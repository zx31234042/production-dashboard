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

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const env = require('./env');
const { createRunner } = require('./lib/assert');
const { createClock, BOUNDARIES } = require('./lib/clock');
const cfg = require('../src/config/board.config.js');
const { createShiftRules } = require('../server/services/shift');
const stats = require('../server/services/stats');

const ROOT = path.resolve(__dirname, '..');

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

/* ---------------- 前端班次推导：在独立 vm 里真加载 mockData.js（R26-P3-5 用） ----------------
   为什么要两侧都验：`src/services/mockData.js` 的 `shiftOf()` 是 `server/services/shift.js`
   `at()` 的**第二份实现**（浏览器侧不能 require 服务端模块，只能逐字同规则）—— 头屏班次
   （FR-1.9/1.10）与 FR-4.16 跨零点归属由它出。两侧一旦不同规则，头屏班次会与服务端统计分叉，
   而当前配置（0-8/8-16/16-24）下两侧输出一致，故缺陷长期潜伏。
   加载手法与 `tests/ui-check.js` 的 `loadUi()`／`tests/contract-check.js` 的
   `createIsolatedHarness()` **完全一致**（vm.createContext ＋ 按 index.html 顺序 run 源码），
   此处只取本用例需要的最小加载集（config → fieldMap → format → mockData），**不另造框架**。 */
function loadFrontEnd(list) {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const run = rel => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox,
    { filename: path.join(ROOT, rel) });
  run('src/config/board.config.js');
  /* 班次定义在 mockData.js **加载时**就快照进 SHIFTS ⇒ 必须先改配置再加载
     （与 contract-check 的 `mutate` 钩子同一个原因） */
  sandbox.window.BoardConfig.shift.list = list;
  run('src/config/fieldMap.js');
  run('src/utils/format.js');
  run('src/services/mockData.js');
  return {
    /** 驱动一次 tick，返回头屏消费的 state.shift 字段（异常原样抛出，供"必须显式抛错"用例断言） */
    tickAt(iso) {
      sandbox.window.MockData.tick(vm.runInContext(`new Date(${JSON.stringify(iso)})`, sandbox));
      const s = sandbox.window.MockData.state.shift;
      return { name: s.name, start: s.start, end: s.end, range: s.range,
        elapsed: s.elapsed, total: s.total, pct: s.pct };
    }
  };
}

/** 执行 fn 并把结果/异常都变成可断言的值：{ok:true,out} 或 {ok:false,err}
    （断言里一律用它取值，这样"实现改成抛错"只会让断言变红并打印原因，不会把脚本打崩） */
function callOrThrow(fn) {
  try { return { ok: true, out: fn() }; } catch (e) { return { ok: false, err: `${e.name}: ${e.message}` }; }
}

/** 把 callOrThrow 的结果压成一句可读文本（失败详情用） */
const brief = (r, pick) => (r.ok ? pick(r.out) : `【抛错】${r.err}`);

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

  /* ---- R26-P3-5：跨零点与配置缺口在**两侧**（服务端权威实现 ↔ 前端第二实现）逐点对账 ----
     两侧必须逐条同规则：① 命中判据（跨零点 = [start,24) ∪ [0,end)）② 边界半开 [start,end)
     ③ end=24 ④ 时刻不属任何班次（配置缺口）⇒ 一律显式抛错、绝不静默兜底。
     判据要求的配置＝单班跨零点 `[{夜班 22→6}]`；另加"三段含跨零点（覆盖完整 24h）"与
     "三段带缺口（末段＝丙班）"两个对照配置。 */
  const NIGHT1 = [{ name: '夜班', start: 22, end: 6 }];
  const NIGHT3 = [
    { name: '夜班', start: 22, end: 6 },
    { name: '白班', start: 6, end: 14 },
    { name: '中班', start: 14, end: 22 }
  ];
  const GAP3 = [
    { name: '甲班', start: 6, end: 10 },
    { name: '乙班', start: 10, end: 14 },
    { name: '丙班', start: 14, end: 18 }     // 末段：旧前端兜底 `|| SHIFTS[2]` 会把它当成 18:00～06:00 的班次
  ];
  const hhmmOf = n => `${String(n === 24 ? 0 : n).padStart(2, '0')}:00`;
  { /* ① 服务端口径 */
    const srvNight = createShiftRules(NIGHT1);
    const late = callOrThrow(() => srvNight.at('2026-09-19T23:00:00'));
    const early = callOrThrow(() => srvNight.at('2026-09-20T03:00:00'));
    t.check('R26-P3-5 跨零点 22→6（服务端）：23:00 与 03:00 都必须命中夜班（不得落任何兜底段）',
      late.ok && early.ok && late.out.name === '夜班' && early.out.name === '夜班',
      `23:00→${brief(late, o => o.name)}，03:00→${brief(early, o => o.name)}`);
    t.check('R26-P3-5 跨零点 22→6（服务端）：03:00 归属前一日、起于前一日 22:00，整班 8 小时、已过 5 小时',
      early.ok && early.out.date === '2026-09-19' && early.out.startAt === '2026-09-19 22:00:00' &&
      early.out.endAt === '2026-09-20 06:00:00' && early.out.totalSec === 8 * 3600 &&
      early.out.elapsedSec === 5 * 3600,
      brief(early, o => `归属 ${o.date} ${o.startAt}→${o.endAt}，elapsed=${o.elapsedSec}s total=${o.totalSec}s`));
    const b2200 = callOrThrow(() => srvNight.at('2026-09-19T22:00:00'));
    const b0559 = callOrThrow(() => srvNight.at('2026-09-20T05:59:59'));
    const b2159 = callOrThrow(() => srvNight.at('2026-09-19T21:59:00'));
    const b0600 = callOrThrow(() => srvNight.at('2026-09-20T06:00:00'));
    const isNight = r => r.ok && r.out.name === '夜班';
    t.check('R26-P3-5 跨零点边界开闭（服务端）：半开 [22:00, 06:00) —— 含 22:00/05:59:59，不含 21:59/06:00',
      isNight(b2200) && isNight(b0559) && !isNight(b2159) && !isNight(b0600),
      `22:00→${brief(b2200, o => o.name)}，05:59:59→${brief(b0559, o => o.name)}，` +
      `21:59→${brief(b2159, o => o.name)}，06:00→${brief(b0600, o => o.name)}`);
    const gapSrv = callOrThrow(() => srvNight.at('2026-09-19T12:00:00'));
    t.check('R26-P3-5 配置缺口不再静默兜底（服务端）：单班 22→6 在 12:00 显式抛错，不返回任何班次',
      !gapSrv.ok && /缺口/.test(String(gapSrv.err)) && /12:00:00/.test(String(gapSrv.err)),
      gapSrv.ok ? `静默返回了 ${gapSrv.out.name}（elapsed=${gapSrv.out.elapsedSec}s）` : gapSrv.err);
    const gapSrv3 = callOrThrow(() => createShiftRules(GAP3).at('2026-09-19T20:00:00'));
    t.check('R26-P3-5 配置缺口不再返回"下一个/末段"班次（服务端）：GAP3 在 20:00 抛错（旧实现静默返回「甲班」）',
      !gapSrv3.ok && !(gapSrv3.out && gapSrv3.out.name === '甲班'),
      gapSrv3.ok ? `静默返回了 ${gapSrv3.out.name} ${gapSrv3.out.start}-${gapSrv3.out.end}` : gapSrv3.err);
  }
  { /* ② 前端第二实现（vm 真加载 mockData.js） */
    const feNight1 = loadFrontEnd(NIGHT1);
    const feLate = callOrThrow(() => feNight1.tickAt('2026-09-19T23:00:00'));
    const feEarly = callOrThrow(() => feNight1.tickAt('2026-09-20T03:00:00'));
    const srvEarly = createShiftRules(NIGHT1).at('2026-09-20T03:00:00');
    t.check('R26-P3-5 跨零点 22→6（前端 mockData）：23:00 与 03:00 头屏班次都是夜班 22:00-06:00，且进度与服务端逐值一致',
      feLate.ok && feEarly.ok &&
      feLate.out.name === '夜班' && feLate.out.range === '22:00 - 06:00' &&
      feEarly.out.name === '夜班' && feEarly.out.range === '22:00 - 06:00' &&
      feEarly.out.elapsed === srvEarly.elapsedSec && feEarly.out.total === srvEarly.totalSec,
      `23:00→${brief(feLate, o => `${o.name} ${o.range} ${o.elapsed}s/${o.total}s`)}，` +
      `03:00→${brief(feEarly, o => `${o.name} ${o.range} ${o.elapsed}s/${o.total}s`)}` +
      `（服务端 ${srvEarly.elapsedSec}s/${srvEarly.totalSec}s）`);
    const fe2200 = callOrThrow(() => loadFrontEnd(NIGHT1).tickAt('2026-09-19T22:00:00'));
    const fe0559 = callOrThrow(() => loadFrontEnd(NIGHT1).tickAt('2026-09-20T05:59:59'));
    const fe2159 = callOrThrow(() => loadFrontEnd(NIGHT1).tickAt('2026-09-19T21:59:00'));
    const fe0600 = callOrThrow(() => loadFrontEnd(NIGHT1).tickAt('2026-09-20T06:00:00'));
    const feIsNight = r => r.ok && r.out.name === '夜班';
    t.check('R26-P3-5 跨零点边界开闭（前端 mockData）：半开 [22:00, 06:00) —— 含 22:00/05:59:59，不含 21:59/06:00',
      feIsNight(fe2200) && feIsNight(fe0559) && !feIsNight(fe2159) && !feIsNight(fe0600),
      `22:00→${brief(fe2200, o => o.name)}，05:59:59→${brief(fe0559, o => o.name)}，` +
      `21:59→${brief(fe2159, o => o.name)}，06:00→${brief(fe0600, o => o.name)}`);
    const feGap = callOrThrow(() => loadFrontEnd(GAP3).tickAt('2026-09-19T20:00:00'));
    t.check('R26-P3-5 配置缺口不再静默兜底（前端 mockData）：GAP3 在 20:00 显式抛错，不静默给出末段「丙班」',
      !feGap.ok && /缺口/.test(String(feGap.err)) && !(feGap.out && feGap.out.name === '丙班'),
      feGap.ok ? `静默返回了 ${feGap.out.name} ${feGap.out.range}` : feGap.err);
    const feN3 = callOrThrow(() => loadFrontEnd(NIGHT3).tickAt('2026-09-20T03:00:00'));
    t.check('R26-P3-5 跨零点不再落兜底段（前端 mockData）：NIGHT3 在 03:00 是夜班（改前落末段「中班 14:00-22:00」、进度 0）',
      feN3.ok && feN3.out.name === '夜班' && feN3.out.range === '22:00 - 06:00' &&
      feN3.out.elapsed === 5 * 3600 && feN3.out.total === 8 * 3600,
      brief(feN3, o => `${o.name} ${o.range} ${o.elapsed}s/${o.total}s`));
  }
  { /* ③ 回归：当前配置（0-8/8-16/16-24）两侧对整点与边界逐点一致 */
    const feCur = loadFrontEnd(cfg.shift.list);
    const srvCur = createShiftRules(cfg.shift.list);
    const points = ['2026-09-19T00:00:00', '2026-09-19T07:59:00', '2026-09-19T08:00:00',
      '2026-09-19T15:59:00', '2026-09-19T16:00:00', '2026-09-19T23:59:00'];
    const pairs = points.map(iso => ({
      hm: iso.slice(11, 16),
      srv: callOrThrow(() => srvCur.at(iso)),
      fe: callOrThrow(() => feCur.tickAt(iso))
    }));
    t.check('R26-P3-5 两侧同口径（当前配置）：六个边界时刻的班次名逐点一致',
      pairs.every(p => p.srv.ok && p.fe.ok && p.srv.out.name === p.fe.out.name),
      pairs.map(p => `${p.hm}=${brief(p.srv, o => o.name)}/${brief(p.fe, o => o.name)}`).join(' '));
    t.check('R26-P3-5 两侧同口径（当前配置）：起止时刻与已进行/总时长逐点一致（elapsed+remaining=total）',
      pairs.every(p => p.srv.ok && p.fe.ok &&
        p.fe.out.start === hhmmOf(p.srv.out.start) && p.fe.out.end === hhmmOf(p.srv.out.end) &&
        p.fe.out.elapsed === p.srv.out.elapsedSec && p.fe.out.total === p.srv.out.totalSec &&
        p.srv.out.elapsedSec + p.srv.out.remainingSec === p.srv.out.totalSec),
      pairs.map(p => `${p.hm}=${brief(p.fe, o => `${o.range} ${o.elapsed}s/${o.total}s`)}`).join(' '));
  }
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
  /* ⚠ 2026-09-19 修（P3 表外 code-10）：**原断言是循环的** —— 它们拿被测实现算出的 r.runSec
     去验同一实现的公式（如 `idleSec === elapsedSec − runSec`），只能证明"内部自洽"，
     证明不了公式对不对。现改为用**独立已知量**（班次进度 + 用例构造的 tasks/measures）推出期望值。 */
  const elapsed = shift.elapsedSec;                       // 独立已知：班次已进行时长
  const runningCount = list.filter(x => x.result === '测试中').length;
  const measures = [];                                    // 本用例未传 measures
  const runSecExpected = runningCount > 0
    ? (measures.length > 2 ? Math.min(elapsed, measures.length - 1) : elapsed)
    : 0;
  t.check('FR-4.11 有效运行时长＝在测时按班次进度计（无采集串时等于班次进度）',
    r.runSec === runSecExpected && r.runSec === elapsed,
    `实测 runSec=${r.runSec}s，按输入独立推出 ${runSecExpected}s（在测 ${runningCount} 条）`);
  t.check('FR-4.12 待机时长 = 班次进度 − 有效运行',
    r.idleSec === elapsed - runSecExpected, `实测 ${r.idleSec}s = ${elapsed} − ${runSecExpected}`);
  t.check('FR-4.13 单台平均测试时长 = 运行 / 完成数',
    r.avgTestSec === Math.round(runSecExpected / 10), `实测 ${r.avgTestSec}s（期望 ${Math.round(runSecExpected / 10)}s）`);
  t.check('FR-4.14 产能达成率 = 完成 / 计划', r.capacityRate === Number((10 / 16 * 100).toFixed(1)),
    `${r.capacityRate}%`);
  t.check('FR-4.15 稼动率 = 有效运行 / 班次进度',
    r.oee === Number((runSecExpected / elapsed * 100).toFixed(1)), `实测 ${r.oee}%（期望 ${Number((runSecExpected / elapsed * 100).toFixed(1))}%）`);
  t.check('指标齐全：一次核算同时给出 15 项（不缺项）',
    ['planQty', 'startedQty', 'notStartedQty', 'doneQty', 'runningQty', 'waitingQty',
      'passQty', 'failQty', 'retestQty', 'firstPassRate', 'runSec', 'idleSec',
      'avgTestSec', 'capacityRate', 'oee'].every(k => k in r), '');

  /* P2-4：`addRunSec` 必须是"本周期增量" —— 缺省即 0，绝不再默认取"班次已运行时长"。
     旧实现在把上次落库的 accum 传回来时会把累计值当增量重复相加（复审已复现）。

     写法（ADR-0004 D21 的构成性约定）：期望值**不写手算魔数**，一律由"已知正确的量"算出来。
     这样以后改基数或增量，断言不用跟着改，也不会因为"魔数凑上去"而失真。 */
  const accumBase = { daySec: 3600, monthSec: 7200, yearSec: 10800, at: clock.now() };
  const addSec = 120;
  const baseSum = accumBase.daySec + accumBase.monthSec + accumBase.yearSec;
  const sumOf = a => a.daySec + a.monthSec + a.yearSec;

  const noAdd = stats.computeShiftStats({ shift, tasks: list, planQty: 16, now: clock.now(), accum: accumBase });
  t.check('P2-4：不传 addRunSec 时按增量 0 累加（累计不被重复相加）',
    noAdd.accumulate.daySec === accumBase.daySec &&
    noAdd.accumulate.monthSec === accumBase.monthSec &&
    noAdd.accumulate.yearSec === accumBase.yearSec,
    `三项与传入值逐一致（实测 day=${noAdd.accumulate.daySec}）`);

  t.check('P2-4：显式给增量时三项同步 +addRunSec，且再传回时原样保留（不重复相加）',
    (() => {
      const withAdd = stats.computeShiftStats({ shift, tasks: list, planQty: 16, now: clock.now(), accum: accumBase, addRunSec: addSec });
      const again = stats.computeShiftStats({ shift, tasks: list, planQty: 16, now: clock.now(), accum: withAdd.accumulate, addRunSec: 0 });
      /* 日/月/年三项各自"原值 + 增量"，总量随之 +3×增量 —— 全部由已知量推出，无魔数 */
      const expected = { daySec: accumBase.daySec + addSec, monthSec: accumBase.monthSec + addSec, yearSec: accumBase.yearSec + addSec };
      const atExpected = a => a.daySec === expected.daySec && a.monthSec === expected.monthSec && a.yearSec === expected.yearSec;
      return atExpected(withAdd.accumulate) && atExpected(again.accumulate) &&
        sumOf(withAdd.accumulate) === baseSum + 3 * addSec;
    })(), `增量 ${addSec}s：三项各自 +${addSec}，两次结果一致`);
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
