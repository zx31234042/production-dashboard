/* ==========================================================================
   文档与规范一致性自检（tests/docs-check.js）
   作用：把"只读文档"这一侧也纳入回归：文档转换工具的真实能力、提交信息格式、
         项目记录与仓库现状是否对得上、对外文档与实现是否同源、
         以及 PROJECT_RULES.md 里可机械核对的条款。
         D1 md2docx 基础版：真跑一遍，检查产物里的标题/表格/列表/引用/代码块/分隔线/行内格式
         D1b md2docx-img 增强版：图片嵌入、{w=60} 宽度、图注、缺图容错
         D2 提交信息格式（PROJECT_RULES 6.1/6.2）
         D3 项目记录（当前状态快照 / 工作日志）与仓库现状一致性
         D4 对外文档（输出文件/）与实现一致性
         D5 PROJECT_RULES 条款抽查（编码、缩进、无第三方库、归档规则、9.8 变更表、md↔docx 同源）
         D6 需求清单"改名升级版本"必修项抽查（文末版本串 token = 文件名版本、变更记录首段
            `### V<前一版> → V<当前版>`、同名同版本 docx 存在且根目录无其他版本 docx、
            页首「编制日期」行已登记当前版本并加粗）
   依赖：仅 Node 内置模块；会调用本机 PowerShell 5.1 跑 tools/ 下的两个 .ps1。
   运行：node tests/docs-check.js
   退出码：0 = 全部通过；1 = 有断言失败；2 = 脚本自身异常。
   产物：中间文件写在 tests/._verify/（已被 .gitignore 忽略）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const env = require('./env');
env.assertRuntime();

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', '._verify');

/* ---------------- 断言框架 ---------------- */
let passed = 0;
const failures = [];
let skipped = 0;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  [SKIP] ${name} —— ${reason}`);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/* ---------------- 可见文字归一化（`E13` 的判据本体；纯函数，供定点回归直接调用） ----------------
   **为什么剥的是「行内标记」而不是把比对改宽松（回执里也复述了这一段）**：
     ① 同源断言要判的是"**md 与 docx 的可见文字**是否同源"，而不是"markdown 源码是否同源"。
        md 一侧的 `\`` / `**` 是**排版标记**，不是可见文字 ⇒ 比较前剥掉，比的是"剥完之后的可见文字"，
        而且仍然是**逐字比对**（`scanPairContent` 里那句 `body.includes(...)`：标题必须**整串出现**在
        docx 正文里）。**语义正确**，改动小（`E13` 行给的建议②）。
     ② 若改成"包含即可 / 模糊比对 / 只比前 N 字"这类**弱判据**，就是给门禁开防空洞（违反 `ADR-0004`
        `D21`/`D23`：判据只许收紧、不许放松；弱判据会让"docx 真缺标题"这一类真缺陷静默变绿）——
        所以**不动**判据强度，只把"两侧拿来做比较的文字"对齐到同一个口径。
     ③ 剥掉哪些标记，**由实测决定**（`E13` 要求"逐个判断后纳入"）：`tools\md2docx.ps1` 的行内解析
        只认两种标记 —— `InlinePattern()`（`md2docx.ps1:175-177`）＝ `` `代码` `` 与 `**粗体**`，
        `Runs()`（`md2docx.ps1:205-216`）把它们的定界符**丢掉**、只把内容写进 `w:t`（可换成等宽红字
        或 `<w:b/>`）；而 `*斜体*`／`_下划线_`／`~~删除线~~` **不在**该正则里 ⇒ 定界符**原样写进 docx**。
        2026-10-04 本座位实测（样本 `tests\._verify\t20261004-09\probe-e13-out\readouts\heading-inline-sample.md`
        真跑 `md2docx.ps1`，读数见同目录 `probe-md2docx-heading-inline.out.txt`）：
          · `## 反引号：关键参数上传（\`PARAM_INFO_RECV\`）` ⇒ docx 纯文本 `反引号：关键参数上传（PARAM_INFO_RECV）`
            （runs：`(Segoe UI)` ｜ `PARAM_INFO_RECV(Consolas/A31515)` ｜ `）(Segoe UI)`）—— **反引号被丢掉**
          · `## 加粗：**加粗词**在后（\`CODE_BOLD\`）` ⇒ `加粗：加粗词在后（CODE_BOLD）`（`<w:b/>` ＋ Consolas）
          · `## 斜体：*斜体词*在后` ⇒ `斜体：*斜体词*在后`（**逐字相等，星号留着**）
          · `## 下划线：_下划线词_在后` ⇒ `下划线：_下划线词_在后`（**逐字相等**）
          · `## 删除线：~~删除线词~~在后` ⇒ `删除线：~~删除线词~~在后`（**逐字相等**）
        ⇒ **只剥 `\`` 与 `**`**。多剥 `*`/`_`/`~` 会让"md 写了标记而 docx 真缺"的标题假绿（**假阴性**，
        与弱判据同罪：`D23` 要求判据有判别力，不许"把两边都抹平"）。
   判据来源：`E13`（2026-09-21 暴露：第二批澄清函第五节标题里的内联代码让本断言由 41/2 → 40/3；
   当时的规避是"把标题里的反引号去掉"）；修法＝`E13` 行的建议②。
   @param {string} text 标题原文（可含行内标记）
   @returns {string} 剥掉「会被 md2docx 丢掉的行内标记定界符」之后的可见文字 */
const MD_INLINE_TICK = '`';
const MD_INLINE_STAR = '*';
const MD_INLINE_ANY = /[`*]/;

function stripInlineMarkup(text) {
  const src = String(text == null ? '' : text);
  if (!MD_INLINE_ANY.test(src)) return src;   /* 绝大多数标题：一个标记都没有 ⇒ 一个字都不动 */
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === MD_INLINE_TICK || ch === MD_INLINE_STAR) {
      /* 定界符游程：```` ```` 这种「更多反引号」是合法定界符（`md2docx.ps1:172-177` 同样口径）。
         工具侧是 `[regex]::Split` ＋ `InlinePattern()` 的最左匹配 ⇒ 定界符是**整个游程**；
         实测（`probe-multi-tick.js`，2026-10-04）：游程 n≥2 时，工具**先按"下一个 n 连反引号"收尾**
         （宽松写法 `` a`b `` ⇒ 内容 ` a`b `），**收不到就退到单反引号收尾**
         （紧邻写法 ``a`b`` ⇒ 内容 `a`b`）。本函数按同一顺序试，读出的可见文字与工具逐字一致
         ——"多吃了/少吃了可见文字"就是判据的假红/假绿，所以这里必须与工具同口径。
         找不到任何配对 ⇒ 当字面量原样保留（宁可判红也不吃掉可见文字）。 */
      let j = i;
      while (j < src.length && src[j] === ch) j++;
      const run = j - i;
      if (ch === MD_INLINE_STAR && run < 2) {
        /* 单个 `*` 是**字面量**（工具不认斜体）⇒ 原样保留，避免把可见文字吃掉 */
        out += src.slice(i, j); i = j; continue;
      }
      let hit = -1, delim = 0;
      for (let n = run; n >= 1; n--) {
        if (ch === MD_INLINE_STAR && n < 2) break;
        const close = src.indexOf(ch.repeat(n), j);
        if (close >= j) { hit = close; delim = n; break; }
      }
      if (hit >= 0) { out += src.slice(j, hit); i = hit + delim; continue; }
      /* 定界符找不到配对 ⇒ 当字面量保留 */
      out += src.slice(i, j); i = j; continue;
    }
    out += ch; i++;
  }
  return out;
}

/* ---------------- ZIP（OOXML）读取：不用第三方库 ---------------- */
/** 解析中央目录，返回 Map(条目名 → { method, offset, compSize }) */
function zipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const map = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    map.set(buf.toString('utf8', off + 46, off + 46 + nameLen), { method, compSize, offset: localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return map;
}

/** 按 OPC 部件名取条目（容忍打包时误用反斜杠的情况） */
function zipEntry(docxFile, name) {
  const entries = zipEntries(docxFile);
  if (entries.has(name)) return entries.get(name);
  const want = name.replace(/\//g, '\\');
  return entries.get(want);
}

/** 读取 ZIP 内某个条目的文本内容（部件名按 OPC 规范书写，容忍反斜杠） */
function zipEntryText(file, name) {
  const buf = fs.readFileSync(file);
  const entry = zipEntry(file, name);
  if (!entry) throw new Error(`条目不存在：${name}（实际条目：${[...zipEntries(file).keys()].slice(0, 4).join(' , ')}）`);
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  return (entry.method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
}

/** 去掉 XML 标签得到纯文本，便于做"内容包含"判断 */
function stripXml(xml) {
  return xml.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
}

/* ---------------- md ↔ docx 同源扫描（`E13` 的判据；纯函数，roots 可传入 ⇒ 定点回归用受控副本直接调） ----------------
   判据不变：凡有同名 docx 的 md，其 **1～2 级标题**都应当**逐字出现**在该 docx 正文里；
   变的只是"md 侧拿什么去比"——先 `stripInlineMarkup()` 剥掉会被 `md2docx` 丢掉的行内标记
   （`\`` 与 `**`；依据见 `stripInlineMarkup()` 抬头与同目录实测读数），再逐字比对。
   @param {string[]} roots 扫描根（相对仓库根或绝对路径）
   @returns {{pairs:number, stale:string[], roots:string[]}} stale 每项＝"某 docx 缺 N 个标题（如「…」）"
   @throws 中央目录/条目读取失败由调用方兜底（本函数把它记进 stale，不抛） */
function scanPairContent(roots) {
  const pairs = [];
  const collectPairs = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { collectPairs(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      const docx = full.replace(/\.md$/, '.docx');
      if (fs.existsSync(docx)) pairs.push([full, docx]);
    }
  };
  const list = Array.isArray(roots) ? roots : [];
  for (const d of list) {
    const full = path.isAbsolute(d) ? d : path.join(ROOT, d);
    if (fs.existsSync(full)) collectPairs(full);
  }
  const stale = [];
  for (const [mdFile, docxFile] of pairs) {
    const mdText = fs.readFileSync(mdFile, 'utf8');
    const headings = [...mdText.matchAll(/^#{1,2}\s+(.+)$/gm)]
      .map(m => stripInlineMarkup(m[1]).trim());
    if (!headings.length) continue;
    let body;
    try {
      body = stripXml(zipEntryText(docxFile, 'word/document.xml'));
    } catch (e) {
      stale.push(`${path.relative(ROOT, docxFile)}（读取失败：${e.message}）`);
      continue;
    }
    const missing = headings.filter(h => !body.includes(h.replace(/\s+/g, '')));
    if (missing.length) stale.push(`${path.relative(ROOT, docxFile)} 缺 ${missing.length} 个标题（如「${missing[0]}」）`);
  }
  return { pairs: pairs.length, stale, roots: list.slice() };
}

/* ---------------- 调 PowerShell 跑文档转换脚本（输出重定向到文件，避开沙箱管道限制） ----------------
   **`E116`（2026-10-04）**：工具脚本的**受控输入口**。设 `DSH_DOCS_TOOL_DIR` ⇒ 从该目录按**同样的相对布局**
   取 `.ps1`（供定点回归用一把"退 0 但不产出"的假工具）；**不设**就还是 `tools\<同名>`，正式运行的读入面一字不变。
   与 `docs-cross-check` 的 `DSH_DC_*_OVERRIDE`／`offline-check` 的 `DSH_OFFLINE_PKG` 同一口径：
   换"被测输入"的**受控副本**，而不是去改真工具或真产物。 */
function toolPath(scriptRel) {
  return path.join(process.env.DSH_DOCS_TOOL_DIR || ROOT, scriptRel);
}

/**
 * **工具调用的处置口径**（纯函数；`E116` 的判据本体，D1 与 D1b 共用这一份 —— 不许两处各写一套）。
 *
 * 立案（座位 5 在 `C·20.7` `F-9` 报出）：原式是 `code !== 0 || !existsSync(产物)` ⇒ `skip(...)`，
 * 于是"**工具自报成功（退 0）却删掉了自己的产物**"（2026-10-04 真实出现过）被记成 **SKIP**：
 * D1/D1b 的 17 条断言压成 2 条 SKIP、`docs-check` 由 46/2 掉到 29/2/2、连带 `docs-cross-check`
 * 第十一节红、整轮权威对账被挡（护栏是对的，**症状描述误导**）。
 * 现口径：
 *   · **退 0 但产物不存在/为空** ⇒ **fail**，文案点明"**工具自报成功但无产物**"（不是"工具不可用"）；
 *   · **退出码非 0** ⇒ **fail**（工具真失败，不是环境问题）；
 *   · **SKIP 只留给真·环境不满足**，且两种理由**分开表述**：① PowerShell 解释器不可用；
 *     ② 工具脚本文件不存在。既有语义保留：环境不满足**不算失败**（`9.5-5` 的 skip 通道不删）。
 * @param {{toolExists:boolean, spawnError:string, code:number, artifactBytes:?number,
 *          artifactRel:string, toolLabel:string}} r
 * @returns {{verdict:'skip'|'fail'|'ok', why:string}}
 */
function classifyToolRun(r) {
  if (!r.toolExists) return { verdict: 'skip', why: `环境不满足（工具脚本文件不存在）：${r.toolLabel}` };
  if (r.spawnError) return { verdict: 'skip', why: `环境不满足（无法启动 PowerShell）：${r.spawnError}` };
  if (r.code !== 0) return { verdict: 'fail', why: `${r.toolLabel} 退出码 ${r.code}（工具自报失败）` };
  if (r.artifactBytes === null || r.artifactBytes === undefined) {
    return { verdict: 'fail', why: `${r.toolLabel} **工具自报成功但无产物**：退出码 0，产物文件不存在（${r.artifactRel}）` };
  }
  if (r.artifactBytes <= 0) {
    return { verdict: 'fail', why: `${r.toolLabel} **工具自报成功但产物为空**：退出码 0，产物 0 字节（${r.artifactRel}）` };
  }
  return { verdict: 'ok', why: '' };
}

function runPowerShell(scriptRel, args, logName) {
  const shell = process.env.DSH_POWERSHELL || 'powershell.exe';
  const log = path.join(TMP, logName);
  const fd = fs.openSync(log, 'w');
  try {
    execFileSync(shell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', toolPath(scriptRel)
    ].concat(args), { stdio: ['ignore', fd, fd], cwd: ROOT });
    return { code: 0, spawnError: '', log: fs.readFileSync(log, 'utf8') };
  } catch (e) {
    /* `status === undefined` ＝ **没能跑起来**（解释器不在／被策略拒绝／超时）⇒ 环境不满足的那一类，
       由 `classifyToolRun()` 判 SKIP；有 status 就是工具自己的退出码 ⇒ 归 fail。 */
    return {
      code: e.status === undefined ? -1 : e.status,
      spawnError: e.status === undefined ? String(e.code || e.message || e) : '',
      log: fs.readFileSync(log, 'utf8')
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** 跑 git 命令并把 stdout 收到文件（同样避开管道） */
function gitOutput(args, logName) {
  const log = path.join(TMP, logName);
  const fd = fs.openSync(log, 'w');
  try {
    execFileSync('git', args, { stdio: ['ignore', fd, 'ignore'], cwd: ROOT });
  } catch (e) {
    /* 非零退出也照样读文件 */
  } finally {
    fs.closeSync(fd);
  }
  return fs.readFileSync(log, 'utf8');
}

/* ---------------- 样例 Markdown（覆盖工具说明第四章承诺的全部语法） ---------------- */
const SAMPLE_MD = `# 一级标题

普通段落，含 **加粗文字**、\`行内代码\` 与中文标点。

## 二级标题

- 项目符号第一项
  - 缩进的第二级
- 项目符号第二项

1. 编号列表第一项
2. 编号列表第二项

> 引用块：这里是被引用的一段话。

\`\`\`
const a = 1;
console.log(a);
\`\`\`

---

### 三级标题

| 参数 | 说明 |
| --- | --- |
| depth | 航行器水下深度 |
| cameraDepth | 相机水下深度 |

#### 四级标题

![图 1　设备状态页](../../src/assets/screenshots/01-设备状态-任务曲线.png)

![图 2　任务数据页](../../src/assets/screenshots/02-任务数据.png){w=60}

![图 3　缺失图片](不存在的目录/缺图.png)
`;

async function main() {
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

  /* ===== D1 md2docx 基础版 ===== */
  section('D1 md2docx 基础版转换覆盖面（工具说明第四章）');
  const sampleMd = path.join(TMP, 'tools-sample.md');
  const basicDocx = path.join(TMP, 'tools-sample-basic.docx');
  const imgDocx = path.join(TMP, 'tools-sample-img.docx');
  fs.writeFileSync(sampleMd, SAMPLE_MD, 'utf8');
  for (const f of [basicDocx, imgDocx]) if (fs.existsSync(f)) fs.unlinkSync(f);

  const basic = runPowerShell('tools/md2docx.ps1', ['-InPath', sampleMd, '-OutPath', basicDocx, '-DocTitle', '自检样例'], 'md2docx-basic.log');
  /* `E116`：**退 0 但无产物 ⇒ FAIL 并指名**（不再记 SKIP）；SKIP 只留给真·环境不满足。 */
  const basicStat = fs.existsSync(basicDocx) ? fs.statSync(basicDocx).size : null;
  const basicVerdict = classifyToolRun({
    toolExists: fs.existsSync(toolPath('tools/md2docx.ps1')), spawnError: basic.spawnError, code: basic.code,
    artifactBytes: basicStat, artifactRel: path.relative(ROOT, basicDocx), toolLabel: 'md2docx 基础版'
  });
  if (basicVerdict.verdict !== 'ok') {
    const why = `${basicVerdict.why}；工具日志末 3 行：${basic.log.trim().split('\n').slice(-3).join(' / ')}`;
    if (basicVerdict.verdict === 'skip') skip('md2docx 基础版语法覆盖', why);
    else check('md2docx 基础版语法覆盖', false, why);
  } else {
    const doc = zipEntryText(basicDocx, 'word/document.xml');
    const styles = zipEntryText(basicDocx, 'word/styles.xml');
    check('四级标题均写入且带大纲级别', ['Heading1', 'Heading2', 'Heading3', 'Heading4'].every(h => styles.includes(`w:styleId="${h}"`)) && /w:pStyle w:val="Heading1"/.test(doc),
      'styles.xml 或 document.xml 缺少 Heading1～4');
    check('表格转成 Word 表格且表头带底色', doc.includes('<w:tbl>') && doc.includes('DEEAF6'), '未找到 <w:tbl> 或表头底色 DEEAF6');
    check('项目符号列表转成 • / ◦ 两级', doc.includes('• ') && doc.includes('◦ '), '未找到 • 或 ◦ 前缀');
    check('编号列表保留序号', /1\. 编号列表第一项/.test(stripXml(doc)) || doc.includes('1. 编号列表'),
      '文档里找不到 "1. " 序号');
    check('引用块使用 Quote 样式', doc.includes('w:pStyle w:val="Quote"'), '未找到 Quote 样式');
    check('代码块使用 CodeBlock 样式', doc.includes('w:pStyle w:val="CodeBlock"'), '未找到 CodeBlock 样式');
    check('行内代码用等宽红字（A31515）', doc.includes('A31515'), '未找到 A31515 颜色');
    check('行内加粗写入 <w:b/>', doc.includes('<w:b/>'), '未找到 <w:b/>');
    check('分隔线写成段落下边框', doc.includes('<w:pBdr>') && doc.includes('w:bottom'), '未找到 <w:pBdr>/w:bottom');
    check('临时工作目录 ._docx_build 已清理', !fs.existsSync(path.join(TMP, '._docx_build')),
      `${path.relative(ROOT, path.join(TMP, '._docx_build'))} 仍残留`);
    const basicNames = [...zipEntries(basicDocx).keys()];
    check('新生成的 docx 部件名使用正斜杠（OPC 规范）', !basicNames.some(n => n.includes('\\')),
      `条目名用了反斜杠：${basicNames.slice(0, 3).join(' , ')}（打包处见 tools/md2docx.ps1 的 ZipFile::CreateFromDirectory）`);
  }

  /* ===== D1b md2docx-img 增强版 ===== */
  section('D1b md2docx-img 图片能力（工具说明第五章）');
  const img = runPowerShell('tools/md2docx-img.ps1', ['-InPath', sampleMd, '-OutPath', imgDocx, '-DocTitle', '自检样例图片版'], 'md2docx-img.log');
  /* `E116`：同一份处置判据（`classifyToolRun`）—— D1 与 D1b **不各写一套**。 */
  const imgStat = fs.existsSync(imgDocx) ? fs.statSync(imgDocx).size : null;
  const imgVerdict = classifyToolRun({
    toolExists: fs.existsSync(toolPath('tools/md2docx-img.ps1')), spawnError: img.spawnError, code: img.code,
    artifactBytes: imgStat, artifactRel: path.relative(ROOT, imgDocx), toolLabel: 'md2docx-img 图片版'
  });
  if (imgVerdict.verdict !== 'ok') {
    const why = `${imgVerdict.why}；工具日志末 3 行：${img.log.trim().split('\n').slice(-3).join(' / ')}`;
    if (imgVerdict.verdict === 'skip') skip('md2docx-img 图片能力', why);
    else check('md2docx-img 图片能力', false, why);
  } else {
    const names = [...zipEntries(imgDocx).keys()];
    const media = names.filter(n => n.includes('media'));
    const doc = zipEntryText(imgDocx, 'word/document.xml');
    check('图片已嵌入（word/media 条目 ≥ 2）', media.length >= 2, `media 条目 ${media.length} 个：${media.join(', ')}`);
    check('正文含图片引用 <w:drawing>', doc.includes('<w:drawing>'), '未找到 <w:drawing>');
    const text = stripXml(doc);
    check('图注文字写入正文', text.includes('图1设备状态页') || text.includes('图 1'), '未找到图注文字');
    const extents = [...doc.matchAll(/<wp:extent cx="(\d+)"/g)].map(m => Number(m[1]));
    check('{w=60} 的图片宽度小于默认图', extents.length >= 2 && Math.min(...extents) < Math.max(...extents) * 0.8,
      `实测 extent cx：${extents.join(' / ')}`);
    check('缺图容错：占位提示且转换不中断', text.includes('图片缺失'), '未找到「图片缺失」占位文字');
    check('图片版临时工作目录已清理', !fs.existsSync(path.join(TMP, '._docx_build')), '._docx_build 仍残留');
  }

  /* ===== D2 提交信息格式 ===== */
  section('D2 提交信息格式（PROJECT_RULES 6.1/6.2）');
  const subjects = gitOutput(['log', '--pretty=format:%s'], 'git-subjects.txt').split('\n').map(s => s.trim()).filter(Boolean);
  /* 类型表必须与 PROJECT_RULES 6.2 一致；D5 段有断言逐项核对（2026-09-20 补上漏掉的「记录」） */
  const TYPES = ['新增', '修改', '修复', '删除', '文档', '样式', '重构', '构建', '记录'];
  const badSubject = subjects.filter(s => !new RegExp(`^(${TYPES.join('|')}): \\S`).test(s));
  check('每条提交都按「类型: 说明」书写', subjects.length > 0 && badSubject.length === 0,
    badSubject.length ? `不合规：${badSubject.join(' | ')}` : `共 ${subjects.length} 条`);
  const tooLong = subjects.filter(s => s.replace(/^[^:]+:\s*/, '').length > 30);
  check('提交说明不超过 30 字（6.1）', tooLong.length === 0,
    tooLong.map(s => `${s.slice(0, 40)}…（${s.replace(/^[^:]+:\s*/, '').length} 字）`).join('；'));

  /* ===== D3 项目记录与仓库现状 ===== */
  section('D3 项目记录与仓库现状一致性');
  const snapshot = readText('项目记录/当前状态快照.md');
  const head = gitOutput(['rev-parse', '--short', 'HEAD'], 'git-head.txt').trim();
  const claimedHead = (snapshot.match(/最新提交\s*`?([0-9a-f]{7,40})`?/) || [])[1];
  /* 快照里写死哈希有个自相矛盾：提交快照本身就会让哈希过期。
     因此规范做法是"以 git log -1 为准"的版本无关表述；若仍写死哈希，则必须等于当前 HEAD。 */
  const versionAgnostic = /最新提交以\s*`git log -1`\s*为准/.test(snapshot);
  check(
    '快照的"最新提交"采用版本无关表述或等于当前 HEAD',
    versionAgnostic || claimedHead === head,
    versionAgnostic ? '' : `快照写 ${claimedHead || '（未写）'}，实际 HEAD=${head}（建议改为"以 git log -1 为准"）`
  );

  const rulesVersion = (readText('PROJECT_RULES.md').match(/\|\s*版本\s*\|\s*v([\d.]+)/) || [])[1];
  const snapshotRules = (snapshot.match(/代码与结构规范\s*\|\s*\*\*v([\d.]+)\*\*/) || [])[1];
  /* 工作日志：**只认头部"当前版本"字段**（前 12 行），不扫全文。
     原判据在**全文**里匹配 "PROJECT_RULES.md **v<数字>**" 并取首个命中，于是正文里
     任何一句历史陈述（例如"PROJECT_RULES.md **v1.30**（历次版本…）"）都会被当成
     "当前声明" ⇒ 规范每次升版都**假红**（2026-09-29 实测踩到）。口径与 docs-cross-check 一致。
     注：本注释内不得出现反引号包裹的正则字面量（会提前闭合块注释，见 E15/E40 同族）。 */
  const logHead = readText('项目记录/工作日志.md').split(/\r?\n/).slice(0, 12).join('\n');
  const logRules = (logHead.match(/规范\s*\*\*v([\d.]+)\*\*/) || [])[1];
  check('快照声明的规范版本等于 PROJECT_RULES.md 头部版本',
    rulesVersion !== undefined && snapshotRules === rulesVersion,
    `PROJECT_RULES=v${rulesVersion}，快照=v${snapshotRules}`);
  if (logRules === undefined) {
    skip('工作日志声明的规范版本一致', '工作日志头部没有声明规范版本');
  } else {
    check('工作日志声明的规范版本等于 PROJECT_RULES.md 头部版本', logRules === rulesVersion,
      `PROJECT_RULES=v${rulesVersion}，工作日志头部=v${logRules}`);
  }

  const reqDoc = fs.readdirSync(path.join(ROOT, '需求文档')).filter(n => n.endsWith('.md'));
  const reqText = reqDoc.length ? readText(path.join('需求文档', reqDoc[0])) : '';
  /* 只统计 §12.2「待确认事项」表：§12.1 是已确认/已关闭项，不能混进来 */
  const sec122Start = reqText.indexOf('### 12.2');
  const sec122End = sec122Start < 0 ? -1 : reqText.indexOf('\n## ', sec122Start);
  const sec122 = sec122Start < 0 ? '' : reqText.slice(sec122Start, sec122End < 0 ? undefined : sec122End);
  const openItems = sec122.split('\n').filter(l => /^\|\s*Q-\d+\s*\|/.test(l));
  const claimedOpen = Number((sec122.match(/未关闭，共\s*(\d+)\s*项/) || [])[1]);
  check('需求清单声明的未关闭事项数等于 §12.2 表内行数', claimedOpen === openItems.length,
    `声明 ${claimedOpen} 项，表内 ${openItems.length} 行`);

  /* 2026-09-19 审查报告 ⑨：需求清单第 14 章的"已同步至 V1.25"残留已在 V1.27 改为版本无关表述；
     这里由"记录一致性"改为"残留已清除"的正向断言，防止旧表述再次回潮。 */
  const legacyGone = !reqText.includes('前端 Demo 已同步至 V1.25');
  check('需求清单第 14 章已改为版本无关表述（旧「已同步至 V1.25」残留已清除）', legacyGone,
    legacyGone ? '' : '需求清单正文仍写着「前端 Demo 已同步至 V1.25」');
  const snapshotClaimsLegacy = snapshot.includes('前端 Demo 已同步至 V1.25');
  check('快照不再声称该残留仍存在（V1.27 已修复）', !snapshotClaimsLegacy,
    snapshotClaimsLegacy ? '快照 §5.3 仍记录该残留' : '');

  const testScripts = fs.readdirSync(path.join(ROOT, 'tests')).filter(n => n.endsWith('.js'));
  const testsReadme = readText('tests/README.md');
  const unregistered = testScripts.filter(n => !testsReadme.includes(n));
  check('tests/ 下的脚本都已在 tests/README.md 登记', unregistered.length === 0,
    unregistered.length ? `未登记：${unregistered.join('、')}` : `共 ${testScripts.length} 个脚本`);

  const shots = fs.readdirSync(path.join(ROOT, 'src', 'assets', 'screenshots')).filter(n => n.endsWith('.png'));
  const claimedShots = Number((readText('tools/Markdown转Word工具说明.md').match(/本次[《]?前端界面 Demo 说明[》]?中的\s*(\d+)\s*张/) || [])[1]);
  check('工具说明称的截图张数等于实际截图数量', claimedShots === shots.length,
    `说明写 ${claimedShots} 张，实际 ${shots.length} 张`);

  /* 陈述与实际一致性：tests\ 已有脚本后，文档不得再称"未引入自动化测试"（2026-09-19 曾出现该漂移） */
  const staleClaims = [];
  for (const f of ['tests/README.md', 'README.md', 'PROJECT_RULES.md']) {
    const t = readText(f);
    for (const re of [/尚未引入[^\n]{0,20}测试/, /未引入[^\n]{0,20}自动化/, /手工验证清单（后期放自动化测试）/, /后期引入测试工具后/, /仅[有存]手工验证清单/]) {
      const m = t.match(re);
      if (m) staleClaims.push(`${f}：「${m[0].slice(0, 22)}」`);
    }
  }
  check(
    `文档不再声称"未引入自动化测试"（实际已有 ${testScripts.length} 个零依赖脚本）`,
    staleClaims.length === 0,
    staleClaims.join('；')
  );

  /* ===== D4 对外文档与实现一致性 ===== */
  section('D4 对外文档与实现一致性');
  const fieldMapSrc = readText('src/config/fieldMap.js');
  /* 只取 boardToReport 块内的键，避免把 samplePayload（上位机报文样例）混进来 */
  const reportBlock = (fieldMapSrc.match(/boardToReport:\s*\{([\s\S]*?)\n    \}/) || [])[1] || '';
  const reportFields = [...reportBlock.matchAll(/([A-Za-z_]\w*):\s*'/g)].map(m => m[1]);
  const mesDocPath = '输出文件/MES方/接口澄清函-致MES方.md';
  const mesDoc = readText(mesDocPath);
  const missingInMes = reportFields.filter(f => !new RegExp(`\\b${f}\\b`).test(mesDoc));
  check('MES 澄清函覆盖附录 2 的全部上报字段（附录 2 全文随附，C-49）', missingInMes.length === 0,
    missingInMes.length ? `函件未提及：${missingInMes.join('、')}` : `共 ${reportFields.length} 个字段`);

  /* 上位机侧只核对 IF-D.1 的实测数据项；字段名归 Q-21（由上位机方定义），
     所以中文字段名或英文字段名出现其一即算覆盖 */
  const IFD_FIELDS = [
    ['depth', '航行器水下深度'], ['speed', '航行速度'], ['velocity_x', '水平速度'], ['velocity_y', '垂直速度'],
    ['cameraDepth', '相机水下深度'], ['frameRate', '帧率'], ['gain', '增益'], ['shutter', '快门'],
    ['testStatus', '运行状态'], ['stage', '运行阶段'], ['collectTime', '采集时间']
  ];
  const upperDoc = readText('输出文件/上位机方/接口需求函-致设备上位机方.md');
  const missingUpper = IFD_FIELDS.filter(([token, zh]) => !upperDoc.includes(token) && !upperDoc.includes(zh));
  check('上位机接口需求函覆盖 IF-D.1 的实测数据项', missingUpper.length === 0,
    missingUpper.length ? `函件未提及：${missingUpper.map(x => x[0] + '/' + x[1]).join('、')}` : `共 ${IFD_FIELDS.length} 项`);

  const tabs = [...readText('src/pages/Dashboard.js').matchAll(/label:\s*'([^']+)'/g)].map(m => m[1]);
  const demoDoc = readText('输出文件/甲方/水池高速摄像生产管理看板-前端界面Demo说明.md');
  const missingPage = tabs.filter(t => !demoDoc.includes(t));
  check('甲方 Demo 说明覆盖 8 个页面名称', missingPage.length === 0,
    missingPage.length ? `说明里没有：${missingPage.join('、')}` : tabs.join('、'));

  const docFlags = new Set([...demoDoc.matchAll(/(--[a-z][a-z-]*)/g)].map(m => m[1]));
  const upperSrcFlags = new Set([...readText('tools/mock-upper/mock-upper.js').matchAll(/'(--[a-z-]+)'/g)].map(m => m[1]));
  const mesSrcFlags = new Set([...readText('tools/mock-mes/mock-mes.js').matchAll(/'(--[a-z-]+)'/g)].map(m => m[1]));
  const unknownFlags = [...docFlags].filter(f => !upperSrcFlags.has(f) && !mesSrcFlags.has(f) && f !== '--help');
  check('Demo 说明里出现的命令行参数都真实存在', unknownFlags.length === 0,
    unknownFlags.length ? `文档里有但工具没有：${unknownFlags.join('、')}` : `文档提到 ${docFlags.size} 个参数`);

  const pwd = (readText('src/services/mockData.js').match(/unlockPassword:\s*'([^']+)'/) || [])[1];
  check('文档中提到的演示密码与实现一致', pwd !== undefined && demoDoc.includes(pwd), `实现为 ${pwd}`);

  /* ===== D5 PROJECT_RULES 条款抽查 ===== */
  section('D5 PROJECT_RULES 条款抽查');

  /* 本脚本的提交类型表必须与规范 6.2 的类型表一致。
     立案原因（2026-09-20）：规范 6.2 在 2026-09-19 补了「记录」类型，但本脚本的 TYPES 没跟着加，
     于是"按规范写 `记录: …` 作 Summary"会被本门禁判成不合规 —— 门禁与规范打架，且**没有任何断言发现**。
     这里从脚本源码自身取出类型表，再与 6.2 的类型表逐项比，任一侧增删类型都会立刻变红。 */
  const selfSrc = fs.readFileSync(__filename, 'utf8');
  const selfTypes = [...(((selfSrc.match(/const TYPES = \[([^\]]+)\]/) || [])[1] || '').matchAll(/'([^']+)'/g))].map(m => m[1]);
  /* 只取 6.2 本节内容（截到下一个 ### 为止），否则会把后面 6.3/6.4/七/九 的表格一起吞进来 */
  const d62 = (readText('PROJECT_RULES.md').split('### 6.2 类型表')[1] || '').split('\n### ')[0];
  const specTypes = [...d62.matchAll(/^\|\s*([^\s|]+)\s*\|/gm)]
    .map(m => m[1])
    .filter(x => x !== '类型' && !/^-+$/.test(x));
  const missingInScript = specTypes.filter(x => !selfTypes.includes(x));
  const extraInScript = selfTypes.filter(x => !specTypes.includes(x));
  check('本脚本的提交类型表 = PROJECT_RULES 6.2 类型表',
    selfTypes.length > 0 && specTypes.length > 0 && missingInScript.length === 0 && extraInScript.length === 0,
    `脚本 ${selfTypes.length} 个 / 规范 ${specTypes.length} 个` +
    (missingInScript.length ? `；脚本缺：${missingInScript.join('、')}` : '') +
    (extraInScript.length ? `；脚本多：${extraInScript.join('、')}` : ''));

  for (const f of ['tools/md2docx.ps1', 'tools/md2docx-img.ps1']) {
    const b = fs.readFileSync(path.join(ROOT, f));
    const bom = b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
    check(`${path.basename(f)} 为 UTF-8 带 BOM（注意事项 1 / 第七章）`, bom, '缺少 BOM，中文参数会乱码');
  }

  const jsFiles = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|css|html)$/.test(e.name)) jsFiles.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  jsFiles.push(path.join(ROOT, 'index.html'));
  const tabbed = jsFiles.filter(f => fs.readFileSync(f, 'utf8').includes('\t'));
  check('src/ 与 index.html 不使用 Tab 缩进（第五章）', tabbed.length === 0,
    tabbed.map(f => path.relative(ROOT, f)).join('、'));

  const html = readText('index.html');
  const externalRefs = [...html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)].map(m => m[0]);
  check('index.html 不引用任何外链资源（NFR-25 内网隔离）', externalRefs.length === 0, externalRefs.join('、'));
  const externalImports = jsFiles.filter(f => /require\(['"][a-z@]/.test(fs.readFileSync(f, 'utf8')) || /^\s*import\s+.+\s+from\s+['"][a-z@]/m.test(fs.readFileSync(f, 'utf8')));
  check('src/ 不引入第三方库（NFR-25）', externalImports.length === 0,
    externalImports.map(f => path.relative(ROOT, f)).join('、'));

  const tracked = gitOutput(['-c', 'core.quotepath=false', 'ls-files'], 'git-ls-files.txt').split('\n').map(s => s.trim()).filter(Boolean);
  const leaked = tracked.filter(f => f.startsWith('来源文件/') || f.startsWith('reference/'));
  check('甲方原件（来源文件/、reference/）未被纳入版本库（第七章）', leaked.length === 0,
    leaked.slice(0, 5).join('、'));

  const rootReq = fs.readdirSync(path.join(ROOT, '需求文档')).filter(n => n.endsWith('.md'));
  check('需求文档根目录只放当前有效版本', rootReq.length === 1, `实际 ${rootReq.length} 个：${rootReq.join('、')}`);

  const rulesText = readText('PROJECT_RULES.md');
  const changeRows = [...rulesText.matchAll(/^\|\s*v(\d+\.\d+)\s*\|/gm)].map(m => m[1]);
  const dupVersions = changeRows.filter((v, i) => changeRows.indexOf(v) !== i);
  check('9.8 目录结构变更记录表无重复版本行', dupVersions.length === 0,
    dupVersions.length ? `重复登记：v${[...new Set(dupVersions)].join('、v')}（共 ${changeRows.length} 行）` : `共 ${changeRows.length} 行`);

  /* md ↔ docx 同源：凡是有同名 docx 的 md，其 1～2 级标题都应出现在 docx 正文里。
     判据本体＝`scanPairContent()`（`E13`：md 侧先剥行内标记再逐字比对；依据见该函数抬头）。 */
  const sameSrc = scanPairContent(['输出文件', '需求文档', 'tools']);
  const pairs = sameSrc.pairs;
  const stale = sameSrc.stale;
  check(`有 .docx 的 .md 与其 Word 版本内容同源（共 ${pairs} 对）`, stale.length === 0, stale.join('；'));

  /* ===== D6 需求清单"改名升级版本"必修项 ===== */
  /* 立案原因（2026-09-27 补）：需求清单是"改名升版本"的交付物。V1.34→V1.35、V1.35→V1.36、V1.36→V1.37
     三次改名都把文件名与正文升了，却三次漏改文末「本文档为 **V<版本>**」的 token（第三次由主代理人工发现
     `…-V1.37.md:905` 仍写 V1.36）—— 同一类缺陷连发 3 次，而 tests\ 里没有任何断言把它与文件名绑定
     （规范 9.5 的 D23「静态防空洞」）。本段只把"改名必修项"逐项绑定到**文件名版本**，
     不做全文版本号扫描（变更记录里的历史版本号是合法出现的）。 */
  section('D6 需求清单"改名升级版本"必修项（文末版本串／变更记录首段／同名 docx／编制日期）');
  const REQ_LIST_RE = /^(.+)-详细需求清单-V(\d+)\.(\d+)\.md$/;
  const REQ_DOCX_RE = /^(.+)-详细需求清单-V(\d+\.\d+)\.docx$/;
  const reqListNames = fs.readdirSync(path.join(ROOT, '需求文档')).filter(n => REQ_LIST_RE.test(n));
  /* 需求清单必须唯一，版本只从**文件名**取：这正是"改名忘改正文"能被打红的前提 */
  const reqListM = reqListNames.length === 1 ? reqListNames[0].match(REQ_LIST_RE) : null;
  const reqListRel = reqListM ? path.join('需求文档', reqListNames[0]) : '';
  const reqListText = reqListM ? readText(reqListRel) : '';
  const reqListVer = reqListM ? `${reqListM[2]}.${reqListM[3]}` : undefined;
  const reqLine = i => reqListText.slice(0, i).split('\n').length;
  const NO_REQ_MD = reqListNames.length
    ? `需求文档\\ 下有 ${reqListNames.length} 个「…-详细需求清单-V<主>.<次>.md」：${reqListNames.join('、')}`
    : '需求文档\\ 下找不到形如「…-详细需求清单-V<主>.<次>.md」的需求清单';

  /* ① 文末版本串 token ＝ 文件名版本（本次立案的那一处；取最后一次匹配，即文末） */
  const tailHits = [...reqListText.matchAll(/本文档为\s*\*\*V(\d+\.\d+)\*\*/g)];
  const tailHit = tailHits.length ? tailHits[tailHits.length - 1] : null;
  check('需求清单文末版本串 token = 文件名版本（改名必修项）',
    reqListM !== null && tailHit !== null && tailHit[1] === reqListVer,
    !reqListM ? NO_REQ_MD
      : tailHit === null ? `正文找不到形如「本文档为 **V<主>.<次>**」的文末版本串（${reqListRel}）`
        : `文末版本串 V${tailHit[1]} ≠ 文件名 V${reqListVer}（${reqListRel}:${reqLine(tailHit.index)}）—— 改名升版本时这一处 token 漏改`);

  /* ② 变更记录首段标题 ＝ ### V<前一版> → V<当前版>（升版时须在变更记录最前面加一节） */
  const changeLogAt = reqListText.indexOf('## 变更记录');
  const changeLog = changeLogAt < 0 ? '' : reqListText.slice(changeLogAt);
  const firstLog = changeLog.match(/^###\s+V(\d+\.\d+)\s*→\s*V(\d+\.\d+)\s*$/m);
  /* 次版本号减 1 即前一版（1.37 ⇒ 1.36）；次版本号为 0 时退化为"首段标题的目标版本 = 文件名版本" */
  const curMinor = reqListM ? Number(reqListM[3]) : -1;
  const wantLog = reqListM && curMinor >= 1 ? `### V${reqListM[2]}.${curMinor - 1} → V${reqListM[2]}.${reqListM[3]}` : null;
  check('需求清单变更记录首段标题 = ### V<前一版> → V<当前版>（改名必修项）',
    wantLog !== null ? (firstLog !== null && firstLog[0].trim() === wantLog) : (firstLog !== null && firstLog[2] === reqListVer),
    !reqListM ? NO_REQ_MD
      : changeLogAt < 0 ? `正文找不到「## 变更记录」章节（${reqListRel}）`
        : firstLog === null ? `「## 变更记录」后找不到形如「### V<前一版> → V<当前版>」的首段标题（${reqListRel}）`
          : `首个变更记录标题「${firstLog[0].trim()}」（${reqListRel}:${reqLine(changeLogAt + firstLog.index)}）≠ 期望「${wantLog || `### V<前一版> → V${reqListVer}`}」`);

  /* ③ .md 与 .docx 成对：同名同版本存在，且根目录不留其他版本（归档规则废止后只放当前有效版本） */
  const reqDocxNames = fs.readdirSync(path.join(ROOT, '需求文档')).filter(n => n.endsWith('.docx'));
  const wantDocx = reqListM ? reqListNames[0].replace(/\.md$/, '.docx') : undefined;
  check('需求文档\\ 下存在与需求清单同版本同名的 .docx（改名必修项）',
    wantDocx !== undefined && reqDocxNames.includes(wantDocx),
    wantDocx === undefined ? NO_REQ_MD : `缺 ${wantDocx}（实际 .docx：${reqDocxNames.join('、') || '无'}）`);
  const otherDocx = wantDocx === undefined ? [] : reqDocxNames.filter(n => REQ_DOCX_RE.test(n) && n !== wantDocx);
  check('需求文档\\ 下不存在其他版本的需求清单 .docx（只留当前有效版本）',
    wantDocx !== undefined && otherDocx.length === 0,
    wantDocx === undefined ? NO_REQ_MD : `多出 ${otherDocx.join('、')}；应只留 ${wantDocx}`);

  /* ④ 页首「编制日期」行的同类必修项：当前版本必须已登记且加粗（三次改名都改对了这一处，一并锁住） */
  const dateRowM = reqListText.match(/^\|\s*编制日期\s*\|([^\n]*)\|\s*$/m);
  const dateRow = dateRowM ? dateRowM[1] : '';
  const datedVers = [...dateRow.matchAll(/V(\d+\.\d+)\s*修订于/g)].map(m => m[1]);
  const verCmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1]; };
  const latestDated = datedVers.length ? datedVers.slice().sort(verCmp).pop() : undefined;
  const curBold = reqListVer !== undefined && new RegExp(`\\*\\*V${reqListVer.replace('.', '\\.')}\\s+修订于`).test(dateRow);
  check('需求清单页首「编制日期」行已登记当前版本并加粗（改名必修项）',
    dateRow !== '' && latestDated === reqListVer && curBold,
    !reqListM ? NO_REQ_MD
      : dateRow === '' ? `找不到「| 编制日期 |」行（${reqListRel}）`
        : `最新登记 V${latestDated || '（无）'} ≠ 文件名 V${reqListVer}${curBold ? '' : `；且当前版本未写成「**V${reqListVer} 修订于 …**」`}（行内登记：${datedVers.join('、') || '无'}）`);

  /* ---------------- 汇总 ---------------- */
  console.log('\n=== 汇总 ===');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项，跳过 ${skipped} 项`);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ' —— ' + f.detail : ''}`));
    process.exit(1);
  }
  process.exit(0);
}

/* ---------------- 入口接线 ----------------
   `E13`（T-20261004-09）：把两个纯函数显式导出，**供定点回归在进程内直接调用**
   （`E116` 立的规矩：换的是"被测输入"，不是去改真工具/真产物）。
   作为脚本运行时行为一字不变（`node tests\docs-check.js` ⇒ 仍跑 `main()`）；
   被 `require()` 时不再自动跑门禁（否则探针 require 一下就整轮退 1）。
   注意：`main().catch(...)` 必须留在**文件尾**（`harness-check` 十六节的要求），故这里用
   `require.main !== module` 的提前退出来跳过入口，`.catch` 仍是最后一条语句；导出写在它**之前**。 */
module.exports = { stripInlineMarkup, scanPairContent };

if (require.main !== module) return;   /* 被 require ⇒ 只当纯函数库用，不跑门禁（脚本运行不受影响） */

main().catch(err => {
  console.error('\n自检脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
