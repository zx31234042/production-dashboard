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
   *  `timeout` 是兜底：曾实测到子进程卡住不返回，没有它上游工具超时会打断整条命令。 */
  const probe = (script) => {
    const log = path.join(env.ensureDir(env.paths.verify), `docs-cross-${script}-${process.pid}.log`);
    const fd = fs.openSync(log, 'w');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', script + '.js')],
      { cwd: ROOT, stdio: ['ignore', fd, fd], timeout: 120000 });
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
    let out = '';
    try { out = fs.readFileSync(log, 'utf8'); } catch { out = ''; }
    try { fs.rmSync(log, { force: true }); } catch { /* 忽略 */ }
    return { code: r.status, out, timedOut: r.error ? (r.error.code === 'ETIMEDOUT') : false };
  };

  /**
   * 单个脚本的实跑探针 + **最多两次重试**（第十一节用）。
   * 为什么要重试：本机上确有的一次拿不到汇总行的情形（同一台机器上还有别的门禁在并发跑，
   * 子进程可能被挤到超时或输出来不及落盘）。**一次拿不到就报红是假失败**，
   * 会让人去查根本不存在的漂移；故重试两次，三次都拿不到才判"未覆盖"（那时是真有问题）。
   * @param {string} script 脚本名（不含 .js）
   * @returns {{passed:number,attempts:number}|null}
   */
  const probeOne = (script) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = probe(script);
      const s = summaryOf(r.out);
      if (s) return { passed: s.passed, attempts: attempt };
    }
    return null;
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
  const fcRun = probe('files-check');
  const fcScanned = numeric.matchNumber(fcRun.out, /扫描\s*\*{0,2}(\d+)\*{0,2}\s*个文本文件/);
  const fcStated = numeric.matchNumber(readmeSrc, /扫描\s*\*\*(\d+)\*\*\s*个文本文件/);
  t.check('权威区"扫描 N 个文本文件"＝ files-check 实跑值',
    fcScanned !== null && fcStated === fcScanned, `README=${fcStated}，实跑=${fcScanned}`);

  const trRun = probe('trace-check');
  /* README 的写法是 `按类别：…、**ENV 4/20**`；trace-check 输出是 `ENV 6 / 20`。
     两处的加粗与空格都不同，故用容错正则（这两个坑都实际踩过）。 */
  const readmeEnv = (readmeSrc.match(/ENV\s*\*{0,2}\s*(\d+)\s*\/\s*(\d+)/) || []).slice(1).map(Number);
  const traceEnv = (trRun.out.match(/ENV\s*(\d+)\s*\/\s*(\d+)/) || []).slice(1).map(Number);
  t.check('权威区的 ENV 覆盖率分类＝ trace-check 实跑值',
    readmeEnv.length === 2 && traceEnv.length === 2 &&
    readmeEnv[0] === traceEnv[0] && readmeEnv[1] === traceEnv[1],
    `README=ENV ${readmeEnv.join('/')}，实跑=ENV ${traceEnv.join('/')}`);

  /* README 写法：`可追溯覆盖 162 条（63.0%）`；不写"162/257"那种形式，故按"条"取分子 */
  const readmeCov = [
    numeric.matchNumber(readmeSrc, /可追溯覆盖\s*(\d+)\s*条/),
    numeric.matchNumber(readmeSrc, /(\d+)\s*条\*\*需求条款/)
  ];
  const traceCov = (trRun.out.match(/可追溯覆盖[^\d]*(\d+)\s*\/\s*(\d+)/) || []).slice(1).map(Number);
  t.check('权威区的可追溯覆盖率＝ trace-check 实跑值（分子与条款总数都比）',
    readmeCov[0] !== null && readmeCov[1] !== null && traceCov.length === 2 &&
    readmeCov[0] === traceCov[0] && readmeCov[1] === traceCov[1],
    `README=${readmeCov.join(' / ')}，实跑=${traceCov.join(' / ')}`);

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
    mismatched.length ? mismatched.join('；') : `逐项一致（${pairs.map(([n, d]) => `${n}=${d}`).join('、')}）`);

  /* 离线可验证覆盖率与"依赖不可运行脚本"的条数也要比（P3-10 新增的口径） */
  const readmeOffline = numeric.matchNumber(readmeSrc, /离线可验证\s*(\d+)\s*条/);
  const traceOffline = numeric.matchNumber(trRun.out, /离线可验证覆盖\s*(\d+)\s*\//);
  const readmeOnlineOnly = numeric.matchNumber(readmeSrc, /其余\s*(\d+)\s*条依赖/);
  const traceOnlineOnly = numeric.matchNumber(trRun.out, /依赖需浏览器权限的脚本\s*(\d+)\s*条/);
  t.check('权威区的"离线可验证覆盖率"与"依赖浏览器脚本条数"＝ trace-check 实跑值',
    readmeOffline === traceOffline && readmeOnlineOnly === traceOnlineOnly,
    `离线 README=${readmeOffline}/实跑=${traceOffline}；依赖 README=${readmeOnlineOnly}/实跑=${traceOnlineOnly}`);

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

  /* ---- 解析：脚本名（两种形式之一）→ 声明通过数 ---- */
  const nameDecl = (name, textAndSource) => {
    const re = new RegExp('`' + name + '`\\s*\\*{0,2}\\s*(\\d+)\\s*/\\s*(\\d+)', 'g');
    for (const { text, from } of textAndSource) {
      const m = re.exec(text);
      if (m) return { name, declared: Number(m[1]), from };
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
  for (const s of totals.suites) {
    if (s && s.name && s.summary) ledger[s.name] = Number(s.summary.passed);
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
      if (re) { actualProbe[name] = re.passed; sourceOf[name] = 'probe'; }
      else probeFailures.push(`${name}（实跑未产出可解析的汇总行）`);
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
  const notDeclared = offlineGates.filter(n => !nameDeclarations.has(n));
  const mismatchedNamed = [];
  for (const [name, d] of nameDeclarations) {
    /* 自指脚本跳过；其余"拿不到任何实跑值"的由断言 6 报"未覆盖"，此处不猜也不硬比 */
    if (name === SELF_REF || actualOf(name) === undefined) continue;
    if (envSkipped.includes(name)) continue;   /* E55：无 git 时这两个脚本不参与按数比对 */
    if (d.declared !== actualOf(name)) {
      mismatchedNamed.push(`${name}：声明 ${d.declared} ≠ 实跑 ${actualOf(name)}` +
        (recheckNames.includes(name) ? '（账本值亦不符，已实跑复核确认）' : '（取自本轮账）'));
    }
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
    if (name === SELF_REF || actualOf(name) === undefined) continue;
    if (envSkipped.includes(name)) continue;   /* E55：无 git 时这两个脚本不参与按数比对 */
    if (d.declared !== actualOf(name)) {
      cpMismatch.push(`${name}（${d.form}）：声明 ${d.declared} ≠ 实跑 ${actualOf(name)}` +
        (recheckNames.includes(name) ? '（账本值亦不符，已实跑复核确认）' : '（取自本轮账）'));
    }
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
  t.check('每个有声明的离线门禁都拿到了实跑值（取不到即红，不静默放过）',
    (ledgerUsedAll + probedNames.length) > 0 && cannotVerify.length === 0 && probeFailures.length === 0,
    `取到实跑值 ${ledgerUsedAll + probedNames.length} 个` +
    `（账本 ${ledgerUsedAll} 个 ＋ 实跑复核 ${probedNames.length} 个：${probedNames.join('、') || '无'}）` +
    `，拿不到汇总行 ${probeFailures.length} 个` +
    (probeFailures.length ? `：${probeFailures.join('、')}` : '') +
    (cannotVerify.length ? `｜**未覆盖清单**（有声明却既不在账里、也没实跑出值）：${cannotVerify.join('、')}` : '') +
    `｜run-totals.json ${totals.ok ? '可读（快路径数据源）' : '不可用：' + totals.why}`);

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
    const snapSrc51 = read('项目记录/当前状态快照.md');
    const archSrc51 = read('项目架构与技术栈.md');
    const roadSrc51 = read('项目记录/后续路线图.md');
    const pickLine = (src, pred) => (src.split(/\r?\n/).find(pred) || null);
    const regions = [
      { name: '快照一屏速览行', txt: pickLine(snapSrc51, l => l.includes('全量 16 个') && l.includes('门禁')), must: true },
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


  t.finish();
}

/* 与既有脚本一致：异常以退出码 2 结束 */
try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
