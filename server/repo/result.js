/* ==========================================================================
   测试结果仓储（server/repo/result.js）—— DR-05（技术债 E58 ②「写入归口」的落点）
   作用：`result` 表（DR-05）的**按件写入**与「已完成件数」读取。**只做 SQL 与入参校验，不做业务判断** ——
        谁在什么时刻写、写什么结果由业务层决定：判定口径的唯一实现在 `server/services/judge.js`，
        接线（与 1 s 采样落库**同拍**）在 `server/index.js` 的 `emitWarnings()` / `persistJudgement()`。
   依据：DR-05（测试结果表：procOrderNo、结果、判定时间、复检次数）、DR-19（按件固化）、
        FR-3.13（单任务结果五态；**结果取值以本看板判定为准**）、FR-4.4 / FR-5.11
        （已完成 ＝ 合格 ＋ 不合格）、FR-4.9（复检数 ＝ 进入复检流程的任务数）、
        DR-16（时间格式 yyyy-MM-dd HH:mm:ss）、E58 ② 的五项写入口径（负责人 2026-09-30 裁定）。
   表与列（唯一真源：`server/db/schema.sql`；本模块**不做**运行时补列/迁移）：
         proc_order_no  生产任务编号（与 task / measure_rt 同键）
         unit_index     第几件（按件固化；与 proc_order_no 组成唯一索引 ux_result_unit）
         result         结果（FR-3.13 五态；取值域与「已完成」集合复用 services/stats.js 的同一份常量）
         judged_at      判定时刻（**由调用方注入的时钟给出**，与本帧的采集时刻
                        `measure_rt.collect_time` **分开存**：前者是"我们什么时候判的"，
                        后者是"数据是什么时候采的"，混存会让追溯时分不清是谁的时刻）
         retest_count   复检次数（进入"待复检"的次数）
         duration_sec   单件测试时长（秒）＝该件首末**有效**帧（已落库的 1 s 采样帧）的采集时刻差
         created_at     行创建时刻（＝该件首次落 `result` 表的时刻）
         updated_at     最近一次更新时刻
   幂等：`(proc_order_no, unit_index)` 唯一索引（`schema.sql` 的 `ux_result_unit`）
        ＋ `ON CONFLICT ... DO UPDATE` ⇒ **同一件重复推帧不新增行**。
   单调不回退（**有意为之**，逐条理由见 `upsertJudgement()` 的 docblock）：该件一旦判出终态
        （合格／不合格），后续帧的中间态（待测试／测试中）**不得**把它改回去 —— 否则
        `countDone()` 的件数会随帧来回跳，而它正是 FR-5.11「已完成件数」与 FR-4.4「已完成」共用的减数。
   依赖：仅传入的 db 句柄 ＋ `services/stats.js` 的 `STATUS` / `DONE_STATUS`（取值域单一真源）。
   ========================================================================== */
'use strict';

/* 结果取值域（FR-3.13 五态）与「已完成」集合（FR-4.4 ＝ 合格＋不合格）**复用** `services/stats.js`
   已导出的同一份常量：
     · 那里是"当班统计口径的唯一执行点"，五态与 DONE_STATUS 已定义过一次（`DONE_STATUS` 正是
       FR-4.4 / FR-5.11 共用的"已完成"判据）；
     · 为什么不在这里再抄一份枚举：抄一份就是**第二份取值域真源**，两处迟早漂移，
       而"哪些结果算已完成"直接决定 FR-5.11 的减数（E58 的病灶正是这个减数不可信）；
     · 为什么不把取值域定义在本模块再让服务层引用：仓储层是**下游**（只写 SQL），
       取值域属业务口径，引用方向不能反 —— 与 `repo/standard.js` 向上复用 `services/standard.js`
       的 `assertInput` 同一取舍（那里的 docblock 记了同一条理由）。
   本模块**在加载期**把它取到局部常量：`services/stats.js` 只依赖 `platform/clock.js`，
   不存在循环依赖（不同于 standard 那处的延迟 require）。 */
const { STATUS, DONE_STATUS } = require('../services/stats');

/* DR-16 时间格式：yyyy-MM-dd HH:mm:ss（恰好 19 字符）。
   为什么在**入库口**校验（与 `server/repo/measure.js` / `server/repo/standard.js` 同一铁律）：
   `result` 的"按时刻取件/排序"（`ix_result_result(result, judged_at)`）与 measure 的
   "某秒之前/之后"都是**文本比较**，一旦混入带毫秒/带 T/带时区的时间，文本序就不再是时间序，
   取到的"最近一判"会静默取错 —— 宁可拒收，也不落脏时间。 */
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 文本列最大长度（工单号；超长一律拒收而不是截断，避免悄悄改名） */
const TEXT_MAX = 200;

/** `duration_sec` 的上界：一件的测试时长最大按 24 小时收口（防"时间戳写错位"变成天文数字落库） */
const DURATION_SEC_MAX = 24 * 60 * 60;

/** 校验时间文本（DR-16）；不合规即抛错并指出实际值 */
function assertTime(value, field) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new TypeError(
      `result: ${field} 必须是「yyyy-MM-dd HH:mm:ss」（DR-16，19 字符），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 校验工单号（非空文本，DR-05 的按件键成分之一） */
function assertProcOrderNo(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`result: procOrderNo 必须是非空字符串（DR-05 的按件键成分），收到 ${JSON.stringify(value)}`);
  }
  const s = value.trim();
  if (s.length > TEXT_MAX) {
    throw new RangeError(`result: procOrderNo 长度 ${s.length} 超过上限 ${TEXT_MAX}`);
  }
  return s;
}

/** 校验件号：**正整数**（DR-19 按件固化）；0/负数/小数/非数值一律拒收，不静默归一 */
function assertUnitIndex(value) {
  const n = (typeof value === 'string' && /^\d+$/.test(value.trim())) ? Number(value.trim()) : value;
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError(`result: unitIndex 必须是 ≥ 1 的整数（DR-19 第几件），收到 ${JSON.stringify(value)}`);
  }
  return n;
}

/** 校验结果：必须是 FR-3.13 五态之一（取值域真源＝`services/stats.js` 的 STATUS） */
function assertResult(value) {
  const all = Object.values(STATUS);
  if (typeof value !== 'string' || all.indexOf(value) < 0) {
    throw new TypeError(
      `result: 结果必须是 FR-3.13 五态之一（${all.join(' / ')}），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 校验单件时长：**非负整数秒**（该件首末有效帧的采集时刻差，见 schema 的 `duration_sec INTEGER`） */
function assertDurationSec(value) {
  if (!Number.isInteger(value) || value < 0 || value > DURATION_SEC_MAX) {
    throw new TypeError(
      `result: durationSec 必须是 0～${DURATION_SEC_MAX} 的整数秒（该件首末有效帧采集时刻差），` +
      `收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/* 按件 upsert：唯一索引 `ux_result_unit(proc_order_no, unit_index)` 命中即 UPDATE（**不新增行**）。
   各列在 UPDATE 分支的语义（与下方 `params` 的注释一一对应）：
     · result       —— **单调不回退**：已是终态（合格/不合格）⇒ 原样保留；已是"待复检"⇒
                        不被中间态（待测试/测试中）推翻；其余 ⇒ 采用本次判定。
     · retest_count —— 只在"**真的**进入复检流程"时 +1（本次判待复检 且 旧值既不是待复检、
                        也不是被冻结的终态）—— 与 FR-4.9「复检数＝进入复检流程的任务数」同口径；
                        连续多帧判"待复检"只计一次（否则复检数会被帧数灌水）。
     · judged_at    —— 本次**判定时刻**（调用方注入时钟给出）；被冻结的行也照实刷新
                        （判定确实发生了），"首次判定时刻"由 `created_at` 承载，语义不重叠。
     · duration_sec —— `MAX(旧值, 新值)`：该件首末有效帧差**单调不减**（进程重启后按新首帧
                        重算也不会让已落库的时长倒退）。
     · created_at **不动**（行首次创建时刻）；updated_at 刷新。 */
const UPSERT_SQL =
  `INSERT INTO result(
     proc_order_no, unit_index, result, judged_at, retest_count, duration_sec, created_at, updated_at)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(proc_order_no, unit_index) DO UPDATE SET
     result = CASE
       WHEN result.result IN (?, ?) THEN result.result
       WHEN result.result = ? AND excluded.result IN (?, ?) THEN result.result
       ELSE excluded.result END,
     retest_count = result.retest_count + CASE
       WHEN excluded.result = ? AND result.result NOT IN (?, ?, ?) THEN 1 ELSE 0 END,
     judged_at = excluded.judged_at,
     duration_sec = MAX(COALESCE(result.duration_sec, 0), excluded.duration_sec),
     updated_at = excluded.updated_at`;

/** `GET`-风格读取：某工单「已完成」件数（`DONE_STATUS` ＝ 合格＋不合格，FR-4.4 / FR-5.11 共用减数） */
const COUNT_DONE_SQL =
  'SELECT COUNT(*) AS n FROM result WHERE proc_order_no = ? AND result IN (?, ?)';

/**
 * 按件写入/更新一条判定（`result` 表的**唯一写入口**）。
 *
 * 幂等与单调（两条都在 SQL 里做，不读-改-写 ⇒ 无丢失更新窗口）：
 *   · 同 `(procOrderNo, unitIndex)` 再来 ⇒ **UPDATE 既有行**，不新增；
 *   · 该件已是终态（合格/不合格）⇒ 结果**不回退**（理由见文件头"单调不回退"）。
 *
 * @param {object} db 数据库句柄
 * @param {{procOrderNo:string, unitIndex:number, result:string, judgedAt:string, now:string,
 *          durationSec:number}} row
 *        `result` ＝ FR-3.13 五态之一（由 `judge.taskResult()` 产出）；
 *        `judgedAt` ＝ **判定时刻**（`yyyy-MM-dd HH:mm:ss`，由调用方的注入时钟给出，ADR-0003 D17）；
 *        `now` ＝ 落库时刻（同一条时间源；`created_at` / `updated_at` 都用它）；
 *        `durationSec` ＝ 该件首末有效帧的采集时刻差（整数秒，不在此处计算 —— 计算要读帧，
 *        属业务层；本模块只校验与落库）。
 * @returns {{written:boolean, procOrderNo:string, unitIndex:number, retestCount:number}}
 *   `written` ＝ 该件在库中的行**已就位/已更新**（UPSERT 的插入与更新两条路径都计 1）；
 *   要判"有没有**新增行**"用 `countByTask()` 对账（重复推帧 ⇒ 行数不变，这是幂等的硬证据）。
 */
function upsertJudgement(db, row) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('result: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const input = row && typeof row === 'object' ? row : {};
  const procOrderNo = assertProcOrderNo(input.procOrderNo);
  const unitIndex = assertUnitIndex(input.unitIndex);
  const result = assertResult(input.result);
  const judgedAt = assertTime(input.judgedAt, 'judgedAt');
  const now = assertTime(input.now, 'now');
  const durationSec = assertDurationSec(input.durationSec);
  /* 首判即"待复检"也算**已进入**复检流程一次（FR-4.9 是"进入复检流程的任务数"口径）；否则从 0 起 */
  const firstRetest = result === STATUS.RETEST ? 1 : 0;
  /* 参数顺序严格对应 UPDATE 分支的口径（改 SQL 必须同步改这里，故逐项写明用途）：
       1..8  ＝ INSERT 的八列（created_at/updated_at 同一时刻）
       9..13 ＝ result 的单调阶梯：终态(合格,不合格) ／ 待复检 不被 (待测试,测试中) 推翻
       14..17＝ retest_count 的 +1 条件：本次待复检 且 旧值 ∉ (待复检,合格,不合格) */
  const params = [
    procOrderNo, unitIndex, result, judgedAt, firstRetest, durationSec, now, now,
    STATUS.PASS, STATUS.FAIL,
    STATUS.RETEST, STATUS.WAITING, STATUS.RUNNING,
    STATUS.RETEST, STATUS.RETEST, STATUS.PASS, STATUS.FAIL
  ];
  const r = db.prepare(UPSERT_SQL).run(...params);
  const after = db.prepare(
    'SELECT retest_count FROM result WHERE proc_order_no = ? AND unit_index = ?'
  ).get(procOrderNo, unitIndex);
  return {
    written: r.changes > 0,
    procOrderNo,
    unitIndex,
    retestCount: after && Number.isFinite(after.retest_count) ? after.retest_count : firstRetest
  };
}

/**
 * 某工单的「已完成」件数（FR-4.4 一次性合格率的分母 / FR-5.11 工单超时预警的减数）：
 * `result` 表里 `DONE_STATUS`（合格＋不合格）的行数。
 *
 * ⚠ 复检（`待复检`）**不计已完成**（尚未定论），与 `services/stats.js` 的 `DONE_STATUS` 同一口径；
 *   "按件计"而非"按工单计"的依据是 DR-19（按件固化）与 DR-05 的 `unit_index` 列。
 * @param {object} db
 * @param {string} procOrderNo
 * @returns {number} 件数（该工单一行都没有 ⇒ 0 —— 现在 0 是"真的是 0"，因为写入点已在
 *  `server/index.js` 的 1 s 采样落库之后按件落库）
 */
function countDone(db, procOrderNo) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('result: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const key = assertProcOrderNo(procOrderNo);
  const hit = db.prepare(COUNT_DONE_SQL).get(key, DONE_STATUS[0], DONE_STATUS[1]);
  return hit && typeof hit.n === 'number' ? hit.n : 0;
}

/** 按件读取一行（供自检/探针与后续界面切源；取不到 ⇒ null，**不编造**） */
function getOne(db, procOrderNo, unitIndex) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('result: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const row = db.prepare(
    `SELECT proc_order_no, unit_index, result, judged_at, retest_count, duration_sec,
            created_at, updated_at
       FROM result WHERE proc_order_no = ? AND unit_index = ?`
  ).get(assertProcOrderNo(procOrderNo), assertUnitIndex(unitIndex));
  return row || null;
}

/** 某工单的行数（供自检对账"同件重复推帧不新增行"；**只报告不推断**） */
function countByTask(db, procOrderNo) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('result: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  return db.prepare('SELECT COUNT(*) AS c FROM result WHERE proc_order_no = ?')
    .get(assertProcOrderNo(procOrderNo)).c;
}

module.exports = {
  STATUS,
  DONE_STATUS,
  TIME_RE,
  TEXT_MAX,
  DURATION_SEC_MAX,
  assertTime,
  assertProcOrderNo,
  assertUnitIndex,
  assertResult,
  assertDurationSec,
  upsertJudgement,
  countDone,
  getOne,
  countByTask
};
