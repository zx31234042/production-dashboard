/* ==========================================================================
   预警记录仓储（server/repo/warning.js）—— DR-08（技术债 `E62` 「写入归口」的落点，
   依据 ADR-0009 D1，负责人 2026-10-02 裁定 A1）
   作用：`warning` 表（DR-08）的**唯一写入口**与只读对账口。**只做 SQL 与入参校验，不做业务判断** ——
         "哪些预警要落库、归属键怎么拼"由装配层决定（`server/index.js` 的 `persistWarnings()`，
         接线点在**判定发布点** `emitWarnings()`，即 `ingest` 的 `onSampled`＝1 s 采样落库之后）。
   依据：DR-08（预警记录表：预警类型、触发条件、触发时间、状态）、FR-5.8～5.11（四类预警；
         C-88 的两条具名参数类预警）、DR-16（时间格式 yyyy-MM-dd HH:mm:ss）。
   表与列（唯一真源：`server/db/schema.sql` 的 `warning`；本模块**不做**运行时补列/迁移）：
         warn_type    预警类型（＝判定产出里的 `title`：参数阈值临近预警／参数超范围预警／
                      设备维保到期预警／耗材更换预警／工单超时预警，C-88 ＋ FR-5.9～5.11）
         trigger_cond 触发条件描述（本模块写入的形态见下"幂等键"）
         triggered_at **触发时刻**（＝该条判定的判定时刻，由调用方给：`index.js` 用帧的采集时刻，
                      与 `judge.evaluate({now})` 的 `now` **同一个值** —— 判据与数据同一时刻，D17）
         state        处置状态（本包只写缺省 `未处理`：DR-07 的闭环状态机不在本决策范围，ADR-0009 D2）
         created_at   行创建时刻（＝落库动作发生的时刻，调用方的注入时钟给出）
   幂等键（**为什么键落在 `trigger_cond` 里**）：
         `warning` 表**没有任何唯一索引**，且 ADR-0009 D5 明写"五张表结构已就绪、本决策不新增列"
         ⇒ 既不能加列、也不能加索引（结构归口＝`server/db/index.js`，ADR-0006）。可用的四个业务列里，
         只有 `trigger_cond`（TEXT，可空）能承载**归属**信息，故本模块把幂等键写成它的**前缀**：
             `trigger_cond = <归属键> ＋ '｜' ＋ <触发条件描述>`
         并用**精确前缀**做条件插入（不用 `LIKE`，不做转义 —— 前缀比较是逐字相等的）：
             INSERT ... SELECT ... WHERE NOT EXISTS (
               SELECT 1 FROM warning
                WHERE warn_type = ? AND substr(trigger_cond, 1, length(?)) = ?)
         **归属键（幂等键的实质）＝`(warn_type, 归属键)`**：
           · 参数类（C-88 两条具名）：`参数|<班次归属日>|<工单>|<件序号>|<参数名>`
             —— 同一件同一参数**同一等级**（等级由 `warn_type` 承载）只落一条；
             参数名从 detail 前缀导出（`judge.paramDetail()` 逐字以 `PARAM_CN[kind] + ' '` 开头）；
             **导出不来**时退化为把 detail 也放进键（`…|未知|<detail>`）—— 宁可多落一条，
             **不得**把两条不同的预警合并成一条（合并＝静默丢预警）。
           · 工单超时（FR-5.11）：`工单超时|<班次归属日>|<工单>`
           · 设备维保到期（FR-5.9）：`维保|<下次维保日>`（每周期一条；该值是配置真源算出的纯函数产物）
           · 耗材更换（FR-5.10）：`耗材|<班次归属日>|<耗材名>`（当前服务端无取数源 ⇒ 该类不产生）
           · 未知类型兜底：`<title>|<班次归属日>|<工单>|<件序号>|<detail>`（不合并）
         "拿不到"的归属成分**不编造**：帧没带件序号就写 `无件序号`（不写 1）、没有工单就写 `无工单`、
         班次算不出归属日就写 `无归属日`（与 `judge.js`、"E60 裁定①"的纪律一致）。
         ⚠ 只落 `lv !== 'ok'` 的条目：`ok` 是"参数均处于允许范围"的**回执条**（FR-5.8 的
           "标准未设定 ⇒ 两条都不产生"同源），把它写进"预警记录表"就是把非预警记成预警
           —— 该过滤在装配层做，计数见 `/health` 的 `warningWrite.skippedOk`。
         已知边界（如实登记，见回执"未验到/偏差"）：触发条件描述 `detail` **含随帧变化的实测值**
           （如"深度 5.22" → 下一秒"深度 5.31"），但幂等键是**前缀**（归属键）、与描述无关
           ⇒ 同一归属键**恒定命中**，不会因实测值漂移而新增行；会新增行的只有"归属键里的成分变了"
           （换件 / 换参数 / 换等级（`warn_type`）/ 换班次归属日），那是**新的预警事实**，本表各记一条。
   依赖：仅传入的 db 句柄；不 require 任何业务服务（避免与 `services/*` 形成环）。
   ========================================================================== */
'use strict';

/* DR-16 时间格式（理由同 `repo/result.js`：文本比较下混入非定长时间会让"最近一条"取错） */
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 归属键与触发条件的**分隔符**（全角竖线；归属键里禁止出现它 —— 否则前缀会歧义） */
const SEP = '｜';

/** 文本列最大长度 */
const TYPE_MAX = 200;      // 预警类型（标题）
const KEY_MAX = 200;       // 归属键（前缀）
const COND_MAX = 500;      // 触发条件描述（detail 可能较长）

/** 处置状态缺省值（与 `schema.sql` 的 `DEFAULT '未处理'` 同一取值） */
const STATE_DEFAULT = '未处理';

/** 校验时间文本（DR-16） */
function assertTime(value, field) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new TypeError(
      `warning: ${field} 必须是「yyyy-MM-dd HH:mm:ss」（DR-16，19 字符），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 校验非空文本 + 长度上限（超长一律拒收而不是截断） */
function assertText(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`warning: ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`);
  }
  const s = value.trim();
  if (s.length > max) throw new RangeError(`warning: ${field} 长度 ${s.length} 超过上限 ${max}`);
  return s;
}

/** 校验归属键：非空、不得含分隔符（含则前缀比较会出现歧义 ⇒ 直接拒收，不猜） */
function assertDedupeKey(value) {
  const key = assertText(value, 'dedupeKey', KEY_MAX);
  if (key.indexOf(SEP) >= 0) {
    throw new TypeError(`warning: dedupeKey 不得包含分隔符「${SEP}」（它是归属键与触发条件描述的分界），收到 ${JSON.stringify(value)}`);
  }
  return key;
}

/** 组装落库用的 `trigger_cond`（＝归属键 ＋ 分隔符 ＋ 触发条件描述） */
function composeTriggerCond(dedupeKey, triggerCond) {
  return `${dedupeKey}${SEP}${triggerCond}`;
}

/** 从落库形态里取回归属键（读口/探针用；`SEP` 不在键内 ⇒ 取第一个分隔符之前的部分） */
function dedupeKeyOf(triggerCond) {
  const text = typeof triggerCond === 'string' ? triggerCond : '';
  const i = text.indexOf(SEP);
  return i < 0 ? text : text.slice(0, i);
}

/* 条件插入（**幂等**）：同一 `(warn_type, 归属键)` 已在库中 ⇒ 一行都不写。
   为什么写成 `INSERT ... SELECT ... WHERE NOT EXISTS`：本表无唯一索引可用（结构不动，见文件头），
   而 SQLite 的 `ON CONFLICT` 必须依附某个唯一约束 ⇒ 只能用条件插入表达"至多一条"。
   并发：Node 单线程 ＋ node:sqlite 同步调用 ⇒ "查-写"之间不存在交错（无丢失更新窗口）。
   `substr(trigger_cond, 1, length(?))` 的字符计数由 SQLite 自己做（不经 JS 的 UTF-16 计数），
   故中文/代理对都不会数错。 */
const INSERT_SQL =
  `INSERT INTO warning(warn_type, trigger_cond, triggered_at, state, created_at)
   SELECT ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM warning
       WHERE warn_type = ? AND substr(trigger_cond, 1, length(?)) = ?)`;

/**
 * 落一条预警（`warning` 表的**唯一写入口**）。
 *
 * @param {object} db 数据库句柄
 * @param {{warnType:string, triggerCond:string, triggeredAt:string, createdAt:string,
 *          state?:string, dedupeKey:string}} row
 *        `warnType` ＝ 判定产出的 `title`（DR-08 的"预警类型"）；
 *        `triggerCond` ＝ 判定产出的 `detail`（DR-08 的"触发条件"）；
 *        `triggeredAt` ＝ **判定时刻**（与 `judge.evaluate({now})` 同一个值）；
 *        `createdAt` ＝ 落库时刻（注入时钟给出，ADR-0003 D17）；
 *        `dedupeKey` ＝ **归属键**（幂等键的实质，形态见文件头；**不得**含分隔符）；
 *        `state` 缺省 `未处理`（DR-07 的闭环状态机不在本决策范围，ADR-0009 D2）。
 * @returns {{written:boolean, warnType:string, dedupeKey:string, triggeredAt:string, triggerCond:string}}
 *   `written:false` ＝ 该 `(warn_type, 归属键)` 已在库中（**幂等命中，不是失败**）。
 */
function insertWarning(db, row) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('warning: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const input = row && typeof row === 'object' ? row : {};
  const warnType = assertText(input.warnType, 'warnType', TYPE_MAX);
  const triggerCond = assertText(input.triggerCond, 'triggerCond', COND_MAX);
  const dedupeKey = assertDedupeKey(input.dedupeKey);
  const triggeredAt = assertTime(input.triggeredAt, 'triggeredAt');
  const createdAt = assertTime(input.createdAt, 'createdAt');
  const state = assertText(input.state === undefined || input.state === null ? STATE_DEFAULT : input.state,
    'state', TYPE_MAX);
  const stored = composeTriggerCond(dedupeKey, triggerCond);
  const r = db.prepare(INSERT_SQL).run(warnType, stored, triggeredAt, state, createdAt,
    warnType, dedupeKey, dedupeKey);
  return {
    written: r.changes > 0,
    warnType,
    dedupeKey,
    triggeredAt,
    triggerCond: stored
  };
}

/**
 * 按 `(warn_type, 归属键)` 读回（幂等对账/探针/`/health` 的只读使用）。
 * @returns {Array<object>} 命中行（无 ⇒ 空数组 —— "没有"就是空，不编造）
 */
function findByKey(db, warnType, dedupeKey) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('warning: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const type = assertText(warnType, 'warnType', TYPE_MAX);
  const key = assertDedupeKey(dedupeKey);
  return db.prepare(
    `SELECT id, warn_type, trigger_cond, triggered_at, state, created_at
       FROM warning
      WHERE warn_type = ? AND substr(trigger_cond, 1, length(?)) = ?
      ORDER BY id`
  ).all(type, key, key);
}

/** 表内总行数（对账用） */
function countAll(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('warning: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  return db.prepare('SELECT COUNT(*) AS c FROM warning').get().c;
}

/** 某类型的行数（对账/探针用；**只报告不推断**） */
function countByType(db, warnType) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('warning: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const type = assertText(warnType, 'warnType', TYPE_MAX);
  return db.prepare('SELECT COUNT(*) AS c FROM warning WHERE warn_type = ?').get(type).c;
}

/** 最近若干行（巡检/探针用；`ORDER BY id DESC` 只为稳定输出） */
function listRows(db, limit) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('warning: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const n = Number.isInteger(limit) && limit > 0 ? limit : 50;
  return db.prepare(
    `SELECT id, warn_type, trigger_cond, triggered_at, state, created_at
       FROM warning ORDER BY id DESC LIMIT ?`
  ).all(n);
}

module.exports = {
  TIME_RE,
  SEP,
  TYPE_MAX,
  KEY_MAX,
  COND_MAX,
  STATE_DEFAULT,
  INSERT_SQL,
  composeTriggerCond,
  dedupeKeyOf,
  insertWarning,
  findByKey,
  countAll,
  countByType,
  listRows
};
