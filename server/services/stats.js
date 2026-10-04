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

const { startOfDay, startOfMonth, startOfYear, toDate, fmtDate } = require('../../platform/clock');

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
 *       边界（ADR-0009 D3，负责人 2026-10-02 **授权重设**）：必须是
 *       **0 ≤ addRunSec ≤ `elapsedSec`（班次已进行时长）** 的有限数，越界即抛错。
 *       依据与"为什么不是 `runSec`"逐条写在下方「五、累计运行」段 —— 旧上界会让
 *       "无采集串且无「测试中」件"时**任何非零增量都被拒收**（`E59` 接线即爆）。
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
       ⚠ **该上界已按 ADR-0009 D3（2026-10-02 负责人授权重设）改为 `≤ elapsedSec`** ——
       见下方「五、累计运行」段；此处保留的只是"为什么 `runSec` 会恒 0"这一**历史成因**，不是现行判据。
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

  /* ---------------- 五、累计运行（DR-17：单调不减、跨班次不清零） ----------------
     DR-17 累计运行：`addRunSec` 是"**自上次核算以来**的新增运行时长"（增量），
     而 rollAccum 在同一天是 `daySec + add` —— 两者必须同为增量口径。
     旧实现缺省取 `runSec`（班次**累计**已运行时长），调用方一旦把上次落库的 accum 传回来，
     同日就会把"累计值当增量"重复相加，累计运行虚高（复审 P2-4 复现）。
     故缺省改为 0，并对越界值直接报错而不是悄悄算错。

     ---- `addRunSec` 上界：**重设**为 `elapsedSec`（班次已进行时长）—— ADR-0009 D3（2026-10-02 负责人
     **授权重设**），依据三条（**不是**"放宽成不校验"）：
       ① **物理上界**：`addRunSec` 是"本周期新增的**有效运行**时长"，而有效运行只可能落在**已经过去的
          时间**里 —— 本文件「三、时长」段自己就是这么取的：有采集串时 `byMeasures = min(elapsedSec, …)`、
          无采集串但有在测件时直接取 `elapsedSec`。故 `runSec ≤ elapsedSec` 是既有事实，
          `elapsedSec` 才是那个"任何合法增量都不可能越过"的界。
       ② **旧上界 `≤ runSec` 是"读数形态"冒充物理界**：`runSec` 由**入参形态**决定
          （无采集串且无「测试中」件 ⇒ `runSec` 恒 0 —— `E68` 把分档由 3 档收窄为 2 档后连 n=1 都取 0）
          ⇒ 与 `shift_stat` 一旦接线（增量来自**上一班已固化的 `run_sec`**，与本拍有没有帧无关），
          任何非零增量都会被判越界（`E59`／ADR-0009 D3② 明写此耦合必爆）。
       ③ **越界仍是真错**：`addRunSec > elapsedSec` 只可能来自口径错位 —— 把累计值当增量、
          秒与毫秒混淆（8 h 写成 28 800 000）、把别的周期算进来。一个班次里**跑不出**比班次已进行
          时长更长的有效运行 ⇒ 拒收而不是收下算错。
     **可证伪**（读数见 `tests\._verify\seat3-a1-probe.js` 第三节，三条一起给）：
       · 同一组"无采集串 ＋ 无在测件"输入（`elapsedSec = 25200`）：`addRunSec = 3600`
         ⇒ 旧形态（`> runSec`）**抛 RangeError**／新形态**通过**；
       · `addRunSec = elapsedSec + 1` ⇒ 新形态**仍抛 RangeError**（界不是空的）；
       · 定点变异（把界的表达式换成 `Number.MAX_SAFE_INTEGER`）⇒ 上面那条**由红转绿**
         ⇒ 该断言真的在测"界"，不是在测"恒真"。
     ⚠ 保持"必须是有限数且非负"（`0` 合法：本周期确实没有新增运行）。 */
  const rawAdd = input.addRunSec;
  const addRunSec = rawAdd === undefined ? 0 : Number(rawAdd);
  /* 上界＝班次已进行时长（依据见上：有效运行不可能超过已经过去的时间） */
  const addRunSecMax = elapsedSec;
  if (!Number.isFinite(addRunSec) || addRunSec < 0 || addRunSec > addRunSecMax) {
    throw new RangeError(
      `computeShiftStats: addRunSec 必须是 0～${addRunSecMax}（本周期增量；上界＝班次已进行时长 ` +
      `elapsedSec，ADR-0009 D3）的有限数，收到 ${JSON.stringify(rawAdd)}`);
  }
  const liveSplit = splitRunSecondsByDay(shift, runSec);
  /* 第 4 个入参＝`E83` 的自然日切段（含两段各自的**日历归属** `day1Date`/`day2Date`）：
     日档按段归 D／D+1（`E83`），月/年档按段归各自的自然月/年（`E132` —— 段属于哪个周期由
     **段的日期**决定，不由读它的时刻决定；见 `accumulateRunTime()` 的 docblock）。
     ⚠ `E139`：`liveSplit` 可能带 `degraded: true`（入参不是 `createShiftRules().at()` 的完整形态）。
     本函数**原样带上**（下面的 `runSecSplit` 整体返回）—— 于是"这次切段可不可信"随读数一起交给
     读方，而不是被这一层吃掉；`accumulateRunTime()` 只在 `crossing === true` 时按日历归属入档 ⇒
     降级时它走"整段算当日"，与 `E83` 之前的读数**逐字相同**（**仍不抛错**：理由见
     `splitRunSecondsByDay()` 的 `E139` 段 —— 切段是派生增强，不该让旧调用方爆掉）。 */
  const accum = accumulateRunTime(input.accum, addRunSec, now, liveSplit);

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
    /* `E83` 的**自然日投影**（FR-6.4／6.5／6.6 的当日/本月/年度累计运行；由本文件按零点切段）：
       `runSecDay1` ＝ 本班运行秒数里落在**班次开始那一自然日**的部分、`runSecDay2` ＝ 落在**次日**的部分。
       ⚠ 不跨自然日的班次恒为 `{runSecDay1: runSec, runSecDay2: 0}`；两者**恒有** `day1 + day2 === runSec`
         （不许丢秒、不许重复计）。取数落盘与读口见 `repo/shiftStat.js` 的 `run_sec_day1/run_sec_day2`。 */
    runSecDay1: liveSplit.day1,
    runSecDay2: liveSplit.day2,
    /* 切段结果**整体**也带上（含 `crossing` 与两段的日历归属 `day1Date`/`day2Date`）：
       调用方（`stateSnapshot.statsOf()`）要把当班增量按段分配时必须拿到"是否跨零点"——
       只搬运 day1/day2 两个数就会把这一位丢掉（`accumulateRunTime()` 于是走"整段算当日"）。 */
    runSecSplit: liveSplit,
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
 * `E139` 的**入参形态判据**（纯函数、只读）：返回"缺失/非法字段"的名字数组
 * （**空数组＝影响"判定或归属"的字段齐**；⚠ 这**不**等价于"是 `at()` 的完整形态"，见下 `totalSec`）。
 *
 * 为什么要有这道判据（而不是"能算就算"）：`E139`（2026-10-04 登记、主代理亲验）的病灶是
 * `splitRunSecondsByDay()` 对**手工构造的半个 shift 对象**（如 `{name:'夜班',start:22,end:6}`）
 * **静默**退化为"不切段" —— 调用方会把"看不懂"当成一个合法取值（"这段不跨零点"），于是跨零点
 * 那一班按旧口径整段归开始日（**正是 `E132` 的病理形态**），而没有任何地方提示"是入参不全"。
 * 同族先例的处置一律是**把"看不懂"标出来**：`E38`（"没算过"显示成 0）、`E129`（截断不报）、
 * `E131`（`'false'` 静默开闸）。
 *
 * 字段清单＝**只含"影响跨零点判定或日历归属"的字段**（2026-10-04 裁定收窄，理由见下 `totalSec`）：
 *   · `start`／`end`   —— 判"是否跨零点"的既有判据（正文用 `Number(end) <= Number(start)`）。
 *     `at()` 给的是**整数**（`shift.js:175-193` 先 `Number()` 归一、再 `Number.isInteger` 校验），
 *     故这里用**严格数**判据：`null`／`''`／数字字符串一律算形态不全 —— `Number(null) === 0`、
 *     `Number('') === 0` 这类隐式强转会**把"打错字"当成合法取值**，正是 `E139` 要消灭的东西；
 *   · `startAt`／`endAt`—— 跨零点时"零点那一刀"要用的两个时刻。判据是"**能不能解析成时刻**"
 *     （不限定字符串类型：`toDate()` 也吃 `Date`／时间戳），故 `'x'`／`undefined` ⇒ 形态不全；
 *   · `date`           —— 前段的日历归属（`day1Date`）。要求 `yyyy-MM-dd`：`accumulateRunTime()`
 *     拿到它后会拼 `${date}T00:00:00`，而**拼不动/拼歪了**正是当日累计错位（`E83`）的来源；
 *   ⚠ `totalSec` **不在** fault 列表里（**主代理 2026-10-04 更正了自己上一票的口径**）：它**不参与**
 *     本函数任何运算、也**不影响"能不能判跨零点/能不能定归属"**，而 `degraded` 的语义只是"**这次没能
 *     判跨零点**"⇒ 缺它而置 `degraded` 是 **cry wolf**（数值与完整形态**逐值相同**却喊降级）⇒ 缺
 *     `totalSec` ⇒ **`degraded` 缺席**、数值与完整形态逐值相同（它缺不缺，与本函数要报的"判定不成立"无关）。
 *   ⚠ **不**列入：`name`（与本函数无关，缺了不影响任何取值）、`elapsedSec`（本函数 docblock
 *     明写它**可缺**、缺了退化为整班跨度 `span` —— 那是**有意的**向后兼容，不是"看不懂"）。
 * @param {object} shift `createShiftRules().at()` 的产物（或手工构造的同形对象）
 * @returns {string[]} 缺失/非法字段名（`['shift']` ＝ 连对象都不是：`null`／`undefined`／非对象）
 */
function shiftShapeFaults(shift) {
  if (!shift || typeof shift !== 'object') return ['shift'];
  const faults = [];
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isTime = (v) => {
    try {
      const d = toDate(v);
      return !!d && Number.isFinite(d.getTime());
    } catch { return false; }
  };
  if (!isNum(shift.start)) faults.push('start');
  if (!isNum(shift.end)) faults.push('end');
  if (!isTime(shift.startAt)) faults.push('startAt');
  if (!isTime(shift.endAt)) faults.push('endAt');
  if (typeof shift.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(shift.date)) faults.push('date');
  return faults;
}

/**
 * `E139` 的降级说明：一句话说清"**缺什么**"＋"**后果是什么**"（与 `degradedMissing` 的字段名数组
 * 一并给出，前者给人读、后者给机器核）。`facts` 是三个**已判明的事实位**（由调用处算好，
 * 不在这里重算 —— 同一份判据只留一处）：
 *   · `cut`            —— 真的按零点切了段（跨零点那一支）；此时缺的只是形态的其余部分，
 *     后果是"**切段不予背书**"（如缺 `date` ⇒ `day1Date` 为 `undefined`），**不是**"数值算错了"；
 *   · `startEndNumeric`—— `start`/`end` 是**有限数**（能判"是否跨零点"）；
 *   · `cfgCrossing`    —— `Number(end) <= Number(start)`（**配置层面**说这个班跨零点）。
 * ⚠ 三种情形必须**分开说**（否则就是拿"形态不全"冒充"判定无效"，与 `E139` 的病灶同型）：
 *   ① `cut` ⇒ 切了段、但不背书；
 *   ② `startEndNumeric && !cfgCrossing` ⇒ "**本次不跨零点**"这一判定**本身有效**（形态不全 ⇒
 *      仍标 `degraded` 但不冒领"算错了"）；
 *   ③ 其余（`start`/`end` 不是数，**或**判据说跨零点而两个时刻不可用）⇒ **真的判不了/切不了** ⇒
 *      这才是 docblock 那句"**`crossing:false` 不代表"确实不跨零点"**"的适用面。
 *      ⚠ 情形③的**后半**正是 `E139` 的原始踩法（`{name:'夜班',start:22,end:6}`：配置明写跨零点、
 *      只是没有两个时刻）—— 把它归到"判定有效"会是**假话**（实测：本探针第一版就这样误报过）。
 */
function degradedSplitReason(faults, facts) {
  const has = (f) => faults.indexOf(f) >= 0;
  /* ⚠ 本函数的输入只有 `faults`（＝"影响判定/归属"的字段名）与三个事实位 ⇒ 理由串只谈这些：
     `totalSec` 已移出 fault 列表（口径收窄）⇒ 这里**不再有**"缺 `totalSec` 不影响数值"那句（它不可能出现）。 */
  const head = `班次入参**缺/非法**了影响"跨零点判定或日历归属"的字段（${faults.join('、')}）—— `;
  if (facts.cut) {
    return head + '两段的时刻在场、已按零点切了段，但**入参形态不予背书**' +
      (has('date') ? '（缺/非法 `date` ⇒ `day1Date` 为 `undefined`，两段的日历归属不可核）' : '') +
      '；读方不得把它当成"已核实的切段"。';
  }
  if (facts.startEndNumeric && !facts.cfgCrossing) {
    return head + '`start`/`end` 在场且**判据说本次不跨零点** ⇒ 这一判定**有效**（`crossing: false` 可信），' +
      '但入参不是契约形态 ⇒ 本函数对形态**不予背书**' +
      (has('date') ? '（缺/非法 `date` ⇒ 两段的日历归属为 `null`）' : '') + '。';
  }
  return head + (facts.startEndNumeric
    ? '`start`/`end` 在场且**判据说它跨零点**，但 `startAt`/`endAt` 缺失或不可解析 ⇒ **切不了段**'
    : '`start`/`end` 不是数 ⇒ 连"是否跨零点"都**判不了**') +
    ' ⇒ 本次返回的是"整段归班次开始日"的**兜底形态**：`crossing: false` **不代表"确实不跨零点"**' +
    '（真跨零点的班次会被整段归进开始日，正是 `E132` 的病理形态）。';
}

/**
 * `E139`：把降级标记挂到切段结果上（**只加键、不动既有五个键的名字与顺序**）。
 * 形态完整（`faults` 为空）时**原样返回** —— 连一个多余的键都不加：这是"正常路径绝不带
 * `degraded`"与"无跨零点配置逐字不变"两条保证的落点。
 */
function markSplitDegraded(out, faults, facts) {
  if (faults.length === 0) return out;
  out.degraded = true;
  out.degradedReason = degradedSplitReason(faults, facts);
  out.degradedMissing = faults.slice();
  return out;
}

/**
 * `E83` 甲·㈡ **自然日投影**：把"一个班次的运行秒数"按**零点**切成两段。
 *
 *   · **前段（`day1`）＝落在**班次开始那一自然日**（`shift.date`）的运行秒数 ⇒ 归 D；
 *   · **后段（`day2`）＝落在**次日**（D+1）的运行秒数 ⇒ 归 D+1；
 *   · **恒有 `day1 + day2 === runSec`**（不许丢秒、不许重复计）—— 这是本函数唯一的硬约束，
 *     也是验收判据"日/月/年三档的切段之和 ＝ 总运行秒数"的落点。
 *   ⚠ **"日/月/年各自按日历归属聚合"（`E132`，2026-10-04 修正）**：本函数只负责**切日**
 *     （D 与 D+1）；月/年档由读方再按**同一份日历归属**聚合 —— `accumulateRunTime()` 用
 *     `day1Date`/`day2Date` 把自己的加数分派到各自的自然月/年（月末/年末那一班会**同时**跨月/跨年，
 *     两段**不**同月同年，上一版"两段都落在同月/年"的断言是假的 ⇒ 上一周期那段会永久丢失）；
 *     `repo/shiftStat.js` 的 `segmentsOf()`/`projectRows()` 对**已固化**的行做同一件事。
 *     即：**"哪个周期"永远由段的日期决定，不由读它的时刻决定**。
 *
 * **两种口径在此分流（负责人 2026-10-04 裁定，不得混为一谈）**：
 *   · **班次投影**＝整班归"班次开始的那一天"（`DR-06` 逐字／`FR-4.16`）—— 那是 `shift.date`
 *     与 `shift_stat.shift_date` 的既有口径，**本函数不动它**（`repo/shiftStat.js` 的 `run_sec`）；
 *   · **自然日投影**＝本函数（`FR-6.4/6.5/6.6` 的"当日/本月/年度累计运行"按**自然日**零点归零）。
 *   两者**天然解耦**：一个按班次边界切、一个按自然日切，各自成立（不是需求冲突，是两件事）。
 *
 * 为什么**不**直接把 `measures` 按两段各自套一遍"条数 − 1"规则：那条规则（`E68`，见上文
 * 「三、时长」段）是**在整班窗口上**定义 `runSec` 的算子，它对"稀疏/有缺口的采样"**不满足可加性**
 * —— 两段各自 `min(elapsed_i, count_i − 1)` 相加**可能大于**整班 `min(elapsed, count − 1)`
 * （实测构造：`[22:30, 23:30]` 与 `[01:00…06:00]` 六个点 ⇒ 分段和 1 ＋ 5 ＝ 6 s，而整班规则给 6 s
 * 只在 count 恰好填满时相等；缺口一到就两边不等，甚至比整班多算）。**先切再套规则**于是会
 * 凭空造出秒数 ⇒ 直接违反"不丢秒、不重复计"。故本函数以**整班 `runSec` 为总额**、
 * 按**子窗口时长占比**分配（前段上限＝前段时长，余下全归后段）：
 *   · 采样密集（`count ≈ elapsed + 1`，实采 1 s 口径）⇒ 与"先切再套规则"**逐秒相同**；
 *   · 采样稀疏/有缺口 ⇒ 退化为"按已进行时长占比分摊整班总额"—— 这是**保守且可解释**的分配，
 *     且**恒定保住总额**（唯一不能破的那条）。
 *
 * **无跨零点配置时逐字不变（最重要的回归面）**：`shift.end <= shift.start` 为假（现配置
 * 0-8/8-16/16-24 全部如此）⇒ 直接返回 `{day1: runSec, day2: 0}` —— 不查半点、不做除法，
 * 与改动前 `accumulateRunTime(prev, addSec, now)` 的行为**逐字相同**。
 * 为什么要把它写成硬保证而不是"碰巧":自然日投影是新口径，旧口径是**在产**的读数
 * （`/health.runAccum`、`GET /state` 的 `stats.accumulate`、`logic-check`／`db-check` 的既有期望值
 * 都建立在它上面）；一旦现配置下两个投影不同值，说明改动**改变了在产行为**，
 * 那是回归、不是新功能。故 `tests\._verify\e83-*.js` 对现配置做"改前 vs 改后"逐字比对。
 *
 * @param {{start:number, end:number, startAt:string, endAt:string, date:string, totalSec:number,
 *          elapsedSec?:number, name?:string}} shift 班次（真源＝`services/shift.js` 的 `at()`：
 *        `start`/`end` 判是否跨零点、`startAt`/`endAt` 是零点那一刀的两个时刻、`date` 是前段的
 *        日历归属、`totalSec` 是整班跨度（**不参与**本函数运算、也**不在** fault 判据里）；`elapsedSec`
 *        是**已进行时长**且**可缺** —— 缺了退化为整班跨度 `span`，那是有意的向后兼容（见 `shiftShapeFaults()`）
 * @param {number} runSec 整班有效运行秒数（`computeShiftStats()` 里那个 `runSec`）
 * @returns {{day1:number, day2:number, crossing:boolean, day1Date:string|null, day2Date:string|null,
 *            degraded?:true, degradedReason?:string, degradedMissing?:string[]}}
 *   两段秒数（非负整数；恒有 `day1 + day2 === runSec`）＋ `crossing`（这一次增量是否跨了自然日，
 *   `accumulateRunTime()` 据此决定要不要按日历归属入日档）＋ 两段各自的日历归属（`yyyy-MM-dd`）。
 *
 *   ⚠⚠ **`E139`（2026-10-04）：判定不成立时必须**能看出来** —— `degraded` 的语义（**逐字**如下）**：
 *     · **`degraded` 是真＝这次没能判跨零点（不是"确实不跨"）**：入参**缺/非法**了"影响判定或归属"
 *       的字段（`start`/`end`/`startAt`/`endAt`/`date`）⇒ 返回的 `crossing: false` 只是"整段归
 *       班次开始日"的**兜底形态**；`degradedReason` 写明"缺哪个字段／为什么判不了"、
 *       `degradedMissing` 是**字段名数组**（机器可核、稳定顺序）。⚠ 判据**不收**"不影响判定/归属"
 *       的字段（`totalSec`；口径收窄见 `shiftShapeFaults()`）：它既不参与运算、也不妨碍判跨零点/定归属，
 *       把它算作 fault 只会得到"数值与完整形态逐值相同却喊降级"的 **cry wolf**。
 *       `degradedReason` 仍**区分三种情形**、**不冒领**"算错了"：`start`/`end` 不在场＝**真的判不了**；
 *       判据说跨零点而两个时刻不在场/不可解析＝**切不了段**（这才是"`crossing:false` 不代表确实不跨"
 *       的适用面）；在场且判据说本次不跨零点＝这一判定**本身有效**，只是形态**不予背书**。
 *     · **`degraded` 缺席或为 `false` ⇒ 判定有效**（**向后兼容**的定义）：老调用方**完全不看**
 *       这个键，行为与 `E139` 之前**逐字相同** —— 标记是**加**在返回体上的第六～八个键，
 *       既有五个键的名字、顺序、取值一个都没动；⇒ **不看它不会更糟，看它才拿得到新信息**。
 *     · **正常路径（`createShiftRules().at()` 的完整对象）绝不带 `degraded`**：完整形态下
 *       连这个键都**不存在**（缺 `totalSec`、但判定/归属字段齐的入参同样不带 —— 见 `shiftShapeFaults()`；
 *       这是"无跨零点配置逐字不变"那条硬保证的一部分，`E83`／`E132` 的既有断言都建立在那五个键上）。
 *   ⚠ **为什么不抛错**（这条取舍在本函数里**先于** `E139` 就写明了，本次**不推翻**它）：
 *     见正文"判不了…也走这一支…**不抛错**，因为切段是**派生的增强**、不该让旧调用方爆掉"。
 *     抛错会打断它要保护的那批调用方（不传 `startAt`/`endAt` 的旧形态）；而 `degraded` **既不打断**、
 *     又让"我看不懂"变成**可读事实** —— 这正是 `E38`（"没算过"显示成 0）／`E129`（截断不报）／
 *     `E131`（`'false'` 静默开闸）同族缺陷的一贯处置：把"看不懂"标出来，而不是当成正常读数。
 *     命名沿用本仓既有的降级标记先例：`services/dispatch.js` 的 `auth.degraded`（＋ `warning`）。
 */
function splitRunSecondsByDay(shift, runSec) {
  const total = Math.max(0, Math.round(Number(runSec) || 0));
  /* 不跨自然日（含现配置的三段班与 `end = 24` 的 16→24）：整段归班次开始那天，**逐字不变**。
     判不了（`shift.end` 不是数 / `startAt`·`endAt` 缺失或不可解析）也走这一支 —— 退化为
     "整段归当日"，与改动前逐字同值；**不抛错**，因为切段是派生的增强、不该让旧调用方爆掉。
     ⚠ `E139`（2026-10-04）**只把"判不了"从无信号改成有信号**，**不改这条取舍**：上面那句
     "不抛错"是**有意**的向后兼容（`C·22` 靶子⑧ 复核确认），故本次的修法是"标注"而不是
     "改成抛错" —— 抛错会打断它要保护的那批旧调用方，而标注既不打断、又让"我看不懂"可读
     （`markSplitDegraded()`／`degradedSplitReason()`；语义与理由见本函数 docblock 的 `E139` 段）。 */
  const bounds = (() => {
    try {
      const s = toDate(shift && shift.startAt);
      const e = toDate(shift && shift.endAt);
      return (s && e && Number.isFinite(s.getTime()) && Number.isFinite(e.getTime())) ? { s, e } : null;
    } catch { return null; }
  })();
  /* `E139` 的形态判据（**与上面那支判断无关**、只读、不参与任何算式）：fault 只含**影响判定或归属**
     的字段 ⇒ 完整形态（`start`/`end`/`startAt`/`endAt`/`date` 全在场）⇒ 空数组。放在这里只算一次，
     两条出口都用它 —— 两个出口都可能拿到不完整入参：
     ① 整段归当日那一支（判不了跨零点，或本来就非跨零点）；
     ② 真跨零点那一支（时刻在场但 `date` 缺 ⇒ 例如 `day1Date` 会是 `undefined`）。
     ⚠ 下面两个事实位是给 `degradedSplitReason()` 用的（**不参与任何算式**）：`start`/`end`
     是不是有限数、以及**配置层面**说不说这个班跨零点 —— 后者是 `E139` 原始踩法的关键：
     `{name:'夜班',start:22,end:6}` 的 `start`/`end` 明写跨零点，只是两个时刻不在场 ⇒
     理由必须说"**切不了段**"，不许说成"判定有效"（本探针第一版就这样误报过）。 */
  const startEndNumeric = !!shift && typeof shift === 'object' &&
    typeof shift.start === 'number' && Number.isFinite(shift.start) &&
    typeof shift.end === 'number' && Number.isFinite(shift.end);
  const cfgCrossing = Number(shift && shift.end) <= Number(shift && shift.start);
  const faults = shiftShapeFaults(shift);
  if (!cfgCrossing || !bounds) {
    /* 非跨自然日：两段的"日期"其实都是班次开始那天（day2 恒 0）—— 一并给出，读方不用分支。
       ⚠ 完整形态下**原样返回这五个键**（`markSplitDegraded()` 一个键都不加）＝
       "无跨零点配置逐字不变"这条硬保证（`E83`／`E132` 反复保过的回归面）。 */
    const only = shift && typeof shift.date === 'string' ? shift.date : null;
    return markSplitDegraded({ day1: total, day2: 0, crossing: false, day1Date: only, day2Date: only },
      faults, { cut: false, startEndNumeric, cfgCrossing });
  }
  const startAt = bounds.s;
  const endAt = bounds.e;
  const span = Math.max(0, Math.round((endAt.getTime() - startAt.getTime()) / 1000));
  /* ⚠ 分配的分母是**已进行时长**（`shift.elapsedSec`），不是整班跨度 `span`：
     运行中（如 22:00 的夜班在次日 00:30 被读）时已进行的只有 9000 s，而整班跨度是 28800 s ——
     用 span 当分母会把 1800 s 的"后段时长"当成 6 h 的占比（实测：会把 800 : 200 算成 250 : 749）。
     `elapsedSec` 缺失/非法（旧调用方）时退化为 `span`（＝"整班已跑完"的常见情形，
     与 `server/index.js` 的 `completedShiftOf()` 同口径）。 */
  const liveElapsed = Number.isFinite(Number(shift && shift.elapsedSec)) && Number(shift.elapsedSec) > 0
    ? Math.min(span, Math.round(Number(shift.elapsedSec)))
    : span;
  /* 零点（**班次开始日的次日 0 点** ＝ 零点切段的那一刀）：⚠ 这一行必须从 `startAt` 推，
     不能从 `endAt` 推 —— 跨零点规则的 `endAt` **本身**就在次日，"拿 endAt 的日历日当零点"
     会把两段**算反**（实测：22→6 的 00:30 会切成 250 : 749，而正确的 2 h : 0.5 h 是 800 : 200）。
     算式：开始日的 00:00 ＋ 24 h。 */
  const dayStart = new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate(), 0, 0, 0, 0);
  const midnight = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  const day1Sec = Math.max(0, Math.min(span, Math.round((midnight.getTime() - startAt.getTime()) / 1000)));
  /* 分配（整数、总额恒定）：前段＝总额 × 前段占比（四舍五入后夹在 [0, total]），后段＝总额 − 前段。
     ⚠ 前段占比的分母必须是**已进行时长** `liveElapsed`（运行中 ≠ 整班跨度，见上）；
     并且 `day1Sec` 还要被 `liveElapsed` 夹一次 —— 运行中尚未走完"开始日那一整段"时
     （如 22:00 的班在 23:00 被读）前段占比不可能超过 1。 */
  const day1Span = Math.min(day1Sec, liveElapsed);
  const day1 = liveElapsed > 0 ? Math.max(0, Math.min(total, Math.round(total * (day1Span / liveElapsed)))) : 0;
  /* 段 → 日历归属（`yyyy-MM-dd`）随切段一起给出：`day1` 归**班次开始那天**、`day2` 归次日。
     为什么把归属**绑在切段结果上**（而不是让调用方另传一个参数）：两段与它们的日历归属是同一件事，
     分开传就会出现"传了切段、忘了归属"的形态 —— 而那时 `day1`/`day2` 只能靠猜塞进某一天，
     猜错正是 `E83` 要消掉的当日累计错位（实测踩到：次日的日档被多算进开始日那一段）。 */
  return markSplitDegraded(
    { day1, day2: total - day1, crossing: true, day1Date: shift.date, day2Date: fmtDate(midnight) },
    faults, { cut: true, startEndNumeric, cfgCrossing });
}

/**
 * 把本周期新增的运行秒数并入累计值。
 * @param {{daySec:number, monthSec:number, yearSec:number, at:string|Date}} prev 上次落库值（DR-17 持久化）
 * @param {number} addSec 本周期新增（通常为该班次的有效运行秒数）
 * @param {string|Date} now
 * @param {{day1:number, day2:number, crossing?:boolean, day1Date?:string, day2Date?:string}} [addSplit]
 *   `E83` 的**自然日切段**（`splitRunSecondsByDay()` 的产物）。
 *   · **缺省**（未传）或 `crossing !== true` ⇒ 行为与 `E83` 之前**逐字相同**：
 *     整段增量加进日/月/年三档（**不**按日期归属改日档）；月/年档之间的滚动仍由 `rollAccum` 负责；
 *   · `crossing === true` ⇒ 只有**跨零点**这一次增量才按日历归属入档（见下）。
 * @param {{shiftStartDate?:string, shiftNextDate?:string}} [alloc] 兜底的日历归属（`yyyy-MM-dd`）。
 *   ⚠ 为什么**只在 `crossing === true`** 时才动日档（本包实测踩到的两个坑，逐条登记）：
 *    ① **次日的日档会凭空多出开始日那一段**：22:00 的夜班在**次日** 00:30 被读时，"今天"是 D+1，
 *       读者要的是 `day2`；若把 `day1` 也加进日档，实测 `daySec` 由 192 变成 767 —— 正是 `E83`
 *       要消掉的那种错位，只是换了个方向；
 *    ② **不跨零点时按日期归属会改写既有读数**：`accumulateRunTime(prev, add, now)` 的 `prev`
 *       是调用方给的"上次落库值"，`rollAccum` 会在跨日时把旧 `daySec` 滚进月/年 —— 这是**既有**
 *       且**被测**的行为（`tests/logic-check.js` 的「五、累计运行」段与 `A1/D3-2`）。若对不跨零点的
 *       增量也做"按日期归属"，日档就会被改成"整班的 run_sec"，实测把 7 200 变成 28 800
 *       （3 条断言当场变红）。⇒ **不跨零点：一个字都不改**。
 *   本月/本年两档**同样受归属影响**（`E132`，2026-10-04 修正；上一版这里的断言"两段都落在
 *   同一个月/年"**是假的**）：跨零点只可能跨"日"这一句对**日**成立，对**月/年**不成立 ——
 *   月末/年末那一班会同时跨日、跨月（跨年）：`2026-10-31 22:00 → 11-01 06:00`、`now = 11-01 00:30`
 *   ⇒ `day1` 是**10 月**的 7200 s、`day2` 是**11 月**的 1800 s。上一版把两段**一起**加进
 *   `now` 所在的 11 月 ⇒ 实测 `monthSec = 9000`（11 月凭空多拿 10 月那 7200），而 10 月真正的
 *   读数被 `rollAccum()` 的跨月归零丢掉（10 月那段**永久丢失**）⇒ `FR-6.5`（本月）在月末必错；
 *   跨年（12-31 → 次年 01-01）同理 ⇒ `FR-6.6`（年度）在年末必错。
 *   ⇒ **月/年档按各段自己的日历归属聚合**（见下 `monthAdd`/`yearAdd`）：只有落在 `now` 所在
 *     月/年的那几段才进本周期档；不属于本周期的段**不进**（它们归**上一个**周期，见 `outOfPeriod`）。
 * @returns {{daySec:number, monthSec:number, yearSec:number, at:Date, reset:object,
 *            outOfPeriod:null|{month:number,year:number,note:string}}}
 *   `monthSec`/`yearSec` ＝ **本周期**（`now` 所在月/年）截至此刻的累计；
 *   `outOfPeriod` ＝ 本次切段里**不属于 `now` 所在周期**的那些秒数与一句口径说明
 *   （`null` ＝ 没有这种情况）—— 保留它是为了"扣掉的秒去哪儿了"能被看见，而不是静默消失。
 */
function accumulateRunTime(prev, addSec, now, addSplit, alloc) {
  const rolled = rollAccum(prev, toDate(now));
  const add = Math.max(0, Number(addSec) || 0);
  /* 切段口径：缺省 / 不跨零点 ⇒ "整段算当日"（与改动前逐字相同）；只有 `crossing === true`
     才按两段各自的日历归属入档。两段都做非负整数化，且**不**对 `day1 + day2` 做二次缩放
     （`splitRunSecondsByDay()` 已保证恒等式；这里只负责不造出负数/NaN）。
     ⚠ `E139`：**降级**的切段（`E139` 的 `degraded: true`）恒带 `crossing: false` ⇒ 在这里就落进
     "整段算当日"那一支（与 `E83` 之前逐字相同）—— 这正是"不抛错、不改变数值"的取舍。本函数
     **不**把 `degraded` 再抄进自己的返回值（**单一真源**：标记只挂在 `addSplit` 上，调用方手上
     已经有那个对象；多抄一处就会出现"两个地方都说降级、取值还可能不同"）。它在两条在产路径上
     被**读**到：`computeShiftStats()` 的 `runSecSplit`（原样带出）与 `stateSnapshot.statsOf()`
     的 `runAccum.currentShift.splitDegraded`（并记一条去重的 `console.warn`）。 */
  const hasSplit = addSplit && addSplit.crossing === true &&
    Number.isFinite(Number(addSplit.day1)) && Number.isFinite(Number(addSplit.day2));
  const day1 = hasSplit ? Math.max(0, Math.round(Number(addSplit.day1))) : add;
  const day2 = hasSplit ? Math.max(0, Math.round(Number(addSplit.day2))) : 0;
  /* `E132`：月/年档的加数**先各归 0**，只有"落进 `now` 所在周期"的段才被加上（见上 docblock）。
     默认值与上一版**逐字相同**：不跨零点（`hasSplit === false`）⇒ `monthAdd = yearAdd = day1 + day2
     = add + 0 = add`（`day1` 在该支就等于 `add`、`day2` 恒 0）⇒ 三档一个数都不变。 */
  let monthAdd = day1 + day2;
  let yearAdd = day1 + day2;
  let outOfPeriod = null;
  let toDay = add;
  if (hasSplit) {
    /* 两段的日历归属：优先取**切段结果自带**的（同源），否则退到调用方给的 `alloc` */
    const start = (addSplit && typeof addSplit.day1Date === 'string' && addSplit.day1Date)
      || (alloc && typeof alloc.shiftStartDate === 'string' ? alloc.shiftStartDate : null);
    if (!start) {
      throw new TypeError(
        'accumulateRunTime: 传入**跨零点**切段时必须能确定两段的日历归属（addSplit.day1Date/day2Date 或 ' +
        'alloc.shiftStartDate）—— 否则 day1 只能靠猜塞进某一天，而猜错就是 E83 要消掉的当日累计错位');
    }
    const next = (addSplit && typeof addSplit.day2Date === 'string' && addSplit.day2Date)
      || (alloc && typeof alloc.shiftNextDate === 'string' ? alloc.shiftNextDate : fmtDate(nextDay(start)));
    const nowDay = fmtDate(toDate(now));
    if (start === nowDay) toDay = day1;          // 班次开始于今天 ⇒ 前段进今天的日档
    else if (next === nowDay) toDay = day2;      // 今天＝次日 ⇒ 只有后段进今天的日档
    else toDay = day1 + day2;                    // 都不匹配（异常形态）⇒ 不丢秒，整段进日档

    /* ---- `E132`：月/年档按**日历归属**聚合（为什么必须这样，而不是加到 `now` 所属周期）----
       日档"两段分属 D 与 D+1"是 `E83` 已解决的那一半；月/年档是**同一件事的上一层**：
       自然月/自然年都是**日历区间**，而 `now` 只是这一次读数的时刻 —— 把两段一起塞进 `now`
       所在周期，等于承认"一个增量属于哪个周期由**读它的时刻**决定"，那正是 `E132` 的病灶。
       一个反例就够：10-31 22:00→11-01 06:00 在 11-01 00:30 被读 ⇒ 10 月那段会被算进 11 月，
       而 10 月的档已经被 `rollAccum()` 按跨月归零（`rolled.monthSec = 0`）⇒ 那些秒**永久丢失**
       （不是"晚一点才显示"，是不会再出现）。故：**按段自己的月/年归属分派，不属于本周期的不进**。
       ⚠ "不进"不等于"丢"（这是本修正能成立的另一半，必须写清）：
         · 该段的**持久真源**是 `shift_stat` 那一行（`shift_date = 班次开始日`），读口 `sumRunSec()`
           的 `segmentsOf()` 会把 `run_sec_day1` 归到班次开始日、`run_sec_day2` 归到次日 ——
           按**段自己的日历日**再归集到月/年档（`repo/shiftStat.js` 的 `projectRows()`）。
           那一行里的秒数**在它自己的周期里**一定被算到，与本函数无关；
         · 本函数只管"**当班未固化增量**"这一段读数：它属于 `prev`（`now` 所在周期的已固化求和）
           之外的增量 ⇒ 只有落进本周期的段才能进本周期档，否则就会重犯 `E132`；
         · 为了不把"扣掉的秒"做成静默行为，扣掉的部分随 `outOfPeriod` 一并报出（读数可核）。
       ⚠ 边界的同一性（为什么 `=== nowYear` 是**对的**判据，尽管"今年"其实由 1/1 零点定义，
         与"月"由 1 号零点定义不同）：`rolled.yearSec` 只在**跨年**时归零（`rollAccum()` 的
         `yearChanged`），而跨年那一刻起"今年"自然等于 `now` 的年 ⇒ `day1` 若真属于上一年，
         它就不该进 `rolled.yearSec + yearAdd`；若 `day1Date` 与 `now` 同年（哪怕跨了月），
         `rolled.yearSec` 也没归零 ⇒ 相加仍然正确。两档用的是同一条"日历归属"判据。 */
    if (typeof start === 'string' && start) {
      const d1 = toDate(`${start}T00:00:00`);
      const d2 = toDate(`${next}T00:00:00`);
      const nowD = toDate(now);
      const nowMonthKey = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}`;
      const nowYearKey = String(nowD.getFullYear());
      if (d1 && d2 && Number.isFinite(d1.getTime()) && Number.isFinite(d2.getTime())) {
        const d1MonthKey = `${d1.getFullYear()}-${String(d1.getMonth() + 1).padStart(2, '0')}`;
        const d2MonthKey = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}`;
        const d1YearKey = String(d1.getFullYear());
        const d2YearKey = String(d2.getFullYear());
        /* "两段同属本周期"是**常见情形**（班次不跨月末/年末）⇒ 保持上一版的合计口径（一次判定） */
        monthAdd = (d1MonthKey === nowMonthKey) ? day1 + (d2MonthKey === nowMonthKey ? day2 : 0)
          : (d2MonthKey === nowMonthKey ? day2 : 0);
        yearAdd = (d1YearKey === nowYearKey) ? day1 + (d2YearKey === nowYearKey ? day2 : 0)
          : (d2YearKey === nowYearKey ? day2 : 0);
        const outMonth = (day1 + day2) - monthAdd;
        const outYear = (day1 + day2) - yearAdd;
        if (outMonth > 0 || outYear > 0) {
          outOfPeriod = {
            month: outMonth,
            year: outYear,
            note: '这两段里有不属于 now 所在月/年的部分（跨月末/年末的跨零点班次）⇒ 本周期档**只收**' +
              '属于本周期的段，其余的秒数归**上一个**周期：它们由 shift_stat 那一行按段自己的日历日' +
              '（run_sec_day1 → 班次开始日、run_sec_day2 → 次日）计入各自周期（repo/shiftStat.js 的' +
              'segmentsOf/projectRows），**不是丢失**；此处报出只为让"扣掉的秒去哪儿了"可核。'
          };
        }
      }
    }
  }
  return {
    daySec: Math.max(0, rolled.daySec + toDay),
    monthSec: Math.max(0, rolled.monthSec + monthAdd),
    yearSec: Math.max(0, rolled.yearSec + yearAdd),
    at: rolled.at,
    reset: rolled.reset,
    outOfPeriod
  };
}

/** 日期文本 +1 天（`yyyy-MM-dd`；**纯日期运算，不读系统时间**，D17） */
function nextDay(dateText) {
  const d = new Date(`${dateText}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d;
}

module.exports = {
  STATUS,
  DONE_STATUS,
  computeShiftStats,
  accumulateRunTime,
  splitRunSecondsByDay,
  safeDiv,
  pct
};
