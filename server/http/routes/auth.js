/* ==========================================================================
   鉴权路由挂载（server/http/routes/auth.js）—— W5-③（服务层第二笔）
   作用：把 `server/services/auth.js` 的 init/login/logout/change/status 接到 HTTP 面上。
         本文件**只做 HTTP 适配**：读体 → 服务层 → 稳定 JSON 响应；**不写第二条校验/哈希/计数路径**
         （口径只有一份，见 auth.js）。
   端点（路径**定长**，与 `server/http/router.js` 的精确匹配器能力一致，**未扩展路由表**）：
     · `POST /auth/init   {code, password}`               本机回环 + 一次性初始化码（ADR-0007 D4）
     · `POST /auth/login  {username?, password}`          成功 ⇒ `{ok,token,username,expiresAt}`
     · `POST /auth/logout`（Bearer）                      令牌即刻失效
     · `POST /auth/change {oldPassword, newPassword}`（Bearer）改密并**清当前会话**
     · `GET  /auth/status`                                `{ok, initialized, username, locked, ...}`（无秘密）
   HTTP 状态码口径（与 ADR-0007 D2/D4 逐条对应；错误体形状＝`{ok:false, error:'<码>', ...}`）：
     · 200 成功
     · 400 `bad_password`   口令不符合口径（长度/与用户名相同/与原口令相同）
     · 401 `bad_credentials` 口令错**或**用户不存在（对外不区分）｜`bad_init_code` 初始化码错/已作废
           ｜`unauthorized` 会话令牌缺失/伪造/过期/已登出
     · 403 `not_loopback`   非回环来源（即使带对初始化码也拒）
     · 409 `not_initialized` 未初始化 ｜`already_initialized` 已初始化
     · 423 `locked`         锁定中（带 `retryAfterSec`；**口令正确也拒**）
     · 413/400 请求体超限 / 非法 JSON —— 由 `router.readJson()` 的统一口径给出（**口径不变**）
   阶段一说明：本文件**尚未**接进 `server/index.js`（W5-③ 阶段一只交付挂载口，接线由阶段二一次性完成），
     故当前没有生产调用方；自检在进程内 `createRouter() + mountAuth()` 上做端到端断言。
   依赖：`server/services/auth.js`、`server/http/router.js`（复用 readJson/json）、`platform/clock.js`。
   ========================================================================== */
'use strict';

const platformClock = require('../../../platform/clock');
/* **F19-4**：服务层的**结构化白名单**（滤掉 `__internal` 与内部键名 `failCount`/`remainingAttempts`）。
   本文件**只输出 `toPublic()` 的结果** —— 原来靠"本文件里的手写白名单 + 注释"挡内部字段，
   多一个调用方（CLI/巡检/未来的 MES 侧）只要 `Object.assign({}, result)` 就会重新泄漏。
   本轮 F19-4 的处置明确要求本文件改为只输出 `toPublic()` 结果（本文件是本包自己的产物）。 */
const { toPublic } = require('../../services/auth');

/** 从 `Authorization: Bearer <token>` 取令牌（缺省返回空串；**不**兼容裸令牌 —— 与 IF-A 明确分开） */
function readBearer(req) {
  const headers = (req && req.headers) || {};
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const m = /^Bearer\s+(.+)$/i.exec(String(value || '').trim());
  return m ? m[1].trim() : '';
}

/** 来源 IP：**一律取 socket**，不信任何请求头（ADR-0007 D2/D4 —— `X-Forwarded-For` 可伪造） */
function remoteOf(req) {
  return (req && req.socket && req.socket.remoteAddress) || '';
}

/**
 * 挂载鉴权的 HTTP 面。
 * @param {object} router `server/http/router.js` 的 createRouter() 产物
 * @param {{auth:object, logger?:object, now?:Function}} deps
 *   `auth` —— **必须**注入 `server/services/auth.js` 的 `createAuth()` 产物（显式装配，缺了就抛错：
 *             "静默挂一个空鉴权"会让 `/auth/*` 全部 200 而实际没有校验）
 *   `now`  —— 注入时钟（缺省＝platform/clock 真实时钟）；仅用于响应里的 `at` 与日志
 * @returns {{mount:'auth', mounted:boolean, by:string, routes:string[], instance:object, status:Function}}
 */
function mountAuth(router, deps = {}) {
  if (!router || typeof router.post !== 'function' || typeof router.get !== 'function') {
    throw new TypeError('mountAuth: 必须传入 server/http/router.js 的 router（缺少 post/get）');
  }
  const auth = deps.auth;
  if (!auth || typeof auth.status !== 'function' || typeof auth.login !== 'function') {
    throw new TypeError('mountAuth: 必须注入 auth 服务实例（server/services/auth.js 的 createAuth() 产物）');
  }
  const logger = deps.logger || null;
  const nowFn = typeof deps.now === 'function'
    ? deps.now
    : platformClock.createClock({ mode: 'real' }).source();
  const atNow = () => platformClock.fmt(nowFn());
  const routes = [];

  /**
   * 服务层结果 → HTTP 响应体：**只带对外字段**（`httpStatus` 等内部字段不外泄）。
   *
   * ⚠ **两层硬口径**：
   *  ① **结构层（F19-4）**：先过服务层导出的 `toPublic()` —— 它滤掉 `__internal` 命名空间与
   *     内部键名（`failCount`/`remainingAttempts`）。**本函数只读 `toPublic()` 的结果**，
   *     不再依赖"本文件手写白名单恰好没列这两个键"（那是靠人记性，多一个调用方就漏）。
   *  ② **形状层（F17-8①）**：即便过了 `toPublic()`，对外也只按下面的白名单取键
   *     （服务层结果里的 `httpStatus` 等同样不外发）。
   *  为什么这两层都必要：`failCount`/`remainingAttempts` **只对"确实存在的用户"出现** ⇒ 转发出去
   *  等于把"用户不存在 vs 口令错"分开（违反 ADR-0007 D2"对外错误不区分原因"，可用于枚举用户名）。
   *  断言：`tests\db-check.js` 九之三 HTTP 段（"两种失败的对外正文逐字节同形状"＋ `toPublic` 白名单）。
   */
  const bodyOf = raw => {
    const r = toPublic(raw);
    if (r.ok) {
      const body = { ok: true };
      for (const k of ['token', 'username', 'expiresAt', 'absoluteExpiresAt', 'initialized',
        'isInitial', 'requireRelogin', 'sessionsCleared', 'sessionsRemaining']) {
        if (r[k] !== undefined) body[k] = r[k];
      }
      body.at = atNow();
      return body;
    }
    const body = { ok: false, error: r.error };
    /* 对外**只**补可操作的信息：锁定剩余秒数、口令口径原因、锁定未知标记（F17-2）。
       令牌/哈希/明文/内部字段一律不进响应。 */
    if (r.retryAfterSec !== undefined) body.retryAfterSec = r.retryAfterSec;
    if (r.lockedUntil !== undefined) body.lockedUntil = r.lockedUntil;
    if (r.lockedUnknown === true) body.lockedUnknown = true;   // F17-2：只在"锁定态读不懂"时出现
    if (r.reason !== undefined && (r.error === 'bad_password' || r.error === 'locked' ||
      r.error === 'not_initialized' || r.error === 'not_loopback' || r.error === 'already_initialized')) {
      body.reason = r.reason;
    }
    body.at = atNow();
    return body;
  };

  const send = (res, r) => router.json(res, r.httpStatus || (r.ok ? 200 : 400), bodyOf(r));

  /* ---------------- POST /auth/init ---------------- */
  router.post('/auth/init', async (req, res) => {
    const body = await router.readJson(req);          // 413/400 走 router 的统一口径
    const r = auth.init({
      code: body && body.code,
      password: body && body.password,
      username: body && body.username,
      remote: remoteOf(req)
    });
    if (!r.ok && logger && typeof logger.warn === 'function' && r.error === 'not_loopback') {
      logger.warn(`[鉴权] 初始化被拒（非回环来源 ${remoteOf(req) || '(未知)'}）`);
    }
    return send(res, r);
  });
  routes.push('POST /auth/init');

  /* ---------------- POST /auth/login ---------------- */
  router.post('/auth/login', async (req, res) => {
    const body = await router.readJson(req);
    const r = auth.login({
      username: body && body.username,
      password: body && body.password,
      remote: remoteOf(req)
    });
    if (!r.ok && logger && typeof logger.warn === 'function') {
      logger.warn(`[鉴权] 登录被拒：${r.error}（来源 ${remoteOf(req) || '(未知)'}` +
        `${r.retryAfterSec !== undefined ? `，剩余 ${r.retryAfterSec} s` : ''}）`);
    }
    return send(res, r);
  });
  routes.push('POST /auth/login');

  /* ---------------- POST /auth/logout（Bearer） ---------------- */
  router.post('/auth/logout', async (req, res) => {
    await router.readJson(req);                        // 排空请求体（空体 ⇒ {}，不算坏请求）
    return send(res, auth.logout({ token: readBearer(req), remote: remoteOf(req) }));
  });
  routes.push('POST /auth/logout');

  /* ---------------- POST /auth/change（Bearer） ---------------- */
  router.post('/auth/change', async (req, res) => {
    const body = await router.readJson(req);
    return send(res, auth.change({
      token: readBearer(req),
      oldPassword: body && body.oldPassword,
      newPassword: body && body.newPassword,
      remote: remoteOf(req)
    }));
  });
  routes.push('POST /auth/change');

  /* ---------------- GET /auth/status（**不含任何秘密**） ----------------
     ⚠ **F17-8② 边界登记（复核低危，只登记不改行为）**：本端点**无需鉴权**即可读
     `failCount / lockedUntil / lockedUnknown / isInitial / sessions / initCodePending`。
     逐项核过：**没有秘密**（无 salt/hash/令牌/初始化码本身），但确实暴露了"当前是否被锁定、锁到几点、
     失败了几次、有几个在途会话"。裁定为**登记备查**（现场是单人本机看板，锁屏前谁都能看到屏幕；
     且前端在未登录时正需要知道"是否已初始化 / 是否被锁"才能给出可操作提示）。
     若日后要求"锁定态也不得外泄"，改法是加一枚只读令牌或用 `X-Requested-With` 之类的**非安全**门槛 —— 须先改 ADR。 */
  router.get('/auth/status', (req, res) => {
    const st = auth.status();
    return router.json(res, 200, Object.assign({}, st, { at: atNow() }));
  });
  routes.push('GET /auth/status');

  return {
    mount: 'auth',
    mounted: true,
    by: 'W5-3',
    routes,
    instance: auth,
    /** 供启动日志/巡检聚合（**不改 `/health`、不改前端**） */
    status: () => Object.assign({}, auth.status(), { routes })
  };
}

module.exports = { mountAuth, readBearer, remoteOf };
