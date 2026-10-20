/**
 * mesClient.js —— **A4（P1-2）：MES 官方接口的传输层**（2026-10-15 到件的 `S_ME_MG_0001…0006`／`S_ME_BD_0001…0003`）
 *
 * 口径（来件原文）
 *   · URL 模板：`http(s)://{host}:{port}/{context}/service/{serviceName}/{methodName}`
 *   · 方法：**POST**；`Content-Type: application/json`；字符集 **UTF-8**；`webAPI` 网关
 *   · ⚠ **响应结构不一致**（来件自身就不一致）：表格里是 `{"errcode":1/-1,"resultMsg":"…"}`，
 *     而 1.3 的示例是 `{"status":true|false,"msg":"…","data":…}` ⇒ **本层做"宽容归一"**，
 *     但**不可识别的响应一律判失败**（**绝不猜成功**）。
 *
 * 纪律
 *   · **只做传输**：不拼业务字段、不做重试策略（重试归调用方，见 `uploadReporter` 的既有纪律）；
 *   · **时钟注入**（`ADR-0003` D17）：`now()` 必须传入（用于记录调用时刻与超时判定）；
 *   · **可注入 `fetch`**：探针与受限环境可替换（`fetchImpl`）。
 */

'use strict';

/** 归一后的结局（供调用方分流；unknown 视为失败） */
const OUTCOME = Object.freeze({
  OK: 'ok',                 // 明确成功（errcode===1 或 status===true/'success'/200）
  BIZ_FAIL: 'biz-fail',     // 明确业务失败（errcode===-1 或 status===false、含 resultMsg/msg）
  HTTP_FAIL: 'http-fail',   // 非 2xx
  TIMEOUT: 'timeout',
  NETWORK_FAIL: 'network-fail',
  BAD_RESPONSE: 'bad-response' // 不可识别（**判失败**）
});

/** 归一化响应：返回 `{ outcome, code, message, data, raw }` */
function classifyResponse(body) {
  if (!body || typeof body !== 'object') {
    return { outcome: OUTCOME.BAD_RESPONSE, code: null, message: '响应不是 JSON 对象', data: null, raw: body };
  }
  /* 形态 A：{ errcode: 1 | -1, resultMsg } */
  if (Object.prototype.hasOwnProperty.call(body, 'errcode')) {
    const ok = Number(body.errcode) === 1;
    return { outcome: ok ? OUTCOME.OK : OUTCOME.BIZ_FAIL, code: body.errcode,
      message: body.resultMsg === undefined ? '' : String(body.resultMsg), data: body.data === undefined ? null : body.data, raw: body };
  }
  /* 形态 B：{ status: true|false|'success'|200, msg, data } */
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const s = body.status;
    const ok = s === true || s === 'success' || s === 'SUCCESS' || Number(s) === 200;
    return { outcome: ok ? OUTCOME.OK : OUTCOME.BIZ_FAIL, code: s,
      message: body.msg === undefined ? '' : String(body.msg), data: body.data === undefined ? null : body.data, raw: body };
  }
  return { outcome: OUTCOME.BAD_RESPONSE, code: null, message: '响应既无 errcode 也无 status（不可识别 ⇒ 判失败）', data: null, raw: body };
}

/**
 * @param {{baseUrl?:string, host?:string, port?:number|string, context?:string, protocol?:string,
 *          timeoutMs?:number, fetchImpl?:Function, now:Function}} opts
 *   二选一：给 `baseUrl`（完整前缀，如 `http://111.230.228.177:18000/fxzg-be`）或给 `protocol/host/port/context`。
 */
function createMesClient(opts = {}) {
  if (typeof opts.now !== 'function') throw new TypeError('createMesClient: 必须传入 now()（时钟注入出口，ADR-0003 D17）');
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (typeof fetchImpl !== 'function') throw new TypeError('createMesClient: 环境无 fetch，且未注入 fetchImpl');
  let baseUrl = opts.baseUrl;
  if (!baseUrl) {
    if (!opts.host) throw new TypeError('createMesClient: 必须给 baseUrl 或 host');
    const proto = (opts.protocol || 'http').replace(/:$/, '');
    const port = opts.port === undefined ? '' : ':' + String(opts.port);
    const ctx = opts.context ? '/' + String(opts.context).replace(/^\/+/, '') : '';
    baseUrl = `${proto}://${opts.host}${port}${ctx}`;
  }
  baseUrl = String(baseUrl).replace(/\/+$/, '');
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 10000;
  const counts = { calls: 0, ok: 0, bizFail: 0, httpFail: 0, timeout: 0, networkFail: 0, badResponse: 0 };
  let lastCall = null;

  /** 拼 URL（模板：`{base}/service/{service}/{method}`） */
  function urlOf(serviceName, methodName) {
    const s = String(serviceName || '').trim();
    const m = String(methodName || '').trim();
    if (!s || !m) throw new TypeError('mesClient: serviceName／methodName 不能为空');
    return `${baseUrl}/service/${encodeURIComponent(s)}/${encodeURIComponent(m)}`;
  }

  /**
   * 调一次接口（**不做重试**）。
   * @returns {Promise<{outcome:string, httpStatus:number|null, code:any, message:string, data:any, raw:any, url:string, at:string}>}
   */
  async function call(serviceName, methodName, payload, extra = {}) {
    const url = urlOf(serviceName, methodName);
    const at = new Date(opts.now()).toISOString();
    counts.calls += 1;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res, bodyText = '';
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra.headers || {}),
        body: JSON.stringify(payload === undefined ? {} : payload),
        signal: ctrl ? ctrl.signal : undefined
      });
      bodyText = await res.text();
    } catch (e) {
      if (timer) clearTimeout(timer);
      const isAbort = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
      const outcome = isAbort ? OUTCOME.TIMEOUT : OUTCOME.NETWORK_FAIL;
      counts[isAbort ? 'timeout' : 'networkFail'] += 1;
      lastCall = { url, at, outcome, httpStatus: null, code: null, message: String(e && e.message || e), data: null, raw: null };
      return Object.assign({}, lastCall);
    }
    if (timer) clearTimeout(timer);

    if (!res.ok) {
      counts.httpFail += 1;
      lastCall = { url, at, outcome: OUTCOME.HTTP_FAIL, httpStatus: res.status, code: res.status,
        message: `HTTP ${res.status}`, data: null, raw: bodyText.slice(0, 2000) };
      return Object.assign({}, lastCall);
    }
    let parsed = null;
    try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch { parsed = null; }
    const c = classifyResponse(parsed);
    const key = c.outcome === OUTCOME.OK ? 'ok'
      : c.outcome === OUTCOME.BIZ_FAIL ? 'bizFail'
        : c.outcome === OUTCOME.BAD_RESPONSE ? 'badResponse' : 'badResponse';
    counts[key] = (counts[key] || 0) + 1;
    lastCall = { url, at, outcome: c.outcome, httpStatus: res.status, code: c.code, message: c.message, data: c.data, raw: c.raw };
    return Object.assign({}, lastCall);
  }

  return {
    urlOf, call,
    baseUrl: () => baseUrl,
    timeoutMs: () => timeoutMs,
    snapshot: () => Object.assign({}, counts, { lastCall: lastCall ? Object.assign({}, lastCall) : null })
  };
}

module.exports = { OUTCOME, classifyResponse, createMesClient };
