/**
 * cameraDepthAgg.js —— **`cameraDepth` 的 18→1 整合**（负责人 2026-10-21 裁定：**我方整合、取平均值**）
 *
 * 口径（四条，均按"不臆造"定）
 *   ①**只对"有效值"求平均**：`0xFFFF`／`0xFFFFFFFF`（哨兵）、`null`／`undefined`／空串／`NaN` 一律**排除**；
 *     **分母＝有效台数**，**不是**固定 18 —— 否则一台掉线就会把均值拉低 ✗。
 *   ②**有效台数＝0** ⇒ 返回 **`null`**（界面显「—」）；**绝不回落成 0** ✗（0 m 是合法读数，不能代表"没有数据"）。
 *   ③**`0` 是有效值**（水面/零位都可能真实出现）—— 与 `P0-3`（`services/missingValue.js`）同口径。
 *   ④**单位**：寄存器原始值为**厘米**（`通讯.xlsx`：`29 → 0.29 m`）⇒ 换算 ÷100 得米，结果**保留 2 位小数**（cm 精度）。
 *
 * 纯函数：不读库、不取时间（`ADR-0003` D17 精神）。
 */

'use strict';

/** 哨兵（视为缺值） */
const SENTINELS = Object.freeze([0xFFFF, 0xFFFFFFFF]);
/** 原始值（厘米）→ 米的除数 */
const CM_PER_M = 100;

/** 是否"有效深度"（数值、非 NaN、非哨兵）—— **0 有效** */
function isValidDepth(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  return !SENTINELS.includes(v);
}

/**
 * 对若干**米**值求平均（**只用有效值**）。
 * @param {Array<number|null|undefined|string>} values
 * @returns {{value:number|null, validCount:number, totalCount:number, ignored:number}}
 *   `value`＝有效值平均（**2 位小数**）；`validCount`＝参与平均的台数；`ignored`＝被排除的台数。
 */
function aggregateCameraDepth(values) {
  const list = Array.isArray(values) ? values : [];
  const valid = list.filter(isValidDepth);
  const result = {
    validCount: valid.length,
    totalCount: list.length,
    ignored: list.length - valid.length,
    value: null
  };
  if (valid.length === 0) return result;
  const mean = valid.reduce((s, x) => s + x, 0) / valid.length;
  result.value = Math.round(mean * 100) / 100;
  /* 记录被排除的种类（便于排查；不参与计算） */
  result.ignoredKinds = list.filter(v => !isValidDepth(v)).map(v => {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v.trim() === '' ? 'empty-string' : 'non-numeric-string';
    if (typeof v === 'number') return SENTINELS.includes(v) ? 'sentinel' : 'nan';
    return typeof v;
  });
  return result;
}

/**
 * 从**寄存器原始值（厘米）**整合成米。
 * @param {Array<number|null|undefined>} rawValues
 * @param {{cmPerM?:number}} [opts] 默认 100
 */
function aggregateFromRegisters(rawValues, opts = {}) {
  const div = Number.isFinite(opts.cmPerM) && opts.cmPerM > 0 ? opts.cmPerM : CM_PER_M;
  const list = Array.isArray(rawValues) ? rawValues : [];
  const meters = list.map(v => (isValidDepth(v) ? v / div : v));
  const r = aggregateCameraDepth(meters);
  r.cmPerM = div;
  return r;
}

module.exports = { SENTINELS, CM_PER_M, isValidDepth, aggregateCameraDepth, aggregateFromRegisters };
