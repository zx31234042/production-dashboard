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
  const noComment = text.replace(/\/\*[\s\S]*?\*\//g, '');
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
 *   ③ `setTimeout`/`clearTimeout` 只**登记**不真等：用例按 `delay` 找到回调并手工触发。
 * @returns {{w:object, nodes:Map<string,object>, timers:Array, click:Function, fire:Function}}
 */
function loadAutoLockFixture() {
  const nodes = new Map();
  const timers = [];
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

  const sandbox = { console };
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
    /* FR-3.14 实测值超阈值高亮（黄=临近、红=超标） */
    const s = JSON.parse(JSON.stringify(W.MockData.state));
    s.task.real.fps = s.task.std.fps + 5;        // 帧率容差 err=2 → 应判"超标"
    s.task.real.gain = s.task.std.gain + 0.2;    // 增益容差 warn=0.15 / err=0.30 → 应判"临近"
    ui.out.length = 0;
    W.Components.TaskPanel.render(s);
    const table = lastHtml(ui.out, 'tkCompareTable tbody') || '';
    check('FR-3.14 超阈值判定：帧率超标、增益临近', /超标/.test(table) && /临近/.test(table),
      `帧率 +5fps、增益 +0.2 后表格中 ${/超标/.test(table) ? '有' : '无'}超标、${/临近/.test(table) ? '有' : '无'}临近`);
    const warnings = W.MockData.state.warnings.map(w => w.title + ':' + w.lv).join(' | ');
    check('FR-3.14 预警区与设备参数判定联动', W.MockData.state.warnings.some(w => w.title.includes('参数阈值')),
      `当前预警：${warnings}`);
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
    check('FR-5.8～5.11 预防性预警区按字典渲染标题与详情（联动设备参数判定）',
      (() => {
        ui.out.length = 0;
        W.Components.AlarmPanel.render({
          alarm: { active: null, queue: [], ledger: [] },
          warnings: [{ lv: 'warn', title: '帧率接近上限', detail: '当前 950/1000 fps' }]
        });
        const list = String(lastHtml(ui.out, 'alWarningList') || '');
        return list.includes('帧率接近上限') && list.includes('950/1000');
      })(), '');
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
