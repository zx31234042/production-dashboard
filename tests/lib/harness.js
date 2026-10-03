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
   路径口径：临时区两个键（`tempRootBase`＝公共根、`tempRoot`＝**本轮专属**目录）的**定义处**
         是 `tests\env.js`（`T-20261003-10` 单一真源化）；本文件只**校验**它、不再写第二份。
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

/* 【`E90`（2026-10-03，★★★）临时区**按轮次隔离** —— 改任何临时路径前先读完这一段】
   旧版所有进程共用一个 `tests\._verify\tmp`，于是**任一路的 `cleanup(true)`**
   （＝ `rmSync(共享根, {recursive:true})`）会删掉**另一路正在用**的产物，实测两类假红：
     ① `harness-check` 里两条 `screenshot-diff` 判据读子进程日志**读回空串**（落点
        `harness-check.js:3972`）：另一路的 `cleanup(true)` 把本轮写进 `tmp\` 的日志删了；
     ② `harness-check` §五"`cleanup(true)` 真能清空临时区"因**他路**在 `tmp\` 下持有句柄
        ⇒ `rmSync` 中途 `EPERM`、被 `catch` 吞掉 ⇒ 断言报"残留目录仍在=true"。
   两个概念**显式分开**：
     · `tempRootBase` ＝ **公共根**（＝旧 `tempRoot` 的原意 `tests\._verify\tmp`）：
       只作为"各轮目录的父目录"与 24 小时过期清扫的对象；
     · `tempRoot`     ＝ **本轮专属**目录 `<base>\run-<pid>-<本地启动时刻>-<4 hex>`：
       本轮所有临时目录/临时库/子进程日志都落在它下面 ⇒ **任一路的 `cleanup` 只能删到
       自己的 `run-<pid>-…`，物理上删不到别人的** —— 这就是"并发不再互相删"的全部机制。
   向后兼容：`tempRoot` 的**名字与用法一字不变**（仍是"可写的临时区"），只是它现在指向本轮子目录。

   ⚠ **`T-20261003-10`（2026-10-03）单一真源化：这两个键的**定义**已经搬去 `tests\env.js`**
   （那里是"路径集"的定义处，且**任何**脚本 require 它都会算好 —— 包括**不加载本文件**的
   `files-check`／`platform-check`／`docs-check`）。本文件**不再注入式地写这两个键**，
   只做下面的**口径校验**（第二份定义会漂移：收口前"加载 harness 的脚本看到本轮目录、
   不加载的看到公共根"，正是这次要消掉的不一致）。
   ⚠ 推论（别踩）：**不加载本文件**的脚本若要看"临时区根目录"（如 `files-check` 的散落库判据），
   不能只看 `env.paths.tempRoot` —— 本轮目录可能是空的甚至不存在，那样判据会空洞化；
   必须同时看 `tempRootBase` 与各轮目录，理由写在 `tests\files-check.js` 第四节。 */
const tempRootBase = env.paths.tempRootBase;                   /* 只读别名，仅用于下面的校验 */

/** 校验"临时区两键"的语义（定义在 `tests\env.js`）：不满足就**当场抛错**并指名差在哪。
 *  为什么在这里校验而不是各调用点：`makeTempDir`/`cleanup` 全依赖这两个键，
 *  语义被改坏时若只是"路径算错"，症状会散落到各门禁的假红里（正是 `E90` 病灶的形态）；
 *  这里一次说清，且**不产生第二份定义**（下面一律**读** `env.paths.*`，绝不赋值）。 */
function assertTempRootSemantics() {
  const problems = [];
  const runRoot = env.paths.tempRoot;
  const expectedBase = path.join(env.paths.verify, 'tmp');
  if (!tempRootBase) {
    problems.push('`env.paths.tempRootBase` 未定义（定义处＝`tests\\env.js`）');
  } else if (path.resolve(tempRootBase) !== path.resolve(expectedBase)) {
    problems.push(`\`env.paths.tempRootBase\`=${tempRootBase} ≠ 公共根 \`tests\\._verify\\tmp\`=${expectedBase}`);
  }
  if (!runRoot) {
    problems.push('`env.paths.tempRoot` 未定义（定义处＝`tests\\env.js`）');
  } else if (tempRootBase) {
    if (path.resolve(path.dirname(runRoot)) !== path.resolve(tempRootBase)) {
      problems.push(`本轮 \`tempRoot\`=${runRoot} **不是**公共根的直接子目录（各轮必须平铺，否则清扫与隔离都不成立）`);
    }
    if (!/^run-\d+-\d{8}T\d{6}-[0-9a-f]{4}$/.test(path.basename(runRoot))) {
      problems.push(`本轮目录名 \`${path.basename(runRoot)}\` 不符合 \`run-<pid>-<yyyyMMddTHHmmss>-<4hex>\``);
    }
    if (!path.basename(runRoot).startsWith(`run-${process.pid}-`)) {
      problems.push(`本轮目录名 \`${path.basename(runRoot)}\` 的 pid 段 ≠ 本进程 pid ${process.pid}`);
    }
    if (path.resolve(runRoot) === path.resolve(tempRootBase)) {
      problems.push('`tempRoot` **等于**公共根 ⇒ 任一路的 `cleanup` 又能删到他路正在用的产物（E90 回归）');
    }
  }
  if (problems.length) {
    throw new Error('临时区语义校验未通过（定义处＝tests\\env.js）：\n  - ' + problems.join('\n  - '));
  }
}
assertTempRootSemantics();

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
        /* `E46`：本用例目录里可能被放进 junction（F4/F9 那类链接实验就在临时树里做）
           ⇒ 走安全删除（是链接只拆链、否则等价于原 `rmSync`）。 */
        removeLinkSafe(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
      } catch (e) {
        problems.push('rm: ' + e.code + ' ' + e.message);
        /* 逐个文件探测：定位到底哪个文件仍被占用（Windows 上常见于 -wal/-shm 未释放） */
        try {
          for (const n of fs.readdirSync(dir)) {
            try { fs.rmSync(path.join(dir, n), { force: true }); }
            catch (e2) { problems.push(`占用: ${n} → ${e2.code}`); }
          }
          removeLinkSafe(dir, { recursive: true, force: true });
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
      try { removeLinkSafe(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }   /* E46 安全删除 */
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

/* ==========================================================================
   `E46`（★★★）**链接安全删除** —— 改任何"删目录"的调用点前先读完这一段
   --------------------------------------------------------------------------
   立案（2026-09-28）：座位为 F4 越权实验在仓库里建了 `src\zz-* -> tests` 的 **junction**，
   第一版探针用 `fs.rmSync(link, { recursive: true, force: true })` 拆链。**纪律结论（保持）**：
   **拆链接只能用"非递归的 unlink/rmdir 语义"，任何"递归删除"工具一律不得作用在链接目录上。**

   ① **为什么 `rmSync(..., {recursive:true})` 可能**顺着链接**删到目标**
      本机（win32 / Node v24.21.0）实测：`fs.rmSync(<junction>, {recursive:true,force:true})` 的 **10 种写法
      都没有跟随**（含 `link\`、`link/`、全套 maxRetries/retryDelay、`rmdirSync(link,{recursive:true})`、
      把 junction 当 cwd 占住、给 junction 打只读属性），每次都只拆链、目标 3 个文件逐字节仍在
      （取证见 `tests\._verify\e46\probe-raw*.js`／`probe-danger.js` 的 `..out.json`）。
      **但"没跟随"是当前实现细节的巧合，不是保证** —— Node 自己的实现里就有两条**会跟随**的分支：
      `internal/fs/rimraf.js` 先 `lstat(path)`（链接 ⇒ 取 `unlink` 分支，安全），
      可一旦 `lstat` 或 `unlink` 报 **EPERM**（Windows 上杀软/ACL/被占用都可能），
      就落到 `fixWinEPERM()` —— 它 `chmod` 之后用的是 **`stat()`（跟随链接！）**，
      于是 `isDirectory()===true` ⇒ `_rmdir()` ⇒ 目录非空 ⇒ `_rmchildren()` ⇒ **`readdir(link)` 穿过 junction**
      逐个 `rimraf` ⇒ **目标目录内容被删**；`unlink` 报 `EISDIR` 时走的也是同一条 `_rmdir` 路。
      ⇒ 结论：**危险分支在源码里可达，只是"当前这台机器/这个错误路径"没被选中**；
      换 Node/libuv 版本、换 ACL/杀软状态就可能选中。故"别对链接用递归删除"是**纪律级**要求，
      不能靠"实测没炸"来豁免。
      另外**真的会跟随**的两件事（实测复现）：`robocopy <空目录> <junction> /MIR` ⇒ 目标 3 文件 → **0**
      （X4）；`fs.readdirSync(<link>, {recursive:true})` ⇒ 直接列出目标内的条目（T5）。
      全仓 **零** `robocopy` 调用、**零** `readdirSync(..., {recursive:true})` 调用 —— 继续保持。

   ② **为什么 `lstatSync` 不跟、`statSync` 跟**
      `lstat` ＝ "link status"：它返回**目录项自身**的信息。Windows 上 junction/符号链接是 reparse point，
      `lstatSync(link)` 实测给出 `isSymbolicLink()===true`、`isDirectory()===false`（`statSync(link)` 则相反：
      `isDirectory()===true`）⇒ **用 `lstatSync` 判"是不是链接"这个动作本身不会触碰目标**，
      这就是本文件 `countEntriesDeep`（上面）与 `tests\harness-check.js` 同名工具的既有正确做法。
      推论：**凡"要进入某个目录"的遍历，都该用 `lstatSync`（或 `readdirSync(…,{withFileTypes:true})`
      后判 `isDirectory()`，因为 dirent 对 junction 报 `isSymbolicLink()===true`）；
      只有确实要"穿透链接读目标"时才用 `statSync`。**（反例：`tests\ui-check.js:5273` 用 `statSync().isDirectory()`
      递归扫描 `src\` ⇒ 会跟随链接出圈。）

   ③ **为什么 `rmdirSync(link)` 只拆链**
      `fs.rmdirSync(link)` 在 Windows 上落到 `RemoveDirectoryW`，删的是**那个目录项（reparse point）本身**，
      不进入目标；**非递归** ⇒ 目录非空也不遍历 ⇒ 目标一条不动（实测 `rmdirSync` 成功、目标 3/3 不变）。
      它与 `cmd /c rmdir <link>` 是**同一个内核动作**，所以既满足 `E46` 的纪律，又不必起子进程
      （省掉管道/编码那一族风险，参见 `E40`）。`fs.unlinkSync(link)` 在新 libuv 上对 junction 也成功
      （`DeleteFileW` 失败后回退 `RemoveDirectoryW`），故作为**兜底**：两法都非递归，
      物理上都没有"进入目标"的能力。
   ========================================================================== */

/** 路径**自身**是不是链接（Windows junction／符号链接）——用 `lstatSync`，绝不跟随（见上面 ②）。
 *  @param {string} target @returns {boolean} */
function isLink(target) {
  try { return fs.lstatSync(target).isSymbolicLink(); }
  catch { return false; }                                        /* 不存在/读不到 ⇒ 不是链接 */
}

/**
 * **安全删除**"可能是链接"的路径（`E46`）：先 `lstatSync` 判链接 ——
 *   · **是链接** ⇒ **只拆链、绝不递归**（`rmdirSync` 优先、`unlinkSync` 兜底）；
 *   · 不是链接 ⇒ 目录且 `recursive` ⇒ 才允许 `rmSync(…, {recursive:true})`；非目录 ⇒ unlink 语义。
 * 与 `rmSync` 的差别**只在链接这一支**：其余分支行为与原来逐字一致（含 `force`／`maxRetries`／`retryDelay`），
 * 故替换现有调用点不改变正常路径的读数（`E90` 的五条不变量判据照样成立）。
 * ⚠ **残余面（据实登记）**：`recursive` 这一支内部仍用 `rmSync` —— 它删的是**真实目录**，
 *   但若那个目录**里面**还有一个链接，理论上仍会落到 ① 里的危险分支。本机实测：`rmSync` 与
 *   `Remove-Item -Recurse` 都不穿（D2/X5/X6），**只有 `robocopy /MIR` 穿**（X7：目标 2 文件 → 0）；
 *   需要连"目录内部的链接"一起防时，调用点必须先按 `lstatSync` 把内部链接逐个拆掉
 *   （`countEntriesDeep` 就是这种 lstat 遍历），或改用只走 lstat 的删除实现。
 * @param {string} target
 * @param {{recursive?:boolean, force?:boolean, maxRetries?:number, retryDelay?:number}} [options]
 *        `recursive` 默认 `true`（＝原 `rmSync` 语义）；`force` 默认 `true`（路径已不存在时**不抛**）
 * @returns {{kind:'link'|'dir'|'file'|'missing', removed:boolean, via:string, target:string}}
 * @throws 非 `force` 的 `ENOENT`；以及"拆链两法都失败"（错误里同时带两个 errno，便于定位）
 */
function removeLinkSafe(target, options = {}) {
  const recursive = options.recursive !== false;
  const force = options.force !== false;
  const maxRetries = options.maxRetries === undefined ? 0 : options.maxRetries;
  const retryDelay = options.retryDelay === undefined ? 0 : options.retryDelay;

  let st;
  try {
    st = fs.lstatSync(target);                                   /* ← 只取"目录项自身"，不跟随（②） */
  } catch (err) {
    if (force && err.code === 'ENOENT') return { kind: 'missing', removed: false, via: 'none', target };
    throw err;
  }

  if (st.isSymbolicLink()) {                                     /* ← 链接：只拆链（①③） */
    try {
      fs.rmdirSync(target);                                      /* RemoveDirectoryW：删目录项本身 */
      return { kind: 'link', removed: true, via: 'rmdirSync', target };
    } catch (e1) {
      try {
        fs.unlinkSync(target);                                   /* 兜底（文件型符号链接等） */
        return { kind: 'link', removed: true, via: 'unlinkSync', target, rmdirError: e1.code };
      } catch (e2) {
        if (force && (e2.code === 'ENOENT' || e1.code === 'ENOENT')) {
          return { kind: 'missing', removed: false, via: 'none', target };
        }
        const err = new Error(`拆链失败（rmdirSync=${e1.code || e1.message}／unlinkSync=${e2.code || e2.message}）：${target}`);
        err.code = e2.code; err.rmdirCode = e1.code;
        throw err;
      }
    }
  }

  if (st.isDirectory()) {                                        /* 真实目录：原语义 */
    if (!recursive) { fs.rmdirSync(target); return { kind: 'dir', removed: true, via: 'rmdirSync', target }; }
    fs.rmSync(target, { recursive: true, force, maxRetries, retryDelay });
    return { kind: 'dir', removed: true, via: 'rmSync', target };
  }

  fs.rmSync(target, { force });                                  /* 普通文件：unlink 语义 */
  return { kind: 'file', removed: true, via: 'rmSync', target };
}

/**
 * 清理测试临时区。
 *
 * `force=false`（日常收尾，`run-all` 全绿时调用）：只清**公共根**下超过 24 小时的
 *   **整轮目录**（`run-<pid>-…`）—— 本轮目录刚建、mtime 是新的，故自己与别人的这一清理都
 *   命不中它；返回 `{removed, kept}`（**条数**，与旧口径一致，`harness-check` §五按其类型判）。
 *   **公共根口径不写第二份**：清扫策略与目标都在 `tests\env.js` 的 `cleanupStaleTemp()` 里
 *   （`T-20261003-10` 收口后它**就是**清公共根，不再需要"临时把 `tempRoot` 指回公共根"那种
 *   改写单源对象的做法 —— 那既容易被别处观察到，也是"同一份数据两处口径"的温床）。
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
  if (!force) return env.cleanupStaleTemp();                   /* 目标＝公共根，定义在 env.js */
  const target = env.paths.tempRoot;
  const beforeDeep = countEntriesDeep(target);
  const errors = [];
  try {
    /* `E46`：本轮目录**自身**若被人换成了链接（或别人在它里面留了链接），"递归删"就必须让位给
       "只拆链" —— 辅助里那一步 `lstatSync` 就是判据；非链接时行为与原来逐字一致。 */
    removeLinkSafe(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
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
  removeLinkSafe,          /* `E46`：对"可能是 junction/symlink"的路径做安全删除（是链接只拆链） */
  isLink,                  /* `E46`：`lstatSync` 判链接（不跟随）—— 判据与辅助共用同一口径 */
  cleanup
};
