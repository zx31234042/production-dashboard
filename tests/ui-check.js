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
  [
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
  ].forEach(run);
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

/** 某一行里的「典型值」单元格（第 4 格：检测参数 / 上限 / 下限 / 典型值）；取不到返回 null */
function typicalCell(rows, kind) {
  const row = rows.find(r => r.kind === kind);
  return row ? (row.tds[3] || null) : null;
}

/** 从形如 `<span class="std-value">12.80</span>` 的片段里取出数值（不合口径返回 null） */
function valueOf(snippet, digits) {
  const m = /<span class="std-value">(-?\d+(?:\.\d+)?)<\/span>/.exec(String(snippet || ''));
  if (!m) return null;
  return new RegExp(`^-?\\d+\\.\\d{${digits}}$`).test(m[1]) ? Number(m[1]) : null;
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
    const cells = ['depth', 'speed'].flatMap(k => ['upper', 'lower'].map(side => stdCell(rows, k, k + (side === 'upper' ? 'Upper' : 'Lower'))));
    check(
      'FR-3.18 测试标准区显示深度/速度两行、每行含上限/下限两个可录入单元格（data-edit 齐全）',
      rows.length === 2 && rows.map(r => r.kind).join(',') === 'depth,speed' &&
      cells.every(c => c !== null) && rows.every(r => r.tds.length === 4),
      `行=${rows.map(r => `${r.kind}(${r.tds.length} 格)`).join(' / ') || '（未解析到结构）'}；` +
      `可录入格=${cells.filter(Boolean).length}/4`
    );
    const limitsOk = [['depth', dep], ['speed', spd]].every(([kind, spec]) => {
      const u = stdCell(rows, kind, kind + 'Upper');
      const l = stdCell(rows, kind, kind + 'Lower');
      return spec && valueOf(u && u.text, digits) === spec.upper && valueOf(l && l.text, digits) === spec.lower;
    });
    check(
      'FR-3.18 上限＝典型值＋上偏差、下限＝典型值＋下偏差（按配置 default 段与 state 实算，非硬编码）',
      limitsOk,
      [['depth', dep], ['speed', spd]].map(([kind, spec]) => {
        const u = stdCell(rows, kind, kind + 'Upper');
        const l = stdCell(rows, kind, kind + 'Lower');
        return `${kind}: 上限格=${valueOf(u && u.text, digits)} 应=${spec && spec.upper}；` +
          `下限格=${valueOf(l && l.text, digits)} 应=${spec && spec.lower}`;
      }).join('；')
    );
    check(
      'FR-3.18 深度单位 m、速度单位 m/s，且上下限与典型值一律保留两位小数（位数读配置 standards.digits）',
      [dep, spd].every(spec => spec && spec.digits === digits) &&
      unitOf(typicalCell(rows, 'depth') && typicalCell(rows, 'depth').text) === 'm' &&
      unitOf(typicalCell(rows, 'speed') && typicalCell(rows, 'speed').text) === 'm/s' &&
      valueOf(stdCell(rows, 'depth', 'depthUpper') && stdCell(rows, 'depth', 'depthUpper').text, digits) !== null &&
      valueOf(stdCell(rows, 'speed', 'speedLower') && stdCell(rows, 'speed', 'speedLower').text, digits) !== null &&
      typicalOf(typicalCell(rows, 'depth') && typicalCell(rows, 'depth').text, digits) !== null &&
      typicalOf(typicalCell(rows, 'speed') && typicalCell(rows, 'speed').text, digits) !== null,
      `digits=${digits}（深度/速度配置位数 ${dep && dep.digits}/${spd && spd.digits}）；` +
      `深度行单位=${JSON.stringify(unitOf(typicalCell(rows, 'depth') && typicalCell(rows, 'depth').text))}、` +
      `速度行单位=${JSON.stringify(unitOf(typicalCell(rows, 'speed') && typicalCell(rows, 'speed').text))}`
    );
    check(
      'FR-3.18 典型值单元格给出两位小数取值与带符号偏差（上偏差 +、下偏差 −），且两行都有',
      [['depth', dep], ['speed', spd]].every(([kind, spec]) => {
        const t = typicalCell(rows, kind);
        return typicalOf(t && t.text, digits) === spec.typical &&
          devOf(t && t.text, '上偏差') === '+' + spec.upperDev.toFixed(digits) &&
          devOf(t && t.text, '下偏差') === (spec.lowerDev >= 0 ? '+' : '') + spec.lowerDev.toFixed(digits);
      }),
      [['depth', dep], ['speed', spd]].map(([kind, spec]) => {
        const t = typicalCell(rows, kind);
        return `${kind}: 典型值=${typicalOf(t && t.text, digits)} 应=${spec.typical}；` +
          `上偏差=${devOf(t && t.text, '上偏差')} 应=+${spec.upperDev.toFixed(digits)}；` +
          `下偏差=${devOf(t && t.text, '下偏差')} 应=${(spec.lowerDev >= 0 ? '+' : '') + spec.lowerDev.toFixed(digits)}`;
      }).join('；')
    );
    check(
      'FR-3.18 典型值只显示不改变 state：#tkStdMeta 写明"典型值只显示、不参与判定"与上下限由典型值±偏差导出',
      /典型值只显示、不参与判定/.test(String(fx.node('tkStdMeta').textContent || '')) &&
      /上限＝典型值＋上偏差/.test(String(fx.node('tkStdMeta').textContent || '')) &&
      /下限＝典型值＋下偏差/.test(String(fx.node('tkStdMeta').textContent || '')) &&
      fx.state.task.standard === undefined,
      `#tkStdMeta=${JSON.stringify(String(fx.node('tkStdMeta').textContent || '').slice(0, 80))}；` +
      `state.task.standard=${fx.state.task.standard === undefined ? '未建（只显示不写入）' : '已被渲染建立'}`
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

    /* ---- (d) FR-3.19 第 4 步：反色 + 高亮框 + 0.5 s 闪烁的样式契约（静态，读 CSS） ---- */
    {
      const css = readText('src/styles/global.css');
      const blink = /@keyframes\s+stdBlink\s*\{([\s\S]*?)\n\}/.exec(css) || [];
      /* 三项样式走 `parseCss()`（已按 CRLF 归一，见该函数注释）——
         之前这四条断言假红的根因就是 `global.css` 是 CRLF，属性名带上了 `\r\n` 前缀。 */
      const rulesCss = parseCss(css);
      const editing = rulesCss.get('.std-limits td.is-editing') || {};
      const animMs = Number((String(editing.animation || '').match(/\s(\d*\.?\d+)s(\s|$)/) || [])[1]) * 1000;
      const invRule = rulesCss.get('.std-limits td.is-editing .std-value') || {};
      check(
        'FR-3.19 第4步 反色、高亮框与 0.5 s ± 50 ms 闪烁的样式契约齐备（@keyframes stdBlink + .is-editing 的 animation/box-shadow/反色文字）',
        /@keyframes\s+stdBlink/.test(css) && /50%,\s*100%\s*\{\s*opacity/.test(blink[1] || '') &&
        editing.animation === 'stdBlink .5s step-end infinite' &&
        Math.abs(animMs - 500) <= 50 &&
        /inset 0 0 0 \d+px/.test(editing['box-shadow'] || '') &&
        /var\(--accent\)/.test(editing.background || '') &&
        invRule.color !== undefined && invRule.color.toUpperCase() !== '#FFFFFF',
        `@keyframes stdBlink=${/@keyframes\s+stdBlink/.test(css)}；animation=${JSON.stringify(editing.animation)}（${animMs} ms，允差 ±50）；` +
        `box-shadow=${JSON.stringify(editing['box-shadow'] || '（缺）')}；背景=${JSON.stringify(editing.background || '（缺）')}；` +
        `反色文字色=${JSON.stringify(invRule.color || '（缺）')}`
      );
    }

    /* ---- (e) 第 ①③④⑧ 步：未解锁点击数字不进入录入态；解锁后才进入（FR-3.19 / AC-09） ---- */
    fx.node('tkStdEdit').hidden = true;                     /* index.html 的初始 hidden */
    /** 取当前渲染出的、带指定 data-edit 的可录入单元格（事件目标与断言对象是同一个节点） */
    const realCell = type => {
      /* 走 querySelector('tbody') 而不是 __children：前几个 check 里的 `T.render()` 会重建
         单元格对象，只有经过一次 tbody 查询，夹具缓存里的节点才与"最后一次渲染"对齐 */
      const tb = fx.node('tkStdTable').querySelector('tbody');
      return tb.__children.slice().reverse().map(r => r.__children.find(td => td.dataset.edit === type)).find(Boolean) || null;
    };
    /** 关闭"上一个用例留下的"录入会话（避免它的退出提交污染下一个用例的观察）：
     *  组件在"点击其他区域"时会**先提交再处理点击**，故不显式收尾的话，下一个用例的第一次点击
     *  会顺带用**当前输入框内容**提交上一个会话 —— 实测就踩过这条（下一个用例的 alert 计数与
     *  opLog 都多出一条与它无关的留痕）。
     *  注：这里**不手工清 `#tkStdMsg`** —— 它是组件的渲染产物（`render()` 按
     *  lastErr/lastInfo/session/unlocked 四态择一写入），手工改写会让"锁定后应看到锁定提示"
     *  这条断言变成对用例自己写的内容的观察（自证），而不是对组件输出的观察。 */
    const closeSession = () => { fx.input().value = ''; fx.screen('blur'); };
    fx.click(realCell('depthUpper'));                       /* 锁定时点真实的上限格 */
    check(
      'FR-3.19 第⑧步 未解锁时点击上限/下限数字不进入录入态：#tkStdEdit 保持隐藏、且录入行内无可聚焦的 #tkStdInput',
      fx.node('tkStdEdit').hidden === true && /class="[^"]*is-editing/.test(String(fx.node('tkStdTable tbody').innerHTML)) === false,
      `#tkStdEdit.hidden=${fx.node('tkStdEdit').hidden}；正文含 is-editing=` +
      `${/class="[^"]*is-editing/.test(String(fx.node('tkStdTable tbody').innerHTML))}；` +
      `#tkStdMsg=${JSON.stringify(String(fx.node('tkStdMsg').textContent || '').slice(0, 40))}`
    );
    fx.W.MockData.setUnlocked(true);
    fx.click(realCell('depthUpper'));
    const editRows = parseStdRows(fx.node('tkStdTable tbody').innerHTML);
    const editingCell = stdCell(editRows, 'depth', 'depthUpper');
    check(
      'FR-3.19 第③④步 解锁后点击上限数字进入录入态：该格带 is-editing（反色+高亮+闪烁）、#tkStdEdit 可见、标签写明「深度上限」',
      /(?:^|\s)is-editing(?:\s|$)/.test(editingCell ? editingCell.cls : '') &&
      !/(?:^|\s)is-editing(?:\s|$)/.test((stdCell(editRows, 'depth', 'depthLower') || {}).cls || '') &&
      fx.node('tkStdEdit').hidden === false &&
      /深度上限/.test(String(fx.node('tkStdEditLabel').textContent || '')),
      `上限格 class=${JSON.stringify(editingCell && editingCell.cls)}；下限格 class=` +
      `${JSON.stringify(stdCell(editRows, 'depth', 'depthLower') && stdCell(editRows, 'depth', 'depthLower').cls)}；` +
      `#tkStdEdit.hidden=${fx.node('tkStdEdit').hidden}；标签=${JSON.stringify(String(fx.node('tkStdEditLabel').textContent || ''))}`
    );
    check(
      'FR-3.19 第③步 点击数字会重置"无操作回首页"计时并重新登记自动锁定（activity()：Dashboard.resetIdleTimer + SettingPanel.armAutoLock）',
      (() => {
        const lockMs = evalNumericExpr(constExpr(readText('src/components/SettingPanel.js'), 'AUTO_LOCK_MS'));
          fx.timers.length = 0;                        /* 只观察本次点击登记了什么 */
          const resetsBefore = fx.idleResets;
          fx.click(realCell('depthUpper'));
        const pending = fx.timers.filter(t => t.delay === lockMs && !t.cancelled && !t.fired).length;
        return pending === 1 && fx.idleResets === resetsBefore + 1;
      })(),
      `AUTO_LOCK_MS=${evalNumericExpr(constExpr(readText('src/components/SettingPanel.js'), 'AUTO_LOCK_MS'))} ms；` +
      `点击后存活自动锁定定时器=${fx.timers.filter(t => t.delay === evalNumericExpr(constExpr(readText('src/components/SettingPanel.js'), 'AUTO_LOCK_MS')) && !t.cancelled && !t.fired).length} 个；` +
      `回首页计时重置累计=${fx.idleResets} 次`
    );

    /* ---- (f) 第 ⑥ 步校验：非法（下限 > 上限 / 典型值越界）⇒ 弹窗 + 不写入 ----
       "不写入"的判定对象是**标准取值**（unit/digits/typical/upperDev/lowerDev）逐字不变；
       `opLog` 会**增加一条"被拒绝"留痕**，那是 FR-3.19 的**预期**行为（并发录入逐条留痕），
       故快照比对必须把 opLog 排除在外 —— 否则会把"按规范留痕"误判成"非法值被写入"。
       实现侧依据：`commitSession()` 的两条校验分支都在 `ensureStd()`/写 `upperDev`/`lowerDev` **之前** return。 */
    const stdKeys = ['unit', 'digits', 'typical', 'upperDev', 'lowerDev'];
    const stdDepth = () => fx.state.task.standard && fx.state.task.standard.depth;
    const stdDepthVals = () => JSON.stringify(stdKeys.map(k => (stdDepth() || {})[k]));

    fx.click(realCell('depthLower'));
    fx.input().value = '+0.60';                       /* 下偏差显式取正 ⇒ 下限 13.10 > 上限 12.80 */
    const depthValsBefore = stdDepthVals();    const logCountBefore = fx.state.opLog.length;
    fx.alerts.length = 0;
    fx.screen('keydown');                             /* 回车 */
    const rejectedLog = fx.state.opLog[fx.state.opLog.length - 1] || {};
    check(
      'FR-3.19 第⑥步 非法录入（下限 > 上限）⇒ alert 弹窗提醒、标准取值逐字不变（不写入）、且 opLog 追加一条"被拒绝"留痕',
      fx.alerts.length === 1 && /下限/.test(fx.alerts[0]) && /上限/.test(fx.alerts[0]) &&
      stdDepthVals() === depthValsBefore && fx.state.opLog.length === logCountBefore + 1 &&
      /录入被拒绝/.test(String(rejectedLog.detail || '')),
      `alert=${fx.alerts.length} 次（${JSON.stringify((fx.alerts[0] || '').slice(0, 56))}）；` +
      `标准取值${stdDepthVals() === depthValsBefore ? '未变' : '**被改动**'}（${depthValsBefore}）；` +
      `opLog ${logCountBefore} → ${fx.state.opLog.length} 条，末条=${JSON.stringify(String(rejectedLog.detail || '').slice(0, 40))}`
    );
    check(
      'FR-3.19 第⑥步 非法录入后录入态被退出且显示红字提醒：#tkStdEdit 隐藏、#tkStdMsg 带 err 类',
      fx.node('tkStdEdit').hidden === true && /err/.test(String(fx.node('tkStdMsg').className || '')) &&
      !/is-editing/.test(String(fx.node('tkStdTable tbody').innerHTML)),
      `#tkStdEdit.hidden=${fx.node('tkStdEdit').hidden}；#tkStdMsg.className=${JSON.stringify(String(fx.node('tkStdMsg').className || ''))}`
    );

    /* 典型值越界分支（FR-3.19 第⑥步第二项校验）：构造一个**下限 ≤ 上限 成立、但典型值不在区间内**
       的状态，再录下限 —— 应被"典型值在上下限之间"挡下。
       为什么这样造：校验顺序是「下限 ≤ 上限」在前、居中校验在后，若构造出让下限 > 上限的
       偏差组合，命中的会是**第一项**校验（实测踩过：12.95/上限13.25/下限12.75 其实是合法区间，
       于是那条断言看到的是"合法写入"，不是"非法拒绝"）。
       取 `upperDev = -0.40`（上限 12.10 < 典型值 12.50 ⇒ 当前区间本就不含典型值），
       注入 `lowerDev = -0.45`（下限 12.05 ≤ 上限 12.10，第一项通过），于是只剩第二项拦它。 */
    T.ensureStd(fx.state, 'depth');
    T.ensureStd(fx.state, 'speed');
    fx.state.task.standard.depth.upperDev = -0.40;
    fx.state.task.standard.depth.lowerDev = -0.50;
    closeSession();                                   /* 收掉上一个用例留下的会话 */
    fx.click(realCell('depthLower'));
    fx.input().value = '-0.45';
    const depthValsBefore2 = stdDepthVals();
    const logCountBefore2 = fx.state.opLog.length;
    fx.alerts.length = 0;
    fx.screen('keydown');
    check(
      'FR-3.19 第⑥步 非法录入（典型值不在上下限之间）⇒ 弹窗且标准取值逐字不变（不写入）、opLog 追加被拒绝留痕',
      fx.alerts.length === 1 && /典型值/.test(fx.alerts[0]) && /不在上下限/.test(fx.alerts[0]) &&
      stdDepthVals() === depthValsBefore2 && fx.state.opLog.length === logCountBefore2 + 1 &&
      /录入被拒绝/.test(String((fx.state.opLog[fx.state.opLog.length - 1] || {}).detail || '')),
      `alert=${JSON.stringify((fx.alerts[0] || '').slice(0, 70))}；当前标准=${depthValsBefore2}；` +
      `标准取值${stdDepthVals() === depthValsBefore2 ? '未变' : '**被改动**'}；opLog ${logCountBefore2} → ${fx.state.opLog.length} 条`
    );

    /* ---- (g) 第 ⑤⑥ 步：不带符号按默认口径（下偏差负、上偏差正）＋ 回车/点击其他区域注入 ---- */
    fx.state.task.standard.depth.typical = dep.typical;              /* 复位为配置典型值，便于实算比对 */
    /* 同时把偏差复位成**配置默认段**：上一个用例刻意把上/下偏差改成 −0.40/−0.50（造"典型值越界"），
       若不复位，本用例注入 −0.35 会让下限 12.15 > 上限 12.10，被"下限 ≤ 上限"挡下（实测踩过）。 */
    fx.state.task.standard.depth.upperDev = dep.upperDev;
    fx.state.task.standard.depth.lowerDev = dep.lowerDev;
    closeSession();                                                  /* 收掉上一个用例留下的会话 */
    fx.click(realCell('depthLower'));
    fx.input().value = '0.35';                                       /* 无符号 ⇒ 下偏差应为 −0.35 */
    const beforeLower = stdDepth().lowerDev;
    fx.screen('keydown');                                            /* 回车 = 退出并注入 */
    const lowerAfter = stdDepth().lowerDev;
    const lowerLimit = stdCell(parseStdRows(fx.node('tkStdTable tbody').innerHTML), 'depth', 'depthLower');
    check(
      'FR-3.19 第⑤⑥步 无符号输入按默认口径（下偏差默认负）：回车退出并注入，下限＝典型值＋(输入取负)，画面随之刷新',
      lowerAfter === -0.35 && lowerAfter !== beforeLower && valueOf(lowerLimit && lowerLimit.text, digits) === r2(dep.typical - 0.35),
      `下偏差 ${beforeLower} → ${lowerAfter}（应 −0.35）；画面下限格=${valueOf(lowerLimit && lowerLimit.text, digits)} 应=${r2(dep.typical - 0.35)}`
    );
    fx.click(realCell('depthUpper'));
    fx.input().value = '0.35';                                       /* 无符号 ⇒ 上偏差应为 +0.35 */
    fx.screen('blur');                                               /* 失焦 = 点击其他区域，同样退出并注入 */
    const upperAfter = stdDepth().upperDev;
    check(
      'FR-3.19 第⑤⑥步 无符号输入按默认口径（上偏差默认正）：失焦（点击其他区域）退出并注入，上限＝典型值＋输入',
      upperAfter === 0.35 && valueOf(stdCell(parseStdRows(fx.node('tkStdTable tbody').innerHTML), 'depth', 'depthUpper').text, digits) === r2(dep.typical + 0.35),
      `上偏差=${upperAfter}（应 +0.35）；画面上限格=` +
      `${valueOf(stdCell(parseStdRows(fx.node('tkStdTable tbody').innerHTML), 'depth', 'depthUpper').text, digits)} 应=${r2(dep.typical + 0.35)}`
    );

    /* ---- (h) Esc / 取消：不注入 ---- */
    const speedValsBefore = JSON.stringify(['upperDev', 'lowerDev'].map(k => (fx.state.task.standard.speed || {})[k]));
    fx.click(realCell('speedUpper'));
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
    fx.click(realCell('speedLower'));
    fx.input().value = '0.25';
    fx.screen('keydown');                                            /* 回车注入（无符号 ⇒ 下偏差 −0.25） */
    const log = fx.state.opLog[fx.state.opLog.length - 1] || {};
    const detail = String(log.detail || '');
    check(
      'FR-3.19 第⑦步 成功后留痕：state.opLog 末条含动作、改动前后数值、生效时间戳（取自 state.clock）与班组编号（取自 config.shift.roster.teamId）',
      fx.state.opLog.length > 0 && log.action === '测试标准录入' &&
      /\d{2}:\d{2}:\d{2}/.test(String(log.time || '')) &&
      new RegExp('生效时间 ' + fx.state.clock.date + ' ' + fx.state.clock.time).test(detail) &&
      detail.includes(fx.W.BoardConfig.shift.roster.teamId) &&
      /→/.test(detail) && /新偏差/.test(detail),
      `末条日志=${JSON.stringify({ action: log.action, time: log.time, date: log.date, detail: detail.slice(0, 90) })}；` +
      `期望时间戳=${JSON.stringify(fx.state.clock.date + ' ' + fx.state.clock.time)}、班组编号=${JSON.stringify(fx.W.BoardConfig.shift.roster.teamId)}`
    );
    check(
      'FR-3.19 配套约束"修改成功前不改动现有值与显示"：取消/非法录入不留半成品（日志只记录被拒绝与取消，state 里没有未成功生效的标准行）',
      fx.state.opLog.some(o => /录入被拒绝/.test(String(o.detail || ''))) &&
      fx.state.opLog.some(o => /取消.*录入/.test(String(o.detail || ''))) &&
      /^CP-2026-A17$/.test(String(fx.state.task.standard.productCode || '')) &&
      fx.state.task.standard.revision >= 2,
      `opLog 动作=${fx.state.opLog.map(o => o.action).join('/')}；` +
      `standard.productCode=${JSON.stringify(fx.state.task.standard.productCode)}、revision=${fx.state.task.standard.revision}`
    );

    /* ---- (j) 第 ⑧ 步 锁定语义：录入会话中 activity() 重置回首页计时 + 重新 arm（同一个 5 分钟计时器） ---- */
    fx.timers.length = 0;
    const resetsBefore = fx.idleResets;
    fx.click(realCell('speedLower'));
    const lockMs2 = evalNumericExpr(constExpr(readText('src/components/SettingPanel.js'), 'AUTO_LOCK_MS'));
    check(
      'FR-3.19 第⑧步 锁定＝与 FR-8.2 同一个 5 分钟无操作计时器：录入动作触发 activity() 时先重置回首页计时、再重新 arm 自动锁定（各 1 次、只存活 1 个计时器）',
      fx.idleResets === resetsBefore + 1 &&
      fx.timers.filter(t => t.delay === lockMs2 && !t.cancelled && !t.fired).length === 1 &&
      fx.timers.filter(t => t.cancelled).length === 0,
      `回首页计时重置次数 ${resetsBefore} → ${fx.idleResets}；存活 ${lockMs2} ms 自动锁定定时器 ` +
      `${fx.timers.filter(t => t.delay === lockMs2 && !t.cancelled && !t.fired).length} 个；` +
      `已取消 ${fx.timers.filter(t => t.cancelled).length} 个（应为 0：本次仅 arm 一次）`
    );
    fx.click(realCell('speedLower'));
    closeSession();                                                   /* 收掉本次会话，使下一步只观察"又一次动作" */
    const cancelledBefore = fx.timers.filter(t => t.delay === lockMs2 && t.cancelled).length;
    fx.click(realCell('speedLower'));                                 /* 第二个动作：重复 arm 不堆叠 */
    check(
      'FR-3.19 第⑧步 连续录入动作不堆叠自动锁定计时（第二次 arm ⇒ 仍只存活 1 个、且把上一次的计时 clearTimeout 掉）',
      fx.timers.filter(t => t.delay === lockMs2 && !t.cancelled && !t.fired).length === 1 &&
      fx.timers.filter(t => t.delay === lockMs2 && t.cancelled).length === cancelledBefore + 1,
      `存活=${fx.timers.filter(t => t.delay === lockMs2 && !t.cancelled && !t.fired).length} 个、` +
      `被取消=${fx.timers.filter(t => t.delay === lockMs2 && t.cancelled).length} 个（本次动作前 ${cancelledBefore} 个）`
    );
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
      fx2.click(cellOf('depthUpper'));                                 /* 解锁 ⇒ 进入录入态（真路径） */
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

  /* ---------------- 汇总 ---------------- */
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
