/* ==========================================================================
   操作日志仓储（server/repo/opLog.js）
   作用：`op_log` 表（DR-12）的读写 —— **解锁后写操作的留痕**：
         维保录入 / 公告发布 / 异常闭环 / 参数配置 / 标准录入 / 解锁 等。
         V1.33 增列 `team_code`（班组编号），留痕要能回答"**哪个班组**在什么时候改了什么"。
   依据：DR-12（需求 V1.33）、草案第四节 DR-12 增列、FR-1.6（班组显示）、
         FR-3.19 第 7 步（录入成功记录内容、时间戳、班组编号）、DR-16（时间格式）。
   班组编号的**唯一真源**：录入时**当前生效班次**的班组，与 FR-1.6（看板头部"所属班组"）
         同一处 —— `src/config/board.config.js` 的 `shift.roster.team`（联调后由 MES 人员班组资质
         接口提供）。本模块**只负责把调用方给的值落库**，不自己推导班组；禁止在这里另起
         "按操作人姓名反查班组"之类的来源，否则审计口径会与头部显示分裂。
   表与列（唯一真源：`server/db/schema.sql`）：
         op_log.op_time     操作时间（'yyyy-MM-dd HH:mm:ss'）
         op_log.operator    操作人
         op_log.op_type     操作类型（自由文本，见下方 OP_TYPE 约定值）
         op_log.content     操作内容
         op_log.result      结果（成功/失败）
         op_log.team_code   班组编号（V1.33 增列）
         op_log.created_at  落库时间
   用法：
     const repo = require('./repo/opLog');
     repo.append(db, { opTime: at, operator: '张伟', opType: '标准录入',
                       content: '深度上下限 4.80～5.30', result: '成功',   // 数字取真源：board.config.js:244-247 `standards.default.depth`（5.00±0.30/−0.20 ⇒ 4.80～5.30）
                       teamCode: '检验一班' }, at);
     repo.list(db, { opType: '标准录入', atFrom: '2026-09-22 00:00:00' }, { limit: 20 });
   ========================================================================== */
'use strict';

/* DR-16 时间格式：yyyy-MM-dd HH:mm:ss（恰好 19 字符）。
   与 server/repo/measure.js、server/repo/uploadQueue.js 同一铁律：时间列一律**文本比较**，
   格式不对会让"按时间排序/取最旧"静默失真，故在入库口拒收。 */
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 操作结果的约定值（**不强制**：允许历史词形与新词形，但只认这两个字面量做统计） */
const RESULT = { SUCCESS: '成功', FAILED: '失败' };

/** 操作类型的约定值（自由文本也可以写，这里只是**既有用词的集中处**，避免各处拼错） */
const OP_TYPE = {
  UNLOCK: '解锁',
  MAINT: '维保录入',
  NOTICE: '公告发布',
  ALARM_CLOSE: '异常闭环',
  PARAM: '参数配置',
  STANDARD: '标准录入'
};

/** 文本列长度上限：操作内容会装一整行描述，给宽一些；其余列短 */
const CONTENT_MAX = 500;
const TEXT_MAX = 200;

/** 校验时间文本（DR-16）；不合规即抛错并指出实际值 */
function assertTime(value, field) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new TypeError(
      `opLog: ${field} 必须是「yyyy-MM-dd HH:mm:ss」（DR-16，19 字符），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 校验必填文本（去首尾空白后非空） */
function assertText(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`opLog: ${field} 不能为空（收到 ${JSON.stringify(value)}）`);
  }
  const s = value.trim();
  if (s.length > max) {
    throw new RangeError(`opLog: ${field} 长度 ${s.length} 超过上限 ${max}`);
  }
  return s;
}

/** 可选文本：空值/空串 → null（便于区分"没写"与空串） */
function optionalText(value, field, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) {
    throw new RangeError(`opLog: ${field} 长度 ${s.length} 超过上限 ${max}`);
  }
  return s;
}

const INSERT_SQL =
  `INSERT INTO op_log(op_time, operator, op_type, content, result, team_code, created_at)
   VALUES(?, ?, ?, ?, ?, ?, ?)`;

/**
 * 追加一条操作留痕（DR-12）。
 *
 * 追加式：本表**只增不改不删**（除保留策略按时间裁剪外），故没有 update/delete 接口。
 * `teamCode` 由调用方从**当前生效班次**取（与 FR-1.6 同一真源）；未解锁场景不该写日志，
 * 故这里不设"缺省班组"——没传就是 `null`，**不猜**。
 *
 * @param {object} db 数据库句柄
 * @param {{opTime?:string, operator?:string, opType:string, content?:string,
 *          result?:string, teamCode?:string}} entry
 * @param {string} now 当前时刻（'yyyy-MM-dd HH:mm:ss'，由调用方注入时钟给出）
 * @returns {{id:number, opTime:string, opType:string, teamCode:string|null}}
 */
function append(db, entry, now) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('opLog.append: 入参必须是对象');
  }
  const at = assertTime(now, 'now');
  /* 操作时间缺省＝落库时间（调用方通常两者相同；拆开是为了让"补记历史操作"仍能写准时间） */
  const opTime = entry.opTime === undefined || entry.opTime === null || entry.opTime === ''
    ? at
    : assertTime(entry.opTime, 'opTime');
  const opType = assertText(entry.opType, 'opType', TEXT_MAX);
  const operator = optionalText(entry.operator, 'operator', TEXT_MAX);
  const content = optionalText(entry.content, 'content', CONTENT_MAX);
  const result = optionalText(entry.result, 'result', TEXT_MAX);
  const teamCode = optionalText(entry.teamCode, 'teamCode', TEXT_MAX);
  const r = db.prepare(INSERT_SQL).run(opTime, operator, opType, content, result, teamCode, at);
  return { id: Number(r.lastInsertRowid), opTime, opType, teamCode };
}

/**
 * 查询留痕（按时间升序，默认只返回前 100 条）。
 * @param {object} db
 * @param {{opType?:string, operator?:string, teamCode?:string,
 *          atFrom?:string, atTo?:string}} [query]
 * @param {{limit?:number, offset?:number}} [options]
 * @returns {Array<object>} hydrate 后的行
 */
function list(db, query = {}, options = {}) {
  const where = [];
  const args = [];
  if (query.opType) { where.push('op_type = ?'); args.push(String(query.opType)); }
  if (query.operator) { where.push('operator = ?'); args.push(String(query.operator)); }
  if (query.teamCode) { where.push('team_code = ?'); args.push(String(query.teamCode)); }
  if (query.atFrom) { where.push('op_time >= ?'); args.push(assertTime(query.atFrom, 'atFrom')); }
  if (query.atTo) { where.push('op_time <= ?'); args.push(assertTime(query.atTo, 'atTo')); }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;
  const offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0;
  return db.prepare(
    `SELECT * FROM op_log${where.length ? ' WHERE ' + where.join(' AND ') : ''}
      ORDER BY op_time ASC, id ASC LIMIT ? OFFSET ?`
  ).all(...args, limit, offset).map(hydrate);
}

/** 某班组在某时间区间内的留痕条数（供"班组操作量"类展示与审计核对） */
function countByTeam(db, teamCode, range = {}) {
  const where = ['team_code = ?'];
  const args = [String(teamCode)];
  if (range.atFrom) { where.push('op_time >= ?'); args.push(assertTime(range.atFrom, 'atFrom')); }
  if (range.atTo) { where.push('op_time <= ?'); args.push(assertTime(range.atTo, 'atTo')); }
  return db.prepare(`SELECT COUNT(*) AS c FROM op_log WHERE ${where.join(' AND ')}`).get(...args).c;
}

/** 全表行数（供保留策略与自检） */
function count(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM op_log').get().c;
}

/** 行 → 对象（库列名转小驼峰） */
function hydrate(row) {
  return {
    id: row.id,
    opTime: row.op_time,
    operator: row.operator,
    opType: row.op_type,
    content: row.content,
    result: row.result,
    teamCode: row.team_code === undefined ? null : row.team_code,
    createdAt: row.created_at
  };
}

module.exports = { TIME_RE, RESULT, OP_TYPE, CONTENT_MAX, TEXT_MAX, assertTime, append, list, countByTeam, count };
