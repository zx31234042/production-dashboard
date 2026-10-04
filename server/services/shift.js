/* ==========================================================================
   班次计算（server/services/shift.js）
   作用：把"某个时刻属于哪个班次、班次从几点到几点、进行了多久、跨零点归哪一天"
        全部算清楚。这是 FR-4.16（跨零点归属正确）与 FR-1.9/1.10（当前班次与起止时间）
        的**服务端口径（权威实现）** —— **口径来自 src/config/board.config.js 的 shift.list，
         不在此处另定**。
   ⚠ R26-P3-5 更正：原写"唯一实现处"，**与事实不符** —— 浏览器侧 `src/services/mockData.js`
        的 `shiftOf()` 是同一规则的**第二份实现**（前端不能 require 服务端模块，只能逐字复制规则）。
        两侧必须**逐条同规则、改动须同步**，否则头屏班次与服务端统计会分叉（当前配置
        0-8/8-16/16-24 下两侧输出一致，故长期潜伏；跨零点配置下曾实测分叉）。
        逐条对照（机器断言见 `tests/logic-check.js` 的「二、」段）：
          ① 命中判据：end > start ⇒ 半开区间 [start, end)；end < start（跨零点）⇒ [start, 24) ∪ [0, end)；
          ② `end = 24` 表示次日 0 点（结束日 +1）；
          ③ 归属日 = 班次**开始**那天（跨零点且处于 0～end 段时回退一天）；
          ④ 时刻不属任何班次（配置缺口）⇒ **显式抛错**，绝不静默兜底（两侧同）。
   ⚠ **跨零点配置的显式 opt-in（`E128`，2026-10-04）** —— 这是本文件里唯一的准入闸：
        规则 `end < start`（跨零点，如 22→6）**必须**由配置显式给出 `allowCrossMidnight: true`
        才被接受，否则 `createShiftRules()` **当场拒绝**并抛出可读原因（见
        `assertCrossMidnightAllowed()`；配置面＝`src/config/board.config.js` 的 `shift` 段）。
        为什么这道闸不是多余的仪式（`E128` 的原始问题）：跨零点班次的**运行秒数跨自然日**
        ⇒ 必须先有 `E83` 的**自然日投影**（按零点切段、落盘 `shift_stat.run_sec_day1/run_sec_day2`
        ＋ `services/stats.js` 的 `accumulateRunTime()` 接两段），否则"当日累计"会**静默错位**
        （已固化部分按班次归属日 `shift_date` 相加、未固化增量整段落进 `now` 所在自然日），
        且症状看上去像"数据问题"、不像"配置问题"。⇒ **先做掉 `E83` 的两个投影，再在这里开闸。**
        归属日那一半（DR-06 逐字"班次开始那天"）与这道闸**无关**：`at()` 的
        `startDayOffset = -1` 与 `date = fmtDate(startAt)`（下方 :83/:99 一带）一直是对的，不动。
   依赖：platform/clock.js（时间一律注入，禁止 new Date()）。
    ========================================================================== */
'use strict';

const { fmt, fmtDate, toDate } = require('../../platform/clock');

/** 规则是否**跨自然日**（运行窗口越过零点）。
 *  判据＝`end <= start`（如 22→6；`end = 24` 也落在这里：16→24 的窗口收在**次日 0 点**，
 *  半开区间 [16:00, 24:00) 里最后一秒仍是当天 23:59:59 ⇒ 运行秒数确实只落在当天，
 *  但**窗口的结束时刻在次日** ⇒ 按"跨自然日班次"处理才与 `endAt`/`totalSec` 一致）。
 *  ⚠ 与 `at()` 里 `endAt.setDate(endAt.getDate() + 1)` 的那条判据**必须同源**（同一条不等式），
 *    否则会出现"归属日按跨零点回退、切段却按不跨零点算"这类两套口径。 */
function isCrossMidnight(rule) {
  return Number(rule.end) <= Number(rule.start);
}

/**
 * `E128` 的准入闸：含跨零点规则时**必须**显式 opt-in，否则拒绝。
 *
 * **两种入参形态，两种强度（刻意分开，见下）**：
 *   · **配置段形态**（`{ list, allowCrossMidnight, … }`，或显式给 `options`）—— 这是**生产入口**：
 *     `server/index.js` 与 `services/stateSnapshot.js` 传的就是 `board.config.js` 的整个 `shift` 段。
 *     ⇒ **fail-closed**：含跨零点规则而没开闸就**当场抛错**（启动期拒绝，"不留能配但算错的窗口"）；
 *   · **裸数组形态**（`createShiftRules([{name,start,end}])`，无任何开关上下文）—— 这是
 *     **规则引擎**的用法（`tests/logic-check.js:215/:267/:300` 用它验"跨零点归属日/边界半开/总时长"
 *     这些**与配置闸无关**的规则；`mockData.js` 是前端第二实现、不走这里）。
 *     ⇒ 此处**照旧放行**（`E83` 之前的行为逐字不变），**但**：① 消息面（启动日志/`/health`）
 *     仍由 `crossMidnight()` 如实自述；② 生产路径**没有**绕过闸的口子（唯一入口是配置段）。
 *
 * 为什么不做成"裸数组也抛"（本包实测过的代价，如实登记）：`tests/logic-check.js` 在**模块顶层**
 * 直接 `createShiftRules(NIGHT1)` ⇒ 抛错会变成**整脚本异常**（`E76` 形态：无汇总行 + 退 2、
 * `run-all` 记 `error`），**158 条断言一条都跑不出来** —— 那不是"红一条"，而是"把证据全丢掉"；
 * 而本包的纪律是 tests 归 4b、且判据要有汇总行。故取舍：**危险的入口（配置段）fail-closed，
 * 纯规则引擎入口保持可用**，代价写在这里，由 4b 决定要不要给裸数组也立一条门禁。
 *
 * 配置面（两选一，等价）：整个 shift 段写 `allowCrossMidnight: true`，或写在**规则自己**身上
 * `{ name:'夜班', start:22, end:6, allowCrossMidnight:true }`。
 * @param {Array} rules 已归一化的规则（含 name/start/end）
 * @param {{allowCrossMidnight?:boolean}} [options]
 * @param {boolean} [strict] `true` ＝配置段形态（fail-closed）；`false` ＝裸数组形态（放行、只自述）
 */
function assertCrossMidnightAllowed(rules, options, strict) {
  const crossing = rules.filter(isCrossMidnight);
  if (!crossing.length) return;
  const allowed = Boolean(options && options.allowCrossMidnight) ||
    crossing.every(r => r.allowCrossMidnight === true);
  if (allowed) return;
  if (!strict) return;   // 裸数组形态：见上方 docblock 的取舍说明
  throw new RangeError(
    'shift: 配置里含**跨零点班次**（' +
    crossing.map(r => `${r.name} ${r.start}-${r.end}`).join(' , ') +
    '），但未显式开启 `allowCrossMidnight`。跨零点班次的运行秒数跨自然日 ⇒ ' +
    '**必须先做 `E83` 的两个投影**（班次投影＋按零点切段的自然日投影：' +
    '`shift_stat.run_sec_day1/run_sec_day2` 落盘、`services/stats.js` 的 `accumulateRunTime()` 接两段），' +
    '否则"当日累计"会静默错位（已固化按班次归属日、未固化增量整段落 `now`）。' +
    '确认两个投影已实现后，在 `board.config.js` 的 `shift` 段写 `allowCrossMidnight: true` 再启动。' +
    '（`E128` 的显式 opt-in；拒绝而不是告警，是为了**不留"能配但算错"的窗口**。）');
}

/**
 * 由配置生成班次规则。
 * @param {Array<{name:string,start:number,end:number,allowCrossMidnight?:boolean}>} list
 *   如 [{晚班,0,8},{早班,8,16},{中班,16,24}]；也可传整个 `shift` 段对象
 *   （含 `list` 与 `allowCrossMidnight` —— 见下方 `listingsOf()`）。
 *   约定：start/end 为 24 小时制整点；`end` 可为 24 表示次日 0 点。
 * @param {{allowCrossMidnight?:boolean}} [options] 跨零点准入开关（`E128`；见 `assertCrossMidnightAllowed()`）
 */
function createShiftRules(list, options) {
  /* 入参形态归一（`E128` 顺带）：既接受"裸数组"（`shift.list`），也接受**整个 shift 段对象**
     （`{ list, countHoliday, roster, allowCrossMidnight }`）—— 后者让准入开关能随配置段一起传进来，
     调用处（`server/index.js` :586 与 `services/stateSnapshot.js`）不必自己拆包再拼一次选项。
     为什么值得这一层：`allowCrossMidnight` 是**配置段上的键**，而 `segOf(config,'shift')` 拿到的是
     整个段；如果这里只认数组，那个键就会被静默丢掉（＝闸失效）。 */
  const opts = options && typeof options === 'object' ? options : {};
  const seg = (!Array.isArray(list) && list && typeof list === 'object' && Array.isArray(list.list))
    ? list : null;
  /* 形态归一：`raw` 不是数组也走下面那条"班次列表为空"（`R26-P3-5` 的既有口径：配置缺口/缺段
     一律**显式报错**、不静默兜底）—— 否则会抛出 `(raw || []).map is not a function` 这种
     对现场毫无帮助的错（实测：`createStateSnapshot({config:{}})` 曾落到这一支）。 */
  const raw = Array.isArray(seg ? seg.list : list) ? (seg ? seg.list : list) : [];
  const merged = Object.assign({}, seg ? { allowCrossMidnight: seg.allowCrossMidnight } : {}, opts);

  const rules = raw.map(s => ({
    name: s.name,
    start: Number(s.start),
    end: Number(s.end),
    /* 规则级开关只在**显式 true** 时生效（缺省 undefined ⇒ 不放行），不参与任何算式 */
    allowCrossMidnight: s.allowCrossMidnight === true
  }));
  if (!rules.length) throw new Error('shift: 班次列表为空，请检查 board.config.shift.list');

  /* 配置校验（P2-3）：非法配置过去是"静默走兜底分支、算出看似合理的班次"，
     比直接报错危险得多 —— 看板上会显示错的班次名与时长。故此处一律拒绝。 */
  for (const r of rules) {
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end)) {
      throw new TypeError(`shift: 班次「${r.name}」的 start/end 必须是整点（收到 ${r.start}/${r.end}）`);
    }
    if (r.start < 0 || r.start >= 24) {
      throw new RangeError(`shift: 班次「${r.name}」的 start 必须在 0～23（收到 ${r.start}）；次日 0 点用 end=24 表达`);
    }
    if (r.end < 1 || r.end > 24) {
      throw new RangeError(`shift: 班次「${r.name}」的 end 必须在 1～24（收到 ${r.end}）`);
    }
    if (r.start === r.end) {
      throw new RangeError(`shift: 班次「${r.name}」的 start 与 end 相同（${r.start}）—— 零长度班次无意义`);
    }
  }

  /* `E128`：跨零点准入（形态校验之后、建规则之前 —— 非法形态先报形态错，不被闸的消息盖住）。
     `strict` 的判据＝**调用方是否给了配置上下文**（配置段形态 ⇒ fail-closed；裸数组 ⇒ 放行）。
     判据本体与两种强度的理由写在 `assertCrossMidnightAllowed()` 的 docblock 里（不在此重复）。 */
  const strict = Boolean(seg) || (options && typeof options === 'object');
  assertCrossMidnightAllowed(rules, merged, strict);

  /**
   * 求某时刻所属班次。
   * @returns {{name, start, end, date, startAt, endAt, elapsedSec, totalSec, remainingSec}}
   *   **归属日期＝班次开始的那一天**（这样三个班次首尾相接、覆盖完整 24 小时）：
   *   00:30 → 当日晚班（0→8）；08:30 → 当日早班（8→16）；23:30 → 当日中班（16→24）。
   *   注意口径：16→24 的中班在 24:00 结束，紧接**次日** 00:00 开始的晚班 —— 因此
   *   一天从"晚班"开始（00:00-08:00），再早班、中班，到次日 00:00 收口。
   */
  function at(when) {
    const d = toDate(when);
    const hour = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;

    /* 找到包含该时刻的规则（半开区间 [start, end)）；`end=24` 表示次日 0 点。
       ⚠ P2-3 修复：跨零点规则（end < start，如 22→6）**过去永远匹配不到** ——
       `hour >= 22 && hour < 6` 恒为假，于是悄悄落到兜底分支。
       跨零点时应为 `hour >= start || hour < end`（22:00-23:59 与 00:00-05:59 两段）。
       注：那个兜底分支已按 R26-P3-5 删除，改为下面的显式抛错。 */
    const inRule = (r, h) => (r.end > r.start ? (h >= r.start && h < r.end) : (h >= r.start || h < r.end));
    const rule = rules.find(r => inRule(r, hour));
    if (!rule) {
      /* R26-P3-5：配置缺口**不再静默兜底**。旧实现取"下一个会开始的班次"并把开始日回退一天，
         于是一个谁都不属于的时刻会被显示成"某班次刚好跑满/刚开始"（改前实测 GAP3 配置
         —— 甲6-10/乙10-14/丙14-18 —— 在 20:00 给出「甲班 6-10 归属前一天 elapsed=total=14400s」）。
         与上面 :26 的配置校验是同一个取舍：看板上显示错的班次名与时长比直接报错危险得多 ⇒ 一律拒绝。
         缺口即配置缺陷（正常配置三段班首尾相接、覆盖完整 24 小时）。 */
      throw new RangeError(`shift: ${fmt(d)} 不属任何班次（配置缺口）—— 班次表 ` +
        rules.map(r => `${r.name} ${r.start}-${r.end}`).join(' / '));
    }
    /* 跨零点规则且当前处于**次日凌晨**那一段（如 22→6 的 03:00）：
       班次开始于**前一天** 22:00，归属日期随之回退一天（FR-4.16 的实质）。
       漏这一步会把 05:30 算成"当天 22:00 才开始"，elapsed 变成负数或荒唐值。 */
    const startDayOffset = (rule.end < rule.start && hour < rule.end) ? -1 : 0;

    const startAt = new Date(d.getFullYear(), d.getMonth(), d.getDate() + startDayOffset,
      rule.start === 24 ? 0 : rule.start, 0, 0, 0);
    const endAt = new Date(d.getFullYear(), d.getMonth(), d.getDate() + startDayOffset,
      rule.end === 24 ? 0 : rule.end, 0, 0, 0);
    if (rule.end === 24) endAt.setDate(endAt.getDate() + 1);   // 16→24 收在次日 0 点
    if (rule.end <= rule.start) endAt.setDate(endAt.getDate() + 1);  // 跨零点规则（如 22→6）

    const totalSec = Math.round((endAt.getTime() - startAt.getTime()) / 1000);
    const elapsedSec = Math.max(0, Math.min(totalSec, Math.round((d.getTime() - startAt.getTime()) / 1000)));

    return {
      name: rule.name,
      start: rule.start,
      end: rule.end,
      date: fmtDate(startAt),            // 归属日期 = 班次开始的那一天
      startAt: fmt(startAt),
      endAt: fmt(endAt),
      totalSec,
      elapsedSec,
      remainingSec: totalSec - elapsedSec
    };
  }

  /** 当前班次（便于调用处少写一步） */
  function current(clock) {
    return at(clock ? clock.now() : new Date());
  }

  /** 班次起止时间的可读表述（FR-1.10） */
  function describe(shift) {
    const pad = n => String(n).padStart(2, '0');
    const from = `${pad(shift.start === 24 ? 0 : shift.start)}:00`;
    const to = `${pad(shift.end === 24 ? 0 : shift.end)}:00`;
    return `${shift.name} ${from}-${to}`;
  }

  /** 某班次的名称列表（供界面按配置渲染，避免组件里硬编码） */
  function names() { return rules.map(r => r.name); }

  /** `E128` 的自述（供启动日志与 `/health` 的 `crossMidnight` 字段只读搬运）：
   *  "这套配置里有没有跨零点班次、开没开闸"必须**能被巡检读到**，不能只活在注释里。
   *  ⚠ `allowed` 的语义＝"**跨零点被放行**"，它只在**真有跨零点班次**时才可能为 `true`：
   *    没有跨零点班次时恒为 `false` —— 否则 `/health` 上会出现 `count:0, allowed:true` 这种
   *    自相矛盾的读数（"没有跨零点班次，但跨零点被放行了"），读方无法据此判断该不该报警。 */
  function crossMidnight() {
    const crossing = rules.filter(isCrossMidnight);
    return {
      allowed: crossing.length > 0 && (Boolean(merged.allowCrossMidnight) ||
        crossing.every(r => r.allowCrossMidnight === true)),
      count: crossing.length,
      keys: crossing.map(r => `${r.name} ${r.start}-${r.end}`)
    };
  }

  return { rules, at, current, describe, names, crossMidnight };
}

module.exports = { createShiftRules, isCrossMidnight, assertCrossMidnightAllowed };
