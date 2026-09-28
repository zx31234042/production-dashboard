/* ==========================================================================
   进程内事件总线（server/services/eventBus.js）—— W5-①「服务端 SSE 业务推送」
   作用：给"业务写入点 → 看板内部推送"提供**唯一**的一条进程内通道，零依赖、无 IO：
     ① `publish(kind, payload, {at})`：业务侧（ingest / dispatch / uploadReporter / standard /
        judge）在**真实写入点**调用；不在这里另起第二套状态（事件只是"发生了什么"的通知）；
     ② `subscribe(handler, {since})`：SSE 连接建立时订阅；返回 `{mode:'hello'|'replay', replay, missed}`，
        **同步**注册 + 同步取回补发清单 —— 这样"取补发清单"与"开始收新事件"之间不存在空隙，
        天然满足 FR-2.6 的"断线续传不丢关键值"（按序、不重复、不丢）；
     ③ **有界环形缓冲**（默认容量 512，可配）：溢出**丢最旧**并把 `dropped` **如实计数**
        （绝不静默丢弃；`stats().dropped` 可读可断言）；
     ④ **单调 `seq`**（进程内自增、从 1 起）；每条事件＝`{seq, at, kind, payload}`，
        `at` **一律来自注入时钟**（ADR-0003 D17：本文件不出现裸 `new Date()` / `Date.now()`）；
     ⑤ 订阅者抛错**逐订阅者隔离**（try/catch）：不影响其它订阅者、也不影响发布方；
        **不吞**——记日志（`logger.error`）＋ `onHandlerError` 回调 ＋ 有界错误记录（`stats().errors`）。
   事件种类（**固定**，不得自造同义名；与 `GET /events` 的 `event:` 字段逐字一致）：
     · `frame`    1 s 采样帧被接受并落库（500 ms 原始帧**不发布**，ADR-0001 D7）
     · `link`     上位机连接状态变化（在线→离线 / 离线→在线；判据真源＝`services/ingest.linkState()`）
     · `task`     派工/工单写入（`services/dispatch.js` 的 `task` 落库点）
     · `standard` 标准版本新增（`repo/standard.js` 的 `addVersion` 成功路径；被 `assertInput` 拒收则不发布）
     · `upload`   上报队列/回执状态迁移（`services/uploadQueue.js` 的落库点）
     · `warning`  判定/预警产出（`services/judge.js` 的 `evaluate()` 产出点）
   用法：
     const { createEventBus, KIND } = require('./services/eventBus');
     const bus = createEventBus({ now: clock.source(), logger, capacity: 512 });
     const sub = bus.subscribe(evt => res.write(sseFrame(evt)), { since: 42 });
     bus.publish(KIND.FRAME, payload);            // at 缺省＝注入时钟
     bus.publish(KIND.LINK, { online: false }, { at: someInjectedDate });
     bus.stats();   // { seq, dropped, buffered, capacity, subscribers, handlerErrors, errors, closed }
   依赖：`platform/clock.js`（时间的唯一来源）。**零第三方依赖。**
   ========================================================================== */
'use strict';

const platformClock = require('../../platform/clock');

/** 事件种类（固定名单；`publish()` 对名单外的 kind **直接抛错**，防"同义名"悄悄分叉） */
const KIND = Object.freeze({
  FRAME: 'frame',
  LINK: 'link',
  TASK: 'task',
  STANDARD: 'standard',
  UPLOAD: 'upload',
  WARNING: 'warning'
});

/** 固定种类清单（顺序稳定，供报错与自检打印） */
const KINDS = Object.freeze([KIND.FRAME, KIND.LINK, KIND.TASK, KIND.STANDARD, KIND.UPLOAD, KIND.WARNING]);

/** 环形缓冲默认容量：512 条 ≈ 现场几十分钟的采样事件（1 s 一条时约 8.5 分钟）＋ 状态类事件，
 *  足够覆盖"断线重连 ≤5 s"（FR-2.6）的补发需求；内存占用可忽略。 */
const DEFAULT_CAPACITY = 512;

/** 订阅者错误记录保留条数（有界，防"出错风暴"把内存吃光；计数 `handlerErrors` 不受此限） */
const ERROR_KEEP = 20;

/** 容量归一：必须是 ≥ 1 的整数；非法即抛（不静默兜底成默认值 —— 那会让"溢出丢最旧"这条判据失真） */
function normalizeCapacity(value) {
  if (value === undefined || value === null) return DEFAULT_CAPACITY;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`eventBus: capacity 必须是 ≥ 1 的整数，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * `since` 归一：**非法一律按"无 since"处理**（返回 null），由调用方退回 `hello` 快照 ——
 * 不得因为客户端带了个坏参数就 500（HTTP 层同样按这个口径）。
 * 合法＝非负安全整数（数字或纯数字字符串）。
 * @returns {number|null}
 */
function normalizeSince(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = typeof value === 'number' ? value : String(value).trim();
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) return null;   // 负数、小数、乱码一律非法
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/**
 * 创建进程内事件总线。
 * @param {{capacity?:number, now?:Function, logger?:object, onHandlerError?:Function}} [options]
 *   `now`  —— 注入时钟出口（推荐 `platformClock.createClock({mode:'real'}).source()`）；
 *             缺省＝真实时钟（与 `server/index.js`、`http/router.js` 同一形态，不新造第二套）。
 *   `logger` —— 订阅者抛错时留痕（`logger.error`）；不传时仍有 `onHandlerError` 与 `stats().errors` 兜底。
 * @returns {object} 总线实例（publish / subscribe / unsubscribe / size / stats / dropped / close）
 */
function createEventBus(options = {}) {
  const capacity = normalizeCapacity(options.capacity);
  const logger = options.logger || null;
  const onHandlerError = typeof options.onHandlerError === 'function' ? options.onHandlerError : null;
  const nowFn = typeof options.now === 'function'
    ? options.now
    : platformClock.createClock({ mode: 'real' }).source();

  /** 已发布事件的最大序号（单调，从 1 起；0＝还没发过） */
  let seq = 0;
  /** **溢出丢弃的最旧事件条数**（有界缓冲的唯一丢弃来源；如实计数、可被断言） */
  let dropped = 0;
  /** 关闭后仍被 publish 的事件条数（**单独计数**，不混进 `dropped`，否则"溢出丢最旧"这条判据会被污染） */
  let afterClose = 0;
  /** 订阅者抛错次数（含被保留的记录之外的全部次数） */
  let handlerErrors = 0;
  let closed = false;

  /** 环形缓冲：`ring[(ringStart + i) % capacity]` 从最旧到最新 */
  const ring = new Array(capacity);
  let ringStart = 0;
  let ringLen = 0;
  /** 订阅者集合（插入顺序＝投递顺序，逐个 try/catch 隔离） */
  const subscribers = new Set();
  /** 订阅者抛错记录（有界；**不吞**：日志/回调之外仍落这里供自检读） */
  const errors = [];

  /** 时间出口（唯一）：注入时钟 → ISO 串；不在此处裸取系统时间（D17） */
  const isoOf = value => platformClock.toDate(value).toISOString();
  const atOf = at => (at === undefined || at === null ? isoOf(nowFn()) : isoOf(at));

  /** 记一次订阅者错误：计数 + 有界记录 + 日志/回调（**绝不静默吞掉**） */
  function recordHandlerError(err, evt, index) {
    handlerErrors++;
    const detail = {
      seq: evt.seq,
      kind: evt.kind,
      subscriber: index,
      message: err && err.message ? err.message : String(err)
    };
    errors.push(detail);
    if (errors.length > ERROR_KEEP) errors.shift();
    let reported = false;
    if (logger && typeof logger.error === 'function') {
      logger.error('[SSE] 事件订阅者抛错（已隔离：不影响其它订阅者与发布方）', detail);
      reported = true;
    }
    if (onHandlerError) {
      try { onHandlerError(err, evt, detail); } catch { /* 回调自己坏了也不影响发布 */ }
      reported = true;
    }
    /* 既没有 logger 也没有回调时，`errors` 与 `handlerErrors` 仍是**可读的留痕**（D23：不得静默）；
       这里额外挂一个只读引用，便于自检断言"确实记了"。 */
    detail.reported = reported;
    return detail;
  }

  /** 投递给一个订阅者（逐订阅者隔离） */
  function deliver(sub, evt, index) {
    try {
      sub.handler(evt);
    } catch (err) {
      recordHandlerError(err, evt, index);
    }
  }

  const bus = {
    KIND,
    capacity,

    /**
     * 发布一条事件。
     * @param {string} kind 固定种类（KIND.*）；名单外**抛 RangeError**（防同义名分叉）
     * @param {any} payload 业务载荷（形状由各写入点的 schema 表约定）
     * @param {{at?:Date|string|number}} [opts] `at` 缺省＝注入时钟的当前时刻
     * @returns {{seq:number, at:string, kind:string, payload:any}|null} 总线已关闭时返回 null（并留痕）
     */
    publish(kind, payload, opts = {}) {
      if (!KINDS.includes(kind)) {
        throw new RangeError(
          `eventBus.publish: 未知事件种类 ${JSON.stringify(kind)}（固定种类：${KINDS.join(' / ')}；` +
          '同义名会造成前端与后端两套口径）');
      }
      if (closed) {
        afterClose++;
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[SSE] 总线已关闭：本次事件未发布（优雅退出期间属正常，运行期出现则是缺陷）', { kind });
        }
        return null;
      }
      const evt = { seq: ++seq, at: atOf(opts.at), kind, payload };
      if (ringLen < capacity) {
        ring[(ringStart + ringLen) % capacity] = evt;
        ringLen++;
      } else {
        /* 满了：**丢最旧**（写指针前移）并**显式计数** —— 这是 `dropped` 的唯一来源 */
        ring[ringStart] = evt;
        ringStart = (ringStart + 1) % capacity;
        dropped++;
      }
      let index = 0;
      for (const sub of [...subscribers]) {
        index++;
        if (evt.seq <= sub.since) continue;   // 该订阅者明确表示"只收 seq > since"
        deliver(sub, evt, index);
      }
      return evt;
    },

    /**
     * 订阅（**同步**注册 + 同步取回补发清单，两者之间无空隙）。
     *
     * @param {Function} handler `(evt) => void`；抛错被隔离（见文件头 ⑤）
     * @param {{since?:number|string|null}} [opts] 客户端游标（`Last-Event-ID` / `?since=`）
     * @returns {{mode:'hello'|'replay', since:number|null, replay:Array<object>, missed:number|null,
     *            cursorAhead:boolean, unsubscribe:Function}}
     *   `mode='replay'` ⇒ `replay` 是缓冲区里 `seq > since` 的**按序、不重、不漏**全集（可为空数组）；
     *   `mode='hello'`  ⇒ 调用方必须改发新的 `hello` 快照。三种情形都归到这里：
     *     ① 无 since（缺省/非法）；② since 太旧、缓冲区已补不齐（`missed`＝补不齐条数）；
     *     ③ **since 领先服务端**（`since > seq`，`cursorAhead=true`）—— 见下方"为什么必须查上界"。
     *
     * ⚠ **为什么必须查上界（F1，独立审查立案）**：旧实现只判 `since + 1 >= oldest`（只看下界），
     * 于是 `since > seq` 会走 replay 分支并回一个**空补发清单** ⇒ 客户端既拿不到 `hello` 快照、
     * 又因为这个虚高的 `sub.since` 把**此后所有新事件**（`seq ≤ since`）全过滤掉 ⇒
     * "心跳还在、一条数据都收不到"的**永久静默黑洞**，且重连也救不回来（`Last-Event-ID` 已被带偏）。
     * 现在：游标领先＝"服务端不知道客户端凭什么领先" ⇒ 一律回 `hello` 快照重置游标。
     */
    subscribe(handler, opts = {}) {
      if (typeof handler !== 'function') throw new TypeError('eventBus.subscribe: handler 必须是函数');
      const since = normalizeSince(opts.since);
      let mode = 'hello';
      let replay = [];
      let missed = null;
      let cursorAhead = false;
      if (since !== null) {
        if (since > seq) {
          /* ③ 游标领先服务端：不许 replay（空清单＝黑洞），交回 hello 重建游标 */
          cursorAhead = true;
        } else if (ringLen === 0) {
          /* 一条都没缓冲过：`since === seq` 时"无可补也无丢失"，但客户端仍**没有快照**
             （它可能刚启动、也可能被带偏）⇒ 一律 hello（比"空 replay 且无快照"更安全）。 */
          mode = 'hello';
        } else {
          const oldest = ring[ringStart].seq;
          if (since + 1 >= oldest) {
            mode = 'replay';
            for (let i = 0; i < ringLen; i++) {
              const e = ring[(ringStart + i) % capacity];
              if (e.seq > since) replay.push(e);
            }
          } else {
            missed = oldest - since - 1;   // 缓冲里已经补不齐的条数（如实报出，不假装补上了）
          }
        }
      }
      /* 投递下界：**replay 才沿用客户端游标**；hello（缺省/非法/领先）一律用**当前 seq** ——
         这正是 F1 的关键：若 cursorAhead 时仍沿用那个虚高的 `since`，新事件会被
         `evt.seq <= sub.since` 全部滤掉，黑洞依旧。 */
      const sub = { handler, since: mode === 'replay' ? since : seq };
      sub.mode = mode;
      sub.replay = replay;
      sub.missed = missed;
      sub.cursorAhead = cursorAhead;
      sub.unsubscribe = () => subscribers.delete(sub);
      subscribers.add(sub);
      return sub;
    },

    /** 退订：接受 `subscribe()` 的返回值，也接受 handler 函数本身；返回是否真的移除了一个订阅 */
    unsubscribe(target) {
      if (target && typeof target.unsubscribe === 'function' && subscribers.has(target)) {
        return target.unsubscribe();
      }
      let removed = false;
      for (const sub of [...subscribers]) {
        if (sub === target || sub.handler === target) { subscribers.delete(sub); removed = true; }
      }
      return removed;
    },

    /** 当前订阅者数（`GET /events` 在途连接数＝同一件事，二者同源） */
    size() { return subscribers.size; },

    /** 溢出丢弃的**最旧事件条数**（有界缓冲的唯一丢弃口径；可被直接断言） */
    dropped() { return dropped; },

    /** 已发布事件的最大序号（0＝还没发过） */
    seq() { return seq; },

    /** 缓冲区里最旧/最新事件的序号（空缓冲时为 null）—— 供补发可行性与巡检读取 */
    range() {
      if (ringLen === 0) return { oldest: null, newest: null };
      return { oldest: ring[ringStart].seq, newest: ring[(ringStart + ringLen - 1) % capacity].seq };
    },

    /** 只读状态快照（自检与运维；**不得**在此改写任何状态） */
    stats() {
      const r = bus.range();
      return {
        kind: 'eventBus',
        closed,
        seq,
        dropped,
        afterClose,
        buffered: ringLen,
        capacity,
        oldestSeq: r.oldest,
        newestSeq: r.newest,
        subscribers: subscribers.size,
        handlerErrors,
        errors: errors.slice()
      };
    },

    /**
     * 关闭总线：清空订阅者与缓冲（优雅退出的收尾；`server/index.js` 的 `stop()` 调用）。
     * 关闭后 `publish()` 返回 null 并留痕（**单独计数** `afterClose`），不影响进程退出。
     * @returns {number} 被清掉的订阅者数
     */
    close() {
      const n = subscribers.size;
      subscribers.clear();
      ringLen = 0;
      ringStart = 0;
      closed = true;
      return n;
    },

    /** 是否已关闭（自检与 `/health` 类探针可读） */
    isClosed() { return closed; }
  };

  return bus;
}

module.exports = {
  createEventBus,
  KIND,
  KINDS,
  DEFAULT_CAPACITY,
  ERROR_KEEP,
  normalizeCapacity,
  normalizeSince
};
