/**
 * mes-oee-payload-probe.js —— **6（`S_ME_MG_0006` 载荷映射）自证探针**（零依赖，纯函数）
 *
 * 1 正常构造：字段名/必填齐全（含 MES 文档的 12 个请求参数中的 11 个 ＋ perfRate 默认不传）
 * 2 perfRate 三种策略：omit（默认，不传）／null（显式 null）／zero（按给定值）
 * 3 statsDate 两种形态：date（YYYY-MM-DD）／shift（date-班次）
 * 4 状态→时长桶：0 待机→stopTimes｜1/2→productTimes｜3 异常→shutdownTimes｜未知→null
 * 5 时长累计：三类分别累加，未知状态单列 unknown（不混算）
 * 6 必填缺失／非数值／模式非法／日期非法 ⇒ 明确报错（不静默）
 * 7 计量单位口径：**不换算**（原样透传），仅记录 notes
 *
 * 运行：node tests\mes-oee-payload-probe.js ／ 退出 0 全过、1 有失败
 */
'use strict';

require('./env').assertRuntime();
const p = require('../server/services/mesOeePayload.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}${detail ? ' —— ' + detail : ''}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`); }
};

const base = () => ({
  workshopNo: 'W19', procOrderNo: 'PO-A', equipCode: 'EQ-UC-001',
  statsDate: '2026-10-20', oee: 0.72, availRate: 0.9, qualityRate: 0.95,
  runTimes: 300, shutdownTimes: 20, stopTimes: 40, productTimes: 260
});

function main() {
  console.log('\n=== 6 · S_ME_MG_0006 载荷映射（mesOeePayload） ===');

  /* 1 正常构造 */
  {
    const r = p.buildOeePayload(base());
    const keys = Object.keys(r.payload || {});
    ok('1 正常构造：11 个字段齐全且 perfRate 默认不传',
      r.ok && keys.length === 11 && !keys.includes('perfRate') && r.payload.statsDate === '2026-10-20',
      `keys=${keys.length}｜statsDate=${r.payload && r.payload.statsDate}｜notes=${(r.notes || []).length}`);
    const missing = p.FIELDS.filter(k => !keys.includes(k));
    ok('1b MES 必填/核心字段无缺（仅 perfRate 按策略可缺）', missing.length === 0, `缺=${JSON.stringify(missing)}`);
  }

  /* 2 perfRate 三策略 */
  {
    const a = p.buildOeePayload(Object.assign(base(), { perfRateMode: 'omit' }));
    const b = p.buildOeePayload(Object.assign(base(), { perfRateMode: 'null' }));
    const c = p.buildOeePayload(Object.assign(base(), { perfRateMode: 'zero', perfRate: 0.8 }));
    ok('2a omit ⇒ 不含 perfRate', a.ok && !('perfRate' in a.payload));
    ok('2b null ⇒ perfRate=null', b.ok && b.payload.perfRate === null);
    ok('2c zero（按值）⇒ perfRate=0.8', c.ok && c.payload.perfRate === 0.8, `perfRate=${c.payload && c.payload.perfRate}`);
    const bad = p.buildOeePayload(Object.assign(base(), { perfRateMode: 'zero' }));
    ok('2d zero 模式但缺数值 ⇒ 报错（不静默）', !bad.ok && bad.code === 'BAD_NUMBER', `code=${bad.code}`);
  }

  /* 3 statsDate 两形态 */
  {
    const d = p.buildOeePayload(Object.assign(base(), { statsDateMode: 'date' }));
    const s = p.buildOeePayload(Object.assign(base(), { statsDateMode: 'shift', shiftName: 'A' }));
    ok('3a date ⇒ YYYY-MM-DD', d.ok && d.payload.statsDate === '2026-10-20', d.payload && d.payload.statsDate);
    ok('3b shift ⇒ 2026-10-20-A', s.ok && s.payload.statsDate === '2026-10-20-A', s.payload && s.payload.statsDate);
    const bad = p.buildOeePayload(Object.assign(base(), { statsDate: 'not-a-date' }));
    ok('3c 非法日期 ⇒ 报错', !bad.ok && bad.code === 'BAD_DATE', `code=${bad.code}`);
  }

  /* 4 状态→桶 */
  {
    ok('4a 3 异常 ⇒ shutdownTimes', p.bucketOf(3) === 'shutdownTimes');
    ok('4b 0 待机 ⇒ stopTimes', p.bucketOf(0) === 'stopTimes');
    ok('4c 1 测试中 ⇒ productTimes', p.bucketOf(1) === 'productTimes');
    ok('4d 2 完成 ⇒ productTimes', p.bucketOf(2) === 'productTimes');
    ok('4e 未知(9) ⇒ null', p.bucketOf(9) === null);
  }

  /* 5 时长累计 */
  {
    const acc = p.accumulateDurations([
      { testStatus: 0, minutes: 10 },
      { testStatus: 1, minutes: 100 },
      { testStatus: 2, minutes: 50 },
      { testStatus: 3, minutes: 20 },
      { testStatus: 9, minutes: 5 }
    ]);
    ok('5 三类累加 ＋ unknown 单列',
      acc.stopTimes === 10 && acc.productTimes === 150 && acc.shutdownTimes === 20 && acc.unknown === 5,
      JSON.stringify(acc));
  }

  /* 6 必填/数值校验 */
  {
    const miss = p.buildOeePayload(Object.assign(base(), { workshopNo: '  ' }));
    const badNum = p.buildOeePayload(Object.assign(base(), { oee: '0.7' }));
    const badMode = p.buildOeePayload(Object.assign(base(), { perfRateMode: 'whatever' }));
    ok('6a 缺 workshopNo ⇒ MISSING_FIELD', !miss.ok && miss.code === 'MISSING_FIELD', miss.code);
    ok('6b oee 是字符串 ⇒ BAD_NUMBER', !badNum.ok && badNum.code === 'BAD_NUMBER', badNum.code);
    ok('6c 非法模式 ⇒ BAD_MODE', !badMode.ok && badMode.code === 'BAD_MODE', badMode.code);
  }

  /* 7 不换算单位 */
  {
    const r = p.buildOeePayload(Object.assign(base(), { oee: 72, availRate: 90, qualityRate: 95 }));
    ok('7 原样透传（0..100 形态不擅自除以 100）', r.ok && r.payload.oee === 72 && r.payload.availRate === 90,
      `oee=${r.payload && r.payload.oee}`);
  }

  console.log(`\n=== 汇总 ===\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exitCode = fail ? 1 : 0;
}

try { main(); } catch (e) { console.log('FATAL ' + (e && e.message)); process.exit(2); }
