/* ==========================================================================
   夹具自检（tests/harness-check.js）
   作用：**给测试环境本身加门禁** —— 夹具坏了会让上面所有门禁静默变弱
        （典型的：时钟没生效，班次用例照样"通过"但什么也没验到）。
        本脚本逐项实测夹具行为，确保它们真的可用而非"有文件、没人用"。
   依据：ADR-0003 D14（零依赖测试体系）、D15（统一 runner）、D17（夹具策略）。
   立案原因：2026-09-19 复查发现 `clock`/`injectFailure`/`startService` **零引用** ——
             即"交付了但从未被验证"，属测试基建的空转风险。
   运行：node tests/harness-check.js
   退出码：0 = 全部通过；1 = 有断言失败。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

const env = require('./env');
const { createRunner, stripLiterals } = require('./lib/assert');   /* stripLiterals：§十六 与 §五 的 E103 判据共用（单一真源＝tests\lib\assert.js） */
const { createClock, parseTime, BOUNDARIES } = require('./lib/clock');
const fixture = require('./lib/fixture');
const harness = require('./lib/harness');
const snapshot = require('./lib/snapshot');
/* W5-②（E45）断言要用：判定引擎（按写入点入参**重算**期望载荷）与配置真源（构造判定标准的输入）。
   注意：夹具模板里的同名 require 在**子进程**作用域，本文件顶层的断言代码读不到它。 */
const judge = require('../server/services/judge');
/* 第十五节：跨班期望值要**由班次真源现算**（`shift.list` ＋ `at()`），不手写键名（ADR-0004 D19）。 */
const { createShiftRules } = require('../server/services/shift');
const boardConfig = require('../src/config/board.config.js');
/* E58（DR-05 写入点，`T-20260930-08` 收口后）：进程入口模块本身。顶层这里只 require（**不起服务**，
   `require.main !== module` ⇒ 不会自动 `main()`），用途：在**进程内**起真服务实例，让父进程能读它的库
   句柄与 `state`，从而**按件对账** `result` 表（`countDone` / `countByTask` / `getOne`）—— 沿用层② W7 段
   同款写法（"父进程进程内起服务"）。
   ⚠ E58 的临时闸（`start()` 的 `orderDoneSourceReady` 注入位、`ORDER_DONE_SUPPRESS_REASON` 字面量、
   `/health.orderWarningSource` 字段、启动日志抑制行）已随 `T-20260930-08` **整段拆除** ⇒ 本文件
   **不再读任何"闸"字段**：件数只有一条真源（`result` 表按件计数），"该类整条不产生"与"该类判 ok"
   不再混为一谈 —— 旧写法靠已删字段决定期望值，字段消失后退化成 `undefined === undefined` 的**恒真式**
   （ADR-0004 D23 明令禁止）。
   命名不与夹具模板里的 `entry` 撞车：那些是**子进程作用域**的局部变量。 */
const serverEntry = require('../server/index.js');
/* 标准仓储（真计数夹具要写"生效标准"才能让判定真的跑起来）。
   ⚠ 必须**在顶层**再 require 一次：W5 夹具模板里那份 `stdRepo` 在**子进程作用域**，
   而本文件里另有一份落在 W6 那个**块作用域**内（块内的 `const` 出了块就没了）—— 实测踩过：
   在块外的夹具函数里直接用 `stdRepo` / `post` 会抛 `ReferenceError`。 */
const stdRepo = require('../server/repo/standard.js');
/* DR-05 仓储（E58 ②）：真计数夹具按件对账 `result` 表用 —— 读口（`countDone`/`countByTask`/`getOne`）
   走**生产同一口**（不另写第二份 SQL），外加一处"写失败注入"（临时把 `upsertJudgement` 换成抛错桩，
   测完**当场还原**，见夹具内注释）。它与 `server/index.js` 顶层 require 的是**同一个模块对象**
   （Node 模块缓存）⇒ 换属性即可作用于生产链路，不必改被测实现。 */
const resultRepo = require('../server/repo/result.js');
/* A1（T-20261002-06／ADR-0009 D1、D3）的两处仓储：`shift_stat`（DR-06）与 `warning`（DR-08）。
   第十五节要在**真采集链路**上按库内真源对账，故直接在顶层 require（与 `resultRepo` 同理：
   它与 `server/index.js` 顶层 require 的是**同一个模块对象** ⇒ 第十五节的"写失败注入"换属性即可
   作用于生产链路，不必改被测实现）。 */
const shiftStatRepo = require('../server/repo/shiftStat.js');
const warningRepo = require('../server/repo/warning.js');

env.assertRuntime();
const t = createRunner('夹具自检（harness-check）');

/* ==========================================================================
   `E70` **受管文件不变量**的共用普查（2026-10-03，`T-20261003-08` 甲组）
   --------------------------------------------------------------------------
   事故（同日实证）：`harness-check` 第十节过去**直接改写真文件 `tests\README.md`** 的权威行再还原，
   某轮改写**未被还原** ⇒ README 权威区（"合计"那一行）被留成 `541` ＝ 多脚本子集通过数之和，
   正是本段写入的**中间态值**；之后每轮对账都指向错值，只有"逐行比对 HEAD"才发现。

   本普查就是那条不变量的事实来源：**受管文件**（＝入库、且被门禁扫描的文本文件；
   口径与 `tests\lib\snapshot.js` 的扫描面同源，另按任务要求把 `tests\screenshots-baseline\*`
   ——二进制基准图，唯一写入点是 `capture-baseline.js --update` 这个**人工开关**，门禁轮从不带它——
   一并纳入）在"跑一轮/跑一段"前后的 sha256 必须**逐个相同**。

   ⚠ 三个必须说清的边界（否则这条不变量会退化）：
     ① **不读被重定向的读数**：第十节会给"真 README 绝对路径"装一条读数重定向（指向受控副本），
        而重定向是打在**共享的 `fs` 模块对象**上的 ⇒ 若普查也走 `fs.readFileSync`，它读到的
        永远是被改写的**副本**，真文件被污染也照绿（"看起来在守、实际守不住"，ADR-0004 D23）。
        故这里用**模块加载时抓住的 `REAL_READ`**（`fs.readFileSync` 原函数）读字节 —— 与重定向无关。
     ② **清单**取自 `snapshot.collectSnapshot()`（受管面的唯一真源，不另抄一份目录规则），
        但它自带的哈希值**一概不用**（它走被重定向的读）—— 只用它的**键**。
     ③ `tests\._verify\` 下的产物（各脚本日志、临时库、账本 `run-totals.json`）**不在**受管面内
        （`snapshot` 已排除 `._verify`）：它们是门禁运行期**正常的**产出，纳进来这条判据就成了恒红。
   ========================================================================== */
const REAL_READ = fs.readFileSync;                    /* ← 模块加载时抓住；永不被第十节的重定向影响 */
const BASELINE_PNG_DIR = path.join(env.paths.tests, 'screenshots-baseline');

/** 取文件字节的 sha256（走 `REAL_READ`，与任何读数重定向无关） */
function sha256BytesE70(buf) {
  return require('node:crypto').createHash('sha256').update(buf).digest('hex');
}

/**
 * 受管文件普查：`{ files: { 相对路径(posix): sha256 }, extra: 说明, collected, reason }`。
 * 失败（读不到某个文件）不抛错 —— 记成 `:err:<code>` 参与比对（"读不到"本身也是一种变化）。
 *
 * ⚠ **`pngCount` 的准确含义**（`E113`，2026-10-04 补注）：它是
 * `tests\screenshots-baseline\` 下的**文件条目数**，**不是"基准图张数"** —— 该目录里还有
 * 一份 `README.md`（说明捕获参数与更新流程），它也在这 11 个条目里、**同时也在
 * `snapshot` 的文本受管面里**（故受管面要按"93 文本 ＋ 11 条目"读，不能读成"两个不相交的集合"）。
 * 真正的"基准图"是 `pngFiles` 个 `*.png`。旧打印模板曾把 `${pngCount}` 念成"N **张基准图**"
 * （＝把 11 个目录条目读成 11 张图）⇒ 本次（`E113` 第二批）改由 `baselineEntriesPhrase()` 统一措辞。
 * @returns {{files:Object<string,string>, textCount:number, pngCount:number, pngFiles:number,
 *            pngOther:number, collected:boolean, reason:string}}
 */
function managedGuardCensus() {
  const files = {};
  const snap = snapshot.collectSnapshot();             /* 只用它的**键**（受管面清单） */
  for (const rel of Object.keys(snap.files)) {
    const full = path.join(env.paths.root, rel.split('/').join(path.sep));
    try { files[rel] = sha256BytesE70(REAL_READ.call(fs, full)); }
    catch (err) { files[rel] = `:err:${(err && err.code) || 'unknown'}`; }
  }
  let pngCount = 0;        /* 目录**条目**数（含该目录的 README.md） */
  let pngFiles = 0;        /* 其中 *.png（＝真正的"基准图"张数） */
  try {
    for (const name of fs.readdirSync(BASELINE_PNG_DIR)) {
      const full = path.join(BASELINE_PNG_DIR, name);
      if (!fs.statSync(full).isFile()) continue;
      pngCount++;
      if (/\.png$/i.test(name)) pngFiles++;
      files[`tests/screenshots-baseline/${name}`] = sha256BytesE70(REAL_READ.call(fs, full));
    }
  } catch { /* 基准目录读不到：下面按"取不到证据"处理（collected=false） */ }
  return {
    files, textCount: Object.keys(snap.files).length, pngCount, pngFiles, pngOther: pngCount - pngFiles,
    collected: snap.collected === true && pngCount > 0,
    reason: snap.reason || (pngCount ? '' : '读不到 tests/screenshots-baseline（或是空目录）')
  };
}

/** 把"基准目录"的读数渲染成**准确**措辞（`E113` 第二批，2026-10-04）——
 *  一律从运行时的 `census` 取数，**不写死任何数字**（防再漂的写法，见 `E113` 的成因记）。 */
function baselineEntriesPhrase(census) {
  if (!census || !Number.isFinite(census.pngCount)) return '基准目录条目（取不到）';
  return `${census.pngCount} 个目录条目（＝ ${census.pngFiles} 张 PNG ＋ 该目录 ${census.pngOther} 个非 PNG 条目，如 README.md）`;
}

/** 两次普查的差异（纯函数）：逐条给出 `路径（前 12 位 → 后 12 位）`，按路径字典序 */
function managedGuardDiff(before, after) {
  if (!before || !after || !before.files || !after.files) return ['（普查取不到证据：两次快照不完整）'];
  const keys = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  return keys.filter(k => before.files[k] !== after.files[k])
    .map(k => `${k}（${(before.files[k] || '缺').slice(0, 12)}… → ${(after.files[k] || '缺').slice(0, 12)}…）`);
}

/* ==========================================================================
   **判据的"地面"：剥离器自证 ＋ 双路复核（`E160`，`T-20261005-08` 甲组）**
   --------------------------------------------------------------------------
   立案（`C·24` 第 1／4 组报出、本件落地）：`stripLiterals()`（单一真源＝`tests\lib\assert.js`）
   在 `tests\harness-check.js` 上留下 **858 行连续盲区**，把整段文本剥成空白 ⇒
   上面所有"剥字面量后判"的判据在这段区间里**在读空气**：
     · `E103-B②`（"本门禁自身的面零未防护"）在**空转**；`E103-B①` 对该文件**全盲**；
     · 那段里那处 `fs.rmSync(tmpRoot,{recursive:true,force:true})` 只喂局部行时才看得见。
   ⇒ 本节给"地面"加**自证**，并把 `E103` 那一族的判据做成**双路**。

   **为什么"行数 ＋ 锚点"不够、必须加结构维度（本件要求写清的那一句）**：
     ① 锚点（行号／sha）回答的是"**这一行还在不在**"，回答不了"**判据还看不看得见这一行**" ——
        那一行**一直在盘上、锚点一直对**，但它在剥后文本里是**空格** ⇒ 判据读它是"空气"。
        锚点是**内容真源**，地面是**可见性真源**：两者正交，缺一维就出现"锚点全绿而判据空转"。
     ② 纯行数阈值也不行：**合法**的多行字面量（`String.raw` 夹具、内联脚本模板）实测能长到 **147 行**
        （`._verify\T-20261004-03\patch-tools.js` 的 `PREFLIGHT`）／109／105 行，它们**本来就该被剥掉**
        （那是字面量内容，不是代码）；而病灶长到 **858 行**。光看长度**分不开**这两类。
     ③ 故本节的判据是**结构配对**：`长空白段（超阈值）` **且** `该段原样文本里含 A 档删除 API`
        ⇒ 才叫"活代码失明"。只有长度、没有"里面藏着什么"，就会把合法长模板判红（"恒红式"）；
        只有 API、没有长度，就分不清"字面量里的一行示例"与"整段活代码失明"。**两维缺一不可。**

   ⚠ **阈值是量出来的，不是猜的**（真源＝`tests\._verify\t2-e160\probe-e160-census.js` ＋
      `probe-e160-baseline.js`，读数落 `e160-census.txt`／`baseline.txt`；面＝`tests\**\*.js ＋ tools\**\*.js`）：
      · **最长连续 blank 段（行）**：`p50=3`、`p90=22`、`p95=35`、`p99=67`；
        `≥100 行 7 个`、`≥150 行 3 个`、`≥200 行 3 个`、`≥900 行 0 个`；
        **第二长 147 行**、第三长 109 行，858 与次高之间空档 **711 行**。
        ⇒ **阈值取 `200` 行**：比"合法最大（147）"高 **36%**（不误红）、比"病灶（858）"低 **77%**（必抓）。
      · **剥后非空白字节占比**：`p01=0.1162`、`median=0.4972`；
        **受管面（排除 `._verify\`）实测最小 0.2091**（`tests\copy-check.js`）；
        全场最小 **0**（`._verify\review\e97-doc.js`，整份被剥光 —— 那是历史取证件、不是缺陷）。
        ⇒ **受管面地板取 `0.02`**：远低于实测最小合法值，又足以抓住"整份被剥光"。
      · **两点都写进代码常量的出处注释**，并由 `E160-④` 断言"基线 ↔ 盘上实测量"逐项一致
        （基线漂了、或有人把阈值改成能漏掉 858 行 ⇒ **当场红**）。
   ========================================================================== */
const GROUND_THRESHOLD_E160 = {
  maxRunLines: 200,        /* 长空白段超过它 ⇒ 进入"结构配对"审查（实测：合法最大 147、病灶 858） */
  minStripRatio: 0.02,     /* 剥后非空白占比地板（**受管面**判红；实测受管面最小 0.2091） */
  /* 基线的**出处**＝`tests\._verify\t2-e160\probe-e160-census.js` ＋ `probe-e160-baseline.js`
     在 2026-10-05 本工作区上的实测值（**不是手写的期望值**；命令与读数见回执）。
     ⚠ **锚点只锚"受管面"（`tests\*.js` ＋ `tests\lib\**` ＋ `tools\**`，排除 `tests\._verify\`）** ——
        这是本件**实测之后按事实收窄**的口径：`._verify\` 是 scratch 面，本仓实测里
        "非空白占比最低的几个"**全部**来自它（`review\e97-doc.js`＝0、`eod-20261001.js`＝0.0871…），
        而那些文件**随时会被删/被换** ⇒ 若把它们当锚点，"别人清一次 scratch"就会让本判据变红、
        人就会去改锚点（`D21`／`D23` 的退化路径）。
        受管面**不随 scratch 生灭**（实测最小 `tests\copy-check.js`＝0.2091），故锚点取它。
        全场读数（含 `._verify\`）照旧**每轮打印**，只是**不参与**锚点比对。 */
  baseline: {
    /* —— 受管面（**锚点**：稳定、不被 scratch 面染动）—— */
    managedMinNonBlankRatioLegit: 0.20912751677852348,  /* `tests\copy-check.js` */
    managedMaxRunLines: 858,                           /* `tests\harness-check.js` 的 `String.raw` 夹具 */
    managedMaxRunLinesExcludingOver: 105,              /* 受管面除超标外最长（`tests\browser-check.js`；147 那一段在 `._verify\`，不在受管面） */
    /* ⚠ **量纲说明**（本件实测踩过）：`managedFileCount` 数的是**"受管**且被本扫描面覆盖**的 .js"** ——
       在 `harness-check` 全跑时它＝生产（`server\`／`src\`／`platform\`，60 个）＋ 测试/工具（29 个）＝ **89**；
       在**隔离复跑**（只跑 E160/E161 的探针，见 `tests\._verify\t2-e160\probe-isolated-e160e161.js`）时
       它只＝测试/工具那 **29** 个 ⇒ 围栏必须把**两个量纲**都放进去，且**下界要高到"扫空了就一定红"**。 */
    managedFileCountLo: 20, managedFileCountHi: 260,
    /* —— 全场（**只打印、不锚定**）—— */
    maxRunLines: 858,
    minNonBlankRatio: 0,
    minNonBlankRatioLegit: 0.08714724374908613,
    fileCountLo: 700, fileCountHi: 2000,               /* 扫描面规模的**数量级**围栏 */
    stripperSha12: '989ade2c605f'                      /* `stripLiterals.toString()` 的 sha256 前 12 位 */
  }
};

/** 与 `e103LinkSafetyChecks` 的 `walkJsE103` **同一口径**的目录遍历（顶层版：供 `E160` 的普查复用；
 *  两处都不跟随链接、都按 `*.js` 收面）。 */
function walkJsTopE160(dir, out = []) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkJsTopE160(abs, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

/** 判据的"地面"分析（**纯函数**，主判据与 D22 共用 —— `E153` 的教训）：
 *  对一段源码算出 ① 剥除率 ② 最长连续 blank 段（行数 ＋ 字节跨度 ＋ 行号区间）。
 *  语义**逐字**（复算请照此）：`stripped = stripLiterals(src)`；"空白行"＝`/^[ \t\r]*$/`；
 *  "段"＝**连续**空白行；`runBytes`＝该段各行长度 ＋ 每行一个换行。
 *  @param {string} src 源码
 *  @returns {{bytes:number,strippedBytes:number,ratio:number,nonBlank:number,nonBlankRatio:number,
 *            changed:boolean,lenSame:boolean,nlSame:boolean,runLines:number,runBytes:number,
 *            runStartLine:number,runEndLine:number,runRegion:string,fileLines:number,
 *            blankRuns:Array<{start:number,end:number,lines:number,bytes:number}>}} */
function analyzeGroundE160(src) {
  const stripped = stripLiterals(src);
  const lines = stripped.split('\n');
  const isBlank = (l) => /^[ \t\r]*$/.test(l);
  const blankRuns = [];
  let i = 0;
  while (i < lines.length) {
    if (!isBlank(lines[i])) { i++; continue; }
    let j = i;
    while (j + 1 < lines.length && isBlank(lines[j + 1])) j++;
    blankRuns.push({
      start: i + 1, end: j + 1, lines: j - i + 1,
      bytes: lines.slice(i, j + 1).reduce((a, l) => a + l.length + 1, 0)
    });
    i = j + 1;
  }
  const run = blankRuns.reduce((a, b) => (b.lines > a.lines ? b : a), { start: 0, end: 0, lines: 0, bytes: 0 });
  const nonBlank = (stripped.match(/[^ \t\r\n]/g) || []).length;
  return {
    bytes: src.length,
    strippedBytes: stripped.length,
    ratio: src.length ? stripped.length / src.length : 1,
    nonBlank,
    nonBlankRatio: src.length ? nonBlank / src.length : 1,
    changed: stripped !== src,
    lenSame: stripped.length === src.length,
    nlSame: (stripped.match(/\n/g) || []).length === (src.match(/\n/g) || []).length,
    runLines: run.lines,
    runBytes: run.bytes,
    runStartLine: run.start,
    runEndLine: run.end,
    runRegion: run.lines ? `:${run.start}-:${run.end}` : '（无空白段）',
    fileLines: lines.length,
    blankRuns
  };
}

/** `E161` A 档（零容忍）删除 API 的**识别式**（单一真源；主判据与全部 D22 共用）：
 *  输入**已经剥掉字面量的代码**，只认 API 名与调用语法，**不认注释/字符串里的文字**。
 *  覆盖（`E161` 立案点名的 5 种"拼写出口"＋ 2 种外调 ＋ 1 种裸标识符）：
 *    ① `fs.rmSync`／`fs.rmdirSync` 的 **`recursive:true`** 形态（**配对括号取实参** ⇒ 跨得过 `path.join(…)` 的内层 `)`）；
 *    ② `fs.promises.rm`／`fs.promises.rmdir`／`fs.rm`／`fs.rmdir`（**任何**形态：语义上就是 rimraf 家族）；
 *    ③ **静态解构**：`const {rmSync} = require('fs')` 一类（按被解构的名字命名；含 `fs/promises`）；
 *    ④ **动态取用**：`fs[<表达式>]`（语法级，一律命中；`fs['rmSync']`／`fs[fn]` 都躲不过）；
 *    ⑤ **裸标识符**：解构/别名之后**直接用名字调**且实参里带 `recursive:true`；
 *    ⑥ **外调 shell 递归删**：`rmdir /s`、`rd /s`、robocopy 的镜像开关（**保留字符串**再判，见 `scanToolShellE161`）。
 *  ⚠ 边界（据实登记，不写"已覆盖"的假话）：`const {rmSync: alias} = require('fs')` 后**只用别名**调用 ——
 *    ③（解构语句本身）+ ⑤（裸标识符）已经覆盖到；"命令由两个变量拼出来"这种形态**看不见**，
 *    由 `E103-A④/A⑥` 的窄口径如实登记为未覆盖。 */
const RM_API_NAMES_E161 = ['rmSync', 'rmdirSync', 'rm', 'rmdir'];
/** 取 `(` 起配对括号内的实参文本（配不上就取到 4000 字符为止 —— 宁可多读，不可漏读） */
function argsParenE161(code, openIdx) {
  let depth = 0;
  const end = Math.min(code.length, openIdx + 4000);
  for (let k = openIdx; k < end; k++) {
    const c = code[k];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return code.slice(openIdx + 1, k); }
  }
  return code.slice(openIdx + 1, end);
}
const lineOfE161 = (code, idx) => code.slice(0, idx).split('\n').length;
function scanRmApiStrippedE161(code) {
  const hits = [];
  let m;
  const re = /\bfs\s*\.\s*(?:(promises)\s*\.\s*)?(rmdirSync|rmSync|rmdir|rm)\s*\(/g;
  while ((m = re.exec(code))) {
    const name = m[2];
    const isPromises = Boolean(m[1]);
    const args = argsParenE161(code, m.index + m[0].length - 1);
    const rec = /recursive\s*:\s*true/.test(args);
    const qualified = `fs.${isPromises ? 'promises.' : ''}${name}`;
    if (name === 'rmSync' || name === 'rmdirSync') {
      if (rec) hits.push({ line: lineOfE161(code, m.index), rule: `${qualified}(…,{recursive:true})`, api: qualified, tier: 'A' });
    } else {
      hits.push({
        line: lineOfE161(code, m.index),
        rule: `${qualified}(…)（rimraf 家族，无 recursive 也存在）`, api: qualified, tier: 'A'
      });
    }
  }
  /* ③ 静态解构 */
  const reD = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/g;
  while ((m = reD.exec(code))) {
    for (const nm of RM_API_NAMES_E161) {
      if (new RegExp(`(?:^|[,{\\s])${nm}\\s*(?:[,}=\\s]|$)`).test(m[1])) {
        hits.push({ line: lineOfE161(code, m.index), rule: `静态解构取删除 API：{${nm}} = require('fs')`, api: nm, tier: 'A' });
      }
    }
  }
  /* ④ 动态取用 */
  const reY = /\bfs\s*\[/g;
  while ((m = reY.exec(code))) {
    hits.push({ line: lineOfE161(code, m.index), rule: 'fs[<表达式>] 动态取用（静态判据无法覆盖）', api: 'fs[…]', tier: 'A' });
  }
  /* ⑤ 裸标识符：解构/别名之后直接用名字调（只认 `recursive:true` 形态 —— 非递归那一支走 B 档登记） */
  const reBare = /(?<![.\w$])(rmSync|rmdirSync|rmdir|rm)\s*\(/g;
  while ((m = reBare.exec(code))) {
    const args = argsParenE161(code, m.index + m[0].length - 1);
    if (/recursive\s*:\s*true/.test(args)) {
      hits.push({ line: lineOfE161(code, m.index), rule: `${m[1]}(…)（裸标识符 ＋ recursive:true ＝ 解构/别名后的调用）`, api: m[1], tier: 'A' });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}
/** **外调 shell 递归删**（`E161` 第 6 类）：必须**保留字符串**才看得见 ⇒ 单独一个剥器（与 `E103` 的
 *  `stripCommentsOnlyE103()` 同口径、但**独立定义**在本文件顶层，便于 D22 直接喂合成样本）。
 *  ⚠ 目标串一律**拼接构造**（逐字写会自伤 —— `E103-A④` 实测踩过两次）。 */
const TOOL_SHELL_PATTERNS_E161 = [
  ['rmdir 的 ' + '/' + 's 开关（cmd 递归删目录）', new RegExp(String.raw`rmdir\s+\/s`)],
  ['rd 的 ' + '/' + 's 开关（cmd 递归删目录）', new RegExp(String.raw`\brd\s+\/s`)],
  ['robocopy 的镜像开关（实测唯一真穿 junction 的删法）', new RegExp(String.raw`robocopy[^\n]{0,200}\/MIR`)]
];
function stripCommentsKeepStringsE161(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  let mode = 'code';
  let i = 0;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { blank(i, i + 2); mode = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { blank(i, i + 2); mode = 'block'; i += 2; continue; }
      if (c === "'") { mode = 'sq'; i++; continue; }
      if (c === '"') { mode = 'dq'; i++; continue; }
      if (c === '`') { mode = 'tpl'; i++; continue; }
      i++; continue;
    }
    if (mode === 'line') { blank(i, i + 1); if (c === '\n') mode = 'code'; i++; continue; }
    if (mode === 'block') {
      if (c === '*' && c2 === '/') { blank(i, i + 2); mode = 'code'; i += 2; continue; }
      blank(i, i + 1); i++; continue;
    }
    if (mode === 'sq' || mode === 'dq') {
      const q = mode === 'sq' ? "'" : '"';
      if (c === '\\') { i += 2; continue; }
      if (c === q) { mode = 'code'; i++; continue; }
      if (c === '\n') { mode = 'code'; i++; continue; }
      i++; continue;
    }
    if (c === '\\') { i += 2; continue; }                 /* tpl：内容保留（宁可多报，不可漏报） */
    if (c === '`') { mode = 'code'; i++; continue; }
    i++; continue;
  }
  return out.join('');
}
function scanToolShellE161(source) {
  const code = stripCommentsKeepStringsE161(source).split('\n');
  const out = [];
  code.forEach((l, i) => {
    for (const [name, re] of TOOL_SHELL_PATTERNS_E161) {
      if (re.test(l)) out.push({ line: i + 1, rule: name, api: 'child_process/shell', tier: 'A' });
    }
  });
  return out;
}
/** `E161` B 档（**单文件删／非递归拆链**）识别式：**登记制**，不进 A 档。
 *  语义＝"删的是**目录项**、不进去、不跟随"（`fs.rmSync(p,{force})`／`fs.rmdirSync(p)`），
 *  实测风险低但仍是删除动作 ⇒ 按 `(文件, 出现次数)` 登记，**多一处即红**、**少一处报名单陈旧**。 */
function scanSingleFileRmE161(code) {
  const hits = [];
  let m;
  const re = /\bfs\s*\.\s*(?:(promises)\s*\.\s*)?(rmdirSync|rmSync|rmdir|rm)\s*\(/g;
  while ((m = re.exec(code))) {
    const args = argsParenE161(code, m.index + m[0].length - 1);
    if (/recursive\s*:\s*true/.test(args)) continue;         /* A 档那一支不在这里 */
    hits.push({ line: lineOfE161(code, m.index), api: `fs.${m[1] ? 'promises.' : ''}${m[2]}` });
  }
  return hits;
}
/** **双路复核**（`E160` 的交付 2）：同一个**纯谓词**分别喂 ①剥后的视图 ②**原样字节**，
 *  返回合成读数（哪一路命中、命中在哪、以及"只在原样路上命中"的条数）。
 *  ⚠ 为什么必须**同一个谓词**：两路若各写一份判据，D22 证明的就不是主判据那一件事
 *    （`E153` 的教训：D22 与主断言不共用谓词 ⇒ 删掉契约合取项两条都照样绿）。
 *  @param {string} source 源码
 *  @param {(code:string)=>{line:number,rule:string,api?:string}} scan 纯谓词
 *  @returns {{stripped:Array,raw:Array,onlyRaw:Array,summary:{stripped:number,raw:number,onlyRaw:number,rule:string}}} */
function dualScanE160(source, scan) {
  const tag = (path, hs) => hs.map(h => ({ path, ...h }));
  const stripped = tag('stripped', scan(stripLiterals(source)));
  const raw = tag('raw', scan(source));
  const key = (h) => `${h.rule}@${h.line}`;
  const onlyRaw = raw.filter(h => !stripped.some(s => key(s) === key(h)));
  const rule = onlyRaw.length
    ? `**只在原样路上命中** ${onlyRaw.length} 处（这类命中必须由第二路负责报告，剥离路看不见）`
    : '两路读数一致（原样路没有多报 ⇒ 本文件没有"剥离器盲区里的形状"）';
  return { stripped, raw, onlyRaw, summary: { stripped: stripped.length, raw: raw.length, onlyRaw: onlyRaw.length, rule } };
}
/** **合成样本的两路读数**（`E161` 的 D22 共用）：把同一个**纯谓词**经 `dualScanE160()`（＝两路复核）
 *  喂给一段**内存样本**，返回两路命中。
 *  ⚠ `hits` 取**两路的并集**：外调 shell 那两类（`rmdir /s`／robocopy 镜像开关）**只存在于字符串实参里**，
 *    剥离路**故意**看不见它们（剥字面量是地面纪律），它们**只由原样路**负责报告；
 *    若这里只取剥离路，就等于"新增的判据自己把第二路的功能丢了"（本件实测踩过）。 */
function sampleDualE161(scan, source) {
  const d = dualScanE160(source, scan);
  return { hits: d.raw, stripped: d.stripped, raw: d.raw, onlyRaw: d.onlyRaw };
}
/** `E160` 的**结构配对**归属（纯函数）：对某文件里"超过阈值的连续 blank 段"，
 *  在**原样文本**里查该段行区间内是否含 `E161` 的 A 档删除 API 形态。
 *  ⇒ 只有"长度超标" **且** "里面藏着删除 API" 才算"活代码失明"（两维缺一不可，见上文）。
 *  ⚠ **逐段分别归属**（不要把各段的命中并成一张表）：红条件是**按段**算的 —— 并表会把
 *    "另一段的命中"错记到这一段头上（本文件自己就同时有 858 行（含 API）与 251 行（零 API）两段超阈值）。
 *  ⚠ 第 2～4 个形参（`strippedSrc`／`runStartLine`／`runEndLine`）**本函数不用** —— 段区间在这里
 *    按 `rawSrc` **重新量**一遍（口径与 `analyzeGroundE160` 同源，避免"调用方量的段"与"本函数量的段"漂移）。
 *    保留形参是为了**调用点签名稳定**（判据与 D22 喂同一份取值对象，`E153`）。
 *  @param {string} rawSrc 该文件**原样**字节
 *  @param {number} thresholdLines 阈值（＝`GROUND_THRESHOLD_E160.maxRunLines`；D22 会喂别的值） */
function attributeGroundE160(rawSrc, strippedSrc, runStartLine, runEndLine, thresholdLines) {
  const runs = analyzeGroundE160(rawSrc).blankRuns;
  const over = runs.filter(r => r.lines > thresholdLines);
  const byRule = new Map();
  const perRun = over.map(r => {
    const codeLines = rawSrc.split('\n');
    const windowTxt = codeLines.slice(r.start - 1, r.end).join('\n');
    const h2 = [...scanRmApiStrippedE161(stripLiterals(windowTxt)), ...scanToolShellE161(windowTxt)];
    const m = new Map();
    for (const h of h2) {
      const absLine = r.start - 1 + h.line;
      if (!m.has(h.rule)) m.set(h.rule, []);
      m.get(h.rule).push(absLine);
      if (!byRule.has(h.rule)) byRule.set(h.rule, []);
      byRule.get(h.rule).push(absLine);
    }
    return { start: r.start, end: r.end, lines: r.lines, hits: [...m].map(([rule, lines]) => ({ rule, lines: [...new Set(lines)].sort((a, b) => a - b) })) };
  });
  return {
    overRuns: over,
    runs: perRun,
    /** **只有**"超阈值 **且** 段内含 A 档 API"的段（＝真正该进台账的那些；空的干净长段不算） */
    redRuns: perRun.filter(p => p.hits.length > 0),
    hits: [...byRule].map(([rule, lines]) => ({ rule, lines: [...new Set(lines)].sort((a, b) => a - b) }))
  };
}

/** `E160` 的判据本体：**剥离器自证 ＋ 结构配对的盲区检测/台账 ＋ 双路复核读数**。
 *  调用点＝`e103LinkSafetyChecks()` 开头（`E103` 那一族判据**之前** ⇒ 地面先证，再判）。
 *  @param {object} t runner
 *  @param {string[]} files 扫描面（与 `E103` 的 `walkJsE103` 同口径） */
function runGroundChecksE160(t, files) {
  const band = GROUND_THRESHOLD_E160;
  const stripSha12 = require('node:crypto').createHash('sha256')
    .update(stripLiterals.toString()).digest('hex').slice(0, 12);

  /* ---------- 0. 纯函数自证（合成样本，**真值已知**）：长度/换行守恒 ＋ blank 段算法本身对得上 ---------- */
  const SYN_LINES = 238;
  const synBody = Array.from({ length: SYN_LINES }, (_, i) => (i % 17 === 0 ? '  ' : ' '.repeat(3))).join('\n');
  const synSrc = 'const A = String.raw`\n' + synBody + '\n`;\nconst B = 1;\n';
  const synBad = 'const A = String.raw`\n' + synBody + '\nfs.rmSync(tmpRoot, { recursive: true, force: true });\n`;\nconst B = 1;\n';
  const synGood = 'const A = String.raw`\n' + synBody + '\n（这里是合法字面量内容，没有删除调用）\n`;\nconst B = 1;\n';
  const gSyn = analyzeGroundE160(synSrc);
  const synBlankRunOk = gSyn.runLines === SYN_LINES && gSyn.runStartLine === 2 && gSyn.runEndLine === SYN_LINES + 1;
  const gBad = analyzeGroundE160(synBad);
  const gGood = analyzeGroundE160(synGood);
  const attrBad = attributeGroundE160(synBad, stripLiterals(synBad), gBad.runStartLine, gBad.runEndLine, band.maxRunLines);
  const attrGood = attributeGroundE160(synGood, stripLiterals(synGood), gGood.runStartLine, gGood.runEndLine, band.maxRunLines);
  t.check('E160-① **剥离器自证（合成样本，真值已知）**：`stripLiterals` 保持**长度守恒 ＋ 换行数守恒**'
    + '（下标仍可当锚点），且 `analyzeGroundE160()` 量出的"最长连续 blank 段"与**样本里逐字写下的行数**一致'
    + '（⇒ 自证与量尺本身都被证伪过，不是恒真式）',
    gSyn.lenSame && gSyn.nlSame && synBlankRunOk
      && gBad.lenSame && gBad.nlSame && gGood.lenSame && gGood.nlSame,
    `样本：\`String.raw\` 里 ${SYN_LINES} 行空白（${synSrc.length} B）⇒ 量到 blank 段 ${gSyn.runLines} 行`
      + `（应 ${SYN_LINES}）、区间 ${gSyn.runRegion}（应 :2-:${SYN_LINES + 1}）；`
      + `长度守恒=${gSyn.lenSame}／换行守恒=${gSyn.nlSame}；`
      + `坏样本 ${synBad.length} B（段内含 \`fs.rmSync(…recursive:true)\`）／好样本 ${synGood.length} B（纯字面量）—— 两者都守恒`);

  /* ---------- 1. 全仓普查：两个量现算 ---------- */
  const rows = files.map((abs) => {
    const src = fs.readFileSync(abs, 'utf8');
    const g = analyzeGroundE160(src);
    return { abs, file: path.relative(env.paths.root, abs).split(path.sep).join('\\'), src, g };
  });
  const measuredMaxRun = rows.reduce((a, r) => Math.max(a, r.g.runLines), 0);
  const overRows = rows.filter(r => r.g.runLines > band.maxRunLines);
  const legitMaxRun = rows.filter(r => r.g.runLines <= band.maxRunLines).reduce((a, r) => Math.max(a, r.g.runLines), 0);
  const measuredMinRatio = rows.reduce((a, r) => Math.min(a, r.g.nonBlankRatio), 1);
  const legitMinRatio = rows.filter(r => r.g.nonBlankRatio > 0).reduce((a, r) => Math.min(a, r.g.nonBlankRatio), 1);
  const relManagedOf = (rel) => !rel.split('\\').includes('._verify');
  const managedRows = rows.filter(r => relManagedOf(r.file));
  const managedMinRatio = managedRows.filter(r => r.g.nonBlankRatio > 0).reduce((a, r) => Math.min(a, r.g.nonBlankRatio), 1);
  const lenBad = rows.filter(r => !r.g.lenSame || !r.g.nlSame);

  /* ---------- 2. 判据（结构配对）：超阈值 且 段内**原样文本**含 A 档删除 API ⇒ 检出并逐段指名 ---------- */
  const attribution = rows.map(r => ({
    file: r.file, runLines: r.g.runLines, runRegion: r.g.runRegion, ratio: r.g.nonBlankRatio,
    ...attributeGroundE160(r.src, stripLiterals(r.src), r.g.runStartLine, r.g.runEndLine, band.maxRunLines)
  }));
  const blindSpots = attribution.filter(a => a.redRuns.length > 0);
  const longButClean = attribution.filter(a => a.runs.length > 0 && a.redRuns.length === 0);
  const blindTxt = blindSpots.map(a => {
    const parts = a.redRuns.map(p => `\`:${p.start}-:${p.end}\`（${p.lines} 行）—— `
      + p.hits.map(h => `${h.rule} @ ${h.lines.slice(0, 6).map(n => ':' + n).join('、')}${h.lines.length > 6 ? ` 等 ${h.lines.length} 处` : ''}`).join('；'));
    return `\`${a.file}\` ${parts.join(' ／ ')}`;
  }).join(' ｜ ');
  t.check('E160-② **结构配对的盲区检测（超 ' + band.maxRunLines + ' 行的连续 blank 段 ＋ 该段原样文本里含 A 档删除 API）**：'
    + '两维**同时**成立 ⇒ 该段被**检出并逐段指名 `文件:行号区间` ＋ 命中的 API**；'
    + '只有长度（合法长 `String.raw` 字面量）或只有 API（单行示例）**都不算**盲区 —— '
    + '这正是 `E160` 立案的 858 行：长度维度抓它、API 维度把它与"合法长字面量"分开。'
    + '⚠ **本条的判红职责在 `E160-ⓑ`（台账）**：已登记的那几段是**已知且正当**的（`String.raw` 夹具）——'
    + '若在这里判红就等于"已知边界每轮都红" ⇒ 判据会被改成能过（`D21`／`D23`）；'
    + '故这里只做**检出 ＋ 指名**，"**新增一处就红**"由 `E160-ⓑ` 的台账比对负责',
    true,
    `检出 **${blindSpots.length} 处**"超阈值且段内含删除 API"的长空白段，逐段指名：${blindTxt || '（无）'}；`
      + `扫描 ${rows.length} 个 .js；超阈值段 ${overRows.length} 个，其中**段内含删除 API 的 ${blindSpots.length} 个**、`
      + `**长但干净的 ${longButClean.length} 个**（后者照旧判绿 —— 见 E160-⑤ 的负对照）`);

  /* ---------- 3. 剥除率地板（自证的另一半；**受管面判红**） ----------
     ⚠ **本条不是"恒红式"，也不是"会误红合法输入"的那一档**（本件实测后按事实收窄，理由写全）：
      ① 地板只对**受管面**（`tests\*.js` ＋ `tests\lib\**` ＋ `tools\**`，**排除 `tests\._verify\`**）判红 ——
         `._verify\` 是 scratch 面，里面本来就有"整份被剥光"的历史取证件（实测
         `tests\._verify\review\e97-doc.js`：非空白 0/2086 B），那是**记录**、不是缺陷；
         把 scratch 面的取证产物当判红对象 ⇒ 判据会被别人的临时文件染红（`E145` 已经吃过这个亏）。
      ② 受管面实测**一个都没有**低于地板（0 个；受管面最小合法占比 0.2091）⇒ 对受管面是**真零容忍**。
      ③ `._verify\` 面**照旧报数**（`E160-③-i`）——"不判红"是**看得见的决定**，不是沉默。 */
  const belowFloorManaged = managedRows.filter(r => r.g.nonBlankRatio < band.minStripRatio);
  const belowFloorVerify = rows.filter(r => !relManagedOf(r.file) && r.g.nonBlankRatio < band.minStripRatio);
  const strippedToNothing = rows.filter(r => r.g.nonBlank === 0);
  t.check('E160-③ **剥除率地板（自证的另一半，受管面零容忍）**：受管面（`tests\\*.js` ＋ `tests\\lib\\**` ＋ `tools\\**`，'
    + '**排除 `tests\\._verify\\`**）每个文件的"剥后**非空白**字节占比"都必须 ≥ ' + band.minStripRatio
    + '（实测受管面最小合法 ' + managedMinRatio.toFixed(4) + '）—— 低于地板 ⇒ 判红并指名 '
    + '（"整份被剥光"的文件会让**所有**以剥后文本为地面的判据在该文件上读空气）',
    belowFloorManaged.length === 0,
    belowFloorManaged.length
      ? `判红：${belowFloorManaged.length} 个受管文件低于地板 ${band.minStripRatio} —— `
        + belowFloorManaged.map(r => `\`${r.file}\`（${r.g.nonBlankRatio.toFixed(4)}，非空白 ${r.g.nonBlank}/${r.g.bytes} B）`).join('；')
      : `受管面全部 ≥ ${band.minStripRatio}（${managedRows.length} 个文件，0 个低于地板；受管面最小 ${managedMinRatio.toFixed(4)}）；`
        + `扫描面全体最低 ${measuredMinRatio.toFixed(4)}（>0 的最低＝${legitMinRatio.toFixed(4)}）`);
  t.info(`\`E160-③-i\` **\`._verify\\\` 分面的地板读数（本批只报数、不判红 —— 取舍见 E160-③ 的注释）**：`
    + `低于地板 ${band.minStripRatio} 的 ${belowFloorVerify.length} 个`
    + `（${belowFloorVerify.map(r => `\`${r.file}\` ${r.g.nonBlankRatio.toFixed(4)}`).join('、') || '无'}）；`
    + `全扫描面**非空白为 0**（＝整份被剥光，任何判据都读空气）的 ${strippedToNothing.length} 个：`
    + `${strippedToNothing.map(r => `\`${r.file}\`（${r.g.bytes} B）`).join('、') || '无'}。`
    + `⚠ 这几个**都在 ` + '`._verify\\`' + `（scratch 面）**，是历史取证件，不是生产/门禁文件 ⇒ `
    + `本批据实**不把它们判红**，但也不假装它们不存在。`);

  /* ---------- 4. 基线一致（**锚点取自受管面**；阈值被改成漏掉那一号／改成误红合法长字面量 ⇒ 当场红） ---------- */
  const base = band.baseline;
  const managedOver = managedRows.filter(r => r.g.runLines > band.maxRunLines);
  const managedLegitMaxRun = managedRows.filter(r => r.g.runLines <= band.maxRunLines)
    .reduce((a, r) => Math.max(a, r.g.runLines), 0);
  const baseOk = Math.abs(managedMinRatio - base.managedMinNonBlankRatioLegit) < 1e-9
    && managedRows.reduce((a, r) => Math.max(a, r.g.runLines), 0) === base.managedMaxRunLines
    && managedLegitMaxRun === base.managedMaxRunLinesExcludingOver
    && stripSha12 === base.stripperSha12
    && managedRows.length >= base.managedFileCountLo && managedRows.length <= base.managedFileCountHi
    && rows.length >= base.fileCountLo && rows.length <= base.fileCountHi
    && band.maxRunLines > managedLegitMaxRun      /* 阈值必须**高于**合法最大（否则误红） */
    && band.maxRunLines < managedOver.reduce((a, r) => Math.max(a, r.g.runLines), 0)  /* 且**低于**实测最大 */
    && measuredMaxRun === base.maxRunLines        /* 全场最长（含 scratch）照旧比对 ⇒ 病灶消失也会红 */
    && band.minStripRatio <= managedMinRatio;     /* 地板必须**不高于**受管面合法最小（否则误红） */
  t.check('E160-④ **阈值与基线的自证**（`E156`／`E112` 的口径纪律：**数字必须可复算**）：'
    + '**受管面**锚点（最低占比 ' + base.managedMinNonBlankRatioLegit + '／最长段 ' + base.managedMaxRunLines
    + '／除超标外最长 ' + base.managedMaxRunLinesExcludingOver + '／文件数 ' + base.managedFileCountLo + '–' + base.managedFileCountHi
    + '／剥离器摘要 ' + base.stripperSha12 + '）**逐个等于本轮现算读数**，**且**阈值落在'
    + '"受管面合法最大 < 阈值 < 受管面实测最大"之间（' + managedLegitMaxRun + ' < ' + band.maxRunLines + ' < '
    + managedOver.reduce((a, r) => Math.max(a, r.g.runLines), 0) + '）—— '
    + '⇒ 把阈值改成能漏掉那一号（≥ ' + managedOver.reduce((a, r) => Math.max(a, r.g.runLines), 0) + '）、'
    + '或改成会误红合法长字面量（≤ ' + managedLegitMaxRun + '）**都当场红**；'
    + '剥离器源码一变（`stripLiterals.toString()` 摘要不符）也当场红。'
    + '⚠ **锚点只取受管面**（`._verify\` 是 scratch 面，最低占比全部来自它 ⇒ 锚它会被别人的临时文件染红）',
    baseOk,
    `受管面现算：最低非空白占比 ${managedMinRatio.toFixed(6)}（锚点 ${base.managedMinNonBlankRatioLegit}）、`
      + `最长段 ${managedOver.reduce((a, r) => Math.max(a, r.g.runLines), 0)}（锚点 ${base.managedMaxRunLines}）、除超标外最长 ${managedLegitMaxRun}（锚点 ${base.managedMaxRunLinesExcludingOver}）、`
      + `文件数 ${managedRows.length}（锚点 ${base.managedFileCountLo}–${base.managedFileCountHi}）；`
      + `阈值 ${band.maxRunLines} 落在 (${managedLegitMaxRun}, ${managedOver.reduce((a, r) => Math.max(a, r.g.runLines), 0)}) 内；`
      + `地板 ${band.minStripRatio} ≤ 受管面最低 ${managedMinRatio.toFixed(4)}；`
      + `全场（含 \`._verify\\\`，**只打印不锚定**）：最低占比 ${measuredMinRatio.toFixed(6)}、最长段 ${measuredMaxRun}（锚点 ${base.maxRunLines}）、`
      + `文件数 ${rows.length}（围栏 ${base.fileCountLo}–${base.fileCountHi}）；剥离器摘要 ${stripSha12}（锚点 ${base.stripperSha12}）；`
      + `长度／换行守恒违例 ${lenBad.length} 个（应 0）`);

  /* ---------- 5. D22（可证伪）：整段 blank ＋ 阈值失效 ＋ 两条负对照 ---------- */
  const mutThresholdMiss = ({ src, threshold }) => {         /* 同一判据、只换阈值 */
    const g = analyzeGroundE160(src);
    const a = attributeGroundE160(src, stripLiterals(src), g.runStartLine, g.runEndLine, threshold);
    return a.redRuns.length > 0;                              /* 红条件＝"有段超阈值**且**段内含 API" */
  };
  const d22Blanked = mutThresholdMiss({ src: synBad, threshold: band.maxRunLines });     /* 人为"整段 blank＋藏 API" ⇒ 必红 */
  const d22Clean = mutThresholdMiss({ src: synGood, threshold: band.maxRunLines });      /* 负对照 A：合法长字面量 ⇒ 必绿 */
  const d22Miss = mutThresholdMiss({ src: synBad, threshold: 900 });                     /* 阈值改到 900 ⇒ 漏掉那一号 */
  const d22NoApi = mutThresholdMiss({ src: synSrc, threshold: band.maxRunLines });       /* 负对照 B：整段 blank 但**无 API** ⇒ 必绿 */
  const realTarget = rows.find(r => r.file === 'tests\\harness-check.js');
  const realBlind = realTarget
    ? attributeGroundE160(realTarget.src, stripLiterals(realTarget.src),
      realTarget.g.runStartLine, realTarget.g.runEndLine, band.maxRunLines)
    : { overRuns: [], runs: [], redRuns: [], hits: [] };
  t.check('E160-⑤ D22（可证伪，**四支读数 ＋ 两条负对照**）：同一判据喂'
    + '㈠"人为把整段剥成 blank、且段内留下 `fs.rmSync(…,{recursive:true})`"的合成样本 ⇒ **必红并指名区间 ＋ API**；'
    + '㈡**同一段样本但把阈值改到 ' + 900 + '**（＝改到能漏掉那一号）⇒ **必由红转绿**（⇒ 判据不是恒红式，阈值真的在起作用）；'
    + '㈢**负对照 A**：同样 ' + SYN_LINES + ' 行的合法 `String.raw` 字面量、**段内没有任何删除 API** ⇒ **必绿**'
    + '（防"看到长段就判红"）；㈣**负对照 B**：**同一段空白但段内没有那行 API**（长度维度照旧超标）⇒ **必绿**'
    + '（⇒ 红的**必要条件**是"段内真有 A 档 API"，不是"段长"）；㈤盘上真文件 `tests\\harness-check.js` 的现状一并留痕',
    d22Blanked === true && d22Clean === false && d22Miss === false && d22NoApi === false && Boolean(realTarget),
    `㈠整段 blank ＋ 段内藏 API ⇒ 判红=${d22Blanked}（应 true）`
    + `（命中 ${attrBad.hits.map(h => h.rule).join('、') || '无'}）；`
    + `㈡同一段、阈值改到 900 ⇒ 判红=${d22Miss}（应 false ＝ **阈值真的在挡**，否则判据是恒红式）；`
    + `㈢负对照 A：${SYN_LINES} 行合法字面量、段内 API 命中 ${attrGood.hits.length} ⇒ 判红=${d22Clean}（应 false）；`
    + `㈣负对照 B：同一段空白但段内无 API（\`synSrc\`）⇒ 超阈值段 ${analyzeGroundE160(synSrc).blankRuns.filter(r => r.lines > band.maxRunLines).length}、`
    + `API 命中 ${attributeGroundE160(synSrc, stripLiterals(synSrc), 0, 0, band.maxRunLines).hits.length} ⇒ 判红=${d22NoApi}（应 false）；`
    + `㈤盘上 \`tests\\harness-check.js\`：超阈值段 ${realBlind.runs.map(r => `:${r.start}-:${r.end}（${r.lines} 行、段内 API ${r.hits.reduce((a, h) => a + h.lines.length, 0)} 处）`).join('、') || '（无）'}；`
    + `**该判据现状：进台账的段 ${realBlind.redRuns.length} 处** ⇒ 见下面 E160-ⓑ 的"已知盲区台账" `
    + `（**如实边界**：858 行那一段是 ` + '`String.raw`' + ` 夹具字面量（它生成本文件自己的子进程脚本），`
    + `段内每一次删除都发生在**子进程**里、不是本门禁进程在删；但判据**看不到**它 ⇒ 由 E160-⑥ 的第二路覆盖，`
    + `并由 E160-ⓑ 的台账锁住 —— **不声称"已消除"**）`);

  /* ---------- 5b. **已知盲区台账**（`E160` 交付 4 的落地：盲区"仍存在"，但必须被点名 ＋ 被锁住） ----------
     **为什么要有这张台账（而不是让 E160-② 直接判红）**：
       那一段 858 行**不是缺陷** —— 它是 `String.raw` 夹具字面量（`W5_FIXTURE_SSE` 等），
       **合法语法**、内容确实是"字符串"；剥离器把它 blank 是**正确行为**。真正的缺陷是
       "**判据以为自己看见了这个文件**" —— 故处置＝**逐条登记 ＋ 锁住 ＋ 第二路覆盖**，
       并且**任何一处新的盲区（清单外）⇒ 判红并指名**。三条同时成立才算"如实处置"：
         ①登记（`文件` ＋ `行数` ＋ 原因）；②锁住（条数冻结 ＋ 逐条 `sha12` 锚点 ＋ 行数逐个相符）；
         ③清单外的新盲区 ⇒ 红（这才是"新增即红"）。
     ⚠ 与 `E103` 的 `RM_LEGACY_E103`／`RM_RESIDUE_VERIFY_E103` **同款机制**（`E140`／`E145` 的先例）。
     ⚠ **为什么台账记"行数"而不记"行区间"**（本件实测后按事实收窄的口径，理由写全）：
       台账点名的是 `tests\harness-check.js` 自己 —— 而**这份文件每一轮都在被编辑**（本件落地前后
       那一段就漂了几百行，因为文件头插了新代码）。若把**绝对行号**钉进台账，每一次正当编辑都会让
       判据变红 ⇒ 人会去"把台账改成能过" ⇒ 正是 `D21`／`D23` 的退化路径。
       ⇒ 钉住的是**结构与规模**（哪个文件、多少行、含 A 档删除 API），行号**每轮现算并打印**；
         真正要抓的"**新出现一处盲区**"由"清单外的文件／条数超出"这一维负责（它对新增最敏感）。 */
  const GROUND_BLIND_LEDGER_E160 = [
    /* ⚠ **退役记录（`T-20261005-17` 4b，主代理裁定 ㈠）**：这里原本登记着
       `{ file: 'tests\\harness-check.js', lines: 858 }` 那条。本波把该夹具的收尾清理从
       `fs.rmSync(tmpRoot,{recursive:true,force:true})` 改成走安全出口 `env.removeLinkSafe(...)`
       （理由：那份生成物一旦被中断留在 `._verify\` 里，下一轮 `E103-B⑥` 就会把它当"未登记的新调用点"，
       而文件名带 per-run tag ⇒ 永远不在册 ⇒ 每轮随机复发）。
       于是该段**不再含 A 档删除 API** ⇒ 按 `E160-②` 自己的口径（"长度 ＋ API **两维同时成立**才算盲区"）
       它退化为**合法长字面量** ⇒ 本条按主代理裁定**退役**（不是把行内容改写成"现在没有 API"）。
       它的新归属＝下面 `GROUND_CLEAN_LONG_LEDGER_E160` 里那条"同段、同长 858"的登记。
       ⚠ 段长仍是 858 ⇒ `E160-④` 的长度锚点**不动**（它量的就是**长度**这一维）。 */
    {
      file: 'tests\\._verify\\review\\old-harness-0996ed0.js', lines: 858,
      why: '**旧版本字节副本**（从历史提交取出的 `harness-check.js`，D22／定点变异的基线，不是活动脚本）—— '
        + '`E103` 的 `RM_RESIDUE_VERIFY_E103` 已按 `kind: oldcopy` 登记同一批文件；'
        + '它的 blank 段与上一条**逐字同源**（同一份 `String.raw` 夹具）'
    },
    {
      file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', lines: 858,
      why: '同上（另一份 `harness-check.js` 的历史字节副本，同一份夹具）'
    },
    {
      file: 'tests\\._verify\\T-20261005-09\\harness-check.seat4b-inflight.js', lines: 858,
      why: '**别座位的在飞副本**（本门禁脚本某一轮的快照，落在 `._verify\` 这个 scratch 面）：'
        + '它的 blank 段与第一条**逐字同源** ⇒ 同属"已知且正当"；'
        + '⚠ 它随时会被删/被换 ⇒ 本台账按"盘上已消失**不判红**、只打印"的口径处理'
    }
  ];
  /** **"长但干净"的段**（超阈值、**段内没有任何删除 API**）的台账 ——
   *  例如 `harness-check.js` 里的 `W7_DOD_FIXTURE`（实测 251 行，段内零删除调用）。
   *  它们**不是缺陷**，恰恰是 `E160-⑤` 负对照在盘上的真实样本；登记它们是为了让
   *  "**冒出一处新的长但干净的段**"也能被看见（否则判据只看得见"藏了 API 的段"）。 */
  const GROUND_CLEAN_LONG_LEDGER_E160 = [
    { file: 'tests\\harness-check.js', lines: 290,
      why: '`const W7_DOD_FIXTURE = String.raw\\`…\\``（另一份内联夹具）：段内**零**删除调用 ⇒ '
        + '剥离器把它 blank 完全无害（这正是"长度维度不能单独判红"的盘上实证）' },
    { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', lines: 251, why: '同上（历史字节副本里的同一份夹具）' },
    { file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', lines: 251, why: '同上（另一份历史字节副本）' },
    { file: 'tests\\._verify\\T-20261005-09\\harness-check.seat4b-inflight.js', lines: 251, why: '同上（在飞快照里的同一份夹具）' },
    { file: 'tests\\harness-check.js', lines: 858,
      why: '**从盲区台账退役过来的那一段**（`T-20261005-17` 4b，主代理裁定 ㈠）：同一条 858 行的 '
        + '`const W5_FIXTURE_SSE = String.raw\\`…\\`` 夹具段 —— 本波把它的收尾清理改成走安全出口 '
        + '`env.removeLinkSafe(...)` 之后，段内**零** A 档删除 API ⇒ 按 `E160-②` 的口径它只算'
        + '"**长但干净**"（不是盲区），故在这里登记，盲区台账里对应那条同时退役' }
  ];
  const GROUND_BLIND_ANCHOR_E160 = {
    total: 3,                     /* 退役 `tests\harness-check.js` 那条（见上"退役记录"）⇒ 4 → 3 */
    sha12: require('node:crypto').createHash('sha256')
      .update(GROUND_BLIND_LEDGER_E160.map(e => `${e.file}|${e.lines}`).join('\n')).digest('hex').slice(0, 12)
  };
  /** 台账 ↔ 盘上实测的**双向**对账（纯函数，主断言与 D22 共用 —— `E153` 的教训）：
   *  · `extra`   ＝盘上有、台账里没有 ⇒ **必红并指名 `文件:行号区间`**（这才是"新增即红"）；
   *  · `mismatch`＝同名文件的**行数**与台账不符 ⇒ **必红**（规模变了必须重新登记）；
   *  · `missing` ＝台账里有、盘上找不到 ⇒ **只打印、不判红**（`._verify\` 是 scratch 面，
   *    快照生灭属正常 —— 把它判红会让判据被别人的临时文件染红，`E145` 已吃过这个亏）。
   *  @returns {{missing:Array,extra:Array,mismatch:Array}} */
  const blindAuditE160 = (ledger, disk) => {
    const missing = ledger.filter(e => !disk.some(d => d.file === e.file));
    /* `extra`／`mismatch` 按 **(文件, 段长) 对**比，而不是只按文件比（`T-20261005-17b` 修，理由实测）：
       同一个文件**可以合法地有多段**长段 —— 实测 `tests\harness-check.js` 现在就有两段：
       `W7_DOD_FIXTURE`（251 行）＋ 退役过来的 `W5_FIXTURE_SSE`（858 行）。
       只按文件比的话，第二段要么被当成"已在册"而**隐形**，要么把台账行与"第一段"错配成"行数不符"（本轮实测踩到）。
       按对比**更严**：某文件新冒出一段没登记的段长 ⇒ `extra` 照样红（正是本台账要抓的"新冒出一段长字面量"）。 */
    const keyOf160 = (o) => `${o.file}|${o.lines}`;
    const extra = disk.filter(d => !ledger.some(e => keyOf160(e) === keyOf160(d)));
    const mismatch = ledger
      .filter(e => disk.some(d => d.file === e.file) && !disk.some(d => keyOf160(d) === keyOf160(e)))
      .map(e => `\`${e.file}\`：台账 ${e.lines} 行 —— 盘上同文件**没有**这个段长的段（实测 `
        + `${disk.filter(d => d.file === e.file).map(d => d.lines).join('／')} 行）`);
    return { missing, extra, mismatch };
  };

  const diskBlind = attribution.flatMap(a => a.redRuns.map(p => ({
    file: a.file, start: p.start, end: p.end, lines: p.lines,
    apiLines: [...new Set(p.hits.flatMap(h => h.lines))].sort((x, y) => x - y),
    rules: p.hits.map(h => h.rule)
  })));
  const diskCleanLong = attribution.flatMap(a => a.runs.filter(p => p.hits.length === 0)
    .map(p => ({ file: a.file, start: p.start, end: p.end, lines: p.lines })));
  const blindAuditNow = blindAuditE160(GROUND_BLIND_LEDGER_E160, diskBlind);
  const cleanAuditNow = blindAuditE160(GROUND_CLEAN_LONG_LEDGER_E160, diskCleanLong);
  const blindTxtE160 = diskBlind.map(d =>
    `\`${d.file}\`:${d.start}-:${d.end}（${d.lines} 行；段内 A 档 API ${d.apiLines.map(n => ':' + n).join('、') || '无'}）`).join(' ｜ ') || '（无）';
  t.check('E160-ⓑ **已知盲区台账（`E160` 交付 4：盲区"仍存在"，但被登记 ＋ 被锁住 ＋ 被指名）**：'
    + '每一处"超阈值 **且** 段内含 A 档删除 API"的长空白段都必须在册（**`文件 ＋ 行数`**，条数锚点 '
    + GROUND_BLIND_ANCHOR_E160.total + '、逐条 `sha12` ' + GROUND_BLIND_ANCHOR_E160.sha12 + '）；'
    + '**清单外的任何一处 ⇒ 判红并指名 `文件:行号区间` ＋ 段内 API 行**；同名文件段行数与台账不符 ⇒ 判红；'
    + '台账里的文件在盘上消失 ⇒ **只打印、不判红**（`._verify\` 是 scratch 面）',
    blindAuditNow.extra.length === 0 && blindAuditNow.mismatch.length === 0
      && GROUND_BLIND_LEDGER_E160.length === GROUND_BLIND_ANCHOR_E160.total
      && cleanAuditNow.extra.length === 0 && cleanAuditNow.mismatch.length === 0,
    (blindAuditNow.extra.length || blindAuditNow.mismatch.length)
      ? `判红：**盘上新盲区 ${blindAuditNow.extra.length} 处** —— `
        + blindAuditNow.extra.map(d => `\`${d.file}\`:${d.start}-:${d.end}（${d.lines} 行；段内 A 档 API ${d.apiLines.map(n => ':' + n).join('、')}）`).join('；')
        + `；段行数不符 ${blindAuditNow.mismatch.length} 项 —— ${blindAuditNow.mismatch.join('；')}`
        + `；台账里盘上已消失 ${blindAuditNow.missing.length} 处（**不判红**）：`
        + blindAuditNow.missing.map(e => `\`${e.file}\``).join('、')
      : `台账 ↔ 盘上一致：在册 ${GROUND_BLIND_LEDGER_E160.length} 处 ＝ 盘上实测 ${diskBlind.length} 处；`
        + `台账里盘上已消失 ${blindAuditNow.missing.length} 处（不判红）；`
        + `实测 ${blindTxtE160}；锚点 \`sha12\` ${GROUND_BLIND_ANCHOR_E160.sha12}。`
        + `另：**"长但干净"的段**（超阈值、段内零删除 API）台账 ${GROUND_CLEAN_LONG_LEDGER_E160.length} 处 ↔ 盘上 ${diskCleanLong.length} 处`
        + `（新增/行数不符都会红 —— 免得"新冒出一段长字面量"无人看见）`);
  /* `E160-ⓑ` **退役后的非恒绿自证**（**只报数、不加断言条数** —— 本波主代理明确要求条数不变）：
     把**同一个** `blindAuditE160()` 喂两种内存变异（绝不落盘）：①台账里多一条"与盘上段长不符"的登记；
     ②盘上多一段"台账里没有的盲区" ⇒ 两支都必须**逐条指名**报出来。若"退役"把判据掏空成恒绿，这两支会报空。 */
  const mut160a = blindAuditE160(
    [...GROUND_BLIND_LEDGER_E160, { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', lines: 999 }], diskBlind);

  const mut160b = blindAuditE160(GROUND_BLIND_LEDGER_E160,
    [...diskBlind, { file: 'tests\\._verify\\新盲区-x.js', start: 1, end: 300, lines: 300, apiLines: [7], rules: ['rmSync(...,{recursive:true})'] }]);
  const mut160c = blindAuditE160(GROUND_BLIND_LEDGER_E160, diskBlind);      // 负对照＝盘上现测（应全空）
  t.info(`\`E160-ⓑ\` **已知盲区台账（每轮可见，绝不隐形；行号现算）**：`
    + diskBlind.map(d => `\`${d.file}\`:${d.start}-:${d.end}（${d.lines} 行；段内 A 档 API ${d.apiLines.map(n => ':' + n).join('、') || '无'}）`).join(' ｜ ')
    + `。⚠ 【**本波退役**】\`tests\\harness-check.js\` 那一段（858 行的 \`W5_FIXTURE_SSE\`）**已从本台账退役**`
    + `（\`T-20261005-17\`，主代理裁定 ㈠）：夹具收尾改走安全出口 \`env.removeLinkSafe()\` ⇒ 段内**零** A 档删除 API `
    + `⇒ 按 \`E160-②\` 自己的口径（长度＋API **两维同时成立**才算盲区）它只算"长但干净"，`
    + `新归属见 \`GROUND_CLEAN_LONG_LEDGER_E160\`：`
    + ((GROUND_CLEAN_LONG_LEDGER_E160.find(e => e.file === 'tests\\harness-check.js' && e.lines === 858) || {}).why || '（登记缺失）')
    + `。⚠ 段长仍是 **858** ⇒ \`E160-④\` 的长度锚点**不动**（它量的就是长度这一维）。`
    + `⇒ 处置仍是 **第二路覆盖 ＋ 台账锁住 ＋ 新盲区即红**，**不是**"已消除"；`
    + `任何**清单外**的超阈值段只要段内含 A 档删除 API，\`E160-ⓑ\` 当场红并指名 \`文件:行号区间\`。`
    + ` ｜ **长但干净**的在册 ${GROUND_CLEAN_LONG_LEDGER_E160.length} 处 ↔ 盘上 ${diskCleanLong.length} 处：`
    + diskCleanLong.map(d => `\`${d.file}\`:${d.start}-:${d.end}（${d.lines} 行）`).join('、')
    + ` ｜ 另有**真正合法的长字面量样本**（本件负对照在盘上的实证，段内零删除 API）：`
    + attribution.flatMap(a => a.runs.filter(pp => pp.hits.length === 0 && pp.lines > 100)
      .map(pp => `\`${a.file}\`:${pp.start}-:${pp.end}（${pp.lines} 行）`)).slice(0, 8).join('、'));
  t.info(`\`E160-ⓑ\` **退役后的非恒绿自证（内存变异，只报数、不加条数）**：`
    + `①台账多一条"段长不符"（\`tests\\harness-check.js\` 记 999 行、盘上 858）⇒ mismatch ${mut160a.mismatch.length} 项：`
    + `${mut160a.mismatch.join('；') || '（空 ⇒ 判据被掏空）'}；`
    + `②盘上多一段"清单外盲区"（\`tests\\._verify\\新盲区-x.js\` 300 行、段内 API :7）⇒ extra ${mut160b.extra.length} 处：`
    + `${mut160b.extra.map(d => d.file + ':' + d.start + '-:' + d.end).join('；') || '（空 ⇒ 判据被掏空）'}；`
    + `③负对照＝盘上现测（**同一次调用**）⇒ extra ${mut160c.extra.length}／mismatch ${mut160c.mismatch.length}（都应 0）。`);

  /* ---------- 6. 双路复核（同一纯函数喂两路）：合成读数 ＋ 盘上读数 ---------- */
  const dualExample = dualScanE160(synBad, scanRmApiStrippedE161);
  const dualGood = dualScanE160(synGood, scanRmApiStrippedE161);
  const dualReal = realTarget ? dualScanE160(realTarget.src, scanRmApiStrippedE161) : null;
  t.check('E160-⑥ **双路复核（同一纯函数 `dualScanE160(源, 谓词)` 喂两路）**：'
    + '①**剥离路**（判据现行地面）②**原样字节路**（覆盖剥离器盲区）—— 两路都给合成读数（**哪一路命中、命中在哪**）。'
    + '要求：两路**共用同一个谓词**（`E153` 的教训），主判据与 D22 都喂同一取值对象；'
    + '原样路多出来的命中＝"剥离器盲区里的形状"，**由第二路负责报告**（不是判红，也不是假装没看见）',
    dualExample.stripped.length === 0 && dualExample.raw.length === 1 && dualExample.onlyRaw.length === 1
      && dualGood.stripped.length === 0 && dualGood.raw.length === 0
      && !!(dualReal && dualReal.raw.length >= dualReal.stripped.length),
    `㈠合成"整段 blank ＋ 藏 API"：剥离路 ${dualExample.stripped.length} 处、原样路 ${dualExample.raw.length} 处、`
      + `**只在原样路** ${dualExample.onlyRaw.length} 处（${dualExample.onlyRaw.map(h => `${h.path}:L${h.line}`).join('、') || '无'}）`
      + `⇒ ${dualExample.summary.rule}；`
      + `㈡负对照（合法字面量）：剥离路 ${dualGood.stripped.length}／原样路 ${dualGood.raw.length}（都应 0）；`
      + `㈢盘上 \`tests\\harness-check.js\` 现状：剥离路 ${dualReal ? dualReal.stripped.length : '-'} 处、`
      + `原样路 ${dualReal ? dualReal.raw.length : '-'} 处、只在原样路 ${dualReal ? dualReal.onlyRaw.length : '-'} 处`
      + `（**这正是 858 行盲区的量化读数**：剥离路 **0**、原样路 **> 0** ⇒ 盲区**仍存在、但已被第二路覆盖**）`);

  /* ---------- 7. 每轮可见的读数 ＋ 如实边界（`PASS` 详情不打印 ⇒ 这里必须留痕） ---------- */
  const topRows = rows.slice().sort((a, b) => b.g.runLines - a.g.runLines).slice(0, 6);
  t.info(`\`E160\` 地面读数（**现算**；扫描面＝\`tests\\**\\*.js\` ＋ \`tools\\**\\*.js\`，与 \`E103\` 同口径、不跟随链接）：`
    + `${rows.length} 个 .js；**最长连续 blank 段** ${measuredMaxRun} 行（除超标外最长 ${legitMaxRun} 行；阈值 ${band.maxRunLines}）；`
    + `**剥后非空白占比** 全场最低 ${measuredMinRatio.toFixed(4)}（>0 的最低 ${legitMinRatio.toFixed(4)}；`
    + `**受管面**最低 ${managedMinRatio.toFixed(4)}；地板 ${band.minStripRatio}）；`
    + `长度／换行守恒违例 ${lenBad.length} 个；剥离器摘要 ${stripSha12}。`
    + ` TOP6：${topRows.map(r => `\`${r.file}\` ${r.g.runLines} 行 ${r.g.runRegion}`).join('；')}`);
  t.info(`\`E160\` **如实边界（不许含糊成"已解决"）**：模板串／多行字面量是**合法语法**，`
    + `剥离器**必然**把它们整段 blank ⇒ **盲区不可能被"彻底消灭"**。本件的处置是三条同时成立：`
    + `①**量化**（每个文件的剥除率 ＋ 最长 blank 段，现算）；`
    + `②**结构配对指名**（超 ${band.maxRunLines} 行 **且** 段内含 A 档删除 API ⇒ 检出并指名 \`文件:行号区间\` ＋ API，`
    + `"清单外的新盲区"由 E160-ⓑ 的台账判红）；`
    + `③**第二路覆盖**（\`dualScanE160\` 的原样字节路 —— 盲区里的形状由它报告）。`
    + `⇒ 正确的说法是"**盲区仍存在，但已被第二路覆盖 ＋ 超阈值即指名**"，**不是**"已消除"。`);
}

async function main() {
t.info(env.describe());

/* ---------------- 一、可注入时钟 ---------------- */
t.section('一、可注入时钟（班次边界用例的命门）');
{
  const clock = createClock({ mode: 'fixed', at: '2026-09-19T07:59:30' });
  t.check('fixed 模式：now() 固定在指定时刻，不随真实时间走',
    clock.snapshot().time === '07:59:30' && clock.now().getTime() === clock.now().getTime(),
    clock.snapshot().iso);

  /* 连读两次之间插入真实等待，fixed 时钟必须**纹丝不动** */
  const before = clock.now().getTime();
  const spin = Date.now(); while (Date.now() - spin < 20) { /* 忙等 20 ms */ }
  t.check('fixed 模式：真实时间流逝不影响 now()（可重复性的关键）',
    clock.now().getTime() === before, `真实等待 20 ms 后仍为 ${clock.snapshot().time}`);

  clock.advanceSec(60);
  t.check('advanceSec 前进一秒不差', clock.snapshot().time === '08:00:30', clock.snapshot().time);
  clock.advanceMin(60);
  t.check('advanceMin 前进到 09:00:30', clock.snapshot().time === '09:00:30', clock.snapshot().time);
  clock.reset();
  t.check('reset 回到种子时刻', clock.snapshot().time === '07:59:30', clock.snapshot().time);
  clock.at('2026-09-19T23:59:30');
  t.check('at 可跳到任意时刻（验跨零点）',
    clock.snapshot().time === '23:59:30' && clock.snapshot().date === '2026-09-19', clock.snapshot().iso);

  const later = clock.now().getTime();
  clock.advanceSec(60);
  t.check('跨零点：日期与时间同时前进到次日 00:00:30',
    clock.snapshot().date === '2026-09-20' && clock.snapshot().time === '00:00:30' &&
    clock.now().getTime() === later + 60000, clock.snapshot().iso);

  t.check('source() 提供 () => Date 形式，便于注入被测代码',
    typeof clock.source() === 'function' && clock.source()() instanceof Date, '');

  const real = createClock({ mode: 'real' });
  const delta = Math.abs(real.now().getTime() - Date.now());
  t.check('real 模式返回真实时间（偏差 < 1 s）', delta < 1000, `${delta} ms`);

  const off = createClock({ mode: 'offset', at: '2026-09-19T10:00:00', offsetMs: 3600 * 1000 });
  t.check('offset 模式以真实时间为基准加偏移',
    Math.abs(off.now().getTime() - (Date.now() + 3600 * 1000)) < 2000, off.snapshot().iso);

  for (const mode of ['real', 'offset']) {
    let threw = false;
    try { createClock({ mode }).advanceSec(1); } catch { threw = true; }
    if (!threw) t.check(`${mode} 模式拒绝 advanceSec（只读时钟不得被推进）`, false, '未抛错');
  }
  t.check('real/offset 模式拒绝 advanceSec/at（防止用例误以为时间可控）', true,
    '两种只读时钟均已抛错');

  const keys = Object.keys(BOUNDARIES);
  t.check(`班次边界常量齐备（${keys.length} 个：交班前后/跨零点/跨月/跨年）`,
    keys.length >= 6 && keys.includes('morningBefore') && keys.includes('yearEnd'), keys.join(', '));
  t.check('边界常量都是可解析时间', keys.every(k => !Number.isNaN(parseTime(BOUNDARIES[k]).getTime())), '');

  let badThrew = false;
  try { parseTime('这不是时间'); } catch { badThrew = true; }
  t.check('非法时间输入会抛错（不静默返回 Invalid Date）', badThrew, '');
}

/* ---------------- 二、确定性样本 ---------------- */
t.section('二、确定性样本（同一用例任意时刻跑结果都应一致）');
{
  const m1 = fixture.makeFrame({ i: 0, at: '2026-09-19 10:00:00' });
  const m2 = fixture.makeFrame({ i: 0, at: '2026-09-19 10:00:00' });
  t.check('makeFrame 同参同结果（无隐藏随机）', JSON.stringify(m1) === JSON.stringify(m2), '');

  const expect = Number(Math.hypot(m1.velocity_x, m1.velocity_y).toFixed(2));
  t.check('makeFrame 自洽：speed = √(vx²+vy²)（术语表口径）',
    m1.speed === expect, `speed=${m1.speed}，计算=${expect}`);
  t.check('makeFrame 区分两个深度：cameraDepth ≠ depth（C-32 / IF-C.9）',
    m1.cameraDepth !== m1.depth, `cameraDepth=${m1.cameraDepth}，depth=${m1.depth}`);
  t.check('makeFrame 的 13 个字段与附录 2 对齐',
    fixture.REPORT_FIELDS.every(k => k in m1) && Object.keys(m1).length === 13,
    `实际 ${Object.keys(m1).length} 个`);

  const frames = fixture.makeFrames({ count: 5, startIndex: 100 });
  const times = frames.map(f => f.collectTime);
  t.check('makeFrames 按 startAt 起、每秒一条、时间严格递增',
    times[0] === '2026-09-19 10:00:00' && times[1] === '2026-09-19 10:00:01' &&
    times[4] === '2026-09-19 10:00:04', times.join(' , '));
  t.check('makeFrames 的 startIndex 能错开波形（避免批次间完全相同）',
    frames[0].speed !== fixture.makeFrames({ count: 1, startIndex: 0 })[0].speed, '');

  const c1 = fixture.makeCurve({ kind: 'depth', count: 160 });
  const c2 = fixture.makeCurve({ kind: 'depth', count: 160 });
  t.check('makeCurve 同种子同结果（PRNG 固定种子）',
    JSON.stringify(c1.samples) === JSON.stringify(c2.samples), '');
  t.check('makeCurve 量程上下限与采样点一致',
    c1.minValue === Math.min(...c1.samples) && c1.maxValue === Math.max(...c1.samples), '');
  t.check('makeCurve 的 durationSec／intervalSec／sampleCount 语义一致且互不混同',
    c1.sampleCount === 160 && c1.intervalSec === 1 && c1.durationSec === 160, '');
  t.check('different seed 会产生不同序列（否则"确定性"等于退化）',
    JSON.stringify(fixture.makeCurve({ kind: 'depth', seed: 1 }).samples) !==
    JSON.stringify(fixture.makeCurve({ kind: 'depth', seed: 2 }).samples), '');

  const snap = fixture.makeSnapshot();
  t.check('makeSnapshot 提供完整样本包（设备/工单/标准/帧/两条曲线）',
    Boolean(snap.device && snap.task && snap.standard) &&
    snap.frames.length === 5 && snap.curves.depth && snap.curves.speed, '');
}

/* ---------------- 三、错误注入（验失败路径） ---------------- */
t.section('三、错误注入（IF-B.9 补传、IF-D.9 降级这类失败路径靠它）');
{
  let ok = 0;
  const flaky = harness.injectFailure(() => { ok++; return 'ok'; }, { failAt: 2, times: 1 });
  const r1 = flaky();                     // 第 1 次正常
  let threw2 = false;
  try { flaky(); } catch { threw2 = true; }  // 第 2 次抛错
  const r3 = flaky();                     // 第 3 次恢复
  t.check('injectFailure 在第 failAt 次抛错、之后恢复',
    r1 === 'ok' && threw2 === true && r3 === 'ok' && ok === 2,
    `成功 ${ok} 次，第 2 次抛错=${threw2}`);

  const always = harness.injectFailure(() => 'x', { failAt: 1, times: 99 });
  let count = 0;
  for (let i = 0; i < 3; i++) { try { always(); } catch { count++; } }
  t.check('times 指定连续失败次数', count === 3, `实测失败 ${count} 次`);

  const fn = harness.injectFailure(() => 1, { error: new Error('自定义故障') });
  let msg = '';
  try { fn(); } catch (e) { msg = e.message; }
  t.check('可自定义错误对象（便于断言错误分支）', msg === '自定义故障', msg);
}

/* ---------------- 四、服务进程启停（后端联调用） ---------------- */
t.section('四、服务启停与端口（后端 HTTP/SSE 用例的底座）');
{
  const p1 = await harness.allocPort();
  const p2 = await harness.allocPort();
  t.check('allocPort 返回两个不同端口', p1 > 0 && p2 > 0 && p1 !== p2, `${p1} / ${p2}`);

  /* 临时造一个最小 HTTP 服务脚本，验 startService 能起、能探活、能停、日志落文件 */
  const dir = harness.makeTempDir('svc-script');
  const script = path.join(dir, 'mini-server.js');
  fs.writeFileSync(script, [
    "'use strict';",
    "const http = require('node:http');",
    "const port = Number(process.env.DSH_PORT);",
    "http.createServer((req, res) => {",
    "  if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'});",
    "    return res.end(JSON.stringify({ status: 1, env: process.env.DSH_ENV })); }",
    "  res.writeHead(404); res.end('nope');",
    "}).listen(port, '127.0.0.1', () => console.log('mini-server listening ' + port));"
  ].join('\n'), 'utf8');

  let svc = null;
  try {
    svc = await harness.startService({ script, port: p1, readyPath: '/health', timeoutMs: 8000 });
    const res = await fetch(`http://127.0.0.1:${svc.port}/health`);
    const body = await res.json();
    t.check('startService 能拉起服务并就绪探测通过（DSH_PORT 已注入）',
      res.ok && body.status === 1 && svc.port === p1, JSON.stringify(body));
    t.check('DSH_ENV 注入子进程且不把 prod 透传（D16 硬要求）',
      body.env !== 'prod', `子进程 DSH_ENV=${body.env}`);
    t.check('子进程输出**落文件**（受限沙箱下管道会 EPERM）',
      svc.output().includes('mini-server listening'), svc.output().trim().split('\n')[0]);

    const missing = await fetch(`http://127.0.0.1:${svc.port}/nope`);
    t.check('服务按预期返回 404（确认不是同一个静态假响应）', missing.status === 404, '');
  } finally {
    if (svc) await svc.stop();
  }
  await new Promise(r => setTimeout(r, 150));
  let down = false;
  try { await fetch(`http://127.0.0.1:${p1}/health`); } catch { down = true; }
  t.check('stop() 之后端口不再响应（进程确实被停掉）', down, '');
  harness.removeLinkSafe(dir, { recursive: true, force: true });

  /* ====================== W6：进程入口与运行骨架（server\index.js / server\http\router.js） ======================
     本节原来只验"夹具自身能起停一个临时 mini-server"，验不到**真交付的进程入口**。
     W6 落地后在这里扩断言：能起、能查、监听范围、能优雅退、SSE 骨架、异常不静默 —— 全部是**行为判据**
     （真的起进程、真的打 HTTP 请求、真的读日志），不匹配源码字符串（D23）。
     夹具脚本在本节内**写成文件**再以子进程运行（与本节上面的 mini-server 同一手法）：
       · 为什么必须另起进程：优雅退出要验"进程退出码 + 端口释放 + 无残留进程"，进程内证明不了；
       · 为什么结果走文件而不是 stdout：受限环境下子进程管道会 EPERM（见本节上方与 tests/env.js）；
       · 为什么夹具写在 tests\._verify 之下：该目录已被 .gitignore 忽略（D16：测试产物只允许落这里）。 */
  const w6Root = path.join(env.paths.root, 'server');
  t.check('W6：进程入口文件存在（server\\index.js + server\\http\\router.js）',
    fs.existsSync(path.join(w6Root, 'index.js')) && fs.existsSync(path.join(w6Root, 'http', 'router.js')),
    path.relative(env.paths.root, w6Root));

  if (fs.existsSync(path.join(w6Root, 'index.js'))) {
    const w6 = require('../server/index.js');        // 只为读配置解析与挂载位（不起服务）
    const { createRouter } = require('../server/http/router');

    /* ---- 1. 配置解析：默认仅回环 + 可被环境变量/命令行覆盖 ---- */
    {
      const d = w6.resolveConfig({ argv: [], env: {}, boardConfig: {} });
      t.check('W6：默认监听 127.0.0.1:8787（默认仅回环，遵 NFR-25/AC-09）',
        d.host === '127.0.0.1' && d.port === 8787 && d.sources.host === 'default' && d.sources.port === 'default',
        `${d.host}:${d.port}（来源 ${d.sources.host}/${d.sources.port}）`);

      const e = w6.resolveConfig({ argv: [], env: { DSH_BOARD_PORT: '19001', DSH_BOARD_HOST: '127.0.0.2' }, boardConfig: {} });
      t.check('W6：DSH_BOARD_PORT / DSH_BOARD_HOST 能覆盖默认值（来源被记录）',
        e.port === 19001 && e.host === '127.0.0.2' && e.sources.port === 'env:DSH_BOARD_PORT',
        `${e.host}:${e.port}（${e.sources.port}）`);

      const c = w6.resolveConfig({ argv: ['--port', '19002'], env: { DSH_BOARD_PORT: '19001' }, boardConfig: {} });
      t.check('W6：命令行 --port 覆盖环境变量（优先级＝默认＜配置＜环境变量＜命令行）',
        c.port === 19002 && c.sources.port === 'cli', `port=${c.port}（${c.sources.port}）`);

      let badPort = false;
      try { w6.resolveConfig({ argv: ['--port', 'abc'], env: {}, boardConfig: {} }); } catch { badPort = true; }
      t.check('W6：非法端口被显式拒绝（不静默回落到默认端口 —— 否则 `--prot 9000` 这类笔误会隐身）',
        badPort, '--port abc 应抛错');
    }

    /* ---- 2. 挂载位：四个 W6 空壳注册位必须在，且必须**自报未挂载** ----
       （W5-③ 口径推进见下面 2b：**总挂载位＝5**（4 个空壳 ＋ auth 真实挂载）；
        本条的四个空壳断言**原样保留** —— 它是"未装配时不许假装已挂载"的裸 router 形态断言。） */
    {
      const r = createRouter({ getHealth: () => ({ ok: true }) });
      const mounts = [r.mountIfA(), r.mountIfD(), r.mountUpload(), r.mountSSE()];
      t.check('W6：四个挂载位（IF-A/IF-D/上传/SSE 推送）齐备且显式自报"未挂载"（本包不实现业务逻辑）',
        mounts.every(m => m && m.mounted === false && typeof m.by === 'string' && m.by.length > 0) &&
        mounts.map(m => m.mount).join(',') === 'ifA,ifD,upload,sse',
        mounts.map(m => `${m.mount}→${m.by}`).join(' / '));
      t.check('W6：本包只注册 /health 与 /events（业务路由留给 W1/W2/W4/W5，不越界）',
        r.list().join(' , ') === 'GET /events , GET /health', r.list().join(' , '));
    }

    /* ---- 2b. W5-③ 挂载位**总数**：4 个 W6 空壳 ＋ auth 真实挂载 ＝ 5 ----
       口径推进说明（回执要逐字交代）：原断言只数 W6 的 4 个空壳（`router.js` 内建描述符）。
       auth **不是** `router.js` 的空壳 —— 本仓既有分工是"注册动作写进对应包的路由文件"
       （见 `router.js` 挂载位注释与 6b/6c/6d 段的写法），故 `mountAuth()` 在 `routes/auth.js` 内部注册，
       自报 `mounted:true` / `by:'W5-3'` / 5 条路由。这里**两条都留**：四个空壳仍必须自报未挂载（上面 2），
       总清单必须是 5 且 auth 必须自报已接线（本条）—— "总数变 5"是推进，不是把空壳判据删掉换松的。 */
    {
      const mountDb = harness.makeTempDb({ name: 'w5-auth-mount' });
      try {
        const dbApi = require('../server/db');
        dbApi.initSchema(mountDb.db, '2026-09-28 10:00:00');
        const { createAuth } = require('../server/services/auth');
        const { mountAuth } = require('../server/http/routes/auth');
        const r5 = createRouter({ getHealth: () => ({ ok: true }) });
        const authMount = mountAuth(r5, {
          auth: createAuth({ db: mountDb.db, silent: true, now: () => new Date('2026-09-28T10:00:00') })
        });
        const slots = [r5.mountIfA(), r5.mountIfD(), r5.mountUpload(), r5.mountSSE(), authMount];
        t.check('W5-③：挂载位清单共 **5** 个（W6 的 ifA/ifD/upload/SSE 四个空壳 ＋ auth 真实挂载 W5-3）；' +
          'auth 自报 `mounted:true` 且注册 5 条 `/auth/*` 路由，四个空壳仍自报 `mounted:false`',
          slots.length === 5 &&
          slots.slice(0, 4).every(m => m.mounted === false) &&
          authMount.mounted === true && authMount.by === 'W5-3' && authMount.routes.length === 5 &&
          slots.map(m => m.mount).join(',') === 'ifA,ifD,upload,sse,auth' &&
          r5.list().filter(p => p.includes('/auth/')).length === 5,
          slots.map(m => `${m.mount}(${m.by})${m.mounted ? '已接线' : '空壳'}`).join(' , '));
      } finally {
        mountDb.close();
      }
    }

    /* ---- 2c. W5-③（ADR-0007）**真起进程**的鉴权端到端 ----
       为什么必须另起进程：ADR-0007 的判据横跨"启动期（初始化码登记到 op_log / E18 备份日志）→
       HTTP 面（init/login/change/logout）→ 库内状态"，进程内建服务证明不了"装配真的生效"。
       手法与本节上面一致：`harness.startService`（stdio 落文件，受限环境下管道会 EPERM）、
       临时库/端口/目录全部唯一（门禁允许并发跑）。
       前置造数：先按**当前**结构建库，再把 `schema_meta.schema_version` 改回**上一版**
       （＝`SCHEMA_VERSION − 1`，**由单一真源现算、不写死数字** —— 写死会让每次升版都假红一次，
       实测踩过：`SCHEMA_VERSION` 5 → 6 后本段日志变成"结构版本升级 4 → 6"，而断言里写的是 `4 → 5`）——
       于是真进程启动时命中 E18 判据②"结构版本升级 <上一版> → <当前版>"，启动日志里的**迁移前备份行**
       与磁盘上的备份文件都成为可断言的**行为**证据（不是匹配源码字符串）。 */
    {
      const authTmp = harness.makeTempDir('w5-auth-e2e');
      const authDbFile = path.join(authTmp, 'board.db');
      const authPort = await harness.allocPort();
      const PW1 = 'W5E2E-Pass-1';
      const PW2 = 'W5E2E-Pass-2';
      const { DatabaseSync } = require('node:sqlite');
      const dbApi = require('../server/db');
      /* 上一版结构版本号：**期望值全部由它现算**（`SCHEMA_VERSION` 是唯一真源，ADR-0004 D21） */
      const PREV_SCHEMA_VERSION = String(Number(dbApi.SCHEMA_VERSION) - 1);
      {
        const seed = new DatabaseSync(authDbFile);
        dbApi.initSchema(seed, '2026-09-28 10:00:00');
        seed.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(PREV_SCHEMA_VERSION, 'schema_version');
        seed.close();
      }
      let authSvc = null;
      try {
        authSvc = await harness.startService({
          script: path.join(env.paths.root, 'server', 'index.js'),
          args: ['--port', String(authPort), '--data-dir', authTmp, '--db-file', authDbFile],
          port: authPort, readyPath: '/health', timeoutMs: 20000
        });
        const base = `http://127.0.0.1:${authSvc.port}`;
        const call = async (method, p, body, headers) => {
          const init = { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
          if (method === 'POST') init.body = JSON.stringify(body === undefined ? {} : body);
          const res = await fetch(base + p, init);
          const text = await res.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* 非 JSON 正文 */ }
          return { status: res.status, body: parsed, text };
        };
        const withDb = fn => {
          const c = new DatabaseSync(authDbFile);
          try { return fn(c); } finally { c.close(); }
        };

        /* ① 启动日志：E18 迁移前备份（判据②）＋ op_log 审计 ＋ 库内版本已升到 `SCHEMA_VERSION` */
        const health = await call('GET', '/health');
        const logText = authSvc.output();
        const backupLine = (logText.match(/\[启动\] E18 迁移前已备份：([^\r\n]+)/) || [])[1] || '';
        const backupPath = backupLine.split('（')[0].trim();
        const auditAfterStart = withDb(c => c.prepare(
          "SELECT op_type, result, content FROM op_log WHERE op_type = '迁移前备份' ORDER BY id").all());
        const versionAfterStart = withDb(c => c.prepare(
          "SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value);
        /* ⚠ 结构版本号**一律现算**（`previous → current` 由 `dbApi.SCHEMA_VERSION` 推出）：
           写死字面量会让本段在**每次升版**时假红一次（ADR-0004 D21：期望值由已知正确的量算出）。 */
        const versionUpgradeRe = new RegExp('结构版本升级 ' + PREV_SCHEMA_VERSION + ' → ' + dbApi.SCHEMA_VERSION);
        t.check('W5-③ 端到端（真进程）：启动期命中 E18 判据②（库内版本 ' + PREV_SCHEMA_VERSION +
          ' ≠ ' + dbApi.SCHEMA_VERSION + '）⇒ 启动日志写明' +
          '「迁移前已备份：<path>（原因 结构版本升级 ' + PREV_SCHEMA_VERSION + ' → ' + dbApi.SCHEMA_VERSION + '…）」、' +
          '备份文件**真的落盘**且备份内是**迁移前**的库、' +
          '`op_log` 有审计行（result=成功、含文件名）、启动后库内版本已升到 ' + dbApi.SCHEMA_VERSION + '；' +
          '**F20 对照**：本库本来就有 `op_log`（审计一次成功）⇒ 该行必须是 `审计 op_log=ok #<id>` 且**不含** `backfill`',
          health.status === 200 && backupPath !== '' && fs.existsSync(backupPath) &&
          versionUpgradeRe.test(backupLine) &&
          auditAfterStart.length === 1 && auditAfterStart[0].result === '成功' &&
          String(auditAfterStart[0].content).includes(path.basename(backupPath)) &&
          versionAfterStart === dbApi.SCHEMA_VERSION &&
          /审计 op_log=ok #\d+/.test(backupLine) && !backupLine.includes('backfill') &&
          (() => {
            const v = require('../server/db/maintain').verifyBackup(backupPath);
            return v.ok && v.tables > 0;
          })(),
          `备份行=${backupLine || '(未出现)'}；审计=${JSON.stringify(auditAfterStart)}；版本=${versionAfterStart}`);

        /* ② 挂载位清单（启动日志）与路由清单：5 项（含 auth(W5-3)已接线）＋ 5 条 /auth/* */
        const routeLine = (logText.match(/\[路由\] 已注册：([^\r\n]+)/) || [])[1] || '';
        const mountLine = (logText.match(/挂载位状态[^\r\n]*/) || [])[0] || '';
        t.check('W5-③ 端到端（真进程）：启动日志的**挂载位清单共 5 项**（ifA/ifD/upload/SSE/auth，' +
          'auth 自报 `auth(W5-3)已接线`），路由清单里 `/auth/*` 恰好 5 条（init/login/logout/change/status）',
          (mountLine.match(/(?:ifA|ifD|upload|sse|auth)\((?:W\d(?:-\d)?)\)(?:已接线|空壳)/g) || []).length === 5 &&
          mountLine.includes('auth(W5-3)已接线') &&
          (routeLine.match(/\/auth\//g) || []).length === 5 &&
          ['GET /auth/status', 'POST /auth/init', 'POST /auth/login', 'POST /auth/logout', 'POST /auth/change']
            .every(p => routeLine.includes(p)),
          `挂载位行=${mountLine.slice(0, 200)}；路由行含 /auth/* ${(routeLine.match(/\/auth\//g) || []).length} 条`);

        /* ③ 未初始化态：status 200/不含秘密；login ⇒ 409；初始化码**从 op_log 读**（不依赖控制台） */
        const st0 = await call('GET', '/auth/status');
        const codeRow = withDb(c => c.prepare(
          "SELECT content FROM op_log WHERE op_type = '口令初始化码' ORDER BY id DESC LIMIT 1").get());
        const initCode = (/一次性初始化码=([0-9a-f]{12})/.exec(codeRow ? codeRow.content : '') || [])[1] || '';
        const login0 = await call('POST', '/auth/login', { password: PW1 });
        t.check('W5-③ 端到端（真进程）：未初始化 ⇒ `GET /auth/status` 200 且 `initialized=false`、' +
          '**正文不含任何秘密**（无 salt/hash/token/初始化码）；`POST /auth/login` ⇒ 409 `not_initialized`；' +
          '一次性初始化码**从 op_log 读得到**（12 位 hex，不依赖控制台打印）',
          st0.status === 200 && st0.body && st0.body.ok === true && st0.body.initialized === false &&
          !/"(salt|hash|token)"/.test(st0.text) && !st0.text.includes(initCode) &&
          login0.status === 409 && login0.body && login0.body.error === 'not_initialized' &&
          /^[0-9a-f]{12}$/.test(initCode),
          `status=${st0.status}/initialized=${st0.body && st0.body.initialized}；login=${login0.status}/` +
          `${login0.body && login0.body.error}；码形状=${/^[0-9a-f]{12}$/.test(initCode) ? '12 位 hex' : '异常'}`);

        /* ④ init ⇒ 200；同码第二次 ⇒ 409（唯一入口只走一次）；库里只存派生值 */
        const init1 = await call('POST', '/auth/init', { code: initCode, password: PW1 });
        const init2 = await call('POST', '/auth/init', { code: initCode, password: PW2 });
        const cred = withDb(c => c.prepare('SELECT username, algo, params, salt, hash FROM auth_credential').all());
        t.check('W5-③ 端到端（真进程）：`POST /auth/init{code,password}` ⇒ **200**（且正文不回显码）；' +
          '同码第二次 ⇒ **409** `already_initialized`；库里只有一行凭证且 **`salt`/`hash` ≠ 口令**、' +
          '`algo=scrypt`、`params=N=16384,r=8,p=1,keylen=32`',
          init1.status === 200 && init1.body && init1.body.initialized === true &&
          !init1.text.includes(initCode) &&
          init2.status === 409 && init2.body && init2.body.error === 'already_initialized' &&
          cred.length === 1 && cred[0].algo === 'scrypt' &&
          cred[0].params === 'N=16384,r=8,p=1,keylen=32' &&
          cred[0].salt !== PW1 && cred[0].hash !== PW1 && !cred[0].hash.includes(PW1) &&
          /^[0-9a-f]{64}$/.test(cred[0].hash) && /^[0-9a-f]{32}$/.test(cred[0].salt),
          `init=${init1.status}；initAgain=${init2.status}；凭证=${JSON.stringify(cred.map(x => ({ u: x.username, algo: x.algo, params: x.params })))}`);

        /* ⑤ 登录 200（64 位 hex 令牌）⇒ 改密 200 ⇒ 旧令牌立即失效（logout 401）⇒ 新口令登录 200、旧口令 401 */
        const login1 = await call('POST', '/auth/login', { password: PW1 });
        const token = login1.body && login1.body.token;
        const wrong = await call('POST', '/auth/login', { password: 'definitely-wrong-1' });
        const chg = await call('POST', '/auth/change', { oldPassword: PW1, newPassword: PW2 },
          { Authorization: 'Bearer ' + token });
        const outOld = await call('POST', '/auth/logout', {}, { Authorization: 'Bearer ' + token });
        const loginNew = await call('POST', '/auth/login', { password: PW2 });
        const loginOldPw = await call('POST', '/auth/login', { password: PW1 });
        /* 改密后的**新**令牌再登出一次 ⇒ 200（留痕里才会出现"登出"这一类；上一条旧令牌登出按设计是 401） */
        const outNew = await call('POST', '/auth/logout', {},
          { Authorization: 'Bearer ' + String(loginNew.body && loginNew.body.token) });
        t.check('W5-③ 端到端（真进程）：`POST /auth/login` ⇒ **200** 且 token 为 64 位 hex（含 `expiresAt`）；' +
          '`POST /auth/change`（Bearer）⇒ **200** 并**强制清会话**（旧令牌 `logout` ⇒ **401**）；' +
          '新口令登录 **200**（其令牌 `logout` ⇒ 200）、旧口令 **401**；错误口令 **401 且响应体不下发原因**',
          login1.status === 200 && /^[0-9a-f]{64}$/.test(String(token)) &&
          typeof (login1.body && login1.body.expiresAt) === 'string' &&
          wrong.status === 401 && wrong.body && wrong.body.error === 'bad_credentials' &&
          wrong.body.reason === undefined &&
          chg.status === 200 && chg.body && chg.body.requireRelogin === true &&
          outOld.status === 401 && outOld.body && outOld.body.error === 'unauthorized' &&
          loginNew.status === 200 && /^[0-9a-f]{64}$/.test(String(loginNew.body && loginNew.body.token)) &&
          loginOldPw.status === 401 && outNew.status === 200,
          `login=${login1.status}(token ${String(token).length} hex)；wrong=${wrong.status}/${wrong.body && wrong.body.error}` +
          `（reason 未下发=${wrong.body && wrong.body.reason === undefined}）；change=${chg.status}；` +
          `旧令牌登出=${outOld.status}；新口令登录=${loginNew.status}（其令牌登出=${outNew.status}）；` +
          `旧口令登录=${loginOldPw.status}`);

        /* ⑥ 错误次数与锁定（HTTP 面）：连续失败达到阈值 ⇒ 423 `locked` + `retryAfterSec`；
           此后**即使口令正确也 423**（ADR-0007 D2 —— 这一条在 HTTP 面也要能被看到，不能只在服务层验）。 */
        const lockAttempts = [];
        for (let i = 0; i < 5; i++) lockAttempts.push(await call('POST', '/auth/login', { password: 'lock-probe-' + i }));
        const lockedRight = await call('POST', '/auth/login', { password: PW2 });
        t.check('W5-③ 端到端（真进程）：连续失败达到阈值（`maxFailures`）后 ⇒ **423 `locked`** 且带 ' +
          '`retryAfterSec`；锁定期间**口令正确也 423**（不是 200）—— ADR-0007 D2 的"锁定"在 HTTP 面同样成立',
          lockAttempts.some(r => r.status === 423 && r.body && r.body.error === 'locked' &&
            typeof r.body.retryAfterSec === 'number' && r.body.retryAfterSec > 0) &&
          lockedRight.status === 423 && lockedRight.body && lockedRight.body.error === 'locked' &&
          typeof lockedRight.body.retryAfterSec === 'number' && lockedRight.body.reason !== undefined,
          `5 次错误口令的状态=${lockAttempts.map(r => r.status).join('/')}；` +
          `正确口令在锁定中=${lockedRight.status}/${lockedRight.body && lockedRight.body.error}` +
          `（retryAfterSec=${lockedRight.body && lockedRight.body.retryAfterSec}）`);

        /* ⑦ 留痕与明文（真进程口径）：六类各≥1、含来源 IP；库里/op_log 里不含口令明文 */
        const auditRows = withDb(c => c.prepare(
          'SELECT op_type, result, content FROM op_log ORDER BY id').all());
        const types = auditRows.map(r => r.op_type);
        const dbBytes = fs.readFileSync(authDbFile);
        t.check('W5-③ 端到端（真进程）：留痕含 **口令初始化码 / 口令初始化 / 解锁 / 解锁失败 / 账号锁定 / 改密 / 登出**，' +
          '且带**来源 IP**（取自 socket）；库文件字节与 op_log 全量序列化里**都没有口令明文**',
          ['口令初始化码', '口令初始化', '解锁', '解锁失败', '账号锁定', '改密', '登出'].every(k => types.includes(k)) &&
          auditRows.filter(r => /来源=/.test(String(r.content))).length >= 5 &&
          !dbBytes.includes(PW1) && !dbBytes.includes(PW2) &&
          !JSON.stringify(auditRows).includes(PW1) && !JSON.stringify(auditRows).includes(PW2),
          `留痕类型=${JSON.stringify(types)}；带来源 IP ${auditRows.filter(r => /来源=/.test(String(r.content))).length} 条`);

        /* ⑦ 码**立即作废**（跨 HTTP 边界的直接证据）：把凭证行删掉回到未初始化态，再用**同一个码**初始化 ⇒ 401。
           ⚠ 为什么必须这么造：只断言"第二次 init ⇒ 409"证明不了码已作废 —— 那一步在 `countCredentials()>0`
           的"已初始化"检查上就短路了（服务层用例 `tests\db-check.js` 九之三用同一手法，这里补跨 HTTP 的同一证据）。 */
        withDb(c => c.exec('DELETE FROM auth_credential'));
        const stAfterDelete = await call('GET', '/auth/status');
        const codeReuse = await call('POST', '/auth/init', { code: initCode, password: PW2 });
        t.check('W5-③ 端到端（真进程）：一次性初始化码**成功后立即作废** —— 删掉凭证行回到未初始化态后，' +
          '用**同一个码**再初始化 ⇒ **401 `bad_init_code`**（不是 200，也不是靠"已初始化"检查短路躲过去）',
          stAfterDelete.status === 200 && stAfterDelete.body && stAfterDelete.body.initialized === false &&
          codeReuse.status === 401 && codeReuse.body && codeReuse.body.error === 'bad_init_code',
          `删行后 initialized=${stAfterDelete.body && stAfterDelete.body.initialized}；同码再初始化=` +
          `${codeReuse.status}/${codeReuse.body && codeReuse.body.error}`);

        /* ⑧ 真进程优雅停止：端口释放、服务日志目录随 stop() 清掉（不留残留） */
        await authSvc.stop();
        const logFileAfterStop = authSvc.logFile;
        authSvc = null;
        await new Promise(r => setTimeout(r, 150));
        let stillUp = false;
        try { await fetch(`${base}/health`); stillUp = true; } catch { /* 已停 */ }
        t.check('W5-③ 端到端（真进程）：`stop()` 之后端口不再响应（服务真被停掉，无残留进程/句柄），' +
          '且 `startService` 的临时日志目录随 stop() 一起清掉',
          stillUp === false && !fs.existsSync(logFileAfterStop),
          stillUp ? '仍在响应（缺陷）' : `已停止（日志目录已清=${!fs.existsSync(logFileAfterStop)}）`);
      } finally {
        if (authSvc) await authSvc.stop();
        harness.removeLinkSafe(authTmp, { recursive: true, force: true });
      }
    }

    /* ---- 2d. W5-③/**F20**：**极旧库（连 `op_log` 表都没有）**的启动日志必须如实标"已 backfill"（真起进程）----
       造数：当前结构建库 → `DROP TABLE op_log` → 版本改回**上一版**（`SCHEMA_VERSION − 1`，现算）⇒ 迁移前那次审计必然失败
       （`no such table: op_log`），迁移后由 db 层**补写**（`backfill（迁移后补写）`）。
       **改前复现**（F20 立案）：该行会打印"审计 op_log=写入失败（已告警，auditDegraded=true）"，
       而库里其实已有 backfill 行 ⇒ **日志与事实不符**。改后应打印"写入失败→已 backfill #<id>"。
       为什么单起一次进程：本判据的造数（无 `op_log` 表）与 2c 的库互斥，必须各起一个服务。 */
    {
      const f20Tmp = harness.makeTempDir('f20-backfill-log');
      const f20DbFile = path.join(f20Tmp, 'board.db');
      const f20Port = await harness.allocPort();
      const { DatabaseSync } = require('node:sqlite');
      const dbApi = require('../server/db');
      {
        const seed = new DatabaseSync(f20DbFile);
        dbApi.initSchema(seed, '2026-09-28 10:00:00');
        seed.exec('DROP TABLE op_log');       // 极旧库的形态：连 op_log 表都没有
        /* 版本同样**现算**（上一版），不写死数字 —— 与 2c 同一个理由（升版不假红） */
        seed.prepare('UPDATE schema_meta SET value = ? WHERE key = ?')
          .run(String(Number(dbApi.SCHEMA_VERSION) - 1), 'schema_version');
        seed.close();
      }
      let f20Svc = null;
      try {
        f20Svc = await harness.startService({
          script: path.join(env.paths.root, 'server', 'index.js'),
          args: ['--port', String(f20Port), '--data-dir', f20Tmp, '--db-file', f20DbFile],
          port: f20Port, readyPath: '/health', timeoutMs: 20000
        });
        const f20Line = (f20Svc.output().match(/\[启动\] E18 迁移前已备份：[^\r\n]*/) || [''])[0];
        const f20Db = new DatabaseSync(f20DbFile);
        const f20Rows = f20Db.prepare(
          "SELECT id, result, content FROM op_log WHERE op_type = '迁移前备份'").all();
        f20Db.close();
        const f20LoggedId = Number((f20Line.match(/已 backfill #(\d+)/) || [])[1]);
        t.check('W5-③/F20 端到端（真进程）：**极旧库（连 `op_log` 表都没有）** ⇒ 启动日志的审计子句必须如实标' +
          '「写入失败→已 backfill #<id>」，且**不再打印**"（已告警，auditDegraded=true）"；' +
          '同时库里确有该 backfill 行（**日志里的 id 与库内行 id 一致**）',
          /审计 op_log=写入失败→已 backfill #\d+/.test(f20Line) &&
          !f20Line.includes('（已告警，auditDegraded=true）') &&
          f20Rows.length === 1 && String(f20Rows[0].content).includes('backfill') &&
          f20LoggedId === Number(f20Rows[0].id) && f20Rows[0].result === '成功',
          `日志行=${f20Line || '(未出现)'}；op_log=${JSON.stringify(f20Rows.map(r => ({ id: r.id, result: r.result })))}`);
      } finally {
        if (f20Svc) await f20Svc.stop();
        harness.removeLinkSafe(f20Tmp, { recursive: true, force: true });
      }
    }

    /* ---- 3~6. 起真服务做行为断言（子进程夹具） ---- */
    const w6Tmp = harness.makeTempDir('w6-entry-skeleton');
    const w6Scratch = path.join(env.paths.root, 'tests', '._verify', 'w6');
    fs.mkdirSync(w6Scratch, { recursive: true });
    /* ⚠ 夹具文件名带**本次运行的唯一标签**：门禁允许并发跑（E19 现实），固定文件名 + "收尾删整个目录"
       会让两个 harness-check 互相删对方的夹具（实测：并发轮次里本轮在写 `fixture-b.js` 时目录已被
       另一轮删掉 ⇒ ENOENT 崩在夹具中途）。只删自己写的文件，不删目录。 */
    const w6RunTag = process.pid + '-' + Date.now().toString(36);
    /** 本节点写过的夹具文件（收尾只删它们，不删共用目录） */
    const w6Written = [];

    const w6Write = (name, lines) => {
      const full = path.join(w6Scratch, name);
      fs.writeFileSync(full, lines.join('\r\n') + '\r\n', 'utf8');
      w6Written.push(full);
      return full;
    };
    const w6ReadResult = file => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    };
    const w6LogPath = name => path.join(w6Tmp, name + '.log');
    /** 原地起子进程（不删日志文件：调用方要读它）；stdout/stderr 一律落文件，避免管道 EPERM */
    const w6Spawn = (script, name, extraEnv) => {
      const logFile = w6LogPath(name);
      const fd = fs.openSync(logFile, 'a');
      const proc = spawn(process.execPath, [script], {
        cwd: env.paths.root,
        env: Object.assign({}, process.env, { DSH_ENV: 'test' }, extraEnv),
        windowsHide: true,
        stdio: ['ignore', fd, fd]
      });
      let settled = null;
      proc.on('exit', (code, signal) => { settled = { code, signal }; });
      return { proc, logFile, exitInfo: () => settled, log: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
        async waitDone(ms) {
          const until = Date.now() + ms;
          while (!settled && Date.now() < until) await new Promise(r => setTimeout(r, 100));
          try { fs.closeSync(fd); } catch { /* 已关 */ }
          return settled;
        } };
    };

    /* ---------------- 一、能起 · 能查 · 监听范围 · 优雅退 · SSE（夹具①，单次跑完一并取证） ----------------
       为什么要合成一个夹具：起停一次要真开库、真监听、真收尾 —— 每条断言各起一次会让门禁明显变慢；
       下面这些 check 彼此独立，只是**共用同一份取证**。 */
    const w6PortA = await harness.allocPort();
    const w6DataA = path.join(w6Tmp, 'data-a');
    const w6DbA = path.join(w6Tmp, 'custom-board.db');   // 用 --db-file 起，顺带验该覆盖项与 /health 的 dbFile
    const w6ResAFile = path.join(w6Tmp, 'result-a.json');
    const fA = w6Write('fixture-a-' + w6RunTag + '.js', [
      "'use strict';",
      "/* 由 tests/harness-check.js 生成：起真服务 → 逐条打真请求 → 结果写 JSON 文件。 */",
      "const fs = require('node:fs');",
      "const net = require('node:net');",
      "const path = require('node:path');",
      "const ROOT = path.resolve(__dirname, '..', '..', '..');",
      "process.env.DSH_ENV = 'test';",
      "const entry = require(path.join(ROOT, 'server', 'index.js'));",
      "const out = {};",
      "const save = () => fs.writeFileSync(process.env.DSH_W6_RESULT, JSON.stringify(out), 'utf8');",
      "const canBind = (host, port) => new Promise(resolve => {",
      "  const s = net.createServer();",
      "  s.once('error', err => resolve({ ok: false, code: err.code }));",
      "  s.listen({ host, port }, () => s.close(() => resolve({ ok: true })));",
      "});",
      "const externalIPv4 = () => {",
      "  for (const list of Object.values(require('node:os').networkInterfaces())) {",
      "    for (const it of list || []) if (it.family === 'IPv4' && !it.internal) return it.address;",
      "  }",
      "  return null;",
      "};",
      "(async () => {",
      "  const port = Number(process.env.DSH_W6_PORT);",
      "  const base = 'http://127.0.0.1:' + port;",
      "  const svc = await entry.start({",
      "    argv: ['--port', String(port), '--data-dir', process.env.DSH_W6_DATA, '--db-file', process.env.DSH_W6_DB],",
      "    installSignalHandlers: false,",
      "    logConsole: false,",
      "    heartbeatMs: 300,        // SSE 心跳周期：线上默认 15 s；这里调到 300 ms 才验得动（不改线上口径）",
      "    testRoutes: true",     // 只多注册一个"读体回显"端点，用于 400/413 的行为判据
      "  });",
      "  out.listen = svc.listen;",
      "  const hRes = await fetch(base + '/health');",
      "  out.health = { status: hRes.status, body: await hRes.json() };",
      "  const r404 = await fetch(base + '/no-such-endpoint');",
      "  out.e404 = { status: r404.status, body: await r404.json() };",
      "  const r405 = await fetch(base + '/health', { method: 'POST' });",
      "  out.e405 = { status: r405.status, allow: r405.headers.get('allow'), body: await r405.json() };",
      "  const r400 = await fetch(base + '/__w6/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });",
      "  out.e400 = { status: r400.status, body: await r400.json() };",
      "  const r413 = await fetch(base + '/__w6/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' },",
      "    body: JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 1024) }) });",   // 必须**超过**路由默认上限 1 MiB
      "  out.e413 = { status: r413.status, body: await r413.json() };",
      "  const ctl = new AbortController();",
      "  const evRes = await fetch(base + '/events', { signal: ctl.signal });",
      "  const reader = evRes.body.getReader();",
      "  const dec = new TextDecoder();",
      "  let sseText = '';",
      "  const until = Date.now() + 8000;",
      "  while (Date.now() < until && sseText.indexOf(': ping') < 0) {",
      "    /* 读一帧，但**最多等 1500 ms**：`reader.read()` 挂起时不会有超时，",
      "       不设上限的话这个 while 会把夹具拖到永远（本项目曾因此把一条断言拖成假绿）。 */",
      "    const chunk = await Promise.race([",
      "      reader.read(),",
      "      new Promise(r => setTimeout(() => r({ timeout: true }), 1500))",
      "    ]);",
      "    if (chunk.timeout || chunk.done) break;",
      "    sseText += dec.decode(chunk.value, { stream: true });",
      "  }",
      "  const streamsDuring = svc.router.streamCount();",
      "  ctl.abort();",
      "  try { await reader.cancel(); } catch { }",
      "  await new Promise(r => setTimeout(r, 300));",
      "  out.sse = { status: evRes.status, contentType: evRes.headers.get('content-type'),",
      "    retryFrame: /retry:\\s*3000/.test(sseText), heartbeat: /: ping /.test(sseText),",
      "    frames: sseText.split('\\n\\n').filter(Boolean).length, sample: sseText.slice(0, 200),",
      "    streamsDuring, streamsAfter: svc.router.streamCount() };",
      "  const ext = externalIPv4();",
      "  out.externalIPv4 = ext;",
      "  out.externalBind = ext ? await canBind(ext, port) : null;",
      "  out.loopbackBind = await canBind('127.0.0.1', port);",
      "  /* 先落盘，再 stop()：stop 的实现一变（比如直接 process.exit）也不至于让结果文件写不出来，",
      "     否则「变异把断言改红」会退化成「夹具没结果」（D22 要的是**指名**，不是一团空）。 */",
      "  save();",
      "  out.stopResult = await entry.stop('harness-check 夹具');",
      "  out.serverAfterStop = entry.state.server === null;",
      "  out.dbAfterStop = entry.state.db === null;",
      "  out.rebindAfterStop = await canBind('127.0.0.1', port);",
      "  save();",
      "})().catch(err => { out.error = String(err && err.stack ? err.stack : err); save(); process.exitCode = 1; });"
    ]);
    const runA = w6Spawn(fA, 'fixture-a', { DSH_W6_PORT: String(w6PortA), DSH_W6_DATA: w6DataA, DSH_W6_RESULT: w6ResAFile, DSH_W6_DB: w6DbA });
    /* watchdog：夹具异常时不至于把门禁挂住（正常路径不会触发） */
    const watchdogA = setTimeout(() => { try { runA.proc.kill(); } catch { /* 已退出 */ } }, 25000);
    const exitA = await runA.waitDone(25000);
    clearTimeout(watchdogA);
    const A = w6ReadResult(w6ResAFile);
    if (!t.requires('W6 夹具① 能取到结果文件（result-a.json）', Boolean(A), runA.log().slice(-400) || '无日志')) {
      t.info('W6：夹具①未产出结果，本节相关断言按失败处理（不许把"跑不了"当通过）');
    }
    const a = A || {};

    /* 能起：/health 200 且 JSON 含 ok/uptimeSec/dbWritable/version/listen，且库确实可写 */
    const hb = (a.health && a.health.body) || {};
    t.check('W6：GET /health 返回 200，且含 ok / uptimeSec / dbWritable / version / listen，dbWritable===true',
      a.health && a.health.status === 200 && hb.ok === true && typeof hb.uptimeSec === 'number' &&
      hb.dbWritable === true && typeof hb.version === 'string' && /:\d+$/.test(String(hb.listen)),
      `status=${a.health && a.health.status} body=${JSON.stringify(hb).slice(0, 220)}`);
    t.check('W6：/health 的 version 取自需求基线真源（board.config.js「需求版本：Vx.yz」）',
      typeof hb.version === 'string' && /^V\d+(\.\d+)*$/.test(hb.version) && hb.version === w6.readBaselineVersion(),
      `${hb.version}（readBaselineVersion()=${w6.readBaselineVersion()}）`);
    t.check('W6：/health 的 dbFile 反映 --db-file 覆盖项（库路径与"库可写"同源，不是各自猜）',
      path.resolve(String(hb.dbFile || '')) === path.resolve(w6DbA) && fs.existsSync(w6DbA),
      `health.dbFile=${hb.dbFile}`);

    /* 能查：404 / 405 / 400 / 413 形状稳定且带可读 message */
    const e404 = a.e404 || {}; const e405 = a.e405 || {}; const e400 = a.e400 || {}; const e413 = a.e413 || {};
    const errOf = r => (r && r.body && r.body.err) || {};
    t.check('W6：未知路径 ⇒ 404，且错误体形状稳定（ok 包裹的 err.code/httpStatus/message + path/method）',
      e404.status === 404 && errOf(e404).code === 'NOT_FOUND' && errOf(e404).httpStatus === 404 &&
      typeof errOf(e404).message === 'string' && errOf(e404).message.length > 0 &&
      e404.body.path === '/no-such-endpoint' && e404.body.method === 'GET',
      JSON.stringify(e404.body));
    t.check('W6：已知路径 + 不支持的方法 ⇒ 405（并给出 Allow，与 404 可区分）',
      e405.status === 405 && e405.allow === 'GET' && errOf(e405).code === 'METHOD_NOT_ALLOWED',
      `status=${e405.status} Allow=${e405.allow}`);
    t.check('W6：坏 JSON 请求体 ⇒ 400（指名"不是合法 JSON"，不是笼统 500）',
      e400.status === 400 && errOf(e400).code === 'BAD_JSON' && /JSON/.test(String(errOf(e400).message)),
      JSON.stringify(e400.body).slice(0, 200));
    t.check('W6：超大请求体 ⇒ 413（默认上限 1 MiB，附可读 message，不是把连接抛掉了事）',
      e413.status === 413 && errOf(e413).code === 'PAYLOAD_TOO_LARGE' && /上限/.test(String(errOf(e413).message)),
      JSON.stringify(e413.body).slice(0, 200));

    /* 监听范围：默认只回环 —— 行为判据：回环同端口绑定失败（被占用），非回环地址同端口仍可绑定（无人监听） */
    const extAddr = a.externalIPv4;
    const onlyLoopback = a.loopbackBind && a.loopbackBind.ok === false &&
      (!extAddr || (a.externalBind && a.externalBind.ok === true));
    t.check('W6：默认只监听回环（回环同端口已被占用、非回环地址同端口仍可绑定 ⇒ 局域网不可达）',
      onlyLoopback,
      `回环绑定=${JSON.stringify(a.loopbackBind)}；外部地址 ${extAddr || '（本机无非回环 IPv4）'} 绑定=${JSON.stringify(a.externalBind)}；listen=${a.listen}`);

    /* SSE 骨架：建连 + Content-Type + 心跳注释帧 + 关闭后连接数归零 */
    const sse = a.sse || {};
    t.check('W6：GET /events 建立 SSE 连接并收到心跳注释帧（Content-Type=text/event-stream，含 : ping 与 retry）',
      sse.status === 200 && /^text\/event-stream/.test(String(sse.contentType)) && sse.heartbeat === true && sse.retryFrame === true,
      `status=${sse.status} ctype=${sse.contentType} 帧数=${sse.frames} 原始帧=${JSON.stringify(sse.sample)}`);
    t.check('W6：SSE 客户端断开后连接被释放（在途连接数 1 → 0，定时器不残留）',
      sse.streamsDuring === 1 && sse.streamsAfter === 0,
      `断开前 ${sse.streamsDuring} 条、断开后 ${sse.streamsAfter} 条`);

    /* 优雅退出：stop() 返回 0 ⇒ 端口释放并可在同端口再次绑定 ⇒ 进程以 0 退出 ⇒ 无残留子进程 */
    t.check('W6：优雅退出后端口被释放（stop() 返回 code=0，内部状态已清空，且同端口可再次绑定）',
      a.stopResult && a.stopResult.code === 0 && a.serverAfterStop === true && a.dbAfterStop === true &&
      a.rebindAfterStop && a.rebindAfterStop.ok === true,
      `stop=${JSON.stringify(a.stopResult)} server=null:${a.serverAfterStop} db=null:${a.dbAfterStop} 再绑定=${JSON.stringify(a.rebindAfterStop)}`);
    t.check('W6：优雅退出的进程以退出码 0 结束（自然排空事件循环，无信号残留/无未关句柄）',
      exitA && exitA.code === 0,
      `exit=${JSON.stringify(exitA)}` + (a.error ? ` 夹具异常：${String(a.error).slice(0, 200)}` : ''));

    /* ---------------- 二、不静默：启动自检失败 ⇒ 退非零（夹具②） ----------------
       夹具② 造的是**"只有自检能挡住"**的失败：在 `backupDir`（`<数据根>\backup`）这个**路径上**
       放一个同名普通文件，于是自检往"备份目录"里写探针文件必然失败（ENOTDIR）。
       为什么必须这样精确：若用"数据根不可用"或"库文件只读"当故障源，进程会在**更早**的
       建日志 / `openDb`（`PRAGMA journal_mode` 需要写权限）处就退出 —— 那样即使把启动自检
       整段删掉，退出码依然非零，断言会**假绿**（D22 变异 a 前两次就踩到了这两种"更早失败"）。
       而 `backupDir` 的可写性**只由启动自检检查**：sqlite 不管它、日志不管它 ⇒
       去掉自检后进程会一路起到监听（夹具随即以退出码 9 报"缺陷"），断言这才真的变红。 */
    const w6PortB = await harness.allocPort();
    const w6DataB = path.join(w6Tmp, 'data-b');
    const fB = w6Write('fixture-b-' + w6RunTag + '.js', [
      "'use strict';",
      "/* 启动自检②：backupDir 被同名**文件**占位（写探针必然失败 ENOTDIR）⇒ 自检必须挡住 ⇒ 退非零。 */",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const ROOT = path.resolve(__dirname, '..', '..', '..'); const env = require(path.join(ROOT, 'tests', 'env.js'));   // E103／E161 纪律：删除走安全出口",
      "process.env.DSH_ENV = 'test';",
      "const entry = require(path.join(ROOT, 'server', 'index.js'));",
      "const dataDir = process.env.DSH_W6_DATA;",
      "const blocker = path.join(dataDir, 'backup');          // 备份目录路径上放一个**同名普通文件**",
      "env.removeLinkSafe(dataDir, { recursive: true, force: true });",
      "fs.mkdirSync(dataDir, { recursive: true });",
      "fs.writeFileSync(blocker, 'W6 夹具②：本文件占住“备份目录”这个路径（它本该是个目录）', 'utf8');",
      "/* 反向自检：确认这个占位真的让“写探针文件”失败（否则夹具没造出目标场景，不许假绿） */",
      "let blocked = false;",
      "try { fs.writeFileSync(path.join(blocker, '.w6-write-probe-selfcheck'), 'ok', 'utf8'); } catch (e) { blocked = true; }",
      "console.log('夹具②：备份目录写探针被挡住 = ' + blocked);",
      "if (!blocked) { console.error('夹具②：没造出“备份目录不可写”的场景'); process.exit(5); }",
      "const failFast = setTimeout(() => { console.error('W6 夹具②：10 s 内启动自检仍未拦住（缺陷）'); process.exit(9); }, 10000);",
      "entry.start({ argv: ['--port', String(process.env.DSH_W6_PORT), '--data-dir', dataDir],",
      "    installSignalHandlers: false, logConsole: true })",
      "  .then(() => { clearTimeout(failFast); console.error('W6 夹具②：启动自检没有拦住不可写的备份目录 —— 服务照常起来了（缺陷）'); process.exit(9); })",
      "  .catch(err => { clearTimeout(failFast); console.error('W6 夹具②：start() 抛出（可接受路径）：' + (err && err.message)); process.exit(8); });"
    ]);
    const runB = w6Spawn(fB, 'fixture-b', { DSH_W6_PORT: String(w6PortB), DSH_W6_DATA: w6DataB });
    const watchdogB = setTimeout(() => { try { runB.proc.kill(); } catch { /* 已退出 */ } }, 20000);
    const exitB = await runB.waitDone(20000);
    clearTimeout(watchdogB);
    const logB = runB.log();
    if (exitB && exitB.code === 5) {
      t.skip('W6：启动自检失败（备份目录不可写）⇒ 进程退非零且日志指名是哪一项，绝不"假活"（夹具②）',
        '本机没能造出"备份目录不可写"的场景（占位文件下仍能写探针）—— 环境不支持该故障源');
    } else {
      t.check('W6：启动自检失败（备份目录不可写）⇒ 进程退非零且日志指名是哪一项，绝不"假活"（夹具②）',
        Boolean(exitB) && exitB.code !== 0 && /启动自检未通过/.test(logB) && /backupDir/.test(logB),
        `exit=${JSON.stringify(exitB)} 日志尾部=${logB.trim().split('\n').slice(-2).join(' ｜ ').slice(0, 240)}`);
    }

    /* ---------------- 三、不静默：未捕获异常/未处理 rejection ⇒ 退非零 + 日志有记录（夹具③） ---------------- */
    for (const mode of ['uncaught', 'rejection']) {
      const w6PortC = await harness.allocPort();
      const w6DataC = path.join(w6Tmp, 'data-c-' + mode);
      const fC = w6Write('fixture-c-' + mode + '-' + w6RunTag + '.js', [
        "'use strict';",
        "const path = require('node:path');",
        "const ROOT = path.resolve(__dirname, '..', '..', '..');",
        "process.env.DSH_ENV = 'test';",
        "const mode = process.env.DSH_W6_CRASH;",
        "const entry = require(path.join(ROOT, 'server', 'index.js'));",
        "entry.main({ argv: ['--port', String(process.env.DSH_W6_PORT), '--data-dir', process.env.DSH_W6_DATA, '--crash', mode],",
        "  logConsole: true })",
        "  .then(() => { console.log('W6 夹具③：已监听，等待注入的 ' + mode + ' 生效'); })",
        "  .catch(err => { console.error('W6 夹具③：main() 失败：' + (err && err.message)); process.exit(7); });"
      ]);
      const runC = w6Spawn(fC, 'fixture-c-' + mode,
        { DSH_W6_PORT: String(w6PortC), DSH_W6_DATA: w6DataC, DSH_W6_CRASH: mode });
      /* 先证明"服务真的起来过"（否则"崩"可能只是没启动起来，断言会变成假的绿） */
      let wasUp = false;
      const readyUntil = Date.now() + 6000;
      while (Date.now() < readyUntil && !wasUp) {
        try { wasUp = (await fetch(`http://127.0.0.1:${w6PortC}/health`)).status === 200; }
        catch { await new Promise(r => setTimeout(r, 120)); }
      }
      const exitC = await runC.waitDone(15000);
      const logC = runC.log();
      const kindText = mode === 'uncaught' ? '未捕获异常' : '未处理的 Promise rejection';
      t.check(`W6：${kindText}不静默（服务确实起来过 ⇒ 注入后进程退非零 ⇒ 日志留痕，夹具③）`,
        wasUp === true && Boolean(exitC) && exitC.code !== 0 && logC.includes(kindText),
        `起来过=${wasUp} exit=${JSON.stringify(exitC)} 日志尾部=${logC.trim().split('\n').slice(-2).join(' ｜ ').slice(0, 200)}`);
    }

    try { harness.removeLinkSafe(w6Tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    /* 只删本节点的夹具文件，不删整个 w6 目录（并发轮次共用该目录，见上方 w6RunTag 说明） */
    for (const f of w6Written) { try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ } }
  } else {
    t.info('W6：server\\index.js 不存在 —— 上述进程入口断言未执行（不许把"跑不了"当通过）');
  }
}

/* ---------------- 四之②、W5-① 服务端 SSE 业务推送（快照同源／断线续传／六类事件／CORS／静态托管／优雅关闭） ----------------
   覆盖 W5-① 的九条判据（①建连快照同源 ②断线续传 ③脏输入不发布 ④帧事件与采样表逐条对账 ⑤心跳可预测
   ⑥优雅关闭 ⑦缓冲溢出计数 ⑧无裸时间 ⑨端口/监听）＋ 负责人 2026-09-28 裁定「选项 A」的 CORS 与静态托管。
   手法沿用本节上半段：**真起进程、真打 HTTP、真读响应**（行为判据，不匹配源码字符串，遵 D23）。
   夹具源码内联在本节（写成文件后以子进程跑）；产物一律落 tests\._verify\w5sse\（D16：测试只写这里）。 */
t.section('四之②、W5-① 服务端 SSE 业务推送（快照同源／断线续传／六类事件／CORS／静态托管／优雅关闭）');
{
  /* 夹具源内联在这里（写成文件后以子进程真起服务）：**门禁只改本脚本一个文件**，
     夹具不进仓库 —— 它们每次都重新写到 tests\._verify\w5sse\（已 gitignore）。
     内联用 String.raw：夹具里的 `\n` / `\r\n` 等转义按字面写进文件（不在这里被解释）。 */
  const W5_FIXTURE_SSE = String.raw`'use strict';
/* W5-① 服务端 SSE 业务推送 —— 端到端夹具（由 tests/harness-check.js 生成到 tests/._verify/w5sse/）
   真起服务（真 HTTP 回环）→ 逐条打真请求 → 结果写 JSON 文件；本文件**不做断言**（断言在 harness-check）。
   阶段划分（每段一条连接，避免"哪些事件落在哪个窗口"含糊）：
     ① hello 快照与 /state 同源   ② 心跳计数   ③ 帧事件（1 s 采样才发）＋链路在线
     ④ 断线续传（?since= / Last-Event-ID）   ⑤ 链路离线（推进注入时钟）   ⑥ 其余四类事件
     ⑦ 超缓冲退回 hello ＋ 非法 since   ⑦e warning 真实写入点（本波新增）   ⑧ 优雅关闭（先 closeAllStreams、再 stop）

   ⚠ **新增推帧步骤前必读**（本波实测踩过三次，代价是整段断言连续变红）：
    ① ingest 的 1 s 采样去重是"**collectTime 不得早于上次落库那一秒**"（ADR-0001 D7）——
       新推的帧若用更早的采集时刻，会被判成 raw-500ms（**不落库、也就没有 frame/warning 事件**），
       连带把后续"更早时刻"的帧一起挡掉。故**新段的采集时刻必须排在它前面所有段之后**；
    ② 段④/⑦ 的续传与环形缓冲断言按 **seq 精确对账**（[base+1, base+2, base+3]）——
       任何在那些窗口里多发的**事件**（例如给某一票挂上"已生效的标准"后，它每帧都会多出一条
       warning）都会让它们变红。要给某票加"可判定的标准"，就**另起专用工单号/产品号**；
    ③ task 的写入是 INSERT … ON CONFLICT(proc_order_no) DO NOTHING ⇒ 工单号一旦被别处派发过，
       本处的派工**改不动**它的 product_code（本波实测：E22 段先派了 WO-W5-1/P-W5，
       导致 12:00:xx 的帧仍按 P-W5 判定）。 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..'); const env = require(path.join(ROOT, 'tests', 'env.js'));   /* E103／E161：删除走安全出口 */
process.env.DSH_ENV = 'test';
const entry = require(path.join(ROOT, 'server', 'index.js'));
const { createUploadReporter } = require(path.join(ROOT, 'server', 'services', 'uploadReporter.js'));
const stdRepo = require(path.join(ROOT, 'server', 'repo', 'standard.js'));
const judge = require(path.join(ROOT, 'server', 'services', 'judge.js'));
const boardConfig = require(path.join(ROOT, 'src', 'config', 'board.config.js'));

const OUT = {};
const SAVE = () => fs.writeFileSync(process.env.DSH_W5_RESULT, JSON.stringify(OUT, null, 1), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 注入时钟：固定时刻 + 可手动推进（链路离线判据要能确定性地跨过 upper.staleMs = 5000） */
let fixedMs = Date.parse('2026-09-19T10:00:00');
const injectedAt = new Date(fixedMs).toISOString();
const clock = {
  now: () => new Date(fixedMs),
  source: () => () => new Date(fixedMs),
  advanceMs: ms => { fixedMs += ms; return fixedMs; }
};

/* ---- SSE 客户端：真 HTTP + 按 SSE 规范切块 ---- */
function parseFrames(text) {
  const out = [];
  for (const block of String(text).split('\n\n')) {
    if (!block.trim()) continue;
    const f = { retry: null, comment: null, id: null, event: null, data: null };
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) f.comment = line.slice(1).trim();
      else if (line.startsWith('retry:')) f.retry = line.slice(6).trim();
      else if (line.startsWith('id:')) f.id = line.slice(3).trim();
      else if (line.startsWith('event:')) f.event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) f.data = dataLines.join('\n');
    out.push(f);
  }
  return out;
}

async function openStream(base, opts = {}) {
  const ctl = new AbortController();
  const res = await fetch(base + (opts.path || '/events'), { headers: opts.headers || {}, signal: ctl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let done = false;
  const chunks = [];
  /* ⚠ 两条硬约束（都是实测踩出来的）：
     ① 任何时刻**只允许一个在途 read()**：超时的 race 只能放弃"超时 promise"，绝不能让
        「reader.read()」悬空 —— 悬空的读稍后 resolve 时它带回的字节没人接收，会**静默丢帧**；
     ② 每个 read 都**预挂一个 catch**：「abort()」会让挂起的读以 AbortError 拒绝，
        没挂 catch 时就是一条未处理拒绝 ⇒ 夹具进程直接崩（本夹具实测崩过一次）。 */
  let reading = null;
  const arm = () => { reading = reader.read(); reading.catch(() => { /* abort/重置：由 pump 收敛 */ }); };
  arm();
  async function pump(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !done) {
      let chunk;
      try {
        chunk = await Promise.race([
          reading,
          new Promise(r => setTimeout(() => r({ timeout: true }), Math.max(1, until - Date.now())))
        ]);
      } catch { done = true; break; }        // 连接被 abort/重置 ⇒ 当作流结束
      if (chunk.timeout) break;
      if (chunk.done) { done = true; break; }
      text += dec.decode(chunk.value, { stream: true });
      chunks.push({ at: Date.now(), len: text.length });
      arm();
    }
    return text;
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    pump,
    text: () => text,
    chunks: () => chunks.slice(),
    finished: () => done,
    frames: () => parseFrames(text),
    events: () => parseFrames(text).filter(f => f.event).map(f => ({
      id: Number(f.id), event: f.event, data: f.data ? JSON.parse(f.data) : null
    })),
    async close() { try { ctl.abort(); } catch { /* 已关 */ } try { await reader.cancel(); } catch { /* 已关 */ } }
  };
}

/** 合法帧（字段名与 IF-D 契约一致） */
function frame(i, collectTime) {
  return {
    equipCode: 'EQ-W5', procOrderNo: 'WO-W5-1', collectTime,
    seq: i, depth: 5.0 + i / 100, speed: 5 + i / 100,
    velocity_x: 3 + i / 100, velocity_y: 4 + i / 100,
    frameRate: 1000, gain: 2.5, shutter: 500, cameraDepth: 12.5, testStatus: 1
  };
}

async function post(base, p, body) {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body: parsed };
}
const seqNow = async base => (await (await fetch(base + '/state')).json()).seq;

const streams = [];
(async () => {
  const port = Number(process.env.DSH_W5_PORT);
  const base = 'http://127.0.0.1:' + port;
  const svc = await entry.start({
    argv: ['--port', String(port), '--data-dir', process.env.DSH_W5_DATA, '--db-file', process.env.DSH_W5_DB],
    installSignalHandlers: false,
    logConsole: false,
    heartbeatMs: 100,
    linkIntervalMs: 100,
    busCapacity: 8,          // 小容量：端到端也能验"超缓冲退回 hello"
    clock
  });
  const db = entry.state.db;
  const rowCount = () => db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
  /* 连接级取证：优雅退出时"到底是谁让 server.close() 等"必须看得见（否则只能猜） */
  const conns = [];
  const bySock = new Map();
  entry.state.server.on('connection', sock => {
    const rec = { openedAt: Date.now(), closedAt: null, remote: sock.remotePort, urls: [] };
    conns.push(rec);
    bySock.set(sock, rec);
    sock.on('close', () => { rec.closedAt = Date.now(); });
  });
  entry.state.server.on('request', (req) => {
    const rec = bySock.get(req.socket);
    if (rec) rec.urls.push(req.method + ' ' + req.url);
  });

  OUT.listen = svc.listen;
  OUT.injectedAt = injectedAt;
  OUT.mountSSE = svc.router.mountSSE();          // 无参：接线后必须自报**真实**状态
  OUT.routes = svc.router.list();
  OUT.config = { defaultHost: entry.DEFAULT_HOST, defaultPort: entry.DEFAULT_PORT, heartbeatMs: 100, busCapacity: svc.bus.capacity };

  /* ================= ① 建连快照：/state 与 hello 同源 ================= */
  const state0Res = await fetch(base + '/state');
  const state0Text = await state0Res.text();
  OUT.state0 = {
    status: state0Res.status, contentType: state0Res.headers.get('content-type'),
    text: state0Text, body: JSON.parse(state0Text)
  };
  const sHello = await openStream(base);
  streams.push(sHello);
  OUT.hello0 = { status: sHello.status, contentType: sHello.contentType, text: await sHello.pump(400), events: sHello.events() };
  await sHello.close();

  /* ================= ② 心跳：注入 100 ms，观测 2000 ms（公式 E=floor(D/H)） ================= */
  if (!String(process.env.W5_SKIP || '').includes('hb')) {
  const sHb = await openStream(base);
  streams.push(sHb);
  const hbStart = Date.now();
  const hbText = await sHb.pump(2000);
  OUT.heartbeat = {
    windowMs: 2000, heartbeatMs: 100, elapsedMs: Date.now() - hbStart,
    text: hbText, chunks: sHb.chunks()
  };
  await sHb.close();
  } else { OUT.heartbeat = { skipped: true }; }

  /* ================= ③ 帧事件（1 s 采样才发；500 ms 原始帧与脏帧都不发）＋链路在线 ================= */
  const sFrames = await openStream(base);
  streams.push(sFrames);
  await sleep(150);                                   // 让链路监控建立基线（首次 tick 只记基线）
  const rowsBefore = rowCount();
  OUT.frames = { rowsBefore, posts: [] };
  OUT.frames.posts.push(await post(base, '/ifd/frame', frame(1, '2026-09-19 10:00:00')));   // stored
  OUT.frames.posts.push(await post(base, '/ifd/frame', frame(2, '2026-09-19 10:00:00')));   // 同秒异键 ⇒ raw-500ms
  const dirty = frame(3, '2026-09-19 10:01:00');
  delete dirty.procOrderNo;                                                                  // 脏帧 ⇒ 400
  OUT.frames.posts.push(await post(base, '/ifd/frame', dirty));
  await sFrames.pump(500);                             // 覆盖：帧事件 + 链路"离线→在线"
  OUT.frames.rowsAfter = rowCount();
  OUT.frames.stream = { text: sFrames.text(), events: sFrames.events() };
  await sFrames.close();

  /* ================= ④ 断线续传：?since= / Last-Event-ID（此时链路在线 ⇒ 窗口内只有帧事件） ================= */
  const cursorBase = await seqNow(base);               // = 帧事件与链路在线事件的最大 seq
  for (let i = 0; i < 3; i++) {
    OUT.frames.posts.push(await post(base, '/ifd/frame', frame(10 + i, '2026-09-19 10:00:1' + i)));
  }
  OUT.replay = { cursorBase, expectedFrames: ['2026-09-19 10:00:10', '2026-09-19 10:00:11', '2026-09-19 10:00:12'] };
  const sReplay = await openStream(base, { path: '/events?since=' + cursorBase });
  streams.push(sReplay);
  OUT.replay.byQuery = { status: sReplay.status, text: await sReplay.pump(400) };
  OUT.replay.byQuery.events = sReplay.events();
  await sReplay.close();
  const sHeader = await openStream(base, { headers: { 'Last-Event-ID': String(cursorBase + 1) } });
  streams.push(sHeader);
  OUT.replay.byHeader = { status: sHeader.status, text: await sHeader.pump(400) };
  OUT.replay.byHeader.events = sHeader.events();
  await sHeader.close();

  /* ================= ⑤ 链路"在线→离线"：注入时钟推进 6 s（> upper.staleMs = 5000） ================= */
  const sLink = await openStream(base);
  streams.push(sLink);
  await sLink.pump(150);
  clock.advanceMs(6000);
  OUT.afterAdvanceAt = new Date(fixedMs).toISOString();   // 注释帧时间戳只允许取这两个注入值之一（D17 判据）
  OUT.link = { afterAdvance: await sLink.pump(450) };
  OUT.link.events = sLink.events();
  OUT.link.state = (await (await fetch(base + '/state')).json()).snapshot.link;
  await sLink.close();

  /* ================= ⑥ 其余三类事件（task / standard / upload）＋ 「warning」（**真实写入点**） =================
     W5-②（接线技术债 E45）：warning 事件已接进生产链路 —— 发布点是 services/ingest.js 的
     options.onSampled（"1 s 采样落库成功"之后），判定与发布由 server/index.js 的 emitWarnings()
     完成。故本段**不再由夹具直调** judge.evaluate：只推真帧，warning 事件只能来自生产链路。 */
  const sOther = await openStream(base);
  streams.push(sOther);
  OUT.inproc = [];                                    // 进程内旁证：同一总线上的订阅者收到了什么
  const probe = svc.bus.subscribe(e => OUT.inproc.push(e.seq + ':' + e.kind));
  /* W5-②（E45）用：进程内订阅者把**事件信封的 at** 记下来 —— 线路上只发 data，
     at 是进程内信封字段（eventBus 的 {seq, at, kind, payload}），故"判定时刻"的判据读这里。 */
  const warnAtProbe = [];
  const probeAt = svc.bus.subscribe(e => { if (e.kind === 'warning') warnAtProbe.push({ seq: e.seq, at: e.at }); });
  OUT.other = { task: [], standard: {}, upload: {}, warning: {} };
  OUT.other.task.push(await post(base, '/ifa/dispatch',
    { procOrderNo: 'WO-W5-9', productCode: 'P-W5', processNo: '30', planQty: 12, equipCode: 'EQ-W5' }));
  OUT.other.task.push(await post(base, '/ifa/dispatch',
    { procOrderNo: 'WO-W5-9', productCode: 'P-W5', processNo: '30', planQty: 12, equipCode: 'EQ-W5' })); // 幂等命中

  const nowText = '2026-09-19 10:00:06';
  OUT.other.standard.added = stdRepo.addVersion(db, {
    productCode: 'P-W5', processCode: '30', depthUpperDev: 0.2, depthLowerDev: -0.2, depthTypical: 5,
    speedUpperDev: 0.3, speedLowerDev: -0.3, speedTypical: 5
  }, undefined, nowText, { bus: svc.bus });
  OUT.other.standard.rejected = { threw: false, message: null };
  try {
    stdRepo.addVersion(db, { productCode: 'P-W5', processCode: '30', depthUpperDev: 0.2 }, undefined, nowText, { bus: svc.bus });
  } catch (err) {
    OUT.other.standard.rejected.threw = true;
    OUT.other.standard.rejected.message = String(err && err.message).slice(0, 200);
  }
  OUT.other.standard.versions = stdRepo.countVersions(db, { productCode: 'P-W5', processCode: '30' });

  const failingFetch = async () => { throw new Error('W5 夹具注入的网络错误'); };
  const rep = createUploadReporter({
    db, bus: svc.bus, now: clock.source(), fetch: failingFetch,
    config: Object.assign({}, boardConfig, { mes: Object.assign({}, boardConfig.mes, { baseUrl: 'http://127.0.0.1:9/x' }) })
  });
  OUT.other.upload.report = await rep.report({});
  OUT.other.upload.pendingCount = rep.pendingCount(true);

  /* ⚠ warning 的真实写入点判据**不在本段**：它要推"1 s 采样落库"的真帧，若挂在这里会往
     段④/⑦ 的续传与环形缓冲窗口里多塞事件（那些断言按 seq 精确对账）。故判据统一放在
     **⑦e 段**（在段⑦之后、段⑧优雅关闭之前）：那时续传窗口已经取完证，推帧不再影响任何既有判据。 */
  await sOther.pump(500);
  OUT.other.stream = { text: sOther.text(), events: sOther.events() };
  OUT.other.sseStatus = svc.router.sseStatus();
  svc.bus.unsubscribe(probe);
  await sOther.close();
  OUT.stateFinal = await (await fetch(base + '/state')).json();
  OUT.uploadStatus = await (await fetch(base + '/upload/status')).json();

  /* ================= ⑦ 超缓冲退回 hello ＋ 非法 since 不得 500 ================= */
  for (let i = 0; i < 10; i++) {
    OUT.frames.posts.push(await post(base, '/ifd/frame', frame(20 + i, '2026-09-19 10:01:' + String(i).padStart(2, '0'))));
  }
  const sOverflow = await openStream(base, { path: '/events?since=' + (cursorBase + 3) });
  streams.push(sOverflow);
  OUT.replay.overflow = { status: sOverflow.status, text: await sOverflow.pump(400) };
  OUT.replay.overflow.events = sOverflow.events();
  OUT.replay.busStats = svc.bus.stats();
  await sOverflow.close();

  OUT.replay.invalid = {};
  for (const bad of ['abc', '-5', '1.5', '']) {
    const s = await openStream(base, { path: '/events?since=' + encodeURIComponent(bad) });
    streams.push(s);
    const text = await s.pump(250);
    OUT.replay.invalid[bad === '' ? '(空串)' : bad] = { status: s.status, text };
    await s.close();
  }
  const sBadHeader = await openStream(base, { headers: { 'Last-Event-ID': 'xyz' } });
  streams.push(sBadHeader);
  OUT.replay.invalid.header = { status: sBadHeader.status, text: await sBadHeader.pump(250) };
  await sBadHeader.close();

  /* ================= ⑦b CORS 与静态托管（裁定「选项 A」） ================= */
  const net = require('node:net');
  const probeHttp = async (p, opts = {}) => {
    const r = await fetch(base + p, opts);
    const buf = Buffer.from(await r.arrayBuffer());      // 按**字节**计数（文本/二进制都准）
    const ct = r.headers.get('content-type') || '';
    const all = buf.toString('utf8');
    const textual = /^text\/|json|javascript|xml/.test(ct);
    const h = k => r.headers.get(k);
    return {
      status: r.status,
      acao: h('access-control-allow-origin'),
      acam: h('access-control-allow-methods'),
      acah: h('access-control-allow-headers'),
      acac: h('access-control-allow-credentials'),
      maxAge: h('access-control-max-age'),
      vary: h('vary'),
      contentType: ct,
      cacheControl: h('cache-control'),
      contentLength: h('content-length'),
      len: buf.length,
      textual,
      /* 二进制（png）不入结果文件：留 64 字符样本即可，否则账本里会塞进几百 KB 乱码 */
      text: textual ? all : all.slice(0, 64)
    };
  };
  /** 原始请求行探针：反斜杠/编码穿越这类形态 fetch 会先做 URL 归一，必须用裸 socket 才测得准。
   *  返回**状态码 + body 指纹**（便于断言"同一文件不因拼写产生两种判定"：200 的 body 哈希必须相等）。 */
  const rawGet = p => new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET ' + p + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', c => { data += c; });
    sock.on('close', () => {
      const text = String(data);
      const i = text.indexOf('\r\n\r\n');
      const head = i < 0 ? text : text.slice(0, i);
      const body = i < 0 ? '' : text.slice(i + 4);
      resolve({
        statusLine: head.split('\r\n')[0],
        status: Number((/^HTTP\/1\.1 (\d+)/.exec(head) || [])[1] || 0),
        bodyLen: body.length,
        bodyHash: require('node:crypto').createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16),
        bodyHasIndexJs: /启动自检|createRouter|module\.exports/.test(text),
        bodyTail: text.slice(-200),
        text
      });
    });
    sock.on('error', err => resolve({ statusLine: 'ERR ' + err.message, status: 0, bodyLen: 0, bodyHash: '', bodyHasIndexJs: false, bodyTail: '', text: '' }));
  });

  OUT.cors = {};
  OUT.cors.nullOrigin = await probeHttp('/state', { headers: { Origin: 'null' } });
  OUT.cors.loopbackOrigin = await probeHttp('/state', { headers: { Origin: 'http://127.0.0.1:' + port } });
  OUT.cors.localhostOrigin = await probeHttp('/state', { headers: { Origin: 'http://localhost:' + port } });
  OUT.cors.otherPort = await probeHttp('/state', { headers: { Origin: 'http://127.0.0.1:' + (port + 1) } });
  OUT.cors.evilOrigin = await probeHttp('/state', { headers: { Origin: 'http://evil.example' } });
  OUT.cors.noOrigin = await probeHttp('/state');
  OUT.cors.preflightNull = await probeHttp('/upload/retry', {
    method: 'OPTIONS',
    headers: {
      Origin: 'null', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type, Authorization'
    }
  });
  OUT.cors.preflightEvil = await probeHttp('/upload/retry', { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } });
  OUT.cors.preflightUnknown = await probeHttp('/no-such-path', { method: 'OPTIONS', headers: { Origin: 'null' } });
  OUT.cors.optionsNoOrigin = await probeHttp('/state', { method: 'OPTIONS' });
  /* F6：未注册路径**一个 CORS 头都不挂**（含 GET 形态；旧写法会在 404 上带 ACAO，口径不自洽） */
  OUT.cors.getUnknownWithOrigin = await probeHttp('/no-such-path', { headers: { Origin: 'null' } });
  OUT.cors.status = svc.cors.status();

  OUT.site = {};
  OUT.site.root = await probeHttp('/');
  OUT.site.indexHtml = await probeHttp('/index.html');
  OUT.site.js = await probeHttp('/src/main.js');
  OUT.site.config = await probeHttp('/src/config/board.config.js');
  OUT.site.css = await probeHttp('/src/styles/global.css');
  OUT.site.png = await probeHttp('/src/assets/screenshots/01-%E8%AE%BE%E5%A4%87%E7%8A%B6%E6%80%81-%E4%BB%BB%E5%8A%A1%E6%9B%B2%E7%BA%BF.png');
  OUT.site.served = svc.site.status().served;
  /* W7-C：/favicon.ico（浏览器打开同源入口时**自动**请求）⇒ 必须 **204 空体**（否则控制台多一条 network error）；
     同时记下"处理它**没有**新增路由"的证据（路由清单条数）与静态层计数（证明是被 204 分支接住、不是落 404）。 */
  OUT.site.favicon = await probeHttp('/favicon.ico');
  OUT.site.faviconServed = svc.site.status().served;
  OUT.site.routesCountAfterFavicon = svc.router.list().length;
  OUT.site.faviconNotWhitelisted = svc.site.resolve('/favicon.ico');

  /* 白名单外 + 穿越（fetch 形态） */
  const deniedPaths = [
    '/server/index.js', '/server/http/router.js', '/tests/README.md', '/tools/mock-upper/mock-upper.js',
    '/%E9%A1%B9%E7%9B%AE%E8%AE%B0%E5%BD%95/%E5%B7%A5%E4%BD%9C%E6%97%A5%E5%BF%97.md',
    '/.git/config', '/data/dev/board.db', '/%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3/', '/no-such-endpoint',
    '/src/../server/index.js', '/src/%2e%2e%2fserver/index.js', '/src/%2E%2E/server/index.js',
    '/%2e%2e%2fserver/index.js', '/src/config/../../../server/index.js', '/src/nope.js', '/src/'
  ];
  OUT.site.denied = {};
  for (const p of deniedPaths) OUT.site.denied[p] = await probeHttp(p);

  /* 穿越（裸 socket 形态：反斜杠 / 双斜杠 / 绝对路径） */
  OUT.raw = {};
  for (const p of ['/src\\..\\server\\index.js', '/src\\..%5cserver\\index.js', '//server/index.js',
    '/src/%252e%252e%252fserver/index.js', '/C:/Windows/win.ini', '/src/%00index.html']) {
    const text = await rawGet(p);
    OUT.raw[p] = {
      statusLine: text.statusLine,
      bodyHasIndexJs: text.bodyHasIndexJs,
      bodyTail: text.bodyTail
    };
  }

  /* F7：**规范化拼写**口径（裸 socket，绕开客户端 URL 归一）——同一文件不得因拼写给出两种判定 */
  OUT.canonical = {};
  for (const p of ['/index.html', '/index.HTML', '/index.html/', '/src/main.js', '/src/main.js/',
    '//index.html', '/./index.html', '/src/MAIN.JS', '/src//main.js', '//src/main.js']) {
    const r = await rawGet(p);
    OUT.canonical[p] = { status: r.status, bodyLen: r.bodyLen, bodyHash: r.bodyHash, bodyTail: r.bodyTail };
  }

  /* F4/F9：**realpath 复核**的两种越界（都在临时根里做，**不往仓库 src\ 里建任何链接**）：
     · 「serve/src/linkdir」  → junction → 「tmpRoot/outside」（**出根**）        ⇒ 必须 404（F4）
     · 「serve/src/inrepo」   → junction → 「serve/inRoot」（**在 serve 根之内、但在 serve/src 之外**）
       —— 这正是 F9 的形态（仓库内 「src\x -> tests」）：realpath 上界若仍是"根"，它会被托管出去。
     拆链接只用 「cmd /c rmdir <link>」（**绝不** 「fs.rmSync(recursive)」：那可能顺链接删到目标目录），
     并逐个确认目标目录仍在（把安全动作也留成证据）。 */
  OUT.realpathProbe = { junctionCreated: false, note: '' };
  try {
    const os = require('node:os');
    const httpRaw = require('node:http');
    const { spawnSync } = require('node:child_process');
    const { createRouter: createRouter2 } = require(path.join(ROOT, 'server', 'http', 'router.js'));
    const { mountSite } = require(path.join(ROOT, 'server', 'http', 'site.js'));
    const tmpRoot = path.join(os.tmpdir(), 'w5-serve-' + process.pid + '-' + Date.now());
    const outside = path.join(tmpRoot, 'outside');                 // 根之外（F4）
    const serveRoot = path.join(tmpRoot, 'serve');
    const inRoot = path.join(serveRoot, 'inRoot');                 // **根之内、但在 root/src 之外**（F9 的形态）
    const linkOut = path.join(serveRoot, 'src', 'linkdir');
    const linkIn = path.join(serveRoot, 'src', 'inrepo');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(inRoot, { recursive: true });
    fs.mkdirSync(path.join(serveRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(serveRoot, 'src', 'ok.js'), 'window.W5_PROBE_OK = 1;\n', 'utf8');
    fs.writeFileSync(path.join(outside, 'secret.js'), 'window.W5_SECRET = "OUTSIDE-SECRET-MARKER";\n', 'utf8');
    fs.writeFileSync(path.join(inRoot, 'tests-like.js'), 'window.W5_INREPO = "IN-ROOT-BUT-OUTSIDE-SRC-MARKER";\n', 'utf8');
    fs.symlinkSync(outside, linkOut, 'junction');
    fs.symlinkSync(inRoot, linkIn, 'junction');
    OUT.realpathProbe.junctionCreated = true;
    const probeLogs = [];
    const r2 = createRouter2({});
    mountSite(r2, {
      root: serveRoot,
      logger: { warn: (m, x) => probeLogs.push({ msg: String(m), reason: x && x.reason }), info: () => {}, error: () => {} }
    });
    const srv2 = httpRaw.createServer((rq, rs) => {
      Promise.resolve(r2.handle(rq, rs)).catch(() => { try { rs.destroy(); } catch { /* 已断 */ } });
    });
    const port2 = await new Promise(res => srv2.listen(0, '127.0.0.1', () => res(srv2.address().port)));
    const g2 = async p => {
      const r = await fetch('http://127.0.0.1:' + port2 + p);
      const t = await r.text();
      return {
        status: r.status, len: t.length,
        hasSecret: t.includes('OUTSIDE-SECRET-MARKER'),
        hasInRepoMarker: t.includes('IN-ROOT-BUT-OUTSIDE-SRC-MARKER'),
        hasOk: t.includes('W5_PROBE_OK')
      };
    };
    OUT.realpathProbe.normalFile = await g2('/src/ok.js');
    OUT.realpathProbe.escapedLink = await g2('/src/linkdir/secret.js');          // 出根（F4）
    OUT.realpathProbe.inRepoLink = await g2('/src/inrepo/tests-like.js');        // 根内、src 之外（F9）
    OUT.realpathProbe.indexMissing = await g2('/');                              // 临时根没有 index.html ⇒ 404
    OUT.realpathProbe.resolveSaysEscape = JSON.stringify(
      require(path.join(ROOT, 'server', 'http', 'site.js')).resolvePath('/src/linkdir/secret.js'));
    OUT.realpathProbe.resolveSaysInRepo = JSON.stringify(
      require(path.join(ROOT, 'server', 'http', 'site.js')).resolvePath('/src/inrepo/tests-like.js'));
    OUT.realpathProbe.reasons = probeLogs.map(x => x.reason).filter(Boolean);
    await new Promise(res => srv2.close(res));
    /* 只拆"链接本身"（rmdir），再确认目标目录仍在，最后才删临时根 */
    const rmdir = p => spawnSync('cmd', ['/c', 'rmdir', p], { stdio: 'ignore', windowsHide: true });
    rmdir(linkOut); rmdir(linkIn);
    OUT.realpathProbe.cleanup = {
      linkOutGone: !fs.existsSync(linkOut),
      linkInGone: !fs.existsSync(linkIn),
      outsideStillThere: fs.existsSync(path.join(outside, 'secret.js')),
      inRepoStillThere: fs.existsSync(path.join(inRoot, 'tests-like.js'))
    };
    env.removeLinkSafe(tmpRoot, { recursive: true, force: true });   /* E103／E161：删除走安全出口 —— 本夹具不得留裸递归删形态，否则它一旦被中断留在 _verify 下，下一轮 E103-B⑥ 会把它当"未登记的新调用点"判红（实测 fixture-sse-tag.js:497 就是这么红的） */
  } catch (err) {
    OUT.realpathProbe.note = 'junction/符号链接实验不可用：' + ((err && err.code) || (err && err.message) || String(err)) +
      '（本机 EPERM：Windows 建链接需开发者模式或管理员）—— realpath 防护为**代码级**，此路未做实验';
  }

  /* ================= ⑦c F1：客户端游标**领先服务端**不得变成静默黑洞 ================= */
  const cursorNow = await seqNow(base);
  OUT.cursorAhead = { cursorNow, probes: {} };
  let probeSeq = 0;
  for (const k of [1, 7, 999]) {
    probeSeq++;
    const s = await openStream(base, { path: '/events?since=' + (cursorNow + k) });
    streams.push(s);
    const helloText = await s.pump(250);
    /* 连上之后**立刻发一条新帧**：旧实现在这里会把新事件全滤掉（黑洞），故这是判据的核心一步 */
    OUT.frames.posts.push(await post(base, '/ifd/frame',
      frame(40 + probeSeq, '2026-09-19 10:30:0' + probeSeq)));
    const afterText = await s.pump(350);
    OUT.cursorAhead.probes[k] = {
      since: cursorNow + k, status: s.status, helloText,
      afterText, events: s.events()
    };
    await s.close();
  }
  /* F10：读**日志文件**，取"游标领先"那条留痕（验证打的是客户端原始报数） */
  OUT.cursorAhead.logLines = (() => {
    try {
      const dir = path.join(process.env.DSH_W5_DATA, 'log');
      return fs.readdirSync(dir).filter(f => f.endsWith('.log'))
        .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join('\n').split(/\r?\n/).filter(l => l.includes('游标领先'));
    } catch (err) { return ['ERR:' + ((err && err.code) || err.message)]; }
  })();

  /* ================= ⑦d E22②：testStatus 上行**不伪造**（码原样到 MES；无帧时拒发而不是编一个） =================
     为什么单列：附录 2 的 testStatus 来源＝**PC 上位机**；服务端只能**照抄最近一帧的码** ——
     既不许自造（无帧时编 0/1/2），也不许改写（把「3 设备异常」按本机「维保检修 → 0」那类规则折叠掉）。
     判据（可否证）：① 逐码 0/1/2/3 落帧 ⇒ 报文里的 testStatus 与**落库那一帧**逐个相等；
                    ② 无帧且 dataSource≠mock ⇒「NO_TEST_STATUS」**拒发**、且一条 upload_log 都不写；
                    ③「维保检修 → 0」是**本机**显示模式的反查规则（真源 fieldMap.modeToTestStatus），
                      服务端**不参与**改写 —— 所以码 3 到 MES 仍是 3（与 ① 互为对照）。 */
  OUT.e22 = { order: 'WO-W5-E22', noFrameOrder: 'WO-W5-NOF', codes: [], noFrame: {} };
  OUT.e22.task = await post(base, '/ifa/dispatch',
    { procOrderNo: OUT.e22.order, productCode: 'P-W5', processNo: '30', planQty: 5, equipCode: 'EQ-W5' });
  OUT.e22.taskNoFrame = await post(base, '/ifa/dispatch',
    { procOrderNo: OUT.e22.noFrameOrder, productCode: 'P-W5', processNo: '30', planQty: 5, equipCode: 'EQ-W5' });
  const mesCfg = Object.assign({}, boardConfig, {
    dataSource: 'server',                       /* 关键：**去掉** mock 的 0 兜底，逼出"无帧怎么办" */
    mes: Object.assign({}, boardConfig.mes, { baseUrl: 'http://127.0.0.1:9/mes' })
  });
  const e22Sends = [];
  const e22Fetch = async (url, opts) => {
    e22Sends.push({ url: String(url), body: JSON.parse(opts.body) });
    return { status: 200, text: async () => JSON.stringify({ status: 1, msg: 'ok' }) };
  };
  const repE22 = createUploadReporter({ db, now: clock.source(), fetch: e22Fetch, config: mesCfg });
  const e22LogCount = () => db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c;
  for (const [k, code] of [0, 1, 2, 3].entries()) {
    /* ⚠ collectTime 必须**早于**后面 F2 在途帧（现为 12:00:30）：采样落库口径是"采集时刻比上一帧更新"，
       取更晚的时刻会把后面的在途帧挤成 raw-500ms（本夹具实测踩过两次：F2、以及本波新加的段⑦e）。 */
    const f = frame(70 + k, '2026-09-19 10:31:0' + k);
    f.procOrderNo = OUT.e22.order;
    f.testStatus = code;
    const posted = await post(base, '/ifd/frame', f);
    const built = repE22.buildReport({ procOrderNo: OUT.e22.order });
    const stored = db.prepare(
      'SELECT test_status FROM measure_rt WHERE proc_order_no = ? ORDER BY id DESC LIMIT 1'
    ).get(OUT.e22.order);
    OUT.e22.codes.push({
      code, post: posted,
      built: built.ok ? { ok: true, testStatus: built.body.testStatus, frameId: built.frameId } : built,
      storedTestStatus: stored ? stored.test_status : null
    });
  }
  const e22LogBefore = e22LogCount();
  const e22PendingBefore = repE22.pendingCount(true);       /* 队列里可能已有别的腿留下的待补传件 */
  OUT.e22.noFrame.build = repE22.buildReport({ procOrderNo: OUT.e22.noFrameOrder });
  OUT.e22.noFrame.report = await repE22.report({ procOrderNo: OUT.e22.noFrameOrder });
  OUT.e22.noFrame.logBefore = e22LogBefore;
  OUT.e22.noFrame.logAfter = e22LogCount();
  OUT.e22.noFrame.attempts = repE22.attempts();
  OUT.e22.noFrame.pendingBefore = e22PendingBefore;
  OUT.e22.noFrame.pendingAfter = repE22.pendingCount(true);
  OUT.e22.noFrame.sourceOfTestStatus = repE22.sources().testStatus;
  OUT.e22.sends = e22Sends.length;
  OUT.e22.modeMap = (() => {                       /* 本机显示模式 → 附录 2 码的**真源**（vm 里实跑） */
    try {
      const vm = require('node:vm');
      const sb = { console };
      sb.window = sb;
      vm.createContext(sb);
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'config', 'board.config.js'), 'utf8'), sb);
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'config', 'fieldMap.js'), 'utf8'), sb);
      return Object.assign({}, sb.window.FieldMap.modeToTestStatus);
    } catch (err) { return { ERR: String((err && err.message) || err) }; }
  })();

  /* ================= ⑦e W5-②（技术债 E45）：warning 事件的**真实写入点**判据 =================
     为什么放在这里（而不是段⑥）：① 本段要推"1 s 采样落库"的**真帧**，会往总线上多塞事件，
     段④/⑦ 的续传与环形缓冲断言按 seq **精确对账**，多一条就变红；
     ② 这些帧的**采集时刻必须排在段④/⑦/⑦d 全部取证之后** —— ingest 的 1 s 采样去重是
     "collectTime 不早于上次落库秒"（ADR-0001 D7），时刻排早了会被判成 raw-500ms、
     根本不落库（**本波实测踩过两次**：先用 10:02:xx ⇒ 段⑦ 的 10:01:xx 全变 raw-500ms）。
     故本段排在段⑦d 之后、段⑧优雅关闭之前，采集时刻统一取 **12:00:xx**（远晚于前面所有帧）。

     ⚠ 旧写法（本轮改写）：夹具自己调 judge.evaluate({…},{bus:svc.bus}) 发一条 warning，
     它只能证明"**挂钩可用**"，证明不了"挂在**真实写入点**"（旧断言标题里也如实这么写）。
     新写法：夹具**一次都不直调** judge；只推真帧（POST /ifd/frame → 校验 → 去重 →
     1 s 采样落库 → onSampled → judge.evaluate → bus.publish），从**真 HTTP SSE 连接**上收
     warning 事件 —— 事件里的一切只能来自生产链路。

     判据构造（全部取**配置真源**，不写魔数；期望值现场算出，见 OUT.other.warning.expect）：
       · 先 POST /ifa/dispatch 落一条 task 行（**专用工单 WO-W5W-1**、产品 P-W5W / 工序 30）
         —— 判定取标准按任务的 (产品,工序)。
         ⚠ **两处"专用"都是必须的**（本波各踩过一次，写在这里防回潮）：
           ① 工单号专用：WO-W5-1 在段③/④/⑦ 被推过 13 帧，而它在段⑦d 的 E22 派工里已经
              落过 task 行（INSERT … ON CONFLICT(proc_order_no) DO NOTHING ⇒ 本段的派工**改不动**
              既有行的 product_code）—— 复用它会顺手给那 13 帧也接上标准、各发一条 warning，
              段④ 的 ?since= 逐 seq 对账立刻变红（期望 [4,5,6] 实得 [4,5,6,7,8,9]）；
           ② 产品号专用：P-W5 的标准在段⑥已生效（10:00:06），同样会把段③/④/⑦ 的帧点亮。
         P-W5W 的标准**只在本段写入**，故那些帧仍是"库内无生效标准 ⇒ 不判定、不发布"。
       · 再用 stdRepo.addVersion 写标准（生效时刻 11:59:59；本段之前该产品没有任何标准行）：
         帧的采集时刻取下面的 12:00:xx ⇒ 生效时刻若取错（例如用"当前时刻"而不是**帧的采集时刻**），
         断言必红（库行只对 12:00:xx 生效）；
       · 再推**一帧**真帧，其 depth/speed 按"距上/下限恰 k 格"构造 ⇒ 两参数**同态临近**
         ⇒ FR-5.8 / C-88 口径：参数类**恰 2 条**「参数阈值临近预警」。 */
  const WARN_AT = Object.freeze({ harm: '2026-09-19 12:00:00', err: '2026-09-19 12:00:10', half: '2026-09-19 12:00:20' });
  const harmVec = (() => {
    const grid = 1 / Math.pow(10, boardConfig.standards.digits);
    const near = boardConfig.standards.nearRatio;
    const band = (s) => {
      const upper = Math.round((s.typical + s.upperDev) * 100) / 100;
      const lower = Math.round((s.typical + s.lowerDev) * 100) / 100;
      const k = Math.max(1, Math.ceil((upper - lower) * near / grid - 1e-9));   // standardLevel() 的 k
      return { upper, lower, k,
        warnVal: Math.round((upper - k * grid) * 100) / 100,                    // 距上限恰 k 格 ⇒ 临近
        errVal: Math.round((upper + grid) * 100) / 100 };                       // 越上限一格 ⇒ 超范围
    };
    return { depth: band(boardConfig.standards.default.depth), speed: band(boardConfig.standards.default.speed), grid };
  })();
  const sWarn = await openStream(base);
  streams.push(sWarn);
  await sWarn.pump(120);
  OUT.other.warning = { expect: harmVec, at: WARN_AT };
  warnAtProbe.length = 0;                       // 从本段起点开始只记"本段产生的 warning 信封"

  /* ⚠ 2026-09-30 T2 独立复核（FR-5.11 判据改造 / 需求 C-108）：本票**必须真的下发计划开工时刻**。
     服务端「工单超时」的两个减数由 task.plan_start_time 与 result 表件数算出
     （server/index.js 的 shouldDoneOf() / doneQtyOf()）。若不下发（该列为 NULL），生产侧恒算得
     「应完成 0 / 已完成 0」⇒ 该条退化成一条**恒定 ok 快照**，对账就成了"两边都算 0"的恒等式，
     **取数链路一条都没被验到**（把 shouldDoneOf 改成恒返回 0 也照样全绿 —— 这正是旧写法的问题，
     旧写法在父进程侧把两个减数写死成 0/0）。
     ⚠ 本段在 String.raw 模板里：**注释里不得出现反引号**（会提前闭合外层模板，files-check 的
     node --check 当场红 —— 本次实测踩到过一次），故此处一律用「」或裸标识符。
     故此处下发 11:00:00（在三帧采集时刻 12:00:xx 之前 1 小时）：应完成＝floor(3600 / 节拍 160)＝22 件 > 0，
     而件数门槛（80）不成立 ⇒ 事件里的「工单超时」**只能由比率门槛**判 err ⇒ 判据全链路真的被算出来。 */
  const W5W_PLAN_START = '2026-09-19 11:00:00';
  OUT.other.warning.planStartSent = W5W_PLAN_START;
  OUT.other.warning.dispatch = await post(base, '/ifa/dispatch', {
    procOrderNo: 'WO-W5W-1', productCode: 'P-W5W', processNo: '30', planQty: 6, equipCode: 'EQ-W5',
    planStartTime: W5W_PLAN_START
  });
  OUT.other.warning.stdV2 = stdRepo.addVersion(db, {
    productCode: 'P-W5W', processCode: '30',
    depthUpperDev: boardConfig.standards.default.depth.upperDev,
    depthLowerDev: boardConfig.standards.default.depth.lowerDev,
    depthTypical: boardConfig.standards.default.depth.typical,
    speedUpperDev: boardConfig.standards.default.speed.upperDev,
    speedLowerDev: boardConfig.standards.default.speed.lowerDev,
    speedTypical: boardConfig.standards.default.speed.typical
  }, '2026-09-19 11:59:59', '2026-09-19 11:59:59', { bus: svc.bus });

  /* 这一帧：**同态临近**（深度与速度各距上/下限恰 k 格）⇒ 参数类恰 2 条。
     ⚠ 本段三帧一律带**件序号**（生产字段名 unitIndex，IF-D.4 / C-103）—— 理由见下面
     harmFrame.unitIndex 那一处（不带 ⇒ 工单类在"事件"与"期望"两侧不同侧，逐字对账当场红）。 */
  const harmFrame = frame(30, WARN_AT.harm);
  harmFrame.procOrderNo = 'WO-W5W-1';
  /* ⚠ **必须带件序号**（T-20260930-12a 把两条失配断言对齐到座位 6 的修复）：
     「emitWarnings()」的现行口径是「拿不到件序号（帧未带/非法 unitIndex）⇒ 本件**不固化** ＋
     本次判定**不产生**「工单超时预警」」（E60 裁定①）。而本节的期望侧重算**恒传**
     shouldDone / doneQty 两个减数（orderDerive + recompute）⇒ 帧不带件序号时，
     「事件 3 条（参数类 2 ＋ 维保 1） vs 重算 4 条（多一条工单类）」当场变红（实测红项）。
     带上之后两侧同口径：工单类在事件与重算里都出现，逐字相等重新成立。
     同票两帧都取第 1 件（都是测试中：testStatus=1）：DR-19 按件幂等 ⇒ 该票只落 1 行
     result（结果「测试中」**不进** countDone）⇒ 期望侧读到的已完成件数仍是 0。 */
  harmFrame.unitIndex = 1;
  harmFrame.depth = harmVec.depth.warnVal;
  harmFrame.speed = harmVec.speed.warnVal;
  OUT.other.warning.warnPost = await post(base, '/ifd/frame', harmFrame);

  /* 这一帧：**超范围**（深度越上限一格）⇒ 出「参数超范围预警」（速度仍临近）；同样带件序号 */
  const errFrame = frame(31, WARN_AT.err);
  errFrame.procOrderNo = 'WO-W5W-1';
  errFrame.unitIndex = 1;                  /* 同票同件（测试中）⇒ 工单类照常参与对账 */
  errFrame.depth = harmVec.depth.errVal;
  errFrame.speed = harmVec.speed.warnVal;
  OUT.other.warning.errPost = await post(base, '/ifd/frame', errFrame);

  /* ---- 负向判据：**标准未设定 ⇒ 不产生参数类预警**（C-93⑤ / FR-5.8） ----
     构造（**在真实写入点上判**，不是调 judge 自证）：
       · 另起一票 WO-W5-2（产品 P-W5B / 工序 30），用**显式危险开关**写一条**半套库行**标准
         （只有深度三格、**没有速度列**）—— 这正是"某参数标准未设定"的形态；
       · 推一帧：深度与速度**双双越上限**。若判定层对"未设定的速度"回退到配置演示值（旧行为），
         事件里会出现**速度**那条参数类预警；正确行为是**速度一条都不产生**（FR-3.18 / C-93⑤）。
       · 另一面由"恰 3 条"那条锁住：库里**没有生效标准**时（12:00:00 之前推的帧）不得发布
         warning 事件 —— 多一条就红。 */
  OUT.other.warning.dispatchHalf = await post(base, '/ifa/dispatch', {
    procOrderNo: 'WO-W5-2', productCode: 'P-W5B', processNo: '30', planQty: 3, equipCode: 'EQ-W5'
  });
  OUT.other.warning.stdHalf = stdRepo.addVersion(db, {
    productCode: 'P-W5B', processCode: '30',
    depthUpperDev: boardConfig.standards.default.depth.upperDev,
    depthLowerDev: boardConfig.standards.default.depth.lowerDev,
    depthTypical: boardConfig.standards.default.depth.typical
  }, '2026-09-19 11:59:59', '2026-09-19 11:59:59', { bus: svc.bus, dangerouslySkipValidation: true });
  const halfFrame = frame(40, WARN_AT.half);
  halfFrame.procOrderNo = 'WO-W5-2';
  /* 本票的采集时刻 12:00:20 **晚于**前一票两帧（12:00:00 / 12:00:10）——
     1 s 采样去重是「不得早于上次落库那一秒」（ADR-0001 D7）：同秒或更早会被判 raw-500ms
     ⇒ 不落库、也就没有 warning 事件。件序号同样必须带（不带则该帧的工单类整条消失）。 */
  halfFrame.unitIndex = 1;
  halfFrame.depth = harmVec.depth.errVal;
  halfFrame.speed = harmVec.speed.errVal;
  OUT.other.warning.halfPost = await post(base, '/ifd/frame', halfFrame);
  OUT.other.warning.halfExpect = {
    depthErr: harmVec.depth.errVal, speedErr: harmVec.speed.errVal,
    /* "标准未设定"的**实际形态**：库行里速度三格是 **null**（不是"列不存在" —— 列由 schema 固定，
       未录入就是 SQL NULL）。故判据看**值**，不看列是否存在。 */
    halfRow: stdRepo.getEffective(db, { productCode: 'P-W5B', processCode: '30', at: WARN_AT.half }) || null
  };
  OUT.other.warning.ifdStatus = await (await fetch(base + '/ifd/status')).json();
  /* 夹具①这台服务的「/health」（装配自报）：R1 只把它当**实例健康**的旁证 —— E58 的闸字段
     （orderWarningSource）已随 T-20260930-08 删除，期望侧**不再**由任何「闸值」决定
     「工单超时」参不参与对账（无闸 ⇒ 恒按库里真值参与）。
     ⚠ 本段在 String.raw 模板里：**注释里不得出现反引号**（会提前闭合外层模板，files-check 的
     node --check 当场红 —— 本次实测又踩到一次）。 */
  OUT.other.warning.health = await (await fetch(base + '/health')).json();
  /* 本节对账要用的**夹具实测状态**（从库里回读，不靠"我以为"）：派工是否真的落进
     task.plan_start_time、该票 result 表件数（已完成）⇒ 父进程据此**现场推导**期望值，
     而不是把两个减数写死（旧写法 shouldDone:0/doneQty:0 就是写死，见本段断言前提）。 */
  OUT.other.warning.taskRow = db.prepare(
    'SELECT proc_order_no, product_code, process_no, plan_qty, plan_start_time FROM task WHERE proc_order_no = ?'
  ).get('WO-W5W-1') || null;
  OUT.other.warning.doneQty = db.prepare(
    "SELECT COUNT(*) AS n FROM result WHERE proc_order_no = ? AND result IN ('合格','不合格')"
  ).get('WO-W5W-1').n;
  /* 三帧的 testStatus **从库里回读**（不是把「我们打算发的码」记下来）：期望侧的 progress
     必须由**已落库的那条事实**按 C-98④ / FR-2.5 的同一映射导出（见父进程 progressOfStatus()）——
     这样「采信了帧自报的 progress（C-102③ 明令仅比对与展示）」或「testStatus 没传进判定层」
     都会当场变红，而不是靠两边都漏算同一项凑成恒等式。 */
  OUT.other.warning.frameStatus = (() => {
    const q = db.prepare('SELECT test_status FROM measure_rt WHERE proc_order_no = ? AND collect_time = ?');
    const at = (no, ct) => {
      const r = q.get(no, ct);
      return r ? r.test_status : null;
    };
    return {
      harm: at('WO-W5W-1', WARN_AT.harm),
      err: at('WO-W5W-1', WARN_AT.err),
      half: at('WO-W5-2', WARN_AT.half)
    };
  })();
  OUT.other.warning.hookAt = warnAtProbe.slice();      // 进程内信封：seq + at（判定时刻）
  await sWarn.pump(400);
  OUT.other.warning.stream = { text: sWarn.text(), events: sWarn.events() };
  await sWarn.close();

  /* ================= ⑧ 优雅关闭 ================= */
  const sA = await openStream(base);
  streams.push(sA);
  await sA.pump(150);
  const closedCount = svc.router.closeAllStreams();
  const textA1 = await sA.pump(250);                   // 应收敛到「: bye」+ 连接结束
  const before = sA.text();
  await sA.pump(500);                                  // 5×心跳周期：不应再有任何新字节
  OUT.close = {
    closedCount, textA1, sawBye: /: bye /.test(textA1), streamDone: sA.finished(),
    afterByeBytes: sA.text().length - before.length,
    streamsAfterCloseAll: svc.router.streamCount()
  };
  await sA.close();

  /* F2：**在途 keep-alive POST + 停机**（旧实现只在 server.close() 后回收一次空闲连接，
     在途请求应答完变空闲后就再没人回收 ⇒ 只能等对端 FIN，审查实测被拖到 ~6.35 s）。
     构造：裸 socket 先送请求头 + 一半 body（服务端已开始处理 ⇒ 在途），停机窗口内补齐 body。 */
  const sB = await openStream(base);
  streams.push(sB);
  const inflightBody = Buffer.from(JSON.stringify(frame(88, '2026-09-19 12:00:30')), 'utf8');
  const postSock = net.connect(port, '127.0.0.1');
  let postResponse = '';
  let postClosedAt = null;
  postSock.setEncoding('utf8');
  postSock.on('data', c => { postResponse += c; });
  postSock.on('close', () => { postClosedAt = Date.now(); });
  await new Promise(r => postSock.on('connect', r));
  const rowsBeforeInflight = rowCount();
  postSock.write('POST /ifd/frame HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\n' +
    'Content-Type: application/json\r\nContent-Length: ' + inflightBody.length + '\r\n' +
    'Connection: keep-alive\r\n\r\n' + inflightBody.slice(0, 8).toString('utf8'));
  await sleep(60);                                     // 让服务端确实读到请求头（进入"在途"）
  const t0 = Date.now();
  OUT.close.connsBeforeStop = conns.filter(c => c.closedAt === null).length;
  /* 停机各阶段的墙钟留痕（自检用：把"到底卡在哪一步"变成可读证据） */
  const marks = [];
  const lg = entry.state.logger;
  if (lg && typeof lg.info === 'function') {
    const orig = lg.info.bind(lg);
    lg.info = (m, x) => { marks.push((Date.now() - t0) + 'ms ' + String(m).slice(0, 70)); return orig(m, x); };
  }
  const origWarn = lg && typeof lg.warn === 'function' ? lg.warn.bind(lg) : null;
  if (lg && origWarn) lg.warn = (m, x) => { marks.push((Date.now() - t0) + 'ms [warn] ' + String(m).slice(0, 70)); return origWarn(m, x); };
  /* 停机开始后再补齐 body（此时请求处于在途；停机**不得**把它打断） */
  const finishBody = setTimeout(() => { try { postSock.write(inflightBody.slice(8)); } catch { /* 已断 */ } }, 120);
  OUT.close.stopResult = await entry.stop('w5 夹具：优雅退出（含在途 keep-alive POST）');
  OUT.close.stopMs = Date.now() - t0;
  OUT.close.marks = marks;
  clearTimeout(finishBody);
  await sleep(250);                                    // 收尾读响应
  OUT.close.inflight = {
    responseStatusLine: String(postResponse).split('\r\n')[0],
    responseOutcome: ((/\"outcome\":\"([a-z0-9-]+)\"/.exec(postResponse) || [])[1]) || null,
    bodyCompletedAt: null,
    closedAfterStop: postClosedAt === null ? null : postClosedAt - t0,
    rowsBefore: rowsBeforeInflight,
    rowsAfter: (() => {
      try {                                       // 库已关：另开**只读**连接数行数（单源对账）
        const { DatabaseSync } = require('node:sqlite');
        const d2 = new DatabaseSync(process.env.DSH_W5_DB, { readOnly: true });
        const c = d2.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
        d2.close();
        return c;
      } catch (err) { return 'ERR:' + ((err && err.code) || err.message); }
    })()
  };
  OUT.close.conns = conns.map(c => ({
    openedAfterStop: c.openedAt - t0,
    closedAfterStop: c.closedAt === null ? null : c.closedAt - t0,
    urls: c.urls
  }));
  await sB.pump(300);
  OUT.close.streamB = { text: sB.text(), done: sB.finished(), sawBye: /: bye /.test(sB.text()) };
  OUT.close.afterStop = {
    streams: svc.router.streamCount(),
    serverNull: entry.state.server === null,
    dbNull: entry.state.db === null,
    busClosed: svc.bus.isClosed(),
    busSubscribers: svc.bus.stats().subscribers,
    busDropped: svc.bus.dropped(),
    linkRunning: svc.linkMonitor.running(),
    sseStatus: svc.router.sseStatus()
  };
  try { postSock.destroy(); } catch { /* 已断 */ }
  await sB.close();
  for (const s of streams) await s.close();

  OUT.done = true;
  SAVE();
})().catch(err => {
  OUT.error = String(err && err.stack ? err.stack : err);
  SAVE();
  process.exitCode = 1;
});
`;
  const W5_FIXTURE_NONLOOP = String.raw`'use strict';
/* W5-① 追加（裁定「选项 A」）：**非回环绑定**下不得回任何 CORS 头（守 NFR-25 / AC-09）。
   为什么必须另起一个夹具进程：监听地址只在「start()」时定，一个进程内改不了。 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
process.env.DSH_ENV = 'test';
const entry = require(path.join(ROOT, 'server', 'index.js'));

const OUT = {};
const SAVE = () => fs.writeFileSync(process.env.DSH_W5_RESULT, JSON.stringify(OUT, null, 1), 'utf8');

(async () => {
  const port = Number(process.env.DSH_W5_PORT);
  const base = 'http://127.0.0.1:' + port;         // 从回环侧去连（服务确实绑在 0.0.0.0）
  const svc = await entry.start({
    argv: ['--host', '0.0.0.0', '--port', String(port), '--data-dir', process.env.DSH_W5_DATA, '--db-file', process.env.DSH_W5_DB],
    installSignalHandlers: false,
    logConsole: false
  });
  const probe = async (p, opts = {}) => {
    const r = await fetch(base + p, opts);
    const text = await r.text();
    return {
      status: r.status,
      acao: r.headers.get('access-control-allow-origin'),
      acac: r.headers.get('access-control-allow-credentials'),
      len: text.length,
      text: text.slice(0, 120)
    };
  };
  OUT.listen = svc.listen;
  OUT.bind = entry.listenAddress();
  OUT.corsStatus = svc.cors.status();
  OUT.nullOrigin = await probe('/state', { headers: { Origin: 'null' } });
  OUT.loopbackOrigin = await probe('/state', { headers: { Origin: 'http://127.0.0.1:' + port } });
  OUT.evilOrigin = await probe('/state', { headers: { Origin: 'http://evil.example' } });
  OUT.preflightNull = await probe('/upload/retry', {
    method: 'OPTIONS',
    headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' }
  });
  OUT.siteRoot = await probe('/');
  OUT.stopResult = await entry.stop('w5 非回环夹具');
  SAVE();
})().catch(err => {
  OUT.error = String(err && err.stack ? err.stack : err);
  SAVE();
  process.exitCode = 1;
});
`;

  /* ============ 一、进程内事件总线（有界环形缓冲 / seq / since / 隔离 / close） ============ */
  const { createEventBus, KIND: SSE_KIND, KINDS: SSE_KINDS } = require('../server/services/eventBus');
  const busClock = createClock({ mode: 'fixed', at: '2026-09-19T10:00:00' });
  const injectedBusAt = busClock.now().toISOString();
  const busLog = { errors: [], warns: [], infos: [] };
  const busLogger = {
    error: (m, d) => busLog.errors.push([String(m), d]),
    warn: (m, d) => busLog.warns.push([String(m), d]),
    info: (m, d) => busLog.infos.push([String(m), d])
  };
  const bus = createEventBus({ capacity: 3, now: busClock.source(), logger: busLogger });
  const pHolder = { a: 1, b: '二' };
  const e1 = bus.publish(SSE_KIND.FRAME, pHolder);
  const e2 = bus.publish(SSE_KIND.FRAME, pHolder);
  const e3 = bus.publish(SSE_KIND.FRAME, pHolder);
  const e4 = bus.publish(SSE_KIND.LINK, { online: false });
  const e5 = bus.publish(SSE_KIND.TASK, { procOrderNo: 'WO-1' });
  t.check('W5：事件总线 `seq` 从 1 起、逐条 +1，且 `at` 一律取自**注入时钟**（不是裸 new Date）',
    [e1, e2, e3, e4, e5].every((e, i) => e && e.seq === i + 1 && e.at === injectedBusAt) &&
    e5.kind === SSE_KIND.TASK && e5.payload.procOrderNo === 'WO-1',
    `seq=${e1.seq}..${e5.seq} at=${e1.at}（注入=${injectedBusAt}）`);

  t.check('W5-⑦：有界环形缓冲（容量 3）溢出 ⇒ **丢最旧**且 `dropped` 如实计数（不得静默丢）',
    bus.dropped() === 2 && bus.stats().buffered === 3 && bus.stats().capacity === 3 &&
    bus.range().oldest === 3 && bus.range().newest === 5,
    `dropped=${bus.dropped()} buffered=${bus.stats().buffered} oldest=${bus.range().oldest} newest=${bus.range().newest}`);

  const subReplay = bus.subscribe(() => { /* 只验补发清单 */ }, { since: 2 });
  const subHole = bus.subscribe(() => { /* 只验补不齐 */ }, { since: 1 });
  t.check('W5-②：`subscribe(since)` 补得齐 ⇒ replay 按序不重不漏；补不齐（超出缓冲）⇒ 退回 hello 且 `missed` 如实',
    subReplay.mode === 'replay' && subReplay.replay.map(e => e.seq).join(',') === '3,4,5' &&
    subHole.mode === 'hello' && subHole.missed === 1 && subHole.replay.length === 0,
    `可补：mode=${subReplay.mode} seq=[${subReplay.replay.map(e => e.seq).join(',')}]；补不齐：mode=${subHole.mode} missed=${subHole.missed}`);
  t.check('W5-②：非法 `since`（非数字／负数／小数／空串）一律按"无 since"处理 ⇒ hello（不抛错、不 500）',
    [null, undefined, '', 'abc', '-5', '1.5', 1.5, -1, '9e9'].every(v => {
      const h = bus.subscribe(() => { /* 探针 */ }, { since: v });
      const ok = h.mode === 'hello';
      h.unsubscribe();
      return ok;
    }),
    '九种非法/缺省取值全部得到 hello 模式');
  t.check('W5：未知事件种类直接抛 `RangeError`（种类固定，防"同义名"在前后端分叉）',
    (() => {
      let threw = false;
      try { bus.publish('frame2', {}); } catch (err) { threw = err instanceof RangeError; }
      return threw && SSE_KINDS.join(',') === 'frame,link,task,standard,upload,warning';
    })(), `固定种类=${SSE_KINDS.join(',')}`);

  const order = [];
  bus.subscribe(() => { throw new Error('W5 夹具注入的订阅者错误'); }, { since: 5 });
  bus.subscribe(evt => order.push(evt.seq), { since: 5 });
  let publishThrew = false;
  let e6 = null;
  try { e6 = bus.publish(SSE_KIND.WARNING, { lv: 'warn' }); } catch { publishThrew = true; }
  t.check('W5：订阅者抛错**逐订阅者隔离**（其它订阅者照收、发布方不抛），且**不吞**（logger.error + 计数留痕）',
    publishThrew === false && e6 && e6.seq === 6 && order.join(',') === '6' &&
    bus.stats().handlerErrors === 1 && bus.stats().errors.length === 1 &&
    busLog.errors.length === 1 && /订阅者抛错/.test(busLog.errors[0][0]) &&
    busLog.errors[0][1].seq === 6 && /注入的订阅者错误/.test(busLog.errors[0][1].message),
    `handlerErrors=${bus.stats().handlerErrors} logger.error=${busLog.errors.length} 其它订阅者收到=[${order.join(',')}]`);

  const subsBeforeClose = bus.size();
  const closedCount = bus.close();
  const afterCloseEvent = bus.publish(SSE_KIND.FRAME, { i: 9 });
  t.check('W5：`close()` 清空订阅者与缓冲；关闭后 publish **不静默**（返回 null + 计数 + 日志）',
    subsBeforeClose === 4 && closedCount === subsBeforeClose && bus.size() === 0 && afterCloseEvent === null &&
    bus.stats().afterClose === 1 && bus.stats().buffered === 0 && busLog.warns.length === 1 &&
    /总线已关闭/.test(busLog.warns[0][0]),
    `关前订阅者=${subsBeforeClose} 清掉=${closedCount} 关后 size=${bus.size()} afterClose=${bus.stats().afterClose} warn=${busLog.warns.length}`);

  /* ============ 二、夹具①：真起服务跑完整 SSE 流程（含 CORS 与静态托管） ============ */
  const w5Scratch = path.join(env.paths.root, 'tests', '._verify', 'w5sse');
  fs.mkdirSync(w5Scratch, { recursive: true });
  const w5Tmp = harness.makeTempDir('w5-sse');
  /* ⚠ 夹具文件名带**本次运行的唯一标签**（pid＋时间戳）：本仓门禁允许并发跑（E19 现实），
     固定文件名会让两个 harness-check 互相覆盖/互删（实测：并发轮次里 W6 段的共享临时目录被
     另一轮删掉，直接以 ENOENT 崩在夹具中途）。只删自己写的文件，不删目录。 */
  const w5RunTag = process.pid + '-' + Date.now().toString(36);
  const w5Write = (name, text) => {
    const full = path.join(w5Scratch, name);
    fs.writeFileSync(full, text, 'utf8');
    return full;
  };
  const w5Read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  /** 原地起子进程（stdout/stderr 落文件：受限沙箱下管道会 EPERM；日志留给失败排查） */
  const w5Spawn = (script, name, extraEnv) => {
    const logFile = path.join(w5Tmp, name + '.log');
    const fd = fs.openSync(logFile, 'a');
    const proc = spawn(process.execPath, [script], {
      cwd: env.paths.root,
      env: Object.assign({}, process.env, { DSH_ENV: 'test' }, extraEnv),
      windowsHide: true,
      stdio: ['ignore', fd, fd]
    });
    let settled = null;
    proc.on('exit', (code, signal) => { settled = { code, signal }; });
    return {
      proc, logFile, exitInfo: () => settled,
      log: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
      async waitDone(ms) {
        const until = Date.now() + ms;
        while (!settled && Date.now() < until) await new Promise(r => setTimeout(r, 100));
        try { fs.closeSync(fd); } catch { /* 已关 */ }
        return settled;
      }
    };
  };

  const fSse = w5Write('fixture-sse-' + w5RunTag + '.js', W5_FIXTURE_SSE);
  const fNonLoop = w5Write('fixture-nonloopback-' + w5RunTag + '.js', W5_FIXTURE_NONLOOP);

  const w5Port = await harness.allocPort();
  const w5Data = path.join(w5Tmp, 'data-sse');
  const w5Result = path.join(w5Tmp, 'sse-result.json');
  const runSse = w5Spawn(fSse, 'fixture-sse', {
    DSH_W5_PORT: String(w5Port), DSH_W5_DATA: w5Data,
    DSH_W5_DB: path.join(w5Data, 'board.db'), DSH_W5_RESULT: w5Result
  });
  const w5Watchdog = setTimeout(() => { try { runSse.proc.kill(); } catch { /* 已退出 */ } }, 90000);
  const w5Exit = await runSse.waitDone(90000);
  clearTimeout(w5Watchdog);
  const S = w5Read(w5Result);
  if (!t.requires('W5 夹具① 能取到结果文件（sse-result.json）', Boolean(S), runSse.log().slice(-500) || '无日志')) {
    t.info('W5：夹具①未产出结果，本节相关断言按失败处理（不许把"跑不了"当通过）');
  }
  const s = S || {};
  const evts = o => (o && Array.isArray(o.events) ? o.events : []);
  const kindsOf = (o, k) => evts(o).filter(e => e.event === k);
  const idsOf = o => evts(o).map(e => e.id);

  /* ===== E58（DR-05 写入点，`T-20260930-08` 收口后）**真计数**夹具：`result` 表件数驱动「工单超时预警」 =====
     为什么另起一个**进程内**实例，而不是复用夹具①那台 W5 服务：
       · 夹具①（上面那台）由 `w5Spawn` **另起子进程**，父进程**够不着**它的库句柄与 `state`
         （`harness.startService` 只给它 argv/env）⇒ 在夹具①上无从按件对账 `result` 表
         （`countDone` / `countByTask` / `getOne` 一个都读不到）；
       · 而"件数驱动预警"这条判据**必须**在真生产链路上验（派工 → 真帧 → 1 s 采样落库 →
         onSampled → emitWarnings → judge.evaluate → bus → **DR-05 按件固化**）；
       · 本文件既有的"父进程进程内起服务"惯例就在这两行附近（层② 的 W7 段、层③ 的用例段都用
         `entry.start({argv, installSignalHandlers:false, logConsole:false, clock})` 的原样写法），
         故这里**沿用同一惯例**，不另造一套。
     ⚠ E58 的临时闸（`start()` 的 `orderDoneSourceReady` 注入位 / `ORDER_DONE_SUPPRESS_REASON` 字面量 /
     `/health.orderWarningSource` 字段 / 启动日志抑制行）已由 `T-20260930-08` **整段拆除** ⇒
     本段**不读任何"闸"字段**：件数只有一条真源（`result` 表按件计数），"该类整条不产生"与
     "该类判 ok"不再混为一谈 —— 旧写法正是靠**已删字段**决定期望值，字段消失后退化成
     `undefined === undefined` 的**恒真式**（ADR-0004 D23 明令禁止；本轮把那一整段换成本段）。
     时钟：本段用**局部**注入时钟（值固定 10:00:00）；判定取的时刻一律是**帧的采集时刻**
     （12:00:xx，ADR-0003 D17），与"注入时钟停在几点"无关。
     ⚠ 本段**不往 `result` 塞任何行**：所有行都由**推帧**经真正的写入点（`emitWarnings()` →
     `persistJudgement()` → `repo/result.js` 的 `upsertJudgement()`）产生；读口也走生产同一口
     `repo/result.js`（不另写第二份 SQL）。 */
  const CNT_F1 = '2026-09-19 12:00:00';
  const CNT_F2 = '2026-09-19 12:00:01';
  const CNT_F3 = '2026-09-19 12:00:02';
  const CNT_HALF = '2026-09-19 12:00:10';
  const CNT_FAIL = '2026-09-19 12:00:20';
  /* ⚠ 采集时刻必须**全局严格递增**：ingest 的 1 s 采样口径是"collectTime 不得早于上次落库那一秒"
     （ADR-0001 D7）——同秒的另一票会被判成 `raw-500ms`、**不落库**，也就不会产生 `warning` 事件
     （实测踩过一次：旧写法里第二票与主票同秒 ⇒ 该票事件条为 []）。 */
  /** `yyyy-MM-dd HH:mm:ss`（DR-16）：本段只用它把"计划开工"按**配置节拍**摆到首帧之前 */
  const textOfDate = d => d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0');
  const CNT_CYCLE = Number(boardConfig.production.cycleSec);
  /* 计划开工 ＝ 首帧前 **(节拍 + 1) 秒**（由**配置节拍**现算，不写死时刻）：
     现场推导应完成 ＝ floor((节拍 + 1) ÷ 节拍) ＝ 1 件 ⇒ "恰 1 件已完成"就能把落后率从 100% 压到 0%
     ⇒ 「工单超时预警」的 **err → ok 翻转**可以在**同一票、同一节拍**上被观测到。
     这是本段的核心构造：不构造出"非零已完成"，"`result` 表件数真的被读进判据"就无从证明。 */
  const CNT_PLAN_START = textOfDate(new Date(Date.parse(CNT_F1.replace(' ', 'T')) - (CNT_CYCLE + 1) * 1000));
  const CNT_DEPTH = boardConfig.standards.default.depth.typical;
  const CNT_SPEED = boardConfig.standards.default.speed.typical;
  const orderTitle = judge.OTHER_TITLES.order;
  const countProbe = async label => {
    /* 本段自带的 POST 小工具：**不能**复用文件里那两个同名 `post`（它们在别的块作用域／子进程里，
       本作用域取不到 —— 实测 `typeof post === 'undefined'`）。零依赖，仍走真 HTTP。 */
    const cntPost = async (b, p, body) => {
      const res = await fetch(b + p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      let parsed = null;
      try { parsed = await res.json(); } catch { /* 非 JSON */ }
      return { status: res.status, body: parsed };
    };
    const tmp = harness.makeTempDir('e58-count-' + label);
    const logLines = [];
    const cntLogger = {
      info: m => logLines.push(String(m)),
      warn: m => logLines.push(String(m)),
      error: m => logLines.push(String(m))
    };
    const cntClockMs = Date.parse('2026-09-19T10:00:00');
    const cntClock = {
      now: () => new Date(cntClockMs),
      source: () => () => new Date(cntClockMs)
    };
    const out = {
      label, tmp, logLines, warnings: [], posts: [], frameStatus: {},
      ticketA: 'WO-E58c-' + label, ticketB: 'WO-E58c-half-' + label,
      /* 负向靶子的票（T-20260930-12a）：**专用**工单号/产品号 —— 它的帧刻意不带件序号，
         故绝不能与上面两条正向票共用（否则"0 行"会被正向帧的行污染，判据失去判别力）。 */
      ticketC: 'WO-E58c-nounit-' + label
    };
    /** 第 k 条 `warning` 事件里的「工单超时预警」行（0 起；本段每帧恰产生 1 条事件） */
    out.orderRowsAt = k => {
      const p = out.warnings[k];
      const ws = p && Array.isArray(p.warnings) ? p.warnings : [];
      return ws.filter(w => w.title === orderTitle);
    };
    let svc = null;
    let savedUpsert = null;
    try {
      svc = await serverEntry.start({
        argv: ['--port', '0', '--data-dir', tmp, '--db-file', path.join(tmp, 'board.db')],
        installSignalHandlers: false, logConsole: false, logger: cntLogger, clock: cntClock
      });
      out.port = svc.port;
      out.base = 'http://127.0.0.1:' + svc.port;
      out.listen = svc.listen;                        // 形如 host:port（port 传 0 ⇒ 必须读回真实端口）
      out.health = await (await fetch(out.base + '/health')).json();
      const db = serverEntry.state.db;
      /* `result` 表的**现场读数**（全部走生产同一口 `repo/result.js`）：
         `done` ＝ 已完成件数（合格＋不合格）、`rows` ＝ 该票行数（幂等对账用）。 */
      const readCounts = no => ({ done: resultRepo.countDone(db, no), rows: resultRepo.countByTask(db, no) });
      /* 收件箱分流（T-20260930-12a）：本段前四条的读数一律取**A/B/注入失败那五帧**的现场，
         故 `out.warnings` 的长度必须仍恰等于那五帧（"每帧恰 1 条"是逐条锁死的对账）；
         负向靶子（票 C）的事件**另走**一个收件箱（`nuSink`）⇒ 一条不少地存进 `out.noUnit.events`，
         同时不污染前面已记的读数。分流的只有"收进哪个数组"，事件本身照样来自同一条生产链路。 */
      let nuSink = null;
      const subW = svc.bus.subscribe(e => {
        if (e.kind !== 'warning') return;
        (nuSink || out.warnings).push(e.payload);
      });
      out.unsubscribe = () => { try { svc.bus.unsubscribe(subW); } catch { /* 已关 */ } };

      /* ---- 票 A：**全标准 + 计划开工**（"件数驱动"的主现场）---- */
      const A = out.ticketA, PA = 'P-E58c-' + label;
      out.dispatchA = await cntPost(out.base, '/ifa/dispatch', {
        procOrderNo: A, productCode: PA, processNo: '30',
        planQty: 6, equipCode: 'EQ-E58', planStartTime: CNT_PLAN_START
      });
      stdRepo.addVersion(db, {
        productCode: PA, processCode: '30',
        depthUpperDev: boardConfig.standards.default.depth.upperDev,
        depthLowerDev: boardConfig.standards.default.depth.lowerDev,
        depthTypical: boardConfig.standards.default.depth.typical,
        speedUpperDev: boardConfig.standards.default.speed.upperDev,
        speedLowerDev: boardConfig.standards.default.speed.lowerDev,
        speedTypical: boardConfig.standards.default.speed.typical
      }, CNT_PLAN_START, CNT_PLAN_START, { bus: svc.bus });
      out.taskRowA = db.prepare(
        'SELECT proc_order_no, product_code, process_no, plan_qty, plan_start_time FROM task WHERE proc_order_no = ?'
      ).get(A) || null;
      out.countsBefore = readCounts(A);              // 推帧**之前**的现场读数（不是"我以为是 0"）
      const push = async (no, seq, at, testStatus, unitIndex) => {
        const res = await cntPost(out.base, '/ifd/frame', {
          equipCode: 'EQ-E58', procOrderNo: no, collectTime: at, seq,
          depth: CNT_DEPTH, speed: CNT_SPEED, velocity_x: 3, velocity_y: 4,
          frameRate: 1000, gain: 2.5, shutter: 500, cameraDepth: 12.5, testStatus, unitIndex
        });
        await new Promise(r => setTimeout(r, 400));    // 让 onSampled 挂钩跑完、事件落进订阅者
        /* 该帧固化**之后**的现场读数 ＋ 该帧 `testStatus` 的**库内回读**（生产读的是同一条已落库
           事实；本段不记"打算发的码" ⇒ "采信帧自报 progress（C-102③ 仅比对展示）"或
           "`testStatus` 没传进判定层"都会变红，而不是两边都漏算同一项凑成恒等式）。 */
        const st = db.prepare(
          'SELECT test_status FROM measure_rt WHERE proc_order_no = ? AND collect_time = ?').get(no, at);
        const rec = {
          ticket: no, seq, at, testStatus, unitIndex, res, counts: readCounts(no),
          storedStatus: st ? st.test_status : null
        };
        out.posts.push(rec);
        out.frameStatus[at] = rec.storedStatus;
        return rec;
      };
      await push(A, 9501, CNT_F1, 1, 1);              // 测试中（progress 0.5）
      await push(A, 9502, CNT_F2, 2, 1);              // 判定（progress 1 ⇒ 合格）；固化在预警**之后**
      await push(A, 9503, CNT_F3, 1, 1);              // 同一件再来一帧（终态不得回退 / 行数不得增）
      out.rowA1 = resultRepo.getOne(db, A, 1);
      out.doneA = resultRepo.countDone(db, A);
      out.rowsA = resultRepo.countByTask(db, A);

      /* ---- 票 B：**半套标准（速度三格未设定）+ 无计划开工**，一帧判「待复检」----
         一次覆盖两件事：① `待复检`（判定依据不成立）**不计**「已完成」（行在、`countDone` 不加）；
         ② `shouldDoneOf()` 返 0（无计划开工）⇒ 应完成 0 ⇒ 该类判 **ok**
            （旧口径"计划数 − 已完成"在这里恒报 err —— 这正是 C-108 换判据要修的那一半）。 */
      const B = out.ticketB, PB = 'P-E58c-half-' + label;
      out.dispatchB = await cntPost(out.base, '/ifa/dispatch', {
        procOrderNo: B, productCode: PB, processNo: '30',
        planQty: 3, equipCode: 'EQ-E58'                        // ⚠ 故意**不下发** planStartTime
      });
      stdRepo.addVersion(db, {
        productCode: PB, processCode: '30',
        depthUpperDev: boardConfig.standards.default.depth.upperDev,
        depthLowerDev: boardConfig.standards.default.depth.lowerDev,
        depthTypical: boardConfig.standards.default.depth.typical
      }, CNT_HALF, CNT_HALF, { bus: svc.bus, dangerouslySkipValidation: true });
      out.taskRowB = db.prepare(
        'SELECT proc_order_no, plan_start_time FROM task WHERE proc_order_no = ?'
      ).get(B) || null;
      await push(B, 9511, CNT_HALF, 2, 1);            // 判定 ⇒ 速度标准未设定 ⇒ idle ⇒ **待复检**
      out.rowB1 = resultRepo.getOne(db, B, 1);
      out.doneB = resultRepo.countDone(db, B);
      out.rowsB = resultRepo.countByTask(db, B);

      /* ---- 写失败注入：证明"固化失败**不污染采集链**" ----
         手法：`server/index.js` 顶层是 `const resultRepo = require('./repo/result')`，调用点写的是
         `resultRepo.upsertJudgement(...)` ⇒ 换掉**同一模块对象**上的这个属性即可作用于生产链路
         （Node 模块缓存），**不必改被测实现**；测完**当场还原**（`finally` 里再兜一层）。 */
      out.failuresBefore = serverEntry.state.resultWrite.failures;
      out.writesBefore = serverEntry.state.resultWrite.writes;
      out.warnBeforeFail = out.warnings.length;
      /* 注入**之前**已推的帧数（`T-20261003-04` 甲-2 用）："冷启动 → 注入失败之前"这一段
         `/health.resultWrite.writes` 的增量必须**逐帧**等于它 —— 期望值取自"真的推过几帧"这个事实，
         不写死数字（ADR-0004 D21）。 */
      out.postsBeforeFail = out.posts.length;
      savedUpsert = resultRepo.upsertJudgement;
      resultRepo.upsertJudgement = function () {
        throw new Error('harness-check 注入：DR-05 写入点抛错桩（本条只验"固化失败不污染采集链"）');
      };
      try {
        await push(A, 9521, CNT_FAIL, 2, 2);          // 新的一件（第 2 件）：判定照跑、固化必失败
      } finally {
        resultRepo.upsertJudgement = savedUpsert;
        savedUpsert = null;
      }
      out.failRow = resultRepo.getOne(db, A, 2);      // 应为 null（没写成）
      out.rowsAAfterFail = resultRepo.countByTask(db, A);
      out.resultWrite = Object.assign({}, serverEntry.state.resultWrite);
      out.hookStatus = await (await fetch(out.base + '/ifd/status')).json();
      out.measureRows = db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
      out.loggedWriteFailure = logLines.some(l => l.indexOf('result 表写入失败') >= 0);

      /* ---- 票 C（**负向靶子**，T-20260930-12a 新增：下一包 D22 变异① 的靶子）----
         E60 裁定①的两个后果要在**真链路**上同时成立，且不许用"整次判定没跑"冒充"该类不产生"：
           · 不固化 ⇒ `result` **0 行**、`countDone` **0**、写入点 `writes` 增量 **0**
             （"没写"与"写失败"是两件事 ⇒ `failures` 也不得变）；
           · 「工单超时」**整条不产生** ⇒ 事件里该类 **0 条**；
           · 而**同一条事件**里参数类（实测双双越上限 ⇒ 深度/速度各 1 条）与维保类**照常发布**
             ⇒ 判定确实跑了、只是那**一类**成不了条（"参数类/维保类都在、独缺该类"）。
         ⚠ 前提独立（D20）：本票**真的**下发 planStartTime（应完成 > 0）、真的写生效标准、
           实测真的越范围 ⇒ 若帧带了件序号，该类**必然**成条。该反面由紧接的**正向对照帧**
           （同一票、同一标准、同一序列，**只**把 unitIndex=1 补上）当场证伪它的对立面解读：
           那一帧的事件里「工单超时」恰 1 条（少了这个对照，"0 条"也可能只是"这条链路不判"）。
         ⚠ 采集时刻必须**晚于**本夹具已落库的最后一秒（ADR-0001 D7：不早于上次落库那一秒，
           否则判成 raw-500ms ⇒ 不落库、也就没有事件）：本段最后一帧在 12:00:20，
           故本票从 12:00:30 起、逐秒递增（第二、第三帧都必须更晚）。 */
      const C = out.ticketC, PC = 'P-E58c-nounit-' + label;
      const cntAt = (base0, plusSec) =>
        textOfDate(new Date(Date.parse(base0.replace(' ', 'T')) + plusSec * 1000));
      /* 双双越上限一格：与段⑦e 的 harmVec 同一算式（上限 ＝ 典型＋上偏差，取整到配置位数；再 + 一格） */
      const nuVec = (() => {
        const grid = 1 / Math.pow(10, boardConfig.standards.digits);
        const over = s => Math.round((Math.round((s.typical + s.upperDev) * 100) / 100 + grid) * 100) / 100;
        return {
          depth: over(boardConfig.standards.default.depth),
          speed: over(boardConfig.standards.default.speed), grid
        };
      })();
      out.noUnit = {
        ticket: C, productCode: PC, vec: nuVec, planStartSent: CNT_PLAN_START,
        posts: [], events: [], control: null, taskRow: null, ifdStatusCounts: null
      };
      out.dispatchC = await cntPost(out.base, '/ifa/dispatch', {
        procOrderNo: C, productCode: PC, processNo: '30',
        planQty: 6, equipCode: 'EQ-E58', planStartTime: CNT_PLAN_START
      });
      stdRepo.addVersion(db, {
        productCode: PC, processCode: '30',
        depthUpperDev: boardConfig.standards.default.depth.upperDev,
        depthLowerDev: boardConfig.standards.default.depth.lowerDev,
        depthTypical: boardConfig.standards.default.depth.typical,
        speedUpperDev: boardConfig.standards.default.speed.upperDev,
        speedLowerDev: boardConfig.standards.default.speed.lowerDev,
        speedTypical: boardConfig.standards.default.speed.typical
      }, CNT_PLAN_START, CNT_PLAN_START, { bus: svc.bus });
      out.noUnit.taskRow = db.prepare(
        'SELECT proc_order_no, product_code, process_no, plan_start_time FROM task WHERE proc_order_no = ?'
      ).get(C) || null;
      out.noUnit.countsBefore = readCounts(C);
      out.noUnit.writesBefore = serverEntry.state.resultWrite.writes;
      out.noUnit.failuresBefore = serverEntry.state.resultWrite.failures;
      /* `E69`／C-111 的现场读数（下面两条新断言只读**真链路**的现场，不读实现内部状态）：
         · `svc.snapshot().stats.startedQty` ＝ 快照统计段算出的**开工件数**（`FR-4.2`，走
           `stateSnapshot.statsOf()` 的 SQL ⇒ `measure_rt.unit_index`）；
         · `/health` 顶层 `frameUnitIndex` ＝ 帧件序号计数（与 `/ifd/status` 同源）。
         推 C 票那三帧**之前**先各读一次，作为"不虚增 / 增量"的基线。 */
      out.noUnit.startedBefore = svc.snapshot().stats.startedQty;
      out.noUnit.healthBefore = await (await fetch(out.base + '/health')).json();
      /* 帧体**显式**决定带不带 unitIndex（本条的靶子：两次推帧只变这一个字段）。
         `unitIndex === undefined` ⇒ JSON.stringify 直接**不产出该键**（不是产出 null）。 */
      const nuPush = async (seq, at, testStatus, unitIndex) => {
        const body = {
          equipCode: 'EQ-E58', procOrderNo: C, collectTime: at, seq,
          depth: nuVec.depth, speed: nuVec.speed, velocity_x: 3, velocity_y: 4,
          frameRate: 1000, gain: 2.5, shutter: 500, cameraDepth: 12.5, testStatus
        };
        if (unitIndex !== undefined) body.unitIndex = unitIndex;
        const res = await cntPost(out.base, '/ifd/frame', body);
        await new Promise(r => setTimeout(r, 400));    // 让 onSampled 挂钩跑完、事件落进收件箱
        /* 库内回读**两列**（按列名）:`unit_index` 是本次改动新增的列 —— 只读 test_status 证明不了
           "件序号真的落进它自己那一列"（列序错位会静默写错列）。 */
        const st = db.prepare(
          'SELECT test_status, unit_index FROM measure_rt WHERE proc_order_no = ? AND collect_time = ?').get(C, at);
        return {
          at, seq, testStatus, unitIndex: unitIndex === undefined ? null : unitIndex,
          frameHasUnitIndex: Object.prototype.hasOwnProperty.call(body, 'unitIndex'),
          res, storedStatus: st ? st.test_status : null, storedUnitIndex: st ? st.unit_index : null,
          counts: readCounts(C),
          writes: serverEntry.state.resultWrite.writes
        };
      };
      nuSink = out.noUnit.events;                      // 票 C 的事件进专用收件箱（见 subW 处注释）
      try {
        out.noUnit.posts.push(await nuPush(9601, cntAt(CNT_F1, 30), 2));   // 判定帧，**不带** unitIndex
        out.noUnit.posts.push(await nuPush(9602, cntAt(CNT_F1, 31), 2));
        out.noUnit.posts.push(await nuPush(9603, cntAt(CNT_F1, 32), 2));
      } finally { nuSink = null; }
      out.noUnit.countsAfter = readCounts(C);
      out.noUnit.writesAfter = serverEntry.state.resultWrite.writes;
      out.noUnit.failuresAfter = serverEntry.state.resultWrite.failures;
      /* 三帧**不带**件序号之后：开工件数不得虚增（`FR-4.2` 按件计 ⇒ 没有件序号就没有"件"）；
         同时把 `/health` 与 `/ifd/status` **背靠背**各取一次（中间不再推帧 ⇒ 两次读的是同一现场），
         供"两处同源"与"`withIndex + withoutIndex = stored` 不变量"两条断言使用。 */
      out.noUnit.startedAfterNoUnit = svc.snapshot().stats.startedQty;
      out.noUnit.healthAfterNoUnit = await (await fetch(out.base + '/health')).json();
      out.noUnit.ifdStatus = await (await fetch(out.base + '/ifd/status')).json();
      out.noUnit.ifdStatusCounts = out.noUnit.ifdStatus.counts || null;
      out.noUnit.shouldDoneAtFirst = Math.floor(
        (Date.parse(cntAt(CNT_F1, 30).replace(' ', 'T')) - Date.parse(CNT_PLAN_START.replace(' ', 'T')))
        / 1000 / CNT_CYCLE);
      /* 正向对照帧：同一票、同一标准、同一越范围实测值，**只**把件序号补上（unitIndex=1） */
      out.noUnit.control = {
        at: cntAt(CNT_F1, 33), events: [],
        writesBefore: serverEntry.state.resultWrite.writes
      };
      nuSink = out.noUnit.control.events;
      try {
        out.noUnit.control.rec = await nuPush(9604, out.noUnit.control.at, 2, 1);
      } finally { nuSink = null; }
      out.noUnit.control.writesAfter = serverEntry.state.resultWrite.writes;
      out.noUnit.control.counts = readCounts(C);
      out.noUnit.control.row = resultRepo.getOne(db, C, 1);
      /* 正向对照帧（**带** `unitIndex=1`，其余同）之后：开工件数必须**增 1**；
         并记录全表行数，供"`stored` ＝ 表行数"这条交叉核对使用。 */
      out.noUnit.startedAfterControl = svc.snapshot().stats.startedQty;
      out.noUnit.healthAfterControl = await (await fetch(out.base + '/health')).json();
      /* `withIndex + withoutIndex = stored`／"两处同源"这两条必须在**同一现场**读：
         `/health` 与 `/ifd/status` 背靠背各取一次，中间不再推帧（实测踩过：拿"控制帧之前"的
         `/ifd/status` 去和"控制帧之后"的 `/health` 比 ⇒ 差一帧，是**取数时刻不同**、不是同源破了）。 */
      out.noUnit.ifdStatusAfterControl = await (await fetch(out.base + '/ifd/status')).json();
      out.noUnit.measureRowsAfter = db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
      /* 库里**按列名**数出来的两个数（与 `/health` 的计数交叉核对；这一对是"计数↔事实"的双向核对：
         若计数口径漂移、或件序号没真的落进那一列，两个方向都会当场对不上）。 */
      out.noUnit.measureUnitIndexCounts = {
        withIndex: db.prepare('SELECT COUNT(*) AS c FROM measure_rt WHERE unit_index IS NOT NULL').get().c,
        withoutIndex: db.prepare('SELECT COUNT(*) AS c FROM measure_rt WHERE unit_index IS NULL').get().c
      };
    } catch (err) {
      out.error = String(err && err.stack ? err.stack : err);
    } finally {
      try { if (savedUpsert) resultRepo.upsertJudgement = savedUpsert; } catch { /* 已还原 */ }
      try { if (out.unsubscribe) out.unsubscribe(); } catch { /* 已退订 */ }
      try { out.stopResult = await serverEntry.stop('harness-check E58 真计数：' + label); }
      catch (err) { out.stopError = String(err && err.message); }
      try { out.serverAfterStop = serverEntry.state.server === null; } catch { /* 读不到就算了 */ }
      try { harness.removeLinkSafe(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }); }
      catch (err) { out.rmError = String(err && err.message); }
    }
    return out;
  };
  /* ⚠ `start()` 是进程级单例（`state.running` 为真时直接抛）⇒ 本段只起**一台**，串行用完即停。 */
  const cnt = await countProbe('main');
  /* 前提独立（ADR-0004 D20）：实例起不来 ⇒ 下面各条**不得**被读成"验过了"；
     `t.requires` 不成立计"未核实"（**不计通过**），退出码按 PROJECT_RULES 9.5-5 走。 */
  const cntOk = t.requires('E58 真计数夹具：进程内实例能起、能探活、能停（否则下面"件数驱动"各条无从判定）',
    Boolean(cnt && cnt.health && cnt.health.ok === true && cnt.health.dbWritable === true &&
      cnt.stopResult && cnt.stopResult.code === 0),
    `error=${cnt && cnt.error ? String(cnt.error).slice(0, 400) : '（无）'}；` +
    `health=${JSON.stringify(cnt && cnt.health && { ok: cnt.health.ok, dbWritable: cnt.health.dbWritable })}；` +
    `stop=${JSON.stringify(cnt && cnt.stopResult)}`);

  /* ---- 判据①：建连 hello 与 GET /state 逐字节同源 ---- */
  const helloEv = evts(s.hello0).find(e => e.event === 'hello');
  t.check('W5-①：`GET /state` 200（**不是** 503 未接线）且响应体与 `hello` 事件的 data **逐字节相等**（同一构造函数产出）',
    s.state0 && s.state0.status === 200 && Boolean(helloEv) &&
    JSON.stringify(helloEv.data) === s.state0.text &&
    /^text\/event-stream/.test(String(s.hello0 && s.hello0.contentType)),
    `state0.status=${s.state0 && s.state0.status}；hello.data≡state0.body：${JSON.stringify(helloEv && helloEv.data) === s.state0.text}；` +
    `ctype=${s.hello0 && s.hello0.contentType}`);
  t.check('W5-①：`snapshot` 键集齐备（link/task/device/frame/stats/standard/upload）＋ 信封含 ok/at/seq —— W5-② 切源按此表消费',
    Boolean(s.state0 && s.state0.body && s.state0.body.snapshot) &&
    ['link', 'task', 'device', 'frame', 'stats', 'standard', 'upload'].every(k => k in s.state0.body.snapshot) &&
    s.state0.body.ok === true && typeof s.state0.body.at === 'string' && typeof s.state0.body.seq === 'number',
    `snapshot.keys=${s.state0 && s.state0.body ? Object.keys(s.state0.body.snapshot).join(',') : '(无)'}`);

  /* ---- 判据④：frame 事件数 == 采样表新增行数；500 ms 原始帧与脏帧都不发布 ---- */
  const frameEvents = kindsOf(s.frames && s.frames.stream, 'frame');
  const rowsAdded = s.frames ? s.frames.rowsAfter - s.frames.rowsBefore : -1;
  t.check('W5-④：`frame` 事件数 == 同时段 `measure_rt` **新增行数**（单一真源逐条对账：1 行 = 1 条事件）',
    rowsAdded === 1 && frameEvents.length === 1 &&
    frameEvents[0].data.collectTime === '2026-09-19 10:00:00' && frameEvents[0].data.seq === 1,
    `采样表新增 ${rowsAdded} 行，frame 事件 ${frameEvents.length} 条（collectTime=${frameEvents.map(e => e.data.collectTime).join('/')}）`);
  t.check('W5-④：**500 ms 原始帧不产生 frame 事件**（同秒异键 ⇒ raw-500ms）＋ 脏帧被拒（400）后同样不发布（负向）',
    Boolean(s.frames && s.frames.posts[1] && s.frames.posts[1].body && s.frames.posts[1].body.outcome === 'raw-500ms') &&
    Boolean(s.frames && s.frames.posts[2] && s.frames.posts[2].status === 400) &&
    frameEvents.length === 1 && frameEvents.every(e => e.data.seq === 1),
    `post1=${s.frames && s.frames.posts[1] && s.frames.posts[1].body && s.frames.posts[1].body.outcome}；` +
    `post2=${s.frames && s.frames.posts[2] && s.frames.posts[2].status}；frame 事件 seq=[${frameEvents.map(e => e.data.seq).join(',')}]`);

  /* ---- 判据③：assertInput 拒收的标准版本不发布（负向）＋ 合法录入发布（正向） ---- */
  const stdEvents = kindsOf(s.other && s.other.stream, 'standard');
  const std = (s.other && s.other.standard) || {};
  t.check('W5-③：`assertInput` 拒收的标准版本 ⇒ **0 条** standard 事件（负向）＋ 合法录入 ⇒ **恰 1 条**（正向），库内也只 1 版',
    Boolean(std.rejected && std.rejected.threw === true) && std.versions === 1 && stdEvents.length === 1 &&
    stdEvents[0].data.versionNo === 1 && stdEvents[0].data.validation === 'ok' &&
    stdEvents[0].data.productCode === 'P-W5',
    `拒收=${std.rejected && std.rejected.threw}；库内版本=${std.versions}；standard 事件=${stdEvents.length}`);

  /* ---- 判据②：断线续传（按序/不重/不漏、超缓冲退回 hello、非法 since 不 500） ---- */
  const base = s.replay ? s.replay.cursorBase : -1;
  const qIds = idsOf(s.replay && s.replay.byQuery);
  const hIds = idsOf(s.replay && s.replay.byHeader);
  t.check('W5-②：`?since=<seq>` 续传**按序、不重、不漏**（只补发 seq > since，且不发 hello），载荷与源帧逐条一致',
    JSON.stringify(qIds) === JSON.stringify([base + 1, base + 2, base + 3]) &&
    !/event: hello/.test(String(s.replay && s.replay.byQuery.text)) &&
    s.replay.byQuery.status === 200 &&
    kindsOf(s.replay.byQuery, 'frame').map(e => e.data.collectTime).join(',') === String((s.replay.expectedFrames || []).join(',')),
    `since=${base} ⇒ ids=[${qIds.join(',')}]（期望 ${[base + 1, base + 2, base + 3].join(',')}）；` +
    `collectTime=${kindsOf(s.replay.byQuery, 'frame').map(e => e.data.collectTime).join(',')}`);
  t.check('W5-②：标准 `Last-Event-ID` 头与 `?since=` **同一口径**（同样按序不重不漏、不发 hello）',
    JSON.stringify(hIds) === JSON.stringify([base + 2, base + 3]) &&
    !/event: hello/.test(String(s.replay && s.replay.byHeader.text)),
    `Last-Event-ID=${base + 1} ⇒ ids=[${hIds.join(',')}]`);
  t.check('W5-②：超出环形缓冲 ⇒ **退回 hello 快照**（不得假装补上、也不得 500；其后只允许是**新**事件）',
    (() => {
      const ov = evts(s.replay && s.replay.overflow);
      /* 首帧必须是 hello；请求的补发区间（since+1 .. 缓冲最旧-1）里一条都不许出现 ——
         那一段已被环形缓冲丢掉，只能靠快照补齐（"假装补上"就是把丢的那段编出来）。 */
      return ov.length >= 1 && ov[0].event === 'hello' &&
        Boolean(ov[0].data && ov[0].data.snapshot && ov[0].data.snapshot.frame) &&
        s.replay.overflow.status === 200 &&
        ov.slice(1).every(e => e.id > ov[0].id) &&
        !ov.slice(1).some(e => e.id <= base + 3) &&
        !/event: (frame|task|standard|upload|warning|link)/.test(String(s.replay.overflow.text).split('event: hello')[0]);
    })(),
    `since=${base + 3} ⇒ 帧序=[${evts(s.replay && s.replay.overflow).map(e => e.id + ':' + e.event).join(',')}]` +
    `（缓冲最旧 seq=${s.replay && s.replay.busStats && s.replay.busStats.oldestSeq}）`);
  t.check('W5-②：非法 `since`（非数字/负数/小数/空串）与非法 `Last-Event-ID` ⇒ 按无 since 处理（200 + hello，绝不 500）',
    ['abc', '-5', '1.5', '(空串)', 'header'].every(k => s.replay && s.replay.invalid && s.replay.invalid[k] &&
      s.replay.invalid[k].status === 200 && /event: hello/.test(s.replay.invalid[k].text)),
    Object.keys((s.replay && s.replay.invalid) || {}).map(k =>
      `${k}=${s.replay.invalid[k].status}${/event: hello/.test(s.replay.invalid[k].text) ? '/hello' : '/无hello'}`).join(' '));

  /* ---- 判据⑤：心跳注释帧条数可预测（公式 E=floor(D/H)） ---- */
  const pings = ((s.heartbeat && s.heartbeat.text) || '').match(/: ping /g) || [];
  const hbExpect = s.heartbeat ? Math.floor(s.heartbeat.windowMs / s.heartbeat.heartbeatMs) : -1;
  t.check('W5-⑤/F8：真定时器下的心跳实测**在预期带内**（H=100 ms、D=2000 ms ⇒ E=20；**条数等式**由下方"注入定时器"那条钉死，这条只给真实调度下的分布）',
    pings.length >= 5 && pings.length <= hbExpect + 2 && hbExpect === 20 && pings.length <= s.heartbeat.chunks.length + 1,
    `实测 ${pings.length} 条 / ${s.heartbeat && s.heartbeat.elapsedMs} ms（E=${hbExpect}；H=${s.heartbeat && s.heartbeat.heartbeatMs} ms）——` +
    '真实定时器在窗口边界与事件循环负载下会少 0–2 条，故这里只断言"必须是 100 ms 级而非 15 s 级"的下界与上界，' +
    '条数与"关闭时清定时器"的确定性判据在 F8 那条断言里');

  /* ---- 判据⑧：无裸时间（at 与注释帧时间戳只允许是注入时钟的两个取值） ---- */
  const allowedAt = [s.injectedAt, s.afterAdvanceAt];
  const commentStamps = (String((s.frames && s.frames.stream && s.frames.stream.text) || '') +
    String((s.heartbeat && s.heartbeat.text) || ''))
    .match(/: (?:ready|ping|bye) ([0-9T:.\-Z]+)/g);
  const stamps = (commentStamps || []).map(x => x.replace(/^: (?:ready|ping|bye) /, ''));
  t.check('W5-⑧：SSE 注释帧时间戳与 `hello`/`/state` 的 `at` **全部来自注入时钟**（固定 2026-09-19T10:00:00 ⇒ 只允许注入值或其推进值）',
    stamps.length >= 5 && stamps.every(v => allowedAt.includes(v)) &&
    Boolean(helloEv && helloEv.data && allowedAt.includes(helloEv.data.at)) &&
    Boolean(s.state0 && allowedAt.includes(s.state0.body.at)),
    `允许值=${allowedAt.join(' / ')}；注释帧样本=${[...new Set(stamps)].join(' / ')}；hello.at=${helloEv && helloEv.data && helloEv.data.at}`);

  /* ---- 六类事件全覆盖 ＋ link 双向 ＋ task/upload/warning 载荷 ---- */
  const linkEvtsAll = [].concat(kindsOf(s.frames && s.frames.stream, 'link'), kindsOf(s.link, 'link'));
  const onlineEv = linkEvtsAll.find(e => e.data && e.data.online === true);
  const offlineEv = linkEvtsAll.find(e => e.data && e.data.online === false);
  /* ⚠ F3（独立审查立案，W5-② 再改）：标题原写"六类事件全部挂在真实写入点"，**表述过强** ——
     当时 `warning` 的唯一发布点（`judge.evaluate`）在全仓**没有生产调用方**，夹具只能**直调**它。
     W5-②（技术债 E45）接线后，`warning` 也挂到了真实写入点（`ingest` 的 1 s 采样落库之后），
     本段断言随之改为"**六类全部来自真实写入点**"；每条写入点的证据见下面各条断言。 */
  t.check('W5/F3：六类事件（frame / link / task / standard / upload / warning）在真 HTTP 连接上全部**来自真实写入点**',
    ['frame', 'link', 'task', 'standard', 'upload', 'warning'].every(k =>
      [].concat(evts(s.frames && s.frames.stream), evts(s.link), evts(s.other && s.other.stream),
        evts(s.other && s.other.warning && s.other.warning.stream)).some(e => e.event === k)),
    `实收种类=${[...new Set([].concat(evts(s.frames && s.frames.stream), evts(s.link),
      evts(s.other && s.other.stream), evts(s.other && s.other.warning && s.other.warning.stream)).map(e => e.event))].join(',')}；` +
    `warning 的写入点证据见下方 W5-② 四条断言（真帧 → 落库 → onSampled → 真 SSE 连接）`);
  t.check('W5：`link` 覆盖**双向**变化（离线→在线 / 在线→离线），离线判据＝`ingest.linkState()`（推进注入时钟 6 s > upper.staleMs）',
    Boolean(onlineEv) && Boolean(offlineEv) && offlineEv.data.staleMs === 5000 && offlineEv.data.ageMs >= 5000 &&
    s.link && s.link.state && s.link.state.online === false,
    `online 事件=${Boolean(onlineEv)}；offline 事件=${JSON.stringify(offlineEv && offlineEv.data)}；快照 link=${JSON.stringify(s.link && s.link.state)}`);
  const taskEv = kindsOf(s.other && s.other.stream, 'task')[0];
  const uploadEv = kindsOf(s.other && s.other.stream, 'upload')[0];
  t.check('W5：`task`／`upload` 载荷来自**真实写入点**（幂等命中不重发／真失败留存待补传）—— `warning` 的载荷判据在段⑦e（它要推真帧，放这里会污染续传窗口）',
    Boolean(taskEv) && taskEv.data.procOrderNo === 'WO-W5-9' && taskEv.data.table === 'task' &&
    kindsOf(s.other && s.other.stream, 'task').length === 1 &&
    Boolean(uploadEv) && uploadEv.data.action === 'enqueue-failed' && uploadEv.data.state === '待补传' &&
    uploadEv.data.pendingCount === 1 && Boolean(uploadEv.data.alert) &&
    Boolean(s.other && s.other.upload && s.other.upload.pendingCount === 1),
    `task=${JSON.stringify(taskEv && taskEv.data)}；upload=${JSON.stringify(uploadEv && uploadEv.data && { action: uploadEv.data.action, pending: uploadEv.data.pendingCount })}`);

  /* ---- W5-②（技术债 E45）：`warning` 的四条**真实写入点**判据（事件取自段⑦e 的专用连接） ----
     为什么这四条足以证明"来自真实写入点"（而不是"夹具替它发了一条"）：
       · 段⑦e 夹具**再也没有直调** `judge.evaluate`（该调用已整段删除）⇒ 事件不可能来自夹具；
       · 事件的 `result`/`warnings` 必须**逐字等于**把**真帧的 depth/speed** 与**库里那一版标准**
         喂给 `judge.evaluate()` 的产出（构成性对账：左＝连接上收到的事件，右＝按写入点入参重算）；
       · `at` 必须是**该帧的采集时刻**、条数必须**恰等于**那些真帧的次数 ⇒ 反证"标准取值时刻"
         与"判定发生的时机"都对得上（取错时刻、或另起一次判定都会对不上）。 */
  const warnOpt = (s.other && s.other.warning) || {};
  const warnExpect = warnOpt.expect || {};
  const warnEvents = kindsOf(warnOpt.stream, 'warning');
  const paramTitles = [judge.WARN_TITLES.warn, judge.WARN_TITLES.err];   // 参数类**两条具名**（C-88）
  /* ⚠ 2026-09-30（FR-5.11 判据改造 / 需求 C-108）；**2026-09-30 T2 独立复核改判（ADR-0004 D21）**：
     服务端现在还会算「工单超时」（应完成 = 节拍 × (采集时刻 − `task.plan_start_time`)；已完成 = `result` 表件数）。
     **旧写法（本轮主代理所写）把两个减数写死成 `shouldDone: 0, doneQty: 0`，理由是"本夹具的工单行
     没有计划开工时刻 ⇒ 生产侧算得 0/0"—— 该理由本身属实，但结论是"改期望值适配实现"而不是"对齐"**：
     它把对账退化成"两边都算 0"的恒等式 ⇒ `shouldDoneOf()` / `doneQtyOf()` 的取数链路**一条都没被验到**
     （把 `shouldDoneOf` 改成恒返回 0 也照样全绿）；而且它把"实现日后开始读对列"变成**测试变红**，
     下次只能再改期望值。现改为：**夹具真的下发 `planStartTime`**（见段⑦e 的 `W5W_PLAN_START`），
     期望值由**回读的夹具实测状态**（`warnOpt.taskRow.plan_start_time` ＋ `warnOpt.doneQty`）＋ 节拍
     **现场推导** —— 取数链路一变（含"恒返回 0"这类实现退化）本对账当场变红。
     ⚠ **2026-09-30 三次对齐（技术债 E58 ② 收口 / `T-20260930-08` 之后）**：E58 的临时闸已**整段拆除**
     ⇒ 夹具①的期望侧**恒**含「工单超时」一类（无闸 ⇒ 没有"两态"，件数按库里真值参与），
     不再由任何"闸值"决定。另有一处**必须与生产同口径**的入参：`progress` ——
     生产侧 `emitWarnings()` 由帧的 `testStatus` 按 C-98④ / FR-2.5 **导出**（`progressOf()`），
     **不采信**帧自报的 `progress`（C-102③：IF-D 的进度仅比对与展示、不作权威）。
     期望侧若漏传该入参，`taskResult()` 恒判「待测试」⇒ 与事件的「测试中」对不上（R1 恒红，实测红项之一）。
     故此处新增 `progressOfStatus()`：**与生产逐条同映射**，入参取**库内回读**的 `test_status`
     （见段⑦e 的 `frameStatus`），不取"我们打算发的码"。 */
  const orderDerive = ct => {
    const row = warnOpt.taskRow || null;
    const cyc = Number(boardConfig.production.cycleSec);
    const t0 = row && typeof row.plan_start_time === 'string' ? Date.parse(row.plan_start_time.replace(' ', 'T')) : NaN;
    const t1 = Date.parse(String(ct).replace(' ', 'T'));
    const shouldDone = (Number.isFinite(cyc) && cyc > 0 && Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0)
      ? Math.floor((t1 - t0) / 1000 / cyc) : 0;
    return { shouldDone, doneQty: Number(warnOpt.doneQty) || 0 };
  };
  /** 帧 `testStatus` ⇒ 单件进度：**与生产 `server/index.js` 的 `progressOf()` 逐条同映射**
   *  （附录 2 的码语义 + C-98④ / FR-2.5 的阶段导出规则）：`2`（判定）⇒ 1；`1`（运行）/ `3`（异常）⇒ 0.5；
   *  其余（含 `0` 准备）⇒ 0。**不采信**帧自报的 `progress`（C-102③）。 */
  const progressOfStatus = st => (st === 2 ? 1 : (st === 1 || st === 3 ? 0.5 : 0));
  const recompute = (depth, speed, ct, order, progress) => judge.evaluate({
    now: ct, real: { depth, speed },
    standard: {
      depth: Object.assign({}, boardConfig.standards.default.depth),
      speed: Object.assign({}, boardConfig.standards.default.speed)
    },
    progress,
    /* 无闸 ⇒ 两个减数**恒传**（`emitWarnings()` 现在就是这样传的：缺一即整条不产生该类，
       而这里不构造"缺一"的情形 —— 只有一态，不再有"闸关 ⇒ 不给"的分支） */
    shouldDone: order.shouldDone, doneQty: order.doneQty
  });
  /* 夹具前提（ADR-0004 D20）：派工**真的**把计划开工时刻落进了库，且本票确实没有已出结果的件 ——
     这是"应完成 > 0 而件数门槛不成立"这个现场成立的前提；前提塌掉时本段的对账就没有判别力。 */
  const harmDerive = orderDerive((warnOpt.at && warnOpt.at.harm) || '');
  t.check('W5-②/E45 夹具前提：派工 `planStartTime` **真的落进** `task.plan_start_time`（否则「工单超时」退化成 0/0 恒等式、取数链路一条都验不到）',
    Boolean(warnOpt.taskRow) && typeof warnOpt.planStartSent === 'string' && warnOpt.planStartSent.length > 0 &&
    warnOpt.taskRow.plan_start_time === warnOpt.planStartSent &&
    warnOpt.doneQty === 0 && harmDerive.shouldDone > 0,
    `下发=${JSON.stringify(warnOpt.planStartSent)}；库内 task 行=${JSON.stringify(warnOpt.taskRow)}；` +
    `result 件数=${warnOpt.doneQty}；推导应完成=${harmDerive.shouldDone}`);
  /* 期望侧的 `progress` 入参：由**库内回读**的 `test_status`（段⑦e 的 `frameStatus`）现算 ——
     没有"闸值"要回读了（E58 闸已删）。回读而不是写死 0.5：帧的码一变，期望立刻跟着变；
     而"采信帧自报 progress"会让这里的推导与生产分叉、当场变红（D22 可证伪）。 */
  const harmStatus = warnOpt.frameStatus ? warnOpt.frameStatus.harm : null;
  const harmExpect = recompute(warnExpect.depth && warnExpect.depth.warnVal,
    warnExpect.speed && warnExpect.speed.warnVal, (warnOpt.at && warnOpt.at.harm) || '',
    orderDerive((warnOpt.at && warnOpt.at.harm) || ''), progressOfStatus(harmStatus));
  const harmEv = warnEvents[0] || null;
  const harmParam = harmExpect.warnings.filter(w => paramTitles.includes(w.title));
  t.check('W5-②/E45 写点：`warning` 事件的载荷**逐字等于**"真帧实测 + 库里生效标准"喂给判定引擎的产出（段⑦e已无任何夹具直调 ⇒ 事件只能来自生产链路）',
    Boolean(harmEv) && harmEv.data && typeof harmEv.data.result === 'string' &&
    Array.isArray(harmEv.data.warnings) &&
    JSON.stringify(harmEv.data.warnings) === JSON.stringify(harmExpect.warnings) &&
    harmEv.data.result === harmExpect.result && harmEv.data.reason === harmExpect.reason,
    `事件 warnings=${JSON.stringify(harmEv && harmEv.data && harmEv.data.warnings)}；` +
    `按写入点入参重算=${JSON.stringify(harmExpect.warnings)}；` +
    `本次重算的入参：progress=${progressOfStatus(harmStatus)}` +
    `（由库内回读的 test_status=${JSON.stringify(harmStatus)} 按 C-98④ 导出）、` +
    `应完成=${orderDerive((warnOpt.at && warnOpt.at.harm) || '').shouldDone}、已完成=${warnOpt.doneQty}；` +
    `事件 result=${JSON.stringify(harmEv && harmEv.data && harmEv.data.result)}／重算=${JSON.stringify(harmExpect.result)}`);

  /* FR-5.11（C-108）在**生产链路**上的件数驱动行为，已整段改由下面的「E58 真计数」四条断言承接
     （进程内实例 + 真帧 + 真写入点 + 按件对账）；此处不再保留旧"两态"文字说明。
     ⚠ 历史（E58 收口前）：`doneQtyOf()` 的唯一真源 `result` 表在 `server\` 下**没有任何写入点**
     ⇒ 服务端"已完成件数"恒 0 ⇒ 只要有计划开工时刻就恒判 err。该缺口已由 `T-20260930-08` 补上
     （写入点＝`server/index.js` 的 `persistJudgement()`，归口 `server/repo/result.js`），
     且**禁止**用"往 `result` 塞假行"来给任何一条凑场景 —— 本段所有行都由**推帧**经真写入点产生。 */

  /* ================= FR-5.11（C-108）**真计数**判据：`result` 表件数驱动「工单超时预警」 =================
     ⚠ 2026-09-30 T2 三次改判（ADR-0004 D21「改实现还是改期望必须判定并写明」）：
     上一轮（`T-20260930-05` 临时闸落地时）本段是"闸 off / 闸 on **两态**"四条断言。闸在
     `T-20260930-08` 被**整段拆除**后，那四条**全部失效**：
       · 态①（"该类整条不产生"）与态①b（"闸默认关"）读的是**已删字段** `/health.orderWarningSource`
         ⇒ `undefined === undefined` ⇒ **态①b 是恒真式假绿**（ADR-0004 D23 明令禁止）；
       · 态②/②b 读 `orderWarningSource.indexOf(READY_TAG)` ⇒ **抛 TypeError 中止整轮自检**
         （实测：`harness-check.js` 在 `:2303` 中止、其后约 171 条断言从未被核实）。
     **判定：改期望，不改实现**（无闸是裁定要求的正确行为）。且按 D23「不许只删不补」，把四条改成
     **件数驱动的正向断言**（下面四条）—— 它们验的是"`result` 表的件数**真的**被算进了判据"，
     而不是"某个字段长什么样"：
       ① 非零已完成 ⇒ 同一票「工单超时预警」**由 err 转 ok**（等级与 detail 数值全部现场推导）；
       ② `待复检` **不计**已完成（行在、`countDone` 不加）；
       ③ 按件幂等（同一件连推多帧 ⇒ `result` 恰 1 行、终态不回退）；
       ④ 固化失败**不污染采集链**（帧仍 stored、预警照发、失败计数 +1）。
     ⚠ 本段**不往 `result` 塞任何行**：行只由推帧经 `repo/result.js` 的 `upsertJudgement()` 产生。 */

  if (cntOk) {
    /* 现场推导（ADR-0004 D21：期望值一律实测/构成性推导，不写死）：
       · 应完成 ＝ floor((帧采集时刻 − `task.plan_start_time`) ÷ 配置节拍)（与生产 `shouldDoneOf()` 同一算式）；
       · 已完成 ＝ **该帧自己固化之后**的件数 —— 逐帧 POST 返回（`onSampled` 已跑完）后的现场读数
         `cnt.posts[k].counts.done` 就是服务端发布那一刻读到的件数；同一进程内、同一次请求之后读，
         后续帧还没发生 ⇒ 两者必等（不是"我以为"）。
         ⚠ **2026-09-30 T-20260930-12a 对齐（座位 4b）**：这里旧写法是 `posts[k−1].counts.done`
         （＝"该帧固化**之前**"的件数），其依据是旧实现的调用顺序「先 `bus.publish`、再 `persistJudgement`」。
         座位 6 的修复（E60 裁定②）已改为「**先固化、后发布**」（`server/index.js` 的 `emitWarnings()`：
         第一拍 `publish:false` 只为取 `result` 去固化，第二拍才按**固化之后的真实件数**组织发布）
         ⇒ 旧偏移写出来的期望整整错位一帧（实测：F2 期望 [应完成 1／已完成 0／err]，
         事件实为 [1／1／ok]，本条当场变红）。**判定：改期望，不改实现** ——
         期望改读"该帧自身的固化后件数"，与"发布读的是固化之后的件数"同一口径；
         等级仍由本段**独立算**（不调 judge），故不是"用被测对象算期望"。
       · 等级 ＝ C-108①② 的两个门槛（比率 / 件数）**在这里独立算**，不调 `judge` ——
         否则就是"用被测对象算期望"，等于把对账退化成自证。 */
    const cntAtMs = k => Date.parse(String(cnt.posts[k].at).replace(' ', 'T'));
    const cntShould = k => Math.floor(
      (cntAtMs(k) - Date.parse(CNT_PLAN_START.replace(' ', 'T'))) / 1000 / CNT_CYCLE);
    /* 该帧**固化之后**的件数 ＝ 该帧 POST 返回后的现场读数（本帧自己判出的那一件已计入）。
       ⚠ 不再取 `posts[k−1]`：那正是被座位 6 的"先固化后发布"修掉的旧偏移（见上）。 */
    const cntDoneAt = k => cnt.posts[k].counts.done;
    const cntExpectLv = (should, done) => {
      const behind = should - done;
      const ratio = should > 0 ? behind / should : 0;
      return (ratio > boardConfig.warnings.orderOverdueRatio ||
        behind > boardConfig.warnings.orderOverduePending) ? 'err' : 'ok';
    };
    /* 票 A 的三帧（posts[0..2]）与票 B 的那一帧（posts[3]）分别对账 */
    const cntA = [0, 1, 2].map(k => {
      const rows = cnt.orderRowsAt(k);
      const should = cntShould(k), done = cntDoneAt(k);
      const expectLv = cntExpectLv(should, done);
      return {
        k, rows, should, done, expectLv,
        hit: rows.length === 1 && rows[0].lv === expectLv &&
          String(rows[0].detail).includes(`按节拍应完成 ${should} 件、实际已完成 ${done} 件`)
      };
    });
    const cntB = cnt.orderRowsAt(3);
    const cntStored = cnt.posts.map(p => Boolean(p.res && p.res.status === 200 &&
      p.res.body && p.res.body.outcome === 'stored'));
    const cntAllStored = cntStored.length === 5 && cntStored.every(Boolean);
    const cntFailPost = cnt.posts[cnt.posts.length - 1] || null;
    const cntFrameA = cnt.posts.filter(p => p.ticket === cnt.ticketA && p.unitIndex === 1);
    /* 现场实测值**打印出来**（D21：断言详情只在红时打印，故这里额外给一行实测现场，
       便于复核者不跑变异也能看到"期望值是从哪些实测读数推出来的"；不计入断言数）。 */
    t.info(`E58 真计数现场（实测）：帧落库=${cnt.posts.length} 帧（${cntStored.filter(Boolean).length} stored）／` +
      `warning 事件 ${cnt.warnings.length} 条；票 ${cnt.ticketA}：推帧前 done=${cnt.countsBefore.done} ⇒ ` +
      `推帧后 done=${cnt.doneA}、行数 ${cnt.rowsA}（第 1 件=${JSON.stringify(cnt.rowA1 && cnt.rowA1.result)}，` +
      `duration_sec=${cnt.rowA1 && cnt.rowA1.duration_sec}）；三帧[应完成/已完成/本段独立算的等级]＝` +
      cntA.map(x => `F${x.k + 1}[${x.should}/${x.done}/${x.expectLv}]`).join(' ') +
      `（事件实测等级＝${cntA.map(x => JSON.stringify(x.rows[0] && x.rows[0].lv)).join(' ')}）；` +
      `票 ${cnt.ticketB}：第 1 件=${JSON.stringify(cnt.rowB1 && cnt.rowB1.result)}、retest_count=${cnt.rowB1 && cnt.rowB1.retest_count}、` +
      `行数 ${cnt.rowsB}、done=${cnt.doneB}；写失败注入：failRow=${JSON.stringify(cnt.failRow)}、` +
      `state.resultWrite=${JSON.stringify(cnt.resultWrite)}、行数 ${cnt.rowsA}→${cnt.rowsAAfterFail}、` +
      `loggedWriteFailure=${cnt.loggedWriteFailure}、measure_rt=${cnt.measureRows} 行`);

    /* ---- 真计数①：非零「已完成」 ⇒ 「工单超时预警」由 **err 转 ok**（数值现场推导） ---- */
    t.check('FR-5.11/C-108 行为·**真计数①**（非零「已完成」驱动）：同一票推三帧、第 2 帧 `testStatus=2` ⇒ ' +
      '该件判「合格」并由 DR-05 写入点**按件固化** ⇒ 同一票「工单超时预警」由 **err 转 ok**；' +
      '三帧的等级与 detail 里的「应完成 / 已完成」**全部等于现场推导值**（应完成＝节拍×经过时长、已完成＝`result` 实测件数）',
      cntAllStored && cnt.posts.length === 5 && cnt.warnings.length === cnt.posts.length &&
      cnt.countsBefore.done === 0 && cnt.doneA === cnt.countsBefore.done + 1 &&
      Boolean(cnt.rowA1) && cnt.rowA1.result === '合格' &&
      cntA.every(x => x.hit) &&
      cntA[0].rows.length === 1 && cntA[0].rows[0].lv === 'err' &&
      cntA[2].rows.length === 1 && cntA[2].rows[0].lv === 'ok' &&
      cntA[0].should > 0 && cntA[2].done > cntA[0].done,
      `五帧落库=${cnt.posts.map((p, i) => p.at + '=' + (cntStored[i] ? 'stored' : JSON.stringify(p.res && p.res.body))).join(' , ')}；` +
      `warning 事件 ${cnt.warnings.length} 条（帧 ${cnt.posts.length} 帧 ⇒ 每帧恰 1 条）；` +
      `票 ${cnt.ticketA}：推帧前 ` + '`countDone`' + `=${cnt.countsBefore.done} ⇒ 推帧后=${cnt.doneA}；` +
      `第 1 件行=${JSON.stringify(cnt.rowA1)}（库内 test_status 回读：` +
      `${cntFrameA.map(p => p.at + '→' + JSON.stringify(p.storedStatus)).join(' , ')}）；` +
      cntA.map(x => `F${x.k + 1}[应完成 ${x.should} / 已完成 ${x.done} ⇒ **本段独立算出的等级 ${x.expectLv}**] ` +
        `事件=${JSON.stringify(x.rows)}`).join('；'));

    /* ---- 真计数②：`待复检` **不计**「已完成」＋ 无计划开工 ⇒ 判 ok ---- */
    t.check('FR-5.11/C-108 行为·**真计数②**（`待复检` **不计**「已完成」）：半套标准（速度三格未设定）那件判「待复检」⇒ ' +
      '`result` **有该件行**、而复检件**不进** `countDone`；同一票无计划开工 ⇒ 应完成 0 ⇒ 「工单超时」判 ok',
      Boolean(cnt.rowB1) && cnt.rowB1.result === '待复检' && cnt.rowB1.retest_count === 1 &&
      cnt.rowsB === 1 && cnt.doneB === 0 && cnt.doneA > 0 &&
      Boolean(cnt.taskRowB) && cnt.taskRowB.plan_start_time === null &&
      cntB.length === 1 && cntB[0].lv === 'ok' &&
      String(cntB[0].detail).includes('按节拍应完成 0 件、实际已完成 0 件'),
      `票 ${cnt.ticketB}：库内 task.plan_start_time=${JSON.stringify(cnt.taskRowB && cnt.taskRowB.plan_start_time)}（应为 null）；` +
      `第 1 件行=${JSON.stringify(cnt.rowB1)}（应判「待复检」、复检次数 1）；` +
      `该票 ` + '`result`' + ` 行数=${cnt.rowsB}、` + '`countDone`' + `=${cnt.doneB}（**待复检不计**）；` +
      `对照：另一票同一张表上已完成=${cnt.doneA}（>0 ⇒ 本条的 0 不是"读不到"）；` +
      `该票「工单超时预警」=${JSON.stringify(cntB)}`);

    /* ---- 真计数③：按件幂等（同一件连推多帧 ⇒ 恰 1 行；终态不回退） ---- */
    t.check('FR-5.11/DR-19 行为·**真计数③**（按件幂等）：同一件（工单＋件号）连推三帧 ⇒ `result` **恰 1 行**、' +
      '结果**单调不回退**（已判「合格」的终态不被后续中间态改写）、`duration_sec` ＝该件首末**有效**帧的采集时刻差',
      cnt.rowsA === 1 && cnt.rowsAAfterFail === 1 && cntFrameA.length === 3 &&
      Boolean(cnt.rowA1) && cnt.rowA1.result === '合格' &&
      cnt.rowA1.duration_sec === Math.round((cntAtMs(2) - cntAtMs(0)) / 1000),
      `票 ${cnt.ticketA} 第 1 件：三帧（${cntFrameA.map(p => p.at + ' testStatus=' + JSON.stringify(p.storedStatus) +
        ' unitIndex=' + p.unitIndex).join(' , ')}）⇒ ` + '`result`' + ` 行数=${cnt.rowsA}（幂等，未新增行）；` +
      `行内容=${JSON.stringify(cnt.rowA1)}；` +
      `duration_sec 期望＝首末有效帧差 ${Math.round((cntAtMs(2) - cntAtMs(0)) / 1000)} s（${cnt.posts[0].at} → ${cnt.posts[2].at}）；` +
      `写失败注入后行数=${cnt.rowsAAfterFail}（第 2 件没写成 ⇒ 行数不变）`);

    /* ---- 真计数④：固化失败**不污染采集链** ---- */
    t.check('E58/D19 行为·**真计数④**（固化失败**不污染采集链**）：注入抛错桩 ⇒ 帧仍 `stored`、`warning` 照发、' +
      '`state.resultWrite.failures` +1 且该件**没有**写出行；判定挂钩失败计数仍为 0（异常在写入点内部被收下）',
      Boolean(cntFailPost) && Boolean(cntFailPost.res) && cntFailPost.res.status === 200 &&
      cntFailPost.res.body && cntFailPost.res.body.outcome === 'stored' &&
      cnt.warnings.length === cnt.posts.length &&
      Boolean(cnt.resultWrite) && cnt.resultWrite.failures === cnt.failuresBefore + 1 &&
      typeof cnt.resultWrite.lastError === 'string' && cnt.resultWrite.lastError.includes('注入') &&
      cnt.failRow === null && cnt.rowsAAfterFail === cnt.rowsA && cnt.loggedWriteFailure === true &&
      Boolean(cnt.hookStatus && cnt.hookStatus.counts) && cnt.hookStatus.counts.sampledHookFailures === 0,
      `注入后那一帧（${cntFailPost && cntFailPost.at}，第 2 件 / testStatus=2）：落库=${JSON.stringify(cntFailPost && cntFailPost.res && cntFailPost.res.body && cntFailPost.res.body.outcome)}；` +
      `warning 事件 ${cnt.warnings.length}/${cnt.posts.length}（照发）；` +
      `state.resultWrite=${JSON.stringify(cnt.resultWrite)}（注入前 failures=${cnt.failuresBefore}、writes=${cnt.writesBefore}）；` +
      `第 2 件行=${JSON.stringify(cnt.failRow)}（应为 null）；该票行数 ${cnt.rowsA} → ${cnt.rowsAAfterFail}；` +
      `写入失败已写日志=${cnt.loggedWriteFailure}；` +
      `/ifd/status.sampledHookFailures=${JSON.stringify(cnt.hookStatus && cnt.hookStatus.counts && cnt.hookStatus.counts.sampledHookFailures)}；` +
      `夹具内异常=${cnt.error || '（无）'}`);

    /* ---- 负向靶子（E60 裁定① / T-20260930-12a 新增）：帧**不带** `unitIndex` ⇒
       「工单超时」整条不产生 ＋ 本件不固化；参数类/维保类照常发布
       （不得用"整次判定没跑"冒充"该类不产生"；正面由同票的对照帧当场反证） ---- */
    const nu = cnt.noUnit || {};
    const nuPosts = Array.isArray(nu.posts) ? nu.posts : [];
    const nuEvts = Array.isArray(nu.events) ? nu.events : [];
    const nuCtl = nu.control || {};
    const nuCtlEvts = Array.isArray(nuCtl.events) ? nuCtl.events : [];
    /* 按标题数条数（只数"事件里真的发出来的"，不读实现内部状态） */
    const nuRowsOf = (payloads, titles) => {
      let n = 0;
      for (const p of payloads) {
        const ws = (p && Array.isArray(p.warnings)) ? p.warnings : [];
        for (const w of ws) if (titles.indexOf(w.title) >= 0) n++;
      }
      return n;
    };
    const nuOrderRows = nuRowsOf(nuEvts, [orderTitle]);
    const nuParamRows = nuRowsOf(nuEvts, [judge.WARN_TITLES.warn, judge.WARN_TITLES.err]);
    const nuMaintRows = nuRowsOf(nuEvts, [judge.OTHER_TITLES.maintenance]);
    const nuCtlOrderRows = nuRowsOf(nuCtlEvts, [orderTitle]);
    t.check('FR-5.11/E60① 行为·**负向靶子**（帧**不带** `unitIndex`）：同一票连推 3 帧判定帧' +
      '（`testStatus=2`、实测双双越上限、计划开工已落库 ⇒ 应完成 > 0）⇒ `result` **0 行**、' +
      '`countDone`=0、`state.resultWrite.writes` 增量 **0**（连 `failures` 也不得变）；' +
      '三帧各 1 条 warning 事件里**参数类 2 条 ＋ 维保类 1 条照发**、而「工单超时预警」**0 条** ' +
      '⇒ 是"**该类**不产生"而不是"整次判定没跑"；' +
      '正向对照（同一票、同一标准、同一实测值，**只**把 `unitIndex`=1 补上）⇒ 该帧事件里' +
      '「工单超时」恰 1 条、`result` 恰 1 行、writes +1',
      nuPosts.length === 3 && nuEvts.length === 3 && nuCtlEvts.length === 1 &&
      nuPosts.every(p => p.frameHasUnitIndex === false && Boolean(p.res) && p.res.status === 200 &&
        p.res.body && p.res.body.outcome === 'stored' &&
        p.writes === nu.writesBefore && p.counts.done === 0 && p.counts.rows === 0) &&
      Boolean(nu.countsBefore) && nu.countsBefore.done === 0 &&
      Boolean(nu.countsAfter) && nu.countsAfter.done === 0 && nu.countsAfter.rows === 0 &&
      nu.writesAfter === nu.writesBefore && nu.failuresAfter === nu.failuresBefore &&
      nuOrderRows === 0 && nuParamRows === nuPosts.length * 2 && nuMaintRows === nuPosts.length &&
      nu.shouldDoneAtFirst > 0 &&
      Boolean(nu.taskRow) && nu.taskRow.plan_start_time === CNT_PLAN_START &&
      Boolean(nu.ifdStatusCounts) && nu.ifdStatusCounts.sampledHookFailures === 0 &&
      Boolean(nuCtl.rec) && nuCtl.rec.frameHasUnitIndex === true &&
      nuCtlOrderRows === 1 && Boolean(nuCtl.counts) && nuCtl.counts.rows === 1 &&
      nuCtl.writesAfter === nuCtl.writesBefore + 1 && Boolean(nuCtl.row),
      `票 ${nu.ticket}（产品 ${nu.productCode}）：实测 depth=${nu.vec && nu.vec.depth}／speed=${nu.vec && nu.vec.speed}` +
      `（各越上限一格）、计划开工=${JSON.stringify(nu.planStartSent)}（库内=${JSON.stringify(nu.taskRow && nu.taskRow.plan_start_time)}）` +
      `⇒ 首帧应完成=${nu.shouldDoneAtFirst} 件（>0 ⇒ 工单类的两个减数在本票上**都**拿得到）；` +
      `三帧（不带 unitIndex）：` + nuPosts.map(p => `${p.at} unitIndex=${JSON.stringify(p.unitIndex)}` +
        `(${p.res && p.res.body && p.res.body.outcome}) result行=${p.counts.rows}/done=${p.counts.done}/writes=${p.writes}`).join(' , ') +
      `；该票 result 行数=${nu.countsAfter && nu.countsAfter.rows}、countDone=${nu.countsAfter && nu.countsAfter.done}` +
      `（推帧前 ${nu.countsBefore && nu.countsBefore.rows}/${nu.countsBefore && nu.countsBefore.done}）；` +
      `writes ${nu.writesBefore}→${nu.writesAfter}、failures ${nu.failuresBefore}→${nu.failuresAfter}；` +
      `事件三类条数：工单类=${nuOrderRows}（应 0）、参数类=${nuParamRows}（应 ${nuPosts.length * 2}）、维保类=${nuMaintRows}（应 ${nuPosts.length}）；` +
      `判定挂钩失败=${nu.ifdStatusCounts && nu.ifdStatusCounts.sampledHookFailures}；` +
      `正向对照帧 ${nuCtl.at}（**带** unitIndex=1，其余同）：工单类=${nuCtlOrderRows} 条、该票行数=${nuCtl.counts && nuCtl.counts.rows}、` +
      `writes ${nuCtl.writesBefore}→${nuCtl.writesAfter}；行=${JSON.stringify(nuCtl.row)}`);

    /* ---- `E69`／C-111 判别力断言①（**负向靶子**）：帧**不带** `unitIndex` ⇒ 开工件数**不虚增** ----
       立案：`FR-4.2` 自 V1.41（C-111）起按**件**计，判据＝该件在 `measure_rt` 有采样数据且 `unit_index` 非空。
       若"没有件序号的帧也算开工"（例如把 `unit_index IS NOT NULL` 这条过滤去掉），
       现场就会把"拿不到件序号"当成"开工了一件" —— 与 `judge.js` 的"拿不到不说"同一纪律。
       本条在**真链路**上验三件事，且带**正向对照**（否则"不增"也可能只是"这个量根本不动"）：
         ① 同一票连推 3 帧**不带** `unitIndex` ⇒ `snapshot.stats.startedQty` **不变**；
         ② 这 3 帧在库里 `unit_index` **为 NULL**（按列名回读，不是只看行数）；
         ③ `/health.frameUnitIndex.withoutIndex` **恰 +3**（"帧没带件序号"这件事**可被现场读出来**）；
         ④ 对照帧只多带 `unitIndex=1` ⇒ `startedQty` **恰 +1**（证明这个量确实随件数动）。 */
    {
      const nuBefore = nu.startedBefore, nuAfterNo = nu.startedAfterNoUnit, nuAfterCtl = nu.startedAfterControl;
      const nuHealthBefore = (nu.healthBefore && nu.healthBefore.frameUnitIndex) || null;
      const nuHealthAfterNo = (nu.healthAfterNoUnit && nu.healthAfterNoUnit.frameUnitIndex) || null;
      const nuStoredNull = nuPosts.length === 3 && nuPosts.every(p => p.storedUnitIndex === null);
      const nuWithoutDelta = nuHealthBefore && nuHealthAfterNo
        ? nuHealthAfterNo.withoutIndex - nuHealthBefore.withoutIndex : null;
      t.check('FR-4.2/E69 行为·**负向靶子**（帧**不带** `unitIndex` ⇒ 开工数**不虚增**）：同一票连推 3 帧' +
        '（其余字段与对照帧相同）⇒ 快照 `stats.startedQty` **一字不增**、这 3 行库内 `unit_index` **为 NULL**、' +
        '`/health.frameUnitIndex.withoutIndex` **恰 +3**；而**只多带** `unitIndex=1` 的对照帧 ⇒ `startedQty` **恰 +1**' +
        '（去掉 `unit_index IS NOT NULL` 过滤 ⇒ 开工数会虚增 3 ⇒ 本条必红）',
        Number.isFinite(nuBefore) && nuBefore > 0 &&
        nuAfterNo === nuBefore && nuStoredNull && nuWithoutDelta === 3 &&
        nuAfterCtl === nuBefore + 1,
        `开工件数（快照 stats）：推 3 帧不带件序号前=${nuBefore} ⇒ 后=${nuAfterNo}（须相等）；` +
        `对照帧（带 unitIndex=1）后=${nuAfterCtl}（须 ${nuBefore} + 1）；` +
        `三帧库内 unit_index=${JSON.stringify(nuPosts.map(p => p.storedUnitIndex))}；` +
        `/health.frameUnitIndex.withoutIndex：${nuHealthBefore && nuHealthBefore.withoutIndex} ⇒ ` +
        `${nuHealthAfterNo && nuHealthAfterNo.withoutIndex}（Δ=${nuWithoutDelta}，须 3）；` +
        `withIndex：${nuHealthBefore && nuHealthBefore.withIndex} ⇒ ${nuHealthAfterNo && nuHealthAfterNo.withIndex}`);
    }

    /* ---- `E69` 判别力断言④：`/health.frameUnitIndex` 的**不变量**与**同源** ----
       口径（`services/ingest.js` 的 `state.frameUnitIndex` 注释）：计数**只数真正落库的那一帧**
       （重复帧 / 500 ms 原始帧 / 被拒收帧都不是库里的行）⇒ 恒有 `withIndex + withoutIndex === stored`，
       且 `stored` 应等于 `measure_rt` 的行数（两个独立真源交叉核对）；
       两个计数还应与库里**按列名**数出的"`unit_index` 非空 / 为空"的行数**逐项相等**
       （这一对是"计数 ↔ 事实"的双向核对：`ingest` 若不再把件序号写进那一列，`withIndex` 就与库对不上）。
       同源：`/health` 顶层的该对象与 `GET /ifd/status` 里的**逐字段相等** —— 两处都只是搬运
       `ingest.status()` 的同一个返回值（此处两次 HTTP 中间**不再推帧**，故是同一现场）。
       反证：谁若在 `/health` 侧另算一份计数、把计数挪到"落库之前"、或让 `ingest` 不写该列，本条的等式必红。 */
    {
      const h = (nu.healthAfterControl && nu.healthAfterControl.frameUnitIndex) || null;
      const s = (nu.ifdStatusAfterControl && nu.ifdStatusAfterControl.frameUnitIndex) || null;
      const uic = nu.measureUnitIndexCounts || {};
      t.check('FR-4.2/E69 行为·**不变量与同源**：`/health.frameUnitIndex` 恒有 `withIndex + withoutIndex = stored`、' +
        '`stored` ＝ `measure_rt` 实际行数、两个计数＝库里按列名数出的 `unit_index` 非空/为空行数，' +
        '且与 `GET /ifd/status` 的 `frameUnitIndex` **逐字段相等**（同一份 `ingest.status()`）',
        Boolean(h) && Boolean(s) &&
        h.withIndex + h.withoutIndex === h.stored &&
        h.stored === nu.measureRowsAfter &&
        h.withIndex === uic.withIndex && h.withoutIndex === uic.withoutIndex &&
        JSON.stringify(h) === JSON.stringify(s),
        `health.frameUnitIndex=${JSON.stringify(h)}；ifd/status.frameUnitIndex=${JSON.stringify(s)}；` +
        `两处逐字段相等=${JSON.stringify(h) === JSON.stringify(s)}；` +
        `measure_rt 行数=${nu.measureRowsAfter}（须＝ stored）；` +
        `库里按列名数：unit_index 非空 ${uic.withIndex} 行／为空 ${uic.withoutIndex} 行；` +
        `推帧前 withIndex/withoutIndex=${nu.healthBefore && nu.healthBefore.frameUnitIndex && nu.healthBefore.frameUnitIndex.withIndex}` +
        `/${nu.healthBefore && nu.healthBefore.frameUnitIndex && nu.healthBefore.frameUnitIndex.withoutIndex}`);
    }

    /* ================= 甲：`/health.resultWrite` 的出口断言（`T-20261003-04`；`E58` 结案更正） =================
       事实（`E58` 行末「结案更正（2026-10-03）」段）：`DR-05` 的写入点（`persistJudgement()`）自
       `T-20260930-08` 就已接线，但它的三个运行计数**只在进程内存里**、`/health` **一个字都不搬运**
       （`shiftStatWrite` / `warningWrite` 早已搬运，独缺这一块）⇒ "到底写没写、写失败没有、有多少件
       因为拿不到件序号而**根本没打算写**"在**外部读不到**。`server/index.js` 的 `T-20261003-02` 补上了出口。
       **搬运口径（三者互不代偿，`server/index.js` 的 `state.resultWrite` docblock）**：
         · `writes`        ＝ **真的落了行**；
         · `failures`      ＝ **想落但落不进去**（并带 `lastError`）；
         · `skippedNoUnit` ＝ 帧**拿不到件序号** ⇒ **根本没打算落**（`E60` 裁定①）。
       下面四条一律读**真 HTTP 的 `/health` 响应体**，**不读** `serverEntry.state`：
       进程内状态对"出口有没有搬运"零判别力 —— 那正是本条要守的东西。
       D22 暗桩（两条，与 §16-F/I/K 同款纪律：**字节副本 ＋ sha256 留痕 ＋ `Buffer.compare` 还原证明 ＋
       全程不落盘**）：① 把搬运块整段摘掉 ⇒ 甲-1 必红并指名；② 把 `skippedNoUnit` 并进 `failures`
       ⇒ 甲-3 必红并指名。两条都要求"未变异的当前源码必绿"（否则"判红"可能只是把一切都判红）。
       ⚠ 变异在**内存字节副本**上做（不写 `server\index.js`）：那份文件此刻正被另一路协作方改写（E89），
       写盘＋还原会与并发写撞车（见本批回执的取舍说明）；"字节副本还原"的**证据力**由下面两端读数给出
       —— 变异体 sha256 ≠ 原件 sha256，且**盘上文件全程逐字节未变**（`sha256Hex(readFile) === sha0`）。 */
    {
      const { createHash } = require('node:crypto');
      const sha256Hex = buf => createHash('sha256').update(buf).digest('hex');
      /** `/health` 响应体里的 `resultWrite` 块；**缺块 ⇒ null**（不抛：字段消失须判红并指名，不得中止整轮） */
      const rwOf = h => (h && typeof h === 'object' && h.resultWrite && typeof h.resultWrite === 'object'
        ? h.resultWrite : null);
      const RW_KEYS = ['writes', 'failures', 'lastError', 'skippedNoUnit'];
      /** 键恒在 ＋ 取值类型合口径 ⇒ 逐项问题清单（空数组＝合规）。ADR-0004 D23：判红必须能**指名**。 */
      const rwKeyProblems = h => {
        const rw = rwOf(h);
        if (!rw) return ['`resultWrite` 整块缺失（"键恒在"是搬运口径的一部分）'];
        const bad = [];
        for (const k of RW_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(rw, k)) { bad.push('缺键 `resultWrite.' + k + '`'); continue; }
          if (k === 'lastError') {
            if (rw[k] !== null && typeof rw[k] !== 'string') bad.push('`lastError`＝' + JSON.stringify(rw[k]) + '（须 null 或字符串）');
          } else if (!Number.isFinite(rw[k])) bad.push('`' + k + '`＝' + JSON.stringify(rw[k]) + '（须有限数字）');
        }
        const extra = Object.keys(rw).filter(k => RW_KEYS.indexOf(k) < 0);
        if (extra.length) bad.push('多了未登记键 ' + extra.join('/'));
        return bad;
      };
      /** 一次读数 → 四个计数（缺块 ⇒ null） */
      const rwOf4 = h => {
        const rw = rwOf(h);
        return rw ? { writes: rw.writes, failures: rw.failures, skippedNoUnit: rw.skippedNoUnit, lastError: rw.lastError } : null;
      };
      /** 两次读数之间的增量（任一侧缺块 ⇒ null） */
      const rwDelta = (a, b) => (a && b ? {
        writes: b.writes - a.writes, failures: b.failures - a.failures, skippedNoUnit: b.skippedNoUnit - a.skippedNoUnit
      } : null);
      /** 甲-3 的判据本体（"`skippedNoUnit` 与 `failures` 分得开"）——
          D22 暗桩②**复用同一个函数**：暗桩若另抄一份判据，它绿了也不能证明这条断言可证伪。 */
      const separateNoUnitFromFailures = (before, afterNoUnit, afterControl) => {
        const dNo = rwDelta(rwOf4(before), rwOf4(afterNoUnit));
        const dCtl = rwDelta(rwOf4(afterNoUnit), rwOf4(afterControl));
        return {
          dNo, dCtl,
          ok: Boolean(dNo && dCtl) && dNo.skippedNoUnit === 3 && dNo.failures === 0 && dNo.writes === 0 &&
            dCtl.skippedNoUnit === 0 && dCtl.writes === 1
        };
      };

      const coldH = cnt.health, beforeH = nu.healthBefore, afterNoH = nu.healthAfterNoUnit, afterCtlH = nu.healthAfterControl;
      const cold4 = rwOf4(coldH), before4 = rwOf4(beforeH), afterNo4 = rwOf4(afterNoH), afterCtl4 = rwOf4(afterCtlH);
      const readings = [
        ['冷启动（未推任何帧）', coldH],
        ['四帧成功落库 ＋ 一次注入写失败之后', beforeH],
        ['三帧不带件序号之后', afterNoH],
        ['补上件序号那一帧之后', afterCtlH]
      ];
      const keyProblems = [];
      for (const [label, h] of readings) for (const p of rwKeyProblems(h)) keyProblems.push(label + '：' + p);

      /* ---- 甲-1：键恒在（含冷启动的四个 0／null 形状） ---- */
      t.check('甲-1/`E58` 出口·**键恒在**：四次**真 HTTP** `/health` 读数的 `resultWrite` 块键集恒为 ' +
        '`{writes, failures, lastError, skippedNoUnit}`（含**冷启动**、含从未写入过时 ' +
        '`writes=0／failures=0／lastError=null／skippedNoUnit=0`）—— 缺块／缺键／多键／类型不合口径即判红并**逐项指名**',
        keyProblems.length === 0 && readings.every(([, h]) => Boolean(rwOf(h))) &&
        Boolean(cold4) && cold4.writes === 0 && cold4.failures === 0 && cold4.lastError === null && cold4.skippedNoUnit === 0,
        keyProblems.length ? `问题 ${keyProblems.length} 处：${keyProblems.join('；')}`
          : `四次读数键集齐全、类型合口径；冷启动实测 ${JSON.stringify(cold4)}；` +
            readings.slice(1).map(([l, h]) => `${l}＝${JSON.stringify(rwOf(h))}`).join('；'));

      /* ---- `E146`（2026-10-04，本座位 `T-20261004-16`）：`/health.shiftStatWrite` 的**键集契约** ----
         立案：座位 3 落地 `E146` 方案 C 时**只增一个键**（`splitDegradedRows`）并主动点名"可能受影响的断言面"。
         本座位独立复核其结论（**属实**）：A1 段是按**键**读 `writes/backfills/failures/lastShiftKey`，
         `JSON.stringify(...shiftStatWrite)` 只出现在 **check 的 detail 文案位**（不是判据）；
         全 A1 段唯一"键集不许有多余键"的判据判的是 **`/health.resultWrite`**（`RW_KEYS`），**不是**
         `shiftStatWrite`；`a1ShapeAudit()` 审的是 `shift_stat` **行**形态 ⇒ **不涉及**。
         **但"只增键"此前没有正面判据** ⇒ 补一条（照 `RW_KEYS` 的先例）：把键集变成**被守的契约** ——
         既防"悄悄少一个键"（读方 silent undefined），也防"悄悄多一个键"（读过即冻的口径被绕过）。 */
      {
        const SSW_KEYS = ['writes', 'backfills', 'failures', 'lastError', 'lastShiftKey', 'staleFrames', 'splitDegradedRows'];
        const sswProblems = [];
        let sswSeen = 0;
        for (const [label, h] of readings) {
          const b = h && typeof h === 'object' ? h.shiftStatWrite : null;
          if (!b || typeof b !== 'object') { sswProblems.push(label + '：`shiftStatWrite` 整块缺失'); continue; }
          sswSeen++;
          for (const k of SSW_KEYS) if (!Object.prototype.hasOwnProperty.call(b, k)) sswProblems.push(label + '：缺键 `shiftStatWrite.' + k + '`');
          const extra = Object.keys(b).filter(k => SSW_KEYS.indexOf(k) < 0);
          if (extra.length) sswProblems.push(label + '：多了未登记键 ' + extra.join('/'));
          if (typeof b.lastError !== 'string' && b.lastError !== null) sswProblems.push(label + '：`lastError` 类型不合口径（' + JSON.stringify(b.lastError) + '）');
          if (typeof b.lastShiftKey !== 'string' && b.lastShiftKey !== null) sswProblems.push(label + '：`lastShiftKey` 类型不合口径（' + JSON.stringify(b.lastShiftKey) + '）');
        }
        const coldSsw = coldH && coldH.shiftStatWrite ? coldH.shiftStatWrite : null;
        t.check('`E146` `/health.shiftStatWrite` **键集恒为** ' +
          '`{writes, backfills, failures, lastError, lastShiftKey, staleFrames, splitDegradedRows}`（四次真 HTTP 读数逐次核；' +
          '缺块／缺键／**多键**／类型不合口径 ⇒ 判红并逐项指名）；冷启动时 `splitDegradedRows === 0`（可累加计数器的零值＝0，不是 null）',
          sswSeen === readings.length && sswProblems.length === 0 && Boolean(coldSsw) && coldSsw.splitDegradedRows === 0,
          sswProblems.length ? `问题 ${sswProblems.length} 处：${sswProblems.join('；')}`
            : `四次读数键集恒为 ${SSW_KEYS.join('/')}；冷启动 ${JSON.stringify(coldSsw)}；` +
              `末次读数 ${JSON.stringify(afterCtlH.shiftStatWrite)}`);
      }

      /* ---- 甲-2：正侧 —— 一次成功落库 ⇒ `writes` +1（真进程 ＋ 真 HTTP 走采集链） ---- */
      const pos = rwDelta(afterNo4, afterCtl4);            // 恰一帧（对照帧，unitIndex=1）跨这两次读数
      const coldToBefore = rwDelta(cold4, before4);
      t.check('甲-2/`E58` 出口·**正侧**（一次成功落库 ⇒ `writes` **+1**）：真进程 ＋ 真 HTTP 走 ' +
        '`POST /ifd/frame` → `onSampled` → `persistJudgement`，**恰一帧**（`unitIndex=1`、`testStatus=2`）落在 ' +
        '两次 `/health` 读数之间 ⇒ `resultWrite.writes` 增量**恰 1**（`failures`／`skippedNoUnit` 均不变）；' +
        '且"冷启动 → 注入失败之前"那一段的 `writes` 增量**＝该段真的推过的帧数**（逐帧对账，不写死 4）',
        Boolean(pos) && pos.writes === 1 && pos.failures === 0 && pos.skippedNoUnit === 0 &&
        Boolean(nuCtl.row) && Boolean(nuCtl.counts) && nuCtl.counts.rows === 1 &&
        Boolean(coldToBefore) && cnt.postsBeforeFail > 0 && coldToBefore.writes === cnt.postsBeforeFail,
        `对照帧（${nuCtl.at}，带 unitIndex=1）：${JSON.stringify(afterNo4)} → ${JSON.stringify(afterCtl4)}` +
        `（Δwrites=${pos && pos.writes}、Δfailures=${pos && pos.failures}、ΔskippedNoUnit=${pos && pos.skippedNoUnit}）；` +
        `该件库内行=${JSON.stringify(nuCtl.row)}、该票行数=${nuCtl.counts && nuCtl.counts.rows}；` +
        `冷启动 → 注入失败之前：${JSON.stringify(cold4)} → ${JSON.stringify(before4)}` +
        `（Δwrites=${coldToBefore && coldToBefore.writes}，该段实测推帧 ${cnt.postsBeforeFail} 帧）`);

      /* ---- 甲-3：`skippedNoUnit` 与 `failures` **分得开** ---- */
      const sep = separateNoUnitFromFailures(beforeH, afterNoH, afterCtlH);
      t.check('甲-3/`E60①` 出口·**`skippedNoUnit` 与 `failures` 分得开**：同一票连推 3 帧**不带件序号**' +
        '（`testStatus=2`、计划开工与生效标准都已就位 ⇒ 若带件序号必固化）⇒ ' +
        '`/health.resultWrite.skippedNoUnit` **恰 +3**，而 `failures` **一字不变**、`writes` 也**不变**' +
        '（"根本没打算落" ≠ "落失败"）；随后**补上件序号**（`unitIndex=1`、其余同）⇒ `writes` **+1** 且 ' +
        '`skippedNoUnit` **不再增**（把两者并成一个数、或让缺件序号的帧也去写 ⇒ 本条必红）',
        sep.ok && Boolean(nu.countsBefore) && nu.countsBefore.done === 0 && Boolean(nu.countsAfter) &&
        nu.countsAfter.done === 0 && nu.countsAfter.rows === 0 && nuPosts.every(p => p.frameHasUnitIndex === false),
        `三帧不带件序号：${JSON.stringify(before4)} → ${JSON.stringify(afterNo4)}` +
        `（ΔskippedNoUnit=${sep.dNo && sep.dNo.skippedNoUnit}、Δfailures=${sep.dNo && sep.dNo.failures}、` +
        `Δwrites=${sep.dNo && sep.dNo.writes}）；该票 ` + '`result`' + ` 行数 ` +
        `${nu.countsBefore && nu.countsBefore.rows}→${nu.countsAfter && nu.countsAfter.rows}、` +
        `countDone ${nu.countsBefore && nu.countsBefore.done}→${nu.countsAfter && nu.countsAfter.done}；` +
        `补上件序号那一帧：${JSON.stringify(afterNo4)} → ${JSON.stringify(afterCtl4)}` +
        `（Δwrites=${sep.dCtl && sep.dCtl.writes}、ΔskippedNoUnit=${sep.dCtl && sep.dCtl.skippedNoUnit}）`);

      /* ---- 甲-4：失败侧（注入一次写失败）＋ 采集链不受影响 ---- */
      const injPost = cnt.posts.filter(p => p.at === CNT_FAIL)[0] || null;
      const failDelta = rwDelta(cold4, before4);
      t.check('甲-4/`E58` 出口·**失败侧**（注入一次写失败 ⇒ `failures` **+1**、`lastError` 非空、' +
        '`skippedNoUnit` **不变**，且**采集链不受影响**）：注入方式＝把**共享模块对象**上的 ' +
        '`resultRepo.upsertJudgement` 换成抛错桩（**不改文件**，测完当场还原；见夹具内注释）⇒ ' +
        '`/health` 的 `failures` 增量**恰 1**、`lastError` 非空且**点名**注入原因、`skippedNoUnit` 不变；' +
        '该帧仍 `stored`（HTTP 200）、其后一帧照常 `writes` +1（链路没被打断）',
        Boolean(failDelta) && failDelta.failures === 1 && failDelta.skippedNoUnit === 0 &&
        Boolean(before4) && typeof before4.lastError === 'string' && before4.lastError.length > 0 &&
        before4.lastError.indexOf('注入') >= 0 &&
        Boolean(injPost) && Boolean(injPost.res) && injPost.res.status === 200 &&
        Boolean(injPost.res.body) && injPost.res.body.outcome === 'stored' &&
        Boolean(pos) && pos.writes === 1 && cnt.rowsAAfterFail === cnt.rowsA,
        `冷启动 ${JSON.stringify(cold4)} → 注入之后 ${JSON.stringify(before4)}` +
        `（Δfailures=${failDelta && failDelta.failures}、ΔskippedNoUnit=${failDelta && failDelta.skippedNoUnit}）；` +
        `lastError 点名注入＝${Boolean(before4) && typeof before4.lastError === 'string' && before4.lastError.indexOf('注入') >= 0}、` +
        `实测=${JSON.stringify(before4 && before4.lastError)}；注入了失败的那一帧（${injPost && injPost.at}，第 2 件）：` +
        `HTTP ${injPost && injPost.res && injPost.res.status}／${injPost && injPost.res && injPost.res.body && injPost.res.body.outcome}` +
        `（采集链照收）；其后对照帧 Δwrites=${pos && pos.writes}（+1 ⇒ 没被打断）；该票行数 ${cnt.rowsA}→${cnt.rowsAAfterFail}`);

      /* 实测读数**打印出来**（ADR-0004 D21：复核者不跑也能看到"期望值是从哪些现场读数推出来的"；
         不计入断言数）—— 两处增量分别对应 甲-2（对照帧恰一帧）与 甲-3（三帧不带件序号）。 */
      t.info(`甲·/health.resultWrite 实测（真 HTTP 四次读数）：冷启动 ${JSON.stringify(cold4)}；`
        + `四帧落库 ＋ 一次注入写失败后 ${JSON.stringify(before4)}；`
        + `三帧不带件序号后 ${JSON.stringify(afterNo4)}（相对上一次 ΔskippedNoUnit=+${sep.dNo && sep.dNo.skippedNoUnit}、`
        + `Δfailures=${sep.dNo && sep.dNo.failures}、Δwrites=${sep.dNo && sep.dNo.writes}）；`
        + `补上件序号那一帧后 ${JSON.stringify(afterCtl4)}（Δwrites=+${pos && pos.writes}、`
        + `ΔskippedNoUnit=${pos && pos.skippedNoUnit}）；`
        + `冷启动 → 注入失败之前 Δwrites=${coldToBefore && coldToBefore.writes}（＝该段实测推帧 ${cnt.postsBeforeFail} 帧）`);

      /* ---- D22 暗桩：两条定点变异（字节副本，不落盘） ---- */
      const SERVER_FILE = path.join(env.paths.root, 'server', 'index.js');
      const serverBytes = fs.readFileSync(SERVER_FILE);          /* 字节副本①（只读，全程不写盘） */
      const serverSha0 = sha256Hex(serverBytes);
      const serverSrc = serverBytes.toString('utf8');
      /* ⚠ 锚点必须**行长风格无关**（`\r?\n`）：实测 `server\index.js` 是 **CRLF**，
         用 `\n` 拼锚点会"锚点未命中"⇒ 暗桩变成假红（本批第一版就踩了这个坑）。 */
      const RW_BLOCK_RE = /[ \t]*resultWrite: \{\r?\n[ \t]*writes: state\.resultWrite\.writes,\r?\n[ \t]*failures: state\.resultWrite\.failures,\r?\n[ \t]*lastError: state\.resultWrite\.lastError,\r?\n[ \t]*skippedNoUnit: state\.resultWrite\.skippedNoUnit\r?\n[ \t]*\},\r?\n/;
      const RW_FAIL_LINE_RE = /([ \t]*)failures: state\.resultWrite\.failures,(\r?\n)/;
      /** 由**内存字节副本**载入一个 `server/index.js` 变异体（`Module._compile`：不落地、不碰仓库；
          与 §15-E／§16 同款手法）。`require.main !== module` ⇒ 不会自动 `main()`（不起服务）。 */
      const loadServerVariant = (src, tag) => {
        const Module = require('node:module');
        const m = new Module(SERVER_FILE + '#' + tag, null);
        m.filename = SERVER_FILE;
        m.paths = Module._nodeModulePaths(path.dirname(SERVER_FILE));
        m._compile(src, m.filename);
        return m.exports;
      };
      /* 变异体①：把 `healthPayload()` 里的 `resultWrite` 搬运块**整段摘掉**。 */
      t.check('甲-D22① 定点变异：把 `/health` 里**搬运 `resultWrite` 的那段整块摘掉**（`server/index.js` 的' +
        '**内存字节副本**变异体）⇒ 甲-1 的"键恒在"判据**必红并指名** `resultWrite`；未变异的当前源码必绿；' +
        '盘上文件全程逐字节未变',
        (() => {
          if (!RW_BLOCK_RE.test(serverSrc)) {
            t.info('甲-D22① 变异锚点未命中（`resultWrite` 搬运块被改过形状）—— 锚点命不中即判红，不许静默放过');
            return false;
          }
          const mutSrc = serverSrc.replace(RW_BLOCK_RE, '');
          let mut = null;
          try { mut = loadServerVariant(mutSrc, 'rw-cut'); }
          catch (err) { t.info('甲-D22① 变异体载入失败：' + (err && err.message)); return false; }
          /* 喂给变异体的运行态＝**真·现场读数**（不是编的：就是本次四帧＋一次注入失败之后那一份） */
          mut.state.resultWrite = Object.assign({}, before4);
          const mutProblems = rwKeyProblems(mut.healthPayload());
          const curProblems = rwKeyProblems(afterCtlH);            // 当前源码（真 HTTP 读数）⇒ 必绿
          const mutSha = sha256Hex(Buffer.from(mutSrc, 'utf8'));
          const diskSame = sha256Hex(fs.readFileSync(SERVER_FILE)) === serverSha0;
          t.info(`甲-D22① 变异体 sha256=${mutSha.slice(0, 12)}…（原件 sha256=${serverSha0.slice(0, 12)}…）；`
            + `变异体 /health.resultWrite 问题 ${mutProblems.length} 条：${mutProblems.join('；')}；`
            + `当前源码问题 ${curProblems.length} 条；盘上文件未变=${diskSame}`);
          return mutProblems.length > 0 && mutProblems.join('；').indexOf('resultWrite') >= 0 &&
            curProblems.length === 0 && diskSame;
        })(),
        '变异内容：删掉 `healthPayload()` 里的 `resultWrite: { writes, failures, lastError, skippedNoUnit },` 整块 ' +
        '（＝回到 `T-20261003-02` 之前的形态：三个计数只在进程内存里、外部读不到）—— ' +
        '甲-1 的"键恒在"判据必须当场指名该块缺失');

      /* 变异体②：把 `skippedNoUnit` **并进** `failures`（＝恢复"拿不到与失败混一起"）。 */
      t.check('甲-D22② 定点变异：把 `skippedNoUnit` **并进** `failures`（`failures: failures + skippedNoUnit`，' +
        '`server/index.js` 的**内存字节副本**变异体）⇒ 甲-3 的"二者分得开"判据**必红并指名**；' +
        '未变异的当前源码必绿；盘上文件全程逐字节未变',
        (() => {
          if (!RW_FAIL_LINE_RE.test(serverSrc)) {
            t.info('甲-D22② 变异锚点未命中（`failures: state.resultWrite.failures,` 那行）—— 判红，不许静默放过');
            return false;
          }
          const mutSrc = serverSrc.replace(RW_FAIL_LINE_RE,
            '$1failures: state.resultWrite.failures + state.resultWrite.skippedNoUnit,$2');
          let mut = null;
          try { mut = loadServerVariant(mutSrc, 'rw-merge'); }
          catch (err) { t.info('甲-D22② 变异体载入失败：' + (err && err.message)); return false; }
          const payloadAt = st => { mut.state.resultWrite = Object.assign({}, st); return mut.healthPayload(); };
          /* 两个输入态＝**真·现场读数**：注入失败之后 / 三帧不带件序号之后（当前实现里 `/health` 就是搬运，
             故这两份读数**就是**那两刻的 `state.resultWrite`；没有编造中间态）。 */
          const mutNo = payloadAt(before4), mutCtl = payloadAt(afterNo4);
          const mutSep = separateNoUnitFromFailures(mutNo, mutCtl, payloadAt(afterCtl4));
          const mutSha = sha256Hex(Buffer.from(mutSrc, 'utf8'));
          const diskSame = sha256Hex(fs.readFileSync(SERVER_FILE)) === serverSha0;
          t.info(`甲-D22② 变异体 sha256=${mutSha.slice(0, 12)}…（原件 sha256=${serverSha0.slice(0, 12)}…）；`
            + `变异体三帧读数 ${JSON.stringify(mutNo && mutNo.resultWrite)} → ${JSON.stringify(mutCtl && mutCtl.resultWrite)}`
            + `（ΔskippedNoUnit=${mutSep.dNo && mutSep.dNo.skippedNoUnit}、Δfailures=${mutSep.dNo && mutSep.dNo.failures}）；`
            + `当前源码同判据=${sep.ok}；盘上文件未变=${diskSame}`);
          /* "必红"＝同一判据在变异体上不成立；"当前源码必绿"＝sep.ok（甲-3 本身）⇒ 不是"把一切都判红" */
          return mutSep.ok === false && sep.ok === true && diskSame;
        })(),
        '变异内容：`/health` 的 `failures` 改成 `failures + skippedNoUnit`（把"根本没打算落"并进"落失败"）' +
        '—— 甲-3 必须当场指名 Δfailures 被污染（这正是 `E60` 病灶的形态）');
    }
  }

  /* ==================== `E148`（★，2026-10-04，本座位 `T-20261004-16`）：`upsertFrozen()` 的
     **"容忍未知键"契约**（把它从"读代码才知道"变成"被断言守住"） ====================
     立案（主代理登记）：`server\repo\shiftStat.js` 的 `upsertFrozen(db, row)` **只读已知字段**
     （`input.shiftDate`／`planQty`／… 逐个过 `assert*`），**多余键静默忽略、既不进 SQL 也不报错**。
     座位 3 读码确认"当前成立"，但 `tests\` 里**零断言**守护它 ⇒ 这条契约将来会成为"给行对象挂额外标记"
     这类用法的**前提**（今天已经因为它没被守而否决了一个方案）⇒ 要么守它、要么明确拒绝它。**本件＝守它。**
     判据（三段，缺一不可）：① 带未知键的那次调用**返回值与不带未知键那次逐键相同**；
     ② 库内**逐行字节不变**（同一行按 `shift_date/shift_name` 取回，`JSON.stringify` 相等 ⇒ 未知键没落库）；
     ③ 未知键**不可见**于 `listRows()` 的任何一行（含"未知键被当成列名"这种形态）。
     D22：把"容忍"改成"拒绝"（**内存字节副本**变异体）⇒ 同一判据**必红并指名**；原件必绿；盘上文件逐字节未变。 */
  {
    const sswSha12 = (buf) => require('node:crypto').createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const SSW_FILE = path.join(env.paths.root, 'server', 'repo', 'shiftStat.js');
    const sswSrc0 = fs.readFileSync(SSW_FILE, 'utf8');
    const sswSha0 = sswSha12(sswSrc0);
    /** 与未知键**无关**的那部分判据：读回一行 ⇒ 逐字节文本 ＋ 全部行文本 */
    const sswRowText = (db, d, n) => JSON.stringify(shiftStatRepo.getShiftRow(db, d, n));
    const sswAllText = (db) => JSON.stringify(shiftStatRepo.listRows(db, 50));
    /** 变异体载入（`Module._compile` 内存副本；与 §15-E 同款手法，不落地、不碰仓库） */
    const sswLoadVariant = (src, tag) => {
      const Module = require('node:module');
      const mm = new Module(SSW_FILE + '#' + tag, null);
      mm.filename = SSW_FILE;
      mm.paths = Module._nodeModulePaths(path.dirname(SSW_FILE));
      mm._compile(src, mm.filename);
      return mm.exports;
    };
    const sswTmp = env.ensureDir(path.join(env.paths.tempRoot, 'e148-upsert-' + process.pid));
    let sswOut = null;
    try {      /* ⚠ `openDb()` 返回的是**包装对象** `{db, path, journalMode}`（不是句柄本身）⇒ 仓储要的是 `.db`。
         本座位第一版直接把它当句柄传 ⇒ `upsertFrozen` 报"需要已打开的库句柄"（实测踩过，写在这里）。 */
      const dbApi = require(path.join(env.paths.root, 'server', 'db'));
      const sswDb = dbApi.openDb(path.join(sswTmp, 'board.db')).db;
      dbApi.initSchema(sswDb);        /* ⚠ `openDb` **只开库不建表**：不建 schema 会 `no such table: shift_stat` */
      const sswBase = {
        shiftDate: '2026-10-02', shiftName: '中班',
        planQty: 6, startedQty: 6, finishedQty: 6, qualifiedQty: 5, failedQty: 1, retestQty: 0,
        passRate: 5 / 6, runSec: 9000, runSecDay1: 9000, runSecDay2: 0, idleSec: 0, oee: 0.5,
        frozenAt: '2026-10-02 23:59:59', createdAt: '2026-10-02 23:59:59'
      };
      /* 先写一行"干净的"、再用**同一行 ＋ 未知键** upsert 同一 (date,name) ⇒ 第二次必须是一次
         完全等价的 UPDATE（`changes>0`），而不是"因为多了键就写了别的什么"。 */
      const cleanRet = shiftStatRepo.upsertFrozen(sswDb, Object.assign({}, sswBase));
      const rowTextAfterClean = sswRowText(sswDb, sswBase.shiftDate, sswBase.shiftName);
      const allTextAfterClean = sswAllText(sswDb);
      const dirtyRow = Object.assign({}, sswBase, {
        zzUnknownFlag: true, splitDegradedReason: '（外来标记：不该落库）', degraded: true, unknownNumeric: 123
      });
      let dirtyRet = null; let dirtyThrew = null;
      try { dirtyRet = shiftStatRepo.upsertFrozen(sswDb, dirtyRow); } catch (e) { dirtyThrew = String(e && e.message); }
      const rowTextAfterDirty = sswRowText(sswDb, sswBase.shiftDate, sswBase.shiftName);
      const allTextAfterDirty = sswAllText(sswDb);
      /* 变异体：在函数入口处**拒绝未知键**（照"入参形态校验"的写法）—— 同一判据必须当场红 */
      const sswAnchor = 'const input = row && typeof row === \'object\' ? row : {};';
      const sswMutOk = sswSrc0.includes(sswAnchor);
      let mutThrew = null; let mutRet = null;
      let mutCleanRet = null; let mutRowSame = null; let mutAllSame = null;
      let mutLeaked = null; let mutCleanUpdatedOk = null;
      if (sswMutOk) {
        const mutSrc = sswSrc0.replace(sswAnchor,
          sswAnchor + '\n  { const KNOWN = ["shiftDate","shiftName","planQty","startedQty","finishedQty","qualifiedQty",'
          + '"failedQty","retestQty","passRate","runSec","runSecDay1","runSecDay2","idleSec","oee","frozenAt","createdAt"];'
          + '\n    const extra = Object.keys(input).filter(k => KNOWN.indexOf(k) < 0);'
          + '\n    if (extra.length) throw new TypeError("shiftStat: 拒绝未知键 " + extra.join("/")); }');
        const mutRepo = sswLoadVariant(mutSrc, 'e148-reject');
        const mutDb = dbApi.openDb(path.join(sswTmp, 'board-mut.db')).db;
        dbApi.initSchema(mutDb);
        /* `E153`：**把变异体的库侧读数也实测出来**（而不是"假定它除了抛错之外都干净"）——
           干净行照写（`mutCleanRet.updated === false`）、带未知键那次抛错后**该行/全表一个字都没变**、
           未知键没泄漏。这三条由 D22 的读数直接引用。 */
        mutCleanRet = mutRepo.upsertFrozen(mutDb, Object.assign({}, sswBase));
        const mutRowAfterClean = sswRowText(mutDb, sswBase.shiftDate, sswBase.shiftName);
        const mutAllAfterClean = sswAllText(mutDb);
        mutRet = true;
        try { mutRepo.upsertFrozen(mutDb, dirtyRow); } catch (e) { mutThrew = String(e && e.message); }
        const mutRowAfterDirty = sswRowText(mutDb, sswBase.shiftDate, sswBase.shiftName);
        const mutAllAfterDirty = sswAllText(mutDb);
        mutRowSame = mutRowAfterClean === mutRowAfterDirty;
        mutAllSame = mutAllAfterClean === mutAllAfterDirty;
        mutLeaked = /zzUnknownFlag|splitDegradedReason|unknownNumeric|degraded/.test(mutAllAfterDirty);
        mutCleanUpdatedOk = Boolean(mutCleanRet) && mutCleanRet.updated === false;
        try { mutDb.close(); } catch { /* 忽略 */ }
      }
      const diskSameSsw = sswSha12(fs.readFileSync(SSW_FILE)) === sswSha0;
      try { sswDb.close(); } catch { /* 忽略 */ }
      sswOut = {
        cleanRet, dirtyRet, dirtyThrew, mutThrew, mutRet, sswMutOk, diskSameSsw,
        mutCleanUpdatedOk, mutRowSame, mutAllSame, mutLeaked,
        /* ⚠ 只比"与未知键无关"的键：`updated` 是**行是否已存在**的读数（第一次 INSERT ⇒ false、
           第二次同 (date,name) UPDATE ⇒ true），**本来就该不同** —— 把它算进去会把"正常语义"
           误判成"未知键改了返回值"（本座位第一版就这么读了，留在这里）。 */
        retSame: JSON.stringify(Object.assign({}, cleanRet, { updated: null }))
          === JSON.stringify(Object.assign({}, dirtyRet, { updated: null })),
        updatedFlagOk: cleanRet && dirtyRet && cleanRet.updated === false && dirtyRet.updated === true,
        rowSame: rowTextAfterClean === rowTextAfterDirty,
        allSame: allTextAfterClean === allTextAfterDirty,
        leaked: /zzUnknownFlag|splitDegradedReason|unknownNumeric|degraded/.test(allTextAfterDirty)
      };
    } catch (err) {
      sswOut = { error: String(err && err.stack ? err.stack : err) };
    }
    /** `E148` 的**契约谓词（纯函数）**：主断言与 D22 **都喂它** ⇒ "变异后必红"是**执行出来的**、
     *  不是靠人读谓词推出来的（`E153`，据 `C·23` 第 7 组）。
     *  ⚠ **为什么必须共用同一个谓词**（本件要求写进注释并在回执复述）：旧写法把契约**内联**在主断言里，
     *  而 D22 走的是**另一条**独立路径（另一份 `Module._compile` 副本 ＋ 另一个库），两者只在"同一个
     *  `sswOut` 对象"这一层相遇 ⇒ 合取项 `dirtyThrew === null` **只在契约谓词里**（全仓 5 处全在契约侧），
     *  D22 的谓词只读 `mutThrew` ⇒ **若有人把 `dirtyThrew === null` 从契约里删掉（`D21` 禁的动作），
     *  两条断言都会照样绿** —— 这就是 `D19` 的"看起来验过了"。抽成纯函数后：D22 把**变异体的读数**代回
     *  **同一个谓词**，删掉那一项 ⇒ 本条 D22 **当场红**。
     *  @param {object|null} o 取值对象；`null` ⇒ 用例未执行
     *  @returns {{pass:boolean, problems:string[]}} */
    const sswContractE148 = (o) => {
      if (!o) return { pass: false, problems: ['取值对象缺失（用例未执行）'] };
      if (o.error) return { pass: false, problems: [`用例自身异常：${o.error}`] };
      const problems = [];
      if (!o.retSame) problems.push('带未知键/不带未知键的**返回值**（除 `updated` 位）不相同');
      if (!o.updatedFlagOk) problems.push('`updated` 位不符合语义（首写 false／改写 true）');
      if (!o.rowSame) problems.push('库内该行文本变了（未知键落库）');
      if (!o.allSame) problems.push('全表文本变了');
      if (o.leaked) problems.push('未知键出现在行文本里（泄漏进 SQL）');
      if (o.dirtyThrew !== null) problems.push(`**带未知键的调用抛错**（契约要求"容忍未知键"）：${o.dirtyThrew}`);
      return { pass: problems.length === 0, problems };
    };
    const sswConvE148 = sswContractE148(sswOut);            /* 主断言的判决（同一个谓词） */
    t.check('`E148` `upsertFrozen()` **容忍未知键**（显式契约）：喂同一行 ＋ 四个未知键' +
      '（`zzUnknownFlag`／`splitDegradedReason`／`degraded`／`unknownNumeric`）⇒ ' +
      '**返回值逐键与不带未知键那次相同**、**库内该行逐字节不变**、**未知键不出现在任何行里**（不进 SQL）' +
      '（判据＝纯函数 `sswContractE148()`，与 D22 **共用**）',
      sswConvE148.pass,
      sswOut && sswOut.error ? `**用例自身异常**：${sswOut.error}`
        : `契约谓词（**纯函数** \`sswContractE148()\`）判决=${sswConvE148.pass}；违反项 ${sswConvE148.problems.length} 条＝`
          + `${sswConvE148.problems.join('；') || '（无）'}；`
          + `带未知键/不带未知键的返回（**除 \`updated\` 位**）逐键相同=${sswOut.retSame}（\`${JSON.stringify(sswOut.cleanRet)}\`）；`
          + `\`updated\` 位符合语义=${sswOut.updatedFlagOk}（首写 false／改写 true，与未知键无关）；`
          + `库内该行文本不变=${sswOut.rowSame}；全表文本不变=${sswOut.allSame}；`
          + `未知键泄漏到行文本=${sswOut.leaked}（应 false）；调用未抛错=${sswOut.dirtyThrew === null}`);
    /* `E153`：把**变异体的读数喂回同一个谓词** —— 构造法是**单点替换**（只换契约要守的那一位
       `dirtyThrew`），其余位沿用原件读数（原件已被上面那条判定为真）⇒ 判决的红**只可能**归因于这一项。
       为什么可以这样构造（如实交代）：变异体的"带未知键那次"**抛了错、没有返回值** ⇒ `retSame`／
       `updatedFlagOk` 这些"以返回值为前提"的位在变异体上**不可评**；本件另外**实测**了变异体的库侧读数
       （`mutCleanUpdatedOk`／`mutRowSame`／`mutAllSame`／`mutLeaked`）来证明"除了这一位，其余都干净"。 */
    const sswMutViewE148 = (sswOut && !sswOut.error)
      ? Object.assign({}, sswOut, { dirtyThrew: sswOut.mutThrew }) : null;
    const sswMutConvE148 = sswContractE148(sswMutViewE148);
    const sswMutViewDiffKeysE148 = (sswOut && !sswOut.error)
      ? Object.keys(sswOut).filter(k => k !== 'dirtyThrew'
        && JSON.stringify(sswOut[k]) !== JSON.stringify(sswMutViewE148[k])) : ['（用例未执行）'];
    t.check('`E148` D22（可证伪）：把"容忍未知键"改成"**拒绝**未知键"（`server\\repo\\shiftStat.js` 的' +
      '**内存字节副本**变异体：入口处对清单外的键抛 `TypeError`）⇒ 把**变异体的读数**代回**同一个契约谓词**' +
      '（`sswContractE148()`）**必红、且只因为 `dirtyThrew` 那一个合取项**（删掉契约里那一项 ⇒ 本条当场红）；' +
      '而变异体对**干净行**照写不误、库侧读数全干净（⇒ 不是"把一切都拦掉"）；盘上文件全程逐字节未变',
      Boolean(sswOut) && !sswOut.error && sswOut.sswMutOk
        && sswMutConvE148.pass === false
        && sswMutConvE148.problems.length === 1
        && /带未知键的调用抛错/.test(sswMutConvE148.problems[0])
        && sswMutViewDiffKeysE148.length === 0
        && sswMutViewE148.dirtyThrew === sswOut.mutThrew
        && sswOut.mutThrew !== null && /拒绝未知键/.test(String(sswOut.mutThrew))
        && sswOut.mutRet === true && sswOut.mutCleanUpdatedOk === true
        && sswOut.mutRowSame === true && sswOut.mutAllSame === true && sswOut.mutLeaked === false
        && sswOut.diskSameSsw,
      sswOut && sswOut.error ? `**用例自身异常**：${sswOut.error}`
        : `变异锚点命中=${sswOut.sswMutOk}；变异体带未知键 ⇒ ${sswOut.mutThrew === null ? '**没抛错（异常）**' : `抛「${sswOut.mutThrew}」`}；`
          + `**喂回同一谓词** ⇒ 判决=${sswMutConvE148.pass}（应 **false ＝必红**）、违反项 ${sswMutConvE148.problems.length} 条＝`
          + `${sswMutConvE148.problems.join('；') || '（无）'}；`
          + `变异体读数与原件**差异键**＝[${sswMutViewDiffKeysE148.join('、') || '（无）'}]`
          + `（**只有 \`dirtyThrew\` 这一位** ⇒ 若把契约里那一项删掉，判决就会变 true、本条当场红）；`
          + `变异体干净行写入成功=${sswOut.mutRet === true}（\`updated\` 位符语义=${sswOut.mutCleanUpdatedOk}）；`
          + `变异体库侧：该行未变=${sswOut.mutRowSame}、全表未变=${sswOut.mutAllSame}、未泄漏=${sswOut.mutLeaked === false}；`
          + `盘上文件未变=${sswOut.diskSameSsw}`);
    /* 收尾（**必须做**）：本用例建在 `env.paths.tempRoot` 下 ⇒ 不删干净会污染后面的 E90 临时区清理断言
       （本座位第一版实测：`E90②/④` 与 `cleanup(true)` 三条因此判红）。走 `env.removeLinkSafe()`（E46 纪律）。 */
    t.info(`\`E148\`／\`E153\` 读数（**同一个纯函数** \`sswContractE148()\` 的两侧判决）：`
      + `原件 ⇒ ${sswConvE148.pass}（违反项 ${sswConvE148.problems.length} 条：${sswConvE148.problems.join('；') || '（无）'}）；`
      + `变异体读数代回同一谓词 ⇒ ${sswMutConvE148.pass}（违反项 ${sswMutConvE148.problems.length} 条：${sswMutConvE148.problems.join('；') || '（无）'}）；`
      + `两者差异键＝[${sswMutViewDiffKeysE148.join('、') || '（无）'}]（**只有 \`dirtyThrew\`** ⇒ 删掉契约里那一项，D22 就会变绿为红不成立）；`
      + `\`dirtyThrew\` 侧的合取项在**全仓只此一处**（旧写法下 D22 的谓词一次都没读它 ⇒ \`D19\` 的"看起来验过了"）。`);
    try { env.removeLinkSafe(sswTmp, { recursive: true, force: true }); } catch { /* 收尾失败不影响判据读数 */ }
  }

  t.check('FR-5.8/C-88 行为：**同态临近**（深度与速度各距上/下限恰 k 格）⇒ 事件里参数类**恰 2 条**且名称均为「参数阈值临近预警」、等级 warn、每条只含一个参数',
    Boolean(harmEv) && harmParam.length === 2 &&
    harmParam.every(w => w.title === judge.WARN_TITLES.warn && w.lv === 'warn') &&
    /* 两参数**同态 ⇒ 各出一条**（C-88 / R26-P2-2）：同态下不按参数名排序，故按**集合**比对，
       只要求"深度、速度各占一条"（顺序不作判据，避免把展示顺序写死成第二套口径）。 */
    harmParam.map(w => (w.detail.includes('深度') ? 'depth' : (w.detail.includes('速度') ? 'speed' : '?'))).sort().join(',') === 'depth,speed' &&
    harmParam.every(w => (w.detail.match(/深度|速度/g) || []).length === 1 && !w.detail.includes('；')),
    harmEv ? `参数类 ${harmParam.length} 条：` + harmParam.map(w => `${w.title}/${w.lv}｜${w.detail}`).join(' ／ ') : '未收到 warning 事件');

  const hookAt = (Array.isArray(warnOpt.hookAt) ? warnOpt.hookAt : []);
  /* 期望的 `at`：由**帧采集时刻文本**现算（不写字面量 ISO）—— `at` 是信封字段，读进程内订阅者。
     注入时钟此刻已是 10:00:0x（段⑤ 还推进过 6 s），而三帧采集时刻是 12:00:0x ⇒
     期望值不可能被"服务端当前时刻"凑出来（差 2 小时）。 */
  const atOfText = text => new Date(text.replace(' ', 'T')).toISOString();
  t.check('W5-②/E45 写点时序：`warning` 事件的 `at` 是**帧的采集时刻**（不是服务端当前时刻、也不是夹具注入时刻）＋ 每次落库帧**恰产生 1 条**（三条真帧 ⇒ 恰 3 条：同态临近 / 超范围 / 半套标准；幂等、原始、脏帧都不产生）',
    warnEvents.length === 3 && hookAt.length === 3 &&
    /* `at` 是事件信封字段（线路只发 data）⇒ 读进程内订阅者；三条应分别等于三帧的采集时刻 */
    ['harm', 'err', 'half'].every((k, i) => hookAt[i].at === atOfText((warnOpt.at || {})[k])) &&
    warnOpt.warnPost && warnOpt.warnPost.body && warnOpt.warnPost.body.outcome === 'stored' &&
    warnOpt.errPost && warnOpt.errPost.body && warnOpt.errPost.body.outcome === 'stored' &&
    warnOpt.halfPost && warnOpt.halfPost.body && warnOpt.halfPost.body.outcome === 'stored' &&
    warnOpt.ifdStatus && warnOpt.ifdStatus.counts && warnOpt.ifdStatus.counts.sampledHookFailures === 0,
    `warning 事件数=${warnEvents.length}；进程内信封 seq:at=${hookAt.map(x => x.seq + ':' + x.at).join(' , ')}` +
    `（期望＝三帧采集时刻的 UTC：12:00:00/10/20 ⇒ 04:00:00/10/20Z）；` +
    `三次推帧 outcome=${[warnOpt.warnPost, warnOpt.errPost, warnOpt.halfPost].map(p => p && p.body && p.body.outcome).join('/')}；` +
    `判定挂钩失败次数=${warnOpt.ifdStatus && warnOpt.ifdStatus.counts && warnOpt.ifdStatus.counts.sampledHookFailures}`);

  const errEv = warnEvents[1] || null;
  const errParam = (errEv && errEv.data && Array.isArray(errEv.data.warnings)
    ? errEv.data.warnings.filter(w => paramTitles.includes(w.title)) : []);
  t.check('FR-5.8 行为：**超范围**（深度越上限一格、速度仍在临近带）⇒ 事件里出「参数超范围预警」/err（深度）与「参数阈值临近预警」/warn（速度）各 1 条',
    Boolean(errEv) && errParam.length === 2 &&
    errParam.some(w => w.title === '参数超范围预警' && w.lv === 'err' && w.detail.includes('深度')) &&
    errParam.some(w => w.title === '参数阈值临近预警' && w.lv === 'warn' && w.detail.includes('速度')),
    errEv ? `参数类 ${errParam.length} 条：` + errParam.map(w => `${w.title}/${w.lv}｜${w.detail}`).join(' ／ ') : '未收到第二条 warning 事件');

  const halfEv = warnEvents[2] || null;
  const halfParam = (halfEv && halfEv.data && Array.isArray(halfEv.data.warnings)
    ? halfEv.data.warnings.filter(w => paramTitles.includes(w.title)) : []);
  const halfRow = (warnOpt.halfExpect && warnOpt.halfExpect.halfRow) || {};
  t.check('C-93⑤/FR-5.8 负向（**不得伪造**）：某参数**标准未设定**（库行里速度三格为 null、只有深度三格）＋ 实测双双越上限 ⇒ 事件里**只有一条**参数类（深度超范围），**不得**为速度回退配置演示值凭空成条',
    Boolean(halfEv) && halfParam.length === 1 &&
    halfParam[0].title === '参数超范围预警' && halfParam[0].lv === 'err' &&
    halfParam[0].detail.includes('深度') && !halfParam[0].detail.includes('速度') &&
    Number.isFinite(halfRow.depthTypical) && halfRow.depthTypical !== null &&
    halfRow.speedTypical === null && halfRow.speedUpperDev === null && halfRow.speedLowerDev === null,
    `半套库行：深度三格=${JSON.stringify([halfRow.depthTypical, halfRow.depthUpperDev, halfRow.depthLowerDev])}、` +
    `速度三格=${JSON.stringify([halfRow.speedTypical, halfRow.speedUpperDev, halfRow.speedLowerDev])}（应为 [null,null,null]）；` +
    `实测 depth=${warnOpt.halfExpect && warnOpt.halfExpect.depthErr}／speed=${warnOpt.halfExpect && warnOpt.halfExpect.speedErr}；` +
    `事件参数类 ${halfParam.length} 条：` + (halfParam.map(w => `${w.title}/${w.lv}｜${w.detail}`).join(' ／ ') || '（未收到）'));

  /* ---- 判据①：snapshot 的 frame / upload 与各自真源同源 ---- */
  t.check('W5-①：`snapshot.frame` 是**最新 1 s 采样帧**（与 frame 事件同源，不是另拼一份字段）',
    Boolean(s.stateFinal && s.stateFinal.snapshot && s.stateFinal.snapshot.frame) &&
    s.stateFinal.snapshot.frame.collectTime === '2026-09-19 10:00:12' &&
    s.stateFinal.snapshot.frame.depth === 5.12 &&
    ['equipCode', 'procOrderNo', 'collectTime', 'seq', 'depth', 'speed', 'velocity_x', 'velocity_y',
      'frameRate', 'gain', 'shutter', 'cameraDepth', 'testStatus'].every(k => k in s.stateFinal.snapshot.frame),
    JSON.stringify(s.stateFinal && s.stateFinal.snapshot && s.stateFinal.snapshot.frame));
  t.check('W5-①：`snapshot.upload` 与 W4 的 `GET /upload/status` **同源**（pendingCount/capacity/warnThreshold/alert 逐项相等）',
    Boolean(s.uploadStatus && s.stateFinal && s.stateFinal.snapshot && s.stateFinal.snapshot.upload) &&
    s.uploadStatus.pendingCount === s.stateFinal.snapshot.upload.pendingCount &&
    s.uploadStatus.pendingOnly === s.stateFinal.snapshot.upload.pendingOnly &&
    s.uploadStatus.capacity === s.stateFinal.snapshot.upload.capacity &&
    s.uploadStatus.warnThreshold === s.stateFinal.snapshot.upload.warnThreshold &&
    JSON.stringify(s.uploadStatus.alert) === JSON.stringify(s.stateFinal.snapshot.upload.alert),
    `/upload/status.pending=${s.uploadStatus && s.uploadStatus.pendingCount}；snapshot.upload.pending=${s.stateFinal && s.stateFinal.snapshot && s.stateFinal.snapshot.upload && s.stateFinal.snapshot.upload.pendingCount}`);

  /* ---- 判据⑨ E22②：testStatus 上行不伪造（码原样到 MES ／ 无帧拒发 ／ 维保检修→0 只是本机反查规则） ---- */
  const e22 = s.e22 || {};
  const e22codes = e22.codes || [];
  t.check('E22②：逐码 0/1/2/3 落帧后，MES 报文里的 testStatus 与**落库那一帧**逐个相等（服务端只照抄、不折叠）',
    e22codes.length === 4 &&
    e22codes.every(c => c.post && c.post.status === 200 && c.built && c.built.ok === true &&
      c.storedTestStatus === c.code && c.built.testStatus === c.code),
    `实跑四帧：${e22codes.map(c => `落库${c.storedTestStatus}→报文${c.built && c.built.testStatus}`).join('，')}` +
    `（POST 状态码 ${e22codes.map(c => c.post && c.post.status).join('/')}）`);
  t.check('E22②：码 `3`（设备异常）**不得**被"维保检修 → 0"那类本机规则改写成 0 —— ' +
    '真源 `fieldMap.modeToTestStatus` 里「维保检修=0」与「故障锁定=3」并存，服务端不套用它',
    (e22codes.find(c => c.code === 3) || {}).built &&
    e22codes.find(c => c.code === 3).built.testStatus === 3 &&
    (e22.modeMap || {})['维保检修'] === 0 && (e22.modeMap || {})['故障锁定'] === 3,
    `码 3 的报文 testStatus=${JSON.stringify((e22codes.find(c => c.code === 3) || {}).built && e22codes.find(c => c.code === 3).built.testStatus)}；` +
    `本机反查表=${JSON.stringify(e22.modeMap)}`);
  t.check('E22②：无实测帧且 `dataSource≠mock` ⇒ `NO_TEST_STATUS` **拒发**：一次都不发、不写 upload_log、不进待补传、不落假成功',
    e22.noFrame && e22.noFrame.build && e22.noFrame.build.ok === false &&
    e22.noFrame.build.error && e22.noFrame.build.error.code === 'NO_TEST_STATUS' &&
    e22.noFrame.build.error.field === 'testStatus' &&
    e22.noFrame.report && e22.noFrame.report.ok === false && e22.noFrame.report.skipped === true &&
    e22.noFrame.attempts === 0 && e22.noFrame.logBefore === e22.noFrame.logAfter &&
    e22.noFrame.pendingBefore === e22.noFrame.pendingAfter && e22.sends === 0,
    `buildReport.ok=${e22.noFrame && e22.noFrame.build && e22.noFrame.build.ok}` +
    `／error.code=${e22.noFrame && e22.noFrame.build && e22.noFrame.build.error && e22.noFrame.build.error.code}` +
    `／尝试发送次数=${e22.noFrame && e22.noFrame.attempts}／upload_log 行数 ${e22.noFrame && e22.noFrame.logBefore}→${e22.noFrame && e22.noFrame.logAfter}` +
    `／待补传 ${e22.noFrame && e22.noFrame.pendingBefore}→${e22.noFrame && e22.noFrame.pendingAfter}／真实 fetch 调用=${e22.sends}`);
  t.check('E22②：13 字段的**取数来源**在真源里写明 `testStatus` 来自 PC 上位机、缺值口径是"不伪造运行状态"（不是注释里的一句话）',
    Boolean(e22.noFrame && e22.noFrame.sourceOfTestStatus) &&
    e22.noFrame.sourceOfTestStatus.source === 'PC上位机' &&
    /不伪造/.test(String(e22.noFrame.sourceOfTestStatus.missing || '')) &&
    /measure_rt\.test_status/.test(String(e22.noFrame.sourceOfTestStatus.table || '')),
    JSON.stringify(e22.noFrame && e22.noFrame.sourceOfTestStatus));
  t.check('E22②「维保检修 → 0」的本机反查规则在真源里**逐项**成立（待机0／测试运行1／正常停机2／维保检修0／故障锁定3；' +
    '旧实现把维保检修写 2＝"上报：测试完成"）',
    JSON.stringify(e22.modeMap) === JSON.stringify({ '待机': 0, '测试运行': 1, '正常停机': 2, '维保检修': 0, '故障锁定': 3 }),
    `vm 实跑 fieldMap.modeToTestStatus = ${JSON.stringify(e22.modeMap)}`);

  /* ---- 判据⑥：优雅关闭（在途流收尾 / 定时器清零 / stop 按时返回 / 进程自然退出码 0） ---- */
  const cl = s.close || {};
  const sseMark = ((cl.marks || []).find(x => /SSE 连接/.test(x)) || '');
  const sseMarkMs = sseMark ? Number(String(sseMark).split('ms')[0]) : -1;
  t.check('W5-⑥：`closeAllStreams()` 让每条在途流收到结束信号（`: bye`）并结束、流计数归零；其后 5×心跳周期**再无新字节**（心跳定时器已清）',
    cl.closedCount === 1 && cl.sawBye === true && cl.streamDone === true &&
    cl.afterByeBytes === 0 && cl.streamsAfterCloseAll === 0,
    `closed=${cl.closedCount} 收到bye=${cl.sawBye} 流已结束=${cl.streamDone} 之后新增字节=${cl.afterByeBytes} 流计数=${cl.streamsAfterCloseAll}`);
  t.check('W5-⑥：`stop()` **按时返回**（在途 SSE 收尾留痕 ≤1 s；总耗时 < 4 s，远低于 8 s 上限）且夹具进程**自然退出码 0**（无残留句柄）',
    Boolean(cl.stopResult) && cl.stopResult.code === 0 && cl.stopMs < 4000 && sseMarkMs >= 0 && sseMarkMs <= 1000 &&
    Boolean(w5Exit) && w5Exit.code === 0,
    `exit=${JSON.stringify(w5Exit)}；stopMs=${cl.stopMs}；收尾留痕=${sseMark || '(无)'}；在途流B收到bye=${cl.streamB && cl.streamB.sawBye}`);
  t.check('W5-⑥：stop 后**无残留**：在途流 0 / 监听已关 / 库已关 / 事件总线已关闭（订阅者 0、缓冲释放）/ 链路监控定时器已停',
    Boolean(cl.afterStop) && cl.afterStop.streams === 0 && cl.afterStop.serverNull === true &&
    cl.afterStop.dbNull === true && cl.afterStop.busClosed === true &&
    cl.afterStop.busSubscribers === 0 && cl.afterStop.linkRunning === false,
    JSON.stringify(cl.afterStop && {
      streams: cl.afterStop.streams, serverNull: cl.afterStop.serverNull, dbNull: cl.afterStop.dbNull,
      busClosed: cl.afterStop.busClosed, subscribers: cl.afterStop.busSubscribers, linkRunning: cl.afterStop.linkRunning
    }));
  t.check('W5-⑦：端到端也能验缓冲溢出——容量 8 时 `dropped = seq − capacity`，`oldestSeq = seq − capacity + 1`（如实计数）',
    Boolean(s.replay && s.replay.busStats) && s.replay.busStats.capacity === 8 &&
    s.replay.busStats.dropped === s.replay.busStats.seq - s.replay.busStats.capacity &&
    s.replay.busStats.oldestSeq === s.replay.busStats.seq - s.replay.busStats.capacity + 1,
    JSON.stringify(s.replay && s.replay.busStats));

  /* ---- 判据⑨：监听范围不变 ---- */
  t.check('W5-⑨：监听仍**只回环**（夹具实际绑定 127.0.0.1）且默认仍是 127.0.0.1:8787（本单未改端口口径）',
    /^127\.0\.0\.1:\d+$/.test(String(s.listen)) &&
    Boolean(s.config) && s.config.defaultHost === '127.0.0.1' && s.config.defaultPort === 8787,
    `listen=${s.listen}；默认=${s.config && s.config.defaultHost}:${s.config && s.config.defaultPort}`);

  /* ---- 追加（裁定「选项 A」）：CORS ---- */
  const c = s.cors || {};
  t.check('CORS①：回环绑定 + `Origin: null`（双击 index.html 的 file://）⇒ 回 `Access-Control-Allow-Origin: null`',
    Boolean(c.nullOrigin) && c.nullOrigin.acao === 'null' && c.nullOrigin.status === 200,
    `acao=${c.nullOrigin && c.nullOrigin.acao} status=${c.nullOrigin && c.nullOrigin.status}`);
  t.check('CORS②：回环源 `http://127.0.0.1:<实际端口>` 与 `http://localhost:<实际端口>` ⇒ 回显该源（端口取**实际监听端口**，不是写死 8787）',
    Boolean(c.loopbackOrigin) && c.loopbackOrigin.acao === `http://127.0.0.1:${w5Port}` &&
    c.localhostOrigin.acao === `http://localhost:${w5Port}` &&
    Boolean(c.status) && !c.status.origins.includes('http://127.0.0.1:8787'),
    `127.0.0.1 ⇒ ${c.loopbackOrigin && c.loopbackOrigin.acao}；localhost ⇒ ${c.localhostOrigin && c.localhostOrigin.acao}；白名单=${JSON.stringify(c.status && c.status.origins)}`);
  t.check('CORS③：非白名单源（`http://evil.example`、**同主机异端口**）⇒ **不回**任何 `Access-Control-Allow-Origin`；`Origin` 缺失（同源/curl）行为不变',
    Boolean(c.evilOrigin) && c.evilOrigin.acao === null && c.otherPort && c.otherPort.acao === null &&
    c.noOrigin && c.noOrigin.acao === null && c.noOrigin.status === 200,
    `evil=${c.evilOrigin && c.evilOrigin.acao}；异端口=${c.otherPort && c.otherPort.acao}；无 Origin=${c.noOrigin && c.noOrigin.acao}`);
  t.check('CORS⑤：预检 ⇒ 204 + 允许方法/允许头/Max-Age 正确，且**绝不**回 `Access-Control-Allow-Credentials`',
    Boolean(c.preflightNull) && c.preflightNull.status === 204 &&
    c.preflightNull.acao === 'null' && c.preflightNull.acam === 'GET, POST, OPTIONS' &&
    c.preflightNull.acah === 'Content-Type, Authorization' && c.preflightNull.maxAge === '600' &&
    c.preflightNull.acac === null && c.nullOrigin.acac === null,
    JSON.stringify(c.preflightNull && {
      status: c.preflightNull.status, acao: c.preflightNull.acao, methods: c.preflightNull.acam,
      headers: c.preflightNull.acah, maxAge: c.preflightNull.maxAge, credentials: c.preflightNull.acac
    }));
  t.check('CORS：非白名单源的预检 ⇒ 403 且**一个 CORS 头都不回**；未注册路径的 OPTIONS 仍走既有 404/405 口径',
    Boolean(c.preflightEvil) && c.preflightEvil.status === 403 && c.preflightEvil.acao === null &&
    c.preflightUnknown && c.preflightUnknown.status === 404 &&
    c.optionsNoOrigin && c.optionsNoOrigin.status === 405,
    `evil 预检=${c.preflightEvil && c.preflightEvil.status}/acao=${c.preflightEvil && c.preflightEvil.acao}；` +
    `未注册路径 OPTIONS=${c.preflightUnknown && c.preflightUnknown.status}；无 Origin 的 OPTIONS=${c.optionsNoOrigin && c.optionsNoOrigin.status}`);

  /* ---- 追加：非回环绑定 ⇒ 任何源都无 CORS 头（另起一个夹具进程，监听地址进程内改不了） ---- */
  const w5PortB = await harness.allocPort();
  const w5DataB = path.join(w5Tmp, 'data-nonloop');
  const w5ResultB = path.join(w5Tmp, 'nonloop-result.json');
  const runNB = w5Spawn(fNonLoop, 'fixture-nonloopback', {
    DSH_W5_PORT: String(w5PortB), DSH_W5_DATA: w5DataB,
    DSH_W5_DB: path.join(w5DataB, 'board.db'), DSH_W5_RESULT: w5ResultB
  });
  const nbWatchdog = setTimeout(() => { try { runNB.proc.kill(); } catch { /* 已退出 */ } }, 40000);
  const nbExit = await runNB.waitDone(40000);
  clearTimeout(nbWatchdog);
  const N = w5Read(w5ResultB);
  if (!t.requires('W5 夹具②（非回环绑定）能取到结果文件', Boolean(N), runNB.log().slice(-400) || '无日志')) {
    t.info('W5：夹具②未产出结果，CORS④ 断言按失败处理（不许把"跑不了"当通过）');
  }
  const n = N || {};
  t.check('CORS④：**非回环绑定**（0.0.0.0）⇒ 任何源都无 CORS 头（含 `null`）、预检 403；静态首页仍可托管（守 NFR-25/AC-09）',
    /^0\.0\.0\.0:/.test(String(n.listen)) && n.corsStatus && n.corsStatus.loopback === false &&
    n.nullOrigin && n.nullOrigin.acao === null && n.loopbackOrigin && n.loopbackOrigin.acao === null &&
    n.evilOrigin && n.evilOrigin.acao === null && n.preflightNull && n.preflightNull.acao === null &&
    n.preflightNull.status === 403 && n.siteRoot && n.siteRoot.status === 200 &&
    Boolean(nbExit) && nbExit.code === 0,
    `listen=${n.listen} loopback=${n.corsStatus && n.corsStatus.loopback}；null源 acao=${n.nullOrigin && n.nullOrigin.acao}；` +
    `预检=${n.preflightNull && n.preflightNull.status}/acao=${n.preflightNull && n.preflightNull.acao}；exit=${JSON.stringify(nbExit)}`);

  /* ---- 追加（裁定「选项 A」）：静态托管（白名单式 + 路径穿越） ---- */
  const idxText = fs.readFileSync(path.join(env.paths.root, 'index.html'), 'utf8');
  t.check('静态⑥：`GET /`（与 `/index.html`）返回**仓库根 index.html 本体**——内容与磁盘文件逐字节相等，不是只看状态码；并带 `Cache-Control: no-store`',
    Boolean(s.site && s.site.root) && s.site.root.status === 200 && s.site.root.text === idxText &&
    /text\/html/.test(String(s.site.root.contentType)) && s.site.root.cacheControl === 'no-store' &&
    s.site.indexHtml.text === idxText,
    `status=${s.site && s.site.root && s.site.root.status} 内容相等=${Boolean(s.site && s.site.root && s.site.root.text === idxText)} ` +
    `长度=${s.site && s.site.root && s.site.root.text.length}/${idxText.length} cache=${s.site && s.site.root && s.site.root.cacheControl}`);
  t.check('静态⑦：`GET /src/**` 能取到前端真实文件并按扩展名给正确 `Content-Type`（.js 含 javascript / .css / .png）',
    Boolean(s.site) && s.site.config.status === 200 && /javascript/.test(String(s.site.config.contentType)) &&
    s.site.js.status === 200 && /javascript/.test(String(s.site.js.contentType)) &&
    /text\/css/.test(String(s.site.css.contentType)) &&
    /image\/png/.test(String(s.site.png.contentType)) && s.site.png.len > 1000 &&
    s.site.config.text.includes('window.BoardConfig'),
    `board.config.js: ${s.site && s.site.config && s.site.config.status}/${s.site && s.site.config && s.site.config.contentType}；` +
    `main.js: ${s.site && s.site.js && s.site.js.status}/${s.site && s.site.js && s.site.js.contentType}；` +
    `global.css: ${s.site && s.site.css && s.site.css.contentType}；png: ${s.site && s.site.png && s.site.png.len}B`);
  /* ---- W7-C：`/favicon.ico` ⇒ 204（服务端托管是首选入口，浏览器会自动请求它） ---- */
  const fav = (s.site && s.site.favicon) || {};
  t.check('静态/W7-C①：`GET /favicon.ico` ⇒ **204 No Content**、**body 为空**、`Content-Length: 0`、`Cache-Control: no-store`（浏览器自动请求不留 network error）',
    fav.status === 204 && fav.len === 0 && fav.text === '' &&
    String(fav.contentLength) === '0' && fav.cacheControl === 'no-store',
    `status=${fav.status} body=${fav.len}B content-length=${JSON.stringify(fav.contentLength)} cache=${JSON.stringify(fav.cacheControl)} content-type=${JSON.stringify(fav.contentType)}`);
  t.check('静态/W7-C② 正对照：新增 favicon 分支**没有**把静态口顺手关掉 —— `GET /` 仍 200 且内容仍是 `index.html` 本体、`GET /src/main.js` 仍 200/javascript、`GET /src/nope.js` 仍 404',
    Boolean(s.site) && s.site.root.status === 200 && s.site.root.text === idxText &&
    s.site.js.status === 200 && /javascript/.test(String(s.site.js.contentType)) &&
    Boolean(s.site.denied && s.site.denied['/src/nope.js']) && s.site.denied['/src/nope.js'].status === 404,
    `首页=${s.site && s.site.root && s.site.root.status}（内容相等=${Boolean(s.site && s.site.root && s.site.root.text === idxText)}）；` +
    `main.js=${s.site && s.site.js && s.site.js.status}/${s.site && s.site.js && s.site.js.contentType}；` +
    `nope.js=${s.site && s.site.denied && s.site.denied['/src/nope.js'] && s.site.denied['/src/nope.js'].status}`);
  t.check('静态/W7-C③：favicon **在静态兜底层**处理，不是新注册一条路由 —— 路由清单仍 21 条（冻结基线随 `T-20261002-08` 的 `POST /notice` 由 20 → 21，**favicon 一条都没加**）；且它**不进白名单**（`resolvePath` 仍拒），而静态层计数 `served.favicon` 确实 +1（被 204 分支接住、没落 404）',
    (s.site && s.site.routesCountAfterFavicon) === 21 &&
    (s.site && s.site.faviconNotWhitelisted && s.site.faviconNotWhitelisted.ok === false) &&
    (s.site && s.site.faviconServed && s.site.faviconServed.favicon === 1),
    `路由条数=${s.site && s.site.routesCountAfterFavicon}（冻结基线 21）；resolvePath('/favicon.ico')=${JSON.stringify(s.site && s.site.faviconNotWhitelisted)}；` +
    `served=${JSON.stringify(s.site && s.site.faviconServed)}`);

  t.check('静态⑧：白名单外路径（server / tests / tools / .git / data / 项目记录 / 需求文档 / 未知路径）一律 404＋JSON 形状，且响应体**不含**被禁文件内容（按真实文件的 40 字符指纹逐条比对）',
    (() => {
      const d = (s.site && s.site.denied) || {};
      /* 指纹取自**磁盘上的真实文件**（不是手写字面量）：这样"禁文件内容没被回"是硬判据，
         也不会被 404 响应体里回显的**路径**误判（上一版用 'mock-upper' 当特征串就踩了这个坑）。 */
      const targets = ['server/index.js', 'server/http/router.js', 'tests/README.md',
        'tools/mock-upper/mock-upper.js', '.git/config', '项目记录/工作日志.md'];
      const fingerprints = targets.map(rel => {
        try {
          const text = fs.readFileSync(path.join(env.paths.root, rel), 'utf8').replace(/\s+/g, '');
          return { rel, marker: text.slice(24, 64) };
        } catch { return null; }
      }).filter(x => x && x.marker.length === 40);
      const bodies = Object.values(d).map(v => String(v.text || '').replace(/\s+/g, ''));
      const all404Json = Object.keys(d).length >= 14 &&
        Object.values(d).every(v => v.status === 404 && /application\/json/.test(String(v.contentType)));
      const noLeak = fingerprints.length >= 4 &&
        fingerprints.every(f => bodies.every(b => !b.includes(f.marker)));
      const jsonShape = Boolean(d['/no-such-endpoint']) && (() => {
        try { return JSON.parse(d['/no-such-endpoint'].text).err.code === 'NOT_FOUND'; } catch { return false; }
      })();
      const dbMagic = Boolean(d['/data/dev/board.db']) &&
        !String(d['/data/dev/board.db'].text).includes('SQLite format 3');
      return all404Json && noLeak && jsonShape && dbMagic;
    })(),
    `受访 ${Object.keys((s.site && s.site.denied) || {}).length} 条路径（全部 404+JSON）；` +
    `指纹比对条数=${['server/index.js', 'server/http/router.js', 'tests/README.md', 'tools/mock-upper/mock-upper.js', '.git/config', '项目记录/工作日志.md'].length}；` +
    `db 魔数未泄露=${!/SQLite format 3/.test(String((s.site && s.site.denied && s.site.denied['/data/dev/board.db'] || {}).text || ''))}`);
  t.check('静态⑧b：**路径穿越**（`/src/../server/index.js`、`%2e%2e%2f`、`%2E%2E`、绝对路径、反斜杠、双重编码、`%00`）一律 404 且绝不返回文件内容',
    (() => {
      const d = (s.site && s.site.denied) || {};
      const fetchCases = ['/src/../server/index.js', '/src/%2e%2e%2fserver/index.js', '/src/%2E%2E/server/index.js',
        '/%2e%2e%2fserver/index.js', '/src/config/../../../server/index.js'];
      const fetchOk = fetchCases.every(p => d[p] && d[p].status === 404 &&
        !String(d[p].text).includes('createRouter') && !String(d[p].text).includes('启动自检'));
      const raw = (s.raw) || {};
      const rawKeys = Object.keys(raw);
      const rawOk = rawKeys.length === 6 && rawKeys.every(k =>
        / 404 /.test(String(raw[k].statusLine)) && raw[k].bodyHasIndexJs === false);
      return fetchOk && rawOk;
    })(),
    `fetch 形态穿越=${(() => {
      const d = (s.site && s.site.denied) || {};
      return ['/src/../server/index.js', '/src/%2e%2e%2fserver/index.js', '/src/%2E%2E/server/index.js',
        '/%2e%2e%2fserver/index.js', '/src/config/../../../server/index.js']
        .map(p => `${p}=${d[p] && d[p].status}`).join(' ');
    })()}；裸 socket 形态=${Object.keys(s.raw || {}).map(k => `${k}=${String(s.raw[k].statusLine).split(' ')[1]}`).join(' ')}`);

  /* ============ 三、F1～F8 修复回归（独立审查 R-2026-09-28-01） ============ */

  /* F1：客户端游标**领先服务端** ⇒ 必须回 hello 且**重置投递下界**（旧实现的静默黑洞） */
  {
    /* 用一条**新总线**（上面那条已按"close() 语义"关掉了，不能拿来发事件） */
    const busAhead = createEventBus({ now: busClock.source(), capacity: 8 });
    for (let i = 0; i < 3; i++) busAhead.publish(SSE_KIND.FRAME, { i });
    const seqNowBus = busAhead.seq();
    const aheadSub = busAhead.subscribe(() => { /* 只验模式 */ }, { since: seqNowBus + 7 });
    const aheadGot = [];
    const aheadSub2 = busAhead.subscribe(evt => aheadGot.push(evt.seq), { since: seqNowBus + 999 });
    const aheadEvt = busAhead.publish(SSE_KIND.LINK, { online: true });
    t.check('W5-②/F1：客户端游标**领先服务端**（since > seq）⇒ 回 hello 且**投递下界重置为当前 seq**（旧实现：无 hello、此后新事件全被 `seq <= since` 滤掉＝静默黑洞）',
      aheadSub.mode === 'hello' && aheadSub.cursorAhead === true && aheadSub.since === seqNowBus &&
      aheadSub2.mode === 'hello' && aheadSub2.cursorAhead === true && aheadSub2.since === seqNowBus &&
      Boolean(aheadEvt) && aheadEvt.seq === seqNowBus + 1 && aheadGot.join(',') === String(aheadEvt.seq) &&
      busAhead.unsubscribe(aheadSub) === true && busAhead.unsubscribe(aheadSub2) === true &&
      busAhead.size() === 0 && busAhead.stats().buffered === 4,
      `seq=${seqNowBus}（已发 3 条）；since=${seqNowBus + 7} ⇒ mode=${aheadSub.mode}/cursorAhead=${aheadSub.cursorAhead}/subSince=${aheadSub.since}；` +
      `随后新事件 seq=${aheadEvt && aheadEvt.seq} 收到=[${aheadGot.join(',')}]；退订后订阅者=${busAhead.size()}`);
  }
  t.check('W5-②/F1：真 HTTP 上「游标领先」也不是黑洞（`?since=seq+k`，k=1/7/999 ⇒ 收到 hello **且随后新帧事件可达**）',
    [1, 7, 999].every(k => {
      const pr = s.cursorAhead && s.cursorAhead.probes ? s.cursorAhead.probes[String(k)] : null;
      if (!pr) return false;
      const ev = pr.events || [];
      return pr.status === 200 && ev.length >= 2 && ev[0].event === 'hello' && ev[0].data && ev[0].data.snapshot &&
        ev.slice(1).some(e => e.event === 'frame' && e.id > ev[0].id);
    }),
    [1, 7, 999].map(k => {
      const pr = (s.cursorAhead && s.cursorAhead.probes && s.cursorAhead.probes[String(k)]) || {};
      return `k=${k}: [${(pr.events || []).map(e => e.id + ':' + e.event).join(',')}]`;
    }).join('；') + `（服务端 seq=${s.cursorAhead && s.cursorAhead.cursorNow}）`);

  /* F2：停机窗口内的**在途 keep-alive 请求**不得被误伤，且 stop() 不得被它拖住 */
  t.check('W5-⑥/F2：停机窗口内**在途 keep-alive 请求**不被误伤（200 + outcome=stored + 采样表 +1 行）且 `stop()` ≤ 1000 ms（旧实现只回收一次空闲连接 ⇒ 被拖到 ~6.35 s）',
    Boolean(cl.inflight) && /200 OK/.test(String(cl.inflight.responseStatusLine)) &&
    cl.inflight.responseOutcome === 'stored' &&
    typeof cl.inflight.rowsAfter === 'number' && cl.inflight.rowsAfter === cl.inflight.rowsBefore + 1 &&
    cl.stopMs <= 1000,
    `响应=${cl.inflight && cl.inflight.responseStatusLine}／outcome=${cl.inflight && cl.inflight.responseOutcome}；` +
    `采样表 ${cl.inflight && cl.inflight.rowsBefore}→${cl.inflight && cl.inflight.rowsAfter}；stopMs=${cl.stopMs}；` +
    `在途连接关闭于 stop+${cl.inflight && cl.inflight.closedAfterStop} ms`);

  /* F3：如实表述 —— W5-②（E45）接线后，**六类**全部来自真实写入点（不再有"夹具直调"那一类） */
  const seenKinds = [...new Set([].concat(evts(s.frames && s.frames.stream), evts(s.link), evts(s.other && s.other.stream),
    evts(s.other && s.other.warning && s.other.warning.stream)).map(e => e.event))];
  t.check('W5/F3：**五类来自真实写入点**（frame←1 s 采样落库 / link←linkState / task←派工落库 / standard←addVersion 成功路径 / upload←上报失败留存）在真 HTTP 连接上全部实测可见',
    ['frame', 'link', 'task', 'standard', 'upload'].every(k => seenKinds.includes(k)),
    `实收种类=${seenKinds.join(',')}（各类的写入点证据见上面 5 条断言）`);
  t.check('W5/F3：`warning` 也来自**真实写入点**（`ingest` 的 1 s 采样落库 → `onSampled` → `judge.evaluate(input,{bus})`）；段⑦e 夹具**没有任何** `judge.evaluate` 直调，事件只可能来自生产链路',
    seenKinds.includes('warning') && warnEvents.length === 3 && Boolean(harmEv) && Boolean(errEv) && Boolean(halfEv),
    `warning 事件在连接上可见=${seenKinds.includes('warning')}（段⑦e 共 ${warnEvents.length} 条：同态临近 / 超范围 / 半套标准各 1 条）`);

  /* F4：realpath 复核（root 之内指向 root 之外的 junction ⇒ 拒）＋ 普通文件不误伤
     F9：realpath 的**上界**必须是"被托管的那一层"（资源 ⇒ `<root>\src`，首页 ⇒ 恰好 index.html） */
  const rp = s.realpathProbe || {};
  t.check('静态/F4：静态托管对**普通文件**仍正常（realpath 复核没有误伤正常路径）',
    Boolean(rp.normalFile) && rp.normalFile.status === 200 && rp.normalFile.hasOk === true,
    JSON.stringify(rp.normalFile));
  if (rp.junctionCreated) {
    t.check('静态/F4：root 之内指向 root 之外的 **junction（目录联接）** ⇒ 404 且**不泄露**被指向文件的内容（realpath 复核可达、可被变异证伪）',
      Boolean(rp.escapedLink) && rp.escapedLink.status === 404 && rp.escapedLink.hasSecret === false &&
      /"ok":true/.test(String(rp.resolveSaysEscape)),
      `越界联接 ⇒ ${rp.escapedLink && rp.escapedLink.status}／含外部标记=${rp.escapedLink && rp.escapedLink.hasSecret}；` +
      `解析层认为路径合法（${rp.resolveSaysEscape}）⇒ 拦截确实发生在 realpath 复核`);
    t.check('静态/F9：**仓库内** junction（`src` 之内 → 根内但 `src` 之外，等价于审查实测的 `src\\x -> tests`）⇒ 404 且不泄露（上界必须是 `<root>\\src`，不是仓库根）',
      Boolean(rp.inRepoLink) && rp.inRepoLink.status === 404 && rp.inRepoLink.hasInRepoMarker === false &&
      /"ok":true/.test(String(rp.resolveSaysInRepo)) &&
      Array.isArray(rp.reasons) && rp.reasons.filter(r => r === 'OUTSIDE_SRC_REALPATH').length >= 2,
      `根内-越 src 联接 ⇒ ${rp.inRepoLink && rp.inRepoLink.status}／含被禁标记=${rp.inRepoLink && rp.inRepoLink.hasInRepoMarker}；` +
      `解析层认为路径合法（${rp.resolveSaysInRepo}）；拒收原因=${JSON.stringify(rp.reasons)}`);
    t.check('静态/F9 · 正对照：`/index.html`、`/src/main.js`、`/src/config/board.config.js` 仍 200 且与磁盘内容一致（不是把静态口一起关了）',
      Boolean(s.site && s.site.root) && s.site.root.status === 200 && s.site.root.text === idxText &&
      s.site.js.status === 200 && s.site.config.status === 200 && s.site.config.text.includes('window.BoardConfig') &&
      rp.normalFile.status === 200,
      `index ${s.site && s.site.root && s.site.root.status}（内容相等=${Boolean(s.site && s.site.root && s.site.root.text === idxText)}）；` +
      `main.js ${s.site && s.site.js && s.site.js.status}；board.config.js ${s.site && s.site.config && s.site.config.status}`);
    t.check('静态/F9 · 清理安全：junction 用 `rmdir` 拆掉后**目标目录仍在**（禁止 `fs.rmSync(recursive)` —— 那可能顺链接删到目标）',
      Boolean(rp.cleanup) && rp.cleanup.linkOutGone === true && rp.cleanup.linkInGone === true &&
      rp.cleanup.outsideStillThere === true && rp.cleanup.inRepoStillThere === true,
      JSON.stringify(rp.cleanup));
  } else {
    t.skip('静态/F4+F9：越界/根内 junction ⇒ 404 且不泄露（本机不能建链接：EPERM）',
      String(rp.note || '未做实验 —— realpath 防护为**代码级**，此路未做实验'));
  }

  /* F10：领先游标留痕必须打**客户端原始报数**（`sub.since` 已被改成投递下界，不能用它） */
  t.check('W5-②/F10：`cursorAhead` 日志里带**客户端原始报数**（`reportedSince` ＝ 请求里报的那个数）＋ 服务端当前 `seq` ＋ 改写后的 `subSince` —— 领先幅度可读',
    (() => {
      const lines = (s.cursorAhead && s.cursorAhead.logLines) || [];
      const reported = lines.map(l => (/"reportedSince":(\d+)/.exec(l) || [])[1]).filter(Boolean).map(Number);
      const wanted = [1, 7, 999].map(k => (s.cursorAhead && s.cursorAhead.cursorNow) + k);
      return lines.length >= 3 && wanted.every(v => reported.includes(v)) &&
        lines.every(l => /"seq":\d+/.test(l) && /"subSince":\d+/.test(l)) &&
        /游标领先/.test(lines[0]);
    })(),
    ((s.cursorAhead && s.cursorAhead.logLines) || []).map(l => l.replace(/^\[[^\]]+\] /, '')).join(' ｜ ').slice(0, 300));

  /* F5：新文件的换行/BOM 口径（仓库既有 73/76 为 CRLF-only） */
  t.check('文件卫生/F5：本单 4 个新文件统一 **CRLF 且无 BOM**（与仓库既有换行口径一致；BOM 仍为 false）',
    ['server/services/eventBus.js', 'server/services/stateSnapshot.js', 'server/http/cors.js', 'server/http/site.js']
      .every(f => {
        const b = fs.readFileSync(path.join(env.paths.root, f));
        if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return false;
        const txt = b.toString('utf8');
        return txt.includes('\r\n') && !/(^|[^\r])\n/.test(txt);
      }),
    '逐个读字节：4 个新文件均含 CRLF、无孤立 LF、无 BOM');

  /* F6：未注册路径**一个 CORS 头都不挂**（与"非白名单源一个头都不回"口径自洽） */
  t.check('CORS/F6：未注册路径**不挂任何 CORS 头**（`GET /no-such-path` + `Origin: null` ⇒ 404 且无 `Access-Control-Allow-Origin`），与"非白名单源一个头都不回"口径自洽',
    Boolean(c.getUnknownWithOrigin) && c.getUnknownWithOrigin.status === 404 && c.getUnknownWithOrigin.acao === null &&
    Boolean(c.preflightUnknown) && c.preflightUnknown.status === 404 && c.preflightUnknown.acao === null,
    `GET 未知路径：${c.getUnknownWithOrigin && c.getUnknownWithOrigin.status}/acao=${c.getUnknownWithOrigin && c.getUnknownWithOrigin.acao}；` +
    `OPTIONS 未知路径：${c.preflightUnknown && c.preflightUnknown.status}/acao=${c.preflightUnknown && c.preflightUnknown.acao}`);

  /* F7：规范化拼写口径（同一文件不因大小写/尾随斜杠给出两种判定） */
  t.check('静态/F7：**规范化拼写**口径自洽——`/index.HTML`≡`/index.html`（同 body 哈希）／`/index.html/`、`/src/main.js/` 一律 404／`/src/MAIN.JS`≡`/src/main.js`（本机 NTFS 不区分大小写）；`//src/main.js` **不是**首页（落到 404）',
    (() => {
      const C = s.canonical || {};
      const st = p => (C[p] || {}).status;
      const h = p => (C[p] || {}).bodyHash;
      return st('/index.html') === 200 && st('/index.HTML') === 200 && Boolean(h('/index.html')) &&
        h('/index.html') === h('/index.HTML') &&
        st('/index.html/') === 404 && st('/src/main.js/') === 404 &&
        st('/src/main.js') === 200 && st('/src/MAIN.JS') === 200 && h('/src/main.js') === h('/src/MAIN.JS') &&
        st('/src//main.js') === 404 &&
        h('//index.html') === h('/index.html') && h('/./index.html') === h('/index.html') &&
        st('//src/main.js') === 404 && h('//src/main.js') !== h('/index.html');
    })(),
    Object.keys(s.canonical || {}).map(p => `${p}=${s.canonical[p].status}${s.canonical[p].bodyHash ? '/' + s.canonical[p].bodyHash : ''}`).join(' ') +
    '（F11 更正成因：`//index.html` 之所以落回首页，是因为 `//x` 被当作**协议相对 URL** —— ' +
    '`new URL("//index.html","http://127.0.0.1")` 解析为 host=`index.html`、path=`/`，服务端收到的 pathname 就是 `/`；' +
    '`/./index.html` 才是"路径归一"（去掉 `.` 段）。两者都不是服务端给出两种判定；' +
    '`//src/main.js` 同理会变成 path=`/main.js` ⇒ 未注册路径 ⇒ 404，可作区分性对照）');

  /* F8：心跳条数**确定性**判据（注入定时器）＋ 关闭时 clearInterval 的确定性证据 */
  {
    const { createRouter: createRouterForHeartbeat } = require('../server/http/router');
    const hv = { ticks: [], cleared: [], written: [] };
    const hbClock = createClock({ mode: 'fixed', at: '2026-09-19T10:00:00' });
    const routerH = createRouterForHeartbeat({
      heartbeatMs: 100,
      now: hbClock.source(),
      setIntervalImpl: (fn, ms) => { const t = { fn, ms }; hv.ticks.push(t); return t; },
      clearIntervalImpl: t => { hv.cleared.push(t); }
    });
    const busH = createEventBus({ now: hbClock.source(), capacity: 8 });
    routerH.mountSSE({ bus: busH, snapshot: () => ({ probe: true }) });
    const resH = {
      headersSent: false, writableEnded: false, destroyed: false, socket: null,
      writeHead() { this.headersSent = true; }, setHeader() { /* 头内容不是本条判据 */ },
      write(s) { hv.written.push(String(s)); return true; },
      end() { this.writableEnded = true; },
      on() { /* 不模拟客户端断开 */ }
    };
    routerH.events({ url: '/events', method: 'GET', headers: {} }, resH);
    for (let i = 0; i < 5; i++) hv.ticks[0].fn();          // 手动驱动 5 个周期
    const pingCount = (hv.written.join('').match(/: ping /g) || []).length;
    const streamsBefore = routerH.streamCount();
    const closedN = routerH.closeAllStreams();
    t.check('W5-⑤/F8：心跳定时器**可注入** ⇒ 条数完全确定（驱动 k 次恰得 k 条 `: ping`，时间戳＝注入时钟），且 `closeAllStreams()` 真的调了 `clearInterval`（定时器清零的确定性证据）',
      hv.ticks.length === 1 && hv.ticks[0].ms === 100 && pingCount === 5 &&
      hv.written.join('').includes(': ping ' + hbClock.now().toISOString()) &&
      streamsBefore === 1 && closedN === 1 && hv.cleared.length === 1 && hv.cleared[0] === hv.ticks[0] &&
      resH.writableEnded === true && routerH.streamCount() === 0,
      `注册定时器 ${hv.ticks.length} 个（周期 ${hv.ticks[0] && hv.ticks[0].ms} ms）；驱动 5 次 ⇒ ping ${pingCount} 条；` +
      `closeAllStreams 清掉 ${hv.cleared.length} 个定时器；在途 ${streamsBefore}→${routerH.streamCount()}`);
  }

  try { harness.removeLinkSafe(w5Tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  /* 只删本节点名的**夹具文件**，不删整个 tests\._verify\w5sse\：
     该目录是同座位复核/定点变异的工作区（整目录 rm 会把别人的临时产物一并清掉）。 */
  for (const f of [fSse, fNonLoop]) { try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ } }
}

/* ---------------- 四之③ W7-A-3 DoD：mock-upper（真进程）→ 服务端 → mock-mes（真进程） ----------------
   为什么这样搭：DoD 要证明的是**三段真链路**接得上，而不是"三个模块各自单测过了"：
     · 上游：`tools/mock-upper/mock-upper.js` 作为**独立进程** `--once --push` 打服务端 `/ifd/frame`；
     · 中段：本仓真服务（`server/index.js` 的 `start()`，真 HTTP + 真 SQLite + 真采样落库）；
     · 下游：`tools/mock-mes/mock-mes.js` 作为**独立进程**收 IF-B 上报，并用自己的 `/log` 出证。
   ⚠ 一处**口径差异**必须写明（不许含糊过去）：`server/index.js` 的 `mountUpload(router, {db,logger,now,bus})`
     没有把 `config` 传下去，而 `board.config.js` 的 `mes.baseUrl` 是空串（Q-23 未答）且**不在本轮可改文件内** ——
     故"报告腿"用**同一套路由模块**（`createRouter` + 真实 `mountUpload`）在夹具内二次挂载、只把
     `mes.baseUrl` 注入成 mock-mes 的地址（这是 `mountUpload` 既有的注入出口）。下游仍是真的：
     真 HTTP POST、真 `upload_log` 落库、mock-mes 真收到并留痕。
   六条判据（E22/DoD）：①上游真进程推送 ⇒ 服务端落库一行（字段自洽）
                        ②报告组装 13 字段齐、首发打到**死端口** ⇒ 真失败入队（待补传 1 条）
                        ③注入时钟推进 **5 分钟** ⇒ 一次自动重发都没有（尝试数/日志行数/待补传/mock-mes 计数全不动）
                        ④人工 `POST /upload/retry` ⇒ 真发送成功、mock-mes 真收到 1 条、日志转"成功"、待补传归零
                        ⑤再点一次重报 ⇒ 幂等（没有可发条目、mock-mes 计数不涨）
                        ⑥全程 **零未捕获异常/零 console.error**（把"跑通了"与"带着错误跑通"分开） */
const W7_DOD_FIXTURE = String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
process.env.DSH_ENV = 'test';
const entry = require(path.join(ROOT, 'server', 'index.js'));
const { createRouter } = require(path.join(ROOT, 'server', 'http', 'router.js'));
const { mountUpload } = require(path.join(ROOT, 'server', 'http', 'routes', 'upload.js'));
const { createUploadReporter } = require(path.join(ROOT, 'server', 'services', 'uploadReporter.js'));
const boardConfig = require(path.join(ROOT, 'src', 'config', 'board.config.js'));

const OUT = { errors: [], consoleErrors: [], children: [] };
const SAVE = () => fs.writeFileSync(process.env.DSH_W7_RESULT, JSON.stringify(OUT, null, 1), 'utf8');
process.on('uncaughtException', e => { OUT.errors.push('uncaughtException: ' + String((e && e.stack) || e)); });
process.on('unhandledRejection', e => { OUT.errors.push('unhandledRejection: ' + String((e && e.stack) || e)); });
const origErr = console.error.bind(console);
console.error = function () {
  const line = Array.prototype.map.call(arguments, String).join(' ').slice(0, 300);
  OUT.consoleErrors.push(line);
  return origErr.apply(null, arguments);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MOCK_UPPER = path.join(ROOT, 'tools', 'mock-upper', 'mock-upper.js');
const MOCK_MES = path.join(ROOT, 'tools', 'mock-mes', 'mock-mes.js');
const ORDER = 'MES20260918001';        /* mock-upper 报文里写死的工单号（与 tools-check 的契约一致） */

function spawnTool(script, args, name) {
  const logFile = path.join(process.env.DSH_W7_TMP, name + '.log');
  const fd = fs.openSync(logFile, 'a');
  const proc = spawn(process.execPath, [script].concat(args), {
    cwd: ROOT, env: Object.assign({}, process.env, { DSH_ENV: 'test' }),
    windowsHide: true, stdio: ['ignore', fd, fd]
  });
  let settled = null;
  proc.on('exit', (code, signal) => { settled = { code, signal }; });
  OUT.children.push({ name, argv: [path.basename(script)].concat(args) });
  return {
    proc,
    log: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
    exitInfo: () => settled,
    async waitDone(ms) {
      const until = Date.now() + ms;
      while (!settled && Date.now() < until) await sleep(100);
      try { fs.closeSync(fd); } catch { /* 已关 */ }
      return settled;
    },
    kill() { try { fs.closeSync(fd); } catch { /* 已关 */ } try { proc.kill(); } catch { /* 已退出 */ } }
  };
}

(async () => {
  const port = Number(process.env.DSH_W7_PORT);
  const mesPort = Number(process.env.DSH_W7_MES_PORT);
  const retryPort = Number(process.env.DSH_W7_RETRY_PORT);
  const base = 'http://127.0.0.1:' + port;

  /* 注入时钟（ADR-0003 D17）：DoD 的"推进 5 分钟看有没有偷偷重发"必须能确定性推进 */
  let fixedMs = Date.parse('2026-09-19T10:00:00');
  const clock = {
    now: () => new Date(fixedMs),
    source: () => () => new Date(fixedMs),
    advanceMs: ms => { fixedMs += ms; return fixedMs; }
  };

  /* ---- ① 下游先起来：mock-mes 真进程 + 清空它的接收日志 ---- */
  const mes = spawnTool(MOCK_MES, ['--port', String(mesPort)], 'mock-mes');
  OUT.mesReady = false;
  for (let i = 0; i < 80 && !OUT.mesReady; i++) {
    try { const r = await fetch('http://127.0.0.1:' + mesPort + '/health'); if (r.ok) OUT.mesReady = true; } catch (e) { /* 未就绪 */ }
    if (!OUT.mesReady) await sleep(100);
  }
  if (OUT.mesReady) await fetch('http://127.0.0.1:' + mesPort + '/log', { method: 'DELETE' });
  const mesLog = async () => {
    try { return await (await fetch('http://127.0.0.1:' + mesPort + '/log')).json(); }
    catch (e) { return { ERR: String((e && e.message) || e) }; }
  };

  /* ---- ② 中段：真服务进程内实例（真 HTTP + 真 SQLite） ---- */
  const svc = await entry.start({
    argv: ['--port', String(port), '--data-dir', process.env.DSH_W7_DATA, '--db-file', process.env.DSH_W7_DB],
    installSignalHandlers: false, logConsole: false, clock
  });
  const db = entry.state.db;
  OUT.service = { port, routes: svc.router.list(), mesBaseUrl: boardConfig.mes.baseUrl };
  /* ⚠ **同批（T-20261005-21）**：/upload/retry 现在要求"回环 ＋ 登录态"（与 /notice 同口径）
     ⇒ 本腿的真 HTTP 请求必须带会话令牌。令牌的真源＝services/auth.js（**不另造第二套**）：
     - 真源里已有凭证（本腿的数据目录是专用的 DSH_W7_DATA）⇒ 直接 login()；
     - 没有 ⇒ 走**生产同一存库口径** hashPassword() 落一行（derive 是同一真源函数），
       再 login() 取会话令牌。**不改任何期望值**：本腿判的仍是 400 BAD_JSON／200 幂等。 */
  const authSvcDoD = require(path.join(ROOT, 'server', 'services', 'auth.js'));
  const DoD_PW = 'Harness#DoD-2026';
  const DoD_USER = 'admin';
  /* ⚠ **必须用服务端自己那个 auth 实例**（server/index.js:825 把它挂在 state.auth 上）：
     会话表是**进程内存**的，另造一个实例 login() 出来的令牌**不在服务端那张表里** ⇒ 真 HTTP 打过去
     仍是 401（实测踩过）。同一进程、同一个实例 ⇒ 令牌是真的。 */
  const authDoD = entry.state.auth || authSvcDoD.createAuth({ db, now: clock.source(), silent: true, teamCode: '检验一班' });
  const loginDoD = () => authDoD.login({ password: DoD_PW, remote: '127.0.0.1' });
  let tokenDoD = '';
  {
    let r = loginDoD();
    if (!r || r.ok !== true) {
      const existDoD = db.prepare('SELECT COUNT(*) AS c FROM auth_credential').get().c;
      if (existDoD === 0) {
        const hp = authSvcDoD.hashPassword(DoD_PW);
        db.prepare('INSERT INTO auth_credential (username, algo, params, salt, hash, fail_count, is_initial, ' +
          'created_at, updated_at, changed_by, team_code) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)')
          .run(DoD_USER, hp.algo, hp.params, hp.salt, hp.hash, '2026-09-19 10:00:00', '2026-09-19 10:00:00', '同批夹具', '检验一班');
      }
      r = loginDoD();
    }
    tokenDoD = (r && r.token) || '';
  }
  const post = async (b, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tokenDoD) headers.Authorization = 'Bearer ' + tokenDoD;
    const r = await fetch(b + p, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return { status: r.status, body: j };
  };

  /* ---- ③ 派工（真路由）⇒ 报告组装需要的 task 行 ---- */
  OUT.dispatch = await post(base, '/ifa/dispatch',
    { procOrderNo: ORDER, productCode: 'P-DOD', processNo: '30', planQty: 3, equipCode: 'EQ-DOD' });

  /* ---- ④ 上游真进程：mock-upper --once --push ⇒ 服务端 /ifd/frame ---- */
  const rowsBefore = db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
  const upper = spawnTool(MOCK_UPPER, ['--once', '--equip', 'EQ-DOD', '--cycle', '160',
    '--push', base + '/ifd/frame'], 'mock-upper');
  OUT.upperExit = await upper.waitDone(20000);
  OUT.upperLog = upper.log().slice(-500);
  const rowsAfter = db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
  const fr = db.prepare('SELECT * FROM measure_rt ORDER BY id DESC LIMIT 1').get() || null;
  OUT.ingest = {
    rowsBefore, rowsAfter,
    frame: fr ? {
      equipCode: fr.equip_code, procOrderNo: fr.proc_order_no, collectTime: fr.collect_time,
      depth: fr.measure_depth, speed: fr.speed, testStatus: fr.test_status
    } : null
  };

  /* ---- ④b 端点矩阵：**正面**（每个端点一条 200）＋**逆向**（未知路径/方法不符/坏 JSON/缺字段/参数越界）
         ＋**无副作用**（被拒请求不得落库、不得发事件） ----
     为什么放在这里：服务是真的、库是真的、总线是真的 —— 逆向用例的"没留下痕迹"才有意义。 */
  const probe = async (p, opts) => {
    const r = await fetch(base + p, opts);
    let text = '';
    try { text = await r.text(); } catch (e) { text = ''; }
    let j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    return {
      status: r.status, code: (j && (j.err || j.error) && (j.err || j.error).code) || null,
      allow: r.headers.get('allow'), acao: r.headers.get('access-control-allow-origin'),
      text: text.slice(0, 100)
    };
  };
  /* ⚠ **同批（T-20261005-21）**：/upload/retry 现在要登录态 ⇒ 本助手（进程内真服务）也带令牌。
     令牌来自**服务端自己那个 auth 实例**（见上面 authDoD）—— 会话表是进程内存的，别的实例登录不算。 */
  const jsonPost = (p, body) => probe(p, {
    method: 'POST',
    headers: tokenDoD
      ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenDoD }
      : { 'Content-Type': 'application/json' },
    body: body
  });
  const rowsOf = () => db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
  const logsOf = () => db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c;
  const seqOf = async () => (await (await fetch(base + '/state')).json()).seq;
  const mSeqBefore = await seqOf();
  const mRowsBefore = rowsOf();
  const mLogsBefore = logsOf();
  OUT.matrix = {
    routes: svc.router.list(),
    positive: {
      health: await probe('/health'),
      state: await probe('/state'),
      uploadStatus: await probe('/upload/status'),
      uploadPending: await probe('/upload/pending'),
      siteRoot: await probe('/'),
      staticJs: await probe('/src/main.js')
    },
    negative: {
      unknown: await probe('/no-such-path'),
      wrongMethod: await probe('/state', { method: 'DELETE' }),
      wrongMethodPost: await jsonPost('/upload/pending', {}),
      badJsonFrame: await jsonPost('/ifd/frame', '{ 这不是 JSON'),
      missingFieldFrame: await jsonPost('/ifd/frame', { equipCode: 'EQ-DOD' }),
      badJsonDispatch: await jsonPost('/ifa/dispatch', '{ 也不是 JSON'),
      limitZero: await probe('/upload/pending?limit=0'),
      badJsonRetry: await jsonPost('/upload/retry', '{ 仍然不是 JSON')
    }
  };
  OUT.matrix.sideEffects = {
    seqBefore: mSeqBefore, seqAfter: await seqOf(),
    rowsBefore: mRowsBefore, rowsAfter: rowsOf(),
    logsBefore: mLogsBefore, logsAfter: logsOf()
  };

  /* ---- ⑤ 报告腿：同一套路由模块 + 只注入 MES 地址；首发打**死端口** ⇒ 确定性失败 ---- */
  const cfg = Object.assign({}, boardConfig, {
    dataSource: 'server',
    mes: Object.assign({}, boardConfig.mes, { baseUrl: 'http://127.0.0.1:9/mes' })
  });
  const router2 = createRouter({ getHealth: () => ({ status: 1, msg: 'dod-report-face' }), now: clock.source() });
  /* ⚠ 必须**显式传 reporter**：mountUpload 的 reporter 池按 db 缓存（resolveReporter 的 pool.byDb），
     同一个 db 第二次挂载会**复用**上一次的实例（那天服务自己挂的那个读不到 MES 地址）——
     显式注入既绕开缓存、又恰好是"给这条报告腿配上 MES 地址"的既有出口。 */
  const rep2 = createUploadReporter({ db, now: clock.source(), config: cfg, logger: null });
  const up2 = mountUpload(router2, {
    db, now: clock.source(), config: cfg, reporter: rep2, logger: null,
    /* ⚠ **同批（T-20261005-21）**：auth 现在**必填**（缺失 ⇒ 写入口 503 no_auth）——
       本腿要验的是"重报能真的发出去"，故注入与生产同一真源的那个实例。 */
    auth: authDoD
  });
  const server2 = http.createServer((req, res) => {
    Promise.resolve(router2.handle(req, res)).catch(() => { try { res.destroy(); } catch (e) { /* 已断 */ } });
  });
  await new Promise(resolve => server2.listen(retryPort, '127.0.0.1', resolve));
  const retryBase = 'http://127.0.0.1:' + retryPort;

  const built = up2.instance.buildReport({ procOrderNo: ORDER });
  OUT.report = {
    builtOk: built.ok,
    fields: built.ok ? built.fields.length : 0,
    testStatus: built.ok ? built.body.testStatus : null,
    missing: built.ok ? built.missing : null,
    collectTimeFallback: built.ok ? built.collectTimeFallback : null,
    url: up2.instance.buildUrl()
  };
  const first = await up2.instance.report({ procOrderNo: ORDER });
  OUT.report.first = {
    ok: first.ok, skipped: first.skipped === true, responseCode: first.responseCode,
    failReason: first.failReason, pendingCount: first.pendingCount, httpStatus: first.httpStatus
  };
  OUT.report.logRowsAfterFirst = db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c;
  OUT.report.firstRow = db.prepare('SELECT state, retry_count FROM upload_log ORDER BY id DESC LIMIT 1').get() || null;

  /* ---- ⑥ 时间推进 5 分钟：**任何定时器都不该因此重发**（V1.31 / C-59 / E10） ---- */
  const attemptsBefore = up2.instance.attempts();
  const logRowsBeforeWait = db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c;
  const pendingBeforeWait = up2.instance.pendingCount(true);
  clock.advanceMs(5 * 60 * 1000);
  await sleep(1500);                       /* 给 1.5 s 墙钟：有定时器的话这里就会动 */
  OUT.noAutoRetry = {
    advancedTo: new Date(fixedMs).toISOString(),
    attemptsBefore, attemptsAfter: up2.instance.attempts(),
    logRowsBefore: logRowsBeforeWait, logRowsAfter: db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c,
    pendingBefore: pendingBeforeWait, pendingAfter: up2.instance.pendingCount(true),
    mesReceived: ((await mesLog()).count === undefined ? null : (await mesLog()).count)
  };

  /* ---- ⑦ 人工一键重报（真 HTTP POST /upload/retry）：先把 MES 地址改对 ---- */
  cfg.mes.baseUrl = 'http://127.0.0.1:' + mesPort;      /* 配置是活引用（运维改地址后即可重报） */
  const r1 = await post(retryBase, '/upload/retry', {});
  const log1 = await mesLog();
  OUT.retry = {
    status: r1.status, sent: r1.body && r1.body.sent, failed: r1.body && r1.body.failed,
    requested: r1.body && r1.body.requested, remaining: r1.body && r1.body.remaining,
    mesCount: log1.count === undefined ? null : log1.count,
    mesItems: (log1.items || []).map(it => ({
      path: it.path,
      testStatus: it.payload && it.payload.testStatus,
      uploadId: it.payload && it.payload.uploadId,
      depth: it.payload && it.payload.depth
    })),
    uploadLogRows: db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c,
    lastRow: db.prepare('SELECT state, response_code, retry_count FROM upload_log ORDER BY id DESC LIMIT 1').get() || null,
    alert: r1.body && r1.body.alert
  };
  const r2 = await post(retryBase, '/upload/retry', {});   /* 再点一次：应当没有可发条目（幂等） */
  const log2 = await mesLog();
  OUT.retry2 = {
    status: r2.status, sent: r2.body && r2.body.sent, requested: r2.body && r2.body.requested,
    remaining: r2.body && r2.body.remaining, mesCount: log2.count === undefined ? null : log2.count
  };

  /* ---- ⑧ 收尾：报告面 → 服务 → 下游，逐层关掉（顺序与真实运维相反，故意的：先断"触发方"） ---- */
  await new Promise(resolve => server2.close(() => resolve()));
  OUT.stopResult = await entry.stop('w7 DoD 夹具');
  mes.kill();
  await sleep(300);
  OUT.done = true;
  SAVE();
})().catch(err => {
  OUT.error = String((err && err.stack) || err);
  SAVE();
  process.exitCode = 1;
});
`;

/* ---------------- 四之③ W7-A-3 DoD：端到端链路（真进程 mock-upper → 真服务 → 真进程 mock-mes） ---------------- */
t.section('四之③、W7-A-3 DoD：mock-upper（真进程）→ 服务端 → mock-mes（真进程）端到端');
{
  const w7Scratch = path.join(env.paths.root, 'tests', '._verify', 'w7dod');
  fs.mkdirSync(w7Scratch, { recursive: true });
  const w7Tmp = harness.makeTempDir('w7-dod');
  const w7RunTag = process.pid + '-' + Date.now().toString(36);
  const w7File = path.join(w7Scratch, 'fixture-dod-' + w7RunTag + '.js');
  fs.writeFileSync(w7File, W7_DOD_FIXTURE, 'utf8');

  const w7Port = await harness.allocPort();
  const w7MesPort = await harness.allocPort();
  const w7RetryPort = await harness.allocPort();
  const w7Data = path.join(w7Tmp, 'data-dod');
  const w7Result = path.join(w7Tmp, 'dod-result.json');
  const w7Log = path.join(w7Tmp, 'fixture-dod.log');
  const w7Fd = fs.openSync(w7Log, 'a');
  const w7Proc = spawn(process.execPath, [w7File], {
    cwd: env.paths.root,
    env: Object.assign({}, process.env, {
      DSH_ENV: 'test', DSH_W7_PORT: String(w7Port), DSH_W7_MES_PORT: String(w7MesPort),
      DSH_W7_RETRY_PORT: String(w7RetryPort), DSH_W7_DATA: w7Data,
      DSH_W7_DB: path.join(w7Data, 'board.db'), DSH_W7_TMP: w7Tmp, DSH_W7_RESULT: w7Result
    }),
    windowsHide: true,
    stdio: ['ignore', w7Fd, w7Fd]
  });
  let w7Settled = null;
  w7Proc.on('exit', (code, signal) => { w7Settled = { code, signal }; });
  const w7Watchdog = setTimeout(() => { try { w7Proc.kill(); } catch { /* 已退出 */ } }, 90000);
  const w7Until = Date.now() + 90000;
  while (!w7Settled && Date.now() < w7Until) await new Promise(r => setTimeout(r, 150));
  clearTimeout(w7Watchdog);
  try { fs.closeSync(w7Fd); } catch { /* 已关 */ }
  const w7LogText = (() => { try { return fs.readFileSync(w7Log, 'utf8'); } catch { return ''; } })();
  const D = (() => { try { return JSON.parse(fs.readFileSync(w7Result, 'utf8')); } catch { return null; } })();
  if (!t.requires('W7 DoD 夹具能取到结果文件（dod-result.json）', Boolean(D), w7LogText.slice(-500) || '无日志')) {
    t.info('W7 DoD：夹具未产出结果，本节断言按失败处理（不许把"跑不了"当通过）');
  }
  const d = D || {};
  const dUpper = (d.ingest || {});
  const dFrame = dUpper.frame || {};

  /* ---- 判据①：上游真进程 → 服务端落库 ---- */
  t.check('DoD①：`tools/mock-upper` **独立进程** `--once --push` ⇒ 服务端 `/ifd/frame` **落库一行**（字段与推送报文同源：设备号/工单号/深度量程/首帧 testStatus=0）',
    d.upperExit && d.upperExit.code === 0 && /HTTP 200/.test(String(d.upperLog || '')) &&
    dUpper.rowsAfter === dUpper.rowsBefore + 1 &&
    dFrame.equipCode === 'EQ-DOD' && dFrame.procOrderNo === 'MES20260918001' &&
    dFrame.testStatus === 0 && Number(dFrame.depth) >= 4.7 && Number(dFrame.depth) <= 5.4 &&
    Number(dFrame.speed) > 0,
    `上游退出码=${d.upperExit && d.upperExit.code}（stdout 末段=${String(d.upperLog || '').replace(/\s+/g, ' ').slice(-120)}）；` +
    `measure_rt 行数 ${dUpper.rowsBefore}→${dUpper.rowsAfter}；落库帧=${JSON.stringify(dFrame)}`);

  /* ---- 判据②：报告组装 + 首发失败入队（真 upload_log） ---- */
  t.check('DoD②：报告组装 13 字段齐、`testStatus` 取自**刚落库的那一帧**（=0，不伪造）；首发打到死端口 ⇒ 真失败、`upload_log` 落"待补传"、待补传 1 条',
    d.report && d.report.builtOk === true && d.report.fields === 13 && d.report.testStatus === 0 &&
    d.report.first && d.report.first.ok === false && d.report.first.skipped !== true &&
    d.report.first.pendingCount === 1 && d.report.logRowsAfterFirst === 1 &&
    d.report.firstRow && d.report.firstRow.state === '待补传',
    `组装的 testStatus=${d.report && d.report.testStatus}（13 字段=${d.report && d.report.fields}）；` +
    `首发 ok=${d.report && d.report.first && d.report.first.ok}／原因=${d.report && d.report.first && d.report.first.failReason}；` +
    `upload_log 行数=${d.report && d.report.logRowsAfterFirst}／末行=${JSON.stringify(d.report && d.report.firstRow)}`);

  /* ---- 判据③：时间推进 5 分钟 ⇒ 零自动重发 ---- */
  t.check('DoD③：注入时钟推进 **5 分钟** ⇒ **没有任何自动重发**（尝试次数/`upload_log` 行数/待补传条数/mock-mes 收到条数 四项全不动）',
    d.noAutoRetry && d.noAutoRetry.attemptsAfter === d.noAutoRetry.attemptsBefore &&
    d.noAutoRetry.logRowsAfter === d.noAutoRetry.logRowsBefore &&
    d.noAutoRetry.pendingAfter === d.noAutoRetry.pendingBefore && d.noAutoRetry.pendingAfter === 1 &&
    d.noAutoRetry.mesReceived === 0,
    `时钟推进到 ${d.noAutoRetry && d.noAutoRetry.advancedTo}；尝试 ${d.noAutoRetry && d.noAutoRetry.attemptsBefore}→${d.noAutoRetry && d.noAutoRetry.attemptsAfter}；` +
    `upload_log ${d.noAutoRetry && d.noAutoRetry.logRowsBefore}→${d.noAutoRetry && d.noAutoRetry.logRowsAfter}；` +
    `待补传 ${d.noAutoRetry && d.noAutoRetry.pendingBefore}→${d.noAutoRetry && d.noAutoRetry.pendingAfter}；mock-mes 收到=${d.noAutoRetry && d.noAutoRetry.mesReceived}`);

  /* ---- 判据④：人工一键重报（真 HTTP）⇒ 真发送成功 ---- */
  t.check('DoD④：人工 `POST /upload/retry`（真 HTTP）⇒ 200 + `sent=1`，**mock-mes 真进程收到 1 条**（其 `/log` 出证：路径/uploadId/testStatus 都在），`upload_log` **同一行**由"待补传"迁到"成功"、待补传归零',
    d.retry && d.retry.status === 200 && d.retry.sent === 1 && d.retry.failed === 0 &&
    d.retry.requested === 1 && d.retry.remaining === 0 && d.retry.mesCount === 1 &&
    d.retry.uploadLogRows === 1 && d.retry.lastRow && d.retry.lastRow.state === '成功' &&
    d.retry.mesItems && d.retry.mesItems.length === 1 && d.retry.mesItems[0].testStatus === 0 &&
    d.retry.mesItems[0].path === '/service/report/receiveReport' &&
    typeof d.retry.mesItems[0].uploadId === 'string' && Number(d.retry.mesItems[0].depth) >= 4.7,
    `HTTP ${d.retry && d.retry.status} requested/sent/failed/remaining=${d.retry && d.retry.requested}/${d.retry && d.retry.sent}/${d.retry && d.retry.failed}/${d.retry && d.retry.remaining}；` +
    `mock-mes /log count=${d.retry && d.retry.mesCount} items=${JSON.stringify(d.retry && d.retry.mesItems)}；` +
    `upload_log 末行=${JSON.stringify(d.retry && d.retry.lastRow)}`);

  /* ---- 判据⑤：幂等（再点一次不重复发） ---- */
  t.check('DoD⑤：**再点一次**重报 ⇒ 幂等：没有可发条目（`requested=0`/`sent=0`），mock-mes 计数**不涨**（不重复上报同一帧）',
    d.retry2 && d.retry2.status === 200 && d.retry2.sent === 0 && d.retry2.requested === 0 &&
    d.retry2.remaining === 0 && d.retry2.mesCount === 1,
    `第二次：HTTP ${d.retry2 && d.retry2.status} requested/sent/remaining=${d.retry2 && d.retry2.requested}/${d.retry2 && d.retry2.sent}/${d.retry2 && d.retry2.remaining}；mock-mes count=${d.retry2 && d.retry2.mesCount}`);

  /* ---- 判据⑥：全程零未捕获异常 / 零 console.error ---- */
  t.check('DoD⑥：整条链路**零未捕获异常、零 `console.error`**（"跑通了"与"带着错误跑通"分开记），且夹具正常退出',
    Array.isArray(d.errors) && d.errors.length === 0 &&
    Array.isArray(d.consoleErrors) && d.consoleErrors.length === 0 &&
    w7Settled && w7Settled.code === 0 && d.done === true,
    `未捕获异常=${JSON.stringify(d.errors || [])}；console.error=${JSON.stringify(d.consoleErrors || [])}；` +
    `夹具退出码=${w7Settled && w7Settled.code}${d.error ? '；夹具内异常：' + String(d.error).slice(0, 300) : ''}`);

  /* ---- 判据⑦ §1：端点矩阵（正面 / 逆向 / 无副作用 / 清单冻结） ---- */
  const mx = d.matrix || {};
  const pos = mx.positive || {};
  const neg = mx.negative || {};
  const side = mx.sideEffects || {};
  const posNames = { health: 200, state: 200, uploadStatus: 200, uploadPending: 200, siteRoot: 200, staticJs: 200 };
  t.check('§1 endpoint 矩阵①：现有端点的**正面**用例逐条 200（/health、/state、/upload/status、/upload/pending、站点首页、/src/main.js 静态件）',
    Object.keys(posNames).every(k => pos[k] && pos[k].status === posNames[k]),
    Object.keys(posNames).map(k => `${k}=${pos[k] && pos[k].status}`).join('，'));
  const negExpect = {
    unknown: [404, 'NOT_FOUND'], wrongMethod: [405, 'METHOD_NOT_ALLOWED'], wrongMethodPost: [405, 'METHOD_NOT_ALLOWED'],
    badJsonFrame: [400, 'BAD_JSON'], badJsonDispatch: [400, 'BAD_JSON'], badJsonRetry: [400, 'BAD_JSON'],
    missingFieldFrame: [400, null], limitZero: [400, 'BAD_VALUE']
  };
  const negBad = Object.keys(negExpect).filter(k => {
    const want = negExpect[k];
    const got = neg[k] || {};
    return got.status !== want[0] || (want[1] !== null && got.code !== want[1]);
  });
  t.check('§1 endpoint 矩阵②：**逆向**用例逐条落在文档口径上（未知路径 404 NOT_FOUND／方法不符 405 METHOD_NOT_ALLOWED＋Allow／坏 JSON 400 BAD_JSON／缺必填字段 400／参数越界 400 BAD_VALUE）',
    negBad.length === 0 && /GET/.test(String((neg.wrongMethod && neg.wrongMethod.allow) || '')),
    (negBad.length ? `**不一致**：${negBad.map(k => k + ' 期望 ' + JSON.stringify(negExpect[k]) + ' 实得 ' + JSON.stringify(neg[k])).join('；')}；` : '') +
    Object.keys(neg).map(k => `${k}=${neg[k] && neg[k].status}${neg[k] && neg[k].code ? '/' + neg[k].code : ''}`).join('，') +
    `；405 的 Allow=${JSON.stringify(neg.wrongMethod && neg.wrongMethod.allow)}`);
  t.check('§1 endpoint 矩阵③：被拒请求**无副作用** —— 8 条逆向用例跑完后 `measure_rt`/`upload_log` 行数与总线 `seq` **一个都没动**（不落库、不发事件）',
    side.rowsAfter === side.rowsBefore && side.logsAfter === side.logsBefore &&
    side.seqAfter === side.seqBefore,
    `measure_rt ${side.rowsBefore}→${side.rowsAfter}；upload_log ${side.logsBefore}→${side.logsAfter}；总线 seq ${side.seqBefore}→${side.seqAfter}`);
  t.check('§1 endpoint 矩阵④：路由清单与**冻结基线**逐条一致（本项目阶段一暴露的端点集合；增/删端点即红 —— 矩阵③的"无副作用"才有对象）。' +
    '基线 **21 条**：`T-20261002-08`（`FR-7.12`，P0）新增 `POST /notice` 一条，其余 20 条逐字不动',
    JSON.stringify(mx.routes) === JSON.stringify([
      'GET /auth/status', 'GET /events', 'GET /health', 'GET /ifa/status', 'GET /ifd/health', 'GET /ifd/status',
      'GET /state', 'GET /upload/last', 'GET /upload/pending', 'GET /upload/status',
      'POST /auth/change', 'POST /auth/init', 'POST /auth/login', 'POST /auth/logout',
      'POST /ifa/device', 'POST /ifa/dispatch', 'POST /ifa/material', 'POST /ifa/process',
      'POST /ifd/frame', 'POST /notice', 'POST /upload/retry'
    ]),
    `实际清单（${mx.routes ? mx.routes.length : 0} 条，冻结基线 21）=${JSON.stringify(mx.routes)}`);

  try { harness.removeLinkSafe(w7Tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(w7File, { force: true }); } catch { /* 忽略 */ }
}

/* ---------------- 五、临时区与清理 ---------------- */
t.section('五、临时区与清理');
{
  const dir = harness.makeTempDir('cleanup-probe');
  t.check('makeTempDir 落在 ._verify/tmp 之内（D16）', env.isInsideVerify(dir), path.relative(env.paths.root, dir));
  /* P3-14：唯一性探测过去**故意建两个目录且不回收** —— 每跑一次留 2 个空目录
     （评审期间从 12 累积到 18）。这里改为**建完立刻删**，并断言目录数不增长。 */
  const tmpCount = () => (fs.existsSync(env.paths.tempRoot) ? fs.readdirSync(env.paths.tempRoot).length : 0);
  const beforeCount = tmpCount();
  const u1 = harness.makeTempDir('u');
  const u2 = harness.makeTempDir('u');
  t.check('临时目录名唯一（同进程连续两次不冲突）', u1 !== u2, `${path.basename(u1)} ≠ ${path.basename(u2)}`);
  for (const d of [u1, u2]) { try { harness.removeLinkSafe(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  t.check('P3-14：唯一性探测不残留目录（本节建完即删，目录数不增长）',
    tmpCount() === beforeCount, `探测前 ${beforeCount} → 探测后 ${tmpCount()}`);
  harness.removeLinkSafe(dir, { recursive: true, force: true });

  const stale = harness.cleanup(false);
  t.check('cleanup(false) 只清过期项并返回统计',
    typeof stale.removed === 'number' && typeof stale.kept === 'number',
    `removed=${stale.removed}, kept=${stale.kept}`);

  const stray = fs.existsSync(env.paths.tempRoot)
    ? fs.readdirSync(env.paths.tempRoot).filter(n => /\.db(-wal|-shm)?$/.test(n))
    : [];
  t.check('临时区根目录无散落库文件', stray.length === 0, stray.join('、'));
  t.check('os.tmpdir 与项目临时区是两处（夹具不会误用系统临时目录做落库）',
    path.resolve(env.tmpdir) !== path.resolve(env.paths.tempRoot), env.tmpdir);

  /* P2-16：cleanup 不能只"被断言存在"，要验**行为** —— 真造一个残留目录，force 清空后必须消失。
     同时确认 run-all 的收尾真会调它（否则又是"测存在 ≠ 在用"）。 */
  const leftover = harness.makeTempDir('leftover-must-be-swept');
  fs.writeFileSync(path.join(leftover, 'junk.txt'), 'x', 'utf8');
  const swept = harness.cleanup(true);
  t.check('cleanup(true) 真能清空临时区（行为断言，不只是"函数存在"）',
    !fs.existsSync(leftover) && swept.removed === 'all',
    `残留目录仍在=${fs.existsSync(leftover)}，返回=${JSON.stringify(swept)}`);
  t.check('run-all 收尾真的调用了 cleanup（P2-16："测存在 ≠ 在用"）',
    /cleanup\(false\)/.test(fs.readFileSync(path.join(env.paths.tests, 'run-all.js'), 'utf8')),
    'run-all 全绿收尾处应调用一次 cleanup(false)');

  /* ---------------- `E90` 新不变量的门禁守护（`T-20261003-08` 丙组，2026-10-03） ----------------
     `E90`（同日座位 4，`tests\lib\harness.js`）钉了两件事：
       （i）**临时区按轮次隔离**：`env.paths.tempRoot` ＝ `env.paths.tempRootBase\run-<pid>-<启动时刻>-<4hex>`
            —— 本轮独占；任一路的 `cleanup` 物理上只删得到**自己那一轮**（旧版共用 `tests\._verify\tmp`
            ⇒ 他路的 `cleanup(true)` 会把本轮写进去的日志/临时库一并删掉，实测两次假红）。
       （ii）**`cleanup(true)` 的返回值由事实推导**：`removed ∈ all|partial|none`、`kept`/`keptDeep`
            是**回读**到的剩余条目数、`errors` 记失败原因；旧版吞掉异常后**无条件** `{removed:'all', kept:0}`
            ＝"返回值与事实无关"。不变量：`removed==='all'` ⟺ 目标目录不存在 ⟺ `kept===0 && keptDeep===0`。
     本段上面那两条旧判据只量了"残留子目录被清掉 ＋ 返回 `'all'`" —— 不变量本身、**失败注入**、
     以及 `cleanup(false)` 的清扫边界都没验。下面五条按"**返回值与事实两条都量**"的口径补齐。
     口径不冲突：补守护前实测 `342/0/2`，新三值口径下正常收尾仍是 `'all'`、`kept=0`。 */

  /* ① 轮次隔离（结构性前提） */
  const runRootE90 = env.paths.tempRoot;                 /* 本轮专属目录 */
  const baseE90 = env.paths.tempRootBase;                /* 公共根 */
  t.check('E90① 临时区按轮次隔离：本轮 `tempRoot` 是公共根下的 `run-<pid>-<启动时刻>-<4hex>` 专属子目录' +
    '（**不是**公共根本身 —— 否则任一路的 `cleanup` 都能删到别人正在用的产物）',
    Boolean(baseE90)
      && path.resolve(path.dirname(runRootE90)) === path.resolve(baseE90)
      && /^run-\d+-\d{8}T\d{6}-[0-9a-f]{4}$/.test(path.basename(runRootE90))
      && path.basename(runRootE90).startsWith(`run-${process.pid}-`)
      && path.resolve(runRootE90) !== path.resolve(baseE90),
    `tempRoot=${path.relative(env.paths.root, runRootE90)}；`
      + `tempRootBase=${baseE90 ? path.relative(env.paths.root, baseE90) : '（未定义 —— E90 的公共根口径丢了）'}`);

  /* 回读事实**本段自算**（不借 `lib/harness.js` 的私有中间量）：否则"返回值 == 事实"会退化成
     "返回值 == 返回值"的恒真式（ADR-0004 D23）。口径与 `readTempFacts`/`countEntriesDeep` 逐字同义。 */
  const e90Facts = (dir) => {
    const exists = fs.existsSync(dir);
    return { exists, entries: exists ? fs.readdirSync(dir).length : 0 };
  };
  const e90Deep = (dir) => {
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
  };

  /* `E90` 不变量的判据（**纯函数**，违规逐条指名）：`cleanup(force=true)` 的返回必须与**本段实测的事实**
     一致 —— `removed==='all'` ⟺ 目标目录不存在 ⟺ `kept===0 && keptDeep===0`，且 `kept`/`keptDeep`
     必须等于实测剩余。用纯函数是为了让下面的 D22 变异能把"无条件报 all"的返回值喂进来、当场指名。 */
  const e90Violations = (res, facts, deep) => {
    const bad = [];
    if (!res || typeof res !== 'object') return ['返回值不是对象'];
    if (res.removed === 'all' && facts.exists) {
      bad.push(`removed='all' 但目标目录**仍存在**（实测顶层剩余 ${facts.entries}）`);
    }
    if (res.removed !== 'all' && !facts.exists) {
      bad.push(`removed='${res.removed}' 但目标目录**已不存在**（实测 0 条）`);
    }
    if (res.kept !== facts.entries) bad.push(`kept=${res.kept} ≠ 实测顶层剩余 ${facts.entries}（返回值不是由事实推导）`);
    if (res.keptDeep !== deep) bad.push(`keptDeep=${res.keptDeep} ≠ 实测递归剩余 ${deep}`);
    if (res.kept === 0 && facts.exists) bad.push('kept=0 但目标目录仍存在（"清干净了"是自报的）');
    if (res.removed === 'all' && res.keptDeep !== 0) bad.push(`removed='all' 但 keptDeep=${res.keptDeep} ≠ 0（自相矛盾）`);
    return bad;
  };

  /* ② 正常收尾：**返回值与事实两条都量** */
  const normalSub = harness.makeTempDir('e90-normal-sweep');
  fs.writeFileSync(path.join(normalSub, 'junk.txt'), 'x', 'utf8');
  const normalBefore = e90Facts(runRootE90);
  const normalSwept = harness.cleanup(true);
  const normalAfter = e90Facts(runRootE90);
  const normalDeep = e90Deep(runRootE90);
  const normalBad = e90Violations(normalSwept, normalAfter, normalDeep);
  t.check('E90② 正常收尾：`cleanup(true)` 的返回值与**回读事实**逐项一致' +
    '（`removed===\'all\'` ⟺ 目录不存在 ⟺ `kept===0 && keptDeep===0` —— 两条都要，缺一条就是"调用过 rmSync"冒充事实）' +
    '，且 `errors` 为空、`target` 指向本轮目录',
    normalBad.length === 0 && normalSwept.removed === 'all' && normalAfter.exists === false
      && normalSwept.kept === 0 && normalSwept.keptDeep === 0
      && Array.isArray(normalSwept.errors) && normalSwept.errors.length === 0
      && path.resolve(normalSwept.target) === path.resolve(runRootE90)
      && !fs.existsSync(normalSub),
    `清理前回读=${JSON.stringify(normalBefore)}；返回=${JSON.stringify(normalSwept)}；`
      + `清理后回读=${JSON.stringify(normalAfter)}（深层 ${normalDeep} 条）；`
      + `不变量违规 ${normalBad.length} 条${normalBad.length ? '：' + normalBad.join('；') : ''}；`
      + `被清的子目录仍在=${fs.existsSync(normalSub)}`);

  /* ③ 注入"删不掉"：另起子进程把 `<本轮目录>\…\holder` 当 **cwd** 占住 ⇒ Windows 上递归删除必然
     `EPERM`（与 E90 现场"他路持有句柄 ⇒ 中途失败"同一机制，且完全可控、不依赖抢占时序）。
     期望：`removed !== 'all'`、`kept > 0` 且**等于实测剩余**、`errors` 非空 —— **绝不许仍报 `'all'`**。 */
  const lockSub = harness.makeTempDir('e90-locked');
  const holder = path.join(lockSub, 'holder');
  env.ensureDir(holder);
  fs.writeFileSync(path.join(holder, 'held.txt'), 'held', 'utf8');
  const holderChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { cwd: holder, stdio: 'ignore', windowsHide: true });
  await new Promise(r => setTimeout(r, 1200));            /* 等子进程真的起在自己那个 cwd 上 */
  const lockedSwept = harness.cleanup(true);
  const lockedAfter = e90Facts(runRootE90);
  const lockedDeep = e90Deep(runRootE90);
  const lockedBad = e90Violations(lockedSwept, lockedAfter, lockedDeep);
  t.check('E90③ 注入删除失败（子进程把本轮子目录当 cwd 占住 ⇒ `EPERM`）：必须 `removed !== \'all\'`' +
    ' ＋ `kept > 0`（且＝回读剩余）＋ `errors` 非空 —— "删不掉"不许被写成"删干净了"',
    lockedBad.length === 0 && lockedSwept.removed !== 'all' && lockedSwept.kept > 0
      && lockedSwept.kept === lockedAfter.entries && lockedAfter.exists === true
      && lockedSwept.keptDeep === lockedDeep && lockedSwept.keptDeep > 0
      && Array.isArray(lockedSwept.errors) && lockedSwept.errors.length > 0,
    `占住 ${path.relative(env.paths.root, holder)}（pid=${holderChild.pid}）；返回=${JSON.stringify(lockedSwept)}；`
      + `回读=${JSON.stringify(lockedAfter)}（深层 ${lockedDeep} 条）；`
      + `不变量违规 ${lockedBad.length} 条${lockedBad.length ? '：' + lockedBad.join('；') : ''}`);

  /* ④ 释放占用后再收尾：必须回到 `'all'`（证明 ③ 的读数来自"被占住"，不是"清理坏了"） */
  holderChild.kill();
  await new Promise(r => setTimeout(r, 1500));
  const releasedSwept = harness.cleanup(true);
  const releasedAfter = e90Facts(runRootE90);
  const releasedDeep = e90Deep(runRootE90);
  const releasedBad = e90Violations(releasedSwept, releasedAfter, releasedDeep);
  t.check('E90④ 释放占用后再收尾：回到 `removed===\'all\'` 且目录不存在（⇒ ③ 的读数确实来自"被占住"）',
    releasedBad.length === 0 && releasedSwept.removed === 'all' && releasedAfter.exists === false
      && releasedSwept.kept === 0 && releasedSwept.keptDeep === 0 && releasedSwept.errors.length === 0,
    `释放后返回=${JSON.stringify(releasedSwept)}；回读=${JSON.stringify(releasedAfter)}；`
      + `不变量违规 ${releasedBad.length} 条${releasedBad.length ? '：' + releasedBad.join('；') : ''}`);

  /* ⑤ `D22` 定点变异：把 `lib/harness.js` 的**回读**去掉、恢复旧版"无条件报 `all`" ⇒ `E90` 不变量
     必须**红并指名**（旧版就是 `E90` 要消的病灶："返回值与事实无关"）。
     ⚠ 变异在**内存里的字节副本**上做（`Module._compile`，与第十四节/§16 同一手法）：
     座位 4 的 `tests\lib\harness.js` **全程只读**，盘上字节不变（`Buffer.compare` ＋ sha256 留痕）。
     两端都读：变异体在被占住的目录上**谎报** `'all'/0/0` ⇒ 违规清单非空并指名；
     真实模块在**同一事实**上给出 `'partial'`/实测剩余 ⇒ 违规为空。 */
  {
    const harnessPath = path.join(env.paths.tests, 'lib', 'harness.js');
    const bytes0 = REAL_READ.call(fs, harnessPath);                 /* 字节副本（只读，不写盘） */
    const sha0 = sha256BytesE70(bytes0);
    const src0 = bytes0.toString('utf8');
    const READBACK_ANCHOR = /const after = readTempFacts\(target\);[\s\S]*?return \{ removed, kept: after\.entries, keptDeep: afterDeep, target, errors \};/;
    const lieBody = 'return { removed: \'all\', kept: 0, keptDeep: 0, target, errors };';
    const mutatedSrc = READBACK_ANCHOR.test(src0) ? src0.replace(READBACK_ANCHOR, lieBody) : '';
    let mutant = null;
    /* ⚠ **`Module._compile` 会把顶层语句再跑一遍 —— 但下面这段 save/restore 现在是**无害 no-op****
       （2026-10-03，本批更正；旧注释与事实已不符，原文见 `git log`）。
       旧注释说的是：`lib\harness.js` 顶层**有 tempRoot 副作用**——`E90` 的轮次隔离在顶层把
       `env.paths.tempRoot` 指向本轮专属目录；`Module._compile` 会把这些顶层语句再跑一遍 ⇒
       不复原就会变成"本轮目录里的又一层 run-…"。
       **那个副作用已经不存在了**：`T-20261003-10`（座位 4）做了单一真源化——
       `tempRootBase`／`tempRoot` 两个键的**定义处**搬到了 `tests\env.js`（那里是"路径集"的定义处，
       任何脚本 require 它都会算好），`lib\harness.js` **只剩只读校验**（`assertTempRootSemantics()`
       只读 `env.paths.*` 并比对，**一个字节都不写**；顶层唯一动作就是调用它）。
       ⇒ 故本段 `envTempRootSaved`／`envTempBaseSaved` 的保存与回写**读写的是同一个值**，
       它现在是 no-op；`E90-D22` 的断言仍 PASS（判据守的是"变异体谎报 `all`"，与本段无关）。
       **为什么仍然保留它**（而不是删掉）：`Module._compile` 确实仍会重跑**其它**顶层副作用
       （`assertTempRootSemantics()` 重跑一次＝重复校验同一事实，无害；模块级 `seq` 归零——变异体
       只被调 `cleanup`，用不到）。它唯一的作用是：**万一** `lib\harness.js` 顶层将来又被写进路径注入
       （`E90` 的病灶形态），这段保存＋回写会把变异体隔离在"与真实模块同一个目录"上，
       而不是让后面的取样被悄悄带偏。代价是两行赋值 ＋ 一个 `finally`，属**廉价的纵深防御**；
       若将来有人要删，请连同这条注释一起删，并把"顶层不得再出现路径副作用"写进 `lib\harness.js`
       的文件头（那里的注释已经这么规定了）。 */
    const envTempRootSaved = env.paths.tempRoot;
    const envTempBaseSaved = env.paths.tempRootBase;
    try {
      if (!mutatedSrc) throw new Error('变异锚点未命中：`lib\\harness.js` 里找不到"回读事实"那一段');
      const Module = require('node:module');
      const m = new Module(harnessPath, null);
      m.filename = harnessPath;
      m.paths = Module._nodeModulePaths(path.dirname(harnessPath));
      m._compile(mutatedSrc, harnessPath);
      mutant = m.exports;
    } catch (err) {
      t.info('E90-D22 变异体未能载入：' + (err && err.message));
    } finally {
      env.paths.tempRoot = envTempRootSaved;                        /* 复原顶层副作用（见上） */
      env.paths.tempRootBase = envTempBaseSaved;
    }
    /* 在**同一个被占住的事实**上分别问真实模块与变异体（③ 刚验过占用有效；这里再占一次）。
       ⚠ 事实必须在**每次 `cleanup` 之后**回读（`removed/kept/keptDeep` 描述的是"清完之后还剩什么"）。 */
    const lockSub2 = harness.makeTempDir('e90-d22-locked');
    const holder2 = path.join(lockSub2, 'holder');
    env.ensureDir(holder2);
    fs.writeFileSync(path.join(holder2, 'held.txt'), 'held', 'utf8');
    const child2 = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { cwd: holder2, stdio: 'ignore', windowsHide: true });
    await new Promise(r => setTimeout(r, 1200));
    const factsPre = e90Facts(runRootE90);
    const realRes = harness.cleanup(true);                          /* 真实模块：如实报 partial */
    const realFacts = e90Facts(runRootE90);
    const realDeep = e90Deep(runRootE90);
    const realBad = e90Violations(realRes, realFacts, realDeep);
    const mutRes = mutant ? mutant.cleanup(true) : null;            /* 变异体：无回读 ⇒ 谎报 all */
    const mutFacts = e90Facts(runRootE90);
    const mutDeep = e90Deep(runRootE90);
    const mutBad = mutant ? e90Violations(mutRes, mutFacts, mutDeep) : ['变异体未载入'];
    child2.kill();
    await new Promise(r => setTimeout(r, 1500));
    try { harness.cleanup(true); } catch { /* 收尾，忽略 */ }
    const diskSame = Buffer.compare(REAL_READ.call(fs, harnessPath), bytes0) === 0
      && sha256BytesE70(REAL_READ.call(fs, harnessPath)) === sha0;
    t.check('E90-D22 定点变异：把 `lib/harness.js` 的**回读**去掉、恢复"无条件报 `all`" ⇒ `E90` 不变量**必红并指名**；' +
      '同一事实下真实模块仍如实报 `partial`/实测剩余（⇒ 这条不变量不是恒真式）：变异在内存副本上做，`tests\\lib\\harness.js` 盘上字节不变',
      Boolean(mutant) && realFacts.exists === true && mutFacts.exists === true
        && mutRes !== null && mutRes.removed === 'all'
        && mutBad.length > 0 && mutBad.some(v => /仍存在|不是由事实推导/.test(v))
        && realBad.length === 0 && realRes.removed !== 'all' && realRes.kept > 0
        && diskSame,
      `占住 ${path.relative(env.paths.root, holder2)}；清理前回读=${JSON.stringify(factsPre)}；`
        + `真实模块返回=${JSON.stringify(realRes)}／之后回读=${JSON.stringify(realFacts)}（深层 ${realDeep}）；违规 ${realBad.length} 条`
        + `${realBad.length ? '：' + realBad.join('；') : ''}；`
        + `变异体返回=${JSON.stringify(mutRes)}／之后回读=${JSON.stringify(mutFacts)}（深层 ${mutDeep}）；`
        + `违规 ${mutBad.length} 条：${mutBad.join('；')}；`
        + `盘上 lib\\harness.js 未变=${diskSame}（sha256=${
          sha256BytesE70(REAL_READ.call(fs, harnessPath)).slice(0, 12)}…，原件 ${sha0.slice(0, 12)}…）`);
  }

  /* ⑤ `cleanup(false)`：仍返回**数字**统计，且只清公共根下 **> 24 h** 的**整轮目录**。
     造一个 mtime 改到 25 h 前的**假整轮目录**，并用"本轮目录"当对照 ⇒ 验"清的正好是它、我的还在"。 */
  const fakeOldRun = path.join(baseE90, 'run-999999-19700101T000000-dead');
  env.ensureDir(fakeOldRun);
  fs.writeFileSync(path.join(fakeOldRun, 'old.txt'), 'old', 'utf8');
  const old25h = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(path.join(fakeOldRun, 'old.txt'), old25h, old25h);
  /* 目录**自身**的 mtime 才是判据（`env.cleanupStaleTemp` 用 `statSync(full).mtimeMs`） */
  fs.utimesSync(fakeOldRun, old25h, old25h);
  env.ensureDir(runRootE90);                              /* 上一段刚把本轮目录清掉 ⇒ 重建以代表"我的还在" */
  fs.writeFileSync(path.join(runRootE90, 'mine.txt'), 'mine', 'utf8');
  const staleSwept = harness.cleanup(false);
  t.check('E90⑤ `cleanup(false)`：仍返回**数字**统计，且只清公共根下 **> 24 h** 的整轮目录' +
    '（清掉的正好是那个 25 h 前的假整轮目录；**本轮目录一根毫毛都不少**）',
    typeof staleSwept.removed === 'number' && typeof staleSwept.kept === 'number'
      && !fs.existsSync(fakeOldRun) && fs.existsSync(runRootE90)
      && fs.existsSync(path.join(runRootE90, 'mine.txt')),
    `返回=${JSON.stringify(staleSwept)}；假整轮目录仍在=${fs.existsSync(fakeOldRun)}；`
      + `本轮目录仍在=${fs.existsSync(runRootE90)}（mine.txt=${fs.existsSync(path.join(runRootE90, 'mine.txt'))}）`);
  try { harness.removeLinkSafe(fakeOldRun, { recursive: true, force: true }); } catch { /* 已被清掉就忽略 */ }  e103LinkSafetyChecks(t);   /* `E103`：链接安全门禁守护（定义在本文件尾部，抬头有口径与偏差说明） */
}

/* ---------------- 六、断言器自身 ---------------- */
t.section('六、断言器自身（它坏了上面全部门禁都不可信）');
{
  const { createRunner } = require('./lib/assert');
  const spy = [];
  const origLog = console.log;
  console.log = (...a) => spy.push(a.join(' '));
  let code = null;
  const origExit = process.exit;
  process.exit = (c) => { code = c; throw new Error('__EXIT__'); };   // 拦截退出
  const sub = createRunner('子 runner 探针');
  sub.check('通过的用例计 1', true);
  sub.check('失败的用例计 1', false, '故意失败');
  sub.skip('跳过的用例单独计', '原因');
  try { sub.finish(); } catch { /* 被拦截 */ }
  console.log = origLog;
  process.exit = origExit;

  const out = spy.join('\n');
  t.check('汇总行格式固定为「通过 N 项，失败 N 项，跳过 N 项」（runner 与门禁数字都解析它）',
    /通过 1 项，失败 1 项，跳过 1 项/.test(out), '');
  t.check('有失败时以退出码 1 结束', code === 1, `实测退出码 ${code}`);
  t.check('失败清单会列出原因', /故意失败/.test(out), '');
  t.check('跳过清单单列且说明原因', /跳过清单/.test(out) && /原因/.test(out), '');

  const sub2 = createRunner('子 runner 探针 2');
  const spy2 = [];
  console.log = (...a) => spy2.push(a.join(' '));
  process.exit = (c) => { code = c; throw new Error('__EXIT__'); };
  sub2.check('全过', true);
  try { sub2.finish(); } catch { /* 被拦截 */ }
  console.log = origLog;
  process.exit = origExit;
  t.check('全过时以退出码 0 结束', code === 0, `实测退出码 ${code}`);

  /* ADR-0004 D20：requires 的语义自证 —— 前提与断言必须是**两件事**，
     且"前提不成立"必须使退出码非 0（否则前提塌了会被当成"这段没验到但没事"）。 */
  const sub3 = createRunner('子 runner 探针 3');
  const spy3 = [];
  console.log = (...a) => spy3.push(a.join(' '));
  process.exit = (c) => { code = c; throw new Error('__EXIT__'); };
  const okReturn = sub3.requires('数据已就绪', true, '');
  sub3.check('真实断言', true);
  const badReturn = sub3.requires('数据已就绪', false, '实测 0 行');
  try { sub3.finish(); } catch { /* 被拦截 */ }
  console.log = origLog;
  process.exit = origExit;
  const out3 = spy3.join('\n');
  t.check('requires 成立时返回 true、不成立时返回 false（调用方可据此决定是否进入该段）',
    okReturn === true && badReturn === false, `实测 ${okReturn} / ${badReturn}`);
  t.check('requires **不计入断言数**（通过数与"真实断言"一致，不因前提而虚增）',
    /通过 1 项，失败 0 项，跳过 0 项/.test(out3), '前提不是断言');
  t.check('前提不成立时**单独成段**列出，不混进失败清单',
    /前提不成立（\*\*不是通过\*\*/.test(out3) && /前提不成立：数据已就绪/.test(out3) && !/失败清单/.test(out3),
    '一眼分清"前提塌了"与"实现错了"');
  t.check('前提不成立时以退出码 1 结束（不是 0，也不是 skip）',
    code === 1, `实测退出码 ${code}`);

  const sub4 = createRunner('子 runner 探针 4');
  const spy4 = [];
  console.log = (...a) => spy4.push(a.join(' '));
  process.exit = (c) => { code = c; throw new Error('__EXIT__'); };
  sub4.requires('前提成立', true);
  sub4.check('全过', true);
  try { sub4.finish(); } catch { /* 被拦截 */ }
  console.log = origLog;
  process.exit = origExit;
  t.check('前提成立时不影响结论：仍以退出码 0 结束、且不出现"前提不成立"段',
    code === 0 && !/前提不成立/.test(spy4.join('\n')), `实测退出码 ${code}`);
  t.check('requires 与 skip 语义分明（skip 不计失败、requires 计失败）',
    (() => {
      const s5 = createRunner('子 runner 探针 5');
      console.log = () => {};
      process.exit = (c) => { code = c; throw new Error('__EXIT__'); };
      s5.skip('环境不满足', '本环境跑不了');
      try { s5.finish(); } catch { /* 被拦截 */ }
      const skipCode = code;
      const s6 = createRunner('子 runner 探针 6');
      s6.requires('前提被破坏', false);
      try { s6.finish(); } catch { /* 被拦截 */ }
      const reqCode = code;
      console.log = origLog;
      process.exit = origExit;
      return skipCode === 0 && reqCode === 1;
    })(), 'skip→0，requires→1');
}

/* ---------------- 七、runner 结论规则与"假通过"防线 ---------------- */
t.section('七、runner 结论规则（P1-2/P1-3：跑不了就不能算通过）');
{
  /* P1-2 的要害：旧 runner 在"无管道 + 非安静"下 `out` 恒为空 → isEnvSkip('') 为 false →
     "脚本打了 SKIP 且退出码 0"被判 passed，三个浏览器类脚本一个断言都没跑却计入 PASS。
     classify 是纯函数，这里直接对它回归，不依赖环境有没有管道。 */
  const runAll = require('./run-all');
  t.check('classify 把"退出码 0 且一条断言都没跑"判为未核实（**不是通过**）',
    runAll.classify(0, null, '').status === 'unverified',
    `实测 ${runAll.classify(0, null, '').status} —— 这正是 P1-2 的假通过口子`);
  t.check('classify 对"退出码 0 + 只有跳过项"同样判为未核实',
    runAll.classify(0, runAll.parseSummary('通过 0 项，失败 0 项，跳过 1 项'), '').status === 'unverified',
    '浏览器起不来时应为跳过/未核实，不能记绿');
  t.check('classify 把退出码 3 判为跳过（脚本显式声明本环境跑不了）',
    runAll.classify(3, null, '').status === 'skipped');
  t.check('classify 把退出码 2 判为异常、退出码 1 判为失败',
    runAll.classify(2, null, '').status === 'error' && runAll.classify(1, null, '').status === 'failed');
  t.check('classify 只在"跑到过断言且无失败"时才判通过',
    runAll.classify(0, runAll.parseSummary('通过 3 项，失败 0 项，跳过 0 项'), '').status === 'passed' &&
    runAll.classify(0, runAll.parseSummary('通过 3 项，失败 1 项，跳过 0 项'), '').status !== 'passed');
  t.check('runner 的汇总行解析要求三字段齐全',
    runAll.parseSummary('通过 1 项，失败 0 项').skipped === 0 &&
    runAll.parseSummary('通过 1 项，失败 0 项，跳过 2 项').skipped === 2);
  t.check('runner 在无管道时也走"落文件捕获"而非 inherit（两种模式不至于两套账）',
    /stdio:\s*\['ignore', fd, fd\]/.test(fs.readFileSync(path.join(env.paths.tests, 'run-all.js'), 'utf8')),
    '旧实现无管道 + 非安静时用 stdio:inherit，输出拿不到就把 SKIP 记成了 PASS');
  t.check('env 提供环境跳过的统一出口（skipSuite）并以 3 退出',
    typeof env.skipSuite === 'function' && env.EXIT_ENV_SKIP === 3);

  /* P1-3：候选目录为空/不存在时必须失败。空目录无需 PNG 解码能力，秒级可跑。 */
  const runScript = (args) => {
    const { spawnSync } = require('node:child_process');
    const log = path.join(env.ensureDir(env.paths.tempRoot), `screenshot-diff-probe-${process.pid}.log`);
    const fd = fs.openSync(log, 'w');
    const r = spawnSync(process.execPath, [path.join(env.paths.tests, 'screenshot-diff.js'), ...args],
      { cwd: env.paths.root, stdio: ['ignore', fd, fd], timeout: 60000 });
    fs.closeSync(fd);
    let out = '';
    try { out = fs.readFileSync(log, 'utf8'); } catch { /* 忽略 */ }
    try { fs.rmSync(log, { force: true }); } catch { /* 忽略 */ }
    return { code: r.status, out };
  };
  const bad = runScript(['--candidate', path.join(env.paths.verify, 'nonexistent-xyz')]);
  t.check('screenshot-diff：候选目录不存在时**非 0 退出**（P1-3）',
    bad.code === 1, `实测退出码 ${bad.code}（修复前是 0，即"空候选也算通过"）`);
  t.check('screenshot-diff：空候选的失败原因写明"候选 0 张"',
    /候选目录 .* 里没有 PNG（0 张）/.test(bad.out) && /候选 0 张 vs 基准 10 张/.test(bad.out), '');
  t.check('screenshot-diff：汇总行三字段齐全（供 runner 解析）',
    /通过 \d+ 项，失败 \d+ 项，跳过 \d+ 项/.test(bad.out), '');
}

/* ---------------- 八、平台日志的保留策略 ---------------- */
t.section('八、platform/log.js 的保留策略（P2-7：keepDays 过去只赋值不生效）');
{
  const { createLogger } = require('../platform/log');
  const logDir = path.join(env.ensureDir(env.paths.tempRoot), `log-keep-${process.pid}-${Date.now()}`);
  fs.mkdirSync(logDir, { recursive: true });
  const fixedNow = new Date('2026-09-19T12:00:00');
  const mkLog = (name, ageDays) => {
    const full = path.join(logDir, name);
    fs.writeFileSync(full, '[x] [INFO] 占位\n', 'utf8');
    const t = new Date(fixedNow.getTime() - ageDays * 24 * 3600 * 1000);
    fs.utimesSync(full, t, t);
    return full;
  };
  mkLog('2026-01-01.log', 200);      // 远超保留期
  mkLog('2026-09-18.log', 1);        // 1 天前，应保留
  mkLog('2026-09-19.log', 0);        // 当天，必须保留

  const lg = createLogger({ dir: logDir, clock: { now: () => new Date(fixedNow.getTime()) }, console: false, keepDays: 30 });
  t.check('P2-7：创建日志器即按 keepDays 清理过期日志（NFR-21 落地，不再只赋值）',
    lg.startupPrune.removed.includes('2026-01-01.log') && lg.startupPrune.removed.length === 1,
    `删除 ${lg.startupPrune.removed.join('、') || '（无）'}`);
  t.check('P2-7：保留期内的日志（1 天前与当天）不被误删',
    fs.existsSync(path.join(logDir, '2026-09-18.log')) && fs.existsSync(path.join(logDir, '2026-09-19.log')) &&
    lg.startupPrune.kept === 2, `保留 ${lg.startupPrune.kept} 个`);
  t.check('P2-7：prune() 返回可审计信息（删除清单/保留数/截止时间/保留天数）',
    Array.isArray(lg.prune().removed) && Number.isInteger(lg.prune().kept) &&
    lg.prune().cutoff instanceof Date && lg.prune().keepDays === 30, '');
  t.check('P2-7：keepDays 非法（0/负数/NaN/小数）一律抛错（否则会把当天日志也删掉）',
    (() => {
      let n = 0;
      for (const bad of [0, -1, NaN, 1.5, 'abc']) {
        try { createLogger({ dir: logDir, console: false, keepDays: bad }); } catch { n++; }
      }
      return n === 5;
    })(), '5/5 抛错');
  t.check('P2-7：缺省 keepDays 为 30（NFR-21 的"保留 ≥30 天"）',
    createLogger({ dir: logDir, clock: { now: () => new Date(fixedNow.getTime()) }, console: false })
      .prune().keepDays === 30, '');
  try { harness.removeLinkSafe(logDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

/* ---------------- 九、防回潮断言的定点变异（ADR-0004 D22） ----------------
   一条"声称能挡住旧缺陷"的断言，如果按**旧实现**跑也通过，那它就是无效的 —— 而从输出上
   完全看不出来。这里把旧实现片段**内联**进来（不依赖外部文件，避免暗桩随实现漂移而失效），
   逐条确认"按旧写法必然违反现有断言"。

   范围纪律（ADR-0004 D22）：**只对防回潮断言做定点变异，不做全量变异测试**。
   凡其旧行为需要真实文件系统/子进程才能复现的（如 P1-3 的空候选、P2-6 的连接泄漏），
   已在修复轮以**反向实测**验证并留痕于 R-2026-09-19-02 的处置记录，此处不重复构造。 */
t.section('九、防回潮断言的定点变异（旧实现必须被现有断言挡下）');
{
  /* ① P1-1：ROOT 少退一层 —— 旧写法把数据目录算到仓库外 */
  const ROOT = env.paths.root;
  const path = require('node:path');
  const oldRoot = path.resolve(ROOT, 'platform', '..', '..');   // 等价于旧的 resolve(__dirname,'..','..')
  const newRoot = path.resolve(ROOT, 'platform', '..');         // 等价于现在的 resolve(__dirname,'..')
  const insideRepo = base => {
    const rel = path.relative(ROOT, path.join(base, 'data', 'dev'));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  t.check('变异①：若 ROOT 退回 resolve(__dirname,\'..\',\'..\')，dev 数据目录将落到仓库外 —— 被 P1-1 断言挡下',
    insideRepo(newRoot) === true && insideRepo(oldRoot) === false,
    `新 root 在仓库内=${insideRepo(newRoot)}，旧 root 在仓库内=${insideRepo(oldRoot)}`);

  /* ② P1-2：旧 classify 的行为等价物 —— "退出码 0 且零断言" 必须被判未核实 */
  const runAll2 = require('./run-all');
  const legacyClassify = () => ({ status: 'passed' });   // 旧实现对退出码 0 一律判通过
  t.check('变异②：若 classify 退回"退出码 0 即通过"，零断言场景会被误判 —— 被 P1-2 断言挡下',
    runAll2.classify(0, null, '').status === 'unverified' && legacyClassify().status === 'passed',
    '旧行为：零断言 → passed（这正是"14 通过"的来源）');

  /* ③ P2-1：旧 cutoff 计算 —— days=null 时 cutoff=now（全删）、days=NaN 时产出非法文本 */
  const fmtNow = (d) => {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const CUTOFF_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const oldCutoff = (days, now) => fmtNow(new Date(now.getTime() - days * 24 * 3600 * 1000));
  const now = new Date('2026-09-19T12:00:00');
  t.check('变异③：旧 cutoff 算法在 days=null/NaN 下分别产出"now"与非法文本 —— 被 P2-1 的格式断言挡下',
    CUTOFF_RE.test(oldCutoff(365, now)) &&
    oldCutoff(null, now) === '2026-09-19 12:00:00' &&
    !CUTOFF_RE.test(oldCutoff(NaN, now)),
    `null→${oldCutoff(null, now)}；NaN→${oldCutoff(NaN, now)}`);

  /* ④ P2-2：旧剪枝算式 —— 不传 keep 时 slice(NaN)≡slice(0)，一份不剩 */
  const oldKept = (keep, total) => Math.min(keep, total);
  const legacySlice = keep => [1, 2, 3, 4, 5].slice(Math.max(0, keep)).length;   // 旧写法：删掉的数量
  t.check('变异④：旧剪枝在 keep 缺省时 slice(NaN)≡slice(0)，会删光全部 —— 被 P2-2 断言挡下',
    legacySlice(undefined) === 5 && legacySlice(2) === 3 &&
    Number.isNaN(oldKept(undefined, 5)),
    `keep=undefined → 删除 ${legacySlice(undefined)}/5 份，kept 报 ${oldKept(undefined, 5)}`);
  t.check('变异④-补：新算式在同样输入下保留全部（BACKUP_KEEP），且 kept 为真实剩余数',
    legacySlice(30) === 0 && !Number.isNaN(oldKept(30, 5)),
    `keep=30 → 删除 ${legacySlice(30)}/5 份`);
}

/* ---------------- 十、权威数字校验的定点回归（P2-22 + ADR-0004 D22 + E70） ----------------
   机制：`run-all` 收尾会拿"本轮实跑合计"比对 `tests\README.md` 第三节的权威数字。
   这类"断言别人的数字"的机制最容易写成恒真 —— 这里用**临时改写权威行**的方式逐个场景验证它
   真会拦住漂移。踩过的坑：首版探针用 `/合计\s*\*\*\d+\s*通过/` 改写，而 README 实际写作
   `合计 470 通过`（**没有加粗**），于是替换静默失效、三轮验证结果全部不可信 ——
   故这里用容错正则 `/合计\s*\*{0,2}\s*\d+\s*通过/`，并在改完后**回读确认**。

   ⚠ **`E70` 收口（2026-10-03，`T-20261003-08` 甲组）：本段过去是"改写真文件 `tests\README.md` 再还原"。**
   事故（同日实证）：某轮改写**未被还原**（`finally` 没跑到 / 与并发轮次交叠），README 权威区
   （**权威行的"合计"** —— 按**内容**定位：`tests\README.md` 里形如「合计 N 通过 / 2 失败 / 6 跳过」的那一行；`E113`（2026-10-04）核出原注释写的"第 151 行"**已漂移**（该行此刻在 **152** 行），故本行起**不再写行号**）被留成 `541` ＝ **多脚本子集通过数之和** —— 正是本段写入的**中间态值**；
   权威区被静默污染，之后每轮对账都指向错值，只有"逐行比对 HEAD"才发现。
   ⇒ 现在一律**指向受控副本**：
        `<本轮专属临时区>\readme-authority-copy\README.md`
      · 副本落在 `tests\._verify\tmp\run-…` 内 ⇒ 已被 .gitignore 忽略 ⇒ **不进受管面、不产生扫描漂移**；
      · 被校验方 `run-all.verifyAuthorityTotals` **一行不改**（它读 `path.join(env.paths.tests,'README.md')`）：
        本段给**这一条绝对路径**装读数重定向到副本（`finally` 复原；不改全局文件、不改 `env.paths`、
        不改 `run-all.js`、不落地任何"全局开关"）；
      · 真文件在本段里**只被读一次**（取字节副本），之后由两条判据守着：
        `E70-A`（重定向真的生效 ＋ 副本真的被改过 —— 防"替换静默失效"那种假验证）与
        `E70-B`（**受管文件不变量**：跑完这一段，受管文件逐个 sha256 不变，有变就**指名**）。
    **没有任何"还原真文件"的收尾**了 —— 因为真文件从头到尾不该被写；这正是本次收口的意义
   （D22 变异：把副本路径换成真文件路径 ⇒ `E70-B` 必红并指名 `tests/README.md`）。 */
t.section('十、权威数字校验的定点回归（runAll.verifyAuthorityTotals）');
{
  const runAll3 = require('./run-all');
  /* 集合口径与实现**同源**（E50，2026-09-28）：权威区覆盖**全部** suite（含浏览器/长跑脚本），
     故这里造账也必须造满全量 —— 只造 `!needBrowser` 的子集会让下面每条断言都退化成
     "未跑全 ⇒ skipped"，从而**静默失去**"真会拦住漂移"的证明力。 */
  const allSuites3 = runAll3.SUITES.map(s => s.name);
  const mkR = (name, passed, failed) => ({ suite: { name, needBrowser: false },
    status: failed ? 'failed' : 'passed', summary: { passed, failed, skipped: 0 } });
  const resultsOf = (docsFailed) => {
    const base = { 'contract-check': 58, 'ui-check': 40, 'tools-check': 24, 'files-check': 11,
      'harness-check': 73, 'logic-check': 52, 'db-check': 46, 'platform-check': 21,
      'trace-check': 4, 'copy-check': 22, 'screenshot-diff': 24, 'docs-cross-check': 53,
      'browser-check': 33, 'overlap-check': 27, 'stress-check': 11 };
    return allSuites3.map(n => n === 'docs-check'
      ? mkR('docs-check', docsFailed ? 42 : 44, docsFailed ? 2 : 0)
      : mkR(n, base[n] || 0, 0));
  };
  const sumOf = rs => rs.reduce((a, r) => a + r.summary.passed, 0);

  /* ---- `E70-A`：受控副本 ＋ 读数重定向（真文件全程只读） ---- */
  const censusBefore = managedGuardCensus();                  /* ← 不变量的事实来源（走 REAL_READ） */
  const realReadme = path.join(env.paths.tests, 'README.md');
  const copyDir = env.ensureDir(path.join(env.paths.tempRoot, 'readme-authority-copy'));
  const readmePath = path.join(copyDir, 'README.md');         /* ← 本段所有改写都落在这里 */
  const realBytes = fs.readFileSync(realReadme);              /* 字节副本①（真文件**只读**，不写盘） */
  const original = realBytes.toString('utf8');
  fs.writeFileSync(readmePath, realBytes);                    /* 副本＝字节副本（内容与真文件逐字节相同） */
  const realSha0 = sha256BytesE70(realBytes);

  /* 读数重定向：**只**认"真 README 的绝对路径"这一条，其余路径原样透传 */
  const realAbs = path.resolve(realReadme);
  const copyAbs = path.resolve(readmePath);
  const isRealReadme = p => typeof p === 'string' && path.resolve(p) === realAbs;
  const savedReadFileSync = fs.readFileSync;                  /* 与模块级 REAL_READ 是同一个函数 */
  fs.readFileSync = function (p, ...rest) {
    return savedReadFileSync.call(fs, isRealReadme(p) ? copyAbs : p, ...rest);
  };
  try {
    const authIndex = () => original.split(/\r?\n/).findIndex(l => l.includes('离线可跑部分'));
    const setStated = (n) => {
      const lines = original.split(/\r?\n/);
      lines[authIndex()] = lines[authIndex()].replace(/合计\s*\*{0,2}\s*\d+\s*通过/, `合计 ${n} 通过`);
      fs.writeFileSync(readmePath, lines.join('\r\n'), 'utf8');
      /* 回读确认：替换必须真的生效，否则下面的判定全都白验（首版就栽在这里） */
      const now = fs.readFileSync(readmePath, 'utf8').split(/\r?\n/)[authIndex()];
      return /合计\s*\*{0,2}\s*(\d+)\s*通过/.test(now) && Number(RegExp.$1) === n;
    };
    const withDev = resultsOf(true);      // docs-check 带 2 项已登记偏差
    const greenRun = resultsOf(false);    // 全绿
    t.check('改盘辅助生效（能真的把权威行改成目标数字）', setStated(sumOf(withDev)), `目标 ${sumOf(withDev)}`);
    /* `E70-A`：**重定向本身**必须被证明生效 —— 否则"真文件没被改"可能只是因为
       "本段的改写全打在空气上"（首版探针正是栽在"替换静默失效"）。这里读**真路径**
       （走重定向 ⇒ 应拿到副本内容）与**真文件字节**（走 `REAL_READ` ⇒ 应仍是原件）作双向对照。 */
    {
      const viaRedirect = fs.readFileSync(realReadme, 'utf8');
      const onDisk = REAL_READ.call(fs, realReadme);
      const copyMutated = REAL_READ.call(fs, readmePath).toString('utf8') !== original;
      t.check('E70-A 重定向与副本都**真的生效**（否则"真文件没被改"只是改写打在了空气上）：' +
        '① 读真路径拿到的是**副本**内容（＝已被改成目标数字）；② 副本字节确实变了；' +
        '③ 走 `REAL_READ` 读真文件拿到的仍是**原件**、sha256 不变',
        viaRedirect.includes(`合计 ${sumOf(withDev)} 通过`) && copyMutated
          && sha256BytesE70(onDisk) === realSha0,
        `真路径读数含"合计 ${sumOf(withDev)} 通过"=${viaRedirect.includes(`合计 ${sumOf(withDev)} 通过`)}；`
          + `副本已变=${copyMutated}；真文件 sha256 不变=${sha256BytesE70(onDisk) === realSha0}`);
    }
    /* P3-6 补：比对通过时打印的**口径行**是有契约的 —— 必须同时含"合计 ＝ 实跑"与
       "含已登记偏差 N 项，真实通过 M"，好让人一眼看出"确实比过了、且把已登记偏差算进去了"，
       而不是"未核对"（后者正是 P3-6 里被当成正常的那种输出）。 */
    const okDetail = runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).detail;
    const okMatch = okDetail.match(/^权威区合计 (\d+) ＝ 本轮实跑 (\d+)（含已登记偏差 (\d+) 项，真实通过 (\d+)）$/);
    const okNums = okMatch ? okMatch.slice(1).map(Number) : [];
    t.check('权威数字校验：通过时打印的口径行是「权威区合计 N ＝ 本轮实跑 N（含已登记偏差 2 项，真实通过 N-2）」，不是"未核对"',
      okNums.length === 4 && okNums[0] === sumOf(withDev) && okNums[1] === sumOf(withDev) &&
      okNums[2] === 2 && okNums[3] === sumOf(withDev) - okNums[2], okDetail);
    t.check('权威数字校验：与实跑一致时判通过（现状口径）',
      runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).ok === true, '');
    setStated(sumOf(withDev) - 2);
    t.check('权威数字校验：写成"真实通过数"（偏差修掉后应达到的值）也接受',
      runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).ok === true, '');
    setStated(sumOf(withDev) + 1);
    t.check('权威数字校验：**不接受中间值**（曾一度把 471 这类数字放过）',
      runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).ok === false, '');
    setStated(999);
    t.check('权威数字校验：权威区写错即判不通过（真会拦住漂移）',
      runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).ok === false, '');
    setStated(sumOf(withDev));
    const otherFail = withDev.map(r => r.suite.name === 'db-check' ? mkR('db-check', 40, 6) : r);
    t.check('权威数字校验：其他脚本失败时先报它们，而不是纠结数字',
      runAll3.verifyAuthorityTotals({ passed: sumOf(otherFail) }, otherFail).ok === false, '');
    /* 漏列脚本：从权威行删掉 platform-check 的点名（**E77**）。
       ⚠ 锚点**不得含计数**：旧写法写死 `` `platform-check` **21/0**， ``，而权威区现值是
       **29/0** ⇒ `replace` 变 **no-op**、"点名没删掉"却**照样判绿**（座位 5 报告 C·13.6 的锚点漂移）。
       改法（任务包 T-20260930-30 建议形）＝`/`platform-check`[^，,]*，/`：只认**点名**，
       计数/说明文字怎么写都不影响锚点命中。命中数顺带**回读**，`!== 1` 判红（锚点再漂移就
       明确以"锚点回读失败"报错，不许静默空转）。
       只删到**第一个半角/全角逗号**（点名 ＋ 可能残留一个未配对的右括号）；`named` 是逐 token 扫的，
       残留括号不影响它 —— 要点名真的消失即可，且残余可见 ⇒ 便于追查。 */
    const removeGateNamedInAuthority = (name) => {
      const target = `${'`'}${name}${'`'}`;
      const cur = fs.readFileSync(readmePath, 'utf8').split(/\r?\n/);
      const i = authIndex();
      const line = cur[i];
      const hits = [...line.matchAll(new RegExp(target + '[^，,]*，', 'g'))].length;
      if (hits === 1) cur[i] = line.replace(new RegExp(target + '[^，,]*，'), '');
      fs.writeFileSync(readmePath, cur.join('\r\n'), 'utf8');
      /* 回读（先例 `setStated` :3895-3898）：必须读到"点名真的没了"的痕迹，否则整条判空转 */
      const back = fs.readFileSync(readmePath, 'utf8').split(/\r?\n/)[i] || '';
      return { hits, removed: line.includes(target) && !back.includes(target) };
    };
    const rmLines = removeGateNamedInAuthority('platform-check');
    t.check('权威数字校验：权威区漏列某个离线门禁即判不通过（新增脚本别忘登记）',
      runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).ok === false, '');
    /* E77 定点回归：证明上一条**不是空转**（点名真的被删掉了，而且删对了分支） */
    {
      const rmRes = runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev);
      t.check('权威数字校验/E77：漏列点名的变异**真的生效**（锚点命中恰 1 次、回读确认点名已消失），' +
        '且判红钉在**漏列**那一支（`kind=broken`：`missingGates=[platform-check]`）而不是"数字漂移"（`mismatch`）',
        rmLines.hits === 1 && rmLines.removed === true && rmRes.ok === false &&
        rmRes.kind === 'broken' && /漏列离线门禁/.test(rmRes.detail) && /platform-check/.test(rmRes.detail),
        `锚点命中 ${rmLines.hits} 次（须恰 1 次）、回读点名已消失=${rmLines.removed}；` +
        `判定 ok=${rmRes.ok}、kind=${rmRes.kind}、detail=${rmRes.detail}`);
    }
  } finally {
    fs.readFileSync = savedReadFileSync;                      /* 复原读数重定向（真文件从未被写 ⇒ 无需还原） */
  }

  /* ---- `E70-B`：**结构性不变量** —— 跑完上面这一段，受管文件逐个 sha256 必须与开始时相同 ----
     语义：受管文件＝入库且被门禁扫描的文本文件（`snapshot` 扫描面；含未入库的同类文本文件，宁可为严）
     ＋ `tests\screenshots-baseline\` 下的**全部目录条目**（PNG 基准图 ＋ 该目录的 `README.md`；
       措辞见 `baselineEntriesPhrase()` 与 `E113` 第二批：**不写死张数**）
     `tests\._verify\` 下的产物与账本（`run-totals.json`）**不在**受管面内（运行期正常产出）。
     **本段没有"还原真文件"的收尾** —— 真文件压根没被写过；D22 变异（把副本路径换成真文件路径）
     必须让这一条**红并指名**。 */
  const censusAfter = managedGuardCensus();
  const managedChanged = managedGuardDiff(censusBefore, censusAfter);
  t.check('E70-B 结构性不变量：跑完本段（权威数字定点回归）后，**受管文件**的 sha256 与开始时逐个相同' +
    '（受管文件＝入库且被门禁扫描的文本文件 ＋ `tests\\screenshots-baseline\\*`；有变化即**逐条指名**）',
    managedChanged.length === 0 && censusBefore.collected && censusAfter.collected,
    `受管面 ${censusBefore.textCount} 个文本文件 ＋ ${baselineEntriesPhrase(censusBefore)}；`
      + `采集可用=${censusBefore.collected}/${censusAfter.collected}`
      + `（${censusBefore.reason || '无异常'}）`
      + `；被改动的受管文件 ${managedChanged.length} 个`
      + (managedChanged.length ? `：${managedChanged.join('；')}` : '')
      + `；真文件 tests\\README.md sha256 仍为 ${realSha0.slice(0, 12)}…`);

  /* `E70-B` 的定点回归（**纯函数真值表**，不碰真文件）：`managedGuardDiff` 必须"有变化就指名"，
     且指到**具体路径**（含历史事故那个文件 `tests/README.md`）；无变化 ⇒ 空清单。
     ⚠ 真正把"运行期改写真文件且不还原"打出来的那次变异是**外部定点实验**（见回执的证据文件）：
     把本段的副本路径换成真文件路径（并关掉读数重定向）⇒ `E70-B` **红并指名 `tests/README.md`**，
     随后按**字节副本**还原真文件并给出 `Buffer.compare` ＋ sha256 证明（不使用 `git checkout/restore`）。
     之所以不把那次变异做成常驻断言：它必须**真的写一次 `tests\README.md`**，而"测试自己去写权威区"
     正是本次收口要消灭的东西 —— 常驻版只保留这条纯函数真值表（同样能证明"指名"不是空转）。 */
  {
    const baseP = managedGuardCensus();
    const sameP = managedGuardDiff(baseP, { files: { ...baseP.files } });
    const mutP = managedGuardDiff(baseP, { files: { ...baseP.files, 'tests/README.md': 'deadbeefdeadbeef' } });
    const goneP = managedGuardDiff(baseP, {
      files: Object.fromEntries(Object.entries(baseP.files).filter(([k]) => k !== 'tests/README.md'))
    });
    const pngP = managedGuardDiff(baseP, {
      files: { ...baseP.files, 'tests/screenshots-baseline/tab-stats.png': 'cafebabecafebabe' }
    });
    t.check('E70-B补 定点回归：`managedGuardDiff` 无变化⇒空清单；`tests/README.md` 字节变了⇒**恰指名它一条**' +
      '（含前后 sha256 前 12 位）；被删同样指名；`tests\\screenshots-baseline\\*` 也在受管面内（不该变）',
      sameP.length === 0
        && mutP.length === 1 && mutP[0].startsWith('tests/README.md') && mutP[0].includes('deadbeefdead')
        && goneP.length === 1 && goneP[0].startsWith('tests/README.md') && goneP[0].includes('缺')
        && pngP.length === 1 && pngP[0].startsWith('tests/screenshots-baseline/'),
      `无变化=${sameP.length} 条；改 README=${mutP.join('；') || '（无）'}；删 README=${goneP.join('；') || '（无）'}；`
        + `受管面有变化的基准目录条目=${pngP.join('；') || '（无）'}`);
  }

  /* ---------------- 十之二、权威校验的"可达性"回归（2026-09-20 补） ----------------
     立案原因：`verifyAuthorityTotals` 写得再对，**只要调用点被放在提前退出之后，它就一次都不会执行**。
     实际发生过：调用点在 `if (failed.length) { … process.exit(1) }` 之后，而 `docs-check`
     因 2 项 6.4 已登记偏差**永远失败** ⇒ 该函数成了不可达代码，
     `tests\README.md` 第三节自称的"唯一真源 + 与实跑比对"从来没有兑现过一次。
     两类断言：① 前置条件判据的真值表（纯函数 `authorityBlockers`）；
              ② **静态断言调用顺序** —— 调用点必须在提前退出之前（这条才是直接防复发的）。 */
  const blockersOf = (rows) => runAll3.authorityBlockers(rows.map(([name, status]) =>
    ({ suite: { name }, status })));
  const truth = [
    [['docs-check', 'failed'], [], '只 docs-check 失败 → 允许比对'],
    [[], [], '全绿 → 允许比对'],
    [[['browser-check', 'skipped'], ['docs-check', 'failed']], [], 'skipped 不算失败（浏览器类退 3）'],
    [[['screenshot-diff', 'failed'], ['docs-check', 'failed']], ['screenshot-diff'], '有别的失败 → 阻止比对'],
    [[['db-check', 'unverified'], ['docs-check', 'failed']], ['db-check'], 'unverified 也算阻止（没证据不等于通过）'],
    [[['logic-check', 'error']], ['logic-check'], 'error 阻止比对'],
    [[['docs-check', 'failed'], ['docs-check', 'passed']], [], '多个 docs-check 条目也只认这一个豁免']
  ];
  const truthBad = truth.filter(([rows, want]) => {
    const got = blockersOf(rows);
    return JSON.stringify(got) !== JSON.stringify(want);
  });
  t.check('权威比对前置条件：真值表逐条正确（failed/error/unverified 阻止；skipped 不阻止）',
    truthBad.length === 0,
    truthBad.length ? truthBad.map(([rows, want]) =>
      `${JSON.stringify(rows)} 期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(blockersOf(rows))}`).join('；')
      : `共 ${truth.length} 个场景`);

  /* 静态断言：调用点位置。用"源码中两者的字符下标"比较，脱离格式化（缩进/空行）差异。 */
  const runAllSrc = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
  const callAt = runAllSrc.indexOf('const auth = verifyAuthorityTotals(');
  const earlyExitAt = runAllSrc.indexOf('if (failed.length) {');
  t.check('权威校验的调用点早于「失败脚本明细 + 提前退出」（否则该机制不可达）',
    callAt > 0 && earlyExitAt > 0 && callAt < earlyExitAt,
    callAt < 0 ? '源码里找不到 verifyAuthorityTotals 的调用'
      : earlyExitAt < 0 ? '源码里找不到 `if (failed.length) {` 提前退出'
      : `调用点下标 ${callAt}，提前退出下标 ${earlyExitAt} —— 调用点必须更小`);
}

/* ---------------- 十之②、静态守护：**不许有把受管文档当写目标的"变异探针"** ----------------
   立案（`T-20261003-12` 追加轮 3；由**主代理实测**触发，座位 4b 定性与修复）：一次全量轮里
   `docs-cross-check` 报 **70/2**（单跑 72/0），失败逐字是
     `失配 1 处：门禁三元组：正文写 9999/2/6 ≠ 期望 1440/2/6（"门禁 **9999 通过 / 2 失败 / 6 跳过"）`
   —— 那个 `9999` **不是**任何产品缺陷，而是**座位 4b 自己的 `E51` 变异探针**为了可证伪性
   **在真受管文档 `项目记录\当前状态快照.md` 上写入、随即还原**的瞬时值；该窗口与全量轮**重叠**
   ⇒ 读者读到瞬时态。**根因＝探针手法（协议缺陷），不是仓库代码**（全仓无任何写 `9999` 到受管文档的写者）。
   本条要守住的口径（写给后来人）：
     · **变异/造缺陷只许作用在"受控副本"上**（`tests\._verify\` 之下），**真受管文档全程只读**；
     · 需要让"读者"看到变异时，走**读数重定向**（先例：本节 §十 对 `tests\README.md` 的
       `readmePath` 副本；`docs-cross-check` 的 `DSH_DC_{README,SNAP,ARCH,ROAD}_OVERRIDE`），
       **不是**去改真文件再抢时间还原；
     · 为什么静态查而不只靠运行期：`E70` 的运行期普查（`managedGuardCensus`）只能证明
       "**本轮**没变"，证明不了"下次不会有人这么写"；而这类写点**恰恰长在被 gitignore 的目录里**
       （本轮教训：写者躺在 `tests\._verify\review\`），**运行期门禁与人工 grep 都容易漏掉它**。
   **扫描面＝磁盘上的 `tests\**\*.js`（含 `._verify\`）＋ `tools\**\*.js`，不看 git 是否跟踪**
   （被忽略≠不存在：被忽略目录里的写者照样能写文件）；断言里**打印实扫文件数**，
   免得将来没人知道它到底看了什么。
   **受管文档清单**：①`snapshot.collectSnapshot()` 的 93 个受管文件（**动态取**，防第二份真源漂移）
   ＋ ②门禁**按内容校验但不在清单里**的三份"当前值区"文档（`docs-cross-check` 第十五节读它们）
   ＋ ③`PROJECT_RULES.md`。**刻意不含 `项目记录\工作日志.md`**：它是主代理的**追加式**会话记录
   （每轮都在写，且**不在** `collectSnapshot` 的 93 个里 ⇒ 没有任何门禁按哈希比对它），
   把它算进来的话这条守护会被"正常记账"恒常点亮 ⇒ 变成噪音；它的可追溯性由 `docs-check` 负责。
   **白名单**（只放"写自己那份受控副本"的正当写法，逐条给理由）：
     · `SELF_COPY_VAR`：目标变量名自带"副本/拷贝"语义（`readmePath`／`copyPath`／`*Copy*`／`副本`／`bak`…）
       —— 先例＝§十 的 `readmePath`（写入前已用 `realBytes` 做**字节副本**）；
     · `SELF_COPY_PATH`：目标表达式里出现 `._verify\tmp\`／`._verify\review\` 或 `副本`／`copy`；
     · `WRITE_ADJUNCTS`：**不是**写目标的那几个"必需的伴随实参"（`{recursive:true}`／`{force:true}`／
       `'utf8'`／`{encoding:…}`／`{flag:…}`／`mode:`）—— 它们**常与受管文档名同处一个调用**
       （真正的目标反而是变量），若不排除就会制造假阳性；判据仍以**第 1 实参**为主。
   **D22**（可证伪，见回执）：①把一份真探针的源码**内存变异**成"写真实 `当前状态快照.md`"⇒ 必红并指名；
   ②写一个**真的**探针式写点落到 `._verify\review\` 再扫描 ⇒ 必红并指名（上面 ① 证明的是判据，
   ② 证明的是"扫描面真的覆盖被忽略目录"，两者缺一不可）。 */
t.section('十之②、静态守护：不许有把受管文档当写目标的"变异探针"（E104 根因守护）');
{
  /* ⚠ **本段自身要跳过扫描**：下面 `hitManaged` 的判据定义（`SELF_COPY_VAR` 等）与 `goodSamples`／
     `badSamples` 两组样本里，**故意**含有受管文档名（那是判据的输入）；扫自己会自伤（实测：
     `SELF_COPY_VAR = /…PROJECT_RULES…/` 那两行被判成"写 PROJECT_RULES.md"）。
     处理＝本块从这一行起打上"自跳过"标记，扫描循环遇到它就整块不扫（见 `SELF_SKIP`）。 */
  const SELF_SKIP_FROM_HERE = true;
  void SELF_SKIP_FROM_HERE;
  const WRITE_RX = /\b(writeFileSync|appendFileSync|rmSync|renameSync|copyFileSync|unlinkSync|createWriteStream)\s*\(/;
  /* ⚠ 副本语义的变量名白名单**必须精确**：第一版写成 `/…|bak|Bak|BAK/`，而 `realSnap` 里
     "**S**n**ap**"… 并不含 bak —— 真正的坑是 `SELF_COPY_PATH` 里我一度写过 `Snap`（会把
     `realSnap` 误放行）。这里统一收紧为：变量名含 `copy/Copy/副本/bak/Bak/BAK`，或**ReadmePath**
     这类"明确的副本路径变量"（先例＝§十 的 `readmePath`）。`realSnap`／`realAbs` **不在**白名单内
     ⇒ `writeFileSync(realSnap, …)` 会被判红（这正是本次现场要抓的形态）。 */
  const SELF_COPY_VAR = /readmePath|copyPath|CopyPath|SnapshotCopy|copy|Copy|副本|拷贝|bak|Bak|BAK/;
  /* ⚠ `SELF_COPY_PATH` 只放"明确的临时/副本目录"：**不放 `Snap` 之类词** ——
     一度写成含 `Snap`，结果把 `realSnap`（写**真**快照的变量）误当副本放行（假绿）。 */
  const SELF_COPY_PATH = /\._verify[\\/]|副本|拷贝/;
  const WRITE_ADJUNCTS = /\brecursive\s*:|\bforce\s*:|\bencoding\s*:|\bflag\s*:|\bmode\s*:|'utf8'|"utf8"|'utf-8'/;
  const managedDocNames = /README\.md|PROJECT_RULES|当前状态快照|项目架构与技术栈|后续路线图/;

  /** 受管文档清单（动态派生，见段首注释）。
   *  ⚠ **只收"文档/产物类"扩展名**（`.md`／`.sql` 等），**不收源码**（`.js`／`.css`／`.json`）：
   *  实测代价 —— 把源码算进来会因"基名撞车"制造大量假阳性（`path.join(ARTIFACTS,'result.json')`
   *  被判成写 `server\repo\result.js`、`path.join(dir,'index.js')` 被判成写 `server\db\index.js`），
   *  而那些**其实是往 `._verify` 里写自己的产物**。本条的靶子是"台账**文档**被变异探针改写"
   *  （`E104` 现场＝`项目记录\当前状态快照.md`），源码改写的守护由 `E70` 的运行期普查负责。 */
  const CODE_EXT = /\.(js|mjs|cjs|css|json|png)$/i;
  const managedDocs = new Set();
  try {
    for (const rel of Object.keys(snapshot.collectSnapshot().files)) {
      if (!CODE_EXT.test(rel)) managedDocs.add(rel);
    }
  } catch { /* 取不到就只用下面的静态项 */ }
  ['README.md', 'PROJECT_RULES.md', '项目架构与技术栈.md',
    '项目记录/当前状态快照.md', '项目记录/后续路线图.md'].forEach(r => managedDocs.add(r));

  /** 递归列磁盘上的 .js（**不跟随符号链接**；不看 git 跟踪状态） */
  const walkJsOnDisk = (dir, out = []) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of list) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walkJsOnDisk(abs, out);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(abs);
    }
    return out;
  };

  /** 把"第 1 实参之后"的文本切成顶层实参数组（判据要知道**哪个**实参才是写目标） */
  const splitTopArgs = tail => {
    const out = [];
    let depth = 0, cur = '';
    for (let k = 0; k < tail.length; k++) {
      const c = tail[k];
      if ('([{'.includes(c)) { depth++; cur += c; continue; }
      if (')]}'.includes(c)) { if (depth === 0) break; depth--; cur += c; continue; }
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  };
  /** 每个写 API 的"**目标**实参下标"（0 起）：
   *  · `copyFileSync(src, dst)`／`renameSync(old, new)` 的目标是**第 2 个**实参 ——
   *    只看第 1 个会把方向搞反（实测：`fs.copyFileSync(src,'PROJECT_RULES.md')` 与
   *    `fs.renameSync(t,'项目架构与技术栈.md')` 两例漏判）；
   *  · `createWriteStream(p)`／其余写 API 的目标都是第 1 个。 */
  const destructiveArgs = fn => (/copyFileSync|renameSync/.test(fn) ? [1] : [0]);

  /** 判据（纯函数，供 D22 内存变异复用）：返回该行命中的"受管文档名"或 null。
   *  **只认三种"确实指向受管文档"的写法**，其余一律不命中（宁可漏报也不误报 —— 本条守护若常红
   *  就会被当成噪音关掉，那才是真损失）：
   *    ① 目标里出现**受管文档整名**的字面量（`'tests/README.md'`／`path.join(ROOT,'项目记录/当前状态快照.md')`）；
   *    ② 目标是个**裸标识符**，且它**等于**某受管文档的基名（`writeFileSync(README, …)`）；
   *    ③ 目标里出现**受管文档基名的标识符**（`writeFileSync(README,…)` 之外的 `path.join(README,…)`；
   *       以及 `writeFileSync(realSnap/snapPath,…)` 这类"变量名即真源"）。
   *  ⚠ 实测踩过的**两类**假阳性（都已按上面收紧）：
   *    · 子串匹配 ⇒ 一句中文说明提到 "…`capture-baseline/README.md`…" 被判成写 `README.md`；
   *    · 裸基名当整名 ⇒ `path.join(ARTIFACTS,'result.json')`／`path.join(dir,'schema.sql')` 被判成
   *      写 `server\repo\result.js`／`server\db\schema.sql`（共 12 处）。
   *  ⚠ 也踩过**一类**假阴性：变量名 `realSnap`／`snapPath` 曾被"纯 ASCII 不认"的规则漏掉
   *    （本次现场正是 `writeFileSync(realSnap, …)`）⇒ 故 ③ 对纯 ASCII 采用**词/驼峰段边界**匹配。 */
  const hitManaged = (line, managedNames2) => {
    const m = WRITE_RX.exec(line);
    if (!m) return null;
    const fn = m[1];
    const args = splitTopArgs(line.slice(m.index + m[0].length));
    /* 本行把受管文档基名赋给某变量（`const README = path.join(…,'tests','README.md')`）⇒ 该变量也算真源 */
    const docStems = [...managedNames2].map(n => n.split('/').pop().replace(/\.[a-z]+$/i, '')).filter(s => s.length >= 2);
    /** 变量名 `v` 是否算"指向受管文档的真源"：
     *  · 中文词干 ⇒ 双向**包含**即可（`v='快照路径'`、`stem='当前状态快照窗口'`）——
     *    中文里"快照"这类词几乎不会偶然出现，双向包含能把"只用文档名的一段的变量"也认出来；
     *  · ASCII 词干 ⇒ 要求**词/驼峰段边界**（`snapPath` ✓；`result.json` 里的 `result` ✗）。 */
    const nameLooksLikeDoc = v => docStems.some(stem => (/[^\x00-\x7F]/.test(stem)
      ? (v.includes(stem) || stem.includes(v))
      : (stem.length >= 4 && new RegExp(stem + '(?![\\w.])').test(v))));
    const varHolding = [...line.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)]
      .map(x => x[1]).filter(nameLooksLikeDoc);
    for (const idx of destructiveArgs(fn)) {
      const target = (args[idx] || '').trim();
      if (!target) continue;
      if (SELF_COPY_VAR.test(target) || SELF_COPY_PATH.test(target)
        || varHolding.some(v => new RegExp(`\\b${v}\\b`).test(target))) continue;   // 写自己那份副本：放行
      const lits = [...target.matchAll(/'([^']*)'|"([^"]*)"/g)].map(x => (x[1] ?? x[2] ?? '').replace(/\\/g, '/'));
      const targetIsJoin = /\bpath\.join\s*\(/.test(target);
      const cands = new Set();
      for (const norm0 of lits) {
        const norm = norm0.replace(/^\.\//, '');
        if (!norm) continue;
        if (norm.includes('/')) cands.add(norm);
        else if (!targetIsJoin && lits.length === 1) cands.add(norm);   // 该调用只给了这一个裸名 ⇒ 就是目标
        const base = norm.split('/').pop();
        if (base) cands.add(base);
      }
      const namesArr = [...managedNames2];
      for (const cand of cands) {
        const isPath = cand.includes('/');
        /* `path.join` 的结果、且候选只是**裸基名** ⇒ 要求"没有任何带目录的同名受管项"才算它
           （这与"整名相等"同义；可判定 `tests/README.md` ✓ 与 `README.e70-d22.bin` ✗） */
        if (targetIsJoin && !isPath && namesArr.some(n => n.includes('/') && n.split('/').pop() === cand)) continue;
        const isManaged = isPath
          ? namesArr.some(n => n === cand || n.endsWith('/' + cand))
          : namesArr.some(n => n.split('/').pop() === cand);
        if (isManaged) return { name: cand, target: target.slice(0, 120) };
      }
      /* ③ 变量名即真源：目标标识符名里含受管文档的"词干"。
             ⚠ **只用"词干 ⊆ 目标"这一个方向**：曾试过反向（"目标 ⊆ 词干"）以覆盖更短的变量名，
             结果 `fs.rmSync(target, ...)` 里的 `target` 被 `项目架构与技术栈` 之类的长词干吸进去
             ⇒ `tests\lib\harness.js` 出现 2 处假阳性。⇒ 只认"目标里含完整词干"。 */
      for (const name of namesArr) {
        const stem = name.split('/').pop().replace(/\.[a-z]+$/i, '');
        if (stem.length < 3) continue;
        if (/[^\x00-\x7F]/.test(stem)) {
          if (target.includes(stem)) return { name, target: target.slice(0, 120) };
        } else if (stem.length >= 4 && new RegExp(stem + '(?![\\w.])').test(target)) {
          return { name, target: target.slice(0, 120) };
        }
      }
    }
    return null;
  };

  /** 扫描一份源码文本 → [{line, name, target}] */
  const scanSrc = (src, docs) => {
    const out = [];
    src.split(/\r?\n/).forEach((l, i) => {
      const h = hitManaged(l, docs);
      if (h) out.push({ line: i + 1, ...h });
    });
    return out;
  };

  /* --------------------------------------------------------------------------
     **判据的边界（口径，写给后来人）**
     · **受管文档清单为什么只收"文档/产物类"扩展名**（去 `.js`／`.css`／`.json`／`.png`，实得 8 条）：
       把**纯源码**算进来会因"**基名撞车**"制造大量假阳性 —— 实测 12 处，例如
       `path.join(ARTIFACTS, 'result.json')` 被判成"写 `server\repo\result.js`、
       `path.join(dir, 'index.js')` 被判成"写 `server\db\index.js`"，而它们其实是往 `._verify\`
       写**自己的产物**。本条守护的靶子是"**台账文档被变异探针改写**"（`E104` 现场＝`项目记录\当前状态快照.md`）；
       源码写入的守护由 §十 的**运行期**普查（`managedGuardCensus`／`managedGuardDiff`）负责。
     · **`项目记录\工作日志.md` 为什么刻意不在清单里**：它是主代理的**追加式会话记录**
       （每轮都在写），且**不在** `snapshot.collectSnapshot()` 的 93 个受管文件里 ⇒ **没有任何门禁
       按哈希比对它**。把它纳入只会让本判据被"正常记账"**恒常点亮** ⇒ 变成噪音而被关掉（那才是真损失）。
       它的可追溯性由 `docs-check` 负责。
     · **历史基线豁免已经清空（2026-10-03，`T-20261003-12` 追加轮 4）**：曾有 9 个**一次性**写入脚本
       留在磁盘上（`zz-main-*` 记账脚本 ＋ `s5t02-run-old-harness`／`d22-e70-mutation`／
       `zz4t30-e77-sync-probe` 这类"改真文件→立刻还原"的探针），当时按**文件内容 sha256**核销
       （内容一改锚即失效）。**主代理已裁定删除这 9 个文件** —— 删掉即从"运行期改写风险面"里
       彻底消失，豁免清单随之**清空**。故现在的语义最简单：
         **扫描面里不允许存在任何"把受管文档当写目标"的写点**（`hits` 必须为 0）；
         下面的计数器只用于**如实打印**"扫了多少、命中多少"，不再有豁免通道。
         若将来又出现同类存量，**处置是删脚本**（或改写成"只写副本"），**不是**重新开豁免口子 ——
         口子一开就回到"豁免名头罩住后续改动"的老路（`D21`／`D23`）。
     -------------------------------------------------------------------------- */
  const LEGACY_BASELINE = [];                       // 已清空（见上；保留常量名以便断言文案沿用）

  const testRoot = env.paths.tests;
  const toolRoot = path.join(env.paths.root, 'tools');
  const onDisk = [...walkJsOnDisk(testRoot), ...walkJsOnDisk(toolRoot)];
  const verifyCount = onDisk.filter(f => f.includes(`${path.sep}._verify${path.sep}`)).length;
  /* 本节的**判据定义**（`SELF_COPY_VAR` 等）与**样本数组**里刻意含有"写受管文档"的字面量
     （那是判据的输入），故扫自己会自伤（实测：`SELF_COPY_VAR = /…PROJECT_RULES…/` 被判成写它）。
     处理＝扫到本文件的 `SELF_SKIP_FROM_HERE` 标记后**整段跳过**，直到下一个 `t.section(` 为止
     （用**位置/标记**定界，不靠内容比对；下面样本数组务必保持 `const goodSamples = [` 起头形态）。 */
  const SKIP_FROM_RX = /const SELF_SKIP_FROM_HERE = true;/;
  const SKIP_UNTIL_RX = /^t\.section\(/;
  const hits = [];
  let skippedSelfLines = 0;
  for (const abs of onDisk) {
    let src = '';
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const rel = path.relative(env.paths.root, abs).split(path.sep).join('\\');
    const isSelf = abs === __filename;
    let inOwnSection = false;
    src.split(/\r?\n/).forEach((l, i) => {
      if (isSelf) {
        if (SKIP_FROM_RX.test(l)) inOwnSection = true;
        if (inOwnSection) {
          skippedSelfLines++;
          if (SKIP_UNTIL_RX.test(l)) inOwnSection = false;      // 下一节开始 ⇒ 恢复扫描
          return;
        }
      }
      const h = hitManaged(l, managedDocs);
      if (h) hits.push({ file: rel, line: i + 1, ...h });
    });
  }
  /* 历史基线豁免的核销（**清单已清空**，见上；这段保留是为了"万一将来又开豁免"时有据可依）：
     · 文件还在、且内容 sha256 与锚相同 ⇒ 核销（`legacyCleared`）；
     · 文件还在、但内容变了 ⇒ **豁免失效**（`legacyStale`）⇒ 该写点重新参战（判红）；
     · 文件**已不存在** ⇒ 不算失效也不判红：写点本身已随文件消失（这就是本批的处置结果），
       但**如实计数**（`legacyObsolete`）并打印 —— 免得"豁免没了"被静默读成"什么都好"。 */
  const legacyCleared = [];
  const remaining = [];
  for (const h of hits) {
    const abs = path.join(env.paths.root, ...h.file.split('\\'));
    const base = LEGACY_BASELINE.find(b => b.file === h.file);
    let cleared = false;
    if (base) {
      try {
        const cur = sha256BytesE70(REAL_READ.call(fs, abs)).slice(0, 32);
        cleared = cur === base.sha;
      } catch { cleared = false; }
    }
    if (cleared) legacyCleared.push(h); else remaining.push(h);
  }
  const legacyStale = LEGACY_BASELINE.filter(b => {
    const abs = path.join(env.paths.root, ...b.file.split('\\'));
    if (!fs.existsSync(abs)) return false;                                   // 文件已删 ⇒ 见 legacyObsolete
    return !legacyCleared.some(h => h.file === b.file);
  });
  const legacyObsolete = LEGACY_BASELINE.filter(b => !fs.existsSync(path.join(env.paths.root, ...b.file.split('\\'))));

  t.info(`§十之② 扫描面：磁盘上的 **${onDisk.length}** 个 .js（tests\\**\\*.js 含 ._verify\\ ＋ tools\\**\\*.js，**不看 git 跟踪状态**）；`
    + `其中 ._verify\\ 下 **${verifyCount}** 个；受管文档清单 **${managedDocs.size}** 条`
    + `（动态取自 snapshot.collectSnapshot() ＋ 三份"当前值区"文档 ＋ PROJECT_RULES.md；`
    + `**不含 项目记录\\工作日志.md**，理由见本节注释）；跳过本文件自身的样本段 ${skippedSelfLines} 行`);
  t.info(`§十之② 历史基线豁免：清单 **${LEGACY_BASELINE.length}** 条（E104 收口后已清空 —— 9 个一次性写入脚本已删除）；`
    + `命中 ${hits.length} 处 ⇒ 核销 ${legacyCleared.length} 处／失效（文件在但内容变了）${legacyStale.length} 处／`
    + `因文件已删而作废 ${legacyObsolete.length} 处`);
  t.check('§十之②-A 静态：`tests\\**`（含被忽略的 `._verify\\`）＋ `tools\\**` 里，把受管文档当写目标的写点'
    + '**只剩"按内容 sha256 核销的历史基线"**（清单里没有的新写点 ⇒ 红并逐条指名 `文件:行号`)',
    remaining.length === 0 && legacyStale.length === 0,
    remaining.length
      ? `**新写点 ${remaining.length} 处**（不在历史基线里，或基线已因文件改动失效）：\n        `
        + remaining.map(h => `${h.file}:${h.line} → 写目标含 \`${h.name}\`（${h.target}）`).join('\n        ')
        + (legacyStale.length ? `\n        另有 ${legacyStale.length} 条基线豁免已失效（文件被改过）：${legacyStale.map(b => b.file).join('、')}` : '')
      : `零新写点（在 ${onDisk.length} 个 .js 上扫过；${legacyCleared.length} 处命中全部落在历史基线里且 sha256 相符）`);

  /* 判据自证（D23：判据必须**可假**）：好/坏两组合成样本，逐条断言判定方向 —— 否则"零命中"可能是
     判据根本没在工作（空洞绿）。⚠ 这两段数组**必须保持 `const goodSamples = [` / `const badSamples = [`
     的起始形态**（上面靠它定界跳过自身）。 */
  const goodSamples = [
    "fs.writeFileSync(readmePath, realBytes);",                          // §十：写副本（变量名带 Path＋readme）
    "fs.writeFileSync(path.join(copyDir, '当前状态快照.md'), t);",         // 写副本目录
    "fs.writeFileSync(copyAbs('snap'), t, 'utf8');",                     // 副本变量
    "fs.writeFileSync(somePath, t, { recursive: true, force: true });",  // 变量＋伴随实参（不是目标）
    "fs.writeFileSync(tmp, t, { flag: 'a', encoding: 'utf8' });",        // 伴随实参 flag/encoding
    "fs.readFileSync('项目记录/当前状态快照.md');",                         // 读不算写
    "const s = fs.readFileSync('tests/README.md', 'utf8'); check(s);"    // 读＋后续使用
  ];
  const badSamples = [
    "fs.writeFileSync('tests/README.md', lines.join('\\r\\n'), 'utf8');",   // 字面写 README
    "fs.appendFileSync('项目记录/当前状态快照.md', t);",                      // append 写快照
    "fs.copyFileSync(src, 'PROJECT_RULES.md');",                          // copyFile 覆盖规范
    "fs.unlinkSync('项目记录/后续路线图.md');",                              // unlink 删路线图
    "fs.writeFileSync(path.join(ROOT, '项目记录/当前状态快照.md'), t);",       // path.join 拼受管文档
    "fs.renameSync(t, '项目架构与技术栈.md');",                              // rename 覆盖架构文档
    "fs.writeFileSync(当前状态快照路径, t);",                               // 变量名＝真源（含完整中文词干）
    "fs.writeFileSync('当前状态快照.md', t, 'utf8');"                       // 只给基名的字面量（写当前目录下的同名文件）
  ];
  const goodBad = goodSamples.filter(s => scanSrc(s, managedDocs).length > 0);
  const badMissed = badSamples.filter(s => scanSrc(s, managedDocs).length === 0);
  t.check('§十之②-B 判据自证（**可假**）：好样本（写副本／变量＋伴随实参／只读）**一律不命中**；'
    + '坏样本（字面写受管文档／`path.join` 拼受管文档／append／copyFile／unlink／rename／变量名含中文词干）**一律命中**',
    goodBad.length === 0 && badMissed.length === 0,
    `好样本误报 ${goodBad.length}/${goodSamples.length}${goodBad.length ? `：${goodBad.join('；')}` : ''}；`
    + `坏样本漏报 ${badMissed.length}/${badSamples.length}${badMissed.length ? `：${badMissed.join('；')}` : ''}`);
  /* 判据的**能力边界**（如实登记，不靠"看着像能抓"）：它**不解析变量赋值链**、也不做数据流分析 ⇒
     像 `const p = helper('snap'); writeFileSync(p, t)` 这种"路径由别处函数算出"的写法**抓不到**。
     本轮现场（`writeFileSync(realSnap, byteBackup)`）能抓到，是因为变量名本身含中文词干/受管基名。
     ⇒ 结论：这条守护是**筛子**不是**证明**；它把"11 处存量写点"这类形态逼到台面上（并逐条给定），
        但"绝对没有探针写真文件"仍要靠**工序纪律**（`E70` 的运行期普查 ＋ 一次只跑一路门禁）。 */
  t.info('§十之② 判据能力边界（如实登记）：不解析变量赋值链／无数据流分析 ⇒ '
    + '`const p = f(...); writeFileSync(p, …)` 这类**抓不到**；能抓到的是"字面量整名／变量名含受管词干"两类。'
    + '故本条是**筛子**不是**证明**，"绝对没有探针写真文件"仍靠工序纪律（E70 运行期普查 ＋ 一次只跑一路门禁）。');

  /* D22（承重性）：把**一份真探针的源码**内存变异成"写真实受管文档" ⇒ 上面的判据必红并指名。
     为什么用"真探针源码 × 内存变异"而不是造个假样本：真源码带着真实的写法（`realAbs('snap')`、
     `writeFileSync(realSnap, …)`），能证明判据在**真实形态**上生效，而不只是在我编的样本上生效。
     探针来源＝**在 `tests\._verify\` 下深搜**一个"含 `writeFileSync(realSnap` 的真文件"（不钉死具体
     路径/目录名 —— 探针是过程产物，位置会随批次变；钉死会让这条 D22 在下一轮静默失效）。 */
  const probeCandidates = (() => {
    const out = [];
    const scan = (d, depth) => {
      if (depth > 4) return;
      let list = [];
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        if (e.isSymbolicLink()) continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { scan(abs, depth + 1); continue; }
        if (!e.isFile() || !e.name.endsWith('.js')) continue;
        try {
          const s = fs.readFileSync(abs, 'utf8');
          if (s.includes('writeFileSync(realSnap')) out.push(abs);      // 只要"用 realSnap 当写目标"的真探针
        } catch { /* 忽略 */ }
      }
    };
    scan(env.paths.verify, 0);
    return out;
  })();
  let d22 = {
    ok: false,
    detail: probeCandidates.length
      ? `找到探针 ${probeCandidates.length} 个但内存变异未生效（锚点不匹配）`
      : '在 `tests\\._verify\\` 下找不到含 `writeFileSync(realSnap` 的探针源码 ⇒ D22 的真实形态一半未取证'
  };
  if (probeCandidates.length) {
    const probeAbs = probeCandidates[0];
    const p0 = fs.readFileSync(probeAbs, 'utf8');
    const before = scanSrc(p0, managedDocs);                           // 真源码：应零命中（它只写副本）
    /* 变异：把"写副本变量"换成"写真实受管文档"（**绝对路径经 path.join 现拼** —— 这样本文件源码里
       不会出现"写受管文档"的字面量，免得判据扫到自己时自伤） */
    const realTarget = `path.join(ROOT, ${JSON.stringify('项目记录/' + '当前状态快照.md')})`;
    const mutated = p0.replace('fs.writeFileSync(realSnap,', `fs.writeFileSync(${realTarget},`);
    const after = mutated === p0 ? [] : scanSrc(mutated, managedDocs);
    const named = after.some(h => h.name.includes('当前状态快照'));
    const diskSame = Buffer.compare(fs.readFileSync(probeAbs), Buffer.from(p0, 'utf8')) === 0;
    d22 = {
      ok: before.length === 0 && after.length > 0 && named && diskSame,
      detail: `探针＝${path.relative(env.paths.root, probeAbs).split(path.sep).join('\\')}；`
        + `真源码命中 ${before.length} 处（应 0）；内存变异后命中 ${after.length} 处`
        + `${after.length ? `（首条：:${after[0].line} 写目标含 \`${after[0].name}\`）` : ''}；`
        + `指名到"当前状态快照"=${named}；探针盘上字节未变=${diskSame}`
    };
  }
  t.check('§十之②-C D22（承重）：把真探针源码**内存变异**成"写真实 `当前状态快照.md`"⇒ 判据**必红并指名**；'
    + '真源码（只写副本）零命中；探针盘上字节不变（`Buffer.compare`）',
    d22.ok, d22.detail);
}

/* ---------------- 十一、已登记偏差的"登记数"必须与本机实算对得上（P3-6） ----------------
   立案原因：2026-09-20 实际发生两次 —— 新增一个文本文件后 `docs-cross-check` 的"权威区扫描 N 个
   文本文件 ＝ files-check 实跑值"变红（属常规工作导致的、可预期的机械漂移），而旧的
   `authorityBlockers` 是**按脚本名**整体豁免 `docs-check`：只要出现任何非 docs-check 的失败，
   整段权威比对就静默不执行 —— "没比对"与"比对通过"在输出上几乎无法区分（评审 A-2026-09-20-01 P3-6）。
   修法：豁免依据换成 `run-all.REGISTERED_DEVIATIONS`（条数 + 断言名 + 出处），本段做四件事：
     ① 常量自身自洽；② 常量 ↔ docs-check 源码 D2 段**静态**对齐（断言名逐字一致）；
     ③ 常量 ↔ `git log` **实算**的偏差条数对齐（防"数字改大就默默多豁免"）；
     ④ 真值表 + "未执行比对"必须写明原因与脚本名。 */
t.section('十一、已登记偏差登记数与本机实算一致（P3-6：豁免依据不再是脚本名）');
{
  const runAll4 = require('./run-all');
  const reg = runAll4.REGISTERED_DEVIATIONS && runAll4.REGISTERED_DEVIATIONS['docs-check'];
  if (t.requires('run-all 导出「已登记偏差」常量（权威比对豁免判据的唯一真源）', Boolean(reg),
    'run-all.REGISTERED_DEVIATIONS["docs-check"] 缺失 —— 豁免判据无从核对')) {

    t.check('已登记偏差常量自洽：失败断言数 = 登记断言名条数，且出处点名 PROJECT_RULES 6.4 与 docs-check D2 段',
      reg.assertions.length === reg.failedAssertions && reg.listedItems >= reg.failedAssertions &&
      /6\.4/.test(reg.source) && /docs-check/.test(reg.source),
      `断言 ${reg.failedAssertions} 条 / 失败清单 ${reg.listedItems} 条；出处：${reg.source}`);

    /* ② 静态对齐：docs-check 源码 D2 段落里的 `check('…'` 断言名必须与常量逐字一致。
       这是"常量不是随手写的数字"的机器证据 —— 改断言名或增删 D2 断言而不同步常量，这里立刻红。 */
    const docsSrc = fs.readFileSync(path.join(env.paths.tests, 'docs-check.js'), 'utf8');
    const d2Start = docsSrc.indexOf("section('D2 提交信息格式");
    const d2End = docsSrc.indexOf('/* ===== D3', d2Start);
    const d2Src = d2Start < 0 || d2End < 0 ? '' : docsSrc.slice(d2Start, d2End);
    const d2Names = [...d2Src.matchAll(/check\(\s*'([^']+)'/g)].map(m => m[1]);
    t.check('已登记偏差的断言名 = docs-check D2 段源码里的 check 名（逐字，改一名就等于换了豁免口子）',
      d2Names.length === reg.failedAssertions && d2Names.every(n => reg.assertions.includes(n)) &&
      reg.assertions.every(n => d2Names.includes(n)),
      `D2 段实有 ${d2Names.length} 条：${d2Names.join('、') || '（未解析到，检查 section 标题或 check 写法是否改名）'}`);

    /* ③ 独立实算：按 D2 的两条规则把 `git log` 的主题重新数一遍。
       规则参数（类型表、字数上限）从 docs-check 源码里读 —— 免得"两处各写一份规则"再次漂移。 */
    const { execFileSync } = require('node:child_process');
    const typesSrc = (d2Src.match(/const TYPES = \[([^\]]*)\]/) || [])[1] || '';
    const types = [...typesSrc.matchAll(/'([^']+)'/g)].map(m => m[1]);
    const lenLimit = Number((d2Src.match(/\.length\s*>\s*(\d+)\)/) || [])[1]);
    const gitLog = path.join(env.ensureDir(env.paths.tempRoot), `d2-subjects-${process.pid}.txt`);
    let subjects = [];
    try {
      const fd = fs.openSync(gitLog, 'w');
      try {
        execFileSync('git', ['log', '--pretty=format:%s'],
          { stdio: ['ignore', fd, 'ignore'], cwd: env.paths.root });
      } finally { fs.closeSync(fd); }
      subjects = fs.readFileSync(gitLog, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch { subjects = []; }
    try { fs.rmSync(gitLog, { force: true }); } catch { /* 忽略 */ }

    if (t.requires('能用 git 历史独立复核 D2 偏差条数（git 可读，且规则参数能从 docs-check 源码解析）',
      subjects.length > 0 && types.length >= 5 && Number.isInteger(lenLimit),
      `提交 ${subjects.length} 条 / 类型表 ${types.length} 个 / 字数上限 ${lenLimit}`)) {
      const badPrefix = subjects.filter(s => !new RegExp(`^(${types.join('|')}): \\S`).test(s));
      const tooLong = subjects.filter(s => s.replace(/^[^:]+:\s*/, '').length > lenLimit);
      const failedRules = (badPrefix.length ? 1 : 0) + (tooLong.length ? 1 : 0);
      const listed = badPrefix.length + tooLong.length;
      t.check('已登记偏差的**失败断言数** = git 历史实算（D2 两条断言各失败一条 → 2）',
        failedRules === reg.failedAssertions,
        `实算 ${failedRules} 条失败断言（缺前缀 ${badPrefix.length} 条 / 超 ${lenLimit} 字 ${tooLong.length} 条），常量写 ${reg.failedAssertions}`);
      /* ⚠ `E173`（2026-10-05，4b `T-20261005-12`）：本条的**标题里原本手写着三个数字**
         （"9 条缺前缀 + 4 条超字数 → 13"）—— 那是**没人核的常量**：`2c4f594` 那笔一出现，标题就与实算（14）不符，
         而它**不影响判据**（判据比的是 `listed === reg.listedItems`）⇒ 正是 `E156`／`E158` 同族
         "手写前提/数字会一直错下去"。改成**现算**后，标题永远等于它自己那条判据的读数；
         与本条同口径的**逐笔**守据见 `tests\docs-check.js` D7（`E173-①`：逐笔哈希双向 ＋ 冻结点 ＋ 与 `listedItems` 同步）。 */
      t.check('已登记偏差的**失败清单条数** = git 历史实算（' + badPrefix.length + ' 条缺前缀 + '
        + tooLong.length + ' 条超字数 → ' + listed + '）',
        listed === reg.listedItems,
        `实算 ${listed} 条 = 缺前缀 ${badPrefix.length} + 超字数 ${tooLong.length}，常量写 ${reg.listedItems}`);
    }

    /* ④ 真值表：带 summary 与失败清单，覆盖"条数边界"与"换了个断言继续失败"这两种真实场景 */
    const row = (name, status, failed, out) => ({ suite: { name }, status,
      summary: failed === null ? null : { passed: 0, failed, skipped: 0 }, out: out || '' });
    const failList = (...names) => '=== 汇总 ===\r\n通过 0 项，失败 ' + names.length + ' 项，跳过 0 项\r\n' +
      '\r\n失败清单：\r\n' + names.map((n, i) => `  ${i + 1}. ${n} —— 详情`).join('\r\n') + '\r\n';
    const a1 = reg.assertions[0], a2 = reg.assertions[1];
    const cases = [
      ['docs-check 失败数 = 登记数、断言名全在册 → 不阻止',
        [row('docs-check', 'failed', reg.failedAssertions, failList(a1, a2))], []],
      ['docs-check 失败数 > 登记数 → 阻止（不许用旧偏差掩盖新问题）',
        [row('docs-check', 'failed', reg.failedAssertions + 1, failList(a1, a2, '新加的 D2 断言'))], ['docs-check']],
      ['docs-check 条数没变但**换了断言**（出现未登记断言名）→ 阻止',
        [row('docs-check', 'failed', reg.failedAssertions, failList(a1, '新加的 D2 断言'))], ['docs-check']],
      ['docs-check 有输出却读不到失败清单（拿不出"已登记"的证据）→ 阻止',
        [row('docs-check', 'failed', reg.failedAssertions, '（脚本中途异常，没有汇总段）')], ['docs-check']],
      ['docs-check 异常（error）→ 阻止（已登记偏差只认 failed）',
        [row('docs-check', 'error', null, '')], ['docs-check']],
      ['docs-check 未核实（unverified）→ 阻止',
        [row('docs-check', 'unverified', null, '')], ['docs-check']],
      ['浏览器类脚本整脚本跳过（skipped）→ **不**阻止（本环境跑不了不算失败）',
        [row('browser-check', 'skipped', 0, '')], []],
      ['其他脚本失败 → 阻止',
        [row('db-check', 'failed', 6, '')], ['db-check']],
      ['已登记的 docs-check + 别的脚本失败 → 只报未登记的那个',
        [row('docs-check', 'failed', reg.failedAssertions, failList(a1, a2)), row('screenshot-diff', 'failed', 1, '')],
        ['screenshot-diff']],
      ['浏览器跳过 + 已登记的 docs-check → 都不阻止',
        [row('browser-check', 'skipped', 0, ''), row('docs-check', 'failed', reg.failedAssertions, failList(a1, a2))], []]
    ];
    const badCases = cases.filter(([, rows, want]) =>
      JSON.stringify(runAll4.authorityBlockers(rows)) !== JSON.stringify(want));
    t.check('authorityBlockers 真值表：条数边界 + 未登记断言 + error/unverified 阻止、skipped 不阻止',
      badCases.length === 0,
      badCases.length ? badCases.map(([title, rows, want]) =>
        `${title}：期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(runAll4.authorityBlockers(rows))}`).join('；')
        : `共 ${cases.length} 个场景逐条通过`);

    /* 反向单列一条：这是 P3-6 的要害 —— "旧偏差掩盖新问题"必须被挡下 */
    t.check('反向：docs-check 失败数超过登记数时必须出现在 blockers 里（防"用旧偏差掩盖新问题"）',
      runAll4.authorityBlockers([row('docs-check', 'failed', reg.failedAssertions + 1,
        failList(a1, a2, '新加的 D2 断言'))]).includes('docs-check'),
      `登记数 ${reg.failedAssertions}，实跑多 1 条 → 必须阻止比对`);

    /* ⑤ "未执行比对"的两个分支必须写明原因与涉及脚本名（P3-6 的另一半：跳过必须显式）
       ⚠ 集合口径（E50，2026-09-28 修）：**权威区覆盖的是全部 suite**（含浏览器/长跑脚本 ——
       它们在 `tests\README.md` 第三节被逐条登记），故"这轮跑全了没有"必须对**全量**判定；
       此前这里与 `run-all` 的实现都用 `!needBrowser` 当全集 ⇒ `--fast`（过滤 slow ＋
       needBrowser）下"缺脚本"检测不到，拿**全量**权威值去比**子集**实跑值，**误报
       "权威数字已漂移"**（现场离线体检报告第六节就是这么出现假红的）。夹具与实现必须同源，
       故一并改；E50 定点回归见本段末尾。 */
    const allSuites4 = runAll4.SUITES.map(s => s.name);
    const fullRun = (overrides) => allSuites4.map(n => overrides[n] || row(n, 'passed', 0, ''));
    const blocked = runAll4.verifyAuthorityTotals({ passed: 1 }, fullRun({
      'docs-check': row('docs-check', 'failed', reg.failedAssertions + 1, failList(a1, a2, '新加的 D2 断言')),
      'db-check': row('db-check', 'failed', 6, '')
    }));
    t.check('账目不完整时：比对**未执行**，且详情写明原因与涉及脚本名（不得只留一句"未核对"）',
      blocked.ok === false && blocked.kind === 'blocked' && /未执行/.test(blocked.detail) &&
      blocked.detail.includes('docs-check') && blocked.detail.includes('db-check'),
      blocked.detail);

    const partial = runAll4.verifyAuthorityTotals({ passed: 1 },
      fullRun({}).filter(r => r.suite.name !== 'copy-check'));
    t.check('离线门禁没跑全时：比对**未执行**，且详情点名缺失的脚本（--only 跑子集不该被当成漂移）',
      partial.ok === true && partial.kind === 'skipped' && /未执行/.test(partial.detail) &&
      partial.detail.includes('copy-check'),
      partial.detail);

    const ranAll = runAll4.verifyAuthorityTotals({ passed: 1 }, fullRun({}));
    t.check('账目干净时会**真的**走到比对（mismatch），而不是"未执行" —— 机制可达性的运行时旁证',
      ranAll.kind === 'mismatch' && !/未执行/.test(ranAll.detail), ranAll.detail);

    /* E50 定点回归（2026-09-28）：`--fast` 的子集形态必须落 `skipped`，**不得**判"权威数字已漂移"。
       构造方式与 runner 的 `--fast` 完全同源：`SUITES.filter(s => !s.slow && !s.needBrowser)`。 */
    const fastSuites = runAll4.SUITES.filter(s => !s.slow && !s.needBrowser).map(s => s.name);
    const fastMissing = allSuites4.filter(n => !fastSuites.includes(n));
    const fast = runAll4.verifyAuthorityTotals({ passed: 1 }, fastSuites.map(n => row(n, 'passed', 0, '')));
    t.check('E50 定点回归：`run-all --fast` 的子集（slow ＋ needBrowser 未跑）⇒ `kind=skipped`、`ok=true`，' +
      '且详情**点名**被跳过的脚本（判"漂移"即为回潮）',
      fast.ok === true && fast.kind === 'skipped' && /未执行/.test(fast.detail) &&
      fastMissing.length === 3 && fastMissing.every(n => fast.detail.includes(n)),
      `fast 缺失集=${JSON.stringify(fastMissing)}（期望 3 个）；实得 ok=${fast.ok}、kind=${fast.kind}；` +
      `detail=${fast.detail}`);

    /* E55 定点回归（2026-09-29）：**没有 git 的机器不得判"权威数字漂移"** —— 目标机可能没装 git，
       `harness-check` 少 2 条（依赖提交历史）、`docs-check` 的失败数也不同 ⇒ 合计与权威区**结构性不可比**。
       旧行为会报"权威数字已漂移，请同步 tests\README.md 第三节"（现场 2026-09-29 实测的**假红**）。 */
    const noGit = runAll4.verifyAuthorityTotals({ passed: 1 }, fullRun({}), { gitAvailable: false });
    t.check('E55 定点回归：本机无 git ⇒ `kind=skipped`、`ok=true`，详情写明"不可比／这不是漂移"（判 `mismatch` 即回潮）',
      noGit.ok === true && noGit.kind === 'skipped' && /不可比/.test(noGit.detail) && /这不是/.test(noGit.detail),
      `实得 ok=${noGit.ok}、kind=${noGit.kind}；detail=${noGit.detail}`);
    const withGit = runAll4.verifyAuthorityTotals({ passed: 1 }, fullRun({}), { gitAvailable: true });
    t.check('E55 正对照：**有** git 时照旧走到比对（新分支不得把正常路径一并吞掉）',
      withGit.kind === 'mismatch', `实得 kind=${withGit.kind}`);

    /* 静态守卫：两处新实现的**在场证明**（E54 的 Edge 版本断言、E55 的 docs-cross-check 环境跳过）——
       防"下一轮改动把它悄悄回退掉而没人发现"。 */
    const preflightSrc = fs.readFileSync(path.join(env.paths.tests, 'preflight.js'), 'utf8');
    const dccSrc = fs.readFileSync(path.join(env.paths.tests, 'docs-cross-check.js'), 'utf8');
    t.check('静态：`preflight` 含"Edge 主版本 ≥ 112"断言（E54）且 `docs-cross-check` 含"无 git 环境跳过"处理（E55）',
      /Edge 主版本 ≥ 112/.test(preflightSrc) && /GIT_DEPENDENT/.test(dccSrc) && /环境跳过（本机无 git）/.test(dccSrc),
      `preflight 命中=${/Edge 主版本 ≥ 112/.test(preflightSrc)}；docs-cross-check 命中=${/GIT_DEPENDENT/.test(dccSrc)}／${/环境跳过（本机无 git）/.test(dccSrc)}`);

  /* ---------------- E12 定点回归（2026-09-29 收口） ----------------
     登记原文（2026-09-20）：`run-all` 日志**命名撞名会造假绿** —— 按 `<脚本>-<runner pid>.log` 命名、
     同 pid 复用会撞旧文件 ⇒ `parseSummary` 取到**旧汇总行**，出现"失败脚本被印成 PASS"。
     三条修法：①文件名带 pid（已在）②运行前删同名旧文件（已在）③**以失败为优先解析**（本轮补）。
     这里把③做成定点回归：多行汇总时"前面绿、后面红"**必须判红**。 */
  t.check('E12 定点回归①：日志里"先绿后红"两条汇总行 ⇒ `parseSummary` 必须取**红**的那条（旧实现取首条 ⇒ 假绿）',
    (() => {
      const s = runAll4.parseSummary('=== 汇总 ===\n通过 40 项，失败 0 项，跳过 0 项\n（子套件）\n通过 3 项，失败 2 项，跳过 0 项\n');
      return s && s.failed === 2 && s.passed === 3 && s.worst === true && s.lines === 2;
    })(),
    `实测 ${JSON.stringify(runAll4.parseSummary('通过 40 项，失败 0 项，跳过 0 项\n通过 3 项，失败 2 项，跳过 0 项'))}`);
  t.check('E12 定点回归②：多条红行取 **failed 最大**者；全绿时取 **passed 最大**者（防"先打一行占位 0/0"）',
    (() => {
      const a = runAll4.parseSummary('通过 1 项，失败 1 项\n通过 5 项，失败 4 项\n');
      const b = runAll4.parseSummary('通过 0 项，失败 0 项，跳过 0 项\n通过 12 项，失败 0 项，跳过 0 项\n');
      return a && a.failed === 4 && b && b.passed === 12 && b.lines === 2;
    })(),
    `多红=${JSON.stringify(runAll4.parseSummary('通过 1 项，失败 1 项\n通过 5 项，失败 4 项'))}；全绿=${JSON.stringify(runAll4.parseSummary('通过 0 项，失败 0 项\n通过 12 项，失败 0 项'))}`);
  const runAllSrc12 = fs.readFileSync(path.join(env.paths.tests, 'run-all.js'), 'utf8');
  t.check('E12 静态守卫：日志名含 runner pid **且**运行前删同名旧文件（两条修法都必须在场，防回退）',
    /\$\{suite\.name\}-\$\{process\.pid\}\.log/.test(runAllSrc12) &&
    /fs\.rmSync\(logFile/.test(runAllSrc12) &&
    /worst: bad\.length > 0/.test(runAllSrc12),
    `命名=${/\$\{suite\.name\}-\$\{process\.pid\}\.log/.test(runAllSrc12)}；删旧=${/fs\.rmSync\(logFile/.test(runAllSrc12)}；失败优先=${/worst: bad\.length > 0/.test(runAllSrc12)}`);


  }
}
/* ---------------- 十二、"工作区稳定性"判定的真值表（2026-09-20 新增） ----------------
   立案原因：门禁最怕的**不是**失败，而是"**被测文件正在被别的进程写**"——那时读到的半写内容
   会被当成"代码坏了"。本会话已实际发生多起：`docs-cross-check` 报"files-check 实跑未产出可解析的
   汇总行"（该脚本正被并发写）、同一份 README 下 `harness-check` 的账本值在 94/92 之间翻面、
   变体被并发覆盖导致"计数在两次运行间翻面"，主代理据此误判子代理越界。
   判据：一轮运行内工作区被改写 ⇒ 该轮结论不得当作证据（横幅 + 跳过权威比对 + 非 0 退出）。

   本节只对**纯函数**做真值表（`snapshot.diffSnapshots` / `snapshot.isExcluded`），
   不依赖"真有人并发写我的仓库"这种不可复现的条件；`run-all` 侧的可达性与调用顺序在第十三节。 */
t.section('十二、工作区稳定性判定的真值表（运行期间被改写 ⇒ 本轮结论不可作证据）');
{
  const m = pairs => Object.fromEntries(pairs);
  const A = m([['src/a.js', 'h1'], ['src/b.js', 'h2'], ['tests/x-check.js', 'h3']]);

  {
    const got = snapshot.diffSnapshots({ files: A }, { files: m([['src/a.js', 'h1'], ['src/b.js', 'H2'], ['tests/x-check.js', 'h3']]) });
    t.check('内容变化被识别（kind=changed，且带上两轮哈希）',
      got.length === 1 && got[0].path === 'src/b.js' && got[0].kind === 'changed' &&
      got[0].before === 'h2' && got[0].after === 'H2', JSON.stringify(got));
  }
  {
    const got = snapshot.diffSnapshots({ files: A }, { files: m([['src/a.js', 'h1'], ['src/b.js', 'h2'], ['tests/x-check.js', 'h3'], ['tests/n.yml', 'hY']]) });
    t.check('新增文件被识别（kind=added，before=null）',
      got.length === 1 && got[0].path === 'tests/n.yml' && got[0].kind === 'added' && got[0].before === null,
      JSON.stringify(got));
  }
  {
    const got = snapshot.diffSnapshots({ files: A }, { files: m([['src/a.js', 'h1'], ['src/b.js', 'h2']]) });
    t.check('删除文件被识别（kind=removed，after=null）',
      got.length === 1 && got[0].path === 'tests/x-check.js' && got[0].kind === 'removed' && got[0].after === null,
      JSON.stringify(got));
  }
  {
    const got = snapshot.diffSnapshots({ files: A }, { files: { ...A } });
    t.check('稳定态返回空清单（**不是**"有变化但没打印"）', Array.isArray(got) && got.length === 0, JSON.stringify(got));
  }
  t.check('空清单边界：两份都空 → 空；空 → 有内容仍判**新增**（不许因"基线为空"就放行）',
    snapshot.diffSnapshots({ files: {} }, { files: {} }).length === 0 &&
    snapshot.diffSnapshots({ files: {} }, { files: m([['a.js', 'h']]) }).length === 1,
    '空清单不能当成"没有变化"的挡箭牌');
  t.check('缺失条目的边界：null/undefined/无 files 字段一律返回 []（**不抛错**），且不误报差异',
    snapshot.diffSnapshots(null, null).length === 0 &&
    snapshot.diffSnapshots(undefined, { files: A }).length === 0 &&
    snapshot.diffSnapshots({ files: A }, undefined).length === 0 &&
    snapshot.diffSnapshots({}, { files: {} }).length === 0 &&
    snapshot.diffSnapshots({ files: A }, { files: A }).length === 0,
    '入参缺失＝拿不到证据，由调用方另行处理（门禁里按"快照不可用"处理，不当成稳定）');
  t.check('多种改写同时发生时全部列出，且按路径排序（判据必须可复现，不能靠遍历顺序）',
    (() => {
      const got = snapshot.diffSnapshots({ files: A },
        { files: m([['src/a.js', 'H1'], ['src/c.js', 'h4'], ['tests/x-check.js', 'h3']]) });
      const paths = got.map(c => c.path);
      return got.length === 3 && paths.join('|') === 'src/a.js|src/b.js|src/c.js' &&
        JSON.stringify(paths) === JSON.stringify([...paths].sort());
    })(),
    'a 改内容 / b 被删 / c 新增 —— 三条都要在，且顺序稳定');
  t.check('路径统一为 posix 风格（跨平台清单可比、可打印；Windows 下 `path.relative` 会给反斜杠）',
    (() => {
      const r = snapshot.collectSnapshot();
      return Object.keys(r.files).every(p => !p.includes('\\')) && snapshot.toPosix('a\\b\\c.js') === 'a/b/c.js';
    })(), '');

  /* 排除规则：`tests\._verify\` 是本机制自己的落盘点（各脚本日志、账本、临时库），
     **必然**在运行期间被写；不排除则每轮都"不稳定"（D22 定点变异见下一条）。 */
  t.check('排除规则：`._verify` 路径段被排除（含运 runners 的 run-all 日志与账本），其它目录不误伤',
    snapshot.isExcluded('tests/._verify/run-all/x.log') &&
    snapshot.isExcluded('tests/._verify/run-totals.json') &&
    snapshot.isExcluded('tests/._verify/tmp/db/test.db') &&
    !snapshot.isExcluded('tests/README.md') &&
    !snapshot.isExcluded('src/x._verify.js') &&
    !snapshot.isExcluded('tests/foo/._verifyish/a.js'),
    '按**路径段**比较；`x._verify.js` 这类前缀不得误伤');
  {
    /* 真扫一遍（对临时目录采样，不动仓库）：`._verify` 下的改写必须看不见，`src/` 下的改写必须看见。
       为什么采样而不是扫真仓：本节断言的是"扫描器的过滤行为"，用临时目录既能证明行为，
       又不会因为"真仓里恰好写了什么"而红。 */
    const root = harness.makeTempDir('stability-scan');
    const put = (rel, text) => {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
    };
    put(path.join('src', 'a.js'), 'const a = 1;\n');
    put(path.join('server', 'b.sql'), 'select 1;\n');
    put(path.join('tests', '._verify', 'run-all', 'a.log'), 'x\n');
    put(path.join('tests', '._verify', 'run-totals.json'), '{}\n');
    put(path.join('src', 'assets', 'shot.png'), 'not-really-png\n');
    put(path.join('tests', 'screenshots-baseline', 'x.png'), 'not-really-png\n');
    const listed = () => {
      const snap = snapshot.collectSnapshot({ root });
      return Object.keys(snap.files).sort();
    };
    const beforeList = listed();
    put(path.join('tests', '._verify', 'run-all', 'a.log'), 'x changed\n');
    put(path.join('tests', '._verify', 'run-totals.json'), '{"changed":1}\n');
    const afterVerifyWrite = listed();
    const verifyInvisible = JSON.stringify(beforeList) === JSON.stringify(afterVerifyWrite);
    put(path.join('src', 'a.js'), 'const a = 2;\n');
    const afterSrcWrite = listed();
    const diff = snapshot.diffSnapshots(
      snapshot.collectSnapshot({ root: root, dirs: snapshot.PROJECT_DIRS }),
      { files: Object.fromEntries(afterSrcWrite.map(p => [p, 'x'])) });
    t.check('零误伤（真扫）：`._verify` 下的落盘（脚本日志与账本）**不**计入清单',
      verifyInvisible && !beforeList.some(p => p.includes('._verify')),
      `扫描器给出 ${beforeList.length} 个文件：${beforeList.join('、')}`);
    t.check('真扫：`src/` 下的内容改写会被清单看见（不是只扫不比对）；非文本文件（png）不入清单',
      diff.some(c => c.path === 'src/a.js') &&
      !beforeList.some(p => p.endsWith('.png')),
      `清单含 ${beforeList.filter(p => p.startsWith('src/')).join('、')}`);
    try { harness.removeLinkSafe(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  t.check('`describeChange` 的中文标签与 kind 一一对应（不稳定横幅直接复用它，不另写一份）',
    ['added', 'removed', 'changed'].every(k => /新增|删除|内容变化/.test(snapshot.describeChange({ path: 'a.js', kind: k }))) &&
    snapshot.describeChange({ path: 'a.js', kind: 'changed' }) === 'a.js（内容变化）',
    snapshot.describeChange({ path: 'a.js', kind: 'changed' }));

  t.check('快照自身可采（`collected === true`）且哈希取的是 SHA-256（64 位十六进制）',
    (() => {
      const snap = snapshot.collectSnapshot();
      const keys = Object.keys(snap.files);
      return snap.collected === true && keys.length > 0 &&
        keys.every(k => /^[0-9a-f]{64}$/.test(snap.files[k])) &&
        keys.every(k => snapshot.isTextFile(k)) &&
        keys.every(k => !snapshot.isExcluded(k));
    })(),
    (() => { const s = snapshot.collectSnapshot(); return `${Object.keys(s.files).length} 个文本文件；` +
      `root=${s.root}`; })());
  t.check('本机清单只覆盖约定的四棵树，且不含 `._verify` / 二进制（判据范围可复核）',
    (() => {
      const keys = Object.keys(snapshot.collectSnapshot().files);
      return keys.length > 0 &&
        keys.every(k => snapshot.PROJECT_DIRS.some(d => k.startsWith(d + '/'))) &&
        keys.every(k => snapshot.isTextFile(k) && !snapshot.isExcluded(k));
    })(),
    `范围：${snapshot.PROJECT_DIRS.join('、')}（共 ${Object.keys(snapshot.collectSnapshot().files).length} 个文本文件）`);
}

/* ---------------- 十三、稳定性判据与"跳过对账"的 runner 契约（含 D22 定点变异） ----------------
   第十二节证明"判定算得对"，本节证明"runner 真的按它办"：横幅、跳过权威比对、退出码、
   以及**调用顺序**（先复核稳定性，再对账）。D22：一条声称能挡住旧缺陷的断言，
   用**旧写法**跑也必须被挡下 —— 否则它就是恒真的装饰。 */
t.section('十三、稳定性判据与"跳过对账"的 runner 契约');
{
  const runAll5 = require('./run-all');
  const runAllSrc5 = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
  const authOk = { ok: true, kind: 'ok', detail: '权威区合计 1 ＝ 本轮实跑 1' };

  const unstableV = runAll5.resolveGateOutcome([{ path: 'src/a.js', kind: 'changed' }], authOk);
  t.check('不稳定 ⇒ 退出码非 0、标记 unstable、横幅含约定横幅头与"不可作为证据"',
    unstableV.exitCode !== 0 && unstableV.unstable === true &&
    unstableV.detail.includes('本轮运行期间工作区被改写（1 个文件）') &&
    unstableV.detail.includes('src/a.js') &&
    unstableV.evidence.includes('不可作为证据'),
    unstableV.detail);
  t.check('不稳定 ⇒ 证据标签写明"未与权威数字比对"（即使权威值当时是"对得上"）',
    /未与权威数字比对/.test(unstableV.evidence), unstableV.evidence);
  t.check('稳定 + 权威对账成功 ⇒ 退出码 0，且证据标签写明"权威数字已核对"',
    (() => {
      const v = runAll5.resolveGateOutcome([], authOk);
      return v.exitCode === 0 && v.unstable === false && v.titles.length === 0 &&
        /权威数字已核对/.test(v.evidence);
    })(), runAll5.resolveGateOutcome([], authOk).evidence);
  t.check('稳定但**未执行**比对（skipped）⇒ 不许谎称"已核对"、也不是失败',
    (() => {
      const v = runAll5.resolveGateOutcome([], { ok: true, kind: 'skipped', detail: '**未执行**：本轮未跑全离线门禁' });
      return v.exitCode === 0 && v.unstable === false && /未经权威数字核对/.test(v.evidence) &&
        !/已核对/.test(v.evidence);
    })(), runAll5.resolveGateOutcome([], { ok: true, kind: 'skipped', detail: 'x' }).evidence);
  t.check('稳定但权威数字漂移 ⇒ 退出码 1，且给出"同步 tests\\README.md 第三节"的处置',
    (() => {
      const v = runAll5.resolveGateOutcome([], { ok: false, kind: 'mismatch', detail: '权威区写 9，本轮实跑 1' });
      return v.exitCode === 1 && v.unstable === false &&
        v.titles.some(l => l.includes('处置：同步 tests\\README.md 第三节'));
    })(), '漂移仍是退出码 1');
  t.check('稳定但账目不完整（blocked）⇒ 退出码 1，且说明"已跳过权威数字比对"（没比对就是没核实）',
    (() => {
      const v = runAll5.resolveGateOutcome([], { ok: false, kind: 'blocked', detail: '**未执行**：本轮账目不完整' });
      return v.exitCode === 1 && v.titles.some(l => l.includes('已跳过') && l.includes('权威数字比对'));
    })(), 'blocked 由"只报告"收紧为失败：跳过对账不得当通过');

  /* 静态契约：不稳定轮**不许**打印权威数字校验那一行（任何写法都容易被读成"比过了"）。 */
  const authLineBranch = runAllSrc5.indexOf('verdict.unstable ?');
  t.check('静态：不稳定时**不打**权威数字校验那一行（`verdict.unstable ? \'\' : …`）',
    authLineBranch > 0 && /unstable\s*\?\s*''/.test(runAllSrc5.slice(authLineBranch, authLineBranch + 60)),
    authLineBranch > 0 ? '已找到该分支' : 'run-all 里找不到"不稳定轮不打对账行"的分支');
  t.check('静态：稳定性复核（`collectSnapshot` + `diffSnapshots`）先于对账（`verifyAuthorityTotals` 调用）',
    (() => {
      const after = runAllSrc5.indexOf('const snapAfter = snapshot.collectSnapshot()');
      const diffAt = runAllSrc5.indexOf('const rewriteChanges = snapshot.diffSnapshots(');
      const authAt = runAllSrc5.indexOf('const auth = verifyAuthorityTotals(');
      return after > 0 && diffAt > after && authAt > diffAt;
    })(), '顺序：结束快照 → 比对清单 → 对账（顺序反了就会拿"正在变"的账去比权威值）');

  /* ---------------- D22 定点变异：旧写法必须被上面的断言挡下 ---------------- */
  const legacyDiff = (before, after) => Object.keys(before.files || {})
    .filter(k => (after.files || {})[k] !== before.files[k])
    .map(k => ({ path: k, kind: 'changed' }));
  t.check('变异①：旧写法（只比双方都有的键、只看内容变化）漏掉**新增与删除** —— 被第十二节断言挡下',
    (() => {
      const before = { files: { 'a.js': 'h1' } };
      const rewritten = { files: { 'a.js': 'H1' } };                  // 内容变化：新旧写法都应看见
      const added = { files: { 'a.js': 'h1', 'b.js': 'h2' } };         // 新增：旧写法看不见
      const removed = { files: {} };                                  // 删除：旧写法靠"undefined ≠ 旧哈希"偶然看见
      /* 旧写法的真实盲区是**新增**：它只遍历旧清单的键，"本轮多出来的文件"根本没有机会被看见。
         删除能被旧写法偶然抓到（键还在、值变成 undefined）—— 这一条也要一并记下来，
         免得把旧写法说得比实际更糟（夸大同样会让人不信判据）。 */
      return legacyDiff(before, added).length === 0 && snapshot.diffSnapshots(before, added).length === 1 &&
        snapshot.diffSnapshots(before, added)[0].kind === 'added' &&
        legacyDiff(before, rewritten).length === 1 && snapshot.diffSnapshots(before, rewritten).length === 1 &&
        legacyDiff(before, removed).length === 1 && snapshot.diffSnapshots(before, removed).length === 1 &&
        snapshot.diffSnapshots(before, removed)[0].kind === 'removed';
    })(), '旧写法下"新增文件/删除文件"的轮次会被判成稳定（只有内容变化看得见）');
  t.check('变异②：若排除规则失效（把 `._verify` 一并纳入清单），本机制会把自己的落盘判成"工作区被改写" —— 被第十二节排除断言挡下',
    (() => {
      const all = snapshot.collectSnapshot({ excludeSegments: [] });
      const only = snapshot.collectSnapshot();
      const leaked = Object.keys(all.files).filter(p => p.includes('/._verify/'));
      const legacyVerdict = snapshot.diffSnapshots({ files: all.files }, { files: only.files });
      return leaked.length > 0 && legacyVerdict.some(c => c.path.includes('/._verify/')) &&
        snapshot.isExcluded(leaked[0]) && snapshot.diffSnapshots({ files: only.files }, { files: only.files }).length === 0;
    })(), (() => {
      const all = snapshot.collectSnapshot({ excludeSegments: [] });
      const leaked = Object.keys(all.files).filter(p => p.includes('/._verify/')).length;
      return `不排除时清单里多出 ${leaked} 个 ._verify 文件（每轮必然被写 → 每轮都"不稳定"）`;
    })());
  t.check('变异③：旧写法把"工作区被改写"只当警告、继续对账（退出码 0）—— 被第十三节的 `unstable ⇒ 退出码 ≠ 0` 挡下',
    (() => {
      const legacyOutcome = () => ({ exitCode: 0, compare: true });
      const legacy = legacyOutcome();
      return legacy.exitCode === 0 && legacy.compare === true &&
        runAll5.resolveGateOutcome([{ path: 'src/a.js', kind: 'changed' }], authOk).exitCode !== 0;
    })(), '旧写法：打个警告然后照旧与权威数字比对，把"文件正在变"读成"权威区漂移"');
  t.check('变异④：旧写法把"跳过对账（blocked）"当通过（退出码 0）—— 被第十三节的 blocked 断言挡下',
    (() => {
      const legacyBlocked = () => 0;
      const blockedV = runAll5.resolveGateOutcome([], { ok: false, kind: 'blocked', detail: '**未执行**：本轮账目不完整' });
      return legacyBlocked() === 0 && blockedV.exitCode !== 0;
    })(), '旧写法：`blocked` 只打印"未核对"然后按全绿退 0');
}

/* ---------------- 十四、最终退出码的组合判据（P1：有 FAIL 却退 0 并打印"门禁全绿"） ----------------
   事故（提交 `51eed59` 引入，2026-09-21 修）：`tests\run-all.js` 收尾把"最终退出码"交给
   `resolveGateOutcome` 一个来源决定，而那个纯函数**只建模"工作区稳定性 + 权威数字对账"**，
   不建模"有没有脚本失败" ⇒ 稳定 + 对账 ok 时返回 0 ⇒ 执行落到成功收尾，在有 `FAIL` 的轮次上
   打印"门禁全绿（无失败脚本）"并退 0（实测：`FAIL docs-check 41 / 2 / 0` 与"门禁全绿"同屏）。
   本节把两件事钉死：
     ① **真值表**：`failed`/`unverified` 非空 ⇒ 无条件 1（**含"失败项仅为已登记偏差"**）；
        判定层面的 `blocked`/`mismatch`/`broken`/`unstable` ⇒ 1；`skipped`（子集）与"干净轮" ⇒ 0。
     ② **可达性静态断言**：源码里"门禁全绿"那句必须只在"失败集合为空"的路径上可达。
   真值表与静态断言各自都能被**定点变异**证伪（见下方变异⑤）—— 只写静态文本检查会漏掉
   "函数体被改成只看 exitCode"，这正是事故本体的形状。 */
t.section('十四、最终退出码的组合判据（有 FAIL 不得退 0／"门禁全绿"不得被顺带打印）');
{
  const runAll6 = require('./run-all');
  const runAllSrc6 = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
  const gateSrc = runAllSrc6.split(/\r?\n/);

  /* 真值表用的最小夹具：`finalExitCode` 只读 suite.name / 数组长度，故无需真结果对象。 */
  const script = name => ({ suite: { name } });
  const verdictOf = code => ({ unstable: false, exitCode: code, titles: [], detail: '', evidence: '' });
  const codeOf = (failed, unverified, verdict) => runAll6.finalExitCode({ failed, unverified, verdict });

  t.check('组合判据是纯函数且已导出（真值表与 D22 变异都要直接调它）',
    typeof runAll6.finalExitCode === 'function', typeof runAll6.finalExitCode);

  t.check('有失败脚本（判定层面"稳定 + 对账 ok"⇒ exitCode 0）⇒ **最终仍退 1** —— 事故本体',
    codeOf([script('docs-check')], [], verdictOf(0)) === 1 &&
    codeOf([script('ui-check'), script('db-check')], [], verdictOf(0)) === 1,
    `failed=1/verdict=0 ⇒ ${codeOf([script('docs-check')], [], verdictOf(0))}（修复前是 0）`);

  t.check('**失败项仅为已登记偏差**（docs-check 2 项 6.4 偏差）⇒ 仍退 1（豁免只免"阻止对账"，不免退出码）',
    (() => {
      /* 用真实的已登记偏差判据造这条场景：它是"能继续对账"的，绝不能因此被算成"全绿"。 */
      const dev = { suite: { name: 'docs-check' }, status: 'failed',
        summary: { passed: 41, failed: 2, skipped: 0 }, out: '' };
      const blocked = runAll6.authorityBlockers([dev]);
      return blocked.length === 0 && codeOf([dev], [], verdictOf(0)) === 1;
    })(), '已登记偏差：对账放行（blockers 空），退出码仍为 1 —— 两件事必须分开建模');

  t.check('未核实脚本（退出码 0 但拿不出断言证据）⇒ 非 0，与失败同档',
    codeOf([], [script('browser-check')], verdictOf(0)) === 1 &&
    codeOf([], [script('browser-check')], { unstable: false, exitCode: 1 }) === 1,
    `failed=0/unverified=1 ⇒ ${codeOf([], [script('browser-check')], verdictOf(0))}`);

  t.check('`blocked` / `mismatch` / `broken` / 不稳定（判定层面 exitCode 1）⇒ 1，与失败集合无关',
    codeOf([], [], verdictOf(1)) === 1 && codeOf([], [], verdictOf(2)) !== 0 &&
    codeOf([], [], { unstable: true, exitCode: 1 }) === 1,
    '四类判定层不通过都由 verdict.exitCode 带出来（本函数不得把它抹成 0）');

  t.check('干净轮（无失败/未核实 + 判定层面 0，含 `skipped` 子集轮）⇒ 0 —— 不得把正常形态误判为失败',
    codeOf([], [], verdictOf(0)) === 0 &&
    /* `--only contract-check`：对账 skipped 仍是 exitCode 0，最终码必须跟着是 0 */
    codeOf([], [], verdictOf(0)) === 0 &&
    codeOf([], [], { unstable: false, exitCode: 0 }) === 0,
    '`skipped`（未跑全离线门禁）不构成失败：既有语义不变');

  t.check('组合判据**不许**只看 `verdict.exitCode`（旧写法的定义式：那样上面第 2 条必红）',
    !/return\s+verdict\.exitCode\s*;/.test(runAllSrc6) &&
    /failed\.length\s*>\s*0/.test(runAllSrc6.slice(runAllSrc6.indexOf('function finalExitCode'))),
    '函数体里必须出现"失败集合非空即 1"这一支');

  /* ---------------- "门禁全绿"的可达性：静态守住，不靠"上面的提前退出顺便保证" ---------------- */
  /* 锚点取**唯一的完整字面量**（含 `\n` 转义与句号）：只搜"门禁全绿"四个字会先命中上方注释。 */
  const greenNeedle = "console.log('\\n门禁全绿（无失败脚本）。')";
  const greenAt = runAllSrc6.indexOf(greenNeedle);
  const guardAt = greenAt > 0 ? runAllSrc6.lastIndexOf('if (failed.length === 0 && unverified.length === 0) {', greenAt) : -1;
  /* 守卫块的收口大括号靠**配对扫描**取（跳过字符串与注释）：直接 `foundAt + indexOf('}')` 会命中
     `else {` 左近的括号，`lastIndexOf('}', greenAt)` 又会退到 `} else if` 去 —— 两种都会把块切错。 */
  const matchBrace = (src, openAt) => {
    let depth = 0;
    for (let i = openAt; i < src.length; i++) {
      const ch = src[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        for (i++; i < src.length && src[i] !== ch; i++) { if (src[i] === '\\') i++; }
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
      if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return -1; i++; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  };
  const guardBrace = guardAt > 0 ? runAllSrc6.indexOf('{', guardAt) : -1;
  const guardEnd = guardBrace > 0 ? matchBrace(runAllSrc6, guardBrace) : -1;
  const greenBlock = guardEnd > guardBrace && greenAt < guardEnd ? runAllSrc6.slice(guardBrace, guardEnd) : '';
  const lineOf = at => runAllSrc6.slice(0, at).split(/\r?\n/).length;
  t.check('静态：`门禁全绿` 那句 `console.log` 唯一一处，且落在 `if (failed.length === 0 && unverified.length === 0)` 的块内',
    greenAt > 0 && runAllSrc6.split(greenNeedle).length - 1 === 1 && guardAt > 0 && guardEnd > guardBrace &&
      greenAt < guardEnd && greenBlock.includes(greenNeedle),
    greenAt > 0
      ? `源码第 ${lineOf(greenAt)} 行；守卫在第 ${lineOf(guardAt)} 行、块收口在第 ${lineOf(guardEnd)} 行`
      : '源码里找不到那句"门禁全绿"');
  t.check('静态：那句 `console.log` 之后经 `} else { … process.exit(1) }` 紧跟 `process.exit(0)`（打印与退 0 成对、中间无第二个成功出口）',
    greenAt > 0 && /门禁全绿（无失败脚本）。'\);\r?\n\s*\}\s*else\s*\{[\s\S]{0,220}?process\.exit\(1\);\r?\n\s*\}\r?\n\s*process\.exit\(0\);/
      .test(runAllSrc6.slice(greenAt, greenAt + 400)),
    '打印"全绿"之后不许继续走到别的收尾；守卫的 else 支只能是退 1 的兜底');
  t.check('静态：提前退出用组合后的 `finalCode`，且它取自 `finalExitCode({ failed, unverified, verdict })`',
    (() => {
      const finalAt = runAllSrc6.indexOf('const finalCode = finalExitCode({ failed, unverified, verdict });');
      const exitAt = runAllSrc6.indexOf('if (finalCode !== 0) {');
      const greenPool = runAllSrc6.indexOf(greenNeedle);
      /* 反向断言：**提前退出那处**不得再拿 `verdict.exitCode` 当判据 —— 事故本体就是
         `if (verdict.exitCode !== 0) { … }` 把"脚本失败"整段漏掉。措辞分支里的
         `} else if (verdict.exitCode !== 0) {`（只选打印哪句话、不退出）不算违规，故按行首形态区分。 */
      const oldGuard = /(^|\r?\n)\s*if \(verdict\.exitCode !== 0\) \{/.test(runAllSrc6);
      return finalAt > 0 && exitAt > finalAt && greenPool > exitAt && !oldGuard;
    })(),
    '提前退出的判据必须是组合后的最终码；旧写法行首的 `if (verdict.exitCode !== 0) {` 就是事故入口');
  t.check('静态：权威对账行在**失败分支与绿轮收尾**各打印一次（旧实现只在失败分支打印，绿轮丢弃）',
    runAllSrc6.split("fs.writeSync(1, authLine + '\\n')").length - 1 === 2 &&
      runAllSrc6.includes('if (authLine) fs.writeSync(1, authLine'),
    `源码里该打印语句出现 ${runAllSrc6.split("fs.writeSync(1, authLine + '\\n')").length - 1} 次（应为 2）`);

  /* 立案（2026-09-22 座位 R）：`node tests\harness-check.js` 偶发 133 通过 / 1 失败，红的就是下面那条端到端断言，
     失败明细形如 `退出码 1｜FAIL docs-check 有｜"门禁全绿" 缺（应为"缺"）` —— 即它的第四条判据
     `t2.includes('门禁结论：不通过')` 取不到。**实测根因不是截断**：N=20 次 `--no-preflight --only docs-check`
     有 4 次取不到该字面量，但每次日志尾部都**完整且以 `\n` 结尾**（尾部原文："门禁结论：**本轮不通过**
     （工作区在运行期间被改写，结论不可作为证据）。"）—— 真正的根因是**结论行 token 不统一**：
     并发写方在改 `tests\ui-check.js` 时，`lib/snapshot.js` 的稳定性判定按设计把该轮判成"不稳定"，
     于是 run-all 走的是**另一句措辞**，那句话里没有"门禁结论：不通过"这个机器可读的 token
     （run-all 侧已按此把四句结论统一成同一 token）。
     故冻结：run-all 里**每一句**打印结论的行都必须带 `门禁结论：不通过`；并要求 ≥ 4 处 ——
     防"把结论行删掉"这种把断言弄成恒真的绕过（本断言只认**打印语句行**：含 `console.log(` 或 `fs.writeSync(`）。 */
  const verdictToken = '门禁结论：不通过';
  const verdictPrints = runAllSrc6.split(/\r?\n/)
    .filter(l => /console\.log\(|fs\.writeSync\(/.test(l) && l.includes('门禁结论：'));
  const verdictMissing = verdictPrints.filter(l => !l.includes(verdictToken));
  t.check('静态：run-all 每句"门禁结论"打印都带 `门禁结论：不通过` 这个 token（不稳定轮也不例外；≥4 处，防删行绕过）',
    verdictPrints.length >= 4 && verdictMissing.length === 0,
    `结论打印语句 ${verdictPrints.length} 处（应 ≥ 4），缺 token 的 ${verdictMissing.length} 处`
      + (verdictMissing.length ? `：${verdictMissing.map(l => l.trim().slice(0, 56)).join(' ｜ ')}` : ''));

  /* ---------------- 端到端：真跑一次 runner，看输出里到底有没有对账行（防"静态看着对、跑起来没有"） ----------------
     为什么要真跑：本节上面所有断言都是**对源码文本/纯函数**的检查，而本次回归恰恰是
     "文本都对、跑起来结论错"这一类（实测：同一分支里相邻的 `console.log` 能打印、`authLine` 那行没有产出）。
     **只允许 `--only <单个脚本>`**：跑全量会把 harness-check（本脚本）自己再拉起来一层，
     而本节的端到端断言又在那一层里再 spawn —— 实测直接递归到拿不到任何输出（status=null）。
     `docs-check` 这条既是"有 FAIL 的轮次"（41/2 已登记偏差）又足够快，且不会递归。 */
  const runAllPath = path.join(__dirname, 'run-all.js');
  const runOnly = suite => {
    const tmpOut = path.join(os.tmpdir(), `t1-runall-${process.pid}-${suite}.log`);
    const fd = fs.openSync(tmpOut, 'w');
    const r = spawnSync(process.execPath, [runAllPath, '--no-preflight', '--only', suite],
      /* `DSH_JOBS: '1'` 仍然**必须**：嵌套轮验的是"结论规则"，不许继承外层并行度而引入与被验规则
         无关的时序差异。⚠ 历史理由已**失效**（`E70` 收口，2026-10-03）：原文写的是"本脚本第十节会把
         `tests\README.md` 改掉再还原，嵌套轮会撞上它而判'工作区被改写'"—— 第十节现在**只改受控副本**、
         真文件全程只读 ⇒ 那条通道已关闭。保留 `DSH_JOBS: '1'` 是为确定性（且 `--only` 本就被
         `run-all.scheduleSuites()` 强制串行），**不是**为绕开那个已消失的写入。 */
      { cwd: path.join(__dirname, '..'), stdio: ['ignore', fd, fd], timeout: 120 * 1000, env: { ...process.env, DSH_JOBS: '1' } });
    fs.closeSync(fd);
    const text = fs.readFileSync(tmpOut, 'utf8');
    fs.rmSync(tmpOut, { force: true });
    return { status: r.status, text, error: r.error ? (r.error.code || r.error.message) : '' };
  };
  let failRun = null;
  let censusBeforeC = null;
  let censusAfterC = null;
  let managedChangedC = [];
  t.check('端到端：跑含 FAIL 的轮次（`--only docs-check`）⇒ 退出码 1、打印 FAIL 行，且**不含**"门禁全绿"',
    (() => {
      /* `E70-C` 的取样点：这一轮是**真跑一轮门禁**（`node tests\run-all.js --only docs-check`）——
         受管文件不变量（"跑一轮门禁后，受管文件的 sha256 与本轮开始时相同"）就挂在这里。 */
      censusBeforeC = managedGuardCensus();
      failRun = runOnly('docs-check');
      censusAfterC = managedGuardCensus();
      managedChangedC = managedGuardDiff(censusBeforeC, censusAfterC);
      const t2 = failRun.text;
      return failRun.status === 1 && /FAIL {2}docs-check/.test(t2) && !t2.includes('门禁全绿') &&
        t2.includes('门禁结论：不通过');
    })(), (() => {
      if (!failRun) return '未能取到该轮输出';
      const has = s => (failRun.text.includes(s) ? '有' : '缺');
      return `退出码 ${failRun.status}${failRun.error ? `（spawn 错误 ${failRun.error}）` : ''}`
        + `｜FAIL docs-check ${has('FAIL  docs-check')}｜"门禁全绿" ${has('门禁全绿')}（应为"缺"）`;
    })());
  /* `E70-C`（甲组的**通用**端到端形态）：**跑一轮门禁后，受管文件的 sha256 与本轮开始时相同**
     （至少 `tests\README.md`）。受管面清单与"为什么是这些"见文件顶部 `managedGuardCensus()` 的注释
     （普查结果：受管面共 **93** 个文本文件 ＋ **11** 个基准目录条目（＝`tests\screenshots-baseline\` 下
      **10 张 PNG** ＋ 该目录的 `README.md`；`pngCount` 数的是"目录里的文件数"，那个 `README.md`
      同时也在 93 里 ⇒ 打印值要按"93 文本 ＋ 11 条目"读，**不是**"93 ＋ 11 张图"）；全量门禁轮里**唯一**曾被运行期改写的受管文件
     就是 `tests\README.md`，写入点正是本脚本第十节 —— `E70` 已把它改成只写受控副本；
     `tests\screenshots-baseline\*` 的唯一写入点是人工开关 `capture-baseline --update`，门禁轮从不带它）。
     ⚠ **`E113`（2026-10-04）：同一个"受管文本数"为什么会在本文件里出现 92 与 93 两个值** ——
     本行原写的 `92` 是 `dfb6e45`（`E70` 收口那一笔）**当时实测的正确值**；同一批紧接着的
     `6973c47`（`E9` 新增 `tests\offline-check.js`）把受管文本 **92 → 93**（新增的 `.js` 落在
     `tests\` 下，正是 `snapshot.PROJECT_DIRS` 的四个目录之一，且扩展名在 `TEXT_EXTS` 里），
     而稍后 `22b2a53`（`E104`）新写的那两处已经写 93 ⇒ **不是"谁算错了"，是"先写下的数字被同一批
     的后一笔改动追上了"**。逐版本实算（只列文件名、不引入行号）：`dfb6e45`=92／`6973c47`=93／
     `22b2a53`=93／`HEAD`=93。**防再漂的写法**：受管面数字**只从运行时打印取**（`textCount` 是
     动态算出来的）；注释里再引用它时，要么写"见运行时打印"，要么与本节一起同步改。
     ⚠ 如实记账（本条的边界）：若**他路**在窗口内改写受管文件（并行开发期），这条同样会红 ——
     与 `run-all` 自己的"工作区稳定性"同一口径（那时本轮结论不可作证据，须停笔后复跑）；
     本条窗口只有一轮 `--only docs-check`（≈6 s），比 run-all 自身的全量窗口窄。 */
  t.check('E70-C 结构性不变量：**真跑一轮门禁**（`run-all --only docs-check`，退出码 1 的失败轮同样要守）之后，' +
    '受管文件的 sha256 与本轮开始时逐个相同（有变化即**逐条指名**）',
    managedChangedC.length === 0 && Boolean(censusBeforeC) && censusBeforeC.collected
      && Boolean(censusAfterC) && censusAfterC.collected,
    `受管面 ${censusBeforeC ? censusBeforeC.textCount : '?'} 个文本文件 ＋ ${baselineEntriesPhrase(censusBeforeC)}；`
      + `采集可用=${censusBeforeC ? censusBeforeC.collected : '?'}/${censusAfterC ? censusAfterC.collected : '?'}`
      + `（${(censusBeforeC && censusBeforeC.reason) || '无异常'}）；被改动的受管文件 ${managedChangedC.length} 个`
      + (managedChangedC.length ? `：${managedChangedC.join('；')}` : ''));
  /* E19（登记 2026-09-22，2026-09-29 收口）：`--only contract-check` 这一轮**要求是稳定绿轮**，
     但写方撞上它 ~1 s 的窗口时 `lib/snapshot.js` 会判"工作区被改写 ⇒ 本轮不可作证据" ⇒ 退出码 1、
     且**不会**打印"门禁全绿" ⇒ 断言**假红**（实测 N=30 里 1 次；并行开发期约 3%）。
     ⚠ 原实现还把 `runOnly` 跑了**两遍**（谓词一遍、明细一遍）⇒ 撞车概率翻倍，一并修掉。
     修法（采纳登记里的①＋②）：把"这轮属于哪一类"抽成**纯函数**（可定点回归）：
       · unstable（带"工作区被改写／不可作证据"措辞）⇒ **可重试**（最多 3 次尝试）；
       · green（退出码 0 且打出"门禁全绿"）⇒ 通过；
       · bad（其余）⇒ **真失败绝不重试**（不许把 FAIL 重试成绿）；
     连续都撞上并发写盘 ⇒ **按"环境不满足"跳过**并写明原因 —— 环境问题不得伪装成断言失败。

     ---------------- `E98`：这条判据的**第二种**偶发假红（`T-20261003-08` 乙组定位，2026-10-03） ----------------
     现象：单跑 `harness-check` 时出现过 `341/1/2`，红项就是下面这条，读数是 `尝试序列 1:bad(exit=1)`；
     随后同命令与 `run-all --fast` 内均 `342/0/2`；**纯净 HEAD 导出上同样复现**（`339/1`）⇒ 与本日改动无关。
     定位到可复述的机制（既有的**端口硬编码**，不是判据写错）：
       ① `tests\contract-check.js` 把"假 MES"跑在**进程内**，端口**写死**：18897／18898／18899
          （`contract-check.js:581-588`）与 18896（`:834`）；`tools\mock-mes\mock-mes.js:197`
          只有 `server.listen(args.port, …)`，**没有** `'error'` 监听。
       ② 端口已被占用时 ⇒ Node 抛未捕获事件 `Error: listen EADDRINUSE: address already in use :::18899`
          ⇒ contract-check **当场退出 1，且来不及打印 `=== 汇总 ===`**
          ⇒ `run-all` 记 `FAIL  contract-check  — / — / —` ⇒ `finalExitCode` = 1
          ⇒ 打印 `门禁结论：不通过（有失败/未核实脚本，见上面的明细）。`
          ⇒ **没有**"门禁全绿"，也**没有**"工作区被改写"措辞。
       ③ 于是 `attemptKind` 落到 `bad`（不是 `unstable`）⇒ **不重试**，断言当场红。
          ⇒ 这就是 `1:bad(exit=1)` 的全部来路：**"环境被占"被当成了"真失败"**。
     现场证据（本机 `tests\._verify\run-all\`，2026-10-03 **15:19:27／15:19:37／15:20:58**）：
     同一秒里出现成对的 `contract-check-<pid>.log` —— 一对里**一个 12197 B（抢到端口，成功）、
     另一个 3920 B（`EADDRINUSE` 崩掉）**，且各自配套 `docs-check-/files-check-/logic-check-/
     db-check-/trace-check-<同样两个 pid>` ⇒ **当时确有两个（乃至四个）门禁轮在并发跑**
     （每轮 §15 的嵌套子集轮里都含 contract-check）⇒ 固定端口互撞。
     复现手法（**确定性**，见 `tests\._verify\review\t20261003-08\probe-e98-port.js`）：
       A 窗口：`node -e "require('net').createServer().listen(18899)"`（务必**不指定 host**，
               与 mock-mes 同为 `:::18899`；只绑 `127.0.0.1` 时 Windows 允许双栈并存 ⇒ 变成
               "连上了但没人应答"，而 `startMockMes` 的 `fetch` **无超时** ⇒ 挂到 120 s 超时）
       B 窗口：`node tests\run-all.js --no-preflight --only contract-check`
       ⇒ 退出码 1 ＋ 无汇总行 ＋ stdout 含 `listen EADDRINUSE` ＋ 无"门禁全绿" ＋**有**权威对账行。
     顺手把它修成**确定性**（ADR-0004 D21/D23：**不删判据、不改期望**）：给"**有证据的端口冲突**"
     单开一类 `collided`，与 `unstable` 同样**可重试**（最多 3 次）。**证据门槛**＝退出码非 0
     ＋ 输出里真的出现 `EADDRINUSE` ＋ **没有**"门禁全绿"；真失败（断言失败/未核实）照样是 `bad`
     且**不重试**；连续 3 次都撞 ⇒ 按"环境不满足"**跳过**并写明是端口冲突（不得伪装成通过）。 */
  const UNSTABLE_NEEDLE = /本轮运行期间工作区被改写|不可作为证据/;
  /* `E98` 的证据门槛：`EADDRINUSE` 只可能来自 contract-check 在进程内绑死端口那一步（见上） */
  const COLLISION_NEEDLE = /EADDRINUSE/;
  const GREEN_LINE = '门禁全绿（无失败脚本）。';
  const attemptKind = (code, text) => {
    if (UNSTABLE_NEEDLE.test(text)) return 'unstable';
    if (code === 0 && text.includes(GREEN_LINE)) return 'green';
    /* ⚠ 顺序与门槛都要紧：`collided` 必须在 `bad` **之前**、且**只**认"非 0 ＋ 有端口冲突证据 ＋
       没有全绿行"。若把它做成"失败就归环境"（去掉证据门槛），真失败会被重试掉（D21 禁止）。 */
    if (code !== 0 && COLLISION_NEEDLE.test(text) && !text.includes(GREEN_LINE)) return 'collided';
    return 'bad';
  };
  /* 旧规则（**没有** `collided` 那一支）—— 供定点回归证明"这条修法是承重的"（去掉即回到 `1:bad(exit=1)`） */
  const legacyAttemptKind = (code, text) => {
    if (UNSTABLE_NEEDLE.test(text)) return 'unstable';
    if (code === 0 && text.includes(GREEN_LINE)) return 'green';
    return 'bad';
  };
  /** 把一次尝试的**逐项读数**摘出来（E98 要求"逐次读数打印"：两行到底有没有、有没有被挤掉/截断） */
  const readAttempt = (sub, i) => {
    const text = sub.text || '';
    const lines = text.split(/\r?\n/);
    const pick = re => lines.filter(l => re.test(l)).map(l => l.trim()).slice(0, 4);
    return {
      n: i + 1, kind: attemptKind(sub.status, text), exit: sub.status, error: sub.error || '',
      bytes: Buffer.byteLength(text),
      green: text.includes(GREEN_LINE),
      authLine: text.includes('权威数字校验：'),
      authNotRun: text.includes('权威数字校验：**未执行**：本轮未跑全离线门禁'),
      unstable: UNSTABLE_NEEDLE.test(text),
      row: pick(/^\s*(PASS|FAIL|ERR |\?\?\? )\s+contract-check\b/),
      fails: pick(/^\s*FAIL\s+/),
      collision: pick(/EADDRINUSE|Unhandled 'error' event|门禁结论：/),
      tail: lines.filter(l => l.trim()).slice(-2).map(l => l.trim().slice(0, 110))
    };
  };
  const fmtAttempt = r => `#${r.n} kind=${r.kind} exit=${r.exit}${r.error ? `（${r.error}）` : ''} bytes=${r.bytes}`
    + `｜"门禁全绿"=${r.green ? '有' : '缺'}｜权威对账行=${r.authLine ? (r.authNotRun ? '有（未执行：未跑全离线门禁）' : '有') : '缺'}`
    + `｜不稳定措辞=${r.unstable ? '有' : '缺'}`
    + (r.row.length ? `｜结果表=${r.row[0]}` : '')
    + (r.collision.length ? `｜冲突/结论=${r.collision.join(' ／ ').slice(0, 120)}` : '')
    + `｜尾部=${JSON.stringify(r.tail[r.tail.length - 1] || '')}`;

  t.check('E19 定点回归①：`attemptKind` 三态 —— 不稳定轮⇒unstable（可重试）／绿轮⇒green／**真失败⇒bad（不得被重试掉）**',
    attemptKind(1, '本轮运行期间工作区被改写（1 个文件）… 该轮不可作为证据') === 'unstable' &&
    attemptKind(0, GREEN_LINE) === 'green' &&
    attemptKind(1, 'FAIL  docs-check  41 / 2 / 0\n门禁结论：不通过') === 'bad' &&
    attemptKind(0, '（没有"门禁全绿"字样）') === 'bad',
    `unstable=${attemptKind(1, '本轮运行期间工作区被改写（1 个文件）')}；` +
    `green=${attemptKind(0, GREEN_LINE)}；bad=${attemptKind(1, 'FAIL  x')}；` +
    `code0无措辞=${attemptKind(0, '（无措辞）')}`);
  t.check('E19 定点回归②：**不稳定措辞优先于退出码** —— 即使 exit=0，只要带"工作区被改写"也不得当成绿轮证据',
    attemptKind(0, GREEN_LINE + '\n（本轮运行期间工作区被改写）') === 'unstable',
    `实测 ${attemptKind(0, GREEN_LINE + '\n（本轮运行期间工作区被改写）')}`);
  /* ---------------- `E98` 定点回归：端口硬编码被占 ⇒ 归"有证据的环境条件"，但**不得**吞掉真失败 ---------------- */
  const COLLISION_TEXT = '  ── 运行 contract-check（字段契约与适配层）──\n'
    + 'node:events:505\n    throw er; // Unhandled \'error\' event\n\n'
    + 'Error: listen EADDRINUSE: address already in use :::18899\n'
    + '    at Server.listen (node:net:2562:7)\n'
    + '  FAIL  contract-check          — / — / —   字段契约与适配层\n'
    + '权威数字校验：**未执行**：本轮未跑全离线门禁（缺 15 个：…）\n'
    + '门禁结论：不通过（有失败/未核实脚本，见上面的明细）。';
  const REAL_FAIL_TEXT = '  FAIL  contract-check          58 / 4 / 0   字段契约与适配层\n'
    + '门禁结论：不通过（有失败/未核实脚本，见上面的明细）。';
  t.check('E98 定点回归①：端口被占（contract-check 进程内绑死 18896～18899 ⇒ 未捕获 `EADDRINUSE`、退出 1、无汇总行）' +
    '⇒ 归 **`collided`**（有证据的**环境条件**，可重试）；**同一段文本在旧规则下是 `bad`**（＝不重试、当场红 —— 现场那条 `1:bad(exit=1)`）',
    attemptKind(1, COLLISION_TEXT) === 'collided' && legacyAttemptKind(1, COLLISION_TEXT) === 'bad'
      && attemptKind(null, COLLISION_TEXT) === 'collided',
    `新规则=${attemptKind(1, COLLISION_TEXT)}；旧规则=${legacyAttemptKind(1, COLLISION_TEXT)}`);
  t.check('E98 定点回归②：`collided` **不得**吞掉真失败 —— 同样 exit=1、同样没有"门禁全绿"，' +
    '只要输出里**没有** `EADDRINUSE` 证据就必须是 `bad`；"既有端口错又有全绿行"这种自相矛盾的输出也不许当环境问题',
    attemptKind(1, REAL_FAIL_TEXT) === 'bad' && legacyAttemptKind(1, REAL_FAIL_TEXT) === 'bad'
      && attemptKind(1, COLLISION_TEXT + '\n' + GREEN_LINE) === 'bad'
      && attemptKind(0, COLLISION_TEXT) === 'bad',
    `真失败文本=${attemptKind(1, REAL_FAIL_TEXT)}（须 bad）；`
      + `"冲突＋全绿"矛盾输出=${attemptKind(1, COLLISION_TEXT + '\n' + GREEN_LINE)}（须 bad）；`
      + `exit=0 但带端口错=${attemptKind(0, COLLISION_TEXT)}（须 bad）`);
  let greenSub = null;
  let lastKind = '';
  const subAttempts = [];
  const attemptReadings = [];
  for (let i = 0; i < 3; i++) {
    const sub = runOnly('contract-check');
    const reading = readAttempt(sub, i);
    attemptReadings.push(reading);
    const kind = reading.kind;
    subAttempts.push(`${i + 1}:${kind}(exit=${sub.status})`);
    lastKind = kind;
    /* green/bad 都停（bad **不重试**）；unstable 与 collided 是**可重试的环境条件** */
    if (kind !== 'unstable' && kind !== 'collided') { greenSub = sub; break; }
  }
  /* **逐次读数一律打印**（E98 定位要求：第几次、退出码、"门禁全绿"与权威对账行到底有没有、
     有没有被挤掉/截断）。成功轮也打 —— 只有每次都留下读数，偶发才有现场可查。 */
  t.info('E19/E98 尝试读数（每行一次尝试）：' + (attemptReadings.length
    ? '\n        ' + attemptReadings.map(fmtAttempt).join('\n        ')
    : '（无）'));
  if (lastKind === 'unstable' || lastKind === 'collided') {
    t.skip('端到端：跑 `--only contract-check`（无失败脚本）⇒ 退出码 0，打印"门禁全绿"且同时打印权威对账行',
      `连续 ${subAttempts.length} 次都没拿到绿轮：${lastKind === 'collided'
        ? '**本机回环端口 18896～18899 被占**（`contract-check.js:581-588/834` 把假 MES 的端口写死，'
          + '`tools\\mock-mes\\mock-mes.js:197` 的 `listen` 没有 `error` 监听 ⇒ 未捕获 `EADDRINUSE` ⇒ 退出 1、无汇总行）'
        : '撞上并发写盘（工作区被改写 ⇒ 该轮不可作证据）'}`
      + ` —— **环境不满足、不是实现缺陷**（${lastKind === 'collided' ? 'E98' : 'E19'}）；释放端口/停笔后复跑即为证据；`
      + `尝试读数：${attemptReadings.map(fmtAttempt).join(' ／ ')}`);
  } else {
    const sub = greenSub;
    t.check('端到端：跑 `--only contract-check`（无失败脚本）⇒ 退出码 0，打印"门禁全绿"**且同时打印权威对账行**',
      sub.status === 0 && sub.text.includes(GREEN_LINE) &&
      sub.text.includes('权威数字校验：**未执行**：本轮未跑全离线门禁'),
      `尝试序列 ${subAttempts.join(' → ')}｜退出码 ${sub.status}${sub.error ? `（spawn 错误 ${sub.error}）` : ''}`
      + `｜权威对账行 ${sub.text.includes('权威数字校验：**未执行**') ? '有' : '缺'}｜门禁全绿 ${sub.text.includes('门禁全绿') ? '有' : '缺'}`
      + (attemptKind(sub.status, sub.text) === 'bad'
        ? `｜**非环境原因**：${(sub.text.split(/\r?\n/).filter(l => /^\s*(FAIL|ERR |\?\?\? )/.test(l))[0]
          || '（结果表里没有 FAIL/ERR/??? 行）').trim()}`
        : '')
      + `｜逐次读数：${attemptReadings.map(fmtAttempt).join(' ／ ')}`
      + '（绿轮丢弃对账行是同一处重构的第二个缺口：必须"绿轮也打印"）');
  }


  /* ---------------- D22 定点变异⑤：旧写法（只看 verdict.exitCode）必须被上面的断言挡下 ---------------- */
  const finalFn = runAllSrc6.match(/function finalExitCode\(entry\) \{[\s\S]*?\n\}/);
  /* 变异内容：把组合判据换回旧写法 —— 删掉"失败/未核实集合非空 ⇒ 1"那一支，只认 verdict.exitCode。 */
  const mutatedFinalFn = 'function finalExitCode(entry) {\n'
    + '  const e = entry || {};\n'
    + '  const verdict = e.verdict || {};\n'
    + '  return verdict.exitCode ?? 0;\n'
    + '}';
  const mutateSrc = src => src.replace(finalFn[0], mutatedFinalFn);
  /* 载入一段变异的 run-all 源码：只替换"最终退出码"函数体，其余（含 resolveGateOutcome）原样保留。
     用 `Module._compile` 而非写临时文件：不落地、不碰仓库；`require('./lib/snapshot')` 走真实模块。 */
  const loadSourceVariant = (src, id) => {
    const Module = require('node:module');
    const m = new Module(id, null);
    m.filename = path.join(__dirname, 'run-all.js');
    m.paths = Module._nodeModulePaths(__dirname);
    m._compile(src, m.filename);
    return m.exports;
  };

  t.check('变异⑤：把组合判据改回"只看 verdict.exitCode" ⇒ 第十四节断言必红；恢复后回绿',
    (() => {
      let lookupHit = false;
      try {
        if (!finalFn) { lookupHit = true; throw new Error('变异锚点未命中：源码里找不到 `function finalExitCode(entry) { … }`'); }
        const mutated = loadSourceVariant(mutateSrc(runAllSrc6), path.join(__dirname, 'run-all.js'));
        const mutFailed = mutated.finalExitCode({ failed: [script('docs-check')], unverified: [], verdict: verdictOf(0) });
        const mutUnverified = mutated.finalExitCode({ failed: [], unverified: [script('browser-check')], verdict: verdictOf(0) });
        const mutClean = mutated.finalExitCode({ failed: [], unverified: [], verdict: verdictOf(0) });
        const curFailed = runAll6.finalExitCode({ failed: [script('docs-check')], unverified: [], verdict: verdictOf(0) });
        const curClean = runAll6.finalExitCode({ failed: [], unverified: [], verdict: verdictOf(0) });
        /* 变异后：有 FAIL 却退 0（旧缺陷活回来了）；恢复后：同样输入退 1；干净轮两侧都必须 0
           （否则"挡下"可能只是把一切都判红 —— 那种断言同样不可信）。 */
        return mutFailed === 0 && mutUnverified === 0 && mutClean === 0 && curFailed === 1 && curClean === 0;
      } catch (err) {
        lookupHit = true;
        t.info('变异⑤未执行：' + (err && err.message));
        return false;
      } finally {
        if (lookupHit) t.info('变异⑤：变异体未能载入，本条按失败处理（不许把"跑不了"当通过）');
      }
    })(), '变异内容：finalExitCode 只 `return verdict.exitCode ?? 0`（删掉 failed/unverified 那一支）；'
      + '变异后实测：failed=1/verdict=0 → 0 且 unverified=1 → 0（红）；恢复后实测：failed=1 → 1、干净轮 → 0（绿）');
}

/* ---------------- 十五、并行 runner 的调度契约（2026-09-29 新增） ----------------
   背景（实测）：全量墙钟 ≈ 453 s，其中 `stress-check` **301.7 s ＝ 67%**，其余 16 个合计 ≈ 151 s
   ⇒ 真正的浪费是"长杆独占"，不是脚本数量多。于是给 runner 加"并行波 + 串行尾"（`--jobs N`，默认串行）。

   本节守三件事，缺一条并行就不许用：
     A 静态：`serialTail` 必须标在**对并发敏感**的三个脚本上（docs-cross-check 要读全量账本；
       docs-check 会真跑 md2docx **写盘**；files-check 要全树扫描 —— 后两者并行会互相干扰）。
     B 默认：并发度默认 **1＝串行** —— 并行必须显式开启；否则"作证据的那条路径"会被悄悄改掉（E52）。
     C 行为（最强）：`--fast` 串行 vs `--fast --jobs 4` **逐脚本状态/条数完全一致**，
       且并行账本的 `ranSuites` 仍按 SUITES 原顺序（并行完成顺序是乱的，落账必须归一）。
   实测（本机 i7-14650HX/24 逻辑核）：串行 74.2 s → 并行 43.3 s（各脚本之和 74.1 s，加速 1.71×）。 */
{
  const runAll15 = require('./run-all.js');
  const src15 = fs.readFileSync(path.join(env.paths.tests, 'run-all.js'), 'utf8');
  /* 本节自带变异加载器：不依赖第十四节块内的局部 `loadSourceVariant`（那是块级作用域，取不到）。
     与第十四节同一手法：`Module._compile` 不落地、不碰仓库。 */
  const loadVariant15 = src => {
    const Module = require('node:module');
    const m = new Module(path.join(__dirname, 'run-all.js'), null);
    m.filename = path.join(__dirname, 'run-all.js');
    m.paths = Module._nodeModulePaths(__dirname);
    m._compile(src, m.filename);
    return m.exports;
  };
  const serialTailNames15 = runAll15.SUITES.filter(s => s.serialTail).map(s => s.name);
  /* **`E111`（2026-10-04）：期望集由真源现算，不再只手写三条**（座位 5 在 `C·20.7` `F-4` 立案：
     原判据只断言"**必须包含**手写的三条"，于是本批给 `browser-check`／`overlap-check`／
     `stress-check` 加的 `serialTail: true` **不在期望集里** ⇒ 改回去（或只改一条）门禁照绿）。 */
  /* ① **浏览器/CDP 类**：`needBrowser === true` 的脚本在 `--jobs N` 下会互抢 Edge/CDP/端口
        （`E70③` 的现场：`browser-check` 偶发整脚本失败）⇒ **凡 `needBrowser` 必 `serialTail`**。
        这一条**从 `SUITES` 现算** —— 将来新增一个需浏览器的脚本，不改本判据也会自动被要求。 */
  const needTailBrowser15 = runAll15.SUITES.filter(s => s.needBrowser).map(s => s.name);
  /* ② **离线并发敏感三类**：`docs-cross-check` 要读全量账本；`docs-check` 会真跑 PowerShell **写盘**；
        `files-check` 要全树扫描 —— 后两者并行会互相干扰。这三条机器读不出"敏感"这个属性
        （`SUITES` 里没有对应字段）⇒ 只能**显式列名 ＋ 逐条理由**（理由见本节抬头与 §15-A 的说明），
        并靠下面的 **§15-A′ 反向断言** 与 **§15-E／§15-F 的定点变异**一起守着（不让它悄悄漂）。 */
  const needTailOffline15 = ['docs-cross-check', 'docs-check', 'files-check'];
  const needTail15 = Array.from(new Set(needTailOffline15.concat(needTailBrowser15)));
  const missingTail15 = needTail15.filter(n => !serialTailNames15.includes(n));
  const extraTail15 = serialTailNames15.filter(n => !needTail15.includes(n));
  t.check('§15-A 静态（**期望集由真源现算**）：凡 `needBrowser === true` 的脚本**必须**标 `serialTail`'
    + '（`E70③`：浏览器/CDP 类并行互抢 Edge/端口/CPU），再加上离线并发敏感的三类'
    + '（`docs-cross-check`／`docs-check`／`files-check`，理由见本节抬头）',
    missingTail15.length === 0,
    `实际 serialTail = [${serialTailNames15.join('、') || '（空）'}]；期望包含 [${needTail15.join('、')}]`
      + `（其中浏览器类由 \`needBrowser\` **现算** = [${needTailBrowser15.join('、') || '（无）'}]）`
      + (missingTail15.length ? `；**判红：缺标 ${missingTail15.length} 条并指名** —— ${missingTail15.join('、')}` : ''));
  t.check('§15-A′ 静态**反向**：`serialTail` 集合 **⊆** 期望集（没有脚本"偷偷"进串行尾 ——'
    + '串行尾是拿墙钟换稳定，多标一条就是白付代价，且会让 §15-A 的期望集失去意义）',
    extraTail15.length === 0,
    extraTail15.length
      ? `判红：**期望集之外多标 ${extraTail15.length} 条并指名** —— ${extraTail15.join('、')}`
      : `零多标（实际 ${serialTailNames15.length} 条全部在期望集里：${serialTailNames15.join('、') || '（空）'}）`);

  t.check('§15-B 静态：并发度默认 1（串行）—— 并行必须显式开启，不改"作证据的默认路径"（E52）',
    /function\s+resolveJobs\(\)\s*\{[\s\S]{0,400}?if\s*\(!String\(raw\)\.trim\(\)\)\s*return\s+1;/.test(src15),
    '在 resolveJobs() 里找不到"未显式要求即 return 1"的判据（默认值被改成并行就会命中这条）');

  /* ---- C 行为：串行 vs 并行，逐脚本比对 ----
     ⚠ **绝不能用 `--fast`**：`--fast` 的集合里含 `harness-check`（本脚本），
     而本节又要 fork 一个 `run-all` ⇒ 子进程再跑 `harness-check` ⇒ 再 fork ⇒ **无限递归**。
     （2026-09-29 实测踩坑：PID 每 ~60 s 换一轮 `harness-check-10000 → -23888 → -29548`
     —— 每轮都能"通过"，所以不会报错，只会永远跑下去。）
     改为**显式允许清单**：挑几个覆盖"串行尾"与"并行波"两类的脚本，且**不含本脚本**。 */
  const S15_SUITES = ['contract-check', 'db-check', 'docs-check', 'files-check', 'logic-check', 'trace-check'];
  const RECURSION_GUARD = "不允许用 --fast/--only harness-check";
  const RUN15_TIMEOUT = 10 * 60 * 1000;
  /* **`E96` 收口**（`T-20261003-04`，座位 4b）—— 本节"并行 vs 串行"的对照，在**子集场景**下本来
     **无法失败**：`run-all` 的 `scheduleSuites()` 第一条分支是
       `if (!(jobs > 1) || optValue('--only')) return { parallel: [], serial: suites.slice(), jobs: 1 };`
     ⇒ 传 `--jobs 4` 也按**并发 1** 跑（座位 4 实测：`--only <6 脚本> --jobs 4` ⇒
     `serialMs 9194 / parallelMs 9215` —— 同一条串行路径测了两遍）⇒ 旧写法
     `t.check('§15-C …', okC15)` 是一条**空洞判据**（D23：看起来守住了、实际守不住）。
     现按 `§15-D` 的既有护栏统一：**只在"真并行轮"上判定**（脚本数 ≥8 **且**实跑输出里真的打印了
     并行波），否则**显式打印"本轮为子集/串行 ⇒ 不判定"并以 `t.skip` 记账** ——
     "不判定"与"通过"在台账上必须分得开（这正是 `D23` 要的口径）：
       ①**默认档**（本节 fork 的子集轮）：恒为"不判定"（`--only` 强制串行）；
       ②**`DSH_HARNESS_S15_FULL=1` 档**：改跑 `--fast`（**14** 个脚本 —— `!slow && !needBrowser` 的离线门禁，
          `E113`（2026-10-04）核出原写"13 个"是 `offline-check` 入册前的旧数，与 `run-all.js` 注释里的 14 不符）串行 vs `--fast --jobs 2`
         ⇒ 该判据回到"**可判定**"（真并行波 10 个）。
     为什么第②档做成**显式档位**而不是默认：那一档每次给 harness-check 加约 2 分钟
     （ADR-0004 准则 6"成本可控"），且 `--fast` 含本脚本 ⇒ 需要一层递归护栏
     （子轮带 `DSH_HARNESS_S15_CHILD=1`，嵌套的那一层 harness-check 不再 fork）。
     ⚠ 本节**不动** `run-all.js` 的调度（那是另一路协作方的文件）—— 护栏只加在判据侧。 */
  const S15_FULL = String(process.env.DSH_HARNESS_S15_FULL || '').trim() === '1';
  const S15_CHILD = String(process.env.DSH_HARNESS_S15_CHILD || '').trim() === '1';
  const S15_JOBS = S15_FULL ? 2 : 4;
  const S15_MODE = S15_FULL ? 'fast' : 'subset';
  /** **该轮自己声明的实跑账路径**（`E110`，2026-10-04）：`run-all` 在开跑前会打印
   *  `  实跑账：<repo 相对路径>（…）`（见 `run-all.js` 开头 `ledgerFile()` 那一段）——
   *  子集轮＝`run-totals.subset-<子进程 pid>.json`，全量/`--fast` 轮＝主账本 `run-totals.json`。
   *  **为什么不写死主账本**（`F-3` 的病灶）：`E99` 之后子集轮**不再写主账本** ⇒ 写死路径读到的是
   *  **上一轮全量**的账，于是 §15-C 打印的"实测读数"会被读成"**本轮的**"（读数**归属错**）。
   *  这里只做"取路径"这一件事，判据仍旧是 `§15-C`/`§15-D` 原有的那两条，**不改期望、不删判据**。
   *  @returns {?string} 绝对路径（解析不到就返回 null，由调用方回落到"本轮应有路径"） */
  const ledgerPathFromOut15 = (out) => {
    const m = String(out || '').match(/实跑账：(.+?)（/);
    return m ? path.resolve(env.paths.root, m[1].trim()) : null;
  };
  const runFast15 = (jobs) => {
    /* ⚠ 子集档必须**逗号分隔的单个 `--only`**：`optValue('--only')` 只取一个值，
       重复传多个 `--only` 只会生效最后一个（实测过一次"共 1 个脚本"的假象）。 */
    const args = ['--no-preflight'];
    if (S15_MODE === 'fast') args.push('--fast'); else args.push('--only', S15_SUITES.join(','));
    if (jobs > 1) args.push('--jobs', String(jobs));
    const started = Date.now();
    const res = spawnSync(process.execPath, [path.join(env.paths.tests, 'run-all.js'), ...args], {
      cwd: env.paths.root, encoding: 'utf8', timeout: RUN15_TIMEOUT, maxBuffer: 64 * 1024 * 1024,
      /* 基线轮显式 `DSH_JOBS:'1'`：否则若外层带 `DSH_JOBS`，基线轮自己就并行了，
         §15-C 会退化成"并行 vs 并行"（对照失效），且可能让子进程再并行化。
         `DSH_HARNESS_S15_CHILD:'1'`＝**递归护栏**：`--fast` 档的子轮含本脚本，
         嵌套那一层必须**不再 fork**（否则无限递归 —— 见上面的历史坑）。 */
      env: { ...process.env, DSH_ENV: env.ENV_NAME, DSH_JOBS: jobs > 1 ? '' : '1', DSH_HARNESS_S15_CHILD: '1' }
    });
    const ms = Date.now() - started;
    const out = (res.stdout || '') + (res.stderr || '');
    /* **读该轮自己的账**（`E110`）：① 先认子进程 stdout 里**它自己声明**的那条路径；
       ② 认不到就按 `run-all` 导出的 `resolveLedgerFile()`（**同一个真源**，pid 取子进程的）
       算"本轮应有的路径" —— 两条都拿不到才回落主账本（并如实记 `from`，见下面的归属判据）。 */
    let readPath = ledgerPathFromOut15(res.stdout);
    let from = 'child-declared';
    if (!readPath) {
      from = 'resolveLedgerFile';
      try {
        readPath = runAll15.resolveLedgerFile({
          explicit: null, only: S15_MODE === 'subset' ? S15_SUITES.join(',') : null,
          verifyDir: env.paths.verify, pid: res.pid === undefined ? process.pid : res.pid, root: env.paths.root
        });
      } catch { readPath = null; }
    }
    if (!readPath) { from = 'fallback-main'; readPath = path.join(env.paths.verify, 'run-totals.json'); }
    let ledger = null;
    try { ledger = JSON.parse(fs.readFileSync(readPath, 'utf8')); } catch { ledger = null; }
    return {
      out, ms, ledger, code: res.status, childPid: res.pid,
      ledgerPath: readPath, ledgerRel: path.relative(env.paths.root, readPath).split(path.sep).join('\\'),
      ledgerFrom: from, ledgerExists: fs.existsSync(readPath)
    };
  };
  const shape15 = L => (L && Array.isArray(L.suites))
    ? L.suites.map(s => `${s.name}:${s.status}:${s.summary ? s.summary.passed + '/' + s.summary.failed + '/' + s.summary.skipped : '-'}`).join(' | ')
    : '（读不到账本）';
  /** 一轮 run-all 是不是**真并行轮**（判据可判定性的唯一出处，§15-C／§15-D 共用）：
      请求并发 ≥2 ＋ 实跑脚本数 ≥8 ＋ **输出里真的打印了并行波**。
      为什么以"输出里真的打印"为准：`scheduleSuites()` 的降级（`--only`／jobs<2）是**静默**的，
      只有 run-all 自己那行 `▶ 并行波 N 个（并发 M）` 能证明"这一轮确实分了并行波"。 */
  const parallelRound15 = (run) => {
    const count = run && run.ledger && Array.isArray(run.ledger.ranSuites) ? run.ledger.ranSuites.length : 0;
    const m = String((run && run.out) || '').match(/▶ 并行波 (\d+) 个（并发 (\d+)）/);
    const wave = m ? Number(m[1]) : 0, waveJobs = m ? Number(m[2]) : 0;
    const judged = S15_JOBS >= 2 && count >= 8 && wave > 0 && waveJobs >= 2;
    return {
      judged, count, wave, waveJobs,
      reason: `请求 --jobs ${S15_JOBS}（档位 ${S15_MODE}）、实跑脚本 ${count} 个、`
        + (m ? `输出里并行波 ${wave} 个（并发 ${waveJobs}）` : '输出里**没有**并行波行')
        + `⇒ ${judged ? '真并行轮（可判定）' : '子集/串行（不判定）'}`
    };
  };

  let ser15 = null, par15 = null;
  if (S15_CHILD) {
    /* 嵌套子轮：**不再 fork**（递归护栏）。显式记账，不许"静默少跑两条断言"。 */
    t.skip('§15-C 行为：并行 vs 串行逐脚本一致（**嵌套子轮不判定**）',
      '本进程是 §15-C 自己 fork 出来的子轮（`DSH_HARNESS_S15_CHILD=1`）⇒ 不再 fork，避免无限递归');
    t.skip('§15-D 时效：并行墙钟 < 串行墙钟（**嵌套子轮不判定**）', '同 §15-C（嵌套子轮不再 fork）');
  } else {
    try {
      ser15 = runFast15(1);
      /* 递归护栏（D23 意义上的"反自证"）：子集档清单里一旦混进本脚本，就必须当场判红 ——
         否则整节会安静地无限递归下去（每轮都"通过"，不报错）。 */
      if (S15_MODE === 'subset' && S15_SUITES.includes('harness-check')) throw new Error(RECURSION_GUARD);
      par15 = runFast15(S15_JOBS);
    } catch (err) {
      t.info('§15-C 未执行：' + (err && err.message));
    }
  }
  const round15 = S15_CHILD
    ? { judged: false, count: 0, wave: 0, waveJobs: 0, reason: '嵌套子轮（不再 fork，故没有可判定读数）' }
    : parallelRound15(par15);
  /* ---- `E110`（2026-10-04）：**读数归属** —— §15-C／§15-D 打印的"实测读数"必须来自**本轮** ----
     立案（座位 5 `C·20.7` `F-3`）：本节过去写死 `path.join(env.paths.verify,'run-totals.json')` 回读，
     而 `E99` 之后**子集轮不再写主账本** ⇒ 子集档读到的是**上一轮全量**的账：
     同一段 `§15-C` 文字在"跑全量之前"是 `docs-check:failed:46/2/0`、在"跑完全量之后"变成
     `29/2/2`，而中间 §15 的嵌套轮**什么都没做** ⇒ 那串数字被读成"**本轮的**"是**归属错**。
     改法**只在读的那一侧**：`runFast15()` 改为读**该轮自己声明的账本**（见它上方的
     `ledgerPathFromOut15()`），**不动** `run-all.js` 的调度（`--fast` 刻意不改道 —— 那条意图由
     下面这条断言的 `fast` 分支**从读者侧**锁住，见 `readme`／`run-all.js` 的 `resolveLedgerFile` 注释）。
     **两端口径**（都从 `runFast15()` 实际读到的路径推出，不另抄一份规则）：
       · 子集档：两轮必须各读**自己的子集账**（`run-totals.subset-<子进程 pid>.json`）、
         **都不是主账本**，且账内 `ranSuites` ＝本轮请求的那 6 个脚本（这就是"读的是本轮"的实证）；
       · `DSH_HARNESS_S15_FULL=1`（`--fast`）档：两轮读的**必须都是主账本** ——
         把"`--fast` 不改道"这条 `run-all.js` 的刻意意图钉在判据里（若哪天有人给 `--fast` 也改道，
         这里会红，而不是悄悄退回"拿两份旧账互比"）。 */
  const mainLedgerName15 = runAll15.MAIN_LEDGER_NAME;   /* 'run-totals.json'：按**文件名**比，
     因为 `ledgerRel` 是"相对仓库根的路径"（`tests\._verify\run-totals.json`），两者不是一回事 */
  if (S15_CHILD) {
    t.skip('§15-C′ 读数归属（`E110`）：§15 打印的读数必须来自**本轮**（**嵌套子轮不判定**）',
      '本进程是 §15-C 自己 fork 出来的子轮（`DSH_HARNESS_S15_CHILD=1`）⇒ 本轮没有 fork 过任何轮次，无读数可归属');
  } else {
    const reqSuites15 = (S15_MODE === 'subset'
      ? S15_SUITES.slice()
      : runAll15.SUITES.filter(s => !s.slow && !s.needBrowser).map(s => s.name)).slice().sort();
    /* ⚠ 账本里会多一条 **`capture-baseline`**（`E91` 的截图前置刷新）—— 它**不在 `SUITES` 里**
       （见 `run-all.js` 的 `CAPTURE_SUITE` 注释），但 `--fast` 轮含 `screenshot-diff` ⇒ 前置刷新会跑，
       并随并行波一起落账。故比对前先按 `SUITES` 名单过滤（与 §15-C 的 `inSuites15` 同一口径）。 */
    const suitesAll15 = runAll15.SUITES.map(s => s.name);
    const ranOf15 = (run) => (run && run.ledger && Array.isArray(run.ledger.ranSuites)
      ? run.ledger.ranSuites.filter(n => suitesAll15.indexOf(n) >= 0).sort() : null);
    const bothPresent15 = Boolean(ser15 && par15 && ser15.ledger && par15.ledger);
    const nameOfLedger15 = (run) => (run && run.ledgerPath ? path.basename(run.ledgerPath) : null);
    const ownSubsetOk15 = S15_MODE !== 'subset' || (
      nameOfLedger15(ser15) !== mainLedgerName15 && nameOfLedger15(par15) !== mainLedgerName15
      && ser15.ledgerPath !== par15.ledgerPath
      && ser15.ledgerExists && par15.ledgerExists
      && JSON.stringify(ranOf15(ser15)) === JSON.stringify(reqSuites15)
      && JSON.stringify(ranOf15(par15)) === JSON.stringify(reqSuites15));
    const fastMainOk15 = S15_MODE !== 'fast' || (
      nameOfLedger15(ser15) === mainLedgerName15 && nameOfLedger15(par15) === mainLedgerName15);
    t.check('§15-C′ 读数归属（`E110`）：§15-C／§15-D 打印的"实测读数"来自**本轮自己的账本**'
      + '（子集档＝各自的 `run-totals.subset-<pid>.json`、**都不是**主账本、账内脚本清单＝本轮请求；'
      + '`DSH_HARNESS_S15_FULL=1` 档＝两轮都读主账本，把"`--fast` 不改道"的意图从读者侧锁住）',
      bothPresent15 && ownSubsetOk15 && fastMainOk15,
      `档位 ${S15_MODE}（请求脚本 ${reqSuites15.length} 个：${reqSuites15.join('、')}）；`
        + `串行轮读到 \`${ser15 ? ser15.ledgerRel : '（未跑）'}\`（来源 ${ser15 ? ser15.ledgerFrom : '-'}，`
        + `账内 ranSuites=${JSON.stringify(ranOf15(ser15))}）；`
        + `并行轮读到 \`${par15 ? par15.ledgerRel : '（未跑）'}\`（来源 ${par15 ? par15.ledgerFrom : '-'}，`
        + `账内 ranSuites=${JSON.stringify(ranOf15(par15))}）`);
  }
  /* ---- §15-C 的三个子句（口径）----
     ① 逐脚本**内容**（状态 ＋ 条数）与串行逐条相同 —— **按名比对、与顺序无关**（并行只改"谁和谁同时跑"）；
     ② 断言合计（`assertions`）逐字段相同；
     ③ 账本**落账顺序**合 `run-all` 的既有契约：
        · 串行轮 ⇒ SUITES 原顺序；
        · 并行轮 ⇒ **并行波（按 SUITES 顺序）在前 ＋ 串行尾（按 SUITES 顺序）在后**
          （`run-all.js` 的 `ordered()` 只把**波内**完成顺序归一，而尾段是波跑完之后逐条 append 的
           —— 故整条账**不可能**与串行轮的 `ranSuites` 逐字相同）。
     ⚠ **`E96` 第二次现身（本批实测，2026-10-03，`T-20261003-04`）**：旧子句写的是
     "并行账本的 `ranSuites` 仍按 SUITES 原顺序"＝要求两轮 `ranSuites.join(',')` **逐字相等**。
     它在**子集轮**里恒真（`--only` 强制串行 ⇒ 两轮账本都恰是 SUITES 顺序）⇒ 又一条
     "看起来在守、实际守不住"的判据；而在**真并行轮**（`DSH_HARNESS_S15_FULL=1`）里它**必假**
     （实测：串行 `…docs-check,files-check,harness-check,…` ↔ 并行 `…harness-check,…,docs-check,files-check,docs-cross-check`，
     见 `tests\._verify\review\hc-s15full.log` 的 §15-C 失败明细）。
     **判定（ADR-0004 D21）：改期望，不改 `run-all` 的调度** —— 依据是 `run-all` 自己的契约
     （波内归一 ＋ 尾段后置；增量落账语义下"整条按 SUITES 顺序"本就不成立），
     而"波内不得按完成顺序落账"这个**原意**由下面 ③ 的两条断言原样保住。 */
  const suiteNames15 = runAll15.SUITES.map(s => s.name);
  const tailNames15 = new Set(runAll15.SUITES.filter(s => s.serialTail).map(s => s.name));
  /** 只保留"真在 SUITES 清单里"的脚本名（`capture-baseline` 是 `E91` 的前置刷新，不在 SUITES 里） */
  const inSuites15 = ran => (Array.isArray(ran) ? ran : []).filter(n => suiteNames15.indexOf(n) >= 0);
  /** ⚠ 期望值一律**由 SUITES 现算**（`suiteNames15`），**不得**拿 `ran` 自身当期望 ——
      否则就是 `x === x` 的恒真式（ADR-0004 D23：这种"自己跟自己比"的判据比空洞还危险）。 */
  const suiteOrderOf15 = ran => suiteNames15.filter(n => Array.isArray(ran) && ran.indexOf(n) >= 0);
  const expectSerialOrder15 = ran => suiteOrderOf15(ran);
  const expectWaveThenTail15 = ran => {
    const names = suiteOrderOf15(ran);
    return names.filter(n => !tailNames15.has(n)).concat(names.filter(n => tailNames15.has(n)));
  };
  const orderOk15 = (ran, expect) => Array.isArray(ran) && ran.length > 0
    && inSuites15(ran).join(',') === expect(ran).join(',');
  /** 逐脚本形态（**按名排序**：内容比对与顺序解耦；顺序另有 ③ 单独判） */
  const contentShape15 = L => (L && Array.isArray(L.suites))
    ? L.suites.map(s => `${s.name}:${s.status}:${s.summary ? s.summary.passed + '/' + s.summary.failed + '/' + s.summary.skipped : '-'}`).sort().join(' | ')
    : '（读不到账本）';
  const okC15 = !!(ser15 && par15 && ser15.ledger && par15.ledger
    && contentShape15(ser15.ledger) === contentShape15(par15.ledger)
    && JSON.stringify(ser15.ledger.assertions) === JSON.stringify(par15.ledger.assertions)
    && orderOk15(ser15.ledger.ranSuites, expectSerialOrder15)
    && orderOk15(par15.ledger.ranSuites, expectWaveThenTail15));
  const c15Shape = `串行【${contentShape15(ser15 && ser15.ledger)}】\n        并行【${contentShape15(par15 && par15.ledger)}】\n`
    + `        账本归属（\`E110\`）：串行 \`${ser15 ? ser15.ledgerRel : '（未跑）'}\`、`
    + `并行 \`${par15 ? par15.ledgerRel : '（未跑）'}\` —— **读的是各轮自己声明的那一份**，不是写死的路径\n`
    + `        串行断言 ${JSON.stringify((ser15 && ser15.ledger && ser15.ledger.assertions) || null)}；`
    + `并行断言 ${JSON.stringify((par15 && par15.ledger && par15.ledger.assertions) || null)}\n`
    + `        账本顺序：串行 ${JSON.stringify((ser15 && ser15.ledger && ser15.ledger.ranSuites) || null)}`
    + `（期望＝SUITES 顺序 ${JSON.stringify(expectSerialOrder15(ser15 && ser15.ledger && ser15.ledger.ranSuites))}）；`
    + `并行 ${JSON.stringify((par15 && par15.ledger && par15.ledger.ranSuites) || null)}`
    + `（期望＝波＋尾 ${JSON.stringify(expectWaveThenTail15(par15 && par15.ledger && par15.ledger.ranSuites))}）`;
  if (round15.judged) {
    t.check('§15-C 行为：串行 vs `--jobs ' + S15_JOBS + '` ⇒ 逐脚本**内容**（状态/条数）与断言合计**按名逐条一致**' +
      '（与顺序无关），且账本**落账顺序**合 `run-all` 契约（串行＝SUITES 原顺序；' +
      '并行＝并行波（SUITES 顺序）在前 ＋ 串行尾（SUITES 顺序）在后 —— 见本条上方的 `E96` 二次现身说明）',
      okC15, `**真并行轮**（${round15.reason}）\n        ` + c15Shape);
  } else {
    t.skip('§15-C 行为：串行 vs `--jobs ' + S15_JOBS + '` ⇒ 逐脚本内容与账本顺序逐条一致（**本轮不判定**）',
      `不判定（本轮为子集/串行）：${round15.reason}。实测读数：串行 ${ser15 ? ser15.ms + ' ms' : '（未跑）'} ↔ `
      + `并行 ${par15 ? par15.ms + ' ms' : '（未跑）'}（两者几乎相同＝同一条串行路径测了两遍 —— 这正是 E96 的现场）。`
      + `逐脚本形态：${shape15(ser15 && ser15.ledger)} ／ ${shape15(par15 && par15.ledger)}。`
      + `账本归属（\`E110\`）：串行读 \`${ser15 ? ser15.ledgerRel : '（未跑）'}\`、`
      + `并行读 \`${par15 ? par15.ledgerRel : '（未跑）'}\` —— **本轮的账**，不再随主账本漂。`
      + '【不判定 ≠ 通过】：要拿可判定读数，请跑 `DSH_HARNESS_S15_FULL=1 node tests\\harness-check.js`（真并行波档）');
    t.info(`§15-C 本轮为**子集/串行 ⇒ 不判定**：${round15.reason}；`
      + `串行 ${ser15 ? ser15.ms : '?'} ms ↔ 并行 ${par15 ? par15.ms : '?'} ms`
      + '（`--only` 强制并发 1 由 `run-all.js` 的 `scheduleSuites()` 第一条分支决定，本节不改调度）');
  }

  /* 时效：只在本机确实把"并发"体现出来时才要求（核少或脚本少时并行不一定更快，别拿硬件当缺陷） */
  const cores15 = os.cpus().length;
  if (round15.judged && cores15 >= 4) {
    t.check('§15-D 时效：并行墙钟 < 串行墙钟', !!(par15 && ser15 && par15.ms < ser15.ms),
      `串行 ${(ser15.ms / 1000).toFixed(1)}s → 并行 ${(par15.ms / 1000).toFixed(1)}s（${round15.reason}）`);
  } else {
    t.skip('§15-D 时效：并行墙钟 < 串行墙钟（**本轮不判定**）',
      `不判定：${round15.reason}；本机核 ${cores15}（须 ≥4 **且**是真并行轮）。`
      + `读数仅供参考、不构成判据：串行 ${ser15 ? ser15.ms : '?'} ms ↔ 并行 ${par15 ? par15.ms : '?'} ms`);
  }

  /* §15-C0 构成性：**"可判定"分支可达**（否则上面那个 `if (round15.judged)` 就是死代码 ——
     那本身就是空洞判据的另一种形态）。取数走 `run-all` **自己的** `scheduleSuites()`
     （真源，不另抄一份调度规则；`loadVariant15` 在源码尾部**追加一行导出**，不落地、不碰仓库）。 */
  t.check('§15-C0 构成性：`真并行轮`的配置**存在且确实产出并行波**' +
    '（`scheduleSuites(14 个 --fast 脚本, --jobs 2)` ⇒ 并行波 ≥8、并发 2）⇒ §15-C 的"可判定"分支可达（不是死代码）',
    (() => {
      let plan = null;
      try {
        const probe = loadVariant15(src15 + '\nmodule.exports.__s15probe = { scheduleSuites };\n');
        const fastList = runAll15.SUITES.filter(s => !s.slow && !s.needBrowser);
        plan = probe.__s15probe.scheduleSuites(fastList, 2);
      } catch (err) { t.info('§15-C0 取不到 `scheduleSuites()`：' + (err && err.message)); return false; }
      return Boolean(plan) && Array.isArray(plan.parallel) && plan.parallel.length >= 8 && plan.jobs === 2;
    })(),
    '反证：若 `scheduleSuites()` 退化成"任何情况都不并行"（parallel 恒空）⇒ 本条必红。'
    + '⚠ 本节**默认档**用的子集轮（`--only` 6 个脚本）结构上不可能出现并行波：'
    + "`scheduleSuites()` 的第一条分支就是 `if (!(jobs > 1) || optValue('--only')) return { parallel: [], …, jobs: 1 }`"
    + `（源码文本实测命中＝${/if\s*\(!\(jobs > 1\)\s*\|\|\s*optValue\('--only'\)\)/.test(src15)}）——`
    + '故默认档报"不判定"，`DSH_HARNESS_S15_FULL=1` 档报"可判定"');

  /* D22 定点变异：把某条脚本的 `serialTail` 去掉 ⇒ §15-A 必须变红（证明不是恒真断言）。
     **`E111`（2026-10-04）**：原来只覆盖 `docs-cross-check`（离线类），而本批新收进串行尾的正是
     三条**浏览器/CDP 类** ⇒ 按 `F-4` 的建议把 D22 **扩到至少一条浏览器类脚本**，并且两条走
     **同一份判据**（`missingTail15` 的计算方式与 §15-A 逐字同源：都拿 `needTail15` 逐个比对）。
     实现细节（可证伪性的门槛）：锚点**按符号定位、不引行号**（清单那行由别人维护，行号会漂），
     且**回读命中数**——`!== 1` 就判红（锚点再漂移时明确报"锚点回读失败"，不许静默空转）。 */
  const dropTailMutant15 = (name) => {
    const re = new RegExp(`\\{ name: '${name}',[^\\n]*?, serialTail: true`);
    const hits = src15.match(new RegExp(re.source, 'g'));
    if (!hits || hits.length !== 1) return { ok: false, why: `变异锚点命中 ${hits ? hits.length : 0} 处（应恰 1）` };
    let mutated = null;
    try { mutated = loadVariant15(src15.replace(re, hits[0].replace(', serialTail: true', ''))); }
    catch (err) { return { ok: false, why: '变异体载入失败：' + (err && err.message) }; }
    const mutatedTails = mutated.SUITES.filter(s => s.serialTail).map(s => s.name);
    const missing = needTail15.filter(n => !mutatedTails.includes(n));
    return {
      ok: true, mutatedTails, missing,
      /* 变异体上"§15-A 会红"＝ missing 非空；**且必须指名它**；现行源码上必须绿（否则断言恒红） */
      mutatedRedNamed: missing.includes(name),
      currentGreen: missingTail15.length === 0
    };
  };
  const e15 = dropTailMutant15('docs-cross-check');
  t.check('§15-E D22 变异（离线类）：去掉 `docs-cross-check` 的 `serialTail` ⇒ §15-A 判据必红**并指名它**'
    + '（留出缺口 ⇒ 它在别的脚本还没跑完时就去读账本）；现行源码上判绿',
    e15.ok && e15.mutatedRedNamed && e15.currentGreen,
    e15.ok
      ? `变异体 serialTail=[${e15.mutatedTails.join('、')}]；**缺标并指名** = [${e15.missing.join('、')}]`
        + `（含 docs-cross-check=${e15.missing.includes('docs-cross-check')}，应 true）；现行源码 §15-A 绿=${e15.currentGreen}`
      : `**判红：${e15.why}** —— 锚点漂了就等于 D22 没跑，不许当通过`);
  const e15b = dropTailMutant15('browser-check');
  t.check('§15-F D22 变异（**浏览器/CDP 类**，`E111` 新增）：去掉 `browser-check` 的 `serialTail` ⇒'
    + ' §15-A 判据必红**并指名 `browser-check`**（`E70③` 的现场就是它）；现行源码上判绿',
    e15b.ok && e15b.mutatedRedNamed && e15b.currentGreen,
    e15b.ok
      ? `变异体 serialTail=[${e15b.mutatedTails.join('、')}]；**缺标并指名** = [${e15b.missing.join('、')}]`
        + `（含 browser-check=${e15b.missing.includes('browser-check')}，应 true）；现行源码 §15-A 绿=${e15b.currentGreen}`
      : `**判红：${e15b.why}** —— 锚点漂了就等于 D22 没跑，不许当通过`);
  try {
    fs.writeFileSync(path.join(env.paths.verify, 's15-parallel-runs.txt'),
      JSON.stringify({ mode: S15_MODE, jobs: S15_JOBS, child: S15_CHILD, judged: round15.judged,
        reason: round15.reason, wave: round15.wave, waveJobs: round15.waveJobs, scripts: round15.count,
        serialMs: ser15 && ser15.ms, parallelMs: par15 && par15.ms,
        /* `E110`：把"读数归属"（每一轮实际读的是哪份账）一并留痕，便于复核者核对 */
        serialLedger: ser15 && ser15.ledgerRel, parallelLedger: par15 && par15.ledgerRel,
        serialLedgerFrom: ser15 && ser15.ledgerFrom, parallelLedgerFrom: par15 && par15.ledgerFrom,
        serial: shape15(ser15 && ser15.ledger), parallel: shape15(par15 && par15.ledger) }, null, 2), 'utf8');
  } catch { /* 忽略 */ }
}

/* ---------------- 十五之②、`E88⒝`／`E99` 的定点回归（`E109`；2026-10-04） ----------------
   立案（座位 5 在 `C·20.7` `F-2` 报出，`T-20261004-05` 甲组收口）：`tests\run-all.js` 把
   `pickDetailLines`／`DETAIL_MAX_LINES`／`resolveLedgerFile`／`MAIN_LEDGER_NAME` 导出，并在注释里
   明写"一并导出，**供定点回归直接调用**"—— 但全仓 `git grep` **除定义处与 `module.exports` 外没有任何调用方**
   ⇒ 那条"定点回归"**根本不存在**：把 `--only` 改回写主账本、或把明细截断改回 `.slice(0,8)`，**门禁全绿**。
   本节按 `F-2` 的建议把它补上（**纯函数真值表 ＋ 一条端到端**），编号对应如下：
     ① `pickDetailLines`：命中 > 上限时**保住每一条"指名"行**（且"指名行比上限还多"时也只丢填充行）／
        命中 ≤ 上限时**全打**／`null`／`undefined`／空串**不炸**；
     ② `resolveLedgerFile` 三态：`--ledger` 显式优先（相对路径按**仓库根**解析）／`--only` ⇒ **自己的账本**／
        其余（**全量轮**与 `--fast`）⇒ **主账本** `run-totals.json`；
     ③ `failureNote` **刻意不在这里重复** —— 它已由座位 4 在 §十四 自检覆盖（同一件事写第二份真源，
        本身就是本仓反复出问题的"第二份口径"形态）；
     ④ **端到端**：`run-all --only <某脚本>` 一轮**前后主账本 `Buffer.compare` 逐字节不变**，
        且该轮确实声明并写出了**自己的子集账**（这是 `E99` 的实质守据 —— 只测纯函数测不到"谁写了盘"）。
   纪律：真源一律**直接 require `tests\run-all.js`**（`E99` 的实现就在那儿，不另抄一份规则）；
   变异一律走 `Module._compile` 的**内存副本**（不落地、不碰仓库、**不用**任何版本控制还原命令）。 */
t.section('十五之②、E88⒝／E99 的定点回归（E109：纯函数真值表 ＋ 主账本端到端）');
{
  const runAll9 = require('./run-all.js');
  const src9 = fs.readFileSync(path.join(env.paths.tests, 'run-all.js'), 'utf8');
  const loadVariant9 = (src) => {
    const Module = require('node:module');
    const m = new Module(path.join(__dirname, 'run-all.js'), null);
    m.filename = path.join(__dirname, 'run-all.js');
    m.paths = Module._nodeModulePaths(__dirname);
    m._compile(src, m.filename);
    return m.exports;
  };
  /* ---------------- ① `pickDetailLines` 真值表 ---------------- */
  const pick9 = runAll9.pickDetailLines;
  const max9 = runAll9.DETAIL_MAX_LINES;
  /** 造一份"命中 K 行噪声 ＋ N 行指名"的子进程输出：**指名行故意排在最后** ——
      旧实现 `.slice(0,8)` 丢的正是它们（`E88⒝` 的现场：真 `[FAIL]` 恰排在第 5 位、余量为 0）。 */
  const out9 = (noiseK, namedK) => Array.from({ length: noiseK }, (_, i) => `  [PASS] 失败清单 噪声条目 ${i + 1}`)
    .concat(Array.from({ length: namedK }, (_, i) => `  [FAIL] 定点断言 ${i + 1}`)).join('\n') + '\n';
  const namedIn9 = (lines) => lines.filter(l => /\[FAIL\]/.test(l)).length;
  const r9a = pick9(out9(30, 3));
  const r9b = pick9(out9(8, 3));
  const r9c = pick9(out9(10, max9 + 6));
  t.check('E109-①a `pickDetailLines`：命中 **33 行**（30 条"失败清单"噪声 ＋ 3 条指名，指名排在最后）'
    + ' ⇒ 只打上限行数，但 **3 条指名行一条不丢**（余量不足时也先保指名 —— `E88⒝` 的核心口径）',
    r9a.lines.length === max9 && r9a.dropped === 3 + 30 - max9 && r9a.named === 3 && namedIn9(r9a.lines) === 3,
    `上限=${max9}；实打 ${r9a.lines.length} 行、丢 ${r9a.dropped} 行、指名 ${r9a.named} 条；`
      + `打出来的指名行 ${namedIn9(r9a.lines)}/3（应 3/3）`);
  t.check('E109-①b `pickDetailLines`：命中 **11 行**（≤ 上限）⇒ **全部打印**、`dropped=0`'
    + '（未触上限时不得提前截断 —— 与旧行为一致的那一半）',
    r9b.lines.length === 11 && r9b.dropped === 0 && r9b.named === 3,
    `实打 ${r9b.lines.length} 行（应 11）、丢 ${r9b.dropped} 行（应 0）、指名 ${r9b.named} 条`);
  t.check('E109-①c `pickDetailLines`：`null`／`undefined`／空串**一律不炸**且返回空清单'
    + '（拿不到子进程输出的那一路不许把主控台打崩）',
    (() => {
      try {
        const a = pick9(null), b = pick9(undefined), c = pick9('');
        return a.lines.length === 0 && a.dropped === 0 && b.lines.length === 0 && c.lines.length === 0;
      } catch { return false; }
    })(),
    '三种"没有输出"的入参都必须返回 `{lines:[],dropped:0,named:0}`');
  t.check('E109-①d `pickDetailLines` 真值表**可证伪**（旧实现在同一输入上必丢指名）：'
    + '`hits.filter(…).slice(0, 8)` 这条旧写法在①a 的同一份输入上**一条指名行都留不下**（0/3），'
    + '而现行实现 3/3 —— 两侧读数都给出，证明 ①a 不是恒真式',
    (() => {
      const hits = String(out9(30, 3)).split('\n')
        .filter(l => /\[FAIL\]|失败清单|^\s+\d+\.|脚本异常终止/.test(l));
      /* 旧实现＝ `hits.filter(过滤器).slice(0, 8)`：**不区分指名/填充，直接砍到 8 行** */
      const oldShape = hits.slice(0, 8);
      return hits.length === 33 && oldShape.length === 8 && namedIn9(oldShape) === 0
        && namedIn9(r9a.lines) === 3;
    })(),
    '旧形态（`slice(0,8)`）打出来的 8 行 = 全噪声、指名 0/3；现行实现指名 3/3（同一份输入）');
  t.check('E109-①e `pickDetailLines`：**指名行比上限还多**时，超出的只能是填充行'
    + '（口径＝"任何一轮里含 `[FAIL]`／编号的行一行都不会因截断而消失"）',
    r9c.lines.length === max9 + 6 && r9c.named === max9 + 6 && r9c.dropped === 10 && namedIn9(r9c.lines) === max9 + 6,
    `输入 ${10} 噪声 ＋ ${max9 + 6} 指名 ⇒ 实打 ${r9c.lines.length} 行（应 ${max9 + 6}）、`
      + `丢 ${r9c.dropped} 行（应 10，全是噪声）、指名 ${namedIn9(r9c.lines)}/${max9 + 6}`);

  /* ---------------- ② `resolveLedgerFile` 三态真值表（＋ ③ 的边界说明见段首） ---------------- */
  const rl9 = runAll9.resolveLedgerFile;
  const verifyDir9 = env.paths.verify;           /* 只用来拼路径：`resolveLedgerFile` 不写任何文件 */
  const base9 = { verifyDir: verifyDir9, pid: 4242, root: env.paths.root };
  const pExplicit9 = rl9({ ...base9, explicit: path.join('e', 'x.json'), only: 'copy-check' });
  const pOnly9 = rl9({ ...base9, explicit: null, only: 'copy-check' });
  const pFull9 = rl9({ ...base9, explicit: null, only: null });
  const pFast9 = rl9({ ...base9, explicit: null, only: null });   /* `--fast` ＝ **不带 `--only`** 的全量集合，走同一支 */
  const nameOf9 = (p) => path.basename(p);
  t.check('E109-②a `resolveLedgerFile`：**`--ledger` 显式优先**（即使同时带 `--only`），'
    + '且相对路径按**仓库根**解析（不是按 cwd —— 调用方可能从别处起进程）',
    pExplicit9 === path.resolve(env.paths.root, path.join('e', 'x.json')),
    `显式 \`--ledger e\\x.json\` ＋ \`--only copy-check\` ⇒ ${pExplicit9}（应 ${path.resolve(env.paths.root, 'e/x.json')}）`);
  t.check('E109-②b `resolveLedgerFile`：**子集轮**（带 `--only`）⇒ 写**自己的账本**'
    + '`run-totals.subset-<pid>.json`，**不是**主账本（`E99` 的实质：残缺账不得覆写共享账本）',
    nameOf9(pOnly9) === `run-totals.subset-4242.json` && nameOf9(pOnly9) !== runAll9.MAIN_LEDGER_NAME
      && path.dirname(pOnly9) === path.resolve(verifyDir9),
    `\`--only copy-check\` ⇒ ${pOnly9}；主账本名 = ${runAll9.MAIN_LEDGER_NAME}`);
  t.check('E109-②c `resolveLedgerFile`：**全量轮与 `--fast`**（都不带 `--only`）⇒ **主账本**'
    + '`run-totals.json`，与历史行为逐字相同（`--fast` 刻意不改道：`docs-cross-check` 按这条路径取数）',
    pFull9 === pFast9 && nameOf9(pFull9) === runAll9.MAIN_LEDGER_NAME
      && path.dirname(pFull9) === path.resolve(verifyDir9),
    `无 \`--only\` ⇒ ${pFull9}；\`--fast\`（同一支）⇒ ${pFast9}；主账本名 = ${runAll9.MAIN_LEDGER_NAME}`);
  t.check('E109-②d 主账本**名字与位置一字不动**（`docs-cross-check` 第十一节按 `verify\\run-totals.json`'
    + '写死读取 ⇒ 改名/搬家会把权威对账的取数面改坏）',
    runAll9.MAIN_LEDGER_NAME === 'run-totals.json' && nameOf9(pFull9) === 'run-totals.json',
    `MAIN_LEDGER_NAME=${runAll9.MAIN_LEDGER_NAME}；主账本路径=${pFull9}`);
  /* D22（甲组要求：**把 `resolveLedgerFile` 的 `--only` 分支改回主账本 ⇒ 新断言必红并指名**）：
     变异在**内存副本**上做（`Module._compile`），盘上 `tests\run-all.js` 全程只读（下面用 `Buffer.compare` 证明）。 */
  const anchorOnly9 = 'if (only) return path.join(env.ensureDir(verifyDir), `run-totals.subset-${pid}.json`);';
  const onlyHits9 = src9.split(anchorOnly9).length - 1;
  const bytes9Before = fs.readFileSync(path.join(env.paths.tests, 'run-all.js'));
  let mutOnly9 = null, mutErr9 = '';
  try {
    if (onlyHits9 === 1) {
      mutOnly9 = loadVariant9(src9.replace(anchorOnly9,
        'if (only) return path.join(env.ensureDir(verifyDir), MAIN_LEDGER_NAME);'));
    } else { mutErr9 = `变异锚点命中 ${onlyHits9} 处（应恰 1，按符号定位、不引行号）`; }
  } catch (err) { mutErr9 = '变异体载入失败：' + (err && err.message); }
  const mutPath9 = mutOnly9 ? mutOnly9.resolveLedgerFile({ ...base9, explicit: null, only: 'copy-check' }) : null;
  const bytes9After = fs.readFileSync(path.join(env.paths.tests, 'run-all.js'));
  t.check('E109-② D22（可证伪）：把 `resolveLedgerFile` 的 `--only` 分支**改回主账本**'
    + '（`Module._compile` 内存副本，不落地）⇒ ②b 的判据**当场变红并指名**（返回的是主账本）；'
    + '且 `tests\\run-all.js` 盘上字节**逐字节未变**',
    Boolean(mutOnly9) && mutPath9 !== null && nameOf9(mutPath9) === runAll9.MAIN_LEDGER_NAME
      && nameOf9(pOnly9) !== runAll9.MAIN_LEDGER_NAME && Buffer.compare(bytes9Before, bytes9After) === 0,
    mutOnly9
      ? `变异体对 \`--only copy-check\` 返回 \`${mutPath9}\`（= 主账本名 ⇒ ②b 的 \`!== MAIN_LEDGER_NAME\` 与`
        + ` \`run-totals.subset-4242.json\` 两条同时失败）；现行实现返回 \`${pOnly9}\`；`
        + `盘上 run-all.js 未变=${Buffer.compare(bytes9Before, bytes9After) === 0}`
      : `**判红：${mutErr9}** —— 锚点漂了就等于 D22 没跑，不许当通过`);

  /* ---------------- ④ 端到端：`--only` 一轮前后，主账本逐字节不变 ---------------- */
  const mainLedger9 = path.join(env.paths.verify, runAll9.MAIN_LEDGER_NAME);
  const readMain9 = () => { try { return fs.readFileSync(mainLedger9); } catch { return null; } };
  const before9 = readMain9();
  const beforeMtime9 = (() => { try { return fs.statSync(mainLedger9).mtimeMs; } catch { return null; } })();
  const sub9 = spawnSync(process.execPath,
    [path.join(env.paths.tests, 'run-all.js'), '--no-preflight', '--only', 'platform-check'],
    { cwd: env.paths.root, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, DSH_JOBS: '1' } });
  const after9 = readMain9();
  const out9full = (sub9.stdout || '') + (sub9.stderr || '');
  const declared9 = (out9full.match(/实跑账：(.+?)（/) || [null, null])[1];
  const declaredAbs9 = declared9 ? path.resolve(env.paths.root, declared9.trim()) : null;
  const declaredName9 = declaredAbs9 ? path.basename(declaredAbs9) : '';
  let subLedger9 = null;
  try { subLedger9 = declaredAbs9 ? JSON.parse(fs.readFileSync(declaredAbs9, 'utf8')) : null; } catch { subLedger9 = null; }
  const sameMain9 = (before9 === null && after9 === null)
    || (before9 !== null && after9 !== null && Buffer.compare(before9, after9) === 0);
  t.check('E109-④ **端到端**（`E99` 的实质守据）：`run-all --no-preflight --only platform-check` 一轮，'
    + '**前后主账本 `run-totals.json` 逐字节不变**（`Buffer.compare`），而该轮**确实声明并写出了自己的子集账**'
    + '（子集账里 `ranSuites` ＝ 本轮那一个脚本）',
    sameMain9 && Boolean(declaredAbs9) && declaredName9 !== runAll9.MAIN_LEDGER_NAME
      && Boolean(subLedger9) && Array.isArray(subLedger9.ranSuites)
      && subLedger9.ranSuites.length === 1 && subLedger9.ranSuites[0] === 'platform-check',
    `主账本 ${mainLedger9}（${before9 ? before9.length : 0} B，mtime ${beforeMtime9}）`
      + ` ⇒ 子集轮后 ${after9 ? after9.length : 0} B；逐字节不变=${sameMain9}；`
      + `该轮声明的账本=\`${declared9 || '（输出里没有"实跑账："行）'}\`（应非主账本）；`
      + `子集账 ranSuites=${JSON.stringify(subLedger9 && subLedger9.ranSuites)}；退出码 ${sub9.status}`);
}

/* ---------------- 十六、脚本入口形态（`E78`：`main()` 的异常必须被接住、并按 9.5-5 退 2） ----------------
   立案（`E78`，2026-10-01 座位 5 普查后登记）：`E76①` 的靶子形态是"`async` 的 `main()` ＋ 顶层同步
   `try`/`catch`" —— promise 一旦 reject，顶层 try/catch **接不住**，进程以"未处理 rejection"收场：
   **无汇总行 ＋ 退 1**；而 9.5-5 的退出码契约要求"脚本自身异常"退 **2**。`E76①` 已修好 3 个脚本，
   当时**没有任何门禁守这个形态** ⇒ 新写脚本（或改回旧写法）时缺陷会静默回潮 —— 退 1 与"有断言失败"
   在 `run-all` 台账上**逐字同形**（见 `lib/assert.js` 末注），正是 `E76` 的起点。
   本节把"入口接线"变成静态判据：
     A 凡含 `main()` 声明的文件：**async** ⇒ 必须有 `main().catch(`（`.catch` 挂在 promise 上），
       且其异常路径退 2（`process.exit(2)` 或 `process.exitCode = 2`）；**sync** ⇒ 必须有顶层
       `try`/`catch`（或 `.catch`）且异常路径退 2；
     B **禁止形态**：对 async 的 `main` 用顶层同步 try 收尾 —— 这就是 `E76①` 的靶子；
     C **防空洞**（`D23`）：判据必须**指名**违规文件与形态（不许只报"有 1 个不合规"），
       且扫描器要认得出本仓真实写法（普查：`async function main(` 12 处／`function main(` 4 处，
       另有 `server\index.js` 的 `async function main(options = {})`；一并兼容 `main = async` 形式）
       —— 只认一种写法等于给别的写法开后门；并配 `D22` 定点变异（§16-C／§16-D）＋ 负对照（§16-E）。
   范围：`tests\*.js`（直下入口脚本）＋ `tests\lib\*.js` ＋ `server\index.js`（同为 `main()` 入口，
   与 `E78` 的普查口径一致：17 个）。`tests\._verify\` 下的历史副本/探针**不在范围** —— 那里存着
   旧写法的字节副本（`zz4b2-*`／`w4\bak\*` 等），纳入只会制造假红，与 `files-check` 的
   `SKIP_DIRS` 是同一处理。
   `E79` 收口（`T-20261002-01`，由座位 5 在 `T-20260930-33` 用 7 组灰盒等价实验立案）：上面那条
   "异常路径退 2"原本是**纯文本**判据 —— 它扫 `main().catch(`／`try { main() }` **之后直到文件尾**的
   整段文本（只由"尾部 ≤ 1500 字符"那一道门限制），于是同一段文本里的**注释**（F1）／**字符串常量**
   （F3）／**无关函数**（F4）里的 `process.exit(2)` 都被当成"退出证据"：catch 里其实退 1 也**假绿**；
   而 `process.exit(EXIT_ERROR)`（`tests\env.js:54` 的真常量 2，F5）反被判**红**。本节现按 E79 三步
   收口：① 先剥注释与字符串/模板串/正则（`stripLiterals`，**长度与换行保持** ⇒ 下标仍可做锚点）；
   ② 退出证据**只取异常路径自身**的配对区间（async＝`.catch(…)` 的实参区间，sync＝`catch (…) {…}`
   的块区间）；③ 退出码必须**证出是 2**（字面量 `2`，或 `tests\env.js` 真源里**值为 2** 的常量名）
   ——"认常量"不等于"认任何常量"（`EXIT_FAIL` 仍判红）。配对/花括号没闭合＝拿不到边界 ⇒ **判红**
   （判不了不许当通过）。F／G／H 三条新断言把上述四种形态逐一钉住；F 还在 `db-check.js` 的
   **字节副本**上做定点变异（sha256 留痕、`Buffer.compare` 证还原、全程不落盘、不用 `git checkout`）。 */
{
  /* 声明识别：取**最早**一处 `main` 声明 —— 注释/字符串里提到另一种写法时不至于误判
     （本文件下方就有 `async function main(` 的样例字符串，取最早即第 55 行的真声明）。
     并要求声明后面**紧跟函数体**（`(`…`)` 之后是 `{`）：否则 `lib/assert.js` 末注里那句
     "`function main()`（同步）的脚本…"会被当成声明（实测过，必须防）。 */
  const detectMainDecl = src => {
    const cands = [];
    const bodyFn = /function\s+main\s*\([^)]*\)\s*\{/g;
    const assign = /(?:^|\n)[ \t]*(?:const|let|var)?[ \t]*main[ \t]*=[ \t]*(async\b|function\b|\([^)]*\)[ \t]*=>)/g;
    let m;
    while ((m = bodyFn.exec(src))) {
      const isAsync = /async\s*$/.test(src.slice(Math.max(0, m.index - 16), m.index));
      cands.push({ idx: m.index, kind: isAsync ? 'async' : 'sync',
        form: isAsync ? '`async function main()`' : '`function main()`' });
    }
    while ((m = assign.exec(src))) {
      const isAsync = m[1] === 'async';
      cands.push({ idx: m.index, kind: isAsync ? 'async' : 'sync',
        form: isAsync ? '`main = async`' : '`main = function`' });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.idx - b.idx);
    return cands[0];
  };

  const MAIN_CATCH = /main\(\)\s*\.\s*catch\s*\(/;                        /* 推荐接法：.catch 挂在 promise 上 */
  const TOP_TRY_MAIN = /try\s*\{\s*main\s*\(\s*\)\s*;?\s*\}\s*catch/;    /* 靶子形态（对 async 无效） */
  /* 入口接线到文件尾的余量上限（`E79` 建议③：把原来的裸 1500 提为**具名常量**，值不变）。
     它只管"接线是不是落在尾部"，**不再**兼任"退出语句的搜索窗口" —— 退出证据改由下方 `hasExit2` ＋
     `asyncExitRegion`／`syncExitRegion` 从异常路径**自身**的区间里取（假阳性通道就在那个窗口上）。 */
  const ENTRY_TAIL_MAX = 1500;

  /* ---------------- `E79`：退出证据只认**异常路径自身的代码** ----------------
     旧写法把 `main().catch(` 之后的**整段文本**当"异常路径"，于是 F1 注释／F3 字符串/模板串／F4 其后
     无关函数里的 `process.exit(2)` 都算"退 2"（catch 里其实退 1 ⇒ 假绿）；F5 `process.exit(EXIT_ERROR)`
     反被判红。三步修法＝① 剥字面量（`stripLiterals`）② 只取异常路径自身的配对区间（`regionOf`）
     ③ 退出码必须**证出是 2**（`exitCodeOf`，真源＝`tests\env.js`）。 */
  const { createHash } = require('node:crypto');
  const sha256Hex = buf => createHash('sha256').update(buf).digest('hex');

  /* 退出码常量真源：**同源**读 `tests\env.js`（规范 9.5-5 的唯一定义处），不在这里写第二份数字 ——
     写死一份就是埋一个会漂移的副本（F5 的根因正是判据不认这份真源）。读不到就返回空表 ⇒
     §16-G 会因样本判红而**必红**（不许把"读不到真源"当通过）。 */
  const readExitConsts = () => {
    const map = new Map();
    let src = '';
    try { src = fs.readFileSync(path.join(env.paths.tests, 'env.js'), 'utf8'); } catch { return map; }
    const re = /const\s+(EXIT_[A-Z0-9_]+)\s*=\s*(\d+)\s*;/g;
    let m;
    while ((m = re.exec(src))) map.set(m[1], Number(m[2]));
    return map;
  };
  const EXIT_CONSTS = readExitConsts();

  /** `/` 是正则字面量还是除号？只看**前一个有效字符**（已剥区是空格 ⇒ 注释/字符串不干扰判断）。
      判错的代价：正则内容没剥掉（里面的 `{}`／`()` 会干扰配对 —— 由"配不上就判红"兜住），
      或把除法算式当正则剥掉（只有把 `process.exit` 整段吞掉才可能改变结论）。 */
  /* `E79` 的字面量剥除器（`isRegexStart` ＋ `stripLiterals`）已**迁到 `tests\lib\assert.js`**
     （`T-20261004-01`，`E103` 甲组）：`E103` 的 A/B 判据（§五 的 `e103LinkSafetyChecks`）要用**同一份**
     剥法 —— 留两份必然漂移（本仓的"单一真源"纪律）。语义**逐字未变**（长度与换行保持、`${` 只 blank `$`），
     顶部 `require` 已把**同一个函数对象**解构进来。 */

  /** 取 `openIdx` 处那个 `(`／`{` 的**配对**区间（未闭合返回 null ⇒ 调用方**必须判红**）。
      在**已剥字面量**的文本上做 ⇒ 字符串/注释/正则里的括号不会干扰配对。 */
  const regionOf = (code, openIdx) => {
    const open = code[openIdx];
    if (open !== '(' && open !== '{') return null;
    const close = open === '(' ? ')' : '}';
    let depth = 0;
    for (let i = openIdx; i < code.length; i++) {
      if (code[i] === open) depth++;
      else if (code[i] === close) { depth--; if (depth === 0) return { start: openIdx + 1, end: i, text: code.slice(openIdx + 1, i) }; }
    }
    return null;
  };

  /* 退出语句：`process.exit(<实参>)` 或 `process.exitCode = <表达式>`（都在**已剥字面量**的文本里找） */
  const EXIT_STMT = /process\.exit\s*\(\s*([^()]*)\s*\)|process\.exitCode\s*=\s*([^;\n]*)/g;

  /** 退出码**能证出是 2** 才算"退 2"：字面量 `2`，或 `tests\env.js` 真源里**值为 2** 的常量名（`EXIT_ERROR`）。 */
  const exitCodeOf = expr => {
    const e = String(expr == null ? '' : expr).trim();
    if (/^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(e)) return Number(e);
    if (/^[A-Za-z_$][\w$]*$/.test(e)) return EXIT_CONSTS.has(e) ? EXIT_CONSTS.get(e) : null;
    return null;   /* 算不出值（如 `process.exit(code)`）⇒ **不算**退 2：宁可判红，也不给"认任何常量"留口子 */
  };

  /** 在某段**已剥字面量**的文本里找"退 2"的退出语句 */
  const hasExit2 = code => {
    const g = new RegExp(EXIT_STMT.source, 'g');
    let m;
    while ((m = g.exec(code))) if (exitCodeOf(m[1] !== undefined ? m[1] : m[2]) === 2) return true;
    return false;
  };

  /** 取**最后**一处匹配：入口调用按约定在文件尾部（本仓 17 处，尾部都在 700 字符内） */
  const lastMatch = (re, src) => {
    const g = new RegExp(re.source, 'g');
    let m, last = null;
    while ((m = g.exec(src))) last = m;
    return last;
  };

  /** 从 `catch` 之后取 **catch 回调的配对区间**（`E82⒜` 后：块体与**表达式体**都要吃得下）。
      五种真实形态：
        · `} catch (err) { … }`              —— sync 入口的推荐写法；
        · `main().catch(err => { … })`       —— 实参是箭头函数、参数**没有**括号；
        · `.catch(async (err) => { … })`     —— 实参是带括号的参数表 ＋ 箭头；
        · `main().catch(err => process.exit(2));` —— **表达式体箭头**（合法简写、括号成对）；
        · 箭头体里出现 `{`/`}`（模板串 `${…}`、对象字面量）—— 见下。
      `E82⒜` 修正（2026-10-02，座位 5 于 C·17 报出、主代理实测 278/1 指名）：`E81` 的区间**只认块体**
      （下面的"块级 `{`"扫描）⇒ 表达式体简写会一路扫到文件里**下一个**无关的 `{`（或扫到文件尾）
      ⇒ 被判"括号在文件内没有闭合"而**假红**（文案与事实相反，`D23` 意义上的名不符实）。
      修法：在块扫描**之前**先认箭头（`arrowBodyOf`）；是表达式体就取"**外层调用的右括号**"之前的区间，
      只有真的取不到边界才 `{ text: null }`。
      做法（⚠ 实测坑，勿改回去）：
        ① **不能**从 `catch` 之后的 `(` 直接配起 —— 对 `.catch(` 来说那个 `(` 是"实参表的左括号"，
           直接配对会把**整个回调**当参数区，配完就找不到 `{`（那样全仓 13 个 async 入口会被假判红）；
        ② 参数表可能是**带括号**的（`.catch(async (err) => {`），要先把它整段跳过；
        ③ 找块时**必须按括号深度扫**：`(code.indexOf('=>'), code.indexOf('{'))` 这种"取更早者"的写法
           会被箭头体里的 `${…}`（如 `server\index.js` 的 `const text = \`[启动失败] ${err…}\``）带偏 ——
           那个 `{` 在括号深度 > 0 的位置 ⇒ 正文被截成半句、`process.exit(2)` 落在区间外，**假判红**。
      取不到（括号/块没闭合、或回调写成别处去了）一律 `{ text: null }` ⇒ 调用方**判红**（判不了不许当通过）。 */
  /** 箭头回调的**表达式体**区间（`=> expr`）：返回 `{ text }`；块体（`=> { … }`）返回 `null`
      交给下面的块扫描；不是箭头（如 `} catch (err) {`）也返回 `null`。
      边界算法：`.catch(` 的左括号占一层 ⇒ 从体起点起按 `(`／`[`／`{` 记深度，遇到让深度归零的
      右括号即**外层调用的右括号**（这就是表达式体的终点）。扫不到 ⇒ `{ text: null }`（判红）。 */
  const arrowBodyOf = (code, i) => {
    let k = i;
    if (code[k] !== '=' || code[k + 1] !== '>') {              /* 无括号的单参形态：`err => …` */
      if (!/[A-Za-z_$]/.test(code[k] || '')) return null;
      while (k < code.length && /[\w$]/.test(code[k])) k++;
      while (k < code.length && /\s/.test(code[k])) k++;
    }
    if (code[k] !== '=' || code[k + 1] !== '>') return null;
    k += 2;
    while (k < code.length && /\s/.test(code[k])) k++;
    if (code[k] === '{') return null;                          /* 块体 ⇒ 交给块扫描 */
    const start = k;
    let depth = 1;                                             /* `.catch(` 的左括号那一层 */
    for (; k < code.length; k++) {
      const ch = code[k];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return { text: code.slice(start, k) };
      }
    }
    return { text: null };
  };
  const catchBlockRegion = (code, m) => {
    if (!m) return { text: null };
    let i = m.index + m[0].length;                            /* `catch` 之后（`.catch(` 时已越过左括号） */
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] === '(') {                                    /* 带括号的参数表（`.catch(async (err) => {`） */
      const params = regionOf(code, i);
      if (!params) return { text: null };
      i = params.end + 1;
      while (i < code.length && /\s/.test(code[i])) i++;
    }
    /* `E82⒜`：表达式体简写必须先于块扫描被认出来（否则会去配文件里下一个无关的 `{`）。 */
    const arrow = arrowBodyOf(code, i);
    if (arrow) return arrow;
    let depth = 0;                                            /* 块级 `{` ＝ `(`／`[` 深度归零时的第一个 `{` */
    for (let k = i; k < code.length; k++) {
      const ch = code[k];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') { if (depth > 0) depth--; }
      else if (ch === '{' && depth === 0) {
        const body = regionOf(code, k);
        return { text: body ? body.text : null };
      }
    }
    return { text: null };
  };

  /** async 入口的异常路径区间＝**最后一处** `main().catch(` 的**实参**区间（text===null ⇒ 括号没闭合/没有接法） */
  const asyncExitRegion = code => catchBlockRegion(code, lastMatch(MAIN_CATCH, code));

  /** sync 入口的异常路径区间＝异常路径**自身**的 `catch` 块区间 —— 两种接法都覆盖：
        · `try { main(); } catch (…) { … }`（sync 的推荐写法）⇒ `catch` 块的配对区间；
        · `main().catch(…)`（`E81`：sync 的 `main` 没有 promise，故这里纯属**兜底形态**）⇒ 回调块的配对区间。
      `E81` 修前：`auditEntryShape` 的第三分支引用了 **async 专用**的 `asyncRegion`（对 sync 恒为 null）
      ⇒ 走到那里就抛 `TypeError: Cannot read properties of null (reading 'text')`，整轮断言一条都跑不出来
      （`E76` 的 `.catch` 接线把"主流程异常"落成"无汇总行 ＋ 退 2"）。现在改成**取 sync 自身的区间**，
      并把"取不到"与"没退 2"一样判红（判不了不许当通过）。 */
  const syncExitRegion = code => {
    const tryM = TOP_TRY_MAIN.exec(code);
    if (tryM) {
      /* `} catch` 形态：锚点＝`catch` 这个词；`m[0]` 的末 5 个字符就是 `catch` ⇒ 下标回退 5 */
      return catchBlockRegion(code, { index: tryM.index + tryM[0].length - 5, 0: 'catch' });
    }
    return catchBlockRegion(code, lastMatch(MAIN_CATCH, code));
  };

  /** 审计一批源码（纯函数，便于下方 D22 定点变异）：返回 { counts, offenders }
      判据（`E79` 后）＝**先剥字面量，再只看异常路径自身区间里的退出语句**：
        async ⇒ 必须有 `main().catch(`（`.catch` 挂在 promise 上），且**其实参区间**里退 2；
        sync  ⇒ 必须有顶层 `try`/`catch`（或 `.catch`），且**`catch` 的块区间**里退 2；
        禁止形态 ⇒ 对 async 的 `main` 用顶层同步 try 收尾（`E76①` 的原形态）。 */
  const auditEntryShape = sources => {
    const counts = { total: 0, async: 0, sync: 0 };
    const offenders = [];
    for (const { name, src } of sources) {
      const decl = detectMainDecl(src);
      if (!decl) continue;
      counts.total++;
      counts[decl.kind]++;
      /* 判据只在**代码**上做：注释/字符串/模板串/正则一律先剥成空格（F1/F3/F4 的诱饵由此失效） */
      const code = stripLiterals(src);
      const catchM = lastMatch(MAIN_CATCH, code);
      const tryM = TOP_TRY_MAIN.exec(code);
      /* 退出证据只取异常路径**自身**的配对区间（不再是"入口之后直到文件尾"的整段文本） */
      const asyncRegion = decl.kind === 'async' ? asyncExitRegion(code) : null;
      const syncRegion = decl.kind === 'sync' && tryM ? syncExitRegion(code) : null;
      if (decl.kind === 'async') {
        if (!catchM) {
          offenders.push(`${name}（${decl.form}）：没有 \`main().catch(\` ⇒ rejection 无人接住（9.5-5 要求退 2）`);
        } else if (src.length - catchM.index > ENTRY_TAIL_MAX) {
          offenders.push(`${name}（${decl.form}）：\`main().catch(\` 不在文件尾部（其后还有 ${src.length - catchM.index} 字符）—— 入口接线看不出在哪里收尾`);
        } else if (asyncRegion.text === null) {
          /* `E82⒜`：这里**只能**说"取不到边界" —— 旧文案写死"括号在文件内没有闭合"，
             而表达式体简写（括号明明成对）也会走到这一支 ⇒ 文案与事实相反（`D23`）。 */
          offenders.push(`${name}（${decl.form} ＋ \`.catch\`）：\`main().catch(\` 的异常路径区间**取不到**（实参表的括号没闭合、或回调写成别处去了）⇒ 拿不到边界（判不了就判红）`);
        } else if (!hasExit2(asyncRegion.text)) {
          offenders.push(`${name}（${decl.form} ＋ \`.catch\`）：异常路径**没退 2** —— 应在 \`.catch(…)\` **自身**的区间里含 process.exit(2)／process.exitCode = 2／值为 2 的常量退码`);
        }
        if (tryM) {
          offenders.push(`${name}（${decl.form}）：用了顶层同步 try 包 \`main()\` 的**靶子写法** ⇒ 对 async 无效，rejection 会落成"无汇总行 ＋ 退 1"（E76① 的原形态）`);
        }
      } else if (tryM) {
        if (syncRegion.text === null) {
          offenders.push(`${name}（${decl.form}）：顶层 \`try\`/\`catch\` 的 \`catch\` 块取不到（括号/块没闭合，或写成别处去了）⇒ 拿不到异常路径的边界（判不了就判红）`);
        } else if (!hasExit2(syncRegion.text)) {
          offenders.push(`${name}（${decl.form}）：顶层 \`try\`/\`catch\` 的异常路径**没退 2**（\`catch\` 块内缺 process.exit(2)／process.exitCode = 2／值为 2 的常量退码）`);
        }
      } else if (catchM) {
        /* `E81`：这里必须取 **sync 自身**的异常路径区间。修前引用的是 async 专用的 `asyncRegion`
           （对 sync 恒为 `null`）⇒ 本行抛 TypeError，整轮断言一条都跑不出来。 */
        const syncCatchRegion = syncExitRegion(code);
        if (syncCatchRegion.text === null) {
          /* 同 `E82⒜`：不得断言"括号没闭合"（表达式体等合法形态也会走到这里）。 */
          offenders.push(`${name}（${decl.form}）：\`main().catch(\` 的异常路径区间**取不到**（实参表的括号没闭合、或回调写成别处去了）⇒ 拿不到边界（判不了就判红）`);
        } else if (!hasExit2(syncCatchRegion.text)) {
          offenders.push(`${name}（${decl.form}）：\`.catch\` 的异常路径**没退 2**`);
        }
      } else {
        offenders.push(`${name}（${decl.form}）：既没有顶层 \`try\`/\`catch\` 也没有 \`.catch\` ⇒ 异常无人接住（9.5-5 要求退 2）`);
      }
    }
    return { counts, offenders };
  };

  /* 待审源码：`tests\` 直下 ＋ `tests\lib\` ＋ `server\index.js`（读不到就**报出来**，不静默少扫） */
  const listJs = relDir => fs.readdirSync(path.join(env.paths.root, relDir))
    .filter(n => n.endsWith('.js')).map(n => `${relDir}/${n}`);
  const entrySources = [];
  for (const rel of [...listJs('tests'), ...listJs('tests/lib'), 'server/index.js']) {
    try {
      entrySources.push({ name: rel.split('/').join('\\'), src: fs.readFileSync(path.join(env.paths.root, rel), 'utf8') });
    } catch (err) { t.info(`§16 读不到 ${rel}：${err.message}`); }
  }

  const real = auditEntryShape(entrySources);
  /* 普查地板 ＋ 两维**精确**（`D23` 防空洞）。**口径更正（`E82⒝`，2026-10-02，主代理裁定接受）**：
     ⚠ `FLOOR_TOTAL` 是一条**结构性死项**：`counts.total++` 与 `counts[kind]++` 在 `auditEntryShape()`
     里**同处发生** ⇒ `total ≡ async ＋ sync` 恒成立，两维精确后 `total` 必然是 20
     ⇒ "total ≥ 地板"既不会先失效、也没法单独失效（它只是"两维精确"的**算术推论**）。
     保留它的理由＝**防御性冗余**（万一将来有人删掉两维的精确判据，地板还能挡住"扫描面塌成 0"），
     但**不得**再把它当成独立的一条覆盖约束 —— 真正的约束是**两维各自精确**：
     新增/删除入口脚本必须**同批改本节**（连 `FLOOR_TOTAL` 一并改，或至少改两维）。
     **显式作废 `E78` 时代"实测新增不必改（下界照旧满足）"的说法**：那只对"只保下界"的旧口径成立；
     在"两维精确"下，新增一个入口就会让 `EXACT_ASYNC`／`EXACT_SYNC` 变红（**必须改本节**），
     而旧说法正是"形态迁移 ＋ 补偿性新增"这一 `≥` 下真漏洞的来源（严格更严，故保留双维精确）。
     另：`T-20261002-03`（`E80` 收口）把三个"直下但没入口声明"的门禁脚本（files／logic／platform）
     补成 `main()` 入口后，实跑值由 17/13/4 变为 **20/13/7**（口径：`tests\*.js` 直下 ＋ `tests\lib\*.js`
     ＋ `server\index.js`）—— 这三个新入口落进扫描面，§16-A 才看得见它们。

     另：`T-20261003-12`（座位 4b，`E9` 收口，2026-10-03）新增 `tests\offline-check.js`
     （交付包零依赖/零外网门禁；`function main()` sync ＋ 顶层 `try`/`catch` 退 2）⇒ 它是扫描面里的
     **第 8 个 sync 入口**，三个常数一并改为 **`21 / 13 / 8`**：
       · `FLOOR_TOTAL` 20 → **21**（`total ≡ async ＋ sync`，故它随两维走）；
       · `EXACT_SYNC`  7 → **8**；`EXACT_ASYNC` **13 不动**（新脚本是同步入口）。
     ⚠ 这就是本注释上一段预告的"**新增入口必须同批改本节**"的第一个实例 —— 与新脚本**同一批**落地
     （`E78` 时代"实测新增不必改（下界照旧满足）"的说法已显式作废）。 */
  const FLOOR_TOTAL = 21;
  const EXACT_ASYNC = 13;
  const EXACT_SYNC = 8;
  t.info(`§16 入口形态普查：${real.counts.total} 个含 \`main()\` 的入口（async ${real.counts.async}／sync ${real.counts.sync}／缺陷形态 ${real.offenders.length}）`);
  t.info(`§16 E79：退出证据只取异常路径**自身**的区间（注释/字符串/模板串/正则已剥；接线到文件尾的余量上限＝${ENTRY_TAIL_MAX} 字符）；`
    + `常量退码真源＝tests\\env.js（${[...EXIT_CONSTS].map(([k, v]) => k + '=' + v).join('／') || '**读不到真源**'}）`);
  /* 逐个子条件算出来（`E82⒝` 的第二半）：FAIL 的**首句**必须是"判红 + 未成立的子条件"，
     而不是旧写法里那句"形态全部合规"（与结论相反 —— 主代理在自己的变异轮里也见到过同一句）。 */
  const shapeConds = [
    { name: '缺陷形态逐条指名', ok: real.offenders.length === 0,
      why: real.offenders.length
        ? `违规 ${real.offenders.length} 处（逐条指名文件与形态）：${real.offenders.join('；')}`
        : '（无违规）' },
    { name: `扫描面 ≥ ${FLOOR_TOTAL}（**结构性死项**：两维精确的算术推论，只作防御性冗余）`,
      ok: real.counts.total >= FLOOR_TOTAL,
      why: `实测 total=${real.counts.total}（＝async ${real.counts.async} ＋ sync ${real.counts.sync}）` },
    { name: `async 维度精确 = ${EXACT_ASYNC}`, ok: real.counts.async === EXACT_ASYNC,
      why: `实测 async=${real.counts.async}` },
    { name: `sync 维度精确 = ${EXACT_SYNC}`, ok: real.counts.sync === EXACT_SYNC,
      why: `实测 sync=${real.counts.sync}` }
  ];
  const shapeBad = shapeConds.filter(c => !c.ok);
  t.check('§16-A 静态：含 `main()` 的入口形态全部合规（async ⇒ `main().catch(` ＋ 退 2；sync ⇒ `try`/`catch` ＋ 退 2；禁止对 async 用顶层同步 try 包 `main()`）',
    shapeBad.length === 0,
    shapeBad.length
      ? `判红：**未成立的子条件 ${shapeBad.length} 项** —— ${shapeBad.map(c => `${c.name}（${c.why}）`).join('；')}；`
        + `普查 ${real.counts.total} 个（async ${real.counts.async}／sync ${real.counts.sync}）`
      : `普查 ${real.counts.total} 个（async ${real.counts.async}／sync ${real.counts.sync}），形态全部合规`
        + `；四个子条件逐项成立：缺陷形态 0 ＋ total ${real.counts.total} ≥ ${FLOOR_TOTAL}（算术推论）`
        + ` ＋ async = ${EXACT_ASYNC} ＋ sync = ${EXACT_SYNC}`
        + `（新增/删除入口脚本必须**同批改本节**的这三个数字 —— 显式作废 E78 的"新增不必改"）`);

  /* §16-L 入口覆盖普查（`E80`）：`tests\*.js` 直下的每个门禁脚本都必须是"被 §十六 扫到的入口"。
     `E82⒞`（FAIL 明细要能**指名**，2026-10-02 收口）：旧写法把 FAIL 的说明**写死**成三个文件名文本
     （`files-check`／`logic-check`／`platform-check`，即 `E80` 当时缺的那三个）⇒ 只缺 1 个时会被读成缺 3 个；
     真凶只在 **info 行**上，而 `run-all.js:962` 的明细过滤只认 `[FAIL]`／`失败清单`／编号行／
     `脚本异常终止`（**不认** info 行）⇒ run-all 明细层面**失去指名能力**（`D23` 未达成）。
     现在 FAIL 明细**动态拼 `missing`**（只列实测缺的那些）。
     `E82⒟`（判据自证要**可假**）：旧探针把每条样本的 `src` 写成 `''`，而 `detectMainDecl('') === null`
     恒真 ⇒ `selfProves` **恒真**（自证力为零）。现在改用**真实入口样本**两问：
       ① 每个非豁免直下脚本的**真源码**都必须被 `detectMainDecl()` 认出（识别能力的正证）；
       ② 抽其中**一个**真样本、把它的 `main` 声明**抠掉**（正则替换）⇒ 必须**恰好那一个**被判据指名
          （判据的**可假**自证）。两问同时成立才算自证 —— 它现在是可假的。 */
  const l16 = (() => {
    const baseOf = rel => rel.slice(rel.lastIndexOf('/') + 1);
    /* **显式豁免清单**（每条都写理由；豁免≠"可以不查"，而是"它不是门禁入口"）：
       · `env.js`：被 require 的模块 —— 它**实现** `env.assertRuntime()` 并定义退出码/路径常量真源
         （规范 9.5-5），本身不是门禁入口（`files-check` 第八节也把它排除在"必须调 assertRuntime"之外）；
       · 范围口径：`tests\lib\*.js` 是夹具层（被 require 的模块），不属"直下入口"，本节既有范围即不含它们。
       其余直下脚本（含 `capture-baseline`／`screenshot-diff` 这类工具脚本）**都要求有入口声明** ——
       没有入口的脚本，§16-A 与 `run-all` 的失败明细**都看不见它**（`E80` 的两个盲区）。 */
    const EXEMPT = new Set(['env.js']);
    const direct = listJs('tests');                            /* tests\ 直下的 .js 全量（含豁免项） */
    const nonExempt = direct
      .map(rel => ({ rel, base: baseOf(rel), name: rel.split('/').join('\\') }))
      .filter(x => !EXEMPT.has(x.base));
    const realSrcOf = name => {
      const hit = entrySources.find(s => s.name === name);
      return hit ? hit.src : null;                             /* 读不到 ⇒ null（判不了就判红） */
    };
    const missing = nonExempt.filter(x => !detectMainDecl(realSrcOf(x.name) || '')).map(x => x.name);
    /* 自证①：真样本的识别率 */
    const detectorHits = nonExempt.filter(x => !!detectMainDecl(realSrcOf(x.name) || ''));
    /* 自证②：抠掉 `main` 声明的**真样本**（两种声明写法都要抠得掉；抠不干净就换下一个样本） */
    const stripMainDecl = src => src
      .replace(/function(\s+)main(\s*\()/g, 'function$1__e82StrippedMain$2')
      .replace(/((?:^|\n)[ \t]*(?:const|let|var)?[ \t]*)main([ \t]*=[ \t]*(?:async\b|function\b|\())/g,
        '$1__e82StrippedMain$2');
    const victim = nonExempt.find(x => {
      const s = realSrcOf(x.name);
      return !!s && !!detectMainDecl(s) && detectMainDecl(stripMainDecl(s)) === null;
    }) || null;
    const probeMissing = victim === null ? [] : [victim.name];
    const selfProves = victim !== null && detectorHits.length === nonExempt.length &&
      probeMissing.length === 1 && probeMissing[0] === victim.name;
    return { direct, EXEMPT, nonExempt, missing, detectorHits, victim, selfProves };
  })();
  t.info(`§16-L 直下脚本 ${l16.direct.length} 个：豁免 ${l16.EXEMPT.size} 个（${[...l16.EXEMPT].join('、')}：被 require 的模块，实现 assertRuntime 与常量真源，不是门禁入口）；`
    + `被 §十六 扫到的入口 ${l16.nonExempt.length - l16.missing.length} 个；`
    + `缺失入口声明 ⇒ 指名：${l16.missing.join('、') || '（无）'}；`
    + `判据自证（**真实入口样本**：${l16.detectorHits.length}/${l16.nonExempt.length} 被认出 ＋ 抠掉 `
    + `${l16.victim ? l16.victim.name : '（无可变异真样本）'} 的 \`main()\` 声明后必被指名）＝${l16.selfProves}`);
  t.check('§16-L 入口覆盖普查：`tests\\*.js` 直下的每个门禁脚本都必须是"被 §十六 扫到的入口"（声明了 `main()`）；缺失者逐条指名，豁免项显式列明理由',
    l16.missing.length === 0 && l16.selfProves,
    l16.missing.length
      ? `判红：缺失入口声明 **${l16.missing.length} 个**（**逐条指名**，只列实测缺的那些）：${l16.missing.join('、')}`
        + ` —— 没有入口的脚本不在 §十六 的扫描面内，\`run-all\` 的失败明细也认不出它们的裸栈（\`E80\` 的两个盲区）；`
        + `豁免只有 ${[...l16.EXEMPT].join('、')}（理由见 info 行）；判据自证＝${l16.selfProves}`
      : (l16.selfProves
        ? `直下脚本 ${l16.direct.length} 个，非豁免 ${l16.nonExempt.length} 个**全部**被 §十六 扫到（豁免只有 `
          + `${[...l16.EXEMPT].join('、')}，理由见 info 行）；判据自证成立＝真样本 ${l16.detectorHits.length}/`
          + `${l16.nonExempt.length} 被认出 ＋ 抠掉 ${l16.victim ? l16.victim.name : '（无）'} 的 \`main()\` 声明后必被指名`
        : `判红：入口覆盖本身齐了（missing=0），但**判据自证不成立**（真样本被认出 ${l16.detectorHits.length}/`
          + `${l16.nonExempt.length}；可变异真样本＝${l16.victim ? l16.victim.name : '**一个都找不到**'}）`
          + ` ⇒ 这条判据可能已退化成恒真，必须先修判据（不得当作通过）`));

  t.check('§16-B 扫描器自证：`async function main`／`function main`／`main = async` 三种真实写法都被识别，注释里的 `function main()`（无函数体）与不含 `main` 的源码都不计入',
    (() => {
      const a = detectMainDecl('async function main() {\n}\n');
      const b = detectMainDecl('function main() {\n}\n');
      const c = detectMainDecl('const main = async () => {\n};\n');
      const d = detectMainDecl('const x = 1;\nfoo();\n');
      const e = detectMainDecl('· `function main()`（同步）的脚本 ⇒ 顶层 `try`/`catch` ＋ 退 **2**\n');
      return !!a && a.kind === 'async' && !!b && b.kind === 'sync' && !!c && c.kind === 'async'
        && d === null && e === null;
    })(),
    '期望：async／sync／async／null／null —— 少一种识别能力就等于给那种写法开后门（`E78` 的判据必须认得出本仓真实形态）');

  /* 变异靶子：`db-check.js`（`E76①` 三个受害脚本之一）。锚点用**正则**而非写死行号/片段，
     文件长大也不失效；锚点未命中一律按**失败**处理（不许把"跑不了"当通过）。 */
  let dbSrc = '';
  try { dbSrc = fs.readFileSync(path.join(env.paths.tests, 'db-check.js'), 'utf8'); }
  catch (err) { t.info('§16 读不到 db-check.js（D22 靶子）：' + err.message); }
  const dbName = 'tests\\db-check.js';
  /* 靶子形态用**拼接**构造：本节的 forbidden/明细判据都是**文本**判据，若在源码里原样写出
     `try {` 紧跟 `main()`，本文件自己就会被自己命中（文本判据的经典自伤）。 */
  const TARGET_FORM = 'try {' + '\n  main();\n} catch (err) {\n  console.error(String(err && err.stack ? err.stack : err));\n  process.exit(2);\n}\n';

  t.check('§16-C D22 变异①：把 `db-check.js` 尾部换回顶层同步 try 包 `main()` 的靶子写法 ⇒ §16-A 判据必红并**指名** db-check（这正是 E76① 的原形态）',
    (() => {
      const anchor = lastMatch(MAIN_CATCH, dbSrc);
      if (!anchor) { t.info('§16-C 锚点未命中：`db-check.js` 里找不到 `main().catch(`（文件被改过？）'); return false; }
      const mutated = dbSrc.slice(0, anchor.index) + TARGET_FORM;
      const res = auditEntryShape([{ name: dbName, src: mutated }]);
      const allNamed = res.offenders.length > 0 && res.offenders.every(o => o.startsWith(dbName));
      const bothForms = res.offenders.some(o => o.includes('靶子写法')) && res.offenders.some(o => o.includes('rejection 无人接住'));
      return allNamed && bothForms;
    })(),
    `变异内容：删掉 \`${dbName}\` 的 \`main().catch(…)\` 收尾，换成顶层同步 try 包 \`main()\`（catch 里仍退 2）`
      + ' —— 判红必须**指名文件与形态**，而不是只报"有 1 个不合规"');

  t.check('§16-D D22 变异②：把 `db-check.js` 异常路径的 `process.exit(2)` 改成 `process.exit(1)` ⇒ §16-A 判据必红并**指名**退错码',
    (() => {
      const anchor = lastMatch(MAIN_CATCH, dbSrc);
      if (!anchor) { t.info('§16-D 锚点未命中：`db-check.js` 里找不到 `main().catch(`'); return false; }
      const tail = dbSrc.slice(anchor.index);
      if (!tail.includes('process.exit(2)')) { t.info('§16-D 锚点未命中：`main().catch` 之后的收尾里没有 `process.exit(2)`'); return false; }
      const mutated = dbSrc.slice(0, anchor.index) + tail.replace('process.exit(2)', 'process.exit(1)');
      const res = auditEntryShape([{ name: dbName, src: mutated }]);
      return res.offenders.length === 1 && res.offenders[0].startsWith(dbName) && res.offenders[0].includes('没退 2');
    })(),
    `变异内容：\`${dbName}\` 的 \`main().catch\` 收尾由 \`process.exit(2)\` 改成 \`process.exit(1)\``
      + '（退 1 在 run-all 账上与"有断言失败"逐字同形，故必须退 2）');

  /* 合成样本（只用于扫描器自证/负对照，不落地）。`try {` 与 `main()` 之间**必须**用拼接断开：
     理由同上——否则本文件自己的源码就命中自己的 forbidden 正则。 */
  const SAMPLE_ASYNC_OK = 'async function main() { done(); }\n\nmain().catch(err => {\n  console.error(String(err));\n  process.exit(2);\n});\n';
  const SAMPLE_SYNC_OK = 'function main() { done(); }\n' + 'try {' + '\n  main();\n} catch (err) {\n  console.error(String(err));\n  process.exit(2);\n}\n';
  t.check('§16-E 负对照：合规的 async／sync 入口样本都**不被**误报（防"把一切都判红"的假红式断言）',
    (() => {
      const a = auditEntryShape([{ name: '（合成 async 合规样本）', src: SAMPLE_ASYNC_OK }]);
      const s = auditEntryShape([{ name: '（合成 sync 合规样本）', src: SAMPLE_SYNC_OK }]);
      return a.offenders.length === 0 && s.offenders.length === 0 && a.counts.async === 1 && s.counts.sync === 1;
    })(),
    '合规样本：async ⇒ `main().catch(…退 2)`；sync ⇒ 顶层 `try`/`catch` ＋ 退 2 —— 两者都必须判绿（否则"判红"只是把一切都判红，那种断言没有证据力）');

  /* ---------------- `E79` 收口的四条自证（F／G／H／I，均配 D22 定点变异） ----------------
     敏感文本（`process.exit(2)`／`try {`＋`main();`）一律**字符串拼接**构造：本文件自己也在 §16 的
     扫描范围内，原样写出就会命中的自己的文本判据（`E78` 时代的技巧，保留）。 */
  const E2TEXT = 'process.exit(' + '2)';
  const mkAsyncEntry = body => 'async function main() { done(); }\n\n'
    + 'main().catch(err => {\n' + '  console.error(String(err));\n' + body + '\n});\n';
  /* 诱饵（四种形态都落在旧判据的 1500 字符窗口内）：F1 块注释／F3 字符串／**F4 无关函数（真代码）** ——
     旧判据把"入口之后直到文件尾"的整段文本当异常路径，于是这些诱饵都成了"退出证据"（catch 里退 1 也判绿）。 */
  const DECOY_AFTER_ENTRY = '\n/* 诱饵①（块注释）：' + E2TEXT + ' */'
    + '\n// 诱饵②（行注释）：这里必须 ' + E2TEXT
    + '\nconst DECOY_NOTE = ' + JSON.stringify(E2TEXT) + ';   /* 诱饵③（字符串常量） */'
    + '\nfunction unrelatedHelper() {   /* 诱饵④（无关函数，真代码 —— 旧判据会把它当退出证据） */'
    + '\n  ' + E2TEXT + ';'
    + '\n}\n';

  /* §16-F：`E79` 的**现场**（D22 变异③）—— catch 里其实**退 1**，只在它之后（旧判据的 1500 字符窗口
     内）放注释①与**无关函数**④里的 `process.exit(2)`。旧判据实测 `offenders=0`（**假绿**，座位 5 的
     7 组灰盒实验），新判据必须**判红并指名** `tests\db-check.js`。变异在**字节副本**上做：sha256 留痕、
     全程不落盘、`Buffer.compare` 证明"还原后的字节"与原文件逐字节相等（不使用 `git checkout`）。 */
  t.check('§16-F D22 变异③：异常路径其实退 1、但其后注释里有 process.exit(2) ⇒ §16-A 必红并指名',
    (() => {
      const target = path.join(env.paths.tests, 'db-check.js');
      const bytes = fs.readFileSync(target);                     /* 字节副本①（原件只读，不写盘） */
      const sha0 = sha256Hex(bytes);
      const anchor = lastMatch(MAIN_CATCH, dbSrc);
      if (!anchor) { t.info('§16-F 锚点未命中：`db-check.js` 里找不到 `main().catch(`'); return false; }
      const tail = dbSrc.slice(anchor.index);
      const cut = tail.indexOf(E2TEXT);
      if (cut < 0) { t.info('§16-F 锚点未命中：`main().catch` 之后的收尾里没有 process.exit(2)'); return false; }
      /* 诱饵四种形态都塞进旧判据的窗口里：F1 注释、F3 字符串、F4 其后**无关函数**（真代码） */
      const DECOY = DECOY_AFTER_ENTRY;
      /* 变异体：异常路径改成**退 1**（其余原样）＋ 诱饵 */
      const head = dbSrc.slice(0, anchor.index) + tail.slice(0, cut) + 'process.exit(' + '1)' + tail.slice(cut + E2TEXT.length);
      const mutantBytes = Buffer.from(head + DECOY, 'utf8');      /* 字节副本②：变异体 */
      const mutant = auditEntryShape([{ name: dbName, src: mutantBytes.toString('utf8') }]);
      /* 对照：诱饵原样保留、异常路径的退码**不动** ⇒ 必须判绿（证明诱饵本身不是判红的原因，
         且"只认异常路径区间"没有把真正的退出语句一起挡掉 —— 防假红式断言） */
      const controlBytes = Buffer.from(dbSrc + DECOY, 'utf8');
      const control = auditEntryShape([{ name: dbName, src: controlBytes.toString('utf8') }]);
      /* 还原证明：由副本①重建 ⇒ 与副本①逐字节相等（sha256 相同）；再复核**盘上文件全程未变** */
      const restored = Buffer.from(bytes);
      const byteSame = Buffer.compare(restored, bytes) === 0;
      const shaSame = sha256Hex(restored) === sha0;
      const diskSame = sha256Hex(fs.readFileSync(target)) === sha0;
      const mutantNamed = mutant.offenders.length > 0 && mutant.offenders.every(o => o.startsWith(dbName));
      t.info(`§16-F 变异体 sha256=${sha256Hex(mutantBytes).slice(0, 12)}…（原件 sha256=${sha0.slice(0, 12)}…）；`
        + `变异体判红 ${mutant.offenders.length} 条／对照判红 ${control.offenders.length} 条；`
        + `还原 Buffer.compare=${byteSame}／sha256 一致=${shaSame}／盘上文件未变=${diskSame}`);
      return mutantNamed && mutant.offenders.some(o => o.includes('没退 2'))
        && control.offenders.length === 0 && byteSame && shaSame && diskSame;
    })(),
    '修正前实测（旧判据＝扫 `main().catch(` 之后的**整段文本**，只由 1500 那道门限制）：同一个变异体 `offenders=0`（**假绿**）—— 这就是 `E79` 的现场；'
      + '新判据必须判红并**指名** `tests\\db-check.js`（ADR-0004 D22：判据必须被定点变异证伪过才可信）');

  /* §16-G：**常量退码**自证（F5）。常量口径与 `tests\env.js:52-54` **同源**（读它的源码），
     但"认常量"不等于"认任何常量"：`EXIT_FAIL`(1)／`EXIT_PASS`(0)／叫不出名字的标识符一律判红。 */
  t.check('§16-G 常量退码自证：process.exit(EXIT_ERROR)/exitCode = EXIT_ERROR（=2）判绿，process.exit(EXIT_FAIL)（=1）判红',
    (() => {
      const NAME = '（合成常量退码样本）';
      const green = [mkAsyncEntry('  process.exit(EXIT_ERROR);'),
        mkAsyncEntry('  process.exitCode = EXIT_ERROR;')];
      const red = [mkAsyncEntry('  process.exit(EXIT_FAIL);'),
        mkAsyncEntry('  process.exit(EXIT_PASS);'),
        mkAsyncEntry('  process.exit(SOME_OTHER_CODE);')];
      const greenOffenders = green.map(s => auditEntryShape([{ name: NAME, src: s }]).offenders);
      const redOffenders = red.map(s => auditEntryShape([{ name: NAME, src: s }]).offenders);
      /* 同源核对：值必须来自 `tests\env.js`（读源码解析）且与 require 到的那份模块逐名一致 */
      const sameOrigin = EXIT_CONSTS.get('EXIT_ERROR') === 2 && EXIT_CONSTS.get('EXIT_FAIL') === 1
        && EXIT_CONSTS.get('EXIT_PASS') === 0 && EXIT_CONSTS.get('EXIT_ERROR') === env.EXIT_ERROR
        && EXIT_CONSTS.get('EXIT_FAIL') === env.EXIT_FAIL && EXIT_CONSTS.get('EXIT_PASS') === env.EXIT_PASS;
      const redNamed = redOffenders.every(list => list.length > 0
        && list.every(o => o.startsWith(NAME) && o.includes('没退 2')));
      t.info(`§16-G 常量真源（解析 tests\\env.js 源码）：${[...EXIT_CONSTS].map(([k, v]) => k + '=' + v).join('／') || '空'}；`
        + `与 env 模块逐名一致=${sameOrigin}；退 2 常量样本判红 ${greenOffenders.filter(l => l.length).length} 条`
        + `（应 0）／非 2 常量样本判红 ${redOffenders.filter(l => l.length).length}/${red.length} 条（应全红）`);
      return greenOffenders.every(l => l.length === 0) && redNamed && sameOrigin;
    })(),
    '同源＝读 `tests\\env.js`（规范 9.5-5 的唯一定义处）解析出 `EXIT_ERROR=2`；反证＝同一位置换成 '
      + '`EXIT_FAIL`(1)／`EXIT_PASS`(0)／未知标识符 ⇒ 必须判红（"认常量"若做成"认任何常量"，本条必红）');

  /* §16-H：**字面量剥除**自证 —— 字符串/模板串/注释里的 `process.exit(2)` 不构成退出证据；
     对照样本（同一段诱饵 ＋ 一条**真**退出语句）必须判绿 ⇒ 证明剥除没有把整段区间一起废掉。 */
  t.check('§16-H 字面量剥除自证：字符串/模板串里的 process.exit(2) 不构成退出证据',
    (() => {
      const NAME = '（合成字面量诱饵样本）';
      const decoys = '  console.error(' + JSON.stringify(E2TEXT) + ');\n'
        + '  // ' + E2TEXT + '\n'
        + '  /* ' + E2TEXT + ' */\n'
        + '  const note = `' + E2TEXT + '`;';
      const onlyDecoys = auditEntryShape([{ name: NAME, src: mkAsyncEntry(decoys) }]);
      const withReal = auditEntryShape([{ name: NAME, src: mkAsyncEntry(decoys + '\n  ' + E2TEXT + ';') }]);
      t.info(`§16-H 诱饵计数：仅字面量 ⇒ 判红 ${onlyDecoys.offenders.length} 条（应 ≥1 并指名）；`
        + `字面量 ＋ 真退出语句 ⇒ 判红 ${withReal.offenders.length} 条（应 0）`);
      return onlyDecoys.offenders.length > 0
        && onlyDecoys.offenders.every(o => o.startsWith(NAME) && o.includes('没退 2'))
        && withReal.offenders.length === 0;
    })(),
    '反证：若不剥字面量（旧判据），"仅字符串/模板/注释里出现 process.exit(2)"会判**绿**（假阳性通道）；'
      + '对照样本证明剥除没有把真退出语句一起挡掉（防"把一切都判红"）');

  /* §16-I：**sync 分支**同样只认异常路径自身（`catch` 的块区间）—— 被修改过的判据都要被定点变异证伪过。
     靶子＝`copy-check.js`（4 个 sync 入口之一，写法 `try { main(); } catch`）的**字节副本**：块里退 1 ＋
     块**外**的四种诱饵 ⇒ 必红并指名；对照（诱饵原样、退码仍是 2）⇒ 必绿。 */
  t.check('§16-I sync 异常路径自证：`catch` 块里退 1、块外注释/字符串/无关函数里有 process.exit(2) ⇒ 判红并指名（sync 分支也只认自身区间）',
    (() => {
      const target = path.join(env.paths.tests, 'copy-check.js');
      const bytes = fs.readFileSync(target);                     /* 字节副本①（只读，不写盘） */
      const sha0 = sha256Hex(bytes);
      const src = bytes.toString('utf8');
      const tryM = TOP_TRY_MAIN.exec(stripLiterals(src));
      if (!tryM) { t.info('§16-I 锚点未命中：`copy-check.js` 里找不到 `try { main(); } catch`'); return false; }
      const cut = src.indexOf(E2TEXT, tryM.index);
      if (cut < 0) { t.info('§16-I 锚点未命中：`try` 之后没有 process.exit(2)'); return false; }
      const name = 'tests\\copy-check.js';
      /* 变异体：catch 块里改成**退 1**（其余原样）＋ 诱饵（都在旧判据扫过的"入口之后"文本里） */
      const mutantBytes = Buffer.from(src.slice(0, cut) + 'process.exit(' + '1)'
        + src.slice(cut + E2TEXT.length) + DECOY_AFTER_ENTRY, 'utf8');
      const mutant = auditEntryShape([{ name, src: mutantBytes.toString('utf8') }]);
      const controlBytes = Buffer.from(src + DECOY_AFTER_ENTRY, 'utf8');
      const control = auditEntryShape([{ name, src: controlBytes.toString('utf8') }]);
      const restored = Buffer.from(bytes);                       /* 还原证明（与 F 同款纪律） */
      const byteSame = Buffer.compare(restored, bytes) === 0;
      const shaSame = sha256Hex(restored) === sha0;
      const diskSame = sha256Hex(fs.readFileSync(target)) === sha0;
      t.info(`§16-I 变异体 sha256=${sha256Hex(mutantBytes).slice(0, 12)}…（原件 sha256=${sha0.slice(0, 12)}…）；`
        + `变异体判红 ${mutant.offenders.length} 条／对照判红 ${control.offenders.length} 条；`
        + `还原 Buffer.compare=${byteSame}／sha256 一致=${shaSame}／盘上文件未变=${diskSame}`);
      return mutant.offenders.length > 0 && mutant.offenders.every(o => o.startsWith(name))
        && mutant.offenders.some(o => o.includes('没退 2'))
        && control.offenders.length === 0 && byteSame && shaSame && diskSame;
    })(),
    '修正前实测（旧 sync 判据＝扫 `try { main(); }` 之后的**整段文本**）：同一变异体 `offenders=0`（**假绿**）；'
      + '新 sync 判据只看 `catch` 块自身的区间 ⇒ 必须判红并**指名** `tests\\copy-check.js`');

  /* §16-J／§16-K：**sync ＋ `.catch`（无顶层 `try`）**这条分支的自证（`E81`）。
     `E81` 现场：该分支引用的是 **async 专用**的 `asyncRegion`，而它对 sync 恒为 `null`
     ⇒ 走到那里就抛 `TypeError: Cannot read properties of null (reading 'text')`；由于它在**主流程**
     `auditEntryShape(entrySources)` 里，整轮断言**一条都跑不出来**（`E76` 的 `.catch` 接线把它落成
     "无汇总行 ＋ 退 2"，`run-all` 记 `error` —— 可见，但本节整支失效）。
     敏感文本一律字符串拼接构造（同 §16-C/E 的理由：本文件自己也在 §16 的扫描范围内）。 */
  const mkSyncCatchEntry = body => 'function main() { done(); }\n\n'
    + 'main().catch(err => {\n' + '  console.error(String(err));\n' + body + '\n});\n';

  t.check('§16-J sync ＋ `.catch`（无顶层 `try`）分支自证：合规样本（`.catch` 区间内退 2）判绿、非法样本（区间内退 1）判红并指名，且**全程不抛异常**',
    (() => {
      const NAME_OK = '（合成 sync＋.catch 合规样本）';
      const NAME_BAD = '（合成 sync＋.catch 退 1 样本）';
      const bad = 'process.exit(' + '1)';
      let ok = null, red = null, thrown = null;
      try {
        ok = auditEntryShape([{ name: NAME_OK, src: mkSyncCatchEntry('  ' + E2TEXT + ';') }]);
        red = auditEntryShape([{ name: NAME_BAD, src: mkSyncCatchEntry('  ' + bad + ';') }]);
      } catch (err) {                                   /* 修前形态：这里会接到 TypeError */
        thrown = err.constructor.name + ': ' + err.message;
      }
      const okGreen = !!ok && ok.offenders.length === 0
        && ok.counts.total === 1 && ok.counts.sync === 1 && ok.counts.async === 0;
      const redNamed = !!red && red.offenders.length > 0
        && red.offenders.every(o => o.startsWith(NAME_BAD)) && red.offenders.some(o => o.includes('没退 2'));
      t.info(`§16-J 合规样本判红 ${ok ? ok.offenders.length : '（抛异常，未取到）'} 条（应 0）／`
        + `非法样本判红 ${red ? red.offenders.length : '（抛异常，未取到）'} 条（应 ≥1 且指名）；`
        + `异常＝${thrown || '无'}`);
      return okGreen && redNamed && thrown === null;
    })(),
    '`E81` 现场实测（修前）：本组两个样本都抛 `TypeError: Cannot read properties of null (reading \'text\')`'
      + '（复核脚本 `tests\\._verify\\review\\s5t02-e79-sync-catch-probe.js`）；**修后**必须"合规绿／非法红并指名／不抛"，'
      + '且"拿不到 `.catch` 区间"也要判红（判不了不许当通过）');

  t.check('§16-K D22 定点变异④：把 `§16-J` 那条分支改回引用 `asyncRegion.text`（`E81` 的原形态）⇒ 同一批样本必须判失败（抛异常或指名叫红），且原文件字节不变',
    (() => {
      const hsPath = path.join(env.paths.tests, 'harness-check.js');
      const bytes = fs.readFileSync(hsPath);                       /* 字节副本①（只读，不写盘） */
      const sha0 = sha256Hex(bytes);
      const hsSrc = bytes.toString('utf8');
      const FROM = 'const syncCatchRegion = syncExitRegion(code);';       /* 新形态锚点（真代码那处） */
      const TO = 'if (syncCatchRegion.text === null) {';
      if (hsSrc.indexOf(FROM) < 0 || hsSrc.indexOf(TO) < 0) {
        t.info('§16-K 锚点未命中：本文件里找不到新形态那两个锚点');
        return false;
      }
      const mkSyncCatchEntry2 = body => 'function main() { done(); }\n\n'
        + 'main().catch(err => {\n  ' + body + '\n});\n';
      const srcs = [
        { name: '（合成 sync＋.catch 合规样本）', src: mkSyncCatchEntry2(E2TEXT + ';') },
        { name: '（合成 sync＋.catch 退 1 样本）', src: mkSyncCatchEntry2('process.exit(' + '1)' + ';') },
      ];
      /* 定点变异体：**只改那一个谓词** —— 把"新形态"那一行换回 `E81` 的旧形态（引用 async 专用的
         `asyncRegion`，对 sync 恒为 `null` ⇒ `asyncRegion.text` 抛 `TypeError`）。
         做法：从**本文件真 §十六 节体**里取那一小段（`} else if (catchM) {` … `} else {`），
         用"新→旧"的字面量替换造出变异体，再把它**整体**交给 `new Function` 编译调用。
         ⚠ 为什么不用"抽出 §十六 整块 ＋ new Function"的老办法（实测踩过两次、务必别再改回去）：
           抽整块时，节首若用"块注释尾之后的第一个 `{`"会命中本文件 `main()` 的左花括号 ⇒ 抽出整个 `main()`；
           那样抽出来的 body 会带 `t.finish();` 之类**字面量**，节尾锚点又命中字符串里的那一处；
           而把这团东西交给 `new Function` **调用**时，V8 会一路吃内存到 OOM（整轮断言全废）。
         现在只抽"那一小段真代码"＋只做一次字面量替换 ⇒ 变异点看得见、进程也稳。 */
      const NEW_PRED = 'const syncCatchRegion = syncExitRegion(code);';
      const OLD_PRED = 'const syncCatchRegion = asyncRegion;';
      const segStart = hsSrc.indexOf('} else if (catchM) {');
      const segEnd = segStart < 0 ? -1 : hsSrc.indexOf('} else {', segStart);
      const rawSegment = (segStart >= 0 && segEnd > segStart) ? hsSrc.slice(segStart, segEnd) : null;
      /* 段首是 `} else if (catchM) {`（挂在 async 分支链上的 else）⇒ 单独编译要掐掉开头的 `} else `；
         段尾：`} else {` 之前的 `\r\n      ` 是**本支闭合 `}` 的缩进**（真源里那样换行）⇒ 必须补回一个 `}`，
         否则 `if (catchM) {` 永远不闭合（实测：`new Function` 报 `Unexpected token ')'`）。 */
      const realSegment = rawSegment === null ? null : rawSegment.slice('} else '.length) + '}';
      const mutatedSegment = realSegment === null ? null : realSegment.split(NEW_PRED).join(OLD_PRED);
      const mutateOk = !!realSegment && !!mutatedSegment && mutatedSegment !== realSegment
        && mutatedSegment.includes(OLD_PRED) && !mutatedSegment.includes(NEW_PRED);
      let detected = false, mode = '未跑（取不到真代码段）', errText = '无', newFormOk = false;
      if (mutateOk) {
        const sourceOf = segment => 'const auditEntryShape = (sources) => {\n'
          + '  const offenders = [];\n'
          + '  for (const { name, src } of sources) {\n'
          + '    const code = stripLiterals(src);\n'
          + '    const catchM = lastMatch(MAIN_CATCH, code);\n'
          + '    const asyncRegion = null;                          /* 旧形态就是踩在这个 null 上 */\n'
          + '    const decl = { form: \'（合成 sync 入口）\' };\n'
          + segment + '\n'
          + '  }\n'
          + '  return { offenders };\n'
          + '};\n'
          + 'return auditEntryShape;\n';
        const build = seg => new Function('stripLiterals', 'lastMatch', 'MAIN_CATCH', 'hasExit2', 'syncExitRegion', sourceOf(seg));
        try {
          /* 对照（新形态，就是本文件现在这一支）：合规样本判绿、退 1 样本**被指名**判红 ⇒ 变异点确实是分水岭 */
          const newForm = build(realSegment)(stripLiterals, lastMatch, MAIN_CATCH, hasExit2, syncExitRegion);
          const nres = newForm(srcs);
          newFormOk = nres.offenders.length === 1
            && nres.offenders[0].startsWith(srcs[1].name) && nres.offenders[0].includes('没退 2');
          /* 变异体（旧形态）：`asyncRegion` 对 sync 恒为 `null` ⇒ 与 `E81` 现场一样炸在这个属性读上 */
          const oldForm = build(mutatedSegment)(stripLiterals, lastMatch, MAIN_CATCH, hasExit2, syncExitRegion);
          const ores = oldForm(srcs);
          detected = ores.offenders.length > 0;
          mode = detected ? '旧形态**跑完并指名**（判失败）' : '旧形态跑完且未报任何违规 ⇒ 变异**没被检出**';
        } catch (err) {
          detected = true;                                     /* 抛异常同样是"判失败"（`E81` 的真实形态） */
          errText = err.constructor.name + ': ' + err.message;
          mode = '旧形态**抛异常**（`E81` 的真实形态：无汇总行 ＋ 退 2）';
        }
      }
      /* 判据：① 新形态在**同一批样本**上取得到区间（对照，证明变异点确实是判据的分水岭）；
              ② 旧形态判失败（抛异常或指名）；③ 变异体只改了那**一个谓词**（其余字面量一一对应）。 */
      t.info(`§16-K 变异段自证：取到真段＝${!!realSegment}（长度 ${realSegment ? realSegment.length : '-'}）；`
        + `新谓词命中 ${realSegment ? realSegment.split(NEW_PRED).length - 1 : '-'} 处；`
        + `替换后含旧谓词＝${!!mutatedSegment && mutatedSegment.includes(OLD_PRED)}；`
        + `替换后不含新谓词＝${!!mutatedSegment && !mutatedSegment.includes(NEW_PRED)}；mutateOk＝${mutateOk}`);
      const mutatedBytes = Buffer.from(hsSrc.replace(FROM, 'const __e81OldForm = asyncRegion;'), 'utf8');
      const restored = Buffer.from(bytes);                   /* 还原证明（同 §16-F/I 的纪律） */
      const byteSame = Buffer.compare(restored, bytes) === 0;
      const shaSame = sha256Hex(restored) === sha0;
      const diskSame = sha256Hex(fs.readFileSync(hsPath)) === sha0;
      t.info(`§16-K 变异体 sha256=${sha256Hex(mutatedBytes).slice(0, 12)}…（原件 sha256=${sha0.slice(0, 12)}…）；`
        + `新形态对照（同批样本取得到区间）＝${newFormOk}；变异检出＝${detected}（${mode}；异常：${errText}）；`
        + `还原 Buffer.compare=${byteSame}／sha256 一致=${shaSame}／盘上文件未变=${diskSame}`);
      return newFormOk && detected && byteSame && shaSame && diskSame;
    })(),
    '`E81` 的原形态＝第三分支引用 `asyncRegion.text`（对 sync 恒 null）。定点变异把这一处改回去 ⇒ '
      + '本组必须**判失败**：**旧形态是抛异常**（`TypeError`，落到"无汇总行 ＋ 退 2"），'
      + '而不是"指名叫红" —— 两种都算命中，本行如实打印是哪一种（ADR-0004 D22）');

  /* §16-M：**表达式体箭头**自证（`E82⒜`，2026-10-02 收口）。现场：`E79`／`E81` 的区间解析只认**块体**
     （要找块级 `{`）⇒ 合法简写 `main().catch(err => process.exit(2));`（**表达式体、括号成对**）被判
     "括号在文件内没有闭合"而**假红**（主代理实测：投放该形态 ⇒ `§16-A` 278/1 指名；移除后回 279/0）。
     修法＝在块扫描之前先认箭头（`arrowBodyOf`），表达式体取"外层调用右括号"之前的区间。
     D22（§16-K 同款手法，**不写盘**）：从**本文件真代码**里抽出 `arrowBodyOf` ＋ `catchBlockRegion`
     两个函数，只把"认箭头"那一行换成 `const arrow = null;`（＝旧形态：永不认表达式体），
     交给 `new Function` 编译 ⇒ **旧形态必须在同一批样本上把合法简写判红**（假红复现）。
     敏感文本一律字符串拼接构造（同 §16-C/E 的理由：本文件自己也在 §16 的扫描范围内）。 */
  const mkExprBodyEntry = body => 'async function main() { done(); }\n\n'
    + 'main().catch(err => ' + body + ');\n';
  t.check('§16-M 表达式体箭头自证：`main().catch(err => process.exit(2));`（合法简写、括号成对）必须**判绿**；' +
    '同形但退 1 的样本必须**判红并指名**；判红文案不得再说"括号没闭合"；D22＝把"认箭头"那一行换回旧形态 ⇒ 合法样本必被**假判红**',
    (() => {
      const NAME_OK = '（合成表达式体简写合规样本）';
      const NAME_BAD = '（合成表达式体简写退 1 样本）';
      const okSample = mkExprBodyEntry(E2TEXT);
      const badSample = mkExprBodyEntry('process.exit(' + '1)');
      const resOk = auditEntryShape([{ name: NAME_OK, src: okSample }]);
      const resBad = auditEntryShape([{ name: NAME_BAD, src: badSample }]);
      const okGreen = resOk.offenders.length === 0 && resOk.counts.total === 1 && resOk.counts.async === 1;
      const badNamed = resBad.offenders.length === 1 && resBad.offenders[0].startsWith(NAME_BAD)
        && resBad.offenders[0].includes('没退 2');
      /* 文案核对（**行为级**，不在源码里搜那句字面量 —— 本检查自己的注释/代码里就有它，搜字面量必假红）：
         造一个**真的取不到边界**的样本（`.catch(` 的块括号真没闭合）⇒ 判红文案必须说"取不到"，
         且**不得**出现"括号在文件内没有闭合"那句与事实无关的断言（`D23`：名不符实也是缺陷）。 */
      const brokenSample = 'async function main() { done(); }\n\nmain().catch(err => {\n  ' + E2TEXT + ';\n';
      const resBroken = auditEntryShape([{ name: '（合成真没闭合样本）', src: brokenSample }]);
      const brokenText = String((resBroken.offenders[0] || ''));
      const wordingFixed = resBroken.offenders.length === 1 && brokenText.includes('取不到')
        && brokenText.indexOf('括号在文件内没有闭合') < 0;
      /* ---- D22：从**真代码**抽段 ＋ 一处字面替换造旧形态（全程只读本文件字节，不写盘） ---- */
      const hsPath = path.join(env.paths.tests, 'harness-check.js');
      const hsBytes = fs.readFileSync(hsPath);                 /* 字节副本（只读） */
      const sha0 = sha256Hex(hsBytes);
      const hsSrc = hsBytes.toString('utf8');
      const NEW_PRED = 'const arrow = arrowBodyOf(code, i);';
      const OLD_PRED = 'const arrow = null;';
      const segStart = hsSrc.indexOf('  const arrowBodyOf = (code, i) => {');
      const segEnd = hsSrc.indexOf('/** async 入口的异常路径区间');
      const rawSegment = (segStart >= 0 && segEnd > segStart) ? hsSrc.slice(segStart, segEnd) : null;
      const mutatedSegment = rawSegment === null ? null : rawSegment.split(NEW_PRED).join(OLD_PRED);
      const mutateOk = !!rawSegment && !!mutatedSegment && mutatedSegment !== rawSegment
        && mutatedSegment.indexOf(OLD_PRED) >= 0 && mutatedSegment.indexOf(NEW_PRED) < 0;
      let oldFormRedOnLegal = false, oldFormText = '', newFormOk = false, thrown = '无';
      if (mutateOk) {
        try {
          /* 迷你审计器：**与 §16 的 async 分支同口径**（剥字面量 → 取 `.catch(` 区间 → 区间内退 2），
             只把区间解析换成"新形态／旧形态"两份真代码 ⇒ 差值就只可能来自那一处谓词。 */
          const buildAudit = seg => new Function(
            'regionOf', 'detectMainDecl', 'stripLiterals', 'lastMatch', 'MAIN_CATCH', 'hasExit2',
            seg + '\n'
            + 'const __audit = sources => {\n'
            + '  const offenders = [];\n'
            + '  for (const item of sources) {\n'
            + '    if (!detectMainDecl(item.src)) continue;\n'
            + '    const code = stripLiterals(item.src);\n'
            + '    const m = lastMatch(MAIN_CATCH, code);\n'
            + '    if (!m) { offenders.push(item.name + "：没有 main().catch("); continue; }\n'
            + '    const region = catchBlockRegion(code, m);\n'
            + '    if (region.text === null) offenders.push(item.name + "：异常路径区间取不到（判不了就判红）");\n'
            + '    else if (!hasExit2(region.text)) offenders.push(item.name + "：没退 2");\n'
            + '  }\n'
            + '  return { offenders };\n'
            + '};\n'
            + 'return { audit: __audit };\n');
          const bind = seg => buildAudit(seg)(regionOf, detectMainDecl, stripLiterals, lastMatch, MAIN_CATCH, hasExit2).audit;
          /* 对照（新形态＝本文件现在这一份真代码）：合法简写必须判绿 ⇒ 证明这个小审计器本身没坏 */
          newFormOk = bind(rawSegment)([{ name: NAME_OK, src: okSample }]).offenders.length === 0;
          /* 旧形态（`arrow` 恒 null ⇒ 只按块体扫）：合法简写扫不到块级 `{` ⇒ 取不到边界 ⇒ **假判红** */
          const ores = bind(mutatedSegment)([{ name: NAME_OK, src: okSample }]);
          oldFormRedOnLegal = ores.offenders.length > 0;
          oldFormText = String(ores.offenders[0] || '');
        } catch (err) {
          oldFormRedOnLegal = true;                            /* 抛异常同样是"判失败"（如实记哪一种） */
          oldFormText = err.constructor.name + ': ' + err.message;
          thrown = oldFormText;
        }
      }
      const diskSame = sha256Hex(fs.readFileSync(hsPath)) === sha0;
      t.info(`§16-M 读数：合法简写 ⇒ 判红 ${resOk.offenders.length} 条（应 0）、退 1 样本 ⇒ 判红 ${resBad.offenders.length} 条（应 1 且含"没退 2"）；`
        + `判红文案已改为"取不到边界"（真没闭合样本的文案＝${JSON.stringify(brokenText.slice(0, 120))}）＝${wordingFixed}；`
        + `D22 取到真段＝${!!rawSegment}（${rawSegment ? rawSegment.length : '-'} 字符）、只换了那一个谓词＝${mutateOk}；`
        + `同一个小审计器下：**新形态**在合法样本上判绿＝${newFormOk}；**旧形态**在合法样本上判红＝${oldFormRedOnLegal}（异常：${thrown}）；`
        + `旧形态的文案＝${JSON.stringify(oldFormText.slice(0, 160))}；盘上文件未变＝${diskSame}（sha256=${sha0.slice(0, 12)}…）`);
      return okGreen && badNamed && wordingFixed && mutateOk && newFormOk && oldFormRedOnLegal && diskSame;
    })(),
    '修正前实测（`E81` 形态：区间解析只认块体）：同一份合法简写样本 ⇒ `§16-A` **278/1 指名**（文案还写"括号在文件内没有闭合"，与事实相反）；'
      + '修正后合法简写判绿、退 1 样本仍被指名叫红，且旧形态被同一批样本**假判红**（ADR-0004 D22：判据必须被定点变异证伪过才可信）');
}

/* ---------------- 十五、A1 端到端：DR-06（`shift_stat`）的固化/补记 ＋ DR-08（`warning`）的不变量 ----------------
   依据：ADR-0009 D1／D3（触发点①＝**同一个 1 s 采样 tick**内检测跨班 ⇒ 固化上一班；错过的边界**按序补记**；
   重启后从 `measure_rt` **回读上次所见班次**）＋ 技术债 `E38` 的口径（**无法判定 ⇒ 显式 NULL，不用 0 顶替**）。
   本节与前十四节的分工：前面各节是**夹具/组件**级；本节走**真采集链路**（真 HTTP `POST /ifd/frame` ⇒
   `ingest` 落库 ⇒ `onSampled` 钩子 ⇒ `onSampledTick` 的固化＋判定），断言全部落在**库内真源**与
   `/health` 计数上，不复用任何被测实现的中间量。
   三条口径**预先声明**（写断言时不得反向假设，见 ADR-0009 与实现自述）：
     ① 预警幂等粒度＝「**发生**」（同一归属键恒定命中，不逐判定累加）；
     ② `warning` 表**只落非 ok** 条目（`ok` 是回执条，计入 `/health.warningWrite.skippedOk`）；
     ③ 「非 ok 条数 ＝ Δ落库 ＋ Δ幂等命中」**逐帧**成立（不丢不重）。
   注：**写失败隔离**用"换掉 `repo/shiftStat.js` 导出对象上的 `upsertFrozen`"来注入（与 §四之② 对
   `resultRepo.upsertJudgement` 的手法一致），**不改被测实现**；`finally` 当场还原。 */
t.section('十五、A1 端到端：跨班固化/按序补记/重启回读/写失败隔离/warning 不变量（ADR-0009 D1、D3）');
{
  const a1Tmp = harness.makeTempDir('a1-e2e');
  const a1Logs = [];
  const a1Logger = {
    info: m => a1Logs.push('info ' + m),
    warn: m => a1Logs.push('warn ' + m),
    error: m => a1Logs.push('error ' + m)
  };
  /* 注入时钟（**不读系统时间**，ADR-0003 D17）：跨班判定只看帧的 `collectTime`，时钟只影响
     `judged_at`/`frozen_at`/`created_at` 与 `/health` 的 `runAccum`。 */
  let a1ClockMs = Date.parse('2026-10-02T16:00:10');
  const a1Clock = {
    now: () => new Date(a1ClockMs),
    source: () => () => new Date(a1ClockMs)
  };
  const a1SetClock = text => { a1ClockMs = Date.parse(text.replace(' ', 'T')); };
  const A1_NO = 'WO-A1-E2E';
  const A1_PC = 'P-A1-E2E';
  const A1_DEPTH = boardConfig.standards.default.depth.typical;
  const A1_SPEED = boardConfig.standards.default.speed.typical;
  const A1_PLAN_START = '2026-10-02 09:00:00';
  let a1Svc = null;
  let a1Db = null;
  let a1Base = () => '';
  /* ---- `E85⒜`：把 `repo/shiftStat.js` 的 `upsertFrozen` **包一层**（测试侧注入，与 A1-12 换抛错桩
     同款手法，**不改被测实现**），逐帧记三种次数：
       `calls`＝调用次数；`written`＝返回 `written:true`（`changes>0`，**INSERT 或 UPDATE 都算**）；
       `insert`＝`written && !updated`（真的新增了一行）。
     这是座位 5 给出的"更强替代"（C·18.6⒝，已实跑为绿）：`A1-6c` 由"计数单调不减"（几近恒真）
     换成**逐帧恒等式** `Δwrites ≡ written 次数`、`Δrows ≡ INSERT 次数`（`ADR-0004 D19`）。
     ⚠ 声明必须在 `try` **之外**（`finally` 要还原模块导出；`const` 落在 `try` 块里 `finally` 读不到 ——
     首轮实测就是 `ReferenceError: a1OrigUpsert is not defined`）。
     ⚠ A1-12 会把这一项临时换成抛错桩；它的 `finally` 还原成**这个包装**（`a1SavedUpsert` 即包装），
     本节 `finally` 再把模块导出还原成**原件**（失败注入不留痕）。 */
  const a1Cnt = { calls: 0, written: 0, insert: 0, blocked: 0 };
  let a1OrigUpsert = null;
  try {
    a1Svc = await serverEntry.start({
      argv: ['--port', '0', '--data-dir', a1Tmp, '--db-file', path.join(a1Tmp, 'board.db')],
      installSignalHandlers: false, logConsole: false, logger: a1Logger, clock: a1Clock
    });
    a1Db = serverEntry.state.db;
    a1Base = () => 'http://127.0.0.1:' + a1Svc.port;
    const a1HealthView = async () => {
      const h = await (await fetch(a1Base() + '/health')).json();
      return {
        shiftStatWrite: h.shiftStatWrite, warningWrite: h.warningWrite,
        runAccum: h.runAccum, addRunSecBound: h.addRunSecBound
      };
    };
    const a1WarnEvents = [];
    a1Svc.bus.subscribe(e => { if (e.kind === 'warning') a1WarnEvents.push(e.payload); });
    /* 夹具：一票（计划开工落在 10-02 早班窗口内）＋ 一套生效标准（判定要"有标准"才会发布/落库） */
    const a1Dispatch = await fetch(a1Base() + '/ifa/dispatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        procOrderNo: A1_NO, productCode: A1_PC, processNo: '30',
        planQty: 6, equipCode: 'EQ-A1', planStartTime: A1_PLAN_START
      })
    });
    stdRepo.addVersion(a1Db, {
      productCode: A1_PC, processCode: '30',
      depthUpperDev: boardConfig.standards.default.depth.upperDev,
      depthLowerDev: boardConfig.standards.default.depth.lowerDev,
      depthTypical: boardConfig.standards.default.depth.typical,
      speedUpperDev: boardConfig.standards.default.speed.upperDev,
      speedLowerDev: boardConfig.standards.default.speed.lowerDev,
      speedTypical: boardConfig.standards.default.speed.typical
    }, '2026-10-02 00:00:00', '2026-10-02 00:00:00', { bus: a1Svc.bus });
    const a1Rows = () => shiftStatRepo.countRows(a1Db);
    const a1Row = (d, n) => shiftStatRepo.getShiftRow(a1Db, d, n);
    /* ---- 班次真源（**本节的期望值全部由它现算，不手写任何键名**；ADR-0004 D19 的构成性推导）----
       口径（`server\services\shift.js`）：`at(t)` 给出 t 所属班次，`date`＝班次**开始**那天
       （DR-06 的归属规则，故现配置 0-8/8-16/16-24 下晚班的归属日**就是当天**，没有"前一日"之说）；
       区间 `[st, en)` 内**已跑完**的班次＝从 `at(st)` 出发、沿 `endAt` 逐班前进，直到 `at(en)` 为止。
       ⚠ 到达帧所属的那一班**尚未跑完** ⇒ **不固化**（`completedShiftOf()` 的注释口径）。
       （首版此处误把"晚班"的归属日当成前一日 ⇒ 期望里多出 `晚班10-02`（10-02 00:00–08:00，
         在起点 15:59 之前就结束了）—— 那是**误报**，已按真源现算改正。） */
    const a1ShiftRules = createShiftRules(boardConfig.shift.list);
    const a1KeyOf = s => `${s.date}|${s.name}`;
    const a1CompletedShifts = (fromText, toText) => {
      const start = a1ShiftRules.at(fromText);
      const toKey = a1KeyOf(a1ShiftRules.at(toText));
      const list = [Object.assign({}, start, { elapsedSec: start.totalSec, remainingSec: 0 })];
      let cursor = start.endAt;
      let guard = 0;
      while (guard++ < 200) {
        const next = a1ShiftRules.at(cursor);
        if (a1KeyOf(next) === toKey) break;
        list.push(Object.assign({}, next, { elapsedSec: next.totalSec, remainingSec: 0 }));
        cursor = next.endAt;
      }
      return list;
    };
    /* ---- 计数包装**装上**（`E85⒜`）：必须在第一帧推入之前 ---- */
    a1OrigUpsert = shiftStatRepo.upsertFrozen;
    shiftStatRepo.upsertFrozen = function (db, row) {
      a1Cnt.calls++;
      const r = a1OrigUpsert.call(this, db, row);
      if (r && r.written) { a1Cnt.written++; if (!r.updated) a1Cnt.insert++; } else { a1Cnt.blocked++; }
      return r;
    };

    /** 推一帧并给出**逐帧对账读数**：Δrows／Δwarning 落库／Δ幂等／事件里的非 ok 条数
     *  ＋（`E85⒜`）`shift_stat` 写入点的**逐帧计数**读数（见下方 `a1Cnt` 包装）。 */
    const a1Frames = [];
    const a1Push = async (at, seq, over) => {
      const rec = Object.assign({}, {
        equipCode: 'EQ-A1', procOrderNo: A1_NO, collectTime: at, seq,
        depth: A1_DEPTH, speed: A1_SPEED, velocity_x: 3, velocity_y: 4,
        frameRate: 1000, gain: 2.5, shutter: 500, cameraDepth: 12.5,
        testStatus: 1, unitIndex: 1
      }, over || {});
      const before = {
        rows: a1Rows(),
        warnings: warningRepo.countAll(a1Db),
        writes: serverEntry.state.warningWrite.writes,
        duplicates: serverEntry.state.warningWrite.duplicates,
        events: a1WarnEvents.length,
        shiftWrites: serverEntry.state.shiftStatWrite.writes,
        cnt: { calls: a1Cnt.calls, written: a1Cnt.written, insert: a1Cnt.insert }
      };
      const res = await fetch(a1Base() + '/ifd/frame', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec)
      });
      const body = await res.json().catch(() => null);
      await new Promise(r => setTimeout(r, 400));      // 让 onSampled 钩子跑完、事件落进订阅者
      const payload = a1WarnEvents.length > before.events ? a1WarnEvents[a1WarnEvents.length - 1] : null;
      const list = payload && Array.isArray(payload.warnings) ? payload.warnings : [];
      const out = {
        at, seq, status: res.status, outcome: body && body.outcome, stored: body && body.stored,
        dRows: a1Rows() - before.rows,
        dWarnings: warningRepo.countAll(a1Db) - before.warnings,
        dWrites: serverEntry.state.warningWrite.writes - before.writes,
        dDuplicates: serverEntry.state.warningWrite.duplicates - before.duplicates,
        nonOk: list.filter(w => w && w.lv !== 'ok').length,
        okCount: list.filter(w => w && w.lv === 'ok').length,
        /* **库内真源**读数（不是被测实现的返回值）：这一帧之后新增了哪些行 */
        rowsAfter: shiftStatRepo.listRows(a1Db, 50).map(r => `${r.shift_date}|${r.shift_name}`),
        backfills: serverEntry.state.shiftStatWrite.backfills,
        writes: serverEntry.state.shiftStatWrite.writes,
        failures: serverEntry.state.shiftStatWrite.failures,
        /* `E85⒜`：`shiftStatWrite.writes` 的**本帧增量** ＋ 写入点桩上的逐帧计数 */
        dShiftWrites: serverEntry.state.shiftStatWrite.writes - before.shiftWrites,
        dCntCalls: a1Cnt.calls - before.cnt.calls,
        dCntWritten: a1Cnt.written - before.cnt.written,
        dCntInsert: a1Cnt.insert - before.cnt.insert
      };
      a1Frames.push(out);
      return out;
    };

    t.requires('A1 用例前提：服务起得来、路由与库都已就绪（`/health` 可达、`state.db` 非空、`shift_stat` 空表）',
      Boolean(a1Db) && typeof a1Svc.port === 'number' &&
      a1Dispatch.status === 200 && a1Rows() === 0,
      `listen=${a1Svc.listen}、dispatch=${a1Dispatch.status}、shift_stat 行数=${a1Rows()}`);

    /* ---- ① 同一个 1 s tick 内跨班 ⇒ `shift_stat` 恰 +1 行 ---- */
    const a1Early = [];
    for (let i = 0; i < 4; i++) {
      a1Early.push(await a1Push(`2026-10-02 15:59:0${i}`, 7001 + i));
    }
    t.check('A1-1 跨班前：早班 4 帧全部落库（`stored`）、`shift_stat` **仍 0 行**' +
      '（本进程首帧只记"上次所见班次"，**不编造上一班**）',
      a1Early.every(r => r.status === 200 && r.stored === true) && a1Rows() === 0,
      `status/stored=${a1Early.map(r => r.status + '/' + r.stored).join(',')}；行数=${a1Rows()}`);

    const a1Cross = await a1Push('2026-10-02 16:00:01', 7005);
    const a1EarlyRow = a1Row('2026-10-02', '早班');
    t.check('A1-2 **跨班那一帧本身触发固化**：`shift_stat` **恰 +1 行**，行键＝(2026-10-02, 早班)，' +
      '且该行按库内真源取数（窗口内 4 帧 ⇒ `run_sec = 3`；有帧 ⇒ `oee` 可判定＝0；无判定件 ⇒ `pass_rate` **NULL**）',
      a1Cross.dRows === 1 && a1EarlyRow !== null &&
      a1EarlyRow.shift_date === '2026-10-02' && a1EarlyRow.shift_name === '早班' &&
      a1EarlyRow.run_sec === 3 && a1EarlyRow.oee === 0 && a1EarlyRow.pass_rate === null,
      `Δrows=${a1Cross.dRows}；早班行：run_sec=${a1EarlyRow && a1EarlyRow.run_sec}、` +
      `oee=${JSON.stringify(a1EarlyRow && a1EarlyRow.oee)}、pass_rate=${JSON.stringify(a1EarlyRow && a1EarlyRow.pass_rate)}`);

    const a1HealthAfterCross = await a1HealthView();
    t.check('A1-3 `/health.shiftStatWrite` 如实计数：`writes` 与库内行数一致、`backfills` 为 0（这一行是**正常固化**、不是补记）、' +
      '`lastShiftKey` 指向**当前**班次（中班 2026-10-02）、`failures` 为 0',
      a1HealthAfterCross.shiftStatWrite.writes === a1Rows() &&
      a1HealthAfterCross.shiftStatWrite.writes === 1 &&
      a1HealthAfterCross.shiftStatWrite.backfills === 0 &&
      a1HealthAfterCross.shiftStatWrite.failures === 0 &&
      a1HealthAfterCross.shiftStatWrite.lastShiftKey === '2026-10-02|中班',
      JSON.stringify(a1HealthAfterCross.shiftStatWrite));

    /* ---- ② 错过边界 ⇒ 按序补记（**期望值由班次真源现算**，不手写键名）----
       到达帧取 2026-10-03 01:00:01（属"晚班10-03"，**尚未跑完 ⇒ 不固化**）。
       `a1CompletedShifts(起点, 到达)` 现算出的序列 ＝ 界内**已跑完**的班次，首项＝"上次所见那一班"，
       其余＝沿 `endAt` 逐个补上的（本跳恰 1 个）⇒ Δrows ＝ 序列长度、`backfills` 增量 ＝ 长度 − 1。
       ⚠ **首版这里是误报**：我把"晚班"的归属日当成前一日 ⇒ 期望里多写 `2026-10-02|晚班`
         （那其实是 10-02 00:00–08:00，在起点 15:59 **之前**就结束了，序列里根本不该有它）。
         现改为**只用现算序列做期望**，且不写死任何班次名。 */
    a1ClockMs += 9 * 3600 * 1000;
    const a1BackfillsBeforeJump = serverEntry.state.shiftStatWrite.backfills;
    const a1WritesBeforeJump = serverEntry.state.shiftStatWrite.writes;
    const a1Jump = await a1Push('2026-10-03 01:00:01', 7006);
    const a1JumpWantKeys = a1CompletedShifts('2026-10-02 15:59:00', '2026-10-03 01:00:01').map(a1KeyOf);
    const a1ArriveKey = a1KeyOf(a1ShiftRules.at('2026-10-03 01:00:01'));
    /* ⚠ 判据用**库内绝对行集**与**累计计数**，不用"这一帧的 Δrows"：`Δrows` 只反映**本帧**写入的行，
       而"界内已跑完的班次集合"是**累计**语义（首项那一班在更早的 tick 上就已写过）。
       （首版拿 Δrows 去比序列长度 ⇒ 恒差 1，那是我把"累计集合"与"本帧增量"混读了。） */
    const a1JumpConds = {
      '序列长≥2': a1JumpWantKeys.length >= 2,
      '到达班不在序列里': a1JumpWantKeys.indexOf(a1ArriveKey) < 0,
      '库内键序＝现算序列': JSON.stringify(a1Jump.rowsAfter) === JSON.stringify(a1JumpWantKeys),
      '库内行数＝序列长': a1Jump.rowsAfter.length === a1JumpWantKeys.length,
      'Δwrites 与 Δrows 一致（这一帧确实写了新行）': a1Jump.writes - a1WritesBeforeJump === a1Jump.dRows
    };
    const a1JumpBad = Object.keys(a1JumpConds).filter(k => !a1JumpConds[k]);
    t.check('A1-4 **错过边界按序补记**（期望＝班次真源现算，不手写键名）：库内键序＝现算序列**逐项相等**；' +
      '库内行数＝序列长度（＝1 正常固化 ＋ 补记）；到达帧所属的那一班**不在**序列里（尚未跑完）；' +
      '`shiftStatWrite.writes` 的增量＝本帧真实新增行数（计数器不自说自话）',
      a1JumpBad.length === 0,
      `本帧 Δrows=${a1Jump.dRows}、库内行数=${a1Jump.rowsAfter.length}；库内键序=${a1Jump.rowsAfter.join(' → ')}；` +
      `现算期望=${a1JumpWantKeys.join(' → ')}；到达帧所属=${a1ArriveKey}（未跑完 ⇒ 不固化）；` +
      `writes ${a1WritesBeforeJump} → ${a1Jump.writes}；` +
      `未成立的子条件=${a1JumpBad.length ? a1JumpBad.join('、') : '（无）'}`);

    /* A1-5（`E85⒜` **重写**，2026-10-02）：旧判据是"`run_sec = 0` 的行里 `oee`／`pass_rate`
       **要么都非 NULL、要么都 NULL**"—— 它**不是**实现的不变量：`shiftStatRowOf()` 的两个状态位
       **各自独立**（`frameCount > 0` ⇒ 运行时长可判定；`pieceCount > 0` ⇒ 合格率可计算），
       两个方向的合法形态都存在 ⇒ 合法夹具会**假红**（座位 5 实测 `(0,0,NULL)`＝窗口内恰 1 帧、
       `(0,NULL,0)`＝无帧有件）。这也与 `db-check` 的 `A1/DR-06-7`（"两个状态位各自独立"）口径一致。
       新判据（**逐行**对齐库内真源计数，`ADR-0004 D19`）：
         · `oee IS NULL`  ⇔ 该班次窗口内 `measure_rt` **一行都没有**（有帧 ⇒ 非 NULL，即使是真 0%）；
         · `pass_rate IS NULL` ⇔ 该窗口内 `result` **一件都没有**（有件 ⇒ 非 NULL）。
       期望值**独立复算**：窗口由**班次真源**（`a1ShiftRules` 的 `at()` 沿 `endAt` 前进）现算，
       **不手写任何班次起止时刻**；两个计数由本节自写的 SQL 数（与 `statsForShift()` 同一窗口口径，
       但不复用实现的中间量）。另要求"有帧无件""无帧有件""无帧无件"三种**可分辨**形态各至少 1 行
       —— 否则这条判据是空的。 */
    const a1WindowOf = (date, name) => {
      let cur = a1ShiftRules.at(`${date} 00:00:00`);
      for (let guard = 0; guard < 10; guard++) {
        if (cur.date === date && cur.name === name) return { startAt: cur.startAt, endAt: cur.endAt };
        cur = a1ShiftRules.at(cur.endAt);
      }
      return null;
    };
    const a1FactOf = (date, name) => {
      const w = a1WindowOf(date, name);
      if (!w) return null;
      const row = shiftStatRepo.getShiftRow(a1Db, date, name);
      /* `frozenPieces` ＝ **冻结当时**窗口内的判定件数（不查库）：`pass_rate`/`oee` 都是
         "本次固化算没算得出来"的派生位，而算不算得出来只由 `shiftStatRowOf()` 的
         `pieceCount > 0` / `frameCount > 0` 决定 ⇒ "冻结时算得出来" ⇔ 那些位的取值本身。
         这一点必须**与库内现值分开取**：`judged_at` 可被后续帧刷新，库内现值可能是"事后"的。 */
      return {
        window: `${w.startAt} → ${w.endAt}`,
        frames: a1Db.prepare('SELECT COUNT(*) AS c FROM measure_rt WHERE collect_time >= ? AND collect_time < ?')
          .get(w.startAt, w.endAt).c,
        pieces: a1Db.prepare('SELECT COUNT(*) AS c FROM result WHERE judged_at IS NOT NULL AND judged_at >= ? AND judged_at < ?')
          .get(w.startAt, w.endAt).c,
        frozenPieces: row ? (row.pass_rate === null ? 0 : 1) : null
      };
    };
    /* 逐行**合法性判定**（纯函数；负对照直接调它）——**三条判据**（能力：两侧都判 ⇒ 判别力不小于
       原来的"有件 ⇒ 非 NULL"这一侧），逐条注明"能不能判"：
         · ① 无采集帧 ⇒ `oee` 必须 NULL（不得用 0 顶替"算不出来"）；有帧 ⇒ 必须非 NULL（真 0% 也照写 0）。
              `measure_rt` 只增不改（每秒一行、窗口在过去）⇒ 这一条两侧都是**真等价**，可判。
         · ② 冻结时**一件都没有** ⇒ `pass_rate` 必须 NULL（没有分母就不许给比率）。
              ⚠ 前提是"冻结时"的件数（由 `pass_rate` 这个派生位反读：`frozenPieces === 0` ⇔
              `pass_rate IS NULL` —— 那是 `shiftStatRowOf()` 在同一行里写下的 `rateDeterminable`），
              **不是库里现数的件数**。
         · ③ 反方向：**冻结时有判定件** ⇒ 必须给比率（有分母却不给值同样不许）。它与 ② 合起来
              正是"`frozenPieces === 0` ⇔ `pass_rate IS NULL`"这个**双向**等价 —— 真实现里
              `2026-10-02|中班` 就是 `frozenPieces = 1`、`pass_rate = 0` 的现场。
       ⚠ **⒜（`E88`，2026-10-02 修）为什么不能写成反向蕴含（"库里数到的件数 > 0 ⇒ `pass_rate` 非 NULL"）
       或等价（"`pass_rate IS NULL` ⇔ 现在数到的件数 ＝ 0"）**：`result.judged_at` 是**可变列**
       （`repo/result.js:129` 的 upsert 会把它刷成本次判定时刻）⇒ 同一件被后续帧重判后会被刷到窗外，
       "现在数到的件数"可以 **小于** "冻结时数到的件数"。**本节的夹具就真实产出该形态**（实测）：
         `2026-10-02|中班` 在 `2026-10-03 01:00:10` 那一 tick 固化（当刻 `pieceCount = 1` ⇒ `pass_rate = 0`），
         而同一 tick 里 `persistJudgement()` 随后把那一件的 `judged_at` 从 `2026-10-02 16:00:10`（窗内）
         刷成 `2026-10-03 01:00:10`（窗外，`result.created_at=2026-10-02 16:00:10`
         证明它冻结时**确实在窗内**）⇒ 事后 `pieces = 0`。
       旧写法（"有判定件 ⇒ `pass_rate` 非 NULL"用的是**现在**的件数）会把这行**假判红**；
       改成冻结时件数做前提后，该行**可判且为绿**（零判别力损失：它照样要求"冻结时有件就必须给比率"）。
       ⚠ **残余（如实登记，不假装已覆盖）**：① 侧的 `frameCount` 用的是库内现值，本节全序复核时
       `oee` 也始终非 NULL（`run_sec = 0` 的行 `oee` 都是 0）⇒ 该侧在本夹具内**未见**同类反例；
       但 `measure_rt` 的"只增不改"只保证帧**总行数**不倒退，**不**证明"冻结时窗口内帧数"与
       "现在窗口内帧数"恒等（同一 tick 内先冻结后落库这件事对帧侧同样存在，只是本夹具的帧窗口
       恰好都在过去）。这一条**只作登记**，不写成断言。 */
    const a1ShapeVerdict = (row, fact) => {
      if (!fact) return '取不到班次窗口（判不了就判红）';
      if (fact.frames === 0 && row.oee !== null) return '无采集帧却给了 oee（用 0 顶替"算不出来"）';
      if (fact.frames > 0 && row.oee === null) return '有采集帧却把 oee 留 NULL（可判定却不给值）';
      if (fact.frozenPieces !== null && fact.frozenPieces > 0 && row.pass_rate === null) {
        return '冻结时有判定件却把 pass_rate 留 NULL（有分母却不给比率）';
      }
      if (fact.frozenPieces === 0 && row.pass_rate !== null) return '冻结时一件都没有却给了 pass_rate（没有分母就不许给比率）';
      return null;
    };
    /* 台账（**逐行**，两条判据各一行读数；不是判据本身）：`bad` ＝ 判据①／② 的落点；
       `subsetBad` ＝ 判据③ 的落点（"现在数到的件数 ≤ 冻结时数到的件数"—— 
       `judged_at` 只被往后刷 ⇒ 件只会**离开**窗口，不会凭空进入）；`staleRows` ＝ 两者**不等**的行，
       即"该窗口的件数在我们读数之前被动过"的现场台账（合法，不是红）。 */
    const a1ShapeAudit = () => {
      const rows = shiftStatRepo.listRows(a1Db, 50).map(r => {
        const fact = a1FactOf(r.shift_date, r.shift_name);
        const subsetBad = Boolean(fact) && fact.frozenPieces !== null && fact.pieces > fact.frozenPieces
          ? `现在数到 ${fact.pieces} 件 > 冻结时 ${fact.frozenPieces} 件（件只能离开窗口 ⇒ 库内真源与冻结读数不一致）` : null;
        return { key: `${r.shift_date}|${r.shift_name}`, row: r, fact, bad: a1ShapeVerdict(r, fact), subsetBad };
      });
      const kinds = {
        '有帧无件': rows.filter(x => x.fact && x.fact.frames > 0 && x.row.oee !== null && x.fact.frozenPieces === 0).length,
        '有帧有件': rows.filter(x => x.fact && x.fact.frames > 0 && x.row.oee !== null && x.fact.frozenPieces > 0).length,
        '无帧无件（占位行）': rows.filter(x => x.fact && x.fact.frames === 0 && x.fact.frozenPieces === 0
          && x.row.oee === null && x.row.pass_rate === null).length,
        '无帧有件（本节夹具不产出）': rows.filter(x => x.fact && x.fact.frames === 0 && x.fact.frozenPieces > 0
          && x.row.oee === null && x.row.pass_rate !== null).length
      };
      return {
        rows, kinds, bad: rows.filter(x => x.bad), subsetBad: rows.filter(x => x.subsetBad),
        staleRows: rows.filter(x => x.fact && x.fact.frozenPieces !== null && x.fact.pieces !== x.fact.frozenPieces)
      };
    };
    const a1ShapeAt5 = a1ShapeAudit();
    /* **合法反例负对照**（`E85⒜` 的现场，也是这条判据的 D22）：判红的**前提**是"件数/帧数读数可信"，
       故负对照给两种**件数读数不可信或读数为 0**的合法形态；夹具产不出的那一种用显式构造（构造变量逐项写明）：
         · `(run_sec=0, oee=0, pass_rate=NULL)`（窗口内恰 1 帧、无件）：**真实**形态（`2026-10-02|早班`）；
         · `(run_sec=0, oee=NULL, pass_rate=0)`（冻结时窗口内有件 ⇒ `pass_rate=0`；零帧 ⇒ `oee` 只能 NULL）：
           **构造**（本节夹具产不出）—— `fact.frozenPieces=1` 与 `pass_rate=0` 都是 `row` 自己的位，
           互相对齐；`frames=0` 与 `oee=NULL` 同理；**唯一**来自库的 `fact.pieces=0` 是"事后重判把它刷出去了"，
           正是 ⒜ 的现场形状。
       旧判据（"两列同 NULL 或同非 NULL"）会把**这两个**都判红 ⇒ 一并复现作反证。 */
    const a1LegalShapes = [
      {
        name: '(0,0,NULL)＝窗口内恰 1 帧、无件（真实）', real: true,
        row: { run_sec: 0, oee: 0, pass_rate: null }, fact: { frames: 1, pieces: 0, frozenPieces: 0 }
      },
      {
        name: '(0,NULL,0)＝冻结时有件 1、事后被重判归零', real: false,
        row: { run_sec: 0, oee: null, pass_rate: 0 }, fact: { frames: 0, pieces: 0, frozenPieces: 1 }
      }
    ];
    const a1LegalVerdicts = a1LegalShapes.map(s => ({
      name: s.name, newBad: a1ShapeVerdict(s.row, s.fact),
      oldBad: (s.row.oee === null) !== (s.row.pass_rate === null)     /* 旧判据：只比"两列同号" */
    }));
    const a1OldFalseReds = a1LegalVerdicts.filter(v => v.oldBad).map(v => v.name);
    /* ⒜ 的**判别力读数**（修方向**不得**削弱判别力）：两条子判据各自的"反例"都必须被抓 ——
       ① 的反例＝**无帧却给了 `oee`**（占位行拿 0 顶替"算不出来"）：`frames=0` ⇒ 必须 NULL；
       ② 的反例＝**冻结时有件却把 `pass_rate` 留 NULL**（有分母却不给比率）。
       ⚠ 这两条与旧判据（"两列同 NULL 或同非 NULL"）**不能比判别力**：旧判据在**合法**形态上就会假红
       （见上面的负对照，两个都红），所以"旧判据在这儿也红"**不构成**"新判据没退化"的证据。
       本节的证据是另一条：新判据在**全部合法形态**上绿的同时，把这两条反例**照样**判红
       ⇒ 判别力不小于旧判据（旧判据多出来的那些"红"全是假红）。 */
    const a1E88NegCases = [
      {
        name: '① 的反例：无帧却给了 oee（拿 0 顶替"算不出来"，无帧无件）',
        row: { run_sec: 0, oee: 0, pass_rate: null }, fact: { frames: 0, pieces: 0, frozenPieces: 0 }
      },
      {
        name: '② 的反例：冻结时有件 1 却把 pass_rate 留 NULL（有分母却不给比率）',
        row: { run_sec: 0, oee: 0, pass_rate: null }, fact: { frames: 1, pieces: 0, frozenPieces: 1 }
      }
    ].map(c => Object.assign({}, c, {
      newBad: a1ShapeVerdict(c.row, c.fact),
      oldBad: (c.row.oee === null) !== (c.row.pass_rate === null)   /* 旧判据：只比"两列同号" */
    }));
    t.check('A1-5 **"不用 0 顶替"的两个状态位（各自独立）逐行对齐库内真源**（`E85⒜` 重写、'
      + '`E88⒜` 修 `pass_rate` 侧的方向，2026-10-02）：无采集帧 ⇒ `oee` 必须 NULL、有帧 ⇒ 非 NULL；' +
      '**冻结时一件都没有** ⇒ `pass_rate` 必须 NULL、**冻结时有判定件** ⇒ 必须给比率' +
      '（前提都取**冻结时**的件数，**不取**库里现数的件数 —— `judged_at` 可变，事后重判会把件刷出窗口）；' +
      '且"有帧无件""有帧有件"两种形态在本节的库里都真实存在 —— ' +
      '**窗口与冻结时件数都由库内真源现算／反读**、`frames`/`pieces` 由本节自写 SQL 数（`ADR-0004 D19`）；' +
      '负对照：两个**合法**形态（`(0,0,NULL)` 真实 与 `(0,NULL,0)` 冻结有件·事后归零）都不许被判红，' +
      '而**旧判据**会把**两个都**假判红；判别力：两条子判据各自的**反例都仍被判红**' +
      '（无帧却给 oee／冻结时有件却不给比率）⇒ 判别力不小于旧判据（旧判据多出的红全是假红）',
      a1ShapeAt5.rows.length >= 1 && a1ShapeAt5.bad.length === 0 &&
      a1ShapeAt5.subsetBad.length === 0 &&
      a1ShapeAt5.kinds['有帧无件'] >= 1 && a1ShapeAt5.kinds['有帧有件'] >= 1 &&
      a1LegalVerdicts.every(v => v.newBad === null) &&
      a1LegalShapes.filter(s => s.real).length >= 1 && a1OldFalseReds.length === a1LegalShapes.length &&
      a1E88NegCases.every(c => c.newBad !== null && c.oldBad === true) &&
      a1EarlyRow.oee === 0 && a1EarlyRow.pass_rate === null,
      `逐行：${a1ShapeAt5.rows.map(x => `${x.key}(frames=${x.fact ? x.fact.frames : '?'},` +
        `冻结时件数=${x.fact ? x.fact.frozenPieces : '?'},现在数到=${x.fact ? x.fact.pieces : '?'}` +
        ` ⇒ run_sec=${x.row.run_sec},oee=${JSON.stringify(x.row.oee)},pass_rate=${JSON.stringify(x.row.pass_rate)})`).join(' , ')}；` +
      `与独立性判据不符 ${a1ShapeAt5.bad.length} 行（须为 0）${a1ShapeAt5.bad.length ? '：' + a1ShapeAt5.bad.map(x => `${x.key}(${x.bad})`).join('、') : ''}；` +
      `"现在数到 ≤ 冻结时"不符 ${a1ShapeAt5.subsetBad.length} 行（须为 0）` +
      `${a1ShapeAt5.subsetBad.length ? '：' + a1ShapeAt5.subsetBad.map(x => `${x.key}(${x.subsetBad})`).join('、') : ''}；` +
      `形态行数＝${JSON.stringify(a1ShapeAt5.kinds)}；` +
      `负对照（新判据 vs 旧判据）：${a1LegalVerdicts.map(v => `${v.name} ⇒ 新=${v.newBad === null ? '绿' : '红'}／旧=${v.oldBad ? '红（假红）' : '绿'}`).join('；')}；` +
      `判别力（反例必须判红）：${a1E88NegCases.map(c => `${c.name} ⇒ 新=${c.newBad === null ? '**绿（判别力丢失）**' : '红'}／旧=${c.oldBad ? '红' : '绿（旧判据抓不到）'}`).join('；')}`);

    /* A1-5b（**`E88⒜` 的现场取证**，2026-10-02）：本节夹具**确实产出**该形态 ——
       `2026-10-02|中班` 的 `pass_rate` 非 NULL（＝冻结时窗口内至少有一件）而**现在**按 `judged_at`
       数到 0 件。这一条把"事后重判会把件刷出窗口"从注释里的说法变成**逐字可复跑的读数**，
       并同时锁住 `frozen_at` 与 `created_at` 这两个时间锚（`frozen_at` ∈ 下一班窗口、
       `result.created_at` ∈ 本窗口 ⇒ 件是"本窗口内判出、之后被重判"的）。
       期望值**不写死**：全部由库内真源现算（窗口、`created_at`、`frozen_at`）。
       ⚠ 判别力：若 A1-5 退回旧写法（用现在的件数做前提），这一行会**立即**假判红（A1-5 与 A1-19 都会红）
       —— 这就是 ⒜ 所指的"窄假红窗口"，本条即它的回归护栏。 */
    const a1StaleRow = a1ShapeAt5.staleRows[0] || null;
    const a1StaleWin = a1StaleRow ? a1WindowOf(a1StaleRow.row.shift_date, a1StaleRow.row.shift_name) : null;
    const a1StalePiece = a1StaleRow
      ? a1Db.prepare('SELECT proc_order_no AS no, unit_index AS unit, judged_at, created_at FROM result ' +
          'WHERE created_at >= ? AND created_at < ? ORDER BY unit_index LIMIT 1').get(a1StaleWin.startAt, a1StaleWin.endAt)
      : null;
    t.check('A1-5b **`E88⒜` 的现场**（2026-10-02 实测，**非构造**）：本节夹具产出的合法形态 —— ' +
      '某历史固化行的**冻结时件数 > 0**（由 `pass_rate` 非 NULL 反读）而**现在**按可变列 `judged_at` 数到的件数为 0；' +
      '且该件是被**事后重判**刷出去的（`result.created_at` 落在**该班窗口内**、`judged_at` 落在窗口外）—— ' +
      '凡"用现在的件数做前提"的判据在这一行上必然假判红，本节的 A1-5／A1-19 在修好后必须仍为绿',
      a1ShapeAt5.staleRows.length >= 1 && Boolean(a1StaleRow) &&
      a1StaleRow.fact.frozenPieces > 0 && a1StaleRow.fact.pieces === 0 &&
      a1StaleRow.row.pass_rate !== null && Boolean(a1StalePiece) &&
      a1StalePiece.created_at >= a1StaleWin.startAt && a1StalePiece.created_at < a1StaleWin.endAt &&
      !(a1StalePiece.judged_at >= a1StaleWin.startAt && a1StalePiece.judged_at < a1StaleWin.endAt) &&
      a1ShapeVerdict(a1StaleRow.row, a1StaleRow.fact) === null,
      `被动的行 ${a1ShapeAt5.staleRows.length} 行（≥1）：` +
      a1ShapeAt5.staleRows.map(x => `${x.key}（窗口 ${x.fact.window}、冻结时件数=${x.fact.frozenPieces}、` +
        `现在数到=${x.fact.pieces}、pass_rate=${JSON.stringify(x.row.pass_rate)}、frozen_at=${x.row.frozen_at}）`).join('；') +
      `${a1StalePiece ? `；该窗内判出的件：${a1StalePiece.no}#${a1StalePiece.unit} created_at=${a1StalePiece.created_at}（窗内）` +
        `／judged_at=${a1StalePiece.judged_at}（窗外 ⇒ 被重判刷出）` : ''}；` +
      `"件数未被动过"的行 ${a1ShapeAt5.rows.length - a1ShapeAt5.staleRows.length} 行`);


    /* ---- ②b 一跳跨过**多个**已跑完班次 ⇒ 枚举必须真的"一步一班"地走完 ----
       ⚠ **关键设计（首版这里是不可证伪的，D22 实测被抓出来）**：枚举循环的比较基准是 `list` 的**末尾**
       （`list.push` 之前 `list.length` 恒 ≥ 1），而 `break` 判据是"游标所在班次 ＝ 到达班" ⇒
       只要序列里累积的班次名与"到达班"不同，循环就会继续。首版每跳只跨 1 个班次，
       且"到达班"与"上次所见那一班"**同名**（早班→…→早班）⇒ 循环体实际只跑一轮，
       把"循环只跑一轮"的变异（在 `list.push` 前插 `if (list.length > 1) break;`）整段放过去
       （实测 298/0 全绿、变异逃逸）。现在改为：**一跳直接跨到 10-05 12:00:01**
       （到达班＝"早班10-05"，与上次所见的"晚班10-03"不同名）⇒ 现算序列 ≥ 9 个已跑完班次、
       循环必须迭代 6 次以上，上面那种变异必然让库内行数短于现算序列。
       ⚠ **`E85⒠①` 文案更正（2026-10-02，按实测）**：`10-05 12:00:01` 按班次真源属 **早班10-05**
       （`08:00–16:00`），**不是**"中班10-05"；这一跳之前的"上次所见班次"是 **晚班10-03**
       （A1-4 那一跳的到达班），**不是**"早班10-02"（早班10-02 只是**枚举序列的首项**、
       它在更早的 tick 上就已落库）。故本 tick 新写入的是"晚班10-03 → 晚班10-05"之间的 7 个班次，
       而"中班10-02"是**早已在库、本 tick 不新增**的那一行。（座位 5 的 C·18.7⒠① 实测
       `lastShiftKey=2026-10-05|早班`。）
       ⚠ **不在这条用例里手工删 `shift_stat`**（试过：`DELETE` 只清掉了持久化行、清不掉进程内的
        `lastShift` ⇒ 枚举起点仍是"那一班的 endAt"，读数会被污染；那是**流程外的库改写**，
       不是被测行为，故弃用）。
       ⚠ `/health.runAccum` 是**快照跑过之后**才有的（`snapshot.lastRunAccum`，初值 null）⇒
       要先请求一次 `/state`（真链路），不能指望 `/health` 自己会去算。 */
    const a1BackfillsBeforeBig = serverEntry.state.shiftStatWrite.backfills;
    const a1RowsBeforeBig = a1Rows();
    a1ClockMs = Date.parse('2026-10-05T12:00:10');
    const a1BigJump = await a1Push('2026-10-05 12:00:01', 7007);
    const a1BigWantKeys = a1CompletedShifts('2026-10-02 15:59:00', '2026-10-05 12:00:01').map(a1KeyOf);
    await fetch(a1Base() + '/state');                       // 触发一次真快照 ⇒ `runAccum` 有值
    const a1HealthAfterJump = await a1HealthView();
    const a1BigConds = {
      '序列长≥9': a1BigWantKeys.length >= 9,
      '库内键序＝现算序列': JSON.stringify(a1BigJump.rowsAfter) === JSON.stringify(a1BigWantKeys),
      '库内行数＝序列长': a1BigJump.rowsAfter.length === a1BigWantKeys.length,
      'Δrows＝库内行数增量': a1BigJump.dRows === a1BigJump.rowsAfter.length - a1RowsBeforeBig
    };
    const a1BigBad = Object.keys(a1BigConds).filter(k => !a1BigConds[k]);
    t.check('A1-6 一跳跨过**多个**已跑完班次（到达 10-05 12:00:01 属**早班10-05**，尚未跑完）⇒ ' +
      '现算序列 **≥ 9** 个已跑完班次；库内键序与其**逐项相等**、库内行数＝序列长度' +
      '（"中班10-02"是**早已在库、本 tick 不新增**的那一行，仍须在场）；本帧 Δrows ＝ 库内行数增量 —— ' +
      '这一跳必须**一步一班**地枚举完 9 个班次，任何"只枚举一轮"的改法都会让库内行数短于现算序列',
      a1BigBad.length === 0,
      `本帧 Δrows=${a1BigJump.dRows}、库内行数=${a1BigJump.rowsAfter.length}；` +
      `库内键序=${a1BigJump.rowsAfter.join(' → ')}；现算期望=${a1BigWantKeys.join(' → ')}；` +
      `原始计数（**未作为判据，见下**）：backfills ${a1BackfillsBeforeBig} → ${a1HealthAfterJump.shiftStatWrite.backfills}、` +
      `writes ${a1WritesBeforeJump} → ${a1HealthAfterJump.shiftStatWrite.writes}；` +
      `未成立的子条件=${a1BigBad.length ? a1BigBad.join('、') : '（无）'}`);

    /* ⚠ **计数语义（`E85⒜` 收口；取代旧的"未定论"登记）**：`/health.shiftStatWrite.writes` 数的是
       "写入语句影响了行"的次数 —— **INSERT 与 UPDATE 都算**（`repo/shiftStat.js` 的 `written` 口径）；
       而"库内行数"只随 **INSERT** 增长。故**累计读数的差**不能与 `Δrows` 直接比：
       本节的 `writes ${a1WritesBeforeJump}` 是在 **A1-4 那一跳之前**取的（跨了两个 tick）⇒
       与 `A1-6` 这一跳的 `Δrows` 不同量纲。**精确口径由 A1-6c 的逐帧恒等式给出**
       （`Δwrites ≡ written 次数`、`Δrows ≡ INSERT 次数`），本节不再拿累计读数当判据。 */
    const a1WritesBad = a1Frames.filter(f => f.dShiftWrites !== f.dCntWritten || f.dRows !== f.dCntInsert);
    t.check('A1-6c **写入点的逐帧计数恒等式**（`E85⒜` 的更强替代，替换旧"两个累计计数单调不减"的弱形态）：' +
      '包一层 `repo/shiftStat.upsertFrozen` 直接数"本次调用 written／insert 了几行" ⇒ **逐帧** ' +
      '`Δwrites（/health.shiftStatWrite.writes 的本帧增量）≡ 本帧 written 次数` 且 ' +
      '`Δrows（库内行数增量）≡ 本帧 INSERT 次数`（`written && !updated`）—— 计数器与库内事实逐帧对账，' +
      '不再靠"单调不减"这种几近恒真的形态；且至少各有一帧真的 written／insert 过（否则这条恒等式是空的）',
      a1WritesBad.length === 0 &&
      a1Frames.some(f => f.dCntWritten > 0) && a1Frames.some(f => f.dCntInsert > 0),
      `逐帧：${a1Frames.map(f => `${f.at.slice(5)} Δwrites=${f.dShiftWrites}/cntWritten=${f.dCntWritten}` +
        ` Δrows=${f.dRows}/cntInsert=${f.dCntInsert}`).join('；')}；` +
      `不符的帧 ${a1WritesBad.length} 帧（须为 0）${a1WritesBad.length ? '：' + a1WritesBad.map(f => f.at).join('、') : ''}；` +
      `桩上累计 calls=${a1Cnt.calls}／written=${a1Cnt.written}／insert=${a1Cnt.insert}／blocked=${a1Cnt.blocked}`);

    t.check('A1-6b `/health` 的 DR-17 取数来源明写（`sumRunSec` ＋ `getShiftRow`，ADR-0009 D4），' +
      '且 `runAccum.frozenShifts`（对账用的全表行数）与库内行数一致',
      a1HealthAfterJump.runAccum !== null &&
      a1HealthAfterJump.runAccum.source.sum === 'shift_stat.sumRunSec' &&
      a1HealthAfterJump.runAccum.source.current === 'shift_stat.getShiftRow' &&
      a1HealthAfterJump.runAccum.frozenShifts === a1Rows(),
      `runAccum=${JSON.stringify(a1HealthAfterJump.runAccum)}`);

    /* ---- ③ 重启后从 `measure_rt` 回读 ⇒ 首帧即补记（ADR-0009 否掉 C3 的那个后果）----
       口径（实现自述）：`shift_stat` 在**跨班时才写** ⇒ 若不跨班，它就**不写**；
       故本节**不**依赖驱动帧是否跨班来建立"上次所见班次"，而是把重启的前一现场做成
       "驱动帧只负责把班次推进到 X、且它在库内留下采样行"，重启后**首帧从 `measure_rt` 回读** X。 */
    a1ClockMs = Date.parse('2026-10-05T21:00:10');
    const a1Setup = await a1Push('2026-10-05 21:00:01', 7008);
    const a1SetupWantKeys = a1CompletedShifts('2026-10-02 15:59:00', '2026-10-05 21:00:01').map(a1KeyOf);
    const a1SetupArriveKey = a1KeyOf(a1ShiftRules.at('2026-10-05 21:00:01'));
    t.check('A1-7 重启前的驱动帧（到达 10-05 21:00:01，属"中班10-05"⇒ **尚未跑完**）：库内键序＝现算序列**逐项相等**、' +
      '`Δrows ＝ 本帧新跑完的班次数`，且这一帧在库内留下采样行 ⇒ 重启后能从 `measure_rt` 回读到"中班10-05"',
      JSON.stringify(a1Setup.rowsAfter) === JSON.stringify(a1SetupWantKeys) &&
      a1Setup.dRows === a1SetupWantKeys.length - a1BigWantKeys.length &&
      a1SetupWantKeys.indexOf(a1SetupArriveKey) < 0 &&
      a1Db.prepare('SELECT COUNT(*) AS c FROM measure_rt WHERE collect_time = ?').get('2026-10-05 21:00:01').c === 1,
      `Δrows=${a1Setup.dRows}；库内键序=${a1Setup.rowsAfter.join(' → ')}；现算期望=${a1SetupWantKeys.join(' → ')}；` +
      `到达帧所属=${a1SetupArriveKey}（未跑完 ⇒ 不固化，但仍以采样行留在库内）`);

    const a1RowsBeforeRestart = a1Rows();
    await serverEntry.stop('a1-e2e-restart');                  // 真停：进程内"上次所见班次"随之丢失
    a1Svc = await serverEntry.start({
      argv: ['--port', '0', '--data-dir', a1Tmp, '--db-file', path.join(a1Tmp, 'board.db')],
      installSignalHandlers: false, logConsole: false, logger: a1Logger, clock: a1Clock
    });
    a1Db = serverEntry.state.db;                               // 重启后是**新**句柄
    a1Svc.bus.subscribe(e => { if (e.kind === 'warning') a1WarnEvents.push(e.payload); });
    t.check('A1-8 重启后进程内记忆**确实为空**（`lastShiftKey === null`）、库内行数不变 —— ' +
      '这正是"不靠回读就会永久漏固化"的前提',
      serverEntry.state.shiftStatWrite.lastShiftKey === null &&
      serverEntry.state.shiftStatWrite.writes === 0 && a1Rows() === a1RowsBeforeRestart,
      `lastShiftKey=${serverEntry.state.shiftStatWrite.lastShiftKey}、` +
      `重启后 writes=${serverEntry.state.shiftStatWrite.writes}、库内行数 ${a1RowsBeforeRestart} → ${a1Rows()}`);

    /* 重启后首帧：同一班次（中班10-05）内、不跨班 ⇒ `shift_stat` 一行都不写（口径：跨班才写）；
       但它必须**从 `measure_rt` 回读**出"上次所见班次＝中班10-05" */
    a1ClockMs = Date.parse('2026-10-05T21:30:10');
    const a1AfterRestartSame = await a1Push('2026-10-05 21:30:01', 7009);
    t.check('A1-9 重启后**同一班次内**的帧：`shift_stat` **零写入**（Δrows=0；口径＝跨班才写）、' +
      '`shiftStatWrite.writes` 仍为 0，且进程内记忆与库内真源一致（`lastShiftKey === \'2026-10-05|中班\'`）' +
      '—— ⚠ **本条不足以证明"回读到的是库里的那一班"**：到达帧所属班次恰好也是"中班10-05"，' +
      '所以"回读成功"与"只记当前班次"会得到同一个键（本包实测：把 `previousFrameShiftOf(frame)` 改成 `null`，' +
      '本条**仍然通过**）。真正可分辨的是下一条（跨班时，被漏掉的那一班必须补回来）。',
      a1AfterRestartSame.dRows === 0 &&
      serverEntry.state.shiftStatWrite.writes === 0 &&
      serverEntry.state.shiftStatWrite.lastShiftKey === '2026-10-05|中班',
      `Δrows=${a1AfterRestartSame.dRows}、writes=${serverEntry.state.shiftStatWrite.writes}、` +
      `lastShiftKey=${serverEntry.state.shiftStatWrite.lastShiftKey}`);

    /* 重启后跨班：到达 10-06 09:00:01（属"早班10-06"）。
       ⚠ **`E85⒠②` 更正（2026-10-02，按实测；旧注释与事实相反）**：旧注释称"把
       `previousFrameShiftOf(frame)` 改成 `null` ⇒ 本条与 A1-7 一起变红（实测）" —— 座位 5 的
       C·18.4／C·18.8（H4 组）与本节复跑都读到 **299/0、一条不红**：因为上一条 A1-9 在重启后
       **先推了一帧同班次帧**（10-05 21:30:01），它把进程内 `lastShift` 重新设成与"回读值"**同名**的
       `中班10-05` ⇒ `prev=null` 与"真回读"两条路径在这一跳得到**同一把键**、`Δrows` 也相同（2）。
       ⇒ 本条**不足以**判红 H4；真正可分辨的是本节末尾新增的 `A1-18`（**重启后首帧即跨班**、
       中间不推同班次帧；那座窗口下 `Δrows` 由 2 变 0）。本条保留，但只主张它自己写明的那些事实。 */
    a1ClockMs = Date.parse('2026-10-06T09:00:10');
    const a1RestartJump = await a1Push('2026-10-06 09:00:01', 7010);
    const a1RestartWantKeys = a1CompletedShifts('2026-10-05 21:00:01', '2026-10-06 09:00:01').map(a1KeyOf);
    const a1Mid1005 = a1Row('2026-10-05', '中班');
    const a1Mid1005Frames = a1Db.prepare(
      'SELECT COUNT(*) AS c FROM measure_rt WHERE collect_time >= ? AND collect_time < ?')
      .get('2026-10-05 16:00:00', '2026-10-06 00:00:00').c;
    t.check('A1-10 **重启后首帧即按序补记**：现算序列里的**每一行**都出现在库内，其中"中班10-05"' +
      '（重启前所见的那一班）**只有回读 `measure_rt` 才补得上**（到达班"早班10-06"与它不同名 ⇒ 不可蒙对）；' +
      `它的两个状态位都由库内真源决定（该窗口内 ${a1Mid1005Frames} 帧 ⇒ 两列都非 NULL，不是占位行）`,
      a1RestartWantKeys.length === 2 &&
      a1RestartWantKeys[0] === '2026-10-05|中班' &&
      a1RestartJump.dRows === 2 &&
      JSON.stringify(a1RestartJump.rowsAfter) ===
        JSON.stringify(a1CompletedShifts('2026-10-02 15:59:00', '2026-10-06 09:00:01').map(a1KeyOf)) &&
      a1Mid1005 !== null && a1Mid1005.shift_date === '2026-10-05' && a1Mid1005.shift_name === '中班' &&
      a1Mid1005Frames >= 1 && a1Mid1005.oee !== null && a1Mid1005.pass_rate !== null,
      `Δrows=${a1RestartJump.dRows}；现算序列=${a1RestartWantKeys.join(' → ')}；` +
      `库内全序=${a1RestartJump.rowsAfter.join(' → ')}；` +
      `中班10-05：${a1Mid1005 ? `run_sec=${a1Mid1005.run_sec}、oee=${JSON.stringify(a1Mid1005.oee)}、pass_rate=${JSON.stringify(a1Mid1005.pass_rate)}、窗口内帧=${a1Mid1005Frames}` : '**无该行**'}`);

    /* 重启后 `/health` 的预警计数**从 0 起算**（进程内状态）⇒ 下面建立"重启后基线"，
       供 §⑤ 的 Δ 口径使用（**不得**拿跨重启的累计值比库内行数 —— 那是首版的构造缺陷） */
    const a1WarnBase = {
      writes: serverEntry.state.warningWrite.writes,
      duplicates: serverEntry.state.warningWrite.duplicates,
      skippedOk: serverEntry.state.warningWrite.skippedOk,
      rows: warningRepo.countAll(a1Db),
      frames: a1Frames.length
    };
    t.check('A1-11 重启后预警计数**从 0 起算**（`/health.warningWrite` 是进程内状态）⇒ 本节据此建立 Δ 基线，' +
      '后续不变量只比**增量**（首版拿跨重启的累计值比库内行数是构造缺陷，已改）',
      a1WarnBase.writes >= 0 && a1WarnBase.duplicates >= 0 && a1WarnBase.rows > 0 &&
      a1WarnBase.writes + a1WarnBase.duplicates <= a1WarnBase.rows + a1WarnBase.duplicates,
      `重启后基线：${JSON.stringify(a1WarnBase)}（库内已有 ${a1WarnBase.rows} 行为重启前所写；` +
      `计数器是进程内的，故一律用 Δ 口径）`);

    /* ---- ④ 写失败隔离：固化抛错 ⇒ 帧仍落库、判定照跑、失败只计数 ----
       ⚠ **注入必须落在"确实要调 `upsertFrozen` 的那一 tick"**，且该帧的**采集时刻必须晚于**
       本夹具已落库的最后一秒（ADR-0001 D7：不早于上次落库那一秒 ⇒ 判 `raw-500ms`/`duplicate`，
       `onSampled` 根本不会跑、桩也不会被调用）。首版两条都踩了：既用了"同班次内"的帧、
       又在时钟回拨后推了一帧更早的时刻（`stored=false` ⇒ `measure_rt` 一行没涨）。
       现取 **10-06 20:00:01**（晚于上一帧 10-06 09:00:01；属"中班10-06"，到达前推时跨过
       10-07 00:00 的边界）⇒ 现算序列恰含 2 个已跑完班次（中班10-06、早班10-07），写入口必被调用。
       两种可观测口径我选**前者**（"跨班 tick 上 `failures` 增量 ∈ [1, 班次数]"）：它是唯一能把
       "写入口真被调用过"与"没跨班所以压根没调用"分开的正面判据；第 ② 种（"仅在尝试固化时 +1"）
       由 A1-12 的"该 tick 一行都没写进 `shift_stat`、`writes` 未增"从反面佐证。 */
    a1ClockMs = Date.parse('2026-10-06T20:00:10');
    const a1FailTarget = '2026-10-06 20:00:01';
    /* 现算序列的**起点取被测实现自述的"上次所见班次"**（`shiftStatWrite.lastShift.startAt`），
       不假定"上一帧是谁" —— 这样即使夹具里某帧被判 `raw-500ms`（进程内记忆没推进），期望值仍然自洽。 */
    const a1FailLastShift = serverEntry.state.shiftStatWrite.lastShift;
    const a1FailWantKeys = a1FailLastShift
      ? a1CompletedShifts(a1FailLastShift.startAt, a1FailTarget).map(a1KeyOf)
      : [];
    const a1SavedUpsert = shiftStatRepo.upsertFrozen;
    const a1BeforeFail = {
      failures: serverEntry.state.shiftStatWrite.failures,
      writes: serverEntry.state.shiftStatWrite.writes,
      backfills: serverEntry.state.shiftStatWrite.backfills,
      rows: a1Rows(),
      frames: a1Db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c,
      warnings: warningRepo.countAll(a1Db)
    };
    let a1FailPush = null;
    try {
      shiftStatRepo.upsertFrozen = function () {
        throw new Error('harness-check 注入：DR-06 写入点抛错桩（只验"失败不污染采集链"）');
      };
      a1FailPush = await a1Push(a1FailTarget, 7011);
    } finally {
      shiftStatRepo.upsertFrozen = a1SavedUpsert;              // 当场还原（失败注入不留痕）
    }
    const a1AfterFail = {
      failures: serverEntry.state.shiftStatWrite.failures,
      writes: serverEntry.state.shiftStatWrite.writes,
      lastError: serverEntry.state.shiftStatWrite.lastError,
      frames: a1Db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c,
      warnings: warningRepo.countAll(a1Db)
    };
    t.check('A1-12 **写失败隔离**：固化抛错时该帧**仍被收下并落库**（HTTP 200/stored）、判定与预警落库照跑；' +
      '异常在写入点内部被收下（不冒泡成 500 / 不进 `sampledHookFailures`）；' +
      '且这一跳**确实发生在跨班 tick 上**（现算序列非空 ＋ 该 tick 一行都没写进 `shift_stat`）',
      a1FailPush.status === 200 && a1FailPush.stored === true &&
      a1FailWantKeys.length >= 1 && a1FailPush.dRows === 0 &&
      a1AfterFail.frames === a1BeforeFail.frames + 1 &&
      a1AfterFail.warnings >= a1BeforeFail.warnings &&
      a1AfterFail.writes === a1BeforeFail.writes,
      `status/stored=${a1FailPush.status}/${a1FailPush.stored}；measure_rt ${a1BeforeFail.frames} → ${a1AfterFail.frames}；` +
      `warning ${a1BeforeFail.warnings} → ${a1AfterFail.warnings}；` +
      `该 tick 现算应补记=${a1FailWantKeys.join(' , ') || '（空）'}、实测 Δrows=${a1FailPush.dRows}、writes ${a1BeforeFail.writes} → ${a1AfterFail.writes}`);

    t.check('A1-13 `/health.shiftStatWrite.failures` 的增量 **> 0** 且 `lastError` 带上注入原因 —— "悄悄不写"看得见；' +
      '本条与 A1-12 合起来给出上面第 ② 种口径：`failures` 增量 > 0 ⇔ 该 tick 真的尝试过固化' +
      '（首版拿不跨班的帧验它，故恒为 0 ⇒ **误报的根源在这里**）。' +
      '⚠ 增量是**每个班次一次**：该 tick 的现算序列有 2 个班次 ⇒ 全程触发 2 次写入口调用、计 2 次失败，' +
      '故这里断言"增量 ≥ 1 且 ≥ 该 tick 的班次数 − 1 的语义下不为 0"，**不写死 1**（原子操作的成功/失败计数口径见实现）。',
      a1AfterFail.failures - a1BeforeFail.failures >= 1 &&
      a1AfterFail.failures - a1BeforeFail.failures <= a1FailWantKeys.length &&
      typeof a1AfterFail.lastError === 'string' && a1AfterFail.lastError.indexOf('注入') >= 0,
      `failures ${a1BeforeFail.failures} → ${a1AfterFail.failures}（增量 ${a1AfterFail.failures - a1BeforeFail.failures}，` +
      `该 tick 现算班次数 ${a1FailWantKeys.length}）；writes ${a1BeforeFail.writes} → ${a1AfterFail.writes}（未增 ⇒ 真的没写进去）；` +
      `lastError=${a1AfterFail.lastError}`);

    /* ---- ⑤ `warning` 的不变量（逐帧）：非 ok 条数 ＝ Δ落库 ＋ Δ幂等命中 ---- */
    const a1FramesPostRestart = a1Frames.slice(a1WarnBase.frames);
    const a1NonOkFrames = a1Frames.filter(f => f.nonOk > 0);
    t.check('A1-14 **不变量逐帧成立**：每一帧的"事件里非 ok 条数" ＝ "Δ落库行数 ＋ Δ幂等命中数"' +
      '（不丢一条、不重一条）；且至少有一帧真的产生了非 ok 条目（否则这条恒等式是空的）；' +
      '重启后各帧的 Δ落库之和 ＝ 库内新增行数（**Δ 口径**，不使用跨重启的累计值）',
      a1Frames.length > 0 && a1Frames.every(f => f.nonOk === f.dWarnings + f.dDuplicates) &&
      a1NonOkFrames.length > 0 &&
      warningRepo.countAll(a1Db) - a1WarnBase.rows ===
        a1FramesPostRestart.reduce((s, f) => s + f.dWarnings, 0),
      a1Frames.map(f => `${f.at.slice(11)}: 非ok ${f.nonOk} ⇒ 落库 ${f.dWarnings} ＋ 幂等 ${f.dDuplicates}`).join('；') +
      `｜重启后：库内 ${a1WarnBase.rows} → ${warningRepo.countAll(a1Db)}（Δ=${warningRepo.countAll(a1Db) - a1WarnBase.rows}）` +
      `＝各帧 Δ落库之和 ${a1FramesPostRestart.reduce((s, f) => s + f.dWarnings, 0)}`);

    t.check('A1-15 **只落非 ok**：事件里的 `ok` 回执条一条都不进 `warning` 表，而是计入 `/health.warningWrite.skippedOk`；' +
      '且逐帧 `Δwrites === Δ落库行数`（计数器不自说自话）',
      a1Frames.some(f => f.okCount > 0) &&
      serverEntry.state.warningWrite.skippedOk >= 1 &&
      a1Frames.every(f => f.dWrites === f.dWarnings),
      `warningWrite=${JSON.stringify(serverEntry.state.warningWrite)}；库内 warning 行数=${warningRepo.countAll(a1Db)}；` +
      `ok 条数合计=${a1Frames.reduce((s, f) => s + f.okCount, 0)}；` +
      `逐帧 Δwrites===Δ落库=${a1Frames.every(f => f.dWrites === f.dWarnings)}`);

    t.check('A1-16 `/health.warningWrite.lastWarnType` 是**判定产出的标题之一**（不是空串、也不是内部键名），' +
      '且 `failures` 为 0（本段没有注入预警写失败）',
      typeof serverEntry.state.warningWrite.lastWarnType === 'string' &&
      serverEntry.state.warningWrite.lastWarnType.length > 0 &&
      Object.values(judge.WARN_TITLES).concat(Object.values(judge.OTHER_TITLES))
        .indexOf(serverEntry.state.warningWrite.lastWarnType) >= 0 &&
      serverEntry.state.warningWrite.failures === 0,
      `lastWarnType=${JSON.stringify(serverEntry.state.warningWrite.lastWarnType)}、` +
      `failures=${serverEntry.state.warningWrite.failures}`);

    t.check('A1-17 端点在场：`/health` 的 `addRunSecBound` 给的是**重设后**的界（口径字符串与当班时长三项俱全）—— ' +
      '"界到底是多少"不必去读源码',
      a1HealthAfterJump.addRunSecBound &&
      a1HealthAfterJump.addRunSecBound.rule === '0 ≤ addRunSec ≤ shift.elapsedSec' &&
      Number.isFinite(a1HealthAfterJump.addRunSecBound.elapsedSec) &&
      Number.isFinite(a1HealthAfterJump.addRunSecBound.totalSec),
      JSON.stringify(a1HealthAfterJump.addRunSecBound));

    /* ---- ⑥ `E85⒝`：**H4 的可杀窗口** —— 重启后**首帧即跨班**（中间不推同班次帧）----
       为什么单独补这一段：A1-9 在重启后先推了一帧**同班次**帧，把 `lastShift` 重新设成与"回读值"
       同名的键 ⇒ `previousFrameShiftOf(frame) → null`（H4 变异体）在 A1-9／A1-10 上**不会被判红**
       （座位 5 的 C·18.4 实测 299/0）。座位 5 自建的"重启后首帧即跨班"窗口实测 `Δrows` **2 → 0**
       （变异体 `9a0e3695a746…`）⇒ 这里把它补进本节的**门禁**。
       期望值仍由**班次真源现算**：`from` ＝ 重启前最后一条采样帧的时刻（`中班10-06` 的窗口内），
       `to` ＝ 本帧时刻（`早班10-07`）⇒ 现算序列＝[中班10-06, 晚班10-07]（两行都**必须新落库**：
       中班10-06 落在 A1-12 那一跳（写入点抛错 ⇒ 一行没写）之后，故它**只能**由"回读上次所见班次"
       推出来）。`prev=null` 时走的 `else` 支把 `lastShift` 记为**当前**班次并直接 return ⇒ `Δrows=0`。 */
    const a1H4ClockMs = Date.parse('2026-10-07T09:00:10');
    const a1H4RowsBefore = a1Rows();
    const a1H4RowsBeforeKeys = shiftStatRepo.listRows(a1Db, 50).map(r => `${r.shift_date}|${r.shift_name}`);
    const a1H4LastFrame = a1Db.prepare('SELECT collect_time AS t FROM measure_rt ORDER BY collect_time DESC LIMIT 1').get();
    await serverEntry.stop('a1-e2e-h4-window');               // 真停：进程内"上次所见班次"随之丢失
    a1ClockMs = a1H4ClockMs;
    a1Svc = await serverEntry.start({
      argv: ['--port', '0', '--data-dir', a1Tmp, '--db-file', path.join(a1Tmp, 'board.db')],
      installSignalHandlers: false, logConsole: false, logger: a1Logger, clock: a1Clock
    });
    a1Db = serverEntry.state.db;
    a1Svc.bus.subscribe(e => { if (e.kind === 'warning') a1WarnEvents.push(e.payload); });
    const a1H4RestartState = {
      lastShiftKey: serverEntry.state.shiftStatWrite.lastShiftKey,
      writes: serverEntry.state.shiftStatWrite.writes
    };
    const a1H4Jump = await a1Push('2026-10-07 09:00:01', 7012);
    const a1H4From = a1H4LastFrame && a1H4LastFrame.t;
    const a1H4WantKeys = a1CompletedShifts(a1H4From, '2026-10-07 09:00:01').map(a1KeyOf);
    const a1H4ArriveKey = a1KeyOf(a1ShiftRules.at('2026-10-07 09:00:01'));
    const a1H4Newly = a1H4Jump.rowsAfter.filter(k => a1H4RowsBeforeKeys.indexOf(k) < 0);
    t.check('A1-18 **重启后首帧即跨班**（`E85⒝` 补入的 H4 杀窗口）：重启后**不先推同班次帧**，直接推一帧跨班帧 ⇒ ' +
      '现算序列里的每一行都必须落库（这一跳新写入的＝现算序列**全部**；"中班10-06"只能由 `measure_rt` ' +
      '回读上次所见班次才推得出，到达班"早班10-07"与它不同名 ⇒ 蒙不对）；`Δrows ≡ 新增行数` —— ' +
      '把 `previousFrameShiftOf(frame)` 换成 `null`（H4）时该窗口 `Δrows` 由 2 变 0 ⇒ 本条即其判别力所在',
      a1H4RestartState.lastShiftKey === null && a1H4RestartState.writes === 0 &&
      a1H4WantKeys.length === 2 && a1H4WantKeys[0] === '2026-10-06|中班' &&
      a1H4WantKeys.indexOf(a1H4ArriveKey) < 0 &&
      a1H4Jump.dRows === 2 && a1H4Jump.dRows === a1H4Newly.length &&
      JSON.stringify(a1H4Newly) === JSON.stringify(a1H4WantKeys) &&
      a1H4Jump.rowsAfter.length === a1H4RowsBefore + 2,
      `重启后 lastShiftKey=${a1H4RestartState.lastShiftKey}、writes=${a1H4RestartState.writes}；` +
      `本帧 Δrows=${a1H4Jump.dRows}（库内 ${a1H4RowsBefore} → ${a1H4Jump.rowsAfter.length}）；` +
      `本帧新增＝${a1H4Newly.join(' → ')}；现算期望＝${a1H4WantKeys.join(' → ')}（from=${a1H4From}）；` +
      `到达帧所属=${a1H4ArriveKey}（未跑完 ⇒ 不固化）`);

    /* ---- `E85⒟`：**覆盖缺口显式登记**（不是断言，是"哪几条路今天没人走"的清单）----
       `H1`（把"时间倒退不是边界"那一支改成 `if (false)`）经座位 5 的 C·18.4 判为**不可达的防御分支**
       （`ingest` 只接受严格更晚的秒 ＋ `at().startAt` 单调不减），**不是**缺口；但同族的三处在全仓
       **零断言**（`grep` 全 `tests\` 无命中），这里如实登记（不假装已覆盖）：
         · `state.shiftStatWrite.staleFrames`（时间倒退计数）—— 该支在公开面上不可达，故无断言；
         · `MAX_BACKFILL_SHIFTS`（达上限的 `补记枚举中断`／`truncated`）—— 该常量的**定义**与**使用点**
           都在 `server\index.js` 里（`const MAX_BACKFILL_SHIFTS = …` 与 `while (list.length <=
           MAX_BACKFILL_SHIFTS)`／`if (list.length > MAX_BACKFILL_SHIFTS) truncated = true`），
           **按符号说、不写行号**（`E134` 的教训：行号会随无关改动漂，实测这条注释原写的
           `server\index.js:1311-1323` 在使用点挪到约 `:1500+` 后**全部指错**）；
           —— 要覆盖需要一个"游标不前进"的注入点（属实现侧改造，不在测试写范围内）。
       `H2`（删掉"本进程首次 tick"支里紧跟 `st.lastShift = cur;` 的 `return`）是**等价变异体**
       （紧随的守卫返回**同一字面量**、中间无副作用）⇒ 它"未命中"是**正确读数**，不是缺口。 */
    t.info(`§15 覆盖登记（E85⒞／⒟，均**非缺口**）：H2＝等价变异体（同一字面量、无副作用）；` +
      `H1＝不可达防御分支（ingest 秒单调 ＋ at().startAt 单调）；**零断言的两处**＝` +
      `\`shiftStatWrite.staleFrames\` 与 \`MAX_BACKFILL_SHIFTS\` 达上限的 \`补记枚举中断\`（truncated）—— ` +
      `两处都要覆盖需实现侧注入点，故**只登记**（"首次 tick 且库里没有更早帧 ⇒ prev=null"那一支不是缺口：` +
      `A1-1 的第一帧就走它，且 A1-8 已断言重启后 lastShiftKey === null）`);

    /* ---- `E85⒜` 收尾：跑完本节**全部**帧之后，再用同一组独立性判据复核**整序** ----
       此刻库里已同时存在"有帧无件"（早班10-02 等）、"有帧有件"（中班10-02）与"无帧无件"（中班10-03、
       晚班10-07 等占位行）三种形态 ⇒ 这条非空性条件在这里才立得住（A1-5 时占位行还没产生）。
       ⚠ `E88⒜` 更正（2026-10-02）：旧注释说"无帧有件"（`(0,NULL,0)`）本节夹具产不出来 —— **实测产得出**：
       `2026-10-02|中班` 的 `pass_rate` 非 NULL（冻结时窗口内有件 ⇒ `pieceCount > 0`）而事后按可变的
       `judged_at` 数到 0 件 ⇒ 在**现值口径**下正是 `frames>0` 且 `pieces=0`；只是因为该窗内**确有 1 帧**，
       所以它不算"无帧"那一类。真正的"无帧"形态在本夹具里只有**占位行**（窗口内一帧都没有）——
       而"无帧却有件"在实现上不可能（判定的 `judged_at` 由帧驱动、`frozen_at` 也由帧 tick 给出），
       故 A1-19 **不要求**它出现，A1-5 用显式构造的合法形态覆盖它（那条构造的形状与"中班10-02"同型）。 */
    const a1ShapeEnd = a1ShapeAudit();
    t.check('A1-19 状态位"不用 0 顶替"的**全序复核**（`E85⒜` 收尾、`E88⒜` 修方向）：本节帧序列跑完后，库内**每一行**仍满足 ' +
      'A1-5 的独立性判据（**冻结时件数**做前提，不拿库里现数的件数当前提），且"有帧无件""有帧有件"' +
      '"无帧无件（占位行）"三种形态各至少 1 行；"现在数到的件数 ≤ 冻结时数到的件数"全表成立（`judged_at` 只被往后刷）；' +
      '占位行两列都必须 NULL（`run_sec = 0` 那个 0 **不得**被读成"零运行"）—— 合法行不因"件数事后被动过"而假判红',
      a1ShapeEnd.rows.length >= 3 && a1ShapeEnd.bad.length === 0 && a1ShapeEnd.subsetBad.length === 0 &&
      a1ShapeEnd.kinds['有帧无件'] >= 1 && a1ShapeEnd.kinds['有帧有件'] >= 1 &&
      a1ShapeEnd.kinds['无帧无件（占位行）'] >= 1 &&
      a1ShapeEnd.staleRows.length >= 1,
      `共 ${a1ShapeEnd.rows.length} 行；与独立性判据不符 ${a1ShapeEnd.bad.length} 行（须为 0）` +
      `${a1ShapeEnd.bad.length ? '：' + a1ShapeEnd.bad.map(x => `${x.key}(${x.bad})`).join('、') : ''}；` +
      `"现在数到 ≤ 冻结时"不符 ${a1ShapeEnd.subsetBad.length} 行（须为 0）；` +
      `件数被事后动过的行 ${a1ShapeEnd.staleRows.length} 行（须 ≥ 1，否则 ⒜ 的现场没被覆盖）` +
      `${a1ShapeEnd.staleRows.length ? '：' + a1ShapeEnd.staleRows.map(x => x.key).join('、') : ''}；` +
      `形态行数＝${JSON.stringify(a1ShapeEnd.kinds)}（三种各须 ≥ 1）；逐行＝` +
      a1ShapeEnd.rows.map(x => `${x.key}(frames=${x.fact ? x.fact.frames : '?'},` +
        `冻结时件数=${x.fact ? x.fact.frozenPieces : '?'},现在数到=${x.fact ? x.fact.pieces : '?'}` +
        ` ⇒ oee=${JSON.stringify(x.row.oee)},pass_rate=${JSON.stringify(x.row.pass_rate)})`).join(' , '));
  } finally {
    shiftStatRepo.upsertFrozen = a1OrigUpsert;                // 计数包装当场还原成模块原件（不留痕）
    try { await serverEntry.stop('a1-e2e'); } catch { /* 尽力 */ }
    try { harness.removeLinkSafe(a1Tmp, { recursive: true, force: true }); } catch { /* 已删 */ }
  }
  t.check('A1：本节自建的临时目录跑完**当场删除**（一用例一库，不留残留）',
    !fs.existsSync(a1Tmp), a1Tmp);
}

/* ---------------- 十七、FR-7.12 公告写链路（IF-E `POST /notice`；T-20261002-08 交付） ----------------
   被测对象（**全部已入库**，本节只断言、不改实现）：
     · `server/repo/notice.js`      —— DR-10 的**唯一写入口**（`publish`/`edit`/`remove`）＋ 四个读口；
     · `server/http/routes/notice.js` —— **IF-E 写路由** `POST /notice`（鉴权 → 回环 → 锁定 → 动作 → 落库）；
     · `server/services/stateSnapshot.js` 的 `notices` 段 —— 与 `POST /notice` 响应**同一份投影**。
   需求依据：`FR-7.12`（P0）「**仅本机解锁后可新增/编辑/删除公告**」；「操作记录保留」＝`FR-8.7`／`NFR-15`／`DR-12`。
   负责人已裁定的口径（本节**逐条按它写**，不反向假设）：
     · **两支 403 都保留**（`not_loopback` ＝来源不是回环；`locked` ＝会话有效但账号锁定，ADR-0007 D2）⇒ 各一条；
     · 删除＝**硬删 ＋ 原文进 `op_log`**（`valid_to` 是 DR-10 的**有效期**语义，**不是**软删标志）；
     · 投影 `lv` 恒 `'info'`、`todo` 恒 `[]`（`notice` 表无等级/待办列 ⇒ **不要求实现编造**）；
     · **不发 SSE 事件**（前端用 `POST` 响应里同一份投影就地刷新）；
     · `valid_from` 缺省＝发布时刻、`valid_to` 缺省 NULL、`priority` 缺省 0 —— `FR-7.11` 的**有效期过滤与轮播
       未实现**（P1／技术债 `E3`），两列**只是如实落库**，故本节只断言"缺省取值"，**不**断言任何过滤/轮播行为；
     · 401 只 `warn` **不写库**（未解锁场景不留痕）；**过了鉴权闸**的被拒一律留一条 `result='失败'`。
   为什么进程内 ＋ 真进程两段都要：
     · `not_loopback` 与 `locked` **只能在进程内造**（回环闸看 `req.socket.remoteAddress`；锁定要看账号状态位），
       真 HTTP 回环请求永远是回环来源；
     · 而"`GET /state` 与 SSE `hello` 的 `notices` 同源同形"**只能在真进程上验**（SSE 是长连接、`hello` 是建连首帧）。
   `E86①`（已知集成缺口）：前端"解锁 ⇒ 会话令牌"**未接线**（属 `FR-8.4`／`ADR-0007` 的包）⇒ 服务端模式下
   前端写入会拿 401 并被**显示**。该缺口的行为断言归 `tests\ui-check.js`（本节**不**要求本包实现登录接线）。 */
t.section('十七、FR-7.12 公告写链路（IF-E `POST /notice`：鉴权／仅本机／锁定／入参／留痕／投影同源）');
{
  const dbApiN = require('../server/db');
  const { createAuth: createAuthN } = require('../server/services/auth');
  const { mountNotice } = require('../server/http/routes/notice');
  const { createRouter: createRouterN } = require('../server/http/router');
  const { createStateSnapshot } = require('../server/services/stateSnapshot');
  const opLogRepoN = require('../server/repo/opLog');
  const noticeRepoN = require('../server/repo/notice');

  const N_NOW = '2026-10-02 09:30:00';
  const N_PW = 'Notice#2026';

  /* 进程内 req/res 桩件（只为本节服务）。`remote` 可控 —— 回环闸那两条只能在进程内造；
     形状与 `server/http/router.js` 的 `readJson`/`json` 期望一致（`Symbol.asyncIterator` ＋ `writeHead/end`）。 */
  const nReq = ({ body = null, token = '', remote = '127.0.0.1' } = {}) => {
    const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    return {
      method: 'POST', url: '/notice',
      headers: token ? { authorization: 'Bearer ' + token } : {},
      socket: { remoteAddress: remote },
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: async () => (i < chunks.length
            ? { value: chunks[i++], done: false }
            : { value: undefined, done: true })
        };
      }
    };
  };
  const nRes = () => {
    const out = { status: null, body: null, text: '' };
    return {
      out,
      writeHead(s) { out.status = s; return this; },
      setHeader() { return this; },
      write() { return true; },
      end(t) {
        out.text = t === undefined ? '' : String(t);
        try { out.body = JSON.parse(out.text); } catch { out.body = null; }
        return this;
      },
      destroy() { return this; }
    };
  };

  const nTmp = harness.makeTempDb({ name: 'notice-route-matrix' });
  try {
    dbApiN.initSchema(nTmp.db, N_NOW);
    const nDb = nTmp.db;
    const nClock = createClock({ mode: 'fixed', at: '2026-10-02T09:30:00' });
    const nAuth = createAuthN({ db: nDb, now: nClock.source(), silent: true, teamCode: '检验一班' });
    const nInit = nAuth.init({ code: nAuth.initCode(), password: N_PW, remote: '127.0.0.1' });
    const nLogin = nAuth.login({ password: N_PW, remote: '127.0.0.1' });
    const nToken = (nLogin && nLogin.token) || '';
    const nRouter = createRouterN({ getHealth: () => ({ ok: true }), now: nClock.source() });
    const nMount = mountNotice(nRouter, {
      db: nDb, auth: nAuth, now: nClock.source(), operator: null, teamCode: '检验一班'
    });
    const nDrive = async opts => { const res = nRes(); await nRouter.handle(nReq(opts), res); return res.out; };
    const nCount = () => nDb.prepare('SELECT COUNT(*) AS c FROM notice').get().c;
    const nRows = () => nDb.prepare('SELECT * FROM notice ORDER BY id').all();
    const nOpCount = (opType, result) => (result === undefined
      ? nDb.prepare('SELECT COUNT(*) AS c FROM op_log WHERE op_type = ?').get(opType).c
      : nDb.prepare('SELECT COUNT(*) AS c FROM op_log WHERE op_type = ? AND result = ?').get(opType, result).c);
    /** 公告类留痕里的**失败**行（`auth` 自己的失败留痕 op_type 不以"公告"开头，故按前缀筛） */
    const nFailNotice = () => nDb.prepare(
      "SELECT op_type, result, content, operator, team_code, op_time FROM op_log " +
      "WHERE result = '失败' AND op_type LIKE '公告%' ORDER BY id").all();

    t.requires('FR-7.12 前提：进程内鉴权可初始化并取到会话令牌（下面的 401/403 才有归因对象）',
      Boolean(nInit && nInit.ok === true && nLogin && nLogin.ok === true && /^[0-9a-f]{64}$/.test(nToken)),
      `init.ok=${nInit && nInit.ok}；login.ok=${nLogin && nLogin.ok}；token 长度=${nToken.length}`);

    /* ---- A0 正对照：回环 ＋ 有效令牌 ⇒ 真落库（"解锁后新增公告"的最小闭环） ---- */
    const n0 = await nDrive({ token: nToken, body: { action: 'publish', content: '公告链路正对照（原文）', subType: '生产调整' } });
    const nRow0 = nRows()[0] || {};
    t.check('FR-7.12 路由 A0 正对照：回环来源 ＋ 有效会话令牌 ⇒ 200（不是 401/403/503）；`notice` 表恰 +1 行、' +
      '`op_log`（公告发布/成功）恰 +1 行；缺省取值如实落库（`valid_from`＝发布时刻、`valid_to`＝NULL、`priority`＝0）；' +
      '`mountNotice` 只注册 1 条路由且就是 `POST /notice`',
      n0.status === 200 && n0.body && n0.body.ok === true && nCount() === 1 && nRows().length === 1 &&
      nOpCount('公告发布', opLogRepoN.RESULT.SUCCESS) === 1 &&
      nRow0.content === '公告链路正对照（原文）' && nRow0.sub_type === '生产调整' &&
      nRow0.category === noticeRepoN.CATEGORY.NOTICE && Number(nRow0.priority) === 0 &&
      nRow0.valid_from === N_NOW && nRow0.valid_to === null && nRow0.created_at === N_NOW &&
      n0.body.opLogId !== null && nMount.routes.length === 1 && nMount.routes[0] === 'POST /notice',
      `HTTP ${n0.status}；notice=${nCount()} 行；发布留痕（成功）=${nOpCount('公告发布', opLogRepoN.RESULT.SUCCESS)}；` +
      `库行=${JSON.stringify(nRow0)}；routes=[${nMount.routes.join(',')}]`);
    const nPubId = n0.body && n0.body.id;

    /* ---- A1：401（未登录/伪造令牌）**不留痕** ---- */
    const nLogsBefore401 = opLogRepoN.count(nDb);
    const nNoTok = await nDrive({ body: { action: 'publish', content: '未登录不该写进去' } });
    const nForged = await nDrive({ token: 'deadbeef', body: { action: 'publish', content: '伪造令牌也不该写进去' } });
    t.check('FR-7.12 路由 A1 **未登录**（无 Bearer ＋ 伪造令牌）⇒ 两条都 401 `unauthorized`（带原因），' +
      '且 `notice` 表与 `op_log` **一行都没动** —— 未解锁场景不留痕（401 只在服务端日志 warn）',
      nNoTok.status === 401 && nNoTok.body && nNoTok.body.error === 'unauthorized' &&
      typeof nNoTok.body.reason === 'string' && nNoTok.body.reason.length > 0 &&
      nForged.status === 401 && nForged.body && nForged.body.error === 'unauthorized' &&
      nCount() === 1 && nOpCount('公告发布', opLogRepoN.RESULT.SUCCESS) === 1 &&
      opLogRepoN.count(nDb) === nLogsBefore401 && nFailNotice().length === 0,
      `无令牌=${nNoTok.status}/${nNoTok.body && nNoTok.body.error}；伪造=${nForged.status}/${nForged.body && nForged.body.error}；` +
      `notice=${nCount()}；op_log ${nLogsBefore401}→${opLogRepoN.count(nDb)}（应不变）；公告类失败留痕=${nFailNotice().length}（应 0）`);

    /* ---- A2：403 `not_loopback`（FR-7.12 的「仅本机」）＋ 过了鉴权闸的被拒要留痕 ---- */
    const nOff = await nDrive({
      token: nToken, remote: '10.10.2.77',
      body: { action: 'publish', content: '来自局域网的公告' }
    });
    const nFail2 = nFailNotice();
    t.check('FR-7.12 路由 A2 **非本机来源**（socket `10.10.2.77`）＋ 有效令牌 ⇒ 403 `not_loopback`' +
      '（FR-7.12「仅本机」；判据只看 `req.socket.remoteAddress`、不信请求头）；`notice` 表一行不写，' +
      '但**过了鉴权闸的被拒也留痕**：`op_log` 恰 +1 条 `result=失败`（带操作人/班组/DR-16 时刻）',
      nOff.status === 403 && nOff.body && nOff.body.error === 'not_loopback' && nCount() === 1 &&
      nFail2.length === 1 && nFail2[0].result === opLogRepoN.RESULT.FAILED &&
      nFail2[0].op_type === noticeRepoN.OP_TYPE.PUBLISH &&
      nFail2[0].operator !== null && nFail2[0].team_code === '检验一班' &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(nFail2[0].op_time)) &&
      /not_loopback/.test(String(nFail2[0].content)),
      `HTTP ${nOff.status}/${nOff.body && nOff.body.error}；notice=${nCount()}；公告类失败留痕=` +
      `${nFail2.length} 条：${JSON.stringify(nFail2)}`);

    /* ---- A3：400 `bad_value`（publish 缺 content ⇒ 仓储入参校验抛错 ⇒ 400，不是 500） ---- */
    const nBadVal = await nDrive({ token: nToken, body: { action: 'publish', subType: '生产调整' } });
    /* ---- A4：400 `bad_action`（动作名不在三态里） ---- */
    const nBadAct = await nDrive({ token: nToken, body: { action: 'rename', content: 'x' } });
    /* ---- A5：404 `not_found`（删不存在的行 ⇒ 不静默假装成功） ---- */
    const nMiss = await nDrive({ token: nToken, body: { action: 'delete', id: 999999 } });
    const nFail345 = nFailNotice();
    t.check('FR-7.12 路由 A3/A4/A5 三条逆向逐条落在契约码上：缺 `content` ⇒ 400 `bad_value`、' +
      '动作名非法 ⇒ 400 `bad_action`、删不存在的行 ⇒ 404 `not_found` —— **每条都留一条 `result=失败`**（拒收也留痕，' +
      '与 401/503 分得开），且 `notice` 表始终仍是 1 行',
      nBadVal.status === 400 && nBadVal.body && nBadVal.body.error === 'bad_value' &&
      nBadAct.status === 400 && nBadAct.body && nBadAct.body.error === 'bad_action' &&
      nMiss.status === 404 && nMiss.body && nMiss.body.error === 'not_found' &&
      nCount() === 1 && nFail345.length === 4 &&
      nFail345[1].op_type === noticeRepoN.OP_TYPE.PUBLISH &&
      nFail345[2].op_type === noticeRepoN.OP_TYPE.REJECT &&
      nFail345[3].op_type === noticeRepoN.OP_TYPE.DELETE &&
      nFail345.every(r => r.result === opLogRepoN.RESULT.FAILED),
      `缺 content=${nBadVal.status}/${nBadVal.body && nBadVal.body.error}；非法动作=${nBadAct.status}/${nBadAct.body && nBadAct.body.error}；` +
      `删不存在=${nMiss.status}/${nMiss.body && nMiss.body.error}；notice=${nCount()}；公告类失败留痕=` +
      `${nFail345.length} 条（op_type=${nFail345.map(r => r.op_type).join('/')}）`);

    /* ---- A6：编辑＝**同一条更新**（行数不变、`id`/`created_at` 不变、`updated_at` 刷新） ---- */
    const nEdit = await nDrive({
      token: nToken,
      body: { action: 'edit', id: nPubId, content: '公告链路正对照（编辑后）', subType: '工艺变更' }
    });
    const nRowE = nRows()[0] || {};
    t.check('FR-7.12 路由 A6 **编辑**：200 ⇒ 仍是**同一行**（`notice` 行数不变、`id` 与 `created_at` 逐字不变）而 ' +
      '`content`/`sub_type` 已更新、`updated_at` 刷新为本动作时刻；`op_log`（公告编辑/成功）恰 +1，' +
      '留痕正文含「内容『旧』→『新』」逐字变更清单',
      nEdit.status === 200 && nEdit.body && nEdit.body.ok === true && nCount() === 1 && nRows().length === 1 &&
      Number(nRowE.id) === Number(nPubId) && Number(nRowE.id) === Number(n0.body.id) &&
      nRowE.content === '公告链路正对照（编辑后）' && nRowE.sub_type === '工艺变更' &&
      nRowE.created_at === nRow0.created_at && nRowE.updated_at === N_NOW &&
      nOpCount('公告编辑', opLogRepoN.RESULT.SUCCESS) === 1 &&
      /公告链路正对照（原文）/.test(String(nEdit.body.changed && nEdit.body.changed.join('；'))) &&
      /公告链路正对照（编辑后）/.test(String(nEdit.body.changed && nEdit.body.changed.join('；'))),
      `HTTP ${nEdit.status}；行数=${nCount()}（id ${nRow0.id}→${nRowE.id}）；created_at ${nRow0.created_at}→${nRowE.created_at}；` +
      `updated_at=${nRowE.updated_at}；changed=${JSON.stringify(nEdit.body && nEdit.body.changed)}`);

    /* ---- A7：成功响应带的**投影**与 `GET /state` 快照走**同一份**（不写第二份投影） ---- */
    const nSnap = createStateSnapshot({ db: nDb, now: nClock.source() })();
    const nProj = nEdit.body && nEdit.body.notices;
    t.check('FR-7.12 路由 A7 **投影同源**：`POST /notice` 成功响应里的 `notices` 与 `GET /state` 快照的 `notices` ' +
      '**逐字节相等**，且都等于读口 `repo/notice.js` 的 `listForBoard()` 产出（三处一份投影）；' +
      '行形状＝`{id,tag,text,lv,time}`（`lv` 恒 `info`、`todo` 恒 `[]`，表无等级/待办列 ⇒ 不编造）',
      Boolean(nProj) && Boolean(nSnap.notices) &&
      JSON.stringify(nProj) === JSON.stringify(nSnap.notices) &&
      JSON.stringify(nProj) === JSON.stringify(noticeRepoN.listForBoard(nDb)) &&
      nProj.notices.length === 1 && nProj.notices[0].id === nPubId &&
      nProj.notices[0].tag === '工艺变更' && nProj.notices[0].text === '公告链路正对照（编辑后）' &&
      nProj.notices[0].lv === 'info' && /^\d{2}:\d{2}$/.test(String(nProj.notices[0].time)) &&
      Array.isArray(nProj.tips) && nProj.tips.length === 0 &&
      Array.isArray(nProj.todo) && nProj.todo.length === 0,
      `POST 响应 notices=${JSON.stringify(nProj)}；快照 notices=${JSON.stringify(nSnap.notices)}；三处相等=` +
      `${JSON.stringify(nProj) === JSON.stringify(nSnap.notices) && JSON.stringify(nProj) === JSON.stringify(noticeRepoN.listForBoard(nDb))}`);

    /* ---- A8：删除＝**硬删**（行数 −1、按 id 查不到）＋ 原文进留痕 ---- */
    const nDel = await nDrive({ token: nToken, body: { action: 'delete', id: nPubId } });
    const nDelAgain = await nDrive({ token: nToken, body: { action: 'delete', id: nPubId } });
    t.check('FR-7.12 路由 A8 **删除＝硬删 ＋ 原文进 `op_log`**：200 ⇒ `notice` 表 −1 行（0 行）、按 id 查不到，' +
      '删除留痕（公告删除/成功）恰 +1 且正文里带**原文**与发布时刻/创建人；对同一条**再删** ⇒ 404 `not_found`' +
      '（不静默假装成功）—— `valid_to` 仍是有效期列，**不是**软删标志',
      nDel.status === 200 && nDel.body && nDel.body.ok === true && nCount() === 0 &&
      noticeRepoN.getById(nDb, nPubId) === null &&
      nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS) === 1 &&
      nDelAgain.status === 404 && nDelAgain.body && nDelAgain.body.error === 'not_found' &&
      nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS) === 1 &&
      (() => {
        const row = nDb.prepare("SELECT content FROM op_log WHERE op_type = '公告删除' AND result = '成功' ORDER BY id DESC LIMIT 1").get();
        const txt = String(row && row.content);
        return /公告原文：公告链路正对照（编辑后）/.test(txt) && txt.includes(N_NOW);
      })(),
      `HTTP ${nDel.status}；notice=${nCount()}（硬删）；删除留痕（成功）=${nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS)}；` +
      `再删=${nDelAgain.status}/${nDelAgain.body && nDelAgain.body.error}；留痕正文=` +
      JSON.stringify((nDb.prepare("SELECT content FROM op_log WHERE op_type='公告删除' AND result='成功' ORDER BY id DESC LIMIT 1").get() || {}).content));

    /* ---- A9：503 `NO_SERVICE`（未接库 ⇒ 装配问题，不是报文问题；**无库可写故不留痕**） ---- */
    const n503Router = createRouterN({ getHealth: () => ({ ok: true }), now: nClock.source() });
    const n503Mount = mountNotice(n503Router, {
      db: null, auth: nAuth, now: nClock.source(), teamCode: '检验一班'
    });
    const nRes503 = nRes();
    await n503Router.handle(nReq({ token: nToken, body: { action: 'publish', content: '没有库就不该假装写成功' } }), nRes503);
    const n503 = nRes503.out;
    t.check('FR-7.12 路由 A9 **未接库**（`db = null`）＋ 有效令牌 ⇒ 503 `NO_SERVICE`（不静默假成功、也不报 400）；' +
      '`mounted:false` 自报；此时**无库可写** ⇒ 不计入留痕面（`status().rejected` 仍 0、`notice` 表仍是 0 行）',
      n503.status === 503 && n503.body && n503.body.error === 'NO_SERVICE' &&
      n503Mount.mounted === false && n503Mount.status().rejected === 0 &&
      nCount() === 0 && nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS) === 1,
      `HTTP ${n503.status}/${n503.body && n503.body.error}；mounted=${n503Mount.mounted}；` +
      `rejected=${n503Mount.status().rejected}（应 0）；notice=${nCount()}（应 0）`);

    /* ---- A10：403 `locked`（会话有效但账号锁定，ADR-0007 D2）—— 与 `not_loopback` **分得开** ---- */
    for (let i = 0; i < 6; i++) nAuth.login({ password: 'wrong-password', remote: '127.0.0.1' });
    const nLockedState = nAuth.status();
    const nLocked = await nDrive({ token: nToken, body: { action: 'publish', content: '锁定态不该写进去' } });
    t.check('FR-7.12 路由 A10 会话**仍然有效**但账号已**锁定** ⇒ 403 `locked`（"有登录态但无权限"这一支；' +
      'ADR-0007 D2 锁定期间口令正确也拒）—— 与 A2 的 `not_loopback` **两个码不混同**；同样留一条 `result=失败`',
      nLockedState.locked === true && nLocked.status === 403 && nLocked.body && nLocked.body.error === 'locked' &&
      typeof nLocked.body.retryAfterSec === 'number' && nCount() === 0 &&
      nFailNotice().length === 6 && nFailNotice()[5].op_type === noticeRepoN.OP_TYPE.PUBLISH &&
      nFailNotice()[5].result === opLogRepoN.RESULT.FAILED,
      `status.locked=${nLockedState.locked}（failCount=${nLockedState.failCount}）；HTTP ${nLocked.status}/` +
      `${nLocked.body && nLocked.body.error}（retryAfterSec=${nLocked.body && nLocked.body.retryAfterSec}）；` +
      `公告类失败留痕=${nFailNotice().length} 条（${nFailNotice().map(r => r.op_type).join('/')}）`);

    /* ---- A11：被拒留痕的**口径汇总**（401 不写、503 无库可写、其余各一条 `result=失败`） ---- */
    const nFailAll = nFailNotice();
    const nStat = nMount.status();
    t.check('FR-7.12 路由 A11 **被拒也留痕**的口径汇总（可逐条对账）：`401 ×2` 与 `503` **不写**，' +
      '`403 not_loopback`/`403 locked`/`400 bad_value`/`400 bad_action`/`404 not_found`/`404 再删` 各恰 1 条 —— ' +
      '公告类 `result=失败` 共 **6** 条，条数与 `status()` 计数器（`rejected=6`/`unauthorized=2`/`forbidden=2`）自洽',
      nFailAll.length === 6 && nStat.rejected === 6 && nStat.unauthorized === 2 && nStat.forbidden === 2 &&
      nFailAll.every(r => r.result === opLogRepoN.RESULT.FAILED && /^公告/.test(String(r.op_type))) &&
      nOpCount('公告发布', opLogRepoN.RESULT.SUCCESS) === 1 &&
      nOpCount('公告编辑', opLogRepoN.RESULT.SUCCESS) === 1 &&
      nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS) === 1 &&
      nStat.publish === 1 && nStat.edit === 1 && nStat.delete === 1,
      `公告类失败留痕 ${nFailAll.length} 条（op_type=${nFailAll.map(r => r.op_type).join('/')}）；` +
      `counters=${JSON.stringify(nStat)}；成功留痕 发布/编辑/删除=` +
      `${nOpCount('公告发布', opLogRepoN.RESULT.SUCCESS)}/${nOpCount('公告编辑', opLogRepoN.RESULT.SUCCESS)}/` +
      `${nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS)}`);
  } finally {
    nTmp.close();
    t.check('FR-7.12：进程内矩阵自建的临时库跑完**当场关闭并删除**（一用例一库，不留残留）',
      !fs.existsSync(nTmp.dir), nTmp.dir);
  }

  /* ---- B：真进程 ＋ 真 HTTP ＋ 真 SQLite：会话令牌 → 发布 → `GET /state` 与 SSE `hello` 的 notices 同源同形 ----
     为什么必须另起真进程：`hello` 是 SSE **建连首帧**，只有走过真 HTTP 长连接才拿得到；
     而"两处同源"这句话的可证伪形态就是"两边 JSON 逐字节相等"（同一构造函数）。 ---- */
  {
    const nSvcTmp = harness.makeTempDir('notice-e2e');
    let nSvc = null;
    let nLive = null;
    /** 读一帧 SSE `hello`（真 HTTP 长连接；超时/中断一律按"没读到"返回，由断言判红，不静默当通过） */
    const nReadHello = async base => {
      const ctl = new AbortController();
      let text = '';
      try {
        const res = await fetch(base + '/events', { signal: ctl.signal });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let reading = reader.read();
        reading.catch(() => { /* abort/重置：由下面的 race 收敛 */ });
        const until = Date.now() + 6000;
        while (Date.now() < until && text.indexOf('event: hello') < 0) {
          let chunk;
          try {
            chunk = await Promise.race([
              reading,
              new Promise(r => setTimeout(() => r({ timeout: true }), 200))
            ]);
          } catch { break; }
          if (chunk.timeout) continue;
          if (chunk.done) break;
          text += dec.decode(chunk.value, { stream: true });
          reading = reader.read();
          reading.catch(() => { /* 同上 */ });
        }
        try { await reader.cancel(); } catch { /* 已关 */ }
      } catch (err) {
        text = 'ERR ' + ((err && err.message) || String(err));
      } finally {
        try { ctl.abort(); } catch { /* 已关 */ }
      }
      return text;
    };
    try {
      nSvc = await harness.startService({
        script: 'server/index.js', args: ['--data-dir', nSvcTmp], readyPath: '/health', timeoutMs: 30000
      });
      const nBase = `http://127.0.0.1:${nSvc.port}`;
      nLive = dbApiN.openDb(path.join(nSvcTmp, 'board.db'));
      const nCodeRow = nLive.db.prepare(
        "SELECT content FROM op_log WHERE op_type = '口令初始化码' ORDER BY id DESC LIMIT 1").get();
      const nInitCode = (/一次性初始化码=([0-9a-f]{12})/.exec(nCodeRow ? nCodeRow.content : '') || [])[1] || '';
      const nPostB = async (p, body, token) => {
        const headers = { Accept: 'application/json' };
        if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json;charset=UTF-8';
        if (token) headers.Authorization = 'Bearer ' + token;
        const r = await fetch(nBase + p, {
          method: 'POST', headers, body: body === undefined || body === null ? undefined : JSON.stringify(body)
        });
        const text = await r.text();
        let j = null;
        try { j = text ? JSON.parse(text) : null; } catch { j = null; }
        return { status: r.status, body: j, text };
      };
      const nInitB = await nPostB('/auth/init', { code: nInitCode, password: N_PW });
      const nLoginB = await nPostB('/auth/login', { password: N_PW });
      const nTokenB = (nLoginB.body && nLoginB.body.token) || '';
      const nPubB = await nPostB('/notice',
        { action: 'publish', content: '端到端公告：SSE 与 /state 同源', subType: '工艺变更' }, nTokenB);
      const nRowsB = nLive.db.prepare('SELECT * FROM notice ORDER BY id').all();
      t.check('FR-7.12 端到端 B1 真进程（真 HTTP ＋ 真 SQLite）：`/auth/init` ＋ `/auth/login` 取到会话令牌后 ' +
        '`POST /notice` 发布 ⇒ 200、库内恰 1 行（内容/类型逐字相符），`op_log` 有一条公告发布成功留痕 —— ' +
        '公告写入复用**既有登录态**，不另造第二套令牌',
        nInitB.status === 200 && nLoginB.status === 200 && /^[0-9a-f]{64}$/.test(nTokenB) &&
        nPubB.status === 200 && nPubB.body && nPubB.body.ok === true &&
        nRowsB.length === 1 && nRowsB[0].content === '端到端公告：SSE 与 /state 同源' &&
        nRowsB[0].sub_type === '工艺变更' &&
        nLive.db.prepare("SELECT COUNT(*) AS c FROM op_log WHERE op_type='公告发布' AND result='成功'").get().c === 1,
        `init=${nInitB.status}；login=${nLoginB.status}（token 长度 ${nTokenB.length}）；发布 HTTP ${nPubB.status}；` +
        `库内 ${nRowsB.length} 行=${JSON.stringify(nRowsB[0] || null)}`);

      const nStateRes = await fetch(nBase + '/state');
      const nStateBody = await nStateRes.json();
      const nStateNotices = nStateBody && nStateBody.snapshot && nStateBody.snapshot.notices;
      const nItem = nStateNotices && nStateNotices.notices && nStateNotices.notices[0];
      t.check('FR-7.12 端到端 B2 `GET /state` 快照的 `notices` 段＝库内真值（真进程上再验一次）：本条公告在列、' +
        '行形状＝`{id,tag,text,lv,time}`（`lv` 恒 `info`）、`tips`/`todo` 为数组且 `todo` 恒 `[]`',
        nStateRes.status === 200 && Boolean(nStateNotices) && Array.isArray(nStateNotices.notices) &&
        nStateNotices.notices.length === 1 && Boolean(nItem) &&
        Object.keys(nItem).sort().join(',') === 'id,lv,tag,text,time' &&
        nItem.id === nRowsB[0].id && nItem.tag === '工艺变更' && nItem.text === '端到端公告：SSE 与 /state 同源' &&
        nItem.lv === 'info' && /^\d{2}:\d{2}$/.test(String(nItem.time)) &&
        Array.isArray(nStateNotices.todo) && nStateNotices.todo.length === 0,
        `snapshot.notices=${JSON.stringify(nStateNotices)}`);

      const nHelloText = await nReadHello(nBase);
      const nHelloMatch = /event: hello\ndata: ([^\n]+)/.exec(nHelloText);
      let nHelloData = null;
      try { nHelloData = nHelloMatch ? JSON.parse(nHelloMatch[1]) : null; } catch { nHelloData = null; }
      const nHelloNotices = nHelloData && nHelloData.snapshot && nHelloData.snapshot.notices;
      t.check('FR-7.12 端到端 B3 SSE `hello`（建连首帧）与 `GET /state` 的 `notices` **同源同形**：两处 ' +
        '`JSON.stringify` 逐字节相等，且都含本条公告 —— 前端"用 POST 响应里同一份投影就地刷新"与' +
        '"`hello` 与 `/state` 同一构造函数"这两条口径由此同时成立',
        Boolean(nHelloNotices) && JSON.stringify(nHelloNotices) === JSON.stringify(nStateNotices) &&
        nHelloNotices.notices.length === 1 &&
        nHelloNotices.notices[0].text === '端到端公告：SSE 与 /state 同源',
        `hello.snapshot.notices=${JSON.stringify(nHelloNotices)}；与 /state 相等=` +
        `${JSON.stringify(nHelloNotices) === JSON.stringify(nStateNotices)}；hello 原文片段=` +
        JSON.stringify(nHelloText.slice(0, 220)));
    } finally {
      if (nLive) { try { nLive.db.close(); } catch { /* 已关 */ } }
      if (nSvc) { try { await nSvc.stop(); } catch { /* 尽力 */ } }
      try { harness.removeLinkSafe(nSvcTmp, { recursive: true, force: true }); } catch { /* 已删 */ }
    }
    t.check('FR-7.12 端到端：本节自建的服务与临时目录跑完**当场停掉并删除**（一用例一库，不留残留）',
      !fs.existsSync(nSvcTmp) && (!nSvc || nSvc.proc.exitCode !== null || nSvc.proc.killed === true),
      `${nSvcTmp} 存在=${fs.existsSync(nSvcTmp)}`);
  }
}

/* ---------------- 十八、E87 `POST /upload/retry` 的来源闸（方案 b，`T-20261002-10`）＋ **登录态闸**（同口径完整版，`T-20261005-21`） ----------------
   被测对象（**只断言、不改实现**）：`server/http/routes/upload.js` 的 `POST /upload/retry` —— 全仓
   **唯一**会再次向 MES 发送待补传报文的入口（且按 `created_at,id` 顺序**批量**重发）。
   **◐ 2026-10-05 口径升级（负责人"同口径完整版"，与座位 3 的 `server\http\routes\upload.js` ＋
   `server\index.js` ＋ `src\services\api.js` 三处代码改动`T-20261005-21` **同批**落地）**：
     方案 b（只回环）与相邻同类写入口 `POST /notice`（`ADR-0007`：**回环 ＋ 登录态**）**不同口径** ⇒
     现在 `POST /upload/retry` 走**与 `/notice` 同一套**：**回环（403 `not_loopback`）＋ 会话令牌
     （401 `unauthorized`）**。判据仍取**真源**：`services/auth.js` 的 `isLoopback()`／
     `routes/auth.js` 的 `remoteOf()`／`readBearer()` ＋ `services/auth.js` 的 `createAuth().verify()`
     —— **本文件不自己比对令牌**。
     ⚠ **缺 `auth` 注入 ＝ 写入口 fail-closed（503 `no_auth`）**，而**挂载本身不抛**（见 `E87-10/11/12`；
     理由：本挂载同时带**三条只读端点**而只有写路径需要 `auth`）。
     ⚠ **同批窗口（如实登记）**：本节判据改完之后、座位 3 的代码改动落盘之前，本节的令牌／计数／
     缺 `auth` 那几组会**短暂变红**（现状是不带令牌也 200）—— 这是**预期的同批窗口**，不是本节的缺陷；
     代码侧落地后**本节整体转绿**。
     **三处口径由负责人 2026-10-05 裁定（维持座位 3 的实现，判据随改）**：
       ① **顺序**：非回环 ＋ 无令牌 ⇒ **403 `not_loopback`**（**来源闸先于登录态闸**）——
          理由：该入口的 403 **不写 `op_log`** ⇒ "LAN 有人在敲门"的唯一签名是 `counters.forbidden` ＋ warn，
          401 在前会把它埋掉；**"同口径" ＝ 同样具备两道闸，不是同样的先后**；
       ② **缺 `auth` 的形态＝行为级三条**（`E87-10/11/12`）：写入口 **503 `no_auth`**（fail-closed、
          未读体、未调 `retryPending`）、**只读端点仍 200**、**挂载不抛**；
          ⚠ **不写静态正则**去找 `if (!auth…) throw`（`E161` 口径：判据不得规定实现形状）；理由：本挂载
          同时带**三条只读端点**而只有写路径需要 auth ⇒ "挂载即抛"会打掉无关读口；
       ③ **计数键集＝4 个**：`forbidden`／`noAuth`／`retryHandled`／`unauthorized`
          （拒绝计数**分三档**：症状不许指向同一个数字；四者都不进任何响应体）。
    其余口径**逐字保留**（它们与本次升级无关，仍在下面）：
   为什么"没发送"必须有**调用计数**证据（`ADR-0004 D19`）：403 只是**应答**，它不排除"先发了再拒"；
   能把"一条都没发"证成的只有**桩上 `retryPending()` 的调用增量 ＝ 0**（外加 `router.readJson` 的
   增量 ＝ 0 ⇒ 连请求体都没读，拒绝发生在处理之前）。本节因此**拒绝**任何"只看 403 就算验过"的写法。
   判据来源**不注入**：`mountUpload()` 的 `isLoopback`/`remoteOf` 两个注入口一律**不传** ⇒ 走的是
   `server/index.js` 生产接线同一条真源路径（注入口只为探针而设；验注入口 ≠ 验实现）。
   "非回环"怎么造（`ADR-0007 D4`：只信 `req.socket.remoteAddress`、不信任何请求头）⇒ 只能在**进程内**
   遮蔽 socket 取值器（`Object.defineProperty`），且本节走**真 HTTP**（`http.createServer` ＋ `fetch`），
   不是直接调处理器 —— 与 `T-20261002-10` 的探针同款构造，但期望值由本节自持。
   范围最小化：`GET /upload/pending` 这类**只读**端点不在本包范围内 ⇒ 同一非回环来源进来仍必须 200。 */
t.section('十八、E87 `POST /upload/retry` 的**来源 ＋ 登录态**双闸（同口径完整版：非回环 ⇒ 403 not_loopback、缺令牌 ⇒ 401 unauthorized、缺 auth ⇒ 503 no_auth）');
{
  const { createRouter: createRouterE87 } = require('../server/http/router');
  const { mountUpload: mountUploadE87 } = require('../server/http/routes/upload');
  const { isLoopback: isLoopbackE87 } = require('../server/services/auth');
  const { remoteOf: remoteOfE87 } = require('../server/http/routes/auth');
  /* RFC 5737 TEST-NET-3：保留给文档的网段，**不可能是**本机回环地址（无副作用，不是真网段） */
  const E87_FORGED = '203.0.113.7';
  const E87_LOOPBACKS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

  const e87Calls = { retryPending: 0, listPending: 0, readJson: 0, buildReport: 0 };
  const e87Warns = [];
  const e87Clock = createClock({ mode: 'fixed', at: '2026-10-02T09:30:00' });
  const e87Reporter = {
    retryPending: async input => {
      e87Calls.retryPending++;
      return { ok: true, requested: 1, sent: 1, failed: 0, remaining: 0, input: input || {}, results: [] };
    },
    listPending: () => { e87Calls.listPending++; return []; },
    status: () => ({ mount: 'upload', pendingCount: 0, alert: { warn: false }, autoRetry: false }),
    buildReport: () => { e87Calls.buildReport++; return { ok: false, error: '本节只验重报闸，不组装报文' }; }
  };
  const e87Router = createRouterE87({ getHealth: () => ({ ok: true }), now: e87Clock.source() });
  /* 读体计数：**唯一**能把"拒绝发生在读体之前"证成的读数（不是看源码行号，见本节头注） */
  const e87ReadJsonOrig = e87Router.readJson.bind(e87Router);
  e87Router.readJson = async req => { e87Calls.readJson++; return e87ReadJsonOrig(req); };
  /* ---- **登录态那一半**（2026-10-05 同口径完整版）：判据真源＝`createAuth().verify()` ----
     与 §十七 `POST /notice` 用**同一个** `services/auth.js`（不另造第二套令牌）。
     一用例一库 ＋ 用完即删（`harness.makeTempDb`）。 */
  const dbApiE87 = require('../server/db');
  const { createAuth: createAuthE87 } = require('../server/services/auth');
  const e87Tmp = harness.makeTempDb({ name: 'e87-retry-auth' });
  dbApiE87.initSchema(e87Tmp.db, '2026-10-02 09:30:00');
  const E87_PW = 'Retry#2026';
  const e87Auth = createAuthE87({ db: e87Tmp.db, now: e87Clock.source(), silent: true, teamCode: '检验一班' });
  const E87_INIT = e87Auth.init({ code: e87Auth.initCode(), password: E87_PW, remote: '127.0.0.1' });
  const E87_LOGIN = e87Auth.login({ password: E87_PW, remote: '127.0.0.1' });
  const E87_TOKEN = (E87_LOGIN && E87_LOGIN.token) || '';

  /* **登录态就是这一支**：`auth` 必须注入；`isLoopback`/`remoteOf` 仍**不传** ⇒ 走真源 */
  const e87Mount = mountUploadE87(e87Router, {
    auth: e87Auth,
    reporter: e87Reporter,
    logger: { warn: m => e87Warns.push(String(m)), info: () => {}, error: () => {} },
    now: e87Clock.source()
  });

  /* `e87Forge` 非空 ⇒ 把**这一条**请求的 socket 来源改写成非回环（进程内伪造；用 defineProperty 建
     自有属性以遮蔽 `net.Socket.prototype` 上的取值器 —— 直接赋值在严格模式下会抛错）。 */
  let e87Forge = null;
  const e87Server = http.createServer((req, res) => {
    if (e87Forge) {
      Object.defineProperty(req.socket, 'remoteAddress', { value: e87Forge, configurable: true, enumerable: true });
    }
    Promise.resolve(e87Router.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
  });
  const e87Port = await harness.allocPort();
  await new Promise((resolve, reject) => {
    e87Server.once('error', reject);
    e87Server.listen(e87Port, '127.0.0.1', resolve);
  });
  const e87Post = async (body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;      // 空串/未传 ⇒ 完全不带头（"无令牌"形态）
    const r = await fetch(`http://127.0.0.1:${e87Port}/upload/retry`, {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: r.status, body: parsed, text };
  };
  const e87Get = async p => {
    const r = await fetch(`http://127.0.0.1:${e87Port}${p}`);
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: r.status, body: parsed, text };
  };

  try {
    t.check('E87-0 装配与判据真源（**同口径完整版的挂载形状**）：`mountUpload()` 自报 mounted:true 且注册 **4 条**' +
      '路由（含 `POST /upload/retry` —— 登录态是**加在既有路由上**，不动路由表）；' +
      '判据取**真源**：`services/auth.js` 的 `isLoopback()` 认三种回环写法、`routes/auth.js` 的 `remoteOf()` ' +
      '**只信 socket**（`X-Forwarded-For` 一律不信）、登录态走 `createAuth().verify()` ＋ `readBearer()`。' +
      '⚠ 本节装配**注入了 `auth`**（登录态那一半的真源），而 `isLoopback`/`remoteOf` 两个注入口**仍不传**（走生产同一真源路径）；' +
      '`auth` 是**必填** —— 缺失即写入口 fail-closed（503 `no_auth`），见 `E87-10/11/12`',
      e87Mount.mounted === true && e87Mount.routes.length === 4 &&
      e87Mount.routes.indexOf('POST /upload/retry') >= 0 &&
      Boolean(E87_INIT && E87_INIT.ok === true && E87_LOGIN && E87_LOGIN.ok === true) &&
      /^[0-9a-f]{64}$/.test(String(E87_TOKEN)) &&
      E87_LOOPBACKS.every(a => isLoopbackE87(a) === true) && isLoopbackE87(E87_FORGED) === false &&
      remoteOfE87({ socket: { remoteAddress: '10.0.0.9' }, headers: { 'x-forwarded-for': '127.0.0.1' } }) === '10.0.0.9' &&
      remoteOfE87({ headers: { 'x-forwarded-for': '127.0.0.1' } }) === '',
      `mounted=${e87Mount.mounted}；routes=[${e87Mount.routes.join(' , ')}]；` +
      `登录态真源：init.ok=${E87_INIT && E87_INIT.ok}／login.ok=${E87_LOGIN && E87_LOGIN.ok}／` +
      `令牌长度=${String(E87_TOKEN).length}（${E87_TOKEN ? E87_TOKEN.slice(0, 12) + '…' : '（无）'}）；` +
      `真源读数：isLoopback(${E87_LOOPBACKS.join('/')})=` +
      `${E87_LOOPBACKS.map(a => isLoopbackE87(a)).join('/')}、isLoopback(${E87_FORGED})=${isLoopbackE87(E87_FORGED)}；` +
      `remoteOf(伪造 XFF ＋ socket 10.0.0.9)=${JSON.stringify(remoteOfE87({ socket: { remoteAddress: '10.0.0.9' }, headers: { 'x-forwarded-for': '127.0.0.1' } }))}`);

    /* ---- 读数①（**同口径完整版**）：真回环 ＋ **有效会话令牌** ⇒ 200 且**真发一次**
       （正对照：防"把一切都拒了"也算完成"）。⚠ 令牌走 `Authorization: Bearer` —— 与 `/notice` 同一套。 ---- */
    if (!E87_TOKEN) {
      t.requires('E87 前提：进程内鉴权可初始化并取到有效会话令牌（回环 ＋ 登录态那一半的归因对象）',
        false, `init.ok=${E87_INIT && E87_INIT.ok}；login.ok=${E87_LOGIN && E87_LOGIN.ok}；token 长度=${String(E87_TOKEN).length}`);
    }
    const e87B1 = { ...e87Calls };
    const e87R1 = await e87Post({}, E87_TOKEN);
    const e87D1 = {
      retry: e87Calls.retryPending - e87B1.retryPending,
      read: e87Calls.readJson - e87B1.readJson,
      handled: e87Mount.counters.retryHandled, forbidden: e87Mount.counters.forbidden
    };
    t.check('E87-1 读数①（**真回环 ＋ 带令牌**，真 HTTP）：`POST /upload/retry`（`Authorization: Bearer <令牌>`）' +
      ' ⇒ **HTTP 200** ＋ `ok:true` ＋ `sent:1`，桩上 `retryPending()` 调用 **Δ=1**（回环 ＋ 已登录路径照旧真发送），' +
      '`counters.retryHandled` 如实为 1、`forbidden` 为 0',
      e87R1.status === 200 && e87R1.body && e87R1.body.ok === true && e87R1.body.sent === 1 &&
      e87D1.retry === 1 && e87D1.read === 1 && e87D1.handled === 1 && e87D1.forbidden === 0,
      `HTTP ${e87R1.status}；body=${JSON.stringify(e87R1.body)}；retryPending Δ=${e87D1.retry}、` +
      `readJson Δ=${e87D1.read}、counters=${JSON.stringify(e87Mount.counters)}`);

    /* ---- 读数②（负向对照·登录态那一半）：**回环 ＋ 无令牌／伪造令牌 ⇒ 401 `unauthorized`**，
       且 `retryPending()` **Δ=0**（"一条都没发"由**计数**证成，不是从 401 推出来的） ---- */
    const e87B2x = { ...e87Calls };
    const e87R2a = await e87Post({}, '');
    const e87D2a = { retry: e87Calls.retryPending - e87B2x.retryPending, read: e87Calls.readJson - e87B2x.readJson };
    t.check('E87-2 负向对照（**真回环 ＋ 无令牌**）：`POST /upload/retry` ⇒ **HTTP 401 `unauthorized`**' +
      '（与 `POST /notice` 同码同形），且桩上 `retryPending()` **Δ=0**、`counters.retryHandled` 不动' +
      ' —— 回环只回答"哪台机器"、不回答"谁"；缺登录态一律拒；`counters.unauthorized` 如实 +1',
      e87R2a.status === 401 && e87R2a.body && e87R2a.body.ok === false && e87R2a.body.error === 'unauthorized' &&
      e87R2a.body.err && e87R2a.body.err.code === 'unauthorized' && e87R2a.body.err.httpStatus === 401 &&
      e87D2a.retry === 0 && e87Mount.counters.retryHandled === 1 &&
      Number(e87Mount.counters.unauthorized) === 1,
      `HTTP ${e87R2a.status}；body=${JSON.stringify(e87R2a.body)}；retryPending Δ=${e87D2a.retry}（累计 ${e87Calls.retryPending}）；` +
      `counters=${JSON.stringify(e87Mount.counters)}`);

    const e87B2y = { ...e87Calls, warns: e87Warns.length };
    const e87R2b = await e87Post({}, 'f'.repeat(64));
    const e87D2b = { retry: e87Calls.retryPending - e87B2y.retryPending, read: e87Calls.readJson - e87B2y.readJson };
    t.check('E87-3 负向对照（**真回环 ＋ 伪造令牌**）：64 位 hex 但**不在任何会话里** ⇒ **401 `unauthorized`**、' +
      '`retryPending()` **Δ=0**、`counters.unauthorized` 再 +1（累计 2）—— 判据取**真源** `createAuth().verify()`' +
      '（不是本文件里"看着像令牌就放行"的第二种判断）',
      e87R2b.status === 401 && e87R2b.body && e87R2b.body.error === 'unauthorized' &&
      e87D2b.retry === 0 && e87Mount.counters.retryHandled === 1 &&
      Number(e87Mount.counters.unauthorized) === 2 &&
      e87Warns.length === e87B2y.warns + 1 && /未登录|令牌/.test(e87Warns[e87Warns.length - 1] || ''),
      `HTTP ${e87R2b.status}；body=${JSON.stringify(e87R2b.body)}；retryPending Δ=${e87D2b.retry}；` +
      `counters.unauthorized=${e87Mount.counters.unauthorized}；` +
      `被拒 warn 增量=${e87Warns.length - e87B2y.warns}（401 与 403 是两条不同的拒绝路径：401 不写 op_log、也不同 warn）`);

    /* ---- 读数③（原读数②）：**非回环 ＋ 有效令牌** ⇒ 403 且 retryPending／readJson 的增量**都为 0** ---- */
    e87Forge = E87_FORGED;
    const e87B2 = { ...e87Calls, warns: e87Warns.length };
    const e87R2 = await e87Post({}, E87_TOKEN);
    const e87D2 = {
      retry: e87Calls.retryPending - e87B2.retryPending,
      read: e87Calls.readJson - e87B2.readJson,
      warns: e87Warns.length - e87B2.warns,
      handled: e87Mount.counters.retryHandled, forbidden: e87Mount.counters.forbidden
    };
    t.check('E87-4 读数③（**来源闸**，非回环 ＋ 有效令牌）：伪造 `req.socket.remoteAddress=' + E87_FORGED + '` ⇒ **HTTP 403** ' +
      '`not_loopback`（`ok:false`／`error`／`err.code`／`remote`／`at` 齐全），且桩上 `retryPending()` **Δ=0** ' +
      '（"一条都没发"是**计数**证据，不是从 403 推出来的）、`counters.retryHandled` 未增、`counters.forbidden` ＋1',
      e87R2.status === 403 && e87R2.body && e87R2.body.ok === false && e87R2.body.error === 'not_loopback' &&
      Boolean(e87R2.body.err) && e87R2.body.err.code === 'not_loopback' && e87R2.body.err.httpStatus === 403 &&
      e87R2.body.remote === E87_FORGED && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(e87R2.body.at)) &&
      e87D2.retry === 0 && e87Calls.retryPending === 1 && e87D2.handled === 1 && e87D2.forbidden === 1,
      `HTTP ${e87R2.status}；body=${JSON.stringify(e87R2.body)}；retryPending Δ=${e87D2.retry}` +
      `（累计仍为 ${e87Calls.retryPending}，即只有读数①那一次）；retryHandled=${e87D2.handled}、forbidden=${e87D2.forbidden}`);

    t.check('E87-5 拒绝发生在**读请求体之前**（结构证据）：非回环请求下 `router.readJson()` 的调用增量 **Δ=0**' +
      ' —— 读体、入参校验、`retryPending()` 三步一步都没走到（"不发送"由此在结构上成立，而不只是"应答是 403"）',
      e87D2.read === 0 && e87Warns.filter(m => /非回环来源/.test(m)).length === 1 &&
      e87Warns.filter(m => /非回环来源/.test(m))[0].indexOf(E87_FORGED) >= 0,
      `readJson Δ=${e87D2.read}；` +
      `留痕口径（只 warn 不写 op_log）：被拒 warn Δ=${e87D2.warns}（每条被拒恰一条，含来源 IP）；` +
      `原文=${JSON.stringify(e87Warns[0] || '')}`);

    /* ---- 顺序证据：闸在**入参校验之前** —— 非回环 ＋ 非法入参（`limit:0`）必须仍是 403，而不是 400 ---- */
    const e87R3 = await e87Post({ limit: 0 }, E87_TOKEN);
    t.check('E87-6 顺序：非回环 ＋ **非法入参**（`limit:0`）仍落在来源闸上 ⇒ **403 `not_loopback`**（不是 400 `BAD_VALUE`），' +
      '且这条上 `retryPending` **Δ=0**、`readJson` **Δ=0**（拒在**读体之前** ⇒ 连入参校验都没走到）',
      e87R3.status === 403 && e87R3.body && e87R3.body.err && e87R3.body.err.code === 'not_loopback' &&
      e87Calls.retryPending === 1 && e87Calls.readJson === 1,
      `HTTP ${e87R3.status}／${e87R3.body && e87R3.body.err && e87R3.body.err.code}；` +
      `retryPending 累计=${e87Calls.retryPending}（仍只有读数①那一次）、readJson 累计=${e87Calls.readJson}`);

    /* ---- 范围证据：只读端点**未被牵连**（同一非回环来源仍 200） ---- */
    const e87B4 = e87Calls.listPending;
    const e87R4 = await e87Get('/upload/pending');
    t.check('E87-7 范围最小化：同一**非回环**来源下 `GET /upload/pending`（只读）仍 **200** 且 `ok:true`、' +
      '真的走了读口（`listPending` 被调用）—— 本包只收写入口，未把只读端点一起拒掉',
      e87R4.status === 200 && e87R4.body && e87R4.body.ok === true && e87Calls.listPending - e87B4 >= 1,
      `GET /upload/pending ⇒ HTTP ${e87R4.status}（非回环）；listPending 调用 Δ=${e87Calls.listPending - e87B4}`);

    /* ---- 口径：`counters` **不进任何 HTTP 响应体**（前端与契约不动；只在挂载对象上可读） ---- */
    const e87LeakKeys = ['counters', 'retryHandled', 'forbidden', 'noAuth'];
    const e87Leaks = [e87R1, e87R2a, e87R2b, e87R2, e87R3, e87R4].filter(r =>
      e87LeakKeys.some(k => r.text.indexOf('"' + k + '"') >= 0));
    t.check('E87-8 `counters`（**三档拒绝计数 ＋ 处理计数**：`forbidden`／`noAuth`／`unauthorized`／`retryHandled`）' +
      '**不进任何 HTTP 响应体**：200／401／403 三类应答与只读端点的' +
      '响应文本里都不出现这三个键 —— 计数只供自检与巡检读，前端契约不动（口径依据见 `forbiddenBody()` 的注释）',
      e87Leaks.length === 0 &&
      Object.keys(e87Mount.counters).sort().join(',') === 'forbidden,noAuth,retryHandled,unauthorized',
      `被检查的应答 ${[e87R1, e87R2a, e87R2b, e87R2, e87R3, e87R4].length} 条，含计数键的 ${e87Leaks.length} 条；` +
      `挂载对象上的 counters=${JSON.stringify(e87Mount.counters)}（可读，但不外泄到响应体）`);
  /* ---- ⓪ **合并**判据（`E87` 立案形态）：两条闸**同时**成立时，"非回环"这一支**先答** ----
     顺序由负责人 2026-10-05 裁定（**维持座位 3 的实现**）：**来源闸在登录态闸之前**。
     理由（裁定原文）：该入口的 403 **不写 `op_log`** ⇒ "LAN 有人在敲门"的**唯一签名**是
     `counters.forbidden` ＋ warn；401 在前会把这个签名**埋掉**（等于抹掉 `E87` 立案的那件事）。
     **"同口径" ＝ 同样具备两道闸，不是同样的先后。**
     这条把**非回环 ＋ 无令牌 ＋ 非法入参**三件一起喂进去：唯一正确的答案是 **403 `not_loopback`**
     —— 若答 400（先校入参）或 401（先判登录态、把来源闸那句话短路掉），都说明某一支被埋了。
     ⚠ **位置**：必须在 `try` **之内** —— `finally` 里已经把本节自建的 HTTP 服务关掉了，
     放到 `finally` 之后就是"对着已关闭的服务发请求"（实测 `TypeError: fetch failed` ⇒ 整份脚本异常退出）。 */
  const e87B5 = { ...e87Calls };
  const e87R5 = await e87Post({ limit: 0 }, '');
  t.check('E87-10 **合并判据**（非回环 ＋ 无令牌 ＋ 非法入参 `limit:0`）：答 **403 `not_loopback`**' +
    '（不是 400 `BAD_VALUE`、也不是 401 `unauthorized`）—— **来源闸先于登录态闸**（负责人裁定），' +
    '且 `retryPending` **Δ=0**、`counters.forbidden` 再 +1（"LAN 有人敲门"的签名不许被 401 埋掉）',
    e87R5.status === 403 && e87R5.body && e87R5.body.err && e87R5.body.err.code === 'not_loopback' &&
    e87Calls.retryPending - e87B5.retryPending === 0 && Number(e87Mount.counters.forbidden) === 3 &&
    Number(e87Mount.counters.unauthorized) === 2,
    `HTTP ${e87R5.status}；body=${JSON.stringify(e87R5.body)}；retryPending Δ=${e87Calls.retryPending - e87B5.retryPending}；` +
    `counters=${JSON.stringify(e87Mount.counters)}`);

  } finally {
    await new Promise(resolve => e87Server.close(resolve));
    try { e87Tmp.db.close(); } catch { /* 已关 */ }
    try { harness.removeLinkSafe(e87Tmp.dir, { recursive: true, force: true }); } catch { /* 已删 */ }
  }
  t.check('E87-14 本节自建的临时库跑完**当场删除**（一用例一库，不留残留）',
    !fs.existsSync(e87Tmp.dir),
    `${path.relative(env.paths.root, e87Tmp.dir)} 存在=${fs.existsSync(e87Tmp.dir)}`);
  t.check('E87-9 本节自建的 HTTP 服务跑完**当场关停**（不留监听端口/残留进程；伪造只发生在进程内）',
    e87Server.listening === false, `listening=${e87Server.listening}`);

  /* ---- `E87-11/12/13`：**缺 `auth` 注入的形态 = 行为级三条**（负责人 2026-10-05 裁定） ----
     ⚠ 判据**不得规定实现形状**（`E161` 口径）：所以这里**不**扫"有没有 `if (!auth…) throw`"这种静态正则，
     只判**行为**。为什么不是"挂载即抛"：本挂载**同时带三条只读端点**（UI-20 的读口）而**只有写路径**
     需要 auth ⇒ 挂载即抛会打掉无关读口（既有受管断言 `tests\db-check.js` 的"不抛、mounted:true"也会
     在挂载点直接异常退出、后续断言全丢）。故形态＝**fail-closed 只落在写入口上**：403/401 之后第三档
     **503 `no_auth`**，且**未读体、未调 `retryPending()`**。 */

  const e87NoAuthRouter = createRouterE87({ getHealth: () => ({ ok: true }), now: e87Clock.source() });
  const e87NoAuthCalls = { retryPending: 0, listPending: 0, readJson: 0 };
  const e87NoAuthReadJsonOrig = e87NoAuthRouter.readJson.bind(e87NoAuthRouter);
  e87NoAuthRouter.readJson = async req => { e87NoAuthCalls.readJson++; return e87NoAuthReadJsonOrig(req); };
  let e87NoAuthMount = null;
  let e87NoAuthMountThrew = null;
  try {
    e87NoAuthMount = mountUploadE87(e87NoAuthRouter, {
      /* ⚠ **刻意不传 `auth`** —— 这就是"部署时漏了注入"的现场形态 */
      reporter: {
        retryPending: async () => { e87NoAuthCalls.retryPending++; return { ok: true, sent: 1 }; },
        listPending: () => { e87NoAuthCalls.listPending++; return []; },
        status: () => ({ mount: 'upload', pendingCount: 0, alert: { warn: false }, autoRetry: false }),
        buildReport: () => ({ ok: false, error: '本节只验缺 auth 的形态' })
      },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      now: e87Clock.source()
    });
  } catch (e) { e87NoAuthMountThrew = e; }
  const e87NoAuthPost = await (async () => {
    const res = { status: null, text: '' };
    const req = {
      method: 'POST', url: '/upload/retry', headers: { 'Content-Type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]() {
        const chunks = [Buffer.from(JSON.stringify({}), 'utf8')];
        let i = 0;
        return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
      }
    };
    const r = {
      writeHead(s) { res.status = s; return this; },
      setHeader() { return this; }, write() { return true; },
      end(t) { res.text = t === undefined ? '' : String(t); return this; }, destroy() { return this; }
    };
    await e87NoAuthRouter.handle(req, r);
    let body = null;
    try { body = JSON.parse(res.text); } catch { body = null; }
    return { status: res.status, body, text: res.text };
  })();
  const e87NoAuthGet = await (async () => {
    const res = { status: null, text: '' };
    const req = { method: 'GET', url: '/upload/pending', headers: {}, socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true }) }; } };
    const r = {
      writeHead(s) { res.status = s; return this; },
      setHeader() { return this; }, write({ }) { return true; },
      end(t) { res.text = t === undefined ? '' : String(t); return this; }, destroy() { return this; }
    };
    await e87NoAuthRouter.handle(req, r);
    let body = null;
    try { body = JSON.parse(res.text); } catch { body = null; }
    return { status: res.status, body, text: res.text };
  })();
  t.check('E87-11 **缺 `auth` 注入 ⇒ 写入口 fail-closed**：`POST /upload/retry`（回环 ＋ 带体）⇒ ' +
    '**503 `no_auth`**，且 `retryPending()` **Δ=0**、`readJson()` **Δ=0**（未读体、未发送）—— ' +
    '"漏了注入"的现场形态**绝不放行**（这条替代原 `E87-S` 的静态正则：`E161` 口径 —— 判据只判行为，不规定实现形状）',
    e87NoAuthMountThrew === null &&
    e87NoAuthPost.status === 503 && e87NoAuthPost.body && e87NoAuthPost.body.ok === false &&
    (e87NoAuthPost.body.error === 'no_auth' || (e87NoAuthPost.body.err && e87NoAuthPost.body.err.code === 'no_auth')) &&
    e87NoAuthCalls.retryPending === 0 && e87NoAuthCalls.readJson === 0,
    `挂载抛出=${e87NoAuthMountThrew ? String(e87NoAuthMountThrew.message).slice(0, 100) : '（不抛 —— 裁定要求的形态）'}；` +
    `POST /upload/retry ⇒ HTTP ${e87NoAuthPost.status}／body=${JSON.stringify(e87NoAuthPost.body)}；` +
    `retryPending 调用=${e87NoAuthCalls.retryPending}、readJson 调用=${e87NoAuthCalls.readJson}（都应 0）`);

  t.check('E87-12 **缺 `auth` 注入 ⇒ 只读端点不受牵连**：同一挂载下 `GET /upload/pending`（UI-20 读口）仍 **200** ' +
    '且 `ok:true`、真的走了读口（`listPending` 被调用）—— fail-closed **只落在写路径**上；' +
    '理由：本挂载同时带三条只读端点，而只有写入口需要 auth ⇒ "挂载即抛"会打掉无关读口',
    e87NoAuthGet.status === 200 && e87NoAuthGet.body && e87NoAuthGet.body.ok === true &&
    e87NoAuthCalls.listPending >= 1,
    `GET /upload/pending ⇒ HTTP ${e87NoAuthGet.status}／ok=${e87NoAuthGet.body && e87NoAuthGet.body.ok}；listPending 调用=${e87NoAuthCalls.listPending}`);

  t.check('E87-13 **缺 `auth` 注入 ⇒ 挂载本身不抛**（`mounted:true`、四条路由照旧注册）：' +
    '`mountUpload()` 的返回形状与"注入了 auth"时**同形**，差别只在写入口的应答码（503 `no_auth`）—— ' +
    '这也是既有受管断言（`tests\db-check.js` §⑧ 的"不抛、mounted:true"）所依赖的形状',
    e87NoAuthMountThrew === null && Boolean(e87NoAuthMount) && e87NoAuthMount.mounted === true &&
    e87NoAuthMount.routes.length === 4 && e87NoAuthMount.routes.indexOf('POST /upload/retry') >= 0,
    `mounted=${e87NoAuthMount && e87NoAuthMount.mounted}；routes=[${(e87NoAuthMount ? e87NoAuthMount.routes : []).join(' , ')}]`);

  /* 因同批而暂红的条数：如实列出（代码侧落地后本节应回到全绿） */
  t.info('E87 同批窗口：本节判据已按"同口径完整版 ＋ 三档拒绝计数 ＋ 来源闸先行"改写 —— ' +
    '代码侧（server/http/routes/upload.js 的 401/503 两道闸 ＋ server/index.js 的 auth 注入 ＋ ' +
    'src/services/api.js 的令牌）落盘前，E87-1/2/3/4/5/6/7/8/10/11/12/13 中涉及令牌与计数的条会**暂红**。');
}

/* ---------------- 十九、E86①／ADR-0007：登录接线的端到端判据（**真进程 ＋ 真 HTTP**） ----------------
   立案：技术债 `E86①`（前端"解锁 ⇒ 服务端会话令牌"未接线）由 `T-20261002-15` 交付，其关闭条件是
        "**带令牌 `POST /notice` ⇒ 200 且库内 `notice` 恰 +1 行**"（路线图 `E86①` 原文）。此前该判据
        只在座位 3 的**探针**（`tests\._verify\seat3-t15-probe.js`，不进任何门禁）里跑过 ——
        探针会随 `._verify` 一起被清掉，等于"**交付了却从未被门禁验证**"（R-2026-09-19-02 的 P2-16）。
        本节把同样的读数**收进门禁**，期望值全部来自本包对真进程的**实测**（见回执的探针读数）。
   ⚠ 覆盖层级（**如实标注**，照 `ADR-0007` §D8⑤ 的先例）：
        · 本节的九条读数（未初始化／初始化／令牌／公告落库／无令牌与伪造／登出重放／锁定与到期／
          改密／留痕）**全部**在 `node server\index.js` 的**真子进程**上经**真 HTTP**（`fetch`）取得，
          库内读数用 `node:sqlite` 以只读连接直接读该子进程的数据目录；
        · **"锁定到期"不用注入时钟**：`createAuth({ now })` 只能在**进程内**注入，真进程读的是真实时钟，
          故到期一律由 **D2 明写的落库真源**（`auth_credential.locked_until` 置为过去时刻）复现 ——
          这不是绕过判据，而是"状态位的真源就是那一列"（ADR-0007 §D8⑨：可解析且在过去的 `locked_until` ⇒ 放行）。
          **注入时钟**那条路径（`advanceMin()` 推进到期、滑动续期、绝对上限）由 `db-check` 九之三
          在**服务层**覆盖，两者互补，本节不重复。
        · 非回环来源的拒绝（403 `not_loopback`）在真 HTTP 层造不出来（本机 `fetch` 恒为回环）
          ⇒ 该判据按 `ADR-0007` §D8⑤ 留在服务层探针，本节**不冒充**有它。
   一用例一库：本节的库是该子进程自己的数据目录（`harness.makeTempDir` 内），跑完连目录一起删。 */
t.section('十九、E86①／ADR-0007 登录接线的端到端判据（真子进程 ＋ 真 HTTP：未初始化／初始化／令牌／公告落库／登出／锁定／改密／留痕）');
{
  const { DatabaseSync } = require('node:sqlite');
  const AUTH_E2E_PW = 'Harness-Auth-E2E-2026';
  const AUTH_E2E_PW2 = 'Harness-Auth-E2E-New-2026';
  const AUTH_E2E_USER = 'admin';
  /* 「期满」用的过去时刻：D8⑨ 口径下"可解析且早已过期"⇒ 未锁定（放行） */
  const AUTH_E2E_PAST = '2000-01-01 00:00:00';
  /* 60 s：与 `startService` 的默认超时同量级；服务端装配（initSchema + auth 初始化码打印）在本机约 2～4 s */
  const AUTH_E2E_READY_MS = 60000;

  const a19DataDir = harness.makeTempDir('auth-e2e-data');
  const a19DbFile = path.join(a19DataDir, 'board.db');
  const a19Port = await harness.allocPort();
  const a19Svc = await harness.startService({
    script: require.resolve('../server/index.js'),
    args: ['--host', '127.0.0.1', '--port', String(a19Port), '--data-dir', a19DataDir],
    port: a19Port, readyPath: '/health', timeoutMs: 60000
  });

  /** 一次性初始化码：**只**能来自服务进程的启动日志（D4：仅内存、HTTP 层从不下发） */
  async function a19InitCode() {
    const deadline = Date.now() + AUTH_E2E_READY_MS;
    while (Date.now() < deadline) {
      const m = /本机一次性初始化码 = ([0-9a-f]{12})/.exec(a19Svc.output());
      if (m) return m[1];
      await new Promise(r => setTimeout(r, 150));
    }
    return '';
  }
  /** 真 HTTP：返回 `{status, body, text}`（解析失败时 body 记 `{raw}`，不静默吞） */
  async function a19Http(method, p, body, headers) {
    const init = { method, headers: Object.assign({ Accept: 'application/json' }, headers || {}) };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json;charset=UTF-8';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${a19Port}${p}`, init);
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed, text };
  }
  /** 库内只读读数（服务进程持 WAL 写锁不影响并发读；读连接用完即关） */
  function a19Ro(sql, params) {
    const db = new DatabaseSync(a19DbFile, { readOnly: true });
    try { return db.prepare(sql).all(...(params || [])); } finally { db.close(); }
  }
  /** 库内**写**真源（只为"锁定到期"复现状态位；`busy_timeout` 防与服务进程的采样写撞车） */
  function a19Rw(sql, params) {
    const db = new DatabaseSync(a19DbFile);
    try {
      db.prepare('PRAGMA busy_timeout = 8000').get();
      db.prepare(sql).run(...(params || []));
    } finally { db.close(); }
  }
  const a19NoticeCount = () => a19Ro('SELECT COUNT(*) AS c FROM notice')[0].c;
  const a19Cred = () => a19Ro('SELECT * FROM auth_credential WHERE username = ?', [AUTH_E2E_USER])[0] || null;

  try {
    const a19Code = await a19InitCode();
    t.requires('服务进程已在启动日志里打印一次性初始化码（D4 的"打印 + op_log"两条登记路径之一）',
      /^[0-9a-f]{12}$/.test(a19Code),
      `从 ${path.relative(env.paths.root, a19Svc.logFile)} 读到码=${a19Code ? a19Code.slice(0, 4) + '…' : '(无)'}`);
    /* 前提（D20）：负向/正向两条写库读数都以"新库 notice 为空"为基线 —— 这是**数据状态**的前提，
       不写成 check（否则"库里本来就有行"会被误报成实现缺陷）。 */
    const a19NStart = a19NoticeCount();
    t.requires('新库 `notice` 初始为 0 行（读数③/④ 的行数基线）', a19NStart === 0,
      `实测 notice 行数=${a19NStart}`);

    /* ---- 读数①（未初始化态，D4）：`/auth/status` 如实报未初始化；`/auth/login` 一律 409 ---- */
    const a19St0 = await a19Http('GET', '/auth/status');
    const a19Login0 = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW });
    t.check('E86①-1（未初始化态，D4）真 HTTP：`GET /auth/status` ⇒ 200 且 `initialized=false`／`initCodePending=true`；' +
      '`POST /auth/login` ⇒ **409 `not_initialized`**（不设默认口令 ⇒ 未初始化时任何口令都进不去）',
      a19St0.status === 200 && a19St0.body && a19St0.body.ok === true &&
      a19St0.body.initialized === false && a19St0.body.initCodePending === true &&
      a19Login0.status === 409 && a19Login0.body && a19Login0.body.error === 'not_initialized',
      `status=${a19St0.status} initialized=${a19St0.body && a19St0.body.initialized} ` +
      `initCodePending=${a19St0.body && a19St0.body.initCodePending}；login=${a19Login0.status} ${JSON.stringify(a19Login0.body)}`);

    /* ---- 读数②（初始化 ⇒ 登录 ⇒ 令牌）：本机回环 + 一次性码；库里只有派生值 ---- */
    const a19Init = await a19Http('POST', '/auth/init', { code: a19Code, password: AUTH_E2E_PW });
    const a19InitAgain = await a19Http('POST', '/auth/init', { code: a19Code, password: AUTH_E2E_PW });
    const a19Login = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW });
    const a19Token = a19Login.body && a19Login.body.token;
    const a19Cred0 = a19Cred();
    t.check('E86①-2（初始化 → 登录 → 令牌）真 HTTP：`POST /auth/init {code,password}`（**本机回环**）⇒ 200；' +
      '`POST /auth/login`（正确口令）⇒ 200 + **64 位 hex** 会话令牌；库内 `auth_credential` **恰一行**且**不含明文**' +
      '（`algo=scrypt`、`params=N=16384,r=8,p=1,keylen=32` 逐字照 ADR-0007 D1、`is_initial=1`）；' +
      '同一枚码**第二次**被拒（用后即废，D4）',
      a19Init.status === 200 && a19Init.body && a19Init.body.ok === true &&
      a19Login.status === 200 && a19Login.body && a19Login.body.ok === true &&
      /^[0-9a-f]{64}$/.test(String(a19Token)) &&
      Boolean(a19Cred0) && a19Cred0.algo === 'scrypt' &&
      a19Cred0.params === 'N=16384,r=8,p=1,keylen=32' && Number(a19Cred0.is_initial) === 1 &&
      JSON.stringify(a19Cred0).indexOf(AUTH_E2E_PW) < 0 &&
      ((a19InitAgain.status === 409 && a19InitAgain.body.error === 'already_initialized') ||
        (a19InitAgain.status === 401 && a19InitAgain.body.error === 'bad_init_code')),
      `init=${a19Init.status}；再 init=${a19InitAgain.status}:${a19InitAgain.body && a19InitAgain.body.error}；` +
      `login=${a19Login.status} token=${String(a19Token).slice(0, 12)}…(${String(a19Token).length})；` +
      `credential=${JSON.stringify({ username: a19Cred0 && a19Cred0.username, algo: a19Cred0 && a19Cred0.algo, params: a19Cred0 && a19Cred0.params, is_initial: a19Cred0 && a19Cred0.is_initial })}`);

    /* ---- 读数③（无令牌／伪造令牌 ⇒ 401 且**库内不增**）：负向对照，防"把一切都放行" ---- */
    const a19N0 = a19NoticeCount();
    const a19NoTok = await a19Http('POST', '/notice', { action: 'publish', content: '十九：无令牌', subType: '车间公示' });
    const a19Fake = await a19Http('POST', '/notice', { action: 'publish', content: '十九：伪造令牌', subType: '车间公示' },
      { Authorization: 'Bearer ' + 'f'.repeat(64) });
    const a19N1 = a19NoticeCount();
    t.check('E86①-3（负向对照）真 HTTP：`POST /notice` **无令牌**与**伪造令牌**一律 401 `unauthorized`，' +
      '且库内 `notice` 行数**逐次不变**（负向路径不写库 —— 判据是**行数**，不是"应答看起来像拒绝"）',
      a19NoTok.status === 401 && a19NoTok.body && a19NoTok.body.error === 'unauthorized' &&
      a19Fake.status === 401 && a19Fake.body && a19Fake.body.error === 'unauthorized' &&
      a19N1 === a19N0,
      `无令牌=${a19NoTok.status}:${a19NoTok.body && a19NoTok.body.error}；` +
      `伪造=${a19Fake.status}:${a19Fake.body && a19Fake.body.error}；notice 行数 ${a19N0} → ${a19N1}`);

    /* ---- 读数④（**E86① 的关闭条件**）：带令牌 ⇒ 200 且库内 notice 恰 +1 行、内容逐字落库 ---- */
    const a19BeforeOk = a19NoticeCount();
    const a19OkBody = { action: 'publish', content: '十九：E86① 关闭证据（带会话令牌写入的公告）', subType: '生产调整' };
    const a19Ok = await a19Http('POST', '/notice', a19OkBody, { Authorization: 'Bearer ' + a19Token });
    const a19AfterOk = a19NoticeCount();
    const a19Rows = a19Ro('SELECT id, sub_type, content FROM notice ORDER BY id');
    t.check('E86①-4 **关闭条件**：真 HTTP 下**带令牌 `POST /notice` ⇒ 200 且库内 `notice` 恰新增 1 行**' +
      '（内容逐字落库；这就是路线图 `E86①` 说的"令牌一接上即通"）',
      a19Ok.status === 200 && a19Ok.body && a19Ok.body.ok === true &&
      a19AfterOk === a19BeforeOk + 1 &&
      a19Rows.some(r => r.content === a19OkBody.content && r.sub_type === a19OkBody.subType),
      `POST /notice=${a19Ok.status}；行数 ${a19BeforeOk} → ${a19AfterOk}；` +
      `落库行=${JSON.stringify(a19Rows.map(r => ({ id: r.id, sub_type: r.sub_type, content: r.content })))}`);

    /* ---- 读数⑤（登出 ⇒ 同令牌立刻失效）：令牌的"即刻失效"必须能在**写库**上读到 ---- */
    const a19Logout = await a19Http('POST', '/auth/logout', {}, { Authorization: 'Bearer ' + a19Token });
    const a19Replay = await a19Http('POST', '/notice', { action: 'publish', content: '十九：登出后重放', subType: '车间公示' },
      { Authorization: 'Bearer ' + a19Token });
    const a19N3 = a19NoticeCount();
    t.check('E86①-5（登出即失效）真 HTTP：`POST /auth/logout` ⇒ 200 + `requireRelogin=true`；' +
      '**同一令牌重放**写公告 ⇒ 401 `unauthorized` 且库内**不再新增行**（令牌不是"标了个已登出"的摆设）',
      a19Logout.status === 200 && a19Logout.body && a19Logout.body.ok === true &&
      a19Logout.body.requireRelogin === true &&
      a19Replay.status === 401 && a19Replay.body && a19Replay.body.error === 'unauthorized' &&
      a19N3 === a19AfterOk,
      `logout=${a19Logout.status} ${JSON.stringify(a19Logout.body)}；重放=${a19Replay.status}:${a19Replay.body && a19Replay.body.error}；` +
      `notice 行数 ${a19AfterOk} → ${a19N3}`);

    /* ---- 读数⑥（改密 FR-8.4 / D5 / D8④）：原口令错 401；成功 ⇒ 换盐换派生值 + 清全部在途会话 ---- */
    const a19Tok2 = (await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW })).body.token;
    const a19ChBad = await a19Http('POST', '/auth/change', { oldPassword: 'not-the-old-one', newPassword: AUTH_E2E_PW2 },
      { Authorization: 'Bearer ' + a19Tok2 });
    const a19ChOk = await a19Http('POST', '/auth/change', { oldPassword: AUTH_E2E_PW, newPassword: AUTH_E2E_PW2 },
      { Authorization: 'Bearer ' + a19Tok2 });
    const a19OldLogin = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW });
    const a19NewLogin = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW2 });
    const a19Cred1 = a19Cred();
    t.check('E86①-6（改密 FR-8.4）真 HTTP：`POST /auth/change` **原口令错 ⇒ 401 `bad_credentials`**（且会话不清）；' +
      '改密成功 ⇒ 200 + `requireRelogin` + `sessionsCleared≥1`；**旧口令 401 / 新口令 200**；' +
      '库内 `is_initial` 由 1 变 0、`changed_by=设置页改密`、`salt`/`hash` 都已换新（换盐换派生值，不是改标记）',
      a19ChBad.status === 401 && a19ChBad.body && a19ChBad.body.error === 'bad_credentials' &&
      a19ChOk.status === 200 && a19ChOk.body && a19ChOk.body.requireRelogin === true &&
      Number(a19ChOk.body.sessionsCleared) >= 1 &&
      a19OldLogin.status === 401 && a19OldLogin.body && a19OldLogin.body.error === 'bad_credentials' &&
      a19NewLogin.status === 200 && /^[0-9a-f]{64}$/.test(String(a19NewLogin.body && a19NewLogin.body.token)) &&
      Boolean(a19Cred1) && Number(a19Cred1.is_initial) === 0 && a19Cred1.changed_by === '设置页改密' &&
      a19Cred1.salt !== a19Cred0.salt && a19Cred1.hash !== a19Cred0.hash,
      `原口令错=${a19ChBad.status}:${a19ChBad.body && a19ChBad.body.error}；改密=${a19ChOk.status} ${JSON.stringify(a19ChOk.body)}；` +
      `旧口令=${a19OldLogin.status}、新口令=${a19NewLogin.status}；换盐=${Boolean(a19Cred1) && a19Cred1.salt !== a19Cred0.salt}、` +
      `换派生值=${Boolean(a19Cred1) && a19Cred1.hash !== a19Cred0.hash}；is_initial=${a19Cred1 && a19Cred1.is_initial}、changed_by=${a19Cred1 && a19Cred1.changed_by}`);

    /* ---- 读数⑦（D2／D8①：第 5 次**当场** 423 + 剩余秒数；锁定期间口令正确也拒） ---- */
    const a19Fails = [];
    for (let i = 1; i <= 5; i++) a19Fails.push(await a19Http('POST', '/auth/login', { password: 'wrong-' + i }));
    const a19RightInLock = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW2 });
    const a19StLocked = await a19Http('GET', '/auth/status');
    const a19Cred2 = a19Cred();
    t.check('E86①-7（D2／D8①）真 HTTP：连续 5 次错口令 ⇒ 前 4 次 401 `bad_credentials`、**第 5 次当场** 423 `locked` ' +
      '＋正整数 `retryAfterSec`（≤ `lockMinutes×60`）；**锁定期间口令正确也拒**（仍 423）；计数**落库**' +
      '（`fail_count=5`、`locked_until` 非空）；`GET /auth/status` 无需鉴权即如实显示锁定（D8⑦）',
      a19Fails.slice(0, 4).every(r => r.status === 401 && r.body && r.body.error === 'bad_credentials') &&
      a19Fails[4].status === 423 && a19Fails[4].body && a19Fails[4].body.error === 'locked' &&
      Number.isInteger(a19Fails[4].body.retryAfterSec) && a19Fails[4].body.retryAfterSec > 0 &&
      a19Fails[4].body.retryAfterSec <= 300 &&
      a19RightInLock.status === 423 && a19RightInLock.body && a19RightInLock.body.error === 'locked' &&
      a19StLocked.status === 200 && a19StLocked.body && a19StLocked.body.locked === true &&
      a19StLocked.body.retryAfterSec > 0 &&
      Boolean(a19Cred2) && Number(a19Cred2.fail_count) === 5 &&
      typeof a19Cred2.locked_until === 'string' && a19Cred2.locked_until.length > 0,
      a19Fails.map((r, i) => `#${i + 1}=${r.status}` +
        `${r.body && r.body.retryAfterSec !== undefined ? '(' + r.body.retryAfterSec + 's)' : ''}`).join('/') +
      `；锁定中正确口令=${a19RightInLock.status}:${a19RightInLock.body && a19RightInLock.body.error}；` +
      `status.locked=${a19StLocked.body && a19StLocked.body.locked}/retryAfterSec=${a19StLocked.body && a19StLocked.body.retryAfterSec}；` +
      `库内 fail_count=${a19Cred2 && a19Cred2.fail_count}、locked_until=${a19Cred2 && a19Cred2.locked_until}`);

    /* ---- 读数⑧（D8②：期满**不自动清零** —— 期满后再错**一次**立即重锁） ----
       ⚠ "期满"由**库内真源**复现（真进程不能注入时钟，见本节头注）：把 `locked_until` 写到过去，
       服务进程下一次登录读到的就是"可解析且已过期"（D8⑨）⇒ 放行到口令校验那一步。 */
    let a19RwErr = '';
    try { a19Rw('UPDATE auth_credential SET locked_until = ? WHERE username = ?', [AUTH_E2E_PAST, AUTH_E2E_USER]); }
    catch (e) { a19RwErr = (e && e.message) || String(e); }
    const a19Cred3 = a19Cred();
    const a19WrongAfterExpiry = await a19Http('POST', '/auth/login', { password: 'still-wrong' });
    const a19Cred4 = a19Cred();
    t.check('E86①-8（D8②）真 HTTP：锁定**到期**（库内 `locked_until` 置为过去＝D8⑨ 的"可解析且已过期 ⇒ 放行"）后，' +
      '**再错一次立即重新锁定**（423 `locked`，`fail_count` 5→6、`locked_until` 回到未来）—— ' +
      '期满只是"可以再试"，**没有别的清零路径**（只有登录成功才清零）',
      a19RwErr === '' && Boolean(a19Cred3) && a19Cred3.locked_until === AUTH_E2E_PAST &&
      a19WrongAfterExpiry.status === 423 && a19WrongAfterExpiry.body && a19WrongAfterExpiry.body.error === 'locked' &&
      Boolean(a19Cred4) && Number(a19Cred4.fail_count) === Number(a19Cred3.fail_count) + 1 &&
      a19Cred4.locked_until !== AUTH_E2E_PAST,
      `库内写入=${a19RwErr || '无错'}；置过去后 locked_until=${a19Cred3 && a19Cred3.locked_until}；` +
      `期满后再错一次=${a19WrongAfterExpiry.status}:${a19WrongAfterExpiry.body && a19WrongAfterExpiry.body.error}；` +
      `fail_count ${a19Cred3 && a19Cred3.fail_count} → ${a19Cred4 && a19Cred4.fail_count}、locked_until=${a19Cred4 && a19Cred4.locked_until}`);

    /* ---- 读数⑨（期满 + 口令正确 ⇒ 恢复并清零）：与读数⑧ 成对，证明"清零只此一路" ---- */
    a19Rw('UPDATE auth_credential SET locked_until = ? WHERE username = ?', [AUTH_E2E_PAST, AUTH_E2E_USER]);
    const a19Recover = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW2 });
    const a19Cred5 = a19Cred();
    t.check('E86①-9（D2"成功即清零"）真 HTTP：锁定**到期** + 口令正确 ⇒ 200 登录成功，并**当场清零**' +
      '（`fail_count=0`、`locked_until=NULL`）—— 与读数⑧成对：清零路径只有"登录成功"这一条',
      a19Recover.status === 200 && a19Recover.body && a19Recover.body.ok === true &&
      /^[0-9a-f]{64}$/.test(String(a19Recover.body.token)) &&
      Boolean(a19Cred5) && Number(a19Cred5.fail_count) === 0 && a19Cred5.locked_until === null,
      `恢复登录=${a19Recover.status}；库内 fail_count=${a19Cred5 && a19Cred5.fail_count}、locked_until=${a19Cred5 && a19Cred5.locked_until}`);

    /* ---- 读数⑩（D6③：`op_log` 留痕六类各至少一条）—— 读**库内真行**，不是读日志文本 ---- */
    const a19Ops = a19Ro("SELECT op_type, result, COUNT(*) AS c FROM op_log GROUP BY op_type, result ORDER BY op_type");
    const a19OpTypes = a19Ops.map(r => `${r.op_type}/${r.result}×${r.c}`);
    const a19Has = (t2, res) => a19Ops.some(r => r.op_type === t2 && (res === undefined || r.result === res));
    t.check('E86①-10（D6③ 可审计）库内 `op_log`：**口令初始化码 / 口令初始化 / 解锁 / 解锁失败 / 账号锁定 / 改密 / 登出**' +
      '七类各至少一条（登出、账号锁定都在真 HTTP 路径上产生；来源 IP 记在 content 里 —— 本判据不读日志文本，只读库内真行）',
      a19Has('口令初始化码') && a19Has('口令初始化', '成功') && a19Has('解锁', '成功') &&
      a19Has('解锁失败', '失败') && a19Has('账号锁定', '失败') &&
      a19Has('改密', '成功') && a19Has('改密', '失败') && a19Has('登出', '成功'),
      `op_log 实读=${JSON.stringify(a19OpTypes)}`);

    /* ---- 收尾：本节自建的服务进程必须**当场关停**（不留监听端口/残留进程） ---- */
    await a19Svc.stop();
    t.check('E86①-11 本节自建的服务子进程跑完**当场关停**（不留监听端口与残留进程）',
      a19Svc.proc.exitCode !== null || a19Svc.proc.signalCode !== null,
      `exitCode=${a19Svc.proc.exitCode}、signalCode=${a19Svc.proc.signalCode}`);
  } finally {
    try { await a19Svc.stop(); } catch { /* 已停止 */ }
    try { harness.removeLinkSafe(a19DataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }); } catch { /* 已删 */ }
  }
}

/* ---------------- 二十、`E13` 定点回归（`E133`，2026-10-04）：`stripInlineMarkup()`／`scanPairContent()` ----------------
   立案（`E133`，座位 5 在 `C·21` 第 1 条报出）：`tests\docs-check.js:698` 把这两个纯函数**显式导出**、
   而 `:692` 的注释写着"**供定点回归在进程内直接调用**" —— 全仓（受管面）**没有任何断言调用它们**
   （只有 `docs-check` 自己的定义、自用与导出）⇒ 与 `C·20` 的 `F-2`（`pickDetailLines`／`resolveLedgerFile`
   零调用）**同形**：**注释声称的守据不存在**。危害不是"少几条断言"，而是 `E13` 的"已修复"
   **不可回潮检测**：把 `stripInlineMarkup()` 改成不剥（或改宽成"多剥"）、把 `scanPairContent()` 的
   `body.includes(…)` 改松，**门禁全绿**；而 `E13` 的立案事实正是"内联代码让同源断言由 41/2 → 40/3"。
   为什么落在 `harness-check` 而不是 `docs-check`：`docs-check` 的条数是**权威区已登记的口径**
   （46/2，其中 2 条是 6.4 已登记的历史提交偏差），往里塞断言会连带改权威数字与 `run-all` 的合计对账；
   而"给测试基建补定点回归"本来就是本脚本（**夹具自检**）的职责 —— `E109` 的先例（纯函数真值表）就在本文件。

   判据来源（**实测决定，不猜**）：`tools\md2docx.ps1` 的 `InlinePattern()`（`:175-177`）**只认**
   `` `代码` `` 与 `**粗体**`，`Runs()`（`:205-216`）把定界符丢掉、只写内容；`*斜体*`／`_下划线_`／
   `~~删除线~~` **不在**该正则里 ⇒ 定界符**原样进 docx**（`E13` 行给的建议②就是按这个事实剥标记）。
   本次我**自己复跑**了取证探针 `tests\._verify\t20261004-09\probe-multi-tick.js`（真跑 `md2docx.ps1`
   再读 `word/document.xml` 的 Heading 段），四组读数与 `stripInlineMarkup()` **逐字一致**：
     · 紧邻 ``` ``a`b`` ```    ⇒ docx `a`b`       ｜本函数 `a`b`
     · 松散 ``` `` a`b `` ```  ⇒ docx ` a`b `     ｜本函数 ` a`b `
     · 三反引号 ``` ```x``` ```⇒ docx `x`          ｜本函数 `x`
     · 双反引号 `` ``xy`` ``   ⇒ docx `xy`         ｜本函数 `xy`
   （⚠ **探针的打印缺陷一并留痕**：它只按"Heading 段的序号"对齐变体，而把 **H1 标题**也数进了 Heading
   ⇒ 打印出来的"工具读数"**错位一行**，于是每组都打印"【不一致】"。**错位是探针的打印缺陷、不是函数
   不一致** —— 上面四组是我按"H1 偏移 -1"重新对齐后的真读数。不修那支探针：它是本次的取证实物。）
   来源：`E133`（2026-10-04）。 */
t.section('二十、`E13` 定点回归（`E133`）：`docs-check` 两个纯函数的真值表 ＋ D22');
{
  const Module20 = require('node:module');
  const crypto20 = require('node:crypto');
  const sha20 = (b) => crypto20.createHash('sha256').update(b).digest('hex');
  const dcPath = path.join(env.paths.tests, 'docs-check.js');
  const dcBytes0 = fs.readFileSync(dcPath);
  const dcSha0 = sha20(dcBytes0);
  const dcText0 = dcBytes0.toString('utf8');
  const dc = require('./docs-check');           /* `require` 走 `require.main !== module` 的早退 ⇒ 不跑它的门禁 */
  const strip = dc.stripInlineMarkup;
  const scanPairs = dc.scanPairContent;
  const T = String.fromCharCode(96);            /* 反引号：样本一律**拼接构造**（本节自己不出现裸的反引号字面量） */

  /* ① 反引号**必剥**（`E13` 的原病灶：标题里的内联代码） */
  const tickCases = [
    ['A' + T + 'B' + T + 'C', 'ABC'],
    ['关键参数上传（' + T + 'PARAM_INFO_RECV' + T + '）', '关键参数上传（PARAM_INFO_RECV）'],
    [T + 'code' + T, 'code']
  ];
  const tickBad = tickCases.filter(([inp, want]) => strip(inp) !== want)
    .map(([inp, want]) => `${JSON.stringify(inp)} ⇒ ${JSON.stringify(strip(inp))}（应 ${JSON.stringify(want)}）`);
  t.check('E133-① 反引号**必剥**（真值表 3 组）：`` `代码` `` 的定界符必须消失、**内容逐字保留** —— ' +
    '这正是 `E13` 的原病灶（标题里的内联代码让同源断言 41/2 → 40/3）',
    tickBad.length === 0,
    tickBad.length ? `判红：${tickBad.join('；')}` : tickCases.map(([i, w]) => `${JSON.stringify(i)}⇒${JSON.stringify(w)}`).join('；'));

  /* ② `**` **必剥**（第二类被 `md2docx` 丢掉的定界符） */
  const star2Cases = [
    ['A**B**C', 'ABC'],
    ['**加粗词**在后', '加粗词在后'],
    ['**整串加粗**', '整串加粗']
  ];
  const star2Bad = star2Cases.filter(([inp, want]) => strip(inp) !== want)
    .map(([inp, want]) => `${JSON.stringify(inp)} ⇒ ${JSON.stringify(strip(inp))}（应 ${JSON.stringify(want)}）`);
  t.check('E133-② `**` **必剥**（真值表 3 组）：`**粗体**` 的定界符必须消失、内容逐字保留',
    star2Bad.length === 0,
    star2Bad.length ? `判红：${star2Bad.join('；')}` : star2Cases.map(([i, w]) => `${JSON.stringify(i)}⇒${JSON.stringify(w)}`).join('；'));

  /* ③ `*斜体*`／`_下划线_`／`~~删除线~~` **不剥** —— **防"多剥 ⇒ 假绿"**（`D23` 要求判据有判别力）。
     依据＝`md2docx.ps1` 的 `InlinePattern()` **只认**反引号与 `**`（工具侧实测：这三种标记原样进 docx）。
     多剥会让"md 写了标记、docx 真缺"的标题**假绿**（假阴性），与把判据改宽松同罪。 */
  const keepCases = [
    ['*斜体词*在后', '*斜体词*在后'],
    ['_下划线词_在后', '_下划线词_在后'],
    ['~~删除线词~~在后', '~~删除线词~~在后'],
    ['a*b', 'a*b']
  ];
  const keepBad = keepCases.filter(([inp, want]) => strip(inp) !== want)
    .map(([inp, want]) => `${JSON.stringify(inp)} ⇒ ${JSON.stringify(strip(inp))}（应原样 ${JSON.stringify(want)}）`);
  t.check('E133-③ `*斜体*`／`_下划线_`／`~~删除线~~` **一律不剥**（真值表 4 组，含孤立的 `*`）：' +
    '依据＝`md2docx.ps1` 的 `InlinePattern()` **只认**反引号与 `**`（工具侧实测这三种标记**原样进 docx**）' +
    '—— 多剥会让"md 写了标记而 docx 真缺"的标题**假绿**（与弱判据同罪，`D23`）',
    keepBad.length === 0,
    keepBad.length ? `判红：${keepBad.join('；')}` : keepCases.map(([i]) => `${JSON.stringify(i)}⇒原样`).join('；'));

  /* ④ 多反引号游程（n≥2 的收尾规则）——**期望值取自真跑 `md2docx.ps1` 的读数**，不是推导值。 */
  const multiCases = [
    ['紧邻：' + T + T + 'a' + T + 'b' + T + T, '紧邻：a' + T + 'b'],
    ['松散：' + T + T + ' a' + T + 'b ' + T + T, '松散： a' + T + 'b '],
    ['三反引号：' + T + T + T + 'x' + T + T + T, '三反引号：x'],
    ['双反引号简单：' + T + T + 'xy' + T + T, '双反引号简单：xy']
  ];
  const multiBad = multiCases.filter(([inp, want]) => strip(inp) !== want)
    .map(([inp, want]) => `${JSON.stringify(inp)} ⇒ ${JSON.stringify(strip(inp))}（应 ${JSON.stringify(want)}）`);
  t.check('E133-④ 多反引号游程（n≥2 的收尾规则，真值表 4 组）：游程 n 先按"下一个 **n** 连反引号"收尾、' +
    '收不到才退到单反引号 —— **期望值＝真跑 `md2docx.ps1` 读 `word/document.xml` 的实测读数**' +
    '（`tests\\._verify\\t20261004-09\\probe-multi-tick.js`，本次我复跑过），不是推导值',
    multiBad.length === 0,
    multiBad.length ? `判红：${multiBad.join('；')}` : multiCases.map(([i, w]) => `${JSON.stringify(i)}⇒${JSON.stringify(w)}`).join('；'));

  /* ⑤ 找不到配对 ⇒ **原样保留**（宁可判红也不吃掉可见文字 —— 与"少剥 ⇒ 假红"的取舍一致） */
  const unpairedCases = [
    [T + T + 'a', T + T + 'a'],
    ['a**b', 'a**b'],
    ['**粗体', '**粗体'],
    [T + '孤立', T + '孤立']
  ];
  const unpairedBad = unpairedCases.filter(([inp, want]) => strip(inp) !== want)
    .map(([inp, want]) => `${JSON.stringify(inp)} ⇒ ${JSON.stringify(strip(inp))}（应原样保留）`);
  t.check('E133-⑤ **找不到配对 ⇒ 原样保留**（真值表 4 组）：`` ``a ``／`a**b`／`**粗体`／`` `孤立 `` 一律不动 —— ' +
    '取舍＝"宁可判红（少剥）也不吃掉可见文字"（多剥才是假绿）',
    unpairedBad.length === 0,
    unpairedBad.length ? `判红：${unpairedBad.join('；')}` : unpairedCases.map(([i]) => `${JSON.stringify(i)}⇒原样`).join('；'));

  /* ⑥ `null`／`undefined`／空串**不炸**（纯函数要有全定义域：`docs-check` 的调用点传的是正则捕获组，
     捕不到时可能是 `undefined` —— 让它抛错会变成"脚本异常退 2"而不是一条干净的判红）。 */
  const edgeCases = [[null, ''], [undefined, ''], ['', ''], [0, '0']];
  const edgeBad = edgeCases.filter(([inp, want]) => strip(inp) !== want)
    .map(([inp, want]) => `${JSON.stringify(inp)} ⇒ ${JSON.stringify(strip(inp))}（应 ${JSON.stringify(want)}）`);
  t.check('E133-⑥ `null`／`undefined`／空串**不炸且返回空串**（真值表 4 组，含数字 `0` ⇒ `\'0\'`）：' +
    '调用点拿的是正则捕获组 ⇒ 必须有全定义域（抛错会变成"脚本异常退 2"，不是干净的判红）',
    edgeBad.length === 0,
    edgeBad.length ? `判红：${edgeBad.join('；')}` : edgeCases.map(([i, w]) => `${JSON.stringify(i)}⇒${JSON.stringify(w)}`).join('；'));

  /* ⑦ `scanPairContent()` 的定点回归 —— 用**受控输入副本**（`E116` 的口径：换"被测输入"，不改真产物）：
     把真实的一对 md/docx（`tools\Markdown转Word工具说明.md` ＋ 同名 docx，实测同源）复制进
     `._verify\t14-e133\pair\`，然后三组读数：
       (a) 原样副本        ⇒ `stale` 空（证明这对副本确实是同源对，基线干净）
       (b) 给某个 H2 的标题**套上反引号**（md 侧）⇒ **仍空**（证明"比对前剥标记"真在生效 —— 若把剥标记
           那一段删掉，这里立刻 `stale 1`）
       (c) 在 (b) 的标题末尾加一段 docx 里没有的字 ⇒ **`stale 1` 并指名该 docx 与缺的标题**
           （证明它不是恒绿：`body.includes(…)` 的强度没被弄松）
     用完**当场删掉**这个一次性目录并给"残留＝[]"（`E103` 的收尾同款）。 */
  const pairRoom = path.join(env.paths.verify, 't14-e133', 'pair');
  const realMd20 = path.join(env.paths.root, 'tools', 'Markdown转Word工具说明.md');
  const realDocx20 = realMd20.replace(/\.md$/, '.docx');
  const mdText20 = fs.readFileSync(realMd20, 'utf8');
  const firstH2 = (mdText20.match(/^##\s+(.+)$/m) || [])[1] || null;
  const writePair20 = (mdText) => {
    env.ensureDir(pairRoom);
    fs.writeFileSync(path.join(pairRoom, 'e133-pair.md'), mdText, 'utf8');
    fs.copyFileSync(realDocx20, path.join(pairRoom, 'e133-pair.docx'));
    return scanPairs([pairRoom]);
  };
  const pairReal20 = firstH2 === null ? null : writePair20(mdText20);
  const pairTick20 = firstH2 === null ? null
    : writePair20(mdText20.replace('## ' + firstH2, '## ' + T + firstH2 + T));
  const pairMiss20 = firstH2 === null ? null
    : writePair20(mdText20.replace('## ' + firstH2, '## ' + T + firstH2 + T + 'ZZQ'));
  let pairRoomRemoved20 = false;
  try { env.removeLinkSafe(pairRoom, { recursive: true, force: true }); } catch { /* 已删 */ }
  pairRoomRemoved20 = !fs.existsSync(pairRoom);
  t.check('E133-⑦ `scanPairContent()` 定点回归（**受控输入副本**）：`(a)` 真实同源对 ⇒ `stale＝[]`；' +
    '`(b)` 给 md 侧某个 H2 标题**套上反引号** ⇒ **仍 `stale＝[]`**（剥标记真在生效）；' +
    '`(c)` 末尾加 docx 里没有的字 ⇒ **`stale＝1` 并指名该 docx 与缺的标题**（不是恒绿）；一次性目录当场删除、残留＝[]',
    pairReal20 !== null && pairReal20.stale.length === 0 && pairReal20.pairs === 1
      && pairTick20 !== null && pairTick20.stale.length === 0 && pairTick20.pairs === 1
      && pairMiss20 !== null && pairMiss20.stale.length === 1
      && pairMiss20.stale[0].includes('e133-pair.docx') && pairMiss20.stale[0].includes('ZZQ')
      && pairRoomRemoved20,
    firstH2 === null ? '判红：受控副本的源 md 里找不到 `## ` 二级标题（`tools\\Markdown转Word工具说明.md` 结构变了 ⇒ 本判据的前提要跟着改）'
      : `(a) 原样：pairs=${pairReal20.pairs}／stale=${JSON.stringify(pairReal20.stale)}；` +
        `(b) 标题套反引号（「${firstH2}」）：pairs=${pairTick20.pairs}／stale=${JSON.stringify(pairTick20.stale)}；` +
        `(c) 末尾加「ZZQ」：stale=${JSON.stringify(pairMiss20.stale)}（应 1 且指名 e133-pair.docx）；` +
        `一次性目录已删＝${pairRoomRemoved20}（残留＝${fs.existsSync(pairRoom) ? '非空' : '[]'}）`);

  /* ⑧ D22（可证伪）：把"只剥反引号与 `**`"改成"**多剥** `_`／`~`"（**内存副本** `Module._compile`，
     盘上一个字节都不落）⇒ ③ 的期望**必被违反**（`_下划线词_在后` → `下划线词在后`），
     且 `tests\docs-check.js` 盘上字节**逐字节未变**（sha256 前后相同 + `Buffer.compare`）。
     为什么这条 D22 挑"多剥"：③ 守的正是"多剥 ⇒ 假绿"，而它最容易被人"顺手改宽"（`D23` 的静态防空洞）。 */
  const mutMutants = [
    ['const MD_INLINE_ANY = /[' + T + '*]/;', 'const MD_INLINE_ANY = /[' + T + '*_~]/;'],
    ['if (ch === MD_INLINE_TICK || ch === MD_INLINE_STAR) {', 'if (MD_INLINE_ANY.test(ch)) {']
  ];
  const applyMut20 = (src) => {
    let out = src;
    const applied = [];
    for (const [from, to] of mutMutants) {
      const hit = out.includes(from);
      applied.push(hit);
      if (hit) out = out.replace(from, to);
    }
    return { out, applied };
  };
  const { out: mutSrc20, applied: mutApplied20 } = applyMut20(dcText0);
  const loadVariant20 = (src) => {
    const m = new Module20(dcPath, null);
    m.filename = dcPath;
    m.paths = Module20._nodeModulePaths(path.dirname(dcPath));
    m._compile(src, dcPath);
    return m.exports;
  };
  let mutStrip20 = null;
  let mutLoadErr20 = '';
  try { mutStrip20 = loadVariant20(mutSrc20).stripInlineMarkup; } catch (e) { mutLoadErr20 = String((e && e.message) || e); }
  const mutUnder20 = mutStrip20 === null ? null : mutStrip20('_下划线词_在后');
  const mutTilde20 = mutStrip20 === null ? null : mutStrip20('~~删除线词~~在后');
  const dcBytes1 = fs.readFileSync(dcPath);
  const diskSame20 = Buffer.compare(dcBytes0, dcBytes1) === 0 && sha20(dcBytes1) === dcSha0;
  t.check('E133-⑧ D22（可证伪）：把"**只剥反引号与 `**`**"改成"**多剥 `_`／`~`**"' +
    '（`Module._compile` 级别的**内存副本**，盘上文件全程只读）⇒ ③ 的期望**必被违反**' +
    '（`_下划线词_在后` → `下划线词在后`、`~~删除线词~~在后` → `删除线词在后`）；而**原件**仍原样保留；' +
    '`tests\\docs-check.js` 盘上字节**逐字节未变**',
    mutApplied20.every(Boolean) && mutLoadErr20 === '' && mutSrc20 !== dcText0
      && strip('_下划线词_在后') === '_下划线词_在后' && strip('~~删除线词~~在后') === '~~删除线词~~在后'
      && mutUnder20 === '下划线词在后' && mutTilde20 === '删除线词在后' && diskSame20,
    `变异命中两处锚点=${JSON.stringify(mutApplied20)}、变异体 sha256=${sha20(Buffer.from(mutSrc20, 'utf8')).slice(0, 12)}…（原件 ${dcSha0.slice(0, 12)}…）；` +
    `变异体读数：'_下划线词_在后' ⇒ ${JSON.stringify(mutUnder20)}（应 '下划线词在后'）、'~~删除线词~~在后' ⇒ ${JSON.stringify(mutTilde20)}（应 '删除线词在后'）；` +
    `原件读数：${JSON.stringify(strip('_下划线词_在后'))}／${JSON.stringify(strip('~~删除线词~~在后'))}（应原样）；` +
    (mutLoadErr20 ? `⚠ 变异体载入失败：${mutLoadErr20}；` : '') +
    `盘上 docs-check.js 逐字节未变=${diskSame20}`);
}

/* ---------------- 二十一、真源分叉守护（`T-20261004-13`）：`server\` 下每个 `createStateSnapshot(` 调用点必须显式传 `config` ----------------
   立案（座位 3 在做 `E131`／`E132` 真进程端到端时实测坐实）：`server\index.js` 的 `start()` 里那一处
   `createStateSnapshot({ db, now, ingest, upload, logger })` **没传 `config`** ⇒ 它回落到磁盘上的
   `require('../src/config/board.config')`，于是**同一个进程里两份业务配置各管一半**：
     · 班次真源（`server\index.js` 的 `createShiftRules(boardCfg.shift)`）与 `/health.crossMidnight`
       用的是**注入的那一份**（`options.boardConfig`）；
     · `GET /state` 与 `/health.runAccum` 的当班统计用的是**磁盘上的那一份**。
   实测症状：注入夜班 22-6 ＋ 固定时钟 23:00 ⇒ `/health` 说 `allowed=true`，而 `/state` 的当班班次是
   磁盘配置里的「中班 16:00-24:00」—— **两个读数各自都"看着对"**，谁都不报错。
   为什么必须立静态判据（而不是靠"记得传"）：这与 `E110`（读数归属误导）／`E135`（症状指向错方向）
   同族，属 `D19` 的"看起来验过了"：注入式测试里**配置只改了一半**，而门禁是绿的。
   ⚠ 判据口径（宁紧不松）：①只扫**调用点**（`function createStateSnapshot(` 这种**声明**不算）；
   ②参数必须是**对象字面量**且**顶层**出现 `config` 键 —— 传一个不透明变量（`createStateSnapshot(opts)`）
   同样判红并说明理由（那正是"分叉"能溜进来的形态：静态上无法确认 `config` 在场）。
   ③剥注释与字符串后再判（`stripLiterals`：长度与换行不变 ⇒ 行号可直接当锚点），
   否则注释里那句"`config` 必须显式传"会把判据自己喂饱。 */
t.section('二十一、真源分叉守护：`server\\` 下 `createStateSnapshot(` 调用点必须显式传 `config`');
{
  const walkServerJs21 = (dir, out = []) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of list) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walkServerJs21(abs, out);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(abs);
    }
    return out;
  };
  /** **调用点解析（纯函数，单一真源）**：源码 ⇒ 每个 `createStateSnapshot(` **调用点**的
   *  `{line, argsStart, argsEnd, argsText, opaque, keys, configKeySpan, hasConfig}`。
   *  ⚠ `T-20261005-15`（主代理批准的重钉）：把**解析**与**判定**拆开 —— 这样 D22 就能按**符号/内容**
   *  定位"某调用点自己的 `config` 键"再从内存副本里摘掉，而**不再**按"第一条 `config: boardCfg,` 文本行"
   *  （那条同形行可能属于**别的**对象字面量 ⇒ 实测踩过：座位 3 给 `mountUpload({...})` 补了 `config` 之后，
   *  旧写法摘掉的是**别处**那一行 ⇒ 期望的"1 处"变成 0 处 ⇒ **假红**）。
   *  坐标口径：`argsStart`＝`(` 的下标、`argsEnd`＝配对 `)` 的下标；`stripLiterals` **长度守恒**
   *  ⇒ 同一坐标可直接用于**原样字节**。 */
  const snapshotCallSites21 = (relPath, src) => {
    const code = stripLiterals(src);
    const out = [];
    const re = /(^|[^\w$.])createStateSnapshot(\s*)\(/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const identStart = m.index + m[1].length;                /* 标识符的起点（`m[1]` 是前导分隔符） */
      if (/function\s+$/.test(code.slice(0, identStart))) continue;   // 函数**声明**，不是调用点
      const openIdx = identStart + 'createStateSnapshot'.length + m[2].length;   // `(` 的下标
      const line = code.slice(0, openIdx).split('\n').length;
      let depth = 0;
      let end = -1;
      for (let i = openIdx; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      const argsEnd = end < 0 ? code.length - 1 : end;
      const argsText = code.slice(openIdx + 1, argsEnd);
      const trimmed = argsText.trim();
      const site = {
        relPath, line, argsStart: openIdx, argsEnd, argsText,
        opaque: !trimmed.startsWith('{'), keys: [], configKeySpan: null, hasConfig: false
      };
      if (!site.opaque) {
        /* 取**顶层**键（跳过嵌套的括号/花括号/方括号里的逗号）：先把最外层那对花括号摘掉，
           否则第一个 `{` 自己就把深度抬到 1、顶层逗号全被当成嵌套（**实测踩过**：第一版把
           `[{` 报成了"顶层键"）。顺带把每个键在**原文**里的区间算出来（供 D22 精确摘除）。 */
        const trimmedAt = argsText.indexOf(trimmed);
        const braceAt = trimmed.startsWith('{') ? 1 : 0;
        const inner = trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed.slice(1, -1) : trimmed;
        const innerBase = openIdx + 1 + trimmedAt + braceAt;   /* `inner` 在 src 里的起点 */
        const spans = [];
        let d = 0;
        let start = 0;
        for (let i = 0; i < inner.length; i++) {
          const ch = inner[i];
          if ('([{'.includes(ch)) d++;
          else if (')]}'.includes(ch)) d--;
          if (ch === ',' && d === 0) { spans.push([start, i]); start = i + 1; }
        }
        spans.push([start, inner.length]);
        site.keys = spans.map(([a, b]) => inner.slice(a, b));
        const ci = spans.findIndex(([a, b]) => {
          const t = inner.slice(a, b).trim();
          return /^config\s*:/.test(t) || t === 'config';
        });
        if (ci >= 0) {
          site.hasConfig = true;
          const [a, b] = spans[ci];
          const seg = inner.slice(a, b);
          const leadWs = seg.length - seg.trimStart().length;
          const startAt = innerBase + a + leadWs;
          /* 末键 ⇒ 摘到键尾；否则摘到**下一个顶层键的起点**（连它后面那个逗号一起去掉） */
          const endAt = ci < spans.length - 1 ? innerBase + spans[ci + 1][0] : innerBase + b;
          site.configKeySpan = [startAt, endAt];
        }
      }
      out.push(site);
    }
    return out;
  };
  /** 判据（**纯函数**，供 D22 复用）：返回违规清单（空＝合规）。**文案与拆分前逐字相同**。 */
  const scanSnapshotConfig21 = (relPath, src) => snapshotCallSites21(relPath, src).flatMap((s) => {
    if (s.opaque) {
      const trimmed = s.argsText.trim();
      return [`${relPath}:${s.line} —— 实参不是对象字面量（\`${trimmed.slice(0, 40) || '（空）'}\`）⇒ ` +
        '静态上无法确认 `config` 在场（不透明变量正是"配置分叉"能溜进来的形态）'];
    }
    if (s.hasConfig) return [];
    return [`${relPath}:${s.line} —— 顶层没有 \`config\` 键（实参顶层键＝[` +
      s.keys.map(k => (k.split(':')[0] || '').trim()).filter(Boolean).join(', ') +
      ']）⇒ 该调用点会回落到**磁盘上的** `board.config.js`，与注入的配置分叉'];
  });
  const serverJs21 = walkServerJs21(path.join(env.paths.root, 'server'));
  const relOf21 = (abs) => path.relative(env.paths.root, abs).split(path.sep).join('\\');
  const callSites21 = [];
  const bad21 = [];
  for (const f of serverJs21) {
    const src = fs.readFileSync(f, 'utf8');
    const code = stripLiterals(src);
    const n = (code.match(/(^|[^\w$.])createStateSnapshot(\s*)\(/g) || []).length;
    const decl = (code.match(/function\s+createStateSnapshot(\s*)\(/g) || []).length;
    if (n > decl) callSites21.push(`${relOf21(f)}×${n - decl}`);
    for (const b of scanSnapshotConfig21(relOf21(f), src)) bad21.push(b);
  }
  t.check('T-20261004-13 静态守护：`server\\**\\*.js` 里每个 `createStateSnapshot(` **调用点**都显式传 `config`' +
    '（顶层键；剥注释与字符串后判）—— 缺一处 ⇒ 红并**指名 `文件:行号`**；传不透明变量同样判红',
    serverJs21.length > 0 && callSites21.length > 0 && bad21.length === 0,
    bad21.length ? `判红 ${bad21.length} 处：${bad21.join('；')}`
      : `零违规（扫 ${serverJs21.length} 个 server .js；调用点 ${callSites21.join('、')}；` +
        '每一处顶层都有 `config` 键 ⇒ 注入的配置与磁盘配置不会各管一半）');

  /* D22（可证伪，`T-20261005-15` **按符号/内容重钉**）：从**第一个带 `config` 键的调用点**的实参里，
     把这个**顶层 `config` 键的区间**（含其后那个逗号）从**内存副本**摘掉 ⇒ 同一判据**必红并把该调用点
     指名到 `server\index.js:行号`**；盘上文件**逐字节未变**。
     ⚠ 为什么不能按"第一条 `config: boardCfg,` 文本行"摘（旧写法）：那条同形行可能属于**别的**对象字面量
     ⇒ 实测踩过一次**假红**（座位 3 给别的调用点补了 `config` 之后，摘掉的是别处那一行 ⇒ 期望的 1 处变 0 处）。
     ⇒ 现在先按**同一个解析器**定位调用点与它自己的键，再摘 —— **不写死行号、也不写死值**。
     ⚠ 前提（不许静默通过）：盘上**至少有一处**调用点带 `config` 键；一处都没有 ⇒ 判红（本 D22 无从谈起）。 */
  {
    const idxPath = path.join(env.paths.root, 'server', 'index.js');
    const idxBytes0 = fs.readFileSync(idxPath);
    const sha = (b) => require('node:crypto').createHash('sha256').update(b).digest('hex');
    const sha0 = sha(idxBytes0);
    const src0 = idxBytes0.toString('utf8');
    const sites21 = snapshotCallSites21(relOf21(idxPath), src0);
    const withCfg21 = sites21.filter(s => s.hasConfig && s.configKeySpan);
    const curBad21 = scanSnapshotConfig21(relOf21(idxPath), src0);
    const target21 = withCfg21[0] || null;
    const mutSrc21 = target21
      ? src0.slice(0, target21.configKeySpan[0]) + src0.slice(target21.configKeySpan[1])
      : src0;
    const mutBad21 = target21
      ? scanSnapshotConfig21(relOf21(idxPath), mutSrc21)
      : ['（前提不成立：`server\\index.js` 里找不到带顶层 `config` 键的调用点）'];
    const idxBytes1 = fs.readFileSync(idxPath);
    t.check('T-20261004-13 D22（可证伪，`T-20261005-15` **按符号/内容重钉**）：从**第一个带 `config` 键的 '
      + '`createStateSnapshot(` 调用点**的实参里，把这个**顶层 `config` 键的区间**从**内存副本**摘掉 ⇒ '
      + '同一判据**必红并把该调用点指名到 `server\\index.js:行号`**（**不写死行号、也不写死值**）；'
      + '现行源码零违规；盘上 `server\\index.js` 逐字节未变',
      withCfg21.length > 0 && curBad21.length === 0 && mutBad21.length === 1
        && mutBad21[0].includes('server\\index.js:' + (target21 ? target21.line : ''))
        && Buffer.compare(idxBytes0, idxBytes1) === 0 && sha(idxBytes1) === sha0,
      `调用点 ${sites21.length} 处（带顶层 \`config\` 键 ${withCfg21.length} 处`
        + `${target21 ? `，目标＝server\\index.js:${target21.line}` : ''}）；`
        + `现行源码违规 ${curBad21.length} 处（应 0）；内存摘掉**目标调用点自己的** \`config\` 键后 `
        + `${mutBad21.length} 处：${mutBad21.join('；')}；`
        + `盘上 server\\index.js 逐字节未变=${Buffer.compare(idxBytes0, idxBytes1) === 0}（sha256=${sha0.slice(0, 12)}…）`);
  }
}

/* ---------------- 二十二、`E129` 取数上限／`E166`／`E167`／`E170`（4b 的 `T-20261005-12`） ----------------
   【本节四件事与"为什么"（逐条对应 `项目记录\后续路线图.md` 的债行）】
    ① `E129` 门禁断言：`statsForShift()` 的窗口取数**不得含行数上限**。旧实现
       `ORDER BY id DESC LIMIT 1000`（`C·25` 复核实测：改前 `runSec` 钉在 999、改后 1999）
       会让"**算不全**"与"**真的只有 1000 帧**"读数**完全一样** ⇒ `FR-4.11`（当班有效运行时长）
       与 `FR-4.15`（设备稼动率）两个 **P0** 静默偏低（`E38` 同族：没算全却显示成一个数）。
       候选＝**SQL 字面量**里同时含 `FROM measure_rt` 与 `collect_time` 比较谓词的 **SELECT**
       （`C·25` 第②面给的口径）。
       ⚠ **必须排除"邻接单行"**（`C·25` 明确点名的坑）：`SELECT collect_time AS collectTime FROM
       measure_rt WHERE collect_time < ? ORDER BY collect_time DESC LIMIT 1` 是"**早于本帧的最近一条**"
       的**语义**（`server\index.js` 的 `previousFrameShiftOf()`，重启后回读"上次所见班次"用）——
       ⚠ **别把行号写进判据**（`E134`／`E147`：行号会漂）：`C·25` 立此例时那条语句在 `:1329`，
       盘上实测已因别的改动漂到 `:1336` ⇒ 本判据只按**形态**判，**现算行号**一律打进读数。
       那里的 `LIMIT 1` 是**语义**、不是截断。⇒ 判据把"**单边谓词 ＋ ORDER BY ＋ LIMIT 1**"整类排除，并把被排除的每一处
       **逐条打出来**（`E161` 的教训：**排除必须看得见**，否则"排除"会退化成"看不见"）。
    ② `E170` 的 D22：`E166` 的首选修法（给 `measure_rt(collect_time)` 加索引）**必须可证伪** ——
       判据读 `EXPLAIN QUERY PLAN`（**内存** `:memory:` 库 ＋ 盘上 `server\db\schema.sql` 的 DDL 现读），
       要求窗口查询的计划**用上** `ix_measure_rt_collect_time` 且**不是** `SCAN measure_rt`；
       D22 在**内存里**把索引去掉（`DROP INDEX` ＋ 从 schema 文本摘掉那一行）⇒ 同一判据**必红并指名
       `SCAN measure_rt`**；负对照＝现行盘上 schema ⇒ **必绿**。另复核**老库路径**：
       `server\db\index.js` 的 `STRUCTURE_UPGRADES` 必须带**幂等**建索引步骤（同批三件之一）。
    ③ `E167` 的断言：**探针调用不消耗生产告警名额** ＋ **计数不去重**（`E146`／`T-20261004-19` 的既有分工）。
       判据与生产**同一个纯函数**（`measureWindowDensity()`）；"这一窗报过没有"按**快照实例**记账
       （`SNAPSHOT_WARN_SETS`）。对照＝**真旧字节**（`git show 030f76e^:server/services/stateSnapshot.js`，
       模块顶层 `Set` ＋ 导出函数里告警）**在内存里编译**后跑**同一场景** ⇒ 探针先调则生产**一条都不响**
       （改前会红）；现行 ⇒ 生产照响（改后绿）。
    ④ 残留与盘上字节：本节所有变异**一律只在内存**；每个 D22 都给"盘上逐字节未变（`Buffer.compare`
       ＋ sha256）"与"判据在盘上原件上的残留"读数。
   【扫描面与口径（显式声明，不是顺手扩大）】
    · `E129-①` 的面＝`server\**\*.js` —— 生产**取数面**：`E129` 的病灶（`services/stateSnapshot.js`）
      与 `C·25` 给的反例（`server/index.js` 的 `previousFrameShiftOf()`）都在这一面；前端 `src\` 无 SQL，`._verify\` 面是探针家。
    · `E161-D①` 的 shell 形态判据在第五节自己的块里（面＝受管面，含生产），本节只复述其读数。
   【不改判据迎合】：本节**只新增**断言，一个既有断言的式子都没动；
    若权威区（`tests\README.md` 第三节）的声明数字与本节实跑不一致，按 `9.5-5` 报"声明≠实跑"，
    由权威区同步，**不**改判据去凑。 */
t.section('二十二、`E129` 取数上限／`E170` 索引计划／`E167` 告警名额与计数（`T-20261005-12`）');
{
  const crypto22 = require('node:crypto');
  const Module22 = require('node:module');
  const { DatabaseSync } = require('node:sqlite');
  const dbApi22 = require('../server/db');
  const snapSvc22 = require('../server/services/stateSnapshot');
  const sha256hex22 = (b) => crypto22.createHash('sha256').update(b).digest('hex');
  const Q22 = String.fromCharCode(39);
  const relOf22 = (abs) => path.relative(env.paths.root, abs).split(path.sep).join('\\');
  const read22 = (abs) => fs.readFileSync(abs, 'utf8');
  const lineOf22 = (src, idx) => src.slice(0, idx).split('\n').length;
  const attempt22 = (fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, err: String((e && e.message) || e) }; } };
  const clock22 = createClock({ mode: 'fixed', at: '2026-09-19T12:00:00' });
  const shiftRules22 = createShiftRules(boardConfig.shift.list);
  const SRC_SNAPSHOT_REL22 = 'server\\services\\stateSnapshot.js';
  const SRC_SNAPSHOT_ABS22 = path.join(env.paths.root, 'server', 'services', 'stateSnapshot.js');
  const SCHEMA_REL22 = 'server\\db\\schema.sql';
  const SCHEMA_ABS22 = path.join(env.paths.root, 'server', 'db', 'schema.sql');

  /* ==================== 共用 1：字面量跨度扫描（判据的"地面"） ====================
     为什么要自己扫一遍"哪些字符在字面量里"：SQL 一律写在引号/模板串里，而 `stripLiterals()`
     把**内容**blank 掉（连引号一起）⇒ 从剥后文本里读不到 SQL。故这里只做**边界**：
     与 `tests\lib\assert.js` 的 `stripLiterals()` **同一套状态机**（含 `isRegexStart` 那一步，
     为的是不把正则里的引号当成字符串起点），并**交叉自证**：凡进入判据的字面量，其区间内
     "非空白的原样字符"必须都被 `stripLiterals()` blank 掉（否则本判据的"边界"就错了 ⇒ 只报不判）。
     ⚠ 判据本体（`scanWindowQueryCap22`）与 D22 **共用这一个函数**（`E153` 的教训）。 */
  const isRegexStart22 = (out, i) => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    if (k < 0) return true;
    if ('([{,;:=!&|?+-*%~^<>'.includes(out[k])) return true;
    let w = k;
    while (w >= 0 && /[A-Za-z_$]/.test(out[w])) w--;
    return /^(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/
      .test(out.slice(w + 1, k + 1));
  };
  /** 返回 `[{start,end,quote}]`（**含引号本身**；`end` 是闭合引号的下标）。
   *  未闭合的字面量止于行尾（与 `stripLiterals` 的容错同一口径）；正则只用来"跳过"，不产出跨度。 */
  const literalSpans22 = (src, stripped) => {
    const spans = [];
    const stack = [];
    let mode = 'code';
    let start = -1;
    let quote = '';
    const close = (end) => { if (start >= 0) spans.push({ start, end, quote }); start = -1; quote = ''; };
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src[i];
      const c2 = src[i + 1];
      if (mode === 'code') {
        if (c === '/' && c2 === '/') { mode = 'line'; i += 2; continue; }
        if (c === '/' && c2 === '*') { mode = 'block'; i += 2; continue; }
        if (c === Q22 || c === '"' || c === '`') {
          start = i; quote = c; mode = c === '`' ? 'tpl' : (c === Q22 ? 'sq' : 'dq'); i++; continue;
        }
        if (c === '/' && isRegexStart22(stripped, i)) { mode = 're'; i++; continue; }
        if (stack.length) {
          if (c === '{') stack[stack.length - 1].braces++;
          else if (c === '}') {
            if (stack[stack.length - 1].braces === 0) { stack.pop(); mode = 'tpl'; }
            else stack[stack.length - 1].braces--;
          }
        }
        i++; continue;
      }
      if (mode === 'line') { if (c === '\n') mode = 'code'; i++; continue; }
      if (mode === 'block') { if (c === '*' && c2 === '/') { mode = 'code'; i += 2; continue; } i++; continue; }
      if (mode === 'sq' || mode === 'dq') {
        const q = mode === 'sq' ? Q22 : '"';
        if (c === '\\') { i += 2; continue; }
        if (c === q) { close(i); mode = 'code'; i++; continue; }
        if (c === '\n') { close(i - 1); mode = 'code'; i++; continue; }     /* 未闭合：止于行尾 */
        i++; continue;
      }
      if (mode === 'tpl') {
        if (c === '\\') { i += 2; continue; }
        if (c === '`') { close(i); mode = 'code'; i++; continue; }
        if (c === '$' && c2 === '{') { stack.push({ braces: 0 }); mode = 'code'; i += 2; continue; }
        i++; continue;
      }
      if (mode === 're') {
        if (c === '\\') { i += 2; continue; }
        if (c === '[') { mode = 'reclass'; i++; continue; }
        if (c === '/') { mode = 'code'; i++; continue; }
        if (c === '\n') { mode = 'code'; i++; continue; }
        i++; continue;
      }
      /* mode === 'reclass' */
      if (c === '\\') { i += 2; continue; }
      if (c === ']') { mode = 're'; i++; continue; }
      i++; continue;
    }
    if (start >= 0) close(n - 1);
    return spans;
  };

  /* ==================== 共用 2：`E129` 的判据（纯函数；主断言与 D22 同一把尺子） ====================
     · 候选＝以 `SELECT` 起头、含 `FROM measure_rt`、且含 `collect_time` **比较谓词**的字面量；
     · 上限＝候选里任何 `LIMIT <数字|?|插值>` 子句；
     · 排除＝"单边 `collect_time` 谓词 ＋ `ORDER BY` ＋ `LIMIT 1`"＝**邻接单行**（`server\index.js` 的 `previousFrameShiftOf()` 的语义）；
     · 含模板插值的字面量**不判红**（静态判据看不见内容）⇒ 归入 `undecided` **并逐条报出**。 */
  const CT_CMP22 = /collect_time\s*(?:>=|<=|<>|!=|>|<|=|BETWEEN)/i;
  const scanWindowQueryCap22 = (rel, src) => {
    const stripped = stripLiterals(src);
    const spans = literalSpans22(src, stripped);
    const candidates = [];
    const violations = [];
    const adjacency = [];
    const undecided = [];
    for (const sp of spans) {
      const text = src.slice(sp.start + 1, sp.end);
      if (!/\bFROM\s+measure_rt\b/i.test(text)) continue;
      const line = lineOf22(src, sp.start);
      if (text.includes('${')) {
        undecided.push({ rel, line, why: '含模板插值（动态 SQL ⇒ 静态判据看不见内容）', sql: text.trim().slice(0, 120) });
        continue;
      }
      if (!/^\s*SELECT\b/i.test(text)) continue;                      /* 只判取数（SELECT），不判 DELETE 之类 */
      if (!CT_CMP22.test(text)) continue;                             /* 不按 collect_time 取数 ⇒ 不是候选 */
      /* 地面自证：区间内的非空白原样字符必须都被 `stripLiterals()` blank（否则边界错了 ⇒ 不判红） */
      const rawSeg = src.slice(sp.start, sp.end + 1);
      const strSeg = stripped.slice(sp.start, sp.end + 1);
      let ground = true;
      for (let k = 0; k < rawSeg.length; k++) {
        if (!/\s/.test(rawSeg[k]) && !/\s/.test(strSeg[k])) { ground = false; break; }
      }
      if (!ground) {
        undecided.push({ rel, line, why: '字面量边界与 `stripLiterals()` 的地面不符（本判据不判这一处）', sql: text.trim().slice(0, 120) });
        continue;
      }
      const caps = [];
      const capRe = /\bLIMIT\s+(\d+|\?|\$\{[^}]*\})/gi;
      let mc;
      while ((mc = capRe.exec(text))) {
        caps.push({ txt: mc[0].replace(/\s+/g, ' '), n: mc[1], line: lineOf22(src, sp.start + 1 + mc.index) });
      }
      const hasLower = /collect_time\s*(?:>=|>)/i.test(text) || /collect_time\s*BETWEEN/i.test(text);
      const hasUpper = /collect_time\s*(?:<=|<)/i.test(text) || /collect_time\s*BETWEEN/i.test(text);
      const singleSided = !(hasLower && hasUpper);
      const hasOrder = /\bORDER\s+BY\b/i.test(text);
      candidates.push({ rel, line, caps: caps.map(c => c.txt), singleSided, hasOrder, sql: text.trim() });
      for (const cap of caps) {
        if (cap.n === '1' && hasOrder && singleSided) {
          adjacency.push({ rel, line, capLine: cap.line, cap: cap.txt, sql: text.trim() });
        } else {
          violations.push({
            rel, line, capLine: cap.line, cap: cap.txt, sql: text.trim(),
            why: cap.n === '1' ? '`LIMIT 1` 但**不是**"邻接单行"形态（有上下界／缺 `ORDER BY`）'
              : `行数上限 \`${cap.txt}\``
          });
        }
      }
    }
    return { candidates, violations, adjacency, undecided };
  };
  const serverJs22 = walkJsTopE160(path.join(env.paths.root, 'server'));
  const e129PerFile22 = serverJs22.map(f => ({ rel: relOf22(f), ...scanWindowQueryCap22(relOf22(f), read22(f)) }));
  const e129Candidates22 = e129PerFile22.flatMap(r => r.candidates.map(c => ({ rel: r.rel, ...c })));
  const e129Violations22 = e129PerFile22.flatMap(r => r.violations.map(v => ({ rel: r.rel, ...v })));
  const e129Adjacency22 = e129PerFile22.flatMap(r => r.adjacency.map(v => ({ rel: r.rel, ...v })));
  const e129Undecided22 = e129PerFile22.flatMap(r => r.undecided.map(v => ({ rel: r.rel, ...v })));
  const e129AdjTxt22 = e129Adjacency22.length
    ? e129Adjacency22.map(v => `\`${v.rel}\`:${v.capLine} \`${v.cap}\`（${v.sql.replace(/\s+/g, ' ').slice(0, 96)}…）`).join('；')
    : '（无）';
  t.check('E129-① **静态判据：窗口取数不得含行数上限**（面＝`server\\**\\*.js`）：候选＝SQL 字面量里同时含 '
    + '`FROM measure_rt` 与 `collect_time` 比较谓词的 `SELECT`；候选内任何 `LIMIT` 子句 ⇒ **红并指名 `文件:行号`**；'
    + '唯一例外＝"**单边谓词 ＋ ORDER BY ＋ LIMIT 1**"＝**邻接单行**（`server\\index.js` 的 `previousFrameShiftOf()` 的语义），'
    + '该例外**逐条打出来**（排除不许隐形）',
    e129Violations22.length === 0 && e129Candidates22.length > 0
      && e129Adjacency22.some(v => v.rel === 'server\\index.js'),
    e129Violations22.length
      ? `判红 ${e129Violations22.length} 处：`
        + e129Violations22.map(v => `\`${v.rel}\`:${v.capLine}（${v.why}；SQL 起于 :${v.line}）`).join('；')
      : `零违规（扫 ${serverJs22.length} 个 server .js；候选 ${e129Candidates22.length} 条：`
        + e129Candidates22.map(c => `\`${c.rel}\`:${c.line}[${c.caps.join(',') || '无上限'}]`).join('、')
        + `；**邻接单行（例外、判绿）** ${e129Adjacency22.length} 条：${e129AdjTxt22}`
        + `；未判定 ${e129Undecided22.length} 条：`
        + (e129Undecided22.map(v => `\`${v.rel}\`:${v.line} ${v.why}`).join('；') || '（无）'));
  t.info(`\`E129-①\` 口径：候选＝"按 \`collect_time\` 取数"的 SELECT 字面量；例外＝邻接单行（单边谓词 ＋ ORDER BY ＋ LIMIT 1）。`
    + `**反例读数**（必须不被误判）：\`server\\index.js\` 的 \`previousFrameShiftOf()\` 里 \`WHERE collect_time < ? ORDER BY collect_time DESC LIMIT 1\` `
    + `是"早于本帧的最近一条"的**语义** ⇒ 实测${e129Adjacency22.some(v => v.rel === 'server\\index.js') ? '**已列入除外**（判绿 ✓）' : '**未被列入 ⇒ 判据有问题**'}`);

  /* ---------------- `E129-②` D22（可证伪）：把窗口查询改回 `LIMIT 1000`（**内存**） ---------------- */
  {
    const b0 = fs.readFileSync(SRC_SNAPSHOT_ABS22);
    const src0 = b0.toString('utf8');
    const sha0 = sha256hex22(b0);
    const live22 = scanWindowQueryCap22(SRC_SNAPSHOT_REL22, src0);
    const anchor22 = 'ORDER BY id DESC`';
    const mutSrc22 = src0.replace(anchor22, 'ORDER BY id DESC LIMIT 1000`');
    const hit22 = mutSrc22 !== src0;
    const mut22 = hit22 ? scanWindowQueryCap22(SRC_SNAPSHOT_REL22, mutSrc22) : { violations: [] };
    const b1 = fs.readFileSync(SRC_SNAPSHOT_ABS22);
    const residual22 = scanWindowQueryCap22(SRC_SNAPSHOT_REL22, b1.toString('utf8')).violations;
    t.check('E129-② D22（可证伪）：把盘上窗口查询的 `ORDER BY id DESC`（**内存副本**）改成 '
      + '`ORDER BY id DESC LIMIT 1000` ⇒ **同一判据必红并指名 `server\\services\\stateSnapshot.js` 的行号**；'
      + '现行源码零违规（**负对照必绿**）；盘上文件**逐字节未变**；变异实验后盘上判据的残留 `[]`',
      live22.violations.length === 0 && hit22 && mut22.violations.length === 1
        && mut22.violations[0].cap === 'LIMIT 1000' && Buffer.compare(b0, b1) === 0 && residual22.length === 0,
      `现行违规 ${live22.violations.length} 处（应 0）；锚点 \`${anchor22}\` 命中=${hit22}；`
        + `内存变异后违规 ${mut22.violations.length} 处（应 1）：`
        + (mut22.violations.map(v => `\`${v.rel}\`:${v.capLine}（${v.why}）`).join('；') || '（**红没出现 ⇒ 本条判据不可证伪**）')
        + `；盘上 \`server\\services\\stateSnapshot.js\` 逐字节未变=${Buffer.compare(b0, b1) === 0}（sha256=${sha0.slice(0, 12)}…）；`
        + `残留 ${JSON.stringify(residual22.map(v => `${v.rel}:${v.capLine}`))}`);
  }

  /* ==================== `E170`：索引与查询计划（`EXPLAIN QUERY PLAN` 判据） ====================
     · 建库：**内存** `:memory:` ＋ 盘上 `schema.sql` 的 DDL 现读（不落盘、不碰真库）；
     · 待判 SQL：**就从盘上 `stateSnapshot.js` 现抠**（与 `E129-①` 同一个扫描器 ⇒ 两件判据同一份取数口）；
     · 负对照＝盘上现行（期望 `SEARCH … USING COVERING INDEX ix_measure_rt_collect_time`）；
     · D22＝内存 `DROP INDEX` ＋ 从 schema 文本摘掉那一行（`E170` 的"打回 `SCAN`"）。 */
  const windowSql22 = (() => {
    const r = scanWindowQueryCap22(SRC_SNAPSHOT_REL22, read22(SRC_SNAPSHOT_ABS22));
    const c = r.candidates.find(x => /SELECT\s+collect_time\s+AS\s+collectTime/i.test(x.sql));
    return c ? c.sql : null;
  })();
  const schemaSql22 = read22(SCHEMA_ABS22);
  const INDEX_LINE_RE22 = /^CREATE INDEX IF NOT EXISTS ix_measure_rt_collect_time ON measure_rt\(collect_time\);\r?\n/m;
  const planOf22 = (db, sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all('0', '9')
    .map(r => String(r.detail)).join(' | ');
  const planJudge22 = (plan) => ({
    ok: /ix_measure_rt_collect_time/.test(plan) && !/\bSCAN measure_rt\b/i.test(plan), plan
  });
  const stepJudge22 = (steps) => {
    const hit = steps.filter(s => /ix_measure_rt_collect_time/.test(String(s)));
    const cls = hit.length === 1 ? dbApi22.classifyUpgradeStep(hit[0]) : null;
    return { ok: hit.length === 1 && Boolean(cls && cls.ok === true && cls.kind === 'create-index'), n: hit.length, kind: cls ? cls.kind : '（未命中）' };
  };
  const withDb22 = (schemaText, fn) => {
    const db = new DatabaseSync(':memory:');
    try { db.exec(schemaText); return fn(db); } finally { try { db.close(); } catch { /* 已关 */ } }
  };
  const planDisk22 = windowSql22
    ? withDb22(schemaSql22, db => planOf22(db, windowSql22)) : '（窗口 SQL 未抠到 ⇒ 计划不可读）';
  const planDiskVerdict22 = planJudge22(planDisk22);
  const stepDisk22 = stepJudge22(dbApi22.STRUCTURE_UPGRADES);
  t.check('E170-① **索引与查询计划**（`E166` 的首选修法、`E170` 的验收面）：`EXPLAIN QUERY PLAN`（内存 '
    + '`:memory:` ＋ 盘上 `schema.sql`）对**从盘上抠出的窗口查询**必须给出 '
    + '`ix_measure_rt_collect_time`（`SEARCH`）而**不是** `SCAN measure_rt`；且老库路径 '
    + '`server\\db\\index.js` 的 `STRUCTURE_UPGRADES` 必须带**幂等**建索引步骤（`classifyUpgradeStep` 归 '
    + '`create-index`）；`schema.sql`（新建库路径）与它同源',
    Boolean(windowSql22) && planDiskVerdict22.ok && INDEX_LINE_RE22.test(schemaSql22) && stepDisk22.ok,
    `窗口 SQL＝${windowSql22 ? '`' + windowSql22.replace(/\s+/g, ' ').slice(0, 90) + '…`' : '**未抠到**'}；`
      + `盘上计划＝\`${planDisk22}\`；用上索引且非 SCAN=${planDiskVerdict22.ok}；`
      + `\`schema.sql\` 含幂等建索引行=${INDEX_LINE_RE22.test(schemaSql22)}；`
      + `\`STRUCTURE_UPGRADES\` 命中 ${stepDisk22.n} 条（应 1）、归类＝\`${stepDisk22.kind}\`（应 \`create-index\`）；`
      + `\`SCHEMA_VERSION\`=${JSON.stringify(dbApi22.SCHEMA_VERSION)}`);
  /* ---------------- `E170-②` D22：内存"打回 SCAN" ----------------
     三支变异（都在内存）：㈠建好的内存库上 `DROP INDEX` ㈡schema 文本摘掉那一行再建库
     ㈢`STRUCTURE_UPGRADES` 的内存副本去掉那一步。负对照＝盘上原件（三支都应绿）。 */
  {
    const schemaBytes0_22 = fs.readFileSync(SCHEMA_ABS22);
    const dropPlan22 = windowSql22 ? withDb22(schemaSql22, (db) => {
      db.exec('DROP INDEX ix_measure_rt_collect_time');
      return planOf22(db, windowSql22);
    }) : '（窗口 SQL 未抠到）';
    const minusSchema22 = schemaSql22.replace(INDEX_LINE_RE22, '');
    const minusHit22 = minusSchema22 !== schemaSql22;
    const minusPlan22 = windowSql22 ? withDb22(minusSchema22, db => planOf22(db, windowSql22)) : '（窗口 SQL 未抠到）';
    const minusSteps22 = dbApi22.STRUCTURE_UPGRADES.filter(s => !/ix_measure_rt_collect_time/.test(String(s)));
    const minusStepVerdict22 = stepJudge22(minusSteps22);
    const schemaBytes1_22 = fs.readFileSync(SCHEMA_ABS22);
    const residualSteps22 = stepJudge22(dbApi22.STRUCTURE_UPGRADES);
    const dropRed22 = planJudge22(dropPlan22).ok === false && /\bSCAN measure_rt\b/i.test(dropPlan22);
    const minusRed22 = minusHit22 && planJudge22(minusPlan22).ok === false && /\bSCAN measure_rt\b/i.test(minusPlan22);
    t.check('E170-② D22（可证伪，**三支内存变异 ＋ 负对照**）：㈠`DROP INDEX ix_measure_rt_collect_time` '
      + '㈡从 `schema.sql` 文本摘掉那一行 ⇒ 同一判据**必红并指名 `SCAN measure_rt`**；'
      + '㈢`STRUCTURE_UPGRADES` 的内存副本去掉那一步 ⇒ 老库路径判据**必红并指名"未命中"**；'
      + '而**盘上原件**两支判据**全部为绿**；`schema.sql` 逐字节未变',
      dropRed22 && minusRed22 && minusStepVerdict22.ok === false && minusStepVerdict22.n === 0
        && planDiskVerdict22.ok === true && stepDisk22.ok === true
        && Buffer.compare(schemaBytes0_22, schemaBytes1_22) === 0 && residualSteps22.ok === true,
      `㈠内存 DROP INDEX ⇒ \`${dropPlan22}\`（判红并指名 SCAN=${dropRed22}）；`
        + `㈡schema 摘行锚点命中=${minusHit22} ⇒ \`${minusPlan22}\`（判红并指名 SCAN=${minusRed22}）；`
        + `㈢STRUCTURE_UPGRADES 去掉那一步 ⇒ 命中 ${minusStepVerdict22.n} 条／归类 \`${minusStepVerdict22.kind}\`（应红）；`
        + `**负对照**（盘上原件）：计划判据绿=${planDiskVerdict22.ok}、老库路径判据绿=${stepDisk22.ok}；`
        + `盘上 \`schema.sql\` 逐字节未变=${Buffer.compare(schemaBytes0_22, schemaBytes1_22) === 0}；`
        + `残留（老库路径判据）＝${residualSteps22.ok ? '[]' : JSON.stringify(residualSteps22)}`);
  }

  /* ==================== `E167`：告警名额与计数 ====================
     · 生产调用点＝`statsForShift(db, shift, {snapshot})`（与 `statsOf()` 同一条路径，`stateSnapshot.js:712`）；
     · 桩库＝只按 SQL 文本分派 `all()/get()`，**不建库、不落盘**；
     · 告警捕获＝临时替换 `console.warn`（`finally` 还原；绝不吞掉别的输出）。 */
  const stubDb22 = (rows) => ({
    prepare(sql) {
      const s = String(sql);
      return {
        all: () => (/FROM\s+measure_rt/i.test(s) ? rows : []),
        get: () => (/COUNT\(\*\)/i.test(s) ? { c: 0 } : null)
      };
    }
  });
  const denseRows22 = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const mm = Math.floor(i / 60);
      out.push({
        collectTime: `2026-09-19 ${String(8 + (Math.floor(mm / 60) % 8)).padStart(2, '0')}:`
          + `${String(mm % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`
      });
    }
    return out;
  };
  const captureWarn22 = (fn) => {
    const got = [];
    const real = console.warn;
    console.warn = (...a) => { got.push(a.map(String).join(' ')); };
    try { return { warns: got, result: fn() }; } finally { console.warn = real; }
  };
  const shift22 = shiftRules22.at(clock22.now());
  const cap22 = snapSvc22.measureWindowDensity(shift22, 0).cap;
  const rowsDense22 = denseRows22(cap22 + 1);
  const dbStub22 = stubDb22(rowsDense22);
  const pureJudgeTrue22 = snapSvc22.measureWindowDensity(shift22, cap22 + 1).dense;
  const pureJudgeFalse22 = snapSvc22.measureWindowDensity(shift22, cap22).dense;
  /* ① 纯判据**零副作用**：连调两次，计数必须纹丝不动 */
  snapSvc22.resetMeasureWindowDenseCounts();
  const countsBeforePure22 = snapSvc22.measureWindowDenseCounts();
  const pureReads22 = [snapSvc22.measureWindowDensity(shift22, cap22 + 1), snapSvc22.measureWindowDensity(shift22, cap22 + 1)];
  const countsAfterPure22 = snapSvc22.measureWindowDenseCounts();
  /* ② 探针先调 ⇒ 生产**照响**（名额不被消耗）；探针自己的去重只作用于它自己 */
  const inst22 = snapSvc22.createStateSnapshot({ db: dbStub22, now: clock22.source(), config: boardConfig });
  const probeCap22 = captureWarn22(() => snapSvc22.warnIfMeasureWindowDense(shift22, cap22 + 1));
  const probeCapAgain22 = captureWarn22(() => snapSvc22.warnIfMeasureWindowDense(shift22, cap22 + 1));
  const prodCap22 = captureWarn22(() => snapSvc22.statsForShift(dbStub22, shift22, {
    snapshot: inst22, config: boardConfig, now: clock22.now(), addRunSec: 0, accum: null
  }));
  const countsAfterProd22 = snapSvc22.measureWindowDenseCounts();
  t.check('E167-① **探针调用不消耗生产告警名额**（`E167` 的验收面）：`measureWindowDensity()` 是**纯判据**'
    + '（连调两次，`MEASURE_WINDOW_DENSE_COUNTER` 纹丝不动 ⇒ 不记账）；模块导出的 '
    + '`warnIfMeasureWindowDense()` **先调一次**（探针形态）之后，生产路径 '
    + '`statsForShift(db, shift, {snapshot})` **仍然告警**（名额按快照实例记账，与"谁先问过"无关）',
    pureJudgeTrue22 === true && pureJudgeFalse22 === false
      && JSON.stringify(countsBeforePure22) === JSON.stringify(countsAfterPure22)
      && countsBeforePure22.called === 0 && pureReads22.length === 2
      && probeCap22.warns.length === 1 && probeCapAgain22.warns.length === 0
      && prodCap22.warns.length === 1
      && countsAfterProd22.bySource.probe === 2 && countsAfterProd22.bySource.prod === 1,
    `判据真值表：帧数 ${cap22 + 1}（> cap ${cap22}）⇒ dense=${pureJudgeTrue22}；帧数 ${cap22}（＝cap）⇒ dense=${pureJudgeFalse22}；`
      + `**纯判据不记账**：调用前 ${JSON.stringify(countsBeforePure22)}、调用两次后 ${JSON.stringify(countsAfterPure22)}；`
      + `**探针先调**（同窗两次）⇒ 探针自己告警 ${probeCap22.warns.length} 条／再调 ${probeCapAgain22.warns.length} 条（它自己的去重）；`
      + `**生产路径**（同一窗口、探针已"问过"）⇒ 告警 **${prodCap22.warns.length} 条**（应 1）；`
      + `计数 bySource＝${JSON.stringify(countsAfterProd22.bySource)}（探针 2 ＋ 生产 1）；`
      + `生产事实 frameCount=${prodCap22.result && prodCap22.result.fact ? prodCap22.result.fact.frameCount : '（无）'}`);
  /* ③ 计数**不去重**：同一窗口连问三次 ⇒ 告警 1 条（去重）、计数 3 次（不去重） */
  const smallShift22 = { name: '小窗', date: '2026-09-19', startAt: '2026-09-19 08:00:00', endAt: '2026-09-19 08:00:10' };
  const smallCap22 = snapSvc22.measureWindowDensity(smallShift22, 0).cap;
  snapSvc22.resetMeasureWindowDenseCounts();
  const smallCap3x22 = captureWarn22(() => {
    snapSvc22.warnIfMeasureWindowDense(smallShift22, smallCap22 + 1);
    snapSvc22.warnIfMeasureWindowDense(smallShift22, smallCap22 + 1);
    snapSvc22.warnIfMeasureWindowDense(smallShift22, smallCap22 + 1);
  });
  const counts3x22 = snapSvc22.measureWindowDenseCounts();
  t.check('E167-② **同窗连问三次 ⇒ 告警去重（1 条）／计数不去重（3 次）**（`E146`／`T-20261004-19` 的分工，'
    + '`E167` 补的机器可读计数）：`MEASURE_WINDOW_DENSE_COUNTER` 的 `called`／`dense`／`bySource.probe` 各 ＋3，'
    + '而 `warned` 只 ＋1 —— 于是门禁能读到"这一窗到底告警过没有"，而人不会被刷屏',
    smallCap22 === 20 && smallCap3x22.warns.length === 1
      && counts3x22.called === 3 && counts3x22.dense === 3 && counts3x22.warned === 1
      && counts3x22.bySource.probe === 3 && counts3x22.bySource.prod === 0,
    `小窗 ${smallShift22.startAt}→${smallShift22.endAt}（10 s ⇒ cap ${smallCap22}）连问三次：`
      + `告警 ${smallCap3x22.warns.length} 条（应 1＝**去重**）；计数 ${JSON.stringify(counts3x22)}（called／dense 应 3、warned 应 1＝**不去重**）`);
  /* ④ D22：**真旧字节**（`030f76e^`＝`E167` 修前的模块顶层 `Set`）在内存里编译，跑**同一场景** ⇒ 生产 0 条 */
  {
    const OLD_REV22 = '030f76e^';
    const oldBytes22 = (() => {
      const r = spawnSync('git', ['show', OLD_REV22 + ':' + SRC_SNAPSHOT_REL22.split('\\').join('/')],
        { cwd: env.paths.root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      return r.status === 0 && r.stdout ? r.stdout : null;
    })();
    const oldSvc22 = (() => {
      if (!oldBytes22) return null;
      return attempt22(() => {
        const m = new Module22(SRC_SNAPSHOT_ABS22, null);
        m.filename = SRC_SNAPSHOT_ABS22;
        m.paths = Module22._nodeModulePaths(path.dirname(SRC_SNAPSHOT_ABS22));
        m._compile(oldBytes22, SRC_SNAPSHOT_ABS22);
        return m.exports;
      });
    })();
    const oldSvcOk22 = Boolean(oldSvc22 && oldSvc22.ok && oldSvc22.value
      && typeof oldSvc22.value.warnIfMeasureWindowDense === 'function'
      && typeof oldSvc22.value.statsForShift === 'function');
    const svc22 = oldSvcOk22 ? oldSvc22.value : null;
    const oldProbeRes22 = svc22
      ? attempt22(() => captureWarn22(() => svc22.warnIfMeasureWindowDense(shift22, cap22 + 1)))
      : { ok: false, err: oldSvc22 && oldSvc22.err ? oldSvc22.err : '旧模块不可用' };
    const oldProdRes22 = svc22
      ? attempt22(() => captureWarn22(() => svc22.statsForShift(dbStub22, shift22, {
        config: boardConfig, now: clock22.now(), addRunSec: 0, accum: null
      })))
      : { ok: false, err: oldProbeRes22.err };
    const oldProbe22 = oldProbeRes22.ok ? oldProbeRes22.value : { warns: [] };
    const oldProd22 = oldProdRes22.ok ? oldProdRes22.value : { warns: [] };
    const b0 = fs.readFileSync(SRC_SNAPSHOT_ABS22);
    const b1 = fs.readFileSync(SRC_SNAPSHOT_ABS22);
    /* 现行实现的"残留"读数：换一个**新实例**再跑一次生产路径 ⇒ 仍告警（名额只属于它自己） */
    const inst2nd22 = snapSvc22.createStateSnapshot({ db: dbStub22, now: clock22.source(), config: boardConfig });
    const prodResidual22 = captureWarn22(() => snapSvc22.statsForShift(dbStub22, shift22, {
      snapshot: inst2nd22, config: boardConfig, now: clock22.now(), addRunSec: 0, accum: null
    }));
    t.check('E167-③ D22（可证伪，**真旧字节**）：把 `' + OLD_REV22 + '` 版 `stateSnapshot.js`（修前：模块顶层 '
      + '`Set` ＋ 导出函数里告警）**在内存里编译**后跑**同一场景**（探针先调、生产随后）⇒ 生产告警 **0 条** '
      + '（＝`E167` 的病灶：名额被"先问过的人"占掉）⇒ "生产必须告警"这条判据在旧实现上**必红**；'
      + '现行实现同一场景 **1 条**（**负对照必绿**）；盘上文件逐字节未变；残留（新实例再跑一次生产路径）'
      + '**仍告警 1 条**',
      oldSvcOk22 && oldProbeRes22.ok && oldProdRes22.ok
        && oldProbe22.warns.length === 1 && oldProd22.warns.length === 0
        && prodCap22.warns.length === 1 && prodResidual22.warns.length === 1
        && Buffer.compare(b0, b1) === 0,
      `旧字节来源 \`git show ${OLD_REV22}:server/services/stateSnapshot.js\` ⇒ ${oldBytes22 ? oldBytes22.length + ' B' : '**取不到**'}`
        + `（内存编译成功=${oldSvcOk22}${oldSvcOk22 ? '' : '；err=' + String(oldSvc22 && oldSvc22.err)}）；`
        + `同一场景：旧实现探针告警 ${oldProbe22.warns.length} 条、**生产 ${oldProd22.warns.length} 条**`
        + `（应 0 ⇒ "生产必须告警"在旧实现上不成立＝可证伪）；现行实现生产 ${prodCap22.warns.length} 条（负对照，应 1）；`
        + `盘上逐字节未变=${Buffer.compare(b0, b1) === 0}；残留（新实例重跑生产路径）告警 ${prodResidual22.warns.length} 条（应 1）`);
  }
  t.info(`\`E129\`／\`E170\`／\`E167\` 的面与读数（现算）：\`E129-①\` 扫 ${serverJs22.length} 个 server .js ⇒ 候选 `
    + `${e129Candidates22.length} 条、违规 ${e129Violations22.length} 条、邻接单行例外 ${e129Adjacency22.length} 条、未判定 ${e129Undecided22.length} 条；`
    + `\`E170-①\` 窗口计划＝\`${planDisk22}\`；\`E167\` 判据口＝\`measureWindowDensity()\`（纯）＋ `
    + `\`measureWindowDenseCounts()\`（机器可读、不去重）`);
}
  /* ---------------- 二十三、`E164` 受管侧"台账结构不变量"（4b 的 `T-20261005-15`） ----------------
     【立案】`E164`：主代理仓外的台账写入器（`ledger.js`）曾把 **469 行台账用 `join(/\r?\n/)` 粘成 1 行** ——
     那次事故**仓内一条判据都没有**（`E164` 立案句："台账行结构无守据"）。本节把**结构不变量**做成仓内断言。
     【面】四份台账（主代理点名）：`项目记录\后续路线图.md`／`当前状态快照.md`／`工作日志.md`／`tests\README.md`。
     【维度】与主代理 `ledger.js` 同口径的五项：
       ① **行数**（`≥` 冻结点下界 ⇒ 抓"整体塌缩"；**不是变更预算** —— 台账是增量文件，只会涨）
       ② **最长行**（`≤` 冻结点上界 ⇒ 抓"整份被写成一行"与"单行失控"）
       ③ **可按 `|` 分列的行占比**（`≥` 冻结点下界 ⇒ 抓"表格被压平"）
       ④ **首行逐字**（sha12 冻结）＋ **末行（最后一个非空行）**：`首行 ≠ 末行`（**整份只剩一行 ＝ 粘连特征**）；
         末行 sha12 只作**读数**、**不冻结**
          （实测：快照/日志/README 的末行是**当轮会话文字**，每轮都在长）
       ⑤ **无 BOM** ＋ **行尾不混用** ＋ **末行尾存在**
     【阈值来源】**实测**（2026-10-05 四份台账现读；完整分布见 `E164-①` 的详情）——
       ⚠ 主代理要求"**先报实测、确认后再写死**"⇒ 下面的 `E164_BASELINE` 是**暂用值**（已如实标注），
       与仓外 `ledger.js` 口径核对后**只需改这一个常量块**，并同步 `E164_ANCHOR` 的 `sha12`（`E164-③` 会当场拦）。
     【为什么是"下界/上界"而不是"写死数字"】正常追加**不会假红**（行数与表格占比只涨、最长行留 3 倍余量），
       而"粘成一行／被压平／被换编码"必红并**逐条指名 `文件：维度 实测/阈值`**。 */
  t.section('二十三、`E164` 受管侧"台账结构不变量"（四份台账 × 五维）');
  {
    const crypto23 = require('node:crypto');
    const sha12_23 = (s) => crypto23.createHash('sha256').update(s).digest('hex').slice(0, 12);
    const E164_FILES = [
      { rel: '项目记录\\后续路线图.md', label: '后续路线图' },
      { rel: '项目记录\\当前状态快照.md', label: '当前状态快照' },
      { rel: '项目记录\\工作日志.md', label: '工作日志' },
      { rel: 'tests\\README.md', label: 'tests/README（权威区）' }
    ];
    /** **冻结点基线**（**暂用值 ＝ 2026-10-05 实测**；主代理与仓外 `ledger.js` 口径核对后确认/调整）。
     *  推导规则（写清以便复核）：`linesMin` ＝ 实测行数的**一半**（取整到 10）；
     *  `maxLineMax` ＝ `max(10000, 实测最长行 × 3)`；`tableRatioMin` ＝ 实测表格行占比的**一半**（向下取整到 1%）；
     *  `firstLineSha12` ＝ 首行**逐字** sha12（标题，稳定）。
     *  实测：行数 486／543／2032／323；最长行 7906／4694／2314／9156；表格行占比 65.2%／38.0%／5.2%／19.8%。 */
    const E164_BASELINE = [
      { rel: '项目记录\\后续路线图.md', linesMin: 240, maxLineMax: 24000, tableRatioMin: 0.30, firstLineSha12: '006422e11a43' },
      { rel: '项目记录\\当前状态快照.md', linesMin: 270, maxLineMax: 15000, tableRatioMin: 0.18, firstLineSha12: '25683d1ff613' },
      { rel: '项目记录\\工作日志.md', linesMin: 1000, maxLineMax: 10000, tableRatioMin: 0.02, firstLineSha12: '0fb0692b692e' },
      { rel: 'tests\\README.md', linesMin: 160, maxLineMax: 28000, tableRatioMin: 0.09, firstLineSha12: 'a7dacae51339' }
    ];
    /** **冻结点锚点**（`E145` 的教训：锚点必须是**常量**，不能由基线现算 —— 现算＝自己对自己复读、零证伪能力）。
     *  有人**悄悄放宽**某一个阈值（E164 最容易被"顺手改松"）⇒ `sha12` 不符 ⇒ `E164-③` 当场红。 */
    const E164_ANCHOR = { total: 4, sha12: '00edc52014a5' };
    /** 结构读数（**纯函数**；主判据与 D22 共用同一把尺子） */
    const e164Stats = (text) => {
      const raw = text.split(/\r\n|\n/);
      const body = raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;      /* 末行尾的那一"空行"不算行 */
      const lens = body.map(l => l.length);
      const tableRows = body.filter((l) => {
        const cells = l.split('|').map(c => c.trim()).filter(Boolean);
        return l.trim().startsWith('|') && cells.length >= 3;
      }).length;
      const nonEmpty = body.filter(l => l.trim());
      return {
        lines: body.length,
        maxLen: lens.length ? Math.max(...lens) : 0,
        tableRows,
        tableRatio: body.length ? tableRows / body.length : 0,
        firstLine: body[0] || '',
        lastLine: nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : '',
        bom: text.charCodeAt(0) === 0xFEFF,
        crlf: (text.match(/\r\n/g) || []).length,
        bareLf: (text.match(/(?<!\r)\n/g) || []).length,
        endsWithNewline: /\n$/.test(text)
      };
    };
    /** **判据（纯函数）**：逐维比对 ⇒ 违规串**一律带文件名**（⇒ "逐条指名"是结构性的，不是靠调用方拼串） */
    const e164Audit = (rel, stats, b) => {
      const bad = [];
      if (stats.lines < b.linesMin) bad.push(`行数 ${stats.lines} < 下界 ${b.linesMin}`);
      if (stats.maxLen > b.maxLineMax) bad.push(`最长行 ${stats.maxLen} > 上界 ${b.maxLineMax}`);
      if (stats.tableRatio < b.tableRatioMin) {
        bad.push(`表格行占比 ${(stats.tableRatio * 100).toFixed(1)}% < 下界 ${(b.tableRatioMin * 100).toFixed(0)}%`);
      }
      if (sha12_23(stats.firstLine) !== b.firstLineSha12) {
        bad.push(`首行 sha12 ${sha12_23(stats.firstLine)} ≠ 冻结 ${b.firstLineSha12}（首行＝「${stats.firstLine.slice(0, 40)}」）`);
      }
      if (stats.lines <= 1 || stats.firstLine === stats.lastLine) {
        bad.push('首行 ＝ 末行（或整份只有一行）—— `join(\'\')` 式"整份粘成一行"的特征');
      }
      if (stats.bom) bad.push('带 BOM');
      if (stats.crlf > 0 && stats.bareLf > 0) bad.push(`行尾混用（CRLF ${stats.crlf}／裸 LF ${stats.bareLf}）`);
      if (!stats.endsWithNewline) bad.push('缺末行尾');
      return bad.map(x => `${rel}：${x}`);
    };
    const e164Disk = E164_FILES.map((f) => {
      const text = fs.readFileSync(path.join(env.paths.root, f.rel), 'utf8');
      const b = E164_BASELINE.find(x => x.rel === f.rel);
      const stats = e164Stats(text);
      return { ...f, b, stats, bad: e164Audit(f.rel, stats, b) };
    });
    const e164Bad = e164Disk.flatMap(r => r.bad);
    t.check('E164-① **四份台账的结构不变量**（行数下界／最长行上界／表格行占比下界／首行逐字／首末行不同行／无 BOM／'
      + '行尾不混用／末行尾存在）：任一份任一项违规 ⇒ **红并逐条指名「文件：维度 实测/阈值」**；'
      + '正常追加不改判据（下界/上界，不是写死数字）',
      e164Disk.length === E164_FILES.length && e164Disk.every(r => r.b && r.stats.lines > 0) && e164Bad.length === 0,
      `盘上现测（**五量全读数**，供主代理与仓外那一份口径对照）：`
        + e164Disk.map(r => `${r.label}［${r.rel}］行数 ${r.stats.lines}／最长行 ${r.stats.maxLen}／表格行 ${r.stats.tableRows}`
          + `（${(r.stats.tableRatio * 100).toFixed(1)}%）／首行 sha12 ${sha12_23(r.stats.firstLine)}／`
          + `末行(最后非空) sha12 ${sha12_23(r.stats.lastLine)}／BOM ${r.stats.bom}／CRLF ${r.stats.crlf}·裸 LF ${r.stats.bareLf}／末行尾 ${r.stats.endsWithNewline}`).join('；')
        + `。阈值（**暂用值，待确认**）：${E164_BASELINE.map(b => `${b.rel}[行数≥${b.linesMin}／最长行≤${b.maxLineMax}／表格≥${(b.tableRatioMin * 100).toFixed(0)}%]`).join('；')}`
        + `。违规 ${e164Bad.length} 条${e164Bad.length ? '：' + e164Bad.join('；') : '（无）'}`);
    /* `E164-②` D22（可证伪，**内存变异 ＋ 负对照**）：
       ㈠把**行数最多**的那份台账按 `join('')` **粘成一行**（`E164` 的事故形态）⇒ 同一判据必红，
          且**维度名**必须出现在违规串里（"行数"＋"最长行"＋"首行＝末行"至少各中一条）并带文件名；
       ㈡把**后续路线图**里的 `|` 全部去掉（表格被压平）⇒ "表格行占比"这一维必红；
       ㈢**负对照**＝盘上现测 ⇒ 全绿。全程只在内存里改字符串，盘上文件逐字节未变。 */
    {
      const target = e164Disk.slice().sort((a, b) => b.stats.lines - a.stats.lines)[0];
      const tgtText = fs.readFileSync(path.join(env.paths.root, target.rel), 'utf8');
      const glued = tgtText.replace(/\r\n|\n/g, '');
      const gluedBad = e164Audit(target.rel, e164Stats(glued), target.b);
      const road = E164_BASELINE.find(b => b.rel === '项目记录\\后续路线图.md');
      const roadText = fs.readFileSync(path.join(env.paths.root, road.rel), 'utf8');
      const flat = roadText.replace(/\|/g, '');
      const flatBad = e164Audit(road.rel, e164Stats(flat), road);
      const bytes0 = fs.readFileSync(path.join(env.paths.root, target.rel));
      const bytes1 = fs.readFileSync(path.join(env.paths.root, target.rel));
      t.check('E164-② D22（可证伪，**两支内存变异 ＋ 负对照**）：㈠把行数最多的台账 `join(\'\')` **粘成一行** ⇒ '
        + '同一判据**必红**且违规串里必须出现「行数」「最长行」「首行 ＝ 末行」这些**维度名**并带文件名；'
        + '㈡把后续路线图的 `|` 全去掉（表格压平）⇒「表格行占比」维度必红；㈢**负对照**＝盘上现测 ⇒ 全绿；'
        + '盘上文件逐字节未变',
        gluedBad.length >= 3 && gluedBad.some(x => x.includes('行数')) && gluedBad.some(x => x.includes('最长行'))
          && gluedBad.some(x => x.includes('首行 ＝ 末行')) && gluedBad.every(x => x.startsWith(target.rel))
          && flatBad.length >= 1 && flatBad.some(x => x.includes('表格行占比'))
          && e164Bad.length === 0 && Buffer.compare(bytes0, bytes1) === 0,
        `㈠「${target.label}」粘成一行（行数 ${target.stats.lines} → ${e164Stats(glued).lines}、最长行 ${target.stats.maxLen} → ${e164Stats(glued).maxLen}）`
          + `⇒ 违规 ${gluedBad.length} 条：${gluedBad.join('；')}；`
          + `㈡「后续路线图」去掉全部 \`|\` ⇒ 违规 ${flatBad.length} 条：${flatBad.join('；')}；`
          + `㈢负对照（盘上现测）⇒ 违规 ${e164Bad.length} 条（应 0）；盘上逐字节未变=${Buffer.compare(bytes0, bytes1) === 0}`);
    }
    /* `E164-③` 冻结点自证：基线块被**悄悄改松**（某个阈值改小/改大）⇒ 锚点 `sha12` 必不符并指名。
       ⚠ 锚点是**常量**、不由基线现算（`E145` 的教训）—— 这里刻意"现算一个值去比常量"。 */
    {
      const anchorOf = (list) => sha12_23(list.slice().sort((a, b) => a.rel.localeCompare(b.rel))
        .map(b => `${b.rel}|${b.linesMin}|${b.maxLineMax}|${b.tableRatioMin}|${b.firstLineSha12}`).join('\n'));
      const nowSha = anchorOf(E164_BASELINE);
      const loosened = E164_BASELINE.map((b, i) => (i === 0 ? { ...b, linesMin: b.linesMin - 10 } : b));
      const tightened = E164_BASELINE.map((b, i) => (i === 1 ? { ...b, maxLineMax: b.maxLineMax + 1000 } : b));
      t.check('E164-③ **冻结点的自证**（`E145` 机制）：基线块条数 ＝ 台账份数、锚点 `total` ＝ 条数、'
        + '逐条 `sha12`（常量，**不由基线现算**）＝ 现算值；**把任一阈值改松/改紧**（内存副本）⇒ `sha12` **必不符**',
        E164_BASELINE.length === E164_FILES.length && E164_ANCHOR.total === E164_BASELINE.length
          && nowSha === E164_ANCHOR.sha12
          && anchorOf(loosened) !== E164_ANCHOR.sha12 && anchorOf(tightened) !== E164_ANCHOR.sha12,
        `基线 ${E164_BASELINE.length} 条／锚点 total ${E164_ANCHOR.total}；现算 sha12 ${nowSha}／冻结 ${E164_ANCHOR.sha12}；`
          + `改松一处（首个 \`linesMin\` −10）⇒ ${anchorOf(loosened)}（必不符）；改紧一处（第二个 \`maxLineMax\` +1000）⇒ ${anchorOf(tightened)}（必不符）`);
    }
  }
t.finish();
}

/* 追加三节（由 apply-harness-edits.js 原样插入 `tests\harness-check.js` 的 `E103` 节之前） */
/* ==========================================================================
   二十四、`E178` **配置读点 ↔ 白名单**的**双向对账**（受管门禁化；`T-20261005-21`）
   --------------------------------------------------------------------------
   立案（`E178` 原文）：`server\http\routes\upload.js` 的 `CONFIG_KEY_PATHS` 已经是"**值维度的唯一权威**"
   （摘掉某项 ⇒ `E48②` 的指纹冲突判据必红），但"**代码新增了一个 config 读点、白名单没跟手**"这一失效
   模式此前**只有靠人工重跑探针** `tests\._verify\T-20261005-18\p-e48-config-coverage.js` 才发现。
   ⇒ 本节把那支探针的对账**搬进受管门禁**（口径逐条照抄，见下），并补 D22 定点变异。

   ⚠ **能力边界（照抄探针的自述，不含糊）**：这是**正则筛子**，不是证明 ——
     · 看不见动态键（`q()[k]`）、也看不见经中间变量间接读的键；
     · `mes.X` / `q().X` 是**局部变量**（`uploadReporter.js:193/220` 的 `mes` / `q()`）的读点，
       本节按"它们就是 `config.mes`"映射（映射口径写在 `SCAN_E178` 的每条注释里）；
     · 扫描前**逐行剥注释**（行号不变）—— 否则注释里提到的 `mes.baseUrl` 会被当成读点
       （实测 `uploadReporter.js` 有 5 处这样的注释）。
   ⚠ **面（明确写出，不许读成"全仓"）**：
     · **面 A（进白名单对账）**＝`config.X`（注入配置对象）＋ `q().X` ＋ `mes.X` 三种形态，
       源文件＝`server\services\uploadReporter.js`；白名单源＝`server\http\routes\upload.js` 的
       `CONFIG_KEY_PATHS`（**从盘上源码文本取，不 import** —— 免得"判据与运行期同源"退化成自证）。
     · **面 B（不进白名单，但必须逐条在册）**＝`boardConfig.mes.X` 形态，
       源文件＝`server\services\uploadQueue.js`。它读的是**磁盘那份** `src\config\board.config.js`
       而不是注入配置 ⇒ 按 `E179`（2026-10-05 落地）的口径**不属于行为指纹**；但它必须是**显式在册的
       例外**，否则"读点集合 ↔ 白名单集合"就成了**假双向**（把真读点当噪声 ignore 掉）。 */

t.section('二十四、`E178` 配置读点 ↔ 白名单**双向零差**（新增读点未登记 ⇒ 逐处指名）');
{
  /** 逐行剥注释（行注释 ＋ 块注释；**行号不变**）—— 与探针 `stripComments()` 同口径 */
  const stripCommentsE178 = lines => {
    let inBlock = false;
    return lines.map(text => {
      let out = '';
      let i = 0;
      if (inBlock) {
        const end = text.indexOf('*/');
        if (end < 0) return '';
        inBlock = false;
        i = end + 2;
      }
      while (i < text.length) {
        if (text.startsWith('//', i)) break;
        if (text.startsWith('/*', i)) {
          const end = text.indexOf('*/', i + 2);
          if (end < 0) { inBlock = true; break; }
          i = end + 2;
          continue;
        }
        out += text[i];
        i++;
      }
      return out;
    });
  };
  /* 读点形态（**一条正则、分支按"从具体到宽泛"排序**）——
     ⚠ 顺序是判据的一部分：`config\.` 若排在 `mes\.` 之前，`config.mes.retryCap` 会先被匹配成
     `config.mes` 而把 `.retryCap` **留在原地**，于是 `mes.` 分支再也匹配不到它 ⇒ **新增读点会漏报**。
     实测（2026-10-05）踩过这个坑 ⇒ 现在把 `q().X`（最具体）→ `mes.X` → `config.X` 排定。
     `boardConfig.mes.X` 是**另一条面**（磁盘真源，不进白名单，但必须逐条在册）。 */
  const SCAN_E178 = {
    re: /(\bq\(\)\.[A-Za-z_$][\w$]*)|((?<![.\w$])boardConfig\.mes\.[A-Za-z_$][\w$]*)|((?<![.\w$])(?<!board)config\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)|((?<![.\w])mes\.[A-Za-z_$][\w$]*)/g,
    kindOf: m => (m[1] ? 'q().<键>' : m[2] ? 'boardConfig.mes.<键>' : m[3] ? 'config.<路径>' : 'mes.<键>'),
    pathOf: m => {
      if (m[1] !== undefined) return 'mes.' + m[1].slice(4);                    /* `q().<键>` → mes.<键> */
      if (m[2] !== undefined) return 'mes.' + m[2].slice(16);                   /* `boardConfig.mes.<键>` */
      if (m[3] !== undefined) return m[3].slice(7);                             /* `config.<路径>` */
      return 'mes.' + m[4].slice(4);                                           /* `mes.<键>` */
    },
    diskOf: m => Boolean(m[2])
  };
  /** 扫一段**文本**（剥注释 ＋ 逐行匹配）—— 磁盘读取与**内存变异体**共用这一条路径 */
  const scanTextE178 = (text, rel) => {
    const raw = String(text).split(/\r?\n/);
    const hits = [];
    stripCommentsE178(raw).forEach((line, i) => {
      const re = new RegExp(SCAN_E178.re.source, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        hits.push({
          file: rel, line: i + 1, kind: SCAN_E178.kindOf(m), raw: m[0],
          path: SCAN_E178.pathOf(m), disk: SCAN_E178.diskOf(m)
        });
      }
    });
    return hits;
  };
  /** 扫一支文件：返回 `{file, line, kind, raw, path, disk}`；**先剥注释**，行号保持 */
  const scanReadPointsE178 = (file, rel) => scanTextE178(fs.readFileSync(file, 'utf8'), rel);
  /** 从盘上源码文本取 `CONFIG_KEY_PATHS`（取**真源文本**，不 import） */
  const whitelistFromSourceE178 = src => {
    const m = /const CONFIG_KEY_PATHS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(src);
    if (!m) return null;
    return (m[1].match(/'[^']+'/g) || []).map(s => s.replace(/'/g, ''));
  };
  /** 覆盖判定 —— 三种形态都算覆盖（与探针同口径）：
   *   ①相等；②白名单条目是它的前缀段（段级读点）；③它是白名单条目的前缀段（由该段逐键条目覆盖）。 */
  const coverKindE178 = (wl, p) => {
    if (wl.some(w => w === p)) return '逐键命中';
    if (wl.some(w => p.startsWith(w + '.'))) return '段级读点（由该段逐键条目覆盖）';
    if (wl.some(w => w.startsWith(p + '.'))) return '由段级白名单条目覆盖';
    return null;
  };
  /** **对账**（纯函数：喂"读点集合 ＋ 白名单 ＋ 在册例外清单"⇒ 逐项判定）—— D22 就喂给这个函数 */
  const reconcileE178 = (hitsAll, wl, diskRegistry) => {
    const injected = [...new Set(hitsAll.filter(h => !h.disk).map(h => h.path))].sort();
    const disk = [...new Set(hitsAll.filter(h => h.disk).map(h => h.path))].sort();
    const uncovered = injected.filter(p => coverKindE178(wl, p) === null);
    const phantom = wl.filter(w => !injected.some(p => p === w || p.startsWith(w + '.')));
    const diskUnregistered = disk.filter(p => !diskRegistry.includes(p));
    const diskStale = diskRegistry.filter(p => !disk.includes(p));
    return {
      injected, disk, uncovered, phantom, diskUnregistered, diskStale,
      at: p => hitsAll.filter(h => h.path === p).map(h => h.file + ':' + h.line).join('、')
    };
  };
  /** 「非注入配置」读点的**在册例外**（`E179` 的口径：真源＝磁盘那份 `board.config.js`）。
   *  ⚠ 新增一处 ⇒ 必须在这里加一行 —— 否则 `diskUnregistered` 非空 ⇒ **红并指名**。 */
  const DISK_READ_REGISTRY_E178 = ['mes.queueWarnThreshold'];

  const uploadSrcE178 = fs.readFileSync(path.join(env.paths.root, 'server', 'http', 'routes', 'upload.js'), 'utf8');
  const wlE178 = whitelistFromSourceE178(uploadSrcE178);
  if (wlE178 === null) {
    t.requires('E178 前提：能从 `server\\http\\routes\\upload.js` 盘上源码取到 `CONFIG_KEY_PATHS`（否则本节无从对账）',
      false, '取不到 `const CONFIG_KEY_PATHS = Object.freeze([…]);` —— 结构被改动了');
  }
  const wl0 = wlE178 || [];
  const hitsE178 = scanReadPointsE178(path.join(env.paths.root, 'server', 'services', 'uploadReporter.js'),
    'server\\services\\uploadReporter.js')
    .concat(scanReadPointsE178(path.join(env.paths.root, 'server', 'services', 'uploadQueue.js'),
      'server\\services\\uploadQueue.js'));
  const recE178 = reconcileE178(hitsE178, wl0, DISK_READ_REGISTRY_E178);

  t.requires('E178 前提：扫描面里两个方向的读数都非空（"读点 0 条／白名单 0 条"都会让双向对账退化成恒真）',
    recE178.injected.length > 0 && wl0.length > 0 && recE178.disk.length > 0,
    `注入配置读点 ${recE178.injected.length} 条、白名单 ${wl0.length} 条、非注入（磁盘真源）读点 ${recE178.disk.length} 条`);

  t.check('E178-① **双向零差**（受管门禁）：代码里的**注入配置读点集合** ↔ `CONFIG_KEY_PATHS` 白名单集合 —— ' +
    '①白名单里每一条都**必须**有对应读点（**凭空登记** ⇒ 逐条指名，它是"改了一个不生效的键会变假冲突"的来源）；' +
    '②每个读点都**必须**被白名单覆盖（**新增读点未登记** ⇒ 逐处指名 `文件:行号`，这就是 `E178` 立案的失效模式）；' +
    '③"非注入配置"读点（`boardConfig.*`，真源＝磁盘那份）不进白名单，但**必须逐条在册** ⇒ 未在册/已消失都红',
    recE178.uncovered.length === 0 && recE178.phantom.length === 0 &&
    recE178.diskUnregistered.length === 0 && recE178.diskStale.length === 0,
    (recE178.uncovered.length || recE178.phantom.length || recE178.diskUnregistered.length || recE178.diskStale.length)
      ? '判红：' +
        (recE178.uncovered.length
          ? `**新增读点未登记 ${recE178.uncovered.length} 条** —— ` +
            recE178.uncovered.map(p => `config.${p}（${recE178.at(p)}）`).join('；') +
            ' ⇒ 必须同步 `server\\http\\routes\\upload.js` 的 `CONFIG_KEY_PATHS`；'
          : '') +
        (recE178.phantom.length
          ? `**白名单里没有对应读点 ${recE178.phantom.length} 条** —— ` +
            recE178.phantom.map(p => `config.${p}`).join('、') + '（凭空登记会在"改了这个键"时制造假冲突）；'
          : '') +
        (recE178.diskUnregistered.length
          ? `**非注入读点未在册 ${recE178.diskUnregistered.length} 条** —— ` +
            recE178.diskUnregistered.map(p => `config.${p}（${recE178.at(p)}）`).join('、') +
            ` ⇒ 加进 \`DISK_READ_REGISTRY_E178\`（当前在册 ${JSON.stringify(DISK_READ_REGISTRY_E178)}）；`
          : '') +
        (recE178.diskStale.length
          ? `**在册但读点已消失 ${recE178.diskStale.length} 条** —— ` + recE178.diskStale.join('、')
          : '')
      : `注入配置读点 ${recE178.injected.length} 条 ⊆ 白名单 ${wl0.length} 条（**逐条有对应读点**）：` +
        recE178.injected.map(p => 'config.' + p).join('、') +
        `；非注入（磁盘真源）读点 ${recE178.disk.length} 条（在册 ${JSON.stringify(DISK_READ_REGISTRY_E178)}）：` +
        recE178.disk.map(p => 'config.' + p + '（' + recE178.at(p) + '）').join('、') +
        '；零差＝双向都空（两个方向都不是靠 ignore 达成的）');

  t.check('E178-② **负对照**（防"判据恒红"）：在 **同一份盘上源码** 上按上面的式子现算 ⇒ 两个方向都必须为空；' +
    '并给出"剥注释前后"的读数对照 —— 若把注释里的 `mes.xxx` 也当读点，剥注释这一半就会显形',
    recE178.uncovered.length === 0 && recE178.phantom.length === 0 &&
    hitsE178.length > 0 && hitsE178.every(h => h.line >= 1),
    `盘上现算：未覆盖 ${recE178.uncovered.length} 条（应 0）、凭空登记 ${recE178.phantom.length} 条（应 0）、` +
    `非注入未在册 ${recE178.diskUnregistered.length} 条（应 0）、在册但消失 ${recE178.diskStale.length} 条（应 0）；` +
    `扫描命中合计 ${hitsE178.length} 处（**剥注释后**）；` +
    `白名单＝[${wl0.map(w => 'config.' + w).join('、')}]`);

  /* `E178` D22（可证伪，**三支内存变异 ＋ 负对照**）：
     ㈠**凭空加一个读点**（内存里在 `uploadReporter.js` 副本里插一行 `config.mes.retryCap` 读点）⇒ 同一判据
        **必红**并**逐处指名文件:行号**（这正是 `E178` 立案的失效模式：`E48` 的池子会**静默漏掉**这个配置）；
     ㈡**凭空登记**（内存里往白名单加一条 `mes.notReadAnywhere`）⇒ `phantom` 非空 ⇒ 必红；
     ㈢**摘掉一个真读点**（内存里把 `q().queueCap` 那处读点去掉）⇒ 它的白名单条目变成 `phantom` ⇒ 必红；
     ㈣**负对照**＝盘上原件 ⇒ 两个方向都为空（必绿）；盘上两支文件**逐字节未变**。 */
  {
    const reporterPath = path.join(env.paths.root, 'server', 'services', 'uploadReporter.js');
    const uploadPath = path.join(env.paths.root, 'server', 'http', 'routes', 'upload.js');
    const reporterDisk = fs.readFileSync(reporterPath, 'utf8');
    const uploadDiskNow = fs.readFileSync(uploadPath, 'utf8');
    const withExtra = reporterDisk.replace('const mes = (config && config.mes) || {};',
      'const mes = (config && config.mes) || {};\nconst ANTH = (config && config.mes && config.mes.retryCap) || 0;');
    const extraHits = withExtra === reporterDisk
      ? null
      : scanTextE178(withExtra, 'server\\services\\uploadReporter.js（**内存变异体**）');
    const m1 = extraHits ? reconcileE178(extraHits.concat(hitsE178.filter(h => h.disk)), wl0, DISK_READ_REGISTRY_E178) : null;
    const m2 = reconcileE178(hitsE178, wl0.concat(['mes.notReadAnywhere']), DISK_READ_REGISTRY_E178);
    const withoutCap = reporterDisk.replace('q().queueCap', '0 /* 摘掉这一处读点（内存变异） */');
    const noCapHits = withoutCap === reporterDisk ? null : hitsE178.filter(h => h.raw !== 'q().queueCap');
    const m3 = noCapHits ? reconcileE178(noCapHits, wl0, DISK_READ_REGISTRY_E178) : null;
    const recNow = reconcileE178(hitsE178, wl0, DISK_READ_REGISTRY_E178);
    t.check('E178-③ D22（可证伪，**三支内存变异 ＋ 负对照**）：㈠源码副本里凭空加一处 `config.mes.retryCap` 读点 ⇒ ' +
      '同一判据**必红**且 `uncovered` **逐处指名**该读点；㈡白名单副本里凭空加一条 ⇒ `phantom` 必红；' +
      '㈢源码副本里摘掉一处**真读点**（`q().queueCap`）⇒ 对应的白名单条目变 `phantom` ⇒ 必红；' +
      '㈣负对照＝盘上原件 ⇒ 双向皆空（必绿）；盘上两支文件**逐字节未变**',
      m1 !== null && m1.uncovered.includes('mes.retryCap') && m1.phantom.length === 0 &&
      m2.uncovered.length === 0 && m2.phantom.includes('mes.notReadAnywhere') &&
      m3 !== null && m3.phantom.includes('mes.queueCap') &&
      recNow.uncovered.length === 0 && recNow.phantom.length === 0 &&
      fs.readFileSync(reporterPath, 'utf8') === reporterDisk && fs.readFileSync(uploadPath, 'utf8') === uploadDiskNow,
      `㈠加读点 ⇒ uncovered=[${m1 ? m1.uncovered.join('、') : '（变异未命中源码形态 ⇒ 本支不作数）'}]、phantom=${m1 ? m1.phantom.length : 'n/a'}；` +
      `㈡加白名单 ⇒ phantom=[${m2.phantom.join('、')}]；㈢摘读点 ⇒ phantom=[${m3 ? m3.phantom.join('、') : '（变异未命中 ⇒ 本支不作数）'}]；` +
      `㈣负对照 ⇒ uncovered=${recNow.uncovered.length}／phantom=${recNow.phantom.length}；` +
      `盘上逐字节未变=${fs.readFileSync(reporterPath, 'utf8') === reporterDisk && fs.readFileSync(uploadPath, 'utf8') === uploadDiskNow}`);
  }
}

/* ==========================================================================
   二十五、`E183` 台账渲染器的**转义／保真判据**（`T-20261005-21`）
   --------------------------------------------------------------------------
   事故（`E183` 立案）：仓外台账渲染器把注记**直接内插**进单引号 JS 字符串 ⇒
     ①注记里的 ASCII 单引号（`reportPlaceholder='65535'`）**把生成器语法写崩**；
     ②**反斜杠被吃掉**：注记里的 `\t` 在渲染时变成**真 TAB**、`\.` 变成 `.`
       ⇒ **渲染出的台账文本与注记原文不一致**（实测历史残留 3 条，已一次性转义修正）。
   工具已重写为"反斜杠 → `\\`、单引号 → `\u0027`、换行 → 空格"，但"**渲染文本 ＝ 注记原文**"
   这件事此前**没有机器判据** —— 本节的判据正是补这个洞。

   ⚠ **地面（如实标注：我在仓内能读到什么、读不到什么）**：
     · **读得到**：渲染**产物**（`项目记录\当前状态快照.md` 的「当前开口」块、路线图的债行）与
       `b-add.js` 的**转义算法**（三条规则写在 `E183` 行的立案文字里）；
     · **读不到**：注记的**原始字节**（在仓外输入文件里，不入库） ⇒ 本节**不做**"与原始注记逐字符比"
       这种拿不到地面的断言（那会是一条永远绿的假判据）。
     · ⇒ 判据落成**两半**，各自可独立证伪：
       ①**产物面**：渲染文本里**不得出现 TAB／C0 控制字符**，且行内每个"转义写法"必须处在
         `escape()` 的**不动点**上（`unescape(render) === render` ⇒ 它**不是**被 JS 字符串解析后留下的残渣）；
       ②**算法面**：`escape()` ⊕ `unescape()` 对含 `\t` / `\n` / `'` / `\` 的样本文本**往返恒等**，
         并**登记冻结点**（逐例"原文 ⇒ 渲染串"的精确对，**常量、不由产物现算**）⇒ 谁悄悄改宽/改窄
         转义算法都当场显形。
     ⚠ **如实登记一条地面边界**：当前「当前开口」块**不含任何反斜杠** ⇒ 产物面的"不动点"那半在**真实台账
       上处于未行使（vacuously true）状态**；它的判别力由本节 D22 在**合成行**上逐支证明（不靠"碰巧
       有一行带 `\t`"）。 */

t.section('二十五、`E183` 台账渲染器：产物无 TAB/控制字符 ＋ 转义算法往返恒等 ＋ 冻结点');
{
  const crypto25 = require('node:crypto');
  const sha12_25 = s => crypto25.createHash('sha256').update(s).digest('hex').slice(0, 12);

  /** 台账渲染器（`b-add.js`）的**转义算法**。四条规则（前两条是 `E183` 立案文字里那三条的
   *  **顺序修正版**，见下），`raw` 一侧一律是**注记的原始字节**：
   *    ① 真换行 → 空格（台账一行一条）
   *    ② 真 TAB → `\t`（**这一步是 `E183` 事故的直接对应**：不做它 ⇒ 渲染文本里出现真 TAB）
   *    ③ 反斜杠 → `\\`（**放在 ①② 之后**：先把控制字符写成可见转义，再把**原本就有的**反斜杠加倍，
   *       否则 ② 造出来的那一个反斜杠会被 ③ 再加一倍 ⇒ 渲染串里出现 `\\t`）
   *    ④ 单引号 → `\u0027`（否则把单引号 JS 字符串写崩）
   *  ⚠ **如实登记一处口径修正**：`E183` 立案文字把工具的三条规则写作
   *    "反斜杠 → `\\`、单引号 → `\u0027`、换行 → 空格"（**没提 TAB**）。若照那个顺序、且**不做 TAB**，
   *    那么"注记里的 `\t`"在渲染后**必然**是真 TAB —— 正是立案的事故。本节的算法面因此把顺序写明
   *    并补上 TAB 规则；冻结点把这一版的**精确对**冻住，谁改宽/改窄/改序都当场显形。 */
  function escapeNoteE183(s) {
    const H = { '\t': '\u0001', '\n': '\u0002', '\r': '\u0003', '\\': '\u0004', "'": '\u0005' };
    const R = { '\u0001': '\\t', '\u0002': '\\n', '\u0003': '\\r', '\u0004': '\\\\', '\u0005': '\\u0027' };
    return String(s)
      .replace(/[\t\n\r\\']/g, ch => H[ch])            // ① 先把"要转义的那一类字符"换成占位符（一步扫描，互不叠加）
      .replace(/\u0001/g, R['\u0001']).replace(/\u0002/g, R['\u0002'])
      .replace(/\u0003/g, R['\u0003']).replace(/\u0004/g, R['\u0004'])
      .replace(/\u0005/g, R['\u0005']);                // ② 占位符 → 各自的转义写法
  }
  /** `escape()` 的**严格逆**（只认本算法造得出的那几种形态；喂进真控制字符 ⇒ 返回 null ＝"不在不动点"） */
  function unescapeNoteE183(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s[i])) return null;
      if (s[i] === '\\') {
        if (s[i + 1] === '\\') { out += '\\'; i++; continue; }
        if (s[i + 1] === 't') { out += '\t'; i++; continue; }
        if (s[i + 1] === 'n') { out += '\n'; i++; continue; }
        if (s[i + 1] === 'r') { out += '\r'; i++; continue; }
        if (s.substr(i + 1, 5) === 'u0027') { out += "'"; i += 5; continue; }
        return null;                                       // 算法造不出的写法 ⇒ 判"不在不动点"
      }
      out += s[i];
    }
    return out;
  }
  /** 冻结点（`E145` 机制）：逐例的**精确对**（**常量、不由产物现算**）＋ 其 `sha12` */
  const E183_ESCAPE_CASES = [
    { raw: 'tests\\._verify\\t13', rendered: 'tests\\\\._verify\\\\t13' },
    { raw: 'reportPlaceholder=\'65535\'', rendered: 'reportPlaceholder=\\u002765535\\u0027' },
    { raw: 'mes.pathTemplate', rendered: 'mes.pathTemplate' },
    { raw: 'a\tb', rendered: 'a\\tb' },
    { raw: 'a\nb', rendered: 'a\\nb' },
    { raw: 'C:\\x\\y', rendered: 'C:\\\\x\\\\y' }
  ];
  const E183_ANCHOR = { total: 6, sha12: 'ca04a7fe97ac' };
  /** 「逐字保真」的**在册样本**：渲染产物里必须**原样在位**的反斜杠序列（`E183` 立案的正是"它们被吃掉"）。
   *  ⚠ 这是**产物侧**的可证伪读数：谁把渲染器改回"不转义/少转义"，这些串就会缺一反斜杠 ⇒ 本判据当场红。 */
  const E183_VERBATIM_PROBES = [
    { seq: 'tests\\._verify\\t13', where: '`E183` 立案文字里点名的那个形态（路径 ＋ 文件名）' },
    { seq: 'server\\http\\routes\\upload.js', where: '受管源码路径（`E178`／`E87` 行）' },
    { seq: 'tests\\harness-check.js', where: '门禁脚本路径' }
  ];
  const e183AnchorNow = sha12_25(E183_ESCAPE_CASES.map(c => c.raw + '\u0001' + c.rendered).join('\n'));

  /** 「当前开口」块的定位（快照）；块＝从含 `**当前开口` 的行起，到下一个非 `>` 非空行为止 */
  const snapshotPath = path.join(env.paths.root, '项目记录', '当前状态快照.md');
  const snapshotText = fs.readFileSync(snapshotPath, 'utf8');
  const snapshotLines = snapshotText.split('\n');
  const openIdx = snapshotLines.findIndex(l => l.indexOf('**当前开口') >= 0);
  let openEnd = openIdx;
  if (openIdx >= 0) {
    while (openEnd < snapshotLines.length &&
      (snapshotLines[openEnd].trim() === '' || snapshotLines[openEnd].startsWith('>'))) openEnd++;
  }
  const openLines = openIdx >= 0 ? snapshotLines.slice(openIdx, openEnd) : [];

  /** 产物面判据（纯函数 —— D22 喂给的就是它）：返回违规清单（**逐处指名**）
   *  ⚠ **口径（正则筛子，不是证明；每一处偏差都写明）**：
   *    · ①**真 TAB／C0 控制字符**：无争议的失真（`E183` 事故的形态）。
   *    · ②`\t`／`\n`／`\r` **且后一个字符不在 {字母数字、非 ASCII 字母、反引号}** 里
   *      （或就此到行尾）；`\b`／`\f`／`\v` **一律**判红（它们在路径里不会出现）；
   *      这类写法一进 JS 字符串就会还原成控制字符 ⇒ 台账里出现**看不见的换行／制表**。
   *      ⚠ **为什么这么窄**：`tests\._verify\t13`（`\t` 后跟数字）、`\b`/`\r` 后跟汉字、
   *      以及**引用这个形态本身的**写法（`` `\t` 在渲染时变成真 TAB ``，`\t` 后跟反引号）
   *      **都完全合法** —— 只按 `\t` 一刀切会**假红**（实测踩过三次，`E183` 立案文字自己就含这个写法）。
   *      代价（如实登记）：`\t13` 这种"转义后紧跟字母数字"的退化形态**不判红** —— 它不做坏事
   *      （显示成 `t13`，无控制字符）；"**逐字保留**"由下面 `E183_VERBATIM_PROBES` 在册样本守。
   *    · ③**乱码形态** `\\u` 后面不是 4 位 hex（`\u0027` 是唯一的合法 `\u` 写法）⇒ 判红。 */
  const E183_BAD_ESCAPE = /\\([tnr])(?![0-9A-Za-z\u00C0-\u024F\u4E00-\u9FFF`])|\\([bfv])|\\u(?![0-9A-Fa-f]{4})/;
  function renderViolationsE183(lines, label) {
    const out = [];
    lines.forEach((l, i) => {
      const tab = /\t/.exec(l);
      const ctrl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.exec(l);
      if (tab) {
        out.push(label + ':' + (i + 1) + ' 含**真 TAB**（U+0009，位置 ' + tab.index + '）—— 渲染器把注记里的反斜杠序列直接内插了');
      } else if (ctrl) {
        out.push(label + ':' + (i + 1) + ' 含控制字符 U+' +
          ctrl[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '（位置 ' + ctrl.index + '）');
      }
      const bad = E183_BAD_ESCAPE.exec(l);
      if (bad) {
        out.push(label + ':' + (i + 1) + ' 含**会还原成控制字符的转义写法** `\\' + (bad[1] || bad[2] || 'u') + '`（位置 ' + bad.index +
          '，上下文 `' + l.slice(Math.max(0, bad.index - 10), bad.index + 14) +
          '`）—— 在册的合法写法：`\\\\`（反斜杠加倍）、`\\u0027`（单引号）、以及反斜杠 ＋ **字母数字**的路径/文件名形态（如 `tests\\._verify\\t13`）');
      }
    });
    return out;
  }
  const e183Violations = renderViolationsE183(openLines, '当前状态快照.md「当前开口」块');

  t.requires('E183 前提：「当前开口」块可定位且非空（否则下面的产物面判据无从判定）',
    openIdx >= 0 && openLines.length > 0,
    `块起始行=${openIdx + 1}、行数=${openLines.length}`);

  t.check('E183-① **产物面**：渲染出的台账文本（快照「当前开口」块的每一行）**不得含真 TAB 与任何 C0 控制字符**，' +
    '也不得含"**会还原成控制字符的转义写法**"（`\\t`／`\\n`／`\\r`／`\\b`／`\\f`／`\\v` 且后一个字符**不是**字母数字或非 ASCII 字母；`\\u` 后不是 4 位 hex）—— ' +
    '违规 ⇒ **逐处指名「行号 ＋ 字符位置 ＋ 上下文」**；路径分隔符形态（`\\s`／`\\.`／`\\接`／`\\t13`…）**不判红**（台账里到处是 Windows 路径）；' +
    '并给"逐字保留"的**在册样本**读数：`tests\\._verify\\t13` 这类"路径 ＋ 文件名"必须**原样在位**（丢一个反斜杠即计为缺失）',
    e183Violations.length === 0 && openLines.length > 0 &&
    E183_VERBATIM_PROBES.every(p => snapshotText.includes(p.seq)),
    e183Violations.length
      ? `判红：${e183Violations.length} 处 —— ` + e183Violations.join('；')
      : '「当前开口」块 ' + openLines.length + ' 行：TAB **0** 处、C0 控制字符 **0** 处；' +
        '逐字保留的在册样本 ' + E183_VERBATIM_PROBES.length + ' 条全部在位：' +
        E183_VERBATIM_PROBES.map(p => JSON.stringify(p.seq) + '（' + p.where + (snapshotText.includes(p.seq) ? ' ✓' : ' ✗ 缺失') + '）').join('、'));

  t.check('E183-② **算法面**：渲染器的转义算法 `escape()` 对含**反斜杠／单引号／换行／TAB** 的样本文本满足 ' +
    '`unescape(escape(x)) === x`（往返恒等，**保真**），且 `escape(x)` 里**不含真 TAB 与控制字符**；' +
    '并把它与**冻结点**（逐例"原文 ⇒ 渲染串"的精确对，**常量、不由产物现算**）比对 —— ' +
    '谁悄悄改宽/改窄转义算法（例如让 `\\t` 不转义）⇒ 逐例不符 ＋ 冻结点 `sha12` **必不符**并指名',
    E183_ESCAPE_CASES.every(c => escapeNoteE183(c.raw) === c.rendered) &&
    E183_ESCAPE_CASES.every(c => unescapeNoteE183(escapeNoteE183(c.raw)) === c.raw) &&
    E183_ESCAPE_CASES.every(c => !/[\t\u0000-\u001F]/.test(escapeNoteE183(c.raw))) &&
    E183_ANCHOR.total === E183_ESCAPE_CASES.length &&
    E183_ANCHOR.sha12 === e183AnchorNow,
    `逐例渲染（现算）：` +
    E183_ESCAPE_CASES.map(c => `${JSON.stringify(c.raw)} ⇒ ${JSON.stringify(escapeNoteE183(c.raw))}` +
      `（期望 ${JSON.stringify(c.rendered)}${escapeNoteE183(c.raw) === c.rendered ? ' ✓' : ' ✗'}）`).join('；') +
    `；冻结点 total ${E183_ANCHOR.total}／sha12 ${E183_ANCHOR.sha12}（现算 ${e183AnchorNow}）`);

  t.check('E183-③ 每轮渲染的 `sha12` **登记**（读数，非阈值）：把「当前开口」块的字节、算法冻结点、快照全文 ' +
    '各登记一个 `sha12` —— 让"渲染器被改动"与"台账被改动"在下一次渲染时**可被逐个读出来**。' +
    '⚠ 本条**只登记读数、不拿它判红**（值随台账正常追加而变）；判红的责任在 `E183-①②` 与 D22',
    openLines.length > 0 && /^[0-9a-f]{12}$/.test(e183AnchorNow) &&
    /^[0-9a-f]{12}$/.test(sha12_25(openLines.join('\n'))),
    `开口块字节 sha12=${sha12_25(openLines.join('\n'))}（${openLines.join('\n').length} 字符）；` +
    `算法冻结点 sha12=${e183AnchorNow}；快照全文 sha12=${sha12_25(snapshotText)}`);

  /* `E183` D22（可证伪，**四支内存变异 ＋ 负对照**，各点名一条判据）：
     ㈠**把 `\\t` 退回"不转义"**（＝立案的事故形态：注记里的 `\t` 直接内插 ⇒ 渲染成真 TAB）⇒ `E183-①` 必红；
     ㈡**多转义一层**（`\\t` → `\\\\t`）⇒ 逆转义后与原文不等 ⇒ `E183-①` 的**不动点**那半必红；
     ㈢**摘掉算法的反斜杠规则** ⇒ 逐例渲染串与冻结点不符 ⇒ `E183-②` 必红、冻结点 `sha12` 必不符；
     ㈣**摘掉算法的单引号规则** ⇒ 渲染串里留下**裸单引号**（会写崩单引号 JS 字面量）⇒ `E183-②` 必红；
     ㈤负对照＝盘上现测 ⇒ 全绿；盘上快照**逐字节未变**。
     ⚠ 合成行（`PROBE_LINE`）只用于**变异与负对照**：它把"产物面"的两支测到，而不依赖真实台账里
        碰巧有一行带 `\t`（否则这三支会变成"因为没命中所以通过"的空转）。 */
  {
    /** 负对照样本行：含 `\\t`（**已转义 ＋ 后跟空格** ⇒ 合法）、`\\u0027`、以及合法的路径反斜杠。
     *  ⚠ "合法"的判据口径见 `E183_BAD_ESCAPE` 的注释：`\t` 后跟**空格**＝会被 JS 吃成真 TAB ⇒ 判红；
     *    后跟**反引号**（`` `\t` 在渲染时… `` 这种**引用该形态本身**的写法）⇒ 在册、不判红。 */
    const PROBE_LINE = '| **E999** | 探针行：注记里的 `\\t` 后跟空格、`\\u0027` 与路径 `\\.\\s` |';
    const probeSet = [PROBE_LINE];
    const vNeg = renderViolationsE183(probeSet, '负对照');
    const v1a = renderViolationsE183([PROBE_LINE.replace('\\t', '\t')], '变异㈠a');
    const v1b = renderViolationsE183(['| **E999** | 注记里的 \t 直接内插 |'], '变异㈠b');
    const v1c = renderViolationsE183([openLines[0] + '\t'], '变异㈠c');
    const noBackslashRule = s => String(s)
      .replace(/[\t\n\r']/g, ch => ({ '\t': '\\t', '\n': '\\n', '\r': '\\r', "'": '\\u0027' })[ch]);
    const noQuoteRule = s => String(s)
      .replace(/[\t\n\r\\]/g, ch => ({ '\t': '\\t', '\n': '\\n', '\r': '\\r', '\\': '\\\\' })[ch]);
    const renderedNoBackslash = E183_ESCAPE_CASES.map(c => noBackslashRule(c.raw));
    const renderedNoQuote = E183_ESCAPE_CASES.map(c => noQuoteRule(c.raw));
    const m3CasesOk = renderedNoBackslash.every((r, i) => r === E183_ESCAPE_CASES[i].rendered) &&
      renderedNoBackslash.every((r, i) => unescapeNoteE183(r) === E183_ESCAPE_CASES[i].raw);
    const m4BareQuote = renderedNoQuote.some(r => r.replace(/\\u0027/g, '').includes("'"));
    const m4CasesOk = renderedNoQuote.every((r, i) => r === E183_ESCAPE_CASES[i].rendered);
    const anchorNoBackslash = sha12_25(renderedNoBackslash.map((r, i) => E183_ESCAPE_CASES[i].raw + '\u0001' + r).join('\n'));
    t.check('E183-D22 定点变异（**四支内存变异 ＋ 负对照**，各点名一条判据）：' +
      '㈠a 把样本行里的 `\\\\t` 退回"不转义"（`\\\\t` → `\\t`，后跟空格 ⇒ 一进 JS 字符串就是真 TAB）、' +
      '㈠b 造一行"注记里的转义序列**直接内插**"、㈠c 往一行里插一个**真 TAB** ⇒ 三支都必须被 `E183-①` **抓住并指名字符位置**；' +
      '㈡**多转义一层**／改宽 ⇒ `E183-②` 的逐例冻结点**必不符**（`sha12` 改）；' +
      '㈢摘掉算法的反斜杠规则 ⇒ 逐例渲染串与冻结点不符（往返恒等也破）⇒ `E183-②` **必红**且冻结点 `sha12` 必不符；' +
      '㈣摘掉单引号规则 ⇒ 渲染串里留下**裸单引号**（会写崩单引号 JS 字面量）⇒ `E183-②` **必红**；' +
      '㈤负对照（含合法样本行）⇒ 全绿；盘上快照**逐字节未变**',
      vNeg.length === 0 && v1a.length > 0 && v1b.length > 0 && v1c.length > 0 &&
      m3CasesOk === false && m4BareQuote === true && m4CasesOk === false &&
      e183Violations.length === 0 && anchorNoBackslash !== e183AnchorNow &&
      fs.readFileSync(snapshotPath, 'utf8') === snapshotText,
      `㈠a \`\\\\t\` 退回不转义 ⇒ 判红 ${v1a.length} 处（首处：${v1a[0] || '（无）'}）；` +
      `㈠b "反斜杠序列直接内插" ⇒ 判红 ${v1b.length} 处（首处：${v1b[0] || '（无）'}）；` +
      `㈠c 插真 TAB ⇒ 判红 ${v1c.length} 处（首处：${v1c[0] || '（无）'}）；` +
      `㈢摘反斜杠规则 ⇒ "逐例相符＋往返恒等"=${m3CasesOk}（应 false）、冻结点现算 ${anchorNoBackslash} ≠ ${e183AnchorNow}；` +
      `㈣摘单引号规则 ⇒ 留裸单引号=${m4BareQuote}、逐例相符=${m4CasesOk}（应 false）；` +
      `㈤负对照（含合法样本行）⇒ 判红 ${vNeg.length} 处；` +
      `盘上逐字节未变=${fs.readFileSync(snapshotPath, 'utf8') === snapshotText}`);
  }
}

/* ==========================================================================
   二十六、`E72①⑥⑦⑧` 的定点收口（`T-20261005-21`）
   --------------------------------------------------------------------------
   `E72` 是 `E69` 收口时带走的遗留清单；本段只做**能做成机器判据**的四项 —— 判据式子一条不改实现：
     · **① 开工数的跨实现可证伪构造**：服务端 `/health.stats.startedQty` ↔ **自写超集 SQL** 现算
       （`COUNT(DISTINCT unit_index) WHERE unit_index IS NOT NULL AND collect_time ∈ 当班窗口`），
       并用**合成序列**证伪"超集构造"本身（`min` 封顶会漂、`COUNT(*)` 不去重会漂）。
     · **⑥ `addRunSec ≤ runSec` 上界耦合**（裁定：**加门禁守不变量、不改算式**）。
     · **⑦ `E70` 门禁卫生**：只做**可判定**的那半（`logic-check` 的 `byMeasures(n)` 消歧 ＋ 与
       `stats.js` 的补集口径逐点对账）；`E70①` **未做**（理由见回执"未验到/偏差"）。
     · **⑧ harness「真计数②③④」的定点变异**：把§十五那三条判据的**判据式子**逐字抽出来喂合成现场。
   本段全部在**进程内**做（一用例一库；不真起服务 ⇒ 不占端口、不写生产目录）。 */

t.section('二十六、`E72①⑥⑦⑧`（开工数跨实现可证伪／`addRunSec` 上界／`E70②`／真计数定点变异）');
{
  /* ---------------- `E72①`：开工数的**跨实现可证伪构造** ---------------- */
  const dbApiE72 = require('../server/db');
  const { createShiftRules } = require('../server/services/shift');
  const snapshotSvcE72 = require('../server/services/stateSnapshot');

  /** **超集构造**（独立于实现的自写 SQL）：按 `stateSnapshot.js` 文档的真源口径现算开工件数。
   *  口径（逐字对齐 `stateSnapshot.js:40`）：`startedQty ← measure_rt`（`unit_index` **去重**件数，
   *  窗口按帧 `collect_time`）。**刻意比实现宽**（用去重值 —— 元组去重 ≤ 件去重 ⇒ 真值 ≤ 参考值），
   *  于是"实现多算一件"与"少算一件"两个方向都当场显形。 */
  const startedSupersetE72 = (db, win) => Number(db.prepare(
    'SELECT COUNT(DISTINCT proc_order_no || \'#\' || unit_index) AS c FROM measure_rt ' +
    'WHERE unit_index IS NOT NULL AND unit_index <> \'\' AND collect_time >= ? AND collect_time < ?')
    .get(win.start, win.end).c);

  /** **合成序列**证伪超集构造本身（不依赖盘上数据）：`{at, unit}` 序列 ⇒ 三种口径的读数 */
  const synthStartedE72 = (frames, win) => {
    const inWin = frames.filter(f => f.at >= win.start && f.at < win.end);
    return {
      distinctUnits: new Set(inWin.filter(f => f.unit !== null && f.unit !== '').map(f => f.unit)).size,
      distinctPairs: new Set(inWin.filter(f => f.unit !== null && f.unit !== '').map(f => f.ticket + '#' + f.unit)).size,
      rows: inWin.filter(f => f.unit !== null && f.unit !== '').length,
      minCapped: Math.min(inWin.length, new Set(inWin.filter(f => f.unit !== null && f.unit !== '').map(f => f.unit)).size)
    };
  };
  const e72Win = { start: '2026-10-05 08:00:00', end: '2026-10-05 16:00:00' };
  const e72Frames = [
    { at: '2026-10-05 08:00:01', ticket: 'T1', unit: 1 },
    { at: '2026-10-05 08:00:02', ticket: 'T1', unit: 1 },     // 同一件第二帧（**不得**再计一件）
    { at: '2026-10-05 08:00:03', ticket: 'T1', unit: 2 },
    { at: '2026-10-05 08:00:04', ticket: 'T2', unit: 1 },     // 另一票的同一件号
    { at: '2026-10-05 08:00:05', ticket: 'T2', unit: null },  // 缺件序号帧（**不得**计入）
    { at: '2026-10-05 07:59:59', ticket: 'T2', unit: 3 },     // 窗口**之前**（不得计入）
    { at: '2026-10-05 16:00:00', ticket: 'T2', unit: 4 }      // 窗口**上沿**（半开区间 ⇒ 不计入）
  ];
  const e72Synth = synthStartedE72(e72Frames, e72Win);

  const e72Tmp = harness.makeTempDb({ name: 'e72-started-qty' });
  dbApiE72.initSchema(e72Tmp.db, '2026-10-05 08:00:00');
  /* ⚠ **`T-20261005-28`（本条的时钟依赖修复）—— 改这里之前先读完这一段** ---------------------
     病灶（盘上实测的假红，`T-20261005-21` 交付时是绿的）：本用例把"当班窗口"由**班次真源现算**，
     却把**实现侧的时刻**交给了**系统时钟** —— `createStateSnapshot()` 的 `now` 选项要的是**时钟函数**
     （`() => Date`，见 `stateSnapshot.js:571-573`：不是函数就回落 `platformClock.createClock({mode:'real'})`），
     而 `snapshot()` **无参**（`stateSnapshot.js:865`：`const now = platformClock.toDate(nowFn())`）
     ⇒ 旧写法 `createStateSnapshot({ …, now: '2026-10-05 10:00:00' })` 与 `snapshot('2026-10-05 10:00:00')`
     **传进去的字符串被整个忽略**，实现侧用的是**跑门禁那一刻的真实时刻**。
     后果：夹具的帧写死在 08:00:01~08:00:05（早班窗口），而实现侧的窗口 = `shift.at(真实时刻)` ⇒
     **真实时刻落在早班（08:00~16:00）时，两边同窗、绿色**；一旦真实时刻越过 16:00（或早于 08:00），
     实现侧换到中班／晚班窗口 ⇒ 该窗口内一帧都没有 ⇒ `startedQty=0` 而自写 SQL（按夹具窗口）读 3
     ⇒ 本条与 `E72①-D22` **同刻双红**。实测：`2026-10-05 15:xx` 绿、`2026-10-05 17:26` 红。
     修法（**只修判据、不动实现、不放宽期望**）：窗口与实现侧时刻**都由同一个固定时刻派生** ——
     注入 `createClock({ mode:'fixed', at: E72_AT })`（`tests\lib\clock.js` 的夹具时钟，
     与 `platform/clock.js` 的共同子集就是 `source()`，`stateSnapshot.js:571` 认这个形状），
     帧也由**同一个窗口**的 `win.start` 推出 ⇒ **与本机系统时钟、与"跑在哪个班次"完全无关**，
     在任何时刻、任何机器上都复现同一结论（门禁的可重复性要求；见回执"为什么不能依赖系统时钟"）。
     期望值一个字都没放宽：仍是 `refStartedE72 === implStartedE72 && refStartedE72 === 3`
     与 `rowsE72 === 4 && implStartedE72 === 3`。 */
  const E72_AT = '2026-10-05 10:00:00';              /* 唯一固定时刻（班次窗口与实现侧时刻同源） */
  const rulesE72 = createShiftRules(boardConfig.shift);
  const shiftE72 = rulesE72.at(E72_AT);
  if (!shiftE72) {
    t.requires('E72① 前提：班次真源能给出固定时刻所属班次（窗口与实现侧时刻都由它派生）',
      false, `createShiftRules(boardConfig.shift).at('${E72_AT}') 返回 null`);
  }
  const winE72 = shiftE72 ? { start: shiftE72.startAt, end: shiftE72.endAt } : e72Win;
  /** 把 `win.start` 往后推 n 秒（DR-16 文本 `YYYY-MM-DD HH:MM:SS`）—— 保证帧**确实落在窗口内**。
   *  ⚠ **不能**经 `toISOString()`：那会把本地时刻转成 UTC（实测把 08:00:01 变成 00:00:01 ⇒
   *  帧落到窗口之外、两侧读数都成了 0 —— 本条自己踩过）。这里按**本地时刻**逐字段拼文本。 */
  const atWinE72 = n => {
    const d = new Date(Date.parse(String(winE72.start).replace(' ', 'T')) + n * 1000);
    const p = v => String(v).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };
  /* 造两票两件 + 一件多帧 + 一帧缺件序号（**只写库，不改编实现**） */
  const insTaskE72 = e72Tmp.db.prepare('INSERT INTO task (proc_order_no, product_code, plan_qty, ' +
    'plan_start_time, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  insTaskE72.run('T1', 'P-A', 2, atWinE72(1), atWinE72(1), atWinE72(1));
  insTaskE72.run('T2', 'P-A', 2, atWinE72(1), atWinE72(1), atWinE72(1));
  const insMeasure = e72Tmp.db.prepare('INSERT INTO measure_rt (equip_code, proc_order_no, unit_index, ' +
    'measure_depth, speed, collect_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insFrameE72 = (ticket, unit, seconds) =>
    insMeasure.run('EQ-E72', ticket, unit, 5.0, 5.0, atWinE72(seconds), atWinE72(seconds));
  insFrameE72('T1', 1, 1);
  insFrameE72('T1', 1, 2);        // 同件第二帧（**不得**再计一件）
  insFrameE72('T1', 2, 3);
  insFrameE72('T2', 1, 4);
  insFrameE72('T2', null, 5);     // 缺件序号帧（**不得**计入）
  /* 实现侧读数：**与生产同一口**（`createStateSnapshot()`；不另写第二份取数）
     ⚠ `now` **必须传时钟函数**（`nowFn` 形态），不能传时刻字符串 —— 传字符串会被静默忽略并回落
     系统时钟（`T-20261005-28` 的病灶，见本段开头那一段）。这里给的是**与窗口同源**的固定夹具时钟。 */
  const clockE72 = createClock({ mode: 'fixed', at: E72_AT });
  const snapshotFnE72 = snapshotSvcE72.createStateSnapshot({ db: e72Tmp.db, config: boardConfig, now: clockE72.source() });
  const snapE72 = snapshotFnE72();                    /* `snapshot()` 无参：时刻只由注入时钟给（D17） */
  const implStartedE72 = snapE72 && snapE72.stats ? snapE72.stats.startedQty : null;
  const refStartedE72 = startedSupersetE72(e72Tmp.db, winE72);

  t.check('E72① **开工数的跨实现可证伪构造**：①服务端读数（`createStateSnapshot().stats.startedQty`，**生产同一口**）' +
    '＝自写**超集 SQL** 现算（`COUNT(DISTINCT unit_index) WHERE unit_index IS NOT NULL AND collect_time ∈ 当班窗口`）；' +
    '②**合成序列证伪构造本身**：同一件两帧 ⇒ 只计 1 件（`COUNT(*)` 会多算 ⇒ 与去重口径**必不同**）、' +
    '缺件序号帧 ⇒ 不计入（`unit_index IS NULL` 被排除 ⇒ 与既有无件序号口径一致）、窗口半开区间 ⇒ 上沿那一帧不计；' +
    '③读数以**当班窗口**为准（窗口由 `shift.at()` 现算），且**实现侧时刻走注入时钟**' +
    '（`createClock({mode:\'fixed\', at})`）⇒ 与本机系统时钟／当前班次无关（`T-20261005-28` 修的红：' +
    '旧写法把时刻字符串传给 `now` 会被静默忽略、回落真实时钟 ⇒ 过了 16:00 当场双红）',
    refStartedE72 === implStartedE72 && refStartedE72 === 3 &&
    e72Synth.distinctPairs === 3 && e72Synth.distinctUnits === 2 && e72Synth.rows === 4 &&
    e72Synth.distinctPairs !== e72Synth.rows && e72Synth.distinctUnits !== e72Synth.distinctPairs,
    `窗口 [${winE72.start}, ${winE72.end})：实现 startedQty=${implStartedE72}、自写超集 SQL（按 (票,件) 去重）=${refStartedE72}（应相等且＝3 —— 两票的件 1/2 与 T2 的件 1）；` +
    `合成序列（7 帧，含同件第二帧／缺件序号帧／窗口外帧／上沿帧）：**去重(票,件)对**=${e72Synth.distinctPairs}、` +
    `**仅按件号去重**=${e72Synth.distinctUnits}、**行数**=${e72Synth.rows} ⇒ ` +
    `\`COUNT(*)\` 口径会给出 ${e72Synth.rows}（≠ 对的去重口径 ${e72Synth.distinctPairs}）、` +
    `\`COUNT(DISTINCT unit_index)\` 会给出 ${e72Synth.distinctUnits}（同样不对）⇒ 本判据把这两支都抓得住；` +
    `\`min\` 封顶口径=${e72Synth.minCapped}`);

  t.check('E72①-D22（可证伪，**内存变异**）：把"去重"从自写 SQL 里去掉（`COUNT(DISTINCT unit_index)` → `COUNT(*)`）' +
    '⇒ 同一现场读数**必与实现侧不等**并指名差额（＝这条对账真的在测"去重 ＋ 窗口"这两件事，不是恒真式）',
    (() => {
      const rowsE72 = Number(e72Tmp.db.prepare(
        'SELECT COUNT(*) AS c FROM measure_rt WHERE unit_index IS NOT NULL AND unit_index <> \'\' ' +
        'AND collect_time >= ? AND collect_time < ?').get(winE72.start, winE72.end).c);
      return rowsE72 !== implStartedE72 && rowsE72 === 4 && implStartedE72 === 3;
    })(),
    (() => {
      const rowsE72 = Number(e72Tmp.db.prepare(
        'SELECT COUNT(*) AS c FROM measure_rt WHERE unit_index IS NOT NULL AND unit_index <> \'\' ' +
        'AND collect_time >= ? AND collect_time < ?').get(winE72.start, winE72.end).c);
      return `变异口径（\`COUNT(*)\`）现算=${rowsE72}、实现侧（去重件数）=${implStartedE72} ⇒ 差额 ${rowsE72 - implStartedE72} 件` +
        '（T1 第 1 件的第二帧 —— 正是"必须去重"的那一帧）';
    })());

  /* ---------------- `E72⑥`：`addRunSec` 上界不变量（**不改算式**） ---------------- */
  const statsSvcE72 = require('../server/services/stats');
  const statsDiskE72 = fs.readFileSync(path.join(env.paths.root, 'server', 'services', 'stats.js'), 'utf8');
  const snapDiskE72 = fs.readFileSync(path.join(env.paths.root, 'server', 'services', 'stateSnapshot.js'), 'utf8');
  const prodFormulaE72 = /const addRunSec = Math\.max\(0, base\.stats\.runSec - frozenRunSec\);/.test(snapDiskE72);
  const boundLineE72 = /const addRunSecMax = elapsedSec;/.test(statsDiskE72);
  const throwLineE72 = /addRunSec > addRunSecMax/.test(statsDiskE72);

  const e72Elapsed = 3600;
  const shiftStubE72 = { startAt: '2026-10-05 08:00:00', endAt: '2026-10-05 16:00:00', elapsedSec: e72Elapsed, name: '白班' };
  const callStatsE72 = addRunSec => statsSvcE72.computeShiftStats({
    shift: shiftStubE72, orders: [], pieces: [], measures: [],
    now: '2026-10-05 10:00:00', accum: null, addRunSec, liveSplit: { day1: 0, day2: 0 }
  });
  let e72OverThrew = null;
  let e72AtBound = null;
  try { e72OverThrew = callStatsE72(e72Elapsed + 1); } catch (e) { e72OverThrew = e; }
  try { e72AtBound = callStatsE72(e72Elapsed); } catch (e) { e72AtBound = e; }

  t.check('E72⑥ **`addRunSec` 的上界不变量是机器守着的**（裁定：加门禁守不变量、**不改算式**）：' +
    '①真 `computeShiftStats()` 喂 `addRunSec = elapsedSec + 1` ⇒ **抛 `RangeError`**（界**不是空的**）；' +
    '②恰好等于上界 ⇒ **不抛**（负对照：判据不是"只要给了增量就红"）；' +
    '③生产侧算式逐字仍是 `addRunSec = Math.max(0, base.stats.runSec - frozenRunSec)`（**本件一字未改**，只把它钉成判据）—— ' +
    '上界的"界"＝`elapsedSec`（`stats.js` 的物理上界论证：有效运行不可能超过已经过去的时间），**不是** `runSec` 的别名',
    e72OverThrew instanceof RangeError && !(e72AtBound instanceof Error) &&
    prodFormulaE72 && boundLineE72 && throwLineE72,
    `越界（${e72Elapsed + 1} > 上界 ${e72Elapsed}）⇒ ` +
    (e72OverThrew instanceof RangeError ? `RangeError：${String(e72OverThrew.message).slice(0, 140)}` : `**未抛**（${JSON.stringify(e72OverThrew && e72OverThrew.ok)}）`) +
    `；等于上界（${e72Elapsed}）⇒ ${e72AtBound instanceof Error ? '**抛了**（' + e72AtBound.message + '）' : '不抛 ✓'}；` +
    `生产算式在册=${prodFormulaE72}、界＝\`elapsedSec\` 在册=${boundLineE72}、越界分支在册=${throwLineE72}`);

  {
    const mutSrcE72 = statsDiskE72.replace('const addRunSecMax = elapsedSec;', 'const addRunSecMax = Number.MAX_SAFE_INTEGER;');
    let mutErr = null;
    if (mutSrcE72 !== statsDiskE72) {
      const modE72 = { exports: {} };
      try {
        /* eslint-disable-next-line no-new-func */
        new Function('require', 'module', 'exports', '__dirname', '__filename', mutSrcE72)(
          require, modE72, modE72.exports, path.join(env.paths.root, 'server', 'services'),
          path.join(env.paths.root, 'server', 'services', 'stats.js'));
        modE72.exports.computeShiftStats({
          shift: shiftStubE72, orders: [], pieces: [], measures: [],
          now: '2026-10-05 10:00:00', accum: null, addRunSec: e72Elapsed + 1, liveSplit: { day1: 0, day2: 0 }
        });
      } catch (e) { mutErr = e; }
    }
    /** 判据：**那条"越界"错必须消失** —— 变异体即使因别的原因抛错，
     *  只要错误文本里不再出现 `addRunSec 必须是 0～…`，就说明"界"确实是这一行守的。
     *  （这也是本支**有判别力**的证据：不是"变异后什么都没变"，而是"越界不再被拦"。） */
    const mutBoundGone = mutErr === null || !/addRunSec 必须是/.test(String(mutErr.message));
    t.check('E72⑥-D22（可证伪）：把"上界＝班次已进行时长"那一行从**内存副本**里放开（`Number.MAX_SAFE_INTEGER`）⇒ ' +
      '同一越界输入**不再被"越界"这条拦下**（错误文本里不再出现 `addRunSec 必须是 0～…`）' +
      '（＝上面那条"越界必抛"确实由这一行守，不是恒真）；盘上 `stats.js` 逐字节未变',
      e72OverThrew instanceof RangeError && mutSrcE72 !== statsDiskE72 && mutBoundGone &&
      fs.readFileSync(path.join(env.paths.root, 'server', 'services', 'stats.js'), 'utf8') === statsDiskE72,
      `变异体越界 ⇒ ${mutErr === null ? '**不抛** ✓' : '抛 ' + mutErr.constructor.name + '：' + String(mutErr.message).slice(0, 110)}` +
      `（"越界"这条已消失=${mutBoundGone}）；` +
      `盘上逐字节未变=${fs.readFileSync(path.join(env.paths.root, 'server', 'services', 'stats.js'), 'utf8') === statsDiskE72}`);
  }

  /* ---------------- `E72⑧`：harness「真计数②③④」的定点变异 ---------------- */
  const cntTrue = {
    rowsA: 1, rowsAAfterFail: 1, rowA1: { result: '合格', duration_sec: 60 },
    resultWrite: { failures: 2, lastError: '注入失败（合成）' }, failuresBefore: 1,
    failRow: null, loggedWriteFailure: true, hookStatus: { counts: { sampledHookFailures: 0 } },
    warnings: [1, 2, 3, 4, 5], posts: [1, 2, 3, 4, 5],
    rowB1: { result: '待复检', retest_count: 1 }, rowsB: 1
  };
  /** 真计数②的判据式子（逐字对齐 `tests\harness-check.js` 的 `FR-5.11/C-108 行为·真计数②`） */
  const pred2 = c => c.rowB1.result === '待复检' && Number(c.rowB1.retest_count) === 1 && c.rowsB === 1;
  /** 真计数③（按件幂等 ＋ 终态不回退 ＋ `duration_sec` ＝首末有效帧差） */
  const pred3 = c => c.rowsA === 1 && c.rowsAAfterFail === 1 && Boolean(c.rowA1) && c.rowA1.result === '合格' &&
    c.rowA1.duration_sec === 60;
  /** 真计数④（固化失败**不污染采集链**） */
  const pred4 = c => c.warnings.length === c.posts.length && c.resultWrite.failures === c.failuresBefore + 1 &&
    typeof c.resultWrite.lastError === 'string' && c.resultWrite.lastError.includes('注入') &&
    c.failRow === null && c.rowsAAfterFail === c.rowsA && c.loggedWriteFailure === true &&
    Boolean(c.hookStatus && c.hookStatus.counts) && c.hookStatus.counts.sampledHookFailures === 0;
  const mut2 = {
    '㈠把「待复检」件错记成「合格」（假 warn 变 ids 缺失）': Object.assign({}, cntTrue, { rowB1: { result: '合格', retest_count: 1 } }),
    '㈡`retest_count` 少记 1（0 ≠ 1）': Object.assign({}, cntTrue, { rowB1: { result: '待复检', retest_count: 0 } }),
    '㈢该票行数多记 1（2 ≠ 1）': Object.assign({}, cntTrue, { rowsB: 2 })
  };
  const mut3 = {
    '㈠"按件幂等"错记成新增一行（rowsA 1→2）': Object.assign({}, cntTrue, { rowsA: 2 }),
    '㈡已判「合格」的终态回退成「待复检」': Object.assign({}, cntTrue, { rowA1: { result: '待复检', duration_sec: 60 } }),
    '㈢`duration_sec` 记错（61 ≠ 60）': Object.assign({}, cntTrue, { rowA1: { result: '合格', duration_sec: 61 } })
  };
  const mut4 = {
    '㈠"写失败"错记成没失败（failures 不涨）': Object.assign({}, cntTrue, { resultWrite: { failures: 1, lastError: '注入失败（合成）' } }),
    '㈡注入的桩变成"成功"（第 2 件写出了行）': Object.assign({}, cntTrue, { failRow: { unit: 2 }, rowsAAfterFail: 2 }),
    '㈢挂钩失败计数错记成 1（异常没在写入点内被收下）': Object.assign({}, cntTrue, { hookStatus: { counts: { sampledHookFailures: 1 } } })
  };
  const redOf = (pred, muts) => Object.keys(muts).filter(k => pred(muts[k]) === false);
  const r2 = redOf(pred2, mut2);
  const r3 = redOf(pred3, mut3);
  const r4 = redOf(pred4, mut4);
  t.check('E72⑧ harness「**真计数②③④**」的**定点变异**（把§十五那三条判据的**判据式子**逐字抽出来喂合成现场）：' +
    '先喂"照实抄的真现场"⇒ **三条全绿**（负对照）；再逐支喂一处**凭空改错的计数** ⇒ ' +
    '②（`待复检` 不计已完成）／③（按件幂等＋终态不回退＋`duration_sec`）／④（固化失败不污染采集链）' +
    '**每一条都必红并指名那一支**（各 3 支，共 9 支 —— 没有一支是"改了也绿"）',
    pred2(cntTrue) && pred3(cntTrue) && pred4(cntTrue) &&
    r2.length === 3 && r3.length === 3 && r4.length === 3,
    `负对照（真现场）⇒ ②=${pred2(cntTrue)}／③=${pred3(cntTrue)}／④=${pred4(cntTrue)}（应全 true）；` +
    `定点变异必红：② ${r2.length}/3 —— ${r2.join('、')}；③ ${r3.length}/3 —— ${r3.join('、')}；` +
    `④ ${r4.length}/3 —— ${r4.join('、')}`);

  t.check('E72⑧ 前提/范围（如实标注）：本条的变异**不跑生产链路**（§十五 那三条要真起进程内服务、要真推帧），' +
    '故它测的是**判据式子对"计数事实"的敏感度**，不是端到端回归；端到端那半由 §十五 自持。' +
    '⚠ 本条**不冒充**端到端改造 —— 真起服务的定点变异需要 §十五 自己的夹具支持（未做，见回执）',
    r2.length === 3 && r3.length === 3 && r4.length === 3 && cntTrue.rowsA === 1,
    `合成现场字段：${Object.keys(cntTrue).join('、')}；§十五 的三条判据式子逐字取自 ` +
    '`tests\\harness-check.js`（真计数②③④），本件只补"变异"这一维');

  /* ---------------- `E70②`：`logic-check` 的 `byMeasures(n)` 消歧 ---------------- */
  const logicDiskE70 = fs.readFileSync(path.join(env.paths.root, 'tests', 'logic-check.js'), 'utf8');
  const hasByMeasuresE70 = /const byMeasures = n => Math\.min\(elapsed, Math\.max\(0, n - 1\)\);/.test(logicDiskE70);
  /* 与生产补集口径**逐点对账**（`E70②` 建议的消歧出口）：`min(elapsed, max(0, n−1))` —— 现算 n = 0..5 */
  const elapsedE70 = 3600;
  const byMeasuresE70 = n => Math.min(elapsedE70, Math.max(0, n - 1));
  const pointsE70 = [0, 1, 2, 3, 5].map(n => `n=${n}⇒${byMeasuresE70(n)}`).join('、');
  /* 死分支的**结构事实**（`E70②` 立案处）：该用例的 `measures` 是**字面空数组** ⇒ 那条 `measures.length > 0`
     的三元**真分支不可达**（不是"表达式写错"，是"用例没传 measures"这个事实）。 */
  const deadBranchFactE70 = /const measures = \[\];\s*\/\/\s*本用例未传 measures/.test(logicDiskE70);
  t.check('E70②（`E72⑦` 的可判定那半）`tests\\logic-check.js` 的"E68 之前的死分支"已被 `byMeasures(n)` 消歧：' +
    '①消歧出口 `const byMeasures = n => Math.min(elapsed, Math.max(0, n - 1));` **在册**；' +
    '②它与生产补集口径**逐点相等**（现算 n=0/1/2/3/5）；' +
    '③`E70②` 立案处那条死分支的**结构事实**如实登记（该用例 `measures` 是字面空数组 ⇒ 真分支不可达，' +
    '当前无影响、**本件不擅自改它** —— 改动权在规范侧放行后）',
    hasByMeasuresE70 && [0, 1, 2, 3, 5].every(n => byMeasuresE70(n) === Math.min(elapsedE70, Math.max(0, n - 1))) &&
    deadBranchFactE70 && byMeasuresE70(0) === 0 && byMeasuresE70(1) === 0 && byMeasuresE70(2) === 1,
    `\`byMeasures(\` 消歧出口在册=${hasByMeasuresE70}；逐点读数：${pointsE70}；` +
    `立案处"字面空数组 ＋ 未传 measures"结构事实在册=${deadBranchFactE70}；` +
    '**未做**：`E70①`（`harness-check` §十 运行期改写受管 `tests\\README.md`）—— 见回执"未验到/偏差"');

  try { e72Tmp.db.close(); } catch { /* 已关 */ }
  try { harness.removeLinkSafe(e72Tmp.dir, { recursive: true, force: true }); } catch { /* 已删 */ }
}

/* ==========================================================================
   `E103`（链接安全的**门禁守护**，`T-20261004-01` 甲组，2026-10-04）
   --------------------------------------------------------------------------
   为什么要有这一段：`E46`（对 junction 递归删除危险）与 `E101`（24h 清扫跟随链接）都改好了，
   但"不得对**可能**是链接的路径递归删除"这条此前**只有纪律、没有门禁** —— `E46` 的事故正是
   **探针的第一版**踩出来的。没有门禁 ⇒ 下一个人、下一支探针还会踩，且删除是合法 git 操作、
   事后无从追责。本节把 `E103` 行给出的 A–E 五条判据落地（口径与偏差逐条写在判据旁边）：
     A 静态禁入清单（剥注释与字符串后）：`robocopy`／`readdirSync(…,{recursive:true})`／
       `rmdir /s`／`rd /s`。
     B 组合判据：`fs.rmSync(id, {recursive:true})` 要求**同文件**存在 `lstatSync(id)`／`isLink(id)`
       （或该调用点已改用 `removeLinkSafe(`）。
     C 行为探针：`._verify\` 内一次性 junction ＋ 5 个 victim 文件 ⇒ `removeLinkSafe()` 必须返回
       `kind==='link'`、`via ∈ {rmdirSync,unlinkSync}`、victim 逐文件 sha256 守恒、链接消失；
       ＋ D22：`lstatSync → statSync` 的**内存字节副本**变异体 ⇒ 同一判据必须**红并指名**。
     D 安全闸：全部实验路径必须落在 `tests\._verify\` 内（`path.relative` 不以 `..` 开头）。
     E 清扫回归：`tempRootBase` 下的链接 ⇒ `cleanupStaleTemp()` **只拆链**、目标一条不少；
       并给出"新鲜真实目录不被回收／过期真实目录被回收"两端读数。
     （丙 `E97`）探针纪律的**调用形态**守护：见下面第三段。

   ⚠ **扫描面（两条面、两种强度 —— `E130` 之后判据标题不再"过度声明"）**
     本节的判据**不是**"全仓零容忍"，而是**两个面各按各的口径**：
       · **受管面**＝`tests\*.js` ＋ `tests\lib\**` ＋ `tools\**`（入库、被门禁扫描的脚本）
         ⇒ **零容忍**（A①／A④／B①／B②／丙①：命中即红并逐处指名）。
       · **`._verify\` 面**＝`tests\._verify\**`（**被 gitignore 的探针与一次性变异器的家**）
         ⇒ **已登记残留 ＋ 新增即红**（A②／A⑥／B⑥／丙②：清单外的任何一处 ⇒ 红并指名 `文件:行号`）。
     **为什么 `._verify\` 面必须守**（`E130` 的立案理由，回执里也复述了）：`E46` 的**真毁伤**与 `E117`
     修的 **6 处**都发生在这一面 —— 它就是"探针会踩坑"的那块地；而 `E130` 之前它**一处都不守**
     （`A④` 由代码显式排除该面、`B①` 的扫描面只喂受管面），读者却会按标题读成"全仓已守"。
     **为什么它只能"登记存量"而不能"零容忍"**：这一面上躺着 `E46` 的**取证实物**（**故意**调用被禁
     API，是 `E103`／`E46` 立案的证据）、**旧版本字节副本**（D22 基线、非活动脚本）与 60 多支一次性
     探针；"零容忍"在这里等于要求把历史证据一起改掉。⇒ 判据式子只有"命中 ⊆ 清单"一条：
     **存量只减不增，新增即红**（与 A② 的既有做法同款；`probe` 类存量**确实该改**，本段只登记、
     不承认其正当性）。

   ⚠ **偏差与口径（据实登记，不照抄台账）**
   ① `E103` 行写"现状应为 **0 命中**"（A）—— 对**受管面**成立（实测 0），但**对全盘不成立**：
      `tests\._verify\e46\` 的两支**取证探针**（`E46` 自己的实物）里有 **3 处** `readdirSync(…,
      {recursive:true})` —— 它们**故意**调用被禁 API 来实测"递归读会跟着 junction 出圈"。
      处置＝受管面**零容忍**（A①）＋ `._verify\` 面用"**已登记取证残留**"逐条判定、**新增即红**（A②）。
      不删那两支探针：它们是 `E46` 的实证（`tests\env.js` 的注释就指着它们）。
   ② `E103` 行写"E：另造**新鲜**链接 ⇒ **不被回收**" —— 与 `env.js` 的实现**不符**：
      `cleanupStaleTemp()` 对链接是**无条件拆链**（不看年龄；理由＝链接不是合法的临时产物，
      见 `tests\env.js` 的 `E101` 段）。本节按**实测口径**断言（新鲜链接**也**被拆链、但目标不受损），
      并把这条偏差写进判据文案。
   ③ B 的判据在**受管面**上**曾经**不可能全绿：`tests\db-check.js`／`tests\offline-check.js`／
      `tests\platform-check.js` 合计 **6 处**未防护的递归删除。**`E117` 之后这 6 处已全部改走
      `env.removeLinkSafe()` ⇒ `RM_LEGACY_E103` 清单已清空（B④ 逐处留档）** ⇒ 现在 B① 是
      "**零新增 ＋ 存量 0**"，任一处回潮都会被当"新增"点名。本条按"事实变了"改写
      （`D21`：判据式子一字未改，变的只是清单里的事实）。**本门禁自身的面**
      （`tests\harness-check.js` ＋ `tests\lib\**`）**不靠存量清单**：那 15 处已全部改走
      `removeLinkSafe()`（B②）。
   ④ `._verify\` 面的存量数字是**普查读数**，会随探针生灭而变。**`T-20261004-16` 迁移后的读数**：
      裸递归删 **42** 条＝`E46` 取证实物 11 ＋ 旧版本字节副本 31（**一次性探针 64 已全部改走
      `env.removeLinkSafe()`** ⇒ 该族归零，见 `E140`）；迁移**之前**的普查基线是 **106** 条
      ＝ 11 ＋ 31 ＋ 64（`T-20261004-14` 甲组）。外部工具调用形态 **13** 条＝`E46` 真调用 3 ＋ 词形撞车 10。
      ⚠ **`E151`（2026-10-04）更正这条普查的一个盲区**：旧判据**先查守护、后查在册** ⇒ 凡"文件里有同 id 的
      `lstatSync`/`isLink`"的 `(文件,id)` **整条**被豁免 ⇒ 它们**连普查都看不见**（上列的 106／42 都**不含**它们）。
      实测：`._verify\` 面另有 **5 条**这类 `(文件,id)`（`e46\probe-danger.js:link`（3 处）、`probe-raw.js:link`、
      `probe-raw2.js:dirlink`、`probe-twoside.js:link`、`review\s5t20-junction.js:link`）、受管面另有 **2 条**
      （`tests\env.js:target`／`p`）⇒ 本批**逐条登记**（清单 42 → **47**＝e46 16 ＋ oldcopy 31，锚点同步更新），
      **不把判据放宽回"未在册也豁免"**。**存量"出现次数"的现算读数**见 B⑥ 的 `E156` 口径行
      （口径写在那里：数的是什么、在哪个面、什么时刻）。
      **两处数口径不同、必须写清**（`C·22` 靶子① 的提醒）：`A⑥` 打印的"**原始命中行**"数的是**行**，
      而"已登记 **13** 条"数的是 `(文件,形态)` **去重后的登记条目** ⇒ 同一 `(文件,形态)` 出现多行时，
      行数会**大于**条目数（实测差 5 行，全是**同一批文件里的重复行**），**不是"有 5 条没登记"**。
      **判据不写死这些数字**（式子只写"命中 ⊆ 清单"）⇒ 探针生灭不会造成假红，只会让"已消失"那栏变长。
    ⚠ **为什么判据要有"形状"这一条腿**：本机 `fs.rmSync(<junction>, {recursive:true})` **只拆链**
   （`E46` 的实测更正）⇒ **纯行为读数区分不出改动前后**（`E101` 的结论）。故 B（形状）与 C（行为）
   缺一不可：形状证明"判据来自 lstat"，行为证明"目标一条不少"。
   ========================================================================== */
function e103LinkSafetyChecks(t) {
  const crypto = require('node:crypto');
  const Module = require('node:module');
  const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  /* ---------------- 扫描面：磁盘上的 `tests\**\*.js` ＋ `tools\**\*.js`（不看 git 跟踪状态） ----------------
     遍历自身也守同一条纪律：`withFileTypes` 报 `isSymbolicLink()` 的条目不进入（不跟随链接）。 */
  const walkJsE103 = (dir, out = []) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of list) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walkJsE103(abs, out);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(abs);
    }
    return out;
  };
  const allJsE103 = [...walkJsE103(env.paths.tests), ...walkJsE103(path.join(env.paths.root, 'tools'))];
  const relOfE103 = (abs) => path.relative(env.paths.root, abs).split(path.sep).join('\\');
  const isUnderVerifyE103 = (abs) => relOfE103(abs).includes('._verify\\');   /* 相对**仓库根** ⇒ `tests\._verify\…` */
  const managedJsE103 = allJsE103.filter(f => !isUnderVerifyE103(f));
  const verifyJsE103 = allJsE103.filter(isUnderVerifyE103);
  const readOrEmpty = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; } };

  /* ==================== 甲-零：判据的"地面"先自证（`E160`，`T-20261005-08` 甲组） ====================
     ⚠ **顺序不可倒**：下面 `E103` 那一族的每一条都以"剥字面量后的文本"为地面 ——
     地面若在某个文件上失真（整段活代码被 blank），**上面所有判据的读数都不可信**（`E160` 的立案句）。
     故先把地面证一遍、并把盲区**检出并登记**（含双路复核读数），再进 `E103` 的判定。 */
  runGroundChecksE160(t, allJsE103);

  /* ---------- `E160` 的统一自查工具（**不是断言**，是"判据有没有能力"的资格闸）----------
     为什么要有它（`E153` 的教训）：D22 要证明的是"**主判据那一件事**能被证伪" ——
     若同一段样本在**空白基准**（什么都不干）时就已经是红，那 D22 证明的是"样本自己红"，
     与主判据无关。故每个 D22 样本都必须**成对**喂给"空白基准"与"主判据"：
     · `blank`（＝谓词恒返回空）⇒ 好的 D22 样本在这里**必须是 0**（否则样本自伤）；
     · `pred`（＝真正的主判据）⇒ 必须**>0**（否则证伪不了）。
     本工具让这两条在**同一份样本**上现算，D22 的结论才与主判据同源。 */
  const samplesOkE160 = (samples) => samples.every(s => s.blank.length === 0 && s.pred.length > 0);

  /* ==================== `E161`（`T-20261005-08` 乙组，步 1）：**禁 API，而不是禁形状** ====================
     **为什么换靶（本件要求在回执里写清的那一句）** —— `E130`／`E144`／`E149`／`E151` 这四层都在问
     "**这段代码长什么样**"：`fs.rmSync(<标识符>, … recursive:true)`。而"危险的删除"是一个**能力**，
     它有无穷多种写法（换 API／换引用方式／拼路径／动态取用／外调 shell）。`E161` 的端到端实测：
     五支**同样危险**的写法（`rmdirSync`／`fs.promises.rm`／解构 `rmSync`／`path.join` 形态／`fs['rmSync']`）
     在旧判据下**全部零命中**，`harness-check` 照样全绿、被提及 **0 次**。
     ⇒ **形状无穷、API 有限**：把"删除"这个能力收敛到一个出口（`tests\env.js` 的 `removeLinkSafe`），
     其余 API 一律静态禁入 ⇒ **写法怎么变都躲不过**（换写法＝换 API，换 API 就命中）。
     这就是"**禁形状靠不住、禁 API 才收敛**"的完整理由：前者在**无穷**的形状空间里追样本，
     后者把判据钉在**有限**的 API 名单上。

     **与既有判据的关系**：**保留** `E103-B⑥`（形状式）与其 D22 样本，**新增**本判据。
     口径（写死在代码注释里，本件要求）：**新的 API 收敛判据是本族的主守卫；旧的形状式保留用于
     存量登记语义与回放样本**（`E145` 的 `sha12` 锚点、`E151` 的裁定㈠读数都挂在旧式子上，
     删掉它们会连带毁掉那两条的留痕）。⇒ 本批**不退役**旧判据；若将来要退役，须在回执里提案
     （附"退役后哪条覆盖顶上、条数如何变"）。

     **剥离器**：本判据一律走**甲（`E160`）那套"剥离 ＋ 自证"的地面** ——
     ①剥字面量（单一真源 `stripLiterals`）②自证（长度／换行守恒 ＋ 剥除率地板 ＋ 最长 blank 段阈值）
     ③双路复核（同一谓词喂"剥后"与"原样"两路）。⇒ **顺序不可倒**：甲先落地，乙才在它上面判。 */
  {
    /* ---------------- 面与口径（**显式声明**：多守一个面是指据强度变化，必须留痕） ----------------
       面的选择依据（不是"顺手扩大"）：
        · 生产代码 `server\`／`src\`／`platform\`：**新增** —— `E103` 那一族的扫描面是
          `tests\**` ＋ `tools\**`，**生产码从来没被这条守过**；而"删目录"在生产码里没有任何正当理由。
        · `tests\*.js`（含 `tests\lib\`）＋ `tools\`：与 `E103` 同面，便于逐条对账。
        · `tests\._verify\**`：**一并扫、但按分面单独报数**（它被 gitignore，但不是法外之地 ——
          `E46` 的真毁伤就发生在这里）；本件**不为它新增 A 档判红**（那是步 2 的范围）。 */
    const VERIFY_FACE_SCOPE_E161 = [
      '`server\\`／`src\\`／`platform\\`（**新增面**：`E103` 那一族从来没守过生产码）',
      '`tests\\**\\*.js`（含 `tests\\lib\\`）／`tools\\`（与 `E103` 同面，便于逐条对账）',
      '`tests\\._verify\\**\\*.js`（**一并扫、分面报数**；本件不为它新增 A 档判红 ⇒ 步 2 的范围）'
    ];
    const prodJsE161 = [...walkJsTopE160(path.join(env.paths.root, 'server')),
      ...walkJsTopE160(path.join(env.paths.root, 'src')),
      ...walkJsTopE160(path.join(env.paths.root, 'platform'))];
    const managedJsE161 = [...prodJsE161, ...managedJsE103];      /* 受管面（＝生产 ＋ 测试/工具，不含 `._verify`） */
    const readE161 = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; } };

    /* ---------------- 甲-A：A 档（零容忍）逐处指名 ---------------- */
    const aHitsE161 = (list) => list.flatMap((f) => {
      const code = stripLiterals(readE161(f));
      return scanRmApiStrippedE161(code).map(h => ({ file: relOfE103(f), ...h }));
    });
    const aHitsManagedNoExempt = aHitsE161(managedJsE161);
    /* **唯一豁免**：`tests\env.js` 里那一处（`removeLinkSafe()` 自身的实现）。
       为什么它必须是"登记一条豁免"而不是"整体放行这个文件"：`E151` 的教训 ——
       "文件里有这个形状"不等于"这个形状在起作用"；登记粒度必须是 `文件:行号`。 */
    const RM_API_EXEMPT_E161 = [
      {
        file: 'tests\\env.js', line: 241, api: 'fs.rmSync',
        why: '**唯一出口** `removeLinkSafe()` 的实现本体：`fs.lstatSync(target)` 判"目录项自身" ⇒ '
          + '**是链接 ⇒ 只拆链（非递归）并 return** ⇒ 走到这一句时已证明"不是链接" ⇒ '
          + '对**真实目录**才递归删。`E103-B①` 的 `RM_LEGACY_E103` 也登记同一个 `(tests\\env.js, target)`。'
      }
    ];
    const exemptMatchedE161 = RM_API_EXEMPT_E161.map(e =>
      aHitsManagedNoExempt.filter(h => h.file === e.file && h.line === e.line && h.api.includes(e.api)));
    const aViolationsE161 = aHitsManagedNoExempt.filter(h =>
      !RM_API_EXEMPT_E161.some(e => e.file === h.file && e.line === h.line));
    t.check('E161-A① **API 收敛判据（A 档·零容忍，本族主守卫）**：受管面（`server\\`／`src\\`／`platform\\`／'
      + '`tests\\**\\*.js` 含 `tests\\lib\\`／`tools\\`）里，剥字面量后**不得出现**：'
      + '`fs.rmSync`／`fs.rmdirSync` 的**递归形态**、`fs.rm`／`fs.rmdir`／`fs.promises.rm`／`fs.promises.rmdir`（任何形态）、'
      + '**静态解构**（`const {rmSync} = require(\'fs\')` 一类）、**动态取用**（`fs[<表达式>]`）、'
      + '**裸标识符**（`rmSync(x,{recursive:true})`）、**外调 shell 递归删** —— '
      + '**唯一豁免**＝`tests\\env.js` 的那一处出口实现（逐条按 `文件:行号` 登记）；命中 ⇒ **红并逐处指名 `文件:行号`**',
      aViolationsE161.length === 0 && exemptMatchedE161.every(x => x.length === 1),
      aViolationsE161.length
        ? `判红：**A 档违规 ${aViolationsE161.length} 处** —— `
          + aViolationsE161.map(h => `\`${h.file}\`:${h.line}（${h.rule}）`).join('；')
          + `；豁免 ${RM_API_EXEMPT_E161.length} 条（${RM_API_EXEMPT_E161.map(e => `${e.file}:${e.line}`).join('、')}）`
        : `零违规（受管面扫 ${managedJsE161.length} 个 .js：生产 ${prodJsE161.length} ＋ 测试/工具 ${managedJsE103.length}；`
          + `**其中生产代码 A 档实测 ＝ 0**）；唯一豁免 ${RM_API_EXEMPT_E161.length} 条`
          + `（${RM_API_EXEMPT_E161.map(e => `${e.file}:${e.line} 命中 ${exemptMatchedE161[0] ? exemptMatchedE161[0].length : 0} 次`).join('、')}）`);
    t.check('E161-A② **豁免只有一处**（`E161` 交付 1 的硬要求）：`tests\\env.js` 里递归删的**豁免恰好命中 1 次** —— '
      + '**不是「这个文件被整体放行」**（把豁免写成文件名级 ⇒ 该文件里再加第 2 处递归删也照样绿，那正是 `E151` 的病）；'
      + '且 `tests\\env.js` **只有这一处**递归形态（第 2 处 ⇒ 本条的"恰好 1 次"当场不成立）',
      RM_API_EXEMPT_E161.length === 1
        && exemptMatchedE161[0] && exemptMatchedE161[0].length === 1
        && aHitsManagedNoExempt.filter(h => h.file === 'tests\\env.js').length === 1
        && RM_API_EXEMPT_E161.filter(e => e.file === 'tests\\env.js' && e.api === 'fs.rmSync').length === 1,
      `豁免清单 ${RM_API_EXEMPT_E161.length} 条（应 1）；\`tests\\env.js\` 盘上递归形态 A 档命中 `
        + `${aHitsManagedNoExempt.filter(h => h.file === 'tests\\env.js').length} 处（应 1，行 `
        + `${aHitsManagedNoExempt.filter(h => h.file === 'tests\\env.js').map(h => h.line).join('、') || '无'}）；`
        + `豁免命中 ${exemptMatchedE161[0] ? exemptMatchedE161[0].length : 0} 次（应 1）`
        + `（文件级放行会让"同文件第 2 处"静默通过 ⇒ 本条的粒度是 \`文件:行号\`）`);

    /* ---------------- 乙-B：B 档（登记制，`E140`／`E145` 机制）----------------
       **为什么单文件删要进 B 档而不是 A 档**：`fs.rmSync(p,{force:true})`／`fs.rmdirSync(p)` 删的是
       **目录项本身**，不进去、不跟随链接（`E46` 实测的 10 种写法都不穿）；而它的**存量不小**
       （受管面实测 20+ 处、`._verify` 面 45 处），全迁走 diff 巨大而安全收益很小。
       ⇒ 沿用 `E140`／`E145` 的先例：**登记 ＋ 只减不增 ＋ 双向可证伪**（多一处 ⇒ 红"新增漂移"；
       少一处 ⇒ 红"名单陈旧"），并给**冻结点锚点**（把"清单被悄悄改过"也变成可证伪）。 */
    const countSingleFileE161 = (list) => {
      const per = {};
      for (const f of list) {
        const n = scanSingleFileRmE161(stripLiterals(readE161(f))).length;
        if (n) per[relOfE103(f)] = n;
      }
      return per;
    };
    const bDiskManagedE161 = countSingleFileE161(managedJsE161);
    /** **B 档登记清单**（逐条 `文件 → 允许出现次数 max`）。语义＝"**只减不增**"：
     *  盘上出现清单外的文件 ⇒ `added`（新增漂移 ⇒ 红）；同文件多一处 ⇒ `over`（超限 ⇒ 红）；
     *  清单里的文件在盘上**少了/没了** ⇒ `stale`（**报"名单陈旧"** ⇒ 红）。 */
    const B_REGISTRY_E161 = {
      'server\\db\\maintain.js': 2,
      'server\\index.js': 1,
      'platform\\log.js': 1,
      'tests\\docs-cross-check.js': 1,
      'tests\\env.js': 4,
      'tests\\harness-check.js': 6,
      'tests\\lib\\harness.js': 1,
      'tests\\platform-check.js': 1,
      'tests\\preflight.js': 1,
      'tests\\run-all.js': 4
    };
    /** **冻结点锚点**（`E140`／`E145` 的先例；这三项是**常量**，**不**从清单现算 ——
     *  现算出来的是"同一个东西对自己的复读"，那种断言**没有证伪能力**）。 */
    const B_ANCHOR_E161 = { total: 22, files: 10, sha12: 'aaa042207ef9' };
    /** B 档双向对账纯函数（主断言与 D22 共用 —— `E153` 的教训）：
     *  @returns {{added:Array,over:Array,stale:Array,changed:Array}} */
    const bAuditE161 = (disk, registry) => {
      const added = Object.keys(disk).filter(f => !(f in registry))
        .map(f => ({ file: f, disk: disk[f], max: 0 }));
      const over = Object.keys(disk).filter(f => (f in registry) && disk[f] > registry[f])
        .map(f => ({ file: f, disk: disk[f], max: registry[f] }));
      const stale = Object.keys(registry).filter(f => !(f in disk) || disk[f] < registry[f])
        .map(f => ({ file: f, disk: disk[f] || 0, max: registry[f] }));
      const changed = Object.keys(disk).filter(f => (f in registry) && disk[f] < registry[f])
        .map(f => ({ file: f, disk: disk[f], max: registry[f] }));
      return { added, over, stale, changed };
    };
    /* 清单 → `文件|次数` 摘要（`sha12` 的输入；排序固定 ⇒ 可复算）。
       ⚠ 若清单与冻结点的**条数**不同，这里把差额显式报出来（否则"少一个文件"只会表现成 sha 不符）。 */
    const bAnchorDiffWith = (registry) => {
      const at = Object.entries(registry).sort((a, b) => a[0].localeCompare(b[0]));
      const sum = at.reduce((a, [, n]) => a + n, 0);
      const out = [];
      if (sum !== B_ANCHOR_E161.total) out.push(`逐条次数之和 ${sum} ≠ 冻结点 ${B_ANCHOR_E161.total}`);
      if (at.length !== B_ANCHOR_E161.files) out.push(`文件数 ${at.length} ≠ 冻结点 ${B_ANCHOR_E161.files}`);
      const sha12 = require('node:crypto').createHash('sha256')
        .update(at.map(([f, n]) => `${f}|${n}`).join('\n')).digest('hex').slice(0, 12);
      if (sha12 !== B_ANCHOR_E161.sha12) out.push(`逐条摘要 ${sha12} ≠ 冻结点 ${B_ANCHOR_E161.sha12}`);
      return { ok: out.length === 0, out, sha12, sum, files: at.length };
    };
    const bAnchorDiffE161 = bAnchorDiffWith(B_REGISTRY_E161);
    const bAuditNowE161 = bAuditE161(bDiskManagedE161, B_REGISTRY_E161);
    const bTotalDiskE161 = Object.values(bDiskManagedE161).reduce((a, b) => a + b, 0);
    const bEntriesTxt = Object.entries(B_REGISTRY_E161).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([f, n]) => `\`${f}\`×${n}`).join('、');
    t.check('E161-B① **B 档登记制（单文件删／非递归拆链）双向可证伪**：清单逐条带 `文件＋出现次数 max`，'
      + '**多一处 ⇒ 红并指名（新增漂移）**、**少一处 ⇒ 红并报"名单陈旧"**（`E140`／`E145` 机制）；'
      + '并给**冻结点锚点**（总次数／文件数／逐条 `sha12`，**常量、不由清单现算**）⇒ 清单被悄悄改过也当场显形',
      bAuditNowE161.added.length === 0 && bAuditNowE161.over.length === 0 && bAuditNowE161.stale.length === 0
        && bAnchorDiffE161.ok,
      (bAuditNowE161.added.length || bAuditNowE161.over.length || bAuditNowE161.stale.length || !bAnchorDiffE161.ok)
        ? `判红：新增/漂移 ${bAuditNowE161.added.length + bAuditNowE161.over.length} 处 —— `
          + [...bAuditNowE161.added.map(h => `\`${h.file}\`：盘上 ${h.disk} 处、**清单里没有这个文件**（新增漂移）`),
            ...bAuditNowE161.over.map(h => `\`${h.file}\`：盘上 ${h.disk} 处 > 登记 \`max: ${h.max}\`（超限）`)].join('；')
          + `；**名单陈旧** ${bAuditNowE161.stale.length} 处 —— `
          + bAuditNowE161.stale.map(h => `\`${h.file}\`：清单写 ${h.max} 处、盘上只剩 ${h.disk} 处`).join('；')
          + `；**冻结点不符** ${bAnchorDiffE161.out.length} 项 —— ${bAnchorDiffE161.out.join('；')}`
        : `双向一致：清单 ${bAnchorDiffE161.files} 个文件／合计 ${bAnchorDiffE161.sum} 处 ＝ 盘上实测 `
          + `${Object.keys(bDiskManagedE161).length} 个文件／合计 ${bTotalDiskE161} 处；逐条摘要 \`sha12\` ${bAnchorDiffE161.sha12}`
          + `（＝冻结点 ${B_ANCHOR_E161.sha12}）；新增 ${bAuditNowE161.added.length}／超限 ${bAuditNowE161.over.length}／陈旧 ${bAuditNowE161.stale.length}（都应 0）；`
          + `清单逐条：${bEntriesTxt}`);
    t.info(`\`E161\` 口径与存量（**现算**）：受管面 .js ${managedJsE161.length} 个`
      + `（生产 ${prodJsE161.length} ＋ 测试/工具 ${managedJsE103.length}）；`
      + `**A 档（零容忍）实测 ${aViolationsE161.length} 处违规**（含豁免共命中 ${aHitsManagedNoExempt.length} 处，`
      + `豁免＝${RM_API_EXEMPT_E161.map(e => `${e.file}:${e.line}`).join('、')}）；`
      + `**B 档（登记制）${bTotalDiskE161} 处／${Object.keys(bDiskManagedE161).length} 个文件**（冻结点 ${B_ANCHOR_E161.total}／${B_ANCHOR_E161.files}，`
      + `逐条摘要 \`sha12\` ${bAnchorDiffE161.sha12}）；分面口径：${VERIFY_FACE_SCOPE_E161.join('；')}`);
    /* `._verify` 面：**只报数、不判红**（本件是步 1；步 2 把它纳进来）。
       为什么必须报数而不能不看不提：`E130` 的立案就是因为"这一面一根判据都没有"而标题却像全仓已守
       （`D19` 同类偏差）——"当前不动"必须是**看得见的**决定，不是沉默。 */
    const aHitsVerifyE161 = aHitsE161(verifyJsE103).filter(h => !RM_API_EXEMPT_E161.some(e => e.file === h.file && e.line === h.line));
    const bDiskVerifyE161 = countSingleFileE161(verifyJsE103);
    const bTotalVerifyE161 = Object.values(bDiskVerifyE161).reduce((a, b) => a + b, 0);
    t.info(`\`E161\` **\`._verify\\\` 分面报数（本批不判红，**步 2** 再议）**：A 档命中 **${aHitsVerifyE161.length} 处**`
      + `（其中递归形态 ${aHitsVerifyE161.filter(h => /recursive/.test(h.rule)).length} 处）；`
      + `B 档（单文件删）**${bTotalVerifyE161} 处／${Object.keys(bDiskVerifyE161).length} 个文件**。`
      + `⚠ 这一面被 gitignore，但**不是法外之地**（` + '`E46`' + ` 的真毁伤就发生在这里）；`
      + `本批**没有**为它迁移或判红，故**不得**把"受管面 A 档 ＝ 0"读成"全仓 A 档 ＝ 0"。`);

    /* ---------------- 乙-C：D22（8 个变异体，每个必红 ＋ 指名） ＋ 负对照 ---------------- */
    const Q3_E161 = String.fromCharCode(39);
    const NAME_RM = 'rm' + 'Sync';                 /* 拼接构造：避免本文件（受管面）被自己的靶子字符串命中 */
    const NAME_RMDIR = 'rmdir' + 'Sync';
    const NAME_RM_P = 'rm';
    const ROBOC = 'robo' + 'copy';
    const MIR = '/' + 'MIR';
    const RD_S = 'rd' + ' ' + '/' + 's';
    const samplesE161 = [
      { key: '㈠ `fs.rmdirSync(…,{recursive:true})`（旧判据零命中的第 1 种拼写出口）',
        src: `const t = one();\nfs.${NAME_RMDIR}(t, { recursive: true, force: true });\n` },
      { key: '㈡ **静态解构**：`const {rmSync} = require(' + Q3_E161 + 'fs' + Q3_E161 + ')` 后直接调',
        src: `const { ${NAME_RM} } = require(${Q3_E161}fs${Q3_E161});\n${NAME_RM}(t, { recursive: true, force: true });\n` },
      { key: '㈢ **动态取用**：`fs[' + Q3_E161 + 'rmSync' + Q3_E161 + ']`（旧判据零命中的第 5 种）',
        src: `const t = one();\nfs[${Q3_E161}${NAME_RM}${Q3_E161}](t, { recursive: true, force: true });\n` },
      { key: '㈣ **`path.join` 形态**：`fs.rmSync(path.join(base,t),{recursive:true})`（旧式子的 `[^)]*` 跨不过内层 `)`）',
        src: `fs.${NAME_RM}(path.join(base, t), { recursive: true, force: true });\n` },
      { key: '㈤ **`fs.promises.rm`**（与 `rmSync` 逐字同源的 Promise 版）',
        src: `await fs.promises.${NAME_RM_P}(t, { recursive: true, force: true });\n` },
      { key: '㈥ **外调 shell 递归删**：`spawnSync(' + Q3_E161 + ROBOC + Q3_E161 + ', [… MIR])`',
        src: `const r = spawnSync(${Q3_E161}${ROBOC}${Q3_E161}, [empty, link, ${Q3_E161}${MIR}${Q3_E161}]);\n` },
      { key: '㈦ **`fs.rm`（顶层回调版）**',
        src: `fs.${NAME_RM_P}(t, { recursive: true }, cb);\n` },
      { key: '㈧ **`' + RD_S + '`**（shell 的另一支；靶子形态**拼接构造**，避免本文件自伤）',
        src: `execSync(${Q3_E161}cmd /c ${RD_S} /q ${Q3_E161} + link);\n` },
      { key: '★负对照：走**唯一出口** `env.removeLinkSafe(x,{recursive:true})`',
        src: `if (env.isLink(t)) { env.removeLinkSafe(t, { recursive: true, force: true }); }\n`,
        negative: true }
    ];
    const BLANK_SCAN_E161 = () => [];             /* 空白基准：什么都不干 ⇒ 好的 D22 样本在这里必须是 0 */
    const RUN_SCAN_E161 = (code) => [...scanRmApiStrippedE161(code), ...scanToolShellE161(code)];
    for (const s of samplesE161) {
      s.blank = sampleDualE161(BLANK_SCAN_E161, s.src).hits;
      s.pred = sampleDualE161(RUN_SCAN_E161, s.src).hits;
    }
    const posSamplesE161 = samplesE161.filter(s => !s.negative);
    const negSampleE161 = samplesE161.find(s => s.negative);
    t.check('E161-C① D22（可证伪，**8 个阳性变异体 ＋ 1 个负对照，全部走 `dualScanE160` 这同一把尺子**）：'
      + '㈠递归形态 `rmdirSync` ㈡静态解构 ㈢动态取用（方括号取 `rmSync`）㈣`path.join` 形态 '
      + '㈤`fs.promises.rm` ㈥robocopy 镜像开关 ㈦`fs.rm` 顶层回调版 ㈧' + RD_S + ' '
      + '—— **每一个都必须命中并指名规则；每一个在"空白基准"下必须 0 命中**（否则 D22 证明的是"样本自伤"、'
      + '与主判据无关，`E153` 的教训）；**负对照**（走唯一出口 `env.removeLinkSafe`）**必须 0 命中**（防恒红式）',
      posSamplesE161.length === 8 && samplesOkE160(posSamplesE161) && negSampleE161.pred.length === 0
        && negSampleE161.blank.length === 0
        && posSamplesE161.every(s => s.pred.some(h => h.rule)
          && s.pred.some(h => h.line === (s.src.split('\n').length - 1))),
      `阳性变异体 ${posSamplesE161.length} 个（应 8）—— `
        + posSamplesE161.map(s => `${s.key.split('（')[0]}：命中 ${s.pred.length} 处`
          + `（${s.pred.map(h => `L${h.line} ${h.rule}`).join('；')}）／空白基准 ${s.blank.length}`).join(' ｜ ')
        + `；负对照：命中 ${negSampleE161.pred.length} 处（应 0，样本＝\`${negSampleE161.src.trim()}\`）`);
    t.check('E161-C② D22（**豁免的"恰好一处"也可证伪**）：把豁免清单里 `tests\\env.js` 的计数改成 **2**'
      + '（＝"这个文件允许两处递归删"）⇒ 同一判据**必红并指名 `tests\\env.js`**（`E151` 的病：'
      + '豁免一旦退化成文件级/放宽计数，同文件的第 2 处就静默通过）',
      (() => {
        const two = RM_API_EXEMPT_E161.concat([{ file: 'tests\\env.js', line: 241, api: 'fs.rmSync', why: '人为把豁免计数改成 2（内存副本）' }]);
        /* 同一判据、只换豁免清单：命中数不再等于 1 ⇒ A② 必须红并指名 */
        const matched = two.map(e => aHitsManagedNoExempt.filter(h => h.file === e.file && h.line === e.line));
        const passTwo = two.length === 1 && matched.every(x => x.length === 1);
        return passTwo === false && two.every(e => e.file === 'tests\\env.js');
      })(),
      `豁免改成 2 条（同一 ` + '`文件:行号`' + ` 写两遍）⇒ 原判据（"豁免恰好 1 条且命中恰好 1 次"）判红＝true；`
        + `**指名**：\`tests\\env.js:241\`（豁免数 2 ≠ 1）—— 盘上文件全程只读（内存副本）`);
    t.check('E161-C③ D22（**B 档双向 ＋ 冻结点都可证伪**，`E145` 机制）：**内存副本**里'
      + '㈠让盘上**多出一个文件**（`._verify` 里新写一支探针的等价形态）⇒ 同一 `bAuditE161()` 必须把它列进 `added`'
      + '（**"新增漂移" ⇒ 红并指名该文件**）；'
      + '㈡让盘上**少一个文件**（把盘上副本里的一个文件拿掉）⇒ 同一纯函数必须把清单里那一条列进 `stale`'
      + '（**报"名单陈旧" ⇒ 红**）；'
      + '㈢**把一个文件的次数改成比盘上少 1**（盘不变）⇒ 进 `changed`／`stale`（红）；'
      + '㈣**加一个盘上没有的文件** ⇒ 进 `added`（红）；'
      + '㈤**只动清单、不动盘**（改一个文件的次数）⇒ 冻结点摘要 `sha12` **必不符**并指名 —— '
      + '这一条证明"锚点不是清单对自己的复读"（`E145` 的教训：用现算值当锚点 ⇒ 恒真、零证伪能力）',
      (() => {
        const a1 = bAuditE161({ ...bDiskManagedE161, 'tests\\._verify\\zz-e161-synth.js': 1 }, B_REGISTRY_E161);
        const diskLess = { ...bDiskManagedE161 };
        delete diskLess['tests\\docs-cross-check.js'];                  /* 盘上少一个（内存副本） */
        const a2 = bAuditE161(diskLess, B_REGISTRY_E161);
        const under = { ...B_REGISTRY_E161 };
        const k2 = Object.keys(B_REGISTRY_E161).find(f => B_REGISTRY_E161[f] > 1);
        under[k2] = B_REGISTRY_E161[k2] - 1;
        const a3 = bAuditE161(bDiskManagedE161, under);
        const a4 = bAuditE161({ ...bDiskManagedE161, 'tests\\._verify\\zz-e161-synth2.js': 1 }, B_REGISTRY_E161);
        const a5 = bAnchorDiffWith(under);
        return a1.added.length === 1 && a1.added[0].file === 'tests\\._verify\\zz-e161-synth.js'
          && a2.stale.length === 1 && a2.stale[0].file === 'tests\\docs-cross-check.js'
          && (a3.over.length + a3.stale.length + a3.changed.length) >= 1
          && (a3.over.some(x => x.file === k2) || a3.stale.some(x => x.file === k2) || a3.changed.some(x => x.file === k2))
          && a4.added.length === 1 && a4.added[0].file === 'tests\\._verify\\zz-e161-synth2.js'
          && a5.ok === false && a5.out.some(s => s.includes('冻结点'));
      })(),
      `㈠盘上多一个文件（\`tests\\._verify\\zz-e161-synth.js\`）⇒ added ${bAuditE161({ ...bDiskManagedE161, 'tests\\._verify\\zz-e161-synth.js': 1 }, B_REGISTRY_E161).added.length} 条（应 1，**报"新增漂移"并指名**）；`
        + `㈡盘上少一个文件（\`tests\\docs-cross-check.js\`）⇒ stale ${bAuditE161((() => { const d = { ...bDiskManagedE161 }; delete d['tests\\docs-cross-check.js']; return d; })(), B_REGISTRY_E161).stale.length} 条（应 1，**报"名单陈旧"**）；`
        + `㈢某文件次数在清单里改小 1（盘不变）⇒ over ${bAuditE161(bDiskManagedE161, (() => { const s = { ...B_REGISTRY_E161 }; const k = Object.keys(s).find(f => s[f] > 1); s[k] -= 1; return s; })()).over.length} 条（应 ≥ 1，红并指名）；㈣加一个盘上没有的文件 ⇒ added 1 条（红）；`
        + `㈤把 ` + '`max`' + ` 改小 1 后比冻结点 ⇒ ${bAnchorDiffWith((() => { const s = { ...B_REGISTRY_E161 }; const k = Object.keys(s).find(f => s[f] > 1); s[k] -= 1; return s; })()).out.join('；')}（应至少 1 项，**锚点真的在挡**）`);
    /* 负对照（本件要求"防恒红"）：把**盘上真文件**的某一处单文件删改成走出口 ⇒ B 档命中数必须**下降**
       （且盘上逐字节未变）。这是"判据不是恒红式"的**真文件级**证据（合成样本那一条是 C① 的负对照）。 */
    {
      const targetE161 = path.join(env.paths.root, 'tests', 'preflight.js');
      const bytesE161 = fs.readFileSync(targetE161);
      const srcE161 = bytesE161.toString('utf8');
      const before = scanSingleFileRmE161(stripLiterals(srcE161));
      const guardCall = 'env.removeLinkSafe(probeFile, { force: true })';
      const mutated = srcE161.replace('fs.' + 'rmSync(probeFile, { force: true })', guardCall);
      const after = mutated === srcE161 ? before : scanSingleFileRmE161(stripLiterals(mutated));
      const diskSame = Buffer.compare(bytesE161, fs.readFileSync(targetE161)) === 0;
      t.check('E161-C④ **负对照（防"恒红式"，用盘上真文件的内存副本）**：把 `tests\\preflight.js` 里那处'
        + '`fs.rmSync(probeFile, { force: true })`（单文件删）**改走唯一出口 `env.removeLinkSafe(...)`** ⇒ '
        + 'B 档在同一判据下的命中数**必须下降**（从 1 → 0）⇒ 判据能区分"裸删"与"规范写法"；'
        + '盘上文件**逐字节未变**',
        before.length === 1 && mutated !== srcE161 && after.length === 0 && diskSame,
        mutated === srcE161
          ? `（样本不匹配：\`tests\\preflight.js\` 里找不到那处调用 ⇒ 本负对照未执行，**不算通过**）`
          : `原件 B 档命中 ${before.length} 处（应 1：${before.map(h => 'L' + h.line).join('、')}）⇒ `
            + `内存副本改成 \`${guardCall}\` 后命中 ${after.length} 处（应 0）；`
            + `盘上 \`tests\\preflight.js\` 逐字节未变=${diskSame}`);
    }
    /* ---------------- 甲-A2（`E161` **步 2**，主代理裁定㈠）：shell／child_process 递归删形态**独立成条并判红** ----------------
       裁定㈠（`项目记录\工作日志.md` 第 8 轮⑤，2026-10-05）："同意把 shell/child_process 形态
       **独立成条并判红**（现在它们只在原样路被报出）"。
       为什么必须独立成条（`E161-C①` 的㈥㈧ 读数就是证据）：`rmdir /s`／`rd /s`／robocopy 的镜像开关
       这类"外调 shell 的递归删"**只存在于字符串实参里**，而 A 档的**剥离路**故意剥掉字符串
       ⇒ 它们**只在原样路上被报出**（`E160-⑦` 的"只在原样路"那一栏，`E161` 立案时实测 2 处）
       ⇒ **"被报出"不等于"被判红"**：一行 info 没人读，等于没守（`D19` 家族）。
       本条的判据**就是** `scanToolShellE161()`（与 `E160-⑦`／`E161-C①` **同一个纯函数** ——
       `E153` 的教训：D22 与主判据不许各写一份），本件新增的是"**命中即红**"的判定 ＋ 面的声明。
       ⚠ **判据自身的形态表**（本文件 `TOOL_SHELL_PATTERNS_E161` 那几行）会被自己的正则扫到 ——
       那是**靶子形态**（写出来的字符串），不是调用 ⇒ 按**动态定位的区间**整段排除，并把排除条数与
       区间**逐条打出来**；区间宽度设上限（> 800 B 或 > 12 行即判红）⇒ **不能拿它当藏身处**。
       ⚠ 裁定㈡：`._verify\` 面**仍然只报不判**（本件只把**受管面**的读数独立判红，不扩大判红面）。 */
    {
      const SELF_ABS_E161D = path.join(env.paths.root, 'tests', 'harness-check.js');
      const SELF_SRC_E161D = readE161(SELF_ABS_E161D);
      const selfRegionE161D = (() => {
        const at = SELF_SRC_E161D.indexOf('const TOOL_SHELL_PATTERNS_E161 = [');
        if (at < 0) return null;
        const end = SELF_SRC_E161D.indexOf('\n];', at);
        if (end < 0) return null;
        const stop = end + 3;
        return {
          at, stop,
          fromLine: lineOfE161(SELF_SRC_E161D, at),
          toLine: lineOfE161(SELF_SRC_E161D, stop),
          bytes: stop - at
        };
      })();
      /** **判据（纯函数；主断言与 D22 同一把尺子）**：输入 `{rel, src}` 列表 ⇒ 违规清单。
       *  唯一例外＝判据自身的形态表区间（只对 `tests\harness-check.js` 生效，且区间必须已定位到）。 */
      const shellJudgeE161D = (items) => items.flatMap(it => scanToolShellE161(it.src)
        .filter(h => !(selfRegionE161D && it.rel === 'tests\\harness-check.js'
          && h.line >= selfRegionE161D.fromLine && h.line <= selfRegionE161D.toLine))
        .map(h => ({ file: it.rel, line: h.line, rule: h.rule })));
      const managedItemsE161D = managedJsE161.map(f => ({ rel: relOfE103(f), src: readE161(f) }));
      const shellManagedE161D = shellJudgeE161D(managedItemsE161D);
      const shellSelfE161D = selfRegionE161D
        ? scanToolShellE161(SELF_SRC_E161D)
          .filter(h => h.line >= selfRegionE161D.fromLine && h.line <= selfRegionE161D.toLine)
          .map(h => ({ file: 'tests\\harness-check.js', line: h.line, rule: h.rule }))
        : [];
      const shellVerifyE161D = shellJudgeE161D(verifyJsE103.map(f => ({ rel: relOfE103(f), src: readE161(f) })));
      t.check('E161-D① **shell／child_process 递归删形态独立判红**（`E161` 步 2，主代理裁定㈠）：受管面'
        + '（`server\\`／`src\\`／`platform\\`／`tests\\**\\*.js`／`tools\\`）里**原样路**（保留字符串）'
        + '不得出现 `rmdir` 的递归开关、' + RD_S + ' 开关、以及 ' + ROBOC + ' 的镜像开关 —— '
        + '命中 ⇒ **红并逐处指名 `文件:行号`**；唯一例外＝**判据自身的形态表**（动态定位的区间，逐条报出且设宽度上限）；'
        + '`._verify\\` 面**只报不判**（裁定㈡：不计作违规，读数照给）',
        shellManagedE161D.length === 0 && Boolean(selfRegionE161D)
          && selfRegionE161D.bytes < 800 && (selfRegionE161D.toLine - selfRegionE161D.fromLine) < 12,
        shellManagedE161D.length
          ? `判红：受管面 shell 递归删形态 ${shellManagedE161D.length} 处 —— `
            + shellManagedE161D.map(h => `\`${h.file}\`:${h.line}（${h.rule}）`).join('；')
          : `零违规（受管面扫 ${managedItemsE161D.length} 个 .js）；判据自身形态表区间＝`
            + (selfRegionE161D
              ? `\`tests\\harness-check.js\`:${selfRegionE161D.fromLine}-:${selfRegionE161D.toLine}（${selfRegionE161D.bytes} B）`
              : '**未定位到**')
            + `；该区间内的"自伤"命中 ${shellSelfE161D.length} 处（已按区间排除，逐条报出：`
            + (shellSelfE161D.map(h => `:${h.line}（${h.rule}）`).join('、') || '无') + `）；`
            + `**\`._verify\\\` 面（只报不判）** ${shellVerifyE161D.length} 处／`
            + `${new Set(shellVerifyE161D.map(h => h.file)).size} 个文件`);
      /* D22（可证伪）：合成样本喂**同一把尺子** ⇒ 两支 shell 形态各命中 1 处并指名行号；
         负对照（走唯一出口 `env.removeLinkSafe`）必须 0 命中。靶子形态一律**拼接构造**（防自伤）。 */
      {
        const bad1E161D = 'const link = one();\n'
          + 'execSync(' + Q3_E161 + 'cmd /c ' + RD_S + ' /q ' + Q3_E161 + ' + link);\n';
        const bad2E161D = 'spawnSync(' + Q3_E161 + ROBOC + Q3_E161 + ', [empty, link, ' + Q3_E161 + MIR + Q3_E161 + ']);\n';
        const goodE161D = 'if (env.isLink(t)) { env.removeLinkSafe(t, { recursive: true, force: true }); }\n';
        const bad1Hits = shellJudgeE161D([{ rel: 'tests\\zz-e161d-synth-1.js', src: bad1E161D }]);
        const bad2Hits = shellJudgeE161D([{ rel: 'tests\\zz-e161d-synth-2.js', src: bad2E161D }]);
        const goodHits = shellJudgeE161D([{ rel: 'tests\\zz-e161d-synth-3.js', src: goodE161D }]);
        t.check('E161-D② D22（可证伪）：同一判据 `shellJudgeE161D()` 喂**合成样本** ⇒ '
          + '㈠外调 shell 版递归删 ㈡' + ROBOC + ' 的镜像开关 '
          + '**每一支必命中并指名 `文件:行号`**；**负对照**（走唯一出口 `env.removeLinkSafe`）**必须 0 命中**'
          + '（防"恒红式"）；而盘上受管面实测 0 违规（由 `E161-D①` 给出）',
          bad1Hits.length === 1 && bad1Hits[0].line === 2 && bad1Hits[0].file === 'tests\\zz-e161d-synth-1.js'
            && bad2Hits.length === 1 && bad2Hits[0].line === 1 && bad2Hits[0].file === 'tests\\zz-e161d-synth-2.js'
            && goodHits.length === 0,
          `㈠命中 ${bad1Hits.length} 处（${bad1Hits.map(h => `${h.file}:${h.line} ${h.rule}`).join('；') || '无'}，应 1 且行号 2）；`
            + `㈡命中 ${bad2Hits.length} 处（${bad2Hits.map(h => `${h.file}:${h.line} ${h.rule}`).join('；') || '无'}，应 1 且行号 1）；`
            + `负对照命中 ${goodHits.length} 处（应 0，样本＝\`${goodE161D.trim()}\`）`);
      t.info(`\`E161-D①\` 面与读数（现算）：受管面 ${managedItemsE161D.length} 个 .js ⇒ **shell 递归删违规 ${shellManagedE161D.length} 处**；`
        + `判据自身形态表区间＝\`tests\\harness-check.js\`:${selfRegionE161D ? selfRegionE161D.fromLine : '?'}-:`
        + `${selfRegionE161D ? selfRegionE161D.toLine : '?'}（${selfRegionE161D ? selfRegionE161D.bytes : '?'} B）、`
        + `区间内自伤命中 ${shellSelfE161D.length} 处（已排除，逐条见断言详情）；`
        + `**\`._verify\\\` 面（只报不判，裁定㈡）** ${shellVerifyE161D.length} 处／${new Set(shellVerifyE161D.map(h => h.file)).size} 个文件 —— `
        + `这一面被 gitignore 但**不是法外之地**（\`E46\` 的真毁伤就发生在这里）；本批**没有**为它迁移或判红，`
        + `故**不得**把"受管面 shell 递归删 ＝ 0"读成"全仓 ＝ 0"。`);
      }
    }
  }

  /* ==================== 甲-A：静态禁入清单 ==================== */
  const BAN_PATTERNS_E103 = [
    ['robocopy 外部镜像复制工具', /\brobocopy\b/],
    ['readdirSync(…, {recursive:true})', /readdirSync\([^)]*recursive:\s*true/],
    ['rmdir 的 /s 开关', /rmdir\s+\/s/],
    ['rd 的 /s 开关', /\brd\s+\/s/]
  ];
  /** 判据（纯函数，供 A③ 的 D22 复用）：**剥注释与字符串/模板串/正则**后逐行找禁入形态。
   *  为什么必须剥：`tests\env.js` 的 `E46` 注释里**逐字**写着 `robocopy … /MIR`、`readdirSync(…,
   *  {recursive:true})` —— 不剥就会把"说明文字"判成"调用"（自伤假红，实测踩过）。
   *  @returns {Array<{line:number, pat:string, text:string}>（text＝该行**原文**，便于人工核）} */
  const scanBanlist = (source) => {
    const code = stripLiterals(source).split('\n');
    const raw = source.split('\n');
    const out = [];
    code.forEach((l, i) => {
      for (const [name, re] of BAN_PATTERNS_E103) {
        if (re.test(l)) out.push({ line: i + 1, pat: name, text: String(raw[i] || '').trim().slice(0, 100) });
      }
    });
    return out;
  };
  const banHitsE103 = (list) => list.flatMap((f) => scanBanlist(readOrEmpty(f)).map(h => ({ file: relOfE103(f), ...h })));
  const banManaged = banHitsE103(managedJsE103);
  const banVerify = banHitsE103(verifyJsE103);
  /** `._verify\` 下**已登记的取证残留**（逐条判定；按 `文件＋形态` 登记，**不含行号** —— scratch 探针随时会动）。
   *  语义＝"**多一处就红**"（不是"允许这个文件里的一切"）：同一个文件里出现**新形态**照样判红。 */
  const BAN_RESIDUE_E103 = [
    { file: 'tests\\._verify\\e46\\probe-raw2.js', pat: 'readdirSync(…, {recursive:true})',
      why: '`E46` 取证探针：**故意**调用被禁 API，实测"`readdirSync(<link>,{recursive:true})` 会跟着 junction 出圈"（该项已记入 `tests\\env.js` 的 `E46` 段与路线图 `E46` 行）' },
    { file: 'tests\\._verify\\e46\\probe-twoside.js', pat: 'readdirSync(…, {recursive:true})',
      why: '同上（同一支取证脚本的第二次调用：受控复现"越界读"）' }
  ];
  t.check('E103-A① 静态禁入清单（**受管面零容忍**）：剥注释与字符串后，`tests\\*.js` ＋ `tests\\lib\\**` ＋ `tools\\**` 里没有 robocopy／`readdirSync(…,{recursive:true})`／rmdir 与 rd 的 /s 开关（命中即红并指名 `文件:行号`）',
    banManaged.length === 0,
    banManaged.length
      ? `判红：命中 ${banManaged.length} 处 —— ` + banManaged.map(h => `${h.file}:${h.line} [${h.pat}]`).join('；')
      : `零命中（扫 ${managedJsE103.length} 个受管 .js；剥注释与字符串后查 ${BAN_PATTERNS_E103.length} 类形态；`
        + `当前全仓这类调用点**为零**，与 tests\\env.js 的 E46 段自述一致）`);
  t.check('E103-A② `tests\\._verify\\**`（含被 gitignore 的）静态禁入命中**只剩已登记的取证残留**（清单外的任何一处 ⇒ 红并指名 `文件:行号`）',
    banVerify.every(h => BAN_RESIDUE_E103.some(r => r.file === h.file && r.pat === h.pat)),
    banVerify.length
      ? `实存 ${banVerify.length} 处：` + banVerify.map(h => `${h.file}:${h.line} [${h.pat}]`).join('；')
        + `；已登记 ${BAN_RESIDUE_E103.length} 条（` + BAN_RESIDUE_E103.map(r => `${r.file}——${r.why}`).join('；') + '）'
      : `._verify\\ 下零命中（扫 ${verifyJsE103.length} 个 .js）`);
  /* 样本一律**拼接构造**：若把靶子形态逐字写在本文件里，判据会先扫到自己的样本（自伤假红，
     实测踩过 —— 与 §16 的"靶子形态用拼接构造"同一手法）。 */
  const Q_E103 = String.fromCharCode(39);
  const sampleBanBad = 'const c = robocopy(empty, link);\n'
    + 'const rd = fs.' + 'readdirSync(link, { recursive: ' + 'true });\n';
  const sampleBanGood = '// 说明：拆链接只许用非递归语义（本行是注释，讲的是 robocopy 的镜像模式会穿链）\n'
    + 'const rd = fs.readdirSync(link);\n'
    + 'const t2 = ' + Q_E103 + 'readdirSync(link, { recursive: ' + 'true })' + Q_E103 + ';\n';
  const banBadHits = scanBanlist(sampleBanBad);
  const banGoodHits = scanBanlist(sampleBanGood);
  t.check('E103-A③ D22（可证伪）：同一判据喂**合成样本** ⇒ 禁入形态**必红且逐类指名**；而"注释里的同名词"与"字符串里的示例写法"**必绿**（⇒ 判据不是恒真式，也不会自伤）',
    banBadHits.length === 2
      && banBadHits.some(h => h.pat === BAN_PATTERNS_E103[0][0]) && banBadHits.some(h => h.pat === BAN_PATTERNS_E103[1][0])
      && banGoodHits.length === 0,
    `坏样本命中 ${banBadHits.length} 处（${banBadHits.map(h => `L${h.line}:${h.pat}`).join('、')}，应 2 且两类各 1）；`
      + `好样本命中 ${banGoodHits.length} 处（应 0：注释与字符串都被剥掉）`);

  /* ==================== 甲-B：递归删除的组合判据 ====================
     **`E144`（2026-10-04，本座位 `T-20261004-16` 甲-D）—— 登记粒度从 `(文件, 标识符)` 升到
     `(文件, 标识符, 允许出现次数)`。**
     立案（座位 5 在 `C·22` 靶子①实测、主代理登记 `E144`）：旧式子按**标识符**去重
     （`seen.has(m[1])`）＋"同文件里有没有 `lstatSync(id)`／`isLink(id)`"，于是两种形态**静默放行**：
       ① 同文件里**同一标识符**再多一处裸递归删（去重把它吃掉了，命中数不涨）；
       ② 同文件里**本来就有** `lstatSync(X)`／`isLink(X)`（被新写法 A 用上），在**别处**再加一处
          裸 `fs.rmSync(X,…)`（"有没有守护"是**文件级**判断，不是**调用点级**）。
     为什么必须修：判据抬头写的是"**多一处就红**"，而实现是"**多一个 `(文件,id)` 组合就红**"
     —— 措辞与判据不一致，正是 `D19` 的"看起来验过了"。修法＝**数出现次数**（清单每条带 `max`），
     于是两种形态都变成"这一条的次数超过了 `max`"⇒ 红并**逐行指名**。
     ⚠ 为什么 `max` 不能省（写成"隐式允许同 id 无限次"）：那等于把洞原样搬进新式子。
       全清单一律**显式**带 `max`（`max>1` 的逐条给出理由），式子只认"`kind` 在册 + 次数 ≤ `max`"。 */
  /** 判据（纯函数，供 B③ 的 D22 复用）：剥字面量后，逐 `(文件, 标识符)` 数"裸递归删"的**出现次数**，
   *  与清单的 `max` 比对。`max` 缺省 = 1（**不隐式放宽**）。
   *  ⚠ "有没有守护"的**判别式子**（`guardedReE144`）抽出来共用：B③／B⑦／B⑧／E144 的 D22 与判据本体
   *    必须是**同一把尺子**。这条式子的结尾必须是 `[,)]`（不能只写 `\b`）：`\b` **旧式子的**结尾会在
   *    `p.foo`／`p && x` 的 `p` 后同样成立 ⇒ 把 `lstatSync(p.foo)`／`lstatSync(p && x)` 这类"提了一句、
   *    **并没有拿 `p` 的判别结果去控制删/不删**"的写法也算成守护 ⇒ 本座位第一版 D22 就是被这一点骗过
   *    （新旧两支都判绿，读数看起来"一致"）。
   *  ⚠ **`E158`（2026-10-04，据 `C·23` 第 4 组）：本段上一版把反例举错了** —— 它写的是
   *    "`lstatSync(p).isSymbolicLink()` 这种**不是守护**的写法也会命中"，而**新式子对它照样命中**
   *    （`p` 后紧跟 `)` 正是 `[,)]` 允许的形态；复核方实测样本 G：该形态 ＋ 同 id 裸删 ⇒ 新判据命中
   *    **0** 条＝被判"有守护"）。**该形态其实**算守护****（`lstatSync` 是**不跟随链接**的判别，与
   *    `isLink()` 同类）⇒ 反例换成**真正被新式子排除**的两种：`lstatSync(p.foo)`／`lstatSync(p && x)`。
   *    **判据强度本身没问题，坏的是这段注释给人的反例**（`D19` 家族：说错了比没有更坏 —— 后来者会
   *    照着错的反例去推判据的强度）。
   *  @param {string} source 该文件源码
   *  @param {Array<{id:string,max:number}>} entries 该文件在清单里登记的条目（可含多条）
   *  @returns {Array<{id:string,count:number,lines:number[],max:number,registered:boolean}>} 违规清单（空＝合规） */
  const guardedReE144 = (id) => new RegExp(`(?:lstatSync|isLink)\\(\\s*${id}\\b\\s*[,)]`);
  const scanRmViolations = (source, entries = []) => {
    const code = stripLiterals(source);
    const lineOf = (idx) => code.slice(0, idx).split('\n').length;
    const cnt = new Map();      /* id → {count, lines}（**未防护**的裸递归删才计） */
    const re = /fs\.rmSync\((\w+)[^)]*recursive:\s*true/g;
    let m;
    while ((m = re.exec(code))) {
      const id = m[1];
      /* `E151`（2026-10-04，主代理裁定㈠）：**守护豁免只发给"在册的 `(文件,id)`"**。
         ── 为什么必须这样切（本件要求写进注释并在回执复述）：**"为什么"看起来有守护" ≠ "守护真的在起作用"** ——
            旧写法的**第一句**是 `if (guardedReE144(id).test(code)) continue;`：它是**文件级**判断
            （"这个文件里出现过该 id 的判别"），而且对**从未在册的 `(文件,id)`** 同样豁免 ⇒
            一支**全新**探针只要写一行 `if (fs.lstatSync(t).isSymbolicLink()) { console.log('note: link'); }`
            （**不 return、结果不参与控制流**）＋ 裸 `fs.rmSync(t,{recursive:true})` 就能过关：
            `C·23` 第 4 组与主代理亲验都读到 `harness-check` **413/0/2 全绿、该文件名 0 次被提及**
            ⇒ `E130` 立案时承诺的"**新增即红**"被**一行装饰性写法**绕过（`max` 的计数维度对
            "从未在册的 `(文件,id)`"完全不起作用）。
         裁定：**未在册 ⇒ 一律不豁免**（`max` 视作 0，出现一处即红并指名 `文件:行号`）；
            **在册 ⇒ 仍走"文件级守护"这条既有语义**（`E149` 的**调用点级**判定留作下一个债号，
            这里**不假装已覆盖**：在册项上一行装饰性 `isLink` 仍能豁免它 —— 见 B⑥ 注释里的边界登记）。
         ⚠ 这**不是**"只要有这个 id 就红"的恒红式：在册且"有守护"或"≤ 各自 `max`"的照旧判绿
            （E144 D22 的形态②③④ 与 B③ 的真守护样本各自给读数）。 */
      const regOf = entries.find(e => e.id === id);
      if (regOf && guardedReE144(id).test(code)) continue;  /* **在册** + 该 id 有判别 ⇒ 不按"裸"删计 */
      if (!cnt.has(id)) cnt.set(id, { count: 0, lines: [] });
      const e = cnt.get(id); e.count++; e.lines.push(lineOf(m.index));
    }
    const out = [];
    for (const [id, v] of cnt) {
      const reg = entries.find(e => e.id === id);
      const max = reg && Number.isFinite(reg.max) ? reg.max : (reg ? 1 : 0);
      if (v.count > max) out.push({ id, count: v.count, lines: v.lines, max, registered: Boolean(reg) });
    }
    return out.sort((a, b) => a.lines[0] - b.lines[0]);
  };
  /** **旧式子**的逐字复刻（只作**对照读数**用：`E144` 的 D22 要"新旧两支读数不同"才说明改动有意义）。
   *  语义＝按 id **去重**（`seen.has`）＋ 守护**文件级**判断（结尾 `\b`）。
   *  ⚠ 它**不参与任何判据**（判据一律走 `scanRmViolations`）；留着它是为了 D22 能打印"旧支怎么读的"。 */
  const scanUnprotectedRmNaive = (source) => {
    const code = stripLiterals(source);
    const lineOf = (idx) => code.slice(0, idx).split('\n').length;
    const seen = new Map();
    const re = /fs\.rmSync\((\w+)[^)]*recursive:\s*true/g;
    let m;
    while ((m = re.exec(code))) if (!seen.has(m[1])) seen.set(m[1], lineOf(m.index));
    const out = [];
    for (const [id, line] of seen) {
      if (!new RegExp(`(?:lstatSync|isLink)\\(\\s*${id}\\b`).test(code)) out.push({ id, line });
    }
    return out.sort((a, b) => a.line - b.line);
  };
  /** 兼容视图（**语义逐字不变**：仍只报"没有守护的 id"、仍给**首次**出现的行号）—— 既有断言与 D22
   *  （B③／B⑦／B⑧／A③ 那一带）全部继续用这个返回值，避免"升级判据时顺手改了一堆别的断言"。 */
  const scanUnprotectedRm = (source) => scanRmViolations(source).map(v => ({ id: v.id, line: v.lines[0] }));
  /** 按 `max` 逐条判定的命中（清单外的任何一处都算"超限"） */
  const rmHitsE103 = (list, residueList) => list.flatMap((f) => scanRmViolations(
    readOrEmpty(f), (residueList || []).filter(r => r.file === relOfE103(f))
  ).map(h => ({ file: relOfE103(f), ...h })));
  const rmManagedDisk = rmHitsE103(managedJsE103);
  /** 存量清单（`文件 ＋ 标识符`；**不含行号**）：语义＝"**零新增**"：清单外的任何一处 ⇒ 红。
   *  **`E117`（2026-10-04，本座位收口）：原先那 6 处已全部改走 `env.removeLinkSafe()` ⇒ 清单清空。**
   *  为什么不"保留豁免"：留着清单就等于"这几处再退回裸 `fs.rmSync(recursive)` 也照样绿"，
   *  正是本仓反复吃亏的"看起来在守、实际守不住"（`D23`）。清空后**任一处回潮都会被 B① 当"新增"点名**，
   *  而"判据不许为了变绿而放宽"这条（`D21`／`D23`）**没有被动过**：B① 的式子一字未改，
   *  变的只是"清单里有几条"这个**事实**（6 → 0，因为缺陷真的被修掉了）。
   *
   *  ⚠ **`E151`（2026-10-04）之后本清单不再为空：新增 1 条**（＝`tests\env.js` 的 `target`）。
   *  **它是怎么冒出来的（如实登记，这是本批的"发现"而不是"放宽"）**：`E151` 的裁定㈠把守护豁免
   *  从"任何 `(文件,id)`"收窄到"**只在册的** `(文件,id)`"（见 `scanRmViolations()` 的注释）⇒
   *  这处**从未进过清单**的调用点**第一次被普查看见**（旧判据**先查守护、后查在册** ⇒ 它被
   *  "文件里有同 id 的 `lstatSync`"整个吃掉，连 `E140` 的 106 条普查里都没有它）。
   *  ⇒ 按裁定**在同一批里登记**（登记本身即留痕），**不把判据放宽回"未在册也豁免"**；
   *  同时 `rmManaged` 改成**把本清单喂进判据**（在册 ⇒ 按各自 `max` 判；未在册 ⇒ 一律不豁免）
   *  —— 这一步是 `E144` 抬头早就写着、而真扫里一直没有的那一维（`D19`：措辞强于判据）。
   *  ⚠ **`target` 是"真守护"**（也是受管面**唯一**的登记）：`removeLinkSafe()` 内部
   *  `st = fs.lstatSync(target)` 之后才分支，链接那一支**先 return** ⇒ 走到
   *  `fs.rmSync(target, {recursive:true})` 时已证明"不是链接" ⇒ 判据口径＝"**零未守护裸递归删**"。
   *  ⚠ **同日撤掉的那一条（主代理裁定㈡，留痕）**：`tests\env.js` 的 **`p`** 曾是第 2 条 ——
   *  它是 `makeRealSweepIo().removeDir` 这个**接缝**，安全性原先**只靠调用方**（`cleanupStaleTemp()`
   *  先 `fsi.isLink(full)`），而文件里 `isLink: p => isLink(p)` 是**转发定义、不是判定**
   *  （文件级正则的**误命中**）⇒ 登记它等于"**文件级命中一次 ⇒ 该 id 的裸删永久豁免、`max` 不生效**"，
   *  正是 `E151` 要消灭的形态。⇒ 已把该接缝改成走 **`removeLinkSafe`**（`tests\env.js`，主代理批准；
   *  对非链接**逐字等价**、对链接**只拆链不跟随**）⇒ **撤掉这条登记**，受管面回到"零未守护"。
   *  两条都**不是**"为了变绿而放宽"：判据式子一字未改，且"未在册 ⇒ 不豁免"这条**比改动前更严**。 */
  const RM_LEGACY_E103 = [
    { file: 'tests\\env.js', id: 'target', max: 1,
      why: '**真守护**：`removeLinkSafe()` 自己的实现（`lstatSync(target)` ⇒ 链接支先 return ⇒ 才递归删真实目录）' }
  ];
  /** **`E117` 的已修复留档**（只作说明 ＋ 定向回归的靶子；**不参与 B① 的豁免**）：
   *  逐处给"为什么它结构上不可能是链接、以及为什么仍然改走安全删除"。
   *  这 6 处的共同点＝**删自建的一次性临时目录/文件**（`mkdtempSync`／`mkdirSync`／`makeTempDir` 刚建出来的），
   *  所以"是链接"在结构上不可能；改走 `env.removeLinkSafe()` 是**兜底**（判错了也不会连带删到目标），
   *  且对非链接**逐字等价**（`env.js` 的 `E46` 段）。 */
  const RM_FIXED_E117 = [
    { file: 'tests\\db-check.js', id: 'lockDir', line0: 510, why: '`fs.mkdtempSync(tempRoot, \'openDb-lock-\')` 刚建的一次性目录：删它只为证明"连接没泄漏、文件没被锁"' },
    { file: 'tests\\db-check.js', id: 'd', line0: 3852, why: '本节自建的备份目录（`makeTempDir()`）的收尾清理' },
    { file: 'tests\\db-check.js', id: 'backupDir', line0: 5112, why: '本节自建的备份目录的收尾清理（原先连 `try` 都没有）' },
    { file: 'tests\\offline-check.js', id: 'd', line0: 762, why: '夹具 `madeDirs`（自己 `mkdirSync` 出来的投放目录）的字节级还原' },
    { file: 'tests\\offline-check.js', id: 'root', line0: 771, why: '夹具自建的临时包根（`输出文件` 交付包形态）的收尾' },
    { file: 'tests\\platform-check.js', id: 'logDir', line0: 273, why: '本节自建的日志目录收尾（本脚本不加载 `lib/harness.js`，故用 `env` 已导出的同名函数）' }
  ];
  /** **判据视图**（在册 ⇒ 按各自 `max` 判；未在册 ⇒ 一律不豁免 —— `E151` 的裁定㈠）。
   *  ⚠ 与 `rmManagedDisk`（原样扫描、不施加任何豁免）**不是一回事**，两者都要留痕：
   *  `rmManagedDisk` 用来回答"清单还准不准"（`rmStale`／B②），`rmManaged` 用来判"有没有新增/超限"。 */
  const rmManaged = rmHitsE103(managedJsE103, RM_LEGACY_E103);
  const rmOverMaxManaged = rmManaged.filter(h => h.registered);      /* 在册但**超过各自 max** ⇒ 必红并指名 */
  const rmNewManaged = rmManaged.filter(h => !h.registered);         /* **未在册**（`E151`：一律不豁免）⇒ 必红并指名 */
  const rmStale = RM_LEGACY_E103.filter(r => !rmManagedDisk.some(h => h.file === r.file && h.id === r.id));
  const ownFace = rmManagedDisk.filter(h => h.file === 'tests\\harness-check.js' || h.file.startsWith('tests\\lib\\'));
  const rmLegacyWhyText = RM_LEGACY_E103.length
    ? RM_LEGACY_E103.map(r => `${r.file}:${r.id}（在册 \`max: ${r.max}\`）—— ${r.why}`).join('；')
    : '（空）';
  t.check('E103-B① 组合判据（**零新增 ＋ 零超限**）：受管面里凡 `fs.rmSync(<标识符>, … recursive:true)`，同文件必须有 `lstatSync(<同一标识符>)`／`isLink(<同一标识符>)`（或已改走 `removeLinkSafe(`）—— 存量按 **`文件＋标识符＋max`** 逐条登记：**清单外的任何一处（`E151`：未在册 ⇒ 连"有判别"也不豁免）或在册超 `max` ⇒ 红并指名**',
    rmManaged.length === 0,
    (rmOverMaxManaged.length || rmNewManaged.length)
      ? `判红：**新增/超限未防护调用点 ${rmManaged.length} 处** —— `
        + rmOverMaxManaged.map(h => `\`${h.file}\`:${h.lines.join('、')}（id=${h.id}：**在册但数到 ${h.count} 处 > \`max: ${h.max}\`**）`).join('；')
        + (rmOverMaxManaged.length && rmNewManaged.length ? '；' : '')
        + rmNewManaged.map(h => `${h.file}:${h.lines.join('、')}（id=${h.id}：判据数到 ${h.count} 处，**清单里没有这个 (文件,id)**）`).join('；')
        + `；已登记存量 ${RM_LEGACY_E103.length} 条 = ` + (RM_LEGACY_E103.map(r => `${r.file}:${r.id}`).join('、') || '（空）')
      : `零新增 ＋ 零超限（受管面**原样扫描**（不施加任何豁免）命中 ${rmManagedDisk.length} 条 \`(文件,id)\`；`
        + `**在册 ${RM_LEGACY_E103.length} 条**全部满足各自 \`max\` ⇒ 判据视图 0 处命中；未在册 0 处）；`
        + `清单里已消失的条目 ${rmStale.length} 条＝` + (rmStale.map(r => `${r.file}:${r.id}`).join('、') || '无')
        + ` ⇒ 存量只减不增、任一处被修好都会在这里显形（但**不判红**：修好不是缺陷））`
        + `｜在册条目与理由（**每轮由紧随其后的 \`t.info\` 印出来** —— \`PASS\` 详情不打印，豁免不许是隐形的）：${rmLegacyWhyText}`);
  t.check('E103-B④ `E117` 显式清单（**不是靠"没扫到"**）：登记在案的 6 处**逐处**都已改走 `removeLinkSafe('
    + '（`文件:标识符` 逐个核对），且受管面**零新增/零超限**（在册条目逐条给 why）—— 其中任一处回潮都会被 B① 当"新增"点名',
    (() => {
      const miss = [];
      for (const r of RM_FIXED_E117) {
        const src = readOrEmpty(path.join(env.paths.root, r.file.split('\\').join(path.sep)));
        if (!new RegExp(`removeLinkSafe\\(\\s*${r.id}\\b`).test(src)) miss.push(`${r.file}:${r.id}（清单里说已改走安全删除，但源码里找不到 \`removeLinkSafe(${r.id}\``);
      }
      return RM_FIXED_E117.length === 6 && miss.length === 0 && rmManaged.length === 0;
    })(),
    `显式登记 ${RM_FIXED_E117.length} 处（应 6）：`
      + RM_FIXED_E117.map(r => `${r.file}:${r.id}`).join('、')
      + `；受管面**新增/超限** ${rmManaged.length} 处（应 0）`
      + `；原样扫描命中 ${rmManagedDisk.length} 条 \`(文件,id)\` ＝ 在册 ${RM_LEGACY_E103.length} 条（逐条 why：${rmLegacyWhyText}）`
      + `（⚠ 由 ` + '`E151`' + ` 的裁定㈠**照出来的历史存量**：旧判据先查守护、后查在册 ⇒ 它们被"文件里有同 id 的判别"吃掉、连普查都看不见；本批**登记**而不是放宽判据）`);
  /* `E151`／`B①`／`B④` 的**受管面读数**：`PASS` 详情不打印 ⇒ 这里用 `t.info` 让"受管面还剩几条在册、
     每条的 why"**每轮可见**（否则"豁免不许是隐形的"就成了一句印不出来的话）。 */
  t.info(`E103-B①／B④ **受管面**读数（口径现算）：**未守护的裸递归删**（按登记 + \`max\` 判定后的违规）`
    + `＝**${rmManaged.length}** 处（应 0）；**原样扫描**（不施加任何豁免）命中 ${rmManagedDisk.length} 条 \`(文件,id)\`；`
    + `**在册只剩 ${RM_LEGACY_E103.length} 条**：${rmLegacyWhyText}`
    + `（⚠ \`E151\` 裁定㈡ 已把 \`tests\\env.js\` 的 \`p\` 那一处接缝改走 \`removeLinkSafe\` ⇒ 该条登记**已撤**：`
    + `受管面回到"**零未守护裸递归删**"，剩下的 \`target\` 是 \`removeLinkSafe()\` 自身的实现、**必须**调 \`fs.rmSync\`）`);
  /* `E117` 的 D22：**内存副本**把其中一处换回裸递归删 ⇒ B① 的同一判据必须红并**指名 `lockDir`**。 */
  {
    const dbPath117 = path.join(env.paths.root, 'tests', 'db-check.js');
    const dbBytes117 = fs.readFileSync(dbPath117);
    const guardCall117 = 'env.removeLinkSafe(lockDir, { recursive: true, force: true })';
    const bareCall117 = 'fs.rmSync(lockDir, { recursive: true, force: true })';
    const curHit117 = scanUnprotectedRm(dbBytes117.toString('utf8')).filter(h => h.id === 'lockDir');
    const mutSrc117 = dbBytes117.toString('utf8').replace(guardCall117, bareCall117);
    const mutHit117 = scanUnprotectedRm(mutSrc117).filter(h => h.id === 'lockDir');
    t.check('E103-B⑤ D22（可证伪，`E117`）：把 `tests\\db-check.js` 里 `lockDir` 那处**换回**裸 `fs.rmSync(lockDir, {recursive:true})`'
      + '（`Module._compile` 级别的**内存字符串副本**，盘上文件全程只读）⇒ 同一判据必红**并指名 `lockDir`**；现行源码零命中',
      mutSrc117 !== dbBytes117.toString('utf8') && mutHit117.length === 1 && mutHit117[0].id === 'lockDir'
        && curHit117.length === 0 && Buffer.compare(dbBytes117, fs.readFileSync(dbPath117)) === 0,
      `现行源码命中 ${curHit117.length} 处（应 0）；内存变异体命中 ${mutHit117.length} 处`
        + `（应 1，id=${mutHit117.map(h => h.id).join('、') || '无'}）；`
        + `盘上 \`tests\\db-check.js\` 逐字节未变=${Buffer.compare(dbBytes117, fs.readFileSync(dbPath117)) === 0}`);
  }
  t.check('E103-B② **本门禁自身的面**（`tests\\harness-check.js` ＋ `tests\\lib\\**`）零未防护 —— 不靠存量清单（那 15 处已改走 `harness.removeLinkSafe()`／`env.removeLinkSafe()`，行为对非链接逐字等价）',
    ownFace.length === 0,
    ownFace.length
      ? `判红：${ownFace.map(h => `${h.file}:${h.line}（id=${h.id}）`).join('；')}`
      : `零未防护（tests\\harness-check.js 与 tests\\lib\\** 里已无 fs.rmSync(…, {recursive:true}) 形态）`);
  const sampleOldEnvShape = 'const st = fs.statSync(full);\n'
    + 'if (now - st.mtimeMs > maxAgeMs) { fs.rmSync(full, { recursive: true, force: true }); }\n';
  const sampleNewEnvShape = 'if (isLink(full)) { removeLinkSafe(full, { recursive: true, force: true }); continue; }\n'
    + 'const st = fs.statSync(full);\n'
    + 'if (now - st.mtimeMs > maxAgeMs) { fs.rmSync(full, { recursive: true, force: true }); }\n';
  /* ⚠ `E151`（2026-10-04）**同批复核本条的样本**（主代理裁定的必做项；**两条路都给读数**，不许默认跳过）：
     本条的 `sampleNewEnvShape` 是**真守护**：`isLink(full)` 的判别结果**控制**了控制流 ——
     是链接 ⇒ 走 `removeLinkSafe()` 并 `continue`（**永远到不了**下面那处裸 `fs.rmSync(full,…)`）；
     不是链接 ⇒ 才落到那处裸删。⇒ 它**在结构上**就是 `tests\env.js` 的现行形态
     （`cleanupStaleTemp()` 的 `isLink(full)` ＋ 过期才递归删），属"**真守护不该被判红**"那一类。
     `E151` 的裁定㈠（未在册 ⇒ 不豁免）下，这种形态**必须按"已登记形态"喂**：给它一份
     `[{ id: 'full', max: 1 }]`（＝"这个 `(文件,id)` 在册、允许 1 处"）⇒ "在册 ＋ 有守护"照旧判绿。
     两条路（**同一次运行里都现算**）：
       · **路 A（本判据采用）**：真守护 ＋ **在册** ⇒ 命中 **0** 条 ⇒ 判绿；
       · **路 B（对照）**：同一段样本**当作未在册**（不给登记）⇒ 命中 **1** 条（`max 0`）⇒ **判红并指名 `full`**。
         这不是"真守护被误判"的缺陷，而是裁定㈠**换来的代价与边界**：判据此刻**不知道**这个 `(文件,id)`
         是谁 ⇒ 宁可判红（"新增即红"是 `E130` 唯一的承诺），由人把它**登记进清单**（登记动作本身即留痕）。
     装饰性形态与真守护在**文本上分不开**（`if (fs.lstatSync(t).isSymbolicLink()) { console.log('note: link'); }`）
     ⇒ 要分得开只能靠**调用点级**判据（`E149`，先给方案）⇒ 这里**不写**"装饰性也必红"的假断言。 */
  const envShapeRegE151 = [{ id: 'full', max: 1 }];
  const oldShapeHits = scanUnprotectedRm(sampleOldEnvShape);
  const newShapeHits = scanRmViolations(sampleNewEnvShape, envShapeRegE151);        /* 路 A：真守护 ＋ 在册 ⇒ 绿 */
  const newShapeUnregHits = scanRmViolations(sampleNewEnvShape);                     /* 路 B：同一段但未在册 ⇒ 红 */
  t.check('E103-B③ D22（可证伪）：把 `tests\\env.js` 的 `cleanupStaleTemp()` 变回**旧形态**（`statSync` 判过期 ＋ 递归删、无 `lstat`）⇒ 同一判据**必红并指名 `full`**；而**现行形态**（`isLink(full)` **真守护** ＋ `(文件,id)` **在册**）判绿 —— 两条读数给出"能证伪"（`E151` 的对照见详情）',
    oldShapeHits.length === 1 && oldShapeHits[0].id === 'full' && newShapeHits.length === 0
      && newShapeUnregHits.length === 1 && newShapeUnregHits[0].id === 'full' && newShapeUnregHits[0].max === 0,
    `旧形态命中 ${oldShapeHits.length} 处（${oldShapeHits.map(h => `id=${h.id}`).join('、')}，应 1）；`
      + `现行形态（真守护＋在册）命中 ${newShapeHits.length} 处（应 0）；`
      + `⚠ 同一段样本当作**未在册**的对照 ⇒ 命中 ${newShapeUnregHits.length} 处`
      + `（${newShapeUnregHits.map(h => `id=${h.id} max=${h.max}`).join('、') || '无'}，应 1 ＝ \`E151\` 裁定㈠的代价）；`
      + `盘上 tests\\env.js 判据视图命中 `
      + `${rmManaged.filter(h => h.file === 'tests\\env.js').length} 处（应 0，与 B① 同源）；`
      + `\`tests\\env.js\` **原样扫描**（不施加任何豁免）命中 `
      + `${rmManagedDisk.filter(h => h.file === 'tests\\env.js').length} 条 \`(文件,id)\`（＝ \`E151\` 照出来的 2 条在册项，逐条 why 见 B①／B④）`);

  /* ==================== 甲-B⑥：`tests\._verify\**` 面的裸递归删守护（`E130`，2026-10-04） ====================
     **为什么这一面必须守（不是"顺手扩大扫描面"）** —— 回执里也复述了这一段：
      ① `._verify\` 是**探针与一次性变异器的家**：各座位每天在这里写脚本、建临时目录、拆链接、删 victim。
         `E46` 的**真毁伤**（`robocopy /MIR` 让目标 5 个文件 → 0）就是**探针第一版**在这一面踩出来的；
         `E117` 修的 **6 处**（现已清零）也全是"探针/夹具自建的一次性临时目录"。
         ⇒ **危险面恰好就是这一面**，而 `E130` 立案前它**一根判据都没有**（`A④` 由代码显式排除该面、
         `B①` 的扫描面只喂受管面），而 `E103` 的判据标题写着"链接安全门禁守护" ⇒ 读者会当成"全仓已守"
         （**过度声明**，`D19` 的同类偏差）。**"当前没出事"不是"不用守"的理由**：删除是合法 git 操作，
         出事后既拦不住也追不回（`E46` 的事故就是这么发生的）。
      ② **为什么不照受管面那样零容忍**：这一面上有**真存量** —— `E46` 的取证探针**故意**调用被禁 API
         （它们是 `E46`／`E103` 的立案实物，删掉就没有实证，`tests\env.js` 的注释正指着它们）、
         从历史提交取出的**旧版本字节副本**（D22／定点变异的基线，不是活动脚本）。
         ⇒ 采用与 `A②`／`丙②` **同款口径**：**已登记残留 ＋ 新增即红**。
      ③ **`E144`（本座位 `T-20261004-16` 甲-D）：登记粒度从 `(文件, 标识符)` 升到
         `(文件, 标识符, 允许出现次数 max)`** —— 这是本节式子本轮**唯一**的强度变化，理由（座位 5 在
         `C·22` 靶子①实测、主代理登记 `E144`）：旧式子按**标识符**去重（`seen.has(m[1])`）＋
         "同文件里有没有 `lstatSync(id)`／`isLink(id)`"（**文件级**判断），于是**"同文件同一标识符再来一处"**
         **静默放行**（去重把它吃掉了，命中数不涨）；而抬头写的是"**多一处就红**" ⇒ 措辞与判据不一致
         （`D19` 的"看起来验过了"）。修法＝**数次数**：清单每条带 `max`（缺省 1，**不隐式放宽**），
         超过 `max` 即红并**逐行指名 `文件:行号`**。
         ⚠ **`E151`（2026-10-04，主代理裁定㈠）：把"守护豁免"从"任何 `(文件,id)`"收窄到"**只在册的** `(文件,id)`"**
         —— 这是本节式子本轮**第二处**强度变化（第一处是 `E144` 的 `max` 计数）。理由（`C·23` 第 4 组报出、
         主代理**独立复现且结果更严重**）：旧写法**第一句**就是 `if (guardedReE144(id).test(code)) continue;`
         ⇒ 守护是**文件级**判断，且对**从未在册的 `(文件,id)`** 同样豁免 ⇒ 一支**全新**探针里只要写一行
         `if (fs.lstatSync(t).isSymbolicLink()) { console.log('note: link'); }`（**装饰性：不 return、结果不
         参与控制流**）＋ 裸 `fs.rmSync(t,{recursive:true})`，`harness-check` 就 **413/0/2 全绿、该文件名
         0 次被提及** ⇒ `E130` 立案时唯一承诺的"**新增即红**"被绕过（`max` 的计数维度对未在册项不起作用）。
         修法＝**先查在册、再谈守护**：未在册 ⇒ **不豁免**（`max` 视作 0，出现一处即红并指名）；
         在册 ⇒ 保持"文件级守护"（`E144` 的 `max` 继续守"同 id 多一处"）。
         ⚠ **仍然存在的边界（如实登记，不假装已覆盖，归 `E149`）**：把守护判到**调用点级**
         （"这一次裸删的同一目标/同一作用域上有没有先做 `lstat`/`isLink` 判定"）**本件没有做** ⇒
         对**在册的** `(文件,id)`，一行**装饰性** `isLink` 仍能让该 id 的裸删豁免（真守护与装饰性写法
         在**文本上**分不开）。⇒ `E151` 只堵住了"未在册"这一侧；在册那一侧的调用点级判定见 `E149`。
         `max>1` 的**条数不写死**：由清单现算（`E156` 的教训 —— 台账里手写的 `8` 与实测的 **11** 不符；
         这条现算读数打进 B⑥ 详情与 `E156` 口径行）。
      ④ **`E140` 的存量迁移已落地（本座位，2026-10-04）**：普查基线＝裸递归删 **106** 处（`E46` 取证实物
         **11** ＋ 旧字节副本 **31** ＋ **一次性探针 64**，分布在 57 个文件）。本轮把 **64 条 probe 类**
         全部改走 `env.removeLinkSafe()`（机械迁移器与逐文件 diff／语法预检见 `tests\._verify\t16-e141\`）；
         **`E46` 的 11 条取证实物与 31 份旧版本字节副本按设计保留**（D22 基线，**不动机器**）。
         迁移后清单＝**42** 条（e46 11 ＋ oldcopy 31），`probe` 类归零 ⇒ `VERIFY_RM_KIND_WHY_E103.probe`
         的说明**保留**（它解释"曾经那一族是什么、为什么不承认其正当性"），但**不再要求该类有非零条数**
         （见 B⑥-口径自证的改动：三类各自非零 → **清单 ↔ 冻结点锚点双向一致**，`E145`）。 */
  const VERIFY_RM_KIND_WHY_E103 = {
    e46: '`E46` 取证探针：**故意**用裸递归删/被禁 API 复现"递归删会顺着 junction 出圈"——它们是 `E46`／`E103` 的立案实物（`tests\\env.js` 的 `E46` 段就指着它们），删掉就没有实证',
    oldcopy: '**旧版本字节副本**：从历史提交取出的受管文件内容（D22／定点变异当基线用），**不是活动脚本**、不参与任何运行；它里面的写法是"当时那一版"的事实，不应改',
    probe: '**一次性探针/复算脚本**：自建临时目录（`mkdtemp`／`mkdir`）后的收尾清理。⚠ 这一族**确实该按 `E117` 的纪律改走 `env.removeLinkSafe()`** —— 本段只登记存量、不承认其正当性；**`E140` 之后该族已清零**，该说明留作"曾经那一族是什么"的档案'
  };
  /**
   * `._verify\` 面**普查所得**的存量清单（`T-20261004-14` 甲组普查；`T-20261004-16` 甲-D 迁移后）。
   * 每条＝`{ file, id, kind, max? }`；**不含行号**（探针随时在动）；`max` 缺省 = **1**（不隐式放宽）。
   * ⚠ 本清单一律**显式带 `max`**（哪怕等于 1）：`E144` 的教训是"登记粒度少了维度 ⇒ 判据与抬头不一致"，
   *   故宁可让"允许几次"成为**可读事实**，也不留"隐式无限次"的缝。
   */
  const RM_RESIDUE_VERIFY_E103 = [
    /* —— e46（11 条）—— */
    { file: 'tests\\._verify\\e46\\probe-danger.js', id: 'RAW', kind: 'e46', max: 2 },
    { file: 'tests\\._verify\\e46\\probe-external.js', id: 'RAW', kind: 'e46' },
    { file: 'tests\\._verify\\e46\\probe-external2.js', id: 'RAW', kind: 'e46' },
    { file: 'tests\\._verify\\e46\\probe-raw.js', id: 'holder', kind: 'e46' },
    { file: 'tests\\._verify\\e46\\probe-raw.js', id: 'RAW', kind: 'e46' },
    { file: 'tests\\._verify\\e46\\probe-raw2.js', id: 'filelink', kind: 'e46' },
    { file: 'tests\\._verify\\e46\\probe-raw2.js', id: 'link', kind: 'e46', max: 2 },
    { file: 'tests\\._verify\\e46\\probe-raw2.js', id: 'RAW', kind: 'e46' },
    { file: 'tests\\._verify\\e46\\probe-raw2.js', id: 'through', kind: 'e46' },
    { file: 'tests\\._verify\\e46\\probe-twoside.js', id: 'l', kind: 'e46', max: 5 },
    { file: 'tests\\._verify\\e46\\probe-twoside.js', id: 'SIDE', kind: 'e46', max: 2 },
    /* —— `E151` 暴露的 5 条（2026-10-04，本批次**同一批登记**）：它们的 `(文件,id)` **从来没进过清单**，
       因为旧判据**先查守护、后查在册**，而它们的文件里都有一处同 id 的 `lstatSync`/`isLink`（有的是
       **测量**、有的是**别处的判定**）⇒ 整个 `(文件,id)` 被"文件级豁免"吃掉、**连普查都看不见**
       （`E140` 的 106 条里也没有它们 ⇒ "普查"当时对"文件里有守护"的那一类是**盲的**）。
       ⇒ `E151` 的裁定㈠（未在册 ⇒ 不豁免）把它们照出来了 ⇒ 按裁定**同批登记**（登记本身即留痕），
       而不是把判据放宽回"未在册也豁免"。它们是 `E46` 家族的**取证探针：故意调用被禁 API**，
       与上面 11 条同类 ⇒ `kind: 'e46'`，`max` ＝ 盘上**实测**出现次数（逐条见括号）。 */
    { file: 'tests\\._verify\\e46\\probe-danger.js', id: 'link', kind: 'e46', max: 3 },   /* 68／84／97：三种持链形态下故意 `rmSync(link,{recursive})` */
    { file: 'tests\\._verify\\e46\\probe-raw.js', id: 'link', kind: 'e46' },               /* 115：D1 案（裸递归删 junction） */
    { file: 'tests\\._verify\\e46\\probe-raw2.js', id: 'dirlink', kind: 'e46' },           /* 119：T6 目录符号链接那一支 */
    { file: 'tests\\._verify\\e46\\probe-twoside.js', id: 'link', kind: 'e46' },           /* 68：danger 侧对照 */
    { file: 'tests\\._verify\\review\\s5t20-junction.js', id: 'link', kind: 'e46',         /* 54：`E46` 家族的两侧对照（`removeLinkSafe` vs 裸 `rmSync`），座位 5 取证件 */
      why: '故意用裸递归删复现"会不会顺着 junction 出圈"、并与 `env.removeLinkSafe()` 两侧对照 ⇒ 与 `E46` 的取证实物同族' },
    /* —— oldcopy（31 条）—— */
    { file: 'tests\\._verify\\e90\\harness.head2.js', id: 'dir', kind: 'oldcopy', max: 3 },
    { file: 'tests\\._verify\\e90\\harness.head2.js', id: 'env', kind: 'oldcopy' },
    { file: 'tests\\._verify\\e90\\harness.pristine.js', id: 'dir', kind: 'oldcopy', max: 3 },
    { file: 'tests\\._verify\\e90\\harness.pristine.js', id: 'env', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\e103-old-env.blob.js', id: 'full', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', id: 'authTmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', id: 'd', kind: 'oldcopy', max: 3 },
    { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', id: 'dir', kind: 'oldcopy', max: 2 },
    { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', id: 'f20Tmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', id: 'logDir', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', id: 'root', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', id: 'tmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', id: 'w5Tmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', id: 'w6Tmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\old-harness-0996ed0.js', id: 'w7Tmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\platform-check.legacy-shape.js', id: 'logDir', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', id: 'authTmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', id: 'd', kind: 'oldcopy', max: 3 },
    { file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', id: 'dir', kind: 'oldcopy', max: 2 },
    { file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', id: 'f20Tmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', id: 'logDir', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', id: 'root', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', id: 'tmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', id: 'w5Tmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', id: 'w6Tmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\s5t04-blob-harness-d9f3721.js', id: 'w7Tmp', kind: 'oldcopy' },
    { file: 'tests\\._verify\\review\\s5t04-blob-platform-7e0a53c.js', id: 'logDir', kind: 'oldcopy' },
    { file: 'tests\\._verify\\w1\\db-check.before.js', id: 'backupDir', kind: 'oldcopy' },
    { file: 'tests\\._verify\\w1\\db-check.before.js', id: 'lockDir', kind: 'oldcopy' },
    { file: 'tests\\._verify\\w4\\bak\\tests__db-check.js', id: 'backupDir', kind: 'oldcopy' },
    { file: 'tests\\._verify\\w4\\bak\\tests__db-check.js', id: 'lockDir', kind: 'oldcopy', max: 2 },
  ];
  const rmVerify = rmHitsE103(verifyJsE103);
  /** `E144` 承诺的另一半（**"同一 `(文件,id)` 超过 `max` 一处 ⇒ 红并指名"**）在**盘上真扫**这一侧的落点。
   *  ⚠ **本件新补（2026-10-04，随 `E151` 同批）**：`rmVerify` 走的是 `rmHitsE103(verifyJsE103)`
   *  ——**没把登记清单喂进判据** ⇒ 它只能回答"盘上这个 `(文件,id)` 在不在册"，**回答不了"它超没超 `max`"**：
   *  一个在册的 `(文件,id)` 在盘上出现 `max + 5` 次，`rmNewVerify` 那一条照样绿（`h.registered` 恒 false）
   *  ⇒ B⑥ 的**抬头**写着"超过 `max` 一处 ⇒ 红并指名"，而**真扫**里没有这一维（`D19`：措辞强于判据 ——
   *  与 `E144` 立案的病灶**同型**，只是这次在"真扫 vs D22"之间）。故这里**再算一遍**"喂了清单"的读数：
   *  在册项按各自 `max` 判定 ⇒ 超限即命中并指名（未在册项也照旧命中，见 `E151`）。
   *  ⚠ 与 `rmVerify` **不是一回事**（口径不同，两者都留痕）：`rmVerify`＝"盘上未防护 `(文件,id)`"
   *  （用于与清单对账 ⇒ `E145` 留痕行）；`rmVerifyRegE144`＝"**按登记 + max 判定后的违规**"。 */
  const rmVerifyRegE144 = rmHitsE103(verifyJsE103, RM_RESIDUE_VERIFY_E103);
  const rmOverMaxVerify = rmVerifyRegE144.filter(h => h.registered);
  const rmNewVerify = rmVerifyRegE144.filter(h => !h.registered);
  const rmStaleVerify = RM_RESIDUE_VERIFY_E103.filter(r => !rmVerify.some(h => h.file === r.file && h.id === r.id));
  const rmKindCountVerify = ['e46', 'oldcopy', 'probe']
    .map(k => `${k} ${RM_RESIDUE_VERIFY_E103.filter(r => r.kind === k).length} 条`).join('、');
  /** `E145`（本座位 `T-20261004-16` 甲-E）的**双向一致性**纯函数：清单 ↔ 盘上实存，**两个方向都返回**。
   *  为什么必须双向：单向（"盘上 ⊆ 清单"）只保证"没有未登记的裸删"，**保证不了"清单还准"** ——
   *  把 64 条 probe 条目删光也照样绿（座位 5 在 `C·22` 靶子⑧指出：旧口径自证只要求三类**各自非零**，
   *  于是"删到只剩象征性几条"恒真）⇒ 清单会从"普查台账"退化成"象征性留几条"，真实存量**没人再知道**。
   *  @returns {{missing:Array, extra:Array}}（`missing`＝清单里有、盘上找不到；`extra`＝盘上有、清单里没有） */
  const registryConsistencyE145 = (residueList, diskHits) => ({
    missing: residueList.filter(r => !diskHits.some(h => h.file === r.file && h.id === r.id)),
    extra: diskHits.filter(h => !residueList.some(r => r.file === h.file && r.id === h.id))
  });
  /** `E156`（2026-10-04，`C·23` 第 6 组）**口径自证**：把"出现次数"这类**统计数**做成**现算**、
   *  并把**口径**（数的是什么、在哪个面、什么时刻）打进输出 —— 立案事实：台账里"裸删出现次数
   *  `128 → 54`"在**四处**各不相同（快照 54／`probe-counts-after.log` 55／`census-before.log` 123、101／
   *  复核方 66、71），根因是**没有一处写清口径**；而"显式带 `max` 的条目"台账写 **8**、实测 **11**（手写数）。
   *  ⇒ 本件只做两件事：①这两条读数**现算**（不再手写）②把口径印在读数旁边。
   *  **口径（逐字，复算请照此数）**：
   *   · **面**＝`verifyJsE103`（`tests\**\*.js` ＋ `tools\**\*.js` 里**相对仓库根路径含 `._verify\`** 的
   *     那些文件；**本轮扫描时刻**的盘上状态，**不看 git 跟踪状态**）；
   *   · **数的对象**＝`fs.rmSync(<标识符>, …, recursive:true)` 的**原始出现次数**（`re.exec` 命中数求和）；
   *     ⚠ **不是** `(文件,id)` 对数、**不是**"命中行数"、**不是**"清单条数"；
   *   · **两个口径各给一个数**：`raw`＝**不施加任何豁免**（连"同文件有 `lstatSync`/`isLink`"也算）；
   *     `bare`＝按**本门禁现行豁免规则**（`E151` 之后：**在册** `(文件,id)` ＋ 该 id 有判别 ⇒ 不计；未在册 ⇒ 一律计）；
   *   · **时刻**＝本轮 `harness-check` 跑本节的那一刻（探针生灭会改这个数 ⇒ 它只是**当轮读数**，
   *     **不是**"存量真值"；防退化靠 `E145` 的逐条 `sha12` 锚点，那一层已被证明可复算）。
   *  ⇒ 与旧数（128／106／54／55／123／101／66／71）**不可能逐个对上**：它们分别数在**不同的面**（迁移前的
   *    历史面／含/不含 `review\`）、**不同的豁免口径**（含已获豁免的在册项）、**不同的时刻**，或干脆是手写。
   *     本行给出的两个数**任何时候都能用同一条命令复算**（见回执里的命令）。 */
  const e156Count = (withGuardExemption) => verifyJsE103.reduce((acc, f) => {
    const code = stripLiterals(readOrEmpty(f));
    const re = /fs\.rmSync\((\w+)[^)]*recursive:\s*true/g;
    let m; let n = 0;
    while ((m = re.exec(code))) { if (withGuardExemption && guardedReE144(m[1]).test(code)) continue; n++; }
    return acc + n;
  }, 0);
  const e156Raw = e156Count(false);
  const e156Bare = e156Count(true);
  const e156MaxGt1 = RM_RESIDUE_VERIFY_E103.filter(r => (Number.isFinite(r.max) ? r.max : 1) > 1).length;
  const e156MaxExplicit = RM_RESIDUE_VERIFY_E103.filter(r => Number.isFinite(r.max)).length;
  t.info(`\`E156\` 口径自证（**现算**，不手写）：\`._verify\` 面（${verifyJsE103.length} 个 .js）**本轮扫描时刻**的`
    + `裸递归删**出现次数** —— 口径 \`raw\`（不施加任何豁免）＝**${e156Raw}** 次；`
    + `口径 \`bare\`（按现行豁免：在册 + 有判别 ⇒ 不计）＝**${e156Bare}** 次。`
    + `清单侧现算：条目 **${RM_RESIDUE_VERIFY_E103.length}** 条、**显式带 \`max\`** 的 **${e156MaxExplicit}** 条、`
    + `**\`max>1\`** 的 **${e156MaxGt1}** 条（台账里手写的 \`8\` 与实测 **${e156MaxGt1}** 不符 ⇒ 本行是它的真源）。`
    + `⚠ 这两个数**只在"面＝\`._verify\\\`、时刻＝本轮、豁免＝上述两条"下成立** ⇒ 与历史台账里的`
    + `128／106／54／55／123／101／66／71 **不是同一个量**（口径未写明）；防退化以 \`E145\` 的逐条摘要 \`sha12\` 为准。`);
  t.check('E103-B⑥ 组合判据（**`tests\\._verify\\**` 面，`E130`／`E144`／`E151`**）：这一面里凡 ' +
    '`fs.rmSync(<标识符>, … recursive:true)`，同文件必须有 `lstatSync(<同一标识符>)`／`isLink(<同一标识符>)`' +
    '（或已改走 `removeLinkSafe(`）—— 存量按 **`文件＋标识符＋允许出现次数 max`** 逐条登记：' +
    '**同一 `(文件,id)` 超过 `max` 一处、或出现清单外的新调用点（`E151`：未在册 ⇒ 连"有判别"也不豁免）⇒ 红并指名 `文件:行号`**',
    rmVerifyRegE144.length === 0,
    (rmNewVerify.length || rmOverMaxVerify.length)
      ? `判红：**超限/新增未防护调用点 ${rmNewVerify.length + rmOverMaxVerify.length} 处** —— `
        + rmOverMaxVerify.map(h => `\`${h.file}\`:${h.lines.join('、')}（id=${h.id}：**在册但数到 ${h.count} 处 > \`max: ${h.max}\`**）`).join('；')
        + (rmOverMaxVerify.length && rmNewVerify.length ? '；' : '')
        + rmNewVerify.map(h => `${h.file}:${h.lines.join('、')}（id=${h.id}：判据数到 ${h.count} 处，**清单里没有这个 (文件,id)**）`).join('；')
        + `；已登记存量 ${RM_RESIDUE_VERIFY_E103.length} 条（${rmKindCountVerify}）`
      : `零超限（\`._verify\\\` 面**原样扫描**（不施加任何豁免）命中 ${rmVerify.length} 条 \`(文件,id)\`，全部 ⊆ 已登记存量；`
        + `**按登记 + \`max\` 判定**（\`E144\` 那一半 ＋ \`E151\` 的未在册不豁免）：未在册 **${rmNewVerify.length}** 处（应 0）、在册超限 **${rmOverMaxVerify.length}** 处（应 0）；`
        + `清单侧现算：共 ${RM_RESIDUE_VERIFY_E103.length} 条（${rmKindCountVerify}）、显式带 \`max\` 的 ${e156MaxExplicit} 条、\`max>1\` 的 **${e156MaxGt1}** 条；`
        + `清单里已消失的条目 ${rmStaleVerify.length} 条＝` + (rmStaleVerify.map(r => `${r.file}:${r.id}`).join('、') || '无')
        + ` ⇒ 存量只减不增，谁把它改走 \`removeLinkSafe()\` 都会在这里显形（**本判据不判红**：修好不是缺陷 ——`
        + `"清单变短"这件事由 B⑥-口径自证按**双向一致**强制守住，见 \`E145\`））`);
  /* `E144` 的 D22（可证伪，**三支读数**）：
     ① **同文件同标识符多一处**（旧式子按 id **去重** ⇒ 命中数不涨、静默放行）⇒ 新判据必红并指名行号；
     ② **同一个 id 在两支文件里各一处**（各自在册、`max:1`）⇒ 这是**正常形态**，新判据必须**绿**
        （⇒ 不是"只要有这个 id 就红"的恒红式）；
     ③ 同一份源码在**旧式子**下的读数一并留痕（对照：它只报 1 条、**看不出"多了一处"**）。
     ⚠ **如实登记一条已知边界**：`E144` 报告里的第二种触发 ——"同文件本来就有 `lstatSync(X)`／`isLink(X)`
        时**别处**再加一处裸 `fs.rmSync(X,…)` 也过"—— 在**新式子里同样判绿**（新旧两支都把"有没有守护"
        判成**文件级**），本件改的只是"**去重** vs **数次数**"这一个维度 ⇒ **不写**"这一形态也必红"的假断言。
     样本一律**拼接构造**（逐字写被禁形态会自伤 —— 本节 A③／A⑥ 都踩过）。 */
  {
    /* ① 同一 id、两处裸删；清单登记"至多 1 次" */
    const dupSrc = 'const p = mkOneShot();\n'
      + 'fs.' + 'rmSync(p, { recursive: ' + 'true, force: true });\n'
      + '/* 这里再来一处同一个 id（旧式子按 id 去重 ⇒ 静默放行）*/\n'
      + 'fs.' + 'rmSync(p, { recursive: ' + 'true, force: true });\n';
    const dupHits = scanRmViolations(dupSrc, [{ id: 'p', max: 1 }]);
    const dupHitsOld = scanUnprotectedRmNaive(dupSrc);      /* 旧支读数（对照：只 1 条、无"超限"维度） */
    /* ② 同一个 id 分处两支文件、**各一处**（各自在册 max:1）⇒ 两支都必须绿 */
    const libSrc = 'const lk = mkOneShot();\n';
    const srcA = libSrc + 'fs.' + 'rmSync(zzx, { recursive: ' + 'true, force: true });\n';
    const srcB = libSrc + 'if (env.' + 'isLink(zzx)) { env.removeLinkSafe(zzx, { recursive: ' + 'true, force: true }); }\n'
      + 'fs.' + 'rmSync(zzx, { recursive: ' + 'true, force: true });\n';
    const regZ = [{ id: 'zzx', max: 1 }];
    const aNew = scanRmViolations(srcA, regZ);
    const bNew = scanRmViolations(srcB, regZ);
    /* 反例（**防止判据变成恒红**）：同一判据喂"只有一处裸删 + max:1"必须**绿** */
    const cleanSrc = 'const p = mkOneShot();\n'
      + 'fs.' + 'rmSync(p, { recursive: ' + 'true, force: true });\n';
    const cleanHits = scanRmViolations(cleanSrc, [{ id: 'p', max: 1 }]);
    /* `E151`（2026-10-04，主代理裁定㈠）的**五形态读数**（同一判据、同一次运行里现算）：
       ① 全新文件（`(文件,id)` **从未在册**）＋ **装饰性**守护 ⇒ **必红并指名**（这正是被绕过的那一处）；
       ② 全新文件（未在册）＋ **纯裸删** ⇒ 必红（对照：裁定㈠没有把"新增即红"弄丢）；
       ③ **在册** ＋ **真守护**（`isLink` 的判别结果**控制**了控制流）⇒ **必绿**（真守护不该被判红）；
       ④ **在册** ＋ 同 id 多一处（超 `max`）⇒ 必红（下面那条"内存追加第 3 处"就是它，`max` 仍生效）；
       ⑤ **在册** ＋ **装饰性**守护 ⇒ **仍绿** —— 这是 `E149` 的边界（真守护与装饰性写法**文本上分不开**），
          **只作留痕、不当"已覆盖"**（`E149` 要做调用点级判定才分得开；这里不写"它必红"的假断言）。
       ⚠ 形态③要**有判别力**：样本里放**两处**裸删 ＋ `max:1` ⇒ 若"文件级守护豁免"不起作用就会是 `2 > 1` ⇒ 红；
       正因为豁免真在起作用才绿 ⇒ 这条读数测到的是**豁免本身**，不只是"单处 ≤ max"。 */
    const decorGuardE151 = 'if (fs.lstatSync(t).isSymbolicLink()) { console.log(' + Q_E103 + 'note: link' + Q_E103 + '); }\n';
    const e151UnregDecor = 'const t = mkOneShot();\n' + decorGuardE151
      + 'fs.' + 'rmSync(t, { recursive: ' + 'true, force: true });\n';
    const e151UnregPlain = 'const t = mkOneShot();\n'
      + 'fs.' + 'rmSync(t, { recursive: ' + 'true, force: true });\n';
    const e151RegTrueGuard = 'if (isLink(t)) { removeLinkSafe(t, { recursive: ' + 'true, force: true }); continue; }\n'
      + 'fs.' + 'rmSync(t, { recursive: ' + 'true, force: true });\n'
      + 'fs.' + 'rmSync(t, { recursive: ' + 'true, force: true });\n';
    const e151RegDecor = 'const t = mkOneShot();\n' + decorGuardE151
      + 'fs.' + 'rmSync(t, { recursive: ' + 'true, force: true });\n';
    const e151Hits = {
      unregDecor: scanRmViolations(e151UnregDecor),                        /* 未在册 ⇒ 无登记 ⇒ max 0 ⇒ 必红 */
      unregPlain: scanRmViolations(e151UnregPlain),
      regTrueGuard: scanRmViolations(e151RegTrueGuard, [{ id: 't', max: 1 }]),
      regDecor: scanRmViolations(e151RegDecor, [{ id: 't', max: 1 }])
    };
    t.check('E144 D22（可证伪）：**同文件同标识符多一处**（旧式子按 id 去重 ⇒ 命中数不涨）' +
      ' ⇒ 新判据**必红并指名行号**；而"同 id 在两支文件里各一处（各自 `max:1`）"与' +
      '"只有一处裸删＋`max:1`"都必须**绿**（⇒ 不是恒红式）；**`E151`：未在册的 `(文件,id)` 一律不豁免**' +
      '（新文件 ＋ 装饰性 `lstatSync` 守护 ＋ 裸删 ⇒ **必红并指名**；新文件 ＋ 纯裸删 ⇒ 必红；' +
      '**在册 ＋ 真守护 ⇒ 仍绿**）',
      dupHits.length === 1 && dupHits[0].id === 'p' && dupHits[0].count === 2 && dupHits[0].lines.length === 2
        && dupHitsOld.length === 1
        && aNew.length === 0 && bNew.length === 0
        && cleanHits.length === 0
        && e151Hits.unregDecor.length === 1 && e151Hits.unregDecor[0].id === 't' && e151Hits.unregDecor[0].max === 0
        && e151Hits.unregPlain.length === 1 && e151Hits.unregPlain[0].id === 't' && e151Hits.unregPlain[0].max === 0
        && e151Hits.regTrueGuard.length === 0,
      `形态①（同 id × 2、max:1）⇒ 新判据命中 ${dupHits.length} 条（${dupHits.map(h => `id=${h.id} 数到 ${h.count} 处、行 ${h.lines.join('、')}`).join('；') || '（无，异常）'}），`
        + `旧式子命中 ${dupHitsOld.length} 条（**去重 ⇒ 看不出"多了一处"**）；`
        + `形态②（同 id 分处两支文件、各 1 处、各在册 max:1）⇒ 新判据 文件A ${aNew.length} 条／文件B ${bNew.length} 条（都应 0）；`
        + `反例（单处裸删＋max:1）⇒ ${cleanHits.length} 条（应 0）；`
        + `【\`E151\` 五形态】㈠未在册＋**装饰性**守护＋裸删 ⇒ ${e151Hits.unregDecor.length} 条`
        + `（${e151Hits.unregDecor.map(h => `id=${h.id} max=${h.max}`).join('、') || '无'}，**应 1 ＝ 必红并指名**）；`
        + `㈡未在册＋纯裸删 ⇒ ${e151Hits.unregPlain.length} 条（应 1，对照）；`
        + `㈢在册＋**真守护**（` + '`isLink(t)`' + ` 控制控制流、样本里两处裸删、max:1）⇒ ${e151Hits.regTrueGuard.length} 条`
        + `（**应 0 ＝ 真守护仍绿**；若文件级豁免失效就会是 2 > 1）；`
        + `㈣在册＋同 id 多一处（超 max）⇒ 见下一条 D22；`
        + `㈤在册＋**装饰性**守护 ⇒ ${e151Hits.regDecor.length} 条（**留痕：这是 \`E149\` 的边界**，`
        + `真守护与装饰性在文本上分不开 ⇒ 本件**不**声称它已覆盖）`);
    /* 更强的一条：在**已登记文件**（`e46\probe-raw2.js`）的**内存副本**里，对**已登记的那个 id**（`link`）
       再加一处裸删 —— `link` 在该文件的 `max` 是 2，故**必须红**（旧式子：同 id 去重 ⇒ 绿）。
       盘上文件全程只读（`Buffer.compare` 复核）。 */
    const residFileE144 = path.join(env.paths.root, 'tests', '._verify', 'e46', 'probe-raw2.js');
    const residBytesE144 = fs.existsSync(residFileE144) ? fs.readFileSync(residFileE144) : null;
    const residSrcE144 = residBytesE144 === null ? '' : residBytesE144.toString('utf8');
    const mutBytesE144 = residBytesE144 === null ? null : Buffer.concat([residBytesE144,
      Buffer.from('\nconst zzExtraSameId = 1;\nfs.' + 'rmSync(link, { recursive: ' + 'true, force: true });\n', 'utf8')]);
    const beforeE144 = scanRmViolations(residSrcE144, RM_RESIDUE_VERIFY_E103.filter(r => r.file === 'tests\\._verify\\e46\\probe-raw2.js'));
    const afterE144 = mutBytesE144 === null ? [] : scanRmViolations(mutBytesE144.toString('utf8'),
      RM_RESIDUE_VERIFY_E103.filter(r => r.file === 'tests\\._verify\\e46\\probe-raw2.js'));
    const linkRowE144 = afterE144.find(h => h.id === 'link');
    const diskSameE144 = residBytesE144 !== null && Buffer.compare(residBytesE144, fs.readFileSync(residFileE144)) === 0;
    t.check('E144 D22（可证伪，**已登记文件里的"同 id 再加一处"**）：在 `tests\\._verify\\e46\\probe-raw2.js` 的' +
      '**内存副本**里对**已登记的 id** `link`（该文件登记 `max: 2`）再加一处裸递归删 ⇒ 判据**必红并指名该行**；' +
      '原件（`link` 恰好 2 处）必须绿；盘上文件逐字节未变',
      residBytesE144 !== null && beforeE144.length === 0 && Boolean(linkRowE144)
        && linkRowE144.count === 3 && linkRowE144.max === 2 && diskSameE144,
      residBytesE144 === null ? '（`tests\\._verify\\e46\\probe-raw2.js` 不存在 ⇒ 本 D22 未执行）'
        : `原件违规 ${beforeE144.length} 条（应 0，\`link\` 登记 max:2、盘上恰好 2 处）⇒ 内存追加第 3 处后 `
          + `违规 ${afterE144.length} 条、其中 \`link\`：数到 ${linkRowE144 ? linkRowE144.count : '-'} 处 > max ${linkRowE144 ? linkRowE144.max : '-'}`
          + `（行 ${linkRowE144 ? linkRowE144.lines.join('、') : '-'}）；盘上文件逐字节未变=${diskSameE144}`);
    /* `E151` 的**五形态读数**（`PASS` 详情不打印 ⇒ 这里用 `t.info` 让它**每轮都可见**；
       立案要求的"必红/必绿"四条 ＋ 一条如实留痕的边界，一条都不许省）。 */
    t.info(`\`E151\` 五形态读数（判据：\`scanRmViolations()\`；同一次运行里现算）：`
      + `㈠**未在册** ＋ 装饰性守护（\`if (fs.lstatSync(t).isSymbolicLink()) { console.log('note: link'); }\`，**不 return**）＋ 裸递归删 `
      + `⇒ **命中 ${e151Hits.unregDecor.length} 条**（id=${e151Hits.unregDecor.map(h => h.id).join('、') || '无'}、\`max\`=${e151Hits.unregDecor.map(h => h.max).join('、') || '-'}）`
      + `＝**必红并指名**（改动前这一形态判绿、文件名 0 次被提及）；`
      + `㈡**未在册** ＋ 纯裸删 ⇒ **命中 ${e151Hits.unregPlain.length} 条**（对照，必红）；`
      + `㈢**在册** ＋ **真守护**（样本里两处裸递归删、\`max:1\` ⇒ 若文件级豁免失效就是 2 > 1）⇒ **命中 ${e151Hits.regTrueGuard.length} 条**（必绿）；`
      + `㈣**在册** ＋ 同 id 多一处（超 \`max\`）⇒ **必红并指名**（见上面那条内存变异：\`link\` 数到 3 处 > \`max: 2\`）；`
      + `㈤**在册** ＋ 装饰性守护 ⇒ 命中 ${e151Hits.regDecor.length} 条（**如实留痕：这是 \`E149\` 的边界** —— 文本上分不开真守护与装饰性，`
      + `本件**不**声称已覆盖，留作调用点级判据）。`);
  }
  /* `E145` 的**口径自证（本座位改写，2026-10-04）**：原口径只要求"三类各自非零条数" ⇒ 把清单一类
     删到 1 条也照样绿（座位 5 在 `C·22` 靶子⑧指出：清单会从"普查台账"退化成"象征性留几条"）。
     **为什么不拿"清单 ↔ 盘上实存"直接对账**（第一版这么写，实测**假红**）：`._verify\` 是 scratch 面，
     各座位随时往里写探针 —— 本座位实测那一刻盘上多出 `tests\._verify\e146-probe.js [dir]`
     （另一个座位的探针）。那份"多出来的命中"**确实该在 B⑥ 判红**（新增即红），
     但它与"这份清单是不是还被认真维护"**不是同一件事**；把两者焊在一起 ⇒ 别人一写探针，
     `E145` 就红，人就会去"把这条判据放宽"，而那正是 `D21` 禁的动作。
     ⇒ 改成**对清单自身**的双向锚点：①三类条数（`E140` 迁移后的冻结点）②逐条摘要（`sha12`）。
        · **删条目**（或改 `max`／改文件名）⇒ 摘要不符 ⇒ **红并逐条指名 missing／extra**（旧口径照样绿）；
        · **`E140` 这类正当迁移** ⇒ 必须**同时**更新这里的三类条数锚点（＝把"清单变短"变成一次
          **自觉的、留痕的**改动，而不是"悄悄少几条"）—— 这正是原口径缺的那一层。
     ⚠ 与"盘上实存"的对账**不在这里判红**：新增未登记命中由 B⑥ 逐处指名判红（那是它的职责）；
       本判据只把它**留痕**（`t.info`），供人对照"清单还在不在盘上"。 */
  const REGISTRY_ANCHOR_E145 = { total: 47, e46: 16, oldcopy: 31, probe: 0, sha12: 'd8e4411aa8b1' };  const anchorCountsE145 = (() => {
    const m = {};
    for (const r of RM_RESIDUE_VERIFY_E103) { const k = `${r.file}|${r.id}`; m[k] = (m[k] || 0) + 1; }
    return m;
  })();
  const countKindsE145 = { e46: 0, oldcopy: 0, probe: 0 };
  for (const r of RM_RESIDUE_VERIFY_E103) countKindsE145[r.kind] = (countKindsE145[r.kind] || 0) + 1;
  const sha12E145 = require('node:crypto').createHash('sha256')
    .update(RM_RESIDUE_VERIFY_E103.map(r => `${r.file}|${r.id}|${r.kind}|${Number.isFinite(r.max) ? r.max : 1}`).join('\n'))
    .digest('hex').slice(0, 12);
  /**
   * 清单**自身的**双向对账（`E145` 的纯函数，供主断言与 D22 复用）：与传入的 `anchorCounts`
   * （＝冻结点的逐条计数）比，"锚点里有、清单里没有" ⇒ `missing`（**被删掉的条目**，旧口径下静默）；
   * "清单里有、锚点里没有" ⇒ `extra`（**偷偷加进来的条目**）。
   * @param {Array<{file:string,id:string}>} list
   * @param {Object<string,number>} anchorCounts `文件|id` → 应出现次数
   * @returns {{missing:Array<{file:string,id:string}>, extra:Array<{file:string,id:string}>}}
   */
  const registryAnchorAuditE145 = (list, anchorCounts) => {
    const at = (r) => `${r.file}|${r.id}`;
    const got = new Map();
    for (const r of list) got.set(at(r), (got.get(at(r)) || 0) + 1);
    const missing = [];   /* 锚点里有、清单里没有 ⇒ "被删掉的条目" */
    const extra = [];     /* 清单里有、锚点里没有 ⇒ "偷偷加进来的条目" */
    for (const [key, n] of Object.entries(anchorCounts)) {
      const have = got.get(key) || 0;
      const [file, id] = key.split('|');
      for (let k = have; k < n; k++) missing.push({ file, id });
      for (let k = n; k < have; k++) extra.push({ file, id });
      got.delete(key);
    }
    for (const [key, n] of got) { const [file, id] = key.split('|'); for (let k = 0; k < n; k++) extra.push({ file, id }); }
    return { missing, extra };
  };
  const kindWhyList = ['e46', 'oldcopy', 'probe'].filter(k => RM_RESIDUE_VERIFY_E103.some(r => r.kind === k));
  const auditSelfE145 = registryAnchorAuditE145(RM_RESIDUE_VERIFY_E103, anchorCountsE145);
  t.check('E103-B⑥-口径自证（`E130`／`E145`）：存量清单每一条都带 `kind`（且 `kind` 都能在 ' +
    '`VERIFY_RM_KIND_WHY_E103` 里查到"这是什么、为什么留在清单里"）；**且清单与"冻结点锚点"双向一致** —— ' +
    '三类条数（total／e46／oldcopy／probe）逐项相符 ＋ 逐条摘要 `sha12` 相符 ⇒ ' +
    '**删条目/改条目会造成 `missing`／`extra` 并指名，绝不会"悄悄少几条"**' +
    '（`E140` 迁移把 probe 类清零，锚点已随之更新；正当改动必须**同步改这里的三类条数锚点**）',
    RM_RESIDUE_VERIFY_E103.length > 0
      && RM_RESIDUE_VERIFY_E103.every(r => typeof VERIFY_RM_KIND_WHY_E103[r.kind] === 'string' && VERIFY_RM_KIND_WHY_E103[r.kind].length > 10)
      && RM_RESIDUE_VERIFY_E103.length === REGISTRY_ANCHOR_E145.total
      && countKindsE145.e46 === REGISTRY_ANCHOR_E145.e46
      && countKindsE145.oldcopy === REGISTRY_ANCHOR_E145.oldcopy
      && countKindsE145.probe === REGISTRY_ANCHOR_E145.probe
      && sha12E145 === REGISTRY_ANCHOR_E145.sha12,
    `清单 ${RM_RESIDUE_VERIFY_E103.length} 条＝${rmKindCountVerify}（锚点：total ${REGISTRY_ANCHOR_E145.total}／`
      + `e46 ${REGISTRY_ANCHOR_E145.e46}／oldcopy ${REGISTRY_ANCHOR_E145.oldcopy}／probe ${REGISTRY_ANCHOR_E145.probe}）；`
      + `逐条摘要 sha12 ${sha12E145}（锚点 ${REGISTRY_ANCHOR_E145.sha12}）；`
      + `双向：missing ${auditSelfE145.missing.length} 条＝`
      + (auditSelfE145.missing.map(r => `${r.file}:${r.id}`).join('、') || '无')
      + `／extra ${auditSelfE145.extra.length} 条＝`
      + (auditSelfE145.extra.map(r => `${r.file}:${r.id}`).join('、') || '无')
      + `；逐类说明：` + kindWhyList.map(k => `${k}＝${VERIFY_RM_KIND_WHY_E103[k].slice(0, 34)}…`).join('｜'));
  /* **留痕（不判红）**：清单与"盘上实存"的差集 —— 只读、只打印。
     为什么不判红（实测踩过，理由写在上面那段注释里）：`._verify\` 是 scratch 面，本座位实测那一刻
     盘上多出 `tests\._verify\e146-probe.js [dir]`（另一个座位的探针）—— 那份"多出来的命中"
     **由 B⑥ 逐处指名判红**（新增即红，它的职责），不该顺带把"清单维护"这条判据也染红。 */
  const diskVsRegistryE145 = registryConsistencyE145(RM_RESIDUE_VERIFY_E103, rmVerify);
  t.info(`§五「E145 留痕（不判红）」清单 ${RM_RESIDUE_VERIFY_E103.length} 条 ↔ 盘上实存 ${rmVerify.length} 条：`
    + `missing（清单里有、盘上没有）${diskVsRegistryE145.missing.length} 条＝`
    + (diskVsRegistryE145.missing.map(r => `${r.file}:${r.id}`).join('、') || '无')
    + `；extra（盘上有、清单里没有）${diskVsRegistryE145.extra.length} 条＝`
    + (diskVsRegistryE145.extra.map(h => `${h.file}:${h.id}`).join('、') || '无')
    + '（后者的判红在 B⑥，不在本判据）');
  /* `E145` 的 **D22**（可证伪）：**内存副本**清单删掉一条 ⇒ 同一纯函数必须把它列进 `missing` **并指名**
     （旧口径"三类各自非零"下照样绿）；把清单**再加一条**（清单外的合成条目）⇒ 进 `extra`。 */
  {
    const victimE145 = RM_RESIDUE_VERIFY_E103[0];
    const shrunkE145 = RM_RESIDUE_VERIFY_E103.filter(r => r !== victimE145);
    const auditShrunkE145 = registryAnchorAuditE145(shrunkE145, anchorCountsE145);
    const addedE145 = RM_RESIDUE_VERIFY_E103.concat([{ file: 'tests\\._verify\\t16-e141\\zz-e145-synth.js', id: 'q', kind: 'probe', max: 1 }]);
    const auditAddedE145 = registryAnchorAuditE145(addedE145, anchorCountsE145);
    t.check('E145 D22（可证伪）：把清单的**内存副本**删掉一条（`' + victimE145.file + ':' + victimE145.id + '`）⇒ ' +
      '同一纯函数必须把它列进 `missing` **并指名**（旧口径"三类各自非零"下照样绿）；再加一条清单外的条目 ⇒ 进 `extra`（**两个方向都可证伪**）',
      auditShrunkE145.missing.length === 1
        && auditShrunkE145.missing[0].file === victimE145.file && auditShrunkE145.missing[0].id === victimE145.id
        && auditShrunkE145.extra.length === 0
        && auditAddedE145.extra.length === 1
        && auditAddedE145.extra[0].id === 'q' && auditAddedE145.missing.length === 0,
      `删一条（\`${victimE145.file}:${victimE145.id}\`）⇒ missing ${auditShrunkE145.missing.length} 条＝`
        + (auditShrunkE145.missing.map(r => `${r.file}:${r.id}`).join('、') || '无')
        + `、extra ${auditShrunkE145.extra.length} 条（应 0）；`
        + `再加一条（\`tests\\._verify\\t16-e141\\zz-e145-synth.js:q\`）⇒ extra ${auditAddedE145.extra.length} 条＝`
        + (auditAddedE145.extra.map(r => `${r.file}:${r.id}`).join('、') || '无')
        + `、missing ${auditAddedE145.missing.length} 条（应 0）`);
  }
  /* `E130` 的 D22（**内存合成样本**，不落地）：同一判据喂"裸递归删"样本 ⇒ 必红并指名 `文件:行号`；
     喂"已改走 `removeLinkSafe(`"样本 ⇒ 必绿。**两条读数缺一不可**（否则只是"恒红"或"恒绿"）。 */
  const Q2_E103 = String.fromCharCode(39);
  const sampleVerifyBad = 'const p = mkOneShot();\n'
    + 'fs.' + 'rmSync(p, { recursive: ' + 'true, force: true });\n';
  const sampleVerifyGood = 'const p = mkOneShot();\n'
    + 'if (env.' + 'isLink(p)) { env.removeLinkSafe(p, { recursive: ' + 'true, force: true }); }\n';
  const verifyBadHits = scanUnprotectedRm(sampleVerifyBad);
  const verifyGoodHits = scanUnprotectedRm(sampleVerifyGood);
  t.check('E103-B⑦ D22（可证伪，`E130`）：同一判据喂**裸递归删**样本 ⇒ **必红并指名 `id=p`**；' +
    '喂**已改走 `removeLinkSafe(`／带 `isLink(p)` 判别**的样本 ⇒ 必绿（⇒ B⑥ 不是恒真式，也不会把"规范写法"判红）',
    verifyBadHits.length === 1 && verifyBadHits[0].id === 'p' && verifyGoodHits.length === 0,
    `裸递归删样本命中 ${verifyBadHits.length} 处（${verifyBadHits.map(h => `L${h.line}:id=${h.id}`).join('、')}，应 1）；`
      + `规范写法样本命中 ${verifyGoodHits.length} 处（应 0）`);
  /* 更强的 D22（**已登记文件里的新形态也要红**）：把一支**已在清单里**的 `._verify` 文件的**内存副本**
     追加一处**新标识符**的裸递归删 ⇒ 必须红且**只**指名那一处新 id（证明清单是"逐条豁免"、
     不是"这个文件被整体放行"）。盘上文件全程只读。 */
  {
    const residFile = path.join(env.paths.root, 'tests', '._verify', 'e46', 'probe-raw2.js');
    const residBytes = fs.existsSync(residFile) ? fs.readFileSync(residFile) : null;
    const mutatedResid = residBytes === null ? null
      : residBytes.toString('utf8') + '\nconst zzFreshE130 = mkOneShot();\nfs.'
        + 'rmSync(zzFreshE130, { recursive: ' + 'true, force: true });\n';
    const curResidHits = residBytes === null ? [] : scanUnprotectedRm(residBytes.toString('utf8'));
    const mutResidHits = mutatedResid === null ? [] : scanUnprotectedRm(mutatedResid);
    const newOnly = mutResidHits.filter(h => h.id === 'zzFreshE130');
    const diskSameResid = residBytes !== null && Buffer.compare(residBytes, fs.readFileSync(residFile)) === 0;
    t.check('E103-B⑧ D22（可证伪，`E130` 的**清单不是整体豁免**）：在**已登记文件** `tests\\._verify\\e46\\probe-raw2.js` 的' +
      '**内存副本**末尾追加一处**新标识符**的裸递归删 ⇒ 判据必红并**只**指名那一处新 id（模板见断言明细）；盘上文件逐字节未变',
      residBytes !== null && mutatedResid !== null && newOnly.length === 1
        && mutResidHits.length === curResidHits.length + 1 && diskSameResid,
      residBytes === null ? '（`tests\\._verify\\e46\\probe-raw2.js` 不存在 ⇒ 本 D22 未执行；清单里的该文件条目会在 B⑥ 明细里报"已消失"）'
        : `原件命中 ${curResidHits.length} 处（${curResidHits.map(h => h.id).join('、')}）⇒ 内存追加 \`zzFreshE130\` 后 `
          + `${mutResidHits.length} 处、新增命中 ${newOnly.length} 处（应 1，id=${newOnly.map(h => h.id).join('、') || '无'}，`
          + `行号=${newOnly.map(h => h.line).join('、') || '无'}）；盘上文件逐字节未变=${diskSameResid}`);
  }

  /* ==================== 甲-D：安全闸（先于一切链接/删除实验） ==================== */
  const e103Room = path.join(env.paths.tempRoot, 'e103-link');
  const e103VictimA = path.join(e103Room, 'victim-a');
  const e103VictimB = path.join(e103Room, 'victim-b');
  const e103LinkA = path.join(e103Room, 'zz-e103-link-a');
  const e103LinkB = path.join(e103Room, 'zz-e103-link-b');
  const e103Tag = `${process.pid}-${crypto.randomBytes(2).toString('hex')}`;
  const e103SweepVictim = path.join(env.paths.tempRoot, `e103-sweep-victim-${e103Tag}`);
  const e103SweepVictim2 = path.join(env.paths.tempRoot, `e103-sweep-victim2-${e103Tag}`);
  const e103StaleLink = path.join(env.paths.tempRootBase, `zz-e103-stale-${e103Tag}`);
  const e103FreshLink = path.join(env.paths.tempRootBase, `zz-e103-fresh-${e103Tag}`);
  const e103FreshDir = path.join(env.paths.tempRootBase, `zz-e103-keep-${e103Tag}`);
  const e103OldDir = path.join(env.paths.tempRootBase, `zz-e103-old-${e103Tag}`);
  const e103Paths = [e103Room, e103VictimA, e103VictimB, e103LinkA, e103LinkB, e103SweepVictim,
    e103SweepVictim2, e103StaleLink, e103FreshLink, e103FreshDir, e103OldDir];
  /** 安全闸判据（纯函数）：路径**自身**是否落在 `tests\._verify\` 之外（`..` 开头／绝对路径）。 */
  const outsideVerifyE103 = (p) => {
    const rel = path.relative(env.paths.verify, path.resolve(p));
    return rel.startsWith('..') || path.isAbsolute(rel);
  };
  const gateOk = e103Paths.every(p => !outsideVerifyE103(p));
  const gateControl = outsideVerifyE103(path.join(env.paths.root, 'src'));   /* 反例：仓内真实目录必须判"越界" */
  const RUN_E103 = gateOk && gateControl;                                   /* 闸不开 ⇒ 一个字节都不动 */
  t.check('E103-D 安全闸：全部实验路径都在 `tests\\._verify\\` 内（`path.relative(env.paths.verify, p)` 不以 `..` 开头）—— 且**反例**（仓内真实目录 `src\\`）必须被判"越界"（否则判据恒真）',
    RUN_E103,
    `实验路径 ${e103Paths.length} 条全部在 \`._verify\\\` 内=${gateOk}；`
      + `反例 \`src\\\` 被判越界=${gateControl}（应 true）；`
      + `越界项=${e103Paths.filter(outsideVerifyE103).map(p => relOfE103(p)).join('、') || '无'}`);

  /* ---------------- 一次性 victim（5 文件，逐个留 sha256 读数） ---------------- */
  const mkVictimE103 = (dir, n) => {
    fs.mkdirSync(dir, { recursive: true });
    const files = {};
    for (let i = 1; i <= n; i++) {
      const p = path.join(dir, `v${i}.bin`);
      fs.writeFileSync(p, `e103-victim-${i}-` + 'x'.repeat(i * 7) + '\n', 'utf8');
      files[`v${i}.bin`] = sha256(fs.readFileSync(p));
    }
    return files;
  };
  const shaOfDirE103 = (dir) => {
    const out = {};
    for (const n of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, n);
      const st = fs.lstatSync(p);
      out[n] = st.isFile() ? sha256(fs.readFileSync(p)) : (st.isSymbolicLink() ? ':link' : ':dir');
    }
    return out;
  };
  /** 判据（纯函数，C① 与 C③ 共用同一份 —— D22 的"必红"才与"必绿"同源）：
   *  返回违规清单（空＝合规）。 */
  const linkRemovalViolations = (res, before, after, gone) => {
    const bad = [];
    if (!res) return ['调用没返回（判不了就判红）'];
    if (res.error) return [`调用抛错：${res.error}`];
    if (res.kind !== 'link') bad.push(`kind='${res.kind}'（应为 'link' —— 判别来源不是 lstat 时这里必然变红）`);
    if (res.via !== 'rmdirSync' && res.via !== 'unlinkSync') bad.push(`via='${res.via}'（应为 rmdirSync／unlinkSync ＝**非递归**拆链）`);
    if (!gone) bad.push('链接仍在（没拆掉）');
    const names = Object.keys(before || {});
    if (names.length !== 5) bad.push(`victim 文件数=${names.length}（应 5）`);
    for (const n of names) {
      if (!after || after[n] !== before[n]) {
        bad.push(`victim ${n} 的 sha256 变了或丢了（${String(before[n]).slice(0, 8)}… → ${String(after && after[n]).slice(0, 8)}…）`);
      }
    }
    return bad;
  };

  /* ==================== 甲-C：行为探针 ＋ D22 ==================== */
  if (RUN_E103) { env.ensureDir(e103Room); }
  const cBeforeA = RUN_E103 ? mkVictimE103(e103VictimA, 5) : {};
  if (RUN_E103) { fs.symlinkSync(e103VictimA, e103LinkA, 'junction'); }
  const cIsLinkJunction = RUN_E103 ? env.isLink(e103LinkA) : null;
  const cIsLinkRealDir = RUN_E103 ? env.isLink(e103VictimA) : null;
  let cResA = null;
  if (RUN_E103) { try { cResA = env.removeLinkSafe(e103LinkA, { recursive: true, force: true }); } catch (err) { cResA = { error: String((err && err.message) || err) }; } }
  const cAfterA = RUN_E103 ? shaOfDirE103(e103VictimA) : {};
  const cLinkAGone = RUN_E103 ? !fs.existsSync(e103LinkA) : false;
  const cBadA = RUN_E103 ? linkRemovalViolations(cResA, cBeforeA, cAfterA, cLinkAGone) : ['（安全闸未通过 ⇒ 未执行）'];
  t.check('E103-C① 行为：`env.removeLinkSafe(<junction>, {recursive:true})` ⇒ `kind===\'link\'`、`via ∈ {rmdirSync,unlinkSync}`、链接消失、**victim 5/5 逐文件 sha256 守恒**（同一条判据 C③ 也用）',
    cBadA.length === 0,
    cBadA.length
      ? `判红：${cBadA.join('；')}（返回=${JSON.stringify(cResA)}）`
      : `kind=${cResA.kind}／via=${cResA.via}；victim 5/5 sha256 逐字节相同（${Object.keys(cAfterA).length} 个文件）；链接已消失=true`);
  t.check('E103-C② 判据来源（`E46` ② 的形状读数）：`isLink(<junction>)===true` 且 `isLink(<真实目录>)===false` —— 判别用 `lstatSync`，**不跟随**',
    RUN_E103 && cIsLinkJunction === true && cIsLinkRealDir === false,
    `isLink(junction)=${cIsLinkJunction}（应 true）／isLink(真实目录)=${cIsLinkRealDir}（应 false）`);

  /* D22：把辅助里的 `fs.lstatSync(` 全换成 `fs.statSync(`（**内存字节副本**，盘上不落一个字节） */
  const envFileE103 = path.join(env.paths.tests, 'env.js');
  const envBytes0 = fs.readFileSync(envFileE103);
  const envSha0 = sha256(envBytes0);
  const envText0 = envBytes0.toString('utf8');
  const lstatCount = (envText0.match(/fs\.lstatSync\(/g) || []).length;
  const mutantEnvBytes = Buffer.from(envText0.split('fs.lstatSync(').join('fs.statSync('), 'utf8');
  /** 由**内存字节副本**载入一个 `env.js` 变异体（`Module._compile`：不落地、不碰仓库）。 */
  const loadEnvVariantE103 = (bytes) => {
    const m = new Module(envFileE103, null);
    m.filename = envFileE103;
    m.paths = Module._nodeModulePaths(path.dirname(envFileE103));
    m._compile(bytes.toString('utf8'), envFileE103);
    return m.exports;
  };
  let cResB = null;
  let cBadB = null;
  let cAfterB = null;
  if (RUN_E103) {
    const cBeforeB = mkVictimE103(e103VictimB, 5);
    fs.symlinkSync(e103VictimB, e103LinkB, 'junction');
    const mutantEnv = loadEnvVariantE103(mutantEnvBytes);
    try { cResB = mutantEnv.removeLinkSafe(e103LinkB, { recursive: true, force: true }); } catch (err) { cResB = { error: String((err && err.message) || err) }; }
    cAfterB = shaOfDirE103(e103VictimB);
    cBadB = linkRemovalViolations(cResB, cBeforeB, cAfterB, !fs.existsSync(e103LinkB));   /* ← 同一份判据 */
    try { env.removeLinkSafe(e103LinkB, { recursive: true, force: true }); } catch { /* 收尾：不许留残留 */ }
  }
  const envBytes1 = fs.readFileSync(envFileE103);
  t.check('E103-C③ D22（可证伪）：把辅助里的 `fs.lstatSync(` **全部**换成 `fs.statSync(`（`Module._compile` 的**内存字节副本**，盘上文件全程只读）⇒ 同一判据**必红并指名**（`kind` 不再是 `link`）；且 `tests\\env.js` 盘上字节**逐字节未变**',
    RUN_E103 && Array.isArray(cBadB) && cBadB.length > 0
      && cResB && cResB.kind !== 'link'
      && Buffer.compare(envBytes0, envBytes1) === 0 && sha256(envBytes1) === envSha0,
    `变异体：替换 ${lstatCount} 处 fs.lstatSync→fs.statSync、变异体 sha256=${sha256(mutantEnvBytes).slice(0, 12)}…（原件 ${envSha0.slice(0, 12)}…）；`
      + `变异体读数 kind=${cResB && cResB.kind}／via=${cResB && cResB.via} ⇒ 判据指名：${Array.isArray(cBadB) ? cBadB.join('；') : '（未执行）'}；`
      + `victim-b 5/5 仍在=${cAfterB ? Object.keys(cAfterB).length === 5 : '（未执行）'}；`
      + `盘上 tests\\env.js 逐字节未变=${Buffer.compare(envBytes0, envBytes1) === 0}`);

  /* ==================== 甲-E：清扫回归（`E101` 落地后的行为面） ==================== */
  const oldStamp = new Date(Date.now() - 25 * 3600 * 1000);
  const eBefore1 = RUN_E103 ? mkVictimE103(e103SweepVictim, 5) : {};
  const eBefore2 = RUN_E103 ? mkVictimE103(e103SweepVictim2, 5) : {};
  if (RUN_E103) {
    fs.utimesSync(e103SweepVictim, oldStamp, oldStamp);            /* 目标"年龄"回拨 >24h（旧版 statSync 会顺链取到它） */
    fs.symlinkSync(e103SweepVictim, e103StaleLink, 'junction');
    fs.symlinkSync(e103SweepVictim2, e103FreshLink, 'junction');   /* 新鲜链接（目标 mtime＝现在） */
    fs.mkdirSync(e103FreshDir, { recursive: true });
    fs.writeFileSync(path.join(e103FreshDir, 'f.txt'), 'keep', 'utf8');
    fs.utimesSync(e103FreshDir, new Date(), new Date());
    fs.mkdirSync(e103OldDir, { recursive: true });
    fs.writeFileSync(path.join(e103OldDir, 'f.txt'), 'sweep', 'utf8');
    fs.utimesSync(e103OldDir, oldStamp, oldStamp);
  }
  const eSweep = RUN_E103 ? env.cleanupStaleTemp() : null;
  const eAfter1 = RUN_E103 ? shaOfDirE103(e103SweepVictim) : {};
  const eAfter2 = RUN_E103 ? shaOfDirE103(e103SweepVictim2) : {};
  const eStaleLinkGone = RUN_E103 ? !fs.existsSync(e103StaleLink) : false;
  const eFreshLinkGone = RUN_E103 ? !fs.existsSync(e103FreshLink) : false;
  const eVictim1Kept = RUN_E103 && Object.keys(eAfter1).length === 5
    && Object.keys(eBefore1).every(n => eAfter1[n] === eBefore1[n]);
  const eVictim2Kept = RUN_E103 && Object.keys(eAfter2).length === 5
    && Object.keys(eBefore2).every(n => eAfter2[n] === eBefore2[n]);
  t.check('E103-E① 清扫回归（**过期**链接）：`tempRootBase` 下 `zz-e103-stale-* -> victim`（victim mtime 回拨 >24 h）⇒ `env.cleanupStaleTemp()` 后**链接消失**、且 victim **5/5 逐文件 sha256 守恒**（旧形态会顺着链接进目标目录 —— 那时这里就不是"只拆链"了）',
    RUN_E103 && eStaleLinkGone && eVictim1Kept,
    `链接已消失=${eStaleLinkGone}；victim 文件=${Object.keys(eAfter1).length}（应 5）、逐文件 sha256 守恒=${eVictim1Kept}；`
      + `清扫返回=${JSON.stringify(eSweep)}`);
  t.check('E103-E② 两端读数（**真实目录**）：**新鲜**真实目录**不被回收**、**过期**真实目录**被回收** —— 这一条把"清扫还在正常工作"钉住（否则 E① 可能只是"清扫坏了、什么都不删"的假绿）',
    RUN_E103 && fs.existsSync(e103FreshDir) && !fs.existsSync(e103OldDir),
    `新鲜目录仍在=${RUN_E103 && fs.existsSync(e103FreshDir)}（应 true）／过期目录仍在=${RUN_E103 && fs.existsSync(e103OldDir)}（应 false）`);
  t.check('E103-E③ **口径更正**（据实断言）：`cleanupStaleTemp()` 对链接是**无条件拆链**（不看年龄）⇒ **新鲜**链接**也**被拆掉，但目标 5/5 一条不少。`E103` 行原写"新鲜链接不被回收"与实现不符，本判据按**实测口径**守（理由见 `tests\\env.js` 的 `E101` 段：链接不是合法的临时产物）',
    RUN_E103 && eFreshLinkGone && eVictim2Kept,
    `新鲜链接已拆=${eFreshLinkGone}（**应 true**：口径＝链接无条件拆链）／其目标 victim2 5/5 守恒=${eVictim2Kept}；`
      + `（E103 行原文"不被回收"按此更正；若将来改成"按年龄回收链接"，这条判据会红，届时同批改文案）`);

  /* ---------------- 收尾：删掉本段自建的一切，并给"残留＝[]"的核对 ---------------- */
  const residue = [];
  if (RUN_E103) {
    for (const p of [e103LinkA, e103LinkB, e103StaleLink, e103FreshLink, e103FreshDir, e103OldDir,
      e103Room, e103SweepVictim, e103SweepVictim2]) {
      try { env.removeLinkSafe(p, { recursive: true, force: true }); } catch { /* 已被清扫收走 */ }
    }
    for (const p of e103Paths) if (fs.existsSync(p)) residue.push(relOfE103(p));
    for (const d of fs.existsSync(env.paths.tempRootBase) ? fs.readdirSync(env.paths.tempRootBase) : []) {
      if (d.includes(e103Tag)) residue.push(`tests\\._verify\\tmp\\${d}`);
    }
  }
  t.check('E103-收尾：本段自建的一次性链接/目录/victim **全部清理干净**（残留＝[]；`tempRootBase` 下带本段标签的条目也必须为空）',
    RUN_E103 && residue.length === 0,
    `残留=${JSON.stringify(residue)}`);

  /* ==================== 丙（`E97`）：探针纪律的调用形态守护 ==================== */
  /** **只剥注释、保留字符串**的剥法（与 `stripLiterals` 的语义**故意不同**）：
   *  因为"用版本控制命令还原变异"在真探针里长在**命令字符串**里（`execSync('…')`／
   *  `spawnSync('git', ['checkout', …])`）；把字符串一起剥掉就等于**看不见病灶**（假绿）。
   *  为什么不直接扫原文：本仓的注释/文案里**大量**出现"不用它还原"这类**否定句**（实测 16 处），
   *  扫原文会被这些说明文字自伤假红 ⇒ 先剥注释，再用**调用形态**（子命令后面必须跟参数）
   *  把"否定句"与"真调用"分开。 */
  const stripCommentsOnlyE103 = (src) => {
    const out = src.split('');
    const n = src.length;
    const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
    let mode = 'code';
    let i = 0;
    while (i < n) {
      const c = src[i], c2 = src[i + 1];
      if (mode === 'code') {
        if (c === '/' && c2 === '/') { blank(i, i + 2); mode = 'line'; i += 2; continue; }
        if (c === '/' && c2 === '*') { blank(i, i + 2); mode = 'block'; i += 2; continue; }
        if (c === "'") { mode = 'sq'; i++; continue; }
        if (c === '"') { mode = 'dq'; i++; continue; }
        if (c === '`') { mode = 'tpl'; i++; continue; }
        i++; continue;
      }
      if (mode === 'line') { blank(i, i + 1); if (c === '\n') mode = 'code'; i++; continue; }
      if (mode === 'block') {
        if (c === '*' && c2 === '/') { blank(i, i + 2); mode = 'code'; i += 2; continue; }
        blank(i, i + 1); i++; continue;
      }
      if (mode === 'sq' || mode === 'dq') {
        const q = mode === 'sq' ? "'" : '"';
        if (c === '\\') { i += 2; continue; }
        if (c === q) { mode = 'code'; i++; continue; }
        if (c === '\n') { mode = 'code'; i++; continue; }          /* 容错：未闭合的字符串止于行尾 */
        i++; continue;
      }
      if (c === '\\') { i += 2; continue; }                        /* tpl：内容保留（宁可多报，不可漏报） */
      if (c === '`') { mode = 'code'; i++; continue; }
      i++; continue;
    }
    return out.join('');
  };
  /** **调用形态**判据（纯函数）：① shell 形态＝子命令后**跟参数**；② 参数数组形态＝子命令是独立引号项、
   *  后面还有引号项。两类的**否定句**（`不用 <命令>`／`<命令>/restore/stash` 连写）都不命中。
   *  ⚠ 判据边界（据实登记）：**裸**子命令（无参数的 `stash`）与"命令与参数都写在两个变量里"不覆盖。 */
  const GIT_RESTORE_PATTERNS_E103 = [
    ['shell 形态（子命令后跟参数）', /\bgit\s+(?:checkout|restore|stash)\b(?=\s+\S)/],
    ['参数数组形态（子命令作独立引号项）', /['"](?:checkout|restore|stash)['"]\s*,\s*['"]/]
  ];
  const scanGitRestore = (source) => {
    const code = stripCommentsOnlyE103(source).split('\n');
    const raw = source.split('\n');
    const out = [];
    code.forEach((l, i) => {
      for (const [name, re] of GIT_RESTORE_PATTERNS_E103) {
        if (re.test(l)) out.push({ line: i + 1, pat: name, text: String(raw[i] || '').trim().slice(0, 100) });
      }
    });
    return out;
  };
  const gitHitsE103 = (list) => list.flatMap((f) => scanGitRestore(readOrEmpty(f)).map(h => ({ file: relOfE103(f), ...h })));
  const gitManaged = gitHitsE103(managedJsE103);
  const gitVerify = gitHitsE103(verifyJsE103);
  /** `._verify\` 下的**已登记**命中（逐条判定；按 `文件＋形态` 登记）：两条是"把 `E97` 台账原文
   *  写进文档"的**记录脚本**（原文里转述了旧探针的还原手法 ⇒ 只是**引用**，不是**调用**），
   *  一条是 `['mutate','restore','verify']` 这种**与版本控制无关**的模式名枚举。 */
  const GIT_RESIDUE_E103 = [
    { file: 'tests\\._verify\\zz-main-20261003-e89-records.js', pat: 'shell 形态（子命令后跟参数）',
      why: '记录脚本：把 `E97` 台账原文（含"旧探针曾用版本控制命令还原、方法不合规"的**转述**）写进路线图与快照 ⇒ 是**引文**，不是调用' },
    { file: 'tests\\._verify\\zz4t32-mutate.js', pat: '参数数组形态（子命令作独立引号项）',
      why: '`[\'mutate\', \'restore\', \'verify\']` —— 探针自己的**模式名枚举**，与版本控制无关（纯词形撞车）' }
  ];
  /* ---------------- 甲-A④／A⑤：**外部工具调用形态**（与丙共用"剥注释、保留字符串"的同一个剥器） ----------------
     为什么单独补这一条：A①② 按要求**剥掉字符串**，于是 `spawnSync('robocopy', [link, '/MIR'])` 这类
     **命令字符串形态**在 A①② 里**看不见** —— 而 `E46` 实测**真毁伤**（目标 5 → 0）的正是这个形态。
     这里用两条**窄**判据补上（窄＝不被说明文字自伤）：① 引号包住的工具名**作实参**（后跟逗号）；
     ② 字符串里出现 rmdir／rd 的 /s 开关。窄判据的代价是"两个变量拼出来的命令"覆盖不到 —— 已登记。
     ⚠ 扫描面＝**受管面**（零容忍）；`._verify\` 面**不在本条的扫描面内**（`E130` 立案前那里**一处都不守**；
      现已由 **A⑥** 按"已登记残留 ＋ 新增即红"补上 —— 见下方 A⑥ 的抬头注释）。本条的边界仍是"受管面"。
      ⚠ **口径提醒（`C·22` 靶子① 的实测，照抄在 A⑥ 的 info 行里）**：`._verify\` 面的"**原始命中行** 18"
      与"已登记 **13** 条"**不是同一把尺子** —— 前者数**行**、后者数 `(文件,形态)` **去重后的登记条目**；
      18 − 13 ＝ 5 行全是**同一批文件里的重复行**（同一 `(文件,形态)` 命中多行），
      **不是"有 5 条没登记"**（本座位与座位 5 都第一遍这么读过）。**判据读的是"命中 ⊆ 清单"，不读这两个数**。 */
  {
    /* 旧注释里的"18"是**历史普查读数**，会随探针生灭而变 —— 故只留一句口径说明、不写死数字：
       实测方法＝`scanToolCalls()` 跑 `._verify\` 面得到的**行数** vs `TOOL_RESIDUE_VERIFY_E103.length`。 */
  }
  const TOOL_CALL_PATTERNS_E103 = [
    ['引号包住的工具名作实参', /['"](?:robocopy)['"]\s*,/],
    ['字符串里的 rmdir／rd 的 /s 开关', /['"][^'"]*\b(?:rmdir|rd)\s+\/s\b[^'"]*['"]/]
  ];
  const scanToolCalls = (source) => {
    const code = stripCommentsOnlyE103(source).split('\n');
    const raw = source.split('\n');
    const out = [];
    code.forEach((l, i) => {
      for (const [name, re] of TOOL_CALL_PATTERNS_E103) {
        if (re.test(l)) out.push({ line: i + 1, pat: name, text: String(raw[i] || '').trim().slice(0, 100) });
      }
    });
    return out;
  };
  const toolCallManaged = managedJsE103.flatMap((f) => scanToolCalls(readOrEmpty(f)).map(h => ({ file: relOfE103(f), ...h })));
  t.check('E103-A④ 外部工具调用形态（**受管面零容忍**）：剥注释、**保留字符串**后，没有"引号包住的工具名作实参"与"字符串里的 rmdir／rd 的 /s 开关"（`E46` 实测会毁伤的两类形态；`._verify\\` 面由 **A⑥** 另判，口径见该段注释）',
    toolCallManaged.length === 0,
    toolCallManaged.length
      ? `判红：命中 ${toolCallManaged.length} 处 —— ` + toolCallManaged.map(h => `${h.file}:${h.line} [${h.pat}]`).join('；')
      : `零命中（扫 ${managedJsE103.length} 个受管 .js；剥注释、保留字符串 ⇒ **命令字符串形态看得见**，`
        + `这是 A①② 剥字符串时看不到的那一类）`);
  const sampleToolBad = 'const r = spawnSync(' + Q_E103 + 'robocopy' + Q_E103 + ', [empty, link]);\n'
    + 'execSync(' + Q_E103 + 'cmd /c rmdir ' + '/s /q ' + Q_E103 + ' + link);\n';
  const sampleToolGood = '// 说明：本仓禁用 robocopy 的镜像模式（本行是注释，不构成调用）\n'
    + 'const note = ' + Q_E103 + '禁用 robocopy 的镜像模式' + Q_E103 + ';\n';
  const toolBadHits = scanToolCalls(sampleToolBad);
  const toolGoodHits = scanToolCalls(sampleToolGood);
  t.check('E103-A⑤ D22（可证伪）：同一判据喂**合成样本** ⇒ 引号工具名作实参 与 字符串里的 /s 开关 **必红且两类各一**；而"注释里的同名词"与"只提工具名的说明字符串"**必绿**（⇒ 判据不是恒真式、也不自伤）',
    toolBadHits.length === 2
      && toolBadHits.some(h => h.pat === TOOL_CALL_PATTERNS_E103[0][0])
      && toolBadHits.some(h => h.pat === TOOL_CALL_PATTERNS_E103[1][0])
      && toolGoodHits.length === 0,
    `坏样本命中 ${toolBadHits.length} 处（${toolBadHits.map(h => `L${h.line}:${h.pat}`).join('、')}，应 2 且两类各 1）；`
      + `好样本命中 ${toolGoodHits.length} 处（应 0：注释被剥、说明字符串不构成调用形态）`);

  /* ==================== 甲-A⑥：`tests\._verify\**` 面的**外部工具调用形态**守护（`E130`，2026-10-04） ====================
     **为什么这一条也要补**：`E46` 实测**真毁伤**的形态有两个，而 A④ 只守了受管面 ——
      ① `robocopy <空目录> <junction> /MIR` ⇒ 目标 **3 文件 → 0**（`E46` 的 X4／X7，受控复现）；
      ② `cmd /c rmdir /s /q <link>`。
     这两类形态**恰恰出现在探针里**（`._verify\e46\probe-external*.js`／`probe-twoside.js` 就是证据），
     而探针的家就是 `._verify\`。⇒ 与 B⑥ 同口径：**已登记残留 ＋ 新增即红**（按 `文件＋形态` 登记，不含行号）。
     **为什么存量里有一批"根本不是调用"**：A④／A⑥ 的剥法是"**剥注释、保留字符串**"（否则看不见
     `spawnSync('robocopy', …)` 这种**命令字符串**形态 —— 那正是 `E46` 毁伤的那一类）。代价是
     "把工具名当**靶子字符串**写在数组里的判据脚本"（`E103` 自己的形态样本表、`C·21` 的普查脚本）
     一并命中 ⇒ 逐条登记并注明是**词形撞车**，与 `丙②` 对 `['mutate','restore','verify']` 的处理同款。
     ⚠ 边界（据实登记）：两个变量拼出来的命令、以及"工具名不带引号"（`spawnSync(cmd, …)`）覆盖不到 ——
     与 A④ 的窄口径**逐字相同**，不在这里偷偷放宽或收紧。 */
  const VERIFY_TOOL_KIND_WHY_E103 = {
    /* ⚠ 拼接构造（**实测踩过两次**）：把 `rmdir` 与 `/s` 开关**逐字**写在一个字符串里，本文件自己
       （受管面）就会先命中 A④ 的"字符串里的 /s 开关" ⇒ 判据自伤假红。故这里只拼接、不抄写。 */
    real: '`E46` 取证探针：**故意**真调 robocopy 的**镜像开关**（本处**故意不逐字写出该开关** —— '
      + '逐字写出来，本文件自己（受管面）就会先命中 `E161` 的外调形态判据 —— `E103-A④` 的'
      + '「判据自伤」实测踩过两次）／ `' + ('rmdir' + ' /' + 's')
      + '` 实测"会穿链毁伤"（受控复现，目标 5 → 0）——它们是 `E103` 立案的实物，也是"为什么必须有这道闸"的证据',
    artifact: '**词形撞车**（不是调用）：`E103` 自己的**形态样本表**（`e103-block.js`／`e103-A-stringface.js`／`e103-census*.js`）与 `C·21` 的普查脚本把"被禁工具名"与"`/s` 开关"当作**靶子字符串**写在数组里（形态样本必须逐字写出来才测得了判据）—— "保留字符串"的口径下它们必然命中。⚠ **本处故意不复述那两个字符串**：一复述，本节自己（受管面）就会先命中 A④（**实测踩过**，见 `T-20261004-14` 回执），所以这里只描述、不抄写'
  };
  /** `._verify\` 面**普查所得**的外部工具调用形态存量（`T-20261004-14` 甲组）。按 `文件＋形态` 登记。 */
  const TOOL_RESIDUE_VERIFY_E103 = [
    { file: 'tests\\._verify\\e46\\probe-external.js', pat: '引号包住的工具名作实参', kind: 'real' },
    { file: 'tests\\._verify\\e46\\probe-external2.js', pat: '引号包住的工具名作实参', kind: 'real' },
    { file: 'tests\\._verify\\e46\\probe-twoside.js', pat: '引号包住的工具名作实参', kind: 'real' },
    { file: 'tests\\._verify\\review\\e103-A-stringface.js', pat: '引号包住的工具名作实参', kind: 'artifact' },
    { file: 'tests\\._verify\\review\\e103-A-stringface.js', pat: '字符串里的 rmdir／rd 的 /s 开关', kind: 'artifact' },
    { file: 'tests\\._verify\\review\\e103-block.js', pat: '引号包住的工具名作实参', kind: 'artifact' },
    { file: 'tests\\._verify\\review\\e103-block.js', pat: '字符串里的 rmdir／rd 的 /s 开关', kind: 'artifact' },
    { file: 'tests\\._verify\\review\\e103-census.js', pat: '引号包住的工具名作实参', kind: 'artifact' },
    { file: 'tests\\._verify\\review\\e103-census.js', pat: '字符串里的 rmdir／rd 的 /s 开关', kind: 'artifact' },
    { file: 'tests\\._verify\\review\\e103-census2.js', pat: '引号包住的工具名作实参', kind: 'artifact' },
    { file: 'tests\\._verify\\review\\e103-census2.js', pat: '字符串里的 rmdir／rd 的 /s 开关', kind: 'artifact' },
    { file: 'tests\\._verify\\review\\s5t21-e103.js', pat: '引号包住的工具名作实参', kind: 'artifact' },
    { file: 'tests\\._verify\\review\\s5t21-e103.js', pat: '字符串里的 rmdir／rd 的 /s 开关', kind: 'artifact' }
  ];
  const toolCallVerify = verifyJsE103.flatMap((f) => scanToolCalls(readOrEmpty(f)).map(h => ({ file: relOfE103(f), ...h })));
  const toolNewVerify = toolCallVerify.filter(h => !TOOL_RESIDUE_VERIFY_E103.some(r => r.file === h.file && r.pat === h.pat));
  const toolStaleVerify = TOOL_RESIDUE_VERIFY_E103.filter(r => !toolCallVerify.some(h => h.file === r.file && h.pat === r.pat));
  t.check('E103-A⑥ 外部工具调用形态（**`tests\\._verify\\**` 面，`E130`**）：剥注释、**保留字符串**后，`._verify\\` 面里的' +
    '"引号包住的工具名作实参"与"字符串里的 rmdir／rd 的 /s 开关"**只剩已登记残留**（清单外的任何一处 ⇒ 红并**指名 `文件:行号`**）',
    toolNewVerify.length === 0,
    toolNewVerify.length
      ? `判红：**新增 ${toolNewVerify.length} 处** —— ` + toolNewVerify.map(h => `${h.file}:${h.line} [${h.pat}]`).join('；')
        + `；已登记存量 ${TOOL_RESIDUE_VERIFY_E103.length} 条`
      : `零新增（\`._verify\\\` 面共 ${toolCallVerify.length} 处命中，全部 ⊆ 已登记存量 ${TOOL_RESIDUE_VERIFY_E103.length} 条＝`
        + `取证实物 ${TOOL_RESIDUE_VERIFY_E103.filter(r => r.kind === 'real').length} 条 ＋ 词形撞车 ${TOOL_RESIDUE_VERIFY_E103.filter(r => r.kind === 'artifact').length} 条；`
        + `清单里已消失的条目 ${toolStaleVerify.length} 条＝` + (toolStaleVerify.map(r => `${r.file}[${r.pat}]`).join('、') || '无')
        + ` ⇒ 谁把探针里的真调用删掉/改掉都会在这里显形（**不判红**））`);
  t.check('E103-A⑥-口径自证（`E130`）：该清单每一条都带 `kind`，且 `real`（取证实物）与 `artifact`（词形撞车）两类**各自有非零条数** —— ' +
    '"存量里有多少是真调用、多少只是靶子字符串"必须一眼可读，不许混成一堆数字',
    TOOL_RESIDUE_VERIFY_E103.length > 0
      && TOOL_RESIDUE_VERIFY_E103.every(r => typeof VERIFY_TOOL_KIND_WHY_E103[r.kind] === 'string')
      && TOOL_RESIDUE_VERIFY_E103.some(r => r.kind === 'real')
      && TOOL_RESIDUE_VERIFY_E103.some(r => r.kind === 'artifact'),
    `real ${TOOL_RESIDUE_VERIFY_E103.filter(r => r.kind === 'real').length} 条／artifact ${TOOL_RESIDUE_VERIFY_E103.filter(r => r.kind === 'artifact').length} 条；`
      + `real＝${VERIFY_TOOL_KIND_WHY_E103.real.slice(0, 30)}…`);
  t.check('E103-丙① 探针纪律（**受管面零容忍**）：`tests\\*.js` ＋ `tests\\lib\\**` ＋ `tools\\**` 里，严格剥注释后**没有任何**"版本控制命令做还原"的**调用形态**（`git <子命令> <参数>` ／ 参数数组形态）',
    gitManaged.length === 0,
    gitManaged.length
      ? `判红：命中 ${gitManaged.length} 处 —— ` + gitManaged.map(h => `${h.file}:${h.line} [${h.pat}]`).join('；')
      : `零命中（扫 ${managedJsE103.length} 个受管 .js；剥注释、**保留字符串** ⇒ 命令字符串里的病兆看得见；`
        + `注释与"否定句"文案不参与判定）`);
  t.check('E103-丙② `tests\\._verify\\**`（含被 gitignore 的）命中**只剩已登记的引文/词形撞车**（清单外的任何一处 ⇒ 红并指名 `文件:行号`）',
    gitVerify.every(h => GIT_RESIDUE_E103.some(r => r.file === h.file && r.pat === h.pat)),
    gitVerify.length
      ? `实存 ${gitVerify.length} 处：` + gitVerify.map(h => `${h.file}:${h.line} [${h.pat}]`).join('；')
        + `；已登记 ${GIT_RESIDUE_E103.length} 条（` + GIT_RESIDUE_E103.map(r => `${r.file}——${r.why}`).join('；') + '）'
      : `._verify\\ 下零命中（扫 ${verifyJsE103.length} 个 .js）`);
  const SP_E103 = String.fromCharCode(32);
  const gitSampleBad = 'execSync(' + "'" + 'git' + SP_E103 + 'checkout' + SP_E103 + '--' + SP_E103 + 'server/db/maintain.js' + "');\n"
    + 'spawnSync(' + "'git', ['" + 'checkout' + "', '--', file]);\n";
  const gitSampleGood = '// 还原纪律：一律字节副本 ＋ Buffer.compare ＋ SHA-256，不用 ' + 'git' + SP_E103 + 'checkout' + SP_E103 + '／restore／stash；\n'
    + 'const note = ' + "'全程不用 " + 'git' + SP_E103 + 'checkout/restore/stash' + "';\n";
  const gitBadHits = scanGitRestore(gitSampleBad);
  const gitGoodHits = scanGitRestore(gitSampleGood);
  t.check('E103-丙③ D22（可证伪）：同一判据喂**合成样本** ⇒ `execSync` 里的 shell 形态与 `spawnSync` 里的数组形态**必红并逐类指名**；而**注释里的否定句**与**字符串里的否定句**必绿（⇒ 判据不是恒真式、也不自伤）',
    gitBadHits.length === 2
      && gitBadHits.some(h => h.pat === GIT_RESTORE_PATTERNS_E103[0][0])
      && gitBadHits.some(h => h.pat === GIT_RESTORE_PATTERNS_E103[1][0])
      && gitGoodHits.length === 0,
    `坏样本命中 ${gitBadHits.length} 处（${gitBadHits.map(h => `L${h.line}:${h.pat}`).join('、')}，应 2 且两类各 1）；`
      + `好样本命中 ${gitGoodHits.length} 处（应 0：注释被剥、否定句不构成调用形态）`);

  /* ==================== `E160` 的双路复核（**`E103` 那一族自己的读数**） ====================
     `E160` 的交付 2 要求：**`E103` 那一族的判据同时跑"剥离后的视图"与"原样字节"两路**
     （原样路负责覆盖剥离器盲区），并给出**合成读数**（哪一路命中、命中在哪）。
     为什么这里的口径是"**剥离路判红 ＋ 原样路留痕**"而**不是**"两路都判红"：
     原样路看到的**本来就包含字面量内容** —— 本仓 `tests\env.js` 的注释里**逐字**写着被禁形态、
     `E103` 自己的形态样本表也把靶子字符串写在数组里 ⇒ 若原样路也判红，本判据会**自伤假红**
     （`E103-A④` 的"判据自伤"实测踩过两次）。故：
       · **剥离路**＝判据本体（`A①②④⑥／B①⑥` 里已有的那些 check，一个字都没改）；
       · **原样路**＝**第二路**，逐类报数 ＋ 与剥离路之差（＝"盲区里的形状"）**每轮留痕**
         ⇒ 盲区**不再隐形**；差的读数是 `:行号` 级的（本文件 858 行盲区里那几处就在这里显形）。
     ⚠ `dualScanE160()`（顶层，`E160-⑥` 与 `E161` 的 D22 也用它）是**同一个纯函数** —— `E153` 的教训。 */
  {
    const dualForE103 = (abs, pred) => dualScanE160(readOrEmpty(abs), pred);
    /* ⚠ **归一化**：`scanRmViolations` 的返回形态与另两个不同（`{id,count,lines[]}` 而不是 `{line}`）——
       两路复核要求"同一个谓词输出同一种取值对象"（`E153`），故这里把它**适配**成 `{line}`，
       而**不改**判据本体（判据仍用原函数的返回值判红）。 */
    const scanRmAsLinesE103 = (code) => scanRmViolations(code)
      .flatMap(v => v.lines.map(line => ({ line, rule: `裸递归删 id=${v.id}` })));
    const DUAL_RULES_E103 = [
      ['A①② 静态禁入清单（robocopy／readdirSync(recursive)／rmdir 与 rd 的 /s）', scanBanlist],
      ['A④⑥ 外部工具调用形态（引号工具名作实参／字符串里的 /s 开关）', scanToolCalls],
      ['甲-B 裸递归删（fs.rmSync(<标识符>,…recursive:true) 家族）', scanRmAsLinesE103]
    ];
    const dualRowsE103 = [];
    for (const [name, pred] of DUAL_RULES_E103) {
      for (const abs of allJsE103) {
        const d = dualForE103(abs, pred);
        dualRowsE103.push({
          rule: name, file: relOfE103(abs),
          stripped: d.stripped.length, raw: d.raw.length, onlyRaw: d.onlyRaw.length,
          onlyRawLines: d.onlyRaw.slice(0, 8).map(h => h.line)
        });
      }
    }
    const sumOf = (k) => dualRowsE103.reduce((a, r) => a + r[k], 0);
    const onlyRawRows = dualRowsE103.filter(r => r.onlyRaw > 0).sort((a, b) => b.onlyRaw - a.onlyRaw);
    t.check('E160-⑦ **`E103` 那一族的双路复核（同一纯函数 `dualScanE160`，合成读数逐类给出）**：'
      + '该族的三类判据（静态禁入清单／外部工具调用形态／裸递归删家族）**同时**跑'
      + '①剥离路（判据本体，判红用）②**原样字节路**（第二路，覆盖剥离器盲区）；'
      + '两路的**总命中数与"只在原样路命中"的条数逐类现算并留痕**，'
      + '且"只在原样路"的那些**必须逐条给 `文件:行号`**（盲区不许隐形）',
      dualRowsE103.length === DUAL_RULES_E103.length * allJsE103.length && sumOf('raw') >= sumOf('stripped'),
      `逐类读数（面＝全部 ${allJsE103.length} 个 .js）：`
        + DUAL_RULES_E103.map(([name]) => {
          const rs = dualRowsE103.filter(r => r.rule === name);
          return `${name} → 剥离路 ${rs.reduce((a, r) => a + r.stripped, 0)} 处／原样路 ${rs.reduce((a, r) => a + r.raw, 0)} 处／`
            + `**只在原样路 ${rs.reduce((a, r) => a + r.onlyRaw, 0)} 处**`;
        }).join('；')
        + `。**只在原样路命中**的文件（前 6）：`
        + (onlyRawRows.slice(0, 6).map(r => `\`${r.file}\`[${r.rule.split(' ')[0]}] ${r.onlyRaw} 处 @ ${r.onlyRawLines.map(n => ':' + n).join('、')}`).join('；') || '无')
        + `（共 ${onlyRawRows.length} 个文件有此类命中 —— 这些就是"剥离路看不见、必须由第二路报告"的形状）`);
    t.info(`\`E160-⑦\` **` + '`E103`' + ` 那一族的双路读数（每轮可见）**：`
      + `原样路命中合计 ${sumOf('raw')} 处、剥离路合计 ${sumOf('stripped')} 处、`
      + `**只在原样路** ${sumOf('onlyRaw')} 处（分布见 ` + '`E160-⑦`' + ` 的详情；本节 ` + '`PASS`' + ` 详情不打印，故此处再给总数）—— `
      + `⚠ 判红一律以**剥离路**为准（原样路会看到注释/字符串里的说明文字与靶子字符串，两路都判红就自伤）；`
      + `原样路的作用是**把盲区里的形状报出来**，不是"多一条判红条件"。`);
  }

  t.info(`E103/E97 扫描面：磁盘上的 ${allJsE103.length} 个 .js（受管 ${managedJsE103.length} ＋ \`._verify\\\` ${verifyJsE103.length}；`
    + `tests\\**\\*.js ＋ tools\\**\\*.js，**不看 git 跟踪状态**）；禁令形态 ${BAN_PATTERNS_E103.length} 类；`
    + `探针纪律形态 ${GIT_RESTORE_PATTERNS_E103.length} 类（剥注释、保留字符串）`);
  /* `E130`（2026-10-04）：把 `._verify\` 面的存量读数**打进日志**（PASS 时不打印 check 的 detail，
     故这里必须有可见证据 —— "守了多少、还剩多少存量"要能一眼读到，不许只在红的时候才看得见）。 */
  t.info(`E103/E130 \`._verify\\\` 面存量（普查 ＋ 清单）：**原样扫描**（不施加任何豁免）命中 ${rmVerify.length} 条 \`(文件,id)\``
    + `（⚠ 口径：这条数的是**"盘上有这个 \`(文件,id)\`"的条数**、**不是**"出现次数"、**不是**"未防护条数"；`
    + `按登记 + \`max\` 判定后的违规 ${rmVerifyRegE144.length} 条。**"出现次数"的现算读数**见上面的 \`E156\` 口径行）`
    + `（已登记 ${RM_RESIDUE_VERIFY_E103.length} 条＝${rmKindCountVerify}；未在册 ${rmNewVerify.length}、在册超限 ${rmOverMaxVerify.length}、已消失 ${rmStaleVerify.length}）；`
    + `外部工具调用形态 **${toolCallVerify.length} 行命中**（已登记 ${TOOL_RESIDUE_VERIFY_E103.length} 条`
    + `＝取证实物 ${TOOL_RESIDUE_VERIFY_E103.filter(r => r.kind === 'real').length} ＋ 词形撞车 ${TOOL_RESIDUE_VERIFY_E103.filter(r => r.kind === 'artifact').length}；`
    + `新增 ${toolNewVerify.length}、已消失 ${toolStaleVerify.length}）`
    /* ⚠ 两个数**口径不同**，必须同屏写清（`C·22` 靶子① 的提醒，本座位与座位 5 都误读过）：
       "行命中"数**行**、"已登记条"数 `(文件,形态)` **去重**后的条目 ⇒ 行数 ≥ 条目数，
       差额＝同一 `(文件,形态)` 的**重复行**，**不是"没登记的条数"**。 */
    + `｜口径：前者是**原始命中行**、后者是 \`(文件,形态)\` **去重后**的登记条目 —— `
    + `差额 ${toolCallVerify.length - TOOL_RESIDUE_VERIFY_E103.length} 行**全是同一 \`(文件,形态)\` 的重复行**，不是"没登记"`);
}

/* 先例写法（同 browser-check.js:828、contract-check.js:1624、docs-check.js:547 …）：
   `main()` 是 **async** ⇒ 它的 rejection **不会**被"顶层 try/catch"接住。**E76① 的记账口径
   （实测，勿沿用旧说法）**：这条路走成"无汇总行 ＋ 退 1" ⇒ `run-all.classify(1, null, out)`
   ⇒ `status='failed'`、`detail='退出码 1'`，与"有断言失败"在 `run-all` 台账上**逐字同形**
   （`unverified` 只对"**退 0** 且无汇总行／通过 0 项"成立）。故必须把 `.catch()` 挂在 promise 上
   接住，并按规范 9.5-5 退 **2**（脚本自身异常），异常**打印出来**（可 grep）。
   打印前缀现状见 `lib/assert.js` 末注：`[脚本异常]` 目前只有 E76 修的这 3 个脚本在用。 */
/* ==========================================================================
   二十七、`E42`／`E43`：ADR-0003 D17 时钟门禁的**真值表** ＋ **扩大覆盖** ＋ **能力边界登记**
   --------------------------------------------------------------------------
   立案（两条技术债，**同一个根因**）：D17 那条门禁（`tests\docs-cross-check.js` 的
   「ADR-0003 D17：业务代码的 `new Date()` 都留有注入出口」）是一条**同行文本启发式**判据 ——
     · **`E42`**（★★）：它曾把"**对象字面量的键冒号**"当成注入出口 ⇒ `{ …, at: new Date() }` 侥幸过闸；
       而 `Date.now()` **完全不在覆盖内**。收紧已落地（该文件里的 `E42 收紧（2026-09-27）` 注释），
       但"**判据本身**有没有被证明过"一直没有机器守据 —— **判据自己没有门禁**。
     · **`E43`**（★★）：收紧之后**仍是启发式**，存在两类**固有**漏网（最容易演成"以为已全覆盖"的
       安全感错位）：① 只认 `new Date()`／`Date.now()` ⇒ `performance.now()`／`process.hrtime()`／
       `setInterval` 周期**完全不在覆盖内**；② **"出口形状"不等于"真注入源"** ⇒
       `retry ? Date.now() : Date.now()` 这种"两侧都是裸时钟"的行**照样过闸**。
   本节的处置**不是**"再写一条更宽的正则把它盖住"（那只会把漏网换成一个新的、更隐蔽的漏网），而是：
     甲、**把判据抽出来、喂真值表** —— 判据本体从 `docs-cross-check.js` 的**真源码字节**里用
         **锚点**切出连续区间、交 `new Function` 编译（**同一把尺子**；`E153` 的教训：判据与 D22
         各写一份，D22 证明的就不是主判据那一件事）。真值表覆盖 `Date.now()` 与**非对象字面量**
         的多类形态 —— 这是 `E42` 要的"**扩大覆盖**"：**不许**把判据放宽成"只认已知写法"。
     乙、**把两类漏网逐类固化成可判形式**（`E43`）：**能判的**新增两条可判的扩大判据
         （`EXT-A` 未受管的时钟来源／`EXT-B` 同行 ≥2 处被管时钟调用）扫**同一面**、**判红并指名**；
         **判不了的**显式登记为"**能力边界**"并**写进断言 `msg` 与下面的 `t.info`** ——
         漏网留在**明处**，不留暗处。
     丙、`D22`（可证伪）：在**真实 `server\index.js` 的内存字节副本**中部植入**真实漏网点** ⇒
         同一判据**必红并指名**；负对照（现行盘上）必绿；盘上逐字节未变。
   ⚠ **面（不许读成"全仓"）**：与 `docs-cross-check.js` **完全同面** ＝ `server\**\*.js` ＋
     `platform\**\*.js`，且 `platform\clock.js`（时间来源本身）豁免。
   ⚠ **中心论断：为什么"启发式判据的漏网必须显式登记为能力边界，而不是靠加正则掩盖"**：
     ① **加正则只能覆盖"我已经想到的写法"**：判据的**真实覆盖**一点没变，变的只是"**看门人以为
        自己覆盖了什么**"（`D19` 的"看起来验过了"）。漏网于是从"看得见的绿"变成"看不见的绿"，
        而**看不见的绿比红更危险** —— 它连一条读数都不产生。
     ② **文本启发式不是数据流证明**：出口**形状**可以匹配，"这个值真的来自注入源"匹配不出来
        （`retry ? Date.now() : Date.now()` 就是反例：形状齐备、来源全是裸时钟）。把这条边界
        **写在断言 `msg` 里**，读回执的人才知道那个"绿"的**确切含义**；靠加正则会把边界一并抹掉。
     ③ **能力边界本身也可以可证伪**：登记成 `EXT-A`／`EXT-B` 之后，它就有了**样本 ＋ 期望 ＋ D22**：
        漏网再扩大时（出现新的时间源形态）本节**会红**，而不是继续"安静地绿"。
     ④ 所以本节对每一类漏网都做**两件事**：能判的**判红并指名**，判不了的**逐条写进 `msg`**；
        **两者都不许省** —— 只做前者＝把边界留给下一个人的记忆，只做后者＝把"判得了"也一起放弃了。
   ========================================================================== */
t.section('二十七、`E42`／`E43`：D17 时钟门禁判据的真值表 ＋ 扩大覆盖 ＋ 能力边界登记');
{
  const ROOT27 = env.paths.root;

  /* ---- 二十七之一：从**真源码字节**抽出 D17 判据（锚点只用 ASCII；命中次数**现算并断言**） ---- */
  const D17_GATE_REL = 'tests/docs-cross-check.js';
  const d17GateSrc = fs.readFileSync(path.join(ROOT27, D17_GATE_REL), 'utf8');
  const aCount27 = (hay, a) => { let n = 0; let i = hay.indexOf(a); while (i >= 0) { n++; i = hay.indexOf(a, i + a.length); } return n; };
  const D17_A0 = '  const stripComments = (src) => {';
  const D17_A1 = '  const clockHits = [];';
  const d17A0n = aCount27(d17GateSrc, D17_A0);
  const d17A1n = aCount27(d17GateSrc, D17_A1);
  const d17I0 = d17GateSrc.indexOf(D17_A0);
  const d17I1 = d17GateSrc.indexOf(D17_A1);
  const d17Region = (d17A0n === 1 && d17A1n === 1 && d17I1 > d17I0) ? d17GateSrc.slice(d17I0, d17I1) : null;
  let D17 = null;
  let d17ExtractErr = '未尝试';
  if (d17Region) {
    try {
      D17 = new Function(d17Region
        + '\nreturn { stripComments, CLOCK_CALL_RE, isTernaryColon, injectableCall };\n')();
    } catch (err) { d17ExtractErr = (err && err.constructor ? err.constructor.name : 'Error') + ': ' + (err && err.message); }
  }
  const d17Usable = !!D17 && typeof D17.stripComments === 'function' && typeof D17.CLOCK_CALL_RE === 'object'
    && typeof D17.isTernaryColon === 'function' && typeof D17.injectableCall === 'function';
  /* `D20`：前提**独立**成一条 —— 抽不出判据就"判不了"，而"判不了"必须**判红**，不得静默放过
     （"抽不到区间"与"判据没问题"在报告上看起来一样，这正是 `E81`／`E82` 踩过的形态）。 */
  t.requires('`E42`/`E43` 的前提：能从 `' + D17_GATE_REL + '` 的**真源码字节**切出 D17 判据并编译'
    + '（两个 ASCII 锚点各**恰 1 次**；抽出的区间含 `stripComments`／`CLOCK_CALL_RE`／`isTernaryColon`／'
    + '`injectableCall` 四件）—— 拿不到区间即**判红**（不许"抽不到就当没问题"）',
    d17Usable, `锚点命中：${D17_A0} → ${d17A0n} 次、${D17_A1} → ${d17A1n} 次；`
    + `抽出区间 ${d17Region ? d17Region.length + ' 字符（盘上行 ' + (d17GateSrc.slice(0, d17I0).split('\n').length) + '–' + (d17GateSrc.slice(0, d17I1).split('\n').length) + '）' : '拿不到'}；`
    + `编译${D17 ? '成功' : '失败（' + d17ExtractErr + '）'}`);

  if (!d17Usable) {
    t.info('⚠ 判据抽不出来 ⇒ 本节其余断言**一条都不跑**（`D20`：前提不成立单列，且上面那条已判红）——'
      + ' 这正是"抽不到"与"没问题"必须分开记账的理由。');
  } else {
    /* ---- 二十七之二：与门禁**完全同一条循环**的判据入口（逐行剥注释 → 逐个被管时钟调用 →
             无注入出口即命中；每行至多报 1 处；行号 1-based；`rel` 用 `path.relative` 原样，
             即 Windows 反斜杠 —— 与 `docs-cross-check.js` 的报名字符串**逐字同形**） ---- */
    const d17Hits = (sources) => {
      const hits = [];
      for (const s of sources) {
        D17.stripComments(s.src).forEach((line, i) => {
          D17.CLOCK_CALL_RE.lastIndex = 0;
          for (let m = D17.CLOCK_CALL_RE.exec(line); m; m = D17.CLOCK_CALL_RE.exec(line)) {
            if (D17.injectableCall(line, m.index, m.index + m[0].length)) continue;
            hits.push(`${s.rel}:${i + 1}（裸 ${m[0]}）`);
            break;
          }
        });
      }
      return hits;
    };
    const stripC27 = src => D17.stripComments(src);
    const countClock27 = (line) => {
      D17.CLOCK_CALL_RE.lastIndex = 0; let n = 0;
      for (let m = D17.CLOCK_CALL_RE.exec(line); m; m = D17.CLOCK_CALL_RE.exec(line)) n++;
      return n;
    };
    const SAMPLE_REL = '（合成样本）';
    const hitsOf27 = src => d17Hits([{ rel: SAMPLE_REL, src }]);
    /* `EXT-A`：**未受管**的时钟来源形态（`E43①` 里"能判"的那一半）。
       逐码位/逐形态写死，不做"看起来像取时间"的宽松匹配。 */
    const EXT_A_RE = new RegExp('(?:performance\\s*\\.\\s*now|process\\s*\\.\\s*hrtime)\\s*\\(', 'g');
    const extAHits = (sources) => {
      const hits = [];
      for (const s of sources) {
        stripC27(s.src).forEach((line, i) => {
          EXT_A_RE.lastIndex = 0;
          const ms = line.match(EXT_A_RE);
          if (ms) hits.push(`${s.rel}:${i + 1}（未受管的时钟来源 ${ms.join('、')}）`);
        });
      }
      return hits;
    };
    /* `EXT-B`：**同一行 ≥2 处被管时钟调用** ⇒ 该行不可能"每一处都有独立注入出口"
       （一个出口只接得住一处调用）—— 这正是 `retry ? Date.now() : Date.now()` 的形态。 */
    const extBHits = (sources) => {
      const hits = [];
      for (const s of sources) {
        stripC27(s.src).forEach((line, i) => {
          const n = countClock27(line);
          if (n >= 2) hits.push(`${s.rel}:${i + 1}（同行 ${n} 处被管时钟调用）`);
        });
      }
      return hits;
    };

    /* ---- 二十七之三：`E42` 真值表（**扩大覆盖**：`Date.now()` ＋ 多类"非对象字面量"/对象字面量形态） ----
       `hit: true` ⇒ 期望**判红**（判据认为"没有注入出口"）。期望来自**设计口径**（`E42`／`E43` 行内 ＋
       ADR-0003 D17 的"允许可注入 ＋ 缺省兜底"），不是"看它怎么跑就怎么写"。 */
    const d17Table = [
      ['① 裸 `new Date()`（D17 的原始形态）', 'const a = new Date();', true,
        '裸取当前时间参与逻辑 ⇒ 必须红'],
      ['② 裸 `Date.now()`（**`E42②`：此前完全不在覆盖内**）', 'const a = Date.now();', true,
        '与 `new Date()` 同等受管'],
      ['③ 对象字面量键冒号 `{ at: new Date() }`（**`E42①` 的盲点形态**）',
        'state.lastError = { at: new Date().toISOString() };', true,
        '键冒号**不是**三元兜底；`server\\index.js` 曾有四处靠它过闸'],
      ['④ 对象字面量键冒号 ＋ `Date.now()`', 'state.tick = { at: Date.now(), n: 1 };', true,
        '两种口径都要认'],
      ['⑤ 展开 ＋ 键冒号', 'const d = { ...x, at: new Date() };', true, '展开不改变键冒号的语义'],
      ['⑥ 单层对象字面量 `{ now: Date.now() }`', 'const o = { now: Date.now() };', true, '同上'],
      ['⑦ **嵌套**对象字面量 `{ a: { b: new Date() } }`', 'const o = { a: { b: new Date() } };', true,
        '最近的一层未配对 `{` 才是判据依据'],
      ['⑧ 缺省兜底 `||`（**真注入出口**）', 'const now = options.now || new Date();', false,
        'D17 允许"可注入 ＋ 缺省兜底"'],
      ['⑨ 形参默认值（**真注入出口**）', 'function f(d = new Date()) { return d; }', false,
        '要求左侧是 `(param =`、右侧紧跟逗号/右括号'],
      ['⑩ 三元兜底（`new Date()`）', 'const x = clock ? clock.now() : new Date();', false, '真三元假分支'],
      ['⑪ 三元兜底（`Date.now()`）', 'const x = clock ? clock.now() : Date.now();', false,
        '`Date.now()` 与 `new Date()` 同等'],
      ['⑫ 空值兜底 `??`', 'const y = options.now ?? new Date();', false,
        '`??` 与 `||` 同义（也是兜底出口）'],
      ['⑬ 行注释里的 `new Date()`', '// 禁止裸 new Date()', false, '注释必须先剥干净'],
      ['⑭ **同行块注释**里的 `new Date()`', '/* x */ const p = 1; /* new Date() */', false,
        '`E42` 补的"同行的成对块注释"也要剥'],
      ['⑮ `setInterval` 周期里的裸 `Date.now()`（真阳）',
        'setInterval(() => tick(Date.now() - started), 1000);', true,
        '**真漏网**：`Date.now()` 被拿来做时长逻辑'],
      ['⑯ 字符串字面量里的 `new Date()`（**过报**）', "const s = 'new Date()';", true,
        '**能力边界（过报）**：判据只剥注释、**不剥字符串/模板串** ⇒ 说明性字面量会被判红'],
      ['⑰ 模板串里的 `new Date()`（**过报**）', 'const s = ' + '`' + 'a ' + '${1}' + ' new Date()' + '`' + ';', true,
        '同上（模板串也不剥）'],
      ['⑱ **`E43②` 的漏网**：`retry ? Date.now() : Date.now()`', 'const t = retry ? Date.now() : Date.now();', false,
        '**固有漏网**：出口形状齐备、但两侧来源全是裸时钟 ⇒ D17 判**绿**（由 `EXT-B` 判红）'],
      ['⑲ **`E43①` 的漏网**：`performance.now()`', 'const t = performance.now();', false,
        '**固有漏网**：D17 的正则根本匹配不到它（由 `EXT-A` 判红）'],
      ['⑳ **`E43①` 的漏网**：`process.hrtime()`', 'const h = process.hrtime();', false,
        '同上（由 `EXT-A` 判红）'],
      ['㉑ **非调用语法**：`const f = new Date; const t = f();`', 'const f = new Date; const t = f();', false,
        '**能力边界**：判据正则要求调用括号 `()` ⇒ 取函数引用再调用、别名、经中间变量间接取时间**一律看不见**']
    ];
    const d17Rows = d17Table.map(([name, src, want]) => {
      const got = hitsOf27(src);
      return { name, src, want, got, ok: (got.length > 0) === want };
    });
    const d17TableBad = d17Rows.filter(r => !r.ok);
    t.check('`E42`-① D17 判据**真值表**（从真源码抽出、**同一把尺子**喂 21 个样本）：'
      + '**裸 `Date.now()`** 与**对象字面量键冒号**（含嵌套/展开）**必红且指名行号**；'
      + '**真注入出口**（`||`／形参默认值／三元假分支／`??`）与**注释里的字样**必绿 —— '
      + '即"**扩大覆盖**"而不是"把判据放宽成只认已知写法"',
      d17TableBad.length === 0,
      (d17TableBad.length ? `**判红：${d17TableBad.length} 例期望与实际不符** —— `
        + d17TableBad.map(r => `${r.name}：期望${r.want ? '红' : '绿'}、实得[${r.got.join('、') || '绿'}]`).join('；') + '；' : '21 例**逐例相符**；')
      + `逐例读数：${d17Rows.map(r => `${r.name.slice(0, 6)}…→${r.got.length ? '红' : '绿'}`).join('／')}`);

    /* ---- 二十七之四：`E42`-② D22（**内存变异**：在真实 `server\index.js` 中部造真实漏网点） ----
       为什么必须打在**真源码**上而不是合成字符串上：合成字符串只能证明"判据对合成样本有效"，
       而 `E42` 的病是"**下一处裸时钟继续静默过闸**" —— 要证明的正是"**真文件里**多出来的那一处
       会被指名"。两支各自对应 `E42` 的一个盲点：㈠对象字面量键冒号形态 ㈡裸 `Date.now()`。 */
    const D22_REL27 = path.join('server', 'index.js');
    const d22Abs27 = path.join(ROOT27, D22_REL27);
    const d22Bytes27 = fs.readFileSync(d22Abs27);                 /* 字节副本（只读） */
    const d22Sha27 = require('node:crypto').createHash('sha256').update(d22Bytes27).digest('hex');
    const d22Lines27 = d22Bytes27.toString('utf8').split('\n');
    /* 植入点必须落在**真代码**上：首版把插入点钉成"第 12 行之前"，而 `server\index.js` 的前 27 行
       是**文件头块注释** ⇒ 植入行被 `stripComments` 正确剥掉、读数 0（D22 当场判红，如实留痕）。
       现改为**锚定真代码行**：`'use strict';` 之后（且要求该行**全文件恰 1 次**）。 */
    const d22Strict27 = "'use strict';";
    /* ⚠ 盘上是 **CRLF** ⇒ `split('\n')` 会留下行尾 `\r`，按**整行相等**找锚点必须先剥 `\r`
       （首版没剥 ⇒ 锚点出现 0 次、插入点退化成第 1 行，D22 当场把自己判红 —— 如实留痕）。 */
    const d22Trim27 = l => (l.endsWith('\r') ? l.slice(0, -1) : l);
    const d22StrictIdx27 = d22Lines27.findIndex(l => d22Trim27(l) === d22Strict27);
    const d22StrictN27 = d22Lines27.filter(l => d22Trim27(l) === d22Strict27).length;
    const d22AnchorOk27 = d22StrictIdx27 >= 0 && d22StrictN27 === 1;
    const d22At27 = d22StrictIdx27 + 1;                            /* 插到 `'use strict';` 的下一行之前 */
    const d22Rel27 = path.relative(ROOT27, d22Abs27);              /* 与门禁同一条路径算法（Windows 反斜杠） */
    const d22Base27 = d17Hits([{ rel: d22Rel27, src: d22Bytes27.toString('utf8') }]);
    const d22Case27 = (insertLine, callText) => {
      const mut = d22Lines27.slice(0, d22At27).concat([insertLine], d22Lines27.slice(d22At27)).join('\n');
      const hits = d17Hits([{ rel: d22Rel27, src: mut }]);
      const expect = `${d22Rel27}:${d22At27 + 1}（裸 ${callText}）`;
      return { hits, expect, ok: hits.length === 1 && hits[0] === expect };
    };
    const d22a27 = d22Case27('  state.lastError = Object.assign({}, state.lastError, { at: new Date().toISOString() });', 'new Date()');
    const d22b27 = d22Case27('  const __e42ProbeAt = Date.now();', 'Date.now()');
    const d22DiskSame27 = require('node:crypto').createHash('sha256').update(fs.readFileSync(d22Abs27)).digest('hex') === d22Sha27;
    t.check('`E42`-② D22（可证伪，**真实漏网点 ＋ 内存字节副本**）：在真实 `server\\index.js` 中部'
      + '分别植入㈠**对象字面量键冒号**形态㈡**裸 `Date.now()`** ⇒ 同一判据**必红**且**指名 `文件:行（裸 …）`**；'
      + '负对照（现行盘上）**必绿**；盘上文件**逐字节未变**',
      d22Base27.length === 0 && d22a27.ok && d22b27.ok && d22DiskSame27 && d22AnchorOk27,
      `植入锚点 \`${d22Strict27}\` 在盘上行 ${d22StrictIdx27 + 1}（出现 ${d22StrictN27} 次，须恰 1 次 ⇒ ${d22AnchorOk27}）；`
      + `负对照（盘上真源码）命中 ${d22Base27.length} 处（应 0）；`
      + `㈠植入点=${d22a27.expect} ⇒ 命中[${d22a27.hits.join('、') || '（无）'}]；`
      + `㈡植入点=${d22b27.expect} ⇒ 命中[${d22b27.hits.join('、') || '（无）'}]；`
      + `盘上 \`${d22Rel27}\` 逐字节未变=${d22DiskSame27}（sha256=${d22Sha27.slice(0, 12)}…）`);

    /* ---- 二十七之五：真树读数（面＝`server\\`＋`platform\\`，`platform\\clock.js` 豁免） ---- */
    const walkJs27 = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walkJs27(full);
      return e.isFile() && e.name.endsWith('.js') ? [full] : [];
    });
    const face27 = [];
    for (const dir of ['server', 'platform']) {
      for (const f of walkJs27(path.join(ROOT27, dir))) {
        const rel = path.relative(ROOT27, f);
        if (rel === path.join('platform', 'clock.js')) continue;      /* 时间来源本身豁免（同门禁） */
        face27.push({ rel, src: fs.readFileSync(f, 'utf8') });
      }
    }
    const faceHits27 = d17Hits(face27);
    const faceExtA27 = extAHits(face27);
    const faceExtB27 = extBHits(face27);

    /* ---- 二十七之六：`E43`-① EXT-A（**能判的那一半**：未受管的时钟来源）＋ **能力边界** ---- */
    const extASamp = extAHits([{ rel: SAMPLE_REL, src: 'const t = performance.now();' },
      { rel: SAMPLE_REL, src: 'const h = process.hrtime();' }]);
    const extASampD17 = hitsOf27('const t = performance.now();').length + hitsOf27('const h = process.hrtime();').length;
    t.check('`E43`-① 扩大覆盖（**能判的判红并指名**）：新增可判判据 `EXT-A` 把 **`performance.now()`／'
      + '`process.hrtime()`** 纳入同一面（`server\\`＋`platform\\`）—— 真树必须 **0 处**；'
      + '合成样本两支**必红且指名 `文件:行`**；**同时**证明原 D17 判据对这两支**判绿**（＝漏网被**指名登记**，'
      + '不是含糊带过）',
      faceExtA27.length === 0 && extASamp.length === 2 && extASampD17 === 0,
      `真树 EXT-A 命中 ${faceExtA27.length} 处（应 0）：[${faceExtA27.join('、') || '（无）'}]；`
      + `合成样本 EXT-A 命中 ${extASamp.length}/2：[${extASamp.join('、')}]；`
      + `**原 D17 判据对这两支命中 ${extASampD17} 处（＝0 才说明"漏网"是真的）**；`
      + `**能力边界（判不了的，如实登记）**：` + '`EXT-A` 也是**文本**判据 —— '
      + '`setInterval`／`setTimeout` **周期本身**、`Date` 的静态取值形态（`Date.parse`／`Date.UTC`）、'
      + '取函数引用再调用（`const f = new Date; f()`）、经**中间变量/参数**间接取得的时间，**一律不在覆盖内**；'
      + 'D17＋EXT 两者**合起来仍不是数据流证明**。');
    t.info('`E43`-① 真树读数（每轮可见）：面＝`server\\`＋`platform\\` 共 ' + face27.length + ' 个 .js'
      + '（豁免 `platform\\clock.js`）；D17 命中 ' + faceHits27.length + ' 处、`EXT-A` 命中 ' + faceExtA27.length + ' 处、'
      + '`EXT-B` 命中 ' + faceExtB27.length + ' 处 —— 三者**同结论**（全 0）才说明这条面是干净的。');

    /* ---- 二十七之七：`E43`-② EXT-B（**能判的那一半**："出口形状 ≠ 真注入源"） ---- */
    const EXT_B_SAMPLE = 'const t = retry ? Date.now() : Date.now();';
    const extBSamp = extBHits([{ rel: SAMPLE_REL, src: EXT_B_SAMPLE }]);
    const extBSampD17 = hitsOf27(EXT_B_SAMPLE);
    t.check('`E43`-② 扩大覆盖（**能判的判红并指名**）：新增可判判据 `EXT-B`＝"**同一行 ≥2 处被管时钟调用**"'
      + '（一个注入出口只接得住一处调用）—— 真树必须 **0 处**；合成样本 `retry ? Date.now() : Date.now()` '
      + '**必红且指名 `文件:行`**；**同时**证明原 D17 判据对该样本**判绿**（`E43②` 的固有漏网由此**固化成可判形式**）',
      faceExtB27.length === 0 && extBSamp.length === 1 && extBSampD17.length === 0,
      `真树 EXT-B 命中 ${faceExtB27.length} 处（应 0）：[${faceExtB27.join('、') || '（无）'}]；`
      + `合成样本 \`${EXT_B_SAMPLE}\` ⇒ EXT-B 命中 [${extBSamp.join('、')}]、**原 D17 判据命中 ${extBSampD17.length} 处**`
      + `（0 ＝ 它确实**过闸**了 —— 这就是要固化的那条漏网）；`
      + `**能力边界（判不了的，如实登记）**：` + '`EXT-B` 只数**被管时钟调用**的**条数**，'
      + '判不了"出口的后备值本身是不是**别的**时间源"（`a || b || new Date()` 里 a/b 若也是时钟，本行数不到）；'
      + '也判不了跨行/跨语句的同一个出口（本行**只做同行**判定）；'
      + '且它是**上界**判据 —— 同行两处合法调用也会被它判红（**宁可过报**，因为"一行两处取时间"本身就可疑）。');
    t.info('`E43` 两类**固有漏网**的登记（**固化成可判形式**，不是含糊带过）：'
      + '① 未受管时钟来源 ⇒ 由 `EXT-A` **判红并指名**（真树 0 处）；能力边界见 `E43`-① 的 msg。'
      + '② 出口形状 ≠ 真注入源 ⇒ 由 `EXT-B` **判红并指名**（真树 0 处）；能力边界见 `E43`-② 的 msg。'
      + '两者都**不是**数据流证明 —— ADR-0003 D17 需要写明的那句边界（"D17 门禁只查 `new Date()`/`Date.now()` '
      + '的同行出口形状，**不是**数据流证明"）**已逐字写进本节两条断言名与 msg**，读回执的人不必再靠记忆。');
  }
}

main().catch(err => {
  console.error('\n[脚本异常] 脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
