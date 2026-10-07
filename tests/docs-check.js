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


  /* ===== D6b 对外函件／设计说明书的**版本一致性**（`E30`） =====
     立案（`E30`，2026-09-27 由 T5 补 D6 时一并报出、主代理复核）：需求清单**自身**的"改名必修项"已有 5 条断言
     （上面 D6），但**对外交付文档**这一层仍有两处空洞：①设计说明书的「文档版本」行与**文件名版本**无绑定；
     ②各收件方**最新一批函件**的「依据文件」行写的是**哪个需求版本**没有任何机器判据
     （`E30` 立案时的实测：`需求确认函`／`接口需求函`／`MES 澄清函` 写 V1.27、设计说明书依据 V1.30、
     `MES 澄清函（第二批）`写 V1.31、上位机第二批函件写 V1.37 —— 而当前基线是 V1.44）。
     ③已发出的**历史函件不宜断言**（属历史件，只能人工核对）⇒ 本段只断「**最新一批**」。
     **口径**（与 6.1「提交信息不写易变数字」同精神：不钉死版本串，版本号从需求清单**文件名**现取）：
       · 对每个收件方目录，取「最后修改时间最新」的那份**函件**（＝最新一批；与文件内容里的日期无关）；
       · 两条可机器判定的事实：⒜ 它**声明了**需求基线版本（「依据文件」行里有 `V<主>.<次>`）；
         ⒝ 各收件方**最新一批互相一致**（同一批交付引用同一条基线 —— 不一致就是"这批里有的函件
         拿旧基线编的"，正是 `E30` 要防的漂移，而且它**不依赖**"输出文件\ 今天是否已随基线升版"）。
       · **与"当前基线"是否相等**单独作为**读数**打印并如实注明，**不作断言** —— 详见 `E30-GAP` 那一段。
     ⚠ `输出文件\` 是**交付物面**：本段**只读**（含 D22 变异，全部走 `._verify` 下的副本）—— `E30③`。 */

  /** `[INFO]` 读数行（本文件既有形态；`check()` 只打 PASS/FAIL） */
  const infoE30 = msg => console.log('  [INFO] ' + msg);

  /* ① 设计说明书：「文档版本」行 ＝ **文件名版本**（与 D6 的"改名必修项"同域，对象换成对外说明书） */
  const designRel = '输出文件/甲方/水池高速摄像生产管理看板-系统设计说明书-V1.0.md';
  const designText = readText(designRel);
  const designFileVer = (designRel.match(/-V(\d+\.\d+)\.md$/) || [])[1];
  const designVerRowM = designText.match(/^\|\s*文档版本\s*\|([^\n]*)\|\s*$/m);
  const designVerRow = designVerRowM ? designVerRowM[1] : '';
  const designRowVer = (designVerRow.match(/V(\d+\.\d+)/) || [])[1];      /* 该格里的**第一个**版本次号 */
  check('对外：`输出文件\\甲方\\…-系统设计说明书-V<版本>.md` 的「文档版本」行 ＝ **文件名版本**' +
    '（`E30①`；只断"两处一致"，不钉死某个版本串 ⇒ 以后升版只需这两处相符）',
    designFileVer !== undefined && designRowVer !== undefined && designRowVer === designFileVer,
    designFileVer === undefined ? `文件名里找不到「-V<主>.<次>.md」版本（${designRel}）`
      : designVerRowM === null ? `找不到「| 文档版本 |」行（${designRel}）`
        : `「文档版本」写 V${designRowVer} ≠ 文件名 V${designFileVer}（${designRel}）—— 改名升版本时这一处漏改`);

  /* ② 最新一批对外函件：「依据文件」行的需求基线版本「有声明 ＋ 本批内一致」 */
  const extBaseEnv = process.env.DSH_DC_EXT_BASE_OVERRIDE;    /* 仅 D22 用：把 `输出文件` 换成本地副本 */
  const extBase = extBaseEnv || path.join(ROOT, '输出文件');
  /* **函件**的判据：按**文件名**认函件（`函`／`确认书`），其余 `.md`（提纲、附件、设计说明书等）
     不算"致某方的函件"，但要作为**读数**列出来 —— 否则"某目录最新那份不是函件"会被静默跳过。 */
  const LETTER_NAME_RE = /函|确认书/;
  const EXCLUDE_EXT_DIR = /^(离线部署与体检包-|交付物提纲-)/;
  /* ⚠ **绝对路径与相对路径都要能当 `base`**（D22 的副本是绝对路径）：
     `path.join(ROOT, '/abs/path')` 会拼成 `ROOT/abs/path`（**不是**取绝对路径）—— 实测踩过：
     副本扫描因此恒空、变异"看起来没生效"。故这里统一走 `absOf()`。 */
  const absOf = p => (path.isAbsolute(p) ? p : path.join(ROOT, p));
  const relOf = abs => path.relative(ROOT, abs).split(path.sep).join('/');
  const listDirAbs = abs => {
    try { return fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  };
  const readAbs = abs => {
    try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
  };
  /* ⚠ 取"最新"时用**绝对路径**消解同毫秒并列（`E113` 同族：不让"取哪一份"随文件系统抖动） */
  const newestIn = (dirAbs, filter) => {
    const cand = listDirAbs(dirAbs)
      .filter(e => e.isFile() && filter(e.name))
      .map(e => {
        const abs = path.join(dirAbs, e.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { mtimeMs = 0; }
        return { abs, rel: relOf(abs), mtimeMs };
      })
      .sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.abs.localeCompare(b.abs));
    return cand.length ? cand[cand.length - 1] : null;
  };
  /** 单份函件的判据（**纯函数**，供 D22 复用）：`{rel, declared, vers, ok, detail}` */
  const letterVersionVerdict = (rel, text, currentVer) => {
    const line = String(text || '').split('\n').find(l => /^\|\s*依据文件\s*\|/.test(l)) || '';
    const vers = [...line.matchAll(/V(\d+\.\d+)/g)].map(m => m[1]);
    const declares = vers.length > 0;
    const hasCurrent = currentVer !== undefined && vers.includes(currentVer);
    return { rel, declared: declares, hasCurrent, vers,
      ok: line !== '' && hasCurrent,
      detail: line === '' ? '没有「依据文件」行'
        : !declares ? '「依据文件」行里没有 `V<主>.<次>` 版本号'
          : hasCurrent ? `依据文件行含当前基线 V${currentVer}`
            : `依据文件行写的是 V${vers.join('/')} ≠ 当前需求基线 V${currentVer}` };
  };
  /** 扫一遍（`baseAbs` 可被 D22 覆盖）——**判据与读数同源**，不另立第二份取数。 */
  const scanNewestLetters = (baseAbs) => {
    const dirs = listDirAbs(baseAbs).filter(e => e.isDirectory() && !EXCLUDE_EXT_DIR.test(e.name))
      .map(e => e.name).sort();
    const rows = [];
    for (const d of dirs) {
      const dirAbs = path.join(baseAbs, d);
      const newestAny = newestIn(dirAbs, n => n.endsWith('.md'));
      const newestLetter = newestIn(dirAbs, n => n.endsWith('.md') && LETTER_NAME_RE.test(n));
      const text = newestLetter ? readAbs(newestLetter.abs) : null;
      rows.push({ dir: d, newestAny: newestAny ? newestAny.rel : null,
        newestLetter: newestLetter ? newestLetter.rel : null,
        verdict: newestLetter ? letterVersionVerdict(newestLetter.rel, text, reqListVer) : null,
        isLetter: newestAny !== null && newestLetter !== null && newestAny.abs === newestLetter.abs });
    }
    const verdicts = rows.filter(r => r.verdict).map(r => r.verdict);
    const declared = verdicts.filter(v => v.declared);
    const distinct = [...new Set(declared.flatMap(v => v.vers))].sort();
    return { base: relOf(baseAbs), dirs, rows, verdicts, declared, distinct,
      consistent: distinct.length === 1,
      notLetterRows: rows.filter(r => !r.isLetter) };
  };
  const e30Scan = scanNewestLetters(absOf(extBase));
  const NO_EXT_MD = `收件方目录里找不到任何 .md（扫描面=${e30Scan.base}\\；目录=${e30Scan.dirs.join('、') || '无'}）`;
  const notLetterNote = e30Scan.notLetterRows.length
    ? `；⚠ 这些目录里"最新那份不是函件"（该目录最新 .md=${e30Scan.notLetterRows.map(r => r.newestAny).join('、')}，` +
      `本段按函件口径取的是 ${e30Scan.notLetterRows.map(r => r.newestLetter || '（该目录无函件）').join('、')}）`
    : '';
  check('对外：`输出文件\\` 下**各收件方目录**里"最后修改时间最新"的那份**函件**，其「依据文件」行含**当前需求基线版本号**' +
    '（`E30②`：基线从需求清单**文件名**现取 ⇒ 升版后本条自动跟随，不钉死版本串；`E30③` 历史函件不改）',
    reqListM !== null && e30Scan.verdicts.length > 0 && e30Scan.verdicts.every(v => v.ok) &&
    e30Scan.declared.length === e30Scan.verdicts.length,
    reqListM === null ? NO_REQ_MD
      : e30Scan.verdicts.length === 0 ? NO_EXT_MD
        : e30Scan.verdicts.filter(v => !v.ok).map(v => `${v.rel}：${v.detail}`).join('；') + notLetterNote);

  /* `E30-GAP`（**读数**，与上面的断言**同源**、不另立取数）：最新一批引用的基线 vs 当前需求基线。
     ⚠ **本段当前的预期状态就是"红"**（如实登记，别把它读成"判据写坏了"）：
     盘上最新一批函件**确实**是旧的 —— MES 第二批 V1.31、上位机第二批 V1.37，而当前基线是 **V1.44**
     ⇒ 断言按 `E30` 的口径判红，并**逐文件指名**。修它要改 `输出文件\**`（**交付物面**，本包无写权限、
     也不许把交付件改绿来迎合判据）⇒ 这是**交付面的待升版事项**，不是判据缺陷。
     升版之后本读数与断言都会自然变绿（**没有**需要改判据的动作）。 */
  {
    const gapVers = e30Scan.distinct.filter(v => v !== reqListVer);
    infoE30(`E30-GAP 读数：最新一批函件引用的需求基线=${e30Scan.distinct.join('、') || '（无）'}；` +
      `当前需求基线 **V${reqListVer}**（取自 ${reqListRel}）；` +
      (gapVers.length ? `⇒ 差异 ${gapVers.map(v => 'V' + v).join('、')} ≠ V${reqListVer}（**交付面待升版**）`
        : '⇒ 两边一致'));
  }

  /* ③ 判据自身**可假**（`D23` 反面）：好样本与坏样本在**同一函数**上必须给出不同判定方向
     （否则"零命中"可能只是判据没工作）。 */
  const gfGood = letterVersionVerdict('（合成：含当前基线）', '| 依据文件 | 《详细需求清单 V1.44》；贵方《接口定义》 |', '1.44');
  const gfNoVer = letterVersionVerdict('（合成：无版本号）', '| 依据文件 | 《详细需求清单》；贵方《接口定义》 |', '1.44');
  const gfNoRow = letterVersionVerdict('（合成：无该行）', '（本函没有那一行）', '1.44');
  const gfOldVer = letterVersionVerdict('（合成：旧版本号）', '| 依据文件 | 《详细需求清单 V1.27》 |', '1.44');
  check('`E30` 判据自证（`D23` 反面）：同一判据对"依据文件行含**当前基线**"判绿、对"写旧版本号"／"没有版本号"／' +
    '"压根没有这一行"三种形态判红并**指名**（防"零命中"其实来自判据根本没在工作）',
    gfGood.ok === true && gfOldVer.ok === false && gfNoVer.ok === false && gfNoRow.ok === false &&
    gfOldVer.detail.includes('1.27') && gfNoVer.detail.includes('没有') && gfNoRow.detail.includes('没有'),
    `含当前基线 ok=${gfGood.ok}；旧版本号 ok=${gfOldVer.ok}（${gfOldVer.detail}）；` +
    `无版本号 ok=${gfNoVer.ok}（${gfNoVer.detail}）；无该行 ok=${gfNoRow.ok}（${gfNoRow.detail}）`);

  /** `输出文件\` 全部 .md 的字节指纹（用于"变异没动真文件"的自证；逐文件 sha12 拼接） */
  const extDirsSig = () => {
    const crypto = require('node:crypto');
    const parts = [];
    for (const r of e30Scan.rows) {
      const dirAbs = path.join(absOf(extBaseEnv || '输出文件'), r.dir);
      let names = [];
      try { names = fs.readdirSync(dirAbs).sort(); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.md')) continue;
        try {
          parts.push(`${r.dir}/${n}@`
            + crypto.createHash('sha256').update(fs.readFileSync(path.join(dirAbs, n))).digest('hex').slice(0, 12));
        } catch { /* 忽略 */ }
      }
    }
    return parts.join('|');
  };

  /* `D22` 变异①：把**最新那份函件**里的 `V<主>.<次>` 全换成另一个值 ⇒ **"本批一致"必红并指名它**
     （读数重定向到 `._verify` 下的副本；`输出文件\` 一个字节都不动 —— 由下面的字节指纹自证）。 */
  const E30_MUT_VER = 'V9.9';
  const withExtOverride = (muts, tag) => {
    const copyBase = path.join(TMP, `e30-ext-${tag}-${process.pid}`);
    /* ⚠ 递归删**必须**走 `env.removeLinkSafe`（`E161-A①`／`E103-B①`：`fs.rmSync(…,{recursive:true})`
       在受管面里是 A 档违规 —— 实测把我第一版点红了 2 处）。副本是自己刚建的普通目录，走它零风险。 */
    env.removeLinkSafe(copyBase, { recursive: true, force: true });
    for (const r of e30Scan.rows) {
      const srcDir = path.join(absOf(extBaseEnv || '输出文件'), r.dir);
      const dstDir = path.join(copyBase, r.dir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        const key = `${r.dir}/${e.name}`;
        const mut = muts[key];
        fs.writeFileSync(path.join(dstDir, e.name),
          mut === undefined ? fs.readFileSync(path.join(srcDir, e.name)) : Buffer.from(mut, 'utf8'));
      }
    }
    process.env.DSH_DC_EXT_BASE_OVERRIDE = copyBase;
    let scan = null, threw = null;
    try { scan = scanNewestLetters(copyBase); } catch (err) { threw = err; }
    delete process.env.DSH_DC_EXT_BASE_OVERRIDE;
    env.removeLinkSafe(copyBase, { recursive: true, force: true });
    return { scan, threw };
  };
  {
    /* 变异对象＝**最新那份函件**（跨全部收件方取 mtime 最新；与 `E30②` 的"每个目录各取一份"同源事实） */
    const newestOverall = e30Scan.rows.filter(r => r.newestLetter)
      .map(r => r.newestLetter)
      .map(rel => ({
        rel,
        m: (() => { try { return fs.statSync(path.join(ROOT, ...rel.split('/'))).mtimeMs; } catch { return 0; } })()
      }))
      .sort((a, b) => (a.m - b.m) || a.rel.localeCompare(b.rel)).pop();
    /* 变异键＝**目录/文件名**（与 `withExtOverride` 的 key 同形，两边不共用 `输出文件/` 前缀） */
    const mutKey = newestOverall ? newestOverall.rel.split('/').slice(1).join('/') : null;
    const mutText = newestOverall ? String(readAbs(path.join(ROOT, ...newestOverall.rel.split('/'))))
      .replace(/V\d+\.\d+/g, E30_MUT_VER) : '';
    const sigBefore = extDirsSig();
    const mm = mutKey ? withExtOverride({ [mutKey]: mutText }, 'd22-a') : { scan: null, threw: null };
    const sigAfter = extDirsSig();
    const bad = mm.scan ? mm.scan.verdicts.filter(v => !v.ok).map(v => v.rel) : [];
    /* 变异体**真的生效**的读数（**不靠路径匹配**：`split('/').slice(1).join('/')` 与扫描侧的
       `path.relative` 在 Windows 上未必逐字同形 —— 直接看"突变值是否出现在任何一份 verdict 里"）。 */
    const mutEffective = Boolean(mm.scan && mm.scan.distinct.includes(E30_MUT_VER.slice(1)) &&
      !mm.scan.verdicts.some(v => v.hasCurrent));
    check('`E30`-`D22` 变异①（**读数重定向到副本**）：把最新那份函件里所有 `V<主>.<次>` 换成 `' + E30_MUT_VER + '` ⇒ ' +
      '② 的判据**必红并指名该文件**（＝这条对账真的在读函件、且在比版本号，不是恒真式）；' +
      '`输出文件\\**` 与需求清单**逐字节不变**',
      newestOverall !== null && mm.threw === null && mm.scan !== null && mutEffective &&
      bad.length > 0 && sigBefore === sigAfter,
      newestOverall === null ? '没找到任何"最新一批函件"（② 已在逐目录指名）'
        : `变异对象=${newestOverall.rel}；变异已生效=${mutEffective}（突变值 ${E30_MUT_VER} 出现在各函件版本=${JSON.stringify(mm.scan ? mm.scan.distinct : null)} 里）；` +
          `判红文件=[${bad.join('、') || '（无）'}]；` +
          `本批一致=${mm.scan ? mm.scan.consistent : '—'}；` +
          `输出文件\\** 字节指纹不变=${sigBefore === sigAfter}${mm.threw ? `；抛出 ${mm.threw.message}` : ''}`);
  }

  /* `D22` 变异②：把设计说明书的「文档版本」格改成另一个版本串 ⇒ ① 必红并**指名该文件**（副本变异）。 */
  const designCopy = path.join(TMP, `e30-design-${process.pid}`, '系统设计说明书-V1.0.md');
  fs.mkdirSync(path.dirname(designCopy), { recursive: true });
  fs.writeFileSync(designCopy, designText.replace(/^(\|\s*文档版本\s*\|)([^\n]*)\|/m,
    (_m, a) => `${a} **V9.9（变异）** |`), 'utf8');
  {
    const mutText = fs.readFileSync(designCopy, 'utf8');
    const mutRowVer = (mutText.match(/^\|\s*文档版本\s*\|([^\n]*)\|\s*$/m) || [, ''])[1].match(/V(\d+\.\d+)/);
    const diskSame = fs.readFileSync(path.join(ROOT, designRel), 'utf8') === designText;
    check('`E30`-`D22` 变异②（**副本变异**）：把设计说明书的「文档版本」改成 `V9.9`（≠ 文件名 `V' +
      (designFileVer || '?') + '`）⇒ ① 的判据必红并**指名该文件**；盘上真文件逐字节不变',
      mutRowVer !== null && mutRowVer[1] === '9.9' && mutRowVer[1] !== designFileVer && diskSame,
      `变异后「文档版本」=V${mutRowVer ? mutRowVer[1] : '（取不到）'}、文件名=V${designFileVer}；` +
      `盘上真文件未变=${diskSame}（${designRel}）`);
    env.removeLinkSafe(path.dirname(designCopy), { recursive: true, force: true });
  }

  /* ===== D7 提交信息偏差登记名单（`E173`：偏差**计数**也是断言） =====
     【为什么"容许失败"的机制必须有计数守据（本段立案句）】
     D2 的两条断言判的是"**当前每一条提交都合规**"，于是它们对**已登记的历史偏差**永久失败。
     "永久失败"的意思不是"红着"，而是：**通过/失败计数不会再动** —— 今天新增一笔不合规提交
     （`2c4f594`「测试: …」就是实例，2026-10-05 主代理自己踩中），D2 的失败清单里会多一条，
     但汇总行仍是"通过 46 项，失败 2 项" ⇒ **新增偏差没有任何独立信号**，不会有人因为"计数变了"去看一眼。
     这正是本仓反复抓到的「**已登记的戳会盖住未登记的失败**」（`E156`／`E164`／`C·24`）
     在**提交信息**这一层的形态：**容错机制自己把新错误吃掉了**。
     ⇒ 修法：把"偏差**条数**"本身变成断言 —— **登记名单的条数 N**（硬编码常量）与 `git log` 实测的
     **不合规提交条数 M** 比对：**M > N ⇒ 红并逐条指名新增的那几笔**（完整哈希 ＋ 主题）；
     **M < N ⇒ 红并报"名单陈旧"**（登记了却实测不到 ⇒ 有人改写了历史，或名单写错/多写）。
     名单本身**只增不改写**（`PROJECT_RULES` 6.4 纪律：已推送的不合规提交一律不改写，只登记）。
     ⚠ 口径（`M` 数的是什么）：**逐提交、按完整哈希去重**（不是按主题去重）—— 否则"再写一笔 `review`"
     这种新增**不会**让计数变化，信号又没了（今天的 `测试:` 那笔恰好是新主题，按主题去重它也看得见；
     但按主题去重会给下一种形态留洞）。
     ⚠ 与既有守据的关系（不重复、不冲突）：`tests\harness-check.js` 第十一节比对的是
     `tests\run-all.js` 的 `REGISTERED_DEVIATIONS['docs-check'].listedItems`（**失败清单条数**）——
     它既不指名具体是哪几笔、也不判"名单陈旧"；本段补的正是**逐笔登记 ＋ 双向 ＋ 冻结点**，
     并把"`listedItems` 与本段名单是否同步"一并纳入判据（免得一处登记、另一处仍写旧数）。
     ⚠ **本段刻意放在 D2 段之外**：`harness-check` 第十一节用**源码切片**（`section('D2 提交信息格式…')`
     到 `/* ===== D3`）静态核对"D2 段断言名 ↔ 已登记偏差断言名"；新增断言若写进切片里，会被误算成
     "D2 段又加了一条断言"（＝换了豁免口子）⇒ 本段的断言**不是**那两条已登记偏差，**不得**进切片。
     ⚠ **如何登记新增（一句话操作说明）**：把新增的那一笔 `{ hash, subject, why }` **追加**到
     `E173_REGISTRY` 末尾，并把 `E173_ANCHOR` 的 `total` 与 `sha12` 改成**本断言判红详情里直接给出的
     新值**（照抄即可）；同时（**须负责人放行 —— 4b 无 `PROJECT_RULES.md`／`tests\run-all.js` 写权限**）
     把 `PROJECT_RULES.md` 6.4 的两个数字与 `tests\run-all.js` 的 `listedItems` 一起 ＋1。名单**只增**，
     历史**不改写**。 */
  section('D7 提交信息偏差登记名单（`E173`：偏差计数也是断言）');
  {
    /** **登记名单**（硬编码常量；出处＝`PROJECT_RULES.md` 6.4 逐条登记的那 13 笔）。
     *  字段：`hash`＝**完整**提交哈希（比对键，逐笔去重）；`subject`＝主题全文（留痕、可读）；
     *  `why`＝6.4 里的登记类别（逐条登记／同类早期）。**只增不改写**。 */
    const E173_REGISTRY = [
      { hash: '01d7aede00bc76a4d61bc7abfb4e95207bcaa621', subject: '修改: 附录2增至13字段并按责任方重新归口待确认事项，需求清单升 V1.26', why: '6.4 同类早期（主题 35 字 > 30）' },
      { hash: '0b2db3fffbb78d085729f59881a8ff736b877537', subject: 'review', why: '6.4 同类早期（缺前缀「review」）' },
      { hash: '3feb163356f83d44af93350505133540474c5f95', subject: '新增：接口适配层与配置化、模拟上位机与模拟 MES 联调工具', why: '6.4 同类早期（缺前缀：用了全角冒号「新增：…」）' },
      { hash: '41fa42d6b209a019352a1b726c086a775682db78', subject: 'review report', why: '6.4 同类早期（缺前缀「review report」）' },
      { hash: '870e54ab18da5f7c1a07c6bd0c26cfbad481f82f', subject: 'review', why: '6.4 同类早期（缺前缀「review」）' },
      { hash: '93f27a9f99ee9b07290f33f6c3f2933e80f69030', subject: '文档: 需求清单升 V1.28，正文附录 2 字段数统一为 13 构建: contract-check 新增字段数声明一致性断言', why: '6.4 逐条登记（主题 60 字 > 30；且 `文档:` 与 `构建:` 挤在同一行）' },
      { hash: 'a5ff9c7be2c893f4997cfde75bfef4a79b10763f', subject: 'review', why: '6.4 同类早期（缺前缀「review」）' },
      { hash: 'a6a6bd0001c613345174e4104421e9ad2dc2a288', subject: 'review', why: '6.4 同类早期（缺前缀「review」）' },
      { hash: 'be63c3734903d3e958849cd1df92e7859cb40eb5', subject: '记录: 登记 FR-5.10 与 FR-5.11 缺口及 FR-5.11 口径待定', why: '6.4 同类早期（主题 37 字 > 30；2026-09-30 本机 AI 提交，推送前由门禁当场发现）' },
      { hash: 'c269c4c07a5b048ab6171b2063fecb142201262e', subject: '代码审查', why: '6.4 逐条登记（类型不合规：无白名单类型前缀，主题为「代码审查」）' },
      { hash: 'dcb8274f5f7a49103337f4947072c5f0e799cad2', subject: '修改: 设备运行阶段简化为准备/运行/判定/完成，需求清单升 V1.25', why: '6.4 同类早期（主题 32 字 > 30）' },
      { hash: 'dffc2dc61f95fac9b6ad95c0ff71a14ac804dbbb', subject: 'test', why: '6.4 同类早期（缺前缀「test」）' },
      { hash: 'f9152eecd7d5b0b901b9793f88253da80e255716', subject: 'review', why: '6.4 逐条登记（类型不合规：无白名单类型前缀「review」）' },
      /* ⚠ `E173` 第 14 笔（2026-10-05 追加，**名单只增不改写**）：负责人当天"**批准登记**"
         （`PROJECT_RULES` 6.4 已同批改为"本表逐条登记 **4** 条／D2 段实际列出 **14** 条"，规范升 v1.39）
         ⇒ 本段名单同步 ＋1，`E173_ANCHOR` 改为 `total: 14`／`sha12: 'aa2200d1bd99'`；
         `tests\run-all.js` 的 `listedItems` 同批 **13 → 14**（本批**临时授权**，只许动这一个常量）。
         这一笔的"将来报警"能力由 `E173-②` 的 ㈠（把实测 M 改成 15 ⇒ 必红并指名）守着。 */
      { hash: '2c4f5945ce697fa1227469d27a14266c9057e34b', subject: '测试: E160地面自证与E161禁API落地', why: '6.4 逐条登记（**类型不在 6.2 白名单**：用了 `测试:`，应为 `修改:`；主题 22 字合规）' },
      /* ⚠ `E173` 第 15 笔（2026-10-05 追加，**名单只增不改写**）：主代理当天把提交写成
         `02e3530`「测试: E72判据改为时钟无关」——**类型不在 6.2 白名单**（用了 `测试:`，应为 `修改:`），
         按 6.4 纪律**登记不改写**（`PROJECT_RULES` 6.4 同批改为"本表逐条登记 **5** 条／D2 段实际列出
         **15** 条"，规范升 v1.41）⇒ 本段名单 ＋1，`E173_ANCHOR` 改为 `total: 15`／
         `sha12: 'df0af5e1c786'`；`tests\run-all.js` 的 `listedItems` 同批 **14 → 15**（本批**临时授权**，
         只许动这一个常量）。 */
      { hash: '02e353025b4fc2570e7d51eaed103de3f577984c', subject: '测试: E72判据改为时钟无关', why: '6.4 逐条登记（类型不在 6.2 白名单：用了 `测试:`，应为 `修改:`）' },
      /* ⚠ `E173` 第 16 笔（2026-10-05 追加，**名单只增不改写**）：主代理当天把提交写成
         `7b01ef9`「测试: E42E43E44E177E186落地并同步权威」——**类型不在 6.2 白名单**（用了 `测试:`，
         应为 `修改:`），按 6.4 纪律**登记不改写**（`PROJECT_RULES` 6.4 同批改为"本表逐条登记 **6** 条／
         D2 段实际列出 **16** 条"，规范升 v1.42）⇒ 本段名单 ＋1，`E173_ANCHOR` 改为 `total: 16`／
         `sha12: 'fffebc399a5c'`；`tests\run-all.js` 的 `listedItems` 同批 **15 → 16**（本批**临时授权**，
         只许动这一个常量）。 */
      { hash: '7b01ef990e3f8c0e75fab70df0a7c83986164b6c', subject: '测试: E42E43E44E177E186落地并同步权威', why: '6.4 逐条登记（类型不在 6.2 白名单：用了 `测试:`，应为 `修改:`）' },
    ];
    /** **冻结点锚点**（`E145` 的教训：锚点必须是**常量**，不能由清单现算 —— 现算＝自己对自己复读、零证伪能力）。
     *  清单被悄悄改过（删一条／改一条主题／换顺序）⇒ `sha12` 不符 ⇒ 当场红。 */
    const E173_ANCHOR = { total: 16, sha12: 'fffebc399a5c' };
    const sha12E173 = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 12);
    /** **判据（纯函数；主断言与 D22 同一把尺子）**：`measured`＝实测不合规提交的**完整哈希**数组；
     *  `registry`＝登记名单。返回双向读数（`E140`／`E145` 的"只增不减 ＋ 名单陈旧 ＋ 冻结点"机制）。 */
    const auditE173 = (measured, registry, anchor) => {
      const measuredSet = new Set(measured);
      const hashes = registry.map(e => e.hash);
      const regSet = new Set(hashes);
      const unregistered = measured.filter(h => !regSet.has(h));       /* M > N：新增（必红并指名） */
      const stale = hashes.filter(h => !measuredSet.has(h));           /* 名单陈旧（必红并报） */
      const dupReg = hashes.filter((h, i) => hashes.indexOf(h) !== i);
      const badField = registry.filter(e => !/^[0-9a-f]{40}$/.test(String(e.hash))
        || !String(e.subject || '').trim() || !String(e.why || '').trim()).map(e => e.hash);
      const sorted = registry.slice().sort((a, b) => String(a.hash).localeCompare(String(b.hash)));
      const sha12 = sha12E173(sorted.map(e => `${e.hash}|${e.subject}`).join('\n'));
      const anchorOk = anchor.total === registry.length && anchor.sha12 === sha12;
      return { unregistered, stale, dupReg, badField, sha12, total: registry.length, anchorOk };
    };
    /* 规则参数**从 D2 段源码里读**（免得两处各写一份规则再次漂移；与 `harness-check` 第十一节同法）。 */
    const selfSrcE173 = fs.readFileSync(__filename, 'utf8');
    const d2AtE173 = selfSrcE173.indexOf("section('D2 提交信息格式");
    const d2EndE173 = selfSrcE173.indexOf('/* ===== D3', d2AtE173);
    const d2SrcE173 = d2AtE173 < 0 || d2EndE173 < 0 ? '' : selfSrcE173.slice(d2AtE173, d2EndE173);
    const typesE173 = [...((d2SrcE173.match(/const TYPES = \[([^\]]*)\]/) || [])[1] || '')
      .matchAll(/'([^']+)'/g)].map(m => m[1]);
    const lenLimitE173 = Number((d2SrcE173.match(/\.length\s*>\s*(\d+)\)/) || [])[1]);
    const rowsE173 = gitOutput(['log', '--pretty=format:%H%x09%s'], 'e173-subjects.txt')
      .split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      .map((l) => { const p = l.split('\t'); return { hash: p[0], subject: p.slice(1).join('\t') }; });
    const ruleOkE173 = rowsE173.length > 0 && typesE173.length >= 5 && Number.isInteger(lenLimitE173);
    const badTypeE173 = rowsE173.filter(r => !new RegExp(`^(${typesE173.join('|')}): \\S`).test(r.subject)).map(r => r.hash);
    const tooLongE173 = rowsE173.filter(r => r.subject.replace(/^[^:]+:\s*/, '').length > lenLimitE173).map(r => r.hash);
    const measuredE173 = [...new Set([...badTypeE173, ...tooLongE173])];
    const subjectOfE173 = (h) => (rowsE173.find(x => x.hash === h) || { subject: '（主题未取到）' }).subject;
    const measuredTxtE173 = measuredE173.map(h => `\`${h.slice(0, 7)}\`「${subjectOfE173(h)}」`);
    const auditDiskE173 = ruleOkE173
      ? auditE173(measuredE173, E173_REGISTRY, E173_ANCHOR)
      : { unregistered: [], stale: [], dupReg: [], badField: [], total: E173_REGISTRY.length, anchorOk: false, sha12: '' };
    const runAllE173 = require('./run-all');
    const listedItemsE173 = runAllE173.REGISTERED_DEVIATIONS && runAllE173.REGISTERED_DEVIATIONS['docs-check']
      ? runAllE173.REGISTERED_DEVIATIONS['docs-check'].listedItems : null;
    const syncOkE173 = listedItemsE173 === E173_REGISTRY.length;
    /** 待登记的几笔（＝实测有、名单无）——判红详情里给**照抄即用**的登记行与新锚点。 */
    const pendingE173 = auditDiskE173.unregistered.map(h => ({
      hash: h, subject: subjectOfE173(h), why: '（待登记：2026-10-05 由 4b 报出，须负责人放行）'
    }));
    const newAnchorE173 = (() => {
      const all = E173_REGISTRY.concat(pendingE173)
        .slice().sort((a, b) => String(a.hash).localeCompare(String(b.hash)));
      return { total: all.length, sha12: sha12E173(all.map(e => `${e.hash}|${e.subject}`).join('\n')) };
    })();
    console.log(`  [E173] 登记名单 N=${E173_REGISTRY.length}（锚点 total=${E173_ANCHOR.total}／sha12=${E173_ANCHOR.sha12}；`
      + `现算 sha12=${auditDiskE173.sha12}；锚点相符=${auditDiskE173.anchorOk}；\`run-all.listedItems\`=${listedItemsE173}）；`
      + `git 实测不合规提交 M=${measuredE173.length}（类型不合规 ${badTypeE173.length} ＋ 超 ${lenLimitE173} 字 ${tooLongE173.length}，`
      + `逐笔按完整哈希去重）${ruleOkE173 ? '' : '；⚠ git 或规则参数取不到 ⇒ 本段不作判定依据'}`);
    check('E173-① **提交信息偏差计数断言**（`E173`）：登记名单条数 N 与 `git log` 实测不合规条数 M **双向比对**'
      + '（逐笔按**完整哈希**去重）—— `M > N` ⇒ **红并逐条指名新增的那几笔（哈希 ＋ 主题）**；'
      + '`M < N` ⇒ 红并报"**名单陈旧**"；名单只增不改写；并给**冻结点锚点**（条数 ＋ 逐条 `sha12`，常量、不由清单现算）；'
      + '且 N 与 `tests\\run-all.js` 的 `listedItems`（另一处登记）**同步**',
      ruleOkE173 && auditDiskE173.unregistered.length === 0 && auditDiskE173.stale.length === 0
        && auditDiskE173.dupReg.length === 0 && auditDiskE173.badField.length === 0
        && auditDiskE173.anchorOk && syncOkE173,
      (ruleOkE173
        ? `**M=${measuredE173.length}／N=${E173_REGISTRY.length} ⇒ 判红**：新增（未登记）${auditDiskE173.unregistered.length} 笔`
          + `${auditDiskE173.unregistered.length ? '＝' + auditDiskE173.unregistered.map(h => measuredTxtE173[measuredE173.indexOf(h)]).join('、') : ''}；`
          + `名单陈旧 ${auditDiskE173.stale.length} 笔${auditDiskE173.stale.length ? '＝' + auditDiskE173.stale.join('、') : ''}；`
          + `重复登记 ${auditDiskE173.dupReg.length}／字段不合形 ${auditDiskE173.badField.length}；`
          + `锚点相符=${auditDiskE173.anchorOk}（冻结 total ${E173_ANCHOR.total}／sha12 ${E173_ANCHOR.sha12}，现算 ${auditDiskE173.sha12}）；`
          + `与 \`run-all.listedItems\` 同步=${syncOkE173}（实测 ${listedItemsE173}）`
        : '⚠ git／规则参数取不到 ⇒ 本段**不作判定依据**（不等于通过）')
        + `。**要清掉这条红**（二选一，两条路都须**负责人放行** —— 4b 无 \`PROJECT_RULES.md\`／`
        + '`tests\\run-all.js` 写权限）：①按 6.4 纪律**登记**上面那几笔（把下面"待追加的登记行"追加进 '
        + `\`E173_REGISTRY\`，并把 \`E173_ANCHOR\` 改成 total: ${newAnchorE173.total}／sha12: '${newAnchorE173.sha12}'，`
        + `同时把 \`tests\\run-all.js\` 的 \`listedItems\` 与 \`PROJECT_RULES.md\` 6.4 的两个数字一起 `
        + `＋${pendingE173.length}）；②若负责人**不许登记**，那也是一种决定，须**显式写出**`
        + `（本条就永久红 —— 这正是"偏差有独立信号"的代价，` + '`E173`' + ` 立案要的就是这个信号）。`
        + ` 待追加的登记行（照抄）：`
        + (pendingE173.length
          ? pendingE173.map(e => `\n        { hash: '${e.hash}', subject: '${e.subject}', why: '${e.why}' },`).join('')
          : '（无）'));
    check('E173-② D22（可证伪，**四支内存变异 ＋ 负对照**）：同一 `auditE173()` 喂 —— '
      + `㈠**实测 M 比名单多 1 笔**（登记 ${E173_REGISTRY.length} 笔之后即 **M=${E173_REGISTRY.length + 1}**）⇒ 进 \`unregistered\`（**红并指名**）；`
      + '㈡登记名单**删**一条（`measured` 不变）⇒ 该笔进 `unregistered`（红）；'
      + '㈢登记名单**加**一笔历史里没有的哈希 ⇒ 进 `stale`（**报"名单陈旧"** ⇒ 红）；'
      + '㈣只改一条的**主题**（哈希不变）⇒ 冻结点 `sha12` **必不符**（⇒ 锚点不是清单对自己的复读）；'
      + '**负对照**＝盘上名单 ＋ "实测＝名单"的合成读数 ⇒ 四项全 0、锚点相符（**必绿**）',
      (() => {
        const reg = E173_REGISTRY;
        const hashes = reg.map(e => e.hash);
        const zz = 'a'.repeat(40);
        const yy = 'b'.repeat(40);
        const clean = auditE173(hashes, reg, E173_ANCHOR);
        const m1 = auditE173(hashes.concat([zz]), reg, E173_ANCHOR);
        const dropped = reg.slice(1);
        const m2 = auditE173(hashes, dropped,
          { total: dropped.length, sha12: auditE173(hashes, dropped, { total: dropped.length, sha12: '' }).sha12 });
        const added = reg.concat([{ hash: yy, subject: '（合成）', why: '（合成）' }]);
        const m3 = auditE173(hashes, added,
          { total: added.length, sha12: auditE173(hashes, added, { total: added.length, sha12: '' }).sha12 });
        const edited = reg.map((e, i) => (i === 0 ? { hash: e.hash, subject: e.subject + '（改过）', why: e.why } : e));
        const m4 = auditE173(hashes, edited, E173_ANCHOR);
        return clean.unregistered.length === 0 && clean.stale.length === 0 && clean.anchorOk === true
          && m1.unregistered.length === 1 && m1.unregistered[0] === zz
          && m2.unregistered.length === 1 && m2.unregistered[0] === reg[0].hash
          && m3.stale.length === 1 && m3.stale[0] === yy
          && m4.anchorOk === false && m4.sha12 !== E173_ANCHOR.sha12;
      })(),
      (() => {
        const reg = E173_REGISTRY;
        const hashes = reg.map(e => e.hash);
        const zz = 'a'.repeat(40);
        const yy = 'b'.repeat(40);
        const clean = auditE173(hashes, reg, E173_ANCHOR);
        const m1 = auditE173(hashes.concat([zz]), reg, E173_ANCHOR);
        const dropped = reg.slice(1);
        const m2 = auditE173(hashes, dropped,
          { total: dropped.length, sha12: auditE173(hashes, dropped, { total: dropped.length, sha12: '' }).sha12 });
        const added = reg.concat([{ hash: yy, subject: '（合成）', why: '（合成）' }]);
        const m3 = auditE173(hashes, added,
          { total: added.length, sha12: auditE173(hashes, added, { total: added.length, sha12: '' }).sha12 });
        const edited = reg.map((e, i) => (i === 0 ? { hash: e.hash, subject: e.subject + '（改过）', why: e.why } : e));
        const m4 = auditE173(hashes, edited, E173_ANCHOR);
        return `负对照（实测＝名单）⇒ unregistered ${clean.unregistered.length}／stale ${clean.stale.length}／锚点相符 ${clean.anchorOk}（都应绿）；`
          + `㈠` + '`measured`' + ` 多一笔未登记哈希 ⇒ unregistered ${m1.unregistered.length} 笔（指名 \`${m1.unregistered[0]}\`）；`
          + `㈡名单删一条 ⇒ unregistered ${m2.unregistered.length} 笔（指名 \`${m2.unregistered[0]}\`）；`
          + `㈢名单加一笔历史里没有的 ⇒ stale ${m3.stale.length} 笔（报"名单陈旧"，指名 \`${m3.stale[0]}\`）；`
          + `㈣只改一条主题 ⇒ 锚点现算 sha12 ${m4.sha12} ≠ 冻结 ${E173_ANCHOR.sha12}（必不符）`;
      })());
  }
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
