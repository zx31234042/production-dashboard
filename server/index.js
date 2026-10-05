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
/* DR-05（`result` 表）的仓储层：**唯一写入口**（技术债 E58 ② 的写入归口，本文件 6e-3 段接线）。
   为什么放在入口而不是 ingest 里：写的是"**本看板判定**的产出"（FR-3.13），
   判定装配的唯一处就是本文件的 `emitWarnings()`（1 s 采样落库之后）—— 见 6e-2/6e-3 两段。 */
const resultRepo = require('./repo/result');
/* DR-06（`shift_stat`）／DR-08（`warning`）的仓储层：**唯一写入口**（技术债 E59／E62 的写入归口，
   依据 ADR-0009 D1／D3；负责人在 2026-10-02 裁定 A1）。接线位置见下方 6e-2／6e-4 两段：
   · `shiftStatRepo.upsertFrozen()` 由 `freezeCrossedShifts()` 在**既有 1 s 采样 tick 内**调用（不新增定时器）；
   · `warningRepo.insertWarning()` 由 `persistWarnings()` 在**判定发布点**（`emitWarnings()`）同批调用。 */
const shiftStatRepo = require('./repo/shiftStat');
const warningRepo = require('./repo/warning');
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
/* `FR-7.12`（P0，负责人 2026-10-02 裁定）的挂载口（`server/http/routes/notice.js`）：
   **IF-E 写路由** `POST /notice`（publish/edit/delete）＋ `op_log` 同批留痕（ADR-0009 D5：不改表）。
   见下方 6d-3 段。**本文件只接一次线**，路由登记全部在 `mountNotice()` 里完成
   （不在入口另起路由表 —— 否则路由清单会分叉成两份真源）。 */
const { mountNotice } = require('./http/routes/notice');
/* W5-① 的两块：进程内事件总线（业务写入点 → 推送的唯一通道）与整机快照构造器
   （`hello` 与 `GET /state` **同一构造函数**产出，禁两套拼装）。见下方 6e 段。 */
const { createEventBus } = require('./services/eventBus');
const { createStateSnapshot, statsForShift } = require('./services/stateSnapshot');
/* 班次真源（`services/shift.js`）：DR-06 的固化**不重算班次边界**，一律经它取
   （`at()` 给出 date/name/startAt/endAt/totalSec；跨零点归属规则只此一处）。 */
const { createShiftRules } = require('./services/shift');
/* W5-③ 的鉴权服务（`server/services/auth.js`）：scrypt 哈希 / 错误次数落库锁定 / 内存会话令牌 /
   一次性初始化码。**纯逻辑**，HTTP 适配在 `routes/auth.js`，本处只建实例并接线（见 6d-2 段）。 */
const { createAuth } = require('./services/auth');
/* W5-① 追加（负责人 2026-09-28 裁定「选项 A」）：CORS（`file://` 的 `Origin: null` 与回环端口源）
   与静态托管（同源入口 `GET /` + `GET /src/**`）。见下方 6f 段。 */
const { createCors, isLoopbackHost } = require('./http/cors');
const { mountSite } = require('./http/site');
/* W5-②（接线技术债 E45）判定装配的两块：判定引擎（`evaluate()` 是 `warning` 事件的唯一发布点）
   与标准取数（`standard` 表按"产品＋工序＋指定时刻生效版本"，DR-03）。见下方 6e-2 段。 */
const judge = require('./services/judge');
const standardSvc = require('./services/standard');
/* `DR-14` 保留策略（**唯一实现**＝`server/db/maintain.js` 的 `applyRetention()`；本处只接线、不重写）。
   技术债 `E89` 的落地：`DR-14`「统一保留 1 年」实现了却**零生产调用方** ⇒ 库无界增长、而
   `repo/notice.js` 文件头自述的"审计反地平线＝保留期（1 年）"是**带前提**的。本包按负责人
   2026-10-03 的裁定接线：**复用既有 1 s 采样 tick、按"跨自然日"触发**（不新增定时器，与 A1 的
   跨班检测同款）。接线点/去重/`maxDelete` 三处口径见下方 6e-5 段。 */
const maintain = require('./db/maintain');

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
/** 跨班补记一次最多枚举多少个班次（**只为防"配置异常时无限循环"**，不是业务上限：
 *  3 班/天 ⇒ 1000 个班次 ≈ 333 天，远大于"服务停摆一天"这种真实场景；枚举超出即如实记错、不静默）。 */
const MAX_BACKFILL_SHIFTS = 1000;
/* `DR-14` 裁剪（技术债 `E89`）**不另设上限**：单次删除的行数上限沿用 `maintain.RETENTION_MAX_DELETE`
   （**单一真源**，不在本文件复制常量 —— 复制一份就会出现"两处口径"）。选值与理由写在 6e-5 段。 */
/* 技术债 E58 的**临时闸已拆除**（T-20260930-08，负责人 2026-09-30 裁定的第②步）：
   闸的构成（`orderDoneSourceReady` 注入位 + `ORDER_DONE_SUPPRESS_REASON` 字面量 +
   `GET /health.orderWarningSource` 字段 + 启动日志的抑制行）全部随本轮删除 ——
   拆除的前提是 `result`（DR-05）**已有写入点**：`server/repo/result.js`（唯一写入口）
   由 `emitWarnings()` 在"1 s 采样落库成功之后"按件 upsert（见下方 6e-3 段）。
   于是 `doneQtyOf()` 读到的件数是**真值**（未跑写入点时它是 0，但那是"真的是 0"，
   不再是 E58 的"拿不到却用 0 代言"）。*/

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
  linkMonitor: null,
  /** DR-05 写入点（E58 ②）的运行计数：`writes` 累计成功、`failures` 累计失败 + 最后一次原因、
   *  `skippedNoUnit` 累计"**帧拿不到件序号 ⇒ 本件不固化**"的次数（E60 裁定①）。
   *  为什么要它：固化失败**不许污染采集链**（故 `persistJudgement()` 只记不抛），
   *  但"悄悄不写"必须看得见 —— 与 `ingest` 计数 `sampledHookFailures` 同一纪律。
   *  ⚠ **三个计数互不代偿**（`T-20261003-02` 补 `/health` 出口时定下的口径）：
   *    `writes`＝真的落了行；`failures`＝想落但落不进去；`skippedNoUnit`＝**根本没打算落**
   *    （件序号拿不到 ⇒ 按"拿不到"处理，见 `unitIndexOf()` 的 docblock）。
   *    把后两者并成一个数，就等于又把"拿不到"与"真是 0"混了一次 —— 那正是 `E60` 的病灶。 */
  resultWrite: { writes: 0, failures: 0, lastError: null, skippedNoUnit: 0 },
  /** DR-06（`shift_stat`，技术债 `E59`）写入点的运行计数 ＋ **跨班检测的进程内状态**：
   *  · `writes` 累计成功固化/补记的班次行数、`backfills` 其中"错过边界后补记"的行数、
   *    `failures` 累计失败 + 最后一次原因（失败**只记不抛**：固化是派生，不许污染采集链）；
   *  · `lastShiftKey` ＝ **上次所见班次**（`<班次日期>|<班次名>`）—— 它是"跨班"判据的被减数；
   *    进程重启后为空，届时由 `previousFrameShiftOf()` 从 `measure_rt` 里**回读**上次采样所属班次
   *    （ADR-0009 C3 被否掉的那个后果：重启错过边界不得永久漏固化）；
   *  · `lastShift` 同上的完整班次对象（枚举补记区间要用它的 `endAt`）；
   *  · `splitDegradedRows`（`E146` 的**更强处置**，2026-10-04）＝本进程内**真的落库**的
   *    **切段降级行**数（判据真源仍是 `services/stats.js` 的 `splitRunSecondsByDay()` 挂在切段结果上的
   *    `degraded`；本键只**数**它，不另判一套）。
   *    ⚠ **它与告警刻意分开、语义不同**（这是本键存在的全部理由）：
   *      · 告警（`warnedSplitDegraded` ＋ `logger.warn`）是**给人看**的 ⇒ **同原因只报一次**（去重，免得刷屏，
   *        一刷屏人就不看了）；
   *      · 本计数是**给门禁/巡检看**的 ⇒ **每次都要算、绝不去重**（一旦去重，降级从 1 行涨到 4 行这种
   *        "错账在变多"的事实就**读不出来了**）。
   *    两者**不许互相替代**：只看告警 ⇒ 一个数字都拿不到（正常形态与"降级 1 行"都是静默或一条）；
   *    只看计数 ⇒ 不知道原因（`degradedReason` 只在告警文案里）。
   *    口径（沿用本仓零值口径，见 `resultWrite`/`retentionWrite` 同款）：**未发生 ⇒ `0`**
   *    （不是 `null` —— 它是个**可累加**的计数器，不是"还没有过"的取值位），随 `start()` 一轮归零。
   *    不变量：`splitDegradedRows ≤ writes`（两者都只数**真的写进库**的行；被 `upsertFrozen()` 的
   *    "信息单调守卫"拦成空操作的行两边都不算）。 */
  shiftStatWrite: {
    writes: 0, backfills: 0, failures: 0, lastError: null,
    lastShiftKey: null, lastShift: null, staleFrames: 0, splitDegradedRows: 0
  },
  /** DR-08（`warning`，技术债 `E62`）写入点的运行计数：
   *  `writes` 累计**新落**的预警条数、`duplicates` 幂等命中（同一归属键已在库中）的次数、
   *  `skippedOk` 被过滤掉的 `ok` 回执条数（`ok` 不是预警，见 `repo/warning.js` 文件头）、
   *  `failures` + `lastError` 同 `resultWrite` 的纪律（只记不抛、不吞）。 */
  warningWrite: {
    writes: 0, duplicates: 0, skippedOk: 0, failures: 0, lastError: null, lastWarnType: null
  },
  /** `DR-14` 保留裁剪（技术债 `E89`）的运行计数 ＋ **跨自然日去重**的进程内记忆：
   *  · `lastRunDay` ＝"本进程已经为**哪个自然日**跑过裁剪"（`yyyy-MM-dd`，取自**注入时钟**）。
   *    它是"同一自然日内只跑一次"的判据（详见 6e-5 段）；
   *  · `lastCutoff` ＝最近一次**成功**算出的保留期截止时刻（`applyRetention()` 的返回值；失败不覆盖 ⇒
   *    可能停留在上一次成功的值，也可能还是 `null`＝"从未成功过"）；
   *  · `lastDeleted` ＝**最近一次尝试**删掉的行数（成功时＝`totalDeleted`；失败时该次无删除 ⇒ 0）；
   *  · `totalDeleted` ＝本进程内**累计**删掉的行数（口径与 `lastDeleted` 并列写明，避免混读）；
   *  · `runs` 累计"真的调了 `applyRetention()` 的次数"（含失败那几次）、`failures` 其中抛错的次数
   *    ＋ `lastError` 最后一次原因。
   *  失败**只记不抛**（与 `shiftStatWrite` / `warningWrite` 同纪律：裁剪是派生，不许污染采集链）。 */
  retentionWrite: {
    runs: 0, failures: 0, lastError: null,
    lastRunDay: null, lastCutoff: null, lastDeleted: 0, totalDeleted: 0
  },
  /** 最近一次**整机快照**（`createStateSnapshot()` 的产物）：`/health` 的 `runAccum` 从它只读引用
   *  （`snapshot.lastRunAccum`）。未生成过 ⇒ null（键恒在，"还没有这个数"与"这个数是 0"分得开）。 */
  snapshot: null,
  /** `E128`（2026-10-04）**跨零点班次配置**的运行期自述（真源＝`services/shift.js` 的
   *  `createShiftRules().crossMidnight()`，`start()` 里落一次；**不在 `/health` 里现算** ——
   *  那会变成第二份判据）。形状 `{allowed, count, keys}`；未启动/未取值 ⇒ `null`
   *  （键恒在：`null` ＝"还没取过"，`count: 0` ＝"取过了，配置里确实没有跨零点班次"）。 */
  crossMidnight: null
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

/** `addRunSec` 上界的**活读数**（ADR-0009 D3，负责人 2026-10-02 授权重设）：
 *  上界＝**当班班次的 `elapsedSec`**（班次已进行时长），依据与可证伪读数写在
 *  `server/services/stats.js` 的「五、累计运行」段。为什么放进 `/health`：这个界刚刚从
 *  `runSec` 换掉，"现场到底按哪个界在拒收增量"必须能被巡检读到（不能只活在注释里）。
 *  值**现算**（注入时钟 ＋ 班次真源 `services/shift.js`，不另造第二套班次口径）；
 *  取不到（配置缺口/时钟异常）⇒ 各数值给 `null` 并把原因写进 `error`（**不编造 0**）。 */
function addRunSecBoundPayload() {
  const rule = '0 ≤ addRunSec ≤ shift.elapsedSec';
  const basis = 'ADR-0009 D3（旧上界 `≤ runSec` 在"无采集串且无「测试中」件"时恒为 0 ⇒ 任何非零增量被拒）';
  try {
    const cfg = require('../src/config/board.config');
    const rules = createShiftRules(((cfg && cfg.shift) || {}).list || []);
    const s = rules.at(currentClock().now());
    return { rule, basis, elapsedSec: s.elapsedSec, totalSec: s.totalSec, shift: { date: s.date, name: s.name } };
  } catch (err) {
    return { rule, basis, elapsedSec: null, totalSec: null, shift: null, error: String((err && err.message) || err) };
  }
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
    /* 帧件序号计数（V1.41 / C-111 ＋ 技术债 `E69`）：`FR-4.2` 的开工数**按件计**
       （判据＝该件在 `measure_rt` 有采样数据、以 `unit_index` 区分），帧**不带件序号**时开工数会算成 0
       ⇒ 现场必须能一眼分清"**真没开工**"与"**帧没带件序号**"（与 `state.resultWrite` 同精神）。
       值**与 `GET /ifd/status` 同源**（都是 `ingest.status()` 的返回值，此处只搬运、不另算）；
       IF-D 未接线时给 `null`（键恒在，"没有这个数"与"这个数是 0"分得开）。
       恒有 `withIndex + withoutIndex === stored`（只数真正落库的帧）。 */
    frameUnitIndex: ifd && ifd.frameUnitIndex ? ifd.frameUnitIndex : null,
    /* 「工单超时预警」（FR-5.11）的取数源：**已完成件数取 `result`（DR-05）真值**。
       E58 的临时闸（`orderDoneSourceReady` / `orderWarningSource` 抑制字段）已随
       `T-20260930-08` 拆除 —— 抑制事实不再需要"可被读到"，因为抑制已不存在：
       件数由写入点（1 s 采样落库之后按件 upsert）驱动，真值是多少就报多少。
       ⚠ `T-20261003-02` 补出口：上一句历史上写的是"运行计数见 `state.resultWrite`"，但那个计数器
       **只在进程内存里、`/health` 一个字都不搬运它**（`shiftStatWrite` / `warningWrite` 都已搬运）
       ⇒ "FR-5.11 的减数到底写没写、写失败没有"在外部**读不到**，与 `persistJudgement()` 自述的
       "悄悄不写必须看得见"相悖。现按**同一风格**搬运（键恒在；`null`＝"还没有过错误"与 `0`
       分得开），三个计数见下方 `resultWrite` 块。 */
    lastError: state.lastError,
    /* ---- 三块写入点的可观测字段（`resultWrite` 由 `T-20261003-02` 补齐；另两块沿 ADR-0009 / T-20261002-05）----
       DR-05／DR-06／DR-08 的写入点都是"失败只记不抛"（不许污染采集链），故**必须**能从这里读到
       "写没写、写失败没有、上次是哪个班次/哪类预警"；`null` 与 `0` 的含义分开（键恒在）。 */
    resultWrite: {
      writes: state.resultWrite.writes,
      failures: state.resultWrite.failures,
      lastError: state.resultWrite.lastError,
      skippedNoUnit: state.resultWrite.skippedNoUnit
    },
    shiftStatWrite: {
      writes: state.shiftStatWrite.writes,
      backfills: state.shiftStatWrite.backfills,
      failures: state.shiftStatWrite.failures,
      lastError: state.shiftStatWrite.lastError,
      lastShiftKey: state.shiftStatWrite.lastShiftKey,
      staleFrames: state.shiftStatWrite.staleFrames,
      /* `E146`（2026-10-04，`T-20261004-19`）：**切段降级行计数**（`E139` 挂在切段结果上的 `degraded`
         标记在**写路径**上被读到的次数）—— 让"降级写库"这件事在 `/health` 上**机器可读**。
         ⚠ 与那条**人读**的告警**刻意分开**：告警同原因**只报一次**（去重，免得刷屏被人无视），
         本计数**每次都要算、不去重**（否则"降级从 1 行涨到 4 行"这种"错账在变多"的事实读不出来）。
         零值语义沿用本仓口径：**未发生 ⇒ `0`**（键恒在；不用 `null`，它是可累加计数器）。 */
      splitDegradedRows: state.shiftStatWrite.splitDegradedRows
    },
    warningWrite: {
      writes: state.warningWrite.writes,
      duplicates: state.warningWrite.duplicates,
      skippedOk: state.warningWrite.skippedOk,
      failures: state.warningWrite.failures,
      lastError: state.warningWrite.lastError,
      lastWarnType: state.warningWrite.lastWarnType
    },
    /* `DR-14` 保留裁剪（技术债 `E89`）的可观测出口 —— 与上面三块**同一风格**（键恒在，
       `null` 与 `0` 分得开："还没跑过"／"上次没删到行"／"删了 0 行"三者可分辨）。
       ⚠ 两个删除计数的**口径不同**，读方不得混用：
         · `deleted` ＝**最近一次尝试**删掉的行数（`applyRetention()` 的 `totalDeleted`；失败时 0）；
         · `totalDeleted` ＝**本进程内累计**删掉的行数（跨自然日累加，随重启归零）。
       `lastRunDay` 是"本进程已为哪个自然日跑过"（去重判据，见 `runDailyRetention()`）；
       `lastCutoff` 是最近一次**成功**算出的保留期截止时刻（失败不覆盖 ⇒ 可能停留在上一次成功的值）。 */
    retentionWrite: {
      runs: state.retentionWrite.runs,
      failures: state.retentionWrite.failures,
      lastError: state.retentionWrite.lastError,
      lastRunDay: state.retentionWrite.lastRunDay,
      lastCutoff: state.retentionWrite.lastCutoff,
      deleted: state.retentionWrite.lastDeleted,
      totalDeleted: state.retentionWrite.totalDeleted
    },
    /* `addRunSec` 的**上界**（ADR-0009 D3 重设）：现算的活读数（规则串 ＋ 当班 elapsedSec/totalSec） */
    addRunSecBound: addRunSecBoundPayload(),
    /* `E128`（2026-10-04）：跨零点班次配置的**显式告警出口**。字段名与取值（真源＝
       `services/shift.js` 的 `crossMidnight()`，在 `start()` 里落进 `state`，此处只搬运）：
         · `allowed`  ＝ 配置里含跨零点班次且已开闸（`shift.allowCrossMidnight: true`）；
         · `count`    ＝ 跨零点班次条数（`0` ＝ 现配置 0-8/8-16/16-24 的情形）；
         · `keys`     ＝ 逐条点名（`'夜班 22-6'` 形态），便于现场一眼认出是哪条规则；
         · `splitReady` ＝ 自然日投影（`E83`）**已实现**（本版本恒 `true` —— 切段落盘在
                          `shift_stat.run_sec_day1/run_sec_day2`，读口见 `repo/shiftStat.js`）。
       为什么要有这个出口：`E128` 的原问题就是"配置含跨零点班次时**没有任何地方报警**" ⇒
       把"有没有跨零点、开没开闸、切段就绪没有"三件事做成**键恒在**的可读字段
       （`null` ＝"还没取过" 与 `count: 0` ＝"取过了，确实没有跨零点"分得开）。 */
    crossMidnight: state.crossMidnight,
    /* DR-17 累计运行的**取数来源**（最近一次整机快照的读数）：日/月/年＝`shift_stat.sumRunSec()` 求和、
       当班增量＝`shift_stat.getShiftRow()` 的"上次累计"之差；`undetermined` ＝该档"无法判定"的班次数
       （状态位，**不是** 0 —— 见 `repo/shiftStat.js` 文件头）。没做过快照 ⇒ null。 */
    runAccum: state.snapshot && state.snapshot.lastRunAccum ? state.snapshot.lastRunAccum : null
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
 *   （`orderDoneSourceReady` 这个 E58 临时闸的注入位已随 `T-20260930-08` **删除**；
 *   传了也无副作用 —— 本函数只读它认识的选项。见 `state.resultWrite` 与 6e-3 段。）
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
  /* DR-05 写入点的运行计数随本轮启动归零（与 lastError 同一处纪律：上一轮的失败不该赖在新一轮头上） */
  state.resultWrite = { writes: 0, failures: 0, lastError: null, skippedNoUnit: 0 };
  /* DR-06／DR-08 写入点的计数与"上次所见班次"同理归零（跨班检测的进程内记忆不得跨启动沿用） */
  state.shiftStatWrite = {
    writes: 0, backfills: 0, failures: 0, lastError: null,
    lastShiftKey: null, lastShift: null, staleFrames: 0, splitDegradedRows: 0
  };
  state.warningWrite = {
    writes: 0, duplicates: 0, skippedOk: 0, failures: 0, lastError: null, lastWarnType: null
  };
  state.snapshot = null;
  /* `DR-14` 裁剪（技术债 `E89`）的计数与"已跑过的自然日"同理归零 —— 进程重启后同日再跑一次是
     **刻意的**（裁剪本身幂等：删除是 `WHERE < cutoff` 的集合差，第二次扫描删 0 行），
     代价＝重启当日多扫一次全表，收益＝"服务每天都会重启的现场"也能真的裁剪到（见 6e-5 段）。 */
  state.retentionWrite = {
    runs: 0, failures: 0, lastError: null,
    lastRunDay: null, lastCutoff: null, lastDeleted: 0, totalDeleted: 0
  };
  /* 时钟注入出口（E42）：从这里起，本进程的"现在几点"只有一个来源 */
  state.clock = resolveClock(options);
  const installSignalHandlers = options.installSignalHandlers !== false;

  /* ---- 1. 配置 ---- */
  const cfg = resolveConfig({ argv: options.argv, env: options.env, boardConfig: options.boardConfig });
  state.config = cfg;
  /* 业务配置真源（`src/config/board.config.js`）—— 判定装配要读**节拍**等业务参数（FR-5.11）。
     `resolveConfig()` 里的同名变量是**它自己的局部变量**，这个作用域取不到；此处显式再取一份
     （与它同一来源：`options.boardConfig` 优先，否则读配置文件）。
     ⚠ 实测踩过：闭包里直接引用那个局部变量 ⇒ 每次判定挂钩都抛 `ReferenceError`、`warning`
     事件永不发布（`harness-check` 段⑦e **7 条断言当场变红**才是发现它的原因）。 */
  const boardCfg = options.boardConfig || require('../src/config/board.config');

  /* 班次真源（DR-06／FR-4.16）：**只建一次**，全进程共用 —— 跨班检测、固化与补记都经它取班次，
     绝不在这里另写一套边界算式（`end=24`／跨零点／归属日回退都只在 `services/shift.js` 里）。
     配置非法（缺口/零长度）时 `createShiftRules()` 会抛错 ⇒ 属启动期致命错误，如实抛出、不兜底。
     `E128`（2026-10-04）：这里传的是**整个 `shift` 段**（不是只传 `list`）—— 跨零点班次的准入开关
     `allowCrossMidnight` 是段上的键，只传数组会把它静默丢掉（＝闸失效）。未开闸而配了跨零点班次时，
     `createShiftRules()` 当场抛错并指名"先做 `E83` 的两个投影"⇒ 启动期拒绝，**不留"能配但算错"的窗口**。 */
  const shiftSeg = (boardCfg && boardCfg.shift) || {};
  const shiftRules = createShiftRules(shiftSeg);
  /* `E128` 的运行期自述：配置里到底有没有跨零点班次、开没开闸、切段就绪没有 ——
     写进模块级 `state`（`/health.crossMidnight` 只读搬运）＋ 下面一条**显式启动日志**。
     "能配但算错"这件事必须**能被巡检看见**，不能只活在注释里。 */
  state.crossMidnight = Object.assign({}, shiftRules.crossMidnight(), { splitReady: true });

  /* ---- 2b.（已删除）E58 临时闸 ----
      T-20260930-05 曾在此处按 E58 的裁定①立一道临时闸（`orderDoneSourceReady`，默认 off ⇒
      `emitWarnings()` 对「工单超时预警」传 `undefined` ⇒ 该类整条不产生，先堵恒定误报）。
      本轮 `T-20260930-08` 做完裁定②（`result` 表写入归口落地，见下方 6e-3 段）后按原注释
      "置 true 并删闸"把闸**整段删除** —— 抑制约定、`/health.orderWarningSource` 字段与启动日志
      的抑制行都不再存在（真源有没有写入方，现在由写入点自身说话）。 */

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
    bus,
    /* W5-②（E45）：判定挂钩 —— 与 `frame` 事件**同一写入点**（1 s 采样落库成功之后），
       实现在下方 6e-2 段（`emitWarnings`），此处只把函数引用交给 ingest。
       `T-20261002-05`（ADR-0009 D1／D3）起，这个 tick 上挂**两件事**（见 `onSampledTick()`）：
       先 DR-06 的跨班固化（`freezeCrossedShifts`），再 DR-05＋DR-08 的判定与预警落库（`emitWarnings`）。 */
    onSampled: frame => onSampledTick(frame)
  });
  /* 把 IF-D 状态快照挂到 router 上（**只挂一个只读函数**，不改 router.js）：
     `healthPayload()` 据此把断连状态一并暴露到 `GET /health`（FR-2.6 的"可被读取"），
     路由清单仍只有一份真源（本处不新增路由、不另起路由表）。 */
  router.ifdStatus = ifd.status;
  logger.info(`[路由] IF-D 采集已接线（${ifd.by}）：${ifd.routes.join(' , ')}；` +
    `去重主口径=equipCode+procOrderNo+collectTime+seq（无 seq 走退路口径）；落库=1 s 采样（ADR-0001 D7）`);
  /* 口径播报（V1.41 / C-111，技术债 E69）：**开工数按件计**，故"帧没带件序号"这件事必须一眼可见 ——
     启动即把口径与可读位置说清楚，避免现场把"帧没带件序号"当成"设备真没开工"。 */
  logger.info('[口径] 帧件序号：`IF-D.4 unitIndex`（落 `measure_rt.unit_index`）；' +
    '**缺件序号的帧 unit_index 写 NULL 且不计入开工件数**（FR-4.2 按件计，判定依据＝该件在 DR-04 有采样数据）；' +
    '计数见 `GET /health` 的 `frameUnitIndex`（=`GET /ifd/status` 同源）—— "真没开工"与"帧没带件序号"是两件事。');

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
    bus,
    /* `E48③`（2026-10-05）：`config` 是**必填**，此处必须传**已解析的业务配置** `boardCfg`
       （`options.boardConfig` 优先、否则读配置文件；见 `:617`）。
       ⚠ 与 `:907` 记录的静默分叉同一机理：上报器同样读
       `mes.{baseUrl,pathTemplate,responseStyle,token,timeoutMs,reportPlaceholder}`，
       若这里不传，它会静默回落到磁盘上那份配置 ⇒ "注入了别的业务配置"的进程里上报打到
       旧地址/旧阈值，且**不报错**（E48 的立案症状）。故本行是**同批传入**，不是兜底。
       ⚠ 刻意写成**最后一项且不带尾逗号**：`harness-check` 第二十一节的 D22 用
       `/^[ \t]*config: boardCfg,\r?\n/m` 替换**第一次**命中来证明"摘掉那一行 ⇒ 判据必红"；
       若本处也带尾逗号，它会更早命中**本行**，那条定点变异就失效了（T-20261005-13 实测踩到）。 */
    config: boardCfg
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

  /* ---- 6d-3（FR-7.12 / P0）. 公告写路由挂载：IF-E（`POST /notice`）＋ `op_log` 同批留痕 ----
     需求原文（`需求文档\…-V1.43.md:547`）：「**仅本机解锁后可新增/编辑/删除公告**」——
     编辑/删除本就在 `FR-7.12`（P0）之内（不是需求缺口），"操作记录保留"的依据＝
     `FR-8.7`／`NFR-15`／`DR-12`；负责人 2026-10-02 已批准开工、**无需需求升版**
     （`FR-7.11` 的有效期/优先级排序属 P1，**滚动/分页轮播仍不做**＝技术债 `E3`）。
     三条接线口径：
       · **鉴权复用既有登录态**（`/auth/*` 的会话令牌，ADR-0007 D3）：未登录 401、
         非本机回环 403、账号锁定态 403 —— 判据全部取 `services/auth.js` 的真源，不在路由里重算；
       · **留痕沿用既有唯一写入口** `server/repo/opLog.js`：三个动作的成功路径与 `notice` 表
         **同一事务**（`repo/notice.js` 里 BEGIN→写表→op_log→COMMIT），过了鉴权闸的被拒也留痕；
       · **落库与读口同一个仓储**：`GET /state` 快照的 `notices` 段与 `POST /notice` 的响应
         都走 `repo/notice.js` 的 `listForBoard()`（前端 `state.notices` 同形，**不写第二份投影**）。
     位置：鉴权挂载之后（本路由要用 `auth.verify()`）、SSE 之前（路由必须在监听前注册完）。 */
  const notice = mountNotice(router, {
    db: state.db,
    logger,
    now: currentClock().source(),
    /* 与 `/auth/*` **同一个** auth 实例（同一份会话表）：不新造第二套令牌，也不另建一份状态 */
    auth,
    /* 留痕身份：`operator` 由会话用户名给出（见 routes/notice.js），`teamCode` 取当前生效班次的班组
       —— 真源＝`board.config.js` 的 `shift.roster.team`（与 FR-1.6 头部"所属班组"同一处；
       取不到就是 null，**不猜**：`repo/opLog.js` 明写"本模块只负责把调用方给的值落库"）。 */
    teamCode: ((boardCfg.shift || {}).roster || {}).team || null
  });
  logger.info(`[路由] 公告写入已接线（${notice.by}）：${notice.routes.join(' , ')}；` +
    `鉴权=复用 /auth/* 会话令牌（未登录 401 / 非本机回环 403 / 账号锁定 403）；` +
    `留痕=notice 表写入与 op_log 同一事务（编辑与删除同样留痕；删除＝硬删＋原文进 op_log）；` +
    `读口=GET /state 的 notices 段与 POST /notice 响应同源（repo/notice.js 的 listForBoard()）`);

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
    /* ⚠ `config` 必须显式传**已解析的业务配置**（`options.boardConfig` 优先，否则配置文件）——
       这一行是 `T-20261004-13` 顺手坐实的一个**静默分叉**：`createStateSnapshot()` 缺省回落到
       `require('../src/config/board.config')`，于是"注入了别的业务配置"的进程里：
       班次真源（`:606` 的 `createShiftRules(boardCfg.shift)`）与 `/health.crossMidnight` 用的是
       **注入的那一份**，而 `GET /state`/`/health.runAccum` 的当班统计用的是**磁盘上的那一份**
       （实测：注入夜班 22-6 ＋ 固定时钟 23:00 ⇒ `/health.crossMidnight.allowed=true` 但
        `/state` 的当班班次是磁盘配置的"中班 16:00-24:00"）。刻意**不**在 `stateSnapshot.js` 里再取一次
       配置（那会变成第二处真源）：真源仍由 `start()` 传入。 */
    config: boardCfg,
    ingest: ifd.instance,
    upload: upload.instance,
    logger
  });
  /* `/health.runAccum` 的取数口：快照函数对象上挂着最近一次 DR-17 读数（`snapshot.lastRunAccum`），
     这里把它登记到进程态，`healthPayload()` 才能只读引用（不做第二份核算）。 */
  state.snapshot = snapshot;
  const sse = router.mountSSE({ bus, snapshot, logger });
  logger.info(`[路由] SSE 业务推送已接线（${sse.by}）：${sse.routes.join(' , ')}；` +
    `事件种类=${require('./services/eventBus').KINDS.join('/')}；` +
    `心跳=${options.heartbeatMs || '默认 15000'} ms；链路监控=${linkMonitor.intervalMs} ms（阈值真源＝upper.staleMs）；` +
    `环形缓冲容量=${bus.capacity}（溢出丢最旧并计 dropped）`);

  /* ---- 6e-2. W5-②（接线技术债 E45）：判定装配 —— `warning` 事件的**唯一生产发布点** ----
     背景（技术债 E45 原文）：六类事件里只有 `warning` 没有真实发布点 —— 挂钩 `judge.evaluate(input,{bus})`
     早就备好，但**全仓没有生产调用方** ⇒ 服务端模式下 `FR-5`（4 类预警，**P0**）在真实源下不可见。
     本波只补"那一次调用"，判定口径一行不改（仍在 `services/judge.js`），接线位置见下三条口径。

     **① 挂在哪**：`services/ingest.js` 的 `options.onSampled` —— 它只在"**1 s 采样落库成功**"
     那条帧上回调（与 `frame` 事件同一写入点、紧随其后）。选它而不是另起定时器/另读一次库：
       · 判定对象＝**落库的那条实测**（`duplicate` 未新增行、`raw-500ms` 不落库、`rejected` 没落库
         ⇒ 三者都不判定，与 `frame` 事件同口径）；
       · "先落库、再通知"与既有 `frame` 事件的顺序理由完全相同（先有事实、再有通知）。

     **② 判定输入从哪来（全部取真源，缺就如实缺 —— 绝不编造）**：
       · `real`      ← 帧里的 `depth` / `speed`（实测值；缺测 ⇒ judge 判 idle，不产生参数类预警）；
       · `standard`  ← `task` 行按帧的 `procOrderNo` 取 `(product_code, process_no)`，
                        再走 `services/standard.js` 的 `getEffectiveStandard(db,{…, at: 帧采集时刻})`
                        （DR-03"指定时刻生效版本"；**库里没有生效版本 ⇒ 显式传 `{depth:null, speed:null}`**，
                        不落进 judge 的配置演示兜底 —— 拿演示值判真任务就是伪造判定，见 FR-3.18/C-93⑤）；
       · `now`       ← 帧的 `collectTime`（**采集时刻**：判据要与这一帧的数据同一时刻；不读系统时间，D17）；
       · `progress`  ← **由帧的 `testStatus` 按 C-98④ 的阶段导出规则算出**（`progressOf()`）：
                        `2`（判定／附录 2 的"测试完成"）⇒ 该件测量已结束、交由本方判定 ⇒ 1；
                        `1`（运行）/ `3`（设备异常＝正交态）：⇒ 0.5；`0`（准备／"完成"过渡回 0）⇒ 0。
                        为什么不采信帧自报的 `progress`：`C-102③` 已定 `IF-D.4` 的进度**仅比对与展示**、
                        不作权威；且实测两处模拟上位机的 `progress` 在整件周期内恒 `< 1` ⇒ 用它会永不判定。
                        ⚠ 本入参是 DR-05 写入点能写出"已完成件数"的前提（T-20260930-08 补）。
       · `shouldDone` / `doneQty` ← FR-5.11（P0）新判据的两个减数：应完成＝节拍 × (采集时刻 − 计划开工)；
                        已完成＝`result`（DR-05）表里该工单「合格＋不合格」的件数（**真值**，无闸）。
                        ⚠ **件序号拿不到时（帧未带/非法 `unitIndex`）两项一律不传** ⇒ 按
                        `judge.buildWarnings()` 的契约**该类整条不产生**（"拿不到"不得用 0 或旧件数代言，
                        E60 裁定①）；发布读的是**固化之后**的件数（裁定②），见 `emitWarnings()` 的顺序注。
       · `consumableHours` ← **当前拿不到**：`server/` 没有累计点亮时长（`production.queueDepth` 是
                        **演示**参数）⇒ 不传，于是"耗材更换"（FR-5.10 P1）**整条不产生**
                        （`judge.buildWarnings()` 的 docblock 写了为什么不给缺省值凑齐 5 条）。
                        ⚠ 这是**已知的能力缺口**（真实源＝上位机/设备台账，属外部依赖 Q-13）。

     **③ 判定失败怎么办**：`judge.evaluate` 抛错（配置缺项等）由 `ingest` 的挂钩 try/catch 收下并
     计数（`ingest.status().counts.sampledHookFailures`），**不影响落库**；启动日志同时给出该计数。

     **④ 判定产出还要固化到 `result`（DR-05）**：见下方 6e-3 段（技术债 E58 ② 的写入点）。 */

  /** 任务行缓存（按 `proc_order_no`）：标准维度＝(产品,工序)，逐帧查库没必要；`task` 行可变 ⇒
   *  只做**按票缓存**（同一票重复帧命中），并把行对象原样留着（不复制、不派生第二份字段口径）。 */
  const taskRowCache = new Map();

  /**
   * 取某工单的 `(产品号, 工序号, 状态)`（判定取标准用；查不到 ⇒ null，**不猜**）。
   * 为什么按帧里的 `procOrderNo` 查：帧本身只带工单号（IF-D.1），产品/工序是 IF-A 派工落库的列
   * —— 与 `services/stateSnapshot.js` 的标准段**同一口径**（那里也是 task 行 → 标准）。
   */
  function taskOf(procOrderNo) {
    const key = String(procOrderNo === undefined || procOrderNo === null ? '' : procOrderNo);
    if (!key) return null;
    if (taskRowCache.has(key)) return taskRowCache.get(key);
    const row = state.db
      ? state.db.prepare('SELECT proc_order_no, product_code, process_no, status, plan_qty, plan_start_time FROM task WHERE proc_order_no = ?').get(key)
      : null;
    taskRowCache.set(key, row || null);
    return row || null;
  }

  /** 已完成件数（FR-5.11 的减数 / FR-4.4 同口径）：`result` 表里该工单「合格 + 不合格」的件数。
   *  为什么用 `result` 而不是 `task.status`：`task.status` 是**单票聚合态**（一票多件时只能给一个状态），
   *  而"已完成多少**件**"必须按件计（DR-19 按件固化）⇒ `result` 是唯一按件的真源。
   *  ⚠ 复检（`待复检`）**不计已完成**（尚未定论），与 `stats.js` 的 `DONE_STATUS` 同一口径 ——
   *  该口径与 SQL 都归口在 `server/repo/result.js` 的 `countDone()`（本函数只做"没库 ⇒ 0"的装配守卫，
   *  不在这里另写一份 SQL：两份 SQL 就是两个口径）。
   *  ⚠ 历史（E58）：本表曾**全仓无写入方** ⇒ 本函数恒 0（而 0 被读成"真的是 0" ⇒ 恒定误报）；
   *  本轮 `T-20260930-08` 补上写入点（见 `persistJudgement()`）后，这里读到的是**真值**。 */
  function doneQtyOf(procOrderNo) {
    if (!state.db || procOrderNo === undefined || procOrderNo === null || procOrderNo === '') return 0;
    return resultRepo.countDone(state.db, procOrderNo);
  }

  /** 按节拍应完成件数（FR-5.11 新判据的减数）：`节拍(件/秒) × 实际经过秒数`，
   *  节拍真源＝`production.cycleSec`（配置单一真源，代码里不写死秒数）。
   *  经过时长的起算点＝该工单的 `plan_start_time`（IF-A.1 `planStartTime`，权威）。
   *  缺计划开工时点 / 不可解析 / 尚未到计划开工 ⇒ **0** —— 新判据下"应完成 0"⇒ 落后率不成立、
   *  **不告警**，这正是它相对旧口径的关键改进（班初不误报）。
   *  ⚠ 不读系统时间：`at` 一律由调用方传采集时刻（ADR-0003 D17）。 */
  function shouldDoneOf(task, at) {
    const cycleSec = Number((boardCfg.production || {}).cycleSec);
    if (!Number.isFinite(cycleSec) || cycleSec <= 0) return 0;
    if (!task || typeof task.plan_start_time !== 'string' || !task.plan_start_time) return 0;
    const t0 = Date.parse(String(task.plan_start_time).replace(' ', 'T'));
    const t1 = Date.parse(String(at).replace(' ', 'T'));
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return 0;
    return Math.floor((t1 - t0) / 1000 / cycleSec);
  }

  /** 判定的标准入参（**显式 null 语义**，见 ② 段）。
   *  库内**无生效版本** ⇒ `{depth:null, speed:null}`（＝未设定）；有版本 ⇒ 传库行本身
   *  （由 `judge.specOf()` 按 DR-03 库行形态归一，缺哪个指标就判哪个 idle）。 */
  const FIELD_PROC_ORDER_NO = 'procOrderNo';
  const FIELD_COLLECT_TIME = 'collectTime';
  /** 件序号字段名（`IF-D.4` / C-103 定义的 `unitIndex`，两种报文形态同名）。
   *  ⚠ Q-21 未答复：真实字段名以上位机方为准，届时只改这一处（与本文件其它字段名的处理同款）。 */
  const FIELD_UNIT_INDEX = 'unitIndex';
  /** 设备运行状态码字段名（`IF-D.1` / 附录 2：`0=待机` `1=测试中` `2=测试完成` `3=设备异常`）。 */
  const FIELD_TEST_STATUS = 'testStatus';

  /** 取"该帧对应工单在**采集时刻**的生效标准"（DR-03 指定时刻生效版本）。
   *  未建立/无生效版本 ⇒ 返回**净化形态** `{depth:null, speed:null}`（由 `judge.specOf()` 判 idle）。
   *  ⚠ 保留净化形态是**有意**的：它同时充当"库里没有生效标准"的显式表达。 */
  function standardOf(frame) {
    const task = taskOf(frame && frame[FIELD_PROC_ORDER_NO]);
    if (!task || !task.product_code) return { depth: null, speed: null };
    const productCode = String(task.product_code);
    const processCode = task.process_no === undefined || task.process_no === null ? '' : String(task.process_no);
    const at = collectTimeTextOf(frame);
    const row = standardSvc.getEffectiveStandard(state.db, { productCode, processCode, at });
    return row || { depth: null, speed: null };
  }

  /** 帧的采集时刻（判定取值时刻 / `now`）：`yyyy-MM-dd HH:mm:ss`；帧缺采集时刻 ⇒ 退注入时钟
   *  （`ingestFrame` 已强制该字段合法，这里是**防御性**兜底，不构成第二条时间真源）。 */
  function collectTimeTextOf(frame) {
    const ct = frame ? frame[FIELD_COLLECT_TIME] : undefined;
    return typeof ct === 'string' && ct ? ct.slice(0, 19) : platformClock.fmt(currentClock().now());
  }

  /* ---- 6e-3. DR-05（`result` 表）的写入点 —— 技术债 E58 ② 的落地（T-20260930-08） ----
     背景（E58）：`result`（DR-05，P0 表）此前**全仓无写入方**，唯一命中是 `doneQtyOf()` 那条 `SELECT`
     ⇒「已完成件数」恒 0 ⇒ 只要派工带 `planStartTime`（IF-A.1），FR-5.11「工单超时预警」恒定误报 err。
     裁定②要求补"写入归口"，并按负责人 2026-09-30 的五项口径实现（同 E58 行）：
       (a) **谁写**＝本看板服务端（FR-3.13 判定权在我方；C-102 已定 IF-D 的**结果**仅比对、不作权威）
           ⇒ 写的是 `judge.evaluate()` 的产出，**不采信**帧里的 `result`；
       (b) **何时**＝每次 1 s 采样落库成功之后、对该件判一次并 upsert（与 `measure_rt` 同拍，
           复用 `onSampled` 这一个挂钩 ⇒ **不新增接口、不新增第二条时间真源、不起第二个定时器**）；
       (c) **粒度**＝按件一行（`(proc_order_no, unit_index)` 唯一索引 upsert）；`待复检` 不计"已完成"；
       (d) `judged_at`＝**判定时刻**（注入时钟；与采集时刻分开存）；`duration_sec`＝该件首末**有效**帧差；
       (e) 不实现 DR-06（`shift_stat`，属 E59）—— 本段一行都不碰班次统计。
     "只有真的发生了判定才写"：本段只在 `emitWarnings()` 越过"无生效标准 ⇒ 不判定/不发布"的早退之后
     被调用 ⇒ 无生效标准**不写**；而 `duplicate` / `raw-500ms` / `rejected` 帧根本不会走到 `onSampled`
     ⇒ 也不写（与 `frame`/`warning` 事件同一写入点口径）。
     ⚠ **E60 裁定①（2026-09-30）补的一支**：帧**拿不到件序号**（未带／非法 `unitIndex`）⇒ **本写入点
     整条不跑**（不写 `result` 行、不动 `state.resultWrite.writes`）—— 缺省 1 会把一票多件归并成一行、
     使「已完成」饱和于 1（审查 P1-1 实测：10 帧 ⇒ 1 行、落后率恒 90.9%）。"拿不到"就是拿不到。
     ⚠ **顺序**：本段的调用点从"发布之后"移到"**发布之前**"（先固化、后发布，E60 裁定②）——
     否则判出某件的那一帧仍按旧件数发布，前 9 件各闪 1 帧假 `err`（审查 P2-1）；详见 `emitWarnings()`。 */

  /** 件号（DR-19 按件固化；字段名见 `FIELD_UNIT_INDEX`）：**正整数，拿不到 ⇒ `null`**。
   *  · 帧没带 ⇒ **null ＝"拿不到"**（**不再缺省 1**）：`judge.js` 的纪律是"'拿不到'与'真的是 0'
   *    是两件事，不得互相代言"，件号同理 —— 用缺省 1 冒充件序号会把一票的 N 件全部归并到第 1 件，
   *    后果是 `countDone()` **饱和于 1**：同一票连推 10 帧 `testStatus=2`（判 10 件）实测 `result`
   *    恰 1 行、落后率恒 ≈90.9% ⇒「工单超时预警」**仍恒定误报**（技术债 `E60`／审查 P1-1 实测）。
   *    负责人 2026-09-30 裁定①：帧缺 `unitIndex` ⇒ **不固化**（不写 `result` 行）＋ 该类**不产生**。
   *    ⚠ 为什么**不写**比"缺省 1"诚实：`unit_index` 是 `ux_result_unit` 唯一键的一半成分，
   *      编一个键值就等于把"这一件"与"另一件"混成一行，而 `result` 表没有第二列能承载真相。
   *  · 带了但非法（0/负数/小数/非数值）⇒ 同样 **null**（不归一、不冒充），并**记一条 warn**
   *    （不静默：脏件号会被看见；`repo/result.js` 的入库口本来就拒收非法值）；
   *  · 只借件序号当**行键**：判定仍由本看板给出（C-102：IF-D 的结果/进度仅比对与展示）。
   *  @returns {number|null} 合法件号（≥1 的整数）；帧未带／非法 ⇒ `null`（＝"拿不到"） */
  function unitIndexOf(frame) {
    const raw = frame ? frame[FIELD_UNIT_INDEX] : undefined;
    if (raw === undefined || raw === null || raw === '') {
      if (logger) {
        logger.warn('[DR-05] 帧未带 unitIndex ⇒ 按"拿不到"处理：本件**不固化**（不写 result 行）、' +
          '本次判定**不产生**「工单超时预警」（不再缺省 1 冒充件序号，E60；IF-D.4 的真实字段名' +
          '与取值域待 Q-21 答复）');
      }
      return null;
    }
    const n = (typeof raw === 'string' && /^\d+$/.test(raw.trim())) ? Number(raw.trim()) : raw;
    if (Number.isInteger(n) && n >= 1) return n;
    if (logger) {
      logger.warn(`[DR-05] 帧里的 unitIndex 非法（${JSON.stringify(raw)}）⇒ 按"拿不到"处理：本件不固化、` +
        `本次判定不产生「工单超时预警」（不归一为 1，E60；IF-D.4 的真实字段名与取值域待 Q-21 答复）`);
    }
    return null;
  }

  /** 本帧对应的**单件测试进度**（FR-3.12 / C-103 的 0～1 口径）—— 由 `testStatus` **导出**：
   *  附录 2 的码语义与 C-98④ / FR-2.5 的阶段导出规则：`0=待机/准备`、`1=测试中/运行`、
   *  `2=测试完成/判定`、`3=设备异常`（正交态、出现时**阶段冻结**）。
   *  · `2`（判定）⇒ **1**：该件测量已结束、**交由本方判定**（C-98④ 明写"「判定」的结束由本方判定"）
   *    ⇒ 只有此时 `judge.taskResult()` 才可能给出 合格/不合格/待复检；
   *  · `1`（运行）/ `3`（异常）⇒ **0.5** ⇒ 判「测试中」（测量未结束，不得据此判合格/不合格）；
   *  · 其余（含 `0`：准备，或"完成"过渡回 0）⇒ **0** ⇒ 判「待测试」。
   *  ⚠ 该件已判出的**终态不会被这些中间态回退**（单调性在 `repo/result.js` 的 upsert 里保证），
   *  故"完成"过渡帧（码回到 0）不会把刚判出的 合格/不合格 抹成「待测试」。
   *  为什么不直接用帧自报的 `progress`：C-102③ 已定 `IF-D.4` 的进度仅比对与展示、不作权威；
   *  且两处模拟上位机的 `progress` 恒 `< 1`（判定阶段 0.85～0.97）⇒ 用它会**永不判定**。 */
  function progressOf(frame) {
    const st = frame ? frame[FIELD_TEST_STATUS] : undefined;
    if (st === 2) return 1;
    if (st === 1 || st === 3) return 0.5;
    return 0;
  }

  /** 该件"首末有效帧差"的进程内记账（有效＝**已落库的 1 s 采样帧**）。
   *  **为什么不引入第二时间源**：记的是帧自带的 `collectTime`（DR-16 文本）—— 它就是同一帧落进
   *  `measure_rt.collect_time` 的那一个字符串；首/末两个值都取自**同一条已落库事实**，
   *  本缓存不读系统时间、不另起定时器、不新增列（ADR-0003 D17）。
   *  **为什么不用 `measure_rt` 的 `MIN(collect_time)`**：该表**曾经**没有 `unit_index` 列
   *  （C-101④ 当时的口径），按工单取 MIN 会把同工单的多件混成一件 ⇒ 按件首帧只能在进程内按
   *  `(工单, 件号)` 记账。**V1.41 / C-111 起 `measure_rt.unit_index` 已落库**（DR-04 增列），
   *  库层现在**可以**按件取首末帧 —— 但本缓存**本轮不动**（改它等于换 `duration_sec` 的取数口径，
   *  超出本包裁定范围；且历史行的 `unit_index` 为 NULL，按件聚合对老数据仍不成立）。
   *  库层对 `duration_sec` 取 `MAX(旧值, 新值)`（单调不减），故进程重启后从 0 重算**也不会**让已落库的时长倒退。
   *  容量上限：只保留最近 `PIECE_SPAN_CACHE_MAX` 件（按插入序淘汰最旧），防长时间运行下无界增长；
   *  被淘汰的件若再来帧，就按"新首帧"重算（同样受上面的 `MAX()` 保护）。 */
  const PIECE_SPAN_CACHE_MAX = 512;
  const pieceSpanCache = new Map();

  /** 取/更新该件的首末帧时刻，并算出整数秒差（同一秒 ⇒ 0，符合 schema 的 `INTEGER`） */
  function pieceSpanOf(procOrderNo, unitIndex, collectTime) {
    const key = procOrderNo + '|' + unitIndex;
    let entry = pieceSpanCache.get(key);
    if (!entry) {
      entry = { first: collectTime, last: collectTime };
      pieceSpanCache.set(key, entry);
      if (pieceSpanCache.size > PIECE_SPAN_CACHE_MAX) {
        const oldest = pieceSpanCache.keys().next();
        if (!oldest.done) pieceSpanCache.delete(oldest.value);
      }
    } else {
      /* 文本比较＝时间序（DR-16 定长秒级）；乱序帧只扩不外缩，保证"首末"是区间端点 */
      if (collectTime > entry.last) entry.last = collectTime;
      if (collectTime < entry.first) entry.first = collectTime;
    }
    const t0 = Date.parse(entry.first.replace(' ', 'T'));
    const t1 = Date.parse(entry.last.replace(' ', 'T'));
    const sec = (Number.isFinite(t0) && Number.isFinite(t1)) ? Math.round((t1 - t0) / 1000) : 0;
    return { first: entry.first, last: entry.last, durationSec: Math.max(0, sec) };
  }

  /**
   * DR-05 写入点：把"本看板刚判出的这一件"upsert 进 `result` 表（与判定**同一拍**）。
   * @param {object} frame 已落库的 1 s 采样帧（`procOrderNo` / `collectTime` / `testStatus` / `unitIndex`）
   * @param {{result:string}} verdict `judge.evaluate()` 的产出（FR-3.13 五态之一）
   * @param {number} unitIndex **合法件号**（≥1 的整数）；由调用方用 `unitIndexOf()` 取到 ——
   *   "拿不到"（`null`）时**调用方不得调本函数**（不固化），本函数不为它兜底（不冒充件序号）。
   * @returns {{written:boolean, procOrderNo:string, unitIndex:number, durationSec:number}|null}
   *   写失败 ⇒ **只记不抛**（落库是事实、判定与固化是派生）：采集链的 HTTP 面拿到的仍是"收下"，
   *   与 `ingest` 对 `onSampled` 失败的既有纪律一致（`services/ingest.js` 的 try/catch 与
   *   `counts.sampledHookFailures`）；失败次数另计在 `state.resultWrite.failures` 并写日志，
   *   保证"悄悄不写"看得见。
   */
  function persistJudgement(frame, verdict, unitIndex) {
    const procOrderNo = frame && frame[FIELD_PROC_ORDER_NO] !== undefined && frame[FIELD_PROC_ORDER_NO] !== null
      ? String(frame[FIELD_PROC_ORDER_NO]) : '';
    const collectTime = collectTimeTextOf(frame);
    const span = pieceSpanOf(procOrderNo, unitIndex, collectTime);
    /* 判定时刻＝**注入时钟的当前时刻**（ADR-0003 D17；与帧的采集时刻分开存） */
    const judgedAt = platformClock.fmt(currentClock().now());
    try {
      const written = resultRepo.upsertJudgement(state.db, {
        procOrderNo,
        unitIndex,
        result: verdict && verdict.result,
        judgedAt,
        now: judgedAt,
        durationSec: span.durationSec
      });
      state.resultWrite.writes++;
      return { written: written.written, procOrderNo, unitIndex, durationSec: span.durationSec };
    } catch (err) {
      state.resultWrite.failures++;
      state.resultWrite.lastError = String((err && err.message) || err);
      if (logger) {
        logger.warn(`[DR-05] result 表写入失败（帧已落库、判定已发布；本条只影响按件固化）：` +
          `${state.resultWrite.lastError}（工单 ${JSON.stringify(procOrderNo)}、第 ${unitIndex} 件）`);
      }
      return null;
    }
  }

  /**
   * **1 s 采样 tick 的挂钩体**（交给 `ingest` 的 `onSampled`；与 `frame` 事件同一写入点）。
   *
   * 顺序固定（两条互不依赖，但先固化事实、再做判定装配更符合"先有事实再有通知"）：
   *   ① `freezeCrossedShifts(frame)` —— DR-06：检测**跨班** ⇒ 固化上一班（含错过补记），
   *      自带 try/catch（失败只记不抛：不许污染采集链，计数见 `/health.shiftStatWrite`）；
   *   ② `emitWarnings(frame)` —— DR-05 按件固化 ＋ 判定发布（`warning` 事件）＋ DR-08 预警落库。
   *   ③ `runDailyRetention()` —— DR-14：**跨自然日**时裁剪超期历史（技术债 `E89`），
   *      自带 try/catch（失败只记不抛，计数见 `/health.retentionWrite`）。
   *  ⚠ ①**不能**放进 `emitWarnings()` 内部："库内没有生效标准 ⇒ 本次不判定"那条早退会把跨班检测
   *    一并跳掉（没有工单/标准时 DR-06 的固化恰恰**更**需要发生 —— 那些班次的运行时长是真实事实）。
   *  ⚠ ③ 排在**最后**且**不受** `emitWarnings()` 早退影响（形状同①）：没有标准时也要能裁剪，
   *    "判定不出来"与"历史该不该清"是两件事。
   *  ⚠ 本 tick 内**不新增任何定时器**（ADR-0009 D3①：沿用"节流而不新起定时器"的工程约定）。
   */
  function onSampledTick(frame) {
    freezeCrossedShifts(frame);
    const published = emitWarnings(frame);
    runDailyRetention();
    return published;
  }

  /** 判定挂钩（交给 `ingest` 的 `onSampled`）：算一次判定 → **固化到 result** → 按（固化后的）
   *  **真实件数**发布 `warning` 事件。抛出的异常由 ingest 的 try/catch 收下（见 ③ 段），此处不吞不掩
   *  （固化那一段自带 try/catch —— 见 `persistJudgement()` 的失败口径）。
   *
   *  **顺序（负责人 2026-09-30 裁定②，技术债 `E60` 同族 P2）**：**先固化、后发布**。
   *  为什么必须是这样：`FR-5.11` 的减数「已完成」＝`result` 表的真实件数（`doneQtyOf()`），
   *  若"先发布、后固化"，则**判出某件的那一帧**仍按**旧件数**发布 ⇒ 按计划推进时第 k 件完成帧的
   *  落后率恰 `1/k`，**前 9 件各闪 1 帧（1 s）假 `err`**（审查 P2-1 实测：帧 2 判合格却发布
   *  "实际已完成 0 件 / 落后 100%"，帧 3 才转 ok）。⇒ 发布必须读**固化之后**的件数。
   *  两次 `evaluate()` 的取舍：`judge.evaluate()` 的 `result`（合格/不合格/待复检）**只由参数判定
   *  与标准决定、不依赖 `doneQty`**（`taskResult()` 不读该入参）⇒ 第一次只为**取 `result` 去固化**
   *  （`publish:false`，不发布：发布权只留一处），第二次才**按固化后的件数**组织并发布。
   *  两次调用同一帧、同一 `now`、同一标准、同一注入时钟 ⇒ **不引入第二条时间源、不新增业务分支**。
   *  固化失败（`persistJudgement()` 返回 `null`）⇒ 件数没变 ⇒ 沿用第一次判定的产出发布（“真的是 0”），
   *  不编造件数、也不吞掉本帧的预警（失败口径见 `persistJudgement()`：只记不抛）。 */
  function emitWarnings(frame) {
    const standard = standardOf(frame);
    /* ⚠ "有没有生效标准"必须用**判定引擎自己的取数口** `judge.specOf()` 判，不得自行读 `standard.depth`：
       DR-03 的库行是**扁平形态**（`depthTypical` / `speedTypical` / …），`standard.depth` 恒为
       undefined —— 按字段名直接判会把"有标准"误判成"没标准"，从而**永不判定**（本波实测踩过：
       探针显示 standard 已取到行、却被早退挡掉）。`specOf()` 同时认三种形态（运行期 / 库行 / 配置段），
       是"该参数是否已设定"的**唯一**口径。 */
    const hasAny = judge.PARAMS.some(kind => judge.specOf(standard, kind) !== null);
    /* 库里没有生效标准 ⇒ **本次不判定、也不发布、更不写 `result`**：没有标准就没有参数类预警
       （FR-5.8 / C-93⑤），而"什么都没判"也不是状态变化；发布一条空预警只会让界面把上一条真预警擦掉
       （假信息）。下一次"1 s 采样落库"会重新看标准是否已到位 —— 标准录入后最迟这一帧起就有预警。 */
    if (!hasAny) return null;
    const task = taskOf(frame && frame[FIELD_PROC_ORDER_NO]);
    const at = collectTimeTextOf(frame);
    const procOrderNo = frame && frame[FIELD_PROC_ORDER_NO];
    /* 件序号：**拿不到 ⇒ null**（帧未带／非法）。它决定两件事（E60 裁定①的"两个后果"）：
       ① **不固化**该件 —— 本帧不写 `result` 行（写入点见 `persistJudgement()`）；
       ② 本次判定**不产生**「工单超时预警」—— 应完成/已完成两项一律传 `undefined`，
          按 `judge.buildWarnings()` 的既有契约"缺一即该类整条不产生"（**不是**传 0：
          "拿不到"与"真的是 0"不得互相代言）。⇒ 若"没有件序号"与"发布顺序"叠加，
          最终行为是**该类不产生**，而不是发一条按旧件数算出来的预警。 */
    const unitIndex = unitIndexOf(frame);
    const hasUnit = unitIndex !== null;
    /* E60 裁定①：件序号拿不到 ⇒ 本件**不固化**。"没写"与"写失败"是两件事（故不并进 `failures`），
       但也不能是个黑洞 ⇒ 单记一个 `skippedNoUnit`（读口＝`GET /health` 的 `resultWrite.skippedNoUnit`）。
       ⚠ 与 `ingest.status().frameUnitIndex.withoutIndex`（`/health.frameUnitIndex`）**不是同一个数**：
       那个数的是**落库的帧**、这个数的是**判定点被跳过的件**，分母不同、不互相代偿（两处都要能读）。 */
    if (!hasUnit) state.resultWrite.skippedNoUnit++;
    const shouldDone = hasUnit ? shouldDoneOf(task, at) : undefined;
    const doneQty = hasUnit ? doneQtyOf(procOrderNo) : undefined;
    /* ---- 第一拍：取 `result` 去固化（**不发布**：发布权只留下面那一处） ----
       单件进度 `progress` 由 `testStatus` 按 C-98④ 导出（见 `progressOf()`）—— 它决定本次判定是
       待测试/测试中，还是可判定的 合格/不合格/待复检。此前不传该入参 ⇒ `taskResult()` 恒判
       「待测试」（进度缺失）⇒ DR-05 永远写不出"已完成"件 ⇒ FR-5.11 的减数只剩"应完成"一侧。 */
    const draft = judge.evaluate({
      now: at,
      real: { depth: frame.depth, speed: frame.speed },
      standard,
      progress: progressOf(frame),
      shouldDone,
      doneQty
    }, { bus, publish: false });
    /* DR-05（E58 ②）：与本帧判定**同一拍**按件 upsert 一次（`judgedAt` 仍取注入时钟，见其内注释）。
       拿不到件号 ⇒ **不固化**（不写行，也不动写入点计数 —— "没写"与"写失败"是两件事）。 */
    const persisted = hasUnit ? persistJudgement(frame, draft, unitIndex) : null;
    /* ---- 第二拍：按**固化之后**的真实件数组织发布 ----
       固化成功 ⇒ 用刚写进去的件数**重算**一次（`result` 不依赖它 ⇒ 第二次的 `result` 与第一次相同）；
       固化失败/未固化 ⇒ 件数没变，沿用第一拍那一次算出的件数（该帧的预警事件照发，见真计数④）。 */
    const published = judge.evaluate({
      now: at,
      real: { depth: frame.depth, speed: frame.speed },
      standard,
      progress: progressOf(frame),
      shouldDone,
      doneQty: persisted ? doneQtyOf(procOrderNo) : doneQty
    }, { bus });
    /* ---- DR-08（`warning` 表，技术债 `E62`）：**判定发布点同批落库**（ADR-0009 D1）----
       与上面那次发布**同一个 tick、同一帧**，紧随其后（顺序理由见 `persistWarnings()` 的 docblock：
       预警落库不反哺判定，故不需要 `result` 那种"先固化后发布"；发布失败/落库失败互不牵连）。 */
    persistWarnings(frame, published, at, unitIndex);
    return published;
  }

  /* ---- 6e-4. DR-06（`shift_stat`）的写入点 —— 技术债 `E59` 的落地（ADR-0009 D1／D3，T-20261002-05）----
     背景（E59）：`shift_stat`（DR-06，14 列早已在 `schema.sql` 就绪、**不改表**）此前**零写入点** ⇒
     `DR-17`「累计运行」名不副实（跨班不清零、跨零点归属失效；`stateSnapshot` 只能写 `addRunSec: 0`）。
     本段按 ADR-0009 D3① 的触发点落地：**在既有的 1 s 采样 tick 内检测"跨班"后固化上一班**，
     **不新增定时器**；跨班时刻被跳过的，**下次采样按序补记**（"补记口径须可测"）。
     固化口径（四条；"正常固化"与"补记"走**同一条**路径，区别只在"这一班我们看没看见过"）：
       · **窗口**＝该班次的 `[startAt, endAt)`（半开区间；班次真源＝`services/shift.js`，不重算边界）；
       · **取数**＝`stateSnapshot.statsForShift()`（**唯一取数口**，与 `GET /state` 同一份 SQL）；
       · **过去的班次** ⇒ `elapsedSec` 取 `totalSec`（整班已过完，不再是"活班次"）；
       · **不得伪造数据**（技术债 `E38` 的既有口径）：该窗口内**一条采集帧都没有** ⇒ 运行时长
         **无法判定** ⇒ `oee`/`pass_rate` 落 **NULL**（列约束下 `run_sec`/`idle_sec` 只能是 0，
         但读方以那两列 NULL 为准，**不得**把 0 读成"零运行"）—— 逐条写在 `repo/shiftStat.js` 的
         文件头与 `shiftStatRowOf()`。 */

  /** 班次归属键（＝`shift_stat` 唯一索引 `ux_shift_stat(shift_date, shift_name)` 的两列） */
  function shiftKeyOf(s) { return `${s.date}|${s.name}`; }

  /** 某班次的**完整**班次对象（供固化用）：`elapsedSec` 一律取 `totalSec` ——
   *  只有"已经跑完的班次"才会被固化/补记（正在跑的那一班不固化，它的读数由 `GET /state` 现算）。 */
  function completedShiftOf(startAtText) {
    const s = shiftRules.at(startAtText);
    return Object.assign({}, s, { elapsedSec: s.totalSec, remainingSec: 0 });
  }

  /** 上次采样帧所属的班次（**进程重启后的"记忆回读口"**）：取 `measure_rt` 里**早于本帧采集时刻**的
   *  最近一条 `collect_time`，算出它属于哪个班次。
   *  为什么需要它：跨班检测的被减数（"上次所见班次"）是**进程内状态**，服务端重启就没了；而
   *  ADR-0009 否掉 C3 方案的理由正是"服务端重启/卡顿错过边界即永久漏固化"——库里的采样帧还在，
   *  故从库里回读上次所见班次，重启后照样能按序补记（库是唯一真源，进程内记忆只是缓存）。
   *  没有更早的帧（新库/首次启动）⇒ `null`：首次 tick 只记当前班次，**不编造上一班**。 */
  function previousFrameShiftOf(frame) {
    if (!state.db) return null;
    const at = collectTimeTextOf(frame);
    const row = state.db.prepare(
      `SELECT collect_time AS collectTime FROM measure_rt
        WHERE collect_time < ? ORDER BY collect_time DESC LIMIT 1`).get(at);
    if (!row || !row.collectTime) return null;
    let s = null;
    try { s = completedShiftOf(row.collectTime); } catch { return null; }   // 该时刻不属任何班次（配置缺口）
    return { key: shiftKeyOf(s), date: s.date, name: s.name, startAt: s.startAt, endAt: s.endAt };
  }

  /** `E146`（2026-10-04）**写路径**的降级告警闸：同一原因（同一 `degradedReason` 串）只告警一次。
   *  本 `Set` 随 `start()` 一轮归零（与 `state.shiftStatWrite` 的计数同一处纪律：上一轮的告警不该
   *  让新一轮静默）。判据真源只有一处 —— `services/stats.js` 的 `splitRunSecondsByDay()` 挂在切段
   *  结果上的 `degraded` 标记（本文件与 `stateSnapshot.js` 都只**读**它，不另判一套）。
   *  ⚠ 本闸**只管告警**（人读 ⇒ 去重）。同一件事的**机器可读**出口是 `state.shiftStatWrite.splitDegradedRows`
   *  （`T-20261004-19` 的更强处置，2026-10-04）—— 那个计数**永不去重**、每次降级都要算。
   *  **为什么两者必须分开、且不许互相替代**：告警一刷屏就没人看（这是 `warnedSplitDegraded` 存在的理由），
   *  而"这一轮到底写了几行错账"是**门禁/巡检**要判的量（去重的计数器只能给出"发生过"这一个 bit，
   *  1 行涨到 4 行这件事就永远读不出来）。两者**语义不同 ⇒ 纪律不同**：一个去重、一个不去重。 */
  const warnedSplitDegraded = new Set();

  /** 把一个班次的**库内真源读数**装成 `shift_stat` 的一行（固化与补记共用；口径见 6e-4 段头）。
   *  ⚠ "无法判定"的两个**状态位**（`oee`/`pass_rate` 为 `null`）是本函数**刻意**给出的，别改成 0：
   *    · `frameCount === 0` ⇒ 该窗口没有采集数据 ⇒ **运行时长无法判定**（设备没跑 / 链路断了 /
   *      服务没运行，三者**不可区分**）⇒ `oee: null`（`runSec`/`idleSec` 受列约束只能 0，占位而已）；
   *    · `pieceCount === 0` ⇒ 没有判定件 ⇒ 合格率**无法计算**（分母为 0，不是 0%）⇒ `passRate: null`。
   *  `T-20261004-19`（本函数的**返回形态**）：为了把"这一行的切段是降级兜底形态"这件事交到
   *  **真的落库**那一步去计数，本函数改为返回 `{row, splitDegraded}`（而不是光返回 `row`）——
   *  `row` 的**内容与键一字未动**（"方案 A／行留痕"已按负责人裁定**不采纳**：那要依赖
   *  `upsertFrozen()` 容忍未知键这条**今天无断言守护**的契约）；多出来的 `splitDegraded` 只是
   *  把上面已经读到的那个判据**交出去**，**不是**另判一套、更**不是**从行值反推（比如拿
   *  "`runSecDay2 === 0`"当降级证据 —— 那是第二份判据，会与真源漂移）。 */
  function shiftStatRowOf(shift) {
    const taken = statsForShift(state.db, shift, { config: boardCfg, now: shift.endAt, addRunSec: 0 });
    const s = taken.stats;
    const f = taken.fact;
    /* `E146`（2026-10-04）：**写路径也要读出降级** —— 读的是与 `stateSnapshot.statsOf()` 同一个标记
       （判据真源只有一处：`services/stats.js` 的 `splitRunSecondsByDay()`；语义＝"**这次没能判跨零点**"，
       `crossing:false` 只是"整段归班次开始日"的兜底形态）。
       为什么**写路径更要管**：读错看得见（下一次读还是错的、能被对账发现），而**写进库的错账**会被
       `repo/shiftStat.js` 的 `segmentsOf()`/`sumRunSec()` 当成"已固化的真源"永久参与日/月/年档求和 ——
       错一次、之后每次读都错，且库里没有任何一列再提示"这一行的切段其实是兜底形态"。
       ⇒ 若降级真的发生在这一支，绝不能**静默**落一行"整段归 day1"的错账。
       处置＝**标注 ＋ 告警 ＋ 计数**（`T-20261004-19` 的更强处置：让"降级写库"在 `/health` 上**机器可读**），
       一个数都不改（与 `stateSnapshot.statsOf()` 同一口径、同一先例；
       出口沿用 `server/db/index.js` 的 F17-3：有 `logger` 走 `logger.warn`，否则 `console.warn`）：
         · **不抛错** —— `stats.js` 的既有取舍是"切段是派生的增强、不该让旧调用方爆掉"（`E139` docblock），
           写路径抛错会把整条固化链（乃至那一拍的判定链）带下来；
         · **同一原因只告警一次**（`warnedSplitDegraded`）：本函数按班次被反复调用，不设闸会刷屏；
          · **计数不去重**（`state.shiftStatWrite.splitDegradedRows`，在 `freezeShift()` 里**落库成功之后**
            加）：告警与计数**语义不同 ⇒ 纪律不同** —— 告警是**给人看**的（去重，不然刷屏就没人看），
            计数是**给门禁/巡检看**的（**每次都要算**；一旦去重，"这一轮写了 4 行错账"与"1 行"就分不出来，
            而"错账在变多"正是最该被机器抓到的信号）。二者不许互相替代：只看告警拿不到数字，
            只看计数不知道原因（`degradedReason` 只在告警文案里）。
       现况（真源可核）：本函数的 `shift` 来自 `completedShiftOf()` → `shiftRules.at()`，而 `at()`
       （`services/shift.js:237-282`）必给 `start`/`end`/`startAt`/`endAt`/`date` —— 正是 `E139` 收窄后的
       **全部** fault 判据（`totalSec` 不在其中）⇒ **生产路径上 `degraded` 不可达**（本条是"下一根探针/
       下一个调用方"的防线，不是当下在冒烟）。 */
    const split = s.runSecSplit;
    /* 本行的切段是不是**降级兜底形态**：判据全函数只在这里读一次（真源＝`services/stats.js` 的 `degraded`
       标记），读出来的**同一个事实**喂两个出口 —— ①上面那条**去重**的告警（人读）；②`freezeShift()` 里
       **不去重**的落库计数（`state.shiftStatWrite.splitDegradedRows`，门禁/巡检读）。
       ⚠ 下面的 `if` 判据**一个字都没改**（旧探针 `tests\._verify\e146-probe.js` 的 D22 锚点正是这一行，
       改它会让那份已验收的取证假红）；标志位在分支体内置位 ⇒ 判据只求值一次、不存在第二份判据。 */
    let splitDegraded = false;
    if (split && split.degraded === true) {
      splitDegraded = true;
      const why = String(split.degradedReason || '（未给 degradedReason）');
      if (!warnedSplitDegraded.has(why)) {
        warnedSplitDegraded.add(why);
        const line = '[DR-06] ⚠ 固化班次的**切段降级**（`E146`）—— ' +
          `班次 ${shift.date} ${shift.name}：本次落库的 run_sec_day1/run_sec_day2 ＝ ` +
          `${s.runSecDay1}/${s.runSecDay2}，是"整段归班次开始日"的**兜底形态**` +
          '（跨零点班次会把次日那一段并进开始日的日档 —— **写进库的错账比读数错更难发现**，' +
          `因为此后每次日/月/年档求和都把它当"已固化的真源"）；原因：${why}`;
        if (logger && typeof logger.warn === 'function') logger.warn(line);
        else console.warn(line);
      }
    }
    const runDeterminable = f.frameCount > 0;
    const rateDeterminable = f.pieceCount > 0;
    const nowText = platformClock.fmt(currentClock().now());
    const row = {
      shiftDate: shift.date,
      shiftName: shift.name,
      planQty: s.planQty,
      startedQty: s.startedQty,
      finishedQty: s.doneQty,
      qualifiedQty: s.passQty,
      failedQty: s.failQty,
      retestQty: s.retestQty,
      passRate: rateDeterminable ? s.firstPassRate : null,
      runSec: runDeterminable ? s.runSec : 0,
      /* `E83` 的**自然日切段**随 `run_sec` 一起落库（真源＝`services/stats.js` 的
         `splitRunSecondsByDay()`，经 `computeShiftStats()` 的 `runSecDay1/runSecDay2` 出来）。
         ⚠ 两个**一起给或一起不给**（`upsertFrozen()` 会拒收半给）：`runDeterminable === false` 时
         `runSec` 只能落 0（列约束），而"没帧 ⇒ 无法判定"这件事由 `oee: null` 承载 ⇒ 这里同样
         **不写切段**（留 NULL ＝"没算过"），不用 `0/0` 冒充"量到了 0 秒"（`E38` 的既有口径）。 */
      runSecDay1: runDeterminable ? s.runSecDay1 : null,
      runSecDay2: runDeterminable ? s.runSecDay2 : null,
      idleSec: runDeterminable ? s.idleSec : 0,
      oee: runDeterminable ? s.oee : null,
      /* 固化（或补记）**动作发生**的时刻（注入时钟）。补记行的 `frozen_at` 晚于班次结束时刻 ——
         两者之差就是"补记"这件事的可读证据（本表没有状态位列；`run_sec_day1/day2` 是 `E83`
         于 2026-10-04 追加的两列，见 `schema.sql` 与 `repo/shiftStat.js` 文件头）。 */
      frozenAt: nowText,
      createdAt: nowText
    };
    return { row, splitDegraded };
  }

  /** 固化/补记一个班次（唯一写入口＝`repo/shiftStat.js` 的 `upsertFrozen()`）；失败**只记不抛**。
   *
   *  `E146`（`T-20261004-19`）的**降级行计数**在这里加：`upsertFrozen()` 真的写进了行
   *  （`written === true`，与 `state.shiftStatWrite.writes` **同一口径**）且该行的切段是**降级兜底形态**
   *  时，`splitDegradedRows` 才 +1。
   *  · **判据不在这里**：由 `shiftStatRowOf()` 交出（真源仍是 `stats.js` 的 `degraded` 标记）—— 本函数
   *    **不另判一套**，也不从行值反推（拿 `runSecDay2 === 0` 当证据 = 第二份判据）。
   *  · **不去重**：同一原因降级 4 行 ⇒ 计数 +4，而人读的告警**仍然只有 1 条**（那正是两者分开的意义）。
   *  · **失败那一支（catch）不计数**：那一行**没落库** ⇒ 只记 `failures`/`lastError`。计数的语义是
   *    "**真的写进库**的降级行数"，故不变量 `splitDegradedRows ≤ writes` 恒成立。 */
  function freezeShift(shift) {
    const built = shiftStatRowOf(shift);
    const row = built.row;
    try {
      const r = shiftStatRepo.upsertFrozen(state.db, row);
      if (built.splitDegraded === true && r && r.written === true) state.shiftStatWrite.splitDegradedRows++;
      return r;
    } catch (err) {
      state.shiftStatWrite.failures++;
      state.shiftStatWrite.lastError = String((err && err.message) || err);
      if (logger) {
        logger.warn('[DR-06] shift_stat 写入失败（帧已落库、判定照跑；本条只影响班次固化的持久化）：' +
          `${state.shiftStatWrite.lastError}（班次 ${row.shiftDate} ${row.shiftName}）`);
      }
      return null;
    }
  }

  /**
   * **跨班检测 ＋ 固化上一班 ＋ 按序补记**（只在既有的 1 s 采样 tick 内跑，**不新增定时器**）。
   *
   * 判据：帧的**采集时刻**所属班次（`shiftRules.at(at)`）与"上次所见班次"不同 ⇒ 发生了跨班；
   *   · 时间**向前**跨（`cur.startAt > lastShift.startAt`）才当作边界；乱序/迟到帧（时间倒退）
   *     计进 `/health.shiftStatWrite.staleFrames`，**不固化**（否则会把"回头路"当边界、
   *     去固化一个还没结束的班次）；
   *   · 中间被跳过的班次**逐个枚举**（从上一班的 `endAt` 起步走班次真源，走到当前班次为止）⇒
   *     "一跳 N 个边界 ⇒ 补记 N 个班次"，顺序＝旧 → 新。
   * @returns {{frozen:number, backfilled:number, list:string[]}|null} 自报（日志/探针用；异常时 null）
   */
  function freezeCrossedShifts(frame) {
    const st = state.shiftStatWrite;
    try {
      const at = collectTimeTextOf(frame);
      let cur = null;
      try {
        cur = shiftRules.at(at);
      } catch (err) {
        /* 配置缺口（该时刻不属任何班次）⇒ 不固化、不猜；如实记一条（`services/shift.js` 的口径就是抛错） */
        st.failures++;
        st.lastError = `班次归属失败：${(err && err.message) || err}`;
        if (logger) logger.warn(`[DR-06] 跨班检测跳过：${st.lastError}`);
        return null;
      }
      const curKey = shiftKeyOf(cur);
      if (!st.lastShiftKey) {
        /* 本进程的首次 tick：先尝试**从库回读**上次所见班次（覆盖"重启跨越了边界"的情形）；
           回读不到 ⇒ 只记当前班次（不编造上一班）。 */
        const prev = previousFrameShiftOf(frame);
        if (prev && prev.startAt < cur.startAt) {
          st.lastShiftKey = prev.key;
          st.lastShift = prev;
        } else {
          st.lastShiftKey = curKey;
          st.lastShift = cur;
          return { frozen: 0, backfilled: 0, list: [] };
        }
      }
      if (st.lastShiftKey === curKey) return { frozen: 0, backfilled: 0, list: [] };
      if (cur.startAt <= st.lastShift.startAt) {          // 时间倒退：不是边界
        st.staleFrames++;
        return null;
      }
      /* 枚举 [上次所见班次, 当前班次) 之间的**全部**班次（含上次所见那一班，它是"正常固化"）：
         从"上一班的结束时刻"起步走班次真源 —— 半开区间 `[start, end)` ⇒ 边界时刻恰落在**下一班**，
         故一步一班、不会重复也不会漏。 */
      const list = [completedShiftOf(st.lastShift.startAt)];
      let cursor = st.lastShift.endAt;
      let truncated = false;
      while (list.length <= MAX_BACKFILL_SHIFTS) {
        const next = shiftRules.at(cursor);
        if (shiftKeyOf(next) === curKey) break;
        if (next.startAt <= list[list.length - 1].startAt) { truncated = true; break; }   // 不前进 ⇒ 停
        list.push(completedShiftOf(next.startAt));
        cursor = next.endAt;
      }
      if (list.length > MAX_BACKFILL_SHIFTS) truncated = true;
      if (truncated) {
        st.failures++;
        st.lastError = `补记枚举中断：已达上限 ${MAX_BACKFILL_SHIFTS} 个班次仍未到达 ${curKey}`;
        if (logger) logger.warn(`[DR-06] ${st.lastError}（已枚举到的班次照常固化，不静默）`);
      }
      /* 按时间序（旧 → 新）固化：`list[0]` 是上次所见的那一班，其余（i > 0）是**补记**。 */
      const written = [];
      let backfilled = 0;
      for (let i = 0; i < list.length; i++) {
        const r = freezeShift(list[i]);
        if (r && r.written) {
          written.push(r.shiftKey);
          if (i > 0) { backfilled++; st.backfills++; }
        }
      }
      if (written.length) st.writes += written.length;
      /* 记住"当前班次"，下一 tick 的被减数就是它 */
      st.lastShiftKey = curKey;
      st.lastShift = cur;
      if (written.length && logger) {
        logger.info(`[DR-06] 跨班固化：${written.join(' , ')}（其中补记 ${backfilled} 个错过的边界；` +
          `固化时刻=${platformClock.fmt(currentClock().now())}）`);
      }
      return { frozen: written.length, backfilled, list: written };
    } catch (err) {
      st.failures++;
      st.lastError = String((err && err.message) || err);
      if (logger) logger.warn(`[DR-06] 跨班固化异常（不污染采集链、判定照跑）：${st.lastError}`);
      return null;
    }
  }

  /* ---- 6e-5. DR-14（保留策略 1 年）的**生产调用方** —— 技术债 `E89` 的落地 ----
     背景（E89）：`server/db/maintain.js` 的 `applyRetention()` 与保留期常量 `RETENTION_DAYS = 365`
     一直都在、裁剪表清单也含 `op_log`，**但全仓没有任何生产调用方**（只有 `tests/db-check.js` 直接调）
     ⇒ ①库无界增长（`measure_rt` 等高频表尤其）；②`repo/notice.js` 文件头自述的"审计反查地平线＝
     保留期（1 年）"**带有前提**（只有真跑过裁剪才成立）。
     负责人 2026-10-03 的裁定：**复用既有 1 s 采样 tick、按"跨自然日"触发**（**不新增定时器**，
     与 A1 的跨班检测同款）—— 本段就是它。三处口径（负责人特别要求写在代码里）：

     【① 1 s tick 里怎么判"跨了自然日"】
     触发点在**既有的 `onSampledTick()`** 内部（`ingest` 的 `onSampled`＝"1 s 采样落库成功之后"，
     与 DR-05／DR-06／DR-08 **同一拍**），**不新增任何定时器**（ADR-0009 D3①／本包裁定）。
     判据只用**注入时钟** `currentClock()`：把 `platformClock.fmtDate(now)` 得到的 `yyyy-MM-dd`
     与"本进程已跑过的那个日子"比对，**不相等即跨日**（或本进程还没跑过）。为什么不用
     `collectTime`／帧时刻：那会把"上位机补传的旧帧"当成时间前进（甚至倒退），跨日判据必须
     跟着"服务自己的今天"走；而"今天"只有一个来源 —— `platformClock`（ADR-0003 D17：
     本文件不裸写 `new Date()`／`Date.now()`）。日期文本由 `platformClock.fmtDate()` 产出，
     与班次归属用的 `fmtDate` 是**同一个函数**（不另写第二套自然日口径）。

     【② 同一自然日怎么去重】
     进程内记忆 `state.retentionWrite.lastRunDay`（`yyyy-MM-dd`）。**先记后跑**：离开本函数前
     无论成败都把 `lastRunDay` 写成"今天" ⇒
       · 成功 ⇒ 今天不再扫（不是"每 tick 扫一遍全表"）；
       · **失败也不重扫**：`applyRetention()` 会先对 6 张表各做一次 `COUNT(*)`，若把它失败当成
         "今天还没跑"而每 tick 重试，就是**每秒一次全表扫描**（正好是 E89 说的日志/负载噪声）——
         故失败同样计入"已跑过"，代价是"今天剩下的时间不重试"，下一个自然日再来（可观测：`failures`＋
         `lastError`）。
     进程重启后记忆清空 ⇒ **同一自然日可能再跑一次**：这是**刻意**的（否掉"必须落表/加列才能幂等"
     的方案 —— 那要动 `schema.sql`，ADR-0009 D5 与 `E89` 都不许）。理由是**裁剪本身幂等**：
     `DELETE … WHERE <列> < cutoff` 是集合差，第二次扫描删 0 行；收益是"每天都会重启一次的现场"
     也真的裁剪得到（不做"首次 tick 不跑、只认日界跳变"，那会让这种现场的裁剪**永不发生**）。
     上限＝"本进程内每自然日 1 次"；重启次数就是额外扫描次数（扫描成本＝6 次 COUNT＋最多 6 次 DELETE）。

     【③ `maxDelete` 怎么选】
     **不传，用 `maintain.RETENTION_MAX_DELETE`（5 000 000 行）这一份真源**（本文件不复制常量；
     上方常量声明处已说明）。理由：
       · 那个上限的语义是"**参数或口径出问题**就先停下，绝不悄悄清库"（`maintain.js:279` 的原话），
         它的取值与 `days` 的校验同属**保留策略自己的安全边界** —— 由调用方另填一个数，
         就等于把这条边界复制成第二份口径（必然漂移）；
       · 现场首次上线时库里可能**已经攒了**多年的行（"1 年裁剪"从未跑过 ⇒ 首跑要删的正是历史欠账），
         把上限调大 = 削弱护栏、调小 = 让首跑永久失败 ⇒ 都不该由本包拍脑袋；
       · 因此**接受"超过上限即中止"**这条既有行为：中止时 `applyRetention()` 抛 `RangeError`，
         被下面的 catch 计成 `failures++` ＋ `lastError`（消息里带**将删除行数**与 `cutoff`），
         并写一条 `warn` 日志 ⇒ **如实发声、不静默**；当日不再重试（见②），次日再来。
         现场若真跑到这一步，处置＝按运维手册先归档/分批清理，再按需调整 `maintain.js` 的那一条常量
         （改真源、登记一条技术债，而不是在入口塞第二个上限）。
     口径的另一半：`days` 同样**不传** ⇒ 走 `maintain.RETENTION_DAYS = 365`（"保留期 1 年"的单一真源）。

     【失败隔离】`applyRetention()` 抛错 ⇒ **只记不抛**（下面 `try/catch` 全包），采集链/判定链
     照跑（本函数在 `onSampledTick()` 里**排在最后**，且它一抛也不会回到 ingest 的 catch 里
     变成 `sampledHookFailures`）；可观测出口＝`/health.retentionWrite`。
     【顺序】放在 tick 的**最后**：先让 DR-06 固化、DR-05＋DR-08 判定与落库都做完，再做这件
     "清理历史"的活 —— 它只影响**超期**数据（≥365 天），与本次采样/判定没有因果关系。 */

  /** 自然日文本（`yyyy-MM-dd`，本地时区）—— 真源＝`platformClock.fmtDate()`，与班次归属用同一个函数。 */
  function dayTextOf(now) { return platformClock.fmtDate(now); }

  /**
   * 跨自然日跑一次 `DR-14` 保留裁剪（见 6e-5 段头的三处口径）。**只在既有 1 s 采样 tick 内被调**。
   * @returns {{ran:boolean, day:string, cutoff:(string|null), deleted:number, error:(string|null)}}
   *   自报（日志/探针用）；本函数**永不抛**（失败只记不抛）。
   */
  function runDailyRetention() {
    const r = state.retentionWrite;
    /* 判据用**注入时钟**（不是帧时刻、不是墙钟）：`currentClock()` 与 `uptimeSec`／班次归属同源。 */
    const day = dayTextOf(currentClock().now());
    if (r.lastRunDay === day) return { ran: false, day, cutoff: r.lastCutoff, deleted: 0, error: null };
    /* **先记后跑**（见段头②）：失败也计"今天跑过"，否则会退化成"每 tick 重试一次全表扫描"。 */
    r.lastRunDay = day;
    r.runs++;
    try {
      /* `days` / `maxDelete` 都**不传** ⇒ 一律走 `maintain.js` 的真源（见段头③）。 */
      const res = maintain.applyRetention(state.db, { now: currentClock().now() });
      r.lastCutoff = res.cutoff;
      r.lastDeleted = res.totalDeleted;
      r.totalDeleted += res.totalDeleted;
      r.lastError = null;
      if (res.totalDeleted > 0 && logger) {
        logger.info(`[DR-14] 保留裁剪：cutoff=${res.cutoff}（保留 ${maintain.RETENTION_DAYS} 天），` +
          `删除 ${res.totalDeleted} 行（明细 ${JSON.stringify(res.deleted)}）`);
      } else if (logger) {
        logger.info(`[DR-14] 保留裁剪：cutoff=${res.cutoff}，本次无超期数据（0 行）`);
      }
      return { ran: true, day, cutoff: res.cutoff, deleted: res.totalDeleted, error: null };
    } catch (err) {
      r.failures++;
      r.lastError = String((err && err.message) || err);
      /* 失败不写 `lastCutoff`（`applyRetention()` 抛错时没有可信的 cutoff 可报）—— 保留**上一次成功**
         的那个值：`null`（还没成功过）与"某个具体时刻"分得开，"这次失败"由 `failures`/`lastError` 说话。 */
      if (logger) {
        logger.warn('[DR-14] 保留裁剪失败（**只记不抛**：采集链与判定链照跑；当日不再重试，次日再来；' +
          `读口＝GET /health 的 retentionWrite）：${r.lastError}`);
      }
      return { ran: true, day, cutoff: null, deleted: 0, error: r.lastError };
    }
  }

  /* ---- 6e-3 追加：DR-08（`warning` 表）的落库 —— 技术债 `E62` 的落地（ADR-0009 D1，T-20261002-05）----
     背景（E62）：`warning`（DR-08）此前**零写入点** ⇒ 判定产出经 SSE 发出后**不落库**、无预警历史。
     写入点＝**判定发布点同批**（`emitWarnings()` 内、`judge.evaluate(…,{bus})` 那次发布之后，
     同一个 tick、同一帧）—— 与 ADR-0009 D1 的表述逐字一致。
     **顺序：先发布、后落库**（与 `result` 的"先固化后发布"相反），理由两条：
       · `result` 必须先固化，是因为 `FR-5.11` 的减数「已完成」读的正是它（**有反馈回路**）；
         而预警落库**不反哺判定**（`judge.evaluate()` 不读 `warning` 表）⇒ 顺序无因果影响；
       · 落库失败**只记不抛**（沿 `persistJudgement()` 的纪律）：不该因为库写不进去就把本条预警的
         SSE 推送也吞掉 —— 推送与落库是两件事。
     **只落 `lv !== 'ok'` 的条目**：`ok` 是"参数均处于允许范围"的**回执条**（FR-5.8／C-88 的
     "标准未设定 ⇒ 两条都不产生"同源），把它写进"预警记录表"就是把非预警记成预警（计数见
     `/health.warningWrite.skippedOk`）。
     **幂等键**＝`(warn_type, 归属键)`，归属键写在 `trigger_cond` 的前缀里（结构不动 ⇒ 无列可加、
     无唯一索引可用；逐条理由与形态见 `repo/warning.js` 文件头）。归属成分"拿不到"时一律写成
     `无工单`／`无件序号`／`无归属日`，**不编造 1 或当天**（E60 裁定①的同一纪律）。 */

  /** 参数类预警的**参数名**（`depth`/`speed`）—— 从 detail 的前缀导出。
   *  `judge.paramDetail()` 逐字以 `PARAM_CN[kind] + ' '` 开头（"深度 5.22（标准 …）"），
   *  故这是**确定性**的导出、不是猜；导出不来 ⇒ `null`（调用方退化为"把 detail 也放进键"，不合并）。 */
  function paramKindOf(detail) {
    const text = typeof detail === 'string' ? detail : '';
    for (const kind of judge.PARAMS) {
      const cn = judge.PARAM_CN[kind];
      if (cn && text.startsWith(cn + ' ')) return kind;
    }
    return null;
  }

  /** 预警的**归属键**（幂等键的实质；形态与理由见 `repo/warning.js` 文件头）。
   *  ⚠ 归一化只做到"归属"这一层，**不碰等级**（等级由 `warn_type` 承载）：
   *    同一件同一参数的 `warn`→`err` 是**新的预警事实**，各记一条。 */
  function warnDedupeKeyOf(warning, ctx) {
    const title = warning && warning.title ? String(warning.title) : '';
    const day = ctx.shiftDate || '无归属日';
    const owner = ctx.procOrderNo ? `工单${ctx.procOrderNo}` : '无工单';
    const piece = ctx.unitIndex === null || ctx.unitIndex === undefined ? '无件序号' : `第${ctx.unitIndex}件`;
    const detail = warning && warning.detail ? String(warning.detail) : '';
    if (title === judge.WARN_TITLES.warn || title === judge.WARN_TITLES.err) {
      /* C-88 的两条具名参数类：**一个参数一条**（同态也各出一条）⇒ 键必须含参数名，否则会把
         "深度超范围"与"速度超范围"合并成一条（静默丢预警）。 */
      const kind = paramKindOf(detail);
      return kind
        ? `参数|${day}|${owner}|${piece}|${kind}`
        : `参数|${day}|${owner}|${piece}|未知|${detail}`;
    }
    if (title === judge.OTHER_TITLES.order) return `工单超时|${day}|${owner}`;
    if (title === judge.OTHER_TITLES.maintenance) {
      /* 维保到期按**维保周期**归一（同一周期只记一条）："下次维保日"＝配置真源的纯函数产物
         （`judge.maintenanceState()`）；算不出来 ⇒ 退化为按 detail（不合并、不丢条）。 */
      try {
        const st = judge.maintenanceState(ctx.at);
        return st && st.next ? `维保|${st.next}` : `维保|${detail}`;
      } catch { return `维保|${detail}`; }
    }
    if (title === judge.OTHER_TITLES.consumable) return `耗材|${day}|${title}`;
    /* 未知类型（判定引擎日后新增一类而这里没跟上）⇒ 按原文入键：**宁可多记一条，也不合并**。 */
    return `${title}|${day}|${owner}|${piece}|${detail}`;
  }

  /** DR-08 落库（在判定发布点**同批**调用）；失败只记不抛。
   *  `unitIndex` 由调用方**只取一次**后传入（`unitIndexOf()` 每次都会记 warn 日志，重复调用会打两遍）。 */
  function persistWarnings(frame, out, at, unitIndex) {
    const w = state.warningWrite;
    const list = out && Array.isArray(out.warnings) ? out.warnings : [];
    const rawNo = frame ? frame[FIELD_PROC_ORDER_NO] : undefined;
    const procOrderNo = rawNo === undefined || rawNo === null ? '' : String(rawNo);
    let shiftDate = null;
    try { shiftDate = shiftRules.at(at).date; } catch { shiftDate = null; }
    const ctx = { shiftDate, procOrderNo, unitIndex, at };
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (item.lv === 'ok') { w.skippedOk++; continue; }   // `ok` 回执条不是预警（见上面段头）
      try {
        const r = warningRepo.insertWarning(state.db, {
          warnType: item.title,
          triggerCond: item.detail,
          triggeredAt: at,
          createdAt: platformClock.fmt(currentClock().now()),
          dedupeKey: warnDedupeKeyOf(item, ctx)
        });
        if (r.written) w.writes++; else w.duplicates++;
        w.lastWarnType = r.warnType;
      } catch (err) {
        w.failures++;
        w.lastError = String((err && err.message) || err);
        if (logger) {
          logger.warn('[DR-08] warning 表写入失败（预警已发布；本条只影响预警历史）：' +
            `${w.lastError}（${JSON.stringify(item.title)}）`);
        }
      }
    }
    return { writes: w.writes, duplicates: w.duplicates, skippedOk: w.skippedOk, failures: w.failures };
  }

  logger.info(`[预警] 判定装配已接线（W5-② / E45）：发布点=ingest 的 onSampled（1 s 采样落库之后）；` +
    `取数=task(procOrderNo)→标准(产品,工序,指定时刻生效版本)；单件进度=testStatus 按 C-98④ 导出；` +
    `耗材更换（FR-5.10）**仍无服务端取数源 ⇒ 不产生**（不编造，真实源＝上位机/设备台账，Q-13）；` +
    `工单超时（FR-5.11）**已由真实件数驱动**（应完成=节拍×(采集时刻−计划开工)、已完成=result 表按件计数）；` +
    `拿不到件序号（帧未带/非法 unitIndex）⇒ 不固化 ＋「工单超时」**整条不产生**（E60 裁定①，不编造）；` +
    `发布读的是**固化之后**的件数（先固化后发布，E60 裁定②）；` +
    `判定异常计入 ingest.status().counts.sampledHookFailures`);
  logger.info(`[DR-05] result 表写入点已接线（技术债 E58 ② 收口）：与判定同拍（onSampled＝1 s 采样落库之后）` +
    `按件 upsert（键 proc_order_no+unit_index，唯一索引 ux_result_unit）；结果＝**本看板判定**（FR-3.13，` +
    `不采信 IF-D 的 result，C-102）；judged_at=判定时刻（注入时钟）、duration_sec=该件首末有效帧采集时刻差；` +
    `待复检不计"已完成"（与 stats.DONE_STATUS 同口径）；写失败只记不抛（T-20261003-02 起计数与读口同备：` +
    `**计数见 /health.resultWrite** 的 writes／failures／skippedNoUnit，三者互不代偿）；` +
    `E58 的临时抑制闸已按裁定**整段拆除** ——「已完成件数」现在由本条写入点说话；` +
    `**拿不到件序号（帧未带/非法 unitIndex）⇒ 本写入点整条不跑**（不再缺省 1，E60 裁定①，` +
    `该次数单记在 /health.resultWrite.skippedNoUnit，**不并进 failures**）`);
  logger.info(`[DR-06] shift_stat 写入点已接线（技术债 E59 收口／ADR-0009 D1＋D3）：触发点=**同一个 1 s 采样 tick**` +
    `（不新增定时器）内检测跨班 ⇒ 固化上一班，被跳过的边界**下次采样按序补记**（重启后从 measure_rt 回读上次所见班次）；` +
    `取数=stateSnapshot.statsForShift()（与 GET /state 同一份 SQL）；` +
    `**无采集帧的班次不伪造 0**：oee/pass_rate 落 NULL＝"无法判定"（run_sec/idle_sec 受列约束只能 0，读方以 NULL 为准）；` +
    `幂等=ux_shift_stat 唯一索引 upsert（同班次不新增行）；计数见 /health.shiftStatWrite`);
  logger.info(`[DR-08] warning 表写入点已接线（技术债 E62 收口／ADR-0009 D1）：与**判定发布点同批**` +
    `（emitWarnings 内、warning 事件发布之后、同一 tick）；只落 lv≠ok 的预警条（ok 回执条不是预警）；` +
    `幂等键=(warn_type, 归属键)，归属键写在 trigger_cond 前缀（结构不动 ⇒ 无唯一索引可用，见 repo/warning.js）；` +
    `归属拿不到就写"无工单/无件序号/无归属日"（不编造）；写失败只记不抛，计数见 /health.warningWrite`);
  logger.info(`[DR-14] 保留策略（1 年）已有**生产调用方**（技术债 E89 收口／负责人 2026-10-03 裁定）：` +
    `触发点=**同一个 1 s 采样 tick**（onSampledTick 的最后一拍，**不新增定时器**）内按"**跨自然日**"触发一次；` +
    `保留期＝maintain.RETENTION_DAYS（365 天，单一真源，不在入口复制）；单次删除上限＝` +
    `maintain.RETENTION_MAX_DELETE（超限即中止并计 failures＋lastError，见 6e-5 段头③）；` +
    `同一自然日内只跑一次（**失败也不重扫**；重启后同日再跑一次是无害的 —— 裁剪幂等）；` +
    `失败只记不抛（不污染采集链），计数见 /health.retentionWrite；` +
    `⚠ op_log 因此**有寿命**：审计反查地平线＝保留期（repo/notice.js 文件头的"未自述边界①"由本条提供前提）`);
  logger.info(`[DR-17] 累计运行取数已改真源：日/月/年＝对 shift_stat 求和（shift_date 归属 ⇒ 跨零点/跨月正确），` +
    `当班增量＝当班runSec − 该班次已固化run_sec；addRunSec 上界按 ADR-0009 D3 **重设**为 elapsedSec` +
    `（旧上界 runSec 在"无采集串且无在测件"时恒 0）；活读数见 /health.addRunSecBound 与 /health.runAccum`);
  /* `E83`＋`E128`（2026-10-04）：**跨零点口径的两个投影**已落地 ⇒ 这条日志把"两套投影各是谁、
     现配置下是否同值、闸开没开"一次说清（读方按 `/health.crossMidnight` 巡检）。 */
  logger.info(`[E83] 跨零点口径的两个投影已落地（负责人 2026-10-04 裁定）：` +
    `①**班次投影**＝整班归"班次开始那天"（DR-06/FR-4.16；shift_stat.run_sec，按 shift_date 求和，**未改**）；` +
    `②**自然日投影**＝运行秒数**按零点切段**（前段归 D、后段归 D+1；落盘 shift_stat.run_sec_day1/run_sec_day2，` +
    `每日档＝"归属日=D 的 day1"＋"归属日=D−1 的 day2"）⇒ 供 FR-6.4/6.5/6.6 与 FR-6.12 对账；` +
    `恒等式 run_sec_day1+run_sec_day2=run_sec 由**写入口**拒收保证（不丢秒、不重复计）；` +
    `现配置（0-8/8-16/16-24）无跨零点班次 ⇒ day2≡0 ⇒ **两套投影恒同值**（改前/改后逐字比对见 tests\\._verify\\e83-*.js）；` +
    `/health.runAccum 的 naturalDay 与 shiftProjection 两段并列报出，差值＝跨零点切段的效应`);
  if (state.crossMidnight && state.crossMidnight.count > 0) {
    logger.warn(`[E128 ⚠ 跨零点班次配置] 配置里含 ${state.crossMidnight.count} 条跨零点班次：` +
      `${state.crossMidnight.keys.join(' , ')}（allowCrossMidnight=${state.crossMidnight.allowed}）—— ` +
      `这些班次的运行秒数跨自然日，**当日/本月/年度累计运行**走 E83 的自然日投影（按零点切段）；` +
      `班次指标（FR-4.16/§4.4）仍按班次边界、整班归开始日。改了班次配置请同步核对 /health.runAccum 的` +
      `naturalDay 与 shiftProjection（两者不再同值属**预期**，同值才是异常）。`);
  } else {
    logger.info(`[E128] 跨零点班次配置自述：count=0（现配置无跨零点班次）⇒ 两个投影恒同值；` +
      `准入闸=显式 opt-in（未写 shift.allowCrossMidnight=true 而配了 end<start ⇒ **启动期拒绝**）；` +
      `读口＝/health.crossMidnight`);
  }

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
    [router.mountIfA(), router.mountIfD(), router.mountUpload(), router.mountSSE(), authMount, notice]
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
    mounts: { ifd, ifa, upload, sse, notice }
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
  /* E58 的抑制字面量导出（`ORDER_DONE_SUPPRESS_REASON`）已随临时闸一并删除（T-20260930-08）——
     抑制约定不存在了：`result`（DR-05）写入点已在 1 s 采样落库之后按件落库。 */
  state
};
