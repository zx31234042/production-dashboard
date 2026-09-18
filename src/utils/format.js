/* ==========================================================================
   格式化与数值工具（utils/format.js）
   作用：与业务无关的通用函数，供数据层与各组件共用
         —— 时间格式化、数值取整、区间限制
   依赖：无（需最先加载）
   ========================================================================== */
window.Format = (function () {
  'use strict';

  /** 两位补零 */
  const pad = n => String(n).padStart(2, '0');

  /** 秒 → HH:MM:SS */
  const clock = s => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s) % 60)}`;

  /** 秒 → H:MM（用于小时级时长） */
  const hm = s => `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}`;

  /** 秒 → 时长（不足 1 小时显示 M:SS，超过显示 HH:MM:SS） */
  const duration = s => (s >= 3600 ? clock(s) : `${Math.floor(s / 60)}:${pad(Math.floor(s) % 60)}`);

  /** 秒 → 小时（保留 1 位小数，带单位） */
  const hours = s => (s / 3600).toFixed(1) + ' h';

  /** 限制在 [a, b] 区间内 */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /** 保留 1 位小数 */
  const round1 = v => Math.round(v * 10) / 10;

  /** 保留 2 位小数 */
  const round2 = v => Math.round(v * 100) / 100;

  return { pad, clock, hm, duration, hours, clamp, round1, round2 };
})();
