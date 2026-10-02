/* ==========================================================================
   IF-B 上报/人工重报路由挂载（server/http/routes/upload.js）—— W4（服务层第二笔 · 第 3 波）
   作用：把 `server/services/uploadReporter.js` 的能力接到 HTTP 面上，供 **UI-20**（待补传清单与
        人工重报入口）与巡检消费。本文件**只做 HTTP 适配**：读查询串 → 服务层 → 稳定 JSON；
        不写第二条组装/发送/留存路径（口径只有一份，见 uploadReporter.js）。
   端点（路径**定长**，与 `server/http/router.js` 的精确匹配器能力匹配，**未扩展路由表**）：
     · `GET  /upload/pending` 待补传清单（条数 + 明细，最旧优先）+ 告警快照（含"待补传条数"）
     · `GET  /upload/status`  上报状态：配置（含 baseUrl 未配置的**显式**告警）/ 队列 / 告警阈值
                              / 13 字段的取数来源与缺值口径 / 最近一次上报结果 / 是否**不做自动重试**
     · `GET  /upload/last`    最近一次**组装出来**的报文（13 字段 + §1.2.5 的 `paramDataList`）
     · `POST /upload/retry`   人工一键重报（**唯一**会再次发送待补传报文的入口）：
                              入参 `{ids?:string[], limit?:number}`（空体＝全部待补传）；
                              **按序补传**、**幂等**（已成功的不再发）；未配置 MES 地址 ⇒
                              200 + `{ok:false, skipped:true, reason:'未配置 MES 地址（Q-23）'}`，
                              **一条都不发**、也不落"成功"。
   来源校验（**E87**，2026-10-02 负责人裁定**方案 b**）：`POST /upload/retry` 在**进入处理前**
     先判来源 —— **非回环 ⇒ 403 `not_loopback`**，且**不读请求体、绝不调用 `reporter.retryPending()`**
     （"不发送"是硬口径：它是全仓唯一会再次向 MES 发报文的入口，且是**批量**重发）。
     判据**只取真源、不写第二份**：`services/auth.js` 的 `isLoopback()`（ADR-0007 D4 白名单）
     ＋ `routes/auth.js` 的 `remoteOf()`（**只信 `req.socket.remoteAddress`**，不信任何请求头）
     —— 与 `routes/notice.js` 用的是同一个出口。**本轮不做登录态**（裁定原文：登录态那一半留到
     `E86①` 前端"解锁 ⇒ 会话令牌"接线落定后另行加）⇒ 零前端依赖、不引 `readBearer`、不改前端。
     留痕口径（**只 `warn`，不写 `op_log`** —— 理由见下方 `forbiddenBody()` 的注释）。
   状态码：200（正常，含"跳过"与"本次仍失败"—— 失败已作为业务结果如实回在响应体里）；
           400（入参非法：`ids`/`limit` 形态不对）；**403（非回环来源，E87）**；
           405/404 由路由器给；500 内部故障（路由器留痕）。
   ⚠ 本包**不做**：定时上报/自动重试（W5 接线后才会有周期触发；即使那时也只调 `report()` 一次）、
      SSE 业务推送（W5）、前端切真实源（W5）、登录与口令（后续包）。
   依赖：`server/services/uploadReporter.js`、`server/http/router.js`（复用 json/readJson）、
        `server/services/auth.js`（`isLoopback`）、`server/http/routes/auth.js`（`remoteOf`）、
        `platform/clock.js`（时间唯一出口）。**零第三方依赖**。
   ========================================================================== */
'use strict';

const platformClock = require('../../../platform/clock');
const { createUploadReporter } = require('../../services/uploadReporter');
const { errorBody } = require('../router');
/* **E87**：回环判据与来源 IP 的**唯一真源**，本文件不另写第二份（两份必然漂移）：
     · `isLoopback`  —— `services/auth.js`（ADR-0007 D4：127.0.0.1 / ::1 / ::ffff:127.0.0.1）；
     · `remoteOf`    —— `routes/auth.js`（**只取 socket 地址**，`X-Forwarded-For` 一律不信），
                        与 `routes/notice.js:41` 复用同一个出口。
   本轮**不引 `readBearer`**：负责人 2026-10-02 裁定方案 b —— 只加回环校验，登录态留到 `E86①` 之后。 */
const { isLoopback } = require('../../services/auth');
const { remoteOf } = require('./auth');

/** 进程内实例池：`POST /upload/*` 是**进程级**端点，而站点实例持有"尝试次数/最近结果"等状态；
 *  每请求各建一份会让 `/upload/status` 永远显示"还没发过"（等于没有状态可观测）。
 *  键＝`db` 句柄本身（`WeakMap`，不把句柄转字符串），与 `routes/ifA.js` 的池同款。 */
const pool = { byDb: new WeakMap(), nullDb: null };

/** 取（或惰性创建）上报器实例。显式注入（`deps.reporter`）优先 —— 自检据此注入 mock 发送/固定时钟。 */
function resolveReporter(deps = {}) {
  if (deps.reporter) return deps.reporter;
  const db = deps.db || null;
  const cached = db ? pool.byDb.get(db) : pool.nullDb;
  if (cached) return cached;
  const created = createUploadReporter({
    db,
    logger: deps.logger || null,
    now: deps.now,
    config: deps.config,
    fetch: deps.fetch,
    queue: deps.queue,
    serviceName: deps.serviceName,
    methodName: deps.methodName,
    capacity: deps.capacity,
    warnThreshold: deps.warnThreshold,
    timeoutMs: deps.timeoutMs,
    /* W5-①：事件总线透传（`upload` 事件在待补传队列的真实状态迁移点发布） */
    bus: deps.bus
  });
  if (db) pool.byDb.set(db, created); else pool.nullDb = created;
  return created;
}

/** 查询串解析（只支持 `?k=v&k2=v2` 这一层，够本端点的 `limit` / `ids` 用；不引第三方解析器） */
function queryOf(req) {
  const raw = req && req.url ? String(req.url) : '';
  const i = raw.indexOf('?');
  if (i < 0) return {};
  const out = {};
  for (const part of raw.slice(i + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const v = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

/** 入参校验：`limit` 必须是正整数；`ids` 必须是字符串数组（逗号分隔或数组）。非法 ⇒ 抛 400。 */
function normalizeRetryInput(body) {
  const out = {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('请求体必须是 JSON 对象（可空体 ＝ 重报全部待补传）');
    err.status = 400; err.code = 'BAD_BODY'; err.field = '(body)';
    throw err;
  }
  if (body.limit !== undefined && body.limit !== null && body.limit !== '') {
    const n = Number(body.limit);
    if (!Number.isInteger(n) || n < 1) {
      const err = new Error(`limit 必须是 ≥ 1 的整数，收到 ${JSON.stringify(body.limit)}`);
      err.status = 400; err.code = 'BAD_VALUE'; err.field = 'limit';
      throw err;
    }
    out.limit = n;
  }
  if (body.ids !== undefined && body.ids !== null && body.ids !== '') {
    const arr = Array.isArray(body.ids) ? body.ids : String(body.ids).split(',');
    const ids = arr.map(s => String(s).trim()).filter(Boolean);
    if (!ids.length) {
      const err = new Error('ids 不能是空数组/空串（要重报全部请传空体或省略该键）');
      err.status = 400; err.code = 'BAD_VALUE'; err.field = 'ids';
      throw err;
    }
    out.ids = ids;
  }
  return out;
}

/** 未接库/未接上报器时的稳定错误体（装配问题，不是报文问题） */
function noServiceBody(path, method) {
  return Object.assign({
    ok: false, mount: 'upload', mounted: false, path, method,
    note: '上报服务未装配（缺少 SQLite 句柄或显式注入的上报器）'
  }, errorBody('NO_SERVICE', '上传/重报服务未装配：既没有 db 也没有注入 reporter', 503));
}

/** 入参非法的 400 响应体（统一 `err` 形状 + `ok:false` + 机器可读的 `field`）。
 *  为什么不直接用 `router.fail()`：它只给 `{err,path,method,extra}`，**没有 `ok:false`** ——
 *  而本模块的成功/跳过/失败响应一律带 `ok`，缺了它前端得靠"有没有 err"分支，形状不齐。
 *  `field` 照 `routes/ifA.js` 的 `rejectBody()` 放在**顶层**（与 `POST /ifd|/ifa/*` 的 400 同形）。 */
function badInputBody(err, path, method) {
  const status = Number(err && err.status) || 400;
  const b = errorBody((err && err.code) || 'BAD_VALUE', (err && err.message) || '入参非法', status);
  return Object.assign({
    ok: false, mount: 'upload', path, method,
    field: (err && err.field) || null
  }, b);
}

/**
 * **非回环来源**的 403 响应体（E87 / 方案 b）。形状与既有错误体一致：机器可读 `err.code`
 * ＋ 顶层 `ok:false`（本模块成功/跳过/失败一律带 `ok`，见上方 `badInputBody()` 的说明）
 * ＋ 顶层 `error`（与 `/auth/*`、`/notice` 的 `error` 同一词形 `not_loopback`，两种读者都能读）。
 *
 * **留痕口径＝只 `warn`，不写 `op_log`**（本包的选择，理由三条，均可核查）：
 *   ① `server/repo/opLog.js:91-92` 明写"**未解锁场景不该写日志**，故这里不设缺省班组" ——
 *      本包按裁定**没有登录闸** ⇒ 非回环来源连"本机会话"都不成立，正属"未解锁场景"；
 *   ② `/notice` 的先例（`routes/notice.js:24-25`）已把"**未过鉴权闸**的拒绝"排除在留痕之外
 *      （那里的 401 只 warn）；本包的 403 发生在**任何身份成立之前**，与那一支同类，
 *      而**不是**与"过了鉴权闸的 `403 not_loopback`"同类（那需要先有有效会话）；
 *   ③ 防"给未认证方一个落盘写原语"：E87 的暴露面正是"**LAN 内任意主机**"，若每条 403 都写
 *      一条 `op_log`，任何局域网主机都能反复触发数据库写入（审计表膨胀／淹没真正的留痕），
 *      与"把暴露收掉"的目标相悖。
 * **不静默**：调用方同时打一条 `logger.warn`（含来源、时刻、被拒原因），并在挂载对象的
 * `counters.forbidden` 上计数（供探针与巡检读取；**不进任何 HTTP 响应体**，前端与契约不动）。
 * @param {string} path 请求路径
 * @param {string} method HTTP 方法
 * @param {string} remote 来源地址（`remoteOf()` 的结果；空串＝读不到，**按非回环从严**）
 * @param {string} at 本次判定的时刻（注入时钟给出，DR-16 格式）
 */
function forbiddenBody(path, method, remote, at) {
  const b = errorBody('not_loopback',
    `人工重报（${method} ${path}）只允许来自本机回环（127.0.0.1 / ::1 / ::ffff:127.0.0.1），` +
    `实际来源 ${remote || '(未知)'} —— 已拒绝：**未读取请求体、未调用 reporter.retryPending()**，` +
    '一条报文都没有发出（E87 / 2026-10-02 负责人裁定方案 b）', 403);
  return Object.assign({
    ok: false, mount: 'upload', path, method,
    error: 'not_loopback', remote: remote || null, at
  }, b);
}

/**
 * 挂载 IF-B 上报的 HTTP 面。
 * @param {object} router `server/http/router.js` 的 createRouter() 产物
 * @param {{db?:object, reporter?:object, logger?:object, now?:Function, config?:object,
 *          fetch?:Function, queue?:object, serviceName?:string, methodName?:string,
 *          capacity?:number, warnThreshold?:number, timeoutMs?:number, bus?:object,
 *          isLoopback?:Function, remoteOf?:Function}} [deps]
 *          `isLoopback`/`remoteOf` 是**判据注入口**（缺省＝上面的真源）：只为自检能把来源伪造为
 *          非回环地址而设，**不给生产接线用**（`server/index.js` 不传这两项）。
 * @returns {{mount:'upload', mounted:boolean, by:'W4', routes:string[], instance:object|null,
 *          counters:object, status:Function}}
 *          `mounted:true` 才是"已接线"的**显式**状态（与 W6 空壳 `router.mountUpload()` 的
 *          `mounted:false` 形成可核查对照，D23 反静默空转）。
 */
function mountUpload(router, deps = {}) {
  if (!router || typeof router.post !== 'function' || typeof router.get !== 'function') {
    throw new TypeError('mountUpload: 必须传入 server/http/router.js 的 router（缺少 post/get）');
  }
  const routes = [];
  const logger = deps.logger || null;
  const reporter = (deps.reporter || deps.db) ? resolveReporter(deps) : null;
  /* 判据注入口（自检用）：缺省一律走**真源**，不另造判定 */
  const isLoopbackOf = typeof deps.isLoopback === 'function' ? deps.isLoopback : isLoopback;
  const remoteOfReq = typeof deps.remoteOf === 'function' ? deps.remoteOf : remoteOf;
  /* 时刻出口（ADR-0003 D17：不裸用 `new Date()`）；缺省＝platform/clock 真实时钟，与 `notice.js` 同款 */
  const nowFn = typeof deps.now === 'function'
    ? deps.now
    : platformClock.createClock({ mode: 'real' }).source();
  const atNow = () => platformClock.fmt(nowFn());
  /** 计数（可读、可断言；**不落库**、也不进任何 HTTP 响应体 —— 留痕口径见 `forbiddenBody()`）：
   *  `retryHandled` ＝ 已过来源校验、**进入发送步骤**的请求数（非回环被拒时它必然是 0，
   *  这正是"不发送"的结构性证据之一；发送次数的权威读数由探针在 `reporter` 桩上计数）。 */
  const counters = { retryHandled: 0, forbidden: 0 };

  /* ---- ① 待补传清单（UI-20 的主数据源） ---- */
  router.get('/upload/pending', (req, res) => {
    if (!reporter) return router.json(res, 503, noServiceBody('/upload/pending', 'GET'));
    const query = queryOf(req);
    const limit = query.limit === undefined || query.limit === '' ? undefined : Number(query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return router.fail(res, 400, 'BAD_VALUE', `limit 必须是 ≥ 1 的整数，收到 ${JSON.stringify(query.limit)}`,
        { path: '/upload/pending', method: 'GET', field: 'limit' });
    }
    const items = reporter.listPending({ limit });
    const st = reporter.status();
    return router.json(res, 200, {
      ok: true, mount: 'upload', path: '/upload/pending',
      count: st.pendingCount,
      pendingOnly: st.pendingOnly,
      failedAfterRetry: st.failedAfterRetry,
      capacity: st.capacity,
      warnThreshold: st.warnThreshold,
      overflow: st.pendingCount >= st.capacity,
      alert: st.alert,
      items
    });
  });
  routes.push('GET /upload/pending');

  /* ---- ② 上报状态（配置 / 队列 / 13 字段来源 / 最近一次 / 不做自动重试的显式声明） ---- */
  router.get('/upload/status', (req, res) => {
    if (!reporter) return router.json(res, 503, noServiceBody('/upload/status', 'GET'));
    return router.json(res, 200, Object.assign(reporter.status(), { routes }));
  });
  routes.push('GET /upload/status');

  /* ---- ③ 最近一次组装的报文（人工核对"到底要报什么"；不发送、不落库） ---- */
  router.get('/upload/last', (req, res) => {
    if (!reporter) return router.json(res, 503, noServiceBody('/upload/last', 'GET'));
    const built = reporter.buildReport({});
    if (!built.ok) {
      return router.json(res, 200, {
        ok: false, mount: 'upload', path: '/upload/last',
        available: false, error: built.error,
        note: '当前无法组装报文（原因见 error）；本端点**只读不发送**'
      });
    }
    return router.json(res, 200, {
      ok: true, mount: 'upload', path: '/upload/last', available: true,
      fields: built.fields, missing: built.missing, collectTimeFallback: built.collectTimeFallback,
      frameId: built.frameId, standardVersionNo: built.standardVersionNo,
      url: built.url, body: built.body,
      note: '本端点只组装、不发送（**不做自动上报**）；发送只在 POST /upload/retry（人工）与后续周期接线里发生'
    });
  });
  routes.push('GET /upload/last');

  /* ---- ④ 人工一键重报（**唯一**会再次发送待补传报文的入口；按序 + 幂等） ----
     **E87 来源校验在第一位**：非回环来源**在读请求体之前**就被拒（403），
     因而"读体/校验入参/调用 `retryPending()`"这三步一步都不会走到（"一条都不发"由此在结构上成立）。 */
  router.post('/upload/retry', async (req, res) => {
    /* ---- ⓪ 来源校验（E87 / 方案 b）：非回环 ⇒ 403，**绝不调用 reporter.retryPending()** ---- */
    const remote = remoteOfReq(req);
    if (!isLoopbackOf(remote)) {
      counters.forbidden++;
      const at = atNow();
      if (logger) {
        logger.warn(`[上报] 人工重报被拒（非回环来源）：${remote || '(未知)'} 于 ${at} 请求 POST /upload/retry` +
          ' —— 未读请求体、未调用 retryPending()（**一条报文都没发**）；' +
          '留痕口径＝只 warn 不写 op_log（理由见 routes/upload.js 的 forbiddenBody()）');
      }
      return router.json(res, 403, forbiddenBody('/upload/retry', 'POST', remote, at));
    }
    if (!reporter) return router.json(res, 503, noServiceBody('/upload/retry', 'POST'));
    /* 读体：坏 JSON ⇒ 400、超限 ⇒ 413（router 的统一口径；空体 ＝ 重报全部待补传） */
    const body = await router.readJson(req);
    let input;
    try {
      input = normalizeRetryInput(body);
    } catch (err) {
      return router.json(res, err.status || 400, badInputBody(err, '/upload/retry', 'POST'));
    }
    counters.retryHandled++;
    const r = await reporter.retryPending(input);
    return router.json(res, 200, Object.assign({ mount: 'upload', path: '/upload/retry', method: 'POST' }, r));
  });
  routes.push('POST /upload/retry');

  return {
    mount: 'upload',
    mounted: Boolean(reporter),
    by: 'W4',
    routes,
    instance: reporter,
    /** 来源校验的计数（E87；供自检/巡检读取，**不进 HTTP 响应体**） */
    counters,
    status: () => (reporter ? reporter.status() : { mounted: false, by: 'W4', routes })
  };
}

module.exports = { mountUpload, resolveReporter, normalizeRetryInput, queryOf };
