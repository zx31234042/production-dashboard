/* ==========================================================================
   公告写入路由挂载（server/http/routes/notice.js）—— **IF-E 写路由**，`FR-7.12`（P0）
   作用：把 `FR-7.12`（需求 `…-V1.42.md:541`：「**仅本机解锁后可新增/编辑/删除公告**」）的三个
         动作接到 HTTP 面上，并把它们落到 `repo/notice.js`（`DR-10` 的唯一写入口）＋ `op_log` 留痕。
         本文件**只做 HTTP 适配**：读体 → 鉴权 → 仓储 → 稳定 JSON；**不写第二条 SQL/留痕路径**。
   端点（路径**定长**，与 `server/http/router.js` 的精确匹配器能力匹配，**未扩展路由表**）：
     · `POST /notice`  入参 `{action:'publish'|'edit'|'delete', …}`：
         - `publish`：`{content, subType?, category?, createdBy?, validFrom?, validTo?, priority?}`
         - `edit`   ：`{id, content?, subType?, category?, validFrom?, validTo?, priority?}`（同一条**更新**）
         - `delete` ：`{id}`（硬删 ＋ **原文进 `op_log`**，理由见 `repo/notice.js` 文件头）
       成功响应**同时**带回 `notice`（这一条）与 `notices`（**前端 `state.notices` 同形**的全量读口）
       —— 前端据此就地刷新，不必再拉一次 `GET /state`（读口只有 `repo.listForBoard()` 一份）。
   鉴权（**正逆向都有**，沿 `routes/auth.js` 的登录态，不另造第二套令牌）：
     · **401 `unauthorized`**：`Authorization: Bearer <token>` 缺失/伪造/过期/已登出
       （口径真源＝`services/auth.js` 的 `verify()`，本文件不自己比对令牌）。
     · **403 `not_loopback`**：来源**不是回环**（FR-7.12 的「**仅本机**」；判据真源＝
       `services/auth.js` 的 `isLoopback()`，只看 `req.socket.remoteAddress`、不信任何请求头）。
     · **403 `locked`**：会话有效但该账号**处于锁定态**（ADR-0007 D2：锁定期间口令正确也拒）
       —— 即"有登录态但**无权限**"这一支，读的是 `auth.status().locked`（**不重算**失败次数）。
   留痕口径（DR-12／`FR-8.7`／`NFR-15`；负责人 2026-10-02 裁定「操作记录保留」）：
     · 三个动作的成功路径：**表写入与 `op_log` 同一事务**（在 `repo/notice.js` 里完成，本文件不碰 SQL）。
     · **过了鉴权闸之后**被拒的写入（回环/锁定/入参/找不到行/写失败）⇒ 追加一条 `result='失败'` 的
       `op_log`（`IF-A` 的先例：拒收也留痕）。
     · **401 不留痕**：那时连"解锁态"都不成立（`repo/opLog.js` 的口径：未解锁场景不该写日志），
       只在服务端日志里 `warn` 一条（不静默）。
   状态码：200 成功；400 入参非法（`bad_action` / `bad_value` / `BAD_JSON`）；
           401 未登录；403 非本机 / 锁定；404 目标行不存在；503 未接库；500 写库失败（路由器留痕）。
   依据：ADR-0009（D5：**不改表、不新增列**）、ADR-0007（登录态与回环判据的真源）、
        ADR-0003 D17（时间一律经注入时钟）、ADR-0004 D23（判据是行为不是源码字符串）。
   依赖：`server/repo/notice.js`、`server/http/router.js`（复用 json/readJson）、
        `server/http/routes/auth.js`（复用 `readBearer` / `remoteOf`，**不写第二份**）、
        `server/services/auth.js`（`isLoopback`）、`platform/clock.js`。**零第三方依赖**。
   ========================================================================== */
'use strict';

const platformClock = require('../../../platform/clock');
const noticeRepo = require('../../repo/notice');
const { isLoopback } = require('../../services/auth');
/* 令牌读取与来源 IP 的**唯一口径**在 `routes/auth.js`（Bearer 正则、只信 socket 不信请求头）；
   本文件复用出口，不另写第二份（两份必然漂移）。 */
const { readBearer, remoteOf } = require('./auth');

/** 允许的动作（**唯一真源**＝`repo/notice.js` 的 `ACTION`，这里只做集合判定） */
const ACTIONS = [noticeRepo.ACTION.PUBLISH, noticeRepo.ACTION.EDIT, noticeRepo.ACTION.DELETE];

/**
 * 统一错误响应体：**同时**给机器可读码（`error`，与 `/auth/*` 同形）与既有 `errorBody` 形状（`err`）。
 * 为什么两样都给：`/auth/*` 的消费方读 `body.error`，而 `src/services/api.js` 的 `httpJson()`
 * 从 `body.err.message` 取失败原因 —— 两种读者都在仓内，各给一份不如把两者都写进同一个体。
 */
function errorPayload(code, message, httpStatus, extra) {
  return Object.assign({
    ok: false,
    mount: 'notice',
    path: '/notice',
    method: 'POST',
    error: code,
    err: { code, httpStatus, message }
  }, extra || {});
}

/**
 * 挂载公告写路由。
 * @param {object} router `server/http/router.js` 的 createRouter() 产物
 * @param {{db?:object, auth:object, logger?:object, now?:Function,
 *          operator?:string, teamCode?:string}} deps
 *   `auth` —— **必须**注入 `services/auth.js` 的 `createAuth()` 产物（缺了就抛错：
 *             "静默挂一个空鉴权"会让公告写入对任何人开放）
 *   `now`  —— 注入时钟出口（ADR-0003 D17；缺省＝platform/clock 真实时钟，**不新造第二套**）
 *   `operator`/`teamCode` —— 留痕身份（缺省 null，**不猜**）；会话有效时 `operator` 取
 *             `verify()` 给出的 `username`（"谁改的"要有出处）
 * @returns {{mount:'notice', mounted:boolean, by:string, routes:string[], instance:object, status:Function}}
 */
function mountNotice(router, deps = {}) {
  if (!router || typeof router.post !== 'function') {
    throw new TypeError('mountNotice: 必须传入 server/http/router.js 的 router（缺少 post）');
  }
  const auth = deps.auth;
  if (!auth || typeof auth.verify !== 'function' || typeof auth.status !== 'function') {
    throw new TypeError('mountNotice: 必须注入 auth 服务实例（server/services/auth.js 的 createAuth() 产物）');
  }
  const db = deps.db || null;
  const logger = deps.logger || null;
  const nowFn = typeof deps.now === 'function'
    ? deps.now
    : platformClock.createClock({ mode: 'real' }).source();
  const atNow = () => platformClock.fmt(nowFn());
  const routes = [];
  /** 计数（可读、可断言；不落库 —— 落库的留痕在 `op_log`） */
  const counters = {
    publish: 0, edit: 0, delete: 0,
    rejected: 0, forbidden: 0, unauthorized: 0,
    writeFailures: 0, opLogFailures: 0
  };

  /** 把一次被拒写入记进 `op_log`（过了鉴权闸之后的拒绝；写失败**不静默**） */
  function reject(res, at, ctx, action, status, code, message, extra) {
    counters.rejected++;
    const audited = noticeRepo.auditReject(db, { now: at, operator: ctx && ctx.operator, teamCode: ctx && ctx.teamCode },
      action, code, message);
    if (audited.error) {
      counters.opLogFailures++;
      if (logger) {
        logger.warn(`[公告] 被拒写入的留痕写不进 op_log（${audited.error}）—— 拒绝结果照常返回，但审计缺这一条`);
      }
    }
    return router.json(res, status, errorPayload(code, message, status,
      Object.assign({ opLogId: audited.id, at }, extra || {})));
  }

  /* ---------------- POST /notice ---------------- */
  router.post('/notice', async (req, res) => {
    /* 读体：坏 JSON ⇒ 400、超限 ⇒ 413（router 的统一口径，本文件不另判） */
    const body = await router.readJson(req);
    const at = atNow();
    const remote = remoteOf(req);
    const action = body && typeof body.action === 'string' ? body.action.trim() : '';

    /* ---- ① 鉴权（401）：登录态＝`/auth/*` 的会话令牌（ADR-0007 D3），**不另造第二套令牌** ---- */
    const verified = auth.verify(readBearer(req));
    if (!verified.ok) {
      counters.unauthorized++;
      if (logger) {
        logger.warn(`[公告] 写入被拒（未登录/令牌无效）：action=${JSON.stringify(action)}，` +
          `来源 ${remote || '(未知)'}，原因 ${(verified && verified.reason) || verified.error}`);
      }
      return router.json(res, 401, errorPayload('unauthorized',
        (verified && verified.reason) || '会话令牌缺失/伪造/过期/已登出 —— 请先经 POST /auth/login 解锁',
        401, { at, reason: (verified && verified.reason) || null }));
    }
    /* 留痕身份：会话给出的用户名优先（"谁改的"有出处），缺则用注入值，再缺就是 null（不猜） */
    const ctx = {
      operator: verified.username || deps.operator || null,
      teamCode: deps.teamCode || null
    };

    /* ---- ② 未接库（503）：装配问题，不是报文问题（不静默假成功） ---- */
    if (!db) {
      return router.json(res, 503, errorPayload('NO_SERVICE',
        '公告仓储未装配（缺少 SQLite 句柄）—— 公告写入不可用', 503, { at }));
    }

    /* ---- ③ 权限（403 之一）：FR-7.12 的「**仅本机**」——非回环来源一律拒 ---- */
    if (!isLoopback(remote)) {
      counters.forbidden++;
      return reject(res, at, ctx, action, 403, 'not_loopback',
        `公告写入只允许来自本机回环（127.0.0.1 / ::1 / ::ffff:127.0.0.1），实际来源 ${remote || '(未知)'}`,
        { remote: remote || null });
    }

    /* ---- ④ 权限（403 之二）：会话有效但账号处于**锁定态**（ADR-0007 D2） ---- */
    const st = auth.status();
    if (st && st.locked === true) {
      counters.forbidden++;
      return reject(res, at, ctx, action, 403, 'locked',
        `账号处于锁定态（剩余 ${st.retryAfterSec === undefined ? '?' : st.retryAfterSec} s）` +
        '—— 锁定期间不允许写公告（ADR-0007 D2）',
        { lockedUntil: st.lockedUntil === undefined ? null : st.lockedUntil, retryAfterSec: st.retryAfterSec });
    }

    /* ---- ⑤ 动作与入参（400）：动作用 `action` 区分三态 ---- */
    if (ACTIONS.indexOf(action) < 0) {
      return reject(res, at, ctx, action, 400, 'bad_action',
        `action 必须是 ${ACTIONS.join(' | ')} 之一，收到 ${JSON.stringify(body && body.action)}`);
    }

    /* ---- ⑥ 落库 ＋ 同批留痕（`repo/notice.js`：BEGIN → 写表 → op_log → COMMIT） ---- */
    let out = null;
    try {
      if (action === noticeRepo.ACTION.PUBLISH) {
        out = noticeRepo.publish(db, body, { now: at, operator: ctx.operator, teamCode: ctx.teamCode });
      } else if (action === noticeRepo.ACTION.EDIT) {
        out = noticeRepo.edit(db, body, { now: at, operator: ctx.operator, teamCode: ctx.teamCode });
      } else {
        out = noticeRepo.remove(db, body, { now: at, operator: ctx.operator, teamCode: ctx.teamCode });
      }
    } catch (err) {
      /* 入参校验抛错（TypeError/RangeError）⇒ 400；其余（库写失败）⇒ 500（由 router 统一留痕） */
      const isInput = err instanceof TypeError || err instanceof RangeError;
      if (isInput) return reject(res, at, ctx, action, 400, 'bad_value', err.message);
      counters.writeFailures++;
      if (logger) logger.error(`[公告] 写库失败：action=${action}，${(err && err.message) || err}`);
      return router.json(res, 500, errorPayload('write_failed',
        `公告写入失败：${(err && err.message) || String(err)}`, 500, { at }));
    }

    /* 仓储的**业务拒绝**（未改任何字段 / 目标行不存在）：一行没写 ⇒ 也留痕（失败） */
    if (!out || out.ok !== true) {
      const code = (out && out.error) || 'write_failed';
      const status = code === 'not_found' ? 404 : 400;
      const message = code === 'not_found'
        ? `公告 #${body && body.id} 不存在（可能已被删除）—— 未做任何修改`
        : '公告内容与库内一致（没有字段发生变化）—— 未做任何修改';
      return reject(res, at, ctx, action, status, code, message, { id: (body && body.id) === undefined ? null : body.id });
    }

    /* ---- ⑦ 成功响应：本条的**前端行形状** ＋ 全量读口（与 GET /state 快照同一份投影） ---- */
    if (action === noticeRepo.ACTION.PUBLISH) counters.publish++;
    else if (action === noticeRepo.ACTION.EDIT) counters.edit++;
    else counters.delete++;
    const item = out.row ? noticeRepo.rowToItem(out.row) : (out.deleted ? noticeRepo.rowToItem(out.deleted) : null);
    if (logger) {
      logger.info(`[公告] ${out.opType} 成功（#${out.id}，操作人 ${ctx.operator || '(未记)'}，` +
        `班组 ${ctx.teamCode || '(未记)'}，op_log #${out.opLogId}）`);
    }
    return router.json(res, 200, {
      ok: true,
      mount: 'notice',
      path: '/notice',
      method: 'POST',
      action,
      id: out.id,
      opType: out.opType,
      opLogId: out.opLogId === undefined ? null : out.opLogId,
      changed: out.changed || null,
      notice: item,
      notices: noticeRepo.listForBoard(db),
      at
    });
  });
  routes.push('POST /notice');

  return {
    mount: 'notice',
    mounted: Boolean(db),
    by: 'FR-7.12',
    routes,
    instance: noticeRepo,
    /** 供启动日志/巡检聚合（**不改 `/health`、不改前端**） */
    status: () => Object.assign({ mounted: Boolean(db), by: 'FR-7.12', routes }, counters)
  };
}

module.exports = { mountNotice, errorPayload, ACTIONS };
