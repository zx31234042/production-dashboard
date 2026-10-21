/**
 * camera-depth-agg-probe.js —— **`cameraDepth` 18→1 整合**自证探针（零依赖，纯函数）
 *
 * 1 18 台全有效 ⇒ 平均值（2 位小数）
 * 2 混入哨兵/`null`/空串/`NaN` ⇒ **排除**，**分母＝有效台数**（不是 18）
 * 3 全无效 ⇒ **null**（不回落成 0）
 * 4 **`0` 是有效值**（不被当缺值）
 * 5 `aggregateFromRegisters`：厘米原始值 → 米（÷100）后再平均
 * 6 单台 ⇒ 等于该值
 * 7 结果恒为 2 位小数
 * 8 `ignoredKinds` 如实记录被排除的种类（哨兵/null/空串/NaN）
 *
 * 运行：node tests\camera-depth-agg-probe.js ／ 退出 0 全过、1 有失败
 */
'use strict';

require('./env').assertRuntime();
const a = require('../server/services/cameraDepthAgg.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}${detail ? ' —— ' + detail : ''}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`); }
};

function main() {
  console.log('\n=== cameraDepth 18→1 整合（有效值平均） ===');

  /* 1 全有效 */
  {
    const vals = [1.00, 1.20, 1.40, 1.60];
    const r = a.aggregateCameraDepth(vals);
    ok('1 全有效 ⇒ 平均值 1.3', r.value === 1.3 && r.validCount === 4 && r.ignored === 0, JSON.stringify(r));
  }

  /* 2 混缺值 */
  {
    const vals = [1.00, 0xFFFF, 1.20, null, 1.60, undefined, '', NaN];
    const r = a.aggregateCameraDepth(vals);
    ok('2 混缺值 ⇒ 只算 3 个有效（1.2667 → 1.27），分母＝有效台数',
      r.validCount === 3 && r.ignored === 5 && r.value === 1.27, `value=${r.value}｜valid=${r.validCount}｜ignored=${r.ignored}`);
    ok('2b ignoredKinds 如实分类',
      Array.isArray(r.ignoredKinds) && r.ignoredKinds.includes('sentinel') && r.ignoredKinds.includes('null') &&
      r.ignoredKinds.includes('undefined') && r.ignoredKinds.includes('empty-string') && r.ignoredKinds.includes('nan'),
      JSON.stringify(r.ignoredKinds));
  }

  /* 3 全无效 */
  {
    const r = a.aggregateCameraDepth([0xFFFF, null, undefined, '']);
    ok('3 全无效 ⇒ null（不回落 0）', r.value === null && r.validCount === 0 && r.ignored === 4, JSON.stringify(r));
  }

  /* 4 0 有效 */
  {
    const r = a.aggregateCameraDepth([0, 0.20]);
    ok('4 0 是有效值 ⇒ 平均 0.1', r.value === 0.1 && r.validCount === 2, `value=${r.value}`);
    const z = a.aggregateCameraDepth([0, 0]);
    ok('4b 两个 0 ⇒ 0（不是 null）', z.value === 0 && z.validCount === 2, `value=${z.value}`);
  }

  /* 5 厘米 → 米 */
  {
    const r = a.aggregateFromRegisters([100, 120, 0xFFFF, 140]);
    ok('5 厘米原始值（100/120/哨兵/140）⇒ 米平均 1.2', r.value === 1.2 && r.validCount === 3 && r.cmPerM === 100,
      `value=${r.value}｜valid=${r.validCount}`);
  }

  /* 6 单台 */
  {
    const r = a.aggregateCameraDepth([2.47]);
    ok('6 单台 ⇒ 等于该值', r.value === 2.47 && r.validCount === 1, `value=${r.value}`);
  }

  /* 7 两位小数 */
  {
    const r = a.aggregateCameraDepth([1, 1, 1]);
    ok('7 结果 2 位小数（1 → 1.00 数值上仍为 1）', r.value === 1, `value=${r.value}`);
    const r2 = a.aggregateCameraDepth([1.111, 2.222]);
    ok('7b 平均后四舍五入到 2 位（1.6665 → 1.67）', r2.value === 1.67, `value=${r2.value}`);
  }

  /* 8 空数组 */
  {
    const r = a.aggregateCameraDepth([]);
    ok('8 空数组 ⇒ null', r.value === null && r.validCount === 0 && r.totalCount === 0, JSON.stringify(r));
  }

  console.log(`\n=== 汇总 ===\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exitCode = fail ? 1 : 0;
}

try { main(); } catch (e) { console.log('FATAL ' + (e && e.message)); process.exit(2); }
