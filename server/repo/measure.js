/* ==========================================================================
   实测数据仓储（server/repo/measure.js）
   作用：measure_rt 表的读写。**只做 SQL，不做业务判断**（判断在 server/services/*）。
   依据：DR-04（实测数据表）、DR-13（去重键 equipCode + procOrderNo + collectTime）、
        DR-16（时间格式 yyyy-MM-dd HH:mm:ss）、ADR-0001 D7（只落 1 s 采样）。
        V1.41 / C-111：DR-04 **增列件序号 `unit_index`**（＝IF-D.4 的 `unitIndex`，**采集落库时写入**）
        —— 入参 `row.unitIndex` 为"合法件序号（≥1 的整数）"或**缺省/`null`（＝本帧没有件序号）**；
        本层**不做**合法值判定（那是 `services/ingest.js` 的 `parseUnitIndex()`），也**不做**"缺省 1"
        这类兜底：`unit_index` 是"这一帧测的是哪一件"的事实，冒充件序号会把一票多件静默归并成一件。
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

/** 校验时间文本格式（DR-16）；不合规即抛错并指出实际值。
 *  与 `server/repo/uploadQueue.js` 的 `assertTime` 同款、同参数名（field='cutoff'）——
 *  删除口的入参与写入口同罪：`collect_time < ?` 是**文本比较**，一旦混入非时间文本，
 *  `WHERE` 的语义就不再是"某时刻之前"，而是"全部"（实测 `'garbage'` ⇒ 全表被删且照常返回行数）。 */
function assertTime(value, field) {
  if (typeof value !== 'string' || !COLLECT_TIME_RE.test(value)) {
    throw new TypeError(
      `measure: ${field} 必须是「yyyy-MM-dd HH:mm:ss」（DR-16，19 字符），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 行对象 → 语句参数（字段名与 schema 列一一对应；depth 映射到 measure_depth 以免与相机深度混淆）
 *
 *  ⚠ **按位置绑定**：本数组的次序必须与 `INSERT_SQL` 的列清单**逐位一致**，而 `INSERT_SQL` 的列清单
 *  又必须与 `server/db/schema.sql` 的 `measure_rt` 建表段逐位一致（`unit_index` 紧邻 `proc_order_no`
 *  —— 依据需求 V1.41 §7 DR-04 的字段次序）。**错位不会报错、只会静默写错列**，故三处改动必须同批做，
 *  并由 `tests\._verify\zz3b-unitindex-probe.js` 的**逐列回读**守着（不只看行数）。 */
function toParams(row, nowIso) {
  return [
    row.equipCode, row.procOrderNo,
    /* 件序号（V1.41 / C-111）：**缺值/非法一律 NULL**。这里**不**做"缺省 1"这类兜底 ——
       `unit_index` 是"这一帧测的是哪一件"的事实，用 1 冒充会把一票多件静默归并成一件
       （与本仓 `server/index.js` 的 `unitIndexOf()`、`services/judge.js` 的"拿不到不说"同一纪律）。
       合法值的判定（整数、≥1、数字字符串归一）在**服务层** `services/ingest.js` 的 `parseUnitIndex()`
       —— 仓储层"只做 SQL、不做业务判断"（本文件头），故这里只负责"没有就写 NULL"。 */
    row.unitIndex === undefined ? null : row.unitIndex,
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
    nowIso,
    /* 端点标识（V1.45 第 11 处 / `DR-13`）：**追加在参数表尾**（与 `schema.sql` 的表尾列、`INSERT_SQL` 的末位一致）。
       未提供 ⇒ 记为该设备的**默认端点**（＝`equipCode`），与 `services\endpointLink.js` 的
       `resolveEndpointId()` 回退链同口径 —— 旧调用方无需改动，且**不会**因 NULL
       （SQLite 唯一索引里 NULL 互不相等）而使去重失效。 */
    (row.endpoint === undefined || row.endpoint === null || String(row.endpoint).trim() === '')
      ? row.equipCode : String(row.endpoint).trim()
  ];
}

/* 列清单＝`server/db/schema.sql` 的 measure_rt 声明次序（`endpoint` **追加在表尾**，与前 13 列的列序解耦）。
   ⚠ 幂等键 `ux_measure_rt(equip_code, proc_order_no, endpoint, collect_time)`（`DR-13`，V1.45 第 11 处）
   —— 2026-10-19 起**端点标识已入键**（此前为三列、无 endpoint）。 */
const INSERT_SQL =
  `INSERT OR IGNORE INTO measure_rt(
     equip_code, proc_order_no, unit_index, measure_depth, speed, velocity_x, velocity_y,
     frame_rate, gain, shutter, camera_depth, test_status, collect_time, created_at, endpoint)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 插入一帧（按 DR-13 去重）。
 *
 * 注（P3 表外 code-17）：这里每次调用都 `prepare` 一次（批量路径 `insertFrames` 才 prepare 一次）。
 * **已实测，不必优化**：单条路径每次 prepare 比复用语句只多 **2.74 µs**
 * （2000 次实测：4.06 µs vs 1.32 µs/次），而 500 ms 收一帧的节拍下占比约 **0.0005%**；
 * 引入语句缓存需处理连接生命周期（本模块是无状态函数、只拿传入的 db 句柄），复杂度不划算。
 * 若日后改成"每帧都落库"或节拍明显变快，再回来复核这个结论。
 *
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

/** 删除某时间点之前的采样（DR-14 保留策略的基础能力）。cutoff 必须是「yyyy-MM-dd HH:mm:ss」 */
function deleteBefore(db, cutoff) {
  assertTime(cutoff, 'cutoff');
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
