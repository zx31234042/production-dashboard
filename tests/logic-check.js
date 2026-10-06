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

/* ---------------- 入口与异常兜底（`E80③`／规范 9.5-5 第 5 条） ----------------
   本脚本是一道**门禁**，但长期没有 `main()` 声明、也没有任何异常兜底 ⇒ 两个后果：
     ① `harness-check` 第十六节只审"声明了 `main()`"的文件 ⇒ 本脚本**不在扫描面内**；
     ② 脚本自身异常时抛裸栈、进程退 **1** ⇒ `run-all` 的失败明细过滤
        （`/\[FAIL\]|失败清单|^\s+\d+\.|脚本异常终止/`）认不出它，与"有断言失败"逐字同形。
   现按既有 sync 家族（`copy-check`／`docs-cross-check`／`trace-check`／`screenshot-diff`）同形收口：
   `function main()` ＋ 顶层 `try`/`catch`，异常**打印出来**（含字面 `脚本异常终止`，供 `run-all` 命中）并退 **2**。
   **断言与条数一字未改**（本例只是把原来的顶层语句搬进 `main()`）。 */
function main() {
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
/* A1（T-20261002-06／ADR-0009 D4）的三处被测对象：
   · `server/repo/shiftStat.js` —— DR-06 的**唯一写入口**（本段只用它**铺夹具行**，不测它本身：仓储层的
     断言在 `tests\db-check.js` 的第十一章之十一）；
   · `server/services/stateSnapshot.js` —— DR-17 的**取数改真源**处：日/月/年＝对 `shift_stat` 求和、
     当班增量＝当班实时 `runSec` − 该班次已固化 `run_sec`；
   · `platform/clock.js` —— 快照的注入时钟出口（周期键按它算，ADR-0003 D17）。
   本文件此前**从不建库**（纯函数 + 注入时钟）；本节为了验"取数真的落在 `shift_stat` 上"必须建一个
   **临时内存库**（`node:sqlite` 的 `:memory:`，不落盘、不进 `._verify`、跑完即关）。 */
const shiftStatRepo = require('../server/repo/shiftStat');
const stateSnapshotSvc = require('../server/services/stateSnapshot');
const platformClock = require('../platform/clock');

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

/* ---------------- 三、15 项指标（FR-4.1～4.15） ----------------
   ⚠ 入参形状自 `E65`（技术债，负责人 2026-09-30 裁定）起**分为两类**，`E69` 起如下：
     · 票级 `orders:[{planQty}]`（来自 `task` 表；单位＝测试任务/件，C-111 §0.2）；
     · **开工件数** `startedPieces:<number>`（来自 `measure_rt` 的 `unit_index` 去重件数；
       取数在 `server/services/stateSnapshot.js` 的 `statsOf()`，本段只验算式不吃取数）；
     · 件级 `pieces:[{result, durationSec}]`（来自 `result` 表；`durationSec` ＝ 单件测试时长）。
   本段因此**不再**用旧的 `tasks: mixed({…})`（旧形状在新实现里被整段忽略 ⇒ 票级与件级全 0，
   那是「喂错输入」不是「实现错」）。下面的期望值全部**由夹具现算**（构成性推导），不写死魔数。 */
t.section('三、15 项当班指标（FR-4.1～4.15）');
{
  const clock = createClock({ mode: 'fixed', at: '2026-09-19T12:00:00' });
  const shift = shifts.current(clock);
  /** 件级夹具（当班件）：**目标场景**＝待测试 3 / 测试中 2 / 合格 8 / 不合格 2 / 待复检 1。
   *  `durationSec` 取显式整数秒（与 `result.duration_sec` INTEGER 同域）。 */
  const piece = (result, durationSec) => ({ result, durationSec });
  const PIECES = [
    piece('待测试', 0), piece('待测试', 0), piece('待测试', 0),
    piece('测试中', 0), piece('测试中', 0),
    piece('合格', 10), piece('合格', 20), piece('合格', 30), piece('合格', 40),
    piece('合格', 50), piece('合格', 60), piece('合格', 70), piece('合格', 80),
    piece('不合格', 90), piece('不合格', 100),
    piece('待复检', 110)
  ];
  /** 票级夹具（当班派工票）：两票各 8 件 ⇒ 计划 16。
   *  ⚠ `E69`（负责人 2026-09-30 裁定③）起 `orders` **不再带逐票 `started` 布尔** —— 那已不是入参：
   *  `FR-4.2` 的开工数是**件数**（单位＝测试任务，C-111 §0.2），由取数层
   *  （`server/services/stateSnapshot.js` 的 `statsOf()`）按件数出来、以 `startedPieces` 显式传入。 */
  const ORDERS = [{ planQty: 8 }, { planQty: 8 }];
  /* 期望值：全部由夹具现算（`E65` 的两种粒度分别只从自己那一类取数） */
  const expectPlanQty = ORDERS.reduce((s, o) => s + o.planQty, 0);
  const expectOrderTotal = ORDERS.length;
  const cnt = st => PIECES.filter(p => p.result === st).length;
  const expectPass = cnt('合格');
  const expectFail = cnt('不合格');
  const expectDone = expectPass + expectFail;                 // FR-4.4 已完成 = 合格 + 不合格
  /* 开工件数（`FR-4.2` / C-111）：**由件级夹具现算** —— "已开始测试"的件＝已判完成的件
     （合格＋不合格）＋ 正在测试的件；`待测试`（还没开始）与 `待复检`（判定依据不成立）不计。
     ⚠ 本夹具刻意让 `expectStartedPieces` **既不等于**派工票数 `ORDERS.length`、**也不等于**计划件数
     `expectPlanQty`、更不等于 0 ⇒ 下面 FR-4.2 / FR-4.3 两条**真的能分辨单位**
     （「改回数票数」⇒ 2、「忽略入参」⇒ 0、「把计划当开工」⇒ 16，三种回潮都当场变红）。 */
  const expectStartedPieces = cnt('合格') + cnt('不合格') + cnt('测试中');
  /* `E67`（负责人 2026-09-30 裁定②）后的分子集合：**只累加 `DONE_STATUS`（合格＋不合格）的件** ——
     依据需求 `FR-4.13`「**完成**测试总时长 ÷ 完成数量」，分子与分母 `expectDone` **同一集合**；
     `待复检`／`测试中`／`待测试` 不计（它们没有"完成测试时长"，算进去是编造分子）。
     ⚠ 这里**不再**取"Σ 全部件"（那是 `E65` 偏差① 的旧口径读数）：本夹具里 `待复检 110` 是
     专门用来让"这条过滤"可证伪的一件 —— 若实现去掉 `DONE_STATUS` 过滤，本条当场变红。 */
  const expectDurSum = PIECES.reduce(
    (s, p) => s + (stats.DONE_STATUS.includes(p.result) ? p.durationSec : 0), 0);
  const base = { shift, orders: ORDERS, startedPieces: expectStartedPieces, pieces: PIECES, now: clock.now() };
  const r = stats.computeShiftStats({
    ...base,
    accum: { daySec: 3600, monthSec: 7200, yearSec: 10800, at: clock.now() }
  });

  t.check('FR-4.1 计划总数 = Σ 当班派工票的 planQty（票级入参）',
    r.planQty === expectPlanQty, `实测 ${r.planQty}，由 orders 现算 ${expectPlanQty}`);
  t.check('FR-4.2 开工数 ＝ 当班**已开始测试的测试任务（件）数**（入参 `startedPieces`；C-111 计量单位）' +
    '—— **不是**派工**票数**（`orders.length`）、**不是**采样帧数、**不看** `task.status`',
    r.startedQty === expectStartedPieces &&
    expectStartedPieces !== ORDERS.length && expectStartedPieces !== expectPlanQty &&
    expectStartedPieces !== 0,
    `实测 ${r.startedQty}，由件级夹具现算 ${expectStartedPieces}` +
    `（＝已完成件 ${expectDone} ＋ 在测件 ${cnt('测试中')}；` +
    `对照组：派工票数 ${ORDERS.length}、计划件数 ${expectPlanQty} —— 三个量刻意互不相等）`);
  t.check('FR-4.3 未开工 ＝ 计划 − 开工（`max(0, planQty − startedPieces)`，**减数与被减数同单位＝件**）' +
    '—— 旧口径把"票数"从"件数"里减掉（实测 30 件 / 3 票 / 未开工 27）正是 `E69`',
    r.notStartedQty === Math.max(0, expectPlanQty - expectStartedPieces),
    `实测 ${r.notStartedQty}（max(0, ${expectPlanQty} − ${expectStartedPieces})；` +
    `若误按票数减则为 ${Math.max(0, expectPlanQty - ORDERS.length)}）`);
  t.check('FR-4.4 已完成 = 合格 + 不合格（件级入参）',
    r.doneQty === expectDone, `实测 ${r.doneQty}，由 pieces 现算 ${expectDone}`);
  t.check('FR-4.5 测试中数量（件级）', r.runningQty === cnt('测试中'), String(r.runningQty));
  t.check('FR-4.6 待测试数量（件级）', r.waitingQty === cnt('待测试'), String(r.waitingQty));
  t.check('FR-4.7 合格数（件级）', r.passQty === expectPass, String(r.passQty));
  t.check('FR-4.8 不合格数（件级）', r.failQty === expectFail, String(r.failQty));
  t.check('FR-4.9 复检数（件级）', r.retestQty === cnt('待复检'), String(r.retestQty));
  t.check('FR-4.10 一次性合格率 = 合格 / 已完成（现状口径，`E63` 未落地前不做"首次判定"）',
    r.firstPassRate === Number((expectPass / expectDone * 100).toFixed(1)),
    `实测 ${r.firstPassRate}% = ${expectPass}/${expectDone}`);
  /* ⚠ 2026-09-19 修（P3 表外 code-10）：**原断言是循环的** —— 它们拿被测实现算出的 r.runSec
     去验同一实现的公式（如 `idleSec === elapsedSec − runSec`），只能证明"内部自洽"，
     证明不了公式对不对。现改为用**独立已知量**（班次进度 + 用例构造的 pieces/measures）推出期望值。
     ⚠ `E65` 后再修一次：`running` 现取自**件级** pieces；下面的期望式与 `stats.js:125-142` 的
     判据逐项对应（有采集串 ⇒ 按"已收到几秒数据"截断取有效运行；无采集串 ⇒ 有「测试中」件才按
     班次进度计，否则 0）。 */
  const elapsed = shift.elapsedSec;                       // 独立已知：班次已进行时长
  const runningCount = cnt('测试中');
  const measures = [];                                    // 本用例未传 measures
  const runSecExpected = measures.length > 0
    ? (measures.length > 2 ? Math.min(elapsed, measures.length - 1) : elapsed)
    : (runningCount > 0 ? elapsed : 0);
  t.check('FR-4.11 有效运行时长＝在测时按班次进度计（无采集串时等于班次进度）',
    r.runSec === runSecExpected && r.runSec === elapsed,
    `实测 runSec=${r.runSec}s，按输入独立推出 ${runSecExpected}s（件级在测 ${runningCount} 件）`);
  t.check('FR-4.12 待机时长 = 班次进度 − 有效运行',
    r.idleSec === elapsed - runSecExpected, `实测 ${r.idleSec}s = ${elapsed} − ${runSecExpected}`);
  t.check('FR-4.13 单台平均测试时长 = Σ **已完成件**（`DONE_STATUS`＝合格＋不合格）件级时长 / 已完成数' +
    '（`E65` 偏差①：分子不取 runSec；`E67` 裁定②：分子与分母**同集合**，`待复检` 不计）',
    r.avgTestSec === Math.round(expectDurSum / expectDone),
    `实测 ${r.avgTestSec}s（期望 Σ **已完成件**时长 ${expectDurSum}s ÷ ${expectDone} = ` +
    `${Math.round(expectDurSum / expectDone)}s；夹具里 ` +
    `Σ 全部件时长 ${PIECES.reduce((s, p) => s + p.durationSec, 0)}s 是旧口径读数，` +
    `差额全在 ${PIECES.filter(p => !stats.DONE_STATUS.includes(p.result) && p.durationSec > 0).length} 件未完成件上）`);
  t.check('FR-4.14 产能达成率 = 完成 / 计划',
    r.capacityRate === Number((expectDone / expectPlanQty * 100).toFixed(1)),
    `实测 ${r.capacityRate}% = ${expectDone}/${expectPlanQty}`);
  t.check('FR-4.15 稼动率 = 有效运行 / 班次进度',
    r.oee === Number((runSecExpected / elapsed * 100).toFixed(1)),
    `实测 ${r.oee}%（期望 ${Number((runSecExpected / elapsed * 100).toFixed(1))}%）`);
  t.check('指标齐全：一次核算同时给出 15 项（不缺项）',
    ['planQty', 'startedQty', 'notStartedQty', 'doneQty', 'runningQty', 'waitingQty',
      'passQty', 'failQty', 'retestQty', 'firstPassRate', 'runSec', 'idleSec',
      'avgTestSec', 'capacityRate', 'oee'].every(k => k in r), '');
  /* `E65` 的返回值改名（`taskTotal` ⇒ `orderTotal`）：钉住"旧键已不存在"，
     否则调用方读 `snapshot.stats.taskTotal` 会静默拿到 `undefined`（旧语义＝传入行数）。 */
  t.check('FR-4 返回值改名（`E65` 偏差③）：`orderTotal` ＝ 当班派工**票数**、且旧键 `taskTotal` 已不存在',
    r.orderTotal === expectOrderTotal &&
    !Object.prototype.hasOwnProperty.call(r, 'taskTotal'),
    `orderTotal=${r.orderTotal}（期望 orders.length=${expectOrderTotal}）；` +
    `taskTotal 在场=${Object.prototype.hasOwnProperty.call(r, 'taskTotal')}`);

  /* ---- runSec / idleSec 真值表（补审查报告 B2-1·9 偏差⑥；条数边界由 `E68` 重述）----
     判据来源 `server\services\stats.js` 的「三、时长」段（`E68` 修正后）：
       有采集串（条数 n > 0） ⇒ runSec = min(已进行时长, max(0, n − 1))  ← **无条件截断，无 n≤2 特例**；
       无采集串（n = 0）     ⇒ runSec = (有「测试中」件 ? 已进行时长 : 0)  ← 旧分支，`E68` 未动；
       idleSec = max(0, 已进行时长 − runSec)。
     ⚠ 覆盖史（座位 4b 的 `T-20260930-18`）：本表原先只取 **n=5 / n=0** 两档，而 `E68` 修正前的判据是
       `n > 2 ? min(elapsed, n−1) : elapsed` —— **n=5 与 n=0 在新旧判据下逐值相同** ⇒ "把 `n > 2`
       特例改回来"这种回潮**当时无一条断言会红**（座位 6 的 B3-7 第 2 条、审查报告 C·8.4(b) 实测）。
       故下面补 **n = 1／2／3** 三行，期望＝新口径 **0／1／2**。
     ⚠ **不得**照抄审查报告 C·8.4(b) 那句"补 3 行（1⇒elapsed、2⇒elapsed、3⇒min(elapsed,2)）" ——
       那组期望是**旧口径**（写在 `E68` 裁定之前），照抄会把旧判据重新锁进断言（B3-4 ① 的备注）。
     期望值不写死秒数：一律由 `elapsed` 与采集条数**现算**。 */
  const runningPiece = piece('测试中', 0);
  const doneOnlyPiece = piece('合格', 10);
  const measureStr = (n, at) => Array.from({ length: n }, (_, i) => new Date(at.getTime() - i * 1000));
  /** 补集口径（＝`stats.js:157` 的 `byMeasures`）：min(elapsed, max(0, n − 1)) —— 无条件截断。 */
  const byMeasures = n => Math.min(elapsed, Math.max(0, n - 1));
  const truth = [
    { label: '(a) 有采集串 n=5 且 有「测试中」件', measures: measureStr(5, clock.now()), pieces: [runningPiece] },
    { label: '(b) 有采集串 n=5 且 无「测试中」件', measures: measureStr(5, clock.now()), pieces: [doneOnlyPiece] },
    { label: '(c) 无采集串 且 无「测试中」件', measures: [], pieces: [doneOnlyPiece] },
    { label: '(d) 无采集串 且 有「测试中」件（旧分支：按整班计）', measures: [], pieces: [runningPiece] },
    /* ↓ 条数边界三行（`E68` 的靶子；期望 0／1／2，不是 elapsed／elapsed／2） */
    { label: '(e) 条数边界 n=1 且 无「测试中」件（**1 帧 ≠ 整班**）', measures: measureStr(1, clock.now()), pieces: [doneOnlyPiece] },
    { label: '(f) 条数边界 n=2 且 无「测试中」件', measures: measureStr(2, clock.now()), pieces: [doneOnlyPiece] },
    { label: '(g) 条数边界 n=3 且 无「测试中」件', measures: measureStr(3, clock.now()), pieces: [doneOnlyPiece] },
    { label: '(h) 条数边界 n=1 且 有「测试中」件', measures: measureStr(1, clock.now()), pieces: [runningPiece] }
  ].map(c => {
    const out = stats.computeShiftStats({ shift, orders: ORDERS, pieces: c.pieces, measures: c.measures, now: clock.now() });
    const expectRun = c.measures.length > 0
      ? byMeasures(c.measures.length)
      : (c.pieces.filter(p => p.result === '测试中').length > 0 ? elapsed : 0);
    return { label: c.label, n: c.measures.length, running: c.pieces.some(p => p.result === '测试中'),
      runSec: out.runSec, idleSec: out.idleSec, oee: out.oee,
      expectRun, expectIdle: Math.max(0, elapsed - expectRun) };
  });
  t.check('runSec/idleSec 真值表（`E68` 条数边界）：有采集串 ⇒ 无条件按采样条数取 min(已进行, n − 1)' +
    '（**n=1⇒0s、n=2⇒1s、n=3⇒2s**）；无采集串 ⇒ 有在测件才按整班计',
    truth.every(x => x.runSec === x.expectRun && x.idleSec === x.expectIdle),
    truth.map(x => `${x.label}: runSec ${x.runSec}/${x.expectRun}、idleSec ${x.idleSec}/${x.expectIdle}`).join('；'));
  /* 负向断言（座位 6 指出的覆盖缺口的**正面收口**）：把 n>2 特例改回来时，上面真值表的 (e)/(f) 两行
     会给出"1 帧＝整班、oee＝100%"，本条把这件事单独说成一句直白的话 —— 让回潮的名字可读、
     不必靠"真值表整体变红"去推断红在哪一档。 */
  const oneSample = truth.find(x => x.n === 1 && !x.running);
  t.check('（`E68` 负向断言）**只有 1 个采集样本时 `runSec` 不得等于整班 `elapsedSec`、`oee` 不得为 100%** ' +
    '—— "1 帧＝整班在跑"是从不足的证据编造正向结论',
    oneSample.runSec !== elapsed && oneSample.runSec === byMeasures(1) &&
    oneSample.oee !== 100 && oneSample.oee === Number((byMeasures(1) / elapsed * 100).toFixed(1)),
    `n=1：实测 runSec=${oneSample.runSec}s（不得为 ${elapsed}s）、oee=${oneSample.oee}%（不得为 100%）、` +
    `idleSec=${oneSample.idleSec}s（应为整班 ${elapsed}s 减去已收到数据的秒数）`);
  /* 旧分支保留（`E68` 未动，负责人裁定①明写）：**无采集串 ＋ 有「测试中」件 ⇒ 按整班 `elapsedSec` 计**。
     单独成条（原先只在真值表 (a)/(c) 里间接体现，没有一条指名"整班"这个后果）。 */
  const noMeasureRunning = truth.find(x => x.n === 0 && x.running);
  t.check('（`E68` 旧分支保留）无采集串但确有「测试中」件 ⇒ `runSec` ＝ 整班 `elapsedSec`、`oee` ＝ 100%' +
    '（件级在测本身就是"在跑"的独立证据，不依赖采样条数）',
    noMeasureRunning.runSec === elapsed && noMeasureRunning.idleSec === 0 && noMeasureRunning.oee === 100,
    `无采集串 ＋ 1 件「测试中」：runSec=${noMeasureRunning.runSec}s（期望整班 ${elapsed}s）、` +
    `idleSec=${noMeasureRunning.idleSec}s、oee=${noMeasureRunning.oee}%`);
  /* 只**记录**现状：`addRunSec` 的上界与 `runSec` 耦合（`addRunSec ≤ runSec`），
     而 `runSec` 现在是"由入参形态决定"的量 —— 若调用方只喂票级数据，非零增量会被判越界。
     这里**不主张它是正确设计**，只把耦合事实落成一条可见的记录，供 `E59`/DR-17 排期时参考。 */
  t.info('E65 观察（只记录、非主张）：`computeShiftStats` 的 `addRunSec` 上界＝当次核算出的 `runSec`；' +
    `而 \`runSec\` 由入参（采集串/在测件）决定 ⇒ 无采集串且无在测件时上界为 0，任何非零增量都会被拒收（RangeError）。` +
    `本段实测真值表各组上界：${truth.map(x => `${x.label}⇒${x.runSec}s`).join('；')}（DR-17 落库调用方尚未接线，见 E59）`);

  /* P2-4：`addRunSec` 必须是"本周期增量" —— 缺省即 0，绝不再默认取"班次已运行时长"。
     旧实现在把上次落库的 accum 传回来时会把累计值当增量重复相加（复审已复现）。

     写法（ADR-0004 D21 的构成性约定）：期望值**不写手算魔数**，一律由"已知正确的量"算出来。
     这样以后改基数或增量，断言不用跟着改，也不会因为"魔数凑上去"而失真。 */
  const accumBase = { daySec: 3600, monthSec: 7200, yearSec: 10800, at: clock.now() };
  const addSec = 120;
  const baseSum = accumBase.daySec + accumBase.monthSec + accumBase.yearSec;
  const sumOf = a => a.daySec + a.monthSec + a.yearSec;

  const noAdd = stats.computeShiftStats({ ...base, accum: accumBase });
  t.check('P2-4：不传 addRunSec 时按增量 0 累加（累计不被重复相加）',
    noAdd.accumulate.daySec === accumBase.daySec &&
    noAdd.accumulate.monthSec === accumBase.monthSec &&
    noAdd.accumulate.yearSec === accumBase.yearSec,
    `三项与传入值逐一致（实测 day=${noAdd.accumulate.daySec}）`);

  t.check('P2-4：显式给增量时三项同步 +addRunSec，且再传回时原样保留（不重复相加）',
    (() => {
      const withAdd = stats.computeShiftStats({ ...base, accum: accumBase, addRunSec: addSec });
      const again = stats.computeShiftStats({ ...base, accum: withAdd.accumulate, addRunSec: 0 });
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
        try { stats.computeShiftStats({ ...base, accum: accumBase, addRunSec: bad }); }
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

  /* `E69` 新契约下的"开工数超过计划"：**开工件数（3 件）大于**计划件数（1 件）——
     两数**同单位**（件），故这是"确实开了 3 件而计划只有 1 件"的可观测事实。
     ⚠ 期望值刻意让 `startedQty` **保持 3（不按计划数封顶）**：开工是可观测事实，封顶会把
     "开工多于计划"藏起来；未开工由 `FR-4.3` 的 `max(0, 计划 − 开工)` 收口，故永不为负。
     这一条同时是"`Math.min(…, planQty)` 那版实现"的靶子（若被改回来 ⇒ `startedQty` 变 1 ⇒ 必红）。 */
  const overflowOrders = [{ planQty: 1 }];
  const overflowPieces = 3;                 // 计划 1 件，实际开工 3 件（同单位、可由取数层数出来）
  const overflow = stats.computeShiftStats({
    shift, orders: overflowOrders, startedPieces: overflowPieces,
    pieces: [{ result: '合格', durationSec: 30 }], now: clock.now()
  });
  t.check('开工数超过计划时，未开工封顶为 0（不出现负数）—— 且 `startedQty` ＝ **件数**（同单位）、' +
    '**按件如实报出、不按计划封顶**（`E69`／C-111：开工 3 件 ＞ 计划 1 件是可观测事实）',
    overflow.startedQty === overflowPieces && overflow.planQty === 1 && overflow.notStartedQty === 0,
    `开工（件）=${overflow.startedQty}（入参 ${overflowPieces}）计划（件）=${overflow.planQty}` +
    ` 未开工=${overflow.notStartedQty}`);

  /* 空库/空入参：**四项比率与时长一律 0，且全部 `Number.isFinite`**（不留 NaN/Infinity）。
     与 `stateSnapshot` 的空库现场（第九节）同一口径，此处锁**纯函数**一层。 */
  const empty = stats.computeShiftStats({
    shift, planQty: 0, orders: [], pieces: [], measures: [], now: clock.now()
  });
  const emptyNums = [empty.firstPassRate, empty.capacityRate, empty.oee, empty.avgTestSec,
    empty.runSec, empty.idleSec, empty.planQty, empty.startedQty, empty.doneQty, empty.notStartedQty];
  t.check('空数据不产生 NaN：各项比率为 0、时长为 0',
    empty.firstPassRate === 0 && empty.capacityRate === 0 && empty.oee === 0 &&
    empty.avgTestSec === 0 && empty.runSec === 0 && empty.notStartedQty === 0, '');
  t.check('空数据的全部数值项都是有限数（无 NaN／Infinity 传到界面）',
    emptyNums.every(Number.isFinite), `逐项：${JSON.stringify(emptyNums)}`);

  /* 未给 `planQty` 覆盖值时，计划数真源＝`Σ orders[].planQty`（不再是"任务条数"）；
     开工数由**显式的件数入参**给出（`E69`）—— 期望式把它一并算进去。 */
  const planOrders = [{ planQty: 2 }, { planQty: 3 }];
  /* 开工件数：由夹具现算（票数的"上一件"），且**刻意不等于票数**（1 ≠ 2）⇒ 本条能分辨单位 */
  const noPlanStartedPieces = planOrders.length - 1;
  const noPlan = stats.computeShiftStats({
    shift, orders: planOrders, startedPieces: noPlanStartedPieces,
    pieces: [{ result: '合格', durationSec: 5 }], now: clock.now()
  });
  t.check('未给计划数时按 Σ orders[].planQty 兜底（不留 undefined；不再按传入条数计），' +
    '且未开工 ＝ 计划 − **开工件数**（不是 − 票数）',
    noPlan.planQty === planOrders.reduce((s, o) => s + o.planQty, 0) &&
    noPlan.startedQty === noPlanStartedPieces &&
    noPlan.notStartedQty === planOrders.reduce((s, o) => s + o.planQty, 0) - noPlanStartedPieces,
    `实测 plan=${noPlan.planQty}（Σ orders.planQty=${planOrders.reduce((s, o) => s + o.planQty, 0)}），` +
    `开工=${noPlan.startedQty}（入参 ${noPlanStartedPieces}，票数 ${planOrders.length}），未开工=${noPlan.notStartedQty}`);

  /* 全部票未开工 + 无采集串 + 无在测件 ⇒ 有效运行 0（待机占满）。
     ⚠ 待测件放**件级**（旧夹具把它塞在 `tasks` 里，新实现只把它当"未提供的入参"）。
     ⚠ `E69` 起"未开工"由**开工件数入参＝0** 表达（不再有逐票 `started` 布尔）。 */
  const waitingOrders = [{ planQty: 4 }, { planQty: 6 }];
  const waitingPieces = [{ result: '待测试', durationSec: 0 }];
  const allWaiting = stats.computeShiftStats({
    shift, orders: waitingOrders, startedPieces: 0, pieces: waitingPieces, measures: [], now: clock.now()
  });
  const waitingPlan = waitingOrders.reduce((s, o) => s + o.planQty, 0);
  t.check('全部待测试：开工 0、未开工等于计划、有效运行为 0（待机占满）',
    allWaiting.startedQty === 0 && allWaiting.notStartedQty === waitingPlan &&
    allWaiting.planQty === waitingPlan && allWaiting.runningQty === 0 &&
    allWaiting.runSec === 0 && allWaiting.idleSec === allWaiting.shift.elapsedSec,
    `开工=${allWaiting.startedQty} 未开工=${allWaiting.notStartedQty}（计划 ${waitingPlan}）` +
    ` runSec=${allWaiting.runSec}s idleSec=${allWaiting.idleSec}s elapsed=${allWaiting.shift.elapsedSec}s`);
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
  /* `E65` 后的入参形状：票级 `orders` ＋ 件级 `pieces`（本用例只验"节拍取配置值"，两者都为空） */
  const r = stats.computeShiftStats({
    shift: shifts.current(clock), orders: [], pieces: [], now: clock.now()
  });
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
    /** ④b～④f（`E65` 票级/件级分离）用的注入时钟：固定在中班（现配置 08:00-16:00）
     *  ⇒ 当班窗口可预期；`SNAP_NOW` 换成 `T` 分隔的写法只是因为 `new Date()` 不认空格分隔。 */
    const SNAP_NOW = '2026-09-19 12:00:00';
    /** 真配置（**只读**；④e 用的是它的内存副本，不落盘） */
    const PROD_CFG = cfg.production;
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
    /* ⚠ ④ 的四件当班件落在**早班窗内**（用 `SNAP_NOW` ＝ 2026-09-19 12:00:00，早班 08:00-16:00）；
       下面 ④b～④f 的票级/件级现场与它**共用这同一段库**（同一班次窗口），故两处的"当班"必须同一天。 */
    snapWritten.forEach((r, i) => resultRepo.upsertJudgement(snapDb, {
      procOrderNo: i === 2 ? SNAP_NG : SNAP_OK, unitIndex: i + 1, result: r,
      judgedAt: SNAP_NOW, now: SNAP_NOW, durationSec: 10 * (i + 1)
    }));
    /* `task` 行：**不是** `result` 行，也不是给被测路径喂假 `result`；它存在的唯一理由是
       "把 `task.status` 摆成一个非 0 的值，再看那条量动不动"。 */
    const snapTaskRow = (no, status) => snapDb.prepare(
      'INSERT INTO task(proc_order_no, product_code, status, created_at, updated_at) VALUES(?,?,?,?,?)'
    ).run(no, 'P-P12', status, SNAP_NOW, SNAP_NOW);
    snapTaskRow('WO-P12-T1', '测试中');
    snapTaskRow('WO-P12-T2', '待测试');
    /* 统计段的公开取数口：整个 `snapshot()`（不另走内部函数 —— 被测的就是"快照里的 stats"）；
       ⚠ 注入时钟与四件当班件的 `judged_at` **必须是同一个班次窗口**（都用 `SNAP_NOW`）。 */
    const snapStats = () => snapSvc.createStateSnapshot({
      db: snapDb, now: () => new Date(SNAP_NOW.replace(' ', 'T'))
    })().stats;
    const snapExpectDone = snapWritten.filter(r => resultRepo.DONE_STATUS.includes(r)).length;
    const snapRows = snapWritten.length;
    /* ④b～④f（`E65` 票级/件级分离 ＋ `E69` 开工数按件计的端到端取数）的现场：**同一段独立内存库**，
       票级经 `task`（`plan_qty` ＋ `plan_start_time` 窗口）取数；**开工件数**经 `measure_rt`
       （当班窗口内 `unit_index` 非空、按 `(proc_order_no, unit_index)` 去重）；
       件级经 `result`（`judged_at` 窗口）取数。所有期望值**现算**（不写死魔数）。 */
    const SNAP_NO_START = 'WO-SNAP-NOSTART';
    const SNAP_WIN = ['WO-SNAP-T1', 'WO-SNAP-T2'];
    /* ⚠ 票级窗口的**可证伪构造**：三票刻意各不相同 ——
       · 窗内 10 / 窗内 20 ⇒ 参与；
       · `plan_start_time` 为空（99 件）⇒ 整票不参与；
       · `plan_start_time` 落在**上一班**（88 件）⇒ 不参与。
       若有人把窗口条件（`plan_start_time >= ? AND < ?`）去掉，后两票都会被算进来
       ⇒ `planQty` 与 `orderTotal` 当场变化（本条即红）。 */
    const SNAP_OUT = 'WO-SNAP-OUT';
    const SNAP_PLAN = {
      'WO-SNAP-T1': 10, 'WO-SNAP-T2': 20, [SNAP_NO_START]: 99, [SNAP_OUT]: 88
    };
    const SHIFT_AT = shifts.current(createClock({ mode: 'fixed', at: SNAP_NOW.replace(' ', 'T') }));
    const WIN = { startAt: SHIFT_AT.startAt, endAt: SHIFT_AT.endAt };
    /* 票级窗口判据（构造用，不参与断言）：与 `stateSnapshot` 用的半开区间同口径 */
    const inSnapWin = t0 => String(t0) >= WIN.startAt && String(t0) < WIN.endAt;
    if (!inSnapWin('2026-09-19 10:00:00') || !inSnapWin(SNAP_NOW)) {
      t.info('⚠ 构造自检：注入时刻/计划开工时刻未落在推算窗口 ' + `${WIN.startAt}~${WIN.endAt}` +
        `（inSnapWin(10:00)=${inSnapWin('2026-09-19 10:00:00')}）`);
    }
    const insSnapTask = snapDb.prepare(
      'INSERT INTO task(proc_order_no, product_code, plan_qty, plan_start_time, status, created_at, updated_at)' +
      ' VALUES(?,?,?,?,?,?,?)');
    insSnapTask.run(SNAP_WIN[0], 'P-SNAP', SNAP_PLAN[SNAP_WIN[0]], '2026-09-19 10:00:00', '待测试', SNAP_NOW, SNAP_NOW);
    insSnapTask.run(SNAP_WIN[1], 'P-SNAP', SNAP_PLAN[SNAP_WIN[1]], '2026-09-19 09:00:00', '待测试', SNAP_NOW, SNAP_NOW);
    insSnapTask.run(SNAP_NO_START, 'P-SNAP', SNAP_PLAN[SNAP_NO_START], null, '待测试', SNAP_NOW, SNAP_NOW);
    insSnapTask.run(SNAP_OUT, 'P-SNAP', SNAP_PLAN[SNAP_OUT], '2026-09-19 07:00:00', '待测试', SNAP_NOW, SNAP_NOW);
    /* 现场甲的采样帧：**刻意含三种边界**，期望值全部由本数组现算（ADR-0004 D21 构成性推导）：
       · **同一件多帧**（`u1` 3 帧、`u2` 2 帧、`u3` 1 帧）⇒ 不去重会把"件数"数成"帧数"；
       · **缺件序号**（`unit_index IS NULL`，当班窗口内、行是真的）⇒ 不计入开工件数；
       · **上一班**（`SNAP_OUT` 的帧，行仍在库内）⇒ 不计入当班。
       ⚠ 帧用**列名**写入（本现场不经 `repo/measure.js` —— 那一条由下面 ⑤ 的逐列回读单独守）。 */
    const insSnapMeasure = snapDb.prepare(
      'INSERT INTO measure_rt(equip_code, proc_order_no, unit_index, collect_time, created_at) VALUES(?,?,?,?,?)');
    const SNAP_FRAMES = [
      { no: SNAP_WIN[0], at: '2026-09-19 10:05:00', unit: 1 },
      { no: SNAP_WIN[0], at: '2026-09-19 10:06:00', unit: 1 },      // 同一件第 2 帧
      { no: SNAP_WIN[0], at: '2026-09-19 10:07:00', unit: 1 },      // 同一件第 3 帧
      { no: SNAP_WIN[0], at: '2026-09-19 10:08:00', unit: 2 },
      { no: SNAP_WIN[0], at: '2026-09-19 10:09:00', unit: 2 },      // 第二件第 2 帧
      { no: SNAP_WIN[0], at: '2026-09-19 10:10:00', unit: 3 },      // 第三件 1 帧
      { no: SNAP_WIN[1], at: '2026-09-19 09:05:00', unit: null },   // **缺件序号**（当班窗口内的真行）
      { no: SNAP_OUT, at: '2026-09-19 07:30:00', unit: 9 }          // 上一班（行仍在库内）
    ];
    SNAP_FRAMES.forEach(f => insSnapMeasure.run('EQ-SNAP', f.no, f.unit, f.at, SNAP_NOW));
    /* 期望值：全部由上面这张帧表现算（`FR-4.2` / C-111 的判据＝当班窗口内、`unit_index` 非空、
       按 `(proc_order_no, unit_index)` 去重后的**件数**）。 */
    const snapWinFrames = SNAP_FRAMES.filter(f => inSnapWin(f.at));
    const expectStartedPieces = new Set(
      snapWinFrames.filter(f => f.unit !== null).map(f => f.no + '|' + f.unit)).size;
    const snapWinRows = snapWinFrames.length;                             // 当班窗口内的**行数**（含 NULL 那条）
    const snapNullInWin = snapWinFrames.filter(f => f.unit === null).length;
    const snapWinTickets = new Set(snapWinFrames.map(f => f.no)).size;    // "按票计"会得到的读数
    /* ⚠ 必须走**同一个公开取数口** `snapshot()`；`config` 只在注入时显式给出
       （`createStateSnapshot` 的 `config` 缺省才回落真配置 ⇒ 不能传 `undefined` 覆盖）；
       库句柄显式传入 ⇒ 现场甲／乙／空库各自独立，互不污染。 */
    const snapWith = (d, cfgIn) => snapSvc.createStateSnapshot(Object.assign(
      { db: d, now: () => new Date(SNAP_NOW.replace(' ', 'T')) },
      cfgIn ? { config: cfgIn } : {}
    ))().stats;
    const snapE = snapWith(snapDb, null);
    const expectPlanQty = SNAP_WIN.reduce((s, no) => s + SNAP_PLAN[no], 0);   // 无 plan_start_time 的票不参与
    t.check('九 · 当班票级取数（`E65` 裁定③＋①）：`planQty` ＝ **当班窗口内** `task.plan_qty` 之和、' +
      '`orderTotal` ＝ 当班**派工票数** —— 无 `plan_start_time` 的票（99 件）与计划开工在**上一班**的票' +
      '（88 件）**都整票不参与**；且快照**不再**取 `board.config.production.planQty`',
      snapE.planQty === expectPlanQty && snapE.orderTotal === SNAP_WIN.length &&
      snapE.planQty !== SNAP_PLAN[SNAP_NO_START] && snapE.planQty !== SNAP_PLAN[SNAP_OUT] &&
      snapE.planQty !== PROD_CFG.planQty,
      `内存库：四票（${SNAP_WIN[0]}=10 / ${SNAP_WIN[1]}=20 在窗内；${SNAP_NO_START}=99 无 plan_start_time；` +
      `${SNAP_OUT}=88 计划开工 07:00 在上一班）⇒ ` +
      `快照 planQty=${snapE.planQty}（期望 Σ 窗内 plan_qty=${expectPlanQty}）、orderTotal=${snapE.orderTotal}` +
      `（期望 ${SNAP_WIN.length} 票）；` +
      `配置的 production.planQty=${PROD_CFG.planQty}（未取用）`);

    /* ② **按件去重**（`E69` 的修复点；C-111 §0.2 的计量单位）：同一件推 3 帧 ＋ 第二件 2 帧 ＋ 第三件 1 帧
       ⇒ 开工数是**件数**，不是帧数、也不是票数。本现场刻意让三个读数**互不相等**（件 3 / 行 7 / 票 2），
       故"不去重"（⇒7）、"按票计"（⇒2）、"忽略取数"（⇒0）三种回退都当场变红。 */
    t.check('九 · `FR-4.2` 开工数**按件去重**（`unit_index` 去重；`E69`／C-111）：同一件推 3 帧 ＋ 第二件 2 帧 ' +
      '＋ 第三件 1 帧 ⇒ `startedQty` ＝ **件数**（**不是**帧行数、**不是**派工票数）',
      snapE.startedQty === expectStartedPieces &&
      snapWinRows > expectStartedPieces && expectStartedPieces !== snapWinTickets &&
      expectStartedPieces > 0 &&
      snapDb.prepare('SELECT COUNT(*) AS c FROM measure_rt WHERE collect_time >= ? AND collect_time < ?')
        .get(WIN.startAt, WIN.endAt).c === snapWinRows &&
      snapE.notStartedQty === expectPlanQty - expectStartedPieces,
      `内存库当班帧 ${snapWinRows} 行（其中 ${snapNullInWin} 行 ` + '`unit_index IS NULL`' + `）；` +
      `去重后件数=${expectStartedPieces}（期望 startedQty=${snapE.startedQty}）；` +
      `对照：按票计会得 ${snapWinTickets}、按行计会得 ${snapWinRows} ⇒ 三个量互不相等；` +
      `notStartedQty=${snapE.notStartedQty}（期望 ${expectPlanQty} − ${expectStartedPieces}）`);

    /* ③ 两道条件各**单独可证伪**：① `unit_index IS NULL` 的当班帧不计入；② 判据落在**当班窗口**
       （把第二件的 2 帧挪到上一班、行仍在库内 ⇒ 开工减 1、未开工加 1，而 `planQty`／`orderTotal` 不变）。 */
    const snapBeforeMoved = snapE;
    /* ⚠ 逐帧挪、且**各挪到一个不同的窗外秒**：`measure_rt` 的唯一键是
       `(equip_code, proc_order_no, collect_time)`（DR-13），两帧挪到同一秒会撞唯一键。 */
    const snapMovedAt = ['2026-09-19 07:28:00', '2026-09-19 07:29:00'];
    const updSnapMoved = snapDb.prepare(
      'UPDATE measure_rt SET collect_time = ? WHERE proc_order_no = ? AND unit_index = ? AND collect_time = ?');
    snapWinFrames.filter(f => f.no === SNAP_WIN[0] && f.unit === 2)
      .forEach((f, i) => updSnapMoved.run(snapMovedAt[i], f.no, f.unit, f.at));
    const snapMoved = snapWith(snapDb, null);
    const snapMovedRowsInWin = snapDb.prepare(
      'SELECT COUNT(*) AS c FROM measure_rt WHERE collect_time >= ? AND collect_time < ?')
      .get(WIN.startAt, WIN.endAt).c;
    t.check('九 · `FR-4.2` 开工取数的**两道过滤**（负向靶子）：① `unit_index IS NULL` 的当班帧**不计入**' +
      '（窗内确有 1 条这样的真行）② 判据落在**当班窗口**（`collect_time` 半开区间）—— ' +
      '把第二件的帧挪到上一班（行仍在库内）⇒ 开工减 1、未开工加 1，而 `planQty`／`orderTotal` 不变。' +
      '去掉 `IS NOT NULL`（⇒ 多算 1 件）或去掉窗口条件（⇒ 不减）都会让本条变红',
      snapNullInWin === 1 &&
      snapE.startedQty === expectStartedPieces &&
      snapMoved.startedQty === snapBeforeMoved.startedQty - 1 &&
      snapMoved.notStartedQty === snapBeforeMoved.notStartedQty + 1 &&
      snapMoved.planQty === snapBeforeMoved.planQty && snapMoved.orderTotal === snapBeforeMoved.orderTotal &&
      snapMovedRowsInWin === snapWinRows - 2,
      `当班窗内缺件序号的行 ${snapNullInWin} 条（不计入 ⇒ 开工 ${snapE.startedQty}＝件数 ${expectStartedPieces}；` +
      `若不去 NULL 则为 ${expectStartedPieces + snapNullInWin}）；` +
      `挪帧前 startedQty=${snapBeforeMoved.startedQty}／notStartedQty=${snapBeforeMoved.notStartedQty}；` +
      `第二件 2 帧挪到 07:30（上一班）后 startedQty=${snapMoved.startedQty}／` +
      `notStartedQty=${snapMoved.notStartedQty}（当班帧 ${snapWinRows} → ${snapMovedRowsInWin} 行）；` +
      `planQty=${snapMoved.planQty}、orderTotal=${snapMoved.orderTotal}（未变）`);

    /* ⑤ **落库列序**（`repo/measure.js` 的 `toParams()` / `INSERT_SQL` 与 `schema.sql` 的列序必须逐位一致）：
       本改动最危险的点是"**按位置绑定**"—— `unit_index` 若落错列**不会报错、只会静默写错列**。
       故这里**逐列按列名回读**（不是只数行数）：给每一列一个互不相同的探针值，回读时"哪一列读到哪个值"
       必须逐一对上；再单独断言 `unit_index` 在**新建库**里的声明位置紧邻 `proc_order_no`
       （需求 V1.41 §7 `DR-04` 的字段次序）。错位一行 ⇒ 至少两列对不上 ⇒ 本条必红。 */
    const measureRepo = require(path.join(ROOT, 'server', 'repo', 'measure.js'));
    const colDb = new DatabaseSync(':memory:');
    memDbApi.initSchema(colDb, SNAP_NOW);
    const COL_PROBE = {
      equipCode: 'EQ-COL', procOrderNo: 'WO-COL', unitIndex: 7,
      depth: 1.11, speed: 2.22, velocity_x: 3.33, velocity_y: 4.44,
      frameRate: 55, gain: 6.6, shutter: 777, cameraDepth: 8.88,
      testStatus: 2, collectTime: '2026-09-19 10:00:00'
    };
    /* 期望：**字段名 → 它该落的列名**（期望值＝"我传进去的那个值"，逐条现算，不写死数值） */
    const COL_OF_FIELD = {
      equipCode: 'equip_code', procOrderNo: 'proc_order_no', unitIndex: 'unit_index',
      depth: 'measure_depth', speed: 'speed', velocity_x: 'velocity_x', velocity_y: 'velocity_y',
      frameRate: 'frame_rate', gain: 'gain', shutter: 'shutter', cameraDepth: 'camera_depth',
      testStatus: 'test_status', collectTime: 'collect_time'
    };
    const colIns = measureRepo.insertFrame(colDb, COL_PROBE, SNAP_NOW);
    const colRow = colDb.prepare(
      'SELECT * FROM measure_rt WHERE equip_code = ? AND proc_order_no = ?')
      .get(COL_PROBE.equipCode, COL_PROBE.procOrderNo);
    const colMismatch = Object.keys(COL_OF_FIELD).filter(f => colRow[COL_OF_FIELD[f]] !== COL_PROBE[f]);
    const measureColOrder = memDbApi.listColumns(colDb, 'measure_rt');
    t.check('九 · **落库列序**（`repo/measure.js` 按位置绑定 ↔ `schema.sql` 列序）：逐**列名**回读 —— ' +
      '13 个字段各自落进自己的列（`unitIndex` → `unit_index`、`depth` → `measure_depth` …），' +
      '且 `unit_index` 在新建库的声明次序**紧邻** `proc_order_no`（V1.41 §7 `DR-04` 字段次序）',
      colIns.inserted === true && colMismatch.length === 0 &&
      measureColOrder.indexOf('unit_index') === measureColOrder.indexOf('proc_order_no') + 1 &&
      colRow.unit_index === COL_PROBE.unitIndex && colRow.created_at === SNAP_NOW,
      `逐列回读：错位列 ${colMismatch.length} 个${colMismatch.length ? '（' + colMismatch.join('、') + '）' : ''}；` +
      `行=${JSON.stringify(colRow)}；列序=[${measureColOrder.join(', ')}]`);
    colDb.close();

    /* ③ 件级按 `judged_at` 落当班窗口：**另起一段独立内存库**（现场乙，与现场甲的件完全无关），
       先只写 4 件当班件取基线，再经**同一个真写入点**补写两件"上一班"的件（1 合格 + 1 待复检），
       再取快照 ⇒ 当班读数**一字不变**。期望值由"窗内件的写入内容"现算（不写死魔数）。 */
    const snapDbB = new DatabaseSync(':memory:');
    memDbApi.initSchema(snapDbB, SNAP_NOW);
    const snapPiece = (result, sec) => ({ result, durationSec: sec });
    const snapInPieces = [snapPiece('合格', 10), snapPiece('合格', 20), snapPiece('不合格', 30), snapPiece('待复检', 40)];
    snapInPieces.forEach((p, i) => resultRepo.upsertJudgement(snapDbB, {
      procOrderNo: SNAP_NG, unitIndex: i + 1, result: p.result,
      judgedAt: `2026-09-19 1${i + 1}:00:00`, now: SNAP_NOW, durationSec: p.durationSec
    }));
    const snapExpectDoneB = snapInPieces.filter(p => resultRepo.DONE_STATUS.includes(p.result)).length;
    /* `E67` 裁定②后的分子集合：**只累加 `DONE_STATUS`（合格＋不合格）的件**（与分母同集合），
       `待复检 40` 这一件**不计**（旧口径 Σ 全部 4 件 ＝ 100 ⇒ 33，是 C·8.4 争议① 的实测读数）。
       ⚠ 该件留在夹具里的唯一理由就是让"这条过滤"是可证伪的一条真过滤 ——
       若实现去掉 `DONE_STATUS.includes(p.result)`，`snapBeforeOut.avgTestSec` 会当场变成
       `Math.round(100 / 3) = 33`、与下面现算的期望不等 ⇒ 本条必红（`D22` 靶子）。 */
    const snapExpectDurB = snapInPieces.reduce(
      (s, p) => s + (resultRepo.DONE_STATUS.includes(p.result) ? p.durationSec : 0), 0);
    const expectAvgB = snapExpectDoneB > 0
      ? Math.round(snapExpectDurB / snapExpectDoneB) : 0;
    const snapBeforeOut = snapWith(snapDbB, null);
    resultRepo.upsertJudgement(snapDbB, {
      procOrderNo: SNAP_NG, unitIndex: 91, result: resultRepo.STATUS.PASS,
      judgedAt: '2026-09-19 07:30:00', now: SNAP_NOW, durationSec: 500
    });
    resultRepo.upsertJudgement(snapDbB, {
      procOrderNo: SNAP_NG, unitIndex: 92, result: resultRepo.STATUS.RETEST,
      judgedAt: '2026-09-19 07:31:00', now: SNAP_NOW, durationSec: 600
    });
    const snapAfterOut = snapWith(snapDbB, null);
    const snapRowsB = resultRepo.countByTask(snapDbB, SNAP_NG);
    t.check('九 · 当班件级取数（`E65` 裁定②）：`judged_at` 落在**上一班**的件不计入当班 —— ' +
      '经真写入点补写 2 件（合格／待复检）⇒ `doneQty`／`passQty`／`retestQty`／`avgTestSec` **一字不变**',
      snapAfterOut.doneQty === snapBeforeOut.doneQty &&
      snapAfterOut.passQty === snapBeforeOut.passQty &&
      snapAfterOut.retestQty === snapBeforeOut.retestQty &&
      snapAfterOut.avgTestSec === snapBeforeOut.avgTestSec &&
      snapBeforeOut.doneQty === snapExpectDoneB && snapBeforeOut.avgTestSec === expectAvgB,
      `补写前 doneQty=${snapBeforeOut.doneQty}／passQty=${snapBeforeOut.passQty}／` +
      `retestQty=${snapBeforeOut.retestQty}／avgTestSec=${snapBeforeOut.avgTestSec}；` +
      `补写 2 件（07:30／07:31）后 doneQty=${snapAfterOut.doneQty}／passQty=${snapAfterOut.passQty}／` +
      `retestQty=${snapAfterOut.retestQty}／avgTestSec=${snapAfterOut.avgTestSec}` +
      `（期望 Σ 已完成件的件级时长 ${snapExpectDurB}s ÷ ${snapExpectDoneB} 件 ＝ ${expectAvgB}s，` +
      `集合＝DONE_STATUS；库内 result 行数=${snapRowsB}（含上一班 2 件 ⇒ 窗口条件确实在生效）`);
    snapDbB.close();

    /* ③b **跨零点窗口**（座位 5 的 C·8.2.5 第 1 条实测形态；C·8.4(b) 指出：门禁里**没有任何断言**
       守着"班次窗口右端点落在次日 00:00:00"这个形态 —— 本段就是补那个覆盖缺口）。
       现场（**独立内存库**，与甲/乙无关）：注入 `2026-09-19T20:00:00` ⇒ 当班＝**中班**
       `[2026-09-19 16:00:00, 2026-09-20 00:00:00)`（`shift.js` 的 `end === 24 ⇒ endAt 收在次日 0 点`）。
       四类输入各**刻意给出窗内/窗外两侧**（否则断言无判别力）：
         · 票：`plan_start_time` 16:00:00／23:30:00 计入、15:30:00 与无 `plan_start_time` 不计；
         · 帧：16:05:00／23:35:00 计入、15:55:00 不计 ⇒ 两票"已在测"；
         · 件：`judged_at` 16:00:00／23:59:59 计入、15:59:59 与 **次日 00:00:00** 不计（**半开区间**）。
       期望值全部由"我写进库的内容"**现算**（不写死魔数）；
       另加一条**构造自检**：窗口必须真的跨日（若哪天班次配置改掉，本段不成立、当场可见）。 */
    const SNAP_MID_NOW = '2026-09-19 20:00:00';                 // ⇒ 中班 [16:00, 次日 00:00)
    const snapMidShift = shifts.current(createClock({ mode: 'fixed', at: SNAP_MID_NOW.replace(' ', 'T') }));
    const MID_START = snapMidShift.startAt, MID_END = snapMidShift.endAt;
    const inMidWin = t0 => String(t0) >= MID_START && String(t0) < MID_END;
    t.check('九 · **跨零点窗口**构造自检：注入 20:00 ⇒ 当班＝中班、`endAt` 落在**次日 00:00:00**' +
      '（右端点是**开**区间；`shift.js` 的 `end === 24` 分支）',
      inMidWin(MID_START) && !inMidWin(MID_END) &&
      MID_START.slice(0, 10) !== MID_END.slice(0, 10) && MID_END.endsWith('00:00:00'),
      `窗口 ${MID_START} ~ ${MID_END}；起点在窗内=true、**右端点在窗内=false**（半开）、两端口日期不同=true`);
    if (inMidWin(MID_START) && !inMidWin(MID_END)) {
      const snapDbM = new DatabaseSync(':memory:');
      memDbApi.initSchema(snapDbM, SNAP_MID_NOW);
      /* 票：t0 刻意取窗内/窗外共四个值（末一个 `plan_start_time` 为空 ⇒ 整票不参与） */
      const MID_TASKS = [
        { no: 'WO-MID-IN-1', qty: 10, t0: '2026-09-19 16:00:00' },
        { no: 'WO-MID-IN-2', qty: 20, t0: '2026-09-19 23:30:00' },
        { no: 'WO-MID-OUT', qty: 88, t0: '2026-09-19 15:30:00' },
        { no: 'WO-MID-NOSTART', qty: 99, t0: null }
      ];
      const insMidTask = snapDbM.prepare(
        'INSERT INTO task(proc_order_no, product_code, plan_qty, plan_start_time, status, created_at, updated_at)' +
        ' VALUES(?,?,?,?,?,?,?)');
      MID_TASKS.forEach(x => insMidTask.run(x.no, 'P-MID', x.qty, x.t0, '待测试', SNAP_MID_NOW, SNAP_MID_NOW));
      /* 帧：窗内 16:05／16:06／23:35（**带件序号**，`IN-1` 两件、`IN-2` 一件）、
         窗内 23:36（**缺件序号** ⇒ 不计入开工件数）、窗外 15:55（上一班） */
      const insMidMeasure = snapDbM.prepare(
        'INSERT INTO measure_rt(equip_code, proc_order_no, unit_index, collect_time, created_at) VALUES(?,?,?,?,?)');
      const MID_FRAMES = [
        { no: 'WO-MID-IN-1', at: '2026-09-19 16:05:00', unit: 1 },
        { no: 'WO-MID-IN-1', at: '2026-09-19 16:06:00', unit: 2 },
        { no: 'WO-MID-IN-2', at: '2026-09-19 23:35:00', unit: 5 },
        { no: 'WO-MID-IN-2', at: '2026-09-19 23:36:00', unit: null },
        { no: 'WO-MID-OUT', at: '2026-09-19 15:55:00', unit: 9 }
      ];
      MID_FRAMES.forEach(x => insMidMeasure.run('EQ-MID', x.no, x.unit, x.at, SNAP_MID_NOW));
      /* 件：窗内 16:00:00／23:59:59；窗外 15:59:59 与**次日 00:00:00**（右端点） */
      const MID_PIECES = [
        { result: '合格', sec: 10, at: '2026-09-19 16:00:00' },
        { result: '不合格', sec: 20, at: '2026-09-19 23:59:59' },
        { result: '合格', sec: 500, at: '2026-09-19 15:59:59' },
        { result: '合格', sec: 600, at: '2026-09-20 00:00:00' }
      ];
      MID_PIECES.forEach((p, i) => resultRepo.upsertJudgement(snapDbM, {
        procOrderNo: 'WO-MID-IN-1', unitIndex: i + 1, result: p.result,
        judgedAt: p.at, now: SNAP_MID_NOW, durationSec: p.sec
      }));
      /* ⚠ 必须给 `now` —— 段内共用的 `snapWith(d, cfg)` 把时钟**写死**在 `SNAP_NOW`（12:00 早班），
         跨零点现场要用**另一个**注入时刻（20:00 中班），故本段自建同规格的取数口，一律显式传 now。 */
      const snapMidWith = d => snapSvc.createStateSnapshot(
        { db: d, now: () => new Date(SNAP_MID_NOW.replace(' ', 'T')) })().stats;
      const snapMid = snapMidWith(snapDbM);
      const midInTasks = MID_TASKS.filter(x => x.t0 !== null && inMidWin(x.t0));
      const midInFrames = MID_FRAMES.filter(x => inMidWin(x.at));
      /* 开工件数（`FR-4.2` / C-111）：窗内、`unit_index` 非空、按 `(proc_order_no, unit_index)` 去重 */
      const midExpectStarted = new Set(
        midInFrames.filter(x => x.unit !== null).map(x => x.no + '|' + x.unit)).size;
      const midNullInWin = midInFrames.filter(x => x.unit === null).length;
      const midInPieces = MID_PIECES.filter(p => inMidWin(p.at));
      const midExpectDone = midInPieces.filter(p => resultRepo.DONE_STATUS.includes(p.result)).length;
      const midExpectDurSum = midInPieces.reduce(
        (s, p) => s + (resultRepo.DONE_STATUS.includes(p.result) ? p.sec : 0), 0);
      const midExpectAvg = midExpectDone > 0 ? Math.round(midExpectDurSum / midExpectDone) : 0;
      /* 反证用的"错口径"读数（**不落盘**，只用来在失败详情里说明本条有判别力）：
         右端点若被当成闭区间，次日 00:00:00 那件 600s 会进分子。 */
      const midWrongAvgIfClosed = midExpectDone > 0
        ? Math.round((midExpectDurSum + 600) / midExpectDone) : 0;
      t.check('九 · **跨零点窗口**（中班 [16:00, 次日 00:00)）：票按 `plan_start_time`、件按 `judged_at`、' +
        '开工件按帧的 `collect_time` **半开区间**落当班 —— 16:00:00 与 23:59:59 计入，15:59:59 与**次日 00:00:00** 不计；' +
        '`orderTotal` 只数当班**票数**，`startedQty` 只数当班**件数**（窗内 `unit_index` 非空且去重）',
        snapMid.planQty === midInTasks.reduce((s, x) => s + x.qty, 0) &&
        snapMid.orderTotal === midInTasks.length &&
        snapMid.startedQty === midExpectStarted &&
        midExpectStarted !== midInFrames.length &&
        snapMid.notStartedQty === midInTasks.reduce((s, x) => s + x.qty, 0) - midExpectStarted &&
        snapMid.doneQty === midExpectDone && snapMid.avgTestSec === midExpectAvg &&
        snapMid.planQty !== MID_TASKS[2].qty + MID_TASKS[3].qty &&
        snapMid.avgTestSec !== midWrongAvgIfClosed,
        `内存库（:memory:）：四票（16:00=10／23:30=20 在窗内；15:30=88 在上一班；无 plan_start_time=99）⇒ ` +
        `planQty=${snapMid.planQty}（期望 ${midInTasks.reduce((s, x) => s + x.qty, 0)}）、orderTotal=${snapMid.orderTotal}` +
        `（期望 ${midInTasks.length} 票）、startedQty=${snapMid.startedQty}` +
        `（期望 ${midExpectStarted}＝窗内**去重件数**；窗内帧 ${midInFrames.length} 行、其中 ${midNullInWin} 行无件序号）；` +
        `四件（16:00:00 合格／23:59:59 不合格 在窗内；15:59:59／次日 00:00:00 在窗外）⇒ ` +
        `doneQty=${snapMid.doneQty}（期望 ${midExpectDone}）、avgTestSec=${snapMid.avgTestSec}` +
        `（期望 Σ${midExpectDurSum}s ÷ ${midExpectDone} ＝ ${midExpectAvg}s；` +
        `右端点若被当成闭区间会是 ${midWrongAvgIfClosed}s ⇒ 本条对"半开区间"有判别力）`);
      snapDbM.close();
    }

    const taskTotalKeyCount = Object.keys(snapMoved).filter(k => k === 'taskTotal').length;
    const snapStatsKeyCount = Object.keys(snapMoved).length;

    /* ④f `E65` 返回值改名（偏差③）：`orderTotal` 在场、旧键 `taskTotal` 不存在 */
    t.check('九 · 返回值改名（`E65` 偏差③）端到端：快照 stats 里 `orderTotal` **在场**、' +
      '旧键 `taskTotal` **不存在**（逐键断言，防"改名只改了一半"）',
      Object.prototype.hasOwnProperty.call(snapMoved, 'orderTotal') && taskTotalKeyCount === 0,
      `stats 键共 ${snapStatsKeyCount} 个；orderTotal=${snapMoved.orderTotal}、taskTotal 出现次数=${taskTotalKeyCount}`);

    /* ④d 空库：四项比率与时长一律 0 且全部 `Number.isFinite`（无 NaN／Infinity 传到界面） */
    const emptyDb = new DatabaseSync(':memory:');
    memDbApi.initSchema(emptyDb, SNAP_NOW);
    const emptyStats = snapWith(emptyDb, null);
    const emptyRates = [emptyStats.capacityRate, emptyStats.firstPassRate, emptyStats.avgTestSec, emptyStats.oee];
    t.check('九 · 空库（无 `task`／`measure_rt`／`result` 行）：`planQty`／`startedQty`／`doneQty` ＝ 0，' +
      '且四个比率/时长全部为有限数（不得出 NaN／Infinity）',
      emptyStats.planQty === 0 && emptyStats.startedQty === 0 && emptyStats.doneQty === 0 &&
      emptyStats.capacityRate === 0 && emptyStats.firstPassRate === 0 &&
      emptyStats.avgTestSec === 0 && emptyStats.oee === 0 && emptyRates.every(Number.isFinite),
      `实测 planQty=${emptyStats.planQty} startedQty=${emptyStats.startedQty} doneQty=${emptyStats.doneQty}；` +
      `capacityRate=${emptyStats.capacityRate} firstPassRate=${emptyStats.firstPassRate} ` +
      `avgTestSec=${emptyStats.avgTestSec} oee=${emptyStats.oee}；逐项 isFinite=${emptyRates.every(Number.isFinite)}`);
    emptyDb.close();

    /* ④e 注入 `boardConfig`（**内存副本**，不碰真配置、不落盘）：把 `production.planQty` 改成 9999 ⇒
       快照 `planQty` 不变（仍＝ Σ 当班 task.plan_qty）。若有人把 `statsOf()` 改回读配置演示值，本条必红。 */
    const snapCfgInjected = JSON.parse(JSON.stringify(cfg));   // 整份配置的内存副本
    snapCfgInjected.production.planQty = 9999;
    const snapInjected = snapWith(snapDb, snapCfgInjected);
    t.check('九 · 当班计划数**不取**配置演示值（`E65` 裁定③）：把注入配置的 `production.planQty` 改成 9999 ⇒ ' +
      '快照 `planQty` **一字不变**（仍 ＝ Σ 当班 `task.plan_qty`）',
      snapInjected.planQty === snapMoved.planQty && snapInjected.planQty === expectPlanQty &&
      PROD_CFG.planQty !== 9999 && snapInjected.planQty !== 9999,
      `注入副本 production.planQty=9999 ⇒ 快照 planQty=${snapInjected.planQty}` +
      `（对照组 ${snapMoved.planQty}／Σ 窗内 plan_qty=${expectPlanQty}）；真配置未被改动＝` +
      `${PROD_CFG.planQty}`);

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

/* ---------------- 十一、A1：`addRunSec` 上界重设（ADR-0009 D3） ----------------
   依据：`server/services/stats.js:207-247`（旧上界 `≤ runSec` 的病灶 ＋ 新上界 `≤ elapsedSec` 的三条依据）。
   期望值**构成性推导**（D21）：下面先由**入参形态**把"旧形态下 `runSec` 恒 0"推出来（无采集串 ⇒ 不按
   采集条数截断；无「测试中」件 ⇒ 不按班次进度兜底），再断言"同一组输入下 3600 被收下且累计真的 +3600"。
   于是"旧上界会对任何非零增量抛错"这句话在本段里是**可复算的**，不是从注释抄的。 */
t.section('十一、A1：`addRunSec` 上界重设 —— 旧上界形态必红 / 新形态必绿 / `elapsedSec + 1` 必抛');
{
  const A1_SHIFT = Object.freeze({
    name: '早班', date: '2026-10-02', startAt: '2026-10-02 08:00:00', endAt: '2026-10-02 16:00:00',
    totalSec: 8 * 3600, elapsedSec: 7 * 3600
  });
  /** 与 ADR-0009 D3② 的现场同形的入参：**无采集串 ＋ 无「测试中」件** */
  const A1_INPUT = Object.freeze({
    shift: A1_SHIFT, orders: [], pieces: [], measures: [],
    now: '2026-10-02 15:00:00',
    accum: { daySec: 0, monthSec: 0, yearSec: 0, at: '2026-10-02 15:00:00' }
  });
  const a1Run = (over) => {
    try { return { ok: true, value: stats.computeShiftStats(Object.assign({}, A1_INPUT, over)) }; }
    catch (err) { return { ok: false, name: err.name, message: String(err.message) }; }
  };

  const baseRun = a1Run({ addRunSec: 0 });
  t.check('A1/D3-1 前提（构成性）：无采集串 ＋ 无「测试中」件 ⇒ **当班实时 `runSec` 恒 0**' +
    '（`measures.length > 0` 为假 ⇒ 不走"按采集条数截断"；`running > 0` 为假 ⇒ 不走"按班次进度兜底"）—— ' +
    '这正是旧上界 `≤ runSec` 的病灶现场，也是本段后面那条断言的对照量',
    baseRun.ok && baseRun.value.runSec === 0 && baseRun.value.idleSec === A1_SHIFT.elapsedSec &&
    baseRun.value.oee === 0,
    `runSec=${baseRun.ok ? baseRun.value.runSec : 'ERR'}、idleSec=${baseRun.ok ? baseRun.value.idleSec : 'ERR'}、` +
    `elapsedSec=${A1_SHIFT.elapsedSec}（旧上界形态下 addRunSec > 0 即越界 ⇒ 必然抛错）`);

  const ok3600 = a1Run({ addRunSec: 3600 });
  t.check('A1/D3-2 新形态必绿：同一组输入下 `addRunSec = 3600` **不抛错**，且累计**真的 +3600**' +
    '（日/月/年三档同时加；`reset` 三档全 false —— 归零靠周期过滤，不靠 rollAccum）',
    ok3600.ok && ok3600.value.runSec === 0 && ok3600.value.accumulate.daySec === 3600 &&
    ok3600.value.accumulate.monthSec === 3600 && ok3600.value.accumulate.yearSec === 3600 &&
    ok3600.value.accumulate.reset.day === false && ok3600.value.accumulate.reset.month === false &&
    ok3600.value.accumulate.reset.year === false,
    ok3600.ok
      ? `runSec=${ok3600.value.runSec}、accumulate=${JSON.stringify({
        daySec: ok3600.value.accumulate.daySec, monthSec: ok3600.value.accumulate.monthSec,
        yearSec: ok3600.value.accumulate.yearSec, reset: ok3600.value.accumulate.reset })}`
      : `${ok3600.name}: ${ok3600.message}`);

  t.check('A1/D3-3 旧上界形态**必红**（同一输入、同一数字）：`addRunSec = 3600 > runSec = 0` ⇒ ' +
    '旧形态（`> runSec`）必然抛 RangeError —— 这就是"`shift_stat` 一旦接线即爆"（ADR-0009 D3②）的机制',
    baseRun.ok && baseRun.value.runSec === 0 && 3600 > baseRun.value.runSec && ok3600.ok,
    `runSec=${baseRun.value.runSec} < addRunSec=3600 ⇒ 旧形态判越界；而新形态实测` +
    `${ok3600.ok ? '收下并累计 +3600' : '也抛错（' + ok3600.message + '）'}`);

  const over = a1Run({ addRunSec: A1_SHIFT.elapsedSec + 1 });
  t.check('A1/D3-4 界不是空的：`addRunSec = elapsedSec + 1`（= 25201）**仍抛 RangeError**，' +
    '且报错文本里点名上界（`0～25200`）',
    over.ok === false && over.name === 'RangeError' &&
    over.message.indexOf('0～' + A1_SHIFT.elapsedSec) >= 0,
    over.ok ? '未抛错（界被拆掉了）' : `${over.name}: ${over.message.slice(0, 120)}`);

  t.check('A1/D3-5 上界的上界＝`elapsedSec` 本身（闭区间，可取值）：`addRunSec = elapsedSec` ⇒ 收下；' +
    '`elapsedSec + 0.5` ⇒ 拒收',
    a1Run({ addRunSec: A1_SHIFT.elapsedSec }).ok === true &&
    a1Run({ addRunSec: A1_SHIFT.elapsedSec + 0.5 }).ok === false,
    `elapsedSec=${A1_SHIFT.elapsedSec}：取等号${a1Run({ addRunSec: A1_SHIFT.elapsedSec }).ok ? '收下' : '被拒'}、` +
    `+0.5${a1Run({ addRunSec: A1_SHIFT.elapsedSec + 0.5 }).ok ? '收下' : '被拒'}`);

  t.check('A1/D3-6 非有限数与负数仍一律拒收（重设上界**不是**"放宽成不校验"）：`NaN`／`Infinity`／`-1` 三种都抛',
    a1Run({ addRunSec: NaN }).ok === false && a1Run({ addRunSec: Infinity }).ok === false &&
    a1Run({ addRunSec: -1 }).ok === false && a1Run({ addRunSec: 0 }).ok === true,
    `NaN/Infinity/-1 均抛；\`addRunSec = 0\` 合法（"本周期确实没有新增运行"是合法读数，不是缺值）`);

  t.check('A1/D3-7 缺省仍是 **0**（不是"当班已运行时长"）：不传 `addRunSec` ⇒ 累计不涨' +
    '（旧实现缺省取 `runSec`，会把"累计值当增量"重复相加）',
    (() => {
      const noAdd = a1Run({ addRunSec: undefined });
      return noAdd.ok && noAdd.value.accumulate.daySec === 0;
    })(),
    `不传 ⇒ accumulate.daySec=${(() => { const x = a1Run({ addRunSec: undefined }); return x.ok ? x.value.accumulate.daySec : 'ERR'; })()}`);
}

/* ---------------- 十二、A1：DR-17 三档**改真源**（对 `shift_stat` 求和）＋ 跨零点/跨月归属 ----------------
   依据：`server/services/stateSnapshot.js:350-380`（`statsOf()`：`sumRunSec` ＋ `getShiftRow` ⇒ `addRunSec`）。
   本段用一个 **`:memory:` 临时库**自铺 `shift_stat` 行（走 DR-06 的唯一写入口），再按三档求和 ＋
   当班增量复算期望值；**不给被测实现喂任何"已算好的累计值"** ⇒ 验的是"它自己去库里求和"。
   已知口径（如实登记，不当期望值用）：①`accumulate.reset` 三档恒 false（归零靠周期过滤）；
   ②跨零点班次按 DR-06 整班归属"班次开始那天"（故次日凌晨不计入次日"当日累计"）；
   ③跨零点时当班**未固化**增量整段计入 `now` 所在自然日（`accumulateRunTime` 只有一个增量入参）
   —— 现配置 0-8/8-16/16-24 **无跨零点班次**，②③ 当前不可达，本段只用**已登记的整班归属口径**断言。 */
t.section('十二、A1：DR-17 三档改真源（对 `shift_stat` 求和）、跨零点归属与"不重复累加"');
{
  const { DatabaseSync } = require('node:sqlite');
  const dbMod = require('../server/db');
  /** 本段自己的**可推进注入时钟**（不借用别段的局部变量；起点＝2026-09-19 10:00:00 = 早班内） */
  const clock = createClock({ mode: 'fixed', at: '2026-09-19T10:00:00' });
  const A1_DB = new DatabaseSync(':memory:');
  let a1Snapshot = null;
  try {
    dbMod.initSchema(A1_DB, '2026-09-19 10:00:00');
    const T = '2026-09-19 10:00:00';
    const putShift = (date, name, runSec, passRate, oee) => shiftStatRepo.upsertFrozen(A1_DB, {
      shiftDate: date, shiftName: name, planQty: 0, startedQty: 0, finishedQty: 0,
      qualifiedQty: 0, failedQty: 0, retestQty: 0,
      passRate, runSec, idleSec: 0, oee, frozenAt: T, createdAt: T
    });
    putShift('2026-09-18', '晚班', 60, 50, 5);      // 前一天（用于跨零点/跨日对照）
    putShift('2026-09-19', '早班', 600, 90, 20.8);   // 当班已固化
    putShift('2026-09-19', '中班', 60, 80, 2);       // 同日、另一班次
    /* 09-19 的采样帧：**恰 4 条**（10:00:01～10:00:04）⇒ 按 `E68` 的无条件截断口径，当班实时
       `runSec = min(elapsedSec, 帧数 − 1)`；这是"当班增量"的独立来源（本段不复用被测实现算它）。 */
    const insFrame = A1_DB.prepare(
      `INSERT INTO measure_rt(equip_code, proc_order_no, unit_index, collect_time, created_at)
       VALUES(?, ?, ?, ?, ?)`);
    for (let i = 1; i <= 4; i++) {
      insFrame.run('EQ-L', 'WO-L', null, `2026-09-19 10:00:0${i}`, `2026-09-19 10:00:0${i}`);
    }
    const liveRunSecAt = (text) => {
      const d = text.slice(0, 10);
      const frames = A1_DB.prepare(
        `SELECT COUNT(*) AS c FROM measure_rt WHERE collect_time >= ? AND collect_time < ?`).get(
        `${d} 08:00:00`, `${d} 16:00:00`).c;
      return frames > 0 ? Math.min(6 * 3600, Math.max(0, frames - 1)) : 0;
    };
    a1Snapshot = stateSnapshotSvc.createStateSnapshot({
      db: A1_DB,
      now: () => clock.now(),
      config: cfg
    });

    /* ① 当班已固化 600 ⇒ 实时 3 ⇒ 增量为 max(0, 3 − 600) = 0；三档＝对库求和 */
    const acc1 = a1Snapshot().stats.accumulate;
    const live1 = liveRunSecAt('2026-09-19 10:00:00');
    const sums1 = shiftStatRepo.sumRunSec(A1_DB, { day: '2026-09-19', month: '2026-09', year: '2026' });
    t.check('A1/D4-1 三档＝**对 `shift_stat` 求和**（归属键＝`shift_date`）：日档 600+60=660、月档＋前一日 60 ⇒ 720、' +
      '年档同月档；且当班增量 `max(0, 实时 3 − 已固化 600) = 0` ⇒ 日档不再加任何东西（**已固化部分不重复相加**）',
      acc1.daySec === 660 && acc1.monthSec === 720 && acc1.yearSec === 720 &&
      sums1.daySec === 660 && live1 === 3 &&
      Number.isInteger(sums1.undetermined.day) && sums1.rows === 3,
      `日=${acc1.daySec}（Σ=${sums1.daySec} ＋ 增量 0）、月=${acc1.monthSec}、年=${acc1.yearSec}；` +
      `当班实时 runSec=${live1}、已固化 600、全表 ${sums1.rows} 行`);

    t.check('A1/D4-2 归零靠**周期过滤**、不靠 `rollAccum`：`accumulate.reset` 三档恒 false；' +
      '且 `at` 是**注入时钟那一刻**的读数（这里钉住的是 `stateSnapshot.lastRunAccum.at` 的 DR-16 定长文本口径，' +
      '因为 `services/stats.js` 的 `accumulate.at` 是 `rollAccum` 原样回传的 `toDate(now)`＝**Date 对象**）',
      acc1.reset.day === false && acc1.reset.month === false && acc1.reset.year === false &&
      a1Snapshot.lastRunAccum && a1Snapshot.lastRunAccum.at === '2026-09-19 10:00:00' &&
      a1Snapshot.lastRunAccum.source.sum === 'shift_stat.sumRunSec' &&
      a1Snapshot.lastRunAccum.source.current === 'shift_stat.getShiftRow',
      `reset=${JSON.stringify(acc1.reset)}、accumulate.at=${JSON.stringify(acc1.at)}、` +
      `lastRunAccum.at=${a1Snapshot.lastRunAccum && a1Snapshot.lastRunAccum.at}、` +
      `取数来源=${JSON.stringify(a1Snapshot.lastRunAccum && a1Snapshot.lastRunAccum.source)}`);

    t.check('A1/D4-3 跨零点/跨月**归属由 `shift_date` 承载**：前一日 09-18 的 60 秒**不进** 09-19 的日档，' +
      '但**进**月/年档（同一份数据、两个周期口径的读数差恰好是它）',
      acc1.daySec === 660 && acc1.monthSec === 720 && acc1.monthSec - acc1.daySec === 60,
      `日=${acc1.daySec}、月=${acc1.monthSec}（差 ${acc1.monthSec - acc1.daySec}＝09-18 晚班那一行的 run_sec）`);

    /* ② 换到中班（同一天、已固化 60）：三档**逐位不变**（同一批行、同一周期）—— 现算求和 ⇒ 同刻连读一致 */
    clock.at('2026-09-19T18:00:00');                 // 中班
    const acc2 = a1Snapshot().stats.accumulate;
    t.check('A1/D4-4 **同班次重复读不重复累加**：同一自然日内换班次、再读一次 ⇒ 三档**逐位相同**' +
      '（求和是"每次现算"、不是"上次结果 + 增量"）；变的只有 `at`',
      acc2.daySec === acc1.daySec && acc2.monthSec === acc1.monthSec && acc2.yearSec === acc1.yearSec &&
      acc2.at !== acc1.at,
      `第一次 ${JSON.stringify({ daySec: acc1.daySec, monthSec: acc1.monthSec, yearSec: acc1.yearSec, at: acc1.at })}；` +
      `第二次 ${JSON.stringify({ daySec: acc2.daySec, monthSec: acc2.monthSec, yearSec: acc2.yearSec, at: acc2.at })}`);

    /* ③ 同一班次内连读两次（时钟前进 1 分钟）⇒ 三档仍逐位相同 */
    clock.advanceMin(1);
    const acc3 = a1Snapshot().stats.accumulate;
    t.check('A1/D4-5 同一班次内连读两次（时钟 +1 min）⇒ 三档**逐位相同**（幂等：现算求和，不是累加器）',
      acc3.daySec === acc2.daySec && acc3.monthSec === acc2.monthSec && acc3.yearSec === acc2.yearSec,
      `${JSON.stringify({ daySec: acc2.daySec, monthSec: acc2.monthSec, yearSec: acc2.yearSec })} 与 ` +
      `${JSON.stringify({ daySec: acc3.daySec, monthSec: acc3.monthSec, yearSec: acc3.yearSec })}`);

    /* ④ 跨自然日：直接跳到 2026-09-20 00:30（**用 `at()` 钉死，不靠累加分钟数** —— 累加易算错，
       也把"这一条到底在看哪个时刻"变得不可读）。该时刻属**晚班**、按 DR-06 归属日＝2026-09-20。
       库里**没有** 09-20 的行 ⇒ 日档为**真 0**（不是"算不出来"）；月/年档保留（跨日不清月/年）。
       增量侧：晚班窗口 [00:00,08:00) 内没有采集帧且无「测试中」件 ⇒ 实时 `runSec` = 0 ⇒ 增量 0。 */
    clock.at('2026-09-20T00:30:00');
    const acc4 = a1Snapshot().stats.accumulate;
    const sums4 = shiftStatRepo.sumRunSec(A1_DB, { day: '2026-09-20', month: '2026-09', year: '2026' });
    t.check('A1/D4-6 **跨自然日**（FR-6.4）：日档＝按 `shift_date = 2026-09-20` 求和（库里 0 行 ⇒ **真 0**）' +
      '＋ 当班增量 0；而**月/年档保留** 720（跨日不清更大周期）',
      acc4.daySec === sums4.daySec && sums4.daySec === 0 && acc4.monthSec === 720 && acc4.yearSec === 720 &&
      sums4.undetermined.day === 0 &&
      a1Snapshot.lastRunAccum.currentShift.date === '2026-09-20' &&
      a1Snapshot.lastRunAccum.currentShift.name === '晚班',
      `09-20 日档 Σ=${sums4.daySec} ⇒ accumulate.daySec=${acc4.daySec}；月=${acc4.monthSec}、年=${acc4.yearSec}；` +
      `该日"无法判定"行数=${sums4.undetermined.day}（0 行 ⇒ 空档，不是"算不出来"）；` +
      `当班=${a1Snapshot.lastRunAccum.currentShift.date} ${a1Snapshot.lastRunAccum.currentShift.name}、` +
      `addRunSec=${a1Snapshot.lastRunAccum.addRunSec}`);

    /* ⑤ 跨月：直接跳到 2026-10-01 08:30（早班）。月档按 `2026-10` 求和（0 行）⇒ 0；年档仍是全表 720 */
    clock.at('2026-10-01T08:30:00');
    const acc5 = a1Snapshot().stats.accumulate;
    const sums5 = shiftStatRepo.sumRunSec(A1_DB, { day: '2026-10-01', month: '2026-10', year: '2026' });
    t.check('A1/D4-7 **跨月归零**（FR-6.5）：月档＝按 `2026-10` 求和（库里 0 行 ⇒ 0），' +
      '而**年档仍是全表** 720（跨月不清年）',
      acc5.monthSec === sums5.monthSec && sums5.monthSec === 0 && acc5.yearSec === 720 &&
      acc5.daySec === sums5.daySec && sums5.daySec === 0,
      `2026-10 月档 Σ=${sums5.monthSec} ⇒ accumulate.monthSec=${acc5.monthSec}；` +
      `日=${acc5.daySec}、年=${acc5.yearSec}（年档＝全表 3 行之和）`);
  } finally {
    try { A1_DB.close(); } catch { /* 已关 */ }
  }
}

/* ---------------- 十三、`E83` 的两个投影（自然日按零点切段）与 `E128` 跨零点准入闸 ----------------
   立案：技术债 `E83`（口径 2026-10-04 由负责人裁定）＋ `E128`（跨零点配置的防变更守护）。
   本节覆盖**两条投影**与**一道闸**（仓储侧的守据在 `tests\db-check.js` 十之十三）：
     甲⑤ 现配置（0-8／8-16／16-24）**无跨零点班次** ⇒ 两个投影**逐字相同**、且与改动前既有期望值一致；
     乙⑥ 跨零点配置（夜班 22→6）⇒ 自然日投影**按零点切段**（配置**只在测试内构造**、用**注入时钟**推进）；
     乙⑦ `E128`：配置段形态含 `end <= start` 而未声明 `allowCrossMidnight` ⇒ **启动期拒绝**并指名
          "先做 `E83` 的两个投影"；声明了 ⇒ 允许；**裸数组形态**保持放行（有意的取舍）但必须如实自述。
   可证伪性（D22）：M-Y1 把 `assertCrossMidnightAllowed()` 的构成条件改成恒真 ⇒ `E128-1` 必红并指名
   （靶子见 `tests\._verify\t20261004-11-d22-mutation.js`，**字节副本**还原）。
   边界（如实登记，不冒领）：本节只断言"**读数的两个投影**"与"**配置准入**"，**不**动
   `E129`（`statsForShift()` 的采样窗口上限）：**2026-10-05 已修复**（`T-20261005-09`）—— 窗口取数改为
   **按时间范围取全量**（无 `LIMIT`），并由 `harness-check` 第二十二节 `E129-①`／`E129-②` 守着；本节夹具帧数很小，故与它无交互。 */
t.section('十三、`E83` 的两个投影（自然日按零点切段）与 `E128` 跨零点准入闸');
{
  const { DatabaseSync } = require('node:sqlite');
  const dbMod = require('../server/db');

  /* ================= 甲⑤ 无跨零点配置 ⇒ 两投影逐字相同 ================= */
  {
    /* (a) 纯函数层：现配置三段班一个都不跨自然日 ⇒ `splitRunSecondsByDay()` 必须直接返回整段
       （不查半点、不做除法）—— 这是"改动前行为逐字保留"的第一条可证伪点。 */
    const probes = [
      ['2026-09-19T04:00:00', 1200],      // 晚班 0-8
      ['2026-09-19T12:00:00', 3600],      // 早班 8-16
      ['2026-09-19T20:00:00', 2400],      // 中班 16-24
      ['2026-09-19T23:59:59', 60]         // 中班最后一秒（`end = 24` 也不跨自然日）
    ];
    const splits = probes.map(([t0, runSec]) => {
      const sh = shifts.at(t0);
      return { t0, runSec, sh, s: stats.splitRunSecondsByDay(sh, runSec) };
    });
    t.check('E83-甲5-1 现配置（0-8／8-16／16-24）下 `splitRunSecondsByDay()` 走"不跨自然日"那一支：' +
      '`crossing = false`、`day1 = runSec`、`day2 = 0`、两段的日期归属都是**班次开始那天**（不查半点、不做除法）',
      splits.every(x => x.s.crossing === false && x.s.day1 === x.runSec && x.s.day2 === 0 &&
        x.s.day1Date === x.sh.date && x.s.day2Date === x.sh.date),
      splits.map(x => `${x.t0.slice(11)}=${JSON.stringify(x.s)}`).join('；'));

    /* (b) 增量层：`accumulateRunTime()` 的第 4 入参**缺省**（＝`E83` 之前的调用形态）与
       **显式给非跨零点切段**必须给出**逐位相同**的三档读数（期望值由入参构成性给出：660 ＋ 7）。 */
    const prev = { daySec: 660, monthSec: 720, yearSec: 720, at: '2026-09-19T10:00:00' };
    const shapeLegacy = stats.accumulateRunTime(prev, 7, '2026-09-19T12:00:00');
    const shapeSplit = stats.accumulateRunTime(prev, 7, '2026-09-19T12:00:00',
      stats.splitRunSecondsByDay(shifts.at('2026-09-19T12:00:00'), 7));
    const briefShape = o => JSON.stringify({ daySec: o.daySec, monthSec: o.monthSec, yearSec: o.yearSec });
    t.check('E83-甲5-2 `accumulateRunTime()` 的第 4 入参（`E83` 的切段）**缺省**与**显式给非跨零点切段**' +
      '给出逐位相同的三档（`daySec`/`monthSec`/`yearSec` 与 `reset` 全相同）—— 现配置下"多传一个切段"不改变任何读数',
      briefShape(shapeLegacy) === briefShape(shapeSplit) &&
      JSON.stringify(shapeLegacy.reset) === JSON.stringify(shapeSplit.reset) &&
      shapeLegacy.daySec === 667 && shapeLegacy.yearSec === 727,
      `缺省=${briefShape(shapeLegacy)}；给切段=${briefShape(shapeSplit)}；` +
      `reset 相同=${JSON.stringify(shapeLegacy.reset) === JSON.stringify(shapeSplit.reset)}`);

    /* (c) 端到端（真临时库 ＋ 真快照）：三行**全部带切段**（现配置下切段＝整段/0，正是
       `computeShiftStats()` 给出的形态），数字与本章十二 `A1/D4-1` 同一组。 */
    const C_DB = new DatabaseSync(':memory:');
    try {
      dbMod.initSchema(C_DB, '2026-09-19 10:00:00');
      const cClock = createClock({ mode: 'fixed', at: '2026-09-19T10:00:00' });
      const C_T = '2026-09-19 10:00:00';
      const cPut = (date, name, runSec, split) => shiftStatRepo.upsertFrozen(C_DB, Object.assign({
        shiftDate: date, shiftName: name, planQty: 0, startedQty: 0, finishedQty: 0,
        qualifiedQty: 0, failedQty: 0, retestQty: 0, passRate: 90, runSec, idleSec: 0, oee: 10,
        frozenAt: C_T, createdAt: C_T
      }, split));
      cPut('2026-09-18', '晚班', 60, { runSecDay1: 60, runSecDay2: 0 });
      cPut('2026-09-19', '早班', 600, { runSecDay1: 600, runSecDay2: 0 });
      cPut('2026-09-19', '中班', 60, { runSecDay1: 60, runSecDay2: 0 });
      const cSnap = stateSnapshotSvc.createStateSnapshot({ db: C_DB, now: () => cClock.now(), config: cfg });
      cSnap();
      const cL1 = cSnap.lastRunAccum;
      t.check('E83-甲5-3 端到端（真临时库 ＋ 真快照）：现配置下 `naturalDay` 与 `shiftProjection` 的日/月/年' +
        '**三档逐字相等**，且＝**改动前既有断言钉住的那三个数** 660／720／720（本章十二 `A1/D4-1`；' +
        '现配置无跨零点班次 ⇒ 两投影同值是**硬保证**、不是巧合）',
        JSON.stringify(cL1.naturalDay) === JSON.stringify(cL1.shiftProjection) &&
        cL1.naturalDay.daySec === 660 && cL1.naturalDay.monthSec === 720 && cL1.naturalDay.yearSec === 720 &&
        cL1.shiftProjection.daySec === 660 && cL1.shiftProjection.monthSec === 720 && cL1.shiftProjection.yearSec === 720 &&
        cL1.currentShift.crossing === false,
        `naturalDay=${JSON.stringify(cL1.naturalDay)}；shiftProjection=${JSON.stringify(cL1.shiftProjection)}；` +
        `crossing=${cL1.currentShift.crossing}`);

      /* 老行形态（两列 NULL，＝`E83` 之前的行）与已切段的行**并存在同一张表**：读口按
         "整段归开始日"兜底 ⇒ 两投影仍必须逐字相等（日档 600＋60＋30＝690、月/年 750）。 */
      cPut('2026-09-19', '晚班', 30, {});
      cSnap();
      const cL2 = cSnap.lastRunAccum;
      t.check('E83-甲5-4 **老行形态**（两列 `NULL`）与已切段的行**共存**时两个投影仍逐字相等：' +
        'NULL 行按"整段归班次开始日"读 ⇒ 与班次投影同值（日档 600＋60＋30＝**690**、月/年 **750**）',
        JSON.stringify(cL2.naturalDay) === JSON.stringify(cL2.shiftProjection) &&
        cL2.naturalDay.daySec === 690 && cL2.naturalDay.monthSec === 750 && cL2.naturalDay.yearSec === 750 &&
        cL2.shiftProjection.daySec === 690,
        `naturalDay=${JSON.stringify(cL2.naturalDay)}；shiftProjection=${JSON.stringify(cL2.shiftProjection)}`);
    } finally {
      try { C_DB.close(); } catch { /* 已关 */ }
    }
  }

  /* ================= 乙⑥ 跨零点配置 ⇒ 按零点切段 ================= */
  {
    const N_DB = new DatabaseSync(':memory:');
    try {
      dbMod.initSchema(N_DB, '2026-10-04 22:00:00');
      const nClock = createClock({ mode: 'fixed', at: '2026-10-04T23:00:00' });
      /* 配置**只在测试内构造**（不改 `board.config.js`）：夜班 22→6 跨零点、显式开闸（`E128`）；
         另两段把它补成覆盖完整 24 h，免得 `at()` 在别的时刻抛"配置缺口"。 */
      const nightSeg = {
        list: [
          { name: '夜班', start: 22, end: 6 },
          { name: '白班', start: 6, end: 14 },
          { name: '中班', start: 14, end: 22 }
        ],
        allowCrossMidnight: true
      };
      const nRules = createShiftRules(nightSeg);
      const nSnap = stateSnapshotSvc.createStateSnapshot({
        db: N_DB, now: () => nClock.now(), config: { shift: nightSeg }
      });
      /* 10 帧采样（22:00:01～22:00:10，全落在夜班窗口 [22:00, 次日 06:00) 内）
         ⇒ 运行中 `runSec = min(elapsedSec, 帧数 − 1) = 9`（`E68` 的无条件截断口径）。
         ⚠ 帧数很小（10 帧）：`statsForShift()` 的采样窗口上限已由 `E129` 修复为**按时间范围取全量**（无 `LIMIT`；`harness-check` 第二十二节 `E129-①②` 守着）⇒ 无交互。 */
      const insN = N_DB.prepare(
        `INSERT INTO measure_rt(equip_code, proc_order_no, unit_index, collect_time, created_at)
         VALUES(?, ?, ?, ?, ?)`);
      for (let i = 1; i <= 10; i++) {
        const ts = `2026-10-04 22:00:${String(i).padStart(2, '0')}`;
        insN.run('EQ-N', 'WO-N', 1, ts, ts);
      }
      const liveAt = (t0) => { nClock.at(t0); nSnap(); return nSnap.lastRunAccum; };
      const sumOf = (L) => L.currentShift.liveDay1 + L.currentShift.liveDay2;
      const L23 = liveAt('2026-10-04T23:00:00');
      const L0030 = liveAt('2026-10-05T00:30:00');
      const L03 = liveAt('2026-10-05T03:00:00');
      t.check('E83-乙6-1 运行中（零点前 23:00）：切段＝`{day1: 9, day2: 0}`（整段还在班次开始日）、' +
        '`liveDay1 + liveDay2 === liveRunSec`（＝9）、`crossing = true`；自然日档（10-04）＝9 而班次档＝0（尚未固化）',
        L23.currentShift.crossing === true && L23.liveRunSec === 9 &&
        L23.currentShift.liveDay1 === 9 && L23.currentShift.liveDay2 === 0 &&
        sumOf(L23) === L23.liveRunSec &&
        L23.naturalDay.daySec === 9 && L23.shiftProjection.daySec === 0,
        `23:00：live=${L23.currentShift.liveDay1}/${L23.currentShift.liveDay2}（liveRunSec=${L23.liveRunSec}）；` +
        `natural.day=${L23.naturalDay.daySec}、shift.day=${L23.shiftProjection.daySec}`);

      t.check('E83-乙6-2 运行中（次日 00:30）：`liveDay2` 随时刻**推进**（0 → 2）、`liveDay1` 相应变小，' +
        '两段之和仍 **=== `liveRunSec`（9）**；此时自然日档（10-05）只含后段 ⇒ 2，而班次档仍是 0（未固化）',
        L0030.currentShift.liveDay2 > L23.currentShift.liveDay2 &&
        L0030.currentShift.liveDay1 === 7 && L0030.currentShift.liveDay2 === 2 &&
        sumOf(L0030) === L0030.liveRunSec && L0030.liveRunSec === 9 &&
        L0030.naturalDay.daySec === 2 && L0030.shiftProjection.daySec === 0 &&
        L0030.currentShift.date === '2026-10-04',
        `00:30：live=${L0030.currentShift.liveDay1}/${L0030.currentShift.liveDay2}（liveRunSec=${L0030.liveRunSec}）；` +
        `归属日=${L0030.currentShift.date}；natural.day=${L0030.naturalDay.daySec}、shift.day=${L0030.shiftProjection.daySec}`);

      t.check('E83-乙6-3 运行中（次日 03:00）：`liveDay2` 继续增长（2 → 5）、`liveDay1` 继续变小，' +
        '两段之和仍 **=== `liveRunSec`**（两段是**划分**：总额恒定、随时刻在两段间移动）',
        L03.currentShift.liveDay1 === 4 && L03.currentShift.liveDay2 === 5 &&
        L03.currentShift.liveDay2 > L0030.currentShift.liveDay2 &&
        L03.currentShift.liveDay1 < L0030.currentShift.liveDay1 &&
        sumOf(L03) === L03.liveRunSec && L03.liveRunSec === 9,
        `03:00：live=${L03.currentShift.liveDay1}/${L03.currentShift.liveDay2}（liveRunSec=${L03.liveRunSec}）`);

      /* ---- 固化（模拟 `server/index.js` 在班次收口时写 `shift_stat`）：用**真实的班次对象**
         （05:59:59 那一拍：归属日 2026-10-04、整班 28800 s）算切段，整班读数取 180 s。 */
      const nEnd = nRules.at('2026-10-05T05:59:59');
      const nFull = stats.splitRunSecondsByDay(nEnd, 180);
      const nWrite = shiftStatRepo.upsertFrozen(N_DB, {
        shiftDate: nEnd.date, shiftName: nEnd.name, planQty: 0, startedQty: 0, finishedQty: 0,
        qualifiedQty: 0, failedQty: 0, retestQty: 0, passRate: 90, runSec: 180, idleSec: 0, oee: 10,
        runSecDay1: nFull.day1, runSecDay2: nFull.day2,
        frozenAt: '2026-10-05 06:00:00', createdAt: '2026-10-05 06:00:00'
      });
      t.check('E83-乙6-4 **固化后**：写入口落盘的 `run_sec_day1 + run_sec_day2 === run_sec`（180 ＝ 45 ＋ 135）、' +
        '且读回的 `runDays` 是同一份段列表（`[{10-04, 45}, {10-05, 135}]`）—— 恒等式在**真库**上成立',
        nFull.day1 === 45 && nFull.day2 === 135 && nFull.day1 + nFull.day2 === 180 &&
        nWrite.written === true && nWrite.runSecDay1 === 45 && nWrite.runSecDay2 === 135 &&
        JSON.stringify(nWrite.runDays) === JSON.stringify([{ day: '2026-10-04', sec: 45 }, { day: '2026-10-05', sec: 135 }]),
        `切段=${JSON.stringify(nFull)}；落库=${nWrite.runSecDay1}/${nWrite.runSecDay2}；runDays=${JSON.stringify(nWrite.runDays)}`);

      /* ---- ③④ 固化后的两个档（回到 10-04 档读一次、再在 10-05 档读一次） ---- */
      const L04 = liveAt('2026-10-04T23:00:00');
      const L05 = liveAt('2026-10-05T06:30:00');
      t.check('E83-乙6-5 **自然日档与班次档分道**（10-04 档）：natural ＝ `day1` ＝ **45**、' +
        'shift ＝ **整段 180**（`DR-06`：整班归班次开始那天）；两者之差 135 ＝落到次日的那一段',
        L04.naturalDay.daySec === 45 && L04.shiftProjection.daySec === 180 &&
        L04.shiftProjection.daySec - L04.naturalDay.daySec === 135 &&
        L04.currentShift.frozenDay1 === 45 && L04.currentShift.frozenDay2 === 135,
        `10-04 档：natural=${L04.naturalDay.daySec}、shift=${L04.shiftProjection.daySec}；` +
        `frozenDay1/2=${L04.currentShift.frozenDay1}/${L04.currentShift.frozenDay2}`);

      t.check('E83-乙6-6 **自然日档与班次档分道**（10-05 档）：natural ＝ **次日段 `day2`** ＝ 135、' +
        'shift ＝ **0**（`shift_date` 没有任何 10-05 的行 —— 班次投影里这一整班都算在 10-04）',
        L05.naturalDay.daySec === 135 && L05.shiftProjection.daySec === 0 &&
        L05.currentShift.name === '白班' && L05.currentShift.crossing === false,
        `10-05 档：natural=${L05.naturalDay.daySec}、shift=${L05.shiftProjection.daySec}；` +
        `当班=${L05.currentShift.date} ${L05.currentShift.name}`);

      t.check('E83-乙6-7 **不丢秒、不重复计**：两日档之和（45 ＋ 135）＝ **总运行 180**；' +
        '月/年两档在两个投影下都 ＝ **180**（两段必落同月/同年 ⇒ 只有"日"这一档会被零点切开）',
        L04.naturalDay.daySec + L05.naturalDay.daySec === 180 &&
        L04.naturalDay.monthSec === 180 && L04.naturalDay.yearSec === 180 &&
        L04.shiftProjection.monthSec === 180 && L04.shiftProjection.yearSec === 180 &&
        L05.naturalDay.monthSec === 180 && L05.naturalDay.yearSec === 180,
        `日档和=${L04.naturalDay.daySec + L05.naturalDay.daySec}；10-04 月/年 natural=` +
        `${L04.naturalDay.monthSec}/${L04.naturalDay.yearSec}、shift=${L04.shiftProjection.monthSec}/${L04.shiftProjection.yearSec}`);
    } finally {
      try { N_DB.close(); } catch { /* 已关 */ }
    }
  }

  /* ================= 乙⑧ `E132`：跨零点班次在**月末/年末**的月/年归属 =================
     立案（`E132`；座位 5 在 `C·21` 靶子⑥ 报出、主代理登记，2026-10-04）：`splitRunSecondsByDay()`
     早就给出两段各自的**日历归属**（`day1Date`/`day2Date`），但旧 `accumulateRunTime()` 把
     `day1 + day2` **一起**加进 `now` 所在月/年 —— 而它注释里那句"跨零点只可能跨日（两段都落在
     同一个月/年）"**是假的**：零点既是日界、也是**月/年界**。
     危害（实测）：`FR-6.5`（本月累计运行）/`FR-6.6`（本年累计运行）在月末/年末那一班**多算 `day1`**，
     而上月/上年那一段（`rollAccum()` 已把旧档清零）**永久丢失** ⇒ 症状是"月/年累计少了几个小时"。
     现口径（座位 3 的 `E132` 实现，本座实测复核）：**月/年档按各段自己的日历归属聚合**，
     不属于本周期的那几段**不进**本周期档，但**也不静默消失** —— 它们的秒数随只读字段
     **`outOfPeriod{month,year,note}`** 一并报出（"扣掉的秒去哪儿了"可核）。
     本次期望值的来源＝我自己跑 `tests\._verify\t14-e130\e132-expected.js` 的实测读数（不是推导值）：
     夜班 22-6、`10-31 22:00→11-01 06:00`、`now=11-01 00:30` ⇒ 切段 `7200/1800`；**旧实现 `monthSec=9000`、
     现实现 `1800` ＋ `outOfPeriod.month=7200`**。 */
  {
    const nightSeg132 = {
      list: [
        { name: '夜班', start: 22, end: 6 },
        { name: '白班', start: 6, end: 14 },
        { name: '中班', start: 14, end: 22 }
      ],
      allowCrossMidnight: true
    };
    const nRules132 = createShiftRules(nightSeg132);
    /** 一次"跨周期"读数：按真源算切段，再把切段交给记账口（`prev` 带**上一个周期**的已固化档） */
    const readAt132 = (now, prev) => {
      const sh = nRules132.at(now);
      const split = stats.splitRunSecondsByDay(sh, sh.elapsedSec);
      const acc = stats.accumulateRunTime(prev, sh.elapsedSec, now, split);
      return { sh, split, acc, total: sh.elapsedSec };
    };
    const prevOct = { daySec: 33, monthSec: 77777, yearSec: 888888, at: '2026-10-31T23:00:00' };
    const M132 = readAt132('2026-11-01T00:30:00', prevOct);
    t.check('E132-1 **跨月**（夜班 `10-31 22:00 → 11-01 06:00` 在 `11-01 00:30` 被读）：切段 `7200/1800`、' +
      '两段日历归属 `2026-10-31`/`2026-11-01`；**月档只收 1800**（＝11 月那一段；**旧实现给 9000**），' +
      '被扣掉的 7200 记进 `outOfPeriod.month`，且 `月档 ＋ outOfPeriod.month === 本次切段总额`（不多算、也不丢秒）',
      M132.sh.date === '2026-10-31' && M132.split.crossing === true &&
      M132.split.day1 === 7200 && M132.split.day2 === 1800 &&
      M132.split.day1Date === '2026-10-31' && M132.split.day2Date === '2026-11-01' &&
      M132.acc.monthSec === 1800 && M132.acc.monthSec !== 9000 &&
      M132.acc.outOfPeriod !== null && M132.acc.outOfPeriod.month === 7200 &&
      M132.acc.monthSec + M132.acc.outOfPeriod.month === M132.total &&
      M132.acc.daySec === 1800,
      `切段=${JSON.stringify(M132.split)}；monthSec=${M132.acc.monthSec}（旧实现会是 9000）、daySec=${M132.acc.daySec}；` +
      `outOfPeriod.month=${M132.acc.outOfPeriod ? M132.acc.outOfPeriod.month : '（null）'}；` +
      `月档＋outOfPeriod.month=${M132.acc.monthSec + (M132.acc.outOfPeriod ? M132.acc.outOfPeriod.month : 0)}（应=${M132.total}）`);

    const prevDec = { daySec: 44, monthSec: 777, yearSec: 888888, at: '2026-12-31T23:00:00' };
    const Y132 = readAt132('2027-01-01T00:30:00', prevDec);
    t.check('E132-2 **跨年**（夜班 `12-31 22:00 → 次年 01-01 06:00` 在 `2027-01-01 00:30` 被读）：切段 `7200/1800`、' +
      '日历归属 `2026-12-31`/`2027-01-01`；**年档只收 1800**（**旧实现给 9000**），被扣掉的 7200 记进 ' +
      '`outOfPeriod.year`，且 `年档 ＋ outOfPeriod.year === 本次切段总额`',
      Y132.sh.date === '2026-12-31' && Y132.split.day1 === 7200 && Y132.split.day2 === 1800 &&
      Y132.split.day1Date === '2026-12-31' && Y132.split.day2Date === '2027-01-01' &&
      Y132.acc.yearSec === 1800 && Y132.acc.yearSec !== 9000 &&
      Y132.acc.outOfPeriod !== null && Y132.acc.outOfPeriod.year === 7200 &&
      Y132.acc.yearSec + Y132.acc.outOfPeriod.year === Y132.total,
      `切段=${JSON.stringify(Y132.split)}；yearSec=${Y132.acc.yearSec}（旧实现会是 9000）；` +
      `outOfPeriod.year=${Y132.acc.outOfPeriod ? Y132.acc.outOfPeriod.year : '（null）'}；` +
      `年档＋outOfPeriod.year=${Y132.acc.yearSec + (Y132.acc.outOfPeriod ? Y132.acc.outOfPeriod.year : 0)}（应=${Y132.total}）`);

    /* 边界两端（**期望值同样是实测值**）：
       · 月末**最后一秒**（`10-31 23:59:59`）：还没跨月 ⇒ 月/年档**整段计入**、`outOfPeriod = null`；
       · **恰好在零点**（`11-01 00:00:00`）：已跨月 ⇒ `day2 = 0`（切段口径）、月档**只收 0**
         （该段全归 10 月）、`outOfPeriod.month = 7200`。
       这一条把"边界两侧各自算对"钉住 —— 只测中间时刻会漏掉"零点那一刻算给谁"这个最容易错的地方。 */
    const E132 = readAt132('2026-10-31T23:59:59', { daySec: 55, monthSec: 77777, yearSec: 888888, at: '2026-10-31T23:00:00' });
    const Z132 = readAt132('2026-11-01T00:00:00', { daySec: 66, monthSec: 77777, yearSec: 888888, at: '2026-10-31T23:00:00' });
    t.check('E132-3 **月末最后一秒 vs 恰好零点**（边界两端各自算对）：`10-31 23:59:59` ⇒ 整段 7199 全进 10 月的月/年档、' +
      '`outOfPeriod = null`；`11-01 00:00:00` ⇒ 切段 `7200/0`、`daySec` 只收后段（0）、**月档只收 0**、' +
      '`outOfPeriod.month = 7200`（那 7200 归 10 月，一分不少地报出来）',
      E132.sh.date === '2026-10-31' && E132.total === 7199 &&
      E132.split.day1 === 7199 && E132.split.day2 === 0 && E132.split.crossing === true &&
      E132.acc.monthSec === 77777 + 7199 && E132.acc.yearSec === 888888 + 7199 &&
      E132.acc.outOfPeriod === null &&
      Z132.sh.date === '2026-10-31' && Z132.total === 7200 &&
      Z132.split.day1 === 7200 && Z132.split.day2 === 0 && Z132.split.crossing === true &&
      Z132.acc.daySec === 0 && Z132.acc.monthSec === 0 &&
      Z132.acc.outOfPeriod !== null && Z132.acc.outOfPeriod.month === 7200,
      `23:59:59：切段=${JSON.stringify(E132.split)}、月/年=${E132.acc.monthSec}/${E132.acc.yearSec}` +
      `（应 ${77777 + 7199}/${888888 + 7199}）、outOfPeriod=${JSON.stringify(E132.acc.outOfPeriod)}；` +
      `00:00:00：切段=${JSON.stringify(Z132.split)}、daySec=${Z132.acc.daySec}、monthSec=${Z132.acc.monthSec}、` +
      `outOfPeriod.month=${Z132.acc.outOfPeriod ? Z132.acc.outOfPeriod.month : '（null）'}`);

    /* `outOfPeriod` 的**契约面**（本座判断：算读数字段，但既然实现把它写进返回值，就该被守 —— 理由：
       它是"扣掉的秒去哪儿了"的**唯一可核证据**；若哪天它被删掉/改成静默，本条的其余读数**照样全绿**
       （数值判定只看 `monthSec`/`yearSec`）⇒ 必须有独立断言把它钉住。零值语义＝`null`（**没有**跨周期段），
       不是 `{month:0,year:0}` —— 两种写法读起来一个是"没有"、一个是"有但为 0"，不许混。） */
    const legacy132 = stats.accumulateRunTime({ daySec: 1, monthSec: 2, yearSec: 3, at: '2026-09-30T23:00:00' },
      60, '2026-10-01T00:30:00');
    const sameMonth132 = readAt132('2026-10-05T00:30:00', { daySec: 0, monthSec: 77777, yearSec: 888888, at: '2026-10-04T23:00:00' });
    t.check('E132-4 `outOfPeriod` **在场且语义明确**（读数字段，本座按契约面守）：三种形态都能读到该键 —— ' +
      '①旧调用形态（不传切段）⇒ `null`；②跨零点但两段同月/同年（`10-04→10-05`）⇒ `null`；' +
      '③真跨周期 ⇒ `{month,year,note}` 且 `month`/`year` 为**数值**、`note` 非空（"不是丢失"的口径写在里面）',
      'outOfPeriod' in legacy132 && legacy132.outOfPeriod === null &&
      'outOfPeriod' in sameMonth132.acc && sameMonth132.acc.outOfPeriod === null &&
      sameMonth132.acc.monthSec === 77777 + 9000 &&
      M132.acc.outOfPeriod !== null && typeof M132.acc.outOfPeriod.month === 'number' &&
      typeof M132.acc.outOfPeriod.year === 'number' && M132.acc.outOfPeriod.note.length > 20 &&
      M132.acc.outOfPeriod.month === 7200 && M132.acc.outOfPeriod.year === 0,
      `旧形态（不传切段）=${JSON.stringify(legacy132.outOfPeriod)}；同月跨零点（10-04→10-05）=${JSON.stringify(sameMonth132.acc.outOfPeriod)}` +
      `（其 monthSec=${sameMonth132.acc.monthSec}，应=${77777 + 9000}）；跨月形态=${JSON.stringify(M132.acc.outOfPeriod && { month: M132.acc.outOfPeriod.month, year: M132.acc.outOfPeriod.year, noteLen: M132.acc.outOfPeriod.note.length })}`);

    /* `E132` 的 D22（可证伪）：把月/年档的两条"按归属聚合"式子**改回旧实现**（`monthAdd = day1 + day2`、
       `yearAdd = day1 + day2`）—— **内存副本** `Module._compile`，盘上一个字节都不落 ⇒
       `E132-1`／`E132-2` 的期望**必被违反**（月档 9000、年档 9000）；盘上 `server\services\stats.js` 逐字节未变。
       ⚠ 只变异**加数**那一处（不碰返回值形状）—— 否则"红"可能来自别的改动，证明不了这条判据的判别力。 */
    {
      const Module132 = require('node:module');
      const crypto132 = require('node:crypto');
      const sha132 = (b) => crypto132.createHash('sha256').update(b).digest('hex');
      const stPath = require.resolve('../server/services/stats');
      const stBytes0 = fs.readFileSync(stPath);
      const sha0 = sha132(stBytes0);
      let mutSrc = stBytes0.toString('utf8');
      const reMonth = /monthAdd = \(d1MonthKey[\s\S]*?;\r?\n/;
      const reYear = /yearAdd = \(d1YearKey[\s\S]*?;\r?\n/;
      const hitMonth = reMonth.test(mutSrc) && reYear.test(mutSrc);
      mutSrc = mutSrc.replace(reMonth, 'monthAdd = day1 + day2;\r\n').replace(reYear, 'yearAdd = day1 + day2;\r\n');
      const load132 = (src) => {
        const m = new Module132(stPath, null);
        m.filename = stPath;
        m.paths = Module132._nodeModulePaths(path.dirname(stPath));
        m._compile(src, stPath);
        return m.exports;
      };
      let mutM = null;
      let mutY = null;
      let mutErr = '';
      try {
        const mutStats = load132(mutSrc);
        const shM = nRules132.at('2026-11-01T00:30:00');
        const spM = mutStats.splitRunSecondsByDay(shM, shM.elapsedSec);
        mutM = mutStats.accumulateRunTime(prevOct, shM.elapsedSec, '2026-11-01T00:30:00', spM);
        const shY = nRules132.at('2027-01-01T00:30:00');
        const spY = mutStats.splitRunSecondsByDay(shY, shY.elapsedSec);
        mutY = mutStats.accumulateRunTime(prevDec, shY.elapsedSec, '2027-01-01T00:30:00', spY);
      } catch (err) { mutErr = String((err && err.message) || err); }
      const stBytes1 = fs.readFileSync(stPath);
      const diskSame132 = Buffer.compare(stBytes0, stBytes1) === 0 && sha132(stBytes1) === sha0;
      t.check('E132-5 D22（可证伪）：把月/年档的两条"按归属聚合"式子**改回旧实现**（`monthAdd = day1 + day2`／' +
        '`yearAdd = day1 + day2`，`Module._compile` 的**内存副本**、盘上文件全程只读）⇒ `E132-1`／`E132-2` 的期望' +
        '**必被违反**（月档 9000、年档 9000）；而**原件**给 1800／1800；`server\\services\\stats.js` 盘上字节逐字节未变',
        hitMonth && mutErr === '' && mutSrc !== stBytes0.toString('utf8') &&
        mutM !== null && mutM.monthSec === 9000 && mutY !== null && mutY.yearSec === 9000 &&
        M132.acc.monthSec === 1800 && Y132.acc.yearSec === 1800 && diskSame132,
        `变异命中两处锚点=${hitMonth}、变异体 sha256=${sha132(Buffer.from(mutSrc, 'utf8')).slice(0, 12)}…（原件 ${sha0.slice(0, 12)}…）；` +
        `变异体读数：跨月 monthSec=${mutM ? mutM.monthSec : '（未执行）'}（应 9000＝旧实现）、` +
        `跨年 yearSec=${mutY ? mutY.yearSec : '（未执行）'}（应 9000）；` +
        `原件读数：monthSec=${M132.acc.monthSec}／yearSec=${Y132.acc.yearSec}（应 1800／1800）；` +
        (mutErr ? `⚠ 变异体载入/执行失败：${mutErr}；` : '') +
        `盘上 stats.js 逐字节未变=${diskSame132}`);
    }
  }

  /* ================= 乙⑨ `E150`：跨零点班次的**非整点**边界（分钟级） =================
     立案（`项目记录\后续路线图.md` 的 `E150` 行，2026-10-04 由本座位在 `T-20261004-16` 顺带发现、
     只留痕未改判据）：`E83`／`E132` 的全部跨零点定点断言都用**整点**构造成例
     （`{name:'夜班',start:22,end:6}` ⇒ `startAt`＝`22:00:00`、`endAt`＝`06:00:00`），
     而 `splitRunSecondsByDay()` 实际接受**分钟级**的 `startAt`／`endAt`。
     ⇒ "整点"是**当前配置的偶然性质**、不是判据的性质：一旦班次边界落在**同一小时内的分**上
     （例：`22:30 → 06:30`），"零点那一刀落在哪一秒"、"`day1`／`day2` 各占多少"、
     "边界两侧（班次开始那一刻 / 恰好零点）算给谁"都**没有任何断言**。
     本节的处置＝路线图给的**方案①**（补一条"非整点跨零点"定点断言），**不写"必须整点"的禁令**
     （禁令会砍掉一个能跑的用例；而"配置层只允许整点"这一事实**另有一条断言如实登记**，见 ④）。
     ⚠ **实情如实登记（不是"实现不支持"，是"两条路径的边界不同"）**：
        · **配置面**（`createShiftRules()`）**只接受整点** —— `shift.js:191` 对 `start`/`end`
          做 `Number.isInteger()` 校验 ⇒ `22.5` 当场 `TypeError`；故"非整点班次"**不可能**来自
          `board.config.js`（`E128` 的准入闸与 `at()` 都建立在整点上）；
        · **切段面**（`stats.js` 的 `splitRunSecondsByDay()`）**接受分钟级/秒级** ——
          它只读 `shift.startAt`／`shift.endAt`（`toDate()` 可解析的任意时刻）、`shift.start`/`end`
          （判"是否跨零点"）与 `shift.elapsedSec`（分配的分母＝**已进行时长**），**都不要求整点**
          ⇒ 本节用**手工构造的同形班次对象**（`Night150`）喂进去，这正是"判据的性质"能覆盖到、
          而"配置的偶然性质"覆盖不到的那一段。
        ⇒ 本节**不改实现**（座位 3 的面），只补断言；④ 把"配置面只允许整点"这一事实钉住，
          免得以后有人把"非整点能跑"误读成"配置也能配非整点"。
     ⚠ **本节第一版踩到的坑（如实登记，不是藏起来）**：第一版把"已进行时长"**只**当成入参传给
        `splitRunSecondsByDay()`，**没把它同时放进班次对象的 `elapsedSec`** ⇒ 实现走"`elapsedSec`
        缺失 ⇒ 退化为整班跨度 `span`"那一支（分配的分母变成 28800）⇒ `00:30` 读出 `1350/5850`
        而不是 `5400/1800`，四条断言当场全红。这正是 `splitRunSecondsByDay()` docblock 明写的
        向后兼容口径（缺 `elapsedSec` ⇒ 按整班分摊），**不是实现缺陷** —— 故修法是本节夹具补齐
        `elapsedSec`（＝`createShiftRules().at()` 的完整形态，也与 `stateSnapshot`／`server/index.js`
        的真实调用同形），**不动实现**。
     **D22（ADR-0004 D22）**：两支**内存变异** `Module._compile`（盘上一个字节都不落）——
      ①把"零点"从 `endAt` 反推（＝切段注释里实测过的那个坑，`day1`/`day2` 会算反）；
      ②把"跨零点"判据的等号拿掉（`Number(end) < Number(start)`）⇒ 班次开始那一刻被判成"不跨零点"。
     两支都**必红并指名**，原件（未变异）必绿。 */
  {
    /* ---- 非整点跨零点班次（`start`/`end` 仍是整数，供"是否跨零点"判据用；边界在时刻上） ----
       构造口径＝`createShiftRules().at()` 的**完整形态**，只把时刻挪到分钟级：
        `startAt`＝10-04 22:30:00、`endAt`＝10-05 06:30:00 ⇒ 整班 `28800 s`（8 h，与整点版**同长**，
        便于把"变的是边界位置、不是班次长度"这件事说清楚）；
       `elapsedSec` ＝ 整班（"班次已经跑完"这一形态，与 `server/index.js` 的 `completedShiftOf()`
        固化路径同形），下面每个探针再按时刻覆盖它。 */
    const Night150 = {
      name: '夜班（非整点 22:30-06:30）', start: 22, end: 6,
      date: '2026-10-04',
      startAt: '2026-10-04 22:30:00', endAt: '2026-10-05 06:30:00',
      totalSec: 28800, elapsedSec: 28800
    };
    /** 某时刻对应的"已进行时长"（**独立于被测实现**，直接由两个时刻相减） */
    const elapsedAt150 = (now) => Math.min(Night150.totalSec,
      Math.round((platformClock.toDate(now).getTime() - platformClock.toDate(Night150.startAt).getTime()) / 1000));
    /** 由 `startAt` 现算零点（**独立于被测实现**；不写死 `5400` 这种手算魔数）——
        ADR-0004 D21：期望值由"已知正确的量"推出 ⇒ 以后挪边界，本节的期望值自动跟随。 */
    const midnight150 = (() => {
      const s = platformClock.toDate(Night150.startAt);
      return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1, 0, 0, 0, 0);
    })();
    /** "按零点切段"的**独立重算**：`day1` ＝ 落在开始日的秒数（上限＝已进行时长）、余下归次日 */
    const expectSplit150 = (now) => {
      const live = elapsedAt150(now);
      const span1 = Math.min(Math.round((midnight150.getTime() - platformClock.toDate(Night150.startAt).getTime()) / 1000),
        Math.max(0, live));
      const d1 = live > 0 ? Math.round(live * (span1 / live)) : 0;
      return { live, day1: d1, day2: live - d1 };
    };
    /** 班次对象 ＋ 该时刻的已进行时长（**两种口径都给**：`splitRunSecondsByDay()` 的分配分母取
        `shift.elapsedSec`，故探针必须把"这一刻"一起放进去 —— 见抬头登记的踩坑） */
    const shiftAt150 = (opts, now) => Object.assign({}, opts, { elapsedSec: elapsedAt150(now) });
    /** 探针：**非整点**的四个时刻 —— 班次中段（小数）、恰好零点、次日凌晨（小数）、班次中后段。
        ⚠ `22:30:00` 那一刻 `elapsed = 0` ⇒ 走的是"零长度增量"那一支（`day1/day2` 都是 0），
        对"归属"没有判别力 ⇒ 下面的边界两端改用 `22:30:01`（`elapsed = 1`）与 `00:00:00`。 */
    const probes150 = ['2026-10-04T23:00:00', '2026-10-05T00:00:00',
      '2026-10-05T00:30:00', '2026-10-05T03:00:00'].map((t0) => {
      const e = expectSplit150(t0);
      return { t0, live: e.live, day1: e.day1, day2: e.day2,
        s: stats.splitRunSecondsByDay(shiftAt150(Night150, t0), e.live) };
    });
    const ok150 = (x) => x.s.crossing === true &&
      x.s.day1 === x.day1 && x.s.day2 === x.day2 && x.s.day1 + x.s.day2 === x.live &&
      x.s.day1Date === '2026-10-04' && x.s.day2Date === '2026-10-05' &&
      typeof x.s.degraded === 'undefined';
    t.check('E150-① 非整点跨零点（`22:30 → 06:30`，手工构造的同形班次对象）的**切段与归属**：' +
      '`crossing = true`；`day1`／`day2` ＝ **按零点切开的两段**（`day1 + day2 === 已进行时长`，' +
      '不丢秒、不重复计）；两段日历归属各自**绑定**为 `2026-10-04`／`2026-10-05`；' +
      '完整形态**不带** `E139` 的 `degraded` 标记（形态齐 ⇒ 判定被背书）；' +
      '并把"边界落在**同一小时内的分**上"这件事逐点打出（整班同长、零点同位置 ⇒ ' +
      '这里承重的是**边界位置**，不是"整点"；`elapsedSec` 为**已进行时长** ⇒ 分配分母不是整班跨度）',
      probes150.every(ok150),
      `班次：${Night150.name}（${Night150.startAt} → ${Night150.endAt}，整班 ${Night150.totalSec}s）；` +
      `零点＝${platformClock.fmt(midnight150)}（由 startAt 现算）；` +
      `逐点＝${probes150.map(x => `${x.t0.slice(11)} 已进行${x.live}s⇒day1/day2=${x.s.day1}/${x.s.day2}` +
        `（期望 ${x.day1}/${x.day2}）`).join('；')}`);

    /** 边界两端（**非整点跨零点最容易错的地方**：班次开始那一刻、恰好零点那一刻）：
        · `22:30:01`（`elapsed = 1`，`runSec = 1`）：`crossing` 必须为 `true`（跨零点判据是
          `end <= start`，**含等号**；拿掉等号 ⇒ 这一刻被判成"不跨零点" ⇒ **判红**，见 D22 的变异②），
          `day1/day2 = 1/0`（§"三、时长"口径：`runSec = min(已进行, 帧数 − 1)` ＝ **1 秒**
          —— 这一秒整个落在**开始日**那一段里、且只有 1 秒 ⇒ 不能倒贴给次日）；
        · `00:00:00`（`elapsed = 5400`）：`day1/day2 = 5400/0` —— **后段为 0 ≠ 不跨零点**：
          这正是 `E132-3` 在整点版上钉住的"零点那一刻算给开始日"，本节把它搬到非整点边界上。 */
    const start150 = stats.splitRunSecondsByDay(shiftAt150(Night150, '2026-10-04T22:30:01'), 1);
    const atMid150 = stats.splitRunSecondsByDay(shiftAt150(Night150, '2026-10-05T00:00:00'),
      elapsedAt150('2026-10-05T00:00:00'));
    const expStart150 = expectSplit150('2026-10-04T22:30:01');
    const expMid150 = expectSplit150('2026-10-05T00:00:00');
    t.check('E150-② **边界两端各自算对**（非整点）：`22:30:01` ⇒ `crossing = true`、`day1/day2 = 1/0`' +
      '（跨零点判据含**等号**：那一刻仍属这一班；1 秒的运行整段落在**开始日**那一段 ⇒ 不得倒贴给次日）；' +
      '`00:00:00` ⇒ `day1/day2 = 5400/0`' +
      '（＝整班前段**恰好走完**，`day2` 为 0 **不代表**"不跨零点"——`crossing` 仍为 `true`，' +
      '与 `E132-3` 在整点版上的口径**逐字同源**）',
      start150.crossing === true && start150.day1 === expStart150.day1 && start150.day2 === expStart150.day2 &&
      start150.day1 === 1 && start150.day2 === 0 &&
      start150.day1Date === '2026-10-04' && start150.day2Date === '2026-10-05' &&
      atMid150.crossing === true && atMid150.day1 === expMid150.day1 && atMid150.day2 === expMid150.day2 &&
      atMid150.day1 === 5400,
      `22:30:01（已进行 ${expStart150.live}s）⇒ crossing=${start150.crossing}、day1/day2=` +
      `${start150.day1}/${start150.day2}（期望 ${expStart150.day1}/${expStart150.day2}）、` +
      `归属 ${start150.day1Date}/${start150.day2Date}；` +
      `00:00:00（已进行 ${expMid150.live}s）⇒ crossing=${atMid150.crossing}、day1/day2=` +
      `${atMid150.day1}/${atMid150.day2}（期望 ${expMid150.day1}/${expMid150.day2}）`);

    /* ---- 非整点跨零点落到**月末**：月/年归属同样不能被"边界是整点"这件事掩盖 ----
       `10-31 22:30 → 11-01 06:30`：`day1`＝10 月、`day2`＝11 月 ⇒ `monthSec` 只收 `day2`、
       被扣的 `day1` 记进 `outOfPeriod.month`（`E132` 的口径），本节只换边界位置、口径一字不改。 */
    const mNight150 = Object.assign({}, Night150, {
      date: '2026-10-31', startAt: '2026-10-31 22:30:00', endAt: '2026-11-01 06:30:00'
    });
    const nowM150 = '2026-11-01T00:30:00';
    const liveM150 = Math.round((platformClock.toDate(nowM150).getTime() -
      platformClock.toDate(mNight150.startAt).getTime()) / 1000);           /* 7200 s（22:30→00:30） */
    const splitM150 = stats.splitRunSecondsByDay(Object.assign({}, mNight150, { elapsedSec: liveM150 }), liveM150);
    const accM150 = stats.accumulateRunTime(
      { daySec: 7, monthSec: 77777, yearSec: 888888, at: '2026-10-31T23:00:00' },
      liveM150, nowM150, splitM150);
    /* `computeShiftStats()` 侧：用**逐秒稠密采样**（22:30:00 → 00:30:00）取到 `runSec = liveM150`
       （`E68` 口径：`runSec = min(elapsedSec, 帧数 − 1)`）⇒ 切段原样带出，与上面的直接调用逐值一致。 */
    const framesM150 = (() => {
      const t0 = platformClock.toDate(mNight150.startAt);
      return Array.from({ length: liveM150 + 1 }, (_, i) => new Date(t0.getTime() + i * 1000));
    })();
    const crossStats150 = stats.computeShiftStats({
      shift: Object.assign({}, mNight150, { elapsedSec: liveM150 }),
      orders: [], pieces: [], measures: framesM150, now: nowM150
    });
    t.check('E150-③ 非整点跨零点的**跨月归属**与"整点版同口径"：`10-31 22:30 → 11-01 06:30` 在 `11-01 00:30` 被读' +
      '⇒ 切段 `5400/1800`（零点那一刀仍在 `11-01 00:00:00`）、日历归属 `10-31`/`11-01`；' +
      '**月档只收 1800**（＝11 月那一段；**旧口径会把两段一起加进 11 月 = 7200**）、`outOfPeriod.month === 5400`，' +
      '且 `月档 + outOfPeriod.month === 本次切段总额`（那两个 7200 都在读数里，"不多算、不丢秒"可核）；' +
      '**年档照旧收整段**（两段同年 ⇒ `888888 + 7200`）—— 这正是"跨零点只跨日/月、不跨年"的那一半；' +
      '`computeShiftStats()` 把同一份切段原样带出（`runSecDay1/2`，与上面的直接调用**逐值一致**）',
      splitM150.crossing === true && splitM150.day1 === 5400 && splitM150.day2 === 1800 &&
      splitM150.day1Date === '2026-10-31' && splitM150.day2Date === '2026-11-01' &&
      accM150.monthSec === 1800 && accM150.monthSec !== 77777 + liveM150 &&
      /* 年档：两段同年 ⇒ **整段进年档**；且这两段本身不是跨年 ⇒ `rollAccum()` 把 `prev.daySec`（7 s）
         滚进年档（月/年两档「整段进」的那一半与 `E132-2` 的跨年形态互为正反面） */
      accM150.yearSec === 888888 + 7 + liveM150 &&
      accM150.outOfPeriod !== null && accM150.outOfPeriod.month === 5400 && accM150.outOfPeriod.year === 0 &&
      accM150.monthSec + accM150.outOfPeriod.month === liveM150 &&
      accM150.daySec === 1800 &&
      crossStats150.runSec === liveM150 &&
      crossStats150.runSecDay1 === splitM150.day1 && crossStats150.runSecDay2 === splitM150.day2 &&
      JSON.stringify(crossStats150.runSecSplit) === JSON.stringify(splitM150),
      `切段=${JSON.stringify(splitM150)}；monthSec=${accM150.monthSec}（旧口径＝77777+${liveM150}）、` +
      `yearSec=${accM150.yearSec}（应＝888888＋滚入的 prev.daySec 7＋${liveM150}）、daySec=${accM150.daySec}；` +
      `outOfPeriod=${accM150.outOfPeriod ? `{month:${accM150.outOfPeriod.month},year:${accM150.outOfPeriod.year}}` : '（null）'}；` +
      `月档＋outOfPeriod.month=${accM150.monthSec + (accM150.outOfPeriod ? accM150.outOfPeriod.month : 0)}` +
      `（应＝本次切段总额 ${liveM150}）；` +
      `computeShiftStats：runSec=${crossStats150.runSec}（采样 ${framesM150.length} 帧）、` +
      `runSecDay1/2=${crossStats150.runSecDay1}/${crossStats150.runSecDay2}`);

    /* ---- ④ **配置面**只允许整点（**如实登记**，不是禁令式判据）：非整点的 `start`/`end`
       必须被 `createShiftRules()` **当场拒绝**并给出可读原因 —— 免得本节的判据被误读成
       "配置也能配非整点"。这条同时是"非整点班次只能由**手工构造的同形对象**喂进切段面"的证据。 */
    const nonIntegral150 = (() => {
      try { createShiftRules({ list: [{ name: '夜班', start: 22.5, end: 6.5 }], allowCrossMidnight: true }); return null; }
      catch (err) { return err; }
    })();
    t.check('E150-④ **配置面只接受整点**（如实登记的事实，不是"必须整点"的禁令）：`createShiftRules()` 收到' +
      '`{start: 22.5, end: 6.5}` 必须**当场拒绝**（`TypeError`）且消息里点名"必须是整点"与收到的值；' +
      '而**切段面**（`splitRunSecondsByDay()`／`computeShiftStats()`）对分钟级 `startAt`/`endAt` 照常工作 ' +
      '⇒ 上面 ①②③ 用的是**手工构造的同形班次对象**，不是配置造出来的',
      nonIntegral150 instanceof TypeError && /必须是整点/.test(String(nonIntegral150.message)) &&
      /22\.5/.test(String(nonIntegral150.message)) &&
      probes150.every(ok150),
      nonIntegral150 ? `${nonIntegral150.constructor.name}：${String(nonIntegral150.message).slice(0, 120)}…`
        : '**未抛错**（配置面接受了非整点 —— 那 E150 的"整点＝配置的偶然性质"这句话要重写）');

    /* ---- D22（可证伪）：两支**内存变异**（`Module._compile`，盘上文件全程只读） ---- */
    {
      const Module150 = require('node:module');
      const crypto150 = require('node:crypto');
      const sha150 = (b) => crypto150.createHash('sha256').update(b).digest('hex');

      /** 判据**纯函数**（只判"读数是否符合切段口径"）：主断言与两支变异共用同一把尺子。
          ⚠ 期望值**从独立重算的 `expect`（`expectSplit150()` 的产物）＋探针输入现取**、不写死数字，
          也不写死两段的日历归属（按"开始日 ＝ `shift.date`、次日 ＝ 开始日 + 1"现算）——
          本座位第一版在这里写死了 `day2 === 2700` 与两个写死的日期 ⇒ 换个探针时刻就把**负对照**
          判成假（实测：`00:30`／`03:00` 两处读数见回执）。那正是 ADR-0004 D21 说的"手算魔数"翻车形态。 */
      const splitVerdict150 = (row, expect, shift150) => {
        const s = platformClock.toDate(shift150.startAt);
        const d1Date = platformClock.fmtDate(shift150.date);
        const d2Date = platformClock.fmtDate(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1, 0, 0, 0, 0));
        return row.crossing === true &&
          row.day1 === expect.day1 && row.day2 === expect.day2 &&
          row.day1 + row.day2 === expect.live &&
          row.day1Date === d1Date && row.day2Date === d2Date;
      };
      /** ④ 的判据（配置面拒收非整点）：同样是**纯函数**，让变异与主断言共用 */
      const nonIntegralVerdict150 = (err) => err instanceof TypeError &&
        /必须是整点/.test(String(err.message)) && /22\.5/.test(String(err.message));

      /** 变异探针①：`00:30`（`elapsedSec = 7200`）⇒ 期望切段 `5400/1800` */
      const probeNow150 = '2026-10-05T00:30:00';
      const expectAt150 = expectSplit150(probeNow150);
      const probeShift150 = shiftAt150(Night150, probeNow150);
      /** 变异探针②：`03:00`（`elapsedSec = 16200`）⇒ 期望切段 `5400/10800`
          （两段都非 0 ⇒ "零点被推后"在**两段上**都能被看见，而不只是把 `day2` 归零） */
      const probeHour150 = '2026-10-05T03:00:00';
      const expectHour150 = expectSplit150(probeHour150);
      const probeShiftHour150 = shiftAt150(Night150, probeHour150);
      /** 负对照（原件，未变异）—— 两支变异各自与"同一时刻的原件读数"对照（同一把尺子） */
      const control150 = Object.assign({}, stats.splitRunSecondsByDay(probeShift150, expectAt150.live));
      const controlHour150 = Object.assign({}, stats.splitRunSecondsByDay(probeShiftHour150, expectHour150.live));

      const stPath150 = require.resolve('../server/services/stats');
      const shPath150 = require.resolve('../server/services/shift');
      const load150 = (src) => {
        const m = new Module150(stPath150, null);
        m.filename = stPath150;
        m.paths = Module150._nodeModulePaths(path.dirname(stPath150));
        m._compile(src, stPath150);
        return m.exports;
      };
      const probeM = (mod) => mod.splitRunSecondsByDay(probeShift150, expectAt150.live);
      const probeHourM = (mod) => mod.splitRunSecondsByDay(probeShiftHour150, expectHour150.live);

      /* 变异①：把"零点那一刀"从 `endAt` 反推 —— 跨零点时 `endAt` 本就在次日 ⇒ 零点被推后一整天
         ⇒ 全部秒数落进 `day1`、`day2` 恒 0（**正是 `stats.js` 注释里实测过的那个坑**）。 */
      const stBytes150 = fs.readFileSync(stPath150);
      const shBytes150 = fs.readFileSync(shPath150);
      const src150 = stBytes150.toString('utf8');
      const reMidnight150 = /const dayStart = new Date\(startAt\.getFullYear\(\), startAt\.getMonth\(\), startAt\.getDate\(\), 0, 0, 0, 0\);/;
      const reYearAdd150 = /yearAdd = \(d1YearKey[\s\S]*?;\r?\n/;
      const hitMid150 = (src150.match(reMidnight150) || []).length === 1;
      const hitYear150 = (src150.match(reYearAdd150) || []).length === 1;
      const srcMid150 = src150.replace(reMidnight150,
        'const dayStart = new Date(endAt.getFullYear(), endAt.getMonth(), endAt.getDate(), 0, 0, 0, 0);');
      /* 变异②：把"零点那一刀"**算晚一小时**（`0, 0, 0, 0` ⇒ `1, 0, 0, 0`，改错的是**小时位**那一处）——
         非整点边界（`22:30 → 06:30`）下，零点被推后 ⇒ `day1` 多算一小时、`day2` 少算一小时
         ⇒ E150-①／E150-③ 的切段与归属**必红并指名 `day1`/`day2`**（整点版 22:00→06:00 同样会被抓到）。
         ⚠ 为什么**不**去动 `shift.js` 的 `isCrossMidnight()` 等号：那个等号只在 `end === start` 时才分叉，
         而 `end === start` 已被 `createShiftRules()` 当"零长度班次"拒绝 ⇒ 那一支**不可达**，
         拿它当 D22 靶子只会得到"变异了但读数一字不变"的**假证伪**（本座位第一版就是这么写的，
         现场读数：`crossing` 没变、判据仍绿 ⇒ 如实换靶）。 */
      const reMidnightHour150 = /const dayStart = new Date\(startAt\.getFullYear\(\), startAt\.getMonth\(\), startAt\.getDate\(\), 0, 0, 0, 0\);/;
      const srcHour150 = src150.replace(reMidnightHour150,
        'const dayStart = new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate(), 1, 0, 0, 0);');
      const hitHour150 = srcHour150 !== src150 && (srcHour150.match(/getDate\(\), 1, 0, 0, 0\)/) || []).length === 1;

      let mutMid150 = null; let mutHour150 = null; let mutErr150 = '';
      try { mutMid150 = probeM(load150(srcMid150)); } catch (err) { mutErr150 += `变异①载入失败：${err.message}；`; }
      try { mutHour150 = probeHourM(load150(srcHour150)); } catch (err) { mutErr150 += `变异②载入失败：${err.message}；`; }
      const diskSame150 = Buffer.compare(stBytes150, fs.readFileSync(stPath150)) === 0 &&
        Buffer.compare(shBytes150, fs.readFileSync(shPath150)) === 0;

      t.check('E150 D22（可证伪，**内存变异 ＋ 负对照**）：①把"零点"从 `endAt` 反推（`dayStart` 的日历日取 `endAt`）' +
        '⇒ 同一判据 `splitVerdict150()` **当场为假**（`day1/day2` 算成 8100/0，而期望 5400/2700）' +
        '**指名的对象＝ `day1`／`day2`**（E150-① 会逐点报出这两个数）；' +
        '②把"零点那一刀"**算晚一小时**（`...getDate(), 0, 0, 0, 0` ⇒ `1, 0, 0, 0`，改错的是**小时位**那一处' +
        '——`stats.js` 注释里实测过的另一个坑）⇒ 切段同样**必红并指名 `day1`／`day2`**；' +
        '③**负对照** ＝ 原件（未变异）在上述输入下**必绿**；`server\\services\\stats.js` 与 ' +
        '`server\\services\\shift.js` 盘上逐字节未变（全程只读它们）',
        hitMid150 && hitYear150 && hitHour150 && mutErr150 === '' &&
        mutMid150 !== null && mutHour150 !== null &&
        splitVerdict150(control150, expectAt150, probeShift150) &&
        splitVerdict150(controlHour150, expectHour150, probeShiftHour150) &&
        !splitVerdict150(mutMid150, expectAt150, probeShift150) &&
        mutMid150.day1 === expectAt150.live && mutMid150.day2 === 0 &&
        !splitVerdict150(mutHour150, expectHour150, probeShiftHour150) &&
        mutHour150.day1 === expectHour150.day1 + 3600 && mutHour150.day2 === expectHour150.day2 - 3600 &&
        nonIntegralVerdict150(nonIntegral150) && diskSame150,
        `变异锚点命中（各恰 1 处）：零点日历日 ${hitMid150}／年档加数 ${hitYear150}／零点小时位 ${hitHour150}` +
        `${mutErr150 ? `｜⚠ ${mutErr150}` : ''}；` +
        `负对照（原件）⇒ ` + '`00:30`' + ` 的 day1/day2=${control150.day1}/${control150.day2}、` +
        `crossing=${control150.crossing}（拆分判据=${splitVerdict150(control150, expectAt150, probeShift150)}，应 true）｜` +
        '`03:00`' + ` 的 day1/day2=${controlHour150.day1}/${controlHour150.day2}` +
        `（拆分判据=${splitVerdict150(controlHour150, expectHour150, probeShiftHour150)}，应 true）；` +
        `变异①（` + '`00:30`' + `）⇒ day1/day2=${mutMid150 ? `${mutMid150.day1}/${mutMid150.day2}` : '（未执行）'}` +
        `（**指名 day1/day2**：期望 ${expectAt150.day1}/${expectAt150.day2}）、拆分判据=${mutMid150 ? splitVerdict150(mutMid150, expectAt150, probeShift150) : '-'}（应 false）；` +
        `变异②（` + '`03:00`' + `，零点晚一小时）⇒ day1/day2=${mutHour150 ? `${mutHour150.day1}/${mutHour150.day2}` : '（未执行）'}` +
        `（**指名 day1/day2**：期望 ${expectHour150.day1}/${expectHour150.day2}）、拆分判据=${mutHour150 ? splitVerdict150(mutHour150, expectHour150, probeShiftHour150) : '-'}（应 false）；` +
        `④ 的判据（配置面拒收非整点，同一把尺子）=${nonIntegralVerdict150(nonIntegral150)}；` +
        `盘上 stats.js／shift.js 逐字节未变=${diskSame150}；` +
        `变异体 sha256（前 12）＝${sha150(Buffer.from(srcMid150, 'utf8')).slice(0, 12)}…／` +
        `${sha150(Buffer.from(srcHour150, 'utf8')).slice(0, 12)}…（原件 ${sha150(stBytes150).slice(0, 12)}…）`);
      t.info(`\`E150\` 读数留痕：非整点班次（${Night150.startAt} → ${Night150.endAt}，整班 ${Night150.totalSec}s）；` +
        `零点现算＝${platformClock.fmt(midnight150)}；` +
        `四探针 day1/day2＝${probes150.map(x => `${x.t0.slice(11)}:${x.s.day1}/${x.s.day2}`).join('、')}；` +
        `跨月探针（10-31 22:30→11-01 06:30 读于 11-01 00:30）⇒ 切段 ${splitM150.day1}/${splitM150.day2}、` +
        `monthSec=${accM150.monthSec}＋outOfPeriod.month=${accM150.outOfPeriod ? accM150.outOfPeriod.month : '（null）'}；` +
        `配置面（` + '`createShiftRules`' + `）拒收 \`start:22.5\`＝${nonIntegralVerdict150(nonIntegral150)}；` +
        `判据真源：切段面接受分钟级 \`startAt\`/\`endAt\` 与 \`elapsedSec\`（\`splitRunSecondsByDay()\`）—— 本节未改任何实现`);
    }
  }
  /* ================= 乙⑦ `E128`：跨零点配置的准入闸 ================= */
  {
    const throwOf = (fn) => { try { return { ok: true, out: fn() }; } catch (err) { return { ok: false, err }; } };
    const cmOf = (r) => (r.ok ? r.out.crossMidnight() : null);

    const gateOff = throwOf(() => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }] }));
    t.check('E128-1 **配置段形态**（`createShiftRules(整个 shift 段)`）＋ 跨零点规则（`end <= start`）＋ 未声明' +
      '`allowCrossMidnight` ⇒ **拒绝**（`RangeError`，fail-closed），且消息**指名"先做 `E83` 的两个投影"**' +
      '（＝不留"能配但算错"的窗口）',
      gateOff.ok === false && gateOff.err instanceof RangeError &&
      /E83/.test(String(gateOff.err.message)) && /两个投影/.test(String(gateOff.err.message)) &&
      /allowCrossMidnight/.test(String(gateOff.err.message)) && /夜班 22-6/.test(String(gateOff.err.message)),
      gateOff.ok ? '**未抛错**（闸失明）' : `${gateOff.err.constructor.name}：${String(gateOff.err.message).slice(0, 150)}…`);

    const segOn = throwOf(() => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }], allowCrossMidnight: true }));
    const ruleOn = throwOf(() => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6, allowCrossMidnight: true }] }));
    t.check('E128-2 **显式开闸即允许**：段级 `allowCrossMidnight: true` 与**规则级** `{…, allowCrossMidnight: true}`' +
      '两种写法都放行（口径等价），且 `crossMidnight()` 如实自述 `{count: 1, allowed: true, keys: [夜班 22-6]}`',
      segOn.ok && ruleOn.ok &&
      cmOf(segOn).count === 1 && cmOf(segOn).allowed === true &&
      JSON.stringify(cmOf(segOn).keys) === JSON.stringify(['夜班 22-6']) &&
      cmOf(ruleOn).count === 1 && cmOf(ruleOn).allowed === true &&
      JSON.stringify(cmOf(ruleOn).keys) === JSON.stringify(['夜班 22-6']),
      `段级=${segOn.ok ? JSON.stringify(cmOf(segOn)) : String(segOn.err)}；` +
      `规则级=${ruleOn.ok ? JSON.stringify(cmOf(ruleOn)) : String(ruleOn.err)}`);

    /* 裸数组形态**有意放行**，但"放行"**不等于"生产可用"** ⇒ 必须如实自述 `allowed: false`。
       Why 放行（如实登记的代价，`server/services/shift.js` 的 docblock 同此）：`tests\logic-check.js`
       的 `:215`／`:267`／`:300` 在**模块顶层**就用裸数组建夜班规则（验"跨零点归属日／边界半开／总时长"
       这些**与配置闸无关**的规则）；若裸数组也抛 ⇒ 本脚本变成**整脚本异常**（无汇总行 ＋ 退 2、
       `run-all` 记 `error`），**158 条断言一条都跑不出来** —— 那不是"红一条"，而是"把证据全丢掉"。
       ⇒ 取舍：**危险的入口（配置段）fail-closed，纯规则引擎入口保持可用**。 */
    const bareOn = throwOf(() => createShiftRules([{ name: '夜班', start: 22, end: 6 }]));
    t.check('E128-3 裸数组形态 `createShiftRules([{name,start:22,end:6}])` **保持放行**（有意取舍：本脚本在' +
      '**模块顶层**就用它，若也拒 ⇒ 整脚本异常、全部断言丢失）—— **但必须如实自述** ' +
      '`crossMidnight() = {count: 1, allowed: false}`（防"放行"被误读成"生产可用"）',
      bareOn.ok === true && cmOf(bareOn).count === 1 && cmOf(bareOn).allowed === false &&
      JSON.stringify(cmOf(bareOn).keys) === JSON.stringify(['夜班 22-6']),
      bareOn.ok ? JSON.stringify(cmOf(bareOn)) : `抛错：${String(bareOn.err)}`);

    const curCm = shifts.crossMidnight();
    t.check('E128-4 `allowed` 只在**真有**跨零点班次时才可能为 `true`：现配置（0-8／8-16／16-24，无跨零点）' +
      '下 `crossMidnight() = {count: 0, allowed: false}`（否则 `/health` 上会出现 `count:0 / allowed:true`' +
      '这种自相矛盾、读方无法据此报警的读数）',
      curCm.count === 0 && curCm.allowed === false && JSON.stringify(curCm.keys) === JSON.stringify([]),
      `现配置 crossMidnight()=${JSON.stringify(curCm)}`);

    /* ================= 乙⑦-b `E131`：`allowCrossMidnight` **只认布尔字面量** =================
       立案（`E131`；座位 5 在 `C·21` 靶子⑦ 实测 13 组、主代理登记，2026-10-04）：段级判据原是
       `Boolean(options && options.allowCrossMidnight)`，而**规则级**同名字段是 `=== true`
       ⇒ **同一个键名两种严格度**：`allowCrossMidnight: 'false'`（**人读作"关"**）会**静默开闸**
       （`Boolean('false') === true`），`/health.crossMidnight.allowed` 还报 `true`。
       现口径（座位 3 的实现，本座逐值复核）：**取值域只有三段** —— `undefined`（键不在场）／
       `true`／`false`；**其余一律 `TypeError` 当场拒绝**，消息里**指名实际值与类型**。
       为什么"打错字"必须吵（而不是静默当关）：`'true'`（带引号）若静默当关，改配置的人**以为开了**
       却什么也没发生；而 `'false'` 若静默当真，则"以为关了其实开了" —— 两种误读都**无法从读数上**
       与正确配置区分（`E38` 同族）。⇒ **含糊即拒绝**（拒绝优于替调用方猜）。
       本条的期望值＝我自己跑 `tests\._verify\t14-e130\e131-expected.js` 的实测读数（逐值 13 组＋规则级同款）。 */
    {
      /** 值 → 报错文本里必须出现的那段"实际值（类型）"（**实测**，`assertBoolSwitch()` 的 `shown`） */
      const NONBOOL = [
        ['\'true\'', 'true', '\'true\'（字符串）'],
        ['\'false\'', 'false', '\'false\'（字符串）'],
        ['\'0\'', '0', '\'0\'（字符串）'],
        ['\'no\'', 'no', '\'no\'（字符串）'],
        ['\'\'', '', '\'\'（字符串）'],
        ['1', 1, '1（number）'],
        ['0', 0, '0（number）'],
        ['[]', [], '[]（数组）'],
        ['{}', {}, '{}（对象）'],
        ['null', null, 'null（null）'],
        ['NaN', NaN, 'NaN（number）']
      ];
      const segBad = NONBOOL.map(([label, v, shown]) => {
        const r = throwOf(() => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }], allowCrossMidnight: v }));
        const msg = r.ok ? '' : String(r.err.message);
        return { label, ok: r.ok, type: r.ok ? '' : r.err.constructor.name, named: msg.includes('收到 ' + shown), msg };
      });
      t.check('E131-1 **段级非布尔值一律拒绝**（真值表 11 组：`\'true\'`／`\'false\'`／`\'0\'`／`\'no\'`／`\'\'`／' +
        '`1`／`0`／`[]`／`{}`／`null`／`NaN`）⇒ 逐个 `TypeError`，且消息**指名实际值与类型**' +
        '（`收到 <值>（<类型>）`）—— 这一条正是 `E131` 的病灶：`Boolean(\'false\') === true` 会静默开闸',
        segBad.every(x => x.ok === false && x.type === 'TypeError' && x.named),
        segBad.every(x => x.ok === false && x.type === 'TypeError' && x.named)
          ? `11/11 全部 TypeError 且逐值指名（例：${segBad[1].msg.slice(0, 74)}…）`
          : '**未拒绝/未指名**的取值：' + segBad.filter(x => x.ok || x.type !== 'TypeError' || !x.named)
            .map(x => `${x.label}（ok=${x.ok}、异常=${x.type || '（无）'}、指名=${x.named}）`).join('；'));

      const ruleBad = NONBOOL.map(([label, v, shown]) => {
        const r = throwOf(() => createShiftRules([{ name: '夜班', start: 22, end: 6, allowCrossMidnight: v }]));
        const msg = r.ok ? '' : String(r.err.message);
        return { label, ok: r.ok, type: r.ok ? '' : r.err.constructor.name, named: msg.includes('收到 ' + shown),
          where: msg.includes('规则「夜班 22-6」') };
      });
      t.check('E131-2 **规则级非布尔值同款**（裸数组 ＋ 规则自带键，真值表 11 组）：同样逐个 `TypeError`、' +
        '同样指名实际值与类型，且消息里点明是**规则那一处**（`规则「夜班 22-6」`）—— ' +
        '两处严格度必须**同一把尺子**（`E131` 的原始病灶就是"同一个键名两种严格度"）',
        ruleBad.every(x => x.ok === false && x.type === 'TypeError' && x.named && x.where),
        ruleBad.every(x => x.ok === false && x.type === 'TypeError' && x.named && x.where)
          ? `11/11 全部 TypeError ＋ 逐值指名 ＋ 点明"规则那一处"（例：${ruleBad[1].label}）`
          : '**未达标**的取值：' + ruleBad.filter(x => x.ok || x.type !== 'TypeError' || !x.named || !x.where)
            .map(x => `${x.label}（ok=${x.ok}、异常=${x.type || '（无）'}、指名=${x.named}、点明规则处=${x.where}）`).join('；'));

      /* ③ **判据与"这次用没用到"无关**：配置里**没有**跨零点班次时打错字，也必须拒 ——
         否则"今天恰好没跨零点"就成了一张通行证，改一行班次它就生效（`board.config.js` 的配置校验同一取舍）。 */
      const dayList = [{ name: '晚班', start: 0, end: 8 }];
      const typos = [['\'false\'', 'false'], ['1', 1], ['{}', {}]];
      const noCrossBad = typos.map(([label, v]) => {
        const seg = throwOf(() => createShiftRules({ list: dayList, allowCrossMidnight: v }));
        const rule = throwOf(() => createShiftRules([{ name: '晚班', start: 0, end: 8, allowCrossMidnight: v }]));
        return { label, seg: !seg.ok && seg.err.constructor.name === 'TypeError', rule: !rule.ok && rule.err.constructor.name === 'TypeError' };
      });
      t.check('E131-3 **不跨零点的班次配置上打错字也必须拒**（真值表 3 组 × 段级/规则级）：' +
        '判据与"这次用没用到这个键"**无关** —— 非法的配置不该因为"今天恰好没跨零点"被放过' +
        '（现场改一行班次就可能让它生效；与 `board.config.js` 的"配置校验不等它出事"同一取舍）',
        noCrossBad.every(x => x.seg && x.rule),
        noCrossBad.every(x => x.seg && x.rule)
          ? `${noCrossBad.map(x => x.label).join('、')} 三组 × 段级/规则级 全部 TypeError`
          : '**被放过**的：' + noCrossBad.filter(x => !x.seg || !x.rule)
            .map(x => `${x.label}（段级拒=${x.seg}、规则级拒=${x.rule}）`).join('；'));

      /* ④ `undefined`／`false` ⇒ **关闸**，且 `E128` 的原判据**不许放宽**：
         `undefined`（键不在场）与 `false`（显式关）在**配置段形态**下都走**既有 fail-closed 拒绝**
         （`RangeError`，消息指名"先做 `E83` 的两个投影"），**不是** `TypeError` ——
         "关闸"是**已声明**的一个取值，不是"看不懂"的兜底去处（两者必须能被分辨）。 */
      const offGate = [['undefined（键不在场）', undefined], ['false（显式关）', false]].map(([label, v]) => {
        const seg = { list: [{ name: '夜班', start: 22, end: 6 }] };
        if (v !== undefined) seg.allowCrossMidnight = v;
        const r = throwOf(() => createShiftRules(seg));
        const msg = r.ok ? '' : String(r.err.message);
        return { label, ok: r.ok, type: r.ok ? '' : r.err.constructor.name,
          e83: /E83/.test(msg) && /两个投影/.test(msg), isType: r.ok ? false : r.err.constructor.name === 'TypeError' };
      });
      t.check('E131-4 `undefined`／`false` ⇒ **关闸**（配置段形态下都走**既有 fail-closed 拒绝**）：' +
        '两者都抛 `RangeError` 且消息指名"先做 `E83` 的两个投影"（`E128` 的原判据**一个字都没放宽**）；' +
        '而且它们**不是** `TypeError` —— "已声明为关"与"打错字"必须能在读数上分辨',
        offGate.every(x => x.ok === false && x.type === 'RangeError' && x.e83 && !x.isType),
        offGate.map(x => `${x.label}：ok=${x.ok}、异常=${x.type}、含"E83 两个投影"=${x.e83}、是 TypeError=${x.isType}`).join('；'));

      /* ⑤ `true` 是**唯一**能开闸的取值：段级 `true` 与规则级 `true` 都放行，且 `crossMidnight()`
         如实自述 `{allowed:true,count:1,keys:['夜班 22-6']}`；而**非布尔真值**（`'true'`／`1`／`[]`／`{}`）
         一律在①/②里被拒 —— 两端合起来＝"取值域闭合"（`open(v) === (v === true)`）。 */
      const openTrue = [['段级', () => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }], allowCrossMidnight: true })],
        ['规则级', () => createShiftRules([{ name: '夜班', start: 22, end: 6, allowCrossMidnight: true }])]]
        .map(([label, mk]) => { const r = throwOf(mk); return { label, ok: r.ok, cm: r.ok ? r.out.crossMidnight() : null }; });
      const truthy = ['true', 1, []].map((v, i) => {
        const val = i === 0 ? 'true' : v;
        const r = throwOf(() => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }], allowCrossMidnight: val }));
        return { label: i === 0 ? '\'true\'' : JSON.stringify(v), rejected: !r.ok && r.err.constructor.name === 'TypeError' };
      });
      t.check('E131-5 取值域**闭合**：`true` 是**唯一**能开闸的取值 —— 段级/规则级 `true` 都放行且 ' +
        '`crossMidnight() = {allowed:true,count:1,keys:[\'夜班 22-6\']}`；而**非布尔真值**' +
        '（`\'true\'`／`1`／`[]`）一律被拒（与①/②同一把尺子）⇒ `开闸(v) === (v === true)`',
        openTrue.every(x => x.ok && x.cm.allowed === true && x.cm.count === 1 &&
          JSON.stringify(x.cm.keys) === JSON.stringify(['夜班 22-6'])) &&
        truthy.every(x => x.rejected),
        `开闸读数：${openTrue.map(x => `${x.label}=${JSON.stringify(x.cm)}`).join('；')}；` +
        `非布尔真值被拒：${truthy.map(x => `${x.label}=${x.rejected}`).join('、')}`);

      /* ---- `E131-6`（`T-20261004-16` 追加件）：**第二入参（`options`）路径** ----
         立案：座位 5 在 `C·22` 靶子④ 实测 `E131` 的形态校验共有 **6 处**防线，但 `E131-1..5`
         **一处都没测** `createShiftRules(seg, opts)` 的**第二入参** —— 那条路径当前**无缺陷**
         （座位 5 实测非布尔值全 `TypeError`），属"没缺陷但**没守据**"：下一批同样的改动
         会悄悄绕开它。本节按实现的实际优先级补两条。
         **实测的优先级（本座位核到，逐字给出式子）**：
           · `createShiftRules()` 里 `const opts = options && typeof options === 'object' ? options : {}`
             （第二参只认对象，其余一律当 `{}`）；
           · `const merged = Object.assign({}, seg ? { allowCrossMidnight: seg.allowCrossMidnight } : {}, opts)`
             ⇒ **`options` 覆盖段级**（后写的赢）；
           · 而 `opts.allowCrossMidnight` 的**形态**在
             `assertBoolSwitch(opts.allowCrossMidnight, '调用方传入的 options')` 处**无条件**校验
             （只要给了第二参，无论段级写没写都要过这一关）。 */
      const optsBad = NONBOOL.map(([label, v, shown]) => {
        const r = throwOf(() => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }] }, { allowCrossMidnight: v }));
        const msg = r.ok ? '' : String(r.err.message);
        return { label, ok: r.ok, type: r.ok ? '' : r.err.constructor.name,
          named: msg.includes('收到 ' + shown), where: msg.includes('调用方传入的 options') };
      });
      const optsGood = [
        ['不传第二参（段级未声明）', () => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }] })],
        ['第二参显式 true', () => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }] }, { allowCrossMidnight: true })],
        ['第二参显式 false', () => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }] }, { allowCrossMidnight: false })],
        ['第二参 undefined（同"不传"）', () => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }] }, { allowCrossMidnight: undefined })],
        /* **优先级**：段级 `false` ＋ `options` `true` ⇒ 以 `options` 为准（开闸）；
           反向组合（段级 true ＋ options false）⇒ 关闸（不得靠段级放行）。 */
        ['段级 false ＋ options true ⇒ 开闸', () => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }], allowCrossMidnight: false }, { allowCrossMidnight: true })],
        ['段级 true ＋ options false ⇒ 关闸', () => createShiftRules({ list: [{ name: '夜班', start: 22, end: 6 }], allowCrossMidnight: true }, { allowCrossMidnight: false })]
      ].map(([label, mk]) => {
        const r = throwOf(mk);
        return { label, ok: r.ok, type: r.ok ? '' : r.err.constructor.name, msg: r.ok ? '' : String(r.err.message) };
      });
      t.check('E131-6 **第二入参（`options`）路径**同款：`createShiftRules(配置段, {allowCrossMidnight:<非布尔>})` ' +
        '逐个 `TypeError`、指名实际值与类型、并点明"**调用方传入的 options**"；对照：不传／`true`／`false`／`undefined` ' +
        '各自走既有语义，且段级与 options 冲突时 **options 覆盖**（段级 false＋options true ⇒ 开闸；段级 true＋options false ⇒ 关闸）',
        optsBad.every(x => x.ok === false && x.type === 'TypeError' && x.named && x.where)
          && optsGood[0].ok === false && /E83/.test(optsGood[0].msg)     /* 不传 ⇒ fail-closed（E128 原判据未放宽） */
          && optsGood[1].ok === true && optsGood[2].ok === false && optsGood[3].ok === false
          && optsGood[4].ok === true && optsGood[5].ok === false,
        `真值表 ${optsBad.length} 组：全部 TypeError＋指名＝${optsBad.every(x => x.ok === false && x.type === 'TypeError' && x.named && x.where)}` +
        `（例：${optsBad.length ? optsBad[1].label : '-'}）；对照：` +
        optsGood.map(x => `${x.label}⇒${x.ok ? '放行' : x.type}`).join('；'));
    }
  }
}

  /* ================= 乙⑨ `E139`：`splitRunSecondsByDay()` 的**降级标记**（`T-20261004-16` 追加件） =================
     立案（主代理亲验 `E132` 时误传入参发现、座位 3 实现、主代理裁定**收窄口径**）：入参**形态不全**时
     旧实现**静默**退化为"整段归班次开始日"（无任何信号）⇒ 调用方会以为"这段不跨零点"（`E38` 同族：
     把"看不懂"当成一个合法取值）。现口径（本座位核过实现）：
       · **形态完整 ⇒ 返回值一个键都不加**（与 HEAD 旧字节逐字节相同）；
       · **形态不全 ⇒ 追加** `degraded:true` ＋ `degradedReason`（人读）＋ `degradedMissing`（机器可核的字段名数组，
         顺序 `start`→`end`→`startAt`→`endAt`→`date`）；既有五个键**逐值不变**；
       · **语义**：`degraded` 缺席或 `false` ⇒ **判定有效**（向后兼容）；`degraded` 为真 ⇒
         **"这次没能判跨零点"，不是"确实不跨零点"**；
       · **`totalSec` 移出 fault 列表**（主代理裁定收窄）：它不参与运算、缺它数值逐值相同 ⇒ 置 `degraded`
         属 **cry wolf**。 */
  {
    const s139 = createShiftRules([{ name: '夜班', start: 22, end: 6, allowCrossMidnight: true }]);
    const full139 = s139.at('2026-10-31T23:00:00');
    /* 完整形态（`at()` 的产物）＋ 运行 9000 s（跨零点、真切段那一支，已生产可用） */
    const fullOut139 = stats.splitRunSecondsByDay(full139, 9000);
    const FIVE139 = ['day1', 'day2', 'crossing', 'day1Date', 'day2Date'];
    /* 不完整形态：从完整对象里**删**掉一个字段（`{}` 根对象在 `Object.assign` 时不复制 `undefined`
       ⇒ 必须显式覆盖成 `undefined` 才算"缺"）。 */
    const missOne139 = (field) => {
      const o = Object.assign({}, full139); o[field] = undefined; return o;
    };
    const cases139 = [
      ['完整形态（`at()` 产物）', full139, [], true],
      ['缺 `startAt`', missOne139('startAt'), ['startAt'], false],
      ['缺 `endAt`', missOne139('endAt'), ['endAt'], false],
      /* ⚠ `E154`（2026-10-04，据 `C·23` 第 7 组）：**"只缺 `date`"这一支必须仍走"按零点切段"**
         （`crossing:true`）—— 这是 `E139` 的**口径裁定**（"两段的时刻在场、已按零点切了段，
         但入参形态不予背书"），不是"当前实现的快照"；旧谓词对它**两支都放行**
         （`crossing === false ? day2 === 0 : …`）⇒ 把它退回"整段归开始日"照样绿。 */
      ['缺 `date`', missOne139('date'), ['date'], true],
      ['缺 `start`/`end`（连判定都做不了）', { name: '夜班', startAt: full139.startAt, endAt: full139.endAt, date: '2026-10-31', elapsedSec: 9000 }, ['start', 'end'], false],
      ['缺四个（只留 `date`）', { name: '夜班', date: '2026-10-31' }, ['start', 'end', 'startAt', 'endAt'], false],
      ['`{}`', {}, ['start', 'end', 'startAt', 'endAt', 'date'], false]
    ].map(([label, obj, wantMissing, wantCross]) => {
      const out = stats.splitRunSecondsByDay(obj, 9000);
      return { label, obj, out, wantMissing, wantCross, hasDeg: 'degraded' in out, deg: out.degraded,
        keys: Object.keys(out), fiveSame: FIVE139.every(k => out[k] === fullOut139[k]),
        gotMissing: Array.isArray(out.degradedMissing) ? out.degradedMissing.join(',') : '(无数组)',
        wantMissingStr: wantMissing.join(','), reason: out.degradedReason || '' };
    });
    const full139Row = cases139[0];
    const bad139 = cases139.slice(1);
    /* 形态不全 ⇒ **走的是"不跨自然日"那一支**（`crossing:false`）——这一支就是 `E139` 以前
       静默退化的那一支。故"数值不变"的**对照物**是这一支的**无故障读数**，不是跨零点那一支的
       `day2`（跨零点时 `day2` 本来就 ≠ 0；拿它当对照会得出"数值变了"的**假红** —— 本座位第一版
       就把它当成 `fiveSame` 的比较对象，实测六种形态全报 false，理由写在这里）。 */
    const noCross139 = stats.splitRunSecondsByDay(
      { name: '夜班', start: 0, end: 8, startAt: '2026-10-31T00:00:00', endAt: '2026-10-31T08:00:00', date: '2026-10-31' }, 9000);
    const noCrossCfg139 = { start: 0, end: 8, date: '2026-10-31' };
    /** `E154` 的**次一日**（用于把"跨零点支的 `day2Date`"钉住；从 `day1Date` 现推，不写死 '2026-11-01'）。 */
    const ymdNext139 = (ymd) => {
      const d = new Date(String(ymd) + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    /** **`E154`（2026-10-04，据 `C·23` 第 7 组）：标题强于谓词 —— 把标题里的承诺搬进谓词。** 两处各一句：
     *   · `E139-1`：旧谓词**只比键集**（`!hasDeg && keys.length === 5 && 五键在场`），而标题写的是
     *     "这五个键与'不跨零点那一支'的无故障读数**逐值相同**" ⇒ 读标题的人以为守住了、读谓词的人知道没守住
     *     （`D23`：**台账/回执里抄的往往是标题**）。本判据把"逐值"落成三条**由入参推出**的比较（不写死期望值）：
     *       ⓐ 两支**共享语义**的三键（`day1`／`day2`／`day1Date`）**逐值相同**；
     *       ⓑ `crossing` 与"由 `start`/`end` 推出的跨零点判定"**逐值一致**（跨零点支 true、非跨零点支 false）；
     *       ⓒ `day2Date`：跨零点支 ＝ `day1Date` 的**次日**；非跨零点支 ＝ `day1Date`；且两段之和恒 ＝ `runSec`。
     *     ⚠ **为什么不是"五键全同"**（如实登记）：`full139` 是**跨零点配置**（夜班 22-6）⇒ `crossing` 与
     *     `day2Date` 按定义**不可能**与"不跨零点那一支"相同 ⇒ 标题原来那句逐字读是错的；本件把标题改成与
     *     谓词相符的写法（**不是**把承诺删掉，而是把它拆成"共享三键逐值 ＋ 两个跨零点键各自钉死"）。
     *   · `E139-2`：旧谓词写 `crossing === false ? day2 === 0 : day2 === 9000 − day1` ⇒ "把'只缺 `date`'
     *     退回整段归开始日"的形态（`{crossing:false, day2:0}`，**保留** `degraded`／`degradedMissing`）
     *     **两支都放行** ⇒ 标题承诺的"**仍按零点切段**"没有任何断言在守。本判据改成**逐形态给期望**
     *     （`wantCross` 在用例表里，来源＝`E139` 的口径裁定，不是实现快照）。
     *  **主断言与 D22 共用本函数**（否则"变异后必红"只是人读谓词推出来的 —— 与 `E153` 同一个教训）。
     *  @returns {string[]} 违规说明（空＝合规） */
    const e139_1_problems = (row, ctrl, cfgCrossing, ctrlCfgCrossing) => {
      const p = [];
      if (row.hasDeg) p.push('完整形态**不该**带 `degraded`（"判定有效 ⇒ 原样返回、一个键都不加"）');
      if (row.keys.length !== 5) p.push(`键集应恰为 5 个（实测 ${row.keys.length} 个：[${row.keys.join(', ')}]）`);
      if (!FIVE139.every(k => Object.prototype.hasOwnProperty.call(row.out, k))) p.push('五键有缺');
      for (const k of ['day1', 'day2', 'day1Date']) {
        if (row.out[k] !== ctrl[k]) {
          p.push(`\`${k}\` 与"不跨零点那一支"的无故障读数应**逐值相同**（完整形态 ${JSON.stringify(row.out[k])} ≠ 对照 ${JSON.stringify(ctrl[k])}）`);
        }
      }
      if (row.out.crossing !== cfgCrossing) {
        p.push(`\`crossing\` 应与"由 \`start\`/\`end\` 推出的跨零点判定"一致（实测 ${row.out.crossing}，应为 ${cfgCrossing}）`);
      }
      if (ctrl.crossing !== ctrlCfgCrossing) p.push(`对照支的 \`crossing\` 应为 ${ctrlCfgCrossing}（实测 ${ctrl.crossing}）`);
      if (cfgCrossing) {
        if (row.out.day2Date !== ymdNext139(row.out.day1Date)) {
          p.push(`跨零点支的 \`day2Date\` 应为 \`day1Date\` 的次日（实测 ${JSON.stringify(row.out.day2Date)}，期望 ${JSON.stringify(ymdNext139(row.out.day1Date))}）`);
        }
      } else if (row.out.day2Date !== row.out.day1Date) p.push('非跨零点支的 `day2Date` 应等于 `day1Date`');
      if (row.out.day1 + row.out.day2 !== 9000) p.push(`两段之和应恒 ＝ runSec 9000（实测 ${row.out.day1 + row.out.day2}）`);
      return p;
    };
    const e139_2_problems = (list) => list.flatMap(c => {
      const p = [];
      if (c.deg !== true) p.push(`${c.label}：\`degraded\` 应为 \`true\`（实测 ${JSON.stringify(c.deg)}）`);
      if (c.gotMissing !== c.wantMissingStr) p.push(`${c.label}：\`degradedMissing\` 应为 [${c.wantMissingStr}]（实测 [${c.gotMissing}]）`);
      if (c.out.crossing !== c.wantCross) {
        p.push(`${c.label}：\`crossing\` 应为 **${c.wantCross}**（实测 ${c.out.crossing}）`
          + (c.wantCross ? '—— 这一支**必须仍按零点切段**（`E154`）' : ''));
      }
      if (c.wantCross) {
        if (c.out.day2 !== 9000 - c.out.day1) p.push(`${c.label}：按零点切段时应有 \`day2 === runSec − day1\`（实测 day1=${c.out.day1}／day2=${c.out.day2}）`);
        if (c.wantMissing.indexOf('date') >= 0 && c.out.day1Date !== undefined) {
          p.push(`${c.label}：缺 \`date\` ⇒ \`day1Date\` 必须**不背书**（应为 undefined，实测 ${JSON.stringify(c.out.day1Date)}）`);
        }
      } else if (c.out.day2 !== 0) p.push(`${c.label}：整段归开始日那一支应恒有 \`day2 === 0\`（实测 ${c.out.day2}）`);
      if (!FIVE139.every(k => typeof c.out[k] !== 'undefined' || k === 'day1Date' || k === 'day2Date')) {
        p.push(`${c.label}：\`day1\`/\`day2\`/\`crossing\` 不得为 undefined（实测 ${JSON.stringify(c.out)}）`);
      }
      return p;
    });
    const full139Problems = e139_1_problems(full139Row, noCross139,
      Number(full139.end) <= Number(full139.start), Number(noCrossCfg139.end) <= Number(noCrossCfg139.start));
    t.check('E139-1 **形态完整 ⇒ 一个键都不加；且五键逐个被"同一份实现 ＋ 入参"钉住**：`createShiftRules().at(...)` ' +
      '的完整对象 ⇒ 返回体键集**恰为** `{day1,day2,crossing,day1Date,day2Date}`（**连 `degradedReason`/`degradedMissing` 都没有**）；' +
      '且 `day1`／`day2`／`day1Date` 与"同一份实现里不跨零点那一支"的无故障读数**逐值相同**、`crossing` 与"由 `start`/`end` ' +
      '推出的跨零点判定"逐值一致、`day2Date` ＝ `day1Date` 的**次日**、两段之和恒 ＝ `runSec`（`E154`：标题的承诺已搬进谓词；' +
      '`D21`：值全部由入参推出，不写死期望值）',
      full139Problems.length === 0,
      `键集＝[${full139Row.keys.join(', ')}]；\`degraded\` 在场=${full139Row.hasDeg}（应 false）；` +
      `读数＝${JSON.stringify(full139Row.out)}；不跨零点对照＝${JSON.stringify(noCross139)}；` +
      (full139Problems.length ? `**逐值违规 ${full139Problems.length} 条**：${full139Problems.join('；')}` : '逐值比对：零违规'));

    t.check('E139-2 **缺字段 ⇒ `degraded:true` ＋ `degradedMissing` 指名缺哪个**（六种形态）；' +
      '数值上不得凭空多出时段（**逐形态给期望**：整段归开始日那一支 `day2` 恒 0；**只缺 `date`** 那一支仍按零点切段' +
      '（`crossing:true`、`day2 === runSec − day1`、`day1Date` 不背书）、且两种出口都可降级' +
      '（`E154`：旧谓词的"两支都放行"已改掉 —— 谓词与 D22 **共用** `e139_2_problems()`）',
      e139_2_problems(bad139).length === 0,
      (e139_2_problems(bad139).length ? `**违规 ${e139_2_problems(bad139).length} 条**：${e139_2_problems(bad139).join('；')}｜` : '零违规｜')
      + bad139.map(c => `${c.label}：degraded=${c.deg}、missing=[${c.gotMissing}]（应 [${c.wantMissingStr}]）、`
        + `crossing=${c.out.crossing}（应 ${c.wantCross}）/day1=${c.out.day1}/day2=${c.out.day2}`).join('；'));

    t.check('E139-3 **语义可分**：`start`/`end` 不在场时理由串**不得说"判定有效"**（必须承认"连是否跨零点都判不了"）；' +
      '`start`/`end` 在场但两个时刻缺失/不可解析（真跨零点那一支）时理由串必须点明' +
      '"**`crossing:false` 不代表"确实不跨零点"**"',
      (() => {
        const noStart = stats.splitRunSecondsByDay({ name: '夜班', date: '2026-10-31' }, 9000).degradedReason;
        const noTimes = stats.splitRunSecondsByDay({ name: '夜班', start: 22, end: 6, date: '2026-10-31' }, 9000).degradedReason;
        return /判不了/.test(noStart) && !/判定\*\*有效\*\*/.test(noStart)
          && /切不了段/.test(noTimes) && /不代表/.test(noTimes) && /确实不跨零点/.test(noTimes);
      })(),
      (() => {
        const noStart = stats.splitRunSecondsByDay({ name: '夜班', date: '2026-10-31' }, 9000).degradedReason;
        const noTimes = stats.splitRunSecondsByDay({ name: '夜班', start: 22, end: 6, date: '2026-10-31' }, 9000).degradedReason;
        return `缺 start/end ⇒ 「${noStart.slice(0, 70)}…」；缺时刻（配置说跨零点）⇒ 「${noTimes.slice(0, 70)}…」`;
      })());

    const noTotal139 = Object.assign({}, full139); delete noTotal139.totalSec;
    const noTotalOut139 = stats.splitRunSecondsByDay(noTotal139, 9000);
    t.check('E139-4 **缺 `totalSec` ⇒ 不降级**（主代理裁定的收窄口径：它不参与运算、缺它数值逐值相同 ⇒ 置 `degraded` 是 cry wolf）：' +
      '键集仍恰为五键、与完整形态逐值相同',
      !('degraded' in noTotalOut139) && JSON.stringify(noTotalOut139) === JSON.stringify(fullOut139),
      `键集＝[${Object.keys(noTotalOut139).join(', ')}]；与完整形态逐值相同=${JSON.stringify(noTotalOut139) === JSON.stringify(fullOut139)}`);

    /* `E139` 的 D22（可证伪）：把"判定有效 ⇒ 原样返回"与"降级 ⇒ 加三键"两条路径**互换**
       （`server\services\stats.js` 的**内存字节副本**，`Module._compile`；盘上文件全程只读）。 */
    {
      const STATS_FILE = path.join(ROOT, 'server', 'services', 'stats.js');
      const src0 = fs.readFileSync(STATS_FILE, 'utf8');
      /* ⚠ 锚点**不跨行**（`\r\n` 与 `\n` 两种行尾都要能命中 —— 本座位第一版把两条 return 连换行
         一起写进锚点，而盘上是 CRLF ⇒ 锚点未命中、D22 直接判红，实测踩过）。 */
      /* ⚠ 互换的必须是**同作用域内可解析、且真的会改变行为**的片段（三次踩坑后定稿，逐条留痕）：
         ① 连 `return markSplitDegraded(` 一起换 ⇒ 括号配对错（`SyntaxError`）；
         ② 只换 `{...}` 字面量 ⇒ `only` 只在"整段归当日"那一支声明 ⇒ `ReferenceError`；
         ③ 换 `faults` ⇒ 它在两支里都由 `shiftShapeFaults(shift)` 现算 ⇒ 同一入参下**值相同**、换不出差别。
         ⇒ 换 `facts`（`{cut:false,…}` ↔ `{cut:true,…}`）：两支都在作用域内、且**语义正好相反**
           （"判定有效"被标成"已切段但不背书"、"降级"被标成"切了段"）⇒ 两支的降级与否**当场互换**。 */
      const A1 = '{ day1: total, day2: 0, crossing: false, day1Date: only, day2Date: only }';
      const B1 = '{ day1, day2: total - day1, crossing: true, day1Date: shift.date, day2Date: fmtDate(midnight) }';
      const A2 = '{ cut: false, startEndNumeric, cfgCrossing }';
      const B2 = '{ cut: true, startEndNumeric, cfgCrossing }';
      const anchorOk = src0.split('  const faults = shiftShapeFaults(shift);').length === 2;
      let mutOut = null; let mutDeg = null; let mutFive = null; let fullSrc = null; let mutFn = null;
      if (anchorOk) {
        /* **把两条出口互换**（最直白的变异）：插一个开关，把"整段归当日那一支"的入口判据反相 ——
           · `bounds` 反相（`null`）⇒ **完整形态也落到"整段归当日"那一支**，而那一支的 `faults`
             被清空 ⇒ 返回体**没有** `degraded`（**违反** E139-1 的"完整形态一个键都不加"）；
           · `faults` 反相（空）⇒ **缺字段的形态也拿不到 `degradedMissing`**（**违反** E139-2）。
           ⚠ 四次踩坑的留痕（逐条写在这里，免得下一个人重踩）：
             ① 连 `return markSplitDegraded(` 一起换 ⇒ 括号配对错（`SyntaxError`）；
             ② 只换 `{...}` 字面量 ⇒ `only` 只在另一支声明 ⇒ `ReferenceError`；
             ③ 只换 `facts`（`cut:false ↔ cut:true`）⇒ `markSplitDegraded()` 只看 `faults.length`
                ⇒ 入参不变则**行为逐字不变**（本条 D22 因此假红过一次）；
             ④ 开关插在 `const faults = …` 处 ⇒ `bounds` 在它之前就用它 ⇒ **TDZ** `ReferenceError`。 */
        const mutSrc = src0
          .replace('  const total = Math.max(0, Math.round(Number(runSec) || 0));',
            '  const __e139Invert = true;\n  const total = Math.max(0, Math.round(Number(runSec) || 0));')
          .replace('  const faults = shiftShapeFaults(shift);',
            '  const faults = __e139Invert ? [] : shiftShapeFaults(shift);')
          .replace('  const bounds = (() => {',
            '  const bounds = __e139Invert ? null : (() => {');
        const M = require('node:module');
        const mod = new M(STATS_FILE + '#e139', null);
        mod.filename = STATS_FILE;
        mod.paths = M._nodeModulePaths(path.dirname(STATS_FILE));
        mod._compile(mutSrc, mod.filename);
        mutFn = mod.exports.splitRunSecondsByDay;
        mutOut = mutFn(full139, 9000);
        mutDeg = 'degraded' in mutOut;
        mutFive = FIVE139.every(k => mutOut[k] === fullOut139[k]);
        fullSrc = mutFn;
      }
      /* "必红并指名"的读数＝**同一条期望在两个方向上都被违反**：
         ① 完整形态本该**没有** `degraded`，变异后却有了；② 五键本该逐值相同，变异后"判不了"那一支
         反而返回了 `day1/day2/crossing:true` 的切段读数 ⇒ 期望的 `sevenKeys`／missing 两个细节都对不上。 */
      const mutMissing = (anchorOk && mutFn) ? mutFn(missOne139('startAt'), 9000).degradedMissing : null;
      /* ——— `E154`（2026-10-04，据 `C·23` 第 7 组）的两支**受控变异读数**（都喂**共用谓词**）———
         ㈠ `E139-1` 的"只比键集"旧谓词 vs "逐值"新谓词：把完整形态读数的 `day1`／`day2` 改坏
            （`{day1:1000, day2:8000}`，键集与 `degraded` 一字不动）⇒ **旧谓词照样 true（放行）**、
            新谓词必红并**指名 `day1`／`day2`**；
         ㈡ `E139-2` 的"只缺 `date`"退回**整段归开始日**（`{crossing:false, day1:9000, day2:0}`，
            **保留** `degraded:true`／`degradedMissing:['date']`）⇒ 旧谓词照样 true、新谓词必红并指名
            "`crossing` 应为 true —— 这一支必须仍按零点切段"。
         ⚠ 旧谓词是**照抄**（只为给"改动前"读数；判据本体一律走共用纯函数）。 */
      const mutRow139 = Object.assign({}, full139Row, { out: Object.assign({}, full139Row.out, { day1: 1000, day2: 8000 }) });
      const oldPredicate139_1 = (row) => !row.hasDeg && row.keys.length === 5
        && FIVE139.every(k => row.keys.includes(k))
        && FIVE139.every(k => Object.prototype.hasOwnProperty.call(row.out, k));
      const newProblems139_1 = e139_1_problems(mutRow139, noCross139,
        Number(full139.end) <= Number(full139.start), Number(noCrossCfg139.end) <= Number(noCrossCfg139.start));
      const dateCase139 = cases139.find(c => c.wantMissing.indexOf('date') >= 0);
      const pushBack139 = Object.assign({}, dateCase139, {
        out: Object.assign({}, dateCase139.out, { crossing: false, day1: 9000, day2: 0 })
      });
      const oldPredicate139_2 = (c) => c.deg === true && c.gotMissing === c.wantMissingStr
        && (c.out.crossing === false ? c.out.day2 === 0 : c.out.day2 === 9000 - c.out.day1)
        && FIVE139.every(k => typeof c.out[k] !== 'undefined' || k === 'day1Date' || k === 'day2Date');
      const oldPushBackVerdict139 = oldPredicate139_2(pushBack139);
      const newPushBackProblems139 = e139_2_problems([pushBack139]);
      t.check('E139-5 D22（可证伪）：把"**判定有效 ⇒ 原样返回**"与"**降级 ⇒ 加三键**"两条路径**互换**' +
        '（`server\\services\\stats.js` 的**内存字节副本**：把"整段归当日那一支"的入口判据反相、并清空 `faults`）' +
        '⇒ `E139-1`／`E139-2` 的期望**当场被违反**（完整形态在本该"判定有效"时拿不到 `degraded`、' +
        '缺字段的形态反倒拿不到 `degradedMissing`）；而**原件**同两条期望都成立；盘上文件逐字节未变。' +
        '**`E154` 追加两支受控变异**：①完整形态的 `day1`／`day2` 改坏 ⇒ **只比键集的旧谓词放行**、' +
        '**逐值的新谓词必红并指名**；②"只缺 `date`"退回整段归开始日 ⇒ **旧谓词放行**、' +
        '**新谓词必红并指名"这一支必须仍按零点切段"**',
        Boolean(fullSrc) && anchorOk && mutDeg === false && mutFive === false
          && !Array.isArray(mutMissing)
          && oldPredicate139_1(mutRow139) === true && newProblems139_1.length > 0
          && newProblems139_1.some(x => x.indexOf('`day1`') >= 0) && newProblems139_1.some(x => x.indexOf('`day2`') >= 0)
          && oldPushBackVerdict139 === true && newPushBackProblems139.length > 0
          && newPushBackProblems139.some(x => x.indexOf('`crossing`') >= 0 && x.indexOf('**true**') >= 0),
        (anchorOk
          ? `变异体：完整形态 ` + '`degraded`' + ` 在场=${mutDeg}（应 false ＝**违反** E139-1）、五键同值=${mutFive}`
            + `（应 false）、缺 startAt 时 degradedMissing=${JSON.stringify(mutMissing)}（应 **undefined** ＝违反 E139-2）；盘上未变=true`
          : '**锚点未命中**（stats.js 的 `const faults = shiftShapeFaults(shift);` 形状变了）⇒ 判红，不许静默放过')
        + `｜【\`E154\` ㈠】把完整形态读数改成 \`day1=1000/day2=8000\`（键集与 \`degraded\` 不动）⇒ `
        + `**旧谓词（只比键集）判决=${oldPredicate139_1(mutRow139)}（＝放行）**、新谓词违规 ${newProblems139_1.length} 条＝`
        + `${newProblems139_1.join('；') || '（无，异常）'}`
        + `｜【\`E154\` ㈡】"只缺 \`date\`"退回整段归开始日 ⇒ **旧谓词判决=${oldPushBackVerdict139}（＝放行）**、`
        + `新谓词违规 ${newPushBackProblems139.length} 条＝${newPushBackProblems139.join('；') || '（无，异常）'}`);
      t.info(`\`E154\` 读数（` + '`PASS`' + ` 详情不打印 ⇒ 这里留痕）：`
        + `\`E139-1\` 谓词从"只比键集"改成**逐值**（共享三键逐值 ＋ \`crossing\` 由入参推出 ＋ \`day2Date\` ＝ 次日 ＋ 两段和恒等）；`
        + `\`E139-2\` 改成**逐形态给期望**（\`wantCross\`：完整／缺 date ⇒ true，其余 ⇒ false），`
        + `两处都抽成纯函数并与 D22 **共用**。`
        + `【㈠ "day1/day2 改坏"】旧谓词（只比键集）判决=${oldPredicate139_1(mutRow139)}（**放行**）、`
        + `新谓词违规 ${newProblems139_1.length} 条＝${newProblems139_1.join('；') || '（无）'}；`
        + `【㈡ "只缺 date 退回整段归开始日"】旧谓词判决=${oldPushBackVerdict139}（**放行**）、`
        + `新谓词违规 ${newPushBackProblems139.length} 条＝${newPushBackProblems139.join('；') || '（无）'}；`
        + `两处**指名**都能从违规串里读到（㈠指名 \`day1\`/\`day2\`、㈡指名"这一支必须仍按零点切段"）。`);
    }
  }

  t.finish();
}

/* 与既有脚本一致：异常以退出码 2 结束（打印行含字面 `脚本异常终止`，`run-all` 的失败明细据此命中） */
try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
