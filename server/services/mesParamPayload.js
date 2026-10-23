/**
 * mesParamPayload.js —— **`S_ME_MG_0005`（关键运行参数上报）载荷构造**
 *   依据：MES 方 2026-10-23 回复所附**请求样例**（逐字）＋ 2026-10-15 接口定义
 *
 * 样例（原文）
 *   { "workshopNo":"19","procOrderNo":"SCP26090100312-3-1","opCode":"FXZG-1900-1201","opName":"水池试验",
 *     "equipCode":"SBXX2026","equipName":"SB","timestamp":"2026/10/15 15:30:00",
 *     "dataList":[ {"tagParam":"位置X","avgValue":12.5,"maxValue":0,"minValue":0,"uclValue":0,"lclValue":0,"IsPass":"1"}, … ] }
 *
 * 三条硬口径（从样例读出，**照抄不发挥**）
 *   ①**`timestamp` 是斜杠格式** `YYYY/MM/DD HH:mm:ss`（**不是** ISO 的短横线；我们内部存短横线，这里转）；
 *   ②**`dataList` 的 `tagParam` 用中文**「位置X／位置Y／速度」（**与航行器数据一一对应**）；
 *   ③**缺值是 0**（`maxValue/minValue/uclValue/lclValue` 样例全为 0）、**`IsPass` 是字符串 `"1"`**
 *     —— 注意这与 `IF-B.5` 旧的"缺值占位 `65535`"**不同**，以 MES 这套为准（附录 2 权威性低于 MES 文档）。
 *
 * 纯函数、不读库、不取时间（`now` 由调用方给 `Date`／ISO 串）。
 */

'use strict';

/** 三个参数标签（MES 样例口径） */
const TAG = Object.freeze({ X: '位置X', Y: '位置Y', SPEED: '速度' });

/** 两位补零 */
const p2 = (n) => String(n).padStart(2, '0');

/**
 * 内部时间（`Date`／ISO 串／`YYYY-MM-DD HH:mm:ss`）→ **MES 斜杠格式** `YYYY/MM/DD HH:mm:ss`。
 * 不是 `Date` 能解析的、或为空 ⇒ 返回 `null`（调用方据此报错，**不猜当前时间**）。
 */
function fmtMesTimestamp(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 数值守卫：非有限数 ⇒ 0（MES 样例的"缺值为 0"口径） */
const num0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** `IsPass`：**字符串**，`'1'`＝合格／`'0'`＝不合格／`''`＝未判定（不传 null，样例用字符串） */
function isPassStr(v) {
  if (v === true || v === 1 || v === '1') return '1';
  if (v === false || v === 0 || v === '0') return '0';
  return '';
}

/**
 * 构造 `S_ME_MG_0005` 请求体。
 * @param {{workshopNo:string, procOrderNo:string, opCode:string, opName:string,
 *          equipCode:string, equipName:string, at:Date|string,
 *          posX?:number, posY?:number, speed?:number,
 *          uclX?:number, lclX?:number, passX?:boolean|number|string,
 *          uclY?:number, lclY?:number, passY?:boolean|number|string,
 *          uclSpeed?:number, lclSpeed?:number, passSpeed?:boolean|number|string,
 *          tags?:string[]}} input   `tags` 可覆盖中文标签（默认 位置X/位置Y/速度）
 * @returns {{ok:true, payload:object, notes:string[]}|{ok:false, code:string, reason:string}}
 */
function buildParamPayload(input) {
  const notes = [];
  if (!input || typeof input !== 'object') return { ok: false, code: 'BAD_INPUT', reason: '入参不是对象' };
  for (const k of ['workshopNo', 'procOrderNo', 'opCode', 'opName', 'equipCode', 'equipName']) {
    if (typeof input[k] !== 'string' || input[k].trim() === '') {
      return { ok: false, code: 'MISSING_FIELD', reason: `缺少 ${k}（MES 必填）` };
    }
  }
  const timestamp = fmtMesTimestamp(input.at);
  if (!timestamp) return { ok: false, code: 'BAD_TIME', reason: `at 无法转成 MES 斜杠格式：${JSON.stringify(input.at)}` };

  const tags = Array.isArray(input.tags) && input.tags.length === 3 ? input.tags : [TAG.X, TAG.Y, TAG.SPEED];
  const row = (tag, avg, ucl, lcl, pass) => ({
    tagParam: tag,
    avgValue: num0(avg),
    /* 样例：max/min 全 0（我方暂无逐时刻极值；**不臆造**，按样例填 0） */
    maxValue: 0,
    minValue: 0,
    uclValue: num0(ucl),
    lclValue: num0(lcl),
    IsPass: isPassStr(pass)
  });

  const payload = {
    workshopNo: input.workshopNo.trim(),
    procOrderNo: input.procOrderNo.trim(),
    opCode: input.opCode.trim(),
    opName: input.opName.trim(),
    equipCode: input.equipCode.trim(),
    equipName: input.equipName.trim(),
    timestamp,
    dataList: [
      row(tags[0], input.posX, input.uclX, input.lclX, input.passX),
      row(tags[1], input.posY, input.uclY, input.lclY, input.passY),
      row(tags[2], input.speed, input.uclSpeed, input.lclSpeed, input.passSpeed)
    ]
  };
  notes.push('timestamp 已转 MES 斜杠格式 ' + timestamp);
  notes.push('maxValue/minValue 按样例填 0（我方暂无逐时刻极值，不臆造）');
  if ((input.posX === undefined) || (input.posY === undefined) || (input.speed === undefined)) {
    notes.push('有参数未给 ⇒ 该条 avgValue 记 0（MES 样例"缺值为 0"口径）');
  }
  return { ok: true, payload, notes };
}

module.exports = { TAG, fmtMesTimestamp, isPassStr, buildParamPayload };
