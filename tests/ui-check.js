/* ==========================================================================
   界面结构与需求规范自检（tests/ui-check.js）
   作用：把「需求清单 V1.26 的 FR-1～FR-4、FR-9、UI-01/03/04/08/11」中可离线判定的条款
         与 src/ 的实际渲染结果逐条对照。三类判据：
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
    getElementById: () => null
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

/* ---------------- 需求规范基线（来源：需求清单 V1.26） ---------------- */
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
