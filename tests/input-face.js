/* ==========================================================================
   输入面登记表（tests/input-face.js）—— `ADR-0010` **D4** 的**单一真源**
   --------------------------------------------------------------------------
   作用（D4 原文口径）：每个门禁脚本必须登记它的"**输入面**"＝该脚本**读到的受管文件集合**
         （例：`db-check ← server/db/** ＋ tests/lib/fixture.js ＋ tests/env.js`）。
         未登记者在缓存档（D3）**一律真跑**并标 `uncached:no-input-face`。
   依据：`项目记录\ADR\ADR-0010-测试执行的档位与可作证性.md` D3/D4（D4 见该文"四、落地与验收"
         对应行）；`ADR-0011` D4「**D3 先行**」——**本件只做登记表**，不做缓存读写／失效那一半。
         脚本名单**从 `tests\run-all.js` 的 `SUITES` 现取**（不写死第二份）。
   用法：
     node tests\input-face.js --self-test     只读自检（不写盘）：打印名单数／已登记数／逐脚本
                                              条目数／validateFace 四类结果／dynamic 条目清单。
                                              退 0 ＝ 四类全空；退 1 ＝ 有非空并逐条指名。
     const r = require('./input-face');  r.faceOf('db-check');  r.validateFace();
   --------------------------------------------------------------------------
   **require('./run-all') 不会跑门禁**（已核实，不是推测）：`tests\run-all.js` 末尾是
     `if (require.main === module) { main()… }` 守卫，且顶层只有 require ＋ 常量／函数定义
     （`SUITES`、`CAPTURE_SUITE`、`REGISTERED_DEVIATIONS`、`resolveLedgerFile()` 等纯函数）
     ⇒ 被 require 时一行断言都不跑、一个字节都不写（与 `harness-check` 直接 require 它同款用法）。
   --------------------------------------------------------------------------
   **推导方法（可复跑；行号会漂，复核请按符号名 ＋ 这些命令现取）**：
     ① 机械扫描（本轮用它出的候选清单）：
        `node tests\._verify\E193-input-face-probe.js <脚本名>`（只读探针，落 `._verify\` 不入库）
        —— 打印：仓内 require 传递闭包／`env.paths.<键>` 用法／fs 读调用（字面量首参与变量首参
        分开）／起子进程语句／`process.env.*`／argv 解析点。
     ② 逐条人工复核用的 grep（本件的主要证据形态）：
        `grep -n "require(" tests\<脚本>.js`                      —— 仓内模块依赖
        `grep -n "path.join(ROOT" tests\<脚本>.js`                —— 仓根相对的字面路径（扫描根）
        `grep -n "readdirSync\|walk(\|readText(\|read(" tests\<脚本>.js` —— 动态目录扫描／按名取文件
        `grep -n "spawn\|execFileSync\|execSync" tests\<脚本>.js` —— 起子进程（子门禁／工具／Edge／PS）
     ③ 受管面口径（`validateFace` 的宽度分母）**逐字取自** `tests\files-check.js` 第一节：
        `walk(ROOT)` ＋ `TEXT_EXT`（.js/.css/.html/.json/.md/.cmd/.ps1/.txt/.sql）＋
        `SKIP_DIRS`（.git/node_modules/.claude/来源文件/reference/._verify/本地归档）＋ 跳过点目录。
   --------------------------------------------------------------------------
   **口径与边界（读这四条就够复核本表）**：
     ① `dynamic` 的语义＝"**运行时才知道读哪些文件**"，消费方（D3 缓存）对它**一律真跑**。
        凡是能用一个静态条目**保守覆盖**的（例：`readdirSync(需求文档).find(f=>.md)` 取哪一个由
        目录顺序决定 ⇒ 登记**整个目录**），就登记路径而**不**标 dynamic —— 那是安全方向
        （多失效、不会漏失效）。只有"面本身不可静态界定"的才标 dynamic：本轮账本／候选图等
        `._verify\` 运行期产物、argv／env 注入的运行期口径、**经子进程再跑别的门禁**、
        时间／浸泡类（`stress-check`）。
     ② `dynamic` 条目**不参与** badPath 与宽度计算（它没有可枚举的静态面）—— 代价是它换不来缓存
        （fail-closed），故不存在"用 dynamic 换绿"的收益；清单在自检里**逐条打印**供复核。
     ③ 每条 `why` 都写了依据（require 调用点／`fs.readFileSync(<路径>)`／`env.paths.xxx`／
        子进程／readdir 扫描）；**找不到读取点的一律不登记**（凭空登记会被 `phantom` 之外的
        `badPath`／人工复核抓住）。只读**目录项**（如残留扫描、存在性断言）的，按 `dir` 登记并
        在 `why` 里写明"只读目录项"—— 该 kind 的展开面＝整目录，属**保守方向**（宁可多失效）。
     ④ `stress-check` 的时间依赖与 `harness-check` §15-C/D 的调度行为**一律按 `dynamic` 登记**
        （D3 明文"时间依赖判据不可缓存"）—— 它们换不来缓存，这是有意的；argv／env 注入的口径
        同理（换一个 `--page`／`--pkg`，文件面没变而判据变了 ⇒ 不标 dynamic 就会给出**假缓存**）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const env = require('./env');
env.assertRuntime();                          /* tests\files-check.js 第八节：tests\*.js 入口必须自校验 */

const { SUITES } = require('./run-all');      /* 名单**现取**（require 安全：见头部说明） */

const ROOT = env.paths.root;

/* ==========================================================================
   一、受管面（宽度分母）—— 口径与 `tests\files-check.js` 第一节逐字一致
   ========================================================================== */
const MANAGED_TEXT_EXT = new Set(['.js', '.css', '.html', '.json', '.md', '.cmd', '.ps1', '.txt', '.sql']);
const MANAGED_SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', '来源文件', 'reference', '._verify', '本地归档']);

const toPosix = p => String(p).split(path.sep).join('/');

/** 递归收集仓内文件（跳过 SKIP_DIRS 与点目录，**不跟随链接**：用 withFileTypes）。 */
function walkRepoFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (MANAGED_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walkRepoFiles(full, out);
    } else if (e.isFile()) out.push(full);
  }
  return out;
}

let ALL_FILES = null;                          /* 盘上全部（含二进制）—— badPath 的枚举面 */
let SURFACE = null;                            /* 受管文本文件（rel, posix）—— 宽度分母 */
function repoFiles() {
  if (!ALL_FILES) ALL_FILES = walkRepoFiles(ROOT, []);
  return ALL_FILES;
}
function managedSurface() {
  if (!SURFACE) {
    SURFACE = repoFiles()
      .map(abs => ({ abs, rel: toPosix(path.relative(ROOT, abs)) }))
      .filter(f => MANAGED_TEXT_EXT.has(path.extname(f.abs).toLowerCase()));
  }
  return SURFACE;
}

/* ==========================================================================
   二、条目展开（must actually enumerate —— D4 明文"不许只看字符串"）
   ========================================================================== */
/** 退化条目（"登记成整个仓库"的伪装形态）：无条件 tooWide，见 validateFace。 */
const DEGENERATE_RELS = new Set(['.', './', '/', '\\', '**', '**/*', '**/**', '*', '*/*', '/*']);

const file = (rel, why) => ({ rel, why, kind: 'file' });
const dir = (rel, why) => ({ rel, why, kind: 'dir' });
const glob = (rel, why) => ({ rel, why, kind: 'glob' });
const dyn = (rel, why) => ({ rel, why, kind: 'dynamic' });

const RX_ESCAPE = '\\^$.|?+()[]{}';
/** 条目的**路径面**：`dir` 的 `src/**`／`src/*`／`src/` 都归一到目录 `src`（`**` 只写在 `why` 之外
 *  的表达里，不参与盘上拼接）；`glob` 保留通配符；`dynamic` 不解析。 */
function entryTarget(entry) {
  let rel = toPosix(String(entry.rel == null ? '' : entry.rel).replace(/^\.\//, ''));
  if (entry.kind === 'dir') rel = rel.replace(/\/\*+$/, '').replace(/\/+$/, '');
  return rel;
}
/** glob → RegExp：`**\/` ＝ 任意层级（含零层）、裸 `**` ＝ 任意、`*` ＝ 单段任意。 */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:[^/]*/)*'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (RX_ESCAPE.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

/**
 * 展开一个条目（只读文件系统，无副作用）。
 * @returns {{dynamic:boolean, exists:boolean, matched:string[]}} `matched` 是**盘上实存**的
 *          rel 列表（posix）；`exists` 对 dir 是"目录存在"，对 file 是"文件存在"，对 glob 是
 *          "命中 ≥ 1 个文件"。
 */
function expandEntry(entry) {
  const relRaw = toPosix(String(entry.rel || '').replace(/^\.\//, ''));
  if (entry.kind === 'dynamic') return { dynamic: true, exists: true, matched: [] };
  if (DEGENERATE_RELS.has(relRaw)) return { dynamic: false, exists: true, matched: [] };
  const rel = entryTarget(entry);
  const abs = path.join(ROOT, rel);
  if (entry.kind === 'file') {
    let ok = false;
    try { ok = fs.statSync(abs).isFile(); } catch { ok = false; }
    return { dynamic: false, exists: ok, matched: ok ? [rel] : [] };
  }
  if (entry.kind === 'dir') {
    let isDir = false;
    try { isDir = fs.statSync(abs).isDirectory(); } catch { isDir = false; }
    const prefix = rel === '' ? '' : rel.replace(/\/+$/, '') + '/';
    const matched = repoFiles().map(f => toPosix(path.relative(ROOT, f))).filter(r => r.startsWith(prefix));
    return { dynamic: false, exists: isDir, matched };
  }
  if (entry.kind === 'glob') {
    const rx = globToRegExp(rel);
    const matched = repoFiles().map(f => toPosix(path.relative(ROOT, f))).filter(r => rx.test(r));
    return { dynamic: false, exists: matched.length > 0, matched };
  }
  return { dynamic: false, exists: false, matched: [] };   /* 未知 kind ⇒ 视为不存在（fail-closed） */
}

/* ==========================================================================
   三、宽度上限（防"登记成整个仓库"＝等于没登记）
   --------------------------------------------------------------------------
   `WIDTH_RATIO_MAX = 0.5` 的**理由（常量＋理由，不是"恰好现在能过的数"）**：
     一个脚本的输入面若覆盖受管面**半数以上**，则"任何一处改动落在它的输入面里"的概率过半 ⇒
     缓存命中率的上界 ≈ 50%、且随受管面增长只会更低 ⇒ 这条登记**换不来可用的缓存**，
     与"没登记"（`uncached:no-input-face`）在实际效果上同义。取 0.5（＝"多数"的自然下界）
     而不是更小的数：更小会把"读了自己那半边"的正常脚本误判成懒登记（`ADR-0004` D23：
     判据不许制造假红）。**整面**脚本（按设计就读整个受管面）走下面的显式声明，
     不靠调大阈值来"过"。
   ========================================================================== */
const WIDTH_RATIO_MAX = 0.5;

/**
 * **按设计覆盖整个受管面的脚本**（⇒ 缓存对它没有意义，消费方**一律真跑**）。
 *
 * 这不是"放宽 tooWide"，而是把 D4 那句话（"登记成整个仓库＝等于没登记"）的**诚实出口**显式化：
 *   · 它们在盘上的读取面**确实**是受管面的主体（下面的 `why` 逐个给出读取点）；
 *   · `validateFace` **双向自证**这条声明：声明了但实际面**没过半** ⇒ `tooWide`（伪整面声明）；
 *     实际面过半但**没声明** ⇒ `tooWide`（过宽）。两者都指名 ⇒ 这张表只能靠**改代码**扩张，
 *     不能靠"顺手放宽阈值"通过（`ADR-0004` D21/D23）。
 *   · 声明它们的收益是给 D3 缓存的消费方一个**明确结论**："这几个脚本永远别建缓存"，
 *     而不是把它们的面登记成一堆窄条目、看着能缓存而**实际永远失效**。
 */
const SURFACE_WIDE_BY_DESIGN = Object.freeze({
  'files-check': '按设计读**整个受管面**：walk(ROOT) 第一节 ＋ TEXT_EXT（编码损坏／BOM／Tab／'
    + '行尾／中部格式字符等卫生判据都读每个文件的字节）',
  'harness-check': '夹具自检的判据面覆盖 tests\\**、server\\**、src\\**、platform\\**、tools\\**、'
    + 'index.html、三份台账与 tests\\README.md（静态扫描 ＋ 真起服务端），并**再起子进程跑**'
    + '`run-all --only …`（嵌套轮）',
  'docs-check': '文档与规范一致性：PROJECT_RULES.md／tests\\**／需求文档\\**／项目记录台账／'
    + '输出文件\\**（函件与设计说明书）／src\\**／tools\\** 都要逐字读，另起 PowerShell 真跑 md2docx',
  'docs-cross-check': '跨文档 ＋ 权威数字校验：PROJECT_RULES.md／根 README／tests\\README.md／'
    + '需求文档／项目记录（快照·工作日志·路线图·ADR）／src\\**／server\\**／platform\\** 全读，'
    + '并按需**起子进程复跑别的门禁**',
  'trace-check': '需求追溯：需求文档正文逐节解析 ＋ 证据可核实性**逐脚本读 tests\\*.js 源码**，'
    + '另有对 src／server／platform／index.html／README／项目记录／tools\\mock-* 的登记路径断言',
});

/* ==========================================================================
   四、登记表本体（25 个脚本；`why` 即依据）
   --------------------------------------------------------------------------
   写法约定：`dir('src/**')` 表示"该目录下**全部**文件"（对缓存是保守方向）；仓内路径一律
   posix 风格（`/`）；`dynamic` 见头部口径①。
   ========================================================================== */
const WHY_ENV = "require('./env')：运行时下限与致命路径常量的真源";
const WHY_ASSERT = "require('./lib/assert.js')：断言运行器 createRunner（本脚本的输出契约由它给）";
const WHY_HARNESS_LIB = "require('./lib/harness.js')：夹具／临时区／服务启停（它自身 require('../env')）";
const WHY_FS_SURFACE = 'walk(ROOT)（files-check.js 第一节：TEXT_EXT ＋ SKIP_DIRS）：本脚本按设计读**整个受管面**的字节';
const WHY_README_TESTS = "readText('tests/README.md')：权威区／登记表比对（tests\\*.js 名单）";
const WHY_RUN_ALL = "require('./run-all')：SUITES／REGISTERED_DEVIATIONS／verifyAuthorityTotals 的真源";

const FACE = {
  /* ---- 离线门禁（13 条） ---- */
  'contract-check': [
    dir('server/**', 'require 闭包：server/services/{stats,shift,uploadQueue}.js、server/http/router.js、'
      + 'server/http/routes/upload.js、server/db/index.js…；另有 vm.runInThisContext(fs.readFileSync(…)) 读源码'),
    dir('platform/**', 'server/** 与 vm 沙箱的传递 require：platform/clock.js、platform/paths.js、platform/id.js'),
    dir('src/**', "readText('src/services/api.js'／'src/main.js'／'src/services/stateAdapter.js'…) ＋ "
      + "walkFiles(src, '.js'|'.css') 的常量集中化与色值扫描"),
    file('tests/env.js', WHY_ENV),
    file('tests/lib/harness.js', WHY_HARNESS_LIB),
    file('tests/browser-check.js', "readText('tests/browser-check.js')：与 browser-check 的静态面比对"),
    file('tools/mock-upper/mock-upper.js', 'readText ＋ execFileSync 真跑（--once）＋ 回读校验字节未变'),
    file('tools/mock-mes/mock-mes.js', 'execFileSync 起 mock MES（真端口、真收帧）'),
    dir('需求文档/**', 'readdirSync(需求文档) 取当前基线 .md 并解析 —— **取哪一个由目录顺序决定**，'
      + '故按整目录登记（保守方向，不标 dynamic）'),
    glob('输出文件/**/*.docx', "walkFiles(输出文件, '.docx')：逐份对外 Word 比对「依据文件」版本；"
      + '份数随交付目录变化（**只读 .docx** —— 该目录下的 .md 不在它的面里，故用 glob 而不是整目录）'),
  ],
  'ui-check': [
    file('index.html', "readText('index.html')：静态 DOM／脚本注册／文案条款逐条对照（多次调用）"),
    dir('src/**', "readText('src/styles/{global,variables}.css'、'src/components/SettingPanel.js'、"
      + "'src/main.js'、'src/pages/Dashboard.js'、'src/services/mockData.js'…) ＋ 递归遍历 src（前端脚本清单）"),
    file('tests/env.js', WHY_ENV),
  ],
  'tools-check': [
    dir('tools/**', "TEXTS＝tools/md2docx.ps1 ＋ tools/md2docx-img.ps1（读字节 ＋ 起 PowerShell 真跑），"
      + "readText('tools/mock-upper/mock-upper.js')，tools/mock-mes/mock-mes.js（真起进程），"
      + '残留白名单扫描 readdirSync(tools)'),
    dir('src/**', "readText('src/config/fieldMap.js'／'src/components/DeviceStatusPanel.js'／"
      + "'src/services/mockUpperSource.js')：工具与前端契约同源"),
    dir('需求文档/**', 'REQ_DIR：取当前基线 .md 解析 FR-2.5（同上，取哪一个由目录顺序决定）'),
    dir('输出文件/**', '残留扫描面之一（readdirSync，**只读目录项**不读内容）：工具真跑后不得留残留'
      + '（按整目录登记＝保守方向）'),
    file('tests/env.js', WHY_ENV),
  ],
  'docs-check': [
    file('PROJECT_RULES.md', "readText('PROJECT_RULES.md')：版本号／6.1-6.2 类型表／9.1 登记项"),
    dir('tests/**', "readdirSync(tests) 取 .js 名单并**逐个读源码**（开关清单）＋ readText('tests/README.md')"
      + '（权威区数字）＋ ' + WHY_RUN_ALL),
    file('index.html', "readText('index.html')：界面与文档条款对照"),
    dir('src/**', "walk(src) 的 Tab／外部依赖扫描 ＋ readText('src/config/fieldMap.js'／"
      + "'src/pages/Dashboard.js'／'src/services/mockData.js')，另列 src/assets/screenshots/*.png 名单"),
    dir('tools/**', "walk(tools) 的 Tab／外部依赖扫描 ＋ readText('tools/Markdown转Word工具说明.md'／"
      + 'tools/mock-upper/mock-upper.js／tools/mock-mes/mock-mes.js)；tools/md2docx*.ps1 由 PowerShell 真跑'),
    dir('需求文档/**', 'readdirSync 取 .md 基线（版本号／第 14 章表述）＋ .docx 名单'),
    dir('项目记录/**', "readText('项目记录/当前状态快照.md')／'项目记录/工作日志.md'：台账与仓库现状一致性"
      + '（**只点名读了这两份**；按整目录登记＝保守方向，其余条目宁可多失效）'),
    dir('输出文件/**', "readText('输出文件/甲方/…前端界面Demo说明.md'／'…系统设计说明书-V1.0.md'／"
      + "'输出文件/上位机方/接口需求函-致设备上位机方.md') ＋ extBase 目录取「各收件方最新函件」"),
    dyn('tests/._verify/**（md2docx 真跑日志与临时产物）', '起 PowerShell（execFileSync）真跑 md2docx，'
      + '日志／临时 docx 落在 ._verify\\ 下、内容运行时才知道 ⇒ 不静态登记；D3 缓存对它必须真跑'),
    dyn('git 提交历史（execFileSync git log）', 'D2 段的提交信息判据读**提交历史**（不是受管文件）'
      + '⇒ 无法用文件面表达；`run-all` 同族判据已有"无 git ⇒ 不判"的口径'),
  ],
  'files-check': [
    dir('src/**', WHY_FS_SURFACE),
    dir('server/**', WHY_FS_SURFACE),
    dir('platform/**', WHY_FS_SURFACE),
    dir('tests/**', WHY_FS_SURFACE + '；含 tests/screenshots-baseline/**（基准目录条目也在受管面内）'),
    dir('tools/**', WHY_FS_SURFACE),
    dir('项目记录/**', WHY_FS_SURFACE + '；其中 项目记录\\ADR\\*.md 另有"必须纯 CRLF"的专项判据'),
    dir('输出文件/**', WHY_FS_SURFACE),
    dir('需求文档/**', WHY_FS_SURFACE),
    file('index.html', WHY_FS_SURFACE),
    file('README.md', WHY_FS_SURFACE),
    file('PROJECT_RULES.md', WHY_FS_SURFACE + '；另单独读它做规范文本比对'),
    file('项目架构与技术栈.md', WHY_FS_SURFACE),
    file('项目协作与权限说明.md', WHY_FS_SURFACE),
  ],
  'harness-check': [
    dir('tests/**', "静态扫描 tests\\**\\*.js（本门禁自身 ＋ 各脚本的形态判据）＋ 夹具层 "
      + 'tests/lib/{assert,clock,fixture,harness,snapshot}.js 的 require ＋ tests/README.md 权威数字'
      + '＋ tests/screenshots-baseline/**（基准目录条目逐条 sha256）'),
    dir('server/**', 'require（server/index.js 起真服务端、db/、repo/、services/、http/）＋ 逐文件静态扫描'),
    dir('src/**', 'require／vm 读 src/config/{board.config,fieldMap}.js ＋ 静态扫描 src/components、src/services'),
    dir('platform/**', 'platform/{paths,log,clock,id}.js：经 server/** 传递 require ＋ 静态扫描'),
    dir('tools/**', 'tools/mock-upper/mock-upper.js、tools/mock-mes/mock-mes.js（真起进程）＋ tools\\**\\*.js 静态扫描'),
    file('index.html', 'readFileSync(index.html)：前端注册面与静态 DOM 判据'),
    file('README.md', '根 README 的声明与实现一致性'),
    file('PROJECT_RULES.md', '规范条款（受管文档写点守护清单也在内）'),
    file('tests/README.md', WHY_README_TESTS + '（权威数字比对）'),
    file('项目记录/当前状态快照.md', 'E104/E183：台账结构不变量与「当前开口」块渲染判据'),
    file('项目记录/后续路线图.md', 'E164 四份台账之一（结构不变量）＋ 债行一致性'),
    file('项目记录/工作日志.md', 'E164 四份台账之一（结构不变量；只在清单里，不参与写点守护）'),
    dyn('tests/._verify/**（本轮账本／日志／S15 子集账／w5-w7 临时目录）', '§15 会**起子进程跑**'
      + '`run-all --only …` 并回读本轮 `run-totals*.json`；这些账本由本轮运行时生成 ⇒ 不可静态登记'),
    dyn('argv／DSH_HARNESS_S15_FULL／DSH_JOBS 等开关', '§15-C/D 的判定档与子轮清单由 argv／env 决定'
      + '（D3 明文：调度行为永不缓存）'),
  ],
  'logic-check': [
    dir('server/**', 'require 闭包：services/{shift,stats,judge,standard,stateSnapshot}.js、'
      + 'repo/{shiftStat,notice,opLog,result,measure}.js、db/index.js；另有 walk(server) 与 '
      + 'readFileSync(server/index.js)／server/services/stats.js 的源码级断言'),
    dir('src/**', 'src/services/mockData.js（沙箱源码）＋ src/config/board.config.js（require）：当班统计的配置真源'),
    dir('platform/**', 'platform/clock.js（require）：班次边界与时钟推进'),
    file('tests/env.js', WHY_ENV),
    file('tests/lib/assert.js', WHY_ASSERT),
    file('tests/lib/clock.js', "require('./lib/clock.js')：createClock／BOUNDARIES 的时间真源"),
  ],
  'db-check': [
    dir('server/**', 'require 闭包：db/{index,maintain}.js、repo/{measure,curve,standard,opLog,uploadQueue}.js、'
      + 'services/{standard,eventBus,ingest,dispatch,uploadReporter}.js、http/{router.js,routes/*}；'
      + '另有 readFileSync(server/db/schema.sql／server/db/index.js／server/repo/uploadQueue.js) 的字节不变断言'),
    dir('platform/**', 'platform/{paths,clock,id}.js：经 server/** 传递 require'),
    file('src/config/board.config.js', 'require：库结构与仓储层的配置真源'),
    file('tests/env.js', WHY_ENV),
    file('tests/lib/assert.js', WHY_ASSERT),
    file('tests/lib/harness.js', WHY_HARNESS_LIB + '：makeTempDb／makeTempDir／allocPort'),
    file('tests/lib/clock.js', "require('./lib/clock.js')：createClock"),
    file('tests/lib/fixture.js', "require('./lib/fixture.js')：样本数据（ADR-0010 D4 的例子点名的输入之一）"),
    file('tests/db-check.js', 'readFileSync(selfPath)：本脚本读**自身字节**做"未被写坏"的自证'),
  ],
  'platform-check': [
    dir('platform/**', "require：platform/id.js、platform/log.js；vm.runInContext(readFileSync(platform/paths.js))："
      + '平台适配层（路径／ID／日志）是被测对象本身'),
    file('PROJECT_RULES.md', '存在性断言：ROOT 必须指向真正的仓库根'),
    file('index.html', '存在性断言：ROOT 必须指向真正的仓库根'),
    dir('tests/**', '存在性断言：ROOT 必须指向真正的仓库根（**只读目录项**，不读内容）'),
    file('tests/env.js', WHY_ENV + '；ds-harness 的临时区语义断言也读它'),
    file('tests/lib/assert.js', WHY_ASSERT),
  ],
  'trace-check': [
    dir('需求文档/**', 'readdirSync(需求文档) 取当前基线 .md，逐节解析条款合计与 §0.2／第 10 章交付物表'
      + '（多处调用；取哪一个由目录顺序决定）'),
    dir('tests/**', '证据可核实性：**逐脚本读 tests\\*.js 源码**（脚本存在 ＋ 证据文本确实在该脚本里），'
      + '含 tests/stress-check.js 与 tests/README.md；另读 tests/trace-check.js 自身（自锚点）'),
    dir('src/**', '交付物登记表的存在性断言（**只读目录项**，按整目录登记＝保守方向）'),
    dir('server/**', '同上（交付物登记表的存在性断言）'),
    dir('platform/**', '同上（交付物登记表的存在性断言）'),
    dir('项目记录/**', 'DELIVERY_LEDGER／AC_MAP 里登记的审查报告与 ADR 路径：存在性断言 ＋ 引用一致性'),
    dir('tools/**', 'DELIVERY_LEDGER 里登记的 tools/mock-upper/README.md 与 tools/mock-mes/README.md'
      + '（存在性断言；按整目录登记＝保守方向）'),
    file('index.html', '交付物登记表的存在性断言'),
    file('README.md', '交付物登记表的存在性断言'),
    file('项目架构与技术栈.md', '交付物登记表的存在性断言'),
    file('tests/env.js', WHY_ENV),
    file('tests/lib/assert.js', WHY_ASSERT),
  ],
  'copy-check': [
    file('index.html', 'MAP 的 files 并集：逐条把需求条款的文案在界面真源里逐字核对'),
    file('src/components/DeviceStatusPanel.js', 'MAP.files（FR-2.1／FR-2.6 等条款的文案面）'),
    file('src/components/TaskPanel.js', 'MAP.files（任务与工单类条款的文案面）'),
    file('src/components/NoticePanel.js', 'MAP.files（公告类条款的文案面）'),
    file('src/components/SettingPanel.js', 'MAP.files（设置／口令类条款的文案面）'),
    file('src/config/board.config.js', 'MAP.files（配置类条款的文案面）'),
    file('src/config/fieldMap.js', 'MAP.files（运行模式／联网状态等枚举名）'),
    file('src/pages/Dashboard.js', 'MAP.files（页面级文案）'),
    file('src/services/auth.js', 'MAP.files（口令与鉴权文案）'),
    file('src/services/mockData.js', 'MAP.files（演示数据的文案面）'),
    file('src/services/mockUpperSource.js', 'MAP.files（运行阶段枚举名）'),
    file('tests/env.js', WHY_ENV),
  ],
  'screenshot-diff': [
    file('index.html', 'renderSources()：参与渲染的源码（脚本注册真源＋静态 DOM），候选图新鲜度也按它判'),
    dir('src/**', "renderSources()：src\\**\\*.js 与 src\\**\\*.css（无打包器 ⇒ 页面加载的就是这些文件）"),
    glob('tests/screenshots-baseline/**/*.png', '基准图目录（env.paths.baseline）：逐图与候选图比对'),
    file('tests/env.js', WHY_ENV),
    dyn('tests/._verify/captures/**（候选图目录，可被 --candidate 覆盖）', '候选 PNG 由 `capture-baseline`'
      + '（`run-all` 的前置刷新）在**运行时**生成，且是"上一次手工/前置捕获"的产物 ⇒ 内容与张数'
      + '不可静态登记；它决定本脚本读数 ⇒ 消费方**不得缓存 screenshot-diff**（E91/E92）'),
    dyn('argv（--candidate／--baseline／--tolerance ／--self）', '比对口径与目录由命令行决定 ⇒ 面随 argv 变'),
  ],
  'offline-check': [
    dir('输出文件/离线部署与体检包-V1.4/**', "PKG_ROOT（DSH_OFFLINE_PKG 可覆盖）：包内 README／清单／"
      + '外链扫描 ＋ 逐文件 sha256 快照与还原（.cmd／.ps1／.md／便携 Node 名单）'),
    file('tests/contract-check.js', 'readFileSync：核对包内工具与仓内契约同源'),
    file('tools/mock-mes/mock-mes.js', '起真进程做端口冲突实测（EADDRINUSE 退码与提示）'),
    file('tests/env.js', WHY_ENV),
    file('tests/lib/assert.js', WHY_ASSERT),
    dyn('输出文件/离线部署与体检包-V1.4/**（作为 --pkg／DSH_OFFLINE_PKG 的**运行期**取值）',
      '包目录与包内容随交付批次变化（且 D22 段会**在包内改写后还原**）⇒ 具体文件集不可静态界定'),
    dyn('argv／DSH_OFFLINE_PKG／DSH_OFFLINE_PROBE_PORT／DSH_OFFLINE_DEBUG', '包路径与实测端口由 env／argv 注入'),
  ],
  'docs-cross-check': [
    file('PROJECT_RULES.md', "read('PROJECT_RULES.md')：规范版本与登记项一致性"),
    file('README.md', "read('README.md')：组件声明数与「双击可打开」等口径"),
    file('tests/README.md', "read(README_REL)：权威区逐脚本数字 ＋ 脚本表（DSH_DC_README_OVERRIDE 只为调试）"),
    file('index.html', "read('index.html')：组件注册条数（与 README 声明的三方不变量）"),
    file('项目架构与技术栈.md', "read('项目架构与技术栈.md')：当前值区／声明版本"),
    dir('tests/**', "readdirSync(tests) 的 .js 计数 ＋ readText('tests/lib/*.js')（时钟单一真源）＋ "
      + '按名单核对各门禁脚本是否存在；另起子进程复跑别的门禁（见 dynamic）'),
    dir('项目记录/**', "read('项目记录/当前状态快照.md'／'工作日志.md'／'后续路线图.md'／'ADR/ADR-000{1,2,3}…'"
      + "／'ADR/README.md')：台账与规范／需求的版本一致性（按整目录登记＝保守方向：其余 ADR／审查报告未必被读）"),
    dir('需求文档/**', 'reqFile（当前基线 .md）：需求版本与交付物口径'),
    dir('src/**', 'walkJs／readdirSync(src/components)：前端组件数与静态扫描面'),
    dir('server/**', 'walkJs(server)：ADR-0002 D11「平台字样收敛在 platform\\」的静态扫描面'),
    dir('platform/**', 'walkJs(platform)：同上的白名单面（这一层**允许**出现平台字样）'),
    dyn('tests/._verify/run-totals.json（本轮实跑账）', '由 `run-all` **本轮**写入（每个脚本跑完更新一次）'
      + '⇒ 内容运行时才知道；第十一节按它比对权威数字（缺／过期时走"前提不成立"并退化实跑）'),
    dyn('tests/._verify/browser-authority-trail.json（E155 留痕）', '上一轮运行的留痕文件（本轮首跑可能不存在）'),
    dyn('起子进程复跑别的门禁（spawnSync node tests/<脚本>.js）', 'D20 退化路径会**再跑一遍**离线门禁 ⇒ '
      + '实际读到的面随那一轮的子进程而变，不可静态界定'),
    dyn('DSH_DC_{README,SNAP,ARCH,ROAD}_OVERRIDE 等读数重定向', '调试出口可把读数面指到别处（不设时是盘上真文件）'),
  ],
  'browser-check': [
    file('index.html', 'PAGE：无头 Edge 真加载的页面真源（file:// 与同源托管两档）'),
    dir('src/**', '页面加载的前端脚本／样式（含 vm 读 src/config/fieldMap.js 取 samplePayload）'),
    dir('server/**', 'B5e 起**真服务端**（node server/index.js）：同源托管页与 /health 读数'),
    dir('platform/**', '经 server/** 传递 require（paths／log／clock／id）'),
    file('tests/env.js', WHY_ENV),
    file('tests/lib/harness.js', WHY_HARNESS_LIB + '：makeTempDir／服务启停（延迟加载）'),
    dyn('Edge 可执行体（MSEDGE_PATH／EDGE_CANDIDATES）与 DSH_EDGE_PORT', '浏览器与调试端口来自环境'
      + '（不是受管文件）；Edge 是外部依赖 ⇒ 不可静态登记'),
  ],
  'overlap-check': [
    file('index.html', 'PAGE（--page 可注入）：元素重叠检测的页面真源'),
    dir('src/**', '页面加载的前端脚本与样式（重叠判据的渲染面）'),
    file('tests/overlap-whitelist.json', 'WHITELIST（--whitelist 可注入）：允许的重叠名单（判据的输入之一）'),
    file('tests/env.js', WHY_ENV),
    dyn('argv（--page／--whitelist／--out）与 MSEDGE_PATH／DSH_OVERLAP_PORT', '页面／白名单路径与浏览器'
      + '端口可由命令行和环境决定 ⇒ 面随 argv 变（默认值即上面登记的仓内文件）'),
  ],
  'stress-check': [
    file('index.html', 'PAGE：长跑页面真源（无头 Edge 真加载并持续驱动）'),
    dir('src/**', '页面加载的前端脚本与样式（长跑期间被反复渲染）'),
    file('tests/env.js', WHY_ENV),
    dyn('argv（--hours／--minutes／--day-seconds／--interval-min／--soak-ledger／--verify-soak）',
      '跑法与浸泡时长由命令行决定 ⇒ 时间依赖判据（ADR-0010 D3 明文：**永不缓存**）'),
    dyn('tests/._verify/**（浸泡台账 .jsonl、截图与日志）', '台账由本轮长跑**边跑边追加**，内容运行时才知道'),
    dyn('本脚本自身字节（sha256 写进台账）与 Edge 可执行体', '台账记 scriptSha256 以自证"哪一版脚本跑的"；'
      + 'Edge／MSEDGE_PATH 是外部依赖'),
  ],
  /* 8 支“自证探针”（座位 4b；2026-10-19 起前 5 支从 `tools\` 收编进 `run-all`）：它们只读**被测服务端的接入口径**
     （require 闭包：db／services／http 路由）＋ 测试夹具，不读 `src\**`／文档 ⇒ 面与 `db-check` 同族、可缓存。
     第 6 支 `mes-client-probe`（2026-10-20）只读 `server/services/mesClient.js`（零 require）＋ `tests/env.js`。
     第 7 支 `mes-oee-payload-probe`（2026-10-21，`S_ME_MG_0006` 收编）只读 `server/services/mesOeePayload.js`（零 require）＋ `tests/env.js`。
     第 8 支 `camera-depth-agg-probe`（2026-10-21，`cameraDepth` 18→1 整合收编）只读 `server/services/cameraDepthAgg.js`（零 require）＋ `tests/env.js`。 */
  'order-inject-probe': [
    dir('server/**', 'require 闭包：server/db/index.js、services/{ingest,orderResolver}.js、http/routes/ifD.js、http/router.js'),
    dir('platform/**', 'server/** 的传递 require：platform/{paths,log,clock,id}.js'),
    file('tests/env.js', WHY_ENV),
    file('tests/lib/harness.js', WHY_HARNESS_LIB + '：makeTempDb（一用例一库）'),
  ],
  'unit-index-probe': [
    dir('server/**', 'require 闭包：server/db/index.js、services/{ingest,unitIndexInfer}.js、http/routes/ifD.js、http/router.js'),
    dir('platform/**', 'server/** 的传递 require：platform/{paths,log,clock,id}.js'),
    file('tests/env.js', WHY_ENV),
    file('tests/lib/harness.js', WHY_HARNESS_LIB + '：makeTempDb（一用例一库）'),
  ],
  'missing-value-probe': [
    dir('server/**', 'require 闭包：server/db/index.js、services/{ingest,missingValue}.js、http/routes/ifD.js、http/router.js'),
    dir('platform/**', 'server/** 的传递 require：platform/{paths,log,clock,id}.js'),
    file('tests/env.js', WHY_ENV),
    file('tests/lib/harness.js', WHY_HARNESS_LIB + '：makeTempDb（一用例一库）'),
  ],
  'endpoint-link-probe': [
    dir('server/**', 'require 闭包：server/db/index.js、services/{endpointLink,ingest}.js、http/routes/ifD.js、http/router.js'),
    dir('platform/**', 'server/** 的传递 require：platform/{paths,log,clock,id}.js'),
    file('tests/env.js', WHY_ENV),
    file('tests/lib/harness.js', WHY_HARNESS_LIB + '：makeTempDb（一用例一库）'),
  ],
  'p02-endpoint-dedup-probe': [
    dir('server/**', 'require 闭包：server/db/index.js（migrateMeasureRtEndpoint）、services/ingest.js、http/routes/ifD.js、http/router.js'),
    dir('platform/**', 'server/** 的传递 require：platform/{paths,log,clock,id}.js'),
    file('tests/env.js', WHY_ENV),
    file('tests/lib/harness.js', WHY_HARNESS_LIB + '：makeTempDb（一用例一库）'),
  ],
  /* 第 6 支（2026-10-20，A4 收编）：**只读传输层自身 ＋ 测试环境常量** —— `server/services/mesClient.js`
     零 `require`（纯函数 ＋ 全局 `fetch`／可注入 `fetchImpl`），故没有 `server/**`／`platform/**` 传递闭包。 */
  'mes-client-probe': [
    file('server/services/mesClient.js', '被测对象：MES 接口传输层（URL 模板／形态归一／不可识别判失败／超时）'),
    file('tests/env.js', WHY_ENV),
  ],
  /* 第 7 支（2026-10-21，`S_ME_MG_0006` 收编）：**只读载荷构造纯函数 ＋ 测试环境常量** ——
     `server/services/mesOeePayload.js` 零 `require`（纯函数；不读库、不取时间），故没有 `server/**`／`platform/**` 传递闭包。 */
  'mes-oee-payload-probe': [
    file('server/services/mesOeePayload.js', '被测对象：`S_ME_MG_0006` OEE 载荷构造（perfRate 三策略／statsDate 两形态／状态→时长映射；零 require）'),
    file('tests/env.js', WHY_ENV),
  ],
  /* 第 8 支（2026-10-21，`cameraDepth` 18→1 整合收编）：**只读聚合纯函数 ＋ 测试环境常量** ——
     `server/services/cameraDepthAgg.js` 零 `require`（纯函数；不读库、不取时间），故没有 `server/**`／`platform/**` 传递闭包。 */
  'camera-depth-agg-probe': [
    file('server/services/cameraDepthAgg.js', '被测对象：`cameraDepth` 18→1 整合（有效值平均／哨兵与空值排除／分母＝有效台数／全无效→null／`0` 有效；零 require）'),
    file('tests/env.js', WHY_ENV),
  ],
};

/* ==========================================================================
   五、对外接口
   ========================================================================== */

/** 取某脚本的输入面。**未登记 ⇒ null（不抛错）** —— 交消费方按 fail-closed 处理（`uncached:no-input-face`）。 */
function faceOf(name) {
  const key = String(name == null ? '' : name).replace(/\.js$/, '');
  return Object.prototype.hasOwnProperty.call(FACE, key) ? FACE[key] : null;
}

/** 全部脚本名（现取自 SUITES，不写死）。 */
function suiteNames() {
  return SUITES.map(s => s.name);
}

/**
 * 校验一张输入面登记表（默认＝本文件的 `FACE`）。
 *
 * **只读文件系统、无副作用**；"纯函数"按"无副作用 ＋ 同一盘面给同一结果"读 ——
 * `badPath` 必须**真枚举**（D4 明文"不许只看字符串"），所以它必然碰盘。
 *
 * @param {Object<string, Array<{rel:string, why:string, kind:string}>>} [face]
 * @returns {{missing:string[], phantom:string[], badPath:string[], tooWide:string[]}}
 *   · `missing`：SUITES 里有、表里没有的脚本（新增脚本忘了登记）；
 *   · `phantom`：表里有、SUITES 里没有的键（凭空登记／脚本已退役）；
 *   · `badPath`：登记项在盘上**既不存在也不匹配任何文件**（dir／glob 实际枚举后仍为 0 命中）；
 *   · `tooWide`：退化条目（仓库根 `.`／裸 `**`）、单脚本输入面覆盖受管面**半数以上**（未声明整面）、
 *     以及**伪整面声明**（`SURFACE_WIDE_BY_DESIGN` 里的脚本实际面没过半）。
 */
function validateFace(face) {
  const table = face || FACE;
  const names = suiteNames();
  const keys = Object.keys(table);
  const missing = names.filter(n => !keys.includes(n));
  const phantom = keys.filter(k => !names.includes(k));
  const badPath = [];
  const tooWide = [];
  const surface = managedSurface();
  const surfaceRels = new Set(surface.map(f => f.rel));
  const limit = surface.length * WIDTH_RATIO_MAX;

  for (const name of keys) {
    const entries = Array.isArray(table[name]) ? table[name] : [];
    const covered = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') { badPath.push(`${name}：条目不是对象`); continue; }
      const rel = toPosix(String(entry.rel == null ? '' : entry.rel).replace(/^\.\//, ''));
      if (!String(entry.why || '').trim()) badPath.push(`${name}：条目 ${rel || '(空)'} 缺 why（依据）`);
      if (!['file', 'dir', 'glob', 'dynamic'].includes(entry.kind)) {
        badPath.push(`${name}：条目 ${rel || '(空)'} 的 kind 非法（${String(entry.kind)}）`);
        continue;
      }
      if (DEGENERATE_RELS.has(rel)) {
        tooWide.push(`${name}：条目 ${JSON.stringify(rel)} 是退化宽条目（仓库根／裸 ** ＝等于没登记）`);
        continue;
      }
      const ex = expandEntry(entry);
      if (ex.dynamic) continue;                        /* dynamic：无静态面 ⇒ 不查 badPath／不计宽度（口径②） */
      if (!ex.exists || ex.matched.length === 0) {
        badPath.push(`${name}：${entry.kind} 「${rel}」在盘上${ex.exists ? '存在但匹配不到任何文件' : '不存在'}`);
        continue;
      }
      for (const m of ex.matched) if (surfaceRels.has(m)) covered.add(m);
    }
    const isWideByDesign = Object.prototype.hasOwnProperty.call(SURFACE_WIDE_BY_DESIGN, name);
    if (covered.size > limit && !isWideByDesign) {
      tooWide.push(`${name}：输入面展开到 ${covered.size}/${surface.length} 个受管文件`
        + `（${(covered.size / surface.length * 100).toFixed(1)}% > ${WIDTH_RATIO_MAX * 100}%）`
        + ' ⇒ 缓存换不来命中，应缩窄或按"整面"显式声明（SURFACE_WIDE_BY_DESIGN ＋ 理由）');
    }
    if (isWideByDesign && covered.size <= limit) {
      tooWide.push(`${name}：已声明为"按设计整面"（SURFACE_WIDE_BY_DESIGN），但实际输入面只有 `
        + `${covered.size}/${surface.length} 个受管文件（≤ ${WIDTH_RATIO_MAX * 100}%）—— 伪整面声明，`
        + '请缩小声明或补全面');
    }
  }
  return { missing, phantom, badPath, tooWide };
}

/** 逐脚本读数（自检与 4b 的门禁共用同一份算路，不另写第二份）。 */
function faceStats(face) {
  const table = face || FACE;
  const surface = managedSurface();
  const surfaceRels = new Set(surface.map(f => f.rel));
  return Object.keys(table).map(name => {
    const entries = Array.isArray(table[name]) ? table[name] : [];
    const covered = new Set();
    let dynamic = 0;
    for (const entry of entries) {
      if (!entry) continue;
      if (entry.kind === 'dynamic') { dynamic++; continue; }
      const rel = toPosix(String(entry.rel == null ? '' : entry.rel).replace(/^\.\//, ''));
      if (DEGENERATE_RELS.has(rel)) continue;
      const ex = expandEntry(entry);
      for (const m of ex.matched) if (surfaceRels.has(m)) covered.add(m);
    }
    return {
      name, points: entries.length, dynamic, width: covered.size,
      ratio: surface.length ? covered.size / surface.length : 0,
    };
  });
}

/**
 * `--self-test` 的**唯一实现**（只读、不写盘）。返回结构化结果 ＋ 待打印行；
 * CLI 只负责打印与给退出码（`ok === false` ⇒ 退 1，并已在 `lines` 里逐条指名）。
 */
function SELF_TEST() {
  const surface = managedSurface();
  const names = suiteNames();
  const registered = names.filter(n => faceOf(n) !== null);
  const v = validateFace(FACE);
  const stats = faceStats(FACE);
  const dynamicEntries = [];
  for (const name of Object.keys(FACE)) {
    for (const e of FACE[name]) if (e.kind === 'dynamic') dynamicEntries.push({ script: name, rel: e.rel, why: e.why });
  }
  const ok = v.missing.length === 0 && v.phantom.length === 0 && v.badPath.length === 0 && v.tooWide.length === 0;
  const lines = [];
  const orNone = arr => (arr.length ? arr : ['（无）']);

  lines.push('=== 输入面登记表自检（tests\\input-face.js --self-test；只读，不写盘） ===');
  lines.push(`依据：ADR-0010 D4（登记表是唯一真源）／ADR-0011 D4（D3 先行：本件只做登记表）`);
  lines.push(`SUITES 脚本数：${names.length}    已登记脚本数：${registered.length}`);
  lines.push(`受管面文本文件总数：${surface.length}（口径＝tests\\files-check.js 第一节 walk ＋ TEXT_EXT ＋ SKIP_DIRS）`);
  lines.push(`宽度上限：WIDTH_RATIO_MAX = ${WIDTH_RATIO_MAX} ⇒ 单脚本输入面展开后 > `
    + `${Math.floor(surface.length * WIDTH_RATIO_MAX)} 个受管文件即判 tooWide（"按设计整面"者见下）`);
  lines.push(`按设计整面（SURFACE_WIDE_BY_DESIGN；缓存对它无意义 ⇒ 消费方一律真跑）：`);
  for (const [n, why] of Object.entries(SURFACE_WIDE_BY_DESIGN)) lines.push(`  · ${n} —— ${why}`);
  lines.push('');
  lines.push('逐脚本输入面（条目数／展开后受管文件数／其中 dynamic 条目数）：');
  for (const s of stats) {
    const pct = (s.ratio * 100).toFixed(1) + '%';
    lines.push(`  ${s.name.padEnd(20)} 条目 ${String(s.points).padStart(2)}   受管文件 ${String(s.width).padStart(3)}（${pct.padStart(5)}）   dynamic ${s.dynamic}`);
  }
  lines.push('');
  lines.push('validateFace 四类结果（应全空）：');
  lines.push(`  missing（SUITES 有、表里没有，${v.missing.length}）：${orNone(v.missing).join('、')}`);
  lines.push(`  phantom（表里有、SUITES 没有，${v.phantom.length}）：${orNone(v.phantom).join('、')}`);
  lines.push(`  badPath（盘上既不存在也不匹配任何文件，${v.badPath.length}）：`);
  for (const x of orNone(v.badPath)) lines.push(`    ${x}`);
  lines.push(`  tooWide（宽度超限／退化条目／伪整面声明，${v.tooWide.length}）：`);
  for (const x of orNone(v.tooWide)) lines.push(`    ${x}`);
  lines.push('');
  lines.push(`dynamic 条目清单（${dynamicEntries.length} 条 —— 运行时才知道读哪些文件 ⇒ 消费方一律真跑）：`);
  for (const d of dynamicEntries) lines.push(`  · ${d.script}  ${d.rel}\n      ← ${d.why}`);
  lines.push('');
  lines.push(ok ? '结论：四类全空 ⇒ 退 0（登记表与 SUITES／盘面一致）'
    : `结论：有 ${v.missing.length + v.phantom.length + v.badPath.length + v.tooWide.length} 条问题（逐条见上，已指名）⇒ 退 1`);
  return {
    ok, lines, surfaceTotal: surface.length, widthLimit: surface.length * WIDTH_RATIO_MAX,
    suites: names, registered, stats, dynamicEntries, validation: v,
    missing: v.missing, phantom: v.phantom, badPath: v.badPath, tooWide: v.tooWide,
  };
}

const USAGE = [
  '用法：node tests\\input-face.js --self-test   只读自检（打印名单／条目数／validateFace 四类／dynamic 清单）',
  '      （本文件是 ADR-0010 D4 的输入面登记表；被 require 时导出 FACE／faceOf／validateFace／SELF_TEST 等）',
].join('\n');

/* ==========================================================================
   六、入口（与 `tests\files-check.js`／`tests\docs-cross-check.js` **同形**收口）
   --------------------------------------------------------------------------
   形态选择（`harness-check` 第十六节的口径）：**sync** 入口 ⇒ 顶层 `try`/`catch` ＋ 异常退 2；
   async 入口 ⇒ 必须 `main().catch(`。本件选 sync：自检全程是同步的读盘比对（无 await），
   写成 async 反而会落进"对 async 用顶层同步 try"的靶子形态。
   `require.main === module` 守卫**必须保留**（`E193` 的另一半）：`tests\harness-check.js`
   第三十一节用 `require('./input-face')` 直接对登记表做九支 D22 定点变异 —— 没有守卫，
   require 一下就会把自检打出来、并改掉调用方的退出码。
   ========================================================================== */
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    const r = SELF_TEST();
    process.stdout.write(r.lines.join('\n') + '\n');
    process.exitCode = r.ok ? env.EXIT_PASS : env.EXIT_FAIL;
    return;
  }
  if (argv.includes('--json')) {
    const r = SELF_TEST();
    process.stdout.write(JSON.stringify({ ok: r.ok, validation: r.validation, stats: r.stats,
      surfaceTotal: r.surfaceTotal, registered: r.registered }, null, 2) + '\n');
    process.exitCode = r.ok ? env.EXIT_PASS : env.EXIT_FAIL;
    return;
  }
  process.stdout.write(USAGE + '\n');
  process.exitCode = env.EXIT_ERROR;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('\n[脚本异常] 脚本异常终止：' + (err && err.stack ? err.stack : err));
    process.exit(2);
  }
}

module.exports = {
  FACE, faceOf, validateFace, SELF_TEST,
  /* 供座位 4b 的门禁／D22 定点回归直接读的常量与算路（口径只有一份） */
  WIDTH_RATIO_MAX, SURFACE_WIDE_BY_DESIGN, DEGENERATE_RELS,
  suiteNames, faceStats, managedSurface, expandEntry, globToRegExp,
};
