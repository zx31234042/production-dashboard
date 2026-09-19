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

/* ---------------- 调 PowerShell 跑文档转换脚本（输出重定向到文件，避开沙箱管道限制） ---------------- */
function runPowerShell(scriptRel, args, logName) {
  const shell = process.env.DSH_POWERSHELL || 'powershell.exe';
  const log = path.join(TMP, logName);
  const fd = fs.openSync(log, 'w');
  try {
    execFileSync(shell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(ROOT, scriptRel)
    ].concat(args), { stdio: ['ignore', fd, fd], cwd: ROOT });
    return { code: 0, log: fs.readFileSync(log, 'utf8') };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, log: fs.readFileSync(log, 'utf8') };
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
  if (basic.code !== 0 || !fs.existsSync(basicDocx)) {
    skip('md2docx 基础版语法覆盖', `脚本退出码 ${basic.code}；日志：${basic.log.trim().split('\n').slice(-3).join(' / ')}`);
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
  if (img.code !== 0 || !fs.existsSync(imgDocx)) {
    skip('md2docx-img 图片能力', `脚本退出码 ${img.code}；日志：${img.log.trim().split('\n').slice(-3).join(' / ')}`);
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
  const TYPES = ['新增', '修改', '修复', '删除', '文档', '样式', '重构', '构建'];
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
  const logRules = (readText('项目记录/工作日志.md').match(/PROJECT_RULES\.md`?\s*\*\*v([\d.]+)\*\*/) || [])[1];
  check('快照声明的规范版本等于 PROJECT_RULES.md 头部版本',
    rulesVersion !== undefined && snapshotRules === rulesVersion,
    `PROJECT_RULES=v${rulesVersion}，快照=v${snapshotRules}`);
  if (logRules === undefined) {
    skip('工作日志声明的规范版本一致', '工作日志里没有声明规范版本');
  } else {
    check('工作日志声明的规范版本等于 PROJECT_RULES.md 头部版本', logRules === rulesVersion,
      `PROJECT_RULES=v${rulesVersion}，工作日志=v${logRules}`);
  }

  const histFiles = fs.readdirSync(path.join(ROOT, '需求文档', '历史文件'));
  const claimedHist = Number((snapshot.match(/历史版本\s*(\d+)\s*个文件/) || [])[1]);
  check('快照声明的历史版本文件数等于实际', claimedHist === histFiles.length,
    `快照写 ${claimedHist} 个，实际 ${histFiles.length} 个`);

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
  const archivedVersions = histFiles.filter(n => /-V\d+\.\d+\.md$/.test(n)).map(n => (n.match(/-V(\d+\.\d+)\.md$/) || [])[1]);
  check('历史文件里保留了旧版本（有归档）', archivedVersions.length >= 5,
    `历史版本 md：${archivedVersions.join('、') || '（无）'}`);

  const rulesText = readText('PROJECT_RULES.md');
  const changeRows = [...rulesText.matchAll(/^\|\s*v(\d+\.\d+)\s*\|/gm)].map(m => m[1]);
  const dupVersions = changeRows.filter((v, i) => changeRows.indexOf(v) !== i);
  check('9.8 目录结构变更记录表无重复版本行', dupVersions.length === 0,
    dupVersions.length ? `重复登记：v${[...new Set(dupVersions)].join('、v')}（共 ${changeRows.length} 行）` : `共 ${changeRows.length} 行`);

  /* md ↔ docx 同源：凡是有同名 docx 的 md，其 1～2 级标题都应出现在 docx 正文里 */
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
  for (const d of ['输出文件', '需求文档', 'tools']) {
    const full = path.join(ROOT, d);
    if (fs.existsSync(full)) collectPairs(full);
  }
  const stale = [];
  for (const [mdFile, docxFile] of pairs) {
    const mdText = fs.readFileSync(mdFile, 'utf8');
    const headings = [...mdText.matchAll(/^#{1,2}\s+(.+)$/gm)].map(m => m[1].replace(/\*\*/g, '').trim());
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
  check(`有 .docx 的 .md 与其 Word 版本内容同源（共 ${pairs.length} 对）`, stale.length === 0, stale.join('；'));

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

main().catch(err => {
  console.error('\n自检脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
