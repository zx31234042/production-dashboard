/* ==========================================================================
   本地库结构自检（tests/db-check.js）
   作用：用**一用例一库**的方式验证 schema.sql 与仓储层是否满足 DR-01～DR-19：
        建表齐全、字段与三方映射对齐、去重键生效、事务可回滚、曲线按件固化、
        备份可校验、保留策略只删该删的行。
   依据：DR-04 / DR-13 / DR-14 / DR-15 / DR-16 / DR-18 / DR-19；ADR-0003（一用例一库）。
   句柄约定：全程使用 `handle.db`；需要换连接时**必须**用 `handle.adopt()`，
             否则夹具自建连接不被跟踪 → Windows 上临时目录删不掉（曾实际踩到）。
   运行：node tests/db-check.js
   退出码：0 = 全部通过；1 = 有断言失败。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const env = require('./env');
const { createRunner } = require('./lib/assert');
const { makeTempDb } = require('./lib/harness');
const fixture = require('./lib/fixture');
const db = require('../server/db');
const maintain = require('../server/db/maintain');
const measureRepo = require('../server/repo/measure');
const curveRepo = require('../server/repo/curve');

env.assertRuntime();
const t = createRunner('本地库结构自检（db-check）');
const NOW = '2026-09-19 10:00:00';

/** 需求 V1.28 第 7 章要求存在的表（DR-01～DR-12、DR-18） */
const REQUIRED_TABLES = [
  'device', 'task', 'standard', 'measure_rt', 'result', 'shift_stat',
  'alarm', 'warning', 'maintenance', 'notice', 'upload_log', 'op_log', 'task_curve'
];

/** 关键列（列名缺失即视为不满足对应 DR） */
const REQUIRED_COLUMNS = {
  device: ['equip_code', 'equip_name', 'upper_host', 'mes_base_url'],
  task: ['proc_order_no', 'batch_no', 'product_code', 'product_name', 'drawing_no',
    'plan_qty', 'plan_start_time', 'plan_end_time', 'status'],
  standard: ['product_code', 'set_depth', 'set_gain', 'set_frame_rate', 'set_shutter', 'effective_from'],
  measure_rt: ['equip_code', 'proc_order_no', 'measure_depth', 'speed', 'velocity_x',
    'velocity_y', 'frame_rate', 'gain', 'shutter', 'camera_depth', 'test_status', 'collect_time'],
  result: ['proc_order_no', 'unit_index', 'result', 'judged_at', 'retest_count'],
  shift_stat: ['shift_date', 'shift_name', 'plan_qty', 'started_qty', 'qualified_qty',
    'failed_qty', 'pass_rate', 'run_sec', 'idle_sec', 'oee'],
  alarm: ['alarm_code', 'alarm_type', 'level', 'occurred_at', 'brief', 'action', 'close_state'],
  warning: ['warn_type', 'trigger_cond', 'triggered_at', 'state'],
  maintenance: ['content', 'maint_time', 'handler', 'accept_state', 'cycle_days', 'next_due_at'],
  notice: ['category', 'content', 'valid_from', 'valid_to', 'priority', 'created_by'],
  upload_log: ['upload_id', 'interface', 'request_body', 'response_code', 'elapsed_ms',
    'retry_count', 'state'],
  op_log: ['op_time', 'operator', 'op_type', 'content', 'result'],
  task_curve: ['proc_order_no', 'unit_index', 'kind', 'samples', 'sample_count',
    'interval_sec', 'duration_sec', 'min_value', 'max_value', 'finished_at']
};

/** 附录 2 的 13 字段 → 落库位置（uploadId 落在上传日志表，不在实测表） */
const REPORT_TO_COLUMN = {
  equipCode: 'equip_code', procOrderNo: 'proc_order_no',
  frameRate: 'frame_rate', gain: 'gain', shutter: 'shutter',
  cameraDepth: 'camera_depth', depth: 'measure_depth',
  speed: 'speed', velocity_x: 'velocity_x', velocity_y: 'velocity_y',
  collectTime: 'collect_time', testStatus: 'test_status'
};

async function main() {
  /* ---------------- 一、建表与结构 ---------------- */
  t.section('一、建表与结构（DR-01～DR-12、DR-18）');
  const handle = makeTempDb({ name: 'schema' });
  const opened = db.openDb(handle.path, {});
  handle.adopt(opened.db);                     // 走 adopt：夹具自建连接仍被跟踪
  const info = db.initSchema(handle.db, NOW);
  t.check('打开库时 WAL 模式生效', opened.journalMode === 'wal', `journal_mode=${opened.journalMode}`);
  t.check('建表脚本执行成功并写入结构版本', info.schemaVersion === db.SCHEMA_VERSION,
    `schema_version=${info.schemaVersion}`);
  db.initSchema(handle.db, NOW);                // 再跑一次验幂等
  t.check('重复初始化是幂等的（可重复执行）',
    db.getSchemaVersion(handle.db) === db.SCHEMA_VERSION, '');

  const tables = db.listTables(handle.db);
  const missing = REQUIRED_TABLES.filter(x => !tables.includes(x));
  t.check(`需求要求的 ${REQUIRED_TABLES.length} 张表全部存在`, missing.length === 0,
    missing.length ? `缺失：${missing.join(', ')}` : `实际 ${tables.length} 张（含 schema_meta）`);

  const colProblems = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = db.listColumns(handle.db, table);
    const miss = cols.filter(c => !actual.includes(c));
    if (miss.length) colProblems.push(`${table} 缺 ${miss.join('/')}`);
  }
  t.check('各表关键列齐全', colProblems.length === 0, colProblems.join('；'));
  t.check('完整性检查通过', db.verifyIntegrity(handle.db).ok, '');

  /* ---------------- 二、字段与三方映射对齐 ---------------- */
  t.section('二、字段与三方映射对齐（附录 2 的 13 项必须都能落库）');
  const measureCols = db.listColumns(handle.db, 'measure_rt');
  const uploadCols = db.listColumns(handle.db, 'upload_log');
  const unmapped = [];
  for (const f of fixture.REPORT_FIELDS) {
    if (f === 'uploadId') {
      if (!uploadCols.includes('upload_id')) unmapped.push('uploadId → upload_log.upload_id');
      continue;
    }
    const col = REPORT_TO_COLUMN[f];
    if (!col || !measureCols.includes(col)) unmapped.push(`${f} → ${col || '(未映射)'}`);
  }
  t.check('附录 2 的 13 个上报字段都有落库列（uploadId 落 upload_log）',
    unmapped.length === 0 && fixture.REPORT_FIELDS.length === 13,
    unmapped.length ? `未映射：${unmapped.join(', ')}` : `已映射 ${fixture.REPORT_FIELDS.length} 项`);
  t.check('相机深度与航行器深度分列存放（camera_depth ≠ measure_depth）',
    measureCols.includes('camera_depth') && measureCols.includes('measure_depth'), '');

  /* ---------------- 三、写入与去重键（DR-13） ---------------- */
  t.section('三、写入与去重键（DR-13）');
  const anchor = fixture.makeFrame({ at: '2026-09-19 10:00:00', i: 0 });
  const first = measureRepo.insertFrame(handle.db, anchor, NOW);
  const second = measureRepo.insertFrame(handle.db, anchor, NOW);
  t.check('首帧写入成功', first.inserted === true, '');
  t.check('同一 (equipCode, procOrderNo, collectTime) 再写被去重（不算错误）',
    second.inserted === false && measureRepo.countByTask(handle.db, anchor.procOrderNo) === 1,
    `表内 ${measureRepo.countByTask(handle.db, anchor.procOrderNo)} 行`);

  /* 批次时间必须与首帧**错开**，否则会被去重键正确拦下（那是上一句验过的行为） */
  const frames = fixture.makeFrames({ count: 60, startAt: '2026-09-19 12:00:00', startIndex: 1000 });
  const batch = measureRepo.insertFrames(handle.db, frames, NOW);
  t.check('批量写入走单事务且计数正确',
    batch.inserted === 60 && batch.skipped === 0, JSON.stringify(batch));

  const dupBatch = measureRepo.insertFrames(handle.db, frames.slice(0, 10), NOW);
  t.check('批量重复写入全部被去重', dupBatch.inserted === 0 && dupBatch.skipped === 10,
    JSON.stringify(dupBatch));

  /* ---------------- 四、事务与回滚 ---------------- */
  t.section('四、事务与回滚');
  const before = measureRepo.countByTask(handle.db, anchor.procOrderNo);
  const badRows = [
    fixture.makeFrame({ at: '2026-09-19 13:00:00', i: 2000 }),
    { procOrderNo: 'PO-ROLLBACK', collectTime: '2026-09-19 13:00:01' }  // 缺 equipCode → NOT NULL 失败
  ];
  let threw = false;
  try {
    measureRepo.insertFrames(handle.db, badRows, NOW);
  } catch {
    threw = true;
  }
  const after = measureRepo.countByTask(handle.db, anchor.procOrderNo);
  t.check('批量事务中某行失败 → 整批回滚（无部分写入）',
    threw && after === before, `抛错=${threw}，行数 ${before} → ${after}`);

  /* ---------------- 五、重启后不丢数据（DR-17 的库侧前提） ---------------- */
  t.section('五、重启后不丢数据');
  const liveBefore = handle.liveConnections();
  const reopened = handle.reopen();             // 夹具会关掉更早的连接，避免文件占用
  t.check('重开会关闭更早连接（避免文件占用导致临时目录删不掉）',
    liveBefore === 2 && handle.liveConnections() === 1,
    `活跃连接 ${liveBefore} → ${handle.liveConnections()}`);
  t.check('重开后行数不变且去重键仍生效',
    reopened === handle.db &&
    measureRepo.countByTask(handle.db, anchor.procOrderNo) === before &&
    measureRepo.insertFrame(handle.db, anchor, NOW).inserted === false,
    `重开后 ${measureRepo.countByTask(handle.db, anchor.procOrderNo)} 行`);

  /* ---------------- 六、任务曲线按件固化（DR-18 / DR-19） ---------------- */
  t.section('六、任务曲线按件固化（DR-18 / DR-19）');
  t.check('无曲线时 count=0（界面据此走空态，不抛错）', curveRepo.count(handle.db) === 0, '');
  t.check('latestCurve 在无数据时返回 null',
    curveRepo.latestCurve(handle.db, { kind: 'depth' }) === null, '');

  const depthCurve = fixture.makeCurve({ kind: 'depth', count: 160 });
  const saved = curveRepo.saveCurve(handle.db, depthCurve, NOW);
  t.check('固化一条曲线：采样点数与体积符合预期',
    saved.sampleCount === 160 && saved.sizeBytes > 800 && saved.sizeBytes < 1200,
    `${saved.sampleCount} 点 / ${saved.sizeBytes} 字节`);

  const roundTrip = curveRepo.getCurve(handle.db, depthCurve.procOrderNo, 1, 'depth');
  t.check('读回的采样序列与写入完全一致（JSON 往返无损）',
    JSON.stringify(roundTrip.samples) === JSON.stringify(depthCurve.samples), '');
  t.check('量程上下限与采样点一致（供图下标注）',
    roundTrip.minValue === Math.min(...depthCurve.samples) &&
    roundTrip.maxValue === Math.max(...depthCurve.samples), '');
  t.check('durationSec 语义为秒（≠ 采样点数，避免与 sampleCount 混同）',
    roundTrip.durationSec === 160 && roundTrip.sampleCount === 160 && roundTrip.intervalSec === 1, '');

  curveRepo.saveCurve(handle.db, fixture.makeCurve({ kind: 'depth', count: 160 }), NOW);
  t.check('同一件同一类型重复固化 → 覆盖而非新增行',
    curveRepo.count(handle.db, 'depth') === 1, `depth 曲线 ${curveRepo.count(handle.db, 'depth')} 条`);

  curveRepo.saveCurve(handle.db, fixture.makeCurve({ kind: 'speed', count: 160 }), NOW);
  const latest = curveRepo.latestCurve(handle.db, { kind: 'depth' });
  t.check('latestCurve 只按类型取最近一条',
    Boolean(latest) && latest.kind === 'depth' && latest.sampleCount === 160,
    latest ? `${latest.kind} ${latest.sampleCount} 点` : 'null');

  /* ---------------- 七、备份（DR-15 / DEP-08） ---------------- */
  t.section('七、备份与校验（DR-15 / DEP-08）');
  const backupDir = path.join(env.paths.tempRoot, 'backup-case');
  const bk = await maintain.backupTo(handle.db, backupDir,
    { name: maintain.backupName(new Date(2026, 8, 19, 10, 0, 0)) });
  t.check('在线备份生成文件且体积 > 0', fs.existsSync(bk.path) && bk.bytes > 0,
    `${path.basename(bk.path)} ${bk.bytes} 字节`);
  const verified = maintain.verifyBackup(bk.path);
  t.check('备份文件可打开、完整且含建好的表',
    verified.ok && verified.tables >= REQUIRED_TABLES.length,
    `integrity=${verified.detail}，表 ${verified.tables} 张`);
  t.check('备份前做了 WAL checkpoint（备份自包含）',
    bk.checkpoint.ok === true, bk.checkpoint.error || '');

  for (let i = 1; i <= 3; i++) {
    await maintain.backupTo(handle.db, backupDir,
      { name: maintain.backupName(new Date(2026, 8, 19, 10, 0, i)) });
  }
  const pruned = maintain.pruneBackups(backupDir, 2);
  t.check('保留策略只保留最近 N 份并删除其余',
    maintain.listBackups(backupDir).length === 2 && pruned.removed.length === 2,
    `保留 ${maintain.listBackups(backupDir).length} 份，删除 ${pruned.removed.length} 份`);

  /* ---------------- 八、保留策略（DR-14 保留 1 年） ---------------- */
  t.section('八、数据保留策略（DR-14）');
  const oldFrame = fixture.makeFrame({ at: '2024-01-01 00:00:00', i: 3000 });
  const newFrame = fixture.makeFrame({ at: '2026-09-19 12:00:00', i: 3001 });
  measureRepo.insertFrames(handle.db, [oldFrame, newFrame], NOW);
  const ret = maintain.applyRetention(handle.db, { days: 365, now: new Date('2026-09-19T12:00:00') });
  const remainsOld = measureRepo.listByTask(handle.db,
    { procOrderNo: oldFrame.procOrderNo, from: '2024-01-01 00:00:00', to: '2024-01-01 23:59:59' }).length;
  const remainsNew = measureRepo.listByTask(handle.db,
    { procOrderNo: newFrame.procOrderNo, from: '2026-09-19 12:00:00', to: '2026-09-19 12:00:00' }).length;
  t.check('超过 1 年的采样被删除、未超期的保留',
    remainsOld === 0 && remainsNew === 1,
    `cutoff=${ret.cutoff}，旧数据 ${remainsOld} 行 / 新数据 ${remainsNew} 行`);
  t.check('保留策略返回各类删除计数（可审计）',
    typeof ret.deleted.measure_rt === 'number' && 'task_curve' in ret.deleted,
    JSON.stringify(ret.deleted));

  /* ---------------- 九、清理与残留 ---------------- */
  t.section('九、临时区与残留');
  const strayDb = fs.readdirSync(env.paths.tempRoot).filter(n => /\.db(-wal|-shm)?$/.test(n));
  t.check('临时库文件都不在临时区根目录（各用例自有子目录，不会互相干扰）',
    strayDb.length === 0, strayDb.slice(0, 3).join(', '));

  fs.rmSync(backupDir, { recursive: true, force: true });
  const tempDir = handle.dir;
  const closeProblems = handle.close();
  const leftover = fs.existsSync(tempDir);
  t.check('用例结束清理临时库（关闭全部连接后目录可删，且不静默吞错）',
    !leftover && closeProblems.length === 0,
    leftover
      ? `残留：${path.relative(env.paths.root, tempDir)}；问题：${closeProblems.join(' / ') || '（close 未报错，说明仍有未跟踪的连接）'}`
      : '');

  t.finish();
}

try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
