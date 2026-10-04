/* ==========================================================================
   界面结构与需求规范自检（tests/ui-check.js）
   作用：把「需求清单的 FR-1～FR-4、FR-9、UI-01/03/04/08/11」中可离线判定的条款
         与 src/ 的实际渲染结果逐条对照（需求版本随 `需求文档\` 下的基线文件自动跟随，
         版本号只在 UI-REQ-VERSION 一处落笔，避免升版时到处改注释）。三类判据：
         ① 静态：样式表数值（字号、三段式比例、色彩变量、舞台尺寸）
         ② 行为：用假 DOM 跑真实组件的 render()，检查字段数、格式化、表格列数、空态、副作用
         ③ 需求口径：FR-4.2/4.3 的"开工 ≤ 计划"、FR-3.13 的五态可达性
   依赖：仅 Node 内置模块；不启浏览器（真实渲染与滚动条见 tests/browser-check.js）。
   运行：node tests/ui-check.js
   退出码：0 = 全部通过；1 = 有断言失败（失败项即待修缺陷）。
   说明：与 contract-check.js 的分工——那个管"接口契约与适配层"，本脚本管"界面与需求条款"。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const env = require('./env');
env.assertRuntime();

const ROOT = path.resolve(__dirname, '..');

/* ---------------- 断言框架 ---------------- */
let passed = 0;
const failures = [];
/* F15-2 的断言必须在**真网络路径**上做（`BoardSource.startServerSource()` 是异步的），
   于是它只能落在异步 IIFE 里；本数组负责把这些 Promise 收集到**汇总之前**统一 await，
   否则那条断言的结果会印在汇总行之后（数字与失败清单都会漏它）。 */
const asyncChecks = [];
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

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* E37/D9：`index.html` 里某元素的**初始 class**（真源就是这份静态文档）。
   为什么要读它：E37 的判据是"自愈后 `#hdrShift` 的 className 回到**与初始一致**的非错误样式"，
   而桩 DOM 的节点初始 `className` 是空串、根本不体现 index.html 的 `shift-badge` —— 照抄桩件的
   基线会把断言判成假红（实测）。返回 null ＝ 取不到（断言随之变红）。 */
function initialClassOf(id) {
  const tag = new RegExp(`<[^>]*\\bid="${id}"[^>]*>`).exec(readText('index.html'));
  if (!tag) return null;
  const cls = /\bclass="([^"]*)"/.exec(tag[0]);
  return cls ? cls[1] : null;
}

/* W7-B'：`index.html` 的 `<script src>` 清单 —— 前端脚本的**唯一注册真源**（顺序＝浏览器执行顺序）。
   为什么要把它做成被判据与夹具共用的真源：W7-B 新增 `src/services/selfCheckProbe.js` 时**忘了注册**，
   而当时的夹具是**手写 rels**、把该文件直接塞进沙箱 ⇒ 门禁全绿、真页面却永远停在占位文案
   （ADR-0004 D23 要防的正是"断言没落在真集成路径上"）。本仓无 ES 模块、无打包器，
   故"每个前端源文件都必须被 `index.html` 显式枚举"是硬不变量。 */
function indexScriptRels() {
  const html = readText('index.html');
  const rels = [];
  const re = /<script\s+src="([^"]+)"\s*>/g;
  let m;
  while ((m = re.exec(html)) !== null) rels.push(m[1]);
  return rels;
}

/* W7-B'：夹具装载**注册守卫** —— 请求装载的 rel 必须真的在 `index.html` 清单里。
   否则夹具会替真页面"补课"（把没注册的文件装进沙箱），把致命缺口伪装成绿。
   同一未注册文件只报一次（避免多条用例重复刷同一失败）。 */
const _guardReported = new Set();
function guardRegistered(rels, where) {
  const registered = indexScriptRels();
  const bad = rels.filter(r => registered.indexOf(r) < 0 && !_guardReported.has(r));
  if (!bad.length) return;
  bad.forEach(r => _guardReported.add(r));
  check(
    'W7-B\'-g（D12）夹具注册守卫（' + where + '）：请求装载的文件**全部**已在 `index.html` 注册',
    false,
    `未注册却被装载=${JSON.stringify(bad)} —— 这些文件在真页面里**根本不会执行**，` +
    '是夹具在替它"补课"（本守卫存在的唯一目的就是不许再发生）'
  );
}

/* ---------------- 轻量 CSS 解析（本项目无 @media/@keyframes，规则不嵌套） ---------------- */
/** 解析 CSS 文本 → Map(选择器, { 属性: 值 })；后出现的同名选择器覆盖前者 */
function parseCss(text) {
  const rules = new Map();
  /* 换行先归一：`global.css` 是 CRLF，`;` 切段后属性名会带 `\r\n` 前缀
     （实测：键成了 `'\r\n  box-shadow'`，`decls['box-shadow']` 恒 undefined ⇒ 断言假红） */
  const noComment = String(text).replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of noComment.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const decls = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    rules.set(selector, decls);
  }
  return rules;
}

/** 取某选择器的字号（px）；取不到返回 null */
function fontPx(rules, selector) {
  const decls = rules.get(selector);
  if (!decls || decls['font-size'] === undefined) return null;
  const m = String(decls['font-size']).match(/^(\d+(?:\.\d+)?)px$/);
  return m ? Number(m[1]) : null;
}

/** 取某选择器的某个 px 值（如 grid-template-rows 的 230px） */
function pxValues(rules, selector, prop) {
  const decls = rules.get(selector);
  if (!decls || decls[prop] === undefined) return [];
  return [...String(decls[prop]).matchAll(/(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
}

/* ---------------- 记录型假 DOM：既捕获渲染输出，也捕获"不该发生"的写操作 ---------------- */
/**
 * @param {Array} out 记录数组，元素形如 { kind, id, value }
 * kind: text | html | class | style | write | listen
 */
function makeRecorder(out) {
  const node = id => {
    const o = { __id: id, __v: '', style: {}, dataset: {} };
    Object.defineProperty(o, 'innerHTML', {
      get() { return ''; },
      set(v) { out.push({ kind: 'html', id: o.__id, value: String(v) }); },
      configurable: true
    });
    Object.defineProperty(o, 'value', {
      get() { return o.__v; },
      set(v) { out.push({ kind: 'write', id: o.__id, value: String(v) }); o.__v = v; },
      configurable: true
    });
    Object.defineProperty(o, 'textContent', {
      get() { return o.__v; },
      set(v) { out.push({ kind: 'text', id: o.__id, value: String(v) }); o.__v = v; },
      configurable: true
    });
    o.classList = { toggle() {}, add() {}, remove() {} };
    o.querySelector = sel => node(o.__id + ' ' + sel);
    o.appendChild = () => {};
    o.remove = () => {};
    o.addEventListener = () => { out.push({ kind: 'listen', id: o.__id }); };
    o.disabled = false;
    return o;
  };
  return {
    $: id => node(id),
    setText: (id, v) => out.push({ kind: 'text', id, value: String(v) }),
    setHTML: (id, v) => out.push({ kind: 'html', id, value: String(v) }),
    setClass: (id, v) => out.push({ kind: 'class', id, value: String(v) }),
    setStyle: (id, prop, value) => out.push({ kind: 'style', id, prop, value }),
    toggleClass: (id, cls, on) => out.push({ kind: 'class', id, value: cls + ':' + on })
  };
}

/** 在独立上下文里加载 src（真 Format/组件，假 Dom），返回 { window, out } */
function loadUi(componentRels) {
  const out = [];
  const sandbox = { console };
  sandbox.window = sandbox;
  /* 组件里还有少量 document 级查询（TaskPanel 的五态流程高亮），用最小桩件顶替 */
  sandbox.document = {
    querySelectorAll: sel => {
      if (sel === '.flow-step') {
        return ['待测试', '测试中', '合格', '不合格', '待复检'].map(step => ({
          dataset: { step },
          classList: { toggle: (cls, on) => out.push({ kind: 'class', id: 'flow-step:' + step, value: cls + ':' + on }) }
        }));
      }
      return [];
    },
    getElementById: () => null,
    querySelector: () => null
  };
  vm.createContext(sandbox);
  const run = rel => vm.runInContext(readText(rel), sandbox, { filename: path.join(ROOT, rel) });
  guardRegistered(componentRels, 'loadUi');
  run('src/config/board.config.js');
  run('src/config/fieldMap.js');
  run('src/utils/format.js');
  sandbox.window.Dom = makeRecorder(out);
  run('src/services/mockData.js');
  componentRels.forEach(run);
  return { w: sandbox.window, out };
}

/** 取记录里某个 id 最后一次写入的文本 */
function lastText(out, id) {
  const hits = out.filter(e => e.kind === 'text' && e.id === id);
  return hits.length ? hits[hits.length - 1].value : null;
}

/** 取记录里某个 id 最后一次写入的 HTML */
function lastHtml(out, id) {
  const hits = out.filter(e => e.kind === 'html' && e.id === id);
  return hits.length ? hits[hits.length - 1].value : null;
}

/** 节点当前可见值的快照（E37/E38/D9）：textContent 与 className 一起取，便于"三态前后比对" */
function snapId(fx, id) {
  const n = fx.node(id);
  return { text: String(n.textContent || ''), cls: String(n.className || '') };
}

/* ---------------- F-02 护栏用的源码读数工具（ADR-0004 D23：比数值，不比字符串写法） ----------------
   立案：审查发现 F-02 —— `SettingPanel.AUTO_LOCK_MS`（5 min）曾早于 `Dashboard.IDLE_RETURN_MS`（3 min），
   回首页时解锁态仍可能有效。修法是把两者的**数值关系**钉住，而不是在源码里搜某个字符串写法：
   若断言写成"源码含不含 `10 * 1000`"，把常量换成等价的 `310000` 就会假失败，
   而把错的 `3 * 60 * 1000` 改回来却可能照样绿 —— 那正是 D23 说的"静态防空洞"。 */

/** 取 `const NAME = <表达式>;` 里的表达式文本（取不到返回 null） */
function constExpr(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

/**
 * 只允许「数字 + `*` `+` `-` `/` + 括号 + 空白」的极小表达式求值器（递归下降，不用 eval/Function）。
 * 白名单之外一律抛错 —— 调用方必须把它变成 FAIL，不得兜底成 0（否则断言会静默变弱）。
 * @param {string} expr 形如 `5 * 60 * 1000 + 10 * 1000`
 * @returns {number} 求值结果
 */
function evalNumericExpr(expr) {
  const src = String(expr);
  if (!/^[\d\s*+\-/()]+$/.test(src)) throw new Error(`表达式含白名单外的字符：${JSON.stringify(src)}`);
  let i = 0;
  const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const number = () => {
    skipWs();
    const m = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (!m) throw new Error(`第 ${i} 个字符处应为数字：${JSON.stringify(src)}`);
    i += m[0].length;
    return Number(m[0]);
  };
  const primary = () => {
    skipWs();
    if (src[i] === '(') {
      i++;
      const v = sum();
      skipWs();
      if (src[i] !== ')') throw new Error(`括号不配对：${JSON.stringify(src)}`);
      i++;
      return v;
    }
    return number();
  };
  const term = () => {
    let v = primary();
    for (;;) {
      skipWs();
      const op = src[i];
      if (op !== '*' && op !== '/') return v;
      i++;
      const r = primary();
      v = op === '*' ? v * r : v / r;
    }
  };
  const sum = () => {
    let v = term();
    for (;;) {
      skipWs();
      const op = src[i];
      if (op !== '+' && op !== '-') return v;
      i++;
      v = op === '+' ? v + term() : v - term();
    }
  };
  const value = sum();
  skipWs();
  if (i !== src.length) throw new Error(`表达式有多余内容：${JSON.stringify(src)}`);
  if (!Number.isFinite(value)) throw new Error(`表达式不是有限数值：${JSON.stringify(src)}`);
  return value;
}

/** 取 `function NAME(...) { ... }` 的函数体源码（按花括号配对，跳过字符串字面量）；取不到返回 null */
function functionBody(src, name) {
  const head = src.indexOf(`function ${name}(`);
  if (head < 0) return null;
  const open = src.indexOf('{', head);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    else if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
    }
  }
  return null;
}

/**
 * F-02 行为夹具：在 vm 里加载**真实** `SettingPanel`，用可判定的 DOM/定时器桩件走真路径。
 * 与上面的记录型假 DOM（`makeRecorder`）的区别，正是本条用例需要的两件事：
 *   ① 节点**按 id 缓存**（同一 id 恒等，与真实 `$` 一致）—— 否则"组件改的节点"与"用例看的节点"不是同一个；
 *   ② 如实记录 `hidden` 与 `classList` 成员（`makeRecorder` 的 classList 是空壳，且没有 hidden）；
 *   ③ `setTimeout`/`clearTimeout` 只**登记**不真等：用例按 `delay` 找到回调并手工触发；
 *   ④ `console.warn` **捕获**（不回放）：`armAutoLock()` 未 bind 时的"不静默失效"判据要读它。
 * @returns {{w:object, nodes:Map<string,object>, node:Function, timers:Array,
 *            warnings:Array<string>, click:Function, fire:Function}}
 */
function loadAutoLockFixture() {
  const nodes = new Map();
  const timers = [];
  const warnings = [];
  let timerSeq = 0;

  const node = id => {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set();
    const handlers = {};
    const o = {
      __id: id, hidden: false, disabled: false, value: '', className: '', style: {}, dataset: {},
      classList: {
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        contains: c => classes.has(c),
        toggle: (c, on) => {
          if (on === undefined ? !classes.has(c) : on) classes.add(c);
          else classes.delete(c);
        }
      },
      addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
      __fire: type => (handlers[type] || []).forEach(fn => fn({ key: 'Enter' })),
      querySelector: sel => node(id + ' ' + sel),
      appendChild: () => {},
      remove: () => {}
    };
    Object.defineProperty(o, 'textContent', {
      get() { return o.__text || ''; }, set(v) { o.__text = String(v); }, configurable: true
    });
    Object.defineProperty(o, 'innerHTML', {
      get() { return ''; }, set() {}, configurable: true
    });
    nodes.set(id, o);
    return o;
  };

  /* `warn` 只捕获、不回放：它是"未 bind 不静默失效"（FR-8.2）的判据来源，
     回放会把一条**预期内**的警告混进门禁输出，看上去像故障。log/error 照旧透传。 */
  const sandbox = {
    console: {
      log: (...a) => console.log(...a),
      error: (...a) => console.error(...a),
      warn: (...a) => { warnings.push(a.map(x => (x && x.message) ? x.message : String(x)).join(' ')); }
    }
  };
  sandbox.window = sandbox;
  sandbox.setTimeout = (fn, delay) => { const id = ++timerSeq; timers.push({ id, delay, fn, fired: false, cancelled: false }); return id; };
  sandbox.clearTimeout = id => { const t = timers.find(x => x.id === id); if (t) t.cancelled = true; };
  sandbox.document = { querySelectorAll: () => [], getElementById: () => null, querySelector: () => null };
  vm.createContext(sandbox);
  const run = rel => vm.runInContext(readText(rel), sandbox, { filename: path.join(ROOT, rel) });
  guardRegistered(['src/components/SettingPanel.js'], 'loadAutoLockFixture');
  run('src/config/board.config.js');
  run('src/config/fieldMap.js');
  run('src/utils/format.js');
  sandbox.window.Dom = {
    $: node,
    setText: () => {}, setHTML: () => {}, setClass: () => {},
    setStyle: () => {}, toggleClass: () => {}
  };
  run('src/services/mockData.js');
  run('src/components/SettingPanel.js');

  return {
    w: sandbox.window,
    nodes,
    node,
    timers,
    warnings,
    click: id => node(id).__fire('click'),
    /** 触发**尚未触发且未被取消**的、delay 匹配的最后一个定时器回调 */
    fire: delay => {
      const t = timers.filter(x => x.delay === delay && !x.cancelled && !x.fired).pop();
      if (!t) throw new Error(`没有待触发的 ${delay} ms 定时器（已登记：${timers.map(x => x.delay).join('/') || '无'}）`);
      t.fired = true;
      t.fn();
      return t;
    }
  };
}

/**
 * F-02 旁路**启动**夹具（`?unlock=1`）：按 index.html 的加载顺序在 vm 里装配**真实**的一整套前端
 * （config → services → components → pages → **main**），只把浏览器环境换成桩件 ——
 * 于是 `src/main.js` 的 IIFE 会**真的跑完 `start()`**（`document.readyState='complete'` ⇒ 直接走 start 分支）。
 *
 * 为什么非要真跑 main.js（而不是在源码里 `indexOf('SettingPanel.armAutoLock(')`）：
 * 静态调用点判据是 ADR-0004 D23 说的"防空洞" —— 把那一行**注释掉**（字符串仍在源码里）或把调用
 * 挪到 `unlockByParam` 分支**之外**，静态判据照样绿（已实测：注释掉后 60 条全绿）。
 * 本夹具只认**行为结果**：启动后 state 是否真解锁、是否真登记了 300000 ms 定时器。
 *
 * 与 `loadAutoLockFixture` 的分工：那一个只装到组件层、由用例手工 bind()/click()；
 * 本夹具额外提供（缺一不可）：
 *   ① `location.search`：旁路参数的**唯一**来源 —— 参数改名、判定改写、分支挪位都会改变观察结果；
 *   ② `setInterval` 桩件：只登记不真跑（否则每秒刷新把 Node 进程钉住不退出）；
 *   ③ `document.getElementById` 恒返回**按 id 缓存**的节点（main.js 要取 `#stage` 施加舞台缩放）。
 * @param {string} search 查询串，如 `'?unlock=1'`、`'?tab=0'`
 * @returns {{w:object, nodes:Map<string,object>, node:Function, timers:Array, intervals:Array,
 *            warnings:Array<string>, fire:Function}}
 */
/** `loadBootFixture` 装载的组件清单（守卫与装载共用同一份，避免两处漂移） */
const BOOT_COMPONENTS = [
  'src/components/HeaderBar.js',
  'src/components/TabsBar.js',
  'src/components/CurveChart.js',
  'src/components/DeviceStatusPanel.js',
  'src/components/TaskPanel.js',
  'src/components/ShiftPanel.js',
  'src/components/StatsPanel.js',
  'src/components/AlarmPanel.js',
  'src/components/MaintPanel.js',
  'src/components/NoticePanel.js',
  'src/components/SettingPanel.js',
  'src/pages/Dashboard.js'
];

function loadBootFixture(search) {
  const nodes = new Map();
  const timers = [];
  const intervals = [];
  const warnings = [];
  let timerSeq = 0;
  let intervalSeq = 0;

  const node = id => {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set();
    const handlers = {};
    const o = {
      __id: id, hidden: false, disabled: false, value: '', className: '', style: {}, dataset: {},
      classList: {
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        contains: c => classes.has(c),
        toggle: (c, on) => {
          if (on === undefined ? !classes.has(c) : on) classes.add(c);
          else classes.delete(c);
        }
      },
      addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
      __fire: type => (handlers[type] || []).forEach(fn => fn({ key: 'Enter' })),
      querySelector: sel => node(id + ' ' + sel),
      appendChild: () => {},
      remove: () => {},
      closest: () => null
    };
    Object.defineProperty(o, 'textContent', {
      get() { return o.__text || ''; }, set(v) { o.__text = String(v); }, configurable: true
    });
    Object.defineProperty(o, 'innerHTML', {
      get() { return o.__html || ''; }, set(v) { o.__html = String(v); }, configurable: true
    });
    nodes.set(id, o);
    return o;
  };

  /* warn 只捕获不回放（与 loadAutoLockFixture 同口径）：`armAutoLock()` 未 bind 时的警告是
     **预期输出**，回放会让门禁输出看上去像故障；log/error 照旧透传，异常不被吞掉。 */
  const sandbox = {
    console: {
      log: (...a) => console.log(...a),
      error: (...a) => console.error(...a),
      warn: (...a) => { warnings.push(a.map(x => (x && x.message) ? x.message : String(x)).join(' ')); }
    },
    location: { search },                 /* main.js 读 location.search 取评审参数 */
    URLSearchParams,                      /* 不是 V8 内建，须显式注入 vm 上下文 */
    innerWidth: 3840, innerHeight: 2160,  /* fitStage() 要读；按 4K 基准，缩放比正好 1 */
    addEventListener: () => {}            /* window.addEventListener('resize', fitStage) */
  };
  sandbox.window = sandbox;
  sandbox.setTimeout = (fn, delay) => { const id = ++timerSeq; timers.push({ id, delay, fn, fired: false, cancelled: false }); return id; };
  sandbox.clearTimeout = id => { const t = timers.find(x => x.id === id); if (t) t.cancelled = true; };
  sandbox.setInterval = (fn, delay) => { const id = ++intervalSeq; intervals.push({ id, delay, fn }); return id; };
  sandbox.clearInterval = () => {};
  sandbox.document = {
    readyState: 'complete',               /* 直接执行 start()，不必再触发 DOMContentLoaded */
    getElementById: node,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => node('created-' + (++timerSeq)),
    addEventListener: () => {}
  };

  vm.createContext(sandbox);
  const run = rel => vm.runInContext(readText(rel), sandbox, { filename: path.join(ROOT, rel) });
  guardRegistered(BOOT_COMPONENTS, 'loadBootFixture');
  run('src/config/board.config.js');
  run('src/config/fieldMap.js');
  run('src/utils/format.js');
  sandbox.window.Dom = {
    $: node,
    setText: () => {}, setHTML: () => {}, setClass: () => {},
    setStyle: () => {}, toggleClass: () => {}
  };
  run('src/services/mockData.js');
  run('src/services/api.js');
  BOOT_COMPONENTS.forEach(run);
  run('src/main.js');                     /* readyState='complete' ⇒ 启动流程在本次 run 内跑完 */

  return {
    w: sandbox.window,
    nodes,
    node,
    timers,
    intervals,
    warnings,
    /** 触发**尚未触发且未被取消**的、delay 匹配的最后一个定时器回调 */
    fire: delay => {
      const t = timers.filter(x => x.delay === delay && !x.cancelled && !x.fired).pop();
      if (!t) throw new Error(`没有待触发的 ${delay} ms 定时器（已登记：${timers.map(x => x.delay).join('/') || '无'}）`);
      t.fired = true;
      t.fn();
      return t;
    }
  };
}

/**
 * E34（★★★，D8）渲染循环兜底夹具：按 index.html 顺序在 vm 里装配**真实**的一整套前端
 * （config → services → components → pages → **main**），只把浏览器环境换成桩件。
 *
 * 与 `loadBootFixture` 的分工：那一个只关心"启动后的静态状态"（解锁位、登记了几个计时器），
 * 本夹具要观察**逐帧行为**，故额外提供三件缺一不可的能力：
 *   ① **可注入的时钟**（`Date` 桩件 + `advance()`）：`step()` 内是 `new Date()` —— 不换 Date
 *      就只能靠"等真实时间"，那既慢又不可复现。换了之后"本帧是否真的刷新"有确定判据：
 *      `#hdrClock` 的文本会随注入时刻变化，冻结帧则原封不动。
 *   ② **`console.error` 捕获**（不回放，`errorCount()/errors()` 读它）：E34 的"不刷屏"判据要
 *      数报错条数，且要求断言**不依赖真实 stderr**。
 *   ③ **`Components.*.render` 调用计数**（`calls`）：在 `main.js` 跑完之后、首帧之前包一层计数器
 *      ⇒ "渲染仍发生"有**行为**证据（调用次数增加），不是源码字符串匹配（ADR-0004 D23）。
 *
 * 用法（缺口配置一律走"内存覆盖 `BoardConfig.shift.list` 的**同一个数组**"，不落盘、
 * 不改 `mockData.js` 的 `SHIFTS` 引用）：
 *   const fx = loadFrameFixture(['src/components/HeaderBar.js', ...]);
 *   fx.setShiftList([{ name:'晚班', start:0, end:8 }, { name:'中班', start:16, end:24 }]);
 *   fx.frame();                    // 驱动**恰好一帧**（等价于 setInterval 那一跳）
 *
 * @param {string[]} componentRels 组件加载清单（顺序须与 index.html 一致）
 * @param {string} [search] 查询串（默认空；`?unlock=1` 等旁路参数按需给）
 * @param {{protocol?:string}} [opts] `protocol` 写进桩件的 `location.protocol`（F18 要区分
 *        `file:` 与同源托管；缺省 `'http:'`）。**必须在 `run()` 之前设**：`boardSource.resolveBaseUrl()`
 *        是**调用时**读 `location.protocol`，而 vm 沙箱里 `location` 就是全局对象本身，
 *        事后从外部对 `fx.w.location` 赋值改不到它。
 * @returns {{w:object, nodes:Map<string,object>, node:Function, out:Array, calls:object,
 *            intervals:Array, errors:Function, errorCount:Function, advance:Function,
 *            setShiftList:Function, frame:Function, click:Function, type:Function,
 *            currentShiftList:Function}}
 */
function loadFrameFixture(componentRels, search, opts) {
  const nodes = new Map();
  const out = [];
  const intervals = [];
  const loggedErrors = [];
  const timers = [];
  const calls = {};
  /* F15-1：`appendChild` 记下的子节点 / `remove()` 摘掉的节点 ——
     供 `document.querySelector*` 只返回"仍在文档里"的节点（真 DOM 语义）。 */
  const appended = [];
  const removed = [];
  const clock = { ms: new Date('2026-09-27T10:20:30').getTime() };
  let timerSeq = 0;
  let intervalSeq = 0;

  const node = id => {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set();
    const handlers = {};
    const o = {
      /* `className` 初值取 `index.html` 的同名 id 初始 class（取不到则空串）：
         E37 要判"是否回到初始样式"，桩件必须先把"初始"表示出来（真 DOM 由 index.html 提供）。 */
      __id: id, hidden: false, disabled: false, value: '', className: initialClassOf(id) || '', style: {}, dataset: {},
      classList: {
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        contains: c => classes.has(c),
        toggle: (c, on) => {
          if (on === undefined ? !classes.has(c) : on) classes.add(c);
          else classes.delete(c);
        }
      },
      addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
      __fire: (type, ev) => (handlers[type] || []).forEach(fn => fn(ev || { key: 'Enter' })),
      querySelector: sel => node(id + ' ' + sel),
      /* F15-1：`appendChild` 必须**记下子节点**（真 DOM 语义），否则"降级横幅只 1 条 / 存在性"
         这类按 `document.querySelector*` 观察的断言看到的是空集合 —— 而"0 条"对
         "不得叠加（≤1）"**同样为真** ⇒ 断言变成防空洞（复核实测：D22 变异测不出来）。
         `__parent` / `parentNode` 也一并维护：`BoardSource.showFallbackBanner()` 用它判断
         "这条横幅到底在不在文档里"（游离节点不得复用）。 */
      appendChild: child => {
        if (child && typeof child === 'object') {
          child.__parent = o;
          o.__children = o.__children || [];
          if (o.__children.indexOf(child) < 0) o.__children.push(child);
          appended.push(child);
          if (child.__id) nodes.set(child.__id, child);
          if (child.id) nodes.set(child.id, child);
        }
        return child;
      },
      remove: () => {
        removed.push(o);
        if (o.__parent && Array.isArray(o.__parent.__children)) {
          const i = o.__parent.__children.indexOf(o);
          if (i >= 0) o.__parent.__children.splice(i, 1);
        }
        o.__parent = null;
        const ai = appended.indexOf(o);
        if (ai >= 0) appended.splice(ai, 1);
        nodes.delete(o.__id);
        if (o.id) nodes.delete(o.id);
      },
      closest: () => null
    };
    Object.defineProperty(o, 'parentNode', { get() { return o.__parent || null; }, configurable: true });
    Object.defineProperty(o, 'textContent', {
      get() { return o.__text || ''; },
      set(v) { o.__text = String(v); out.push({ kind: 'text', id: o.__id, value: String(v) }); },
      configurable: true
    });
    Object.defineProperty(o, 'innerHTML', {
      get() { return o.__html || ''; },
      set(v) { o.__html = String(v); out.push({ kind: 'html', id: o.__id, value: String(v) }); },
      configurable: true
    });
    nodes.set(id, o);
    return o;
  };

  /* Date 桩件：`new Date()` 一律取注入时刻；显式带参的 `new Date(x)` 照旧（组件里会用到） */
  const RealDate = Date;
  const FakeDate = function (...args) { return args.length ? new RealDate(...args) : new RealDate(clock.ms); };
  FakeDate.now = () => clock.ms;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;

  const sandbox = {
    console: {
      log: (...a) => console.log(...a),
      warn: (...a) => { loggedErrors.push({ kind: 'warn', text: a.map(x => (x && x.message) ? x.message : String(x)).join(' ') }); },
      error: (...a) => { loggedErrors.push({ kind: 'error', text: a.map(x => (x && x.message) ? x.message : String(x)).join(' ') }); }
    },
    Date: FakeDate,
    location: { search: search || '', protocol: (opts && opts.protocol) || 'http:' },
    URLSearchParams,
    /* F18：把桩 `fetch` 暴露进沙箱 —— 用例用它**捕获真实请求 URL**（行为判据，不是读源码字符串） */
    fetch: (...a) => sandbox.__fetch(...a),
    innerWidth: 3840, innerHeight: 2160,
    addEventListener: () => {}
  };
  sandbox.window = sandbox;
  /* F18：桩 `fetch`（默认"网络错误"式拒绝；用例可覆盖 `sandbox.__fetch` 以**捕获真实请求 URL**）
     ＋ `AbortSignal.timeout` 占位（`api.httpJson` 会做能力检测，缺了也不抛，这里给全更贴近浏览器）。 */
  sandbox.__fetch = () => Promise.reject(new Error('ui-check 桩 fetch：未接网络'));
  sandbox.AbortSignal = { timeout: () => ({}) };
  sandbox.setTimeout = (fn, delay) => { const id = ++timerSeq; timers.push({ id, delay, fn, fired: false, cancelled: false }); return id; };
  sandbox.clearTimeout = id => { const t = timers.find(x => x.id === id); if (t) t.cancelled = true; };
  sandbox.setInterval = (fn, delay) => { const id = ++intervalSeq; intervals.push({ id, delay, fn }); return id; };
  sandbox.clearInterval = () => {};
  sandbox.document = {
    readyState: 'complete',                 /* 直接跑 start()，不必再触发 DOMContentLoaded */
    getElementById: node,
    /* F15-1：`document.querySelector*` 必须**真的能查到已插入的节点**（真 DOM 语义）。
       改前恒返回 null / []，于是"降级横幅存在且不叠加"这类断言**对 0 条也为真**（空洞），
       D22 变异测不出来（复核实测）。现在按 `appendChild` 记录的"仍在文档里"的节点查找。 */
    querySelector: sel => {
      const cls = String(sel).replace(/^\./, '');
      for (const el of appended) {
        if (String(el.className || '').split(/\s+/).indexOf(cls) >= 0) return el;
      }
      return null;
    },
    querySelectorAll: sel => {
      const cls = String(sel).replace(/^\./, '');
      return appended.filter(el => String(el.className || '').split(/\s+/).indexOf(cls) >= 0);
    },
    createElement: () => node('created-' + (++timerSeq)),
    addEventListener: () => {}
  };

  vm.createContext(sandbox);
  const run = rel => vm.runInContext(readText(rel), sandbox, { filename: path.join(ROOT, rel) });
  guardRegistered(componentRels, '夹具装载');
  run('src/config/board.config.js');
  run('src/config/fieldMap.js');
  run('src/utils/format.js');
  sandbox.window.Dom = {
    $: node,
    setText: (id, v) => { out.push({ kind: 'text', id, value: String(v) }); node(id).__text = String(v); },
    setHTML: (id, v) => { out.push({ kind: 'html', id, value: String(v) }); node(id).__html = String(v); },
    /* setClass **真的写进 `node.className`**（与真 `Dom.setClass` 的无条件 `e.className = v` 同语义）：
       E37 的判据是"正常分支是否把 class 复原"，只记录不落地就观察不到（实测：改前也能"绿"）。 */
    setClass: (id, v) => { out.push({ kind: 'class', id, value: String(v) }); node(id).className = String(v); },
    setStyle: (id, prop, value) => { out.push({ kind: 'style', id, prop, value: String(value) }); node(id).style[prop] = String(value); },
    toggleClass: (id, cls, on) => { out.push({ kind: 'class', id, value: cls + ':' + on }); }
  };
  run('src/services/mockData.js');
  run('src/services/api.js');
  componentRels.forEach(run);
  run('src/pages/Dashboard.js');

  /* 调用计数包在**真组件**上：必须在 main.js 之前包不了（main.js 依赖 Components 已装配），
     但必须不晚于首帧 —— 而 main.js 一跑完就已经跑过首帧了，故计数器只能从"第二帧"起算。
     这正是判据需要的：缺口场景下首帧本身就不该冻结，用例先 `frame()` 一帧把状态推进到稳态，
     再清零计数、连驱 5 帧看增量（每帧每个组件都应 +1）。 */
  const CALL_KEYS = [
    ['HeaderBar', 'render'], ['TabsBar', 'renderLinkStatus'], ['DeviceStatusPanel', 'render'],
    ['TaskPanel', 'render'], ['ShiftPanel', 'render'], ['StatsPanel', 'render'],
    ['AlarmPanel', 'render'], ['MaintPanel', 'render'], ['NoticePanel', 'render'], ['SettingPanel', 'render']
  ];
  const wrapCalls = () => {
    CALL_KEYS.forEach(([name, method]) => {
      const key = name + '.' + method;
      if (calls[key] === undefined) calls[key] = 0;
      const comp = sandbox.window.Components[name];
      const orig = comp[method];
      comp[method] = function (...a) { calls[key]++; return orig.apply(this, a); };
    });
  };
  const resetCalls = () => CALL_KEYS.forEach(([n, m]) => { calls[n + '.' + m] = 0; });

  let startErr = null;
  try { run('src/main.js'); } catch (e) { startErr = e.message; }
  wrapCalls();

  const stepRef = intervals.length ? intervals[0].fn : null;

  return {
    w: sandbox.window,
    nodes,
    node,
    out,
    calls,
    intervals,
    startErr,
    CALL_KEYS,
    resetCalls,
    /** F15-1：当前"仍在文档里"的降级横幅（按类名精确筛选，供"存在且不叠加"断言使用） */
    banners: cls => appended.filter(el =>
      String(el.className || '').split(/\s+/).indexOf(String(cls).replace(/^\./, '')) >= 0),
    /** F15-1：`appendChild` 记录（插入顺序） */
    appended,
    /** 捕获到的 console.warn/error 原文（不回放，避免把**预期内**的告警混进门禁输出） */
    errors: kind => loggedErrors.filter(e => kind === undefined || e.kind === kind).map(e => e.text),
    errorCount: () => loggedErrors.filter(e => e.kind === 'error').length,
    /** 注入时钟前进 ms 毫秒 */
    advance: ms => { clock.ms += ms; },
    /** 就地改写班次配置（**同一个数组**，`mockData.js` 的 `SHIFTS` 与之同引用） */
    setShiftList: arr => {
      const list = sandbox.window.BoardConfig.shift.list;
      list.splice(0, list.length, ...arr);
      return list.slice();
    },
    currentShiftList: () => sandbox.window.BoardConfig.shift.list.slice(),
    /** 驱动**恰好一帧**：注入时钟 +1 s 后调用真实的 `step()`（setInterval 那一跳）。返回顶层是否抛出 */
    frame: () => {
      if (!stepRef) return { threw: true, message: startErr || 'main.js 未登记 setInterval（start() 可能在首帧就中断了）' };
      clock.ms += 1000;
      try { stepRef(); return { threw: false, message: null }; }
      catch (e) { return { threw: true, message: (e && e.message) || String(e) }; }
    },
    click: id => node(id).__fire('click'),
    type: (id, key) => node(id).__fire('keydown', { key: key || 'a' })
  };
}

/**
 * 任务数据页「测试标准区 / 相机二级菜单」夹具（FR-3.16 改写 / FR-3.18 / FR-3.19）。
 *
 * 为什么不能直接复用 `loadUi` 的记录型假 DOM：V1.33 的三条条款要的是**交互与注入行为**，
 * 而记录型假 DOM 缺三件必需的能力 ——
 *   ① **按 id 缓存的节点**（`loadUi` 每次 `$()` 都新建节点，于是"组件改的节点"与"用例看的节点"
 *      不是同一个：`#tkStdEdit` 的 `hidden`、`#std0upper` 的 `parentNode` 都观察不到）；
 *   ② **可派发的事件**（点上限/下限数字走 `#panel-task` 的 mousedown 委托，回车/Esc/失焦走
 *      `#tkStdInput` 的 keydown/blur）—— 没有事件就无法区分"未解锁点数字不进入录入态"与
 *      "解锁后点数字进入录入态"；
 *   ③ **元素的父子关系**（`climbTo()` 靠 `parentNode` 向上找 `.std-num` / `.std-edit`）。
 *
 * 本夹具提供上述三点，并额外把 `#tkStdEdit` 的 `innerHTML` 渲染成**前三个直接子元素**——
 * 与 index.html 的结构（label span / input / hint span）一致，于是"锁定后点击数字不进入录入态"
 * 有一个**可证伪**的观察量：锁定 ⇒ `hidden` 保持 true、且 `#tkStdEdit` 内**没有** `#tkStdInput`
 * 可聚焦（证明不是"输入框其实在，只是没隐藏"）。
 *
 * 真实依赖：`TaskPanel` / `SettingPanel` / `Dashboard` 都是 vm 里的真组件；只把浏览器环境换成桩件。
 * @param {object} [taskState] 用例自备的 state；给了就**整体替换** `MockData.state` 的内容
 *        （逐键覆盖，保留同一个对象 —— 组件的 `TaskPanel` 事件处理器读的是
 *        `window.MockData.state`，换个对象会让它与用例的 `fx.state` 指向不同实例，
 *        表现为"解锁了却点不动"；实测踩过）。
 *        为什么必须给：`pushLog()` 从 `state.clock` 取时间戳、`setUnlocked()` 改 `state.unlocked`，
 *        而真单例的 `clock` 在脚本加载时是空的（不给自备 state 的话留痕时间戳成了 `--:--:--`）。
 * @returns {{W:object, state:object, timers:Array, alerts:Array<string>, idleResets:number,
 *            fire:Function, click:Function, screen:Function, node:Function,
 *            input:Function, snap:Function}}
 */
/** `loadTaskStdFixture` 装载的组件清单（守卫与装载共用同一份，避免两处漂移） */
const TASKSTD_COMPONENTS = ['src/components/TaskPanel.js', 'src/components/SettingPanel.js', 'src/pages/Dashboard.js'];

function loadTaskStdFixture(taskState) {
  const nodes = new Map();
  const timers = [];
  const alerts = [];
  /** tbody 正文的**原始** HTML（key = '表id tbody'）：`innerHTML` 的 getter 要返回"上个渲染周期
      的正文"才与浏览器一致，而 `querySelector('tbody')` 必须按**本次**写入的正文重建子节点，
      两者不能共用一个字段（实测踩过：共用时 querySelector 读到旧/空正文 ⇒ 单元格一个都查不到）。
      注意正文是组件**直接** `tbody.innerHTML = …` 写的，不经过 `Dom.setHTML`，
      故记录动作必须挂在 innerHTML 的 setter 上。 */
  const rawTbody = new Map();
  let seq = 0;
  let idleResets = 0;          /* "无操作回首页"计时被重置的次数（夹具计数桩累加） */

  let sandbox = null;
  let renderSeq = 0;           /* #tkCompareTable/#tkStdTable 正文的渲染次数（单元格对象按此换代） */
  let inputEl = null;          /* #tkStdInput：懒查询（与组件一致，避免渲染顺序耦合） */
  let editBox = null;          /* #tkStdEdit */

  /** 取（必要时创建）按 id 缓存的节点 */
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const handlers = {};
    const classes = new Set();
    const o = {
      __id: id, hidden: false, disabled: false, value: '', className: '', style: {}, dataset: {},
      __children: [],
      classList: {
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        contains: c => classes.has(c),
        toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); }
      },
      addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
      /** 派发事件；载荷默认带 `key:'Enter'` 与 no-op `preventDefault`（组件的 keydown 分支要调它） */
      __fire: (type, extra) => (handlers[type] || []).forEach(fn =>
        fn(Object.assign({ key: 'Enter', preventDefault() {} }, extra))),
      /** 输入框专用：把 value 换成输入框自己的值（浏览器与组件共用同一节点） */
      focus() {}, select() {}, blur() {},
      appendChild() {}, remove() {}, closest: () => null,
      get parentNode() { return o.__parent || null; }
    };
    Object.defineProperty(o, 'textContent', {
      get() { return o.__text || ''; }, set(v) { o.__text = String(v); }, configurable: true
    });
    Object.defineProperty(o, 'innerHTML', {
      get() { return o.__html || ''; },
      set(v) {
        o.__html = String(v);
        /* tbody：记录正文供 querySelector('tbody') 解析（见 rawTbody 的注释） */
        if (/ tbody$/.test(id)) rawTbody.set(id, o.__html);
        /* #tkStdEdit 按 index.html 的子元素结构（label / input / hint）重建，
           这样 #tkStdInput 的可查询性直接反映"录入行是可见的" */
        if (id === 'tkStdEdit') {
          editBox = o;
          o.__children = ['tkStdEditLabel', 'tkStdInput', 'tkStdEditHint'].map(cid => {
            const c = node(cid);
            c.__parent = o;
            return c;
          });
          if (!inputEl) inputEl = o.__children[1];
        }
      },
      configurable: true
    });
    o.querySelector = sel => {
      if (sel !== 'tbody') return node(id + ' ' + sel);
      renderSeq++;
      /* tbody 的 id **必须带表的 id**：`#tkStdTable`（测试标准区）与 `#tkCompareTable`
         （相机二级菜单）各有自己的 tbody；若共用一个节点，后渲染的相机表会**覆盖**标准表
         （实测踩过：标准表正文被相机两列内容顶掉，四条结构断言一起假红）。 */
      const tb = node(id + ' tbody');
      tb.__parent = o;
      const rows = [];
      const src = rawTbody.get(id + ' tbody') || '';
      /* 注意：渲染出的单元格是 `<td class="…">`（td 后紧跟空格），须用 `\b` 而不是 `\s` */
      const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
      const tdRe = /<td\b([^>]*)>([\s\S]*?)<\/td>/g;
      for (const rm of src.matchAll(rowRe)) {
        const row = node(id + ' tr' + renderSeq + '_' + rows.length);
        row.__parent = tb;
        const cls = (/^<tr\b[^>]*\bdata-kind="([^"]+)"/.exec(rm[0]) || [])[1] || '';
        row.dataset.kind = cls;
        let cellIdx = 0;
        row.__children = [];
        for (const cm of rm[1].matchAll(tdRe)) {
          /* 单元格 id 按「第几次渲染 + 行 + 列」派生：同一次渲染内**恒等**（事件目标与
             用例断言的对象是同一个），换一次渲染即换新对象（与真实 innerHTML 重建一致） */
          const td = node(id + ' c' + renderSeq + '_' + (rows.length * 4 + cellIdx++));
          td.__parent = row;
          const cm2 = /\bclass="([^"]*)"/.exec(cm[1]);
          const dm = /\bdata-edit="([^"]*)"/.exec(cm[1]);
          String(cm2 ? cm2[1] : '').split(/\s+/).filter(Boolean).forEach(x => td.classList.add(x));
          if (dm) td.dataset.edit = dm[1];
          td.innerHTML = cm[2];
          row.__children.push(td);
        }
        rows.push(row);
      }
      tb.__children = rows;
      return tb;
    };
    nodes.set(id, o);
    return o;
  }

  sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    alert: msg => { alerts.push(String(msg)); },
    setTimeout: (fn, delay) => { const id = ++seq; timers.push({ id, delay, fn, fired: false, cancelled: false }); return id; },
    clearTimeout: id => { const t = timers.find(x => x.id === id); if (t) t.cancelled = true; },
    addEventListener: () => {},
    Date
  };
  sandbox.window = sandbox;
  sandbox.document = {
    readyState: 'complete',
    getElementById: node,
    /* 没有 addEventListener ⇒ 三个组件自带的"装配一次"IIFE 一律不跑（避免在 MockData 未就位时
       抢跑），装配改由用例显式调用 TaskPanel.bind() / Dashboard.init() / SettingPanel.bind() */
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => node('created-' + (++seq)),
    addEventListener: undefined
  };
  vm.createContext(sandbox);
  const run = rel => vm.runInContext(readText(rel), sandbox, { filename: path.join(ROOT, rel) });
  guardRegistered(TASKSTD_COMPONENTS, 'loadTaskStdFixture');
  run('src/config/board.config.js');
  run('src/config/fieldMap.js');
  run('src/utils/format.js');
  sandbox.window.Dom = {
    $: node,
    setText: (id, v) => { node(id).textContent = v; },
    setHTML: (id, v) => { node(id).innerHTML = v; },
    setClass: (id, v) => { node(id).className = v; },
    setStyle: (id, prop, val) => { node(id).style[prop] = val; },
    toggleClass: (id, cls, on) => { node(id).classList.toggle(cls, on); }
  };
  run('src/services/mockData.js');
  run('src/components/TaskPanel.js');
  run('src/components/SettingPanel.js');
  run('src/pages/Dashboard.js');
  /* Dashboard.init() 还要装配标签栏与报警面板；本用例只关心"回首页计时"那一条时钟，
     给这两个组件空实现即可（不加载真组件＝不把无关 DOM 依赖拖进夹具）。
     注：`SettingPanel.bind` 用**真组件**（FR-3.19 第⑧步要的就是真 armAutoLock 计时）。 */
  sandbox.window.Components.TabsBar = { build() {}, setActive() {}, renderLinkStatus() {} };
  sandbox.window.Components.AlarmPanel = { bind() {}, render() {}, renderAll() {} };
  /* 用例自备的 state 逐键覆盖 MockData 的单例（见函数头 @param taskState 的说明）。
     必须**保留同一个对象**：`TaskPanel` 的事件处理器读 `window.MockData.state`，
     换对象会让它和用例的 `fx.state` 指向不同实例。 */
  if (taskState) Object.assign(sandbox.window.MockData.state, taskState);
  /* `Dashboard.init` 照旧用真实现 —— FR-3.19 第⑧步要观察的正是它内部
     `SettingPanel.bind(state, resetIdleTimer)` 那条接线。
     ⚠️ 计数桩为什么不能挂在这里：自动锁定回调**只置锁定态、不回调 onActivity**
     （它自己就是"锁定"这一动作），挂这里读到的恒是 0（实测踩过）。 */
  const Dash = sandbox.window.Pages.Dashboard;
  /* FR-3.19 第⑧步要观察 `TaskPanel.activity()` 是否真的走到"重置无操作回首页计时"。
     为什么用 spy 而不是 `bind(state, onActivity)` 的计数桩：`Dashboard.init()` 的装配列表里
     **没有** `TaskPanel.bind`（它是 DOM 就绪后自 bind），故注入的 onActivity 收不到这次调用，
     计数恒 0（实测踩过）。spy 装在最外层公开函数上，`activity()` 的 `Pages.Dashboard.resetIdleTimer()`
     必然经过它 —— 真路径，不依赖装配顺序。 */
  const realResetIdle = Dash.resetIdleTimer;
  Dash.resetIdleTimer = function spyResetIdleTimer() {
    idleResets++;
    return realResetIdle();
  };

  const api = {
    W: sandbox.window,
    state: sandbox.window.MockData.state,
    timers,
    alerts,
    /** 真实 `Dashboard.resetIdleTimer()` 被调用的累计次数（夹具把它包成 spy，见上方注释） */
    get idleResets() { return idleResets; },
    node,
    /** 触发**尚未触发且未被取消**的、delay 匹配的最后一个定时器回调 */
    fire: delay => {
      const t = timers.filter(x => x.delay === delay && !x.cancelled && !x.fired).pop();
      if (!t) throw new Error(`没有待触发的 ${delay} ms 定时器（已登记：${timers.map(x => x.delay).join('/') || '无'}）`);
      t.fired = true;
      t.fn();
      return t;
    },
    /** 点击（mousedown）某个节点的 `.std-num` 祖先：沿 parentNode 上溯，模拟真实事件冒泡 */
    click: target => {
      let cur = target;
      while (cur && !(cur.classList && cur.classList.contains('std-num'))) cur = cur.parentNode;
      node('panel-task').__fire('mousedown', { target: cur || target });
    },
    /** 在 #tkStdInput 上派发事件（keydown/blur）；key 默认 'Enter'（组件的回车确认分支） */
    screen: (type, key) => { if (!inputEl) inputEl = node('tkStdInput'); inputEl.__fire(type, { key: key || 'Enter' }); },
    input: () => { if (!inputEl) inputEl = node('tkStdInput'); return inputEl; },
    editBox: () => editBox,
    /** 真实 `Dashboard.resetIdleTimer()` 被调用的次数（夹具把它包成 spy，见上方注释） */
    idleActivity: () => { idleResets++; },
    /** 状态快照：用于"非法录入不得写入"的前后比对 */
    snap: () => JSON.stringify(sandbox.window.MockData.state)
  };
  return api;
}

/* ---------------- 需求规范基线（来源：`需求文档\` 下的当前基线版需求清单） ---------------- */
/* §5 UI-03 色彩规范、UI-04 字号规范（4K 基准）；§4.1/4.3/4.4/4.9 的功能条目 */
const UI03 = { '--ok': '#00B050', '--warn': '#FFC000', '--err': '#FF0000', '--idle': '#808080', '--bg': '#0B1A2B' };
const UI04 = [
  { role: '航行器深度/速度数值（主展示）', selector: '.tile-value.hero', min: 120 },
  { role: '头部设备名', selector: '.device-name', min: 80 },
  { role: '时间数字', selector: '.clock', min: 100 },
  { role: '区块标题', selector: '.card-title', min: 72 },
  { role: '指标名', selector: '.tile-label', min: 56 },
  { role: '辅助说明（取下限最小者）', selector: null, min: 40 }
];
const HELPER_SELECTORS = ['.title-note', '.card-title.sm .title-note', '.link-note', '.tile-note', '.chart-foot', '.chart-empty .empty-note', '.hint', '.form-label'];

/* ==========================================================================
   V1.33 测试标准区（FR-3.16 改写 / FR-3.18 / FR-3.19）——用例侧的解析与规范化工具
   --------------------------------------------------------------------------
   三条纪律：
    ① **断言名里逐字写条款编号**（trace-check 把断言名当逐字证据引用）；
    ② 判据里的**数字一律从配置/state 实算**（`standards.nearRatio`、`AUTO_LOCK_MS`、
       典型值与偏差都来自配置段或 state 快照），**不硬编码 15% / 300000 ms / 12.50** ——
       配置改了断言要跟着改判，而不是假绿；
    ③ 只做**可证伪**的观察：解析失败（拿不到结构）时返回 null/负值，断言随之变红。
   ========================================================================== */

/** 构造一份**自足**的任务状态（字段齐备 ⇒ TaskPanel 走正常渲染分支，而非 FR-3.17 空态） */
function mkStdTaskState() {
  return {
    clock: { date: '2026-09-22', week: '星期二', time: '14:30:00' },
    device: { name: '水池高速摄像生产管理看板', code: 'SB-01', link: 'online', mes: 'online' },
    shift: { list: [], team: '检验一班', operator: '张伟', leader: '李建国' },
    unlocked: false,
    task: {
      procOrderNo: 'MES20260922001', productCode: 'CP-2026-A17', productName: '水下振动测试件',
      batchNo: 'PC20260922-01', drawingNo: 'SJ-4471-02', orderNo: 'DD20260922-118',
      std: { depth: 12.50, gain: 2.5, fps: 1000, shutter: 500 },
      real: { depth: 12.68, speed: 5.00, vx: 4.90, vy: 0.10, fps: 1000, gain: 2.5, shutter: 500, cameraDepth: 12.00 },
      unitIndex: 1, progress: 0.5, result: '测试中', lastResult: '合格', planQty: 300
    },
    stats: { plan: 300, started: 120, notStarted: 180, done: 118, testing: 1, pending: 0, firstPass: 0.9 },
    alarm: { active: null, queue: [], ledger: [] },
    warnings: [], notices: { notices: [], tips: [], todo: [] }, selfCheck: [], opLog: [],
    maint: { records: [] }, curve: {}, curveTick: {}
  };
}

/** 按 VM 里的真实配置（standards.digits / default 段）取某参数的规格；取不到返回 null（断言即变红） */
function makeStdSpec(W, kind) {
  const STD = (W.BoardConfig || {}).standards || {};
  const row = (STD.default || {})[kind];
  if (!row) return null;
  return {
    unit: row.unit, digits: typeof STD.digits === 'number' ? STD.digits : null,
    typical: row.typical, upperDev: row.upperDev, lowerDev: row.lowerDev,
    upper: W.Format.round2(row.typical + row.upperDev),
    lower: W.Format.round2(row.typical + row.lowerDev)
  };
}

/** 解析 `#tkStdTable` 的正文 HTML → 每行的 { kind, tds:[{cls, edit}] }；拿不到结构时给出空数组
 *  ⚠️ 单元格形如 `<td class="std-num upper">`、行形如 `<tr data-kind="depth">` ——
 *     标签名后紧跟的是**空格**，故必须用 `\b` 收尾（写成 `\s` 会一个都匹配不到）。 */
function parseStdRows(tbodyHtml) {
  const rows = [];
  for (const rm of String(tbodyHtml || '').matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)) {
    const kind = (/\bdata-kind="([^"]*)"/.exec(rm[1]) || [])[1] || '';
    const tds = [...rm[2].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map(td => ({
      cls: (/\bclass="([^"]*)"/.exec(td[1]) || [])[1] || '',
      edit: (/\bdata-edit="([^"]*)"/.exec(td[1]) || [])[1] || '',
      text: td[2]
    }));
    rows.push({ kind, tds });
  }
  return rows;
}

/** 某一行里 `data-edit` 为给定值的单元格；取不到返回 null */
function stdCell(rows, kind, edit) {
  const row = rows.find(r => r.kind === kind);
  if (!row) return null;
  return row.tds.find(td => td.edit === edit) || null;
}

/** 某一行里的「典型值」单元格（V1.35 第 2 格：检测参数 / **典型值** / 上偏差 / 下偏差 / 上限·下限（导出））；
 *  取不到返回 null。V1.33 的旧列序（检测参数 / 上限 / 下限 / 典型值）已随 C-90 改对象作废。 */
function typicalCell(rows, kind) {
  const row = rows.find(r => r.kind === kind);
  return row ? (row.tds[1] || null) : null;
}

/** 某一行里的「只读导出值」单元格（V1.35 第 5 格 `.std-derived`）；取不到返回 null */
function derivedCell(rows, kind) {
  const row = rows.find(r => r.kind === kind);
  return row ? (row.tds[4] || null) : null;
}

/** 从 `.std-derived` 单元格文本里取 `上限 5.30 · 下限 4.80` 的上下限数值；缺项/占位（—）返回 null。
 *  ⚠️ 判据是**文本里两个数的相对位置**（上限在前、下限在后），不硬编码 5.30 / 4.80。
 *  @param {string} snippet 单元格 HTML 片段
 *  @param {number} digits 配置的小数位数（standards.digits）
 *  @returns {{upper:number, lower:number}|null} 解析失败（含占位 `—`）返回 null ⇒ 断言随之变红 */
function derivedLimits(snippet, digits) {
  const t = String(snippet || '').replace(/<[^>]*>/g, '');
  const m = /上限\s*(-?\d+(?:\.\d+)?)\s*·\s*下限\s*(-?\d+(?:\.\d+)?)/.exec(t);
  if (!m) return null;
  const okRe = v => new RegExp(`^-?\\d+\\.\\d{${digits}}$`).test(v);
  return (okRe(m[1]) && okRe(m[2])) ? { upper: Number(m[1]), lower: Number(m[2]) } : null;
}

/** 五列口径下每个 `.std-num` 单元格的稳定取法：`editTypeOf(td)` 同时校验 `data-edit` 与冻结类名。
 *  `data-edit` ＝ `<kind><Typical|UpperDev|LowerDev>`（与 DR-03 字段同名，见 TaskPanel.js 的 FIELDS）。 */
const STD_EDIT_TYPES = ['Typical', 'UpperDev', 'LowerDev'];

/** 从形如 `<span class="std-value">12.80</span>` 的片段里取出**非负**数值（不合口径返回 null）。
 *  典型值格是"非负绝对量、不带符号"，故对它用本函数；上/下偏差格**带符号**，用 `signedValueOf()`。 */
function valueOf(snippet, digits) {
  const m = /<span class="std-value">(\d+(?:\.\d+)?)<\/span>/.exec(String(snippet || ''));
  if (!m) return null;
  return new RegExp(`^\\d+\\.\\d{${digits}}$`).test(m[1]) ? Number(m[1]) : null;
}

/** 从形如 `<span class="std-value">+0.30</span>` / `-0.20` 的片段里取出**带符号**数值
 *  （小数位数须等于配置的 `digits`；不合口径返回 null ⇒ 断言随之变红）。 */
function signedValueOf(snippet, digits) {
  const m = /<span class="std-value">([+-]?\d+(?:\.\d+)?)<\/span>/.exec(String(snippet || ''));
  if (!m) return null;
  return new RegExp(`^[+-]?\\d+\\.\\d{${digits}}$`).test(m[1]) ? Number(m[1]) : null;
}

/** 单元格里的单位文本（`<span class="std-unit"> m/s</span>` → 'm/s'） */
function unitOf(snippet) {
  const m = /<span class="std-unit">([^<]*)<\/span>/.exec(String(snippet || ''));
  return m ? m[1].trim() : null;
}

/** 单元格里的典型值数字（`12.50<span class="std-unit">…` → 12.5；也接受含 `<td class="std-typical mono">` 的整格片段） */
function typicalOf(snippet, digits) {
  const m = /(?:<td[^>]*class="[^"]*std-typical[^"]*"[^>]*>)?\s*(-?\d+(?:\.\d+)?)\s*(?:<|$)/.exec(String(snippet || ''));
  if (!m) return null;
  return new RegExp(`^-?\\d+\\.\\d{${digits}}$`).test(m[1]) ? Number(m[1]) : null;
}

/** 单元格里的偏差文本（`上偏差 +0.30 · 下偏差 -0.20` → '+0.30' / '-0.20'） */
function devOf(snippet, label) {
  const m = new RegExp(label + '\\s*([+-]\\d+(?:\\.\\d+)?)').exec(String(snippet || ''));
  return m ? m[1] : null;
}

/** 取 CSS 里**定义了某属性**、且选择器含某标记的规则中最后一条（`parseCss` 按"后写覆盖先写"的次序入 Map，
 *  故"最后一条"正是层叠里胜出的那条）；找不到返回 {}。用于**逐冻结选择器**读实际生效字号：
 *  `.std-limits.compact .std-num.std-upperdev .std-value` 与 `.std-lowerdev` 是**合并选择器**（逗号并列），
 *  整串查不到，只能按标记定位；而"含标记"的规则可能只有 color（
 *  `.std-limits .std-num.std-typical, … .std-upperdev, … .std-lowerdev { color: … }`），
 *  故必须同时要求它**声明了该属性**，否则会读到那条 color 规则 ⇒ 字号恒为 null（实测踩过）。 */
function lastRuleWith(rules, marker, prop) {
  let hit = {};
  for (const [sel, decls] of rules) {
    if (sel.includes(marker) && (!prop || decls[prop] !== undefined)) hit = decls;
  }
  return hit;
}

/** V1.35 的 `.std-value` 里**带正负号**的偏差文本（`+0.30` / `-0.20`）；典型值格是"非负绝对量、不带符号"，
 *  故对它应返回 null —— 用它把"典型值格不写符号"变成可证伪观察（不是"看过就算"）。 */
function devTxtOf(snippet) {
  const m = /(?:^|>)\s*([+-]\d+(?:\.\d+)?)\s*(?:<|$)/.exec(String(snippet || ''));
  return m ? m[1] : null;
}

/** 把 `.std-num` / `.std-name` 单元格文本压成可比较的规整串 */
const stdCellText = td => (td ? String(td.text).replace(/<[^>]*>/g, '').replace(/\s+/g, '') : '');

/** 取 `<th>…</th>` 的表头文字数组 */
const thOf = seg => [...String(seg || '').matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
  .map(m => m[1].replace(/<[^>]*>/g, '').trim());

async function main() {
  const cssVars = readText('src/styles/variables.css');
  const cssGlobal = readText('src/styles/global.css');
  const rules = parseCss(cssVars + '\n' + cssGlobal);
  const html = readText('index.html');

  /* ===== U1 布局与视觉规范（UI-01 / UI-02 / UI-03 / UI-04） ===== */
  section('U1 布局与视觉规范（UI-01/02/03/04）');
  {
    const rows = pxValues(rules, '#stage', 'grid-template-rows');
    const designH = 2160;
    const headerPct = rows.length ? (rows[0] / designH) * 100 : null;
    const footerPct = rows.length ? (rows[rows.length - 1] / designH) * 100 : null;
    check(
      'UI-01 顶部固定头部区占屏高 10%～12%',
      headerPct !== null && headerPct >= 10 && headerPct <= 12,
      `#stage 首行 ${rows[0]}px / 2160px = ${headerPct === null ? '—' : headerPct.toFixed(2)}%`
    );
    check(
      'UI-01 底部标签栏占屏高约 8%（±1%）',
      footerPct !== null && Math.abs(footerPct - 8) <= 1,
      `#stage 末行 ${rows[2]}px / 2160px = ${footerPct === null ? '—' : footerPct.toFixed(2)}%`
    );

    const stage = rules.get('#stage') || {};
    check(
      'UI-02 4K 舞台为固定 3840×2160 且以左上角为缩放原点',
      stage.width === '3840px' && stage.height === '2160px' && stage['transform-origin'] === 'top left',
      `width=${stage.width} height=${stage.height} transform-origin=${stage['transform-origin']}（等比缩放由 main.js fitStage 施加）`
    );

    const varDecls = parseCss(cssVars).get(':root') || {};
    const wrong = Object.entries(UI03).filter(([k, v]) => String(varDecls[k] || '').toUpperCase() !== v);
    check(
      'UI-03 色彩规范（绿/黄/红/灰/背景）与 variables.css 变量一致',
      wrong.length === 0,
      wrong.map(([k, v]) => `${k} 应为 ${v}，实际 ${varDecls[k] || '未定义'}`).join('；')
    );

    for (const item of UI04) {
      if (item.selector) {
        const px = fontPx(rules, item.selector);
        check(
          `UI-04 字号：${item.role} ≥ ${item.min}px`,
          px !== null && px >= item.min,
          `${item.selector} = ${px === null ? '未定义' : px + 'px'}（规范要求 ≥${item.min}px）`
        );
      } else {
        const measured = HELPER_SELECTORS.map(s => ({ s, px: fontPx(rules, s) }));
        const known = measured.filter(x => x.px !== null);
        const min = known.reduce((a, b) => (b.px < a.px ? b : a), known[0]);
        check(
          `UI-04 字号：${item.role} ≥ ${item.min}px`,
          known.length > 0 && known.every(x => x.px >= item.min),
          known.filter(x => x.px < item.min).map(x => `${x.s} = ${x.px}px`).join('；') || '全部达标'
        );
        if (min && min.px < item.min) {
          console.log(`        最小者：${min.s} = ${min.px}px`);
        }
      }
    }
  }

  /* ===== U2 需求条款覆盖（用假 DOM 跑真实渲染） ===== */
  section('U2 需求条款覆盖（FR-1 / FR-3 / FR-4 / FR-9）');
  const ui = loadUi([
    'src/components/HeaderBar.js',
    'src/components/TabsBar.js',
    'src/components/CurveChart.js',
    'src/components/DeviceStatusPanel.js',
    'src/components/TaskPanel.js',
    'src/components/ShiftPanel.js',
    'src/components/StatsPanel.js',
    'src/components/AlarmPanel.js',
    'src/components/MaintPanel.js',
    'src/components/NoticePanel.js',
    'src/components/SettingPanel.js',
    'src/pages/Dashboard.js'
  ]);
  const W = ui.w;
  const state = JSON.parse(JSON.stringify(W.MockData.state));
  W.MockData.tick(new Date('2026-09-18T14:00:00'));

  {
    /* FR-1：头部十项 */
    ui.out.length = 0;
    W.Components.HeaderBar.render(W.MockData.state);
    const fr1 = [
      ['FR-1.1 设备全称', 'hdrDeviceName'],
      ['FR-1.2 设备编号', 'hdrDeviceCode'],
      ['FR-1.3 日期', 'hdrDate'],
      ['FR-1.4 星期', 'hdrWeek'],
      ['FR-1.5 时分秒', 'hdrClock'],
      ['FR-1.6 所属班组', 'hdrTeam'],
      ['FR-1.7 在岗操作员', 'hdrOperator'],
      ['FR-1.8 班组长', 'hdrLeader'],
      ['FR-1.9 当前班次', 'hdrShift'],
      ['FR-1.10 班次起止', 'hdrShiftTime']
    ];
    const missing = fr1.filter(([, id]) => {
      const v = lastText(ui.out, id);
      return v === null || v === '' || v === 'undefined';
    });
    check(
      'FR-1.1～1.10 头部十项均渲染出非空值',
      missing.length === 0,
      missing.map(([n, id]) => `${n}(${id})`).join('；')
    );
    check(
      'FR-1 十项对应的元素 id 都存在于 index.html',
      fr1.every(([, id]) => html.includes(`id="${id}"`)),
      fr1.filter(([, id]) => !html.includes(`id="${id}"`)).map(([n, id]) => `${n}(${id})`).join('；')
    );
    check(
      'FR-1.5 时间为秒级（HH:MM:SS）',
      /^\d{2}:\d{2}:\d{2}$/.test(String(lastText(ui.out, 'hdrClock'))),
      `hdrClock = ${lastText(ui.out, 'hdrClock')}`
    );
  }

  {
    /* FR-3：工单信息 8 项、数值格式、进度与结果 */
    ui.out.length = 0;
    W.Components.TaskPanel.render(W.MockData.state);
    const orderHtml = lastHtml(ui.out, 'tkOrderList') || '';
    const orderRows = (orderHtml.match(/class="kv-row"/g) || []).length;
    check('FR-3.1～3.4 当前工单信息渲染 8 项', orderRows === 8, `实际 ${orderRows} 行`);

    const fmt = [
      ['UI-08 航行器深度 2 位小数', 'tkDepth', /^\d+\.\d{2}$/],
      ['UI-08 航行速度 2 位小数', 'tkSpeed', /^\d+\.\d{2}$/],
      ['UI-08 水平速度 2 位小数', 'tkVx', /^\d+\.\d{2}$/],
      ['UI-08 垂直速度 2 位小数', 'tkVy', /^\d+\.\d{2}$/]
    ];
    const badFmt = fmt.filter(([, id, re]) => !re.test(String(lastText(ui.out, id))));
    check('UI-08 深度与速度数值格式统一', badFmt.length === 0,
      badFmt.map(([n, id]) => `${n}: ${lastText(ui.out, id)}`).join('；'));

    const table = lastHtml(ui.out, 'tkCompareTable tbody') || '';
    const theadTh = ((html.match(/id="tkCompareTable"[\s\S]*?<thead><tr>([\s\S]*?)<\/tr>/) || [])[1] || '').match(/<th>/g) || [];
    const bodyTd = (table.match(/<td/g) || []).length / Math.max(1, (table.match(/<tr>/g) || []).length);
    check(
      '表格列数：设备参数对比表 thead 列数 = 行内 td 数',
      theadTh.length > 0 && bodyTd === theadTh.length,
      `thead ${theadTh.length} 列，tbody 每行 ${bodyTd} 个 td`
    );
  }

  {
    /* FR-4：统计 15 项 + 需求口径 */
    const ids = [...html.matchAll(/id="(s[A-Z]\w*)"/g)].map(m => m[1]);
    check('FR-4.1～4.15 生产统计页渲染 15 个指标', ids.length === 15, `index.html 中 s* 指标 id 共 ${ids.length} 个`);
    ui.out.length = 0;
    W.Components.StatsPanel.render(W.MockData.state);
    const notWritten = ids.filter(id => lastText(ui.out, id) === null);
    check('FR-4 15 个指标全部由 StatsPanel 写入', notWritten.length === 0, notWritten.join('、'));

    const st = W.MockData.state.stats;
    const atNormal = { plan: st.plan, started: st.started, notStarted: st.notStarted };
    W.MockData.tick(new Date('2026-09-18T15:59:59'));   // 班末边界
    const stEnd = W.MockData.state.stats;
    check(
      'FR-4.2/4.3 实际开工数不得超过计划总数（未开工 = 计划 − 开工）',
      atNormal.started <= atNormal.plan && stEnd.started <= stEnd.plan,
      `班中 plan=${atNormal.plan} started=${atNormal.started}；班末 plan=${stEnd.plan} started=${stEnd.started}（未开工 ${stEnd.notStarted}）`
    );
  }

  {
    /* FR-2：5 种运行模式、运行时长格式、四者映射配置化 */
    ui.out.length = 0;
    W.Components.DeviceStatusPanel.render(W.MockData.state);
    const legend = lastHtml(ui.out, 'stLegend') || '';
    const legendCount = (legend.match(/class="legend-item/g) || []).length;
    check('FR-2.1 设备状态页列出 5 种运行模式色标', legendCount === 5, `实际 ${legendCount} 项`);
    check('FR-2.3 实时运行时长为 HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test(String(lastText(ui.out, 'stRunTime'))),
      `stRunTime = ${lastText(ui.out, 'stRunTime')}`);
    check('FR-2.5 运行阶段取值属于 准备/运行/判定/完成', ['准备', '运行', '判定', '完成'].includes(String(lastText(ui.out, 'stStage'))),
      `stStage = ${lastText(ui.out, 'stStage')}`);

    const modes = [...legend.matchAll(/<\/span>([^<]+)<\/div>/g)].map(m => m[1]);   // 图例里的模式名
    const modeToStatus = W.FieldMap.modeToTestStatus;
    const unmapped = modes.filter(m => modeToStatus[m] === undefined);
    check('FR-2.8 运行模式 ↔ 上报 testStatus 映射覆盖全部模式', modes.length > 0 && unmapped.length === 0,
      `未覆盖：${unmapped.join('、')}`);

    /* D1（V1.37 / C-98）：码 `2` 的**界面显示**为「正常停机」，而「维保检修」**无对应状态码**
       （来源为本机维保状态）—— 两者在状态面板里同为灰（`--idle`，UI-03）。
       判据取自**渲染出来的图例**（逐项取"节点 → 色标变量"），故把它变成可证伪观察：
       改文案、改配色、把某一项并到别的色标上，这里都会红，而不是"看一眼源码就算数"。 */
    const legendPairs = [...legend.matchAll(/class="legend-dot" style="background:([^"]+)"><\/span>([^<]+)<\/div>/g)]
      .map(m => ({ color: m[1], name: m[2] }));
    const legendColor = new Map(legendPairs.map(p => [p.name, p.color]));
    const idleHex = (parseCss(cssVars).get(':root') || {})['--idle'];
    check('FR-2.1/FR-2.2/D1 图例五模式的色标一一对应，且「正常停机」（码 2 的显示模式）与「维保检修」（无对应码）同为灰 ' +
      `（--idle＝${UI03['--idle']}）`,
      legendPairs.length === 5 &&
      legendColor.get('待机') === 'var(--warn)' && legendColor.get('测试运行') === 'var(--ok)' &&
      legendColor.get('正常停机') === 'var(--idle)' && legendColor.get('维保检修') === 'var(--idle)' &&
      legendColor.get('故障锁定') === 'var(--err)' &&
      String(idleHex || '').toUpperCase() === UI03['--idle'],
      `图例实测 ${legendPairs.map(p => `${p.name}=${p.color}`).join('、')}；--idle=${idleHex}` +
      '（待机=黄/测试运行=绿/正常停机·维保检修=灰/故障锁定=红）');
  }

  {
    /* FR-3.14 / FR-3.16（V1.33 改判）：原判据是"设备参数对比表里帧率超标、增益临近"——
       V1.33 把相机参数移出任务数据页主体（改由二级菜单只含参数名+设定值），
       这条判据的载体（`#tkCompareTable` 的实测值/偏差/状态列）**已被移走**，故按新口径改判：

         FR-3.14 的判定对象＝**深度与速度的测试标准值**，三态（正常/临近/超范围）**只用于**深度与速度；
         相机参数**不做判定** —— 于是新的可证伪判据分两半：
           ① 满足必要条件：`#tkStdTable` 里深度/速度两行**都带**三态列（`std-state`），不是"没判"而是"判了"；
           ② 相机参数不判定：**同一份** state 下把相机四项实测值推成荒诞离群值（帧率 ×3、增益 ×50、
              设定深度 ±5 m），相机二级菜单的渲染结果与状态**逐字不变**（判定/状态不在本看板职责范围），
              且整块相机菜单 HTML 里**不出现任何三态字面量**。 */
    const s = JSON.parse(JSON.stringify(W.MockData.state));
    const std0 = W.Format.round2;
    s.task.real.depth = std0(s.task.std.depth + 0.05);
    s.task.real.speed = std0(s.task.std.speed + 0.05);
    ui.out.length = 0;
    W.Components.TaskPanel.render(s);
    const stdTbody = lastHtml(ui.out, 'tkStdTable tbody') || '';
    const camA = lastHtml(ui.out, 'tkCompareTable tbody') || '';
    check(
      'FR-3.14/FR-3.18 三态判定只用于深度与速度：#tkStdTable 的深度/速度两行都渲染出三态列（std-state）',
      (stdTbody.match(/class="std-state (?:ok|warn|err|idle)"/g) || []).length === 2,
      `std-state 命中 ${(stdTbody.match(/class="std-state (?:ok|warn|err|idle)"/g) || []).length} 处（应为 2：深度 1 + 速度 1）`
    );

    /* 相机四项推成离群值：二级菜单必须逐字不变，且不含任何三态字面量 */
    s.task.real.fps = s.task.std.fps * 3;
    s.task.real.gain = s.task.std.gain * 50;
    s.task.real.cameraDepth = s.task.std.depth + 5;
    s.task.real.shutter = s.task.std.shutter * 4;
    ui.out.length = 0;
    W.Components.TaskPanel.render(s);
    const camB = lastHtml(ui.out, 'tkCompareTable tbody') || '';
    check(
      'FR-3.14/FR-3.16 相机参数不做判定：四项实测值推成离群值后二级菜单渲染逐字不变、且无三态字面量',
      camA.length > 0 && camB === camA && !/正常|临近|超范围|超标/.test(camB),
      `渲染前 ${camA.length} 字 / 渲染后 ${camB.length} 字，${camB === camA ? '逐字一致' : '**发生变化**'}；` +
      `三态字面量=${/正常|临近|超范围|超标/.test(camB) ? '有（违反 FR-3.14 只判深度/速度）' : '无'}`
    );
  }

  {
    /* FR-9：8 个标签页 */
    const tabs = W.Pages.Dashboard.TABS;
    const panelOk = tabs.length === 8 && tabs.every(t => html.includes(`id="${t.id}"`));
    check('FR-9.1 8 个标签页与 index.html 的 8 个面板一一对应', panelOk, `TABS=${tabs.length} 个：${tabs.map(t => t.id).join(', ')}`);
  }

  {
    /* FR-3.13 五态可达性：跑一整个班次，看单任务结果能出现哪几态 */
    const seen = new Set();
    const M = W.MockData;
    const base = new Date('2026-09-18T08:00:00').getTime();
    for (let t = 0; t <= 8 * 3600; t += 5) {
      M.tick(new Date(base + t * 1000));
      seen.add(M.state.task.result);
    }
    const expect = ['待测试', '测试中', '合格', '不合格', '待复检'];
    const absent = expect.filter(x => !seen.has(x));
    check(
      'FR-3.13 单任务五态在模拟数据中可达',
      absent.length === 0,
      `一个班次内 state.task.result 只出现：${[...seen].join(' / ')}；缺 ${absent.join('、')}`
    );
  }

  /* ===== U3 空态（UI-11 / FR-3.17） ===== */
  section('U3 空态设计（UI-11 / FR-3.17）');
  {
    ui.out.length = 0;
    W.Components.NoticePanel.render({ notices: { notices: [], tips: [], todo: [] } });
    const noticeHtml = (lastHtml(ui.out, 'ntNoticeList') || '') + (lastHtml(ui.out, 'ntTipList') || '') + (lastHtml(ui.out, 'ntTodoList') || '');
    check(
      'UI-11 无公告/无提示/无待办时应给出占位文案',
      noticeHtml.trim().length > 0,
      '三个列表在空数据下都渲染为空字符串，页面上是大片空白'
    );
  }
  {
    ui.out.length = 0;
    let err = null;
    const emptyTask = { task: {}, stats: {}, status: {} };
    try {
      W.Components.TaskPanel.render(emptyTask);
    } catch (e) {
      err = e;
    }
    check(
      'FR-3.17 无在测工单时应显示「等待工单」空态且不抛异常',
      err === null && /等待工单/.test(String(lastHtml(ui.out, 'tkProgressText') || '')),
      err ? `渲染抛异常：${err.message}` : '未找到「等待工单」占位文案'
    );
  }
  {
    ui.out.length = 0;
    W.Components.AlarmPanel.render({ alarm: { active: null, ledger: [] }, warnings: [] });
    const t = String(lastText(ui.out, 'alType') || '');
    check('UI-11 无故障时故障卡显示占位文案', /无故障|正常/.test(t), `alType = ${JSON.stringify(t)}`);
  }

  /* ===== U3b 报警/维保面板的**有内容**渲染（FR-5.1～5.4 / FR-6.x / UI-06）
     立案原因（R-2026-09-19-02 的 P2-9～12）：这 9 条条款此前都挂在"15 个指标由 StatsPanel 写入"
     或"无故障占位文案"上 —— 前者与维保台账/进度条无关，后者断言的是**反面**。
     故在此补真实断言（有故障、有台账），再把追溯表的证据指向它们。 ===== */
  section('U3b 报警与维保面板的有内容渲染（FR-5.1～5.4 / FR-6.1～6.10 / UI-06/07）');
  {
    /* 有故障时：报警卡必须给出编号、类型、描述、故障字典与闭环状态（FR-5.1～5.4） */
    ui.out.length = 0;
    const activeAlarm = {
      code: 'AL-2026-0919-01', type: '上位机断连', level: '严重',
      desc: '与设备上位机通信中断超过 5 s', state: '未处理',
      time: '2026-09-19 09:00:00', action: '检查网线并重启上位机'
    };
    W.Components.AlarmPanel.render({
      alarm: {
        active: activeAlarm, queue: [activeAlarm],
        ledger: [{ time: '2026-09-19 09:00:00', code: activeAlarm.code, desc: activeAlarm.desc, state: '未处理' }]
      },
      warnings: []
    });
    const alCode = String(lastText(ui.out, 'alCode') || '');
    const alType = String(lastText(ui.out, 'alType') || '');
    const alDetail = String(lastHtml(ui.out, 'alDetail') || '');
    const alState = String(lastText(ui.out, 'alState') || '');
    check('FR-5.1 报警卡显示报警编号与类型（有故障时不再显示占位）',
      alCode === activeAlarm.code && alType === activeAlarm.type,
      `alCode=${JSON.stringify(alCode)} alType=${JSON.stringify(alType)}`);
    check('FR-5.2/FR-5.3 报警卡给出故障描述与处理信息（发生时间/等级/处理人/处理措施）',
      alDetail.includes(activeAlarm.desc) && alDetail.includes('故障发生时间') &&
      alDetail.includes('等级') && alDetail.includes('处理措施') && alDetail.includes(activeAlarm.action),
      `alDetail 长度 ${alDetail.length}`);
    check('FR-5.4 报警卡显示闭环状态（未处理时应如实呈现）',
      /闭环状态：未处理/.test(alState), `alState=${JSON.stringify(alState)}`);
    check('FR-5.6 多条并发报警时排队说明与队列列表都渲染（不覆盖、不丢失）',
      (() => {
        ui.out.length = 0;
        const q = [
          activeAlarm,
          { code: 'A2', type: 't2', level: '一般', desc: 'd2', state: '未处理', time: '09:01' },
          { code: 'A3', type: 't3', level: '提示', desc: 'd3', state: '已闭环', time: '09:02' }
        ];
        W.Components.AlarmPanel.render({ alarm: { active: activeAlarm, queue: q, ledger: [] }, warnings: [] });
        const note = String(lastText(ui.out, 'alQueueNote') || '');
        const list = String(lastHtml(ui.out, 'alQueueList') || '');
        return /3 条未闭环/.test(note) && list.includes('A2') && list.includes('A3');
      })(), '队首留卡片、其余两条进队列列表');
    /* V1.34（C-88）改判：预警区夹具原用「帧率接近上限 / 当前 950/1000 fps」——
       那是**相机参数**驱动的旧口径；C-88 明确参数类预警的判定对象＝**深度与速度的
       测试标准上下限**、**相机参数不参与**，且参数类为**两条具名**。夹具与判据随之改判
       （断言名保留 `FR-5.8～5.11 预防性预警区按字典渲染标题与详情` 前缀不变 ——
       `trace-check` 把它当**逐字证据**），核对项由 2 项增至 7 项（只增不减）。 */
    check('FR-5.8～5.11 预防性预警区按字典渲染标题与详情（判定对象＝深度与速度的标准上下限，相机参数不参与）',
      (() => {
        ui.out.length = 0;
        W.Components.AlarmPanel.render({
          alarm: { active: null, queue: [], ledger: [] },
          warnings: [
            { lv: 'warn', title: '参数阈值临近预警', detail: '深度 5.20 m（标准 4.80～5.30 m）判临近' },
            { lv: 'err', title: '参数超范围预警', detail: '速度 8.40 m/s（标准 3.00～8.00 m/s）判超范围' },
            { lv: 'ok', title: '设备维保到期预警', detail: '距计划维保还有 9 天' }
          ]
        });
        const list = String(lastHtml(ui.out, 'alWarningList') || '');
        return list.includes('参数阈值临近预警') && list.includes('深度 5.20 m') &&
          list.includes('参数超范围预警') && list.includes('速度 8.40 m/s') &&
          list.includes('设备维保到期预警') &&
          list.includes('lv-warn') && list.includes('lv-err');
      })(), '参数类两条具名（黄 lv-warn / 红 lv-err）+ 维保类按字典逐条渲染标题与详情');
    /* V1.34（C-88）新增：参数类预警的**名称与条数口径**（不是渲染，而是读 mockData 的实算产物）。
       判据五条，逐条可证伪（下面前 4 条均做过定点变异反证，见本轮报告）：
       ① 参数类**最多 2 条**（一个参数最多一条：深度/速度各按最坏态择名）⇒ 造第 3 条即红；
       ② 参数类**不得出现第三个名字**（把标题改成任何别的"参数…"名即红）；
       ③ **相机参数不参与判定**：任何预警标题里都不得出现帧率/增益/快门/相机
          ⇒ 把参数类预警换回旧口径的「帧率接近上限」即红（**这一条专治"只看名字前缀"的漏网**：
          旧判据按 `includes('参数')` 过滤，相机参数名根本进不了集合，会静默放行）；
       ④ 名称与等级色一一对应（「参数超范围预警」⇔ lv='err'；「参数阈值临近预警」⇔ lv≠'err'，
          含标准已设定但两参数都正常时的 ok 回执条）⇒ "名字对了色错了"即红；
       ⑤ 每条都有非空 detail（不得用空详情的占位名充数）。 */
    check('FR-5.8 参数类预警为两条具名（参数阈值临近预警 / 参数超范围预警）且至多 2 条、名称与等级色一一对应、相机参数不参与（无相机参数类预警名）',
      (() => {
        const PARAM_TITLES = ['参数阈值临近预警', '参数超范围预警'];
        const CAMERA_WORDS = ['帧率', '增益', '快门', '相机'];
        const all = W.MockData.state.warnings || [];
        const param = all.filter(w => PARAM_TITLES.includes(w.title));
        const stray = all.filter(w => String(w.title).includes('参数') && !PARAM_TITLES.includes(w.title));
        return param.length <= 2 &&
          stray.length === 0 &&
          all.every(w => !CAMERA_WORDS.some(k => String(w.title).includes(k))) &&
          param.every(w => (w.title === '参数超范围预警') === (w.lv === 'err')) &&
          param.every(w => typeof w.detail === 'string' && w.detail.length > 0);
      })(),
      `实算预警 ${(W.MockData.state.warnings || []).map(w => `${w.title}/${w.lv}`).join('、') || '（0 条：标准未设定）'}`);

    /* V1.34（C-88）新增（ADR-0004 D22 定点变异 A 的补钉）：上一条判据读的是**当时碰巧的**
       `state.warnings` —— 实测随机游走常落在"两参数都正常 / 只有临近"的帧上，于是
       **变异 A**（把 mockData 的『参数超范围预警』整名改成『参数阈值临近预警』，即让 err 顶着临近名）
       下**改动前**的 ui-check 90/0、copy-check 28/0 **全绿** —— 名称与等级色的对应关系没有任何断言真正判过。
       本条**先把 err 级参数类预警真正构造出来再判**，构造只写**运行时真源** `state.task.standard`
       （FR-3.19 现场录入的标准行；`mockData.standardSpecOf` 优先读它，故下一帧 tick 即按新标准重算；
       **不碰源码、不碰配置**）：
         · 深度标准取在**量程下沿**（typical = `standards.range.depth.min` + 3 格、上下偏差 ±1 格
           ⇒ 上下限 4.02～4.04 m，仍落在量程 [4, 6] 内、是合法可录入的行），而演示深度游走区间是
           [4.77, 5.33]（mockData 头部口径）⇒ **深度几乎每帧都判超范围（err）**；
         · 速度不写标准行 ⇒ 按 mockData 的回退口径取 `standards.default.speed`（4.80～5.20），
           其态随游走变化；循环 tick（上限 2000 帧）直到同一帧里**同时**出现 err 与 warn 两条参数类
           预警（实测 200 次独立试验的命中帧 ≤ 82，故上限留了 20 倍余量；真到不了即判红，不静默放过）。
       判据四条，全部落在**该帧的真实实算产物**上：
         ① 确实存在 err 级参数类预警（否则本条形同虚设 —— 这正是旧判据漏掉变异 A 的原因）；
         ② 名称 ⇔ 等级色一一对应：「参数超范围预警」⇔ lv='err'、「参数阈值临近预警」⇔ lv≠'err'；
         ③ 参数类预警的**名称集合恰为这两条具名**（既不得缺、也不得冒出第三个"参数…"名）；
         ④ 参数类恰 2 条（一个参数一条：深度 err + 速度 warn）。
       参数类的识别口径＝**buildWarnings 的建表顺序**（参数类在前、其后固定 3 条：维保/耗材/工单），
       故 `warnings.slice(0, 长度−3)` 恒为参数类 —— **不拿被测的名称当筛子**（否则改名后连"哪条是
       参数类"都判不出，判据会退化成对着自己的输入打转）。 */
    {
      const M = W.MockData;
      const PARAM_TITLES = ['参数阈值临近预警', '参数超范围预警'];
      const NON_PARAM = 3;                        // 参数类之后固定三条：维保 / 耗材 / 工单
      const STD = W.BoardConfig.standards || {};
      const RANGE_DEPTH = (STD.range || {}).depth || {};
      const grid = 1 / Math.pow(10, STD.digits);   // 显示精度一格（两位小数 ⇒ 0.01 m）
      const savedStandard = M.state.task.standard;
      const obs = { frames: 0, errFrames: 0, hit: null, pairs: [], titles: [], bad: [], stray: [] };
      let buildErr = null;
      try {
        M.state.task.standard = {
          depth: { unit: 'm', digits: STD.digits,
                   typical: RANGE_DEPTH.min + 3 * grid, upperDev: grid, lowerDev: -grid }
        };
        const base = new Date('2026-09-18T15:30:00').getTime();
        for (let i = 0; i < 2000 && obs.hit === null; i++) {
          M.tick(new Date(base + i * 1000));
          obs.frames++;
          const all = M.state.warnings || [];
          const param = all.slice(0, Math.max(0, all.length - NON_PARAM));
          if (param.some(w => w.lv === 'err')) obs.errFrames++;
          if (param.some(w => w.lv === 'err') && param.some(w => w.lv === 'warn')) {
            obs.hit = i;
            obs.pairs = param.map(w => `${w.title}/${w.lv}`);
            obs.titles = param.map(w => w.title);
            obs.bad = param.filter(w => (w.title === '参数超范围预警') !== (w.lv === 'err'));
            obs.stray = param.filter(w => !PARAM_TITLES.includes(w.title));
          }
        }
      } catch (e) {
        buildErr = e;
      } finally {
        M.state.task.standard = savedStandard;    // 还原运行时真源，后面的用例不受影响
      }
      check(
        'FR-5.8/C-88 名称与等级色一一对应（在**确实存在 err 级参数类预警**的状态下判定，非源码字符串搜索）：深度越标准上限 ⇒「参数超范围预警」/err、速度落临近带 ⇒「参数阈值临近预警」/warn，参数类名称集合恰为这两条具名',
        buildErr === null && obs.hit !== null && obs.errFrames > 0 &&
        obs.bad.length === 0 && obs.stray.length === 0 &&
        obs.titles.length === 2 && PARAM_TITLES.every(n => obs.titles.includes(n)),
        buildErr ? `构造/判定异常：${buildErr.message}`
          : `构造的深度标准＝量程下沿 ${RANGE_DEPTH.min + 3 * grid}±${grid}（上下限 ` +
            `${(RANGE_DEPTH.min + 2 * grid).toFixed(STD.digits)}～${(RANGE_DEPTH.min + 4 * grid).toFixed(STD.digits)} m，` +
            `在量程 [${RANGE_DEPTH.min}, ${RANGE_DEPTH.max}] 内）；扫 ${obs.frames} 帧、其中 ${obs.errFrames} 帧含 err 级参数类预警；` +
            (obs.hit === null
              ? '**2000 帧内从未出现"err 与 warn 同时存在"的参数类帧**（构造前提不成立，判据无从成立）'
              : `命中帧参数类名称/等级色＝[${obs.pairs.join('、')}]；名称集合=${JSON.stringify(obs.titles)}` +
                `（应恰为 ${JSON.stringify(PARAM_TITLES)}）` +
                (obs.bad.length ? `；**名称与等级色不符**：${obs.bad.map(w => `${w.title}/${w.lv}`).join('、')}` : '') +
                (obs.stray.length ? `；**冒出第三个参数类名字**：${obs.stray.map(w => w.title).join('、')}` : ''))
      );
    }

    /* V1.37（R26-P2-2 处置 · 负责人 2026-09-27 裁定正确侧＝「拆分（改实现）」）新增：
       **同态 ⇒ 2 条**的定向断言（只增不减，上面两条一字未改）。
       立案：第三轮审查 R-2026-09-26-01 的 P2-2 —— `buildParamWarnings()` 旧实现按态
       `groups.find(x => x.lv === r.lv.lv)` 把**同态**（深度与速度**同为 err** 或**同为 warn**）的两参数
       **合并成一条**（detail 以「；」拼接），与三处声明矛盾：本文件（mockData.js）头部 `:16-18`
       「互不合并 ⇒ 参数类最多 2 条」、docblock `:350-355`「深度与速度分别成条，一条预警里只含一个参数」、
       `config/board.config.js:167-169`「一个参数＝一条预警，深度与速度各自独立成条」。而上面那条 C-88
       判据与 `:1243` 的渲染夹具**都只停在混态**（深度 err + 速度 warn）⇒ 同态形态从无断言，门禁全绿而
       缺陷在（这正是 P2-2「静态证实、行为未复跑」的由来）。本组五条判据：
         ① 同态 err ⇒ 参数类**恰 2 条**、每条 detail **只含一个参数**且不得用「；」拼接两参数；
         ② 同态 warn ⇒ 同上（两条同名同类，各含一个参数）；
         ③ 混态回归：深度 warn ＋ 速度 err **仍恰 2 条**（不得因本次改动变成 1 条或 3 条）；
         ④ C-88 五判据（参数类 ≤2 / 无第三个名字 / 相机参数不参与 / 名称⇔等级色一一对应 / detail 非空）
            在**同态**新用例下同样成立；
         ⑤ 上界回归：参数类 ≤2 ⇒ `state.warnings` 合计 ≤5（同态时仍是 2 条、不是 4 条）。
       驱动方式：`buildParamWarnings()` **未导出**（public surface 只有 standardLevel/standardSpecOf），
       故按 C-88 既有口径走**真路径** —— 只写运行时真源 `state.task.standard`（FR-3.19 现场录入的标准行）
       与 `state.task.real`（FR-3.19 实测行），再由 `tick()` 触发重算；**不碰源码、不碰配置**。
       为什么必须"冻结游走"：深度/速度是随机游走，同态命中帧只能靠扫（上面那条 C-88 用例扫了 2000 帧才
       命中混态）⇒ 判据会随随机数时绿时红。这里把**上下文内的 `Math.random`** 顶成常量 0.5
       （宿主侧 `vm.runInContext('Math', W)` 取到的是同一份 Math 对象，见其返回值的可变性），步长恒 0
       ⇒ 实测值不再游走；再把 `real` 显式钉到演示初值（深度 5.00 m；vx 5.00 / vy 0.10 ⇒ 合成速度 5.00 m/s，
       与 mockData 头部「演示取值」口径一致），于是"标准怎么设、三态就怎么落"完全确定，
       同态两种形态各在**同一帧**稳定命中，不依赖任何随机数。
       失效保护：冻结没生效（或构造抛异常）⇒ 本组判红并明说冻结失效，**不静默退化成"碰巧命中"**；
       `finally` 里无条件还原 `Math.random` / `state.task.standard` / `state.task.real`，后续用例不受影响。 */
    {
      const M = W.MockData;
      const NON_PARAM = 3;                        // 参数类之后固定三条：维保 / 耗材 / 工单
      const PARAM_TITLES = ['参数阈值临近预警', '参数超范围预警'];
      const CAMERA_WORDS = ['帧率', '增益', '快门', '相机'];
      const PARAM_NAMES = ['深度', '速度'];
      const STD = W.BoardConfig.standards || {};
      const RANGE = STD.range || {};
      const grid = 1 / Math.pow(10, STD.digits);  // 显示精度一格（两位小数 ⇒ 0.01 m / 0.01 m/s）
      const unitOf = kind => (kind === 'depth' ? 'm' : 'm/s');
      /* 夹具标准（都落在各自量程内 ⇒ 是**合法可录入**的行，与 `:1317` 那条同一构造手法）：
         · err ：典型值＝量程下沿 + 3 格、偏差 ±1 格 ⇒ 导出上限 4.04 m / 3.04 m/s；
                 而实测被钉在 5.00 ⇒ 两参数**必然同为超范围**；
         · warn：典型值 4.70、偏差 ±0.40 ⇒ 标准带 [4.30, 5.10]、跨度 0.8 ⇒ 临近带宽 0.8×0.15 = 0.12
                 ⇒ 实测 5.00 ∈ [4.98, 5.10)（上侧临近带）⇒ 两参数**必然同为临近**。
         两套夹具在深度量程 [4,6] m 与速度量程 [3,8] m/s 之内（上偏差 ≥ 0 ≥ 下偏差）。 */
      const errSpec = kind => ({ unit: unitOf(kind), digits: STD.digits,
        typical: RANGE[kind].min + 3 * grid, upperDev: grid, lowerDev: -grid });
      const warnSpec = kind => ({ unit: unitOf(kind), digits: STD.digits,
        typical: 4.70, upperDev: 0.40, lowerDev: -0.40 });
      /* 参数类的识别口径与上面一致＝**buildWarnings 的建表顺序**（参数类在前，其后固定 3 条），
         不拿被测的名称当筛子，故改名/漏条都会被如实量到。 */
      const snap = () => {
        const all = M.state.warnings || [];
        const param = all.slice(0, Math.max(0, all.length - NON_PARAM));
        return {
          total: all.length, param,
          titles: param.map(w => w.title), lvs: param.map(w => w.lv),
          nameCounts: param.map(w => PARAM_NAMES.filter(n => String(w.detail).includes(n)).length),
          semi: param.map(w => String(w.detail).includes('；')),
          text: param.map(w => `${w.title}/${w.lv}：${w.detail}`).join(' ｜ ') || '（0 条）'
        };
      };
      /* "一条预警里只含一个参数"的机器口径：detail 恰含**一个**参数名，且不含拼接用的「；」 */
      const oneParamPerRow = s => s.param.length > 0 && s.param.every(w =>
        PARAM_NAMES.filter(n => String(w.detail).includes(n)).length === 1 &&
        !String(w.detail).includes('；'));
      /* C-88 五判据（与 `:1270` 那条同口径）：至多 2 条 / 无第三个名字 / 相机参数不参与 / 名色对应 / detail 非空 */
      const c88 = s => s.param.length <= 2 &&
        s.param.every(w => PARAM_TITLES.includes(w.title)) &&
        s.param.every(w => !CAMERA_WORDS.some(k => String(w.title).includes(k))) &&
        s.param.every(w => (w.title === '参数超范围预警') === (w.lv === 'err')) &&
        s.param.every(w => typeof w.detail === 'string' && w.detail.length > 0);
      const base = new Date('2026-09-18T16:30:00').getTime();
      const ctxMath = vm.runInContext('Math', W);  // src 运行期取到的是**同一份** Math（见下方 freezeOk 实证）
      const savedRandom = ctxMath.random;
      const savedStandard = M.state.task.standard;
      const savedReal = Object.assign({}, M.state.task.real);
      const probes = {};
      let freezeOk = false, buildErr = null;
      try {
        ctxMath.random = () => 0.5;                // 步长恒 0 ⇒ 实测值不再游走
        M.state.task.real.depth = 5.00;            // 与 mockData 头部「演示取值」一致的初值
        M.state.task.real.vx = 5.00;
        M.state.task.real.vy = 0.10;
        M.state.task.standard = { depth: errSpec('depth'), speed: errSpec('speed') };
        M.tick(new Date(base));                    // 本帧起 speed 由 vx/vy 重算（= 5.00）
        const d1 = M.state.task.real.depth, s1 = M.state.task.real.speed;
        M.tick(new Date(base + 1000));
        freezeOk = d1 === 5.00 && s1 === 5.00 &&
          M.state.task.real.depth === d1 && M.state.task.real.speed === s1;
        probes.real = `depth=${d1} speed=${s1}`;
        probes.bothErr = snap();
        M.state.task.standard = { depth: warnSpec('depth'), speed: warnSpec('speed') };
        M.tick(new Date(base + 2000));
        probes.bothWarn = snap();
        M.state.task.standard = { depth: warnSpec('depth'), speed: errSpec('speed') };
        M.tick(new Date(base + 3000));
        probes.mixed = snap();
      } catch (e) {
        buildErr = e;
      } finally {
        ctxMath.random = savedRandom;              // 还原全局随机源（后续用例照常游走）
        M.state.task.standard = savedStandard;     // 还原运行时真源
        Object.assign(M.state.task.real, savedReal);
      }
      const frozen = buildErr === null && freezeOk;
      const pre = buildErr ? `构造/判定异常：${buildErr.message}`
        : `实测 ${probes.real}（冻结游走 ${freezeOk ? '生效' : '**失效 ⇒ 本组判据不成立**'}）；`;
      const line = s => s
        ? `${s.param.length} 条、标题/等级=[${s.titles.map((t, i) => `${t}/${s.lvs[i]}`).join('、') || '无'}]、` +
          `每行 detail 参数名个数=[${s.nameCounts.join(', ') || '无'}]、含「；」=[${s.semi.join(', ') || '无'}]、` +
          `state.warnings 合计 ${s.total} 条；实算＝${s.text}`
        : '（未取到）';
      check('FR-5.8/C-88 同态预警独立成条（**同态应出 2 条**）：深度与速度**同为超范围（err）**⇒ 参数类恰 2 条、每条 detail 只含一个参数且不用「；」拼接两参数（R26-P2-2 修）',
        frozen && probes.bothErr && probes.bothErr.param.length === 2 &&
        probes.bothErr.lvs.every(l => l === 'err') &&
        probes.bothErr.titles.every(t => t === '参数超范围预警') &&
        oneParamPerRow(probes.bothErr),
        pre + '同态 err 应出 2 条：' + line(probes.bothErr));
      check('FR-5.8/C-88 同态预警独立成条（**同态应出 2 条**）：深度与速度**同为临近（warn）**⇒ 参数类恰 2 条、每条 detail 只含一个参数且不用「；」拼接两参数（R26-P2-2 修）',
        frozen && probes.bothWarn && probes.bothWarn.param.length === 2 &&
        probes.bothWarn.lvs.every(l => l === 'warn') &&
        probes.bothWarn.titles.every(t => t === '参数阈值临近预警') &&
        oneParamPerRow(probes.bothWarn),
        pre + '同态 warn 应出 2 条：' + line(probes.bothWarn));
      check('FR-5.8/C-88 同态改动后的**混态回归**：深度 warn ＋ 速度 err 仍恰 2 条（一临近一超范围、各含一个参数）',
        frozen && probes.mixed && probes.mixed.param.length === 2 &&
        probes.mixed.lvs.join(',') === 'err,warn' &&
        PARAM_TITLES.every(n => probes.mixed.titles.includes(n)) &&
        oneParamPerRow(probes.mixed),
        pre + '混态应仍为 2 条（err 在前、warn 在后）：' + line(probes.mixed));
      check('FR-5.8/C-88 五判据在**同态**用例下同样成立（至多 2 条 / 无第三个名字 / 相机参数不参与 / 名称⇔等级色 / detail 非空）',
        frozen && c88(probes.bothErr) && c88(probes.bothWarn) && c88(probes.mixed),
        pre + `同态 err：${line(probes.bothErr)} ｜ 同态 warn：${line(probes.bothWarn)}`);
      check('FR-5.8 参数类**上界回归**：参数类最多 2 条 ⇒ state.warnings 合计最多 5 条（同态时仍是 2 条、不是 4 条）',
        frozen && [probes.bothErr, probes.bothWarn, probes.mixed].every(s => s.param.length <= 2 && s.total <= 5) &&
        probes.bothErr.param.length === 2 && probes.bothErr.total === 5 &&
        probes.bothWarn.param.length === 2 && probes.bothWarn.total === 5,
        pre + `合计 = 同态 err ${probes.bothErr ? probes.bothErr.total : '--'} 条 / 同态 warn ${probes.bothWarn ? probes.bothWarn.total : '--'} 条 ` +
          `（参数类 2 + 维保/耗材/工单 3 = 5；若同态被合并则只剩 1+3=4）`);
    }
    check('FR-5.12/FR-5.13/FR-5.14 当班异常台账按行渲染（时间/编号/描述/闭环状态）',
      (() => {
        ui.out.length = 0;
        W.Components.AlarmPanel.render({
          alarm: {
            active: null, queue: [],
            ledger: [
              { time: '2026-09-19 09:00:00', code: 'AL-1', desc: '断连', state: '已闭环' },
              { time: '2026-09-19 09:30:00', code: 'AL-2', desc: '帧率超限', state: '未处理' }
            ]
          },
          warnings: []
        });
        const tbody = String(lastHtml(ui.out, 'alTable tbody') || '');
        return (tbody.match(/<tr>/g) || []).length === 2 && tbody.includes('AL-1') &&
          tbody.includes('AL-2') && tbody.includes('已闭环') && tbody.includes('未处理');
      })(), '台账条目不得覆盖或丢失');

    /* 维保台账：周期行、进度条百分比、累计运行三项、检修记录表（FR-6.1～6.10 / UI-06/07）
       注：假 DOM 把 `$('mtTable').querySelector('tbody').innerHTML = …` 记为 id 为
       `mtTable tbody` 的 html 记录（见本文件 `o.querySelector` 的实现），故按该 id 取。 */
    ui.out.length = 0;
    W.Components.MaintPanel.render(W.MockData.state);
    const styleOf = (id, prop) => {
      const hits = ui.out.filter(r => r.kind === 'style' && r.id === id && r.prop === prop);
      return hits.length ? hits[hits.length - 1].value : null;
    };
    const cycle = String(lastHtml(ui.out, 'mtCycleList') || '');
    const bar = String(styleOf('mtProgressBar', 'width') || '');
    const today = String(lastText(ui.out, 'mtTodayRun') || '');
    const month = String(lastText(ui.out, 'mtMonthRun') || '');
    const year = String(lastText(ui.out, 'mtYearRun') || '');
    const days = String(lastText(ui.out, 'mtDaysLeft') || '');
    const tbody = String(lastHtml(ui.out, 'mtTable tbody') || '');
    check('FR-6.1/FR-6.2 维保周期台账渲染出三行（上次维保/计划下次/固定周期）',
      (cycle.match(/kv-row/g) || []).length === 3 &&
      cycle.includes('上次维保时间') && cycle.includes('计划下次维保') && cycle.includes('固定维保周期'),
      `周期行数 ${(cycle.match(/kv-row/g) || []).length}`);
    check('FR-6.3 维保进度条按已用比例设置宽度（0～100%）',
      /^\d+(\.\d+)?%$/.test(bar) && Number.parseFloat(bar) >= 0 && Number.parseFloat(bar) <= 100,
      `width=${bar}`);
    check('FR-6.4/FR-6.5/FR-6.6 距离下次维保天数渲染为「N 天」',
      /^\d+\s*天$/.test(days), `mtDaysLeft=${JSON.stringify(days)}`);
    check('FR-6.7/FR-6.8/FR-6.9 三项累计运行都有**真实格式值**（不是占位破折号）',
      [today, month, year].every(v => v.length > 0 && v !== '—' && v !== ''),
      `当班=${today} 本月=${month} 本年=${year}`);
    check('FR-6.10 检修记录表按行渲染（时间/内容/责任人/状态四列）',
      tbody.includes('<tr>') && ['mono', 'ok', 'warn'].some(c => tbody.includes(c)),
      `tbody 片段数 ${(tbody.match(/<tr>/g) || []).length}`);
  }

  /* ==========================================================================
     U3c 测试标准区（FR-3.16 改写 / FR-3.18 显示 / FR-3.19 八步录入 / FR-3.14 判定对象）
     --------------------------------------------------------------------------
     立案：V1.33 把任务数据页右下角原「设备参数对比区」改写为「测试标准区」，相机参数移入二级菜单。
     于是 U2 里两条旧断言的基础被移走（见上方改判），本段按**新口径**补齐可证伪判据。
     夹具：`loadTaskStdFixture()`（真 TaskPanel/SettingPanel/Dashboard + 可派发事件的按 id 缓存桩件）。
     ========================================================================== */
  section('U3c 测试标准区与相机二级菜单（FR-3.16 / FR-3.18 / FR-3.19 / FR-3.14）');
  {
    const fx = loadTaskStdFixture(mkStdTaskState());
    const T = fx.W.Components.TaskPanel;
    const STDCFG = fx.W.BoardConfig.standards;
    /* 临近比例与单位精度**读配置**，不硬编码：配置改了断言随之改判（FR-3.18 / NFR-19） */
    const ratio = STDCFG.nearRatio;
    const digits = STDCFG.digits;
    const dep = makeStdSpec(fx.W, 'depth');
    const spd = makeStdSpec(fx.W, 'speed');
    const r2 = fx.W.Format.round2;
    const tolOf = spec => r2((spec.upper - spec.lower) * ratio);
    const snap = () => fx.snap();
    let before = '';

    /* 装配（顺序即真实启动顺序）：TaskPanel 的录入事件（面板 mousedown 委托 + 输入框 keydown/blur）
       → Dashboard.init（真实现：内部 `SettingPanel.bind(state, resetIdleTimer)`）
       → 用例再 bind 一次 SettingPanel，把 onActivity 顶成**夹具计数桩**。
       为什么必须留到最后 bind：`TaskPanel.activity()` 调的是"最近一次 bind 的 onActivity"，
       而自动锁定回调自己不回调 onActivity，故只有这条计数桩能证明"重置回首页计时"真的发生了。 */
    T.bind(fx.state);
    fx.W.Pages.Dashboard.init(fx.state);
    fx.W.Components.SettingPanel.bind(fx.state, fx.idleActivity);
    T.render(fx.state);
    const rows = parseStdRows(fx.node('tkStdTable tbody').innerHTML);
    /* V1.35（C-90）五列口径：检测参数 / 典型值 / 上偏差 / 下偏差 / 上限·下限（导出）。
       可录入＝前四列里带 `data-edit` 的三个（Typical / UpperDev / LowerDev）；
       第 5 列是**只读导出值**（`.std-derived`，无 `data-edit`、无 `std-num`）——
       下面既正面断言三格可录入，也**反向**断言第 5 格不可录入（"上下限不可直接录入"的机器证据）。 */
    const expectedEdits = ['depth', 'speed'].flatMap(k => STD_EDIT_TYPES.map(suffix => k + suffix));
    const actualEdits = rows.flatMap(r => r.tds.map(td => td.edit).filter(Boolean));
    const hasClass = (td, cls) => !!td && new RegExp(`(?:^|\\s)${cls}(?:\\s|$)`).test(td.cls);
    const numCellsOk = rows.every(r => r.tds.length === 5 &&
      ['Typical', 'UpperDev', 'LowerDev'].every((suffix, i) =>
        hasClass(r.tds[i + 1], 'std-num') && r.tds[i + 1].edit === r.kind + suffix));
    const cellOfKind = (kind, suffix) => stdCell(rows, kind, kind + suffix);
    const expectedEditsOk = ['depth', 'speed'].every(kind =>
      ['Typical', 'UpperDev', 'LowerDev'].every(suffix => cellOfKind(kind, suffix) !== null));
    const derivedReadOnly = ['depth', 'speed'].every(kind => {
      const d = derivedCell(rows, kind);
      return !!d && hasClass(d, 'std-derived') && !hasClass(d, 'std-num') && !d.edit && /上限|下限/.test(stdCellText(d));
    });
    check(
      'FR-3.18 测试标准区显示深度/速度两行、五列（检测参数/典型值/上偏差/下偏差/上限·下限（导出）），' +
      '且每行恰三个可录入格（data-edit = <kind>Typical / UpperDev / LowerDev）',
      rows.length === 2 && rows.map(r => r.kind).join(',') === 'depth,speed' &&
      rows.every(r => r.tds.length === 5) && numCellsOk &&
      actualEdits.slice().sort().join(',') === expectedEdits.slice().sort().join(',') && expectedEditsOk,
      `行=${rows.map(r => `${r.kind}(${r.tds.length} 格)`).join(' / ') || '（未解析到结构）'}；` +
      `可录入格 data-edit=[${actualEdits.join('、') || '（无）'}] 应=[${expectedEdits.join('、')}]；` +
      `五列类名=${rows.map(r => r.tds.map(td => td.cls.replace(/\s+/g, '/')).join('|')).join(' # ') || '（无）'}`
    );
    check(
      'FR-3.18/FR-3.19 上限·下限为**只读导出值**：第 5 格 .std-derived 无 data-edit、无 std-num（上下限不可直接录入）',
      derivedReadOnly,
      ['depth', 'speed'].map(kind => {
        const d = derivedCell(rows, kind);
        return `${kind}: class=${JSON.stringify(d && d.cls)}、data-edit=${JSON.stringify(d && d.edit)}、` +
          `含 std-num=${hasClass(d, 'std-num')}、文本=${JSON.stringify(d ? stdCellText(d) : null)}`;
      }).join('；')
    );
    /* 导出值语义（D21 期望值实测）：上限＝典型值＋上偏差、下限＝典型值＋下偏差 ——
       两侧都从 `standards.default` 与 state 实算，**不硬编码 5.30 / 4.80**。 */
    const derivedOk = [['depth', dep], ['speed', spd]].every(([kind, spec]) => {
      const d = derivedLimits(derivedCell(rows, kind) && derivedCell(rows, kind).text, digits);
      return spec && d && d.upper === spec.upper && d.lower === spec.lower;
    });
    check(
      'FR-3.18 上限＝典型值＋上偏差、下限＝典型值＋下偏差（按配置 default 段与 state 实算，非硬编码）',
      derivedOk,
      [['depth', dep], ['speed', spd]].map(([kind, spec]) => {
        const d = derivedLimits(derivedCell(rows, kind) && derivedCell(rows, kind).text, digits);
        return `${kind}: 导出格=${JSON.stringify(d)} 应={上限 ${spec && spec.upper}, 下限 ${spec && spec.lower}}`;
      }).join('；')
    );
    check(
      'FR-3.18 深度单位 m、速度单位 m/s，且三格与导出值一律保留两位小数（位数读配置 standards.digits）',
      [dep, spd].every(spec => spec && spec.digits === digits) &&
      unitOf(typicalCell(rows, 'depth') && typicalCell(rows, 'depth').text) === 'm' &&
      unitOf(typicalCell(rows, 'speed') && typicalCell(rows, 'speed').text) === 'm/s' &&
      ['depth', 'speed'].every(k => ['Typical', 'UpperDev', 'LowerDev'].every(s =>
        (s === 'Typical' ? valueOf(cellOfKind(k, s) && cellOfKind(k, s).text, digits)
          : signedValueOf(cellOfKind(k, s) && cellOfKind(k, s).text, digits)) !== null)) &&
      derivedLimits(derivedCell(rows, 'depth') && derivedCell(rows, 'depth').text, digits) !== null &&
      typicalOf(typicalCell(rows, 'depth') && typicalCell(rows, 'depth').text, digits) !== null &&
      typicalOf(typicalCell(rows, 'speed') && typicalCell(rows, 'speed').text, digits) !== null,
      `digits=${digits}（深度/速度配置位数 ${dep && dep.digits}/${spd && spd.digits}）；` +
      `深度行单位=${JSON.stringify(unitOf(typicalCell(rows, 'depth') && typicalCell(rows, 'depth').text))}、` +
      `速度行单位=${JSON.stringify(unitOf(typicalCell(rows, 'speed') && typicalCell(rows, 'speed').text))}；` +
      `深度三格=${['Typical', 'UpperDev', 'LowerDev'].map(s => valueOf(cellOfKind('depth', s) && cellOfKind('depth', s).text, digits)).join('/')}`
    );
    check(
      'FR-3.18 三个录入格分别给出两位小数取值与带符号偏差（典型值无符号、上偏差 +、下偏差 −），且两行都有',
      [['depth', dep], ['speed', spd]].every(([kind, spec]) => {
        const t = stdCell(rows, kind, kind + 'Typical');
        const u = stdCell(rows, kind, kind + 'UpperDev');
        const l = stdCell(rows, kind, kind + 'LowerDev');
        return typicalOf(t && t.text, digits) === spec.typical &&
          signedValueOf(u && u.text, digits) === r2(spec.upperDev) &&
          signedValueOf(l && l.text, digits) === r2(spec.lowerDev) &&
          devTxtOf(t && t.text) === null;                 /* 典型值格**不带**正负号（非负绝对量） */
      }),
      [['depth', dep], ['speed', spd]].map(([kind, spec]) => {
        const t = stdCell(rows, kind, kind + 'Typical');
        const u = stdCell(rows, kind, kind + 'UpperDev');
        const l = stdCell(rows, kind, kind + 'LowerDev');
        return `${kind}: 典型值=${typicalOf(t && t.text, digits)} 应=${spec.typical}（格内偏差小字=${JSON.stringify(devTxtOf(t && t.text))}）；` +
          `上偏差=${signedValueOf(u && u.text, digits)} 应=${r2(spec.upperDev)}；下偏差=${signedValueOf(l && l.text, digits)} 应=${r2(spec.lowerDev)}`;
      }).join('；')
    );
    check(
      'FR-3.18 旧版「偏差小字」不再渲染：典型值格内无 .std-dev、也无「上偏差… · 下偏差…」小字（V1.35 三格独立呈现）',
      !/std-dev/.test(String(fx.node('tkStdTable tbody').innerHTML)) &&
      !/上偏差 [+-]?\d/.test(stdCellText(stdCell(rows, 'depth', 'depthTypical'))),
      `depth 典型值格文本=${JSON.stringify(stdCellText(stdCell(rows, 'depth', 'depthTypical')))}；` +
      `正文含 .std-dev=${/std-dev/.test(String(fx.node('tkStdTable tbody').innerHTML))}`
    );
    /* V1.36（U-5 / C-96）改判：说明行由长句精简为**只有一句** ⇒ 判据从"包含若干片段"改为
       **逐字相等**（`===`，不是正则 test），并**反向**断言长句与尾部 meta 均已删除（防回潮）。
       ⚠️ 为什么不能顺手把"上下限为只读导出值 / 典型值不参与判定"一起删掉：
       那是**界面语义**，不是这句文案的属性 —— 按 C-96「信息不丢失」的口径，它由**第 5 格
       `.std-derived`**（无 `data-edit`、无 `std-num`、导出值实算，见上方两条既有断言）与
       三个 `data-edit` 单元格集合承担；本段不重复断言它们，但也**不得**因文案精简而失去该证据。 */
    const metaText = String(fx.node('tkStdMeta').textContent || '');
    const META_ONLY = '典型值 / 上偏差 / 下偏差三格可录入';
    const metaBanned = ['上限＝', '下限＝', '只读导出值', '不参与判定', '班组', '生效时间', '版本'];
    const metaHits = metaBanned.filter(s => metaText.includes(s));
    check(
      'FR-3.18（U-5 / C-96）说明行逐字只有一句「典型值 / 上偏差 / 下偏差三格可录入」：不含导出公式长句、' +
      '不含「只读导出值」「典型值不参与判定」、不含尾部 meta（班组/生效时间/版本），且渲染仍不写 state',
      metaText === META_ONLY && metaHits.length === 0 && fx.state.task.standard === undefined,
      `#tkStdMeta=${JSON.stringify(metaText)}（应逐字等于 ${JSON.stringify(META_ONLY)}）；` +
      `反向命中（应为空）=[${metaHits.join('、')}]；` +
      `state.task.standard=${fx.state.task.standard === undefined ? '未建（渲染不写入）' : '已被渲染建立'}`
    );

    /* ---- (b) 三态：正常 / 临近黄 / 超范围红（FR-3.18 / FR-3.14），阈值用配置 nearRatio 实算 ---- */
    const depTol = tolOf(dep);
    const spdTol = tolOf(spd);
    const colorOf = id => fx.node(id).style.color;
    /* 临近带内侧 0.01 m/s：距下限已进入 (上限−下限)×nearRatio 之内（恰落在边界上会被两位小数取整
       推到带外，故取带内一点，判据仍完全由配置的 nearRatio 实算） */
    fx.state.task.real.depth = r2(dep.lower + depTol) - r2(1 / Math.pow(10, digits));
    fx.state.task.real.speed = r2(spd.upper + 0.5);             /* 超上限 */
    T.render(fx.state);
    check(
      'FR-3.18/FR-3.14 超范围红、临近黄（三态只用于深度与速度）：临近判据＝实测距边界 ≤ (上限−下限)×nearRatio（比例读配置）',
      /class="std-state warn"/.test(fx.node('tkStdTable tbody').innerHTML) &&
      colorOf('tkDepth') === 'var(--warn)' && colorOf('tkSpeed') === 'var(--err)',
      `nearRatio=${ratio} ⇒ 深度容差 ${depTol}（实测 depth=${fx.state.task.real.depth} ∈ [${dep.lower}, ${r2(dep.lower + depTol)}]）⇒ ${colorOf('tkDepth')}；` +
      `实测 speed=${fx.state.task.real.speed} > 上限 ${spd.upper} ⇒ ${colorOf('tkSpeed')}`
    );
    check(
      'FR-3.18 临近/超范围两态判据互斥：临近带内的实测值不得被判超范围，超上限的实测值必须红（同一渲染内的两行对照）',
      (() => {
        const body = fx.node('tkStdTable tbody').innerHTML;
        const warnDepth = /data-kind="depth">[\s\S]*?class="std-state warn"/.test(body);
        const errSpeed = /data-kind="speed">[\s\S]*?class="std-state err"/.test(body);
        return warnDepth && errSpeed;
      })(),
      `深度行判临近=${/data-kind="depth">[\s\S]*?class="std-state warn"/.test(fx.node('tkStdTable tbody').innerHTML)}、` +
      `速度行判超范围=${/data-kind="speed">[\s\S]*?class="std-state err"/.test(fx.node('tkStdTable tbody').innerHTML)}`
    );
    fx.state.task.real.depth = r2(dep.typical - (dep.typical - dep.lower) / 2);
    fx.state.task.real.speed = r2(spd.typical + (spd.upper - spd.typical) / 2);
    T.render(fx.state);
    check(
      'FR-3.18 区间内（远离上下限）判正常：两行三态都是 ok，且实测值不被染成黄/红',
      /data-kind="depth">[\s\S]*?class="std-state ok"/.test(fx.node('tkStdTable tbody').innerHTML) &&
      /data-kind="speed">[\s\S]*?class="std-state ok"/.test(fx.node('tkStdTable tbody').innerHTML) &&
      colorOf('tkDepth') === '' && colorOf('tkSpeed') === '',
      `深度 depth=${fx.state.task.real.depth}⇒${colorOf('tkDepth') || '（默认色）'}；` +
      `速度 speed=${fx.state.task.real.speed}⇒${colorOf('tkSpeed') || '（默认色）'}`
    );

    /* ---- (b2) FR-3.18 临近带的**闭边界**（含等号）与**压线不算超范围** ----
       立案（D22 变异 M6）：把 `standardLevel()` 的临近判据 `<= k` 改成 `< k`
       （即取消"距离恰等于带宽也算临近"）时，此前 ui-check 87/0 仍全绿 —— 原有 near 用例的实测值
       离边界尚有余量，落进两种写法都判 warn 的区域，**锁不住闭边界**。
       本段按实现在**显示精度网格上的整数口径**构造两侧对照（判据全部从 `standards.digits /
       nearRatio / default` 实算，不写死 0.06 / 15% / 8 格）：
         带宽格数 k = max(1, ceil((上限−下限)×nearRatio ÷ 最小格))；
         距边界恰 k 格     ⇒ 临界（含等号）⇒ `warn`；
         距边界 k+1 格     ⇒ 出带         ⇒ `ok`；
         恰等于上/下限（压线）⇒ 判定区间是闭区间 [下限, 上限] ⇒ `ok`，**不得**判 `err`。
       判据与实现逐值对照（`T.levelOf`），并同时核对渲染出的 `std-state` 类名与主展示色 ——
       既锁公式、也锁界面三态（FR-3.14 / FR-3.18）。 */
    {
      const levelOf = (v, spec) => T.levelOf(v, spec) || {};
      const specLines = [['depth', dep], ['speed', spd]].map(([kind, spec]) => {
        const grid = Math.pow(10, -spec.digits);            /* 最小格（两位小数 ⇒ 0.01） */
        const tol = r2((spec.upper - spec.lower) * ratio);
        const k = Math.max(1, Math.ceil(tol / grid - 1e-9));
        return { kind, spec, grid, tol, k };
      });
      const specOf = kind => (kind === 'depth' ? dep : spd);
      const nearAt = (line, side, steps) => ({
        v: r2(side === 'upper' ? line.spec.upper - steps * line.grid : line.spec.lower + steps * line.grid),
        want: steps <= line.k ? 'warn' : 'ok'
      });
      const probes = specLines.flatMap(line => [
        { kind: line.kind, label: `距上限恰 ${line.k} 格`, ...nearAt(line, 'upper', line.k) },
        { kind: line.kind, label: `距上限 ${line.k + 1} 格`, ...nearAt(line, 'upper', line.k + 1) },
        { kind: line.kind, label: `距下限恰 ${line.k} 格`, ...nearAt(line, 'lower', line.k) },
        { kind: line.kind, label: `距下限 ${line.k + 1} 格`, ...nearAt(line, 'lower', line.k + 1) }
      ]).map(p => ({ ...p, got: levelOf(p.v, specOf(p.kind)).lv }));

      /* 渲染侧核对：把探针值逐个喂给 render，该行的三态类名必须与 levelOf 一致 */
      const renderMismatch = [];
      for (const p of probes) {
        fx.state.task.real[p.kind] = p.v;
        T.render(fx.state);
        const seg = new RegExp(`data-kind="${p.kind}">[\\s\\S]*?class="std-state (\\w+)"`)
          .exec(fx.node('tkStdTable tbody').innerHTML);
        if (!seg || seg[1] !== p.want) renderMismatch.push(`${p.kind} ${p.label} 渲染判 ${seg ? seg[1] : '（未解析到）'} 应 ${p.want}`);
      }
      const logicMismatch = probes.filter(p => p.got !== p.want);
      check(
        'FR-3.18 临近带含等号（闭边界）：距边界恰等于带宽 ⇒ 临近（warn）；再往外一格 ⇒ 正常（ok）；判据按配置 digits/nearRatio 实算',
        probes.length === 8 && logicMismatch.length === 0 && renderMismatch.length === 0,
        `带宽格数 k：深度 ${specLines[0].k} 格（tol ${specLines[0].tol}）、速度 ${specLines[1].k} 格（tol ${specLines[1].tol}）⇒ ` +
        (logicMismatch.length
          ? `判据不符 ${logicMismatch.length} 项：` + logicMismatch.map(p => `${p.kind} ${p.label} 实测 ${p.v} 判 ${p.got} 应 ${p.want}`).join('；')
          : probes.map(p => `${p.kind} ${p.label}(${p.v})=${p.got}`).join('，')) +
        (renderMismatch.length ? `；渲染不符：${renderMismatch.join('；')}` : '')
      );

      /* 压线（恰等于上/下限）：闭区间 ⇒ 正常，不得判超范围 */
      const edgeProbes = specLines.flatMap(line => [
        { kind: line.kind, label: '实测＝上限（压线）', v: line.spec.upper, want: 'ok' },
        { kind: line.kind, label: '实测＝下限（压线）', v: line.spec.lower, want: 'ok' }
      ]).map(p => ({ ...p, got: levelOf(p.v, specOf(p.kind)).lv }));
      const edgeMismatch = edgeProbes.filter(p => p.got !== p.want);
      const edgeColors = [];
      for (const p of edgeProbes) {
        fx.state.task.real[p.kind] = p.v;
        T.render(fx.state);
        if ((p.kind === 'depth' ? colorOf('tkDepth') : colorOf('tkSpeed')) !== '') {
          edgeMismatch.push({ kind: p.kind, label: p.label + '（主展示被着色）', got: colorOf(p.kind === 'depth' ? 'tkDepth' : 'tkSpeed'), want: '（默认色）' });
        }
        edgeColors.push(`${p.kind}${p.label}=${(p.kind === 'depth' ? colorOf('tkDepth') : colorOf('tkSpeed')) || '（默认色）'}`);
      }
      check(
        'FR-3.18 压线不算超范围：实测恰等于上限或下限（闭区间边界）⇒ 正常（ok），且主展示数字不着红/黄',
        edgeProbes.length === 4 && edgeMismatch.length === 0,
        edgeMismatch.length
          ? `不符：` + edgeMismatch.map(p => `${p.kind} ${p.label} 判 ${p.got} 应 ${p.want}`).join('；')
          : `压线四例（深度/速度 × 上/下限）均判 ok；主展示色：${edgeColors.join('，')}`
      );

      /* 复位到典型值，避免把探针值留给后面的用例 */
      fx.state.task.real.depth = r2(dep.typical);
      fx.state.task.real.speed = r2(spd.typical);
      T.render(fx.state);
    }

    /* ---- (c) 相机参数二级菜单：只含参数名 + 设定值，无实测值/偏差/状态列（FR-3.16 改写） ---- */
    const camRows = parseStdRows(fx.node('tkCompareTable tbody').innerHTML);
    const camLabels = camRows.map(r => stdCellText(r.tds[0]));
    const camHead = thOf((html.match(/id="tkCompareTable"[\s\S]*?<thead><tr>([\s\S]*?)<\/tr>/) || [])[1] || '');
    const camCfg = (fx.W.BoardConfig.camera || {}).rows || [];
    const camDetail = fx.node('tkCompareTable tbody').innerHTML;
    check(
      'FR-3.16 相机参数二级菜单只含参数名 + 设定值两列：表头列集恰为「参数/设定值」、每行恰 2 格',
      camHead.join(',') === '参数,设定值' && camRows.length === camCfg.length && camRows.length > 0 &&
      camRows.every(r => r.tds.length === 2),
      `#tkCompareTable thead = [${camHead.join(' | ')}]（index.html）；正文 ${camRows.length} 行、每行 ` +
      `${camRows.map(r => r.tds.length).join('/') || '—'} 格（配置 ${camCfg.length} 项）`
    );
    check(
      'FR-3.16 相机二级菜单不含实测值/偏差/状态：正文无"偏差"、无三态字面量；且只改 real 段实测值后菜单渲染**逐字不变**',
      camDetail.length > 0 && !/偏差/.test(camDetail) && !/正常|临近|超范围|超标/.test(camDetail) &&
      (() => {
        const keep = { depth: fx.state.task.real.depth, fps: fx.state.task.real.fps, gain: fx.state.task.real.gain };
        fx.state.task.real.depth = r2(keep.depth + 3);
        fx.state.task.real.fps = keep.fps * 2;
        fx.state.task.real.gain = r2(keep.gain + 7);
        T.render(fx.state);
        const moved = fx.node('tkCompareTable tbody').innerHTML;
        fx.state.task.real.depth = keep.depth; fx.state.task.real.fps = keep.fps; fx.state.task.real.gain = keep.gain;
        T.render(fx.state);
        return moved === camDetail;
      })(),
      `正文出现"偏差"=${/偏差/.test(camDetail)}、三态字面量=${/正常|临近|超范围|超标/.test(camDetail)}；` +
      `正文=${JSON.stringify(camDetail.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 110))}`
    );
    check(
      'FR-3.16 菜单项为参数名 + 设定值（值取自 state.task.std 的设定值，逐项按配置位数格式化：相机设定深度/相机增益/设定帧率/快门速度）',
      camRows.length === camCfg.length && camRows.length > 0 && camRows.every((r, i) => {
        const row = camCfg[i];
        const sv = fx.state.task.std[row.key];
        return camLabels[i] === row.label && stdCellText(r.tds[1]) === (typeof sv === 'number' ? sv.toFixed(row.digits) : '—') + (row.unit || '');
      }),
      camRows.map((r, i) => `${camLabels[i]} vs ${camCfg[i] && camCfg[i].label}＝${JSON.stringify(stdCellText(r.tds[1]))}`).join('；')
    );
    check(
      'FR-3.16 二级菜单下给出归属说明行（上位机侧设备参数，不参与本看板判定）',
      /上位机侧设备参数，不参与本看板判定/.test(html) && /id="tkCameraMenu"/.test(html) &&
      /<details[^>]*class="[^"]*camera-menu[^"]*"[^>]*id="tkCameraMenu"/.test(html),
      `index.html 含归属说明=${/上位机侧设备参数，不参与本看板判定/.test(html)}；` +
      `#tkCameraMenu 是 <details class="camera-menu">=${/<details[^>]*class="[^"]*camera-menu[^"]*"[^>]*id="tkCameraMenu"/.test(html)}`
    );

    /* ---- (d) FR-3.19 第 4 步：反色 + 高亮框 2 px + 1 s ± 50 ms 闪烁的样式契约（静态，读 CSS） ----
       U-2（C-89）改判：间隔 0.5 s ± 50 ms → **1 s ± 50 ms**，高亮框 4 px → **2 px**。 */
    {
      const css = readText('src/styles/global.css');
      const blink = /@keyframes\s+stdBlink\s*\{([\s\S]*?)\n\}/.exec(css) || [];
      /* 三项样式走 `parseCss()`（已按 CRLF 归一，见该函数注释）——
         之前这四条断言假红的根因就是 `global.css` 是 CRLF，属性名带上了 `\r\n` 前缀。 */
      const rulesCss = parseCss(css);
      const editing = rulesCss.get('.std-limits td.is-editing') || {};
      const animMs = Number((String(editing.animation || '').match(/\s(\d*\.?\d+)s(\s|$)/) || [])[1]) * 1000;
      const invRule = rulesCss.get('.std-limits td.is-editing .std-value') || {};
      /* 闪烁间隔目标值从**需求口径**读（1 s），允差 ±50 ms —— 判据是"落在 950–1050 ms"，不是"字面等于 1s 这串字符" */
      const BLINK_MS = 1000, BLINK_TOL = 50;
      check(
        'FR-3.19 第4步 反色、高亮框（2 px）与 1 s ± 50 ms 闪烁的样式契约齐备（@keyframes stdBlink + .is-editing 的 animation/box-shadow/反色文字）',
        /@keyframes\s+stdBlink/.test(css) && /50%,\s*100%\s*\{\s*opacity/.test(blink[1] || '') &&
        editing.animation === 'stdBlink 1s step-end infinite' &&
        Number.isFinite(animMs) && Math.abs(animMs - BLINK_MS) <= BLINK_TOL &&
        editing['box-shadow'] === 'inset 0 0 0 2px #FFFFFF' &&
        /var\(--accent\)/.test(editing.background || '') &&
        invRule.color !== undefined && invRule.color.toUpperCase() !== '#FFFFFF',
        `@keyframes stdBlink=${/@keyframes\s+stdBlink/.test(css)}；animation=${JSON.stringify(editing.animation)}（${animMs} ms，允差 ±${BLINK_TOL}）；` +
        `box-shadow=${JSON.stringify(editing['box-shadow'] || '（缺）')}；背景=${JSON.stringify(editing.background || '（缺）')}；` +
        `反色文字色=${JSON.stringify(invRule.color || '（缺）')}`
      );
    }

    /* ---- (d2) U-1（C-92）字号与"占满卡片剩余高度"的**静态机器证据** ----
       负责人原话按**字面口径**落地：典型值数值 60–64 px、参数名 48 px、单位与偏差（含只读导出值）36–40 px。
       为什么逐类名分别读：`parseCss()` 的 Map 对**同名选择器**后写覆盖先写，但"哪条规则最终胜出"取决于
       优先级与声明次序（`global.css` 里 `.data-table.compact td`(0,2,1) 会压过 `.std-limits td`(0,1,1)，
       注释里已记录过这次实测踩坑）。故这里用 `fontPx()` 逐选择器读**冻结选择器串**的字号：
       选择器串一旦被改写/删掉，读到的就是 null ⇒ 断言变红，人必须回来复核，而不是自动跟着新值变绿。 */
    {
      const rulesCss = parseCss(readText('src/styles/global.css'));
      const pxOf = sel => fontPx(rulesCss, sel);
      /* 上/下偏差字号挂在**合并选择器** `.std-limits.compact .std-num.std-upperdev .std-value,\n
         .std-limits.compact .std-num.std-lowerdev .std-value { font-size: 40px; }` 上 ——
         整串查不到，须按标记定位（`lastRuleWith` 取"层叠里最后一条"，即实际胜出者）。 */
      const devRuleUpper = lastRuleWith(rulesCss, '.std-num.std-upperdev', 'font-size');
      const devRuleLower = lastRuleWith(rulesCss, '.std-num.std-lowerdev', 'font-size');
      const pxFromRule = (decls) => {
        const m = String((decls || {})['font-size'] || '').match(/^(\d+(?:\.\d+)?)px$/);
        return m ? Number(m[1]) : null;
      };
      const typicalPx = pxOf('.std-limits.compact .std-value');
      const upperDevPx = pxFromRule(devRuleUpper);
      const lowerDevPx = pxFromRule(devRuleLower);
      const unitPx = pxOf('.std-limits.compact .std-unit');
      const derivedPx = pxOf('.std-limits.compact .std-derived');
      const namePx = pxOf('.std-limits.compact .std-name');
      const inRange = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;
      check(
        'FR-3.16（U-1 字号）典型值数值 60–64 px、参数名 48 px、上/下偏差与单位及只读导出值 36–40 px（逐冻结选择器读实际生效字号）',
        inRange(typicalPx, 60, 64) && namePx === 48 &&
        inRange(upperDevPx, 36, 40) && inRange(lowerDevPx, 36, 40) &&
        inRange(unitPx, 36, 40) && inRange(derivedPx, 36, 40),
        `典型值=${typicalPx}（应 60–64）、参数名=${namePx}（应 48）、上偏差=${upperDevPx}/下偏差=${lowerDevPx}（应 36–40）、` +
        `单位=${unitPx}、导出值=${derivedPx}（应 36–40）`
      );
      /* 占满卡片剩余高度：`.std-limits` 接管剩余高度、二级菜单只占自身高度（`flex: none`）。
         判据是**两条样式事实**，不是"看起来没有大片空白"这种观感。 */
      const limitsRule = rulesCss.get('.std-limits') || {};
      const menuRule = rulesCss.get('.camera-menu') || {};
      const flexShort = String(limitsRule.flex || '').replace(/\s+/g, '');
      check(
        'FR-3.16（U-1 占位）测试标准区占满卡片剩余高度：.std-limits 的 flex:1 且 height:100%，.camera-menu 为 flex:none（不抢剩余高度）',
        flexShort === '1' && String(limitsRule.height || '').trim() === '100%' &&
        String(limitsRule['min-height'] || '').trim() === '0' &&
        String(menuRule.flex || '').replace(/\s+/g, '') === 'none',
        `.std-limits flex=${JSON.stringify(limitsRule.flex || '（缺）')}、height=${JSON.stringify(limitsRule.height || '（缺）')}、` +
        `min-height=${JSON.stringify(limitsRule['min-height'] || '（缺）')}；.camera-menu flex=${JSON.stringify(menuRule.flex || '（缺）')}`
      );
    }

    /* ---- (d3) U-4（C-95）"预期外换行"的**声明层**机器证据（纯 CSS 可查，与真机判据互补） ----
       立案（V1.36 / C-95，负责人手动测试反馈 U-4，真机截图复现）：三态徽标由 2 字变 3 字
       （「超范围」）后，参数名列变宽 ⇒ 5 列最大内容宽之和超出卡片可用宽 ⇒ 浏览器按自动表格布局
       **挑一列断行**，而当时唯一允许换行的第 5 格（`.std-derived` 旧版 `white-space: normal`）被压成两行。
       故**根因修复点就是第 5 格的 `white-space: nowrap`**，本段把它单独点名（改回 normal 即红）。
       ⚠️ `.std-limits th` 的 `white-space: normal` 是**有意保留**的既有设计（需求 C-95 原文：
       "表头仍允许换行（既有设计，本次不动）"）—— 这里写成**正向**断言，防止有人"顺手统一成 nowrap"。
       本段只查**声明**（静态、离线可复跑）；同一条要求在真机的**渲染结果**由 browser-check 的
       B5b 段（3840×2160、强制徽标＝超范围、逐格量包围盒）承接。 */
    {
      const rulesCss = parseCss(readText('src/styles/global.css'));
      /** 读某选择器的 `white-space` 声明；读不到返回 '（缺）'（不得兜底成 nowrap，否则删规则也变绿） */
      const wsOf = sel => {
        const d = rulesCss.get(sel);
        return d && d['white-space'] !== undefined ? String(d['white-space']).trim() : '（缺）';
      };
      const derivedWs = wsOf('.std-limits.compact .std-derived');
      const stateWs = wsOf('.std-limits .std-state');
      const nameWs = wsOf('.std-limits.compact .std-name');
      const thWs = wsOf('.std-limits th');
      check(
        'FR-3.18（U-4 / C-95）**根因修复点**：第 5 格只读导出值不换行 —— `.std-limits.compact .std-derived` 的 white-space === nowrap',
        derivedWs === 'nowrap',
        `.std-limits.compact .std-derived white-space=${JSON.stringify(derivedWs)}（应 nowrap；旧版为 normal ⇒ 被三字徽标挤成两行）`
      );
      check(
        'FR-3.18（U-4 / C-95）参数名与三态徽标同排不换行：`.std-limits.compact .std-name` 与 `.std-limits .std-state` 的 white-space 均 === nowrap',
        nameWs === 'nowrap' && stateWs === 'nowrap',
        `.std-limits.compact .std-name white-space=${JSON.stringify(nameWs)}、` +
        `.std-limits .std-state white-space=${JSON.stringify(stateWs)}（均应 nowrap）`
      );
      check(
        'FR-3.16（U-4 / C-95 有意保留）表头仍允许换行：`.std-limits th` 的 white-space === normal（正向断言，防"顺手改掉"）',
        thWs === 'normal',
        `.std-limits th white-space=${JSON.stringify(thWs)}（需求 C-95 明示"表头仍允许换行，本次不动"）`
      );
      /* 宽度账的两个余量来源（U-1 字号区间的**上界** 40 px ＋ 单元格横向内边距 6 px）：
         C-95 的修法"限于样式与列宽"，即靠这两项给 5 列最大内容宽之和腾出余量。
         `padding` 简写按 CSS 展开规则取横向值（1 值＝四边相同；2/3 值＝第 2 个值；4 值＝第 2、4 个）。 */
      const derivedPx = fontPx(rulesCss, '.std-limits.compact .std-derived');
      const padRaw = String((rulesCss.get('.std-limits.compact td') || {}).padding || '').trim();
      const padParts = padRaw.split(/\s+/).filter(Boolean);
      const padH = padParts.length === 0 ? []
        : padParts.length === 1 ? [padParts[0], padParts[0]]
          : padParts.length === 4 ? [padParts[1], padParts[3]]
            : [padParts[1], padParts[1]];
      const padHOk = padH.length === 2 && padH.every(v => /^6px$/.test(v));
      check(
        'FR-3.18（U-4 / C-95 宽度账）第 5 格字号取 U-1 区间 [36,40] px（实测上界 40）且 `.std-limits.compact td` 横向内边距 6 px（余量来源）',
        typeof derivedPx === 'number' && derivedPx >= 36 && derivedPx <= 40 && padHOk,
        `.std-derived font-size=${derivedPx} px（应 ∈[36,40]）；.std-limits.compact td padding=${JSON.stringify(padRaw || '（缺）')}` +
        ` ⇒ 横向=[${padH.join('、')}]（应 6px/6px）`
      );
    }

    /* ---- (e) 第 ①③④⑧ 步：未解锁点击数字不进入录入态；解锁后才进入（FR-3.19 / AC-09） ----
       V1.35（C-90）改判：可录入的是**典型值 / 上偏差 / 下偏差**三格（`data-edit` = `<kind>Typical|UpperDev|LowerDev`），
       旧的上限/下限格已不存在（上限/下限是只读导出值，见上方的反向断言）。 */
    fx.node('tkStdEdit').hidden = true;                     /* index.html 的初始 hidden */
    /** 取当前渲染出的、带指定 data-edit 的可录入单元格（事件目标与断言对象是同一个节点）；
     *  **取不到返回 null** —— 调用方必须让它变成 FAIL，不得兜底成"跳过"。 */
    const realCell = type => {
      /* 走 querySelector('tbody') 而不是 __children：前几个 check 里的 `T.render()` 会重建
         单元格对象，只有经过一次 tbody 查询，夹具缓存里的节点才与"最后一次渲染"对齐 */
      const tb = fx.node('tkStdTable').querySelector('tbody');
      return tb.__children.slice().reverse().map(r => r.__children.find(td => td.dataset.edit === type)).find(Boolean) || null;
    };
    /** 点击某个可录入格（找不到就**不点**并返回 null）—— 由**断言**把这个 null 判成 FAIL，
     *  不在这里静默兜底、也不抛异常中断整脚本（其余断言仍应继续跑完并逐条点名）。 */
    const clickCell = type => {
      const c = realCell(type);
      if (c) fx.click(c);
      return c;
    };
    /** 关闭"上一个用例留下的"录入会话（避免它的退出提交污染下一个用例的观察）：
     *  组件在"点击其他区域"时会**先提交再处理点击**，故不显式收尾的话，下一个用例的第一次点击
     *  会顺带用**当前输入框内容**提交上一个会话 —— 实测就踩过这条（下一个用例的 alert 计数与
     *  opLog 都多出一条与它无关的留痕）。
     *  注：这里**不手工清 `#tkStdMsg`** —— 它是组件的渲染产物（`render()` 按
     *  lastErr/lastInfo/session/unlocked 四态择一写入），手工改写会让"锁定后应看到锁定提示"
     *  这条断言变成对用例自己写的内容的观察（自证），而不是对组件输出的观察。 */
    const closeSession = () => { fx.input().value = ''; fx.screen('blur'); };
    /* V1.35（C-90）：三格均可录入，故"未解锁点数字不进入录入态"与"解锁后进入录入态"都按**三格**逐格覆盖。 */
    const FIELD_CN = { Typical: '典型值', UpperDev: '上偏差', LowerDev: '下偏差' };
    const hasEdit = (type, body) => new RegExp(`data-edit="${type}"[^>]*class="[^"]*is-editing|class="[^"]*is-editing[^"]*"[^>]*data-edit="${type}"`).test(String(body));
    /* 锁定时点：逐格点击 ⇒ 都不进入录入态（`#tkStdEdit` 保持 hidden、正文无 is-editing） */
    const lockedProbe = ['depthTypical', 'depthUpperDev', 'depthLowerDev'].map(type => {
      fx.click(realCell(type));
      return { type, hidden: fx.node('tkStdEdit').hidden, editing: /is-editing/.test(String(fx.node('tkStdTable tbody').innerHTML)) };
    });
    check(
      'FR-3.19 第⑧步/AC-09 未解锁时点击典型值/上偏差/下偏差任一数字都不进入录入态：#tkStdEdit 保持隐藏、正文无 is-editing、录入行内无可聚焦的 #tkStdInput',
      lockedProbe.every(p => p.hidden === true && p.editing === false) &&
      String(fx.node('tkStdMsg').textContent || '').includes('当前已锁定'),
      lockedProbe.map(p => `${p.type}: hidden=${p.hidden}/is-editing=${p.editing}`).join('；') +
      `；#tkStdMsg=${JSON.stringify(String(fx.node('tkStdMsg').textContent || '').slice(0, 40))}`
    );
    fx.W.MockData.setUnlocked(true);
    /* 解锁后逐格点击 ⇒ 该格带 is-editing、#tkStdEdit 可见、标签写明「深度 <字段>」、其余两格无 is-editing */
    for (const type of ['depthTypical', 'depthUpperDev', 'depthLowerDev']) {
      closeSession();                                   /* 先收掉上一格留下的会话，观察量只归本格 */
      const clicked = clickCell(type);
      const body = String(fx.node('tkStdTable tbody').innerHTML);
      const others = ['depthTypical', 'depthUpperDev', 'depthLowerDev'].filter(t => t !== type);
      check(
        `FR-3.19 第③④步 解锁后点击「${FIELD_CN[type.slice('depth'.length)]}」数字进入录入态：该格带 is-editing（反色+高亮+闪烁）、` +
        '#tkStdEdit 可见、标签写明「录入 深度 ' + FIELD_CN[type.slice('depth'.length)] + '」、其余两格不进入',
        !!clicked && clicked.dataset.edit === type && hasEdit(type, body) &&
        others.every(t => !hasEdit(t, body)) &&
        fx.node('tkStdEdit').hidden === false &&
        String(fx.node('tkStdEditLabel').textContent || '') === '录入 深度 ' + FIELD_CN[type.slice('depth'.length)],
        `点击格=${JSON.stringify(clicked && clicked.dataset.edit)}（应 ${type}）；正文命中 is-editing：` +
        `本格=${hasEdit(type, body)}、其余=[${others.map(t => `${t}:${hasEdit(t, body)}`).join('、')}]；` +
        `#tkStdEdit.hidden=${fx.node('tkStdEdit').hidden}；标签=${JSON.stringify(String(fx.node('tkStdEditLabel').textContent || ''))}`
      );
    }
    closeSession();
    check(
      'FR-3.19 第③步 点击数字会重置"无操作回首页"计时并重新登记自动锁定（activity()：Dashboard.resetIdleTimer + SettingPanel.armAutoLock）',
      (() => {
        const lockMs = evalNumericExpr(constExpr(readText('src/components/SettingPanel.js'), 'AUTO_LOCK_MS'));
          fx.timers.length = 0;                        /* 只观察本次点击登记了什么 */
          const resetsBefore = fx.idleResets;
        fx.click(realCell('depthUpperDev'));
        const pending = fx.timers.filter(t => t.delay === lockMs && !t.cancelled && !t.fired).length;
        return pending === 1 && fx.idleResets === resetsBefore + 1;
      })(),
      `AUTO_LOCK_MS=${evalNumericExpr(constExpr(readText('src/components/SettingPanel.js'), 'AUTO_LOCK_MS'))} ms；` +
      `点击后存活自动锁定定时器=${fx.timers.filter(t => t.delay === evalNumericExpr(constExpr(readText('src/components/SettingPanel.js'), 'AUTO_LOCK_MS')) && !t.cancelled && !t.fired).length} 个；` +
      `回首页计时重置累计=${fx.idleResets} 次`
    );

    /* ---- (f) 第 ⑥ 步校验（V1.35 / C-91 按**偏差模型**重述）：6 个用例 + 2 个专项，逐条断言
       ①`alert` 弹窗且写明原因与"本次不写入" ②`state.task.standard` **逐字不变**（不写入）
       ③无残留 `is-editing` ④被拒留痕含被改单元格名与原因。
       "不写入"的判定对象是**标准取值**（unit/digits/typical/upperDev/lowerDev）逐字不变；
       `opLog` 会**增加一条"被拒绝"留痕**，那是 FR-3.19 的**预期**行为（并发录入逐条留痕），
       故快照比对必须把 opLog 排除在外 —— 否则会把"按规范留痕"误判成"非法值被写入"。
       实现侧依据：`commitSession()` 的每条校验分支都在 `ensureStd()`/写字段**之前** return。 */
    const stdKeys = ['unit', 'digits', 'typical', 'upperDev', 'lowerDev'];
    const stdDepth = () => fx.state.task.standard && fx.state.task.standard.depth;
    const stdDepthVals = () => JSON.stringify(stdKeys.map(k => (stdDepth() || {})[k]));
    /** 三格对应的中文标签（断言"被拒留痕含被改单元格名"用的就是它） */
    const LABEL_CN = { depthTypical: '深度 典型值', depthUpperDev: '深度 上偏差', depthLowerDev: '深度 下偏差' };
    /** 一次"非法录入"的完整观察：弹窗 / state 逐字不变 / 无残留 is-editing / 被拒留痕含单元格名与原因 */
    const illegalCase = (type, typed, wantRe, label) => {
      closeSession();                                    /* 收掉上一个用例留下的会话（不注入任何值） */
      fx.click(realCell(type));
      fx.input().value = typed;
      const beforeVals = stdDepthVals();
      const beforeLogs = fx.state.opLog.length;
      fx.alerts.length = 0;
      fx.screen('keydown');
      const msg = String(fx.alerts[0] || '');
      const last = fx.state.opLog[fx.state.opLog.length - 1] || {};
      const detail = String(last.detail || '');
      const stateSame = stdDepthVals() === beforeVals;
      const oneLog = fx.state.opLog.length === beforeLogs + 1;
      const noEditing = !/is-editing/.test(String(fx.node('tkStdTable tbody').innerHTML));
      const errShown = fx.node('tkStdEdit').hidden === true && /err/.test(String(fx.node('tkStdMsg').className || ''));
      /* 被拒留痕：**含被改单元格名与具体原因**（按"包含关系"判，不比对分隔符写法） */
      const logOk = /录入被拒绝/.test(detail) && detail.includes(LABEL_CN[type]) && wantRe.test(detail);
      const ok = fx.alerts.length === 1 && /本次不写入/.test(msg) && wantRe.test(msg) &&
        stateSame && oneLog && noEditing && errShown && logOk;
      const detailTxt =
        `alert=${JSON.stringify(msg.slice(0, 96))}（应匹配 ${wantRe} 且含「本次不写入」）；` +
        `标准取值${stateSame ? '未变' : '**被改动**'}（${beforeVals}）；opLog ${beforeLogs} → ${fx.state.opLog.length} 条（应 +1）；` +
        `残留 is-editing=${!noEditing}、#tkStdEdit.hidden=${fx.node('tkStdEdit').hidden}、#tkStdMsg.class=${JSON.stringify(String(fx.node('tkStdMsg').className || ''))}；` +
        `被拒留痕=${JSON.stringify(detail.slice(0, 96))}（应含「${LABEL_CN[type]}」与原因）`;
      check(
        `FR-3.19 第⑥步 校验用例「${label}」⇒ alert 弹窗写明原因与"本次不写入"、state.task.standard 逐字不变、` +
        '无残留 is-editing、且被拒留痕含被改单元格名与原因',
        ok, detailTxt
      );
      return { ok, msg, detail, stateSame, detailTxt };
    };

    T.ensureStd(fx.state, 'depth');
    T.ensureStd(fx.state, 'speed');
    /* 期望值一律从**配置/state 实算**（D21），不写死 5.35 / 4.60 / 6.20 这类数字 */
    const RANGE = STDCFG.range || {};
    const dRange = RANGE.depth || { min: null, max: null };
    const devTxt = v => (v >= 0 ? '+' : '') + r2(v).toFixed(digits);
    const CASE_LEDGER = [];
    CASE_LEDGER.push(illegalCase('depthTypical', 'abc',
      /未识别到有效数值/, '非数值（abc）'));
    CASE_LEDGER.push(illegalCase('depthTypical', '5.123',
      new RegExp(`小数位非法|最多 ${digits} 位小数`), `小数位非法（> standards.digits=${digits}）`));
    CASE_LEDGER.push(illegalCase('depthTypical', '-5.00',
      /非负绝对量/, '典型值带负号'));
    /* `下偏差 > 上偏差`：先把偏差复位成配置默认段，**并显式写 `+`**（不带符号会被归一成负值，
       根本到不了"下偏差 ≤ 上偏差"这条校验 —— 实测踩过），再注入 `+0.40 > 上偏差 +0.30`。 */
    CASE_LEDGER.push((() => {
      fx.state.task.standard.depth.typical = dep.typical;
      fx.state.task.standard.depth.upperDev = dep.upperDev;
      fx.state.task.standard.depth.lowerDev = dep.lowerDev;
      return illegalCase('depthLowerDev', devTxt(dep.upperDev + 0.10),
        /下偏差/, '下偏差 > 上偏差（违 下偏差 ≤ 上偏差）');
    })());
    CASE_LEDGER.push(illegalCase('depthUpperDev', devTxt(-0.10),
      /上偏差/, '上偏差为负（违 上偏差 ≥ 0 ≥ 下偏差）'));
    /* 下偏差为正：**必须显式写 `+`** —— 不带符号按"下偏差默认负"口径会被归一成负值
       （`normalizeNum('0.10','lowerDev') = -0.10`，那是 FR-3.19⑤ 的默认口径，不是"正则通过"）。
       构造 `lowerDev = +0.10` 后，`上偏差 ≥ 0 ≥ 下偏差` 的右半边不成立 ⇒ 应被拒。 */
    CASE_LEDGER.push(illegalCase('depthLowerDev', devTxt(0.10),
      /下偏差/, '下偏差为正（违 上偏差 ≥ 0 ≥ 下偏差）'));
    /* 超量程：改**典型值**（C-93④"整体平移不免检"）——典型值刻意取 `量程上限 − 上偏差 + 一格`，
       使**提交后**的导出上限恰越上界；判据里的数字全部由配置实算，不硬编码 5.90 / 6.20。 */
    {
      const grid = Math.pow(10, -digits);
      const overTypical = r2(r2(dRange.max - dep.upperDev) + grid);
      fx.state.task.standard.depth.typical = dep.typical;
      fx.state.task.standard.depth.upperDev = dep.upperDev;
      fx.state.task.standard.depth.lowerDev = dep.lowerDev;
      CASE_LEDGER.push(illegalCase('depthTypical', overTypical.toFixed(digits),
        /超出深度量程|超出.*量程/,
        `超量程（典型值 ${overTypical.toFixed(digits)} ＋ 上偏差 ${dep.upperDev.toFixed(digits)} ⇒ 上限 ${r2(overTypical + dep.upperDev).toFixed(digits)} ∉ [${dRange.min}, ${dRange.max}]）`));
    }
    CASE_LEDGER.forEach((c, i) => console.log(`  [校验用例 ${i + 1}] ${c.ok ? 'PASS' : '**FAIL**'} —— ${c.detailTxt}`));
    check(
      'FR-3.19 第⑥步 校验用例齐备（≥6 条：非数值 / 小数位非法 / 典型值带负号 / 下偏差 > 上偏差 / 上偏差为负 / 下偏差为正 / 超量程），每条都「弹窗 + state 逐字不变 + 无残留 is-editing + 被拒留痕」',
      CASE_LEDGER.length >= 6 && CASE_LEDGER.every(c => c.ok),
      `${CASE_LEDGER.length} 条用例全部通过=${CASE_LEDGER.every(c => c.ok)}；逐条：` +
      CASE_LEDGER.map((c, i) => `${i + 1}.${c.ok ? 'PASS' : '**FAIL**'}`).join(' ')
    );

    /* 典型值越界分支（FR-3.19 第⑥步 / C-91 校验⑥）：构造一个**下偏差 ≤ 上偏差 成立、但典型值落在导出区间外**
       的状态，再录下偏差 —— 应被「上偏差 ≥ 0 ≥ 下偏差」挡下。
       取 `upperDev = -0.40`（导出上限 4.60 < 典型值 5.00 ⇒ 当前区间本就不含典型值），
       注入 `lowerDev = -0.45`（导出下限 4.55 ≤ 导出上限 4.60，校验⑤通过），于是只剩校验⑥拦它。 */
    fx.state.task.standard.depth.typical = dep.typical;
    fx.state.task.standard.depth.upperDev = -0.40;
    fx.state.task.standard.depth.lowerDev = -0.50;
    const centeringCase = illegalCase('depthLowerDev', '-0.45',
      /上偏差 ≥ 0|小于 0/, '典型值高于导出上限（居中校验）');
    check(
      'FR-3.19 第⑥步 非法录入（典型值不在导出上下限之间）⇒ 弹窗且标准取值逐字不变（不写入）、被拒留痕含单元格名',
      centeringCase.ok,
      `alert=${JSON.stringify(centeringCase.msg.slice(0, 88))}；标准取值${centeringCase.stateSame ? '未变' : '**被改动**'}；` +
      `被拒留痕=${JSON.stringify(centeringCase.detail.slice(0, 88))}`
    );

    /* 上/下偏差**须同时存在或同时为空**（C-91 校验④）：把一侧置空，再提交另一侧 ⇒ 必须被挡下 */
    {
      fx.state.task.standard.depth.typical = dep.typical;
      fx.state.task.standard.depth.upperDev = null;
      fx.state.task.standard.depth.lowerDev = dep.lowerDev;
      const pairCase = illegalCase('depthLowerDev', devTxt(dep.lowerDev - 0.05),
        /同时存在或同时为空|只设了下偏差/, '只有一侧偏差（违「同时存在或同时为空」）');
      check(
        'FR-3.19 第⑥步 上/下偏差须同时存在或同时为空：只有一侧偏差时提交被拒（弹窗 + state 逐字不变 + 被拒留痕）',
        pairCase.ok,
        `alert=${JSON.stringify(pairCase.msg.slice(0, 88))}；标准取值${pairCase.stateSame ? '未变' : '**被改动**'}；` +
        `被拒留痕=${JSON.stringify(pairCase.detail.slice(0, 88))}`
      );
    }

    /* ---- (f2) 典型值为空：只校 `下偏差 ≤ 上偏差`，**跳过**居中校验与超量程校验（C-91 / C-93⑤） ----
       为什么必须单列：这是"跳过"语义的唯一机器证据 —— 若实现把超量程校验也照跑，偏差本身
       （不含量程内的典型值）会被判超量程而拒绝，本组用例立刻变红。
       用**全新夹具**（不动主夹具的 state），避免把"典型值为空"的残缺标准留给后面的用例。 */
    {
      const fx3 = loadTaskStdFixture(mkStdTaskState());
      const T3 = fx3.W.Components.TaskPanel;
      fx3.W.MockData.setUnlocked(true);
      T3.bind(fx3.state);
      T3.render(fx3.state);
      const cell3 = type => {
        const tb = fx3.node('tkStdTable').querySelector('tbody');
        return tb.__children.slice().reverse().map(r => r.__children.find(td => td.dataset.edit === type)).find(Boolean) || null;
      };
      /* 偏差本身**超量程**（14.00 / 15.00 远在深度量程之外），典型值置空 ⇒ 超量程校验应跳过 */
      const setTypicalNull = () => {
        T3.ensureStd(fx3.state, 'depth');
        fx3.state.task.standard.depth.typical = null;
        fx3.state.task.standard.depth.upperDev = r2(dRange.max + 8);
        fx3.state.task.standard.depth.lowerDev = r2(dRange.max + 7);
      };
      const threeOf = () => JSON.stringify(stdKeys.map(k => fx3.state.task.standard.depth[k]));
      /* ① 偏差超量程但典型值为空 ⇒ **应当写入成功**，导出上/下限显示占位（—）、三态 idle（不判定） */
      setTypicalNull();
      T3.render(fx3.state);
      fx3.alerts.length = 0;
      const beforeNull = threeOf();
      const nullDerivedRow = () => {
        const rows3 = parseStdRows(fx3.node('tkStdTable tbody').innerHTML);
        const row = rows3.find(r => r.kind === 'depth') || { tds: [] };
        return { row, d: derivedCell(rows3, 'depth') };
      };
      fx3.click(cell3('depthLowerDev'));
      fx3.input().value = r2(dRange.max + 7).toFixed(digits);
      fx3.screen('keydown');
      const nd = nullDerivedRow();
      check(
        'FR-3.19 第⑥步/FR-3.18 典型值为空时**跳过超量程校验**：偏差本身超量程仍可写入，且导出上/下限显示占位（—）、不判定（三态 idle）',
        fx3.alerts.length === 0 && threeOf() !== beforeNull &&
        derivedLimits(nd.d && nd.d.text, digits) === null && /—/.test(stdCellText(nd.d)) &&
        /std-state idle/.test(String(fx3.node('tkStdTable tbody').innerHTML)),
        `alert=${fx3.alerts.length} 次（应 0）；标准 ${beforeNull} → ${threeOf()}；` +
        `导出格文本=${JSON.stringify(stdCellText(nd.d))}（解析值=${JSON.stringify(derivedLimits(nd.d && nd.d.text, digits))}，应占位 —）；` +
        `三态 idle=${/std-state idle/.test(String(fx3.node('tkStdTable tbody').innerHTML))}`
      );
      /* ② 典型值仍为空、且 `下偏差 > 上偏差` ⇒ 本项校验**仍要跑**（只跳过居中与超量程）。
         构造口径：两侧偏差都超量程（故只有"跳过超量程"才可能通过），且**上偏差取负值** ——
         这样"不带符号按默认负"的下偏差（`-13.50`）才会**大于**上偏差（`-14.00`），
         于是唯一可能拦住它的就是校验⑤（`下偏差 ≤ 上偏差`）。
         同一构造再跑一次**反向输入**（下偏差 `-14.50 < -14.00`）⇒ 必须**写入成功** ——
         两侧合起来才算证明"拦它的是 ⑤，不是别的校验"（单侧只证明"有个弹窗"）。 */
      const setNegPair = () => {
        T3.ensureStd(fx3.state, 'depth');
        fx3.state.task.standard.depth.typical = null;
        fx3.state.task.standard.depth.upperDev = r2(dRange.max - 20);   /* = -14.00 */
        fx3.state.task.standard.depth.lowerDev = r2(dRange.max - 19);   /* = -13.00 */
      };
      setNegPair();
      T3.render(fx3.state);
      fx3.alerts.length = 0;
      fx3.click(cell3('depthLowerDev'));
      fx3.input().value = '13.50';                                      /* 无符号 ⇒ 归一为 -13.50 > 上偏差 -14.00 */
      const beforeBadPair = threeOf();
      fx3.screen('keydown');
      const badPairMsg = String(fx3.alerts[0] || '');
      const badPairStable = threeOf() === beforeBadPair;
      const badPairAlerts = fx3.alerts.length;
      const badPairNoEditing = !/is-editing/.test(String(fx3.node('tkStdTable tbody').innerHTML));
      /* 反向对照：`14.50` ⇒ 归一为 `-14.50 < -14.00` ⇒ 校验⑤通过 ⇒ 必须**写入成功** */
      setNegPair();
      T3.render(fx3.state);
      fx3.alerts.length = 0;
      fx3.click(cell3('depthLowerDev'));
      fx3.input().value = '14.50';
      const beforeOkPair = threeOf();
      fx3.screen('keydown');
      check(
        'FR-3.19 第⑥步 典型值为空时**仍校 `下偏差 ≤ 上偏差`**：下偏差 > 上偏差 ⇒ 弹窗且 state 逐字不变；反向输入（下偏差更小）⇒ 写入成功（两侧对照）',
        badPairAlerts === 1 && /下偏差/.test(badPairMsg) && /上偏差/.test(badPairMsg) && /本次不写入/.test(badPairMsg) &&
        badPairStable && badPairNoEditing &&
        fx3.alerts.length === 0 && threeOf() !== beforeOkPair,
        `下偏差 > 上偏差：alert=${JSON.stringify(badPairMsg.slice(0, 88))}、state 逐字不变=${badPairStable}、无残留 is-editing=${badPairNoEditing}；` +
        `反向（下偏差 -14.50 < 上偏差 -14.00）：alert=${fx3.alerts.length} 次（应 0）、state ${beforeOkPair} → ${threeOf()}（应已写入）`
      );
    }

    /* ---- (g) 第 ⑤⑥ 步：不带符号按默认口径（下偏差负、上偏差正）＋ 回车/点击其他区域注入 ---- */
    fx.state.task.standard.depth.typical = dep.typical;              /* 复位为配置典型值，便于实算比对 */
    /* 同时把偏差复位成**配置默认段**：上面的用例刻意把上/下偏差改成 −0.40 / −0.50（造"典型值越界"），
       若不复位，本用例注入 −0.35 会让导出下限 4.65 > 导出上限 4.60，被"下偏差 ≤ 上偏差"挡下（实测踩过）。 */
    fx.state.task.standard.depth.upperDev = dep.upperDev;
    fx.state.task.standard.depth.lowerDev = dep.lowerDev;
    closeSession();                                                  /* 收掉上一个用例留下的会话 */
    fx.click(realCell('depthLowerDev'));
    fx.input().value = '0.35';                                       /* 无符号 ⇒ 下偏差应为 −0.35 */
    const beforeLower = stdDepth().lowerDev;
    fx.screen('keydown');                                            /* 回车 = 退出并注入 */
    const lowerAfter = stdDepth().lowerDev;
    const lowerDerived = derivedLimits(derivedCell(parseStdRows(fx.node('tkStdTable tbody').innerHTML), 'depth') &&
      derivedCell(parseStdRows(fx.node('tkStdTable tbody').innerHTML), 'depth').text, digits);
    check(
      'FR-3.19 第⑤⑥步 无符号输入按默认口径（下偏差默认负）：回车退出并注入，导出下限＝典型值＋(输入取负)，画面随之刷新',
      lowerAfter === -0.35 && lowerAfter !== beforeLower && lowerDerived !== null &&
      lowerDerived.lower === r2(dep.typical - 0.35) && lowerDerived.upper === r2(dep.typical + dep.upperDev),
      `下偏差 ${beforeLower} → ${lowerAfter}（应 −0.35）；导出格=${JSON.stringify(lowerDerived)} 应={上限 ${r2(dep.typical + dep.upperDev)}, 下限 ${r2(dep.typical - 0.35)}}`
    );
    fx.click(realCell('depthUpperDev'));
    fx.input().value = '0.35';                                       /* 无符号 ⇒ 上偏差应为 +0.35 */
    fx.screen('blur');                                               /* 失焦 = 点击其他区域，同样退出并注入 */
    const upperAfter = stdDepth().upperDev;
    const upperDerived = derivedLimits(derivedCell(parseStdRows(fx.node('tkStdTable tbody').innerHTML), 'depth') &&
      derivedCell(parseStdRows(fx.node('tkStdTable tbody').innerHTML), 'depth').text, digits);
    check(
      'FR-3.19 第⑤⑥步 无符号输入按默认口径（上偏差默认正）：失焦（点击其他区域）退出并注入，导出上限＝典型值＋输入、下限不动',
      upperAfter === 0.35 && upperDerived !== null &&
      upperDerived.upper === r2(dep.typical + 0.35) && upperDerived.lower === r2(dep.typical - 0.35),
      `上偏差=${upperAfter}（应 +0.35）；导出格=${JSON.stringify(upperDerived)} 应={上限 ${r2(dep.typical + 0.35)}, 下限 ${r2(dep.typical - 0.35)}（不动）}`
    );

    /* ---- (g2) V1.35 / C-90 导出值语义②：**改典型值 ⇒ 上下限随偏差整体平移**；改偏差 ⇒ 仅对应一侧变化 ----
       判据全部从 state 与配置实算：平移量 = 新典型值 − 旧典型值；跨度（上限−下限）应保持不变
       （它只由两个偏差决定）。**不硬编码 5.10 / 5.40 / 4.90**。 */
    {
      const depthState = () => fx.state.task.standard.depth;
      const boundsOf = kind => {
        const rowsNow = parseStdRows(fx.node('tkStdTable tbody').innerHTML);
        return derivedLimits(derivedCell(rowsNow, kind) && derivedCell(rowsNow, kind).text, digits);
      };
      const spanOf = b => (b ? r2(b.upper - b.lower) : null);
      /* ① 典型值 5.00 → 5.10：两侧同步平移 +0.10，偏差与跨度不变 */
      const newTypical = r2(dep.typical + 0.10);
      const before1 = { t: depthState().typical, u: depthState().upperDev, l: depthState().lowerDev, b: boundsOf('depth') };
      closeSession();
      fx.click(realCell('depthTypical'));
      fx.input().value = newTypical.toFixed(digits);
      fx.screen('keydown');
      const after1 = { t: depthState().typical, u: depthState().upperDev, l: depthState().lowerDev, b: boundsOf('depth') };
      const shift = r2(newTypical - before1.t);
      check(
        'FR-3.19 第⑥步/FR-3.18 改典型值 ⇒ 导出上下限**整体平移**（同幅同向）、两个偏差格与跨度不变（按 state 实算，非硬编码）',
        after1.t === newTypical && after1.u === before1.u && after1.l === before1.l && after1.b !== null && before1.b !== null &&
        r2(after1.b.upper - before1.b.upper) === shift && r2(after1.b.lower - before1.b.lower) === shift &&
        spanOf(after1.b) === spanOf(before1.b),
        `典型值 ${before1.t} → ${after1.t}（平移量 ${shift}）；导出 ${JSON.stringify(before1.b)} → ${JSON.stringify(after1.b)}；` +
        `偏差 上=${before1.u}→${after1.u}、下=${before1.l}→${after1.l}；跨度 ${spanOf(before1.b)} → ${spanOf(after1.b)}`
      );
      /* ② 只改上偏差 +0.30 → +0.50：仅导出上限上移 +0.20，导出下限**逐字不变** */
      const newUpperDev = r2(dep.upperDev + 0.20);
      const before2 = { u: depthState().upperDev, l: depthState().lowerDev, b: boundsOf('depth') };
      closeSession();
      fx.click(realCell('depthUpperDev'));
      fx.input().value = ('+' + newUpperDev.toFixed(digits));
      fx.screen('keydown');
      const after2 = { u: depthState().upperDev, l: depthState().lowerDev, b: boundsOf('depth') };
      check(
        'FR-3.19 第⑥步/FR-3.18 改上偏差 ⇒ **仅对应一侧**变化：导出上限上移、导出下限逐字不变、下偏差格不变（按 state 实算）',
        after2.u === newUpperDev && after2.l === before2.l && after2.b !== null && before2.b !== null &&
        r2(after2.b.upper - before2.b.upper) === r2(newUpperDev - before2.u) &&
        after2.b.lower === before2.b.lower,
        `上偏差 ${before2.u} → ${after2.u}（Δ${r2(after2.u - before2.u)}）；下偏差 ${before2.l} → ${after2.l}；` +
        `导出 ${JSON.stringify(before2.b)} → ${JSON.stringify(after2.b)}（下限应逐字不变）`
      );
    }

    /* ---- (h) Esc / 取消：不注入 ---- */
    const speedValsBefore = JSON.stringify(['upperDev', 'lowerDev'].map(k => (fx.state.task.standard.speed || {})[k]));
    fx.click(realCell('speedUpperDev'));
    fx.input().value = '0.90';
    const logCountBefore3 = fx.state.opLog.length;
    fx.alerts.length = 0;
    fx.screen('keydown', 'Escape');                    /* Esc：与"回车注入"形成对照 */
    check(
      'FR-3.19 第⑥步 Esc 取消不注入：标准取值与显示逐字不变、不弹窗、录入态退出（与"回车注入"形成对照）',
      JSON.stringify(['upperDev', 'lowerDev'].map(k => (fx.state.task.standard.speed || {})[k])) === speedValsBefore &&
      fx.alerts.length === 0 && fx.node('tkStdEdit').hidden === true &&
      !/is-editing/.test(String(fx.node('tkStdTable tbody').innerHTML)) &&
      fx.state.opLog.length === logCountBefore3 + 1 &&
      /取消.*录入/.test(String((fx.state.opLog[fx.state.opLog.length - 1] || {}).detail || '')),
      `speed 偏差${JSON.stringify(['upperDev', 'lowerDev'].map(k => (fx.state.task.standard.speed || {})[k])) === speedValsBefore ? '未变' : '**被改动**'}；` +
      `alert=${fx.alerts.length} 次；#tkStdEdit.hidden=${fx.node('tkStdEdit').hidden}；` +
      `末条日志=${JSON.stringify(String((fx.state.opLog[fx.state.opLog.length - 1] || {}).detail || '').slice(0, 40))}`
    );

    /* ---- (i) 第 ⑦ 步：留痕（内容、时间戳、班组编号） ----
       先补一次**成功注入**（Esc 取消只留"取消"日志，取末条会取到取消记录 —— 实测踩过），
       再看该条日志的内容/时间戳/班组编号。 */
    closeSession();
    fx.click(realCell('speedLowerDev'));
    fx.input().value = '0.25';
    fx.screen('keydown');                                            /* 回车注入（无符号 ⇒ 下偏差 −0.25） */
    const log = fx.state.opLog[fx.state.opLog.length - 1] || {};
    const detail = String(log.detail || '');
    /** 「被改单元格『<参数> <字段>』」——逐单元格留痕的锚（C-90⑦ 的"被改单元格"） */
    const logCellOf = d => {
      const m = /「([^」]+)」/.exec(String(d || ''));
      return m ? m[1] : null;
    };
    /** 从形如 `-0.20 → -0.25` 的片段里取"修改前 → 修改后"；**取全部命中**（不是只取第一处）。
     *  为什么必须取全：成功回执 `lastInfo` 与留痕 `detail` 里各有一次 `导出上限 X → Y`，
     *  被拒日志里更有两次（lastInfo 段 + detail 段）—— 只取第一处的话，
     *  "实现把后一处删掉"这类变异照样能绿（D22 变异 M8 实测踩过：改 `limitTxt` 后仍被判"命中"）。
     *  @returns {Array<{from:number,to:number}>} 全部命中（按出现次序） */
    const pairsOf = (d, key) => [...String(d || '').matchAll(
      new RegExp(key + '[^；]*?(-?\\d+(?:\\.\\d+)?)\\s*→\\s*(-?\\d+(?:\\.\\d+)?)', 'g'))]
      .map(m => ({ from: Number(m[1]), to: Number(m[2]) }));
    const pairOf = (d, key) => pairsOf(d, key)[0] || null;
    const devPair = pairOf(detail, '被改单元格');
    const upperPairs = pairsOf(detail, '导出上限');
    const lowerPairs = pairsOf(detail, '导出下限');
    const boundsPair = { upper: upperPairs[0] || null, lower: lowerPairs[0] || null };
    check(
      'FR-3.19 第⑦步 成功留痕（①内容）：state.opLog 末条写明**被改单元格名**与**修改前后值**（按元数据实算，非字面比对），且导出上/下限各恰一处',
      fx.state.opLog.length > 0 && log.action === '测试标准录入' &&
      logCellOf(detail) === '速度 下偏差' && devPair !== null &&
      devPair.to === -0.25 && Number.isFinite(devPair.from) && devPair.from !== devPair.to &&
      boundsPair.upper !== null && boundsPair.lower !== null && boundsPair.lower.to === r2(5.00 - 0.25) &&
      /* 留痕里 `导出上限 X → Y` 与 `导出下限 X → Y` 应**各恰 1 处**（opLog 的 detail 就是被记下来的原文）；
         少一处即"留痕被削弱"，本断言变红（D22 变异 M8 正是打这里：把 limitTxt 的前缀删掉）。
         注：`state.opLog` 的 detail 里只有留痕那一份，成功回执 `lastInfo` **不进 opLog**，故不是 2 处。 */
      upperPairs.length === 1 && lowerPairs.length === 1 &&
      upperPairs[0].from === boundsPair.upper.from && lowerPairs[0].from === boundsPair.lower.from,
      `被改单元格=${JSON.stringify(logCellOf(detail))}；改动前后=${JSON.stringify(devPair)}；` +
      `导出上限命中 ${upperPairs.length} 处=${JSON.stringify(upperPairs)}、导出下限命中 ${lowerPairs.length} 处=${JSON.stringify(lowerPairs)}（应各 2 处且逐处同值）；` +
      `末条日志=${JSON.stringify({ action: log.action, time: log.time, date: log.date, detail: detail.slice(0, 150) })}`
    );
    check(
      'FR-3.19 第⑦步 成功留痕（②时间戳与班组编号）：生效时间＝state.clock 的日期＋时刻、班组编号＝config.shift.roster.teamId（留痕由 MockData.pushLog 记录）',
      /\d{2}:\d{2}:\d{2}/.test(String(log.time || '')) &&
      new RegExp('生效时间 ' + fx.state.clock.date + ' ' + fx.state.clock.time).test(detail) &&
      detail.includes(fx.W.BoardConfig.shift.roster.teamId),
      `log.time=${JSON.stringify(log.time)}、log.date=${JSON.stringify(log.date)}；` +
      `期望时间戳=${JSON.stringify(fx.state.clock.date + ' ' + fx.state.clock.time)}、班组编号=${JSON.stringify(fx.W.BoardConfig.shift.roster.teamId)}；` +
      `detail=${JSON.stringify(detail.slice(0, 120))}`
    );
    /* 被拒路径留痕（②要求）：同样含**被改单元格名**与**具体原因**，并再次确认 state 逐字不变。
       为什么用"改典型值 ⇒ 超量程"这一支：它的原因文本带具体数值与量程（`超出深度量程 [4.00, 6.00]`），
       比"未识别到有效数值"更能证明"原因被逐字记进留痕"（不是只记一句"被拒绝"）。 */
    {
      const grid = Math.pow(10, -digits);
      const overTypical = r2(r2(dRange.max - dep.upperDev) + grid);
      fx.state.task.standard.depth.typical = dep.typical;
      fx.state.task.standard.depth.upperDev = dep.upperDev;
      fx.state.task.standard.depth.lowerDev = dep.lowerDev;
      const rej = illegalCase('depthTypical', overTypical.toFixed(digits),
        /超出深度量程|超出.*量程/, '被拒留痕专项（改典型值 ⇒ 超量程）');
      const rejLabel = logCellOf(rej.detail);
      const rejReason = (/录入被拒绝/.test(rej.detail) ? String(rej.detail).split(/录入被拒绝/)[1] : '') || '';
      check(
        'FR-3.19 第⑦步 被拒路径留痕：opLog 记「被改单元格名 + 具体原因（含导出值/量程）」，且 state.task.standard 逐字不变、无残留 is-editing',
        rej.ok && rejLabel !== null && rejLabel.includes('深度 典型值') &&
        /超出深度量程|超出.*量程/.test(rejReason) &&
        new RegExp(String(dRange.max)).test(rejReason) && rejReason !== '',
        `被改单元格=${JSON.stringify(rejLabel)}；被拒原因=${JSON.stringify(rejReason.slice(0, 96))}；` +
        `state 逐字不变=${rej.stateSame}；alert=${JSON.stringify(rej.msg.slice(0, 80))}`
      );
    }
    check(
      'FR-3.19 配套约束"修改成功前不改动现有值与显示"：取消/非法录入不留半成品（日志只记录被拒绝与取消，state 里没有未成功生效的标准行）',
      fx.state.opLog.some(o => /录入被拒绝/.test(String(o.detail || ''))) &&
      fx.state.opLog.some(o => /取消.*录入/.test(String(o.detail || ''))) &&
      /^CP-2026-A17$/.test(String(fx.state.task.standard.productCode || '')) &&
      fx.state.task.standard.revision >= 2,
      `opLog 动作=${fx.state.opLog.map(o => o.action).join('/')}；` +
      `standard.productCode=${JSON.stringify(fx.state.task.standard.productCode)}、revision=${fx.state.task.standard.revision}`
    );

    /* ---- (j) 第 ⑧ 步 锁定语义：录入会话中 activity() 重置回首页计时 + 重新 arm（同一个 5 分钟计时器） ----
       ⚠️ 计数必须在**本次点击之前**取：上一条校验用例（被拒）已经退出会话、不会再触发 activity()，
       若在这之后仍调一次收尾，`fx.idleResets` 会被那次收尾的 activity() 先加 1（实测踩过）。 */
    {
      const lockMs2 = evalNumericExpr(constExpr(readText('src/components/SettingPanel.js'), 'AUTO_LOCK_MS'));
      fx.timers.length = 0;
      const resetsBefore = fx.idleResets;
      fx.click(realCell('depthUpperDev'));
      check(
        'FR-3.19 第⑧步 锁定＝与 FR-8.2 同一个 5 分钟无操作计时器：录入动作触发 activity() 时先重置回首页计时、再重新 arm 自动锁定（各 1 次、只存活 1 个计时器）',
        fx.idleResets === resetsBefore + 1 &&
        fx.timers.filter(t => t.delay === lockMs2 && !t.cancelled && !t.fired).length === 1 &&
        fx.timers.filter(t => t.cancelled).length === 0,
        `回首页计时重置次数 ${resetsBefore} → ${fx.idleResets}；存活 ${lockMs2} ms 自动锁定定时器 ` +
        `${fx.timers.filter(t => t.delay === lockMs2 && !t.cancelled && !t.fired).length} 个；` +
        `已取消 ${fx.timers.filter(t => t.cancelled).length} 个（应为 0：本次仅 arm 一次）`
      );
      closeSession();                                                   /* 收掉本次会话，使下一步只观察"又一次动作" */
      const cancelledBefore = fx.timers.filter(t => t.delay === lockMs2 && t.cancelled).length;
      fx.click(realCell('speedLowerDev'));                              /* 第二个动作：重复 arm 不堆叠 */
      check(
        'FR-3.19 第⑧步 连续录入动作不堆叠自动锁定计时（第二次 arm ⇒ 仍只存活 1 个、且把上一次的计时 clearTimeout 掉）',
        fx.timers.filter(t => t.delay === lockMs2 && !t.cancelled && !t.fired).length === 1 &&
        fx.timers.filter(t => t.delay === lockMs2 && t.cancelled).length === cancelledBefore + 1,
        `存活=${fx.timers.filter(t => t.delay === lockMs2 && !t.cancelled && !t.fired).length} 个、` +
        `被取消=${fx.timers.filter(t => t.delay === lockMs2 && t.cancelled).length} 个（本次动作前 ${cancelledBefore} 个）`
      );
    }
    /* ---- (k) 第 ⑧ 步 锁定后点击数字不进入录入态 + 可观察反馈 ----
       本用例**必须换一副全新夹具**：`renderMsg()` 的择一顺序是
       `lastErr → lastInfo → session → 未解锁提示 → 已解锁提示`，而 `lastInfo` 是组件模块级的
       "最近一次成功回执"，上面几条用例刚注入过一串成功值 ⇒ 复用旧夹具时锁定提示会被 lastInfo
       顶掉（实测踩过：`#tkStdMsg` 读到的仍是"录入中…/xx 已更新…"）。
       新夹具 = 真 TaskPanel + 真 armAutoLock 计时，且从"未解锁"起步，走最短真路径：
       render（未解锁）→ setUnlocked(true) → 点击数字（进入录入态）→ 收尾 →
       setUnlocked(false) → render（每秒 renderAll 的等效动作）→ 点击数字（**不**进入录入态）。 */
    {
      const fx2 = loadTaskStdFixture(mkStdTaskState());
      const T2 = fx2.W.Components.TaskPanel;
      fx2.W.MockData.setUnlocked(false);
      T2.bind(fx2.state);
      T2.render(fx2.state);
      const cellOf = type => {
        const tb = fx2.node('tkStdTable').querySelector('tbody');
        return tb.__children.slice().reverse().map(r => r.__children.find(td => td.dataset.edit === type)).find(Boolean) || null;
      };
      fx2.W.MockData.setUnlocked(true);
      fx2.click(cellOf('depthUpperDev'));                              /* 解锁 ⇒ 进入录入态（真路径） */
      const enteredWhenUnlocked = fx2.node('tkStdEdit').hidden === false;
      fx2.screen('keydown', 'Escape');                                 /* 收尾：Esc 取消（不注入、且清掉回执态） */
      fx2.W.MockData.setUnlocked(false);                               /* 自动锁定到点 ⇒ 解锁态失效 */
      T2.render(fx2.state);                                            /* 每秒 renderAll 一次：锁定提示在这里写入 */
      const msgLocked = String(fx2.node('tkStdMsg').textContent || '');
      fx2.click(cellOf('depthUpper'));                                 /* 锁定后的第一次点击 */
      check(
        'FR-3.19 第⑧步 锁定后点击数字不进入录入态并给出可观察反馈（#tkStdEdit 隐藏、该格无 is-editing、#tkStdMsg 明示"当前已锁定…解锁"）',
        enteredWhenUnlocked && fx2.node('tkStdEdit').hidden === true &&
        !/is-editing/.test(String(fx2.node('tkStdTable tbody').innerHTML)) &&
        /当前已锁定/.test(msgLocked) && /解锁/.test(msgLocked) &&
        String(fx2.node('tkStdMsg').textContent || '') === msgLocked,
        `解锁态点击进入录入态=${enteredWhenUnlocked}；锁定后 #tkStdEdit.hidden=${fx2.node('tkStdEdit').hidden}、` +
        `含 is-editing=${/is-editing/.test(String(fx2.node('tkStdTable tbody').innerHTML))}；` +
        `#tkStdMsg=${JSON.stringify(msgLocked.slice(0, 46))}`
      );
    }
  }

  /* ===== U4 每秒整屏重绘的副作用 ===== */
  section('U4 每秒 renderAll 的副作用（NFR-01）');
  {
    ui.out.length = 0;
    const s = W.MockData.state;
    const renders = [
      ['HeaderBar', () => W.Components.HeaderBar.render(s)],
      ['TabsBar', () => W.Components.TabsBar.renderLinkStatus(s)],
      ['DeviceStatusPanel', () => W.Components.DeviceStatusPanel.render(s)],
      ['TaskPanel', () => W.Components.TaskPanel.render(s)],
      ['ShiftPanel', () => W.Components.ShiftPanel.render(s)],
      ['StatsPanel', () => W.Components.StatsPanel.render(s)],
      ['AlarmPanel', () => W.Components.AlarmPanel.render(s)],
      ['MaintPanel', () => W.Components.MaintPanel.render(s)],
      ['NoticePanel', () => W.Components.NoticePanel.render(s)],
      ['SettingPanel', () => W.Components.SettingPanel.render(s)]
    ];
    const errors = [];
    for (const [name, fn] of renders) {
      try { fn(); } catch (e) { errors.push(`${name}: ${e.message}`); }
    }
    check('每个组件的 render() 都不抛异常（满数据）', errors.length === 0, errors.join('；'));

    const writes = ui.out.filter(e => e.kind === 'write');
    check(
      'render() 不得写表单控件的 value（否则用户输入会被每秒清空）',
      writes.length === 0,
      writes.map(e => e.id).join('、')
    );
    const listens = ui.out.filter(e => e.kind === 'listen');
    check(
      'render() 不得注册事件监听（否则每秒累积监听器）',
      listens.length === 0,
      listens.map(e => e.id).join('、')
    );
  }

  /* ===== U5 性能微基准（NFR-01：1 秒刷新周期） ===== */
  section('U5 单次刷新耗时与内存微基准（NFR-01）');
  {
    const M = W.MockData;
    const s = M.state;
    const renders = [
      () => W.Components.HeaderBar.render(s),
      () => W.Components.TabsBar.renderLinkStatus(s),
      () => W.Components.DeviceStatusPanel.render(s),
      () => W.Components.TaskPanel.render(s),
      () => W.Components.ShiftPanel.render(s),
      () => W.Components.StatsPanel.render(s),
      () => W.Components.AlarmPanel.render(s),
      () => W.Components.MaintPanel.render(s),
      () => W.Components.NoticePanel.render(s),
      () => W.Components.SettingPanel.render(s)
    ];
    const cycle = t => {
      M.tick(new Date(t));
      for (const r of renders) r();
    };
    for (let i = 0; i < 50; i++) { cycle(Date.now() + i * 1000); ui.out.length = 0; }   // 预热

    const N = 2000;
    const base = new Date('2026-09-18T08:00:00').getTime();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      cycle(base + i * 1000);
      ui.out.length = 0;                 // 丢弃捕获记录，避免把"记录增长"误判成内存泄漏
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    const heapAfter = process.memoryUsage().heapUsed;
    const growthMb = (heapAfter - heapBefore) / 1024 / 1024;

    check('单次 tick + 10 个组件全量重绘耗时 < 200 ms（1 秒周期内绰绰有余）', ms < 200,
      `${ms.toFixed(2)} ms/次（模拟 ${N} 次，每次 tick 并重绘全部组件）`);
    /* 堆增长只有在能强制 GC 时才有意义：否则量到的是"尚未回收的临时对象"而非泄漏 */
    if (typeof global.gc !== 'function') {
      skip('连续刷新后的堆增长（内存泄漏粗筛）',
        `未启用 --expose-gc，本次量到 ${growthMb.toFixed(1)} MB 属未回收临时对象；需要精确结论时用 node --expose-gc tests/ui-check.js`);
    } else {
      global.gc();
      const settled = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
      check('连续 2000 次刷新后堆增长 < 20 MB（强制 GC 后）', settled < 20,
        `堆增长 ${settled.toFixed(2)} MB`);
    }
    console.log(`        参考：${(1000 / Math.max(ms, 0.001)).toFixed(0)} 次/秒的处理能力上限`);
  }

  /* ===== U6 需求条款余项：FR-5～FR-9 与 NFR-11（本轮新增） ===== */
  section('U6 需求条款余项（FR-5～FR-9 / NFR-11/15）');
  {
    const mainSrc = readText('src/main.js');
    const dashSrc = readText('src/pages/Dashboard.js');
    const setSrc = readText('src/components/SettingPanel.js');
    const mockSrc = readText('src/services/mockData.js');
    const allSrc = [mainSrc, dashSrc, setSrc, mockSrc].join('\n');

    check(
      'FR-8.2 解锁状态超时（5 分钟）自动锁定',
      /setUnlocked\(\s*false\s*\)/.test(allSrc) && /(5\s*\*\s*60|300000|5\s*\*\s*60\s*\*\s*1000)/.test(allSrc),
      '只有手动「锁定」按钮会置 false，没有"解锁后 5 分钟自动锁定"的计时'
    );

    /* ---- F-02 回归护栏（审查发现 F-02：解锁 5 min 曾**早于**回首页 3 min ⇒ 回首页时解锁态仍可能有效）
       V1.32 口径：FR-8.2 锁定 5 分钟（300000 ms）先发生；FR-9.4 回首页默认 5 分 10 秒（310000 ms）
       后发生。前两条只做**数值**判定（先把常量表达式求值，再比大小 / 比差值），
       后四条是弹窗契约与行为断言 —— 一律不做源码字符串匹配（ADR-0004 D23）。 ---- */
    let lockMs = null;
    let returnMs = null;
    let tipMs = null;
    let constErr = null;
    try {
      lockMs = evalNumericExpr(constExpr(setSrc, 'AUTO_LOCK_MS'));
      returnMs = evalNumericExpr(constExpr(dashSrc, 'IDLE_RETURN_MS'));
      tipMs = evalNumericExpr(constExpr(setSrc, 'AUTO_LOCK_TIP_MS'));
    } catch (e) {
      constErr = e.message;
    }

    check(
      'F-02 时序护栏（FR-8.2/FR-9.4）：AUTO_LOCK_MS < IDLE_RETURN_MS 且差值恰为 10000 ms（锁定先于回首页 10 s）',
      constErr === null && lockMs < returnMs && returnMs - lockMs === 10000,
      constErr
        ? `常量表达式无法求值：${constErr}`
        : `AUTO_LOCK_MS=${lockMs}，IDLE_RETURN_MS=${returnMs}，差值=${returnMs - lockMs} ms（应为 10000）`
    );
    check(
      'FR-8.2/FR-9.4 数值口径：自动锁定 300000 ms（5 分钟）、回首页 310000 ms（5 分 10 秒）',
      constErr === null && lockMs === 300000 && returnMs === 310000,
      constErr ? `常量表达式无法求值：${constErr}` : `AUTO_LOCK_MS=${lockMs}（应 300000），IDLE_RETURN_MS=${returnMs}（应 310000）`
    );

    /* (b) 弹窗静态契约：节点、初始隐藏、两个子节点、2 s 时长、防定时器堆叠 */
    const tipOpen = html.match(/<div[^>]*\bid="autoLockTip"[^>]*>/);
    const tipStart = tipOpen ? html.indexOf(tipOpen[0]) : -1;
    const tipEnd = tipStart >= 0 ? html.indexOf('</div>', tipStart) : -1;
    const tipBlock = tipEnd > tipStart ? html.slice(tipStart, tipEnd) : '';
    check(
      'F-02 弹窗 DOM 契约（FR-8.2）：#autoLockTip 存在、初始带 hidden、且含标题与正文两个子节点',
      tipOpen !== null && /\shidden(?=[\s>])/.test(tipOpen[0]) &&
        tipBlock.includes('id="autoLockTipTitle"') && tipBlock.includes('id="autoLockTipText"'),
      tipOpen === null
        ? 'index.html 里没有 id="autoLockTip" 的节点'
        : `起始标签=${tipOpen[0]}；子节点=${tipBlock.includes('id="autoLockTipTitle"') ? '有' : '缺'}标题 / ` +
          `${tipBlock.includes('id="autoLockTipText"') ? '有' : '缺'}正文`
    );
    const tipBody = functionBody(setSrc, 'showAutoLockTip');
    check(
      'F-02 提示时长（FR-8.2）：AUTO_LOCK_TIP_MS = 2000 ms，且 showAutoLockTip 内先 clearTimeout（不堆叠定时器）',
      tipMs === 2000 && tipBody !== null && /clearTimeout\s*\(/.test(tipBody),
      `AUTO_LOCK_TIP_MS=${tipMs}（应 2000）；showAutoLockTip ` +
      (tipBody === null ? '未找到函数体' : (/clearTimeout\s*\(/.test(tipBody) ? '内有 clearTimeout' : '内无 clearTimeout'))
    );

    /* (c) 行为断言：走真路径（bind → 解锁 → 自动锁定回调 → 提示隐藏回调 → 手动锁定分支） */
    {
      let seqErr = null;
      let unlockedAfter = null;
      let tipShown = false;
      let tipTimersAfter = 0;
      let tipHiddenAgain = false;
      let manualQuiet = false;
      const steps = [];
      try {
        const fx = loadAutoLockFixture();
        const M = fx.w.MockData;
        const tip = fx.node('autoLockTip');
        tip.hidden = true;                        /* 对应 index.html 的初始 `hidden` 属性 */
        let activity = 0;
        fx.w.Components.SettingPanel.bind(M.state, () => { activity++; });

        /* 真口令（演示密码 8888，见 mockData 的 CFG.unlockPassword）走 #setUnlockBtn 的 click 处理 */
        fx.nodes.get('setPwd').value = M.CFG.unlockPassword;
        fx.click('setUnlockBtn');
        steps.push(`解锁后 state.unlocked=${M.state.unlocked}`,
          `登记定时器=[${fx.timers.filter(x => !x.cancelled).map(x => x.delay).join(',')}] ms`,
          `onActivity 回调 ${activity} 次`);

        fx.fire(300000);                          /* 触发自动锁定回调 */
        unlockedAfter = M.state.unlocked;
        tipShown = tip.hidden === false && tip.classList.contains('show');
        tipTimersAfter = fx.timers.filter(x => x.delay === 2000 && !x.fired).length;
        steps.push(`300000 ms 回调后 state.unlocked=${unlockedAfter}，弹窗显示=${tipShown}，` +
          `新登记 2000 ms 定时器 ${tipTimersAfter} 个`);

        fx.fire(2000);                            /* 触发提示 2 s 自动隐藏回调 */
        tipHiddenAgain = tip.hidden === true && !tip.classList.contains('show');
        steps.push(`2000 ms 回调后弹窗回到隐藏态=${tipHiddenAgain}`);

        /* 手动「锁定」分支：只锁不弹（弹窗只属于自动锁定） */
        tip.hidden = true;
        tip.classList.remove('show');
        fx.nodes.get('setPwd').value = M.CFG.unlockPassword;
        fx.click('setUnlockBtn');
        const tipTimersBefore = fx.timers.filter(x => x.delay === 2000).length;
        fx.click('setLockBtn');
        manualQuiet = M.state.unlocked === false && tip.hidden === true &&
          !tip.classList.contains('show') && fx.timers.filter(x => x.delay === 2000).length === tipTimersBefore;
        steps.push(`手动锁定后 state.unlocked=${M.state.unlocked}，弹窗仍隐藏=` +
          `${tip.hidden && !tip.classList.contains('show')}，未新增 2000 ms 定时器=` +
          `${fx.timers.filter(x => x.delay === 2000).length === tipTimersBefore}`);
      } catch (e) {
        seqErr = e.message;
      }
      check(
        'F-02 自动锁定行为（FR-8.2）：解锁后登记 300000 ms 定时器 → 回调置为锁定并弹出提示 → 2000 ms 后自动隐藏',
        seqErr === null && unlockedAfter === false && tipShown && tipTimersAfter === 1 && tipHiddenAgain,
        seqErr ? `夹具执行异常：${seqErr}` : steps.join('；')
      );
      check(
        'F-02 手动锁定不弹提示（FR-8.2）：提示弹窗只挂在自动锁定分支',
        seqErr === null && manualQuiet,
        seqErr ? `夹具执行异常：${seqErr}` : steps.join('；')
      );
    }

    /* (e) `?unlock=1` 旁路（main.js）：置位解锁后调用导出的 `SettingPanel.armAutoLock()`。
       判据分两段，且两段都必须是**行为**判据：
         ① 真启动（`loadBootFixture()` 在 vm 里加载**真实** main.js 并跑完 start()）：
            `?unlock=1` ⇒ 已解锁 + 恰登记 1 个 300000 ms 自动锁定定时器 + 无"armAutoLock() 在
            bind() 之前被调用"的警告（= arm 确实发生在 Dashboard.init → SettingPanel.bind 之后）；
            不带该参数 ⇒ 未解锁 + 不登记任何 300000 ms 定时器（= arm 确实在 `unlockByParam` 分支**内**）。
         ② 再按该分支的调用序列（setUnlocked(true) → armAutoLock()）验回调行为（锁定 + 弹提示 + 2 s 隐藏）。
       为什么不用 `mainSrc.indexOf('SettingPanel.armAutoLock(')` 钉调用点：那正是 ADR-0004 D23 的
       静态防空洞 —— 把调用**注释掉**（字符串仍在源码里）或把它挪出 `unlockByParam` 分支，
       这种判据照样绿（**修复前实测**：把那行注释掉后 60 条仍全绿），拔掉也不红。 */
    {
      let bootErr = null;
      let bootOn = null;          /* ?unlock=1 的启动观察 */
      let bootOff = null;         /* 不带该参数的启动观察（钉住"调用必须在分支内"） */
      try {
        const on = loadBootFixture('?unlock=1');
        bootOn = {
          unlocked: on.w.MockData.state.unlocked,
          lockTimers: on.timers.filter(x => x.delay === 300000 && !x.cancelled).length,
          warn: on.warnings.join(' | ')
        };
        const off = loadBootFixture('?tab=0');
        bootOff = {
          unlocked: off.w.MockData.state.unlocked,
          lockTimers: off.timers.filter(x => x.delay === 300000 && !x.cancelled).length
        };
      } catch (e) {
        bootErr = e.message;
      }
      const booted = bootErr === null && bootOn !== null && bootOff !== null &&
        bootOn.unlocked === true && bootOn.lockTimers === 1 && bootOn.warn === '' &&
        bootOff.unlocked === false && bootOff.lockTimers === 0;
      /* 通过时也把观察值播出来（失败时另见 detail）：门禁输出本身即可复核，不必重跑一遍夹具 */
      if (bootErr === null) {
        console.log(`        参考（真实 main.js 启动）：?unlock=1 ⇒ 解锁=${bootOn.unlocked}、300000 ms 定时器 ${bootOn.lockTimers} 个、` +
          `console.warn=${bootOn.warn || '（无）'}；?tab=0 ⇒ 解锁=${bootOff.unlocked}、300000 ms 定时器 ${bootOff.lockTimers} 个`);
      }

      let byErr = null;
      let armedRet = null;
      let armedTimers = -1;
      let byUnlocked = null;
      let byTipShown = false;
      let byTipTimers = -1;
      let byTipHidden = false;
      const steps = [bootErr
        ? `真实 main.js 启动异常：${bootErr}`
        : `真实 main.js 启动：?unlock=1 ⇒ 解锁=${bootOn.unlocked}、300000 ms 定时器 ${bootOn.lockTimers} 个、` +
          `console.warn=${bootOn.warn || '（无）'}；?tab=0 ⇒ 解锁=${bootOff.unlocked}、300000 ms 定时器 ${bootOff.lockTimers} 个`];
      try {
        const fx = loadAutoLockFixture();
        const M = fx.w.MockData;
        const tip = fx.node('autoLockTip');
        tip.hidden = true;
        fx.w.Components.SettingPanel.bind(M.state, () => {});      /* Dashboard.init(state) 里做的事之一 */
        M.setUnlocked(true);                                        /* ?unlock=1 的置位 */
        armedRet = fx.w.Components.SettingPanel.armAutoLock();       /* main.js 的旁路调用 */
        armedTimers = fx.timers.filter(x => x.delay === 300000 && !x.cancelled && !x.fired).length;
        steps.push(`armAutoLock() 返回 ${armedRet}，未触发/未取消的 300000 ms 定时器 ${armedTimers} 个`);

        fx.fire(300000);
        byUnlocked = M.state.unlocked;
        byTipShown = tip.hidden === false && tip.classList.contains('show');
        byTipTimers = fx.timers.filter(x => x.delay === 2000 && !x.fired).length;
        steps.push(`300000 ms 回调后 state.unlocked=${byUnlocked}，弹窗显示=${byTipShown}，2000 ms 定时器 ${byTipTimers} 个`);

        fx.fire(2000);
        byTipHidden = tip.hidden === true && !tip.classList.contains('show');
        steps.push(`2000 ms 回调后弹窗回到隐藏态=${byTipHidden}`);
      } catch (e) {
        byErr = e.message;
      }
      check(
        'F-02 旁路接线（?unlock=1）：真实 main.js 启动时该分支 arm（已解锁 + 恰 1 个 300000 ms 定时器 + arm 在 Dashboard.init 之后），无该参数时不 arm；该定时器回调置为锁定并弹出提示 → 2000 ms 后自动隐藏',
        byErr === null && booted && armedRet && armedTimers === 1 && byUnlocked === false &&
          byTipShown && byTipTimers === 1 && byTipHidden,
        byErr ? `夹具执行异常：${byErr}` : steps.join('；')
      );
    }

    /* (e2) 未 bind 时 `armAutoLock()` 必须"不静默失效"：返回 false + console.warn，且不登记任何计时 */
    {
      let nbErr = null;
      let refusedRet = null;
      let refusedTimers = -1;
      let warned = false;
      let warnText = '';
      try {
        const fx = loadAutoLockFixture();
        fx.w.MockData.setUnlocked(true);       /* 即便已解锁，未 bind 也无从登记自动锁定 */
        refusedRet = fx.w.Components.SettingPanel.armAutoLock();
        refusedTimers = fx.timers.filter(x => !x.cancelled).length;
        warned = fx.warnings.some(w => /armAutoLock\(\) 在 bind\(\) 之前被调用/.test(w) && /自动锁定未登记/.test(w));
        warnText = fx.warnings.join(' | ');
      } catch (e) {
        nbErr = e.message;
      }
      const refused = refusedRet === false;
      check(
        'F-02 未 bind 时不静默失效：armAutoLock() 返回 false、不登记计时、且 console.warn 说明"自动锁定未登记"',
        nbErr === null && refused && refusedTimers === 0 && warned,
        nbErr ? `夹具执行异常：${nbErr}` : `返回值=${refusedRet}，未取消定时器 ${refusedTimers} 个，捕获 warn=${warnText || '（无）'}`
      );
    }

    /* (e3) 重复 arm 不堆叠：`?unlock=1` 与手动解锁可能先后触发，任一时刻只应有一个自动锁定计时 */
    {
      let rpErr = null;
      let pending = -1;
      let cancelled = -1;
      let rets = '';
      try {
        const fx = loadAutoLockFixture();
        const M = fx.w.MockData;
        fx.w.Components.SettingPanel.bind(M.state, () => {});
        M.setUnlocked(true);
        const r1 = fx.w.Components.SettingPanel.armAutoLock();
        const r2 = fx.w.Components.SettingPanel.armAutoLock();
        rets = `${r1}/${r2}`;
        pending = fx.timers.filter(x => x.delay === 300000 && !x.cancelled && !x.fired).length;
        cancelled = fx.timers.filter(x => x.delay === 300000 && x.cancelled).length;
      } catch (e) {
        rpErr = e.message;
      }
      check(
        'F-02 重复 arm 不堆叠：连续两次调用后未触发/未取消的 300000 ms 定时器恰 1 个（且发生过 1 次 clearTimeout）',
        rpErr === null && pending === 1 && cancelled === 1,
        rpErr ? `夹具执行异常：${rpErr}` : `两次返回值=${rets}；存活 300000 ms 定时器 ${pending} 个，被 clearTimeout 的 ${cancelled} 个`
      );
    }

    /* ---- R26-P2-1（D2）：设置页写操作/键入必须重挂**同一个** 5 分钟锁定计时 + 锁定后保存不静默 ----
       立案（审查 R-2026-09-26 的 R26-P2-1）：`SettingPanel.bind` 收到的 onActivity 是
       `Dashboard.resetIdleTimer`（FR-9.4 回首页计时，5 分 10 秒），而设置页的写操作与录入框键入
       **只**刷新它 ⇒ FR-8.2 的锁定计时不刷新（改前实测：6/6 类活动 "未重挂"）；且各保存路径以
       `if (!state.unlocked) return` 开头 ⇒ 锁定后保存静默失效（操作人不知道没保存成功）。
       裁定（负责人 2026-09-27）＝**刷新**：与任务页 `TaskPanel.activity()` **同一口径**的双动作
       （onActivity + armAutoLock；不新造计时逻辑、不新增第二个定时器），且锁定后保存必须给出可观察反馈。
       判据一律是**行为**判据（存活定时器 id / 存活数 / clearTimeout 次数 / 节点文案），
       不在源码里搜字符串（ADR-0004 D23）——
       `armAutoLock()` 必先 clearTimeout 再 setTimeout ⇒ 真的重挂时**存活定时器的 id 必然变化**；
       只调 onActivity() 时那个 id 原封不动，本段 4 条断言随之变红。 ---- */
    if (constErr === null) {
      /* 保存路径成功后会回调这两个面板的 render；本段只观察计时与提示，用空桩件顶替
         （不动 loadAutoLockFixture 这个共享夹具，避免影响 F-02 既有用例）。 */
      const stubSavePanels = w => {
        w.Components.MaintPanel = { render: () => {} };
        w.Components.NoticePanel = { render: () => {} };
      };
      const liveLock = fx => fx.timers.filter(x => x.delay === lockMs && !x.cancelled && !x.fired);
      const deadLock = fx => fx.timers.filter(x => x.delay === lockMs && x.cancelled).length;
      /** 一副"已解锁且已 arm"的设置页夹具（解锁走真路径：#setUnlockBtn → tryUnlock） */
      const unlockedFixture = () => {
        const fx = loadAutoLockFixture();
        stubSavePanels(fx.w);
        let idle = 0;
        fx.w.Components.SettingPanel.bind(fx.w.MockData.state, () => { idle++; });
        fx.nodes.get('setPwd').value = fx.w.MockData.CFG.unlockPassword;
        fx.click('setUnlockBtn');
        return { fx, M: fx.w.MockData, idle: () => idle };
      };
      /** 施加一次"设置页活动"，返回可证伪的观察值（重挂 ⇒ 存活计时器换新 id 且旧的被 clearTimeout） */
      const observeActivity = (setup, act) => {
        const c = unlockedFixture();
        if (setup) setup(c);
        const idBefore = (liveLock(c.fx)[0] || {}).id;
        const aliveBefore = liveLock(c.fx).length;
        const deadBefore = deadLock(c.fx);
        const idleBefore = c.idle();
        act(c);
        const idAfter = (liveLock(c.fx)[0] || {}).id;
        return {
          idBefore, idAfter,
          aliveAfter: liveLock(c.fx).length,
          deadDelta: deadLock(c.fx) - deadBefore,
          idleDelta: c.idle() - idleBefore,
          rearmed: aliveBefore === 1 && idAfter !== undefined && idAfter !== idBefore
        };
      };

      /* (f1) 每个写操作（维保保存 / 公告发布 / 参数保存 / NTP 同步 / 手动时间）都要重挂锁定计时 */
      let opsErr = null;
      let writeOps = [];
      try {
        writeOps = [
          ['维保保存', c => { c.fx.nodes.get('maintContent').value = 'R26-P2-1 检修内容'; }, c => c.fx.click('maintSave')],
          ['公告发布', c => { c.fx.nodes.get('noticeText').value = 'R26-P2-1 公告'; }, c => c.fx.click('noticeSave')],
          ['参数保存', c => { c.fx.nodes.get('cfgEquipCode').value = 'R26-P2-1-CODE'; }, c => c.fx.click('cfgSaveBtn')],
          ['NTP 同步', null, c => c.fx.click('setSyncBtn')],
          ['手动时间', null, c => c.fx.click('setManualBtn')]
        ].map(([name, setup, act]) => [name, observeActivity(setup, act)]);
      } catch (e) {
        opsErr = e.message;
      }
      check(
        'R26-P2-1（D2）FR-8.2/FR-3.19⑧ 设置页每个写操作都按任务页同一口径刷新：既重置 FR-9.4 回首页计时（onActivity +1），' +
        '又重挂 FR-8.2 的 5 分钟锁定计时（存活计时器换成新 id、恰 1 个、clearTimeout 恰 1 次）',
        opsErr === null && writeOps.length === 5 &&
        writeOps.every(([, o]) => o.rearmed && o.aliveAfter === 1 && o.deadDelta === 1 && o.idleDelta === 1),
        opsErr ? `夹具执行异常：${opsErr}` : writeOps.map(([n, o]) => `${n}: 计时器 ${o.idBefore}→${o.idAfter}、存活 ${o.aliveAfter}、` +
          `clearTimeout +${o.deadDelta}、onActivity +${o.idleDelta}${o.rearmed ? '' : ' ⇒ 未重挂'}`).join('；')
      );

      /* (f2) 每个录入框的键入（改前只有密码框绑了 keydown）都要重挂锁定计时 */
      let typeErr = null;
      let typed = [];
      try {
        typed = ['maintContent', 'maintOwner', 'noticeText',
          'cfgEquipCode', 'cfgUpperUrl', 'cfgMesUrl', 'cfgWarnDays']
          .map(id => [id, observeActivity(null, c => c.fx.node(id).__fire('keydown', { key: 'a' }))]);
      } catch (e) {
        typeErr = e.message;
      }
      check(
        'R26-P2-1（D2）FR-8.2/FR-3.19⑧ 设置页录入框键入同样刷新：7 个录入框（维保内容/维保责任人/公告正文/参数四框）各派发一次 keydown ' +
        '⇒ 每次都以新 id 重挂同一个锁定计时（不新增第二个定时器）',
        typeErr === null && typed.length === 7 &&
        typed.every(([, o]) => o.rearmed && o.aliveAfter === 1 && o.deadDelta === 1 && o.idleDelta === 1),
        typeErr ? `夹具执行异常：${typeErr}` : typed.map(([id, o]) => `${id}: 计时器 ${o.idBefore}→${o.idAfter}、` +
          `存活 ${o.aliveAfter}${o.rearmed ? '' : ' ⇒ 未重挂'}`).join('；')
      );

      /* (f3) 锁定后保存**不得静默失效**：三处保存路径都要给出可见反馈，且都不在锁定态写入状态 */
      let lockErr = null;
      let lockedSaves = [];
      try {
        lockedSaves = [
          ['维保保存', 'maintSave', s => `${s.unlocked}|${s.maint.records.length}`],
          ['公告发布', 'noticeSave', s => `${s.unlocked}|${s.notices.notices.length}`],
          ['参数保存', 'cfgSaveBtn', s => `${s.unlocked}|${s.device.code}|${s.maint.warnDays}`]
        ].map(([name, btn, snap]) => {
          const fx = loadAutoLockFixture();
          stubSavePanels(fx.w);
          const M = fx.w.MockData;
          fx.w.Components.SettingPanel.bind(M.state, () => {});
          M.setUnlocked(false);                       /* 相当于自动锁定到点之后的锁定态 */
          const entry = fx.node('entryMsg');
          const before = String(entry.textContent || '');
          const stateBefore = snap(M.state);
          fx.click(btn);
          const after = String(entry.textContent || '');
          return {
            name, before, after,
            stateSame: snap(M.state) === stateBefore,
            visible: after !== before && after.length > 0 && /锁定/.test(after) && /未保存/.test(after)
          };
        });
      } catch (e) {
        lockErr = e.message;
      }
      check(
        'R26-P2-1（D2）FR-8.2/C-84③ 锁定后设置页保存给出可观察反馈（#entryMsg 变为"当前已锁定…未保存，请先输入解锁密码"），' +
        '不是静默 return：三处保存路径既都可见、也都不在锁定态写入状态',
        lockErr === null && lockedSaves.length === 3 && lockedSaves.every(r => r.visible && r.stateSame),
        lockErr ? `夹具执行异常：${lockErr}` : lockedSaves.map(r => `${r.name}: #entryMsg ${JSON.stringify(r.before)} → ` +
          `${JSON.stringify(r.after)}；可见反馈=${r.visible}；state 未写入=${r.stateSame}`).join('；')
      );

      /* (f4) 两页共用**同一个**计时器而非两套：8 次设置页活动 ⇒ 全局存活恰 1 个；
         再走任务页那条入口（`TaskPanel.activity()` 调的导出 `armAutoLock()`）⇒ 它取消掉的正是这一个；
         触发它 ⇒ 走 FR-8.2 自动锁定（置锁定 + 弹 #autoLockTip + 2 s 后隐藏）。 */
      let shareErr = null;
      let shared = null;
      try {
        const c = unlockedFixture();
        const idleBefore = c.idle();
        const deadBefore = deadLock(c.fx);
        c.fx.nodes.get('maintContent').value = 'D2 2b 检修内容';
        c.fx.click('maintSave');
        c.fx.nodes.get('noticeText').value = 'D2 2b 公告';
        c.fx.click('noticeSave');
        c.fx.nodes.get('cfgEquipCode').value = 'D2-2B-CODE';
        c.fx.click('cfgSaveBtn');
        c.fx.click('setSyncBtn');
        c.fx.click('setManualBtn');
        ['maintContent', 'cfgWarnDays', 'noticeText'].forEach(id => c.fx.node(id).__fire('keydown', { key: 'a' }));
        const bySettings = { alive: liveLock(c.fx).length, id: (liveLock(c.fx)[0] || {}).id, dead: deadLock(c.fx) };
        const armed = c.fx.w.Components.SettingPanel.armAutoLock();   /* 任务页 activity() 的同一步 */
        const byTask = { alive: liveLock(c.fx).length, id: (liveLock(c.fx)[0] || {}).id, dead: deadLock(c.fx) };
        const tip = c.fx.node('autoLockTip');
        tip.hidden = true;
        c.fx.fire(lockMs);
        shared = {
          idleDelta: c.idle() - idleBefore,
          deadDelta: bySettings.dead - deadBefore,
          bySettings, byTask, armed,
          unlockedAfter: c.M.state.unlocked,
          tipShown: tip.hidden === false && tip.classList.contains('show'),
          tipTimers: c.fx.timers.filter(x => x.delay === 2000 && !x.fired).length
        };
        c.fx.fire(2000);
        shared.tipHidden = tip.hidden === true && !tip.classList.contains('show');
      } catch (e) {
        shareErr = e.message;
      }
      check(
        'R26-P2-1（D2）FR-8.2/FR-3.19⑧ 设置页与任务页共用**同一个**5 分钟锁定计时器（非两套）：8 次设置页活动后全局仅 1 个存活计时器，' +
        '任务页入口 armAutoLock() 取消的正是它（id 变化、存活仍 1），触发它即自动锁定并弹提示 → 2 s 后隐藏',
        shareErr === null && shared !== null &&
        shared.idleDelta === 8 && shared.deadDelta === 8 &&
        shared.bySettings.alive === 1 && shared.byTask.alive === 1 &&
        shared.byTask.id !== shared.bySettings.id && shared.byTask.dead === shared.bySettings.dead + 1 &&
        shared.armed === true && shared.unlockedAfter === false && shared.tipShown &&
        shared.tipTimers === 1 && shared.tipHidden === true,
        shareErr ? `夹具执行异常：${shareErr}` : shared === null ? '（无观察值）' :
          `8 次设置页活动：onActivity +${shared.idleDelta}、clearTimeout +${shared.deadDelta}；` +
          `存活计时器 ${shared.bySettings.alive} 个（id ${shared.bySettings.id}）→ 任务页入口 arm 后 ` +
          `${shared.byTask.alive} 个（id ${shared.byTask.id}）；触发后 unlocked=${shared.unlockedAfter}、` +
          `弹窗显示=${shared.tipShown}、2000 ms 定时器 ${shared.tipTimers} 个、2 s 后隐藏=${shared.tipHidden}`
      );

      /* 通过时也把观察值播出来（失败时另见 detail）：门禁输出本身即可复核，不必重跑夹具 */
      if (opsErr === null && typeErr === null && lockErr === null && shareErr === null && shared !== null) {
        console.log(`        参考（真实 SettingPanel）：5 类写操作重挂 ${writeOps.filter(([, o]) => o.rearmed).length}/5、` +
          `7 个录入框键入重挂 ${typed.filter(([, o]) => o.rearmed).length}/7、` +
          `锁定后三处保存可见反馈 ${lockedSaves.filter(r => r.visible).length}/3、` +
          `8 次设置页活动后存活 ${lockMs} ms 计时器 ${shared.bySettings.alive} 个` +
          `（任务页入口 armAutoLock() 后 ${shared.byTask.alive} 个、clearTimeout 共 +${shared.deadDelta}）`);
      }
    }

    check(
      'FR-8.7 / NFR-15 解锁后的写操作留痕（真实操作日志）',
      /(opLog|operationLog|auditLog|state\.logs|操作日志\s*[:：]?\s*\[)/.test(allSrc) === true &&
        /push\(\s*\{[^}]*(action|op|操作)/.test(allSrc),
      '录入/发布只把"已记录操作日志"写进提示文案，state 里没有任何日志容器或追加动作'
    );

    const cssAll = readText('src/styles/global.css') + readText('src/styles/variables.css');
    check(
      'FR-9.7 大屏交互屏蔽（文本选中 / 右键菜单）',
      /user-select\s*:\s*none/.test(cssAll) && /contextmenu/.test(allSrc),
      '样式里没有 user-select:none，JS 也没有拦截 contextmenu（Alt+Tab/Win 属 kiosk 启动参数，见 README）'
    );

    check(
      'FR-8.6 设置页提供关键参数配置入口（设备编号 / 上位机地址 / MES 地址）',
      /id="[^"]*(equipCode|upperUrl|mesUrl|cfgEquip|cfgUpper|cfgMes)[^"]*"/i.test(html),
      'index.html 里没有设备编号/上位机地址/MES 地址的输入控件，这些参数只能改 board.config.js'
    );

    check(
      'FR-5.6 多条并发报警排队展示、不互相覆盖',
      /alarm\.queue|alarmQueue|pendingAlarms/.test(mockSrc),
      '只有单个 state.alarm.active（新报警直接覆盖）+ 每 150 s 自动轮换；台账也不接收新报警'
    );

    /* NFR-11：单一组件异常不应导致整屏白屏（行为验证） */
    const originalRender = W.Components.StatsPanel.render;
    W.Components.StatsPanel.render = () => { throw new Error('注入的组件故障'); };
    ui.out.length = 0;
    let propagated = null;
    try {
      W.Pages.Dashboard.renderAll(W.MockData.state);
    } catch (e) {
      propagated = e.message;
    }
    W.Components.StatsPanel.render = originalRender;
    const afterFailure = ['ntTodoList', 'mtCycleList', 'setSelfCheckList'].filter(id => lastHtml(ui.out, id) !== null);
    check(
      'NFR-11 单一组件异常不导致整屏刷新中断',
      propagated === null && afterFailure.length === 3,
      propagated
        ? `StatsPanel 抛错后异常直接冒出 renderAll：${propagated}（其后的组件都不会再渲染）`
        : `未中断，但其后组件未渲染：${afterFailure.join('、') || '（无）'}`
    );
  }

  /* ===== U7 班次配置缺口：渲染循环兜底（E34 ★★★）与设置页同步按钮锁定守卫（E35 ★） ===== */
  section('U7 班次缺口兜底与设置页锁定守卫（E34 / E35）');

  /* ---- E34：`step()` 必须兜住 `mockData.shiftOf()` 的缺口抛错，且**不得**冻结整帧 ----
     立案（C 分区 N1 实测，`tests\._verify\c1\probe-new-frame-abort.js`）：P3-5 之后 `M.tick()` 在
     班次**配置缺口**时按服务端口径显式抛错（该语义要保留，绝不静默兜底），而 `src/main.js` 的
     `step()` 原先**无** try/catch ⇒ `syncLinkState()` 与 `renderAll()` 都不执行、看板冻结在上一帧。
     负责人 2026-09-27 裁定＝方案①：保留抛错 + 渲染循环兜底 + 显式可见异常态 + 不刷屏。
     判据一律是**行为**判据（真实 main.js 逐帧驱动、组件 render 调用计数、节点文本、捕获的
     console.error 条数），不做源码字符串匹配（ADR-0004 D23）。 ---- */
  {
    const FRAME_COMPONENTS = [
      'src/components/HeaderBar.js',
      'src/components/TabsBar.js',
      'src/components/CurveChart.js',
      'src/components/DeviceStatusPanel.js',
      'src/components/TaskPanel.js',
      'src/components/ShiftPanel.js',
      'src/components/StatsPanel.js',
      'src/components/AlarmPanel.js',
      'src/components/MaintPanel.js',
      'src/components/NoticePanel.js',
      'src/components/SettingPanel.js'
    ];
    /* 有缺口的三段班（挖掉 08:00-16:00）——**内存覆盖**，不落盘、不动 mockData.js */
    const GAP_LIST = [{ name: '晚班', start: 0, end: 8 }, { name: '中班', start: 16, end: 24 }];
    const FULL_LIST = [
      { name: '晚班', start: 0, end: 8 },
      { name: '早班', start: 8, end: 16 },
      { name: '中班', start: 16, end: 24 }
    ];
    const countText = (o, id) => o.filter(e => e.kind === 'text' && e.id === id).length;
    /* 缺口帧"无数据"表达涉及的统计位（覆盖统计页四个分区）与班次进度位（E38） */
    const E38_STAT_IDS = ['sPlan', 'sStarted', 'sNotStarted', 'sDone', 'sDoing', 'sTodo',
      'sQualified', 'sUnqualified', 'sRecheck', 'sFpy', 'sRunTime', 'sIdleTime', 'sAvgTime', 'sCapacity', 'sOee'];
    const E38_SHIFT_IDS = ['shProgressPct', 'shElapsed', 'shRemaining'];
    const NO_DATA = '—';
    /** 判"这一格是不是显式无数据表达"：等于占位符，且**不是** 0 / 0.0% / 空串 / undefined 文本 */
    const isNoData = v => v === NO_DATA && !/^(0(\.0+)?%?|)$/.test(v);
    const snapAll = (fx, ids) => ids.reduce((a, id) => (a[id] = String(fx.node(id).textContent || ''), a), {});
    /** 基线里那几格的真实值（自愈后须逐字回到这些值，而不是"非占位就算过"） */
    const E38_BACK_IDS = ['sPlan', 'sFpy', 'sOee', 'shProgressPct', 'shElapsed'];
    const FE = { gapErr: null, r: null };

    try {
      /* (a) 基线：**正常配置**下先跑一帧（首帧由 main.js 的 start() 自己跑掉），
             再用"连续 5 帧的调用增量"证明计数器本身是可用的（否则下面对照组会很可疑） */
      const base = loadFrameFixture(FRAME_COMPONENTS);
      base.frame();
      const baseline = {
        statsKeys: Object.keys(base.w.MockData.state.stats).sort().join(','),
        noData: base.w.MockData.state.stats.noData,
        stats: snapAll(base, E38_STAT_IDS),
        shiftIds: snapAll(base, E38_SHIFT_IDS),
        shiftKeys: Object.keys(base.w.MockData.state.shift).sort().join(','),
        hdrShift: snapId(base, 'hdrShift')
      };
      base.resetCalls();
      const baseThrew = [0, 1, 2, 3, 4].map(() => base.frame().threw).filter(Boolean).length;
      const baseCalls = Object.assign({}, base.calls);

      /* (b) 缺口：同一路夹具，把班次表换成有缺口的配置（首帧已在正常配置下跑过 ⇒
             "冻结"的表现就是后续帧再也不刷新，与实测现象一致） */
      const gap = loadFrameFixture(FRAME_COMPONENTS);
      gap.frame();                                   /* 首帧（正常配置）+1 s 稳态 */
      const gapBaseline = {                           /* 缺口前的正常帧快照（E37/E38 的"基线值"） */
        hdrShift: snapId(gap, 'hdrShift'),
        stats: snapAll(gap, E38_STAT_IDS),
        shiftIds: snapAll(gap, E38_SHIFT_IDS)
      };
      gap.setShiftList(GAP_LIST);                    /* 内存覆盖 ⇒ 下一帧起 `shiftOf()` 抛缺口 */
      gap.resetCalls();
      const before = {
        records: gap.out.length,
        clock: String(gap.node('hdrClock').textContent || ''),
        errors: gap.errorCount(),
        hdrShift: String(gap.node('hdrShift').textContent || '')
      };
      const frames = [0, 1, 2, 3, 4].map(() => gap.frame());
      const threwCount = frames.filter(f => f.threw).length;
      const after = {
        records: gap.out.length,
        clock: String(gap.node('hdrClock').textContent || ''),
        errors: gap.errorCount(),
        hdrShift: String(gap.node('hdrShift').textContent || ''),
        hdrShiftTime: String(gap.node('hdrShiftTime').textContent || ''),
        hdrTeam: String(gap.node('hdrTeam').textContent || ''),
        hdrLinkBadge: String(gap.node('hdrLinkBadge').textContent || ''),
        settingsRendered: gap.calls['SettingPanel.render'],
        alarmsRendered: gap.calls['AlarmPanel.render'],
        statsRendered: gap.calls['StatsPanel.render'],
        shiftPanelRendered: gap.calls['ShiftPanel.render'],
        shiftListText: String(gap.node('shShiftList').innerHTML || ''),
        clockRenders: countText(gap.out, 'hdrClock'),
        /* ---- E36 / E38（D9）：缺口帧的状态位、统计值、键集 ---- */
        statsNoData: gap.w.MockData.state.stats.noData,
        shiftNoData: gap.w.MockData.state.shift.noData,
        statsKeys: Object.keys(gap.w.MockData.state.stats).sort().join(','),
        shiftKeys: Object.keys(gap.w.MockData.state.shift).sort().join(','),
        stats: snapAll(gap, E38_STAT_IDS),
        shiftIds: snapAll(gap, E38_SHIFT_IDS)
      };
      const gapErrors = gap.errors('error');
      const clockRefreshed = after.clock !== before.clock && after.clock.length > 0;
      /* `M.tick()` 抛在 `state.clock` 之后、`state.shift` 之前 ⇒ 时钟必然推进、班次必然不更新，
         故还用 C 组的时钟文本反证"本夹具真的能观察刷新" */
      const baseCallsAllOne = base.CALL_KEYS.every(([n, m]) => baseCalls[n + '.' + m] === 5);
      FE.r = {
        baseline, gapBaseline, baseThrew, clockRefreshed, before, after, threwCount, gapErrors, baseCallsAllOne,
        frameErr: frames.map(f => f.message).filter(Boolean)[0] || null
      };
    } catch (e) {
      FE.gapErr = e.message;
    }

    {
      const r = FE.r;
      check(
        'E34（D8）FR-1.9/FR-1.10 班次配置缺口下不冻结：真实 main.js 的 step() 连驱 5 帧**一次都不抛到顶层**，' +
        '且整帧仍渲染（10 个组件各 +5 次 render 调用、Dom 写入记录增长、#hdrClock 从上一帧时刻刷新到新时刻）',
        FE.gapErr === null && r !== null && r.frameErr === null && r.threwCount === 0 &&
        r.baseCallsAllOne && r.clockRefreshed && r.after.records > r.before.records &&
        r.after.settingsRendered === 5 && r.after.alarmsRendered === 5 && r.after.statsRendered === 5 &&
        r.after.shiftPanelRendered === 5,
        FE.gapErr ? `夹具执行异常：${FE.gapErr}` : r === null ? '（无观察值）' :
          `抛出顶层 ${r.threwCount}/5 帧${r.frameErr ? '（原文：' + r.frameErr + '）' : ''}；` +
          `Dom 记录 ${r.before.records} → ${r.after.records}；#hdrClock ${JSON.stringify(r.before.clock)} → ` +
          `${JSON.stringify(r.after.clock)}（刷新=${r.clockRefreshed}）；` +
          `缺口 5 帧调用增量 班次页=${r.after.shiftPanelRendered} 统计页=${r.after.statsRendered} ` +
          `设置页=${r.after.settingsRendered} 异常页=${r.after.alarmsRendered}；` +
          `正常配置对照组 5 帧 = 每组件 ${r.baseCallsAllOne ? 5 : '不等'} 次`
      );

      check(
        'E34（D8）显式异常状态用户可见且其余区域照常刷新：缺口帧头屏班次位显示「班次配置异常」' +
        '（起止与班组/操作员/班组长回落为「—」），同时联网标识仍按状态渲染、班次页照旧列出配置里的全部班次时段',
        FE.gapErr === null && r !== null &&
        /班次配置异常/.test(r.after.hdrShift) &&
        r.after.hdrShiftTime === '—' && r.after.hdrTeam === '—' &&
        /上位机/.test(r.after.hdrLinkBadge) &&
        r.after.shiftListText.includes('晚班') && r.after.shiftListText.includes('中班'),
        FE.gapErr ? `夹具执行异常：${FE.gapErr}` : r === null ? '（无观察值）' :
          `#hdrShift=${JSON.stringify(r.after.hdrShift)}、#hdrShiftTime=${JSON.stringify(r.after.hdrShiftTime)}、` +
          `#hdrTeam=${JSON.stringify(r.after.hdrTeam)}、#hdrLinkBadge=${JSON.stringify(r.after.hdrLinkBadge)}；` +
          `#shShiftList 含晚班/中班=${r.after.shiftListText.includes('晚班')}/${r.after.shiftListText.includes('中班')}`
      );

      check(
        'E34（D8）不刷屏：连续 5 帧缺口场景下 console.error 总数 ≤ 1（同一 message 只在状态变化时报一次），' +
        '且报错原文带"班次配置异常"字样（去重生效，不是把异常吞掉）',
        FE.gapErr === null && r !== null && r.after.errors <= 1 &&
        r.gapErrors.length === r.after.errors &&
        r.gapErrors.every(m => /班次配置异常/.test(m)),
        FE.gapErr ? `夹具执行异常：${FE.gapErr}` : r === null ? '（无观察值）' :
          `console.error ${r.after.errors} 条（判据 ≤1）；原文=${JSON.stringify(r.gapErrors.map(m => m.split('\n')[0]))}`
      );

      /* ---- E36 / E38（D9）：缺口帧的"无数据"必须显式，且**不得**再手写 state.stats 的键集 ----
         立案：真机验证（`tests\._verify\b1\probe-e34-browser.js`）实测缺口帧 `#sPlan=""`、
         `#sFpy=0.0%`、`#sOee=0.0%`（基线 180 / 92.9% / 79.0%）⇒ 把"无法计算"显示成了"零产量"，
         违背"不得伪造数据"。源码层根因有两处：①`src/main.js` 的缺口兜底**按既有字段名手写**了
         一份 `state.stats`（与 `computeStats()` 形成无人守的隐性契约，且**已经漏了 `plan` 键** ——
         实测把 `#sPlan` 写成了 `undefined`）；②渲染层照原样格式化 ⇒ 全 0。
         修法：键集由数据层在**运行期**从 `computeStats()` 取（`MockData.noDataStats()`），
         渲染层只认显式状态位 `stats.noData === true` 显示占位"—"。
         判据一律**行为**判据：键集比对、状态位、节点文本，不做源码字符串匹配（ADR-0004 D23）。 ---- */
      check(
        'E36（D9）缺口帧产物键集 ＝ 正常帧键集：`state.stats`/`state.shift` 的键集逐字相等' +
        '（"无数据"由显式状态位 stats.noData / shift.noData 表达，渲染循环不再手写任何键集 ⇒ 键集不会漂移）',
        FE.gapErr === null && r !== null &&
        r.baseline.noData === false && r.after.statsNoData === true &&
        r.baseline.statsKeys === r.after.statsKeys &&
        r.baseline.shiftKeys === r.after.shiftKeys &&
        r.after.shiftNoData === true,
        FE.gapErr ? `夹具执行异常：${FE.gapErr}` : r === null ? '（无观察值）' :
          `正常帧 stats 键集＝${r.baseline.statsKeys}；缺口帧 stats 键集＝${r.after.statsKeys}` +
          `（相等=${r.baseline.statsKeys === r.after.statsKeys}）；` +
          `正常帧 shift 键集＝${r.baseline.shiftKeys}；缺口帧 shift 键集＝${r.after.shiftKeys}` +
          `（相等=${r.baseline.shiftKeys === r.after.shiftKeys}）；` +
          `stats.noData ${JSON.stringify(r.baseline.noData)} → ${JSON.stringify(r.after.statsNoData)}、` +
          `shift.noData → ${JSON.stringify(r.after.shiftNoData)}`
      );

      const statBad = E38_STAT_IDS.filter(id => !isNoData(r.after.stats[id]));
      const shiftBad = E38_SHIFT_IDS.filter(id => !isNoData(r.after.shiftIds[id]));
      check(
        'E38（D9）缺口帧"统计/计划"位显示**显式无数据**（"'+ NO_DATA +'"）：15 个统计位与 3 个班次进度位' +
        '一律为占位，**不得**是 0 / 0.0% / 空串（不把"无法计算"显示成"零产量"）',
        FE.gapErr === null && r !== null && statBad.length === 0 && shiftBad.length === 0,
        FE.gapErr ? `夹具执行异常：${FE.gapErr}` : r === null ? '（无观察值）' :
          `统计位＝${JSON.stringify(r.after.stats)}；不合判据的位=${JSON.stringify(statBad)}；` +
          `班次进度位＝${JSON.stringify(r.after.shiftIds)}；不合判据的位=${JSON.stringify(shiftBad)}`
      );

      const backBad = E38_BACK_IDS.filter(id => {
        const key = E38_SHIFT_IDS.includes(id) ? 'shiftIds' : 'stats';
        return r.after[key][id] !== r.gapBaseline[key][id];
      });
      check(
        'E38b（D9）缺口帧的统计位/班次进度位**确实是被本帧改写过的**（不等于缺口前基线的真实值）：' +
        '证明断言观察到的是"无数据"状态本身，而不是"节点压根没被渲染/没被写"',
        FE.gapErr === null && r !== null && backBad.length === E38_BACK_IDS.length,
        FE.gapErr ? `夹具执行异常：${FE.gapErr}` : r === null ? '（无观察值）' :
          `缺口前基线＝${JSON.stringify(Object.assign({}, r.gapBaseline.stats, r.gapBaseline.shiftIds))}；` +
          `缺口帧＝${JSON.stringify(Object.assign({}, r.after.stats, r.after.shiftIds))}；` +
          `仍等于基线的位=${JSON.stringify(E38_BACK_IDS.filter(id => !backBad.includes(id)))}（应全不同）`
      );
    }
  }

  /* ---- E34 恢复自愈：配置改回正常 ⇒ 提示消失、班次正常显示、不再新增报错 ---- */
  {
    const COMPONENTS = [
      'src/components/HeaderBar.js', 'src/components/TabsBar.js', 'src/components/CurveChart.js',
      'src/components/DeviceStatusPanel.js', 'src/components/TaskPanel.js', 'src/components/ShiftPanel.js',
      'src/components/StatsPanel.js', 'src/components/AlarmPanel.js', 'src/components/MaintPanel.js',
      'src/components/NoticePanel.js', 'src/components/SettingPanel.js'
    ];
    const GAP = [{ name: '晚班', start: 0, end: 8 }, { name: '中班', start: 16, end: 24 }];
    const FULL = [
      { name: '晚班', start: 0, end: 8 },
      { name: '早班', start: 8, end: 16 },
      { name: '中班', start: 16, end: 24 }
    ];
    let healErr = null;
    let heal = null;
    /* E38（D9）：自愈帧要逐字回到**缺口前的真实值**（不是"非占位即算过"）；E37：class 一起复原 */
    const HEAL_BACK_IDS = ['sPlan', 'sFpy', 'sOee', 'shProgressPct', 'shElapsed', 'shRemaining'];
    const INITIAL_HDR_SHIFT_CLASS = initialClassOf('hdrShift');
    try {
      const fx = loadFrameFixture(COMPONENTS);
      fx.frame();
      const beforeGap = {
        stats: HEAL_BACK_IDS.reduce((a, id) => (a[id] = String(fx.node(id).textContent || ''), a), {}),
        hdrShift: snapId(fx, 'hdrShift')
      };
      fx.setShiftList(GAP);
      fx.frame();
      fx.frame();
      const during = {
        hdrShift: String(fx.node('hdrShift').textContent || ''),
        hdrShiftClass: String(fx.node('hdrShift').className || ''),
        alert: fx.w.MockData.state.shiftAlert,
        errors: fx.errorCount(),
        statsNoData: fx.w.MockData.state.stats.noData,
        noDataCells: HEAL_BACK_IDS.reduce((a, id) => (a[id] = String(fx.node(id).textContent || ''), a), {})
      };
      fx.setShiftList(FULL);                       /* 就地改回正常配置（同一个数组引用） */
      fx.frame();
      heal = {
        beforeGap,
        during,
        initialClass: INITIAL_HDR_SHIFT_CLASS,
        after: {
          hdrShift: String(fx.node('hdrShift').textContent || ''),
          hdrShiftClass: String(fx.node('hdrShift').className || ''),
          hdrShiftTime: String(fx.node('hdrShiftTime').textContent || ''),
          hdrTeam: String(fx.node('hdrTeam').textContent || ''),
          alert: fx.w.MockData.state.shiftAlert,
          errors: fx.errorCount(),
          statsNoData: fx.w.MockData.state.stats.noData,
          backCells: HEAL_BACK_IDS.reduce((a, id) => (a[id] = String(fx.node(id).textContent || ''), a), {})
        }
      };
    } catch (e) {
      healErr = e.message;
    }
    check(
      'E34（D8）恢复自愈：班次配置改回无缺口后，头屏「班次配置异常」消失、班次名/起止/班组恢复为真实班次，' +
      'state.shiftAlert 收敛为 null，且恢复过程不新增 console.error',
      healErr === null && heal !== null &&
      /班次配置异常/.test(heal.during.hdrShift) && typeof heal.during.alert === 'string' && heal.during.alert.length > 0 &&
      !/班次配置异常/.test(heal.after.hdrShift) && heal.after.hdrShift.length > 0 &&
      heal.after.alert === null && heal.after.errors === heal.during.errors &&
      heal.after.hdrShiftTime !== '—' && heal.after.hdrTeam !== '—',
      healErr ? `夹具执行异常：${healErr}` : heal === null ? '（无观察值）' :
        `缺口期 #hdrShift=${JSON.stringify(heal.during.hdrShift)}、shiftAlert 非空=${typeof heal.during.alert === 'string'}、` +
        `console.error ${heal.during.errors} 条；恢复后 #hdrShift=${JSON.stringify(heal.after.hdrShift)}、` +
        `#hdrShiftTime=${JSON.stringify(heal.after.hdrShiftTime)}、#hdrTeam=${JSON.stringify(heal.after.hdrTeam)}、` +
        `shiftAlert=${JSON.stringify(heal.after.alert)}、console.error 仍 ${heal.after.errors} 条`
    );

    /* ---- E37（★，真机验证查出）：自愈后**样式也要复原** ----
       真机三态实测：基线 `className="shift-badge"`／`color=rgb(159,216,255)` → 缺口态 `chip chip-err`／
       `rgb(255,0,0)` → **自愈后仍是 `chip chip-err`／`rgb(255,0,0)`**。
       根因：`src/components/HeaderBar.js` 只在缺口分支 `setClass('hdrShift','chip chip-err')`，
       正常分支只 `setText` 不重置 class，而 `index.html:32` 的初始类是 `shift-badge`。
       判据＝三态比对：基线 class＝`index.html` 的初始类 → 缺口 class 含 `chip-err` →
       自愈 class **逐字回到初始类**。颜色在同一条 class 上从样式表推出，故 class 复原即颜色复原
       （真机 computed color 由浏览器侧探针 `tests\._verify\b1\probe-e34-browser.js` 复核）。 ---- */
    check(
      'E37（D9）自愈后班次徽标样式复原：缺口态 class 含 chip-err，配置改回后 #hdrShift 的 className' +
      '**逐字回到 index.html 的初始类**（与基线一致的非错误样式、颜色随之复原，不靠改 index.html/CSS）',
      healErr === null && heal !== null &&
      heal.initialClass !== null && /shift-badge/.test(heal.initialClass) &&
      heal.beforeGap.hdrShift.cls === heal.initialClass &&
      /chip-err/.test(heal.during.hdrShiftClass) &&
      heal.after.hdrShiftClass === heal.initialClass &&
      !/chip-err/.test(heal.after.hdrShiftClass),
      healErr ? `夹具执行异常：${healErr}` : heal === null ? '（无观察值）' :
        `index.html 初始 class=${JSON.stringify(heal.initialClass)}；` +
        `基线 className=${JSON.stringify(heal.beforeGap.hdrShift.cls)} → ` +
        `缺口态 className=${JSON.stringify(heal.during.hdrShiftClass)} → ` +
        `自愈后 className=${JSON.stringify(heal.after.hdrShiftClass)}`
    );

    /* ---- E38b（D9）：自愈后统计/进度位回到缺口前的真实值 ----
       与上面 E38 配对：那条防"把无数据显示成 0"，这条防"把无数据当成常态/占位回不来"。
       分两类判据（缺口期到自愈跨越 3 帧 ⇒ 真实时钟往前走了 3 秒）：
         · **离散位**（计划数、合格率、稼动率、班次进度百分数）逐字相等；
         · **时长位**（已进行/剩余）跨度不能逐字相等 —— 改为"合法 HH:MM:SS + 相对基线的位移 ≤ 10 s"
           （真值确实在走），既排除占位"—"，也不把正常推进判成假红。 ---- */
    const STRICT_BACK_IDS = ['sPlan', 'sFpy', 'sOee', 'shProgressPct'];
    const CLOCK_BACK_IDS = ['shElapsed', 'shRemaining'];
    const secsOf = v => {
      const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(v || '');
      return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
    };
    const strictBad = heal === null ? STRICT_BACK_IDS.slice()
      : STRICT_BACK_IDS.filter(id => heal.after.backCells[id] !== heal.beforeGap.stats[id]);
    const clockBad = heal === null ? CLOCK_BACK_IDS.slice()
      : CLOCK_BACK_IDS.filter(id => {
        const a = secsOf(heal.beforeGap.stats[id]);
        const b = secsOf(heal.after.backCells[id]);
        return a === null || b === null || Math.abs(b - a) > 10;
      });
    const duringBad = heal === null ? HEAL_BACK_IDS.slice()
      : HEAL_BACK_IDS.filter(id => heal.during.noDataCells[id] !== '—');
    check(
      'E38b（D9）自愈后统计/班次进度位回到缺口前的真实值：离散位（#sPlan/#sFpy/#sOee/#shProgressPct）逐字相等、' +
      '时长位（#shElapsed/#shRemaining）为合法 HH:MM:SS 且相对基线位移 ≤10 s；' +
      '缺口期这六格均为显式无数据"—"（无数据不是常态、也不靠"非占位"蒙过）',
      healErr === null && heal !== null && strictBad.length === 0 && clockBad.length === 0 && duringBad.length === 0 &&
      heal.during.statsNoData === true && heal.after.statsNoData === false,
      healErr ? `夹具执行异常：${healErr}` : heal === null ? '（无观察值）' :
        `缺口前基线＝${JSON.stringify(heal.beforeGap.stats)}；缺口期＝${JSON.stringify(heal.during.noDataCells)}` +
        `（非"—"的位=${JSON.stringify(duringBad)}）；自愈后＝${JSON.stringify(heal.after.backCells)}` +
        `（离散位未回到基线=${JSON.stringify(strictBad)}；时长位不合法或位移>10s=${JSON.stringify(clockBad)}）；` +
        `stats.noData ${JSON.stringify(heal.during.statsNoData)} → ${JSON.stringify(heal.after.statsNoData)}`
    );
  }

  /* ===== U7b E39（★★，D10）：E38 的同族残留 —— 缺口帧"把无法计算显示成零"还剩 2 处 ===== */
  section('U7b 缺口帧"无法计算"残留两处的显式无数据（E39）');

  /* 立案（D9 定位，负责人 2026-09-27 裁定方案 (a)；E38 已按此口径在 `StatsPanel`（15 个统计位）与
     `ShiftPanel`（3 个班次进度位）收口并真机验证通过，本次收 E38 的**同族残留 2 处**）：
       ① `src/components/DeviceStatusPanel.js`：缺口帧 `#stRunTime` 走 `state.stats.runSec || 0`
          ⇒ 显示 `00:00:00`，读起来像"本班零运行"（实测基线 `01:51:00`）；
       ② `src/components/TaskPanel.js`：缺口帧 `#tkProgressText` 走 `state.stats.done / plan`
          ⇒ 显示「当班已完成 0 / 0 件」，读起来像"当班一件没干"（实测基线「52 / 180 件」）。
     口径（与 E38 完全一致，不另造机制）：凡**无法计算**的数值一律显示**显式无数据**「—」，
     **禁止** `0`／`0.0%`／`00:00:00`／空串；判断**只认显式状态位** `state.stats.noData`
     （**不得**靠"值是不是 0"去猜 —— 真实 0 仍显示 0）；配置改回后**自愈**回真实值。
     判据一律**行为**判据（真 main.js 逐帧驱动 + 节点文本 + 本帧写入证据），不做源码字符串匹配（ADR-0004 D23）。 ---- */
  {
    const COMPONENTS_E39 = [
      'src/components/HeaderBar.js', 'src/components/TabsBar.js', 'src/components/CurveChart.js',
      'src/components/DeviceStatusPanel.js', 'src/components/TaskPanel.js', 'src/components/ShiftPanel.js',
      'src/components/StatsPanel.js', 'src/components/AlarmPanel.js', 'src/components/MaintPanel.js',
      'src/components/NoticePanel.js', 'src/components/SettingPanel.js'
    ];
    const GAP_E39 = [{ name: '晚班', start: 0, end: 8 }, { name: '中班', start: 16, end: 24 }];
    const FULL_E39 = [
      { name: '晚班', start: 0, end: 8 },
      { name: '早班', start: 8, end: 16 },
      { name: '中班', start: 16, end: 24 }
    ];
    const NO_DATA_E39 = '—';
    /* E39 两处：`#stRunTime`（设备状态页"实时运行时长"）与 `#tkProgressText`（任务页"当班已完成"文案） */
    const E39_IDS = ['stRunTime', 'tkProgressText'];
    const textOf = (fx, id) => String(fx.node(id).textContent || '');
    const snapE39 = fx => E39_IDS.reduce((a, id) => (a[id] = textOf(fx, id), a), {});
    const writesOf = (fx, id) => fx.out.filter(e => e.kind === 'text' && e.id === id).length;
    /** 判"这一格是不是显式无数据表达"：整格等于占位符，或**文案里含独立占位符**"… — 件"
        （任务页的"当班已完成"位本身就是一句完整文案）；同时不得是 0 / 0.0% / 空串 / undefined 文本 */
    const isNoDataE39 = v => {
      const s = String(v === undefined || v === null ? '' : v);
      if (s === '' || /^(0(\.0+)?%?)$/.test(s)) return false;
      return s === NO_DATA_E39 || s.indexOf(NO_DATA_E39) >= 0;
    };
    /**
     * 判"像是把无法计算写成了零"：时长位是 `00:00:00`（或空串），或完成数位出现"0 / N 件"/"0 件"
     * —— 注意 `0 / N 件` 是**缺陷形状**（0 计划也是 0），真实 0 的口径另由控制组按 noData:false 判定。
     */
    const zeroLikeE39 = v => {
      const s = String(v === undefined || v === null ? '' : v);
      return s === '' || s === '00:00:00' || /(^|[^\d])0\s*\/\s*\d+\s*件/.test(s);
    };
    const hasCountE39 = v => /\d+\s*\/\s*\d+\s*件/.test(String(v || ''));
    const secsE39 = v => {
      const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(v || ''));
      return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
    };
    const E39 = { err: null, r: null };
    try {
      const fx = loadFrameFixture(COMPONENTS_E39);
      fx.frame();                                    /* 首帧（正常配置）+1 s 稳态 */
      const beforeGap = snapE39(fx);
      /* 基线帧的**结构**证据（防"组件压根没跑也能绿"）：两处都被写过、且写着真实值 */
      const baselineWrites = E39_IDS.reduce((a, id) => (a[id] = writesOf(fx, id), a), {});
      const baselineStat = {
        noData: fx.w.MockData.state.stats.noData,
        runSec: fx.w.MockData.state.stats.runSec,
        done: fx.w.MockData.state.stats.done
      };
      const gapWritesBefore = E39_IDS.reduce((a, id) => (a[id] = writesOf(fx, id), a), {});

      fx.setShiftList(GAP_E39);                      /* 内存覆盖 ⇒ 下一帧起 `shiftOf()` 抛缺口 */
      fx.frame();
      const during = {
        cells: snapE39(fx),
        statsNoData: fx.w.MockData.state.stats.noData,
        raw: { runSec: fx.w.MockData.state.stats.runSec, done: fx.w.MockData.state.stats.done }
      };
      /* "缺口帧确实被本帧改写"：这一帧里两个节点各被**再写一次**（不是沿用上帧文本） */
      const gapWrites = E39_IDS.reduce((a, id) => (a[id] = writesOf(fx, id) - gapWritesBefore[id], a), {});

      fx.setShiftList(FULL_E39);                     /* 就地改回正常配置（同一个数组引用） */
      fx.frame();
      const heal = {
        cells: snapE39(fx),
        statsNoData: fx.w.MockData.state.stats.noData,
        raw: { done: fx.w.MockData.state.stats.done, plan: fx.w.MockData.state.stats.plan }
      };

      /* 控制组（锁"只认状态位、不靠值猜"）：真实 0 + `noData:false` ⇒ 两处**照旧显示 0**，
         不是"—"。这是**真实零运行**的合法表达（如班次刚开始/设备刚启动），不得被本处置吞掉。
         为什么不复用上面那个夹具：`step()` 每一帧都会重算 `state.stats`（注入时钟从 10:20:30 起步，
         `runSec` 必然非 0），人为置 0 会被下一帧覆盖掉 —— 那就观察不到"值是 0 而状态位为 false"这一态。
         故这里**直接以受控 state 调真组件**（与 U3b 的 `W.Components.*.render(受控 state)` 同一手法：
         真 state 取 `MockData.state`，只覆盖 `runSec/done` 与显式状态位），断言仍然是**行为**判据
         （组件写出的节点文本），不是源码字符串匹配。 */
      const st = fx.w.MockData.state.stats;
      const zeroState = Object.assign({}, fx.w.MockData.state, {
        stats: Object.assign({}, st, { runSec: 0, done: 0, noData: false })
      });
      const zeroWritesBefore = E39_IDS.reduce((a, id) => (a[id] = writesOf(fx, id), a), {});
      fx.w.Components.DeviceStatusPanel.render(zeroState);
      fx.w.Components.TaskPanel.render(zeroState);
      const zero = {
        cells: snapE39(fx),
        statsNoData: zeroState.stats.noData,
        raw: { runSec: zeroState.stats.runSec, done: zeroState.stats.done, plan: zeroState.stats.plan }
      };
      const ctrlWrites = E39_IDS.reduce((a, id) => (a[id] = writesOf(fx, id) - zeroWritesBefore[id], a), {});

      E39.r = { beforeGap, baselineWrites, baselineStat, during, gapWrites, heal, zero, ctrlWrites };
    } catch (e) {
      E39.err = e.message;
    }

    const r39 = E39.r;
    const gapBad = r39 === null ? E39_IDS.slice()
      : E39_IDS.filter(id => !isNoDataE39(r39.during.cells[id]) || zeroLikeE39(r39.during.cells[id]));
    check(
      'E39（D10）缺口帧"实时运行时长"（#stRunTime）与任务页"当班已完成"文案（#tkProgressText）显示**显式无数据**' +
      `（"${NO_DATA_E39}"）：一律为占位，**不得**是 0 / 00:00:00 / 0 / N 件 / 空串，且缺口帧 state.stats.noData === true`,
      E39.err === null && r39 !== null && r39.during.statsNoData === true && gapBad.length === 0,
      E39.err ? `夹具执行异常：${E39.err}` : r39 === null ? '（无观察值）' :
        `缺口帧 #stRunTime=${JSON.stringify(r39.during.cells.stRunTime)}、` +
        `#tkProgressText=${JSON.stringify(r39.during.cells.tkProgressText)}；` +
        `不合判据的位=${JSON.stringify(gapBad)}（判据：显式"—"且不是 0/00:00:00/0_N件/空串）；` +
        `state.stats.noData=${JSON.stringify(r39.during.statsNoData)}；` +
        `缺口帧 state.stats=${JSON.stringify(r39.during.raw)}`
    );

    check(
      'E39b（D10）缺口帧这两处**确实是被本帧改写过的**（本帧各被写入 ≥1 次、且文本不等于缺口前基线的真实值）：' +
      '证明断言观察到的是"无数据"状态本身，而不是"这两格压根没被渲染/没被写"',
      E39.err === null && r39 !== null &&
      E39_IDS.every(id => r39.gapWrites[id] >= 1) &&
      E39_IDS.every(id => r39.during.cells[id] !== r39.beforeGap[id]),
      E39.err ? `夹具执行异常：${E39.err}` : r39 === null ? '（无观察值）' :
        `缺口前基线=${JSON.stringify(r39.beforeGap)}；缺口帧=${JSON.stringify(r39.during.cells)}；` +
        `缺口帧内写入次数=${JSON.stringify(r39.gapWrites)}（应各 ≥1）；` +
        `仍等于基线的位=${JSON.stringify(E39_IDS.filter(id => r39.during.cells[id] === r39.beforeGap[id]))}（应全不同）`
    );

    /* 自愈判据分两类（缺口期到自愈跨越 2 帧 ⇒ 真实时钟往前走 2 s）：时长位按"合法 HH:MM:SS +
       相对基线位移 ≤10 s"（真值确实在走，不把正常推进判成假红）；完成数位按"回到正整数件数，
       且与基线同形/同量级"（完成数派生于运行时长，位移由同一条时钟推断，故不要求逐字相等）。 */
    const healBad = r39 === null ? E39_IDS.slice()
      : E39_IDS.filter(id => isNoDataE39(r39.heal.cells[id]) || zeroLikeE39(r39.heal.cells[id]));
    const healRunSecs = r39 === null ? null : secsE39(r39.heal.cells.stRunTime);
    const baseRunSecs = r39 === null ? null : secsE39(r39.beforeGap.stRunTime);
    const healDoneM = r39 === null ? null : /当班已完成\s*(\d+)\s*\/\s*(\d+)\s*件/.exec(r39.heal.cells.tkProgressText);
    const baseDoneM = r39 === null ? null : /当班已完成\s*(\d+)\s*\/\s*(\d+)\s*件/.exec(r39.beforeGap.tkProgressText);
    const healRunOk = healRunSecs !== null && baseRunSecs !== null && Math.abs(healRunSecs - baseRunSecs) <= 10;
    const healDoneOk = !!healDoneM && !!baseDoneM && Number(healDoneM[1]) > 0 &&
      Number(healDoneM[2]) === Number(baseDoneM[2]) && Math.abs(Number(healDoneM[1]) - Number(baseDoneM[1])) <= 2;
    check(
      'E39c（D10）自愈后两处回到真实值：配置改回无缺口后 #stRunTime 为合法 HH:MM:SS（非"—"、相对基线位移 ≤10 s）、' +
      '#tkProgressText 回到真实正整数完成数（形如「当班已完成 N / M 件」，计划数与基线一致）',
      E39.err === null && r39 !== null && healRunOk && healDoneOk && healBad.length === 0 &&
      r39.heal.statsNoData === false,
      E39.err ? `夹具执行异常：${E39.err}` : r39 === null ? '（无观察值）' :
        `自愈后 #stRunTime=${JSON.stringify(r39.heal.cells.stRunTime)}（合法 HH:MM:SS=${healRunSecs !== null}、` +
        `相对基线 ${JSON.stringify(r39.beforeGap.stRunTime)} 位移=${healRunSecs !== null && baseRunSecs !== null ? Math.abs(healRunSecs - baseRunSecs) : 'n/a'} s，判据 ≤10 s）；` +
        `#tkProgressText=${JSON.stringify(r39.heal.cells.tkProgressText)}（基线 ${JSON.stringify(r39.beforeGap.tkProgressText)}，` +
        `正整数完成数=${!!healDoneM && Number(healDoneM[1]) > 0}）；` +
        `仍为无数据/零形状的位=${JSON.stringify(healBad)}；` +
        `state.stats.noData ${JSON.stringify(r39.during.statsNoData)} → ${JSON.stringify(r39.heal.statsNoData)}`
    );

    /* 防"只认状态位、不靠值猜"被改坏：真实 0（`noData:false`）必须**照旧显示 0**，
       绝不因为"值是 0"就被写成"—" —— 否则真实的"零运行/零完成"会被本处置吞掉。 */
    check(
      'E39d（D10）真实 0 不被误显示为"—"（锁定"只认状态位、不靠值猜"）：人为把统计置 0 但显式 noData=false 时，' +
      '#stRunTime 仍为合法时长（00:00:00 属真实零运行的合法表达）、#tkProgressText 仍为「当班已完成 0 / 180 件」，两处都**不是**"—"',
      E39.err === null && r39 !== null &&
      r39.zero.statsNoData === false &&
      r39.ctrlWrites.stRunTime >= 1 && r39.ctrlWrites.tkProgressText >= 1 &&
      secsE39(r39.zero.cells.stRunTime) !== null && !isNoDataE39(r39.zero.cells.stRunTime) &&
      /当班已完成\s*0\s*\/\s*180\s*件/.test(r39.zero.cells.tkProgressText) &&
      !isNoDataE39(r39.zero.cells.tkProgressText),
      E39.err ? `夹具执行异常：${E39.err}` : r39 === null ? '（无观察值）' :
        `控制组 state.stats.noData=${JSON.stringify(r39.zero.statsNoData)}（真实 0 ⇒ 不得显示"—"）；` +
        `#stRunTime=${JSON.stringify(r39.zero.cells.stRunTime)}、` +
        `#tkProgressText=${JSON.stringify(r39.zero.cells.tkProgressText)}；` +
        `本帧两处写入次数=${JSON.stringify(r39.ctrlWrites)}（各 ≥1 ⇒ 确实渲染过，不是"没跑也算过"）`
    );
  }

  /* ---- E35（★）：`#setSyncBtn`（NTP 手动同步）缺锁定守卫 ----
     与三处保存（维保/公告/参数，见 R26-P2-1 的 f3）**同一口径**：锁定态必须 `denyLocked('时间同步')`
     —— 既不得写 `pushLog('时间同步')`，也不得只改 `#setMsg`（那是 `#setMsg` 而不是指定的反馈位），
     而要在 `#entryMsg` 上给出可见反馈（复用该文件既有 `denyLocked()`，不新造提示机制）。
     判据是行为判据：真 SettingPanel + 真 state，锁定态点击后看 `state.opLog` 有没有多出"时间同步"、
     解锁态点击是否照旧留痕（防止"把守卫改成永远拒绝"也能过）。 ---- */
  {
    let syncErr = null;
    let sync = null;
    try {
      const fx = loadAutoLockFixture();
      const M = fx.w.MockData;
      fx.w.Components.SettingPanel.bind(M.state, () => {});
      const opLogHas = action => (M.state.opLog || []).some(o => o.action === action);
      const syncLogs = () => (M.state.opLog || []).filter(o => o.action === '时间同步').length;

      M.setUnlocked(false);                        /* 相当于自动锁定到点之后的锁定态 */
      const entry = fx.node('entryMsg');
      const beforeText = String(entry.textContent || '');
      const beforeCount = syncLogs();
      fx.click('setSyncBtn');
      const locked = {
        logs: syncLogs() - beforeCount,
        msgText: String(fx.node('setMsg').textContent || ''),
        entryText: String(entry.textContent || ''),
        entryChanged: String(entry.textContent || '') !== beforeText
      };

      M.setUnlocked(true);                         /* 解锁态：真路径（#setUnlockBtn → tryUnlock）之外的等价置位 */
      const beforeCount2 = syncLogs();
      fx.click('setSyncBtn');
      const unlocked = {
        logs: syncLogs() - beforeCount2,
        msgText: String(fx.node('setMsg').textContent || '')
      };
      sync = { locked, unlocked, hasAction: opLogHas('时间同步') };
    } catch (e) {
      syncErr = e.message;
    }
    check(
      'E35（D8）FR-8.2/C-84③ 锁定态点击 NTP 同步按钮不写操作日志：不产生 pushLog(\'时间同步\')，' +
      '且在 #entryMsg 给出可见反馈（复用 denyLocked()）；解锁态点击照旧留痕并提示"NTP 同步完成"',
      syncErr === null && sync !== null &&
      sync.locked.logs === 0 && sync.locked.entryChanged &&
      /当前已锁定/.test(sync.locked.entryText) && /时间同步/.test(sync.locked.entryText) &&
      sync.locked.msgText === '' &&                       /* 不再抢在守卫前写 #setMsg */
      sync.unlocked.logs === 1 && /NTP 同步完成/.test(sync.unlocked.msgText),
      syncErr ? `夹具执行异常：${syncErr}` : sync === null ? '（无观察值）' :
        `锁定态：新增"时间同步"日志 ${sync.locked.logs} 条（应 0）、#entryMsg ${JSON.stringify(sync.locked.entryText)}、` +
        `#setMsg=${JSON.stringify(sync.locked.msgText)}；解锁态：新增日志 ${sync.unlocked.logs} 条（应 1）、` +
        `#setMsg=${JSON.stringify(sync.unlocked.msgText)}`
    );
  }

  /* ===== F15（D11，2026-09-28 独立复核 R-2026-09-28-02）：源降级横幅 + frame:null 缺值 =====
     立案：
       F15-1（P1）`fallbackToDemo()` 曾把 `state.device.link` 置 `'online'`，而源降级横幅的
         className 里含 `degraded-banner` ⇒ 被 `Dashboard.renderDegraded()` 的
         `document.querySelector('.degraded-banner')` 命中 ⇒ 同一次 `renderAll` 走
         `!offline && banner ⇒ banner.remove()`，**降级提示在 1 帧内被删**（复核真启动路径实测
         5 帧后两条横幅全没，只剩页脚小角标）。
       F15-2（P2）`snapshot.frame === null`（服务端从未收到帧）时"先归 null"的守卫在
         `applyServerFrame()` 内部、而它只在 `frame` 是对象时才被调 ⇒ 实测位保留 `mockData`
         演示种子值（界面 `#stDepth="5.00" #stFps="400"`）—— ADR-0008 D3「不得用演示值顶替」。
     判据一律**行为**判据（真启动路径逐帧驱动 + 真节点文本 + 本帧写入证据），遵 ADR-0004 D23。
     ⚠ 本节的"横幅存在且只 1 条"断言**对 0 条为假**（`>0` 与 `===1` 同时成立才过）——
       这正是 F15-1 立案的"空洞断言"修补点（D22 变异 8 可指名变红）。 ---- */
  {
    const F15_COMPONENTS = [
      /* `loadFrameFixture` 的 `componentRels` 会按顺序 `run()` 这些文件；它固定预加载的是
         config/fieldMap/format/mockData/api/Dashboard。W5-② 的两个新服务（形状翻译与
         服务端取数）必须显式列进来，否则 `window.StateAdapter` / `window.BoardSource` 是空的。 */
      'src/services/stateAdapter.js', 'src/services/boardSource.js',
      'src/components/HeaderBar.js', 'src/components/TabsBar.js', 'src/components/CurveChart.js',
      'src/components/DeviceStatusPanel.js', 'src/components/TaskPanel.js', 'src/components/ShiftPanel.js',
      'src/components/StatsPanel.js', 'src/components/AlarmPanel.js', 'src/components/MaintPanel.js',
      'src/components/NoticePanel.js', 'src/components/SettingPanel.js'
    ];
    const SOURCE_BANNER = 'source-fallback-banner';
    const LINK_BANNER = 'degraded-banner';
    const R = { err: null, r: null };

    try {
      /* (A) 服务端不可达 ⇒ 回退演示源 ⇒ 源降级横幅**必须存在**且**1 s/5 s/30 s 后仍在**、且只 1 条 */
      const fx = loadFrameFixture(F15_COMPONENTS);
      fx.w.BoardConfig.dataSource = 'server';
      fx.w.BoardConfig.board.baseUrl = 'http://127.0.0.1:1';   // 必然连不上
      const st = fx.w.MockData.state;
      /* 让"回退"这一异步收敛在**注入时钟**下完成：直接调真实出口，再逐帧驱动渲染循环 */
      fx.w.BoardSource.fallbackToDemo('F15 用例：端口不可达', st);
      fx.w.Pages.Dashboard.renderAll(st);

      const snap = () => ({
        src: fx.banners(SOURCE_BANNER).length,
        link: fx.banners(LINK_BANNER).filter(el =>
          String(el.className).split(/\s+/).indexOf(SOURCE_BANNER) < 0).length,
        text: fx.banners(SOURCE_BANNER).map(el => String(el.textContent || ''))
      });
      const s1 = snap();
      fx.frame();                                    // ≈1 s
      const s1f = snap();
      fx.frame(); fx.frame(); fx.frame(); fx.frame(); // 累计 ≈5 s
      const s5 = snap();
      for (let i = 0; i < 25; i++) fx.frame();        // 累计 ≈30 s
      const s30 = snap();

      R.r = {
        afterFallback: s1,
        after1s: s1f,
        after5s: s5,
        after30s: s30,
        dataSource: fx.w.BoardConfig.dataSource,
        sourceFallback: st.sourceFallback === true,
        errors: fx.errors('error')
      };
    } catch (e) { R.err = e.message; }

    check(
      'F15-1（D11）服务端不可达回退演示源后，**源降级横幅存在（>0 条）且 1 s / 5 s / 30 s 后仍在**、' +
      '文本正确、且**不叠加**（恰 1 条；既有上位机链路横幅已被摘掉，不得两条同屏）',
      R.err === null && R.r !== null &&
      R.r.afterFallback.src === 1 && R.r.after1s.src === 1 &&
      R.r.after5s.src === 1 && R.r.after30s.src === 1 &&
      R.r.after30s.link === 0 &&
      R.r.after30s.text.some(t => t.indexOf('看板服务端不可用') >= 0 && t.indexOf('已回退演示数据源') >= 0),
      R.err ? `夹具执行异常：${R.err}` : R.r === null ? '（无观察值）' :
        `回退后：源横幅 ${R.r.afterFallback.src} 条 → 1 s ${R.r.after1s.src} 条 → 5 s ${R.r.after5s.src} 条 → ` +
        `30 s ${R.r.after30s.src} 条（均应 1）；30 s 时链路横幅 ${R.r.after30s.link} 条（应 0）；` +
        `文本=${JSON.stringify(R.r.after30s.text)}；sourceFallback=${R.r.sourceFallback}；` +
        `console.error=${R.r.errors.length}`
    );
    check(
      'F15-1b（D11）源降级**不再借用 `device.link` 表达**：其驱动位是 `state.sourceFallback`；' +
      '且真·上位机断连横幅（`device.link !== \'online\'`）在**未回退**时仍能出现、链路恢复后自行消失',
      R.err === null && R.r !== null && R.r.sourceFallback === true &&
      (() => {
        try {
          const f2 = loadFrameFixture(F15_COMPONENTS);
          const s2 = f2.w.MockData.state;
          s2.device.link = 'offline';
          f2.w.Pages.Dashboard.renderAll(s2);
          const shown = f2.banners(LINK_BANNER).filter(el =>
            String(el.className).split(/\s+/).indexOf(SOURCE_BANNER) < 0).length;
          s2.device.link = 'online';
          f2.w.Pages.Dashboard.renderAll(s2);
          const hidden = f2.banners(LINK_BANNER).filter(el =>
            String(el.className).split(/\s+/).indexOf(SOURCE_BANNER) < 0).length;
          R.r.linkPair = { shown, hidden };
          return shown === 1 && hidden === 0;
        } catch (e) { R.r.linkPair = { err: e.message }; return false; }
      })(),
      R.err ? `夹具执行异常：${R.err}` : `sourceFallback=${R.r && R.r.sourceFallback}；` +
        `链路横幅：断连时 ${R.r && R.r.linkPair && R.r.linkPair.shown} 条（应 1）→ 恢复后 ` +
        `${R.r && R.r.linkPair && R.r.linkPair.hidden} 条（应 0）`
    );

    /* (B) `snapshot.frame === null`（服务端从未收到帧）⇒ 实测位「—」、real 逐键 null、零 console.error。
       走**真网络路径**：把沙箱 fetch 替换成"返回 `{ok:true, snapshot}`"，**await** BoardSource
       的启动 Promise（`startServerSource()` 的当前实现是同步注册 + 两段 `.then()`，故必须等它收敛），
       再驱动真 `step()` 逐帧渲染。 */
    const N = { err: null, r: null };
    const N_DONE = (async () => {
      try {
        const fx = loadFrameFixture(F15_COMPONENTS, '?source=server');
        const REAL_FETCH = fx.w.fetch;
        const st = fx.w.MockData.state;
        /* ⚠ "演示种子值确实存在"这个**前置**必须在**调用适配层之前**取：
           适配层一旦把实测位归 null，就读不到种子了（实测踩过：前置取值晚了一步，
           于是"前置不成立"把整条断言判红，掩盖了真实结论）。 */
        const seedBefore = {
          depth: st.task.real.depth, speed: st.task.real.speed, vx: st.task.real.vx, vy: st.task.real.vy,
          fps: st.task.real.fps, gain: st.task.real.gain, shutter: st.task.real.shutter,
          cameraDepth: st.task.real.cameraDepth
        };
        fx.w.BoardConfig.board.baseUrl = 'http://127.0.0.1:1';
        fx.w.fetch = (url, init) => {
          const u = String(url);
          if (/\/upload\/(pending|status)/.test(u)) {
            return REAL_FETCH ? REAL_FETCH(url, init) : Promise.reject(new Error('no fetch'));
          }
          return Promise.resolve({
            ok: true, status: 200,
            text: () => Promise.resolve(JSON.stringify({
              ok: true, at: '2026-09-28 10:00:00', seq: 0,
              snapshot: {
                link: null, task: null, device: null, frame: null,
                stats: { planQty: 180, shift: null }, standard: null, upload: null
              }
            }))
          });
        };
        await fx.w.BoardSource.startServerSource(st, () => {});   // 等首帧快照真正落地
        /* ⚠ 这里**不**再驱动 `fx.frame()`：`loadFrameFixture` 的 `main.js` 是在
           `BoardConfig.dataSource` 仍为默认 `'mock'` 时启动的（`sourceKind==='none'`），
           它的 `step()` 会跑 `M.tick()`；本用例是**异步**等 `startServerSource()` 收敛之后才检查，
           此刻若再驱动一帧，`M.tick()` 会把演示值写回来，从而看不到"归 null"这一步。
           本用例要证的是**适配层把 frame:null 归成 null**（渲染层据此显示「—」），
           不是"服务端模式下 tick 不跑"——后者由门禁 `contract-check` 的源码形状断言与
           我的 W5-② 行为级夹具（判据②）负责。故：等快照落地 ⇒ 立即断言状态与已渲染文本。 */
        fx.w.Pages.Dashboard.renderAll(st);
        const IDS = ['stDepth', 'stSpeed', 'stVx', 'stVy', 'stFps', 'stGain', 'stShutter', 'stCamDepth'];
        N.r = {
          seedBefore,
          seedIsNumeric: Object.keys(seedBefore).every(k => typeof seedBefore[k] === 'number'),
          texts: IDS.reduce((a, id) => (a[id] = String(fx.node(id).textContent || ''), a), {}),
          realNull: ['depth', 'speed', 'vx', 'vy', 'fps', 'gain', 'shutter', 'cameraDepth']
            .every(k => st.task.real[k] === null),
          serverMode: st.serverMode === true,
          frameMissing: true,
          errors: fx.errors('error')
        };
      } catch (e) { N.err = e.message; }
      check(
        'F15-2（D11）`snapshot.frame === null`（服务端从未收到帧）⇒ 8 个实测位一律「—」、' +
        '`state.task.real` 逐键 `null`、整屏零 `console.error`（**不得**把 mockData 演示种子值当真实值显示）',
        N.err === null && N.r !== null && N.r.seedIsNumeric && N.r.serverMode && N.r.realNull &&
        Object.keys(N.r.texts).every(id => N.r.texts[id] === '—') && N.r.errors.length === 0,
        N.err ? `夹具执行异常：${N.err}` : N.r === null ? '（无观察值）' :
          `回退前演示种子=${JSON.stringify(N.r.seedBefore)}；real 逐键 null=${N.r.realNull}（serverMode=${N.r.serverMode}）；` +
          `界面=${JSON.stringify(N.r.texts)}；console.error=${N.r.errors.length}`
      );
    })();
    asyncChecks.push(N_DONE);

    /* (C) F15-3：服务端模式**不得**回退演示默认上下限（成对：演示模式仍回退） */
    const T = { err: null, r: null };
    try {
      const f3 = loadFrameFixture(F15_COMPONENTS);
      f3.w.BoardConfig.dataSource = 'server';
      const st3 = f3.w.MockData.state;
      st3.task.standard = undefined;
      const serverLim = f3.w.Api.standardLimits(st3);
      f3.w.BoardConfig.dataSource = 'mock';
      const st4 = f3.w.MockData.state;
      st4.task.standard = undefined;
      const demoLim = f3.w.Api.standardLimits(st4);
      T.r = { serverLim, demoLim };
    } catch (e) { T.err = e.message; }
    check(
      'F15-3（D11，ADR-0008 D3 裁定）服务端模式下**关闭**演示默认上下限回退：无标准 ⇒ ' +
      '`Api.standardLimits()` 双参数均 `null`（界面「标准未设定」/「—」、上报走 N-7 哨兵）；' +
      '**成对**：演示模式仍回退 `standards.default`（depth 5.30/4.80 · speed 5.20/4.80）',
      T.err === null && T.r !== null &&
      T.r.serverLim.depth === null && T.r.serverLim.speed === null &&
      !!T.r.demoLim.depth && T.r.demoLim.depth.upper === 5.30 && T.r.demoLim.depth.lower === 4.80 &&
      !!T.r.demoLim.speed && T.r.demoLim.speed.upper === 5.20 && T.r.demoLim.speed.lower === 4.80,
      T.err ? `夹具执行异常：${T.err}` : T.r === null ? '（无观察值）' :
        `服务端：depth=${JSON.stringify(T.r.serverLim.depth)} speed=${JSON.stringify(T.r.serverLim.speed)}（应均 null）；` +
        `演示：depth=${JSON.stringify(T.r.demoLim.depth)} speed=${JSON.stringify(T.r.demoLim.speed)}`
    );
  }

  /* ---------------- 汇总 ---------------- */
  /* F15-2 走真网络路径（`BoardSource.startServerSource()` 是异步的）⇒ 必须等它的断言跑完再汇总，
     否则那条断言的结果会落在"汇总行之后"（数字对不上、清单也漏它）。 */
  await Promise.all(asyncChecks);

  /* ===== F18（D12，2026-09-28 真机正向取证的真缺陷）：基地址必须**只留一份真源** =====
     立案：`src/services/api.js` 的 `serverBase()` 曾**自己读** `CFG.board.baseUrl`（空即空串），
     而 `boardSource.resolveBaseUrl()` 会按 `location.protocol === 'file:'` 回退到
     `http://127.0.0.1:8787` ⇒ 基地址被劈成两份：`EventSource` 拿对了 base，
     而本文件所有 REST 取数（`fetchSnapshot`/`fetchPending`/…）在 `file://` 下发出
     **相对路径** ⇒ 实际打到 `file:///D:/state`（`net::ERR_FILE_NOT_FOUND`）⇒ 首帧必失败
     ⇒ 优雅回退演示源 ⇒ **ADR-0008 D2 专为"双击 index.html"开的 CORS `Origin: null` 白名单
     从来没被用上**（那条路径整条是断的；真机实测角标显示「已回退 · 演示数据」而服务端在跑）。
     判据一律**行为**判据：桩 `fetch` 捕获**真实请求 URL**（不读源码字符串），遵 ADR-0004 D23。 ---- */
  {
    const F18_COMPONENTS = [
      'src/services/stateAdapter.js', 'src/services/boardSource.js',
      'src/components/HeaderBar.js', 'src/components/TabsBar.js', 'src/components/CurveChart.js',
      'src/components/DeviceStatusPanel.js', 'src/components/TaskPanel.js', 'src/components/ShiftPanel.js',
      'src/components/StatsPanel.js', 'src/components/AlarmPanel.js', 'src/components/MaintPanel.js',
      'src/components/NoticePanel.js', 'src/components/SettingPanel.js'
    ];
    /* (c) 用**独立最小 vm 上下文**（只装 config/fieldMap/api/mockData，不装 BoardSource、不跑 main.js）：
       `loadFrameFixture` 内部会 `wrapCalls()` 逐个包 `CALL_KEYS` 里的组件，无法表达"缺 BoardSource"。 */
    const F = { err: null, file: null, same: null, none: null };
    /** 取一次"URL 观察"：桩 fetch 只记 URL、返回网络错误式拒绝（本用例只关心 URL） */
    const observe = (fx, jobs) => {
      const urls = [];
      fx.w.__fetch = url => { urls.push(String(url)); return Promise.reject(new Error('F18 桩：不真发请求')); };
      return Promise.all(jobs(fx.w.Api)).then(() => urls);
    };
    try {
      /* (a) file:// ⇒ 8787（ADR-0008 D2 的核心承诺） */
      const a = loadFrameFixture(F18_COMPONENTS, '', { protocol: 'file:' });
      a.w.BoardConfig.board.baseUrl = '';            // 与真实配置一致（同源＝空串）
      const aResolved = a.w.BoardSource.resolveBaseUrl();
      const aBase = a.w.Api.getStatus().boardBaseUrl;
      const aUrls = await observe(a, Api => [Api.fetchSnapshot().catch(() => {}), Api.fetchPending().catch(() => {})]);
      F.file = { reserved: aResolved, base: aBase, urls: aUrls };

      /* (b) 成对：同源托管（https:）⇒ 空串 / 相对路径（不得把同源也写死成 8787） */
      const b = loadFrameFixture(F18_COMPONENTS, '', { protocol: 'https:' });
      b.w.BoardConfig.board.baseUrl = '';
      const bBase = b.w.Api.getStatus().boardBaseUrl;
      const bUrls = await observe(b, Api => [Api.fetchSnapshot().catch(() => {})]);
      F.same = { base: bBase, urls: bUrls, resolved: b.w.BoardSource.resolveBaseUrl() };

      /* (c) BoardSource 不存在 ⇒ 退旧读法、不抛（能力检测，不得 ReferenceError）。
         这里**不用** `loadFrameFixture`：它内部会把 `CALL_KEYS` 里的组件逐个包一层，
         而"存在性"恰恰要求清单里**没有** BoardSource + 全套组件仍在 ⇒ 用一个只装
         config/fieldMap/utils/api/mockData 的最小 vm 上下文（**不跑 main.js**），
         直接观察 `Api` 的基地址出口 —— 这正是 F18 要证的那一层。 */
      const cSandbox = { location: { search: '', protocol: 'file:' }, URLSearchParams };
      cSandbox.window = cSandbox;
      cSandbox.console = { log: () => {}, warn: () => {}, error: () => {} };
      cSandbox.__urls = [];
      cSandbox.__fetch = url => { cSandbox.__urls.push(String(url)); return Promise.reject(new Error('F18 桩：不真发请求')); };
      cSandbox.fetch = (...a) => cSandbox.__fetch(...a);
      cSandbox.AbortSignal = { timeout: () => ({}) };
      vm.createContext(cSandbox);
      const cRun = rel => vm.runInContext(readText(rel), cSandbox, { filename: path.join(ROOT, rel) });
      cRun('src/config/board.config.js');
      cRun('src/config/fieldMap.js');
      cRun('src/utils/dom.js');
      cRun('src/utils/format.js');
      cRun('src/services/api.js');
      cRun('src/services/mockData.js');
      cSandbox.BoardConfig.board.baseUrl = 'http://10.0.0.9:9999';
      const cBase = cSandbox.Api.getStatus().boardBaseUrl;
      await cSandbox.Api.fetchSnapshot().catch(() => {});
      const cUrls = cSandbox.__urls;
      F.none = { hasBoardSource: typeof cSandbox.BoardSource, base: cBase, urls: cUrls };
    } catch (e) { F.err = e.message; }

    check(
      'F18-a（D12）`file://`（双击 index.html）⇒ 基地址与 `BoardSource.resolveBaseUrl()` 逐字相同（`http://127.0.0.1:8787`），' +
      '且 `fetchSnapshot()` 的 URL **恰为** `http://127.0.0.1:8787/state`、`fetchPending()` 为 `http://127.0.0.1:8787/upload/pending`',
      F.err === null && F.file !== null &&
      F.file.reserved === 'http://127.0.0.1:8787' && F.file.base === F.file.reserved &&
      F.file.urls.indexOf('http://127.0.0.1:8787/state') >= 0 &&
      F.file.urls.indexOf('http://127.0.0.1:8787/upload/pending') >= 0,
      F.err ? `夹具执行异常：${F.err}` : F.file === null ? '（无观察值）' :
        `resolveBaseUrl()=${JSON.stringify(F.file.reserved)}；getStatus().boardBaseUrl=${JSON.stringify(F.file.base)}；` +
        `实际请求 URL=${JSON.stringify(F.file.urls)}`
    );
    check(
      'F18-b（D12，成对）同源托管（`https:`）+ 配置空串 ⇒ `boardBaseUrl === ""` 且 `fetchSnapshot()` 的 URL 是**相对** `/state`' +
      '（证明没有把同源情形也写死成 8787）',
      F.err === null && F.same !== null &&
      F.same.resolved === '' && F.same.base === '' && F.same.urls.indexOf('/state') >= 0,
      F.err ? `夹具执行异常：${F.err}` : F.same === null ? '（无观察值）' :
        `resolveBaseUrl()=${JSON.stringify(F.same.resolved)}；boardBaseUrl=${JSON.stringify(F.same.base)}；` +
        `实际请求 URL=${JSON.stringify(F.same.urls)}`
    );
    check(
      'F18-c（D12）`BoardSource` **不存在**时退回读 `CFG.board.baseUrl` 且**不抛**（能力检测，不得 `ReferenceError`）',
      F.err === null && F.none !== null && F.none.hasBoardSource === 'undefined' &&
      F.none.base === 'http://10.0.0.9:9999' && F.none.urls.indexOf('http://10.0.0.9:9999/state') >= 0,
      F.err ? `夹具执行异常：${F.err}` : F.none === null ? '（无观察值）' :
        `typeof BoardSource=${F.none.hasBoardSource}；boardBaseUrl=${JSON.stringify(F.none.base)}；` +
        `实际请求 URL=${JSON.stringify(F.none.urls)}`
    );
  }

  /* ===== W7-B'（D12）「每个前端源文件都必须被 `index.html` 显式注册」=====
     立案（真实缺口）：W7-B 加了 `src/services/selfCheckProbe.js`，却**没在 index.html 注册**
     ⇒ 真页面里 `window.SelfCheckProbe === undefined`，设置页永远停在「尚未接入服务端自检结果：
     正在探测…」占位；而当时夹具是**手写 rels** 直接把它塞进沙箱 ⇒ **门禁全绿**。
     这就是 D23 说的"断言没落在真集成路径上"。本仓无 ES 模块、无打包器，故把这条件做成硬不变量：
       · 判据真源＝`index.html` 的 `<script src>` 清单（`indexScriptRels()`）；
       · 故意不注册的文件必须进 `UNREGISTERED_ALLOWED`（rel → 原因）并在失败信息里打印；
       · 夹具侧由 `guardRegistered()` 兜住"手写清单替真页面补课"（见文件头）。 ---- */
  {
    const FRONT_SRC_DIRS = ['config', 'utils', 'services', 'components', 'pages'];
    const frontSrcFiles = [];
    for (const d of FRONT_SRC_DIRS) {
      const abs = path.join(ROOT, 'src', d);
      for (const f of fs.readdirSync(abs)) {
        if (f.endsWith('.js')) frontSrcFiles.push('src/' + d + '/' + f);
      }
    }
    frontSrcFiles.push('src/main.js');          /* 入口也在 `src/` 根下，同样必须注册 */
    /** **故意不注册**的白名单：rel → 原因（当前为空；新增一条必须写明"为什么页面不需要它"） */
    const UNREGISTERED_ALLOWED = {};
    const scripts = indexScriptRels();
    const missing = frontSrcFiles.filter(r => scripts.indexOf(r) < 0 && !UNREGISTERED_ALLOWED[r]);
    const ghosts = scripts.filter(r => frontSrcFiles.indexOf(r) < 0);
    const wlDump = Object.keys(UNREGISTERED_ALLOWED).length
      ? Object.keys(UNREGISTERED_ALLOWED).map(r => r + '（' + UNREGISTERED_ALLOWED[r] + '）').join('；')
      : '（空）';
    check(
      'W7-B\'-a（D12）`index.html` 的 `<script src>` 清单**覆盖全部前端源文件**' +
      '（`src/{config,utils,services,components,pages}/**/*.js` ＋ `src/main.js`）、且清单无死链；白名单为空',
      scripts.length > 0 && missing.length === 0 && ghosts.length === 0,
      `index.html 注册 ${scripts.length} 个脚本；前端源文件 ${frontSrcFiles.length} 个；` +
      `**未注册=${JSON.stringify(missing)}**（应 []）；死链=${JSON.stringify(ghosts)}（应 []）；白名单=${wlDump}`
    );
  }

  /* ===== W7-B（D12，FR-8.5 / NFR-26）：设置页「系统状态自检」改**服务端真实探测** =====
     立案：该栏此前是 `mockData.buildSelfCheck()` 的**演示数据**（服务端模式下更是空的 ⇒ 什么都看不到），
     现场拿它判断不了真实链路。本包按既有 7 条行名（`copy-check` 的 FR-8.5 映射锁住）把服务端
     **已有**只读端点映射进来：`GET /health`、`/ifd/status`、`/ifa/status`、`/upload/status`。
     判据一律**行为**判据：桩 `fetch` 返回**指名的真值** ⇒ 逐行对账界面文本与桩响应；
     并成对断言"演示模式仍走演示自检""探测失败不得显示成通过"。遵 ADR-0004 D23。 ---- */
  {
    /* W7-B'：**不再手写清单** —— 直接从 `index.html` 注册的脚本里派生。
       排除项及原因（都是**夹具**的替换，不是"忘了注册"，两者不可混为一谈）：
         · `board.config`/`fieldMap`/`format`/`mockData`/`api`/`Dashboard`/`main` 由夹具按序**自己预加载**，重复 run 会二次执行；
         · `src/utils/dom.js` 会被夹具的**观测型 Dom 桩**顶替（真 Dom 直接操作真 document，
           夹具的 `node()` 就观察不到节点了）。 */
    const FIXTURE_PRELOADED = ['src/config/board.config.js', 'src/config/fieldMap.js',
      'src/utils/format.js', 'src/utils/dom.js', 'src/services/mockData.js', 'src/services/api.js',
      'src/pages/Dashboard.js', 'src/main.js'];
    /** 组件/服务装载清单：**派生自 index.html**（含 `selfCheckProbe.js` —— 它没注册就不在这里） */
    const W7B_COMPONENTS = indexScriptRels().filter(r => FIXTURE_PRELOADED.indexOf(r) < 0);
    /** 自检七行的**行名**（逐字取自 `mockData.buildSelfCheck()`；`copy-check` FR-8.5 锁住） */
    const W7B_NAMES = ['看板主机网络', 'PC 上位机连接', 'MES 接口连通性', 'MES 上报队列',
      '本地数据库', '磁盘空间', 'NTP 时间同步'];
    /** 从渲染出来的 HTML 里读某一行的 `{lv, state}`（行名 + 结论标签） */
    const rowText = (fx, name) => {
      const html = String(fx.node('setSelfCheckList').innerHTML || '');
      const re = new RegExp('<span class="body">' + name + '</span><span class="meta ([a-z]+)">([^<]*)</span>');
      const m = re.exec(html);
      return m ? { lv: m[1], state: m[2] } : null;
    };
    const rowsDump = fx => W7B_NAMES.map(n => {
      const t = rowText(fx, n);
      return t ? n + '[' + t.lv + ']' + t.state : n + '=MISSING';
    });
    /** 装一套"指名真值"的桩响应（键＝去查询串的 path） */
    const stubFetch = (fx, table, opts) => {
      const o = opts || {};
      fx.w.__fetch = (url) => {
        const u = String(url);
        let path = u;
        const q = u.indexOf('?');
        if (q >= 0) path = u.slice(0, q);
        const i = path.indexOf('://');
        if (i >= 0) path = path.slice(path.indexOf('/', i + 3));
        const hit = table[path];
        if (!hit) return Promise.reject(new Error('W7-B 桩：未登记的 URL ' + u));
        if (hit.__hang) return new Promise(() => {});            // 永不 settle ⇒ 走超时/在途路径
        /* `Date` 头**按当前时刻算**（NTP 行的判据是"本地时钟 − 服务端 Date"） */
        const dateHdr = hit.__date === false ? null : new Date().toUTCString();
        return Promise.resolve({
          ok: hit.status >= 200 && hit.status < 300,
          status: hit.status,
          headers: { get: k => (String(k).toLowerCase() === 'date' ? dateHdr : null) },
          text: () => Promise.resolve(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body))
        });
      };
      if (o.baseUrl) fx.w.BoardConfig.board.baseUrl = o.baseUrl;
    };
    const W = { err: null, demoBefore: null, server: null, fail: null, demoAfter: null, timers: null,
      integration: null };
    /** 指名真值桩表（`(a)` 与 `(e)` 共用）。声明在 **try 之外**：`(e)` 特意放在 try 之后，
        以便"忘了注册"这类缺口发生时它仍能独立产出观察值。 */
    const HEALTHY_STUBS = {
      '/health': { status: 200, body: { ok: true, uptimeSec: 3661, dbWritable: true, version: 'V1.38',
        listen: '127.0.0.1:8787', pid: 4242, env: 'test', dataRoot: 'D:/data', dbFile: 'D:/data/board.db',
        streams: 2, lastError: null } },
      '/ifd/status': { status: 200, body: { ok: true, mount: 'ifD',
        counts: { received: 10, accepted: 9, stored: 9, rejected: 1 },
        link: { state: 'offline', online: false, staleMs: 5000, ageMs: 6000, lastAcceptedAt: null } } },
      '/ifa/status': { status: 200, body: { ok: true, mount: 'ifA', mounted: true,
        auth: { enabled: false, source: 'config', degraded: true, warning: '本机接口未启用鉴权' },
        counts: { byKind: {} } } },
      '/upload/status': { status: 200, body: { ok: true, configured: false, baseUrl: '', responseStyle: 'status',
        pendingCount: 3, warnThreshold: 1, capacity: 5000, alert: { warn: true }, autoRetry: false } }
    };
    try {
      /* (c-1) 演示模式基线 ＋ **直接对 `ensure()` 断言"演示模式下不探测"**。
         为什么不能只比"渲染前后相同"：那样若有人把演示短路删掉、又在别处补一次 `probe()`，
         断言仍会绿（本用例第一版 D22 变异 2 就是这样**假绿**的）。故这里同时钉两件事：
           ① `ensure()` 在演示模式下返回 **false**（没有发起探测）；
           ② 显式调一次 `probe()` 后，`state.selfCheck` **仍等于**演示那七行（`mockData` 的真源
              没被顶替）—— 渲染路径不再参与判断，判据落在**数据层**。 */
      const d0 = loadFrameFixture(W7B_COMPONENTS);
      /* W7-B'：**先点名**"页面根本没加载这个模块"这种缺口，否则后面只会报一句
         `Cannot read properties of undefined (reading 'reset')`，读的人看不出根因。 */
      if (!d0.w.SelfCheckProbe) {
        throw new Error('页面未加载 `window.SelfCheckProbe` —— `src/services/selfCheckProbe.js` ' +
          '很可能没在 index.html 注册（见 W7-B\'-a 的未注册清单）');
      }
      d0.w.BoardConfig.dataSource = 'mock';
      d0.w.Pages.Dashboard.renderAll(d0.w.MockData.tick(new Date()));
      W.demoBefore = rowsDump(d0);
      const demoRowsFromData = (d0.w.MockData.state.selfCheck || []).map(c => c.name + '[' + c.lv + ']' + c.state);
      const demoBeforeStr = JSON.stringify(demoRowsFromData);
      /* 演示模式的 7 行**全部**是 `lv:'ok'`（`buildSelfCheck()` 的演示口径）。这是"演示真源"的指纹：
         若探测结果被写进演示态，指纹必然被打破（探测行只会是 err/warn/ok 且文本完全不同）。 */
      const demoAllOk = (d0.w.MockData.state.selfCheck || []).length === 7 &&
        (d0.w.MockData.state.selfCheck || []).every(c => c.lv === 'ok');
      d0.w.SelfCheckProbe.reset();
      const demoEnsure = d0.w.SelfCheckProbe.ensure(d0.w.MockData.state, new Date());
      const demoProbeRows = await d0.w.SelfCheckProbe.probe(new Date());     // 显式跑一轮探测
      await new Promise(r => setTimeout(r, 30));                            // 交给可能的异步赋值落定
      const demoAfterStr = JSON.stringify((d0.w.MockData.state.selfCheck || []).map(c => c.name + '[' + c.lv + ']' + c.state));
      const demoProbeAllOk = demoProbeRows.length === 7 && demoProbeRows.every(r => r.lv === 'ok');
      /* 探测行的"非演示"指纹：**不是全 ok**，且前 6 行（四个端点相关）全 `err`
         （`磁盘空间` 是"尚未接入"的 `warn`，**不算** err —— 这正是本用例第一版把断言写错的地方：
         我曾要求"七行全 err"，那是错的口径）。 */
      const demoProbeReal = demoProbeRows.length === 7 && !demoProbeAllOk &&
        demoProbeRows.slice(0, 5).every(r => r.lv === 'err') && demoProbeRows[6].lv === 'err' &&
        demoProbeRows[5].lv === 'warn';
      W.demoGuard = {
        ensureReturned: demoEnsure,
        demoAllOk: demoAllOk,
        /* 演示真源没被顶替 ⇔ 渲染前后逐字相同 **且** 那七行仍是"全 ok"的演示指纹 */
        rowsEqual: demoBeforeStr === demoAfterStr,
        probeRowsAreReal: demoProbeReal
      };

      /* (a) 服务端模式 + 指名真值 ⇒ 逐行对账 */
      const a = loadFrameFixture(W7B_COMPONENTS, '?source=server');
      a.w.BoardConfig.dataSource = 'server';
      const stA = a.w.MockData.state;
      stA.serverMode = true;
      /* 指名真值表：`(a)` 与 `(e) 真集成路径` 共用（同一份桩，避免两处漂移）。
         声明在 **try 之外**：`(e)` 特意放在 try 之后以便独立于前面的成败。 */
      stubFetch(a, HEALTHY_STUBS, { baseUrl: 'http://127.0.0.1:8787' });
      const probeOk = await a.w.SelfCheckProbe.probe(new Date());
      stA.selfCheck = probeOk;
      a.w.Pages.Dashboard.renderAll(stA);
      W.server = {
        rows: W7B_NAMES.map(n => Object.assign({ name: n }, rowText(a, n) || { lv: 'MISSING', state: '' })),
        dump: rowsDump(a),
        errors: a.errors('error')
      };

      /* (b) 坏证据 ⇒ 对应行显式 err、其余行不受影响、零 console.error。
         这里刻意把"坏"分三类，验证**每一行只按自己的数据源**判定、不互相污染：
           · `/upload/status` → **503**：`MES 接口连通性` + `MES 上报队列` 两行 err；
           · `/health` → 200 但 **`dbWritable:false`**：只有 `本地数据库` err（`看板主机网络` 仍 ok、`NTP` 仍 ok）；
           · `/ifd/status` → 200 但 **`link.online:false`**：`PC 上位机连接` err。 */
      const b = loadFrameFixture(W7B_COMPONENTS, '?source=server');
      b.w.BoardConfig.dataSource = 'server';
      const stB = b.w.MockData.state;
      stB.serverMode = true;
      stubFetch(b, {
        '/health': { status: 200, body: { ok: true, uptimeSec: 120, dbWritable: false, version: 'V1.38',
          listen: '127.0.0.1:8787', pid: 1, env: 'test', dataRoot: 'D:/data', dbFile: 'D:/data/board.db',
          streams: 0, lastError: null } },
        '/ifd/status': { status: 200, body: { ok: true, mount: 'ifD', link: { state: 'offline', online: false, staleMs: 5000, ageMs: null } } },
        '/ifa/status': { status: 200, body: { ok: true, mount: 'ifA', mounted: true, auth: { enabled: false, degraded: false } } },
        '/upload/status': { status: 503, body: { ok: false, err: { code: 'NO_SERVICE', message: '上报服务未装配' } } }
      }, { baseUrl: 'http://127.0.0.1:8787' });
      const probeFail = await b.w.SelfCheckProbe.probe(new Date());
      stB.selfCheck = probeFail;
      b.w.Pages.Dashboard.renderAll(stB);
      W.fail = {
        rows: W7B_NAMES.map(n => Object.assign({ name: n }, rowText(b, n) || { lv: 'MISSING', state: '' })),
        dump: rowsDump(b),
        errorCount: b.errorCount()
      };

      /* (c-2) 探测过后再回演示模式 ⇒ 自检仍逐项等于演示基线 */
      d0.w.BoardConfig.dataSource = 'mock';
      d0.w.Pages.Dashboard.renderAll(d0.w.MockData.tick(new Date()));
      W.demoAfter = rowsDump(d0);

      /* (d) 不新起定时器 + 窗口内重复 ensure() 节流去重 */
      const t0 = a.intervals.filter(x => !x.cancelled).length;
      let fetchCalls = 0;
      const origFetch = a.w.__fetch;
      a.w.__fetch = (...args) => { fetchCalls++; return origFetch(...args); };
      a.w.SelfCheckProbe.reset();                                  // 清在途/节流，让"第一次 ensure"能发起
      const f1 = a.w.SelfCheckProbe.ensure(stA, new Date());
      const f2 = a.w.SelfCheckProbe.ensure(stA, new Date());       // 窗口内第二次
      const f3 = a.w.SelfCheckProbe.ensure(stA, new Date());       // 第三次
      await new Promise(r => setTimeout(r, 30));
      const t1 = a.intervals.filter(x => !x.cancelled).length;
      W.timers = { before: t0, after: t1, f1, f2, f3, callsAfterFirst: fetchCalls };

    } catch (e) { W.err = e.message; }

    /* (e) W7-B'：**真集成路径** —— 装载清单逐字取自 `index.html`（见 `W7B_COMPONENTS` 的派生）。
       这里刻意先渲染一次**空自检**（＝服务端模式下 `stateAdapter.clearUnservedModules()` 的实况：
       `state.selfCheck = []`），看它会不会停在「正在探测…」占位 —— 那正是"忘了注册"时真页面的样子。
       为什么放在**外层 try 之外**并自带 try/catch：它是"忘了注册"这一缺口的**直证**，
       而缺口本身会让 (c-1) 的 `SelfCheckProbe.reset()` 先抛错 —— 若共用同一个 try，
       本项就永远拿不到观察值（实测：只报"（无观察值）"）。故它必须**独立于前面的成败**照旧产出实测。 */
    W.integration = { err: null };
    try {
      const ie = loadFrameFixture(W7B_COMPONENTS, '?source=server');
      ie.w.BoardConfig.dataSource = 'server';
      const stI = ie.w.MockData.state;
      stI.serverMode = true;
      stI.selfCheck = [];
      ie.w.Pages.Dashboard.renderAll(stI);
      const intBefore = String(ie.node('setSelfCheckList').innerHTML || '');
      const probeType = typeof ie.w.SelfCheckProbe;
      /* `SelfCheckProbe` 是 IIFE 返回的**对象**（不是函数）⇒ 判据必须落在"`probe()` 可调用"上，
         否则断言会写错（第一版就把它写成 `typeof === 'function'`，于是探测根本没跑、观察值失真）。 */
      const probeCallable = !!(ie.w.SelfCheckProbe && typeof ie.w.SelfCheckProbe.probe === 'function');
      let intAfter = intBefore;
      if (probeCallable) {
        stubFetch(ie, HEALTHY_STUBS, { baseUrl: 'http://127.0.0.1:8787' });
        stI.selfCheck = await ie.w.SelfCheckProbe.probe(new Date());
        ie.w.Pages.Dashboard.renderAll(stI);
        intAfter = String(ie.node('setSelfCheckList').innerHTML || '');
      }
      W.integration = {
        err: null,
        listSource: 'index.html',
        loadedCount: W7B_COMPONENTS.length,
        probeType,
        probeCallable,
        placeholderBefore: /正在探测/.test(intBefore),
        placeholderAfter: /正在探测/.test(intAfter),
        before: intBefore,
        after: intAfter,
        rowOk: /看板主机网络/.test(intAfter) && /127\.0\.0\.1:8787/.test(intAfter) && !/正在探测/.test(intAfter)
      };
    } catch (e2) {
      W.integration = Object.assign(W.integration, { err: (e2 && e2.message) || String(e2) });
    }

    check(
      'W7-B-a（D12）服务端模式 + 指名真值（`/health` 200 / `/ifd/status` 离线 / `/upload/status` 未配地址）⇒ ' +
      '自检七行**逐项与桩响应对账**（行名不变、结论含真实值/原因、三态分布正确）',
      W.err === null && W.server !== null &&
      W.server.rows.every(r => r.lv && r.lv !== 'MISSING') &&
      W.server.rows[0].lv === 'warn' && /127\.0\.0\.1:8787/.test(W.server.rows[0].state) && /01:01:01/.test(W.server.rows[0].state) &&
      W.server.rows[1].lv === 'err' && /离线断连/.test(W.server.rows[1].state) && /6 s/.test(W.server.rows[1].state) && /5000 ms/.test(W.server.rows[1].state) &&
      W.server.rows[2].lv === 'warn' && /未配置地址/.test(W.server.rows[2].state) && /Q-23/.test(W.server.rows[2].state) &&
      W.server.rows[3].lv === 'warn' && /待补传 3 条/.test(W.server.rows[3].state) && /5000/.test(W.server.rows[3].state) &&
      W.server.rows[4].lv === 'ok' && /board\.db/.test(W.server.rows[4].state) &&
      W.server.rows[5].lv === 'warn' && /尚未接入服务端/.test(W.server.rows[5].state) &&
      /* 「磁盘空间」/「NTP」两行是**尽力的真探测**（服务端 /health 无这两个字段），必须在**可读文本**里
         写明口径来源，免得现场把"浏览器配额"读成"磁盘剩余空间"、把"响应头 Date 偏差"读成"服务端上报的偏差"。 */
      /口径来源：浏览器配额口径，非磁盘剩余空间/.test(W.server.rows[5].state) &&
      W.server.rows[6].lv === 'ok' && /时钟同步/.test(W.server.rows[6].state) &&
      /口径来源：响应头 Date 与本地钟偏差/.test(W.server.rows[6].state) &&
      W.server.errors.length === 0,
      W.err ? `夹具执行异常：${W.err}` : W.server === null ? '（无观察值）' :
        `逐行实测：${W.server.dump.join(' ｜ ')}；console.error=${W.server.errors.length}`
    );
    check(
      'W7-B-b（D12，成对）坏证据各归各行（`/upload/status` **503** ⇒ MES 两行 err；`/health` 200 但 **dbWritable:false** ⇒ 只有`本地数据库` err；' +
      '`/ifd/status` link 离线 ⇒ `PC 上位机连接` err），**在线的行不受影响**（`看板主机网络`/`NTP 时间同步` 仍 ok）；整屏**零 console.error**',
      W.err === null && W.fail !== null &&
      W.fail.rows[0].lv === 'ok' &&
      W.fail.rows[1].lv === 'err' && /离线断连/.test(W.fail.rows[1].state) &&
      W.fail.rows[2].lv === 'err' && /探测失败/.test(W.fail.rows[2].state) && /503/.test(W.fail.rows[2].state) &&
      W.fail.rows[3].lv === 'err' && /探测失败/.test(W.fail.rows[3].state) && /503/.test(W.fail.rows[3].state) &&
      W.fail.rows[4].lv === 'err' && /dbWritable/.test(W.fail.rows[4].state) &&
      W.fail.rows[6].lv === 'ok' && /时钟同步/.test(W.fail.rows[6].state) &&
      /口径来源：响应头 Date 与本地钟偏差/.test(W.fail.rows[6].state) &&
      W.fail.errorCount === 0,
      W.err ? `夹具执行异常：${W.err}` : W.fail === null ? '（无观察值）' :
        `逐行实测：${W.fail.dump.join(' ｜ ')}；console.error=${W.fail.errorCount}`
    );
    check(
      'W7-B-c（D12，成对）**演示模式**：`ensure()` 返回 `false`（**不发起探测**），且显式 `probe()` 只返回**探测行**（夹具 fetch 必失败 ⇒ 七行全 `err`，与演示的"七行全 ok"指纹不同），' +
      '演示态 `state.selfCheck` 仍是 `mockData.buildSelfCheck()` 那七行（渲染前后逐字相同 ⇒ 演示真源没被顶替）',
      W.err === null && W.demoBefore !== null && W.demoAfter !== null && W.demoGuard !== null &&
      W.demoBefore.length === 7 && W.demoBefore.every(x => !/MISSING/.test(x)) &&
      W.demoGuard.ensureReturned === false && W.demoGuard.demoAllOk === true &&
      W.demoGuard.probeRowsAreReal === true && W.demoGuard.rowsEqual === true &&
      JSON.stringify(W.demoBefore) === JSON.stringify(W.demoAfter),
      W.err ? `夹具执行异常：${W.err}` :
        `ensure() 返回=${JSON.stringify(W.demoGuard && W.demoGuard.ensureReturned)}（应 false）；` +
        `演示态七行全 ok=${JSON.stringify(W.demoGuard && W.demoGuard.demoAllOk)}（应 true）；` +
        `探测行确为"非演示"（全 err）=${JSON.stringify(W.demoGuard && W.demoGuard.probeRowsAreReal)}（应 true）；` +
        `探测后演示态未被顶替=${JSON.stringify(W.demoGuard && W.demoGuard.rowsEqual)}（应 true）；` +
        `渲染前=${JSON.stringify(W.demoBefore)}；渲染后=${JSON.stringify(W.demoAfter)}`
    );
    check(
      'W7-B-d（D12）探测**不新起定时器**、且窗口内重复 `ensure()` 被节流去重（存活 interval 数不变、第二/第三次不再发起）',
      W.err === null && W.timers !== null &&
      W.timers.before === W.timers.after &&
      W.timers.f1 === true && W.timers.f2 === false && W.timers.f3 === false,
      W.err ? `夹具执行异常：${W.err}` :
        `存活 interval：探测前 ${W.timers.before} → 探测后 ${W.timers.after}；` +
        `ensure() 三次返回=${JSON.stringify([W.timers.f1, W.timers.f2, W.timers.f3])}（应 [true,false,false]）`
    );
    check(
      'W7-B\'-b（D12）**真集成路径**：装载清单逐字取自 `index.html` ⇒ 服务端模式下七行自检是**真探测结果**，' +
      '不再停留「尚未接入服务端自检结果：正在探测…」占位（`window.SelfCheckProbe` 必须真的被页面加载）',
      W.integration != null && W.integration.err === null &&
      W.integration.probeCallable === true && W.integration.rowOk === true,
      W.integration == null ? '（无观察值）' :
        (W.integration.err ? `真集成路径探测抛出：${W.integration.err}；` : '') +
        `装载清单取自=index.html（${W.integration.loadedCount} 个）；` +
        `typeof window.SelfCheckProbe=${W.integration.probeType}；` +
        `probe() 可调用=${JSON.stringify(W.integration.probeCallable)}（应 true）；` +
        `空自检首帧是否停留占位=${JSON.stringify(W.integration.placeholderBefore)}；` +
        `探测渲染后是否仍停留占位=${JSON.stringify(W.integration.placeholderAfter)}（应 false）；` +
        `#setSelfCheckList 实测 HTML=${JSON.stringify(String(W.integration.after).slice(0, 320))}`
    );
  }

  /* ===== U8 FR-7.12 公告「编辑 / 删除」入口与设置页写入链（`T-20261002-08` 交付） =====
     判据分四组（一律**行为**判据，遵 ADR-0004 D23：跑真组件、读真节点，不做源码字符串匹配）：
       ① **演示模式的行逐字节不变** —— 编辑/删除入口只在服务端模式渲染，演示模式走原来那条拼装分支
          （10 张截图基准 `tests/screenshots-baseline/` 不受影响）；
       ② **入口仅解锁态** —— 服务端模式 ＋ 解锁 ⇒ 两个按钮可点；锁定 ⇒ 渲染但 `disabled`；
       ③ **服务端写入链** —— 解锁 ⇒ 真走 `POST /notice`（`Api.httpJson` 唯一出口、带会话令牌头），成功用响应里
          **同一份投影**就地刷新；失败（含 401）**写进 `#entryMsg`**、**绝不静默**；
          ⚠ `E86①` **已知集成缺口**：前端"解锁 ⇒ 会话令牌"未接线（属 `FR-8.4`／`ADR-0007` 的包）⇒
          服务端模式下写入会拿 401 并**被显示**。本节的判据就是"**失败可见**"，**不要求**本包实现登录接线。
       ④ **`stateAdapter` 的公告段** —— 服务端给了就**映射**（不再清空）；缺段/空段 ⇒ 既有空态（UI-11）。
     为什么要自建夹具而不是复用既有两个：`loadAutoLockFixture` 的 `Dom.setHTML` 是空实现（读不到渲染出的
     HTML）；`loadFrameFixture` 的节点没有 `getAttribute`（`SettingPanel.actionButtonOf()` 靠它向上找
     `data-notice-act`，缺了则编辑/删除入口永远点不动 —— 断言会退化成恒真）。故这里自建一个**最小但齐全**的桩。 ---- */
  section('U8 FR-7.12 公告编辑/删除入口与服务端写入链（演示模式零变化 / 仅解锁态 / 失败可见 / 适配层映射）');
  {
    const NODES = new Map();
    const nNode = id => {
      if (NODES.has(id)) return NODES.get(id);
      const attrs = {};
      const handlers = {};
      const classes = new Set();
      const o = {
        __id: id, hidden: false, disabled: false, value: '', className: '', style: {}, dataset: {}, __parent: null,
        classList: {
          add: c => classes.add(c), remove: c => classes.delete(c),
          contains: c => classes.has(c), toggle: () => {}
        },
        addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
        __fire: (type, ev) => (handlers[type] || []).forEach(fn => fn(ev || { key: 'Enter' })),
        setAttribute: (k, v) => { attrs[k] = String(v); },
        getAttribute: k => (attrs[k] === undefined ? null : attrs[k]),
        appendChild(child) { if (child && typeof child === 'object') child.__parent = o; return child; },
        remove() {}, closest: () => null, querySelector: () => null
      };
      Object.defineProperty(o, 'parentNode', { get: () => o.__parent, configurable: true });
      Object.defineProperty(o, 'textContent', {
        get: () => o.__text || '', set: v => { o.__text = String(v); }, configurable: true
      });
      Object.defineProperty(o, 'innerHTML', {
        get: () => o.__html || '', set: v => { o.__html = String(v); }, configurable: true
      });
      NODES.set(id, o);
      return o;
    };

    const htmlOut = new Map();
    const warnings = [];
    const fetchCalls = [];
    let nextFetch = null;              /* (url, init) => Promise —— 用例按场景替换 */
    const sandbox = {
      console: {
        log() {},
        warn: (...a) => warnings.push(a.map(x => (x && x.message) ? x.message : String(x)).join(' ')),
        error: (...a) => warnings.push(a.map(x => (x && x.message) ? x.message : String(x)).join(' '))
      }
    };
    sandbox.window = sandbox;
    /* 定时器桩件：`flashEntry` 的 4 s 复位与自动锁定计时都不真跑（只登记），否则 Node 进程被钉住 */
    sandbox.setTimeout = () => 1;
    sandbox.clearTimeout = () => {};
    sandbox.fetch = (url, init) => {
      fetchCalls.push({ url, init });
      return nextFetch ? nextFetch(url, init) : Promise.reject(new Error('U8 桩 fetch：未接网络'));
    };
    sandbox.AbortSignal = { timeout: () => ({}) };
    sandbox.document = { getElementById: nNode, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
    vm.createContext(sandbox);
    const nRun = rel => vm.runInContext(readText(rel), sandbox, { filename: path.join(ROOT, rel) });
    const U8_COMPONENTS = ['src/components/NoticePanel.js', 'src/components/SettingPanel.js', 'src/services/stateAdapter.js'];
    guardRegistered(U8_COMPONENTS, 'loadNoticeFixture');
    nRun('src/config/board.config.js');
    nRun('src/config/fieldMap.js');
    nRun('src/utils/format.js');
    sandbox.window.Dom = {
      $: nNode,
      setText: (id, v) => { nNode(id).__text = String(v); },
      setHTML: (id, v) => { nNode(id).__html = String(v); htmlOut.set(id, String(v)); },
      setClass: (id, v) => { nNode(id).className = String(v); },
      setStyle: () => {}, toggleClass: () => {}
    };
    nRun('src/services/mockData.js');
    nRun('src/services/api.js');
    U8_COMPONENTS.forEach(nRun);

    const U8 = { err: null };
    try {
      /* ---------------- ① 演示模式：公告行**逐字节**等于改动前 ---------------- */
      const DEMO_ROW = { tag: '生产调整', text: '正文 <b>x</b>', lv: 'info', time: '09:30' };
      /* 改动前的公告行拼装 —— **逐字**写成本用例的字面量（来源：`T-20261002-08` 之前 `rowPlain()` 的形态，
         也正是 10 张截图基准所冻结的版面）。`esc()` 只做 `& < > "` 四个替换 ⇒ 期望值**手工展开**为字面量，
         与被测实现不共用任何表达式（不拿"自己的输出"证明"自己没变"）。 */
      const LEGACY_ROW = '<div class="list-item lv-info"><span class="tag">生产调整</span>' +
        '<span class="body">正文 &lt;b&gt;x&lt;/b&gt;</span><span class="meta mono">09:30</span></div>';
      const esc = sandbox.window.Format.esc;
      sandbox.window.Components.NoticePanel.render({ notices: { notices: [DEMO_ROW], tips: [], todo: [] } });
      const demoHtml = String(htmlOut.get('ntNoticeList') || '');
      /* ⚠ **必须用"带 `id` 的演示行"再断一次**（本轮 D22 首跑实测出来的补钉）：只断言"无 id 的演示行"
         时，"把 `rowOf` 改成**无条件**走带动作分支"那种变异**测不出来** —— 因为 `actionsOf()` 对
         `id` 缺失的行本来就返回空串（实测：该变异体下 163/0 全绿）。两种输入都断，这条才真正锁住
         "入口**只在服务端模式**渲染"这个判据本身，而不是靠"演示数据恰巧没有 id"兜住。 */
      sandbox.window.Components.NoticePanel.render({
        notices: { notices: [Object.assign({}, DEMO_ROW, { id: 7 })], tips: [], todo: [] }
      });
      const demoWithIdHtml = String(htmlOut.get('ntNoticeList') || '');
      U8.demo = {
        html: demoHtml,
        withId: demoWithIdHtml,
        legacy: LEGACY_ROW,
        escMatches: esc(DEMO_ROW.text) === '正文 &lt;b&gt;x&lt;/b&gt;',
        hasButton: demoHtml.indexOf('<button') >= 0,
        hasData: demoHtml.indexOf('data-notice') >= 0
      };
      check('U8/FR-7.12-a 演示模式（`dataSource` 非服务端、`state.serverMode` 非真）：公告行 HTML 与改动前**逐字节相同**、' +
        '**不带**任何 `<button>` 与 `data-notice-*`（**带 `id` 的行同样如此** —— "入口只在服务端模式渲染"不能靠"演示数据恰巧无 id"兜住）' +
        '—— 编辑/删除入口只在服务端模式渲染，10 张截图基准版面零变化',
        U8.demo.escMatches && demoHtml === LEGACY_ROW && demoWithIdHtml === LEGACY_ROW &&
        !U8.demo.hasButton && !U8.demo.hasData,
        `esc 口径一致=${U8.demo.escMatches}；无 id 行=${JSON.stringify(demoHtml)}；带 id 行=` +
        `${JSON.stringify(demoWithIdHtml)}；期望行=${JSON.stringify(LEGACY_ROW)}；` +
        `含 button=${U8.demo.hasButton}；含 data-notice=${U8.demo.hasData}`);

      /* ---------------- ② 服务端模式 ＋ 解锁 ⇒ 两个入口可点；锁定 ⇒ `disabled` ---------------- */
      const ACTS = id => '<span class="notice-acts">' +
        `<button type="button" class="btn tiny" data-notice-act="edit" data-notice-id="${id}">编辑</button>` +
        `<button type="button" class="btn tiny danger" data-notice-act="delete" data-notice-id="${id}">删除</button></span>`;
      const srvRow = Object.assign({}, DEMO_ROW, { id: 7 });
      sandbox.window.Components.NoticePanel.render({
        notices: { notices: [srvRow], tips: [], todo: [] }, serverMode: true, unlocked: true
      });
      const unlockedHtml = String(htmlOut.get('ntNoticeList') || '');
      sandbox.window.Components.NoticePanel.render({
        notices: { notices: [srvRow], tips: [], todo: [] }, serverMode: true, unlocked: false
      });
      const lockedHtml = String(htmlOut.get('ntNoticeList') || '');
      const lockedDisabled = (lockedHtml.match(/ disabled>/g) || []).length;
      U8.unlocked = unlockedHtml;
      U8.locked = lockedHtml;
      check('U8/FR-7.12-b 服务端模式 ＋ **解锁**：每条公告带「编辑 / 删除」入口（`data-notice-act` ＋ `data-notice-id`），' +
        '两个按钮**都不可 disabled**，且整行＝演示行**原样**＋动作入口（改动是纯追加、正文仍转义）',
        unlockedHtml === LEGACY_ROW.replace('</div>', ACTS(7) + '</div>') &&
        unlockedHtml.indexOf(' disabled') < 0 &&
        unlockedHtml.indexOf('正文 &lt;b&gt;x&lt;/b&gt;') > 0,
        `实测行=${JSON.stringify(unlockedHtml)}`);
      check('U8/FR-7.12-c 服务端模式 ＋ **锁定**：入口**仍在**（不凭空消失）但两个按钮**都 `disabled`** —— ' +
        'FR-7.12「仅**解锁**后可新增/编辑/删除公告」在这两个入口上的落点（实际点击还会走 `denyLocked` 的可见反馈）',
        lockedDisabled === 2 && lockedHtml.indexOf('data-notice-act="edit"') > 0 &&
        lockedHtml.indexOf('data-notice-act="delete"') > 0 &&
        lockedHtml.replace(/ disabled/g, '') === unlockedHtml,
        `disabled 计数=${lockedDisabled}（应 2）；锁定行去 disabled 后与解锁行逐字相等=` +
        `${lockedHtml.replace(/ disabled/g, '') === unlockedHtml}`);

      /* ---------------- ③ 服务端写入链（发布 / 401 可见 / 锁定态零请求） ---------------- */
      const ST = sandbox.window.MockData.state;
      sandbox.window.Components.SettingPanel.bind(ST, () => {});
      const flush = () => new Promise(r => setTimeout(r, 30));
      const okBody = notices => ({ ok: true, status: 200, body: { ok: true, notices } });
      const jsonRes = (status, obj) => ({
        ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(obj))
      });

      ST.serverMode = true;
      ST.unlocked = true;
      ST.sessionToken = 'U8-TOKEN';
      ST.notices = { notices: [{ id: 5, tag: '生产调整', text: '服务端已有公告', lv: 'info', time: '09:00' }], tips: [], todo: [] };
      nNode('noticeType').value = '工艺变更';
      nNode('noticeText').value = 'U8 服务端模式新公告';
      fetchCalls.length = 0;
      nextFetch = () => Promise.resolve(jsonRes(200, {
        ok: true,
        notices: { notices: [{ id: 6, tag: '工艺变更', text: 'U8 服务端模式新公告', lv: 'info', time: '09:30' }], tips: [], todo: [] }
      }));
      nNode('noticeSave').__fire('click');
      await flush();
      const pubCall = fetchCalls[fetchCalls.length - 1] || {};
      const pubInit = pubCall.init || {};
      let pubBody = null;
      try { pubBody = JSON.parse(String(pubInit.body)); } catch { pubBody = null; }
      U8.publish = {
        calls: fetchCalls.length, url: String(pubCall.url || ''), method: pubInit.method,
        body: pubBody, headers: pubInit.headers || {},
        notices: ST.notices, msg: String(nNode('entryMsg').textContent || '')
      };
      check('U8/FR-7.12-d 服务端模式 ＋ 解锁点「发布」⇒ **恰 1 次** `POST /notice`（`action=publish`、`content`/`subType` 取自输入框、' +
        '带 `Authorization: Bearer <会话令牌>`）；成功后用**响应里同一份投影**就地刷新 `state.notices`（不重拉快照），反馈写在 `#entryMsg`',
        fetchCalls.length === 1 && /\/notice$/.test(U8.publish.url) && pubInit.method === 'POST' &&
        pubBody && pubBody.action === 'publish' && pubBody.content === 'U8 服务端模式新公告' &&
        pubBody.subType === '工艺变更' &&
        U8.publish.headers.Authorization === 'Bearer U8-TOKEN' &&
        ST.notices.notices.length === 1 && ST.notices.notices[0].id === 6 &&
        ST.notices.notices[0].text === 'U8 服务端模式新公告' && ST.notices.todo.length === 0 &&
        /已发布/.test(U8.publish.msg),
        `http 调用=${fetchCalls.length} 次；url=${JSON.stringify(U8.publish.url)}；method=${U8.publish.method}；` +
        `body=${JSON.stringify(pubBody)}；headers=${JSON.stringify(U8.publish.headers)}；` +
        `state.notices=${JSON.stringify(ST.notices)}；#entryMsg=${JSON.stringify(U8.publish.msg)}`);

      /* 401（`E86①` 的现场形态：服务端模式但令牌无效/缺失）⇒ **失败可见** */
      const before401 = JSON.stringify(ST.notices);
      fetchCalls.length = 0;
      nextFetch = () => Promise.resolve(jsonRes(401, {
        ok: false, error: 'unauthorized',
        err: { code: 'unauthorized', httpStatus: 401, message: '会话令牌缺失/伪造/过期/已登出 —— 请先经 POST /auth/login 解锁' }
      }));
      nNode('noticeText').value = '会被服务端拒绝的公告';
      nNode('noticeSave').__fire('click');
      await flush();
      const msg401 = String(nNode('entryMsg').textContent || '');
      U8.reject = { calls: fetchCalls.length, msg: msg401, notices: ST.notices };
      check('U8/FR-7.12-e **服务端拒绝可见**（`E86①` 的行为侧）：401 ⇒ `#entryMsg` 里写明「公告未保存」＋ HTTP 码 ＋ ' +
        '机器可读码 ＋ 原因，`state.notices` **逐字不变**（失败**绝不静默**；本包**不**实现登录接线，缺口如实暴露给操作人）',
        fetchCalls.length === 1 && /公告未保存/.test(msg401) && /401/.test(msg401) &&
        /unauthorized/.test(msg401) && JSON.stringify(ST.notices) === before401,
        `http 调用=${U8.reject.calls} 次；#entryMsg=${JSON.stringify(msg401)}；` +
        `notices 未变=${JSON.stringify(ST.notices) === before401}`);

      /* 锁定态点「发布」⇒ 0 次请求 ＋ 可见反馈（不静默失效） */
      ST.unlocked = false;
      fetchCalls.length = 0;
      nNode('noticeText').value = '锁定态不该发出去';
      nNode('noticeSave').__fire('click');
      await flush();
      const msgLocked = String(nNode('entryMsg').textContent || '');
      U8.lockedClick = { calls: fetchCalls.length, msg: msgLocked };
      check('U8/FR-7.12-f 服务端模式 ＋ **锁定**点「发布」⇒ **0 次请求**（不把锁定态写入发出去）且 `#entryMsg` 明示' +
        '「锁定 / 未保存」（FR-8.2 的"锁定后不得静默失效"在公告这一支同样成立）',
        fetchCalls.length === 0 && /锁定/.test(msgLocked) && /未保存/.test(msgLocked),
        `http 调用=${U8.lockedClick.calls} 次（应 0）；#entryMsg=${JSON.stringify(msgLocked)}`);

      /* ---------------- ④ `stateAdapter` 的公告段：有段映射 / 缺段与空段空态 ---------------- */
      const mkState = () => ({
        notices: { notices: [{ tag: '演示值', text: '演示公告', lv: 'info', time: '08:00' }], tips: [], todo: [] },
        warnings: [], selfCheck: [], opLog: [], alarm: { active: null, queue: [], ledger: [] },
        maint: {}, task: {}, stats: {}, device: {}, shift: { list: [] }, upload: null, clock: { time: '09:30:00' }
      });
      const NUL = { link: null, task: null, device: null, frame: null, stats: null, standard: null, upload: null };
      const stMap = mkState();
      sandbox.window.StateAdapter.snapshotToState(stMap, Object.assign({}, NUL, {
        notices: {
          notices: [{ id: 7, tag: '生产调整', text: '服务端公告正文', lv: 'info', time: '09:30' }],
          tips: [{ id: 9, tag: '测试要求', text: '服务端工艺提示', lv: 'info', time: '08:00' }],
          todo: []
        }
      }), new Date('2026-10-02T09:30:00'));
      const stEmpty = mkState();      /* 服务端给了"空段" */
      sandbox.window.StateAdapter.snapshotToState(stEmpty, Object.assign({}, NUL, {
        notices: { notices: [], tips: [], todo: [] }
      }), new Date('2026-10-02T09:30:00'));
      const stMissing = mkState();    /* 旧服务端/裁剪快照：**连 notices 段都没有** */
      sandbox.window.StateAdapter.snapshotToState(stMissing, Object.assign({}, NUL), new Date('2026-10-02T09:30:00'));
      U8.adapter = { map: stMap.notices, empty: stEmpty.notices, missing: stMissing.notices, serverMode: stMap.serverMode };
      check('U8/FR-7.12-g `stateAdapter`：服务端给了公告段 ⇒ **映射**（不再清空）—— `notices`/`tips` 逐键搬进 `state.notices`' +
        '（含 `id`，供编辑/删除定位）、`todo` 恒 `[]`、`serverMode` 置真；演示值被替换（ADR-0008 D3：不得用演示值顶替）',
        stMap.notices.notices.length === 1 && stMap.notices.tips.length === 1 &&
        stMap.notices.notices[0].id === 7 && stMap.notices.notices[0].tag === '生产调整' &&
        stMap.notices.notices[0].text === '服务端公告正文' && stMap.notices.notices[0].lv === 'info' &&
        stMap.notices.notices[0].time === '09:30' && stMap.notices.tips[0].id === 9 &&
        stMap.notices.todo.length === 0 && stMap.serverMode === true,
        `映射后 state.notices=${JSON.stringify(stMap.notices)}；serverMode=${stMap.serverMode}`);
      check('U8/FR-7.12-h `stateAdapter`：服务端**确实没有数据**（空段／缺段）⇒ 一律落**既有空态** ' +
        '`{notices:[],tips:[],todo:[]}`（不留 `mockData.js` 的演示公告残留；UI-11 的空态文案由 NoticePanel 承担）',
        [stEmpty, stMissing].every(s => s.notices.notices.length === 0 && s.notices.tips.length === 0 &&
          s.notices.todo.length === 0 && Array.isArray(s.notices.todo)),
        `空段后=${JSON.stringify(stEmpty.notices)}；缺段后=${JSON.stringify(stMissing.notices)}`);

      /* 零 console.warn/error（夹具自身不许制造噪音：U8 只做"失败可见"，不往控制台灌） */
      check('U8/FR-7.12-i 本节全程**零 `console.warn`/`console.error`**（"失败可见"落在 `#entryMsg`，不靠刷控制台）',
        warnings.length === 0, warnings.join(' | ').slice(0, 240));
    } catch (e) {
      U8.err = (e && e.stack) || String(e);
      check('U8/FR-7.12 夹具执行完毕（未抛异常）', false, String(U8.err).slice(0, 400));
    }
  }

  /* ---------------- U9：设置页登录接线（`T-20261002-15` / 技术债 `E86①`；口径＝ADR-0007 D1–D9） ----------------
     本节管**前端那一侧的行为**（服务端那一侧的真进程/真 HTTP 判据在 `harness-check` 第十九节）：
       · 服务端模式下"解锁"＝真 `POST /auth/login`（**不存在**明文比对路径）—— 用**演示口令 8888** 都解不开，
         这是"前端不比对"的行为级证据（静态读数只是旁证，见 U9-a2）；
       · 401 ⇒ **可见降级**（`未登录或登录已过期`；不黑屏、不抛未捕获异常）；
       · 423 ⇒ 显示服务端给的**剩余秒数**；409 ⇒ 提示走**本机**一次性初始化；
       · 改密（FR-8.4）成功后**强制清会话并要求重新登录**；
       · 自动锁定到点（FR-8.2）**确实调用 `logout`**（前端计时器与服务端令牌不各管一套，D5）；
       · **演示模式**：显式提示 + 其余行为**逐字不变**（沿用 U8 的字节级口径：期望串是**手写字面量**，
         不与实现共用任何表达式）；
       · **静态不变量**：前端源码零 `localStorage`、零哈希/明文比对/失败计数/锁定判定。
     夹具：真 `services/api.js` + 真 `services/auth.js` + 真 `SettingPanel.js` 在 vm 里跑，
           `fetch` 是**可编排的桩件**（本节的每条失败路径都要能被精确制造出来），定时器只登记不真跑。
     ⚠ 为什么"服务端 401 可见降级"要在**真 `Api.httpJson()` 路径**上制造：统一 401 处理挂在
        `httpJson()` 的 `!res.ok` 分支上（全仓唯一 HTTP 出口）—— 直接调 `BoardSession.noteUnauthorized()`
        只能证明"记账函数可用"，证明不了"出口真的接了它"（D23 的防空洞）。 */
  section('U9 FR-8.1/FR-8.2/FR-8.4 设置页登录接线（服务端模式＝POST /auth/login / 401 可见降级 / 423 剩余秒数 / 409 本机初始化 / 改密清会话 / 自动锁定登出 / 演示模式逐字不变 / 静态不变量）');
  {
    /** 静态不变量用：剥掉**注释与字符串字面量**（只留可执行代码）。
     *  为什么必须剥：`src/services/auth.js` 的**注释**里就写着"明令禁止 `localStorage`"与
     *  "`server/services/auth.js`：scrypt + 独立盐…" —— 对原文直接 grep 会把**禁令声明**判成违规
     *  （现场实测：原文 localStorage 2 处、scrypt 1 处，全在注释里）。 */
    function codeOnly(src) {
      let out = '';
      for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
        if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; out += ' '; continue; }
        if (c === "'" || c === '"' || c === '`') {
          const q = c; i++;
          while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
          out += ' '; continue;                                  // 字符串整体替换为空格（不改变行结构）
        }
        out += c;
      }
      return out;
    }

    const U9_NODES = new Map();
    const U9_TIMERS = [];
    const U9_WARN = [];
    const U9_STORE = new Map();
    const U9_CALLS = [];
    let u9TimerSeq = 0;
    let u9NextFetch = null;
    const u9Node = id => {
      if (U9_NODES.has(id)) return U9_NODES.get(id);
      const classes = new Set();
      const handlers = {};
      const o = {
        __id: id, hidden: false, disabled: false, value: '', className: '', style: {}, dataset: {}, __parent: null,
        classList: {
          add: c => classes.add(c), remove: c => classes.delete(c),
          contains: c => classes.has(c), toggle: () => {}
        },
        addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
        __fire: (type, ev) => (handlers[type] || []).forEach(fn => fn(ev || { key: 'Enter' })),
        setAttribute: (k, v) => { o[k] = String(v); },
        getAttribute: k => (o[k] === undefined ? null : o[k]),
        appendChild(child) { if (child && typeof child === 'object') child.__parent = o; return child; },
        remove() {}, closest: () => null, querySelector: () => null
      };
      Object.defineProperty(o, 'parentNode', { get: () => o.__parent, configurable: true });
      Object.defineProperty(o, 'textContent', {
        get: () => o.__text || '', set: v => { o.__text = String(v); }, configurable: true
      });
      Object.defineProperty(o, 'innerHTML', {
        get: () => o.__html || '', set: v => { o.__html = String(v); }, configurable: true
      });
      U9_NODES.set(id, o);
      return o;
    };

    const u9Sandbox = {
      console: {
        log() {},
        warn: (...a) => U9_WARN.push(a.map(x => (x && x.message) ? x.message : String(x)).join(' ')),
        error: (...a) => U9_WARN.push(a.map(x => (x && x.message) ? x.message : String(x)).join(' '))
      },
      /* 定时器只登记（与 `loadAutoLockFixture` 同口径）：自动锁定/2 s 弹窗/4 s 复位都由用例手工触发 */
      setTimeout: (fn, delay) => { const id = ++u9TimerSeq; U9_TIMERS.push({ id, delay, fn, fired: false, cancelled: false }); return id; },
      clearTimeout: id => { const t = U9_TIMERS.find(x => x.id === id); if (t) t.cancelled = true; },
      setInterval: () => 0, clearInterval: () => {},
      AbortSignal: { timeout: () => ({}) },
      fetch: (url, init) => {
        U9_CALLS.push({ url: String(url), init: init || {} });
        return u9NextFetch ? u9NextFetch(String(url), init || {}) : Promise.reject(new Error('U9 桩 fetch：未接网络'));
      },
      sessionStorage: {
        getItem: k => (U9_STORE.has(k) ? U9_STORE.get(k) : null),
        setItem: (k, v) => U9_STORE.set(k, String(v)),
        removeItem: k => U9_STORE.delete(k)
      },
      document: { getElementById: u9Node, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} }
    };
    u9Sandbox.window = u9Sandbox;
    vm.createContext(u9Sandbox);
    const u9Run = rel => vm.runInContext(readText(rel), u9Sandbox, { filename: path.join(ROOT, rel) });
    const U9_RELS = ['src/components/NoticePanel.js', 'src/components/SettingPanel.js'];
    guardRegistered(U9_RELS.concat(['src/services/auth.js']), 'loadAuthFixture');
    u9Run('src/config/board.config.js');
    u9Run('src/config/fieldMap.js');
    u9Run('src/utils/format.js');
    u9Sandbox.window.Dom = {
      $: u9Node,
      setText: (id, v) => { u9Node(id).__text = String(v); },
      setHTML: (id, v) => { u9Node(id).__html = String(v); },
      setClass: (id, v) => { u9Node(id).className = String(v); },
      setStyle: () => {}, toggleClass: () => {}
    };
    u9Run('src/services/mockData.js');
    u9Run('src/services/api.js');
    u9Run('src/services/auth.js');
    U9_RELS.forEach(u9Run);

    const U9 = { w: u9Sandbox.window, err: null };
    try {
      const W = u9Sandbox.window;
      const ST = W.MockData.state;
      const BS = W.BoardSession;
      const flush = () => new Promise(r => setTimeout(r, 20));
      const jsonRes = (status, obj) => ({
        ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(obj))
      });
      const txt = id => String(u9Node(id).textContent || '');
      /** 触发尚未触发/未取消的、delay 匹配的**最后一个**定时器回调（同 `loadAutoLockFixture.fire`） */
      const fire = delay => {
        const t = U9_TIMERS.filter(x => x.delay === delay && !x.cancelled && !x.fired).pop();
        if (!t) throw new Error(`没有待触发的 ${delay} ms 定时器（已登记：${U9_TIMERS.map(x => x.delay).join('/') || '无'}）`);
        t.fired = true;
        t.fn();
        return t;
      };
      const callsTo = p => U9_CALLS.filter(c => c.url.indexOf(p) >= 0);
      /** 把界面切到"服务端模式"（判据＝状态位优先、配置兜底，与组件同源） */
      const intoServerMode = () => {
        W.BoardConfig.dataSource = 'server';
        ST.serverMode = true;
        ST.unlocked = false;
        ST.notices = { notices: [], tips: [], todo: [] };
        if (!ST.clock) ST.clock = { date: '2026-10-02', time: '10:00:00' };
      };

      /* ---- U9-a 服务端模式解锁＝真 `POST /auth/login`（**演示口令 8888 也解不开**＝前端不比对的行为证据） ---- */
      intoServerMode();
      W.Components.SettingPanel.bind(ST, () => {});
      U9_CALLS.length = 0;
      u9NextFetch = () => Promise.resolve(jsonRes(401, { ok: false, error: 'bad_credentials', reason: '用户名或口令不正确' }));
      u9Node('setPwd').value = '8888';                      /* ← 演示口令：服务端模式下**必须**被服务端拒 */
      u9Node('setUnlockBtn').__fire('click');
      await flush();
      const aLogin = callsTo('/auth/login');
      const aBody = aLogin.length ? (() => { try { return JSON.parse(String(aLogin[0].init.body)); } catch { return null; } })() : null;
      check('U9-a 服务端模式解锁＝真 POST /auth/login：口令**原样**提交给服务端（本用例提交的正是演示口令 `8888`，' +
        '服务端回 401 `bad_credentials` ⇒ `state.unlocked` 仍为 false、本地无令牌）—— ' +
        '"前端不做比对"由此在**行为**上成立（若还有明文比对路径，8888 会当场解开）',
        aLogin.length === 1 && aLogin[0].init.method === 'POST' &&
        aBody && aBody.password === '8888' && aBody.username === 'admin' &&
        ST.unlocked === false && BS.token() === '' &&
        /密码错误/.test(txt('setMsg')) && /服务端/.test(txt('setMsg')),
        `login 请求=${aLogin.length} 次；body=${JSON.stringify(aBody)}；unlocked=${ST.unlocked}；token='${BS.token()}'；` +
        `#setMsg=${JSON.stringify(txt('setMsg'))}`);

      /* ---- U9-a2（静态旁证）服务端解锁路径里**没有**本地比对/演示口令 ----
         取 `tryUnlockServer` 的**函数体**（剥注释与字符串后）判：既无 `unlockPassword`、也无 `8888`。
         为什么要剥注释/字符串：函数里那句提示文案本身就写着"（口令由服务端校验）"，
         不剥的话任何文案都会被当成"比对路径"（实测踩不到，但口径要写死）。 */
      const setSrcRaw = readText('src/components/SettingPanel.js');
      const setCode = codeOnly(setSrcRaw);
      const serverBody = functionBody(setCode, 'tryUnlockServer');
      const uniq = (s, needle) => s.split(needle).length - 1;
      check('U9-a2（静态读数，**旁证**）`SettingPanel.js` 的服务端解锁路径 `tryUnlockServer()` 体内**不含**' +
        '`unlockPassword`、也不含字面量 `8888`（剥掉注释与字符串后判定）；且全文件里 `unlockPassword` 的**可执行**出现' +
        '**恰 1 处**（＝演示路径那一次，`8888` 只允许存在于演示模式，ADR-0007 D4/D5）',
        Boolean(serverBody) && serverBody.indexOf('unlockPassword') < 0 && serverBody.indexOf('8888') < 0 &&
        uniq(setCode, 'unlockPassword') === 1 && uniq(setCode, 'localStorage') === 0,
        `tryUnlockServer 体长=${serverBody ? serverBody.length : '(取不到)'}；` +
        `体内 unlockPassword=${serverBody ? uniq(serverBody, 'unlockPassword') : 'n/a'}、8888=${serverBody ? uniq(serverBody, '8888') : 'n/a'}；` +
        `全文件可执行 unlockPassword=${uniq(setCode, 'unlockPassword')} 处（注释里的原文出现 ${uniq(setSrcRaw, 'unlockPassword')} 处）`);

      /* ---- U9-b **统一 401 处理**：在真 `Api.httpJson()` 路径上制造 401 ⇒ 可见降级、不黑屏、不抛 ---- */
      intoServerMode();
      U9_WARN.length = 0;
      BS.save({ token: 'a'.repeat(64), username: 'admin', expiresAt: '2026-10-02 22:00:00' });
      ST.unlocked = true;                                   /* 人为制造"界面以为已解锁、服务端说不认"的现场 */
      u9NextFetch = () => Promise.resolve(jsonRes(401, {
        ok: false, error: 'unauthorized',
        err: { code: 'unauthorized', httpStatus: 401, message: '会话令牌缺失/伪造/过期/已登出' }
      }));
      let bThrew = null;
      let bFetch = null;
      try {
        bFetch = await W.Api.fetchSnapshot();               /* 走**唯一 HTTP 出口**（挂 401 钩子的那一条） */
        /* 上一条用例的 `flashEntry` 把 `#entryMsg` 置成了粘滞（桩件下 4 s 复位不会自己发生）
           ⇒ 这里显式清粘滞位，让本帧的 `render()` 真的去写"未登录或登录已过期"（模拟 4 s 后的复位）。 */
        delete u9Node('entryMsg').dataset.sticky;
        W.Components.SettingPanel.render(ST);
      } catch (e) { bThrew = (e && e.message) || String(e); }
      const bLost = String(BS.lostNote() || '');
      const bNote = txt('setAuthNote');
      check('U9-b **统一 401 处理**（真 `Api.httpJson()` 路径）：服务端回 401 `unauthorized` ⇒ 令牌被**清空**、' +
        '`state.unlocked` 回到**锁定态**、`#setAuthNote` 与 `#entryMsg` 都如实写出「未登录或登录已过期」；' +
        '**不黑屏**（面板其余文案照常渲染）、**不抛未捕获异常**（`httpJson` 把失败收敛成 `ok:false`）',
        bThrew === null && bFetch && bFetch.ok === false && String(bFetch.responseCode) === '401' &&
        BS.token() === '' && ST.unlocked === false &&
        /未登录或登录已过期/.test(bLost) && /未登录或登录已过期/.test(bNote) &&
        /未登录或登录已过期/.test(txt('entryMsg')) &&
        txt('setLockText') === '当前已锁定' && txt('setMsg') !== '',
        `fetch.ok=${bFetch && bFetch.ok}／responseCode=${bFetch && bFetch.responseCode}；抛错=${bThrew || '无'}；` +
        `token='${BS.token()}'；unlocked=${ST.unlocked}；` +
        `lostNote=${JSON.stringify(bLost)}；#setAuthNote=${JSON.stringify(bNote)}；#entryMsg=${JSON.stringify(txt('entryMsg'))}；` +
        `#setLockText=${JSON.stringify(txt('setLockText'))}`);

      /* ---- U9-b2 与登录态**无关**的 401 不得误清令牌（按机器可读码区分，D5 的细化） ---- */
      BS.save({ token: 'b'.repeat(64), username: 'admin', expiresAt: '2026-10-02 22:00:00' });
      BS.clearLost();
      u9NextFetch = () => Promise.resolve(jsonRes(401, {
        ok: false, error: 'bad_credentials', err: { code: 'bad_credentials', httpStatus: 401 }
      }));
      await W.Api.authLogin('wrong-password');              /* 口令错也是 401，但它**不是**会话失效 */
      check('U9-b2 401 **按码区分**：`bad_credentials`（口令错/原口令错）这类与会话无关的 401 **不清令牌**、' +
        '不记账（否则改密时原口令敲错一次就把仍然有效的登录态丢掉，操作人被迫重新解锁）',
        BS.token() === 'b'.repeat(64) && BS.lostNote() === '',
        `token 仍在=${BS.token() === 'b'.repeat(64)}；lostNote=${JSON.stringify(String(BS.lostNote() || ''))}`);

      /* ---- U9-c 423 ⇒ **如实显示剩余秒数**（口令正确也拒；剩余秒数由服务端算出） ---- */
      intoServerMode();
      U9_CALLS.length = 0;
      u9NextFetch = () => Promise.resolve(jsonRes(423, {
        ok: false, error: 'locked', retryAfterSec: 187, lockedUntil: '2026-10-02 10:05:00'
      }));
      u9Node('setPwd').value = 'whatever-correct-looking';
      u9Node('setUnlockBtn').__fire('click');
      await flush();
      check('U9-c 423 `locked` ⇒ `#setMsg` 显示**服务端给的剩余秒数**（本用例桩值 187 s）且说明"口令正确也会被拒"；' +
        '`#entryMsg` 同步给出可见失败（**绝不静默**）；`state.unlocked` 仍 false',
        ST.unlocked === false && /187 秒/.test(txt('setMsg')) && /口令正确也会被拒/.test(txt('setMsg')) &&
        /HTTP 423/.test(txt('entryMsg')) && /剩余 187 秒/.test(txt('entryMsg')),
        `#setMsg=${JSON.stringify(txt('setMsg'))}；#entryMsg=${JSON.stringify(txt('entryMsg'))}；unlocked=${ST.unlocked}`);

      /* ---- U9-d 409 `not_initialized` ⇒ 提示走**本机**一次性初始化，并让初始化行可见 ---- */
      intoServerMode();
      u9Node('setInitWrap').hidden = true;                  /* 先复位可视状态，再让 render 决定 */
      u9NextFetch = () => Promise.resolve(jsonRes(409, {
        ok: false, error: 'not_initialized', reason: '尚未初始化：请在本机用一次性初始化码设置口令'
      }));
      u9Node('setPwd').value = 'anything';
      u9Node('setUnlockBtn').__fire('click');
      await flush();
      fire(4000);                                           /* flashEntry 的 4 s 复位（定时器是桩件，手工触发） */
      check('U9-d 409 `not_initialized` ⇒ `#setMsg` 提示用**本机**一次性初始化码设置口令（D4：不设默认口令、不许远程初始化）；' +
        '`render()` 后 `#setInitWrap` **不再 hidden**（初始化入口可见）；`#setAuthNote` 明写"服务端尚未初始化"',
        /409 not_initialized/.test(txt('setMsg')) && /一次性初始化码/.test(txt('setMsg')) &&
        u9Node('setInitWrap').hidden === false &&
        /服务端尚未初始化/.test(txt('setAuthNote')),
        `#setMsg=${JSON.stringify(txt('setMsg'))}；#setInitWrap.hidden=${u9Node('setInitWrap').hidden}；` +
        `#setAuthNote=${JSON.stringify(txt('setAuthNote'))}`);

      /* ---- U9-e 改密（FR-8.4）：成功 ⇒ **Bearer 用会话出口的令牌**、清会话、要求重新登录 ---- */
      intoServerMode();
      BS.save({ token: 'c'.repeat(64), username: 'admin', expiresAt: '2026-10-02 22:00:00' });
      ST.unlocked = true;
      W.Components.SettingPanel.render(ST);
      u9Node('setOldPwd').value = 'Old-Pass-2026';
      u9Node('setNewPwd').value = 'New-Pass-2026';
      u9Node('setNewPwd2').value = 'New-Pass-2026';
      U9_CALLS.length = 0;
      u9NextFetch = () => Promise.resolve(jsonRes(200, {
        ok: true, username: 'admin', requireRelogin: true, sessionsCleared: 1
      }));
      u9Node('setPwdChangeBtn').__fire('click');
      await flush();
      const eCall = callsTo('/auth/change');
      const eHdr = eCall.length ? (eCall[0].init.headers || {}) : {};
      check('U9-e 改密（FR-8.4）成功：真 `POST /auth/change`（`Bearer <令牌>` 取自**会话出口** `BoardSession.token()`）；' +
        '成功后**强制清当前会话**（`BoardSession.token()` 变空、`state.unlocked=false`、输入框清空）并提示"请用新口令重新解锁"',
        eCall.length === 1 && eCall[0].init.method === 'POST' &&
        eHdr.Authorization === 'Bearer ' + 'c'.repeat(64) &&
        BS.token() === '' && ST.unlocked === false &&
        u9Node('setOldPwd').value === '' && u9Node('setNewPwd').value === '' && u9Node('setNewPwd2').value === '' &&
        /重新解锁/.test(txt('setMsg')),
        `change 请求=${eCall.length} 次；headers=${JSON.stringify(eHdr)}；token='${BS.token()}'；unlocked=${ST.unlocked}；` +
        `#setMsg=${JSON.stringify(txt('setMsg'))}`);

      /* ---- U9-e2 两次输入不一致 ⇒ **0 次请求**（前端只做"两次是否一致"这一件本地事） ---- */
      intoServerMode();
      BS.save({ token: 'd'.repeat(64), username: 'admin', expiresAt: '2026-10-02 22:00:00' });
      ST.unlocked = true;
      u9Node('setOldPwd').value = 'Old-Pass-2026';
      u9Node('setNewPwd').value = 'New-Pass-2026';
      u9Node('setNewPwd2').value = 'New-Pass-2026-typo';
      U9_CALLS.length = 0;
      u9NextFetch = () => Promise.resolve(jsonRes(200, { ok: true }));
      u9Node('setPwdChangeBtn').__fire('click');
      await flush();
      check('U9-e2 改密"确认"框不一致 ⇒ **0 次 HTTP**（服务端不受打扰）且 `#entryMsg` 给出可见提示（"本次不提交"）',
        callsTo('/auth/change').length === 0 && /不一致/.test(txt('entryMsg')) && /不提交/.test(txt('entryMsg')),
        `change 请求=${callsTo('/auth/change').length} 次；#entryMsg=${JSON.stringify(txt('entryMsg'))}`);

      /* ---- U9-f 自动锁定到点（FR-8.2）**确实调用 `logout`**（令牌即失效；不各管一套） ---- */
      intoServerMode();
      BS.save({ token: 'e'.repeat(64), username: 'admin', expiresAt: '2026-10-02 22:00:00' });
      ST.unlocked = true;
      const lockMs = evalNumericExpr(constExpr(readText('src/components/SettingPanel.js'), 'AUTO_LOCK_MS'));
      W.Components.SettingPanel.armAutoLock();              /* 与 `?unlock=1` 旁路、设置页解锁同一条 arm 路径 */
      U9_CALLS.length = 0;
      u9NextFetch = () => Promise.resolve(jsonRes(200, { ok: true, username: 'admin', requireRelogin: true, sessionsRemaining: 0 }));
      fire(lockMs);
      await flush();
      await flush();
      const fOut = callsTo('/auth/logout');
      const fHdr = fOut.length ? (fOut[0].init.headers || {}) : {};
      check('U9-f FR-8.2 自动锁定**到点确实调用 `logout`**：定时器回调（`AUTO_LOCK_MS` 由源码常量实读，本机 ' + lockMs +
        ' ms）在服务端模式下发出**恰 1 次** `POST /auth/logout`（带同一枚 `Bearer` 令牌），' +
        '本地令牌当场失效、`state.unlocked=false`（前端计时器与服务端令牌**不各管一套**，ADR-0007 D5）',
        fOut.length === 1 && fOut[0].init.method === 'POST' &&
        fHdr.Authorization === 'Bearer ' + 'e'.repeat(64) &&
        BS.token() === '' && ST.unlocked === false,
        `logout 请求=${fOut.length} 次；headers=${JSON.stringify(fHdr)}；token='${BS.token()}'；unlocked=${ST.unlocked}；` +
        `#setMsg=${JSON.stringify(txt('setMsg'))}`);

      /* ---- U9-g **演示模式**：显式提示 + 行为**逐字不变**（含"演示模式不朝服务端发一次请求"） ---- */
      W.BoardConfig.dataSource = 'mock';
      ST.serverMode = false;
      ST.unlocked = false;
      U9_CALLS.length = 0;
      const gWarnBase = U9_WARN.length;
      u9NextFetch = () => Promise.reject(new Error('演示模式**不该**发请求（U9-g）'));
      delete u9Node('entryMsg').dataset.sticky;              /* 模拟 `flashEntry` 的 4 s 复位（定时器是桩件，手工清粘滞位） */
      W.Components.SettingPanel.render(ST);
      const gNote = txt('setAuthNote');
      const gEntryLocked = txt('entryMsg');
      /* 期望串是**手写字面量**（ADR-0007 D5 原文 + 被 10 张截图基准冻结的演示文案），
         不与实现共用任何表达式 —— 否则"自己的输出证明自己没变"（同 U8 的口径）。 */
      const DEMO_NOTE = '演示模式：未启用服务端口令校验（口令由服务端校验）';
      const DEMO_ENTRY_LOCKED = '当前已锁定：请先在左侧输入解锁密码（演示密码 8888）';
      u9Node('setPwd').value = '8888';
      u9Node('setUnlockBtn').__fire('click');
      await flush();
      const gUnlocked = ST.unlocked;
      const gMsgOk = txt('setMsg');
      const gEntryUnlocked = txt('entryMsg');
      u9Node('setPwd').value = 'not-8888';
      u9Node('setUnlockBtn').__fire('click');
      await flush();
      const gMsgWrong = txt('setMsg');
      const gLockMs = evalNumericExpr(constExpr(readText('src/components/SettingPanel.js'), 'AUTO_LOCK_MS'));
      fire(gLockMs);                                        /* 演示模式到点也不得朝服务端发请求 */
      await flush();
      check('U9-g **演示模式**（`dataSource` 非服务端）：`#setAuthNote` **逐字**＝ADR-0007 D5 那句"未启用服务端口令校验"；' +
        '锁定/解锁两句 `#entryMsg` 与 `#setMsg`（成功/失败）**逐字**等于被基准冻结的演示文案；' +
        '演示口令 `8888` 照旧可解锁；**全程 0 次 HTTP**（自动锁定到点同样不发请求）—— 演示模式一行都不改',
        gNote === DEMO_NOTE && gEntryLocked === DEMO_ENTRY_LOCKED && gUnlocked === true &&
        gMsgOk === '解锁成功，维保录入与公告修改已开放（5 分钟无操作自动锁定）' &&
        gEntryUnlocked === '已解锁：录入内容保存后写入本地库并记录操作日志' &&
        gMsgWrong === '密码错误，请重新输入（演示密码：8888）' &&
        U9_CALLS.length === 0 && U9_WARN.length === gWarnBase,
        `#setAuthNote=${JSON.stringify(gNote)}（期望 ${JSON.stringify(DEMO_NOTE)}）；` +
        `#entryMsg 锁定态=${JSON.stringify(gEntryLocked)}；解锁态=${JSON.stringify(gEntryUnlocked)}；` +
        `#setMsg 成功=${JSON.stringify(gMsgOk)}、失败=${JSON.stringify(gMsgWrong)}；unlocked=${gUnlocked}；` +
        `HTTP 调用=${U9_CALLS.length} 次；warn/error Δ=${U9_WARN.length - gWarnBase}`);

      /* ---- U9-h 静态不变量：零 `localStorage` / 零哈希·比对·计数·锁定判定 ----
         两个扫描面（口径不同，**分别写明**）：
           · `src\**` ＋ `index.html`（全部前端源码）⇒ 只判 `localStorage`（落点口径，D3/D7）；
           · **鉴权四件**（`services/auth.js`／`services/api.js`／`components/SettingPanel.js`／`main.js`）
             ⇒ 判"零哈希/零比对/零计数/零锁定判定"。
             为什么**不**把 `src/config/board.config.js` 算进来：`maxFailures: 5` 是**服务端口径的配置真源**
             （`server/services/auth.js` 读它），它是"配置值"不是"前端判定"—— 把它一起扫会变成用文件名白名单
             排除自己不想看的命中（那正是 D23 要防的"静态防空洞"），故这里把范围写在判据里并说明理由。 */
      const srcFiles = [];
      (function walk(dir) {
        for (const n of fs.readdirSync(dir)) {
          const p = path.join(dir, n);
          const st = fs.lstatSync(p);
          if (st.isDirectory()) walk(p);
          else if (/\.(js|css|html)$/.test(n)) srcFiles.push(p);
        }
      })(path.join(ROOT, 'src'));
      srcFiles.push(path.join(ROOT, 'index.html'));
      const AUTH_LAYER = ['src/services/auth.js', 'src/services/api.js', 'src/components/SettingPanel.js', 'src/main.js'];
      const lsHits = [];
      const hashHits = [];
      for (const f of srcFiles) {
        const rel = path.relative(ROOT, f);
        if (codeOnly(fs.readFileSync(f, 'utf8')).indexOf('localStorage') >= 0) lsHits.push(rel);
      }
      for (const rel of AUTH_LAYER) {
        if (/scrypt|timingSafeEqual|fail_count|locked_until/.test(codeOnly(readText(rel)))) hashHits.push(rel);
      }
      const authRel = path.join('src', 'services', 'auth.js');
      const authCode = codeOnly(readText(authRel));
      const bsDefs = (() => {
        let n = 0;
        for (const f of srcFiles) if (codeOnly(fs.readFileSync(f, 'utf8')).indexOf('window.BoardSession =') >= 0) n++;
        return n;
      })();
      check('U9-h **静态不变量**（一律剥掉注释与字符串后判定）：`src\\**` 与 `index.html` 的可执行代码里 **0 处 `localStorage`**' +
        '（`sessionStorage` 是唯一落点，D3/D7）；**鉴权四件**（`services/auth.js`／`services/api.js`／`components/SettingPanel.js`／`main.js`）里' +
        '**0 处** `scrypt`／`timingSafeEqual`／`fail_count`／`locked_until`（哈希、口令比对、失败计数、锁定判定**全部**在服务端，D5）；' +
        '`window.BoardSession =` 全前端**恰 1 处**定义（会话只有这一个出口）且它就定义在 `src\\services\\auth.js`（内部用 `sessionStorage`）',
        lsHits.length === 0 && hashHits.length === 0 && bsDefs === 1 &&
        authCode.indexOf('sessionStorage') >= 0,
        `扫描文件=${srcFiles.length} 个；可执行 localStorage 命中=${JSON.stringify(lsHits)}；` +
        `鉴权四件的哈希/计数/锁定判定命中=${JSON.stringify(hashHits)}；BoardSession 定义处=${bsDefs}；` +
        `auth.js 可执行代码含 sessionStorage=${authCode.indexOf('sessionStorage') >= 0}` +
        `（注释里的禁令原文：localStorage ${readText(authRel).split('localStorage').length - 1} 处、scrypt ${readText(authRel).split('scrypt').length - 1} 处 —— 属**声明**，不参与判定）`);

      /* ---- U9-i 零控制台噪音 ---- */
      check('U9-i 本节全程**零 `console.warn`/`console.error`**（失败可见一律落在界面提示位，不靠刷控制台）',
        U9_WARN.length === 0, U9_WARN.join(' | ').slice(0, 240));
    } catch (e) {
      U9.err = (e && e.stack) || String(e);
      check('U9 夹具执行完毕（未抛异常）', false, String(U9.err).slice(0, 400));
    }
  }

  console.log('\n=== 汇总 ===');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项，跳过 ${skipped} 项`);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ' —— ' + f.detail : ''}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('\n自检脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
