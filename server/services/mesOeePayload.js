/**
 * mesOeePayload.js —— **`S_ME_MG_0006`（OEE_RESULT_RECV）载荷构造**（口径 V1.46 ＋ 负责人 2026-10-20 裁定）
 *
 * 依据
 *   · MES 文档（2026-10-15 更正版）请求参数：`workshopNo` / `procOrderNo` / `statsDate` / `equipCode` /
 *     `oee` / `availRate` / `perfRate` / `qualityRate` / `runTimes` / `shutdownTimes` / `stopTimes` / `productTimes`
 *   · 与甲方的既有约定（`输出文件\MES方\接口澄清函-第二批-致MES方.md` N-8）：**按「班次」上报**；
 *     `formula.oee = runSec / elapsedSec`（`board.config.js`，`ADR-0005` 真源）
 *   · 负责人 2026-10-20：**异常(3)=关机 → `shutdownTimes`｜待机(0)=停机待机 → `stopTimes`｜测试中(1)+完成(2)=加工 → `productTimes`**
 *
 * 关键设计（为什么这样）
 *   ① **`perfRate` 策略可配**（`omit` 默认／`null`／`zero`）—— 我方**拿不到理论节拍/标准产能**，
 *      **不臆造**：默认**不传**；等 MES 答复再切换。**绝不默认填 0**（0 会被当成"性能效率真的是 0"）。
 *   ② **`statsDate` 两种形态**（**默认 `shift`＝`<date>-<班次>`**，依 MES 2026-10-23 答复；`date` 形态仍支持）
 *      两种都支持，切换只是一个参数。
 *   ③ **纯函数**：不读库、不取时间（`ADR-0003` D17 精神）；数字由调用方算好传入。
 *   ④ **不做单位换算**：MES 的 `decimal` 是 **0..1 还是 0..100** 未定 ⇒ 原样透传调用方的值并**记录口径**，
 *      不在这里猜（猜错会静默把 95% 变成 9500%）。
 */

'use strict';

/** 时长桶：按 `testStatus` 分三类（负责人裁定） */
const DURATION_BUCKET = Object.freeze({
  /** 3 异常 ⇒ 关机 */
  3: 'shutdownTimes',
  /** 0 待机 ⇒ 停机/待机 */
  0: 'stopTimes',
  /** 1 测试中 ＋ 2 测试完成 ⇒ 加工 */
  1: 'productTimes',
  2: 'productTimes'
});

/** `perfRate` 的三种策略（默认 omit＝不传） */
const PERF_RATE_MODE = Object.freeze({ OMIT: 'omit', NULL: 'null', ZERO: 'zero' });

/** `statsDate` 的两种形态 */
const STATS_DATE_MODE = Object.freeze({ DATE: 'date', SHIFT: 'shift' });

const FIELDS = Object.freeze([
  'workshopNo', 'procOrderNo', 'statsDate', 'equipCode', 'oee', 'availRate', 'qualityRate',
  'runTimes', 'shutdownTimes', 'stopTimes', 'productTimes'
]);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** `YYYY-MM-DD`（本地，秒级以下不需要） */
function fmtDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

/**
 * 构造 `S_ME_MG_0006` 的请求体。
 * @param {{workshopNo:string, procOrderNo:string, equipCode:string,
 *          statsDate:Date|string, shiftName?:string,
 *          oee:number, availRate:number, qualityRate:number, perfRate?:number,
 *          runTimes:number, shutdownTimes:number, stopTimes:number, productTimes:number,
 *          perfRateMode?:string, statsDateMode?:string}} input
 * @returns {{ok:true, payload:object, notes:string[]}|{ok:false, code:string, reason:string}}
 */
function buildOeePayload(input) {
  const notes = [];
  if (!input || typeof input !== 'object') return { ok: false, code: 'BAD_INPUT', reason: '入参不是对象' };
  const need = ['workshopNo', 'procOrderNo', 'equipCode'];
  for (const k of need) {
    if (typeof input[k] !== 'string' || input[k].trim() === '') {
      return { ok: false, code: 'MISSING_FIELD', reason: `缺少 ${k}（MES 必填）` };
    }
  }
  const nums = ['oee', 'availRate', 'qualityRate', 'runTimes', 'shutdownTimes', 'stopTimes', 'productTimes'];
  for (const k of nums) {
    if (!isNum(input[k])) return { ok: false, code: 'BAD_NUMBER', reason: `${k} 必须是有限数值，收到 ${JSON.stringify(input[k])}` };
  }
  const mode = input.perfRateMode || PERF_RATE_MODE.OMIT;
  if (!Object.values(PERF_RATE_MODE).includes(mode)) return { ok: false, code: 'BAD_MODE', reason: `perfRateMode 非法：${mode}` };
  /* MES 2026-10-23 明确 statsDate 填班次标识（如 2026-10-20-A）⇒ 默认走班次形态 */
  const sdMode = input.statsDateMode || STATS_DATE_MODE.SHIFT;
  if (!Object.values(STATS_DATE_MODE).includes(sdMode)) return { ok: false, code: 'BAD_MODE', reason: `statsDateMode 非法：${sdMode}` };

  const d = fmtDate(input.statsDate);
  if (!d) return { ok: false, code: 'BAD_DATE', reason: `statsDate 非法：${JSON.stringify(input.statsDate)}` };
  const statsDate = sdMode === STATS_DATE_MODE.SHIFT ? `${d}-${String(input.shiftName || '').trim() || 'A'}` : d;
  if (sdMode === STATS_DATE_MODE.SHIFT) notes.push(`statsDate 用班次形态：${statsDate}（待 MES 确认是否接受）`);

  const payload = {
    workshopNo: input.workshopNo.trim(),
    procOrderNo: input.procOrderNo.trim(),
    statsDate,
    equipCode: input.equipCode.trim(),
    oee: input.oee,
    availRate: input.availRate,
    qualityRate: input.qualityRate,
    runTimes: input.runTimes,
    shutdownTimes: input.shutdownTimes,
    stopTimes: input.stopTimes,
    productTimes: input.productTimes
  };

  /* perfRate：**默认不传**；明确要求时才按策略写 */
  if (mode === PERF_RATE_MODE.OMIT) {
    notes.push('perfRate 未传（我方无理论节拍/标准产能，不臆造；待 MES 答复）');
  } else if (mode === PERF_RATE_MODE.NULL) {
    payload.perfRate = null;
    notes.push('perfRate 显式传 null（按 MES 要求）');
  } else {
    if (!isNum(input.perfRate)) return { ok: false, code: 'BAD_NUMBER', reason: `perfRateMode=zero 但 perfRate 非数值` };
    payload.perfRate = input.perfRate;
    notes.push('perfRate 已按调用方给定值传入');
  }

  return { ok: true, payload, notes };
}

/** 按 `testStatus` 取时长桶名（未知状态 ⇒ null，调用方自行处置） */
function bucketOf(testStatus) {
  return DURATION_BUCKET[Number(testStatus)] || null;
}

/**
 * 把一串"带时长的状态帧"累加成三类时长（分钟）。
 * @param {Array<{testStatus:number, minutes:number}>} frames
 * @returns {{shutdownTimes:number, stopTimes:number, productTimes:number, unknown:number}}
 *   `unknown`＝无法归类（未知状态）的分钟数，**单列**而不是塞进任何一类（不混算）。
 */
function accumulateDurations(frames) {
  const out = { shutdownTimes: 0, stopTimes: 0, productTimes: 0, unknown: 0 };
  for (const f of frames || []) {
    if (!f || !isNum(f.minutes) || f.minutes < 0) continue;
    const b = bucketOf(f.testStatus);
    if (b) out[b] += f.minutes; else out.unknown += f.minutes;
  }
  return out;
}

module.exports = {
  DURATION_BUCKET, PERF_RATE_MODE, STATS_DATE_MODE, FIELDS,
  fmtDate, buildOeePayload, bucketOf, accumulateDurations
};
