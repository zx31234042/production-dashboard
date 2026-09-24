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

  /* ===== B6 无操作自动回首页（虚拟时间快进） ===== */
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
