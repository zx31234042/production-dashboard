/* ==========================================================================
   第三方字段契约与适配层自检（tests/contract-check.js）
   作用：把 tests/README.md 第 6.1～6.7 项里**可离线执行**的部分脚本化，覆盖：
         A. 附录 2 契约（13 字段）↔ config/fieldMap.js 的 boardToReport
         B. 上位机报文契约：fieldMap.upperToBoard ↔ samplePayload ↔ mockUpperSource ↔ tools/mock-upper
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
/* mock-mes.js 是 CLI：入口处读 process.argv 后立刻监听端口，所以在进程内改 argv 再 require 即可 */
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

  const portStatus = 18899;
  const portCode = 18898;
  const portFail = 18897;
  const started = await Promise.all([
    startMockMes({ port: portStatus, receipt: 'status', failRate: 0 }),
    startMockMes({ port: portCode, receipt: 'code', failRate: 0 }),
    startMockMes({ port: portFail, receipt: 'status', failRate: 1 })
  ]);
  if (!started.every(Boolean)) {
    skip('IF-B 回执与补传联调（6.8～6.10）', '本机回环端口 18897～18899 未能全部监听');
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
    /* 临时把容量收窄到 1：待补传已有 1 条，告警位必须**当场重算**为 true。
       否则"状态/告警字段确实被刷新"就无从证明（写死的 false 也会通过）。 */
    CFG.mes.queueCap = 1;
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
      flushed.capacity === statusAfterFlush.pendingCapacity && flushed.capacity === 1 &&
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
    const ok = await startMockMes({ port: 18896, receipt: 'status', failRate: 1 });
    if (!ok) {
      skip('自检项与待补传队列/回执风格的一致性', '本机回环端口 18896 未能监听');
    } else {
      const h = createIsolatedHarness({});
      h.window.BoardConfig.mes.baseUrl = 'http://127.0.0.1:18896';
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
