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
/* W3（判定引擎）：服务端权威实现 ＋ 与前端演示实现对账用的标准换算（**只读复用**，不另写取数） */
const judgeSvc = require('../server/services/judge');
const standardSvc = require('../server/services/standard');

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
function loadFrontEnd(list, options) {
  const opts = options || {};
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const run = rel => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox,
    { filename: path.join(ROOT, rel) });
  run('src/config/board.config.js');
  /* 班次定义在 mockData.js **加载时**就快照进 SHIFTS ⇒ 必须先改配置再加载
     （与 contract-check 的 `mutate` 钩子同一个原因）；`outputRatio` 同理（W3 的工单超时 err 用例
     需要一个"实际产出慢于计划"的演示现场，而它也是加载期快照） */
  sandbox.window.BoardConfig.shift.list = list;
  if (typeof opts.outputRatio === 'number') sandbox.window.BoardConfig.production.outputRatio = opts.outputRatio;
  run('src/config/fieldMap.js');
  run('src/utils/format.js');
  run('src/services/mockData.js');
  const M = sandbox.window.MockData;
  const ctxMath = vm.runInContext('Math', sandbox);   // 上下文内 `Math` 的**同一份**对象（冻结随机游走用）
  return {
    /** 该实例自己的配置对象（W3 的"阈值可配"用例只在内存里改它，不落盘） */
    config: sandbox.window.BoardConfig,
    mockData: M,
    /** 驱动一次 tick，返回头屏消费的 state.shift 字段（异常原样抛出，供"必须显式抛错"用例断言） */
    tickAt(iso) {
      sandbox.window.MockData.tick(vm.runInContext(`new Date(${JSON.stringify(iso)})`, sandbox));
      const s = sandbox.window.MockData.state.shift;
      return { name: s.name, start: s.start, end: s.end, range: s.range,
        elapsed: s.elapsed, total: s.total, pct: s.pct };
    },
    /**
     * W3 用：**冻结随机游走**后走一帧，返回前端演示实现的判定与预警现场。
     *   · `Math.random` 顶成 0.5 ⇒ 步长恒 0 ⇒ 实测值不再游走，判据完全确定（与 ui-check 的
     *     R26-P2-2 用例同一手法），不依赖"碰巧扫到某一帧"；
     *   · 只写**运行时真源** `state.task.standard`（FR-3.19 现场录入）与 `state.task.real`（实测），
     *     再由 `tick()` 触发重算 —— 走的正是 `buildParamWarnings()` / `buildWarnings()` 真路径
     *     （它们未导出：public surface 只有 standardLevel / standardSpecOf / tick / state）；
     *   · 速度只能由 vx/vy 合成（令 vy=0 ⇒ speed = |vx|），故用例的实测值都取在演示 clamps 内；
     *   · `finally` 无条件还原 `Math.random` 与标准（后续用例不受影响）。
     * @returns {{real:{depth:number,speed:number}, levels:Array, ctx:object, warnings:Array}}
     */
    freezeTick(iso, standard, real) {
      const savedRandom = ctxMath.random;
      const savedStandard = M.state.task.standard;
      try {
        ctxMath.random = () => 0.5;
        M.state.task.standard = standard;
        if (real && typeof real === 'object') {
          if (real.depth !== undefined) M.state.task.real.depth = real.depth;
          if (real.speed !== undefined) { M.state.task.real.vx = real.speed; M.state.task.real.vy = 0; }
        }
        M.tick(vm.runInContext(`new Date(${JSON.stringify(iso)})`, sandbox));
        const got = { depth: M.state.task.real.depth, speed: M.state.task.real.speed };
        return {
          real: got,
          levels: ['depth', 'speed'].map(kind => {
            const spec = M.standardSpecOf(kind);
            return { kind, lv: M.standardLevel(got[kind], spec) };
          }),
          ctx: {
            maintDaysLeft: M.state.maint.daysLeft,
            maintNext: M.state.maint.next,
            /* 耗材累计点亮时长＝演示基准 + 已完成任务数（与 mockData 的演示算式同源；
               基准从 MockData.CFG 读，**不在断言里另写一份 780**） */
            lampHours: M.CFG.lampBaseline + Math.floor(M.state.stats.done || 0),
            pending: M.state.stats.pending,
            /* FR-5.11 **新判据**（2026-09-30 判据变更）的两个入参现场：前端按"班次已进行秒数 / 节拍"
               算应完成、按 `state.stats.done` 取已完成 ⇒ 对账时必须把**同一组**喂给服务端，
               否则两侧算的不是同一个量（旧口径喂的是 `pendingQty`，已废止）。 */
            shiftElapsed: M.state.shift.elapsed,
            done: Math.floor(M.state.stats.done || 0)
          },
          warnings: (M.state.warnings || []).map(x => ({ title: x.title, lv: x.lv, detail: x.detail }))
        };
      } finally {
        ctxMath.random = savedRandom;
        M.state.task.standard = savedStandard;
      }
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

/* ---------------- 七、判定引擎（服务端权威实现）：标准导出 / 三态 / 闭边界 ----------------
   本段与以下三段（八 / 九 / 十）是 **W3（服务层第二笔·第 1 波）** 的判据：
     · 判定对象＝**深度与速度的测试标准上下限**（FR-3.14 / C-75）；相机参数不参与（C-84④）；
     · 上下限由「典型值 ± 上/下偏差」导出（FR-3.18 / FR-3.19 / C-90），**取数复用
       `server/services/standard.js`**（不在判定引擎里重写第二套）；
     · 三态闭边界（FR-3.18）：**压线（恰等于上下限）不算超范围**、**距边界恰等于带宽算临近**；
     · 标准未设定 / 实测缺测 ⇒ idle，**不判合格、不判超范围、不出参数类预警**；
     · 五态（FR-3.13）：待测试 / 测试中 / 合格 / 不合格 / 待复检（进入条件见 §八的说明）。
   期望值一律由**配置真源**（`board.config.js` 的 standards / maintenance / warnings）推出，
   不写手算魔数 —— 改配置后本段期望值自动跟随。 */
t.section('七、判定引擎：标准上下限导出与三态闭边界（FR-3.13 / FR-3.14 / FR-3.18）');
{
  const STD = cfg.standards;
  const GRID = 1 / Math.pow(10, STD.digits);          // 显示精度一格（两位小数 ⇒ 0.01）
  const dSpec = STD.default.depth;                    // 演示默认标准：深度典型值 5.00、偏差 +0.30/−0.20
  const sSpec = STD.default.speed;
  /** 由"典型值 ± 偏差"导出上下限与临近带宽（**只用于构造用例输入**，不是被测实现） */
  const bandOf = spec => {
    const upper = standardSvc.round2(spec.typical + spec.upperDev);
    const lower = standardSvc.round2(spec.typical + spec.lowerDev);
    const tol = (upper - lower) * STD.nearRatio;
    return { upper, lower, tol, k: Math.max(1, Math.ceil(tol / GRID - 1e-9)) };
  };
  const dB = bandOf(dSpec);
  const sB = bandOf(sSpec);
  /** 对称带（上下偏差等值）：跨度恰为**整数格**的倍数 ⇒ 可做"距边界**恰等于**带宽"的值级用例 */
  const symSpec = { unit: dSpec.unit, digits: STD.digits,
    typical: dSpec.typical, upperDev: dSpec.upperDev, lowerDev: -dSpec.upperDev };
  const symB = bandOf(symSpec);

  const judgeOk = t.requires('判定引擎入口可用（judge.standardLevel / limits / buildParamWarnings / taskResult）',
    !!judgeSvc && typeof judgeSvc.standardLevel === 'function' && typeof judgeSvc.limits === 'function' &&
    typeof judgeSvc.buildParamWarnings === 'function' && typeof judgeSvc.taskResult === 'function', '');
  t.requires('标准真源齐备：standards.default 的深度/速度三格与 nearRatio / digits 均为有限数',
    ['depth', 'speed'].every(k => STD.default[k] &&
      ['typical', 'upperDev', 'lowerDev'].every(f => Number.isFinite(STD.default[k][f]))) &&
    Number.isFinite(STD.nearRatio) && Number.isFinite(STD.digits),
    `digits=${STD.digits} nearRatio=${STD.nearRatio}`);
  const symExact = t.requires('用例前提：对称带的临近带宽恰为整数格（值级"等号"用例才成立）',
    Math.abs(symB.tol - symB.k * GRID) < 1e-9,
    `对称带 [${symB.lower}, ${symB.upper}] 跨度 ${symB.upper - symB.lower} ⇒ 带宽 ${symB.tol} = ${symB.k} 格`);

  /* ① 上下限导出（FR-3.18：上限＝典型值＋上偏差、下限＝典型值＋下偏差） */
  const limD = judgeSvc.limits({ depth: dSpec });
  const limS = judgeSvc.limits({ speed: sSpec });
  t.check('FR-3.18 深度上下限＝典型值＋上偏差／下偏差（导出值，典型值不参与判定）',
    !!judgeOk && limD.depth && limD.depth.upper === standardSvc.round2(dSpec.typical + dSpec.upperDev) &&
    limD.depth.lower === standardSvc.round2(dSpec.typical + dSpec.lowerDev),
    `实测上限 ${limD.depth && limD.depth.upper}、下限 ${limD.depth && limD.depth.lower}` +
    `（配置典型值 ${dSpec.typical}、上偏差 ${dSpec.upperDev}、下偏差 ${dSpec.lowerDev}）`);
  t.check('FR-3.18 速度上下限＝典型值＋上偏差／下偏差（同口径）',
    !!judgeOk && limS.speed && limS.speed.upper === standardSvc.round2(sSpec.typical + sSpec.upperDev) &&
    limS.speed.lower === standardSvc.round2(sSpec.typical + sSpec.lowerDev),
    `实测上限 ${limS.speed && limS.speed.upper}、下限 ${limS.speed && limS.speed.lower}`);
  /* 复用证据（而不是"看起来一样"）：DR-03 库行形态与运行期真源形态导出**同一组**上下限，
     且与 `services/standard.js` 的 `absoluteLimits()` 逐值相同 ⇒ 判定引擎没有第二套取数。 */
  const rowForm = { depthTypical: dSpec.typical, depthUpperDev: dSpec.upperDev, depthLowerDev: dSpec.lowerDev,
    speedTypical: sSpec.typical, speedUpperDev: sSpec.upperDev, speedLowerDev: sSpec.lowerDev };
  const limRow = judgeSvc.limits(rowForm);
  const absRow = standardSvc.absoluteLimits(rowForm);
  t.check('上下限取数**复用** services/standard.js：库行形态与运行期形态导出同一组值（非第二套实现）',
    !!judgeOk && ['depth', 'speed'].every(k => limRow[k] && absRow[k] &&
      limRow[k].upper === absRow[k].upper && limRow[k].lower === absRow[k].lower &&
      limRow[k].upper === (k === 'depth' ? limD.depth.upper : limS.speed.upper)),
    `库行形态 ${JSON.stringify(limRow)} vs absoluteLimits ${JSON.stringify(absRow)}`);
  t.check('FR-3.18 必要项缺一即"标准未设定"（导出 null ⇒ 不判定、不预警）',
    judgeSvc.limits({ depth: { typical: dSpec.typical, upperDev: dSpec.upperDev } }).depth === null &&
    judgeSvc.limits({ depth: { unit: dSpec.unit } }).depth === null &&
    judgeSvc.limits({ depth: { typical: dSpec.typical, upperDev: dSpec.upperDev, lowerDev: dSpec.lowerDev } }).depth !== null,
    '半套（缺下偏差）与空套都判未设定；三格齐则给出上下限');

  /* ② 三态与**闭边界**（FR-3.18）—— 每一条都同时给出"判据"与"前一格/后一格"的对照 */
  t.check('FR-3.18 压线不算超范围：实测**恰等于上限** ⇒ ok',
    judgeSvc.standardLevel(dB.upper, dSpec).lv === 'ok',
    `实测 ${dB.upper}（＝上限）、标准带 [${dB.lower}, ${dB.upper}] ⇒ ${judgeSvc.standardLevel(dB.upper, dSpec).lv}`);
  t.check('FR-3.18 压线不算超范围：实测**恰等于下限** ⇒ ok',
    judgeSvc.standardLevel(dB.lower, dSpec).lv === 'ok',
    `实测 ${dB.lower}（＝下限）⇒ ${judgeSvc.standardLevel(dB.lower, dSpec).lv}`);
  const lineWarnings = judgeSvc.buildParamWarnings({ real: { depth: dB.upper, speed: dB.lower }, standard: { depth: dSpec, speed: sSpec } });
  t.check('压线帧不产生任何参数类预警（恰等于上/下限时不进 err、也不进 warn）',
    lineWarnings.length === 1 && lineWarnings[0].lv === 'ok' && !/判(超范围|临近)/.test(lineWarnings[0].detail),
    `压线帧参数类 ${lineWarnings.length} 条：${lineWarnings.map(w => `${w.title}/${w.lv}`).join('、')}`);
  t.check('FR-3.18 临近带**闭边界**：距上限恰等于带宽（' + dB.k + ' 格，值 ' + standardSvc.round2(dB.k * GRID) + '）⇒ warn',
    judgeSvc.standardLevel(standardSvc.round2(dB.upper - dB.k * GRID), dSpec).lv === 'warn',
    `实测 ${standardSvc.round2(dB.upper - dB.k * GRID)} 距上限 ${dB.k} 格（带宽 ${dB.tol} ⇒ ${dB.k} 格）⇒ ` +
    `${judgeSvc.standardLevel(standardSvc.round2(dB.upper - dB.k * GRID), dSpec).lv}`);
  t.check('FR-3.18 临近带**再外一格**（' + (dB.k + 1) + ' 格）⇒ ok（不得把带宽放大一格）',
    judgeSvc.standardLevel(standardSvc.round2(dB.upper - (dB.k + 1) * GRID), dSpec).lv === 'ok',
    `实测 ${standardSvc.round2(dB.upper - (dB.k + 1) * GRID)} 距上限 ${dB.k + 1} 格 ⇒ ` +
    `${judgeSvc.standardLevel(standardSvc.round2(dB.upper - (dB.k + 1) * GRID), dSpec).lv}`);
  t.check('FR-3.18 值级等号（带宽恰为整数格）：实测距上限**恰等于** (上限−下限)×nearRatio ⇒ warn',
    symExact && judgeSvc.standardLevel(standardSvc.round2(symB.upper - symB.tol), symSpec).lv === 'warn',
    symExact ? `实测 ${standardSvc.round2(symB.upper - symB.tol)}（＝上限 ${symB.upper} − 带宽 ${symB.tol}）⇒ ` +
      `${judgeSvc.standardLevel(standardSvc.round2(symB.upper - symB.tol), symSpec).lv}`
      : '前提不成立（带宽非整数格，本用例无从成立）');
  t.check('FR-3.18 值级等号**再外一格**：距上限＝带宽＋一格 ⇒ ok',
    symExact && judgeSvc.standardLevel(standardSvc.round2(symB.upper - symB.tol - GRID), symSpec).lv === 'ok',
    symExact ? `实测 ${standardSvc.round2(symB.upper - symB.tol - GRID)} ⇒ ` +
      `${judgeSvc.standardLevel(standardSvc.round2(symB.upper - symB.tol - GRID), symSpec).lv}`
      : '前提不成立');
  t.check('FR-3.18 上限外一格 ⇒ err（超范围）',
    judgeSvc.standardLevel(standardSvc.round2(dB.upper + GRID), dSpec).lv === 'err' &&
    judgeSvc.standardLevel(standardSvc.round2(sB.upper + GRID), sSpec).lv === 'err',
    `深度 ${standardSvc.round2(dB.upper + GRID)}（上限 ${dB.upper}）、速度 ${standardSvc.round2(sB.upper + GRID)}（上限 ${sB.upper}）均判 err`);
  t.check('FR-3.18 下限外一格 ⇒ err（下侧与上侧同规则）',
    judgeSvc.standardLevel(standardSvc.round2(dB.lower - GRID), dSpec).lv === 'err',
    `实测 ${standardSvc.round2(dB.lower - GRID)}（下限 ${dB.lower}）⇒ ${judgeSvc.standardLevel(standardSvc.round2(dB.lower - GRID), dSpec).lv}`);
  t.check('FR-3.18 三态区间上下对称：同距离格数的上/下侧判到同一个态',
    [0, 1, 2, dB.k, dB.k + 1, dB.k + 5].every(n =>
      judgeSvc.standardLevel(standardSvc.round2(dB.upper - n * GRID), dSpec).lv ===
      judgeSvc.standardLevel(standardSvc.round2(dB.lower + n * GRID), dSpec).lv),
    `上侧与下侧各取 ${[0, 1, 2, dB.k, dB.k + 1, dB.k + 5].join('/')} 格：` +
    [0, 1, 2, dB.k, dB.k + 1, dB.k + 5].map(n =>
      `${n}格→${judgeSvc.standardLevel(standardSvc.round2(dB.upper - n * GRID), dSpec).lv}`).join('、'));

  /* ③ idle（标准未设定 / 实测缺测）—— 不得误判成合格或超范围 */
  t.check('idle：标准未设定（典型值缺失）⇒ 不判合格、不判超范围',
    judgeSvc.standardLevel(dB.upper, { unit: dSpec.unit }).lv === 'idle' &&
    judgeSvc.standardLevel(0, null).lv === 'idle',
    'spec 缺三格 ⇒ idle（与"实测恰在标准外"无关，判据本身不成立）');
  t.check('idle：实测缺测（NaN / null / undefined / 字符串）⇒ idle',
    [NaN, null, undefined, '5.00'].every(v => judgeSvc.standardLevel(v, dSpec).lv === 'idle'),
    '非有限数一律不判定（含字符串，避免"看着像数"就判）');
  t.check('C-84④ 相机参数不参与判定：把帧率/增益/快门塞进实测与标准也不改变参数类结论',
    (() => {
      const base = { real: { depth: dB.upper + GRID, speed: sSpec.typical }, standard: { depth: dSpec, speed: sSpec } };
      const withCam = { real: Object.assign({}, base.real, { fps: 999, gain: 9.9, shutter: 1, cameraDepth: 99 }),
        standard: Object.assign({}, base.standard, { fps: { typical: 400, upperDev: 1, lowerDev: -1 } }) };
      const a = judgeSvc.buildParamWarnings(base), b = judgeSvc.buildParamWarnings(withCam);
      return a.length === b.length && a.every((w, i) => w.title === b[i].title && w.lv === b[i].lv && w.detail === b[i].detail);
    })(),
    `判定对象恰为 [${judgeSvc.PARAMS.join(', ')}]（相机参数既不出条、也不改判据）`);
}

/* ---------------- 八、单任务五态（FR-3.13） ----------------
   "待复检"的进入条件是本实现的选择：需求 FR-3.13 只列出五个状态、**全篇未定义进入规则**
   （FR-4.9 只说"复检数＝当班进入复检流程的任务数"，DR-05 只有"复检次数"）。
   本实现选择"**我方判定依据不成立（标准未设定 / 实测缺测）时进复检**"，理由：
     ① FR-3.18/C-93 与 FR-5.8 明写"标准未设定 ⇒ 不判定、不预警" ⇒ 此时既不能判合格也不能判不合格，
        必须有一个显式待处理状态（否则默认成合格＝伪造判定）；
     ② FR-3.19 允许现场补录标准 ⇒ 补录后可**不重测**直接复判，正是"复检"语义；
     ③ 实测缺测同理（拿不到实测值就判不了）。
   **临近（warn）不进复检**：FR-3.14 只规定"黄=临近"高亮，红才是"超标" ⇒ 临近仍判合格。
   ⚠ 若负责人日后要求"临近即复检"，只需改 `judge.taskResult()` 一处（本包只报告，不代替拍板）。 */
t.section('八、单任务五态：待测试 / 测试中 / 合格 / 不合格 / 待复检（FR-3.13）');
{
  const STD = cfg.standards;
  const GRID = 1 / Math.pow(10, STD.digits);
  const dSpec = STD.default.depth;
  const sSpec = STD.default.speed;
  const upper = standardSvc.round2(dSpec.typical + dSpec.upperDev);
  const lower = standardSvc.round2(dSpec.typical + dSpec.lowerDev);
  const tol = (upper - lower) * STD.nearRatio;
  const k = Math.max(1, Math.ceil(tol / GRID - 1e-9));
  const nearVal = standardSvc.round2(upper - k * GRID);          // 上侧临近带的闭边界
  const std = { depth: dSpec, speed: sSpec };
  const okReal = { depth: dSpec.typical, speed: sSpec.typical };
  const idlish = { depth: { unit: dSpec.unit }, speed: { unit: sSpec.unit } };
  const T = input => judgeSvc.taskResult(input);

  t.check('FR-3.13 待测试：进度 0（未开工）⇒ 待测试',
    T({ progress: 0, real: okReal, standard: std }).result === '待测试' &&
    T({ progress: undefined, real: okReal, standard: std }).result === '待测试' &&
    T({ progress: null, real: okReal, standard: std }).result === '待测试',
    'progress 0 / undefined / null ⇒ 待测试（判定不成立时不得凭空给出结论）');
  t.check('FR-3.13 测试中：0 < 进度 < 1 ⇒ 测试中（含 1 之前的最后一个刻度）',
    T({ progress: 0.01, real: okReal, standard: std }).result === '测试中' &&
    T({ progress: 0.5, real: okReal, standard: std }).result === '测试中' &&
    T({ progress: 0.9999, real: okReal, standard: std }).result === '测试中',
    '进度未到 100% 一律"测试中"（不提前给判定结论）');
  t.check('FR-3.13 合格：进度 1（可判定）且深度/速度都在标准闭区间内 ⇒ 合格',
    T({ progress: 1, real: okReal, standard: std }).result === '合格',
    `实测 深度 ${okReal.depth}、速度 ${okReal.speed}；标准带 [${lower}, ${upper}]`);
  t.check('FR-3.13 合格（压线边界）：实测恰等于上限 ⇒ 合格（压线不算超范围）',
    T({ progress: 1, real: { depth: upper, speed: sSpec.typical }, standard: std }).result === '合格',
    `深度 ${upper}（＝上限）⇒ ${T({ progress: 1, real: { depth: upper, speed: sSpec.typical }, standard: std }).result}`);
  t.check('FR-3.13 合格（临近不改变结论）：实测落临近带 ⇒ 仍合格，但会出「参数阈值临近预警」',
    T({ progress: 1, real: { depth: nearVal, speed: sSpec.typical }, standard: std }).result === '合格' &&
    judgeSvc.buildParamWarnings({ real: { depth: nearVal, speed: sSpec.typical }, standard: std })
      .some(w => w.title === '参数阈值临近预警' && w.lv === 'warn'),
    `深度 ${nearVal} ⇒ ${T({ progress: 1, real: { depth: nearVal, speed: sSpec.typical }, standard: std }).result}` +
    '（黄=临近只高亮＋联动预警，红=超标才不合格）');
  t.check('FR-3.13 不合格：进度 1 且任一参数超范围 ⇒ 不合格',
    T({ progress: 1, real: { depth: standardSvc.round2(upper + GRID), speed: sSpec.typical }, standard: std }).result === '不合格' &&
    T({ progress: 1, real: { depth: sSpec.typical, speed: standardSvc.round2(sSpec.typical + sSpec.upperDev + GRID) }, standard: std }).result === '不合格',
    '深度越上限、速度越上限各自都能单独判"不合格"');
  const retest = T({ progress: 1, real: okReal, standard: idlish });
  t.check('FR-3.13 待复检：标准未设定（必要项缺失）⇒ 待复检（不得默认成合格）',
    retest.result === '待复检' &&
    retest.undetermined.length === 2 &&
    retest.undetermined.every(u => u.why === '标准未设定'),
    `${retest.result} —— ${retest.reason}`);
  const missing = T({ progress: 1, real: { depth: NaN, speed: sSpec.typical }, standard: std });
  t.check('FR-3.13 待复检：实测缺测（单参数 NaN）⇒ 待复检，且只有缺测的那个参数未判定',
    missing.result === '待复检' && missing.undetermined.length === 1 &&
    missing.undetermined[0].kind === 'depth' && missing.undetermined[0].why === '实测缺测',
    `${missing.result} —— ${missing.reason}`);
  t.check('FR-3.13/FR-3.14 判定对象只有深度与速度：五态产物里不含任何相机参数',
    ['depth', 'speed'].every(kind => T({ progress: 1, real: okReal, standard: std })
      .levels.some(l => l.kind === kind)) &&
    T({ progress: 1, real: okReal, standard: std }).levels.length === 2 &&
    T({ progress: 1, real: Object.assign({}, okReal, { fps: 1, gain: 1, cameraDepth: 1 }), standard: std })
      .levels.length === 2,
    'levels 恰两项（深度/速度）；往实测里塞相机参数也不进判定');
}

/* ---------------- 九、跨实现对账：服务端 judge ≡ 前端 mockData ----------------
   为什么必须对账：`src/services/mockData.js` 的判定/预警是**浏览器侧的第二份同类实现**
   （演示用，本包一行不得改），服务端 `judge.js` 是**权威实现**；两份一旦分叉，现场看到的
   三态/预警与上报 MES 的口径就会各说各话。本段用**同一组输入序列**（16 组＝`CASES`：正常 / 临近 /
   超范围 / 压线（上、下）/ 临近带外一格 / 同态 err / 同态 warn / 混态 / idle / 缺测 /
   跨零点班次 / 单参数 idle / 工单超时 / 耗材更换 / 班初）逐条比对。
   前端侧走**真路径**：只写运行时真源 `state.task.standard` / `state.task.real` 后 `tick()`
   （冻结 `Math.random` ⇒ 实测值确定，不靠随机命中）；服务端侧把**前端回读的同一组输入**
   （实测值、标准、now、耗材累计时长、应完成件数、已完成件数）喂给 `judge.buildWarnings()`。
   **比较规则**（选定理由随附）：
     ① 硬判据 ＝ 逐条、按序、**逐字**相等：**条数 / 顺序 / 名称 / 等级** —— 这是 C-88
        「名称与等级色一一对应」与「同态独立成条」的载体，容不得任何格式宽松；
     ② **参与参数**＝每条 detail 中出现的参数名个数（深度/速度），两侧必须相等（参数错配即红）；
     ③ detail 的**数值与单位**：按"数值多重集（容差半格 0.005）＋ 单位记号多重集"比对，
        **允许格式微差**（空格 / 连接符 / 全半角 / 千分位等）—— 需求只规定判据数值与单位表述、
        不规定文案排版；容差取半格，是因为显示精度为两位小数（0.01），小于半格不可能是有意差异；
     ④ **加严项（非需求要求，本实现下已成立）**：detail 全文**逐字一致**，另立一条断言钉住，
        将来任一侧文案单改会立刻变红，提示口径漂移。
      ⑤ **本节的对账边界（2026-09-30 T2 复核补齐，防被读成「前后端全口径一致」）**：本段只对账
         **「同一组入参下两侧判定函数一致」**（条数 / 顺序 / 名称 / 等级 / 参与参数 / 数值 / 单位 / 逐字），
         **不覆盖服务端 `shouldDoneOf()` / `doneQtyOf()` 的派生** —— 本段是把前端回读的
         「应完成 / 已完成」**同一组入参**喂给服务端判据，两个减数**怎么算出来的**不在本段射程内。
         两侧减数的取数口径**本就不同**（**不是同源**）：
           · **生产口径（权威）**：应完成 ＝ 节拍 ×（采集时刻 − **工单计划开工时刻**），起算点取
             `task.plan_start_time`（＝ IF-A.1 `planStartTime`；`server/index.js` 的 `shouldDoneOf()`）
             —— 负责人 2026-09-30 裁定「应完成起算点＝工单计划开工时刻」（需求将按 V1.40 / C-109 补句）；
           · **前端演示口径（近似）**：应完成 ＝ 节拍 × **班次已进行秒数**
             （`src/services/mockData.js` 的 `state.shift.elapsed`）—— 这是**演示近似**，
             因为演示数据里没有工单计划开工时刻；**不得**读成两侧同源。
         另有一处**真源缺口**由本段末尾的静态断言登记：`doneQtyOf()` 的唯一真源 `result` 表
         在 `server\` 下**当前没有任何写入点** ⇒ 服务端侧"已完成件数"恒为 0。
   输入序列的实测值都取在前端演示 clamps 内（深度 [4.77,5.33]、vx [4.78,5.22]，速度由 vx/vy 合成），
   否则前端 `tick()` 会把值夹回去，"同一组输入"就不成立（这也是本段所有取值都由配置推导的原因）。 */
t.section('九、跨实现对账：服务端 judge ≡ 前端 mockData（用例集见 CASES，逐组逐条比对）');
{
  const STD = cfg.standards;
  const GRID = 1 / Math.pow(10, STD.digits);
  const r2 = standardSvc.round2;
  const dSpec = STD.default.depth;
  const sSpec = STD.default.speed;
  const bandOf = spec => {
    const upper = r2(spec.typical + spec.upperDev);
    const lower = r2(spec.typical + spec.lowerDev);
    const tol = (upper - lower) * STD.nearRatio;
    return { upper, lower, tol, k: Math.max(1, Math.ceil(tol / GRID - 1e-9)) };
  };
  const dB = bandOf(dSpec);
  const sB = bandOf(sSpec);
  /** 量程下沿 + 3 格、偏差 ±1 格 ⇒ 导出上下限远低于实测 ⇒ 必为超范围（落在量程内的合法行） */
  const errSpec = kind => ({ unit: kind === 'depth' ? 'm' : 'm/s', digits: STD.digits,
    typical: STD.range[kind].min + 3 * GRID, upperDev: GRID, lowerDev: -GRID });

  const CASES = [
    { id: 'C01', name: '正常（两参数均 ok）', fe: 'default', iso: '2026-09-18T15:30:00',
      depth: dSpec.typical, speed: sSpec.typical, standard: { depth: dSpec, speed: sSpec } },
    { id: 'C02', name: '深度临近（距上限恰等于带宽 ' + dB.k + ' 格）', fe: 'default', iso: '2026-09-18T15:30:01',
      depth: r2(dB.upper - dB.k * GRID), speed: sSpec.typical, standard: { depth: dSpec, speed: sSpec } },
    { id: 'C03', name: '深度超范围（上限外一格）', fe: 'default', iso: '2026-09-18T15:30:02',
      depth: r2(dB.upper + GRID), speed: sSpec.typical, standard: { depth: dSpec, speed: sSpec } },
    { id: 'C04', name: '压线（实测恰等于上限）', fe: 'default', iso: '2026-09-18T15:30:03',
      depth: dB.upper, speed: sSpec.typical, standard: { depth: dSpec, speed: sSpec } },
    { id: 'C05', name: '压线（实测恰等于下限）', fe: 'default', iso: '2026-09-18T15:30:04',
      depth: dB.lower, speed: sSpec.typical, standard: { depth: dSpec, speed: sSpec } },
    { id: 'C06', name: '临近带外一格（' + (dB.k + 1) + ' 格 ⇒ ok）', fe: 'default', iso: '2026-09-18T15:30:05',
      depth: r2(dB.upper - (dB.k + 1) * GRID), speed: sSpec.typical, standard: { depth: dSpec, speed: sSpec } },
    { id: 'C07', name: '同态 err（深/速同时超范围）', fe: 'default', iso: '2026-09-18T15:30:06',
      depth: dSpec.typical, speed: sSpec.typical, standard: { depth: errSpec('depth'), speed: errSpec('speed') } },
    { id: 'C08', name: '同态 warn（深/速同时临近）', fe: 'default', iso: '2026-09-18T15:30:07',
      depth: r2(dB.upper - dB.k * GRID), speed: r2(sB.upper - sB.k * GRID),
      standard: { depth: dSpec, speed: sSpec } },
    { id: 'C09', name: '混态（深度临近 + 速度超范围）', fe: 'default', iso: '2026-09-18T15:30:08',
      depth: r2(dB.upper - dB.k * GRID), speed: sSpec.typical,
      standard: { depth: dSpec, speed: errSpec('speed') } },
    { id: 'C10', name: 'idle（两参数标准均未设定）', fe: 'default', iso: '2026-09-18T15:30:09',
      depth: dSpec.typical, speed: sSpec.typical,
      standard: { depth: { unit: dSpec.unit }, speed: { unit: sSpec.unit } } },
    { id: 'C11', name: '缺测（深度实测缺失 ⇒ idle，速度临近）', fe: 'default', iso: '2026-09-18T15:30:10',
      depth: NaN, speed: r2(sB.upper - sB.k * GRID), standard: { depth: dSpec, speed: sSpec } },
    { id: 'C12', name: '跨零点班次（22→6 的 03:00，深度临近）', fe: 'night', iso: '2026-09-20T03:00:00',
      depth: r2(dB.upper - dB.k * GRID), speed: sSpec.typical, standard: { depth: dSpec, speed: sSpec } },
    { id: 'C13', name: '单参数 idle（深度未设定）+ 速度正常', fe: 'default', iso: '2026-09-18T15:30:12',
      depth: dSpec.typical, speed: sSpec.typical,
      standard: { depth: { unit: dSpec.unit }, speed: sSpec } },
    { id: 'C14', name: '工单超时（实际产出慢于计划 ⇒ 进度落后率 > 配置阈值）', fe: 'lag', iso: '2026-09-18T15:30:30',
      depth: dSpec.typical, speed: sSpec.typical, standard: { depth: dSpec, speed: sSpec } },
    { id: 'C15', name: '耗材更换（点亮时长 > 配置阈值）', fe: 'default', iso: '2026-09-18T12:00:00',
      depth: dSpec.typical, speed: sSpec.typical, standard: { depth: dSpec, speed: sSpec } },
    /* 班初现场（**同一"产出落后"实例**）：应完成仍为 0 ⇒ 工单**不得**因落后而误报；
       已完成 0 ⇒ 点亮时长停在基准、低于更换阈值 ⇒ 耗材 ok 分支由此构造 */
    { id: 'C16', name: '班初（落后实例但应完成 0 ⇒ 工单 ok；点亮时长 < 阈值 ⇒ 耗材 ok）', fe: 'lag', iso: '2026-09-18T00:00:30',
      depth: dSpec.typical, speed: sSpec.typical, standard: { depth: dSpec, speed: sSpec } }
  ];
  const NIGHT1 = [{ name: '夜班', start: 22, end: 6 }];
  /* 工单超时用例要一个**真的落后**的现场：FR-5.11 判据比较"应完成 / 已完成"，而演示数据的已完成
     由节拍推导 ⇒ 只有把演示旋钮 `outputRatio` 调低（实际产出慢于计划）才构造得出落后的
     工单进度。取 0.6 使落后率落进 (阈值率, 件数门槛] 区间 —— 即**必须**由比率门槛判 err，
     件数门槛（80 件）此时不成立，这样"比率门槛真的在起作用"才有证据，而不是靠件数兜底
     （旋钮同样是加载期快照 ⇒ 必须在加载前覆盖，只改内存、不落盘）。
     ⚠ 该旋钮**不是配置真源里的参数**（2026-09-30 负责人裁定 B：它只被 `src\services\mockData.js`
     读取，已从 `board.config.js` 移出）⇒ 本用例的注入方式是"往**内存沙箱**的配置对象上写一个
     mockData 认得的键"，**不得**写成"该键必须存在于 board.config"的断言。 */
  const LAG_RATIO = 0.6;

  let FE = null;
  const feOk = t.requires('对账前提：前端三实例可加载（默认班次 / 跨零点班次 / 产出落后）且能冻结随机走帧',
    (() => {
      try {
        FE = {
          default: loadFrontEnd(cfg.shift.list.slice()),
          night: loadFrontEnd(NIGHT1),
          lag: loadFrontEnd(cfg.shift.list.slice(), { outputRatio: LAG_RATIO })
        };
        return ['default', 'night', 'lag'].every(k => FE[k] && typeof FE[k].freezeTick === 'function');
      } catch (e) { return false; }
    })(), '');
  t.requires('对账前提：用例序列 ≥ 10 组，且覆盖 压线/同态/混态/idle/缺测/跨零点班次',
    CASES.length >= 10 &&
    ['C04', 'C05', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12'].every(id => CASES.some(c => c.id === id)),
    `本次 ${CASES.length} 组`);

  /** 逐条比对（规则见本节标题下的 ①②③）→ 返回不一致清单（空数组＝逐条一致） */
  const numTokens = s => (String(s).match(/-?\d+(?:\.\d+)?/g) || []).map(Number).sort((a, b) => a - b);
  const unitTokens = s => (String(s).match(/m\/s|m|h|件|天|%/g) || []).slice().sort();
  const paramCount = s => ['深度', '速度'].filter(n => String(s).includes(n)).length;
  const sameNums = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= GRID / 2);
  const compareWarnings = (fe, sv) => {
    const bad = [];
    if (fe.length !== sv.length) bad.push(`条数 ${fe.length} ≠ ${sv.length}`);
    for (let i = 0; i < Math.min(fe.length, sv.length); i++) {
      if (fe[i].title !== sv[i].title) bad.push(`[${i + 1}] 名称「${fe[i].title}」≠「${sv[i].title}」`);
      if (fe[i].lv !== sv[i].lv) bad.push(`[${i + 1}] 等级 ${fe[i].lv} ≠ ${sv[i].lv}`);
      if (paramCount(fe[i].detail) !== paramCount(sv[i].detail)) {
        bad.push(`[${i + 1}] 参与参数个数 ${paramCount(fe[i].detail)} ≠ ${paramCount(sv[i].detail)}`);
      }
      if (!sameNums(numTokens(fe[i].detail), numTokens(sv[i].detail))) {
        bad.push(`[${i + 1}] detail 数值集 [${numTokens(fe[i].detail)}] ≠ [${numTokens(sv[i].detail)}]`);
      }
      if (unitTokens(fe[i].detail).join('|') !== unitTokens(sv[i].detail).join('|')) {
        bad.push(`[${i + 1}] detail 单位集 [${unitTokens(fe[i].detail)}] ≠ [${unitTokens(sv[i].detail)}]`);
      }
    }
    return bad;
  };

  const rows = [];
  if (feOk) {
    for (const c of CASES) {
      const fe = FE[c.fe].freezeTick(c.iso, c.standard, { depth: c.depth, speed: c.speed });
      /* FR-5.11 新判据：服务端要的是"应完成 / 已完成"两个量，**必须取前端回读的同一组现场**
         （节拍两侧同源＝production.cycleSec；前端应完成＝floor(shift.elapsed / cycleSec)）。 */
      const sv = judgeSvc.buildWarnings({ now: c.iso, real: fe.real, standard: c.standard,
        consumableHours: fe.ctx.lampHours,
        shouldDone: Math.floor(fe.ctx.shiftElapsed / (cfg.production.cycleSec || 160)),
        doneQty: fe.ctx.done });
      const mst = judgeSvc.maintenanceState(c.iso);
      rows.push({
        c, fe, sv, bad: compareWarnings(fe.warnings, sv),
        lvSame: ['depth', 'speed'].every((kind, i) =>
          judgeSvc.standardLevel(fe.real[kind], judgeSvc.specOf(c.standard, kind)).lv === fe.levels[i].lv.lv),
        ctxSame: mst.daysLeft === fe.ctx.maintDaysLeft && mst.next === fe.ctx.maintNext
      });
    }
    for (const r of rows) {
      t.check(`九 · ${r.c.id} ${r.c.name}：服务端 judge ≡ 前端 mockData（条数/顺序/名称/等级/参与参数/数值/单位）`,
        r.bad.length === 0 && r.fe.warnings.length >= 3 && r.sv.length >= 3,
        r.bad.length ? `不一致：${r.bad.join('；')}` :
          `两侧 ${r.sv.length} 条逐条一致：${r.sv.map(x => `${x.title}/${x.lv}`).join(' ｜ ')}` +
          `（前端回读 深度 ${r.fe.real.depth}、速度 ${r.fe.real.speed}；三态一致 ${r.lvSame ? '✓' : '✗'}；` +
          `维保日期推导一致 ${r.ctxSame ? '✓' : '✗'}）`);
    }
    t.check(`九 · 三态判据逐参数一致（服务端 standardLevel ≡ 前端 standardLevel，${rows.length} 组 × 2 参数）`,
      rows.every(r => r.lvSame),
      rows.filter(r => !r.lvSame).map(r => r.c.id).join('、') || `${rows.length * 2} 个参数点全部一致`);
    t.check('九 · 维保剩余天数与下次维保日期的推导两侧一致（含跨零点班次用例）',
      rows.every(r => r.ctxSame),
      rows.filter(r => !r.ctxSame).map(r => r.c.id).join('、') || `${rows.length} 组一致的 (daysLeft, next)`);
    t.check('九 · 加严项（非需求要求）：detail 全文**逐字**一致（任一侧文案单改即红）',
      rows.every(r => r.fe.warnings.length === r.sv.length &&
        r.fe.warnings.every((w, i) => w.detail === r.sv[i].detail)),
      rows.filter(r => r.fe.warnings.some((w, i) => !r.sv[i] || w.detail !== r.sv[i].detail))
        .map(r => r.c.id).join('、') || `${rows.length}/${rows.length} 组 detail 逐字相同`);

    /* C-88 定向断言（在**确实构造出来的**形态上判，不是"碰巧扫到某帧"）：
       同态 ⇒ 每个参数各一条、共 2 条、每条只含一个参数、且不得用「；」拼接两参数。
       参数类的识别口径＝**建表顺序**（参数类在前，其后固定 3 条：维保 / 耗材 / 工单），
       **不拿被测的名称当筛子**（否则改名后连"哪条是参数类"都判不出）。 */
    const paramRows = warnings => warnings.slice(0, Math.max(0, warnings.length - 3));
    const oneParamEach = warnings => paramRows(warnings).every(w =>
      paramCount(w.detail) === 1 && !String(w.detail).includes('；'));
    const sameErr = rows.find(r => r.c.id === 'C07');
    const sameWarn = rows.find(r => r.c.id === 'C08');
    const mixed = rows.find(r => r.c.id === 'C09');
    t.check('C-88/R26-P2-2 同态 err（深/速同超范围）⇒ 参数类**恰 2 条**、名称/等级均「参数超范围预警」/err、每条只含一个参数',
      !!sameErr && paramRows(sameErr.sv).length === 2 &&
      paramRows(sameErr.sv).every(w => w.title === '参数超范围预警' && w.lv === 'err') && oneParamEach(sameErr.sv),
      sameErr ? `参数类 ${paramRows(sameErr.sv).length} 条：` + paramRows(sameErr.sv).map(w => `${w.title}/${w.lv}｜${w.detail}`).join(' ／ ') : '用例缺失');
    t.check('C-88/R26-P2-2 同态 warn（深/速同临近）⇒ 参数类**恰 2 条**、名称/等级均「参数阈值临近预警」/warn、每条只含一个参数',
      !!sameWarn && paramRows(sameWarn.sv).length === 2 &&
      paramRows(sameWarn.sv).every(w => w.title === '参数阈值临近预警' && w.lv === 'warn') && oneParamEach(sameWarn.sv),
      sameWarn ? `参数类 ${paramRows(sameWarn.sv).length} 条：` + paramRows(sameWarn.sv).map(w => `${w.title}/${w.lv}｜${w.detail}`).join(' ／ ') : '用例缺失');
    t.check('C-88 混态（深度临近 + 速度超范围）⇒ 恰 2 条、名称与等级色一一对应（err 在前）、每条只含一个参数',
      !!mixed && paramRows(mixed.sv).length === 2 && oneParamEach(mixed.sv) &&
      paramRows(mixed.sv)[0].title === '参数超范围预警' && paramRows(mixed.sv)[0].lv === 'err' &&
      paramRows(mixed.sv)[1].title === '参数阈值临近预警' && paramRows(mixed.sv)[1].lv === 'warn',
      mixed ? `参数类 ${paramRows(mixed.sv).length} 条：` + paramRows(mixed.sv).map(w => `${w.title}/${w.lv}`).join('、') : '用例缺失');
    t.check('C-88 参数类**上界**（一个参数最多一条）：全部用例的参数类条数 ∈ {0,1,2}，且预警合计 ≤ 5 条',
      rows.every(r => paramRows(r.sv).length <= 2 && r.sv.length <= 5),
      rows.map(r => `${r.c.id}:${paramRows(r.sv).length}+3`).join(' '));
    const idleRow = rows.find(r => r.c.id === 'C10');
    const oneIdle = rows.find(r => r.c.id === 'C13');
    t.check('idle 不误判：标准全未设定 ⇒ 参数类 **0 条**（不得默认成合格/超范围）',
      !!idleRow && paramRows(idleRow.sv).length === 0,
      idleRow ? `C10 参数类 ${paramRows(idleRow.sv).length} 条（预警合计 ${idleRow.sv.length} 条＝固定 3 条）` : '用例缺失');
    t.check('idle 不误判：单参数标准未设定 ⇒ 该参数**不进任何一条**（仅另一参数成条/汇总）',
      !!oneIdle && paramRows(oneIdle.sv).length === 1 && paramCount(paramRows(oneIdle.sv)[0].detail) === 1 &&
      !String(paramRows(oneIdle.sv)[0].detail).includes('深度'),
      oneIdle ? `C13 参数类 ${paramRows(oneIdle.sv).length} 条：${paramRows(oneIdle.sv)[0].detail}` : '用例缺失');
    /* 覆盖度证据（2026-09-30 T2 独立复核后**重写标题并逐分支指名构造者**）。
       原标题写的是"维保 / 耗材 / 工单三类预警的 warn|ok|err 分支均被真实构造出来"——**表述过强**：
       实测（下方 detail 打印的等级集合，逐组实测值见回执 T-20260930-01）——
         · 维保：实现只有 warn|ok 两态（无 err），本用例集 16 组**全部 warn**（ok 分支未构造）；
         · 耗材：只有 warn|ok 两态（无 err），warn 由 C01～C15 构造、**ok 仅由 C16 构造**；
         · 工单：只有 ok|err 两态（**实现无 warn 态**），ok 由 C01～C13/C15/C16 构造、
           **err 仅由 C14 构造**，且 C14 必须由**比率门槛**（不是件数兜底）判成立。
       故本断言改为只钉**确实可达且已构造**的分支，并把"不可达/未构造"的分支写进 detail，
       避免后来者按标题误以为 9 个组合都被验过（D19：断言只证明它自己说的那件事）。 */
    const otherLv = title => rows.map(r => (r.sv.find(w => w.title === title) || {}).lv);
    const rowOf = id => rows.find(r => r.c.id === id) || {};
    const lvInFE = (row, title) => (row.fe ? (row.fe.warnings.find(w => w.title === title) || {}).lv : null);
    const lvInSV = (row, title) => (row.sv ? (row.sv.find(w => w.title === title) || {}).lv : null);
    const detailInSV = (row, title) => (row.sv ? (row.sv.find(w => w.title === title) || {}).detail : undefined);
    t.check('九 · 用例覆盖度（逐分支指名构造者）：维保 warn／耗材 warn＋ok／工单 err＋ok 都被**真实构造**，' +
      '且标注了不可达分支（维保·耗材无 err；工单无 warn）',
      otherLv('设备维保到期预警').includes('warn') &&
      otherLv('耗材更换预警').includes('warn') && otherLv('耗材更换预警').includes('ok') &&
      otherLv('工单超时预警').includes('err') && otherLv('工单超时预警').includes('ok') &&
      /* 逐分支指名：ok 与 err 必须落在**具体用例**上，不是"某处恰好有一条" */
      lvInSV(rowOf('C16'), '耗材更换预警') === 'ok' &&
      lvInSV(rowOf('C14'), '工单超时预警') === 'err' &&
      lvInSV(rowOf('C16'), '工单超时预警') === 'ok',
      `维保[${[...new Set(otherLv('设备维保到期预警'))]}]（实现无 err 态、ok 未构造）` +
      ` 耗材[${[...new Set(otherLv('耗材更换预警'))]}]（实现无 err 态；ok 仅 C16）` +
      ` 工单[${[...new Set(otherLv('工单超时预警'))]}]（实现无 warn 态；err 仅 C14、ok 见 C01～C13/C15/C16）`);

    /* C14：**唯一**构造「工单超时」err 的现场。本断言钉住"这个 err 只能来自**比率门槛**"——
       数值全部**现场算出**（不写死）：应完成＝floor(前端回读的班次已进行秒数 ÷ 节拍)、
       已完成＝前端回读的 done（与喂给服务端的是同一组，见上面 §九 的对账口径）。
       ⇒ 判据若退回"队列件数 > 阈值"或比率门槛失效，本用例当场由 err 变 ok、本断言**指名**变红。 */
    const CYC = cfg.production.cycleSec || 160;
    const c14 = rowOf('C14');
    const c14Should = c14.fe ? Math.floor(c14.fe.ctx.shiftElapsed / CYC) : -1;
    const c14Done = c14.fe ? c14.fe.ctx.done : -1;
    const c14Behind = c14Should - c14Done;
    const c14Ratio = c14Should > 0 ? c14Behind / c14Should : 0;
    t.check('九 · C14（实际产出慢于计划）真构造「工单超时」err：判据**只可能**由比率门槛产生' +
      '（落后件数 ≤ 件数门槛 ⇒ 兜底门槛不成立），两侧 detail 的落后率与实算一致',
      c14Should > 0 && c14Done >= 0 && c14Ratio > cfg.warnings.orderOverdueRatio &&
      c14Behind <= cfg.warnings.orderOverduePending &&
      lvInSV(c14, '工单超时预警') === 'err' && lvInFE(c14, '工单超时预警') === 'err' &&
      String(detailInSV(c14, '工单超时预警')).includes((c14Ratio * 100).toFixed(1)),
      `C14 现场：应完成 ${c14Should} / 已完成 ${c14Done} ⇒ 落后 ${c14Behind} 件（比率 ` +
      `${(c14Ratio * 100).toFixed(1)}% > 阈值率 ${cfg.warnings.orderOverdueRatio}）；件数门槛 ` +
      `${cfg.warnings.orderOverduePending}（${c14Behind} ≤ ${cfg.warnings.orderOverduePending} ⇒ **不成立**）；` +
      `两侧等级 ${lvInFE(c14, '工单超时预警')}/${lvInSV(c14, '工单超时预警')}；detail=${detailInSV(c14, '工单超时预警')}`);

    /* C16：**唯一**构造「耗材 ok」的现场，同时是「班初」现场（应完成 0）——
       C-108 换判据的动因正是"旧口径班初恒真"（见 C-108 的实测记录），故"班初不得误报"必须被钉住。 */
    const c16 = rowOf('C16');
    const c16Should = c16.fe ? Math.floor(c16.fe.ctx.shiftElapsed / CYC) : -1;
    const c16Done = c16.fe ? c16.fe.ctx.done : -1;
    const lampCfg = (cfg.maintenance.consumables || [])[0] || {};
    const c16Lamp = c16.fe ? c16.fe.ctx.lampHours : -1;
    t.check('九 · C16（班初）真构造「应完成 0 ⇒ 工单不得误报（ok）」＋「点亮时长 < 阈值 ⇒ 耗材 ok」' +
      '（本用例集里耗材 ok 的唯一构造者；旧口径下这里必报 err）',
      c16Should === 0 && c16Done === 0 &&
      lvInSV(c16, '工单超时预警') === 'ok' && lvInFE(c16, '工单超时预警') === 'ok' &&
      Number.isFinite(c16Lamp) && c16Lamp <= lampCfg.threshold &&
      lvInSV(c16, '耗材更换预警') === 'ok' && lvInFE(c16, '耗材更换预警') === 'ok',
      `C16 现场（班初）：应完成 ${c16Should} / 已完成 ${c16Done} ⇒ 工单 ` +
      `${lvInFE(c16, '工单超时预警')}/${lvInSV(c16, '工单超时预警')}；点亮 ${c16Lamp} h ≤ 阈值 ` +
      `${lampCfg.threshold} h ⇒ 耗材 ${lvInFE(c16, '耗材更换预警')}/${lvInSV(c16, '耗材更换预警')}`);
    /* 起算点分叉的**登记**（不是断言，不改判据）：本段喂给服务端的是前端回读的减数，
       而生产侧应完成另按 `task.plan_start_time` 起算 ⇒ 这里把两侧口径现场打印出来，
       便于复核者一眼看到"本节对账的是判据、不是取数"。 */
    t.info(`九 · 起算点差异登记（不由本节断言）：前端演示应完成＝floor(班次已进行秒数 ${c14.fe ? c14.fe.ctx.shiftElapsed : '(缺)'} ÷ ${CYC})；` +
      `生产侧应完成＝floor((采集时刻 − task.plan_start_time) ÷ ${CYC})（server/index.js shouldDoneOf）——` +
      `本节只对账「同一组入参下两侧判定函数一致」，取数口径分叉不在此节覆盖范围内`);

    /* 真源缺口**已收口**（T2 2026-09-30 三次对齐；D19「断言只证明它自己说的那件事」）：
       上一轮本条是**缺口登记**（"`server\` 下没有 `result` 表写入点 ⇒ `doneQtyOf()` 恒 0"），
       并在自己的文案里写明："本条变红即表示写入点已实装，必须换成真正的「已完成件数派生」断言"。
       座位 3 已在 `T-20260930-08` 落地写入点：`server\repo\result.js` 的 `upsertJudgement()`
       （唯一写入口，`ON CONFLICT DO UPDATE`），由 `server\index.js` 的 `persistJudgement()` 在
       **1 s 采样落库之后**（`onSampled` 挂钩）按件调用。故本轮**按原话把它换掉**，换成下面三条：
         ① **结构**：写入点确实在（且全仓唯一），`persistJudgement()` 确实调用它；
         ② **委托**：`doneQtyOf()` 把"已完成件数"委托给同一个仓储的 `countDone()`
            （不再自写第二份计数 SQL —— 两份 SQL 就是两个口径）；
         ③ **派生（走真写入点）**：`countDone()` 的数**真的**由 `upsertJudgement()` 写出的行派生
            （合格＋不合格计入、待复检不计、按件幂等、终态不回退、非法结果拒收）。
       ⚠ 禁止用"往 `result` 塞假行"来让关联断言变绿 —— ③ 的写入**全部经真写入点**落进一个
       **独立的内存库**（`node:sqlite` 的 `:memory:` ＋ `server/db` 的 `initSchema()`），
       与任何生产库文件无关，也不构造生产不可达的状态。 */
    const SERVER_JS_FILES = (() => {
      const out = [];
      const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith('.js')) out.push(full);
        }
      };
      walk(path.join(ROOT, 'server'));
      return out;
    })();
    const relOf = f => path.relative(ROOT, f).split(path.sep).join('/');
    const resultWriters = SERVER_JS_FILES.filter(f =>
      /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+result\b/i.test(fs.readFileSync(f, 'utf8')));
    /* 取某函数的**函数体**（从声明处到下一个同级 `  function ` 之前）：只扫这一段，
       避免把文件里别处的同名调用/SQL 当成"这个函数做了那件事"（D19 的口径要精确到函数）。 */
    const bodyOf = (src, decl) => {
      const i = src.indexOf(decl);
      if (i < 0) return null;
      const j = src.indexOf('\n  function ', i + decl.length);
      return src.slice(i, j < 0 ? src.length : j);
    };
    const resultRepo = require(path.join(ROOT, 'server', 'repo', 'result.js'));
    const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    const doneQtyBody = bodyOf(indexSrc, 'function doneQtyOf(');
    const persistBody = bodyOf(indexSrc, 'function persistJudgement(');
    t.check('九 · 真源已收口 ①（**写入点实装**）：`server\\` 下**有** `result` 表写入点 —— ' +
      '`server/repo/result.js` 导出 `upsertJudgement()`（全仓**唯一**含 `INSERT INTO result` 的文件），' +
      '且 `server/index.js` 的 `persistJudgement()` **真的调用**它（不是"有仓储没人用"）',
      resultWriters.length === 1 && relOf(resultWriters[0]) === 'server/repo/result.js' &&
      typeof resultRepo.upsertJudgement === 'function' &&
      Boolean(persistBody) && persistBody.includes('resultRepo.upsertJudgement('),
      `扫描 server\\*.js 共 ${SERVER_JS_FILES.length} 个文件；含 INSERT INTO result 的：` +
      `${resultWriters.map(relOf).join('、') || '无'}；` +
      `repo/result 导出 upsertJudgement=${typeof resultRepo.upsertJudgement}；` +
      `persistJudgement() 调用 resultRepo.upsertJudgement=${Boolean(persistBody && persistBody.includes('resultRepo.upsertJudgement('))}`);
    t.check('九 · 真源已收口 ②（**委托同一口**）：`doneQtyOf()` 把"已完成件数"委托给 `repo/result.js` 的 ' +
      '`countDone()`（`result` 表的读口也只有一处），**不再**在 `server/index.js` 里自写第二份计数 SQL',
      typeof resultRepo.countDone === 'function' &&
      Boolean(doneQtyBody) && doneQtyBody.includes('resultRepo.countDone(') &&
      !/SELECT\s+COUNT/i.test(doneQtyBody),
      `doneQtyOf() 函数体：委托 resultRepo.countDone=${Boolean(doneQtyBody && doneQtyBody.includes('resultRepo.countDone('))}；` +
      `自写 SELECT COUNT=${Boolean(doneQtyBody && /SELECT\s+COUNT/i.test(doneQtyBody))}；` +
      `函数体=${JSON.stringify(String(doneQtyBody || '').replace(/\s+/g, ' ').trim().slice(0, 220))}`);

    /* ③ 走**真写入点**的「已完成件数派生」断言（ADR-0004 D21：期望值构成性推导，不写死）：
       在一个**独立的内存库**上**只经** `upsertJudgement()` 写入三件不同结果的判定
       （第 1 件「合格」、第 2 件「不合格」、第 3 件「待复检」），随后对第 1 件再写一条「测试中」。
       期望由"**写了什么** ＋ `DONE_STATUS`（FR-4.4 的已完成集合真源）"现算：
         · `countDone()` ＝ 写成内容里落在 `DONE_STATUS` 的条数（＝ 合格 ＋ 不合格；**待复检不计**）；
         · `countByTask()` ＝ 写过的**件数**（(工单,件号) 幂等：第 1 件写两次仍是一行）；
         · 第 1 件的结果**不回退**（终态「合格」不被后来的「测试中」改写）、`duration_sec` 取 `MAX`；
         · 第 3 件 `retest_count` ＝ 1（首判即待复检 ⇒ 进入复检流程一次，FR-4.9 口径）；
         · 取值域外的结果**被拒收**（`TypeError`）且库里不新增行（写入点守边界、不做业务判断）。 */
    const memDbApi = require(path.join(ROOT, 'server', 'db'));
    const { DatabaseSync } = memDbApi.loadSqlite();
    const memDb = new DatabaseSync(':memory:');
    memDbApi.initSchema(memDb, '2026-09-30 09:00:00');
    const MEM_T = 'WO-E58-MEM', MEM_NOW = '2026-09-30 09:00:00';
    const memWritten = ['合格', '不合格', '待复检'];
    const put = (unitIndex, result, durationSec) => resultRepo.upsertJudgement(memDb, {
      procOrderNo: MEM_T, unitIndex, result, judgedAt: MEM_NOW, now: MEM_NOW, durationSec
    });
    put(1, memWritten[0], 10);
    put(2, memWritten[1], 20);
    put(3, memWritten[2], 30);
    put(1, '测试中', 99);                          // 同一件再写：幂等 + 终态不回退 + duration 取 MAX
    const memDone = resultRepo.countDone(memDb, MEM_T);
    const memRows = resultRepo.countByTask(memDb, MEM_T);
    const memRow1 = resultRepo.getOne(memDb, MEM_T, 1);
    const memRow3 = resultRepo.getOne(memDb, MEM_T, 3);
    /* 期望的构成性推导：落在 `DONE_STATUS`（合格＋不合格）的那些"件"才算已完成（FR-4.4 / FR-5.11） */
    const memExpectDone = memWritten.filter(r => resultRepo.DONE_STATUS.includes(r)).length;
    let memRejected = null;
    try { put(4, '合格件', 1); } catch (err) { memRejected = err; }
    const memRowsAfterReject = resultRepo.countByTask(memDb, MEM_T);
    t.check('九 · 「已完成件数」**派生自写入点**（FR-4.4 / FR-5.11 的减数真的能非零）：' +
      '经 `upsertJudgement()` 写入 合格/不合格/待复检 三件（第 1 件再写一次「测试中」）⇒ ' +
      '`countDone()` ＝ **合格＋不合格**（**待复检不计**）、`countByTask()` ＝ 写过的件数（按件幂等）、' +
      '第 1 件终态不回退、第 3 件 `retest_count` ＝ 1、取值域外的结果被拒收且不新增行',
      memDone === memExpectDone && memExpectDone < memWritten.length &&
      memRows === memWritten.length &&
      Boolean(memRow1) && memRow1.result === '合格' && memRow1.duration_sec === 99 &&
      Boolean(memRow3) && memRow3.result === '待复检' && memRow3.retest_count === 1 &&
      memRejected instanceof TypeError && memRowsAfterReject === memWritten.length,
      `内存库（:memory: ＋ initSchema，**只经真写入点**写入）实测：countDone=${memDone}、` +
      `期望＝写成内容里落在 DONE_STATUS=${JSON.stringify(resultRepo.DONE_STATUS)} 的条数=${memExpectDone}` +
      `（**待复检不计**：写 ${memWritten.length} 件、只算 ${memExpectDone} 件）；` +
      `countByTask=${memRows}（期望 ${memWritten.length}）；` +
      `第 1 件行=${JSON.stringify(memRow1)}（终态不回退 / duration_sec 取 MAX）；` +
      `第 3 件行=${JSON.stringify(memRow3)}；` +
      `取值域外的结果 '合格件' 被拒收=${memRejected instanceof TypeError}` +
      `（${memRejected && memRejected.message ? String(memRejected.message).slice(0, 70) : '（未抛错）'}）；` +
      `拒收后行数=${memRowsAfterReject}`);

    /* ④ 当班「已完成」的**取数真源**（技术债 `E61`／审查 P1-2，负责人 2026-09-30 裁定：
       `stateSnapshot.js` 的 `statsOf()` 由 `SELECT status FROM task` 改为 `SELECT result FROM result`，
       与 `FR-5.11` 同源）。**为什么必须在门禁里落成断言**：此前**没有任何门禁**看这一处取数 ——
       把 `statsOf()` 改回读 `task.status`（该列全仓无写入方 ⇒ 恒 `待测试` ⇒ 「已完成」恒 0、
       与同帧 `FR-5.11` 的 detail 同屏矛盾），上面 ①②③ 三条**全部照旧全绿**
       （它们只验"写入点在不在／委托给谁／`countDone` 的派生"，没有一条经 `stateSnapshot` 的统计段取数）。
       本节 ④ 就是补这个缺口，并作为 **D22 定点变异**的靶子（ADR-0004 D22：防回潮断言须可证伪）。
       ---- 现场构造（**与 ③ 完全独立的一段内存库**，不往 ③ 的库塞任何行） ----
       经 `upsertJudgement()`（真写入点）写四件：合格 / 合格 / 不合格 / 待复检
       ⇒ `DONE_STATUS` 口径下"已完成"应为 **3**（**待复检不计**），而 `result` 表共 **4** 行。
       `task` 表另插 **2** 行（`status` 分别为「测试中」「待测试」）—— **只为证伪"读 `task.status`"这一支**：
       这两行若被当成"已完成"来源，数是 0（都非 `DONE_STATUS`）。
       期望值**现算**：`expectDone` ＝ 写入内容里落在 `DONE_STATUS` 的条数（不写死魔数）。
       ⚠ 两个来源在本夹具上的取值**刻意不同**（3 vs 0/2），否则本条对"改回读 task.status"无判别力。 */
    const snapSvc = require(path.join(ROOT, 'server', 'services', 'stateSnapshot.js'));
    const snapDb = new DatabaseSync(':memory:');
    memDbApi.initSchema(snapDb, MEM_NOW);
    const SNAP_OK = 'WO-P12-SNAP-OK', SNAP_NG = 'WO-P12-SNAP-NG';
    const snapWritten = ['合格', '合格', '不合格', '待复检'];
    snapWritten.forEach((r, i) => resultRepo.upsertJudgement(snapDb, {
      procOrderNo: i === 2 ? SNAP_NG : SNAP_OK, unitIndex: i + 1, result: r,
      judgedAt: MEM_NOW, now: MEM_NOW, durationSec: 10 * (i + 1)
    }));
    /* `task` 行：**不是** `result` 行，也不是给被测路径喂假 `result`；它存在的唯一理由是
       "把 `task.status` 摆成一个非 0 的值，再看那条量动不动"。 */
    const snapTaskRow = (no, status) => snapDb.prepare(
      'INSERT INTO task(proc_order_no, product_code, status, created_at, updated_at) VALUES(?,?,?,?,?)'
    ).run(no, 'P-P12', status, MEM_NOW, MEM_NOW);
    snapTaskRow('WO-P12-T1', '测试中');
    snapTaskRow('WO-P12-T2', '待测试');
    /* 统计段的公开取数口：整个 `snapshot()`（不另走内部函数 —— 被测的就是"快照里的 stats"） */
    const snapStats = () => snapSvc.createStateSnapshot({
      db: snapDb, now: () => new Date(MEM_NOW.replace(' ', 'T'))
    })().stats;
    const snapExpectDone = snapWritten.filter(r => resultRepo.DONE_STATUS.includes(r)).length;
    const snapRows = snapWritten.length;
    /** 逐态件数：**也从写入内容现算**（不写死魔数 —— 与上面的 expectDone 同一口径） */
    const snapCountOf = st => snapWritten.filter(r => r === st).length;
    const ST = resultRepo.STATUS;
    /** 若有人把取数改回 `task.status`，这一格就是它会读到的值（用来当场证明本条有判别力） */
    const taskStatusDone = () => Number(snapDb.prepare(
      'SELECT COUNT(*) AS c FROM task WHERE status IN (?,?)'
    ).get(resultRepo.DONE_STATUS[0], resultRepo.DONE_STATUS[1]).c);

    const snapA = snapStats();
    const fakeA = taskStatusDone();
    t.check('九 · 当班「已完成」的**取数真源＝`result` 表**（P1-2／E61）：`stateSnapshot` 的 ' +
      '`stats.doneQty` ＝ `result` 表里落在 `DONE_STATUS`（合格＋不合格）的**件数**，**待复检不计** —— ' +
      '写入 合格/合格/不合格/待复检 四件 ⇒ 「已完成」只是其中合格＋不合格那几件' +
      '（而同一份快照里 `retestQty` 非 0 证明那件**在表内**、只是不计已完成）',
      snapA.doneQty === snapExpectDone && snapExpectDone < snapRows &&
      snapA.passQty === snapCountOf(ST.PASS) && snapA.failQty === snapCountOf(ST.FAIL) &&
      snapA.retestQty === snapCountOf(ST.RETEST),
      `内存库（:memory: ＋ initSchema；四件**只经** upsertJudgement 写入）：` +
      `stats.doneQty=${snapA.doneQty}（期望＝写入内容里落在 DONE_STATUS=${JSON.stringify(resultRepo.DONE_STATUS)} 的条数=${snapExpectDone}）；` +
      `passQty=${snapA.passQty}（写入「${ST.PASS}」${snapCountOf(ST.PASS)} 件）/` +
      `failQty=${snapA.failQty}（写入「${ST.FAIL}」${snapCountOf(ST.FAIL)} 件）/` +
      `retestQty=${snapA.retestQty}（写入「${ST.RETEST}」${snapCountOf(ST.RETEST)} 件）—— ` +
      `写 ${snapRows} 件、已完成 ${snapExpectDone} 件；` +
      `同刻 task 表里落在 DONE_STATUS 的 ` + '`task.status`' + `＝${fakeA} 条` +
      `（≠ ${snapExpectDone} ⇒「读 task.status」这一支在本夹具上**必然算错**，本条有判别力）`);

    const snapB = snapStats();                                  // 改写 task.status 前再取一次（阴性对照基线）
    snapDb.prepare('UPDATE task SET status = ?').run('合格');    // ① 全改「合格」（落在 DONE_STATUS 内）
    snapTaskRow('WO-P12-T3', '测试中');                          // 并再**新增**一行 task（证明"多一行工单"也不动该量）
    const snapC = snapStats();
    const fakeC = taskStatusDone();
    snapDb.prepare('UPDATE task SET status = ?').run('测试中');  // ② 全改「测试中」（落在 DONE_STATUS 外）
    const snapD = snapStats();

    t.check('九 · 当班「已完成」**不读** `task.status`（P1-2／E61；**D22 靶子**）：把 `task` 表的 ' +
      '`status` 全改成「合格」或全改成「测试中」（并**再新增一行** task）⇒ `stats.doneQty` **一字不变**，' +
      '始终等于 `result` 表的合格＋不合格件数',
      snapB.doneQty === snapExpectDone && snapC.doneQty === snapB.doneQty &&
      snapD.doneQty === snapB.doneQty && snapExpectDone < snapRows &&
      fakeC !== snapExpectDone,
      `task.status 三态下同一份快照的 doneQty：` +
      `「测试中/待测试」⇒ ${snapB.doneQty}；全改「合格」＋新增一行 task ⇒ ${snapC.doneQty}；全改「测试中」⇒ ${snapD.doneQty}` +
      `（三次都应为 ${snapExpectDone} ＝ result 表口径）；` +
      `同期 task 表按 status 数的"假想已完成"＝${fakeA} → ${fakeC} → 0（**确实在变** ⇒ 该量若真来自 task.status，本条必红）；` +
      `result 表行数始终＝${snapRows}`);
    snapDb.close();
  }
}

/* ---------------- 十、预警阈值可配（改配置真源 ⇒ 判据随之变化） ----------------
   立案：四类预警的阈值过去有一部分只活在前端演示实现的字面量里（工单超时 80），
   服务端判定引擎若不读配置就无从"可配"（NFR-19 关键参数配置化）。
   本段**在内存里覆盖配置真源**（跑完复查磁盘未变）后，逐类给出**改前 → 改后**的判据反转，
   最后无条件还原并复验"回到基线"（不是"改完就不管了"）。 */
t.section('十、预警阈值可配：改配置真源（内存覆盖，不落盘）后判据随之变化');
{
  const STD = cfg.standards;
  const GRID = 1 / Math.pow(10, STD.digits);
  const dSpec = STD.default.depth;
  const sSpec = STD.default.speed;
  const upper = standardSvc.round2(dSpec.typical + dSpec.upperDev);
  const lower = standardSvc.round2(dSpec.typical + dSpec.lowerDev);
  const k = Math.max(1, Math.ceil((upper - lower) * STD.nearRatio / GRID - 1e-9));
  const nearVal = standardSvc.round2(upper - k * GRID);         // 现配置下的"临近带闭边界"值
  const M = cfg.maintenance || {};
  const C = (M.consumables || [])[0] || {};
  const saved = {
    order: cfg.warnings.orderOverduePending, orderRatio: cfg.warnings.orderOverdueRatio,
    warnDays: M.warnDays, lamp: C.threshold, near: STD.nearRatio
  };
  const lvOf = (title, input) => {
    const hit = judgeSvc.buildWarnings(input).find(w => w.title === title);
    return hit ? hit.lv : null;
  };
  const input = {
    now: '2026-09-18T15:30:00', real: { depth: dSpec.typical, speed: sSpec.typical },
    standard: { depth: dSpec, speed: sSpec },
    /* 耗材计数取在**现阈值之上**，这样"阈值调大 ⇒ 判据反转"的对照才成立 */
    consumableHours: C.threshold + 70,
    /* FR-5.11 新判据的两个入参：应完成 100 / 已完成 50 ⇒ 落后率 50% ⇒ 现阈值下必 err */
    shouldDone: 100, doneQty: 50
  };
  const cfgOk = t.requires('阈值真源齐备：warnings.orderOverdueRatio / warnings.orderOverduePending / maintenance.warnDays / consumables[0].threshold / standards.nearRatio 都是配置里的有限数值',
    Number.isFinite(saved.order) && Number.isFinite(saved.orderRatio) && Number.isFinite(saved.warnDays) &&
    Number.isFinite(saved.lamp) && Number.isFinite(saved.near),
    `orderOverdueRatio=${saved.orderRatio} orderOverduePending=${saved.order} warnDays=${saved.warnDays} lampThreshold=${saved.lamp} nearRatio=${saved.near}`);

  try {
    /* ① 工单超时（FR-5.11 新判据）：落后率 50% 在现阈值（0.1＝10%）下判 err；
          把**比率阈值**上调到 60% 且**件数阈值**放到很大 ⇒ 同一现场判 ok；还原后回 err。
          两个门槛**都要可配**，故这里把件数门槛也一并放大（否则 50 件落后 > 80 不成立、
          但比率已被放大 ⇒ 只证明比率可配）。 */
    const beforeOrder = lvOf('工单超时预警', input);
    cfg.warnings.orderOverdueRatio = 0.6;
    cfg.warnings.orderOverduePending = 999999;      // 等价关闭件数门槛，单独验比率门槛
    const afterRatioRaised = lvOf('工单超时预警', input);
    cfg.warnings.orderOverdueRatio = saved.orderRatio;
    cfg.warnings.orderOverduePending = 10;          // 只剩件数门槛：落后 50 > 10 ⇒ 仍 err
    const afterCountOnly = lvOf('工单超时预警', input);
    cfg.warnings.orderOverduePending = 999999;      // 率回基线、件数门槛关闭 ⇒ **比率门槛单独判 err**
    const ratioOnly = lvOf('工单超时预警', input);
    cfg.warnings.orderOverduePending = saved.order;
    t.check('FR-5.11 工单超时阈值可配（比率 + 件数双门槛）：改 warnings.orderOverdueRatio / orderOverduePending（内存）⇒ 同一现场的判据反转，还原后回到基线',
      beforeOrder === 'err' && afterRatioRaised === 'ok' && afterCountOnly === 'err' && ratioOnly === 'err' &&
      lvOf('工单超时预警', input) === 'err',
      `应完成 ${input.shouldDone} / 已完成 ${input.doneQty}（落后率 50%）：阈值率 ${saved.orderRatio} ⇒ ${beforeOrder}；` +
      `率 0.6 且件数门槛关闭 ⇒ ${afterRatioRaised}；率还原、件数门槛 10 ⇒ ${afterCountOnly}；` +
      `率还原、件数门槛关闭 ⇒ ${ratioOnly}（比率门槛**单独**即可判 err）；还原后 ⇒ ${lvOf('工单超时预警', input)}`);

    /* ①b FR-5.11 **允许落后率为负**（超前于计划）⇒ 绝不告警；且"应完成 0"（班初）也不得告警 */
    const ahead = lvOf('工单超时预警', { ...input, shouldDone: 100, doneQty: 130 });
    const zeroShould = lvOf('工单超时预警', { ...input, shouldDone: 0, doneQty: 0 });
    t.check('FR-5.11 负落后率（超前）与"应完成 0"（班初）均**不得告警**（旧口径班初必报，是本判据换掉它的原因）',
      ahead === 'ok' && zeroShould === 'ok',
      `超前（应 100 / 完成 130 ⇒ 落后率 −30%）⇒ ${ahead}；班初（应 0 / 完成 0）⇒ ${zeroShould}`);

    /* ② 维保到期：提前天数现值 ⇒ 剩余 9 天判 warn；收紧到"剩余天数 − 1" ⇒ 同一剩余天数判 ok */
    const beforeMaint = lvOf('设备维保到期预警', input);
    const daysLeft = judgeSvc.maintenanceState(input.now).daysLeft;
    M.warnDays = Math.max(0, daysLeft - 1);
    const afterMaint = lvOf('设备维保到期预警', input);
    M.warnDays = saved.warnDays;
    t.check('NFR-19 维保提前天数可配：改 maintenance.warnDays（内存）⇒ 同一剩余天数的判据反转，还原后回到基线',
      beforeMaint === 'warn' && afterMaint === 'ok' && lvOf('设备维保到期预警', input) === 'warn',
      `剩余 ${daysLeft} 天：阈值 ${saved.warnDays} ⇒ ${beforeMaint}；阈值 ${Math.max(0, daysLeft - 1)} ⇒ ${afterMaint}；还原后 ⇒ ${lvOf('设备维保到期预警', input)}`);

    /* ③ 耗材更换：阈值现值 ⇒ 点亮 阈值+70 判 warn；上调到 点亮+1 ⇒ 同一点亮判 ok */
    const beforeLamp = lvOf('耗材更换预警', input);
    C.threshold = input.consumableHours + 1;
    const afterLamp = lvOf('耗材更换预警', input);
    C.threshold = saved.lamp;
    t.check('NFR-19 耗材更换阈值可配：改 maintenance.consumables[0].threshold（内存）⇒ 同一点亮时长的判据反转，还原后回到基线',
      beforeLamp === 'warn' && afterLamp === 'ok' && lvOf('耗材更换预警', input) === 'warn',
      `点亮 ${input.consumableHours} h：阈值 ${saved.lamp} ⇒ ${beforeLamp}；阈值 ${input.consumableHours + 1} ⇒ ${afterLamp}；还原后 ⇒ ${lvOf('耗材更换预警', input)}`);

    /* ④ 临近比例（FR-3.18 的判据参数）：现值 ⇒ 距上限 k 格判 warn；收紧到一半 ⇒ 同一实测判 ok */
    const beforeNear = judgeSvc.standardLevel(nearVal, dSpec).lv;
    STD.nearRatio = saved.near / 2;
    const afterNear = judgeSvc.standardLevel(nearVal, dSpec).lv;
    STD.nearRatio = saved.near;
    t.check('FR-3.18/C-85 临近比例可配（standards.nearRatio）：收紧比例 ⇒ 临近带宽变窄、同一实测由 warn 变 ok，还原后回到基线',
      beforeNear === 'warn' && afterNear === 'ok' && judgeSvc.standardLevel(nearVal, dSpec).lv === 'warn',
      `实测 ${nearVal}（距上限 ${k} 格）：nearRatio ${saved.near} ⇒ ${beforeNear}；${saved.near / 2} ⇒ ${afterNear}；还原后 ⇒ ${judgeSvc.standardLevel(nearVal, dSpec).lv}`);
  } finally {
    cfg.warnings.orderOverduePending = saved.order;
    cfg.warnings.orderOverdueRatio = saved.orderRatio;
    M.warnDays = saved.warnDays;
    C.threshold = saved.lamp;
    STD.nearRatio = saved.near;
  }

  /* ⑤ 还原复验（**配置真源与判据都回到基线**） */
  const restored = {
    order: cfg.warnings.orderOverduePending === saved.order,
    orderRatio: cfg.warnings.orderOverdueRatio === saved.orderRatio,
    warnDays: M.warnDays === saved.warnDays,
    lamp: C.threshold === saved.lamp,
    near: STD.nearRatio === saved.near
  };
  t.check('阈值用例跑完**配置真源逐项还原**（内存覆盖不落盘，判据回到基线）',
    restored.order && restored.orderRatio && restored.warnDays && restored.lamp && restored.near &&
    lvOf('工单超时预警', input) === 'err' && judgeSvc.standardLevel(nearVal, dSpec).lv === 'warn',
    `orderOverduePending=${cfg.warnings.orderOverduePending} orderOverdueRatio=${cfg.warnings.orderOverdueRatio} warnDays=${M.warnDays} lamp=${C.threshold} nearRatio=${STD.nearRatio}（均与用例前相同）`);

  /* ⑥ 阈值可配（跨实现）：前端读的是**同一个配置键**（`standards.nearRatio` 现读）
     ⇒ 改真源后两侧必须同步反转、且判据仍逐条一致（否则"可配"只配了一半）。 */
  if (cfgOk) {
    const fe = loadFrontEnd(cfg.shift.list.slice());
    const std = { depth: dSpec, speed: sSpec };
    const feBefore = fe.freezeTick('2026-09-18T15:30:20', std, { depth: nearVal, speed: sSpec.typical });
    const svBefore = judgeSvc.buildParamWarnings({ real: feBefore.real, standard: std });
    try {
      STD.nearRatio = saved.near / 2;
      fe.config.standards.nearRatio = saved.near / 2;     // 只改隔离实例的配置对象（仓库文件不动）
      const feAfter = fe.freezeTick('2026-09-18T15:30:21', std, { depth: nearVal, speed: sSpec.typical });
      const svAfter = judgeSvc.buildParamWarnings({ real: feAfter.real, standard: std });
      const feWarnBefore = feBefore.warnings.find(w => w.title === '参数阈值临近预警');
      const feWarnAfter = feAfter.warnings.find(w => w.title === '参数阈值临近预警');
      t.check('阈值可配（跨实现）：nearRatio 改真源后**前端与服务端同步反转**，且两侧判据仍逐条一致',
        !!feWarnBefore && feWarnBefore.lv === 'warn' && !!feWarnAfter && feWarnAfter.lv === 'ok' &&
        svBefore.length === 1 && svBefore[0].lv === 'warn' && svAfter.length === 1 && svAfter[0].lv === 'ok',
        `前端 ${feWarnBefore && feWarnBefore.lv} → ${feWarnAfter && feWarnAfter.lv}；` +
        `服务端 ${svBefore.length ? svBefore[0].lv : '（0 条）'} → ${svAfter.length ? svAfter[0].lv : '（0 条）'}`);
    } finally {
      STD.nearRatio = saved.near;
      fe.config.standards.nearRatio = saved.near;
    }
  }
}

t.finish();
