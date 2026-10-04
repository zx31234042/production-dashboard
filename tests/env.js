/* ==========================================================================
   测试环境常量与校验（tests/env.js）
   作用：集中定义测试侧的环境开关、路径与运行时下限，供 tests/ 下所有脚本引用。
        其中**临时区的两个键**（`tempRootBase`＝公共根、`tempRoot`＝本轮专属目录）是 `E90`
        "按轮次隔离"的**唯一定义处** —— 所有脚本（含**不加载** `lib\harness.js` 的那些）
        看到的都是同一口径；详见下面"临时区"那一段。
        业务代码**不得**引用本文件（业务走 platform/paths.js）。
   依据：ADR-0003（测试环境）D16 环境与目录隔离、D17 夹具与临时库策略；规范 9.5-5。
   依赖：仅 Node 内置模块。
   用法：const env = require('./env');  env.assertRuntime();  env.paths.testData
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

/* ---------------- 运行时下限 ----------------
   node:sqlite 在 Node 22.5+ 存在但为实验性（需 --experimental-sqlite），Node 24 起免标志。
   见 ADR-0001 附件《依赖完备性核查》与 ADR-0002 D10。 */
const MIN_NODE_MAJOR = 24;

/** 解析 "v24.21.0" → 24 */
function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

/**
 * 校验运行时下限与测试环境安全性；不满足时**直接退出**（不是断言失败）。
 * 调用时机：每个测试脚本的第 3 行（require 之后立刻调用）。
 */
function assertRuntime() {
  const major = nodeMajor();
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    console.error(`\n[环境不满足] 需要 Node >= ${MIN_NODE_MAJOR}（当前 ${process.version}）。`);
    console.error(`原因：node:sqlite 在 Node 22.x 需 --experimental-sqlite，Node 24 起免标志（ADR-0002 D10）。`);
    process.exit(2);
  }
  /* D16：测试进程绝不允许指向生产数据目录 —— 宁可直接停下，也不能冒险写脏真实数据 */
  if (ENV_NAME === 'prod') {
    console.error('\n[环境不满足] DSH_ENV=prod：测试脚本拒绝在**生产环境**下运行（ADR-0003 D16）。');
    console.error('原因：测试会创建/删除临时库与样本数据，必须在 test 环境下执行。');
    process.exit(2);
  }
}

/* ---------------- 退出码契约（规范 9.5-5 第 6 条：跑不了必须显式跳过） ----------------
   0 = 全部断言通过（允许 0 项"跳过"的断言，如 ui-check 的需浏览器单项）
   1 = 有断言失败
   2 = 脚本自身异常（环境不满足导致的运行时错误、未捕获异常）
   3 = **本环境跑不了**，整脚本显式跳过 —— runner 据此归类为"跳过"，绝不计入通过
   为什么单独给 3：SKIP 场景过去以 0 退出，runner 只能靠子进程输出文本猜，
   而受限沙箱下输出可能拿不到（管道 EPERM），于是一个断言都没跑的脚本被记成 PASS。
   现有脚本**只用**这三个函数发退出码，不要在脚本里手写 process.exit(0/1/2/3)。 */
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_ERROR = 2;
const EXIT_ENV_SKIP = 3;

/* ---------------- 环境与路径 ---------------- */
const ENV_NAME = process.env.DSH_ENV || 'dev';                 // dev | test | prod
const ROOT = path.resolve(__dirname, '..');                    // 仓库根目录
const TESTS = path.join(ROOT, 'tests');

/** 测试可写区（已被 .gitignore 忽略）；临时库、日志、截图都落在这里 */
const VERIFY = path.join(TESTS, '._verify');

/* ==========================================================================
   **临时区：公共根 与 本轮专属目录（`E90` 的唯一定义处）**
   `T-20261003-10`（2026-10-03）单一真源化 —— 改这里的任何一行前先读完这一段。
   --------------------------------------------------------------------------
   ① **定义在哪**：就在下面这三行（`TEMP_ROOT_BASE`／`RUN_STAMP`／`RUN_TEMP_ROOT`）与
      `paths` 里的 `tempRootBase`／`tempRoot`。**别处一律只读 `env.paths`，不得再定义第二份**。
      历史（为什么要收口）：`E90`（临时区按轮次隔离）最初把定义**注入式**写在
      `tests\lib\harness.js` 的顶层 —— require 它时才把这两个键写进 `env.paths`。于是同一份语义
      出现两处不一致：**加载 harness** 的脚本（`db-check`／`preflight`／`harness-check`…）看到的是
      **本轮专属**目录；而**不加载 harness** 的脚本（`files-check`／`platform-check`／`docs-check`…）
      看到的仍是**公共根**。现在两个键在本文件（＝"路径集"的定义处）**一次算好**，
      任何脚本 require 本文件都看到同一口径；`lib\harness.js` 只**校验**这套语义（见该文件顶部）。
   ② **谁看到什么**（收口后，与"是否加载 harness"无关）：
        · `tempRootBase` ＝ **公共根** `tests\._verify\tmp` —— 各轮目录的**父目录**，
          也是"过期清扫"（`cleanupStaleTemp`）的唯一对象；
        · `tempRoot`     ＝ **本轮专属** `<base>\run-<pid>-<本地启动时刻>-<4 hex>` ——
          本轮所有临时目录/临时库/子进程日志都落在它下面 ⇒ 任一路的 `cleanup(true)`
          物理上删不到他路正在用的产物（`E90` 现场＝共用 `tests\._verify\tmp` 被别的路清掉）。
      名字与用法**向后兼容**：`tempRoot` 仍是"可写的临时区"（preflight 的写探针、db-check 找
      散落库文件、harness-check 数目录数、run-all 的 `cleanup(false)` 都照旧），只是它**现在对所有
      脚本**都指向本轮子目录，而不再只是"加载了 harness 的那些"。
  ③ **不加载 harness 的脚本要判"临时区根目录"的卫生时，不许只看 `tempRoot`**：本轮目录可能
      空的、甚至不存在（该脚本自己不写临时区）⇒ 只看它会把判据变成**恒真**（空洞化）。
      必须**同时**看公共根与各轮目录 —— 见 `tests\files-check.js` 第四节的扫描范围与理由。 */
const TEMP_ROOT_BASE = path.join(VERIFY, 'tmp');               // 公共根：各轮目录之父
const RUN_STARTED_AT = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
const RUN_STAMP = `${RUN_STARTED_AT.getFullYear()}${pad2(RUN_STARTED_AT.getMonth() + 1)}${pad2(RUN_STARTED_AT.getDate())}`
  + `T${pad2(RUN_STARTED_AT.getHours())}${pad2(RUN_STARTED_AT.getMinutes())}${pad2(RUN_STARTED_AT.getSeconds())}`;
/* 随机后缀：Windows 的 pid 会复用 ⇒ 只按 pid ＋ 秒级时刻命名有"同名撞上旧轮残留"的理论窗口 */
const RUN_TEMP_ROOT = path.join(TEMP_ROOT_BASE, `run-${process.pid}-${RUN_STAMP}-${randomBytes(2).toString('hex')}`);

const paths = {
  root: ROOT,
  tests: TESTS,
  verify: VERIFY,                                              // 自检产物总目录（已忽略）
  tempRootBase: TEMP_ROOT_BASE,                                // 公共根（各轮目录之父 ＋ 24h 清扫对象）
  tempRoot: RUN_TEMP_ROOT,                                     // **本轮专属**临时区（E90：可写的就是它）
  testData: path.join(VERIFY, 'data', 'test'),                 // D16：测试唯一允许写的数据目录
  captures: path.join(VERIFY, 'captures'),                     // 截图候选目录（screenshot-diff 默认读这里）
  baseline: path.join(TESTS, 'screenshots-baseline')           // 基准图（只读，不要写入）
};

/** 确保目录存在（递归创建） */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 判断路径是否位于测试可写区内（防误写生产数据；供断言与自查使用） */
function isInsideVerify(target) {
  const rel = path.relative(VERIFY, path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/* ==========================================================================
   `E46`（★★★）**链接安全删除** —— 改任何"删目录"的调用点前先读完这一段。
   `T-20261003-14`（2026-10-03）**定义搬家**：`isLink()`／`removeLinkSafe()` 原先定义在
   `tests\lib\harness.js`，现搬到这里（＝"路径集/环境"的定义处），由 `lib\harness.js` **再导出**。
   **为什么放 `env.js` 而不是留在 `lib\harness.js`**（`E101` 的建议，本批落地）：
     `cleanupStaleTemp()`（就在下面）必须用这两个辅助；而它按 `E90`／`T-20261003-10` 的口径
     定义在 `env.js`。若辅助留在 `lib\harness.js`，`env.js` 就得**反向 require** `lib\harness.js`
     ⇒ `harness.js` 顶层 require `../env`、`env` 又 require `../lib/harness` —— **循环 require**：
     谁先进来谁拿到半成品（`env.paths`／`module.exports` 可能还是空对象），症状是"某些加载顺序下
     门禁随机报错"，属最难查的一类。放 `env.js`（它只依赖 Node 内置）则依赖方向永远是
     `lib\harness.js → env.js` 单箭头，**无环**；同时定义**只有一份**（调用点从 `harness` 取
     或从 `env` 取都是**同一个函数对象**，见 `lib\harness.js` 的再导出）。
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
      这就是 `lib\harness.js` 的 `countEntriesDeep` 与 `tests\harness-check.js` 同名工具的既有正确做法。
      推论：**凡"要进入某个目录"的遍历，都该用 `lstatSync`（或 `readdirSync(…,{withFileTypes:true})`
      后判 `isDirectory()`，因为 dirent 对 junction 报 `isSymbolicLink()===true`）；
      只有确实要"穿透链接读目标"时才用 `statSync`。**（本处**只按做法指、不按行号指** —— `E134`：
      它原先举的反例是"`tests\ui-check.js:5273` 用 `statSync()`"，而该行**早已改成 `fs.lstatSync(p)`**
      （`E102`）⇒ 反例指向了**已经改对的正确做法**、与事实相反；同族（注释里的行号/做法被当成事实引用）
      在本仓已连发多次：`E88⒞`／`E78`／`E113`。**行号会漂，做法不会**。）
      `E101` 病灶正是**判据来源用错**：`cleanupStaleTemp()` 旧版用 `statSync(full).mtimeMs` 判"过期"
      ⇒ 链接的"年龄"其实是**目标**的年龄（跟随后才拿到）⇒ 链接顺理成章进了"递归删"那一支。
      —— **这一处就是本条的"真实反例"**（按做法指，不按行号指）。

   ③ **为什么拆链必须非递归（`rmdirSync(link)` 只拆链）**
      `fs.rmdirSync(link)` 在 Windows 上落到 `RemoveDirectoryW`，删的是**那个目录项（reparse point）本身**，
      不进入目标；**非递归** ⇒ 目录非空也不遍历 ⇒ 目标一条不动（实测 `rmdirSync` 成功、目标 3/3 不变）。
      它与 `cmd /c rmdir <link>` 是**同一个内核动作**，所以既满足 `E46` 的纪律，又不必起子进程
      （省掉管道/编码那一族风险，参见 `E40`）。`fs.unlinkSync(link)` 在新 libuv 上对 junction 也成功
      （`DeleteFileW` 失败后回退 `RemoveDirectoryW`），故作为**兜底**：两法都非递归，
      物理上都没有"进入目标"的能力 —— 这就是"只拆链"能做到**结构性安全**（而不是"这次恰好没删到"）的原因。
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

/* ==========================================================================
   **过期清扫的 24 小时口径：只有这一份**
   `E90` 之后的 `cleanupStaleTemp()` 与 `E105`（子集账本回收）**共用**同一个常量 ⇒
   改口径只改这一行，不会出现"目录按 24h、账本按别的时长"这种第二份口径。
   ========================================================================== */
const STALE_MAX_AGE_MS = 24 * 3600 * 1000;

/** `._verify\` 根下**子集轮账本**的文件名（`E99`：`--only` 子集轮写自己的账，刻意保留 pid
 *  ⇒ 同机多轮不互相覆写）。回收面**只认这个名字形状**，见 `cleanupStaleTemp`。 */
const SUBSET_LEDGER_RX = /^run-totals\.subset-.+\.json$/;

/** `._verify\` 根下**主账本**的文件名 —— **`docs-cross-check` 第十一节的取数面**（`E99`）：
 *  `run-all` 的每一种模式都写它、`docs-cross-check` 按写死路径读它。
 *  `E105` 的清扫**必须绕开它**（`SUBSET_LEDGER_RX` 天然不匹配 `run-totals.json`；
 *  这里把名字显式写出来是给下一位读者看的"禁区标记"，不是用来做匹配）。 */
const MAIN_LEDGER_NAME = 'run-totals.json';

/**
 * 清理**过期**（默认 24 小时前）的测试产物。`T-20261003-14` 之后有**两个**清扫面，
 * 共用 `STALE_MAX_AGE_MS` 这一份口径：
 *   ① **公共根**（`paths.tempRootBase` ＝ `tests\._verify\tmp`）下的**整轮**临时目录；
 *   ② `tests\._verify\` **根下** >24h 的**子集轮账本** `run-totals.subset-*.json`
 *      （`E105`：`E99` 的子集轮账本每轮 4~5 个、~1 KB/个，只写不回收 ⇒ 无限增长）。
 *
 * 为什么①的目标**不是** `paths.tempRoot`（这是 `T-20261003-10` 明确下来的口径）：`E90` 之后
 *   `tempRoot` 是**本轮专属**目录 —— 它刚建、mtime 是新的，拿它当目标等于"一圈都清不掉"；
 *   而"过期清扫"的语义本来就只对公共根下的 `run-<pid>-…` 成立（本轮与他路刚建的都不该被清）。
 *   `lib\harness.js` 的 `cleanup(false)` 与 `run-all` 的全绿收尾都走这里 ⇒ "24 小时"只有这一份。
 *
 * **`E101`（★★★）安全判据 —— 顺序不能调**：每个条目**先用 `lstatSync` 判"是不是链接"**：
 *   · **是链接** ⇒ **只拆链**（`removeLinkSafe`：`rmdirSync` 优先／`unlinkSync` 兜底，两法皆非递归），
 *     **绝不** `rmSync(recursive)` —— 理由与实测见上面 `E46` 那一段（危险分支可达，不靠"实测没炸"豁免）；
 *   · **不是链接** ⇒ 才按 mtime 判过期、才允许对**真实目录** `rmSync(…, {recursive:true})`。
 *   为什么"先 lstat 再 stat"而不是"直接 stat 看 mtime"：旧版用 `statSync(full).mtimeMs` ——
 *   `statSync` **跟随**链接 ⇒ 链接的"年龄"其实是**目标**的年龄，一个指向仓内真实目录的
 *   `zz -> tests` junction 只要目标够旧，就会被"24h 清扫"当成过期目录**递归删**。
 *   判别与删除必须用**同一口径**（lstat），否则判据与动作之间就有"穿链"的缝。
 *
 * 回收面的三重边界（都不是"顺手多删"）：
 *   · **只认 `._verify\` 根下的 `run-totals.subset-*.json`**（`SUBSET_LEDGER_RX`）—— 新鲜的不动
 *     （同机多轮不互相覆写，这就是不肯改成固定名的原因）；后缀不是 `.json` 的不动；
 *   · **主账本 `run-totals.json` 永不被本函数碰到**（`MAIN_LEDGER_NAME`）：它是 `docs-cross-check`
 *     的取数面，删了就等于把权威对账的取数面弄坏（`E99` 的教训）；
 *   · 本函数**只读一层**（`readdirSync` 不带 `recursive`）⇒ 不可能被链接带出圈（`E46` T5）。
 *
 * 返回 `{ removed, kept, removedRounds, removedLinks, removedLedgers }`（`E114` 拆分口径）：
 *   · `removed`＝**拆掉/删掉的条目总数** ＝ `removedRounds + removedLinks`（与 `E114` 之前**逐字同口径**：
 *     旧实现把"拆掉的链接"也计进这个数，`harness-check` §五与 `E103-E①/E③` 读的就是它 ⇒ 不改义，
 *     免得为一次"读数口径"改动去动别的文件；新读者请**优先读后三个分类字段**）；
 *   · `removedRounds`＝按过期口径**递归删掉的真实条目**（本仓的形态＝公共根下的整轮目录 `run-<pid>-…`）；
 *   · `removedLinks`＝**只拆链**拆掉的链接条数（`E101`：链接不看年龄、无条件拆链 —— 所以它
 *     **不是**"过期整轮目录"，这正是 `E114` 立案的读数误导：旧日志把两者打成一个数）；
 *   · `removedLedgers`＝回收的**过期子集账本** `run-totals.subset-*.json` 个数（`E105`）；
 *   · `kept`＝**留下的条目数**（两个清扫面上未被命中、且成功判定的条目）。
 *   异常不抛出（逐条 `try/catch`），避免影响门禁；计数**只在动作成功返回后**自增（与旧实现一致）。
 *
 * **注入面（`E114`）**：第二个参数 `io` 是给**定点回归**用的清扫 IO 替身（默认 `null` ＝真文件系统）。
 *   形状与 `makeRealSweepIo()` 逐键一致：`{ now, existsSync, readdir, isLink, mtimeMs, removeLink,
 *   removeDir, removeFile }`。它与 `verifyAuthorityTotals(agg, results, { gitAvailable })` 同一手法：
 *   **默认真实现、只在自检里注入假体** ⇒ 判据可以对着"真实函数体"跑真值表而**不产生任何副作用**
 *   （不建链接、不删目录）。⚠ 注入体必须自己保证"拆链非递归"（真实现走 `removeLinkSafe`）。
 */
function cleanupStaleTemp(maxAgeMs = STALE_MAX_AGE_MS, io = null) {
  const fsi = io || makeRealSweepIo();
  const result = { removed: 0, kept: 0, removedRounds: 0, removedLinks: 0, removedLedgers: 0 };
  const base = paths.tempRootBase;
  const now = fsi.now;
  if (fsi.existsSync(base)) {
    for (const name of fsi.readdir(base)) {
      const full = path.join(base, name);
      try {
        if (fsi.isLink(full)) {                                  /* ① 链接：只拆链，绝不递归（E101/E46） */
          fsi.removeLink(full);
          result.removedLinks++; result.removed++;
          continue;
        }
        const mtimeMs = fsi.mtimeMs(full);                       /* ② 已确认非链接，stat 不再有"穿链"语义 */
        if (now - mtimeMs > maxAgeMs) { fsi.removeDir(full); result.removedRounds++; result.removed++; }
        else result.kept++;
      } catch { /* 忽略：被别人占用或已删除 */ }
    }
  }
  /* `E105`：`._verify\` 根下的子集轮账本（与上面**同一份** `maxAgeMs` 口径）。
     `VERIFY` 尚未建出时（极早的单脚本调用）跳过 —— 没有目录就没有账本可回收。 */
  const verifyEntries = fsi.existsSync(VERIFY) ? fsi.readdir(VERIFY) : [];
  for (const name of verifyEntries) {
    if (!SUBSET_LEDGER_RX.test(name)) continue;                  /* 主账本/别的东西一律不碰 */
    const full = path.join(VERIFY, name);
    try {
      if (fsi.isLink(full)) { fsi.removeLink(full); result.removedLedgers++; continue; }
      const mtimeMs = fsi.mtimeMs(full);
      if (now - mtimeMs > maxAgeMs) { fsi.removeFile(full); result.removedLedgers++; }
      else result.kept++;
    } catch { /* 忽略：被占用或已删除 */ }
  }
  return result;
}

/**
 * 清扫的**真 IO**（`E114` 的注入面默认值）：每个键都只是把本文件既有的实现包一层 ——
 * 抽出来只为让 `cleanupStaleTemp(maxAgeMs, io)` 有一个可替换的接缝。
 *
 * ⚠ **`E151` 追加（2026-10-04，主代理裁定㈡）：`removeDir` 从 `fs.rmSync(p, {recursive:true})`
 *   改成走 `removeLinkSafe(p, …)`。** 对**非链接**逐字等价（`removeLinkSafe()` 的 `dir` 支就是
 *   `fs.rmSync(p, {recursive:true, force, maxRetries, retryDelay})`，本处不传后两项 ⇒ 默认 0），
 *   对**链接**则只拆链、**不跟随**。
 *   为什么必须这么改（**不是**"顺手换个封装"）：`removeDir` 是**接缝**，它的安全性原先**只靠调用方**
 *   （`cleanupStaleTemp()` 先 `fsi.isLink(full)`，顺序判据见上面 `E101` 段）；而门禁只能看到
 *   "这个文件里有没有该 id 的判别"（`E151` 的**文件级**豁免）⇒ 下面 `isLink: p => isLink(p)`
 *   这行**转发定义**会被当成"守护"，于是 `(tests\env.js, p)` 的裸递归删被**永久豁免**
 *   （`max` 不生效 —— 登记一条它，等于把 `E151` 的病搬进受管面）。改成 `removeLinkSafe` 之后
 *   **接缝自身**就是安全的 ⇒ 受管面回到"**零未守护裸递归删**"（只剩 `removeLinkSafe()` 自己的实现
 *   那一处**真守护**，它必须调 `fs.rmSync`）。`isLink` 键**保留**：调用方仍按 `E101` 的顺序判，
 *   两处都不穿链（"先 lstat 再 stat"的口径不变）。
 * @returns {{now:number, existsSync:Function, readdir:Function, isLink:Function, mtimeMs:Function,
 *            removeLink:Function, removeDir:Function, removeFile:Function}}
 */
function makeRealSweepIo() {
  return {
    now: Date.now(),
    existsSync: p => fs.existsSync(p),
    readdir: p => fs.readdirSync(p),
    isLink: p => isLink(p),
    mtimeMs: p => fs.statSync(p).mtimeMs,                        /* 调用点已先判非链接 ⇒ 不穿链 */
    removeLink: p => removeLinkSafe(p, { recursive: true, force: true }),
    removeDir: p => removeLinkSafe(p, { recursive: true, force: true }),
    removeFile: p => fs.rmSync(p, { force: true })
  };
}

/** 供日志/报告展示的简短环境摘要 */
function describe() {
  return [
    `Node ${process.version}`,
    `${process.platform}/${process.arch}`,
    `DSH_ENV=${ENV_NAME}`,
    `临时区=${path.relative(ROOT, paths.tempRoot)}`
  ].join(' ｜ ');
}

/* ---------------- 统一结论输出（规范 9.5-5 第 5、6 条） ---------------- */

/**
 * 打印"整脚本因环境不满足而跳过"，并以 EXIT_ENV_SKIP(3) 退出。
 * 输出格式与各脚本内的单项 skip 一致（`[SKIP] 名称 —— 原因`），
 * runner 优先据此归类；**不得**再退 0（那等于把跑不了的说成通过）。
 * @param {string} name   被跳过的东西（通常是"无头 Edge 启动与 CDP 连接"）
 * @param {string} reason 具体原因，必须写清是环境限制
 * @returns {never}
 */
function skipSuite(name, reason) {
  console.log(`  [SKIP] ${name} —— ${reason}`);
  console.log('\n=== 汇总 ===');
  console.log('通过 0 项，失败 0 项，跳过 1 项');
  console.log(`（整脚本跳过：${reason}）`);
  process.exit(EXIT_ENV_SKIP);
}

/**
 * 统一结论行。跳过数为 0 时**不写**"跳过"字段 —— 6.1 的冻结格式是
 * "通过 N 项，失败 N 项，跳过 N 项"，但 ui-check 等脚本已有历史口径，
 * 故此处仅在**真正有跳过**时补出该字段，避免把 0 跳过写成噪音。
 * @param {{passed:number, failed:number, skipped:number}} result
 */
function reportSummary(result) {
  const skipped = Number(result.skipped) || 0;
  const tail = skipped > 0 ? `，跳过 ${skipped} 项` : '';
  console.log('\n=== 汇总 ===');
  console.log(`通过 ${Number(result.passed) || 0} 项，失败 ${Number(result.failed) || 0} 项${tail}`);
}

module.exports = {
  MIN_NODE_MAJOR,
  EXIT_PASS,
  EXIT_FAIL,
  EXIT_ERROR,
  EXIT_ENV_SKIP,
  ENV_NAME,
  paths,
  isTest: ENV_NAME === 'test',
  isProd: ENV_NAME === 'prod',
  tmpdir: os.tmpdir(),
  nodeMajor,
  assertRuntime,
  ensureDir,
  isInsideVerify,
  /* `E46`（定义搬家，`T-20261003-14`）：链接安全删除的**单一真源**就在这里；
     `tests\lib\harness.js` 只**再导出**同一份函数对象（避免 `env.js` 反向 require 造成循环依赖）。 */
  isLink,
  removeLinkSafe,
  STALE_MAX_AGE_MS,
  SUBSET_LEDGER_RX,
  MAIN_LEDGER_NAME,
  cleanupStaleTemp,
  /* `E114`：清扫的**注入面真实现** —— 一并导出是为了让收尾自检能比对"假体与真实现的键集一致"
     （见 `tests\run-all.js` 的 `sweepCountSelfCheck`），不改变任何调用点的行为。 */
  makeRealSweepIo,
  describe,
  skipSuite,
  reportSummary
};
