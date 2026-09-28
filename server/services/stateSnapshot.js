/* ==========================================================================
   看板整机快照（server/services/stateSnapshot.js）—— W5-①「服务端 SSE 业务推送」
   作用：把"看板这一刻的全量状态"组装成**一份**对象，供两个出口共用：
     · SSE 建连时的 `event: hello`（`data` 即 `{ok, at, seq, snapshot}`）
     · REST 的 `GET /state`（响应体同形）
   **同源要求（判据①）**：两处**必须**由本文件的 `snapshot()` 产出 —— 禁止两套拼装
   （否则 `hello` 与 `/state` 会各自演化，前端切源时必然对不上）。`at` / `seq` 由调用方
   （`http/router.js`）加在信封上，**不进** `snapshot` 本体，这样同一时刻两次读取可深比较。
   ---- snapshot 的键名（**一旦定下即契约**，W5-② 的前端切源按此表消费）----------------
     link     { state:'online'|'offline', online:boolean, staleMs:number,
                lastAcceptedAt:string|null, lastCollectTime:string|null, lastCollectMs:number|null }
              来源：`services/ingest.linkState()`（FR-2.6 的唯一真源，**不重算阈值**）
              ⚠ 刻意**不含** `ageMs` / `reason`：它们随"读的时刻"变化，会把"hello 与 /state 同源"
                这条判据变成时间敏感的；需要它们请读 `GET /ifd/status` 或 `GET /ifd/health`。
     task     { procOrderNo, batchNo, productCode, productName, productNo, drawingNo, orderNo,
                processNo, processName, planQty:number, status, planStartTime, planEndTime,
                actualStart, actualEnd, updatedAt } | null
              来源：`task` 表最近更新的一条（DR-02；无工单 ⇒ null）
     device   { equipCode, equipName } | null         来源：`device` 表（DR-01）
     frame    { equipCode, procOrderNo, collectTime, seq, depth, speed, velocity_x, velocity_y,
                frameRate, gain, shutter, cameraDepth, testStatus } | null
              来源：**最新 1 s 采样帧**（`ingest.lastSampledFrame()`），形状与上位机 `upper` 报文
              逐字段同名（前端 `applyUpperPayload()` 直接可消费）；缺测字段按报文原样缺省（不编造）
     stats    `services/stats.computeShiftStats()` 的全量产物（键名即其返回值）：
              { shift:{name,date,startAt,endAt,elapsedSec,totalSec}, planQty, startedQty,
                notStartedQty, doneQty, runningQty, waitingQty, passQty, failQty, retestQty,
                firstPassRate, runSec, idleSec, avgTestSec, capacityRate, oee,
                accumulate:{daySec,monthSec,yearSec,at,reset}, taskTotal, cycleSec }
              来源：**当班统计的唯一核算处**（FR-4 十五项口径不在此重写）
     standard { productCode, processCode, versionNo:number|null, effectiveFrom:string|null,
                depth:{typical,upperDev,lowerDev,upper,lower,set}, speed:{同左},
                limits:{depth:{upper,lower,typical}|null, speed:{…}|null} } | null
              来源：`services/standard`（`getEffectiveStandard` + `toDisplayStandard` +
              `absoluteLimits`）；无工单/无生效版本 ⇒ null
     upload   { configured:boolean, baseUrl:string, responseStyle:'status'|'code',
                pendingCount:number, pendingOnly:number, failedAfterRetry:number, total:number,
                capacity:number, warnThreshold:number, oldestAt:string|null, alert:object,
                autoRetry:false }
              来源：**W4 的 `GET /upload/status` 同一真源**（`uploadReporter.status()` 的子集）
   ---- 口径与边界 --------------------------------------------------------------------
     · 时间：`snapshot` 本体**不含**"现在几点"；需要时刻读信封的 `at`（注入时钟给出，D17）。
       `stats.shift.elapsedSec` 等当班进度**随秒前进**（跨秒两次读取可能差 1 s），这是当班
       进度的应有语义；`link` 与 `frame` 在同一次状态变化之间是稳定的。
     · 缺什么给什么：无工单/无帧/无上报器 ⇒ 对应键为 null 或按上文缺省，**绝不编造**数值。
     · DR-17 累计运行：本项目尚无 `shift_stat` 的落库调用方，故 `stats.accumulate` 以
       `addRunSec: 0`、无上次值核算（首次入库口径＝原样保留传入值）—— 已在 W5 回执登记。
   依赖：`platform/clock.js`、`server/services/{shift,stats,standard}.js`、`src/config/board.config.js`。
   ========================================================================== */
'use strict';

const platformClock = require('../../platform/clock');
const boardConfig = require('../../src/config/board.config.js');
const { createShiftRules } = require('./shift');
const statsSvc = require('./stats');
const standardSvc = require('./standard');

/** 帧载荷的字段清单（**与 IF-D / fieldMap.upperToBoard 的 key 同名**；顺序只为可读） */
const FRAME_FIELDS = Object.freeze([
  'equipCode', 'procOrderNo', 'collectTime', 'seq',
  'depth', 'speed', 'velocity_x', 'velocity_y',
  'frameRate', 'gain', 'shutter', 'cameraDepth', 'testStatus'
]);

/** 工单关键字段（task 表的业务列；不算 SQL 结构真源 —— 结构真源仍是 `server/db/schema.sql`） */
const TASK_FIELDS = Object.freeze([
  ['procOrderNo', 'proc_order_no'], ['batchNo', 'batch_no'], ['productCode', 'product_code'],
  ['productName', 'product_name'], ['productNo', 'product_no'], ['drawingNo', 'drawing_no'],
  ['orderNo', 'order_no'], ['processNo', 'process_no'], ['processName', 'process_name'],
  ['planQty', 'plan_qty'], ['status', 'status'], ['planStartTime', 'plan_start_time'],
  ['planEndTime', 'plan_end_time'], ['actualStart', 'actual_start'], ['actualEnd', 'actual_end'],
  ['updatedAt', 'updated_at']
]);

/** 空值归一：库里的 null/undefined 统一成 null（"没有值"与"值是 0"必须分得开） */
function nullIfAbsent(v) {
  return v === undefined || v === null ? null : v;
}

/** 取配置段（容错：配置缺段时给空对象，不抛 —— 缺的是**参数**，不是结构） */
function segOf(config, name) {
  const v = config ? config[name] : null;
  return v && typeof v === 'object' ? v : {};
}

/**
 * 创建整机快照构造器。
 * @param {{db?:object, ingest?:object, upload?:object, now?:Function, config?:object}} [options]
 *   `db`     —— SQLite 句柄（读 task/device/measure_rt；**只读**，不写任何表）
 *   `ingest` —— `services/ingest.js` 实例（`linkState()` / `lastSampledFrame()`）
 *   `upload` —— `services/uploadReporter.js` 实例（`status()`）；缺省 ⇒ `upload` 键为 null 的子集
 *   `now`    —— 注入时钟出口（与全进程同一份；缺省＝真实时钟，不新造第二套）
 * @returns {() => object} `snapshot()`：无参、纯读、同步；同一时刻两次调用结果可深比较
 */
function createStateSnapshot(options = {}) {
  const db = options.db || null;
  const ingest = options.ingest || null;
  const upload = options.upload || null;
  const nowFn = typeof options.now === 'function'
    ? options.now
    : platformClock.createClock({ mode: 'real' }).source();
  const config = options.config || boardConfig;
  const shiftRules = createShiftRules((segOf(config, 'shift').list) || []);

  /** 当前工单行（最近更新的一条；无 ⇒ null） */
  function taskRow() {
    if (!db) return null;
    return db.prepare('SELECT * FROM task ORDER BY updated_at DESC, proc_order_no ASC LIMIT 1').get() || null;
  }

  /** 设备行（DR-01 口径是"整套系统 1 个编号"，故取最近更新的一条） */
  function deviceRow() {
    if (!db) return null;
    return db.prepare('SELECT equip_code, equip_name FROM device ORDER BY updated_at DESC LIMIT 1').get() || null;
  }

  /** 快照里的工单段（键名固定见文件头） */
  function taskOf(row) {
    if (!row) return null;
    const out = {};
    for (const [key, col] of TASK_FIELDS) out[key] = nullIfAbsent(row[col]);
    return out;
  }

  /** 快照里的链路段（刻意剔除 ageMs/reason：随读时刻变化，见文件头说明） */
  function linkOf() {
    if (!ingest || typeof ingest.linkState !== 'function') return null;
    const st = ingest.linkState();
    return {
      state: st.state,
      online: st.online,
      staleMs: st.staleMs,
      lastAcceptedAt: nullIfAbsent(st.lastAcceptedAt),
      lastCollectTime: nullIfAbsent(st.lastCollectTime),
      lastCollectMs: nullIfAbsent(st.lastCollectMs)
    };
  }

  /** 快照里的帧段（**最新 1 s 采样帧**，形状与 upper 报文同名；无 ⇒ null） */
  function frameOf() {
    if (!ingest || typeof ingest.lastSampledFrame !== 'function') return null;
    const raw = ingest.lastSampledFrame();
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const key of FRAME_FIELDS) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
    return out;
  }

  /** 快照里的统计段（**唯一核算处**＝`services/stats.computeShiftStats()`；本文件不重写任何算式） */
  function statsOf(now) {
    const prod = segOf(config, 'production');
    const rows = db ? db.prepare('SELECT status FROM task').all() : [];
    const measures = db
      ? db.prepare('SELECT collect_time FROM measure_rt ORDER BY id DESC LIMIT 1000').all()
      : [];
    const shift = shiftRules.at(now);
    const computed = statsSvc.computeShiftStats({
      shift,
      tasks: rows.map(r => ({ result: r.status })),
      measures: measures.map(r => r.collect_time),
      planQty: prod.planQty,
      cycle: { sec: prod.cycleSec },
      now,
      /* DR-17 累计运行：本项目尚无落库调用方（见文件头"口径与边界"），故增量 0、无上次值 */
      addRunSec: 0
    });
    return computed;
  }

  /** 快照里的标准段（`services/standard` 同源：生效版本 + 偏差显示 + 绝对值上下限） */
  function standardOf(task, at) {
    if (!db || !task) return null;
    const productCode = task.productCode === undefined || task.productCode === null ? '' : String(task.productCode);
    if (!productCode) return null;
    const processCode = task.processNo === undefined || task.processNo === null ? '' : String(task.processNo);
    const row = standardSvc.getEffectiveStandard(db, { productCode, processCode, at });
    if (!row) return null;
    const display = standardSvc.toDisplayStandard(row);
    return {
      productCode: row.productCode === undefined ? productCode : row.productCode,
      processCode: row.processCode === undefined ? processCode : row.processCode,
      versionNo: nullIfAbsent(display.versionNo),
      effectiveFrom: nullIfAbsent(display.effectiveFrom),
      depth: display.depth,
      speed: display.speed,
      limits: standardSvc.absoluteLimits(row)
    };
  }

  /** 快照里的上报段（**与 W4 的 `GET /upload/status` 同一真源**：`uploadReporter.status()` 的子集） */
  function uploadOf() {
    if (!upload || typeof upload.status !== 'function') return null;
    const s = upload.status();
    return {
      configured: s.configured,
      baseUrl: s.baseUrl,
      responseStyle: s.responseStyle,
      pendingCount: s.pendingCount,
      pendingOnly: s.pendingOnly,
      failedAfterRetry: s.failedAfterRetry,
      total: s.total,
      capacity: s.capacity,
      warnThreshold: s.warnThreshold,
      oldestAt: nullIfAbsent(s.oldestAt),
      alert: s.alert,
      autoRetry: false
    };
  }

  /**
   * 组装整机快照（纯读、同步）。
   * @returns {object} 见文件头的 snapshot schema 表
   */
  function snapshot() {
    const now = platformClock.toDate(nowFn());
    const task = taskOf(taskRow());
    const frame = frameOf();
    /* 标准取值时刻：优先用**最新采样帧的采集时刻**（"当时生效版本"，与 W4 上报组装同口径）；
       没有帧时退到注入时钟的当前时刻（DR-16 文本）。 */
    const at = frame && frame.collectTime ? String(frame.collectTime) : platformClock.fmt(now);
    const dev = deviceRow();
    return {
      link: linkOf(),
      task,
      device: dev ? { equipCode: dev.equip_code, equipName: dev.equip_name } : null,
      frame,
      stats: statsOf(now),
      standard: standardOf(task, at),
      upload: uploadOf()
    };
  }

  return snapshot;
}

module.exports = { createStateSnapshot, FRAME_FIELDS, TASK_FIELDS };
