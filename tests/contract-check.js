/* ==========================================================================
   第三方字段契约与适配层自检（tests/contract-check.js）
   作用：把 tests/README.md 第 6.1～6.7 项里**可离线执行**的部分脚本化，覆盖：
         A. 附录 2 契约（13 字段）↔ config/fieldMap.js 的 boardToReport
         B. 上位机报文契约：fieldMap.upperToBoard ↔ samplePayload ↔ mockUpperSource ↔ tools/mock-upper
         C. services/api.js 的 IF-D 行为（缺字段容错 / 冻结判定 / 配置化生效）
         D. services/api.js 的 IF-B 行为（13 字段上报 / 两种回执风格 / 失败补传）
         E. ?source=upper 端到端链路（内置模拟上位机的取帧顺序）
         F. IF-D 降级接线：数据冻结时界面判据 state.device.link 是否跟随（IF-D.9）
         G. 派生统计量的收敛与累计一致性（当班统计非负、累计运行不倒退、待办与自检可闭环）
         H. 界面渲染安全：公告/检修录入走 innerHTML 时的转义（FR-7.12、FR-6.11）
         I. 交付物 .docx 的 ZIP/OPC 条目名结构
         J. 文档与源码的版本号、附录 2 项数一致性
         K. 现状快照（非缺陷）：口径占位项，变了就提醒重新确认
         L. 常量集中化：颜色字面量、维保/耗材阈值是否走配置（PROJECT_RULES 五章）
   依赖：仅 Node 内置模块；不联网（只连本机回环端口）、不启动浏览器。
   运行：node tests/contract-check.js
   退出码：0 = 全部通过；1 = 有断言失败（失败项即待修缺陷）。
   对应需求：IF-C.1（三方映射表）、IF-B.8（附录 2 共 13 字段）、IF-B.9（失败补传）、
             IF-D.9（断连/数据冻结）、FR-2.6、Q-21、Q-23
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

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

/** 取需求文档当前基线版本号（文件名里的 Vx.y，排除 历史文件/） */
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
  /* ===== A. 附录 2 契约：需求清单 V1.27 §6.4 字段表 ↔ fieldMap.boardToReport ===== */
  section('A. 附录 2 上报字段契约（IF-B.8 / IF-C.1）');
  const APPENDIX2 = [
    'equipCode', 'procOrderNo', 'frameRate', 'gain', 'shutter', 'cameraDepth', 'depth',
    'speed', 'velocity_x', 'velocity_y', 'collectTime', 'testStatus', 'uploadId'
  ];
  const reportKeys = Object.keys(MAP.boardToReport);
  check('附录 2（需求清单 V1.27 §6.4 表）共 13 个字段', APPENDIX2.length === 13, `实际 ${APPENDIX2.length}`);
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

    CFG.mes.baseUrl = `http://127.0.0.1:${portStatus}`;
    CFG.mes.retry.baseDelayMs = 0;
    const flushed = await Api.flushPending();
    check(
      '补传：链路恢复后 flushPending 补齐队列（6.10 后半）',
      flushed.sent === 1 && flushed.left === 0,
      `sent=${flushed.sent}，left=${flushed.left}`
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
      '接线：main.js 调用 Api.flushPending（IF-B.9 补传必须被触发）',
      /Api\.flushPending\s*\(/.test(readText('src/main.js')),
      'src/main.js 未调用 flushPending，失败报文只进队列、永不补传（P1-2）'
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
      const idx = lines.findIndex(l => /附录\s*2/.test(l) && /共\s*\d+\s*项/.test(l));
      let declared = null;
      const rows = [];
      if (idx >= 0) {
        declared = Number(lines[idx].match(/共\s*(\d+)\s*项/)[1]);
        for (let i = idx + 1; i < lines.length; i++) {
          const l = lines[i].trim();
          if (!l.startsWith('|')) { if (rows.length) break; else continue; }
          if (/^\|[\s:|-]+\|$/.test(l) || l.includes('字段标识')) continue;
          rows.push(l);
        }
      }
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
    check(
      '稼动率仍由配置常量推导（Q-11 口径占位）',
      oee.every(v => Math.abs(v - expect) < 1e-9),
      `实测 oee=${oee.join(' / ')}%，runRate*100=${expect}%（若已改为真实口径，请同步更新界面说明）`
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
