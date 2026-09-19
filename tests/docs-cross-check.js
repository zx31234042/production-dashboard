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
  t.check('架构文档标注"待建"的 server/ 当前不存在',
    !dirs.includes('server') && arch.includes('⬜ 待建'), `实际：${dirs.join(', ')}`);
  t.check('架构文档标注"待建"的 platform/ 当前不存在', !dirs.includes('platform'));
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

  t.finish();
}

/* 与既有脚本一致：异常以退出码 2 结束 */
try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
