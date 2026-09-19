/* ==========================================================================
   当班生产统计（server/services/stats.js）
   作用：FR-4 全组 15 项指标的**唯一核算处**；口径与公式来自
        `src/config/board.config.js` 的 production.formula（Q-11 答复后只改配置）。
   设计：**纯函数 + 注入时钟** —— 不读系统时间、不碰数据库、不碰界面，
        因此可以用固定时刻把"班次边界/跨零点/累计不倒退"逐条钉死（FR-4.16 / DR-17）。
   关键口径（此前前端踩过的两个坑，这里写成硬约束）：
        · 未开工数 = max(0, 计划 − 开工数)  —— 开工数封顶于计划数，**绝不出现负数**
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
 *   @param {Array}    input.tasks     当班任务 [{ result, updatedAt? , startedAt?, finishedAt?, durationSec? }]
 *   @param {Array}    input.measures  当班采集时刻串（用于推导有效运行/待机时长；可为空）
 *   @param {object}   input.cycle     { sec } 单任务节拍（生产时长推导用），默认 160
 *   @param {object}   input.accum     累计运行上次落库值（DR-17），形如 { daySec, monthSec, yearSec, at }
 *   @param {number}   [input.addRunSec] **本周期增量**秒数（上次核算之后新增的运行时长）。
 *       缺省即 **0**（不是"当班已运行时长"）—— 见下方 P2-4 说明；调用方必须显式给出增量。
 *       边界：必须是 0 ≤ addRunSec ≤ runSec 的有限数，越界即抛错（防重复相加导致累计虚高）。
 *   @param {number}   input.planQty   当班计划数；缺省按当班任务条数
 *   @param {string|Date} input.now    当前时刻
 * @returns {object} 15 项指标 + DR-17 累计运行 + 班次信息
 */
function computeShiftStats(input) {
  const shift = input.shift;
  const tasks = input.tasks || [];
  const measures = input.measures || [];
  const cycleSec = (input.cycle && input.cycle.sec) || 160;
  const now = toDate(input.now);

  /* ---------------- 一、任务计数（先算，指标都由它派生） ---------------- */
  const total = tasks.length;
  const running = count(tasks, STATUS.RUNNING);
  const waiting = count(tasks, STATUS.WAITING);
  const retest = count(tasks, STATUS.RETEST);
  const pass = count(tasks, STATUS.PASS);
  const fail = count(tasks, STATUS.FAIL);
  const done = pass + fail;                                  // FR-4.4 已完成 = 合格+不合格
  const planQty = input.planQty === undefined ? total : Math.max(0, Number(input.planQty) || 0);
  /* 已开工 = 非"待测试"的任务数；**封顶于计划数**，保证"未开工 = 计划 − 开工"永不为负 */
  const started = Math.min(total - waiting, planQty);
  const notStarted = Math.max(0, planQty - started);         // FR-4.3

  /* ---------------- 二、时长（有效运行 / 待机） ----------------
     口径：任务处于"测试中"时，班次已进行的时段记有效运行；其余记待机。
     采集时刻串超过 2 条时，按"已收到几秒数据"截断，避免把断连后的时段算成运行。 */
  const elapsedSec = shift.elapsedSec;
  const byMeasures = measures.length > 2 ? Math.min(elapsedSec, measures.length - 1) : elapsedSec;
  const runSec = running > 0 ? byMeasures : 0;
  const idleSec = Math.max(0, elapsedSec - runSec);

  /* ---------------- 三、派生指标（公式走配置，分母为 0 一律返回 0） ---------------- */
  const firstPassRate = pct(pass, done);                       // FR-4.10 一次性合格率
  const capacityRate = pct(done, planQty);                     // FR-4.14 产能达成率
  const oee = pct(runSec, elapsedSec);                         // FR-4.15 稼动率
  const avgTestSec = done > 0 ? Math.round(runSec / done) : 0; // FR-4.13 单台平均测试时长

  /* ---------------- 四、累计运行（DR-17：单调不减、跨班次不清零） ---------------- */
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
    /* FR-4.1～4.9 */
    planQty, startedQty: started, notStartedQty: notStarted, doneQty: done,
    runningQty: running, waitingQty: waiting, passQty: pass, failQty: fail, retestQty: retest,
    /* FR-4.10～4.15 */
    firstPassRate, runSec, idleSec, avgTestSec, capacityRate, oee,
    /* DR-17 */
    accumulate: accum,
    /* 核对用 */
    taskTotal: total,
    cycleSec
  };
}

/** 计数小工具 */
function count(tasks, status) {
  return tasks.filter(t => t && t.result === status).length;
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
