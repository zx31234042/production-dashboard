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
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', '来源文件', 'reference', '._verify']);
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
t.info(`扫描 ${files.length} 个文本文件（已跳过 .git / 来源文件 / reference / ._verify）`);

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
const tempRoot = env.paths.tempRoot;
const strayDb = fs.existsSync(tempRoot)
  ? fs.readdirSync(tempRoot).filter(n => /\.db(-wal|-shm)?$/.test(n))
  : [];
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

t.finish();
