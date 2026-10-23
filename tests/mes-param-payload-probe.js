/**
 * mes-param-payload-probe.js —— **`S_ME_MG_0005` 载荷构造**自证探针（零依赖，纯函数）
 *
 * 1 正常构造：7 个顶层字段 ＋ dataList 3 条，标签逐字「位置X／位置Y／速度」
 * 2 **`timestamp` 斜杠格式**：`2026-10-15 15:30:00` → `2026/10/15 15:30:00`（Date／ISO 串同）
 * 3 **`IsPass` 是字符串**（`'1'`／`'0'`／`''`），不是布尔、不是 null
 * 4 **缺值口径**：未给的 avgValue ⇒ **0**；`maxValue/minValue` 恒 0（不臆造极值）
 * 5 `uclValue/lclValue` 原样带入（未给 ⇒ 0）
 * 6 必填缺失／时间非法 ⇒ 明确报错（不猜时间）
 * 7 三组数据与样例同形（键序/键集一致：tagParam/avgValue/maxValue/minValue/uclValue/lclValue/IsPass）
 *
 * 运行：node tests\mes-param-payload-probe.js ／ 退出 0 全过、1 有失败
 */
'use strict';

require('./env').assertRuntime();
const p = require('../server/services/mesParamPayload.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}${detail ? ' —— ' + detail : ''}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`); }
};

const base = (extra = {}) => Object.assign({
  workshopNo: '19', procOrderNo: 'SCP26090100312-3-1',
  opCode: 'FXZG-1900-1201', opName: '水池试验',
  equipCode: 'SBXX2026', equipName: 'SB',
  at: '2026-10-15 15:30:00',
  posX: 12.5, posY: 39.6, speed: 23.8
}, extra);

function main() {
  console.log('\n=== S_ME_MG_0005 载荷构造（mesParamPayload） ===');

  /* 1 正常 */
  {
    const r = p.buildParamPayload(base());
    const top = ['workshopNo', 'procOrderNo', 'opCode', 'opName', 'equipCode', 'equipName', 'timestamp', 'dataList'];
    ok('1 顶层字段齐全（8 键）', r.ok && top.every(k => k in r.payload) && Object.keys(r.payload).length === 8,
      Object.keys(r.payload).join(','));
    ok('1b dataList 3 条且标签逐字', r.payload.dataList.length === 3 &&
      r.payload.dataList[0].tagParam === '位置X' && r.payload.dataList[1].tagParam === '位置Y' && r.payload.dataList[2].tagParam === '速度',
      r.payload.dataList.map(d => d.tagParam).join('/'));
  }

  /* 2 timestamp 斜杠 */
  {
    const a = p.fmtMesTimestamp('2026-10-15 15:30:00');
    const b = p.fmtMesTimestamp(new Date('2026-10-15T15:30:00'));
    const c = p.fmtMesTimestamp('2026-10-15T15:30:00Z');
    ok('2a 短横线输入 ⇒ 斜杠输出', a === '2026/10/15 15:30:00', a);
    ok('2b Date 输入 ⇒ 斜杠输出（本地时刻）', b === '2026/10/15 15:30:00', b);
    ok('2c ISO(Z) 输入 ⇒ 有输出（时区按本地）', typeof c === 'string' && /^\d{4}\/\d{2}\/\d{2} /.test(c), c);
    ok('2d 非法时间 ⇒ null（不猜当前时间）', p.fmtMesTimestamp('not-a-time') === null && p.fmtMesTimestamp('') === null);
  }

  /* 3 IsPass 字符串 */
  {
    ok("3a true/1/'1' ⇒ '1'", p.isPassStr(true) === '1' && p.isPassStr(1) === '1' && p.isPassStr('1') === '1');
    ok("3b false/0/'0' ⇒ '0'", p.isPassStr(false) === '0' && p.isPassStr(0) === '0' && p.isPassStr('0') === '0');
    ok("3c 未判定 ⇒ ''（空串，不是 null）", p.isPassStr(undefined) === '' && p.isPassStr(null) === '');
    const r = p.buildParamPayload(base({ passX: true, passY: false }));
    ok("3d 载荷里 IsPass 是字符串", r.payload.dataList[0].IsPass === '1' && r.payload.dataList[1].IsPass === '0' &&
      r.payload.dataList[2].IsPass === '', JSON.stringify(r.payload.dataList.map(d => d.IsPass)));
  }

  /* 4 缺值 ⇒ 0；极值恒 0 */
  {
    const r = p.buildParamPayload(base({ speed: undefined }));
    const d = r.payload.dataList[2];
    ok('4a 未给 speed ⇒ avgValue=0', d.avgValue === 0, `avgValue=${d.avgValue}`);
    ok('4b maxValue/minValue 恒 0（不臆造极值）', r.payload.dataList.every(x => x.maxValue === 0 && x.minValue === 0));
    ok('4c notes 记录"缺值记 0"', r.notes.some(n => n.includes('缺值') || n.includes('记 0')), JSON.stringify(r.notes));
  }

  /* 5 ucl/lcl 原样 */
  {
    const r = p.buildParamPayload(base({ uclX: 15, lclX: 10, uclSpeed: 30, lclSpeed: 20 }));
    ok('5 ucl/lcl 原样带入', r.payload.dataList[0].uclValue === 15 && r.payload.dataList[0].lclValue === 10 &&
      r.payload.dataList[2].uclValue === 30, JSON.stringify(r.payload.dataList.map(d => [d.uclValue, d.lclValue])));
  }

  /* 6 必填/时间 */
  {
    const miss = p.buildParamPayload(base({ opCode: '   ' }));
    const badT = p.buildParamPayload(base({ at: 'xxx' }));
    ok('6a 缺 opCode ⇒ MISSING_FIELD', !miss.ok && miss.code === 'MISSING_FIELD', miss.code);
    ok('6b 时间非法 ⇒ BAD_TIME', !badT.ok && badT.code === 'BAD_TIME', badT.code);
  }

  /* 7 与样例同形 */
  {
    const r = p.buildParamPayload(base());
    const want = ['tagParam', 'avgValue', 'maxValue', 'minValue', 'uclValue', 'lclValue', 'IsPass'];
    ok('7 dataList 键集与样例逐字一致', r.payload.dataList.every(x => JSON.stringify(Object.keys(x)) === JSON.stringify(want)),
      JSON.stringify(Object.keys(r.payload.dataList[0])));
  }

  console.log(`\n=== 汇总 ===\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exitCode = fail ? 1 : 0;
}

try { main(); } catch (e) { console.log('FATAL ' + (e && e.message)); process.exit(2); }
