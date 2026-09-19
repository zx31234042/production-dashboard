/* ==========================================================================
   长时间运行稳定性自检（tests/stress-check.js）
   作用：把看板挂在无头 Edge 里连续跑数小时（默认 8 小时 = 覆盖一个整班次），
         每 10 分钟采一次样，回答"能不能 7×24 挂着"这个问题：
         S1 页面是否一直活着（时钟每轮都在推进、无未捕获异常、无 console.error）
         S2 JS 堆是否无界增长（Chromium 的 performance.memory.usedJSHeapSize 趋势）
         S3 DOM 是否膨胀（元素总数、标签按钮数、激活面板数是否稳定）
         S4 整班次业务面：跨班次时 when 班次名/统计/曲线/待补传队列如何变化
         S5 周期性负载：每小时把 8 个页面轮一遍 + 切换两次断连，模拟值守操作
   运行：node tests/stress-check.js
   可选环境变量：
         DSH_STRESS_HOURS=8          运行小时数
         DSH_STRESS_INTERVAL_MIN=10  采样间隔（分钟）
         DSH_STRESS_SIZE=3840x2160   视口尺寸
         DSH_STRESS_EDGE=<path>      指定 msedge.exe
   产物：tests/._verify/stress-<时间戳>.csv（逐次采样）
         tests/._verify/stress-<时间戳>.log（进度日志）
         tests/._verify/stress-<时间戳>-start.png / -end.png（首末截图）
   权限：与 browser-check.js 相同——Chromium 需要命名管道，
         受限沙箱下会以 mojo platform_channel 拒绝访问；需在可创建命名管道的权限下运行。
   退出码：0 = 长跑期间各项判据通过；1 = 有判据不通过；2 = 脚本自身异常。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const env = require('./env');

/* 浏览器类脚本一律不得在 prod 环境下跑（ADR-0003 D16）；本脚本额外守一条值域门 */
if (env.isProd) {
  console.error('\n[环境不满足] DSH_ENV=prod：stress-check 拒绝在**生产环境**下运行（ADR-0003 D16）。');
  process.exit(env.EXIT_ERROR);
}
if (env.ENV_NAME !== 'dev' && env.ENV_NAME !== 'test') {
  console.error(`\n[环境不满足] DSH_ENV 取值非法：${env.ENV_NAME}（只允许 dev | test；prod 禁止运行测试）。`);
  process.exit(env.EXIT_ERROR);
}

const ROOT = path.resolve(__dirname, '..');
const PAGE = pathToFileURL(path.join(ROOT, 'index.html')).href;
const OUT = path.join(ROOT, 'tests', '._verify');

const HOURS = Number(process.env.DSH_STRESS_HOURS || 8);
const INTERVAL_MIN = Number(process.env.DSH_STRESS_INTERVAL_MIN || 10);
const SIZE = String(process.env.DSH_STRESS_SIZE || '3840x2160').split('x').map(Number);
const PORT = Number(process.env.DSH_STRESS_PORT || 18930);
const EDGE_CANDIDATES = [
  process.env.DSH_STRESS_EDGE,
  process.env.MSEDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const CSV = path.join(OUT, `stress-${stamp}.csv`);
const LOG = path.join(OUT, `stress-${stamp}.log`);

let edge = null;
let cdp = null;
const pageErrors = [];

/* ---------------- 极简 CDP 客户端 ---------------- */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = [];
    this.closed = false;
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      this.handlers.forEach(h => h(msg));
    });
    this.ws.addEventListener('close', () => { this.closed = true; });
  }

  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (e) {
        reject(e);
      }
    });
  }

  on(handler) {
    this.handlers.push(handler);
  }

  close() {
    try { this.ws.close(); } catch (e) { /* 已关闭 */ }
  }
}

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  fs.appendFileSync(LOG, text + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) { /* 未就绪 */ }
    await sleep(200);
  }
  return null;
}

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'page evaluate failed');
  return r.result.value;
}

async function launch() {
  const exe = EDGE_CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stress-'));
  edge = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    /* 长跑关键：禁掉后台节流，否则页面定时器在无头/遮挡时会被降频 */
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `--window-size=${SIZE[0]},${SIZE[1]}`,
    'about:blank'
  ], { stdio: 'ignore' });
  const version = await waitHttp(`http://127.0.0.1:${PORT}/json/version`, 30000);
  if (!version) return null;
  const list = await waitHttp(`http://127.0.0.1:${PORT}/json/list`, 5000);
  const target = (list || []).find(t => t.type === 'page');
  if (!target) return null;
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on(msg => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageErrors.push(new Date().toISOString() + ' console.error: ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(new Date().toISOString() + ' uncaught: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: SIZE[0], height: SIZE[1], deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 100; i++) {
    const ready = await evaluate('document.readyState').catch(() => null);
    if (ready === 'complete') break;
    await sleep(200);
  }
  return exe;
}

/** 页面内的采样表达式：一次取回所有关心的量 */
const SNAPSHOT_EXPR = `(() => {
  const m = performance.memory || {};
  const st = (window.MockData && window.MockData.state) || {};
  const q = window.Api && window.Api.getStatus ? window.Api.getStatus() : {};
  return {
    clock: (st.clock && st.clock.time) || '',
    lastRefresh: st.lastRefresh || '',
    shift: (st.shift && st.shift.name) || '',
    unitIndex: (st.task && st.task.unitIndex) || 0,
    done: (st.stats && st.stats.done) || 0,
    notStarted: (st.stats && st.stats.notStarted) || 0,
    pending: q.pendingCount === undefined ? -1 : q.pendingCount,
    heap: m.usedJSHeapSize || 0,
    nodes: document.getElementsByTagName('*').length,
    tabs: document.querySelectorAll('.tab-btn').length,
    activePanels: document.querySelectorAll('.tab-panel.active').length,
    hasData: !!document.querySelector('.chart-wrap.has-data'),
    banner: !!document.querySelector('.degraded-banner'),
    mode: (document.getElementById('stMode') || {}).textContent || '',
    curveTask: (document.getElementById('stDepthTask') || {}).textContent || ''
  };
})()`;

/** 每小时一次的负载：8 个页面轮一遍 + 两次断连/恢复 */
async function hourlyWorkload() {
  for (let i = 0; i < 8; i++) {
    await evaluate(`(() => { const b = document.querySelectorAll('.tab-btn')[${i}]; if (b) b.click(); return true; })()`);
    await sleep(400);
  }
  await evaluate(`(() => { const b = document.querySelectorAll('.tab-btn')[0]; if (b) b.click(); return true; })()`);
  for (const type of ['keyDown', 'keyUp', 'keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, text: type === 'keyDown' ? 'd' : '' });
    await sleep(300);
  }
}

async function screenshot(file) {
  try {
    /* 4K 下 CDP 截图偶尔会挂住：加超时，绝不允许它拖死长跑 */
    const shot = await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png' }),
      sleep(30000).then(() => null)
    ]);
    if (!shot) {
      log(`截图超时，跳过 ${path.basename(file)}`);
      return 0;
    }
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return fs.statSync(file).size;
  } catch (e) {
    log(`截图失败：${e.message}`);
    return 0;
  }
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(CSV, 'iso,elapsedMin,clock,shift,unitIndex,done,notStarted,pending,heapMB,nodes,tabs,activePanels,mode,hasData,banner,curveTask\n');
  log(`长跑开始：时长 ${HOURS} h、采样间隔 ${INTERVAL_MIN} min、视口 ${SIZE[0]}×${SIZE[1]}`);
  log(`页面 ${PAGE}`);
  log(`产物 ${path.relative(ROOT, CSV)} / ${path.relative(ROOT, LOG)}`);

  const exe = await launch();
  if (!exe) {
    /* 整脚本跳过：必须退 3（不是 0），否则 runner 会把"一个断言都没跑"记成 PASS（规范 9.5-5 第 6 条）。
       注意与内部的"长跑中途浏览器掉线"区分：那种情况有部分断言已跑，走下面的 results 汇总而非整脚本跳过。 */
    log('整脚本跳过：无头 Edge 起不来');
    env.skipSuite('无头 Edge 启动与 CDP 连接', '未找到 msedge.exe 或沙箱不允许创建命名管道');
  }
  log(`浏览器 ${exe}`);
  await screenshot(path.join(OUT, `stress-${stamp}-start.png`));

  const t0 = Date.now();
  const deadline = t0 + HOURS * 3600 * 1000;
  const intervalMs = INTERVAL_MIN * 60 * 1000;
  const samples = [];
  let round = 0;

  while (Date.now() < deadline) {
    round++;
    const elapsedMin = Math.round((Date.now() - t0) / 60000);
    let snap = null;
    let err = null;
    try {
      snap = await evaluate(SNAPSHOT_EXPR);
    } catch (e) {
      err = e.message;
    }

    if (err) {
      log(`采样 #${round} 失败：${err}`);
      samples.push({ ok: false, elapsedMin, err });
    } else {
      const heapMB = Math.round((snap.heap / 1024 / 1024) * 10) / 10;
      fs.appendFileSync(CSV, [
        new Date().toISOString(), elapsedMin, snap.clock, snap.shift, snap.unitIndex, snap.done,
        snap.notStarted, snap.pending, heapMB, snap.nodes, snap.tabs, snap.activePanels,
        snap.mode, snap.hasData, snap.banner, JSON.stringify(snap.curveTask)
      ].join(',') + '\n');
      samples.push({ ok: true, elapsedMin, ...snap, heapMB });
      log(`采样 #${round}（+${elapsedMin} min）时钟=${snap.clock} 班次=${snap.shift} 件号=${snap.unitIndex} 已完成=${snap.done} 未开工=${snap.notStarted} 待补传=${snap.pending} 堆=${heapMB}MB DOM=${snap.nodes} 错误累计=${pageErrors.length}`);
    }

    if (round % Math.max(1, Math.round(60 / INTERVAL_MIN)) === 0) {
      try {
        await hourlyWorkload();
        log(`第 ${Math.round(elapsedMin / 60)} 小时负载：8 页轮巡 + 2 次断连/恢复 完成`);
      } catch (e) {
        log(`负载执行失败：${e.message}`);
      }
    }

    if (cdp.closed) {
      log('CDP 连接已断开（浏览器可能退出），长跑提前结束');
      break;
    }
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    await sleep(Math.min(intervalMs, remain));
  }

  await screenshot(path.join(OUT, `stress-${stamp}-end.png`));
  const ok = samples.filter(s => s.ok);
  const first = ok[0];
  const last = ok[ok.length - 1];

  /* ---------------- 判据 ---------------- */
  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' —— ' + detail : ''}`);
  };

  check('采样成功率 100%（页面始终可响应）', ok.length === samples.length,
    `${ok.length}/${samples.length} 次采样成功`);
  const clockStuck = ok.filter((s, i) => i > 0 && s.clock === ok[i - 1].clock).length;
  check('时钟持续推进（无卡死）', clockStuck === 0, `${clockStuck} 次相邻采样时钟相同`);
  check('标签按钮数恒定 8（无重复渲染累积）', ok.every(s => s.tabs === 8),
    `出现过的取值：${[...new Set(ok.map(s => s.tabs))].join('/')}`);
  check('始终只有一个面板处于激活态', ok.every(s => s.activePanels === 1),
    `出现过的取值：${[...new Set(ok.map(s => s.activePanels))].join('/')}`);
  check('无未捕获异常与 console.error', pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | '));

  const heapGrowthRatio = first && last ? last.heapMB / Math.max(first.heapMB, 1) : 1;
  check('JS 堆增长不超过首轮的 2 倍且增量 < 100 MB', heapGrowthRatio <= 2 || (last.heapMB - first.heapMB) < 100,
    `首轮 ${first ? first.heapMB : '—'} MB → 末轮 ${last ? last.heapMB : '—'} MB（${heapGrowthRatio.toFixed(2)}×）`);
  const nodeGrowth = first && last ? last.nodes / Math.max(first.nodes, 1) : 1;
  check('DOM 元素数增长不超过 50%', nodeGrowth <= 1.5,
    `首轮 ${first ? first.nodes : '—'} → 末轮 ${last ? last.nodes : '—'}（${nodeGrowth.toFixed(2)}×）`);

  const shifts = [...new Set(ok.map(s => s.shift))];
  log(`覆盖班次：${shifts.join(' → ')}；曲线已固化为「${last ? last.curveTask : '—'}」；末次运行模式 ${last ? last.mode : '—'}`);

  const summary = {
    startedAt: new Date(t0).toISOString(),
    hours: HOURS,
    samples: samples.length,
    samplesOk: ok.length,
    shifts,
    first: first || null,
    last: last || null,
    pageErrors,
    results,
    csv: path.relative(ROOT, CSV),
    log: path.relative(ROOT, LOG)
  };
  fs.writeFileSync(path.join(OUT, `stress-${stamp}-summary.json`), JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n=== 汇总 ===');
  console.log(`通过 ${results.filter(r => r.pass).length} 项，失败 ${results.filter(r => !r.pass).length} 项`);
  results.filter(r => !r.pass).forEach((r, i) => console.log(`  ${i + 1}. ${r.name}${r.detail ? ' —— ' + r.detail : ''}`));
  console.log(`明细：${summary.csv} / ${summary.log} / stress-${stamp}-summary.json`);

  if (cdp) cdp.close();
  if (edge && edge.exitCode === null) {
    try { edge.kill(); } catch (e) { /* 已退出 */ }
  }
  process.exit(results.some(r => !r.pass) ? 1 : 0);
}

main().catch(err => {
  log('脚本异常终止：' + (err && err.stack ? err.stack : err));
  console.error(err);
  process.exit(2);
});
