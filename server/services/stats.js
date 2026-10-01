/* ==========================================================================
   当班生产统计（server/services/stats.js）
   作用：FR-4 全组 15 项指标的**唯一核算处**；统计口径（公式）**就写在本文件里**，
        是服务端的**权威实现**（ADR-0005 选项 B：公式留在代码，配置只存参数）。
        `src/config/board.config.js` 的 production **只提供参数值**（cycleSec/runRate…），
        **不提供公式**（原 production.formula 属零读取点的死配置，已按 ADR-0005 删除），
        **也不再提供"当班计划数"** —— 计划数（FR-4.1）的真源是 `task.plan_qty` 的当班之和，
        见入参 `orders`；`production.planQty` 自 `E65` 起**仅供前端演示**，服务端不取它。
   Q-11 口径变化时**须同步修改**（改任一处都必须同步其它处，缺一即前后端算出两套结果）：
        1) 本文件「四、派生指标」段的四条算式（firstPassRate/capacityRate/oee/avgTestSec；
           `E65` 之后行号已变，故此处**只写段名**，不再写会过期的具体行号）
        2) `src/services/mockData.js` 的 stats 段（前端演示的第二份同类实现）
        3) `tests/logic-check.js` 中按口径推导的**期望值**
        4) `tests/contract-check.js` 的占位断言（OEE 段）与跨实现一致性断言（M 段）
   设计：**纯函数 + 注入时钟** —— 不读系统时间、不碰数据库、不碰界面，
        因此可以用固定时刻把"班次边界/跨零点/累计不倒退"逐条钉死（FR-4.16 / DR-17）。
   粒度与计量单位（技术债 `E65` ＋ `E69`；需求 V1.41 §0.2 / C-111）：
        FR-4 的 15 项指标原先**共用一个 `tasks` 入参**（票级与件级混用），`E65` 拆分后又留下
        `E69` 这个**单位错配**（开工按"票"计、计划按"件"计 ⇒ FR-4.3 减数与被减数不同单位）。
        现口径：
          · **计量单位统一为「测试任务（件）」**（C-111）：**派工**＝`DR-02` `task` 一行
            （`IF-A.1` 一条报文，含 `dispatchQty` 个测试任务）；**测试任务/件**＝一次测试
            （以 `measure_rt.unit_index` 区分）。故 FR-4.1 计划数 / FR-4.2 开工数 / FR-4.3 未开工
            **同单位**、可直接相减。
          · 入参 `orders`（来自 `task` 表）：每票 `planQty` —— 它是**测试任务数**，不是"票数"；
          · 入参 `startedPieces`（来自 `measure_rt`，取数在 `stateSnapshot.statsOf()`）：
            **当班已开始测试的件数**（`unit_index IS NOT NULL` 且按 `(proc_order_no, unit_index)` 去重）；
          · 入参 `pieces`（来自 `result` 表：`result`、`judged_at`、`duration_sec`）：件级结果态
            （FR-4.4 已完成 / FR-4.5～4.9 / FR-4.10 合格率 / FR-4.13 平均时长）。
        混用的两种错误形态（都实测过，见 `项目记录\后续路线图.md` 的 `E65`／`E69` 行）：
          ① 传 `task.status`：该列**全仓无写入方** ⇒ 恒「待测试」⇒ 开工恒 0；
          ② 传 `result` 行（把"件"当"票"）：`planQty` 变成"已判定件数"、待测恒 0；
          ③ 用"有帧的票数"当开工数（`E69` 原形态）：30 件 / 3 票 ⇒ 未开工 27（减数与被减数不同单位）。
        故 `orders`／`startedPieces`／`pieces` **必须分别取数**（取数在 `server/services/stateSnapshot.js`
        的 `statsOf()`）；`orderTotal`（票数）**是唯一保留的票级量**，不得参与上面的减法。
   关键口径（此前前端踩过的两个坑，这里写成硬约束）：
        · 未开工数 = max(0, 计划 − 开工数)  —— **绝不出现负数**（两数同单位，见上）
        · 累计运行（日/月/年）**单调不减** —— 跨班次不清零，只有跨自然日/月/年才重置
   依赖：platform/clock.js（时间工具）。
   ========================================================================== */
'use strict';

const { startOfDay, startOfMonth, startOfYear, toDate } = require('../../platform/clock');

const STATUS = {
  WAITING: '待测试',
  RUNNING: '测试中',
  PASS: '合格',
  FAIL: '不合格',
  RETEST: '待复检'
};
const DONE_STATUS = [STATUS.PASS, STATUS.FAIL];

/** 安全除（分母为 0 时返回 0，避免 NaN 传到界面） */
function safeDiv(a, b) {
  return b > 0 ? a / b : 0;
}

/** 百分比（保留 1 位小数；与界面口径一致） */
function pct(a, b) {
  return Number((safeDiv(a, b) * 100).toFixed(1));
}

/**
 * 核算当班统计。
 * @param {object} input
 *   @param {object}   input.shift     班次（createShiftRules().at(now) 的结果，含 elapsedSec/totalSec/date/name）
 *   @param {Array}    input.orders    **票级**当班派工票 `[{ planQty }]`
 *       `planQty` ＝ 该票的派工数量（`task.plan_qty`，FR-4.1 的加数）；**单位＝测试任务（件）**
 *       （需求 V1.41 §0.2 / C-111：`IF-A.1` 一条派工报文含 `dispatchQty` 个测试任务）。
 *       调用方只放**当班**票（`task.plan_start_time` 落在班次窗口内；无 `plan_start_time` 的票不参与）。
 *       ⚠ **不要**把"件"（`result` 行）传进来当票 —— 那是 `E65` 的病灶（票级量被件级数据顶替）。
 *       ⚠ 上一版的 `p.started`（每票一个布尔）**已删除**（`E69`）：见下面的 `startedPieces`。
 *   @param {number}   input.startedPieces  **开工数：当班已开始测试的测试任务（件）数**（FR-4.2）。
 *       **单位＝件/测试任务**（不是派工票数、不是采样帧数）—— 口径见 C-111：件以 `unit_index` 区分，
 *       判定依据＝该件在 `measure_rt` 有采样数据；取数在 `server/services/stateSnapshot.js` 的
 *       `statsOf()`（当班窗口内 `unit_index IS NOT NULL`、按 `(proc_order_no, unit_index)` 去重后计数）。
 *       ⚠ 字段名刻意写成 `startedPieces`（而不是 `started`/`startedQty`）就是为了让读者一眼看出
 *         **单位是件**：上一版这里是"每票一个布尔、由本函数数票数"，而 `planQty` 是件数 ⇒
 *         FR-4.3 的**减数与被减数单位不同**（实测 30 件 / 3 票 / 未开工 27），这就是 `E69`。
 *       缺省/非有限值 ⇒ 按 **0** 处理（当班没有已开工的件；绝不产生 `NaN`）。
 *   @param {Array}    input.pieces    **件级**当班测试件 `[{ result, durationSec? }]`
 *       `result` ＝ FR-3.13 五态之一（`STATUS` 的取值域）；`durationSec` ＝ 该件测试时长（秒，FR-4.13 的加数）。
 *       调用方只放**当班**件（`result.judged_at` 落在班次窗口内）。
 *   @param {Array}    input.measures  当班采集时刻串（用于推导有效运行/待机时长；可为空）
 *   @param {object}   input.cycle     { sec } 单任务节拍（生产时长推导用），默认 160
 *   @param {object}   input.accum     累计运行上次落库值（DR-17），形如 { daySec, monthSec, yearSec, at }
 *   @param {number}   [input.addRunSec] **本周期增量**秒数（上次核算之后新增的运行时长）。
 *       缺省即 **0**（不是"当班已运行时长"）—— 见下方 P2-4 说明；调用方必须显式给出增量。
 *       边界：必须是 0 ≤ addRunSec ≤ runSec 的有限数，越界即抛错（防重复相加导致累计虚高）。
 *   @param {number}   [input.planQty]  当班计划数（FR-4.1）的**显式覆盖值**；
 *       缺省 ＝ `Σ orders[].planQty`。★ 服务端**不得**再拿 `board.config.js` 的 `production.planQty`
 *       顶替（那项自 `E65` 起**仅供前端演示**）—— 无派工 ⇒ 计划数就是 **0**，不编造。
 *   @param {string|Date} input.now    当前时刻
 * @returns {object} 15 项指标 + DR-17 累计运行 + 班次信息
 *   · `planQty`／`startedQty`／`notStartedQty` —— **单位＝测试任务（件）**（`FR-4.x` 同一单位，C-111）：
 *     `planQty` ＝ Σ`orders[].planQty`（FR-4.1）；`startedQty` ＝ `startedPieces`（FR-4.2，件数）；
 *     `notStartedQty` ＝ `max(0, planQty − startedPieces)`（FR-4.3）。
 *   · `orderTotal` ＝ 参与核算的**当班派工票数**（`orders.length`）—— **唯一保留的票级量**，故**不要**
 *     与上面三项直接相减（那是 `E69` 的病灶：票数减件数）；原名 `taskTotal`，`E65` 时改名。
 *   · `doneQty`／`passQty`／`failQty`／`retestQty`／`runningQty`／`waitingQty`／`avgTestSec` —— **件级**（来自 `pieces`）
 *   · 除零行为（**实测**，见 `tests\._verify\zz6b-stats-probe.js` 的空库现场④）：
 *     `planQty = 0` ⇒ `capacityRate = 0`；`doneQty = 0` ⇒ `firstPassRate = 0`、`avgTestSec = 0`；
 *     `elapsedSec = 0` ⇒ `oee = 0`。全部由 `pct()`/`safeDiv()`（分母 ≤ 0 返回 0）与显式
 *     `done > 0 ? … : 0` 保证，**任何一项都不会是 `NaN`／`Infinity`**。
 */
function computeShiftStats(input) {
  const shift = input.shift;
  const orders = input.orders || [];
  const pieces = input.pieces || [];
  const measures = input.measures || [];
  const cycleSec = (input.cycle && input.cycle.sec) || 160;
  const now = toDate(input.now);

  /* ---------------- 一、票级计数（FR-4.1～4.3、4.6） ----------------
     `orders` 是**票**（派工票），`pieces` 是**件**（测试件）；两者粒度不同，
     故下面两组计数分别只从各自入参取数，**互不代偿**（`E65` 的硬约束）。 */
  const orderTotal = orders.length;
  const planQty = input.planQty === undefined
    ? orders.reduce((s, o) => s + (o && Number.isFinite(Number(o.planQty)) ? Math.max(0, Number(o.planQty)) : 0), 0)
    : Math.max(0, Number(input.planQty) || 0);
  /* 已开工 ＝ **当班已开始测试的测试任务（件）数**（FR-4.2 / C-111：件以 `unit_index` 区分，
     判定依据＝该件在 `measure_rt` 有采样数据；取数在 `stateSnapshot.statsOf()`）。
     ⚠ `E69`（负责人 2026-09-30 裁定③）：上一版这里是 `orders.filter(o => o.started).length`
        —— 数的是**派工票数**，而 `planQty` 是**测试任务数** ⇒ FR-4.3 的减数与被减数**单位不同**
        （实测 30 件 / 3 票 / 未开工 27）。故入参改为显式的件数 `startedPieces`、**算式一字未动**
        （下面仍是 `max(0, 计划 − 开工)`）。缺省/非有限值按 0（当班没有已开工的件，绝不产生 NaN）。
     ⚠ 与更早一版 `Math.min(…, planQty)` 的差别（如实登记，非顺手改口径）：这里**不按计划数封顶** ——
       开工件是可观测事实，封顶会把"开工多于计划"这类真实现象藏起来；未开工仍按 FR-4.3 的
       `max(0, 计划 − 开工)` 收口，故永不为负。 */
  const startedPieces = Number.isFinite(Number(input.startedPieces))
    ? Math.max(0, Number(input.startedPieces)) : 0;
  const notStarted = Math.max(0, planQty - startedPieces);   // FR-4.3

  /* ---------------- 二、件级计数（FR-4.4～4.10） ---------------- */
  const running = count(pieces, STATUS.RUNNING);
  const waiting = count(pieces, STATUS.WAITING);
  const retest = count(pieces, STATUS.RETEST);
  const pass = count(pieces, STATUS.PASS);
  const fail = count(pieces, STATUS.FAIL);
  const done = pass + fail;                                  // FR-4.4 已完成 = 合格+不合格
  /* FR-4.13 的分子：当班**已完成件**（`DONE_STATUS` ＝ 合格＋不合格）的件级测试时长之和 ——
     与分母 `doneQty` **同一集合**。依据＝需求 `FR-4.13`「**完成**测试总时长 ÷ 完成数量」；
     `result.duration_sec` 是每件首末有效帧之差（DR-05）。
     ⚠ `E67`（负责人 2026-09-30 裁定②）**限集合**，两版差别如实登记：
        · 上一版（`E65` 偏差①）分子＝**窗口内全部件**之和（含 `待复检`／`测试中`／`待测试`），
          而分母只数合格＋不合格 ⇒ 分子集合比分母大。实测 4 件（合格 10／合格 20／不合格 30／
          **待复检 40**）得 `avgTestSec = 33`（Σ100 ÷ 3），按需求字面应为 **20**（Σ60 ÷ 3，差 65%）。
        · 现只累加 `DONE_STATUS.includes(p.result)` 的件 ⇒ 未完成件**不计**：`待复检` 尚未"完成测试"
          （`FR-5.12` 复检闭环未结，它只进 `retestQty`），`测试中`／`待测试` 更没有"完成时长"可言 ——
          把它们算进"完成测试总时长"是**编造分子**。
        · 缺 `durationSec`／非有限值仍按 0 计（与 `avgTestSec` 的除零口径一致，绝不产生 NaN）。 */
  const testSecSum = pieces.reduce(
    (s, p) => s + (p && DONE_STATUS.includes(p.result) && Number.isFinite(Number(p.durationSec))
      ? Math.max(0, Number(p.durationSec)) : 0), 0);

  /* ---------------- 三、时长（有效运行 / 待机） ----------------
     口径：**当班有没有采样帧**决定设备是否在跑 —— 有采集串即按"已收到几秒数据"截断记有效运行；
     无采集串时沿用旧兜底：有「测试中」件才按班次进度计，否则 0。
     采集时刻串按 1 s 采样（DR-05／实采），故"条数 − 1"＝已收到数据的秒数，避免把断连后的
     时段算成运行。
     ⚠ `E65` 的边界修正（**只改输入形状带来的连带**，逐条登记）：上一版判据写作
       `running > 0 ? byMeasures : 0`，其中 `running` 来自**件级**结果（`pieces` 的「测试中」）。
       入参分离后，若调用方只喂票级数据（或件级里没有「测试中」行），`running` 恒 0 ⇒ `runSec` 恒 0 ⇒
       `addRunSec` 的上界校验（`addRunSec ≤ runSec`）会对**任何非零增量**抛错，把"读数噪声"升级成
       **异常**（`tests\logic-check.js:395` 与 `tests\contract-check.js:1117` 两个现场实测如此）。
       故判据改为按"**当班有没有采样帧**"取有效运行（`measures` 正是那一列的载荷）。
       ⚠ `E65` 自述的"三者组合下**观测等价**"**不成立**（座位 5 的 C·8.4 争议③ 已实测）：旧写法在
       "有采集串且无在测件"时得 0，与下面 `E68` 的新读数不同 —— 该句作废，按 `E68` 重述于下。
     ⚠ `E68`（负责人 2026-09-30 裁定①）**去掉"帧太少就信整班"的特例**：上一版写作
       `measures.length > 2 ? Math.min(elapsedSec, measures.length - 1) : elapsedSec` —— 1／2 帧
       **直接取整班 `elapsedSec`**。后果（实测）：默认路径（有帧、`result` 表尚空 ⇒ 无在测件）下
       `runSec` 0 → 整班 ⇒ `oee` **0% → 100%**、`idleSec` 整班 → 0；而 3 帧只得 2 s（`oee ≈ 0%`）
       ⇒ **判据按帧数不连续跳变**，且"1 帧＝整班在跑"是**从不足的证据编造正向结论**。
     现口径（**无条件截断**）：`byMeasures = min(elapsedSec, max(0, measures.length − 1))`，
     后果逐条写明：**1 帧 ⇒ 0 s、2 帧 ⇒ 1 s、n 帧 ⇒ (n−1) s**；按 1 s 采样（本仓实采口径）
     ⇒ n ≈ elapsedSec + 1 ⇒ **≈整班**（"整班"是采样跑满了才得出的读数，不是 1 个样本的推断）。
     **不再从 1～2 个样本声称设备跑了整班** —— 与 `judge.js` 的"拿不到不说"同一精神。
     旧分支保留（`E68` **未动**）：**无采集串但确有「测试中」件 ⇒ 按整班 `elapsedSec` 计**
     （件级在测本身就是"在跑"的独立证据，不依赖采样条数）。 */
  const elapsedSec = shift.elapsedSec;
  const byMeasures = Math.min(elapsedSec, Math.max(0, measures.length - 1));
  const runSec = measures.length > 0 ? byMeasures : (running > 0 ? elapsedSec : 0);
  const idleSec = Math.max(0, elapsedSec - runSec);

  /* ---------------- 四、派生指标（公式即本段代码，分母为 0 一律返回 0） ----------------
     ⚠ 权威性说明（ADR-0005 选项 B，2026-09-20 拍板）：本段是 FR-4 统计口径的**唯一执行点之一**——
       服务端**权威实现**（仅此一处）；另一处是前端演示实现 `src/services/mockData.js` 的 stats 段。
       此前注释写"公式走配置"**不成立**：`src/config/board.config.js` 的 production.formula
       当时**没有任何读取点**（死配置），Q-11 答复到达后"只改配置"不会改变任何统计结果。
       口径变化时需同步的位置：本段四条算式 / `src/services/mockData.js` 的 stats 段 /
       `tests/logic-check.js` 的期望值 / `tests/contract-check.js` 的占位断言（跨实现一致性见其 M 段）。
       本段为纯函数，**不得在注释以外改动算法**。 */
  /* FR-4.10 一次性合格率：**现状口径 ＝ 合格数 ÷ 已完成数**（≤ 完成数，非"首次判定"口径）。
     技术债 `E63`（复检改判被 `repo/result.js` 的"终态不回退"吞掉）一旦落地，"首次合格数"才有
     独立取值；届时**只改这里的分子**、并把本注释同步改成"首次合格数"。本次**不实现"首次判定"**。 */
  const firstPassRate = pct(pass, done);
  const capacityRate = pct(done, planQty);                     // FR-4.14 产能达成率
  const oee = pct(runSec, elapsedSec);                         // FR-4.15 稼动率
  const avgTestSec = done > 0 ? Math.round(testSecSum / done) : 0; // FR-4.13 单台平均测试时长

  /* ---------------- 五、累计运行（DR-17：单调不减、跨班次不清零） ---------------- */
  /* DR-17 累计运行：`addRunSec` 是"**自上次核算以来**的新增运行时长"（增量），
     而 rollAccum 在同一天是 `daySec + add` —— 两者必须同为增量口径。
     旧实现缺省取 `runSec`（班次**累计**已运行时长），调用方一旦把上次落库的 accum 传回来，
     同日就会把"累计值当增量"重复相加，累计运行虚高（复审 P2-4 复现）。
     故缺省改为 0，并对越界值直接报错而不是悄悄算错。 */
  const rawAdd = input.addRunSec;
  const addRunSec = rawAdd === undefined ? 0 : Number(rawAdd);
  if (!Number.isFinite(addRunSec) || addRunSec < 0 || addRunSec > runSec) {
    throw new RangeError(
      `computeShiftStats: addRunSec 必须是 0～${runSec}（本周期增量）的有限数，收到 ${JSON.stringify(rawAdd)}`);
  }
  const accum = accumulateRunTime(input.accum, addRunSec, now);

  return {
    shift: {
      name: shift.name, date: shift.date, startAt: shift.startAt, endAt: shift.endAt,
      elapsedSec, totalSec: shift.totalSec
    },
    /* FR-4.1～4.9（单位均为「测试任务／件」，见文件头与 C-111） */
    planQty, startedQty: startedPieces, notStartedQty: notStarted, doneQty: done,
    runningQty: running, waitingQty: waiting, passQty: pass, failQty: fail, retestQty: retest,
    /* FR-4.10～4.15 */
    firstPassRate, runSec, idleSec, avgTestSec, capacityRate, oee,
    /* DR-17 */
    accumulate: accum,
    /* 核对用 */
    orderTotal,
    cycleSec
  };
}

/** 计数小工具（**件级**：入参是 `pieces`，每项一个 FR-3.13 结果态） */
function count(pieces, status) {
  return pieces.filter(p => p && p.result === status).length;
}

/**
 * 累计运行核算（DR-17）：**按自然日/月/年推进，跨班次一律不清零**。
 * 语义：
 *   · 未跨日 → 原样保留（daySec 只增不减）
 *   · 跨日但未跨月 → 日累计归零并把"上一日的日累计"滚入月/年（这样月/年**单调不减**）
 *   · 跨月 → 月累计归零（上年累计继续累积）
 *   · 跨年 → 年累计归零
 * `prev.at` 缺失（首次入库）时，**原样保留传入的累计值** —— 绝不把它们抹成 0，
 * 否则重启后累计运行会倒退（正是本轮要防的缺陷）。
 */
function rollAccum(prev, now) {
  const base = {
    daySec: prev && Number.isFinite(prev.daySec) ? prev.daySec : 0,
    monthSec: prev && Number.isFinite(prev.monthSec) ? prev.monthSec : 0,
    yearSec: prev && Number.isFinite(prev.yearSec) ? prev.yearSec : 0,
    at: prev && prev.at ? toDate(prev.at) : null
  };
  if (!base.at) return { ...base, at: now, reset: { day: false, month: false, year: false } };

  const dayChanged = startOfDay(now).getTime() > startOfDay(base.at).getTime();
  const monthChanged = startOfMonth(now).getTime() > startOfMonth(base.at).getTime();
  const yearChanged = startOfYear(now).getTime() > startOfYear(base.at).getTime();
  const rolledIn = dayChanged ? base.daySec : 0;   // 上一日的日累计滚入更大周期

  return {
    daySec: dayChanged ? 0 : base.daySec,
    monthSec: monthChanged ? 0 : base.monthSec + rolledIn,
    yearSec: yearChanged ? 0 : base.yearSec + rolledIn,
    at: now,
    reset: { day: dayChanged, month: monthChanged, year: yearChanged }
  };
}

/**
 * 把本周期新增的运行秒数并入累计值。
 * @param {{daySec:number, monthSec:number, yearSec:number, at:string|Date}} prev 上次落库值（DR-17 持久化）
 * @param {number} addSec 本周期新增（通常为该班次的有效运行秒数）
 * @param {string|Date} now
 */
function accumulateRunTime(prev, addSec, now) {
  const rolled = rollAccum(prev, toDate(now));
  const add = Math.max(0, Number(addSec) || 0);
  return {
    daySec: Math.max(0, rolled.daySec + add),
    monthSec: Math.max(0, rolled.monthSec + add),
    yearSec: Math.max(0, rolled.yearSec + add),
    at: rolled.at,
    reset: rolled.reset
  };
}

module.exports = {
  STATUS,
  DONE_STATUS,
  computeShiftStats,
  accumulateRunTime,
  safeDiv,
  pct
};
