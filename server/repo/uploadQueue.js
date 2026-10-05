/* ==========================================================================
   上报队列仓储（server/repo/uploadQueue.js）
   作用：**上报流水与失败待补传队列的落库读写**（技术债 E10 / IF-B.10）—— 把失败的上报报文写进
        `upload_log`（DR-11），进程重启后由 `listPending()` 原样读回，不再"重启即丢"；
        成功上报由 `recordSuccess()` 记同一张表（三态留痕：成功 / 失败 / 待补传）。
        **只做 SQL，不做业务判断**（容量上限、告警、重报流程在 server/services/uploadQueue.js）。
   依据：IF-B.9（上报失败本地缓存）、NFR-13（数据不丢失）、DR-11（MES 上传日志表）、
        DR-16（时间格式 yyyy-MM-dd HH:mm:ss）、ADR-0002 D11（不碰平台专有行为）。
   表与列（沿用 `server/db/schema.sql` 的既有约定：小写下划线、时间文本 19 字符）：
        upload_log.upload_id     幂等键（uploadId，同接口内唯一，ux_upload_log_id）
        upload_log.interface     接口名，形如 `report/receiveReport`（serviceName/methodName）
        upload_log.request_body  请求报文（JSON 文本）
        upload_log.response_code 响应码 / 传输错误码（`网络错误`、`无回执`、`本机错误`）
        upload_log.response_body 响应报文原文（有回执时为回执 JSON，无回执时为失败详情）
        upload_log.elapsed_ms    本次请求耗时（毫秒）
        upload_log.retry_count   已重报次数（人工重报每次 +1）
        upload_log.state         状态：`待补传` / `成功` / `失败`
        upload_log.created_at    创建时间
        upload_log.fail_reason   失败原因（E10 字段，建表语句在 `server/db/schema.sql` 的 upload_log 段）
        upload_log.updated_at    最近一次状态变更时间（E10 字段，同上）
   表结构**唯一真源**：`server/db/schema.sql`（`SCHEMA_VERSION = '3'`）。
    本模块**不做运行时补列 / 迁移**（原先的 `ensureColumns()` 已删除）：旧库缺列时应按
    `SCHEMA_VERSION` 判据显式迁移或重建，而不是让仓储层静默 `ALTER TABLE`。
   用法：
     const repo = require('./repo/uploadQueue');
     repo.enqueueFailed(db, { uploadId, interface, requestBody, responseCode,
                              responseBody, elapsedMs, failReason }, '2026-09-20 10:00:00');
     repo.listPending(db, { limit: 50 });
   ========================================================================== */
'use strict';

/* DR-16 时间格式：yyyy-MM-dd HH:mm:ss（恰好 19 字符）。
   P2-5 的同类教训（见 server/repo/measure.js）：格式不对会让"按时间排序/取最旧"失真，
   故在**入库口**校验，宁可拒收也不落脏数据。 */
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 队列状态词（与 schema.sql 的 state 注释一致；SQL 里按字面量比较，禁改词形） */
const STATE = {
  PENDING: '待补传',
  SUCCESS: '成功',
  FAILED: '失败'
};

/** 单条失败原因的最大留存长度（防止把整页 HTML 错误页塞进库里） */
const FAIL_REASON_MAX = 500;

/** 校验时间文本格式（DR-16）；不合规即抛错并指出实际值 */
function assertTime(value, field) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new TypeError(
      `uploadQueue: ${field} 必须是「yyyy-MM-dd HH:mm:ss」（DR-16，19 字符），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 失败原因归一：转字符串、去首尾空白、超长截断；空值返回 null */
function normalizeReason(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > FAIL_REASON_MAX ? s.slice(0, FAIL_REASON_MAX) : s;
}

/** 请求/响应报文归一：字符串原样、对象转 JSON、空值存 null */
function normalizeBody(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return '[无法序列化]'; }
}

/** 毫秒耗时归一：非有限数或负数一律记 null（不落脏数字） */
function normalizeElapsed(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

const INSERT_FAILED_SQL =
  `INSERT INTO upload_log(upload_id, interface, request_body, response_code, response_body,
                          elapsed_ms, retry_count, state, created_at, fail_reason, updated_at)
   VALUES(?, ?, ?, ?, ?, ?, 0, '待补传', ?, ?, ?)
   ON CONFLICT(upload_id, interface) DO UPDATE SET
     request_body = excluded.request_body,
     response_code = excluded.response_code,
     response_body = excluded.response_body,
     elapsed_ms = excluded.elapsed_ms,
     state = excluded.state,
     fail_reason = excluded.fail_reason,
     updated_at = excluded.updated_at`;

/**
 * 落一条失败上报（待补传）。
 *
 * 幂等：同一 (uploadId, interface) 重复入队**覆盖**原行（不产生第二条）——
 * 重报后仍失败走 `markRetryFailed()`，同一条报文只会有一行，`retry_count` 单调累加。
 *
 * `created` 的判定（A1 修）：**不能**拿 `run().changes` 当"是否新增" ——
 * SQLite 的 `INSERT … ON CONFLICT DO UPDATE` 走覆盖分支时 `changes` 同样是 1，
 * 于是"重复入队"会被误报成新增。故这里**先查存在性再 upsert**（命中 `ux_upload_log_id` 唯一索引）。
 *
 * @param {object} db
 * @param {{uploadId:string, interface:string, requestBody:any, responseCode?:string,
 *          responseBody?:any, elapsedMs?:number, failReason?:string}} entry
 * @param {string} nowIso 当前时刻（'yyyy-MM-dd HH:mm:ss'，由调用方注入时钟给出）
 * @returns {{uploadId:string, interface:string, created:boolean}} created=false 表示覆盖了已有行
 */
function enqueueFailed(db, entry, nowIso) {
  if (!entry || !entry.uploadId || !entry.interface) {
    throw new TypeError('uploadQueue.enqueueFailed: entry 必须含 uploadId 与 interface');
  }
  const at = assertTime(nowIso, 'nowIso');
  const uploadId = String(entry.uploadId);
  const iface = String(entry.interface);
  const existed = hasUploadId(db, uploadId, iface);
  db.prepare(INSERT_FAILED_SQL).run(
    uploadId, iface,
    normalizeBody(entry.requestBody),
    entry.responseCode === undefined ? null : String(entry.responseCode),
    normalizeBody(entry.responseBody),
    normalizeElapsed(entry.elapsedMs),
    at,
    normalizeReason(entry.failReason),
    at
  );
  return { uploadId, interface: iface, created: !existed };
}

/**
 * 该 (uploadId, interface) 是否**已在库中**（不论状态：待补传/成功/失败都算"已存在"）。
 *
 * 用途（A1，技术债 E10）：容量上限只应拦**新键**入队。已存在的键重复入队属
 * `ON CONFLICT` 覆盖更新（刷新失败原因/响应/耗时），**不新增行、不占额度**，
 * 若也在容量判定里被拒，运维就再也刷新不了那一条的失败原因。
 *
 * @returns {boolean}
 */
function hasUploadId(db, uploadId, iface) {
  const row = db.prepare(
    'SELECT 1 AS hit FROM upload_log WHERE upload_id = ? AND interface = ? LIMIT 1'
  ).get(String(uploadId), String(iface));
  return Boolean(row);
}

/**
 * 该 (uploadId, interface) 是否**还等着人工补传**（`待补传` 或 `失败`）。
 * 供人工重报口判"这条到底还算不算待办"（幂等：已成功的条目不再是待办，不该被重复发送）。
 * @returns {boolean}
 */
function isPending(db, uploadId, iface) {
  const row = db.prepare(
    'SELECT 1 AS hit FROM upload_log WHERE upload_id = ? AND interface = ? AND state IN (?, ?) LIMIT 1'
  ).get(String(uploadId), String(iface), STATE.PENDING, STATE.FAILED);
  return Boolean(row);
}

const INSERT_SUCCESS_SQL =
  `INSERT INTO upload_log(upload_id, interface, request_body, response_code, response_body,
                          elapsed_ms, retry_count, state, created_at, fail_reason, updated_at)
   VALUES(?, ?, ?, ?, ?, ?, 0, '成功', ?, NULL, ?)
   ON CONFLICT(upload_id, interface) DO UPDATE SET
     request_body = excluded.request_body,
     response_code = excluded.response_code,
     response_body = excluded.response_body,
     elapsed_ms = excluded.elapsed_ms,
     state = excluded.state,
     fail_reason = NULL,
     updated_at = excluded.updated_at`;

/**
 * **记一条上报成功**（IF-B.10 的"成功/失败/回执三态留痕"里缺的那一态）。
 *
 * 为什么必须有它：`upload_log` 原先只有"失败入队"一条写入路径（`enqueueFailed`），
 * 一次**成功**的首发不留任何痕迹 ⇒ ①IF-B.10 要求的"结果"栏没有正样本；
 * ②人工重报也无从核对"这条到底报上去没有"。本函数把成功态补上，与失败态共用同一行
 * 幂等键 `(upload_id, interface)`：
 *   · 新键 ⇒ 插入一行 `state='成功'`（`retry_count=0`）；
 *   · 已存在（首发失败过、或人工重报过）⇒ **覆盖为成功**、清空失败原因与响应，
 *     **但 `retry_count` 保留**（它记的是"人工重报了几次"，是审计信息，不该被抹掉）；
 *   · `created_at` 保持首次落库时间不变（`DO UPDATE` 分支不改该列）—— 成功时刻看 `updated_at`。
 *
 * @param {object} db
 * @param {{uploadId:string, interface:string, requestBody:any, responseCode?:string,
 *          responseBody?:any, elapsedMs?:number}} entry
 * @param {string} nowIso 'yyyy-MM-dd HH:mm:ss'（由调用方注入时钟给出）
 * @returns {{uploadId:string, interface:string, created:boolean}} created=false 表示覆盖了已有行
 */
function recordSuccess(db, entry, nowIso) {
  if (!entry || !entry.uploadId || !entry.interface) {
    throw new TypeError('uploadQueue.recordSuccess: entry 必须含 uploadId 与 interface');
  }
  const at = assertTime(nowIso, 'nowIso');
  const uploadId = String(entry.uploadId);
  const iface = String(entry.interface);
  const existed = hasUploadId(db, uploadId, iface);
  db.prepare(INSERT_SUCCESS_SQL).run(
    uploadId, iface,
    normalizeBody(entry.requestBody),
    entry.responseCode === undefined ? null : String(entry.responseCode),
    normalizeBody(entry.responseBody),
    normalizeElapsed(entry.elapsedMs),
    at,
    at
  );
  return { uploadId, interface: iface, created: !existed };
}

/** 行 → 对象（列名转小驼峰，供业务层与人工重报界面使用） */
function hydrate(row) {
  return {
    id: row.id,
    uploadId: row.upload_id,
    interface: row.interface,
    requestBody: row.request_body,
    responseCode: row.response_code,
    responseBody: row.response_body,
    elapsedMs: row.elapsed_ms,
    retryCount: row.retry_count,
    state: row.state,
    failReason: row.fail_reason === undefined ? null : row.fail_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at === undefined ? null : row.updated_at
  };
}

/**
 * 待补传清单（明细），按"最旧优先"（先失败先补报）。
 * **含 `失败`**：人工重报过但仍未成功的条目**同样留在队列里**（IF-B.9 不丢数据），
 * 故清单 = `待补传` ∪ `失败`，与 countPendingAll() 同口径；只想看"没重报过的"用 state 自筛。
 * @param {{limit?:number, offset?:number}} [query] limit 缺省取全部（上限由业务层控制）
 * @returns {Array<object>} hydrate 后的行
 */
function listPending(db, query = {}) {
  const hasLimit = Number.isInteger(query.limit) && query.limit > 0;
  const hasOffset = Number.isInteger(query.offset) && query.offset > 0;
  const args = [STATE.PENDING, STATE.FAILED];
  let sql = 'SELECT * FROM upload_log WHERE state IN (?, ?) ORDER BY created_at ASC, id ASC';
  /* SQLite 的 OFFSET 必须跟在 LIMIT 之后；只给 offset 时用 LIMIT -1（= 不限条数）占位 */
  if (hasLimit) { sql += ' LIMIT ?'; args.push(query.limit); }
  else if (hasOffset) { sql += ' LIMIT -1'; }
  if (hasOffset) { sql += ' OFFSET ?'; args.push(query.offset); }
  return db.prepare(sql).all(...args).map(hydrate);
}

/** 待补传条数（仅"没重报过"的，告警与界面显示用；走 ix_upload_log_state 索引） */
function countPending(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM upload_log WHERE state = ?').get(STATE.PENDING).c;
}

/** 待补传总条数 = `待补传` + `失败`（人工重报失败的仍不丢，故必须计入） */
function countPendingAll(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM upload_log WHERE state IN (?, ?)')
    .get(STATE.PENDING, STATE.FAILED).c;
}

/** 队列总条数（含已成功/已失败，供运维核对与保留策略） */
function countAll(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c;
}

/**
 * 已成功记录（**最近优先**）。供上报器判"这一帧是不是已经报上去过"（防同一帧重复发送）
 * 与运维核对上报流水；与 `listPending` 一样只做 SQL。
 * @param {{limit?:number, iface?:string}} [query] limit 缺省不限
 */
function listSucceeded(db, query = {}) {
  const args = [STATE.SUCCESS];
  let sql = 'SELECT * FROM upload_log WHERE state = ?';
  if (query.iface) { sql += ' AND interface = ?'; args.push(String(query.iface)); }
  sql += ' ORDER BY updated_at DESC, id DESC';
  if (Number.isInteger(query.limit) && query.limit > 0) { sql += ' LIMIT ?'; args.push(query.limit); }
  return db.prepare(sql).all(...args).map(hydrate);
}

/** 按 uploadId 取一条（回执核对与人工重报前的确认） */
function getByUploadId(db, uploadId, iface) {
  const row = iface === undefined
    ? db.prepare('SELECT * FROM upload_log WHERE upload_id = ? ORDER BY id DESC LIMIT 1').get(String(uploadId))
    : db.prepare('SELECT * FROM upload_log WHERE upload_id = ? AND interface = ?').get(String(uploadId), String(iface));
  return row ? hydrate(row) : null;
}

/**
 * 标记"重报成功"：状态置 `成功`、失败原因清空。
 * **只改仍处于 `待补传` 的行**，返回真实改动行数（0 表示该条已不在队列里，调用方据此提示）。
 * @returns {{updated:number}}
 */
function markRetrySuccess(db, uploadId, iface, nowIso) {
  const at = assertTime(nowIso, 'nowIso');
  const r = db.prepare(
    `UPDATE upload_log
        SET state = ?, fail_reason = NULL, response_code = NULL, response_body = NULL, updated_at = ?
      WHERE upload_id = ? AND interface = ? AND state = ?`
  ).run(STATE.SUCCESS, at, String(uploadId), String(iface), STATE.PENDING);
  return { updated: r.changes };
}

/**
 * 标记"重报仍失败"：**保留在队列里**、`retry_count` 累加 1，并记录本次失败原因/响应。
 * 状态从 `待补传` 改为 `失败`（表示"已人工重报过、仍未成功"），查询待补传清单时
 * 需把 `失败` 一并算入（业务层 `listPending()` 就是这么做的）——这样队列既不丢条目，
 * 又能让运维一眼看出"哪些是重报过还没成功的"。
 * @returns {{updated:number, retryCount:number|null}}
 */
function markRetryFailed(db, uploadId, iface, detail, nowIso) {
  const at = assertTime(nowIso, 'nowIso');
  const info = detail || {};
  const r = db.prepare(
    `UPDATE upload_log
        SET state = ?, retry_count = retry_count + 1,
            response_code = COALESCE(?, response_code),
            response_body = COALESCE(?, response_body),
            fail_reason = COALESCE(?, fail_reason), updated_at = ?
      WHERE upload_id = ? AND interface = ? AND state IN (?, ?)`
  ).run(
    STATE.FAILED,
    info.responseCode === undefined ? null : String(info.responseCode),
    normalizeBody(info.responseBody),
    normalizeReason(info.failReason),
    at, String(uploadId), String(iface),
    STATE.PENDING, STATE.FAILED
  );
  const row = r.changes > 0
    ? db.prepare('SELECT retry_count FROM upload_log WHERE upload_id = ? AND interface = ?')
      .get(String(uploadId), String(iface))
    : null;
  return { updated: r.changes, retryCount: row ? row.retry_count : null };
}

/**
 * 某接口最近一条上报流水（`buildReportPayload` 与人工重报都靠它核对 uploadId 是否已被记录）。
 * @param {{iface?:string}} [query]
 */
function latest(db, query = {}) {
  const args = [];
  let sql = 'SELECT * FROM upload_log';
  if (query.iface) { sql += ' WHERE interface = ?'; args.push(String(query.iface)); }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT 1';
  const row = db.prepare(sql).get(...args);
  return row ? hydrate(row) : null;
}

/**
 * 队列状态汇总（供"告警/暴露待补传条数"与运维巡检）。
 * ⚠ **告警阈值没有本层缺省**（`E33①`，2026-10-05）：这里原写
 * `options.warnThreshold === undefined ? <字面量> : …` —— 那是一个**不读真源的独立判据**
 * （真源＝`src/config/board.config.js` 的 `mes.queueWarnThreshold`，由服务层
 * `services/uploadQueue.js` 读取后**显式**传进来，见那里的 `configWarnThreshold()`）。
 * 现在**删掉缺省**：缺参 ⇒ 当场抛错，**不返回一个"看似正常"的 warn**。
 * 为什么不是"在本层改成读真源"（两种修法里选了这个，理由三条）：
 *   · 本文件是**只做 SQL 的仓储**（见文件头第 6 行），阈值属业务口径；
 *   · 在这里再读一次配置 = **第二处真源读取点**：同一进程里内存改配置时，两层会在
 *     两个时刻各读一次 ⇒ 又制造两判，正是 `E33` 要防的形态；
 *   · "忘了传"若被静默当成"传了真源"，缺陷永远看不见 —— 显式失败让调用点当场可见。
 * @param {{capacity?:number, warnThreshold:number}} options
 *   `warnThreshold` **必填**且须为有限数：待补传条数 ≥ 它即 `warn`；缺参/非有限数 ⇒ `TypeError`。
 */
function stats(db, options = {}) {
  const pendingOnly = countPending(db);
  const failedAfterRetry = countFailed(db);
  const pending = pendingOnly + failedAfterRetry;
  const oldest = db.prepare(
    `SELECT MIN(created_at) AS first_at FROM upload_log WHERE state IN (?, ?)`
  ).get(STATE.PENDING, STATE.FAILED).first_at;
  /* `E33①`：**不设缺省**、也不在本层读真源（理由见上方 JSDoc）—— 缺参当场失败，
     不返回一个"看似正常"的 warn（那正是"死配置/散落字面量"制造两判的形态）。 */
  if (options.warnThreshold === undefined) {
    throw new TypeError('uploadQueueRepo.stats: 必须显式传 warnThreshold（E33①：本层不做业务判断、不设缺省；' +
      '真源＝board.config.js 的 mes.queueWarnThreshold，由 services/uploadQueue.js 读取后传入）');
  }
  const threshold = Number(options.warnThreshold);
  if (!Number.isFinite(threshold)) {
    throw new TypeError(`uploadQueueRepo.stats: warnThreshold 必须是有限数，收到 ${JSON.stringify(options.warnThreshold)}`);
  }
  return {
    pending,
    pendingOnly,
    failedAfterRetry,
    total: countAll(db),
    capacity: options.capacity === undefined ? null : options.capacity,
    oldestAt: oldest || null,
    warn: pending >= threshold
  };
}

/** 已人工重报过但仍未成功的条数（state = `失败`，属待补传的一部分） */
function countFailed(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM upload_log WHERE state = ?').get(STATE.FAILED).c;
}

/** 删除某时间点之前的已了结记录（DR-14 保留策略的基础能力；**不动待补传/失败项**） */
function deleteSettledBefore(db, cutoff) {
  assertTime(cutoff, 'cutoff');
  const r = db.prepare(
    'DELETE FROM upload_log WHERE state = ? AND created_at < ?'
  ).run(STATE.SUCCESS, cutoff);
  return { deleted: r.changes };
}

module.exports = {
  STATE,
  FAIL_REASON_MAX,
  enqueueFailed,
  recordSuccess,
  hasUploadId,
  isPending,
  listPending,
  listSucceeded,
  countPending,
  countPendingAll,
  countFailed,
  countAll,
  getByUploadId,
  markRetrySuccess,
  markRetryFailed,
  latest,
  stats,
  deleteSettledBefore
};
