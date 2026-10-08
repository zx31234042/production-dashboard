/* ==========================================================================
   编码与文件卫生体检（tests/files-check.js）
   作用：把"文件本身没坏"这件事变成可复跑的门禁。检查四类问题：
        ① **编码损坏**：出现替换符 U+FFFD，或命中常见 mojibake 特征（PS 5.1 用 `utf8`
            写文件会加 BOM 并把中文重新编码，产生"缁/鐢/鍙"这类乱码，且**不可逆**）
        ② **BOM 用错**：`tools/*.ps1` 必须 UTF-8 **带** BOM（PROJECT_RULES 第七章）；
            其余源码/脚本必须**不带** BOM
        ③ **Tab 缩进**：`src/`、`index.html`、`server/`、`tests/` 一律 2 空格（第五章）
        ④ **临时文件泄漏**：`.tmp`、`~$*`、`*.db`、`*.db-wal`、`*.db-shm`、`._*` 不得出现在仓库里
            （测试产生的临时库必须落在 `tests/._verify/` 内，见 ADR-0003 D16）
   立案原因：2026-09-19 用 PowerShell 文本命令改 `tests/db-check.js` 时**把文件写坏且不可逆**，
             只能整文件重写。这类损坏靠肉眼看 diff 很容易漏，必须机器查。
   依赖：仅 Node 内置模块。
   运行：node tests/files-check.js
   退出码：0 = 全部干净；1 = 有问题（失败项即待修）。
   ========================================================================== */
'use strict';

/* ---------------- 入口与异常兜底（`E80③`／规范 9.5-5 第 5 条） ----------------
   本脚本是一道**门禁**，但长期没有 `main()` 声明、也没有任何异常兜底 ⇒ 两个后果：
     ① `harness-check` 第十六节只审"声明了 `main()`"的文件 ⇒ 本脚本**不在扫描面内**；
     ② 脚本自身异常时抛裸栈、进程退 **1** ⇒ `run-all` 的失败明细过滤
        （`/\[FAIL\]|失败清单|^\s+\d+\.|脚本异常终止/`）认不出它，与"有断言失败"逐字同形。
   现按既有 sync 家族（`copy-check`／`docs-cross-check`／`trace-check`／`screenshot-diff`）同形收口：
   `function main()` ＋ 顶层 `try`/`catch`，异常**打印出来**（含字面 `脚本异常终止`，供 `run-all` 命中）并退 **2**。
   **断言与条数一字未改**（本例只是把原来的顶层语句搬进 `main()`）。 */
function main() {
const fs = require('node:fs');
const path = require('node:path');

const env = require('./env');
const { createRunner } = require('./lib/assert');

env.assertRuntime();
const t = createRunner('编码与文件卫生体检（files-check）');
const ROOT = env.paths.root;

/** 需要检查编码/乱码的文本文件扩展名 */
const TEXT_EXT = new Set(['.js', '.css', '.html', '.json', '.md', '.cmd', '.ps1', '.txt', '.sql']);
/** 不进入版本库的目录（甲方原件、提取件、自检产物） */
/* 注意：这份跳过清单是**硬编码**的，不读 `.gitignore` —— 所以凡"本机专用、已 gitignore"
   的目录都必须在这里显式列出，否则漏一个就会把本机文件算进扫描数。
   `本地归档`：本机归档区（需求历史版本、函件草稿），已在 .gitignore 中，
   属本机专用、不入库，不应计入仓库卫生扫描。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', '来源文件', 'reference', '._verify', '本地归档']);
/** Tab 缩进检查范围（相对路径前缀） */
const TAB_SCOPE = ['src', 'server', 'tests', 'index.html', 'tools'];
/** 常见 mojibake 特征：PS 5.1 双重编码把中文变成"缁熶竴/鐢ㄤ緥/鍙ユ焺"这类**罕见双字组合**。
 *  为什么用双字组合而不是单字：像"閫"这种字本身是合法汉字，单字匹配会误报；
 *  且 `tests/browser-check.js` 与 `tests/files-check.js` 自身就含"乱码特征字表"，
 *  属**正当出现**，必须按文件/行排除，否则门禁会自己把自己判失败。 */
const MOJIBAKE_BIGRAMS = [
  '缁熶', '鐢ㄤ', '鍙ユ', '閫氳', '鏂囦', '鐨勶', '涓€', '璁板', '鍔犺', '鎵€',
  '娴嬭', '锛堜', '鐩戞', '鏄剧', '鍦ㄧ', '姝ｇ', '鍑虹', '鍒犻', '鏇茬', '澶囦'
];
const MOJIBAKE_RE = new RegExp(MOJIBAKE_BIGRAMS.join('|'));
/** 免检：检测器自身与浏览器脚本里有"乱码特征字"样例，属有意为之 */
const MOJIBAKE_EXEMPT = [/^tests[\\/](files-check|browser-check)\.js$/];
/** 按行免检：讨论编码问题的行会**故意引用乱码样例**（规范、记录、本文件），不能算损坏 */
const DISCUSS_LINE = /乱码|mojibake|双重编码|UTF-8|BOM|替换符|PS 5\.1|PowerShell/i;

/** 递归收集文件（跳过 SKIP_DIRS） */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), out);
    } else {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
}

const files = walk(ROOT).filter(f => TEXT_EXT.has(path.extname(f).toLowerCase()));
t.info(`扫描 ${files.length} 个文本文件（已跳过 .git / 来源文件 / reference / ._verify / 本地归档）`);

/* ---------------- 一、编码损坏 ---------------- */
t.section('一、编码损坏（替换符 / mojibake）');
const broken = [];
const mojibake = [];
const exempt = new Set();
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const buf = fs.readFileSync(f);
  let text;
  try { text = buf.toString('utf8'); } catch { broken.push(rel); continue; }
  if (text.includes('\uFFFD')) broken.push(rel);
  if (MOJIBAKE_EXEMPT.some(re => re.test(rel))) { exempt.add(rel); continue; }
  /* 按行判定：跳过"正在讨论编码问题"的行（其中会引用乱码样例作为说明） */
  const hit = text.split('\n').find(l => !DISCUSS_LINE.test(l) && MOJIBAKE_RE.test(l));
  if (hit) mojibake.push(`${rel}（${hit.trim().slice(0, 40)}…）`);
}
t.check('没有文件含替换符 U+FFFD（编码损坏的硬特征）', broken.length === 0,
  broken.length ? `损坏：${broken.slice(0, 5).join('、')}` : '');
t.check('没有文件出现 mojibake 双字乱码特征（PS 5.1 双重编码产物）', mojibake.length === 0,
  mojibake.length ? `疑似双重编码：${mojibake.slice(0, 3).join('；')}` : '');
if (exempt.size) t.info(`免检文件（含乱码样例，属有意为之）：${[...exempt].join('、')}`);

/* ---------------- 二、BOM 用法 ---------------- */
t.section('二、BOM 用法（.ps1 必须带，其余必须不带）');
const psMissingBom = [];
const wrongBom = [];
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const buf = fs.readFileSync(f);
  const isPs1 = path.extname(f).toLowerCase() === '.ps1';
  if (isPs1 && !hasBom(buf)) psMissingBom.push(rel);
  if (!isPs1 && hasBom(buf)) wrongBom.push(rel);
}
t.check('tools/*.ps1 都是 UTF-8 带 BOM（否则中文会乱码，第七章）', psMissingBom.length === 0,
  psMissingBom.join('、'));
t.check('其余文本文件都不带 BOM', wrongBom.length === 0, wrongBom.join('、'));

/* ---------------- 三、Tab 缩进 ---------------- */
t.section('三、Tab 缩进（第五章：统一 2 空格）');
const tabFiles = [];
for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (!TAB_SCOPE.some(p => rel === p || rel.startsWith(p + path.sep))) continue;
  if (/[\t]/.test(fs.readFileSync(f, 'utf8'))) tabFiles.push(rel);
}
t.check('src/、server/、tests/、index.html、tools/ 下没有 Tab 缩进', tabFiles.length === 0,
  tabFiles.join('、'));

/* ---------------- 四、临时文件泄漏 ---------------- */
t.section('四、临时文件泄漏（不得进仓库）');
const all = walk(ROOT);
const junk = all.filter(f => {
  const n = path.basename(f);
  return /\.tmp$/i.test(n) || /^~\$/.test(n) || /^\._/.test(n) ||
    /\.db(-wal|-shm)?$/i.test(n) || /^新建|副本|旧版/.test(n);
}).map(f => path.relative(ROOT, f));
t.check('仓库内没有 .tmp / ~$* / ._* / *.db / 副本类临时文件', junk.length === 0,
  junk.slice(0, 5).join('、'));

/* 测试产生的临时库必须落在 tests/._verify 之内（D16） */
/* ==========================================================================
   **散落库判据的扫描范围 —— `T-20261003-10`（2026-10-03）单一真源化后必须这样扫**
   （`E90` 的临时区定义已从 `lib\harness.js` 搬到 `tests\env.js`；改本段前先读完）
   --------------------------------------------------------------------------
   ① **定义在哪**：`tempRootBase`（公共根 `tests\._verify\tmp`）与按轮次的 `tempRoot`
      （`<base>\run-<pid>-<启动时刻>-<4hex>`）都定义在 `tests\env.js`，
      **任何**脚本 require 它都看到同一口径（不再"加载 harness 才看到本轮目录"）。
   ② **谁看到什么（本脚本的处境）**：本脚本**不加载** `lib\harness.js` ⇒ 收口**前**它看到的
      `tempRoot` 是**公共根**；收口**后**是**本轮专属子目录**（本轮目录通常**不存在**，
      因为本脚本自己不写临时区）。
      ⚠ 所以**绝不能**把下面这段写成 `readdirSync(env.paths.tempRoot)` 就完事 ——
      那会让判据变成"只扫自己那层空目录"⇒ **恒真（空洞化）**，等于把这条防线删掉。
   ③ **扫什么（"临时区的根级别"，两个层次，都不是递归）**：
        ① 公共根 `tempRootBase` 的顶层 —— 原判据的语义：散落库不得躺在公共根下；
        ② 公共根下**每个整轮目录** `run-*` 的顶层 —— 轮次隔离（`E90`）后"根"多了一层，
           他路（另一个门禁进程／另一个座位）把 `.db` 落在 `run-<pid>-…/` 顶层同样要发现。
      改动前后"实际扫到了什么"的实测（2026-10-03，`T-20261003-10`）：
        · 改动前：公共根顶层一个 `stray-probe-t1.db` ⇒ **FAIL（10 通过/1 失败，退 1）**；
          而 `run-999999-…\stray-in-run.db` ⇒ **11/0 通过（漏掉）** —— `E90` 之后真实产物
          全在 `run-…` 那一层，旧扫描面已**够不着**它们。
        · 改动后：两处都 ⇒ **FAIL 并指名文件**；正常情况下（两处都无 `.db`）仍是 11/0。
   ④ **为什么不递归到各用例自己的子目录**：用例库**按设计**就叫
      `<run-…>\<case>-…\test.db`（"各用例自有子目录"），递归会把**合法**的用例库判成散落库
      ⇒ 并发跑门禁时必然假红（`E90` 正是为消这类假红而立的）。故本判据的语义仍是
      "**临时区的根级别**不许有库文件"，只把 `E90` 新增的那一层补齐。
   ========================================================================== */
const tempRootBase = env.paths.tempRootBase;                  /* 公共根（定义在 tests\env.js） */
/** 公共根下的整轮目录名（`run-<pid>-<启动时刻>-<4hex>`）；读不到就当空（清扫可能刚把它删了） */
const tempRunDirs = (() => {
  try {
    return fs.readdirSync(tempRootBase, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^run-/.test(e.name))
      .map(e => e.name);
  } catch { return []; }
})();
/** 在"临时区根级别"（公共根顶层 ＋ 每个整轮目录顶层）找散落库文件 */
const strayDb = [];
for (const [label, dir] of [['公共根', tempRootBase],
  ...tempRunDirs.map(n => [n, path.join(tempRootBase, n)])]) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { continue; }    /* 目录可能刚被别的轮次收走 */
  for (const n of names) if (/\.db(-wal|-shm)?$/.test(n)) strayDb.push(`${label}\\${n}`);
}
t.info(`散落库扫描面：公共根顶层 ＋ ${tempRunDirs.length} 个整轮目录顶层`
  + `（共 ${1 + tempRunDirs.length} 处；**不**递归进各用例自有子目录 —— 用例库按设计就在那些子目录里）`);
t.check('临时区根目录没有散落的库文件（各用例自有子目录）', strayDb.length === 0,
  strayDb.slice(0, 3).join('、'));

/* ---------------- 五、写文件的正确姿势（防止再踩同一个坑） ---------------- */
t.section('五、防止再踩同一个坑（文档与工具约定）');
const rules = fs.readFileSync(path.join(ROOT, 'PROJECT_RULES.md'), 'utf8');
t.check('PROJECT_RULES 已写明"不要用 PowerShell 文本命令改源码文件"',
  /PowerShell.{0,30}改.{0,20}(源码|文件)|不要用 PowerShell 文本命令/.test(rules),
  '该约定是 2026-09-19 文件被写坏后的补救措施');

/* ---------------- 六、全部 .js 都能被解析 ----------------
   立案原因（2026-09-19）：在 JSDoc 块注释里嵌了一个 `/* … *\/` 式注释，其中的 `*\/`
   提前闭合了外层注释，整个模块变成语法错误。当时**只有恰好 require 到它的用例才会炸**，
   其它用例照样"看起来正常"。这里对每个 .js 跑一次 `node --check`，
   让这类自伤立刻暴露，而不依赖"谁碰巧引用了它"。 */
t.section('六、全部 .js 语法可解析（防"注释把模块写坏"这类自伤）');
const jsFiles = all.filter(f => f.endsWith('.js'));
const brokenJs = [];
for (const f of jsFiles) {
  const r = require('node:child_process').spawnSync(process.execPath, ['--check', f],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  if (r.status !== 0) brokenJs.push(path.relative(ROOT, f));
}
t.check(`全部 ${jsFiles.length} 个 .js 文件可被 node 解析`,
  brokenJs.length === 0, brokenJs.slice(0, 5).join('、'));

/* ---------------- 七、静态防空洞断言（ADR-0004 D23） ----------------
   立案原因（ADR-0004）：修复轮里出现过"把前提写成普通断言"导致的**空洞断言**风险 ——
   一旦前提不再成立，那条断言要么恒假、要么被顺手放宽成恒真，而**两者从输出上都看不出来**。
   这里做静态检查：把 `check()` 的**第二个实参**（判定表达式）抽出来，
   只报"注定恒真/恒假"的形态 —— 确证的算 FAIL，仅可疑的只提示（避免制造假失败）。

   边界（务必守住）：像 `x === 0`、`x === ''` 这种**单侧字面量比较是合法边界断言**，
   不得报；只有**两侧都是字面量**、或整个判定就是字面量 `true/false` 时才可疑。 */

/** 从位置 i 开始，取出以 open 开头、到配对括号结束的完整片段 */
function sliceBalanced(src, i, open = '(', close = ')') {
  if (src[i] !== open) return null;
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(i, k + 1); }
    else if (c === "'" || c === '"' || c === '`') {           // 跳过字符串字面量
      const q = c;
      k++;
      while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++; }
    }
  }
  return null;
}

/** 在顶层逗号处切分实参列表 */
function splitArgs(argSrc) {
  const inner = argSrc.slice(1, -1);
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k];
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      cur += c; k++;
      while (k < inner.length && inner[k] !== q) { cur += inner[k]; if (inner[k] === '\\') { k++; cur += inner[k]; } k++; }
      cur += q;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(s => s.trim());
}

/** 去掉字符串与模板串（模板串里的 ${...} 视为**非字面量**，替换为 NAME 标记） */
function stripStrings(src) {
  let out = '';
  for (let k = 0; k < src.length; k++) {
    const c = src[k];
    if (c === "'" || c === '"') {
      k++;
      while (k < src.length && src[k] !== c) { if (src[k] === '\\') k++; k++; }
      out += ' LIT ';
      continue;
    }
    if (c === '`') {
      k++;
      let hasSub = false;
      while (k < src.length && src[k] !== '`') {
        if (src[k] === '\\') { k++; k++; continue; }
        if (src[k] === '$' && src[k + 1] === '{') { hasSub = true; let d = 1; k += 2; while (k < src.length && d > 0) { if (src[k] === '{') d++; if (src[k] === '}') d--; k++; } k--; }
        k++;
      }
      out += hasSub ? ' NAME ' : ' LIT ';   // 含插值的模板串不是字面量
      continue;
    }
    out += c;
  }
  return out;
}

/** 判定表达式是否"注定恒真/恒假"：两侧都是字面量，或整段就是字面量 */
function isVacuous(expr, hasReason) {
  if (!expr) return null;
  const e = stripStrings(expr).replace(/\s+/g, ' ').trim();
  /* 裸 `true`：与任何实现无关地恒真 —— 最典型的空洞断言 */
  if (e === 'true' || e === '!false') return `判定恒为 true（与任何实现无关）`;
  /* 裸 `false`：**带原因**时是"无条件判失败"的正当写法（如"空候选必须失败"），
     带原因说明作者是故意的；不带任何原因才是疑似空占位。 */
  if (e === 'false' || e === '!true') {
    return hasReason ? null : '判定恒为 false 且未给出原因（疑似未完成的占位断言）';
  }
  /* 两侧都是字面量。
     不报**单侧**字面量 —— `x === 0`、`ok === false`、`count < 10` 都是合法边界断言，
     误报会制造假失败（ADR-0004 D23 明确要求区分"确证"与"可疑"）。
     会报的是"两侧都恒定"的式子，如 `1 + 1 === 2`（算术常量折叠后仍是常量比较）。 */
  const LIT = "(?:true|false|null|undefined|NaN|LIT|\\d+(?:\\.\\d+)?|(?:\\d+(?:\\.\\d+)?\\s*[+\\-*/]\\s*)+\\d+(?:\\.\\d+)?)";
  const cmp = new RegExp(`^${LIT}\\s*(===|!==|==|!=|<=|>=|<|>)\\s*${LIT}$`);
  if (cmp.test(e)) return `两侧都是字面量：${e}`;
  /* 与字面量 true/false 做逻辑运算：该侧恒定，等价于削弱（甚至取消）这条断言 */
  if (/^(?:true|false)\s*(?:&&|\|\|)/.test(e) || /(?:&&|\|\|)\s*(?:true|false)$/.test(e)) {
    return `与字面量做逻辑运算：${e}`;
  }
  return null;
}

const vacuous = [];
const suspicious = [];
for (const f of jsFiles) {
  const rel = path.relative(ROOT, f);
  if (rel === path.join('tests', 'files-check.js')) continue;   // 本文件含"字面量样例"，跳过
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  let idx = -1;
  while ((idx = src.indexOf('check(', idx + 1)) >= 0) {
    /* 排除定义处与方法名后缀（如 `.check(`）以外的误命中：要求前一个非空白字符不是字母数字 */
    const prev = src.slice(0, idx).trimEnd().slice(-1);
    if (/[\w$.]/.test(prev)) continue;
    const argSrc = sliceBalanced(src, idx + 'check'.length);
    if (!argSrc) continue;
    const lineNo = src.slice(0, idx).split('\n').length;
    let args;
    try { args = splitArgs(argSrc); } catch { continue; }
    if (args.length < 2) continue;                    // 形态异常（如跨文件拼接），交给语法/运行门禁
    const reason = isVacuous(args[1], args.length >= 3 && args[2] !== "''" && args[2] !== '""');
    if (reason) vacuous.push(`${rel}:${lineNo} —— ${reason}`);
    /* 仅提示：判定里出现 `=== true` / `!== false` 这类冗余写法（不是错，但易掩盖意图） */
    if (/===\s*true\b|!==\s*false\b/.test(args[1])) suspicious.push(`${rel}:${lineNo}`);
  }
  void lines;
}
t.check('没有"注定恒真/恒假"的断言（两侧字面量比较、判定即 true/false、占位未删）',
  vacuous.length === 0, vacuous.slice(0, 5).join('；'));
if (suspicious.length) {
  t.info(`提示（非失败）：${suspicious.length} 处断言使用 \`=== true\` / \`!== false\` 冗余写法：${suspicious.slice(0, 5).join('、')}`);
}

/* ---------------- 八、每个门禁脚本都必须校验运行时环境（P2-13，D16） ----------------
   立案原因：`env.assertRuntime()` 原本只被 6 个脚本调用 —— `DSH_ENV=prod node tests\ui-check.js`
   照跑并"通过 40 项"退出码 0，等于 D16"测试进程绝不允许指向生产数据目录"在 8 个脚本里失效。
   这条静态断言把"每个 tests\*.js 都要校验"钉住，避免以后新增脚本又漏掉。
   **豁免**：`env.js` 自身（它实现校验）、`preflight.js`（它**故意**把环境问题报成检查项，
   而不是自己先退 2 —— 理由写在该文件第一节注释里）。
   **范围**：只看 `tests\` **直下**的入口脚本；`tests\lib\` 下的夹具层是被 require 的模块
   （由宿主脚本负责校验），逐个要求它们自校验既无意义也会造成假失败。 */
const noRuntimeCheck = [];
for (const f of jsFiles) {
  const rel = path.relative(ROOT, f);
  const dir = path.dirname(rel);
  if (dir !== 'tests') continue;                       // 只查 tests\ 直下
  const base = path.basename(rel);
  if (base === 'env.js' || base === 'preflight.js') continue;
  if (!/assertRuntime\(\)/.test(fs.readFileSync(f, 'utf8'))) noRuntimeCheck.push(rel);
}
t.check('每个 tests\\*.js 入口脚本都调用 env.assertRuntime()（D16 的 prod 拒绝不漏脚本）',
  noRuntimeCheck.length === 0, noRuntimeCheck.join('、'));

/* ==========================================================================
   九、受管面编码卫生（`E40` 的机器守据；`T-20261005-01` 甲）
   --------------------------------------------------------------------------
   立案原因（`E40`，★★★，2026-10-04 **一天之内 4 起同一根因**）：
     ① `Set-Content -Encoding utf8` 给 `tests\trace-check.js` **加 BOM**；
     ② 内联 `node -e` 的反引号被 PowerShell 吃掉；
     ③ `Set-Content` 吞掉多字节字符；
     ④ 4b 自己用 `(Get-Content -Raw) -replace … | Set-Content -Encoding utf8` 改
        `harness-check.js` ⇒ PowerShell 按**系统 ANSI（cp936）**读 UTF-8 ⇒ 中文段
        全乱（**7064 个字符落进 PUA 区**、逆推 4 次不完整）。
   共同根因：**用"文本命令"改源码/台账**。而本条最危险的地方是"**检测不到**"——
   `E40` 原文实测：那次损坏后 `U+FFFD` 计数仍为 **0**、当时的 `files-check` 乱码
   特征**查不出来**，于是**门禁全绿而源码已经坏了**。所以本节的落点是：把"编码
   干净"本身变成**可复跑、能指名、能被植入自证**的判据，而不是靠肉眼看 diff。

   ── 为什么"看起来干净"不等于"编码干净"（**四类各自的静默后果**）──
   · **BOM（`EF BB BF`）**：源码/文档首部多出 3 个**不可见**字节。Node 照跑、
     编辑器看着正常、语法照过 ⇒ **没有任何症状**；但它是**行首锚点杀手**：
     `/^#!/`、`/^---/`、`/^#\s/`、`/^\|/` 这类匹配**全部失配**，`git diff` 首行
     才显形，外部工具会把 BOM 当正文 ⇒ **判据静默失效比报错更坏**。
     （`tools\*.ps1` 反过来**必须**带 BOM —— 第七章；故本节对 `.ps1` 免判，
      那一面由第二节守着。这是本判据唯一的例外，且例外本身有门禁。）
   · **`U+FFFD`（替换符）**：**不可逆** —— 原始字节已经丢了，只留下"这里曾经有
     个我不认识的字节"的墓碑。此后任何比较、哈希、溯源都**永久失真**，而文本
     仍然"是合法 UTF-8、能编译、能显示" ⇒ 损失只会在几个月后某次复核时暴露。
   · **PUA 区（`U+E000`–`U+F8FF`）**：这是"**UTF-8 字节被按 GBK/cp936 解码**"的
     **特征残留** —— cp936 把若干双字节区段映射到私用区，屏幕上多半显示成方块/
     空白/异体字，**像排版问题而不像数据损坏**，最容易被当"显示问题"放过；
     而它一旦进了源码，`===` 比较、正则字符类、台账锚点会**静默不匹配**。
   · **行尾混合（同一文件既 CRLF 又裸 LF）**：逐行工具（`split('\n')` 后比对、
     按行切片替换台账）处理带 `\r` 的行时会**多带一个不可见字符** ⇒ 逐字比对失败、
     替换串被污染；更坏的是**部分匹配**：一半行匹配、一半不匹配 ⇒ "改了一半"
     看起来像"改完了"。**文件末尾缺行尾**则让"追加一行"与**末行粘连** ——
     `E164` 那次事故就是 `join(/\r?\n/)` 把整份台账粘成 1 行（内容守恒、结构全毁），
     而门禁只认子串 ⇒ **照绿**。
   ⇒ 一句话：**这四类都不会让程序报错，只会让"判据"悄悄失效**，而"判据失效"从
      输出上看与"一切都好"**逐字同形**。这正是 `E40` 被评 ★★★ 的原因。

   ── 扫描面与分面口径 ──
   受管面 ＝ 第一节的 `files`（`src\`／`server\`／`platform\`／`tests\`／`tools\`／
   `*.md`，已排除 `.git`／`node_modules`／`._verify`／`来源文件`／`reference`／
   `本地归档`）。`tests\._verify\` **单列一面**：它是探针/取证/临时产物区，按
   `ADR-0003` D16 与既定裁定**不判红**（含 2 个已裁定的内容损坏件，保持原样不修），
   但必须**可见**（`E40` 的"如实列出"）。故：
     · 四类**损坏特征**（BOM／FFFD／PUA／无损 GBK 乱码）对受管面**零容忍**；
     · `._verify` 面**报数＋名单**，另加一条"该面确实被扫到"的反装饰判据。

   ── "无损 GBK 乱码"判据的依据与实测（勿凭直觉改窄/改宽）──
   `E40` 的形态是"UTF-8 字节被按 cp936 解码后另存"。它的**精确逆运算**是：把候选
   文本的每个字符按 cp936 **编回双字节**（ASCII 原样出字节、`U+20AC`→`0x80`），
   再按 **UTF-8 严格解码**（`fatal: true`）；能还原成"**含汉字**的合法文本"即为乱码。
   2026-10-05 用 `tests\._verify\t2-e40\` 的三个探针实测（读数见回执）：
     · cp936 可逆码位 **23939** 个（来自 23940 个合法双字节），**多义码位仅 1 个**
       ⇒ 逆推几乎无歧义；
     · **只要求"逆推成功"会假红**：`tests\screenshot-diff.js:11` 的 `<目录>`
       （同一行出现两次）逆推得 4 个拉丁扩展字符，恰好凑够阈值 ⇒ 故判据收紧为
       "**逆推结果里必须有汉字**（`U+4E00`–`U+9FFF`）"；依据是真乱码的原始字节
       是 UTF-8 **三字节 CJK 序列**，逆推后必然是汉字；收紧后受管面 **86749 行
       假红 0 处**；
     · 它**只补**另外两条判据够不着的那一档：5114 行"事故模拟"里约 **97%** 会落出
       `U+FFFD` 或 PUA（由上面两条抓），剩下 **164 行无损**（既无 FFFD 也无 PUA）
       **全部**被本判据抓住（100%）；
     · `tests\._verify\t16-e141\probe-survey.js`（既定的 GBK 乱码件）**不由本判据抓**
       （它含 `?` 丢失字节、不可逆推），而由 **PUA 判据**抓（PUA＝12）⇒ 两条判据
       分工互补，**都必须在**。
   保守取向：整行逆推、不做"部分行"猜测 ⇒ **宁可漏报，不误报整仓**。

   ── 行尾两类为什么是"登记 ＋ 反漂移"而不是"零容忍"（**实测现状，须留痕**）──
   **带门禁实测（`T-20261005-03`，权威读数）**：混行尾 **2** 处、末尾缺行尾 **6** 处；
   其中 **2 处**（`tests\lib\assert.js`、`tests\logic-check.js`）本轮按裁定补齐末行尾，
   余 **4 处**落在**明令禁改**的面（`项目记录\*`／`输出文件\*`，历史记录与已交付件
   不改字节）。若写成"必须为空"，本条会**永久红且本轮无权清** ⇒ 判据必然
   被当噪声忽略（这正是 `E149`/`E151` 说的"装饰性守护"的反面教材）。
   ⚠ **与一次性探针的差异（勿沿用探针数字）**：更早的一次性探针报"缺行尾 5 处"，
   漏掉 `输出文件\离线部署与体检包-V1.4\体检-双击运行.cmd` —— 它只扫 `*.md`，
   非 `.md` 的交付产物没进面。**这正是"门禁比一次性探针更可信"的实例**，
   故本节一切数字以带门禁实测为准（下面基线行内亦有同样留痕）。
   本轮（`T-20261005-03` 甲）**只清** `tests\lib\assert.js` 与 `tests\logic-check.js`
   两处（纯补末行尾、零语义变化）⇒ 缺末行尾 **6 → 4**。
   故改为 **fail-closed 的登记制**：当前集合必须**恰等于**登记集合 ——
   **多一个 ⇒ 判红并指名**（新漂移必被抓）；**少一个 ⇒ 也判红并报"名单陈旧"**
   （名单只能缩小，不许悄悄留着）。两个方向都可证伪，不存在"静默放过"。
   ⚠ 与任务包表述的**实测差异**（如实留痕，不改判据迎合）：任务包写"受管面现在
     各类违规均为 0"；实测**四类损坏特征确为 0**，但**行尾惯例有偏差 8 处**
     （2 混行尾 ＋ 6 缺末行尾；补齐后为 2 ＋ 4），已逐条登记在下面的两个基线里。

   ── D22（可证伪）──
   每类判据各在**内存字节副本**上植入 1 处，复核四件事：①判据必红；②**指名到
   `文件:行号`**；③未变异的当前源码同判据必绿（排除"本来就红"）；④盘上文件
   **全程逐字节未变**（`Buffer.equals`）⇒ 无残留可清（`残留＝[]`）。

   ── ⚠ 行尾基线的"基线陈旧"分支 == **预期形态**之一（`T-20261005-03` 实测；改名单前先读这段）──
   **机制**：`git add`／提交会按 `core.autocrlf` **规整工作区文件的行尾** ⇒ 某个原登记为
   "混行尾／缺末行尾"的文件可能在**没有任何人手工编辑它**的情况下变成正常 ⇒ `E40-⑤`／`E40-⑥`
   会走"**基线陈旧**"分支判红。**这是预期的**，按 `9.5-5` 的 **v1.34 勘误**处理：
   比对前先归一化、"某处不再偏差"**不等于**"结论作废" ⇒ 处置永远是**把该条从名单里删掉**
   （名单只能缩小），**不是**把它塞回去、**更不是**把判据放宽。
   今天（2026-10-05）的实例：`项目记录\工作日志.md` 的混行尾被规整没了
   （实测 `CRLF 1095 ／ 裸 LF 840` → **0 处混行尾**）⇒ 混行尾基线 **2 → 1**。
   **这是该勘误的第二个实例**（第一个＝`db28fbc` 之后三个文件的哈希漂移）。
   ⚠ **收尾（2026-10-06 由 `T-20261006-07` 核清并更正）**：同一机制随后把**最后一条** `项目记录/ADR/README.md` 也规整成纯 CRLF ⇒ 链条是 **2 → 1 → 0**（详见 `EOL_MIXED_BASELINE` 的注释，那儿是它的归属地）。
   分辨口径：**"提交规整了行尾"＝正常（删名单条目）**；**"有人把文件又改回混行尾"＝真漂移（多一个分支，判红）**。
   ========================================================================== */
t.section('九、受管面编码卫生（E40：文本命令改文件会静默吞多字节字符）');
{
  /* ---- 九之一：扫描器 ---- */
  /** 受管面 ＝ 第一节的 files（已排除 `._verify` 与"不入库目录"） */
  const MANAGED = files;
  /** `._verify` 面：单列，只报不判。读失败必须容错 —— 并发座位会**独占锁住**里面的
   *  文件（2026-10-05 实测 `EBUSY`：`T-20261005-02` 的锁测试正在跑）⇒ 硬读会让
   *  本门禁在"别的座位干活时"随机崩，那是最坏的一种假红。 */
  const VERIFY_DIR = path.join(ROOT, 'tests', '._verify');
  const VERIFY = [];
  (function collectVerify(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collectVerify(p);
      else if (TEXT_EXT.has(path.extname(p).toLowerCase())) VERIFY.push(p);
    }
  })(VERIFY_DIR);

  /** 统一的仓库相对路径（正斜杠 —— 台账与回执里都用这一种写法） */
  const relOf = abs => path.relative(ROOT, abs).split(path.sep).join('/');

  /** cp936 逆推表：codepoint -> 双字节（`U+20AC` 例外：来自**单字节** `0x80`）。
   *  `TextDecoder('gbk')` 依赖完整 ICU；环境不支持时返回 null，本判据记 SKIP
   *  （**不是** PASS —— "跳过 ≠ 通过"，见 `tests\README.md` 5.3 节口径）。 */
  const GBK_REVERSE = (() => {
    try {
      const dec = new TextDecoder('gbk');
      const m = new Map();
      for (let b1 = 0x81; b1 <= 0xFE; b1++) {
        for (let b2 = 0x40; b2 <= 0xFE; b2++) {
          if (b2 === 0x7F) continue;
          const s = dec.decode(Buffer.from([b1, b2]));
          if (s.length !== 1 || s.charCodeAt(0) === 0xFFFD) continue;
          if (!m.has(s.charCodeAt(0))) m.set(s.charCodeAt(0), [b1, b2]);
        }
      }
      m.set(0x20AC, [0x80]);
      return m;
    } catch { return null; }
  })();

  /** 把一行当作"cp936 解码产物"逆推成原始 UTF-8 文本；不可逆返 null */
  function gbkReverse(text) {
    const bytes = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) { bytes.push(cp); continue; }
      const pair = GBK_REVERSE.get(cp);
      if (!pair) return null;                       /* 含 U+FFFD 的行必然走到这里 */
      for (const b of pair) bytes.push(b);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes)); }
    catch { return null; }
  }

  /** 一行是否命中"无损 GBK 乱码"判据（依据见本节头部注释） */
  function isMojibakeLine(line) {
    if (!GBK_REVERSE) return false;
    if ((line.match(/[^\x00-\x7F]/g) || []).length < 4) return false;
    const back = gbkReverse(line);
    if (back === null) return false;
    if ((back.match(/[^\x00-\x7F]/g) || []).length < 4) return false;
    return /[\u4E00-\u9FFF]/.test(back);            /* 逆推结果里必须有汉字 */
  }

  /** 行尾统计（`crlf`／裸 `LF`／是否有末行尾） */
  function eolStat(buf) {
    let crlf = 0; let bareLf = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 10) { if (buf[i - 1] === 13) crlf++; else bareLf++; }
    }
    return { crlf, bareLf, endsNl: buf.length > 0 && buf[buf.length - 1] === 10 };
  }

  /* ==================== `E192` ②（★★）：`项目记录/ADR/` 的「必须纯 CRLF」 ====================
     立案事实（`E192`，2026-10-06）：`项目记录\ADR\README.md` 的**维护规则句**逐字要求"**编码：
     UTF-8（无 BOM），换行 CRLF**，与 `项目记录\` 其余文档一致"，而实测 `ADR-0005`（CRLF=0／LF=82）
     与 `ADR-0009`（CRLF=0／LF=88）是**纯 LF** ⇒ **目录自订的行尾规则与实情分叉，且没有任何机器判据
     看着它**（`E40` 家族只查"混行尾／缺末行尾"，这两条对"纯 LF"**恰好都不响**）。
     本条把那条**声明**变成判据，口径＝ `CRLF > 0 ∧ 裸 LF == 0 ∧ 无 BOM`：
       · **不写"无混行尾"这种更弱的说法** —— "无混行尾"对**纯 LF** 恰好为真，而纯 LF 正是立案事实本身；
       · 判据面只认这个目录的 `.md`（目录规则第 10 行"本目录**只放 `.md`**"），违规时**逐处指名
         `文件（行尾形态：纯 LF／混行尾／带 BOM／无行尾）`**；
       · **防装饰性守护**（`E174` 同族）：光有"违规桶为空"可以被"把目录改名／移出扫描面"变成**恒真**
         ⇒ 另记 `crlfDirFiles`（该目录**被扫到**几个 `.md`），判据要求它**恰等于盘上实有 `.md` 数**
         （**动态取**，不写死常量 —— `ADR-0004` D21）。
     ⚠ **不许另开第二份 EOL 判据脚本**（规范 9.5-7 唯一入口／单一真源；`E57` 的刹车）：就地扩 E40 家族。
     ⚠ 本条的"规则真源"（那句声明）由下面 **`E40-⑨·声明锚点`** 一并守着：规则句被改动 ⇒ 判红。
     ⚠⚠ **本条的说明故意写在这里、不写进"第九节头部注释块"**：那一整段在 `stripLiterals()` 之后是
       一条**连续的空白段**，而 `harness-check` 的 **`E160-④`** 把"受管面除超标外最长空白段"**锚死**
       在 **105 行**（`managedMaxRunLinesExcludingOver`，属**别的脚本的冻结锚点**、本包无权改）——
       2026-10-06 本包首版往里加了 9 行 ⇒ 实测 **116 行** ⇒ `E160-④` 当场红（真红、非抖动）。
       要补说明**请写在这一段里**（或判据旁边），**别再往第九节头部注释块里加行**。 */
  /** 受判目录（相对路径，正斜杠 —— 与 `relOf` 同口径）。**唯一真源**：判据、D22、自证都从这里取。 */
  const ADR_CRLF_DIR = '项目记录/ADR';
  /** 该目录下的**受判成员**：**直属** `.md`（只认直属 ⇒ 与 `readdirSync` 同层，两个计数才可比）。 */
  function isAdrCrlfMember(rel, abs) {
    if (path.extname(abs).toLowerCase() !== '.md') return false;
    if (!rel.startsWith(ADR_CRLF_DIR + '/')) return false;
    return rel.slice(ADR_CRLF_DIR.length + 1).indexOf('/') < 0;
  }
  /** 「必须纯 CRLF」的判定：合规 ⇔ `CRLF > 0 ∧ 裸 LF == 0 ∧ 无 BOM`。
   *  合规 ⇒ `null`；不合规 ⇒ 返回**逐处指名**用的 `文件（行尾形态：…）`（形态口径写死，见上）。 */
  function crlfRequiredViolation(rel, buf) {
    const e = eolStat(buf);
    const bom = hasBom(buf);
    if (e.crlf > 0 && e.bareLf === 0 && !bom) return null;
    const form = e.crlf > 0
      ? (e.bareLf > 0 ? `混行尾 CRLF=${e.crlf}／裸LF=${e.bareLf}` : `纯CRLF CRLF=${e.crlf}`)
      : (e.bareLf > 0 ? `纯LF CRLF=0／裸LF=${e.bareLf}` : '无行尾（既无 CRLF 也无裸 LF）');
    return `${rel}（行尾形态：${form}${bom ? '；且带 BOM' : ''}）`;
  }

  /** 逐行类命中最多收这么多条（真值另记 `counts`）—— 防"一个 80545 行的日志把内存吃掉" */
  /* ==================== `E186`（★★）：**文件中部**的格式字符 ====================
     立案原因：源码注释里混着**零宽字符**（`U+200B` 等）⇒ 把它当"锚点"会"命中 0 次"或
     "多匹配一大段"（2026-10-05 座位 3 在 `T-20261005-30` 实测踩到 3 次）。而本文件原来的
     `E40` 家族只抓 **BOM（仅文件首 3 字节）**／`U+FFFD`／PUA／无损 GBK 乱码／混行尾／缺末行尾
     ⇒ **文件中部**的 `U+200B`／`U+200C`／`U+200D`／`U+200E`／`U+200F`／`U+2028`–`U+202E`
     ／非首字符的 `U+FEFF` **一律漏过** ✗（它们全在 ASCII 之外、却**既不是** `U+FFFD`、
     **也不在** PUA 区，视觉上与"一切都好"逐字同形 —— 与 `E40` 同一种"看不见的损坏"）。
     ⚠ **不许把合法的全角/中文标点当格式字符**：下面的集合**逐码位写死**，只有 13 个码位；
     `U+2026`（…）／`U+2014`（—）／`U+201C`／`U+201D`／`U+3000`／`U+FF0C`（，）等**一律不在**其中。
     判据面：受管面**零容忍**（落成 `E40-⑤`／`E40-⑥` 同款的 **fail-closed 登记制** —— 见
     `MIDFILE_FORMAT_BASELINE` 的注释说明"为什么基线不是空集"）；`._verify` 面**只报不判**。 */
  /** 中部格式字符的**唯一真源**（码位 → 人读名）。判据与 D22 都从它取，不许各写一份。 */
  const MIDFILE_FORMAT = new Map([
    [0x200B, 'U+200B ZWSP 零宽空格'],
    [0x200C, 'U+200C ZWNJ 零宽非连接符'],
    [0x200D, 'U+200D ZWJ 零宽连接符'],
    [0x200E, 'U+200E LRM 从左到右标记'],
    [0x200F, 'U+200F RLM 从右到左标记'],
    [0x2028, 'U+2028 LS 行分隔符'],
    [0x2029, 'U+2029 PS 段分隔符'],
    [0x202A, 'U+202A LRE 左到右嵌入'],
    [0x202B, 'U+202B RLE 右到左嵌入'],
    [0x202C, 'U+202C PDF 定向格式终止'],
    [0x202D, 'U+202D LRO 左到右覆盖'],
    [0x202E, 'U+202E RLO 右到左覆盖'],
    [0xFEFF, 'U+FEFF ZWNBSP 零宽不换行空格（**非首字符**）']
  ]);
  /* 判据正则**全部用 `\uXXXX` 转义构造**（不用原字符写字面量）⇒ 本文件自身的字节里
     一个格式字符都不含 —— 否则"检测器把自己判红"（`E40-④` 首版踩过的同款坑）。
     `[\u200B-\u200F]` 恰＝200B..200F；`[\u2028-\u202E]` 恰＝2028..202E；`\uFEFF` 单列。 */
  const MIDFILE_TEST_RE = new RegExp('[\\u200B-\\u200F\\u2028-\\u202E\\uFEFF]');
  const MIDFILE_MARK_RE = new RegExp('[\\u200B-\\u200F\\u2028-\\u202E\\uFEFF]', 'g');

  const HY_CAP = 200;
  /** 扫一组文件。`readOf(abs)` 提供字节 —— D22 靠它注入**内存变异体**，盘上不动。
   *  返回各判据的命中清单（逐行类截断到 `HY_CAP`）＋ **真实条数** `counts`。 */
  function scanHygiene(list, readOf = f => fs.readFileSync(f)) {
    const out = { bom: [], bomPs1: [], fffd: [], pua: [], mixed: [], noEol: [], moji: [], format: [], crlfDir: [], unreadable: [],
      counts: { files: list.length, bom: 0, bomPs1: 0, fffd: 0, pua: 0, mixed: 0, noEol: 0, moji: 0, format: 0, crlfDir: 0, crlfDirFiles: 0, unreadable: 0 } };
    const add = (arr, key, item) => { out.counts[key]++; if (arr.length < HY_CAP) arr.push(item); };
    for (const abs of list) {
      const rel = relOf(abs);
      let buf;
      try { buf = readOf(abs); } catch (err) { add(out.unreadable, 'unreadable', `${rel}（${err.code || err.message}）`); continue; }
      /* BOM：`.ps1` 是**唯一**例外（第七章要求它带 BOM，由第二节判）。两桶分开记 ——
         `.ps1` 的 BOM 是**规定**、不是偏差；混在一桶里报会让人读成"受管面有 N 个 BOM 缺陷"。 */
      if (hasBom(buf)) {
        if (path.extname(abs).toLowerCase() === '.ps1') { out.counts.bomPs1++; out.bomPs1.push(rel); }
        else add(out.bom, 'bom', rel);
      }
      const text = buf.toString('utf8');
      if (text.length) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (!/[\u0080-\uFFFF]/.test(l)) continue;   /* 纯 ASCII 行：三类都不可能命中（快速跳过） */
          if (l.includes('\uFFFD')) add(out.fffd, 'fffd', `${rel}:${i + 1}`);
          if (/[\uE000-\uF8FF]/.test(l)) add(out.pua, 'pua', `${rel}:${i + 1}`);
          if (isMojibakeLine(l)) add(out.moji, 'moji', `${rel}:${i + 1}`);
          /* `E186`：**文件中部**的格式字符 —— **逐处指名 `文件:行:列`**。
             列 ＝ 该行内第几个**字符**（1-based，按 Unicode 码点计；不用字节偏移、也不用
             UTF-16 下标 —— 两种口径在含火星文的行上会不一致，故这里写死"按码点"）。
             文件**首字符**的 `U+FEFF` 就是 BOM 本身（归 `E40-①` 管），故只在 `i === 0 &&
             m.index === 0 && 该文件确实以 BOM 开头` 时跳过；紧随其后的第二个 `U+FEFF` 仍判红。 */
          if (MIDFILE_TEST_RE.test(l)) {
            MIDFILE_MARK_RE.lastIndex = 0;
            for (let m = MIDFILE_MARK_RE.exec(l); m; m = MIDFILE_MARK_RE.exec(l)) {
              if (i === 0 && m.index === 0 && hasBom(buf)) continue;
              const cp = l.codePointAt(m.index);
              const col = [...l.slice(0, m.index)].length + 1;
              out.counts.format++;
              out.format.push(`${rel}:${i + 1}:${col}（${MIDFILE_FORMAT.get(cp)}）`);
            }
          }
        }
      }
      const e = eolStat(buf);
      if (e.crlf > 0 && e.bareLf > 0) {
        out.counts.mixed++;
        out.mixed.push({ rel, crlf: e.crlf, bareLf: e.bareLf });   /* 行尾类不截断：集合要比对 */
      }
      if (!e.endsNl) { out.counts.noEol++; out.noEol.push(rel); }
      /* `E192` ②：`项目记录\ADR\` 下**每个 `.md`** 必须**纯 CRLF**。`crlfDirFiles` 同时记下
         "该目录被扫到几个 `.md`" —— 它是这条判据的**正向自证**（见本节头部：空基线下
         `removed` 分支不可达，没有这个计数就只剩"恒空 ⇒ 恒绿"的装饰性守护）。 */
      if (isAdrCrlfMember(rel, abs)) {
        out.counts.crlfDirFiles++;
        const v = crlfRequiredViolation(rel, buf);
        if (v) add(out.crlfDir, 'crlfDir', v);
      }
    }
    return out;
  }

  /** 集合的双向差：`added`＝新增漂移；`removed`＝"名单陈旧"（已修好但没从基线里删） */
  function setDiff(current, baseline) {
    const cur = new Set(current); const base = new Set(baseline);
    return { added: [...cur].filter(x => !base.has(x)).sort(), removed: [...base].filter(x => !cur.has(x)).sort() };
  }

  /** 名册打印（超过 `cap` 只报前 `cap` 个 ＋ 余数，防日志被 80000 行淹掉） */
  function listNames(arr, cap) {
    if (!arr.length) return '（无）';
    if (!cap || arr.length <= cap) return arr.join('、');
    return `${arr.slice(0, cap).join('、')}、…（另 ${arr.length - cap} 个）`;
  }

  /** 把名册折成每行 `per` 个 —— `._verify` 的 BOM 名单要**列全**（E40 的"如实列出"），
   *  但一条横排 64 个名字会没法读，故按行折。 */
  function wrapNames(arr, per) {
    const outLines = [];
    for (let i = 0; i < arr.length; i += per) outLines.push(arr.slice(i, i + per).join('、'));
    return outLines;
  }

  const managedScan = scanHygiene(MANAGED);
  const verifyScan = scanHygiene(VERIFY);
  t.info(`受管面 ${managedScan.counts.files} 个文本文件（四类损坏特征零容忍）；`
    + `\`._verify\` 面 ${verifyScan.counts.files} 个（只报不判；读不到 ${verifyScan.counts.unreadable} 个）`);

  /* ---- 九之二：行尾惯例的**登记基线**（依据见本节头部注释） ---- */
  /** 混行尾（同一文件既 CRLF 又裸 LF）的既存偏差 —— **现为 0 处**（基线＝**空集**）。
   *  ⚠ **2026-10-06 更正（`T-20261006-07`）：本条注释此前写的是"**1 处**，在 `项目记录\ADR\*`（禁改面）"，
   *  那描述的是**已被取代的中间状态**，与同一段下方的 `= []` **自相矛盾**；按 `E174`／ADR-0004 D23 的
   *  同族口径（**不许留一个"看起来在守"的空基线**）如实更正如下。**
   *  **逐版溯源（`git show <rev>:tests/files-check.js` 实测，权威）**：
   *   · `c534616`（`E40` 落地首版）＝ **2 处**：`项目记录/ADR/README.md` ＋ `项目记录/工作日志.md`；
   *   · `d152f01` 后＝ **1 处**：`项目记录/工作日志.md` 被提交规整掉（口径见下面那段 9.5-5 v1.34 勘误）；
   *   · `dc433b8` 起＝ **`EOL_MIXED_BASELINE = []`**：最后一条 `项目记录/ADR/README.md`
   *     **也归零**（同一个机制：`git add`／提交按 `core.autocrlf` 规整工作区行尾），条目随之**删除**；
   *   · `7b01ef9`／`HEAD` 沿用 `[]`（**但上面的注释一直停在"1 处"那一版 ⇒ 就是这次更正的对象**）。
   *  ⇒ **它指的是哪个文件/哪种形态**：指 `项目记录/ADR/README.md`（ADR **目录自己的 README**，
   *  即本批 `E192` 要守的那个目录）**在 2026-10-05 前后曾是"同一文件既有 CRLF 又有裸 LF"**；
   *  **不是**别的目录，**也不是** `ADR-0005`／`ADR-0009`（那两份从头到尾是**纯 LF**，从不"混行尾"）。
   *  **2026-10-06 复测（本包，逐文件扫受管面 162 个文本文件）**：混行尾 **0 处**（`[]`，与盘上实存集合
   *  逐项相同）⇒ 该条目**已不存在**，故不加回、不改判据、只把注释改准。
   *  证据＝`tests\._verify\T-20261006-07\recon.out.txt`（⑤ 全量清单）＋ `git ls-files --eol 项目记录/ADR/`
   *  的 12 行全部 `w/crlf`（**没有** `w/mixed`，git 自己的行尾判据独立佐证）。
   *  ⚠ **下面这条"基线陈旧＝预期形态"的口径仍然有效**，是 `9.5-5` 的 **v1.34 勘误**的落地形态：
   *  规范升版落盘时主代理对几个受管文件做了 `git add`/提交，而 **`git add`／提交会按 `core.autocrlf`
   *  规整工作区文件的行尾** ⇒ 原登记为"混行尾"的文件可能在**没有任何人手工编辑它**的情况下变成正常
   *  ⇒ 本基线出现"**基线陈旧**"分支并**正确判红**。处置永远是**把该条从名单里删掉**（名单只能缩小），
   *  **不是**把它塞回去、**更不是**把判据放宽。分辨口径：**"提交规整了行尾"＝正常（删名单条目）**；
   *  **"有人把文件又改回混行尾"＝真漂移（多一个分支，判红并指名）**。
   *  （第一个实例＝`db28fbc` 之后三个文件的哈希漂移；第二个实例＝`项目记录\工作日志.md`；
   *   第三个实例＝`项目记录/ADR/README.md` —— 本条基线就是这样一路缩到 0 的。）
   *  ⚠ 若哪天有**别的文件**变成混行尾，本条仍按 fail-closed 判红并指名 —— **不要**为了让它变绿就往名单里添行。 */
  const EOL_MIXED_BASELINE = [];  /* 2026-10-05 起为空集（最后一条 `项目记录/ADR/README.md` 被提交规整掉）；2026-10-06 复测仍 0 处 ⇒ "名单只能缩小"缩到 0 即等于"零容忍" */
  /** 末尾缺行尾的既存偏差 —— **6 → 4 处**（`T-20261005-03` 甲补齐两处后）；
   *  余 **4 处全部落在明令禁改的面**（历史记录与已交付件不改字节）。
   *  ⚠ 这份名册是 **fail-closed** 的：它必须**恰好等于**盘上实存集合 ——
   *  多一个 ⇒ 红并指名"新增漂移"；少一个 ⇒ 红并报"基线陈旧"。故**补末行尾后
   *  必须同步删掉对应两行**，否则本条会因"名单陈旧"而红（这正是它该有的行为）。 */
  /** 「**文件中部**的格式字符」（`E186`）的登记基线 —— **空集 ＝ 零容忍**，机制与 `E40-⑤`／`E40-⑥` 同款：
   *  集合必须**恰好等于**盘上实存集合 —— **多一处 ⇒ 红并逐处指名 `文件:行:列`**（新增漂移）；
   *  **少一处 ⇒ 红并报"名单陈旧"**（修好了要**删条目**，**不许**把判据放宽成"只认已知写法"）。
   *  空集不是"这条判据不生效"：**任何一处新增都当场红**，且"名单只能缩小"的 fail-closed 机制
   *  仍然保留 —— 将来若确有**正当**保留项（落在禁改面、本轮无权改的那种），处置是**显式登记**
   *  并把理由写在旁边，**不是**把判据放宽（放宽会让判据对"下一处"失明 —— 那正是 `E186` 要防的）。
   *  ⚠ **基线为什么是空集（改前 → 改后的实测留痕）**：
   *    · **改前**（`T-20261005-31` 实测，2026-10-05，两法互证）：受管面 **161** 个文本文件 ⇒ **1 处**
   *      ＝ `项目记录/审查报告-2026-09-26.md:36:133` 的 `U+200B`（一个零宽字符的笔误）。
   *    · 该处已由**负责人**按"只动这一个字符"**定点移除并自证**（去零宽后逐字节相同），
   *      提交 `bb09756 文档: 清除审查报告中的零宽字符` ⇒ **改后实测 0 处**。
   *    · 故本基线取 **`[]`**（与 `EOL_MIXED_BASELINE` 从 1 缩到 `[]` 是**同一口径**：修好就删条目、
   *      **名单只能缩小**，而不是"留个例外免得它红"）。
   *  ⚠ `._verify` 面按既定裁定**只报不判**：实测 **1 处**
   *  ＝ `tests/._verify/zz6-diag.js` 里的非首字符 `U+FEFF`（**历史诊断件，不动**；见 E40-⑧ 的 `t.info`）。
   *  ⚠ 负对照（判据不误伤合法标点）：把 `，。、；：？！“”‘’（）《》【】—…·～０１２ＡＢ中文汉字`
   *  喂进同一判据 ⇒ **0 命中**（`U+2026`／`U+2014`／`U+201C`／`U+201D`／`U+FF0C` 等都不是格式字符）。 */
  const MIDFILE_FORMAT_BASELINE = [];
  const EOL_NO_TRAILING_NL_BASELINE = [
    '输出文件/离线部署与体检包-V1.4/README-离线部署与体检.md',        /* 交付产物区（2026-10-08 随包升版改名 V1.3 → V1.4；**末行尾状态未变**：实测仍为"无末行尾"） */
    '输出文件/离线部署与体检包-V1.4/体检-双击运行.cmd',              /* 交付产物区（一次性探针 1 漏了它 —— */
    /*   探针 1 只扫了 `*.md` 文档面，非 .md 的交付产物没进面 ⇒ 门禁实测才把它抓出来： */
    /*   这正是"门禁比一次性探针更可信"的一个实例，留痕以免被当成噪声删掉。） */
    '项目记录/审查报告-2026-09-28-01-服务层W5-①独立复核.md',          /* `项目记录\*`：禁改面 */
    '项目记录/架构评审报告-2026-09-30-01.md'                          /* `项目记录\*`：禁改面 */
    /* 已移出基线（本轮甲补齐末行尾，**零语义变化**；移出即"名单只能缩小"）：
       · `tests/lib/assert.js`（`T-20261005-03` 甲：正文逐字节未变，仅补末行尾 `\r\n`）
       · `tests/logic-check.js`（同上） */
  ];
  /** `E192` ②：`项目记录/ADR/` 的「**必须纯 CRLF**」登记基线 —— **空集 ＝ 零容忍**，机制与
   *  `E40-⑤`／`E40-⑥`／`E40-⑧` 同款（`setDiff` 双向：多一处 ⇒ 红并**逐处指名
   *  `文件（行尾形态：…）`**；"名单只能缩小"）。
   *  **为什么是空集**：2026-10-06 主代理已把最后两份**纯 LF**（`ADR-0005`／`ADR-0009`）归一到 CRLF
   *  （`E192` 第①步，逐份自证"去 CR 后逐字节相同"），本包实测**全目录 12 份均为纯 CRLF**
   *  （逐文件读数＝`tests\._verify\T-20261006-07\recon.out.txt`）⇒ 取空集，**不是**"留两个例外免得它红"。
   *  ⚠ **空集本身不构成"这条判据在守"**（`E174`／ADR-0004 D23 同族：静态防空洞）：空基线下
   *  `removed` 分支**结构性不可达** ⇒ 本条**另加**一条**正向自证**："该目录被扫到的 `.md` 数
   *  **恰等于**盘上实有 `.md` 数"（`readdirSync` 独立枚举，**动态取**、不写死 12 —— `ADR-0004` D21）。
   *  目录被改名／被移出扫描面 ⇒ 该合取式当场红，而不是"恒空 ⇒ 恒绿"。
   *  ⚠ 规则真源（`项目记录/ADR/README.md` 的维护规则句）由紧邻的 **`E40-⑨·声明锚点`** 守着：
   *  那句被改动 ⇒ 判红并提示"**规则文本变了，判据要跟**"。 */
  const ADR_CRLF_BASELINE = [];

  /* ---- 九之三：受管面四类损坏特征（零容忍，逐条指名 `文件:行号`） ---- */
  t.check('E40-① 受管面无 BOM（`tools\\*.ps1` 除外 —— 第七章要求它带 BOM，由第二节守）',
    managedScan.counts.bom === 0, listNames(managedScan.bom, 5));
  t.check('E40-② 受管面无替换符 U+FFFD（不可逆的编码损伤墓碑）',
    managedScan.counts.fffd === 0, listNames(managedScan.fffd, 5));
  t.check('E40-③ 受管面无 PUA 区字符 U+E000–U+F8FF（"按 ANSI 读 UTF-8"的特征残留）',
    managedScan.counts.pua === 0, listNames(managedScan.pua, 5));
  if (!GBK_REVERSE) {
    t.skip('E40-④ 受管面无"无损 GBK 乱码"（cp936 逆推往返判据）',
      '本机 TextDecoder 不支持 gbk（ICU 非完整）⇒ 判据不可用；按"跳过 ≠ 通过"记账，不得读成通过');
  } else {
    t.check('E40-④ 受管面无"无损 GBK 乱码"（UTF-8 字节被按 cp936 解码的精确逆推判据）',
      managedScan.counts.moji === 0, listNames(managedScan.moji, 5));
  }

  /* ---- 九之四：受管面行尾惯例（登记 ＋ 反漂移，两个方向都可证伪） ---- */
  const mixedDiff = setDiff(managedScan.mixed.map(m => m.rel), EOL_MIXED_BASELINE);
  t.check('E40-⑤ 受管面"混行尾"集合 ＝ 登记基线（多一个 ⇒ 红并指名；少一个 ⇒ 红并报"名单陈旧"）',
    mixedDiff.added.length === 0 && mixedDiff.removed.length === 0,
    (mixedDiff.added.length ? `**新增漂移** ${mixedDiff.added.length} 处：${mixedDiff.added.join('、')}；` : '')
    + (mixedDiff.removed.length ? `**基线陈旧**（已修好却仍登记着，请删对应行）${mixedDiff.removed.length} 处：${mixedDiff.removed.join('、')}；` : '')
    + `实测 ${managedScan.counts.mixed} 处：${listNames(managedScan.mixed.map(m => `${m.rel}（CRLF ${m.crlf} / 裸 LF ${m.bareLf}）`), 5)}`);
  const noEolDiff = setDiff(managedScan.noEol, EOL_NO_TRAILING_NL_BASELINE);
  t.check('E40-⑥ 受管面"末尾缺行尾"集合 ＝ 登记基线（同上：fail-closed，名单只能缩小）',
    noEolDiff.added.length === 0 && noEolDiff.removed.length === 0,
    (noEolDiff.added.length ? `**新增漂移** ${noEolDiff.added.length} 处：${noEolDiff.added.join('、')}；` : '')
    + (noEolDiff.removed.length ? `**基线陈旧**（已修好却仍登记着，请删对应行）${noEolDiff.removed.length} 处：${noEolDiff.removed.join('、')}；` : '')
    + `实测 ${managedScan.counts.noEol} 处：${listNames(managedScan.noEol, 8)}`);

  /* ---- 九之四之②：`E186` 受管面"**文件中部**的格式字符"（零容忍，落成 fail-closed 登记制） ---- */
  const midFmtDiff = setDiff(managedScan.format, MIDFILE_FORMAT_BASELINE);
  t.check('E40-⑧ 受管面"**文件中部**格式字符"**零容忍**（`E186`：`U+200B`–`U+200F`／'
    + '`U+2028`–`U+202E`／**非首字符** `U+FEFF`；基线＝**空集**）—— 多一处 ⇒ 红并**逐处指名 `文件:行:列`**；'
    + 'fail-closed 机制保留：少一处 ⇒ 红并报"名单陈旧"（名单只能缩小，**不许**放宽判据）',
    midFmtDiff.added.length === 0 && midFmtDiff.removed.length === 0,
    (midFmtDiff.added.length ? `**新增漂移** ${midFmtDiff.added.length} 处（零容忍）:${midFmtDiff.added.join('、')}；` : '')
    + (midFmtDiff.removed.length ? `**基线陈旧**（已修好却仍登记着，请删对应行）${midFmtDiff.removed.length} 处:${midFmtDiff.removed.join('、')}；` : '')
    + `实测 ${managedScan.counts.format} 处（基线 ${MIDFILE_FORMAT_BASELINE.length} 条）:`
    + (managedScan.format.join('、') || '（无）'));
  t.info(`  · [\`E186\`] **文件中部格式字符**：受管面 **${managedScan.counts.format}** 处`
    + `（基线 ${MIDFILE_FORMAT_BASELINE.length} 条；${managedScan.format.join('、') || '（无）'}）；`
    + `\`._verify\` 面 **${verifyScan.counts.format}** 处（**只报不判**`
    + `${verifyScan.format.length ? '：' + listNames(verifyScan.format, 6) : ''}）`
    + `；格式字符集合＝${MIDFILE_FORMAT.size} 个码位（逐码位写死，**不含**合法全角/中文标点）`);

  /* ---- 九之四之③：`E192` ② 受管面「`项目记录\ADR\` 的每个 `.md` 必须纯 CRLF」（零容忍，fail-closed） ---- */
  /** 该目录 `.md` 成员数 —— **独立枚举**（`readdirSync`，不经扫描器）⇒ 它才能当"扫描面没漏成员"的正向自证。
   *  读不到目录 ⇒ `-1`（下面判据必红并报出这一点，**不**让异常把门禁打成退 2）。 */
  const adrDirAbs = path.join(ROOT, ...ADR_CRLF_DIR.split('/'));
  const adrDirMdCount = (() => {
    try { return fs.readdirSync(adrDirAbs).filter(n => n.toLowerCase().endsWith('.md')).length; } catch { return -1; }
  })();
  const crlfDirDiff = setDiff(managedScan.crlfDir, ADR_CRLF_BASELINE);
  t.check('E40-⑨ `项目记录/ADR/` 下**每个 `.md` 必须纯 CRLF**（`E192` ②；口径＝`CRLF>0 ∧ 裸LF==0 ∧ 无 BOM`）'
    + ' —— **不是**"无混行尾"这种更弱的说法（纯 LF 恰好"无混行尾"，而纯 LF 正是 `E192` 的立案事实）；'
    + '基线＝**空集**（零容忍）：多一处 ⇒ 红并**逐处指名 `文件（行尾形态：…）`**；'
    + 'fail-closed 双向（"名单只能缩小"）；另以"**该目录被扫到的 `.md` 数 ＝ 盘上实有数**"防装饰性守护',
    crlfDirDiff.added.length === 0 && crlfDirDiff.removed.length === 0
    && adrDirMdCount > 0 && managedScan.counts.crlfDirFiles === adrDirMdCount,
    (crlfDirDiff.added.length ? `**新增漂移** ${crlfDirDiff.added.length} 处：${crlfDirDiff.added.join('、')}；` : '')
    + (crlfDirDiff.removed.length ? `**基线陈旧**（已修好却仍登记着，请删对应行）${crlfDirDiff.removed.length} 处：${crlfDirDiff.removed.join('、')}；` : '')
    + `受判面 ${managedScan.counts.crlfDirFiles} 个 \`.md\`／盘上实有 ${adrDirMdCount} 个（**必须相等且 >0** `
    + `—— 不等即"扫描面漏成员／目录被改名搬走"）；实测违规 ${managedScan.counts.crlfDir} 处（基线 ${ADR_CRLF_BASELINE.length} 条）：`
    + listNames(managedScan.crlfDir, 5));

  /* ---- 九之四之④：`E192` ② 的「声明 ↔ 判据」绑定（`E186` 锚点纪律：**锚点只许 ASCII**） ----
     判据要守的那句声明来自 `项目记录/ADR/README.md` 的维护规则：**"换行 CRLF"**。它是**中文夹 ASCII**
     的句子 ⇒ 按 `E186`"锚点只许 ASCII"的纪律，取句中三个 ASCII 记号做锚：`UTF-8`／`BOM`／`CRLF`。
     ⚠ **为什么锚点必须落在"声明面"（`>` 开头的引用块）而不是全文**（2026-10-06 实测，见 `anchor.out.txt`）：
       · 单锚 `CRLF` 在**全文**出现 **9 次**、命中 **2 行**（`10` 与 `29`），`UTF-8`／`BOM` 同样命中 `{10,29}`
         —— 因为**勘误行 `:29` 逐字引用了那句规则** ⇒ 全文面**做不到"恰命中 1 次"**，只能退化成
         "至少 1 次"（那正是 `E186` 要防的"锚点漂了还能绿"）；
       · 在**声明面**（`>` 引用块，实测 10 行）里，三个锚**逐锚点各恰命中 1 行**、三锚**同行合取恰 1 行**
         且＝行 `10` ⇒ 既能自证"恰 1 次"，又把"这句规则被搬走/改写"变成可判红的形态。
     ⚠ 若哪天有人改了那句规则文本（或把它移出引用块）⇒ 本条判红；**提示语在 detail 里逐字给出**。 */
  const ADR_RULE_TARGET = `${ADR_CRLF_DIR}/README.md`;
  const ADR_RULE_ANCHORS = ['UTF-8', 'BOM', 'CRLF'];      /* 全 ASCII ⇒ 零宽字符/编码损伤改不动它们 */
  /** 锚点判定（**纯函数**：文本 ⇒ 读数）—— 主断言与它的"可证伪"负对照**共用同一把尺子**
   *  （`E153` 的教训：各写一份的话，D22 证明的就不是主判据了）。 */
  function adrRuleAnchorProbe(text) {
    const quote = text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.startsWith('>'));
    return {
      quote,
      asciiOk: ADR_RULE_ANCHORS.every(a => /^[\x20-\x7E]+$/.test(a)),
      perAnchor: ADR_RULE_ANCHORS.map(a => [a, quote.filter(([, l]) => l.includes(a)).map(([i]) => i)]),
      lines: quote.filter(([, l]) => ADR_RULE_ANCHORS.every(a => l.includes(a))).map(([i]) => i)
    };
  }
  /** **主断言的那一个合取式**（主判据与负对照都只调它） */
  const adrAnchorOk = (p) => p.asciiOk && p.lines.length === 1 && p.perAnchor.every(([, ls]) => ls.length === 1);
  const adrRuleAbs = path.join(ROOT, ...ADR_RULE_TARGET.split('/'));
  const adrRuleText = fs.readFileSync(adrRuleAbs, 'utf8');
  const adrRuleProbe = adrRuleAnchorProbe(adrRuleText);
  const { quote: adrRuleQuote, perAnchor: adrAnchorHits, lines: adrRuleLineNos } = adrRuleProbe;
  t.check('E40-⑨·声明锚点（`E192` ②的"声明↔判据"绑定）：`项目记录/ADR/README.md` 的**声明面**（`>` 引用块）里，'
    + 'ASCII 锚 `UTF-8`／`BOM`／`CRLF` **逐锚点各恰命中 1 行**、三锚**同行合取恰 1 行**；'
    + '锚点一失配即说明**规则文本变了，判据要跟**（`E186` 锚点纪律：锚点只许 ASCII）',
    adrAnchorOk(adrRuleProbe),
    `锚点纯 ASCII=${adrRuleProbe.asciiOk}；逐锚点在声明面的命中行＝`
    + `${adrAnchorHits.map(([a, ls]) => `${a}→[${ls.join(',')}]`).join('；')}（各应恰 1 行）；`
    + `三锚同行合取命中行=[${adrRuleLineNos.join(',')}]（应恰 1 行，实测＝行 ${adrRuleLineNos[0] || '（未命中）'}）；`
    + `声明面共 ${adrRuleQuote.length} 行。⚠ **规则文本变了，判据要跟**：若你改了那句`
    + `"编码：UTF-8（无 BOM），换行 CRLF"，请同步核 \`E40-⑨\` 的判据面与它的基线说明`);
  /* 负对照（**定点变异，内存**）：模拟"有人把这句规则放宽成 LF"（把**声明面**里的 `CRLF` 换成 `LF`）
     ⇒ 同一个合取式**必须为假**。没有这一条，"锚点断言"只是"每次都绿的一串字"（`E174` 同族）。
     ⚠ 只改**内存字符串**；末尾再回读盘上文件，证明它逐字节未动。 */
  const adrRuleMutText = adrRuleText.split('\n')
    .map(l => (l.startsWith('>') ? l.split('CRLF').join('LF') : l)).join('\n');
  const adrRuleMutProbe = adrRuleAnchorProbe(adrRuleMutText);
  const adrRuleDiskSame = fs.readFileSync(adrRuleAbs, 'utf8') === adrRuleText;
  t.check('E40-⑨·声明锚点 负对照（**可证伪**）：把声明面里的 `CRLF` 换成 `LF`（＝"有人把规则放宽成 LF"'
    + '的真实形态，**内存副本**、盘上不动）⇒ 同一合取式**当场为假**；未变异时必真、盘上逐字节未变',
    adrAnchorOk(adrRuleProbe) && !adrAnchorOk(adrRuleMutProbe) && adrRuleDiskSame,
    `未变异 ok=${adrAnchorOk(adrRuleProbe)}（应 true）；变异后 ok=${adrAnchorOk(adrRuleMutProbe)}（应 false）；`
    + `变异后逐锚点命中行＝${adrRuleMutProbe.perAnchor.map(([a, ls]) => `${a}→[${ls.join(',')}]`).join('；')}；`
    + `盘上逐字节未变=${adrRuleDiskSame}`);

  /* 每轮**可见**的读数（`check` 的 PASS 详情默认不打印 ⇒ 判据的"实测值"必须另用 `t.info` 说出来，
     否则读者只能看到"绿"而看不到"守的是哪 12 个文件、各是什么形态"）。
     这里逐文件列形态，是为了让"**全目录纯 CRLF**"这个事实每轮都自证一次、而不是只写在注释里。 */
  const adrFormList = MANAGED.filter(f => isAdrCrlfMember(relOf(f), f))
    .map(f => `${path.basename(f)}→${crlfRequiredViolation(relOf(f), fs.readFileSync(f)) ? '**违规**' : '纯CRLF'}`);
  t.info(`  · [\`E192\`②（\`E40-⑨\`）] **ADR 目录行尾**：受判 ${managedScan.counts.crlfDirFiles} 个 \`.md\``
    + `（\`readdirSync\` 独立枚举 ${adrDirMdCount} 个）、违规 **${managedScan.counts.crlfDir}** 处、基线 ${ADR_CRLF_BASELINE.length} 条；`
    + `逐文件形态：${adrFormList.join('、')}`);
  t.info(`  · [\`E192\`②（\`E40-⑨\`·声明锚点）] 规则真源＝\`${ADR_RULE_TARGET}\` 的 \`>\` 声明面（${adrRuleQuote.length} 行）：`
    + `${adrAnchorHits.map(([a, ls]) => `\`${a}\` 恰 ${ls.length} 行[${ls.join(',')}]`).join('；')}；`
    + `三锚**同行合取**恰 ${adrRuleLineNos.length} 行＝[${adrRuleLineNos.join(',')}]（规则句原样在：${adrRuleLineNos.length === 1}）`);

  /* ---- 九之五：`._verify` 面如实登记（按既定裁定不判红、不修，但必须可见） ---- */
  t.info('（以下 `._verify` 面只报不判 —— 它是探针/取证/临时产物区，按 ADR-0003 D16 与既定裁定保持原样）');
  t.info(`  · BOM：非 \`.ps1\` **${verifyScan.counts.bom}** 个（偏差）＋ \`.ps1\` **${verifyScan.counts.bomPs1}** 个`
    + `（第七章要求带 BOM ⇒ 不算偏差）；其中 \`.js\` 带 BOM **${verifyScan.bom.filter(r => r.endsWith('.js')).length}** 个`
    + `（T-21 已清掉 22 个 \`.js\` BOM ⇒ 现为 0，与那次清理一致）`);
  for (const l of wrapNames(verifyScan.bom, 4)) t.info(`      ${l}`);
  for (const l of wrapNames(verifyScan.bomPs1, 4)) t.info(`      [.ps1·规定带 BOM] ${l}`);
  t.info(`  · U+FFFD ${verifyScan.counts.fffd} 处（清单共记 ${verifyScan.fffd.length} 条，前 8：`
    + `${verifyScan.fffd.slice(0, 8).join('、') || '（无）'}）`);
  t.info(`  · PUA 区 ${verifyScan.counts.pua} 处（清单共记 ${verifyScan.pua.length} 条，前 8：`
    + `${verifyScan.pua.slice(0, 8).join('、') || '（无）'}）`);
  t.info(`  · 无损 GBK 乱码 ${verifyScan.counts.moji} 处（前 8：${listNames(verifyScan.moji, 8)}）`);
  t.info(`  · 混行尾 ${verifyScan.counts.mixed} 个（前 8：${listNames(verifyScan.mixed.map(m => m.rel), 8)}）`);
  t.info(`  · 末尾缺行尾 ${verifyScan.counts.noEol} 个（前 8：${listNames(verifyScan.noEol, 8)}）`);
  t.info(`  · 读不到 ${verifyScan.counts.unreadable} 个（并发座位可能正独占锁着，实测 EBUSY）`
    + (verifyScan.unreadable.length ? `：${listNames(verifyScan.unreadable, 3)}` : ''));

  /** 两个**已裁定保持原样**的内容损坏件（`T-20261005-01` 乙/甲两处的既定口径）：
   *   `d8\head-main.js`（截断副本 —— 其特征是**缺末行尾**，字符类判据抓不到它）
   *   `t16-e141\probe-survey.js`（GBK 乱码内容 —— PUA＝12）
   *  这两个锚点同时承担"**扫描面确实扫到了 `._verify`**"的反装饰证明：若哪天扫描面
   *  写错/被静默排除，本判据立刻红，而不是"报告恒空 ⇒ 看起来一切正常"。 */
  const KNOWN_DAMAGED = ['tests/._verify/d8/head-main.js', 'tests/._verify/t16-e141/probe-survey.js'];
  const present = KNOWN_DAMAGED.filter(rel => VERIFY.some(v => relOf(v) === rel));
  /* ⚠ 这两个既定件必须**单文件不截断**再扫一次：主报告里的逐行清单受 `HY_CAP` 限制，
     而 `._verify` 的 PUA 有 2399 处 ⇒ 拿被截断的清单去 `some()` 会**假阴性**
     （首版实测：`probe-survey.js` 的第 3 行落在第 200 条之后 ⇒ 被误判成"未如实列出"）。
     这条教训本身值得留痕：**"清单截断"与"判据失明"看起来一模一样**。 */
  const knownScan = scanHygiene(KNOWN_DAMAGED.map(r => path.join(ROOT, r)));
  const puaNamed = knownScan.pua.some(s => s.startsWith('tests/._verify/t16-e141/probe-survey.js:'));
  const noEolNamed = knownScan.noEol.includes('tests/._verify/d8/head-main.js');
  t.check('E40-⑦ `._verify` 面确实被扫到，且两个既定内容损坏件如实出现在报告里'
    + '（防"扫描面写错/被静默排除 ⇒ 报告恒空 ⇒ 装饰性守护"）',
    present.length === KNOWN_DAMAGED.length && verifyScan.counts.files > 0 && puaNamed && noEolNamed,
    `扫到 ${verifyScan.counts.files} 个文件；两个既定件在扫描面内 ${present.length}/${KNOWN_DAMAGED.length}`
    + `（${present.join('、') || '无'}）；probe-survey.js 命中 PUA 判据=${puaNamed}`
    + `（实测 PUA ${knownScan.counts.pua} 处，首条 ${knownScan.pua[0] || '无'}）；`
    + `head-main.js 命中"缺末行尾"判据=${noEolNamed}`);

  /* ---- 九之六：D22（每类判据各在**内存字节副本**上植入 1 处） ----
     为什么用内存副本而不是"改盘再还原"：`E70` 的事故（2026-10-03）就是"改真文件没还原"
     —— 受管文件被静默污染、只有逐行比对 HEAD 才发现。内存副本从机制上让
     **盘上文件从头到尾只被读一次** ⇒ "残留"不可能存在。 */
  const D22_TARGET = 'src/components/HeaderBar.js';
  const d22Abs = path.join(ROOT, D22_TARGET);
  const d22Src = fs.readFileSync(d22Abs);
  const d22Lines = d22Src.toString('utf8').split('\n').length;      /* 追加一行后的 1-based 行号 */
  /** 一次 D22 复核：未变异必绿 ＋ 变异**恰 1 处**并**逐字指名** ＋ 盘上逐字节未变 */
  function runD22(buf, expect, pick) {
    const base = scanHygiene([d22Abs]);
    const mut = scanHygiene([d22Abs], p => (p === d22Abs ? buf : fs.readFileSync(p)));
    const hit = pick(mut);
    const untouched = fs.readFileSync(d22Abs).equals(d22Src);
    return {
      ok: pick(base).length === 0 && hit.length === 1 && hit[0] === expect && untouched,
      detail: `植入点=${expect}；未变异命中 ${pick(base).length} 处（应 0）；变异命中 [${hit.join('、')}]`
        + `（应恰 1 处且＝植入点）；盘上逐字节未变=${untouched}`
    };
  }
  const d22Cases = [
    ['E40 D22① BOM：给受管面源码**头部植入 1 个 BOM**',
      Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), d22Src]), D22_TARGET, r => r.bom],
    ['E40 D22② U+FFFD：在源码**末行后追加 1 行**含 1 个替换符',
      Buffer.concat([d22Src, Buffer.from(`D22-PROBE\uFFFD\r\n`, 'utf8')]), `${D22_TARGET}:${d22Lines}`, r => r.fffd],
    ['E40 D22③ PUA：在源码**末行后追加 1 行**含 1 个 `U+E000`',
      Buffer.concat([d22Src, Buffer.from(`D22-PROBE\uE000\r\n`, 'utf8')]), `${D22_TARGET}:${d22Lines}`, r => r.pua],
    ['E40 D22④ 混行尾：在纯 CRLF 的源码末尾**追加 1 个裸 LF**（制造同文件两种行尾）',
      Buffer.concat([d22Src, Buffer.from('D22-PROBE\n', 'utf8')]), D22_TARGET, r => r.mixed.map(m => m.rel)],
    ['E40 D22⑤ 缺末行尾：**剥掉源码的末行尾**',
      d22Src.slice(0, d22Src[d22Src.length - 2] === 13 ? d22Src.length - 2 : d22Src.length - 1),
      D22_TARGET, r => r.noEol]
  ];
  /** D22⑥ 的乱码样本**由代码现算、不在本文件里写字面量** —— 写死时本文件自己就命中
   *  E40-④（首版实测：`tests/files-check.js:680` 被判红）。那恰好证明判据**抓得住自己**，
   *  但"检测器把自带样例判成损坏"是既有 `MOJIBAKE_EXEMPT` 那条老路的坑；现算更干净，
   *  并且把"样本必须无损"变成下面一条可断言的**前提**（`D20`）。 */
  const D22_PLAIN = '夹具层不引用业务代码';
  const D22_BROKEN = (() => {
    try { return new TextDecoder('gbk').decode(Buffer.from(D22_PLAIN, 'utf8')); } catch { return ''; }
  })();
  if (GBK_REVERSE) {
    d22Cases.push(['E40 D22⑥ 无损 GBK 乱码：在源码末行后追加 **1 行"真中文被 cp936 解码"的乱码**'
      + '（往返可逆、无 FFFD／PUA ⇒ 只有本判据抓得住它）',
    Buffer.concat([d22Src, Buffer.from(D22_BROKEN + '\r\n', 'utf8')]),
    `${D22_TARGET}:${d22Lines}`, r => r.moji]);
  }
  /* `E186` 的 D22：**13 个码位逐个**在内存字节副本上植入（不是只拿 `U+200B` 当代表）——
     单点样本只能证明"那一个码位被抓"，而本条的判据是**一个集合**（还带"非首字符 `U+FEFF`"
     这种位置相关语义）⇒ 必须**逐个码位**给读数，否则就是 `D19` 的"看起来验过了"。
     手法与上面同款：在受管面源码**末行后追加 1 行**，行内先写 ASCII 前缀 `D22-<HEX>-`，
     紧跟**恰好 1 个**目标码位 ⇒ 期望**恰命中 1 处**且指名串**逐字等于** `文件:行:列（码位名）`。
     列＝`D22-<HEX>-` 的**码点数 + 1**（前缀全 ASCII ⇒ 与前缀字符数相同），**不抄现算值**。 */
  const mfPrefixOf = cp => `D22-${cp.toString(16).toUpperCase()}-`;
  const mfRows = [];
  let mfAllOk = true;
  const mfBase = scanHygiene([d22Abs]);                       /* 负对照（现行盘上）——只读一次，13 支共用 */
  for (const [cp, name] of MIDFILE_FORMAT) {
    const prefix = mfPrefixOf(cp);
    const buf = Buffer.concat([d22Src, Buffer.from(prefix + String.fromCharCode(cp) + '\r\n', 'utf8')]);
    const expect = `${D22_TARGET}:${d22Lines}:${[...prefix].length + 1}（${name}）`;
    const mut = scanHygiene([d22Abs], p => (p === d22Abs ? buf : fs.readFileSync(p)));
    /* ① 判据本体（`scanHygiene` 的 `format` 桶）：恰 1 处且**逐字**等于期望的 `文件:行:列（码位名）` */
    const namedOk = mut.format.length === 1 && mut.format[0] === expect;
    /* ② **主断言那一件事**（`E40-⑧` 用的就是这个合取式：`setDiff(scan.format, BASELINE)`）——
       为什么必须把这一步也算进来（`E153` 的教训）：只证明"扫描器能看见"不等于证明
       "**主断言会红**"；两处若各写一份，D22 证明的就不是受管面那条判据了。 */
    const d = setDiff(mut.format, MIDFILE_FORMAT_BASELINE);
    const redOk = d.added.length === 1 && d.added[0] === expect && d.removed.length === 0;
    const untouched = fs.readFileSync(d22Abs).equals(d22Src);
    if (!(namedOk && redOk && untouched)) mfAllOk = false;
    mfRows.push(`${name.split(' ')[0]}→指名[${mut.format.join('、') || '（无）'}]/主断言新增=${d.added.length}`);
  }
  const mfNegBaseOk = mfBase.format.length === 0;
  if (!mfNegBaseOk) mfAllOk = false;
  t.check('E40-⑧ D22（可证伪，**13 个码位的真值表**）：逐一在受管面源码的**内存字节副本**中部植入'
    + '**恰好 1 个**格式字符 ⇒ ① 判据**必红** ② **指名到 `文件:行:列（码位名）`**（列按码点计）'
    + ' ③ **主断言那一个合取式**（`setDiff(scan.format, 基线)`）**当场多出恰 1 条且逐字等于植入点**'
    + ' ④ 未变异（现行盘上）**必绿** —— 负对照 ⑤ 盘上逐字节未变',
    mfAllOk, `未变异命中 ${mfBase.format.length} 处（应 0）；逐码位读数：${mfRows.join('；')}`);

  /* 负对照②（判据不误伤合法标点）：把**合法全角/中文标点**追加成一行 ⇒ 本判据必须 0 命中。
     为什么这条必须有：`E186` 的判据是一个"码位集合"，集合一旦被写宽（例如把 `U+2026`／`U+2014`
     顺手并进区间），就会把正常中文文档判红 —— 那样门禁会被人"关掉"，比漏报更坏。 */
  const mfNegLine = 'D22-NEG：，。、；：？！“”‘’（）《》【】—…·～０１２ＡＢ中文汉字\r\n';
  const mfNeg = (() => {
    const buf = Buffer.concat([d22Src, Buffer.from(mfNegLine, 'utf8')]);
    const base = scanHygiene([d22Abs]);
    const mut = scanHygiene([d22Abs], p => (p === d22Abs ? buf : fs.readFileSync(p)));
    return { base: base.format.length, mut: mut.format.length, untouched: fs.readFileSync(d22Abs).equals(d22Src) };
  })();
  t.check('E40-⑧ 负对照（**判据不把合法全角/中文标点当格式字符**）：把 `，。、；：？！“”‘’（）《》【】'
    + '—…·～０１２ＡＢ中文汉字` 追加成一行（`U+2026`／`U+2014`／`U+201C`／`U+201D`／`U+FF0C` 都在其中）'
    + ' ⇒ 本判据 **0 命中**；同一次调用里受管面现行读数也必须仍是 0（基线是空集、实测 0 处）',
    mfNeg.mut === 0 && mfNeg.base === 0 && mfNeg.untouched,
    `变异体命中 ${mfNeg.mut} 处（应 0）、未变异命中 ${mfNeg.base} 处（应 0）、盘上逐字节未变=${mfNeg.untouched}`);

  for (const [label, buf, expect, pick] of d22Cases) {
    const r = runD22(buf, expect, pick);
    t.check(`${label} ⇒ ① 判据必红 ② **指名到文件:行号** ③ 未变异必绿 ④ 盘上逐字节未变`, r.ok, r.detail);
  }
  if (!GBK_REVERSE) {
    t.skip('E40 D22⑥ 无损 GBK 乱码：内存植入 ⇒ 必红并指名',
      '本机 ICU 不含 gbk ⇒ 样本构造不出来；判据 E40-④ 也已按 SKIP 记账（"跳过 ≠ 通过"）');
  }
  /* D22⑥ 的**前提**（ADR-0004 D20）：样本必须"往返可逆且无 FFFD／PUA"，否则它会被
     ①②③ 抓走 ⇒ 这条 D22 就**证明不了** ④ 判据本身有效 —— 那正是"看起来守住了"的形态。 */
  t.requires('D22⑥ 的乱码样本是**无损**的（cp936 逆推恰等于原句，且样本不含 U+FFFD／PUA）',
    GBK_REVERSE ? (gbkReverse(D22_BROKEN) === D22_PLAIN
      && !/[\uFFFD\uE000-\uF8FF]/.test(D22_BROKEN)) : true,
    'cp936 逆推表不可用或样本已失效 —— 请重取样本并同步本行注释');

  /* ---- 九之六之②：`E40-⑨`（`E192` ②）的 D22 ----
     与上面同款（**内存字节副本**，盘上全程只读），但**多两件**：①变异体是 `项目记录\ADR\` 的
     **真实成员**（不是 `src\` 里的替身）⇒ "目录归属"这一步也被验到；②除"判据桶"外还要
     **主断言那一个合取式**（`setDiff(scan.crlfDir, ADR_CRLF_BASELINE)`）当场红 —— `E153` 的教训：
     只证明"扫描器看见了"不等于证明"两条主断言会红"。
     ⚠ 与"真文件字节变异→还原"的关系：本段证明的是**判据逻辑**可证伪（盘上零残留）；**真文件**
     那一轮读数由 `tests\._verify\T-20261006-07\d22-real.out.txt` 留痕（本仓惯例：防回潮判据
     要对**真文件**起过作用）。 */
  const ADR_D22_TARGET = `${ADR_CRLF_DIR}/ADR-0005-统计口径真源形态.md`;
  const adrD22Abs = path.join(ROOT, ...ADR_D22_TARGET.split('/'));
  const adrD22Src = fs.readFileSync(adrD22Abs);
  /** 变异体：去掉**所有** `0x0D` ⇒ 纯 LF */
  const adrD22Lf = Buffer.from(adrD22Src.filter(b => b !== 0x0D));
  /** 独立计数（**不用被测函数**算期望值 —— ADR-0004 D21/D23） */
  const adrD22LfCount = adrD22Lf.reduce((n, b) => n + (b === 10 ? 1 : 0), 0);
  /** 期望串：形态**逐字写死**，只有 `裸LF=N` 的 N 来自上面那次独立计数 */
  const adrD22Expect = `${ADR_D22_TARGET}（行尾形态：纯LF CRLF=0／裸LF=${adrD22LfCount}）`;
  /** "去掉所有 `0x0D`"与"把 CRLF 换成 LF"必须逐字节同结果（否则该文件混着孤立 CR ⇒ 前提不成立） */
  const adrD22Stripped = Buffer.from(adrD22Src.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  const adrD22Base = scanHygiene([adrD22Abs]);                       /* 负对照：现行盘上必 0 */
  const adrD22Mut = scanHygiene([adrD22Abs], p => (p === adrD22Abs ? adrD22Lf : fs.readFileSync(p)));
  const adrD22Diff = setDiff(adrD22Mut.crlfDir, ADR_CRLF_BASELINE);
  const adrD22Untouched = fs.readFileSync(adrD22Abs).equals(adrD22Src);
  t.requires('`E40-⑨` 的 D22 前提：目标文件现行是**纯 CRLF**，且"去掉所有 `0x0D`"与'
    + '"把 CRLF 换成 LF"逐字节相同（否则"⇒ 纯 LF"这一步不成立，D22 就证明不了判据）',
    adrD22Base.crlfDir.length === 0 && adrD22Stripped.equals(adrD22Lf)
    && adrD22Src.length > 0 && adrD22Lf.length > 0 && adrD22LfCount > 0,
    `现行违规 ${adrD22Base.crlfDir.length} 处（应 0）；去 CR 后逐字节相同=${adrD22Stripped.equals(adrD22Lf)}；`
    + `${adrD22Src.length} B → ${adrD22Lf.length} B（裸 LF ${adrD22LfCount}）`);
  t.check('E40-⑨ D22（可证伪）：把 `项目记录/ADR/ADR-0005` 的**内存字节副本**改成**纯 LF**'
    + '（去掉所有 `0x0D`）⇒ ① 判据**必红** ② **逐字指名** `文件（行尾形态：纯LF CRLF=0／裸LF=N）`'
    + ' ③ **主断言**（`setDiff(scan.crlfDir, 基线)`）**当场多出恰 1 条且逐字等于植入串**'
    + ' ④ 未变异（现行盘上）**必绿** ⑤ 盘上逐字节未变',
    adrD22Mut.crlfDir.length === 1 && adrD22Mut.crlfDir[0] === adrD22Expect
    && adrD22Diff.added.length === 1 && adrD22Diff.added[0] === adrD22Expect && adrD22Diff.removed.length === 0
    && adrD22Base.crlfDir.length === 0 && adrD22Untouched,
    `植入点=${adrD22Expect}；未变异命中 ${adrD22Base.crlfDir.length} 处（应 0）；`
    + `变异命中 [${adrD22Mut.crlfDir.join('、')}]（应恰 1 处且＝植入点）；`
    + `主断言新增 ${adrD22Diff.added.length} 条／"基线陈旧" ${adrD22Diff.removed.length} 条（应 1／0）；`
    + `盘上逐字节未变=${adrD22Untouched}`);
}

  t.finish();
}

/* 与既有脚本一致：异常以退出码 2 结束（打印行含字面 `脚本异常终止`，`run-all` 的失败明细据此命中） */
try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
