/* ==========================================================================
   界面基准图确定性捕获（tests/capture-baseline.js）
   作用：用无头 Edge + CDP 把 8 个标签页 + 2 个特殊状态（共 10 张）按固定口径截图，
         并注入"确定化"脚本让每次捕获的画面逐像素一致，使 tests/screenshot-diff.js
         的 5% 阈值真正严格（否则时钟/随机游走/曲线会让动态区域吃掉容差）。
   确定化手段（页面加载前注入，见 SHIM）：
         ① 固定时间：Date 固定为 2026-09-18T10:00:00（时钟、班次、统计落在同一取值）
         ② 固定随机：用种子化 LCG 替换 Math.random（模拟数据与曲线可复现）
         ③ 冻结定时器：setInterval/setTimeout 置空，只保留启动时的第一次渲染
   运行：
         node tests/capture-baseline.js                       # 拍到 tests/._verify/captures
         node tests/capture-baseline.js --out <目录>
         node tests/capture-baseline.js --update              # 同时覆盖 tests/screenshots-baseline（人工确认后使用）
         node tests/capture-baseline.js --size 3840x2160      # 默认 1920x1080
   权限：Chromium 需创建命名管道，受限沙箱下会以 mojo platform_channel 拒绝访问；
         请与 tests/browser-check.js 同样在可创建命名管道的权限下运行。
   退出码：0 = 10 张全部捕获成功；1 = 有失败；2 = 脚本自身异常。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const env = require('./env');
env.assertRuntime();

const ROOT = path.resolve(__dirname, '..');
const PAGE = pathToFileURL(path.join(ROOT, 'index.html')).href;
const BASELINE = path.join(ROOT, 'tests', 'screenshots-baseline');
const PORT = Number(process.env.DSH_CAPTURE_PORT || 18940);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const OUT = path.resolve(ROOT, String(arg('out', path.join('tests', '._verify', 'captures'))));
const UPDATE = arg('update', false) === true;
const SIZE = String(arg('size', '1920x1080')).split('x').map(Number);

const EDGE_CANDIDATES = [
  process.env.MSEDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

/* 10 张基准：命名与 src\assets\screenshots 一致 */
const SHOTS = [
  ['01-设备状态-任务曲线.png', ''],
  ['02-任务数据.png', '?tab=1'],
  ['03-班次信息.png', '?tab=2'],
  ['04-生产统计.png', '?tab=3'],
  ['05-设备异常.png', '?tab=4'],
  ['06-维保台账.png', '?tab=5'],
  ['07-公告备注.png', '?tab=6'],
  ['08-操作设置.png', '?tab=7'],
  ['09-曲线初始空态.png', '?curve=none'],
  ['10-上位机断连降级.png', '?link=off']
];

/* 确定化脚本：固定时间 + 固定随机 + 冻结定时器 */
const SHIM = `(() => {
  const FIXED = Date.parse('2026-09-18T10:00:00');
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(FIXED); }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => FIXED;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;
  let seed = 20260919;
  Math.random = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  window.setInterval = function () { return 0; };
  window.setTimeout = function () { return 0; };
})();`;

let edge = null;
let cdp = null;

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); this.closed = false; }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    });
    this.ws.addEventListener('close', () => { this.closed = true; });
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params: params || {} })); } catch (e) { reject(e); }
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* 已关闭 */ } }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
  return r.result.value;
}

async function launch() {
  const exe = EDGE_CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-capture-'));
  edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars',
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
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: SIZE[0], height: SIZE[1], deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM });
  return exe;
}

/** 打开页面并等到"首屏渲染完成"（渲染完成标记：深度数值已写入且非空） */
async function openAndSettle(query) {
  await cdp.send('Page.navigate', { url: PAGE + (query || '') });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ok = await evaluate(`(() => {
      const el = document.getElementById('stDepth');
      return document.readyState === 'complete' && !!el && /^[0-9]+\\.[0-9]{2}$/.test(el.textContent.trim());
    })()`).catch(() => false);
    if (ok) break;
    await sleep(150);
  }
  await sleep(400);   // 留一拍给合成器落盘
}

/** CDP 截图（带超时保护，避免 4K 下偶发挂住） */
async function shoot(file) {
  const r = await Promise.race([
    cdp.send('Page.captureScreenshot', { format: 'png' }),
    sleep(45000).then(() => null)
  ]);
  if (!r) throw new Error('captureScreenshot 超时');
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return fs.statSync(file).size;
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  console.log(`输出目录：${path.relative(ROOT, OUT)}`);
  console.log(`视口：${SIZE[0]}×${SIZE[1]}；确定化：固定时间 + 种子随机 + 冻结定时器`);
  if (UPDATE) console.log(`--update：同时覆盖 ${path.relative(ROOT, BASELINE)}（请先人工看图确认）`);

  const exe = await launch();
  if (!exe) {
    console.log('\nSKIP：未找到 msedge.exe，或沙箱不允许创建命名管道（mojo platform_channel 拒绝访问）');
    process.exit(0);
  }
  console.log(`浏览器：${exe}\n`);

  const results = [];
  for (const [name, query] of SHOTS) {
    try {
      await openAndSettle(query);
      const size = await shoot(path.join(OUT, name));
      let updated = '';
      if (UPDATE) {
        fs.copyFileSync(path.join(OUT, name), path.join(BASELINE, name));
        updated = '  → 已覆盖基准';
      }
      results.push({ name, ok: true, size });
      console.log(`  [PASS] ${name}  ${(size / 1024).toFixed(0)} KB${updated}`);
    } catch (e) {
      results.push({ name, ok: false, error: e.message });
      console.log(`  [FAIL] ${name} —— ${e.message}`);
    }
  }

  const okCount = results.filter(r => r.ok).length;
  console.log(`\n=== 汇总 ===\n捕获成功 ${okCount} / ${SHOTS.length} 张（${path.relative(ROOT, OUT)}）`);
  if (okCount !== SHOTS.length) {
    console.log('失败清单：' + results.filter(r => !r.ok).map(r => `${r.name}(${r.error})`).join('；'));
  }
  console.log('下一步：node tests\\screenshot-diff.js --baseline tests\\screenshots-baseline --candidate ' + path.relative(ROOT, OUT));

  if (cdp) cdp.close();
  if (edge && edge.exitCode === null) { try { edge.kill(); } catch (e) { /* 已退出 */ } }
  process.exit(okCount === SHOTS.length ? 0 : 1);
}

main().catch(err => {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  if (cdp) cdp.close();
  if (edge && edge.exitCode === null) { try { edge.kill(); } catch (e) { /* 已退出 */ } }
  process.exit(2);
});
