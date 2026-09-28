/* ==========================================================================
   服务端静态托管（server/http/site.js）—— 负责人裁定「选项 A」（2026-09-28）的第二半
   作用：让看板有**同源入口**（`http://127.0.0.1:8787/`），不再只能靠 `file://` 打开 ——
         `file://` 下浏览器会把手写 `Origin: null` 的请求当跨源（须配 CORS 才能用），
         而同源入口把这些麻烦一次消掉（CORS 是给"仍然双击 index.html"的场景兜底）。
   白名单（**白名单式，不是黑名单**；裁定原文点名哪些必须 404）：
     · `GET /`（或 `/index.html`）  ⇒ 仓库根的 `index.html`
     · `GET /src/**`                ⇒ 仓库 `src\` 子树（按扩展名给正确 `Content-Type`）
     · 其余一律 **404**（沿用 router 的 JSON 404 形状，**不返回 HTML**）：
       `需求文档\` / `项目记录\` / `tests\` / `tools\` / `本地归档\` / `输出文件\` /
       `server\` / `data\` / `.git`，以及一切路径穿越形态。
   安全（**路径穿越必须全部拒掉且不得泄露内容**）：
     ① 逐段 `decodeURIComponent`，解码后若仍含 `%`（二次编码）⇒ 拒；
     ② 任一段解码后含 `/`、`\`、NUL，或是 `.` / `..` ⇒ 拒（`%2e%2e%2f` 解出 `/` 即在此被拦）；
     ③ 只有第一段是 `src` 的才放行；算出的绝对路径必须**仍在**对应白名单层之内 ——
        **字面量前缀 + `realpathSync` 两道都查，且 realpath 的上界是"被托管的那一层"**：
        资源 `/src/**` ⇒ 必须落 `<仓库根>\src` 之内（**不是仓库根** —— F9：一条仓库内 junction
        `src\x -> tests` 在"上界＝仓库根"的旧写法下能把 `tests\**` 读出去，突破 ADR-0008 D1）；
        首页 `/` ⇒ `index.html` 的 realpath 必须**恰好等于** `<仓库根>\index.html`；
        越界分别给出 `OUTSIDE_SRC_REALPATH` / `OUTSIDE_INDEX_REALPATH`；
     ④ 只放行**常规文件**（目录、符号链接指向别处、特殊文件一律拒）；
     ⑤ **只认规范拼写**（F7）：非根路径不得带尾斜杠、不得有 `//` 或 `.` 段、`index.html` 比较
        大小写不敏感（详见 `resolvePath()` 的规范化口径）。
   响应：`Cache-Control: no-store`（开发期避免改前端后仍看到旧文件）＋ `Content-Length`；
         路径穿越/白名单外**只记 warn**（不写 console.error），返回 404。
   ⚠ **给后来者的忠告（F9 实测教训）**：拆 Windows **junction** 只能用 `cmd /c rmdir <链接路径>`；
      **绝对不要**对 junction 目录调 `fs.rmSync(..., { recursive: true })` —— 那可能**顺着链接删到目标目录**。
   依赖：`platform/paths.js`（D11：业务代码不得硬编码路径）、node 内置模块。零第三方依赖。
   用法：
     const site = mountSite(router, { logger });      // 注册成 router 的**兜底处理器**
     site.routes;                                     // ['GET /', 'GET /src/**']
     site.isStaticPath('/src/main.js')                // CORS 预检据此判断"路径是否已注册"
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const platformPaths = require('../../platform/paths');

/** 扩展名 → Content-Type（**白名单**：表里没有的扩展名一律 404，不做"猜类型"） */
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
});

/** 允许托管的顶层白名单（只有这两个：首页与 `src/` 子树） */
const ALLOWED_TOP = Object.freeze(['src']);
const INDEX_FILE = 'index.html';

/** 安全解码一个路径段：非法编码 / 二次编码 / 段内注入（`/`、`\`、NUL）一律返回 null */
function safeSegment(raw) {
  let s = null;
  try { s = decodeURIComponent(raw); } catch { return null; }
  if (s === null) return null;
  /* 二次编码（`%252e%252e%252f`）：再解一次若发生变化，说明客户端在绕过单次解码 —— 直接拒 */
  try { if (decodeURIComponent(s) !== s) return null; } catch { /* 解不动 = 只有一层，正常 */ }
  if (s.includes('/') || s.includes('\\') || s.includes('\u0000')) return null;
  return s;
}

/**
 * 解析请求路径 → 允许托管的相对路径。
 *
 * **规范化口径（F7，独立审查立案：同一文件不得因拼写产生两种判定）**：
 *   · 只认**规范拼写**：根 `'/'`、`'/index.html'`（**大小写不敏感**，见下）、`'/src/<...>'`；
 *   · **非根路径不得以 `/` 结尾**（`/src/main.js/`、`/index.html/` ⇒ 404：带尾斜杠指向的是目录语义，
 *     而第 4 条已经拒绝"列目录"，两者必须同判）；
 *   · **空段与 `.` 段一律拒**（`//index.html`、`/./index.html` ⇒ 404）—— 规范化拼写只有一种；
 *   · `index.html` 的**文件名比较用小写**（`/index.HTML` 与 `/index.html` 同判为"首页"），
 *     这与"`src/` 子树交给文件系统解析"在 Windows/NTFS 上的大小写行为一致（同一文件＝同一判定）。
 *     ⚠ 平台边界：本看板只部署在 Windows（NFR/部署口径），故"src 子树大小写不敏感"由 NTFS 保证；
 *       换到大小写敏感的文件系统时，`/src/MAIN.JS` 会因**文件不存在**而 404（不是"两种判定"，是"无此文件"）。
 * @param {string} rawPath `URL.pathname`（未解码，含前导 `/`）
 * @returns {{ok:true, rel:string, kind:'index'|'asset', ext:string}
 *          |{ok:false, reason:string}} `reason` 是机器可读的拒绝原因（warn 留痕用）
 */
function resolvePath(rawPath) {
  const p = String(rawPath === undefined || rawPath === null ? '/' : rawPath);
  if (!p.startsWith('/')) return { ok: false, reason: 'NOT_ABSOLUTE' };
  if (p === '/') return { ok: true, rel: INDEX_FILE, kind: 'index', ext: '.html' };
  /* 尾随斜杠：除了根 `'/'` 之外一律拒（F7） */
  if (p.endsWith('/')) return { ok: false, reason: 'TRAILING_SLASH' };
  const segs = [];
  const rawSegs = p.split('/');
  for (let i = 0; i < rawSegs.length; i++) {
    const raw = rawSegs[i];
    if (raw === '') {
      /* 只允许"前导斜杠"造成的空段：`//index.html`、`/src//main.js` 一律拒（F7：不做隐式归一） */
      if (i === 0) continue;
      return { ok: false, reason: 'EMPTY_SEGMENT' };
    }
    const s = safeSegment(raw);
    if (s === null) return { ok: false, reason: 'BAD_SEGMENT' };
    if (s === '.' || s === '..') return { ok: false, reason: 'TRAVERSAL' };
    segs.push(s);
  }
  if (segs.length === 1 && segs[0].toLowerCase() === INDEX_FILE) {
    return { ok: true, rel: INDEX_FILE, kind: 'index', ext: '.html' };
  }
  if (!ALLOWED_TOP.includes(segs[0])) return { ok: false, reason: 'NOT_WHITELISTED' };
  if (segs.length < 2) return { ok: false, reason: 'DIRECTORY_LISTING_REFUSED' };
  const rel = segs.join('/');
  const ext = path.extname(rel).toLowerCase();
  if (!MIME[ext]) return { ok: false, reason: 'EXT_NOT_ALLOWED' };
  return { ok: true, rel, kind: 'asset', ext };
}

/**
 * 挂载静态站点（注册为 router 的**兜底处理器**：不新增精确路由，故不影响既有 404/405 口径）。
 * @param {object} router `server/http/router.js` 的 createRouter() 产物（需支持 `fallback()`）
 * @param {{logger?:object, root?:string}} [options] `root` 缺省＝`platform/paths.js` 的仓库根（D11）
 * @returns {{mount:'site', mounted:boolean, by:'W5', routes:string[], root:string, isStaticPath:Function,
 *            resolve:Function, status:Function}}
 */
function mountSite(router, options = {}) {
  if (!router || typeof router.fallback !== 'function') {
    throw new TypeError('mountSite: 必须传入 server/http/router.js 的 router（需支持 fallback()）');
  }
  const logger = options.logger || null;
  const root = path.resolve(options.root || platformPaths.paths.root);
  /* F4/F9：**realpath 复核**用的上界。两道：
     · 资源（`/src/**`）的上界是 **`<root>\\src`**（`srcReal`）—— 不是仓库根！F9（独立复跑立案）实测：
       一条**仓库内** junction（`src\\x -> tests`）在"上界＝仓库根"的旧写法下能让
       `GET /src/x/harness-check.js` 返回 **200**，把 `tests\\**` 从静态口读出来，突破
       `ADR-0008 D1`（只托管 `index.html` + `src\\**`）；
     · 首页 `/` ⇒ `index.html` 的上界是**恰好等于 `<root>\\index.html`**（它就在仓库根，
       不能因为"在仓库根之内"就放宽成整仓）。
     `path.resolve` + `startsWith` 只挡字面量越界，挡不住 root 之内指向 root 之外的链接
     （Windows 上 junction 同理）⇒ 必须再比一次 realpath，且上界必须是**被托管的那一层**。 */
  const realOf = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const rootReal = realOf(root);
  const srcReal = realOf(path.join(root, 'src'));
  const indexReal = path.join(rootReal, INDEX_FILE);
  /** 大小写归一（Windows 路径比较；非 Windows 原样）—— 只用于"是否仍在某一层之内"的判定 */
  const normCase = s => (process.platform === 'win32' ? String(s).toLowerCase() : String(s));
  const insideOrEqual = (child, parent) =>
    normCase(child) === normCase(parent) || normCase(child).startsWith(normCase(parent) + path.sep);
  const served = { index: 0, asset: 0, denied: 0, missing: 0 };

  /**
   * 解析后落到绝对路径，并做"字面在 root 之内 + realpath 落在**对应白名单层**之内 + 是常规文件"校验。
   * @param {string} rel 允许托管的相对路径（`index.html` 或 `src/...`）
   * @param {'index'|'asset'} kind 决定 realpath 的上界（`index.html` 恰好一个文件；资源落 `src\\`）
   */
  function fileOf(rel, kind) {
    const full = path.resolve(root, rel);
    const inside = full === root || full.startsWith(root + path.sep);
    if (!inside) return { ok: false, reason: 'OUTSIDE_ROOT' };
    let real = null;
    try { real = fs.realpathSync(full); } catch { return { ok: false, reason: 'NOT_FOUND' }; }
    if (kind === 'index') {
      /* 首页：realpath 必须**恰好等于** `<root>/index.html`（不接受别名/链接指向别处） */
      if (normCase(real) !== normCase(indexReal)) return { ok: false, reason: 'OUTSIDE_INDEX_REALPATH' };
    } else if (!insideOrEqual(real, srcReal)) {
      /* 资源：realpath 必须落在 `<root>/src` 之内（F9 收窄；旧写法用的是仓库根） */
      return { ok: false, reason: 'OUTSIDE_SRC_REALPATH' };
    }
    let st = null;
    try { st = fs.statSync(real); } catch { return { ok: false, reason: 'NOT_FOUND' }; }
    if (!st.isFile()) return { ok: false, reason: 'NOT_A_FILE' };
    return { ok: true, full: real };
  }

  /** 兜底处理器：只有 GET 才处理；白名单外/穿越一律返回 false（交给既有 JSON 404） */
  async function handle(req, res, ctx = {}) {
    const method = String(ctx.method || req.method || '').toUpperCase();
    if (method !== 'GET') return false;
    const r = resolvePath(ctx.path);
    if (!r.ok) {
      served.denied++;
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[静态托管] 拒绝非白名单路径（404）', { path: ctx.path, reason: r.reason });
      }
      return false;                       // ⇒ router 的既有 JSON 404
    }
    const found = fileOf(r.rel, r.kind);
    if (!found.ok) {
      served.missing++;
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[静态托管] 文件不存在或不是常规文件（404）', { path: ctx.path, rel: r.rel, reason: found.reason });
      }
      return false;
    }
    let buf = null;
    try {
      buf = fs.readFileSync(found.full);
    } catch (err) {
      served.missing++;
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[静态托管] 读取失败（404）', { path: ctx.path, reason: err.code || err.message });
      }
      return false;
    }
    if (r.kind === 'index') served.index++; else served.asset++;
    res.writeHead(200, {
      'Content-Type': MIME[r.ext],
      'Content-Length': String(buf.length),
      /* 开发期避免"改了前端却看到旧文件"：不做长缓存（裁定原文要求） */
      'Cache-Control': 'no-store'
    });
    res.end(buf);
    return true;
  }

  router.fallback(handle);

  return {
    mount: 'site',
    mounted: true,
    by: 'W5',
    routes: ['GET /', 'GET /src/**'],
    root,
    /** CORS 预检用：该路径是否属于"已注册路径"（精确路由之外的第二类可应答路径） */
    isStaticPath: rawPath => resolvePath(rawPath).ok,
    resolve: resolvePath,
    status: () => Object.assign({ mount: 'site', mounted: true, by: 'W5', root, routes: ['GET /', 'GET /src/**'] },
      { served: Object.assign({}, served) })
  };
}

module.exports = { mountSite, resolvePath, safeSegment, MIME, ALLOWED_TOP, INDEX_FILE };
