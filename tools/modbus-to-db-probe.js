/* modbus-to-db-probe.js —— 「Modbus → 落库」**端到端**探针 · **零依赖** · `tools\modbus-to-db-probe.js`
 * ---------------------------------------------------------------------------
 * 链路（**全程真件**，不改冻结面，只 require/调用）：
 *   `mock-modbus-slave`（真 TCP 从站）→ `modbus-poll-probe` 的客户端（真 TCP 主站）
 *   → 记录映射成 `upper` 帧（字段名与 `server\services\ingest.js` 的 `FIELD` 一致，`collectTime` 转 DR-16 字符串）
 *   → **直接调用 `createIngest().ingestFrame()`**（将来 Modbus 轮询器就是这条调用；HTTP 那层只是薄封装）
 *   → 用 `node:sqlite` **读回** `measure_rt` / `result` 行数与关键列 ⇒ 证据。
 *
 * 它要回答的三件事（读数、非断言）：
 *   ㈠ **同一次刷新重复送** ⇒ 服务端判 `duplicate`（键相同）⇒ **库里仍 1 行**；
 *   ㈡ **同一秒内的两次刷新**（`seq` 不同 ⇒ 键不同）⇒ 服务端判 **`raw-500ms` 不落库**（`ADR-0001` D7：1 s 采样落库）
 *      ⇒ **`IF-D.8` 的 100～500 ms 逐点，在现行落库口径下只会留 1 行/秒**；
 *   ㈢ **下一**秒的刷新 ⇒ `stored` ⇒ 库里 2 行 ⇒ 采样节奏＝**1 行/秒**得到实证；
 *   另：帧**不带 `unitIndex`（件序号）**时，`result`（`DR-05`）**不固化** ⇒ 打印 `result` 行数以示后果
 *   （⇒ 映射表必须补问 `IF-D.4` 的任务结果/进度字段，见快照 2026-10-10 段）。
 *
 * **不是门禁**（不在 `run-all` 的 suite 清单里）：它是联调夹具；**是否接门禁归负责人**（要接则断言归座位 4b）。
 * 用法：node tools\modbus-to-db-probe.js [--verbose]
 * ---------------------------------------------------------------------------
 */
'use strict';

const path = require('node:path');
const sim = require('./mock-modbus-slave.js');
const probe = require('./modbus-poll-probe.js');
const { makeTempDb } = require('../tests/lib/harness.js');
const dbmod = require('../server/db/index.js');
const { createIngest } = require('../server/services/ingest.js');

const verbose = process.argv.includes('--verbose');
const verboseInfer = process.argv.includes('--verbose');
const INFER_CYCLES = (() => { const i = process.argv.indexOf('--cycles'); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 3; })();
const EPOCH_2000 = Date.UTC(2000, 0, 1);
/** `collectTime` 必须是 DR-16 字符串（`yyyy-MM-dd HH:mm:ss[.SSS]`）——见 ingest 的 `parseCollectTime` */
const fmtCollect = (sec) => {
  const d = new Date(EPOCH_2000 + sec * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
/** Modbus 记录 ⇒ `upper` 帧（字段名与 ingest 的 `FIELD` 一致；**故意不带 `unitIndex`**，见头部 ㈢） */
const frameOf = (rec) => ({
  equipCode: rec.equipCode,
  procOrderNo: rec.procOrderNo,
  collectTime: fmtCollect(rec.collectTime),
  seq: rec.seq,
  testStatus: rec.testStatus,
  frameRate: rec.frameRate,
  gain: rec.gain,
  shutter: rec.shutter,
  cameraDepth: rec.cameraDepth,
  depth: rec.depth,
  speed: rec.speed,
  velocity_x: rec.velocity_x,
  velocity_y: rec.velocity_y
});

/* ============================ 件边界推断（`--infer-pieces`） ============================ */
/** 负责人 2026-10-10 裁定：**一个测试周期（`0→1→2→0`）恰对应一件**；且**件序号须与 MES 一致**
 *  ⇒ 本模式把"件"算在**进入 `testStatus=2`（判定窗口）**上，并**自生成递增件序号**（同一工单内从 1 起、按完成顺序）
 *  —— 与 `IF-D.4` 的件序号口径同形的**降级路径**（对方给值则以对方为准并校核）。
 *  要看三样读数：①推断出的件数 ②`measure_rt.unit_index` **不再为 NULL** ③`result` 表**按件固化**（行数＝件数）。
 *  注：`result` 的判定值依赖标准/典型值（`Q-39` 归口甲方、现场录入）—— 本模式只验"**按件固化**"这件事。 */
async function inferPieces(cycles = 3) {
  const handle = makeTempDb({ name: 'infer-pieces' });
  const opened = dbmod.openDb(handle.path, {});
  handle.adopt(opened.db);
  dbmod.initSchema(handle.db, '2026-10-10 11:00:00');
  const db = handle.db;
  const ingest = createIngest({ db, now: () => new Date() });
  const slave = sim.createSlave({ unit: 1 });
  const srv = await sim.startServer(slave, { port: 0, host: '127.0.0.1' });
  const port = srv.address().port;
  const opts = { port, unit: 1, host: '127.0.0.1' };
  const base = Date.UTC(2026, 9, 10, 11, 0, 0);
  let sec = 0, prev = null, piece = 1;
  const rows = [];
  const step = async (testStatus) => {
    slave.refresh({ testStatus, frameRate: 500, gainX10: 125, shutter: 800, cameraDepthX100: 450, depthX100: 480,
      speedX100: 500, vxX100: 210, vyX100: 241, setDepthX100: 500, setGainX10: 100, setFrameRate: 400 }, base + sec * 1000);
    sec += 1;
    const rec = await probe.pollOnce(opts);
    const cur = rec.testStatus;
    const enteredJudgement = prev !== 2 && cur === 2;          /* 进入判定窗口 ⇒ 该件完成 */
    const frame = { ...frameOf(rec), unitIndex: piece };       /* **我方自生成的件序号**（同一工单内从 1 起） */
    const r = ingest.ingestFrame(frame);
    rows.push({ sec: sec - 1, testStatus: cur, enteredJudgement, unitIndex: piece, outcome: r.outcome, stored: r.stored });
    if (verboseInfer) console.log(`[infer] t=${sec - 1}s ts=${cur} ${enteredJudgement ? '← 记一件' : '        '} unitIndex=${piece} outcome=${r.outcome}`);
    if (prev === 2 && cur !== 2) piece += 1;                   /* 离开判定窗口 ⇒ 转到下一件 */
    prev = cur;
  };
  for (let c = 0; c < cycles; c++) for (const st of [0, 1, 2, 0]) await step(st);
  const inferred = piece - 1;
  const measure = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN unit_index IS NULL THEN 1 ELSE 0 END) AS nul FROM measure_rt').get();
  const resultRows = db.prepare('SELECT COUNT(*) AS n FROM result').get().n;
  const perPiece = db.prepare('SELECT unit_index, COUNT(*) AS n FROM measure_rt WHERE unit_index IS NOT NULL GROUP BY unit_index ORDER BY unit_index').all();
  console.log('\n[infer] 读数：');
  console.log(`        驱动 ${cycles} 个完整周期（每个 0→1→2→0，每秒一帧）`);
  console.log(`        ① **推断件数 = ${inferred}**（＝周期数）`);
  console.log(`        ② \`measure_rt\` 行数 ${measure.n}，其中 \`unit_index\` 为 NULL 的 ${measure.nul} 行`);
  console.log(`        ③ **\`result\` 按件固化 = ${resultRows} 行**（＝件数 ${resultRows === inferred ? '✓' : '⚠ 不等'}）`);
  console.log(`        逐件落库行数：${perPiece.map(r => `件${r.unit_index}→${r.n}行`).join('　')}`);
  console.log('        ⇒ 结论读数：**即使贵方不提供 `IF-D.4`，件数与按件固化也能自洽**（`IF-D.4` 由阻塞项降为**校核项**）');
  srv.close();
  handle.close();
}

/* ============================ 经**真服务端装配层**（`--via-server`） ============================ */
/** 上一个模式（`--infer-pieces`）直接调 `createIngest()` ⇒ **绕过了装配层**，所以看不到 `result` 固化。
 *  本模式**起动真服务端**（`server\index.js` 的 `start()`：挂 `/ifd/frame` ＋ 在 `onSampled` 上接
 *  `judge.evaluate()`／`persistJudgement()`），用 **HTTP 推送**把"我方自生成件序号"的帧送进去，
 *  再把 `GET /ifd/status` 的 `resultWrite` 计数与库里的 `result` 行数**读回来**。
 *  ⇒ 这才是"**按件固化**"的端到端证据（`DR-05`）。数据根与库文件都落在 `tests\._verify` 的临时目录内。 */
async function viaServer(cycles = 3) {
  const { makeTempDir, allocPort } = require('../tests/lib/harness.js');
  const dir = makeTempDir('e2e-server');
  const port = await allocPort();   /* harness 的 `allocPort()` 是**异步**的（真试探空闲端口） */
  process.env.DSH_ENV = 'test';
  process.env.DSH_BOARD_HOST = '127.0.0.1';
  process.env.DSH_BOARD_PORT = String(port);
  process.env.DSH_BOARD_DATA_DIR = dir;
  process.env.DSH_BOARD_DB_FILE = path.join(dir, 'board.db');
  const serverEntry = require('../server/index.js');
  /* ②-0b **DR-03 标准**：判定的阈值来自 `standard` 表（`getEffectiveStandard`），而它**没有 IF-A 的 HTTP 入口**
     （`/ifa/process` 只写 `op_log` 留痕）⇒ 只能走仓储层 `standardRepo.addVersion()`（＝界面/录入路径的同一出口）。
     阈值取"包住我方模拟数据"的区间（depth 4.8／speed 3.2）⇒ 预期判**合格**。 */
  const fix0 = require('../tests/lib/fixture.js');   /* 就地取（避免与下方的 `fixture` 声明撞 TDZ） */
  const seedDb = new (require('node:sqlite').DatabaseSync)(path.join(dir, 'board.db'));
  dbmod.initSchema(seedDb, '2026-10-10 00:00:00');
  const stdRes = { ok: true, info: '' };
  try {
    require('../server/repo/standard.js').addVersion(seedDb, {
      productCode: fix0.standard.productCode, processCode: fix0.task.processNo,
      depthTypical: 4.8, depthUpperDev: 0.5, depthLowerDev: -0.5,
      speedTypical: 5.0, speedUpperDev: 1.5, speedLowerDev: -1.5,
      setDepth: fix0.standard.setDepth, setGain: fix0.standard.setGain,
      setFrameRate: fix0.standard.setFrameRate, setShutter: fix0.standard.setShutter
    }, '2026-10-10 00:00:00', '2026-10-10 00:00:00');
    stdRes.info = 'addVersion 成功（无校验豁免）';
  } catch (err) {
    stdRes.ok = false; stdRes.info = 'addVersion 抛错：' + err.message.slice(0, 120);
  }
  seedDb.close();
  console.log(`[via-server] DR-03 标准种子：${stdRes.ok ? '✓' : '✗'} ${stdRes.info}`);
  const srv = await serverEntry.start();
  console.log(`[via-server] 真服务端已起 127.0.0.1:${srv.port}（数据根 ${dir}）`);

  /* ②-0 灌种子：判定需要"任务(procOrderNo) → 标准(产品,工序,生效版本)"
     ⇒ 先按 IF-A 形态把**派工**与**工艺标准**写进去（时间窗覆盖我方帧的 collectTime），否则判定无所依、`result` 不产生。 */
  const fixture = require('../tests/lib/fixture.js');
  const ORDER = 'PO-20261010-P1';
  const seedTask = {
    ...fixture.task, procOrderNo: ORDER, productCode: fixture.standard.productCode,
    planStartTime: '2026-10-10 19:00:00', planEndTime: '2026-10-10 23:00:00'
  };
  const seedStd = { ...fixture.standard, procOrderNo: ORDER, processNo: fixture.task.processNo, effectiveFrom: '2026-10-10 00:00:00' };
  const postJson = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${srv.port}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const t = await r.text();
    return { status: r.status, body: t.slice(0, 700) };
  };
  const s0 = await postJson('/ifa/device', { ...fixture.device, equipCode: 'EQ-UC-001' });
  const s1 = await postJson('/ifa/dispatch', seedTask);
  const s2 = await postJson('/ifa/process', seedStd);
  console.log(`[via-server] 种子：POST /ifa/device ⇒ HTTP ${s0.status}${s0.status >= 300 ? ' ' + s0.body : ''}；` +
    `POST /ifa/dispatch ⇒ HTTP ${s1.status}${s1.status >= 300 ? ' ' + s1.body : ''}；POST /ifa/process ⇒ HTTP ${s2.status}${s2.status >= 300 ? ' ' + s2.body : ''}`);

  const slave = sim.createSlave({ unit: 1 });
  slave.refresh({ procOrderNo: ORDER, equipCode: 'EQ-UC-001' });   /* 让帧里的工单号与种子的派工一致 */
  const sim_ = await sim.startServer(slave, { port: 0, host: '127.0.0.1' });
  const opts = { port: sim_.address().port, unit: 1, host: '127.0.0.1' };
  const base = Date.UTC(2026, 9, 10, 12, 0, 0);
  let sec = 0, prev = null, piece = 1;
  const steps = [];
  const step = async (testStatus) => {
    slave.refresh({ testStatus, frameRate: 500, gainX10: 125, shutter: 800, cameraDepthX100: 450, depthX100: 480,
      speedX100: 500, vxX100: 210, vyX100: 241, setDepthX100: 500, setGainX10: 100, setFrameRate: 400 }, base + sec * 1000);
    sec += 1;
    const rec = await probe.pollOnce(opts);
    const cur = rec.testStatus;
    const entered = prev !== 2 && cur === 2;
    const frame = { ...frameOf(rec), unitIndex: piece };
    const res = await fetch(`http://127.0.0.1:${srv.port}/ifd/frame`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(frame)
    });
    const body = await res.json().catch(() => null);
    steps.push({ sec: sec - 1, testStatus: cur, entered, unitIndex: piece, status: res.status, outcome: body && body.outcome });
    if (verboseInfer) console.log(`[via-server] t=${sec - 1}s ts=${cur} unitIndex=${piece} HTTP ${res.status} outcome=${body && body.outcome}`);
    if (prev === 2 && cur !== 2) piece += 1;
    prev = cur;
  };
  for (let c = 0; c < cycles; c++) for (const st of [0, 1, 2, 0]) await step(st);

  const stRes = await fetch(`http://127.0.0.1:${srv.port}/health`);
  const stRaw = await stRes.text();
  let status = null;
  try { status = JSON.parse(stRaw); } catch { /* 非 JSON：下面按原文报 */ }
  const ifdRes = await fetch(`http://127.0.0.1:${srv.port}/ifd/status`);
  let ifd = null;
  try { ifd = JSON.parse(await ifdRes.text()); } catch { /* 忽略 */ }
  const rw = status && status.resultWrite ? status.resultWrite : null;
  await serverEntry.stop();
  sim_.close();

  /* 读回库（服务端已停 ⇒ 新开只读连接） */
  const { DatabaseSync } = require('node:sqlite');
  const ro = new DatabaseSync(path.join(dir, 'board.db'));
  const measure = ro.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN unit_index IS NULL THEN 1 ELSE 0 END) AS nul FROM measure_rt').get();
  const resultRows = ro.prepare('SELECT COUNT(*) AS n FROM result').get().n;
  const perPiece = ro.prepare('SELECT unit_index, COUNT(*) AS n FROM measure_rt WHERE unit_index IS NOT NULL GROUP BY unit_index ORDER BY unit_index').all();
  const resultDetail = ro.prepare('SELECT proc_order_no, unit_index, result FROM result ORDER BY unit_index').all();
  ro.close();

  console.log('\n[via-server] 读数（**经真服务端装配层**）：');
  console.log(`        驱动 ${cycles} 个完整周期；HTTP 推送 ${steps.length} 帧（HTTP 非 2xx 的 ${steps.filter(s => !(s.status >= 200 && s.status < 300)).length} 帧）`);
  console.log(`        ① 推断件数 = ${piece - 1}（＝周期数）`);
  console.log(`        ② \`measure_rt\` 行数 ${measure.n}，\`unit_index\` 为 NULL 的 ${measure.nul} 行（逐件：${perPiece.map(r => `件${r.unit_index}→${r.n}行`).join('　')}）`);
  console.log(`        ③ **\`result\` 行数 = ${resultRows}**（＝件数 ${resultRows === piece - 1 ? '✓' : '⚠ 不等'}）`);
  console.log(`        ④ GET /health ⇒ HTTP ${stRes.status}${status ? '' : '（非 JSON：' + stRaw.slice(0, 80) + '）'}；GET /ifd/status ⇒ HTTP ${ifdRes.status}`);
  if (ifd) {
    const c = ifd.counts || {};
    console.log(`           /ifd/status counts：accepted=${c.accepted} stored=${c.stored} duplicate=${c.duplicate} raw500ms=${c.raw500ms} rejected=${c.rejected} **sampledHookFailures=${c.sampledHookFailures}**`);
    if (ifd.lastSampledHookError) console.log(`           lastSampledHookError=${JSON.stringify(ifd.lastSampledHookError).slice(0, 200)}`);
  }
  if (status) {
    const c = status.counts || {};
    console.log(`           /health counts：accepted=${c.accepted} stored=${c.stored} duplicate=${c.duplicate} rejected=${c.rejected} sampledHookFailures=${c.sampledHookFailures}`);
    if (rw) console.log(`           **/health.resultWrite：writes=${rw.writes} failures=${rw.failures} skippedNoUnit=${rw.skippedNoUnit}** lastError=${rw.lastError === null ? 'null' : JSON.stringify(rw.lastError).slice(0, 160)}`);
    if (status.warningWrite) console.log(`           /health.warningWrite：writes=${status.warningWrite.writes} failures=${status.warningWrite.failures}`);
    if (status.taskRows !== undefined) console.log(`           库内 task 行数=${status.taskRows}`);
  }
  if (resultDetail.length) console.log(`        逐件结果：${resultDetail.map(r => `件${r.unit_index}=${r.result}`).join('　')}`);
  console.log(`        ⇒ 结论读数：**件数统计与件序号落库跑通**；**按件固化（\`DR-05\`）${resultRows === piece - 1 ? '跑通' : '未产生行'}**` +
    (resultRows === piece - 1 ? '' : ' ⇒ 前置条件未满足，看上列 `sampledHookFailures`／`lastError`（**不是件序号的问题**）'));
}

/* ============================ 帧不带工单号/设备编号 ⇒ 由本机注入（`--no-order`） ============================ */
/** 负责人 2026-10-12 问："`procOrderNo` 工单编号仅限我方和 MES 方，不再涉及上位机方的通讯了。是否可行"。
 *  本模式把它变成**两段读数**：
 *   ㈠ **必要性**：帧里**不带** `procOrderNo` 时，`ingestFrame()` 必以 `MISSING_FIELD` **拒收**（`REQUIRED_FIELDS` 三条之一）；
 *   ㈡ **可行性**：由本机**注入**（工单号＝本机当前派工〔此处模拟 IF-A 来源〕；设备编号＝**从站地址 → 设备台账**映射）
 *      之后，落库／去重／（`unit_index`）行为**与带值帧完全一致**。
 *  ⇒ 结论：**可行**，但**"注入"这一步必须真的做**（不改 `ingest` 的必填口径）。 */
async function noOrder(cycles = 3) {
  const handle = makeTempDb({ name: 'no-order' });
  const opened = dbmod.openDb(handle.path, {});
  handle.adopt(opened.db);
  dbmod.initSchema(handle.db, '2026-10-10 11:00:00');
  const db = handle.db;
  const ingest = createIngest({ db, now: () => new Date() });
  const slave = sim.createSlave({ unit: 1 });
  const srv = await sim.startServer(slave, { port: 0, host: '127.0.0.1' });
  const opts = { port: srv.address().port, unit: 1, host: '127.0.0.1' };
  const base = Date.UTC(2026, 9, 12, 9, 0, 0);
  /* 本机两张"权威表"（现场分别来自 IF-A 派工 与 设备台账；此处按现场口径写死做夹具） */
  const LOCAL_ACTIVE_ORDER = 'PO-20261012-A';          /* ＝ 本机当前派工（IF-A 权威；FR-3.1） */
  const LOCAL_DEVICE_BY_UNIT = { 1: 'EQ-UC-001' };     /* ＝ 从站地址 → 设备台账映射（**仅对账备用**：equipCode 过渡期照收上位机方自定值） */
  const frameOfNoIds = (rec) => {                       /* 帧里**不含** procOrderNo（**equipCode 由上位机方带来，保留**） */
    const f = frameOf(rec); delete f.procOrderNo; return f;
  };
  const inject = (f) => Object.assign({}, f, { procOrderNo: LOCAL_ACTIVE_ORDER });   /* 只注入工单号 */
  let prev = null, piece = 1, sec = 0;
  const step = async (testStatus, { withInject, noRefresh = false }) => {
    if (!noRefresh) {
      slave.refresh({ testStatus, frameRate: 500, gainX10: 125, shutter: 800, cameraDepthX100: 450, depthX100: 480,
        speedX100: 500, vxX100: 210, vyX100: 241, setDepthX100: 500, setGainX10: 100, setFrameRate: 400 }, base + sec * 1000);
      sec += 1;
    }
    const rec = await probe.pollOnce(opts);
    const bare = frameOfNoIds(rec);
    const frame = withInject ? inject(bare) : bare;
    if (withInject) frame.unitIndex = piece;
    const cur = rec.testStatus;
    const r = ingest.ingestFrame(frame);
    if (prev === 2 && cur !== 2) piece += 1;
    prev = cur;
    return r;
  };

  /* ㈠ 必要性：不带工单号 ⇒ 必被拒收 */
  const bare = await step(1, { withInject: false });
  console.log('\n[no-order] ㈠ **必要性**（帧里不带 `procOrderNo`）：');
  console.log(`        outcome=${bare.outcome}｜stored=${bare.stored}｜reason=${JSON.stringify(bare.reason || bare.error || bare.rejection || null).slice(0, 160)}`);
  console.log(`        ⇒ 与 ` + '`REQUIRED_FIELDS = [equipCode, procOrderNo, collectTime]`' + ` 一致：**注入这一步不能省**`);

  /* ㈡ 可行性：注入后跑 3 个周期（含同刷新重复送与同秒两次刷新） */
  prev = null; piece = 1;
  const rows = [];
  for (let c = 0; c < cycles; c++) {
    rows.push(await step(0, { withInject: true }));
    rows.push(await step(1, { withInject: true }));
    rows.push(await step(2, { withInject: true }));
    rows.push(await step(2, { withInject: true, noRefresh: true }));   /* **不刷新**再送一次 ⇒ 同键 ⇒ 应判 duplicate */
    rows.push(await step(0, { withInject: true }));
  }
  const n = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN unit_index IS NULL THEN 1 ELSE 0 END) AS nul FROM measure_rt').get();
  const kinds = rows.reduce((a, r) => (a[r.outcome] = (a[r.outcome] || 0) + 1, a), {});
  console.log('\n[no-order] ㈡ **可行性**（本机注入 **工单号＝当前派工**〔IF-A 权威〕之后；`equipCode` 由帧带来）：');
  console.log(`        送帧 ${rows.length} ⇒ ` + Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join('｜'));
  console.log(`        \`measure_rt\` 行数 ${n.n}（\`unit_index\` 为 NULL 的 ${n.nul} 行）｜件数推断 ${piece - 1}`);
  console.log('        ⇒ 结论读数：**落库/去重/件序号行为与带值帧一致 ⇒ 工单号归口我方注入 = 可行**（来源＝IF-A 权威〔FR-3.1〕）');
  console.log('        ⚠ 更正（负责人 2026-10-12）：**`equipCode` 不归我方注入** —— 过渡期**照收上位机方自定值**（MES 口径定了再对齐；『从站地址→台账』仅作对账备用）');
  console.log('        ⚠ 已裁（负责人 2026-10-12「按建议」）：①**跨工单切换瞬间**以 **IF-A 派工生效时间窗**为准，**窗口外不落库＋计数＋告警**②**无派工就开测** ⇒ **不兜底**（不落库＋告警，不编造工单号）');
  srv.close();
  handle.close();
}

async function main() {
  /* ① 临时库（一用例一库；WAL）＋ schema */
  const handle = makeTempDb({ name: 'modbus-to-db' });
  const opened = dbmod.openDb(handle.path, {});
  handle.adopt(opened.db);
  dbmod.initSchema(handle.db, '2026-10-10 11:00:00');   /* 第二参数必须是**字符串**（SQLite 不能绑 Date；与 db-check 的 NOW 同形） */
  const db = handle.db;
  const ingest = createIngest({ db, now: () => new Date() });
  const countOf = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

  /* ② 真从站（进程内） */
  const slave = sim.createSlave({ unit: 1, verbose: false });
  const srv = await sim.startServer(slave, { port: 0, host: '127.0.0.1' });
  const port = srv.address().port;
  const opts = { port, unit: 1, host: '127.0.0.1' };
  console.log(`[e2e] 从站已起 127.0.0.1:${port}；临时库 ${handle.path}`);

  const rows = [];
  const post = async (tag) => {
    const rec = await probe.pollOnce(opts);
    const frame = frameOf(rec);
    const r = ingest.ingestFrame(frame);
    const n = countOf('measure_rt');
    rows.push({ tag, key: probe.keyOf(rec), collectTime: frame.collectTime, seq: rec.seq, outcome: r.outcome, stored: r.stored, measureRt: n, resultRows: countOf('result') });
    console.log(`[e2e] ${String(tag).padEnd(26)} outcome=${String(r.outcome).padEnd(10)} stored=${String(r.stored).padEnd(5)} measure_rt=${n} result=${countOf('result')} key=${probe.keyOf(rec)}`);
    return r;
  };

  /* ③ 场景㈠：一次刷新，连送 3 次（同键 ⇒ 后两次应判 duplicate） */
  const baseMs = Date.UTC(2026, 9, 10, 10, 30, 0);
  slave.refresh({ testStatus: 1, frameRate: 500, gainX10: 125, shutter: 800, cameraDepthX100: 450, depthX100: 480,
    speedX100: 320, vxX100: 210, vyX100: 241, setDepthX100: 500, setGainX10: 100, setFrameRate: 400 }, baseMs);
  for (let i = 1; i <= 3; i++) await post(`㈠ 同刷新第 ${i} 次`);

  /* ④ 场景㈡：**同一秒内**再刷新一次（`seq` +1 ⇒ 键不同 ⇒ 预期 raw-500ms、不落库） */
  slave.refresh({ testStatus: 2 }, baseMs + 400);
  await post('㈡ 同秒第二次刷新');

  /* ⑤ 场景㈢：**下一秒**再刷新（预期 stored、库里 +1） */
  slave.refresh({ testStatus: 0 }, baseMs + 1500);
  await post('㈢ 下一秒刷新');

  /* ⑥ 读回明细 */
  const detail = db.prepare('SELECT collect_time, test_status, measure_depth, camera_depth, speed, unit_index FROM measure_rt ORDER BY collect_time').all();
  console.log('\n[e2e] measure_rt 明细（collect_time / test_status / measure_depth / camera_depth / speed / unit_index）：');
  for (const r of detail) console.log(`        ${r.collect_time}  ts=${r.test_status}  depth=${r.measure_depth}  cam=${r.camera_depth}  speed=${r.speed}  unit_index=${r.unit_index === null ? 'NULL' : r.unit_index}`);

  /* ⑦ 结论读数（**只报数，不做验收断言**） */
  const dup = rows.filter(r => r.outcome === 'duplicate').length;
  const raw = rows.filter(r => r.outcome === 'raw-500ms').length;
  const sto = rows.filter(r => r.outcome === 'stored').length;
  console.log('\n[e2e] 读数汇总：');
  console.log(`        总送帧 ${rows.length} ⇒ stored ${sto}｜duplicate ${dup}｜raw-500ms ${raw}｜rejected ${rows.filter(r => r.outcome === 'rejected').length}`);
  console.log(`        measure_rt 行数 ${countOf('measure_rt')}｜result 行数 ${countOf('result')}（**帧不带件序号 ⇒ 不固化**）`);
  console.log(`        ㈠ 同刷新重复送 ⇒ 后 ${dup} 次判 duplicate（键相同）`);
  console.log(`        ㈡ 同秒第二次刷新 ⇒ ${raw === 1 ? '按 ADR-0001 D7 判 raw-500ms、**不落库**' : '⚠ 未按预期判 raw-500ms'}`);
  console.log(`        ㈢ 下一秒刷新 ⇒ stored，库里二次出现该秒 ⇒ **1 行/秒**`);
  console.log('        （⇒ `IF-D.8` 的 100～500 ms 逐点，在现行「1 s 采样落库」口径下**只留 1 行/秒**；要逐点入库须改 `ADR-0001` D7 —— 属决策项）');

  if (verbose) console.log('[e2e] 明细行：' + JSON.stringify(rows, null, 2));
  srv.close();
  handle.close();
}

if (require.main === module) {
  const run = process.argv.includes('--infer-pieces') ? () => inferPieces(cyclesArg())
    : process.argv.includes('--via-server') ? () => viaServer(cyclesArg())
      : process.argv.includes('--no-order') ? () => noOrder(cyclesArg())
        : () => main();
  run().catch((err) => { console.error('\n[脚本异常] 脚本异常终止：' + (err && err.stack ? err.stack : err)); process.exit(2); });
}
function cyclesArg() { return Number.isFinite(INFER_CYCLES) && INFER_CYCLES > 0 ? INFER_CYCLES : 3; }
module.exports = { frameOf, fmtCollect, inferPieces, viaServer };
