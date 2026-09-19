/* ==========================================================================
   可注入时钟（tests/lib/clock.js）
   作用：让"依赖当前时间"的用例变得**可重复**。班次边界（08:00/16:00/00:00）、
        跨零点归属、累计运行（日/月/年）这类断言，若读真实系统时间，会出现
        "07:59 与 08:01 结果不同"的看运气现象，无法作为门禁。
   依据：ADR-0003 D17（夹具与临时库策略）；规范 9.5-5 第 4 条
        （业务代码的时间来源统一走 clock 包装，**不得直接 new Date()**）。
   依赖：仅 Node 内置模块。
   用法：
     const { createClock } = require('./lib/clock');
     const clock = createClock({ mode: 'fixed', at: '2026-09-19T07:59:00' });
     clock.now();          // Date（固定不动的"现在"）
     clock.advanceSec(120); // 前进 2 分钟 → 08:01，用于验班次切换
     clock.at('2026-09-19T23:59:30');  // 直接跳到某时刻（验跨零点）
     clock.reset();        // 回到初始种子时刻
   ========================================================================== */
'use strict';

/** 解析时间输入：Date / 时间戳 / 'YYYY-MM-DD HH:mm:ss' / ISO 字符串 */
function parseTime(input) {
  if (input instanceof Date) return new Date(input.getTime());
  if (typeof input === 'number') return new Date(input);
  if (typeof input === 'string') {
    // 允许 'YYYY-MM-DD HH:mm:ss'（空格分隔，非 ISO 严格格式）
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(input)
      ? input.replace(' ', 'T')
      : input;
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) throw new Error(`clock: 无法解析时间「${input}」`);
    return d;
  }
  throw new Error('clock: 时间参数类型不支持（仅接受 Date / 数字 / 字符串）');
}

/**
 * 创建时钟。
 * @param {{mode?: 'fixed'|'real'|'offset', at?: string|Date|number, offsetMs?: number}} [options]
 *   fixed   —— 固定在 `at`（默认 2026-09-19T10:00:00），**测试推荐**
 *   real    —— 直接返回真实系统时间（用于联调/长跑观测）
 *   offset  —— 以真实时间为基准加固定偏移（模拟时钟漂移排查）
 */
function createClock(options = {}) {
  const mode = options.mode || 'fixed';
  const seed = parseTime(options.at !== undefined ? options.at : '2026-09-19T10:00:00');
  const offsetMs = Number(options.offsetMs || 0);

  let current = new Date(seed.getTime());
  const realBase = Date.now();

  const api = {
    mode,
    seed: new Date(seed.getTime()),

    /** 当前"现在" */
    now() {
      if (mode === 'real') return new Date();
      if (mode === 'offset') return new Date(Date.now() - realBase + seed.getTime() + offsetMs);
      return new Date(current.getTime());
    },

    /** 直接跳到某时刻 */
    at(when) {
      if (mode !== 'fixed') throw new Error(`clock: mode=${mode} 为只读时钟，不能 at()`);
      current = parseTime(when);
      return api;
    },

    /** 前进（毫秒） */
    advanceMs(ms) {
      if (mode !== 'fixed') throw new Error(`clock: mode=${mode} 为只读时钟，不能 advanceMs()`);
      current = new Date(current.getTime() + Number(ms));
      return api;
    },

    /** 前进（秒） */
    advanceSec(sec) { return api.advanceMs(Number(sec) * 1000); },

    /** 前进（分钟） */
    advanceMin(min) { return api.advanceMs(Number(min) * 60 * 1000); },

    /** 回到初始种子时刻 */
    reset() {
      current = new Date(seed.getTime());
      return api;
    },

    /** 供被测代码注入的回调形式（`() => clock.now()`） */
    source() { return () => api.now(); },

    /** 便于断言的可读快照 */
    snapshot() {
      const d = api.now();
      const pad = n => String(n).padStart(2, '0');
      return {
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
        iso: d.toISOString(),
        timestamp: d.getTime()
      };
    }
  };

  return api;
}

/* ---------------- 常用测试时刻（班次边界，供夹具复用） ---------------- */
/** 班次边界基准（需求 Q-10 口径：早 08:00 / 中 16:00 / 晚 00:00） */
const BOUNDARIES = Object.freeze({
  lateNight: '2026-09-19T23:59:30',   // 晚班末，用于验跨零点
  midnight: '2026-09-20T00:00:30',    // 刚过零点
  morningBefore: '2026-09-19T07:59:30', // 交班前
  morningAfter: '2026-09-19T08:00:30',  // 刚交早班
  afternoonAfter: '2026-09-19T16:00:30',// 刚交中班
  monthEnd: '2026-09-30T23:59:30',    // 跨月
  yearEnd: '2026-12-31T23:59:30'      // 跨年
});

module.exports = { createClock, parseTime, BOUNDARIES };
