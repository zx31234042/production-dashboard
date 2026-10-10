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
      speedX100: 320, vxX100: 210, vyX100: 241, setDepthX100: 500, setGainX10: 100, setFrameRate: 400 }, base + sec * 1000);
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
  if (process.argv.includes('--infer-pieces')) {
    inferPieces(Number.isFinite(INFER_CYCLES) && INFER_CYCLES > 0 ? INFER_CYCLES : 3)
      .catch((err) => { console.error('\n[脚本异常] 脚本异常终止：' + (err && err.stack ? err.stack : err)); process.exit(2); });
  } else {
    main().catch((err) => { console.error('\n[脚本异常] 脚本异常终止：' + (err && err.stack ? err.stack : err)); process.exit(2); });
  }
}
module.exports = { frameOf, fmtCollect, inferPieces };
