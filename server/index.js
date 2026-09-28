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
const { createRouter, pathnameOf } = require('./http/router');
/* W1 的挂载口（`server/http/routes/ifD.js`）：IF-D 采集接入的唯一接线点，见下方 6b 段 */
const { mountIfD } = require('./http/routes/ifD');
/* W2 的挂载口（`server/http/routes/ifA.js`）：IF-A 接收（MES 派工/物料/工艺/设备）的唯一接线点，见下方 6c 段 */
const { mountIfA } = require('./http/routes/ifA');
/* W4 的挂载口（`server/http/routes/upload.js`）：IF-B 上报的**人工重报/待补传状态**接口（UI-20）
   的唯一接线点，见下方 6d 段。**本文件只接一次线**，路由登记全部在 mountUpload() 里完成
   （不在入口另起路由表 —— 否则路由清单会分叉成两份真源，见 `router.js` 挂载位的说明）。 */
const { mountUpload } = require('./http/routes/upload');
/* W5-③ 的挂载口（`server/http/routes/auth.js`）：ADR-0007「设置页口令与登录鉴权」的唯一接线点，
   见下方 6d-2 段。**本文件只接一次线**，5 条 `/auth/*` 路由的登记全部在 `mountAuth()` 里完成
   （不在入口另起路由表 —— 否则路由清单会分叉成两份真源）。 */
const { mountAuth } = require('./http/routes/auth');
/* W5-① 的两块：进程内事件总线（业务写入点 → 推送的唯一通道）与整机快照构造器
   （`hello` 与 `GET /state` **同一构造函数**产出，禁两套拼装）。见下方 6e 段。 */
const { createEventBus } = require('./services/eventBus');
const { createStateSnapshot } = require('./services/stateSnapshot');
/* W5-③ 的鉴权服务（`server/services/auth.js`）：scrypt 哈希 / 错误次数落库锁定 / 内存会话令牌 /
   一次性初始化码。**纯逻辑**，HTTP 适配在 `routes/auth.js`，本处只建实例并接线（见 6d-2 段）。 */
const { createAuth } = require('./services/auth');
/* W5-① 追加（负责人 2026-09-28 裁定「选项 A」）：CORS（`file://` 的 `Origin: null` 与回环端口源）
   与静态托管（同源入口 `GET /` + `GET /src/**`）。见下方 6f 段。 */
const { createCors, isLoopbackHost } = require('./http/cors');
const { mountSite } = require('./http/site');

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
/** 停机期间**空闲连接回收**的间隔（毫秒）：见 `stop()` 的 F2 说明 —— 在途请求应答完会变成空闲
 *  keep-alive 连接，只回收一次会漏掉它，`server.close()` 于是被对端 FIN 拖住。 */
const SHUTDOWN_IDLE_SWEEP_MS = 50;
/** 是否回环地址（本服务默认只允许这一类；对外地址必须显式配置并由负责人批准）
 *  判据实现只有一份 = `server/http/cors.js` 的 `isLoopbackHost`（CORS 的"仅回环才回跨源头"用的
 *  是同一条判据 —— 两处各写一遍必然漂移）。本处仅转发，导出名保持不变（既有自检在用）。 */

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
  lastError: null,
  /** W5-①：事件总线与链路状态监控（优雅退出时都要收尾：退订/清定时器/释放缓冲） */
  bus: null,
  linkMonitor: null
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
 *   `uptimeSec` / `lastError.at` / SSE 的 `at` 与注释帧）都用它，未传即 `platformClock.createClock({mode:'real'})`。
 *   `heartbeatMs` / `linkIntervalMs` / `busCapacity` 是**自检用的注入位**（线上口径不变）：
 *   SSE 心跳周期、链路状态轮询周期、事件总线环形缓冲容量。
 * @returns {Promise<{host:string, port:number, listen:string, router:object, logger:object,
 *                    health:Function, bus:object, snapshot:Function, linkMonitor:object,
 *                    mounts:object}>}
 *   `bus`/`snapshot`/`linkMonitor`/`mounts` 是**装配结果的自报**（自检与运维读"到底接了什么线"），
 *   不构成第二条真源：它们就是本文件传给各挂载口的同一批对象。
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
    /* E18（W5-③）：`initSchema()` 在**破坏性迁移/结构变更之前**会强制备份（复用 `server/db/maintain.js`），
       备份**失败即抛错中止**（业务数据一行不动），并把结果如实回报。这里把结果落到启动日志：
        · 需要迁移 ⇒ "迁移前已备份：<path>（原因 …；体积；审计 op_log=…）"；
        · 不需要迁移（新建库/重复初始化）⇒ "无破坏性迁移，未备份"（幂等：不会每次启动多产一份）。
       `logger` 一并透传（**F17-3**）：审计留痕写不进去时由 db 层**就地** `logger.warn` 告警
       （返回值同时带 `auditDegraded:true`），故这里不再重复告警一次（避免同一条警告打两遍）。
       **F20**：极旧库（连 `op_log` 都没有）那一刻审计失败、但迁移后 db 层会**补写**（`auditBackfilled`）
       ⇒ 日志必须如实分三种：`ok #<id>` / `写入失败→已 backfill #<id>` / `写入失败（已告警…）`
       （改前此处一律打印第三种，与"其实已 backfill 成功"的事实不符）。 */
    const schemaInfo = dbApi.initSchema(handle.db, undefined, { logger });
    const pre = schemaInfo && schemaInfo.preMigrationBackup;
    if (pre && pre.needed) {
      logger.info(`[启动] E18 迁移前已备份：${pre.path}（原因 ${pre.reason}；${pre.bytes} 字节；` +
        `engine=${pre.engine}；审计 op_log=${pre.audit && pre.audit.ok
          ? 'ok #' + pre.audit.id
          : (pre.auditBackfilled
            ? '写入失败→已 backfill #' + (pre.backfillAudit && pre.backfillAudit.id)
            : '写入失败（已告警，auditDegraded=true）')}）`);
    } else {
      logger.info(`[启动] E18 无破坏性迁移/结构变更，未产出迁移前备份（${pre ? pre.reason : '判据不可用'}）`);
    }
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

  /* ---- 6a. W5-① 事件总线（**先于各业务挂载创建**：业务写入点要拿它发布事件） ----
     依据负责人裁定 #3「看板内部连接＝SSE」：业务写入点（IF-D 采样落库 / IF-A 派工落库 /
     标准新增 / 上报队列状态迁移 / 判定产出）都只往这一条进程内总线发布，SSE 端点再从总线取数 ——
     推送与业务之间**没有第二条真源**。容量可注入（自检要能逼出"缓冲溢出丢最旧 + dropped 计数"）。 */
  const bus = createEventBus({
    now: currentClock().source(),
    logger,
    capacity: Number.isInteger(options.busCapacity) && options.busCapacity > 0 ? options.busCapacity : undefined
  });
  state.bus = bus;

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
    now: currentClock().source(),
    /* W5-①：`frame` 事件在 ingest 的 **1 s 采样落库**点发布（500 ms 原始帧不发布） */
    bus
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
    /* W5-①：`task` 事件在 dispatch 的**派工落库**点发布（幂等命中不发布） */
    bus,
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

  /* ---- 6d. W4 业务挂载：IF-B 上报的**人工重报/待补传状态**接口（UI-20 的消费口） ----
     依据 `server/http/router.js` 挂载位的指引（"实现这些包时，请把注册写进对应函数体"），
     注册动作在 `server/http/routes/upload.js` 的 `mountUpload()` 里完成，本处**只接一次线**
     （不在此另起路由表，避免路由清单分叉成两份真源）。
     职责边界（重要）：本挂载**只提供"上报状态 + 待补传清单 + 人工一键重报"**——
       · `GET /upload/pending` / `GET /upload/status` / `GET /upload/last`：给 UI-20 与巡检读；
       · `POST /upload/retry`：**唯一**会再次发送待补传报文的入口（人工触发）。
     **本包不做定时上报、不做自动重试**（IF-B.9 / V1.31 / C-59）：周期触发与前端切真实源属 W5；
     上报器（`services/uploadReporter.js`）的 `report()` 一次调用只发一次，失败即落 `upload_log`
     等人工补传，**不起任何定时器/退避**。`mes.baseUrl` 未配置（Q-23 未答）时所有端点都会
     如实返回"未配置"，不当作成功（见回执"未决"）。 */
  const upload = mountUpload(router, {
    db: state.db,
    logger,
    now: currentClock().source(),
    /* W5-①：`upload` 事件在待补传队列（upload_log 的唯一写路径）的状态迁移点发布 */
    bus
  });
  logger.info(`[路由] IF-B 上报接口已接线（${upload.by}）：${upload.routes.join(' , ')}；` +
    `不做自动重试（V1.31/C-59）：失败落 upload_log 留存 + 告警，重报只能经 POST /upload/retry 人工触发；` +
    `MES 地址=${upload.status().configured ? upload.status().baseUrl : '未配置（Q-23，端点会显式 skipped）'}`);

  /* ---- 6d-2（W5-③）. 鉴权挂载：ADR-0007「设置页口令与登录鉴权」 ----
     依据 `server/http/router.js` 挂载位的指引（"实现这些包时，请把注册写进对应函数体"），
     注册动作在 `server/http/routes/auth.js` 的 `mountAuth()` 里完成，本处**只接一次线**
     （不在此另起路由表，避免路由清单分叉成两份真源）。
     三条口径（与 ADR-0007 一致，细则写在 `server/services/auth.js`）：
       · **不设出厂默认口令**：无凭证行时 `createAuth()` 生成一次性初始化码（`randomBytes(6)`），
         打印到控制台并写 `op_log`，**仅本机回环**可用、成功后立即作废、重启重新生成；
       · **与 IF-A 静态令牌严格分开**：`server.ifAuth.token` 只给对外接口，本挂载的会话令牌只给看板解锁，
         两套互不复用（`server/services/auth.js` 里没有任何一处读 `ifAuth.token`）；
       · 时钟仍走**同一个注入出口** `currentClock().source()`（ADR-0003 D17），**不新造第二套时钟**。
     位置：数据面挂载（IF-D/IF-A/IF-B）之后、SSE 之前 —— 路由必须在监听前全部注册完。 */
  const auth = createAuth({ db: state.db, logger, now: currentClock().source() });
  state.auth = auth;
  const authMount = mountAuth(router, { auth, logger, now: currentClock().source() });
  logger.info(`[路由] 鉴权已接线（${authMount.by}）：${authMount.routes.join(' , ')}；` +
    `口令哈希=${auth.algorithm}（${auth.params}）；失败阈值=${auth.limits.maxFailures} 次 ⇒ 锁定 ` +
    `${auth.limits.lockMinutes} 分钟；会话 TTL=${auth.limits.sessionHours} h（滑动续期，绝对上限 ` +
    `${auth.limits.absoluteHours} h）；当前状态=${auth.status().initialized
      ? '已初始化' : '未初始化（本机一次性初始化码已打印到控制台并写入 op_log）'}`);

  /* ---- 6e. W5-① 业务挂载：SSE 业务推送（真实 `/events` ＋ `GET /state`） ----
     依据 `server/http/router.js` 挂载位的指引（"实现这些包时，请把注册写进对应函数体"），
     本处**只接一次线**：`router.mountSSE({bus, snapshot})` 内部完成 `GET /state` 的注册，
     并把 `/events` 从 W6 的"空通道"切成真实推送（不在入口另起路由表，避免路由清单分叉）。
     顺序：必须在 IF-D/IF-A/IF-B **之后**（快照要读它们的实例：最新采样帧、链路状态、上报队列）。
     两件配套：
       · **链路状态监控**：把 `ingest.linkState()` 的变化（在线↔离线，FR-2.6）发布成 `link` 事件；
         定时器可注入、`stop()` 时清掉（**进程退出后不得有残留定时器**）。
       · **快照构造器**：`hello` 与 `GET /state` 共用的**唯一**来源（禁两套拼装）。 */
  const linkMonitor = ifd.instance.createLinkMonitor({
    bus,
    logger,
    intervalMs: Number.isInteger(options.linkIntervalMs) && options.linkIntervalMs > 0
      ? options.linkIntervalMs : undefined
  });
  linkMonitor.start();
  state.linkMonitor = linkMonitor;

  const snapshot = createStateSnapshot({
    db: state.db,
    now: currentClock().source(),
    ingest: ifd.instance,
    upload: upload.instance,
    logger
  });
  const sse = router.mountSSE({ bus, snapshot, logger });
  logger.info(`[路由] SSE 业务推送已接线（${sse.by}）：${sse.routes.join(' , ')}；` +
    `事件种类=${require('./services/eventBus').KINDS.join('/')}；` +
    `心跳=${options.heartbeatMs || '默认 15000'} ms；链路监控=${linkMonitor.intervalMs} ms（阈值真源＝upper.staleMs）；` +
    `环形缓冲容量=${bus.capacity}（溢出丢最旧并计 dropped）`);

  /* ---- 6f. W5-① 追加：静态托管（同源入口）＋ CORS（`file://` / 回环源） ----
     依据负责人 2026-09-28 裁定「选项 A」：
       · 前端仍可双击 `index.html`（`file://` ⇒ `Origin: null`）：**仅当绑定回环**时回
         `Access-Control-Allow-Origin: null`；非回环绑定**一律不回任何 CORS 头**（守 NFR-25/AC-09）；
       · 首选入口改为**服务端托管静态页**（同源，彻底免掉跨源）：
         `GET /` ⇒ `index.html`，`GET /src/**` ⇒ `src\` 子树，**白名单式**（其余一律既有 JSON 404）。
     注册方式仍是"只接一次线"：静态托管把处理器挂到 `router.fallback()`（**不写路由表**，
     故 404/405 口径与路由清单都不变）；CORS 挂在 `http.Server` 的请求回调最前面。 */
  const site = mountSite(router, { logger });
  const cors = createCors({
    logger,
    bind: () => {
      const addr = listenAddress();
      return { host: addr.address, port: addr.port };
    }
  });
  logger.info(`[路由] 静态托管已接线（${site.by}）：${site.routes.join(' , ')}（白名单式；` +
    `其余路径仍走既有 JSON 404）；根=${site.root}`);
  logger.info(`[路由] CORS 已接线：白名单=${cors.status().origins.join(' / ')}；` +
    `方法=${cors.allowMethods}；请求头=${cors.allowHeaders}；凭证=${cors.status().allowCredentials}（不放开）；` +
    `仅回环绑定才回跨源头`);

  const server = http.createServer((req, res) => {
    /* CORS 先行：按来源决定要不要挂跨源头，并应答 OPTIONS 预检（已注册路径才应答；
       未注册路径的 OPTIONS 继续走 router 的既有 404/405 口径）。命中即已应答，不再往下走。 */
    if (cors.handle(req, res, {
      path: pathnameOf(req),
      knownPath: p => p !== null && (router.allowedMethods(p).length > 0 || site.isStaticPath(p))
    })) return;
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
  logger.info(`[路由] 已注册：${router.list().join(' , ')}；挂载位状态（空壳＝该包只留描述符、真实现由 ` +
    `routes\\*.js 接线；SSE 自 W5-① 起、auth 自 W5-③ 起都是真实挂载）：` +
    [router.mountIfA(), router.mountIfD(), router.mountUpload(), router.mountSSE(), authMount]
      .map(m => `${m.mount}(${m.by})${m.mounted ? '已接线' : '空壳'}`).join(' , '));

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
    health: healthPayload,
    /* W5-① 装配结果自报（自检/运维读"接了什么线"；不是第二条真源） */
    bus,
    snapshot,
    linkMonitor,
    cors,
    site,
    mounts: { ifd, ifa, upload, sse }
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
      /** F2：周期性回收空闲连接的定时器（`done()` 里必须停掉，否则会空转到进程退出） */
      let sweep = null;
      const done = why => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sweep) clearInterval(sweep);
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
        if (n) log('info', `[优雅退出] 已关闭 ${n} 条 SSE 连接（已发结束信号并清掉心跳定时器）`);
      }
      /* SSE 收掉后，那些连接（以及其它 keep-alive 空闲连接）**对端可能迟迟不发 FIN**（实测：Node 的
         fetch/undici 客户端会把它握到自己的 keep-alive 超时，约 2 s），而 `server.close()` 要等
         "所有连接结束"才回调 —— 于是停机被对端拖住。这里**只回收空闲连接**（不碰正在处理请求的
         连接，"等在途请求"的语义不变）：SSE 在 `res.end()` 之后即属空闲，可被立即回收。 */
      /* 停机期间"空闲连接"会**反复产生**，必须**反复回收**（F2，独立审查立案）：
         · SSE 被 `res.end()` 之后即属空闲；
         · 更要紧的是**在途请求**：它在停机窗口内应答完就变成空闲 keep-alive 连接，而
           "只在 server.close() 后立刻回收一次"的旧写法**再也碰不到它** ⇒ `server.close()`
           只能等对端 FIN（审查实测被拖到 ~6.35 s；对端是 undici 时约 2 s）。
         这里以 SHUTDOWN_IDLE_SWEEP_MS 的短间隔重复回收，直到 close 回调 / 内部截止
         （与 SHUTDOWN_TIMEOUT_MS 共用同一个 timer）。**只回收空闲连接**
         （`closeIdleConnections()` 的语义），正在处理请求的连接一律不碰 ——
         "在途请求不被误伤"这条判据保持成立（审查已实测 200 + 落库）。 */
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
        sweep = setInterval(() => {
          if (settled) return;
          if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        }, SHUTDOWN_IDLE_SWEEP_MS);
        if (typeof sweep.unref === 'function') sweep.unref();
      }
    });

    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();

    /* W5-① 收尾：链路监控的定时器与事件总线的订阅/缓冲都必须清掉 ——
       "进程退出后不得有残留定时器"是优雅退出的判据之一（定时器若还活着，事件循环就排不空）。 */
    if (state.linkMonitor) {
      try {
        state.linkMonitor.stop();
        log('info', '[优雅退出] 链路状态监控已停止（定时器已清除）');
      } catch (err) { log('warn', `[优雅退出] 链路监控停止失败：${err.message}`); }
      state.linkMonitor = null;
    }
    if (state.bus) {
      try {
        const subs = state.bus.close();
        log('info', `[优雅退出] 事件总线已关闭（清掉 ${subs} 个订阅者、缓冲已释放，` +
          `dropped=${state.bus.dropped()}）`);
      } catch (err) { log('warn', `[优雅退出] 事件总线关闭失败：${err.message}`); }
      state.bus = null;
    }

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
  SHUTDOWN_IDLE_SWEEP_MS,
  state
};
