/* ==========================================================================
   跨文档一致性（tests/docs-cross-check.js）
   作用：检查**文档之间**的口径是否一致 —— 这是单看任何一份文档都发现不了的一类缺陷。
        2026-09-19 的一次性交叉验证曾用同类检查抓出 3 处真缺陷，其中 2 处
        （README 缺"MES 上报 13 字段"、规范 9.5 与 ADR-0002 的零依赖口径冲突）
        正是"文档之间的缺口/矛盾"。故按 ADR-0003 D18 转正为正式门禁。
   检查分组：
        一、版本号一致性          二、跨文档核心数字
        三、需求编号可追溯        四、目录描述 与 实际仓库
        五、技术栈断言 vs ADR      六、与规范 9.5 四条技术约束
        七、字段语义（易错项）     八、进度标注 与 实际状态
        九、测试侧边界（测试代码不得引用业务代码）
        十、权威门禁数字的机器校验（P2-22）
        十一、权威区逐脚本条数 ＝ 实跑值（P2-2，**账本快路径 + 冲突复核**）
   依赖：仅 Node 内置模块（纯文本读取 + 子进程落文件读回）。
   运行：node tests/docs-cross-check.js
   退出码：0 = 全部一致；1 = 有跨文档不一致（**失败项即待修缺陷**）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const env = require('./env');
const { createRunner } = require('./lib/assert');

/* 说明：环境变量 `DSH_DC_README_OVERRIDE`（**仅调试用**，正式运行不设它）用于把
   "被校验的 README"指向一份副本 —— 本机这台机器上有并发协作方在同时改 `tests\README.md`，
   要验证本节"全绿/变异即红"只能在一份**不受并发改写影响的副本**上做，否则同一份 README
   两次运行读到的内容都可能不同。不设它时读的就是真文件 `tests\README.md`。 */
const README_REL = process.env.DSH_DC_README_OVERRIDE || 'tests/README.md';

const ROOT = env.paths.root;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));

/* `T-20261003-12` 追加轮 3：把上面 `DSH_DC_README_OVERRIDE` 那套"**仅调试用**的读数重定向"
   推广到**第十五节（`E51`）要读的三份"当前值区"文档**。为什么要它：
   `E51` 的两端取证（数字改坏 ⇒ 断言红；锚点措辞删掉 ⇒ 前提红）必须**在变异体上跑**，
   而 `E51` 读的是**真受管文档** ⇒ 若像旧做法那样"写真文件→跑→还原"，就会
   ① 与并发门禁轮**互相污染读数**（实测已发生一次：座位 4b 的探针窗口与主代理的全量轮重叠，
      让 `docs-cross-check` 读到瞬时态 `门禁 **9999 通过`，被误登记为"运行期改写受管文档"）；
   ② 让"盘上不变量"无法在**并发**下成立。
   ⇒ 有了这三个出口，变异与取证可以**只作用于副本**：**真文件全程只读、逐字节不变**。
   **不设这三个环境变量时，读的就是原来的真文件**（与 `DSH_DC_README_OVERRIDE` 同口径，
   正式运行不设它们 ⇒ 行为逐字不变）。 */
const SNAP_REL = process.env.DSH_DC_SNAP_OVERRIDE || '项目记录/当前状态快照.md';
const ARCH_REL = process.env.DSH_DC_ARCH_OVERRIDE || '项目架构与技术栈.md';
const ROAD_REL = process.env.DSH_DC_ROAD_OVERRIDE || '项目记录/后续路线图.md';

/** 取需求文档当前基线文件名（只取 需求文档/ 根目录下的当前基线） */
function baselineReqFile() {
  const dir = path.join(ROOT, '需求文档');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  return files.sort().pop();
}

const t = createRunner('跨文档一致性（docs-cross-check）');
env.assertRuntime();

/* 注意：main 里第十一节优先**读取本轮 `run-all` 的实跑账**（`tests\._verify\run-totals.json`）
   取"实跑值"，只在"声明 ≠ 账"时对冲突脚本**单独复跑一次**（见该节 `resolveActuals` 注释）；
   探针全程同步、不 await，末尾仍是 `t.finish()` 退 0/1。 */
function main() {
  /* 输入文档集中读入，避免各处重复 IO */
  const arch = read('项目架构与技术栈.md');
  const readme = read('README.md');
  const rules = read('PROJECT_RULES.md');
  const snap = read('项目记录/当前状态快照.md');
  const log = read('项目记录/工作日志.md');
  const roadmap = read('项目记录/后续路线图.md');
  const testsReadme = read('tests/README.md');
  const reqFile = baselineReqFile();
  const req = read('需求文档/' + reqFile);
  const adr1 = read('项目记录/ADR/ADR-0001-后端形态与运行时选型.md');
  const adr2 = read('项目记录/ADR/ADR-0002-运行时选型Node.md');
  const adr3 = read('项目记录/ADR/ADR-0003-测试环境.md');
  const adrReadme = read('项目记录/ADR/README.md');

  /* ---------------- 一、版本号一致性 ---------------- */
  t.section('一、版本号一致性');
  const rulesV = (rules.match(/\|\s*版本\s*\|\s*v([\d.]+)/) || [])[1];
  const reqV = (reqFile.match(/-V([\d.]+)\.md$/) || [])[1];
  t.check('能定位规范版本与需求基线版本', Boolean(rulesV && reqV), `规范 v${rulesV} / 需求 V${reqV}`);
  t.check('架构文档声明的规范版本 = PROJECT_RULES 头部版本',
    arch.includes(`规范 **v${rulesV}**`), `期望 v${rulesV}`);
  t.check('架构文档声明的需求版本 = 需求文档基线版本',
    arch.includes(`需求清单 **V${reqV}**`), `期望 V${reqV}`);
  const snapRules = (snap.match(/代码与结构规范\s*\|\s*\*\*v([\d.]+)\*\*/) || [])[1];
  t.check('快照声明的规范版本 = PROJECT_RULES 头部版本',
    snapRules === rulesV, `快照 v${snapRules}`);
  /* 工作日志：**只认头部"当前版本"字段**，不扫全文。
     原判据是在**全文**里匹配 "PROJECT_RULES.md **v<数字>**" 并取首个命中，
     于是正文里任何一句历史陈述（例如"PROJECT_RULES.md **v1.30**（历次版本…）"）
     都会被当成"当前声明" ⇒ 规范每次升版都会**假红**（2026-09-29 实测踩到）。
     口径与快照一致：声明必须写在头部字段里，才算"本文件声明了规范版本"。
     注：本注释内不得出现反引号包裹的正则字面量（会把块注释提前闭合，见 E15/E40 同族）。 */
  const logHead = log.split(/\r?\n/).slice(0, 12).join('\n');
  const logRules = (logHead.match(/规范\s*\*\*v([\d.]+)\*\*/) || [])[1];
  t.check('工作日志声明的规范版本 = PROJECT_RULES 头部版本',
    logRules === rulesV, `工作日志头部 v${logRules}`);
  /* 2026-09-20 补：路线图此前不在覆盖范围内，其"当前基线"曾长期停在 v1.15（实际 v1.24）而门禁全绿 */
  const roadmapRules = (roadmap.match(/规范\s*\*\*v([\d.]+)\*\*/) || [])[1];
  t.check('路线图声明的规范版本 = PROJECT_RULES 头部版本',
    roadmapRules === rulesV, `路线图 v${roadmapRules}`);

  /* ---------------- 二、跨文档核心数字 ---------------- */
  t.section('二、跨文档核心数字');
  const appendixRows = (() => {
    const lines = req.split('\n');
    const idx = lines.findIndex(l => /附录\s*2/.test(l) && /共\s*\d+\s*项/.test(l));
    if (idx < 0) return 0;
    let n = 0;
    for (let i = idx + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l.startsWith('|')) { if (n) break; else continue; }
      if (/^\|[\s:|-]+\|$/.test(l) || l.includes('字段标识')) continue;
      n++;
    }
    return n;
  })();
  t.check('需求附录 2 字段表为 13 项', appendixRows === 13, `实际 ${appendixRows} 行`);
  t.check('架构文档按"13 字段"表述且与附录 2 一致',
    arch.includes('13 字段'), '架构文档 §2/§5/§6 均以 13 字段表述');
  t.check('README 数据口径提到"MES 上报 13 个字段"',
    readme.includes('13 个字段'), '2026-09-19 交叉验证补入，防再出现覆盖缺口');
  t.check('ADR-0001 与架构文档的落库吞吐口径一致（38 万行/秒量级）',
    adr1.includes('384,615 行/秒') && /38 万/.test(arch), '');
  t.check('数据量估算 0.34 GB/年 在 ADR-0001 与架构文档一致',
    adr1.includes('0.34 GB') && arch.includes('0.34 GB'), '');
  t.check('数据量估算标注了推算前提（避免被当成需求事实）',
    /推算前提|开发假设/.test(adr1) && /推算前提|开发假设/.test(arch), '');

  /* ---------------- 三、需求编号可追溯 ---------------- */
  t.section('三、需求编号可追溯（架构文档引用的编号必须真实存在）');
  const cited = [...new Set((arch.match(/\b(FR|UI|IF|DR|NFR|DEP|ENV)-[A-Z0-9]*\d+(?:\.\d+)?/g) || []))];
  const missing = cited.filter(id => {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m);
    return !new RegExp(esc + '(?![0-9])').test(req);
  });
  t.check('架构文档引用的需求编号都能在需求清单里找到', missing.length === 0,
    `共 ${cited.length} 个编号；缺失：${missing.join(', ')}`);

  /* ---------------- 四、目录描述 与 实际仓库 ---------------- */
  t.section('四、目录描述 与 实际仓库');
  const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  const files = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
  /* server/ 与 platform/ 都已真实存在（2026-09-19 起）；断言只要求"文档描述与实际一致" */
  const serverExists = dirs.includes('server');
  const serverDeclaredPending = /server\/\s*#\s*【后端，⬜ 待建】/.test(arch);
  t.check('server/ 的存在状态与架构文档描述一致',
    serverExists ? !serverDeclaredPending : serverDeclaredPending,
    serverExists ? 'server/ 已存在且文档未再标"待建"' : `实际：${dirs.join(', ')}`);
  const platformExists = dirs.includes('platform');
  const platformDeclaredPending = /platform\/\s*#\s*【平台适配层，⬜ 待建】/.test(arch);
  t.check('platform/ 的存在状态与架构文档描述一致',
    platformExists ? !platformDeclaredPending : platformDeclaredPending,
    platformExists ? 'platform/ 已存在且文档未再标"待建"' : 'platform/ 尚未创建，文档须标"待建"');
  t.check('架构文档存在于根目录', files.includes('项目架构与技术栈.md'));
  t.check('README 目录树登记了架构文档', readme.includes('项目架构与技术栈.md'));
  t.check('PROJECT_RULES 9.1 登记了架构文档', rules.includes('项目架构与技术栈.md'));
  t.check('PROJECT_RULES 9.6 登记了"架构现状说明"归档去向', /架构现状说明/.test(rules));
  t.check('PROJECT_RULES 把 server/platform 列入"后期再创建"',
    rules.includes('`server\\`') || /server\\/.test(rules), '');
  t.check('ADR 目录索引含 ADR-0001/0002/0003',
    adrReadme.includes('ADR-0001') && adrReadme.includes('ADR-0002') && adrReadme.includes('ADR-0003'));

  /* ---- `E94`（"清单计数"类声明无门禁守护）：**组件数三方一致**的结构性不变量 ----
     立案事实：文件系统 `src\components\*.js` ＝ **12** 个、`index.html` 注册的
     `<script src="src/components/…">` 也＝ **12** 条，而根 `README.md` §二 写的是 **11**
     （从 `UploadPanel.js` 落地起就错、**无人报警** —— `E94` 由座位 9 顺手发现、主代理复核属实）。
     修法（按 `E94` 的建议）：守"**清单计数 ＝ 文件系统事实**"这一条**通则**，而不是逐个数：
       `src\components\*.js` 文件数 ＝ `index.html` 注册的 `<script src="src/components/*.js">` 条数
       ＝ 根 `README.md` §二 声明的条数。
     ⚠ **不写死 12**：写成"**三者相等**"⇒ 以后新增组件只要三处同步就照样绿（不会假红），
     而任何一处漂移（改文档不补注册、或补注册不改文档）必红。
     取数口径的三个坑（都实测过）：
       ① `index.html` 里 `src/components/` 字样共出现 **15** 次，其中 3 次在**注释**里
          （`SettingPanel.js`×2、`UploadPanel.js`×1）⇒ 必须锚 `<script … src="…">`，不能只数字符串；
       ② README 的声明在"源码加载顺序"代码块里，形式为 `components（N 个…）` ⇒ 锚 `components（N 个`；
       ③ 锚点找不到（文档结构被改）⇒ **判红**（不许静默退化成"检查不了"—— `D23`）。 */
  {
    const COMP_DIR = path.join(ROOT, 'src', 'components');
    /** 真源①：`src\components\*.js` 的文件名（按名排序） */
    const compFiles = (() => {
      try { return fs.readdirSync(COMP_DIR).filter(n => n.endsWith('.js')).sort(); } catch { return null; }
    })();
    /** 真源②：`index.html` 注册的 `<script … src="src/components/*.js">` 的**文件名逐条**（含重复） */
    const htmlRegs = [...read('index.html').matchAll(/<script\b[^>]*\bsrc\s*=\s*"src\/components\/([^"\/]+\.js)"/g)]
      .map(m => m[1]);
    /** 真源③：根 `README.md` §二 的声明数（`components（N 个…`） */
    const compDeclMatch = readme.match(/components（\s*\*{0,2}(\d+)\s*个/);
    const nFiles = compFiles ? compFiles.length : null;
    const nHtml = htmlRegs.length;
    const nDecl = compDeclMatch ? Number(compDeclMatch[1]) : null;
    const threeCounts = `src\\components\\*.js＝${nFiles === null ? '（目录读不到）' : nFiles + ' 个'}；`
      + `index.html 注册＝${nHtml} 条；README.md §二 声明＝${nDecl === null ? '（锚点未命中）' : nDecl + ' 个'}`;
    /** **判据本体**（`E94` 的不变量）：三方相等。D22 暗桩复用**同一个函数**，
        否则暗桩绿了也证明不了这条断言可证伪。 */
    const compCountVerdict = (filesN, htmlN, readmeN) =>
      filesN !== null && htmlN > 0 && readmeN !== null && filesN === htmlN && htmlN === readmeN;
    t.check('E94 结构不变量：`src\\components\\*.js` 文件数 ＝ `index.html` 注册的 `<script src="src/components/…">` 条数 ' +
      '＝ 根 `README.md` §二 声明的条数（**三者相等**；不写死数字 ⇒ 以后新增组件不会假红）；不一致即**逐项报出三个数**',
      compCountVerdict(nFiles, nHtml, nDecl), threeCounts);

    /* 计数相等还不够：**逐条名字**也要对得上（"摘掉一条注册再补一条别的"会让计数照样相等）。
       方向①：注册的每个文件名都真实存在（且无重复注册）；方向②：每个文件都被注册过。
       两个方向的差集都必须为空 —— 正是 `PROJECT_RULES` 9.1「新增文件时同步在 `index.html` 里补一行」。 */
    const regSet = [...new Set(htmlRegs)].sort();
    const dupRegs = [...new Set(htmlRegs.filter((n, i) => htmlRegs.indexOf(n) !== i))];
    const notOnDisk = compFiles ? regSet.filter(n => compFiles.indexOf(n) < 0) : ['（目录读不到）'];
    const notRegistered = compFiles ? compFiles.filter(n => regSet.indexOf(n) < 0) : [];
    t.check('E94 结构不变量·**逐条对账**：`index.html` 注册的每个组件文件都真实存在（无重复注册），' +
      '且 `src\\components\\*.js` 里每个文件都被注册过（两个方向的差集都要为空）',
      nFiles !== null && notOnDisk.length === 0 && notRegistered.length === 0 && dupRegs.length === 0,
      `注册 ${regSet.length} 个（重复注册 ${dupRegs.length} 个${dupRegs.length ? '：' + dupRegs.join('、') : ''}）；` +
      `注册了但文件不存在：${notOnDisk.join('、') || '（无）'}；文件存在但未注册：${notRegistered.join('、') || '（无）'}`);

    /* `E94` D22 定点变异（**内存文本变异**：字节副本 ＋ sha256 留痕 ＋ 盘上文件未变的复核，
       与 `harness-check` §16 同款纪律 —— 不落地、不碰仓库、不用 `git checkout`）。
       ① README 声明数 +1 ⇒ 必红并**指名 README 那一侧**；
       ② 从 `index.html` 摘掉一条注册 ⇒ 计数与逐条对账**两侧都必红**、且逐条对账**指名**该文件。 */
    const { createHash } = require('node:crypto');
    const sha256Hex = buf => createHash('sha256').update(buf).digest('hex');
    const readmeFile = path.join(ROOT, 'README.md');
    const htmlFile = path.join(ROOT, 'index.html');
    const readmeBytes = fs.readFileSync(readmeFile), htmlBytes = fs.readFileSync(htmlFile);
    const readmeSha0 = sha256Hex(readmeBytes), htmlSha0 = sha256Hex(htmlBytes);
    t.check('E94 D22 变异①：根 `README.md` §二 的声明数 +1（**内存字节副本变异**）⇒ 上面的"三者相等"判据必红并**指名** README 那一侧；' +
      '未变异的当前源码必绿；盘上文件全程逐字节未变',
      (() => {
        const anchorRe = /components（\s*\*{0,2}(\d+)\s*个/;
        const mm = readmeBytes.toString('utf8').match(anchorRe);
        if (!mm) { t.info('E94 D22① 锚点未命中（README 里找不到 `components（N 个`）—— 判红，不许静默放过'); return false; }
        const mutText = readmeBytes.toString('utf8').replace(anchorRe, 'components（' + (Number(mm[1]) + 1) + ' 个');
        const mutDecl = Number((mutText.match(anchorRe) || [])[1]);
        const mutRed = !compCountVerdict(nFiles, nHtml, mutDecl);
        const curGreen = compCountVerdict(nFiles, nHtml, nDecl);
        const mutSha = sha256Hex(Buffer.from(mutText, 'utf8'));
        const diskSame = sha256Hex(fs.readFileSync(readmeFile)) === readmeSha0;
        t.info(`E94 D22① 变异体 sha256=${mutSha.slice(0, 12)}…（原件 sha256=${readmeSha0.slice(0, 12)}…）；`
          + `变异后声明＝${mutDecl}（原件 ${nDecl}）⇒ 三者相等判据必红=${mutRed}；当前源码同判据=${curGreen}；`
          + `盘上文件未变=${diskSame}`);
        return mutRed && curGreen && mutDecl === nDecl + 1 && diskSame;
      })(),
      '变异内容：把根 `README.md` §二 的 `components（N 个…` 改成 `N+1`（＝`E94` 立案时的 11 vs 12 形态）'
      + '—— 判据必须当场报出三个数并指名 README 那一侧');

    t.check('E94 D22 变异②：从 `index.html` 摘掉**一条**注册（**内存字节副本变异**）⇒ "三者相等"与"逐条对账"两条判据都必红，' +
      '且逐条对账**指名**被摘掉的那个文件；未变异的当前源码必绿；盘上文件全程逐字节未变',
      (() => {
        const htmlText = htmlBytes.toString('utf8');
        const tagRe = /[ \t]*<script\b[^>]*\bsrc\s*=\s*"src\/components\/([^"\/]+\.js)"[^>]*><\/script>[ \t]*\r?\n/;
        const tm = htmlText.match(tagRe);
        if (!tm) { t.info('E94 D22② 锚点未命中（index.html 里找不到成行的 `<script src="src/components/…"></script>`）—— 判红'); return false; }
        const victim = tm[1];
        const mutText = htmlText.replace(tagRe, '');
        const mutRegs = [...mutText.matchAll(/<script\b[^>]*\bsrc\s*=\s*"src\/components\/([^"\/]+\.js)"/g)].map(x => x[1]);
        const mutRed = !compCountVerdict(nFiles, mutRegs.length, nDecl);
        const mutUnreg = compFiles ? compFiles.filter(n => mutRegs.indexOf(n) < 0) : [];
        const curGreen = compCountVerdict(nFiles, nHtml, nDecl) && notRegistered.length === 0;
        const mutSha = sha256Hex(Buffer.from(mutText, 'utf8'));
        const diskSame = sha256Hex(fs.readFileSync(htmlFile)) === htmlSha0;
        t.info(`E94 D22② 变异体 sha256=${mutSha.slice(0, 12)}…（原件 sha256=${htmlSha0.slice(0, 12)}…）；`
          + `摘掉的那条注册＝${victim}；变异后注册数＝${mutRegs.length}（原件 ${nHtml}）⇒ 计数判据必红=${mutRed}；`
          + `逐条对账必指名=${JSON.stringify(mutUnreg)}；当前源码同判据=${curGreen}；盘上文件未变=${diskSame}`);
        return mutRed && curGreen && mutUnreg.length === 1 && mutUnreg[0] === victim && diskSame;
      })(),
      '变异内容：删掉 `index.html` 里一条 `<script src="src/components/…"></script>`'
      + '（＝"文件在、但页面不加载它"的静默形态）—— 判据必须当场指名该文件');
  }

  /* ---------------- 五、技术栈断言 vs ADR ---------------- */
  t.section('五、技术栈断言 vs ADR');
  t.check('运行时 Node.js 24 LTS 三方一致（架构/ADR-0002/快照）',
    arch.includes('Node.js 24 LTS') && adr2.includes('Node.js 24 LTS') && snap.includes('Node.js 24 LTS'));
  t.check('版本下限 Node ≥ 24 在架构与 ADR-0002 D10 一致',
    /≥ 24|≥24/.test(arch) && /≥24|≥ 24/.test(adr2));
  t.check('推送用 SSE（非 WebSocket）：架构/ADR-0001/需求 IF-E.1 一致',
    arch.includes('SSE') && adr1.includes('SSE') && req.includes('SSE'));
  t.check('500 ms 原始帧不落库：架构 = ADR-0001 D7',
    arch.includes('不落库') && adr1.includes('不落库'));
  t.check('零 npm 依赖：架构 = ADR-0002 D13', arch.includes('零 npm') && adr2.includes('npm'));
  t.check('平台适配层：架构 = ADR-0002 D11', arch.includes('平台适配层') && adr2.includes('平台适配层'));
  t.check('SQLite + WAL 一致', arch.includes('WAL') && adr1.includes('WAL'));
  t.check('桌面壳 WebView2（交付期）+ kiosk（开发期）：架构 = ADR-0001 D1/D2',
    arch.includes('WebView2') && arch.includes('kiosk') && adr1.includes('WebView2'));
  t.check('测试环境：架构 §9.1 = ADR-0003（不引测试框架 / DSH_ENV / 一用例一库）',
    /不引[入]?任何测试框架/.test(arch) && /不引[入]?任何测试框架/.test(adr3) &&
    arch.includes('DSH_ENV') && adr3.includes('DSH_ENV'),
    '措辞允许"不引/不引入"两种写法（避免断言写死措辞造成假失败）');

  /* ---------------- 六、与规范 9.5 约束 ---------------- */
  t.section('六、与规范 9.5 技术约束');
  t.check('「不使用 ES module」在架构文档与规范中一致',
    arch.includes('ES module') && rules.includes('ES module'));
  t.check('「不引入第三方库/CDN」一致', arch.includes('CDN') && rules.includes('CDN'));
  t.check('「双击 index.html 可打开」一致', arch.includes('双击') && readme.includes('双击'));
  t.check('规范 9.5 的 package.json 口径与 ADR-0002 零依赖一致（前后端都不建）',
    /前端任何情况下都不建/.test(rules) && rules.includes('目标零 npm 依赖'));

  /* ADR-0002 D11 的断言（P2-8）：承诺过"业务代码不得出现平台字样"却一直没有断言落地。
     这里静态扫描 server\ 与 platform\ 的 *.js，禁止盘符路径、Windows 可执行名与
     Windows 服务命令 —— 平台差异必须收敛在 platform\ 薄适配层里。 */
  const walkJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walkJs(full);
    return e.isFile() && e.name.endsWith('.js') ? [full] : [];
  });
  const platformHits = [];
  for (const dir of ['server', 'platform']) {
    for (const f of walkJs(path.join(ROOT, dir))) {
      const src = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      src.split(/\r?\n/).forEach((line, i) => {
        /* 允许 http:// 这类协议前缀；只拦"盘符 + 反斜杠"的本地路径与平台专有命令/程序名 */
        const bad = /(?<![:/])[A-Za-z]:\\/.test(line) || /\bmsedge\b/i.test(line) ||
          /\bsc(\.exe)?\s+create\b/i.test(line) || /\bschtasks\b/i.test(line) || /\bnssm\b/i.test(line);
        if (bad) platformHits.push(`${rel}:${i + 1}`);
      });
    }
  }
  t.check('ADR-0002 D11：server\\ 与 platform\\ 的代码里没有盘符路径与平台专有命令（断言落地）',
    platformHits.length === 0, platformHits.slice(0, 5).join('、'));

  /* ADR-0003 D17 承诺的"业务代码不得直接 new Date()"断言（P3-7：承诺已有、门禁一直没落地）。
     判据（先查实情再定，避免自造规则）：**允许"可注入 + 缺省兜底"写法** —— 形如
     `options.now || new Date()`、`d = new Date()`、`clock ? clock.now() : new Date()`；
     **禁止**的是"没有注入出口、直接用当前时间参与逻辑"（那会让用例不可重复）。
     `platform\clock.js` 是时间来源本身，**豁免**。
     **E42 收紧（2026-09-27）**：旧判据用 `/[?:]\s*new Date()/` 认"注入出口"，于是**对象字面量的
     键冒号**被误认成三元兜底 —— `state.lastError = { …, at: new Date().toISOString() }` 靠它侥幸
     过闸（与 D11 刚修掉的 SSE 注释帧同类，是那轮修复后的遗留不一致点）。两条修正：
       ① `:` 必须是**三元冒号**（同层有未配对的 `?`）；`{ key: … }` 的键冒号**不算**注入出口；
       ② `Date.now()` 与 `new Date()` **同等**受管（此前完全不看 `Date.now()` ⇒ 裸 `Date.now()` 静默过闸）。
     断言名**保持原文**：`项目记录\ADR\ADR-0003-测试环境.md:141` 逐字引用了它，而该文件不在本轮可改范围。 */
  /**
   * 逐行返回"去掉注释后"的代码行（P3-7 需要：注释里会写"禁止 new Date()"这类说明，
   * 首版把这些注释行判成了违规）。只做**行级轻量处理**：识别 `//` 与成对的 `/* … *\/`，
   * 足够用于静态扫描，不追求完整 JS 词法分析。
   * E42 补：成对的块注释也可能**全在同一行**（首版只处理跨行块，一行 JSDoc 里的 `new Date()`
   * 就被误判成"裸时钟"）—— 注释必须先剥干净，判据才对事不对字面。
   */
  const stripComments = (src) => {
    const out = [];
    let inBlock = false;
    for (const raw of src.split(/\r?\n/)) {
      let line = raw;
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end < 0) { out.push(''); continue; }
        line = line.slice(end + 2);
        inBlock = false;
      }
      for (;;) {
        const open = line.indexOf('/*');
        if (open < 0) break;
        const close = line.indexOf('*/', open + 2);
        if (close < 0) { inBlock = true; line = line.slice(0, open); break; }
        line = line.slice(0, open) + line.slice(close + 2);
      }
      const slash = line.indexOf('//');
      if (slash >= 0) line = line.slice(0, slash);
      out.push(line);
    }
    return out;
  };

  /* 被管的时钟调用：`new Date()` 与 `Date.now()` **同等**（E42②：此前只看 `new Date()`）。 */
  const CLOCK_CALL_RE = /(?:new Date|Date\.now)\(\s*\)/g;

  /**
   * `line[colonIdx]` 是不是**三元**的 `:`（E42①：对象字面量的键冒号必须判否）。
   * 行级轻量判定：从冒号往左扫，成对括号内的内容整体跳过；**同层**先遇到未闭合的 `{` ⇒ 这个冒号是
   * 对象字面量的键分隔符（`{ at: new Date() }` 不是注入出口）；**同层**先遇到真三元 `?` ⇒ 是三元
   * 假分支（`… ? x : new Date()`）。`?.` 与 `??` 不是三元运算符，故跳过。
   */
  const isTernaryColon = (line, colonIdx) => {
    let depth = 0;
    for (let i = colonIdx - 1; i >= 0; i--) {
      const c = line[i];
      if (c === ')' || c === ']' || c === '}') { depth++; continue; }
      if (c === '(' || c === '[' || c === '{') {
        if (depth > 0) depth--;
        else if (c === '{') return false;
        continue;
      }
      if (depth > 0) continue;
      if (c === '?') {
        if (line[i + 1] === '.' || line[i + 1] === '?' || line[i - 1] === '?') continue;
        return true;
      }
    }
    return false;
  };

  /**
   * `line.slice(start, end)` 这处时钟调用是否留有注入出口（**同一行**判定）：
   *   · 缺省兜底：`X || new Date()` ／ `X || Date.now()`
   *   · 形参默认值：`param = new Date()` 或 `param = new Date(),`
   *     （首版 `=\s*new Date()` 过宽，把 `const now = new Date();` 也当成了形参默认值 ——
   *      反证时发现该写法**没能被抓出**，故要求左侧是 `(param =`、右侧紧跟逗号或右括号）
   *   · 三元兜底：`cond ? new Date()` ／ `cond ? x : Date.now()`
   */
  const injectableCall = (line, start, end) => {
    const before = line.slice(0, start);
    const after = line.slice(end);
    if (/\|\|\s*$/.test(before)) return true;
    if (/\(\s*[A-Za-z_$][\w$]*\s*=\s*$/.test(before) && /^\s*[,)]/.test(after)) return true;
    const m = /([?:])\s*$/.exec(before);
    if (!m) return false;
    if (m[1] === '?') return true;
    return isTernaryColon(line, m.index);
  };

  const clockHits = [];
  for (const dir of ['server', 'platform']) {
    for (const f of walkJs(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, f);
      if (rel === path.join('platform', 'clock.js')) continue;
      stripComments(fs.readFileSync(f, 'utf8')).forEach((line, i) => {
        CLOCK_CALL_RE.lastIndex = 0;
        for (let m = CLOCK_CALL_RE.exec(line); m; m = CLOCK_CALL_RE.exec(line)) {
          if (injectableCall(line, m.index, m.index + m[0].length)) continue;
          clockHits.push(`${rel}:${i + 1}（裸 ${m[0]}）`);
          break;
        }
      });
    }
  }
  t.check('ADR-0003 D17：业务代码的 `new Date()` 都留有注入出口（不是直接取当前时间算逻辑）',
    clockHits.length === 0, clockHits.slice(0, 5).join('、'));

  /* ---------------- 七、字段语义（易错项） ---------------- */
  t.section('七、字段语义（易错项）');
  t.check('架构文档写明 depth＝航行器深度、cameraDepth＝相机自身深度',
    arch.includes('航行器') && arch.includes('cameraDepth') && arch.includes('相机自身'));
  t.check('需求以 C-32 / IF-C.9 支撑该区分',
    req.includes('相机系统测量的航行器水下深度') && req.includes('IF-C.9'));
  t.check('测试夹具体现同一区分（cameraDepth ≠ depth）',
    read('tests/lib/fixture.js').includes('相机自身深度'));

  /* ---------------- 八、进度标注 与 实际状态 ---------------- */
  t.section('八、进度标注 与 实际状态');
  t.check('架构文档把"数据落库"标为未实现（⬜）', arch.includes('⬜') && arch.includes('13 张表'));
  t.check('快照"下一步"与架构文档待建项一致（建表/数据落库）',
    snap.includes('数据落库') && arch.includes('schema.sql'));
  t.check('路线图基线已含"后端运行时 Node.js 24 LTS"', roadmap.includes('Node.js 24 LTS'));

  /* ---------------- 九、测试侧边界 ---------------- */
  t.section('九、测试侧边界（测试代码不得引用业务代码）');
  const envSrc = read('tests/env.js');
  const harnessSrc = read('tests/lib/harness.js');
  const clockSrc = read('tests/lib/clock.js');
  const fixtureSrc = read('tests/lib/fixture.js');
  const libSrc = [envSrc, harnessSrc, clockSrc, fixtureSrc].join('\n');
  t.check('夹具层不 require 业务代码（tests/lib 与 env.js 只依赖 Node 内置）',
    !/require\(['"]\.\.\/\.\.\/src/.test(libSrc) && !/require\(['"].*src\//.test(libSrc),
    '夹具必须与业务解耦，否则业务改动会连带打挂所有门禁');
  t.check('测试临时区落在 ._verify 之内（D16：绝不写生产目录）',
    /_verify/.test(envSrc) && envSrc.includes("'tmp'"));
  t.check('harness 提供"一个用例一个库"能力（makeTempDb）',
    harnessSrc.includes('function makeTempDb') && harnessSrc.includes('journal_mode = WAL'));
  t.check('harness 的 stdio 采用落文件而非管道（受限环境管道会 EPERM）',
    /stdio:\s*\['ignore', fd, fd\]/.test(harnessSrc));

  /* P1-1 防回潮：platform/paths.js 的 ROOT 少退一层会把数据目录写到仓库外（曾复现）。
     这里在进程内换 DSH_ENV 重新加载该模块来实测三套目录，不靠"读源码猜"。 */
  const loadPathsUnder = (envName) => {
    const prev = process.env.DSH_ENV;
    process.env.DSH_ENV = envName;
    const abs = require.resolve('../platform/paths');
    delete require.cache[abs];
    try {
      return require(abs);
    } finally {
      if (prev === undefined) delete process.env.DSH_ENV; else process.env.DSH_ENV = prev;
      delete require.cache[abs];
    }
  };
  const pDev = loadPathsUnder('dev');
  const pTest = loadPathsUnder('test');
  t.check('platform/paths 的 ROOT 指向仓库根（含 PROJECT_RULES.md / index.html / tests）',
    ['PROJECT_RULES.md', 'index.html', 'tests'].every(m => fs.existsSync(path.join(pDev.ROOT, m))),
    `实测 ROOT=${pDev.ROOT}`);
  t.check('platform/paths 的 dev 数据目录落在仓库根之内（ADR-0002 D11）',
    pDev.isInside(pDev.ROOT, pDev.paths.dataRoot),
    `dev dataRoot=${pDev.paths.dataRoot}`);
  t.check('platform/paths 的 test 数据目录落在 tests\\._verify 之内（ADR-0003 D16）',
    pTest.isInside(path.join(pTest.ROOT, 'tests', '._verify'), pTest.paths.dataRoot),
    `test dataRoot=${pTest.paths.dataRoot}`);
  t.check('platform/paths 拒绝把 test 数据根覆盖到 ._verify 之外',
    (() => {
      try { pTest.overrideDataRoot(path.join(pTest.ROOT, 'data', 'test')); return false; }
      catch { return true; }
    })(),
    '越界覆盖必须抛错，否则测试会写进真实数据目录');

  /* ---------------- 十、权威门禁数字的机器校验（P2-22，ADR-0004 D19） ----------------
     症状：`tests\README.md` 自称"本节为权威值"，却**没有任何断言检查它** —— 12 个脚本里
     没有一条比对过扫描文件数/覆盖率分类，所以数字漂移永远不会被拦下（本轮已修掉两处旧漂移：
     文本文件数 89→98→99、ENV 覆盖率 4/20→6/20）。这里补三层校验。 */
  t.section('十、权威门禁数字的机器校验（P2-22）');

  const numeric = require('./lib/numeric');
  const readmeSrc = read(README_REL);
  const { spawnSync } = require('node:child_process');

  /** 实跑一个门禁脚本（输出落文件后回读；受限环境禁管道，故不用 pipe）。
   *
   *  **日志落点很关键**：不要落在 `tests\._verify\tmp\`（临时库区）—— 本机实测那里写下的日志
   *  会在子进程跑完前后**消失**（`statSync` 直接 ENOENT，连读都读不到 → 实跑值恒为 null，
   *  表现为 `harness-check` 这类脚本"三次重试都拿不到汇总行"的假失败）。
   *  落在 `tests\._verify\` 根下则次次可读（实测 2/2 成功、8813 字节）。该目录已被 .gitignore 忽略。
   *  `timeout` 是兜底：曾实测到子进程卡住不返回，没有它上游工具超时会打断整条命令。
   *
   *  **`E135`（2026-10-04）：超时值按脚本分档 ＋ 超时与"声明≠实跑"分开报** —— 两件事一起改，
   *  因为它们的**症状同形、成因相反**：
   *    · 旧实现是一个常量 `120000`，而各门禁耗时差两个数量级（`logic-check` 实测 133 ms
   *      ↔ `harness-check` **空机**单跑 **84.1 s**，见 `C·21` 靶子③）⇒ 最重那条的余量只有 **1.43×**；
   *      机器有负载（并发跑门禁、`--jobs N`）时复核探针会超时。
   *    · 超时后被 `probeOne()` 记成"拿不到汇总行"，断言 6 判红、`actualOf` 回落到**旧账** ⇒
   *      读者看到的像"**权威区漂移**"，于是去查一个**不存在**的漂移（`E110` 同族的"症状指向错方向"）。
   *  ⇒ 两条修法：①**按脚本给余量**（下表：默认 300 s＝旧值 2.5×；最重的 `harness-check` 360 s
   *  ＝对它 84.1 s 的 **4.28×** 余量，且**最坏墙钟与旧实现持平**，见下）；②把"**探针超时**"
   *  （＝**前提不成立**：判据没能在预算内跑完被测脚本）与"**取不到汇总行**"（＝被测脚本真的没产出）
   *  分开分类、分开计数、分开报（`classifyProbeE135()`／`probeShortfallNoteE135()` 是纯函数，
   *  D22 复用同一份 ⇒ "变异后变红"能证伪这条断言）。
   *
   *  **超时不重试**（`nosummary` 仍重试到 3 次）：超时的成因是"机器忙/预算不够"，
   *  重试既不改诊断、又会把最坏墙钟乘上重试次数（3×360 s ＝ 18 min）。**旧实现的最坏墙钟是
   *  3×120 s ＝ 6 min**；现在超时只跑 1 次 ⇒ **6 min，与旧实现持平**，但换来"不再假报漂移"。
   *  而"输出来不及落盘"那一类（子进程正常退出、汇总行没落盘）本来就表现为 `nosummary`，
   *  重试语义**逐字保留**。
   *
   *  `DSH_DC_PROBE_TIMEOUT_MS`（**受控输入口**，与 `DSH_DC_*_OVERRIDE` 同口径）：设了就用它当
   *  所有脚本的超时 —— 只为 `E135` 的 D22（把超时压到 1 ms，实测"报探针超时、不报权威漂移"），
   *  正式运行不设 ⇒ 行为只由上面的表决定。
   *  @param {string} script 脚本名（不含 .js）
   *  @param {number} [overrideMs] 只作用于本次调用（D22 用；不落任何全局状态）
   *  @returns {{code:?number, errCode:?string, out:string, timedOut:boolean, timeoutMs:number}} */
  const PROBE_TIMEOUT_MS = {
    default: 300000,
    /* 唯一一条与"默认 300 s"不同的：它空机单跑就要 84.1 s（`C·21` 实测），余量必须给足。
       其余离线门禁实测都在秒级/十秒级（`logic-check` 133 ms）⇒ 300 s 对它们是 30× 以上。 */
    'harness-check': 360000
  };
  const PROBE_TIMEOUT_ENV = (() => {
    const v = Number(process.env.DSH_DC_PROBE_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : null;
  })();
  const probeTimeoutFor = (script, overrideMs) => {
    if (Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs;
    if (PROBE_TIMEOUT_ENV !== null) return PROBE_TIMEOUT_ENV;
    return Object.prototype.hasOwnProperty.call(PROBE_TIMEOUT_MS, script)
      ? PROBE_TIMEOUT_MS[script] : PROBE_TIMEOUT_MS.default;
  };
  const probe = (script, overrideMs) => {
    const timeoutMs = probeTimeoutFor(script, overrideMs);
    const log = path.join(env.ensureDir(env.paths.verify), `docs-cross-${script}-${process.pid}.log`);
    const fd = fs.openSync(log, 'w');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', script + '.js')],
      { cwd: ROOT, stdio: ['ignore', fd, fd], timeout: timeoutMs });
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
    let out = '';
    try { out = fs.readFileSync(log, 'utf8'); } catch { out = ''; }
    try { fs.rmSync(log, { force: true }); } catch { /* 忽略 */ }
    return {
      code: r.status,
      errCode: r.error ? String(r.error.code || '') : null,
      out, timeoutMs,
      timedOut: r.error ? (r.error.code === 'ETIMEDOUT') : false
    };
  };

  /**
   * 单个脚本的实跑探针 + **重试**（第十一节用）。
   * 为什么要重试：本机上确有的一次拿不到汇总行的情形（同一台机器上还有别的门禁在并发跑，
   * 子进程可能被挤到"输出来不及落盘"）。**一次拿不到就报红是假失败**，
   * 会让人去查根本不存在的漂移；故重试两次，三次都拿不到才判"未覆盖"（那时是真有问题）。
   *
   * **`E135` 的改动（分类 ＋ 超时不重试）**：返回值不再只有"成功/失败"两态，而是带 `kind`：
   *   · `ok`        ⇒ 拿到汇总行（`passed` 有效）；
   *   · `timeout`   ⇒ 探针在预算内**没跑完**（`ETIMEDOUT`）＝**前提不成立**（机器忙/预算不够），
   *                   **不是**"权威区写错了"⇒ **不重试**（重试不改诊断，只会把最坏墙钟乘上次数）；
   *   · `nosummary` ⇒ 子进程正常退出（或退出码非 0）但**没产出可解析的汇总行** ⇒ 仍重试到 3 次。
   * 两类都仍然**判红**（取不到实跑值不得静默放过，`D19/D21/D23`），但**报的话不一样**：
   * 前者报"探针超时（前提不成立）"，后者报"未取到汇总行" —— 见 `probeShortfallNoteE135()`。
   * @param {string} script 脚本名（不含 .js）
   * @param {number} [overrideMs] 只作用于本次调用（D22 用）
   * @returns {{kind:'ok'|'timeout'|'nosummary', passed?:number, attempts:number, timeoutMs:number}}
   */
  const classifyProbeE135 = (r) => {
    const s = summaryOf(r && r.out);
    if (s) return { kind: 'ok', passed: s.passed };
    if (r && r.timedOut) return { kind: 'timeout' };
    return { kind: 'nosummary' };
  };
  /** 两类"取不到实跑值"的**文案**（纯函数：D22 复用它 ⇒ "报的是超时、不是漂移"可证伪）。 */
  const probeShortfallNoteE135 = (name, kind, timeoutMs) => (kind === 'timeout'
    ? `${name}（**探针超时**：预算 ${timeoutMs} ms 内没跑完 ⇒ **前提不成立**，` +
      '**不是"权威区漂移"** —— 先看机器负载/并发，或 `--fast` 刷新账本后重跑）'
    : `${name}（实跑未产出可解析的汇总行）`);
  const probeOne = (script, overrideMs) => {
    let last = { kind: 'nosummary', attempts: 0, timeoutMs: probeTimeoutFor(script, overrideMs) };
    const maxAttempts = (kind) => (kind === 'timeout' ? 1 : 3);   /* 超时不重试，理由见抬头 */
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = probe(script, overrideMs);
      const c = classifyProbeE135(r);
      last = { ...c, attempts: attempt, timeoutMs: r.timeoutMs };
      if (c.kind === 'ok') return last;
      if (attempt >= maxAttempts(c.kind)) return last;
    }
    return last;
  };

  /** 说明：`run-totals.json` 里"断言合计"的那本账，**本脚本不做比对** ——
   *  "权威值 vs 实跑合计"要等本轮全部脚本跑完才有最终账，suite 成员按定义读不到，
   *  已移到 `run-all` 收尾执行（它是唯一持有最终账、且不会自递归的地方）。
   *  **第十一节只借用其中的"逐脚本通过数"**（每个脚本跑完就落盘，故是既成事实而非预测），
   *  且必须确认它是**本轮**写的（mtime 判定），详见该节注释。 */

  /* ① 结构完整性：权威区点名的每个脚本都必须真实存在 */
  const authLine = (readmeSrc.split('\n').find(l => l.includes('离线可跑部分')) || '');
  const named = [...new Set([...authLine.matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1])
    .filter(n => n.endsWith('-check') || n === 'screenshot-diff'))];
  const unknownNamed = named.filter(n => !fs.existsSync(path.join(ROOT, 'tests', n + '.js')));
  t.check('权威区点名的脚本都真实存在',
    named.length >= 12 && unknownNamed.length === 0,
    unknownNamed.length ? `不存在：${unknownNamed.join('、')}` : `点名 ${named.length} 个`);

  /* ② "权威值 vs 实跑合计"**不在这里做** —— 本脚本是 suite 成员，按定义读不到"本轮最终账"
     （它自己还没跑完），任何 forecast/占位都会算错。该比对交给 **run-all 收尾**：
     它是唯一持有最终实跑账的地方，且不会自递归。此处只做**文件级**的权威值校验（③）。
     历史教训：首版在此处"再跑一遍 run-all"→ 自递归超时；第二版用 forecast 占位 → 数字算错。 */
  const sumListed = numeric.sumScriptCounts(authLine);
  const statedTotal = numeric.matchNumber(authLine, /合计\s*\*{0,2}\s*(\d+)\s*通过/);
  t.check('权威区列出的各脚本数字之和 ≤ 声明合计（防重复计数/写错数）',
    sumListed > 0 && statedTotal !== null && sumListed <= statedTotal,
    `列出的和=${sumListed}，合计=${statedTotal}`);

  /* ④ 当前状态文档引用的门禁总数 = 权威区声明（2026-09-20 补）
     立案原因：权威区**自身**有机器校验（①～③），但"别的文档抄这个数有没有跟上"此前无人把关。
     2026-09-19 收工后 `当前状态快照`／`项目架构与技术栈`／`后续路线图` 三份一起停在 493（权威值 497），
     一致性门禁全绿 —— 因为一致性门禁只能发现"文档之间互相打架"，发现不了"大家一起旧了"。
     本断言把权威区当成唯一真源，要求三份"当前状态"文档都引用同一个三元组。 */
  const authTriple = (authLine.match(/合计\s*\*{0,2}\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败\s*\/\s*(\d+)\s*跳过/) || []).slice(1);
  const authStr = authTriple.length === 3
    ? `${authTriple[0]} 通过 / ${authTriple[1]} 失败 / ${authTriple[2]} 跳过` : null;
  const currentDocs = [['当前状态快照', snap], ['项目架构与技术栈', arch], ['后续路线图', roadmap]];
  const staleDocs = currentDocs.filter(([, src]) => !authStr || !src.includes(authStr));
  t.check('当前状态文档引用的门禁总数 = 权威区声明（防"文档集体滞后"）',
    authStr !== null && staleDocs.length === 0,
    authStr === null
      ? '未能在权威区解析出「X 通过 / Y 失败 / Z 跳过」三元组'
      : `权威值「${authStr}」未被引用：${staleDocs.map(d => d[0]).join('、')}`);

  /* ③ 与实跑对齐：权威区关于"扫描文件数 / 覆盖率分类"的数字必须等于对应脚本的真实输出 */
  /* `E135`（2026-10-04）：本节三条探针的读数也把"**探针超时**"这一**前提不成立**的事实跟着报出来 ——
     否则 1 ms 受控变异（或真有负载时）读者只看到"实跑=null"，会去猜"是不是权威值写错了"。
     正常预算下 `files-check`／`trace-check` 实测都在秒级（默认 300 s）⇒ 这条注记平时一个字符都不出现。 */
  const probeNote10 = (r) => (r && r.timedOut
    ? `｜**探针超时**（预算 ${r.timeoutMs} ms 内没跑完 ⇒ **前提不成立**，**不是"权威值漂移"**）` : '');
  const fcRun = probe('files-check');
  const fcScanned = numeric.matchNumber(fcRun.out, /扫描\s*\*{0,2}(\d+)\*{0,2}\s*个文本文件/);
  const fcStated = numeric.matchNumber(readmeSrc, /扫描\s*\*\*(\d+)\*\*\s*个文本文件/);
  t.check('权威区"扫描 N 个文本文件"＝ files-check 实跑值',
    fcScanned !== null && fcStated === fcScanned,
    `README=${fcStated}，实跑=${fcScanned}` + probeNote10(fcRun));

  const trRun = probe('trace-check');
  /* README 的写法是 `按类别：…、**ENV 4/20**`；trace-check 输出是 `ENV 6 / 20`。
     两处的加粗与空格都不同，故用容错正则（这两个坑都实际踩过）。 */
  const readmeEnv = (readmeSrc.match(/ENV\s*\*{0,2}\s*(\d+)\s*\/\s*(\d+)/) || []).slice(1).map(Number);
  const traceEnv = (trRun.out.match(/ENV\s*(\d+)\s*\/\s*(\d+)/) || []).slice(1).map(Number);
  t.check('权威区的 ENV 覆盖率分类＝ trace-check 实跑值',
    readmeEnv.length === 2 && traceEnv.length === 2 &&
    readmeEnv[0] === traceEnv[0] && readmeEnv[1] === traceEnv[1],
    `README=ENV ${readmeEnv.join('/')}，实跑=ENV ${traceEnv.join('/')}` + probeNote10(trRun));

  /* README 写法：`可追溯覆盖 162 条（63.0%）`；不写"162/257"那种形式，故按"条"取分子 */
  const readmeCov = [
    numeric.matchNumber(readmeSrc, /可追溯覆盖\s*(\d+)\s*条/),
    numeric.matchNumber(readmeSrc, /(\d+)\s*条\*\*需求条款/)
  ];
  const traceCov = (trRun.out.match(/可追溯覆盖[^\d]*(\d+)\s*\/\s*(\d+)/) || []).slice(1).map(Number);
  t.check('权威区的可追溯覆盖率＝ trace-check 实跑值（分子与条款总数都比）',
    readmeCov[0] !== null && readmeCov[1] !== null && traceCov.length === 2 &&
    readmeCov[0] === traceCov[0] && readmeCov[1] === traceCov[1],
    `README=${readmeCov.join(' / ')}，实跑=${traceCov.join(' / ')}` + probeNote10(trRun));

  /* 逐项分类数也要比 —— 只比分子/分母会漏掉"分类写错"（本轮我就把 backend-phase 写成 60、
     declared-gap 写成 12，而实跑是 57/13；当时无断言，靠人工回读才发现）。 */
  const traceClass = {};
  for (const m of trRun.out.matchAll(/^\s{2}([a-z-]+)\s+(\d+)\s+条\s+\(/gm)) traceClass[m[1]] = Number(m[2]);
  const classPair = (name) => {
    const re = new RegExp('`' + name + '`\\s*(\\d+)\\s*条');
    const n = numeric.matchNumber(readmeSrc, re);
    return [name, n, traceClass[name]];
  };
  const pairs = ['backend-phase', 'declared-gap', 'manual', 'out-of-scope', 'subjective']
    .map(classPair).filter(([, , actual]) => actual !== undefined);
  const mismatched = pairs.filter(([, doc, actual]) => doc !== actual)
    .map(([name, doc, actual]) => `${name}: README=${doc} 实跑=${actual}`);
  t.check('权威区的各分类条数＝ trace-check 实跑值（逐项比，不只比总数）',
    pairs.length >= 4 && mismatched.length === 0,
    (mismatched.length ? mismatched.join('；') : `逐项一致（${pairs.map(([n, d]) => `${n}=${d}`).join('、')}）`) + probeNote10(trRun));

  /* 离线可验证覆盖率与"依赖不可运行脚本"的条数也要比（P3-10 新增的口径） */
  const readmeOffline = numeric.matchNumber(readmeSrc, /离线可验证\s*(\d+)\s*条/);
  const traceOffline = numeric.matchNumber(trRun.out, /离线可验证覆盖\s*(\d+)\s*\//);
  const readmeOnlineOnly = numeric.matchNumber(readmeSrc, /其余\s*(\d+)\s*条依赖/);
  const traceOnlineOnly = numeric.matchNumber(trRun.out, /依赖需浏览器权限的脚本\s*(\d+)\s*条/);
  t.check('权威区的"离线可验证覆盖率"与"依赖浏览器脚本条数"＝ trace-check 实跑值',
    readmeOffline === traceOffline && readmeOnlineOnly === traceOnlineOnly,
    `离线 README=${readmeOffline}/实跑=${traceOffline}；依赖 README=${readmeOnlineOnly}/实跑=${traceOnlineOnly}` + probeNote10(trRun));

  /* ---------------- 十一、权威区逐脚本条数 ＝ 实跑值（2026-09-20 新增，P2-2） ----------------
     立案症状（架构评审 A-2026-09-20-01 P2-2）：权威区自己写着"本节数字为权威值"，第十节也做了
     合计/文件级/分类的机器校验，但**逐脚本那一行声明的条数没有任何断言盯着**，于是它长期漂移：
     `docs-cross-check` 描述里写 48 项（实跑 58）、`logic-check` 写 44 项（实跑 52）、
     `db-check` 写 46 项（实跑 50）、`harness-check` 写 73 项（实跑 94）—— 全绿着漂了很久。
     注意第十节 ③ 的"列出的和 ≤ 声明合计"**抓不住这种漂移**：它只比合计，不逐脚本比。

     期望值**一律来自实跑**（D21：不得把 58/94/52… 之类的数字当期望值写进断言，那就成了第二个真源）：
     本节需要"每个离线门禁此刻的实跑通过数"，取数走**两条路**（2026-09-20 T-20260920-10 改造）：

     ① **快路径 = 本轮 `run-all` 落下的实跑账**（`tests\._verify\run-totals.json`）。
        `run-all` 每跑完一个脚本就把该脚本的 `summary` 写进这份账，而 `docs-cross-check` 排在
        suite **最后**，故它运行时账里已经有**前面每个离线门禁的既成事实**（不是预测）。
        这份账是"逐脚本跑出来的数"，不是人工抄的第二个真源，符合 D21。
     ② **冲突复核 = 只对"声明 ≠ 账"的那几个脚本单独实跑一次**（`probeOne`），
        并以**此刻的实跑结果**为最终判据。

     为什么不能无条件采信账本（**这是本节的关键设计约束**）：账本是**另一个进程随时会重写**的文件 ——
     实测同一份 README、同一个变异条件下，账里 `harness-check` 先后读到过 94 / 92（并发的 run-all
     反复重写），若直接拿账当判据，就会出现"声明 93 vs 账 93"的**假绿**与真红在两次运行间翻面。
     故分工固定为：**账本负责"认定一致"（快），实跑负责"认定不一致"（准）** ——
       · 声明 = 账  → 直接采信（12 个脚本省掉一次串行实跑，本节墙钟从约 15 s 降到约 2.5 s）；
       · 声明 ≠ 账  → 该脚本**实跑复核**，实跑与声明也不符才判红（真漂移），
         实跑与声明相符则判绿（账是并发轮的旧值，**不误伤**）。
     代价（如实交代）：若某个脚本"账与声明同为旧值"（例如 README 与账都停在上一轮的 93，
     而此刻实跑是 94），快路径会判绿 —— 这类"集体滞后"由第十节④（当前状态文档引用的门禁总数）
     与 `run-all` 收尾的 `verifyAuthorityTotals`（按合计）拦截，且下一轮 run-all 写账后即自愈。

     账本采信的前提（ADR-0004 D20，用 `t.requires` 表达，**塌了就退化为逐项实跑，不静默放过**）：
     文件存在 + 能解析 + 其内条目覆盖当前门禁清单。任一不满足 → 对**缺的那些**脚本实跑补数
     （单独 `node tests\docs-cross-check.js` 且账本缺失时就是"全部实跑"，与改造前行为一致）。
     账本里 `docs-cross-check` 那条是它**中途**落盘的数（实测 62/63），不是终值 —— 故自指脚本另见下。

     解析覆盖两种形式（两者都要比，缺一不可）：
       ① 逐脚本清单：`` `contract-check` **58/0** ``、`` tools-check 24/0 ``（加粗可有可无）；
       ② 脚本表行里的中文描述：`**夹具自检（94 项）**`、`**编码与文件卫生（11 项）**`。
     脚本名与中文描述的对应关系**取自脚本表首列的 `tests/xxx-check.js`**（同一条表行），不另写映射表。

     显式排除项（**不静默跳过**，逐条说明）：
       · `browser-check` / `overlap-check` / `stress-check`：受限沙箱下整脚本 SKIP（退出码 3），
         "跳过不是通过"，不拿 0 去比对，也不在本节的覆盖清单里；
       · `preflight` / `run-all`：环境体检与 runner，不是断言门禁；
       · `docs-cross-check`（本脚本自身）：**自指**。它声明的条数 = 它自己这次跑出来的通过数，
         而"这次"要等本节结束后才确定（第十节已有先例：suite 成员读不到本轮最终账）。
         拿账本里的值去比只会拿到它"中途落盘"的数或上一轮的数 —— 都不构成防漂移断言，
         故**不纳入本节比对**，改为在断言详情里如实标注。它的漂移由 `run-all` 收尾的
         `verifyAuthorityTotals`（合计）拦截。 */
  t.section('十一、权威区逐脚本条数 ＝ 实跑值（P2-2）');
  const dbg = process.env.DSH_DEBUG_S11 === '1';

  const SUITES_READ = (() => {
    try { return require('./run-all').SUITES; } catch { return null; }
  })();
  t.requires('能读到 run-all 的门禁清单 SUITES', Array.isArray(SUITES_READ));
  const browserNames = new Set((SUITES_READ || []).filter(s => s.needBrowser).map(s => s.name));
  /** 离线门禁 = run-all 清单里的 needBrowser:false（含 screenshot-diff 与 docs-cross-check 自身） */
  const offlineGates = (SUITES_READ || []).filter(s => !s.needBrowser).map(s => s.name);

  /** 从脚本输出里取汇总行（`通过 N 项，失败 N 项[(，跳过 N 项)]` 的**最后一次**出现） */
  const summaryOf = (out) => {
    const re = /通过\s*(\d+)\s*项，失败\s*(\d+)\s*项(?:，跳过\s*(\d+)\s*项)?/g;
    let m; let last = null;
    while ((m = re.exec(String(out || ''))) !== null) last = m;
    return last ? { passed: Number(last[1]), failed: Number(last[2]), skipped: last[3] === undefined ? 0 : Number(last[3]) } : null;
  };

  /**
   * 逐脚本实跑账（`tests\._verify\run-totals.json`）的读取 —— **本节快路径的唯一数据入口**。
   *
   * 采信条件**不是** mtime（试过：mtime 与进程启动时刻只差 0.1 s，判定会因计时抖动而翻面 ——
   * 那样的门禁是"看运气"的），而是**内容完整性**：文件存在 + 能解析 + `suites[].summary.passed`
   * 覆盖到各个离线门禁。它可能是**上一轮** `run-all` 写的，故按内容采信后还有第二道闸：
   * 凡"账里的数 ≠ README 声明"的脚本**一律单跑复核**（见 `resolveActuals`），
   * 既不会有"账与声明一致却被判红"的假失败，也不会漏掉真漂移。
   * （单独运行本脚本时账内通常已含上一轮全部脚本，故复核只在真有出入时才发生。）
   *
   * 落盘方 `run-all` 的契约**不要求预建父目录**（它自己 `ensureDir` 后写），故本读取端
   * 以"文件不存在"为一条正常分支（单独跑本脚本、或账本还没生成过），**不当异常**。
   * @returns {{ok:boolean, why:string, error:?(Error|null), suites:Array, file:string}}
   */
  const readRunTotals = (mode) => {
    const file = path.join(env.paths.verify, 'run-totals.json');
    const prefix = mode === 'hard' ? '**不可读**：' : '';
    try {
      if (!fs.existsSync(file)) return { ok: false, why: prefix + '不存在（本轮不是经 run-all 启动，账本还没生成过）', error: null, suites: [], file };
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(json.suites)) return { ok: false, why: prefix + '结构不对（缺 suites 数组）', error: null, suites: [], file };
      return { ok: true, why: '', error: null, suites: json.suites, file };
    } catch (err) {
      return { ok: false, why: prefix + '读取失败：' + (err && err.message), error: err || null, suites: [], file };
    }
  };

  /* ---- 解析：脚本名（两种形式之一）→ 声明三元（通过/失败/跳过） ----
     `E112`（2026-10-04）：原来只抓「`name` P/F」两元，于是"逐脚本跳过数"根本没有解析入口
     （权威区实际**两种写法并存**，都必须认）：
       · **三元**：`` `stress-check` **11/0/3** ``（第 3 位＝跳过数）
       · **后缀**：`` `ui-check` **175/0**（+1 跳过；…） ``
     `declared` 仍是**通过数**（既有断言 1/2 的口径一字不动）；`failed`／`skipDeclared` 是新增的两位。
     ⚠ 只认"名字紧跟数字/数字"这一形态 —— 权威行里 `` `ui-check` **1 项** `` 那种**跳过枚举**
       不会命中（它没有 `数字/数字`），故不会与枚举混淆。 */
  const nameDecl = (name, textAndSource) => {
    const re = new RegExp('`' + name + '`\\s*\\*{0,2}\\s*(\\d+)\\s*/\\s*(\\d+)' +
      '(?:\\s*/\\s*(\\d+))?\\s*\\*{0,2}\\s*(?:[（(]\\s*\\+\\s*(\\d+)\\s*跳过)?', 'g');
    for (const { text, from } of textAndSource) {
      const m = re.exec(text);
      if (m) {
        const skip3 = m[3] === undefined ? null : Number(m[3]);
        const skipSuffix = m[4] === undefined ? null : Number(m[4]);
        return {
          name, declared: Number(m[1]), failed: Number(m[2]),
          skipDeclared: skip3 !== null ? skip3 : skipSuffix, from,
          declForm: skip3 !== null ? '三元 P/F/S' : (skipSuffix !== null ? '后缀 (+N 跳过)' : '两位 P/F')
        };
      }
    }
    return null;
  };
  const nameDeclarations = new Map();
  for (const name of offlineGates) {
    const hit = nameDecl(name, [{ text: authLine, from: '权威区逐脚本清单' }, { text: readmeSrc, from: 'tests/README.md 全文' }]);
    if (hit) nameDeclarations.set(name, hit);
  }

  /* ---- 解析：脚本行首列的 `tests/xxx.js` ↔ 本行"中文描述（N 项）" ---- */
  const tableDeclarations = new Map();
  for (const line of readmeSrc.split(/\r?\n/)) {
    const cell0 = /^\|\s*`tests[\\/]([a-z0-9-]+)\.js`\s*\|/.exec(line);
    if (!cell0 || tableDeclarations.has(cell0[1])) continue;
    const rest = line.slice(cell0[0].length);
    /* 描述在"运行"列之后的"覆盖"列里，故不用 `^` 锚定；形式固定为 `描述（**N 项**…）`。
       字符类排除 `|（）*` 反引号：既避免跨单元格，也把描述限制成一段纯中文短语。 */
    const desc = /([^|（）*`]{1,20}?)（(?:\*\*|\s)*(\d+)\s*项/.exec(rest);
    if (!desc) continue;
    tableDeclarations.set(cell0[1], { name: cell0[1], form: desc[1], declared: Number(desc[2]), from: 'tests/README.md 脚本表中文描述' });
  }

  const totals = readRunTotals();
  const ledger = {};                   // 脚本名 → 账本里的通过数（**本轮** run-all 的逐脚本实跑账）
  /* `E112`（2026-10-04）：另存一份**完整三元**（通过/失败/跳过）。为什么不改 `ledger` 的形状：
     它被本节多处按"通过数"直接参与算术（合计/取数/来源统计），改形状会牵连一片；
     而"三元"只有下面**断言 8** 用 ⇒ 单开一张表，语义清楚、影响面为零。 */
  const ledgerSummary = {};
  for (const s of totals.suites) {
    if (s && s.name && s.summary) {
      ledger[s.name] = Number(s.summary.passed);
      ledgerSummary[s.name] = {
        passed: Number(s.summary.passed), failed: Number(s.summary.failed || 0), skipped: Number(s.summary.skipped || 0)
      };
    }
  }
  /**
   * 自指脚本：**两条逐脚本断言都不比它**。
   * 理由（实测确认）：本脚本是 suite 最后一个，`run-totals.json` 里那条记录是它**中途**落盘的
   * 数（实测 62/63，含本节尚未走完的计数），不是终值；"拿上一轮的账"（T-1）同样不成立 ——
   * 它会天然与声明差一轮，变成永远红的假失败。真正可比的量只有"自己这次的最终通过数"，
   * 而那要等本节结束才确定。它的漂移由 `run-all` 收尾的 `verifyAuthorityTotals`（按合计）拦截。
   * 注意：正因为它是自指，读账失败**不**用 `t.requires` 硬失败 —— 单独跑本脚本（没有 run-all 账）
   * 是合法用法，此时退化为"对每个有声明的离线门禁各实跑一次"，结论照样是实跑值。
   */
  const SELF_REF = 'docs-cross-check';
  /* 前提（ADR-0004 D20）：账本必须覆盖当前门禁清单，本节才允许走"快路径"。
     塌了不报 FAIL（前提不成立会单独成段并使退出码非 0），但也**绝不静默放过** ——
     下面 resolveActuals 对"账里没有"的脚本一律实跑补数（③ 退化分支）。 */
  t.requires('run-totals.json 的条目覆盖当前门禁清单（账本缺失/过期时退化为逐项实跑，不静默放过）',
    totals.ok && offlineGates.every(n => n === SELF_REF || ledger[n] !== undefined),
    totals.ok
      ? `账本缺 ${offlineGates.filter(n => n !== SELF_REF && ledger[n] === undefined).join('、') || '（无）'}`
      : totals.why);
  /** 声明值取自 readmeSrc（本进程启动时读入的那一份，`main` 顶部一次性读取） */
  const declaredOf = (name) => {
    if (nameDeclarations.has(name)) return nameDeclarations.get(name).declared;
    return tableDeclarations.has(name) ? tableDeclarations.get(name).declared : null;
  };
  /**
   * 逐脚本实跑值的取数 —— **账本快路径 + 冲突复核**（设计取舍见本节顶部注释）。
   *
   * 规则（三条，缺一不可）：
   *   ① **快路径**：账里有这个脚本 → 先当成"实跑值"（它确实是逐脚本跑出来的既成事实，不是预测）；
   *   ② **冲突复核**：`声明 ≠ 账` → 对该脚本 `probeOne()` **复跑一次**，以**此刻的实跑**为最终判据
   *      （账本可能是并发轮的旧值，也可能 README 真漂移了 —— 只有实跑能分辨）；
   *   ③ **账本不覆盖** → 也实跑补上（单独跑本脚本、账本缺失/过期、或 run-all 中途失败时），
   *      **取不到就计入 unresolved/失败，绝不静默放过**（D19/D21/D23）。
   * 为什么不是"无条件实跑"（旧实现）：12 个脚本串行实测约 13 s（最慢 `harness-check` 约 4 s），
   * 而 `run-all` 本轮**刚刚**跑过它们并把逐脚本数落了盘 —— 再跑一遍是纯粹的重复实跑。
   * 为什么不是"无条件信账"（另一头的错法）：账会被并发的另一个 run-all 覆盖，实测同一条件
   * 下 `harness-check` 读到过 94 / 92，"真假红绿翻面"；故账只用来**认定一致**。
   */
  const actualProbe = {};       // 脚本名 → 实跑探针拿到的通过数（仅"冲突复核 / 账本不覆盖"的脚本）
  const probeFailures = [];     // 跑了但拿不到汇总行的（不得静默放过）
  const probeTimeouts = [];     // `E135`：跑了但**超时**的（前提不成立，**不是**权威区漂移）
  const probeFailed = {};       // 脚本名 → 'timeout' | 'nosummary'（断言 1/2 据此**不判漂移**）
  const probedNames = [];       // 实跑过的脚本名（含冲突复核与账本不覆盖两类）
  const rechecked = [];         // 其中"因声明 ≠ 账而复核"的脚本名
  const sourceOf = {};          // 脚本名 → 最终取数来源（'ledger' | 'probe'）
  const probeWallMs = (() => {
    const startedAt = Date.now();
    for (const name of offlineGates) {
      if (name === SELF_REF) continue;                         // 自指，见 SELF_REF 注释
      const declared = declaredOf(name);                       // 没声明的由断言 3/5 报，不猜
      if (declared === null) continue;
      if (!exists(path.join('tests', name + '.js'))) continue;
      const logged = ledger[name];
      const needProbe = logged === undefined || declared !== logged;
      if (!needProbe) { sourceOf[name] = 'ledger'; continue; } // ① 快路径
      probedNames.push(name);
      if (logged !== undefined) rechecked.push(name);           // ② 声明 ≠ 账 → 冲突复核
      const re = probeOne(name);                                // ②/③ 实跑
      if (re && re.kind === 'ok') {
        actualProbe[name] = re.passed; sourceOf[name] = 'probe';
      } else {
        /* `E135`：**两类分开记**。超时＝前提不成立（机器忙/预算不够）⇒ 报"探针超时"；
           nosummary＝被测脚本自己没产出 ⇒ 报"未取到汇总行"。两者都**仍然判红**（取不到不得静默放过），
           但**不许**再被读成"权威区漂移"。 */
        const kind = re ? re.kind : 'nosummary';
        probeFailed[name] = kind;
        if (kind === 'timeout') probeTimeouts.push(probeShortfallNoteE135(name, kind, re.timeoutMs));
        else probeFailures.push(probeShortfallNoteE135(name, kind));
      }
    }
    return Date.now() - startedAt;
  })();
  /** 账本快路径取到值的脚本数（不含自指；用于输出里的数据来源标注与断言 7） */
  const ledgerUsed = Object.keys(sourceOf).filter(n => sourceOf[n] === 'ledger');
  /** 冲突复核的脚本数（声明 ≠ 账）；这些脚本的最终判据是**实跑**，不是账 */
  const recheckNames = rechecked.slice();
  /**
   * 取数后的实跑值：**冲突复核/实跑探针优先**（它才是"此刻"的事实），其次账本；两者都没有则
   * 返回 undefined —— 由断言 6/7 统一报"未覆盖/取不到"并判红，**不在这里猜、也不默认通过**。
   */
  const actualOf = (name) => {
    if (name === SELF_REF) return undefined;
    return actualProbe[name] !== undefined ? actualProbe[name] : ledger[name];
  };
  /* ---- 结构自检：解析出来的每一步都必须指向真实存在的脚本文件 ---- */
  const badNamedScript = [...nameDeclarations.keys()].filter(n => !exists(path.join('tests', n + '.js')));
  const badTableScript = [...tableDeclarations.keys()].filter(n => !exists(path.join('tests', n + '.js')));
  t.check('第十一节解析出的脚本名都指向真实存在的 tests\\*.js',
    badNamedScript.length === 0 && badTableScript.length === 0,
    [...badNamedScript, ...badTableScript].join('、'));

  /* E55（2026-09-29）：本机没有 git 时，`docs-check`／`harness-check` 的条数**必然**与权威区不同
     （各自有依赖提交历史的断言：harness-check 少 2 条、docs-check 的失败数也变）⇒ 这两个脚本
     **不参与按数比对**，改为显式标注"环境跳过（本机无 git）"。否则会把**环境差异**判成缺陷
     （现场 2026-09-29 实测：无 git 的机器上这两个脚本各报一条红，指向"权威区声明 ≠ 实跑"）。 */
  const GIT_DEPENDENT = ['docs-check', 'harness-check'];
  const gitOkHere = (() => {
    try {
      const r = require('node:child_process').spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 8000 });
      return r.status === 0 && /git version/i.test(String(r.stdout || ''));
    } catch { return false; }
  })();
  const envSkipped = gitOkHere ? [] : GIT_DEPENDENT.filter(n => nameDeclarations.has(n) || tableDeclarations.has(n));
  const envSkipNote = envSkipped.length
    ? `｜**环境跳过（本机无 git）**：${envSkipped.join('、')} —— 其条数依赖提交历史，不参与按数比对`
    : '';


  /* ---- 断言 1：逐脚本清单形式 ---- */
  /* `E135`（2026-10-04）：把"声明 vs 实跑"的失配判定抽成**纯函数**，让"探针超时**不算**漂移"这件事
     可被 D22 定点证伪。语义与旧写法**逐字相同**，只多一条前置：**前提不成立（探针超时/取不到汇总行）
     ⇒ 不产出失配项**（它由断言 6 按"探针超时/未取到汇总行"报红 —— **不静默放过，也不误报漂移**）。
     为什么必须分开：超时是"判据没能在预算内跑完被测脚本"，与"权威区写错了"是**成因相反**的两件事；
     旧写法把前者记成"拿不到汇总行"、再让 `actualOf` 回落到旧账 ⇒ 输出读起来像"权威区漂移"（`E110` 同族）。 */
  const declaredMismatchE135 = (label, declared, actual, ctx) => {
    if (ctx.selfRef || actual === undefined) return null;
    if (ctx.envSkipped) return null;                 /* E55：无 git 时这两个脚本不参与按数比对 */
    if (ctx.probeFailed) return null;                /* `E135`：前提不成立 ⇒ 不在此判"漂移"（见断言 6） */
    if (declared === actual) return null;
    return `${label}：声明 ${declared} ≠ 实跑 ${actual}` +
      (ctx.rechecked ? '（账本值亦不符，已实跑复核确认）' : '（取自本轮账）');
  };
  const notDeclared = offlineGates.filter(n => !nameDeclarations.has(n));
  const mismatchedNamed = [];
  for (const [name, d] of nameDeclarations) {
    /* 自指脚本跳过；其余"拿不到任何实跑值"的由断言 6 报"未覆盖"，此处不猜也不硬比 */
    const msg = declaredMismatchE135(name, d.declared, actualOf(name), {
      selfRef: name === SELF_REF, envSkipped: envSkipped.includes(name),
      probeFailed: Boolean(probeFailed[name]), rechecked: recheckNames.includes(name)
    });
    if (msg) mismatchedNamed.push(msg);
  }
  t.check('权威区逐脚本清单声明的条数 ＝ 各脚本实跑通过数',
    nameDeclarations.size > 0 && notDeclared.length === 0 && mismatchedNamed.length === 0,
    (mismatchedNamed.length
      ? mismatchedNamed.join('；')
      : `逐脚本一致：${[...nameDeclarations].map(([n, d]) => `${n}=${d.declared}`).join('、')}`) +
    (notDeclared.length ? `｜**权威区未声明条数**（新增脚本请按 \`\\\`name\\\` N/M\` 形式登记）：${notDeclared.join('、')}` : '') +
    `；实跑 ${probedNames.length} 个（${probedNames.join('、') || '无'}）` +
    `｜来源：账本 ${ledgerUsed.length} 个 ＋ 冲突复核 ${recheckNames.length} 个`);

  /* ---- 断言 2：脚本表里的**中文形式**条数（与形式①是两处不同的文字，必须都比） ---- */
  const cpMismatch = [];
  for (const [name, d] of tableDeclarations) {
    /* `E135`：同断言 1 —— 前提不成立（探针超时/取不到汇总行）不在此判"漂移"（由断言 6 报） */
    const msg = declaredMismatchE135(`${name}（${d.form}）`, d.declared, actualOf(name), {
      selfRef: name === SELF_REF, envSkipped: envSkipped.includes(name),
      probeFailed: Boolean(probeFailed[name]), rechecked: recheckNames.includes(name)
    });
    if (msg) cpMismatch.push(msg);
  }
  t.check('权威区脚本表里"中文形式"的逐脚本条数 ＝ 各脚本实跑通过数',
    tableDeclarations.size >= 4 && cpMismatch.length === 0,
    cpMismatch.length
      ? cpMismatch.join('；')
      : `中文形式一致（${[...tableDeclarations].map(([, d]) => `${d.form}=${d.declared}`).join('、')}）`);
  if (dbg) t.info('（调试）声明/取数明细：' + offlineGates.map(n =>
    `${n}(声明=${declaredOf(n)}/账本=${ledger[n] === undefined ? '-' : ledger[n]}` +
    `/探针=${actualProbe[n] === undefined ? '-' : actualProbe[n]}` +
    `/来源=${sourceOf[n] || '-'}/采用=${actualOf(n)})`).join(' '));

  /* ---- 数据来源标注（**本节取值从哪来，必须一眼可见**；不是断言，但读数前先看它） ---- */
  t.info(`实跑值来源：run-totals.json（本轮账，${ledgerUsed.length} 个脚本）` +
    ` ＋ 冲突复核 ${recheckNames.length} 个（${recheckNames.join('、') || '无'}）` +
    `＋ 账本不覆盖实跑 ${probedNames.length - recheckNames.length} 个` +
    `｜账本 ${totals.ok ? '可读' : '不可读：' + totals.why}｜实跑探针墙钟 ${probeWallMs} ms`);
  if (envSkipped.length) t.info('**环境跳过（本机无 git）**：' + envSkipped.join('、') + ' —— 其条数依赖提交历史，不参与按数比对（E55）');

  /* ---- 断言 3：解析必须**全覆盖**，解析不到的不得静默放过 ---- */
  t.check('权威区每个离线门禁的牌面条数都被解析覆盖（解析不到的列进"未覆盖清单"）',
    offlineGates.length > 0 && notDeclared.length === 0,
    notDeclared.length
      ? `**未覆盖清单**（权威区里读不出条数，或写法不在解析范围内）：${notDeclared.join('、')}`
      : `覆盖 ${nameDeclarations.size}/${offlineGates.length} 个离线门禁` +
        (nameDeclarations.size !== tableDeclarations.size ? '（其中带中文形式描述的见上一条）' : ''));

  /* ---- 断言 4：防"声明了却对不上任何脚本"（新写一段文字却写错脚本名） ---- */
  const declaredButUnknown = [...nameDeclarations.keys()].filter(n => !offlineGates.includes(n));
  t.check('第十一节解析出的声明都能对上一个真实门禁脚本',
    declaredButUnknown.length === 0,
    declaredButUnknown.length ? `未匹配到门禁脚本：${declaredButUnknown.join('、')}` : '（0 处）');

  /* ---- 断言 5：**两种形式**合起来必须覆盖每个离线门禁（新增脚本别只写一处就以为登记过了） ---- */
  const uncoveredOffline = offlineGates.filter(n => !nameDeclarations.has(n) && !tableDeclarations.has(n));
  t.check('两种形式合起来覆盖全部离线门禁（权威区不得漏登记某个脚本的条数）',
    offlineGates.length > 0 && uncoveredOffline.length === 0,
    uncoveredOffline.length
      ? `**未覆盖清单**（权威区里既无 \`name\` N/M、也无"描述（N 项）"）：${uncoveredOffline.join('、')}`
      : `覆盖 ${offlineGates.length}/${offlineGates.length}（逐脚本清单 ${nameDeclarations.size} 个、中文形式 ${tableDeclarations.size} 个）`);

  /* ---- 断言 6：**不得静默变绿** —— 有任何"有声明却取不到实跑值"的必须红 ----
     判据从"探针是否跑过"泛化为"是否取到可溯源实跑值"（账本快路径 / 冲突复核 / 账本不覆盖的实跑
     三条都算），语义**不变也未被削弱**：只要有一个有声明的离线门禁既不在账里、也没实跑出汇总行，
     这里就判红并点名 —— 不许把"取不到"改判为通过（D19/D21/D23）。 */
  const cannotVerify = offlineGates.filter(n => n !== SELF_REF && declaredOf(n) !== null &&
    actualOf(n) === undefined);
  const ledgerUsedAll = offlineGates.filter(n => n !== SELF_REF && declaredOf(n) !== null &&
    sourceOf[n] === 'ledger').length;
  t.check('每个有声明的离线门禁都拿到了实跑值（取不到即红，不静默放过）—— 且**两类"取不到"分开报**：' +
    '「**探针超时**」＝前提不成立（机器忙/预算不够），「取不到汇总行」＝被测脚本真没产出；' +
    '前者**绝不许**被读成"权威区漂移"（`E135`）',
    (ledgerUsedAll + probedNames.length) > 0 && cannotVerify.length === 0
      && probeFailures.length === 0 && probeTimeouts.length === 0,
    `取到实跑值 ${ledgerUsedAll + probedNames.length} 个` +
    `（账本 ${ledgerUsedAll} 个 ＋ 实跑 ${probedNames.length} 个：${probedNames.join('、') || '无'}）` +
    `，**探针超时 ${probeTimeouts.length} 个**` + (probeTimeouts.length ? `：${probeTimeouts.join('；')}` : '') +
    `，取不到汇总行 ${probeFailures.length} 个` +
    (probeFailures.length ? `：${probeFailures.join('、')}` : '') +
    `｜超时预算（按脚本分档）：默认 ${PROBE_TIMEOUT_MS.default} ms` +
    (offlineGates.filter(n => Object.prototype.hasOwnProperty.call(PROBE_TIMEOUT_MS, n)).length
      ? `、` + offlineGates.filter(n => Object.prototype.hasOwnProperty.call(PROBE_TIMEOUT_MS, n))
        .map(n => `${n} ${PROBE_TIMEOUT_MS[n]} ms`).join('、')
      : '') +
    (PROBE_TIMEOUT_ENV !== null ? `；⚠ 本次由 \`DSH_DC_PROBE_TIMEOUT_MS=${PROBE_TIMEOUT_ENV}\` 覆盖（只用于受控 D22）` : '') +
    (cannotVerify.length ? `｜**未覆盖清单**（有声明却既不在账里、也没实跑出值）：${cannotVerify.join('、')}` : '') +
    `｜run-totals.json ${totals.ok ? '可读（快路径数据源）' : '不可用：' + totals.why}`);

  /* ---- `E135` D22（可证伪）：把超时压到 1 ms（**受控**：只作用于这一次调用）⇒ 必须报"探针超时"，
     而**不是**"权威漂移"。四组读数缺一不可：①真实 1 ms 超时 → `ETIMEDOUT` ＋ `kind==='timeout'`；
     ②合成 `{timedOut:true}` → `timeout`；③合成"正常退出但无汇总行" → `nosummary`（**两类不许混**）；
     ④文案断言：超时那条含"探针超时"且**不含**"漂移"；⑤`declaredMismatchE135()` 在"前提不成立"时
     **不产出失配项**（⇒ 症状不会再指向权威区），而在同一组数字下把前提恢复 ⇒ 失配项**照旧产出**
     （⇒ 不是把判据弄成恒不报）。 */
  {
    const tinyRun = probe('files-check', 1);
    const tinyCls = classifyProbeE135(tinyRun);
    const synthTimeout = classifyProbeE135({ out: '', timedOut: true, timeoutMs: 1 });
    const synthNoSum = classifyProbeE135({ out: '（子进程正常退出，但没有汇总行）', timedOut: false });
    const synthOk = classifyProbeE135({ out: '通过 7 项，失败 0 项，跳过 0 项', timedOut: false });
    const timeoutNote = probeShortfallNoteE135('harness-check', 'timeout', 1);
    const noSumNote = probeShortfallNoteE135('harness-check', 'nosummary', 1);
    const ctxBase = { selfRef: false, envSkipped: false, rechecked: true };
    const asProbeFailed = declaredMismatchE135('harness-check', 391, 300, { ...ctxBase, probeFailed: true });
    const asRealMismatch = declaredMismatchE135('harness-check', 391, 300, { ...ctxBase, probeFailed: false });
    t.check('E135 D22（可证伪）：超时预算压到 **1 ms**（受控，只作用于本次调用）⇒ 探针必报 `ETIMEDOUT` 且被分类为' +
      '**「探针超时」**（前提不成立），与「取不到汇总行」**分开**；超时那条文案**明说"不是权威区漂移"**且' +
      '**不含任何失配话术**（无 `声明 N ≠ 实跑 M`、无"请同步 tests\\README.md"）；' +
      '同一组"声明 391 ≠ 实跑 300"的数字，在前提不成立时**不产出失配项**、前提恢复后**照旧产出**（⇒ 不是恒不报）',
      tinyRun.timedOut === true && tinyRun.errCode === 'ETIMEDOUT' && tinyCls.kind === 'timeout'
        && synthTimeout.kind === 'timeout' && synthNoSum.kind === 'nosummary'
        && synthOk.kind === 'ok' && synthOk.passed === 7
        && timeoutNote.includes('探针超时') && /不是[^。]{0,8}权威区漂移/.test(timeoutNote)
        && !/声明\s*\d+\s*≠/.test(timeoutNote) && !timeoutNote.includes('请同步')
        && noSumNote.includes('未产出可解析的汇总行')
        && asProbeFailed === null && asRealMismatch !== null && asRealMismatch.includes('声明 391 ≠ 实跑 300'),
      `1 ms 实跑：timedOut=${tinyRun.timedOut}、errCode=${tinyRun.errCode}、分类=${tinyCls.kind}（应 timeout；预算 ${tinyRun.timeoutMs} ms）；` +
      `合成三类分类＝${synthOk.kind}/${synthTimeout.kind}/${synthNoSum.kind}（应 ok/timeout/nosummary，通过数 ${synthOk.passed}）；` +
      `超时文案＝"${timeoutNote}"（含"探针超时"=${timeoutNote.includes('探针超时')}、` +
      `含"不是…权威区漂移"=${/不是[^。]{0,8}权威区漂移/.test(timeoutNote)}、含失配话术=${/声明\s*\d+\s*≠/.test(timeoutNote)}）；` +
      `"未取到汇总行"文案＝"${noSumNote}"；` +
      `前提不成立时失配项=${asProbeFailed === null ? 'null（不判漂移）' : asProbeFailed}；` +
      `前提恢复后失配项=${asRealMismatch === null ? 'null（**异常**）' : asRealMismatch}` +
      `；探针日志已删=${!fs.existsSync(path.join(env.paths.verify, `docs-cross-files-check-${process.pid}.log`))}`);
  }

  /* ---- 断言 7（2026-09-20 T-20260920-10 新增）：取数**不得留空** ----
     新增这条是为了给"快路径"本身加护栏：改造后"取数"多了一条分支（账本），而分支越多越容易
     出现"某个脚本悄悄没被取到值、两条逐脚本断言又都 continue 掉了"的空洞 —— 那正是 D23 说的
     "取不到不得静默放过"。判据：每个应有实跑值的脚本（有声明 + 脚本文件存在 + 非自指）都必须
     有明确来源（账本 / 实跑），且实跑过的脚本不得留下"跑了却没结果"的记录。 */
  const sourceGaps = offlineGates.filter(n => n !== SELF_REF && declaredOf(n) !== null &&
    exists(path.join('tests', n + '.js')) && sourceOf[n] === undefined);
  const unlocatedProbes = probedNames.filter(n => actualProbe[n] === undefined);
  t.check('第十一节的实跑值取数不留空洞（每个应有值的脚本都有来源：账本 或 实跑）',
    sourceGaps.length === 0 && unlocatedProbes.length === 0,
    `来源统计：账本 ${ledgerUsed.length} 个、实跑 ${probedNames.length} 个（其中冲突复核 ${recheckNames.length} 个）` +
    (sourceGaps.length ? `｜**无来源**（既没读账也没实跑）：${sourceGaps.join('、')}` : '') +
    (unlocatedProbes.length ? `｜**实跑无结果**：${unlocatedProbes.join('、')}` : ''));

  /* ---- 断言 8（`E112`，2026-10-04 追加）：权威区逐脚本按**通过/失败/跳过**三元写全 ----
     立案（`E112` / 座位 5 的 `C·20` `F-5`）：权威区对 `harness-check` 只写 `391/0`、
     **漏它那 2 条跳过**；而"跳过"在本项目是"**不算通过**"的语义（规范 9.5-5 第 6 条）⇒
     漏写在报表里会被读成"这两条也过了"（数得出来的后果：按枚举去对账**总是差 2**）。
     判据（三条，缺一不可）：
       ① **写了就必须对**：写出跳过数的（`P/F/S` 三元 或 `（+N 跳过）` 后缀）必须 ＝ 实跑跳过数；
          三元里的第 2 位（失败数）同理。
       ② **跳过了就必须写**：实跑跳过数 > 0 的脚本，权威区**必须**写出该跳过数 —— 这正是 `E112` 的缺口。
       ③ **取不到实跑值 ⇒ 判红**（不静默放过，`D19/D21/D23`）。
     两种写法都已在权威区**实际存在**（实测）：`` `stress-check` **11/0/3** ``（三元）与
     `` `ui-check` **175/0**（+1 跳过；…） ``（后缀）⇒ 解析器**两种都认**，**不要求**统一改写
     （改写权威区的排版不是本门禁的职责；门禁只要求"写了的对、跳过的写了"）。
     ⚠ 自指脚本 `docs-cross-check` 不在本断言内（其实跑值要到本节结束才确定，理由同 `SELF_REF`）。
     ⚠ **`D20` 边界（2026-10-04 追加轮，实测修正）**：`--fast` 档的主账本**不含**浏览器/长跑脚本
       （`browser-check`／`overlap-check`／`stress-check`；`E99` 之后 `--fast` 仍写主账本）⇒
       **"账本覆盖不到" ≠ "权威区写错"**：前者是**前提不成立**（该脚本本轮**不可比**），
       必须报"本轮不可比"并点名，**不得判 FAIL**（旧写法把 3 条"账本没有该脚本"当失配 ⇒
       全量轮内假红 2 条、权威对账被拒，实证见该轮回执）；反过来，
       **账本里有且数不符 ⇒ 仍必红并指名**（判据强度**不许降**，`D21`/`D23`）。
       两种情形分别计数、互不混淆：
         · `covered` ＝ 账本里有条目 ⇒ 逐项比失败数/跳过数，不符即进 `findings`（红）；
         · `unmet`   ＝ 账本里**没有**条目 ⇒ 记"本轮不可比"**只列清单**（不红、**也不计入已核对**）。
       ⇒ 不许"装绿"：`covered ＋ unmet === 应有值`（一个都不许消失、也不许两边都算）。
     ⚠ 判据本体抽成**纯函数** `tripleAudit()`：D22 定点变异必须复用**同一个函数**，
       否则"变异后变红"证明不了这条断言可证伪。 */
  const tripleAudit = (authText, summaryOfName) => {
    const findings = [];
    const covered = [];
    const unmet = [];
    for (const s of (SUITES_READ || [])) {
      const nm = s.name;
      if (nm === SELF_REF) continue;
      const d = nameDecl(nm, [{ text: authText, from: '权威区逐脚本清单' }]);
      if (!d) { findings.push(`${nm}：权威区里解析不出 \`通过/失败\` 声明`); continue; }
      const sum = summaryOfName(nm);
      /* `D20`：账本覆盖不到 ⇒ **本轮不可比**（前提不成立），不是失败 —— 但必须点名并计数 */
      if (!sum) { unmet.push(`${nm}（本轮账本无该脚本条目）`); continue; }
      covered.push(nm);
      if (d.failed !== sum.failed) {
        findings.push(`${nm}：权威区写**失败 ${d.failed}** ≠ 实跑失败 ${sum.failed}（${d.declForm}）`);
      }
      if (sum.skipped > 0 && d.skipDeclared === null) {
        findings.push(`${nm}：实跑**跳过 ${sum.skipped} 条**，而权威区只写了两位 ` +
          `\`${d.declared}/${d.failed}\` —— **跳过数漏写**（\`E112\` 的原始缺口；"跳过"≠"通过"）`);
      } else if (d.skipDeclared !== null && d.skipDeclared !== sum.skipped) {
        findings.push(`${nm}：权威区写**跳过 ${d.skipDeclared}** ≠ 实跑跳过 ${sum.skipped}（${d.declForm}）`);
      }
    }
    return { findings, covered, unmet };
  };
  {
    const tri = tripleAudit(authLine, nm => ledgerSummary[nm]);
    const expectCovered = (SUITES_READ || []).length - 1;      /* 减去自指脚本 */
    t.check('E112 权威区逐脚本**三元写全**（通过/失败/跳过）：写出的失败数与跳过数都＝实跑值，' +
      '且**凡实跑有跳过项的脚本都必须在权威区写出跳过数**（两种写法都认：`P/F/S` 三元 或 `（+N 跳过）` 后缀；' +
      '实跑三元取本轮账本 `run-totals.json` —— 与本节其它断言同源）；' +
      '**账本覆盖不到的脚本按 `D20` 报"本轮不可比"（不判 FAIL、也不计入已核对），但账本里有且数不符仍必红并指名**',
      tri.findings.length === 0 && tri.covered.length + tri.unmet.length === expectCovered,
      (tri.findings.length ? `**失配/漏写 ${tri.findings.length} 条**：${tri.findings.join('；')}` : '逐脚本三元一致') +
      `｜**已核对 ${tri.covered.length}／${expectCovered} 个**` +
      `（${tri.covered.map(n => `${n}=${ledgerSummary[n].passed}/${ledgerSummary[n].failed}/${ledgerSummary[n].skipped}`).join('、')}）` +
      `｜**本轮不可比 ${tri.unmet.length} 个**：${tri.unmet.join('、') || '（无）'}` +
      `｜自指 \`${SELF_REF}\` 不在本断言内`);

    /* ---- 断言 9（`D20` 边界自证："覆盖不足**不许装绿**"）----
       危险形态：把"账本缺该脚本"随手 `continue` 掉 ⇒ 该脚本既不进"已核对"也不进"不可比"，
       于是**总数悄悄变少**、门禁照绿（`D23` 的"静默缩小校验范围"）。
       判据＝**一个都不许消失或重复**：`已核对 ＋ 不可比 === 应有值`，且每个不可比项都点名。
       可证伪（内存注入）：把某个**已核对**脚本的实跑三元置为 `undefined` ⇒ 它必须
       **从"已核对"移到"不可比"**（两侧各变 1、总数不变），而不是"两边都在"或"两边都不在"。 */
    {
      const probeName = tri.covered[0] || (offlineGates.find(n => n !== SELF_REF) || 'ui-check');
      const hiddenTri = tripleAudit(authLine, nm => (nm === probeName ? undefined : ledgerSummary[nm]));
      const moved = !hiddenTri.covered.includes(probeName)
        && hiddenTri.unmet.some(x => x.startsWith(probeName));
      t.check('E112 §11 断言 9（`D20` 边界自证）：**账本覆盖不足的脚本一律报"本轮不可比"并逐条点名** —— ' +
        '既不得据此判 FAIL（把"前提不成立"当成"权威区写错"），也不得**装绿**（悄悄算作已核对通过）；' +
        '判据＝`已核对 ＋ 不可比 === 应有值`（一个都不许消失或重复）；**内存注入**：把某已核对脚本的实跑三元置空 ' +
        '⇒ 它必须**从"已核对"移到"不可比"**',
        tri.covered.length + tri.unmet.length === expectCovered
          && hiddenTri.covered.length === tri.covered.length - 1
          && hiddenTri.unmet.length === tri.unmet.length + 1
          && moved,
        `已核对 ${tri.covered.length} ＋ 本轮不可比 ${tri.unmet.length} ＝ ${tri.covered.length + tri.unmet.length}` +
        `（应有 ${expectCovered}）｜不可比清单：${tri.unmet.join('、') || '（无）'}｜` +
        `注入「${probeName} 无实跑三元」⇒ 已核对 ${hiddenTri.covered.length}／不可比 ${hiddenTri.unmet.length}、` +
        `该脚本已移入不可比=${moved}（**两侧计数各变 1、总数不变**）`);
      if (tri.unmet.length) {
        t.info(`§11「三元写全」**本轮不可比 ${tri.unmet.length} 个**（账本不含该脚本条目 ⇒ 不判 FAIL、` +
          '**也不计入已核对**）：' + tri.unmet.join('、') +
          ' —— `--fast` 形态的主账本不含浏览器/长跑脚本时属**正常形态**；' +
          '权威对账由 run-all 收尾按**全量** SUITES 判定（与 `E50`／`E55` 同口径）');
      }
    }

    /* `D22` 定点变异：把 `ui-check` 的 `（+1 跳过）` 后缀改成 `（+9 跳过）`（**内存文本变异**，
       不落地、不碰仓库、不用 `git checkout`）⇒ 本判据必红**并指名 `ui-check`**；未变异的当前源码必绿。
       ⚠ **两种账本语境下都要成立**（`D20` 边界的核心要求；`--fast` 档实测踩到过）：
         · ㈠**账本覆盖不足**（`--fast` 形态主账本不含浏览器/长跑脚本）⇒ 那些脚本进 `unmet`
           （**本轮不可比**）而**不是 `findings`** ⇒ 基线**必绿**、判据**不红**；
         · ㈡**账本覆盖充分**（全量形态）⇒ 基线同样必绿，变异后**必红并指名 `ui-check`**。
       ⚠ 基线仍用"按需补齐待同步项"的内存副本：只在"权威区还没写出该跳过数、且账本里**有**该脚本"
         时才补（否则会拿"本来就红"当基线，证明不了可证伪性）。补齐只作用于**内存副本**。 */
    const baselineAuth = (() => {
      const m = nameDecl('harness-check', [{ text: authLine, from: 'x' }]);
      const hs = ledgerSummary['harness-check'];
      if (!m) return null;
      if (!hs || m.skipDeclared !== null) return authLine;   /* 本轮不可比 或 已写跳过数 ⇒ 无需补齐 */
      return authLine.replace(
        new RegExp('(`harness-check`\\s*\\*{0,2}\\s*' + m.declared + '\\s*/\\s*' + m.failed + ')\\s*\\*{0,2}'),
        `$1/${hs.skipped}** `);
    })();
    const baseTri = baselineAuth === null ? null : tripleAudit(baselineAuth, nm => ledgerSummary[nm]);
    const mutAuth = baselineAuth === null ? null
      : baselineAuth.replace(/(`ui-check`\s*\*{0,2}\s*\d+\s*\/\s*\d+\s*\*{0,2}\s*[（(]\s*\+\s*)(\d+)(\s*跳过)/,
        (_, a, n, c) => a + (Number(n) + 8) + c);
    const mutTri = mutAuth === null ? null : tripleAudit(mutAuth, nm => ledgerSummary[nm]);
    const mutSha = mutAuth === null ? null : require('node:crypto').createHash('sha256').update(mutAuth).digest('hex');
    const diskAuth = (readmeSrc.split(/\r?\n/).find(l => l.includes('离线可跑部分')) || '');
    t.check('E112 D22 定点变异（**两种账本语境下都要成立**）：把 `ui-check` 的 `（+1 跳过）` 后缀改成 ' +
      '`（+9 跳过）`（**内存文本变异**）⇒ "三元写全"判据必红**并指名 `ui-check`**；' +
      '而**账本覆盖不足**（`--fast` 形态主账本不含浏览器/长跑脚本）时，那些脚本按 `D20` 记**本轮不可比**，' +
      '基线在**两种语境下都必绿**（不把"前提不成立"当失败）；权威行在盘上逐字未变',
      baseTri !== null && mutTri !== null && mutSha !== null
        && baseTri.findings.length === 0
        && mutTri.findings.length > 0
        && mutTri.findings.some(f => f.includes('ui-check') && f.includes('跳过 9'))
        && diskAuth === authLine,
      `基线失配 ${baseTri ? baseTri.findings.length : '（锚点未命中）'} 条（基线不可比 ${baseTri ? baseTri.unmet.length : '-'} 个）；` +
      `变异体 sha256=${mutSha ? mutSha.slice(0, 12) + '…' : '（无）'}；` +
      `变异后失配 ${mutTri ? mutTri.findings.length : '（无）'} 条：` +
      `${mutTri ? mutTri.findings.join('；') : ''}｜盘上权威行逐字未变=${diskAuth === authLine}`);
  }

  /* ---- 断言 10（`E136`，2026-10-04）：三只**浏览器/长跑**脚本的**通过数**逐脚本判据（**只读账本**） ----
     立案（座位 5 的 `C·21` 靶子③顺带报出、主代理登记）：`offlineGates` 只含 `!needBrowser` ⇒
     `browser-check`／`overlap-check`／`stress-check` 的**通过数**在本节**没有任何逐脚本判据**
     （下面断言 8 的 `tripleAudit` 虽遍历**全量** `SUITES`，但只比"**失败数／跳过数**"两位）。
     **实测**：把主账本里 `browser-check` 的 `passed` 从 33 改成 99，本节仍 **79/0/0 全绿** ⇒
     "权威区声明"与"实跑"之间对这三条**只剩合计级保护**（`sumListed ≤ statedTotal` ＋ `run-all` 收尾合计）。
     为什么这三条只做"**只读账本**"的判据（**故意不实跑**）：
       · 它们是**浏览器/CDP/长跑**脚本（`stress-check` 默认就跑 5 分钟）—— 为了核一个数字去起浏览器、
         跑 5 分钟长跑，是拿"判据的成本"去换"它要防的风险"（`E52`：一轮收口只跑一次全量）；
       · 它们在 `run-all` 的 `serialTail` 里排在**本脚本之后** ⇒ **本轮**账本**天然不含**它们
         （`run-totals.json` 是"每跑完一条就落盘"的增量账）。故判据只在"账本里**有**该脚本条目"时比 ——
         这正是 `D20` 的边界：**账本覆盖不到 ⇒ 本轮不可比**（点名、**不判 FAIL**、**也不计入已核对**，
         与断言 8 的 `unmet` 同口径）。**不许装绿**：`已核对 ＋ 不可比 === 应有值`（一个都不许消失）。
     为什么"账本里有且**数不符** ⇒ **必红**"（而不是也记"不可比"）：账本里那份数只可能来自某次
     **全量**轮（`--fast` 不写这三条），它与权威区声明不符就是**真漂移**（`D19`／`D21`／`D23`：
     判据强度**不许降**）；要消除它只需再跑一次**全量**轮刷新账本（不是改判据去迎合）。 */
  const browserGatesE136 = (SUITES_READ || []).filter(s => s.needBrowser).map(s => s.name);
  const browserDeclOfE136 = (nm) => nameDecl(nm, [{ text: authLine, from: '权威区逐脚本清单' },
    { text: readmeSrc, from: 'tests/README.md 全文' }]);
  /** 判据本体（**纯函数**：D22 复用它 ⇒ "变异后变红"能证伪这条断言）。 */
  const browserLedgerAuditE136 = (declOf, sumOfName) => {
    const findings = [];
    const covered = [];
    const unmet = [];
    for (const nm of browserGatesE136) {
      const d = declOf(nm);
      if (!d) { findings.push(`${nm}：权威区里解析不出 \`通过/失败\` 声明`); continue; }
      const sum = sumOfName(nm);
      /* `D20`：账本覆盖不到 ⇒ **本轮不可比**（它们在 `serialTail` 里排在本脚本之后，属正常形态） */
      if (!sum) { unmet.push(`${nm}（本轮账本无该脚本条目）`); continue; }
      covered.push(nm);
      if (d.declared !== sum.passed) {
        findings.push(`${nm}：权威区写 **${d.declared} 通过** ≠ 账本 ${sum.passed}（**通过数逐脚本漂移**；` +
          `该数只来自全量轮，故它就是真漂移 —— 重跑一次全量轮刷新账本，不要改判据）`);
      }
    }
    return { findings, covered, unmet };
  };
  {
    const brAudit = browserLedgerAuditE136(browserDeclOfE136, nm => ledgerSummary[nm]);
    t.check('E136 三只**浏览器/长跑**脚本的**通过数**逐脚本对账（**只读账本**，不实跑）：权威区声明的通过数 = ' +
      '`run-totals.json` 里该脚本的 `passed`；**账本覆盖不到 ⇒ 按 `D20` 报"本轮不可比"并点名**' +
      '（不判 FAIL、也不计入已核对）；`已核对 ＋ 不可比 === 应有值`（**不许装绿**）',
      browserGatesE136.length > 0 && brAudit.findings.length === 0
        && brAudit.covered.length + brAudit.unmet.length === browserGatesE136.length,
      (brAudit.findings.length ? `**失配 ${brAudit.findings.length} 条**：${brAudit.findings.join('；')}`
        : `逐脚本一致（${brAudit.covered.map(n => `${n}=${ledgerSummary[n].passed}/${ledgerSummary[n].failed}/${ledgerSummary[n].skipped}`).join('、') || '（无可比项）'}）`) +
      `｜**已核对 ${brAudit.covered.length}／${browserGatesE136.length} 个**` +
      `｜**本轮不可比 ${brAudit.unmet.length} 个**：${brAudit.unmet.join('、') || '（无）'}` +
      `｜声明：${browserGatesE136.map(n => { const d = browserDeclOfE136(n); return `${n}=${d ? d.declared : '（解析不到）'}`; }).join('、')}` +
      `｜账本 ${totals.ok ? `可读（${path.relative(env.paths.root, totals.file)}）` : '不可用：' + totals.why}`);
    if (brAudit.unmet.length) {
      t.info(`§11「E136 浏览器/长跑脚本通过数」**本轮不可比 ${brAudit.unmet.length} 个**（账本不含该脚本条目 ⇒ ` +
        '不判 FAIL、**也不计入已核对**）：' + brAudit.unmet.join('、') +
        ' —— 它们在 `run-all.__serialTail` 里排在 `docs-cross-check` **之后**，本轮账天然不含它们（`--fast` 形态同理）；' +
        '权威对账由 `run-all` 收尾按**全量** SUITES 判定（与 `E50`／`E112` 同口径）');
    }
    /* `E136` 的 D22：**内存变异账本副本**（不改盘上 `run-totals.json`）——
       ㈠把某只脚本的 `passed` 改错 ⇒ **必红并指名它**；㈡把它置空 ⇒ **从"已核对"移到"不可比"**
       （两侧各变 1、总数不变）⇒ 证明"覆盖不足"既不判 FAIL、也不装绿。**两种账本语境都成立**。 */
    /* `E136` 的 D22：用**完全受控的合成三元组**（**不依赖盘上账本的当前状态** ⇒ 基线一定干净），
       复用**同一个纯函数** `browserLedgerAuditE136()` ⇒ "变异后变红并指名"能证伪这条断言。
       ⚠ 为什么不用"改盘上账本的那一个数"当判据（**实测踩过**）：若账本本身已经被外部改脏（或有真漂移），
       `target` 的基线**本来就红**，"变异后恰多 1 条"这条差集判据就不成立 —— 那会把"判据可证伪"
       与"账本恰好干净"两件事焊在一起。⇒ 判据用合成输入，**真实账本**再各做一次同样的内存变异，
       只作读数留痕（差集为 0 时说明"账本本来就红"，如实打印、不判红）。 */
    const targetE136 = brAudit.covered[0] || browserGatesE136[0];
    const baseE136 = ledgerSummary[targetE136];
    const synthDeclE136 = (nm) => ({ declared: nm === targetE136 ? 33 : 7, failed: 0, skipDeclared: 0, from: '（合成三元组）' });
    const synthSumE136 = (nm) => ({ passed: nm === targetE136 ? 33 : 7, failed: 0, skipped: 0 });
    const synthBaseE136 = browserLedgerAuditE136(synthDeclE136, synthSumE136);
    const synthMutE136 = browserLedgerAuditE136(synthDeclE136,
      (nm) => (nm === targetE136 ? { passed: 99, failed: 0, skipped: 0 } : synthSumE136(nm)));
    const synthHideE136 = browserLedgerAuditE136(synthDeclE136,
      (nm) => (nm === targetE136 ? undefined : synthSumE136(nm)));
    const mutSumE136 = (nm) => (nm === targetE136
      ? { passed: (baseE136 ? baseE136.passed : 0) + 66, failed: 0, skipped: 0 }
      : ledgerSummary[nm]);
    const hideSumE136 = (nm) => (nm === targetE136 ? undefined : ledgerSummary[nm]);
    const mutAuditE136 = browserLedgerAuditE136(browserDeclOfE136, mutSumE136);
    const hideAuditE136 = browserLedgerAuditE136(browserDeclOfE136, hideSumE136);
    const diskLedgerShaE136 = require('node:crypto').createHash('sha256')
      .update(totals.ok ? fs.readFileSync(totals.file) : Buffer.from('')).digest('hex').slice(0, 12);
    t.check('E136 D22（可证伪）：用**受控合成三元组**（不依赖盘上账本的当前状态）把某只浏览器/长跑脚本的' +
      '通过数改错（`33 ⇒ 99`）⇒ 本判据**必红并指名它**（恰 1 条）；把它置空 ⇒ 该项**从"已核对"移到"不可比"**' +
      '（`已核对＋不可比` 总数不变）⇒ `D20` 边界两边都不装绿；判据复用的是**同一个纯函数**；' +
      '盘上账本**逐字节未变**（全程只读它，不写它）',
      synthBaseE136.findings.length === 0 && synthBaseE136.covered.length === browserGatesE136.length
        && synthMutE136.findings.length === 1
        && synthMutE136.findings[0].includes(targetE136) && synthMutE136.findings[0].includes('通过数逐脚本漂移')
        && synthMutE136.covered.length + synthMutE136.unmet.length === browserGatesE136.length
        && !synthHideE136.covered.includes(targetE136)
        && synthHideE136.unmet.some(x => x.startsWith(targetE136)) && synthHideE136.findings.length === 0
        && synthHideE136.covered.length + synthHideE136.unmet.length === browserGatesE136.length,
      `合成基线：失配 ${synthBaseE136.findings.length} 条／已核对 ${synthBaseE136.covered.length}（应 0／${browserGatesE136.length}）；` +
      `合成变异（33 ⇒ 99）：失配 ${synthMutE136.findings.length} 条 ⇒ ${synthMutE136.findings.join('；') || '（无，异常）'}；` +
      `合成置空：已核对 ${synthHideE136.covered.length}／不可比 ${synthHideE136.unmet.length}（总数 ${browserGatesE136.length} 不变）、` +
      `已移入不可比=${!synthHideE136.covered.includes(targetE136)}；` +
      `【真实账本读数（只留痕、不判红）】基线失配 ${brAudit.findings.length} 条（正常 = 0，由上面那条主断言判）；` +
      `内存改「${targetE136} 的 passed ⇒ ${(baseE136 ? baseE136.passed : 0) + 66}」后失配 ${mutAuditE136.findings.length} 条、` +
      `置空后已核对 ${hideAuditE136.covered.length}／不可比 ${hideAuditE136.unmet.length}；` +
      `盘上账本 sha256=${diskLedgerShaE136}…（D22 的变异只作用于内存访问器，不落盘）`);
  }

  /* ---- 自指排除的如实交代：docs-cross-check 自身的声明值不在本节比对范围内 ---- */
  const notCompared = offlineGates.filter(n => n !== SELF_REF && sourceOf[n] === undefined);
  t.info(`未纳入逐脚本比对的离线门禁：${SELF_REF}（自指）` +
    (notCompared.length ? `；另有未取到值的：${notCompared.join('、')}` : '') +
    '（docs-cross-check 为**自指**：它声明的条数 = 它自己这次跑出来的通过数，本节结束时才确定，' +
    '账本里那条还只是它中途落盘的数；其漂移由 run-all 收尾的 verifyAuthorityTotals 按合计拦截）' +
    `｜实跑探针墙钟 ${probeWallMs} ms`);

  /* ---------------- 十五、正文"当前值"穷举校验（E51，2026-09-29 补） ----------------
     立案（2026-09-28 登记）：本文件原先只校验**权威区**（`tests\README.md` 第三节）的数字，
     **其它文档正文里的叙述性数字无人守** ⇒ 已实测滞后两次：架构/快照引"权威区合计 690 ＝ 690
     （真实通过 688）"、快照一屏速览写"165/259（63.7%）＋ 153/259（59.1%）"。
     本节把"**当前值区**"用**唯一标记**圈出来（不再按"整个 §一"取 —— §一 混着 714/773/590 这类
     过去轮次的数字，且历史回执行 `> **09-…` 一律**故意不动**），在这些区域里**穷举**抓取下列家族：
       ① 门禁三元组 `门禁 … N 通过 / M 失败 / K 跳过`（对**权威区声明值**；该值已由第十/十一节对实跑校验）
       ② `可追溯覆盖 N/M` ③ `离线可验证 N/M` ④ `AC 覆盖 N/M`（对 **`trace-check` 实跑值**）
       ⑤ `tests\ 共 N 个`（对**文件系统**：`tests\*.js` 顶层脚本数）
     锚点找不到 ⇒ **判红**（防文档改结构后本检查被静默架空）；某家族在区域内一处都没有 ⇒ 进"未覆盖清单"
     （只提示），但**门禁三元组与可追溯覆盖必须各有 ≥1 处**（防"把声明删掉就没人守了"）。 */
  {
    const snapSrc51 = read(SNAP_REL);
    const archSrc51 = read(ARCH_REL);
    const roadSrc51 = read(ROAD_REL);
    const pickLine = (src, pred) => (src.split(/\r?\n/).find(pred) || null);
    /* ⚠ **锚点不许写死"会漂移的计数"**（`T-20261003-12` 追加轮，2026-10-03）——
       实测踩过：本行的旧锚点是 `l.includes('全量 16 个') && l.includes('门禁')`，
       而"全量 16 个"里的 **16 是脚本总数**（离线 14 ＋ 浏览器/长跑 3 ＝ 17）⇒
       新增一个门禁脚本（`E9` 的 `offline-check`，16 → 17）就让锚点**定位不到** ⇒
       `E51 前提` 判红、`E51 断言` 因 `miss51.length > 0` **连带判红**（两条红都不是真缺陷，
       是**判据自身**脆弱）。**这与本节要守的东西恰好相反**：本节守的是"正文里的数字要与实跑一致"，
       而锚点自己却把数字焊死了 ⇒ "加脚本 ⇒ 锚点静默失效"会**每加一次脚本复发一次**。
       ⇒ **改用不含计数的结构性锚点**：`全量`（该口径的关键词，与旧锚点同源、便于 grep 溯源）
       ＋ `个脚本的总计`（该行对"门禁三元组口径"的**结构性描述**，逐字不出现在任何历史回执行里）
       ＋ `门禁`。实测唯一命中快照第 66 行（`全量`／`门禁` 两词单独用会命中多行 —— 见回执的锚点唯一性表）。
       **可证伪性**（改完必须两端都验，见回执）：①把该行数字改坏 ⇒ `E51 断言` 必红并指名；
       ②把 `个脚本的总计` 这个结构性措辞删掉 ⇒ `E51 前提` 必红并指名"快照一屏速览行"。
       同节其余 4 个锚点**均不含计数**（`跑一遍门禁看结论`／`当前值（本行由…守护`／
       `门禁总数（当前）`／路线图的 `/门禁\s*\d+\s*通过/` —— 最后这个是**形状**正则、
       不钉具体数字），故本次只改这一处；全节普查见回执。 */
    const regions = [
      { name: '快照一屏速览行', txt: pickLine(snapSrc51, l => l.includes('全量') && l.includes('个脚本的总计') && l.includes('门禁')), must: true },
      { name: '快照「跑一遍门禁看结论」行', txt: pickLine(snapSrc51, l => l.includes('跑一遍门禁看结论')), must: true },
      { name: '架构「当前值（本行由 docs-cross-check 第十五节守护）」行', txt: pickLine(archSrc51, l => l.includes('当前值（本行由') && l.includes('守护')), must: true },
      { name: '架构「门禁总数（当前）」行（旧锚点，可选）', txt: pickLine(archSrc51, l => l.includes('门禁总数（当前）')), must: false },
      { name: '路线图头部基线行', txt: pickLine(roadSrc51.split(/\r?\n/).slice(0, 12).join('\n'), l => /门禁\s*\d+\s*通过/.test(l)), must: true }
    ];
    const miss51 = regions.filter(r => r.must && !r.txt).map(r => r.name);
    t.check('E51 前提："当前值区"锚点都可定位（文档改结构必须同步本节，不许静默架空）',
      miss51.length === 0, miss51.length ? `定位不到：${miss51.join('、')}` : `${regions.filter(r => r.txt).length} 区命中（${regions.filter(r => r.txt).map(r => r.name).join('、')}）`);
    const body51 = regions.filter(r => r.txt).map(r => r.txt).join('\n');
    /* 期望值：① 权威区声明 ② trace-check 实跑 ③ 文件系统 */
    const authLine51 = (readmeSrc.split('\n').find(l => l.includes('离线可跑部分')) || '');
    const expTriple51 = (authLine51.match(/合计\s*\*{0,2}(\d+)\s*通过\s*\/\s*(\d+)\s*失败\s*\/\s*(\d+)\s*跳过/) || []).slice(1).map(Number);
    const tr51 = probe('trace-check');
    const numPair = (src, re) => (src.match(re) || []).slice(1).map(Number);
    const expCov51 = numPair(tr51.out, /可追溯覆盖[^\d]*(\d+)\s*\/\s*(\d+)/);
    const expOff51 = numPair(tr51.out, /离线可验证覆盖[^\d]*(\d+)\s*\/\s*(\d+)/);
    const expAc51 = numPair(tr51.out, /AC 覆盖[^\d]*(\d+)\s*\/\s*(\d+)/);
    const jsCount51 = fs.readdirSync(env.paths.tests).filter(n => n.endsWith('.js')).length;
    const fams51 = [
      { name: '门禁三元组', re: /门禁[^\d]{0,12}(\d+)\s*通过\s*\/\s*(\d+)\s*失败\s*\/\s*(\d+)\s*跳过/g, exp: expTriple51, must: true },
      { name: '可追溯覆盖', re: /(?:可)?追溯覆盖[^\d]{0,12}(\d+)\s*\/\s*(\d+)/g, exp: expCov51, must: true },
      { name: '离线可验证', re: /离线可验证[^\d]{0,12}(\d+)\s*\/\s*(\d+)/g, exp: expOff51, must: false },
      { name: 'AC 覆盖', re: /AC 覆盖[^\d]{0,8}(\d+)\s*\/\s*(\d+)/g, exp: expAc51, must: false },
      { name: 'tests\\*.js 个数', re: /tests\\[^\d]{0,14}(\d+)\s*个/g, exp: [jsCount51], must: false }
    ];
    const bad51 = [];
    const zero51 = [];
    const counts51 = [];
    for (const fam of fams51) {
      let hits = 0;
      let m;
      fam.re.lastIndex = 0;
      while ((m = fam.re.exec(body51)) !== null) {
        hits++;
        const got = m.slice(1).map(Number);
        const ok = fam.exp.length > 0 && got.length === fam.exp.length && got.every((v, i) => v === fam.exp[i]);
        if (!ok) bad51.push(`${fam.name}：正文写 ${got.join('/')} ≠ 期望 ${fam.exp.join('/') || '（取不到实跑值）'}（"${m[0].replace(/\s+/g, ' ').trim()}"）`);
      }
      counts51.push(`${fam.name}=${hits}`);
      if (hits === 0 && fam.must) zero51.push(fam.name);
    }
    t.check('E51 断言：正文"当前值区"里**每个**被抓到的数字都等于实跑/权威值（零失配），且门禁三元组与可追溯覆盖**各 ≥1 处**',
      miss51.length === 0 && expTriple51.length === 3 && bad51.length === 0 && zero51.length === 0,
      (bad51.length ? `失配 ${bad51.length} 处：${bad51.slice(0, 4).join('；')}` : '零失配')
      + (zero51.length ? `｜**必守家族一处都没找到**：${zero51.join('、')}` : '')
      + `｜命中计数：${counts51.join('、')}`);
    const zeroList51 = fams51.map((f, i) => ({ n: f.name, c: Number(String(counts51[i] || '0').split('=')[1] || 0) }))
      .filter(x => x.c === 0).map(x => x.n);
    t.info(`E51 未覆盖清单（该家族在"当前值区"里没出现，属正常，仅记录以免"悄悄删掉"）：${zeroList51.join('、') || '无'}`);
  }


  /* ---------------- 十六、正文「内部引数」对账（`E112`，2026-10-04 补） ----------------
     【为什么要有这一节】第十节只管**权威区**（`tests\README.md` 第三节）、第十五节只管
     **被唯一标记圈出来的"当前值区"**；两者之外的**正文内部引数**此前**没有任何对账** ⇒ 已实测
     漂移：架构文档 4 处 `11 个组件`（真源 12，`E119`）、同一文档 `db-check` 238／220／权威 285
     **三值并存**（`E120`）、权威行内部 `4 跳过`（真值 6）／`16 个脚本`（真值 17）／
     `那 13 个`（真值 14）（`E112` 第二批），以及座位 2 在 `T-20261004-08` 里逐处报出的 6 处
     同族陈旧引数（`docs-cross-check` 68／`harness-check` 258／`logic-check` 120 等）。
     本节把**可机器核实的引数**与**真源**逐处比对。

     【⚠ 为什么范围**必须显式列明**、绝不能做成"扫全文找数字"】
     本节的命中口径是"**文件 × 行范围 × 形态**"三元组，三者都写死在下面的 `SRC16`／`FAM16` 里。
     依据是**本机实测**的两处反例（2026-10-04，探针
     `tests\._verify\t20261004-07\probe-arch-refs2.js`，只读）：
       · 若允许在 `tests\README.md` 里抓「N 个组件」⇒ 会命中权威行中的
         「单次 tick + **10 个组件**全量重绘约 0.1 ms」—— 那是**性能微基准的历史读数**，
         与"组件清单有几项"毫无关系（真源 12）⇒ 白白造出一条**归属错**的假红；
       · 若允许在该行里抓「`<脚本名>`（N 项）」⇒ 会命中
         「唯一失败脚本＝`docs-check`（**2 项**＝6.4 已登记偏差）」—— 那个 2 是**该轮的失败条数**，
         不是"该脚本有多少条断言"（真源 46）⇒ 同族假红。
     ⇒ 结论：**数字本身没有归属，归属只由"它出现在哪一行的哪一种形态里"决定**（`E110` 同族
       教训）。故本节只认**紧贴锚点短语**的形态，且**逐文件登记允许的形态族**（`SRC16[].fams`）。

     【⚠ 为什么必须排除 dated 历史记录】
     变更记录／历史台账里的数字是"**当时的真值**"，不是"现在的错值"：改它等于**改写历史**
     （硬纪律 10）。同一份架构文档里的**真实例子**：
       · `:365`（§十一 变更记录 2026-09-29 行）写「逐脚本条数（… `db-check` **220** …）」——
         `220` 是那一轮的真实口径，**不许动**，也不许被判红（座位 2 已就地补注
         "（均为 2026-09-29 当时口径）"）；
       · `:292` 的「权威区合计 **1248 ＝ 1248**」是 2026-10-02 的 dated 引文，同理排除；
       · 「13 张表」全族**本条判据不碰**：`schema.sql` 实为 15 条 `CREATE TABLE`、
         `tests\db-check.js` 的 `REQUIRED_TABLES` 为 14、而权威区与本节同文件 `:445` 都写 13
         ⇒ 牵涉**口径裁定未定**（已另立 `E123`），纳入会把 `docs-cross-check` 打红。
     ⇒ 排除口径（**两条，取并集**；都是"按小节/行前缀限定"，不是"按数字大小猜"）：
       ① 行前缀是 `| <4 位年>-<2 位月>-<2 位日>` 的行（dated 表格行）；
       ② 位于「变更记录」小节标题之后的**所有**行（该小节整体是历史）。

     【范围总表 `SRC16` —— 逐文件登记"扫哪些行、允许哪些形态"】
       · `项目架构与技术栈.md`：**非 dated 行**；允许 ①②③a③b③c④（全族）。
       · `tests\README.md`：**仅权威行**（含 `离线可跑部分` 的那一行）；只允许 ②③a④
         （① 与 ③b/③c 在该行的实测假命中见上）。
       · `项目记录\当前状态快照.md`／根 `README.md`／`PROJECT_RULES.md`／`项目记录\后续路线图.md`：
         **本节不扫**，逐条给理由（**显式排除，不是漏掉**）：
           - 快照：正文数字已由第十五节按**当前值区**锚点守护；整份扫描会命中早期阶段行
             （如 `tests\ 现有 **20 个** *.js（**13 个** 离线门禁）`＝2026-09-19 当时的真值）⇒ 假红；
           - 根 `README.md`：「N 个组件」的清单口径已由 **`E94`** 的三方不变量守着
             （`src\components\*.js` ＝ `index.html` 注册数 ＝ README §二声明数），本节不重复实现；
           - `PROJECT_RULES.md`／`后续路线图.md`：其中的数字多属 **dated 台账/债号行**，
             纳入只会带来假红，而同族的重复守护收益为零。
       · **「14 个的和是 M」这一族的真源**＝`Σ(13 个非自指离线门禁的实跑通过数) ＋ 权威区对
         自指脚本 docs-cross-check 的声明数`（自指脚本的实跑值本节结束时才确定 ⇒ 见下）。
       · **③ `<脚本名>`（N 项）⇒ 该脚本实跑条数**：取数与**第十一节同源**
         （账本快路径 ＋「声明≠账」时冲突复核），**唯一例外＝自指脚本 `docs-cross-check` 自身**
         —— 第十一节已按同一理由把它排除逐脚本比对，故它与**权威区 README 的同名声明**比对，
         并在详情里如实标注"自指 ⇒ 与权威区比对"。
     【口径】按 `D19`：本节只证明"文档里的数字与真源一致"，**不构成**任何实现证据。 */
  {
    /* —— 真源取数 —— */
    const compCount16 = (() => {
      try { return fs.readdirSync(path.join(ROOT, 'src', 'components')).filter(n => n.endsWith('.js')).length; }
      catch { return null; }
    })();
    const jsTop16 = fs.readdirSync(env.paths.tests).filter(n => n.endsWith('.js')).length;
    const offlineCount16 = offlineGates.length;
    /** `<脚本名>`（N 项）族的期望值：实跑通过数（与第十一节同源）；自指脚本 ⇒ 权威区声明。 */
    const scriptTruth16 = (name) => (name === SELF_REF ? declaredOf(name) : actualOf(name));
    const sumMissing16 = offlineGates.filter(n => n !== SELF_REF && actualOf(n) === undefined);
    const sumTruth16 = offlineGates.filter(n => n !== SELF_REF)
      .reduce((a, n) => a + (actualOf(n) === undefined ? 0 : actualOf(n)), 0)
      + (declaredOf(SELF_REF) === null ? 0 : declaredOf(SELF_REF));

    /* —— 范围与形态表（**唯一**的命中口径；改口径必须同步这段注释） —— */
    /** dated 历史记录的排除口径（三条，取并集；都是"按小节/行前缀/显式锚点限定"，不按数字大小猜）：
     *  ① 行前缀是 `| <4 位年>-<2 位月>-<2 位日>`（变更记录表格行）；
     *  ② 位于「变更记录」小节标题之后的**所有**行（该小节整体是历史）；
     *  ③ 带**dated 引文标记**的行（`原始输出引文`／`（最近一轮：2026-10-02`／`截至 <日期>`）——
     *     实测例子：`项目架构与技术栈.md:292` 的「权威区合计 **1248 ＝ 1248**（最近一轮：2026-10-02 …）」
     *     是**当轮的原始输出引文**（≠ 现在的真值，也不该改），但它**不带日期行前缀、也在变更记录之前**
     *     ⇒ 只靠 ①② 抓不到它（本轮如实补上 ③，并把理由写在这里）。 */
    const isDated16 = s => /^\s*\|?\s*\d{4}-\d{2}-\d{2}/.test(s)
      || /原始输出引文|最近一轮[:：]|截至\s*\d{4}-\d{2}-\d{2}/.test(s);
    const archAll16 = read(ARCH_REL).split(/\r?\n/);
    const cutPos16 = archAll16.findIndex(l => /^#+\s*.*变更记录/.test(l));
    const archRows16 = archAll16.map((text, i) => ({ file: ARCH_REL, no: i + 1, text }))
      .filter(r => !isDated16(r.text) && (cutPos16 < 0 || r.no - 1 < cutPos16));
    const archExcluded16 = archAll16.length - archRows16.length;
    const readmeNo16 = readmeSrc.split(/\r?\n/).findIndex(l => l.includes('离线可跑部分')) + 1;
    const authRows16 = [{ file: 'tests/README.md', no: readmeNo16, text: authLine }];
    const FAM16 = {
      comp: { id: '①N 个（界面）组件', re: /(\d+)\s*个\s*\*{0,2}(?:界面)?组件/g, kind: 'count', truth: () => compCount16 },
      gates: { id: '②N 个（离线）门禁', re: /(\d+)\s*个\s*\*{0,2}(?:为)?(?:带断言的)?(?:（离线）|\(离线\)|离线)?\s*门禁/g, kind: 'count', truth: () => offlineCount16 },
      js: { id: '③a N 个 `tests\\*.js`', re: /(\d+)\s*个\*{0,2}\s*`(?:\*\.js|tests\\\*\.js)`/g, kind: 'count', truth: () => jsTop16 },
      scriptJ: { id: '③b `脚本.js`（N 项）', re: /`([a-z0-9-]+)\.js`\s*（\s*\*{0,2}\s*(\d+)\s*项/g, kind: 'script' },
      scriptC: { id: '③c `脚本`（…N 项）', re: /`([a-z0-9-]+)`\s*（[^（）|]{0,14}?\*{0,2}(\d+)\s*项/g, kind: 'script' },
      sum: { id: '④N 个的和是 M', re: /(\d+)\s*\*{0,2}\s*个\s*\*{0,2}\s*的和是\s*\*{0,2}(\d+)/g, kind: 'sum' }
    };
    const SRC16 = [
      { file: ARCH_REL, rows: archRows16, fams: ['comp', 'gates', 'js', 'scriptJ', 'scriptC', 'sum'], must: ['comp', 'gates', 'js', 'scriptJ'] },
      { file: 'tests/README.md', rows: authRows16, fams: ['gates', 'js', 'sum'], must: ['gates', 'sum'] }
    ];
    /** 判据本体（**纯函数**：D22 复用同一个函数，否则变异绿了也证明不了可证伪）。
     *  @returns {{hits:Object, findings:Array<{key:string,msg:string}>, lost:Array<string>, checked:number}} */
    const audit16 = (srcs) => {
      const hits = {}; const findings = []; const lost = []; let checked = 0;
      for (const src of srcs) {
        for (const key of src.fams) {
          const fam = FAM16[key];
          let n = 0;
          for (const row of src.rows) {
            fam.re.lastIndex = 0;
            let m;
            while ((m = fam.re.exec(row.text)) !== null) {
              n++; checked++;
              const where = `${src.file}:${row.no}`;
              const raw = m[0].replace(/\s+/g, ' ');
              if (fam.kind === 'count') {
                const got = Number(m[1]); const exp = fam.truth();
                if (exp === null || got !== exp) {
                  findings.push({ key, msg: `${where} ${fam.id}：正文写 ${got} ≠ 真源 ${exp === null ? '（取不到）' : exp}（"${raw}"）` });
                }
              } else if (fam.kind === 'script') {
                const name = m[1]; const got = Number(m[2]); const exp = scriptTruth16(name);
                if (exp === null || exp === undefined) {
                  findings.push({ key, msg: `${where} ${fam.id}：\`${name}\`（${got} 项）**取不到真源**（该脚本没有实跑值/权威区声明）` });
                } else if (got !== exp) {
                  findings.push({ key, msg: `${where} ${fam.id}：\`${name}\` 正文写 ${got} 项 ≠ 真源 ${exp}` +
                    `${name === SELF_REF ? '（自指 ⇒ 与权威区声明比对）' : '（实跑通过数）'}（"${raw}"）` });
                }
              } else {
                const n2 = Number(m[1]); const got = Number(m[2]);
                if (n2 !== offlineCount16) {
                  findings.push({ key, msg: `${where} ${fam.id}："${raw}" 的"${n2} 个"≠ 离线门禁实数 ${offlineCount16}` });
                } else if (got !== sumTruth16) {
                  findings.push({ key, msg: `${where} ${fam.id}："${raw}" 写 ${got} ≠ 真源 ${sumTruth16}` +
                    `（＝离线门禁实数中的 ${n2 - 1} 个**非自指**脚本实跑值之和 ＋ 权威区对自指脚本 \`${SELF_REF}\` 的声明）` });
                }
              }
            }
          }
          hits[key] = (hits[key] || 0) + n;
          if (n === 0 && src.must.includes(key)) lost.push(`${src.file} 的「${fam.id}」锚点一处都没命中`);
        }
      }
      return { hits, findings, lost, checked };
    };

    const A16 = audit16(SRC16);
    const famCounts16 = Object.keys(FAM16).map(k => `${FAM16[k].id}=${A16.hits[k] || 0} 处`).join('、');
    t.check('E112 §16 前提：正文「内部引数」的范围锚点都可定位（**文件 × 行范围 × 形态**三元组；' +
      '必守形态族命中 0 处即判红 —— 文档改结构必须同步本节，不许静默架空）',
      A16.lost.length === 0 && A16.checked > 0,
      `${A16.checked} 处命中｜${famCounts16}｜范围：${SRC16.map(s => `${s.file}（${s.rows.length} 行）`).join('、')}` +
      `｜dated 历史记录**已排除** ${archExcluded16} 行（口径：日期行前缀 ／ 变更记录小节之后 ／ dated 引文标记）` +
      (A16.lost.length ? `｜**锚点丢失**：${A16.lost.join('；')}` : '') +
      `｜真源：组件 ${compCount16}／离线门禁 ${offlineCount16}／tests\\*.js ${jsTop16}／和值 ${sumTruth16}` +
      (sumMissing16.length ? `（**和的取数不完整**：${sumMissing16.join('、')} 无实跑值）` : ''));

    const badNum16 = A16.findings.filter(f => f.key !== 'sum');
    const badSum16 = A16.findings.filter(f => f.key === 'sum');
    t.check('E112 §16 断言（数量族 ①②③）：正文内部引数（N 个组件／N 个（离线）门禁／N 个 `tests\\*.js`／' +
      '`<脚本名>`（N 项））与真源**零失配**（逐处指名 `文件:行号`；真源＝`src\\components\\*.js` 文件数／' +
      '`run-all` 的 `SUITES` 过滤结果／各脚本**实跑**条数）',
      badNum16.length === 0,
      badNum16.length ? `失配 ${badNum16.length} 处：${badNum16.map(f => f.msg).join('；')}`
        : `零失配（${Object.keys(FAM16).filter(k => k !== 'sum').map(k => `${FAM16[k].id}=${A16.hits[k] || 0} 处`).join('、')}）；` +
          `真源：组件 ${compCount16}／离线门禁 ${offlineCount16}／tests\\*.js ${jsTop16}／各脚本实跑条数`);

    t.check('E112 §16 断言（和值族 ④）：「N 个的和是 M」的 N ＝ 离线门禁实数、M ＝ 真源和值' +
      '（真源＝13 个非自指离线门禁的实跑通过数之和 ＋ 权威区对自指脚本的声明数）',
      badSum16.length === 0,
      badSum16.length ? `失配 ${badSum16.length} 处：${badSum16.map(f => f.msg).join('；')}`
        : `零失配（命中 ${A16.hits.sum || 0} 处，和值真源 ${sumTruth16}）`);

    /* ---- `D22` 定点变异（**内存文本变异**：字节副本 ＋ sha256 留痕 ＋ 盘上文件未变的复核；
       不落地、不碰仓库、不用 `git checkout`／`restore`／`stash`）----
       **同一次变异**把四个族各改坏一处 ⇒ 四条判据必须各自**红并逐处指名 `文件:行号`**。
       基线＝"把本轮待同步的引数先按真源就地改正"的**内存副本**（改正只作用于内存）：
       理由如实交代 —— 那几处属座位 2／主代理本轮 `E119`/`E120`/`E121` 与追加清单的同步范围，
       拿"当前（尚未同步）的正文"当基线，D22 会因**别人的在飞改动**而恒红，失去"可证伪"这一层意思。 */
    const sha16 = s => require('node:crypto').createHash('sha256').update(String(s)).digest('hex');
    const archFile16 = path.join(ROOT, ARCH_REL);
    const readmeFile16 = path.join(ROOT, 'tests', 'README.md');
    const archSha0 = sha16(fs.readFileSync(archFile16, 'utf8'));
    const readmeSha0 = sha16(fs.readFileSync(readmeFile16, 'utf8'));
    /** 把**每一处**被识别到的引数按真源就地改写（只作用于传入的字符串副本） */
    const repair16 = (srcs) => srcs.map(src => ({
      ...src,
      rows: src.rows.map(row => {
        let text = row.text;
        for (const key of src.fams) {
          const fam = FAM16[key];
          let out = ''; let last = 0; let m;
          fam.re.lastIndex = 0;
          while ((m = fam.re.exec(text)) !== null) {
            let rep = m[0];
            if (fam.kind === 'count') rep = rep.replace(/\d+/, String(fam.truth()));
            else if (fam.kind === 'script') {
              const exp = scriptTruth16(m[1]);
              if (exp !== undefined && exp !== null) rep = rep.replace(/(\d+)(\s*项)/, exp + '$2');
            } else if (Number(m[1]) === offlineCount16) rep = rep.replace(/(的和是\s*\*{0,2}\s*)\d+/, '$1' + sumTruth16);
            out += text.slice(last, m.index) + rep; last = m.index + m[0].length;
          }
          text = out + text.slice(last);
        }
        return { ...row, text };
      })
    }));
    /** 把**第一个**命中该族的引数的**最后一个数字** +1（＝"改错一处"的最小形态） */
    const bump16 = (srcs, key) => {
      const fam = FAM16[key];
      for (const src of srcs) {
        for (const row of src.rows) {
          fam.re.lastIndex = 0;
          const m = fam.re.exec(row.text);
          if (!m) continue;
          const bumped = m[0].replace(/(\d+)(?=[^\d]*$)/, x => String(Number(x) + 1));
          return { srcs: srcs.map(s => s === src ? { ...s, rows: s.rows.map(r => r === row ? { ...r, text: row.text.slice(0, m.index) + bumped + row.text.slice(m.index + m[0].length) } : r) } : s),
            where: `${src.file}:${row.no}`, from: m[0].replace(/\s+/g, ' ') };
        }
      }
      return null;
    };
    const base16 = repair16(SRC16);
    const A16base = audit16(base16);
    const mutants = ['comp', 'gates', 'scriptC', 'sum'].map(k => ({ k, m: bump16(base16, k) }))
      .map(x => ({ ...x, a: x.m ? audit16(x.m.srcs) : null }));
    const directed = mutants.every(x => x.m && x.a
      && x.a.findings.some(f => f.key === x.k && f.msg.startsWith(x.m.where)));
    t.check('E112 §16 D22 定点变异（**内存文本变异**，同一次变异改坏四个族各一处）：' +
      '①「N 个组件」改错、②「N 个（离线）门禁」改错、③一处「`<脚本>`（N 项）」改错、④「N 个的和是 M」改错 ⇒ ' +
      '四条判据必须各自**红并逐处指名 `文件:行号`**；按真源更正后的基线必绿；盘上两个文件逐字节未变',
      A16base.findings.length === 0 && A16base.lost.length === 0 && directed
        && sha16(fs.readFileSync(archFile16, 'utf8')) === archSha0
        && sha16(fs.readFileSync(readmeFile16, 'utf8')) === readmeSha0,
      `基线失配 ${A16base.findings.length} 处（锚点丢失 ${A16base.lost.length} 处）；` +
      mutants.map(x => x.m
        ? `${FAM16[x.k].id}：变异 ${x.m.where} 的「${x.m.from}」⇒ 命中该族且指名该行=${Boolean(x.a && x.a.findings.some(f => f.key === x.k && f.msg.startsWith(x.m.where)))}`
        : `${FAM16[x.k].id}：**锚点未命中，无法变异**`).join('；') +
      `｜盘上未变 arch=${sha16(fs.readFileSync(archFile16, 'utf8')) === archSha0}` +
      ` readme=${sha16(fs.readFileSync(readmeFile16, 'utf8')) === readmeSha0}`);
    if (badNum16.length || badSum16.length) {
      t.info('§16 的失配**逐处**照录（`E118`：失败明细一律留全）：\n      ' +
        [...badNum16, ...badSum16].map(f => f.msg).join('\n      '));
    }
  }


  t.finish();
}

/* 与既有脚本一致：异常以退出码 2 结束 */
try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
