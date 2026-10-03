/* ==========================================================================
   测试夹具（tests/lib/harness.js）
   作用：为后端自检提供**隔离**的运行环境与临时资源：
         ①临时库（一用例一库、WAL、跑完删）②临时目录（**按轮次隔离**：
           `tests\._verify\tmp\run-<pid>-<启动时刻>-<4hex>`，见文件中部 `E90` 注释）
         ③空闲端口分配 ④服务进程启停（stdio 落文件，避免管道依赖）⑤错误注入工具
   为什么必须有它：不隔离会写脏生产数据；SQLite WAL 下"服务持锁、测试写入"
         会出现随机失败；共用库会让用例互相污染（"单跑过、连跑挂"）；
         共用**临时根**会让并发跑的收尾互相删产物（`E90`：假红与"返回值说谎"）。
   依据：ADR-0003 D17；规范 9.5-5 第 3 条（一个用例一个库）；
         `E90`（2026-10-03）：临时区按轮次隔离 ＋ `cleanup(force)` 的返回值必须由**事实**推导。
   依赖：仅 Node 内置模块（node:sqlite 延迟加载，未达标时不因本文件报错）。
   用法：
     const { makeTempDir, makeTempDb, allocPort, startService, stall } = require('./lib/harness');
     const db = makeTempDb();          // { path, dir, db, close, reopen }
     db.db.exec('CREATE TABLE t(a)');
     db.close();
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const env = require('../env');

/* ---------------- 临时目录与临时库 ---------------- */

/* 【E90（2026-10-03，★★★）临时区**按轮次隔离** —— 改任何临时路径前先读完这一段】
   旧版所有进程共用一个 `tests\._verify\tmp`，于是**任一路的 `cleanup(true)`**
   （＝ `rmSync(共享根, {recursive:true})`）会删掉**另一路正在用**的产物，实测两类假红：
     ① `harness-check` 里两条 `screenshot-diff` 判据读子进程日志**读回空串**（落点
        `harness-check.js:3972`）：另一路的 `cleanup(true)` 把本轮写进 `tmp\` 的日志删了；
     ② `harness-check` §五"`cleanup(true)` 真能清空临时区"因**他路**在 `tmp\` 下持有句柄
        ⇒ `rmSync` 中途 `EPERM`、被 `catch` 吞掉 ⇒ 断言报"残留目录仍在=true"。
   现在把两个概念**显式分开**（只在这里定义；别处一律读 `env.paths`）：
     · `tempRootBase` ＝ **公共根**（＝旧 `tempRoot` 的原意 `tests\._verify\tmp`）：
       只作为"各轮目录的父目录"与 24 小时过期清扫的对象；
     · `tempRoot`     ＝ **本轮专属**目录 `<base>\run-<pid>-<本地启动时刻>-<4 hex>`：
       本轮所有临时目录/临时库/子进程日志都落在它下面 ⇒ **任一路的 `cleanup` 只能删到
       自己的 `run-<pid>-…`，物理上删不到别人的** —— 这就是"并发不再互相删"的全部机制。
   向后兼容：`tempRoot` 的**名字与用法一字不变**（仍是"可写的临时区"：`preflight` 的写探针、
   `db-check`/`files-check` 找散落库文件、`harness-check` 数目录数都照旧），只是它现在指向
   本轮子目录；需要"公共根"的地方**显式**读 `env.paths.tempRootBase`（如 `run-all` 的过期清扫）。
   落地方式：本文件被 require 时就把这两个键写进 `env.paths`（`env.paths` 是**同一个对象**，
   故所有 `require('../env')` 的脚本立刻看到同一口径，不必逐个脚本改）。 */
const tempRootBase = env.paths.tempRoot;                       /* 公共根：tests\._verify\tmp */
const runStartedAt = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
const runStamp = `${runStartedAt.getFullYear()}${pad2(runStartedAt.getMonth() + 1)}${pad2(runStartedAt.getDate())}`
  + `T${pad2(runStartedAt.getHours())}${pad2(runStartedAt.getMinutes())}${pad2(runStartedAt.getSeconds())}`;
/* 随机后缀：Windows 的 pid 会复用 ⇒ 只按 pid ＋ 秒级时刻命名有"同名撞上旧轮残留"的理论窗口 */
const runTempRoot = path.join(tempRootBase, `run-${process.pid}-${runStamp}-${randomBytes(2).toString('hex')}`);
env.paths.tempRootBase = tempRootBase;                         /* 公共根（显式命名，供清扫与排查） */
env.paths.tempRoot = runTempRoot;                              /* ← 语义更新：指向本轮专属子目录 */

let seq = 0;
/** 生成本次运行内唯一的临时目录名（同时带 pid 便于排查残留） */
function uniqueName(prefix) {
  seq++;
  return `${prefix}-${process.pid}-${seq}-${Date.now().toString(36)}`;
}

/** 在**本轮专属**临时根下建一个临时目录（`tests\._verify\tmp\run-<pid>-…\`，**已被 .gitignore 忽略**） */
function makeTempDir(prefix = 'case') {
  const dir = path.join(env.paths.tempRoot, uniqueName(prefix));
  env.ensureDir(dir);
  return dir;
}

/**
 * 延迟加载 node:sqlite：Node < 22.5 没有该模块，
 * 但不能让"引用本文件"本身就抛错（否则旧环境连报错信息都看不全）。
 */
function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (err) {
    throw new Error(`node:sqlite 不可用（当前 ${process.version}），需 Node >= ${env.MIN_NODE_MAJOR}：${err.message}`);
  }
}

/**
 * 建一个**独立的**临时 SQLite 库（WAL 模式）。
 * @param {{name?: string, initSql?: string|string[], foreignKeys?: boolean}} [options]
 * @returns {{path:string, dir:string, db:object, walPath:string, close:Function, reopen:Function}}
 */
function makeTempDb(options = {}) {
  const { DatabaseSync } = loadSqlite();
  const dir = makeTempDir(options.name || 'db');
  const dbPath = path.join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);

  // WAL：与服务端运行配置一致，避免"测试用 DELETE、生产用 WAL"掩盖并发差异
  const journal = db.prepare('PRAGMA journal_mode = WAL').get();
  if (options.foreignKeys !== false) db.prepare('PRAGMA foreign_keys = ON').get();

  if (options.initSql) {
    const scripts = Array.isArray(options.initSql) ? options.initSql : [options.initSql];
    for (const sql of scripts) db.exec(sql);
  }

  /* 跟踪本夹具创建过的**所有**数据库连接。
     为什么需要：reopen() 会新建连接，旧连接若不显式 close，Windows 上文件仍被占用，
     导致临时目录删不掉（表现为测试通过但脏文件残留，进而污染版本库风险）。 */
  const handles = [db];

  const handle = {
    dir,
    path: dbPath,
    db,
    journalMode: journal && journal.journal_mode,
    /** 用外部连接替换当前句柄（例如测试用 server/db 的 openDb 打开同一文件）。
     *  **必须走本方法**：直接把 handle.db 赋成新连接会**丢掉夹具自建连接**的跟踪，
     *  导致它一直不放 → Windows 上临时目录删不掉（曾实际踩到过）。 */
    adopt(conn) {
      if (conn !== handle.db) handles.push(conn);
      handle.db = conn;
      return conn;
    },
    /** 当前仍被跟踪的活跃连接数（自检用：应为 1，close 后为 0） */
    liveConnections() {
      return handles.length;
    },
    /** 关闭**全部**连接并删除整个临时目录（幂等）。
     *  注意：**不静默吞异常** —— 删不掉时必须能看见原因（Windows 上文件占用会静默失败，
     *  表现为"测试通过但脏文件残留"，属于要查的问题而不是可忽略的小事）。 */
    close() {
      const problems = [];
      for (const h of handles) {
        try { h.close(); } catch (e) { problems.push('close: ' + e.message); }
      }
      handles.length = 0;
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
      } catch (e) {
        problems.push('rm: ' + e.code + ' ' + e.message);
        /* 逐个文件探测：定位到底哪个文件仍被占用（Windows 上常见于 -wal/-shm 未释放） */
        try {
          for (const n of fs.readdirSync(dir)) {
            try { fs.rmSync(path.join(dir, n), { force: true }); }
            catch (e2) { problems.push(`占用: ${n} → ${e2.code}`); }
          }
          fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* 已尽可能清理 */ }
      }
      handle.closeProblems = problems;
      return problems;
    },
    /** 关掉再打开同一个文件（用于验证"落库后重启不丢数据"，如 DR-17 累计运行）。
     *  **必须关掉更早的所有连接**，否则 Windows 上文件仍被占用 → 临时目录删不掉；
     *  且旧句柄被重复 close 会报 "database is not open"。 */
    reopen() {
      for (const h of handles) { try { h.close(); } catch { /* 已关闭 */ } }
      handles.length = 0;
      const again = new DatabaseSync(dbPath);
      again.prepare('PRAGMA journal_mode = WAL').get();
      if (options.foreignKeys !== false) again.prepare('PRAGMA foreign_keys = ON').get();
      handles.push(again);
      handle.db = again;
      return again;
    }
  };
  return handle;
}

/* ---------------- 空闲端口 ---------------- */

/**
 * 取一个当前空闲的本地端口（先 bind 0 再释放，存在极小的竞态但足够测试用）。
 * @param {number} [preferred] 优先尝试的端口（被占用则回退到随机）
 */
function allocPort(preferred) {
  return new Promise((resolve, reject) => {
    const tryBind = (port) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', () => { if (port !== 0) tryBind(0); else reject(new Error('无法分配空闲端口')); });
      srv.listen({ host: '127.0.0.1', port }, () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    };
    tryBind(preferred || 0);
  });
}

/* ---------------- 服务进程启停 ---------------- */

/**
 * 以子进程方式启动一个 Node 脚本，并等待端口就绪。
 * **stdio 落文件而非管道**：受限环境下管道会 EPERM，落文件既免疫又便于排查。
 * @param {{script:string, args?:string[], cwd?:string, port?:number, readyPath?:string, timeoutMs?:number, env?:object}} opts
 * @returns {Promise<{proc:object, port:number, logFile:string, stop:Function, output:Function}>}
 */
async function startService(opts) {
  const {
    script, args = [], cwd = env.paths.root,
    port = await allocPort(), readyPath = '/health',
    timeoutMs = 15000, env: extraEnv = {}
  } = opts;

  const dir = makeTempDir('svc');
  const logFile = path.join(dir, 'service.log');
  const fd = fs.openSync(logFile, 'a');

  const proc = spawn(process.execPath, [script, ...args], {
    cwd,
    env: {
      ...process.env,
      DSH_ENV: env.ENV_NAME === 'prod' ? 'test' : env.ENV_NAME, // 绝不把 prod 透给子进程
      DSH_PORT: String(port),
      ...extraEnv
    },
    windowsHide: true,
    stdio: ['ignore', fd, fd]   // 不用 pipe
  });

  let exited = null;
  proc.on('exit', (code, signal) => { exited = { code, signal }; });

  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (exited) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${readyPath}`);
      if (res.ok) { ready = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 120));
  }

  const output = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };

  if (!ready) {
    try { proc.kill(); } catch { /* 已退出 */ }
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
    const why = exited ? `进程已退出（code=${exited.code}）` : `等待 ${timeoutMs} ms 未就绪`;
    throw new Error(`服务未就绪：${why}\n脚本=${script}\n日志=${logFile}\n--- 日志尾部 ---\n${output().slice(-1500)}`);
  }

  return {
    proc, port, dir, logFile, output,
    /** 停止服务并清理临时目录（幂等） */
    async stop() {
      if (proc.exitCode === null && !exited) {
        proc.kill();
        const until = Date.now() + 3000;
        while (proc.exitCode === null && Date.now() < until) await new Promise(r => setTimeout(r, 50));
      }
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  };
}

/* ---------------- 错误注入（验失败路径用） ---------------- */

/**
 * 让某个函数在第 `failAt` 次（及可选的后 n 次）调用时抛错，用于验证：
 *   IF-B.9 上报失败进入待补传队列、IF-D.9 断连降级 等**失败路径**。
 * @param {Function} fn 原函数
 * @param {{failAt?:number, times?:number, error?:Error}} [opts] failAt 从 1 开始计
 */
function injectFailure(fn, opts = {}) {
  const failAt = opts.failAt || 1;
  const times = opts.times === undefined ? 1 : opts.times;
  const error = opts.error || new Error('注入的故障（测试用）');
  let calls = 0;
  const wrapped = function (...args) {
    calls++;
    if (calls >= failAt && calls < failAt + times) throw error;
    return fn.apply(this, args);
  };
  wrapped.calls = () => calls;
  return wrapped;
}

/* ---------------- 收尾 ---------------- */

/** 回读临时区**事实**（不猜）：目标目录是否存在、还剩多少条目（顶层）。 */
function readTempFacts(dir) {
  const exists = fs.existsSync(dir);
  return { exists, entries: exists ? fs.readdirSync(dir).length : 0 };
}

/** 递归条目数（含子目录自身）—— 用来判"删掉了一部分"还是"一条没删"。
 *  用 `lstatSync` **不跟随**链接/junction：本项目有 junction 用例，跟随会出圈。 */
function countEntriesDeep(dir) {
  let n = 0;
  const walk = (d) => {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      n++;
      const full = path.join(d, name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isDirectory() && !st.isSymbolicLink()) walk(full);
    }
  };
  walk(dir);
  return n;
}

/**
 * 清理测试临时区。
 *
 * `force=false`（日常收尾，`run-all` 全绿时调用）：只清**公共根**下超过 24 小时的
 *   **整轮目录**（`run-<pid>-…`）—— 本轮目录刚建、mtime 是新的，故自己与别人的这一清理都
 *   命不中它；返回 `{removed, kept}`（**条数**，与旧口径一致，`harness-check` §五按其类型判）。
 *   **公共根口径不写第二份**：`env.cleanupStaleTemp(maxAgeMs)` 的目标是 `paths.tempRoot`，
 *   `E90` 后它指向本轮子目录 ⇒ 这里**临时**把它指回公共根再调用（同步执行、`finally` 复原，
 *   期间没有别的代码能观察到这个临时态），从而复用同一份"24 小时"策略，避免两份口径漂移。
 *
 * `force=true`（收尾**本轮**临时区）：只删**本轮专属目录** `env.paths.tempRoot`，
 *   且**删完必须回读**（这就是 `E90` 的判据 —— 绝不能用"调用过 `rmSync`"代替事实）：
 *     · `removed`：目标目录**不在**了 ⇒ `'all'`；还在但递归条目变少（或只剩空壳）⇒ `'partial'`；
 *       还在且一条都没少 ⇒ `'none'`；
 *     · `kept`：回读到的**剩余顶层条目数**（另给 `keptDeep` 供排查）；
 *     · `errors`：失败原因（`catch` 里**也回读**，不再静默吞 —— 旧版吞掉异常后无条件
 *       `return { removed:'all', kept:0 }`，即"返回值与事实无关"，那正是 `E90` 要消的）；
 *     · `target`：本轮到底删的是哪个目录（白盒可核）。
 *   **不变量**：`removed==='all'` ⟺ 目标目录不存在 ⟺ `kept===0 && keptDeep===0`。
 */
function cleanup(force = false) {
  if (!force) {
    const runRoot = env.paths.tempRoot;                        /* 本轮子目录（勿动） */
    env.paths.tempRoot = tempRootBase;                         /* 临时态：清扫目标是公共根 */
    try {
      return env.cleanupStaleTemp();
    } finally {
      env.paths.tempRoot = runRoot;                            /* 复原：别处读到的仍是本轮目录 */
    }
  }
  const target = env.paths.tempRoot;
  const beforeDeep = countEntriesDeep(target);
  const errors = [];
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  } catch (err) {
    errors.push(`${(err && err.code) || 'ERR'}: ${(err && err.message) || String(err)}`);
  }
  const after = readTempFacts(target);                         /* ← 事实（回读），不是"调用过" */
  const afterDeep = countEntriesDeep(target);
  let removed;
  if (!after.exists) removed = 'all';                          /* 目录不存在 ⇒ 真清干净了 */
  else if (afterDeep === 0) removed = 'partial';               /* 只剩空壳目录：也没清干净 */
  else if (afterDeep < beforeDeep) removed = 'partial';        /* 删掉一部分，仍有残留 */
  else removed = 'none';                                       /* 一条都没删掉 */
  return { removed, kept: after.entries, keptDeep: afterDeep, target, errors };
}

/* 注：`stall(ms)`（挂起执行以验超时/断连）已于 2026-09-19 删除 ——
   它从加进来起就**零引用**，属"交付了却从未被验证"的死代码（R-2026-09-19-02 的 P2-16）。
   需要挂起时直接 `await new Promise(r => setTimeout(r, ms))`，不必留一个没人用的导出。 */

module.exports = {
  makeTempDir,
  makeTempDb,
  allocPort,
  startService,
  injectFailure,
  cleanup
};
