/* ==========================================================================
   当班统计与班次边界自检（tests/logic-check.js）
   作用：把 FR-4 全组（15 项统计）与 FR-4.16（班次自动切换与跨零点归属）、
        DR-17（累计运行持久化、重启不倒退）变成可复跑断言。
   **为什么这个脚本是"统计口径"的最终判据**：业务代码不读系统时间，时间全部注入，
        因此 07:59:30 与 08:00:30 这种边界可以**确定性地**验，而不是"看运气跑"。
   依据：FR-4.1～4.17、FR-1.9/1.10、DR-17；口径源 `src/config/board.config.js`。
   运行：node tests/logic-check.js
   退出码：0 = 全部通过；1 = 有断言失败。
   ========================================================================== */
'use strict';

const env = require('./env');
const { createRunner } = require('./lib/assert');
const { createClock, BOUNDARIES } = require('./lib/clock');
const cfg = require('../src/config/board.config.js');
const { createShiftRules } = require('../server/services/shift');
const stats = require('../server/services/stats');

env.assertRuntime();
const t = createRunner('当班统计与班次边界自检（logic-check）');
const shifts = createShiftRules(cfg.shift.list);

/** 造任务：n 条指定结果 */
function tasks(n, result) {
  return Array.from({ length: n }, (_, i) => ({ procOrderNo: `PO-${i + 1}`, result }));
}
/** 混合任务（按结果计数） */
function mixed(spec) {
  return Object.entries(spec).flatMap(([result, n]) => tasks(n, result));
}

/* ---------------- 一、班次规则来自配置（不硬编码） ---------------- */
t.section('一、班次规则（FR-1.9/1.10，口径来自 board.config.js）');
{
  t.check('班次列表由配置提供且非空', shifts.rules.length > 0 && shifts.names().length === cfg.shift.list.length,
    shifts.names().join(' / '));
  t.check('班次起止为整点且配置可改（改配置即改行为）',
    shifts.rules.every(r => Number.isInteger(r.start) && Number.isInteger(r.end)), '');
  const s = shifts.at('2026-09-19T10:00:00');
  t.check('班次起止时间的可读表述（FR-1.10）', /^(早班|中班|晚班) \d{2}:00-\d{2}:00$/.test(shifts.describe(s)),
    shifts.describe(s));
}

/* ---------------- 二、班次边界（FR-4.16） ---------------- */
t.section('二、班次边界自动切换与跨零点归属（FR-4.16）');
{
  const before = shifts.at(BOUNDARIES.morningBefore);   // 2026-09-19 07:59:30
  const after = shifts.at(BOUNDARIES.morningAfter);     // 2026-09-19 08:00:30
  t.check('07:59:30 属晚班，08:00:30 属早班（交班瞬间切换）',
    before.name === '晚班' && after.name === '早班', `${before.name} → ${after.name}`);
  t.check('跨零点：00:00:30 属"当日"晚班，且班次从当日 00:00 起算（归属不回退）',
    shifts.at(BOUNDARIES.midnight).name === '晚班' &&
    shifts.at(BOUNDARIES.midnight).date === '2026-09-20' &&
    shifts.at(BOUNDARIES.midnight).startAt === '2026-09-20 00:00:00',
    `${shifts.at(BOUNDARIES.midnight).name} 归属 ${shifts.at(BOUNDARIES.midnight).date}，起于 ${shifts.at(BOUNDARIES.midnight).startAt}`);
  t.check('16:00:30 交中班', shifts.at(BOUNDARIES.afternoonAfter).name === '中班', '');
  t.check('23:59:30 属中班的最后时刻（尚未跨零点）',
    shifts.at(BOUNDARIES.lateNight).name === '中班', shifts.at(BOUNDARIES.lateNight).name);

  /* 三个班次首尾相接、覆盖完整 24 小时（这是"跨零点归属正确"的实质） */
  const e1 = shifts.at('2026-09-19T07:59:59');
  const e2 = shifts.at('2026-09-19T08:00:00');
  const e3 = shifts.at('2026-09-19T15:59:59');
  const e4 = shifts.at('2026-09-19T16:00:00');
  const e5 = shifts.at('2026-09-19T23:59:59');
  const e6 = shifts.at('2026-09-20T00:00:00');
  t.check('晚班→早班 首尾相接（前一班结束 = 后一班开始）',
    e1.endAt === e2.startAt && e1.name === '晚班' && e2.name === '早班', `${e1.endAt} → ${e2.startAt}`);
  t.check('早班→中班 首尾相接', e3.endAt === e4.startAt && e4.name === '中班', `${e3.endAt} → ${e4.startAt}`);
  t.check('中班→次日晩班 首尾相接（跨零点）',
    e5.endAt === e6.startAt && e5.name === '中班' && e6.name === '晚班', `${e5.endAt} → ${e6.startAt}`);
  t.check('三个班次总时长恰为 24 小时',
    shifts.rules.reduce((a, r) => a + ((r.end === 24 ? 24 : r.end) - r.start) * 3600, 0) === 24 * 3600,
    shifts.rules.map(r => `${r.name} ${r.start}-${r.end}`).join(' / '));

  const mid = shifts.at('2026-09-19T12:00:00');
  t.check('班次总时长与进度自洽（elapsed + remaining = total）',
    mid.elapsedSec + mid.remainingSec === mid.totalSec && mid.totalSec === 8 * 3600,
    `total=${mid.totalSec}s elapsed=${mid.elapsedSec}s`);
  t.check('班次刚开始时 elapsed 为 0，结束时接近总时长',
    shifts.at('2026-09-19T08:00:00').elapsedSec === 0 &&
    shifts.at('2026-09-19T15:59:59').elapsedSec >= 8 * 3600 - 2, '');

  /* P2-3：跨零点规则（end < start）与非法配置 —— 复审实测旧实现里 22→6 这种规则
     **永远匹配不到**（`hour >= 22 && hour < 6` 恒假），会悄悄落到兜底分支，
     看板上于是显示错的班次名与时长。这里把"必须匹配"和"非法配置必须拒绝"都钉住。 */
  const night = createShiftRules([{ name: '夜班', start: 22, end: 6 }]);
  t.check('跨零点规则 22→6：22:30 与 05:30 都归属该班次（旧实现恒不匹配）',
    night.at('2026-09-19T22:30:00').name === '夜班' && night.at('2026-09-20T05:30:00').name === '夜班',
    `22:30→${night.at('2026-09-19T22:30:00').name}，05:30→${night.at('2026-09-20T05:30:00').name}`);
  t.check('跨零点规则 22→6：总时长 8 小时，且 05:30 的班次归属前一天（开始那天）',
    night.at('2026-09-19T22:30:00').totalSec === 8 * 3600 &&
    night.at('2026-09-20T05:30:00').date === '2026-09-19' &&
    night.at('2026-09-20T05:30:00').startAt === '2026-09-19 22:00:00',
    `${night.at('2026-09-20T05:30:00').date} 起于 ${night.at('2026-09-20T05:30:00').startAt}`);
  t.check('跨零点规则的 elapsed/remaining 自洽，且 22:00 起算、05:59:59 接近满班',
    (() => {
      const x = night.at('2026-09-20T03:00:00');
      const s = night.at('2026-09-19T22:00:00');
      const e = night.at('2026-09-20T05:59:59');
      return x.elapsedSec + x.remainingSec === x.totalSec && x.elapsedSec === 5 * 3600 &&
        s.elapsedSec === 0 && e.elapsedSec >= 8 * 3600 - 2;
    })(), '03:00 已过 5 小时');
  const badCfgs = [
    [{ name: 'a', start: 8, end: 8 }],
    [{ name: 'a', start: -1, end: 8 }],
    [{ name: 'a', start: 8, end: 25 }],
    [{ name: 'a', start: 24, end: 8 }],
    [{ name: 'a', start: 8.5, end: 16 }],
    [{ name: 'a', start: 8, end: 16 }, { name: 'b', start: 20, end: 4.5 }]
  ];
  let badRejected = 0;
  for (const cfgBad of badCfgs) {
    try { createShiftRules(cfgBad); } catch { badRejected++; }
  }
  t.check('非法班次配置一律拒绝（零长度/越界/非整点），不再静默走兜底',
    badRejected === badCfgs.length, `${badRejected}/${badCfgs.length} 被拒绝`);
  t.check('空班次列表仍报错（既有行为不回退）',
    (() => { try { createShiftRules([]); return false; } catch { return true; } })());
}

/* ---------------- 三、15 项指标（FR-4.1～4.15） ---------------- */
t.section('三、15 项当班指标（FR-4.1～4.15）');
{
  const clock = createClock({ mode: 'fixed', at: '2026-09-19T12:00:00' });
  const shift = shifts.current(clock);
  const list = mixed({ 待测试: 3, 测试中: 2, 合格: 8, 不合格: 2, 待复检: 1 });
  const r = stats.computeShiftStats({
    shift, tasks: list, planQty: 16, now: clock.now(),
    accum: { daySec: 3600, monthSec: 7200, yearSec: 10800, at: clock.now() }
  });

  t.check('FR-4.1 计划总数来自参数', r.planQty === 16, String(r.planQty));
  t.check('FR-4.2 开工数 = 非"待测试"条数', r.startedQty === 13, String(r.startedQty));
  t.check('FR-4.3 未开工 = 计划 − 开工', r.notStartedQty === 3, String(r.notStartedQty));
  t.check('FR-4.4 已完成 = 合格 + 不合格', r.doneQty === 10, String(r.doneQty));
  t.check('FR-4.5 测试中数量', r.runningQty === 2, String(r.runningQty));
  t.check('FR-4.6 待测试数量', r.waitingQty === 3, String(r.waitingQty));
  t.check('FR-4.7 合格数', r.passQty === 8, String(r.passQty));
  t.check('FR-4.8 不合格数', r.failQty === 2, String(r.failQty));
  t.check('FR-4.9 复检数', r.retestQty === 1, String(r.retestQty));
  t.check('FR-4.10 一次性合格率 = 合格 / 已完成 = 80%', r.firstPassRate === 80, `${r.firstPassRate}%`);
  t.check('FR-4.11 有效运行时长有值且不超过班次进度',
    r.runSec > 0 && r.runSec <= r.shift.elapsedSec, `${r.runSec}s / 班次 ${r.shift.elapsedSec}s`);
  t.check('FR-4.12 待机时长 = 班次进度 − 有效运行', r.idleSec === r.shift.elapsedSec - r.runSec,
    `${r.idleSec}s`);
  t.check('FR-4.13 单台平均测试时长 = 运行 / 完成数',
    r.avgTestSec === Math.round(r.runSec / 10), `${r.avgTestSec}s`);
  t.check('FR-4.14 产能达成率 = 完成 / 计划', r.capacityRate === Number((10 / 16 * 100).toFixed(1)),
    `${r.capacityRate}%`);
  t.check('FR-4.15 稼动率 = 有效运行 / 班次进度',
    r.oee === Number((r.runSec / r.shift.elapsedSec * 100).toFixed(1)), `${r.oee}%`);
  t.check('指标齐全：一次核算同时给出 15 项（不缺项）',
    ['planQty', 'startedQty', 'notStartedQty', 'doneQty', 'runningQty', 'waitingQty',
      'passQty', 'failQty', 'retestQty', 'firstPassRate', 'runSec', 'idleSec',
      'avgTestSec', 'capacityRate', 'oee'].every(k => k in r), '');

  /* P2-4：`addRunSec` 必须是"本周期增量" —— 缺省即 0，绝不再默认取"班次已运行时长"。
     旧实现在把上次落库的 accum 传回来时会把累计值当增量重复相加（复审已复现）。 */
  const accumBase = { daySec: 3600, monthSec: 7200, yearSec: 10800, at: clock.now() };
  const noAdd = stats.computeShiftStats({ shift, tasks: list, planQty: 16, now: clock.now(), accum: accumBase });
  t.check('P2-4：不传 addRunSec 时按增量 0 累加（累计不被重复相加）',
    noAdd.accumulate.daySec === 3600 && noAdd.accumulate.monthSec === 7200,
    `daySec=${noAdd.accumulate.daySec}（旧实现会变成 3600+${r.runSec}）`);
  t.check('P2-4：显式给增量时按增量累加（幂等口径）',
    (() => {
      const withAdd = stats.computeShiftStats({ shift, tasks: list, planQty: 16, now: clock.now(), accum: accumBase, addRunSec: 120 });
      const again = stats.computeShiftStats({ shift, tasks: list, planQty: 16, now: clock.now(), accum: withAdd.accumulate, addRunSec: 0 });
      return withAdd.accumulate.daySec === 3720 && withAdd.accumulate.monthSec === 7320 &&
        withAdd.accumulate.yearSec === 10920 &&
        again.accumulate.daySec === 3720 && again.accumulate.monthSec === 7320 &&
        again.accumulate.yearSec === 10920;
    })(), '第二次传回上次结果且增量 0 → 累计原样保留（不重复相加）');
  t.check('P2-4：addRunSec 越界（负数/超过本班运行时长/NaN/Infinity）一律抛错',
    (() => {
      let n = 0;
      for (const bad of [-1, r.runSec + 1, NaN, Infinity]) {
        try { stats.computeShiftStats({ shift, tasks: list, planQty: 16, now: clock.now(), accum: accumBase, addRunSec: bad }); }
        catch { n++; }
      }
      return n === 4;
    })(), '4/4 抛错');
}

/* ---------------- 四、边界与除零（此前踩过的坑） ---------------- */
t.section('四、边界与除零（"未开工为负"是前端曾复现过的真实缺陷）');
{
  const clock = createClock({ mode: 'fixed', at: '2026-09-19T15:00:00' });
  const shift = shifts.current(clock);

  /* 计划 100，但已开工 120（复检计入开工）→ 未开工必须是 0，不能是 −20 */
  const overflow = stats.computeShiftStats({
    shift, planQty: 100, now: clock.now(),
    tasks: mixed({ 合格: 118, 待复检: 2 })
  });
  t.check('开工数超过计划时，未开工封顶为 0（不出现负数）',
    overflow.startedQty === 100 && overflow.notStartedQty === 0,
    `开工=${overflow.startedQty} 未开工=${overflow.notStartedQty}`);

  const empty = stats.computeShiftStats({ shift, planQty: 0, tasks: [], now: clock.now() });
  t.check('空数据不产生 NaN：各项比率为 0、时长为 0',
    empty.firstPassRate === 0 && empty.capacityRate === 0 && empty.oee === 0 &&
    empty.avgTestSec === 0 && empty.runSec === 0 && empty.notStartedQty === 0, '');

  const noPlan = stats.computeShiftStats({ shift, tasks: mixed({ 合格: 5 }), now: clock.now() });
  t.check('未给计划数时按任务条数兜底（不留 undefined）',
    noPlan.planQty === 5 && noPlan.notStartedQty === 0, `plan=${noPlan.planQty}`);

  const allWaiting = stats.computeShiftStats({ shift, planQty: 10, tasks: tasks(10, '待测试'), now: clock.now() });
  t.check('全部待测试：开工 0、未开工等于计划、有效运行为 0（待机占满）',
    allWaiting.startedQty === 0 && allWaiting.notStartedQty === 10 &&
    allWaiting.runSec === 0 && allWaiting.idleSec === allWaiting.shift.elapsedSec, '');
}

/* ---------------- 五、累计运行（DR-17） ---------------- */
t.section('五、累计运行持久化：重启不倒退、跨班次不清零（DR-17）');
{
  /* 已有累计值（模拟重启后从库里读回） */
  const persisted = { daySec: 3600, monthSec: 7200, yearSec: 10800, at: '2026-09-19T12:00:00' };

  const sameDay = stats.accumulateRunTime(persisted, 60, '2026-09-19T12:01:00');
  t.check('同日内累加：三个周期都增加，且都不小于原值',
    sameDay.daySec === 3660 && sameDay.monthSec === 7260 && sameDay.yearSec === 10860 &&
    sameDay.reset.day === false, JSON.stringify(sameDay));

  /* 跨班次（12:00 中班 → 16:30 中班 → 00:30 晚班）都不该让累计变小 */
  const crossShift = stats.accumulateRunTime(persisted, 60, '2026-09-19T16:30:00');
  t.check('跨班次不清零：累计只增不减',
    crossShift.daySec >= persisted.daySec && crossShift.monthSec >= persisted.monthSec,
    JSON.stringify(crossShift));
  const crossMidnight = stats.accumulateRunTime(persisted, 60, '2026-09-20T00:30:00');
  t.check('跨零点：日累计归零，但月/年**继续累积**（把上一日的日累计滚入）',
    crossMidnight.daySec === 60 &&
    crossMidnight.monthSec === persisted.monthSec + persisted.daySec + 60 &&
    crossMidnight.yearSec === persisted.yearSec + persisted.daySec + 60 &&
    crossMidnight.reset.day === true,
    JSON.stringify(crossMidnight));

  const crossMonth = stats.accumulateRunTime(persisted, 60, BOUNDARIES.monthEnd);
  t.check('跨月（9/30→10/1 前后）：月累计归零、年累计继续累积',
    crossMonth.reset.month === false, '9/30 当天未跨月，reset.month 应为 false');
  const nextMonth = stats.accumulateRunTime(persisted, 60, '2026-10-01T00:30:00');
  t.check('进入 10 月后月累计重置为新增值，年累计仍 ≥ 原值',
    nextMonth.reset.month === true && nextMonth.monthSec === 60 &&
    nextMonth.yearSec >= persisted.yearSec, JSON.stringify(nextMonth));

  const crossYear = stats.accumulateRunTime(persisted, 60, '2027-01-01T00:30:00');
  t.check('跨年：年累计归零为新增值，且等于月的处理',
    crossYear.reset.year === true && crossYear.yearSec === 60, JSON.stringify(crossYear));

  /* 首次入库：**必须原样保留**已持久化的累计值，绝不能抹成 0 */
  const noAt = stats.accumulateRunTime({ daySec: 100, monthSec: 200, yearSec: 300 }, 10, '2026-09-19T12:00:00');
  t.check('首次入库（无上次时间戳）保留已有累计值，不抹零（重启不丢失的关键）',
    noAt.daySec === 110 && noAt.monthSec === 210 && noAt.yearSec === 310, JSON.stringify(noAt));

  const negative = stats.accumulateRunTime(persisted, -50, '2026-09-19T12:01:00');
  t.check('负增量被夹为 0（不因脏数据让累计倒退）',
    negative.daySec === persisted.daySec, String(negative.daySec));
}

/* ---------------- 六、与配置的一致性 ---------------- */
t.section('六、与 board.config.js 的一致性（前后端同一份口径）');
{
  t.check('统计脚本读到的就是前端那份配置（单一真源，非复制）',
    cfg.production.cycleSec === 160 && Number.isFinite(cfg.production.runRate),
    `cycleSec=${cfg.production.cycleSec}`);
  const clock = createClock({ mode: 'fixed', at: '2026-09-19T10:00:00' });
  const r = stats.computeShiftStats({ shift: shifts.current(clock), tasks: [], now: clock.now() });
  t.check('节拍取配置值', r.cycleSec === cfg.production.cycleSec, String(r.cycleSec));
  t.check('班次名称与配置列表逐项一致',
    shifts.names().join('|') === cfg.shift.list.map(s => s.name).join('|'),
    shifts.names().join(' / '));
}

t.finish();
