/* ==========================================================================
   服务进程入口（server/index.js）—— W6「进程入口与运行骨架」
   作用：交付一个**能起、能查、能优雅退**的最小 HTTP 服务进程，并把后续工作包的挂载点备好：
         ①读配置（默认 `127.0.0.1:8787`，可被环境变量/命令行覆盖）
         ②启动自检（库可打开可写 / 关键目录可写 / 时间源可读）——任一失败**明确报错并退非零**
         ③监听（默认仅回环；配成对外地址时**日志显著告警**）
         ④优雅退出（SIGINT/SIGTERM/SIGHUP → 停收新连接 → 等在途请求（有上限）→ WAL checkpoint → 关库）
         ⑤未捕获异常/未处理 rejection **不静默**：记日志并退非零
   本包**不做**：IF-A/IF-D/IF-B 业务逻辑、鉴权与登录、迁移备份、前端改动、任何协议细节
        （地址/签名待三方答复）。业务路由留给 W1/W2/W4/W5，挂载位见 `server/http/router.js`。
   依据：ADR-0001 D1/D5（双进程开发模式 + HTTP 服务形态）、ADR-0002 D10（Node 24 LTS、零 npm）、
        ADR-0002 D11（业务代码不得硬编码路径，一律走 platform/paths.js）、
        ADR-0003 D16（DSH_ENV 决定数据目录）、NFR-25 / AC-09（**不得对外**）、
        任务分解 `项目记录\服务层第二笔-任务分解与排期.md` 第 64～67 行。
   依赖：**仅 node: 内置模块** + 本项目 platform/db（零第三方依赖）。
   运行：node server\index.js
   配置优先级（后者覆盖前者）：内置默认 → `board.config.js` 的 `server` 段（可选）→ 环境变量 → 命令行参数
     `--host <地址>`      ／ 环境变量 `DSH_BOARD_HOST`
     `--port <端口>`      ／ 环境变量 `DSH_BOARD_PORT`（兼容测试夹具惯用的 `DSH_PORT`）
     `--data-dir <目录>`  ／ 环境变量 `DSH_BOARD_DATA_DIR`（覆盖数据根；test 环境下必须在 tests\._verify 内）
     `--db-file <路径>`   ／ 环境变量 `DSH_BOARD_DB_FILE`（覆盖库文件；默认 `dataRoot\board.db`）
       —— 存在的理由：自检要证明"库不可写 ⇒ 拒绝启动"**可达**，需要一个"目录可写、库文件不可写"的场景。
     `--crash uncaught|rejection` ／ 环境变量 `DSH_BOARD_CRASH`
       —— **只为自检**保留的"故障注入位"（正式运行不要设）：启动后 500 ms 主动抛，
          用来证明"未捕获异常不静默、进程退非零"这条线真的生效（不是源码字符串匹配）。
   导出：`start()` / `stop()` / `main()` 与配置解析器（供自检与后续工作包复用；直接运行本文件时自动 `main()`）。
   ========================================================================== */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const platformPaths = require('../platform/paths');
const platformClock = require('../platform/clock');
const { createLogger } = require('../platform/log');
const dbApi = require('./db');
const { createRouter } = require('./http/router');
/* W1 的挂载口（`server/http/routes/ifD.js`）：IF-D 采集接入的唯一接线点，见下方 6b 段 */
const { mountIfD } = require('./http/routes/ifD');
/* W2 的挂载口（`server/http/routes/ifA.js`）：IF-A 接收（MES 派工/物料/工艺/设备）的唯一接线点，见下方 6c 段 */
const { mountIfA } = require('./http/routes/ifA');

/* 注入出口（ADR-0003 D17 / E42）：本文件的时间**一律**经 platformClock 取，不裸写 `new Date()` /
   `Date.now()`；形态与 `server/http/router.js`、`server/services/dispatch.js` 及下方 IF-D/IF-A
   挂载处**完全一致**（`platformClock.createClock({mode:'real'}).source()`），**不新造第二套时钟**。
   为什么在模块级先建一份：崩溃兜底（`installCrashGuards`）可能在 `start()` 之前就要时间戳；
   `start({clock})` 注入的时钟会在启动时覆盖它（见下方 `currentClock()`）。 */
const processClock = platformClock.createClock({ mode: 'real' });

/** 默认监听地址：**仅回环**。理由见下方 start() 内的告警分支。 */
const DEFAULT_HOST = '127.0.0.1';
/** 默认端口（2026-09-27 负责人裁定：默认 127.0.0.1:8787，可配） */
const DEFAULT_PORT = 8787;
/** 需求基线版本串的**真源**＝ `src/config/board.config.js` 头部注释的「需求版本：Vx.yz」行 */
const BASELINE_SOURCES = [
  path.join(__dirname, '..', 'src', 'config', 'board.config.js'),
  path.join(__dirname, '..', 'src', 'services', 'api.js')
];
/** 优雅退出的在途请求等待上限（毫秒）：到点即强制收尾，避免"等一个不响应的连接"卡住停机 */
const SHUTDOWN_TIMEOUT_MS = 8000;
/** 是否回环地址（本服务默认只允许这一类；对外地址必须显式配置并由负责人批准） */
function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/* ---------------- 一、配置读取与命令行解析 ---------------- */

/**
 * 解析命令行参数。
 * 支持 `--port 8787` 与 `--port=8787` 两种写法；未知参数**显式报错**（不静默忽略 ——
 * 否则把 `--prot 9000` 这种笔误当成"用了默认端口"，现场很难发现）。
 * @param {string[]} argv 默认取 `process.argv.slice(2)`
 */
function parseArgs(argv) {
  const args = argv || process.argv.slice(2);
  const out = { unknown: [] };
  const take = (i, name) => {
    const cur = args[i];
    const eq = cur.indexOf('=');
    if (eq >= 0) return { value: cur.slice(eq + 1), next: i };
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`参数 ${name} 缺少取值（用法：${name} <值>）`);
    }
    return { value: next, next: i + 1 };
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port' || a.startsWith('--port=')) { const r = take(i, '--port'); out.port = r.value; i = r.next; }
    else if (a === '--host' || a.startsWith('--host=')) { const r = take(i, '--host'); out.host = r.value; i = r.next; }
    else if (a === '--data-dir' || a.startsWith('--data-dir=')) { const r = take(i, '--data-dir'); out.dataDir = r.value; i = r.next; }
    else if (a === '--db-file' || a.startsWith('--db-file=')) { const r = take(i, '--db-file'); out.dbFile = r.value; i = r.next; }
    else if (a === '--crash' || a.startsWith('--crash=')) { const r = take(i, '--crash'); out.crash = r.value; i = r.next; }
    else out.unknown.push(a);
  }
  return out;
}

/** 取 `board.config.js` 的 `server` 段（若日后有人加了这段，值即被采纳；当前文件里**没有**该段） */
function serverConfigFrom(boardConfig) {
  const seg = boardConfig && typeof boardConfig === 'object' ? boardConfig.server : null;
  return seg && typeof seg === 'object' ? seg : {};
}

/**
 * 组装运行配置。
 * @param {{argv?:string[], env?:object, boardConfig?:object}} [options]
 * @returns {{host:string, port:number, dataDir:string|null, crashMode:'uncaught'|'rejection'|null,
 *            maxBodyBytes:(number|null), sources:object}}
 *   `sources` 记录每项取值来自哪一层（默认/配置/环境变量/命令行）—— 供日志与自检对账。
 */
function resolveConfig(options = {}) {
  const env = options.env || process.env;
  const boardConfig = options.boardConfig || require('../src/config/board.config');
  const args = parseArgs(options.argv);
  const cfg = serverConfigFrom(boardConfig);
  const sources = {};
  const pick = (name, argValue, envNames, cfgValue, fallback) => {
    const fromEnv = envNames.map(n => [n, env[n]]).find(([, v]) => v !== undefined && v !== '');
    if (argValue !== undefined) { sources[name] = 'cli'; return argValue; }
    if (fromEnv) { sources[name] = `env:${fromEnv[0]}`; return fromEnv[1]; }
    if (cfgValue !== undefined && cfgValue !== null && cfgValue !== '') { sources[name] = 'config'; return cfgValue; }
    sources[name] = 'default';
    return fallback;
  };

  const host = String(pick('host', args.host, ['DSH_BOARD_HOST'], cfg.host, DEFAULT_HOST)).trim();
  const portRaw = pick('port', args.port, ['DSH_BOARD_PORT', 'DSH_PORT'], cfg.port, DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`端口非法：${JSON.stringify(portRaw)}（来源 ${sources.port}）—— 需为 0～65535 的整数`);
  }
  if (!host) throw new Error('监听地址为空 —— 需显式给出地址或以默认 127.0.0.1 启动');

  const dataDirRaw = pick('dataDir', args.dataDir, ['DSH_BOARD_DATA_DIR'], cfg.dataDir, null);
  /* 库文件覆盖：默认由 platform/paths.js 决定（dataRoot/board.db）。这一项存在的理由：
     自检要证明"库不可写 ⇒ 拒绝启动"这条线**可达**，就需要一个"目录可写、但库文件不可写"的场景 ——
     只覆盖数据根做不到（那时日志目录也会跟着不可写，失败点在更早的建日志处）。 */
  const dbFileRaw = pick('dbFile', args.dbFile, ['DSH_BOARD_DB_FILE'], cfg.dbFile, null);
  const crashRaw = pick('crash', args.crash, ['DSH_BOARD_CRASH'], null, null);
  const crashMode = crashRaw === 'uncaught' || crashRaw === 'rejection' ? crashRaw : null;
  if (crashRaw && !crashMode) {
    throw new Error(`--crash 只接受 uncaught | rejection（收到 ${JSON.stringify(crashRaw)}）`);
  }
  return {
    host,
    port,
    dataDir: dataDirRaw ? path.resolve(String(dataDirRaw)) : null,
    dbFile: dbFileRaw ? path.resolve(String(dbFileRaw)) : null,
    crashMode,
    maxBodyBytes: cfg.maxBodyBytes,
    sources
  };
}

/** 读取需求基线版本串（真源＝配置/适配层头部注释的「需求版本：Vx.yz」） */
function readBaselineVersion() {
  for (const file of BASELINE_SOURCES) {
    try {
      const m = fs.readFileSync(file, 'utf8').match(/需求版本：(V\d+(?:\.\d+)*)/);
      if (m) return m[1];
    } catch { /* 读不到就试下一个来源 */ }
  }
  return 'unknown';
}

/* ---------------- 二、启动自检（失败即退非零，绝不"假活"） ---------------- */

/**
 * 自检函数集。每项返回 `{ok:boolean, reason:string, detail?:string}`。
 * 为什么失败必须退出而不是"打个警告继续"：一个起得来但库写不进去的进程会被现场当成"服务正常"，
 * 后续所有落库动作静默失败 —— 这正是"假活"，比直接不启动更难排查。
 */
const SELF_CHECKS = {
  /** ③ 时间源可读（DR-16 全部时间戳都经 platform/clock，注入时钟坏掉会让班次归属全错） */
  timeSource() {
    try {
      const clock = platformClock.createClock({ mode: 'real' });
      const now = clock.now();
      const formatted = platformClock.fmt(now);
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        return { ok: false, reason: `时钟返回了非法时间：${String(now)}` };
      }
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(formatted)) {
        return { ok: false, reason: `时间格式不符合 DR-16（yyyy-MM-dd HH:mm:ss）：${formatted}` };
      }
      return { ok: true, reason: '', detail: formatted };
    } catch (err) {
      return { ok: false, reason: `时间源不可读：${err.message}` };
    }
  },

  /** ② 关键目录可写（逐个真写一个探针文件再删，而不是只看 existsSync） */
  dirWritable(key) {
    const dir = platformPaths.paths[key];
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.w6-write-probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok', 'utf8');
      const back = fs.readFileSync(probe, 'utf8');
      fs.rmSync(probe, { force: true });
      if (back !== 'ok') return { ok: false, reason: `${key} 写入后读回不一致` };
      return { ok: true, reason: '', detail: dir };
    } catch (err) {
      return { ok: false, reason: `${key} 不可写（${dir}）：${err.message}` };
    }
  },

  /**
   * ① 库可打开且可写。
   * 为什么用**临时表 + 删表**验证写能力：`PRAGMA query_only` 之类的读探测证明不了写；
   * 真写一张临时表再删掉，既不碰业务数据，又能把"只读挂载/权限不足/WAL 目录不可写"这类问题一次问出来。
   * @param {object} db 已打开的库句柄（由 initSchema 之后的连接给出）
   */
  dbWritable(db) {
    try {
      const row = db.prepare('PRAGMA quick_check').get();
      const detail = row ? String(Object.values(row)[0]) : '';
      if (detail && detail !== 'ok') return { ok: false, reason: `库完整性自检未通过：${detail}` };
      db.exec('CREATE TEMP TABLE IF NOT EXISTS w6_write_probe(v INTEGER)');
      db.prepare('INSERT INTO w6_write_probe(v) VALUES (?)').run(1);
      const n = db.prepare('SELECT COUNT(*) AS c FROM w6_write_probe').get().c;
      db.exec('DROP TABLE w6_write_probe');
      if (Number(n) < 1) return { ok: false, reason: '临时表写入后读不到行 —— 库不可写' };
      return { ok: true, reason: '', detail: '临时表写入/回读/删除均成功' };
    } catch (err) {
      return { ok: false, reason: `库不可写：${err.message}` };
    }
  }
};

/**
 * 跑完整套启动自检。
 * @returns {{ok:boolean, failures:Array<{name:string, reason:string}>, results:object}}
 */
function assertSelfCheck(db) {
  const results = {
    dbWritable: SELF_CHECKS.dbWritable(db),
    dataDir: SELF_CHECKS.dirWritable('dataRoot'),
    logDir: SELF_CHECKS.dirWritable('logDir'),
    backupDir: SELF_CHECKS.dirWritable('backupDir'),
    timeSource: SELF_CHECKS.timeSource()
  };
  const failures = Object.entries(results)
    .filter(([, r]) => !r.ok)
    .map(([name, r]) => ({ name, reason: r.reason }));
  return { ok: failures.length === 0, failures, results };
}

/* ---------------- 三、进程骨架 ---------------- */

/** 运行态（同时只有一个实例：`start()` 会拒绝重复启动，避免两个监听抢同一个端口） */
const state = {
  running: false,
  server: null,
  router: null,
  db: null,
  dbFile: null,
  logger: null,
  config: null,
  clock: null,
  startedAt: 0,
  stopping: null,
  lastError: null
};

/**
 * 解析注入时钟（E42：让 `startedAt` / `uptimeSec` / `lastError.at` 都能被注入时钟钉死，
 * 不再"时间戳只能读墙钟"）。只认"时钟对象"（有 `now()`，与 `platform\clock.js` /
 * `tests\lib\clock.js` 的共同子集一致）；缺 `source()` 的最简注入按**同一时刻**补一个适配层
 * —— 适配层不含自己的时间，故不算"第二套时钟"。
 */
function resolveClock(options = {}) {
  const injected = options.clock;
  if (injected && typeof injected.now === 'function') {
    if (typeof injected.source === 'function') return injected;
    return { now: () => injected.now(), source: () => () => injected.now() };
  }
  return platformClock.createClock({ mode: 'real' });
}

/** 当前生效的时钟：注入的优先；未注入（含崩溃兜底早于 `start()`）即模块级真实时钟。 */
function currentClock() {
  return state.clock || processClock;
}

/** 当前时刻的 ISO 串 —— `lastError.at` 一律经此取，不再裸 `new Date().toISOString()`。 */
function isoNow() {
  return currentClock().now().toISOString();
}

/** 当前监听地址（未监听时给配置值，便于日志与自检在任何阶段都能读到） */
function listenAddress() {
  const srv = state.server;
  if (srv && typeof srv.address === 'function') {
    const addr = srv.address();
    if (addr && typeof addr === 'object') return { address: addr.address, port: addr.port, family: addr.family };
  }
  return state.config
    ? { address: state.config.host, port: state.config.port, family: '' }
    : { address: DEFAULT_HOST, port: DEFAULT_PORT, family: '' };
}

/** `GET /health` 的响应体。字段口径写在 `server\README`（本包无 README，见回执"未决"）与 tests 断言里。 */
function healthPayload() {
  const addr = listenAddress();
  /* IF-D 采集子集（W1）：`state.router.ifdStatus` 由挂载处挂上（未接线时为 undefined）。
     为什么放进 `/health`：FR-2.6 的"在线/离线"要有**可被读取**的出口，巡检与门禁都已有探 `/health` 的习惯；
     同一份数据仍由 `GET /ifd/status` 完整提供（含计数与 source 启用情况），两处同源不另算。 */
  const ifd = state.router && typeof state.router.ifdStatus === 'function' ? state.router.ifdStatus() : null;
  return Object.assign({
    ok: true,
    uptimeSec: state.startedAt ? Math.max(0, Math.round((currentClock().now().getTime() - state.startedAt) / 1000)) : 0,
    dbWritable: Boolean(state.db),
    version: readBaselineVersion(),
    listen: `${addr.address}:${addr.port}`,
    pid: process.pid,
    env: process.env.DSH_ENV || 'dev',
    dataRoot: platformPaths.paths.dataRoot,
    dbFile: state.dbFile || platformPaths.paths.dbFile,
    streams: state.router ? state.router.streamCount() : 0,
    lastError: state.lastError
  }, ifd ? { ifd } : {});
}

/** 启动期致命错误：**明确报错并退非零**（退 2 与 tests/env.js 的"脚本自身异常"口径一致） */
function fatal(logger, title, lines) {
  const text = [title].concat(lines || []).join('\n');
  if (logger) logger.error(text); else console.error(text);
  process.exitCode = 2;
  process.exit(2);
}

/**
 * 启动服务。
 * @param {{
 *   argv?:string[], env?:object, boardConfig?:object, logger?:object,
 *   heartbeatMs?:number, installSignalHandlers?:boolean, logConsole?:boolean,
 *   clock?:{now:Function, source?:Function}
 * }} [options]
 *   `clock` 是**时钟注入出口**（E42）：传了就全进程（路由 / IF-D / IF-A / `/health` 的
 *   `uptimeSec` / `lastError.at`）都用它，未传即 `platformClock.createClock({mode:'real'})`。
 * @returns {Promise<{host:string, port:number, listen:string, router:object, logger:object, health:Function}>}
 */
async function start(options = {}) {
  if (state.running) throw new Error('start(): 进程内已有服务在运行（请先 stop()）');
  /* 允许"停后再起"：清掉上一轮的收尾标记，否则新一轮收到信号会被幂等短路掉、永远不会退 */
  state.stopping = null;
  state.lastError = null;
  /* 时钟注入出口（E42）：从这里起，本进程的"现在几点"只有一个来源 */
  state.clock = resolveClock(options);
  const installSignalHandlers = options.installSignalHandlers !== false;

  /* ---- 1. 配置 ---- */
  const cfg = resolveConfig({ argv: options.argv, env: options.env, boardConfig: options.boardConfig });
  state.config = cfg;

  /* ---- 2. 数据根目录（用 platform/paths.js 这一层，业务代码不得自己拼路径：D11） ---- */
  if (cfg.dataDir) {
    try {
      platformPaths.overrideDataRoot(cfg.dataDir);
    } catch (err) {
      fatal(null, '[启动自检未通过]', [`数据根目录被拒绝：${err.message}`]);
    }
  }

  /* ---- 3. 日志（NFR-21；创建时即剪一次过期日志） ---- */
  let logger = options.logger || null;
  if (!logger) {
    try {
      logger = createLogger({
        dir: platformPaths.paths.logDir,
        level: options.logLevel || 'info',
        console: options.logConsole !== false
      });
    } catch (err) {
      fatal(null, '[启动自检未通过]', [`日志目录不可用（${platformPaths.paths.logDir}）：${err.message}`]);
    }
  }
  state.logger = logger;

  /* ---- 4. 打开库并建表（复用 server/db，不另起一套） ---- */
  let handle = null;
  const dbFile = cfg.dbFile || platformPaths.paths.dbFile;
  try {
    handle = dbApi.openDb(dbFile);
    dbApi.initSchema(handle.db);
  } catch (err) {
    try { if (handle && handle.db) handle.db.close(); } catch { /* 关不掉不掩盖原始错误 */ }
    fatal(logger, '[启动自检未通过]', [`数据库不可用（${dbFile}）：${err.message}`]);
    throw err;   // fatal 已 exit；这行只保证静态分析看得出"此处不会继续"
  }
  state.db = handle.db;
  state.dbFile = dbFile;

  /* ---- 5. 启动自检：库可写 / 目录可写 / 时间源可读 ---- */
  const check = assertSelfCheck(state.db);
  logger.info(`[启动自检] ${check.ok ? '通过' : '未通过'}：` +
    Object.entries(check.results).map(([k, v]) => `${k}=${v.ok ? 'ok' : 'FAIL'}`).join(' '));
  if (!check.ok) {
    try { dbApi.flushWal(state.db); } catch { /* 尽力 */ }
    try { state.db.close(); } catch { /* 尽力 */ }
    state.db = null;
    fatal(logger, '[启动自检未通过] —— 拒绝以"假活"状态启动（库不可写/目录不可写/时间源不可读都必须先修）',
      check.failures.map(f => `  - ${f.name}: ${f.reason}`));
  }

  /* ---- 6. 路由与监听 ---- */
  const router = createRouter({
    getHealth: () => healthPayload(),
    /* 时钟注入出口（ADR-0003 D17 / E42）：全进程**同一份**时钟（`currentClock()`），
       形态仍是 `platformClock.createClock({mode:'real'}).source()`，不新造第二套 ——
       SSE 的 ready/ping/openedAt 时间戳由它给出，`router.js` 里不再裸 `new Date()`；
       于是 `start({clock})` 注入固定时钟时，路由/IF-D/IF-A 与 `/health` 的 uptime 用的是同一时刻。 */
    now: currentClock().source(),
    onError: (err, extra) => {
      state.lastError = { message: err.message, at: isoNow() };
      logger.error(`[HTTP 500] ${err && err.stack ? err.stack : err}`, extra);
    },
    maxBodyBytes: cfg.maxBodyBytes,
    heartbeatMs: options.heartbeatMs
  });

  /* 自检注入的**测试端点**（默认不注册任何东西，正式运行不会走到）：
     为什么需要这个口子：400/413 是 `router.readJson()` 的行为判据，若路由表里没有任何"读 JSON 体"
     的端点，"坏 JSON ⇒ 400 / 超大 body ⇒ 413"就只能靠匹配源码字符串来"证明"（违反 D23 行为判据）。
     故仅在调用方**显式**传 `testRoutes: true` 时注册一个只做"读体 + 回显"的 `/__w6/echo`，
     不含任何业务逻辑；它属自检面而非交付面（回执与日志里都标注）。 */
  if (options.testRoutes === true) {
    router.post('/__w6/echo', async (req, res) => {
      const body = await router.readJson(req);
      return router.json(res, 200, { ok: true, echo: body, maxBodyBytes: router.maxBodyBytes });
    });
    logger.warn('[启动自检] 已注册测试端点 POST /__w6/echo（testRoutes=true，仅供自检，非交付面）');
  }
  state.router = router;

  /* ---- 6b. W1 业务挂载：IF-D 采集接入（上位机实时帧 → 校验 → 去重 → 1 s 采样落库） ----
     依据 `server/http/router.js` 挂载位的指引（"实现这些包时，请把注册写进对应函数体"），
     注册动作在 `server/http/routes/ifD.js` 的 `mountIfD()` 里完成，本处**只接一次线**
     （不在此另起路由表，避免路由清单分叉成两份真源）。
     形态说明：当前启用**推送**（`POST /ifd/frame`）；**轮询**（看板作客户端去 `upper.url` 取数）
     已在 `services/ingest.js` 的 `createPoller()` 实现但**默认未启用** —— 谁主动待 U-0.1 / Q-21 答复。
     时钟用生产时钟（real）：断连判据（FR-2.6 ≤5 s）在自检里由注入时钟验证，线上走真实时间。 */
  const ifd = mountIfD(router, {
    db: state.db,
    logger,
    now: currentClock().source()
  });
  /* 把 IF-D 状态快照挂到 router 上（**只挂一个只读函数**，不改 router.js）：
     `healthPayload()` 据此把断连状态一并暴露到 `GET /health`（FR-2.6 的"可被读取"），
     路由清单仍只有一份真源（本处不新增路由、不另起路由表）。 */
  router.ifdStatus = ifd.status;
  logger.info(`[路由] IF-D 采集已接线（${ifd.by}）：${ifd.routes.join(' , ')}；` +
    `去重主口径=equipCode+procOrderNo+collectTime+seq（无 seq 走退路口径）；落库=1 s 采样（ADR-0001 D7）`);

  /* ---- 6c. W2 业务挂载：IF-A 接收（MES 派工/物料/工艺/设备；本机提供接口） ----
     依据 `server/http/router.js` 挂载位的指引（"请把注册写进对应函数体"），注册动作在
     `server/http/routes/ifA.js` 的 `mountIfA()` 里完成，本处**只接一次线**（不在此另起路由表）。
     访问控制（负责人 2026-09-27 裁定①）：配置键 `board.config.js` 的 `server.ifAuth.{enabled,token}`，
     环境变量 `DSH_BOARD_IF_TOKEN` 可覆盖；**未配置时默认放行并在挂载时显著告警**（由 ifA 侧执行，
     与下方"监听范围告警"同风格），配置后请求头须携带令牌（401/403 且落 op_log）。
     权威侧：equipCode / 工单 / 工艺**以 IF-A 为权威**，本机配置仅兜底、不一致时给可见提示（FR-1.2/IF-D.12）；
     IF-D 侧取值仅比对与展示（C-100 / C-102）—— 比对快照取自 IF-D 服务实例的最近有效帧。 */
  const ifa = mountIfA(router, {
    db: state.db,
    logger,
    now: currentClock().source(),
    ifd: () => {
      /* IF-D 侧取值**仅供比对与展示**（C-100 / C-102）：取内存态最近一帧（`ingest.lastFrame()`，
         由 ifD 挂载结果暴露的 `instance` 读到；**不改 ifD.js、不加新真源**）。取不到就是 null，
         比对逻辑在 `services/dispatch.js` 里对 null 静默跳过（"没有可比对象"不等于"一致"）。 */
      const f = ifd.instance && typeof ifd.instance.lastFrame === 'function' ? ifd.instance.lastFrame() : null;
      if (!f) return null;
      return {
        equipCode: f.equipCode === undefined ? null : f.equipCode,
        procOrderNo: f.procOrderNo === undefined ? null : f.procOrderNo,
        frameRate: f.frameRate === undefined ? null : f.frameRate,
        gain: f.gain === undefined ? null : f.gain,
        shutter: f.shutter === undefined ? null : f.shutter,
        cameraDepth: f.cameraDepth === undefined ? null : f.cameraDepth
      };
    }
  });
  logger.info(`[路由] IF-A 接收已接线（${ifa.by}）：${ifa.routes.join(' , ')}；` +
    `幂等口径=task 按 proc_order_no 幂等（不覆盖）/ device 按 equip_code 后到覆盖 / 物料·工艺按报文签名幂等；` +
    `留痕=op_log（成功与失败都留，幂等命中不追加）；访问控制=${ifa.status().auth.enabled ? '已启用' : '未配置（放行+告警）'}`);

  const server = http.createServer((req, res) => {
    /* 统一入口；路由器内部已经把异常收敛成稳定的 JSON 错误体，这里再兜一层"连响应都发不出去"的情况 */
    Promise.resolve(router.handle(req, res)).catch(err => {
      state.lastError = { message: err.message, at: isoNow() };
      logger.error(`[HTTP 处理异常] ${err && err.stack ? err.stack : err}`, { url: req.url });
      try { res.destroy(); } catch { /* 已断开 */ }
    });
  });
  server.on('clientError', (err, socket) => {
    logger.warn(`[HTTP 客户端错误] ${err.code || err.message}`);
    try { socket.destroy(); } catch { /* 已断开 */ }
  });
  state.server = server;

  const listen = () => new Promise((resolve, reject) => {
    const onError = err => {
      if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
        reject(new Error(`监听 ${cfg.host}:${cfg.port} 失败：${err.code} —— ` +
          '端口被占用或无权限（可用 --port 换一个空闲端口）'));
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(cfg.port, cfg.host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  try {
    await listen();
  } catch (err) {
    try { state.db.close(); } catch { /* 尽力 */ }
    state.db = null;
    state.server = null;
    fatal(logger, '[启动失败]', [`  - ${err.message}`]);
  }

  const addr = server.address();
  const listenText = `${addr.address}:${addr.port}`;
  state.startedAt = currentClock().now().getTime();
  state.running = true;

  logger.info(`[启动完成] 监听 ${listenText}（pid=${process.pid}，DSH_ENV=${process.env.DSH_ENV || 'dev'}）`);
  logger.info(`[启动完成] 数据根=${platformPaths.paths.dataRoot}；库=${platformPaths.paths.dbFile}；` +
    `需求基线=${readBaselineVersion()}；配置来源=${JSON.stringify(cfg.sources)}`);
  logger.info(`[路由] 已注册：${router.list().join(' , ')}；后续挂载位（本包未实现）：` +
    [router.mountIfA(), router.mountIfD(), router.mountUpload(), router.mountSSE()]
      .map(m => `${m.mount}(${m.by})`).join(' , '));

  /* ⚠ 监听范围告警（NFR-25 / AC-09）：本系统**不得对外**提供服务。
     若把 --host 配成非回环地址（如 0.0.0.0 或本机局域网 IP），即为**对外暴露**，
     违反 NFR-25 / AC-09（"不得对外"），必须有负责人书面批准；此告警**刻意写两次**
     （warn 与 error 各一次）以免被淹没在日志里。 */
  if (!isLoopbackHost(addr.address)) {
    logger.warn(`[⚠ 监听范围告警] 当前绑定 ${listenText} —— **非回环地址**，局域网/外部主机可达！` +
      ' 违反 NFR-25 / AC-09（不得对外），需负责人批准后才允许这样运行。');
    logger.error(`[⚠ 监听范围告警] 对外地址确认：${listenText}（NFR-25/AC-09 要求默认仅本机；请核对配置来源）`);
  }

  /* ---- 7. 信号处理器（优雅退出的正式入口） ---- */
  if (installSignalHandlers) installSignals();

  /* ---- 8. 自检用的故障注入位（正式运行不会走到） ---- */
  if (cfg.crashMode) {
    const mode = cfg.crashMode;
    logger.warn(`[自检模式] 将在 500 ms 后注入 ${mode} —— 仅用于验证"未捕获异常不静默"这条线`);
    setTimeout(() => {
      if (mode === 'uncaught') {
        setImmediate(() => { throw new Error('W6 自检注入：未捕获异常（DSH_BOARD_CRASH=uncaught）'); });
      } else {
        Promise.reject(new Error('W6 自检注入：未处理的 Promise rejection（DSH_BOARD_CRASH=rejection）'));
      }
    }, 500);
  }

  return {
    host: addr.address,
    port: addr.port,
    listen: listenText,
    router,
    logger,
    health: healthPayload
  };
}

/** 注册 SIGINT/SIGTERM/SIGHUP ⇒ 走同一条优雅退出路径（幂等） */
function installSignals() {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    if (process.listeners(sig).includes(onSignal)) continue;
    process.on(sig, onSignal);
  }
}
/** 顶层命名函数而非匿名箭头：`process.listeners()` 里可辨认，重复注册也能去重 */
function onSignal(sig) {
  if (state.stopping) return;
  state.stopping = stop(sig).catch(err => {
    console.error(`[优雅退出失败] ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

/**
 * 优雅退出：**停收新连接 → 等在途请求（有上限）→ 关 SSE → WAL checkpoint → 关库**。
 * 幂等（重复调用返回同一个 Promise）。**不在这里 `process.exit(0)`** ——
 * 让事件循环自然排空后以 0 退出，这样"句柄泄漏"会表现为"进程退不掉"而不是被掩盖。
 * @param {string} [reason] 触发原因（信号名/自检调用），只用于日志
 */
function stop(reason) {
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    const logger = state.logger;
    const log = (level, msg) => { if (logger) logger[level](msg); };
    const server = state.server;
    if (!server) { log('info', '[优雅退出] 服务未在运行，无需收尾'); return { code: 0, reason: reason || 'not-running' }; }

    log('info', `[优雅退出] 收到 ${reason || 'stop()'}：停止接受新连接，等待在途请求（上限 ${SHUTDOWN_TIMEOUT_MS} ms）`);
    installSignals();   // 确保期间再次收到信号走同一条路径（幂等）

    await new Promise(resolve => {
      let settled = false;
      const done = why => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (why === 'timeout') log('warn', `[优雅退出] 等待在途请求超过 ${SHUTDOWN_TIMEOUT_MS} ms，强制收尾`);
        resolve();
      };
      const timer = setTimeout(() => done('timeout'), SHUTDOWN_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        /* close 的回调只在"所有连接结束"后触发 —— 这正是"等在途请求"的实现；
           SSE 长连接不会自己结束，故紧接着要主动收掉（见下）。 */
        server.close(() => done('closed'));
      } catch (err) {
        log('warn', `[优雅退出] server.close 失败：${err.message}`);
        done('error');
      }
      if (state.router) {
        const n = state.router.closeAllStreams();
        if (n) log('info', `[优雅退出] 已关闭 ${n} 条 SSE 连接（空通道，无业务数据在途）`);
      }
    });

    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();

    try {
      const cp = dbApi.flushWal(state.db);
      log(cp.ok ? 'info' : 'warn', `[优雅退出] WAL checkpoint ${cp.ok ? '完成' : '失败：' + cp.error}`);
    } catch (err) {
      log('warn', `[优雅退出] WAL checkpoint 异常：${err.message}`);
    }
    try { state.db.close(); } catch (err) { log('error', `[优雅退出] 关库失败：${err.message}`); }
    state.db = null;
    state.server = null;
    state.running = false;
    log('info', '[优雅退出] 完成：监听已关闭、库已关闭');
    return { code: 0, reason: reason || 'stop' };
  })();
  return state.stopping;
}

/* ---------------- 四、异常兜底（**不得静默**） ---------------- */

/**
 * 装"最后一层网"：未捕获异常 / 未处理 rejection 一律记日志并**退非零**。
 * 为什么必须退非零：进程带伤继续跑就是"假活"（NFR：崩溃可自愈的前提是**先让它可见地崩**，
 * 由守护方重启）；退 1 与 tests/env.js 的"脚本失败"口径一致。
 */
function installCrashGuards() {
  process.on('uncaughtException', err => {
    state.lastError = { message: err && err.message, at: isoNow(), kind: 'uncaughtException' };
    try {
      if (state.logger) state.logger.error(`[未捕获异常] ${err && err.stack ? err.stack : err}`);
      else console.error(`[未捕获异常] ${err && err.stack ? err.stack : err}`);
    } catch { /* 日志本身坏了也要退 */ }
    process.exit(1);
  });
  process.on('unhandledRejection', reason => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    state.lastError = { message: err.message, at: isoNow(), kind: 'unhandledRejection' };
    try {
      if (state.logger) state.logger.error(`[未处理的 Promise rejection] ${err.stack || err.message}`);
      else console.error(`[未处理的 Promise rejection] ${err.stack || err.message}`);
    } catch { /* 同上 */ }
    process.exit(1);
  });
}

/* ---------------- 五、入口 ---------------- */

/**
 * 进程入口：装异常兜底 → 启动 → 成功即驻留（监听套接字本身让事件循环存活）。
 * @returns {Promise<void>} 仅在启动阶段返回；成功时进程继续驻留
 */
async function main(options = {}) {
  installCrashGuards();
  await start(options);
}

/* 直接运行本文件（`node server\index.js`）时自动启动；被 require 时只导出（自检需要这个能力） */
if (require.main === module) {
  main().catch(err => {
    const logger = state.logger;
    const text = `[启动失败] ${err && err.stack ? err.stack : err}`;
    if (logger) logger.error(text); else console.error(text);
    process.exit(2);
  });
}

module.exports = {
  main,
  start,
  stop,
  installSignals,
  installCrashGuards,
  resolveConfig,
  parseArgs,
  assertSelfCheck,
  readBaselineVersion,
  healthPayload,
  listenAddress,
  isLoopbackHost,
  DEFAULT_HOST,
  DEFAULT_PORT,
  SHUTDOWN_TIMEOUT_MS,
  state
};
