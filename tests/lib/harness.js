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
           ⇒ 走安全删除（是链接只拆链、否则等价于原 `rmSync`）。定义已按 `T-20261003-14`
           搬到 `tests\env.js`（单一真源）⇒ 这里从 `env` 取，取到的是同一个函数对象。 */
        env.removeLinkSafe(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
      } catch (e) {
        problems.push('rm: ' + e.code + ' ' + e.message);
        /* 逐个文件探测：定位到底哪个文件仍被占用（Windows 上常见于 -wal/-shm 未释放） */
        try {
          for (const n of fs.readdirSync(dir)) {
            try { fs.rmSync(path.join(dir, n), { force: true }); }
            catch (e2) { problems.push(`占用: ${n} → ${e2.code}`); }
          }
          env.removeLinkSafe(dir, { recursive: true, force: true });
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
      try { env.removeLinkSafe(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }   /* E46 安全删除 */
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
   `E46`（★★★）**链接安全删除** —— 改任何"删目录"的调用点前先读完 `tests\env.js` 的那一段
   --------------------------------------------------------------------------
   `T-20261003-14`（2026-10-03）**定义搬家**：`isLink()`／`removeLinkSafe()` 的**定义**（连同
   上面那一整段 `E46` 立案/实测/纪律说明）已经搬到 **`tests\env.js`** —— 因为 `env.js` 的
   `cleanupStaleTemp()`（`E101`）自己要用它们，而 `env.js` **绝不能**反向 require 本文件
   （`harness.js` 顶层 `require('../env')` ⇒ 会成环：谁先进谁拿到半成品）。
   ⇒ 依赖方向永远只有 `lib\harness.js → env.js` 一条单箭头；定义**只有一份**。
   本文件下面的 `isLink`／`removeLinkSafe` 是**再导出**（`E46` 那批调用点仍然从 `harness` 取，
   取到的是**同一个函数对象** ⇒ 行为一字不变，只是定义搬了家）；文件内部一律走 `env.*` 调用。
   **纪律结论（保持）**：**拆链接只能用"非递归的 unlink/rmdir 语义"，任何"递归删除"工具
   一律不得作用在链接目录上** —— 理由（危险分支可达、`statSync` 跟随／`lstatSync` 不跟、
   `rmdirSync(link)` 只拆链）与全部实测取证见 `tests\env.js` 顶部那一段。 */
const isLink = env.isLink;                                     /* E46：lstatSync 判链接（不跟随） */
const removeLinkSafe = env.removeLinkSafe;                     /* E46：是链接只拆链，否则等价 rmSync */

/**
 * 清理测试临时区。
 *
 * `force=false`（日常收尾，`run-all` 全绿时调用）：只清**公共根**下超过 24 小时的
 *   **整轮目录**（`run-<pid>-…`）—— 本轮目录刚建、mtime 是新的，故自己与别人的这一清理都
 *   命不中它；返回 `{removed, kept, removedLedgers}`（`removed`/`kept` 是**条数**，与旧口径一致，
 *   `harness-check` §五按其类型判）。`T-20261003-14`（`E105`）起，**同一份 24h 口径**也回收
 *   `tests\._verify\` 根下过期的**子集轮账本** `run-totals.subset-*.json`，计入 `removedLedgers`
 *   （**主账本 `run-totals.json` 是 `docs-cross-check` 的取数面，永不被这条清扫碰到**）。
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
    env.removeLinkSafe(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
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

/* ==========================================================================
   **探针纪律：注入层次 ＋ 还原三重（`E97`，本仓探针/变异取证必读）**
   `T-20261004-01`（2026-10-04，4b／座位 4·10）把 `E97` 的两条立案事实写进测试基建的**抬头**。
   `E97` 的代价是"**假绿/假红**"：前者让你以为验过了、其实验的是旧对象；后者把变异留进工作区、
   污染别人的门禁。两条都不是"小心一点"能防住的，必须照抄下面的做法。
   --------------------------------------------------------------------------
   ① **顶层 `require` 是按值绑定 —— 改文件、删 `require.cache` 都不生效**
      形如 `const maintain = require('./db/maintain')` 的绑定在**模块加载时**就完成。之后：
        · 改磁盘上的真文件 → **无效**（模块对象早在内存里了）；
        · "改文件 ＋ 删 `require.cache` 里那一项" → **同样无效**：本仓被 require 的模块常常在
          `start()` 走完时缓存里**根本没有那个键**（首次 require 的旧对象已经握在调用方手里）。
      ⇒ **要真注入，必须"改真文件字节"的同时，把模块对象的属性换掉**（`mod.fn = 注入实现`），
        并在 `finally` 里把属性**还原成原件引用**。先例＝`harness-check` §15 换
        `resultRepo.upsertJudgement`、§17 换 `warningRepo` 的导出 —— 同一族的正确姿势。
      ⚠ 只用"改文件"的那种探针会得到两种错误结论：**假绿**（被测代码用的还是旧实现）或
        **假红**（改的文件被别的模块提前 require 走了，注入的只有一半）。
      ⚠ 另一种**可接受**的注入形态（本仓已有先例、主代理已裁定）：**内存字节副本** ——
        用 `Module._compile` 在内存里编译一份变异体并直接调用它（盘上文件全程不动）。
        要求：变异体 sha256 ≠ 原件 sha256、且原件**全程逐字节未变**（两端读数）。
   --------------------------------------------------------------------------
   ② **还原纪律：一律"字节副本 ＋ `Buffer.compare` ＋ SHA-256"，禁用版本控制命令还原**
      开工时 `const bytes0 = fs.readFileSync(f)`（原件全程**只读**），结束（放 `finally`）时：
        · 把 `bytes0` 写回 ⇒ 用 `Buffer.compare(fs.readFileSync(f), bytes0) === 0` **证明**还原；
        · 再留一对 sha256（改前／还原后）作留痕；
        · 若注入是"按行插入"，另留一层"**按行剔除**"兜底（`finally` 里不得引用 `try` 内声明的
          变量 —— 曾有探针因 `ReferenceError` 把变异**带着**跑完全程，见 `E97` 立案事实②）。
      ⛔ **禁用** `git checkout` ／ `git restore` ／ `git stash` 还原变异：它们是**合法 git 操作**、
        门禁抓不到，且会把"未跟踪的取证产物/别人的在制改动"一起冲掉（本仓历史上真发生过一次，
        结果虽等价但**方法不合规**）。
      · 该禁用的**静态守护**＝`harness-check` §五 的 `E103-丙①/②/③`（剥注释、**保留字符串**扫
        "调用形态"；否定句与引文不误伤；受管面零容忍、`._verify\` 面按已登记残留逐条判定）。
      · 本文件的 `removeLinkSafe()`／`isLink()`（`E46`）是**删除**侧的同一族纪律：
        拆链接只许非递归语义，任何"递归删除"工具不得作用在链接目录上。
   ========================================================================== */

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
