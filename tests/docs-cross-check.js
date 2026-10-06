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
  const files = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
  /* ---- `E174`（★★，2026-10-05 主代理登记）：**"守规划项假现状"的判据已退化为恒真** ----
     立案：本节原来那两条（`server/ 的存在状态与架构文档描述一致`／`platform/ …`）以
     `项目架构与技术栈.md` 里的 `【后端，⬜ 待建】`／`【平台适配层，⬜ 待建】` 为锚；而该文档自
     `server\`／`platform\` 落地起**就不再写这两个标记** ⇒ `xxxDeclaredPending` 恒 `false`
     ⇒ 条件恒为 `!false === true` ⇒ **两条断言恒真、判别力为零**（`D23`：恒真断言＝没有断言）；
     第三条（本节 `PROJECT_RULES 把 server/platform 列入"后期再创建"`，`msg` 为空）同样恒真。
     ⇒ 改成**以规范 9.1「后期再创建」表为真源**的判据：**表 → 项集 → 每项的可判定路径 → 存在性 ⇔ 登记**。
     ⚠ **主代理给的两条路我选㈡「显式登记」**（依据＝盘上实测）：该表眼下**确有 4 项已在盘**
       （`server\services\`／`server\http\`／`server\index.js`／`platform\`），而它们**早已登记在
       9.1 目录树里** ⇒ 那是**规范表该行的措辞待一次放行**，不是"盘上偷偷多建"。若写成"表内每一项都必须
       不存在"，这 4 项会**恒红**；若只判未建项，就丢掉"新落地的东西必须登记"这一半 ⇒ 故把这 4 项
       **显式登记**（附放行待办）＋ **双向机制**（未登记即红／登记陈旧即红／划掉项必须在盘上不存在）。
     ⚠ **不许恒真也不许恒红**：`E174-③` 用**内存变异**证明这条判据可证伪（全程不碰盘）。 */
  /** 规范 9.1「后期再创建」表 → 项集（**纯函数**；主判据与 D22 共用同一把尺子） */
  const e174Parse = (rulesText) => {
    const at = rulesText.search(/^\*\*后期再创建（现在不需要）\*\*\s*$/m);
    if (at < 0) return { ok: false, why: '规范里找不到「**后期再创建（现在不需要）**」标题', items: [] };
    const items = [];
    for (const line0 of rulesText.slice(at).split(/\r?\n/)) {
      const line = line0.trim();
      if (!line.startsWith('|')) { if (items.length) break; continue; }
      if (/^\|\s*-{2,}/.test(line) || /^\|\s*文件\s*\|/.test(line)) continue;
      const first = (line.split('|')[1] || '').trim();
      if (!first) continue;
      for (const raw0 of first.split('、')) {
        const raw = raw0.trim();
        if (!raw) continue;
        items.push({ raw, struck: /^~~[\s\S]*~~$/.test(raw), name: raw.replace(/~~/g, '').replace(/`/g, '').trim() });
      }
    }
    return { ok: items.length > 0, why: items.length ? '' : '表里解析不到任何项（结构被改？）', items };
  };
  /** 项 → **可判定路径**（解释规则只此一份；`E174-①` 与规范表**双向**比对，多／少都红） */
  const E174_PATHS = [
    { name: 'package.json', rel: 'package.json', kind: 'file' },
    { name: 'server\\services\\', rel: 'server/services', kind: 'dir' },
    { name: 'transport\\', rel: 'server/transport', kind: 'dir' },
    { name: 'http\\', rel: 'server/http', kind: 'dir' },
    { name: 'index.js', rel: 'server/index.js', kind: 'file' },
    { name: 'server\\util\\', rel: 'server/util', kind: 'dir' },
    { name: 'platform\\', rel: 'platform', kind: 'dir' },
    { name: 'docs/', rel: 'docs', kind: 'dir' }
  ];
  /** **已在盘、而规范表仍列「后期再创建」**的显式登记（＝待一次规范放行；`E174` 立案句） */
  const E174_BUILT_REGISTRY = [
    { rel: 'server/services', why: '服务层实现时落地，**9.1 目录树已登记** ⇒ 本表该行措辞待放行' },
    { rel: 'server/http', why: '同上（`server\\http\\` 已落地并登记）' },
    { rel: 'server/index.js', why: '同上（`server\\index.js` 已落地并登记）' },
    { rel: 'platform', why: '平台适配层落地，**9.1 目录树已登记** ⇒ 本表该行措辞待放行' }
  ];
  /** 存在性读数（盘上现测；D22 用**内存变异**替换它，绝不写真盘） */
  const e174ExistsOf = (p) => {
    const abs = path.join(ROOT, p.rel);
    if (!fs.existsSync(abs)) return false;
    try { const st = fs.lstatSync(abs); return p.kind === 'dir' ? st.isDirectory() : st.isFile(); } catch { return false; }
  };
  /** **判据（纯函数；主断言与 D22 同一把尺子）**：`existsOf` 由调用方喂 ⇒ 变异只在内存里做 */
  const e174Audit = (parsed, paths, registry, existsOf) => {
    const names = parsed.items.map(i => i.name);
    const unknownInSpec = names.filter(n => !paths.some(p => p.name === n));
    const unknownInCode = paths.map(p => p.name).filter(n => !names.includes(n));
    const regSet = new Set(registry.map(r => r.rel));
    const builtUnregistered = [];
    const registryStale = [];
    const struckOnDisk = [];
    const rows = [];
    for (const p of paths) {
      const item = parsed.items.find(i => i.name === p.name);
      if (!item) continue;
      const ex = Boolean(existsOf(p));
      const registered = regSet.has(p.rel);
      rows.push({ name: p.name, rel: p.rel, kind: p.kind, struck: item.struck, exists: ex, registered });
      if (item.struck) { if (ex) struckOnDisk.push(p); continue; }
      if (ex && !registered) builtUnregistered.push(p);
      if (!ex && registered) registryStale.push({ rel: p.rel, kind: p.kind, orphan: false });
    }
    for (const r of registry) if (!paths.some(p => p.rel === r.rel)) registryStale.push({ rel: r.rel, kind: '?', orphan: true });
    return { unknownInSpec, unknownInCode, builtUnregistered, registryStale, struckOnDisk, rows };
  };
  const e174Parsed = e174Parse(rules);
  const e174Disk = e174Audit(e174Parsed, E174_PATHS, E174_BUILT_REGISTRY, e174ExistsOf);
  const e174RowTxt = (p) => `${p.name}→${p.rel}（${p.kind}${p.struck ? '，**已划掉＝不另建**' : ''}）`;
  t.check('E174-① **规范 9.1「后期再创建」表 ↔ 判据的"可判定路径"表双向对齐**（`E174` 的地面自证）：'
    + '规范表里解析出的**每一项**都必须在判据里有唯一一条可判定路径（多一项 ⇒ 判据未覆盖 ⇒ 红并指名）；'
    + '判据里的每一条路径也必须在规范表里有对应项（规范删了项而判据没删 ⇒ 红并指名）；'
    + '并逐项打出"项 → 路径 → 类型"',
    e174Parsed.ok && e174Disk.unknownInSpec.length === 0 && e174Disk.unknownInCode.length === 0
      && e174Parsed.items.length === E174_PATHS.length,
    !e174Parsed.ok
      ? `前提不成立：${e174Parsed.why}`
      : `规范表解析出 ${e174Parsed.items.length} 项（其中划掉的 ${e174Parsed.items.filter(i => i.struck).length} 项）；`
        + `判据路径 ${E174_PATHS.length} 条；**规范有而判据不认** ${e174Disk.unknownInSpec.length} 项`
        + `${e174Disk.unknownInSpec.length ? '：' + e174Disk.unknownInSpec.join('、') : ''}；`
        + `**判据有而规范无** ${e174Disk.unknownInCode.length} 项`
        + `${e174Disk.unknownInCode.length ? '：' + e174Disk.unknownInCode.join('、') : ''}；`
        + `逐项：${E174_PATHS.map(e174RowTxt).join('；')}`);
  t.check('E174-② **表内每一项的盘上存在性 ⇔ 登记**（`E174` 主判据）：**盘上已存在而未登记 ⇒ 逐项指名红**；'
    + '**登记了却盘上不存在 ⇒ 红并报"登记陈旧"**；**被划掉的项**（`~~…~~`＝不另建）必须在盘上**不存在**'
    + '（否则 `v1.38` 的裁定被违反）',
    e174Disk.builtUnregistered.length === 0 && e174Disk.registryStale.length === 0
      && e174Disk.struckOnDisk.length === 0,
    `盘上现测 ${e174Disk.rows.length} 项：`
      + e174Disk.rows.map(r => `${r.name}存在=${r.exists}／登记=${r.registered}`).join('、')
      + `；**盘上有而未登记** ${e174Disk.builtUnregistered.length} 项`
      + `${e174Disk.builtUnregistered.length ? '：' + e174Disk.builtUnregistered.map(p => p.rel).join('、') + '（⇒ 请登记到 E174_BUILT_REGISTRY 或把它从规范表移出）' : ''}；`
      + `**登记陈旧** ${e174Disk.registryStale.length} 项`
      + `${e174Disk.registryStale.length ? '：' + e174Disk.registryStale.map(r => r.rel).join('、') : ''}；`
      + `**划掉项却在盘上** ${e174Disk.struckOnDisk.length} 项`
      + `${e174Disk.struckOnDisk.length ? '：' + e174Disk.struckOnDisk.map(p => p.rel).join('、') : ''}；`
      + `**已登记待放行**（表仍列"待建"但 9.1 树已登记其落地）${E174_BUILT_REGISTRY.length} 项：`
      + E174_BUILT_REGISTRY.map(r => `${r.rel}（${r.why}）`).join('；'));
  t.check('架构文档存在于根目录', files.includes('项目架构与技术栈.md'));
  t.check('README 目录树登记了架构文档', readme.includes('项目架构与技术栈.md'));
  t.check('PROJECT_RULES 9.1 登记了架构文档', rules.includes('项目架构与技术栈.md'));
  t.check('PROJECT_RULES 9.6 登记了"架构现状说明"归档去向', /架构现状说明/.test(rules));
  /* `E174-③` D22（可证伪，**内存变异 ＋ 负对照**，全程不碰盘）：
     ①把**未建项** `transport\` 的存在性翻成 true ⇒ 同一 `e174Audit()` 必让它进 `builtUnregistered`
       并**指名 `server/transport`**（＝"盘上已存在而未登记"这一维真的在挡）；
     ②把 `platform` 从登记里摘掉（内存副本）⇒ 同一判据也必红并**指名 `platform`**
       （证明"登记"这一维不是装饰）；
     ③**负对照**＝盘上现测 ⇒ 三项全 0（绿）。 */
  {
    const t1 = e174Audit(e174Parsed, E174_PATHS, E174_BUILT_REGISTRY,
      (p) => (p.rel === 'server/transport' ? true : e174ExistsOf(p)));
    const regMinus = E174_BUILT_REGISTRY.filter(r => r.rel !== 'platform');
    const t2 = e174Audit(e174Parsed, E174_PATHS, regMinus, e174ExistsOf);
    const t3 = e174Disk;
    t.check('E174-③ D22（可证伪，**内存变异 ＋ 负对照**）：①内存把未建项 `transport\\` 翻成"存在" ⇒ 同一判据'
      + '**必红并指名 `server/transport`**；②内存把 `platform` 从登记里摘掉 ⇒ **必红并指名 `platform`**'
      + '（证明"登记"这一维在挡，不是装饰）；③**负对照**＝盘上现测 ⇒ 三项全 0（绿）',
      t1.builtUnregistered.length === 1 && t1.builtUnregistered[0].rel === 'server/transport'
        && t2.builtUnregistered.length === 1 && t2.builtUnregistered[0].rel === 'platform'
        && t3.builtUnregistered.length === 0 && t3.registryStale.length === 0 && t3.struckOnDisk.length === 0,
      `①把 server/transport 翻成存在 ⇒ builtUnregistered ${t1.builtUnregistered.length} 项（应 1，指名 `
        + `${t1.builtUnregistered.map(p => p.rel).join('、') || '（无）'}）；`
        + `②摘掉 platform 的登记 ⇒ builtUnregistered ${t2.builtUnregistered.length} 项（应 1，指名 `
        + `${t2.builtUnregistered.map(p => p.rel).join('、') || '（无）'}）；`
        + `③负对照（盘上现测）⇒ builtUnregistered ${t3.builtUnregistered.length}／registryStale ${t3.registryStale.length}／`
        + `struckOnDisk ${t3.struckOnDisk.length}（都应 0）；盘上文件全程只读（变异只在内存）`);
  }
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
   * `E189` 补（2026-10-05，座位 4b `T-20261005-35`）：剥注释之后**再剥字符串与模板串**
   * （只剥**字面量段**、保持列位、插值 `${…}` 内的真代码逐字保留）—— 逐条理由见下面两个助手函数
   * 的抬头注释。⚠ `stripComments` 的**函数名**与调用它的两个 ASCII 锚点行不许改：
   * `harness-check` §二十七 靠它们从本文件真源码字节里切段并编译（改了 ⇒ 抽取失败 ⇒ §二十七 判红）。
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
      out.push(blankStringsKeepPosE189(line));
    }
    return out;
  };

  /* ---------- `E189`（2026-10-05，座位 4b `T-20261005-35`）：剥字符串/模板串（**保持列位**） ----------
     立案（`项目记录\后续路线图.md` `E189`；由上一件 `T-20261005-31` 在收紧判据时**实测报出**）：
     本判据此前**只剥注释** ⇒ `const s = "new Date()"` 这类**字符串字面量**里的时钟形态会被判红
     （`D17` 主判据与 `EXT-A`／`EXT-B` **三面同病**，因为三者共用 `stripComments`）。**真树 0 命中**
     （故当前不发作），但这是一条**过报（假阳）边界**：说明性字面量（URL、示例串、错误模板、SQL 文本）
     一旦出现，就会把一条**正确**的行判红 —— 假红与假绿同价，都让门禁失去指向性。
     修法＝在**剥注释之后**把字符串/模板串的**字面量段**置空。三条硬约束（踩了当场出事）：
       ① **函数名与两个锚点行的字面不许改**：`harness-check` §二十七 靠**两个 ASCII 锚点行**
          （`stripComments` 的定义行 ＋ `clockHits` 的初始化行；逐字字面见该节常量
          `D17_A0`／`D17_A1`，此处**故意不复述** —— 复述会让锚点在真源码里命中两次、抽取当场失效）
          从本文件**真源码字节**里切连续区间再 `new Function` 编译（**同一把尺子**，`E153`）。
          故本段全部落在**两个锚点之间**（抽取区间内）—— 放到 `clockHits` 那一行之后，
          抽出的判据就会引用不到它（`new Function` 编译期 `ReferenceError`）。
       ② **必须保持字符位置**：字面量内容换成**等长空格**、不删字符。删字面量会让列索引左移 ⇒
          `injectableCall(line, m.index, m.index + m[0].length)` 看到的 `before`/`after` 错位 ⇒
          正常行被判成"有注入出口"（**假绿**）。
       ③ **模板串插值 `${…}` 里的真代码仍要判**（它是代码、不是字面量）⇒ 只**跳过**、**不置空**。
     顺序（为什么不先剥字符串再剥注释）：注释里常带撇号/引号（英文注释尤甚）；字符串先剥会把
     块注释里的**撇号**当成字符串起点，把**同一行的真代码**一并置空 ⇒ 那是**漏报**，比过报更危险。
     故沿用既有顺序：**先注释、后字符串**（本函数在每行剥完注释后调用下面的助手）。
     **能力边界（如实登记，不靠加正则掩盖）**：
       · 行内**未闭合**的引号 ⇒ 该行余下内容全部置空（非法 JS，代价可接受）；
       · **正则字面量**里的引号（`/['"]/`）会被当成字符串起点 ⇒ 该行余下内容置空（**漏报**方向），
         与"正则 vs 除号"歧义同源，属**文本启发式**的固有边界；
       · 字符串里出现 `//` 时仍会**先被注释剥掉**（既有顺序的固有边界）。
     上述三条边界与 `D17`／`EXT-A`／`EXT-B` 的既有边界同族：本判据**不是**数据流证明。 */
  const braceEndE189 = (line, openIdx) => {
    let depth = 0;
    for (let i = openIdx; i < line.length; i++) {
      const c = line[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  };
  const blankStringsKeepPosE189 = (line) => {
    const chars = line.split('');
    let i = 0;
    while (i < line.length) {
      const q = line[i];
      if (q !== '"' && q !== "'" && q !== '`') { i++; continue; }
      chars[i] = ' ';
      let j = i + 1;
      while (j < line.length) {
        const c = line[j];
        if (c === '\\') { chars[j] = ' '; if (j + 1 < line.length) chars[j + 1] = ' '; j += 2; continue; }
        if (c === q) { chars[j] = ' '; j++; break; }
        const isInterpE189 = q === '`' && c === '$' && line[j + 1] === '{';
        if (isInterpE189) {
          const end = braceEndE189(line, j + 1);
          if (end < 0) { for (let k = j; k < line.length; k++) chars[k] = ' '; j = line.length; break; }
          j = end + 1;
          continue;                       /* E189-INTERP-KEEP：插值内是真代码 ⇒ 只跳段、不置空 */
        }
        chars[j] = ' ';
        j++;
      }
      i = j;
    }
    return chars.join('');
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
   *      **`E141`（2026-10-04，本座位 `T-20261004-16` 甲）**：这条修法原先**只做了一半** —— 第十一节
   *      （`declaredMismatchE135()` 有 `probeFailed` 前置）说得对，但**第十六节**的真源仍走
   *      `actualOf()` ⇒ 同一次超时里 §11 说"不是漂移"、§16 却打印"正文写 407 ≠ 真源 406"
   *      （`C·22` 靶子②实测）。§16 现已接上同一前提（`truthReason16()`）⇒ 两节**同口径**。
   *  ⇒ 两条修法：①**按脚本给余量**（下表：默认 300 s＝旧值 2.5×；最重的 `harness-check` 360 s
   *  ＝对它 84.1 s 的 **4.28×** 余量）；②把"**探针超时**"
   *  （＝**前提不成立**：判据没能在预算内跑完被测脚本）与"**取不到汇总行**"（＝被测脚本真的没产出）
   *  分开分类、分开计数、分开报（`classifyProbeE135()`／`probeShortfallNoteE135()` 是纯函数，
   *  D22 复用同一份 ⇒ "变异后变红"能证伪这条断言）。
   *
   *  **最坏墙钟的真实算法（`E143`，2026-10-04，本座位 `T-20261004-16` 丙）** —— 旧抬头写的
   *  "最坏 360 s ＝旧实现 3×120 s ＝**持平**"**不成立**，实测/读码更正如下：
   *    · **`nosummary` 重试 3 次、`timeout` 不重试**（`probeOne()` 的 `maxAttempts(kind)`）⇒
   *      **单脚本混合路径最坏 ＝ 首次 `nosummary` 已经跑满 360 s（子进程"正常退出但没汇总行"也可能跑满）
   *      ＋ 第 2、3 次各超时 360 s ＝ 3×360 s ＝ 1080 s（18 min）**；纯超时路径＝1×360 s；
   *      纯 `nosummary` 路径＝3×360 s（若每次都跑满）。
   *    · **多脚本**：`probeWallMs` 会遍历 `offlineGates`，凡"声明 ≠ 账"的脚本各跑一次 `probeOne()`
   *      ⇒ 最坏墙钟**随冲突脚本个数线性增长**（N 个 ⇒ 最坏 N×1080 s）。
   *    · 旧实现（无条件实跑、12 个脚本串行、每个 120 s 兜底）的最坏是 12×120 s ＝ 1440 s，
   *      但**逐脚本**看它是 120 s；本改造把单脚本上界抬到 1080 s ⇒ "持平"只在
   *      "恰好一个脚本、且第一次就超时"这一种形态下成立。
   *    · **为什么仍然接受这个上界**：正常预算下（`harness-check` 84.1 s / 360 s）路径根本走不到
   *      重试与超时；这两条只在"机器极忙"或"受控 1 ms 变异"下出现，且此时**判据仍然红**（不静默）。
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
  const probeOne = (script, overrideMs) => retryProbePolicyE143(() => probeOneOnceE143(script, overrideMs));
  /**
   * **重试策略（`E143` 的单一真源，纯函数）**：`nosummary` 重试到 3 次、`timeout` **不重试**。
   * 抽成纯函数有两个目的：① `probeOne()` 与"最坏墙钟的算术"用**同一份**策略（不会各写一份而漂移）；
   * ② 可以喂**合成的 attempt 序列**（`nosummary` → `timeout` → `timeout`）⇒ "混合路径最坏 3×预算"
   *    这件事**可被定点证伪**，而不是只在注释里写一句上界。
   * @param {(attempt:number)=>({kind:'ok'|'timeout'|'nosummary', passed?:number, timeoutMs:number})} attemptOnce
   * @returns {{kind:string, attempts:number}} 最终一次的分类与**实际跑了几次**
   */
  const retryProbePolicyE143 = (attemptOnce) => {
    const maxAttempts = (kind) => (kind === 'timeout' ? 1 : 3);   /* 超时不重试，理由见抬头 */
    let last = { kind: 'nosummary', attempts: 0 };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const c = attemptOnce(attempt);
      last = { ...c, attempts: attempt };
      if (c.kind === 'ok') return last;
      if (attempt >= maxAttempts(c.kind)) return last;
    }
    return last;
  };
  /** 单次探针（`probeOne` 的一次尝试；拆出来只为把重试策略抽成纯函数） */
  const probeOneOnceE143 = (script, overrideMs) => {
    const r = probe(script, overrideMs);
    const c = classifyProbeE135(r);
    return { ...c, timeoutMs: r.timeoutMs };
  };
  /** `E143`（2026-10-04，本座位 `T-20261004-16` 丙）：**让墙钟读数自解释** ——
   *  单看"实跑探针墙钟 1080 ms"分不清"多个脚本各重试了一次 nosummary"与"某个脚本超时"。
   *  这里把每个实跑过的脚本的 `attempts` 与最终 `kind` 一并打进同一行输出。
   *  @param {Array<{name:string, kind:string, attempts:number}>} records 实跑记录（**逐次**）
   *  @returns {string} 形如 `harness-check=timeout(1 次)、logic-check=ok(2 次)` */
  const fmtProbeDetailE143 = (records) => (records.length
    ? records.map(r => `${r.name}=${r.kind}(${r.attempts} 次)`).join('、')
    : '无');
  /* `E143` 的 D22（**合成 attempt 序列**，不依赖任何真实脚本的耗时）：
     ① 混合路径 `nosummary → timeout` ⇒ 跑 **2** 次、最终 `timeout`（第 2 次就停：超时不重试）；
     ② `nosummary → timeout → timeout` 的**上界**：若第 1 次 `nosummary`、第 2 次才超时，最多 2 次；
        真正的最坏 3 次由"第 1、2 次都 `nosummary`、第 3 次超时"给出 ⇒ 断言它停在 3 次；
     ③ `ok` 第 1 次就返回（1 次）；④ 纯 `timeout` 只 1 次；⑤ 纯 `nosummary` 满 3 次。
     这四条合起来把"最坏墙钟 ＝ 3×预算／脚本"钉成**可证伪**的读数。 */
  {
    const seq = (kinds) => { let i = 0; return () => ({ kind: kinds[Math.min(i++, kinds.length - 1)], timeoutMs: 360000 }); };
    const mixed1 = retryProbePolicyE143(seq(['nosummary', 'timeout', 'timeout']));
    const mixed2 = retryProbePolicyE143(seq(['nosummary', 'nosummary', 'timeout']));
    const pureTimeout = retryProbePolicyE143(seq(['timeout']));
    const pureNoSummary = retryProbePolicyE143(seq(['nosummary']));
    const okFirst = retryProbePolicyE143(seq(['ok']));
    t.check('E143 D22（可证伪）：重试策略（**纯函数**，`probeOne()` 与"最坏墙钟算术"共用同一份）—— ' +
      '`nosummary` 最多 3 次、`timeout` **不重试** ⇒ 单脚本**混合路径最坏跑 3 次**（＝最坏墙钟 3×预算，' +
      '而不是旧注释写的"1×预算、与旧实现持平"）；`ok` 第 1 次即返回',
      mixed1.kind === 'timeout' && mixed1.attempts === 2
        && mixed2.kind === 'timeout' && mixed2.attempts === 3
        && pureTimeout.kind === 'timeout' && pureTimeout.attempts === 1
        && pureNoSummary.kind === 'nosummary' && pureNoSummary.attempts === 3
        && okFirst.kind === 'ok' && okFirst.attempts === 1,
      `混合（nosummary→timeout）：${mixed1.kind}／${mixed1.attempts} 次；`
        + `最坏混合（nosummary→nosummary→timeout）：${mixed2.kind}／${mixed2.attempts} 次（**上界**）；`
        + `纯 timeout：${pureTimeout.attempts} 次；纯 nosummary：${pureNoSummary.attempts} 次；ok 首跑：${okFirst.attempts} 次；`
        + `⇒ 单脚本最坏墙钟 ＝ 3×预算（\`harness-check\` 360 s ⇒ **1080 s**），`
        + `多脚本冲突复核**线性叠加**（N 个 ⇒ N×1080 s）—— 见抬头注释的更正`);
  }

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
   * @returns {{ok:boolean, why:string, error:?(Error|null), suites:Array, ranSuites:string[], file:string}}
   */
  const readRunTotals = (mode) => {
    const file = path.join(env.paths.verify, 'run-totals.json');
    const prefix = mode === 'hard' ? '**不可读**：' : '';
    try {
      if (!fs.existsSync(file)) return { ok: false, why: prefix + '不存在（本轮不是经 run-all 启动，账本还没生成过）', error: null, suites: [], ranSuites: [], file };
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(json.suites)) return { ok: false, why: prefix + '结构不对（缺 suites 数组）', error: null, suites: [], ranSuites: [], file };
      /* `E142`（2026-10-04）：另带出 `ranSuites`（`run-all.writeRunTotals()` 落盘时写的**本轮真跑过的脚本名**）。
         它是"**本轮没轮到它跑**"与"**上一轮有、这一轮账里没了**"唯一的分辨依据 —— 详见断言 10 的抬头。 */
      return { ok: true, why: '', error: null, suites: json.suites, ranSuites: Array.isArray(json.ranSuites) ? json.ranSuites : [], file };
    } catch (err) {
      return { ok: false, why: prefix + '读取失败：' + (err && err.message), error: err || null, suites: [], ranSuites: [], file };
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
  const probeRecordsE143 = [];  // `E143`：逐脚本的实跑记录 `{name, kind, attempts}`（墙钟读数自解释用）
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
      /* `E143`：把"谁、跑了几次、最后是哪一类"逐条留痕（墙钟读数靠它自解释） */
      probeRecordsE143.push({ name, kind: re && re.kind ? re.kind : 'nosummary', attempts: re && re.attempts ? re.attempts : 0 });
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
    `｜账本 ${totals.ok ? '可读' : '不可读：' + totals.why}｜实跑探针墙钟 ${probeWallMs} ms` +
    `｜` + '`E143` 逐脚本探针读数（`kind(attempts)` ⇒ 墙钟自解释）：' + fmtProbeDetailE143(probeRecordsE143));
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
  /** 判据本体（**纯函数**：D22 复用它 ⇒ "变异后变红"能证伪这条断言）。
   *  `E142`（2026-10-04，本座位 `T-20261004-16` 乙）：**加第三参 `ranRound`** —— 账本自述的"上一轮真跑过的脚本"
   *  （`run-all.writeRunTotals()` 落的 `ranSuites`）＋ 可选的"本轮真跑过的脚本"。
   *
   *  **为什么必须把两种"缺"分开**（本件要求写进注释并在回执复述）：
   *    · **"本轮没轮到它跑"**（正常形态）：`browser-check`／`overlap-check`／`stress-check` 在
   *      `run-all.__serialTail` 里排在 `docs-cross-check` **之后** ⇒ 本轮账本**天然不含**它们；
   *      而且 `--only` 子集轮**根本不跑**它们 ⇒ 那时账本里"没有这几条"是**预期**。
   *      `D20` 的边界正是为它立的：**不可比、点名、不判 FAIL**。
   *    · **"上一轮有、这一轮没了"**（异常）：⚠ **`E155`（2026-10-04，据 `C·23` 第 2 组）更正了本段上一版的措辞** ——
   *      上一版写"账本是**增量落盘、不清空**的"，据此推出"`ranSuites` 记着上一轮真跑过、账里也真有过"。
   *      **与实现不符**：`run-all.js:1275` 起手 `const results = []`，`:604`／`:608` 每轮把 `ranSuites`／`suites`
   *      **重写成本轮结果**（主代理亲验：两处都是 `results.map(...)`）⇒ 正确的口径是
   *      "**轮内增量写、轮间重置**"。⇒ 下面这条"消失"判据**只在"单跑本脚本、读到上一轮完整账本"那条路径上活着**；
   *      在 `run-all` 轮里（浏览器/长跑脚本排在 `docs-cross-check` 之后）它们**本来就不在账**里。
   *      这正是 `E142` 的守护窗口：**跑过一次 `--fast`**（把这三条条目合法清掉）之后，
   *      `browser-check 33`／`overlap-check 27`／`stress-check 11` 这三个**已登记的权威数字**
   *      **在门禁里没有任何逐脚本判据**（本节只报"本轮不可比 3 个"、不判红）。
   *      ⇒ **`E155` 的补法**：给这三条一个**不随轮次重置的持久真源**（`._verify\browser-authority-trail.json`，
   *      见下面 `trailDriftE155()`）：账本里有它 ⇒ 照旧逐值比对**并把读数写进留痕**；
   *      账本里没有它（`--fast` 轮／子集轮／`run-all` 轮的中途）⇒ 退回留痕比"**上一次全量轮的真读数** vs
   *      **现在的权威区声明**" ⇒ **不一致即判红并指名**（这正是 `--fast` 之后无人守的那件事）；
   *      连留痕都没有 ⇒ **显式报"不可比：无持久留痕"**（**不判红、但绝不静默**）。
   *      ⚠ 为什么不改 `run-all.js` 让它别覆盖这三条（候选方案之一）：那要动 `run-all.js`（本件权限外，
   *      且会把"账本＝本轮结果"这个已被多处依赖的口径改掉）；留痕方案的代价只是**一个新文件 ＋ 一次写盘**。
   *    · **"上一轮有、这一轮没了"**（异常，单跑本脚本时的判据）：这一轮它不见了，只可能是**条目被删/被改写**
   *      （座位 5 实测：只删 `browser-check` 一条 ⇒ 失配 0、`已核对 2／不可比 1`、主断言**仍 PASS**，
   *      这正是 `E142` 立案时的那次读数）。
   *      这一条**必须判红并指名是哪只脚本消失了** —— 否则一个已登记的权威数字（33／27／11）
   *      可以"没人守"，而报告上完全看不出来。
   *    ⇒ 判据：`planned = (ranRound 若有 ⇒ 本轮实跑集合) 否则 (账本自述的 ranSuites)`；
   *      凡 `planned` 里有、而**本轮账本条目缺失**的浏览器/长跑脚本 ⇒ **finding（判红、指名）**；
   *      `planned` 里**没有**的 ⇒ 照旧走 `D20` 的 `unmet`（不可比、不判红）。
   *      两个方向都读 ⇒ "删条目绕过"被堵死（`C·22` 靶子③的②④两种形态）。
   *  @param {(nm:string)=>({declared:number}|null)} declOf 声明访问器
   *  @param {(nm:string)=>({passed:number}|undefined)} sumOfName 账本访问器
   *  @param {{ranLedger?:string[], ranRound?:string[]}} [ran] 上一轮/本轮"真跑过"的脚本名
   */
  const browserLedgerAuditE136 = (declOf, sumOfName, ran) => {
    const findings = [];
    const covered = [];
    const unmet = [];
    const disappeared = [];      /* `E142`：**上一轮跑过、这一轮账里消失**的脚本名（第三只桶） */
    const ranLedger = (ran && Array.isArray(ran.ranLedger)) ? ran.ranLedger : [];
    const ranRound = (ran && Array.isArray(ran.ranRound)) ? ran.ranRound : [];
    /* "本轮该在账里"的集合：优先用**本轮实跑集合**（最准）；拿不到就退回账本自述的上一轮集合。 */
    const planned = ranRound.length ? ranRound : ranLedger;
    const plannedSrc = ranRound.length ? '本轮实跑集合（ranSuites）' : '账本自述的上一轮实跑集合';
    for (const nm of browserGatesE136) {
      const d = declOf(nm);
      if (!d) { findings.push(`${nm}：权威区里解析不出 \`通过/失败\` 声明`); continue; }
      const sum = sumOfName(nm);
      if (!sum) {
        /* `E142` 的单向标记：**该跑/上一轮跑过、而这一轮账里没有** ⇒ 异常（判红并指名）。
           `D20` 的 `unmet` 只留给"确实没轮到它跑"（`planned` 里没有它）。 */
        if (planned.includes(nm)) {
          disappeared.push(nm);
          findings.push(`${nm}：**上一轮账里有、这一轮账里消失了**（${plannedSrc} 含它，`
            + `而本轮账本不含 ⇒ 条目被删/被改写 ⇒ 一个已登记的权威数字**没人守**；`
            + `这不是"本轮没轮到它跑"，不许按 \`D20\` 当不可比放过）`);
          continue;
        }
        unmet.push(`${nm}（本轮账本无该脚本条目）`);
        continue;
      }
      covered.push(nm);
      if (d.declared !== sum.passed) {
        findings.push(`${nm}：权威区写 **${d.declared} 通过** ≠ 账本 ${sum.passed}（**通过数逐脚本漂移**；` +
          `该数只来自全量轮，故它就是真漂移 —— 重跑一次全量轮刷新账本，不要改判据）`);
      }
    }
    return { findings, covered, unmet, disappeared, planned, plannedSrc };
  };
  {
    /* `E142`：把"上一轮真跑过"（`totals.ranSuites`，账本自述）与"本轮真跑过"（同一份账本的 ranSuites ——
       本轮若经 `run-all` 启动，这个字段就是**本轮**写的）都喂给判据，用来分辨两种"缺"。 */
    const ranInfoE136 = { ranLedger: totals.ranSuites, ranRound: totals.ranSuites };
    const brAudit = browserLedgerAuditE136(browserDeclOfE136, nm => ledgerSummary[nm], ranInfoE136);
    /* ==================== `E155`（2026-10-04）：三只浏览器/长跑脚本的**持久留痕** ====================
       立案（`C·23` 第 2 组报出、主代理亲验）：`run-all.js:1275` 起手 `const results = []`、`:604`／`:608`
       每轮把 `ranSuites`／`suites` **重写成本轮结果**（正确口径＝"**轮内增量写、轮间重置**"）⇒ 跑过一次
       `--fast` 之后，这三条的条目被**合法清掉**，而它们的权威数字（33／27／11）在本节**只剩"本轮不可比"**、
       **没有任何逐脚本判据** ⇒ 声明漂移可以悄悄溜过去（本节**只报不可比、不判红**）。
       **候选方案与代价（`E155` 要求"先给方案（两个以上候选 ＋ 代价）再动手"）**：
        ㈠ **持久留痕文件**（**本件采用**）：`tests\._verify\browser-authority-trail.json` —— 每当**账本里有**
           这条时，把 `passed/failed/skipped ＋ 当时的声明 ＋ 账本 sha12 ＋ 时间` 写进去；账本里**没有**时，
           拿留痕的 `passed` 与**现在的声明**比 ⇒ 不一致即**判红并指名**。
           代价：本节多一次写盘（落在被 gitignore 的 scratch 面）＋ 多一个文件；**不动** `run-all.js`。
        ㈡ 让 `--fast` **不覆盖**带浏览器脚本的条目：须改 `run-all.js:604`／`:608`（**本件权限外，需先回执申请**），
           且会改掉"账本＝本轮结果"这个已被 `E50`／`E112`／`E136` 多处依赖的口径。
        ㈢ 只靠 `run-all` 收尾按全量 SUITES 判（现状）：**单跑本节**这条路径仍然无人守 ⇒ 不解决本次立案的形态。
       ⇒ 采用 ㈠（最小、可复算、不越权）。⚠ 留痕**不是**"第二个账本"：它只记**上一次全量轮的通过数**，
         用来回答"**声明有没有漂**"；"这一次真的跑出多少"永远以**实跑/账本**为准。 */
    const TRAIL_E155 = path.join(env.paths.verify, 'browser-authority-trail.json');
    const readTrailE155 = () => {
      try {
        if (!fs.existsSync(TRAIL_E155)) return { ok: false, why: '留痕文件不存在（本节第一次跑／刚被清理）', entries: {} };
        const j = JSON.parse(fs.readFileSync(TRAIL_E155, 'utf8'));
        return { ok: true, why: '', entries: (j && j.entries) || {}, at: j && j.at };
      } catch (e) { return { ok: false, why: `留痕读不出：${e.message}`, entries: {} }; }
    };
    /** 判据本体（**纯函数**：D22 复用 ⇒ "留痕比声明"这件事能被合成输入证伪）。
     *  @returns {{findings:string[], viaTrail:string[], noTrail:string[], guardedByLedger:string[]}} */
    const trailDriftE155 = (declOf, gates, sumOfName, trail, writeRes) => {
      const findings = []; const viaTrail = []; const noTrail = []; const guardedByLedger = [];
      /* `E162`（2026-10-05）：**独立的不可比桶** —— 写票不是"显式成功"时，手里那份留痕可能是陈旧的，
         "留痕比声明"这条路径**不再可比** ⇒ 记这里、**不报失配**（报失配 ＝ 把正确声明误诊成"声明漂移"）。 */
      const incomparable = [];
      const writeGuardE155 = trailWriteGuardE162(writeRes, gates);
      const writeBlockedE155 = writeGuardE155.blocked;   /* `E162`：写票不是"显式成功" ⇒ 只影响"比声明"这一类 */
      for (const nm of gates) {
        const d = declOf(nm);
        if (!d) { findings.push(`${nm}：权威区里解析不出 \`通过/失败\` 声明`); continue; }
        if (sumOfName(nm)) { guardedByLedger.push(nm); continue; }        /* 账本里有 ⇒ 由 `E136` 逐值守 */
        /* `E162`：写票不是"显式成功" ⇒ 手里这份留痕**可能是陈旧的**（正是它读出来与声明不符的那一刻）
           ⇒ 记"不可比"、**不报失配**（报失配 ＝ 把正确声明误诊成"声明漂移"）。 */
        if (writeBlockedE155) { incomparable.push(nm); continue; }
        const rec = trail.entries[nm];
        if (!rec || !Number.isFinite(rec.passed)) { noTrail.push(nm); continue; }
        if (d.declared !== rec.passed) {
          findings.push(`${nm}：**本轮账本不含它**（按 \`D20\` 不可比），而**持久留痕**记着上一次全量轮它是 `
            + `**${rec.passed} 通过**（${rec.at || '时间未记'}、账本 sha12=${rec.ledgerSha12 || '-'}），`
            + `权威区现在写 **${d.declared} 通过** ⇒ **声明漂移，而别的判据不会报它**（\`E155\` 立案的正是这一形态）`);
        } else viaTrail.push(nm);
      }
      return { findings, viaTrail, noTrail, guardedByLedger, incomparable };
    };
    /* ==================== `E162`（2026-10-05 登记）：留痕写入的 **fail-open** ====================
       立案（`项目记录\后续路线图.md` 的 `E162` 行；座位 5 在 `C·24` 第 4 组报出）：原来的
       `trailWriteE155` **只在定义处与一条 `t.info` 出现，不进任何 `t.check`** ⇒
       **写失败只印一行 info、当轮照绿**。危害**不是"少写一个文件"**，而是**症状指向错方向**：
       留痕悄悄陈旧 ⇒ 下一次"账本不含它"的轮（`--fast`／子集轮／`run-all` 中途）里，
       `trailDriftE155()` 会拿**陈旧的留痕**去比**现在（正确）的声明** ⇒ 把**正确声明**误诊成
       "**声明漂移**"（`E110`／`E135`／`E152` 同族：报出来的名字指向**另一个**问题）。
       修法（两选一，本件**两条都做**，与 `E116`"工具自报成功但无产物 ⇒ FAIL"同一条纪律）：
         ① **写失败进判据**（`E162-①`）：`trailWriteE155.ok === false` ⇒ **当轮判红**并**指名留痕文件**；
         ② **显式"不可比"**（本段的 `incomparable` 桶）：写失败时"留痕比声明"这条路径不再可比 ⇒
            那些项**逐条点名**记"不可比"，而不是报失配（既不装绿、也不把正确声明误诊成漂移）。
       ⚠ **fail-closed**：**不给票**（旧调用点／忘了接线）也记不可比 ——"没有证据"不许当成"写成功了"。
       ⚠ **注入时仍然照写**（只改返回值）：写失败只意味着"这一次没写成功"，下一次仍要试；
         若因为"上一轮注入过失败"就停写，会把注入变成"永久静默"，那比 fail-open 更坏。 */
    const trailWriteFailInjectedE162 = process.env.DSH_E162_TRAIL_WRITE_FAIL === '1';
    /** **写票守卫**（**纯函数**：`E162-②` 的 D22 复用它）：写票不是"显式成功" ⇒ **不可比**。
     *  @returns {{blocked:boolean, why:string, blockedSubjects:string[]}} */
    const trailWriteGuardE162 = (writeRes, gates) => {
      if (writeRes && writeRes.ok === true) return { blocked: false, why: '', blockedSubjects: [] };
      return {
        blocked: true,
        why: '**留痕写入失败** ⇒ 本轮"留痕与声明对账"这条路径**不可比**（陈旧的留痕会把**正确声明**误诊成'
          + '"声明漂移"，`E110`／`E135`／`E152` 同族「症状指向错方向」）—— 写失败本身由 `E162-①` 判红并指名，'
          + '**不许**按失配报',
        blockedSubjects: (gates || []).slice()
      };
    };
    const trailBeforeE155 = readTrailE155();
    /** 留痕的**唯一写入点**：账本里有这条 ⇒ 记下"这一次全量轮的真读数"；写失败**显式报出来**（不静默）。 */
    const trailWriteE155 = (() => {
      const ledgerShaE155 = totals.ok ? require('node:crypto').createHash('sha256')
        .update(fs.readFileSync(totals.file)).digest('hex').slice(0, 12) : null;
      const entries = Object.assign({}, trailBeforeE155.entries);
      let written = 0;
      for (const nm of browserGatesE136) {
        const s = ledgerSummary[nm]; const d = browserDeclOfE136(nm);
        if (!s || !d) continue;
        entries[nm] = { passed: s.passed, failed: s.failed, skipped: s.skipped, declared: d.declared,
          ledgerSha12: ledgerShaE155, at: new Date().toISOString().slice(0, 19) + 'Z' };
        written++;
      }
      if (trailWriteFailInjectedE162) {
        /* `E162` 的**受控注入点**：只把本次写入的**返回值**改成失败，**不碰盘、不抛错** ⇒
           "写失败必进判据"这条能被证伪；生产路径不设这个环境变量 ⇒ 行为逐字不变。 */
        return { ok: false, written: 0, why: '`E162` D22 **受控注入**（`DSH_E162_TRAIL_WRITE_FAIL=1`）：'
          + '把这一次写入的结果改成失败（**不碰盘**）—— 用来证伪"写失败必进判据"这一条' };
      }
      if (!written) return { ok: true, written: 0, why: '账本里没有这三条 ⇒ 本轮**不写**（留痕保持原样，供下次不可比时用）' };
      try {
        fs.writeFileSync(TRAIL_E155, JSON.stringify({
          note: 'E155 持久留痕：三只浏览器/长跑脚本"上一次全量轮"的通过数（判据与写入点都在 tests/docs-cross-check.js 的 §11 E136/E155/E162 段；'
            + '写入失败由 `E162-①` 判红并指名 ⇒ 这一处**不再是静默的 fail-open**）',
          at: new Date().toISOString().slice(0, 19) + 'Z',
          ledger: path.relative(env.paths.root, totals.file),
          entries
        }, null, 2) + '\n');
        return { ok: true, written, why: '' };
      } catch (e) { return { ok: false, written: 0, why: `留痕**写失败**：${e.message}` }; }
    })();
    /* `E162`：审计调用**移到写入点之后**（原顺序里它在写入点之前 ⇒ 块级 `const` TDZ）——
       只动位置、不动字节：原样四行 ＋"写票"这一参。 */
    const trailAuditE155 = trailDriftE155(browserDeclOfE136, browserGatesE136, nm => ledgerSummary[nm],
      trailBeforeE155, trailWriteE155);
    t.check('E136 三只**浏览器/长跑**脚本的**通过数**逐脚本对账（**只读账本**，不实跑）：权威区声明的通过数 = ' +
      '`run-totals.json` 里该脚本的 `passed`；**账本覆盖不到 ⇒ 按 `D20` 报"本轮不可比"并点名**' +
      '（不判 FAIL、也不计入已核对）；`已核对 ＋ 不可比 ＋ **上轮有这轮没了** === 应有值`（**一只都不许消失**）；' +
      '**`E142`：账本自述"上一轮跑过"而本轮条目消失 ⇒ 判红并指名**（"本轮没轮到"与"上轮有这轮没了"必须分得开）；' +
      '**`E155`：账本不含它时退回持久留痕 —— 留痕的通过数 ≠ 现在的权威区声明 ⇒ 判红并指名**（`--fast` 之后无人守的那件事）',
      browserGatesE136.length > 0 && brAudit.findings.length === 0 && trailAuditE155.findings.length === 0
        && brAudit.covered.length + brAudit.unmet.length + brAudit.disappeared.length === browserGatesE136.length
        /* `E162-①`：**留痕写入结果当第 5 票**接进主判据 —— 写失败 ⇒ 当轮判红（写进判据才算收口）。 */
        && trailWriteE155.ok === true,
      (trailWriteE155.ok ? ''
        : `**留痕写失败（\`E162-①\` 判红并指名）**：文件＝${path.relative(env.paths.root, TRAIL_E155)}`
          + `｜原因＝${trailWriteE155.why}｜本轮"留痕与声明对账"**不可比 ${trailAuditE155.incomparable.length} 项**`
          + `（${trailAuditE155.incomparable.join('、') || '（无）'}）｜`) +
        (brAudit.findings.length ? `**失配 ${brAudit.findings.length} 条**：${brAudit.findings.join('；')}`
        : `逐脚本一致（${brAudit.covered.map(n => `${n}=${ledgerSummary[n].passed}/${ledgerSummary[n].failed}/${ledgerSummary[n].skipped}`).join('、') || '（无可比项）'}）`) +
      (trailAuditE155.findings.length ? `｜**\`E155\` 留痕失配 ${trailAuditE155.findings.length} 条**：${trailAuditE155.findings.join('；')}` : '') +
      `｜**已核对 ${brAudit.covered.length}／${browserGatesE136.length} 个**` +
      `｜**本轮不可比 ${brAudit.unmet.length} 个**：${brAudit.unmet.join('、') || '（无）'}` +
      `｜**\`E162\` 写失败⇒不可比 ${trailAuditE155.incomparable.length} 个**：${trailAuditE155.incomparable.join('、') || '（无）'}` +
      `｜**\`E155\` 由留痕守住 ${trailAuditE155.viaTrail.length} 个**：${trailAuditE155.viaTrail.join('、') || '（无）'}` +
      `｜**\`E155\` 无留痕（显式不可比，不判红）${trailAuditE155.noTrail.length} 个**：${trailAuditE155.noTrail.join('、') || '（无）'}` +
      `｜**\`E142\` 上轮有这轮没了 ${brAudit.disappeared.length} 个**：${brAudit.disappeared.join('、') || '（无）'}` +
      `｜\`E142\` 计划集合来源＝${brAudit.plannedSrc}（${brAudit.planned.length} 个）` +
      `｜声明：${browserGatesE136.map(n => { const d = browserDeclOfE136(n); return `${n}=${d ? d.declared : '（解析不到）'}`; }).join('、')}` +
      `｜账本 ${totals.ok ? `可读（${path.relative(env.paths.root, totals.file)}）` : '不可用：' + totals.why}`);
    t.info(`\`E155\` 持久留痕：文件＝${path.relative(env.paths.root, TRAIL_E155)}`
      + `（${trailBeforeE155.ok ? `可读，条目 ${Object.keys(trailBeforeE155.entries).length} 条` : `**不可读**：${trailBeforeE155.why}`}）；`
      + `本轮写入＝${trailWriteE155.written} 条${trailWriteE155.why ? `（${trailWriteE155.why}）` : ''}${trailWriteE155.ok ? '' : ' ⚠ **写失败**'}` +
      `｜判据分工：账本有 ⇒ \`E136\` 逐值守（${trailAuditE155.guardedByLedger.length} 个）＋ 记入留痕；`
      + `账本没有 ⇒ 留痕比声明（守住 ${trailAuditE155.viaTrail.length} 个、失配 ${trailAuditE155.findings.length} 个、`
      + `无留痕 ${trailAuditE155.noTrail.length} 个**显式不可比、不静默**）` +
      `｜\`E162\`：留痕**写入**这一票进判据（写失败 ⇒ 当轮判红、并把这些项记"不可比"）—— ` +
      `本轮写入 ok=${trailWriteE155.ok}、不可比 ${trailAuditE155.incomparable.length} 项`);
    if (brAudit.unmet.length) {
      t.info(`§11「E136 浏览器/长跑脚本通过数」**本轮不可比 ${brAudit.unmet.length} 个**（账本不含该脚本条目 ⇒ ` +
        '不判 FAIL、**也不计入已核对**）：' + brAudit.unmet.join('、') +
        ' —— 它们在 `run-all.__serialTail` 里排在 `docs-cross-check` **之后**，本轮账天然不含它们（`--fast` 形态同理）；' +
        '权威对账由 `run-all` 收尾按**全量** SUITES 判定（与 `E50`／`E112` 同口径）');
    }
    /* `E136` 的 D22：**内存变异账本副本**（不改盘上 `run-totals.json`）——
       ㈠把某只脚本的 `passed` 改错 ⇒ **必红并指名它**；㈡把它置空 ⇒ **从"已核对"移到"不可比"**
       （两侧各变 1、总数不变）⇒ 证明"覆盖不足"既不判 FAIL、也不装绿。**两种账本语境都成立**。 */
    /* ==================== `E162-①`／`E162-②`（2026-10-05）：留痕写入进判据 ＋ 不可比桶 ====================
       ① `E162-①`：**已合进上面那条 `E136` 主判据**（`&& trailWriteE155.ok === true`）—— 写失败 ⇒ 当轮判红，
          并**指名留痕文件与写入失败原因**；"留痕比声明"那些项同时进 `incomparable` 桶（显式"不可比"）。
       ② `E162-②`：D22 —— 同一纯函数 `trailDriftE155()` 喂**合成"写入失败"** ⇒ 不可比桶**逐条点名三只脚本**、
          失配 0 条；喂**负对照（写入成功）** ⇒ 不可比空、留痕守住三只、失配 0 条；写票守卫是 fail-closed
          （不给票 ⇒ 不可比）。⚠ 合成输入**不依赖盘上留痕的当前状态** ⇒ 基线一定干净、读数可复算。 */
    const synthTrailE162 = { ok: true, entries: {} };
    for (const nm of browserGatesE136) {
      synthTrailE162.entries[nm] = { passed: 33, declared: 33,
        at: '2026-10-04T00:00:00Z', ledgerSha12: 'deadbeef0000' };
    }
    const synthDeclE162 = (nm) => ({ declared: 33, failed: 0, skipDeclared: 0, from: '（合成三元组）' });
    const noLedgerE162 = () => undefined;
    const synthWriteFailE162 = { ok: false, written: 0, why: '（合成：留痕写失败）' };
    const synthWriteOkE162 = { ok: true, written: browserGatesE136.length, why: '' };
    const selfAuditE162 = {
      failed: trailDriftE155(synthDeclE162, browserGatesE136, noLedgerE162, synthTrailE162, synthWriteFailE162),
      control: trailDriftE155(synthDeclE162, browserGatesE136, noLedgerE162, synthTrailE162, synthWriteOkE162),
      writeFailBlocked: trailWriteGuardE162(synthWriteFailE162, browserGatesE136).blocked,
      writeOkBlocked: trailWriteGuardE162(synthWriteOkE162, browserGatesE136).blocked
    };
    t.check('E162-② D22（可证伪）：同一纯函数 `trailDriftE155()` 喂**合成"写入失败"** ⇒ ' +
      '**不可比桶逐条点名**（三只浏览器/长跑脚本）、**失配 0 条**（绝不把正确声明误诊成"声明漂移"）；' +
      '喂**负对照（写入成功）** ⇒ `incomparable` 空、`viaTrail` 守住三只、同样失配 0 条；' +
      '两次用的是**同一个函数**（`E153` 同一把尺子）；写票守卫是 fail-closed（不给票 ⇒ 不可比）',
      selfAuditE162.failed.incomparable.length === browserGatesE136.length &&
        selfAuditE162.failed.findings.length === 0 && selfAuditE162.failed.viaTrail.length === 0 &&
        selfAuditE162.failed.incomparable.every(nm => browserGatesE136.includes(nm)) &&
        selfAuditE162.control.incomparable.length === 0 &&
        selfAuditE162.control.viaTrail.length === browserGatesE136.length &&
        selfAuditE162.control.findings.length === 0 &&
        selfAuditE162.writeFailBlocked === true && selfAuditE162.writeOkBlocked === false &&
        trailWriteGuardE162(undefined, browserGatesE136).blocked === true,
      `①注入写失败 ⇒ 不可比 ${selfAuditE162.failed.incomparable.length} 项`
        + `（${selfAuditE162.failed.incomparable.join('、') || '（无）'}）、失配 ${selfAuditE162.failed.findings.length} 条`
        + `（应 0）、留痕守住 ${selfAuditE162.failed.viaTrail.length}（应 0）；`
        + `②负对照（写成功）⇒ 不可比 ${selfAuditE162.control.incomparable.length}（应 0）、`
        + `留痕守住 ${selfAuditE162.control.viaTrail.length}（应 ${browserGatesE136.length}）、`
        + `失配 ${selfAuditE162.control.findings.length}（应 0）；`
        + `③写票守卫（fail-closed）⇒ 失败票 blocked=${selfAuditE162.writeFailBlocked}、成功票 blocked=${selfAuditE162.writeOkBlocked}、`
        + `不给票 blocked=${trailWriteGuardE162(undefined, browserGatesE136).blocked}（都应"失败/成功/不给 ⇒ true/false/true"）`);
    t.info(`\`E162\` 判据链：①留痕文件＝${path.relative(env.paths.root, TRAIL_E155)}`
      + `（本轮写入点：ok=${trailWriteE155.ok}、written=${trailWriteE155.written}）；`
      + `②"留痕与声明对账"本轮记不可比 ${trailAuditE155.incomparable.length} 项`
      + `（${trailAuditE155.incomparable.join('、') || '（无）'}）而**不**报失配（失配 ${trailAuditE155.findings.length} 条）；`
      + `③负对照（合成写成功）⇒ 留痕守住 ${selfAuditE162.control.viaTrail.length} 项、失配 `
      + `${selfAuditE162.control.findings.length} 条；④D22 注入点＝环境变量 \`DSH_E162_TRAIL_WRITE_FAIL=1\``
      + `（只改返回值、不碰盘；生产路径不设它 ⇒ 行为逐字不变）`);
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
    /* ⚠ 这一支（"置空"）的**原意**是 `D20` 边界：账本覆盖不到 ⇒ 不可比、**不判红**。
       `E142` 之后"覆盖不到"分两种 —— 要保住原意就必须显式说明"**账本自述里也从没跑过它**"
       （`{ranLedger: []}`）；不给第三参会退回"账本自述"那一侧，于是"上轮跑过、这轮没了"会**判红**
       （那是 `E142` 想要的，但会把这一支的原意读反）。本座位第一版就踩了这个（实测读数见回执）。 */
    const synthHideE136 = browserLedgerAuditE136(synthDeclE136,
      (nm) => (nm === targetE136 ? undefined : synthSumE136(nm)), { ranLedger: [] });
    const mutSumE136 = (nm) => (nm === targetE136
      ? { passed: (baseE136 ? baseE136.passed : 0) + 66, failed: 0, skipped: 0 }
      : ledgerSummary[nm]);
    const hideSumE136 = (nm) => (nm === targetE136 ? undefined : ledgerSummary[nm]);
    const mutAuditE136 = browserLedgerAuditE136(browserDeclOfE136, mutSumE136);
    const hideAuditE136 = browserLedgerAuditE136(browserDeclOfE136, hideSumE136);
    /* `E142`（2026-10-04，本座位 `T-20261004-16` 乙）的三支**受控合成读数**（复用同一个纯函数）：
       ① `removed`：账本自述"上一轮跑过全部三只"（`ranLedger=应有值`、`ranRound=[]` ⇒ 退化为用账本自述），
          而本轮某只**条目消失** ⇒ 必须**判红并指名它**（旧口径下这里 `findings=0`、主断言 PASS）；
       ② `neverPlanned`：账本自述里**本来就没有**它（＝"本轮没轮到"或"`--only` 子集轮不跑它"）
          ⇒ 照旧 `unmet`、**不判红**（`D20` 边界**不被新规则破坏**）；
       ③ `allRemoved`：三只**全部消失**、而本轮仍报"跑过它们"（这一侧从 `ranRound` 来）
          ⇒ 三条都要红（不许"全部不可比就万事大吉"）。 */
    const audit142 = {
      removed: browserLedgerAuditE136(synthDeclE136,
        (nm) => (nm === targetE136 ? undefined : synthSumE136(nm)),
        { ranLedger: browserGatesE136.slice() }),
      neverPlanned: browserLedgerAuditE136(synthDeclE136,
        (nm) => (nm === targetE136 ? undefined : synthSumE136(nm)),
        { ranLedger: [] }),
      allRemoved: browserLedgerAuditE136(synthDeclE136, () => undefined, { ranRound: browserGatesE136.slice() })
    };
    const diskLedgerShaE136 = require('node:crypto').createHash('sha256')
      .update(totals.ok ? fs.readFileSync(totals.file) : Buffer.from('')).digest('hex').slice(0, 12);
    /* `E155` 的 **D22**（`PASS` 详情不打印 ⇒ 读数下面用 `t.info` 留痕）：四支**受控合成**读数 ——
       ㈠ 账本里没有它 ＋ 留痕 33 vs 声明 33 ⇒ **由留痕守住**（不判红、也不装绿）；
       ㈡ 账本里没有它 ＋ 留痕 33 vs 声明 **34** ⇒ **必红并指名**（＝"跑过 `--fast` 之后无人守"的那件事）；
       ㈢ 账本里没有它 ＋ **没有留痕** ⇒ 显式"不可比：无持久留痕"（不判红、**但绝不静默**）；
       ㈣ 账本里有它 ⇒ 交回 `E136` 逐值守（留痕不抢判据的活）。 */
    const noLedgerE155 = () => undefined;
    /* `E162`：给既有四支**显式**补上"写入成功"那一票（fail-closed 下不给票会全体变"不可比"，
       那会把 `E155` 原来的四组读数改坏 —— 这是本座位上一轮实测踩过的坑，此处按"只增不改"处理）。 */
    const synthWriteOkE155 = { ok: true, written: 1, why: '' };
    const synthTrailE155 = { ok: true, entries: { [targetE136]: { passed: 33, declared: 33, at: '2026-10-04T00:00:00Z', ledgerSha12: 'deadbeef0000' } } };
    const trail155 = {
      held: trailDriftE155(synthDeclE136, browserGatesE136, noLedgerE155, synthTrailE155, synthWriteOkE155),
      drifted: trailDriftE155((nm) => (nm === targetE136 ? { declared: 34 } : synthDeclE136(nm)), browserGatesE136, noLedgerE155, synthTrailE155, synthWriteOkE155),
      noTrail: trailDriftE155(synthDeclE136, browserGatesE136, noLedgerE155, { ok: false, why: '（合成：没有留痕）', entries: {} }, synthWriteOkE155),
      ledgerWins: trailDriftE155(synthDeclE136, browserGatesE136, synthSumE136, synthTrailE155, synthWriteOkE155)
    };
    t.check('E136 D22（可证伪）：用**受控合成三元组**（不依赖盘上账本的当前状态）把某只浏览器/长跑脚本的' +
      '通过数改错（`33 ⇒ 99`）⇒ 本判据**必红并指名它**（恰 1 条）；把它置空 ⇒ 该项**从"已核对"移到"不可比"**' +
      '（`已核对＋不可比` 总数不变）⇒ `D20` 边界两边都不装绿；判据复用的是**同一个纯函数**；' +
      '**`E155`：账本不含它时退回持久留痕 —— 留痕 33 vs 声明 34 ⇒ 必红并指名；留痕 33 vs 声明 33 ⇒ 由留痕守住；' +
      '连留痕都没有 ⇒ 显式"不可比"（不判红、但绝不静默）**；盘上账本**逐字节未变**（全程只读它，不写它）',
      synthBaseE136.findings.length === 0 && synthBaseE136.covered.length === browserGatesE136.length
        && synthMutE136.findings.length === 1
        && synthMutE136.findings[0].includes(targetE136) && synthMutE136.findings[0].includes('通过数逐脚本漂移')
        && synthMutE136.covered.length + synthMutE136.unmet.length === browserGatesE136.length
        && !synthHideE136.covered.includes(targetE136)
        && synthHideE136.unmet.some(x => x.startsWith(targetE136)) && synthHideE136.findings.length === 0
        && synthHideE136.covered.length + synthHideE136.unmet.length === browserGatesE136.length
        /* `E142` 的三支读数（同一纯函数）：①**上一轮跑过、这轮条目消失** ⇒ 判红并**指名**；
           ②**账本自述里就没有它**（＝"本轮没轮到/子集轮不跑它"）⇒ 照旧 `unmet`、不判红；
           ③**三条全删**（基线已被删干净）⇒ "这一轮仍在实跑集合里"这一侧兜住红灯（不许空转）。 */
        && audit142.removed.findings.length === 1
        && audit142.removed.findings[0].includes(targetE136)
        && audit142.removed.findings[0].includes('消失了')
        /* 三只桶合起来仍是"应有值"（`E142` 把"消失"单列成第三只桶，不是把它从计数里抹掉） */
        && audit142.removed.covered.length + audit142.removed.unmet.length + audit142.removed.disappeared.length === browserGatesE136.length
        && audit142.removed.disappeared.includes(targetE136)
        && audit142.neverPlanned.findings.length === 0
        && audit142.neverPlanned.unmet.some(x => x.startsWith(targetE136))
        && audit142.neverPlanned.disappeared.length === 0
        && audit142.allRemoved.findings.length === browserGatesE136.length
        && audit142.allRemoved.disappeared.length === browserGatesE136.length
        && browserGatesE136.every(nm => audit142.allRemoved.findings.some(f => f.includes(nm)))
        /* `E155` 的四支合成读数 */
        && trail155.held.findings.length === 0 && trail155.held.viaTrail.includes(targetE136)
        && trail155.held.noTrail.length === browserGatesE136.length - 1
        && trail155.drifted.findings.length === 1 && trail155.drifted.findings[0].includes(targetE136)
        && trail155.drifted.findings[0].includes('声明漂移')
        && trail155.noTrail.findings.length === 0 && trail155.noTrail.noTrail.length === browserGatesE136.length
        && trail155.ledgerWins.guardedByLedger.length === browserGatesE136.length,
      `合成基线：失配 ${synthBaseE136.findings.length} 条／已核对 ${synthBaseE136.covered.length}（应 0／${browserGatesE136.length}）；` +
      `合成变异（33 ⇒ 99）：失配 ${synthMutE136.findings.length} 条 ⇒ ${synthMutE136.findings.join('；') || '（无，异常）'}；` +
      `合成置空：已核对 ${synthHideE136.covered.length}／不可比 ${synthHideE136.unmet.length}（总数 ${browserGatesE136.length} 不变）、` +
      `已移入不可比=${!synthHideE136.covered.includes(targetE136)}；` +
      `【\`E142\` 三支】**上轮跑过/这轮消失**：失配 ${audit142.removed.findings.length} 条 ⇒ ${audit142.removed.findings.join('；') || '（无，异常）'}；` +
      `**从来自述没跑过**：失配 ${audit142.neverPlanned.findings.length} 条（应 0）／不可比 ${audit142.neverPlanned.unmet.length}；` +
      `**三条全删**：失配 ${audit142.allRemoved.findings.length} 条（应 ${browserGatesE136.length}）；` +
      `【\`E155\` 四支】㈠留痕 33 vs 声明 33（账本无它）⇒ 失配 ${trail155.held.findings.length} 条（应 0）、由留痕守住 ${trail155.held.viaTrail.length} 个；` +
      `㈡留痕 33 vs 声明 **34** ⇒ 失配 ${trail155.drifted.findings.length} 条 ⇒ ${trail155.drifted.findings.join('；') || '（无，异常）'}；` +
      `㈢无留痕 ⇒ 失配 ${trail155.noTrail.findings.length} 条（应 0）、**显式不可比** ${trail155.noTrail.noTrail.length} 个；` +
      `㈣账本有它 ⇒ 交回 \`E136\` 逐值守 ${trail155.ledgerWins.guardedByLedger.length} 个；` +
      `【真实账本读数（只留痕、不判红）】基线失配 ${brAudit.findings.length} 条（正常 = 0，由上面那条主断言判）；` +
      `内存改「${targetE136} 的 passed ⇒ ${(baseE136 ? baseE136.passed : 0) + 66}」后失配 ${mutAuditE136.findings.length} 条、` +
      `置空后已核对 ${hideAuditE136.covered.length}／不可比 ${hideAuditE136.unmet.length}；` +
      `盘上账本 sha256=${diskLedgerShaE136}…（D22 的变异只作用于内存访问器，不落盘）`);
    t.info(`\`E155\` D22 合成读数：㈠账本无它＋留痕 33 vs 声明 33 ⇒ 失配 ${trail155.held.findings.length}／留痕守住 ${trail155.held.viaTrail.length}`
      + `（${trail155.held.viaTrail.join('、') || '无'}）；㈡留痕 33 vs 声明 34 ⇒ 失配 ${trail155.drifted.findings.length}`
      + `（${trail155.drifted.findings[0] ? trail155.drifted.findings[0].slice(0, 200) + '…' : '（无）'}）；`
      + `㈢无留痕 ⇒ 显式不可比 ${trail155.noTrail.noTrail.length} 个（失配 ${trail155.noTrail.findings.length}）；`
      + `㈣账本有它 ⇒ 交回 E136（${trail155.ledgerWins.guardedByLedger.length} 个）`);
  }

  /* ---- 自指排除的如实交代：docs-cross-check 自身的声明值不在本节比对范围内 ---- */
  const notCompared = offlineGates.filter(n => n !== SELF_REF && sourceOf[n] === undefined);
  t.info(`未纳入逐脚本比对的离线门禁：${SELF_REF}（自指）` +
    (notCompared.length ? `；另有未取到值的：${notCompared.join('、')}` : '') +
    `（docs-cross-check 为**自指**：它声明的条数 = 它自己这次跑出来的通过数，本节结束时才确定，` +
    '账本里那条还只是它中途落盘的数；其漂移由 run-all 收尾的 verifyAuthorityTotals 按合计拦截）' +
    `｜实跑探针墙钟 ${probeWallMs} ms` +
    `｜` + '`E143` 逐脚本探针读数：' + fmtProbeDetailE143(probeRecordsE143));

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
    /**
     * **`E141`（2026-10-04，本座位 `T-20261004-16` 甲）：§16 与 §11 同口径 —— 前提不成立 ⇒ 本轮不可比。**
     *
     * 立案（座位 5 在 `C·22` 靶子②实测、主代理登记 `E141`）：同一次 `DSH_DC_PROBE_TIMEOUT_MS=1` 里，
     * §11 正确报"**探针超时…不是权威区漂移**"，而 §16 仍打印
     * 「`项目架构与技术栈.md:297` … `harness-check` 正文写 407 项 ≠ 真源 406（实跑通过数）」——
     * **症状仍指向"文档没同步"**，会让人去改**正确**的数字。
     * 根因：§16 的真源取数走 `actualOf()`，而它在探针失败时**回落滞后账本**（`:948-951`）；§11 的
     * `declaredMismatchE135()` 有 `probeFailed` 前置，§16 没有。
     *
     * **为什么"前提不成立"仍要判红、但报的话必须不同**（本件要求写进注释并在回执复述）：
     *   · **仍然判红**：拿不到真源就**不许静默放过**（`D19`/`D21`/`D23`）—— "这轮没比成"必须有人看见，
     *     否则一个取不到值的脚本会让整节悄悄变绿，那正是本仓最贵的一类缺陷。
     *   · **报的话必须不同**：超时的成因是"**判据没能跑完被测脚本**"（机器忙/预算不够），
     *     而"声明 ≠ 真源"的成因是"**文档写错了**"——**两者方向相反**。旧写法把前者渲染成后者，
     *     等于把读者送去改**对的**数字（`E110` 同族）。故这里把"不可比"单列，`msg` 里只出现
     *     "**本轮不可比**"＋原因，**绝不出现"≠ 真源"话术**。
     *
     * **§16 里还有没有别的取数路径会回落滞后账本**（要求：自己 grep 一遍 `actualOf(`／账本读取点，
     * 逐处判定并写进注释）——**`E152`（2026-10-04，据 `C·23` 第 1 组）把上一版的结论更正如下**：
     * 上一版写的是"§16 共 3 处取数，②③ 都**已接前提** ⇒ **没有第二处**未接前提的账本回落"，
     * **那句话不成立**：`E141` 只把前提加在**使用点**，而 `sumMissing16`（原 `:1533`）／`sumTruth16`
     * （原 `:1534`）的**定义**仍走 `actualOf()` ⇒ **定义了**一个"回落滞后账本"的值（只是当时没人绕过守卫用它）。
     * `repair16()`（D22 基线"按真源更正"那一步）**就是**那个绕过者（本批实测：超时轮里基线被改成 **1483**、
     * 真值 **1490**）⇒ 完整结论是：
     *   ① `scriptTruth16()`＝ 家庭 ③b／③c 的真源 ⇒ **定义层已接前提** ✓；
     *   ② `sumMissing16`／③ `sumTruth16` ⇒ **本件改成定义层接前提**（`sumEval16`，见下）；
     *   ④ `repair16()` 的和值更正口 ⇒ **本件补前提**（前提不成立 ⇒ **一个字都不改**，并如实报"跳过"）；
     *   ⑤ `audit16()` 的 `!sumTruthReady16` 守卫（使用点）⇒ **保留**：**定义层 ＋ 使用点两层都要有** ——
     *      定义层保证"漏不掉"（错值根本不会生成）、使用点保证"报的话对"（报"本轮不可比"而不是"文档漂移"）。
     *   其余"数字"要么来自**文件系统**（`compCount16`＝`src\components\*.js` 文件数、`jsTop16`＝
     *   `tests\*.js` 顶层数、`offlineCount16`＝`SUITES` 过滤结果）—— 它们**不经账本、不受探针影响**；
     *   要么来自 `declaredOf()`（**声明侧**，不是真源）。⇒ §16 **没有第二处**未接前提的账本回落。
     *   （§11 另有 `actualOf()` 的调用点：断言 1／2 走 `declaredMismatchE135` 的 `probeFailed` 前置；
     *     断言 6 的 `cannotVerify` 本就是"取不到 ⇒ 判红"那一条；调试 info 行只是留痕。均已合规。）
     * @returns {{value:(number|undefined), data:boolean, reason:string}} `data=true` ⇒ 真源有效；
     *          `data=false` ⇒ **本轮不可比**（`reason` 给出可读原因）
     */
    const truthReason16 = (name) => {
      if (name === SELF_REF) {
        const d = declaredOf(name);
        return d === null
          ? { value: undefined, data: false, reason: `自指脚本 \`${SELF_REF}\` 连权威区声明都解析不到` }
          : { value: d, data: true, reason: '' };
      }
      if (probeFailed[name]) {
        return { value: undefined, data: false, reason: probeShortfallNoteE135(name, probeFailed[name], probeTimeoutFor(name)) };
      }
      if (actualOf(name) === undefined) {
        return { value: undefined, data: false, reason: `${name} 本轮既没有账本条目、也没能实跑到` };
      }
      return { value: actualOf(name), data: true, reason: '' };
    };
    /** 家庭 ④ 的**可比性**：和值＝Σ(非自指门禁实跑值) ＋ 权威区对自指脚本的声明 ⇒ **任一项取不到 ⇒ 和值不可比**。
     *  ⚠ **`E152`（2026-10-04，据 `C·23` 第 1 组）：前提必须接在"定义层"，不能只接在"使用点"。**
     *  为什么（本件要求写进注释并在回执复述）：`E141` 只把前提加在**使用点**（下面 `audit16()` 里的
     *  `!sumTruthReady16` 守卫），而 `sumMissing16`／`sumTruth16` 的**定义**仍走 `actualOf()` ——
     *  `actualOf()` 在探针失败/取不到汇总行时**回落滞后账本** ⇒ **任何绕过使用点守卫的读者**拿到的都是
     *  "**账本拼出来的假和值**"（它看起来跟真值一模一样，没有任何标记）。本批实测到的那一处正是这样生效的：
     *  `repair16()`（D22 基线"按真源更正"那一步）**没有前提判断** ⇒ 同一次 1 ms 超时轮里 **D22 基线被改成
     *  1483**（＝滞后账本的和值；真值 **1490**），并让 `§16 D22` 变红、文案把读者引向"D22 定点变异／基线失配"。
     *  ⇒ **只在使用点加闸 = 给每一个未来的读者留一条"必须记得加闸"的义务**；把前提做进**定义**
     *  （返回值自带"前提是否成立"）才是"漏不掉"的形态 —— 本件据此把 `sumMissing16`／`sumTruth16`
     *  改成 `sumEval16` 的**派生值**：`data=false` 时 `value` 是 `undefined`（**不是**一个恰好等于
     *  滞后账本的数字），于是"忘了判前提"的读者会拿到 `undefined`，**当场显形**而不是悄悄算错。
     *  @returns {{value:(number|undefined), data:boolean, missing:string[], reason:string}}
     *           `data=true` ⇒ 和值可用；`data=false` ⇒ **本轮不可比**（`missing` 逐个列名、`reason` 可读） */
    const sumEval16 = (() => {
      const missing = offlineGates.filter(n => n !== SELF_REF && truthReason16(n).data === false);
      const selfDecl = declaredOf(SELF_REF);
      const selfOk = selfDecl !== null;
      const data = missing.length === 0 && selfOk;
      return {
        value: data
          ? offlineGates.filter(n => n !== SELF_REF).reduce((a, n) => a + truthReason16(n).value, 0) + selfDecl
          : undefined,
        data,
        missing,
        reason: data ? ''
          : (missing.length
            ? `和值真源里这些脚本本轮取不到实跑值（探针超时／无账本条目）：${missing.join('、')}`
            : `自指脚本 \`${SELF_REF}\` 的权威区声明解析不到`)
      };
    })();
    const sumTruthReady16 = sumEval16.data;
    const sumMissing16 = sumEval16.missing;   /* **定义层**就带前提：取不到的项逐个列名（不再只在使用点判） */
    const sumTruth16 = sumEval16.value;       /* `undefined` ⇒ 本轮不可比：读者必须显式处理（见 `E152`） */
    /** `<脚本名>`（N 项）族的期望值：实跑通过数（与第十一节同源）；自指脚本 ⇒ 权威区声明。 */
    const scriptTruth16 = (name) => truthReason16(name).value;

    /* —— 范围与形态表（**唯一**的命中口径；改口径必须同步这段注释） —— */
    /** dated 历史记录的排除口径（四条，取并集；都是"按小节/行前缀/显式标注限定"，**不按数字大小猜、
     *  更不按行号白名单**）：
     *  ① 行前缀是 `| <4 位年>-<2 位月>-<2 位日>`（变更记录表格行）；
     *  ② 位于「变更记录」小节标题之后的**所有**行（该小节整体是历史）；
     *  ③ 带**dated 引文标记**的行（`原始输出引文`／`（最近一轮：2026-10-02`／`截至 <日期>`）——
     *     实测例子：`项目架构与技术栈.md:292` 的「权威区合计 **1248 ＝ 1248**（最近一轮：2026-10-02 …）」
     *     是**当轮的原始输出引文**（≠ 现在的真值，也不该改），但它**不带日期行前缀、也在变更记录之前**
     *     ⇒ 只靠 ①② 抓不到它（本轮如实补上 ③，并把理由写在这里）。
     *  ④ **带"历史/现场读数"标注的行**（`E190` 新增，2026-10-05 座位 4b `T-20261005-35`）——
     *     标注词：`现场读数`／`本机不可复跑`／`（当时口径）`（全角）或 `(当时口径)`（半角）。
     *     **依据（本仓 `E120` 已立的标注约定，不是本件新造）**：`项目架构与技术栈.md:348` 是那份文档
     *     里**已写明**的口径 —— "历史读数与现状声明混在同一文档里、又都不写性质，正是技术债 `E120`
     *     的成因"，处理办法是**就地补注"（当时口径）"**；`E120` 的另一半是"描述**现状**的数字**必须**
     *     等于实跑值／权威值"。⇒ 于是"**行内已自证是历史/现场读数**"的行，其数字**不是现状声明**
     *     ⇒ 不进判定（既不改它，也不判它红）。
     *     ⚠ 为什么必须给它一条**通用规则**而不是"把某一行排除掉"：新族 ⓐ（裸 `P/F`）实测会在
     *     `项目架构与技术栈.md:88` 命中 4 处（`screenshot-diff` 24/0／`browser-check` 33/0／
     *     `overlap-check` 27/0／`stress-check` 11/0/3）—— 那一句明写"**现场读数，本机不可复跑**"，
     *     并与"**已复核到原件**"的现场门禁报告绑在一起 ⇒ 判它红＝要求改写一份**现场事实**（硬纪律 10）。
     *     按行号白名单排除则"文档一改结构就静默失效"（`E186` 的反面教材），故**按行内标注**判定。 */
    const isDated16 = s => /^\s*\|?\s*\d{4}-\d{2}-\d{2}/.test(s)
      || /原始输出引文|最近一轮[:：]|截至\s*\d{4}-\d{2}-\d{2}/.test(s)
      || /现场读数|本机不可复跑|（当时口径）|\(当时口径\)/.test(s);
    const archAll16 = read(ARCH_REL).split(/\r?\n/);
    const cutPos16 = archAll16.findIndex(l => /^#+\s*.*变更记录/.test(l));
    /* `E190`：报名字符串用**稳定的受管文档名**（`ARCH_LABEL16`），**不用** `ARCH_REL` —— 后者在
       `DSH_DC_ARCH_OVERRIDE`（**仅调试用**的读数重定向）生效时是**副本路径**，而 D22 的取证要求
       "指名**受管文档**的 `文件:行号`"（副本与真文件逐字节相同、只差被替换掉的那一处 ⇒ 行号一致）。
       README 那两条范围本来就写死 `tests/README.md`，这里与之对齐。 */
    const ARCH_LABEL16 = '项目架构与技术栈.md';
    const archRows16 = archAll16.map((text, i) => ({ file: ARCH_LABEL16, no: i + 1, text }))
      .filter(r => !isDated16(r.text) && (cutPos16 < 0 || r.no - 1 < cutPos16));
    const archExcluded16 = archAll16.length - archRows16.length;
    const readmeNo16 = readmeSrc.split(/\r?\n/).findIndex(l => l.includes('离线可跑部分')) + 1;
    const authRows16 = [{ file: 'tests/README.md', no: readmeNo16, text: authLine }];

    /* `E190`（2026-10-05，座位 4b `T-20261005-35`）：**新增两族形态**。负责人当日裁定：
       **收进 §16，不新增第 18 个脚本**（理由：同一张"声明面"的口径必须只有一处实现，
       否则又变成"两个真源各自漂移"）。
       立案＝主代理本批把 `harness 461→465`／`files 24→27`／`db 298→301` 三种变化**分三轮**才同步
       干净，每一步都靠 `docs-cross-check` **报错才找到** —— 漏掉的正是下面两族：
         ⓐ **裸 `P/F`（可含跳过位）**：形如 `` `db-check` 296/0 ``／`` `screenshot-diff` 24/0 ``／
            `` `stress-check` 11/0/3 ``（加粗可有可无、空格可有可无）。**为什么它当时没有门禁**：
            §11 只扫 `tests\README.md`（权威行 ＋ 全文），本节原有的 `scriptJ`／`scriptC` 只认
            "（N 项）"形态 ⇒ **架构文档正文里的裸 `P/F` 一处都没人看**。实测：`项目架构与技术栈.md`
            `:37`／`:83` 的 `` `db-check` 296/0 `` 与真源 301/0 不符 —— 那是**仓外审计脚本**
            `e190-decl-audit.js` 抓出来的，**不是门禁**抓出来的。
         ⓑ **自指脚本的中文形式**：`tests\README.md` 脚本表里 `docs-cross-check` 那一格的
            「**跨文档一致性（N 项）**」。**为什么这一族必须单列**（三条，缺一条都说不通）：
              ① §11 的两条逐脚本断言**按设计**都排除自指脚本（原文："自指脚本：两条逐脚本断言都比
                 不了它"——它执行时"自己这次跑出来的通过数"还没确定，拿账本里的**中途值**去比会变成
                 永远红的假失败）；
              ② 本节原有的 `scriptC` 要求"反引号脚本名**紧跟**左括号"，而脚本表那一格的形态是
                 "表格单元里 `tests/docs-cross-check.js` ＋ 中文短语 ＋（N 项）" ⇒ 该族**命中不到**；
              ③ 于是一个**真漂移**（README 脚本表写 **72**、权威行写 **84**）在当时的两族下**都不报**。
            ⇒ 该族的真源＝**权威区对自指脚本的声明数**（`declaredOf(SELF_REF)`），与和值族 ④ 里
               `selfDecl` 的取数**同源** ⇒ "脚本表的中文形式"与"权威行的三元"由同一个真源对账。
       两族共用**同一套**排除口径（`isDated16`，含新增规则 ④）与**同一套**取数
       （`truthReason16()`：账本快路径 ＋ 冲突复核；前提不成立 ⇒ `incomparable` 单列、报"本轮不可比"）——
       口径不许各写一份，否则"两族"立刻变成"两个真源"。 */
    const readmeTableRows16 = readmeSrc.split(/\r?\n/)
      .map((text, i) => ({ file: 'tests/README.md', no: i + 1, text }))
      .filter(r => /^\|\s*`tests[\\/][a-z0-9-]+\.js`\s*\|/.test(r.text) && !isDated16(r.text));
    /** ⓑ 的形态串**不硬编码**：从 §11 已解析出的"脚本表中文短语"（`tableDeclarations`）现取
     *  ⇒ 文档改标题时本族跟着走；连短语都解析不到 ⇒ 正则退化为"永不命中"、`must` 当场判红
     *  （"锚点丢失即红"，`E186`：不许静默架空）。 */
    const selfCnForm16 = (() => {
      const d = tableDeclarations.get(SELF_REF);
      return d && d.form ? d.form : null;
    })();
    const escRe16 = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const FAM16 = {
      comp: { id: '①N 个（界面）组件', re: /(\d+)\s*个\s*\*{0,2}(?:界面)?组件/g, kind: 'count', truth: () => compCount16 },
      gates: { id: '②N 个（离线）门禁', re: /(\d+)\s*个\s*\*{0,2}(?:为)?(?:带断言的)?(?:（离线）|\(离线\)|离线)?\s*门禁/g, kind: 'count', truth: () => offlineCount16 },
      js: { id: '③a N 个 `tests\\*.js`', re: /(\d+)\s*个\*{0,2}\s*`(?:\*\.js|tests\\\*\.js)`/g, kind: 'count', truth: () => jsTop16 },
      scriptJ: { id: '③b `脚本.js`（N 项）', re: /`([a-z0-9-]+)\.js`\s*（\s*\*{0,2}\s*(\d+)\s*项/g, kind: 'script' },
      scriptC: { id: '③c `脚本`（…N 项）', re: /`([a-z0-9-]+)`\s*（[^（）|]{0,14}?\*{0,2}(\d+)\s*项/g, kind: 'script' },
      scriptpf: {
        id: '⑤裸 `脚本名` P/F（可含跳过位）',
        /* `E190`ⓐ：加粗可有可无、空格可有可无；第三位（跳过数）可选。**只认紧贴**的形态
           （反引号脚本名 ＋ 数字/数字），故 `E123 的 REQUIRED_TABLES ＝ 14` 这类断言不会误入。
           ⚠ 名字字符集与 §11 的 `nameDecl` 同口径（`[a-z0-9-]`，不含点/斜杠）⇒ 「`judge.js` 15/15」
           这种**非门禁**形态不会被抓（它不是"`脚本名` P/F"，而 `judge.js` 也不在门禁清单里）。 */
        re: /`([a-z0-9-]+)`\s*\*{0,2}\s*(\d+)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?/g,
        kind: 'scriptpf'
      },
      selfcn: {
        id: '⑥自指脚本的中文形式（`跨文档一致性（N 项）`）',
        /* `E190`ⓑ：形态串从 §11 已解析出的"脚本表中文短语"现取（**不硬编码**标题）；
           取不到 ⇒ 退化为"永不命中"，由 `must` 当场判红（锚点丢失不许静默）。 */
        re: selfCnForm16 ? new RegExp(escRe16(selfCnForm16) + '（(?:\\*\\*|\\s)*(\\d+)\\s*项', 'g') : /(?!)/g,
        kind: 'selfcn'
      },
      sum: { id: '④N 个的和是 M', re: /(\d+)\s*\*{0,2}\s*个\s*\*{0,2}\s*的和是\s*\*{0,2}(\d+)/g, kind: 'sum' }
    };
    const SRC16 = [
      { file: ARCH_LABEL16, rows: archRows16, fams: ['comp', 'gates', 'js', 'scriptJ', 'scriptC', 'scriptpf', 'sum'], must: ['comp', 'gates', 'js', 'scriptJ', 'scriptpf'] },
      { file: 'tests/README.md', rows: authRows16, fams: ['gates', 'js', 'sum'], must: ['gates', 'sum'] },
      /* `E190`ⓑ：**单列一条范围**（同一文件、另一段行区间）—— 不去扩 README 的权威行范围，
         因为那样会让 ①②③④ 族也去扫整张脚本表（实测会命中"性能微基准/失败条数"那类**归属不同**
         的数字，见本节抬头"为什么范围必须显式列明"）。`label` 只用于范围读数，`file` 仍用于报
         `文件:行号`（必须可 grep 回原文）。 */
      { file: 'tests/README.md', label: 'tests/README.md（脚本表行）', rows: readmeTableRows16, fams: ['selfcn'], must: ['selfcn'] }
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
                const name = m[1]; const got = Number(m[2]);
                const t16 = truthReason16(name);
                if (!t16.data) {
                  /* `E141`：**前提不成立 ⇒ 本轮不可比**（不产出"声明 ≠ 真源"失配项；仍由下面那条
                     专门的断言判红并指名）—— 文案里只出现"本轮不可比"，**不出现"≠ 真源"话术**。 */
                  findings.push({ key, incomparable: true, msg: `${where} ${fam.id}：\`${name}\`（${got} 项）**本轮不可比**（${t16.reason}）` });
                } else if (got !== t16.value) {
                  findings.push({ key, msg: `${where} ${fam.id}：\`${name}\` 正文写 ${got} 项 ≠ 真源 ${t16.value}` +
                    `${name === SELF_REF ? '（自指 ⇒ 与权威区声明比对）' : '（实跑通过数）'}（"${raw}"）` });
                }
              } else if (fam.kind === 'scriptpf') {
                /* `E190`ⓐ：裸 `P/F`（可含跳过位）⇒ 与逐脚本真源比对。**取数口径与 §11／本节其余族一致**：
                   通过数走 `truthReason16()`（账本快路径 ＋"声明≠账"时的冲突复核实跑；自指 ⇒ 权威区声明）；
                   失败/跳过位只有**账本**这一个真源（`ledgerSummary`），账本没有该脚本的完整三元 ⇒
                   `incomparable`（**不许**拿"没第三位"当"跳过为 0"、也不许只比通过数就算过）。 */
                const name = m[1];
                const gotP = Number(m[2]); const gotF = Number(m[3]);
                const gotS = m[4] === undefined ? null : Number(m[4]);
                const t16 = truthReason16(name);
                const led = ledgerSummary[name];
                if (!t16.data || !led) {
                  findings.push({ key, incomparable: true, msg: `${where} ${fam.id}：\`${name}\`（"${raw}"）**本轮不可比**（`
                    + (!t16.data ? t16.reason : `账本里没有 \`${name}\` 的完整三元 ⇒ 失败/跳过位无从比对`) + '）' });
                } else {
                  const want = `${t16.value}/${led.failed}${gotS === null ? '' : '/' + led.skipped}`;
                  const badP = gotP !== t16.value; const badF = gotF !== led.failed;
                  const badS = gotS !== null && gotS !== led.skipped;
                  if (badP || badF || badS) {
                    findings.push({ key, msg: `${where} ${fam.id}：\`${name}\` 正文写 ${gotP}/${gotF}`
                      + `${gotS === null ? '' : '/' + gotS} ≠ 真源 ${want}`
                      + `（通过数＝${name === SELF_REF ? '权威区对自指脚本的声明' : '账本快路径／冲突复核实跑'}；`
                      + '失败与跳过位＝本轮账本 `run-totals.json`）'
                      + (badS ? `｜**跳过位**：正文写 ${gotS} ≠ 账本 ${led.skipped}` : '') + `（"${raw}"）` });
                  }
                }
              } else if (fam.kind === 'selfcn') {
                /* `E190`ⓑ：自指脚本的中文形式 ⇒ 与"权威区对自指脚本的声明数"比对（与和值族 ④ 同源）。
                   取不到权威区声明 ⇒ `incomparable`（不静默放过、也不把"取不到"说成"文档写错"）。 */
                const got = Number(m[1]);
                const selfDecl16 = declaredOf(SELF_REF);
                if (selfDecl16 === null) {
                  findings.push({ key, incomparable: true, msg: `${where} ${fam.id}：**本轮不可比**`
                    + `（权威区对自指脚本 \`${SELF_REF}\` 的声明数解析不到）` });
                } else if (got !== selfDecl16) {
                  findings.push({ key, msg: `${where} ${fam.id}：正文写 ${got} 项 ≠ 权威区对自指脚本 `
                    + `\`${SELF_REF}\` 的声明 ${selfDecl16}（自指 ⇒ 与权威区比对，与和值族同源）（"${raw}"）` });
                }
              } else {
                const n2 = Number(m[1]); const got = Number(m[2]);
                if (n2 !== offlineCount16) {
                  findings.push({ key, msg: `${where} ${fam.id}："${raw}" 的"${n2} 个"≠ 离线门禁实数 ${offlineCount16}` });
                } else if (!sumTruthReady16) {
                  /* `E141`＋`E152`：和值的真源依赖"每个非自指门禁的实跑值都在" ⇒ 任一项取不到即**不可比**
                     （`sumEval16.missing` 是**定义层**给出的逐个列名结果，不再只在使用点重算一遍）。 */
                  findings.push({ key, incomparable: true, msg: `${where} ${fam.id}："${raw}" **本轮不可比**`
                    + `（${sumEval16.reason}）` });
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
      `${A16.checked} 处命中｜${famCounts16}｜范围：${SRC16.map(s => `${s.label || s.file}（${s.rows.length} 行）`).join('、')}` +
      `｜dated/标注历史记录**已排除** ${archExcluded16} 行（口径：日期行前缀 ／ 变更记录小节之后 ／ dated 引文标记 ／ ` +
      `行内「现场读数·本机不可复跑·（当时口径）」标注 —— 见 \`E190\` 规则 ④）` +
      (A16.lost.length ? `｜**锚点丢失**：${A16.lost.join('；')}` : '') +
      `｜真源：组件 ${compCount16}／离线门禁 ${offlineCount16}／tests\\*.js ${jsTop16}／和值 `
      + (sumTruthReady16 ? sumTruth16 : `（**本轮不可比**：${sumEval16.reason}）`) +
      (sumMissing16.length ? `（**和的取数不完整**：${sumMissing16.join('、')} 无实跑值）` : ''));
    /* `E190` 的**排除口径真值表**（合成样本，两组对照）—— 不进主判定，只证明"规则 ④"是承重的。
       为什么用**合成**样本：真行（`项目架构与技术栈.md:88`）的"现场读数"是否恰好与当前账本不符，
       取决于**现场那台机器**当时的读数，会随环境变；把它当判据会变成"看运气"的门禁。
       合成的两组共用同一行文本，**只差标注词** ⇒ 命中差异只能由规则 ④ 解释。 */
    const cfText16 = '| 兆芯平台与 4K 真机实测 | 🟡 部分实测 | `screenshot-diff` 24/0、`browser-check` 33/0**现场读数，本机不可复跑** |';
    const cfRow16 = (text) => [{ file: '（合成）排除口径样本', no: 1, text }];
    const auditCf16 = (rows) => audit16([{ file: '（合成）排除口径样本', rows, fams: ['scriptpf'], must: [] }]);
    const cfWithMark16 = auditCf16(cfRow16(cfText16).filter(r => !isDated16(r.text)));
    const cfNoMark16 = auditCf16(cfRow16(cfText16.replace('**现场读数，本机不可复跑**', '')).filter(r => !isDated16(r.text)));
    /* 真行上的**反事实读数**（只作留痕）：把带标注的真行塞回扫描面 ⇒ 会多出哪些失配。 */
    const archAnnotRows16 = archAll16.map((text, i) => ({ file: ARCH_LABEL16, no: i + 1, text }))
      .filter(r => isDated16(r.text) && !/^\s*\|?\s*\d{4}-\d{2}-\d{2}/.test(r.text)
        && !/原始输出引文|最近一轮[:：]|截至\s*\d{4}-\d{2}-\d{2}/.test(r.text) && (cutPos16 < 0 || r.no - 1 < cutPos16));
    const A16cfReal = audit16(SRC16.map(s => (s.rows === archRows16 ? { ...s, rows: archRows16.concat(archAnnotRows16) } : s)));
    const cfReal16 = A16cfReal.findings.filter(f => !f.incomparable && f.key === 'scriptpf');
    t.check('`E190` §16 排除口径（**按行内标注、不按行号白名单**）：带「现场读数／本机不可复跑／（当时口径）」' +
      '标注的行**整行不进判定**（依据＝`E120` 已立的标注约定：行内已自证是历史/现场读数 ⇒ 其数字不是现状声明），' +
      '且这条口径**是承重的**（同一行去掉标注词就会判红并指名）—— 既不许误判现场读数，也不许把规则写成"恒排除"',
      archAnnotRows16.length > 0 && archAnnotRows16.every(r => !archRows16.some(x => x.no === r.no))
        && cfWithMark16.findings.length === 0 && cfNoMark16.findings.length > 0,
      `按规则 ④ 排除的**非 dated** 行：${archAnnotRows16.map(r => `${r.file}:${r.no}`).join('、') || '（无）'}；`
      + `合成真值表：带标注 ⇒ 失配 ${cfWithMark16.findings.length} 处（应 0）、去掉标注 ⇒ 失配 ${cfNoMark16.findings.length} 处（应 >0，`
      + `${cfNoMark16.findings.map(f => f.msg).join('；')}）；`
      + `**真行反事实读数（只作留痕）**：若把上述真行塞回扫描面，新族 ⑤ 会多出 ${cfReal16.length} 处失配`
      + `${cfReal16.length ? `：${cfReal16.map(f => f.msg).join('；')}` : ''}（**这些正是"现场读数"不该被判的地方**）`);
    /* `E190` 的**每轮可见读数**（`PASS` 详情不打印 ⇒ 用 `t.info` 留痕）：两族的命中数与排除面 ——
       没有这一行，"排除口径把 :88 挡掉了"这件事只能靠读代码相信（`D19` 的"看起来验过了"）。 */
    t.info('`E190` §16 新增两族读数（每轮可见）：'
      + `⑤ 裸 \`脚本名\` P/F（可含跳过位）命中 ${A16.hits.scriptpf || 0} 处、`
      + `⑥ 自指脚本中文形式命中 ${A16.hits.selfcn || 0} 处（形态串：「${selfCnForm16 === null ? '**解析不到**' : selfCnForm16}」）；`
      + `排除口径 ④ 排除的**非 dated** 行＝${archAnnotRows16.map(r => `${r.file}:${r.no}`).join('、') || '（无）'}；`
      + `**真行反事实（若不排除会多出的 ⑤ 失配）**＝${cfReal16.map(f => f.msg).join('；') || '（无）'}`
      + `｜本次读入：架构＝${ARCH_REL}、README＝${README_REL}`
      + `${ARCH_REL === '项目架构与技术栈.md' && README_REL === 'tests/README.md' ? '（**盘上真文件**）'
        : '（**⚠ `DSH_DC_*_OVERRIDE` 生效，读的是副本** —— 报文里的 `文件:行号` 仍按受管文档名给出）'}`);

    const badNum16 = A16.findings.filter(f => f.key !== 'sum' && !f.incomparable);
    const badSum16 = A16.findings.filter(f => f.key === 'sum' && !f.incomparable);
    /* `E141`：**不可比**单列一桶 —— 它仍判红（见下一条），但**不许**混进"声明 ≠ 真源"的失配清单
       （否则同一次探针超时会被读成"文档没同步"，正是本件要消掉的那个误导方向）。 */
    const incomp16 = A16.findings.filter(f => f.incomparable);
    t.check('E112 §16 断言（数量族 ①②③⑤⑥）：正文内部引数（N 个组件／N 个（离线）门禁／N 个 `tests\\*.js`／' +
      '`<脚本名>`（N 项）／`E190`ⓐ **裸 `脚本名` P/F（可含跳过位）**／`E190`ⓑ **自指脚本的中文形式**）与真源**零失配**' +
      '（逐处指名 `文件:行号`；真源＝`src\\components\\*.js` 文件数／`run-all` 的 `SUITES` 过滤结果／各脚本**实跑**条数／' +
      'ⓐ＝逐脚本三元（通过数走账本快路径＋冲突复核，失败与跳过位取本轮账本）／ⓑ＝权威区对自指脚本的声明数）；' +
      '**前提不成立（探针超时/取不到汇总行/账本无完整三元）的项走"本轮不可比"**，' +
      '不在此清单里（`E141`：两节的判定口径现已一致）',
      badNum16.length === 0,
      badNum16.length ? `失配 ${badNum16.length} 处：${badNum16.map(f => f.msg).join('；')}`
        : `零失配（${Object.keys(FAM16).filter(k => k !== 'sum').map(k => `${FAM16[k].id}=${A16.hits[k] || 0} 处`).join('、')}）；` +
          `真源：组件 ${compCount16}／离线门禁 ${offlineCount16}／tests\\*.js ${jsTop16}／各脚本实跑条数` +
          `／ⓑ 自指中文形式串＝${selfCnForm16 === null ? '**解析不到**（锚点丢失）' : `「${selfCnForm16}」`}` +
          (incomp16.length ? `；**本轮不可比 ${incomp16.length} 处**（见下一条断言）` : ''));

    t.check('E112 §16 断言（和值族 ④）：「N 个的和是 M」的 N ＝ 离线门禁实数、M ＝ 真源和值' +
      '（真源＝13 个非自指离线门禁的实跑通过数之和 ＋ 权威区对自指脚本的声明数）',
      badSum16.length === 0,
      badSum16.length ? `失配 ${badSum16.length} 处：${badSum16.map(f => f.msg).join('；')}`
        : `零失配（命中 ${A16.hits.sum || 0} 处，和值真源 ${sumTruthReady16 ? sumTruth16 : '（本轮不可比）'}）`);

    /* `E141`（2026-10-04，本座位 `T-20261004-16` 甲）：**§16 与 §11 同口径** —— 前提不成立（探针超时／
       取不到汇总行）⇒ **本轮不可比**，**不产出"声明 ≠ 真源"失配项**；但**仍然判红**（取不到不得静默放过，
       `D19`/`D21`/`D23`），只是**报的话不同**（"本轮不可比"＋具体原因，绝不出现"≠ 真源"话术）。
       为什么两件事必须分开报（回执里也复述）：超时的成因是"**判据没能在预算内跑完被测脚本**"，
       "声明 ≠ 真源"的成因是"**文档写错了**"—— 成因相反，混报会把读者送去改**正确**的数字（`E110` 同族）。 */
    t.check('E141 §16 与 §11 同口径：**前提不成立（探针超时／取不到汇总行）⇒ 本轮不可比**、' +
      '不产出"声明 与 真源 不一致"的失配项 —— 但仍**判红**并逐处指名（"取不到不得静默放过"），只是报的话不同',
      incomp16.length === 0,
      incomp16.length
        ? `**本轮不可比 ${incomp16.length} 处**（前提不成立 ⇒ 不是"文档漂移"）：${incomp16.map(f => f.msg).join('；')}`
        : `本轮无"前提不成立"的取数（探针失败 ${Object.keys(probeFailed).length} 个）`);

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
    /** 把**每一处**被识别到的引数按真源就地改写（只作用于传入的字符串副本）。
     *  **`E152`（2026-10-04）：前提不成立时，和值族一个字都不许改。** 立案实测：旧写法在这一步
     *  **没有前提判断** ⇒ `DSH_DC_PROBE_TIMEOUT_MS=1` 那一轮把 D22 基线从 **1490** 改成 **1483**
     *  （＝滞后账本的和值）⇒ 基线随环境漂，且 `§16 D22` 变红、文案指向"D22 定点变异／基线失配"。
     *  修法＝在每个"按真源更正"的入口**逐族判前提**（`sum` 族要求 `sumEval16.data === true` —— 与主断言
     *  **同一个** `sumEval16`；`script` 族要求该脚本 `truthReason16(name).data === true`；`count` 族的真源
     *  来自**文件系统**、不经账本 ⇒ 前提恒成立、照改）。**拒绝更正时如实报"跳过"**（不静默）。
     *  @returns {{srcs:Array, skipped:Array<string>, sumRowsBefore:string, sumRowsAfter:string}} */
    const repair16 = (srcs) => {
      const skipped = [];
      const repaired = srcs.map(src => ({
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
                else skipped.push(`${key}（\`${m[1]}\` 本轮不可比 ⇒ **拒绝按真源更正**）`);
              } else if (fam.kind === 'scriptpf') {
                /* `E190`ⓐ：按**逐脚本三元**更正（通过数＝`truthReason16`，失败/跳过＝账本）。
                   只改**第二个反引号之后**的数字 ⇒ 脚本名里万一有数字也不会被误改。 */
                const tie16 = truthReason16(m[1]);
                const led16 = ledgerSummary[m[1]];
                if (!tie16.data || !led16) {
                  skipped.push(`${key}（\`${m[1]}\` 本轮不可比 ⇒ **拒绝按真源更正**）`);
                } else {
                  const cut16 = m[0].indexOf('`', 1) + 1;
                  const exp16 = [tie16.value, led16.failed].concat(m[4] === undefined ? [] : [led16.skipped]);
                  let ki16 = 0;
                  rep = m[0].slice(0, cut16) + m[0].slice(cut16).replace(/\d+/g, () => String(exp16[ki16++]));
                }
              } else if (fam.kind === 'selfcn') {
                /* `E190`ⓑ：按"权威区对自指脚本的声明数"更正（与和值族同源）。 */
                const selfRep16 = declaredOf(SELF_REF);
                if (selfRep16 === null) skipped.push(`${key}（自指脚本的权威区声明解析不到 ⇒ **拒绝按真源更正**）`);
                else rep = rep.replace(/(\d+)(\s*项)/, selfRep16 + '$2');
              } else if (Number(m[1]) === offlineCount16) {
                if (!sumEval16.data) {
                  /* ← `E152`：**前提不成立 ⇒ 不改基线**（旧写法在这里会写进滞后账本的和值） */
                  skipped.push(`${key}（和值本轮不可比 ⇒ **拒绝按真源更正**：${sumEval16.reason}）`);
                } else {
                  rep = rep.replace(/(的和是\s*\*{0,2}\s*)\d+/, '$1' + sumTruth16);
                }
              }
              out += text.slice(last, m.index) + rep; last = m.index + m[0].length;
            }
            text = out + text.slice(last);
          }
          return { ...row, text };
        })
      }));
      /* "基线有没有被改"的读数：只取**和值族所在的行**（这一族是 `E152` 的主角） */
      const sumRowsOf16 = (list) => list.flatMap(s => (s.fams.includes('sum') ? s.rows.map(r => r.text) : [])).join('\n');
      return { srcs: repaired, skipped, sumRowsBefore: sumRowsOf16(srcs), sumRowsAfter: sumRowsOf16(repaired) };
    };
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
    const base16R = repair16(SRC16);
    const base16 = base16R.srcs;
    const A16base = audit16(base16);
    /* `E152`：**基线里"不可比"的项单列一桶**（`E141` 的 `incomparable` 标记）——
       它们**既不算失配、也不算通过**（"通过"由 §16 的前两条断言在**前提成立**时给出）。
       ⚠ 为什么必须排除，而不是把主断言放宽：不排除时"超时轮"会让本条 D22 **必红**
       （`C·23` 实测：`基线失配 3 处` ⇒ 文案把读者引向"D22 定点变异／基线失配"，而四个变异体全打 `true`）。
       排除之后"取不到"仍**不许静默放过**：它由上面那条 `E141 §16 与 §11 同口径` 断言**判红并指名**
       （报的话是"**本轮不可比**"）⇒ 两条各司其职：**一条管"不可比要有人说"，一条管"可比时必须可证伪"**。 */
    const baseIncomp16 = A16base.findings.filter(f => f.incomparable);
    const baseBad16 = A16base.findings.filter(f => !f.incomparable);
    /* `E152` 的**"改动前"读数**（只作留痕，不参与判据）：把**旧定义**（照抄：`actualOf()` 直接求和、
       无前提 —— 探针失败时它会静默回落到**滞后账本**）算一遍 ⇒ 看它在**同一轮**会给出什么数。
       本批实测：`DSH_DC_PROBE_TIMEOUT_MS=1` ＋ 账本 `harness-check 413→406` 时它给 **1483**，
       而真值 **1490** ⇒ 旧写法会把 D22 基线写成 1483。 */
    const laggedSumOld16 = offlineGates.filter(n => n !== SELF_REF)
      .reduce((a, n) => a + (actualOf(n) === undefined ? 0 : actualOf(n)), 0)
      + (declaredOf(SELF_REF) === null ? 0 : declaredOf(SELF_REF));
    /* "基线（和值族）有没有被改"：前提成立 ⇒ 基线里和值＝真源；前提不成立 ⇒ **逐字未改**
       （⚠ 这一条**就是 `E152` 的可证伪点**：把 `repair16()` 里那层前提闸去掉，超时轮就会把 1483 写进基线
       ⇒ `sumBaselineUntouched16` 变 false ⇒ 本条 D22 **必红**） */
    const sumBaselineUntouched16 = base16R.sumRowsBefore === base16R.sumRowsAfter;
    const sumRepairHeld16 = sumEval16.data
      ? base16R.sumRowsAfter.includes(String(sumTruth16))
      : sumBaselineUntouched16;
    const mutants = ['comp', 'gates', 'scriptC', 'scriptpf', 'selfcn', 'sum'].map(k => ({ k, m: bump16(base16, k) }))
      .map(x => ({ ...x, a: x.m ? audit16(x.m.srcs) : null }));
    const directed = mutants.every(x => x.m && x.a
      && x.a.findings.some(f => f.key === x.k && f.msg.startsWith(x.m.where)));
    t.check('E112 §16 D22 定点变异（**内存文本变异**，同一次变异改坏**六个族**各一处）：' +
      '①「N 个组件」改错、②「N 个（离线）门禁」改错、③一处「`<脚本>`（N 项）」改错、' +
      '⑤`E190`ⓐ「裸 `脚本名` P/F」改错、⑥`E190`ⓑ「自指脚本的中文形式」改错、④「N 个的和是 M」改错 ⇒ ' +
      '六条判据必须各自**红并逐处指名 `文件:行号`**；按真源更正后的基线必绿（**`E152`：`incomparable` 项单列一桶、不算失配**，' +
      '它们由 §16 的"本轮不可比"那条断言判红）；**前提不成立时和值族一个字都不许改**（基线不被污染）；盘上两个文件逐字节未变',
      baseBad16.length === 0 && A16base.lost.length === 0 && directed
        && sumRepairHeld16
        && sha16(fs.readFileSync(archFile16, 'utf8')) === archSha0
        && sha16(fs.readFileSync(readmeFile16, 'utf8')) === readmeSha0,
      `基线失配 ${baseBad16.length} 处（**应 0**）、另有**本轮不可比** ${baseIncomp16.length} 处（单列，不计入失配；锚点丢失 ${A16base.lost.length} 处）；` +
      `和值族基线：前提${sumEval16.data ? '**成立**（已按真源更正 ⇒ 基线和值 ' + sumTruth16 + '）' : '**不成立**（拒绝更正 ⇒ 和值行逐字未改=' + sumBaselineUntouched16 + '、旧定义照抄会给 ' + laggedSumOld16 + '）'}` +
      `${base16R.skipped.length ? '；**拒绝更正的族**：' + [...new Set(base16R.skipped)].join('；') : ''}；` +
      mutants.map(x => x.m
        ? `${FAM16[x.k].id}：变异 ${x.m.where} 的「${x.m.from}」⇒ 命中该族且指名该行=${Boolean(x.a && x.a.findings.some(f => f.key === x.k && f.msg.startsWith(x.m.where)))}`
        : `${FAM16[x.k].id}：**锚点未命中，无法变异**`).join('；') +
      `｜盘上未变 arch=${sha16(fs.readFileSync(archFile16, 'utf8')) === archSha0}` +
      ` readme=${sha16(fs.readFileSync(readmeFile16, 'utf8')) === readmeSha0}`);
    /* `E152` 的读数**每轮可见**（`PASS` 详情不打印 ⇒ 用 `t.info` 留痕；这是丙/乙两件回执的原始读数）。 */
    t.info(`\`E152\` 读数（§16 D22 基线）：和值前提 ${sumEval16.data ? '**成立**' : '**不成立**'}`
      + `${sumEval16.data ? '' : `（${sumEval16.reason}）`}；`
      + `按真源更正后的基线和值＝${sumEval16.data ? sumTruth16 : '（未更正）'}；`
      + `**旧定义照抄**（` + '`actualOf()` 直接求和、无前提' + `）在同一轮会给出＝${laggedSumOld16}` +
      `${sumEval16.data ? '' : '（**这就是改动前会写进基线的那个数** ⇒ 基线随环境漂）'}；`
      + `和值族行 sha 前后相同=${sumBaselineUntouched16}；`
      + `拒绝更正的族＝${base16R.skipped.length ? [...new Set(base16R.skipped)].join('；') : '（无）'}；`
      + `基线失配 ${baseBad16.length} 处／本轮不可比 ${baseIncomp16.length} 处`);
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
