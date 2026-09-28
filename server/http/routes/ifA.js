/* ==========================================================================
   IF-A 接收路由挂载（server/http/routes/ifA.js）—— W2（服务层第二笔 · 第 2 波）
   作用：把 `server/services/dispatch.js` 的 `receive()` / `authorize()` 接到 HTTP 面上。
         本文件**只做 HTTP 适配**：鉴权 → 读体 → 服务层 → 稳定 JSON 响应；
         不写第二条校验/幂等/落库路径（口径只有一份，见 dispatch.js）。
   端点（路径**定长**，与 `server/http/router.js` 的精确匹配器能力匹配，**未扩展路由表**）：
     · `POST /ifa/dispatch`  派工信息（IF-A.1）→ `task`（DR-02，幂等）
     · `POST /ifa/material`  物料信息（IF-A.2）→ `op_log` 留痕（幂等，见 dispatch.js 的落库口径）
     · `POST /ifa/process`   工艺信息（IF-A.3）→ `op_log` 留痕（幂等；相机设定值以 IF-A 为权威）
     · `POST /ifa/device`    设备运行信息（IF-A.4）→ `device`（DR-01，**equipCode 权威写入点**）
     · `GET  /ifa/status`    接收状态：计数 / 访问控制（含未配置告警）/ 权威侧与冲突 / 最近一次
   HTTP 状态码口径（**沿用 `server/http/router.js` 的统一错误体形状**）：
     · 200 报文被**收下**（`outcome='stored'` 落库 / `'duplicate'` 幂等命中 —— 重复**不算错误**，
       与 DR-13「重复帧不算错误」、`POST /ifd/frame` 的 200 口径一致；若回 4xx，MES 侧会当失败而重发）
     · 400 报文被**拒收**（缺字段/类型错/时间非法/数量非法 —— 响应体带 `err.code` / `err.field` / `err.reason`）
     · 401/403 **鉴权拒绝**（未携带 / 令牌不匹配）——⚠ 鉴权**先于**报文校验，故拒绝原因永远是"鉴权"
       而不是"参数"（W2 判据②）；两者都落 `op_log`（`result='失败'`）且**不落任何业务表**
     · 413 请求体超限、400 坏 JSON —— 由 `router.readJson()` 的统一口径给出（**在鉴权通过之后**）
     · 503 接收服务未接库（`NO_DB`：装配问题，不是报文问题）
     · 500 写库失败（`DB_WRITE_FAILED`：内部故障，已留痕）
   可见提示（FR-1.2 / IF-D.12 / C-100 / C-102）：权威不一致时 200 响应体里带
     `warnings[]`（每条含 code / 两侧取值 / 人可读 message）与 `warning`（拼成一句，便于人眼）；
     同时已落 `op_log`（`op_type='IF-A权威不一致'`），并可在 `GET /ifa/status` 常显 —— **不静默**。
   依赖：`server/services/dispatch.js`、`server/http/router.js`（复用 readJson/json/errorBody）。
   ========================================================================== */
'use strict';

const { createDispatch, KIND } = require('../../services/dispatch');
const { errorBody } = require('../router');

/** 进程内实例池（无 `deps.dispatch` 注入时复用；键＝`db` 句柄本身，不把句柄转成字符串）。
 *  为什么要池：`POST /ifa/*` 是**进程级**端点，而服务层持有计数、访问控制与"最近一次权威值"状态；
 *  每请求各建一份会让 `/ifa/status` 永远显示"收过 0 条"（那就等于没有状态可观测）。 */
const pool = { byDb: new WeakMap(), nullDb: null };

/**
 * 取（或惰性创建）IF-A 接收服务实例。
 * 显式注入（`deps.dispatch`）优先 —— 自检据此注入固定时钟/库/鉴权配置。
 */
function resolveDispatch(deps = {}) {
  if (deps.dispatch) return deps.dispatch;
  const db = deps.db || null;
  const cached = db ? pool.byDb.get(db) : pool.nullDb;
  if (cached) return cached;
  const created = createDispatch({
    db,
    logger: deps.logger || null,
    now: deps.now,
    auth: deps.auth,
    localEquipCode: deps.localEquipCode,
    ifd: deps.ifd,
    operator: deps.operator,
    teamCode: deps.teamCode,
    env: deps.env,
    /* W5-①：事件总线透传（`task` 事件在 dispatch 的派工落库点发布） */
    bus: deps.bus
  });
  if (db) pool.byDb.set(db, created); else pool.nullDb = created;
  return created;
}

/** 鉴权失败的响应体（`ok:false` + 统一 `err` 形状 + 显式的 `outcome='unauthorized'`） */
function authFailBody(auth, kind, path, method) {
  const b = errorBody(auth.code, auth.reason, auth.httpStatus);
  return Object.assign({
    ok: false, mount: 'ifA', kind, outcome: 'unauthorized',
    auth: auth.auth, at: auth.at, path, method
  }, b);
}

/** 拒收的响应体（补出机器可读的 `err.field` / `err.reason`，与 `POST /ifd/frame` 同口径） */
function rejectBody(result, kind, path, method) {
  const status = (result.error && result.error.httpStatus) || 400;
  const base = errorBody(result.error.code, result.error.reason, status);
  return Object.assign({
    ok: false, mount: 'ifA', kind, outcome: result.outcome, at: result.at, path, method,
    err: Object.assign(base.err, { field: result.error.field, reason: result.error.reason })
  });
}

/**
 * 挂载 IF-A 的 HTTP 面。
 * @param {object} router `server/http/router.js` 的 createRouter() 产物
 * @param {{db?:object, dispatch?:object, logger?:object, now?:Function,
 *          auth?:{enabled:boolean,token:string}, localEquipCode?:string,
 *          ifd?:object|Function, operator?:string, teamCode?:string}} [deps]
 * @returns {{mount:'ifA', mounted:boolean, by:'W2', routes:string[], instance:object, status:Function}}
 *          `mounted:true` 才是"已接线"的**显式**状态（与 W6 空壳 `mountIfA()` 的 `mounted:false`
 *          形成可核查对照，见 D23 反静默空转）。
 */
function mountIfA(router, deps = {}) {
  if (!router || typeof router.post !== 'function' || typeof router.get !== 'function') {
    throw new TypeError('mountIfA: 必须传入 server/http/router.js 的 router（缺少 post/get）');
  }
  const dispatch = resolveDispatch(deps);
  const routes = [];

  /** 生成某一类入站的处理器（一个入口形状，四类共用；口径只在服务层一份） */
  const register = kind => {
    const path = `/ifa/${kind}`;
    router.post(path, async (req, res) => {
      const meta = { path, method: 'POST', kind, remote: (req.socket && req.socket.remoteAddress) || '' };
      /* ① 鉴权先于报文校验：拒绝原因必须是"鉴权"而不是"参数"（W2 判据②）。
         未配置访问控制时 `authorize()` 直接放行（并已在挂载时告警）。 */
      const a = dispatch.authorize(req.headers, meta);
      if (!a.ok) {
        /* 不读体就回：把未消费的请求体排空，避免客户端在写一半时收到 RST（本地/局域网链路更干净） */
        try { req.resume(); } catch { /* 已断开 */ }
        return router.json(res, a.httpStatus, authFailBody(a, kind, path, 'POST'));
      }
      /* ② 读体（坏 JSON ⇒ 400、超限 ⇒ 413 —— router 的统一口径） */
      const body = await router.readJson(req);
      /* ③ 业务处理（校验 → 权威比对 → 落库 → 留痕；返回值即全部结论，不抛） */
      const r = dispatch.receive(kind, body, meta);
      if (!r.ok) return router.json(res, r.error.httpStatus || 400, rejectBody(r, kind, path, 'POST'));
      return router.json(res, 200, Object.assign({
        ok: true, mount: 'ifA', kind, label: r.label, outcome: r.outcome, stored: r.stored,
        key: r.key, table: r.table, sig: r.sig, ledgerId: r.ledgerId, idempotency: r.idempotency,
        unknown: r.unknown, warnings: r.warnings, auth: a.auth, at: r.at,
        device: r.device
      }, r.warnings.length ? { warning: r.warnings.map(w => w.message).join('；') } : {}));
    });
    routes.push(`POST ${path}`);
  };

  register(KIND.DISPATCH);
  register(KIND.MATERIAL);
  register(KIND.PROCESS);
  register(KIND.DEVICE);

  /* 查询：GET /ifa/status（计数 / 访问控制降级状态 / 权威侧与冲突 / 最近一次） */
  router.get('/ifa/status', (req, res) => {
    const body = dispatch.status();
    return router.json(res, 200, Object.assign({}, body, { routes }));
  });
  routes.push('GET /ifa/status');

  return {
    mount: 'ifA',
    mounted: true,
    by: 'W2',
    routes,
    instance: dispatch,
    /** 供启动日志/巡检聚合（**不改 `/health`、不改前端**） */
    status: () => Object.assign({}, dispatch.status(), { routes })
  };
}

module.exports = { mountIfA, resolveDispatch, authFailBody, rejectBody };
