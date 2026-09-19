/* ==========================================================================
   班次计算（server/services/shift.js）
   作用：把"某个时刻属于哪个班次、班次从几点到几点、进行了多久、跨零点归哪一天"
        全部算清楚。这是 FR-4.16（跨零点归属正确）与 FR-1.9/1.10（当前班次与起止时间）
        的唯一实现处 —— **口径来自 src/config/board.config.js 的 shift.list，不在此处另定**。
   依赖：platform/clock.js（时间一律注入，禁止 new Date()）。
   ========================================================================== */
'use strict';

const { fmt, fmtDate, toDate } = require('../../platform/clock');

/**
 * 由配置生成班次规则。
 * @param {Array<{name:string,start:number,end:number}>} list 如 [{晚班,0,8},{早班,8,16},{中班,16,24}]
 *   约定：start/end 为 24 小时制整点；`end` 可为 24 表示次日 0 点。
 */
function createShiftRules(list) {
  const rules = (list || []).map(s => ({
    name: s.name,
    start: Number(s.start),
    end: Number(s.end)
  }));
  if (!rules.length) throw new Error('shift: 班次列表为空，请检查 board.config.shift.list');

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

    /* 找到包含该时刻的规则（半开区间 [start, end)）；`end=24` 表示次日 0 点 */
    let rule = rules.find(r => hour >= r.start && hour < r.end);
    let startDayOffset = 0;
    if (!rule) {
      /* 配置存在缺口时的兜底：取"下一个会开始的班次"，并把开始日回退一天，
         保证 elapsed/total 仍算得出来（正常配置下不会走到这里） */
      const sorted = [...rules].sort((a, b) => a.start - b.start);
      rule = sorted.find(r => r.start > hour) || sorted[0];
      startDayOffset = -1;
    }

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

  return { rules, at, current, describe, names };
}

module.exports = { createShiftRules };
