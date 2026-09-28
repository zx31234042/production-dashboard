/* ==========================================================================
   设置页口令与登录鉴权（server/services/auth.js）—— W5-③（服务层第二笔）
   作用：把 NFR-14 / FR-8.4 / AC-09 的"设置页口令保护"落到**服务端**，口径**唯一真源＝ADR-0007**：
         ① 凭证存储与哈希：`scryptSync(password, salt, 32, {N:16384,r:8,p:1})` + 每口令 16 字节随机盐，
            只存 hex 派生值，比较一律 `timingSafeEqual`，**任何位置不得出现明文**（D1）；
         ② 错误次数：`fail_count`/`locked_until` **落库**（重启不清零），连续 N 次失败锁定 M 分钟，
            锁定期间口令正确也拒并回剩余秒数，成功即清零（D2）；
         ③ 会话令牌：`randomBytes(32).toString('hex')`，**仅进程内存**、`Bearer` 传递、
            滑动续期 + 24 h 绝对上限、`logout`/重启即失效（D3）；
         ④ 初始化：无凭证行 ⇒ **未初始化**态；`POST /auth/init` 需"本机回环 + 本进程一次性初始化码"，
            成功后码立即作废；不设出厂默认口令（D4）。
   与 IF-A 的关系（**严格分开，互不复用/互不替代**，D3）：`server.ifAuth.token` 是**对外接口**的静态
         令牌（`services/dispatch.js` 的 `authorize()` 管），本文件的会话令牌只给看板解锁用；
         两套令牌在两边都验不过去（自检里有成对断言）。
   依赖：`node:crypto`（内建）、`server/repo/opLog.js`（**留痕唯一写入口**）、
         `platform/clock.js`（时间唯一出口，ADR-0003 D17）、`src/config/board.config.js`（配置真源）。
   **零裸时钟**：本文件不出现 `new Date()` / `Date.now()`，一律经注入的 `now()`（缺省＝platform/clock）。
   用法：
     const { createAuth } = require('./services/auth');
     const auth = createAuth({ db, logger, now: clock.source() });
     auth.init({ code: auth.initCode(), password, remote: req.socket.remoteAddress });
     const r = auth.login({ username: 'admin', password, remote });
     if (r.ok) res.setHeader('Authorization', 'Bearer ' + r.token);
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');

const opLogRepo = require('../repo/opLog');
const platformClock = require('../../platform/clock');
const boardConfig = require('../../src/config/board.config.js');

/* ---------------- 一、口径常量（改这里等于改 ADR-0007，必须同步改 ADR） ---------------- */

/** 派生算法与参数：**逐字**照 ADR-0007 D1（库里 `auth_credential.params` 也记这一串） */
const ALGORITHM = 'scrypt';
const PARAMS = 'N=16384,r=8,p=1,keylen=32';
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1 });
/** 派生密钥长度（字节） */
const KEY_LEN = 32;
/** 每口令独立随机盐（字节） */
const SALT_BYTES = 16;
/** 会话令牌长度：`randomBytes(32)` ⇒ 64 位 hex（256 bit，ADR-0007 D3） */
const TOKEN_BYTES = 32;
/** 一次性初始化码长度：`randomBytes(6)` ⇒ 12 位 hex（ADR-0007 D4） */
const INIT_CODE_BYTES = 6;
/** 口令长度口径（ADR-0007 D1）：4～64 位；不强制字符集，但不得与用户名相同 */
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 64;
/** 本轮唯一用户名（表按多行设计、唯一键 username，为将来分权留位，**不提前实现**） */
const DEFAULT_USERNAME = 'admin';

/** 内置默认（`board.config.js` 的 `server.ifAuth.*` 缺键时兜底；ADR-0007 D2/D3） */
const DEFAULTS = Object.freeze({ maxFailures: 5, lockMinutes: 5, sessionHours: 12 });
/** 会话**绝对**上限（小时）：滑动续期也不得越过它（ADR-0007 D3，防"一直用就一直有效"） */
const SESSION_ABSOLUTE_HOURS = 24;

/** 回环白名单（ADR-0007 D4）：**只看 `req.socket.remoteAddress`**，不信任何请求头 */
const LOOPBACK_ADDRESSES = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 留痕操作人：口令事件由系统记账（没有"某个人"的上下文），**来源 IP 记在 content 里** */
const AUDIT_OPERATOR = '系统';

/** 对外错误码（**固定口径**，路由按它映射 HTTP 状态码；不区分"口令错"与"用户不存在"） */
const ERROR = Object.freeze({
  NOT_INITIALIZED: 'not_initialized',        // 409：无凭证行（未初始化）
  ALREADY_INITIALIZED: 'already_initialized', // 409：已初始化，不允许二次初始化
  BAD_CREDENTIALS: 'bad_credentials',        // 401：口令错 **或** 用户不存在（对外不区分）
  BAD_INIT_CODE: 'bad_init_code',            // 401：初始化码错/已作废
  NOT_LOOPBACK: 'not_loopback',              // 403：非回环来源（即使带对码也拒）
  LOCKED: 'locked',                          // 423：锁定中（带 retryAfterSec）
  UNAUTHORIZED: 'unauthorized',              // 401：会话令牌缺失/伪造/过期/已登出
  BAD_PASSWORD: 'bad_password'               // 400：口令不符合口径（长度/与用户名相同/与原口令相同）
});

/** `op_log.op_type` 的**固定口径**（ADR-0007 D2 点名的三个用原文；其余三个在此固定下来，
 *  `repo/opLog.js` 的 `OP_TYPE` 约定值表在本单的文件边界之外，故新增词形写在这里并保持稳定） */
const OP_TYPE = Object.freeze({
  INIT_CODE: '口令初始化码',  // 进程启动时登记的一次性初始化码（**仅未初始化态**写）
  INIT: '口令初始化',         // 用初始化码设置口令的结果（成功/失败各一条）
  LOGIN: '解锁',              // ADR-0007 D2 原文：登录成功
  LOGIN_FAIL: '解锁失败',     // ADR-0007 D2 原文：口令错/用户不存在（锁定期间也写）
  LOCKED: '账号锁定',         // ADR-0007 D2 原文：连续失败达到阈值
  CHANGE: '改密',             // FR-8.4：修改口令
  LOGOUT: '登出'              // POST /auth/logout
});

/* ---------------- 二、纯函数（哈希 / 比较 / 校验 / 回环判定） ---------------- */

/**
 * 派生口令（ADR-0007 D1）：`scryptSync(password, salt, 32, {N:16384,r:8,p:1})`。
 * **口令与盐的缓冲区用后清零**（`fill(0)`）—— 明文不得在任何位置驻留；
 * 返回的 hex 串是**要存库的派生值**（不可逆），不是明文。
 * @param {string} password 明文（只在本次调用内存在）
 * @param {string} saltHex 16 字节盐的 hex
 * @returns {string} 32 字节派生值的 hex
 */
function derive(password, saltHex) {
  const pass = Buffer.from(typeof password === 'string' ? password : String(password), 'utf8');
  const salt = Buffer.from(String(saltHex || ''), 'hex');
  let key = null;
  try {
    key = crypto.scryptSync(pass, salt, KEY_LEN, SCRYPT_OPTIONS);
    return key.toString('hex');
  } finally {
    pass.fill(0);
    salt.fill(0);
    if (key) key.fill(0);
  }
}

/** 口令 → `{salt, hash}`（**新盐**：每口令独立随机，ADR-0007 D1） */
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  return { salt, hash: derive(password, salt), algo: ALGORITHM, params: PARAMS };
}

/** 常量时间比较两个 hex 派生值（长度不等/为空直接 false —— `timingSafeEqual` 对不等长会抛） */
function hashEquals(aHex, bHex) {
  const a = Buffer.from(String(aHex || ''), 'hex');
  const b = Buffer.from(String(bHex || ''), 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 令牌/初始化码的常量时间比较：先取 SHA-256 摘要（长度必然相等），口径与 `services/dispatch.js` 一致 */
function tokenEquals(a, b) {
  const ha = crypto.createHash('sha256').update(String(a === undefined || a === null ? '' : a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b === undefined || b === null ? '' : b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * 口令口径校验（ADR-0007 D1）：4～64 位、不得与用户名相同。
 *
 * ⚠ **F17-8③ 边界登记（复核低危，只登记不改行为）**：
 *   · 长度按 **UTF-16 码元**计（`String.prototype.length`）—— 非 BMP 字符（如 emoji）算 2 位；
 *   · **接受 `\u0000`**（NUL 不在任何拒绝分支里）。ADR-0007 D1 只说"4～64 位、不强制字符集"，
 *     未禁止这两点，故**保持现状**；现场口令是单人本机的短口令，不构成账号体系风险。
 *     若日后要求"按码点计长"或"禁控制字符"，须先改 ADR 再改这里（不得在实现里单方面收紧）。
 * @returns {string} `''`＝通过；否则是**不含明文**的原因（可直接回给前端）
 */
function checkPasswordPolicy(password, username) {
  if (typeof password !== 'string') return '口令必须是字符串';
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `口令长度必须在 ${PASSWORD_MIN}～${PASSWORD_MAX} 位之间`;
  }
  if (password === String(username)) return '口令不得与用户名相同';
  return '';
}

/** 回环判定（ADR-0007 D4）：只看 socket 地址，**不看任何请求头**（`X-Forwarded-For` 可伪造） */
function isLoopback(remoteAddress) {
  const a = typeof remoteAddress === 'string' ? remoteAddress.trim() : '';
  return LOOPBACK_ADDRESSES.includes(a);
}

/** 正整数取值（配置/注入项非法时退回内置默认，**不抛错**：缺键与脏值都按"用默认"处理） */
function positiveInt(value, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * 解析登录限制参数。优先级：`options.limits`（自检注入）→ `board.config.js` 的 `server.ifAuth.*`
 * → **内置默认**（ADR-0007 D2/D3）。本文件**只读**配置，不修改它。
 * @returns {{maxFailures:number, lockMinutes:number, sessionHours:number, absoluteHours:number, source:string}}
 */
function resolveLimits(config, options = {}) {
  const cfg = (config && config.server && config.server.ifAuth) || {};
  const injected = options.limits || {};
  const pick = key => {
    if (injected[key] !== undefined) return { value: positiveInt(injected[key], DEFAULTS[key]), from: 'options' };
    if (cfg[key] !== undefined) return { value: positiveInt(cfg[key], DEFAULTS[key]), from: 'config:server.ifAuth' };
    return { value: DEFAULTS[key], from: 'default' };
  };
  const maxFailures = pick('maxFailures');
  const lockMinutes = pick('lockMinutes');
  const sessionHours = pick('sessionHours');
  return {
    maxFailures: maxFailures.value,
    lockMinutes: lockMinutes.value,
    sessionHours: sessionHours.value,
    absoluteHours: SESSION_ABSOLUTE_HOURS,
    source: `maxFailures=${maxFailures.from}｜lockMinutes=${lockMinutes.from}｜sessionHours=${sessionHours.from}`
  };
}

/* ---------------- 三、对外/对内字段的分界（F19-4） ---------------- */

/** **内部字段**（绝不许进对外正文）：只对"确实存在的用户"出现，会区分"用户不存在 vs 口令错" */
const INTERNAL_FIELDS = Object.freeze(['failCount', 'remainingAttempts']);

/**
 * 服务层结果 → **对外可见**字段（F19-4，**结构化白名单**，供**任何**适配器使用）。
 *
 * 为什么要有它：原来只有"HTTP 适配器的白名单 + 一条注释"挡着 `failCount` / `remainingAttempts`
 * （它们只对真实用户出现 ⇒ 转发出去就等于允许枚举用户名，违反 ADR-0007 D2"对外不区分原因"）。
 * 将来第二个调用方（CLI/巡检/未来的 MES 侧）只要 `Object.assign({}, result)` 就会重新泄漏。
 * 现在改为**结构上分开**：内部信息统一放进 `__internal` 命名空间（任何 `__` 前缀键一律不外发），
 * 且历史键名（`INTERNAL_FIELDS`）也一并过滤 —— 双重保险，防回归。
 *
 * @param {object} result 服务层返回值（`ok:true` 或 `ok:false` 均可）
 * @returns {object} 去掉 `__internal` 与内部键名后的**新对象**（不改原对象）
 */
function toPublic(result) {
  if (!result || typeof result !== 'object') return result;
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === '__internal' || k.startsWith('__')) continue;
    if (INTERNAL_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/* ---------------- 三之二、服务实例 ---------------- */

/**
 * 创建鉴权服务（**纯逻辑 + 依赖注入**，不碰 HTTP：HTTP 适配见 `server/http/routes/auth.js`）。
 * @param {{db?:object, logger?:object, now?:Function, config?:object, limits?:object,
 *          username?:string, teamCode?:string|Function, silent?:boolean}} [options]
 *   db       —— 库句柄（缺省 ⇒ 未初始化态且不接受初始化：初始化必须落库）
 *   logger   —— 留痕用（缺省 ⇒ 初始化码打印到控制台，与 ADR-0007 D4 一致）
 *   now      —— **注入时钟**（`tests/lib/clock.js` 的 `source()`）；缺省＝`platform/clock` 真实时钟
 *   config   —— 配置真源（缺省＝`src/config/board.config.js`），只读 `server.ifAuth.*`
 *   limits   —— 直接覆盖三个参数（自检用；比改配置文件更可控）
 *   teamCode —— `auth_credential.team_code`/`op_log.team_code` 的来源（缺省读 `shift.roster.team`）
 * @returns {object} 服务实例（status/init/login/logout/change/verify/initCode/limits/...）
 */
function createAuth(options = {}) {
  const db = options.db || null;
  const logger = options.logger || null;
  const nowFn = typeof options.now === 'function'
    ? options.now
    : platformClock.createClock({ mode: 'real' }).source();
  const config = options.config || boardConfig;
  const limits = resolveLimits(config, options);
  const defaultUsername = options.username || DEFAULT_USERNAME;
  const silent = options.silent === true;

  /** 班组编号（与 `op_log.team_code` 同一真源＝当前生效班次）：不注入就读配置，读不到＝null（**不猜**） */
  const teamCodeOf = (() => {
    if (typeof options.teamCode === 'function') return () => options.teamCode();
    if (typeof options.teamCode === 'string' && options.teamCode.trim()) return () => options.teamCode.trim();
    const t = config && config.shift && config.shift.roster ? config.shift.roster.team : null;
    return () => (typeof t === 'string' && t.trim() ? t.trim() : null);
  })();

  /** 会话表：token → `{username, createdAtMs, expiresAtMs, absoluteExpiresAtMs, lastSeenMs}`。
   *  **仅进程内存**（不落库、不落盘）：重启即全部失效，是 ADR-0007 D3 明写的安全属性。 */
  const sessions = new Map();
  /** 一次性初始化码：**仅内存**、成功后立即作废、重启重新生成（ADR-0007 D4） */
  let initCode = null;
  let initCodeUsed = false;

  /** 当前时刻快照（一次操作只取一次：文本与毫秒必须同源，否则留痕与过期判定会错位） */
  function stamp() {
    const raw = nowFn();
    const d = raw instanceof Date ? new Date(raw.getTime()) : platformClock.toDate(raw);
    if (!Number.isFinite(d.getTime())) throw new Error('auth: 注入时钟返回值无法解析为 Date（D17）');
    return { ms: d.getTime(), text: platformClock.fmt(d) };
  }

  const okBody = extra => Object.assign({ ok: true, error: '', httpStatus: 200 }, extra || {});
  const failBody = (error, httpStatus, extra) => Object.assign({ ok: false, error, httpStatus }, extra || {});
  /* ---- 表访问（未 initSchema 时**降级为未初始化**，不静默假装有凭证） ---- */
  function tableReady() {
    if (!db) return false;
    try {
      return Boolean(db.prepare(
        "SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'auth_credential'").get());
    } catch { return false; }
  }
  function readCredential(user) {
    if (!tableReady()) return null;
    return db.prepare('SELECT * FROM auth_credential WHERE username = ?').get(user) || null;
  }
  function countCredentials() {
    if (!tableReady()) return 0;
    return db.prepare('SELECT COUNT(*) AS c FROM auth_credential').get().c;
  }

  /**
   * 留痕（**唯一写入口**＝`repo/opLog.js`）。留痕失败**不改变业务结果**，但绝不静默：
   * 记 logger.error 并如实回报 `{ok:false}`（调用方可审计）。
   */
  function audit({ opType, result, content, at, remote }) {
    const line = remote ? `${content}｜来源=${remote}` : content;
    try {
      const r = opLogRepo.append(db, {
        opTime: at,
        operator: AUDIT_OPERATOR,
        opType,
        content: String(line).slice(0, opLogRepo.CONTENT_MAX),
        result,
        teamCode: teamCodeOf()
      }, at);
      return { ok: true, id: r.id, error: '' };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (logger && typeof logger.error === 'function') {
        logger.error(`[鉴权] op_log 留痕失败（${opType}/${result}）：${message}`);
      }
      return { ok: false, id: null, error: message };
    }
  }

  /** 生成并登记本次进程的一次性初始化码（打印到控制台 + 写 op_log；ADR-0007 D4） */
  function issueInitCode() {
    initCode = crypto.randomBytes(INIT_CODE_BYTES).toString('hex');
    initCodeUsed = false;
    const s = stamp();
    const line = `[看板鉴权] 未初始化：本机一次性初始化码 = ${initCode}` +
      '（**仅本进程内存**有效；请在**本机**浏览器打开设置页输入；成功后立即作废，进程重启会重新生成）';
    if (!silent) {
      if (logger && typeof logger.info === 'function') logger.info(line);
      else console.log(line);
    }
    audit({
      opType: OP_TYPE.INIT_CODE, result: '成功',
      content: `一次性初始化码=${initCode}（仅内存｜仅本机回环可用｜成功后立即作废）`, at: s.text
    });
  }
  /* 未初始化态：启动即生成并登记一次性初始化码（已初始化则**不必**生成 —— init 一律 409） */
  if (countCredentials() === 0) issueInitCode();

  /**
   * 锁定状态：`null`＝**未锁定**；否则 `{until, untilMs, unknown, retryAfterSec, raw?}`。
   *
   * ⚠ **F17-2（复核中危，已修）**：库内 `locked_until` 可能是**脏值**（人工改库、旧版本写入、
   * 编码问题）。旧写法直接 `platformClock.toDate(row.locked_until)` ⇒ 抛 `clock: 无法解析时间`
   * ⇒ `login()` / `status()` 冒未捕获异常 ⇒ **HTTP 500**（既不是"锁定"也不是"放行"，
   * 而且把 500 与异常文本暴露成探测信号；`Number.isFinite` 那道守卫**永远到不了**，是死守卫）。
   * 裁定口径（从严，复核给定）：**不可解析 ⇒ 按"锁定未知"处理** ——
   *   · `login()` 一律 **423**，`retryAfterSec` 取 `lockMinutes × 60`（保守值），并写一条留痕（含库内原值片段）；
   *   · `status()` **必须 200**，返回 `{locked:true, lockedUntil:null, lockedUnknown:true}`（仍不含任何秘密）。
   * 为什么从严而不是放行：`locked_until` 是"防暴力枚举"的状态位，读不懂它时放行等于把限流关掉。
   *
   * ⚠ **F19-1/F19-2（结案复跑残留，已修）**：
   *   · **不能用"真值判断"区分解析失败**（`if (!untilMs)`）：`1970-01-01 08:00:00`（UTC+8 纪元 0）
   *     解析出来的毫秒数**恰是 0**，是**合法且早已过期**的值，却被误判成"锁定未知"；SQLite 的 TEXT 亲和
   *     还会把数字 `0` 存成 `'0.0'`。现改为**显式布尔 `parsed`**：`parsed=false` 才是"锁定未知"，
   *     `parsed=true && untilMs <= now` ⇒ **已过期放行**。`'0.0'` 这类**纯数字串**按"毫秒时间戳"解释
   *     （TEXT 亲和的兼容口径，见下面的 numeric 回退）。
   *   · **空串 `''` 走"从严"**（裁定）：只有 `NULL`/`undefined` ＝"未设置（正常未锁定）"；
   *     非 NULL 但不可解析（**含空串**）一律＝"锁定未知" ⇒ 423。理由：只有一条规则更好守，
   *     库被写坏时应拒绝而不是放行（ADR-0007 §D8 第⑨条，主代理维护）。
   */
  function lockedState(row, nowMs) {
    if (!row) return null;
    const raw = row.locked_until;
    /* NULL ＝ 未设置（正常未锁定）；**空串不算 NULL**（F19-2：它落在下面的"锁定未知"从严分支） */
    if (raw === null || raw === undefined) return null;
    let parsed = false;
    let untilMs = 0;
    try {
      const d = platformClock.toDate(raw);
      if (Number.isFinite(d.getTime())) { untilMs = d.getTime(); parsed = true; }
    } catch { /* 不在这里下结论：先试下面的纯数字串回退，再落到"锁定未知" */ }
    if (!parsed) {
      /* F19-1：SQLite TEXT 亲和可能把数字时间戳存成 `'0.0'` / `'1758000000000'` —— 那不是脏值。
         仅当**非空**且纯数字时才按"毫秒时间戳"解释（`''` 因此不会命中这里 ⇒ 仍是"锁定未知"）。 */
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (s !== '' && /^-?\d+(?:\.\d+)?$/.test(s) && Number.isFinite(Number(s))) {
        untilMs = Number(s);
        parsed = true;
      }
    }
    if (!parsed) {
      return {
        until: null, untilMs: 0, unknown: true,
        raw: String(raw).slice(0, 40),
        retryAfterSec: Math.max(1, limits.lockMinutes * 60)
      };
    }
    if (untilMs <= nowMs) return null;      // 已过期（含纪元 0 / 远古时刻）⇒ 未锁定
    return {
      until: raw, untilMs, unknown: false,
      retryAfterSec: Math.max(1, Math.ceil((untilMs - nowMs) / 1000))
    };
  }

  /**
   * `GET /auth/status` 的响应体来源：**不含任何秘密**（无 hash/salt/令牌/初始化码）。
   * @returns {{ok:true, initialized:boolean, schemaReady:boolean, username:string, locked:boolean, ...}}
   */
  function status() {
    const s = stamp();
    const row = readCredential(defaultUsername);
    const lock = row ? lockedState(row, s.ms) : null;
    return {
      ok: true,
      initialized: Boolean(row),
      schemaReady: tableReady(),
      username: row ? row.username : defaultUsername,
      locked: Boolean(lock),
      lockedUntil: lock ? lock.until : null,          // 锁定未知（F17-2）⇒ null（不吐脏值）
      lockedUnknown: Boolean(lock && lock.unknown),   // 但**如实**标明"锁定态读不懂，按锁定处理"
      retryAfterSec: lock ? lock.retryAfterSec : 0,
      failCount: row ? Number(row.fail_count) : 0,
      maxFailures: limits.maxFailures,
      lockMinutes: limits.lockMinutes,
      sessionHours: limits.sessionHours,
      absoluteHours: limits.absoluteHours,
      limitsSource: limits.source,
      isInitial: row ? Number(row.is_initial) === 1 : false,
      changedBy: row ? row.changed_by : null,
      sessions: sessions.size,
      initCodePending: !row && !initCodeUsed && Boolean(initCode),
      at: s.text
    };
  }

  /**
   * 校验会话令牌（Bearer 中间件的服务层）。滑动续期 + 绝对上限都在这里。
   * @param {string} token
   * @returns {{ok:boolean, username?:string, expiresAt?:string, error?:string, httpStatus:number}}
   */
  function verify(token) {
    const s = stamp();
    const presented = typeof token === 'string' ? token : '';
    if (!presented) {
      return failBody(ERROR.UNAUTHORIZED, 401, { reason: '未携带会话令牌（Authorization: Bearer <token>）' });
    }
    /* 逐个 timingSafeEqual 比对（ADR-0007 D3："比较都用 timingSafeEqual"）：会话数恒为个位数，
       不为了 O(1) 而改回 Map 直接取值那套（那等于把"常量时间比较"这条口径只写在注释里）。 */
    let hitToken = null;
    let hit = null;
    for (const [k, v] of sessions) {
      if (tokenEquals(k, presented)) { hitToken = k; hit = v; break; }
    }
    if (!hit) {
      return failBody(ERROR.UNAUTHORIZED, 401, { reason: '会话令牌不存在或已失效（登出/进程重启后一律失效）' });
    }
    if (s.ms >= hit.expiresAtMs || s.ms >= hit.absoluteExpiresAtMs) {
      sessions.delete(hitToken);
      return failBody(ERROR.UNAUTHORIZED, 401, { reason: '会话已过期' });
    }
    /* 滑动续期：成功校验即顺延 TTL，但不得越过绝对上限（D3） */
    const nextExpiresMs = Math.min(s.ms + limits.sessionHours * 3600 * 1000, hit.absoluteExpiresAtMs);
    hit.expiresAtMs = nextExpiresMs;
    hit.lastSeenMs = s.ms;
    return okBody({
      token: hitToken, username: hit.username,
      expiresAt: platformClock.fmt(new Date(nextExpiresMs)), expiresAtMs: nextExpiresMs,
      absoluteExpiresAt: platformClock.fmt(new Date(hit.absoluteExpiresAtMs)),
      at: s.text
    });
  }

  /**
   * `POST /auth/init {code, password}`：**唯一**初始化入口（ADR-0007 D4）。
   * 判定顺序＝已初始化(409) → 回环(403) → 初始化码(401) → 口令口径(400) → 落库(200)。
   */
  function init(input = {}) {
    const s = stamp();
    const remote = input.remote;
    const user = typeof input.username === 'string' && input.username.trim()
      ? input.username.trim() : defaultUsername;

    if (countCredentials() > 0) {
      /* **不写留痕**：这是"重复初始化"的常规拒绝，没有安全事件可记（避免把 op_log 刷满噪声） */
      return failBody(ERROR.ALREADY_INITIALIZED, 409, { reason: '已经初始化过（重置＝删除凭证行后重启）' });
    }
    if (!tableReady()) {
      audit({
        opType: OP_TYPE.INIT, result: '失败',
        content: `口令初始化被拒：库内没有 auth_credential 表（未 initSchema）`, at: s.text, remote
      });
      return failBody(ERROR.NOT_INITIALIZED, 409, { reason: '库结构未就绪：未执行 initSchema' });
    }
    if (!isLoopback(remote)) {
      audit({
        opType: OP_TYPE.INIT, result: '失败',
        content: `口令初始化被拒：来源不是回环地址（即使带对初始化码也拒绝）`, at: s.text, remote
      });
      return failBody(ERROR.NOT_LOOPBACK, 403, {
        reason: '初始化只允许来自本机回环（127.0.0.1 / ::1 / ::ffff:127.0.0.1）'
      });
    }
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!initCode || initCodeUsed || !code || !tokenEquals(code, initCode)) {
      audit({
        opType: OP_TYPE.INIT, result: '失败',
        content: `口令初始化被拒：一次性初始化码不正确或已作废（已用=${initCodeUsed}）`,
        at: s.text, remote
      });
      return failBody(ERROR.BAD_INIT_CODE, 401, { reason: '一次性初始化码不正确或已作废' });
    }
    const policy = checkPasswordPolicy(input.password, user);
    if (policy) {
      audit({
        opType: OP_TYPE.INIT, result: '失败',
        content: `口令初始化被拒：口令不符合口径（${policy}）`, at: s.text, remote
      });
      return failBody(ERROR.BAD_PASSWORD, 400, { reason: policy });
    }

    const { salt, hash } = hashPassword(input.password);
    db.prepare(
      `INSERT INTO auth_credential(username, algo, params, salt, hash, fail_count, locked_until,
                                   is_initial, created_at, updated_at, changed_by, team_code)
       VALUES(?, ?, ?, ?, ?, 0, NULL, 1, ?, ?, ?, ?)`
    ).run(user, ALGORITHM, PARAMS, salt, hash, s.text, s.text, '一次性初始化码', teamCodeOf());

    /* 码**立即作废**（仅内存；重启会重新生成） */
    initCode = null;
    initCodeUsed = true;
    audit({
      opType: OP_TYPE.INIT, result: '成功',
      content: `口令初始化成功｜用户=${user}｜由一次性初始化码设置（is_initial=1，人工尚未改过）`,
      at: s.text, remote
    });
    return okBody({ initialized: true, username: user, isInitial: true, at: s.text });
  }

  /**
   * `POST /auth/login {username?, password}`：成功发会话令牌；口令错与用户不存在**对外不区分**。
   */
  function login(input = {}) {
    const s = stamp();
    const remote = input.remote;
    const user = typeof input.username === 'string' && input.username.trim()
      ? input.username.trim() : defaultUsername;

    if (countCredentials() === 0) {
      audit({
        opType: OP_TYPE.LOGIN_FAIL, result: '失败',
        content: `登录失败：服务尚未初始化（用户=${user}）—— 需先在本机用一次性初始化码设置口令`,
        at: s.text, remote
      });
      return failBody(ERROR.NOT_INITIALIZED, 409, { reason: '尚未初始化：请在本机用一次性初始化码设置口令' });
    }
    const row = readCredential(user);
    if (!row) {
      /* 用户不存在：**对外与"口令错"不可区分**（ADR-0007 D2），记账如实写 */
      audit({
        opType: OP_TYPE.LOGIN_FAIL, result: '失败',
        content: `解锁失败｜用户=${user}｜库内无该用户（对外与"口令错"同一响应）`, at: s.text, remote
      });
      return failBody(ERROR.BAD_CREDENTIALS, 401, { reason: '用户名或口令不正确' });
    }
    const lock = lockedState(row, s.ms);
    if (lock) {
      /* F17-2：锁定未知（库内 locked_until 不可解析）也走这一支，但留痕写明原因与库内原值片段 */
      audit({
        opType: OP_TYPE.LOGIN_FAIL, result: '失败',
        content: lock.unknown
          ? `解锁失败｜用户=${row.username}｜库内 locked_until 不可解析（原值="${lock.raw}"）⇒ ` +
            `**从严按锁定处理**（剩余按 ${limits.lockMinutes} 分钟保守估计）`
          : `解锁失败｜用户=${row.username}｜账号锁定中（剩余 ${lock.retryAfterSec} s）—— **口令正确也拒绝**`,
        at: s.text, remote
      });
      return failBody(ERROR.LOCKED, 423, {
        retryAfterSec: lock.retryAfterSec,
        lockedUntil: lock.unknown ? null : lock.until,
        lockedUnknown: lock.unknown === true,
        reason: lock.unknown
          ? `库内锁定时间不可解析 —— 从严按锁定处理，请在 ${lock.retryAfterSec} s 后重试`
          : `账号已锁定，请在 ${lock.retryAfterSec} s 后重试`,
        /* F19-4：内部字段统一进 `__internal`（`toPublic()` 一律不外发） */
        __internal: { failCount: Number(row.fail_count) }
      });
    }

    const presented = typeof input.password === 'string' ? input.password : '';
    const passOk = presented.length > 0 && hashEquals(row.hash, derive(presented, row.salt));
    if (!passOk) {
      const fails = Number(row.fail_count) + 1;
      if (fails >= limits.maxFailures) {
        const untilMs = s.ms + limits.lockMinutes * 60 * 1000;
        const until = platformClock.fmt(new Date(untilMs));
        db.prepare('UPDATE auth_credential SET fail_count = ?, locked_until = ?, updated_at = ? WHERE username = ?')
          .run(fails, until, s.text, row.username);
        const retryAfterSec = Math.max(1, Math.ceil((untilMs - s.ms) / 1000));
        audit({
          opType: OP_TYPE.LOCKED, result: '失败',
          content: `账号锁定｜用户=${row.username}｜连续失败 ${fails}/${limits.maxFailures} 次 ⇒ 锁定至 ${until}` +
            `（${limits.lockMinutes} 分钟，锁定期间口令正确也拒绝）`,
          at: s.text, remote
        });
        return failBody(ERROR.LOCKED, 423, {
          retryAfterSec, lockedUntil: until,
          reason: `连续失败 ${fails} 次，账号已锁定 ${limits.lockMinutes} 分钟`,
          __internal: { failCount: fails }
        });
      }
      db.prepare('UPDATE auth_credential SET fail_count = ?, updated_at = ? WHERE username = ?')
        .run(fails, s.text, row.username);
      audit({
        opType: OP_TYPE.LOGIN_FAIL, result: '失败',
        content: `解锁失败｜用户=${row.username}｜口令不匹配（第 ${fails}/${limits.maxFailures} 次）`,
        at: s.text, remote
      });
      /* ⚠ **F17-8① / F19-4 硬口径（本轮结构化了）**：下面这两个字段
         （`failCount` / `remainingAttempts`）**只对"确实存在的用户"出现** ⇒ 它们天然把
         "用户不存在"与"口令错"区分开了。服务层保留它们是为了**自检与运维取证**（也要能审计"第几次失败"），
         但 **任何适配器（HTTP/CLI/IPC/未来的 MES 侧）都不得把它们转发给调用方** ——
         否则 ADR-0007 D2 的"对外错误不区分原因"就被绕过（可用来枚举用户名）。
         防护已从"注释 + 适配器白名单"升级为**结构分离**：内部信息只放在 `__internal` 下，
         适配器一律经 `toPublic(result)` 取值（`__` 前缀键与 `INTERNAL_FIELDS` 双双过滤）。
         `server/http/routes/auth.js` 的 `bodyOf()` 已改为只读 `toPublic()` 的结果；
         并有断言锁住"两种失败的对外正文逐字节同形状"（`tests\db-check.js` 九之三 HTTP 段）。 */
      return failBody(ERROR.BAD_CREDENTIALS, 401, {
        reason: '用户名或口令不正确',
        __internal: { failCount: fails, remainingAttempts: Math.max(0, limits.maxFailures - fails) }
      });
    }

    /* 成功：**清零**失败计数、解除锁定（ADR-0007 D2），发新令牌（D3） */
    db.prepare('UPDATE auth_credential SET fail_count = 0, locked_until = NULL, updated_at = ? WHERE username = ?')
      .run(s.text, row.username);
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const absoluteExpiresAtMs = s.ms + limits.absoluteHours * 3600 * 1000;
    const expiresAtMs = Math.min(s.ms + limits.sessionHours * 3600 * 1000, absoluteExpiresAtMs);
    sessions.set(token, {
      username: row.username, createdAtMs: s.ms, expiresAtMs, absoluteExpiresAtMs, lastSeenMs: s.ms
    });
    audit({
      opType: OP_TYPE.LOGIN, result: '成功',
      content: `解锁｜用户=${row.username}｜失败计数已清零｜会话到期 ${platformClock.fmt(new Date(expiresAtMs))}` +
        `（滑动续期 ${limits.sessionHours} h，绝对上限 ${limits.absoluteHours} h）`,
      at: s.text, remote
    });
    return okBody({
      token, username: row.username,
      expiresAt: platformClock.fmt(new Date(expiresAtMs)), expiresAtMs,
      absoluteExpiresAt: platformClock.fmt(new Date(absoluteExpiresAtMs)),
      at: s.text
    });
  }

  /** `POST /auth/logout`（Bearer）：令牌**立即失效**；未携带/伪造令牌一律 401 */
  function logout(input = {}) {
    const s = stamp();
    const v = verify(input.token);
    if (!v.ok) {
      return failBody(ERROR.UNAUTHORIZED, 401, { reason: v.reason || '会话令牌无效', unauthorized: true });
    }
    sessions.delete(v.token);
    audit({
      opType: OP_TYPE.LOGOUT, result: '成功',
      content: `登出｜用户=${v.username}｜会话令牌即刻失效（剩余在途会话 ${sessions.size} 个）`,
      at: s.text, remote: input.remote
    });
    return okBody({
      username: v.username, sessionsRemaining: sessions.size,
      requireRelogin: true, at: s.text
    });
  }

  /**
   * `POST /auth/change {oldPassword, newPassword}`（Bearer）：校验原口令 → 口径 → 换盐换派生值
   * → **清掉该用户全部在途会话（含当前）**并要求重新登录（ADR-0007 D5）。
   */
  function change(input = {}) {
    const s = stamp();
    const remote = input.remote;
    const v = verify(input.token);
    if (!v.ok) {
      return failBody(ERROR.UNAUTHORIZED, 401, { reason: v.reason || '会话令牌无效', unauthorized: true });
    }
    const row = readCredential(v.username);
    if (!row) {
      return failBody(ERROR.NOT_INITIALIZED, 409, { reason: '凭证行不存在（已被重置）—— 请重新初始化' });
    }
    const oldPw = typeof input.oldPassword === 'string' ? input.oldPassword : '';
    if (!oldPw || !hashEquals(row.hash, derive(oldPw, row.salt))) {
      audit({
        opType: OP_TYPE.CHANGE, result: '失败',
        content: `改密失败｜用户=${v.username}｜原口令不匹配（会话未清除）`, at: s.text, remote
      });
      return failBody(ERROR.BAD_CREDENTIALS, 401, { reason: '原口令不正确' });
    }
    const policy = checkPasswordPolicy(input.newPassword, v.username);
    if (policy) {
      audit({
        opType: OP_TYPE.CHANGE, result: '失败',
        content: `改密失败｜用户=${v.username}｜新口令不符合口径（${policy}）`, at: s.text, remote
      });
      return failBody(ERROR.BAD_PASSWORD, 400, { reason: policy });
    }
    if (input.newPassword === oldPw) {
      audit({
        opType: OP_TYPE.CHANGE, result: '失败',
        content: `改密失败｜用户=${v.username}｜新口令与原口令相同`, at: s.text, remote
      });
      return failBody(ERROR.BAD_PASSWORD, 400, { reason: '新口令不得与原口令相同' });
    }

    const { salt, hash } = hashPassword(input.newPassword);
    db.prepare(
      `UPDATE auth_credential SET algo = ?, params = ?, salt = ?, hash = ?, is_initial = 0,
                                  updated_at = ?, changed_by = ?, team_code = ? WHERE username = ?`
    ).run(ALGORITHM, PARAMS, salt, hash, s.text, '设置页改密', teamCodeOf(), v.username);

    /* 改密 ⇒ **强制清会话**：ADR-0007 D5 要求"清当前会话并要求重新登录"；单机单操作人场景下
       "清该用户全部会话"与"只清当前"等价，取**更严**的一侧（旧令牌一律作废）。 */
    const cleared = sessions.size;
    sessions.clear();
    audit({
      opType: OP_TYPE.CHANGE, result: '成功',
      content: `改密成功｜用户=${v.username}｜已清 ${cleared} 个在途会话（含当前）⇒ 须重新登录`,
      at: s.text, remote
    });
    return okBody({
      username: v.username, requireRelogin: true, sessionsCleared: cleared, at: s.text
    });
  }

  return {
    username: defaultUsername,
    limits,
    algorithm: ALGORITHM,
    params: PARAMS,
    /** 当前进程的一次性初始化码（**仅供启动打印与自检读取**；HTTP 层从不下发它） */
    initCode: () => initCode,
    /** **结构化白名单**（F19-4）：适配器只许输出它的结果 —— 任何 `__` 前缀键与内部键名都被滤掉 */
    toPublic,
    status,
    init,
    login,
    logout,
    change,
    verify
  };
}

module.exports = {
  createAuth,
  resolveLimits,
  derive,
  hashPassword,
  hashEquals,
  tokenEquals,
  toPublic,
  INTERNAL_FIELDS,
  checkPasswordPolicy,
  isLoopback,
  ALGORITHM,
  PARAMS,
  SCRYPT_OPTIONS,
  KEY_LEN,
  SALT_BYTES,
  TOKEN_BYTES,
  INIT_CODE_BYTES,
  PASSWORD_MIN,
  PASSWORD_MAX,
  DEFAULT_USERNAME,
  DEFAULTS,
  SESSION_ABSOLUTE_HOURS,
  LOOPBACK_ADDRESSES,
  ERROR,
  OP_TYPE
};
