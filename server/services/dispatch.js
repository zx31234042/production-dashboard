/* ==========================================================================
   IF-A 派工/物料/工艺接收服务（server/services/dispatch.js）—— W2（服务层第二笔 · 第 2 波）
   作用：把 MES 下发的三类业务信息变成**可校验、可幂等落库、可留痕、可观测**的一条链：
     ① 派工信息（`IF-A.1`）→ `task`（DR-02「工单任务表（来源 IF-A）」）；
     ② 物料信息（`IF-A.2`）→ 见下「物料/工艺的落库口径」；
     ③ 工艺信息（`IF-A.3`）→ 见下「物料/工艺的落库口径」；
     ④ 设备运行信息（`IF-A.4`）→ `device`（DR-01），**`equipCode` 的权威写入点**。
   权威侧（`FR-1.2` / `IF-D.12` / `C-100` / `C-102`，V1.38 口径收口）：
     `equipCode` / 工单（`procOrderNo`）/ 工艺**一律以 `IF-A` 为权威**；本机配置
     （`FR-8.6`，真源＝`src/config/board.config.js` 的 `device.equipCode`）**仅作未收到 IF-A 时的兜底**；
     `IF-D` 侧同名字段（`IF-D.2` 工单 / `IF-D.3` 设定值）**仅比对与展示**。
     一旦 IF-A 值与「本机配置」或「IF-D 侧值」不一致 —— **绝不静默择一**：
       · 响应体里带 `warnings[]`（含 code / 两侧取值 / 人可读说明）；
       · 落一条 `op_log`（`op_type='IF-A权威不一致'`）；
       · `GET /ifa/status` 的 `authority` 段常显。
   幂等口径（**逐类声明，依据见各处常量与断言**）：
     · `task`（派工/工单）＝**幂等**：`INSERT … ON CONFLICT(proc_order_no) DO NOTHING`
       —— 同键重复下发**不新增行、也不改写既有行**。依据：① `proc_order_no` 是 `schema.sql` DR-02
       的主键，"同键不产生第二条记录"由库层唯一性直接保证（无需另起第二套去重真源）；
       ② `task` 还带**本机自有进度列**（`status` / `actual_start` / `actual_end`），它们由看板侧的
       判定与流程推进，若"后到覆盖"会把本机进度抹掉 —— 那是毁本地状态，不是同步；
       ③ 与既有先例同口径（`server/repo/measure.js` 的 `INSERT OR IGNORE`，DR-13 明示幂等优先）。
     · `device`（设备运行信息）＝**后到覆盖**：`device.equip_code` 是 DR-01 的主键，且该表的口径是
       "整套系统 1 个编号"；同键重复下发即**刷新**权威值（`equip_name` / `updated_at`），行数不变。
       依据：MES 是 `equipCode` 的给定方（附录 2「数据来源＝MES 工单」），最新下发即最新权威值。
     · 物料 / 工艺＝**幂等**：幂等键＝`op_log(op_type, content)` 的**规范化报文签名**（同键已有行
       ⇒ `duplicate`，不追加）。
   物料/工艺的落库口径（**为什么不是新建表**）：
     V1.38 §7 的 DR-01～DR-19 **没有物料表**；`DR-03 standard` 在 V1.33 已重建为
     「(产品,工序,版本) 的深度/速度偏差」追加式版本模型，**不再承载相机设定值**
     （FR-3.5～3.8 的设定深度/增益/帧率/快门自 V1.33 起属"设备参数、不参与判定"）。
     故本包**不新建表、不改 `schema.sql`/`server/db/*`/`server/repo/*`**（任务书明令），
     物料与工艺信息以 DR-12 `op_log` 作**可查询留痕**落库（附完整规范化报文 + 签名），
     真实契约（Q-23）到位后若 MES 方给出专属表口径，只改本文件的 `applyLedger()` 一处。
     一句话：**结构真源仍只有 `server/db/schema.sql` 一份**，本文件只写它已声明的表。
   留痕口径（把技术债 **E16** 的"`op_log` 零调用方"接上一半 —— 失败/成功都留痕）：
     · 成功收下 ⇒ 一条 `op_log`（`result='成功'`，`op_type` 按入站种类区分，可 `opLogRepo.list()` 查询）；
     · 拒收/鉴权拒绝 ⇒ 一条 `op_log`（`result='失败'`，带机器可读 code 与可读原因）；
     · 权威不一致 ⇒ 一条 `op_log`（`op_type='IF-A权威不一致'`）；
     · **幂等命中（duplicate）不追加**：留痕表只记"状态变化"，否则重复下发会把审计表按心跳刷满；
       重复的可见性由响应 `outcome='duplicate'` 与 `stats` 计数承担（口径统一、可断言）。
   访问控制（负责人 2026-09-27 裁定①：**鉴权本轮做**，完整登录/口令哈希属后续包）：
     · 配置键：`server.ifAuth.{enabled, token}`（`src/config/board.config.js`，**本包不改该文件**，
       键位为约定 + 防御式读取）；运维侧可用环境变量 `DSH_BOARD_IF_TOKEN` 覆盖；自检可注入 `deps.auth`。
     · **未配置**（无键、`enabled!==true`、或 `enabled=true` 但 `token` 为空）⇒ **放行，但明确告警**
       （挂载时 `logger.warn` + `logger.error` 各一次，W6「对外监听告警」同风格；每个响应体带
       `auth.warning`；`/ifa/status` 的 `auth.degraded=true`）—— 绝不静默放行。
     · **已配置** ⇒ 请求头必须携带令牌：`Authorization: Bearer <token>` 或 `X-IF-Token: <token>`；
       缺失 ⇒ **401**，不匹配 ⇒ **403**，两者都落 `op_log` 且**不落任何业务表**。
     · **鉴权先于报文校验**（W2 判据②：拒绝原因必须是"鉴权"而不是"参数"）；令牌一律不落日志/库，
       不硬编码任何明文口令（值只来自配置/环境/注入）。
   依赖：`server/repo/opLog.js`（唯一留痕出口）、`platform/clock.js`（时间注入，ADR-0003 D17：
        业务代码不得直接 `new Date()`）、`src/config/board.config.js`（本机兜底编号与鉴权键）。
        **零第三方依赖**（`node:crypto` 为内置模块）。
   用法：
     const { createDispatch, KIND } = require('./services/dispatch');
     const d = createDispatch({ db, logger, now: clock.source() });
     const a = d.authorize(req.headers, { path: '/ifa/dispatch' });
     if (!a.ok) return router.json(res, a.httpStatus, …);
     const r = d.receive(KIND.DISPATCH, body);   // → { outcome:'stored'|'duplicate'|'rejected', … }
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');

const opLogRepo = require('../repo/opLog');
const platformClock = require('../../platform/clock');
const boardConfig = require('../../src/config/board.config.js');
const { KIND: EVENT_KIND } = require('./eventBus');

/* ---------------- 一、契约常量（全部可从需求原文追到出处） ---------------- */

/** DR-16 时间文本（`yyyy-MM-dd HH:mm:ss`）；真源＝`server/repo/opLog.js`（同层共用一把尺子） */
const TIME_RE = opLogRepo.TIME_RE;

/** 入站种类（IF-A 四类；任务书点名的三类＝派工/物料/工艺，设备运行信息见 IF-A.4） */
const KIND = Object.freeze({
  DISPATCH: 'dispatch',
  MATERIAL: 'material',
  PROCESS: 'process',
  DEVICE: 'device'
});

/** 结果种类（`receive()` 的 `outcome`）——与 W1 的 ingest 同形，便于上层统一分流 */
const OUTCOME = Object.freeze({
  STORED: 'stored',
  DUPLICATE: 'duplicate',
  REJECTED: 'rejected'
});

/** 拒收原因码（机器可读稳定字符串；HTTP 状态码一并给出，避免上层再判断一次） */
const REJECT = Object.freeze({
  KIND: 'UNKNOWN_KIND',
  BODY: 'BODY_NOT_OBJECT',
  MISSING: 'MISSING_FIELD',
  MISSING_CONTENT: 'MISSING_CONTENT',
  TYPE: 'BAD_TYPE',
  TIME: 'BAD_TIME',
  VALUE: 'BAD_VALUE',
  NO_DB: 'NO_DB',
  DB_WRITE: 'DB_WRITE_FAILED'
});

/** 鉴权失败码（**必须与"参数错"区分**：W2 判据②"拒绝原因是鉴权而非参数"） */
const AUTH_CODE = Object.freeze({
  MISSING: 'AUTH_TOKEN_MISSING',
  INVALID: 'AUTH_TOKEN_INVALID'
});

/** 告警码（可见提示/状态位；**不是**拒收 —— 收下数据但把冲突亮出来） */
const WARN = Object.freeze({
  AUTH_DISABLED: 'IF_AUTH_DISABLED',
  EQUIP_MISMATCH: 'EQUIP_CODE_MISMATCH',
  IFD_EQUIP_MISMATCH: 'IFD_EQUIP_CODE_MISMATCH',
  IFD_TASK_MISMATCH: 'IFD_PROC_ORDER_MISMATCH',
  IFD_STANDARD_MISMATCH: 'IFD_STANDARD_MISMATCH',
  DEVICE_MULTI_ROW: 'DEVICE_TABLE_MULTI_ROW',
  QTY_CONFLICT: 'DISPATCH_QTY_CONFLICT',
  OP_LOG_FAILED: 'OP_LOG_APPEND_FAILED'
});

/** `op_log.op_type` 约定值（可 `opLogRepo.list(db, { opType })` 精确查询） */
const OP_TYPE = Object.freeze({
  DISPATCH: 'IF-A派工接收',
  MATERIAL: 'IF-A物料接收',
  PROCESS: 'IF-A工艺接收',
  DEVICE: 'IF-A设备信息接收',
  REJECT: 'IF-A报文拒收',
  AUTH: 'IF-A访问控制',
  MISMATCH: 'IF-A权威不一致'
});

/** 幂等口径依据（**写死在返回值里**，让"幂等还是后到覆盖"这条口径可被 HTTP/自检直接读到） */
const IDEMPOTENT_BASIS = Object.freeze({
  task: 'schema.sql DR-02 的主键 proc_order_no ＋ INSERT … ON CONFLICT DO NOTHING：' +
    '同键重复下发不新增行、也不改写既有行（task 的 status/actual_start/actual_end 属本机进度，覆盖即毁本地状态）',
  device: 'schema.sql DR-01 的主键 equip_code（device 的口径＝整套系统 1 个编号）：' +
    '同键重复下发为**后到覆盖**（刷新 equip_name/updated_at），行数不变；MES 是 equipCode 的给定方，最新下发即最新权威值',
  ledger: 'DR 无物料/工艺专属表（V1.38 §7 DR-01～DR-19 无物料表；DR-03 standard 自 V1.33 起为深度/速度偏差版本模型）：' +
    '以 DR-12 op_log 作可查询留痕，幂等键＝op_type ＋ 规范化报文签名（同键已有行 ⇒ duplicate，不追加）'
});

/**
 * 各入站种类的字段规格（**只做"形状与类型"这一层**，业务规则在 apply* 里）。
 * 口径：必填字段缺一即拒收；其余字段"给了就校验类型、不给就不写"；**未知字段不拒收**，
 * 但一律回带在 `unknown[]` 里（MES 真实契约 Q-23 未定，静默丢弃字段比拒收更危险）。
 */
const SPECS = Object.freeze({
  [KIND.DISPATCH]: {
    label: '派工信息（IF-A.1）',
    keyField: 'procOrderNo',
    required: ['procOrderNo'],
    strings: ['procOrderNo', 'techNoticeNo', 'batchNo', 'productCode', 'productName', 'productNo',
      'drawingNo', 'orderNo', 'heatBatchNo', 'parentPartNo', 'processNo', 'processName',
      'unit', 'processRoute', 'processNum', 'dispatchTarget', 'equipCode', 'equipName'],
    numbers: [],
    integers: ['dispatchQty', 'planQty'],
    times: ['planStartTime', 'planEndTime'],
    requireOneOf: []
  },
  [KIND.MATERIAL]: {
    label: '物料信息（IF-A.2）',
    keyField: 'procOrderNo',
    required: ['procOrderNo'],
    strings: ['procOrderNo', 'techNoticeNo', 'batchNo', 'processNo', 'processName',
      'materialCode', 'materialName', 'materialType', 'materialBatch', 'specModel',
      'materialDesc', 'unit'],
    numbers: [],
    integers: ['qty'],
    times: [],
    requireOneOf: [['materialCode', 'materialName']]
  },
  [KIND.PROCESS]: {
    label: '工艺信息（IF-A.3）',
    keyField: 'procOrderNo',
    required: ['procOrderNo'],
    strings: ['procOrderNo', 'productCode', 'drawingNo', 'productName', 'processNo', 'processName',
      'processRoute', 'bomInstance', 'workInstruction'],
    /* 相机设定值（FR-3.5～3.8 的四项设备参数）字段名待 Q-23 答复：此处同时接受看板现行
       映射名（`src/config/fieldMap.js` 的 `task.std.*`：stdDepth/stdGain/stdFps/stdShutter）
       与接口侧常见写法（setDepth/setGain/setFrameRate/setShutter）—— 两者都只作**比对与留痕**。 */
    numbers: ['setDepth', 'setGain', 'setFrameRate', 'setShutter',
      'stdDepth', 'stdGain', 'stdFps', 'stdShutter'],
    integers: ['setFrameRate', 'setShutter', 'stdFps', 'stdShutter'],
    times: [],
    requireOneOf: [['processNo', 'processName', 'processRoute', 'workInstruction', 'bomInstance']]
  },
  [KIND.DEVICE]: {
    label: '设备运行信息（IF-A.4）',
    keyField: 'equipCode',
    required: ['equipCode'],
    strings: ['equipCode', 'equipName', 'procOrderNo', 'productCode', 'drawingNo',
      'processNo', 'processName', 'equipStatus'],
    numbers: [],
    integers: [],
    times: ['timestamp'],
    requireOneOf: []
  }
});

/** 取某张表已声明的列集（**运行时从库结构读**，不在此抄一份表结构 —— 结构真源仍只有 schema.sql） */
function tableColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  } catch {
    return [];
  }
}

/* ---------------- 二、小工具（纯函数，便于单测） ---------------- */

/** 缺测判定：`undefined` 与 `null` 都算"报文里没有这个字段" */
const isAbsent = v => v === undefined || v === null;

/** 非空字符串字段：类型不对 ⇒ BAD_TYPE；空串 ⇒ 视为缺（由必填规则兜） */
function readString(body, field) {
  const raw = body[field];
  if (isAbsent(raw)) return { absent: true };
  if (typeof raw !== 'string') {
    return { error: { code: REJECT.TYPE, field, reason: `字段 ${field} 必须是字符串（收到 ${typeName(raw)}）` } };
  }
  const s = raw.trim();
  if (s === '') return { absent: true };
  return { value: s };
}

/**
 * 数值字段：接受 JSON 数字，也接受**纯数字字符串**（MES 侧 XML/文本口径常见，Q-23 未定）。
 * 类型不对或不可解析 ⇒ BAD_TYPE；`integer` / `min` 不满足 ⇒ BAD_VALUE。
 */
function readNumber(body, field, opts = {}) {
  const raw = body[field];
  if (isAbsent(raw)) return { absent: true };
  if (typeof raw === 'string' && raw.trim() === '') return { absent: true };
  let n = null;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(raw.trim())) n = Number(raw.trim());
  if (n === null || !Number.isFinite(n)) {
    return { error: { code: REJECT.TYPE, field, reason: `字段 ${field} 必须是数值（收到 ${JSON.stringify(raw)}）` } };
  }
  if (opts.integer && !Number.isInteger(n)) {
    return { error: { code: REJECT.VALUE, field, reason: `字段 ${field} 必须是整数（收到 ${n}）` } };
  }
  if (opts.min !== undefined && n < opts.min) {
    return { error: { code: REJECT.VALUE, field, reason: `字段 ${field} 不能小于 ${opts.min}（收到 ${n}）` } };
  }
  return { value: n };
}

/** 时间字段：非 DR-16 文本即拒收（与 repo 层同一把尺子，避免"文本比较"被格式污染） */
function readTime(body, field) {
  const raw = body[field];
  if (isAbsent(raw)) return { absent: true };
  if (typeof raw !== 'string' || !TIME_RE.test(raw)) {
    return {
      error: {
        code: REJECT.TIME, field,
        reason: `字段 ${field} 必须是「yyyy-MM-dd HH:mm:ss」（DR-16），收到 ${JSON.stringify(raw)}`
      }
    };
  }
  return { value: raw };
}

/** 类型名（错误原因里给"收到了什么"，便于现场一眼定位） */
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * 校验一类入站报文的形状与类型（**纯函数**：不碰库、不写日志，故可直接单测）。
 * @returns {{ok:true, value:object, unknown:string[]} | {ok:false, error:object}}
 */
function validate(kind, body) {
  const spec = SPECS[kind];
  if (!spec) {
    return { ok: false, error: { code: REJECT.KIND, field: '(kind)', httpStatus: 400,
      reason: `未知的入站种类 ${JSON.stringify(kind)}（本机只接收 ${Object.keys(SPECS).join(' / ')}）` } };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: { code: REJECT.BODY, field: '(body)', httpStatus: 400,
      reason: `${spec.label} 报文必须是 JSON 对象（收到 ${typeName(body)}）` } };
  }
  const value = {};
  for (const f of spec.required) {
    const r = readString(body, f);
    /* 类型错优先于"缺失"报出去：`procOrderNo: 12345` 是**类型错**，不是"没有这个字段" ——
       两者的现场处置完全不同（前者要改 MES 报文，后者要查为什么没下发）。 */
    if (r.error) return { ok: false, error: Object.assign({ httpStatus: 400 }, r.error) };
    if (r.value === undefined) {
      return { ok: false, error: { code: REJECT.MISSING, field: f, httpStatus: 400,
        reason: `${spec.label} 缺少必填字段 ${f}（未给出或为空串）` } };
    }
    value[f] = r.value;
  }
  for (const f of spec.strings) {
    if (value[f] !== undefined) continue;
    const r = readString(body, f);
    if (r.error) return { ok: false, error: Object.assign({ httpStatus: 400 }, r.error) };
    if (r.value !== undefined) value[f] = r.value;
  }
  for (const f of spec.numbers || []) {
    const r = readNumber(body, f);
    if (r.error) return { ok: false, error: Object.assign({ httpStatus: 400 }, r.error) };
    if (r.value !== undefined) value[f] = r.value;
  }
  for (const f of spec.integers || []) {
    const r = readNumber(body, f, { integer: true, min: 0 });
    if (r.error) return { ok: false, error: Object.assign({ httpStatus: 400 }, r.error) };
    if (r.value !== undefined) value[f] = r.value;
  }
  for (const f of spec.times || []) {
    const r = readTime(body, f);
    if (r.error) return { ok: false, error: Object.assign({ httpStatus: 400 }, r.error) };
    if (r.value !== undefined) value[f] = r.value;
  }
  for (const group of spec.requireOneOf || []) {
    if (!group.some(f => value[f] !== undefined)) {
      return { ok: false, error: { code: REJECT.MISSING_CONTENT, field: group[0], httpStatus: 400,
        reason: `${spec.label} 至少需要 ${group.join(' / ')} 之一（都缺失 ⇒ 这条报文没有可用的业务内容）` } };
    }
  }
  const known = new Set([...(spec.required || []), ...(spec.strings || []), ...(spec.numbers || []),
    ...(spec.integers || []), ...(spec.times || [])]);
  const unknown = Object.keys(body).filter(k => !known.has(k));
  return { ok: true, value, unknown };
}

/** 规范化 JSON（键名排序 ⇒ 同一报文恒得同一签名；用于物料/工艺的幂等键） */
function stableJson(value) {
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`).join(',')}}`;
}

/** 报文签名（SHA-256 前 16 位十六进制） */
function signatureOf(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex').slice(0, 16);
}

/** 留痕正文（**长度上限由 repo 定**，超长截断但保证尾部签名完整 —— 签名即幂等键，不可被截掉） */
function ledgerContent(head, detail, sig) {
  const tail = `｜sig=${sig}`;
  const max = opLogRepo.CONTENT_MAX;
  let h = String(head);
  if (h.length + tail.length + 1 > max) h = h.slice(0, Math.max(0, max - tail.length - 1));
  const room = max - h.length - tail.length - 1;
  return `${h}｜${String(detail).slice(0, Math.max(0, room))}${tail}`;
}

/** 事件型留痕正文（无幂等语义，只需截断到上限内） */
function plainContent(text) {
  return String(text).slice(0, opLogRepo.CONTENT_MAX);
}

/** 常量时间比较（防时序侧信道；先各取 SHA-256 摘要，长度必然相等） */
function tokenEquals(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 从请求头取令牌：`Authorization: Bearer x` / `X-IF-Token: x` / `X-DSH-Token: x`（三者等价） */
function readToken(headers) {
  const h = headers || {};
  const pick = name => {
    const v = h[name];
    return Array.isArray(v) ? v[0] : (typeof v === 'string' ? v : '');
  };
  const authz = pick('authorization').trim();
  if (authz) {
    const m = /^Bearer\s+(.+)$/i.exec(authz);
    return m ? m[1].trim() : authz;   // 兼容不带 Bearer 前缀的裸令牌
  }
  return (pick('x-if-token') || pick('x-dsh-token')).trim();
}

/** `board.config.js` 的本机兜底设备编号（FR-8.6）——读不到就给空串（= 不放任何兜底断言） */
function defaultLocalEquipCode() {
  const dev = boardConfig && boardConfig.device;
  return dev && typeof dev.equipCode === 'string' ? dev.equipCode.trim() : '';
}

/** `board.config.js` 的本机设备名（写 `device.equip_name`（NOT NULL）时的兜底来源） */
function defaultLocalEquipName() {
  const dev = boardConfig && boardConfig.device;
  return dev && typeof dev.name === 'string' ? dev.name.trim() : '';
}

/**
 * 解析访问控制配置（优先级：显式注入 → 环境变量 → `board.config.js` 的 `server.ifAuth` → 未配置）。
 * **未配置 ⇒ enabled=false（放行 + 告警）**；不在此读取任何硬编码口令。
 * @returns {{enabled:boolean, token:string, source:string, degraded:boolean, warning:string}}
 */
function resolveAuthConfig(options = {}) {
  const env = options.env || process.env;
  let enabled = false;
  let token = '';
  let source = 'none';
  if (options.auth && typeof options.auth === 'object') {
    enabled = options.auth.enabled === true;
    token = options.auth.token === undefined || options.auth.token === null ? '' : String(options.auth.token);
    source = 'deps';
  } else if (env.DSH_BOARD_IF_TOKEN) {
    enabled = true;
    token = String(env.DSH_BOARD_IF_TOKEN);
    source = 'env:DSH_BOARD_IF_TOKEN';
  } else {
    const seg = boardConfig && boardConfig.server && boardConfig.server.ifAuth;
    if (seg && typeof seg === 'object') {
      enabled = seg.enabled === true;
      token = seg.token === undefined || seg.token === null ? '' : String(seg.token);
      source = 'config:server.ifAuth';
    }
  }
  const incomplete = enabled && token === '';
  const active = enabled && token !== '';
  return {
    enabled: active,
    token: active ? token : '',
    source,
    degraded: !active,
    warning: active
      ? `访问控制已启用（来源 ${source}）：请求头须携带 Authorization: Bearer <token> 或 X-IF-Token: <token>`
      : (incomplete
        ? `访问控制**配置不完整**（来源 ${source}：enabled=true 但 token 为空）—— 本机按"未配置"口径**放行**，` +
          '但必须尽快补上令牌；此为局域网内的降级运行，不得对外监听（NFR-25 / AC-09）'
        : `访问控制**未配置**（来源 ${source}）—— IF-A 端点**当前放行**（MES 派工链路不被阻断），` +
          '但本机接口无鉴权；请在 board.config.js 的 server.ifAuth 或环境变量 DSH_BOARD_IF_TOKEN 配置令牌')
  };
}

/* ---------------- 三、服务实例 ---------------- */

/**
 * 创建 IF-A 接收服务。
 * @param {{db?:object, logger?:object, now?:Function, auth?:{enabled:boolean,token:string},
 *          localEquipCode?:string, ifd?:object|Function, operator?:string, teamCode?:string,
 *          env?:object}} [options]
 *   db             —— 库句柄（缺省 ⇒ 所有写入路径回 503 NO_DB，而不是静默假成功）
 *   now            —— 注入时钟（测试传 `tests/lib/clock.js` 的 `source()`）；
 *                   **注入时钟抛错 ⇒ 本次接收失败并留痕**（不静默回退真实时间，D17/D23）
 *   auth           —— 访问控制（缺省读环境变量/配置，见 resolveAuthConfig）
 *   localEquipCode —— 本机兜底编号（缺省读 board.config.js 的 device.equipCode）
 *   ifd            —— IF-D 侧"仅比对与展示"的取值快照（对象或返回对象的函数）
 * @returns {object} 服务实例（receive / authorize / validate / status / auth / stats）
 */
function createDispatch(options = {}) {
  const db = options.db || null;
  const logger = options.logger || null;
  /* W5-① 事件总线（可选注入）：`task` 事件挂在**派工真正落库**的那一处（见 applyDispatch）。
     不注入 ⇒ 行为与 W2 完全一致（幂等/留痕口径一行不动）。 */
  const bus = options.bus || null;
  if (bus && typeof bus.publish !== 'function') {
    throw new TypeError('dispatch: options.bus 传了但不是事件总线（缺 publish）——见 services/eventBus.js');
  }
  const nowFn = typeof options.now === 'function'
    ? options.now
    : platformClock.createClock({ mode: 'real' }).source();
  const localEquipCode = options.localEquipCode === undefined
    ? defaultLocalEquipCode()
    : String(options.localEquipCode || '').trim();
  const ifdSource = typeof options.ifd === 'function' ? options.ifd : (options.ifd || null);
  const auth = resolveAuthConfig(options);
  const operator = options.operator || null;
  /* 班组编号：与 repo/opLog.js 同口径 —— **不猜**，调用方不给就是 null（FR-1.6 的唯一真源在班次侧） */
  const teamCode = options.teamCode || null;

  /** 计数（可读、可断言；不落库，落库留痕见 op_log） */
  const counters = {
    received: 0, stored: 0, duplicate: 0, rejected: 0, authRejected: 0, mismatch: 0,
    byKind: {}
  };
  const counterOf = kind => {
    if (!counters.byKind[kind]) counters.byKind[kind] = { stored: 0, duplicate: 0, rejected: 0 };
    return counters.byKind[kind];
  };
  /** 最近一次收到的取值（供 `/ifa/status` 常显权威侧） */
  const last = { at: null, kind: null, key: null, outcome: null, warnings: [], ifa: null };

  /** 当前时刻（DR-16 文本）：注入时钟返回 Date 或已格式化字符串都接受 */
  function nowText() {
    let raw;
    try {
      raw = nowFn();
    } catch (err) {
      /* 注入时钟失效时**绝不静默回退真实时间** —— 静默兜底正是 ADR-0003 D17 要防的形态：
         回退墙钟会让用例/留痕里的时间戳与本轮注入的时间悄悄分叉（断言与台账对不上、事故不可复现），
         而且"时钟坏了"这件事在日志里一个字都没有（违反 D23 反静默）。
         故选择 **留痕 + 抛错**：本次接收以 500 可见地失败（HTTP 面由 `router.handle` 收敛成
         稳定错误体并经 `onError` 落日志），而不是盖上一个假时间继续往下走。 */
      const reason = `注入时钟失效（now 注入出口抛错）：${err && err.message ? err.message : String(err)}`;
      if (logger) logger.error(`[IF-A] ${reason} —— 拒绝回退真实时间（ADR-0003 D17），本次接收失败`);
      throw new Error(reason, { cause: err });
    }
    if (raw instanceof Date) return platformClock.fmt(raw);
    const s = String(raw);
    if (TIME_RE.test(s)) return s;
    return platformClock.fmt(s);
  }

  /** 本机配置侧兜底编号（可被实例参数覆盖；空串＝不比较） */
  function localCode() {
    return localEquipCode;
  }

  /** 取 IF-D 侧的"仅比对与展示"快照（函数形态允许每次现读；读不到就是 null） */
  function ifdSnapshot() {
    if (!ifdSource) return null;
    try {
      const v = typeof ifdSource === 'function' ? ifdSource() : ifdSource;
      return v && typeof v === 'object' ? v : null;
    } catch (err) {
      if (logger) logger.warn(`[IF-A] 读取 IF-D 侧比对快照失败（不影响接收）：${err.message}`);
      return null;
    }
  }

  /**
   * 追加留痕（**唯一出口**；不抛 —— 留痕失败必须变成可见告警而不是让接收动作整个失败）。
   * @returns {number|null} op_log.id；失败时 null，并在 `warnings` 里补 `OP_LOG_APPEND_FAILED`
   */
  function appendLedger(entry, at, warnings) {
    if (!db) return null;
    try {
      const r = opLogRepo.append(db, {
        opTime: at,
        operator,
        opType: entry.opType,
        content: entry.content,
        result: entry.result,
        teamCode
      }, at);
      return r.id;
    } catch (err) {
      if (logger) logger.error(`[IF-A] 写 op_log 失败（type=${entry.opType}）：${err.message}`);
      if (Array.isArray(warnings)) {
        warnings.push({ code: WARN.OP_LOG_FAILED, opType: entry.opType,
          message: `留痕写入失败（${err.message}）—— 业务结果已按返回值给出，但审计台账缺这一条` });
      }
      return null;
    }
  }

  /** 拒收留痕（**失败日志**：任何拒收都必须有可查询留痕 + 日志，不得静默） */
  function recordReject(kind, error, meta, at) {
    const spec = SPECS[kind];
    const from = meta && (meta.path || meta.remote) ? `｜来源=${meta.path || ''}${meta.remote ? '@' + meta.remote : ''}` : '';
    if (logger) {
      logger.warn(`[IF-A] ${spec ? spec.label : kind} 报文被拒收：${error.code}／${error.field}／${error.reason}${from}`);
    }
    return appendLedger({
      opType: OP_TYPE.REJECT,
      result: '失败',
      content: plainContent(
        `${spec ? spec.label : String(kind)}｜code=${error.code}｜field=${error.field}｜原因=${error.reason}${from}`)
    }, at, null);
  }

  /** 权威不一致留痕（**不静默**：FR-1.2 / IF-D.12 的"给出可见提示"必须同时留在台账里） */
  function recordMismatch(field, ifaValue, otherValue, otherSource, extra, at) {
    counters.mismatch++;
    if (logger) {
      logger.warn(`[IF-A] 权威不一致（以 IF-A 为准）：${field} IF-A=${ifaValue} ≠ ${otherSource}=${otherValue}`);
    }
    return appendLedger({
      opType: OP_TYPE.MISMATCH,
      result: '成功',
      content: plainContent(
        `${field}｜IF-A（权威）=${ifaValue}｜${otherSource}=${otherValue}｜已按 IF-A 为准处理${extra ? '｜' + extra : ''}`)
    }, at, null);
  }

  /**
   * 鉴权（**先于报文校验**）：未配置 ⇒ 放行（带 warning）；已配置 ⇒ 令牌必须匹配。
   * 失败即落 `op_log`（不落业务表），并回 401（未携带）/ 403（不匹配）。
   * @param {object} headers 请求头（node 已小写化）
   * @param {{path?:string, kind?:string, remote?:string}} [meta]
   */
  function authorize(headers, meta = {}) {
    const at = nowText();
    const visible = {
      enabled: auth.enabled, source: auth.source, degraded: auth.degraded, warning: auth.warning
    };
    if (!auth.enabled) return { ok: true, mode: 'disabled', at, auth: visible };
    const presented = readToken(headers);
    if (!presented) {
      counters.authRejected++;
      const reason = '请求未携带访问令牌（Authorization: Bearer <token> 或 X-IF-Token: <token>）—— 拒绝原因是**鉴权**，不是报文参数';
      appendLedger({
        opType: OP_TYPE.AUTH,
        result: '失败',
        content: plainContent(`鉴权拒绝｜code=${AUTH_CODE.MISSING}｜${meta.kind || ''}｜path=${meta.path || ''}` +
          `｜来源=${meta.remote || ''}｜未携带令牌（expectedLen=${auth.token.length}）`)
      }, at, null);
      if (logger) {
        logger.warn(`[IF-A] 鉴权拒绝（未携带令牌）：${meta.path || ''}（${AUTH_CODE.MISSING}）`);
        logger.error(`[IF-A] 鉴权拒绝确认：${meta.path || ''} — 未授权请求已挡在业务处理之前`);
      }
      return { ok: false, code: AUTH_CODE.MISSING, httpStatus: 401, reason, at, auth: visible };
    }
    if (!tokenEquals(presented, auth.token)) {
      counters.authRejected++;
      const reason = '访问令牌不匹配 —— 拒绝原因是**鉴权**，不是报文参数';
      appendLedger({
        opType: OP_TYPE.AUTH,
        result: '失败',
        content: plainContent(`鉴权拒绝｜code=${AUTH_CODE.INVALID}｜${meta.kind || ''}｜path=${meta.path || ''}` +
          `｜来源=${meta.remote || ''}｜令牌不匹配（presentedLen=${presented.length}）`)
      }, at, null);
      if (logger) {
        logger.warn(`[IF-A] 鉴权拒绝（令牌不匹配）：${meta.path || ''}（${AUTH_CODE.INVALID}）`);
        logger.error(`[IF-A] 鉴权拒绝确认：${meta.path || ''} — 令牌不匹配，未授权请求已挡在业务处理之前`);
      }
      return { ok: false, code: AUTH_CODE.INVALID, httpStatus: 403, reason, at, auth: visible };
    }
    return { ok: true, mode: 'token', at, auth: visible };
  }

  /* ---- 三之① 权威侧比对（equipCode / procOrderNo / 工艺设定值；IF-D 仅比对与展示） ---- */
  function checkAuthority(kind, value, warnings, at) {
    const ifd = ifdSnapshot();
    if (typeof value.equipCode === 'string' && value.equipCode) {
      const local = localCode();
      if (local && local !== value.equipCode) {
        const w = {
          code: WARN.EQUIP_MISMATCH, field: 'equipCode',
          authoritative: value.equipCode, authoritativeSource: 'IF-A',
          localConfig: local,
          message: `设备编号不一致：IF-A（权威）=${value.equipCode}，本机配置（FR-8.6 / board.config.js）=${local}；` +
            '已按 IF-A 为准写入 device，**请同步修正本机配置**（FR-1.2 / IF-D.12）'
        };
        warnings.push(w);
        recordMismatch('equipCode', value.equipCode, local, '本机配置', '已写入 device（以 IF-A 为准）', at);
      }
      if (ifd && typeof ifd.equipCode === 'string' && ifd.equipCode && ifd.equipCode !== value.equipCode) {
        warnings.push({
          code: WARN.IFD_EQUIP_MISMATCH, field: 'equipCode',
          authoritative: value.equipCode, authoritativeSource: 'IF-A', ifd: ifd.equipCode,
          message: `IF-D 侧报文带的 equipCode=${ifd.equipCode} 与 IF-A（权威）=${value.equipCode} 不一致；` +
            'IF-D 侧该字段**仅作比对与展示**（IF-D.12），不参与取值'
        });
        recordMismatch('equipCode', value.equipCode, ifd.equipCode, 'IF-D 侧', 'IF-D 仅比对与展示', at);
      }
    }
    if (typeof value.procOrderNo === 'string' && value.procOrderNo &&
        ifd && typeof ifd.procOrderNo === 'string' && ifd.procOrderNo && ifd.procOrderNo !== value.procOrderNo) {
      warnings.push({
        code: WARN.IFD_TASK_MISMATCH, field: 'procOrderNo',
        authoritative: value.procOrderNo, authoritativeSource: 'IF-A', ifd: ifd.procOrderNo,
        message: `IF-D 侧报文带的 procOrderNo=${ifd.procOrderNo} 与 IF-A（权威）=${value.procOrderNo} 不一致；` +
          'IF-D.2 的同名字段**仅作比对与展示**（C-102），工单以 IF-A 为权威'
      });
      recordMismatch('procOrderNo', value.procOrderNo, ifd.procOrderNo, 'IF-D 侧', 'IF-D 仅比对与展示', at);
    }
    if (kind === KIND.PROCESS && ifd) {
      /* 工艺信息（FR-3.5～3.8 的四项相机设定值）以 IF-A 为权威；IF-D.3 的设定值仅比对与展示。 */
      const pairs = [['setDepth', 'cameraDepth'], ['setGain', 'gain'],
        ['setFrameRate', 'frameRate'], ['setShutter', 'shutter'],
        ['stdDepth', 'cameraDepth'], ['stdGain', 'gain'], ['stdFps', 'frameRate'], ['stdShutter', 'shutter']];
      const seen = new Set();
      for (const [ifaField, ifdField] of pairs) {
        if (seen.has(ifdField)) continue;
        const a = value[ifaField];
        const b = ifd[ifdField];
        if (typeof a !== 'number' || typeof b !== 'number' || a === b) continue;
        seen.add(ifdField);
        warnings.push({
          code: WARN.IFD_STANDARD_MISMATCH, field: ifaField,
          authoritative: a, authoritativeSource: 'IF-A', ifd: b, ifdField,
          message: `工艺设定值 ${ifaField}：IF-A（权威）=${a}，IF-D.3 侧 ${ifdField}=${b}；` +
            '以 IF-A 为准，IF-D.3 的设定值仅比对与展示'
        });
        recordMismatch(ifaField, a, b, `IF-D 侧 ${ifdField}`, 'IF-D.3 仅比对与展示', at);
      }
    }
  }

  /* ---- 三之② 派工（IF-A.1）→ task（DR-02，幂等） ---- */

  /** `task` 的插入语句：列集取自 `server/db/schema.sql` 的 DR-02 段（不在此另立结构真源）。
   *  `status` **不写** —— 交给 schema 的缺省值「待测试」，因为它是**本机进度列**，不由 MES 报文决定。 */
  const TASK_INSERT =
    `INSERT INTO task(proc_order_no, batch_no, product_code, product_name, product_no, drawing_no,
                      order_no, plan_qty, plan_start_time, plan_end_time, process_no, process_name,
                      created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(proc_order_no) DO NOTHING`;

  /** 派工数量：`planQty`（看板现行映射名）与 `dispatchQty`（IF-A.1 报文名）都收；两者冲突即告警 */
  function resolveQty(value, warnings) {
    const plan = value.planQty;
    const disp = value.dispatchQty;
    if (plan !== undefined && disp !== undefined && plan !== disp) {
      warnings.push({
        code: WARN.QTY_CONFLICT, field: 'planQty',
        message: `派工数量同一报文里出现两个值：planQty=${plan}、dispatchQty=${disp}；` +
          '按看板现行映射名 planQty 落库（fieldMap.js 的 task.planQty），另一个值仅留存痕'
      });
    }
    const q = plan !== undefined ? plan : (disp === undefined ? 0 : disp);
    return Math.trunc(q);
  }

  /** 写 `device`（DR-01）：IF-A 为权威；同键后到覆盖，异键兜底行"让位"（主键改名，不删行不增行） */
  function writeDevice(value, at, warnings) {
    const code = value.equipCode;
    const name = value.equipName || defaultLocalEquipName() || code;
    const cols = tableColumns(db, 'device');
    if (!cols.length) {
      throw new Error('device 表不存在（库结构未初始化？）—— 无法写入 IF-A 设备信息');
    }
    const rows = db.prepare('SELECT equip_code FROM device').all().map(r => r.equip_code);
    const existed = rows.includes(code);
    const superseded = rows.filter(c => c !== code);
    db.exec('BEGIN');
    try {
      if (existed) {
        db.prepare('UPDATE device SET equip_name = ?, updated_at = ? WHERE equip_code = ?').run(name, at, code);
      } else if (rows.length === 1) {
        /* 单行让位：本体保留（upper_host / mes_base_url 等本机兜底值不动），只把主键改成 IF-A 的权威编号
           —— device 的口径是"整套系统 1 个编号"（schema.sql DR-01），故不新增第二行、也不删行。 */
        db.prepare('UPDATE device SET equip_code = ?, equip_name = ?, updated_at = ? WHERE equip_code = ?')
          .run(code, name, at, rows[0]);
      } else if (rows.length === 0) {
        db.prepare('INSERT INTO device(equip_code, equip_name, updated_at) VALUES(?, ?, ?)').run(code, name, at);
      } else {
        /* 多行（异常态：device 本该只有 1 行）——不删任何行，只 upsert 权威行并**明确告警**。 */
        db.prepare(
          `INSERT INTO device(equip_code, equip_name, updated_at) VALUES(?, ?, ?)
           ON CONFLICT(equip_code) DO UPDATE SET equip_name = excluded.equip_name, updated_at = excluded.updated_at`
        ).run(code, name, at);
        warnings.push({
          code: WARN.DEVICE_MULTI_ROW, field: 'equipCode',
          rows,
          message: `device 表本应只有 1 行（DR-01"整套系统 1 个编号"），实际 ${rows.length} 行：${rows.join(' / ')}；` +
            '已写入 IF-A 权威行，**未删除**其余行（请人工核对本机配置与历史数据）'
        });
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误 */ }
      throw err;
    }
    return { equipCode: code, equipName: name, created: !existed && rows.length === 0,
      updated: existed, superseded, deviceRows: rows.length === 0 ? 1 : rows.length };
  }

  function applyDispatch(value, at, warnings) {
    const qty = resolveQty(value, warnings);
    const r = db.prepare(TASK_INSERT).run(
      value.procOrderNo, value.batchNo || null, value.productCode || null, value.productName || null,
      value.productNo || null, value.drawingNo || null, value.orderNo || null, qty,
      value.planStartTime || null, value.planEndTime || null,
      value.processNo || null, value.processName || null, at, at);
    const stored = Number(r.changes) > 0;
    let device = null;
    if (typeof value.equipCode === 'string' && value.equipCode) device = writeDevice(value, at, warnings);
    /* ---- W5-①：`task` 事件挂在**派工真正新增行**的这一刻 ----
       为什么 `stored` 才发：`ON CONFLICT DO NOTHING` 命中时（duplicate）**没有任何状态变化**，
       发出去只会让看板把"重复下发"误当成"任务切换"；payload 里的 `ifaKind` 说明它来自 IF-A 哪一类
       （`task` 事件只覆盖派工/工单；物料/工艺/设备不是工单切换，故不发布）。 */
    if (stored && bus) {
      bus.publish(EVENT_KIND.TASK, {
        ifaKind: KIND.DISPATCH,
        procOrderNo: value.procOrderNo,
        table: 'task',
        outcome: OUTCOME.STORED,
        productCode: value.productCode || null,
        productName: value.productName || null,
        processNo: value.processNo || null,
        planQty: qty,
        equipCode: value.equipCode || null
      }, { at });
    }
    return {
      outcome: stored ? OUTCOME.STORED : OUTCOME.DUPLICATE,
      key: value.procOrderNo,
      table: 'task',
      device,
      idempotency: { mode: 'idempotent', key: 'task.proc_order_no', basis: IDEMPOTENT_BASIS.task }
    };
  }

  /* ---- 三之③ 设备运行信息（IF-A.4）→ device（DR-01，后到覆盖） ---- */
  function applyDevice(value, at, warnings) {
    const written = writeDevice(value, at, warnings);
    return {
      outcome: OUTCOME.STORED,
      key: value.equipCode,
      table: 'device',
      device: written,
      idempotency: { mode: 'overwrite', key: 'device.equip_code', basis: IDEMPOTENT_BASIS.device }
    };
  }

  /* ---- 三之④ 物料 / 工艺 → op_log 留痕（幂等键＝op_type ＋ 规范化报文签名） ---- */
  function applyLedger(kind, value, at, warnings) {
    const spec = SPECS[kind];
    const opType = kind === KIND.MATERIAL ? OP_TYPE.MATERIAL : OP_TYPE.PROCESS;
    const sig = signatureOf(value);
    const key = value[spec.keyField];
    const content = ledgerContent(`${spec.label} ${key}`, stableJson(value), sig);
    const dup = db.prepare('SELECT id FROM op_log WHERE op_type = ? AND content = ? LIMIT 1').get(opType, content);
    if (dup) {
      return {
        outcome: OUTCOME.DUPLICATE, key, table: 'op_log', sig, ledgerId: Number(dup.id), content,
        idempotency: { mode: 'idempotent', key: 'op_log(op_type, content 签名)', basis: IDEMPOTENT_BASIS.ledger }
      };
    }
    return {
      outcome: OUTCOME.STORED, key, table: 'op_log', sig, ledgerId: null, content,
      idempotency: { mode: 'idempotent', key: 'op_log(op_type, content 签名)', basis: IDEMPOTENT_BASIS.ledger }
    };
  }

  /* ---- 三之⑤ 统一入口 ---- */
  function apply(kind, value, at, warnings) {
    if (kind === KIND.DISPATCH) return applyDispatch(value, at, warnings);
    if (kind === KIND.DEVICE) return applyDevice(value, at, warnings);
    return applyLedger(kind, value, at, warnings);
  }

  /** 成功留痕的正文（把告警一并写进留痕：事后回查能看见"当时给过提示"） */
  function receiptText(kind, value, applied, warnings) {
    const spec = SPECS[kind];
    const warnText = warnings.length ? `｜告警=${warnings.map(w => w.code).join(',')}` : '';
    return `${spec.label} ${applied.key}｜结果=${applied.outcome}｜表=${applied.table}` +
      (applied.sig ? `｜sig=${applied.sig}` : '') + warnText;
  }

  /**
   * 接收一条报文（**校验 → 权威比对 → 落库 → 留痕**；任一步失败都可读地返回，不抛）。
   * @param {string} kind   KIND.*
   * @param {object} body   已解析的 JSON 报文
   * @param {{path?:string, method?:string, remote?:string}} [meta]
   */
  function receive(kind, body, meta = {}) {
    const at = nowText();
    const spec = SPECS[kind];
    counters.received++;
    const v = validate(kind, body);
    if (!v.ok) {
      counters.rejected++;
      counterOf(kind).rejected++;
      const ledgerId = recordReject(kind, v.error, meta, at);
      last.at = at; last.kind = kind; last.key = null; last.outcome = OUTCOME.REJECTED; last.warnings = [];
      return { ok: false, kind, label: spec ? spec.label : kind, outcome: OUTCOME.REJECTED,
        error: v.error, ledgerId, at };
    }
    if (!db) {
      counters.rejected++;
      counterOf(kind).rejected++;
      const error = { code: REJECT.NO_DB, field: '(db)', httpStatus: 503,
        reason: '接收服务未接库（装配问题，不是报文问题）—— 拒绝"假成功"' };
      if (logger) logger.error('[IF-A] 未接库：拒绝收下报文（避免静默假成功）');
      last.at = at; last.kind = kind; last.key = null; last.outcome = OUTCOME.REJECTED; last.warnings = [];
      return { ok: false, kind, label: spec.label, outcome: OUTCOME.REJECTED, error, ledgerId: null, at };
    }
    const warnings = [];
    let applied;
    try {
      checkAuthority(kind, v.value, warnings, at);
      applied = apply(kind, v.value, at, warnings);
    } catch (err) {
      counters.rejected++;
      counterOf(kind).rejected++;
      if (logger) logger.error(`[IF-A] ${spec.label} 处理失败：${err && err.stack ? err.stack : err}`);
      const error = { code: REJECT.DB_WRITE, field: '(db)', httpStatus: 500,
        reason: `处理失败：${err.message}` };
      return { ok: false, kind, label: spec.label, outcome: OUTCOME.REJECTED, error,
        ledgerId: recordReject(kind, error, meta, at), at };
    }
    let ledgerId = applied.ledgerId === null || applied.ledgerId === undefined ? null : applied.ledgerId;
    if (applied.outcome === OUTCOME.STORED) {
      counters.stored++;
      counterOf(kind).stored++;
      ledgerId = appendLedger({
        opType: kind === KIND.DISPATCH ? OP_TYPE.DISPATCH
          : kind === KIND.MATERIAL ? OP_TYPE.MATERIAL
            : kind === KIND.PROCESS ? OP_TYPE.PROCESS : OP_TYPE.DEVICE,
        result: '成功',
        content: kind === KIND.MATERIAL || kind === KIND.PROCESS
          ? applied.content                                   /* 留痕行本身就是业务记录（幂等键同一份文本） */
          : plainContent(receiptText(kind, v.value, applied, warnings))
      }, at, warnings);
    } else {
      counters.duplicate++;
      counterOf(kind).duplicate++;
    }
    last.at = at; last.kind = kind; last.key = applied.key; last.outcome = applied.outcome;
    last.warnings = warnings.map(w => w.code); last.ifa = valueOfKind(kind, v.value);
    return {
      ok: true, kind, label: spec.label, outcome: applied.outcome, key: applied.key,
      stored: applied.outcome === OUTCOME.STORED, table: applied.table, sig: applied.sig || null,
      warnings, unknown: v.unknown, ledgerId, at, idempotency: applied.idempotency,
      device: applied.device || null,
      /* 人可读的可见提示（把 warnings 拼成一句）：服务层调用方（不只 HTTP）也能直接读到，
         不必自己再拼一遍 —— 现场排查时"响应里有一句话"比"数组里有个码"更快。 */
      warning: warnings.length ? warnings.map(w => w.message).join('；') : null
    };
  }

  /** 报文里与"权威侧"有关的取值（供 `/ifa/status` 常显） */
  function valueOfKind(kind, value) {
    return {
      equipCode: value.equipCode || null,
      procOrderNo: value.procOrderNo || null,
      processNo: value.processNo || null
    };
  }

  /** 状态快照（`GET /ifa/status`；**访问控制的降级状态与权威侧冲突都在这里常显**） */
  function status() {
    let deviceRows = [];
    let ifaEquip = last.ifa && last.ifa.equipCode ? last.ifa.equipCode : null;
    if (db) {
      try {
        deviceRows = db.prepare('SELECT equip_code, equip_name, updated_at FROM device ORDER BY updated_at DESC').all();
      } catch { deviceRows = []; }
      if (!ifaEquip && deviceRows.length) ifaEquip = deviceRows[0].equip_code;
    }
    const local = localCode();
    const conflict = Boolean(local && ifaEquip && local !== ifaEquip);
    return {
      ok: true,
      mount: 'ifA',
      mounted: true,
      by: 'W2',
      kinds: Object.keys(SPECS).map(k => ({ kind: k, label: SPECS[k].label })),
      counts: Object.assign({}, counters, { byKind: counters.byKind }),
      last: Object.assign({}, last),
      auth: {
        enabled: auth.enabled, source: auth.source, degraded: auth.degraded, warning: auth.warning,
        header: auth.enabled ? 'Authorization: Bearer <token> 或 X-IF-Token: <token>' : null
      },
      authority: {
        equipCode: {
          authoritative: ifaEquip,
          source: ifaEquip ? 'IF-A（权威，FR-1.2 / IF-D.12）' : '（尚未收到 IF-A 的 equipCode）',
          localConfig: local || null,
          fallbackUsed: !ifaEquip && Boolean(local),
          conflict,
          deviceRows
        },
        procOrderNo: {
          source: 'IF-A（权威，C-102/FR-3.1～3.4）',
          last: last.ifa ? last.ifa.procOrderNo : null
        }
      },
      warnings: []
        .concat(auth.degraded ? [{ code: WARN.AUTH_DISABLED, message: auth.warning }] : [])
        .concat(conflict ? [{
          code: WARN.EQUIP_MISMATCH,
          message: `设备编号冲突：IF-A=${ifaEquip}，本机配置=${local}（已以 IF-A 为准，请修正本机配置）`
        }] : [])
    };
  }

  /* 挂载时的**可见告警**（W6「对外监听告警」同风格：warn 与 error 各一次，避免被淹没）：
     访问控制未配置 ⇒ 冻结不了功能（会挡住 MES 派工链路），但必须让人一眼看见"本机接口无鉴权"。 */
  if (logger && !auth.enabled) {
    logger.warn(`[⚠ IF-A 访问控制告警] ${auth.warning}`);
    logger.error(`[⚠ IF-A 访问控制告警] 对外暴露确认：来源=${auth.source}；` +
      '监听须保持仅本机/局域网（NFR-25 / AC-09），并尽快配置令牌（负责人 2026-09-27 裁定①）');
  }

  return {
    receive,
    authorize,
    validate: (kind, body) => validate(kind, body),
    status,
    auth,
    counters,
    db,
    /** 供自检注入用：当前本机兜底编号与 IF-D 快照取值 */
    localEquipCode: localCode,
    ifdSnapshot
  };
}

module.exports = {
  createDispatch,
  validate,
  resolveAuthConfig,
  readToken,
  stableJson,
  signatureOf,
  ledgerContent,
  defaultLocalEquipCode,
  defaultLocalEquipName,
  KIND,
  OUTCOME,
  REJECT,
  AUTH_CODE,
  WARN,
  OP_TYPE,
  SPECS,
  IDEMPOTENT_BASIS,
  TIME_RE
};
