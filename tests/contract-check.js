/* ==========================================================================
   第三方字段契约与适配层自检（tests/contract-check.js）
   作用：把 tests/README.md 第 6.1～6.7 项里**可离线执行**的部分脚本化，覆盖：
         A. 附录 2 契约（13 字段）↔ config/fieldMap.js 的 boardToReport
         B. 上位机报文契约：fieldMap.upperToBoard ↔ samplePayload ↔ mockUpperSource ↔ tools/mock-upper
         B2b. 相机侧设定值**四处对账**（工具侧运行期产出 ＋ fieldMap.samplePayload ＋ browser-check 夹具 ↔ mockUpperSource；E20，2026-10-06）
         B3. testStatus 口径（V1.37 / C-98）：附录 2 代码语义（0=待机/1=测试中/2=测试完成/3=设备异常）
             ↔ 显示模式四态（2 显示为「正常停机」）↔ 上报 MES 反查表（**维保检修→0**，本次修正点）
         C. services/api.js 的 IF-D 行为（缺字段容错 / 冻结判定 / 配置化生效）
         D. services/api.js 的 IF-B 行为（13 字段上报 / 两种回执风格 / 失败入队——**不自动重发**；
            flushPending 只刷新待补传状态与告警、不发送，人工入口 retryPending 才发送）
         E. ?source=upper 端到端链路（内置模拟上位机的取帧顺序）
         F. IF-D 降级接线：数据冻结时界面判据 state.device.link 是否跟随（IF-D.9）
         G. 派生统计量的收敛与累计一致性（当班统计非负、累计运行不倒退、待办与自检可闭环）
         H. 界面渲染安全：公告/检修录入走 innerHTML 时的转义（FR-7.12、FR-6.11）
         I. 交付物 .docx 的 ZIP/OPC 条目名结构
         J. 文档与源码的版本号、附录 2 项数一致性
         K. 现状快照（非缺陷）：口径占位项，变了就提醒重新确认
         L. 常量集中化：颜色字面量、维保/耗材阈值是否走配置（PROJECT_RULES 五章）
         M. 跨实现一致性：前端演示实现 mockData.js ↔ 服务端权威实现 stats.js
            （同一组输入下 一次性合格率/产能达成率/稼动率/平均测试时长 必须一致，
              ADR-0005 第三节建议第 2 条；配 ADR-0004 D22 定点变异反证）
         M2. 跨实现一致性（**累计运行时长**）：前端 accumulateRun ↔ 服务端 accumulateRunTime（E32；
             跨班次/跨零点（E83 切段）/跨月/跨年/空序列/负增量夹零 逐值相等 ＋ D22 定点变异反证）
         N. 补传队列告警阈值单一真源（R26-P3-4 / E10 / IF-B.9）
         O. E176① 告警阈值边界收窄：入口层（装配期）＋ 真源读取层（E176）
   依赖：仅 Node 内置模块；不联网（只连本机回环端口）、不启动浏览器。
   运行：node tests/contract-check.js
   退出码：0 = 全部通过；1 = 有断言失败（失败项即待修缺陷）。
   对应需求：IF-C.1（三方映射表）、IF-B.8（附录 2 共 13 字段）、
             IF-B.9（失败入队**不自动重发**：flushPending 只刷新状态与告警、人工入口 retryPending 才发送）、
             IF-D.9（断连/数据冻结）、FR-2.1/FR-2.5/FR-2.8（V1.37 / C-98：testStatus 口径与映射表）、
             FR-2.6、Q-21、Q-23
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const env = require('./env');
env.assertRuntime();

/* `E100`②（2026-10-03）：本脚本要用夹具的**空闲端口分配**（`allocPort`）取代写死的 18896～18899。
   为什么走夹具而不是自己写一份：端口分配口径只能有一处（`tests\lib\harness.js` 的 `allocPort`
   已服务 `startService` 与 §15 的嵌套轮），另起一份会各写各的。
   夹具顶层会做**只读**的"临时区语义校验"（`E90`／`T-20261003-10` 之后它不再注入任何副作用），
   故本行不改变本脚本的既有行为 —— 断言与条数一字未动。 */
const harness = require('./lib/harness');

const ROOT = path.resolve(__dirname, '..');

/* ---------------- 极简断言框架 ---------------- */
let passed = 0;
const failures = [];
let skipped = 0;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/** 记录一条断言结果；detail 在失败时打印 */
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

/** 数值四舍五入到 2 位，仅用于自检输出 */
function fmtNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : String(v);
}

/** 集合差异描述，用于把"哪几个字段不一致"直接写进报告 */
function diffSets(actual, expected) {
  const a = new Set(actual);
  const e = new Set(expected);
  const onlyActual = [...a].filter(x => !e.has(x));
  const onlyExpected = [...e].filter(x => !a.has(x));
  const parts = [];
  if (onlyActual.length) parts.push('多出：' + onlyActual.join(', '));
  if (onlyExpected.length) parts.push('缺少：' + onlyExpected.join(', '));
  return parts.join('；') || '（无差异）';
}

/* ---------------- 以浏览器脚本的方式加载 src/ ---------------- */
/* 这些文件都是 "window.X = (function(){...})()" 的 IIFE，用 vm 在全局作用域执行即可 */
global.window = global;

function loadScript(relPath) {
  const full = path.join(ROOT, relPath);
  vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full });
}

/* 加载顺序与 index.html 一致：config → utils → services */
const LOAD_ORDER = [
  'src/config/board.config.js',
  'src/config/fieldMap.js',
  'src/utils/dom.js',
  'src/utils/format.js',
  'src/services/api.js',
  'src/services/mockData.js',
  'src/services/mockUpperSource.js'
];
LOAD_ORDER.forEach(loadScript);

const CFG = window.BoardConfig;
const MAP = window.FieldMap;
const Api = window.Api;
const Mock = window.MockData;
const UpperSource = window.MockUpperSource;

/** state 的深拷贝：自检过程中会改字段，避免污染 MockData 的单例 */
function cloneState() {
  return JSON.parse(JSON.stringify(Mock.state));
}

/** upperToBoard 里"报文侧"的字段名（字符串写法取本身，对象写法取 key） */
function payloadKeysFromMap() {
  return [...new Set(Object.values(MAP.upperToBoard).map(spec => (typeof spec === 'string' ? spec : spec.key)))];
}

/**
 * 运行 tools/mock-upper 的 --once，取一帧真实报文
 * 说明：用文件描述符承接 stdout（不用管道），以适配受限沙箱；失败则返回 null 走 SKIP
 */
function mockUpperCliFrame() {
  const out = path.join(os.tmpdir(), 'contract-check-mock-upper.json');
  let fd;
  try {
    fd = fs.openSync(out, 'w');
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'mock-upper', 'mock-upper.js'), '--once'], {
      stdio: ['ignore', fd, 'ignore']
    });
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (e) {
    return null;
  }
}

/* ---------------- 通用读取与独立运行环境（供 F～K 段使用） ---------------- */

/** 读仓库内文件（UTF-8） */
function readText(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/**
 * 在全新的 vm 上下文里按 index.html 的顺序加载 src/，得到互不干扰的一套 window
 * 用途：mockData.js 在加载时就快照了 board.config 的取值，要验证"改配置后的行为"必须换一套实例
 * @param {object} [options] options.planQty 在加载 mockData 之前改写当班计划数
 */
function createIsolatedHarness(options) {
  const sandbox = { console, fetch, AbortSignal, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const run = rel => vm.runInContext(readText(rel), sandbox, { filename: path.join(ROOT, rel) });
  run(LOAD_ORDER[0]);
  if (options && typeof options.planQty === 'number') sandbox.window.BoardConfig.production.planQty = options.planQty;
  if (options && typeof options.mutate === 'function') options.mutate(sandbox.window);
  LOAD_ORDER.slice(1).forEach(run);
  sandbox.__at = iso => vm.runInContext(`new Date(${JSON.stringify(iso)})`, sandbox);
  return sandbox;
}

/** 递归收集某目录下指定扩展名的文件 */
function walkFiles(dir, ext) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, ext));
    else if (entry.name.toLowerCase().endsWith(ext)) out.push(full);
  }
  return out;
}

/**
 * 读取 ZIP 的中央目录，返回条目名列表（零依赖，只解析签名 0x02014b50）
 * 用于检查 .docx 的 OPC 部件名是否用正斜杠
 */
function zipEntryNames(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录结束记录');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * 假 DOM：把写进 innerHTML / setHTML / setText 的内容收集起来
 * 用途：不启浏览器也能验证"用户输入是否被原样拼进 HTML"
 */
function makeFakeDom(captured) {
  const node = () => {
    const o = { style: {}, dataset: {}, textContent: '', value: '' };
    Object.defineProperty(o, 'innerHTML', {
      get() { return ''; },
      set(v) { captured.push(String(v)); },
      configurable: true
    });
    o.classList = { toggle() {}, add() {}, remove() {} };
    o.querySelector = () => node();
    o.appendChild = () => {};
    o.remove = () => {};
    return o;
  };
  return {
    $: () => node(),
    setText: (id, v) => captured.push(String(v)),
    setHTML: (id, v) => captured.push(String(v)),
    setClass: () => {},
    setStyle: () => {},
    toggleClass: () => {}
  };
}

/** 只加载 Format + 假 Dom + 指定组件，返回该上下文的 window */
function createComponentHarness(componentRels, domMock) {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const run = rel => vm.runInContext(readText(rel), sandbox, { filename: path.join(ROOT, rel) });
  run('src/utils/format.js');
  sandbox.window.Dom = domMock;
  componentRels.forEach(run);
  return sandbox.window;
}

/** 取需求文档当前基线版本号（只取 需求文档/ 根目录下的当前基线，文件名里的 Vx.y） */
function baselineRequirementVersion() {
  const dir = path.join(ROOT, '需求文档');
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map(e => e.name);
  const versions = files
    .map(n => (n.match(/-V(\d+\.\d+)\.md$/i) || [])[1])
    .filter(Boolean)
    .map(v => ({ raw: v, num: v.split('.').reduce((a, b) => a * 1000 + Number(b), 0) }));
  if (!versions.length) return null;
  versions.sort((a, b) => b.num - a.num);
  return { raw: versions[0].raw, file: files.find(n => n.includes('-V' + versions[0].raw)) };
}

/**
 * 取需求清单附录 2 字段表的行（供两处断言共用，避免"表头一处、正文另一处"各判各的）
 * 输入：需求清单全文行数组；输出：{ declared, rows }，declared 为「共 N 项」里的 N
 */
function appendix2FieldRows(lines) {
  const idx = lines.findIndex(l => /附录\s*2/.test(l) && /共\s*\d+\s*项/.test(l));
  const rows = [];
  if (idx < 0) return { declared: null, rows };
  const declared = Number(lines[idx].match(/共\s*(\d+)\s*项/)[1]);
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith('|')) { if (rows.length) break; else continue; }
    if (/^\|[\s:|-]+\|$/.test(l) || l.includes('字段标识')) continue;
    rows.push(l);
  }
  return { declared, rows };
}

/* ---------------- 在进程内起"假 MES"（tools/mock-mes） ---------------- */
/* mock-mes.js 是 CLI：入口处读 process.argv 后立刻监听端口，所以在进程内改 argv 再 require 即可。
   ⚠ 端口**不再写死**（`E100`②，2026-10-03）：`harness.allocPort()`（`tests\lib\harness.js`）
   先 `bind(0)` 拿一个当前空闲的端口再释放 ⇒ 每次运行都不同。
   改前写死 18896～18899（本文件 `:581-588` 与 `:834`）导致两类现场故障：
     ① 并发门禁轮（同一工作区跑两路 `run-all`，每路的 §15 嵌套子集轮都含本脚本）**互抢固定端口**；
     ② 现场机器上只要有常驻进程占着 18899，本脚本就**每次都跑不了**。
   端口被占时的收场已由 `tools\mock-mes\mock-mes.js` 的 `'error'` 监听改成"打印 `EADDRINUSE`
   ＋ 非 0 退码"（`E100`①）—— `run-all` 据此归 `collided`（可重试的环境条件），不再崩栈。 */
async function startMockMes({ port, receipt, failRate }) {
  const mesPath = path.join(ROOT, 'tools', 'mock-mes', 'mock-mes.js');
  const savedArgv = process.argv;
  process.argv = ['node', mesPath, '--port', String(port), '--receipt', receipt, '--fail-rate', String(failRate)];
  try {
    delete require.cache[require.resolve(mesPath)];
    require(mesPath);
  } finally {
    process.argv = savedArgv;
  }
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch (e) { /* 还没起来，继续等 */ }
    await sleep(100);
  }
  return false;
}

/**
 * 取 n 个**互不相同**的空闲端口（`E100`②）。
 * 为什么要"取满再起服务"而不是"起一个取一个"：`allocPort` 是"先 bind 0 再释放"，
 * 每次调用都是一个**新鲜的** bind(0)，理论上两次调用可能拿到同一个号；这里做一次去重兜底，
 * 拿到重复号就重取，保证三个假 MES 不会互相撞。
 * @param {number} n
 * @returns {Promise<number[]>}
 */
async function allocDistinctPorts(n) {
  const ports = [];
  while (ports.length < n) {
    const p = await harness.allocPort();
    if (!ports.includes(p)) ports.push(p);
  }
  return ports;
}

/* ---------------- 自检主体 ---------------- */
async function main() {
  /* ===== A. 附录 2 契约：需求清单 §6.4 字段表 ↔ fieldMap.boardToReport ===== */
  section('A. 附录 2 上报字段契约（IF-B.8 / IF-C.1）');
  const APPENDIX2 = [
    'equipCode', 'procOrderNo', 'frameRate', 'gain', 'shutter', 'cameraDepth', 'depth',
    'speed', 'velocity_x', 'velocity_y', 'collectTime', 'testStatus', 'uploadId'
  ];
  const reportKeys = Object.keys(MAP.boardToReport);
  check(
    `附录 2（需求清单 V${(baselineRequirementVersion() || { raw: '?' }).raw} §6.4 表）共 13 个字段`,
    APPENDIX2.length === 13,
    `实际 ${APPENDIX2.length}`
  );
  check(
    'fieldMap.boardToReport 的字段名与附录 2 完全一致',
    reportKeys.length === APPENDIX2.length && reportKeys.every(k => APPENDIX2.includes(k)),
    diffSets(reportKeys, APPENDIX2)
  );
  check(
    'fieldMap.boardToReport 字段顺序与附录 2 表一致',
    reportKeys.every((k, i) => k === APPENDIX2[i]),
    `实际顺序：${reportKeys.join(', ')}`
  );

  /* ===== B. 上位机报文契约：映射表 ↔ 样例 ↔ 两个模拟上位机（Q-21 / IF-D） ===== */
  section('B. 上位机报文契约一致性（IF-D / Q-21）');
  const mapKeys = payloadKeysFromMap();
  const sampleKeys = Object.keys(MAP.samplePayload);
  const sourceFrame = UpperSource.sample();
  const sourceKeys = Object.keys(sourceFrame);
  check(
    'fieldMap 映射的报文键 ↔ fieldMap.samplePayload 完全一致',
    mapKeys.length === sampleKeys.length && mapKeys.every(k => sampleKeys.includes(k)),
    diffSets(sampleKeys, mapKeys)
  );
  check(
    'fieldMap 映射的报文键 ↔ services/mockUpperSource.js 产出完全一致',
    mapKeys.length === sourceKeys.length && mapKeys.every(k => sourceKeys.includes(k)),
    diffSets(sourceKeys, mapKeys)
  );
  const cliFrame = mockUpperCliFrame();
  if (cliFrame === null) {
    skip('fieldMap 映射的报文键 ↔ tools/mock-upper 产出完全一致', '本沙箱内无法捕获子进程输出，请手工执行 node tools/mock-upper/mock-upper.js --once 比对');
  } else {
    const cliKeys = Object.keys(cliFrame);
    check(
      'fieldMap 映射的报文键 ↔ tools/mock-upper 产出完全一致',
      mapKeys.length === cliKeys.length && mapKeys.every(k => cliKeys.includes(k)),
      diffSets(cliKeys, mapKeys)
    );
  }

  /* ---- B2. 相机侧设定值：`state.task.std` ↔ 上位机报文 `std*` 跨实现一致 ＋ 与航行器深度标准**分语义** ----
     立案（ADR-0004 D22 定点变异 B 漏判）：把 `src/services/mockData.js` 的 `std: { depth: 12.50, … }`
     改成 `5.00`（＝把**相机设定深度**误当成航行器深度标准的量级）后，**改动前**的 ui-check 90/0、
     copy-check 28/0、contract-check 66/0、tools-check 24/0 **全绿** —— 因为此前没有任何断言把这两套语义分开：
     `state.task.std` 只被"二级菜单显示值 = state.task.std[key]"这类**自洽**断言读过（写什么就显示
     什么，值改错了照样自洽），而报文侧的 `stdDepth` 是另一份硬编码的 12.50，两边从未对过账。
     本条把它钉成两件**可证伪**的事实（字段名与精度都取自 `fieldMap.upperToBoard`，不硬编码）：
       ① **跨实现一致**：`state.task.std.{depth,gain,fps,shutter}`（＝任务数据页二级菜单显示的那四项，
          FR-3.16）与 `services/mockUpperSource.js` 产出的 `stdDepth/stdGain/stdFps/stdShutter`
          （IF-D.3 / FR-3.5 的「设备参数」，即 fieldMap 的 `task.std.*` → `key` 映射）逐项相等；
       ② **语义钉开**：`state.task.std.depth` ＝**相机设定深度**（FR-3.5 / IF-D.3 设备参数，与
          `real.cameraDepth`＝相机自身水下深度同侧、±12 m 量级），**不得**等于**航行器深度标准**的
          典型值（FR-3.18 / C-86：`standards.default.depth.typical` ＝ 5.00 m；现场录入后取
          `state.task.standard.depth`）—— 两套数据语义不同、各有单一真源（见 board.config.js 的
          `standards` / `camera` 两段注释与 fieldMap.js 对 `task.std.depth` 的注），故"相等"即上游
          那类错误（菜单显示相机设定深度 5.00 m，而 cameraDepth ≈ 12.0 / 上位机 stdDepth = 12.50）。
       ③ **同侧旁证**（把②从"两个数不相等"提升为"两个物理量分属两侧"）：相机设定深度与**相机自身
          水下深度**的距离必须**小于**它与**航行器实测深度**的距离（两者都实算，不写死 12 / 5）。
     反证（变异 B）：① 报 depth 不一致（5.00 vs 12.50），② 报"相机设定深度 ＝ 航行器深度标准典型值"，
     ③ 同侧性反转（|5−12| = 7 ≮ |5−5| = 0）—— 三半各自独立变红。 */
  {
    const CAM_KEYS = ['depth', 'gain', 'fps', 'shutter'];
    const camFrame = UpperSource.sample();
    const camRows = CAM_KEYS.map(kind => {
      const spec = MAP.upperToBoard['task.std.' + kind];
      const key = typeof spec === 'string' ? spec : (spec && spec.key);
      const digits = (spec && typeof spec.digits === 'number') ? spec.digits : 2;
      const board = (Mock.state.task.std || {})[kind];
      const wire = key === undefined ? undefined : camFrame[key];
      /* 按 fieldMap 声明的位数比对（显示精度即契约精度），避免浮点表示差异被当成实现差异 */
      const norm = v => (typeof v === 'number' && Number.isFinite(v)) ? Number(v.toFixed(digits)) : v;
      const num = v => typeof v === 'number' && Number.isFinite(v);
      return {
        kind, key, board, wire,
        same: key !== undefined && num(board) && num(wire) && norm(board) === norm(wire)
      };
    });
    const camOk = camRows.length > 0 && camRows.every(r => r.same);
    /* 航行器深度标准的典型值：运行时真源（FR-3.19 现场录入）优先、未录入回退演示默认段 ——
       与 mockData.standardSpecOf / fieldMap.standardLimits 同一取值口径 */
    const runStdDepth = (Mock.state.task.standard || {}).depth;
    const dftStdDepth = ((CFG.standards || {}).default || {}).depth;
    const vesselTypical = (runStdDepth || dftStdDepth || {}).typical;
    const camSetDepth = (Mock.state.task.std || {}).depth;
    const camOwnDepth = (Mock.state.task.real || {}).cameraDepth;   // 相机自身水下深度（IF-D.1）
    const vesselReal = (Mock.state.task.real || {}).depth;          // 航行器实测深度
    const num = v => typeof v === 'number' && Number.isFinite(v);
    const sideOk = num(camSetDepth) && num(camOwnDepth) && num(vesselReal) &&
      Math.abs(camSetDepth - camOwnDepth) < Math.abs(camSetDepth - vesselReal);
    check(
      'FR-3.5/FR-3.16/IF-D.3 相机侧设定值跨实现一致且与航行器深度标准（FR-3.18 / C-86）分语义：' +
      'state.task.std.{depth,gain,fps,shutter} ↔ mockUpperSource 的 std{Depth,Gain,Fps,Shutter} 逐项相等，' +
      '且相机设定深度 ≠ 航行器深度标准典型值（两套语义不得混用）',
      camOk && camSetDepth !== vesselTypical && sideOk,
      camRows.map(r => `${r.kind}: state.task.std.${r.kind}=${r.board} ↔ 报文 ${r.key}=${r.wire}${r.same ? '（一致）' : '（**不一致**）'}`).join('；') +
      `；相机设定深度 ${camSetDepth} vs 航行器深度标准典型值 ${vesselTypical}` +
      `${camSetDepth === vesselTypical ? '（**相等：把相机设备参数当成了航行器深度标准**）' : '（已分开）'}` +
      `；同侧性（|设定深度−相机自身水下深度| ${Math.abs(camSetDepth - camOwnDepth)} < |设定深度−航行器实测深度| ${Math.abs(camSetDepth - vesselReal)}）=${sideOk}`
    );
  }

  /* ---- B2b. 相机侧设定值的**工具侧**对账（`E20`，2026-10-06 落地；本包新增） ----
     立案（`E20`）：B2 只比 `mockUpperSource` ↔ `mockData`，而相机侧设定值在仓库里**四处各有一份**：
       · `tools/mock-upper/mock-upper.js` 的 `std{Depth,Gain,Fps,Shutter}`（工具侧**运行期产出**）
       · `src/services/mockUpperSource.js` 的 `std{Depth,Gain,Fps,Shutter}`（前端内置模拟上位机）
       · `src/config/fieldMap.js` 的 `samplePayload.std*`（样例报文）
       · `tests/browser-check.js` 注入的"固定报文"夹具
     ⇒ 把**工具侧**的 `stdDepth` 改成 `5.00`（＝把"相机设定深度"当成"航行器深度标准"的量级，
     上游真犯过这一类错）此前**无人拦**：`tools-check` 只比字段键集合/存在性。
     本段的判据（两件事分开说，不互相代替）：
       ① **工具读数必须是运行期产出**：`tools/mock-upper/mock-upper.js` 是**独立进程** ⇒ 跑 `--once`，
          stdout 经 **fd 承接**（不用管道，适配受限沙箱）后 `JSON.parse` —— **不以 grep 源码文本当行为证据**；
       ② **四源 × 四值逐值对账**（基准＝`mockUpperSource.sample()`，即前端内置上位机的运行期帧）。
          `fieldMap.samplePayload` 与 `browser-check` 的夹具是**数据字面量/测试内注入帧**，
          源码读法就是它们的存在形态（本段并列给出，且**分别**断言，避免把两类证据混成一条）。
     可证伪（ADR-0004 D22，靶子在本段内、判据共用同一个纯函数 `cameraStdProblems()`）：
       把工具源码的 `stdDepth` 改成 `5.00`（**内存副本**写成临时文件、**以真进程跑** `--once`）
       ⇒ 判据**当场变红**并**指名** `tools/mock-upper/mock-upper.js`；临时副本用 `env.removeLinkSafe()` 回收，
       盘上原件逐字节未变。 */
  {
    const CAM_KINDS = ['depth', 'gain', 'fps', 'shutter'];
    const CAM_WIRE = { depth: 'stdDepth', gain: 'stdGain', fps: 'stdFps', shutter: 'stdShutter' };
    const TOOL_UPPER = path.join(ROOT, 'tools', 'mock-upper', 'mock-upper.js');
    const camSrc = UpperSource.sample();
    const camPayload = MAP.samplePayload;
    /** 跑一个**真进程**取一帧（`--once`，stdout 经 fd 承接 —— 与上面 `mockUpperCliFrame()` 同款做法） */
    function toolFrameOf(script, tag) {
      const outFile = path.join(os.tmpdir(), `contract-check-e20-${tag}-${process.pid}.json`);
      let fd;
      let err = '';
      try {
        fd = fs.openSync(outFile, 'w');
        execFileSync(process.execPath, [script, '--once'], { stdio: ['ignore', fd, 'ignore'] });
      } catch (e) {
        err = 'spawn: ' + String(e && (e.code || e.message));
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      let frame = null;
      try {
        if (!err) frame = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      } catch (e) {
        err = err || ('parse: ' + e.message);
      } finally {
        env.removeLinkSafe(outFile);
      }
      return { frame, err };
    }
    const toolRun = toolFrameOf(TOOL_UPPER, 'real');
    /* `browser-check` 的夹具（测试内注入帧）：源码里那**一行**字面量，锚点只取 ASCII */
    const bcCamMatch = readText('tests/browser-check.js')
      .match(/stdDepth:\s*([\d.]+),\s*stdGain:\s*([\d.]+),\s*stdFps:\s*([\d.]+),\s*stdShutter:\s*([\d.]+)/);
    const bcCam = bcCamMatch
      ? { stdDepth: Number(bcCamMatch[1]), stdGain: Number(bcCamMatch[2]),
        stdFps: Number(bcCamMatch[3]), stdShutter: Number(bcCamMatch[4]) }
      : null;
    const camRows = [
      { label: 'src/services/mockUpperSource.js（运行期 sample()）', get: k => camSrc[CAM_WIRE[k]], runtime: true },
      { label: 'tools/mock-upper/mock-upper.js（真进程 --once 产出）', get: k => toolRun.frame && toolRun.frame[CAM_WIRE[k]], runtime: true },
      { label: 'src/config/fieldMap.js 的 samplePayload', get: k => camPayload[CAM_WIRE[k]], runtime: false },
      { label: 'tests/browser-check.js 的固定报文夹具（源码）', get: k => bcCam && bcCam[CAM_WIRE[k]], runtime: false }
    ];
    /** 判据本体（纯函数）：以第一行为基准，逐源逐值比对；问题串里**点名来源** */
    function cameraStdProblems(rowsIn) {
      const base = rowsIn[0];
      const problems = [];
      for (const r of rowsIn.slice(1)) {
        for (const k of CAM_KINDS) {
          const a = base.get(k);
          const b = r.get(k);
          if (!(typeof a === 'number' && typeof b === 'number' && a === b)) {
            problems.push(`${r.label} 的 ${CAM_WIRE[k]}=${b} ≠ 基准 ${CAM_WIRE[k]}=${a}`);
          }
        }
      }
      return problems;
    }
    const camProblems = cameraStdProblems(camRows);
    const camTable = camRows.map(r => r.label + '：' + CAM_KINDS.map(k => `${CAM_WIRE[k]}=${r.get(k)}`).join('、')).join('；');
    check('E20 工具侧读数是**运行期产出**（真进程 `--once` 的 JSON 帧），不是源码 grep：' +
      '帧里四个相机侧设定值都是有限数值',
      Boolean(toolRun.frame) && CAM_KINDS.every(k => Number.isFinite(toolRun.frame[CAM_WIRE[k]])),
      `进程读数 err=${JSON.stringify(toolRun.err)}；stdDepth=${toolRun.frame && toolRun.frame.stdDepth}`);
    check('E20 相机侧设定值**四处对账**（工具运行期产出 ＋ `fieldMap.samplePayload` ＋ `browser-check` 夹具 ' +
      '↔ 基准 `mockUpperSource`）四值逐值一致 —— 工具侧改值即被拦（原先只有 B2 的"前端两处"对账）',
      camProblems.length === 0, camProblems.join('；') || camTable);
    /* D22：把工具源码的 stdDepth 改成 5.00（内存副本 → 临时文件 → **真进程**跑） */
    const CAM_ANCHOR = 'stdDepth: 12.50, stdGain: 2.5, stdFps: 400, stdShutter: 500,';
    const toolSrc = readText('tools/mock-upper/mock-upper.js');
    const camAnchorHits = toolSrc.split(CAM_ANCHOR).length - 1;
    let camMutProblems = null;
    if (camAnchorHits === 1) {
      const mutFile = path.join(os.tmpdir(), `contract-check-e20-mut-${process.pid}.js`);
      fs.writeFileSync(mutFile, toolSrc.replace(CAM_ANCHOR,
        'stdDepth: 5.00, stdGain: 2.5, stdFps: 400, stdShutter: 500,'), 'utf8');
      const mutRun = toolFrameOf(mutFile, 'mut');
      env.removeLinkSafe(mutFile);
      camMutProblems = cameraStdProblems(camRows.map((r, i) => (i === 1
        ? { label: r.label, get: k => mutRun.frame && mutRun.frame[CAM_WIRE[k]] } : r)));
    }
    check('E20 D22 可证伪：把工具侧 `stdDepth` 改成 `5.00`（源码**内存副本** → 临时文件 → **真进程**跑 `--once`；' +
      '盘上原件零字节改动）⇒ 本判据**必红**并**指名** `tools/mock-upper/mock-upper.js`（`stdDepth` 那一项）',
      camAnchorHits === 1 && Boolean(camMutProblems) && camMutProblems.length > 0
      && camMutProblems.some(p => p.includes('tools/mock-upper/mock-upper.js'))
      && camMutProblems.some(p => p.includes('stdDepth')),
      camAnchorHits !== 1 ? `锚点命中 ${camAnchorHits} 次（应恰 1）⇒ 判红，不许静默放过`
        : `变异后违规 ${camMutProblems.length} 条：${camMutProblems.join('；')}`);
    check('E20 D22 内存副本未落盘：`tools/mock-upper/mock-upper.js` 逐字节未变',
      readText('tools/mock-upper/mock-upper.js') === toolSrc, `${toolSrc.length} 字符相同`);
  }
  /* ---- B3. testStatus 口径（V1.37 / C-98）：附录 2 代码语义、上报反查表、显示模式四态 ----
     立案（2026-09-24 负责人裁定）：C-98 把 `testStatus` 的取值语义统一到**附录 2**
     （`0=待机`／`1=测试中`／`2=测试完成`／`3=设备异常`），并连带修正两处口径。本段把三件事
     钉成可证伪的断言（D1/D2 即裁定里的两条判定）：
       ① **D1（显示侧，FR-2.8）**：`upperToBoard['status.mode'].map` 的**输出**仍是看板的
          **显示模式四态**（0→待机／1→测试运行／2→正常停机／3→故障锁定）—— "代码语义＝测试完成"
          与"界面显示＝正常停机"**并存**，故这张表**不随附录 2 改名**（改错了，界面与 copy-check
          的运行模式文案会立刻对不上）。
       ② **D2（上报侧，IF-B.8 / FR-2.8）**：`modeToTestStatus` 反查表逐项对账，其中
          **「维保检修」是本次修正点** —— 原实现误写 `2`（在附录 2 语义下等于"上报：测试完成"，
          属**语义失真**），现按本机维保状态无上位机码、上报按 `0`（待机）取值。
       ③ 反查表的**键集**必须等于 FR-2.1 的五种运行模式（从界面组件实读，不写死）、
          **值域 ⊆ {0,1,2,3} 的整数**（附录 2 只有四态）；有码的四模式上，反查表必须与正查表一致。
     证据口径（D19）：下面把两张表的实际取值原样打印出来。 */
  section('B3. testStatus 口径（V1.37 / C-98：附录 2 代码语义 ↔ 显示模式 ↔ 上报反查表）');
  {
    /* D1 的期望值：**显示模式**四态（这一条判的就是"输出侧不许跟着代码语义改名"） */
    const EXPECT_MODE_MAP = { 0: '待机', 1: '测试运行', 2: '正常停机', 3: '故障锁定' };
    const modeSpec = MAP.upperToBoard['status.mode'];
    const modeMap = (modeSpec && modeSpec.map) || null;
    check('FR-2.8/D1 码语义（附录 2：2=测试完成）与显示模式（2=正常停机）并存：' +
      "upperToBoard['status.mode'].map 的输出仍是显示模式四态 0→待机／1→测试运行／2→正常停机／3→故障锁定",
      Boolean(modeMap) &&
      Object.keys(modeMap).length === Object.keys(EXPECT_MODE_MAP).length &&
      Object.entries(EXPECT_MODE_MAP).every(([code, name]) => modeMap[code] === name),
      `实际映射 ${JSON.stringify(modeMap)}；期望 ${JSON.stringify(EXPECT_MODE_MAP)}` +
      '（若把输出改成"测试完成"，界面显示与 copy-check 的运行模式文案会立刻对不上）'
    );

    /* 五模式清单：从界面组件**实读**（FR-2.1 的"5 种运行模式"就是状态面板图例里这五个），不写死 */
    const panelSrc = readText('src/components/DeviceStatusPanel.js');
    const legendModes = [...panelSrc.matchAll(/\{\s*name:\s*'([^']+)'\s*,\s*color:/g)].map(m => m[1]);
    const reverse = MAP.modeToTestStatus || null;
    /* D2 的逐项期望（**维保检修→0 单列点名**：本次修正点，失败时一眼可见） */
    const EXPECT_REVERSE = { '待机': 0, '测试运行': 1, '正常停机': 2, '维保检修': 0, '故障锁定': 3 };
    const reverseRows = Object.entries(EXPECT_REVERSE).map(([mode, code]) => ({
      mode, code, actual: reverse ? reverse[mode] : undefined
    }));
    const reverseBad = reverseRows.filter(r => r.actual !== r.code);
    check('FR-2.8/IF-B.8/D2 上报 MES 反查表 modeToTestStatus 逐项对账（附录 2 代码语义）：' +
      '待机→0／测试运行→1／正常停机→2／**维保检修→0（本次修正点：原误写 2 ＝ 上报"测试完成"）**／故障锁定→3',
      Boolean(reverse) && reverseBad.length === 0,
      reverseRows.map(r => `${r.mode}→${r.actual === undefined ? '（缺）' : r.actual}` +
        `${r.actual === r.code ? '' : `（应为 ${r.code}）`}`).join('／') +
      `；表实际取值 ${JSON.stringify(reverse)}`
    );
    check('FR-2.1/FR-2.8 反查表的键集 ＝ 状态面板图例的五种运行模式（不含未定义模式、也不漏模式），' +
      '且取值域 ⊆ {0,1,2,3} 的整数（附录 2 只有 待机/测试中/测试完成/设备异常 四态）',
      Boolean(reverse) && legendModes.length === 5 &&
      Object.keys(reverse).length === legendModes.length &&
      legendModes.every(m => Object.prototype.hasOwnProperty.call(reverse, m)) &&
      Object.values(reverse).every(v => Number.isInteger(v) && v >= 0 && v <= 3),
      `图例五模式＝[${legendModes.join('、')}]（从 DeviceStatusPanel.js 实读）；` +
      `反查表键＝[${reverse ? Object.keys(reverse).join('、') : '（无表）'}]；` +
      `值域＝[${reverse ? Object.values(reverse).join('、') : '—'}]`
    );
    /* 正查表 / 反查表在有码的四模式上必须双向一致（同一份口径的两个方向，各写一份必漂移） */
    const codedModes = Object.entries(modeMap || {}).map(([code, name]) => ({ code: Number(code), name }));
    const crossBad = codedModes.filter(m => !reverse || reverse[m.name] !== m.code);
    check('FR-2.8 正查表（码→显示模式）与反查表（显示模式→上报码）在有码的四模式上双向一致' +
      '（「维保检修」在附录 2 里无对应码 ⇒ 只出现在反查表，其上报码由上面那条单独点名）',
      codedModes.length === 4 && crossBad.length === 0,
      codedModes.map(m => `${m.code}→${m.name}→上报 ${reverse ? reverse[m.name] : '（缺表）'}`).join('；') +
      (crossBad.length ? `；**不一致**：${crossBad.map(m => m.name).join('、')}` : '')
    );
  }

  /* ===== C. IF-D 行为：applyUpperPayload / 冻结判定 / 配置化（6.3～6.6） ===== */
  section('C. IF-D 适配层行为（tests/README 6.3～6.6）');
  const state = cloneState();
  const okFrame = Api.applyUpperPayload(state, MAP.samplePayload, new Date());
  check(
    '完整报文：全部映射字段都被应用、无缺失',
    okFrame.applied === mapKeys.length && okFrame.missing.length === 0,
    `applied=${okFrame.applied}/${mapKeys.length}，missing=${JSON.stringify(okFrame.missing)}`
  );

  const state2 = cloneState();
  state2.task.real.depth = 42.42;
  const partial = Object.assign({}, MAP.samplePayload);
  delete partial.depth;
  const r2 = Api.applyUpperPayload(state2, partial, new Date());
  check(
    '缺字段容错：depth 缺失时保留原值不清零（6.3）',
    state2.task.real.depth === 42.42 && r2.missing.includes('depth'),
    `depth=${state2.task.real.depth}，missing=${JSON.stringify(r2.missing)}`
  );

  const state3 = cloneState();
  state3.task.real.depth = 43.43;
  const badType = Object.assign({}, MAP.samplePayload, { depth: 'abc' });
  const r3 = Api.applyUpperPayload(state3, badType, new Date());
  check(
    '非数值入参：depth="abc" 时保留原值并计入缺失',
    state3.task.real.depth === 43.43 && r3.missing.includes('depth'),
    `depth=${state3.task.real.depth}，missing=${JSON.stringify(r3.missing)}`
  );

  const staleSaved = CFG.upper.staleMs;
  CFG.upper.staleMs = 500;
  const t0 = new Date('2026-09-18T15:10:27');
  Api.applyUpperPayload(cloneState(), MAP.samplePayload, t0);
  check(
    '数据冻结判定：超过 staleMs 判为过期（6.4）',
    Api.isUpperStale(new Date(t0.getTime() + 600)) === true,
    `staleMs=${CFG.upper.staleMs}`
  );
  check(
    '数据冻结判定：未超时判为新鲜（6.4）',
    Api.isUpperStale(new Date(t0.getTime() + 100)) === false
  );
  CFG.upper.staleMs = staleSaved;

  const depthSpecSaved = MAP.upperToBoard['task.real.depth'];
  MAP.upperToBoard['task.real.depth'] = { key: 'depthX', digits: 2 };
  const state4 = cloneState();
  const r4 = Api.applyUpperPayload(state4, { depthX: 7.5 }, new Date());
  check(
    '字段映射可配置：改 fieldMap 的 key 后按新字段名取值（6.6）',
    state4.task.real.depth === 7.5 && r4.applied === 1,
    `task.real.depth=${state4.task.real.depth}`
  );
  MAP.upperToBoard['task.real.depth'] = depthSpecSaved;

  const planSaved = CFG.production.planQty;
  CFG.production.planQty = 250;
  check(
    '配置生效：改 board.config 的 planQty 后报文随之变化（6.5）',
    UpperSource.sample().planQty === 250,
    `planQty=${UpperSource.sample().planQty}`
  );
  CFG.production.planQty = planSaved;

  /* ===== D. IF-B 行为：上报报文 / 回执风格 / 失败补传（6.8～6.10） ===== */
  section('D. IF-B 上报与补传（tests/README 6.8～6.10）');
  const upTime = new Date('2026-09-18T15:10:27');
  const report = Api.buildReportPayload(cloneState(), upTime);
  const reportFields = Object.keys(report);
  check(
    '上报报文含附录 2 全部 13 个字段',
    reportFields.length === 13 && APPENDIX2.every(k => reportFields.includes(k)),
    diffSets(reportFields, APPENDIX2)
  );
  check(
    'uploadId 形如 UP + yyyyMMddHHmmss + 3 位序号',
    /^UP\d{17}$/.test(String(report.uploadId)),
    `uploadId=${report.uploadId}`
  );
  check(
    'collectTime 格式为 yyyy-MM-dd HH:mm:ss',
    report.collectTime === '2026-09-18 15:10:27',
    `collectTime=${report.collectTime}`
  );
  check(
    'testStatus 为整数状态码（附录 2 定义 0～3）',
    Number.isInteger(report.testStatus) && report.testStatus >= 0 && report.testStatus <= 3,
    `testStatus=${JSON.stringify(report.testStatus)}`
  );

  /* `E100`②（2026-10-03）：端口由 `allocPort()` 现取（改前写死 18899／18898／18897）。
     先取满三个**互不相同**的空闲端口、再起服务 —— 把"取号→绑定"的窗口压到最短，
     降低与另一路并发门禁抢号的可能。 */
  const [portStatus, portCode, portFail] = await allocDistinctPorts(3);
  const started = await Promise.all([
    startMockMes({ port: portStatus, receipt: 'status', failRate: 0 }),
    startMockMes({ port: portCode, receipt: 'code', failRate: 0 }),
    startMockMes({ port: portFail, receipt: 'status', failRate: 1 })
  ]);
  if (!started.every(Boolean)) {
    skip('IF-B 回执与补传联调（6.8～6.10）',
      `本机回环端口 ${portStatus}／${portCode}／${portFail} 未能全部监听（端口是现取的，非写死）`);
  } else {
    CFG.mes.baseUrl = `http://127.0.0.1:${portStatus}`;
    CFG.mes.responseStyle = 'status';
    const up1 = await Api.uploadReport(report);
    check('回执风格 status：{status:1} 判定为成功（6.8）', up1.ok === true, JSON.stringify(up1.receipt));

    const log = await (await fetch(`http://127.0.0.1:${portStatus}/log`)).json();
    const last = log.items[log.items.length - 1];
    const loggedFields = Object.keys(last.payload);
    check(
      '假 MES 侧收到的报文同样是 13 个字段（6.8）',
      loggedFields.length === 13 && APPENDIX2.every(k => loggedFields.includes(k)),
      diffSets(loggedFields, APPENDIX2)
    );

    CFG.mes.baseUrl = `http://127.0.0.1:${portCode}`;
    CFG.mes.responseStyle = 'code';
    const up2 = await Api.uploadReport(report);
    check('回执风格 code：{code:200} 判定为成功（6.9）', up2.ok === true, JSON.stringify(up2.receipt));

    const beforePending = Api.getStatus().pendingCount;
    CFG.mes.baseUrl = `http://127.0.0.1:${portFail}`;
    CFG.mes.responseStyle = 'status';
    const up3 = await Api.uploadReport(report);
    const afterPending = Api.getStatus().pendingCount;
    check(
      '异常回执：判为失败并进入待补传队列（6.10 前半）',
      up3.ok === false && afterPending === beforePending + 1,
      `ok=${up3.ok}，pending ${beforePending} → ${afterPending}`
    );
    /* `E33②`（★，`T-20261005-17`）：下面"告警位当场重算"那一臂**必须与真源阈值同量级** ——
       原写法把容量写死成 `1`、再期望 `capacity === 1` 且 `queueAlert === true`，只在
       "**真源阈值恰好是 1**"时成立（`src\config\board.config.js` 的 `mes.queueWarnThreshold`
       一旦长期改成 ≥2，这条会**静默失配** —— `E156` 同族：手写的数会一直错下去）。
       ⇒ 待补传条数**按真源阈值配足**（此刻链路仍指向 `portFail` ⇒ 每次上报都失败入队；
         用**不同 uploadId** 免得前端按 id 去重把条数吃掉），后面所有期望值一律由 `thrD` 推导、
         **不再出现字面量 1**。⚠ 配足必须发生在上面那条"`pending + 1`"的对账**之后**（否则会改掉它的入参）。 */
    const thrD = CFG.mes.queueWarnThreshold;      // 真源（浏览器侧；与 board.config.js 的同源由 R26-P3-4 ① 对账）
    const pendAtInject = Api.getStatus().pendingCount;
    for (let i = pendAtInject; i < thrD; i++) {
      await Api.uploadReport(Object.assign({}, report, { uploadId: 'UP' + String(20260918151027000 + i) }));
    }

    /* 6.10 后半（V1.31 语义，C-58～C-62）：上报失败**不做任何自动重发**（IF-B.9 / NFR-10 / NFR-13）。
       失败只做两件事：①告警/暴露待补传条数；②报文本地持久化留存（浏览器侧为内存队列，
       落库在 server/services/uploadQueue.js）。重报**完全由人工触发**（UI-20，尚未实现）。
       故原「链路恢复后 flushPending 补齐队列」一条拆成两条：
         (a) flushPending() 只刷新状态、不发送；
         (b) 唯一会主动发送的是人工入口 retryPending()。
       待补传场景由上面 up3 的失败直接构造（失败报文已被压进队列），
       不再依赖已按 ADR-0005 删除的 CFG.mes.retry 键（见 src/config/board.config.js）。 */
    CFG.mes.baseUrl = `http://127.0.0.1:${portStatus}`;   // 链路"恢复"：若还在自动重发，这里就会把队列发空
    const queueCapSaved = CFG.mes.queueCap;
    /* 临时把容量收窄到**真源阈值 `thrD`**（不再写死 `1`）：待补传已配足到 `≥ thrD` 条 ⇒
       告警位必须**当场重算**为 true。否则"状态/告警字段确实被刷新"就无从证明（写死的 false 也会通过）。
       `E33②`：收窄值与下面那条断言的期望值**全部由 `thrD` 推导** ⇒ 真源改成 ≥2 时照样成立。 */
    CFG.mes.queueCap = thrD;
    const flushLogBefore = (await (await fetch(`http://127.0.0.1:${portStatus}/log`)).json()).items.length;
    const pendBeforeFlush = Api.getStatus().pendingCount;
    const flushed = await Api.flushPending();
    const pendAfterFlush = Api.getStatus().pendingCount;
    const statusAfterFlush = Api.getStatus();   // 仍在校窄容量下取，供与 flushPending 的回报逐字比对
    CFG.mes.queueCap = queueCapSaved;           // 立即还原，后面的人工重报仍用原容量
    const flushLogAfter = (await (await fetch(`http://127.0.0.1:${portStatus}/log`)).json()).items.length;
    check(
      '只刷新不发送：flushPending 重算并暴露待补传状态与告警，但不发任何报文、队列条数不变（6.10 后半 · IF-B.9 V1.31）',
      flushed.sent === 0 && flushed.failed === 0 &&
      pendAfterFlush === pendBeforeFlush &&
      flushLogAfter === flushLogBefore &&
      flushed.pendingCount === pendAfterFlush && flushed.left === pendAfterFlush &&
      flushed.remaining === pendAfterFlush &&
      flushed.capacity === statusAfterFlush.pendingCapacity && flushed.capacity === thrD &&
      flushed.queueAlert === true && flushed.queueAlert === statusAfterFlush.queueAlert &&
      flushed.queueFull === true && flushed.queueFull === statusAfterFlush.queueFull,
      `sent=${flushed.sent} failed=${flushed.failed}；待补传 ${pendBeforeFlush} → ${pendAfterFlush}；` +
      `假 MES 收件数 ${flushLogBefore} → ${flushLogAfter}（不变即未发送）；` +
      `回报 pendingCount=${flushed.pendingCount} capacity=${flushed.capacity} queueAlert=${flushed.queueAlert} queueFull=${flushed.queueFull}`
    );
    /* (b) 人工入口才发送：retryPending() 是**唯一**会主动重发补传报文的函数（供 UI-20 调用）。
           先让链路仍不通 —— 失败条目必须留在队列且有"已试次数"累加；再让链路恢复 —— 成功条目必须移出队列。 */
    const beforeRetry = Api.listPending().items[0];
    CFG.mes.baseUrl = `http://127.0.0.1:${portFail}`;
    const retryStillFail = await Api.retryPending({ limit: 1 });
    const keptItem = Api.listPending().items[0];
    const pendAfterRetryFail = Api.getStatus().pendingCount;
    CFG.mes.baseUrl = `http://127.0.0.1:${portStatus}`;
    const retryThenOk = await Api.retryPending();
    const pendAfterRetryOk = Api.getStatus().pendingCount;
    check(
      '人工入口才发送：retryPending 重报后仍失败者保留且次数累加、成功者移出队列（6.10 后半 · IF-B.9 V1.31）',
      beforeRetry !== undefined &&
      retryStillFail.sent === 0 && retryStillFail.failed === 1 &&
      retryStillFail.remaining === pendAfterFlush && pendAfterRetryFail === pendAfterFlush &&
      keptItem !== undefined && keptItem.uploadId === beforeRetry.uploadId &&
      keptItem.tries === beforeRetry.tries + 1 &&
      retryThenOk.sent === pendAfterRetryFail && retryThenOk.failed === 0 && pendAfterRetryOk === 0,
      `人工重报（链路未恢复）sent=${retryStillFail.sent} failed=${retryStillFail.failed}，` +
      `tries ${beforeRetry && beforeRetry.tries} → ${keptItem && keptItem.tries}，队列仍 ${pendAfterRetryFail} 条；` +
      `人工重报（链路恢复）sent=${retryThenOk.sent}，队列 ${pendAfterRetryFail} → ${pendAfterRetryOk} 条`
    );
    /* `E33②-D22`（**真源内存变异 ＋ 负对照**，不落盘任何文件）：把真源阈值在内存里改成 `thrD + 1` ⇒
       同一条"容量收窄到阈值 ⇒ `flushPending` 把告警位重算为 true"**仍然成立**（＝"期望值从真源推导"的可证伪面）；
       再给**负对照**：阈值抬到 `thrD + 2`（待补传只有 `thrD + 1` 条）⇒ 告警位**必须为 false**
       —— 这一臂证明判据**真的在读阈值**，不是恒真（`D23`）。
       ⚠ 位置：放在"人工入口才发送"那条**之后** —— 它要往队列里补件，若插在前面会改掉那条的入参
         （实测：插在前面时 `retryStillFail.remaining === pendAfterFlush` 立刻变红）；末尾再把队列**排空**，
         让本段结束态与改动前一致。 */
    const thrSavedD = CFG.mes.queueWarnThreshold;
    const capSavedD = CFG.mes.queueCap;
    CFG.mes.queueWarnThreshold = thrD + 1;
    CFG.mes.baseUrl = `http://127.0.0.1:${portFail}`;
    const pendNowD = Api.getStatus().pendingCount;
    for (let i = pendNowD; i < thrD + 1; i++) {
      await Api.uploadReport(Object.assign({}, report, { uploadId: 'UP' + String(20260918151028000 + i) }));
    }
    CFG.mes.queueCap = thrD + 1;
    const flushAltD = await Api.flushPending();
    CFG.mes.baseUrl = `http://127.0.0.1:${portStatus}`;
    CFG.mes.queueWarnThreshold = thrD + 2;        // 负对照：阈值高于待补传条数 ⇒ 不得告警
    const alertLowD = Api.getStatus().queueAlert;
    const pendAltD = Api.getStatus().pendingCount;
    const capAltD = Api.getStatus().pendingCapacity;
    CFG.mes.queueWarnThreshold = thrSavedD;       // 立即还原（后续段仍按真源跑）
    CFG.mes.queueCap = capSavedD;
    const drainD = await Api.retryPending();      // 收尾：把 D22 造的补传件发走，队列回到"空"（与改动前本段结束态一致）
    check('E33②-D22（**真源内存变异 ＋ 负对照**）：把真源阈值在内存里改成 `thrD + 1` 后，同一条'
      + '「容量收窄到阈值 ⇒ `flushPending` 当场把告警位重算为 true」**仍然成立**；'
      + '再把阈值抬到 `thrD + 2` ⇒ 同一 `pending` 下告警位**必须为 false**（证明判据真在读阈值、不是恒真）',
      flushAltD.sent === 0 && flushAltD.failed === 0 && flushAltD.capacity === thrD + 1
        && flushAltD.queueAlert === true && flushAltD.pendingCount >= thrD + 1
        && alertLowD === false && pendAltD >= thrD + 1 && capAltD === thrD + 1
        && CFG.mes.queueWarnThreshold === thrSavedD && CFG.mes.queueCap === capSavedD
        && Api.getStatus().pendingCount === 0,
      `变异后（真源 ${thrD + 1}）flushPending：capacity=${flushAltD.capacity}（应 ${thrD + 1}）、`
        + `queueAlert=${flushAltD.queueAlert}（应 true）、pending=${flushAltD.pendingCount}、sent=${flushAltD.sent}；`
        + `负对照（阈值抬到 ${thrD + 2}、pending ${pendAltD}）⇒ queueAlert=${alertLowD}（应 **false**）、capacity=${capAltD}；`
        + `真源／容量已还原=${CFG.mes.queueWarnThreshold}/${CFG.mes.queueCap}；收尾排空 sent=${drainD.sent}、队列剩 ${Api.getStatus().pendingCount} 条`);
  }

  /* ===== E. ?source=upper 链路：内置模拟上位机的取帧顺序（6.2） ===== */
  section('E. ?source=upper 端到端链路（tests/README 6.2）');
  /* services/api.js 的 startUpper() 必须按 mockUpperSource 声明的契约取帧：
       const frame = window.MockUpperSource.next(inner);  inner = frame.inner;  const payload = frame.payload;
     三者缺一不可，否则第二帧起内部状态被写坏（审查报告 P1-1①）。 */
  const numericFields = ['depth', 'speed', 'velocity_x', 'velocity_y', 'frameRate', 'gain',
                         'shutter', 'cameraDepth', 'progress', 'unitIndex'];
  const apiSrc = readText('src/services/api.js');
  const mainSrc = readText('src/main.js');
  check('取帧链：api.js 传上一帧 inner 并用返回值里的 inner 递推',
    /MockUpperSource\.next\(\s*inner\s*\)/.test(apiSrc) && /inner\s*=\s*frame\.inner/.test(apiSrc),
    'api.js 未按"传 inner、取 frame.inner"递推，第二帧起数值会变 NaN');
  check('数据源互斥：upper 模式不得再跑 mockData.tick()',
    /if\s*\(\s*sourceKind\s*===\s*'none'\s*\)\s*M\.tick\(/.test(mainSrc),
    'main.js 仍无条件 tick，报文数据会被模拟数据每秒覆盖（P1-1②）');

  let inner = null;
  const frames = [];
  for (let i = 0; i < 3; i++) {
    const frame = UpperSource.next(inner);
    inner = frame.inner;
    frames.push(frame.payload);
  }
  const nanOnFrame2 = numericFields.filter(k => Number.isNaN(frames[1][k]));
  check(
    '按 api.js 的调用方式连续取 3 帧：数值字段不出现 NaN',
    nanOnFrame2.length === 0,
    `第 2 帧 NaN 字段：${nanOnFrame2.join(', ') || '（无）'}；stage=${frames[1].stage} testStatus=${frames[1].testStatus}`
  );
  check(
    '按 api.js 的调用方式连续取 3 帧：运行阶段不跳变到"完成"',
    frames[1].stage === frames[0].stage || frames[1].stage === '运行',
    `第 1 帧 stage=${frames[0].stage}，第 2 帧 stage=${frames[1].stage}`
  );

  const state5 = cloneState();
  let inner5 = null;
  let lastFrame = null;
  let lastApply = null;
  for (let i = 0; i < 3; i++) {
    lastFrame = UpperSource.next(inner5);
    inner5 = lastFrame.inner;
    lastApply = Api.applyUpperPayload(state5, lastFrame.payload, new Date());
  }
  check(
    '经适配层后：数值保持逐帧更新（不因 NaN 被当成缺字段而冻结）',
    state5.task.real.depth === lastFrame.payload.depth,
    `state.depth=${state5.task.real.depth}，报文 depth=${lastFrame.payload.depth}，被丢弃字段数=${lastApply.missing.length}`
  );
  check(
    '经适配层后：运行模式不被写成非法值',
    typeof state5.status.mode === 'string' && !Number.isNaN(state5.status.mode),
    `status.mode=${JSON.stringify(state5.status.mode)}`
  );

  /* ===== F. IF-D 降级接线：数据冻结后界面判据是否跟随（IF-D.9 / FR-2.6） ===== */
  section('F. IF-D 降级接线（IF-D.9 / FR-2.6）');
  {
    const h = createIsolatedHarness({});
    h.window.BoardConfig.dataSource = 'upper';   // 降级同步只在 upper 模式生效（mock 模式的 device.link 由演示键 D 控制）
    const st = h.window.MockData.state;
    h.window.Api.applyUpperPayload(st, h.window.FieldMap.samplePayload, h.__at('2026-09-18T15:10:27'));
    const fresh = h.window.Api.syncLinkState(st, h.__at('2026-09-18T15:10:28'));
    check('数据新鲜时链路判据为在线', fresh === 'online', `syncLinkState=${fresh} state.device.link=${st.device.link}`);
    const stale = h.window.Api.isUpperStale(h.__at('2026-09-18T15:10:40'));   // 13 s 无新数据（staleMs=5000）
    check('前置条件：适配层能判定数据已冻结', stale === true);
    const offline = h.window.Api.syncLinkState(st, h.__at('2026-09-18T15:10:40'));
    check(
      '数据冻结时界面判据 state.device.link 转为断连',
      offline === 'offline' && st.device.link === 'offline',
      `isUpperStale=${stale}，syncLinkState=${offline}，state.device.link=${JSON.stringify(st.device.link)}`
    );
    check(
      '接线：main.js 每帧调用 Api.syncLinkState（否则降级不会生效）',
      /Api\.syncLinkState\s*\(/.test(readText('src/main.js')),
      'src/main.js 未调用 syncLinkState，数据冻结不会触发界面降级'
    );
    check(
      '接线：main.js 周期调用 Api.flushPending 刷新待补传状态与告警（存在性断言；IF-B.9 V1.31）',
      /Api\.flushPending\s*\(/.test(readText('src/main.js')),
      'src/main.js 未调用 flushPending，待补传条数与队列告警不会周期刷新。' +
      'V1.31 口径：flushPending 只刷新待补传状态与告警；发送由人工触发（IF-B.9 V1.31，唯一发送入口为 retryPending）。' +
      '本断言只查"周期刷新仍被接线"，**不要求** retryPending 在 UI 侧已有调用点 —— 人工重报入口属 UI-20，尚未实现（见"需上层决策"）'
    );
    check(
      'Api.getStatus() 的结果应被界面消费',
      /getStatus\s*\(/.test(readText('src/main.js')) || /getStatus\s*\(/.test(readText('src/pages/Dashboard.js')) ||
      /getStatus\s*\(/.test(readText('src/services/mockData.js')),
      'src 内除 api.js 自身外没有调用方，"数据冻结/待补传"状态无法呈现'
    );
  }

  /* ===== G. 派生统计量的收敛与累计一致性 ===== */
  section('G. 派生统计量的收敛与累计一致性');
  {
    const h = createIsolatedHarness({});
    h.window.MockData.tick(h.__at('2026-09-18T15:59:59'));
    const s = h.window.MockData.state.stats;
    check(
      '当班统计：未开始件数不得为负（默认 planQty=180，班末）',
      s.notStarted >= 0,
      `plan=${s.plan} started=${s.started} notStarted=${s.notStarted}（StatsPanel 的 sNotStarted 直接展示该值）`
    );
  }
  {
    const h = createIsolatedHarness({ planQty: 100 });
    h.window.MockData.tick(h.__at('2026-09-18T14:00:00'));
    const s = h.window.MockData.state.stats;
    check(
      '当班统计：未开始件数不得为负（改 planQty=100 后，tests 6.5 场景）',
      s.notStarted >= 0,
      `plan=${s.plan} started=${s.started} notStarted=${s.notStarted}`
    );
  }
  {
    const h = createIsolatedHarness({});
    h.window.MockData.tick(h.__at('2026-09-18T07:59:00'));
    const before = {
      today: h.window.MockData.state.maint.todayRun,
      month: h.window.MockData.state.maint.monthRun,
      year: h.window.MockData.state.maint.yearRun
    };
    h.window.MockData.tick(h.__at('2026-09-18T08:01:00'));
    const after = {
      today: h.window.MockData.state.maint.todayRun,
      month: h.window.MockData.state.maint.monthRun,
      year: h.window.MockData.state.maint.yearRun
    };
    check('维保累计：本月累计运行不得在交班时变小', after.month >= before.month,
      `07:59 month=${fmtNum(before.month)}s → 08:01 month=${fmtNum(after.month)}s`);
    check('维保累计：本年累计运行不得在交班时变小', after.year >= before.year,
      `07:59 year=${fmtNum(before.year)}s → 08:01 year=${fmtNum(after.year)}s`);
    check('维保累计：同一自然日内"当日累计运行"不得因交班归零', after.today >= before.today,
      `07:59 today=${fmtNum(before.today)}s → 08:01 today=${fmtNum(after.today)}s`);
  }
  {
    const h = createIsolatedHarness({});
    const seen = new Set();
    for (const t of ['2026-09-18T09:00:00', '2026-09-18T09:05:00', '2026-09-18T09:10:00']) {
      h.window.MockData.tick(h.__at(t));
      seen.add(h.window.MockData.state.alarm.active.state);
    }
    check(
      '前置条件：alarm.active.state 的实际取值（行为证据）',
      [...seen].every(v => v !== '已闭环'),
      `实际取值=${[...seen].join(' / ')}`
    );
    check(
      '待办"未闭环异常"的判据不得比较一个永不出现的状态值',
      !/alarm\.active\.state\s*===\s*'已闭环'/.test(readText('src/services/mockData.js')),
      'mockData.js 中仍是 alarm.active.state === \'已闭环\'，而该状态只可能是 未处理/处理中 → 计数恒为 1、永不闭环'
    );
  }
  {
    /* `E100`②（2026-10-03）：端口由 `allocPort()` 现取（改前写死 18896）。 */
    const portSelfCheck = await harness.allocPort();
    const ok = await startMockMes({ port: portSelfCheck, receipt: 'status', failRate: 1 });
    if (!ok) {
      skip('自检项与待补传队列/回执风格的一致性',
        `本机回环端口 ${portSelfCheck} 未能监听（端口是现取的，非写死）`);
    } else {
      const h = createIsolatedHarness({});
      h.window.BoardConfig.mes.baseUrl = `http://127.0.0.1:${portSelfCheck}`;
      h.window.BoardConfig.mes.responseStyle = 'status';
      const payload = h.window.Api.buildReportPayload(h.window.MockData.state, h.__at('2026-09-18T15:10:27'));
      const r = await h.window.Api.uploadReport(payload);
      const pending = h.window.Api.getStatus().pendingCount;
      check('前置条件：异常回执进入待补传队列', r.ok === false && pending === 1, `ok=${r.ok}，pendingCount=${pending}`);

      h.window.MockData.tick(h.__at('2026-09-18T15:10:30'));   // 重建 selfCheck
      const queueItem = h.window.MockData.state.selfCheck.find(c => c.name.includes('上报队列'));
      check(
        '自检「MES 上报队列」应与实际待补传条数一致',
        String(queueItem.state).includes(String(pending)) && pending !== 0,
        `界面显示「${queueItem.state}」，实际 pendingCount=${pending}`
      );
      const mesItem = h.window.MockData.state.selfCheck.find(c => c.name.includes('MES 接口'));
      const claimed = /code=\d+/.test(mesItem.state) ? 'code' : (/status=\d+/.test(mesItem.state) ? 'status' : null);
      check(
        '自检文案的回执风格应与 board.config.mes.responseStyle 一致',
        claimed === h.window.BoardConfig.mes.responseStyle,
        `文案「${mesItem.state}」→ ${claimed}，配置 responseStyle=${h.window.BoardConfig.mes.responseStyle}`
      );
    }
  }

  /* ===== H. 界面渲染安全：用户输入是否原样拼进 HTML（FR-7.12 / FR-6.11） ===== */
  section('H. 界面渲染安全（用户输入路径）');
  {
    const evil = '<img src=x onerror="alert(1)">';
    const noticeCap = [];
    const wn = createComponentHarness(['src/components/NoticePanel.js'], makeFakeDom(noticeCap));
    wn.Components.NoticePanel.render({
      notices: { notices: [{ tag: '车间公示', text: evil, time: '10:00', lv: 'info' }], tips: [], todo: [] }
    });
    check(
      '公告正文（用户输入）不得原样写入 HTML',
      !noticeCap.join('\n').includes('<img'),
      'NoticePanel.render 把 state.notices.notices[].text 直接拼进 setHTML → 解锁后填入 HTML 即执行'
    );

    const maintCap = [];
    const wm = createComponentHarness(['src/components/MaintPanel.js'], makeFakeDom(maintCap));
    wm.Components.MaintPanel.render({
      maint: {
        last: '2026-08-28', next: '2026-09-27', cycle: 30, daysLeft: 9,
        todayRun: 0, monthRun: 0, yearRun: 0,
        records: [{ time: '2026-09-18 09:00', content: evil, owner: evil, state: '已验收' }]
      }
    });
    check(
      '检修内容/负责人（用户输入）不得原样写入 HTML',
      !maintCap.join('\n').includes('<img'),
      'MaintPanel.render 把 state.maint.records[].content / .owner 直接拼进 tbody.innerHTML'
    );
  }

  /* ===== I. 交付物 .docx 的 ZIP/OPC 结构 ===== */
  section('I. 交付物 .docx 的 ZIP/OPC 结构');
  {
    const docs = walkFiles(path.join(ROOT, '输出文件'), '.docx');
    if (!docs.length) {
      skip('交付 .docx 条目名结构', '输出文件/ 下没有 .docx');
    } else {
      const backslash = [];
      const noContentTypes = [];
      for (const f of docs) {
        const names = zipEntryNames(f);
        if (names.some(n => n.includes('\\'))) backslash.push(path.relative(ROOT, f));
        if (!names.includes('[Content_Types].xml')) noContentTypes.push(path.relative(ROOT, f));
      }
      const sample = zipEntryNames(docs[0]).slice(0, 4).join(' , ');
      check(
        'docx 部件名应使用正斜杠（OPC 规范）',
        backslash.length === 0,
        `${backslash.length}/${docs.length} 个文件用了反斜杠，例如 ${path.relative(ROOT, docs[0])} 的条目：${sample}`
      );
      check('docx 应包含 [Content_Types].xml', noContentTypes.length === 0, noContentTypes.join('；'));
    }
  }

  /* ===== J. 文档与源码的版本号 / 附录 2 项数一致性 ===== */
  section('J. 文档与源码的版本、项数一致性');
  {
    const base = baselineRequirementVersion();
    check('能定位需求文档当前基线版本', base !== null, '需求文档/ 下没找到 -Vx.y.md');
    if (base) {
      const offenders = [];
      const versionSources = [
        ...walkFiles(path.join(ROOT, 'src'), '.js'),
        ...walkFiles(path.join(ROOT, 'src'), '.css')   // 样式表头部同样会引用需求清单版本
      ];
      for (const f of versionSources) {
        const head = fs.readFileSync(f, 'utf8').split('\n').slice(0, 25).join('\n');
        for (const m of head.matchAll(/需求清单\s*V(\d+\.\d+)/g)) {
          if (m[1] !== base.raw) offenders.push(`${path.relative(ROOT, f)} 写 V${m[1]}`);
        }
      }
      check(
        `源码/样式头部引用的需求清单版本应等于基线 V${base.raw}`,
        offenders.length === 0,
        offenders.join('；')
      );

      const lines = readText('需求文档/' + base.file).split('\n');
      const { declared, rows } = appendix2FieldRows(lines);
      check(
        '需求清单「附录 2 共 N 项」的声明与字段表行数应一致',
        declared !== null && declared === rows.length,
        `声明「共 ${declared} 项」，字段表实际 ${rows.length} 行`
      );
      check(
        '需求清单附录 2 字段表应等于 fieldMap 的 13 个上报字段',
        rows.length === APPENDIX2.length,
        `字段表 ${rows.length} 行，fieldMap.boardToReport ${APPENDIX2.length} 个`
      );
      /* 防回潮（V1.28 / C-52）：V1.27 只改了附录 2 表头的项数，正文仍写"12 个字段"，
         与字段表、IF-C.1、fieldMap 三方不一致。此处只扫「N 个字段」这种带量词的写法，
         并按行号排除「变更记录」章（历史条目里的旧数字属史实，保留原样）。 */
      if (rows.length > 0) {
        const changeLogFrom = lines.findIndex(l => /^###\s*V[\d.]+ → V[\d.]+/.test(l.trim()));
        const mismatched = [];
        lines.forEach((l, i) => {
          if (changeLogFrom >= 0 && i >= changeLogFrom) return;
          for (const m of l.matchAll(/(\d+)\s*个字段/g)) {
            if (Number(m[1]) !== rows.length) {
              mismatched.push(`第 ${i + 1} 行写「${m[1]} 个字段」`);
            }
          }
        });
        check(
          `需求清单正文「N 个字段」的声明应与附录 2 字段表一致（均为 ${rows.length}）`,
          mismatched.length === 0,
          mismatched.join('；')
        );
      }
    }
  }

  /* ===== K. 现状快照（非缺陷）：口径占位项，变了就提醒重新确认 ===== */
  section('K. 现状快照（非缺陷，变更即提醒）');
  {
    const h = createIsolatedHarness({});
    const oee = [];
    for (const t of ['2026-09-18T10:00:00', '2026-09-18T12:00:00']) {
      h.window.MockData.tick(h.__at(t));
      oee.push(h.window.MockData.state.stats.oee);
    }
    const expect = h.window.BoardConfig.production.runRate * 100;
    /* ⚠ 语义修正（评审 A-2026-09-20-01 P2-4 / ADR-0005 第三节建议第 3 条）：
       这条是**演示占位口径**，**不是验收判据** —— 它钉的是"前端演示值直接等于配置里的
       有效运行占比 runRate"，而不是 FR-4.15 的真实口径（真实口径应为 有效运行时长 / 班次进度，
       见 server/services/stats.js 的 oee = pct(runSec, elapsedSec)）。
       演示之所以成立：mockData.computeStats 里 runSec = elapsed * runRate，所以
       runSec / elapsed 恒等于 runRate —— 这是同一份演示取值换了个写法，不能当业务判据。
       保留它的唯一目的：Q-11 答复到达、口径改为真实实现后，这条会立刻变红，提醒同步本段
       与界面说明；真正的跨实现口径判据在 M 段。 */
    check(
      '稼动率仍由配置常量推导（**演示占位口径，非验收判据**；口径变更即提醒）',
      oee.every(v => Math.abs(v - expect) < 1e-9),
      `实测 oee=${oee.join(' / ')}%，runRate*100=${expect}%（现值来自 mockData 的 runSec=elapsed*runRate，` +
      '属演示占位口径；Q-11 答复到达后按真实口径 u=有效运行/班次进度 改写本段与界面说明，真实口径判据见 M 段）'
    );
    /* P3-12 修复后：当班异常台账不再是固定 5 条——自动闭环的报警会转入台账（保留上限 8 条）。
       本项由"固定 5 条"快照改为"确实接收新闭环报警"的行为断言。 */
    const h2 = createIsolatedHarness({});
    h2.window.MockData.tick(h2.__at('2026-09-18T10:00:00'));   // 首帧：5 条演示台账 + 当前 1 条未闭环报警
    const first = h2.window.MockData.state.alarm.ledger.length;
    h2.window.MockData.tick(h2.__at('2026-09-18T10:03:00'));   // 180 s 后：该报警自动闭环并转入台账
    const after = h2.window.MockData.state.alarm.ledger.length;
    check(
      '当班异常台账接收新闭环报警（不再固定 5 条，上限 8 条）',
      first === 5 && after > first && after <= 8,
      `首帧 ${first} 条 → 3 分钟后 ${after} 条（闭环报警应入账，且不超过 8 条）`
    );
  }

  /* ===== L. 常量集中化：颜色与阈值不得散落各处（PROJECT_RULES 五章·魔法数字） ===== */
  section('L. 常量集中化（颜色 / 阈值）');
  {
    const cssHex = new Set([...readText('src/styles/variables.css').matchAll(/#[0-9A-Fa-f]{6}/g)].map(m => m[0].toUpperCase()));
    const dup = new Map();
    for (const f of walkFiles(path.join(ROOT, 'src'), '.js')) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/#[0-9A-Fa-f]{6}/g)) {
        const hex = m[0].toUpperCase();
        if (!cssHex.has(hex)) continue;
        if (!dup.has(hex)) dup.set(hex, new Set());
        dup.get(hex).add(path.relative(ROOT, f));
      }
    }
    check(
      'JS 内联色值不应与 variables.css 重复维护',
      dup.size === 0,
      [...dup].map(([hex, files]) => `${hex} 同时写死在 ${[...files].join('、')}`).join('；') +
      '（PROJECT_RULES 五章要求颜色集中到 CSS 变量或 JS 的 CFG 常量）'
    );

    const h2 = createIsolatedHarness({ mutate: w => { w.BoardConfig.maintenance.warnDays = 1; } });
    h2.window.MockData.tick(h2.__at('2026-09-18T10:00:00'));
    const maintWarn = h2.window.MockData.state.warnings.find(w => w.title.includes('维保'));
    check(
      '维保到期预警阈值应跟随 board.config.maintenance.warnDays',
      maintWarn.lv !== 'warn',
      `warnDays=1、距下次维保 ${h2.window.MockData.state.maint.daysLeft} 天，仍判为 "${maintWarn.lv}"（阈值 14 硬编码在 mockData.js）`
    );

    const h3 = createIsolatedHarness({ mutate: w => { w.BoardConfig.maintenance.consumables[0].threshold = 9999; } });
    h3.window.MockData.tick(h3.__at('2026-09-18T10:00:00'));
    const lampWarn = h3.window.MockData.state.warnings.find(w => w.title.includes('耗材'));
    check(
      '耗材更换预警阈值应跟随 board.config.maintenance.consumables[].threshold',
      lampWarn.lv !== 'warn',
      `threshold=9999、实际点亮时长远低于阈值，仍判为 "${lampWarn.lv}"（780 基准与 800 阈值硬编码在 mockData.js）`
    );
  }

  /* ===== M. 跨实现一致性：前端演示实现 ↔ 服务端权威实现（ADR-0005 建议第 2 条） =====
     背景：统计公式在仓库里有**两份实现**（`src\services\mockData.js` 的 computeStats 与
     `server\services\stats.js` 的 computeShiftStats）。ADR-0005 采纳"公式留在代码、配置只存参数"
     后，两份实现都必须改到位；本段就是盯住这件事的机器判据 —— 同一组输入下逐项比对
     一次性合格率 / 产能达成率 / 稼动率 / 平均测试时长。

     同一组输入怎么构造（两侧都用**仓库现值**，不写魔数）：
       · 完成数 done = min(planQty, floor(班次已进行时长 / cycleSec))，合格 = round(done × firstPassRate)
         —— 这正是 mockData.computeStats 的构造口径，故可**独立于被测函数**先算出来；
       · 服务端侧的入参形状自 `E65` 起**分成两类**（`server\services\stats.js` 的 docblock），
         `E69`（负责人 2026-09-30 裁定③）后如下：
         票级 `orders:[{planQty}]`（一票即整票计划数）＋ **开工件数** `startedPieces:<number>`
         （由 `measure_rt.unit_index` 去重数出、取数在 `stateSnapshot.statsOf()`）＋
         件级 `pieces:[{result, durationSec}]`（合格 N1 件 + 不合格 N2 件 + 测试中 2 件）。
         ⚠ `E69` 之前这里写的是 `orders:[{planQty, started:true}]` —— 那个 `started` **已是死入参**
         （新实现只读 `startedPieces`），留着会让后来人误以为票级布尔仍在新契约里，故本段按新契约改写。
         **两侧必须喂等价输入**：前端的「完成件数/合格数」由构造值给；件级时长之和
         **恰恰取前端自己的运行时长** `round(已进行时长 × runRate)` —— 这正是 `E65` 偏差① 之后
         `avgTestSec`（分子＝Σ 件级时长）与前端 `avgTest`（分子＝runSec）**唯一的对齐方式**；
         运行时长同时用**采集时刻串**表达（`runSecInt + 1` 条 ⇒ stats.js 的 runSec = 采集条数 − 1
         = runSecInt，秒级整数粒度）。
       · ⚠ 本段**不改** `src\services\mockData.js`（前端那份实现的现值），只把**输入**改成新契约。
       · ⚠ **本段对新分子的判别力是有限的**（如实登记，不夸大）：因为件级时长之和＝前端运行时长，
         "服务端分子取 Σ 件级时长"与"取 runSec"在本段**数值上不可区分**（实测：把 `stats.js` 的
         `avgTestSec` 分子改回 `runSec` ⇒ 本段 5 条断言**全绿**）。对偏差①真正可证伪的是下面
         ②d（**独立构造**）与 `tests\logic-check.js` 的 `FR-4.13` 断言 —— 那里件级时长之和
         与班次运行时长**刻意不同**（Σ660s vs 班次进度 14400s），变异后当场变红。
       两侧 `planQty` / `cycleSec` / `runRate` / `firstPassRate` 都读 `board.config.js`，
       因此 Q-11 改参数后本段期望值自动跟随，不需要改断言。

     精度口径（**实测确认，非猜测**）：
       · 前端输出**未取整**的原始百分比（实测 93.33333333333333 / 78.88888888888889）；
         服务端 pct() 按"保留 1 位小数"返回（实测 93.3 / 78.9，见 stats.js 的 pct() 定义）。
         ⇒ 比对时两侧都归一到 1 位小数，容差 0.05 只用于吸收浮点表示误差（如 79 vs 78.99999999999999），
           不是放宽业务口径。
       · 服务端 runSec 是**整数秒**（采集条数 − 1），前端 runSec 可为小数（已进行时长 × runRate）；
         两侧差值实测 ≤ 0.5 s（远小于 1 s），本身不构成口径分歧。
        · 平均测试时长两侧取整口径**不同**（服务端 Math.round、前端不取整）——见 ②b，
          按 `服务端 === Math.round(前端)` 锁为**已知边界**，不放宽容差。 */
  section('M. 跨实现一致性（前端 mockData ↔ 服务端 stats 权威实现）');
  {
    const stats = require('../server/services/stats');
    const { createShiftRules } = require('../server/services/shift');
    /* 前提（ADR-0004 D20）：本段没有 runner 对象，用局部包装沿用 tests/lib/assert.js 的 requires 语义
       —— 前提塌掉时**不计入通过**，而是记为一条失败并单列原因（不是"环境不满足就跳过"）。 */
    function requires(name, ok, detail) {
      if (!ok) {
        console.log(`  [UNMET] 前提不成立：${name} —— ${detail}`);
        check(name, false, `${detail}（前提不成立，本段用例不成立、不计入通过）`);
      }
      return Boolean(ok);
    }
    /* 配置真源：两侧的输入都从这里取，避免把 Q-11 参数写死在断言里 */
    const conf = require('../src/config/board.config.js');
    const prod = conf.production;
    const shiftRules = createShiftRules(conf.shift.list);
    /* 取整函数与 stats.js 的 pct() 同口径（保留 1 位小数）；比对前两侧都过一遍 */
    const norm1 = v => Number(v.toFixed(1));

    /** 把秒数**按件切开**成非负整数秒（与 `result.duration_sec` INTEGER 同域），各件之和**恰等于** total。
     *  ⚠ `T-20260930-18`（B3-5 改法①）后本函数**只用于"构造自检"**，不再用来把服务端的件级时长
     *    绑成前端的运行时长 —— 那种"输入等价性"会让两侧共用一个真源，构造出一致并**掩盖分叉**
     *    （座位 6 实测：把前端 `avgTest` 改回 `runSec / done` 时，旧 M 段三条谓词 `true/true/true` 全绿）。 */
    function splitInt(total, n) {
      const out = [];
      for (let i = 0; i < n; i++) out.push(Math.floor(total * (i + 1) / n) - Math.floor(total * i / n));
      return out;
    }

    /* `E67`／`E68` 之后**两侧各自独立取数**（B3-5 改法①；不再靠"把 Σ件级时长绑成 runSec"对齐）：
       两侧的**件级时长定义本就不同、不可互相换算**，故把它显式登记为"**不可比量**" ——
       登记的是**口径**（各自的取数来源），不是某个具体差额数字（避免把可变读数写成魔数，ADR-0004 D21）。
       · 服务端（`stats.js` 的 `avgTestSec`）：件级时长＝**独立给定的整数秒**（`duration_sec` INTEGER 同域）；
       · 前端（`mockData.js` 的 `avgTest`）：件级时长＝**演示节拍** `cycleSec / outputRatio`。
       "是否真的不可比"**可证伪**：若有人把它们改回同一个真源（例如把服务端 `durationSec` 由 `runSec` 切开、
       或把前端 `avgTest` 改回 `runSec / done`），本段两侧的差额会塌成 0（或前端侧内等式失效）⇒ ②b／②c 变红。 */
    const INCOMPARABLE_4B = {
      name: 'FR-4.13 两侧 avgTest 的**件级时长定义**',
      feBasis: `演示节拍 cycleSec / outputRatio ＝ ${prod.cycleSec} / ${prod.outputRatio}`,
      beBasis: '件级时长＝独立给定的整数秒之和（Σ pieces[].durationSec）'
    };

    /** 把"同一组输入"分别喂给前端与服务端，返回两侧的派生指标
     *  （`E65` 后的新契约：服务端入参＝票级 `orders` ＋ 件级 `pieces`，不再是 `tasks`）
     *  ⚠ `T-20260930-18`：件级时长**由本函数独立给定**（见下面 `BE_PIECE_SEC = 100`），
     *     **不再由前端 `runSec` 切开** —— 这是 B3-5 改法①的落点。 */
    function evalCase(iso) {
      const at = new Date(iso);
      const shift = shiftRules.at(at);
      const elapsedSec = shift.elapsedSec;
      const done = Math.min(prod.planQty, Math.floor(elapsedSec / prod.cycleSec));
      const pass = Math.round(done * prod.firstPassRate);
      const runSecExact = elapsedSec * prod.runRate;      // 前端口径：已进行时长 × 有效运行占比
      const runSecInt = Math.round(runSecExact);          // 服务端口径：采集时刻串只能表达整秒

      const h = createIsolatedHarness({});
      h.window.MockData.tick(h.__at(iso));
      const fe = h.window.MockData.state.stats;

      /* 件级时长：**服务端独立取数** —— 前 done 件各 `BE_PIECE_SEC` 秒（整数秒，`duration_sec` 同域），
         两条「测试中」件各 0s（尚未完成，`duration_sec` 缺省为 0）。
         ⇒ Σ durationSec ＝ `BE_PIECE_SEC × done`，与前端的 `runSec` **无关**（故意不等）。
         本构造仍做一次**自检**（`durSumSame`）：Σ ＝ 常数 × done（不再借 `splitInt(runSecInt, done)`）。 */
      const BE_PIECE_SEC = 100;
      const dur = new Array(done).fill(BE_PIECE_SEC);
      const pieces = [];
      for (let i = 0; i < pass; i++) pieces.push({ result: stats.STATUS.PASS, durationSec: BE_PIECE_SEC });
      for (let i = pass; i < done; i++) pieces.push({ result: stats.STATUS.FAIL, durationSec: BE_PIECE_SEC });
      for (let i = 0; i < 2; i++) pieces.push({ result: stats.STATUS.RUNNING, durationSec: 0 });
      /* 票级：一票＝整票计划数（与前端 planQty 同一取值）；**开工件数按 `E69` 新契约显式给**
         （＝已完成的 done 件 ＋ 两条「测试中」件 —— 它们都已"开始测试"；同一件级夹具现算，不写死）。
         ⚠ 本值**与 `orders.length`（1 票）刻意不等** ⇒ 下面 ②a-2 那条断言有判别力
         （若实现退回"数票数"或忽略该入参，读数会变成 1 或 0）。 */
      const orders = [{ planQty: prod.planQty }];
      const startedPieces = done + 2;
      /* 采集时刻串仍是两侧**共同输入**（服务端 `runSec` 由它的条数决定）——
         这是真实契约本身（`runSec` ＝ 采样条数 − 1），不是"把两侧绑成等价"的构造。 */
      const measures = [];
      for (let i = 0; i <= runSecInt; i++) measures.push(new Date(at.getTime() - i * 1000));
      const be = stats.computeShiftStats({
        shift, orders, startedPieces, pieces, measures,
        accum: { daySec: 0, monthSec: 0, yearSec: 0, at }, addRunSec: runSecInt, now: at
      });
      return { iso, elapsedSec, done, pass, runSecExact, runSecInt, dur, durSum: dur.reduce((s, v) => s + v, 0),
        bePieceSec: BE_PIECE_SEC, pieces, orders, startedPieces, fe, be };
    }

    /* ---- `E67` 裁定②（分子**集合**＝`DONE_STATUS`）与 `E65` 偏差①（分子不是 `runSec`）的**独立靶子** ----
       上面 `evalCase` 现在两侧各自取数，但"服务端分子只累加**已完成件**"这条**集合口径**在
       `evalCase` 的现场里不可证伪（那里的 `pieces` 只有合格／不合格＋两条 0 秒「测试中」——
       去掉过滤与保留过滤**数值相同**）。故这里另起两组**刻意分离**的输入，把"分子"与"集合"
       两个维度分别钉死；两条读数都走**真**实现，另两组走**在内存里编译的旧写法**（不落盘、不碰仓库）：

       (A) 分子维度：件级时长之和（300s）≠ 班次运行时长（20s）⇒ 真实现 ＝ Σ÷done ＝ 100；
           把分子换回 `runSec` 的旧写法 ＝ 20 ⇒ **两条读数必须不同**。
       (B) 集合维度（`T-20260930-18` 新增，B3-5 改法③）：同一组输入里混入 **1 件「待复检」（带 240s 时长）**
           ⇒ 真实现 `avgTestSec` **不变**（＝100）；把 `DONE_STATUS.includes(p.result) &&` 去掉的旧写法
           ⇒ 变大（(300+240)/3 ＝ 180）⇒ 两条读数必须不同。**这一格是"集合口径"唯一可证伪点**：
           本仓把 `待复检` 算进分子，正是 `E67` 之前被门禁锁住的错口径（C·8.4 争议①）。 */
    const MUT_AVG_NUMERATOR = 'const avgTestSec = done > 0 ? Math.round(runSec / done) : 0;';
    const MUT_ALL_PIECES = 'p && Number.isFinite(Number(p.durationSec))';
    /* 与 `evalCase` 里 `pieces` 形状相同、与 `stats.js` 的 STATUS 取值域同一份 */
    const RUN = stats.STATUS.RUNNING;
    const RETEST = stats.STATUS.RETEST;
    const numeratorProbe = (() => {
      const at = new Date('2026-09-18T12:00:00');
      const shift = shiftRules.at(at);
      const pieces = [
        { result: stats.STATUS.PASS, durationSec: 100 },
        { result: stats.STATUS.PASS, durationSec: 100 },
        { result: stats.STATUS.FAIL, durationSec: 100 }
      ];
      const measures = [];
      for (let i = 0; i <= 20; i++) measures.push(new Date(at.getTime() - i * 1000));   // runSec = 20s
      const input = {
        shift, orders: [{ planQty: 10 }], startedPieces: 10, pieces, measures,
        accum: { daySec: 0, monthSec: 0, yearSec: 0, at }, addRunSec: 0, now: at
      };
      const real = stats.computeShiftStats(input);
      const done = pieces.filter(p => p.result === stats.STATUS.PASS || p.result === stats.STATUS.FAIL).length;
      const durSum = pieces.reduce((s, p) => s + p.durationSec, 0);
      return { at, shift, pieces, measures, input, real: real.avgTestSec, done, durSum, runSec: real.runSec,
        expectReal: done > 0 ? Math.round(durSum / done) : 0 };
    })();
    /* 编译一份"内存变异体"并跑同一组输入；锚点未命中 ⇒ 返回 null（断言把它判红，不放行） */
    const compileVariant = (src, from, to, tag) => {
      if (!src.includes(from)) return { tag, ok: false };
      const srcPath = require('node:path').join(__dirname, '..', 'server', 'services', 'stats.js');
      const Module = require('node:module');
      const m = new Module(srcPath, null);
      m.filename = srcPath;
      m.paths = Module._nodeModulePaths(require('node:path').dirname(srcPath));
      m._compile(src.replace(from, to), srcPath);
      return { tag, ok: true, mod: m.exports };
    };
    const statsSrc = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'server', 'services', 'stats.js'), 'utf8');
    const legacyNum = compileVariant(statsSrc, 'const avgTestSec = done > 0 ? Math.round(testSecSum / done) : 0;',
      MUT_AVG_NUMERATOR, '分子改回 runSec');
    const legacyAll = compileVariant(statsSrc, 'p && DONE_STATUS.includes(p.result) && Number.isFinite(Number(p.durationSec))',
      MUT_ALL_PIECES, '去掉 DONE_STATUS 过滤');
    const legacyNumRead = legacyNum.ok ? legacyNum.mod.computeShiftStats(numeratorProbe.input).avgTestSec : null;

    /* (B) 集合维度现场：3 件已完成（各 100s）＋ **1 件「待复检」（240s）** ＋ 1 件「测试中」（0s） */
    const collectionProbe = (() => {
      const at = new Date('2026-09-18T12:00:00');
      const shift = shiftRules.at(at);
      /* 现算期望的"已完成件集合"：**由构造内容现算**，不写死 3 —— 集合判据一旦被改，这里同时跟着对不上 */
      const allPieces = [
        { result: stats.STATUS.PASS, durationSec: 100 },
        { result: stats.STATUS.PASS, durationSec: 100 },
        { result: stats.STATUS.FAIL, durationSec: 100 },
        { result: RETEST, durationSec: 240 },
        { result: RUN, durationSec: 0 }
      ];
      const measures = [];
      for (let i = 0; i <= 20; i++) measures.push(new Date(at.getTime() - i * 1000));   // runSec = 20s（与分子无关）
      const input = {
        shift, orders: [{ planQty: 10 }], startedPieces: 10, pieces: allPieces, measures,
        accum: { daySec: 0, monthSec: 0, yearSec: 0, at }, addRunSec: 0, now: at
      };
      const real = stats.computeShiftStats(input);
      const done = allPieces.filter(p => stats.DONE_STATUS.includes(p.result)).length;
      const doneDurSum = allPieces.reduce(
        (s, p) => s + (stats.DONE_STATUS.includes(p.result) ? p.durationSec : 0), 0);
      const allDurSum = allPieces.reduce((s, p) => s + p.durationSec, 0);
      const legacy = legacyAll.ok ? legacyAll.mod.computeShiftStats(input).avgTestSec : null;
      return { done, retestQty: real.retestQty, doneDurSum, allDurSum, runSec: real.runSec,
        real: real.avgTestSec, legacy, expectReal: done > 0 ? Math.round(doneDurSum / done) : 0,
        expectLegacy: done > 0 ? Math.round(allDurSum / done) : 0 };
    })();
    check(
      '跨实现一致（E67 裁定②·**独立靶子（集合维度）**）：`avgTestSec` 的分母/分子＝**同一集合**（`DONE_STATUS`）' +
      '—— 混入 1 件带 240s 的「待复检」⇒ 真实现**不变**、去掉 `DONE_STATUS` 过滤的旧写法**必变大**',
      legacyAll.ok && stats.DONE_STATUS.includes(RETEST) === false && collectionProbe.retestQty === 1 &&
      collectionProbe.real === collectionProbe.expectReal &&
      collectionProbe.real === numeratorProbe.expectReal &&
      collectionProbe.legacy === collectionProbe.expectLegacy &&
      collectionProbe.legacy !== collectionProbe.real,
      `现场：已完成 ${collectionProbe.done} 件（Σ${collectionProbe.doneDurSum}s）＋「待复检」1 件（240s，` +
      `DONE_STATUS 含「${RETEST}」=${stats.DONE_STATUS.includes(RETEST)}）＋「测试中」1 件（0s）；` +
      `真实现 avgTestSec=${collectionProbe.real}s（期望 Σ已完成 ${collectionProbe.doneDurSum}s ÷ ${collectionProbe.done} ` +
      `＝ ${collectionProbe.expectReal}s，**与上面分子靶子的 100s 逐值相同 ⇒ "待复检"确实没进分子**）；` +
      `去掉 DONE_STATUS 过滤的旧写法＝${collectionProbe.legacy}s（期望 ${collectionProbe.expectLegacy}s）` +
      `⇒ ${collectionProbe.legacy !== collectionProbe.real ? '两者**不同**（集合口径可证伪）' : '两者相同（靶子无力，须查）'}；` +
      `（对照：本现场的 runSec＝${collectionProbe.runSec}s，与两个读数都不同 ⇒ 也顺带证伪"分子取 runSec"）`);
    check(
      '跨实现一致（E65 偏差①·**独立靶子（分子维度）**）：服务端平均测试时长的分子＝Σ **件级**时长（不是 runSec）' +
      '—— 刻意让 Σ 件级时长（300s）≠ 班次运行时长（20s）⇒ 期望值现算，且"改回 runSec"的读数**必须不同**',
      legacyNum.ok && numeratorProbe.real === numeratorProbe.expectReal &&
      legacyNumRead !== numeratorProbe.real,
      `件级 ΣdurationSec=${numeratorProbe.durSum}s ÷ doneQty=${numeratorProbe.done} ⇒ 期望 ${numeratorProbe.expectReal}s；` +
      `真实现实测 ${numeratorProbe.real}s；把分子改回 runSec（runSec=${numeratorProbe.runSec}s）的读数 ` +
      `${legacyNumRead}s ⇒ 两者${legacyNumRead !== numeratorProbe.real ? '**不同**（靶子有力）' : '相同（靶子无力，须查）'}`);

    /* 四个时刻：
       · 10:00 / 12:00 —— 整点班次进度（runSecInt 恰为整数），与现有 K 段同一时间基准；
       · 14:19:30 —— 非整点样本（`elapsedSec × runRate` 带小数，取整后才落到采集串条数）；
       · 03:30:58 —— **取整边界样本**：实测 elapsed=12658s ⇒ done=79、runSecInt=10000，
         前端平均时长 126.58（小数部分 .58）—— 距 .5 最近的那类输入（四舍五入必然进位 127，
         截断则得 126），用于让"服务端取整"这条已知边界**可证伪**而不是被容差盖住。 */
    const evals = ['2026-09-18T10:00:00', '2026-09-18T12:00:00',
      '2026-09-18T14:19:30', '2026-09-18T03:30:58'].map(evalCase);

    /* 前提（ADR-0004 D20）：只声明"输入处于可用状态"，不描述被测函数的返回值 */
    const inputsOk = evals.every(e =>
      e.elapsedSec > 0 && e.done > 0 && e.done < prod.planQty &&
      e.pass > 0 && e.pass < e.done && e.runSecInt > 0);
    if (requires('跨实现一致性的输入可用（班次已进行、完成数 ∈ (0, 计划数)、运行时长 > 0）',
      inputsOk, evals.map(e => `${e.iso}: elapsed=${e.elapsedSec}s done=${e.done} pass=${e.pass} runSec=${e.runSecInt}s`).join('；'))) {
      /* ① 两侧对"完成数"这一共同输入必须一致（若连它都不一致，下面的比对没有意义）。
         ⚠ `E65` 后的判别力：这一段在**旧形状**（把件塞进 `tasks`）下服务端恒 0 ⇒ 本条必红；
         现在两侧喂的是等价输入（件级 `pieces` 的合格/不合格件数 ＝ 构造值 pass/done−pass）。 */
      check(
        '跨实现一致性前提：同一组输入下两侧的完成数一致（FR-4.4）',
        evals.every(e => e.fe.done === e.done && e.be.doneQty === e.done &&
          e.be.passQty === e.pass && e.be.failQty === e.done - e.pass),
        evals.map(e => `${e.iso}: 前端 ${e.fe.done} / 服务端 ${e.be.doneQty} / 构造值 ${e.done}` +
          `（合格 前端 ${e.fe.qualified} / 服务端 ${e.be.passQty} / 构造 ${e.pass}）`).join('；')
      );

      /* ②a 三项百分比指标：**必须严格一致**（两侧都归一到 1 位小数，容差 0.05 只吸收浮点表示误差）。
         `pct1` 依据：服务端 pct() 按"保留 1 位小数"返回（stats.js 的 pct() 定义）；前端输出**未取整**的
         原始百分比（实测 firstPass=93.33333333333333、capacity=78.88888888888889）。
         这三项不因 FR-4.13 的取整边界而放宽 —— 各自容差仍是 0.05。 */
      const pct1 = v => Number(v.toFixed(1));
      const rows = [
        { name: '一次性合格率', fe: 'firstPass', be: 'firstPassRate', id: 'FR-4.10' },
        { name: '产能达成率', fe: 'capacity', be: 'capacityRate', id: 'FR-4.14' },
        { name: '稼动率', fe: 'oee', be: 'oee', id: 'FR-4.15' }
      ];
      for (const row of rows) {
        const bad = evals.filter(e => Math.abs(pct1(e.fe[row.fe]) - e.be[row.be]) > 0.05);
        check(
          `跨实现一致（${row.id} ${row.name}）：前端 mockData.${row.fe} 与 server.stats.${row.be} 对同一组输入一致`,
          bad.length === 0,
          bad.length
            ? bad.map(e => `${e.iso}: 前端 ${e.fe[row.fe]}（归一 ${pct1(e.fe[row.fe])}）/ 服务端 ${e.be[row.be]}`).join('；')
            : evals.map(e => `${e.iso}: ${e.fe[row.fe]} ↔ ${e.be[row.be]}`).join('；')
        );
      }

      /* ②a-2 `E69`／C-111 的新契约（**侧内**，不与前端比相等）：开工数是**件数入参** `startedPieces`
         （不是票级布尔 `started`）。本段原构造里的 `started: true` 自 `E69` 起已是**死入参**
         （实现不再读它）—— 留着会让后来人误以为票级布尔仍是契约，故按新契约改写并在这里把
         "该入参真的被消费"钉成一句断言（`startedPieces` 与本段派工票数 1 **刻意不等** ⇒ 有判别力：
         实现若退回"数票数"⇒ 1、忽略入参 ⇒ 0，都当场变红）。
         ⚠ **不与前端 `started` 比相等**（这不是"少写一条断言"，而是**不可比量必须显式登记**）：
            · 前端（`src\services\mockData.js`）：`started = min(计划, 完成＋在测＋待复检)` —— **演示派生量**；
            · 服务端：`startedPieces` 由调用方从 `measure_rt.unit_index` **去重数出的件数**给出。
         两者取数真源不同，绑成"两侧一致"会把 `T-20260930-18`／B3-5 已消除的"构造出一致"请回来。 */
      check(
        '跨实现一致（`E69` 新契约·**侧内**）：服务端 `startedQty` ＝ 入参 `startedPieces`（**件数**）、' +
        '`notStartedQty` ＝ max(0, planQty − startedPieces) —— 该入参**不是死参数**（与派工票数刻意不等）',
        evals.every(e => e.be.startedQty === e.startedPieces &&
          e.be.notStartedQty === Math.max(0, e.be.planQty - e.startedPieces) &&
          e.startedPieces !== e.orders.length && e.startedPieces > 0),
        evals.map(e => `${e.iso}: startedQty=${e.be.startedQty}（入参 ${e.startedPieces}／派工票数 ${e.orders.length}）` +
          `、notStartedQty=${e.be.notStartedQty}（＝max(0, ${e.be.planQty} − ${e.startedPieces})）`).join('；') +
        '；**不可比量已显式登记**：两侧「开工数」取数真源不同 —— ' +
        '前端＝演示派生量 min(计划, 完成＋在测＋待复检)、服务端＝`measure_rt.unit_index` 去重件数，故**不**比相等'
      );

      /* ②b 平均测试时长（FR-4.13）：`E67` 之后**两侧各自独立取数**，故本段**不再**断言
          "服务端值 === Math.round(前端值)"（那条断言把两侧绑成同一真源，构造出一致并掩盖分叉 ——
          B3-5 指出的正是这一点；实测旧写法下把前端 `avgTest` 改回 `runSec / done` 曾使三条谓词全绿）。
          改为两条**侧内**构成性断言（ADR-0004 D21：期望值现算，不写死魔数）：
            · 服务端：`avgTestSec` ＝ `Math.round(Σ pieces[].durationSec ÷ doneQty)`（分子是**件级时长和**）；
            · 前端：`avgTest` ＝ **演示节拍** `cycleSec / outputRatio`（与服务端同一需求口径、各自取数）。
          两侧的**取值**在本样本上不必相等 —— 那是"两份实现各自的输入不同"的必然结果，
          在 ②c 里作为**已知边界**登记（`INCOMPARABLE_4B`），不再当"公式差异"去放宽容差。 */
      const avgBoundary = evals.map(e => ({
        iso: e.iso, done: e.done, fe: e.fe.avgTest, be: e.be.avgTestSec, durSum: e.durSum,
        delta: e.fe.avgTest - e.be.avgTestSec,
        /* 侧内构成性等式（两侧各自成立；改任一侧的分子/分母集合/取整口径都会让对应那条变红） */
        beFormulaOk: e.be.avgTestSec === (e.done > 0 ? Math.round(e.durSum / e.done) : 0),
        feFormulaOk: e.fe.avgTest === (prod.outputRatio > 0 ? prod.cycleSec / prod.outputRatio : prod.cycleSec),
        /* **构造自检**（原"输入等价性"，B3-5 建议②：降级为构造自检，不再当公式契约）：
           Σ durationSec 是本次构造**自己给的常数 × done**（不再借 `splitInt(runSecInt, done)`）；
           `be.runSec === runSecInt` 则是**真实契约**（服务端 `runSec` ＝ 采集条数 − 1）。 */
        durSumIsConstruct: e.durSum === e.bePieceSec * e.done,
        runSecContract: e.be.runSec === e.runSecInt
      }));
      check(
        '跨实现一致（FR-4.13 平均测试时长·**侧内构成性等式**）：服务端 `avgTestSec` ＝ Math.round(' +
        'Σ **件级**时长 ÷ 已完成数)，前端 `avgTest` ＝ **演示节拍**（cycleSec / outputRatio）' +
        '—— 两侧各自独立取数、不靠"把 Σ件级时长绑成 runSec"对齐',
        avgBoundary.every(r => r.beFormulaOk && r.feFormulaOk),
        avgBoundary.map(r => `${r.iso}: 服务端 ${r.be}（期望 round(${evals.find(x => x.iso === r.iso).durSum} ÷ ${r.done})）` +
          `／前端 ${r.fe}（期望 ${prod.cycleSec} / ${prod.outputRatio} ＝ ${prod.cycleSec / prod.outputRatio}）`).join('；')
      );
      const incomparable = {
        declared: INCOMPARABLE_4B,
        /* "不可比"的可证伪判据（**不写魔数**）：两侧取值在本段现场上**确实不同**；
           若有人把两侧绑回同一真源（差额全为 0）⇒ 本条变红。 */
        distinct: avgBoundary.every(r => r.delta !== 0),
        sameSideFormulaOk: avgBoundary.every(r => r.beFormulaOk && r.feFormulaOk)
      };
      check(
        '跨实现一致（E67 后**不可比量已显式登记**）：两侧的**件级时长**定义不同 ⇒ avgTest ' +
        '**不要求相等**（前端＝演示节拍、服务端＝独立整数秒之和后再取整）；"不可比"本身须可证伪',
        incomparable.distinct && incomparable.sameSideFormulaOk,
        '登记：' + INCOMPARABLE_4B.name + ' —— 前端＝' + INCOMPARABLE_4B.feBasis +
        '、服务端＝' + INCOMPARABLE_4B.beBasis + '；实测各样本差额 ' +
        avgBoundary.map(r => r.iso + '→' + r.delta).join('、') +
        '（全不为 0=' + incomparable.distinct + '，即两侧**没有**被绑成同一真源）；' +
        '两侧各自侧内构成性等式成立=' + incomparable.sameSideFormulaOk
      );
      /* ②d `E65` 新契约的**构造自检**（B3-5 建议②：由"公式契约"降级为"构造自检"，并显式登记
         "本段 ΣdurationSec 由构造给出 ⇒ 对 `avgTest` 的**集合口径**不可证伪"——
          对集合口径真正可证伪的是上面 (B) 的 `collectionProbe` 与 `tests\logic-check.js` 的
          `FR-4.13`／九 · 当班件级取数两条断言）。 */
      check(
        '跨实现一致（构造自检，**不对集合口径作证**）：服务端件级时长之和 ＝ 构造常数 × 完成数，' +
        '且服务端有效运行 runSec ＝ 采集条数 − 1（真实契约，与构造无关）',
        avgBoundary.every(r => r.durSumIsConstruct && r.runSecContract),
        avgBoundary.map(r => `${r.iso}: ΣdurationSec=${evals.find(x => x.iso === r.iso).durSum}` +
          `（＝${evals.find(x => x.iso === r.iso).bePieceSec}×${r.done}：${r.durSumIsConstruct}）` +
          ` / 服务端 runSec=${evals.find(x => x.iso === r.iso).be.runSec} vs runSecInt=${evals.find(x => x.iso === r.iso).runSecInt}` +
          `（${r.runSecContract}）`).join('；')
      );
      /* ③ 前端基线自洽（D23 式守卫）：断言的输入口径不得在无人察觉时漂移。
         合格数 / 完成数 若与界面输出的一次性合格率对不上，说明"同一组输入"两个字段各说各话 ——
         这不是恒真断言：它把 mockData 里 qualified 与 firstPass 两条路径钉在一起。 */
      const splitOk = evals.every(e =>
        e.fe.qualified === e.pass && e.fe.unqualified === e.done - e.pass &&
        Math.abs(norm1(e.fe.firstPass) - norm1((e.fe.qualified / e.fe.done) * 100)) < 0.05);
      check(
        '跨实现一致性的前端基线自洽（qualified/unqualified 与 firstPass、构造输入三者一致）',
        splitOk,
        evals.map(e => `${e.iso}: 前端 合格 ${e.fe.qualified} / 不合格 ${e.fe.unqualified} / 完成 ${e.fe.done}` +
          `（构造 ${e.pass} / ${e.done - e.pass} / ${e.done}）`).join('；')
      );
    }
  }

  /* ===== M2. 跨实现一致性（**累计运行时长**：前端 `accumulateRun` ↔ 服务端 `accumulateRunTime`，`E32`）=====
     立案（`E32`）：`src/services/mockData.js` 的 `accumulateRun(now, runRate)`（日/月/年累计运行时长）
     与 `server/services/stats.js` 的 `accumulateRunTime(prev, addSec, now, addSplit, alloc)` 是**第二份实现**，
     **没有任何跨实现比对**（同文件里 `computeStats()` ↔ `stats` 已有上面 M 段的跨实现对账）。
     本段照 M 段的**口径与写法**补上这一组（同一组输入序列 ⇒ 日/月/年累计**逐值相等**）。

     两侧各自的**在产形态**（这一点决定了本段怎么喂输入）：
       · 前端：`accumulateRun()` **未导出**（`MockData` 的返回对象里没有它）⇒ 走它的**在产可观测口**
         `MockData.tick(now)` 写出的 `state.maint.{todayRun,monthRun,yearRun}`，即维保页显示的那三个数
         （`mockData.js` 里 `accumulateRun()` 的**唯一**调用点，三个字段直接赋值、未经加工）；
       · 服务端：调用形态＝`server/services/stateSnapshot.js` 的 `statsOf()` —— `prev` ＝
         `shift_stat` 按周期求和（读口 `sumRunSec()`）＋ **`prev.at = now`**（同一时刻）。
         ⚠ 由此有一条**已知边界**（如实登记，不冒领）：`rollAccum()` 的跨日/跨月**滚动支**在本判据里
         **不会触发**（在产口径就是"归零靠周期过滤、不靠 rollAccum"，见 `tests/logic-check.js` 的
         `A1/D4-2`）⇒ 本段考的是**归属（E83 切段）/周期过滤/夹零**与两实现的一致性，**不覆盖**滚动支。

     输入序列怎么构造（**两边同一组输入**，且期望值**构成性给出**，不写死魔数）：
       · 账本 ＝ `Map<'yyyy-MM-dd', 秒>`，等价于 `shift_stat` 里按 `shift_date` 归集后的 `run_sec` 求和
         （`sumRunSec()` 的三档就是按日期前缀过滤这张账本）；
       · 每个拍点：`addSec` ＝ 上一拍到这一拍的时长 × `runRate`（这就是 `runRate`＝有效运行占比的定义），
         跨零点的拍点带 **`E83` 的自然日切段**（`day1/day2` 按零点切开、各带 `day1Date/day2Date`）；
         每拍算完后把上一拍的"未固化增量"按段固化进账本（＝班次结束时落 `shift_stat` 那一行）；
       · 初始条件（**归纳起点**，不是被测结论）：`t0` 之前系统按 `runRate` 均匀累积 ⇒ 账本与前端读数一致；
         断言只覆盖 `t0` 之后的每一步。
       · 期望值＝"自周期起点起算的时长 × `runRate`"（前端那份实现的**定义**，独立于两个实现的代码算出来）。
       · **精度**：时间点全部取整点，配置 `runRate=0.79` 下"整点时长×runRate"是**精确整数**
         （本段另立一条**构造成立性**断言把它钉住）⇒ 逐值比较用**严格 `===`**，**不放任何容差**。

     覆盖：跨班次（08:00→16:00 早班整班、16:00→24:00 中班）／跨零点＋`E83` 切段（含 `day2=0` 的零点整）／
     跨月（`E132` 的现场形态 `10-31 22:00→11-01 00:30`）／跨年（`12-31 22:00→次年 01-01 00:30`）／
     空序列零增量／缺测（`addSec`＝0 或缺失）／负增量夹零（`addSec=-600` 与"两段皆负的切段"）。
     两侧口径差异**用构成性断言锁定并写明是已知边界**（两处，各自独立断言，不靠放宽相等性凑绿）：
       ① **缺测**：服务端三档**停在账本值、不伪造增量**（`E38`「不得伪造数据」），前端按时刻外推 ⇒
          差额**恰等于**自账本一致点起的已过时长 × `runRate`；
       ② **跨月/跨年**：`monthSec`／`yearSec` **只收落在 `now` 所在周期的那一段**，另一段由 `outOfPeriod`
          报出（归**上一个**周期、不是丢失）—— 切段总额 − 进本周期档的额 ＝ `outOfPeriod` 报出的额。

     可证伪（ADR-0004 D22，靶子在本段内、判据共用同一个纯函数 `e32ParityProblems()`）：
       把前端 `accumulateRun()` 的**日档**算式改错一位（`/1000` → `/10000`，`src/services/mockData.js` 的
       **内存副本**，盘上零字节改动）⇒ 本判据**必红**并**指名** `src/services/mockData.js`（偏离方）与
       当日档（`today`/`daySec`）。 */
  section('M2. 跨实现一致性（累计运行时长：前端 accumulateRun ↔ 服务端 accumulateRunTime，E32）');
  {
    const e32Stats = require('../server/services/stats');
    const e32Conf = require('../src/config/board.config.js');
    const E32_RATE_CFG = e32Conf.production.runRate;
    const E32_LOAD_ORDER = [
      'src/config/board.config.js', 'src/config/fieldMap.js', 'src/utils/dom.js',
      'src/utils/format.js', 'src/services/api.js', 'src/services/mockData.js',
      'src/services/mockUpperSource.js'
    ];
    /** 按 index.html 的顺序加载 `src/`（与 `createIsolatedHarness()` 同一口径；多一个"源码覆盖"出口，
     *  只为 D22 的**内存副本**——盘上文件全程只读） */
    function e32Harness(overrides) {
      const sandbox = { console, fetch, AbortSignal, setTimeout, clearTimeout };
      sandbox.window = sandbox;
      vm.createContext(sandbox);
      const run = rel => vm.runInContext(
        (overrides && overrides[rel] !== undefined) ? overrides[rel] : readText(rel), sandbox,
        { filename: path.join(ROOT, rel) });
      E32_LOAD_ORDER.forEach(run);
      return sandbox;
    }
    const e32StartOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const e32StartOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
    const e32StartOfYear = d => new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0);
    const e32Pad = n => String(n).padStart(2, '0');
    const e32FmtDate = d => `${d.getFullYear()}-${e32Pad(d.getMonth() + 1)}-${e32Pad(d.getDate())}`;
    const e32Fmt = d => `${e32FmtDate(d)} ${e32Pad(d.getHours())}:${e32Pad(d.getMinutes())}:${e32Pad(d.getSeconds())}`;
    const e32D = (y, m, d, h, mi, s) => new Date(y, m - 1, d, h || 0, mi || 0, s || 0);
    const e32Want = (t, rate) => ({
      today: ((t - e32StartOfDay(t)) / 1000) * rate,
      month: ((t - e32StartOfMonth(t)) / 1000) * rate,
      year: ((t - e32StartOfYear(t)) / 1000) * rate
    });
    /* 前端读数缓存**按沙箱分桶**（同一个沙箱里同一时刻的读数可复用；原件与 D22 变异体各一份） */
    const e32FeCaches = new WeakMap();
    function e32Fe(h, t) {
      const key = t.getTime();
      let cache = e32FeCaches.get(h);
      if (!cache) { cache = new Map(); e32FeCaches.set(h, cache); }
      if (cache.has(key)) return cache.get(key);
      const MD = h.window.MockData;
      MD.tick(new Date(key));
      const v = { today: MD.state.maint.todayRun, month: MD.state.maint.monthRun, year: MD.state.maint.yearRun };
      cache.set(key, v);
      return v;
    }
    const E32_PAIRS = [['daySec', 'today', '当日'], ['monthSec', 'month', '本月'], ['yearSec', 'year', '本年']];
    /** 判据本体（纯函数）：两实现逐值比对；偏离方按"与期望值的关系"**点名** */
    function e32ParityProblems(outv, fev, want, label) {
      const problems = [];
      for (const [sk, fk, cn] of E32_PAIRS) {
        const a = outv[sk];
        const b = fev[fk];
        const w = want ? want[fk] : undefined;
        if (a !== b) {
          const who = (want && b === w) ? '**server/services/stats.js**（服务端 stats.accumulateRunTime）'
            : (want && a === w) ? '**src/services/mockData.js**（前端 accumulateRun）' : '两侧';
          problems.push(`${label} ${cn}档跨实现不一致，偏离方＝${who}：服务端 ${sk}=${a}、前端 ${fk}=${b}`
            + (want ? `、期望（自周期起点时长×runRate）=${w}` : ''));
        } else if (want && a !== w) {
          problems.push(`${label} ${cn}档两侧一致但与期望不符：两侧=${a}、期望=${w}`);
        }
      }
      return problems;
    }
    function e32LedgerSums(ledger, t) {
      const day = e32FmtDate(t);
      const month = day.slice(0, 7);
      const year = day.slice(0, 4);
      let d = 0; let m = 0; let y = 0;
      for (const [date, sec] of ledger) {
        if (date === day) d += sec;
        if (date.slice(0, 7) === month) m += sec;
        if (date.slice(0, 4) === year) y += sec;
      }
      return { daySec: d, monthSec: m, yearSec: y };
    }
    function e32AutoSplit(prevTick, t, rate) {
      const mid = e32StartOfDay(t);
      if (e32StartOfDay(prevTick).getTime() === mid.getTime()) return undefined;
      return {
        crossing: true,
        day1: ((mid - prevTick) / 1000) * rate,
        day2: ((t - mid) / 1000) * rate,
        day1Date: e32FmtDate(prevTick),
        day2Date: e32FmtDate(t)
      };
    }
    function e32RunCase(spec) {
      const h = spec.h;
      const rate = spec.rate;
      const ledger = new Map();
      const addTo = (date, sec) => ledger.set(date, (ledger.get(date) || 0) + sec);
      const w0 = e32Want(spec.t0, rate);
      addTo(e32FmtDate(spec.t0), w0.today);
      if (w0.month - w0.today !== 0) addTo(e32FmtDate(new Date(spec.t0.getTime() - 86400000)), w0.month - w0.today);
      if (w0.year - w0.month !== 0) {
        addTo(e32FmtDate(new Date(spec.t0.getFullYear(), spec.t0.getMonth() - 1, 15)), w0.year - w0.month);
      }
      const rows = [];
      let prevTick = spec.t0;
      let prevAdd = null;
      let prevSplit;
      const base = { daySec: w0.today, monthSec: w0.month, yearSec: w0.year };
      rows.push({ label: '起点 ' + e32Fmt(spec.t0), t: spec.t0, add: null, out: base, prev: base,
        fe: e32Fe(h, spec.t0), want: w0, sinceT0: 0, problems: [] });
      for (const st of spec.steps) {
        if (prevAdd !== null) {
          if (prevSplit && prevSplit.crossing === true) {
            addTo(prevSplit.day1Date, Math.max(0, Math.round(prevSplit.day1)));
            addTo(prevSplit.day2Date, Math.max(0, Math.round(prevSplit.day2)));
          } else {
            addTo(e32FmtDate(prevTick), Math.max(0, Math.round(prevAdd)));
          }
        }
        const t = st.t;
        const add = st.undef ? undefined : (st.add !== undefined ? st.add : ((t - prevTick) / 1000) * rate);
        const split = st.split === 'auto' ? e32AutoSplit(prevTick, t, rate) : st.split;
        const sums = e32LedgerSums(ledger, t);
        const prev = { daySec: sums.daySec, monthSec: sums.monthSec, yearSec: sums.yearSec, at: t };
        const outv = e32Stats.accumulateRunTime(prev, add, t, split);
        const fev = e32Fe(h, t);
        const want = st.missing ? null : e32Want(t, rate);
        const label = `${st.kind || '步'} ${e32Fmt(t)}`;
        rows.push({
          label, t, add, split, prev, out: outv, fe: fev, want, missing: Boolean(st.missing),
          sinceT0: ((t - spec.t0) / 1000) * rate,
          problems: st.missing ? [] : e32ParityProblems(outv, fev, want, label)
        });
        prevTick = t; prevAdd = add; prevSplit = split;
      }
      return { spec, rows };
    }
    function e32BuildCases(h) {
      const rate = h.window.MockData.CFG.runRate;
      return [
        { name: '①跨班次＋跨零点（现配置 0-8／8-16／16-24；E83 切段 day2=0）', h, rate,
          t0: e32D(2026, 10, 6, 8, 0, 0),
          steps: [
            { kind: '跨班次（08:00→16:00 早班整班）', t: e32D(2026, 10, 6, 16, 0, 0) },
            { kind: '跨零点（16:00→次日 00:00 中班）', t: e32D(2026, 10, 7, 0, 0, 0), split: 'auto' },
            { kind: '零点后（00:00→00:30）', t: e32D(2026, 10, 7, 0, 30, 0) }
          ] },
        { name: '②跨零点且跨月（E132 现场形态：10-31 22:00→11-01 00:30）', h, rate,
          t0: e32D(2026, 10, 31, 22, 0, 0),
          steps: [{ kind: '跨月＋跨零点', t: e32D(2026, 11, 1, 0, 30, 0), split: 'auto' }] },
        { name: '③跨零点且跨年（12-31 22:00→次年 01-01 00:30）', h, rate,
          t0: e32D(2026, 12, 31, 22, 0, 0),
          steps: [{ kind: '跨年＋跨零点', t: e32D(2027, 1, 1, 0, 30, 0), split: 'auto' }] },
        { name: '④跨零点在零点整＋同日多步', h, rate,
          t0: e32D(2026, 5, 20, 20, 0, 0),
          steps: [
            { kind: '（20:00→次日 00:00）', t: e32D(2026, 5, 21, 0, 0, 0), split: 'auto' },
            { kind: '（00:00→06:00）', t: e32D(2026, 5, 21, 6, 0, 0) }
          ] },
        { name: '⑤空序列／零增量（addSec 恒 0、时刻不动）', h, rate,
          t0: e32D(2026, 6, 15, 9, 0, 0),
          steps: [
            { kind: '零增量（同时刻）', t: e32D(2026, 6, 15, 9, 0, 0), add: 0 },
            { kind: '零增量（同时刻，再一拍）', t: e32D(2026, 6, 15, 9, 0, 0), add: 0 }
          ] },
        { name: '⑥缺测（addSec=0／undefined ⇒ 不伪造增量）', h, rate,
          t0: e32D(2026, 10, 8, 8, 0, 0),
          steps: [
            { kind: '缺测（addSec=0）', t: e32D(2026, 10, 8, 16, 0, 0), add: 0, missing: true },
            { kind: '缺测（addSec=undefined）', t: e32D(2026, 10, 8, 20, 0, 0), undef: true, missing: true }
          ] },
        { name: '⑦负增量夹零（addSec=-600；切段两段为负）', h, rate,
          t0: e32D(2026, 10, 9, 8, 0, 0),
          steps: [
            { kind: '负增量（同时刻）', t: e32D(2026, 10, 9, 8, 0, 0), add: -600 },
            { kind: '负切段（同时刻，day1/day2 均负）', t: e32D(2026, 10, 9, 8, 0, 0), add: 0,
              split: { crossing: true, day1: -100, day2: -50, day1Date: '2026-10-08', day2Date: '2026-10-09' } }
          ] }
      ];
    }
    const e32H = e32Harness();
    const e32Runs = e32BuildCases(e32H).map(e32RunCase);
    const e32Problems = [];
    let e32Exact = true;
    for (const r of e32Runs) {
      for (const row of r.rows) {
        if (row.want) {
          for (const k of ['today', 'month', 'year']) if (!Number.isInteger(row.want[k])) e32Exact = false;
        }
        for (const p of row.problems) e32Problems.push(p);
      }
    }
    const e32Ticks = e32Runs.reduce((n, r) => n + r.rows.length, 0);
    check('E32 跨实现对账：后端 `accumulateRunTime`（`daySec/monthSec/yearSec`，在产形态 `prev.at=now`）' +
      '↔ 前端 `accumulateRun`（`state.maint.{todayRun,monthRun,yearRun}`）' +
      '在**同一组输入序列**上**逐值相等**（严格 `===`，无容差；' +
      `${e32Ticks} 个拍点 × 3 档）—— 覆盖跨班次／跨零点＋E83 切段（含零点整）／跨月／跨年／空序列／负增量夹零`,
      e32Problems.length === 0,
      e32Problems.length ? e32Problems.slice(0, 4).join('；') + `（共 ${e32Problems.length} 条）`
        : `${e32Ticks} 拍逐值相等；序列=${e32Runs.map(r => r.spec.name.slice(0, 2)).join('')}`);
    check('E32 精度前提（构造成立性）：序列的期望值与增量**全为整数**（配置 `runRate=' + E32_RATE_CFG + '` 下' +
      '「整点时长×runRate」是精确整数）⇒ 上面的严格相等不受 IEEE754 表示误差干扰',
      e32Exact, `全为整数=${e32Exact}，runRate=${E32_RATE_CFG}`);
    {
      const r0 = e32Runs[0];
      const mono = r0.rows.every((row, i) => i === 0 || (row.out.monthSec >= r0.rows[i - 1].out.monthSec
        && row.out.yearSec >= r0.rows[i - 1].out.yearSec));
      const cross = r0.rows[2];
      check('E32 同月/同年内**逐拍单调不减**（月/年档不倒退）；跨零点那一刻**当日档归零、只收当日段**' +
        '（`daySec` 由 45504 变 0 ＝周期过滤，不是丢秒）',
        mono && cross.out.daySec === 0 && cross.out.daySec === cross.split.day2,
        `月/年单调=${mono}；跨零点 daySec=${cross.out.daySec}（day2=${cross.split.day2}）`);
    }
    {
      const r5 = e32Runs[5];
      const rows = r5.rows.slice(1);
      const gaps = rows.map(row => row.fe.today - row.out.daySec);
      const wantGaps = rows.map(row => row.sinceT0);
      const stopped = rows.every(row => row.out.daySec === r5.rows[0].out.daySec
        && row.out.monthSec === r5.rows[0].out.monthSec && row.out.yearSec === r5.rows[0].out.yearSec);
      check('E32 **已知边界①（缺测）**——构成性锁定，不是放宽相等：`addSec` 为 0／缺失时服务端三档' +
        '**停在账本值、不伪造增量**（E38「不得伪造数据」），与前端的差额**恰等于自账本一致点起的' +
        '已过时长 × runRate**',
        stopped && gaps.every((g, i) => g === wantGaps[i]),
        `服务端停在原值=${stopped}；差额=${gaps.join(' / ')}，期望=${wantGaps.join(' / ')}`);
    }
    {
      const r6 = e32Runs[6];
      const base = r6.rows[0];
      const neg = r6.rows.slice(1);
      check('E32 负增量夹零（构成性锁定）：`addSec = -600` 与"两段皆负的切段" ⇒ 三档**逐值停在原值**' +
        '（不倒退、不出负数/NaN），且与前端在同一时刻的读数相等',
        neg.every(x => x.out.daySec === base.out.daySec && x.out.monthSec === base.out.monthSec
          && x.out.yearSec === base.out.yearSec) && neg.every(x => x.problems.length === 0),
        neg.map(x => `${x.label} ⇒ ${x.out.daySec}/${x.out.monthSec}/${x.out.yearSec}`).join('；'));
    }
    {
      const accs = [e32Runs[1], e32Runs[2]].map(r => {
        const last = r.rows[r.rows.length - 1];
        const total = last.split.day1 + last.split.day2;
        return { name: r.spec.name, total, mAdd: last.out.monthSec - last.prev.monthSec,
          yAdd: last.out.yearSec - last.prev.yearSec, op: last.out.outOfPeriod,
          daySec: last.out.daySec, day2: last.split.day2, monthSec: last.out.monthSec, yearSec: last.out.yearSec };
      });
      check('E32 **已知边界②（跨月/跨年）**——构成性锁定，不是放宽相等：`monthSec`／`yearSec` **只收落在 ' +
        '`now` 所在周期的那一段**（另一段由 `outOfPeriod` 报出、归**上一个**周期，不是丢失），' +
        '且「切段总额 − 进本周期档的额 ＝ `outOfPeriod` 报出的额」是**记账恒等式**',
        accs.every(c => c.op && c.op.month === c.total - c.mAdd && c.op.year === c.total - c.yAdd
          && c.daySec === c.day2 && c.monthSec === c.day2),
        accs.map(c => `${c.name.slice(0, 2)}：total=${c.total}、进本月=${c.mAdd}、进本年=${c.yAdd}、`
          + `outOfPeriod=${JSON.stringify(c.op && { month: c.op.month, year: c.op.year })}、daySec=${c.daySec}`).join('；'));
    }
    /* D22：前端日档算式改错一位（1000 → 10000）——内存副本 */
    const E32_ANCHOR = '      today: secSince(dayStart),';
    const e32MdSrc = readText('src/services/mockData.js');
    const e32AnchorHits = e32MdSrc.split(E32_ANCHOR).length - 1;
    let e32MutProblems = null;
    if (e32AnchorHits === 1) {
      const hMut = e32Harness({ 'src/services/mockData.js': e32MdSrc.replace(E32_ANCHOR,
        '      today: Math.max(0, (now - dayStart) / 10000) * runRate,') });
      e32MutProblems = [];
      for (const c of e32BuildCases(hMut)) for (const row of e32RunCase(c).rows) e32MutProblems.push(...row.problems);
    }
    check('E32 D22 可证伪：把前端 `accumulateRun()` 的**日档**算式改错一位（`/1000` → `/10000`，' +
      '`src/services/mockData.js` 的**内存副本**、盘上零字节改动）⇒ 本判据**必红**且问题串**指名**' +
      '`src/services/mockData.js`（偏离方）与当日档 —— 而月/年两档同时**保持绿**（说明判别力落在日档上）',
      e32AnchorHits === 1 && Boolean(e32MutProblems) && e32MutProblems.length > 0
      && e32MutProblems.some(p => p.includes('src/services/mockData.js'))
      && e32MutProblems.some(p => p.includes('当日档'))
      && !e32MutProblems.some(p => p.includes('本月档') || p.includes('本年档')),
      e32AnchorHits !== 1 ? `锚点命中 ${e32AnchorHits} 次（应恰 1）⇒ 判红，不许静默放过`
        : `变异后违规 ${e32MutProblems.length} 条（首条：${e32MutProblems[0]}）`);
    check('E32 D22 内存副本未落盘：`src/services/mockData.js` 逐字节未变',
      readText('src/services/mockData.js') === e32MdSrc, `${e32MdSrc.length} 字符相同`);
  }

  /* ===== M3. `E199`（＝`E72①` 的**前端一侧**）：开工数两侧口径的**登记判据** =====
     立案（`E199`，2026-10-07 由负责人裁定"各自立号"、自 `E72①` 转出）：
       `E72①` 的**服务端**一侧已由 4b 的 `T-20261005-21` 落地（`tests\harness-check.js` 第二十六节：
       服务端读数 `createStateSnapshot().stats.startedQty` ↔ **自写超集 SQL** 现算 ＋ **合成序列**，
       把 `COUNT(*)` 与 `COUNT(DISTINCT unit_index)` 两种错口径都抓住，并配 `E72①-D22`）；
       而**前端一侧** —— `src\services\mockData.js` 的**演示派生**与 `src\services\stateAdapter.js`
       映射的**生产读数** —— **没有任何对账断言** ⇒ 两侧漂移无人拦（与 `contract-check` M／M2 段
       已有的跨实现对账**不同域**：M 段比的是统计公式、M2 段比的是累计运行时长）。

     **本段在 `E199` 的二选一里选 ②「显式登记"演示派生不做跨实现对账"」**（判定与理由见下），
     并把这条登记做成**机器可判**的三条 —— 登记不能只是散文，否则下一个人只读到"有人写过一句话"：

       · **M3-①（侧内构成性等式·演示侧）** `state.stats.started ≡ min(计划, 完成 + 在测 + 待复检)`、
         `notStarted ≡ 计划 − started`。**为什么是"构成性"而不是写死数字**（ADR-0004 D21）：
         期望值由**同一帧**的其它实测字段（`done`/`testing`/`recheck`/`plan`）算出，不写手算魔数
         ⇒ 改 `planQty`／`cycleSec`／`firstPassRate`（Q-11）后期望自动跟随。
         样本**必须含"封顶生效"的那一类**：实测本班末（`elapsedSec=28799`）
         `done 179 + testing 1 + recheck 7 = 187 > 计划 180` ⇒ 封顶把 187 压到 180；
         若只取班中样本（实测班中三者和 ＝ 计划封顶**不生效**）⇒ 判据对"封顶被摘掉"是**盲的**。
         样本时刻**由班次真源现算**（班首＋2 h、班末 −1 s），不写"15:59:59"这类魔数。

       · **M3-②（生产侧映射＝纯改名，不派生）** `STATS_KEY_MAP.startedQty === 'started'`，且对一组
         刻意值（含 `0`／计划数／**实测的超计划值**（＝上面那一格的未封顶和）／`null`／非数值）
         映射结果**逐值等于入参**：数值原样（**不封顶、不重算**）、非有限数一律 `null`。
         **为什么要有这一条**："两侧不许逐值相等"的**反向**风险是"有人把生产侧改成演示口径"
         （例如顺手在映射里加一道 `Math.min(计划, …)`）—— 那也会让两侧"看起来一致"，
         而**任何跨实现相等判据都发现不了**（它比的是被改坏的那一侧）。本判据按"映射是不是纯改名"
         判断，与两侧是否相等无关。

       · **M3-③（"不做逐值对账"本身可证伪）** 把**同一班次、同一时刻**分别喂两侧，读数**刻意不同**：
         演示侧只吃 `elapsed`，生产侧只吃 `startedPieces`（同一时刻 `startedPieces=0 ⇒ 0`、
         `计划+1 ⇒ 计划+1`，**不封顶**）。两侧**没有共同入参** —— 演示侧源码里
         `startedPieces`／`unit_index`／`measure_rt` **零命中**（否定性事实：正则 `g` 计数，期望 0）
         ⇒ "前端根本拿不到件级去重入参"。故"同一组入参逐值相等"这个构造在这里**不存在**；
         而"不可比"这一结论**可被证伪**：若有人把两侧绑成同一真源（生产侧改按 `elapsed` 现算、
         或演示侧去读件级入参）⇒ 本条的"两侧读数不同"塌掉 ⇒ **必红**。

     **登记（判定＋可核理由）—— 为什么不做 `E199` 的 ①（前端 ↔ 服务端同口径逐值对账）**：
       ① **语义差别（两侧各自的取数出口，可核）**
          · 演示侧（`mockData.js` 的 `computeStats()`）：`started = min(计划, 完成＋在测＋待复检)` ——
            **时间派生量**，唯一入参是班次已进行时长（＋Q-11 配置），**无窗口、无去重**，封顶于计划数；
            它是"演示现场看起来自洽"的量，不是任何实测。
          · 生产侧（`server\services\stateSnapshot.js` 的 `statsOf()` → `startedPieces` →
            `server\services\stats.js` 的 `startedQty` → `stateAdapter.js` 的 `STATS_KEY_MAP`）：
            **件级去重计数** —— `measure_rt` 里按 `(proc_order_no, unit_index)` **去重**、
            **限定在当班 `collect_time` 窗口**、`unit_index` 缺失/非法的帧**不计入**（`FR-4.2`），
            且**不封顶于计划数**（件数允许超过计划）。
          ⇒ 单位相同（件，C-111）但**真源、窗口、去重口径全不同**，"同一组入参"不存在。
       ② **为什么**不该**逐值相等**：要让它们相等，只能**由演示侧的派生值反推** `startedPieces`
          喂给服务端（或反之）。那正是 `E67`／`E69`／`T-20260930-18`（B3-5 改法①）在**同一文件的 M 段**
          里已经**明确否掉**的"输入等价性／构造出一致"形态 —— 两侧共用一个真源，**掩盖分叉**
          （实测记录在案：旧写法下把前端 `avgTest` 改回 `runSec / done`，M 段三条谓词**全绿**）
          ⇒ 选 ① 等于把该反模式请回来，**劣于登记**。
       ③ **漂移如何被别的判据拦住（逐条给脚本名＋断言名；没拦住的照实说，不写"不会漂移"）**
          · 生产侧**取数口径（窗口＋去重）**：`harness-check` 第二十六节
            「`E72①` **开工数的跨实现可证伪构造**」＋「`E72①-D22`」（自写超集 SQL ＋ 合成序列）。
          · 生产侧**键映射（服务端键 → 前端键）**：本段 **M3-②**（纯改名、含"不得封顶"）。
          · 演示侧**封顶与同帧一致性**：本段 **M3-①**；另有 `ui-check`
            「FR-4.2/4.3 实际开工数不得超过计划总数（未开工 = 计划 − 开工）」（**不等式**，非等式）。
          · **没有拦住的（如实登记）**：演示侧 `started` 的**非封顶项**（例如把 `recheck` 从和里去掉）
            在 M3-① 之前**没有任何判据** —— 旧门禁只有"≤ 计划"这条不等式，去掉若干件待复检后
            `started` 仍 ≤ 计划（实测 187→180 这一类）⇒ **全绿**。**M3-① 是本仓第一条钉住该算式的判据。**
            另：同一个 `#sStarted` 在两种模式下**含义不同**这件事由 `E197` 的口径标注承担
            （`ui-check` U11 ／ `browser-check` B5d）—— 那是**告知**，不是**对账**。

     可证伪（ADR-0004 D22，两组；靶子都在本段内、盘上**零字节改动**）：
       (a) 摘掉演示派生的封顶（`src\services\mockData.js` 的**内存副本**，
           `Math.min(P, done + testing + recheck)` → `done + testing + recheck` ——
           **这正是"把前端 `started` 改成服务端口径"（服务端不封顶）的最小形态**）
           ⇒ M3-① **必红**并指名 `src/services/mockData.js` 与**封顶生效**的那一格
           （班中那一格同时保持绿 ⇒ 判别力确实落在封顶生效的样本上）；
       (b) 给 `stateAdapter` 的映射加一道封顶（`src\services\stateAdapter.js` 的**内存副本**）
           ⇒ M3-② **必红**并指名 `started` 这一档（超计划那一格被压回计划数）。 */
  section('M3. `E199`：开工数（`#sStarted`）两侧口径 —— 演示派生 vs 生产映射（登记"不做逐值对账"）');
  {
    /* 本段没有 runner 对象，沿用 M 段／N 段的局部包装（前提塌掉 ⇒ 记一条失败并单列原因，
       不是"环境不满足就跳过"） */
    function requires(name, ok, detail) {
      if (!ok) {
        console.log(`  [UNMET] 前提不成立：${name} —— ${detail}`);
        check(name, false, `${detail}（前提不成立，本段用例不成立、不计入通过）`);
      }
      return Boolean(ok);
    }
    const m3Conf = require('../src/config/board.config.js');
    const m3Prod = m3Conf.production;
    /* 班次真源：与 M／M2 段同一个模块（`server/services/shift.js`），不另写一份班次判定 */
    const { createShiftRules } = require('../server/services/shift');
    const m3Rules = createShiftRules(m3Conf.shift.list);
    const m3Stats = require('../server/services/stats');
    const m3Crypto = require('node:crypto');
    /** 文件的事实截止点（9.5-5 第 9 条：读数类结论必须记 SHA-256，写法 `<相对路径>@<前 12 位>`） */
    const m3Hash = rel => m3Crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, rel))).digest('hex').slice(0, 12);
    const M3_LOAD_ORDER = [
      'src/config/board.config.js', 'src/config/fieldMap.js', 'src/utils/dom.js',
      'src/utils/format.js', 'src/services/api.js', 'src/services/mockData.js',
      'src/services/mockUpperSource.js', 'src/services/stateAdapter.js'
    ];
    /** 按 index.html 的顺序加载 `src/`（多一个 `stateAdapter.js` —— 本段的"生产映射"那一侧）。
     *  `overrides` 只为 D22 的**内存副本**而设；盘上文件全程只读。 */
    function m3Harness(overrides) {
      const sandbox = { console, fetch, AbortSignal, setTimeout, clearTimeout };
      sandbox.window = sandbox;
      vm.createContext(sandbox);
      const run = rel => vm.runInContext(
        (overrides && overrides[rel] !== undefined) ? overrides[rel] : readText(rel), sandbox,
        { filename: path.join(ROOT, rel) });
      M3_LOAD_ORDER.forEach(run);
      return sandbox;
    }
    /* 样本时刻**由班次真源现算**（班首 ＋2 h、班末 −1 s），不写魔数 ⇒ 改 Q-10 班次后自动跟随 */
    const m3Shift = m3Rules.at(new Date('2026-09-18T10:00:00'));
    const m3ToDate = s => new Date(String(s).replace(' ', 'T'));
    const m3Samples = m3Shift ? [
      { label: '班中', at: new Date(m3ToDate(m3Shift.startAt).getTime() + 2 * 3600 * 1000) },
      { label: '班末', at: new Date(m3ToDate(m3Shift.endAt).getTime() - 1000) }
    ] : [];

    /** 判据本体（**纯函数**，原件与 D22 变异体共用同一把尺子）：
     *  演示侧 = `state.stats.started ≡ min(计划, 完成＋在测＋待复检)`（期望值由同帧其它字段算出，
     *  不写手算魔数，ADR-0004 D21）。 */
    function m3DemoVerdict(h) {
      return m3Samples.map(s => {
        h.window.MockData.tick(s.at);
        const st = h.window.MockData.state.stats;
        const sum = st.done + st.testing + st.recheck;
        const expectStarted = Math.min(st.plan, sum);
        const expectNotStarted = st.plan - expectStarted;
        return {
          label: s.label, at: s.at, st, sum, expectStarted, expectNotStarted,
          capBites: sum > st.plan,
          ok: st.started === expectStarted && st.notStarted === expectNotStarted
        };
      });
    }
    /** 判据本体（**纯函数**）：生产侧映射＝**纯改名**（数值原样、不封顶；非有限数一律 null） */
    function m3MapVerdict(SA, overPlan) {
      const cases = [0, 1, m3Prod.planQty, overPlan, null, 'x', undefined, NaN];
      const rows = cases.map(v => {
        const state = { stats: {} };
        const out = SA.applyServerStats(state, {
          startedQty: v, planQty: m3Prod.planQty, shift: { name: m3Shift ? m3Shift.name : null }
        });
        const want = (typeof v === 'number' && Number.isFinite(v)) ? v : null;
        return { given: v, got: out.started, want, ok: out.started === want };
      });
      const keyOk = SA.STATS_KEY_MAP.startedQty === 'started';
      return { keyOk, rows, overRow: rows.find(r => r.given === overPlan),
        ok: keyOk && rows.every(r => r.ok) };
    }
    /** 生产侧在**指定时刻**的真读数（走生产同一口：`stats.computeShiftStats()` ＋ 真映射层） */
    function m3BeAt(at, startedPieces) {
      const measures = [];
      for (let i = 0; i < 3; i++) measures.push(new Date(at.getTime() - i * 1000));
      const be = m3Stats.computeShiftStats({
        shift: m3Rules.at(at), orders: [{ planQty: m3Prod.planQty }], startedPieces,
        pieces: [], measures,
        accum: { daySec: 0, monthSec: 0, yearSec: 0, at }, addRunSec: 0, now: at
      });
      const state = { stats: {} };
      m3Harness().window.StateAdapter.applyServerStats(state, be);
      return state.stats.started;
    }

    const m3H = m3Harness();
    const m3Fe = m3DemoVerdict(m3H);
    const m3OverPlan = (m3Fe.find(r => r.capBites) || {}).sum;
    const m3MapV = m3MapVerdict(m3H.window.StateAdapter, m3OverPlan);
    const m3Late = m3Fe.find(r => r.capBites) || m3Fe[m3Fe.length - 1] || null;

    if (requires('M3 前提：班次真源能给出样本时刻所属班次（样本由班首/班末现算）',
      Boolean(m3Shift) && m3Samples.length === 2 && m3Fe.length === 2,
      `createShiftRules(boardConfig.shift).at('2026-09-18T10:00:00') ⇒ ` +
      `${m3Shift ? m3Shift.name + ' [' + m3Shift.startAt + ',' + m3Shift.endAt + ')' : 'null'}；` +
      `样本数=${m3Samples.length}`)) {
      check('M3-① `E199` 演示派生的**侧内构成性等式**：`#sStarted` 的值 ≡ min(计划, 完成 ＋ 在测 ＋ 待复检)、' +
        '`notStarted` ≡ 计划 − started（期望值由**同一帧**的其它实测字段算出、不写魔数；' +
        '样本含"封顶生效"一格 —— 否则本判据对"封顶被摘掉"是**盲的**）',
        m3Fe.every(r => r.ok) && m3Fe.some(r => r.capBites),
        m3Fe.map(r => `${r.label}：started=${r.st.started}（现算 min(${r.st.plan}, ` +
          `${r.st.done}+${r.st.testing}+${r.st.recheck}=${r.sum})＝${r.expectStarted}；封顶${r.capBites ? '**生效**' : '未生效'}）、` +
          `notStarted=${r.st.notStarted}（期望 ${r.expectNotStarted}）`).join('；') +
        `；盘上事实截止点：src/services/mockData.js@${m3Hash('src/services/mockData.js')}`);

      check('M3-② `E199` 生产侧映射＝**纯改名、不派生**：`STATS_KEY_MAP.startedQty === \'started\'`，' +
        '且 `applyServerStats()` 对刻意值（0／1／计划数／**实测超计划值**／null／字符串／undefined／NaN）' +
        '**逐值等于入参**（数值原样、**不封顶**；非有限数一律 null）—— 防"把生产侧改成演示口径"',
        m3MapV.ok,
        `STATS_KEY_MAP.startedQty=${JSON.stringify(m3H.window.StateAdapter.STATS_KEY_MAP.startedQty)}；` +
        m3MapV.rows.map(r => `${JSON.stringify(r.given)}→${JSON.stringify(r.got)}（期望 ${JSON.stringify(r.want)}）`).join('、') +
        `；超计划那一格 given=${JSON.stringify(m3OverPlan)}（计划 ${m3Prod.planQty}）⇒ 映射后 ${JSON.stringify(m3MapV.overRow && m3MapV.overRow.got)}` +
        `（若被压回 ${m3Prod.planQty} ⇒ 本条必红）；盘上事实截止点：src/services/stateAdapter.js@${m3Hash('src/services/stateAdapter.js')}`);

      /* M3-③：同班同刻两侧读数**刻意不同**＋两侧各自跟随各自真源 ＋ 演示侧对件级入参零命中 */
      const m3Pairs = m3Late ? [0, m3Prod.planQty + 1].map(sp => ({ sp, be: m3BeAt(m3Late.at, sp) })) : [];
      const m3MockSrc = readText('src/services/mockData.js');
      const m3Hits = {
        startedPieces: (m3MockSrc.match(/startedPieces/g) || []).length,
        unit_index: (m3MockSrc.match(/unit_index/g) || []).length,
        measure_rt: (m3MockSrc.match(/measure_rt/g) || []).length
      };
      check('M3-③ `E199` 登记"不做逐值对账"**本身可证伪**：同班次同时刻下两侧读数**刻意不同**、且各自' +
        '跟随各自真源（演示侧只吃 elapsed、生产侧只吃 `startedPieces`）—— 若有人把两侧绑成同一真源 ⇒ 本条必红；' +
        '**否定性事实**：演示侧源码对件级去重入参零命中（`grep -c` 口径，期望 0/0/0）',
        Boolean(m3Late) && m3Pairs.length === 2 &&
        m3Pairs.every(p => p.be === p.sp && p.be !== m3Late.st.started) &&
        m3Hits.startedPieces === 0 && m3Hits.unit_index === 0 && m3Hits.measure_rt === 0,
        `时刻 ${m3Late ? m3Late.at.toISOString() : '(无)'}（${m3Late ? m3Late.label : ''}，班次 ${m3Shift ? m3Shift.name : '?'}）：` +
        `演示侧 started=${m3Late ? m3Late.st.started : '(无)'}（＝min(计划, ${m3Late ? m3Late.sum : '?'} 未封顶和)）；` +
        `生产侧 ${m3Pairs.map(p => `startedPieces=${p.sp} ⇒ ${p.be}`).join('、')}` +
        `⇒ 两侧读数 ${m3Pairs.every(p => p.be !== (m3Late && m3Late.st.started)) ? '**全不相等**（不可比量：无共同入参）' : '出现相等（不可比量登记失效，须查）'}；` +
        `src/services/mockData.js 命中数 startedPieces=${m3Hits.startedPieces}／unit_index=${m3Hits.unit_index}／` +
        `measure_rt=${m3Hits.measure_rt}（命令：对盘上该文件跑这三个正则，期望各 0 命中）`);

      /* ---- D22(a)：摘掉演示派生的封顶（`Math.min(P, done + testing + recheck)` 的最小形态
             就是"服务端口径"：服务端 `startedQty` **不封顶**） ---- */
      const M3_ANCHOR_FE = '    const started = Math.min(P, done + testing + recheck);';
      const m3MdSrc = readText('src/services/mockData.js');
      const m3FeHits = m3MdSrc.split(M3_ANCHOR_FE).length - 1;
      const m3MutFe = m3FeHits === 1
        ? m3DemoVerdict(m3Harness({
          'src/services/mockData.js': m3MdSrc.replace(M3_ANCHOR_FE, '    const started = done + testing + recheck;')
        })) : null;
      check('M3-D22(a) 可证伪（**内存变异**）：把演示派生的**封顶**摘掉（`src\\services\\mockData.js` 的' +
        '内存副本 —— 这正是"把前端 `started` 改成服务端口径"的最小形态，服务端 `startedQty` 不封顶）' +
        '⇒ M3-① **必红**并指名该文件与**封顶生效**的那一格（班中那一格保持绿 ⇒ 判别力落在封顶样本上）',
        m3FeHits === 1 && Boolean(m3MutFe) &&
        m3MutFe.every(r => r.capBites ? !r.ok : r.ok) && m3MutFe.some(r => r.capBites && !r.ok),
        m3FeHits !== 1 ? `锚点命中 ${m3FeHits} 次（应恰 1）⇒ 判红，不许静默放过（指名 src/services/mockData.js）`
          : m3MutFe.map(r => `${r.label}：变异后 started=${r.st.started}（期望 ${r.expectStarted}）⇒ ${r.ok ? '绿' : '**红**'}`)
            .join('；') + `；盘上逐字节未变=${readText('src/services/mockData.js') === m3MdSrc}`);

      /* ---- D22(b)：给生产侧映射加一道封顶（模仿演示口径） ---- */
      const M3_ANCHOR_MAP = '      out[STATS_KEY_MAP[serverKey]] = numOrNull(s[serverKey]);';
      const m3SaSrc = readText('src/services/stateAdapter.js');
      const m3SaHits = m3SaSrc.split(M3_ANCHOR_MAP).length - 1;
      const m3MutMap = m3SaHits === 1
        ? m3MapVerdict(m3Harness({
          'src/services/stateAdapter.js': m3SaSrc.replace(M3_ANCHOR_MAP, M3_ANCHOR_MAP +
            "\n      if (STATS_KEY_MAP[serverKey] === 'started') { const p = numOrNull(s.planQty);" +
            " if (typeof out.started === 'number' && typeof p === 'number') out.started = Math.min(p, out.started); }")
        }).window.StateAdapter, m3OverPlan) : null;
      check('M3-D22(b) 可证伪（**内存变异**）：给 `stateAdapter` 的映射加一道封顶（`src\\services\\stateAdapter.js`' +
        ' 的内存副本，模仿演示口径 —— 反向漂移：把生产侧改成演示派生）⇒ M3-② **必红**并指名 `started` 档' +
        '（实测超计划那一格被压回计划数）',
        m3SaHits === 1 && Boolean(m3MutMap) && m3MutMap.ok === false &&
        Boolean(m3MutMap.overRow) && m3MutMap.overRow.ok === false,
        m3SaHits !== 1 ? `锚点命中 ${m3SaHits} 次（应恰 1）⇒ 判红，不许静默放过（指名 src/services/stateAdapter.js）`
          : `变异后超计划格 given=${JSON.stringify(m3OverPlan)} ⇒ got=${JSON.stringify(m3MutMap.overRow && m3MutMap.overRow.got)}` +
            `（期望原样 ${JSON.stringify(m3OverPlan)}）⇒ 判红=${m3MutMap.ok === false}；` +
            `盘上逐字节未变=${readText('src/services/stateAdapter.js') === m3SaSrc}`);

      check('M3-D22 内存副本未落盘：`src\\services\\mockData.js` 与 `src\\services\\stateAdapter.js` 逐字节未变' +
        '（本段只用 `vm` 里的源码字符串覆盖，禁用 `git checkout/restore`）',
        readText('src/services/mockData.js') === m3MdSrc &&
        readText('src/services/stateAdapter.js') === m3SaSrc,
        `mockData.js ${m3MdSrc.length} 字符相同=${readText('src/services/mockData.js') === m3MdSrc}；` +
        `stateAdapter.js ${m3SaSrc.length} 字符相同=${readText('src/services/stateAdapter.js') === m3SaSrc}；` +
        `sha256 前 12 位 mockData.js@${m3Hash('src/services/mockData.js')}／stateAdapter.js@${m3Hash('src/services/stateAdapter.js')}`);
    }
  }
  /* ===== N. 补传队列告警阈值：单一真源、两端同判（R26-P3-4 / E10 / IF-B.9） =====
     立案：同一「补传队列告警」概念在两侧**语义相反** —— 前端 `src/services/api.js` 按
     `max(1, floor(queueCap × 90%))` 算（容量 5000 ⇒ 要积压 **4500 条**才亮），
     服务端 `server/services/uploadQueue.js` 的 `warnThreshold` 缺省 **1**（积压 1 条即 warn），
     且 `board.config.js` 的 `mes` 段当时**只有 `queueCap`、没有共享阈值键** ⇒ 参数真源缺位，
     接线后必然口径漂移。
     本段按"断言即证据（D19）＋行为判据"钉住四件事：
       ① **同一真源**：`board.config.js` 的 `mes.queueWarnThreshold` 存在且为数值；服务端
          `queue.warnThreshold` **由它决定**（断言相等，且构造器缺省值取不到时兜底同值）；
       ② **同一真源决定两端行为**：`pending = 阈值 − 1 / 阈值` 两点上，前端（vm 跑 `src/services/api.js`
          真源码）与服务端（真 `uploadQueue` + 内存 `node:sqlite`）**同判**：不告警／告警；
       ③ **旧分歧被消除**（行为判据优先）：默认容量 5000 下，`pending = 1`（远小于 90% 容量）
          前端**必须已告警**；并静态守住"前端不再出现按容量比例推导告警线"这个写法；
       ④ **阈值可配**：把隔离沙箱里的真源改成别的值（前端 1 个探针、服务端 2 个探针 + 显式传参），
          两端判定**同步变化** —— 证明告警线真由该键决定，不是恰好等于默认值的巧合；
       ⑤ **容量键仍在**：`queueCap` 语义未被破坏（前端仍用它做"满则拒入"，服务端仍用它拒新键）。
     反证（ADR-0004 D22 定点变异，两组，均已实测）：(a) 把前端改回 `cap * 0.9` ⇒ ③(1 条) 与 ② 变红并点名；
     (b) 把服务端缺省改回**独立字面量**（不读真源、且与真源不同值）⇒ ① 与 ② 变红并点名。 */
  section('N. 补传队列告警阈值单一真源（R26-P3-4 / E10 / IF-B.9）');
  {
    /* 前置不成立时**记为失败并单列原因**（沿用 M 段 `requires` 语义，不是"环境不满足就跳过"） */
    function requires(name, ok, detail) {
      if (!ok) {
        console.log(`  [UNMET] 前提不成立：${name} —— ${detail}`);
        check(name, false, `${detail}（前提不成立，本段用例不成立、不计入通过）`);
      }
      return Boolean(ok);
    }
    /* 真源：一律从 board.config.js 读，阈值/容量都不在断言里写死（改真源即改期望，符合"参数只在配置"） */
    const confNode = require('../src/config/board.config.js');
    const capCfg = confNode.mes.queueCap;
    const thrCfg = confNode.mes.queueWarnThreshold;
    /* 真源同时驱动浏览器侧加载（contract-check 顶部 LOAD_ORDER 已加载同一份文件） */
    const capScript = CFG.mes.queueCap;
    const thrScript = CFG.mes.queueWarnThreshold;
    const thrOk = requires('补传队列告警阈值的真源存在且为数值（board.config.js mes.queueWarnThreshold）',
      typeof thrCfg === 'number' && Number.isFinite(thrCfg) && thrCfg >= 1 && capScript === capCfg &&
      thrScript === thrCfg,
      `require 侧 ${JSON.stringify(thrCfg)}（queueCap ${JSON.stringify(capCfg)}）；vm 加载侧 ` +
      `${JSON.stringify(thrScript)}（queueCap ${JSON.stringify(capScript)}）—— ` +
      '两侧读的是同一个文件，取不到或不是数值说明真源缺位/漂移');

    /* 前端探针：vm 加载**真源码**（config → fieldMap → api.js，顺序同 index.html）。
       fetch 用桩恒失败（离线，不联网）：走的就是 `uploadReport → queuePending` 这条真实入队路径。 */
    function frontProbe(n, mutate) {
      const sandbox = { console, setTimeout, clearTimeout, AbortSignal };
      sandbox.window = sandbox;
      sandbox.fetch = () => Promise.reject(new Error('contract-check N 段：故意失败，只入队不联网'));
      vm.createContext(sandbox);
      const run = rel => vm.runInContext(readText(rel), sandbox, { filename: path.join(ROOT, rel) });
      run('src/config/board.config.js');
      if (typeof mutate === 'function') mutate(sandbox.window.BoardConfig);
      run('src/config/fieldMap.js');
      run('src/services/api.js');
      const w = sandbox.window;
      w.BoardConfig.mes.baseUrl = w.BoardConfig.mes.baseUrl || 'http://127.0.0.1:1/mes';   // 非空即够（fetch 是桩）
      return (async () => {
        const rs = [];
        for (let i = 1; i <= n; i++) {
          rs.push(await w.Api.uploadReport({ uploadId: 'UP2026092610000' + String(i).padStart(2, '0') }));
        }
        const st = w.Api.getStatus();
        return { n, rs, st, cfg: w.BoardConfig };
      })();
    }

    /* 服务端探针：真 uploadQueue + 内存库（node:sqlite），入库 n 条后取告警快照 */
    function serverProbe(n, options) {
      const { DatabaseSync } = require('node:sqlite');
      const dbApi = require('../server/db');
      const { createUploadQueue } = require('../server/services/uploadQueue');
      const db = new DatabaseSync(':memory:');
      dbApi.initSchema(db);
      const q = createUploadQueue(Object.assign({
        db, now: () => new Date('2026-09-26T10:00:00')
      }, (options || {}).queueOptions));
      let fullErr = null;
      for (let i = 1; i <= n; i++) {
        try {
          q.enqueueFailed({ uploadId: 'UP2026092610000' + String(i).padStart(2, '0'), requestBody: { i } });
        } catch (err) {
          fullErr = err;   // 容量满（新键）时按设计抛错，探针如实记录
          break;
        }
      }
      const alert = q.alert();
      const count = q.pendingCount();
      db.close();
      return { n, queue: q, alert, count, fullErr };
    }

    if (thrOk) {
      /* ① 同一真源：服务端告警阈值由该键决定（构造器缺省即读它） */
      const srvDefault = serverProbe(0);
      check('R26-P3-4 ① 服务端 uploadQueue 的缺省告警阈值 = board.config.js 的 mes.queueWarnThreshold' +
        '（单一真源；不得各自硬编码）',
        srvDefault.queue.warnThreshold === thrCfg && thrCfg === srvDefault.queue.warnThreshold,
        `服务端 warnThreshold=${srvDefault.queue.warnThreshold}，真源=${thrCfg}` +
        '（若此处不等，说明服务端把阈值写成了独立字面量，接线后必然与前端漂移）');

      /* ② 同一真源决定两端行为：pending = 阈值 − 1 / 阈值 两点，两侧同判 */
      const belowFe = await frontProbe(Math.max(0, thrCfg - 1));
      const belowBe = serverProbe(Math.max(0, thrCfg - 1));
      const atFe = await frontProbe(thrCfg);
      const atBe = serverProbe(thrCfg);
      const belowSame = belowFe.st.queueAlert === false && belowBe.alert.warn === false &&
        belowFe.st.pendingCount === Math.max(0, thrCfg - 1) && belowBe.alert.pendingCount === Math.max(0, thrCfg - 1);
      const atSame = atFe.st.queueAlert === true && atBe.alert.warn === true &&
        atFe.st.pendingCount === thrCfg && atBe.alert.pendingCount === thrCfg;
      check(`R26-P3-4 ② 同一真源决定两端行为：pending = ${thrCfg - 1}（阈值 − 1）两点均**不告警**、` +
        `pending = ${thrCfg}（阈值）两点均**告警**（前端 getStatus().queueAlert ↔ 服务端 alert().warn）`,
        belowSame && atSame,
        `pending=${Math.max(0, thrCfg - 1)}：前端 ${belowFe.st.queueAlert}（${belowFe.st.pendingCount} 条）` +
        `／服务端 ${belowBe.alert.warn}（${belowBe.alert.pendingCount} 条）；` +
        `pending=${thrCfg}：前端 ${atFe.st.queueAlert}（${atFe.st.pendingCount} 条）` +
        `／服务端 ${atBe.alert.warn}（${atBe.alert.pendingCount} 条）`);

      /* ③ 旧分歧被消除（**行为判据**，优先）：默认容量下 pending = 1 前端必须已告警 */
      const fe1 = await frontProbe(1);
      check('R26-P3-4 ③ 旧分歧消除（行为判据）：默认容量 ' + capCfg + ' 下 pendingCount = 1 时前端' +
        '**必须已告警**（旧实现按容量 90% ⇒ 要积压 ' + Math.max(1, Math.floor(capCfg * 0.9)) + ' 条才亮，' +
        '与服务端"积压 1 条即 warn"两判相反）',
        fe1.st.pendingCount === 1 && fe1.st.queueAlert === true,
        `pendingCount=${fe1.st.pendingCount}，queueAlert=${fe1.st.queueAlert}，queueFull=${fe1.st.queueFull}` +
        `（容量 ${fe1.st.pendingCapacity}）；若为 false 即回到了"容量 × 90%"口径`);
      const feAtOldLine = Math.max(1, Math.floor(capCfg * 0.9));
      const feOldLine = await frontProbe(feAtOldLine);
      check('R26-P3-4 ③b 前端不得再按容量比例推导告警线：pending = ' + feAtOldLine +
        '（＝容量 ' + capCfg + ' 的 90%）时既不"因满而拒入"、也**不改变判定方向**' +
        '（该点仍告警，且 queueFull 仍为 false —— 告警线 ≠ 容量线）',
        feOldLine.st.pendingCount === feAtOldLine && feOldLine.st.queueAlert === true &&
        feOldLine.st.queueFull === false,
        `pendingCount=${feOldLine.st.pendingCount}，queueAlert=${feOldLine.st.queueAlert}，` +
        `queueFull=${feOldLine.st.queueFull}（容量 ${feOldLine.st.pendingCapacity}）`);
      /* 只在**代码行**上查（剔除以 `*`、`//`、`/*` 开头的注释行，`api.js` 的注释里会引用旧写法作对照） */
      const apiCodeN = readText('src/services/api.js')
        .split(/\r?\n/).filter(l => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
      check('R26-P3-4 ③c 静态守卫：src/services/api.js 的**代码**里不再出现"容量 × 0.9"这类隐藏阈值写法' +
        '（行为判据见 ③/③b；本条只守住写法不回潮）',
        !/cap\s*\*\s*0\.9/.test(apiCodeN) && !/0\.9\s*\*\s*cap/.test(apiCodeN),
        'api.js 代码里仍有 `cap * 0.9`：告警线被容量按比例推导，不是配置阈值');

      /* ④ 阈值可配：改真源 ⇒ 两端判定**同步**变化（不落盘任何临时改动）
         · 前端：隔离沙箱里把 mes.queueWarnThreshold 改为 thrCfg + 2；同一 pending = thrCfg 必须**不再告警**
           （若前端读的是缺省 1，或读死值，这一点会保持不变、断言即失败）；
         · 服务端：真源本身不动仓库文件，改为**显式传参**覆盖（调用方保留传参能力），
           同一 pending = thrCfg 也必须**不再告警**；阈值＝thrCfg + 2 时同一点**告警**。 */
      const thrAlt = thrCfg + 2;
      const feAlt = await frontProbe(thrCfg, cfg => {
        cfg.mes.queueWarnThreshold = thrAlt;   // 只在隔离沙箱内改，仓库文件不动
      });
      const beAltBelow = serverProbe(thrCfg, { queueOptions: { warnThreshold: thrAlt } });
      const beAltAt = serverProbe(thrAlt, { queueOptions: { warnThreshold: thrAlt } });
      check(`R26-P3-4 ④ 阈值可配：真源改为 ${thrAlt} 时，同一 pending = ${thrCfg} 的判定同步反转为` +
        '**不告警**；阈值到达时再告警（前端＝隔离沙箱改真源，服务端＝显式传参覆盖）',
        feAlt.st.pendingCount === thrCfg && feAlt.st.queueAlert === false &&
        beAltBelow.alert.pendingCount === thrCfg && beAltBelow.alert.warn === false &&
        beAltAt.alert.pendingCount === thrAlt && beAltAt.alert.warn === true,
        `前端（真源 ${thrAlt}）pending=${feAlt.st.pendingCount} → queueAlert=${feAlt.st.queueAlert}；` +
        `服务端（显式 warnThreshold=${thrAlt}）pending=${beAltBelow.alert.pendingCount} → warn=${beAltBelow.alert.warn}，` +
        `pending=${beAltAt.alert.pendingCount} → warn=${beAltAt.alert.warn}`);

      /* ⑤ 容量键仍在：queueCap 语义未被阈值改动破坏（前端"满则拒入"、服务端拒新键，两侧同判） */
      const capTight = Math.max(1, Math.min(3, capCfg));
      const feFull = await frontProbe(capTight + 1, cfg => { cfg.mes.queueCap = capTight; });
      const fullResults = feFull.rs || [];
      const firstFull = fullResults.find(r => r.queueFull === true);
      const beFull = serverProbe(capTight + 1, { queueOptions: { capacity: capTight } });
      check('R26-P3-4 ⑤ 容量键仍生效且语义未被改动：前端仍按 queueCap「满则拒入」' +
        '（不丢弃已缓存报文）、服务端仍拒新键并抛 UploadQueueFullError',
        feFull.st.pendingCapacity === capTight && feFull.st.pendingCount === capTight &&
        firstFull !== undefined && Boolean(beFull.fullErr) && beFull.fullErr.name === 'UploadQueueFullError' &&
        beFull.count === capTight,
        `前端（queueCap=${capTight}）入队 ${capTight + 1} 条 → pendingCount=${feFull.st.pendingCount}` +
        `（满后拒绝：${firstFull !== undefined ? '已拒入' : '**未拒入**'}，queueFull=${firstFull && firstFull.queueFull}）；` +
        `服务端 capacity=${capTight} → 入库 ${beFull.count} 条、第 ${capTight + 1} 条` +
        `${beFull.fullErr ? '抛 ' + beFull.fullErr.name : '**未拒收**'}`);
    }
  }

  /* ===== O. `E176①` 告警阈值边界收窄：**入口层（装配期）** 与 **真源读取层** =====
     背景（`E33①` 显式失败化留下的两条边界）：`Number()` 把 `null`／`''` 收成 `0` ⇒ `pending >= 0`
     **恒告警**；`NaN`／`Infinity` 经 `JSON.stringify` **印成 "null"** ⇒ 症状指向错方向（`E135` 同族）。
     上一节（`N`）钉的是"真源单一 ＋ 两端同判"；本节钉**收窄之后**两层的形态（实现已落，本节只写断言）：
       ① **入口层** `mountUpload(router, deps)` 的 `assertOptionTypes()`：`warnThreshold` 非法 ⇒
          **装配期**抛 `TypeError`，文案同时含键名 ＋ `String(v)` ＋ `typeof v`；且**实例未建**
          （结构取证：**同一个库**紧接着用合法值再挂载 ⇒ `reporterSource='created'`，不是 `'reused'`）；
       ② **真源读取层** `services/uploadQueue.js` 的 `configWarnThreshold()`：真源键**在场**但非法 ⇒
          **读取期**抛并**指名真源键** `mes.queueWarnThreshold`；键**缺失** ⇒ 仍走历史兜底 `1`
          （**主代理确认保留的取舍**，不是"缺失也要抛"），且 `DEFAULT_WARN_THRESHOLD` 与真源现值同值
          （＝"缺省＝真源"）；
       ③ **缺省由读取期决定**：真源改成 7 ⇒ 不显式传 `warnThreshold` 的实例就是 7（不是导入期快照）。
     ⚠ 仓储层（`repo/uploadQueue.stats()`）的同款断言在 `tests/db-check.js` 的
       「八之三之②、E176①」一节 —— 同一批、同口径，落点按层分（那里还有 D22 ㈠：守卫退回 `Number()`）。
     可证伪（ADR-0004 D22 ㈡，靶子在本节内）：把入口层那条 `> 0` 摘掉（`server/http/routes/upload.js` 的
     **内存副本**，`Module._compile`；盘上零字节改动）⇒ `mountUpload({warnThreshold: 0})` 那条断言
     **必红**：它**不再"装配期抛"**（装配通过、实例已建＝症状晚到首次 `status()`）。 */
  section('O. E176① 告警阈值边界收窄（入口期／真源读取期）');
  {
    const Module = require('node:module');
    const { DatabaseSync } = require('node:sqlite');
    const oDbApi = require('../server/db');
    const oRepo = require('../server/repo/uploadQueue.js');
    const oSvc = require('../server/services/uploadQueue.js');
    const oConfig = require('../src/config/board.config.js');
    const { createRouter } = require('../server/http/router.js');
    const { mountUpload } = require('../server/http/routes/upload.js');
    const O_REAL_THR = oConfig.mes.queueWarnThreshold;
    const O_ILLEGAL = [
      ['null', null], ["''", ''], ["'5'", '5'], ['0', 0], ['-1', -1], ['true', true], ['false', false],
      ['NaN', NaN], ['Infinity', Infinity], ['{}', {}]
    ];
    const O_LEGAL = [['1', 1], ['5', 5], ['5000', 5000], ['0.5', 0.5]];
    const oFreshDb = pending => {
      const d = new DatabaseSync(':memory:');
      oDbApi.initSchema(d);
      for (let i = 1; i <= (pending || 0); i++) {
        oRepo.enqueueFailed(d, {
          uploadId: 'UP-E176-' + String(i).padStart(3, '0'),
          interface: 'report/receiveReport', requestBody: { i }, failReason: 'contract-check O 段：造待补传'
        }, '2026-10-06 10:00:00');
      }
      return d;
    };
    const oFixedNow = () => new Date('2026-10-06T02:00:00Z');
    const oFetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
    const oCfg = () => ({
      dataSource: 'mock', device: { equipCode: 'E176-EQ' },
      mes: {
        baseUrl: '', token: '', pathTemplate: '/service/{serviceName}/{methodName}',
        responseStyle: 'status', reportPlaceholder: 65535, queueCap: 5000, queueWarnThreshold: 1
      }
    });
    /** 入口层一次试探：装配 ⇒ status() ⇒ **同一个库**再用合法值挂载（结构取证） */
    function oEntryTrial(mountFn, v, withSecond) {
      const db = oFreshDb(1);
      const errs = [];
      const router = createRouter({ getHealth: () => ({ ok: true }), onError: e => errs.push(String(e && e.message)) });
      const deps = { db, logger: null, now: oFixedNow, config: oCfg(), fetch: oFetch };
      if (v !== undefined) deps.warnThreshold = v;
      let mounted = null;
      let mountThrew = '';
      try { mounted = mountFn(router, deps); } catch (e) { mountThrew = e.name + ': ' + e.message; }
      let st = null;
      let statusThrew = '';
      try { st = mounted && mounted.status(); } catch (e) { statusThrew = e.name + ': ' + e.message; }
      let secondSource = null;
      let secondThrew = '';
      if (withSecond) {
        const router2 = createRouter({ getHealth: () => ({ ok: true }), onError: () => {} });
        try {
          const m2 = mountFn(router2, {
            db, logger: null, now: oFixedNow, config: oCfg(), fetch: oFetch, warnThreshold: 5
          });
          secondSource = m2 && m2.reporterSource;
        } catch (e) { secondThrew = e.name + ': ' + e.message; }
      }
      db.close();
      return { mountThrew, mountDone: Boolean(mounted), st, statusThrew, secondSource, secondThrew, errs };
    }
    const oBad = [];
    for (const [label, v] of O_ILLEGAL) {
      const r = oEntryTrial(mountUpload, v, true);
      const want = String(v) + '（类型 ' + typeof v + '）';
      const ok = r.mountThrew.startsWith('TypeError') && r.mountThrew.includes('warnThreshold')
        && r.mountThrew.includes(want) && r.mountDone === false && r.statusThrew === ''
        && r.secondSource === 'created' && r.secondThrew === '';
      if (!ok) {
        oBad.push(`${label}：装配=${JSON.stringify(r.mountThrew.slice(0, 60))}、同库再挂=${r.secondSource}`
          + `${r.secondThrew ? '（抛 ' + r.secondThrew.slice(0, 50) + '）' : ''}`);
      }
    }
    check('E176① 入口层非法逐例（null／\'\'／\'5\'／0／-1／true／false／NaN／Infinity／{}）⇒ **装配期**抛 ' +
      '`TypeError`（文案含 `warnThreshold` ＋ `String(v)` ＋ `typeof v`）、`status()` 根本没被调到、' +
      '**实例未建**（结构取证：同库紧接着用合法值 `5` 挂载 ⇒ `reporterSource=created`，不是 `reused`）',
      oBad.length === 0, oBad.join('；') || `${O_ILLEGAL.length} 例逐例命中`);
    {
      const zero = oEntryTrial(mountUpload, 0, false);
      check('E176① 症状面：`mountUpload({warnThreshold: 0})` ⇒ **装配期即抛**（改前是"过装配、首次 ' +
        '`status()` 才炸"＝症状晚一步），且抛点就在入口层（`> 0` 那一条）',
        zero.mountThrew.startsWith('TypeError') && zero.mountThrew.includes('> 0')
        && zero.mountDone === false && zero.statusThrew === '',
        `装配=${zero.mountThrew.slice(0, 90) || '**未抛**'}`);
    }
    {
      /* 合法逐例（1／5／5000／0.5）：**每例都把阈值两侧造出来**（pending = 2 ⇒ `1`／`0.5` 告警、`5`／`5000` 不告警）
         —— 既证"不是一律拒收"，也证 `status().alert.warn` 真的由该阈值决定（而非恰好等于缺省值）。 */
      const oLegalRows = O_LEGAL.map(([label, v]) => {
        const db = oFreshDb(2);
        const router = createRouter({ getHealth: () => ({ ok: true }), onError: () => {} });
        let m = null;
        let err = '';
        try {
          m = mountUpload(router, { db, logger: null, now: oFixedNow, config: oCfg(), fetch: oFetch, warnThreshold: v });
        } catch (e) { err = e.name + ': ' + e.message; }
        let st = null;
        let stErr = '';
        try { st = m && m.status(); } catch (e) { stErr = e.name + ': ' + e.message; }
        db.close();
        return { label, v, err, stErr, thr: st && st.warnThreshold, warn: st && st.alert && st.alert.warn,
          pending: st && st.alert && st.alert.pendingCount };
      });
      check('E176① 入口层合法逐例（1／5／5000／0.5）⇒ 装配通过、`status()` 可用，且 `warn` 判定＝' +
        '`pending >= threshold`（pending = 2 造**两侧**：`1`／`0.5` 告警、`5`／`5000` 不告警）—— 不是"一律拒收"',
        oLegalRows.every(r => r.err === '' && r.stErr === '' && r.thr === r.v && r.pending === 2
          && r.warn === (2 >= r.v)),
        oLegalRows.map(r => `${r.label}: warnThreshold=${r.thr}、pending=${r.pending}、warn=${r.warn}`
          + `${r.err || r.stErr ? '（抛 ' + (r.err || r.stErr) + '）' : ''}`).join('；'));
    }
    /* ---- 真源读取层：`configWarnThreshold()`（真源对象是 require 缓存的同一实例 ⇒ 内存改、finally 还原）---- */
    const oWithThr = (v, fn) => {
      const had = Object.prototype.hasOwnProperty.call(oConfig.mes, 'queueWarnThreshold');
      const prev = oConfig.mes.queueWarnThreshold;
      try {
        if (v === '__DELETE__') delete oConfig.mes.queueWarnThreshold;
        else oConfig.mes.queueWarnThreshold = v;
        return fn();
      } finally {
        if (had) oConfig.mes.queueWarnThreshold = prev;
        else delete oConfig.mes.queueWarnThreshold;
      }
    };
    const oSrcBad = [];
    for (const [label, v] of O_ILLEGAL) {
      const r = oWithThr(v, () => {
        try { return { v: oSvc.configWarnThreshold(), err: '' }; } catch (e) { return { v: null, err: e.name + ': ' + e.message }; }
      });
      const want = String(v) + '（类型 ' + typeof v + '）';
      if (!(r.err.startsWith('TypeError') && r.err.includes('queueWarnThreshold') && r.err.includes(want))) {
        oSrcBad.push(`${label}：${r.err || '**未抛**（读到 ' + r.v + '）'}`);
      }
    }
    check('E176① 真源读取层：真源键**在场**但非法（逐例）⇒ **读取期**抛 `TypeError` 并**指名真源键** ' +
      '`mes.queueWarnThreshold`（文案含 `String(v)` ＋ `typeof v`，不经 `JSON.stringify`）',
      oSrcBad.length === 0, oSrcBad.join('；') || `${O_ILLEGAL.length} 例逐例命中`);
    {
      const missing = oWithThr('__DELETE__', () => {
        try { return { v: oSvc.configWarnThreshold(), err: '' }; } catch (e) { return { v: null, err: e.message }; }
      });
      check('E176① **缺省＝真源**（历史口径保留，主代理确认的取舍）：真源键**缺失** ⇒ 仍走兜底 1' +
        '（不是"缺失也要抛"），且 `DEFAULT_WARN_THRESHOLD` 与真源现值同值',
        missing.err === '' && missing.v === 1 && oSvc.DEFAULT_WARN_THRESHOLD === 1
        && oConfig.mes.queueWarnThreshold === O_REAL_THR,
        `缺失 ⇒ ${missing.err ? '抛 ' + missing.err : '返回 ' + missing.v}；DEFAULT_WARN_THRESHOLD=` +
        `${oSvc.DEFAULT_WARN_THRESHOLD}；真源现值=${JSON.stringify(O_REAL_THR)}（已还原）`);
    }
    {
      const oLegalBad = [];
      for (const [label, v] of O_LEGAL) {
        const r = oWithThr(v, () => {
          try { return { v: oSvc.configWarnThreshold(), err: '' }; } catch (e) { return { v: null, err: e.message }; }
        });
        if (r.err || r.v !== v) oLegalBad.push(`${label} ⇒ ${r.err || r.v}`);
      }
      const dyn = oWithThr(7, () => oSvc.createUploadQueue({ db: oFreshDb(0), now: oFixedNow }).warnThreshold);
      check('E176① 真源合法值（1／5／5000／0.5）原样读出（读取期不归一、不回落）；且服务层缺省＝**读取期' +
        '读真源**（真源改 7 ⇒ 不显式传参的实例 `warnThreshold=7`，不是导入期快照 1）',
        oLegalBad.length === 0 && dyn === 7,
        oLegalBad.join('；') + `；真源=7 ⇒ 实例 warnThreshold=${dyn}`);
    }
    /* ---- D22 ㈡：入口层 `> 0` 支摘掉（内存副本） ---- */
    const oEntryPath = path.join(ROOT, 'server', 'http', 'routes', 'upload.js');
    const oEntrySrc = fs.readFileSync(oEntryPath, 'utf8');
    const O_ANCHOR = "if (k === 'warnThreshold' && !(v > 0)) {";
    const oAnchorHits = oEntrySrc.split(O_ANCHOR).length - 1;
    let oMutMount = null;
    if (oAnchorHits === 1) {
      const m = new Module(oEntryPath + '#e176-mut', null);
      m.filename = oEntryPath;
      m.paths = Module._nodeModulePaths(path.dirname(oEntryPath));
      m._compile(oEntrySrc.replace(O_ANCHOR, 'if (false) {'), m.filename);
      oMutMount = m.exports.mountUpload;
    }
    const oMutZero = oMutMount ? oEntryTrial(oMutMount, 0, false) : null;
    check('E176① D22 可证伪：把入口层那条 `> 0` 摘掉（`server/http/routes/upload.js` 的**内存副本**，' +
      '盘上零字节改动）⇒ `mountUpload({warnThreshold: 0})` 那条断言**必红**：它**不再"装配期抛"**' +
      '（装配通过、实例已建；症状晚到首次 `status()`）',
      oAnchorHits === 1 && Boolean(oMutZero) && oMutZero.mountThrew === '' && oMutZero.mountDone === true
      && oMutZero.statusThrew.startsWith('TypeError') && oMutZero.statusThrew.includes('warnThreshold'),
      oAnchorHits !== 1 ? `锚点命中 ${oAnchorHits} 次（应恰 1）⇒ 判红，不许静默放过`
        : (oMutZero ? `变异体：装配未抛=${oMutZero.mountThrew === ''}、实例已建=${oMutZero.mountDone}、`
          + `首次 status() ⇒ ${oMutZero.statusThrew.slice(0, 80)}` : '（未变异）'));
    check('E176① D22 内存副本未落盘：`server/http/routes/upload.js` 逐字节未变',
      fs.readFileSync(oEntryPath, 'utf8') === oEntrySrc, `${oEntrySrc.length} 字符相同`);
  }
  /* ---------------- 汇总 ---------------- */
  console.log('\n=== 汇总 ===');
  console.log(`通过 ${passed} 项，失败 ${failed0()} 项，跳过 ${skipped} 项`);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ' —— ' + f.detail : ''}`));
    process.exit(1);
  }
  process.exit(0);
}

function failed0() {
  return failures.length;
}

main().catch(err => {
  console.error('\n自检脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
