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
   状态码：200（正常，含"跳过"与"本次仍失败"—— 失败已作为业务结果如实回在响应体里）；
           400（入参非法：`ids`/`limit` 形态不对）；405/404 由路由器给；500 内部故障（路由器留痕）。
   ⚠ 本包**不做**：定时上报/自动重试（W5 接线后才会有周期触发；即使那时也只调 `report()` 一次）、
      SSE 业务推送（W5）、前端切真实源（W5）、登录与口令（后续包）。
   依赖：`server/services/uploadReporter.js`、`server/http/router.js`（复用 json/readJson）。
   ========================================================================== */
'use strict';

const { createUploadReporter } = require('../../services/uploadReporter');
const { errorBody } = require('../router');

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
    timeoutMs: deps.timeoutMs
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
 * 挂载 IF-B 上报的 HTTP 面。
 * @param {object} router `server/http/router.js` 的 createRouter() 产物
 * @param {{db?:object, reporter?:object, logger?:object, now?:Function, config?:object,
 *          fetch?:Function, queue?:object, serviceName?:string, methodName?:string,
 *          capacity?:number, warnThreshold?:number, timeoutMs?:number}} [deps]
 * @returns {{mount:'upload', mounted:boolean, by:'W4', routes:string[], instance:object|null, status:Function}}
 *          `mounted:true` 才是"已接线"的**显式**状态（与 W6 空壳 `router.mountUpload()` 的
 *          `mounted:false` 形成可核查对照，D23 反静默空转）。
 */
function mountUpload(router, deps = {}) {
  if (!router || typeof router.post !== 'function' || typeof router.get !== 'function') {
    throw new TypeError('mountUpload: 必须传入 server/http/router.js 的 router（缺少 post/get）');
  }
  const routes = [];
  const reporter = (deps.reporter || deps.db) ? resolveReporter(deps) : null;

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

  /* ---- ④ 人工一键重报（**唯一**会再次发送待补传报文的入口；按序 + 幂等） ---- */
  router.post('/upload/retry', async (req, res) => {
    if (!reporter) return router.json(res, 503, noServiceBody('/upload/retry', 'POST'));
    /* 读体：坏 JSON ⇒ 400、超限 ⇒ 413（router 的统一口径；空体 ＝ 重报全部待补传） */
    const body = await router.readJson(req);
    let input;
    try {
      input = normalizeRetryInput(body);
    } catch (err) {
      return router.json(res, err.status || 400, badInputBody(err, '/upload/retry', 'POST'));
    }
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
    status: () => (reporter ? reporter.status() : { mounted: false, by: 'W4', routes })
  };
}

module.exports = { mountUpload, resolveReporter, normalizeRetryInput, queryOf };
