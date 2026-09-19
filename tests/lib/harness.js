/* ==========================================================================
   测试夹具（tests/lib/harness.js）
   作用：为后端自检提供**隔离**的运行环境与临时资源：
         ①临时库（一用例一库、WAL、跑完删）②临时目录 ③空闲端口分配
         ④服务进程启停（stdio 落文件，避免管道依赖）⑤错误注入工具
   为什么必须有它：不隔离会写脏生产数据；SQLite WAL 下"服务持锁、测试写入"
         会出现随机失败；共用库会让用例互相污染（"单跑过、连跑挂"）。
   依据：ADR-0003 D17；规范 9.5-5 第 3 条（一个用例一个库）。
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
const env = require('../env');

/* ---------------- 临时目录与临时库 ---------------- */

let seq = 0;
/** 生成本次运行内唯一的临时目录名（同时带 pid 便于排查残留） */
function uniqueName(prefix) {
  seq++;
  return `${prefix}-${process.pid}-${seq}-${Date.now().toString(36)}`;
}

/** 在 tests/._verify/tmp 下建一个临时目录（**已被 .gitignore 忽略**） */
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

  const handle = {
    dir,
    path: dbPath,
    db,
    journalMode: journal && journal.journal_mode,
    /** 关闭并从磁盘删除整个临时目录（幂等） */
    close() {
      try { db.close(); } catch { /* 已关闭 */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 被占用则留给清理任务 */ }
    },
    /** 关掉再打开同一个文件（用于验证"落库后重启不丢数据"，如 DR-17 累计运行） */
    reopen() {
      try { db.close(); } catch { /* 忽略 */ }
      const again = new DatabaseSync(dbPath);
      again.prepare('PRAGMA journal_mode = WAL').get();
      if (options.foreignKeys !== false) again.prepare('PRAGMA foreign_keys = ON').get();
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

/** 把某个函数的执行挂起 ms 毫秒（验超时/断连检测） */
function stall(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ---------------- 收尾 ---------------- */

/** 清理测试临时区（默认只清 24 小时前的；传 force=true 清空全部） */
function cleanup(force = false) {
  if (force) {
    try { fs.rmSync(env.paths.tempRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
    return { removed: 'all', kept: 0 };
  }
  return env.cleanupStaleTemp();
}

module.exports = {
  makeTempDir,
  makeTempDb,
  allocPort,
  startService,
  injectFailure,
  stall,
  cleanup
};
