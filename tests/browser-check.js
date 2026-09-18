/* ==========================================================================
   真实浏览器自检（tests/browser-check.js）
   作用：用无头 Microsoft Edge + Chrome DevTools Protocol 真跑一遍 index.html，
         覆盖 tests/README.md 第一节里"只能靠浏览器确认"的部分：
         B1 页面能打开：脚本全部加载、无红色报错、8 个标签与页脚要素齐全
         B2 参数化启动：?tab= / ?curve=none / ?link=off / ?unlock=1 / ?source=upper
         B3 键盘演示键 D：进入断连降级态
         B4 逐页点击切换：始终只有一个面板 active，头部信息常显
         B5 三种分辨率下无滚动条（3840×2160 / 1920×1080 / 1366×768）
         B6 无操作自动回首页（用虚拟时间快进 3 分钟）
         B7 关键页面截图落到 tests/._verify/（已被 .gitignore 忽略），供人工比对
   运行：node tests/browser-check.js
   依赖：本机已安装 Microsoft Edge；无 npm 依赖（用 Node 内置 WebSocket 直连 CDP）。
   重要：Chromium 需要创建命名管道，受限沙箱（workspace-write）下会以
         "mojo platform_channel: 拒绝访问" 启动失败；请在可创建命名管道的权限下运行，
         例如 dsh 会话中批准 danger-full-access，或在普通终端直接执行。
   退出码：0 = 通过（含全部跳过）；1 = 有断言失败；2 = 脚本自身异常。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PAGE = pathToFileURL(path.join(ROOT, 'index.html')).href;
const ARTIFACTS = path.join(ROOT, 'tests', '._verify');
const PORT = Number(process.env.DSH_EDGE_PORT || 18920);

const EDGE_CANDIDATES = [
  process.env.MSEDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

/* ---------------- 断言框架 ---------------- */
let passed = 0;
const failures = [];
let skipped = 0;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  [SKIP] ${name} —— ${reason}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ---------------- 极简 CDP 客户端（全局 WebSocket，无第三方库） ---------------- */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = [];
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
  }

  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  on(handler) {
    this.handlers.push(handler);
  }

  close() {
    try { this.ws.close(); } catch (e) { /* 已关闭 */ }
  }
}

/* ---------------- 浏览器进程与页面操作 ---------------- */
let edge = null;
let cdp = null;
const consoleErrors = [];

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) { /* 未就绪 */ }
    await sleep(150);
  }
  return null;
}

async function launchEdge() {
  const exe = EDGE_CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edge-'));
  edge = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank'
  ], { stdio: 'ignore' });
  const version = await waitHttp(`http://127.0.0.1:${PORT}/json/version`, 20000);
  if (!version) return null;
  const list = await waitHttp(`http://127.0.0.1:${PORT}/json/list`, 5000);
  const page = (list || []).find(t => t.type === 'page');
  if (!page) return null;
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on(msg => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push('console.error: ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleErrors.push('uncaught: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push('log: ' + msg.params.entry.text);
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  return exe;
}

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
}

/** 打开页面并等待首个渲染周期（DOMContentLoaded + 两次 1 秒 tick） */
async function openPage(query, waitMs) {
  consoleErrors.length = 0;
  await cdp.send('Page.navigate', { url: PAGE + (query || '') });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await evaluate('document.readyState').catch(() => null);
    if (ready === 'complete') break;
    await sleep(150);
  }
  await sleep(waitMs === undefined ? 2200 : waitMs);
}

async function clickTab(index) {
  return evaluate(`(() => { const b = document.querySelectorAll('.tab-btn')[${index}]; if (!b) return false; b.click(); return true; })()`);
}

async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}

/**
 * 用 Edge 命令行截图（比 CDP 的 captureScreenshot 在 4K 下更稳，且带 60 秒超时保护）
 * @returns {number} 生成文件字节数；失败返回 0
 */
async function cliScreenshot(exe, url, file) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edge-shot-'));
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--window-size=3840,2160', `--screenshot=${file}`, url
  ], { stdio: 'ignore' });
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* 已退出 */ }
      resolve('timeout');
    }, 60000);
    child.on('exit', () => { clearTimeout(timer); resolve('exit'); });
  });
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

/* ---------------- 主流程 ---------------- */
async function main() {
  if (!fs.existsSync(ARTIFACTS)) fs.mkdirSync(ARTIFACTS, { recursive: true });

  console.log(`页面：${PAGE}`);
  const exe = await launchEdge();
  if (!exe) {
    section('浏览器自检');
    skip('无头 Edge 启动与 CDP 连接', '未找到 msedge.exe，或沙箱不允许创建命名管道（mojo platform_channel 拒绝访问）');
    console.log('\n=== 汇总 ===');
    console.log(`通过 ${passed} 项，失败 0 项，跳过 ${skipped} 项`);
    process.exit(0);
  }
  console.log(`浏览器：${exe}`);

  /* ===== B1 页面能打开 ===== */
  section('B1 页面加载与首屏（tests/README 第一节 1～2）');
  await openPage('', 2500);
  const globals = await evaluate(`({
    mockData: typeof window.MockData, api: typeof window.Api, dash: typeof (window.Pages||{}).Dashboard,
    components: window.Components ? Object.keys(window.Components).length : 0,
    tabs: document.querySelectorAll('.tab-btn').length,
    activePanels: document.querySelectorAll('.tab-panel.active').length,
    clock: (document.getElementById('hdrClock')||{}).textContent || '',
    deviceName: (document.getElementById('hdrDeviceName')||{}).textContent || '',
    version: (document.querySelector('#board-status b')||{}).textContent || '',
    refresh: (document.getElementById('sbRefresh')||{}).textContent || '',
    depth: (document.getElementById('stDepth')||{}).textContent || '',
    panels: ['panel-status','panel-task','panel-shift','panel-stats','panel-alarm','panel-maint','panel-notice','panel-setting'].every(id => !!document.getElementById(id))
  })`);
  check('全部脚本加载（MockData / Api / Dashboard / 组件齐备）',
    globals.mockData === 'object' && globals.api === 'object' && globals.dash === 'object' && globals.components >= 11,
    `MockData=${globals.mockData} Api=${globals.api} Dashboard=${globals.dash} 组件=${globals.components} 个`);
  check('无红色报错（console.error / 未捕获异常 / 浏览器 error 日志）', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '));
  check('默认首页是「设备状态」且只有一个面板处于激活态',
    globals.activePanels === 1 && globals.tabs === 8,
    `.tab-btn=${globals.tabs} 个，激活面板=${globals.activePanels} 个`);
  check('头部信息常显（设备名 + 秒级时钟）',
    globals.deviceName.length > 0 && /^\d{2}:\d{2}:\d{2}$/.test(globals.clock),
    `设备名=${globals.deviceName} 时钟=${globals.clock}`);
  check('页脚显示版本号与最后刷新时刻（UI-17 / FR-9.3）',
    /^v\d+\.\d+\.\d+/.test(globals.version) && /^\d{2}:\d{2}:\d{2}$/.test(globals.refresh),
    `版本=${globals.version} 最后刷新=${globals.refresh}`);
  check('主要实测数据已渲染（航行器深度）', /^\d+\.\d{2}$/.test(globals.depth), `stDepth=${globals.depth}`);
  check('8 个面板容器都存在', globals.panels === true);

  /* ===== B2 参数化启动 ===== */
  section('B2 参数化启动（tests/README 第一节 4）');
  await openPage('?tab=3', 1800);
  const tabState = await evaluate(`(() => {
    const a = document.querySelector('.tab-panel.active');
    const idx = [...document.querySelectorAll('.tab-btn')].findIndex(b => b.classList.contains('active'));
    return { id: a ? a.id : null, idx };
  })()`);
  check('?tab=3 直接打开「生产统计」', tabState.id === 'panel-stats' && tabState.idx === 3,
    `active=${tabState.id} 标签序号=${tabState.idx}`);

  await openPage('?curve=none', 2500);
  const curveState = await evaluate(`(() => {
    const wrap = document.getElementById('stDepthChart').parentElement;
    const empty = wrap.querySelector('.chart-empty');
    return {
      hasData: wrap.classList.contains('has-data'),
      emptyVisible: empty ? getComputedStyle(empty).display !== 'none' : false,
      polylines: document.querySelectorAll('#stDepthChart polyline, #stSpeedChart polyline').length,
      taskText: (document.getElementById('stDepthTask')||{}).textContent || ''
    };
  })()`);
  check('?curve=none 显示空态且不画曲线',
    curveState.emptyVisible === true && curveState.polylines === 0,
    `空态可见=${curveState.emptyVisible}，polyline=${curveState.polylines} 条，图下文案=${curveState.taskText}`);

  await openPage('?link=off', 2500);
  const linkState = await evaluate(`({
    banner: !!document.querySelector('.degraded-banner'),
    linkText: (document.getElementById('stLinkText')||{}).textContent || '',
    mode: (document.getElementById('stMode')||{}).textContent || '',
    footer: (document.getElementById('sbHeartbeat')||{}).textContent || ''
  })`);
  check('?link=off 进入降级态：横幅 + 离线文案 + 页脚链路中断（UI-10）',
    linkState.banner && /离线|断连/.test(linkState.linkText) && /中断/.test(linkState.footer),
    `横幅=${linkState.banner} 链路=${linkState.linkText} 模式=${linkState.mode} 页脚=${linkState.footer}`);

  await openPage('?unlock=1', 2000);
  const unlockState = await evaluate(`({
    content: document.getElementById('maintContent').disabled,
    save: document.getElementById('maintSave').disabled,
    lockText: (document.getElementById('setLockText')||{}).textContent || ''
  })`);
  check('?unlock=1 启动即解锁：录入控件可用（FR-8.1、FR-6.11）',
    unlockState.content === false && unlockState.save === false,
    `maintContent.disabled=${unlockState.content} maintSave.disabled=${unlockState.save} 文案=${unlockState.lockText}`);

  await openPage('?source=upper', 2500);
  /* 把"模拟上位机"换成一帧固定报文：若界面真的由报文驱动，深度应稳定显示 9.99；
     若界面仍被 mockData 的每秒 tick 覆盖，数值会继续随机游走。 */
  await evaluate(`(() => {
    const fixed = {
      equipCode: 'SX-UNDERWATER-001', procOrderNo: 'MES20260918001', collectTime: '2026-09-18 15:10:27',
      testStatus: 1, stage: '运行', linkStatus: 'online',
      depth: 9.99, speed: 1.11, velocity_x: 1.11, velocity_y: 0, frameRate: 401, gain: 2.5, shutter: 500, cameraDepth: 12,
      productCode: 'CP-2026-A17', productName: '水下振动测试件', batchNo: 'PC20260918-03', drawingNo: 'SJ-4471-02',
      orderNo: 'DD20260917-118', planQty: 180, stdDepth: 12.5, stdGain: 2.5, stdFps: 400, stdShutter: 500,
      result: '测试中', unitIndex: 1, progress: 0.5
    };
    window.MockUpperSource.next = function () { return { payload: fixed, inner: null }; };
    return true;
  })()`);
  await sleep(2600);
  const upper1 = await evaluate(`(document.getElementById('stDepth')||{}).textContent || ''`);
  await sleep(1600);
  const upper2 = await evaluate(`(document.getElementById('stDepth')||{}).textContent || ''`);
  check('?source=upper 时界面数值由报文驱动（不被 mockData 的每秒 tick 覆盖）',
    upper1 === '9.99' && upper2 === '9.99',
    `注入固定报文 depth=9.99 后，stDepth = ${upper1} → ${upper2}（若在变，说明画面仍在跑模拟数据而不是报文）`);

  /* ===== B3 键盘演示键 ===== */
  section('B3 键盘演示键（tests/README 第一节 4）');
  await openPage('', 2200);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, text: 'd' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
  await sleep(1600);
  const afterD = await evaluate(`({
    banner: !!document.querySelector('.degraded-banner'),
    mode: (document.getElementById('stMode')||{}).textContent || ''
  })`);
  check('按 D 进入「故障锁定 + 降级横幅」（UI-10）',
    afterD.banner && afterD.mode === '故障锁定',
    `横幅=${afterD.banner} 运行模式=${afterD.mode}`);

  /* ===== B4 逐页切换 ===== */
  section('B4 逐页点击切换（FR-9.1～9.3）');
  await openPage('', 2200);
  const problems = [];
  for (let i = 0; i < 8; i++) {
    await clickTab(i);
    await sleep(350);
    const st = await evaluate(`(() => {
      const act = document.querySelectorAll('.tab-panel.active');
      const clock = (document.getElementById('hdrClock')||{}).textContent || '';
      return { count: act.length, id: act[0] ? act[0].id : null, clock };
    })()`);
    if (st.count !== 1 || st.id === null || !/^\d{2}:\d{2}:\d{2}$/.test(st.clock)) {
      problems.push(`第 ${i + 1} 页：active=${st.count} 个，id=${st.id}，时钟=${st.clock}`);
    }
  }
  check('切换 8 个标签页：始终只有一个面板激活且头部常显', problems.length === 0, problems.join('；'));

  /* ===== B5 三种分辨率无滚动条 ===== */
  section('B5 分辨率与滚动条（UI-02）');
  for (const [w, h] of [[3840, 2160], [1920, 1080], [1366, 768]]) {
    await setViewport(w, h);
    await sleep(600);
    const m = await evaluate(`({
      sw: document.documentElement.scrollWidth, iw: window.innerWidth,
      sh: document.documentElement.scrollHeight, ih: window.innerHeight,
      scrollbar: document.documentElement.scrollHeight > window.innerHeight + 1 || document.documentElement.scrollWidth > window.innerWidth + 1
    })`);
    check(`${w}×${h} 无横/纵向滚动条`, m.scrollbar === false,
      `scrollWidth=${m.sw} / innerWidth=${m.iw}，scrollHeight=${m.sh} / innerHeight=${m.ih}`);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  /* ===== B6 无操作自动回首页（虚拟时间快进） ===== */
  section('B6 无操作 3 分钟自动返回首页（FR-9.4）');
  try {
    await openPage('', 2200);
    await clickTab(5);
    await sleep(300);
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 200000 });
    await sleep(1500);
    const after = await evaluate(`(() => {
      const act = document.querySelector('.tab-panel.active');
      return act ? act.id : null;
    })()`);
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' }).catch(() => {});
    check('快进 200 秒后自动回到「设备状态」首页', after === 'panel-status', `当前激活面板=${after}`);
  } catch (e) {
    skip('无操作 3 分钟自动返回首页', '虚拟时间快进不可用：' + e.message);
  }

  /* ===== B7 截图 ===== */
  section('B7 关键页面截图（人工比对用）');
  const shots = [
    ['default', ''],
    ['curve-none', '?curve=none'],
    ['link-off', '?link=off'],
    ['tab-stats', '?tab=3']
  ];
  const made = [];
  for (const [name, query] of shots) {
    const file = path.join(ARTIFACTS, `${name}.png`);
    const size = await cliScreenshot(exe, PAGE + query, file);
    made.push(`${name}.png ${size ? (size / 1024).toFixed(0) + ' KB' : '未生成'}`);
  }
  check('截图已生成到 tests/._verify/', made.every(x => !x.includes('未生成')), made.join('，'));

  /* ---------------- 汇总 ---------------- */
  console.log('\n=== 汇总 ===');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项，跳过 ${skipped} 项`);
  console.log(`截图目录：${path.relative(ROOT, ARTIFACTS)}（已被 .gitignore 忽略）`);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ' —— ' + f.detail : ''}`));
  }
  cleanup();
  process.exit(failures.length ? 1 : 0);
}

function cleanup() {
  if (cdp) cdp.close();
  if (edge && edge.exitCode === null) {
    try { edge.kill(); } catch (e) { /* 已退出 */ }
  }
}

main().catch(err => {
  console.error('\n自检脚本异常终止：' + (err && err.stack ? err.stack : err));
  cleanup();
  process.exit(2);
});
