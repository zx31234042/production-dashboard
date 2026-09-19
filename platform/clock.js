/* ==========================================================================
   可注入时钟（platform/clock.js）
   作用：**业务代码不得直接 new Date()**（ADR-0003 D17）—— 时间一律经这里取，
        这样自检就能把"现在几点"钉死，班次边界与跨零点用例才可重复。
   与 tests/lib/clock.js 的分工：那个是**测试侧**夹具（造时间、推进、跳转）；
        本文件是**生产侧**时钟（默认走真实时间）。
        二者**共同子集**是 `createClock({mode:'fixed', at})` + `now()` + `source()`
        —— 被测代码只依赖这三样，故注入任一侧都能无感切换（这正是"接口一致"的含义）。
        差异（各取所需，**不追求全等**）：
          · 测试侧另有 `parseTime` / `BOUNDARIES`（造边界用例）与更丰富的推进方法；
          · 生产侧另有 `toDate` / `fmt` / `fmtDate` / `diffSec` / `startOfDay|Month|Year` / `DAY_MS`
            （格式化与日期运算，业务代码要用）。
   依赖：无。
   ========================================================================== */
'use strict';

/**
 * 创建时钟。
 * @param {{mode?: 'real'|'fixed', at?: string|Date|number, offsetMs?: number}} [options]
 *   real（默认）—— 真实系统时间，生产用
 *   fixed        —— 固定在 `at` 不动（等价于测试夹具的 fixed）
 *   offsetMs     —— 在所选模式上再加固定偏移（排查时钟漂移用）
 */
function createClock(options = {}) {
  const mode = options.mode || 'real';
  const offsetMs = Number(options.offsetMs || 0);
  let fixedAt = null;
  if (mode === 'fixed') {
    fixedAt = options.at === undefined ? new Date() : toDate(options.at);
  }

  const clock = {
    mode,
    /** 当前"现在" */
    now() {
      return mode === 'fixed' ? new Date(fixedAt.getTime() + offsetMs) : new Date(Date.now() + offsetMs);
    },
    /** 供被测代码注入的回调（`const now = clock.source()`） */
    source() { return () => clock.now(); },
    /** 固定模式的推进（生产代码不该用；仅测试便利） */
    advanceMs(ms) {
      if (mode !== 'fixed') throw new Error('clock: 非 fixed 模式不能推进');
      fixedAt = new Date(fixedAt.getTime() + Number(ms));
      return clock;
    }
  };
  return clock;
}

/** 解析时间输入：Date / 时间戳 / 'YYYY-MM-DD HH:mm:ss' / ISO */
function toDate(input) {
  if (input instanceof Date) return new Date(input.getTime());
  if (typeof input === 'number') return new Date(input);
  if (typeof input === 'string') {
    const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(input) ? input.replace(' ', 'T') : input;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`clock: 无法解析时间「${input}」`);
    return d;
  }
  throw new Error('clock: 时间参数类型不支持');
}

/** 本地时间格式（DR-16：yyyy-MM-dd HH:mm:ss） */
function fmt(d) {
  const x = toDate(d);
  const pad = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ` +
    `${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
}

/** 只要日期部分 yyyy-MM-dd（班次归属日期用） */
function fmtDate(d) {
  const x = toDate(d);
  const pad = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

/** 两个时刻相差的整秒（可为负） */
function diffSec(a, b) {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 1000);
}

const DAY_MS = 24 * 3600 * 1000;

/** 当天 00:00:00 */
function startOfDay(d) {
  const x = toDate(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 0, 0, 0, 0);
}

/** 当月 1 日 00:00:00 */
function startOfMonth(d) {
  const x = toDate(d);
  return new Date(x.getFullYear(), x.getMonth(), 1, 0, 0, 0, 0);
}

/** 当年 1 月 1 日 00:00:00 */
function startOfYear(d) {
  const x = toDate(d);
  return new Date(x.getFullYear(), 0, 1, 0, 0, 0, 0);
}

module.exports = {
  createClock, toDate, fmt, fmtDate, diffSec,
  startOfDay, startOfMonth, startOfYear, DAY_MS
};
