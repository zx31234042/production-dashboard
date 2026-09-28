/* ==========================================================================
   上报待补传队列服务（server/services/uploadQueue.js）
   作用：把"上报失败的报文"**落库留存 + 暴露待补传条数**，并提供**人工重报**所需的三件事：
        ①查询待补传清单（条数 + 明细）②标记单条重报结果 ③标记批量重报结果。
        —— 技术债 E10 的落地：原实现（`src/services/api.js:17-18`）是**模块内存数组**，
        上限 5000 条后 `shift()` **丢弃最旧**，进程重启即丢、超限即丢，
        与 IF-B.9（上报失败本地缓存）、NFR-13（数据不丢失）直接冲突。
   背景决策（**已定，本文件据此实现**）：
        · **不做自动重试** —— 不实现指数退避、不加定时器、不自动 flush；
        · 上报失败**只做两件事**：①告警/暴露待补传条数；②把失败报文落库留存；
        · **重报由人工触发**（后续"一键重报"界面另行开发，本文件只提供它要调用的能力）。
   上限策略（**不得再静默丢弃最旧报文**）：
        `capacity` 缺省 5000（= 原内存队列上的同一个数，便于对照）；达到上限时**新键**
        `enqueueFailed()` **拒绝入队并抛 `UploadQueueFullError`**，调用方据此告警；
        队列内容**一条不删**（宁可拒收新的，也不丢已留存的）。
        **已存在的 uploadId 不受容量限制**（A1 修）：重复入队是 `ON CONFLICT` 覆盖更新，
        不新增行、不占额度，连它也拒掉会让"刷新失败原因"在队列满时彻底不可用。
   落库位置（表结构**唯一真源**）：`server/db/schema.sql` 的 `upload_log`（DR-11），
        本次已把 E10 需要的 `fail_reason`、`updated_at` 正式并入建表语句，
        `SCHEMA_VERSION` 同步由 `'2'` 升到 `'3'`；运行时**不再有 ALTER TABLE 补列**。
   依赖：`server/repo/uploadQueue.js`（SQL）；时间由调用方注入（不给注入出口时不落时间字段）。
   ========================================================================== */
'use strict';

const repo = require('../repo/uploadQueue');
const { KIND: EVENT_KIND } = require('./eventBus');
/* 配置真源（R26-P3-4）：`src/config/board.config.js` 同时支持浏览器（window.BoardConfig）
   与 Node（module.exports），故服务端可直接 require 同一份配置 —— 不新造第二份阈值。 */
const boardConfig = require('../../src/config/board.config.js');

/** 队列容量缺省值（与原内存队列的 5000 条上限一致；改这里即改行为，不散落魔法数字） */
const DEFAULT_CAPACITY = 5000;

/** 待补传清单一次返回的最大条数（防止把几千条明细一次性吐给界面） */
const DEFAULT_LIST_LIMIT = 200;

/** 默认告警阈值：**取自配置真源** `board.config.js` 的 `mes.queueWarnThreshold`
 *  （＝"待补传条数 ≥ 该值即告警"，NFR-13 口径：报不上去就要让人看见；真源现值 1）。
 *  **不要**在此写死字面量：前端 `src/services/api.js` 的 `getStatus().queueAlert` 读同一键，
 *  写死即两侧口径漂移（R26-P3-4 立案原因：前端曾按"容量 × 90%"算、服务端缺省 1，两判相反）。
 *  取不到配置键时的兜底与真源同值（1）—— 改一处必须同步另一处。
 *
 *  为什么还留一个模块级常量（R26-P3-4 的 `DEFAULT_WARN_THRESHOLD`）：它是**导入期快照**，
 *  `tests/contract-check.js` 拿它与配置真源做"逐值对账"（跨实现一致性断言）。
 *  **运行期**的缺省值走 `configWarnThreshold()`（每次读配置），这样"改配置即改判据"
 *  在同一个进程里也成立（否则改配置要重启才生效，判据与真源会短暂两判）。 */
const DEFAULT_WARN_THRESHOLD =
  (boardConfig.mes && boardConfig.mes.queueWarnThreshold !== undefined)
    ? boardConfig.mes.queueWarnThreshold : 1;

/** 运行期读取告警阈值真源（配置缺项/非法时回落到与真源同值的兜底 1） */
function configWarnThreshold() {
  const v = boardConfig.mes && boardConfig.mes.queueWarnThreshold;
  return (typeof v === 'number' && Number.isFinite(v)) ? v : DEFAULT_WARN_THRESHOLD;
}

/**
 * 队列已满：**拒绝新键入队**（不再静默丢弃最旧报文）。
 * 只在"本次 uploadId 在库中不存在"时才抛 —— 已存在的键走覆盖更新，不受容量限制。
 * 调用方应捕获它并把 `pending`/`capacity` 告警出去；报文本身**必须由调用方自行处置**
 * （例如另行人工导出），因为本服务已明确拒收。
 */
class UploadQueueFullError extends Error {
  constructor(pending, capacity) {
    super(
      `上报待补传队列已满（${pending}/${capacity}）：拒绝入队以避免丢弃已留存报文（NFR-13）。` +
      '请人工处理待补传清单后再上报。');
    this.name = 'UploadQueueFullError';
    this.code = 'UPLOAD_QUEUE_FULL';
    this.pending = pending;
    this.capacity = capacity;
  }
}

/** 时间格式化（本地实现，避免为一次格式化引入对平台层的依赖；格式遵循 DR-16） */
function fmtNow(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 取“现在”（**必须有注入出口**，ADR-0003 D17：业务代码不得直接取当前时间参与逻辑）
    缺省兜底写成**同一行**的 `X || new Date()` —— 门禁按行判定注入出口是否存在
    （见 tests/docs-cross-check.js 第六节的 D17 判据），孤立一行 `return new Date();` 会被判违规。 */
function resolveNow(options) {
  const injected = (options && options.now) || new Date();
  return typeof injected === 'function' ? injected() : injected;
}

/** 校验并归一容量：必须是 ≥ 1 的整数；非法入参直接抛错，不静默兜底 */
function normalizeCapacity(value) {
  if (value === undefined) return DEFAULT_CAPACITY;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`uploadQueue: capacity 必须是 ≥ 1 的整数，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 创建待补传队列服务实例。
 *
 * @param {object} options
 *   @param {object}    options.db             SQLite 句柄（platform/paths.js 的 dbFile 经 server/db 打开）
 *   @param {string}    [options.interface]    缺省接口名，形如 `report/receiveReport`（serviceName/methodName）
 *   @param {number}    [options.capacity]     队列容量上限，缺省 5000；满了**拒绝入队**（抛 UploadQueueFullError）
 *   @param {number}    [options.listLimit]    清单一次最多返回条数，缺省 200
 *   @param {number}    [options.warnThreshold] 告警阈值（待补传条数 ≥ 该值即 warn）；
 *                        缺省＝`board.config.js` 的 `mes.queueWarnThreshold`（真源现值 1），
 *                        **不由容量换算**（与 queueCap 分语义）；调用方仍可显式传参覆盖（R26-P3-4）
 *   @param {Function|Date} [options.now]      时钟注入：函数（推荐传 platform/clock.js 的 clock.source()）或 Date
 *   @param {object}    [options.logger]       日志器（platform/log.js 的 createLogger 产物）；不传则不写日志
 * @returns {object} 队列服务实例（见下方各方法注释）
 */
function createUploadQueue(options = {}) {
  const db = options.db;
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('uploadQueue: 必须传入 SQLite 句柄（options.db）');
  }
  const ifaceDefault = options.interface || 'report/receiveReport';
  const capacity = normalizeCapacity(options.capacity);
  const listLimit = options.listLimit === undefined ? DEFAULT_LIST_LIMIT : options.listLimit;
  const warnThreshold = options.warnThreshold === undefined ? configWarnThreshold() : options.warnThreshold;
  const logger = options.logger || null;
  /* W5-① 事件总线（可选注入）：`upload` 事件挂在**本模块的真实状态迁移点**上。
     为什么挂在这里：`upload_log` 的写路径**全部**经本模块（上报器 `sendOnce` 也只调 recordSuccess /
     enqueueFailed），故这里是"上报队列/回执状态"的唯一真源 —— 挂在别处就会另起一套状态观察。 */
  const bus = options.bus || null;
  if (bus && typeof bus.publish !== 'function') {
    throw new TypeError('uploadQueue: options.bus 传了但不是事件总线（缺 publish）——见 services/eventBus.js');
  }

  /* 待补传条数缓存：COUNT 查询本身很便宜，但界面/自检会高频读，故缓存；
     任何写操作后立即作废（**不做定时刷新** —— 本项目不引入定时器，见文件头背景决策）。 */
  let cachedCount = null;

  const nowIso = () => fmtNow(resolveNow(options));

  /** 作废条数缓存（每次写操作后调用；**别省这一步**，否则告警数字会滞后） */
  function invalidate() { cachedCount = null; }

  /**
   * 把一次**真实状态迁移**发布成 `upload` 事件（W5-①）。
   * 只在下面四个写路径里调用（enqueueFailed / recordSuccess / markRetried / markRetriedBatch），
   * 也就是 `upload_log` 的**全部**写入点 —— 不在这里之外另造状态观察（真源只有一份）。
   * @param {string} action 'enqueue-failed' | 'record-success' | 'retry-ok' | 'retry-fail' | 'retry-batch'
   * @param {{uploadId:string, interface:string, state:string, pendingCount:number, alert:object,
   *          created?:boolean, retryCount?:number|null, updated?:number}} detail
   */
  function publishUpload(action, detail) {
    if (!bus) return null;
    const payload = {
      action,
      uploadId: detail.uploadId === undefined ? null : detail.uploadId,
      interface: detail.interface === undefined ? null : detail.interface,
      state: detail.state,
      created: detail.created === undefined ? null : detail.created,
      retryCount: detail.retryCount === undefined ? null : detail.retryCount,
      updated: detail.updated === undefined ? null : detail.updated,
      pendingCount: detail.pendingCount,
      capacity: queue.capacity,
      warnThreshold: queue.warnThreshold,
      alert: detail.alert
    };
    return bus.publish(EVENT_KIND.UPLOAD, payload);
  }

  /** 直查待补传条数（含人工重报过仍失败的；带缓存，写操作后由 invalidate() 作废） */
  function computePending() {
    if (cachedCount === null) cachedCount = repo.countPendingAll(db);
    return cachedCount;
  }

  /** 组装告警信息（供界面顶部横幅/自检项直接显示，见 mockData 的「MES 上报队列」自检项） */
  function buildAlert(pending) {
    return {
      warn: pending >= warnThreshold,
      pendingCount: pending,
      capacity: queue.capacity,
      text: pending > 0 ? `MES 上报队列：待补传 ${pending} 条` : 'MES 上报队列：无待补传',
      overflow: pending >= queue.capacity
    };
  }

  /**
   * 回写一条重报结果（内部共用实现：单条与批量走同一条路径，避免两处口径不一致）。
   * **只写库、不刷缓存、不写日志** —— 批量调用方在外面统一收口。
   */
  function applyRetried(uploadId, result) {
    const iface = result.interface || ifaceDefault;
    const at = result.at === undefined ? nowIso() : fmtNow(result.at);
    const r = result.ok
      ? repo.markRetrySuccess(db, uploadId, iface, at)
      : repo.markRetryFailed(db, uploadId, iface, {
        responseCode: result.responseCode,
        responseBody: result.responseBody,
        failReason: result.failReason
      }, at);
    return r;
  }

  const queue = {
    capacity,
    warnThreshold,

    /**
     * ①落库留存：把一次**上报失败**的报文写进本地库（IF-B.9 / NFR-13）。
     *
     * 容量上限（A1 修）：**只拦"新键"入队**，并**拒绝入队 + 抛 `UploadQueueFullError`** 告警
     * （不再像旧实现那样 `shift()` 丢最旧）。**已存在的 uploadId 不受容量限制** ——
     * 它的重复入队是 `ON CONFLICT` 覆盖更新（刷新失败原因/响应/耗时），不新增行、不占额度；
     * 若连它也一并拒掉，队列一满就再也刷新不了那条的失败原因（本次修的正是这个顺序问题）。
     *
     * @param {{uploadId:string, serviceName?:string, methodName?:string, interface?:string,
     *          requestBody:any, responseCode?:string, responseBody?:any, elapsedMs?:number,
     *          failReason?:string, at?:Date}} entry 失败上报（uploadId 即 DR-11 的幂等键）
     * @returns {{persisted:boolean, created:boolean, uploadId:string, interface:string,
     *            pendingCount:number, alert:object}} created=false 表示覆盖了已有条目
     * @throws {UploadQueueFullError} 队列已满**且本次是新增键**（报文未被留存，调用方必须自行告警/处置）
     */
    enqueueFailed(entry) {
      if (!entry || !entry.uploadId) {
        throw new TypeError('uploadQueue.enqueueFailed: entry 必须含 uploadId（DR-11 幂等键）');
      }
      const iface = entry.interface || [entry.serviceName || 'report', entry.methodName || 'receiveReport'].join('/');
      invalidate();                                   // 入队前先拿真实条数，避免拿旧缓存判容量
      const current = computePending();
      /* 顺序很关键：**先判键是否已存在，再判容量**。已存在的键走覆盖更新，不受容量上限约束。 */
      const isNewKey = !repo.hasUploadId(db, entry.uploadId, iface);
      if (isNewKey && current >= capacity) {
        const err = new UploadQueueFullError(current, capacity);
        if (logger) logger.error('[上报队列] 拒绝入队：队列已满且为新键，报文未留存', { code: err.code, pending: current, capacity });
        throw err;
      }
      const at = entry.at === undefined ? nowIso() : fmtNow(entry.at);
      const wrote = repo.enqueueFailed(db, {
        uploadId: entry.uploadId,
        interface: iface,
        requestBody: entry.requestBody,
        responseCode: entry.responseCode,
        responseBody: entry.responseBody,
        elapsedMs: entry.elapsedMs,
        failReason: entry.failReason
      }, at);
      invalidate();
      const pending = computePending();
      const alert = buildAlert(pending);
      if (logger) {
        const detail = { uploadId: wrote.uploadId, interface: iface, pending, created: wrote.created };
        if (wrote.created) logger.warn('[上报队列] 上报失败已落库待补传', detail);
        else logger.info('[上报队列] 重复入队：覆盖更新失败原因（不新增行、不占额度）', detail);
      }
      publishUpload('enqueue-failed', {
        uploadId: wrote.uploadId, interface: iface, state: repo.STATE.PENDING,
        created: wrote.created, pendingCount: pending, alert
      });
      return {
        persisted: true, created: wrote.created,
        uploadId: wrote.uploadId, interface: iface, pendingCount: pending, alert
      };
    },

    /**
     * ①' **成功留痕**（IF-B.10 的"结果"栏）：把一次**成功**的上报记进 `upload_log`。
     *
     * 与 `enqueueFailed()` 共用同一行幂等键 `(uploadId, interface)`：
     *   · 新键 ⇒ 插一行 `成功`；已存在（首发失败过 / 人工重报过）⇒ **覆盖为成功**；
     *   · 覆盖时**保留 `retry_count`**（那是"人工重报了几次"的审计信息，不该被抹掉）；
     *   · 成功后该条**不再计入待补传**（`state='成功'` 不落在 `IN ('待补传','失败')` 里）。
     * 容量上限对本函数**不适用**：成功的报文不是"待补传积压"，没有拒收理由。
     *
     * @param {{uploadId:string, interface?:string, serviceName?:string, methodName?:string,
     *          requestBody:any, responseCode?:string, responseBody?:any, elapsedMs?:number, at?:Date}} entry
     * @returns {{persisted:boolean, created:boolean, uploadId:string, interface:string,
     *            pendingCount:number, alert:object}}
     */
    recordSuccess(entry) {
      if (!entry || !entry.uploadId) {
        throw new TypeError('uploadQueue.recordSuccess: entry 必须含 uploadId（DR-11 幂等键）');
      }
      const iface = entry.interface || [entry.serviceName || 'report', entry.methodName || 'receiveReport'].join('/');
      /* 先看这条当前是不是待办：只有"待办 → 成功"才改变待补传条数（避免无谓作废缓存） */
      const wasPending = repo.isPending(db, entry.uploadId, iface);
      const at = entry.at === undefined ? nowIso() : fmtNow(entry.at);
      const wrote = repo.recordSuccess(db, {
        uploadId: entry.uploadId,
        interface: iface,
        requestBody: entry.requestBody,
        responseCode: entry.responseCode,
        responseBody: entry.responseBody,
        elapsedMs: entry.elapsedMs
      }, at);
      if (wasPending) invalidate();
      const pending = computePending();
      const alert = buildAlert(pending);
      if (logger) {
        logger.info('[上报队列] 上报成功已留痕', {
          uploadId: wrote.uploadId, interface: iface, pending, created: wrote.created, fromPending: wasPending
        });
      }
      publishUpload('record-success', {
        uploadId: wrote.uploadId, interface: iface, state: repo.STATE.SUCCESS,
        created: wrote.created, pendingCount: pending, alert
      });
      return {
        persisted: true, created: wrote.created,
        uploadId: wrote.uploadId, interface: iface, pendingCount: pending, alert
      };
    },

    /** 该 (uploadId, interface) 是否**仍待人工补传**（已成功的条目返回 false ⇒ 重报口据此幂等跳过） */
    isPending(uploadId, iface) {
      return repo.isPending(db, uploadId, iface === undefined ? ifaceDefault : iface);
    },

    /**
     * ②查询：待补传**条数**（含人工重报过仍失败的条目）。
     * @param {boolean} [refresh] true 时强制重查（忽略缓存），缺省读缓存
     * @returns {number}
     */
    pendingCount(refresh) {
      if (refresh) invalidate();
      return computePending();
    },

    /**
     * ②查询：待补传**清单（明细）**，最旧优先（先失败先补报），供人工"一键重报"界面逐条展示。
     * @param {{limit?:number, offset?:number}} [query] 缺省 limit = listLimit（200）
     * @returns {Array<object>} 每条含 uploadId/interface/requestBody/responseCode/responseBody/
     *                          elapsedMs/retryCount/state/failReason/createdAt/updatedAt
     */
    listPending(query = {}) {
      const limit = Number.isInteger(query.limit) && query.limit > 0 ? query.limit : listLimit;
      return repo.listPending(db, { limit, offset: query.offset });
    },

    /** ②查询：队列状态汇总（条数/容量/最早一条时间/是否告警），供巡检与界面横幅 */
    status() {
      const s = repo.stats(db, { capacity, warnThreshold });
      cachedCount = s.pending;
      return Object.assign({}, s, { alert: buildAlert(s.pending) });
    },

    /** 按 uploadId 取一条（人工重报前确认报文内容） */
    get(uploadId, iface) {
      return repo.getByUploadId(db, uploadId, iface === undefined ? undefined : iface);
    },

    /**
     * ③标记**单条**重报结果（人工触发后回写）。
     *   · `ok === true`  → 状态置 `成功`、从待补传清单移除；
     *   · `ok === false` → **保留在队列里**、`retry_count` 累加 1，并记录本次失败原因/响应。
     * 成功与失败都返回最新条数与告警信息；`updated === 0` 表示该条已不在队列（可能已被处理）。
     *
     * @param {string} uploadId
     * @param {{ok:boolean, interface?:string, responseCode?:string, responseBody?:any,
     *          failReason?:string, at?:Date}} result 本次重报结果
     * @returns {{updated:number, retryCount:number|null, pendingCount:number, alert:object}}
     */
    markRetried(uploadId, result) {
      if (!uploadId) throw new TypeError('uploadQueue.markRetried: 必须给出 uploadId');
      if (!result || typeof result.ok !== 'boolean') {
        throw new TypeError('uploadQueue.markRetried: result.ok 必须是布尔值（true 成功 / false 仍失败）');
      }
      const r = applyRetried(uploadId, result);
      invalidate();
      const pending = computePending();
      const alert = buildAlert(pending);
      if (logger) {
        const detail = { uploadId, interface: result.interface || ifaceDefault, pending, updated: r.updated };
        if (result.ok) logger.info('[上报队列] 人工重报成功，已移出队列', detail);
        else logger.warn('[上报队列] 人工重报仍失败，保留在队列并累加重试次数', detail);
      }
      publishUpload(result.ok ? 'retry-ok' : 'retry-fail', {
        uploadId, interface: result.interface || ifaceDefault,
        state: result.ok ? repo.STATE.SUCCESS : repo.STATE.FAILED,
        retryCount: r.retryCount, updated: r.updated, pendingCount: pending, alert
      });
      return { updated: r.updated, retryCount: r.retryCount, pendingCount: pending, alert };
    },

    /**
     * ③标记**批量**重报结果（人工一键重报后逐条回写）。
     * 单条入参非法**不中断整批**（记入 `skipped`），因为人工重报的批次通常来自多个 uploadId，
     * 让一条脏数据打断整批会让"重报结果"丢掉一部分、反而更容易丢数。
     *
     * @param {Array<{uploadId:string, ok:boolean, interface?:string, responseCode?:string,
     *                responseBody?:any, failReason?:string, at?:Date}>} results
     * @returns {{total:number, succeeded:number, stillFailed:number, skipped:number,
     *            pendingCount:number, alert:object, details:Array<object>}}
     */
    markRetriedBatch(results) {
      if (!Array.isArray(results)) {
        throw new TypeError('uploadQueue.markRetriedBatch: 入参必须是数组');
      }
      const details = [];
      let succeeded = 0;
      let stillFailed = 0;
      let skipped = 0;
      for (const item of results) {
        if (!item || !item.uploadId || typeof item.ok !== 'boolean') {
          skipped++;
          details.push({ uploadId: item && item.uploadId ? item.uploadId : null, skipped: true, reason: '入参缺少 uploadId 或 ok' });
          continue;
        }
        const r = applyRetried(item.uploadId, item);
        details.push({ uploadId: item.uploadId, ok: item.ok, updated: r.updated, retryCount: r.retryCount });
        if (item.ok) succeeded++; else stillFailed++;
      }
      invalidate();
      const pending = computePending();
      const alert = buildAlert(pending);
      if (logger) {
        logger.info('[上报队列] 批量重报结果已回写',
          { total: results.length, succeeded, stillFailed, skipped, pending });
      }
      publishUpload('retry-batch', {
        uploadId: null, interface: ifaceDefault, state: repo.STATE.PENDING,
        updated: succeeded, pendingCount: pending, alert,
        /* 批次明细另带两个计数（不进 `state`：批次里成功与仍失败并存，用单一 state 表达会失真） */
        batch: { total: results.length, succeeded, stillFailed, skipped }
      });
      return { total: results.length, succeeded, stillFailed, skipped, pendingCount: pending, alert, details };
    },

    /** 告警快照（读缓存；供界面取用，**不引入定时器**） */
    alert() {
      return buildAlert(computePending());
    },

    /** 清空条数缓存（外部直接改动过库、或自检需要强制重查时调用） */
    refresh() {
      invalidate();
      return computePending();
    }
  };

  return queue;
}

module.exports = {
  DEFAULT_CAPACITY,
  DEFAULT_LIST_LIMIT,
  DEFAULT_WARN_THRESHOLD,
  configWarnThreshold,
  UploadQueueFullError,
  createUploadQueue
};
