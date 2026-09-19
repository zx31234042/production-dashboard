/* ==========================================================================
   任务曲线仓储（server/repo/curve.js）
   作用：task_curve 表的读写。每完成一件固化一条完整曲线；页面读取"最近一条"绘制。
   依据：DR-18（任务曲线表）、DR-19（采样与固化）、FR-3.15 / UI-19（按任务完成更新一次、
        不做秒级刷新、无已完成任务时显示空态）。
   依赖：仅传入的 db 句柄。
   ========================================================================== */
'use strict';

const INSERT_SQL =
  `INSERT INTO task_curve(proc_order_no, unit_index, kind, samples, sample_count,
                          interval_sec, duration_sec, min_value, max_value, finished_at, created_at)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(proc_order_no, unit_index, kind) DO UPDATE SET
     samples = excluded.samples, sample_count = excluded.sample_count,
     interval_sec = excluded.interval_sec, duration_sec = excluded.duration_sec,
     min_value = excluded.min_value, max_value = excluded.max_value,
     finished_at = excluded.finished_at, created_at = excluded.created_at`;

/**
 * 固化一条曲线（幂等：同任务同件同类型重复固化会覆盖，不产生重复行）。
 * @param {object} curve 见 tests/lib/fixture.js 的 makeCurve()：含 samples 数组
 * @returns {{id:number|null, sampleCount:number, sizeBytes:number}}
 */
function saveCurve(db, curve, nowIso) {
  const samples = Array.isArray(curve.samples) ? curve.samples : [];
  const payload = JSON.stringify(samples);
  const row = db.prepare(INSERT_SQL).run(
    curve.procOrderNo, curve.unitIndex === undefined ? 1 : curve.unitIndex, curve.kind,
    payload, samples.length,
    curve.intervalSec === undefined ? 1 : curve.intervalSec,
    curve.durationSec === undefined ? samples.length : curve.durationSec,
    curve.minValue === undefined ? null : curve.minValue,
    curve.maxValue === undefined ? null : curve.maxValue,
    curve.finishedAt, nowIso
  );
  return {
    id: row.lastInsertRowid === undefined ? null : Number(row.lastInsertRowid),
    sampleCount: samples.length,
    sizeBytes: Buffer.byteLength(payload, 'utf8')
  };
}

/** 读取一条曲线（samples 解析回数组） */
function getCurve(db, procOrderNo, unitIndex, kind) {
  const r = db.prepare(
    'SELECT * FROM task_curve WHERE proc_order_no = ? AND unit_index = ? AND kind = ?'
  ).get(procOrderNo, unitIndex, kind);
  return r ? hydrate(r) : null;
}

/**
 * 读取"最近一条已完成任务"的曲线（设备状态页要画的就是它）。
 * @param {{kind:string, procOrderNo?:string}} q
 */
function latestCurve(db, q) {
  const args = [q.kind];
  let sql = 'SELECT * FROM task_curve WHERE kind = ?';
  if (q.procOrderNo) { sql += ' AND proc_order_no = ?'; args.push(q.procOrderNo); }
  sql += ' ORDER BY finished_at DESC, id DESC LIMIT 1';
  const r = db.prepare(sql).get(...args);
  return r ? hydrate(r) : null;
}

/** 某任务已固化的曲线列表（不含 samples 内容，便于列表展示） */
function listByTask(db, procOrderNo) {
  return db.prepare(
    `SELECT id, proc_order_no, unit_index, kind, sample_count, interval_sec,
            duration_sec, min_value, max_value, finished_at
       FROM task_curve WHERE proc_order_no = ?
      ORDER BY unit_index ASC, kind ASC`
  ).all(procOrderNo);
}

/** 曲线总数（供空态断言：为 0 时界面必须显示空态而非抛错） */
function count(db, kind) {
  if (kind) return db.prepare('SELECT COUNT(*) AS c FROM task_curve WHERE kind = ?').get(kind).c;
  return db.prepare('SELECT COUNT(*) AS c FROM task_curve').get().c;
}

/** 删除某完成时间之前的曲线（DR-14 保留策略） */
function deleteBefore(db, cutoff) {
  const r = db.prepare('DELETE FROM task_curve WHERE finished_at < ?').run(cutoff);
  return { deleted: r.changes };
}

/** 行 → 对象（把 JSON 文本解析回数组） */
function hydrate(row) {
  return {
    id: row.id,
    procOrderNo: row.proc_order_no,
    unitIndex: row.unit_index,
    kind: row.kind,
    samples: JSON.parse(row.samples),
    sampleCount: row.sample_count,
    intervalSec: row.interval_sec,
    durationSec: row.duration_sec,
    minValue: row.min_value,
    maxValue: row.max_value,
    finishedAt: row.finished_at
  };
}

module.exports = { saveCurve, getCurve, latestCurve, listByTask, count, deleteBefore };
