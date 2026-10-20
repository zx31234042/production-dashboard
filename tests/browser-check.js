/* ==========================================================================
   真实浏览器自检（tests/browser-check.js）
   作用：用无头 Microsoft Edge + Chrome DevTools Protocol 真跑一遍 index.html，
         覆盖 tests/README.md 第一节里"只能靠浏览器确认"的部分：
         B1 页面能打开：脚本全部加载、无红色报错、8 个标签与页脚要素齐全
         B2 参数化启动：?tab= / ?curve=none / ?link=off / ?unlock=1 / ?source=upper
         B3 键盘演示键 D：进入断连降级态
         B4 逐页点击切换：始终只有一个面板 active，头部信息常显
         B5 三种分辨率下无滚动条（3840×2160 / 1920×1080 / 1366×768）
         B5b 任务数据页「测试标准区」U-4 版面（V1.36 / C-95）：3840×2160 下把三态徽标强制成
             最坏态「超范围」，逐格量「内容是否只有一行／无横向溢出／参数名与徽标同排」
         B5c 任务数据页「测试标准区」**占满卡片剩余高度**（U-1 / FR-3.16 / C-92）的**真机判据**：
              3840×2160、`?tab=1` 下量「#tkStdTable 实测高 vs 卡片内容区剩余高度」与
              「两行行高 vs 自然高度（临时把表移出文档流实测）」，并做页内 `flex:none` 对照
              （对照只改当次 Runtime.evaluate 的临时 DOM，**不改仓库文件**）——每项都打印实测数字
         B6 无操作自动回首页（用虚拟时间快进 5 分 10 秒）
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
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const env = require('./env');

/* D16 硬要求：Node 版本下限 + 拒绝在 prod 下运行（统一出口，见 tests/env.js） */
env.assertRuntime();

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

/** 打开一个**绝对 URL** 并等待首个渲染周期（DOMContentLoaded + 指定等待）
 *  与 `openPage()` 同一口径，只是不拼 `PAGE` 前缀 —— `B5e`（`E206`）要打开**真服务端**托管的
 *  同源页面（`http://127.0.0.1:<port>/?source=server`），不是 `file://` 的 `index.html`。 */
async function openUrl(url, waitMs) {
  consoleErrors.length = 0;
  await cdp.send('Page.navigate', { url });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await evaluate('document.readyState').catch(() => null);
    if (ready === 'complete') break;
    await sleep(150);
  }
  await sleep(waitMs === undefined ? 2200 : waitMs);
}

/** 打开页面并等待首个渲染周期（DOMContentLoaded + 两次 1 秒 tick） */
async function openPage(query, waitMs) {
  return openUrl(PAGE + (query || ''), waitMs);
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
    /* 整脚本跳过：必须退 3（不是 0），否则 runner 会把"一个断言都没跑"记成 PASS（规范 9.5-5 第 6 条） */
    env.skipSuite('无头 Edge 启动与 CDP 连接', '未找到 msedge.exe，或沙箱不允许创建命名管道（mojo platform_channel 拒绝访问）');
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

  /* 编码与乱码：整屏可见文本不得出现替换字符或典型 GBK↔UTF-8 误解码序列（tests/README 第一节 5） */
  const encoding = await evaluate(`(() => {
    const text = [document.title, (document.getElementById('stage')||{}).innerText || ''].join('\\n');
    const bad = [
      ['替换字符 U+FFFD', /\\uFFFD/],
      ['典型乱码「锟斤拷」', /锟斤拷/],
      ['典型乱码「ï¿½」', /ï¿½/],
      ['UTF-8 被按 Latin-1 解码（â€／Ã 后跟控制区）', /(?:â€|Ã[\\u0080-\\u00BF]|æ[\\u0080-\\u00BF]|å[\\u0080-\\u00BF]|ç[\\u0080-\\u00BF])/],
      ['GBK 误解码特征字', /[鏉鐢閫氳涓洪個]/]
    ].filter(([, re]) => re.test(text)).map(([name]) => name);
    return {
      charset: document.characterSet,
      bad,
      hasChinese: /设备运行模式|航行器深度/.test(text),
      length: text.length
    };
  })()`);
  check('页面编码为 UTF-8 且中文字符正常渲染',
    encoding.charset === 'UTF-8' && encoding.hasChinese,
    `characterSet=${encoding.charset} 含预期中文=${encoding.hasChinese} 文本长度=${encoding.length}`);
  check('整屏可见文本无乱码特征（替换字符 / GBK 误解码序列）',
    encoding.bad.length === 0,
    encoding.bad.join('、'));

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

  /* ---- ?curve=none：**任何 load 相位**都要求空态（`E203` 收紧后重述，2026-10-07） ----
     `?curve=none` 的语义是"**初始**空态"（README.md §三、需求清单 V1.46 §…、甲方 Demo 说明同一措辞）：
     `src/main.js:116` 在 `start()` 里执行一次 `M.clearCurve()`，**只清预置曲线**。
     · **改前**：`src/services/mockData.js` 的节拍边界固化判据只有"缓冲长度 > 1" ⇒ load 恰落在边界前
       1～2 s 时，边界那一帧会把 2～3 帧残缓冲固化并**覆盖**空态 ⇒ 本用例随机变红（相位全扫 1～2/160）；
       当时的**相位守据**（"观测窗须落在一个节拍之内、余量 > 6 s"）就是为了绕开这些相位。
     · **改后（`E203`，`mockData.js:751-765`）**：两条同时成立才固化 —— ①缓冲属于**紧邻的上一件**
       ②缓冲 ≥ `CURVE_FREEZE_MIN_SAMPLES`（整件采样数的 90%，现配置 144 帧）。本用例的缓冲**在装载后
       才开始累积**（`mockData.js:254` 装载时为空），2.5 s 观测窗内至多 3～4 帧 ⇒ **任何相位都达不到
       阈值** ⇒ 空态与 load 相位**无关**，守据不必再拦（留着它反而让本用例对"边界前 1～2 s 装载"
       这一相位**永远失明**）。
     · 相位只作**留痕**记进详情，便于失败时判断"窗内是否跨了节拍边界"；"160 个相位都不出现
       2～3 采样点曲线"的**确定性覆盖**由 `tests/logic-check.js` 第十四节 `E203-⑤` 承担。 */
  async function curveCyclePhase() {
    return evaluate(`(() => {
      const M = window.MockData;
      return { into: M.state.shift.elapsed % M.CFG.cycleSec, cycleSec: M.CFG.cycleSec };
    })()`);
  }
  await openPage('?curve=none', 900);                    // 先取到帧，才有 shift.elapsed
  const curvePhaseUsed = await curveCyclePhase();         // 相位＝**留痕**（不再是前提）
  await sleep(2500);                                      // 观测窗 2.5 s（装载后才累积 ⇒ ≤3～4 帧）
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
  check('?curve=none 显示空态且不画曲线（**任何 load 相位**；`E203` 收紧后残缓冲不再固化）',
    curveState.emptyVisible === true && curveState.polylines === 0,
    `空态可见=${curveState.emptyVisible}，polyline=${curveState.polylines} 条，图下文案=${curveState.taskText}` +
    `；装载相位＝节拍内已进行 ${curvePhaseUsed ? curvePhaseUsed.into.toFixed(1) : '未取到'} s / 节拍 ` +
    `${curvePhaseUsed ? curvePhaseUsed.cycleSec : '未取到'} s（距下一道边界 ` +
    `${curvePhaseUsed ? (curvePhaseUsed.cycleSec - curvePhaseUsed.into).toFixed(1) : '未取到'} s；` +
    '相位**不再是前提** —— 见上方重述与 `logic-check` 第十四节 `E203-⑤`）');


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

  /* 键盘 A：切到下一条故障报警（FR-5.1～5.4；mockData.injectAlarm 让 activeAlarmIndex+1） */
  const alarmBefore = await evaluate(`(() => {
    const a = (window.MockData.state.alarm || {}).active || {};
    return { code: a.code || '', type: a.type || '', mark: (a.time || '') + '|' + (a.state || '') };
  })()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await sleep(1600);
  const alarmAfter = await evaluate(`(() => {
    const a = (window.MockData.state.alarm || {}).active || {};
    return {
      code: a.code || '', type: a.type || '',
      domCode: (document.getElementById('alCode')||{}).textContent || '',
      domType: (document.getElementById('alType')||{}).textContent || ''
    };
  })()`);
  check('按 A 切换到下一条故障报警（DOM 与 state 同步变化）',
    alarmBefore.code !== alarmAfter.code &&
      alarmAfter.domCode === alarmAfter.code && alarmAfter.domType === alarmAfter.type,
    `state：${alarmBefore.code}/${alarmBefore.type} → ${alarmAfter.code}/${alarmAfter.type}；` +
    `DOM：${alarmAfter.domCode}/${alarmAfter.domType}`);

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

  /* ===== B5b 任务数据页「测试标准区」U-4 版面真机判据（V1.36 / C-95） =====
     立案：负责人 2026-09-24 手动测试反馈 U-4（真机截图复现）——三态徽标为三字「超范围」时，
     测试标准区出现**预期外换行**（第 5 格只读导出值被压成两行）。C-95 要求：
     参数名与徽标**同排**、第 5 格导出值**一行显示且不丢「上限/下限」字样**、表头仍允许换行、
     字号口径不变（U-1）。静态声明层证据在 ui-check 的 (d3) 段；本段证明**真机渲染结果**。
     判据（逐条都打印实测值）：
       ① 结构齐备：`?tab=1` 的 `#tkStdTable` 恰好两行 × 5 格、每行 1 个 `.std-state`；
       ② **最坏态强制**：`document.querySelectorAll('.std-limits .std-state')` 逐一把 `textContent`
          改成 `超范围`，并回读确认改成功（不确认就是"没跑最坏态也算过"）；
       ③ 每个 `td` 的内容**只有一行**：`Range` 包围盒高 ÷ 单行推进量 取整 === 1。
          「单行推进量」＝该格内每个文本 run 的
          `max(同字号同字体族探针实测单行高, 该 run 自身 line-height × 舞台缩放比)` 的最大值
          （探针 = `position:absolute` + `white-space:nowrap` 的 span ⇒ 只可能是一行）。
          为什么**不**直接拿 td 的 computed `line-height` 当除数：真机实测（probe2.json 配置 B）
          「典型值」格 内容高 86 ÷ td 行高 58 = **1.483**，距 `Math.round` 的 1.5 悬崖只差 0.017
          ⇒ 会误报（格内 `.std-value` 是 64px 字体、td 的 line-height 只是 48px 字体的 normal）。
          题面口径的 `包围盒高 ÷ td 行高` 仍逐格打印（`ratioByLh`）供人工对照。
          ⚠️ **不用** `getClientRects().length`：那是行内盒碎片数 —— "参数名＋徽标同排"会被数成 2 而误报。
       ④ 第 5 格 `.std-derived`：`textContent` 仍含「上限」「下限」两词、计算值 `white-space === nowrap`、
          `text-overflow !== ellipsis`（不得省略号截断）、且行数 = 1；
       ⑤ 无横向溢出：任一 `td` 的 `scrollWidth ≤ clientWidth + 1`，且 `Range` 内容宽（÷ 缩放）不超出内容盒 + 2；
          `table.scrollWidth ≤ table.clientWidth + 1`；
          （后一个 2 px 容差是**辅助**判据：真机上"参数名＋徽标"格的横向余量本身就只有约 0.5 px，
            取 1 px 会贴边抖动；真被挤压时超出量是几十像素，2 px 仍然决定性。主判据 `scrollWidth`
            的 +1 px 容差按题面口径原样保留。）
       ⑥ 参数名与徽标**同排**且垂直居中对齐：徽标左边界 ≥ 参数名右边界 − 1 px（若徽标折到下一行，
          它的左边界会退回内容盒左端 ⇒ 差值为负，本条直接变红）；且两者 `top` 差与 `bottom` 差
          ≤ 参数名单行高的 1/2（基线对齐 ⇒ 同排时差值 ≈ 字号差 × 字体内容比，远小于半行高；
          折行时差值 ≈ 一个行高 ⇒ 变红）。
     ⚠️ 强制徽标与全部量测在**同一次 `Runtime.evaluate` 内**完成：页面每秒 tick 会重绘 tbody，
     跨调用改写会被下一帧冲掉（主代理此前实测过），同一次同步求值内不可能被插入重绘。
     ⚠️ `#stage` 被 main.js 按 `min(innerWidth/3840, innerHeight/2160)` 等比缩放 ⇒
     `getBoundingClientRect()` 是**缩放后**的值，`clientWidth` / computed `line-height` 是**未缩放**的布局值，
     故按 `table.clientWidth` 与 `table` 的 rect 之比归一后再比较（3840×2160 下该比值应为 1）。
     本段依赖浏览器权限：无 Edge / 沙箱禁命名管道时整脚本在此前已 `skipSuite`（退 3，跳过 ≠ 通过）。 */
  section('B5b 任务数据页测试标准区 U-4 版面（V1.36 / C-95：3840×2160、强制徽标＝超范围）');
  await setViewport(3840, 2160);
  await openPage('?tab=1', 2500);
  const u4 = await evaluate(`(() => {
    const table = document.getElementById('tkStdTable');
    if (!table) return { fatal: '未找到 #tkStdTable（任务数据页未渲染？）' };
    const badges = [].slice.call(document.querySelectorAll('.std-limits .std-state'));
    if (!badges.length) return { fatal: '未找到 .std-limits .std-state' };
    /* ① 强制最坏态：徽标文案＝三字「超范围」（负责人截图里的态），并回读确认 */
    const forced = badges.map(function (b) { b.textContent = '超范围'; return b.textContent; });
    const rows = [].slice.call(table.querySelectorAll('tbody tr'));
    if (!rows.length) return { fatal: '#tkStdTable tbody 没有数据行' };
    /* 舞台缩放归一：getBoundingClientRect（缩放后）÷ clientWidth（布局） */
    const tableRect = table.getBoundingClientRect();
    const scale = table.clientWidth > 0 ? (tableRect.width / table.clientWidth) : 1;
    /* 隐形探针：复制该段文本的字体，nowrap + absolute ⇒ 高度就是该字体的"单行内容高" */
    const probeH = function (cs, text) {
      const s = document.createElement('span');
      s.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:nowrap;';
      s.style.fontFamily = cs.fontFamily; s.style.fontSize = cs.fontSize;
      s.style.fontWeight = cs.fontWeight; s.style.fontStyle = cs.fontStyle;
      s.textContent = text;
      document.body.appendChild(s);
      const h = s.getBoundingClientRect().height;
      s.parentNode.removeChild(s);
      return h;
    };
    const textRuns = function (td) {
      const out = [];
      (function walk(el) {
        [].slice.call(el.childNodes).forEach(function (n) {
          if (n.nodeType === 3) {
            if (n.textContent.trim()) out.push({ el: n.parentElement || el, text: n.textContent.trim() });
          } else if (n.nodeType === 1) { walk(n); }
        });
      })(td);
      return out;
    };
    const cells = [];
    rows.forEach(function (tr) {
      [].slice.call(tr.children).forEach(function (td, i) {
        const cs = getComputedStyle(td);
        /* 逐文本 run 取两个量：
             ① contentArea＝该 run 的"单行内容高"（同字号同字体族隐形探针实测、落在同一缩放上下文里）；
             ② advance＝该 run 的"单行推进量"＝ max(内容高, 该 run 自身 line-height × 缩放比)。
           除数取 run 的 max，**不是** td 的 computed line-height —— 这是实测定点修正：
           真机探针（tests\\._verify\\u4\\probe2.json，配置 B＝现状 40px/6px）实测「典型值」格
           内容高 86 / td 行高 58 = **1.483**，离 Math.round 的 1.5 悬崖只差 0.017 —— 因为格内
           .std-value 是 64px 字体（内容高 ≈1.34em），而 td 的 line-height 只是 48px 字体的
           normal（≈1.21em）。按 run 取 max 后：单行时除数恰等于内容高 ⇒ 比值 **1.000**（离 1.5 有 0.5 余量）；
           断成两行时包围盒＝内容高＋行推进 ⇒ 比值 ≈1.78–1.90 ⇒ 取整 2（离 1.5 同样有余量）。
           两侧都不贴边 ⇒ 该指标在真机上既不误报也不漏报。题面口径的「包围盒高 ÷ td 行高」
           仍逐格打印（ratioByLh）供人工对照。 */
        let contentArea = 0, areaSrc = '（格内无可测文本）', advance = 0, advSrc = '（同左）';
        textRuns(td).forEach(function (r) {
          const rcs = getComputedStyle(r.el);
          const h = probeH(rcs, r.text);
          const rlh = parseFloat(rcs.lineHeight);
          const adv = Math.max(h, isFinite(rlh) && rlh > 0 ? rlh * scale : 0);
          if (h > contentArea) { contentArea = h; areaSrc = rcs.fontSize + ' × ' + JSON.stringify(r.text.slice(0, 8)); }
          if (adv > advance) { advance = adv; advSrc = rcs.fontSize + ' 行高=' + (isFinite(rlh) && rlh > 0 ? rlh + 'px' : 'normal'); }
        });
        const tdLh = parseFloat(cs.lineHeight);
        const divisor = advance;
        const range = document.createRange();
        range.selectNodeContents(td);
        const rb = range.getBoundingClientRect();
        const pL = parseFloat(cs.paddingLeft) || 0, pR = parseFloat(cs.paddingRight) || 0;
        const innerW = td.clientWidth - pL - pR;
        const innerOverflow = scale > 0 ? (rb.width / scale - innerW) : 0;
        const badge = td.querySelector('.std-state');
        let pair = null;
        if (badge) {
          const tn = [].slice.call(td.childNodes).filter(function (n) {
            return n.nodeType === 3 && n.textContent.trim();
          })[0];
          if (tn) {
            const nr = document.createRange();
            nr.selectNodeContents(tn);
            const nb = nr.getBoundingClientRect(), bb = badge.getBoundingClientRect();
            pair = {
              nameRight: +nb.right.toFixed(2), badgeLeft: +bb.left.toFixed(2),
              leftGap: +(bb.left - nb.right).toFixed(2),
              topDiff: +Math.abs(bb.top - nb.top).toFixed(2),
              bottomDiff: +Math.abs(bb.bottom - nb.bottom).toFixed(2),
              nameH: +nb.height.toFixed(2)
            };
          }
        }
        cells.push({
          row: tr.getAttribute('data-kind'), col: i, cls: String(td.className),
          text: td.textContent.trim().slice(0, 40),
          contentH: +rb.height.toFixed(2), contentArea: +contentArea.toFixed(2),
          divisor: +divisor.toFixed(2), areaSrc: areaSrc, advSrc: advSrc,
          ratio: divisor > 0 ? +(rb.height / divisor).toFixed(3) : null,
          ratioByLh: (isFinite(tdLh) && tdLh > 0) ? +(rb.height / (tdLh * scale)).toFixed(3) : null,
          lines: divisor > 0 ? Math.round(rb.height / divisor) : null,
          scrollW: td.scrollWidth, clientW: td.clientWidth,
          innerW: +innerW.toFixed(2), innerOverflow: +innerOverflow.toFixed(2),
          nowrap: cs.whiteSpace, textOverflow: cs.textOverflow, pair: pair
        });
      });
    });
    return {
      viewport: [window.innerWidth, window.innerHeight],
      scale: +scale.toFixed(4),
      forced: forced, rowCount: rows.length, cells: cells,
      table: { scrollW: table.scrollWidth, clientW: table.clientWidth }
    };
  })()`);

  if (!u4 || u4.fatal) {
    /* 取不到被测对象 ⇒ FAIL（不得静默通过、也不兜底成"跳过"） */
    check('B5b/U-4 任务数据页测试标准区可在真机量测（?tab=1、#tkStdTable 两行、徽标齐备）',
      false, (u4 && u4.fatal) || 'evaluate 未返回结果');
  } else {
    const cellBrief = c => `${c.row}.${c.col}[${c.cls.replace(/\s+/g, '/')}] 包围盒高=${c.contentH}` +
      ` ÷ 单行推进(${c.advSrc})=${c.divisor} = ${c.ratio} ⇒ ${c.lines} 行（内容高=${c.contentArea}，` +
      `题面口径 包围盒高÷td行高=${c.ratioByLh}）`;
    check('B5b/U-4 最坏态「超范围」已真实复现且结构齐备：两行 × 5 格 × 每行 1 个徽标，徽标文案实测为三字',
      u4.rowCount === 2 && u4.cells.length === 10 && u4.forced.length === 2 &&
      u4.forced.every(t => t === '超范围') && u4.cells.filter(c => c.pair).length === 2,
      `视口=${u4.viewport[0]}×${u4.viewport[1]}（stage scale=${u4.scale}）；行数=${u4.rowCount}、格数=${u4.cells.length}；` +
      `徽标强制后文案=[${u4.forced.join('、')}]（应 2 个「超范围」）；带"参数名＋徽标"的格=${u4.cells.filter(c => c.pair).length} 个`);
    check('B5b/U-4 每个 td 的内容只占一行（Range 包围盒高 ÷ 单行基准 取整 === 1；逐格打印实测值）',
      u4.cells.length === 10 && u4.cells.every(c => c.lines === 1),
      u4.cells.map(cellBrief).join('；'));
    const dc = u4.cells.filter(c => /std-derived/.test(c.cls));
    check('B5b/U-4 第 5 格只读导出值一行显示、不截断、不丢字（含「上限」「下限」两词 + computed white-space=nowrap + 非 ellipsis + 行数=1）',
      dc.length === 2 && dc.every(c => c.text.includes('上限') && c.text.includes('下限') &&
        c.nowrap === 'nowrap' && c.textOverflow !== 'ellipsis' && c.lines === 1),
      dc.map(c => `${c.row}: 文本=${JSON.stringify(c.text)}、含上限=${c.text.includes('上限')}、含下限=${c.text.includes('下限')}、` +
        `white-space=${c.nowrap}、text-overflow=${c.textOverflow}、行数=${c.lines}`).join('；') ||
      '（未找到 .std-derived 格 —— 取不到即 FAIL）');
    check('B5b/U-4 任一 td 无横向溢出（scrollWidth ≤ clientWidth + 1），且 Range 内容宽（÷ 缩放）不超出内容盒 + 2 px',
      u4.cells.length === 10 && u4.cells.every(c => c.scrollW <= c.clientW + 1 && c.innerOverflow <= 2),
      u4.cells.map(c => `${c.row}.${c.col}: scrollWidth=${c.scrollW}/clientWidth=${c.clientW}、` +
        `内容宽−内容盒=${c.innerOverflow}（内容盒=${c.innerW}）`).join('；'));
    check('B5b/U-4 表格无横向溢出（table.scrollWidth ≤ table.clientWidth + 1）',
      u4.table.scrollW <= u4.table.clientW + 1,
      `table.scrollWidth=${u4.table.scrollW} / table.clientWidth=${u4.table.clientW}`);
    const pairs = u4.cells.filter(c => c.pair && /std-name/.test(c.cls));
    check('B5b/U-4 参数名与三态徽标同排且垂直居中对齐（徽标左边界 ≥ 参数名右边界 − 1 px；顶差/底差 ≤ 参数名单行高的 1/2）',
      pairs.length === 2 && pairs.every(c => c.pair.leftGap >= -1 &&
        c.pair.topDiff <= c.pair.nameH / 2 && c.pair.bottomDiff <= c.pair.nameH / 2),
      pairs.map(c => `${c.row}: 参数名右边界=${c.pair.nameRight}、徽标左边界=${c.pair.badgeLeft}（间距=${c.pair.leftGap}）、` +
        `顶差=${c.pair.topDiff}、底差=${c.pair.bottomDiff}（容差=参数名单行高 ${c.pair.nameH} 的一半=${(c.pair.nameH / 2).toFixed(2)}）`)
        .join('；') || '（未找到 .std-name 格或其中缺「参数名＋徽标」—— 取不到即 FAIL）');
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  /* ===== B5c 任务数据页「测试标准区」占满卡片剩余高度：U-1 的**真机**判据（V1.36 / C-92） =====
     立案：FR-3.16 版面要求测试标准区**占满卡片剩余高度**（需求 :393 与 C-92）。此前只有
     `ui-check` 的**声明层**断言（`.std-limits { flex:1; min-height:0; height:100% }` +
     `.camera-menu { flex:none }`）—— 声明写了不等于真机上真的把行拉高了。本段在真机上量：
       ① 表下方/上方无剩余空白（与相邻已显示兄弟的缝隙 ≤ 该侧 computed margin + 2 px）
       ② 表确被 flex 拉伸（表高 ≥ 自然高 × 1.5；自然高＝整表临时移出文档流实测）
       ③ 无纵向溢出（表底 ≤ 卡片**内容盒底** + 2 px、卡片无滚动条）
       ④ 页内对照（防假绿）：临时 flexGrow=0 **且** height=auto 后表塌回自然高（≤ 正常态 40%），随后还原复测
     ⚠️ **几何模型（2026-09-24 按主代理沙箱外真机实测数据重写）**：上一版把"卡片内容盒底"
     用 `card.offsetTop + card.clientHeight − paddingBottom` 推导、又拿"表前兄弟累加"当剩余高度顶点，
     得出"剩余 1135 / 内容盒底 1646"这类**错误基准**，把正确版面判成 FAIL（①0.744、③超出 78.41、
     ④对照态反被 `height:100%` 撑到整卡高）。现只用 `getBoundingClientRect` + `computed margin/padding`。
     真机实测（3840×2160）：卡 399–1950（padding 31，内容盒底 1919、内高 1520）、表前兄弟 ≈481、
     表高 844.42、表后兄弟 ≈194.6 ⇒ 481 + 844.4 + 194.6 ≈ 1520，**恰好占满、无剩余空白**。
     阈值/容差：A1 取 0（只容忍兄弟自身 margin）、A2 取 1.5×（实测 ≈3.1×）、A3 取 2 px、
     A4 取"对照态 ≤ 正常态 40%"（实测 19%）；2 px 为亚像素/舍入容差，实测差值 0.0–10 px 量级、不贴边。
     ⚠️ 本段依赖浏览器权限：无 Edge / 沙箱禁命名管道时整脚本已 `skipSuite`（退 3，跳过 ≠ 通过）。 */
  section('B5c 任务数据页测试标准区占满卡片剩余高度（U-1 / C-92：3840×2160、页内 flex:none 对照）');
  await setViewport(3840, 2160);
  await openPage('?tab=1', 2500);
  const u1 = await evaluate(`(() => {
    const table = document.getElementById('tkStdTable');
    if (!table) return { fatal: '未找到 #tkStdTable' };
    const card = table.closest('.card');
    if (!card) return { fatal: '#tkStdTable 不在 .card 内（版面结构变了？）' };
    const rows = [].slice.call(table.querySelectorAll('tbody tr'));
    if (rows.length < 2) return { fatal: '数据行不足 2 行，无法量"两行被拉伸"' };
    const rowH = (tr) => tr.getBoundingClientRect().height;

    const visible = (el) => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
    };
    const px = (v) => (isFinite(parseFloat(v)) ? parseFloat(v) : 0);
    const hOf = (el) => (el ? +el.getBoundingClientRect().height.toFixed(2) : null);

    /* A1：表前后**已显示的**兄弟 —— 直接用 rect 量缝隙，不自行推导卡片几何 */
    const kids = [].slice.call(card.children);
    const ti = kids.indexOf(table);
    const prev = ti > 0 ? kids.slice(0, ti).filter(visible).slice(-1)[0] : null;
    const next = kids.slice(ti + 1).filter(visible)[0] || null;
    const tableRect = table.getBoundingClientRect();
    const tableMarginTop = px(getComputedStyle(table).marginTop);
    const nextMarginTop = next ? px(getComputedStyle(next).marginTop) : 0;
    const gapBelow = next ? +(next.getBoundingClientRect().top - tableRect.bottom).toFixed(2) : null;
    const gapAbove = prev ? +(tableRect.top - prev.getBoundingClientRect().bottom).toFixed(2) : null;

    /* A3 的基准：卡片**内容盒底**（只用 rect + computed padding，不用 clientHeight/offsetTop 推导） */
    const cardCs = getComputedStyle(card);
    const cardRect = card.getBoundingClientRect();
    const cardContentBottom = +(cardRect.bottom - px(cardCs.paddingBottom)).toFixed(2);
    const bottomOverflow = +(tableRect.bottom - cardContentBottom).toFixed(2);

    const tableH_normal = +table.getBoundingClientRect().height.toFixed(2);
    const rowH_normal = rows.map((tr) => +tr.getBoundingClientRect().height.toFixed(2));

    /* A2 的自然高：整表临时移出文档流（absolute + 自动高 + 自动宽 + 不参与 flex），量完逐字还原 */
    const st = table.style.cssText;
    const r0 = table.getBoundingClientRect();
    const parentCs = getComputedStyle(table.parentElement);
    table.style.position = 'absolute';
    table.style.left = (-30000 - Math.round(r0.left) + px(parentCs.paddingLeft)) + 'px';
    table.style.top = '0px';
    table.style.width = (parentCs.clientWidth - px(parentCs.paddingLeft) - px(parentCs.paddingRight)) + 'px';
    table.style.height = 'auto';
    table.style.maxHeight = 'none';
    table.style.flex = '0 0 auto';
    const tableH_natural = +table.getBoundingClientRect().height.toFixed(2);
    const rowH_natural = rows.map((tr) => +tr.getBoundingClientRect().height.toFixed(2));
    table.style.cssText = st;                       // 逐字还原 inline 样式

    /* A4 的页内对照：flexGrow=0 **且** height=auto（两个都要 —— 只改 flex 会让 height:100%
       按"整卡内容高"解析、把表撑得比正常还高，那是模型污染不是对照），量高后立即还原并复测 */
    table.style.flexGrow = '0';
    table.style.height = 'auto';
    const csCtrl = getComputedStyle(table);
    const tableH_control = +table.getBoundingClientRect().height.toFixed(2);
    const controlFlexGrow = csCtrl.flexGrow;
    const controlHeightRaw = csCtrl.height;
    table.style.removeProperty('flex-grow');
    table.style.removeProperty('height');
    const tableH_restored = +table.getBoundingClientRect().height.toFixed(2);
    const restoredCs = getComputedStyle(table);

    const cardContentTop = cardRect.top + px(cardCs.paddingTop);
    const contentH = +(cardRect.height - px(cardCs.paddingTop) - px(cardCs.paddingBottom)).toFixed(2);
    const sibBefore = +(tableRect.top - cardContentTop).toFixed(2);
    const sibAfter = +(cardContentBottom - tableRect.bottom).toFixed(2);
    return {
      viewport: [window.innerWidth, window.innerHeight],
      rows: rows.length, kinds: rows.map((tr) => tr.getAttribute('data-kind')),
      card: { top: +cardRect.top.toFixed(2), bottom: +cardRect.bottom.toFixed(2),
        padT: px(cardCs.paddingTop), padB: px(cardCs.paddingBottom),
        contentH: contentH, contentBottom: cardContentBottom,
        scrollOverflow: card.scrollHeight - card.clientHeight },
      geometry: { sibBefore: sibBefore, tableH: tableH_normal, sibAfter: sibAfter,
        reconstructed: +(sibBefore + tableH_normal + sibAfter).toFixed(2),
        prevTag: prev ? (prev.id || String(prev.className)) : null, prevH: hOf(prev),
        nextTag: next ? (next.id || String(next.className)) : null, nextH: hOf(next) },
      tableH_normal: tableH_normal, tableH_natural: tableH_natural,
      tableH_control: tableH_control, tableH_restored: tableH_restored,
      controlFlexGrow: controlFlexGrow, controlHeightRaw: controlHeightRaw,
      restoredFlexGrow: restoredCs.flexGrow, restoredHeightRaw: restoredCs.height,
      tableBottom: +tableRect.bottom.toFixed(2), cardContentBottom: cardContentBottom,
      bottomOverflow: bottomOverflow,
      gapBelow: gapBelow, nextMarginTop: +nextMarginTop.toFixed(2),
      gapAbove: gapAbove, tableMarginTop: +tableMarginTop.toFixed(2),
      rowH_normal: rowH_normal, rowH_natural: rowH_natural,
      tolerance: 2
    };
  })()`);

  if (!u1 || u1.fatal) {
    check('B5c/U-1 测试标准区占满卡片剩余高度可在真机量测（?tab=1、#tkStdTable 两行、卡片容器齐备）',
      false, (u1 && u1.fatal) || 'evaluate 未返回结果');
  } else {
    const stretch = u1.tableH_natural > 0 ? +(u1.tableH_normal / u1.tableH_natural).toFixed(3) : null;
    const controlRatio = u1.tableH_normal > 0 ? +((u1.tableH_control / u1.tableH_normal) * 100).toFixed(1) : null;
    const rowBrief = u1.rowH_normal.map((v, i) => `${u1.kinds[i]}: 行高 ${v} / 自然 ${u1.rowH_natural[i]}`).join('；');
    const geo = u1.geometry;
    const brief = `视口=${u1.viewport[0]}×${u1.viewport[1]}；卡片 ${u1.card.top}–${u1.card.bottom}` +
      `（padding ${u1.card.padT}/${u1.card.padB}、内容盒底=${u1.card.contentBottom}、内高=${u1.card.contentH}）；` +
      `几何对账：表前 ${geo.sibBefore} + 表高 ${geo.tableH} + 表后 ${geo.sibAfter} = ${geo.reconstructed}` +
      `（应＝内高 ${u1.card.contentH}，差 ${(geo.reconstructed - u1.card.contentH).toFixed(2)}）`;

    check('B5c/U-1 A1 表下方（与上方）无剩余空白：与相邻已显示兄弟的缝隙 ≤ 该侧 computed margin + 2px',
      u1.gapBelow !== null && u1.gapAbove !== null &&
      u1.gapBelow <= u1.nextMarginTop + u1.tolerance && u1.gapAbove <= u1.tableMarginTop + u1.tolerance,
      `表下缝隙=${u1.gapBelow}（下一兄弟 ${geo.nextTag} 高 ${geo.nextH}、其 margin-top=${u1.nextMarginTop}、容差 ${u1.tolerance}）；` +
      `表上缝隙=${u1.gapAbove}（上一兄弟 ${geo.prevTag} 高 ${geo.prevH}、表 margin-top=${u1.tableMarginTop}）；` +
      `判据：缝隙 ≤ 相邻兄弟/表自身 computed margin + ${u1.tolerance}px ⇒ "把剩余高度吃完、没有多余空白"；${brief}`);

    check('B5c/U-1 A2 表确被 flex 拉伸：表高 ≥ 自然高的 1.5 倍（自然高＝整表临时移出文档流实测）',
      stretch !== null && stretch >= 1.5,
      `表高=${u1.tableH_normal} / 自然高=${u1.tableH_natural} = **${stretch}×**（阈值 1.5×；本环境实测应 ≈3.1×）；` +
      `行高对照：${rowBrief}；${brief}`);

    check('B5c/U-1 A3 无纵向溢出：表底 ≤ 卡片**内容盒底** + 2px，且卡片未产生滚动条',
      u1.bottomOverflow <= u1.tolerance && u1.card.scrollOverflow <= u1.tolerance,
      `表底=${u1.tableBottom} / 内容盒底=${u1.cardContentBottom} ⇒ 超出 ${u1.bottomOverflow}px（容差 ${u1.tolerance}）；` +
      `卡片 scrollHeight−clientHeight=${u1.card.scrollOverflow}px；${brief}`);

    check('B5c/U-1 A4 页内对照（防假绿）：临时 flexGrow=0 且 height=auto 后表塌回自然高（≤ 正常态 40%），随后还原复测一致',
      u1.tableH_control <= u1.tableH_normal * 0.40 && u1.tableH_restored === u1.tableH_normal,
      `对照态（flex-grow=${u1.controlFlexGrow}、computed height=${u1.controlHeightRaw}）表高=${u1.tableH_control}` +
      ` ＝ 正常态 ${u1.tableH_normal} 的 **${controlRatio}%**（判据 ≤40%；本环境实测应 ≈19%）；` +
      `还原后复测=${u1.tableH_restored}（应＝正常态 ⇒ 页面未被污染）、computed flex-grow=${u1.restoredFlexGrow}、height=${u1.restoredHeightRaw}`);

    check('B5c/U-1 A4b 对照是"同一次 evaluate 的临时 DOM 改动"而非改仓库文件（flex-grow / height 已还原为样式表取值）',
      String(u1.restoredFlexGrow) !== '0' && String(u1.restoredHeightRaw) !== 'auto' &&
      u1.tableH_restored === u1.tableH_normal,
      `还原后 computed flex-grow=${u1.restoredFlexGrow}（不应是 0）、height=${u1.restoredHeightRaw}（不应是 auto）；` +
      `表高复测=${u1.tableH_restored} ＝ 正常态 ${u1.tableH_normal}`);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  /* ===== B5d `E197`（`#sStarted` 口径标注）＋ `E198`（帧缺件序号提示位）的**真机**判据 =====
     座位 4b（`T-20261007-03`）：把"当班任务统计"卡第 2 格（`#sStarted` 那一格）的三件事放到
     **file:// 的真页面**上量 —— 静态声明层与假 DOM 层的判据在 `ui-check` 的 U11 段，
     本段要证的是**真机渲染结果**（真 computed style、真排版）：
       ① 演示模式下该格**可见文本**里含「（演示派生）」；
       ② 该格可见文本里**不含**"帧缺件序号"（`E198` 的提示行在演示模式**不显示**；
          负责人 2026-10-07 裁定：该格已由 `E197` 声明为演示派生）；
       ③ 该格**未撑破指标块**：`scrollWidth ≤ clientWidth + 1` 且 `scrollHeight ≤ clientHeight + 1`。
     ⚠️ 判据口径（**不许**把"临时摘 `hidden` 再量"的读数当断言）：
        · 「可见文本」＝**只收可见的文本节点**：`TreeWalker(SHOW_TEXT)` 逐个文本节点走，
          该节点自身及其**全部祖先**都满足 `display !== 'none'` ∧ `visibility !== 'hidden'` 才收。
          **不能**用 `textContent`（把隐藏后代的文本一起算进来），也**不能**用"可见元素的
          `textContent` 拼起来"—— 后者会被**祖先元素**顶上来：复核实测（本段首跑即踩到）
          `#c114StartedSource` 已经 `display:none`、`childVisibility` 也判它不可见，
          但它的父元素 `.tile-label` 可见，于是可见文本里**仍有**「（演示派生）」
          ⇒ 那种口径对"隐藏"根本分辨不出来，是一条**防空洞**（ADR-0004 D23）。
          改用文本节点口径后：隐藏谁、谁的文本就真的从投影里消失（由本段探测面自证反证）；
        · 「未撑破」＝量**该格自身**（`.tile`）的 `scrollWidth/Height` vs `clientWidth/Height`，
          不临时改 DOM、不改 `hidden`、不改 `display` ⇒ 与页面的真实状态一致；
        · 另配**探测面自证**（同一次 evaluate 内，且**当场逐字还原**）：给提示位注入一个临时可见文本、
          再摘掉它的两道关闭 ⇒ 投影里它变"可见"、"帧缺件序号"能读出来；把后缀位藏起来 ⇒
          「（演示派生）」从可见文本里消失。两处都跟着变，才说明这个投影**分得出隐藏**；
          否则"不含帧缺件序号"可能只是探测器失灵（那正是 D23 要防的空洞形态）。
          该临时改动**在量完 ①②③ 之后**单独做一次，**不作为** ①②③ 的读数。
     ⚠️ 本段依赖浏览器权限：无 Edge / 沙箱禁命名管道时整脚本已在前文 `skipSuite`（退 3，跳过 ≠ 通过）。 */
  section('B5d `E197`/`E198` 真机判据（生产统计页「实际开工总数」格：演示派生标注 / 提示行不显示 / 未撑破）');
  {
    const B5D_RESOLUTIONS = [[3840, 2160], [1920, 1080], [1366, 768]];
    /* **同一把尺子**：三档分辨率的三条判据 + 探针自证的反证都用这三个函数（避免两处判据漂移）。 */
    const verdict = {
      demo: m => ({ ok: typeof m.visibleText === 'string' && m.visibleText.indexOf('（演示派生）') >= 0 &&
          m.srcText === '（演示派生）' && m.srcVisible === true && m.noteLv === 'demo',
        why: `可见文本=${JSON.stringify(String(m.visibleText).slice(0, 60))}；` +
          `#c114FrameUnitNote 的 dataset.noteLv=${JSON.stringify(m.noteLv)}（演示档应为 'demo'）` +
          `（本判据的读数是普通对象、可喂内存副本 —— 见下方 D22 那段）；` + m.brief }),
      noFrameText: m => ({ ok: typeof m.visibleText === 'string' && m.visibleText.indexOf('帧缺件序号') < 0 &&
          m.noteDisplay === 'none' &&
          m.childVisibility.some(c => c.id === 'c114FrameUnitNote' && c.visible === false),
        why: `可见文本含"帧缺件序号"=${String(m.visibleText).includes('帧缺件序号')}；` +
          `#c114FrameUnitNote 的 computed display=${m.noteDisplay}（应 none）、hidden 属性=${m.noteHiddenAttr}、` +
          `DOM 文本=${JSON.stringify(m.noteText)}（演示模式应为空串）；` + m.brief }),
      notBroken: m => ({ ok: m.overflow.sw <= m.overflow.cw + 1 && m.overflow.sh <= m.overflow.ch + 1,
        why: `scrollWidth=${m.overflow.sw} / clientWidth=${m.overflow.cw}（差 ${m.overflow.dw}）；` +
          `scrollHeight=${m.overflow.sh} / clientHeight=${m.overflow.ch}（差 ${m.overflow.dh}）；` + m.brief })
    };
    const readCell = () => evaluate(`(() => {
      const note = document.getElementById('c114FrameUnitNote');
      const tile = note ? note.closest('.tile') : null;
      const cell = tile || (document.getElementById('c114StartedSource') || {}).parentElement;
      if (!cell || !note) return { fatal: '未找到 #c114FrameUnitNote 或其 .tile 容器（生产统计页未渲染？）' };
      const vis = el => {
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      /* 只收**可见的文本节点**（自身与全部祖先都可见）—— 见段首 ⚠️ 的口径说明与实测反证 */
      const textOf = root => {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        let out = '';
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          let p = n.parentElement, ok = true;
          while (p) { if (!vis(p)) { ok = false; break; } p = p.parentElement; }
          if (ok) out += n.textContent || '';
        }
        return out;
      };
      const kids = [].slice.call(cell.querySelectorAll('*'));
      const childVisibility = kids.map(el => ({ id: el.id || null, cls: String(el.className || ''),
        text: (el.textContent || '').trim().slice(0, 24), visible: vis(el) }));
      const visibleText = vis(cell) ? textOf(cell) : '';
      const noteCs = getComputedStyle(note);
      const src = document.getElementById('c114StartedSource');
      return {
        viewport: [window.innerWidth, window.innerHeight],
        cellTag: cell.tagName + (cell.id ? '#' + cell.id : '') + '.' + String(cell.className || ''),
        srcText: src ? String(src.textContent || '') : null,
        srcDisplay: src ? getComputedStyle(src).display : null,
        srcVisible: src ? vis(src) : null,
        noteText: String(note.textContent || ''),
        noteDisplay: noteCs.display, noteVisibility: noteCs.visibility, noteHiddenAttr: note.hidden === true,
        /* E197/E198 的**机器可读标记**：StatsPanel.js:159 把 frameUnitIndexNote().mark 写进
           noteEl.dataset.noteLv（真 DOM 上 ≡ data-note-lv），四个字面值 demo|warn|err|ok；
           **与可见性解耦**（隐藏时照样写）⇒ 演示档的"没有这个读数"与服务端读到 0 的 ok 分得开。
           本段读的是**真机上真的那份 dataset**，不是另行推断出来的值（故本注释不用反引号：它在模板串里）。 */
        noteLv: (note.dataset && note.dataset.noteLv !== undefined) ? note.dataset.noteLv : null,
        noteLvAttr: note.getAttribute('data-note-lv'),
        tileText: String(cell.textContent || ''),
        visibleText,
        overflow: { sw: cell.scrollWidth, cw: cell.clientWidth, sh: cell.scrollHeight, ch: cell.clientHeight,
          dw: cell.scrollWidth - cell.clientWidth, dh: cell.scrollHeight - cell.clientHeight },
        childVisibility,
        /* ---- 以下四项为 B5e（E206，服务端档真机判据）追加：**同一把尺子**再读四处 ----
           （对 B5d 的三条断言完全无影响：只多读，不改任何既有字段的分寸。
             ⚠ 本注释在模板串内 ⇒ 一律不用反引号。） */
        startedText: (() => { const el = document.getElementById('sStarted'); return el ? String(el.textContent || '') : null; })(),
        serverMode: !!(window.MockData && window.MockData.state && window.MockData.state.serverMode === true),
        dataSource: (window.BoardConfig || {}).dataSource === undefined ? null : window.BoardConfig.dataSource,
        noteRect: (() => { const b = note.getBoundingClientRect();
          return { t: b.top, b: b.bottom, l: b.left, r: b.right, h: b.height }; })(),
        sibling: (() => {
          const parent = cell.parentElement;
          const tiles = parent ? [].slice.call(parent.children) : [];
          const i = tiles.indexOf(cell);
          const rc = el => { if (!el) return null; const b = el.getBoundingClientRect();
            return { t: b.top, b: b.bottom, l: b.left, r: b.right, w: b.width, h: b.height }; };
          const card = cell.closest('.card');
          let cardBottom = null;
          if (card) { const cs = getComputedStyle(card); const b = card.getBoundingClientRect();
            cardBottom = b.bottom - parseFloat(cs.paddingBottom || '0') - parseFloat(cs.borderBottomWidth || '0'); }
          return { self: rc(cell), prev: rc(tiles[i - 1]), next: rc(tiles[i + 1]), count: tiles.length, cardBottom };
        })()
      };
    })()`);

    /* A-7④：真机三档各读一次 `dataset.noteLv`（下面 `noteLvReadings` 收齐后**一条**断言）；
       `verdict.demo` 也已把 `m.noteLv === 'demo'` 并进"该格可见文本含「（演示派生）」"那条。 */
    const noteLvReadings = [];
    for (const [w, h] of B5D_RESOLUTIONS) {
      await setViewport(w, h);
      await openPage('?tab=3', 2500);            /* 生产统计页：这一格只在该页可见 */
      const m = await readCell();
      if (!m || m.fatal) {
        check(`B5d ${w}×${h} 「实际开工总数」格可在真机量测（?tab=3、#c114FrameUnitNote 与 .tile 容器齐备）`,
          false, (m && m.fatal) || 'evaluate 未返回结果');
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        continue;
      }
      const brief = `视口=${m.viewport[0]}×${m.viewport[1]}；格=${m.cellTag}；` +
        `#c114StartedSource: 文本=${JSON.stringify(m.srcText)}、display=${m.srcDisplay}、可见=${m.srcVisible}；` +
        `#c114FrameUnitNote: 文本=${JSON.stringify(m.noteText)}、display=${m.noteDisplay}、hidden 属性=${m.noteHiddenAttr}、` +
        `dataset.noteLv=${JSON.stringify(m.noteLv)}/@data-note-lv=${JSON.stringify(m.noteLvAttr)}`;
      m.brief = brief;                                 /* 供下面三个 `verdict.*` 共用 */
      noteLvReadings.push({ w, h, lv: m.noteLv, attr: m.noteLvAttr, m });

      /* 三档分辨率用**同一把尺子**（`verdict`）：探针自证那一节也复用它来反证"按变异态跑必红"。 */
      check(`B5d ${w}×${h} 该格可见文本含「（演示派生）」（真实渲染：后缀位 computed display=${m.srcDisplay}，非 none/不可见）`,
        verdict.demo(m).ok,
        verdict.demo(m).why);

      check(`B5d ${w}×${h} 该格可见文本**不含**"帧缺件序号"（演示模式下提示行不显示：` +
        '`#c114FrameUnitNote` 的 computed `display` 为 `none`、且它在"逐节点可见性"投影里判为不可见。' +
        '⚠ **不**要求它的 DOM 文本非空 —— 演示模式下渲染写的就是**空串**（服务端两档才有字），' +
        '拿"文本非空"当判据会把正确实现判红（复核实测踩到）；' +
        '"可见文本"这条投影本身是否分得出隐藏，由本段的探测面自证单独证明）',
        verdict.noFrameText(m).ok,
        verdict.noFrameText(m).why);

      check(`B5d ${w}×${h} 该格未撑破指标块（` +
        '`scrollWidth ≤ clientWidth + 1` ∧ `scrollHeight ≤ clientHeight + 1`；真机读数，不临时摘 hidden）',
        verdict.notBroken(m).ok,
        verdict.notBroken(m).why);
    }

    /* A-7④（`T-20261007-09`）：**顺手在真机上读一次** `dataset.noteLv` 并断言演示档 `=== 'demo'`。
       为什么要这条：`E198` 那两种"没有"（演示 `demo` / 服务端读到 0 `ok`）在**可见性与文本上都一样**
       （都不可见、文本都空）⇒ 上面三条断言**分辨不出**是哪一种；而这个标记正是实现里用来分开它们的那一位
       （`StatsPanel.js:159` 写、`frameUnitIndexNote()` 的 `mark` 给）。**服务端档不在真机可构造范围内**
       （本用例只跑演示档；服务端两档由 `ui-check` 的 vm 夹具构造），故**只断言 `demo`**。
       D22（内存变异 ⇒ 必红并指名；未变异 ⇒ 绿；`StatsPanel.js` 盘上字节全程未变）：把 **①真机实时读到的**
       读数留底，再把**该读数的内存副本**改成 `ok`（＝"两种没有混成同一个空"的错实现）跑**同一条 `verdict.demo`**
       ⇒ 必红且 `why` 里指名 `dataset.noteLv`；随后连同 `data-note-lv` 属性一起逐字还原并**回读核实**。
       ⚠ 第 ① 项是**当场现读**（不是用循环里那份快照）—— 否则"读到的就是 demo"可能只是拿了旧值。 */
    const noteLvNow = await evaluate(`(() => {
      const n = document.getElementById('c114FrameUnitNote');
      if (!n) return { fatal: '未找到 #c114FrameUnitNote' };
      return { lv: (n.dataset && n.dataset.noteLv !== undefined) ? n.dataset.noteLv : null,
        attr: n.getAttribute('data-note-lv') };
    })()`);
    const liveLv = noteLvNow && !noteLvNow.fatal ? noteLvNow.lv : null;
    const liveOk = Boolean(noteLvNow) && noteLvNow.fatal === undefined && liveLv === 'demo';
    let d22NoteLv = null;
    if (liveOk) {
      const base = noteLvReadings.map(r => r.m).filter(Boolean).sort((a, b) => a.viewport[0] - b.viewport[0])[0];
      const mutated = Object.assign({}, base, { noteLv: 'ok' });
      d22NoteLv = { base: base ? verdict.demo(base) : { ok: null, why: '（无基线读数）' },
        mut: verdict.demo(mutated),
        baseLv: base ? base.noteLv : null };
      const restore = await evaluate(`(() => {
        const n = document.getElementById('c114FrameUnitNote');
        if (!n) return { ok: false, lv: null };
        n.dataset.noteLv = 'demo';                      /* 逐字还原成实现写的那一位 */
        return { ok: n.dataset.noteLv === 'demo' && n.getAttribute('data-note-lv') === 'demo',
          lv: n.dataset.noteLv, attr: n.getAttribute('data-note-lv') };
      })()`);
      d22NoteLv.restored = restore;
    }
    check('B5d-A7④ 真机 `#c114FrameUnitNote` 的 `dataset.noteLv` 演示档 `=== \'demo\'`（三档分辨率读数；' +
      '服务端档不在真机可构造范围内、**只断言 demo**）＋ D22：把**该读数的内存副本**改成 `ok` ⇒ ' +
      '同一条 `verdict.demo` 必红并在 `why` 里指名 `dataset.noteLv`，还原后回绿',
      liveOk && noteLvReadings.length === 3 && noteLvReadings.every(r => r.lv === 'demo') &&
      noteLvReadings.every(r => r.attr === 'demo') &&
      d22NoteLv !== null && d22NoteLv.base.ok === true && d22NoteLv.mut.ok === false &&
      String(d22NoteLv.mut.why).indexOf('dataset.noteLv') >= 0 &&
      Boolean(d22NoteLv.restored) && d22NoteLv.restored.ok === true,
      `真机现读：\`dataset.noteLv\`=${JSON.stringify(liveLv)}、\`@data-note-lv\`=` +
      `${JSON.stringify(noteLvNow ? noteLvNow.attr : null)}（取不到即 FAIL）；` +
      `三档读数=[${noteLvReadings.map(r => `${r.w}×${r.h}: ${JSON.stringify(r.lv)}/@${JSON.stringify(r.attr)}`).join('、')}]（应三档全 'demo'）；` +
      `**D22 内存变异**：基线读数（内存副本，不改盘）判绿=${d22NoteLv && d22NoteLv.base.ok}、` +
      `\`dataset.noteLv\` ${JSON.stringify(d22NoteLv && d22NoteLv.baseLv)} → 'ok' 后同一条判据判红=` +
      `${Boolean(d22NoteLv) && d22NoteLv.mut.ok === false}、` +
      `红时指名=${JSON.stringify(String(d22NoteLv ? d22NoteLv.mut.why : '（未跑）').slice(0, 160))}；` +
      `还原并回读=${JSON.stringify(d22NoteLv && d22NoteLv.restored)}（应 lv/attr 都回 'demo'）`);

    /* 探测面自证（**只作读数**，且当场逐字还原）：若"隐藏"根本分辨不出来，上面那条"不含帧缺件序号"
       就可能是碰巧（真机 `textContent` 里那句话只要存在就永远在）。这一段证明探测器**确实**按
       computed display 分辨，并在同一次 evaluate 内还原全部临时改动；任何断言都**不**引用
       这里量到的几何，只用"探测器在这两处是否跟着变"。
       ⚠ 演示模式下 `#c114FrameUnitNote` 的文本**本来就是空串** ⇒ 自证时给它注入一个临时可见文本
       （`TMP_FRAME_TEXT` 含"帧缺件序号"），否则"摘掉隐藏后也读不出字"会把自证自己判红。 */
    await setViewport(3840, 2160);
    await openPage('?tab=3', 2500);
    const probe = await evaluate(`(() => {
      const TMP = '帧缺件序号：自证用临时文本';
      const cell = document.getElementById('c114FrameUnitNote').closest('.tile');
      const vis = el => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden'; };
      const snap = () => {
        const kids = [].slice.call(cell.querySelectorAll('*'));
        /* 与上面 readCell 的投影**逐字同口径**：只收可见的文本节点（自身与全部祖先都可见） */
        const textOf = root => {
          const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
          let out = '';
          for (let n = w.nextNode(); n; n = w.nextNode()) {
            let p = n.parentElement, ok = true;
            while (p) { if (!vis(p)) { ok = false; break; } p = p.parentElement; }
            if (ok) out += n.textContent || '';
          }
          return out;
        };
        const contributors = kids.filter(vis).map(el => ({ id: el.id || null, cls: String(el.className || ''),
          hitDemo: (el.textContent || '').indexOf('（演示派生）') >= 0,
          hitFrame: (el.textContent || '').indexOf('帧缺件序号') >= 0 }));
        return {
          visibleText: textOf(cell),
          childVisibility: kids.map(el => ({ id: el.id || null, visible: vis(el) })),
          contributors,
          srcText: document.getElementById('c114StartedSource').textContent,
          srcVisible: (() => { const s = document.getElementById('c114StartedSource'); return vis(s); })(),
          noteDisplay: getComputedStyle(document.getElementById('c114FrameUnitNote')).display,
          noteText: document.getElementById('c114FrameUnitNote').textContent,
          overflow: (() => { const t = cell; return { sw: t.scrollWidth, cw: t.clientWidth, sh: t.scrollHeight, ch: t.clientHeight,
            dw: t.scrollWidth - t.clientWidth, dh: t.scrollHeight - t.clientHeight }; })()
        };
      };
      const note = document.getElementById('c114FrameUnitNote');
      const src = document.getElementById('c114StartedSource');
      const noteStyle = note.getAttribute('style');   /* 逐字留底 */
      const srcStyle = src.getAttribute('style');
      const noteTextBackup = note.textContent;
      const srcTextBackup = src.textContent;
      const before = snap();
      /* ⚠ 必须**先冻结这两个位的按帧重写**（'?tab=3' 页每秒 tick 会调 Dom.setText 把演示后缀写回来）：
         否则"藏起来"的临时改动会被下一帧冲掉，量到的仍是"有后缀" ⇒ 自证自己判红（复核实测踩到）。 */
      const FREEZE = ['c114StartedSource', 'c114FrameUnitNote'];
      const realSetText = window.Dom.setText;
      window.Dom.setText = function (id, v) {
        const r = realSetText.apply(this, arguments);
        if (FREEZE.indexOf(id) >= 0) { if (id === 'c114StartedSource') src.textContent = srcTextBackup; else note.textContent = noteTextBackup; }
        return r;
      };
      note.textContent = TMP;                         /* 临时可见文本（含"帧缺件序号"） */
      note.style.display = '';
      note.hidden = false;                            /* 两道关闭都摘掉 ⇒ 它应当"可见" */
      src.style.display = 'none';                     /* 后缀位藏起来 ⇒ 它应当从可见文本里消失 */
      const during = snap();
      /* ---- 逐字还原（按帧重写 + 属性 + 文本），随后复测 ---- */
      window.Dom.setText = realSetText;
      note.textContent = noteTextBackup;
      if (noteStyle === null) note.removeAttribute('style'); else note.setAttribute('style', noteStyle);
      note.hidden = true;
      if (srcStyle === null) src.removeAttribute('style'); else src.setAttribute('style', srcStyle);
      src.textContent = srcTextBackup;
      const after = snap();
      return {
        beforeDemoContributors: before.contributors.filter(c => c.hitDemo),
        duringHasFrameText: during.visibleText.indexOf('帧缺件序号') >= 0,
        duringNoteVisible: during.childVisibility.some(c => c.id === 'c114FrameUnitNote' && c.visible === true),
        duringHasDemoNote: during.visibleText.indexOf('（演示派生）') >= 0,
        duringDemoContributors: during.contributors.filter(c => c.hitDemo),
        duringSrcSeen: during.contributors.some(c => c.id === 'c114StartedSource'),
        afterVisibleText: after.visibleText,
        /* mutation 态（＝"该格可见文本含帧缺件序号"的错实现）与 baseline 态各一份**原始读数**，
           交给 Node 侧用**同一个** verdict 判 ⇒ 反证的是**这三条断言本身**，不是另写一段判据。
           （标签在 Node 侧补，避免在 evaluate 体里嵌模板字面量。） */
        mut: during,
        base: after,
        restored: window.Dom.setText === realSetText &&
          String(note.getAttribute('style') || '') === String(noteStyle || '') &&
          note.hidden === true && getComputedStyle(note).display === 'none' &&
          note.textContent === noteTextBackup &&
          String(src.getAttribute('style') || '') === String(srcStyle || '') &&
          src.textContent === srcTextBackup
      };
    })()`);
    /* D22（`E198` 那一组）：**按变异态跑同一条判据 ⇒ 必红并指名到具体元素**；
       未变异（刚还原的页面）⇒ 同一条判据必绿。这是"可证伪"的直接证据，不是推理。 */
    const probeBrief = o => `可见文本=${JSON.stringify(String(o.visibleText).slice(0, 60))}、` +
      `#c114StartedSource 文本=${JSON.stringify(o.srcText)}/可见=${o.srcVisible}、` +
      `#c114FrameUnitNote display=${o.noteDisplay}/DOM 文本=${JSON.stringify(o.noteText)}`;
    if (probe) {
      probe.mut = Object.assign({}, probe.mut, { brief: probeBrief(probe.mut), cellTag: 'probe-mutation' });
      probe.base = Object.assign({}, probe.base, { brief: probeBrief(probe.base), cellTag: 'probe-restored' });
    }
    const mutVerdict = probe ? verdict.noFrameText(probe.mut) : { ok: null, why: '（探针未返回）' };
    const baseVerdict = probe ? verdict.noFrameText(probe.base) : { ok: null, why: '（探针未返回）' };
    check('B5d 探测器面自证 ＋ `E198` D22（只作读数、当场逐字还原）：摘掉 `#c114FrameUnitNote` 的' +
      '两道关闭并给它一个含"帧缺件序号"的临时文本（＝"提示行本该不可见却可见"的**变异态**）⇒ ' +
      '同一条 `noFrameText` 判据**必红并指名 `#c114FrameUnitNote`**；把 `#c114StartedSource` 藏起来 ⇒ ' +
      '「（演示派生）」从可见文本消失（证明投影分得出隐藏）；随后逐字还原 ⇒ 同一条判据回到绿',
      probe && probe.duringHasFrameText === true && probe.duringNoteVisible === true &&
      probe.duringHasDemoNote === false && probe.restored === true &&
      baseVerdict.ok === true && mutVerdict.ok === false &&
      mutVerdict.why.indexOf('c114FrameUnitNote') >= 0 &&
      typeof probe.afterVisibleText === 'string' && probe.afterVisibleText.indexOf('（演示派生）') >= 0 &&
      probe.afterVisibleText.indexOf('帧缺件序号') < 0,
      `摘关闭后：可见文本含"帧缺件序号"=${probe && probe.duringHasFrameText}、` +
      `#c114FrameUnitNote 判为可见=${probe && probe.duringNoteVisible}、` +
      `可见文本含「（演示派生）」=${probe && probe.duringHasDemoNote}（应 false ⇒ 证明后缀位被藏后确实消失）；` +
      `**D22 反证**：变异态跑 noFrameText 判据 ⇒ 判红=${mutVerdict.ok === false}、指名内容=${JSON.stringify(String(mutVerdict.why).slice(0, 160))}；` +
      `还原态跑同一条 ⇒ 判绿=${baseVerdict.ok === true}；` +
      `探针读数：摘关闭前"（演示派生）"的贡献者 ${(probe && probe.beforeDemoContributors || []).length} 个，` +
      `摘关闭时 ${(probe && probe.duringDemoContributors || []).length} 个` +
      `（${(probe && probe.duringDemoContributors || []).map(c => c.cls || c.id).join('、') || '（无）'}）、` +
      `后缀位仍在可见集合=${probe && probe.duringSrcSeen}；还原=${probe && probe.restored}`);
    /* ===== B5e `E206`：`E197`／`E198` 的**服务端档**真机判据 =====
       立案（`E206`，2026-10-07 由主代理在收口 `E197`／`E198` 时**如实分立**）：`tests\ui-check.js` 的
       **U11** 已用假 DOM 把四态文案与 `data-note-lv` 逐字钉死（含服务端 `err`／`warn` 两档），而
       `tests\browser-check.js` 的 **B5d** 只在**演示档**（`file://`）真机读数 ⇒
       **服务端模式下的真实版面（提示行是否真的可见、是否挤压邻格、`data-note-lv` 在真机上的取值）
       在门禁里没有真机证据**（`file://` 下取不到 `/health`）。

       **本段在 `E206` 的二选一里选 ①**：补一组"**起本地服务端 ⇒ 真机读服务端档 `data-note-lv` 与版面**"
       的真机判据。**归属选 `browser-check` 的理由**（不是"顺手"）：
         · 要证的是**真机渲染结果**（真 computed style、真排版、真 `dataset`），只有 CDP 面能证；
           `platform-check` 是**纯文本/进程内**的平台适配层判据（它的整脚本定位就是"不起浏览器"），
           把真机判据塞进去会破坏它自己的分层；
         · B5d 已经在这里把"服务端档不在真机可构造范围内、只断言 `demo`"**明文登记**过（见上一条断言的
           注释与 `why`）⇒ 缺口就落在本文件的这一处，补在这里才是**闭合**而不是新开一处。
       **复用而非新造**：起服务端走 `tests\lib\harness.js` 的 `startService`／`makeTempDir`
       （`harness-check` 的端到端与 `T-20261005-21` 用的是同一条设施，见 `harness-check` §W7／§二十六），
       **不另写启动器、不占固定端口**（`allocPort` 随机）；灌帧走**既有接口** `POST /ifd/frame`，
       载荷字段取自 `src\config\fieldMap.js` 的 `samplePayload`（**单一真源**，不手抄字段名）。

       三档怎么造（**都在真服务端上造，不碰 `src\`**）：
         · **`err` 档**：灌 1 帧带合法 `unitIndex` ＋ 1 帧**不带** `unitIndex` ⇒
           `/health.frameUnitIndex.withoutIndex > 0` ⇒ 提示行应**可见**且红字点名"件序号"；
         · **`ok` 档**：另起一个干净库、只灌带 `unitIndex` 的帧 ⇒ `withoutIndex === 0` ⇒ 提示行**不可见、
           文本为空**，但 `data-note-lv` 必须是 `ok` —— 这正是 `E198` 要分开的"两种『没有』"
           （演示 `demo` ≠ 服务端读到 0 `ok`）在**真机**上的证据。
         · ⚠ **未覆盖（如实登记）**：`warn` 档（`/health` 读数未取得）在**健康服务端上不可达**
           （要构造它得让 `/health` 失败或让 IF-D 未接线）⇒ 该档真机证据**仍然缺**，
           现由 `ui-check` U11 的假 DOM 面承担。`demo` 档由 B5d 承担。**不得据本段全绿宣称"四态均已真机验证"**
           （ADR-0004 D19）。

       "挤压邻格"怎么量（**可判定**的形态，不靠观感）：①本格 `scrollWidth/Height ≤ client/Height + 1`
       （未撑破）②提示行的 `getBoundingClientRect()` **完整落在本格矩形内**（不许越出格子）
       ③本格与同容器相邻格的两两矩形**不相交**。三者都只用**同域**的量（元素自身 scroll/client ＋
       rect 对 rect）—— **刻意不比"本格底 vs 卡片内容盒底"**：那是"视觉坐标 vs 未缩放布局值"的混算，
       在 1920×1080/1366×768（舞台按 0.5 缩放）下会凭空多出 ~15.5 px（首版实测 534 vs 518.5 ⇒ 假红），
       与 `tests\README.md` 的 B5b 注记同源；该读数只打印、不作判据。
       ⚠ 只断言"结构上没坏"，**不**断言"提示行占了多少行高" —— 行高由 `.tile` 的布局决定，
       写死行高会在正当的样式调整后落空（`E205` 的教训）。

       真机取数链（**渲染层不发请求**）：同源托管页（`GET /` 由 `server/http/site.js` 提供）＋
       `?source=server` ⇒ `state.serverMode === true`；`/health` 读数由**既有**的
       `services/selfCheckProbe.js`（5 s 节流）经 `SettingPanel.render()` 触发 ⇒ **不新造取数通道**
       （PROJECT_RULES 9.6 单一真源）。故本段每档都**先落生产统计页、再切设置页触发探测、再切回来量版面**。
       ⚠ 本段依赖浏览器权限 **＋** 能起 Node 子进程：无 Edge / 沙箱禁命名管道时整脚本已在前文
       `skipSuite`（退 3，跳过 ≠ 通过）。 */
    section('B5e `E206` 服务端档真机判据（起真服务端 ⇒ 真机读 `#c114FrameUnitNote` 的 `data-note-lv` 与版面）');
    {
      /* 帧载荷取自配置真源（`fieldMap.samplePayload`）：字段名不手抄，改契约时本段自动跟随 */
      const sampleFrame = (() => {
        const sb = { console };
        sb.window = sb;
        vm.createContext(sb);
        const rel = path.join('src', 'config', 'fieldMap.js');
        vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sb, { filename: path.join(ROOT, rel) });
        return Object.assign({}, sb.window.FieldMap.samplePayload);
      })();
      const pad2 = n => String(n).padStart(2, '0');
      /** DR-16 的本地时刻文本（**不经 `toISOString()`** —— 那会转 UTC、帧落到班次窗口之外） */
      const stampOf = (d, off) => {
        const t = new Date(d.getTime() + off * 1000);
        return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) + ' ' +
          pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
      };
      /** 起一个**真服务端**并灌帧：`unitIndexes` 里的 `null` ＝ **缺件序号**帧（`testStatus` 取 0（待机）⇒ P0-4 不推断件序号、`unit_index` 仍 NULL）。
       *  夹具**延迟加载**（放在函数内）：万一 `tests\lib\harness.js` 在本环境载入即抛
       *  （临时区语义校验不过等），它会被上面的 try 收成"环境不满足 ⇒ 显式跳过"，而不是把
       *  整脚本打成异常退出（规范 9.5-5：跑不了要说跑不了，跳过 ≠ 通过）。 */
      async function serveWith(unitIndexes) {
        const harnessLib = require('./lib/harness');
        const svc = await harnessLib.startService({
          script: 'server/index.js', args: ['--data-dir', harnessLib.makeTempDir('b5e-data')],
          readyPath: '/health', timeoutMs: 30000
        });
        const base = 'http://127.0.0.1:' + svc.port;
        const now = new Date();
        const n = unitIndexes.length;
        const posted = [];
        for (let i = 0; i < n; i++) {
          const f = Object.assign({}, sampleFrame, { collectTime: stampOf(now, -2 * (n - i)) });
          if (unitIndexes[i] === null) { delete f.unitIndex; f.testStatus = 0; } else f.unitIndex = unitIndexes[i];
          const r = await fetch(base + '/ifd/frame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json;charset=UTF-8' },
            body: JSON.stringify(f)
          });
          const body = await r.json();
          posted.push({ status: r.status, outcome: body.outcome });
        }
        const health = await (await fetch(base + '/health')).json();
        const snap = await (await fetch(base + '/state')).json();
        return { svc, base, health, snap, posted };
      }
      const startedQtyOf = snap =>
        (snap && snap.snapshot && snap.snapshot.stats) ? snap.snapshot.stats.startedQty : null;
      /** 真机取数：同源服务端页（`?source=server&tab=3`）⇒ 切设置页触发**既有**探测 ⇒ 切回量版面 */
      async function readServerCellAt(base, w, h) {
        await setViewport(w, h);
        await openUrl(base + '/?source=server&tab=3', 2600);
        await clickTab(7);
        await sleep(2600);
        await clickTab(3);
        await sleep(1600);
        return await readCell();
      }
      const briefOf = m => '视口=' + m.viewport[0] + '×' + m.viewport[1] + '；serverMode=' + m.serverMode +
        '、dataSource=' + JSON.stringify(m.dataSource) + '；格=' + m.cellTag +
        '；#c114StartedSource 文本=' + JSON.stringify(m.srcText) + '／display=' + m.srcDisplay +
        '；#c114FrameUnitNote 文本=' + JSON.stringify(m.noteText) + '／display=' + m.noteDisplay +
        '／hidden 属性=' + m.noteHiddenAttr + '／dataset.noteLv=' + JSON.stringify(m.noteLv);
      /* **同一把尺子**（纯函数）：原件读数与 D22 变异读数都喂给这三个判据 —— 不另写一份期望 */
      const SVERD = {
        prodFacts: (m, wantStarted) => ({
          /* ⚠ 判据取**可见文本投影里没有「（演示派生）」**（与 B5d 同一投影口径），
             **不**取"后缀位 `display:none`"：`E197` 的实现口径是 `setText(..., '')` ——
             **清空文本**，不是隐藏元素（真机实测 `srcText=""` 且 `srcDisplay="inline"`）。
             首版我把期望写成 `srcVisible === false` ⇒ 三条断言全红；按 ADR-0004 D21 判定：
             **实际值是对的**（`ui-check` U11 的 `E197-②` 逐字断言的就是"该位文本为空串"，
             从不涉及可见性）⇒ 改**期望**，并把这条判定留在此处（不改成"隐藏元素"那种实现，
             那会同时打红 U11）。 */
          ok: m.srcText === '' && m.visibleText.indexOf('（演示派生）') < 0 &&
            m.startedText === String(wantStarted),
          why: '#c114StartedSource 文本=' + JSON.stringify(m.srcText) + '（服务端档应**逐字为空串**；' +
            '该位是**空的内联元素**，computed display=' + m.srcDisplay + ' ⇒ 元素本身仍"可见"，' +
            '故判据看**可见文本投影**）、可见文本含「（演示派生）」=' +
            (m.visibleText.indexOf('（演示派生）') >= 0) + '（应为 false）；#sStarted 真机文本=' +
            JSON.stringify(m.startedText) + '（应 ＝ 服务端 `/state` 的 `startedQty` ' +
            JSON.stringify(String(wantStarted)) + '）；' + m.brief
        }),
        noteVisibleErr: (m, withoutIndex, mixedTickets) => {
          /* `E64`（2026-10-07 负责人"同票混帧语义：以带件序号的帧为准 ＋ 缺序号帧如实计数并可见"）：
             `mixedTickets > 0` ⇒ 实现会在既有 err 文案**之后追加**一句下界说明；
             `mixedTickets === 0`／键缺失 ⇒ 文案**逐字不变**。真机判据按服务端 `/health` 的**真值**分档：
             混合票数取自 `frameUnitIndex.mixedTickets`（**不手抄**），期望后缀也由它现拼。 */
          const mixed = (typeof mixedTickets === 'number' && Number.isFinite(mixedTickets) && mixedTickets > 0)
            ? mixedTickets : 0;
          const suffix = mixed > 0
            ? '；其中 ' + mixed + ' 票为同票混帧（件数按带件序号的帧计 ⇒ 已完成只是下界）' : '';
          const textOk = m.noteText.indexOf('帧未带件序号') >= 0 &&
            m.noteText.indexOf('本班 ' + withoutIndex + ' 帧') >= 0;
          return {
            ok: m.noteLv === 'err' && m.noteHiddenAttr === false && m.noteDisplay !== 'none' &&
              m.noteVisibility !== 'hidden' && textOk &&
              (suffix === '' ? m.noteText.indexOf('同票混帧') < 0 : m.noteText.indexOf(suffix) >= 0),
            why: 'dataset.noteLv=' + JSON.stringify(m.noteLv) + "（应 'err'）、hidden 属性=" + m.noteHiddenAttr +
              '（应 false）、computed display=' + m.noteDisplay + '／visibility=' + m.noteVisibility +
              '（应可见）、DOM 文本=' + JSON.stringify(m.noteText) + '（应含"帧未带件序号"与"本班 ' +
              withoutIndex + ' 帧"）；`E64` 混帧档：服务端 mixedTickets=' + JSON.stringify(mixedTickets) +
              ' ⇒ 期望' + (suffix === '' ? '**不含**"同票混帧"字样' : '含后缀 ' + JSON.stringify(suffix)) +
              '（实测含该后缀=' + (m.noteText.indexOf('；其中 ') >= 0 && m.noteText.indexOf('同票混帧') >= 0) + '）；' + m.brief
          };
        },
        noteHiddenOk: m => ({
          ok: m.noteLv === 'ok' && m.noteHiddenAttr === true && m.noteDisplay === 'none' &&
            String(m.noteText) === '',
          why: 'dataset.noteLv=' + JSON.stringify(m.noteLv) + "（应 'ok'；演示档是 'demo' ⇒ 两种『没有』" +
            '不得混同）、hidden 属性=' + m.noteHiddenAttr + '（应 true）、computed display=' + m.noteDisplay +
            '（应 none）、DOM 文本=' + JSON.stringify(m.noteText) + '（应空串）；' + m.brief
        }),
        layout: m => {
          const s = m.sibling || {};
          const hit = (a, b) => Boolean(a && b) && a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
          const inTile = Boolean(s.self) && m.noteRect.t >= s.self.t - 1 && m.noteRect.b <= s.self.b + 1;
          const noOverlap = !hit(s.self, s.prev) && !hit(s.self, s.next);
          /* ⚠ **刻意不比"本格底 vs 卡片内容盒底"**：`getBoundingClientRect()` 是**舞台缩放后**的视觉
             坐标（`UI-02 4K 舞台`在 1920×1080/1366×768 下按 0.5 缩放），而 `computed paddingBottom`
             是**未缩放**的布局值 —— 两者相减会凭空多出 ~15.5 px（首版实测：1920×1080 下 534 vs 518.5）。
             这正是 `tests\README.md` 的 B5b 注记里那句"在 0.5 缩放舞台下须按缩放归一"的同类口径陷阱。
             故本判据只用**同域**的量：元素自身的 `scroll*` vs `client*`（都不受缩放影响）
             与 rect 对 rect 的比较（同为视觉坐标）。 */
          return {
            ok: m.overflow.sw <= m.overflow.cw + 1 && m.overflow.sh <= m.overflow.ch + 1 &&
              inTile && noOverlap,
            why: '本格 scrollWidth/clientWidth=' + m.overflow.sw + '/' + m.overflow.cw +
              '、scrollHeight/clientHeight=' + m.overflow.sh + '/' + m.overflow.ch +
              '（差值 ' + m.overflow.dw + ',' + m.overflow.dh + '，均需 ≤ +1）；提示行 rect=[' +
              m.noteRect.t + ',' + m.noteRect.b + ']（高 ' + m.noteRect.h + '）完整落在本格 [' +
              (s.self ? s.self.t : '?') + ',' + (s.self ? s.self.b : '?') + '] 内=' + inTile +
              '；与同容器相邻格（共 ' + s.count + ' 格，上一格 ' + JSON.stringify(s.prev) +
              '、下一格 ' + JSON.stringify(s.next) + '）矩形不相交=' + noOverlap +
              '；【读数·不作断言】本格底 vs 卡片内容盒底 = ' + (s.self ? s.self.b : '?') + ' vs ' +
              s.cardBottom + '（含舞台缩放与布局值混算，**不作判据**，见本函数注释）；' + m.brief
          };
        }
      };

      let errSvc = null;
      let okSvc = null;
      let b5eInfra = null;
      try {
        errSvc = await serveWith([7, null]);
        okSvc = await serveWith([7, 8]);
      } catch (e) {
        /* 服务端起不来 ⇒ **环境不满足**，按规范 9.5-5 的口径"跳过 ≠ 通过"显式记跳过并写出原因
           （`server/index.js` 自身的启动回归由 `harness-check` 的 §W6/§W7 硬判，
             本脚本不替它判；这里只保证"跑不了就说跑不了"）。 */
        b5eInfra = e;
      }
      try {
        if (b5eInfra) {
          skip('B5e 服务端档真机判据（起本地服务端 ⇒ 真机读 `data-note-lv` 与版面）',
            '本地服务端起不来 ⇒ 本用例环境不满足（**跳过 ≠ 通过**；服务端自身的启动回归由 harness-check 判）：' +
            b5eInfra.message);
        } else {
          await runB5eChecks(errSvc, okSvc);
        }
      } finally {
        /* 服务端子进程与临时目录一律收尾（失败也不留进程/端口） */
        if (errSvc) await errSvc.svc.stop();
        if (okSvc) await okSvc.svc.stop();
      }

      /** B5e 的断言主体（服务端已就绪时调用）。**函数声明在块内提升** ⇒ 可写在调用点之后，
       *  这样"服务端起不来就显式跳过"的分支不会把整段断言体再缩进一层（规范第五章：缩进 2 空格）。 */
      async function runB5eChecks(errSvc, okSvc) {
        const errFi = (errSvc.health && errSvc.health.frameUnitIndex) || {};
        const okFi = (okSvc.health && okSvc.health.frameUnitIndex) || {};
        const errStarted = startedQtyOf(errSvc.snap);
        const okStarted = startedQtyOf(okSvc.snap);
        check('B5e 前提：两档真服务端的 `/health.frameUnitIndex` 与 `/state.stats.startedQty` 都取得到，' +
          '且两档在"缺件序号"这一位上**确实不同**（否则本段的分档没有意义）',
          typeof errFi.withoutIndex === 'number' && errFi.withoutIndex > 0 && errFi.withIndex > 0 &&
          okFi.withoutIndex === 0 && okFi.withIndex > 0 &&
          typeof errStarted === 'number' && typeof okStarted === 'number',
          'err 现场：/health.frameUnitIndex=' + JSON.stringify(errFi) + '、startedQty=' + errStarted +
          '；ok 现场：/health.frameUnitIndex=' + JSON.stringify(okFi) + '、startedQty=' + okStarted +
          '；灌帧结果=' + JSON.stringify(errSvc.posted) + '／' + JSON.stringify(okSvc.posted));

        /* ---- `err` 档：三档分辨率（**提示行可见** —— 版面风险就在这一档） ---- */
        let errBase = null;
        for (const [w, h] of B5D_RESOLUTIONS) {
          const m = await readServerCellAt(errSvc.base, w, h);
          if (!m || m.fatal || m.startedText === null) {
            check('B5e ' + w + '×' + h + ' 服务端 `err` 档「实际开工总数」格可在真机量测' +
              '（?source=server&tab=3、#c114FrameUnitNote／#sStarted／.tile 齐备）',
              false, (m && m.fatal) || (m && m.startedText === null ? '未找到 #sStarted' : 'evaluate 未返回结果'));
            continue;
          }
          m.brief = briefOf(m);
          if (!errBase) errBase = m;
          check('B5e ' + w + '×' + h + ' 服务端 `err` 档**可在真机量测**且确实是服务端模式' +
            '（`state.serverMode === true`；同源托管页 ⇒ `resolveBaseUrl()` 走相对路径）',
            m.serverMode === true,
            m.brief + '（serverMode 必须为 true —— 否则本页其实是回退后的演示档，下面几条会连带判红）');
          const pf = SVERD.prodFacts(m, errStarted);
          check('B5e ' + w + '×' + h + ' 服务端档**生产口径**（真机）：`#c114StartedSource` 文本**逐字为空串**' +
            '（不标「（演示派生）」）且 `#sStarted` 数值**＝服务端 `/state` 的 `startedQty`**（真机端到端对账）',
            pf.ok, pf.why);
          const nv = SVERD.noteVisibleErr(m, errFi.withoutIndex, errFi.mixedTickets);
          check('B5e ' + w + '×' + h + ' 服务端 `err` 档：`withoutIndex > 0` ⇒ 提示行**真的可见**' +
            '（`hidden` 属性 false ＋ computed `display`/`visibility` 均可见）且文案逐字含"帧未带件序号"' +
            '与"本班 N 帧"（N 取自 `/health` 真值）＋ `E64` 的混帧后缀（`mixedTickets > 0` ⇒ 追加' +
            '「其中 N 票为同票混帧 … 已完成只是下界」；为 0/键缺失 ⇒ **逐字不含**该后缀）',
            nv.ok, nv.why);
          const ly = SVERD.layout(m);
          check('B5e ' + w + '×' + h + ' 服务端 `err` 档版面：**未撑破**（scroll ≤ client + 1）＋ 提示行' +
            '**完整落在本格内** ＋ 与相邻格矩形**不相交**（"不挤压邻格"的可判定形态；只用同域的量，' +
            '不混算舞台缩放，见 `layout` 判据注释）',
            ly.ok, ly.why);
        }

        /* ---- D22（ADR-0004）：内存读数副本 ＋ 真机 DOM 变异，两支都要"必红并指名" ---- */
        let d22 = null;
        if (errBase) {
          const lvMut = Object.assign({}, errBase, { noteLv: 'ok' });
          const hiddenMut = Object.assign({}, errBase, { noteHiddenAttr: true, noteDisplay: 'none' });
          const domMut = await evaluate(`(() => {
            const n = document.getElementById('c114FrameUnitNote');
            if (!n) return { fatal: '未找到 #c114FrameUnitNote' };
            const before = { lv: n.dataset.noteLv, attr: n.getAttribute('data-note-lv'), hidden: n.hidden,
              display: getComputedStyle(n).display, style: n.getAttribute('style'), text: n.textContent };
            n.dataset.noteLv = 'ok';                       /* ① 写成"服务端读到 0" => 判据应红 */
            const lvMut = { lv: n.dataset.noteLv, attr: n.getAttribute('data-note-lv') };
            n.dataset.noteLv = before.lv;                  /* 逐字还原（同一同步任务内，渲染循环插不进来） */
            n.hidden = true; n.style.display = 'none';     /* ② 藏起来 => 判据应红 */
            const hidMut = { hidden: n.hidden, display: getComputedStyle(n).display };
            n.hidden = before.hidden;
            if (before.style === null) n.removeAttribute('style'); else n.setAttribute('style', before.style);
            return { before, lvMut, hidMut,
              restored: { lv: n.dataset.noteLv, attr: n.getAttribute('data-note-lv'), hidden: n.hidden,
                display: getComputedStyle(n).display, text: n.textContent } };
          })()`);
          d22 = { base: SVERD.noteVisibleErr(errBase, errFi.withoutIndex, errFi.mixedTickets),
            lv: SVERD.noteVisibleErr(lvMut, errFi.withoutIndex, errFi.mixedTickets),
            hidden: SVERD.noteVisibleErr(hiddenMut, errFi.withoutIndex, errFi.mixedTickets), domMut,
            /* `E64` 第三支：把**读数副本**的 DOM 文本里的混帧后缀**逐字删掉**
               （＝"只读 withoutIndex"的旧形态在真机上的读数）⇒ 同一判据必红并指名该后缀。 */
            noMixedSuffix: SVERD.noteVisibleErr(
              Object.assign({}, errBase, { noteText: String(errBase.noteText).replace(/；其中 [^）]*）/, '') }),
              errFi.withoutIndex, errFi.mixedTickets) };
        }
        check('B5e-D22 可证伪（ADR-0004 D22）：①把**读数副本**的 `dataset.noteLv` 改成 `ok`（＝"两种没有混同"）' +
          '②把**读数副本**改成"隐藏"（＝"提示行没显示"的错实现）' +
          '③把**读数副本**文本里的 `E64` 混帧后缀**逐字删掉**（＝"只读 `withoutIndex`"的旧形态）' +
          '⇒ **同一条 `noteVisibleErr` 判据必红**并在 `why` 里分别指名 `noteLv`／`hidden`／该后缀；' +
          '④真机 DOM 上把前两处临时改掉再**逐字还原并回读核实**' +
          '（证明读的是活 DOM，且本段对盘上文件零写入）',
          Boolean(d22) && d22.base.ok === true &&
          d22.lv.ok === false && d22.lv.why.indexOf('noteLv') >= 0 &&
          d22.hidden.ok === false && d22.hidden.why.indexOf('hidden') >= 0 &&
          d22.noMixedSuffix.ok === false && d22.noMixedSuffix.why.indexOf('同票混帧') >= 0 &&
          Boolean(d22.domMut) && d22.domMut.fatal === undefined &&
          d22.domMut.lvMut.lv === 'ok' && d22.domMut.hidMut.hidden === true &&
          d22.domMut.hidMut.display === 'none' &&
          d22.domMut.restored.lv === d22.domMut.before.lv &&
          d22.domMut.restored.attr === d22.domMut.before.attr &&
          d22.domMut.restored.hidden === d22.domMut.before.hidden &&
          d22.domMut.restored.display === d22.domMut.before.display &&
          d22.domMut.restored.text === d22.domMut.before.text,
          '基线读数判绿=' + Boolean(d22 && d22.base.ok) + '（' + (d22 ? d22.base.why : '（未跑）') + '）；' +
          '变异①`noteLv` → `ok` 判红=' + Boolean(d22 && d22.lv.ok === false) + '、指名=' +
          JSON.stringify(String(d22 ? d22.lv.why : '').slice(0, 150)) + '；' +
          '变异②隐藏判红=' + Boolean(d22 && d22.hidden.ok === false) + '、指名=' +
          JSON.stringify(String(d22 ? d22.hidden.why : '').slice(0, 150)) + '；' +
          '变异③删混帧后缀判红=' + Boolean(d22 && d22.noMixedSuffix.ok === false) + '、指名=' +
          JSON.stringify(String(d22 ? d22.noMixedSuffix.why : '').slice(0, 150)) + '；' +
          '真机 DOM 变异并还原=' + JSON.stringify(d22 && d22.domMut) + '（`restored` 四项须与 `before` 逐字相等）');

        /* ---- `E64`：真机混帧档（`mixedTickets > 0`）⇒ 追加句的**逐字**判据 ----
           夹具 `err` 档灌的是 `[7, null]`（同一票一帧带件序号 ＋ 一帧不带）⇒ `/health.frameUnitIndex`
           的 `mixedTickets` 应恰 1。本条把"追加句是否真的出现在真机文本里"钉住，且期望后缀由
           **服务端真值现拼**（`withoutIndex`／`mixedTickets` 都取自 `/health`，不手抄）。 */
        if (errBase) {
          const e64Mixed = (typeof errFi.mixedTickets === 'number' && errFi.mixedTickets > 0) ? errFi.mixedTickets : 0;
          const e64Suffix = '；其中 ' + e64Mixed + ' 票为同票混帧（件数按带件序号的帧计 ⇒ 已完成只是下界）';
          check('B5e `E64` 真机混帧档（1920×1080）：夹具把**同一票**灌成"一帧带件序号 ＋ 一帧不带"' +
            '⇒ `/health.frameUnitIndex.mixedTickets` 恰 **1**；真机 `#c114FrameUnitNote` 的 DOM 文本' +
            '**逐字以**该后缀结尾（后缀由服务端两个真值现拼：`withoutIndex` ＋ `mixedTickets`），' +
            '而 `data-note-lv` 仍是 `err`（追加的只是说明，不换档）',
            e64Mixed === 1 && errFi.withIndex > 0 && errFi.withoutIndex > 0 &&
            String(errBase.noteText).endsWith(e64Suffix) &&
            String(errBase.noteText).indexOf('；其中 ') >= 0 &&
            errBase.noteLv === 'err' && errBase.noteHiddenAttr === false,
            `mixedTickets=${JSON.stringify(errFi.mixedTickets)}（应 1）、withIndex=${JSON.stringify(errFi.withIndex)}、` +
            `withoutIndex=${JSON.stringify(errFi.withoutIndex)}；真机 DOM 文本=${JSON.stringify(errBase.noteText)}；` +
            `期望后缀=${JSON.stringify(e64Suffix)}（` +
            `${String(errBase.noteText).endsWith(e64Suffix) ? '逐字命中' : '**未命中**'}）；` +
            `dataset.noteLv=${JSON.stringify(errBase.noteLv)}`);
        }

        /* ---- `ok` 档（`withoutIndex === 0`）：提示行不可见，但 `data-note-lv` 必须是 `ok` ---- */
        const okM = await readServerCellAt(okSvc.base, 1920, 1080);
        if (!okM || okM.fatal || okM.startedText === null) {
          check('B5e 1920×1080 服务端 `ok` 档（`withoutIndex === 0`）可在真机量测',
            false, (okM && okM.fatal) || 'evaluate 未返回结果');
        } else {
          okM.brief = briefOf(okM);
          const nh = SVERD.noteHiddenOk(okM);
          check('B5e 1920×1080 服务端 `ok` 档（`withoutIndex === 0`）：提示行**不可见、文本为空**，' +
            '但 `data-note-lv` **必须是 `ok`** —— 与演示档的 `demo` 在**真机**上分得开' +
            '（两种"没有"不得混同；判据与 B5d 的演示档 `demo` 同源、同一把尺子）',
            okM.serverMode === true && nh.ok, nh.why);
          const pf2 = SVERD.prodFacts(okM, okStarted);
          check('B5e 1920×1080 服务端 `ok` 档的生产口径（真机）：不标「（演示派生）」＋ `#sStarted` ＝ ' +
            '服务端 `startedQty`', pf2.ok, pf2.why);
        }
      }
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }

  /* ===== B5f P1-1b 按端点链路状态（FR-2.6）真机判据 =====
     立案：`FR-2.6` 要求「联网状态」按**端点**显示，且**单点掉线不得报成整套离线**；
     假 DOM 面（`ui-check` 的 P1-1b 五条）已覆盖渲染与取数归一，本段只补**真机**证据：
       ① 起真服务端 ⇒ 先灌 `EP-OFF` 一帧、**真等 > staleMs**、再灌 `EP-ON` 一帧
          （端点链路按**服务端接受时刻**计时，故必须真等，不能靠 collectTime 伪造成旧帧）；
       ② `GET /ifd/endpoints` 自证前提：恰 1 在线 / 1 离线、`allOffline === false`；
       ③ `?source=server` 真机读 `#stLinkText` 与 `#stLinkNote .link-ep`：
          断的行 `data-online="false"` ＋「离线断连」、连的行 `data-online="true"` ＋「在线正常」，
          汇总含 `1/2` 且**不出现**「整套离线」/「上位机断连」；
       ④ 再真等到**所有端点都过期** ⇒ `allOffline === true` ⇒ 汇总显示「整套离线」。
     ⚠ 依赖能起 Node 子进程与真浏览器；起不来 ⇒ **显式跳过（跳过 ≠ 通过）**。 */
  section('B5f P1-1b 按端点链路真机判据（`?source=server` ⇒ 逐端点行；单点掉线 ≠ 整套离线）');
  {
    const sampleFrame = (() => {
      const sb = { console };
      sb.window = sb;
      vm.createContext(sb);
      const rel = path.join('src', 'config', 'fieldMap.js');
      vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sb, { filename: path.join(ROOT, rel) });
      return Object.assign({}, sb.window.FieldMap.samplePayload);
    })();
    const pad2 = n => String(n).padStart(2, '0');
    const stampOf = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());

    /** 真机读设备状态页「联网状态」块（只读数、不改 DOM） */
    const readLinkPanel = () => evaluate(`(() => {
      const note = document.getElementById('stLinkNote');
      const rows = note ? [...note.querySelectorAll('.link-ep')].map(el => ({
        ep: el.getAttribute('data-ep'),
        online: el.getAttribute('data-online'),
        text: String(el.textContent || '')
      })) : [];
      const st = (window.MockData && window.MockData.state) || {};
      const el = st.endpointLink || null;
      return {
        fatal: note ? undefined : '未找到 #stLinkNote',
        serverMode: st.serverMode === true,
        summary: String((document.getElementById('stLinkText') || {}).textContent || ''),
        noteText: note ? String(note.textContent || '') : '',
        rows: rows,
        banner: !!document.querySelector('.degraded-banner'),
        endpointLink: el ? {
          staleMs: el.staleMs, total: el.total, onlineCount: el.onlineCount,
          offlineCount: el.offlineCount, allOffline: el.allOffline,
          endpoints: (el.endpoints || []).map(e => ({ id: e.endpointId, online: e.online, ageMs: e.ageMs }))
        } : null
      };
    })()`);

    /** 轮询真机读数直到满足 `pred`（返回最后一次读数；超时也返回，供断言报实测值） */
    async function waitLinkPanel(pred, timeoutMs) {
      const end = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < end) {
        last = await readLinkPanel();
        if (last && pred(last)) return last;
        await sleep(250);
      }
      return last;
    }

    let svc = null;
    let infra = null;
    try {
      const harnessLib = require('./lib/harness');
      svc = await harnessLib.startService({
        script: 'server/index.js', args: ['--data-dir', harnessLib.makeTempDir('b5f-data')],
        readyPath: '/health', timeoutMs: 30000
      });
    } catch (e) { infra = e; }

    if (infra) {
      skip('B5f P1-1b 按端点链路真机判据', '本地服务端起不来 ⇒ 本用例环境不满足（**跳过 ≠ 通过**）：' + infra.message);
    } else {
      try {
        const base = 'http://127.0.0.1:' + svc.port;
        const postFrame = async endpointId => {
          const f = Object.assign({}, sampleFrame, { endpointId: endpointId, collectTime: stampOf(new Date()) });
          const r = await fetch(base + '/ifd/frame', {
            method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8' }, body: JSON.stringify(f)
          });
          return { status: r.status, body: await r.json() };
        };
        const endpointsOf = async () => (await (await fetch(base + '/ifd/endpoints')).json());

        const offPost = await postFrame('EP-OFF');
        /* 端点链路按**服务端接受时刻**算 age ⇒ 必须真等 > staleMs（5000 ms），不能拿 collectTime 伪造 */
        await sleep(5600);
        const onPost = await postFrame('EP-ON');
        const pre = await endpointsOf();
        check('B5f 前提：真服务端两端口各收 1 帧（EP-OFF 先、EP-ON 后，**真等 > staleMs**）⇒ ' +
          '`GET /ifd/endpoints` 为 `onlineCount=1 / offlineCount=1 / allOffline=false`（**单点掉线 ≠ 整套离线**）',
          offPost.status === 200 && onPost.status === 200 && pre.ok === true &&
          pre.total === 2 && pre.onlineCount === 1 && pre.offlineCount === 1 && pre.allOffline === false &&
          pre.endpoints.length === 2 &&
          pre.endpoints.some(e => e.endpointId === 'EP-OFF' && e.online === false) &&
          pre.endpoints.some(e => e.endpointId === 'EP-ON' && e.online === true),
          `灌帧：EP-OFF ${offPost.status}/${offPost.body && offPost.body.outcome}、EP-ON ` +
          `${onPost.status}/${onPost.body && onPost.body.outcome}；/ifd/endpoints=` +
          JSON.stringify({ total: pre.total, onlineCount: pre.onlineCount, offlineCount: pre.offlineCount,
            allOffline: pre.allOffline, endpoints: pre.endpoints }));

        await setViewport(1920, 1080);
        await openUrl(base + '/?source=server', 1200);
        const pm = await waitLinkPanel(m => m && m.rows.length === 2 && /1\/2/.test(m.summary), 15000);
        const pOff = pm && pm.rows.find(r => r.ep === 'EP-OFF');
        const pOn = pm && pm.rows.find(r => r.ep === 'EP-ON');
        const pAllText = pm ? pm.summary + ' ' + pm.noteText : '';
        check('B5f P1-1b **单点掉线**真机判据（1920×1080、`?source=server`）：逐端点行中「EP-OFF」' +
          '`data-online="false"` ＋「离线断连」、「EP-ON」`data-online="true"` ＋「在线正常」；' +
          '汇总含 `1/2` 且**不出现**「整套离线」/「上位机断连」、链路降级横幅不出现',
          pm !== null && pm.serverMode === true && pm.rows.length === 2 &&
          pOff && pOff.online === 'false' && /离线|断连/.test(pOff.text) &&
          pOn && pOn.online === 'true' && /在线正常/.test(pOn.text) &&
          /1\/2/.test(pm.summary) &&
          !/整套离线/.test(pAllText) && !/上位机断连/.test(pAllText) && pm.banner === false,
          pm === null ? '（未读到 #stLinkNote）' :
            'serverMode=' + pm.serverMode + '；summary=' + JSON.stringify(pm.summary) +
            '；rows=' + JSON.stringify(pm.rows) +
            '；横幅=' + pm.banner + '；state.endpointLink=' + JSON.stringify(pm.endpointLink));

        /* 等到**所有端点**都过期：轮询服务端 `/ifd/endpoints` 直到 `allOffline === true` */
        let preAll = null;
        const allDeadline = Date.now() + 15000;
        while (Date.now() < allDeadline) {
          preAll = await endpointsOf();
          if (preAll && preAll.allOffline === true) break;
          await sleep(500);
        }
        const am = await waitLinkPanel(m => m && m.endpointLink && m.endpointLink.allOffline === true &&
          /整套离线/.test(m.summary), 15000);
        check('B5f P1-1b `allOffline=true` 真机判据：服务端所有端点都过期后再读页面 ⇒ 汇总**显示「整套离线」**' +
          '（`0/2`），且逐端点行仍逐个 `data-online="false"`（不以汇总代替明细）',
          preAll && preAll.allOffline === true && preAll.onlineCount === 0 &&
          am !== null && am.endpointLink && am.endpointLink.allOffline === true &&
          /整套离线/.test(am.summary) && /0\/2/.test(am.summary) &&
          am.rows.length === 2 && am.rows.every(r => r.online === 'false'),
          '服务端 /ifd/endpoints=' + JSON.stringify(preAll && {
            total: preAll.total, onlineCount: preAll.onlineCount, allOffline: preAll.allOffline,
            endpoints: preAll.endpoints }) +
          '；页面 summary=' + JSON.stringify(am && am.summary) +
          '；rows=' + JSON.stringify(am && am.rows) +
          '；state.endpointLink=' + JSON.stringify(am && am.endpointLink));
      } catch (e) {
        check('B5f P1-1b 按端点链路真机判据（本段自身执行）', false, '夹具/真机读数异常：' + e.message);
      } finally {
        if (svc) await svc.stop();
        await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      }
    }
  }

  /* ===== B8／B9 `E2` 真模态报警弹窗（`FR-5.5` 高亮弹窗预警 ／ `FR-5.7` 停留·自动收起·手动确认可配）=====
     座位 4b 的 `T-20261007-24`：假 DOM 面（`ui-check` 的 U12 段：四路径读数 ＋ 7 组 D22）已覆盖**行为**；
     本段只补两件**只能在真机上看**的事 —— 它们正是"基准图与 4K 交付图要不要重拍"的机器证据：
       B8 **抓图口径钉住**：抓图口径（`tests\capture-baseline.js` 的 SHIM：固定时钟 ＋ 种子随机 ＋
          **冻结定时器**）下，10 个入口（`?tab=` 全套 ＋ `?curve=none` ＋ `?link=off`）在**两种分辨率**下
          `#alPopup` 都必须满足：`getComputedStyle().display === 'none'` ∧ `getBoundingClientRect()` 为
          **0×0** ∧ `data-popup-state === 'hidden'`。⇒ 弹窗**必然不进图** ⇒ 10 张基准图与 10 张 4K
          交付图都**不需要重拍**（不是"看起来没出现"，是三条可量测的读数同时成立）。
       B9 **真机"不阻塞"**（`FR-5.5` 的后半句）：绕开首帧口径把弹窗**真的弹出来**，然后量
          `#alPopup` 的 computed `pointer-events === 'none'` ∧ `#alPopupConfirm` 为 `auto` ∧
          弹窗 rect 与 `#board-header` rect **不相交** ∧ 弹窗**空白处**的 `elementFromPoint` **不是**
          `#alPopup`（＝点击穿过弹窗落到下层）。没有这一条，"不阻塞"就只是注释里的声明。
     ⚠ `B8` 的 SHIM 只在本段插入、**段末立刻摘掉**（B6 的虚拟时间快进与 B7 的 `cliScreenshot`
        不能被冻结定时器影响）；B9 另插一支"`setTimeout` 空转"的 SHIM（模拟退化成 8000 ms 的实际形态），
        段末一并摘掉。 */
  section('B8 `E2` 弹窗的**抓图口径**真机读数（基准图与 4K 交付图是否需重拍＝机器证据）');
  {
    /* 抓图口径的 SHIM —— **逐字照抄** `tests\capture-baseline.js` 的 SHIM */
    const CAPTURE_SHIM = [
      '(() => {',
      "  const FIXED = Date.parse('2026-09-18T10:00:00');",
      '  const RealDate = Date;',
      '  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(FIXED); }',
      '  FakeDate.prototype = RealDate.prototype;',
      '  FakeDate.now = () => FIXED;',
      '  FakeDate.parse = RealDate.parse;',
      '  FakeDate.UTC = RealDate.UTC;',
      '  window.Date = FakeDate;',
      '  let seed = 20260919;',
      '  Math.random = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };',
      '  window.setInterval = function () { return 0; };',
      '  window.setTimeout = function () { return 0; };',
      '})();'
    ].join('\n');
    /* 10 个入口 —— **逐字照抄** `tests\capture-baseline.js` 的 SHOTS（顺序也一致） */
    const CAPTURE_SHOTS = [
      ['01-设备状态-任务曲线', ''],
      ['02-任务数据', '?tab=1'],
      ['03-班次信息', '?tab=2'],
      ['04-生产统计', '?tab=3'],
      ['05-设备异常', '?tab=4'],
      ['06-维保台账', '?tab=5'],
      ['07-公告备注', '?tab=6'],
      ['08-操作设置', '?tab=7'],
      ['09-曲线初始空态', '?curve=none'],
      ['10-上位机断连降级', '?link=off']
    ];
    const readCapturePopup = () => evaluate(`(() => {
      const el = document.getElementById('alPopup');
      if (!el) return { exists: false, fatal: '未找到 #alPopup 挂点（组件未创建）' };
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      const ds = el.dataset || {};
      const alarm = (() => {
        try {
          const a = window.MockData.state.alarm;
          return { queueLen: (a.queue || []).length, ledgerLen: (a.ledger || []).length };
        } catch (e) { return { error: String((e && e.message) || e) }; }
      })();
      return {
        exists: true, hidden: el.hidden === true, display: cs.display, visibility: cs.visibility,
        pointerEvents: cs.pointerEvents,
        rect: { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) },
        state: (ds.popupState === undefined) ? null : ds.popupState,
        stateAttr: el.getAttribute('data-popup-state'),
        queueLen: (ds.popupQueueLen === undefined) ? null : ds.popupQueueLen,
        dismiss: (ds.popupDismiss === undefined) ? null : ds.popupDismiss,
        className: String(el.className || ''),
        alarm: alarm
      };
    })()`);
    /* 判据抽成**纯函数**，供断言与 D22 的"内存读数副本"共用同一把尺子 */
    const captureVerdict = m => {
      const bad = [];
      if (!m || !m.exists) return { ok: false, why: '（读不到 #alPopup）' + JSON.stringify(m) };
      if (m.display !== 'none') bad.push('display=' + JSON.stringify(m.display) + '（应 "none"）');
      if (!(m.rect.w === 0 && m.rect.h === 0)) bad.push('rect=' + m.rect.w + '×' + m.rect.h + '（应 0×0）');
      if (m.state !== 'hidden') bad.push('data-popup-state=' + JSON.stringify(m.state) + '（应 "hidden"）');
      return { ok: bad.length === 0, why: bad.join('；') };
    };

    const scriptId = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SHIM })).identifier;
    const rows = [];
    for (const size of [[3840, 2160], [1920, 1080]]) {
      await setViewport(size[0], size[1]);
      for (const [name, q] of CAPTURE_SHOTS) {
        await openPage(q, 900);
        const m = await readCapturePopup();
        rows.push({ size: size.join('×'), name: name, q: q, m: m, v: captureVerdict(m) });
      }
    }
    const bad = rows.filter(r => !r.v.ok);
    check('B8 抓图口径（固定时钟＋种子随机＋**冻结定时器**）× 2 分辨率 × 10 入口 = ' + rows.length +
      ' 次真机读取：每一次都满足 `display==="none"` ∧ `rect 0×0` ∧ `data-popup-state==="hidden"` ' +
      '⇒ 弹窗**必然不进图**（基准图与 4K 交付图都不需重拍）',
      rows.length === 20 && bad.length === 0,
      '不合格读数=' + bad.length + ' 次' + (bad.length ? '：' +
        bad.slice(0, 4).map(r => `${r.size} ${r.name}: ${r.v.why}`).join(' ｜ ') : '') +
      '；抽样（4K 首张）：display=' + JSON.stringify((rows[0] || {}).m ? rows[0].m.display : null) +
      '、rect=' + JSON.stringify((rows[0] || {}).m ? rows[0].m.rect : null) +
      '、state=' + JSON.stringify((rows[0] || {}).m ? rows[0].m.state : null) +
      '、hidden=' + JSON.stringify((rows[0] || {}).m ? rows[0].m.hidden : null) +
      '、报警队列条数=' + JSON.stringify((rows[0] || {}).m && rows[0].m.alarm ? rows[0].m.alarm.queueLen : null) +
      '（> 0 ⇒ 本判据不是"恰好没有报警"的假绿）');

    /* D22（**内存读数副本**，不改盘上任何文件）：把某一次真机读数的 `data-popup-state` 改成 `'shown'`
       （＝"弹窗其实显示了"的错实现）⇒ 同一条 `captureVerdict` **必红并指名** `data-popup-state`；
       未变异副本必绿。随后不做任何"还原"动作 —— 变异只发生在 Node 侧的对象副本上，页面与盘上都没变。 */
    const base0 = rows[0] ? rows[0].m : null;
    const baseV = base0 ? captureVerdict(base0) : { ok: false, why: '（无基线读数）' };
    const mutated = base0 ? Object.assign({}, base0, { state: 'shown' }) : null;
    const mutV = mutated ? captureVerdict(mutated) : { ok: false, why: '（无变异副本）' };
    check('B8-D22 可证伪（ADR-0004 D22）：把**真机读数副本**的 `data-popup-state` 改成 `\'shown\'` ' +
      '（＝"抓图口径下弹窗其实弹出来了"）⇒ 同一条 `captureVerdict` **必红并指名** `data-popup-state`；' +
      '未变异副本必绿（变异只发生在内存副本上，页面与盘上都不动）',
      baseV.ok === true && mutV.ok === false && String(mutV.why).indexOf('data-popup-state') >= 0,
      '未变异副本判绿=' + baseV.ok + '；改成 `shown` 后判红=' + (mutV.ok === false) +
      '、红时指名=' + JSON.stringify(mutV.why));

    /* 摘掉抓图口径的 SHIM：后面的 B6（虚拟时间快进）／B7（`cliScreenshot`）不能被冻结定时器影响 */
    try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }); }
    catch (e) { check('B8 抓图口径 SHIM 已摘除（否则会污染 B6／B7）', false, String(e && e.message || e)); }
  }

  section('B9 `E2` 弹窗的**真机"不阻塞"**判据（`FR-5.5` 后半句：不阻塞头部与关键状态显示）');
  {
    /* 只让 `setTimeout` 空转（`#alPopupConfirm` 的停留计时**不自动收起**，弹窗留在屏上可供量测）；
       `setInterval` 保持真身 ⇒ 页面按真实节拍渲染（`ui-check` 的假 DOM 面已覆盖计时行为，
       本段要的是"弹窗真的在屏上时的几何与命中"）。 */
    const NO_DWELL_SHIM = [
      '(() => { window.setTimeout = function () { return 0; }; })();'
    ].join('\n');
    const HIT_EXPR = `(() => {
      const M = window.MockData;
      const injected = M.injectAlarm(new Date());
      window.Pages.Dashboard.renderAll(M.state);
      const root = document.getElementById('alPopup');
      const btn = document.getElementById('alPopupConfirm');
      const code = document.getElementById('alPopupCode');
      const header = document.getElementById('board-header');
      if (!root || !btn || !code || !header) {
        return { fatal: '缺节点：' + JSON.stringify({ root: !!root, btn: !!btn, code: !!code, header: !!header }) };
      }
      const cs = el => { const c = getComputedStyle(el); return { pointerEvents: c.pointerEvents, display: c.display, cursor: c.cursor }; };
      const rc = el => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
      const br = rc(btn), cr = rc(code), hr = rc(header), rr = rc(root);
      const atBtn = document.elementFromPoint(br.x + br.w / 2, br.y + br.h / 2);
      const atBody = document.elementFromPoint(cr.x + Math.min(8, cr.w / 2), cr.y + cr.h / 2);
      const idOf = el => (el ? (el.id || (el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''))) : null);
      const ds = root.dataset || {};
      return {
        injected: injected ? injected.code : null,
        root: Object.assign({ hidden: root.hidden === true, rect: rr, state: (ds.popupState === undefined) ? null : ds.popupState }, cs(root)),
        btn: Object.assign({ id: btn.id, text: String(btn.textContent || ''), rect: br }, cs(btn)),
        code: Object.assign({ rect: cr }, cs(code)),
        header: rc(header),
        hitAtButtonCenter: idOf(atBtn),
        hitAtPopupBlank: idOf(atBody)
      };
    })()`;
    /* 判据抽成纯函数（断言与 D22 的内存副本共用） */
    const hitVerdict = {
      passThrough: (m, label) => {
        const bad = [];
        if (m.hitAtPopupBlank === 'alPopup') bad.push('弹窗空白处的 elementFromPoint 命中 #alPopup（应**穿过**它）');
        if (m.hitAtPopupBlank === null) bad.push('弹窗空白处的 elementFromPoint 为 null（取不到下层元素）');
        return { ok: bad.length === 0, why: label + ' 命中=' + JSON.stringify(m.hitAtPopupBlank) + '：' + bad.join('；') };
      },
      btnReachable: m => {
        const bad = [];
        if (m.hitAtButtonCenter !== 'alPopupConfirm') {
          bad.push('#alPopupConfirm 中心点命中=' + JSON.stringify(m.hitAtButtonCenter) + '（应 "alPopupConfirm"）');
        }
        return { ok: bad.length === 0, why: bad.join('；') };
      },
      rootNone: m => (m.root.pointerEvents === 'none'
        ? { ok: true, why: 'computed pointer-events=' + JSON.stringify(m.root.pointerEvents) }
        : { ok: false, why: 'computed pointer-events=' + JSON.stringify(m.root.pointerEvents) + '（应 "none"）' }),
      btnAuto: m => (m.btn.pointerEvents === 'auto'
        ? { ok: true, why: 'computed pointer-events=' + JSON.stringify(m.btn.pointerEvents) }
        : { ok: false, why: 'computed pointer-events=' + JSON.stringify(m.btn.pointerEvents) + '（应 "auto"）' }),
      headerClear: m => {
        const a = m.root.rect, b = m.header;
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        return { ok: !(ix > 0 && iy > 0),
          why: '相交面积=' + (ix * iy).toFixed(1) + ' px²（相交宽 ' + ix.toFixed(1) + ' × 高 ' + iy.toFixed(1) +
            '）；弹窗 rect=' + a.w + '×' + a.h + '@(' + a.x + ',' + a.y + ')、#board-header rect=' +
            b.w + '×' + b.h + '@(' + b.x + ',' + b.y + ')' };
      }
    };

    const scriptId = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_DWELL_SHIM })).identifier;
    const hitRows = [];
    for (const size of [[1920, 1080], [3840, 2160]]) {
      await setViewport(size[0], size[1]);
      await openPage('', 1500);
      const m = await evaluate(HIT_EXPR);
      if (!m || m.fatal) {
        check('B9 ' + size.join('×') + ' 弹窗可在真机上量测（绕开首帧口径弹出后 #alPopup／#alPopupConfirm／' +
          '#alPopupCode／#board-header 齐备）', false, (m && m.fatal) || 'evaluate 未返回结果');
        continue;
      }
      hitRows.push({ size: size.join('×'), m: m });
      const brief = `${size.join('×')}：弹窗 state=${JSON.stringify(m.root.state)} hidden=${m.root.hidden} ` +
        `display=${m.root.display} rect=${JSON.stringify(m.root.rect)}；注入=${JSON.stringify(m.injected)}；` +
        `按钮 pointer-events=${JSON.stringify(m.btn.pointerEvents)} rect=${JSON.stringify(m.btn.rect)}`;
      check(`B9 ${size.join('×')} 前提：绕开首帧口径（` + '`injectAlarm()` ＋ 重绘一帧' +
        '）后弹窗**真的显示中**（`data-popup-state === \'shown\'` ∧ `hidden === false`）—— ' +
        '否则下面的"不阻塞"读数是在一个没显示的节点上量的，等于没量',
        m.root.state === 'shown' && m.root.hidden === false,
        brief);
      check(`B9 ${size.join('×')} 真机"不阻塞"①：` + '`getComputedStyle(#alPopup).pointerEvents === \'none\'` ' +
        '∧ `getComputedStyle(#alPopupConfirm).pointerEvents === \'auto\'`（根不吃事件、只有确认按钮可点）' +
        ' ∧ `#alPopup` 与 `#board-header` 的 rect **不相交**',
        hitVerdict.rootNone(m).ok && hitVerdict.btnAuto(m).ok && hitVerdict.headerClear(m).ok,
        'root：' + hitVerdict.rootNone(m).why + '；按钮：' + hitVerdict.btnAuto(m).why +
        '；' + hitVerdict.headerClear(m).why + '；' + brief);
      check(`B9 ${size.join('×')} 真机"不阻塞"②：弹窗**空白处**（报警代码上）的 ` +
        '`document.elementFromPoint()` **不是** `#alPopup`（点击**穿过**弹窗落到下层），' +
        '而确认按钮**中心**必须命中 `#alPopupConfirm`（按钮真的可点）',
        hitVerdict.passThrough(m, size.join('×')).ok && hitVerdict.btnReachable(m).ok,
        hitVerdict.passThrough(m, size.join('×')).why + '；' + hitVerdict.btnReachable(m).why +
        '；按钮文案=' + JSON.stringify(m.btn.text) + '；' + brief);
    }

    /* D22（**内存读数副本**）：①把"空白处命中"改成 `'alPopup'`（＝弹窗把页面挡住了）⇒ 必红并指名；
       ②把根节点的 `pointerEvents` 改成 `'auto'` ⇒ 必红并指名。页面与盘上都不动。 */
    const hb = hitRows[0] ? hitRows[0].m : null;
    const mutPass = hb ? Object.assign({}, hb, { hitAtPopupBlank: 'alPopup' }) : null;
    const mutPe = hb ? Object.assign({}, hb, { root: Object.assign({}, hb.root, { pointerEvents: 'auto' }) }) : null;
    const pv = mutPass ? hitVerdict.passThrough(mutPass, '变异') : { ok: false, why: '（无副本）' };
    const ev = mutPe ? hitVerdict.rootNone(mutPe) : { ok: false, why: '（无副本）' };
    check('B9-D22 可证伪（ADR-0004 D22）：把**真机读数副本**的"空白处命中"改成 `\'alPopup\'` ⇒ ' +
      '`passThrough` **必红并指名**；把根节点的 `pointerEvents` 改成 `\'auto\'` ⇒ `rootNone` **必红并指名**；' +
      '未变异副本两项都绿（变异只发生在内存副本上）',
      hb !== null && hitVerdict.passThrough(hb, '真机').ok && hitVerdict.rootNone(hb).ok &&
      pv.ok === false && String(pv.why).indexOf('alPopup') >= 0 &&
      ev.ok === false && String(ev.why).indexOf('pointer-events') >= 0,
      '未变异：空白处=' + JSON.stringify(hb ? hb.hitAtPopupBlank : null) +
      '、root pointer-events=' + JSON.stringify(hb ? hb.root.pointerEvents : null) +
      '（两项都绿=' + Boolean(hb && hitVerdict.passThrough(hb, '真机').ok && hitVerdict.rootNone(hb).ok) + '）' +
      '；变异①判红=' + (pv.ok === false) + '、指名=' + JSON.stringify(pv.why) +
      '；变异②判红=' + (ev.ok === false) + '、指名=' + JSON.stringify(ev.why));

    try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }); }
    catch (e) { check('B9 SHIM 已摘除（否则会污染 B6／B7）', false, String(e && e.message || e)); }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }

  section('B6 无操作 5 分 10 秒自动返回首页（FR-9.4）');
  try {
    await openPage('', 2200);
    await clickTab(5);
    await sleep(300);
    /* FR-9.4（V1.32）：默认 5 分 10 秒 = 310000 ms。budget 必须**严格大于**该阈值，
       否则快进结束仍停在当前页，用例会假失败（原为 200000/3 分钟，阈值升到 310 s 后必然失败）。 */
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 320000 });
    await sleep(1500);
    const after = await evaluate(`(() => {
      const act = document.querySelector('.tab-panel.active');
      return act ? act.id : null;
    })()`);
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' }).catch(() => {});
    check('快进 320 秒后自动回到「设备状态」首页', after === 'panel-status', `当前激活面板=${after}`);
  } catch (e) {
    skip('无操作 5 分 10 秒自动返回首页', '虚拟时间快进不可用：' + e.message);
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
