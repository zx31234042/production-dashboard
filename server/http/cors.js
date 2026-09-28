/* ==========================================================================
   跨源访问控制（server/http/cors.js）—— 负责人裁定「选项 A」（2026-09-28）
   背景：看板前端是**双击 `index.html`** 打开的（`file://` 协议），浏览器给它发的 `Origin`
        是**字面量 `null`**；而 `/state`、`/events`（EventSource）、`POST /upload/retry`
        都要跨源取数 ⇒ 没有 CORS 应答头时浏览器会直接拦下（前端表现为"黑屏/无数据"）。
   裁定口径（**严格按裁定实现，不自行放宽**）：
     · 白名单**只有三类**：`null`（file://）＋ `http://127.0.0.1:<实际端口>` ＋
       `http://localhost:<实际端口>`（端口取**实际监听端口**，不写死 8787；`::1` 同形一并收）。
     · **`null` 源的放行有前提**：仅当**绑定回环地址**（`127.0.0.1` / `::1` / `localhost`）时
       才回 `Access-Control-Allow-Origin`；**绑定非回环地址时一律不回任何 CORS 头**
       （跨源由浏览器拦下）—— 守 `NFR-25` / `AC-09`「不得对外」。
     · 允许方法 `GET, POST, OPTIONS`；允许头 `Content-Type, Authorization`；
       **绝不**回 `Access-Control-Allow-Credentials`（本项目用 `Bearer` 头，不用 Cookie）；
       `Access-Control-Max-Age` 给小值（默认 600）。
     · `Origin` 缺失（同源页面 / curl / 测试夹具）⇒ **行为与现状一致**，不新增任何限制。
     · 预检只对**已注册路径**（含静态白名单）应答；未注册路径的 `OPTIONS` 仍走既有 404/405 口径。
     · 拒绝**不写 `console.error`**（避免踩"无红色报错"门禁）：走 `logger.warn`。
   依赖：仅 node 内置 + `platform/clock` 形态的注入约定（本文件**不取时间**，故无时钟出口；
        时间戳留痕由调用方 logger 负责）。零第三方依赖。
   用法：
     const cors = createCors({ logger, bind: () => ({ host, port }) });
     // 在 http.Server 的 request 回调最前面：
     if (cors.handle(req, res, { path, knownPath })) return;   // true = 已应答（预检/拒绝）
   ========================================================================== */
'use strict';

const { errorBody } = require('./router');

/** 预检缓存时长（秒）：小值即可 —— 开发期改端口/改配置后不该被浏览器长缓存挡住 */
const DEFAULT_MAX_AGE = 600;

/** 允许的请求方法/请求头（裁定原文；**不是**通配符 `*`，避免被当成"什么都允许"） */
const ALLOW_METHODS = 'GET, POST, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization';

/**
 * 是否回环地址（**与 `server/index.js` 同一判据**：`127.0.0.1` / `::1` / `localhost`）。
 * 判据只有一份实现（index.js 从这里取用），避免"两处都判、两处能漂移"。
 */
function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/**
 * 创建 CORS 中间件。
 * @param {{logger?:object, maxAge?:number, bind?:Function}} [options]
 *   `bind()` 返回**当前实际**的绑定 `{host, port}`（监听前/后都能读；端口不写死）。
 * @returns {{handle:Function, apply:Function, evaluate:Function, origins:Function, allowMethods:string,
 *            allowHeaders:string, maxAge:number}}
 */
function createCors(options = {}) {
  const logger = options.logger || null;
  const maxAge = Number.isInteger(options.maxAge) && options.maxAge >= 0 ? options.maxAge : DEFAULT_MAX_AGE;
  const readBind = typeof options.bind === 'function' ? options.bind : () => ({ host: '', port: 0 });

  /** 当前白名单（按**实际端口**生成；`null` 恒在其中，但是否放行还要看绑定地址） */
  function origins() {
    const b = readBind() || {};
    const list = new Set(['null']);
    if (b.port) {
      list.add(`http://127.0.0.1:${b.port}`);
      list.add(`http://localhost:${b.port}`);
      list.add(`http://[::1]:${b.port}`);
    }
    return list;
  }

  /** 取请求的 Origin（浏览器发的是字面量 `null`；数组形态取第一个） */
  function originOf(req) {
    const h = req && req.headers ? req.headers.origin : undefined;
    if (Array.isArray(h)) return h.length ? String(h[0]) : null;
    return typeof h === 'string' && h !== '' ? h : null;
  }

  /**
   * 判定一次请求的 CORS 结论（纯读，不改响应）。
   * @returns {{present:boolean, origin:string|null, allowed:boolean, loopback:boolean, reason:string}}
   */
  function evaluate(req) {
    const origin = originOf(req);
    const b = readBind() || {};
    const loopback = isLoopbackHost(b.host);
    if (!origin) return { present: false, origin: null, allowed: false, loopback, reason: 'no-origin' };
    if (!loopback) {
      return { present: true, origin, allowed: false, loopback, reason: 'non-loopback-bind' };
    }
    const ok = origins().has(origin);
    return { present: true, origin, allowed: ok, loopback, reason: ok ? 'allowlisted' : 'not-allowlisted' };
  }

  /** 给响应挂 CORS 头（仅"有 Origin 且在白名单且绑定回环"时挂；否则一个头都不加） */
  function apply(req, res) {
    const v = evaluate(req);
    if (!v.present || !v.allowed) return v;
    res.setHeader('Access-Control-Allow-Origin', v.origin);
    res.setHeader('Vary', 'Origin');
    return v;
  }

  /**
   * 统一入口：先判"这条路径服务端认不认"，再挂 CORS 头 / 应答预检。
   * ⚠ 顺序按 **F6（独立审查立案）** 修正：**先判 `knownPath`，未注册路径一个 CORS 头都不挂**。
   *   旧写法先 `apply()` 后判 knownPath ⇒ `OPTIONS /nope` + `Origin: null` 会变成
   *   "404 且带 `Access-Control-Allow-Origin: null`"，与"非白名单源一个头都不回"的口径不自洽。
   *   口径统一为：**本服务只对自己真正提供的路径表态** —— 404 是"这里没有这个资源"，
   *   与"允许哪个源跨源读它"无关，故连头都不加。
   * @param {object} req
   * @param {object} res
   * @param {{path?:string|null, knownPath?:boolean|Function}} [opts]
   *   `knownPath` —— 该路径是否**已注册**（精确路由或静态白名单）；未注册路径不在这里应答，
   *   继续走 `router.handle()` 的既有 404/405 口径（裁定原文要求）。
   * @returns {boolean} true = 本次请求已应答，调用方不要再往下走
   */
  function handle(req, res, opts = {}) {
    const known = typeof opts.knownPath === 'function' ? opts.knownPath(opts.path) : opts.knownPath !== false;
    if (!known) return false;                     // 未注册路径 ⇒ 不表态（无 CORS 头），交给 404/405
    const v = apply(req, res);
    if (String(req && req.method ? req.method : '').toUpperCase() !== 'OPTIONS') return false;
    if (!v.present) return false;                 // 无 Origin ⇒ 现状口径（同源/curl 不受影响）

    if (!v.allowed) {
      /* 非白名单源：**一个 CORS 头都不回** + 明确的 403（不得是 500，也不得含糊成 200）。 */
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[CORS] 预检被拒：来源不在白名单（不回任何 CORS 头）',
          { origin: v.origin, path: opts.path || null, reason: v.reason });
      }
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(Object.assign(
        errorBody('CORS_ORIGIN_DENIED',
          `来源 ${v.origin} 不在白名单（${[...origins()].join(' / ')}）；且仅回环绑定才允许跨源`, 403),
        { ok: false, path: opts.path || null, method: 'OPTIONS' })));
      return true;
    }

    res.writeHead(204, {
      'Access-Control-Allow-Origin': v.origin,
      'Access-Control-Allow-Methods': ALLOW_METHODS,
      'Access-Control-Allow-Headers': ALLOW_HEADERS,
      'Access-Control-Max-Age': String(maxAge),
      Vary: 'Origin',
      'Cache-Control': 'no-store'
    });
    res.end();
    return true;
  }

  return {
    handle,
    apply,
    evaluate,
    origins,
    allowMethods: ALLOW_METHODS,
    allowHeaders: ALLOW_HEADERS,
    maxAge,
    /** 供 `/health` 或启动日志自报口径（**只报告事实**） */
    status: () => {
      const b = readBind() || {};
      return {
        loopback: isLoopbackHost(b.host),
        bind: `${b.host || ''}:${b.port || ''}`,
        origins: [...origins()],
        allowMethods: ALLOW_METHODS,
        allowHeaders: ALLOW_HEADERS,
        allowCredentials: false,
        maxAge
      };
    }
  };
}

module.exports = { createCors, isLoopbackHost, DEFAULT_MAX_AGE, ALLOW_METHODS, ALLOW_HEADERS };
