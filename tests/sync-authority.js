/* ==========================================================================
   权威区同步器（tests/sync-authority.js）—— 技术债 `E56` 的"写"那半边
   --------------------------------------------------------------------------
   【E56 是什么】`tests\README.md` 第三节是**门禁数字的唯一真源**，但它靠**人手**维护：
   每加/改一条断言，都要人工同步**五份文档**的多个声明点（README 权威区 ＋ 脚本表"中文形式"、
   `项目架构与技术栈.md` 当前值行/和值/§9 逐脚本行、`项目记录\当前状态快照.md` 一屏速览行/预期行、
   `项目记录\后续路线图.md` header）——加一条断言的边际成本 ≈ 改五份文档（2026-09-29 实测）。
   **"判"已经很硬**（`docs-cross-check` 的 `E112`／`E51`／`E136`／`E155` 四族逐处指名抓漂移，
   一次没漏）；**缺的只是"写"** —— 而人工"写"正是本项目连出三次事故的地方
   （吃掉 CRLF 的 `\r`／整份文件被翻成另一种行尾／正则 `$1` 字面写进文件）。本脚本补"写"。

   【两种模式】
     · `--check`（默认，只读）：把**每个声明点**与**真源**逐一比对；
       **零漂移 ⇒ 退 0**；任何一处不符 ⇒ **退 1 并逐处指名 `文件:行号 ＋ 声明值 ≠ 真源值`**
       （口径与 `docs-cross-check` 一致，便于互证）。
     · `--apply`（写）：把声明点改成真源值。**硬要求**（逐条对应任务包的 1～4）：
         ① **按行切片 → 只改目标数字 → 按该文件原有行尾写回**：实现上不是"按行重写文件"，
            而是**在整个文件文本里只替换那几个数字字符的区间**（`before.slice` 拼接），
            因此行尾/BOM/末行尾/其余行**逐字节不可能被翻转**；改完打印每文件的
            `CRLF/裸LF/裸CR/BOM/末行尾/行数` 自证，并给出**"改后 Buffer ≡ 按声明区间拼接出来的
            期望 Buffer"**的逐字节证明（不是抽样比对）。
         ② **grep-first**：每个声明点都有**显式锚点串**（字面量）＋**显式形态正则**；
            锚点在文件里必须**恰命中 1 次**、形态正则在该行里必须**恰命中 1 次**，
            否则**该文件整体拒写并指名**（今天在"猜形态"上白跑过三轮全量，故此处不猜）。
         ③ **只做字面替换**：写入走**捕获组的字符区间拼接**（`m.indices`），
            全程**不调用** `String.replace(…, 替换串)` ⇒ 结构上不可能把 `$1`／`$&`／`$'` 写进文件。
         ④ `--apply` 结束打印**逐处 old → new** 摘要 ＋ 每文件行尾自证。
     · `--list`：只读列出每个声明点的 `文件:行号/当前值/真源值/状态`（审计覆盖面对账用）。

   【真源（唯一）】`tests\._verify\run-totals.json`（各脚本 `passed/failed/skipped`）
     ＋ **由它现算的和值**＝ Σ(13 个非自指离线门禁实跑通过数) ＋ 自指脚本 `docs-cross-check` 的账本值
     ＋ **合计**＝和值 ＋ `browser-check` ＋ `overlap-check` ＋ `stress-check`。
     ⚠ 口径**不自创**：门禁集合取自 `tests\run-all.js` 的 `SUITES`（既有实现的唯一清单）；
       合计口径的**既有实现**由 `run-all.verifyAuthorityTotals()` 直接复用做第 17 条互证；
       数字解析复用 `tests\lib\numeric.js`（`docs-cross-check` 第十/十六节用的是**同一份函数**）。
     ⚠ 为什么不是"另写一套"（`D21`）：`docs-cross-check` 把 `nameDecl()`／`FAM16`／`sumEval16()`
       定义在 `main()` **内部**、**没有任何 `module.exports`**，且 `require` 它会**立即执行整轮**
       （含 12 个脚本的实跑探针）⇒ 无法在不动它的前提下直接 `require` 那几个纯函数。
       本脚本的替代做法是**向下取同一层底座**：`lib\numeric.js`（同一份纯函数）＋ `run-all` 的
       `SUITES`／`verifyAuthorityTotals`（合计口径的既有实现），并在**同一轮**里与
       `docs-cross-check` 互证（两条都绿才算对得上）。**未**改动 `docs-cross-check.js` 一个字节。

   【明确不做】
     · **不改任何 dated 历史行**（`>` 引用块、逐日小结、变更记录）：位于历史行上的锚点
       ⇒ **拒写并指名**（`isDated()` 的四条排除口径与 `docs-cross-check` §16 同源）。
     · **不代笔散文式枚举**：形如 `4 跳过＝…ui-check 1 项 ＋ stress-check 3 条` 的叙述句里，
       数字改了而枚举文字不会自动跟着走 ⇒ 本工具**只报不改**（见 `--check` 的"待人工同步"段）。
     · **不重复实现 `docs-cross-check` §15 的覆盖类判据**（可追溯覆盖/离线可验证/AC 覆盖）：
       它们的真源是 `trace-check` 的实跑输出，已由那一节守着；此处再写一份就是"第二个真源"。

   依赖：仅 Node 内置模块 ＋ `tests\env.js`／`tests\lib\numeric.js`／`tests\lib\assert.js`／
         `tests\run-all.js`（后两者只取纯函数与清单，不在本脚本里跑门禁）。
   退出码契约（规范 9.5-5）：`0` 通过 ｜ `1` 有漂移/拒写/不可比 ｜ `2` 脚本自身异常。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const env = require('./env');
env.assertRuntime();                                   /* D16：每个 tests\*.js 入口都要校验运行环境 */
const numeric = require('./lib/numeric');              /* 与 docs-cross-check 第十/十六节**同一份**纯函数 */
const { createRunner } = require('./lib/assert');
const runAll = require('./run-all');                   /* 既有实现：门禁清单 SUITES ＋ 合计口径 verifyAuthorityTotals */

const SELF = 'docs-cross-check';                       /* 自指脚本（与 docs-cross-check §11 同名同义） */
const SUITES = Array.isArray(runAll.SUITES) ? runAll.SUITES : [];
const OFFLINE = SUITES.filter(s => !s.needBrowser).map(s => s.name);
const BROWSER = SUITES.filter(s => s.needBrowser).map(s => s.name);

/* `DSH_SA_ROOT`＝**受控数据根覆盖**（与 `docs-cross-check` 的 `DSH_DC_*_OVERRIDE` 同口径）：
   只为"在**仓外临时副本**上验字节安全"而存在（任务包硬要求 ③）。设了它 ⇒ 互证跳过
   （`verifyAuthorityTotals()` 读的是真 `tests\README.md`，没有覆盖口）。 */
const OVERRIDDEN_ROOT = process.env.DSH_SA_ROOT ? path.resolve(process.env.DSH_SA_ROOT) : null;
const ROOT = OVERRIDDEN_ROOT || env.paths.root;
const ARGV = process.argv.slice(2);
const hasFlag = f => ARGV.includes(f);

const REL = {
  readme: 'tests/README.md',
  arch: '项目架构与技术栈.md',
  snap: '项目记录/当前状态快照.md',
  road: '项目记录/后续路线图.md'
};

/* ==========================================================================
   一、字节读数（行尾/编码自证）
   ========================================================================== */

/**
 * 一份文本的"行尾/编码"读数（改前改后各取一次，逐项比对 ⇒ 自证"只改了目标数字"）。
 * @param {string} text 文件全文（UTF-8 解码后）
 * @returns {{bytes:number,bom:boolean,crlf:number,bareLf:number,bareCr:number,eofEol:boolean,lines:number}}
 */
const readings = (text) => {
  const b = Buffer.from(text, 'utf8');
  let crlf = 0; let bareLf = 0; let bareCr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\r') { if (text[i + 1] === '\n') { crlf++; i++; } else bareCr++; }
    else if (c === '\n') bareLf++;
  }
  return {
    bytes: b.length,
    bom: text.charCodeAt(0) === 0xFEFF,
    crlf, bareLf, bareCr,
    eofEol: /(?:\r\n|\n|\r)$/.test(text),
    lines: splitLines(text).length
  };
};

/**
 * 按**行尾原样**切行，并给出每行在全文里的**字符区间**（`end` 不含行尾符）。
 *
 * 为什么不 `text.split(/\r?\n/)`：那会把"裸 CR"与"CRLF"混为一谈 —— 而本脚本的全部字节安全
 * 自证都建立在"能指出每个声明值到底在哪几个字符上"之上。故用 `/[\r\n]/` 逐个定位行尾。
 * @param {string} text
 * @returns {Array<{no:number,start:number,end:number,text:string}>}
 */
function splitLines(text) {
  const out = [];
  let start = 0; let no = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\r' || c === '\n') {
      out.push({ no, start, end: i, text: text.slice(start, i) });
      if (c === '\r' && text[i + 1] === '\n') i++;
      start = i + 1; no++;
    }
  }
  if (start <= text.length) out.push({ no, start, end: text.length, text: text.slice(start) });
  return out;
}

/** `docs-cross-check` §16 的 `isDated16()`（四条排除口径**逐条同源**）：命中即"历史/现场读数行"，
 *  其数字**不是现状声明** ⇒ 既不改它、也不判它红。 */
const isDated = s => /^\s*\|?\s*\d{4}-\d{2}-\d{2}/.test(s)
  || /原始输出引文|最近一轮[:：]|截至\s*\d{4}-\d{2}-\d{2}/.test(s)
  || /现场读数|本机不可复跑|（当时口径）|\(当时口径\)/.test(s);

/* ==========================================================================
   二、真源
   ========================================================================== */

/** 读 `tests\._verify\run-totals.json`（与 `docs-cross-check` §11 的 `readRunTotals()` 同口径：
 *  **按内容完整性**采信，不看 mtime —— mtime 与进程启动时刻只差 0.1 s，判定会因计时抖动翻面）。 */
function readLedger() {
  const file = path.join(ROOT, 'tests', '._verify', 'run-totals.json');
  try {
    if (!fs.existsSync(file)) {
      return { ok: false, why: '不存在（本轮不是经 run-all 启动，账本还没生成过）', entries: {}, ranSuites: [], meta: {} };
    }
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(j.suites)) return { ok: false, why: '结构不对（缺 suites 数组）', entries: {}, ranSuites: [], meta: {} };
    const entries = {};
    for (const s of j.suites) {
      if (s && s.name && s.summary) {
        entries[s.name] = {
          passed: Number(s.summary.passed), failed: Number(s.summary.failed || 0),
          skipped: Number(s.summary.skipped || 0), status: s.status
        };
      }
    }
    return {
      ok: true, why: '', entries, file,
      ranSuites: Array.isArray(j.ranSuites) ? j.ranSuites : [],
      meta: { at: j.at, mode: j.mode, role: j.role, mainLedger: j.mainLedger, pid: j.pid }
    };
  } catch (err) {
    return { ok: false, why: '读取失败：' + (err && err.message), entries: {}, ranSuites: [], meta: {} };
  }
}

/** 真源"取不到"的显式标记（`D19`/`D20`：取不到**不得**静默放过，也不得冒充成"漂移"）。 */
const NA = why => ({ ok: false, why });
const T = value => ({ ok: true, value });

/**
 * 实跑 `files-check` 并解析它自报的**扫描文本文件数**与**`.js` 数**。
 *
 * 为什么要探针：README 脚本表里那两处是**现状声明**（`docs-cross-check` §10 会把"扫描 N 个文本文件"
 * 与 `files-check` 实跑值逐字比对），而它们的真源只存在于该脚本的输出里 —— 从别处现算就是"第二个真源"。
 * 约束（与 `docs-cross-check` §10 的 `probe()` 同口径）：**输出落文件再回读**（受限环境禁管道）、
 * 日志落**仓外临时目录**（`--check` 自称只读 ⇒ 不在仓库里留任何字节）、**跑完不清理**（落 `%TEMP%`，由系统回收；本脚本**不删任何文件**）。
 * ⚠ 探针跑的**永远是真实仓库**的 `tests\files-check.js`（`env.paths.tests`／`env.paths.root`），
 *    不是 `DSH_SA_ROOT` 指向的副本：副本里没有 `tests\lib`（模块解析会当场退 2），
 *    而它要回答的问题本来就是"**这个受管面上有多少文本文件/`.js`**" —— 副本模式下文档是同一份内容的副本，
 *    真源仍是真仓库的那份读数。副本与真仓库读数不一致时，会如实报成"声明 ≠ 真源"（不静默）。
 * @returns {{ok:boolean,scan:(number|null),js:(number|null),why:string}}
 */
function probeFilesCheck() {
  const log = path.join(os.tmpdir(), `sync-authority-files-${process.pid}.log`);
  let fd = null;
  try {
    fd = fs.openSync(log, 'w');
    const r = spawnSync(process.execPath, [path.join(env.paths.tests, 'files-check.js')],
      { cwd: env.paths.root, stdio: ['ignore', fd, fd], timeout: 600000 });
    fs.closeSync(fd); fd = null;
    let out = '';
    try { out = fs.readFileSync(log, 'utf8'); } catch { out = ''; }
    const scan = numeric.matchNumber(out, /扫描\s*(\d+)\s*个文本文件/);
    const js = numeric.matchNumber(out, /全部\s*(\d+)\s*个 \.js 文件可被 node 解析/);
    if (r.error && r.error.code === 'ETIMEDOUT') return { ok: false, scan: null, js: null, why: '探针超时（前提不成立：机器忙/预算不够）' };
    if (scan === null || js === null) return { ok: false, scan, js, why: `实跑未产出可解析读数（退出码 ${r.status}）` };
    return { ok: true, scan, js, why: '' };
  } catch (err) {
    return { ok: false, scan: null, js: null, why: '探针异常：' + (err && err.message) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
    /* ⚠ 刻意**不清理**：临时日志落 `%TEMP%`（仓库面之外），由系统回收；本脚本**不删任何文件**（不是漏写）。 */
  }
}

/**
 * 现算真源（**唯一入口**）。
 * @returns {object} 见下方 `truth.*` 的各字段；每个取值都是 `T(...)`／`NA(why)`
 */
function computeTruth(led, filesProbe, selfDecl) {
  const missing = SUITES.map(s => s.name).filter(n => !led.entries[n]);
  const e = n => led.entries[n];
  const field = (n, f) => (e(n) ? T(e(n)[f]) : NA(`账本里没有 \`${n}\` 的条目（--fast 子集轮／本轮未入账）`));

  /* 自指脚本那一项：取**账本值**（＝它上一轮跑完的终值）；口径说明见脚本抬头。
     ⚠ 取账本值而不是"权威区自述值"，是为了让 `--apply` **一趟**写出自洽的文件：
       否则"自述值错了 ⇒ 和值也跟着按错的算 ⇒ 和值写对了却与实跑不符"。 */
  const selfTerm = e(SELF) ? T(e(SELF).passed) : NA(`账本里没有自指脚本 \`${SELF}\` 的条目`);
  const sumParts = OFFLINE.filter(n => n !== SELF).map(n => ({ n, v: field(n, 'passed') }));
  const sumMissing = sumParts.filter(p => !p.v.ok).map(p => p.n);
  const sum = (sumMissing.length === 0 && selfTerm.ok)
    ? T(sumParts.reduce((a, p) => a + p.v.value, 0) + selfTerm.value)
    : NA(sumMissing.length
      ? `和值真源里这些脚本本轮取不到实跑值：${sumMissing.join('、')}`
      : selfTerm.why);

  const browserParts = BROWSER.map(n => ({ n, v: field(n, 'passed') }));
  const browserMissing = browserParts.filter(p => !p.v.ok).map(p => p.n);
  const totalPassed = (sum.ok && browserMissing.length === 0)
    ? T(sum.value + browserParts.reduce((a, p) => a + p.v.value, 0))
    : NA(sum.ok ? `合计里这些浏览器/长跑脚本本轮取不到实跑值：${browserMissing.join('、')}` : sum.why);
  const failedParts = SUITES.map(s => field(s.name, 'failed'));
  const skippedParts = SUITES.map(s => field(s.name, 'skipped'));
  const totalFailed = failedParts.every(v => v.ok) ? T(failedParts.reduce((a, v) => a + v.value, 0)) : NA('账本条目不全，合计失败数取不到');
  const totalSkipped = skippedParts.every(v => v.ok) ? T(skippedParts.reduce((a, v) => a + v.value, 0)) : NA('账本条目不全，合计跳过数取不到');

  /* README 权威行里"现为 **6** ＝ ui-check 1 ＋ stress-check 3 ＋ harness-check 2"这一处：
     它的枚举**写死了三个脚本名**（形态的一部分）。若实跑里有跳过的脚本集合变了，
     本工具**不代笔改写枚举**（那要动散文，不是"只改数字"）⇒ 该点整条**拒写**并指名。 */
  const SKIP_ENUM = ['ui-check', 'stress-check', 'harness-check'];
  const skippedNow = SUITES.map(s => s.name).filter(n => e(n) && e(n).skipped > 0);
  const skipEnumOk = skippedNow.length === SKIP_ENUM.length && SKIP_ENUM.every(n => skippedNow.includes(n));

  return {
    led, filesProbe, missing, sum, totalPassed, totalFailed, totalSkipped,
    js: T(fs.readdirSync(path.join(ROOT, 'tests')).filter(n => n.endsWith('.js')).length),
    gates: T(OFFLINE.length),
    browserCount: T(BROWSER.length),
    suiteCount: T(SUITES.length),
    pass: n => field(n, 'passed'),
    fail: n => field(n, 'failed'),
    skip: n => field(n, 'skipped'),
    selfDecl,
    filesScan: filesProbe && filesProbe.ok ? T(filesProbe.scan) : NA((filesProbe && filesProbe.why) || '未取 files-check 探针'),
    filesJs: filesProbe && filesProbe.ok ? T(filesProbe.js) : NA((filesProbe && filesProbe.why) || '未取 files-check 探针'),
    skipEnum: skipEnumOk ? T(true) : NA(`实跑有跳过项的脚本集合＝[${skippedNow.join('、') || '空'}] ≠ 声明形态里写死的 [${SKIP_ENUM.join('、')}] ⇒ 枚举文字需人工改写（本工具不代笔）`),
    skipEnumParts: SKIP_ENUM.map(n => field(n, 'skipped'))
  };
}

/* ==========================================================================
   三、声明点注册表（**显式锚点 ＋ 显式形态**，不许猜）
   --------------------------------------------------------------------------
   每个声明点的四个要素：
     · `file`   ：四份受管文档之一（本脚本是它们唯一允许的写入者）
     · `anchor` ：**显式锚点串**（字面量）——在文件里必须**恰命中 1 次**（grep-first 的第一道闸）
     · `scope`  ：`'after'`＝形态正则必须**紧贴锚点之后**命中在偏移 0；
                  `'line'` ＝形态正则必须在**锚点所在行**里命中（且**恰 1 次**）
     · `re`     ：形态正则（**捕获组＝当前声明值**；写入时按捕获组的**字符区间**拼接新数字）
     · `parts`  ：捕获组 ↦ { 标签, 真源取数 } —— 每个数字都要有名字与真源，避免"数字没有归属"
   形态正则一律**留出空白容差**（`\s*`），因为文档里的加粗/空格写法历史上变过；
   但**脚本名与中文短语是逐字的** —— 那才是"声明形态"，不是可以猜的东西。
   ========================================================================== */

/** §11 的逐脚本声明形态（`nameDecl()` 的**同一份正则**：三位 `P/F/S` 与后缀 `（+N 跳过）` 都认）。 */
const tripleRe = name => new RegExp('`' + name + '`\\s*\\*{0,2}\\s*(\\d+)\\s*/\\s*(\\d+)'
  + '(?:\\s*/\\s*(\\d+))?\\s*\\*{0,2}\\s*(?:[（(]\\s*\\+\\s*(\\d+)\\s*跳过)?');

/** README 脚本表"中文形式"：行首 `| \`tests/xxx.js\` |` ＋ 覆盖列里的 `描述（**N 项**…）`。
 *  **与 `docs-cross-check` §11 的 `tableDeclarations` 逐字同源**（同一个 `desc` 正则）。 */
const tableDescRe = () => /([^|（）*`]{1,20}?)（(?:\*\*|\s)*(\d+)\s*项/;

/**
 * 构建声明点清单。
 * @param {object} truth `computeTruth()` 的返回值
 * @returns {Array<object>}
 */
function buildPoints(truth) {
  const P = [];
  const add = p => { P.push(p); return p; };

  /* ---------- ① tests\README.md ---------- */
  const R = REL.readme;
  /* 第 6 行（脚本数量口径说明行）：`tests\*.js` 个数 / 离线门禁数 / 浏览器类脚本数 */
  add({
    key: 'readme.head.js', file: R, scope: 'line', anchor: '此后门禁持续增加',
    re: /`tests\\\*\.js`\s*\*\*(\d+) 个\*\*/, parts: { 1: { label: '`tests\\*.js` 个数', t: () => truth.js } }
  });
  add({
    key: 'readme.head.gates', file: R, scope: 'line', anchor: '此后门禁持续增加',
    re: /带断言的离线门禁 \*\*(\d+) 个\*\*/, parts: { 1: { label: '离线门禁数', t: () => truth.gates } }
  });
  add({
    key: 'readme.head.browser', file: R, scope: 'line', anchor: '此后门禁持续增加',
    re: /、需浏览器权限的 \*\*(\d+) 个\*\*/, parts: { 1: { label: '浏览器类脚本数', t: () => truth.browserCount } }
  });

  /* 第三节**权威区行**（唯一真源那一行；锚点＝§15／§16 都在用的结构性词 `离线可跑部分`） */
  const AUTH = { file: R, scope: 'line', anchor: '离线可跑部分' };
  add({
    ...AUTH, key: 'readme.auth.gates',
    re: /不需要浏览器\/命名管道的 \*\*(\d+) 个\*\*门禁/, parts: { 1: { label: '离线门禁数', t: () => truth.gates } }
  });
  add({
    ...AUTH, key: 'readme.auth.browserCount',
    re: /紧随其后另列 (\d+) 个需本地浏览器或长跑的脚本/, parts: { 1: { label: '浏览器/长跑脚本数', t: () => truth.browserCount } }
  });
  add({
    ...AUTH, key: 'readme.auth.suites1',
    re: /跳过」是这 \*\*(\d+)\*\* 个脚本/, parts: { 1: { label: 'suite 集合脚本数', t: () => truth.suiteCount } }
  });
  add({
    ...AUTH, key: 'readme.auth.totalFailedProse',
    re: /「合计 N 通过 \/ (\d+) 失败 \/ K 跳过」/, parts: { 1: { label: '合计失败数（口径说明里的字面值）', t: () => truth.totalFailed } }
  });
  add({
    ...AUTH, key: 'readme.auth.suites2',
    re: /同样按\*\*全量 (\d+) 个\*\*/, parts: { 1: { label: '全量脚本数', t: () => truth.suiteCount } }
  });
  add({
    ...AUTH, key: 'readme.auth.skipEnum', guard: () => truth.skipEnum,
    re: /\*\*随实跑、勿写死\*\*（现为 \*\*(\d+)\*\* ＝ ui-check (\d+) ＋ stress-check (\d+) ＋ harness-check (\d+)）/,
    parts: {
      1: { label: '合计跳过数', t: () => truth.totalSkipped },
      2: { label: 'ui-check 跳过数', t: () => truth.skipEnumParts[0] },
      3: { label: 'stress-check 跳过数', t: () => truth.skipEnumParts[1] },
      4: { label: 'harness-check 跳过数', t: () => truth.skipEnumParts[2] }
    }
  });
  add({
    ...AUTH, key: 'readme.auth.sum',
    re: /（见 E50）；\*\*(\d+) 个的和是 (\d+)\*\*/,
    parts: { 1: { label: '"N 个"（离线门禁数）', t: () => truth.gates }, 2: { label: '和值', t: () => truth.sum } }
  });
  add({
    ...AUTH, key: 'readme.auth.total',
    re: /（不是靠登记偏差掩盖））。\*\*合计 (\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过\*\*/,
    parts: {
      1: { label: '合计通过', t: () => truth.totalPassed },
      2: { label: '合计失败', t: () => truth.totalFailed },
      3: { label: '合计跳过', t: () => truth.totalSkipped }
    }
  });
  /* 权威区行里**逐脚本三元**（17 个；含跳过后缀口径）——取数口径与 `docs-cross-check` §11 同源 */
  for (const name of SUITES.map(s => s.name)) {
    add({
      ...AUTH, key: 'readme.auth.script.' + name, re: tripleRe(name),
      parts: {
        1: { label: '通过', t: () => truth.pass(name) },
        2: { label: '失败', t: () => truth.fail(name) },
        3: { label: '跳过', t: () => truth.skip(name) },
        4: { label: '跳过（后缀形态）', t: () => truth.skip(name) }
      },
      skipSlots: [3, 4]                         /* 实跑有跳过项时，这两位必须至少写出一个（E112） */
    });
  }
  /* 脚本表行里的两处现状声明（files-check 自报读数＝唯一真源 ⇒ 走探针） */
  add({
    file: R, scope: 'after', anchor: '`node tests/files-check.js`（零依赖，扫描 **',
    key: 'readme.filesRow.scan', re: /^(\d+)\*\* 个文本文件/,
    parts: { 1: { label: '扫描文本文件数', t: () => truth.filesScan } }
  });
  add({
    file: R, scope: 'after', anchor: '⑥**全部 ',
    key: 'readme.filesRow.js', re: /^(\d+) 个 `\.js`/,
    parts: { 1: { label: '`.js` 文件数', t: () => truth.filesJs } }
  });
  /* 脚本表"中文形式"逐脚本条数（§11 的第二种形式；含自指脚本那一格 = `E190`ⓑ）。
     ⚠ 只登记**盘上确实带该形态**的那些行（实测 7 行）；给不带该形态的行登记一个点
       会让 `locate()` 判"形态命中 0 次" ⇒ 整份 README 被拒写 —— 那不是判据，是自伤。
       哪一行新长出 `描述（N 项）`，就在这里补一行（形态变了必须显式登记，不许猜）。 */
  const TABLE_FORM = ['files-check', 'harness-check', 'logic-check', 'db-check', 'platform-check', 'offline-check', SELF];
  for (const name of TABLE_FORM) {
    const isSelf = name === SELF;
    const t = isSelf ? (() => truth.selfDecl) : (() => truth.pass(name));
    add({
      file: R, scope: 'line', anchor: '| `tests/' + name + '.js` |',
      key: 'readme.table.' + name, re: tableDescRe(),
      parts: { 2: { label: '中文形式（N 项）', t } },
      note: isSelf ? '自指脚本 ⇒ 真源＝权威区对它的声明（与和值族同源）' : ''
    });
  }

  /* ---------- ② 项目架构与技术栈.md ---------- */
  const AR = REL.arch;
  add({
    file: AR, scope: 'line', anchor: '自检体系（**', key: 'arch.81',
    re: /自检体系（\*\*(\d+) 个\*\* `tests\\\*\.js`，其中 \*\*(\d+) 个\*\*为带断言的离线门禁/,
    parts: { 1: { label: '`tests\\*.js` 个数', t: () => truth.js }, 2: { label: '离线门禁数', t: () => truth.gates } }
  });
  add({
    file: AR, scope: 'line', anchor: '当前值（本行由', key: 'arch.90.total',
    re: /门禁 \*\*(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过\*\*/,
    parts: {
      1: { label: '合计通过', t: () => truth.totalPassed },
      2: { label: '合计失败', t: () => truth.totalFailed },
      3: { label: '合计跳过', t: () => truth.totalSkipped }
    }
  });
  add({
    file: AR, scope: 'line', anchor: '当前值（本行由', key: 'arch.90.js',
    re: /`tests\\` 共 \*\*(\d+) 个\*\* `\*\.js`/,
    parts: { 1: { label: '`tests\\*.js` 个数', t: () => truth.js } }
  });
  add({
    file: AR, scope: 'line', anchor: '与现有 JS 资产（适配层、模拟工具、', key: 'arch.100.js',
    re: /(\d+) 个自检脚本/, parts: { 1: { label: '自检脚本数', t: () => truth.js } }
  });
  add({
    file: AR, scope: 'line', anchor: '零依赖自检脚本（', key: 'arch.173',
    re: /零依赖自检脚本（(\d+) 个，其中 (\d+) 个为带断言的离线门禁/,
    parts: { 1: { label: '自检脚本数', t: () => truth.js }, 2: { label: '离线门禁数', t: () => truth.gates } }
  });
  add({
    file: AR, scope: 'line', anchor: '`tests\\` 下 **', key: 'arch.292',
    re: /`tests\\` 下 \*\*(\d+) 个\*\* `\*\.js`（其中 \*\*(\d+) 个\*\*为带断言的离线门禁/,
    parts: { 1: { label: '`tests\\*.js` 个数', t: () => truth.js }, 2: { label: '离线门禁数', t: () => truth.gates } }
  });
  add({
    file: AR, scope: 'line', anchor: '那 **', key: 'arch.295.sum',
    re: /那 \*\*(\d+)\*\* 个的和是 \*\*(\d+)\*\*/,
    parts: { 1: { label: '"N 个"（离线门禁数）', t: () => truth.gates }, 2: { label: '和值', t: () => truth.sum } }
  });
  /* §九 逐脚本行（`scripts.js`（N 项）／`scripts`（… N 项）两种形态） */
  const archScriptJ = [
    ['docs-cross-check', '`docs-cross-check.js`（', /^\*\*(\d+) 项\*\*/, () => truth.selfDecl],
    ['files-check', '`files-check.js`（', /^(\d+) 项/, () => truth.pass('files-check')],
    ['harness-check', '`harness-check.js`（', /^\*\*(\d+) 项\*\*/, () => truth.pass('harness-check')],
    ['logic-check', '`logic-check.js`（', /^\*\*(\d+) 项\*\*/, () => truth.pass('logic-check')],
    ['db-check', '`db-check.js`（', /^(\d+) 项/, () => truth.pass('db-check')],
    ['db-check', '`db-check`（本地库结构与仓储层 ', /^(\d+) 项/, () => truth.pass('db-check')],
    ['logic-check', '`logic-check`（班次与统计 **', /^(\d+) 项\*\*/, () => truth.pass('logic-check')],
    ['platform-check', '`platform-check`（平台适配层 ', /^(\d+) 项/, () => truth.pass('platform-check')]
  ];
  for (const [name, anchor, re, t] of archScriptJ) {
    add({
      file: AR, scope: 'after', anchor, key: 'arch.s9.' + name + '@' + anchor,
      re, parts: { 1: { label: '（N 项）', t } }
    });
  }
  add({
    file: AR, scope: 'line', anchor: '自检 `db-check` ', key: 'arch.83.dbpf',
    re: /自检 `db-check` (\d+)\/(\d+)/,
    parts: { 1: { label: '通过', t: () => truth.pass('db-check') }, 2: { label: '失败', t: () => truth.fail('db-check') } }
  });
  add({
    file: AR, scope: 'after', anchor: '（`server\\db` + `server\\repo`，', key: 'arch.37.dbpf',
    re: /^`db-check` (\d+)\/(\d+)/,
    parts: { 1: { label: '通过', t: () => truth.pass('db-check') }, 2: { label: '失败', t: () => truth.fail('db-check') } }
  });
  add({
    file: AR, scope: 'line', anchor: '✅ 已完整 | ', key: 'arch.317.js',
    re: /(\d+) 个测试脚本/, parts: { 1: { label: '测试脚本数', t: () => truth.js } }
  });

  /* ---------- ③ 项目记录\当前状态快照.md ---------- */
  const S = REL.snap;
  /* 一屏速览行：锚点＝`docs-cross-check` §15 用过的**结构性短语**（不含计数，故不会随脚本数漂移） */
  const SNAP = { file: S, scope: 'line', anchor: '个脚本的总计' };
  add({
    ...SNAP, key: 'snap.screen.js', re: /`tests\\` 共 \*\*(\d+) 个\*\* `\*\.js`/,
    parts: { 1: { label: '`tests\\*.js` 个数', t: () => truth.js } }
  });
  add({
    ...SNAP, key: 'snap.screen.gates', re: /`\*\.js`（\*\*(\d+) 个\*\*带断言的离线门禁/,
    parts: { 1: { label: '离线门禁数', t: () => truth.gates } }
  });
  add({
    ...SNAP, key: 'snap.screen.browser', re: /带断言的离线门禁 ＋ \*\*(\d+) 个\*\*需本地浏览器/,
    parts: { 1: { label: '浏览器/长跑脚本数', t: () => truth.browserCount } }
  });
  add({
    ...SNAP, key: 'snap.screen.suites', re: /需本地浏览器\/长跑 ＝ 门禁\*\*全量 (\d+) 个\*\*/,
    parts: { 1: { label: '全量脚本数', t: () => truth.suiteCount } }
  });
  add({
    ...SNAP, key: 'snap.screen.total', re: /；门禁 \*\*(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过\*\*/,
    parts: {
      1: { label: '合计通过', t: () => truth.totalPassed },
      2: { label: '合计失败', t: () => truth.totalFailed },
      3: { label: '合计跳过', t: () => truth.totalSkipped }
    }
  });
  add({
    ...SNAP, key: 'snap.screen.browserScripts',
    re: /`browser-check` \*\*(\d+)\/(\d+)\*\*、`overlap-check` \*\*(\d+)\/(\d+)\*\*、`screenshot-diff` \*\*(\d+)\/(\d+)\*\*/,
    parts: {
      1: { label: 'browser-check 通过', t: () => truth.pass('browser-check') },
      2: { label: 'browser-check 失败', t: () => truth.fail('browser-check') },
      3: { label: 'overlap-check 通过', t: () => truth.pass('overlap-check') },
      4: { label: 'overlap-check 失败', t: () => truth.fail('overlap-check') },
      5: { label: 'screenshot-diff 通过', t: () => truth.pass('screenshot-diff') },
      6: { label: 'screenshot-diff 失败', t: () => truth.fail('screenshot-diff') }
    }
  });
  add({
    file: S, scope: 'line', anchor: '跑一遍门禁看结论', key: 'snap.expect.total',
    re: /预期 \*\*(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过\*\*/,
    parts: {
      1: { label: '合计通过', t: () => truth.totalPassed },
      2: { label: '合计失败', t: () => truth.totalFailed },
      3: { label: '合计跳过', t: () => truth.totalSkipped }
    }
  });

  /* ---------- ④ 项目记录\后续路线图.md（header 当前基线行） ---------- */
  const D = REL.road;
  add({
    file: D, scope: 'line', anchor: '| 当前基线 |', key: 'road.header.total',
    /* ⚠ 路线图这一行的写法与其余三处**不同**：加粗在"门禁"**之前**（`**门禁 1884 通过…**`），
       故此处用 `[^\d]{0,4}` 容掉 `**`／空格（`docs-cross-check` §15 的同族正则也是这个口径）。 */
    re: /门禁[^\d]{0,4}(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 跳过/,
    parts: {
      1: { label: '合计通过', t: () => truth.totalPassed },
      2: { label: '合计失败', t: () => truth.totalFailed },
      3: { label: '合计跳过', t: () => truth.totalSkipped }
    }
  });
  add({
    file: D, scope: 'line', anchor: '| 当前基线 |', key: 'road.header.screenshotDiff',
    re: /界面基准图已按本批 UI 变更\*\*重拍\*\*，`screenshot-diff` \*\*(\d+)\/(\d+)\*\*/,
    parts: {
      1: { label: 'screenshot-diff 通过', t: () => truth.pass('screenshot-diff') },
      2: { label: 'screenshot-diff 失败', t: () => truth.fail('screenshot-diff') }
    }
  });

  return P;
}

/* ==========================================================================
   三之二、登记点（registration points）—— "新增脚本必须在本表登记"这一类**存在性**要求
   --------------------------------------------------------------------------
   立案（本批实测）：`tests\docs-check.js:561-565` 断言「**tests/ 下的脚本都已在 tests/README.md 登记**」，
   判据＝**每个 `tests/*.js` 的文件名子串在 README 里出现**。新增一个脚本而不登记 ⇒ 那是**新增的未登记失败**
   （不是 6.4 已登记偏差）⇒ `run-all` 的 `authorityBlockers()` 会挡下权威对账、**整轮不可作证据**。
   故"登记"这件事也必须是机器可写的一个点 —— 它正是 `E56`（"人守数字换成机器守数字"）的同一族人工税。
   ⚠ 与"声明点"的区别：登记点**不产出数字声明**（因此不纳入 `--check` 的"声明值 ≠ 真源值"清单，
     也**不进**权威区条数），它只回答"这一行在不在"；`--apply` 的动作是**按原行尾插入一行**（不是改数字）。
   ========================================================================== */
const REGISTRATIONS = [
  {
    key: 'readme.register.sync-authority',
    file: REL.readme,
    anchor: '| `tests/run-all.js` |',                     /* 插在 runner 那一行之后（工具/runner 行区） */
    mustContain: 'sync-authority.js',                     /* 判据与 `docs-check` **逐字同源**：文件名子串 */
    why: '`docs-check` 的「tests/ 下的脚本都已在 tests/README.md 登记」要求它；未登记 ⇒ 新增未登记失败 ⇒ 权威对账被挡',
    line: '| `tests/sync-authority.js` | `node tests/sync-authority.js --check`（零依赖；`--apply` 写、'
      + '`--list` 列出声明点、`--no-probe` 跳过 files-check 探针） | **权威区同步器（技术债 `E56` 的“写”那半边）**：'
      + '把四份受管文档里的**门禁数字声明点**（README 权威行与脚本表中文形式／架构当前值行与 §九 逐脚本行／'
      + '快照一屏速览行与预期行／路线图 header）与 `tests\\._verify\\run-totals.json` 的**现算真源**逐处比对'
      + '（`--check`：零漂移退 0，任何一处不符退 1 并逐处指名 `文件:行号 ＋ 声明值 ≠ 真源值`）或同步（`--apply`：'
      + '**grep-first 锚点恰 1 命中 ＋ 只改目标数字的字符区间 ＋ 按原行尾/BOM/末行尾写回**，dated 历史行**拒写并指名**）。'
      + '**不是门禁**（不在 `run-all` 的 suite 清单里）⇒ 不计入权威区条数、也不参与权威对账 |'
  }
];

/* ==========================================================================
   四、定位（grep-first）与取值
   ========================================================================== */

/** 每个受管文件里"至少应有多少个声明点"（**防静默缩小校验范围**，D23：把点删掉就没人守了）。
 *  数值＝本次交付的实测点数**下界**（不是精确值：以后加点不必改这里，删点必红）。 */
const POINT_FLOOR = { [REL.readme]: 35, [REL.arch]: 15, [REL.snap]: 6, [REL.road]: 2 };

/**
 * 在一个文件的文本里定位一个声明点。
 * @param {string} text 文件全文
 * @param {Array} lines `splitLines()` 的结果
 * @param {object} point 声明点
 * @returns {{ok:boolean,why:string,line:?object,anchorHits:number,m:?object,reHits:number,dated:boolean}}
 */
function locate(text, lines, point) {
  const hits = lines.filter(l => l.text.includes(point.anchor));
  if (hits.length !== 1) {
    return { ok: false, why: `锚点命中 ${hits.length} 次（要求**恰 1 次**）：${JSON.stringify(point.anchor)}`, anchorHits: hits.length, m: null, reHits: 0, dated: false };
  }
  const line = hits[0];
  const dated = isDated(line.text);
  /* 形态正则：`after` ⇒ 必须紧贴锚点之后命中在偏移 0；`line` ⇒ 在整行里命中且**恰 1 次**
     ⚠ 一律带 `d` 标志：写入靠 `m.indices[g]` 的**字符区间**（不是靠替换串 —— 那正是 `$1` 事故的入口）。 */
  const globalRe = new RegExp(point.re.source, 'gd');
  let reHits = 0; let m = null;
  let base = 0;                                  /* 形态匹配串相对**行首**的偏移（`after` 作用域下≠0） */
  if (point.scope === 'after') {
    base = line.text.indexOf(point.anchor) + point.anchor.length;
    const tail = line.text.slice(base);
    const one = new RegExp('^(?:' + point.re.source + ')', 'd').exec(tail);
    if (one) { reHits = 1; m = one; }
    /* 另核"全文里这个形态是否唯一"：不止一次 ⇒ 说明锚点没把声明点卡死 */
    let k = 0; let mm;
    while ((mm = globalRe.exec(line.text)) !== null) { k++; if (k > 1) break; }
    if (reHits === 1 && k > 1) {
      return { ok: false, why: `锚点后的形态命中了，但**同一行里该形态出现 ${k} 次以上** ⇒ 锚点没有把声明点卡死`, anchorHits: 1, m: null, reHits: k, dated };
    }
  } else {
    let mm;
    while ((mm = globalRe.exec(line.text)) !== null) { reHits++; m = mm; if (reHits > 1) break; }
  }
  if (reHits !== 1 || !m) {
    return { ok: false, why: `声明形态在该行命中 ${reHits} 次（要求**恰 1 次**）：${point.re}`, anchorHits: 1, m: null, reHits, dated, base, line };
  }
  return { ok: true, why: '', line, anchorHits: 1, m, reHits: 1, dated, base };
}

/**
 * 一个声明点的"当前值 / 真源值 / 待改区间"。
 * @returns {{ok:boolean,why:string,parts:Array,changes:Array,unavailable:Array}}
 */
function evaluatePoint(text, lines, point) {
  const loc = locate(text, lines, point);
  if (!loc.ok) return { ok: false, why: loc.why, parts: [], changes: [], unavailable: [], loc };
  if (loc.dated) {
    return { ok: false, why: `${point.file}:${loc.line.no} 锚点落在 **dated 历史行**（isDated() 四条口径命中）⇒ 该文件**整体拒写并指名**（硬纪律 10：历史记录不改）`, parts: [], changes: [], unavailable: [], loc };
  }
  if (point.guard) {
    const g = point.guard();
    if (!g.ok) return { ok: false, why: '形态守卫不成立：' + g.why, parts: [], changes: [], unavailable: [], loc };
  }
  const parts = []; const changes = []; const unavailable = [];
  const seen = [];
  const skipSlots = point.skipSlots || [];
  for (const [gKey, spec] of Object.entries(point.parts)) {
    const g = Number(gKey);
    const tv = spec.t();
    const idx = loc.m.indices ? loc.m.indices[g] : null;
    if (!idx) {
      /* 该捕获组在本形态里不存在：
         · 若它属于 `skipSlots`（`P/F/S` 三元 与 `（+N 跳过）` 后缀是**互斥的两种写法**，
           必然有一位缺席）⇒ **不据此拒写**，是否缺"跳过位"由下面的 `skipSlots` 段统一判；
         · 其它情况：真源要求写出非 0 值而没有这一位 ⇒ **拒写**（不代笔改形态）。 */
      if (!skipSlots.includes(g) && tv.ok && Number(tv.value) !== 0) {
        return { ok: false, why: `形态里没有「${spec.label}」这一位，而真源要求写出 ${tv.value} ⇒ 需人工补写该位（本工具不代笔改形态）`, parts: [], changes: [], unavailable: [], loc };
      }
      parts.push({ g, label: spec.label, got: null, truth: tv, slotMissing: true });
      continue;
    }
    const [s, e] = idx;
    const relS = s + loc.base;                    /* 换算回**行内**偏移（`after` 作用域要加锚点尾偏移） */
    const relE = e + loc.base;
    const raw = text.slice(loc.line.start + relS, loc.line.start + relE);
    const got = Number(raw);
    parts.push({ g, label: spec.label, got, truth: tv, raw, absStart: loc.line.start + relS, absEnd: loc.line.start + relE });
    if (!tv.ok) { unavailable.push(`${spec.label}（${tv.why}）`); continue; }
    if (String(tv.value) !== raw) {
      changes.push({ g, label: spec.label, got, want: tv.value, absStart: loc.line.start + relS, absEnd: loc.line.start + relE, raw });
    }
    if (seen.some(x => !(relE <= x[0] || relS >= x[1]))) {
      return { ok: false, why: '两个声明值的字符区间重叠 ⇒ 拒写（避免互相覆盖）', parts: [], changes: [], unavailable: [], loc };
    }
    seen.push([relS, relE]);
  }
  /* `skipSlots`：实跑有跳过项时，跳过位**必须**在声明里写出来（`E112` 的原始缺口） */
  if (point.skipSlots) {
    const anySlot = point.skipSlots.some(g => loc.m.indices && loc.m.indices[g]);
    const skipTruth = point.parts[point.skipSlots[0]].t();
    if (!anySlot && skipTruth.ok && Number(skipTruth.value) > 0) {
      return { ok: false, why: `实跑**跳过 ${skipTruth.value} 条**，而权威区只写了两位 \`P/F\` ⇒ 跳过数漏写（需人工补写；本工具不代笔改形态）`, parts: [], changes: [], unavailable: [], loc };
    }
  }
  return { ok: true, why: '', parts, changes, unavailable, loc };
}

/** 某文件按"真源可读性"标注：`NA` 的声明点本轮**不可比**（`D20`：取不到 ≠ 漂移）。 */
const fmtPart = p => (p.truth.ok ? String(p.truth.value) : `（本轮不可比：${p.truth.why}）`);

/* ==========================================================================
   五、写入（只改目标数字的字符区间；行尾/BOM/末行尾逐字节不可能变）
   ========================================================================== */

/**
 * 把 `file` 上所有声明点的改动**一次性**应用到内存文本，并给出"除声明区间外逐字节相同"的证明。
 * 声明点＝**改数字**（`newText`＝新数字）；登记点＝**插入一行**（`byteStart === byteEnd`，`newText`＝整行文本）。
 * @param {Buffer} before 改前字节
 * @param {Array<{absStart:number,absEnd:number,want:(number|undefined),newText:string,label:string,got:?number}>} changes
 * @returns {{ok:boolean,why:string,after:Buffer,spans:Array,insertStats:Object}}
 */
function applyChanges(before, changes) {
  const text = before.toString('utf8');
  /* 字符区间 → 字节区间：被替换的都是 ASCII 数字、被插入的整行用 `Buffer.byteLength` 现算 */
  const sorted = changes.slice().sort((a, b) => a.absStart - b.absStart);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].absStart < sorted[i - 1].absEnd) return { ok: false, why: '改动区间相互重叠 ⇒ 拒写', after: before, spans: [], insertStats: null };
  }
  const spans = sorted.map(c => {
    const newText = c.newText === undefined ? String(c.want) : c.newText;
    return {
      ...c, newText,
      byteStart: Buffer.byteLength(text.slice(0, c.absStart), 'utf8'),
      byteEnd: Buffer.byteLength(text.slice(0, c.absEnd), 'utf8'),
      inserted: c.absStart === c.absEnd
    };
  });
  /* 期望字节：在**改前字节**上按区间替换（**倒序**拼接，故下标始终有效）。
     ⚠ 顺序**必须**是"先 unshift 本区间之后的尾段、再 unshift 新内容" —— `unshift` 是前插，
       两行的先后写反会让所有片段**整体乱序**（本脚本的首版就踩了这一处：临时副本的独立复核
       当场抓到"文件尾被追加了 531、且丢了 3 字节"。`expected` 与写出来的字节**一致**并不能发现它，
       因为两者同源 ⇒ 这也是"必须再有一道**独立**复核"的实证）。 */
  const chunks = [];
  let cursor = before.length;
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    chunks.unshift(before.slice(s.byteEnd, cursor));
    chunks.unshift(Buffer.from(s.newText, 'utf8'));
    cursor = s.byteStart;
  }
  chunks.unshift(before.slice(0, cursor));
  const expected = Buffer.concat(chunks);
  /* 插入行的读数（供自证：行数/各类行尾的**增量**必须恰好等于插入文本自带的量） */
  const insertedText = spans.filter(s => s.inserted).map(s => s.newText).join('');
  const insertStats = {
    lines: (insertedText.match(/\r\n|\n|\r/g) || []).length,
    crlf: (insertedText.match(/\r\n/g) || []).length,
    cr: (insertedText.match(/\r(?!\n)/g) || []).length,
    lf: (insertedText.match(/(?<!\r)\n/g) || []).length
  };
  return { ok: true, why: '', after: expected, spans, expected, insertStats };
}

/** `--apply` 的每文件收尾自证（行尾/编码/行数逐项 ＋ "只有声明区间变了"的逐字节证明）。
 *  **插入行**会合法地改变"行数/某类行尾"，故自证按**增量**判：`after == before + 插入量`。 */
function selfProof(rel, before, after, spans, insertStats) {
  const beforeText = before.toString('utf8');
  const rb = readings(beforeText);
  const ra = readings(after.toString('utf8'));
  const ins = insertStats || { lines: 0, crlf: 0, cr: 0, lf: 0 };
  const expect = { lines: rb.lines + ins.lines, crlf: rb.crlf + ins.crlf, bareCr: rb.bareCr + ins.cr, bareLf: rb.bareLf + ins.lf };
  const bad = ['bom', 'eofEol'].filter(k => rb[k] !== ra[k])
    .concat(['lines', 'crlf', 'bareCr', 'bareLf'].filter(k => expect[k] !== ra[k]));
  const beforeLines = splitLines(beforeText);
  const lineNos = [...new Set(spans.map(s => {
    const hit = beforeLines.find(l => l.start <= s.absStart && s.absEnd <= l.end);
    return hit ? hit.no : 0;
  }))];
  const insN = spans.filter(s => s.inserted).length;
  return {
    ok: bad.length === 0,
    line: `[自证] ${rel}｜字节 ${rb.bytes} → ${ra.bytes}（Δ${ra.bytes - rb.bytes >= 0 ? '+' : ''}${ra.bytes - rb.bytes}）` +
      `｜BOM ${rb.bom} → ${ra.bom}｜CRLF ${rb.crlf} → ${ra.crlf}（应 ${expect.crlf}）｜裸LF ${rb.bareLf} → ${ra.bareLf}（应 ${expect.bareLf}）` +
      `｜裸CR ${rb.bareCr} → ${ra.bareCr}（应 ${expect.bareCr}）｜末行尾 ${rb.eofEol} → ${ra.eofEol}` +
      `｜行数 ${rb.lines} → ${ra.lines}（应 ${expect.lines}）｜改数字 ${spans.length - insN} 处 ＋ 插入 ${insN} 行（行 ${lineNos.join('、')}）` +
      `｜行尾/编码/BOM/末行尾逐项不变${insN ? '（插入行按增量计入）' : ''}=${bad.length === 0}${bad.length ? '（不符：' + bad.join('、') + ' ⇒ **拒写**）' : ''}`
  };
}

/** 登记点状态：锚点恰 1 命中？"已登记"判据（文件名子串）是否成立？ */
function registrationState(text, lines, reg) {
  const hits = lines.filter(l => l.text.includes(reg.anchor));
  if (hits.length !== 1) return { ok: false, why: `锚点命中 ${hits.length} 次（要求**恰 1 次**）：${JSON.stringify(reg.anchor)}` };
  const registered = text.includes(reg.mustContain);
  return { ok: true, registered, line: hits[0], why: '' };
}

/* ==========================================================================
   六、两种模式
   ========================================================================== */

/** 取真源 ＋ 建点（两种模式共用，保证 `--check` 与 `--apply` 口径**同一条代码路径**） */
function prepare() {
  const led = readLedger();
  const filesProbe = hasFlag('--no-probe') ? { ok: false, why: '本次由 --no-probe 显式跳过 files-check 探针' } : probeFilesCheck();
  /* 自指脚本的"权威区声明值"：按 §11 的 nameDecl 在权威行上现取（供脚本表中文形式那一格比对） */
  let selfDecl = NA('权威区里解析不到自指脚本的声明');
  try {
    const readme = fs.readFileSync(path.join(ROOT, REL.readme), 'utf8');
    const authLine = splitLines(readme).find(l => l.text.includes('离线可跑部分'));
    if (authLine) {
      const m = tripleRe(SELF).exec(authLine.text);
      if (m) selfDecl = T(Number(m[1]));
    }
  } catch { /* 读不到 ⇒ 保持 NA */ }
  const truth = computeTruth(led, filesProbe, selfDecl);
  return { led, truth, points: buildPoints(truth) };
}

/** `--check`（默认）：逐处比对，零漂移退 0；任何一处不符 ⇒ 退 1 并逐处指名 */
function runCheck() {
  const t = createRunner('权威区同步器（sync-authority）');
  const { led, truth, points } = prepare();

  t.section('零、真源读数');
  const srcOf = n => (truth.pass(n).ok ? truth.pass(n).value : '（取不到）');
  t.info(`账本：${led.ok ? '可读' : '**不可读**'}${led.file ? '（' + path.relative(ROOT, led.file).split(path.sep).join('/') + '）' : ''}` +
    `${led.ok ? `｜at=${led.meta.at || '-'}｜mode=${led.meta.mode || '-'}｜role=${led.meta.role || '-'}｜条目 ${Object.keys(led.entries).length} 个｜ranSuites ${led.ranSuites.length} 个` : '：' + led.why}`);
  t.info(`现算真源：离线门禁 ${OFFLINE.length} 个｜浏览器/长跑 ${BROWSER.length} 个｜suite 集合 ${SUITES.length} 个｜` +
    `\`tests\\*.js\` ${truth.js.ok ? truth.js.value : '-'} 个｜files-check 探针 ${truth.filesScan.ok ? `扫描 ${truth.filesScan.value} / js ${truth.filesJs.value}` : '不可用：' + truth.filesScan.why}`);
  t.info(`现算和值 ${truth.sum.ok ? truth.sum.value : '（不可比：' + truth.sum.why + '）'}` +
    `｜合计 ${truth.totalPassed.ok ? truth.totalPassed.value : '（不可比）'} 通过 / ${truth.totalFailed.ok ? truth.totalFailed.value : '-'} 失败 / ${truth.totalSkipped.ok ? truth.totalSkipped.value : '-'} 跳过` +
    `｜逐脚本：${SUITES.map(s => `${s.name}=${srcOf(s.name)}`).join('、')}`);

  /* 前提（ADR-0004 D20）：账本必须覆盖 run-all 的**全部**门禁脚本 —— 否则那些点"本轮不可比" */
  t.requires('run-totals.json 覆盖 run-all 的全部 17 个门禁（缺条目者按 D20 记"本轮不可比"，**不判漂移**、也不静默放过）',
    led.ok && truth.missing.length === 0,
    led.ok ? `账本缺：${truth.missing.join('、') || '（无）'}` : `账本不可读：${led.why}`);

  const byFile = new Map();
  for (const p of points) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }

  t.section('一、锚点与形态完整性（grep-first：锚点恰 1 命中 ＋ 形态恰 1 命中）');
  const evals = new Map();
  for (const [file, list] of byFile) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const lines = splitLines(text);
    const ev = list.map(p => ({ p, e: evaluatePoint(text, lines, p) }));
    evals.set(file, { text, lines, ev });
    const lost = ev.filter(x => !x.e.ok).map(x => `${file}:${x.e.loc && x.e.loc.line ? x.e.loc.line.no : '?'} ${x.p.key} —— ${x.e.why}`);
    const floor = POINT_FLOOR[file] || 1;
    t.check(`「${file}」的 ${list.length} 个声明点：锚点/形态都恰命中 1 次，且点数 ≥ ${floor}（防"把声明删掉就没人守"）`,
      lost.length === 0 && list.length >= floor,
      (lost.length ? `**拒写/判红 ${lost.length} 处**：${lost.join('；')}` : `全部就位（${list.length} 个点）`)
      + (list.length < floor ? `｜**点数 ${list.length} < 地板 ${floor}**：有人删掉了声明点（D23 静默缩小校验范围）` : ''));
  }

  t.section('二、声明点 ↔ 真源 逐处比对');
  const allDrift = [];
  for (const [file, { ev }] of evals) {
    const drift = []; const unavail = [];
    for (const { p, e } of ev) {
      if (!e.ok) continue;
      for (const c of e.changes) {
        drift.push(`${file}:${e.loc.line.no} 「${c.label}」声明 ${c.got} ≠ 真源 ${c.want}（锚点 ${JSON.stringify(p.anchor)}）`);
      }
      for (const u of e.unavailable) unavail.push(`${file}:${e.loc.line.no} 「${u}」`);
    }
    allDrift.push(...drift);
    t.check(`「${file}」的声明点与真源逐处一致（本文件 ${ev.length} 个点，本轮可比 ${ev.filter(x => x.e.ok && x.e.unavailable.length === 0).length} 个）`,
      drift.length === 0,
      (drift.length ? `**漂移 ${drift.length} 处**：${drift.join('；')}` : '零漂移')
      + (unavail.length ? `｜**本轮不可比 ${unavail.length} 处**（真源取不到 ⇒ 不判漂移、也不静默放过）：${unavail.join('；')}` : ''));
    if (unavail.length) {
      t.info(`「${file}」本轮不可比的声明点（` + '`D20`：前提不成立 ≠ 权威区写错）：' + unavail.join('；'));
    }
  }

  t.section('二之二、登记点（新增脚本必须在 README 登记；`docs-check` 的同一条判据守着它）');
  for (const reg of REGISTRATIONS) {
    const text = fs.readFileSync(path.join(ROOT, reg.file), 'utf8');
    const st = registrationState(text, splitLines(text), reg);
    t.check(`「${reg.key}」：锚点恰 1 命中，且**已登记**（判据＝${JSON.stringify(reg.mustContain)} 出现在 ${reg.file} 里，与 \`docs-check\` 逐字同源）`,
      st.ok && st.registered,
      st.ok
        ? (st.registered ? `已登记（锚点行 ${st.line.no}）` : `**未登记**：${reg.file}:${st.line.no} 之后缺一行登记（${reg.why}）⇒ \`--apply\` 会插入`)
        : st.why);
  }

  t.section('三、与既有实现互证（`D21`：不另写一套口径）');
  const selfOk = truth.selfDecl && truth.selfDecl.ok;
  t.check('自指脚本 `docs-cross-check` 的账本值与权威区声明一致（自指项：第十一节本级无法自证，此处显式比对）',
    selfOk && truth.pass(SELF).ok ? truth.selfDecl.value === truth.pass(SELF).value : false,
    `权威区声明 ${selfOk ? truth.selfDecl.value : '（解析不到）'}；账本 ${truth.pass(SELF).ok ? truth.pass(SELF).value : '（取不到）'}` +
    '（两值不等 ⇒ 和值/合计也会跟着漂；本工具按账本值现算 ⇒ `--apply` 一趟即可自洽）');
  if (OVERRIDDEN_ROOT) {
    t.info('互证（`run-all.verifyAuthorityTotals`）**跳过**：本次由 `DSH_SA_ROOT` 指向临时副本，' +
      '而该函数读的是真 `tests\\README.md`（无覆盖口，属既有实现，本脚本不改它）。');
  } else {
    const results = SUITES.map(s => ({
      suite: { name: s.name },
      status: led.entries[s.name] ? (led.entries[s.name].failed > 0 ? 'failed' : 'passed') : 'unverified',
      summary: led.entries[s.name] || null, out: ''
    }));
    const auth = runAll.verifyAuthorityTotals({ passed: truth.totalPassed.ok ? truth.totalPassed.value : -1 }, results);
    t.info('互证读数（复用 `run-all.verifyAuthorityTotals`）：kind=' + auth.kind + '｜' + auth.detail);
    t.check('既有实现的合计口径与本工具现算的真源一致（`verifyAuthorityTotals` 复用；`blocked`/`skipped` 属真源完整性，不算漂移）',
      auth.ok || auth.kind === 'blocked' || auth.kind === 'skipped',
      `kind=${auth.kind}｜${auth.detail}`);
  }

  t.section('四、本工具**只报不改**的待人工同步项（散文式枚举）');
  const prose = [];
  for (const [file, { text }] of evals) {
    for (const l of splitLines(text)) {
      /* 只报**现状声明**行：逐日小结（`> **09-24 …`）、带日期的历史说明（`> **…（2026-09-24）**`）
         与 `isDated()` 的四条口径命中行都属历史，不在此列（本段**只报不写**，故排除口径放宽无风险） */
      const dailyLog = /^\s*>?\s*\*\*\d{2}-\d{2}/.test(l.text)
        || /^\s*\|?\s*\d{4}-\d{2}-\d{2}/.test(l.text)
        || /^\s*>\s*\*\*[^：\n]{0,40}\d{4}-\d{2}-\d{2}/.test(l.text);
      if (dailyLog || isDated(l.text)) continue;
      if (/跳过＝/.test(l.text)) {
        const n = numeric.matchNumber(l.text, /(\d+) 跳过＝/);
        if (n !== null && truth.totalSkipped.ok && n !== truth.totalSkipped.value) {
          prose.push(`${file}:${l.no} 叙述句里的「${n} 跳过＝…」（真源合计跳过 ${truth.totalSkipped.value}）——需人工补写枚举文字（本工具不代写散文）`);
        }
      }
    }
  }
  if (prose.length) {
    for (const line of prose) t.info('【待人工同步】' + line);
    t.info(`共 ${prose.length} 处：数字位可以自动改，但**枚举文字**（哪个脚本各跳过几条）必须人工写 —— ` +
      '代笔会造出"数字对、陈述错"的句子（比留旧更危险）。');
  } else {
    t.info('无（叙述句里的跳过枚举与真源一致，或本文件内没有该形态）。');
  }

  t.info(`声明点合计 ${points.length} 个（${[...byFile].map(([f, l]) => `${f}=${l.length}`).join('、')}）` +
    `｜漂移 ${allDrift.length} 处｜本次为 **--check（只读）**：未写任何文件`);
  t.finish();
}

/** `--apply`：把声明点改成真源值（**按声明区间拼接**，绝不整份重写、绝不翻转行尾） */
function runApply() {
  const t0 = Date.now();
  const { led, truth, points } = prepare();
  console.log('\n=== sync-authority --apply ===');
  console.log(`真源：账本${led.ok ? '可读' : '**不可读：' + led.why + '**'}｜离线 ${OFFLINE.length} / 浏览器 ${BROWSER.length} / suite ${SUITES.length}` +
    `｜\`tests\\*.js\` ${truth.js.ok ? truth.js.value : '-'} 个｜和值 ${truth.sum.ok ? truth.sum.value : '（不可比）'}` +
    `｜合计 ${truth.totalPassed.ok ? truth.totalPassed.value : '（不可比）'} 通过 / ${truth.totalFailed.ok ? truth.totalFailed.value : '-'} 失败 / ${truth.totalSkipped.ok ? truth.totalSkipped.value : '-'} 跳过`);

  const byFile = new Map();
  for (const p of points) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }

  let written = 0; let changedCount = 0; const refused = []; const unwritten = [];
  for (const [file, list] of byFile) {
    const abs = path.join(ROOT, file);
    const before = fs.readFileSync(abs);
    const text = before.toString('utf8');
    const lines = splitLines(text);
    const ev = list.map(p => ({ p, e: evaluatePoint(text, lines, p) }));
    const hard = ev.filter(x => !x.e.ok);
    if (hard.length) {
      refused.push(`${file}（**整体拒写**，${hard.length} 处）：${hard.map(x => `${x.p.key} —— ${x.e.why}`).join('；')}`);
      console.log(`\n[拒写] ${file}：${hard.length} 处不满足 grep-first/形态/日期口径 ⇒ 该文件**一个字节都不写**`);
      for (const x of hard) console.log(`   · ${x.p.key} —— ${x.e.why}`);
      continue;
    }
    const changes = [];
    const summary = [];
    let same = 0;
    for (const { p, e } of ev) {
      for (const c of e.changes) changes.push(c);
      for (const u of e.unavailable) unwritten.push(`${file}:${e.loc.line.no} 「${u}」`);
      if (e.changes.length === 0 && e.unavailable.length === 0) { same++; continue; }
      for (const c of e.changes) summary.push(`${p.key}：${c.got} → ${c.want}`);
      if (e.unavailable.length) summary.push(`${p.key}：因真源取不到未写（${e.unavailable.join('；')}）`);
    }
    /* 登记点（存在性要求）：缺登记 ⇒ **按原行尾插入一行**（插入点是锚点行的行尾之后） */
    let regBroken = null;
    for (const reg of REGISTRATIONS.filter(r => r.file === file)) {
      const st = registrationState(text, lines, reg);
      if (!st.ok) { regBroken = `${reg.key} —— ${st.why}`; break; }
      if (st.registered) { same++; continue; }
      const eolMatch = /\r\n|\n|\r/.exec(text.slice(st.line.end));
      const eol = eolMatch ? eolMatch[0] : '\n';
      const at = st.line.end + eol.length;
      changes.push({ absStart: at, absEnd: at, newText: reg.line + eol, label: '登记行（插入）', got: null, inserted: true });
      summary.push(`${reg.key}：**插入登记行**（在 ${reg.file}:${st.line.no} 之后，行尾沿用该行 ${JSON.stringify(eol)}）`);
    }
    if (regBroken) {
      refused.push(`${file}（登记点锚点不成立）：${regBroken}`);
      console.log(`\n[拒写] ${file}：登记点锚点不成立 ⇒ 该文件**一个字节都不写**\n   · ${regBroken}`);
      continue;
    }
    if (changes.length === 0) {
      console.log(`\n[文件] ${file}：无漂移（0 处）${same ? `（${same} 个点本来一致）` : ''}`);
      continue;
    }
    const res = applyChanges(before, changes);
    if (!res.ok) {
      refused.push(`${file}（改动区间冲突）：${res.why}`);
      console.log(`\n[拒写] ${file}：${res.why}`);
      continue;
    }
    const proof = selfProof(file, before, res.after, res.spans, res.insertStats);
    /* ⚠ 自证**写在写盘之前**：行尾/编码/行数任一项变了 ⇒ 这一份**一个字节都不写**
       （旧版先写后判，等于"判出来了但已经写坏了"—— 本批临时副本的独立复核当场抓到过）。 */
    if (!proof.ok) {
      refused.push(`${file}：写入前自证不通过（行尾/编码/行数有变化）`);
      console.log(`\n[拒写] ${file}：写入前自证不通过 ⇒ 不写\n   ${proof.line}`);
      continue;
    }
    /* 写盘：`fs.writeFileSync` 按字节写（**不加 BOM**）—— 规范 9.5-8⑥（会入库文本一律按字节写） */
    fs.writeFileSync(abs, res.after);
    const after = fs.readFileSync(abs);
    const byteIdentical = Buffer.compare(after, res.expected) === 0;
    if (!byteIdentical) {
      refused.push(`${file}：写入后与"按声明区间拼出来的期望字节"不等（磁盘写入未忠实）`);
      console.log(`\n[异常] ${file}：写入后与期望字节不等 ⇒ 需人工检查该文件`);
      continue;
    }
    written++; changedCount += changes.filter(c => !c.inserted).length;
    const insN = changes.filter(c => c.inserted).length;
    console.log(`\n[文件] ${file}：改数字 ${changes.length - insN} 处 ＋ 插入 ${insN} 行（另有 ${same} 个点本来一致）｜文件全长 ${res.after.length} 字节｜逐字节自证通过`);
    for (const s of summary) console.log(`   · ${s}`);
    console.log('   ' + proof.line);
  }

  console.log('\n=== --apply 汇总 ===');
  console.log(`写入文件 ${written} 个｜改数字 ${changedCount} 处｜拒写文件 ${refused.length} 个｜因真源不可比未写 ${unwritten.length} 处｜墙钟 ${Date.now() - t0} ms`);
  if (refused.length) { console.log('拒写清单（**一个字节都没写**，按 grep-first／形态／dated 口径）：'); refused.forEach((r, i) => console.log(`  ${i + 1}. ${r}`)); }
  if (unwritten.length) { console.log('因真源取不到而未写的声明点（`D20`：本轮不可比 ≠ 权威区写错）：'); unwritten.forEach((u, i) => console.log(`  ${i + 1}. ${u}`)); }
  if (refused.length || unwritten.length) {
    console.log('⇒ 未能做到"全部声明点与真源一致"：退 1（规范 9.5-5：没有证据不等于通过）。');
    process.exit(1);
  }
  console.log('⇒ 全部声明点与登记点一致（写后自证通过；建议随后跑 `node tests\\files-check.js` 与 `node tests\\docs-cross-check.js` 复核）。');
  process.exit(0);
}

/** `--list`：只读列出每个声明点（审计"覆盖面"用） */
function runList() {
  const { truth, points } = prepare();
  console.log('\n=== sync-authority --list（只读） ===');
  console.log(`声明点 ${points.length} 个｜真源：\`tests\\*.js\`=${truth.js.ok ? truth.js.value : '-'}｜离线门禁=${truth.gates.value}` +
    `｜和值=${truth.sum.ok ? truth.sum.value : '（不可比）'}｜合计=${truth.totalPassed.ok ? truth.totalPassed.value : '（不可比）'}/${truth.totalFailed.ok ? truth.totalFailed.value : '-'}/${truth.totalSkipped.ok ? truth.totalSkipped.value : '-'}`);
  for (const p of points) {
    const file = p.file;
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const lines = splitLines(text);
    const e = evaluatePoint(text, lines, p);
    const where = e.ok || (e.loc && e.loc.line) ? `${file}:${e.loc.line.no}` : `${file}:?`;
    if (!e.ok) { console.log(`  [锚点/形态] ${where}  ${p.key} —— ${e.why}`); continue; }
    const got = e.parts.map(x => `${x.label}=${x.got === null ? '（形态无此位）' : x.got}`).join('／');
    const want = e.parts.map(x => `${x.label}=${fmtPart(x)}`).join('／');
    const st = e.changes.length ? '漂移' : (e.unavailable.length ? '不可比' : '一致');
    console.log(`  [${st}] ${where}  ${p.key}${p.note ? '（' + p.note + '）' : ''}\n      当前：${got}\n      真源：${want}${e.loc.dated ? '  ⚠ dated 行' : ''}`);
  }
  for (const reg of REGISTRATIONS) {
    const text = fs.readFileSync(path.join(ROOT, reg.file), 'utf8');
    const st = registrationState(text, splitLines(text), reg);
    console.log(`  [${st.ok ? (st.registered ? '一致' : '漂移') : '锚点/形态'}] ${reg.file}:${st.line ? st.line.no : '?'}  ${reg.key}\n` +
      `      当前：${st.ok ? (st.registered ? '已登记' : '**未登记**') : st.why}\n      真源：必须有 ${JSON.stringify(reg.mustContain)}（docs-check 同一条判据）`);
  }
  process.exit(0);
}

/**
 * 入口（同步 `main()` ＋ 顶层 `try`/`catch` 退 2 —— 与 `docs-cross-check.js` 同形态，
 * 由 `harness-check` 第十六节静态守住）。
 */
function main() {
  if (hasFlag('--apply')) return runApply();
  if (hasFlag('--list')) return runList();
  return runCheck();
}

try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
