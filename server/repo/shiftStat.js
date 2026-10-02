/* ==========================================================================
   班次统计仓储（server/repo/shiftStat.js）—— DR-06（技术债 `E59` 「写入归口」的落点，
   依据 ADR-0009 D1／D3／D4，负责人 2026-10-02 裁定 A1）
   作用：`shift_stat` 表（DR-06）的**唯一写入口**与三个读口。**只做 SQL 与入参校验，不做业务判断** ——
         "什么时候固化哪一班、读什么值"由业务层决定：班次边界真源＝`server/services/shift.js`，
         取数口径＝`server/services/stateSnapshot.js` 的 `statsForShift()`，
         接线（**既有 1 s 采样 tick 内**检测跨班 ⇒ 固化上一班 ＋ 按序补记）在 `server/index.js` 的
         `freezeCrossedShifts()`；**不新增定时器**（ADR-0009 D3①）。
   依据：DR-06（班次统计表：班次日期、班次、计划数、开工数、完成数、合格数、不合格数、复检数、
        合格率、运行/待机时长、稼动率；"班次结束时固化"）、DR-17（累计运行需持久化）、
        FR-4.16（跨零点归属正确）、FR-6.4/6.5/6.6（当日/本月/年度累计，跨零点/跨月/跨年归零）、
        DR-16（时间格式 yyyy-MM-dd HH:mm:ss）、ADR-0003 D17（时间一律注入，本文件不读系统时间）。
   表与列（唯一真源：`server/db/schema.sql` 的 `shift_stat`；本模块**不做**运行时补列/迁移）：
         shift_date    班次日期（**跨零点按班次归属规则**＝班次开始那一天，DR-06；真源＝shift.js 的 date）
         shift_name    班次名（早班/中班/晚班；真源＝配置 `shift.list`）
         plan_qty      计划数（FR-4.1）、started_qty 开工数（FR-4.2）、finished_qty 完成数（FR-4.4）
         qualified_qty 合格数（FR-4.7）、failed_qty 不合格数（FR-4.8）、retest_qty 复检数（FR-4.9）
         pass_rate     一次性合格率（FR-4.10）、run_sec 有效运行时长、idle_sec 待机时长、
         oee           稼动率（FR-4.15）、frozen_at 固化时刻、created_at 行创建时刻
   幂等（**同一班次归属不得重复插入**）：
         `ux_shift_stat(shift_date, shift_name)`（`schema.sql` 的既有唯一索引）＋
         `ON CONFLICT ... DO UPDATE`（带下面的**信息单调**守卫）⇒ 同一班次重复固化**不新增行**。
         ⚠ 本决策**不改结构**（ADR-0009 D5：五张表结构已就绪、不新增列）⇒ 幂等复用既有唯一索引，
           不在本文件里做任何 `CREATE INDEX`（结构归口＝`server/db/index.js`，ADR-0006）。
   固化与补记的**信息单调**（为什么 UPDATE 还要带 `WHERE`）：
         · 正常固化＝班次结束后按**库内真源**重算（`task`＋`measure_rt`＋`result` 的窗口取数）；
           同一窗口重算的结果逐列相同 ⇒ UPDATE 是**幂等空操作**（行数不变、读数不变）；
         · **补记**（服务端重启/卡顿错过边界）同样按库内真源重算 ⇒ 补记与固化走**同一条口径**，
           区别只在"这一班我们看没看见过"；
         · 唯一的守卫：**不许把"可判定"的读数覆盖成"无法判定"**（`WHERE NOT (新行 unknown AND 旧行 known)`）——
           依据是 `measure_rt` 会被保留策略裁剪（DR-14／NFR-21）：一个老窗口**迟到的重算**可能因为
           帧已被裁掉而算出更少的信息；已固化的读数**不回退**（与 `repo/result.js` 的"终态不回退"同一纪律）。
   补记**不得伪造数据**（技术债 `E38` 的既有口径：**无法计算 ⇒ 显式 `null`／状态位，不用 0 顶替**）：
         `shift_stat` 的计数列是 `INTEGER NOT NULL DEFAULT 0`（列约束，结构不动），故"没有数据"这件事
         只能由**可空列**承载 —— 本模块定下并写死一条读法：
           · `oee IS NULL`            ⇒ **本班次的"有效运行时长"无法判定**（该窗口内一条采集帧都没有：
                                         设备没跑 / 链路断了 / 服务没运行，三者**不可区分** ⇒ 不得写成"零运行"）；
           · `pass_rate IS NULL`      ⇒ **本班次的合格率无法计算**（该窗口内没有判定件，分母为 0）；
           · 两列都为 `NULL`          ⇒ 本行是**补记占位行**（只承载"这个班次存在过"与窗口事实）；
           · 两列都不为 `NULL`        ⇒ 该班次的运行时长与合格率**都可判定**。
         于是 `run_sec = 0` 有两种完全不同的含义，读方**必须**用 `oee`/`pass_rate` 区分：
         `oee = 0` ＝"确实一帧都没有/一帧都不足"的**真 0%**，`oee IS NULL` ＝"**算不出来**"。
         （这就是"不用 0 顶替"的落地形态：0 只写在该写的地方，算不出来的地方留 NULL。）
   读口（三个，供 `stateSnapshot` 与 `/health`／探针用）：
         · `getShiftRow(db, shiftDate, shiftName)` —— 「**上次累计**」读口：取某班次已固化行
           （DR-17 的 `addRunSec` ＝ 当班实时 `runSec` − 本行 `run_sec`，见 `stateSnapshot.statsOf()`）；
         · `sumRunSec(db, {day, month, year})` —— 「**区间求和**」读口：按 `shift_date` 对三档求和
           （当日/本月/本年；**含跨零点与跨月归属** —— 归属键就是 DR-06 的 `shift_date`），
           同时给出各档内"无法判定"的行数（`undetermined`），**不把占位行的 0 当成真 0**；
         · `listRows(db, limit)` / `countRows(db)` —— 对账（探针与 `/health` 的只读使用）。
   依赖：仅传入的 db 句柄；本文件不 require 任何业务服务（避免与 `services/*` 形成环）。
   ========================================================================== */
'use strict';

/* DR-16 时间格式：yyyy-MM-dd HH:mm:ss（恰好 19 字符）。入库口校验的理由与 `repo/result.js`
   逐字相同：`shift_date` 与 `triggered_at` 类列的排序/区间比较都是**文本比较**，混入带毫秒/带 T/
   带时区的时间会让"文本序＝时间序"静默失效。 */
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** 班次日期（`shift_date`）：只要日期部分 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 月份键 / 年份键（「区间求和」读口的入参形态） */
const MONTH_RE = /^\d{4}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;

/** 文本列最大长度（班次名；超长一律拒收而不是截断，避免悄悄改名） */
const TEXT_MAX = 200;
/** 计数/时长列的上界：**一个班次**的秒数最多是一整天（24 h）——超过它必是口径错位（秒/毫秒混淆等） */
const SHIFT_SEC_MAX = 24 * 60 * 60;

/** 校验时间文本（DR-16）；不合规即抛错并指出实际值 */
function assertTime(value, field) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new TypeError(
      `shiftStat: ${field} 必须是「yyyy-MM-dd HH:mm:ss」（DR-16，19 字符），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 校验班次日期（DR-06 的归属键成分之一） */
function assertShiftDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new TypeError(`shiftStat: shiftDate 必须是「yyyy-MM-dd」（DR-06 的班次归属日），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 校验班次名（非空文本，DR-06 的归属键成分之一） */
function assertShiftName(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`shiftStat: shiftName 必须是非空字符串（DR-06 的班次名），收到 ${JSON.stringify(value)}`);
  }
  const s = value.trim();
  if (s.length > TEXT_MAX) throw new RangeError(`shiftStat: shiftName 长度 ${s.length} 超过上限 ${TEXT_MAX}`);
  return s;
}

/** 校验计数（**非负整数**；缺省即 0 —— 与列的 `NOT NULL DEFAULT 0` 同一取值域） */
function assertCount(value, field) {
  const n = value === undefined || value === null ? 0 : value;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`shiftStat: ${field} 必须是 ≥ 0 的整数，收到 ${JSON.stringify(value)}`);
  }
  return n;
}

/** 校验秒数（非负整数且 ≤ 一天；`run_sec`/`idle_sec` 是 `INTEGER NOT NULL`） */
function assertSec(value, field) {
  const n = assertCount(value, field);
  if (n > SHIFT_SEC_MAX) {
    throw new RangeError(`shiftStat: ${field} 不得超过一天（${SHIFT_SEC_MAX} 秒），收到 ${value}`);
  }
  return n;
}

/** 校验可空的比率列（`pass_rate`/`oee` 是 `REAL`，**允许 NULL ＝ 无法判定/无法计算**，见文件头） */
function assertNullableRate(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new TypeError(
      `shiftStat: ${field} 必须是 0～100 的有限数或 null（null ＝"无法判定"，不是 0），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 班次归属键（＝唯一索引 `ux_shift_stat` 的两列，供日志/回执/探针读） */
function shiftKeyOf(shiftDate, shiftName) {
  return `${shiftDate}|${shiftName}`;
}

/* 按班次归属 upsert（唯一索引命中即 UPDATE，**不新增行**）。
   为什么 UPDATE 分支带 `WHERE`（**信息单调守卫**，理由见文件头"固化与补记的信息单调"）：
     · `excluded` 是本次重算的行；`shift_stat` 是库内既有行；
     · 只有"本次**也是**无法判定（pass_rate 与 oee 都为 NULL）而既有行**可判定**"这一种组合要拦住
       —— 它只可能来自"老窗口的帧被保留策略裁掉后的迟到重算"，不得让已固化的读数回退；
     · 其余情形（同值重算、占位行升级为可判定、迟到帧补足）一律允许 UPDATE ⇒ 幂等且单调。
   `created_at` 只在 INSERT 时落（行创建时刻），UPDATE 分支不动它。 */
const UPSERT_SQL =
  `INSERT INTO shift_stat(
     shift_date, shift_name, plan_qty, started_qty, finished_qty, qualified_qty,
     failed_qty, retest_qty, pass_rate, run_sec, idle_sec, oee, frozen_at, created_at)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(shift_date, shift_name) DO UPDATE SET
     plan_qty = excluded.plan_qty,
     started_qty = excluded.started_qty,
     finished_qty = excluded.finished_qty,
     qualified_qty = excluded.qualified_qty,
     failed_qty = excluded.failed_qty,
     retest_qty = excluded.retest_qty,
     pass_rate = excluded.pass_rate,
     run_sec = excluded.run_sec,
     idle_sec = excluded.idle_sec,
     oee = excluded.oee,
     frozen_at = excluded.frozen_at
   WHERE NOT ((excluded.pass_rate IS NULL AND excluded.oee IS NULL)
              AND (shift_stat.pass_rate IS NOT NULL OR shift_stat.oee IS NOT NULL))`;

/**
 * 固化/补记一个班次（`shift_stat` 表的**唯一写入口**）。
 *
 * 幂等与单调（都在 SQL 里做，不读-改-写 ⇒ 无丢失更新窗口）：
 *   · 同一 `(shiftDate, shiftName)` 再来 ⇒ **UPDATE 既有行**，不新增（唯一索引 `ux_shift_stat`）；
 *   · 已"可判定"的行不被"无法判定"的重算覆盖（信息单调，见 `UPSERT_SQL` 上方注释）。
 *
 * @param {object} db 数据库句柄
 * @param {{shiftDate:string, shiftName:string, planQty?:number, startedQty?:number, finishedQty?:number,
 *          qualifiedQty?:number, failedQty?:number, retestQty?:number, passRate:number|null,
 *          runSec:number, idleSec:number, oee:number|null, frozenAt:string, createdAt:string}} row
 *        `passRate` / `oee` **显式允许 `null`** ＝"无法计算/无法判定"（**不得**用 0 顶替，见文件头）；
 *        `frozenAt` ＝ **固化（或补记）动作发生的时刻**（调用方的注入时钟给出，ADR-0003 D17）——
 *        补记行的 `frozenAt` 晚于班次结束时刻，两者之差就是"补记"这件事的可读证据（本表没有状态位列）；
 *        `createdAt` ＝ 行创建时刻（首次落库时刻；UPDATE 分支不覆盖）。
 * @returns {{written:boolean, shiftDate:string, shiftName:string, shiftKey:string, updated:boolean}}
 *   `written` ＝ 写入语句影响了行（INSERT 或 UPDATE 都算）；`updated` ＝ 命中的是既有行
 *   （`written:false` 只可能来自"信息单调守卫"拦下的空操作）。
 */
function upsertFrozen(db, row) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('shiftStat: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const input = row && typeof row === 'object' ? row : {};
  const shiftDate = assertShiftDate(input.shiftDate);
  const shiftName = assertShiftName(input.shiftName);
  const planQty = assertCount(input.planQty, 'planQty');
  const startedQty = assertCount(input.startedQty, 'startedQty');
  const finishedQty = assertCount(input.finishedQty, 'finishedQty');
  const qualifiedQty = assertCount(input.qualifiedQty, 'qualifiedQty');
  const failedQty = assertCount(input.failedQty, 'failedQty');
  const retestQty = assertCount(input.retestQty, 'retestQty');
  const passRate = assertNullableRate(input.passRate, 'passRate');
  const runSec = assertSec(input.runSec, 'runSec');
  const idleSec = assertSec(input.idleSec, 'idleSec');
  const oee = assertNullableRate(input.oee, 'oee');
  const frozenAt = assertTime(input.frozenAt, 'frozenAt');
  const createdAt = assertTime(input.createdAt, 'createdAt');
  const existed = getShiftRow(db, shiftDate, shiftName) !== null;
  const r = db.prepare(UPSERT_SQL).run(
    shiftDate, shiftName, planQty, startedQty, finishedQty, qualifiedQty,
    failedQty, retestQty, passRate, runSec, idleSec, oee, frozenAt, createdAt);
  return {
    written: r.changes > 0,
    shiftDate,
    shiftName,
    shiftKey: shiftKeyOf(shiftDate, shiftName),
    updated: existed
  };
}

/**
 * 「**上次累计**」读口：取某班次已固化的一行（`shift_stat` 的按归属读取）。
 *
 * 用途（DR-17 的唯一落地点）：`stateSnapshot.statsOf()` 用它读**当班已固化**的 `run_sec`，
 * 于是"本周期增量"＝ 当班实时 `runSec` − 本行 `run_sec`（`addRunSec`），已固化部分不会重复计入累计。
 * @param {object} db
 * @param {string} shiftDate `yyyy-MM-dd`（班次归属日）
 * @param {string} shiftName 班次名
 * @returns {object|null} 表行（含 `run_sec`/`oee`/`pass_rate`/`frozen_at`）；无该班次 ⇒ `null`（**不编造**）
 */
function getShiftRow(db, shiftDate, shiftName) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('shiftStat: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const row = db.prepare(
    `SELECT id, shift_date, shift_name, plan_qty, started_qty, finished_qty, qualified_qty,
            failed_qty, retest_qty, pass_rate, run_sec, idle_sec, oee, frozen_at, created_at
       FROM shift_stat WHERE shift_date = ? AND shift_name = ?`
  ).get(assertShiftDate(shiftDate), assertShiftName(shiftName));
  return row || null;
}

/* 「区间求和」读口：三档一次给全（当日/本月/本年），**归属键＝DR-06 的 `shift_date`** ——
   跨零点班次的归属日＝班次开始那一天，故"跨零点归属"由 `shift_date` 自身的口径承载；
   跨月/跨年同理（按 `shift_date` 的月份/年份过滤）。求和**不读时钟**（周期键由调用方给出，D17）。
   `undetermined` ＝ 该档内"无法判定"的行数（`pass_rate` 与 `oee` 都为 NULL 的补记占位行）：
   它们的 `run_sec` 受列约束只能是 0，**不得**被读成"零运行" ⇒ 把这件事作为**状态位**一并报出来。 */
const SUM_SQL =
  `SELECT
     COALESCE(SUM(CASE WHEN shift_date = ? THEN run_sec END), 0)                   AS daySec,
     COALESCE(SUM(CASE WHEN substr(shift_date, 1, 7) = ? THEN run_sec END), 0)     AS monthSec,
     COALESCE(SUM(CASE WHEN substr(shift_date, 1, 4) = ? THEN run_sec END), 0)     AS yearSec,
     COALESCE(SUM(CASE WHEN shift_date = ?
                        AND pass_rate IS NULL AND oee IS NULL THEN 1 ELSE 0 END), 0) AS dayUnknown,
     COALESCE(SUM(CASE WHEN substr(shift_date, 1, 7) = ?
                        AND pass_rate IS NULL AND oee IS NULL THEN 1 ELSE 0 END), 0) AS monthUnknown,
     COALESCE(SUM(CASE WHEN substr(shift_date, 1, 4) = ?
                        AND pass_rate IS NULL AND oee IS NULL THEN 1 ELSE 0 END), 0) AS yearUnknown,
     COUNT(*)                                                                       AS rows
   FROM shift_stat`;

/**
 * 「**区间求和**」读口（DR-17 日/月/年三档累计的真源）。
 * @param {object} db
 * @param {{day:string, month:string, year:string}} period 周期键（由调用方按**注入时钟**算出：
 *        `day`＝`yyyy-MM-dd`、`month`＝`yyyy-MM`、`year`＝`yyyy` —— 本函数不读时钟，D17）
 * @returns {{daySec:number, monthSec:number, yearSec:number,
 *            undetermined:{day:number, month:number, year:number}, rows:number}}
 *   `*Sec` ＝ 该档 `run_sec` 之和（**含**占位行的 0；占位行的真相在 `undetermined` 里）；
 *   `rows` ＝ 表内总行数（对账用）。空表 ⇒ 全 0（"真的是 0"：一个班次都还没固化）。
 */
function sumRunSec(db, period) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('shiftStat: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const p = period && typeof period === 'object' ? period : {};
  if (typeof p.day !== 'string' || !DATE_RE.test(p.day)) {
    throw new TypeError(`shiftStat.sumRunSec: day 必须是「yyyy-MM-dd」，收到 ${JSON.stringify(p.day)}`);
  }
  if (typeof p.month !== 'string' || !MONTH_RE.test(p.month)) {
    throw new TypeError(`shiftStat.sumRunSec: month 必须是「yyyy-MM」，收到 ${JSON.stringify(p.month)}`);
  }
  if (typeof p.year !== 'string' || !YEAR_RE.test(p.year)) {
    throw new TypeError(`shiftStat.sumRunSec: year 必须是「yyyy」，收到 ${JSON.stringify(p.year)}`);
  }
  const r = db.prepare(SUM_SQL).get(p.day, p.month, p.year, p.day, p.month, p.year);
  return {
    daySec: Number(r.daySec) || 0,
    monthSec: Number(r.monthSec) || 0,
    yearSec: Number(r.yearSec) || 0,
    undetermined: {
      day: Number(r.dayUnknown) || 0,
      month: Number(r.monthUnknown) || 0,
      year: Number(r.yearUnknown) || 0
    },
    rows: Number(r.rows) || 0
  };
}

/** 表内总行数（对账用；**只报告不推断**） */
function countRows(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('shiftStat: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  return db.prepare('SELECT COUNT(*) AS c FROM shift_stat').get().c;
}

/** 按归属日/班次列出若干行（探针与巡检用；不排序推断语义，`ORDER BY shift_date, id` 只为稳定输出） */
function listRows(db, limit) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('shiftStat: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const n = Number.isInteger(limit) && limit > 0 ? limit : 50;
  return db.prepare(
    `SELECT id, shift_date, shift_name, plan_qty, started_qty, finished_qty, qualified_qty,
            failed_qty, retest_qty, pass_rate, run_sec, idle_sec, oee, frozen_at, created_at
       FROM shift_stat ORDER BY shift_date, id LIMIT ?`
  ).all(n);
}

module.exports = {
  TIME_RE,
  DATE_RE,
  MONTH_RE,
  YEAR_RE,
  TEXT_MAX,
  SHIFT_SEC_MAX,
  UPSERT_SQL,
  SUM_SQL,
  shiftKeyOf,
  upsertFrozen,
  getShiftRow,
  sumRunSec,
  countRows,
  listRows
};
