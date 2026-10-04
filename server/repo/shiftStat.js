/* ==========================================================================
   班次统计仓储（server/repo/shiftStat.js）—— DR-06（技术债 `E59` 「写入归口」的落点，
   依据 ADR-0009 D1／D3／D4，负责人 2026-10-02 裁定 A1；`E83` 的自然日投影见下）
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
         shift_date      班次日期（**跨零点按班次归属规则**＝班次开始那一天，DR-06；真源＝shift.js 的 date）
         shift_name      班次名（早班/中班/晚班；真源＝配置 `shift.list`）
         plan_qty        计划数（FR-4.1）、started_qty 开工数（FR-4.2）、finished_qty 完成数（FR-4.4）
         qualified_qty   合格数（FR-4.7）、failed_qty 不合格数（FR-4.8）、retest_qty 复检数（FR-4.9）
         pass_rate       一次性合格率（FR-4.10）、run_sec 有效运行时长、idle_sec 待机时长、
         oee             稼动率（FR-4.15）、frozen_at 固化时刻、created_at 行创建时刻
         run_sec_day1    ★`E83` **自然日投影**：本班运行秒数里落在**班次开始那一自然日**的部分
         run_sec_day2    ★`E83` **自然日投影**：落在**次日**的那部分（不跨零点班次恒为 0）
   两个投影（**同一行的两套口径，互不代偿**；负责人 2026-10-04 裁定）：
         · **班次投影**＝整班归"班次开始的那一天"（`DR-06` 逐字／`FR-4.16`）⇒ 读 `run_sec`，
           供 §4.4 生产统计的班次指标、`E89` 保留裁剪、`shift_stat` 的"一行一班次"；
         · **自然日投影**＝运行秒数按**零点切段**（前段归 D、后段归 D+1）⇒ 读 `run_sec_day1`／
           `run_sec_day2`，供 `FR-6.4`／`6.5`／`6.6` 与 `FR-6.12` 的 ≤1% 对账。
         ⚠ **现配置（0-8／8-16／16-24）无跨零点班次** ⇒ 两套投影**恒同值**（`run_sec_day2` 恒 0）：
           这不是"巧合"，而是"改口径不改读数"的硬保证 —— 见 `services/stats.js` 的
           `splitRunSecondsByDay()` 与 `tests\._verify\e83-*.js` 的改前/改后逐字比对。
   幂等（**同一班次归属不得重复插入**）：
         `ux_shift_stat(shift_date, shift_name)`（`schema.sql` 的既有唯一索引）＋
         `ON CONFLICT ... DO UPDATE`（带下面的**信息单调**守卫）⇒ 同一班次重复固化**不新增行**；
         两段切段值随 `run_sec` 一起被 UPSERT 覆盖（同窗口重算 ⇒ 逐列相同 ⇒ 幂等空操作）。
   固化与补记的**信息单调**（为什么 UPDATE 还要带 `WHERE`）：
         · 正常固化＝班次结束后按**库内真源**重算（`task`＋`measure_rt`＋`result` 的窗口取数）；
           同一窗口重算的结果逐列相同 ⇒ UPDATE 是**幂等空操作**（行数不变、读数不变）；
         · **补记**（服务端重启/卡顿错过边界）同样按库内真源重算 ⇒ 补记与固化走**同一条口径**，
           区别只在"这一班我们看没看见过"；
         · 唯一的守卫：**不许把"可判定"的读数覆盖成"无法判定"**（`WHERE NOT (新行 unknown AND 旧行 known)`）——
           依据是 `measure_rt` 会被保留策略裁剪（DR-14／NFR-21）：一个老窗口**迟到的重算**可能因为
           帧已被裁掉而算出更少的信息；已固化的读数**不回退**（与 `repo/result.js` 的"终态不回退"同一纪律）。
         · `E83` 追加同一条纪律的第二个落点：**不许把已切段的两段覆盖成 NULL**（`run_sec_day1`
           `IS NOT NULL` 的既有行不被"没算过切段"的重算清空）—— 否则自然日投影会**静默回退**
           成"整段归当日"，而那正是 `E83` 要消掉的那个错位。
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
         ★`E83` 的**第三对可空列**（`run_sec_day1`/`run_sec_day2`）按**同一条读法**处理，但含义不同：
           · 两列都为 `NULL` ⇒ 本行**按旧口径写入、未做自然日切段**（`SCHEMA_VERSION < '7'` 的库）；
             读口 `runDaysOf()` 因此把**整段** `run_sec` 当作"落在班次开始日"—— 与 `E83` 之前的
             读数**逐字相同**（`E83` 之前该日档本来就等于 `Σ run_sec(shift_date = D)`）；
             ⚠ 用 0 顶替这里会**静默少算**：跨零点班的"开始日那一段"会凭空消失。
           · 两列都**非 NULL** ⇒ 切段已算过，且恒有 `d1 + d2 === run_sec`（写入口校验）——
             读方按段取，**不再**回落到整段。
   读口（三个，供 `stateSnapshot` 与 `/health`／探针用）：
         · `getShiftRow(db, shiftDate, shiftName)` —— 「**上次累计**」读口：取某班次已固化行
           （DR-17 的 `addRunSec` ＝ 当班实时 `runSec` − 本行 `run_sec`，见 `stateSnapshot.statsOf()`）；
         · `sumRunSec(db, {day, month, year})` —— 「**区间求和**」读口，**一次给两套投影**：
             · `daySec`/`monthSec`/`yearSec`  ＝ **自然日投影**（`E83` 后；`FR-6.4/6.5/6.6` 的真源）：
               `day` 那一档取"班次归属日＝D 的 `run_sec_day1`"＋"班次归属日＝D−1 的 `run_sec_day2`"
               （跨零点班的后半段**归 D+1**）；月/年档同理（两段都进，见下）；
             · `shiftDaySec`/`shiftMonthSec`/`shiftYearSec` ＝ **班次投影**（`E83` 之前的口径，逐字保留）：
               按 `shift_date` 对 `run_sec` 求和（整班归开始日，`DR-06`）；供班组指标与
               "**无跨零点配置时两投影必须同值**"这条定点判据对账；
             · `undetermined` ＝ 该档内"无法判定"的行数（`pass_rate` 与 `oee` 都为 NULL 的补记占位行）；
             · `rows` ＝ 表内总行数。
           ⚠ **两套投影都不是估的**：`shiftDaySec` 是 `E83` 之前的**原式**（供对账与回退），
             `daySec` 是切段后的真值；现配置下二者**必须逐字相等**（`run_sec_day2 ≡ 0`）。
         · `listRows(db, limit)` / `countRows(db)` —— 对账（探针与 `/health` 的只读使用）。
   依赖：仅传入的 db 句柄 ＋ `platform/clock.js` 的 `fmtDate`（**纯日期文本运算**，不读系统时间）。
    ========================================================================== */
'use strict';

const { fmtDate } = require('../../platform/clock');

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

/** 校验可空秒数（`E83` 的 `run_sec_day1`/`run_sec_day2`：`INTEGER` 可空，`null` ＝"未做切段"） */
function assertNullableSec(value, field) {
  if (value === undefined || value === null) return null;
  return assertSec(value, field);
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

/**
 * `E83` 的**段映射**（纯函数，读口用）：一行 `shift_stat` 的 `(run_sec, run_sec_day1, run_sec_day2)`
 * → "它给**哪些自然日**各贡献多少秒"。
 *
 * 三条读法（每一条都对应一种真实形态；**不用 0 顶替 NULL**，见文件头"第三对可空列"）：
 *   ① 两列都为 `NULL`（`SCHEMA_VERSION < '7'` 的旧行、或旧写入口写的行）⇒ **整段归班次开始日**：
 *      `[{day: fromDate, sec: runSec}]` —— 与 `E83` 之前"该日档＝Σ run_sec(shift_date = D)"逐字相同；
 *   ② 两列都非 `NULL` 且 `run_sec_day2 === 0` ⇒ 未跨自然日 ⇒ 整段归 `fromDate`（同上，但**是算出来的**）；
 *   ③ 两列都非 `NULL` 且 `run_sec_day2 > 0` ⇒ **跨了零点**：`day1` 归 `fromDate`、`day2` 归 `fromDate + 1`。
 *
 * @param {{fromDate:string, runSec:number, runSecDay1:number|null, runSecDay2:number|null}} row
 * @returns {Array<{day:string, sec:number}>} 段列表（`sec` 为 0 的段**不返回** —— 空段不贡献读数）
 */
function segmentsOf(row) {
  const fromDate = String(row.fromDate);
  const runSec = Math.max(0, Math.round(Number(row.runSec) || 0));
  const d1 = row.runSecDay1 === undefined || row.runSecDay1 === null ? null : Math.max(0, Math.round(Number(row.runSecDay1)));
  const d2 = row.runSecDay2 === undefined || row.runSecDay2 === null ? null : Math.max(0, Math.round(Number(row.runSecDay2)));
  /* ① 旧行（未切段）⇒ 整段归开始日。⚠ 这是**兜底读法**，不是"切段结果"：它把跨零点班的后半段
     也算在开始日（正是 `E83` 要消掉的错位），但对**不跨零点**的旧行它是**逐字正确**的
     —— 而旧库里只可能有"不跨零点或未切段的跨零点"两种行（跨零点配置在 `E128` 的闸后面）。 */
  if (d1 === null && d2 === null) return runSec > 0 ? [{ day: fromDate, sec: runSec }] : [];
  /* 半 NULL：写入口恒等式被绕过（直改库/漏列）⇒ **不回退、也不静默**：按"未切段"读整段，
     让读数不至于丢掉，但这件事必须能被发现 —— 读口把它当旧行处理（同上），并留给门禁去指名。 */
  if (d1 === null || d2 === null) return runSec > 0 ? [{ day: fromDate, sec: runSec }] : [];
  const nextDate = fmtDate(nextDayOf(fromDate));
  const out = [];
  if (d1 > 0) out.push({ day: fromDate, sec: d1 });
  if (d2 > 0) out.push({ day: nextDate, sec: d2 });
  return out;
}

/** 日期文本 +1 天（`yyyy-MM-dd`；**纯文本/日期运算，不读系统时间**，D17） */
function nextDayOf(dateText) {
  const d = new Date(`${dateText}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d;
}

/**
 * `E83` 读口的**取数投影**（纯函数，`SUM_SQL` 的行 → 两套投影的读数）。
 *
 * 为什么要有这一层（而不是直接在 SQL 里堆 CASE）：`SUM_SQL` 已经很长，而"行 → 哪些自然日各多少秒"
 * 的读法（`segmentsOf()`）是**有分支的口径**（旧行兜底／切段），写在 SQL 里就会出现**第二份口径**
 * —— 而这份口径必须能在探针里被逐条断言。故分工：SQL 只负责**取行**（过滤由参数给），
 * 本函数负责**按段归集**，两套投影一次给全。
 *
 * @param {Array<{shift_date:string, run_sec:number, run_sec_day1:number|null, run_sec_day2:number|null,
 *                pass_rate:number|null, oee:number|null}>} rows 库内行（不排序、不推断）
 * @param {{day:string, month:string, year:string}} period 周期键（由调用方按**注入时钟**算出）
 * @returns {{daySec, monthSec, yearSec, shiftDaySec, shiftMonthSec, shiftYearSec,
 *            undetermined:{day,month,year}, rows:number}}
 */
function projectRows(rows, period) {
  const out = {
    /* **自然日投影**（`E83` 之后；`FR-6.4/6.5/6.6` 的真源） */
    daySec: 0, monthSec: 0, yearSec: 0,
    /* **班次投影**（`E83` 之前的原式：整班归 `shift_date`；`DR-06`／对账用） */
    shiftDaySec: 0, shiftMonthSec: 0, shiftYearSec: 0,
    undetermined: { day: 0, month: 0, year: 0 },
    rows: 0
  };
  for (const r of rows || []) {
    out.rows++;
    const runSec = Math.max(0, Math.round(Number(r.run_sec) || 0));
    const fromDate = String(r.shift_date);
    /* 班次投影：一把 `shift_date`，与 `E83` 之前的 `SUM_SQL` 逐字同口径 */
    if (fromDate === period.day) out.shiftDaySec += runSec;
    if (fromDate.slice(0, 7) === period.month) out.shiftMonthSec += runSec;
    if (fromDate.slice(0, 4) === period.year) out.shiftYearSec += runSec;
    /* 无法判定（两个状态位**同时**为 NULL 的补记占位行）按 `shift_date` 的三档计 —— 与 `E83` 之前一致 */
    if (r.pass_rate === null && r.oee === null) {
      if (fromDate === period.day) out.undetermined.day++;
      if (fromDate.slice(0, 7) === period.month) out.undetermined.month++;
      if (fromDate.slice(0, 4) === period.year) out.undetermined.year++;
    }
    /* 自然日投影：按段归集 */
    for (const seg of segmentsOf({ fromDate, runSec, runSecDay1: r.run_sec_day1, runSecDay2: r.run_sec_day2 })) {
      if (seg.day === period.day) out.daySec += seg.sec;
      if (seg.day.slice(0, 7) === period.month) out.monthSec += seg.sec;
      if (seg.day.slice(0, 4) === period.year) out.yearSec += seg.sec;
    }
  }
  return out;
}

/* 按班次归属 upsert（唯一索引命中即 UPDATE，**不新增行**）。
   为什么 UPDATE 分支带 `WHERE`（**信息单调守卫**，理由见文件头"固化与补记的信息单调"）：
     · `excluded` 是本次重算的行；`shift_stat` 是库内既有行；
     · 只有"本次**也是**无法判定（pass_rate 与 oee 都为 NULL）而既有行**可判定**"这一种组合要拦住
       —— 它只可能来自"老窗口的帧被保留策略裁掉后的迟到重算"，不得让已固化的读数回退；
     · `E83` 的第二条：本次**没算切段**（`run_sec_day1 IS NULL`）而既有行**算过**
       （`run_sec_day1 IS NOT NULL`）⇒ 同样拦住 —— 否则自然日投影会静默回退成"整段归开始日"。
     · 其余情形（同值重算、占位行升级为可判定、迟到帧补足）一律允许 UPDATE ⇒ 幂等且单调。
   `created_at` 只在 INSERT 时落（行创建时刻），UPDATE 分支不动它。 */
const UPSERT_SQL =
  `INSERT INTO shift_stat(
     shift_date, shift_name, plan_qty, started_qty, finished_qty, qualified_qty,
     failed_qty, retest_qty, pass_rate, run_sec, run_sec_day1, run_sec_day2,
     idle_sec, oee, frozen_at, created_at)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(shift_date, shift_name) DO UPDATE SET
     plan_qty = excluded.plan_qty,
     started_qty = excluded.started_qty,
     finished_qty = excluded.finished_qty,
     qualified_qty = excluded.qualified_qty,
     failed_qty = excluded.failed_qty,
     retest_qty = excluded.retest_qty,
     pass_rate = excluded.pass_rate,
     run_sec = excluded.run_sec,
     run_sec_day1 = excluded.run_sec_day1,
     run_sec_day2 = excluded.run_sec_day2,
     idle_sec = excluded.idle_sec,
     oee = excluded.oee,
     frozen_at = excluded.frozen_at
   WHERE NOT ((excluded.pass_rate IS NULL AND excluded.oee IS NULL)
              AND (shift_stat.pass_rate IS NOT NULL OR shift_stat.oee IS NOT NULL))
     AND NOT (excluded.run_sec_day1 IS NULL AND shift_stat.run_sec_day1 IS NOT NULL)`;

/* 读口的取列清单（三个读口共用**一份**列名，避免"某个读口漏了一列"这种静默分叉） */
const ROW_COLUMNS =
  'id, shift_date, shift_name, plan_qty, started_qty, finished_qty, qualified_qty, ' +
  'failed_qty, retest_qty, pass_rate, run_sec, run_sec_day1, run_sec_day2, idle_sec, oee, frozen_at, created_at';

/**
 * 固化/补记一个班次（`shift_stat` 表的**唯一写入口**）。
 *
 * 幂等与单调（都在 SQL 里做，不读-改-写 ⇒ 无丢失更新窗口）：
 *   · 同一 `(shiftDate, shiftName)` 再来 ⇒ **UPDATE 既有行**，不新增（唯一索引 `ux_shift_stat`）；
 *   · 已"可判定"的行不被"无法判定"的重算覆盖；已切段的行不被"没算切段"的重算清空（见 `UPSERT_SQL`）。
 *
 * `E83` 的切段校验（**恒等式在这里守住**）：`runSecDay1`/`runSecDay2` **要么都给、要么都不给**：
 *   · 都不给（缺省）⇒ 落 `NULL` ＝"本行未做自然日切段"（读口按整段归开始日兜底）；
 *   · 都给 ⇒ 必须 `runSecDay1 + runSecDay2 === runSec`（切段是**划分**，不是估计：
 *     丢秒或重复计都当场拒收）。**半给**（只给一段）一律拒收 —— 那一定是调用方算错了。
 *
 * @param {object} db 数据库句柄
 * @param {{shiftDate:string, shiftName:string, planQty?:number, startedQty?:number, finishedQty?:number,
 *          qualifiedQty?:number, failedQty?:number, retestQty?:number, passRate:number|null,
 *          runSec:number, runSecDay1?:number|null, runSecDay2?:number|null,
 *          idleSec:number, oee:number|null, frozenAt:string, createdAt:string}} row
 *        `passRate` / `oee` **显式允许 `null`** ＝"无法计算/无法判定"（**不得**用 0 顶替，见文件头）；
 *        `runSecDay1`/`runSecDay2` 缺省即 `null`（＝未切段）；真源＝`services/stats.js` 的
 *        `computeShiftStats()` 返回的 `runSecDay1`/`runSecDay2`（`splitRunSecondsByDay()` 的产物）；
 *        `frozenAt` ＝ **固化（或补记）动作发生的时刻**（调用方的注入时钟给出，ADR-0003 D17）——
 *        补记行的 `frozenAt` 晚于班次结束时刻，两者之差就是"补记"这件事的可读证据（本表没有状态位列）；
 *        `createdAt` ＝ 行创建时刻（首次落库时刻；UPDATE 分支不覆盖）。
 * @returns {{written:boolean, shiftDate:string, shiftName:string, shiftKey:string, updated:boolean,
 *            runSec:number, runSecDay1:number|null, runSecDay2:number|null, runDays:Array<{day:string,sec:number}>}}
 *   `written` ＝ 写入语句影响了行（INSERT 或 UPDATE 都算）；`updated` ＝ 命中的是既有行
 *   （`written:false` 只可能来自"信息单调守卫"拦下的空操作）。
 *   `runDays` ＝ 本行**落库后**按自然日的段列表（读口同源的 `segmentsOf()`，供日志/探针直接引用）。
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
  /* ---- `E83` 切段（形态先校验、再写入：与上面各列同一纪律） ---- */
  const hasD1 = input.runSecDay1 !== undefined && input.runSecDay1 !== null;
  const hasD2 = input.runSecDay2 !== undefined && input.runSecDay2 !== null;
  if (hasD1 !== hasD2) {
    throw new TypeError(
      'shiftStat: runSecDay1/runSecDay2 必须**同时给或同时不给**（半给 = 调用方没算完切段；' +
      `不能一半落库一半留空），收到 runSecDay1=${JSON.stringify(input.runSecDay1)}、` +
      `runSecDay2=${JSON.stringify(input.runSecDay2)}`);
  }
  const runSecDay1 = hasD1 ? assertNullableSec(input.runSecDay1, 'runSecDay1') : null;
  const runSecDay2 = hasD2 ? assertNullableSec(input.runSecDay2, 'runSecDay2') : null;
  if (runSecDay1 !== null && runSecDay1 + runSecDay2 !== runSec) {
    throw new RangeError(
      'shiftStat: 自然日切段必须**恰好划分**整班运行秒数（不丢秒、不重复计）：' +
      `run_sec_day1 + run_sec_day2 应等于 run_sec，收到 ${runSecDay1} + ${runSecDay2} ≠ ${runSec}`);
  }
  const existed = getShiftRow(db, shiftDate, shiftName) !== null;
  const r = db.prepare(UPSERT_SQL).run(
    shiftDate, shiftName, planQty, startedQty, finishedQty, qualifiedQty,
    failedQty, retestQty, passRate, runSec, runSecDay1, runSecDay2, idleSec, oee, frozenAt, createdAt);
  return {
    written: r.changes > 0,
    shiftDate,
    shiftName,
    shiftKey: shiftKeyOf(shiftDate, shiftName),
    updated: existed,
    runSec,
    runSecDay1,
    runSecDay2,
    runDays: segmentsOf({ fromDate: shiftDate, runSec, runSecDay1, runSecDay2 })
  };
}

/**
 * 「**上次累计**」读口：取某班次已固化的一行（`shift_stat` 的按归属读取）。
 *
 * 用途（DR-17 的唯一落地点）：`stateSnapshot.statsOf()` 用它读**当班已固化**的 `run_sec`
 * 与两段切段值，于是"本周期增量"＝ 当班实时读数 − 本行读数（`addRunSec`），
 * 已固化部分不会重复计入。
 * @param {object} db
 * @param {string} shiftDate `yyyy-MM-dd`（班次归属日）
 * @param {string} shiftName 班次名
 * @returns {object|null} 表行（含 `run_sec`/`run_sec_day1`/`run_sec_day2`/`oee`/`pass_rate`/`frozen_at`）；
 *   无该班次 ⇒ `null`（**不编造**）
 */
function getShiftRow(db, shiftDate, shiftName) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('shiftStat: 需要已打开的库句柄（server/db 的 openDb 产物）');
  }
  const row = db.prepare(
    `SELECT ${ROW_COLUMNS} FROM shift_stat WHERE shift_date = ? AND shift_name = ?`
  ).get(assertShiftDate(shiftDate), assertShiftName(shiftName));
  return row || null;
}

/* 「区间求和」读口：**一次取全表**，两套投影由 `projectRows()` 归集。
   为什么不在 SQL 里做周期过滤：`E83` 的自然日投影要按**段**归集（一行可能跨两个自然日），
   而"行 → 各自然日多少秒"的分支口径只能有一份（`segmentsOf()`）；SQL 侧再写一版 CASE
   就等于两份口径（与 `repo/result.js` 的 `countDone()` 归口同一取舍）。
   本表规模＝"班次数"（一天 ≤ 3～4 行）⇒ 全表扫描的代价可忽略，换来的是**单一口径**。
   ⚠ 求和**不读时钟**（周期键由调用方按注入时钟给出，D17）。 */
const SUM_SQL = `SELECT ${ROW_COLUMNS} FROM shift_stat ORDER BY id`;

/**
 * 「**区间求和**」读口（DR-17 日/月/年三档累计的真源；`E83` 后**一次给两套投影**）。
 * @param {object} db
 * @param {{day:string, month:string, year:string}} period 周期键（由调用方按**注入时钟**算出：
 *        `day`＝`yyyy-MM-dd`、`month`＝`yyyy-MM`、`year`＝`yyyy` —— 本函数不读时钟，D17）
 * @returns {{daySec:number, monthSec:number, yearSec:number,
 *            shiftDaySec:number, shiftMonthSec:number, shiftYearSec:number,
 *            undetermined:{day:number, month:number, year:number}, rows:number}}
 *   `daySec`/`monthSec`/`yearSec` ＝ **自然日投影**（`E83`：按零点切段；`FR-6.4/6.5/6.6`）；
 *   `shiftDaySec`/`shiftMonthSec`/`shiftYearSec` ＝ **班次投影**（整班归 `shift_date`；`DR-06`，对账用）；
 *   `undetermined` ＝ 该档内"两个状态位都为 NULL"的行数；`rows` ＝ 表内总行数。
 *   空表 ⇒ 全 0（"真的是 0"：一个班次都还没固化）。
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
  return projectRows(db.prepare(SUM_SQL).all(), { day: p.day, month: p.month, year: p.year });
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
    `SELECT ${ROW_COLUMNS} FROM shift_stat ORDER BY shift_date, id LIMIT ?`
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
  segmentsOf,
  nextDayOf,
  projectRows,
  upsertFrozen,
  getShiftRow,
  sumRunSec,
  countRows,
  listRows
};
