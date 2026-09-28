/* ==========================================================================
   极简路由与 HTTP 工具（server/http/router.js）
   作用：本包（W6「进程入口与运行骨架」）**只交付骨架** ——
         ①路由器：定长路径匹配（GET/POST）、JSON 请求体解析与大小上限、
           统一的 JSON 错误响应形状（400/404/405/413/500 形状稳定）；
         ②健康检查 `GET /health`（进程能起、能查的机器可读证据，含库可写与监听地址）；
         ③后续工作包的**挂载位**：`mountIfA` / `mountIfD` / `mountUpload` / `mountSSE`
           （W1/W2/W4 已各自接线；`mountSSE` 自 **W5-①** 起也是**真实挂载**）；
         ④SSE 通道：`GET /events`（W6 起能建连/心跳/优雅关闭；**W5-① 起推送业务事件**：
           建连发 `hello` 快照，之后逐条 `id/event/data`，并支持 `Last-Event-ID` / `?since=` 断线续传）
           ＋ `GET /state`（REST 快照，与 `hello` 的 `snapshot` **同一构造函数**产出）。
   依据：W6 任务边界（`项目记录\服务层第二笔-任务分解与排期.md` 第 65 行）、
        W5 任务边界（同文件第 58～62 行）、负责人裁定 #3「看板内部连接＝SSE」与 #4「默认仅本机」、
        ADR-0001 D5/D1（HTTP 服务形态）、DR/IF 契约留待三方答复。
   依赖：**仅 node: 内置模块** + 本项目 `platform/clock.js`（时间的唯一来源；仍零 npm 依赖）
        + `services/eventBus.js` 的 `normalizeSince`（**同一个** since 解析口径，不写第二份）。
         取时间一律走注入出口（ADR-0003 D17）：SSE 注释帧的 ready/ping/bye 与 openedAt 都经 `options.now`，
         缺省＝真实时钟 —— **本文件不出现裸 `new Date()`**。
   用法：
     const { createRouter, errorBody, MAX_JSON_BODY_BYTES } = require('./http/router');
     const router = createRouter({ getHealth: () => ({ ok: true }) });
     router.attach(httpServer);            // 绑定到 server/index.js 创建的 http.Server
     router.mountSSE({ bus, snapshot });   // W5：真实挂载（注册 GET /state，/events 转入真实推送）
     router.closeAllStreams();             // 优雅退出时先收掉在途 SSE
   ========================================================================== */
'use strict';

/* 时间来源：与 `server/index.js`、`services/dispatch.js` 用**同一套**（不新造第三套时钟机制）。
   SSE 的注释帧时间戳是给运维看的，但"展示/协议层"同样不得裸取当前时间 —— 否则用例无法复现
   "这一帧发生在哪一刻"，门禁（`tests/docs-cross-check.js` 第六节的 D17 判据）也会判红。 */
const platformClock = require('../../platform/clock');
/* since 解析口径**只有一份**（`services/eventBus.js` 的 normalizeSince）：客户端游标既可能来自
   `?since=` 也可能来自 `Last-Event-ID`，两处必须同判；在这里另写一份正则就是第二套口径（必然漂移）。 */
const { normalizeSince, KINDS: EVENT_KINDS } = require('../services/eventBus');

/** 路由允许的方法（本包只要 GET/POST；其余一律 405） */
const METHODS = ['GET', 'POST'];

/** JSON 请求体大小上限（默认 1 MiB）。超过 ⇒ 413。
 *  为什么要有上限：无上限的 `for await (const chunk of req)` 会让一条畸形请求把内存吃光 ——
 *  本服务默认只监听回环、但仍须守住"拒绝而不是被拖死"这条线（NFR-25/AC-09 的本地服务同样适用）。 */
const MAX_JSON_BODY_BYTES = 1024 * 1024;

/** SSE 心跳注释帧周期（默认 15 s）。SSE 规范允许以 `:` 开头的注释行保活；
 *  为什么必须发：中间设备/浏览器会按空闲超时断连，没有心跳就看不出"通道还在"。 */
const SSE_HEARTBEAT_MS = 15000;

/** 稳定的 JSON 响应头（统一 charset，避免中文在某些客户端被按 latin1 解） */
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/**
 * 统一的错误响应体形状（**后续所有 HTTP 工作包都必须沿用它**）：
 *   { ok:false, error:{ code:'NOT_FOUND', httpStatus:404, message:'…' }, path, method, at }
 * 为什么把 code 与 httpStatus 分开：前者给程序分支用（稳定字符串），后者给日志/代理看图；
 * 为什么不嵌业务字段：错误体在"任何端点上"都应能被同一个解析函数读懂。
 * @param {string} code    机器可读错误码（NOT_FOUND/BAD_REQUEST/…）
 * @param {string} message 人类可读说明（**必须包含是哪一步失败**，便于现场排查）
 * @param {number} status  HTTP 状态码
 */
function errorBody(code, message, status) {
  return { err: { code, httpStatus: status, message } };
}

/** 取请求的路径部分（去掉查询串与 hash），并把非法编码的路径兜住 */
function pathnameOf(req) {
  try {
    return new URL(req.url, 'http://127.0.0.1').pathname;
  } catch {
    return null;   // 形如 `GET http://` 的畸形请求行 —— 调用方按 400 处理
  }
}

/**
 * 创建路由器。
 * @param {{
 *   getHealth?: () => object,
 *   onError?: (err: Error, extra: object) => void,
 *   maxBodyBytes?: number,
 *   now?: () => (Date|string|number)
 * }} [options]
 *   getHealth    —— `GET /health` 的响应体来源（由 `server/index.js` 提供，含库可写/版本/监听地址）
 *   onError      —— 500 时的留痕回调（由入口传 logger，**不得静默**）
 *   maxBodyBytes —— 请求体上限（测试可调小以验 413）
 *   heartbeatMs  —— SSE 心跳周期（默认 15 s；调小只用于自检，不改变线上口径）
 *   now          —— **注入时钟**（缺省＝`platformClock.createClock({mode:'real'}).source()`；
 *                   与 `server/index.js` 里 IF-D/IF-A 挂载处同一形态）。
 *                   SSE 注释帧时间戳一律由它给出（D17：展示层也不留裸 `new Date()`）
 */
function createRouter(options = {}) {
  const maxBodyBytes = options.maxBodyBytes === undefined ? MAX_JSON_BODY_BYTES : options.maxBodyBytes;
  const heartbeatMs = Number(options.heartbeatMs) > 0 ? Number(options.heartbeatMs) : SSE_HEARTBEAT_MS;
  const onError = typeof options.onError === 'function' ? options.onError : null;
  /** SSE 侧留痕（订阅者抛错由总线记；这里给的是"路由装配/快照失败"这类） */
  let sseLogger = options.logger || null;
  /* 心跳定时器注入出口（F8：心跳**条数**要能被确定性验证 —— 用真定时器只能测"大概几条"）。
     命名与 `services/ingest.js` 的 `setIntervalImpl/clearIntervalImpl` 一致；缺省＝真定时器。 */
  const setIntervalImpl = typeof options.setIntervalImpl === 'function' ? options.setIntervalImpl : setInterval;
  const clearIntervalImpl = typeof options.clearIntervalImpl === 'function' ? options.clearIntervalImpl : clearInterval;
  /* 时钟注入出口（ADR-0003 D17）—— **本文件取当前时间的唯一出口**：
     `nowIso()` 把注入时钟的返回值（Date / 时间戳 / 可解析字符串都收）统一成 ISO 串，
     于是 ready / ping / openedAt 三处共用同一个出口，谁都不再直接碰 `new Date()`。 */
  const nowFn = typeof options.now === 'function'
    ? options.now
    : platformClock.createClock({ mode: 'real' }).source();
  const nowIso = () => platformClock.toDate(nowFn()).toISOString();
  /** 精确匹配表：`'GET /health'` → handler（本包不做参数化路由，W1/W2 需要时再扩展） */
  const routes = new Map();
  /** 在途 SSE 连接（优雅退出时要先收掉，避免 server.close() 一直等在途连接上） */
  const streams = new Set();
  /**
   * **兜底处理器**（可选）：精确路由全不命中时才调用，用来挂"路径是**前缀/任意**形态"的处理器
   * （本仓目前只有静态托管 `server/http/site.js` 需要它 —— 路由表是定长匹配，`/src/**` 没法用
   * 精确路由表达）。它**不写进路由表**，故不会影响既有 404/405 口径：
   * 命中且返回 true 才算已应答，否则继续走 404。
   */
  let fallback = null;
  /** SSE 业务推送的接线状态（`mountSSE()` 注入；未接线时 `/events` 仍是 W6 的"空通道"） */
  const sse = { mounted: false, bus: null, snapshot: null };

  /* ---------------- SSE 工具（本文件内部；口径与 eventBus 的 since 解析共用一份） ---------------- */

  /** 客户端游标：`?since=<seq>` 优先；给了该键但值非法 ⇒ **按无 since 处理**（不回退请求头，口径唯一）。
   *  没有该键时才看标准的 `Last-Event-ID` 头。两者都经 `normalizeSince`（同一份解析）。 */
  function readSince(req) {
    let hasQuerySince = false;
    let querySince = null;
    try {
      const url = new URL(String(req && req.url ? req.url : '/'), 'http://127.0.0.1');
      hasQuerySince = url.searchParams.has('since');
      if (hasQuerySince) querySince = normalizeSince(url.searchParams.get('since'));
    } catch {
      hasQuerySince = false;   // 畸形 URL：当作没带 since（不得因此 500）
    }
    if (hasQuerySince) return querySince;
    const headers = (req && req.headers) || {};
    const header = headers['last-event-id'];
    return normalizeSince(Array.isArray(header) ? header[0] : header);
  }

  /** 写一条业务事件帧：`id: <seq>` + `event: <kind>` + `data: <JSON>`（SSE 规范三段式） */
  function writeEvent(res, evt) {
    if (res.writableEnded || res.destroyed) return;
    res.write(`id: ${evt.seq}\nevent: ${evt.kind}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
  }

  /** `hello` 与 `GET /state` 的**同源**响应体（同一构造函数；`at`/`seq` 只在信封上，不进 snapshot） */
  function stateBody() {
    const seqNow = sse.bus && typeof sse.bus.seq === 'function' ? sse.bus.seq() : 0;
    return { ok: true, at: nowIso(), seq: seqNow, snapshot: sse.snapshot() };
  }

  /** 挂载描述符（`mountSSE()` 无参调用与真实挂载后都返回它；`mounted` 反映**实际**状态） */
  function sseDescriptor() {
    return {
      mount: 'sse',
      mounted: sse.mounted,
      by: 'W5',
      routes: sse.mounted ? ['GET /events', 'GET /state'] : ['GET /events'],
      note: sse.mounted
        ? `SSE 业务推送已接线：事件种类 ${EVENT_KINDS.join(' / ')}；心跳 ${heartbeatMs} ms；` +
          '断线续传＝`Last-Event-ID` 或 `?since=<seq>`（超缓冲退回 hello 快照）'
        : 'SSE 业务推送**未接线**（当前只有 W6 的空通道 /events）—— 在 server/index.js 调 ' +
          'mountSSE({bus, snapshot}) 接线；调用后本描述符的 mounted 即为 true'
    };
  }

  /** 记录一个处理器（方法必须是大写白名单内） */
  function route(method, pathname, handler) {
    const m = String(method).toUpperCase();
    if (!METHODS.includes(m)) throw new RangeError(`router.route: 方法 ${method} 不在 ${METHODS.join('/')} 内`);
    if (typeof handler !== 'function') throw new TypeError('router.route: handler 必须是函数');
    const key = `${m} ${pathname}`;
    if (routes.has(key)) throw new Error(`router.route: 重复注册 ${key}`);
    routes.set(key, handler);
    return router;
  }

  /** 该路径上已注册的方法（供 405 时回 `Allow` 头，并让 405 与 404 有可区分的依据） */
  function allowedMethods(path) {
    return METHODS.filter(m => routes.has(`${m} ${path}`));
  }

  const router = {
    /** 已注册路由（自检与运维可读；不含参数化路由） */
    list: () => [...routes.keys()].sort(),
    route,
    /** 直达的注册口（等价 `route('GET', …)`，供入口文件读起来更像路由表） */
    get: (pathname, handler) => route('GET', pathname, handler),
    post: (pathname, handler) => route('POST', pathname, handler),
    allowedMethods,
    maxBodyBytes,

    /**
     * 解析 JSON 请求体。
     * 判据（与本包的 400/413 断言一致）：
     *   · 字符数（不是字节数）超过上限 ⇒ 413（用字符数：解码后的大小才是真正要分配的内存）
     *   · 非空且 JSON.parse 失败          ⇒ 400（附解析器给出的原因）
     *   · 空体                            ⇒ `{}`（"无参数"不等于"坏请求"）
     */
    async readJson(req) {
      const chunks = [];
      let chars = 0;
      for await (const chunk of req) {
        const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chars += piece.toString('utf8').length;
        if (chars > maxBodyBytes) {
          const err = new Error(`请求体超过上限 ${maxBodyBytes} 字符（已读 ${chars}）`);
          err.status = 413; err.code = 'PAYLOAD_TOO_LARGE';
          throw err;
        }
        chunks.push(piece);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return {};
      try {
        return JSON.parse(text);
      } catch (e) {
        const err = new Error(`请求体不是合法 JSON：${e.message}`);
        err.status = 400; err.code = 'BAD_JSON';
        throw err;
      }
    },

    /** 统一 JSON 应答（对象/数组直接序列化；字符串原样发送，供后续端点返回 HTML 片段） */
    json(res, status, payload) {
      res.writeHead(status, JSON_HEADERS);
      res.end(JSON.stringify(payload));
      return true;
    },

    /** 统一错误应答（形状见 errorBody 的说明） */
    fail(res, status, code, message, extra) {
      const body = Object.assign(errorBody(code, message, status), extra || {});
      return router.json(res, status, body);
    },

    /**
     * 处理一条请求。`server/index.js` 只把它挂到 `http.Server` 的 `request` 事件上。
     * 判定顺序：**精确路由 → 405（路径在、方法不对）→ 兜底处理器 → 404**。
     */
    async handle(req, res) {
      const path = pathnameOf(req);
      if (path === null) {
        return router.fail(res, 400, 'BAD_REQUEST_LINE', `无法解析请求行：${String(req.url).slice(0, 120)}`);
      }
      const method = String(req.method || '').toUpperCase();

      /** 处理器（含兜底）抛错时的统一收敛：带状态码的按其声明回，其余 500 并留痕（onError） */
      const failed = err => {
        const status = Number(err && err.status) || 500;
        const code = (err && err.code) || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
        if (status >= 500 && onError) onError(err, { path, method });
        if (res.headersSent) { try { res.end(); } catch { /* 已在关闭 */ } return false; }
        return router.fail(res, status, code, (err && err.message) || String(err), { path, method });
      };

      const handler = routes.get(`${method} ${path}`);
      if (handler) {
        try {
          return await handler(req, res);
        } catch (err) {
          return failed(err);
        }
      }
      const allow = router.allowedMethods(path);
      if (allow.length) {
        /* 路径存在、方法不对 ⇒ 405（并给出 Allow，避免前端靠猜） */
        res.setHeader('Allow', allow.join(', '));
        return router.fail(res, 405, 'METHOD_NOT_ALLOWED',
          `${method} 不被 ${path} 支持，允许：${allow.join('/')}`, { path, method });
      }
      if (typeof fallback === 'function') {
        /* 兜底处理器（静态托管）：**不写路由表**；返回 true ＝已应答，否则继续走 404 */
        try {
          const done = await fallback(req, res, { path, method });
          if (done) return done;
        } catch (err) {
          return failed(err);
        }
      }
      return router.fail(res, 404, 'NOT_FOUND', `未知路径：${path}`, { path, method });
    },

    /**
     * 注册**兜底处理器**（精确路由全不命中时调用）。同一时刻只有一个：
     * 重复注册直接抛错（静默覆盖会让"谁在处理这条路径"变成不可读的隐状态）。
     * @param {(req:object, res:object, ctx:{path:string, method:string}) => (boolean|Promise<boolean>)} fn
     */
    fallback(fn) {
      if (typeof fn !== 'function') throw new TypeError('router.fallback: 必须是函数');
      if (fallback && fallback !== fn) throw new Error('router.fallback: 兜底处理器已注册（只允许一个）');
      fallback = fn;
      return router;
    },

    /** 是否已有兜底处理器（自检可读，避免"以为挂了其实没挂"） */
    hasFallback: () => typeof fallback === 'function',

    /* ---------------- 挂载位（W1/W2/W4 已接线；SSE 见下方 mountSSE） ---------------- */
    /**
     * 前三组是**空壳挂载位**（真实现分别在 `routes/ifD.js` / `routes/ifA.js` / `routes/upload.js`，
     * 由 `server/index.js` 一次性接线）：
     *   `mountIfA`    —— W2：接收 MES 派工/物料/工艺（本机提供接口，IF-A）
     *   `mountIfD`    —— W1：接收上位机实时帧（IF-D，含 1 s 采样落库）
     *   `mountUpload` —— W4：IF-B 上报的**人工重报**入口与待补传清单状态接口（UI-20）
     * 它们在**未接线**时如实自报 `mounted:false`（D23 反静默空转）；真实挂载后由各
     * `mountX()` 的返回值给出 `mounted:true`，本处不再重复一份状态。
     * ⚠ 实现这些包时，请把注册写进对应函数体（**不要**在入口文件里另起一套路由表，
     *   否则路由清单会分叉成两份真源）。
     */
    mountIfA() { return { mount: 'ifA', mounted: false, by: 'W2', note: 'IF-A 接收由 routes/ifA.js 的 mountIfA(router, deps) 接线（本处是空壳描述符）' }; },
    mountIfD() { return { mount: 'ifD', mounted: false, by: 'W1', note: 'IF-D 接收由 routes/ifD.js 的 mountIfD(router, deps) 接线（本处是空壳描述符）' }; },
    mountUpload() { return { mount: 'upload', mounted: false, by: 'W4', note: 'IF-B 上报接口由 routes/upload.js 的 mountUpload(router, deps) 接线（本处是空壳描述符）' }; },

    /* ---------------- 健康检查 ---------------- */
    async health(req, res) {
      const payload = typeof options.getHealth === 'function' ? options.getHealth() : { ok: true };
      return router.json(res, 200, Object.assign({ ok: true }, payload));
    },

    /* ---------------- SSE 业务推送（W5-①） ---------------- */
    /**
     * `GET /events`：建立 SSE 连接。
     *   · **已接线**（`mountSSE({bus, snapshot})` 调过）：
     *       ① 客户端带合法 `?since=`/`Last-Event-ID` 且缓冲区**补得齐** ⇒ 先按序补发 `seq > since`
     *          的事件，**不重复、不丢**（`eventBus.subscribe` 同步注册 + 同步取补发清单，中间无空隙）；
     *       ② 无 since（或缺省/非法/超缓冲） ⇒ 发 `event: hello`，`data` 是**完整快照**
     *          （`{ok, at, seq, snapshot}`，与 `GET /state` **同一构造函数**产出）并带 `id: <seq>`；
     *       ③ 之后逐条 `id: <seq>` + `event: <kind>` + `data: <JSON>`；`retry: 3000` 与
     *          注释心跳（`: ping …`）保留（周期由 `options.heartbeatMs` 注入）。
     *   · **未接线**（裸路由器）⇒ 仍是 W6 的空通道：`retry` + `: ready` + 心跳注释，无业务数据。
     * 关闭路径：客户端断开（`close`）或进程优雅退出时 `closeAllStreams()` —— 两者走同一套 `cleanup`
     * （清心跳定时器 + 退订总线 + 从集合移除），因此**不残留定时器**、`server.close()` 不被吊住。
     */
    events(req, res) {
      const hasBus = Boolean(sse.bus) && typeof sse.bus.subscribe === 'function';
      let sub = null;
      let hello = null;
      /* F10：**客户端原始报数**单独留存 —— `sub.since` 在 hello/领先模式下会被改写成"当前 seq"
         （那是投递下界，不是客户端报的数）。排障时要看到的是"客户端报了 10、服务端当前 3"这种
         领先幅度，故两值都要进日志。非法/缺省 ⇒ null（与 `readSince()` 的口径一致）。 */
      const reportedSince = hasBus ? readSince(req) : null;
      if (hasBus) {
        /* 顺序很关键：**先订阅**（拿到补发清单即已开始收新事件），再取快照/写响应 ——
           若反过来，两步之间发布的事件会既不在补发清单里、也不在订阅之后（＝丢事件）。 */
        sub = sse.bus.subscribe(evt => writeEvent(res, evt), { since: reportedSince });
        if (sub.mode !== 'replay') {
          try {
            hello = stateBody();
          } catch (err) {
            sub.unsubscribe();     // 快照失败 ⇒ 不留一条"挂在总线上"的空订阅
            throw err;             // 交给 router.handle 收敛成 500 JSON（此时还没写响应头）
          }
        }
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'   // 若日后置于反向代理之后，禁掉代理缓冲
      });
      /* retry：告诉浏览器断线后 3 s 重连（W5 的"断线重连 ≤5 s"口径由此起步）。 */
      res.write('retry: 3000\n\n');
      res.write(`: ready ${nowIso()}\n\n`);

      const entry = {
        res, openedAt: nowIso(), heartbeats: 0, closed: false,
        since: sub ? sub.since : null, mode: sub ? sub.mode : 'none',
        replayed: sub && sub.mode === 'replay' ? sub.replay.length : 0,
        subscription: sub
      };
      if (sub) {
        if (sub.mode === 'replay') {
          /* 补发：**同步**写（此刻不可能有并发 publish 插进来，故顺序＝seq 顺序） */
          for (const evt of sub.replay) writeEvent(res, evt);
        } else {
          /* 游标领先服务端（F1）：**必须留痕**，否则现场只看到"重连后没有数据"却不知为何。
             F10：`reportedSince` ＝客户端**原始报数**（不是被改写后的投递下界），
             `subSince` ＝改写后的投递下界（＝服务端当前 seq）—— 两个都打，领先幅度一眼可见。 */
          if (sub.cursorAhead && sseLogger && typeof sseLogger.warn === 'function') {
            sseLogger.warn('[SSE] 客户端游标领先服务端 ⇒ 改发 hello 快照重建游标（避免静默黑洞）',
              {
                reportedSince,
                subSince: sub.since,
                seq: hello.seq,
                remote: (req && req.socket && req.socket.remotePort) || null
              });
          }
          res.write(`id: ${hello.seq}\nevent: hello\ndata: ${JSON.stringify(hello)}\n\n`);
        }
      }

      entry.timer = setIntervalImpl(() => {
        if (entry.closed || res.writableEnded) return;
        entry.heartbeats++;
        res.write(`: ping ${nowIso()}\n\n`);
      }, heartbeatMs);
      /* unref：心跳本身不该让进程"无法退出"（真正的存活由监听套接字负责） */
      if (typeof entry.timer.unref === 'function') entry.timer.unref();

      /** 同一套清理：清心跳定时器 → 退订总线 → 从集合移除 → 结束响应（幂等） */
      const cleanup = () => {
        if (entry.closed) return;
        entry.closed = true;
        clearIntervalImpl(entry.timer);
        if (entry.subscription) {
          try { entry.subscription.unsubscribe(); } catch { /* 总线已关闭 */ }
        }
        streams.delete(entry);
      };
      entry.close = () => {
        if (entry.closed) return;
        /* 先给客户端一个**结束信号**（`: bye`），再收尾：客户端据此能区分"服务端主动收"与"网络断" */
        try { if (!res.writableEnded) res.write(`: bye ${nowIso()}\n\n`); } catch { /* 已断开 */ }
        cleanup();
        try { res.end(); } catch { /* 已断开 */ }
        /* SSE 是长连接：主动半关底层套接字，避免 keep-alive 下 server.close() 一直等这条连接
           （Node 的 socket.end() 会先把已缓冲的数据发完再发 FIN，故 `: bye` 不会丢）。 */
        try {
          const sock = res.socket;
          if (sock && !sock.destroyed) sock.end();
        } catch { /* 已断开 */ }
      };
      /* 客户端断开 / 连接被销毁 ⇒ 同一套清理（否则定时器与订阅会残留） */
      res.on('close', cleanup);
      streams.add(entry);
      return true;
    },

    /**
     * `GET /state`：REST 快照（`{ok:true, at, seq, snapshot}`）。
     * 与 `hello` 事件**同一构造函数**（`stateBody()`）—— 两套拼装会在前端切源时对不上。
     * 未接线 ⇒ 503（不假装成功）。
     */
    state(req, res) {
      if (!sse.mounted) {
        return router.json(res, 503, Object.assign(
          errorBody('SSE_NOT_MOUNTED', 'SSE 业务推送未接线（未调用 mountSSE({bus, snapshot})）—— /state 无快照可给', 503),
          { mount: 'sse', mounted: false, path: '/state', method: 'GET' }));
      }
      return router.json(res, 200, stateBody());
    },

    /**
     * **真实挂载** SSE 业务推送（W5-①）。
     *   · 调用一次即接线：注册 `GET /state`，并把 `/events` 从"空通道"切到"真实推送"；
     *   · **幂等**：重复调用返回同一描述符，不重复注册路由；
     *   · 未传 `deps`（或没给 bus/snapshot）⇒ 返回**当前真实状态**的描述符（此时 `mounted:false`）——
     *     这样 `server/index.js` 末尾那行"挂载位清单"在任何阶段都读得到、且不撒谎。
     * @param {{bus:object, snapshot:Function, logger?:object}} deps
     * @returns {{mount:'sse', mounted:boolean, by:'W5', routes:string[], note:string}}
     */
    mountSSE(deps) {
      const d = deps || {};
      const provided = Boolean(d.bus) || typeof d.snapshot === 'function';
      if (!provided || sse.mounted) return sseDescriptor();
      if (!d.bus || typeof d.bus.subscribe !== 'function' || typeof d.bus.publish !== 'function') {
        throw new TypeError('mountSSE: 必须注入事件总线（需含 subscribe/publish，见 services/eventBus.js）');
      }
      if (typeof d.snapshot !== 'function') {
        throw new TypeError('mountSSE: 必须注入 snapshot()（hello 与 GET /state 的**唯一同源**构造函数）');
      }
      sse.bus = d.bus;
      sse.snapshot = d.snapshot;
      if (d.logger) sseLogger = d.logger;
      route('GET', '/state', (req, res) => router.state(req, res));
      sse.mounted = true;
      if (sseLogger && typeof sseLogger.info === 'function') {
        sseLogger.info('[路由] SSE 业务推送已接线：GET /events（真实推送）＋ GET /state（同源快照）；' +
          `事件种类 ${EVENT_KINDS.join(' / ')}；心跳 ${heartbeatMs} ms`);
      }
      return sseDescriptor();
    },

    /** SSE 接线状态与总线计数（自检/巡检可读；`bus` 段来自 `eventBus.stats()`） */
    sseStatus() {
      const desc = sseDescriptor();
      return {
        mount: 'sse', mounted: sse.mounted, by: 'W5', routes: desc.routes,
        streams: streams.size, heartbeatMs,
        bus: sse.bus && typeof sse.bus.stats === 'function' ? sse.bus.stats() : null
      };
    },

    /** 在途 SSE 连接数（自检与运维可读） */
    streamCount: () => streams.size,

    /** 优雅退出第 ① 步：主动收掉全部 SSE 连接（否则 `server.close()` 会一直等在途连接上） */
    closeAllStreams() {
      const n = streams.size;
      for (const entry of [...streams]) { try { entry.close(); } catch { /* 尽力关闭 */ } }
      streams.clear();
      return n;
    }
  };

  /* 内建端点：健康检查与 SSE 通道。`/state` 由 `mountSSE()` 在接线时注册
     （未接线时它**不该**存在 —— 否则 `/state` 会给出一个"没有快照来源"的假成功）。 */
  route('GET', '/health', (req, res) => router.health(req, res));
  route('GET', '/events', (req, res) => router.events(req, res));

  return router;
}

module.exports = {
  createRouter,
  errorBody,
  pathnameOf,
  METHODS,
  MAX_JSON_BODY_BYTES,
  SSE_HEARTBEAT_MS,
  JSON_HEADERS
};
