/* ==========================================================================
   实测数据仓储（server/repo/measure.js）
   作用：measure_rt 表的读写。**只做 SQL，不做业务判断**（判断在 server/services/*）。
   依据：DR-04（实测数据表）、DR-13（去重键 equipCode + procOrderNo + collectTime）、
        DR-16（时间格式 yyyy-MM-dd HH:mm:ss）、ADR-0001 D7（只落 1 s 采样）。
   依赖：仅传入的 db 句柄。
   ========================================================================== */
'use strict';

/* DR-16 时间格式：yyyy-MM-dd HH:mm:ss（恰好 19 字符）
   P2-5：`listSecondSamples` 用 `substr(collect_time,1,19)` 做 1 s 去重，该做法**只在长度恰为 19 时成立**。
   上游若给带毫秒（`...12:00:00.500`）或 ISO 带 `T`、带时区的时间，去重与"整秒取最后一条"就都会失真
   （同一秒被切成多组、MAX(collect_time) 的字典序也可能不再是时间序）。
   因此把校验放在**入库口**：格式不对直接报错，宁可拒收也不落脏数据。 */
const COLLECT_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 校验采集时间格式；不合规即抛错并指出实际值（DR-16） */
function assertCollectTime(value) {
  if (typeof value !== 'string' || !COLLECT_TIME_RE.test(value)) {
    throw new TypeError(
      `measure: collectTime 必须是「yyyy-MM-dd HH:mm:ss」（DR-16，19 字符），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 行对象 → 语句参数（字段名与 schema 列一一对应；depth 映射到 measure_depth 以免与相机深度混淆） */
function toParams(row, nowIso) {
  return [
    row.equipCode, row.procOrderNo,
    row.depth === undefined ? null : row.depth,
    row.speed === undefined ? null : row.speed,
    row.velocity_x === undefined ? null : row.velocity_x,
    row.velocity_y === undefined ? null : row.velocity_y,
    row.frameRate === undefined ? null : row.frameRate,
    row.gain === undefined ? null : row.gain,
    row.shutter === undefined ? null : row.shutter,
    row.cameraDepth === undefined ? null : row.cameraDepth,
    row.testStatus === undefined ? null : row.testStatus,
    assertCollectTime(row.collectTime),
    nowIso
  ];
}

const INSERT_SQL =
  `INSERT OR IGNORE INTO measure_rt(
     equip_code, proc_order_no, measure_depth, speed, velocity_x, velocity_y,
     frame_rate, gain, shutter, camera_depth, test_status, collect_time, created_at)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 插入一帧（按 DR-13 去重）。
 * @returns {{inserted:boolean}} 重复帧返回 inserted=false（**不算错误**，属正常去重）
 */
function insertFrame(db, row, nowIso) {
  const r = db.prepare(INSERT_SQL).run(...toParams(row, nowIso));
  return { inserted: r.changes > 0 };
}

/**
 * 批量插入（单事务）。高频落库走这里 —— 实测 5000 行/13 ms（ADR-0001 附件）。
 * @returns {{inserted:number, skipped:number, total:number}}
 */
function insertFrames(db, rows, nowIso) {
  if (!rows || rows.length === 0) return { inserted: 0, skipped: 0, total: 0 };
  const stmt = db.prepare(INSERT_SQL);
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const r = stmt.run(...toParams(row, nowIso));
      if (r.changes > 0) inserted++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { inserted, skipped: rows.length - inserted, total: rows.length };
}

/**
 * 按任务读取采样（默认按时间升序）。
 * @param {{procOrderNo:string, from?:string, to?:string, limit?:number}} q
 */
function listByTask(db, q) {
  const where = ['proc_order_no = ?'];
  const args = [q.procOrderNo];
  if (q.from) { where.push('collect_time >= ?'); args.push(q.from); }
  if (q.to) { where.push('collect_time <= ?'); args.push(q.to); }
  const limit = q.limit && q.limit > 0 ? ` LIMIT ${Number(q.limit)}` : '';
  return db.prepare(
    `SELECT * FROM measure_rt WHERE ${where.join(' AND ')} ORDER BY collect_time ASC${limit}`
  ).all(...args);
}

/**
 * 任务曲线的 1 s 采样序列（供 DR-18 固化用）。
 * 做法：按"整秒"分组取该秒最后一条 —— 500 ms 原始帧进内存，落库只留 1 s 采样（ADR-0001 D7）。
 * @param {{procOrderNo:string}} q
 */
function listSecondSamples(db, q) {
  return db.prepare(
    `SELECT substr(collect_time, 1, 19) AS second, measure_depth, speed, collect_time
       FROM measure_rt
      WHERE proc_order_no = ?
      GROUP BY second
      HAVING collect_time = MAX(collect_time)
      ORDER BY second ASC`
  ).all(q.procOrderNo);
}

/** 某任务的采样点数量（供"曲线点数与采样数一致"类断言） */
function countByTask(db, procOrderNo) {
  return db.prepare('SELECT COUNT(*) AS c FROM measure_rt WHERE proc_order_no = ?').get(procOrderNo).c;
}

/** 最早/最新采集时间（供数据新鲜度与保留策略） */
function timeRange(db, procOrderNo) {
  const row = db.prepare(
    `SELECT MIN(collect_time) AS first_time, MAX(collect_time) AS last_time
       FROM measure_rt WHERE proc_order_no = ?`
  ).get(procOrderNo);
  return { firstTime: row.first_time, lastTime: row.last_time };
}

/** 删除某时间点之前的采样（DR-14 保留策略的基础能力） */
function deleteBefore(db, cutoff) {
  const r = db.prepare('DELETE FROM measure_rt WHERE collect_time < ?').run(cutoff);
  return { deleted: r.changes };
}

module.exports = {
  insertFrame,
  insertFrames,
  listByTask,
  listSecondSamples,
  countByTask,
  timeRange,
  deleteBefore
};
