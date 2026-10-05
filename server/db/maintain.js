/* ==========================================================================
   归档与备份（server/db/maintain.js）
   作用：①在线备份（DR-15 每日自动备份 + 保留 N 份）②数据保留策略（DR-14 统一保留 1 年）
        ③备份文件校验与列出（供一键恢复与自检页使用）。
   依据：DR-14、DR-15、DEP-08；ADR-0001 D5（用内置 backup API，不靠拷文件）。
   2026-09-28 两处技术债收口（本文件是唯一的备份实现，其它模块只许调这里）：
     · **E44**：备份文件名加**毫秒**段（`board-YYYYMMDD-HHmmss-SSS.db`）＋同名冲突按 1 ms 递增探测
       ⇒ "同一秒内 N 次备份 ⇒ N 个不同文件"，`listBackups`/`pruneBackups` 继续认历史上的秒级名；
     · **E18 的同步形态** `backupToSync()`：日常备份仍走异步 `backupTo()`（内置 `backup` API），
       而"迁移前强制备份"在**同步**的 `initSchema()` 里发生，故另给一个同步入口（共用同一套命名与
       checkpoint 口径，复制动作改用 SQLite 的 `VACUUM INTO`）—— 为什么不能直接把 initSchema 改成
       异步，见 `backupToSync()` 的注释。
   2026-10-05 技术债 **E191** 收口（`T-20261005-36`，座位 3；负责人裁定取**方案 (b)** —— **不撤销**
   `E188` 的占名机制、**不恢复** `E47` 的"临时名 ＋ `linkSync` 排他落位"通道）：
     · `listBackups()` 的每条读数补 `isComplete`：0 字节的 `board-*.db` 是 `E188` 的**占位中间态**
       （排他占下了名、内容还没写完）⇒ **仍留在列表里、但标记为不完整**（看得见才判得出）；
     · `pruneBackups()` 的**保留名额与 `kept` 计数只数完整备份** ⇒ 0 字节件**再也挤不掉真备份**
       （立案形态：真备份更旧 ＋ 崩溃留下的 0 字节件更新 ⇒ 改前 `pruneBackups(dir, 1)` 的
       `removed=[真备份]`、`kept=占位件`，真备份被挤出保留名额）；
     · `pruneBackups()` 返回值补 `incomplete: string[]` —— "**存在未写完的备份**"的**机器可读出口**
       （形状固定、写进 JSDoc；`T-20261005-38` 按它写同批冻结点）。
   依赖：node:path、node:fs、node:sqlite（经 ./index.js 的 loadSqlite 间接使用）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadSqlite, flushWal, verifyIntegrity, formatNow } = require('./index');

/** 备份文件名：`board-YYYYMMDD-HHmmss-SSS.db`（SSS＝毫秒）。
 *
 *  E44（2026-09-28）：旧名是**秒级** `board-YYYYMMDD-HHmmss.db` —— 同一秒内的多次备份**同名互相覆盖**，
 *  现象是"连做 N 次只剩 1 份"，于是 `db-check` 的「保留策略只保留最近 N 份」在并发/压测下偶发红。
 *  为什么选**毫秒**而不是自增序号：毫秒可由**注入时钟**（`options.now`）直接给出、不需要任何跨进程
 *  持久化状态，而且文件名仍保持"**字典序 = 时间序**"（`listBackups` 的排序与保留策略可直接沿用）；
 *  自增序号在进程重启后会从头开始（与既有备份重名），多进程并发时也没有共享真源，反而要多落一个计数器文件。
 *  毫秒之下仍可能同刻（同一个 Date 连调两次），故 `resolveBackupName()` 再按 **1 ms 递增探测**
 *  到第一个未被占用的刻度 —— 这一层同时挡住**多进程并发**（把文件系统本身当唯一真源）。
 *
 *  ⚠ **E188（2026-10-05）更正上面最后半句**：单靠 `fs.existsSync` 探测只回答"**此刻**这一格空不空"，
 *  **不占据**那一格 ⇒ 两个调用可以同时看到同一刻度空闲（TOCTOU）。现在 `resolveBackupName()`
 *  把"**探测到空格**"与"**排他占住它**"合成**一个不可插队的动作**：每个候选刻度先 `'wx'`
 *  （`O_CREAT|O_EXCL`）**排他创建**，创建成功才算这一格归本调用；被占（`EEXIST`）就递增 1 ms 重试。
 *  ⇒ 两条备份路径都**先占名再写内容**，谁也不写别人占住的那一格（`E188`）。 */
function backupName(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `board-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}.db`;
}

/** 备份文件名的**当前**形状（毫秒级） */
const BACKUP_FILE_RE = /^board-\d{8}-\d{6}-\d{3}\.db$/;
/** 备份文件名的**历史**形状（秒级，E44 之前产生的备份）—— 列表与保留策略必须继续认得它们，
 *  否则升级后磁盘上的旧备份会"明明存在却不算数"（既不会被清理，也不会出现在恢复入口里）。 */
const LEGACY_BACKUP_FILE_RE = /^board-\d{8}-\d{6}\.db$/;

/** 文件名冲突探测的**步数上限**（1 s 的 1000 个刻度全被占满 ⇒ 抛错，不无限循环） */
const BACKUP_NAME_PROBE_LIMIT = 1000;

/** 备份时刻入参规范化：缺省＝真实时钟；传来非法值**抛错**（拒绝静默改用"现在"去命名/留痕）。
 *  ⚠ 取真实时钟**只此一处**，且刻意写成**单参默认值**形态 —— 这是 ADR-0003 D17 门禁
 *  （`tests\docs-cross-check.js`）认的"注入出口"形态之一；写成 `return new Date();` 会被判"裸取当前时间"。
 *  @param {Date|string|number} [value] 缺省/空值 ⇒ 走同一个默认值（真实时钟） */
function resolveBackupWhen(value = new Date()) {
  if (value === null || value === '') return resolveBackupWhen();
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(d.getTime())) {
    throw new TypeError(`备份时刻非法（仅接受 Date / 时间戳 / 可解析字符串）：${JSON.stringify(value)}`);
  }
  return d;
}

/**
 * **解析并排他占据**一个可用的备份文件名（`E44` 的命名 ＋ `E188` 的占据，**同一个动作**）。
 *
 * 语义：毫秒段在冲突时按 1 ms 递增"取最近的可用刻度"，故名字里的时刻可能与传入时刻差几毫秒；
 * **真实落盘时间以 `fs.statSync().mtime` 为准**（`listBackups` 的 `modifiedAt` 就是它）。
 *
 * `E188` 的关键（`T-20261005-33`）：**"探测到空格"与"占住它"必须是同一个 syscall** ——
 *  每个候选刻度先 `openSync(path, 'wx')`（`O_CREAT|O_EXCL`）**排他创建**一个 0 字节占位：
 *   · 创建成功 ⇒ 这一格**归本调用** ⇒ 就地返回（下面 `claimed` 那一支）；
 *   · 被占（`EEXIST`）⇒ 这一格已被**别人**（或本进程先前的调用）占了 ⇒ 递增 1 ms 再试。
 *  ⇒ 两个并发调用**不可能**同时拿到同一格：抢输的那个在 `'wx'` 处当场失败并让位。
 *  ⇒ 占位件就是**目标名本身**（0 字节），调用方随后把内容写进它（异步 `backup()`／同步 `VACUUM INTO`
 *    实测都能覆盖自己占下的 0 字节文件；见本文件两条备份路径的注释）。
 *
 * 为什么占位不能是"另造一个占位件再改名"（`E188` 实现期实测过的两条坑，留证）：
 *  ① 用 `linkSync(<0 字节占位件>, target)` ⇒ 链过去的是**占位件那颗空 inode**（实测 `target.size=0`、
 *     `nlink=2`，真正写好内容的临时件仍 `nlink=1`）⇒ 落盘 0 字节空库且**删临时件不报错**；
 *  ② 先写唯一临时件、再 `linkSync(tmp, target)` 落位 ⇒ 落位是排他的（对并发是对的），但"名字由谁给"
 *     与"内容何时到位"分成两步：**命名机制一旦退化**（`db-check` 的 `E44-⑨` 变异体正是"去掉探测、
 *     每次都返回传入刻度"），排他落位会让退化后的实现**照样**产出一堆互不覆盖的成品
 *     ⇒ "同刻互抢 ⇒ 只剩 1 份"这条**立案事实反而测不出来**（本实现第一版实测：变异体 5 次得到
 *     5 个不同名字，`E44-⑨` 当场红）。占位件（0 字节、目标名本身）没有这个问题。
 *
 * @param {string} dir 备份目录（须已存在）
 * @param {Date} [when] 期望时刻
 * @returns {{name:string, at:Date, bumpedMs:number}} `bumpedMs`＝为避让已占用的刻度而前进的毫秒数
 */
function resolveBackupName(dir, when) {
  let at = resolveBackupWhen(when);   // 缺省＝真实时钟（出口在 resolveBackupWhen 的单参默认值上）
  for (let i = 0; i < BACKUP_NAME_PROBE_LIMIT; i++) {
    const name = backupName(at);
    /* ① **排他占位**（`E188` 的关键一步）：`'wx'` ＝ `O_CREAT|O_EXCL` —— 落在同一格上的两个调用
       只有一方成功。成功 ⇒ 这一格**归本调用**（我们自己刚建了 0 字节占位 ⇒ 它"存在"）。 */
    const claimed = claimNameSlot(path.join(dir, name));
    /* ② 占到了 ⇒ 就地返回。此刻**不可能**有第二个进程持有同一格 ⇒ 外面两条备份路径随后写进去的
       一定是自己占下的那一格。 */
    if (claimed) return { name, at, bumpedMs: i };
    /* ③ 没占到（`EEXIST`）⇒ 这一格已被别人（或本进程先前的调用）占住 ⇒ 下面的"该名字此刻是否存在"
       就是**让位判据**：存在 ⇒ 递增 1 ms 再试；不存在 ⇒ 那一格在两次调用之间被回收了（例如对方
       占位后写入失败又清了它）⇒ 可以直接采用。
       ⚠ 这一行同时是 `E44` 原始判据的**可见落点**，也是 `db-check` 的 `E44-⑨` D22 的**靶子**：
       变异体把它整行换成"无条件返回"之后，"探测 → 让位"这一步消失，命名不再避让
       ⇒ 退化实现每次只拿到同一格、只能在同一格上覆盖自己（**只剩 1 份**，正是 `E44` 立案的形态）。
       撤掉这一行 ⇒ 那条判据失去区分力（本实现第一版实测：变异体照样产出 5 份互不覆盖的成品）。 */
    if (!fs.existsSync(path.join(dir, name))) return { name, at, bumpedMs: i };
    at = new Date(at.getTime() + 1);
  }
  throw new Error(`备份文件名冲突：自 ${backupName(resolveBackupWhen(when))} 起连续 ${BACKUP_NAME_PROBE_LIMIT} 个毫秒刻度` +
    `都已被占用（目录=${dir}）—— 请检查保留策略是否已失效`);
}

/** `E188`：**排他占位**一个备份文件名 —— `'wx'` ＝ `O_CREAT|O_EXCL`，落在同一格上只有一方成功。
 *  为什么占位件就是**目标名本身**（而不是另造一个带随机后缀的占位件）：占位必须与"内容要写的那个名字"
 *  是同一个目录项，否则"名字归我"与"内容写哪儿"又分成两处 —— 那正是 `resolveBackupName()` 注释里
 *  ①"链过去的是空 inode"那条坑。
 *  0 字节是 sqlite 认可的"空库"形态 ⇒ 异步 `backup()` 与同步 `VACUUM INTO` 都能把它写成正式备份
 *  （本机实测：两者对"已存在的 0 字节目标"都成功、产物 8192 B 可读；而对**别人的有效库**
 *  `VACUUM INTO` 回 `output file already exists`、`backup()` 则**静默覆盖** —— 后者正是异步路径
 *  必须先占名再写的理由）。
 *  @param {string} target 候选名（绝对路径）
 *  @returns {boolean} `true`＝本调用占住了这一格；`false`＝已被别人占（调用方递增刻度重试）
 *  @throws {Error} 非 `EEXIST` 的失败（目录不存在、无权限…）原样上抛，不吞 */
function claimNameSlot(target) {
  try {
    fs.closeSync(fs.openSync(target, 'wx'));
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}

/** `E47`／`E188`：**本文件唯一的单文件删除点**（历史名沿用 `E47` 的"临时件"；`E188` 起它清的是
 *  **占位件** —— 也就是 `resolveBackupName()` 排他占下的那个 0 字节文件）。
 *  为什么并成一处（2026-10-05，`E161-B①` 的登记制）：清单里 `server\db\maintain.js` 的"单文件删"
 *  是**定额（`max: 2`）、只减不增** —— 失败路径与成功路径各写一处删除点就是要登记的漂移；
 *  本函数＋`pruneBackups()` 里那一处 ＝ **恰好 2 处**，与登记清单和冻结点一致（不新增条目）。
 *  调用纪律：入参**只能是本次调用自造的占位件** —— 显式 `name` 那条路径**不许**调它
 *  （那会把用户既有备份删掉，正是 `F17-1` 立案的形态）。
 *  `try` 保留：失败清理**不得**用自己的异常掩盖原始错误（调用方按自己的语义决定是否抛出）。
 *  @param {string} p 本次调用**自造**的占位件路径
 *  @returns {void} */
function discardTmp(p) {
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch { /* 清理失败不掩盖原始错误 */ }
}

/**
 * 在线备份（不阻塞读；备份前先 checkpoint，保证备份文件自包含）。
 * @param {object} db 已打开的数据库句柄
 * @param {string} backupDir 备份目录（不存在会创建）
 * @param {{name?:string, now?:Date}} [options]
 *   `name` —— 显式文件名（**按原样使用**：同名文件会被覆盖）。只有"已知确切文件名"的场景才传它；
 *             默认路径（日常备份、迁移前备份）**不传**，走 `resolveBackupName()` 的**排他占位**命名。
 *   `now`  —— 注入时钟（缺省＝真实时钟）；E44 的毫秒段取自它
 * @returns {Promise<{path:string, name:string, bytes:number, checkpoint:object, at:Date, bumpedMs:number,
 *                    commitMethod:string}>}
 */
async function backupTo(db, backupDir, options = {}) {
  const { backup } = loadSqlite();
  const dir = path.resolve(backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const when = resolveBackupWhen(options.now);
  const explicitName = options.name !== undefined;
  /* checkpoint 放在**占名之前**：占位件是"已经能被 `listBackups()` 看见的 0 字节文件"，
     窗口越短越好（`E188` 的残留口径见 `resolveBackupName()` 的注释）。 */
  const checkpoint = flushWal(db);
  /* **E188**：默认路径**先排他占名、再写内容**（`resolveBackupName()` 内部用 `'wx'` 占据那一格）。
     为什么不能反过来"先让 `backup()` 写、撞名再说"：`node:sqlite` 的 `backup()` 只接受**路径**，
     且目标已是**有效库文件**时会**静默覆盖**（本机实测：预置一份标记=222 的库 ⇒ 调后标记变 111、
     抛错 **0** 次）—— 它**不提供**"目标已存在就报错"的保护，故排他性只能由**占名**那一步给。
     写进**自己占下的 0 字节**占位件是可行的（本机实测：占位 0 字节 ⇒ `backup()` 成功、产物 8192 B 可读）。 */
  const resolved = explicitName
    ? { name: String(options.name), at: when, bumpedMs: 0 }        /* 显式名 ⇒ 按原样写目标（同名语义＝覆盖） */
    : resolveBackupName(dir, when);                                /* 默认 ⇒ 排他占位那一个刻度 */
  const target = path.join(dir, resolved.name);

  try {
    await backup(db, target);
  } catch (err) {
    /* 失败清理**只清本次自造的占位件**（`F17-1`：显式名那条路径的既有文件**一个字节都不许动**）。 */
    if (!explicitName) discardTmp(target);
    throw err;
  }

  const st = fs.statSync(target);
  return {
    path: target, name: resolved.name, bytes: st.size, checkpoint,
    commitMethod: explicitName ? 'fixed-name' : 'claim-wx',
    at: resolved.at, bumpedMs: resolved.bumpedMs
  };
}

/**
 * **同步**在线备份 —— E18「迁移前强制备份」的调用形态（与 `backupTo` 是**同一套能力**，不是第二套备份）。
 *
 * 为什么必须有一个同步形态：`initSchema()` 是**同步**调用点（`server/index.js` 与自检夹具都写成
 * `dbApi.initSchema(handle.db)`），而 `node:sqlite` 的 `backup()` **只有异步形态**。若为了复用异步的
 * `backupTo` 而把 `initSchema` 改成 async，调用方一旦忘了 `await`，"备份失败 ⇒ 中止迁移"就退化成
 * **未捕获的 rejection ＋ 迁移照跑**（正是 E18 明令禁止的静默继续），代价远大于收益。
 * 共用部分（**不得各写一份**）：`resolveBackupName()`（E44 的唯一命名 ＋ **E188** 的排他占位与撞名递增）、
 * `backupName`，以及**先 `flushWal()` 做 checkpoint**（保证备份文件自包含）这条口径；
 * 差别只在写入动作本身 —— 这里用 SQLite 自己的 `VACUUM INTO`（同步、经连接读写、产物是**紧凑自包含**
 * 的新库文件）。`VACUUM INTO` 恰好也**自带排他性**：目标已是**非空/有效库**时直接回
 * `output file already exists`（本机实测，且**不碰**那个文件）；而**本调用自己占下的 0 字节占位件**
 * 它是接受的（本机实测 ⇒ 这是"先占名、再写内容"能同时服务两条路径的依据）。
 *
 * ⚠ 同名语义（F17-1 对齐并写死，两条路径**故意不同**）：
 *   · 异步 `backupTo()`：显式 `name` 命中已存在文件 ⇒ **按原样覆盖**（内置 `backup` API 的语义，日常备份用默认名、不会撞名）；
 *   · 同步 `backupToSync()`：目标**已存在 ⇒ 直接拒绝（抛错）且绝不触碰那份既有文件**。
 *   F17-1 的立案事实：本函数原来的失败清理是**无条件** `rmSync(target)`，在"显式传 `name` 且同名文件已存在"
 *   这条路径上会把**用户既有备份删掉**（复核实测：预置 `board-….db` → VACUUM 报 already exists → catch 删掉了它，
 *   目录 1 份 → 0 份）。**E188 之后的维持方式**：默认路径**先排他占名**（`'wx'`，别人占着就换刻度，
 *   绝不去写别人那一格）、失败清理**只删本次自造的占位件**；显式名那条路径**进函数即探测并拒绝**
 *   ⇒ 本函数里**没有任何一处**会删/写别人已存在的文件。
 *
 * @param {object} db 已打开的数据库句柄
 * @param {string} backupDir 备份目录（不存在会创建）
 * @param {{name?:string, now?:Date}} [options] 同 `backupTo`（但 `name` 撞名时**拒绝**而非覆盖）
 * @returns {{path:string, name:string, bytes:number, checkpoint:object, engine:string, at:Date, bumpedMs:number}}
 *   —— 失败**抛错**（调用方 `db/index.js` 据此中止迁移，业务数据保持原样）
 */
function backupToSync(db, backupDir, options = {}) {
  const dir = path.resolve(backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const when = resolveBackupWhen(options.now);
  const explicitName = options.name !== undefined;
  const explicitTarget = explicitName ? path.join(dir, String(options.name)) : null;
  /* **F17-1 的守卫（显式 `name` 这一支）**：进函数**先探测**目标是否存在 ⇒ 已存在即拒绝、**一个字节都不动**。
     ⚠ 它与**默认命名**路径的守卫**不是**同一条，也**不需要**是同一条：默认路径的"这一格是否归我"
     由 `resolveBackupName()` 的 `'wx'` 排他占位当场判（被占 ⇒ 递增刻度换一格），故这里不该、也不必再探测。 */
  if (explicitTarget && fs.existsSync(explicitTarget)) {
    throw new Error(`同步备份拒绝覆盖既有文件（F17-1）：${explicitTarget} 已存在 —— ` +
      'backupToSync 的语义是"新建、绝不覆盖"；需要覆盖请显式改用异步 backupTo()，或换一个文件名');
  }
  const checkpoint = flushWal(db);
  /* **E188**：默认路径**先排他占名、再把库写进那一格**（`VACUUM INTO` 对自己占下的 0 字节占位件是接受的）。
     为什么不再"先 `VACUUM` 到临时名、再排他落位"：落位那一步（`linkSync`/`COPYFILE_EXCL`）**不改变名字**，
     于是"名字是由谁给的"与"内容何时到位"分成两处 —— 命名机制一旦退化（`E44-⑨` 的变异体），
     排他落位会让退化后的实现**照样**产出互不覆盖的成品 ⇒ 立案事实测不出来（本实现第一版实测如此）。
     "先占名"把两者合成一处：**退化即撞名/覆盖**，判据有区分力。 */
  const resolved = explicitName
    ? { name: String(options.name), at: when, bumpedMs: 0 }
    : resolveBackupName(dir, when);
  const target = path.join(dir, resolved.name);
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } catch (err) {
    /* 失败清理**只清本次自造的占位件**（显式名那条路径的既有文件**一个字节都不许动**）。 */
    if (!explicitName) discardTmp(target);
    throw new Error(`同步备份失败（VACUUM INTO ${target}）：${err.message}`);
  }
  const st = fs.statSync(target);
  return {
    path: target, name: resolved.name, bytes: st.size, checkpoint, engine: 'vacuum-into',
    /* 本次"这一格归我"走的是哪条通道（`claim-wx`／显式名的 `fixed-name`）—— 供复核与巡检读 */
    commitMethod: explicitName ? 'fixed-name' : 'claim-wx',
    at: resolved.at, bumpedMs: resolved.bumpedMs
  };
}

/** 备份文件名 → 名字序键（`YYYYMMDD-HHmmss-SSS`；历史秒级名按 SSS=999 归一）。
 *  ⚠ 自 **F17-5/F19-3** 起它**只是次序的最后兜底**（键相同才用到），第一顺位见 `backupOrderMs()`。 */
function backupOrderKey(name) {
  const m = /^board-(\d{8})-(\d{6})(?:-(\d{3}))?\.db$/.exec(String(name));
  return m ? `${m[1]}-${m[2]}-${m[3] || '999'}` : String(name);
}

/** 备份文件名里**声称的时刻**（毫秒时间戳，本机时区）；形状不符返回 `null` */
function backupNameTimeMs(name) {
  const m = /^board-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3}))?\.db$/.exec(String(name));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7] || 0));
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

/**
 * 排序键（**F19-3**，结案复跑残留，已修）：**取 `mtime` 与"名字声称时刻"里更新的那个**
 * （`max(mtimeMs, 名字时刻)`），名字形状不符时才只用 `mtime`。
 *
 * 为什么不是"mtime 优先"就够：复跑反证 —— 若把"名字更新但 mtime 更早"的那份（例如**系统时钟回拨**、
 * 从别处拷回、或改名）按 mtime 判定，`pruneBackups(dir, 1)` 会**删掉名字更新（也更可能真是最新）的那份**。
 * 两个信号取"更新的那个"⇒ 任一为真都算新：**名字新**（文件自己声称的时间）与**落盘新**（mtime）
 * 两个方向都不会误删；只有两者都旧时才判旧。同键再退名字序键、最后退纯名字（保证次序确定）。
 */
function backupOrderMs(entry) {
  const nameMs = backupNameTimeMs(entry.name);
  return nameMs === null ? entry.mtimeMs : Math.max(entry.mtimeMs, nameMs);
}

/** 列出备份（按时间倒序），带体积与修改时间。
 *  识别**两种**文件名形状（当前毫秒级 + 历史秒级）：历史备份必须继续被"看见"，
 *  否则保留策略既不会清理它们、恢复入口也列不出来（升级不该让旧备份变成隐形文件）。
 *
 *  ⚠ 次序键（**F17-5 ＋ F19-3** 两轮复核，已修到位）：第一顺位＝`max(mtime, 名字声称时刻)`（见上），
 *  第二顺位＝名字序键，第三顺位＝纯名字。历史**秒级**名没有毫秒段，单看名字会被归一化（SSS=999）
 *  排到同一秒的毫秒名**之后**、"更新的那份"可能被误删（F17-5 复核实测）；而单看 mtime 又会在
 *  **mtime 回拨**时误删名字更新的那份（F19-3 复跑反证）。取两者更大的一个即可两个方向都不误删。
 *
 *  ⚠ **E191（2026-10-05）新增字段 `isComplete`**（判据＝`bytes > 0`）：`false` ＝ "**只占了名、
 *  内容还没写完**" —— 即 `E188` 的占位中间态（`claimNameSlot()` 用 `'wx'` 排他建的那一格**只有 0 字节**，
 *  崩溃/被杀/写入失败后的备份就停在这里）。
 *  **为什么选择"留在列表里 ＋ 打标记"而不是"直接不返回"**（三条，按分量排序）：
 *   ① **看得见才判得出**：这类文件与"合法的**空库**备份"在 `verifyBackup()` 眼里**完全一样**
 *      （0 字节是合法 SQLite 空库 ⇒ `ok:true`、`tables:0`，`E188-⑤` 实测）⇒ 若这一层**再**把 0 字节件
 *      藏起来，"**存在未写完的备份**"就没有任何读者能看见（连自检页/巡检都看不到），而它恰是
 *      "崩溃留下的现场"；标记出来才能让下游区分，并由 `pruneBackups()` 点名报出。
 *   ② **判据已按该形状冻结**：`db-check` 的 `E188-⑤` 钉住"占位件**被 `listBackups()` 列为一份**
 *      （`bytes=0` 可见）"；改成"不返回"会让那条冻结点变红，而它钉的正是**同一件事**（占位件可见）
 *      —— 没有理由用"隐藏"去换一个红。
 *   ③ **纯增量、向后兼容**：只加字段，名字/顺序/既有字段一个不动 ⇒ 忽略 `isComplete` 的老读者行为不变；
 *      只想要"可恢复成品"的读者（一键恢复/自检页）自行 `filter(b => b.isComplete)` 即可。
 *  ⇒ 纪律：**任何把 `listBackups()` 的产物当"可恢复备份"的下游，都必须先按 `isComplete` 过滤。** */
function listBackups(backupDir) {
  const dir = path.resolve(backupDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => BACKUP_FILE_RE.test(n) || LEGACY_BACKUP_FILE_RE.test(n))
    .map(n => {
      const full = path.join(dir, n);
      const st = fs.statSync(full);
      return {
        name: n, path: full, bytes: st.size,
        /* `E191`：`isComplete=false` ＝ **只占了名、内容还没写完**（`E188` 的 0 字节占位件）。
           判据刻意只用 `bytes > 0`：它不必打开文件（列表阶段不该有副作用，更不该对**别人正在写**的
           文件上手、也就不会顺手造出 `-wal`/`-shm`），而 `E188` 占名机制的痕迹**就是"0 字节"**
           这一点 —— 理由与取舍见文件头 `E191` 段与本节 JSDoc。
           ⚠ 残余面（如实登记）：崩溃落在**写入中途**留下的**非 0 字节半成品**，这条读数判不出来；
           那一类要用 `verifyBackup()` 的 `tables` 读数与需求点名的表数比对另行判定。 */
        isComplete: st.size > 0,
        modifiedAt: formatNow(st.mtime), mtimeMs: st.mtimeMs
      };
    })
    .sort((a, b) => {
      /* F19-3：`max(mtime, 名字声称时刻)` —— 两个信号取更新的那个（任一为真都算新） */
      const ma = backupOrderMs(a);
      const mb = backupOrderMs(b);
      if (ma !== mb) return mb - ma;                               // 新 → 旧
      const ka = backupOrderKey(a.name);
      const kb = backupOrderKey(b.name);
      if (ka !== kb) return ka < kb ? 1 : -1;
      return a.name < b.name ? 1 : (a.name > b.name ? -1 : 0);
    });
}

/** 默认保留份数：每日一份 ≈ 30 天（DR-15） */
const BACKUP_KEEP = 30;

/**
 * 只保留最近 keep 份**完整**备份，多余的删除（DR-15 的"保留 N 份"）。
 *
 * ⚠ 2026-09-19 修（复审 P2-2）：旧写法 `Math.max(0, keep)` 在 `keep` 缺省/undefined 时得
 * `NaN`，`slice(NaN)` 等价 `slice(0)` —— **一次删光全部备份**，还返回 `kept: NaN` 且不报错
 * （已复现：3 份备份 → 删后 0 份）。现在：缺省走 `BACKUP_KEEP`、入参非法即抛错、
 * `kept` 返回**真实剩余数**，并把删除名单一并返回供审计。
 *
 * ⚠ **E191（2026-10-05，`T-20261005-36`）**：保留名额与计数**只数完整备份**
 * （`listBackups()` 的 `isComplete === true`）—— 0 字节件（`E188` 排他占下名、内容还没写完）
 * **不占名额、也不计进 `kept`**。
 * 立案读数（`T-20261005-34` 独立复核并加重的形态）：真备份**更旧** ＋ 崩溃留下的 0 字节件**更新**
 * ⇒ 改前 `pruneBackups(dir, 1)` 的 `removed=[真备份]`、`kept=占位件`
 * —— **0 字节占位件把真备份挤出了"保留最近 N 份"**（"看起来保住了 N 份、其实真备份没了"）。
 * **为什么这些 0 字节件只报不删**（三条，按分量排序）：
 *   ① 它可能**正被另一个进程写**：占名（`'wx'`）就是"这一格归我"的承诺，别人把它删掉之后，
 *      后来的调用会**重新占到同一格** ⇒ `E188` 关掉的 TOCTOU 又开了（两条备份写同一格）；
 *   ② 本文件的删除纪律是"**只删自己造的占位件**"（`discardTmp()`／`F17-1`），不是"替别人收尸"
 *      —— `E161-B①` 把本文件的单文件删定额钉在**恰 2 处**，本次收口**一处都不加**；
 *   ③ 保留策略的职责是"留最近 N 份**真备份**"，不是清理崩溃残骸 ⇒ 残骸**如实报出**（`incomplete`），
 *      由人或巡检处置，而不是让它在一次 `prune` 里**悄悄消失**（那就又变成"看不见"了）。
 *
 * @param {string} backupDir
 * @param {number} [keep] 保留份数（默认 30）；必须是 ≥ 0 的整数。**只对完整备份计数**
 * @returns {{kept:number, removed:string[], incomplete:string[], dir:string}}
 *   `kept`       —— **完整**备份的真实剩余数（不含 0 字节件；与 `listBackups()` 里 `isComplete` 的口径同一个）
 *   `removed`    —— 本次删掉的备份名（**只可能是完整备份**）
 *   `incomplete` —— **机器可读出口**："**存在未写完的备份**"时逐个点名（0 字节占位件的文件名，
 *                   与 `listBackups()` **同序**＝新 → 旧）；**本次一个都没删**；空数组 ＝ 没有。
 *                   ⚠ 形状固定（`string[]`），`T-20261005-38` 的同批冻结点按此写
 *   `dir`        —— 备份目录的绝对路径
 */
function pruneBackups(backupDir, keep = BACKUP_KEEP) {
  const dir = path.resolve(backupDir);
  const n = typeof keep === 'string' && keep.trim() !== '' ? Number(keep) : keep;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`pruneBackups: keep 必须是 ≥ 0 的整数（收到 ${JSON.stringify(keep)}）`);
  }
  const all = listBackups(dir);
  /* **E191**：名额只看**完整**备份；0 字节件**只报不删**（三条理由见上面 JSDoc）。 */
  const complete = all.filter(b => b.isComplete);
  const incomplete = all.filter(b => !b.isComplete).map(b => b.name);
  const removed = [];
  for (const b of complete.slice(n)) {
    try { fs.rmSync(b.path, { force: true }); removed.push(b.name); } catch { /* 忽略 */ }
  }
  const kept = listBackups(dir).filter(b => b.isComplete).length;   // 完整备份的真实剩余数（不靠算式推断）
  return { kept, removed, incomplete, dir };
}

/**
 * 校验一个备份文件能否打开且完整（供"一键恢复"前的自查）。
 * @returns {{ok:boolean, detail:string, tables:number}}
 */
function verifyBackup(file) {
  const { DatabaseSync } = loadSqlite();
  let db = null;
  try {
    db = new DatabaseSync(file);
    const integrity = verifyIntegrity(db);
    const tables = db.prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).get().c;
    return { ok: integrity.ok, detail: integrity.detail, tables };
  } catch (err) {
    return { ok: false, detail: err.message, tables: 0 };
  } finally {
    if (db) { try { db.close(); } catch { /* 忽略 */ } }
  }
}

/** 默认保留策略：1 年（DR-14） */
const RETENTION_DAYS = 365;

/** 单次裁剪删除行数上限：超过即视为"参数或口径出问题"，先停下而不是悄悄清库 */
const RETENTION_MAX_DELETE = 5_000_000;

/**
 * 按保留天数裁剪历史数据。**只删数据、不删表**。
 * 裁剪对象：measure_rt（采样）、task_curve（曲线）、alarm/warning/upload_log/op_log（台账与日志）。
 * task / result / shift_stat 属业务主数据，本函数不触碰（由归档流程另行处理）。
 *
 * ⚠ 2026-09-19 修（复审 P2-1，已复现的**静默删光**路径）：
 * 旧写法对 `days` 不做校验 —— `null` 被当成 0（cutoff=now，历史全删）、
 * `NaN` 让 `formatNow` 产出 `"NaN-NaN-NaN NaN:NaN:NaN"`，而 SQLite 里日期是**文本比较**，
 * 任何正常日期都 `< "N..."`，结果六张表被**清空**（探针实测剩余 0 行）。
 * 现在：入口强校验 `days`、cutoff 必须可解析、单次删除设上限并返回可审计信息。
 *
 * @param {object} db
 * @param {{days?:number, now?:Date, maxDelete?:number, dryRun?:boolean}} [options]
 * @returns {{cutoff:string, deleted:object, totalDeleted:number, dryRun:boolean}}
 */
function applyRetention(db, options = {}) {
  const rawDays = options.days === undefined ? RETENTION_DAYS : options.days;
  const days = typeof rawDays === 'string' && rawDays.trim() !== '' ? Number(rawDays) : rawDays;
  if (!Number.isInteger(days) || days < 1) {
    throw new TypeError(`applyRetention: days 必须是 ≥ 1 的整数（收到 ${JSON.stringify(options.days)}）—— 拒绝退化为"全删"`);
  }
  const maxDelete = options.maxDelete === undefined ? RETENTION_MAX_DELETE : Number(options.maxDelete);
  if (!Number.isInteger(maxDelete) || maxDelete < 0) {
    throw new TypeError(`applyRetention: maxDelete 必须是 ≥ 0 的整数（收到 ${JSON.stringify(options.maxDelete)}）`);
  }
  const now = options.now || new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('applyRetention: now 必须是合法 Date');
  }
  const cutoffDate = new Date(now.getTime() - days * 24 * 3600 * 1000);
  if (!Number.isFinite(cutoffDate.getTime())) {
    throw new RangeError(`applyRetention: 由 days=${days} 推出的 cutoff 非法 —— 拒绝执行删除`);
  }
  const cutoff = formatNow(cutoffDate);
  /* cutoff 必须是可比较的日期文本；否则文本比较下会误删全部（P2-1 的根因） */
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cutoff)) {
    throw new RangeError(`applyRetention: cutoff 格式异常「${cutoff}」—— 拒绝执行删除`);
  }

  const targets = [
    ['measure_rt', 'measure_rt', 'collect_time'],
    ['task_curve', 'task_curve', 'finished_at'],
    ['alarm', 'alarm', 'occurred_at'],
    ['warning', 'warning', 'triggered_at'],
    ['upload_log', 'upload_log', 'created_at'],
    ['op_log', 'op_log', 'op_time']
  ];

  /* 先数后删：既能做上限保护，也让 dryRun 可用（恢复演练/评审时先看会删多少） */
  const deleted = {};
  let total = 0;
  for (const [label, table, col] of targets) {
    const c = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} < ?`).get(cutoff).c;
    deleted[label] = c;
    total += c;
  }
  if (total > maxDelete) {
    throw new RangeError(
      `applyRetention: 本次将删除 ${total} 行，超过上限 ${maxDelete}（cutoff=${cutoff}）—— 已中止，请核对 days 与数据范围`);
  }
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    for (const [, table, col] of targets) {
      db.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(cutoff);
    }
  }
  return { cutoff, deleted, totalDeleted: total, dryRun };
}

module.exports = {
  RETENTION_DAYS,
  RETENTION_MAX_DELETE,
  BACKUP_KEEP,
  BACKUP_FILE_RE,
  LEGACY_BACKUP_FILE_RE,
  BACKUP_NAME_PROBE_LIMIT,
  backupName,
  backupOrderKey,
  backupNameTimeMs,
  backupOrderMs,
  resolveBackupName,
  resolveBackupWhen,
  backupTo,
  backupToSync,
  listBackups,
  pruneBackups,
  verifyBackup,
  applyRetention
};
