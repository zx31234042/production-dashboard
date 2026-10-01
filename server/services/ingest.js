/* ==========================================================================
   IF-D 采集接入服务（server/services/ingest.js）—— W1（服务层第二笔 · 第 2 波）
   作用：把"上位机的一帧实时测量数据"变成**可校验、可去重、可落库、可观测**的一条链：
     ① 校验与拒收（**不得静默收脏数据**）：字段缺失 / 类型不符 / 时间非法（含毫秒与秒级两种
        输入）/ 取值域不合理 ⇒ 拒收 + 可读原因 + **不落库、不留半条**；
     ② 去重（DR-13）：主口径＝**四字段 equipCode + procOrderNo + collectTime + seq**；
        无 seq 时走**退路口径**（equipCode + procOrderNo + collectTime），并在返回值里
        **显式标注退路口径**（同时把跨工单误判风险一起带出来，不隐藏）；
     ③ 采样落库（ADR-0001 D7）：**1 s 采样落库、500 ms 原始帧不落库**
        （500 ms 帧只更新内存态，供实时显示；库里只留每秒一行）；
     ③b 判定挂钩（W5-② 接线技术债 E45）：落库成功后回调 `options.onSampled(frame)` ——
        这是"判定/预警产出"的**真实写入点**（`warning` 事件由此产生，见下"两条挂钩"注）；
        本文件**不自己判定**（判定口径的唯一实现在 `services/judge.js`），只负责"在正确的时刻叫一次"；
     ④ 断连状态（FR-2.6 / IF-D.9）：维护"最近一次收到**有效帧**的时刻"，
        `linkState()` / `status()` 按 `board.config.js` 的 `upper.staleMs`（缺省 5000 ms）
        给出 在线正常 / 离线断连，供 `/health` 或后续端点读取（**本包不改 SSE、不改前端**）。
   入站形态（两种都支持 —— **"谁主动"未定，见下**）：
     · ① 看板轮询取数：`createPoller()` —— 看板服务端作为 HTTP **客户端**去 `CFG.upper.url`
         拉一帧（口径参考 `src/services/api.js:253-255` 的既有轮询：GET + 可选 Bearer +
         `timeoutMs` 超时）；默认**不自动启动**（`enabled` 为 false），也不在本包接线。
     · ② 上位机推送：`createPushHandler()` —— 接收 HTTP POST 帧（真实形态，见
         `server/http/routes/ifD.js` 的 `POST /ifd/frame`）。
     两者**共用同一个入口** `ingestFrame(frame)`：形态只是"帧从哪来"，校验/去重/落库口径只有一份。
   ⚠ **形态不确定性（U-0.1 / Q-21 / IF-D.7 未答复）**：需求只说"传输方式待定：建议上位机主动
     推送 HTTP POST（JSON）或 WebSocket 长连接；接口规范需由上位机方提供"。故本文件把两种形态
     都做成**可插拔的 source 接口**、默认都处于"已实现但未启用"的状态：谁先被启用只影响
     `server/http/routes/ifD.js` 的一处状态声明，不影响 ingest 的任何口径。真实形态、字段名、
     鉴权、地址待答复后回填（Q-21 / U-0.1）。
   去重口径的选择（**读原文后决定，理由见下**）：
     DR-13 原文："同一去重键的重复帧按**幂等 / 后到覆盖先到**处理、不产生第二条记录"；
     并注明"**库层唯一索引暂不加 seq 列**（现行 1 s 采样落库下同秒仅一行，见 ADR-0001 D7）"。
     本实现选 **幂等**：重复帧**不产生第二行、也不改写既有行**。依据有三
       a) 落库调用链 `server/repo/measure.js:insertFrame()` 用的是
          `INSERT OR IGNORE` + 库层唯一索引 `ux_measure_rt(equip_code, proc_order_no, collect_time)`；
       b) 职责边界（`server/repo/measure.js` 文件头）："只做 SQL，不做业务判断"；
       c) 本包**不得改** `server/repo/*`，故"后到覆盖"需要另写一条 `UPDATE` 路径 ——
          那等于在库的唯一索引之外**另起第二套去重真源**，正是任务书明令禁止的。
     故本实现**只报告库层的真实结果**（inserted=false），不自行改写；同秒多帧（seq 不同、
     collect_time 同）由"1 s 采样"这条口径先行拦下（见 ②/③），不会把 500 ms 原始帧顶掉采样帧。
   落库表与字段（依据 ADR-0001 D7 + `server/db/schema.sql` 的 DR-04 建表段）：
     表 `measure_rt`；写入字段＝`equip_code, proc_order_no, unit_index, measure_depth(depth), speed,
     velocity_x, velocity_y, frame_rate, gain, shutter, camera_depth, test_status, collect_time,
     created_at`。**`seq` 不落库**——schema 与唯一索引都没有该列（C-101④ 明示"本次不加列"）。
     `unit_index`（V1.41 / C-111）：＝`IF-D.4` 的 `unitIndex`，**采集落库时写入**；帧未带或非法
     （非整数、< 1）⇒ 写 **NULL** 并计入 `status().frameUnitIndex.withoutIndex`（**不整帧拒收**：
     实测数据本身有效）。它使 `FR-4.2` 的"开工数"能按**件**计（`FR-4.3` 的减数与被减数同单位，E69）。
   依赖：`server/repo/measure.js`（SQL，唯一落库出口）、`platform/clock.js`（时间注入与格式）、
        `src/config/board.config.js`（`upper.staleMs` 等参数真源）。**零第三方依赖。**
   用法：
     const { createIngest } = require('./services/ingest');
     const ingest = createIngest({ db, logger, now: clock.source() });
     const r = ingest.ingestFrame(frame);     // → { outcome:'stored'|'duplicate'|'raw-500ms'|'rejected', … }
     ingest.ingestFrame(frame);               // 同一四字段键重复送 ⇒ outcome='duplicate'，库中仍一行
     ingest.linkState();                      // → 'online' | 'offline'（FR-2.6，≤5 s）
   ========================================================================== */
'use strict';

/* W5-② 接线技术债 E45 的两条挂钩（都挂在**同一条写入点**上，先后有序 —— 先有事实、再有通知）：
     `bus.publish(EVENT_KIND.FRAME, sampled)`   帧推送（W5-① 起就有，"1 s 采样落库"那条帧）；
     `onSampled(sampled)`                       判定挂钩（本波接线）：装配方在回调里调
                                                 `judge.evaluate(input,{bus})`，`warning` 事件由此发布。
   本文件**不自己判定**（判定口径的唯一实现在 `services/judge.js`），只负责"在正确的时刻叫一次"。 */

const measureRepo = require('../repo/measure');
const platformClock = require('../../platform/clock');
const boardConfig = require('../../src/config/board.config.js');
const { KIND: EVENT_KIND } = require('./eventBus');

/* ---------------- 一、契约常量（全部可从配置/需求原文追到出处） ---------------- */

/** DR-16 落库/显示精度：秒级 `yyyy-MM-dd HH:mm:ss`（恰好 19 字符） */
const COLLECT_TIME_SEC_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
/** DR-16 的**接收侧**补充半句（V1.38 / C-101③）："接收侧可携带**毫秒级**采集时刻用于去重，
 *  显示与落库维持秒级" ⇒ 毫秒形态也**合法**（1～3 位小数），只是落库前截断到秒。 */
const COLLECT_TIME_MS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{1,3})$/;

/** 帧字段名（与需求 IF-D.1 / 附录 2 / `tests/lib/fixture.js` 的报文契约一致）。
 *  为什么**不** require `src/config/fieldMap.js`：该文件是**浏览器侧**模块
 *  （`window.FieldMap = …`），Node 下 `window` 未定义会直接抛错；故此处按已确认的报文键名
 *  照抄一份**字段清单**（不是映射逻辑），映射真源仍在 fieldMap.js，Q-21 答复后只改那边 + 这里。 */
const FIELD = Object.freeze({
  equipCode: 'equipCode',
  procOrderNo: 'procOrderNo',
  collectTime: 'collectTime',
  seq: 'seq',
  depth: 'depth',
  speed: 'speed',
  velocityX: 'velocity_x',
  velocityY: 'velocity_y',
  frameRate: 'frameRate',
  gain: 'gain',
  shutter: 'shutter',
  cameraDepth: 'cameraDepth',
  testStatus: 'testStatus',
  /* V1.41 / C-111：`IF-D.4` 的件序号（落 `measure_rt.unit_index`）。字段名沿用
     `src\config\fieldMap.js` 的既有映射（`'task.unitIndex' → key: 'unitIndex'`），真实字段名与
     取值域待 `Q-21` 答复后只改两处（那边＋本常量）。 */
  unitIndex: 'unitIndex'
});

/** **必填**字段（三件：去重主口径的键成分 + 值域校验的锚）。
 *  为什么恰好是这三个：DR-13 四级键里 `seq` 可缺（有退路口径）、`procOrderNo`/`collectTime`/
 *  `equipCode` 缺任何一个就**无法形成去重键** ⇒ 拒收；深度/速度等实测量允许缺测
 *  （`server/services/judge.js` 对缺测判 `idle`，属正常业务态，不是脏数据）。 */
const REQUIRED_FIELDS = Object.freeze([FIELD.equipCode, FIELD.procOrderNo, FIELD.collectTime]);

/** UI-08（附录 2 相邻条款）明示的量程：帧率 0～1200 fps **整型**、增益 1 位小数、快门整型。 */
const FPS_MIN = 0;
const FPS_MAX = 1200;
/** 显示/录入精度真源＝配置 `standards.digits`（现值 2）—— 深度的两位小数口径由它而来 */
const STD_DIGITS = (boardConfig.standards && typeof boardConfig.standards.digits === 'number')
  ? boardConfig.standards.digits : 2;
/** 增益精度（UI-08 明示 1 位小数） */
const GAIN_DIGITS = 1;

/** 物理/工程**合理带**（拒收判据的兜底）。
 *  口径说明（**有意与"测试标准上下限"分开**）：`board.config.js` 的 `standards.range`
 *  （深度 4.00～6.00 m / 速度 3.00～8.00 m/s）是**判定**用的量程 —— 实测超范围要**判红并留证**
 *  （FR-3.14 三态），**绝不能在这里拒收**，否则"超范围"这条业务态会被采集口吃掉、判定引擎再也看不到。
 *  故此处只拦**物理上不可能/明显失真**的值，阈值集中在本表、不散落字面量。 */
const PLAUSIBLE = Object.freeze({
  depth: { min: 0, max: 1000 },
  speed: { min: 0, max: 200 },
  velocity: { min: -200, max: 200 },
  cameraDepth: { min: 0, max: 1000 },
  gain: { min: 0, max: 100 },
  shutter: { min: 1, max: 10000000 }
});

/** testStatus 取值域（V1.37 / C-98①：附录 2 的代码语义，0～3；「维保检修」无对应码）。 */
const TEST_STATUS_VALUES = Object.freeze([0, 1, 2, 3]);

/** 拒收原因码（机器可读，稳定字符串；回执与 HTTP 响应都用它） */
const REJECT = Object.freeze({
  NOT_OBJECT: 'FRAME_NOT_OBJECT',
  MISSING_FIELD: 'MISSING_FIELD',
  BAD_TYPE: 'BAD_TYPE',
  BAD_TIME: 'BAD_COLLECT_TIME',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  BAD_STATUS: 'BAD_TEST_STATUS',
  IDENTITY_MISMATCH: 'EQUIP_CODE_MISMATCH'
});

/** 结果种类（`ingestFrame()` 的 `outcome`） */
const OUTCOME = Object.freeze({
  STORED: 'stored',
  DUPLICATE: 'duplicate',
  RAW_500MS: 'raw-500ms',
  REJECTED: 'rejected'
});

/** 链路状态监控的缺省轮询周期（毫秒）。
 *  为什么 1 s：断连阈值是 `upper.staleMs`（缺省 5000 ms），1 s 轮询 ⇒ 跨过阈值后 ≤1 s 内发布
 *  `link` 事件，满足 FR-2.6 的"≤5 s 可察觉"。**阈值本身不在这里**（真源仍是 `linkState()`）。 */
const DEFAULT_LINK_INTERVAL_MS = 1000;

/** 去重口径标记（DR-13 主口径 / 退路口径 —— 返回值里**必须**带，不得隐藏） */
const DEDUP = Object.freeze({
  PRIMARY: 'primary-4field',
  FALLBACK: 'fallback-3field'
});

/* ---------------- 二、小工具 ---------------- */

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = v => Number.isInteger(v);

/** 缺测判定：`undefined` 与 `null` 都算"这一帧没有这个字段" */
const isAbsent = v => v === undefined || v === null;

/** 两位/一位小数的"超精度"判定：容许 IEEE754 极小误差，但 12.345（深度）这类必须拒。
 *  判据＝`|v - round(v, d)| > 1e-9`。 */
function hasTooManyDecimals(v, digits) {
  const r = Math.pow(10, digits);
  return Math.abs(v - Math.round(v * r) / r) > 1e-9;
}

/**
 * 解析并校验采集时间（DR-16 + C-101③）。
 * 接受两种**输入**：秒级 `yyyy-MM-dd HH:mm:ss`、毫秒级 `yyyy-MM-dd HH:mm:ss.SSS`（1～3 位小数）；
 * 其余（带 `T`、斜杠、缺秒、空串、数字、非法月日）一律拒收。
 * @returns {{ok:true, sec:string, ms:number, raw:string}|{ok:false, reason:string}}
 *   `sec` 恰好 19 字符 —— 落库口 `server/repo/measure.js` 的 `assertCollectTime` 认的就是它。
 */
function parseCollectTime(value) {
  if (typeof value !== 'string') {
    return { ok: false, reason: `collectTime 必须是字符串（DR-16），收到 ${JSON.stringify(value)}（${typeof value}）` };
  }
  let m = COLLECT_TIME_MS_RE.exec(value);
  let ms = 0;
  if (m) {
    /* 毫秒位补零到 3 位：'.5' 是 500 ms、'.05' 是 50 ms（左对齐补齐，不是右对齐） */
    ms = Number(m[7].padEnd(3, '0'));
  } else {
    m = COLLECT_TIME_SEC_RE.exec(value);
    if (!m) {
      return { ok: false, reason: `collectTime 必须是「yyyy-MM-dd HH:mm:ss」或带毫秒的 ` +
        `「yyyy-MM-dd HH:mm:ss.SSS」（DR-16 / C-101③），收到 ${JSON.stringify(value)}` };
    }
  }
  /* ⚠ 变量名**不得**用 `mi`/`d` 这类两位名去接分组：本文件顶部已 import 了 `node:http`，
     在 `'use strict'` 下把 `mi` 重新 `const` 一遍会在**声明处**直接抛
     `SyntaxError: Identifier 'mi' has already been declared`（整个模块加载失败）。
     故分组一律用具名 `const` 逐个取。 */
  const yy = Number(m[1]);
  const mo = Number(m[2]);
  const dd = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = Number(m[6]);
  /* 先做**范围**判定：SQLite 与 DR-16 都是"文本比较"，一个 `2026-13-45` 会让按时间排序/取最旧全部失真；
     且 `new Date(2026,12,45)` 会被 JS 静默进位，只判 `Number.isNaN` 抓不到，故范围必须先拦。 */
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mm > 59 || ss > 59 || ms > 999) {
    return { ok: false, reason: `collectTime 不是真实存在的时刻（月/日/时/分/秒越界）：${JSON.stringify(value)}` };
  }
  const dt = new Date(yy, mo - 1, dd, hh, mm, ss, ms);
  /* 再回读比对：拦住"月内天数越界"（如 2026-02-30）这类范围检查抓不到、但 Date 会进位的值。 */
  if (dt.getFullYear() !== yy || dt.getMonth() !== mo - 1 || dt.getDate() !== dd ||
    dt.getHours() !== hh || dt.getMinutes() !== mm || dt.getSeconds() !== ss) {
    return { ok: false, reason: `collectTime 不是真实存在的时刻（该月无此日）：${JSON.stringify(value)}` };
  }
  return { ok: true, sec: platformClock.fmt(dt), ms, raw: value };
}

/**
 * 解析件序号（`IF-D.4` 的 `unitIndex` → `measure_rt.unit_index`；V1.41 / C-111 ＋ 技术债 `E69`）。
 *
 * **纯函数**：不读库、不取时间、不改入参。**绝不抛错、绝不改判整帧** —— 件序号缺失或非法
 * **不是**帧的错（实测数据本身有效），故这里只回答"这一帧的件序号拿不拿得到"，由调用方决定
 * "拿不到就写 NULL 并计数"。
 * 判据（与 `server/index.js` 的 `unitIndexOf()` 同一口径，两处读的是**同一帧的同一个字段**，
 * 不许一个收下、另一个判"拿不到"）：
 *   · `undefined` / `null` / `''`            ⇒ `{ok:false, reason:'absent'}`（帧没带）
 *   · 整数且 ≥ 1                             ⇒ `{ok:true, value}`（**归一为数字**）
 *   · 纯数字字符串（如 `'3'`，上位机常把序号序列化成字符串）⇒ 收下并归一为数字
 *   · 其余（`0` / 负数 / 小数 / `'abc'` / 布尔 / 对象 / 超安全整数）⇒ `{ok:false, reason:'invalid'}`
 * **为什么合法值不写 0**：`unit_index` 是"这一帧测的是哪一件"的事实，"拿不到"与"真的是第 0 件"
 * 是两件事 —— 用 0/1 代言会把一票多件静默归并成一件（`server/index.js` 的 `unitIndexOf()` 注释
 * 记着这条实测后果：10 帧 ⇒ `result` 只 1 行、落后率恒 ≈90.9%）。
 * @param {any} raw 帧里的件序号原值
 * @returns {{ok:true, value:number}|{ok:false, reason:'absent'|'invalid'}}
 */
function parseUnitIndex(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: false, reason: 'absent' };
  const n = (typeof raw === 'string' && /^\d+$/.test(raw.trim())) ? Number(raw.trim()) : raw;
  if (isInt(n) && Number.isSafeInteger(n) && n >= 1) return { ok: true, value: n };
  return { ok: false, reason: 'invalid' };
}

/**
 * 校验单个**可缺**数值字段：缺 ⇒ 跳过；类型/精度/量程不符 ⇒ 返回原因。
 * 判据顺序**固定**为 类型 → 整型 → 精度 → 量程：`depth: '5.00'` 必须报"类型错"而不是"超量程"
 * （否则现场会照着"量程"去改数据，而真正的问题是报文把数字序列化成了字符串）。
 * @returns {{field:string, code:string, reason:string}|null} null = 通过
 */
function checkNumField(frame, name, opts) {
  const v = frame[name];
  if (isAbsent(v)) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { field: name, code: REJECT.BAD_TYPE,
      reason: `${name} 必须是有限数值（JSON 数字），收到 ${JSON.stringify(v)}（${typeof v}）` };
  }
  if (opts.integer && !isInt(v)) {
    return { field: name, code: REJECT.BAD_TYPE, reason: `${name} 必须是整型（UI-08），收到 ${JSON.stringify(v)}` };
  }
  if (!opts.integer && opts.digits !== undefined && hasTooManyDecimals(v, opts.digits)) {
    return { field: name, code: REJECT.OUT_OF_RANGE,
      reason: `${name} 小数位超出 UI-08 精度（最多 ${opts.digits} 位），收到 ${JSON.stringify(v)}` };
  }
  if (v < opts.min || v > opts.max) {
    return { field: name, code: REJECT.OUT_OF_RANGE,
      reason: `${name} 超出合理取值域 [${opts.min}, ${opts.max}]（UI-08 量程 / 工程合理带），收到 ${JSON.stringify(v)}` };
  }
  return null;
}

/* ---------------- 三、校验（纯函数，导出以便单测） ---------------- */

/**
 * 校验一帧。**纯函数**：不读库、不取时间、不改入参。
 * @param {any} frame 上位机报文（扁平对象；IF-D 的字段名见 FIELD）
 * @param {{equipCode?:string, enforceEquipCode?:boolean}} [options]
 *        `enforceEquipCode === true` 且给出 `equipCode` 时做**一致性**校验。
 *        ⚠ **缺省为 false**（不做一致性拒收），依据 IF-D.12 原文：
 *          "**上位机报文若携带 equipCode 则原样使用、不自行编号**；不携带则由看板按 IF-A / 本机配置补齐"，
 *          且"两者不一致时**以 IF-A 为准并给出可见提示**" —— 可见提示属 IF-A 包（W2）的职责，
 *          采集口把它当**拒收**理由会直接丢掉真实测量数据（配置号与 MES 号不一致是**配置问题**，
 *          不是帧脏）。故本包只在 `enforceEquipCode` 显式打开时才拒收（留给后续包决定）。
 * @returns {{ok:true, frame:object, collectTimeSec:string, collectMs:number, seq:number|null}
 *          |{ok:false, code:string, field:string, reason:string}}
 */
function validateFrame(frame, options = {}) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    return { ok: false, code: REJECT.NOT_OBJECT, field: '(frame)',
      reason: `帧必须是对象（JSON 对象），收到 ${Array.isArray(frame) ? 'array' : JSON.stringify(frame)}` };
  }

  /* ① 必填三件：缺一即拒 —— 否则形不成 DR-13 的去重键（见 REQUIRED_FIELDS 的注释） */
  for (const name of REQUIRED_FIELDS) {
    const v = frame[name];
    if (isAbsent(v)) {
      return { ok: false, code: REJECT.MISSING_FIELD, field: name,
        reason: `缺少必填字段 ${name}（DR-13 去重键成分，缺它无法去重；IF-D.1 / IF-D.12）` };
    }
    if (typeof v !== 'string' || v.trim() === '') {
      return { ok: false, code: REJECT.BAD_TYPE, field: name,
        reason: `${name} 必须是非空字符串，收到 ${JSON.stringify(v)}（${typeof v}）` };
    }
  }

  /* ② 采集时间：秒级/毫秒级都收，非法即拒（含毫秒的**真实存在性**校验） */
  const t = parseCollectTime(frame[FIELD.collectTime]);
  if (!t.ok) {
    return { ok: false, code: REJECT.BAD_TIME, field: FIELD.collectTime, reason: t.reason };
  }

  /* ③ 序号 seq（DR-13 主口径的第四字段）：缺 ⇒ 记 null（走退路口径，**不是**拒收）；
     给了就必须是**非负整数**（数字，或纯数字字符串 —— 上位机常把序号序列化成字符串，收下并归一）。 */
  let seq = null;
  const rawSeq = frame[FIELD.seq];
  if (!isAbsent(rawSeq)) {
    if (isInt(rawSeq) && rawSeq >= 0) {
      seq = rawSeq;
    } else if (typeof rawSeq === 'string' && /^\d+$/.test(rawSeq.trim())) {
      seq = Number(rawSeq.trim());
      if (!Number.isSafeInteger(seq)) {
        return { ok: false, code: REJECT.OUT_OF_RANGE, field: FIELD.seq,
          reason: `seq 超出安全整数范围：${JSON.stringify(rawSeq)}` };
      }
    } else {
      return { ok: false, code: REJECT.BAD_TYPE, field: FIELD.seq,
        reason: `seq 必须是非负整数（DR-13 帧级序号），收到 ${JSON.stringify(rawSeq)}（${typeof rawSeq}）` };
    }
  }

  /* ④ 设备编号一致性：**默认不做**（见 validateFrame 的 docblock：IF-D.12 要求"原样使用 +
     不一致时以 IF-A 为准并给出可见提示"，拒收会丢真实数据）。仅在调用方显式打开时才拦。 */
  if (options.enforceEquipCode === true && options.equipCode !== undefined && options.equipCode !== null &&
    options.equipCode !== '' && frame[FIELD.equipCode] !== options.equipCode) {
    return { ok: false, code: REJECT.IDENTITY_MISMATCH, field: FIELD.equipCode,
      reason: `equipCode 与本机配置不一致：收到 ${JSON.stringify(frame[FIELD.equipCode])}，` +
        `期望 ${JSON.stringify(options.equipCode)}（IF-D.12；默认按"原样使用"，本判据需显式开启）` };
  }

  /* ⑤ 实测量：类型 + 精度 + 合理带（UI-08）。缺测**不是**脏数据（判定层会判 idle），故缺 ⇒ 跳过。 */
  const PROBLEMS = [
    checkNumField(frame, FIELD.depth, { min: PLAUSIBLE.depth.min, max: PLAUSIBLE.depth.max, digits: STD_DIGITS }),
    checkNumField(frame, FIELD.speed, { min: PLAUSIBLE.speed.min, max: PLAUSIBLE.speed.max, digits: STD_DIGITS }),
    checkNumField(frame, FIELD.velocityX, { min: PLAUSIBLE.velocity.min, max: PLAUSIBLE.velocity.max, digits: STD_DIGITS }),
    checkNumField(frame, FIELD.velocityY, { min: PLAUSIBLE.velocity.min, max: PLAUSIBLE.velocity.max, digits: STD_DIGITS }),
    checkNumField(frame, FIELD.cameraDepth, { min: PLAUSIBLE.cameraDepth.min, max: PLAUSIBLE.cameraDepth.max, digits: STD_DIGITS }),
    checkNumField(frame, FIELD.frameRate, { min: FPS_MIN, max: FPS_MAX, integer: true }),
    checkNumField(frame, FIELD.gain, { min: PLAUSIBLE.gain.min, max: PLAUSIBLE.gain.max, digits: GAIN_DIGITS }),
    checkNumField(frame, FIELD.shutter, { min: PLAUSIBLE.shutter.min, max: PLAUSIBLE.shutter.max, integer: true })
  ].filter(Boolean);
  if (PROBLEMS.length) {
    return { ok: false, code: PROBLEMS[0].code, field: PROBLEMS[0].field,
      reason: PROBLEMS.map(p => p.reason).join('；') };
  }

  /* ⑥ testStatus 码值域（附录 2：0 待机 / 1 测试中 / 2 测试完成 / 3 设备异常） */
  const st = frame[FIELD.testStatus];
  if (!isAbsent(st)) {
    if (!isInt(st)) {
      return { ok: false, code: REJECT.BAD_TYPE, field: FIELD.testStatus,
        reason: `testStatus 必须是整型状态码，收到 ${JSON.stringify(st)}（${typeof st}）` };
    }
    if (!TEST_STATUS_VALUES.includes(st)) {
      return { ok: false, code: REJECT.BAD_STATUS, field: FIELD.testStatus,
        reason: `testStatus 不在附录 2 的取值域 [${TEST_STATUS_VALUES.join(', ')}] 内，收到 ${st}` };
    }
  }

  /* ⑦ 件序号 `unitIndex`（V1.41 / C-111）：**有意不在这里校验、更不拒收** ——
     负责人 2026-09-30 裁定②：非法件序号（非整数、< 1）**不整帧拒收**（实测数据本身有效），
     按"**未提供**"处理（写 NULL ＋ 计入 `state.frameUnitIndex.withoutIndex`）。
     理由：件序号是 `IF-D.4` 的**附加**字段（真实字段名与取值域待 `Q-21`），把它当必填会因
     "上位机还没回填该字段"而丢掉真实测量数据 —— 那正是本仓反复禁止的"把配置/接口问题
     当成帧脏"。解析在 `parseUnitIndex()`，落库在 `ingestFrame()` 的 ③ 段。 */

  return {
    ok: true,
    frame,
    collectTimeSec: t.sec,
    collectMs: t.ms,
    seq
  };
}

/* ---------------- 四、服务实例 ---------------- */

/**
 * 把"校验通过的帧"归一成**推送载荷**（形状＝上位机 `upper` 报文，前端 `applyUpperPayload()` 直接可消费）。
 * 为什么复用原报文键名而不另造一套：IF-D 的字段名已是三方契约（`src/config/fieldMap.js` 的
 * `upperToBoard` key），再造一套字段名会让前端切源时冒出第二份映射表（P2-4 那类"两份实现"）。
 * 这里只做**两处归一**：① `collectTime` 归一到秒级（落库/去重口径，DR-16）；
 * ② `seq` 归一为数字（原始报文常见把序号序列化成字符串）。
 * 缺测字段**不编造**（保持缺省，JSON 序列化时自然省略）——与上位机报文同语义。
 * @param {{frame:object, collectTimeSec:string, seq:number|null}} v `validateFrame()` 的通过结果
 * @returns {object} 推送载荷（键名与 `upper` 报文一致）
 */
function framePayloadOf(v) {
  const payload = Object.assign({}, v.frame, { collectTime: v.collectTimeSec });
  if (v.seq === null) delete payload[FIELD.seq];
  else payload[FIELD.seq] = v.seq;
  return payload;
}

/** 取 `upper.staleMs`（FR-2.6 的"断连 ≤5 s"阈值真源＝`board.config.js`）；非法即抛，不静默兜底 */
function resolveStaleMs(options) {
  const injected = options.staleMs;
  if (injected !== undefined) {
    if (!isNum(injected) || injected <= 0) {
      throw new TypeError(`ingest: staleMs 必须是正数，收到 ${JSON.stringify(injected)}`);
    }
    return injected;
  }
  const fromCfg = boardConfig.upper ? boardConfig.upper.staleMs : undefined;
  if (!isNum(fromCfg) || fromCfg <= 0) {
    throw new TypeError('ingest: 断连阈值只能来自配置真源 board.config.js 的 upper.staleMs（现取值非法）');
  }
  return fromCfg;
}

/**
 * 创建 IF-D 采集接入服务。
 * @param {object} options
 *   @param {object}   options.db             SQLite 句柄（`server/db` 打开的库）；无库时 ingestFrame 一律拒收
 *   @param {Function|Date} [options.now]     时钟注入（推荐 `platform/clock.js` 的 `clock.source()`，ADR-0003 D17）
 *   @param {object}   [options.logger]       日志器（platform/log.js 的 createLogger 产物）；不传则不写日志
 *   @param {number}   [options.staleMs]      断连阈值覆盖（缺省＝配置真源 `upper.staleMs`）
 *   @param {string}   [options.equipCode]    期望设备编号（给了则对帧内 equipCode 做一致性校验）
 *   @param {object}   [options.upper]        轮询取数参数（`{url, auth, timeoutMs}`；缺省读配置 `upper`）
 *   @param {Function} [options.fetchImpl]    fetch 实现（缺省 globalThis.fetch；自检可注入假 fetch）
 *   @param {Function} [options.setIntervalImpl] / [options.clearIntervalImpl] 定时器注入（自检用）
 *   @param {Function} [options.onSampled]    判定挂钩（W5-② / E45）：`onSampled(sampledFrame)` 在
 *        **1 s 采样落库成功之后**回调一次（与 `frame` 事件同一写入点）；装配方在回调里调
 *        `judge.evaluate(input,{bus})` 以发布 `warning` 事件。缺省不回调（行为与 W1 一致）。
 * @returns {object} 采集服务实例
 */
function createIngest(options = {}) {
  const db = options.db || null;
  if (db && typeof db.prepare !== 'function') {
    throw new TypeError('ingest: options.db 传了但不是 SQLite 句柄');
  }
  const logger = options.logger || null;
  /* W5-① 事件总线（可选注入）：`frame` 事件只挂在**1 s 采样落库**的那条帧上（见 ingestFrame 的 ④）。
     不注入 ⇒ 行为与 W1 完全一致（本包不因此改变任何落库/去重口径）。 */
  const bus = options.bus || null;
  if (bus && typeof bus.publish !== 'function') {
    throw new TypeError('ingest: options.bus 传了但不是事件总线（缺 publish）——见 services/eventBus.js');
  }
  /* W5-② 判定挂钩（可选注入，接线技术债 E45）：`onSampled(sampledFrame)` 只在"**1 s 采样落库成功**"
     那条帧上回调一次（与 `frame` 事件**同一写入点**、紧随其后）。
     为什么做成注入回调而不是在本文件里直接 require judge 并发布：
       · 判定要读**标准真源**（`standard` 表按"产品＋工序＋指定时刻生效版本"）与派生量，属**业务装配**
         （谁装配服务谁决定判定输入从哪来）—— ingest 的职责是"帧进得来、脏的挡得住、采样落得下"；
       · 注入方式是 `createPoller` 的 `cfg.onResult`、`uploadReporter` 的 `fetch` 同一惯例（零新机制）；
       · 回调抛错**不得**影响落库与帧推送（落库是事实，判定是派生），故下方 try/catch 只计数 + 记日志。 */
  const onSampled = options.onSampled || null;
  if (onSampled !== null && typeof onSampled !== 'function') {
    throw new TypeError('ingest: options.onSampled 必须是函数（判定挂钩，见 services/judge.js 的 evaluate）');
  }
  const staleMs = resolveStaleMs(options);
  /* 期望设备编号：默认＝配置真源 `device.equipCode`（仅用于**报告与显式开启的**一致性校验）；
     是否真的据此拒收由 `enforceEquipCode` 决定，缺省 false（理由见 validateFrame 的 docblock）。 */
  const expectedEquip = options.equipCode === undefined
    ? ((boardConfig.device && boardConfig.device.equipCode) || undefined)
    : options.equipCode;
  const enforceEquipCode = options.enforceEquipCode === true;
  /** 组装 validateFrame 的选项（一致性校验只在显式开启时生效） */
  const validateOpts = () => (enforceEquipCode && expectedEquip
    ? { equipCode: expectedEquip, enforceEquipCode: true } : {});
  const upperCfg = options.upper || (boardConfig.upper || {});
  const fetchImpl = options.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  const setIntervalImpl = options.setIntervalImpl || setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || clearInterval;

  /* 取"现在"：**必须有注入出口**（ADR-0003 D17：业务代码不得直接读系统时间参与逻辑）。
     缺省兜底与 `server/services/uploadQueue.js` 同款写在同一行，便于门禁按行识别。 */
  const nowFn = () => {
    const injected = (options && options.now) || new Date();
    return typeof injected === 'function' ? injected() : injected;
  };

  /** 运行态（**唯一的真源**：断连判据与 1 s 采样去重都只看它） */
  const state = {
    receivedFrames: 0,          // 收到的帧总数（含脏帧）
    acceptedFrames: 0,          // 通过校验的帧数（＝"有效帧"）
    storedFrames: 0,            // 真正落库成功的行数（`inserted=true`）
    duplicateFrames: 0,         // 被幂等去重拦下的帧数
    rawFramesInMemory: 0,       // 500 ms 原始帧（**只进内存、不落库**，ADR-0001 D7）
    rejectedFrames: 0,          // 被拒收的帧数
    lastReject: null,           // 最近一次拒收（code/field/reason/at）—— 现场排查用
    lastAcceptedAt: null,       // 最近一次收到**有效帧**的时刻（毫秒时间戳）→ FR-2.6 断连判据
    lastAcceptedMs: null,       // 最近一次有效帧的 collectTime 毫秒位（用于诊断同秒抖动）
    lastCollectTime: null,      // 最近一次有效帧的采集时刻（秒级文本）
    lastStoredSecond: null,     // 最近一次**落库**的那一秒（1 s 采样去重：同一秒不再落第二行）
    lastStoredKey: null,        // 最近一次落库的四/三字段键（诊断与幂等证据）
    lastFrame: null,            // 最近一帧有效报文（**内存态**，供实时显示；500 ms 帧也更新它）
    lastSampledFrame: null,     // 最近一帧**1 s 采样落库**的帧（W5 快照用；500 ms 原始帧不更新它）
    /* 件序号可观测性（V1.41 / C-111 ＋ 技术债 E69，与 E58 同精神）：
       `FR-4.2` 的"开工数"**按件计**（判据＝该件在 `measure_rt` 有采样数据、以 `unit_index` 区分）
       ⇒ 帧**不带件序号**时开工数会算成 **0**。故必须能区分两种"0"：
         · `withoutIndex` —— 落库的帧里**没有**件序号的条数（开工数为 0 **可能只是帧没带**）；
         · `withIndex`    —— 落库的帧里**带了**合法件序号的条数。
       计数口径＝**真正落库（`stored`）的那一帧**：重复帧 / 500 ms 原始帧 / 被拒收帧都不是库里的行，
       不计入 ⇒ 恒有 `withIndex + withoutIndex === counts.stored`（探针据此交叉核对，防"计数漂移"）。
       **绝不用 0 代言"拿不到"**。 */
    frameUnitIndex: { withIndex: 0, withoutIndex: 0 }
  };

  /** 判定挂钩（`onSampled`）的可观测性：回调抛错的次数与最后一次原因。
   *  为什么单独记：回调是**派生**动作，失败不得影响落库，但"悄悄不判定了"必须看得见（否则又回到
   *  "写了机制 ≠ 机制在跑"那类事故）。`stats()` / `status()` 里都如实给出。 */
  const hookState = { sampledHookFailures: 0, lastSampledHookError: null };

  /** L1 采样去重（**同秒只留第一帧**）＝"500 ms 原始帧不落库"的落地判据。
   *  为什么这么判：DR-13 的 `collectTime` 是**秒级**（附录 2 / UI-08 / DR-16）而 IF-D.8 的测试
   *  过程推送是 100～500 ms ⇒ 同一秒会来 2～10 帧。这正是 C-101 引入 `seq` 的原因；
   *  而在"库里同秒只有一行"（ADR-0001 D7）的既定口径下，同一秒的**后到帧不落库**。 */
  function isSameStoredSecond(sec) {
    return state.lastStoredSecond !== null && sec <= state.lastStoredSecond;
  }

  const ingest = {
    /** 只读的配置快照（自检与运维可读） */
    config: Object.freeze({
      staleMs,
      equipCode: expectedEquip,
      enforceEquipCode,
      dedupPrimary: DEDUP.PRIMARY,
      dedupFallback: DEDUP.FALLBACK,
      pollerUrl: upperCfg.url || '',
      pollerEnabled: false          // ①轮询形态：**默认未启用**（形态待 U-0.1 答复）
    }),

    /**
     * **唯一入口**：处理一帧（两种入站形态共用）。
     * @param {object} frame 上位机报文（扁平 JSON 对象）
     * @returns {{outcome:string, stored:boolean, collectTime:string|null, collectMs:number|null,
     *            seq:number|null, dedup:{basis:string, key:string|null, fallback:boolean, risk:string|null},
     *            error:{code:string, field:string, reason:string}|null, at:string}}
     */
    ingestFrame(frame) {
      const atMs = nowFn().getTime();
      state.receivedFrames++;

      /* ---- ① 校验：挡在落库之前（**不留半条**——下面没有任何"先写再校验"的路径） ---- */
      const v = validateFrame(frame, validateOpts());
      if (!v.ok) {
        state.rejectedFrames++;
        state.lastReject = { code: v.code, field: v.field, reason: v.reason, at: platformClock.fmt(new Date(atMs)) };
        if (logger) logger.warn('[IF-D] 帧被拒收（未落库）', { code: v.code, field: v.field, reason: v.reason });
        return {
          outcome: OUTCOME.REJECTED, stored: false,
          collectTime: null, collectMs: null, seq: null,
          dedup: { basis: DEDUP.PRIMARY, key: null, fallback: false, risk: null },
          error: { code: v.code, field: v.field, reason: v.reason },
          at: platformClock.fmt(new Date(atMs))
        };
      }

      /* ---- ② 有效帧：先更新"最近收到时刻"（断连判据只认**有效**帧，FR-2.6） ---- */
      state.acceptedFrames++;
      state.lastAcceptedAt = atMs;
      state.lastAcceptedMs = v.collectMs;
      state.lastCollectTime = v.collectTimeSec;
      state.lastFrame = v.frame;                      // 内存态：实时显示用，**不等于**落库

      /* 去重口径：四字段为主口径；无 seq ⇒ 退路口径（并**显式标注**风险） */
      const fallback = v.seq === null;
      const key = [v.frame[FIELD.equipCode], v.frame[FIELD.procOrderNo], v.collectTimeSec,
        fallback ? '' : String(v.seq)].join('|');
      const dedup = {
        basis: fallback ? DEDUP.FALLBACK : DEDUP.PRIMARY,
        key,
        fallback,
        risk: fallback
          ? '退路口径（DR-13 / 函件 U-5）：帧内无 seq ⇒ 去重键退化为 equipCode+procOrderNo+collectTime；' +
            '**跨工单同秒帧存在误判风险**（已书面向对方声明，见 U-5④），且同一秒的多帧会被 1 s 采样口径合并'
          : null
      };

      /* ---- ③ 采样落库（ADR-0001 D7：1 s 采样落库、500 ms 原始帧不落库） ----
         ⚠ 顺序很关键：**同一秒**的帧有两种，必须先分清再看落库，否则会把"同一键重复送"
           错报成"原始帧不落库"（那就把 DR-13 的幂等去重藏起来了）：
             · **键相同** ⇒ 是 DR-13 的**重复帧** ⇒ 照常走落库口（`INSERT OR IGNORE` 报 `inserted=false`）
               再按 `duplicate` 返回 —— 去重真源仍是库层唯一索引，不由内存态冒充；
             · **键不同、同秒** ⇒ 是 IF-D.8 的 100～500 ms **原始帧** ⇒ 不落库（只更新内存态）。 */
      const sameKeyAsStored = state.lastStoredKey !== null && key === state.lastStoredKey;
      if (!sameKeyAsStored && isSameStoredSecond(v.collectTimeSec)) {
        state.rawFramesInMemory++;
        if (logger && state.rawFramesInMemory % 100 === 1) {
          logger.info('[IF-D] 500 ms 原始帧不落库（只进内存，ADR-0001 D7）', { collectTime: v.collectTimeSec });
        }
        return {
          outcome: OUTCOME.RAW_500MS, stored: false,
          collectTime: v.collectTimeSec, collectMs: v.collectMs, seq: v.seq,
          dedup, error: null, at: platformClock.fmt(new Date(atMs))
        };
      }

      if (!db) {
        /* 无库句柄 ⇒ **不假装成功**：按拒收返回并说明是装配问题（拒绝而非静默丢弃） */
        state.rejectedFrames++;
        const reason = '采集服务未接库（options.db 缺失）—— 帧未落库';
        state.lastReject = { code: 'NO_DB', field: '(service)', reason, at: platformClock.fmt(new Date(atMs)) };
        if (logger) logger.error('[IF-D] ' + reason);
        return {
          outcome: OUTCOME.REJECTED, stored: false,
          collectTime: v.collectTimeSec, collectMs: v.collectMs, seq: v.seq,
          dedup, error: { code: 'NO_DB', field: '(service)', reason },
          at: platformClock.fmt(new Date(atMs))
        };
      }

      /* 落库出口**唯一**＝`server/repo/measure.js`（本包不写第二套 SQL，也不另起去重真源）。
         幂等依据：`INSERT OR IGNORE` + 库层唯一索引 `ux_measure_rt(equip_code, proc_order_no,
         collect_time)`（`server/db/schema.sql` 的 DR-04 段；**刻意不写行号** —— schema 一增列
         行号即漂移，`PROJECT_RULES` 9.5-5 第 9 条要求引用带哈希而非会过期的行号）。 */
      const nowIso = platformClock.fmt(new Date(atMs));
      /* 件序号（V1.41 / C-111）：**拿不到就写 NULL**，绝不整帧拒收、也不拿 0/1 代言
         （裁定②：实测数据本身有效）。落列位置见 `server/repo/measure.js` 的 `toParams()`。 */
      const unit = parseUnitIndex(v.frame[FIELD.unitIndex]);
      const row = {
        equipCode: v.frame[FIELD.equipCode],
        procOrderNo: v.frame[FIELD.procOrderNo],
        collectTime: v.collectTimeSec,          // **截断到秒**（DR-16：落库维持秒级）
        unitIndex: unit.ok ? unit.value : null, // 缺 / 非法 ⇒ NULL（＝"这一帧没有件序号"）
        depth: v.frame[FIELD.depth],
        speed: v.frame[FIELD.speed],
        velocity_x: v.frame[FIELD.velocityX],
        velocity_y: v.frame[FIELD.velocityY],
        frameRate: v.frame[FIELD.frameRate],
        gain: v.frame[FIELD.gain],
        shutter: v.frame[FIELD.shutter],
        cameraDepth: v.frame[FIELD.cameraDepth],
        testStatus: v.frame[FIELD.testStatus]
      };
      const written = measureRepo.insertFrame(db, row, nowIso);
      if (!written.inserted) {
        /* 幂等：重复帧（同一 equip_code+proc_order_no+collect_time）**不改写既有行**。
           若走"后到覆盖"，这里就该 UPDATE —— 本实现**刻意不做**（理由见文件头）。 */
        state.duplicateFrames++;
        if (logger) logger.info('[IF-D] 重复帧被幂等去重（未产生第二行）', { key });
        return {
          outcome: OUTCOME.DUPLICATE, stored: false,
          collectTime: v.collectTimeSec, collectMs: v.collectMs, seq: v.seq,
          dedup, error: null, at: nowIso
        };
      }

      state.storedFrames++;
      state.lastStoredSecond = v.collectTimeSec;
      state.lastStoredKey = key;
      /* 件序号计数（**只数真正落库的那一帧** ⇒ 恒有 withIndex + withoutIndex === storedFrames）：
         非法/缺失都记 `withoutIndex`，并**留一条 warn**（不静默：现场要能看出"开工数为什么是 0"）。
         为什么在落库成功之后计数而不是之前：`duplicate`/`raw-500ms` 不新增行，先计数会让两个数
         与 `counts.stored` 对不上，把"可观测位"变成"又一个会漂移的数字"。 */
      if (unit.ok) {
        state.frameUnitIndex.withIndex++;
      } else {
        state.frameUnitIndex.withoutIndex++;
        /* 日志**不逐帧刷**（帧率 1/s×多设备，逐帧 warn 会把日志淹掉、反而看不见）：
           首次 + 之后每 100 帧各一条，与上方"500 ms 原始帧"的既有节流写法同款。
           计数本身是**逐帧**的（不受日志节流影响），`/health` 里读得到真值。 */
        if (logger && (state.frameUnitIndex.withoutIndex === 1 || state.frameUnitIndex.withoutIndex % 100 === 0)) {
          const raw = v.frame[FIELD.unitIndex];
          logger.warn(unit.reason === 'absent'
            ? `[IF-D] 帧未带件序号（IF-D.4 unitIndex；累计 ${state.frameUnitIndex.withoutIndex} 帧）⇒ ` +
              'measure_rt.unit_index 写 NULL、这些帧不计入开工件数（FR-4.2 按件计；"帧没带"≠"真没开工"）'
            : `[IF-D] 帧里的件序号非法（${JSON.stringify(raw)}；累计 ${state.frameUnitIndex.withoutIndex} 帧）` +
              ' ⇒ 视同"未提供"：unit_index 写 NULL、不计入开工件数（**不整帧拒收** —— 实测数据本身有效；' +
              'IF-D.4 的真实字段名与取值域待 Q-21）');
        }
      }
      /* ---- ④ W5-①：把"**1 s 采样落库**的这条帧"发布到事件总线（`frame` 的**唯一**发布点） ----
         为什么只发这里（三条口径，逐条对齐需求）：
           · 「1 s 采样落库、500 ms 原始帧不落库」（ADR-0001 D7 / W1 判据③）——事件流若把 500 ms
             原始帧也推给看板，等于从推送侧绕开"库里每秒只有一行"这条既定口径；
           · `duplicate`（同键幂等命中、**未新增行**）与 `rejected`/`raw-500ms` 都不是状态变化，
             不发布（判据③的负向断言据此成立）；
           · 载荷形状＝上位机 `upper` 报文（见 `framePayloadOf`），前端 `applyUpperPayload()` 直接消费。
         发布顺序：**落库成功之后**（先有事实、再有通知）。发布失败（总线已关闭等）不影响落库结果。 */
      const sampled = framePayloadOf(v);
      state.lastSampledFrame = sampled;
      if (bus) bus.publish(EVENT_KIND.FRAME, sampled);

      /* ---- ⑤ W5-②（技术债 E45）：把**这一帧**交给判定挂钩 —— `warning` 事件的**唯一真实写入点** ----
         为什么挂在这里（与上方 `frame` 事件逐条同源，不另立第二条路径）：
           · **只在"1 s 采样落库成功"之后**：判定对象是"落在库里的那条实测"（`duplicate` 未新增行、
             `raw-500ms` 不落库、`rejected` 没落库 —— 三者都不判定，与 `frame` 事件同口径）；
           · 顺序＝**先落库、再发帧、最后判定**：判定要读库（标准真源）与入参，落库之后读到的才是事实；
           · 回调抛错**只记不抛**：落库与帧推送已经完成，判定属派生；把异常甩回 HTTP 面会让
             "上位机看到 5xx 于是重发帧"，反而污染采集链。失败计入 `sampledHookFailures` 并写日志。 */
      if (onSampled) {
        try {
          onSampled(sampled);
        } catch (err) {
          hookState.sampledHookFailures++;
          hookState.lastSampledHookError = String((err && err.message) || err);
          if (logger) {
            logger.warn('[IF-D] 判定挂钩（onSampled → warning 事件）失败：' +
              (err && err.message ? err.message : String(err)) +
              ' —— 帧已落库且 frame 事件已发布，本条只影响预警推送');
          }
        }
      }
      if (logger) {
        logger.info('[IF-D] 采样落库（1 s 采样）', { key, collectTime: v.collectTimeSec, dedup: dedup.basis });
      }
      return {
        outcome: OUTCOME.STORED, stored: true,
        collectTime: v.collectTimeSec, collectMs: v.collectMs, seq: v.seq,
        dedup, error: null, at: nowIso
      };
    },

    /** 校验口（**纯函数**的直通，供自检/上层预检；不改变任何运行态） */
    validate(frame) { return validateFrame(frame, validateOpts()); },

    /* ---------------- 断连状态（FR-2.6 / IF-D.9） ---------------- */

    /**
     * 链路状态快照。
     * @returns {{state:'online'|'offline', staleMs:number, ageMs:number|null, ...
     *            online:boolean, reason:string}}
     *   判据：**从未收到有效帧** 或 `now - lastAcceptedAt > staleMs` ⇒ offline（≤5 s 口径）。
     */
    linkState() {
      const t = nowFn().getTime();
      const ageMs = state.lastAcceptedAt === null ? null : t - state.lastAcceptedAt;
      let linkState = 'online';
      let reason = '';
      if (state.lastAcceptedAt === null) {
        linkState = 'offline';
        reason = '尚未收到任何有效帧（IF-D.9：重连期间显示「数据冻结/离线」）';
      } else if (ageMs > staleMs) {
        linkState = 'offline';
        reason = `距最近一次有效帧已 ${ageMs} ms > 阈值 ${staleMs} ms（FR-2.6 断连检测 ≤5 s）`;
      } else {
        reason = `距最近一次有效帧 ${ageMs} ms ≤ 阈值 ${staleMs} ms`;
      }
      return {
        state: linkState,
        online: linkState === 'online',
        staleMs,
        ageMs,
        lastAcceptedAt: state.lastAcceptedAt === null ? null : platformClock.fmt(new Date(state.lastAcceptedAt)),
        lastCollectTime: state.lastCollectTime,
        lastCollectMs: state.lastAcceptedMs,
        reason
      };
    },

    /** 采集计数与去重口径快照（供 `/health` 与运维；**只报告不推断**） */
    status() {
      return {
        ingest: 'ifD',
        dedup: { primary: DEDUP.PRIMARY, fallback: DEDUP.FALLBACK },
        sampling: { store: '1s', raw: '500ms-内存不落库', basis: 'ADR-0001 D7' },
        counts: {
          received: state.receivedFrames,
          accepted: state.acceptedFrames,
          stored: state.storedFrames,
          duplicate: state.duplicateFrames,
          rawInMemory: state.rawFramesInMemory,
          rejected: state.rejectedFrames,
          /* W5-②：判定挂钩（`warning` 事件）的失败次数 —— 0 才是"预警链路真的在跑" */
          sampledHookFailures: hookState.sampledHookFailures
        },
        lastSampledHookError: hookState.lastSampledHookError,
        /* V1.41 / C-111（技术债 E69）：件序号计数 —— 让"开工数为什么是 0"可被现场读出来
           （"帧没带件序号" vs "真没开工"）。`/health` 的 `ifd` 子集与 `GET /ifd/status` 同源
           （两处都是本函数的返回值，不另算一份）。恒有 withIndex + withoutIndex === counts.stored。 */
        frameUnitIndex: {
          withIndex: state.frameUnitIndex.withIndex,
          withoutIndex: state.frameUnitIndex.withoutIndex,
          stored: state.storedFrames,
          note: '帧件序号（IF-D.4 unitIndex）：缺件序号的帧 unit_index 写 NULL 且不计入开工件数（FR-4.2 按件计）'
        },
        lastReject: state.lastReject,
        lastStoredKey: state.lastStoredKey,
        lastStoredSecond: state.lastStoredSecond,
        link: ingest.linkState(),
        sources: {
          push: { kind: 'http-post', path: '/ifd/frame', implemented: true, enabled: true },
          poller: { kind: 'poll', url: upperCfg.url || '', implemented: true, enabled: false,
            note: '形态待 U-0.1 / Q-21 答复；启用只改 routes/ifD.js 的一处声明' }
        }
      };
    },

    /** 内存态最近一帧（供后续实时展示复用；**不落库、不是持久真源**） */
    lastFrame() { return state.lastFrame; },

    /** 内存态**最新 1 s 采样帧**（形状＝`upper` 报文；W5 的 `snapshot.frame` 唯一来源）。
     *  与 `lastFrame()` 的区别：500 ms 原始帧会更新 `lastFrame()`，**不**更新这里。 */
    lastSampledFrame() { return state.lastSampledFrame; },

    /**
     * 链路状态变化监控（W5-①）：把 `linkState()` 的**变化**发布成 `link` 事件
     * （在线→离线 / 离线→在线，FR-2.6）。
     *   · **判据真源只有一个**＝`ingest.linkState()`（阈值＝`upper.staleMs`，缺省 5000 ms）；
     *     本监控**不重写**阈值比较（两处阈值必然漂移）；
     *   · 只在**状态变化**时发布；首次 tick 只建立基线（建连时的 `hello` 快照已承载当前状态）；
     *   · 定时器可注入（`setIntervalImpl`/`clearIntervalImpl`，与 `createPoller` 同一对注入口），
     *     `stop()`/`close()` 清掉 —— **进程退出后不得有残留定时器**（优雅退出的判据⑥）；
     *   · `intervalMs` 只是**轮询周期**（缺省 1 s），与断连阈值是两件事。
     * @param {{bus?:object, intervalMs?:number, logger?:object, setIntervalImpl?:Function,
     *          clearIntervalImpl?:Function}} [cfg]
     * @returns {{start:Function, stop:Function, close:Function, running:Function, tick:Function,
     *            status:Function, intervalMs:number}}
     */
    createLinkMonitor(cfg = {}) {
      const monitorBus = cfg.bus || bus;
      const intervalMs = isNum(cfg.intervalMs) && cfg.intervalMs > 0
        ? cfg.intervalMs : DEFAULT_LINK_INTERVAL_MS;
      const setImpl = cfg.setIntervalImpl || setIntervalImpl;
      const clearImpl = cfg.clearIntervalImpl || clearIntervalImpl;
      const log = cfg.logger || logger;
      let timer = null;
      let lastOnline = null;          // null＝尚未建立基线（首次 tick 只记基线）
      let transitions = 0;
      let published = 0;
      let lastEvent = null;

      /** 走一次判定（**可单独调用**，供自检不起定时器也能验判据） */
      function tick() {
        const st = ingest.linkState();
        if (lastOnline === null) { lastOnline = st.online; return null; }
        if (st.online === lastOnline) return null;
        lastOnline = st.online;
        transitions++;
        const payload = {
          online: st.online, state: st.state, staleMs: st.staleMs,
          ageMs: st.ageMs, lastAcceptedAt: st.lastAcceptedAt
        };
        lastEvent = payload;
        if (monitorBus) { monitorBus.publish(EVENT_KIND.LINK, payload); published++; }
        if (log) {
          log.info(`[IF-D] 链路状态变化：${st.online ? '离线→在线' : '在线→离线'}`,
            { ageMs: st.ageMs, staleMs: st.staleMs });
        }
        return payload;
      }

      const monitor = {
        intervalMs,
        tick,
        start() {
          if (timer !== null) return monitor;
          timer = setImpl(tick, intervalMs);
          if (timer && typeof timer.unref === 'function') timer.unref();
          return monitor;
        },
        stop() {
          if (timer !== null) { clearImpl(timer); timer = null; }
          return monitor;
        },
        running: () => timer !== null,
        /** 与 `stop()` 同义（优雅退出路径上的调用名与 eventBus.close() 对齐） */
        close() { return monitor.stop(); },
        status: () => ({
          running: timer !== null, intervalMs, lastOnline, transitions, published, lastEvent,
          staleMs: staleMs
        })
      };
      return monitor;
    },

    /* ---------------- 可插拔的入站 source（两种形态共用 ingestFrame） ---------------- */

    /**
     * ① **看板轮询取数**（服务端作为客户端）。口径参考 `src/services/api.js:253-255`
     *   （GET + 可选 `Authorization: Bearer` + `timeoutMs` 超时），但实现落在服务端。
     *   **默认不自动启动**：形态未定（U-0.1），本包只提供能力与注入出口，不接线、不起定时器。
     * @param {{url?:string, intervalMs?:number, timeoutMs?:number, auth?:object,
     *          onResult?:Function, autoStart?:boolean}} [cfg]
     * @returns {{enabled:boolean, start:Function, stop:Function, running:Function, pollOnce:Function}}
     */
    createPoller(cfg = {}) {
      const url = cfg.url || upperCfg.url || '';
      const intervalMs = isNum(cfg.intervalMs) && cfg.intervalMs > 0 ? cfg.intervalMs : 1000;  // IF-D.8 常规 1 s
      const timeoutMs = isNum(cfg.timeoutMs) && cfg.timeoutMs > 0
        ? cfg.timeoutMs : (isNum(upperCfg.timeoutMs) ? upperCfg.timeoutMs : 3000);
      const auth = cfg.auth || upperCfg.auth || { type: 'none' };
      let timer = null;

      /** 拉一帧（**不抛**：取数失败只记状态与日志，不把异常甩给调用方） */
      async function pollOnce() {
        if (!fetchImpl) return { ok: false, error: { code: 'NO_FETCH', reason: '当前运行时没有 fetch 可用' } };
        if (!url) return { ok: false, error: { code: 'NO_URL', reason: '未配置上位机取数地址（upper.url）' } };
        try {
          const headers = auth && auth.type === 'bearer' ? { Authorization: `Bearer ${auth.token}` } : {};
          /* 超时用 `AbortSignal.timeout`（`src/services/api.js:260` 的既有口径）：
             超时表现为 fetch 抛 AbortError，由外层 catch 收敛成 `{ok:false,error:{code:'FETCH_FAILED'}}`，
             **不抛给调用方**、也**不刷新 lastAcceptedAt**（断连判据据此自然走向 offline，FR-2.6）。 */
          const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
            ? AbortSignal.timeout(timeoutMs) : undefined;
          const res = await fetchImpl(url, { method: 'GET', headers, signal });
          if (!res.ok) {
            return { ok: false, error: { code: 'HTTP_' + res.status, reason: `上位机取数失败：HTTP ${res.status}` } };
          }
          const payload = await res.json();
          const result = ingest.ingestFrame(payload);
          if (cfg.onResult) cfg.onResult(result);
          return { ok: true, result };
        } catch (err) {
          /* 取数失败**不改** lastAcceptedAt ⇒ 断连判据自然走向 offline（FR-2.6） */
          if (logger) logger.warn('[IF-D] 轮询取数失败：' + (err && err.message));
          return { ok: false, error: { code: 'FETCH_FAILED', reason: (err && err.message) || String(err) } };
        }
      }

      const poller = {
        enabled: false,
        url,
        intervalMs,
        pollOnce,
        running: () => timer !== null,
        start() {
          if (timer !== null) return poller;
          poller.enabled = true;
          timer = setIntervalImpl(() => { pollOnce().catch(() => { /* pollOnce 内部已收敛 */ }); }, intervalMs);
          if (typeof timer.unref === 'function') timer.unref();
          if (logger) logger.warn('[IF-D] 轮询取数已启动（形态待 U-0.1 答复）', { url, intervalMs });
          return poller;
        },
        stop() {
          if (timer !== null) { clearIntervalImpl(timer); timer = null; }
          poller.enabled = false;
          return poller;
        }
      };
      if (cfg.autoStart === true) poller.start();
      return poller;
    },

    /**
     * ② **上位机推送**：返回一个 HTTP 处理函数（`(reqBody) => result`）。
     *   真正的接线在 `server/http/routes/ifD.js`（`POST /ifd/frame`）；这里只把
     *   "请求体 → 同一入口"这一段做成纯函数，便于不起 HTTP 也能单测。
     * @returns {{handle:Function, path:string}}
     */
    createPushHandler(cfg = {}) {
      const path = cfg.path || '/ifd/frame';
      return {
        path,
        /**
         * @param {any} body 已解析的 JSON 请求体；形如 `{frame:{…}}` 时**解包**（兼容包装形态，
         *        因为真实报文外层结构待 Q-21 答复）
         */
        handle(body) {
          const frame = (body && typeof body === 'object' && !Array.isArray(body) &&
            body.frame && typeof body.frame === 'object') ? body.frame : body;
          return ingest.ingestFrame(frame);
        }
      };
    },

    /** 运行态只读视图（自检需要断言"原始帧只进内存"时读它；**不得**在此改写） */
    stats() { return Object.assign({}, state, hookState); }
  };

  return ingest;
}

module.exports = {
  createIngest,
  validateFrame,
  parseCollectTime,
  framePayloadOf,
  FIELD,
  REQUIRED_FIELDS,
  REJECT,
  OUTCOME,
  DEDUP,
  PLAUSIBLE,
  TEST_STATUS_VALUES,
  FPS_MIN,
  FPS_MAX,
  STD_DIGITS,
  GAIN_DIGITS,
  COLLECT_TIME_SEC_RE,
  COLLECT_TIME_MS_RE,
  DEFAULT_LINK_INTERVAL_MS
};
