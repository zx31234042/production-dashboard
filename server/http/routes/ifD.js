/* ==========================================================================
   IF-D 采集路由挂载（server/http/routes/ifD.js）—— W1（服务层第二笔 · 第 2 波）
   作用：把 `server/services/ingest.js` 的 `ingestFrame()` 接到 HTTP 面上（**推送形态**），
        并把断连状态暴露成一个可查询端点。本文件**只做 HTTP 适配**：
         请求体 → `ingestFrame` → 稳定 JSON 响应；不写第二条校验/去重/落库路径。
   端点（路径**定长**，与 `server/http/router.js` 的精确匹配器能力匹配，未扩展路由表）：
     · `POST /ifd/frame`   送一帧（上位机推送；body 为扁平帧，或 `{frame:{…}}` 包装形态）
     · `GET  /ifd/status`  采集状态：断连（FR-2.6）、计数、去重口径、入站 source 启用情况
     · `GET  /ifd/health`  采集侧健康（`/health` 的 IF-D 子集，便于巡检脚本单独探）
   HTTP 状态码口径（**与 `server/http/router.js` 的统一错误体形状一致**）：
     · 200 帧被**收下**（`stored` / `duplicate` / `raw-500ms` —— 三者都不是错误，见下）
     · 400 帧被**拒收**（校验不过：字段/类型/时间/取值域）—— 响应体里带 `ok:false` 与
       `err.code` / `err.field` / `err.reason`（机器可读，不必从 message 抠字）
     · 413 请求体超限、400 坏 JSON —— 由 `router.readJson()` 的统一口径给出
     · 503 采集服务未接库（`NO_DB`：装配问题，不是报文问题，故与 400 区分）
     ⚠ 为什么 `duplicate` / `raw-500ms` 回 **200** 而不是 4xx：
       DR-13 明示"重复帧**不算错误**"（`server/repo/measure.js` 同口径），
       ADR-0001 D7 明示 500 ms 原始帧"**照收照显示**、只是不落库" —— 若回 4xx，
       上位机会把它当失败而重发，反而放大流量。故只有"报文本身不可用"才 400。
   形态不确定性（U-0.1 / Q-21 未答复）：`SOURCES` 里把两种入站形态都登记为"已实现"，
     但**启用**的那一个才是真实形态。当前启用＝**推送（HTTP POST）**；轮询（`createPoller`）
     已实现、默认未启用。答复到达后**只改本文件的一处声明**，ingest 口径不动。
   依赖：`server/services/ingest.js`、`server/http/router.js`（复用其 readJson/json/errorBody）。
   ========================================================================== */
'use strict';

const { createIngest, OUTCOME } = require('../../services/ingest');
const { errorBody } = require('../router');

/** 入站形态登记表（**只报告事实**：实现与否 / 启用与否）—— 形态待 U-0.1 答复 */
const SOURCES = Object.freeze({
  push: { kind: 'http-post', path: '/ifd/frame', implemented: true, enabled: true,
    note: '上位机主动推送：本包已接线（IF-D.7 的"建议"形态之一）' },
  poll: { kind: 'poll', implemented: true, enabled: false,
    note: '看板轮询上位机（服务端作客户端，参考 src/services/api.js:253-255 口径）：' +
      '已实现于 services/ingest.js 的 createPoller()，**默认未启用**，形态待 U-0.1 / Q-21 答复' }
});

/** 进程内实例池（无 `deps.ingest` 注入时复用；键＝`db` 句柄本身，不把句柄转成字符串） */
const pool = { byDb: new WeakMap(), nullDb: null };

/**
 * 取（或惰性创建）采集服务实例。
 * 为什么要有这个"池"：`POST /ifd/frame` 是**进程级**端点，而 ingest 需要 `db` + 时钟；
 * 显式注入（`deps.ingest`）优先，缺省时按 `db` 句柄惰性建一个并复用 —— 避免每个请求各建一份，
 * 否则"1 s 采样去重"与"最近有效帧时刻"的状态会在每请求间丢失（那就等于没有断连判据）。
 */
function resolveIngest(deps = {}) {
  if (deps.ingest) return deps.ingest;
  const db = deps.db || null;
  const cached = db ? pool.byDb.get(db) : pool.nullDb;
  if (cached) return cached;
  const created = createIngest({
    db,
    logger: deps.logger || null,
    now: deps.now,
    staleMs: deps.staleMs,
    equipCode: deps.equipCode
  });
  if (db) pool.byDb.set(db, created); else pool.nullDb = created;
  return created;
}

/** 采集状态体（`status()` 的 HTTP 形状） */
function statusBody(ingest) {
  return Object.assign({ ok: true, mount: 'ifD', sources: SOURCES }, ingest.status());
}

/**
 * 挂载 IF-D 的 HTTP 面。
 * @param {object} router `server/http/router.js` 的 createRouter() 产物（提供 route/readJson/json/fail）
 * @param {{db?:object, ingest?:object, logger?:object, now?:Function, staleMs?:number,
 *          equipCode?:string}} [deps]
 * @returns {{mount:'ifD', mounted:boolean, by:'W1', routes:string[], instance:object, status:Function}}
 *          `mounted:true` 才是"已接线"的**显式**状态（与 W6 空壳 `mountIfD()` 的
 *          `mounted:false` 形成可核查的对照，见 D23 反静默空转）。
 */
function mountIfD(router, deps = {}) {
  if (!router || typeof router.post !== 'function' || typeof router.get !== 'function') {
    throw new TypeError('mountIfD: 必须传入 server/http/router.js 的 router（缺少 post/get）');
  }
  const ingest = resolveIngest(deps);
  const push = ingest.createPushHandler({ path: '/ifd/frame' });

  /* ---- 推送：POST /ifd/frame（固定路径；路由表未扩展，精确匹配即够） ---- */
  router.post('/ifd/frame', async (req, res) => {
    const body = await router.readJson(req);          // 坏 JSON ⇒ 400、超限 ⇒ 413（router 统一口径）
    const result = push.handle(body);
    if (result.outcome === OUTCOME.REJECTED) {
      const status = result.error.code === 'NO_DB' ? 503 : 400;
      /* 复用 router 统一错误体形状（`{ok:false, err:{code,httpStatus,message}}`），
         并**补出机器可读的拒收明细** `err.field` / `err.reason`：
         现场排查要能直接拿到"哪个字段、为什么"，而不是从 message 里正则抠。 */
      return router.json(res, status, Object.assign(errorBody(result.error.code, result.error.reason, status), {
        /* `ok:false`：帧的结局不是错误（重复/原始帧都回 200），**回 4xx 时结局就是"拒收"** ——
           显式给出 `ok:false` + `outcome:'rejected'`，让实现侧只需看两个稳定字段即可分流，
           不必从 message 里抠字（`err` 仍保持 `server/http/router.js` 的统一形状）。 */
        ok: false, mount: 'ifD', outcome: result.outcome, at: result.at,
        err: Object.assign(errorBody(result.error.code, result.error.reason, status).err, {
          field: result.error.field, reason: result.error.reason
        })
      }));
    }
    return router.json(res, 200, Object.assign({
      mount: 'ifD',
      /** `stored` 才是"落了库"；`duplicate`＝幂等去重未新增行；`raw-500ms`＝原始帧只进内存（ADR-0001 D7） */
      ok: true, outcome: result.outcome, stored: result.stored,
      collectTime: result.collectTime, collectMs: result.collectMs, seq: result.seq,
      dedup: result.dedup
    }, result.dedup.fallback ? { warning: result.dedup.risk } : {}));
  });

  /* ---- 查询：GET /ifd/status（断连状态 + 计数 + source 启用情况） ---- */
  router.get('/ifd/status', (req, res) => router.json(res, 200, statusBody(ingest)));
  /* ---- 查询：GET /ifd/health（IF-D 子集，独立探针） ---- */
  router.get('/ifd/health', (req, res) => {
    const link = ingest.linkState();
    return router.json(res, 200, {
      ok: true, mount: 'ifD', link: link.state, online: link.online, staleMs: link.staleMs,
      ageMs: link.ageMs, lastAcceptedAt: link.lastAcceptedAt, reason: link.reason
    });
  });

  return {
    mount: 'ifD',
    mounted: true,
    by: 'W1',
    routes: ['POST /ifd/frame', 'GET /ifd/status', 'GET /ifd/health'],
    instance: ingest,
    /** 供 `/health` 或启动日志聚合（**不改 SSE、不改前端**） */
    status: () => statusBody(ingest)
  };
}

module.exports = { mountIfD, SOURCES, statusBody, resolveIngest };
