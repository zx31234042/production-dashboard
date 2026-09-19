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
   依赖：仅 Node 内置模块（纯文本读取）。
   运行：node tests/docs-cross-check.js
   退出码：0 = 全部一致；1 = 有跨文档不一致（**失败项即待修缺陷**）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const env = require('./env');
const { createRunner } = require('./lib/assert');

const ROOT = env.paths.root;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));

/** 取需求文档当前基线文件名（排除 历史文件/） */
function baselineReqFile() {
  const dir = path.join(ROOT, '需求文档');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  return files.sort().pop();
}

const t = createRunner('跨文档一致性（docs-cross-check）');
env.assertRuntime();

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
  const logRules = (log.match(/PROJECT_RULES\.md`?\s*\*\*v([\d.]+)\*\*/) || [])[1];
  t.check('工作日志声明的规范版本 = PROJECT_RULES 头部版本',
    logRules === rulesV, `工作日志 v${logRules}`);

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
     `platform\clock.js` 是时间来源本身，**豁免**。 */
  /**
   * 逐行返回"去掉注释后"的代码行（P3-7 需要：注释里会写"禁止 new Date()"这类说明，
   * 首版把这些注释行判成了违规）。只做**行级轻量处理**：识别 `//` 与成对的 `/* … *\/`，
   * 足够用于静态扫描，不追求完整 JS 词法分析。
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
      const open = line.indexOf('/*');
      if (open >= 0 && line.indexOf('*/', open) < 0) { inBlock = true; line = line.slice(0, open); }
      const slash = line.indexOf('//');
      if (slash >= 0) line = line.slice(0, slash);
      out.push(line);
    }
    return out;
  };

  const clockHits = [];
  for (const dir of ['server', 'platform']) {
    for (const f of walkJs(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, f);
      if (rel === path.join('platform', 'clock.js')) continue;
      stripComments(fs.readFileSync(f, 'utf8')).forEach((line, i) => {
        if (!/new Date\(\s*\)/.test(line)) return;
        /* 精确判据（首版 `=\s*new Date()` 过宽，把 `const now = new Date();` 也当成了形参默认值 ——
           反证时发现该写法**没能被抓出**，故收紧为其后必须紧跟逗号或右括号）：
           · 缺省兜底：`X || new Date()`
           · 形参默认值：`param = new Date()` 或 `param = new Date(),`
           · 三元兜底：`cond ? new Date()` 或 `: new Date()` */
        const injectable = /\|\|\s*new Date\(\s*\)/.test(line) ||
          /\(\s*\w+\s*=\s*new Date\(\s*\)\s*[,)]/.test(line) ||
          /[?:]\s*new Date\(\s*\)/.test(line);
        if (!injectable) clockHits.push(`${rel}:${i + 1}`);
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
  const readmeSrc = read('tests/README.md');
  const { spawnSync } = require('node:child_process');

  /** 实跑一个门禁脚本（输出落文件后回读；受限环境禁管道，故不用 pipe） */
  const probe = (script) => {
    const log = path.join(env.ensureDir(env.paths.tempRoot), `docs-cross-${script}-${process.pid}.log`);
    const fd = fs.openSync(log, 'w');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', script + '.js')],
      { cwd: ROOT, stdio: ['ignore', fd, fd], timeout: 300000 });
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
    let out = '';
    try { out = fs.readFileSync(log, 'utf8'); } catch { out = ''; }
    try { fs.rmSync(log, { force: true }); } catch { /* 忽略 */ }
    return { code: r.status, out };
  };

  /** 说明：`run-totals.json` 是 runner 落盘的实跑账，**本脚本不读它** ——
   *  "权威值 vs 实跑合计"的比对本脚本做不了（suite 成员按定义读不到本轮最终账），
   *  已移到 `run-all` 收尾执行（它是唯一持有最终账、且不会自递归的地方）。 */

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

  /* README 写法：`可追溯覆盖 164 条（64.1%）`；不写"164/256"那种形式，故按"条"取分子 */
  const readmeCov = [
    numeric.matchNumber(readmeSrc, /可追溯覆盖\s*(\d+)\s*条/),
    numeric.matchNumber(readmeSrc, /(\d+)\s*条\*\*需求条款/)
  ];
  const traceCov = (trRun.out.match(/可追溯覆盖[^\d]*(\d+)\s*\/\s*(\d+)/) || []).slice(1).map(Number);
  t.check('权威区的可追溯覆盖率＝ trace-check 实跑值（分子与条款总数都比）',
    readmeCov[0] !== null && readmeCov[1] !== null && traceCov.length === 2 &&
    readmeCov[0] === traceCov[0] && readmeCov[1] === traceCov[1],
    `README=${readmeCov.join(' / ')}，实跑=${traceCov.join(' / ')}`);

  t.finish();
}

/* 与既有脚本一致：异常以退出码 2 结束 */
try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
