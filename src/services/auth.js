/* ==========================================================================
   会话出口（services/auth.js）—— T-20261002-15（技术债 E86① 的前端接线）
   需求：FR-8.1（看板输入解锁）、FR-8.4（改密）、NFR-14（哈希存储 / 错误次数限制）、AC-09；
        口径**唯一真源**＝`项目记录\ADR\ADR-0007-设置页口令与登录鉴权形态.md`（D1–D9）。
   作用：把「会话令牌」这件事收敛到**一个出口**（`window.BoardSession`）——
         看板前端只做三件事（ADR-0007 D5）：**提交口令、保存令牌、统一处理 401**。
   硬边界（改这里等于改 ADR-0007，必须先改 ADR）：
     · **不得**在浏览器里做哈希 / 口令比对 / 错误计数 / 锁定判定 —— 那些全在服务端
       （`server/services/auth.js`：scrypt + 独立盐 + fail_count/locked_until 落库）；
       本文件只搬运**服务端给出的结论**（`errorCode` / `retryAfterSec`）；
     · 令牌保存位置＝**内存 + `sessionStorage`**（关窗即弃），**明令禁止 `localStorage`**
       （D3 与 D7 的被否方案：长期驻留、本地翻取成本低）；
     · **与 IF-A 的静态访问令牌严格分开**（D3）：本文件只认 `/auth/login` 下发的会话令牌，
       绝不读 `BoardConfig.server.ifAuth.token`；
     · 零 npm 依赖、零 CDN、无 DOM 操作（PROJECT_RULES 9.2：services 层不碰 DOM）；
       不使用裸 `new Date()`（ADR-0003 D17）——本文件不取时间，`expiresAt` 一律用服务端给的文本；
     · 所有失败路径**收敛成返回值**，绝不抛未捕获异常（调用方据此显示"可见降级"）。
   令牌的一生：`login()` 拿到 ⇒ `save()` 写入内存 + sessionStorage ⇒ 各处由 `token()` 取用
     （唯一 HTTP 出口 `services/api.js` 的 `httpJson()` 把它装成 `Authorization: Bearer`）；
     `logout()` / 改密 / 任何一次**会话类 401** ⇒ `clear()`。
   刷新页面的口径（**显式**，不假装已登录）：sessionStorage 里的令牌仍在（同标签页刷新不丢），
     但**解锁位** `state.unlocked` 一并复位 —— 前端**不凭一个未经校验的令牌自称已登录**
     （D5 禁止"假装已登录"）；重新解锁会重新走 `POST /auth/login` 并换发新令牌。
   依赖：`services/api.js`（全仓唯一的服务端 HTTP 出口；本文件**不另起** fetch）。
   ========================================================================== */
window.BoardSession = (function () {
  'use strict';

  /** sessionStorage 的键名（**不得**改用 localStorage：ADR-0007 D3/D7） */
  const STORAGE_KEY = 'board.session.token';
  /** 本轮唯一的用户名（服务端 `auth_credential` 也只有这一行；D1） */
  const DEFAULT_USERNAME = 'admin';
  /** 统一 401 处理认的机器可读码（服务端口径：`401 { ok:false, error:'unauthorized' }`） */
  const UNAUTHORIZED_CODE = 'unauthorized';

  /* 内存态（唯一真源；sessionStorage 只是同一份状态的"同标签页随刷新存活"副本） */
  let mem = { token: '', username: '', expiresAt: '' };
  /* 最近一次"会话失效"的可读说明（统一 401 处理的**记账位**；由界面渲染成可见提示） */
  let lostNote = '';

  /** 取 API 出口（能力检测：裁剪环境/测试桩件下缺失 ⇒ 返回 null，调用方如实降级） */
  function api() {
    const a = window.Api;
    return a || null;
  }

  /**
   * 取 `sessionStorage`（**能力检测 + try/catch**：隐私模式/裁剪环境可能抛或被禁）。
   * @returns {Storage|null} 不可用时返回 null —— 令牌退化为"仅内存"（仍然可用，只是刷新即丢）
   */
  function storage() {
    try {
      const s = window.sessionStorage;
      if (!s || typeof s.getItem !== 'function' || typeof s.setItem !== 'function') return null;
      return s;
    } catch (err) {
      return null;
    }
  }

  function persist() {
    const s = storage();
    if (!s) return false;
    try {
      if (mem.token) s.setItem(STORAGE_KEY, JSON.stringify(mem));
      else s.removeItem(STORAGE_KEY);
      return true;
    } catch (err) {
      return false;
    }
  }

  /** 从 sessionStorage 读回（**只在内存为空时**读一次；坏数据一律当未登录，不猜） */
  function restore() {
    if (mem.token) return mem;
    const s = storage();
    if (!s) return mem;
    try {
      const raw = s.getItem(STORAGE_KEY);
      if (!raw) return mem;
      const o = JSON.parse(raw);
      if (o && typeof o.token === 'string' && o.token) {
        mem = {
          token: o.token,
          username: typeof o.username === 'string' ? o.username : '',
          expiresAt: typeof o.expiresAt === 'string' ? o.expiresAt : ''
        };
      } else {
        s.removeItem(STORAGE_KEY);          // 形状不对：清掉，绝不半信半疑地用
      }
    } catch (err) {
      try { s.removeItem(STORAGE_KEY); } catch (e2) { /* 清不掉也不影响"按未登录处理" */ }
    }
    return mem;
  }

  /** 保存服务端下发的登录态（`POST /auth/login` 的响应体） */
  function save(result) {
    const r = result || {};
    mem = {
      token: typeof r.token === 'string' ? r.token : '',
      username: typeof r.username === 'string' ? r.username : DEFAULT_USERNAME,
      expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : ''
    };
    persist();
    return mem;
  }

  /** 清空本地登录态（**令牌一清即视为未登录**；服务端那一侧是否仍有效由服务端说了算） */
  function clear() {
    mem = { token: '', username: '', expiresAt: '' };
    const s = storage();
    if (s) { try { s.removeItem(STORAGE_KEY); } catch (err) { /* 清不掉不改变"已按未登录处理" */ } }
    return true;
  }

  /** 当前会话令牌（无则空串；调用方**不伪造**） */
  function token() {
    return restore().token || '';
  }

  function username() {
    return restore().username || '';
  }

  function expiresAt() {
    return restore().expiresAt || '';
  }

  function isLoggedIn() {
    return !!token();
  }

  /** 鉴权头（给唯一 HTTP 出口用；未登录时返回空对象 ⇒ 请求头与不带鉴权时逐字节相同） */
  function authHeaders() {
    const t = token();
    return t ? { Authorization: 'Bearer ' + t } : {};
  }

  /* ---------------- 统一 401 处理（ADR-0007 D5 的第三件事） ---------------- */

  /**
   * 判定"这一次失败是不是**会话失效**"。
   *
   * ⚠ 为什么不能"见到 401 就当会话失效"：`server/services/auth.js` 里有**两种** 401 ——
   *   · `unauthorized`     —— 会话令牌缺失/伪造/过期/已登出（**这才是会话失效**，必须清令牌 + 显式提示）；
   *   · `bad_credentials`  —— 口令错（登录、以及改密时的"原口令不正确"）／`bad_init_code` 一次性码错。
   *   后两种 401 与"登录态"无关：把它们当成会话失效会**误清掉仍然有效的令牌**
   *   （实测形态：改密时原口令敲错 ⇒ 前端把登录态丢掉，操作人被迫重新解锁）。故**按码区分**。
   * @param {{status?:number, errorCode?:string, path?:string}} info
   * @returns {boolean}
   */
  function isSessionLoss(info) {
    const i = info || {};
    if (i.status !== 401) return false;
    const code = String(i.errorCode || '');
    if (code) return code.toLowerCase() === UNAUTHORIZED_CODE;
    /* 没有机器可读码（老版本/中间层）：非 `/auth/*` 端点的 401 按会话失效处理（从严一侧） */
    return !/^\/auth\//.test(String(i.path || ''));
  }

  /**
   * **统一 401 处理**：`services/api.js` 的 `httpJson()` 是唯一 HTTP 出口，它对每个 401 调这里。
   * 动作只有两件：①清掉本地令牌；②记一条**可见**说明（界面下一帧渲染成提示，不黑屏、不抛异常）。
   * @param {{path?:string, status?:number, errorCode?:string, reason?:string}} info
   * @returns {string} 记账后的说明（'' ＝ 本次 401 与会话无关，未记账）
   */
  function noteUnauthorized(info) {
    const i = info || {};
    if (!isSessionLoss(i)) return '';
    clear();
    const why = i.reason ? '（' + String(i.reason) + '）' : '';
    lostNote = '未登录或登录已过期' + why;
    return lostNote;
  }

  /** 最近一次"会话失效"的说明（'' ＝ 无）；供界面渲染可见提示 */
  function lostNoteOf() {
    return lostNote;
  }

  /** 清掉"会话失效"记账（**只有成功登录**才清；与 ADR-0007 D2「只有成功才清零」同一纪律） */
  function clearLost() {
    lostNote = '';
    return true;
  }

  /* ---------------- 三个动作（提交口令 / 保存令牌 / 失效即清） ---------------- */

  /** API 出口不可用时的**如实**结论（形状与 Api.auth* 的归一化结果一致） */
  function apiMissing() {
    return {
      ok: false, status: null, errorCode: 'no_api', url: '',
      reason: '服务端接口未装配（window.Api 不可用）', body: null
    };
  }

  /**
   * 解锁（FR-8.1）：把口令**原样**提交给 `POST /auth/login`，成功即保存服务端下发的令牌。
   * **前端不比对、不哈希、不计数**（D5）——错误原因（口令错/锁定/未初始化）全部由服务端给出。
   * @param {string} password 口令（只在本次调用内存在；不缓存、不落盘）
   * @param {string} [user]
   * @returns {Promise<object>} 归一化结果（`ok/status/errorCode/reason/retryAfterSec/token/...`）
   */
  function login(password, user) {
    const a = api();
    if (!a || typeof a.authLogin !== 'function') return Promise.resolve(apiMissing());
    return a.authLogin(password, user || DEFAULT_USERNAME).then(r => {
      if (r && r.ok && r.token) {
        save(r);
        clearLost();          // 成功即清（与 D2「只有成功登录才清零」同口径）
      }
      return r;
    }).catch(err => ({
      ok: false, status: null, errorCode: 'client_error', url: '',
      reason: (err && err.message) || String(err), body: null
    }));
  }

  /**
   * 登出（FR-8.2 的"5 分钟到点同步登出"）：**先清本地**再通知服务端 ——
   * 顺序不能反：`logout` 请求若因网络失败，本地也必须已回到"未登录"（否则界面看着已锁、令牌还在）。
   * @returns {Promise<object>} 服务端结论（无令牌时如实返回 `skipped`，不当成失败）
   */
  function logout() {
    const t = token();
    clear();
    const a = api();
    if (!t) return Promise.resolve({ ok: true, skipped: true, reason: '本窗口没有会话令牌，无需登出' });
    if (!a || typeof a.authLogout !== 'function') {
      return Promise.resolve({ ok: false, skipped: false, errorCode: 'no_api', reason: '服务端接口未装配（window.Api 不可用）；本地令牌已清除', body: null });
    }
    return a.authLogout(t).then(r => r).catch(err => ({
      ok: false, status: null, errorCode: 'client_error', url: '',
      reason: (err && err.message) || String(err), body: null
    }));
  }

  /**
   * 改密（FR-8.4）：成功后服务端**清空该用户全部在途会话**（D8④，含当前）
   * ⇒ 本地**强制清会话**并要求重新登录（D5）。
   */
  function change(oldPassword, newPassword) {
    const a = api();
    if (!a || typeof a.authChange !== 'function') return Promise.resolve(apiMissing());
    return a.authChange(oldPassword, newPassword, token()).then(r => {
      if (r && r.ok) { clear(); clearLost(); }
      return r;
    }).catch(err => ({
      ok: false, status: null, errorCode: 'client_error', url: '',
      reason: (err && err.message) || String(err), body: null
    }));
  }

  /**
   * 本机一次性初始化（ADR-0007 D4）：`POST /auth/init {code, password}`。
   * 两条硬约束由**服务端**判（本文件只转发）：①必须来自回环；②码必须是本次进程启动生成的那一枚。
   */
  function init(code, password) {
    const a = api();
    if (!a || typeof a.authInit !== 'function') return Promise.resolve(apiMissing());
    return a.authInit(code, password).catch(err => ({
      ok: false, status: null, errorCode: 'client_error', url: '',
      reason: (err && err.message) || String(err), body: null
    }));
  }

  /** 读服务端鉴权状态（`GET /auth/status`，**无需鉴权**、不含任何秘密；D8⑦） */
  function status() {
    const a = api();
    if (!a || typeof a.authStatus !== 'function') return Promise.resolve(apiMissing());
    return a.authStatus().catch(err => ({
      ok: false, status: null, errorCode: 'client_error', url: '',
      reason: (err && err.message) || String(err), body: null
    }));
  }

  return {
    /* 令牌的一生 */
    token, username, expiresAt, isLoggedIn, authHeaders, save, clear, restore,
    /* 三个动作 + 状态读取 */
    login, logout, change, init, status,
    /* 统一 401 处理 */
    isSessionLoss, noteUnauthorized, lostNote: lostNoteOf, clearLost,
    /* 常量（自检与排查读它，避免断言里抄字面量） */
    STORAGE_KEY, DEFAULT_USERNAME, UNAUTHORIZED_CODE
  };
})();
