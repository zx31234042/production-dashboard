/* ==========================================================================
   IF-B 上报 MES 的服务端实现（server/services/uploadReporter.js）—— W4（服务层第二笔 · 第 3 波）
   作用：把**附录 2 的 13 个字段**组装出来、**发一次**、并按 IF-B.9 / V1.31 的裁定处置结果：
         ①`buildReport()`：13 字段**从库表取数**（`device` / `task` / `measure_rt` 最近一帧 /
           登录 `standard` 的生效版本），`uploadId` **复用 `platform/id.js` 的生成器**（不另写序号域）；
           13 字段之外**另带** `paramDataList`（§1.2.5 `PARAM_INFO_RECV` 的两条 dataList，
           C-78 / 澄清函 N-2 的"我方填法"：`uclValue`/`lclValue` 取绝对值、缺失即占位 65535 / IsPass=null）；
         ②`httpSend()`：一次 HTTP POST，**不发第二次**；
         ③`report()`：成功 ⇒ `upload_log` 记"成功"；失败 ⇒ `upload_log` 记"待补传" + 告警 + 待补传条数；
         ④`retryPending()`：**唯一**会再次发送待补传报文的入口（人工一键重报，供 UI-20 消费），
           按 `created_at, id` **顺序**补传、逐条回写成功/仍失败、**幂等**（已成功的不再发）。
   硬约束（本包**刻意不做**的事，别"顺手补上"）：
     · **不做自动重试**：无定时器、无指数退避、无"延时再试一次"、无 flush 循环（V1.31 / C-59 / E10）；
     · `mes.baseUrl` 未配置（Q-23 未答）⇒ **显式**返回 `{skipped:true, reason:'未配置 MES 地址（Q-23）'}`，
       **不得**当成成功（成功会让看板以为数据已到 MES，属"假活"）；
     · **不做**真实 MES 签名/鉴权协商（待 MES 方书面答复；`mes.token` 有值则按 Bearer 带上，仅此）。
   缺值口径（**先读原文再实现**，不另创哨兵）：
     · **文本类**（`equipCode` / `procOrderNo` / `collectTime`）：附录 2 的"数据来源"列给了给定方
       （MES 工单 / Java 程序）；`equipCode` 取 `device` 表（IF-A.4 为权威口径，`task` 兜底，再兜
       `board.config.js` 的 `device.equipCode`＝FR-8.6 的本机兜底），取不到写**空串**（"无值"）；
       `collectTime` 取**报文所依据那一帧**的 `collect_time`；库内一帧都没有时不编造采集时间，
       按前端既有做法（`src/services/api.js` 的 `buildReportPayload`）退到**报文时刻**并置 `collectTimeFallback`。
     · **数值类**：库列可空（`measure_rt.measure_depth` 等）⇒ 缺值写 **`null`**。**不写 0** ——
       0 是合法物理量（0 m 深度 / 0 m·s⁻¹ 速度），把它当"缺值默认"会让 MES 侧把"没有数据"
       读成"测到 0"，与 IF-C.9「depth 与 cameraDepth 不得混用」同一类**语义失真**。
       前端 `api.js` 的 `v = 0` 是演示期的安全默认（避免报文缺字段），服务端按上文取**语义正确**的 null；
       这是**有意的口径收紧**，已在 W4 回执"未决/风险"里登记，前端切换真实源时（W5）须同步改为 null。
     · **标准占位**：`paramDataList` 里"标准未设定"仍按 N-7 的已发口径 `65535` / `IsPass: null`
       （`services/standard.mesLimits()`，单一真源），**不新创哨兵值**。
   依据：IF-B.8/B.9/B.10、V1.31 / C-59（不做自动重试）、DR-11（上传日志）、DR-13（uploadId 幂等）、
        附录 2 字段表（13 项，含 `cameraDepth`；`uclValue`/`lclValue`/`IsPass` 不在其中，见 C-78）、
        MES 澄清函 N-2（§1.2.5 承载与填法）、IF-0.6 / C-104（回执结构以 `{status,msg,data}` 为准，
        兼容读取 `{code,...}`）、Q-23（地址/鉴权/请求方式待答复）。
   依赖：`server/repo/uploadQueue.js`（upload_log 的 SQL；14 号列在下方"取数来源"里逐项写明）＋
        `server/db`（只读 `device`/`task`/`measure_rt`/`standard`：本文件**不另写** measure 的取数函数，
        最近一帧就是一条 `ORDER BY id DESC LIMIT 1` 的只读查询，故不引入 `repo/measure` 的写路径）、
        `server/services/{uploadQueue,standard}.js`、`platform/{id,clock}.js`、`node:http|node:https`。
   ========================================================================== */
'use strict';

const http = require('node:http');
const https = require('node:https');

const repo = require('../repo/uploadQueue');
const boardConfig = require('../../src/config/board.config.js');
const platformId = require('../../platform/id');
const platformClock = require('../../platform/clock');
const standardSvc = require('./standard');
const { createUploadQueue } = require('./uploadQueue');

/** 接口名缺省口径（`serviceName/methodName`；与 `upload_log.interface`、`repo/uploadQueue` 的注释一致） */
const DEFAULT_SERVICE = 'report';
const DEFAULT_METHOD = 'receiveReport';

/** 单次上报的超时缺省值（毫秒）。缺省取 `upper.timeoutMs` 同量级；未配置时 3000。 */
const DEFAULT_TIMEOUT_MS = 3000;

/** 附录 2 的 **13 个字段**（顺序即报文键序；`uploadId` 最后，与附录 2 表内顺序一致）。
 *  ⚠ `uclValue` / `lclValue` / `IsPass` **不在**此列（C-78：它们属 §1.2.5 结构）——
 *  该结构另由 `paramDataList` 承载，13 字段**不增不减**（IF-B.8）。 */
const REPORT_FIELDS = Object.freeze([
  'equipCode', 'procOrderNo', 'frameRate', 'gain', 'shutter', 'cameraDepth',
  'depth', 'speed', 'velocity_x', 'velocity_y', 'collectTime', 'testStatus', 'uploadId'
]);

/** 13 字段的**取数来源**（可被 `buildReport()` 原样暴露给界面/自检，避免"来源只在注释里"）。
 *  `ifd` ＝ 上位机侧实测帧列（`measure_rt`，来源列＝附录 2 的「PC上位机」）；
 *  `mesOrder` ＝ MES 工单（`task` / `device`）；`java` ＝ 本机 Java 程序生成（`uploadId` / `collectTime`）。 */
const REPORT_SOURCES = Object.freeze({
  equipCode: { source: 'MES 工单', table: 'device.equip_code', fallback: 'task.equip_code → board.config.device.equipCode（FR-8.6 本机兜底）', missing: '空串（"无值"）' },
  procOrderNo: { source: 'MES 工单', table: 'task.proc_order_no', fallback: '本次报文指定（原样回显）', missing: '空串（但缺工单号时 report() 整体拒发）' },
  frameRate: { source: 'PC上位机', table: 'measure_rt.frame_rate（最近一帧）', fallback: '—', missing: 'null' },
  gain: { source: 'PC上位机', table: 'measure_rt.gain（最近一帧）', fallback: '—', missing: 'null' },
  shutter: { source: 'PC上位机', table: 'measure_rt.shutter（最近一帧）', fallback: '—', missing: 'null' },
  cameraDepth: { source: 'PC上位机', table: 'measure_rt.camera_depth（最近一帧）', fallback: '—', missing: 'null' },
  depth: { source: 'PC上位机', table: 'measure_rt.measure_depth（最近一帧）', fallback: '—', missing: 'null' },
  speed: { source: 'PC上位机', table: 'measure_rt.speed（最近一帧）', fallback: '—', missing: 'null' },
  velocity_x: { source: 'PC上位机', table: 'measure_rt.velocity_x（最近一帧）', fallback: '—', missing: 'null' },
  velocity_y: { source: 'PC上位机', table: 'measure_rt.velocity_y（最近一帧）', fallback: '—', missing: 'null' },
  collectTime: { source: 'Java 程序', table: 'measure_rt.collect_time（最近一帧）', fallback: '报文时刻（并置 collectTimeFallback=true）', missing: '报文时刻' },
  testStatus: { source: 'PC上位机', table: 'measure_rt.test_status（最近一帧）', fallback: "board.config 的 dataSource==='mock' → 0=待机；否则报表式跳过", missing: '跳过发送（不伪造运行状态）' },
  uploadId: { source: 'Java 程序生成', table: '（不落库，落 upload_log.upload_id）', fallback: '—', missing: '由 platform/id.js 生成，永不缺' }
});

/** 未配置 MES 地址时的显式结论（Q-23 未答）。**共享同一个冻结对象**：调用方可用 `===` 判定。 */
const NOT_CONFIGURED = Object.freeze({
  ok: false,
  skipped: true,
  reason: '未配置 MES 地址（Q-23）'
});

/** 一个可读的"当前时刻"格式化（DR-16：yyyy-MM-dd HH:mm:ss）。**只经注入时钟**，不裸取系统时间。 */
function fmtClock(d) {
  return platformClock.fmt(platformClock.toDate(d));
}

/** 取"现在"（**必须有注入出口**，ADR-0003 D17）。
 *  缺省兜底写成**同一行**的 `X || new Date()` —— 门禁按行判定注入出口是否存在。 */
function resolveNow(options) {
  const injected = (options && options.now) || new Date();
  return () => (typeof injected === 'function' ? injected() : injected);
}

/** 读配置段（`src/config/board.config.js` 是**单一真源**：地址/回执风格/占位哨兵/队列阈值都读它） */
function resolveConfig(options) {
  return options.config || boardConfig;
}

/** 回执是否表示成功：以配置的 `mes.responseStyle` 为准（IF-0.6 / C-104：默认 `status` 风格，
 *  `status===1` 成功；`code` 风格兼容读取 `code===200`）。 */
function isReceiptOk(receipt, style) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (style === 'code') return receipt.code === 200;
  return receipt.status === 1 || receipt.status === '1';
}

/** 从回执里取一句可读的失败原因（人工重报界面要显示"为什么失败"） */
function receiptReason(receipt) {
  if (!receipt || typeof receipt !== 'object') return '无回执';
  const msg = receipt.msg || receipt.message || receipt.error || receipt.raw;
  if (msg) return String(msg);
  if (receipt.code !== undefined) return `回执 code=${receipt.code}`;
  if (receipt.status !== undefined) return `回执 status=${receipt.status}`;
  return '回执判为失败';
}

/** 从回执里取"响应码"列（`upload_log.response_code`）：优先业务码，其次 HTTP 状态码 */
function receiptCode(receipt, httpStatus) {
  if (receipt && typeof receipt === 'object') {
    if (receipt.code !== undefined) return String(receipt.code);
    if (receipt.status !== undefined) return String(receipt.status);
  }
  return String(httpStatus);
}

/** 超时包装：`fetch` + `AbortController`（Node 24 内置；**零依赖**）。
 *  为什么自己写而不直接 `fetch(url, {signal: AbortSignal.timeout(ms)})`：本文件要显式
 *  `clearTimeout` 并在自检里核对"确实带上了超时"，显式控制器更可核查。 */
async function httpSend(deps, req) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    const res = await deps.fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: controller.signal
    });
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    let receipt = null;
    try { receipt = text ? JSON.parse(text) : null; } catch { receipt = { raw: text }; }
    return { httpStatus: res.status, receipt, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 创建 IF-B 上报器实例。
 *
 * @param {object} options
 *  @param {object}   options.db             SQLite 句柄（读 device/task/measure_rt/standard，写 upload_log）
 *  @param {object}   [options.logger]       日志器（platform/log.js 产物）
 *  @param {Function|Date} [options.now]     时钟注入出口（**必须是 `platform/clock.js` 的 `clock.source()`**）
 *  @param {object}   [options.config]       配置覆盖（缺省＝`board.config.js`；自检可用内存副本改阈值）
 *  @param {Function} [options.fetch]        发送实现覆盖（**自检注入用**；缺省＝全局 fetch）
 *  @param {object}   [options.queue]        复用既有队列服务实例（缺省按 db 自建）
 *  @param {object}   [options.idGenerator]  uploadId 生成器覆盖（缺省＝`platform/id.js` 的真源）
 *  @param {string}   [options.serviceName]  服务名（缺省 `report`）
 *  @param {string}   [options.methodName]   方法名（缺省 `receiveReport`）
 *  @param {number}   [options.capacity]     待补传队列容量（透传队列服务）
 *  @param {number}   [options.warnThreshold] 告警阈值（缺省＝`mes.queueWarnThreshold` 真源）
 *  @param {boolean}  [options.strict]       true 时"已报过同一帧"改为**抛错**（缺省 false＝跳过）
 *  @param {number}   [options.timeoutMs]    单次上报超时（缺省见 `DEFAULT_TIMEOUT_MS`）
 * @returns {object} 上报器实例
 */
function createUploadReporter(options = {}) {
  const db = options.db;
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('uploadReporter: 必须传入 SQLite 句柄（options.db）');
  }
  const logger = options.logger || null;
  const config = resolveConfig(options);
  const now = resolveNow(options);
  const fetchImpl = options.fetch || ((...args) => fetch(...args));
  const serviceName = options.serviceName || DEFAULT_SERVICE;
  const methodName = options.methodName || DEFAULT_METHOD;
  const iface = [serviceName, methodName].join('/');
  const strict = options.strict === true;
  const mes = (config && config.mes) || {};
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : (Number.isFinite(mes.timeoutMs) && mes.timeoutMs > 0 ? mes.timeoutMs : DEFAULT_TIMEOUT_MS);
  const placeholder = mes.reportPlaceholder === undefined ? 65535 : mes.reportPlaceholder;
  /* 序号域真源：**只**用 `platform/id.js` 的生成器（E31：按日重置、1～999、永不产生 000） */
  const idGenerator = options.idGenerator
    || platformId.createUploadIdGenerator({ clock: { now } });
  const queue = options.queue || createUploadQueue({
    db,
    interface: iface,
    capacity: options.capacity,
    warnThreshold: options.warnThreshold,
    now,
    logger
  });

  /** 每次真正尝试发送的次数（人工重报也计；供自检证明"没有隐藏重试"） */
  let attemptCount = 0;
  let lastAttemptAt = null;
  let lastResult = null;

  /** 是否需要"未配置 baseUrl"的显式结论（配置可运行期变化，故每次读） */
  const configured = () => Boolean(mes.baseUrl);
  const q = () => (config && config.mes) || {};
  const baseUrl = () => String(q().baseUrl || '').replace(/\/$/, '');
  const pathTemplate = () => q().pathTemplate || '/service/{serviceName}/{methodName}';
  const responseStyle = () => (q().responseStyle === 'code' ? 'code' : 'status');
  const token = () => q().token || '';

  /** 组装 URL（与前端 `api.js` 的 buildUrl 同模板同拼法） */
  function buildUrl() {
    const path = pathTemplate().replace('{serviceName}', serviceName).replace('{methodName}', methodName);
    return baseUrl() + path;
  }

  /** 13 字段的**取数快照**（供界面/自检核对"每个字段从哪来、缺了怎么表达"） */
  function describeFields() {
    const out = {};
    for (const f of REPORT_FIELDS) out[f] = Object.assign({ field: f }, REPORT_SOURCES[f]);
    return out;
  }

  /**
   * 组装一帧上报报文（**只组装、不发送**；纯读库，无副作用）。
   *
   * @param {{procOrderNo?:string, now?:Date}} [input] procOrderNo 缺省＝取 `task` 表里最近更新的工单
   * @returns {{ok:true, body:object, fields:string[], missing:string[], collectTimeFallback:boolean,
   *            frameId:number|null, at:string, interface:string, url:string}
   *          |{ok:false, error:{code:string, field:string, reason:string}}}
   */
  function buildReport(input = {}) {
    const at = input.now === undefined ? now() : platformClock.toDate(input.now);
    const deviceRow = db.prepare('SELECT * FROM device ORDER BY updated_at DESC, equip_code ASC LIMIT 1').get() || null;
    const taskRow = input.procOrderNo
      ? db.prepare('SELECT * FROM task WHERE proc_order_no = ?').get(String(input.procOrderNo))
      : db.prepare('SELECT * FROM task ORDER BY updated_at DESC, proc_order_no ASC LIMIT 1').get();
    if (!taskRow) {
      return {
        ok: false,
        error: {
          code: 'NO_TASK',
          field: 'procOrderNo',
          reason: input.procOrderNo
            ? `库中不存在生产任务编号 ${input.procOrderNo}（IF-A.1 派工信息尚未下发？）—— 拒绝组装上报报文`
            : '库中没有任何工单（task 表为空）—— 拒绝组装上报报文：procOrderNo 是必填且为 MES 幂等键'
        }
      };
    }
    /* 报文所依据的**那一帧**：取该工单最近一条落库采样（DR-13 幂等 = 同秒后到覆盖）。
       ⚠ 全部 13 字段里的实测类字段都取自**这一帧**，保证"同一时刻的一组值"（不混帧）。 */
    const frame = db.prepare(
      'SELECT * FROM measure_rt WHERE proc_order_no = ? ORDER BY id DESC LIMIT 1'
    ).get(taskRow.proc_order_no) || null;

    const equipCode = (deviceRow && deviceRow.equip_code)
      || taskRow.equip_code || (config.device && config.device.equipCode) || '';
    const collectTime = frame && frame.collect_time ? String(frame.collect_time) : fmtClock(at);
    const collectTimeFallback = !(frame && frame.collect_time);
    const testStatus = frame && frame.test_status !== null && frame.test_status !== undefined
      ? frame.test_status
      : ((config && config.dataSource === 'mock') ? 0 : null);
    if (testStatus === null) {
      return {
        ok: false,
        error: {
          code: 'NO_TEST_STATUS',
          field: 'testStatus',
          reason: '既无实测帧可读 test_status，配置 dataSource 也不是 mock —— 不伪造设备运行状态，拒绝发送' +
            '（附录 2 的 testStatus 来源＝PC上位机）'
        }
      };
    }
    /* 缺值一律 null（**不写 0**：0 是合法物理量；理由见文件头"缺值口径"） */
    const num = v => (v === undefined || v === null ? null : Number(v));
    const body = {
      equipCode: equipCode,
      procOrderNo: String(taskRow.proc_order_no),
      frameRate: num(frame && frame.frame_rate),
      gain: num(frame && frame.gain),
      shutter: num(frame && frame.shutter),
      cameraDepth: num(frame && frame.camera_depth),
      depth: num(frame && frame.measure_depth),
      speed: num(frame && frame.speed),
      velocity_x: num(frame && frame.velocity_x),
      velocity_y: num(frame && frame.velocity_y),
      collectTime: collectTime,
      testStatus: testStatus,
      uploadId: idGenerator.next()
    };
    /* §1.2.5（IF-B.5 / C-78 / N-2 的"我方填法"）：深度与速度各一条 `dataList`，上限/下限报**绝对值**，
       标准未设定即整条占位（65535 / IsPass=null）。**不并入 13 字段**，而是随报文另带一个数组。 */
    const std = standardSvc.getEffectiveStandard(db, {
      productCode: taskRow.product_code || '',
      processCode: taskRow.process_no === undefined || taskRow.process_no === null ? '' : String(taskRow.process_no),
      at: collectTime
    });
    const limitOf = kind => {
      const m = standardSvc.absoluteLimits(std)[kind];
      return m || null;
    };
    const paramDataList = ['depth', 'speed'].map(kind => {
      const lim = limitOf(kind);
      const value = kind === 'depth' ? body.depth : body.speed;
      const hasValue = typeof value === 'number' && Number.isFinite(value);
      return {
        tagParam: kind,
        avgValue: value,
        maxValue: value,
        minValue: value,
        uclValue: lim ? lim.upper : placeholder,
        lclValue: lim ? lim.lower : placeholder,
        IsPass: (lim && hasValue) ? (value >= lim.lower && value <= lim.upper) : null
      };
    });
    body.paramDataList = paramDataList;

    /* 缺值清单：**只报告、不阻断**（除 testStatus/procOrderNo 两类"不知就无法上报"的）。
       `missing` 里的字段在报文里以 null / 空串表达，语义＝"本机没有这个值"。 */
    const missing = REPORT_FIELDS.filter(f => body[f] === null || body[f] === '');
    return {
      ok: true, body, fields: [...REPORT_FIELDS], missing,
      collectTimeFallback, frameId: frame ? frame.id : null,
      at: fmtClock(at), interface: iface, url: buildUrl(),
      standardVersionNo: std ? std.versionNo : null
    };
  }

  /** 组装的报文内容指纹（用于"同一帧不重复上报"的比较；**不含 uploadId** —— 它每次都新） */
  function fingerprintOf(body) {
    const copy = Object.assign({}, body);
    delete copy.uploadId;
    return JSON.stringify(copy);
  }

  /** 最近一次**已成功**上报的报文指纹（没有成功记录＝null） */
  function lastSentFingerprint() {
    const last = repo.latest(db, { iface });
    if (!last || last.state !== repo.STATE.SUCCESS || !last.requestBody) return null;
    try {
      return fingerprintOf(JSON.parse(last.requestBody));
    } catch {
      return null;   // 历史行不是 JSON（不该发生）：当作"没有可比对象"，不阻断首次发送
    }
  }

  /** 发一次并回写留痕；**不做任何重试**（失败即入队，等人工）。`body` 已组装好（含 uploadId）。 */
  async function sendOnce(body) {
    const startedAt = now();
    attemptCount++;
    lastAttemptAt = fmtClock(startedAt);
    const requestBody = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json;charset=UTF-8' };
    if (token()) headers.Authorization = 'Bearer ' + token();
    let outcome;
    try {
      outcome = await httpSend({ fetch: fetchImpl }, {
        url: buildUrl(), headers, body: requestBody, timeoutMs
      });
    } catch (err) {
      /* 传输层失败（ECONNREFUSED / 超时中止 / DNS…）：**不重试**，如实记录并留存。 */
      const msg = err && err.message ? err.message : String(err);
      const elapsedMs = Math.max(0, platformClock.toDate(now()).getTime() - platformClock.toDate(startedAt).getTime());
      outcome = { httpStatus: 0, receipt: null, text: '', transportError: msg, elapsedMs };
    }
    const elapsedMs = outcome.elapsedMs !== undefined
      ? outcome.elapsedMs
      : Math.max(0, platformClock.toDate(now()).getTime() - platformClock.toDate(startedAt).getTime());
    const ok = outcome.transportError === undefined && isReceiptOk(outcome.receipt, responseStyle());
    const failReason = ok ? null
      : (outcome.transportError ? `网络错误：${outcome.transportError}` : receiptReason(outcome.receipt));
    const responseCode = ok ? receiptCode(outcome.receipt, outcome.httpStatus)
      : (outcome.transportError ? '网络错误' : (outcome.receipt === null ? '无回执' : receiptCode(outcome.receipt, outcome.httpStatus)));
    const detail = {
      ok, url: buildUrl(), httpStatus: outcome.httpStatus, receipt: outcome.receipt,
      responseText: outcome.text, failReason, responseCode, elapsedMs,
      uploadId: body.uploadId
    };
    if (ok) {
      queue.recordSuccess({
        uploadId: body.uploadId, interface: iface, requestBody: body,
        responseCode, responseBody: outcome.receipt === null ? outcome.text : outcome.receipt,
        elapsedMs
      });
    } else {
      try {
        queue.enqueueFailed({
          uploadId: body.uploadId, interface: iface, requestBody: body,
          responseCode, responseBody: outcome.receipt === null ? (outcome.text || outcome.transportError || '') : outcome.receipt,
          elapsedMs, failReason
        });
      } catch (err) {
        /* 队列满 ⇒ 报文**未被留存**（`UploadQueueFullError`）：绝不静默，写入返回值与日志 */
        detail.queueFull = true;
        detail.queueError = err && err.message ? err.message : String(err);
        if (logger) logger.error('[IF-B 上报] 失败报文未能留存（队列已满）—— 必须人工处置', { uploadId: body.uploadId });
      }
    }
    detail.alert = queue.alert();
    detail.pendingCount = detail.alert.pendingCount;
    lastResult = detail;
    if (logger) {
      if (ok) logger.info('[IF-B 上报] 成功', { uploadId: body.uploadId, url: detail.url, responseCode });
      else logger.warn('[IF-B 上报] 失败已留存待人工补传（**不自动重试**，IF-B.9 / V1.31）', {
        uploadId: body.uploadId, url: detail.url, responseCode, failReason, pending: detail.pendingCount
      });
    }
    return detail;
  }

  /**
   * **上报一帧**（首发）。失败即留存 + 告警 + 待补传条数；**绝不自动重发**。
   *
   * `mes.baseUrl` 未配置时**显式**返回 `{ok:false, skipped:true, reason:'未配置 MES 地址（Q-23）'}`，
   * 既不发送也不落"成功"（也不落"待补传"—— 未配置不是"上报失败"，是"还没得报"）。
   *
   * @param {{procOrderNo?:string, now?:Date}} [input]
   * @returns {Promise<object>} `{ok, skipped?, reason?, uploadId?, pendingCount?, alert?, ...}`
   * @throws {Error} `strict:true` 且本次报文与最近一次成功报文完全相同（＝同一帧重复上报）
   */
  async function report(input = {}) {
    if (!configured()) return Object.assign({}, NOT_CONFIGURED, { at: fmtClock(now()) });
    const built = buildReport(input);
    if (!built.ok) {
      return {
        ok: false, skipped: true, reason: built.error.reason,
        error: built.error, at: fmtClock(now())
      };
    }
    /* 同一帧不重复上报：MES 侧以 procOrderNo 幂等覆盖（IF-B.9），本机重复发送只会刷出
       多条 upload_log 并让"是否需要补传"的判断变糊。判定＝与**最近一次成功**报文（除 uploadId 外）逐字节相同。 */
    const fp = fingerprintOf(built.body);
    if (fp === lastSentFingerprint()) {
      if (strict) throw new Error(`uploadReporter: 本次报文与最近一次成功上报完全相同（同一帧重复上报被拒，strict 模式）`);
      lastResult = { ok: true, skipped: true, reason: 'STALE_FRAME', uploadId: built.body.uploadId,
        message: '本次组装的报文与最近一次成功上报完全相同 —— 已跳过发送（避免重复上报同一帧）' };
      return Object.assign({}, lastResult, { pendingCount: queue.pendingCount(), alert: queue.alert(), at: fmtClock(now()) });
    }
    const sent = await sendOnce(built.body);
    return Object.assign({}, sent, {
      fields: built.fields, missing: built.missing, collectTimeFallback: built.collectTimeFallback
    });
  }

  /**
   * **人工一键重报**（IF-B.9 / V1.31 / UI-20）：**唯一**会再次发送待补传报文的入口。
   *
   * 语义：
   *   · **按序**：待补传清单本身按 `created_at ASC, id ASC`（先失败先补报）；
   *   · **幂等**：已成功的条目不在待补传清单里，**不会被重发**；重复调用同一批不会再发一遍；
   *   · 仍失败 ⇒ 留在队列里、`retry_count` +1、刷新失败原因（**绝不丢弃报文**）；
   *   · 未配置 `baseUrl` ⇒ 只回 `skipped`，**一条都不发**；
   *   · 无定时器、无退避、无后台循环（本函数只在被调用时跑一趟）。
   *
   * @param {{ids?:string[], limit?:number, order?:(a,b)=>number}} [options]
   * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, requested:number, sent:number,
   *                    failed:number, remaining:number, results:Array<object>, alert:object}>}
   */
  async function retryPending(options = {}) {
    if (!configured()) {
      return Object.assign({}, NOT_CONFIGURED, {
        requested: 0, sent: 0, failed: 0,
        remaining: queue.pendingCount(true), results: [], alert: queue.alert(), at: fmtClock(now())
      });
    }
    const wantIds = Array.isArray(options.ids) && options.ids.length
      ? new Set(options.ids.map(String))
      : null;
    const all = queue.listPending({ limit: options.limit === undefined ? undefined : options.limit });
    const selected = wantIds ? all.filter(it => wantIds.has(String(it.uploadId))) : all;
    const results = [];
    let sent = 0;
    let failed = 0;
    for (const item of selected) {
      /* 幂等防线：若这条已不在待补传状态（例如调用前刚被别处补传成功），跳过而不是重发。
         `listPending` 只返回待补传/失败，故这里通常恒真 —— 留着是为了**语义显式**。 */
      if (!queue.isPending(item.uploadId, item.interface)) {
        results.push({ uploadId: item.uploadId, ok: true, skipped: true, reason: 'ALREADY_SETTLED' });
        continue;
      }
      const current = queue.get(item.uploadId, item.interface);
      let body = null;
      try {
        body = JSON.parse(current.requestBody);
      } catch {
        body = null;
      }
      if (!body || typeof body !== 'object') {
        /* 留存报文不可解析（不该发生）：**不当成成功**，仍失败并累加次数（人工可据此排查） */
        const marked = queue.markRetried(item.uploadId, {
          ok: false, interface: item.interface, responseCode: '本机错误',
          failReason: '留存报文无法解析为 JSON —— 无法补传，请人工核对 upload_log.request_body'
        });
        failed++;
        results.push({ uploadId: item.uploadId, ok: false, error: '留存报文无法解析', retryCount: marked.retryCount });
        continue;
      }
      body.uploadId = item.uploadId;          // 用**留存时的** uploadId（DR-13 幂等键），不重新生成
      const r = await sendOnce(body);
      if (r.ok) {
        sent++;
        results.push({ uploadId: item.uploadId, ok: true, responseCode: r.responseCode, httpStatus: r.httpStatus });
      } else {
        failed++;
        results.push({ uploadId: item.uploadId, ok: false, error: r.failReason, responseCode: r.responseCode });
      }
    }
    const alert = queue.alert();
    if (logger) {
      logger.info('[IF-B 上报] 人工一键重报完成（按序补传）', {
        requested: selected.length, sent, failed, remaining: alert.pendingCount
      });
    }
    return {
      ok: true, requested: selected.length, sent, failed,
      remaining: alert.pendingCount, results, alert, at: fmtClock(now())
    };
  }

  /** 供 UI-20 / 自检消费的状态快照：配置、13 字段来源与缺值、队列与告警、最近一次结果 */
  function status() {
    const s = queue.status();
    const last = repo.latest(db, { iface });
    let lastBody = null;
    try { lastBody = last && last.requestBody ? JSON.parse(last.requestBody) : null; } catch { lastBody = null; }
    return {
      mount: 'upload', mounted: true, by: 'W4',
      interface: iface,
      configured: configured(),
      configWarning: configured() ? null : NOT_CONFIGURED.reason,
      baseUrl: mes.baseUrl || '',
      responseStyle: responseStyle(),
      queueCap: q().queueCap === undefined ? queue.capacity : q().queueCap,
      capacity: queue.capacity,
      warnThreshold: queue.warnThreshold,
      pendingCount: s.pending,
      pendingOnly: s.pendingOnly,
      failedAfterRetry: s.failedAfterRetry,
      total: s.total,
      oldestAt: s.oldestAt,
      alert: s.alert,
      autoRetry: false,
      autoRetryNote: '不做自动重试/指数退避（IF-B.9 / V1.31 / C-59）：重报只能经 POST /upload/retry 人工触发',
      attemptCount,
      lastAttemptAt,
      lastResult,
      lastLogged: last ? { uploadId: last.uploadId, state: last.state, responseCode: last.responseCode,
        retryCount: last.retryCount, failReason: last.failReason, createdAt: last.createdAt, updatedAt: last.updatedAt } : null,
      lastBody,
      fields: describeFields()
    };
  }

  return {
    interface: iface,
    serviceName,
    methodName,
    queue,
    queueCap: queue.capacity,
    warnThreshold: queue.warnThreshold,
    timeoutMs,
    buildReport,
    buildUrl,
    sendOnce,
    report,
    retryPending,
    status,
    pendingCount: refresh => queue.pendingCount(refresh),
    listPending: query => queue.listPending(query),
    /** 自检/巡检用：本次尝试发送的真实次数（人工重报也计） */
    attempts: () => attemptCount,
    lastResult: () => lastResult,
    fields: () => [...REPORT_FIELDS],
    sources: () => Object.assign({}, REPORT_SOURCES)
  };
}

module.exports = {
  createUploadReporter,
  httpSend,
  REPORT_FIELDS,
  REPORT_SOURCES,
  NOT_CONFIGURED,
  DEFAULT_SERVICE,
  DEFAULT_METHOD,
  DEFAULT_TIMEOUT_MS,
  isReceiptOk,
  receiptReason
};
