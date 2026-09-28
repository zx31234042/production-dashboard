/* ==========================================================================
   长时间运行稳定性自检（tests/stress-check.js）
   作用：把看板挂在无头 Edge 里跑一段时间并周期采样，回答"能不能长时间挂着"：
         S1 页面是否一直活着（时钟每轮都在推进、无未捕获异常、无 console.error）
         S2 JS 堆是否无界增长（Chromium 的 performance.memory.usedJSHeapSize 趋势）
         S3 DOM 是否膨胀（元素总数、标签按钮数、激活面板数是否稳定）
         S4 整班次业务面：跨班次时 班次名/统计/曲线/待补传队列如何变化（**需 --hours 8**）
         S5 周期性负载：8 个页面轮一遍 + 两次断连/恢复（第 1 轮必跑，其后每小时一次）
   运行（**默认＝有限时长**，够门禁在一轮里跑完；整夜浸泡改为显式参数）：
         node tests/stress-check.js                                   # 默认 20 分钟、预期 3 个采样点
         node tests/stress-check.js --soak                            # 整班次浸泡（＝ --hours 8）
         node tests/stress-check.js --hours 8                         # 显式浸泡小时数
         node tests/stress-check.js --minutes 2 --interval-min 0.5    # 快速自检（机制验证用，非门禁）
         node tests/stress-check.js --help                            # 用法
   可选环境变量（与 CLI 同时给时 **CLI 优先**）：
         DSH_STRESS_HOURS=8          浸泡小时数（**给了它就按浸泡跑**，与 CLI --hours 同义）
         DSH_STRESS_INTERVAL_MIN=10  采样间隔（分钟；可为小数，便于快速自检）
         DSH_STRESS_SIZE=3840x2160   视口尺寸
         DSH_STRESS_EDGE=<path>      指定 msedge.exe
   判据（**真断言计数**；runner 解析标准汇总行 `通过 N 项，失败 M 项，跳过 K 项`）：
         · **计划类（2 条，任何时长都跑）**：实际墙钟 ≥ **请求时长** − 90 s（"时长参数被遵守"）、
           采样点数 == floor(时长/间隔)+1；
         · **通用 8 条（任何时长都跑）**：采样成功率 / 时钟推进 / 标签数恒定 / 单激活面板 /
           无未捕获异常与 console.error / 堆增长 / DOM 增长 / 周期性负载至少 1 次且无失败；
         · **长跑专属 3 条（默认时长下计入"跳过"，**不是**假装通过；理由：需 `--hours 8`）**：
             ① S4 跨班次：班次名 ≥ 2 种且末次采样曲线已固化
             ② S5 周期性负载按小时重复 ≥ 2 次
             ③ 采样窗口 ≥ 1 小时（≥ 6 个采样点）
         · **自洽 1 条**：跳过项数 == 长跑专属判据条数（默认模式）/ 0（浸泡模式）
           —— 防"把长跑判据悄悄改成通过"（改错这条会红）。
   产物：tests/._verify/stress-<时间戳>.csv（逐次采样）
         tests/._verify/stress-<时间戳>.log（进度日志）
         tests/._verify/stress-<时间戳>-summary.json
         tests/._verify/stress-<时间戳>-start.png / -end.png（首末截图）
   权限：与 browser-check.js 相同——Chromium 需要正常创建命名管道/进程的权限；
         受限沙箱下会以 mojo platform_channel 拒绝访问 ⇒ 整脚本 SKIP（退 3），不产出汇总行。
   退出码：0 = 判据通过（跳过项不影响）；1 = 有判据不通过；2 = 脚本自身异常；3 = 环境不满足（整脚本跳过）。
   记账自检：本文件导出 `resolvePlan()` / `evaluateCriteria()` / `summaryLine()` 三个**纯函数**，
             可在没有浏览器的环境里对"时长参数被遵守 / 跳过项如实 / 汇总行可被 runner 解析"做定点验证。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const env = require('./env');

/* D16 硬要求：Node 版本下限 + 拒绝在 prod 下运行（统一出口，见 tests/env.js） */
env.assertRuntime();

const ROOT = path.resolve(__dirname, '..');
const PAGE = pathToFileURL(path.join(ROOT, 'index.html')).href;
const OUT = path.join(ROOT, 'tests', '._verify');

/** 默认时长（分钟）：**有限时长**，门禁一轮跑得完；整夜浸泡走 `--soak` / `--hours 8` */
const DEFAULT_MINUTES = 20;
/* ⚠ 这一行必须保留 `DSH_STRESS_HOURS || 8` 的字面形态：tests\trace-check.js 的 AC-07 断言
   用正则 `DSH_STRESS_HOURS\s*\|\|\s*(\d+)` 从本文件取"浸泡默认时长"，据此判"8 h 不构成 7 天证据"。
   同时它也是本脚本的浸泡预设（`--soak` ≡ `--hours 8`）。 */
const SOAK_HOURS = Number(process.env.DSH_STRESS_HOURS || 8);
const SOAK_ONLY_MIN = SOAK_HOURS * 60;

/** 长跑专属判据的**名字常量**（跳过/检查两处共用一份，口径不会分叉） */
const SOAK_ONLY_NAMES = Object.freeze([
  'S4 跨班次：班次名 ≥ 2 种且末次采样曲线已固化（需 --hours 8）',
  'S5 周期性负载按小时重复 ≥ 2 次（需 --hours 8）',
  '采样窗口 ≥ 1 小时（≥ 6 个采样点）（需 --hours 8）'
]);

const SIZE = String(process.env.DSH_STRESS_SIZE || '3840x2160').split('x').map(Number);
const PORT = Number(process.env.DSH_STRESS_PORT || 18930);
const EDGE_CANDIDATES = [
  process.env.DSH_STRESS_EDGE,
  process.env.MSEDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

const USAGE = [
  '用法：node tests/stress-check.js [选项]',
  '  （无选项）                     默认 20 分钟、预期 3 个采样点（门禁用有限时长）',
  '  --soak                        整班次浸泡（＝ --hours 8）',
  '  --hours <N>                   浸泡 N 小时（如 --hours 8）',
  '  --minutes <N>                 只跑 N 分钟（快速自检用；与 --hours/--soak 互斥）',
  '  --interval-min <N>            采样间隔（分钟，可为小数；缺省 10）',
  '  --help                        打印本用法',
  '环境变量：DSH_STRESS_HOURS / DSH_STRESS_INTERVAL_MIN / DSH_STRESS_SIZE / DSH_STRESS_EDGE（CLI 优先）',
  '判据：计划类 2 条 + 通用 8 条 + 长跑专属 3 条（默认时长下如实计入"跳过"）+ 自洽 1 条',
  '退出码：0 通过 / 1 有判据不通过 / 2 脚本异常 / 3 环境不满足（整脚本跳过）'
].join('\n');

/**
 * **纯函数**：解析运行计划（时长/间隔/预期采样点数/是否浸泡）。
 * 抽成纯函数是为了在没有浏览器的环境里验证"时长参数被遵守"这条判据（定点变异不必起 Edge）。
 * @param {{minutes?:string|number|null, hours?:string|number|null, soak?:boolean,
 *          envHours?:string|number|null, envIntervalMin?:string|number|null,
 *          defaultMinutes?:number, soakHours?:number}} o
 * @returns {{requestedMin:number, durationMin:number, intervalMin:number, expectedSamples:number,
 *            perHour:number, soakOnly:boolean, source:string}}
 * @throws {Error} 参数非法或互相冲突（不静默择一）
 */
function resolvePlan(o = {}) {
  const defaultMinutes = o.defaultMinutes === undefined ? DEFAULT_MINUTES : Number(o.defaultMinutes);
  const soakHours = o.soakHours === undefined ? SOAK_HOURS : Number(o.soakHours);
  const hasMinutes = o.minutes !== null && o.minutes !== undefined && o.minutes !== '';
  const hasHours = o.hours !== null && o.hours !== undefined && o.hours !== '';
  const soak = o.soak === true;
  if (hasMinutes && (hasHours || soak)) throw new Error('--minutes 与 --hours/--soak 不能同时给（口径必须唯一）');
  if (soak && hasHours) throw new Error('--soak 就是 --hours ' + soakHours + '；两者不能同时给（避免口径含糊）');
  let requestedMin;
  let source;
  if (hasMinutes) { requestedMin = Number(o.minutes); source = 'cli:--minutes'; }
  else if (hasHours) { requestedMin = Number(o.hours) * 60; source = 'cli:--hours'; }
  else if (soak) { requestedMin = soakHours * 60; source = 'cli:--soak'; }
  else if (o.envHours !== null && o.envHours !== undefined && o.envHours !== '') {
    requestedMin = Number(o.envHours) * 60; source = 'env:DSH_STRESS_HOURS';
  } else { requestedMin = defaultMinutes; source = 'default(' + defaultMinutes + ' 分钟)'; }
  const intervalRaw = (o.envIntervalMin === null || o.envIntervalMin === undefined || o.envIntervalMin === '')
    ? 10 : Number(o.envIntervalMin);
  if (!Number.isFinite(requestedMin) || requestedMin <= 0) {
    throw new Error('时长必须是正数（收到 ' + JSON.stringify(requestedMin) + '，来源 ' + source + '）');
  }
  if (!Number.isFinite(intervalRaw) || intervalRaw <= 0) {
    throw new Error('采样间隔必须是正数（收到 ' + JSON.stringify(intervalRaw) + '）');
  }
  const intervalMin = intervalRaw;
  return {
    requestedMin,
    durationMin: requestedMin,
    intervalMin,
    expectedSamples: Math.floor(requestedMin / intervalMin) + 1,
    perHour: Math.max(1, Math.round(60 / intervalMin)),
    soakOnly: requestedMin >= soakHours * 60,
    source
  };
}

/** runner 解析的标准汇总行（**这一行是契约**：`通过 N 项，失败 M 项，跳过 K 项`） */
const summaryLine = v => `通过 ${v.passed} 项，失败 ${v.failed} 项，跳过 ${v.skipped} 项`;

/**
 * **纯函数**：把一次运行的观测折算成判据结论。
 * 三种结果：`check`（pass 真/假）、`skip`（本时长下不适用，如实计入跳过，**不是**通过）。
 * @param {{samples:Array<object>, okSamples:Array<object>, pageErrors:string[], plan:object,
 *          workloadRuns:number, workloadFailures:number, wallMs:number}} ctx
 * @returns {{results:Array<{name:string, kind:'check'|'skip', pass:boolean|null, detail:string}>,
 *            passed:number, failed:number, skipped:number, shifts:string[]}}
 */
function evaluateCriteria(ctx) {
  const plan = ctx.plan || {};
  const samples = ctx.samples || [];
  const ok = ctx.okSamples || [];
  const pageErrors = ctx.pageErrors || [];
  const wallMs = Number(ctx.wallMs) || 0;
  const results = [];
  const check = (name, pass, detail) => results.push({ name, kind: 'check', pass: Boolean(pass), detail: detail || '' });
  const skip = (name, reason) => results.push({ name, kind: 'skip', pass: null, detail: reason || '' });
  const first = ok[0];
  const last = ok[ok.length - 1];

  /* ---- 计划类（任何时长都跑）：时长参数被遵守 + 采样点符合计划 ---- */
  check('本轮墙钟时长 ≥ 请求时长 − 90 s（"时长参数被遵守"）',
    wallMs >= plan.requestedMin * 60000 - 90000,
    `请求 ${plan.requestedMin} min（来源 ${plan.source}），实测墙钟 ${(wallMs / 60000).toFixed(1)} min`);
  check('采样点数 == floor(时长/间隔)+1（采样计划被遵守）',
    samples.length === plan.expectedSamples,
    `预期 ${plan.expectedSamples} 点，实测 ${samples.length} 点（间隔 ${plan.intervalMin} min）`);

  /* ---- 通用判据（任何时长都跑） ---- */
  check('采样成功率 100%（页面始终可响应）', samples.length > 0 && ok.length === samples.length,
    `${ok.length}/${samples.length} 次采样成功`);
  const clockStuck = ok.filter((s, i) => i > 0 && s.clock === ok[i - 1].clock).length;
  check('时钟持续推进（无卡死）', clockStuck === 0, `${clockStuck} 次相邻采样时钟相同`);
  check('标签按钮数恒定 8（无重复渲染累积）', ok.length > 0 && ok.every(s => s.tabs === 8),
    `出现过的取值：${[...new Set(ok.map(s => s.tabs))].join('/')}`);
  check('始终只有一个面板处于激活态', ok.length > 0 && ok.every(s => s.activePanels === 1),
    `出现过的取值：${[...new Set(ok.map(s => s.activePanels))].join('/')}`);
  check('无未捕获异常与 console.error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  const heapGrowthRatio = first && last ? last.heapMB / Math.max(first.heapMB, 1) : 1;
  check('JS 堆增长不超过首轮的 2 倍且增量 < 100 MB', Boolean(first && last) &&
    (heapGrowthRatio <= 2 || (last.heapMB - first.heapMB) < 100),
    `首轮 ${first ? first.heapMB : '—'} MB → 末轮 ${last ? last.heapMB : '—'} MB（${heapGrowthRatio.toFixed(2)}×，窗口 ${samples.length} 点）`);
  const nodeGrowth = first && last ? last.nodes / Math.max(first.nodes, 1) : 1;
  check('DOM 元素数增长不超过 50%', Boolean(first && last) && nodeGrowth <= 1.5,
    `首轮 ${first ? first.nodes : '—'} → 末轮 ${last ? last.nodes : '—'}（${nodeGrowth.toFixed(2)}×）`);
  check('周期性负载（8 页轮巡 + 断连/恢复）至少执行 1 次且无失败',
    Number(ctx.workloadRuns) >= 1 && Number(ctx.workloadFailures) === 0,
    `执行 ${ctx.workloadRuns} 次，失败 ${ctx.workloadFailures} 次`);

  /* ---- 长跑专属：默认时长下**如实跳过**（不是假装通过） ---- */
  const shifts = [...new Set(ok.map(s => s.shift))];
  if (plan.soakOnly) {
    check(SOAK_ONLY_NAMES[0], shifts.length >= 2 && Boolean(last && last.curveTask),
      `班次 ${shifts.join(' → ') || '—'}；末次曲线「${last ? last.curveTask : '—'}」`);
    check(SOAK_ONLY_NAMES[1], Number(ctx.workloadRuns) >= 2, `执行 ${ctx.workloadRuns} 次`);
    check(SOAK_ONLY_NAMES[2], samples.length >= 6, `${samples.length} 点`);
  } else {
    skip(SOAK_ONLY_NAMES[0], `需 --hours 8（本轮请求 ${plan.requestedMin} min，不跨班次）`);
    skip(SOAK_ONLY_NAMES[1], `需 --hours 8（本轮只跑第 1 轮负载）`);
    skip(SOAK_ONLY_NAMES[2], `需 --hours 8（本轮 ${samples.length} 点）`);
  }

  /* ---- 自洽判据：跳过项数必须与"长跑专属判据"条数一致（防把长跑判据悄悄改成通过） ---- */
  const counted = {
    passed: results.filter(r => r.kind === 'check' && r.pass).length,
    failed: results.filter(r => r.kind === 'check' && !r.pass).length,
    skipped: results.filter(r => r.kind === 'skip').length
  };
  const expectSkips = plan.soakOnly ? 0 : SOAK_ONLY_NAMES.length;
  check('跳过项数 == 长跑专属判据条数（防"把长跑判据悄悄改成通过"）',
    counted.skipped === expectSkips,
    `跳过 ${counted.skipped} 项，期望 ${expectSkips} 项（长跑专属共 ${SOAK_ONLY_NAMES.length} 条）`);

  return {
    results,
    passed: results.filter(r => r.kind === 'check' && r.pass).length,
    failed: results.filter(r => r.kind === 'check' && !r.pass).length,
    skipped: results.filter(r => r.kind === 'skip').length,
    shifts
  };
}

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

let LOG = null;
let CSV = null;

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  if (LOG) fs.appendFileSync(LOG, text + '\n');
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

/** 周期性负载：8 个页面轮一遍 + 两次断连/恢复 */
async function workload() {
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
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const optValue = name => {
    const i = argv.indexOf('--' + name);
    if (i < 0) return null;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? null : v;
  };
  let plan;
  try {
    plan = resolvePlan({
      minutes: optValue('minutes'),
      hours: optValue('hours'),
      soak: argv.includes('--soak'),
      envHours: process.env.DSH_STRESS_HOURS,
      envIntervalMin: optValue('interval-min') !== null ? optValue('interval-min') : process.env.DSH_STRESS_INTERVAL_MIN,
      defaultMinutes: DEFAULT_MINUTES,
      soakHours: SOAK_HOURS
    });
  } catch (err) {
    console.error('[参数非法] ' + err.message + '\n\n' + USAGE);
    process.exit(2);
  }

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  CSV = path.join(OUT, `stress-${stamp}.csv`);
  LOG = path.join(OUT, `stress-${stamp}.log`);
  fs.writeFileSync(CSV, 'iso,elapsedMin,clock,shift,unitIndex,done,notStarted,pending,heapMB,nodes,tabs,activePanels,mode,hasData,banner,curveTask\n');
  log(`长跑开始：请求时长 ${plan.requestedMin} min（来源 ${plan.source}）、采样间隔 ${plan.intervalMin} min、` +
    `预期采样 ${plan.expectedSamples} 点、视口 ${SIZE[0]}×${SIZE[1]}、模式 ${plan.soakOnly ? '浸泡' : '默认短跑'}`);
  log(`页面 ${PAGE}`);
  log(`产物 ${path.relative(ROOT, CSV)} / ${path.relative(ROOT, LOG)}`);

  const exe = await launch();
  if (!exe) {
    /* 整脚本跳过：必须退 3（不是 0），否则 runner 会把"一个断言都没跑"记成 PASS（规范 9.5-5 第 6 条）。
       注意与内部的"长跑中途浏览器掉线"区分：那种情况有部分断言已跑，走下面的判据汇总而非整脚本跳过。 */
    log('整脚本跳过：无头 Edge 起不来');
    env.skipSuite('无头 Edge 启动与 CDP 连接', '未找到 msedge.exe 或沙箱不允许创建命名管道');
  }
  log(`浏览器 ${exe}`);
  await screenshot(path.join(OUT, `stress-${stamp}-start.png`));

  const t0 = Date.now();
  const deadline = t0 + plan.durationMin * 60000;
  const samples = [];
  let round = 0;
  let workloadRuns = 0;
  let workloadFailures = 0;

  /** 采一次样（写 CSV + 进 samples + 打日志） */
  async function takeSample(reason) {
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
      log(`采样 #${round}（${reason}）失败：${err}`);
      samples.push({ ok: false, elapsedMin, err });
      return null;
    }
    const heapMB = Math.round((snap.heap / 1024 / 1024) * 10) / 10;
    fs.appendFileSync(CSV, [
      new Date().toISOString(), elapsedMin, snap.clock, snap.shift, snap.unitIndex, snap.done,
      snap.notStarted, snap.pending, heapMB, snap.nodes, snap.tabs, snap.activePanels,
      snap.mode, snap.hasData, snap.banner, JSON.stringify(snap.curveTask)
    ].join(',') + '\n');
    samples.push({ ok: true, elapsedMin, ...snap, heapMB });
    log(`采样 #${round}（${reason}，+${elapsedMin} min）时钟=${snap.clock} 班次=${snap.shift} 件号=${snap.unitIndex} ` +
      `已完成=${snap.done} 未开工=${snap.notStarted} 待补传=${snap.pending} 堆=${heapMB}MB DOM=${snap.nodes} 错误累计=${pageErrors.length}`);
    return samples[samples.length - 1];
  }

  while (Date.now() < deadline) {
    await takeSample('周期');
    /* 周期性负载：**第 1 轮必跑**（默认短跑也要覆盖"8 页轮巡 + 断连/恢复"），其后每小时一次 */
    if ((round - 1) % plan.perHour === 0) {
      try {
        await workload();
        workloadRuns++;
        log(`第 ${round} 轮后的周期性负载完成（8 页轮巡 + 2 次断连/恢复；累计 ${workloadRuns} 次）`);
      } catch (e) {
        workloadFailures++;
        log(`负载执行失败：${e.message}`);
      }
    }
    if (cdp.closed) {
      log('CDP 连接已断开（浏览器可能退出），长跑提前结束');
      break;
    }
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    await sleep(Math.min(plan.intervalMin * 60000, remain));
  }
  /* 收尾采样：让"采样点数 = floor(时长/间隔)+1"在默认短跑下也成立（20 min / 10 min ⇒ 3 点） */
  if (samples.length < plan.expectedSamples && !cdp.closed) await takeSample('收尾');

  await screenshot(path.join(OUT, `stress-${stamp}-end.png`));
  const wallMs = Date.now() - t0;
  const verdict = evaluateCriteria({
    samples,
    okSamples: samples.filter(s => s.ok),
    pageErrors,
    plan,
    workloadRuns,
    workloadFailures,
    wallMs
  });

  for (const r of verdict.results) {
    if (r.kind === 'skip') log(`[SKIP] ${r.name} —— ${r.detail}`);
    else log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ' —— ' + r.detail : ''}`);
  }
  log(`覆盖班次：${verdict.shifts.join(' → ') || '—'}；末次运行模式 ${samples.filter(s => s.ok).slice(-1)[0] ? samples.filter(s => s.ok).slice(-1)[0].mode : '—'}`);

  const okSamples = samples.filter(s => s.ok);
  const summary = {
    startedAt: new Date(t0).toISOString(),
    requestedMin: plan.requestedMin,
    durationMin: plan.durationMin,
    intervalMin: plan.intervalMin,
    expectedSamples: plan.expectedSamples,
    soakOnly: plan.soakOnly,
    source: plan.source,
    wallMin: Math.round((wallMs / 60000) * 10) / 10,
    samples: samples.length,
    samplesOk: okSamples.length,
    workloadRuns,
    workloadFailures,
    shifts: verdict.shifts,
    first: okSamples[0] || null,
    last: okSamples[okSamples.length - 1] || null,
    pageErrors,
    results: verdict.results,
    csv: path.relative(ROOT, CSV),
    log: path.relative(ROOT, LOG)
  };
  fs.writeFileSync(path.join(OUT, `stress-${stamp}-summary.json`), JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n=== 汇总 ===');
  console.log(`本轮：${plan.soakOnly ? '浸泡模式' : '默认短跑'} 请求 ${plan.requestedMin} 分钟（来源 ${plan.source}；` +
    `采样间隔 ${plan.intervalMin} min；采样 ${samples.length}/${plan.expectedSamples} 点；实际墙钟 ${summary.wallMin} min；` +
    `视口 ${SIZE[0]}×${SIZE[1]}）`);
  console.log(summaryLine(verdict));
  if (verdict.failed) {
    console.log('失败清单：');
    verdict.results.filter(r => r.kind === 'check' && !r.pass).forEach((r, i) => console.log(`  ${i + 1}. ${r.name}${r.detail ? ' —— ' + r.detail : ''}`));
  }
  if (verdict.skipped) {
    console.log('跳过清单（不计入失败；长跑专属判据需 --hours 8）：');
    verdict.results.filter(r => r.kind === 'skip').forEach((r, i) => console.log(`  ${i + 1}. ${r.name} —— ${r.detail}`));
  }
  console.log(`明细：${summary.csv} / ${summary.log} / stress-${stamp}-summary.json`);

  if (cdp) cdp.close();
  if (edge && edge.exitCode === null) {
    try { edge.kill(); } catch (e) { /* 已退出 */ }
  }
  process.exit(verdict.failed ? 1 : 0);
}

/* 被 require 时只导出纯函数（供记账自检/定点变异用），**不执行**长跑本体 */
if (require.main === module) {
  main().catch(err => {
    log('脚本异常终止：' + (err && err.stack ? err.stack : err));
    console.error(err);
    process.exit(2);
  });
}

module.exports = {
  resolvePlan,
  evaluateCriteria,
  summaryLine,
  SOAK_ONLY_NAMES,
  DEFAULT_MINUTES,
  SOAK_HOURS,
  SOAK_ONLY_MIN,
  USAGE
};
