/* ==========================================================================
   元素重叠检测（tests/overlap-check.js）
   作用：在 3 种分辨率 × 8 个页面（+2 个特殊状态）下，用真实浏览器取各主要容器的
         视觉矩形（getBoundingClientRect，已含 #stage 的等比缩放），两两做相交检测，
         报出"意外重叠"；用于替代手工目视"没有元素重叠"这一条。
   判定与白名单：
         · 父子/祖先-后代重叠视为正常（布局包含关系），自动跳过
         · 不可见元素（无尺寸）自动跳过
         · 重叠面积占较小元素面积 ≤ --min（默认 5%）视为可忽略
         · 其余按「选择器组合」聚合；命中 tests/overlap-whitelist.json 的 allow 规则则通过
   运行：
         node tests/overlap-check.js                    # 只报候选（未填白名单时退出码 1）
         node tests/overlap-check.js --min 10           # 调整可忽略阈值（百分比）
         node tests/overlap-check.js --shots 3          # 为最严重的 3 类各截一张图
   产物：tests/._verify/overlaps/report.json（明细）、overlaps/*.png（截图）
   权限：需可创建命名管道的权限（与 tests/browser-check.js 相同）。
   退出码：0 = 无未白名单化的重叠；1 = 有候选；2 = 脚本自身异常。
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
const OUT = path.join(ROOT, 'tests', '._verify', 'overlaps');
const WHITELIST = path.join(ROOT, 'tests', 'overlap-whitelist.json');
const PORT = Number(process.env.DSH_OVERLAP_PORT || 18950);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const MIN_PCT = Number(arg('min', 5));
const SHOTS = Number(arg('shots', 3));

const RESOLUTIONS = [[3840, 2160], [1920, 1080], [1366, 768]];
const PAGES = [
  ['设备状态', ''],
  ['任务数据', '?tab=1'],
  ['班次信息', '?tab=2'],
  ['生产统计', '?tab=3'],
  ['设备异常', '?tab=4'],
  ['维保台账', '?tab=5'],
  ['公告备注', '?tab=6'],
  ['操作设置', '?tab=7']
];
const EXTRA = [['曲线空态', '?curve=none'], ['断连降级', '?link=off']];

/* 参与检测的容器/块级元素（不含纯文本行内元素） */
const SELECTORS = [
  '.card', '.tile', '.data-table', '.progress-block', '.kv-list', '.list',
  '.chart-wrap', '.shift-item', '.legend-item', '.alarm-card', '.entry-form',
  '.degraded-banner', '.hero-band', '.hero-stage', '.result-block', '.task-flow',
  '.lock-state', '.pwd-row', '.btn-row', '.entry-grid'
];

const EDGE_CANDIDATES = [
  process.env.MSEDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

let edge = null;
let cdp = null;

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); }
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-overlap-'));
  edge = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1920,1080', 'about:blank'
  ], { stdio: 'ignore' });
  if (!await waitHttp(`http://127.0.0.1:${PORT}/json/version`, 30000)) return null;
  const list = await waitHttp(`http://127.0.0.1:${PORT}/json/list`, 5000);
  const target = (list || []).find(t => t.type === 'page');
  if (!target) return null;
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return exe;
}

/** 页面内收集矩形并求相交；返回候选重叠（已排除父子与不可见元素） */
const DETECT_EXPR = (selectors, minPct) => `(() => {
  const sels = ${JSON.stringify(selectors)};
  const items = [];
  for (const sel of sels) {
    document.querySelectorAll(sel).forEach((el, idx) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 100) return;
      items.push({ sel, idx, el, r });
    });
  }
  const pct = (a, b) => {
    const x = Math.max(0, Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left));
    const y = Math.max(0, Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top));
    const inter = x * y;
    if (inter <= 0) return 0;
    const small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
    return inter / small * 100;
  };
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;   // 父子/包含：正常
      const p = pct(a, b);
      if (p <= ${minPct}) continue;
      out.push({
        a: a.sel + '#' + a.idx, b: b.sel + '#' + b.idx,
        pct: Math.round(p * 10) / 10,
        rectA: [Math.round(a.r.left), Math.round(a.r.top), Math.round(a.r.width), Math.round(a.r.height)],
        rectB: [Math.round(b.r.left), Math.round(b.r.top), Math.round(b.r.width), Math.round(b.r.height)]
      });
    }
  }
  return out;
})()`;

async function openPage(query) {
  await cdp.send('Page.navigate', { url: PAGE + (query || '') });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await evaluate('document.readyState').catch(() => null);
    if (ready === 'complete') break;
    await sleep(150);
  }
  await sleep(900);
}

async function shoot(file) {
  const r = await Promise.race([
    cdp.send('Page.captureScreenshot', { format: 'png' }),
    sleep(30000).then(() => null)
  ]);
  if (!r) return 0;
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return fs.statSync(file).size;
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  let allow = [];
  if (fs.existsSync(WHITELIST)) {
    try { allow = JSON.parse(fs.readFileSync(WHITELIST, 'utf8')).allow || []; } catch (e) { allow = []; }
  }
  const allowKeys = new Set(allow.map(x => [x.a, x.b].sort().join(' × ')));

  console.log(`分辨率：${RESOLUTIONS.map(r => r.join('×')).join(' / ')}`);
  console.log(`页面：${PAGES.length} 个标签页 + ${EXTRA.length} 个特殊状态；可忽略阈值：≤${MIN_PCT}%`);
  console.log(`白名单：${allow.length} 条（${path.relative(ROOT, WHITELIST)}）\n`);

  const exe = await launch();
  if (!exe) {
    /* 整脚本跳过：必须退 3（不是 0），否则 runner 会把"一个断言都没跑"记成 PASS（规范 9.5-5 第 6 条） */
    env.skipSuite('无头 Edge 启动与 CDP 连接', '未找到 msedge.exe，或沙箱不允许创建命名管道');
  }

  const agg = new Map();   // "selA × selB" → { count, worst, cases: [] }
  const details = [];

  for (const [w, h] of RESOLUTIONS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    const pages = w === 1920 ? PAGES.concat(EXTRA) : PAGES;
    for (const [name, query] of pages) {
      await openPage(query);
      const hits = await evaluate(DETECT_EXPR(SELECTORS, MIN_PCT));
      for (const hit of hits) {
        const key = [hit.a.replace(/#\d+$/, ''), hit.b.replace(/#\d+$/, '')].sort().join(' × ');
        if (!agg.has(key)) agg.set(key, { count: 0, worst: 0, cases: [] });
        const rec = agg.get(key);
        rec.count++;
        rec.worst = Math.max(rec.worst, hit.pct);
        rec.cases.push({ page: name, res: `${w}×${h}`, query, a: hit.a, b: hit.b, pct: hit.pct, rectA: hit.rectA, rectB: hit.rectB });
        details.push({ page: name, res: `${w}×${h}`, ...hit });
      }
      process.stdout.write(`  ${w}×${h} ${name}：${hits.length} 处\n`);
    }
  }

  console.log('\n=== 按选择器组合聚合（未白名单化的一律列出）===');
  const rows = [...agg].sort((a, b) => b[1].worst - a[1].worst);
  const unallowed = [];
  for (const [key, rec] of rows) {
    const ok = allowKeys.has(key);
    if (!ok) unallowed.push(key);
    const sample = rec.cases.sort((a, b) => b.pct - a.pct)[0];
    console.log(`  [${ok ? '白名单' : '候选  '}] ${key}  ${rec.count} 处，最大 ${rec.worst}%  （例：${sample.res} ${sample.page} → ${sample.a} vs ${sample.b}）`);
  }

  /* 为最严重的几类各截一张图，便于人工判断"是否合法重叠" */
  const shotPairs = rows.slice(0, SHOTS);
  for (const [key, rec] of shotPairs) {
    const c = rec.cases.sort((a, b) => b.pct - a.pct)[0];
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await openPage(c.query);
    const file = path.join(OUT, key.replace(/[^\w\u4e00-\u9fa5]+/g, '_') + '.png');
    const size = await shoot(file);
    console.log(`  截图：${path.relative(ROOT, file)}（${(size / 1024).toFixed(0)} KB，${c.page} @ ${c.res}，${c.pct}%）`);
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ threshold: MIN_PCT, whitelist: allow, aggregate: rows.map(([k, v]) => ({ key: k, ...v })), details }, null, 2), 'utf8');
  console.log(`\n明细：${path.relative(ROOT, path.join(OUT, 'report.json'))}`);

  console.log('\n=== 汇总 ===');
  console.log(`检测组合 ${rows.length} 类，其中未白名单化 ${unallowed.length} 类`);
  if (unallowed.length) {
    console.log('未白名单化清单：');
    unallowed.forEach(k => console.log(`  - ${k}`));
    console.log(`\n请人工看图确认这些重叠是否合法；合法的写进 ${path.relative(ROOT, WHITELIST)} 的 allow 数组（字段 a / b / reason）。`);
  }

  if (cdp) cdp.close();
  if (edge && edge.exitCode === null) { try { edge.kill(); } catch (e) { /* 已退出 */ } }
  process.exit(unallowed.length ? 1 : 0);
}

main().catch(err => {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  if (cdp) cdp.close();
  if (edge && edge.exitCode === null) { try { edge.kill(); } catch (e) { /* 已退出 */ } }
  process.exit(2);
});
