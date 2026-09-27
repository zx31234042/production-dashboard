/* ==========================================================================
   极简路由与 HTTP 工具（server/http/router.js）
   作用：本包（W6「进程入口与运行骨架」）**只交付骨架** ——
         ①路由器：定长路径匹配（GET/POST）、JSON 请求体解析与大小上限、
           统一的 JSON 错误响应形状（400/404/405/413/500 形状稳定）；
         ②健康检查 `GET /health`（进程能起、能查的机器可读证据，含库可写与监听地址）；
         ③后续工作包的**空壳挂载位**：`mountIfA` / `mountIfD` / `mountUpload` / `mountSSE`
           （本包**不实现**任何业务逻辑，只把挂载点与调用契约钉住）；
         ④SSE **空通道骨架**：`GET /events` 能建连、能发心跳注释帧、能优雅关闭，
           **不推送任何业务数据**（业务推送属 W5）。
   依据：W6 任务边界（`项目记录\服务层第二笔-任务分解与排期.md` 第 65 行）、
        ADR-0001 D5/D1（HTTP 服务形态）、DR/IF 契约留待三方答复。
   依赖：**仅 node: 内置模块** + 本项目 `platform/clock.js`（时间的唯一来源；仍零 npm 依赖）。
         取时间一律走注入出口（ADR-0003 D17）：SSE 注释帧的 ready/ping 与 openedAt 都经 `options.now`，
         缺省＝真实时钟 —— **本文件不出现裸 `new Date()`**。
   用法：
     const { createRouter, errorBody, MAX_JSON_BODY_BYTES } = require('./http/router');
     const router = createRouter({ getHealth: () => ({ ok: true }) });
     router.attach(httpServer);            // 绑定到 server/index.js 创建的 http.Server
     router.closeAllStreams();             // 优雅退出时先收掉在途 SSE
   ========================================================================== */
'use strict';

/* 时间来源：与 `server/index.js`、`services/dispatch.js` 用**同一套**（不新造第三套时钟机制）。
   SSE 的注释帧时间戳是给运维看的，但"展示/协议层"同样不得裸取当前时间 —— 否则用例无法复现
   "这一帧发生在哪一刻"，门禁（`tests/docs-cross-check.js` 第六节的 D17 判据）也会判红。 */
const platformClock = require('../../platform/clock');

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
     */
    async handle(req, res) {
      const path = pathnameOf(req);
      if (path === null) {
        return router.fail(res, 400, 'BAD_REQUEST_LINE', `无法解析请求行：${String(req.url).slice(0, 120)}`);
      }
      const method = String(req.method || '').toUpperCase();

      const handler = routes.get(`${method} ${path}`);
      if (!handler) {
        const allow = router.allowedMethods(path);
        if (allow.length) {
          /* 路径存在、方法不对 ⇒ 405（并给出 Allow，避免前端靠猜） */
          res.setHeader('Allow', allow.join(', '));
          return router.fail(res, 405, 'METHOD_NOT_ALLOWED',
            `${method} 不被 ${path} 支持，允许：${allow.join('/')}`, { path, method });
        }
        return router.fail(res, 404, 'NOT_FOUND', `未知路径：${path}`, { path, method });
      }

      try {
        return await handler(req, res);
      } catch (err) {
        /* 业务处理器抛出的"带状态码"错误（如 readJson 的 400/413）按其声明回；其余 500。
           500 必须**留痕**（onError）：否则现场只看到"界面报错"，日志里什么都没有。 */
        const status = Number(err && err.status) || 500;
        const code = (err && err.code) || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
        if (status >= 500 && onError) onError(err, { path, method });
        if (res.headersSent) { try { res.end(); } catch { /* 已在关闭 */ } return false; }
        return router.fail(res, status, code, (err && err.message) || String(err), { path, method });
      }
    },

    /* ---------------- 后续工作包的空壳挂载位 ---------------- */
    /**
     * 这四组函数是**挂载点占位**，本包（W6）**不实现任何业务逻辑**：
     *   `mountIfA`    —— W2：接收 MES 派工/物料/工艺（本机提供接口，IF-A）
     *   `mountIfD`    —— W1：接收上位机实时帧（IF-D，含 1 s 采样落库）
     *   `mountUpload` —— W4：IF-B 上报的**人工重报**入口与待补传清单状态接口（UI-20）
     *   `mountSSE`    —— W5：看板内部 SSE **业务推送**（本包只留空通道 `/events`）
     * 每个函数返回"未挂载"描述符而不是静默返回 undefined ——
     * 这样"本包没实现"在代码与自检里都是**显式状态**，不会被当成"已接线"（D23 反静默空转）。
     * ⚠ 实现这些包时，请把注册写进对应函数体（**不要**在入口文件里另起一套路由表，
     *   否则路由清单会分叉成两份真源）。
     */
    mountIfA() { return { mount: 'ifA', mounted: false, by: 'W2', note: 'IF-A 接收（MES 派工/物料/工艺）未实现' }; },
    mountIfD() { return { mount: 'ifD', mounted: false, by: 'W1', note: 'IF-D 上位机帧接收未实现' }; },
    mountUpload() { return { mount: 'upload', mounted: false, by: 'W4', note: 'IF-B 人工重报/待补传状态接口未实现' }; },
    mountSSE() { return { mount: 'sse', mounted: false, by: 'W5', note: 'SSE 业务推送未实现（本包只有空通道 /events）' }; },

    /* ---------------- 健康检查 ---------------- */
    async health(req, res) {
      const payload = typeof options.getHealth === 'function' ? options.getHealth() : { ok: true };
      return router.json(res, 200, Object.assign({ ok: true }, payload));
    },

    /* ---------------- SSE 空通道骨架 ---------------- */
    /**
     * `GET /events`：建立 SSE 连接 → 立刻发一个 `retry:` 与一条就绪注释帧 →
     * 之后的帧**只有心跳注释**（`: ping …`），**不含任何业务数据**。
     * 关闭路径：客户端断开（`close`）或进程优雅退出时 `closeAllStreams()`；
     * 两者都走同一个 `cleanup`，保证定时器与集合条目不残留。
     */
    events(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'   // 若日后置于反向代理之后，禁掉代理缓冲
      });
      /* retry：告诉浏览器断线后 3 s 重连（W5 的"断线重连 ≤5 s"口径由此起步）。 */
      res.write('retry: 3000\n\n');
      res.write(`: ready ${nowIso()}\n\n`);

      const entry = { res, openedAt: nowIso(), heartbeats: 0, closed: false };
      entry.timer = setInterval(() => {
        if (entry.closed || res.writableEnded) return;
        entry.heartbeats++;
        res.write(`: ping ${nowIso()}\n\n`);
      }, heartbeatMs);
      /* unref：心跳本身不该让进程"无法退出"（真正的存活由监听套接字负责） */
      if (typeof entry.timer.unref === 'function') entry.timer.unref();

      entry.close = () => {
        if (entry.closed) return;
        entry.closed = true;
        clearInterval(entry.timer);
        streams.delete(entry);
        try { res.end(); } catch { /* 已断开 */ }
      };
      /* 客户端断开 / 连接被销毁 ⇒ 同一套清理（否则定时器与集合条目会残留） */
      res.on('close', () => {
        if (entry.closed) return;
        entry.closed = true;
        clearInterval(entry.timer);
        streams.delete(entry);
      });
      streams.add(entry);
      return true;
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

  /* 内建端点：健康检查与 SSE 空通道。挂载位（mountIfA 等）本包**不调用**。 */
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
