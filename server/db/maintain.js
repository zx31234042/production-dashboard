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
   依赖：node:path、node:fs、node:sqlite（经 ./index.js 的 loadSqlite 间接使用）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');   /* E47：临时名的随机段（内置模块，零依赖） */
const { loadSqlite, flushWal, verifyIntegrity, formatNow } = require('./index');

/** 备份文件名：`board-YYYYMMDD-HHmmss-SSS.db`（SSS＝毫秒）。
 *
 *  E44（2026-09-28）：旧名是**秒级** `board-YYYYMMDD-HHmmss.db` —— 同一秒内的多次备份**同名互相覆盖**，
 *  现象是"连做 N 次只剩 1 份"，于是 `db-check` 的「保留策略只保留最近 N 份」在并发/压测下偶发红。
 *  为什么选**毫秒**而不是自增序号：毫秒可由**注入时钟**（`options.now`）直接给出、不需要任何跨进程
 *  持久化状态，而且文件名仍保持"**字典序 = 时间序**"（`listBackups` 的排序与保留策略可直接沿用）；
 *  自增序号在进程重启后会从头开始（与既有备份重名），多进程并发时也没有共享真源，反而要多落一个计数器文件。
 *  毫秒之下仍可能同刻（同一个 Date 连调两次），故 `resolveBackupName()` 再按 **1 ms 递增探测**
 *  到第一个未被占用的刻度 —— 这一层同时挡住**多进程并发**（把文件系统本身当唯一真源）。 */
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
 * 在 `dir` 内解析一个**当前未被占用**的备份文件名 —— E44「同一秒 N 次备份 ⇒ N 个不同文件」的落点。
 * 语义：文件名的毫秒段在冲突时按 1 ms 递增"取最近的可用刻度"，故名字里的时刻可能与传入时刻差几毫秒；
 * **真实落盘时间以 `fs.statSync().mtime` 为准**（`listBackups` 的 `modifiedAt` 就是它）。
 * @param {string} dir 备份目录（须已存在）
 * @param {Date} [when] 期望时刻
 * @returns {{name:string, at:Date, bumpedMs:number}} `bumpedMs`＝为避让已占用的刻度而前进的毫秒数
 */
function resolveBackupName(dir, when) {
  let at = resolveBackupWhen(when);   // 缺省＝真实时钟（出口在 resolveBackupWhen 的单参默认值上）
  for (let i = 0; i < BACKUP_NAME_PROBE_LIMIT; i++) {
    const name = backupName(at);
    if (!fs.existsSync(path.join(dir, name))) return { name, at, bumpedMs: i };
    at = new Date(at.getTime() + 1);
  }
  throw new Error(`备份文件名冲突：自 ${backupName(resolveBackupWhen(when))} 起连续 ${BACKUP_NAME_PROBE_LIMIT} 个毫秒刻度` +
    `都已被占用（目录=${dir}）—— 请检查保留策略是否已失效`);
}

/**
 * 在线备份（不阻塞读；备份前先 checkpoint，保证备份文件自包含）。
 * @param {object} db 已打开的数据库句柄
 * @param {string} backupDir 备份目录（不存在会创建）
 * @param {{name?:string, now?:Date}} [options]
 *   `name` —— 显式文件名（**按原样使用**：同名文件会被覆盖）。只有"已知确切文件名"的场景才传它；
 *             默认路径（日常备份、迁移前备份）**不传**，走 `resolveBackupName()` 的唯一化解法。
 *   `now`  —— 注入时钟（缺省＝真实时钟）；E44 的毫秒段取自它
 * @returns {Promise<{path:string, name:string, bytes:number, checkpoint:object, at:Date, bumpedMs:number}>}
 */
async function backupTo(db, backupDir, options = {}) {
  const { backup } = loadSqlite();
  const dir = path.resolve(backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const when = resolveBackupWhen(options.now);
  const resolved = options.name
    ? { name: String(options.name), at: when, bumpedMs: 0 }
    : resolveBackupName(dir, when);
  const target = path.join(dir, resolved.name);

  const checkpoint = flushWal(db);
  await backup(db, target);

  const st = fs.statSync(target);
  return {
    path: target, name: resolved.name, bytes: st.size, checkpoint,
    at: resolved.at, bumpedMs: resolved.bumpedMs
  };
}

/** `E47`：**进程唯一**的临时文件名（与目标**同目录** ⇒ 硬链接/复制都不跨卷）。
 *  形状 `.<目标名>.tmp-<pid>-<12 位随机>`：
 *   · 前缀 `.` 且结尾不是 `.db` ⇒ `listBackups()` / `pruneBackups()` 的**全串匹配**正则
 *     （`BACKUP_FILE_RE` / `LEGACY_BACKUP_FILE_RE`，均以 `$` 收尾）**看不见**它 ⇒ 万一残留，
 *     它既不会被恢复入口当成"一份备份"列出，也不会被保留策略误删/误留；
 *   · `pid` ＋ `randomBytes(6)` ⇒ 同一进程内的多次调用、多进程并发都不会撞名。
 *  @param {string} name 目标备份文件名（不含目录）
 *  @returns {string} 同目录下的临时文件名 */
function tempNameFor(name) {
  return '.' + name + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
}

/** `E47`：丢弃**本次调用自造**的临时文件 —— **本文件唯一的临时件删除点**。
 *  为什么并成一处（2026-10-05，门禁回修）：`E161-B①` 对 `server/db/maintain.js` 的
 *  "单文件删"是**登记制**（清单里 `max` 定额、只减不增）—— 失败路径与成功路径各写一处
 *  就是一条要登记的漂移；合并后语义**一字不变**（两处删的都是**同一个** `tmp`），
 *  而"删除点更少"本身就是收益。
 *  `try` 保留：失败清理**不得**用自己的异常掩盖原始错误（调用方按自己的语义决定是否抛出）。
 *  @param {string} tmp 本次调用自造的临时文件路径
 *  @returns {void} */
function discardTmp(tmp) {
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  } catch { /* 清理失败不掩盖原始错误 */ }
}

/** `E47`：把临时文件**排他地**放到 `target`（"到位"这一步；目标已存在 ⇒ 抛 `EEXIST`，
 *  **绝不覆盖**）。为什么不用更短的 `rename`：`rename` 在目标已存在时是**覆盖**语义
 *  （Windows 的 MoveFileEx 带 REPLACE_EXISTING、POSIX 亦然）⇒ 若另一进程在这最后一步的
 *  窗口里抢先建了同名文件，`rename` 会把**它的**成品替换掉 —— "绝不触碰既有文件"仍然破功。
 *  两条通道都不覆盖、都不删 `target`：
 *   ①`linkSync(tmp, target)` —— 原子且目标已存在即 `EEXIST`（NTFS / ext4 等支持硬链接）；
 *   ②文件系统**不支持硬链接**（exFAT / FAT32 的 U 盘、部分网络盘 ⇒ `EPERM`/`ENOTSUP`/`EMLINK`
 *     等）时退化为 `copyFileSync(tmp, target, COPYFILE_EXCL)` —— 同样排他（在**打开目标**时
 *     就失败，不会写坏对方文件），代价是"目标可见性"不是原子的。
 *  @param {string} tmp 本次调用自造的临时文件
 *  @param {string} target 目标路径（已存在 ⇒ 抛错）
 *  @returns {'link'|'copy-excl'} 实际走通的通道（供返回值与复核留痕） */
const LINK_UNSUPPORTED = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'EXDEV', 'ENOSYS', 'EINVAL']);
function commitExclusive(tmp, target) {
  let linkErr = null;
  try {
    fs.linkSync(tmp, target);
    return 'link';
  } catch (err) {
    if (err && err.code === 'EEXIST') throw err;
    linkErr = err;
    if (!LINK_UNSUPPORTED.has(err && err.code)) throw err;
  }
  try {
    fs.copyFileSync(tmp, target, fs.constants.COPYFILE_EXCL);
  } catch (err2) {
    if (err2 && err2.code === 'EEXIST') throw err2;
    throw new Error('排他创建目标失败（硬链接 ' + (linkErr && linkErr.code) +
      ' ⇒ 退化 COPYFILE_EXCL 亦失败：' + (err2 && err2.code) + '）：' + (err2 && err2.message));
  }
  return 'copy-excl';
}

/**
 * **同步**在线备份 —— E18「迁移前强制备份」的调用形态（与 `backupTo` 是**同一套能力**，不是第二套备份）。
 *
 * 为什么必须有一个同步形态：`initSchema()` 是**同步**调用点（`server/index.js` 与自检夹具都写成
 * `dbApi.initSchema(handle.db)`），而 `node:sqlite` 的 `backup()` **只有异步形态**。若为了复用异步的
 * `backupTo` 而把 `initSchema` 改成 async，调用方一旦忘了 `await`，"备份失败 ⇒ 中止迁移"就退化成
 * **未捕获的 rejection ＋ 迁移照跑**（正是 E18 明令禁止的静默继续），代价远大于收益。
 * 共用部分（**不得各写一份**）：`backupName` / `resolveBackupName`（E44 的唯一命名与冲突探测），
 * 以及**先 `flushWal()` 做 checkpoint**（保证备份文件自包含）这条口径；
 * 差别只在复制动作本身 —— 这里用 SQLite 自己的 `VACUUM INTO`（同步、经连接读写、产物是**紧凑自包含**
 * 的新库文件；目标已存在时 SQLite 直接回 `output file already exists`，天然不会覆盖）。
 *
 * ⚠ 同名语义（F17-1 对齐并写死，两条路径**故意不同**）：
 *   · 异步 `backupTo()`：显式 `name` 命中已存在文件 ⇒ **按原样覆盖**（内置 `backup` API 的语义，日常备份用默认名、不会撞名）；
 *   · 同步 `backupToSync()`：目标**已存在 ⇒ 直接拒绝（抛错）且绝不触碰那份既有文件**。
 *   F17-1 的立案事实：本函数原来的失败清理是**无条件** `rmSync(target)`，在"显式传 `name` 且同名文件已存在"
 *   这条路径上会把**用户既有备份删掉**（复核实测：预置 `board-….db` → VACUUM 报 already exists → catch 删掉了它，
 *   目录 1 份 → 0 份）。现在：进函数先探测目标是否存在 ⇒ 已存在即抛错；失败清理**只允许删本次调用新建的文件**。
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
  const resolved = options.name
    ? { name: String(options.name), at: when, bumpedMs: 0 }
    : resolveBackupName(dir, when);
  const target = path.join(dir, resolved.name);
  /* F17-1①：**先探测**目标是否存在。默认命名路径由 `resolveBackupName()` 保证不存在，
     只有"显式传 name"才可能命中 —— 命中即拒绝，**一个字节都不动**那份既有文件。 */
  const existedBefore = fs.existsSync(target);
  if (existedBefore) {
    throw new Error(`同步备份拒绝覆盖既有文件（F17-1）：${target} 已存在 —— ` +
      'backupToSync 的语义是"新建、绝不覆盖"；需要覆盖请显式改用异步 backupTo()，或换一个文件名');
  }
  const checkpoint = flushWal(db);
  /* **E47**（2026-10-05）：不再直接 `VACUUM INTO target`，而是**先写进程唯一的临时名**，
     成功后再**排他地**把它放到 `target`（见上方 `commitExclusive()`）。为什么这样就没有窗口了：
       ①`VACUUM INTO` 的写目标是**本次调用自造的唯一名字**（pid ＋ 随机段）⇒ 别的进程用不到
         这个名字 ⇒ 并发下 `output file already exists` 这条错误**不可能**再出现
         （立案时它正是"进入 catch、进而删掉对方成品"的入口）；
       ②失败清理只按**这个自造名字**删（`tmp`），本函数里**不再出现任何 `rmSync(target)`**
         ⇒ "把另一个进程刚建好的成品删掉"在结构上不可能发生 —— 不是判据更严，而是那条
         代码路径不存在了；
       ③"到位"这一步是**排他创建**而不是 `rename`（理由见 `commitExclusive()` 的注释）。 */
  const tmp = path.join(dir, tempNameFor(resolved.name));
  /* 前置断言：这个唯一名字**本不该存在**。若它存在 ⇒ 名字空间被污染 ⇒ **拒绝触碰**
     （而不是"先删了再写"）—— 这样下面 catch 里删的 `tmp` 一定是**本次 VACUUM 造的**，
     "失败清理只删自己造的东西"由此可证，而不是靠推断。 */
  if (fs.existsSync(tmp)) {
    throw new Error(`同步备份拒绝触碰已存在的临时名（E47）：${tmp} —— ` +
      '该名字含本次进程号与随机段，正常不可能存在；请人工检查后删除它');
  }
  let commitMethod = null;
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    commitMethod = commitExclusive(tmp, target);
  } catch (err) {
    /* F17-1② ＋ E47②：失败清理**只删本次调用自造的临时文件**（`tmp`）。
       不做无条件 `rmSync(target)` —— 那正是"失败反而毁掉既有备份"的成因；
       现在这里**连一行"删 target"的代码都没有**，故另一个进程的成品不可能被本函数删掉。
       删除动作走**本文件唯一的** `discardTmp()`（`E161-B①` 的登记制：只减不增）。 */
    discardTmp(tmp);
    if (err && err.code === 'EEXIST') {
      throw new Error(`同步备份放弃：目标在本次写入期间被**另一个进程**创建（E47 的并发窗口）：` +
        `${target} —— 本次**未覆盖、未删除**对方产物（本次的临时文件已清理）`);
    }
    throw new Error(`同步备份失败（VACUUM INTO ${tmp} ⇒ 目标 ${target}）：${err.message}`);
  }
  /* 临时文件**成功路径**的清理：与失败路径**共用同一个删除点**（`discardTmp()`）——
     残留无害（`tempNameFor` 的命名口径保证 `listBackups()` 看不见它），
     故这里也不把它的异常升级成备份失败。 */
  discardTmp(tmp);
  const st = fs.statSync(target);
  return {
    path: target, name: resolved.name, bytes: st.size, checkpoint, engine: 'vacuum-into',
    /* `E47`：本次"到位"走的是哪条排他通道（`link` / `copy-excl`）—— 供复核与巡检读 */
    commitMethod,
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
 *  **mtime 回拨**时误删名字更新的那份（F19-3 复跑反证）。取两者更大的一个即可两个方向都不误删。 */
function listBackups(backupDir) {
  const dir = path.resolve(backupDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => BACKUP_FILE_RE.test(n) || LEGACY_BACKUP_FILE_RE.test(n))
    .map(n => {
      const full = path.join(dir, n);
      const st = fs.statSync(full);
      return { name: n, path: full, bytes: st.size, modifiedAt: formatNow(st.mtime), mtimeMs: st.mtimeMs };
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
 * 只保留最近 keep 份备份，多余的删除（DR-15 的"保留 N 份"）。
 *
 * ⚠ 2026-09-19 修（复审 P2-2）：旧写法 `Math.max(0, keep)` 在 `keep` 缺省/undefined 时得
 * `NaN`，`slice(NaN)` 等价 `slice(0)` —— **一次删光全部备份**，还返回 `kept: NaN` 且不报错
 * （已复现：3 份备份 → 删后 0 份）。现在：缺省走 `BACKUP_KEEP`、入参非法即抛错、
 * `kept` 返回**真实剩余数**，并把删除名单一并返回供审计。
 *
 * @param {string} backupDir
 * @param {number} [keep] 保留份数（默认 30）；必须是 ≥ 0 的整数
 * @returns {{kept:number, removed:string[], dir:string}}
 */
function pruneBackups(backupDir, keep = BACKUP_KEEP) {
  const dir = path.resolve(backupDir);
  const n = typeof keep === 'string' && keep.trim() !== '' ? Number(keep) : keep;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`pruneBackups: keep 必须是 ≥ 0 的整数（收到 ${JSON.stringify(keep)}）`);
  }
  const all = listBackups(dir);
  const removed = [];
  for (const b of all.slice(n)) {
    try { fs.rmSync(b.path, { force: true }); removed.push(b.name); } catch { /* 忽略 */ }
  }
  const kept = listBackups(dir).length;   // 真实剩余数（不靠算式推断）
  return { kept, removed, dir };
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
