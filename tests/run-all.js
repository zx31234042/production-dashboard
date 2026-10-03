/* ==========================================================================
   统一门禁 runner（tests/run-all.js）
   作用：一条命令跑完所有自检脚本并按脚本汇总"通过/失败/跳过"，**任一失败即非零退出**。
        没有它就得手敲 7 条命令，实际执行中很容易只跑"自己改动相关的那条"，
        从而漏掉连带失败（例：改样式注释也可能打挂 contract-check 的常量集中化断言）。
   依据：ADR-0003 D15；规范第七章自查清单。
   用法：
     node tests\run-all.js                跑全部（含需要浏览器的脚本，能跑就跑）
     node tests\run-all.js --fast         跳过耗时/浏览器类脚本，且改为**安静模式**（子进程输出落文件）
     node tests\run-all.js --tap          安静模式：子进程输出落 tests\._verify\run-all\<脚本>.log
     node tests\run-all.js --only a,b     只跑指定脚本（逗号分隔，不用写 .js）
     node tests\run-all.js --no-preflight 不跑体检
     node tests\run-all.js --list         只列出脚本清单
     node tests\run-all.js --ledger <p>   指定本轮实跑账落盘路径（默认见下方 `E99` 段：
                                         全量/`--fast` ⇒ 主账本 `run-totals.json`；
                                         `--only` 子集轮 ⇒ 自己的 `run-totals.subset-<pid>.json`）
   前置（**2026-10-03 起，`E91` 收尾**）：本轮若含 `screenshot-diff`，会在**任何脚本启动之前**
         先跑一次 `node tests\capture-baseline.js --out tests\._verify\captures` 刷新候选图；
         刷不出来（无 Edge／沙箱禁命名管道／捕获失败）⇒ **当场判红并写明原因**，绝不静默跳过
         （`--fast` 也照跑：`--fast` 含 `screenshot-diff`，没有这一步的它就是"绿得没有依据"）。
   退出码：0 = 无失败；1 = 有脚本失败（含前置刷新失败）；2 = 环境不满足（Node 版本等）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const snapshot = require('./lib/snapshot');

const env = require('./env');
env.assertRuntime();

/**
 * 探测"能否用管道捕获子进程输出"。
 * 受限沙箱在 Windows 上禁止打开命名管道 → EPERM；此时 runner 必须**降级**：
 * 改用 stdio=inherit 直通输出（仍能拿到退出码），而不是把 EPERM 当成脚本失败。
 * 注意：这与 preflight 的检查同源，不是脚本缺陷。
 */
function probePipes() {
  try {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("1")'], { encoding: 'utf8', timeout: 8000 });
    return { ok: !r.error && String(r.stdout).trim() === '1', reason: r.error ? (r.error.code || r.error.message) : '' };
  } catch (err) {
    return { ok: false, reason: err.code || err.message };
  }
}

const argv = process.argv.slice(2);
const hasFlag = f => argv.includes(f);
const optValue = name => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

/* ---------------- 并行调度（--jobs N） ----------------
   背景（2026-09-29 实测）：全量墙钟 ≈ 453 s，其中 **`stress-check` 301.7 s ＝ 67%**，
   其余 16 个合计才 ≈ 151 s（`browser-check` 46.7 / `harness-check` 34.2 / `overlap-check` 31.0 /
   `tools-check` 24.3 / 其余 ≈ 15）。**耗时集中在一个脚本上**，而不是"脚本太多"。
   于是最划算的做法是把 `stress-check` 这根"长杆"与其余脚本**重叠**跑，
   而不是去压那 151 s 的小头（离线 12 个门禁已实测：串行 70.0 s → 4 worker 36.4 s，加速 1.5×，
   地板是 `harness-check` 自身 34.5 s）。

   **为什么可以并行**：16 个脚本各自独立进程、端口已天然隔离
   （`browser-check` 18920 / `stress-check` 18930 / `capture-baseline` 18940 / `overlap-check` 18950，
   各读自己的 `DSH_*_PORT`；`tools-check` 用 18901～18909，`harness-check` 用 `DSH_PORT`/`DSH_BOARD_PORT`），
   且 `tests\lib\snapshot.js` 的稳定性扫描已排除 `tests\._verify\` —— 各脚本的日志/临时库写入
   不会被误判成"工作区被改写"。

   **为什么有尾巴必须串行**（`serialTail`）：见 SUITES 里逐条标注。
   并行只改"谁和谁同时跑"，**不改任何断言与判据**；并发度默认 4（`DSH_JOBS` 或 `--jobs` 可覆盖）。

   **2026-10-03（`E70③`，座位 4 的 `T-20261003-01`）：浏览器/CDP 类脚本整批收进串行尾。**
   实测形态（`E70③` 立案）：同一工作区，`browser-check` 单独跑 33/0 退 0、`--jobs 2` 全量也 33/0，
   而 `--jobs 4` 那一轮**整脚本失败**（四个浏览器/CDP 类脚本抢 Edge/端口/CPU 的典型形态）——
   它会打断"一轮全量取权威证据"的纪律（`E52`），且失败时按设计**跳过权威数字比对**。
   现在 `browser-check`／`overlap-check`／`stress-check` 三条**都标 `serialTail: true`**，
   与 `capture-baseline`（`E91` 的前置刷新，本就独占运行）一样不再进并行波。
   **如实记账（代价）**：并行波因此只剩离线脚本，"长杆 `stress-check` 与其余脚本重叠"这条收益消失
   ⇒ `--jobs N` 的墙钟会比改动前更长（实测见本批回执）。这是**拿墙钟换判据稳定性**的自觉取舍：
   `E70③` 的偶发红会污染证据，而墙钟只是等待。既有判据"并行波墙钟 < 串行墙钟"的含义不变
   （`harness-check` 第十五节 D 项按同一批脚本的串行/并行读秒比较），但它在本机
   `--only` 子集下**本就不判定**（脚本数 < 8；且 `--only` 一律串行，见 `scheduleSuites`）。 */

/** 调度：把 suites 拆成 [并行波, 串行尾]，并保持各自在 SUITES 里的原顺序。 */
function scheduleSuites(suites, jobs) {
  /* `--only`（定点重跑）**一律串行**：它是"复跑某一个脚本来复核/取证"的语义，
     并行既没有收益（通常只有一个脚本），又会让"工作区稳定性"判据在**别的进程正在改写
     共享文件**时被触发 —— 实测过一次：嵌套轮（harness-check 端到端里 spawn 的
     `run-all --only contract-check`）继承了 `DSH_JOBS`，于是它自己也并行，
     正好撞上另一个进程改写 `tests\README.md` ⇒ 判"工作区被改写"、整轮不作证据。 */
  if (!(jobs > 1) || optValue('--only')) return { parallel: [], serial: suites.slice(), jobs: 1 };
  const parallel = suites.filter(s => !s.serialTail);
  const serial = suites.filter(s => s.serialTail);
  return { parallel, serial, jobs };
}

/** 有界并发：同时最多 `limit` 个子进程；结果按传入顺序返回（与串行的输出顺序一致）。 */
async function runPool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

/**
 * 解析并发度。**默认 1＝串行**（与历史行为逐字一致）——并行必须**显式开启**。
 *
 * 为什么默认不并行：本项目"作证据"的那条路径是**串行全量**（E52：一轮收口只跑一次全量），
 * 它的时序与读数不该被并发改动悄悄改掉；并行是给"迭代期反复跑"用的加速档。
 * 开启方式：`--jobs N` 或环境变量 `DSH_JOBS=N`（上限 16）。
 * 推荐值 4：本机 24 逻辑核足够，而**被验目标机是 8 核 8 线程**（兆芯 KX-U6780A），4 已能喂满；
 * 再高只会让 `harness-check`/`browser-check` 这类自身较重的脚本互相抢 CPU，反而拉长墙钟。
 */
function resolveJobs() {
  const raw = optValue('--jobs') || process.env.DSH_JOBS || '';
  if (!String(raw).trim()) return 1;                 // 未显式要求 ⇒ 串行
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.max(1, Math.min(16, Math.floor(n)));
}

/* ==========================================================================
   **实跑账的落盘路径**（`E99` 收口；2026-10-03 座位 4 的 `T-20261003-13`）
   --------------------------------------------------------------------------
   事故形态（`E99`，2026-10-03 由 4b 在 `T-20261003-08` 中顺带实测立案）：账本文件名原先
   **写死** `tests\._verify\run-totals.json`，而**每一种**模式（全量／`--fast`／`--only`）都写它
   ⇒ 一次**子集轮**（`--only <子集>`）就把这份**共享账本**覆写成"只剩它跑过的那几个脚本"的子集账。
   `tests\docs-cross-check.js` 第十一节读的正是这条路径（`docs-cross-check.js:721`），读到子集账 ⇒
   触发它的"**前提不成立**"分支（`D20`，`docs-cross-check.js:779`）并**退化为逐项实跑**
   （自己把 12 个离线脚本再跑一遍）⇒ ① 与并发脚本抢 CPU/端口，实测出**假红**
   （`每个有声明的离线门禁都拿到了实跑值 … 拿不到汇总行 1 个`／`第十一节的实跑值取数不留空洞
   … 无来源/实跑无结果：tools-check`）；② 任何独立跑 `docs-cross-check` 的人都可能落到慢路径
   （本机实测探针墙钟 **37.3 s**）。`harness-check` 第十五节的嵌套调用（`--only <6 脚本>`，
   见 `harness-check.js` §15 的 `S15_SUITES` ＋ `runFast15()`）就是最典型的子集轮调用方
   （**按符号定位、不引行号** —— 那个文件由 4b 在飞维护，2026-10-03 一天内行号已漂移两次）。
   ========================================================================== */

/**
 * 主账本文件名。**这个名字与路径是 `docs-cross-check` 第十一节的取数面，不得改名、不得搬家**：
 * 它按 `path.join(env.paths.verify, 'run-totals.json')` **写死**读取（`docs-cross-check.js:721`），
 * 而该文件是别的协作方在维护的文件（本批硬约束：不得改 `tests\docs-cross-check.js`）。
 * 若为了"绕开 `E99`"而把主账本改名（例如统一改成 `run-totals-<pid>.json`），
 * `docs-cross-check` 就**永远**读不到本轮账 ⇒ 权威对账的取数面被改坏（每轮都退化 +37 s，
 * 且"逐脚本声明 ＝ 实跑值"那条断言会改走"逐项实跑"这条路）—— 那是比原缺陷更坏的结果。
 * ⇒ 修法是让**子集轮写自己的账**，主账本的名字与路径**一字不动**（见 `resolveLedgerFile`）。
 */
const MAIN_LEDGER_NAME = 'run-totals.json';

/**
 * 解析本轮实跑账的落盘路径（**纯函数**：不碰 argv 解析结果之外的状态，便于定点回归）。
 *
 * 规则（优先级从高到低）：
 *   ① `--ledger <path>` 显式指定 ⇒ 用它（相对路径按**仓库根**解析）；任何模式下都优先。
 *   ② **子集轮**（本轮带 `--only`）⇒ 写**自己的**账本 `run-totals.subset-<pid>.json`，
 *      主账本**一字不改**。**为什么子集轮不能覆写主账本**（本批的核心判据）：
 *      主账本是一份"**本轮跑过的全部脚本**的实跑账"（`docs-cross-check` 第十一节拿它当
 *      "每个离线门禁此刻的实跑通过数"的唯一快路径数据源，并把它与 `tests\README.md` 权威区
 *      逐脚本比对）；而子集轮的账**天然残缺**（它只跑了几个脚本）。残缺账覆写共享账本 ⇒
 *      下一位读者（`docs-cross-check`，无论它是被同一个 `run-all` 调的、还是被人**独立单跑**的）
 *      会把"账本不全"读成"**账本过期/缺失**" ⇒ 退化为逐项实跑并报"前提不成立"。
 *      即：一个**只为复核单个脚本**的子集轮，副作用是**污染全局对账数据源**并让权威对账变慢、
 *      与并发脚本抢资源（`E99` 的两条后果）。子集轮**没有**义务也没有权利改写全局账本。
 *   ③ 其余（**全量轮**与 `--fast`）⇒ 主账本 `run-totals.json`，与历史行为**逐字相同**。
 *
 * **为什么 `--fast` 不改道**（与 `--only` 区别对待，不是漏了）：`--fast` 的集合＝全部
 * `!slow && !needBrowser` 的**离线门禁**（14 个），它落在主账本里照样**覆盖 `docs-cross-check`
 * 的门禁清单**（那份清单就是"离线门禁"）⇒ 不触发"前提不成立"，无 `E99` 之害；而
 * `harness-check` 第十五节的 `DSH_HARNESS_S15_FULL=1` 档**就是跑 `--fast`**，跑完随即按
 * **写死的路径**回读这份账来比对"串行 vs 并行"两轮的 `suites`／`ranSuites`／`assertions`
 * （§15-C：`runFast15()` 里回读 `run-totals.json` 的那两行 ＋ `okC15` 的顺序判据；
 * 同样**按符号定位、不引行号**）。把 `--fast` 也改道 ⇒ §15-C 那两轮回读到**同一份
 * 旧账** ⇒ 会拿"陈旧账 vs 陈旧账"去判"落账顺序"，把一条**本来可判定**的判据变成**假红**
 * （而 `harness-check.js` 是本批**不得改**的文件）。⇒ 只让"确实会破坏门禁清单覆盖"的
 * `--only` 改道，其余保持原样：**改动面最小，且不动任何判据**。
 *
 * **`[UNMET]` 那条判据必须留着**（本批硬约束，`ADR-0004` D21/D23）：`docs-cross-check` 第十一节的
 * `t.requires('run-totals.json 的条目覆盖当前门禁清单…')`（`docs-cross-check.js:779`）是有价值的
 * **护栏**：账本缺失/过期时**不许静默放过**，必须显式报"前提不成立"并退化为逐项实跑（退 1）。
 * 本批**没有**删弱、放宽或绕过它（`docs-cross-check.js` 一个字节都没动）：要修的是"**正常的全量轮
 * 与子集轮不该互相污染**"，而不是"让这条判据不再触发"。⇒ 修好之后，它**照样可触发、照样判红**：
 * 删掉/清空主账本后单跑 `node tests\docs-cross-check.js`，仍会看到 `[UNMET] 前提不成立` 与退 1
 * （实测证据见本批回执【证据】第 2.d 条：临时移走主账本 ⇒ `前提不成立` ＋ 退出码 1）。
 *
 * @param {{explicit?:?string, only?:?string, verifyDir?:string, pid?:number, root?:string}} [o]
 * @returns {string} 账本绝对路径
 */
function resolveLedgerFile(o = {}) {
  const explicit = o.explicit !== undefined ? o.explicit : optValue('--ledger');
  const only = o.only !== undefined ? o.only : optValue('--only');
  const verifyDir = o.verifyDir || env.paths.verify;
  const pid = o.pid === undefined ? process.pid : o.pid;
  const root = o.root || env.paths.root;
  if (explicit) return path.resolve(root, explicit);
  if (only) return path.join(env.ensureDir(verifyDir), `run-totals.subset-${pid}.json`);
  return path.join(env.ensureDir(verifyDir), MAIN_LEDGER_NAME);
}

/** 本轮账本路径（只解析一次；`main` 打印它、`writeRunTotals` 写它，两处必须是同一个值）。 */
let LEDGER_FILE = null;
function ledgerFile() {
  if (!LEDGER_FILE) LEDGER_FILE = resolveLedgerFile();
  return LEDGER_FILE;
}

/* ---------------- 门禁清单 ----------------
   needBrowser 脚本在受限环境（沙箱禁命名管道）会自行 SKIP，runner 据此归类为"跳过"。
   slow 脚本默认在 --fast 下不跑。
   serialTail 脚本**只在串行尾段跑**（见下方 scheduleSuites）：它们对"别的脚本正在跑"敏感，
   不能进 `--jobs N` 的并行波 —— 详见 serialTail 的逐条理由。
   当前共 **6** 条：`docs-check`／`files-check`／`docs-cross-check`（离线三类，原有）
   ＋ `browser-check`／`overlap-check`／`stress-check`（浏览器/CDP 三类，`E70③` 于 2026-10-03 收进）。
   另有 `capture-baseline`（`E91` 的截图前置刷新）**不在本清单里**：它由 `refreshCaptureBaseline()`
   在**并行波之前**独占跑一次，见该函数注释（那是"比串行尾更彻底的串行"，不是新增竞争）。 */
const SUITES = [
  { name: 'contract-check', desc: '字段契约与适配层', needBrowser: false, slow: false },
  { name: 'ui-check', desc: '界面结构与需求条款', needBrowser: false, slow: false },
  { name: 'tools-check', desc: '联调工具进程级行为', needBrowser: false, slow: false },
  /* docs-check 走串行尾段：它会调 PowerShell 真跑一遍 md2docx（**会写盘**），
     而 files-check 要扫描整棵树 —— 两者并行会互相干扰（写盘 vs 全树扫描）。 */
  { name: 'docs-check', desc: '文档与规范一致性', needBrowser: false, slow: false, serialTail: true },
  { name: 'files-check', desc: '编码与文件卫生', needBrowser: false, slow: false, serialTail: true },
  { name: 'harness-check', desc: '夹具自检（时钟/样本/注入/服务启停）', needBrowser: false, slow: false },
  { name: 'logic-check', desc: '当班统计与班次边界（FR-4 / DR-17）', needBrowser: false, slow: false },
  { name: 'db-check', desc: '本地库结构与仓储层', needBrowser: false, slow: false },
  { name: 'platform-check', desc: '平台适配层（路径/ID/日志）', needBrowser: false, slow: false },
  { name: 'trace-check', desc: '需求追溯', needBrowser: false, slow: false },
  { name: 'copy-check', desc: '界面文案与需求条款对照', needBrowser: false, slow: false },
  { name: 'screenshot-diff', desc: '界面视觉回归', needBrowser: false, slow: false },
  /* `E9`（★★，验收前必做；ADR-0002 待办 3）：**交付包形态**的零依赖/零外网断言。
     它与 `docs-cross-check` 是两个层次：后者扫的是**源码/文档**里的依赖与外链，
     本脚本扫的是**打包产物**（`输出文件\离线部署与体检包-V1.2\`）：包内有没有 node_modules、
     有没有带 dependencies 的 package.json、有没有未登记的外链、便携 Node 版本是否满足 D10。
     放在**离线门禁的靠后位置**（`docs-cross-check` 之前）：它是"整包扫描 ＋ 真端口冲突实测"，
     耗时与包体积相关，不该挡在其它脚本前面；且不依赖其它脚本的产物（可独立跑）。
     ⚠ 它**进 SUITES 就进权威账**：`tests\README.md` 第三节的逐脚本清单与合计会因此漂移
     （本批由主代理收口），`files-check` 的受管文本扫描数也会 160 → 161。 */
  { name: 'offline-check', desc: '交付包零依赖/零外网（E9）', needBrowser: false, slow: false },
  /* 放在**离线门禁的最后**：它是跨文档/总账性质的聚合检查，要靠前面跑完的实跑账去比对
     `tests\README.md` 的权威数字（P2-22）；排在前面会读到不完整的账。
     `serialTail: true` 让它在 `--jobs N` 并行模式下**也**一定落在串行尾（见 scheduleSuites）。
     ⚠ `E70③`（2026-10-03）之后，尾段里在它**后面**还有三个浏览器/CDP 脚本 —— 这不影响它：
     它逐脚本比对的是 `offlineGates`（＝ `!needBrowser`，即 13 个离线门禁），浏览器类**不在其账目来源里**；
     而那三个脚本的入账由本 runner 收尾的 `verifyAuthorityTotals`（按**全量** SUITES 判定）负责。
     故"它必须在离线门禁之后"这条含义不变，只是不再字面等于"尾段的最后一条"。 */
  { name: 'docs-cross-check', desc: '跨文档一致性 + 权威数字校验', needBrowser: false, slow: false, serialTail: true },
  /* 三条浏览器/CDP 类脚本**整批收进串行尾**（`E70③`，2026-10-03 座位 4）：
     实测 `--jobs 4` 下四条浏览器/CDP 脚本互抢 Edge/端口/CPU ⇒ `browser-check` 偶发整脚本失败，
     而那一轮按设计**跳过权威数字比对**（打断 `E52` 的"一轮全量取权威证据"纪律）。
     串行尾里它们彼此**也**是串行的（逐条跑），故不存在"自己抢自己"。
     代价（如实）：`stress-check` 这根长杆不再与离线脚本重叠 ⇒ `--jobs N` 墙钟变长。 */
  { name: 'browser-check', desc: '真实浏览器（无头 Edge + CDP）', needBrowser: true, slow: false, serialTail: true },
  { name: 'overlap-check', desc: '元素重叠检测', needBrowser: true, slow: false, serialTail: true },
  /* slow 仍为 true：默认 20 分钟虽不再是"整夜浸泡"，但仍是本仓最耗时的一类（起真浏览器 + 采样），
     `--fast` 下跳过它是对的；整班次浸泡改由 `--soak` / `--hours 8` 显式触发（见 stress-check.js）。 */
  { name: 'stress-check', desc: '长跑稳定性（默认 2 分钟；--soak / --hours 8 为整班次浸泡）', needBrowser: true, slow: true, serialTail: true }
];

/* ==========================================================================
   **截图候选图前置刷新**（`E91` 收尾；2026-10-03 座位 4 的 `T-20261003-01`）
   --------------------------------------------------------------------------
   问题（`E91`，2026-10-02 立案／2026-10-02 由主代理"更正与升级"）：`screenshot-diff` 比的
   **不是当场截图**，而是候选目录 `tests\._verify\captures\` 里的 PNG（见 `screenshot-diff.js`
   文件头）。而本 runner 与 `preflight` **都不跑** `capture-baseline` ⇒ 候选图是否新鲜，
   只取决于"上一次手工捕获"。实测后果（`E92` 定量取证）：`05bcf7b` 引入的 4.59% 真实版面回归，
   靠**回归之前**的候选图**静默通过了约 4 天**。
   ⇒ 本批交付：在 `screenshot-diff` 读候选目录**之前**，必须有（且只有）一次刷新。

   **为什么选"前置步骤"而不是"与 `screenshot-diff` 一起放串行尾"**（两案都评估过）：
     ① **顺序由构造保证**：本步骤在任何门禁脚本启动之前跑完 ⇒ 与 `--jobs N` 无关，也不依赖
        `screenshot-diff` 最终落在哪一波（它**留在并行波**：它只解码 PNG，不碰 Edge/CDP）。
     ② **`--fast` 这一档也成立**：`capture-baseline` 是 `needBrowser` 脚本、会被 `--fast` 过滤掉，
        而 `screenshot-diff` **不会**（`needBrowser:false`）。若把刷新挂在"串行尾的
        `capture-baseline`"上，`--fast` 就会出现"跑了截图门禁、却没刷新候选图"的组合 ——
        那正是 `E91` 要堵的洞。
     ③ **不给权威区添账**：本步骤**不进 `SUITES`** ⇒ `authorityAll`／`offlineGates`／README
        权威行逐脚本清单都不变（若加进去，权威行必须点名它，否则 `verifyAuthorityTotals` 会判
        "权威区漏列离线门禁"；`docs-cross-check` 也会把它当离线门禁要求声明数）。
        它对"断言合计"的贡献恒为 0（`summary: null`）。
     ④ **资源独占**：它跑的时候没有别的脚本在跑 ⇒ 与 `E70③`（浏览器/CDP 互抢 Edge/CPU）的关系是
        "比串行尾更彻底的串行"，不是新增竞争。

   **fail-closed（硬要求，不静默跳过、也不让整套门禁崩掉）**：刷不出来时**判红并写明原因**——
     · `capture-baseline` 退出码非 0 ⇒ 红（原因＝退出码）；
     · 它自报 `SKIP`（未找到 msedge.exe，或沙箱不允许创建命名管道）⇒ 红（**它这一路是退 0 的**，
       不单独识别就会被读成"刷新成功"，那正是静默跳过）；
     · 候选目录里**每一张** PNG 的 mtime 都必须 ≥ 本次刷新开始时刻 − `CAPTURE_FRESH_SLACK_MS`
       （＝"确实被本次捕获重写"）⇒ 有更旧的就红并**逐张指名**。
   判据取 **mtime 实证**而不是"解析它打印的汇总行"：前者不依赖被测脚本的文案，后者一旦改文案
   就会静默失效（那正是 `E91` 的失效形态：判据看着在，实际没在判）。
   ========================================================================== */
const CAPTURE_FRESH_SLACK_MS = 2000;      // 文件系统时间戳粒度 + "取时刻到 spawn"之间的余量
const CAPTURE_SUITE = Object.freeze({
  name: 'capture-baseline',
  desc: '截图候选图前置刷新（E91：须在 screenshot-diff 读候选目录之前）',
  needBrowser: true,
  slow: false
});

/**
 * 跑一次 `capture-baseline --out tests\._verify\captures`，并**核对它真的刷新了候选图**。
 * 只读/只写 `tests\._verify\` 之下（截图落 `env.paths.captures`、日志落 `run-all\`），
 * 而工作区稳定性快照已排除 `._verify` ⇒ 不会把自己判成"工作区被改写"。
 * @returns {{ok:boolean, ms:number, logFile:string, out:string, total:number, fresh:number,
 *            stale:string[], reasons:string[]}}
 */
function refreshCaptureBaseline() {
  const outDir = env.paths.captures;                       // ＝ tests\._verify\captures（与 screenshot-diff 默认候选目录同源）
  const logDir = env.ensureDir(path.join(env.paths.verify, 'run-all'));
  const logFile = path.join(logDir, `capture-baseline-${process.pid}.log`);
  if (fs.existsSync(logFile)) { try { fs.rmSync(logFile, { force: true }); } catch { /* 忽略 */ } }

  const startedMs = Date.now();
  const fd = fs.openSync(logFile, 'a');
  const res = spawnSync(process.execPath,
    [path.join(env.paths.tests, 'capture-baseline.js'), '--out', outDir],
    { cwd: env.paths.root, timeout: 10 * 60 * 1000, stdio: ['ignore', fd, fd],
      env: { ...process.env, DSH_ENV: env.isProd ? 'test' : env.ENV_NAME } });
  try { fs.closeSync(fd); } catch { /* 忽略 */ }
  const ms = Date.now() - startedMs;

  let out = '';
  try { out = fs.readFileSync(logFile, 'utf8'); } catch { out = ''; }

  let pngs = [];
  try { pngs = fs.readdirSync(outDir).filter(n => n.toLowerCase().endsWith('.png')); } catch { pngs = []; }
  const stale = [];
  let fresh = 0;
  for (const n of pngs) {
    let st;
    try { st = fs.statSync(path.join(outDir, n)); } catch { continue; }
    if (st.mtimeMs >= startedMs - CAPTURE_FRESH_SLACK_MS) fresh++;
    else stale.push(`${n}（mtime ${new Date(st.mtimeMs).toLocaleString('sv-SE')}）`);
  }

  const reasons = [];
  if (res.error) reasons.push(`无法启动 capture-baseline（${res.error.code || res.error.message}）`);
  else if (res.status !== 0) reasons.push(`capture-baseline 退出码 ${res.status}（应为 0）`);
  if (/SKIP[:：]/.test(out)) {
    reasons.push('capture-baseline 自报 SKIP（未找到 msedge.exe，或沙箱不允许创建命名管道）'
      + '⇒ Edge/CDP 不可用，候选图**没有被刷新**');
  }
  if (!pngs.length) reasons.push(`候选目录 ${path.relative(env.paths.root, outDir)} 里没有 PNG`);
  if (stale.length) {
    reasons.push(`${stale.length}/${pngs.length} 张 PNG 未被本次刷新重写（mtime 早于本次开始时刻）：${stale.join('、')}`);
  }
  return { ok: reasons.length === 0, ms, logFile, out, total: pngs.length, fresh, stale, reasons };
}

/**
 * 解析子进程输出里的汇总行。**E12（登记 2026-09-20，2026-09-29 收口）：以失败为优先。**
 *
 * 为什么：日志若出现**多条**汇总行（嵌套子跑、脚本自报子套件等），旧实现 `out.match(…)` 只取
 * **第一条** ⇒ "前面一行绿、后面一行红"会被判成通过（假绿）。现在扫**全部**汇总行、按最坏优先取：
 *   ① 任一条 `failed > 0` ⇒ 取其中 **failed 最大**的那条（并标 `worst: true`）；
 *   ② 全绿 ⇒ 取 **passed 最大**的那条（防"先打一行占位 0/0"被当成结果）；
 *   ③ 附 `lines`＝见到的汇总行条数，便于复核"这轮到底有几条汇总"。
 * 与另两条修法合起来堵住 E12 的两种形态：**文件名带 runner pid** ＋ **运行前删同名旧文件**
 * （`runSuite()` 内，见断言"日志命名与删旧都在场"）；本条补的是"多行只取首条"这一种。
 */
function parseSummary(out) {
  const re = /通过\s*(\d+)\s*项，失败\s*(\d+)\s*项(?:，跳过\s*(\d+)\s*项)?/g;
  const all = [];
  let m;
  while ((m = re.exec(out)) !== null) {
    all.push({ passed: Number(m[1]), failed: Number(m[2]), skipped: m[3] === undefined ? 0 : Number(m[3]) });
  }
  if (!all.length) return null;
  const bad = all.filter(s => s.failed > 0);
  const pick = bad.length
    ? bad.reduce((a, b) => (b.failed > a.failed ? b : a))
    : all.reduce((a, b) => (b.passed > a.passed ? b : a));
  return { passed: pick.passed, failed: pick.failed, skipped: pick.skipped, lines: all.length, worst: bad.length > 0 };
}


/** 判断一次执行是否属于"环境不满足而跳过"（脚本自己打了 SKIP 且没有断言失败） */
function isEnvSkip(out) {
  return /\[SKIP\]/.test(out) && /未找到 msedge|命名管道|不允许创建命名管道|SKIP：/.test(out);
}

/**
 * 结论分类（**纯函数**，不碰文件系统与子进程）—— 便于 `harness-check` 直接对该规则做回归。
 * 输入子进程退出码与捕获到的输出，输出状态与理由。
 *
 * 规则（按优先级）：
 *   ① 退出码 3 → skipped：脚本显式声明"本环境跑不了"（env.EXIT_ENV_SKIP）
 *   ② 退出码 2 → error  ：脚本自身异常
 *   ③ 非 0 且输出里有 SKIP 文本特征 → skipped
 *   ④ 其余非 0 → failed（**输出拿不到时也是 failed**，不许因"没证据"就记跳过）
 *   ⑤ 退出码 0 但无汇总行 → unverified
 *   ⑥ 退出码 0 但汇总行说"失败 > 0" → failed（退出码与结论不一致，按严处理）
 *   ⑦ 退出码 0 但通过 0 项（一条断言都没跑 / 只有跳过项）→ **unverified**
 *   ⑧ 退出码 0 且跑到过断言、无失败 → passed
 *
 * ⑤⑦ 是 P1-2 的要害：旧实现把 ⑤⑦ 记成 passed，于是在无管道环境下
 * "一个断言都没跑"的浏览器类脚本被算进"14 通过"。宁可报"未核实"，也不能报通过。
 *
 * @param {number|null} exitCode 子进程退出码（null 表示 spawn 自身失败）
 * @param {{passed:number,failed:number,skipped:number}|null} summary 解析出的汇总行
 * @param {string} out 子进程输出全文
 * @returns {{status:string, detail:string}}
 */
function classify(exitCode, summary, out) {
  const text = String(out || '');
  if (exitCode === env.EXIT_ENV_SKIP) {
    return { status: 'skipped', detail: '本环境跑不了（脚本显式跳过，退出码 3）' };
  }
  if (exitCode === env.EXIT_ERROR) {
    return { status: 'error', detail: '脚本以退出码 2 终止（异常）' };
  }
  if (exitCode !== 0 && isEnvSkip(text)) {
    return { status: 'skipped', detail: '环境不满足（脚本自行 SKIP）' };
  }
  if (exitCode !== 0) {
    /* 注意：**不许**因为"输出为空/拿不到"就当成跳过 —— 那正是 P1-2 的错法。
       拿不到证据时只能按失败处理（宁可为严，不可假绿）。 */
    return { status: 'failed', detail: `退出码 ${exitCode}` };
  }
  if (!summary) {
    return { status: 'unverified', detail: '退出码 0，但未产出可解析的汇总行 —— 结论未核实，不计入通过' };
  }
  /* **先看失败数**：退出码 0 但汇总行写着"失败 > 0"是不可信的组合，按失败处理（别放过） */
  if (summary.failed > 0) {
    return { status: 'failed', detail: `汇总行报告失败 ${summary.failed} 项，但退出码为 0（退出码与结论不一致）` };
  }
  if (summary.passed + summary.skipped === 0) {
    return { status: 'unverified', detail: '退出码 0，但一条断言都没跑 —— 不是通过（脚本应改用 env.skipSuite 退 3）' };
  }
  /* 跑到过断言，但**通过数为 0**（只有跳过项）：不是"通过"，而是本环境没验到东西 */
  if (summary.passed === 0) {
    return { status: 'unverified', detail: `退出码 0，但通过 0 项、跳过 ${summary.skipped} 项 —— 本环境没验到任何断言，不计入通过` };
  }
  return { status: 'passed', detail: '' };
}

/**
 * 跑一个门禁脚本。
 *
 * **输出捕获策略（2026-09-19 修订，修 P1-2）**：无论有没有管道，一律把子进程 stdout/stderr
 * **落进 `tests\._verify\run-all\<脚本>-<pid>.log`**，再回读解析。
 * 旧实现是"有管道才捕获，无管道 + 非安静就 stdio:inherit"，于是同一环境出现两套账：
 * 无管道时 `out` 恒为空 → 三个浏览器类脚本"一个断言都没跑"却被判 PASS，
 * `--fast` 与默认模式的"通过数"还不一致。现在两种模式口径统一，且日志留痕可事后复核。
 *
 * **状态判定**：退出码是权威信号（0 通过 / 1 失败 / 2 异常 / 3 整脚本跳过，见 `env.js` 退出码契约）；
 * 文本 SKIP 特征仅作兜底。退出码 0 但**没解析出汇总行**或**一条断言都没跑**时，
 * 一律标为"未核实"（不是通过）—— 跑不了就要说跑不了，不能静默记绿（规范 9.5-5 第 6 条）。
 */
function runScript(suite, pipesOk, quiet) {
  const file = path.join(env.paths.tests, suite.name + '.js');
  const started = Date.now();

  const logDir = env.ensureDir(path.join(env.paths.verify, 'run-all'));
  const logFile = path.join(logDir, `${suite.name}-${process.pid}.log`);
  if (fs.existsSync(logFile)) { try { fs.rmSync(logFile, { force: true }); } catch { /* 忽略 */ } }

  const opts = {
    cwd: env.paths.root,
    timeout: suite.slow ? 12 * 3600 * 1000 : 10 * 60 * 1000,
    env: { ...process.env, DSH_ENV: env.isProd ? 'test' : env.ENV_NAME }
  };

  const fd = fs.openSync(logFile, 'a');
  const res = spawnSync(process.execPath, [file], { ...opts, stdio: ['ignore', fd, fd] });
  try { fs.closeSync(fd); } catch { /* 忽略 */ }
  const ms = Date.now() - started;

  let out = '';
  try { out = fs.readFileSync(logFile, 'utf8'); } catch { out = ''; }

  /* 非安静模式：把捕获到的输出回放到主控台，保持"看得见明细"的旧体验 */
  if (!quiet && out) process.stdout.write(out);

  const summary = parseSummary(out);

  if (res.error && res.error.code !== 'EPERM') {
    return { status: 'error', detail: res.error.code || res.error.message, ms, out, summary, logFile, exit: null };
  }
  const verdict = classify(res.status, summary, out);
  return { ...verdict, ms, out, summary, logFile, exit: res.status };
}

/**
 * **异步版** runScript —— 行为与上面**逐字一致**（同一日志命名、同一落盘、同一 classify 判据），
 * 唯一差别是它不阻塞事件循环，因而多个 suite 可以真并发。
 *
 * 为什么要单独加一个异步版而不是把同步版改成异步：**默认串行路径必须保持原样**。
 * 串行是本项目"作证据"的那条路径（E52：一轮收口只跑一次全量），它的时序不该被并行化改动碰到。
 * 于是同步版**原封不动**，异步版只服务于 `--jobs N` 的并行波。
 */
function runScriptAsync(suite, pipesOk, quiet, sink) {
  return new Promise(resolve => {
    const file = path.join(env.paths.tests, suite.name + '.js');
    const started = Date.now();

    const logDir = env.ensureDir(path.join(env.paths.verify, 'run-all'));
    const logFile = path.join(logDir, `${suite.name}-${process.pid}.log`);
    if (fs.existsSync(logFile)) { try { fs.rmSync(logFile, { force: true }); } catch { /* 忽略 */ } }

    const opts = {
      cwd: env.paths.root,
      env: { ...process.env, DSH_ENV: env.isProd ? 'test' : env.ENV_NAME }
    };

    const fd = fs.openSync(logFile, 'a');
    let child;
    try {
      child = spawn(process.execPath, [file], { ...opts, stdio: ['ignore', fd, fd] });
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
      resolve({ status: 'error', detail: err.code || err.message, ms: Date.now() - started, out: '', summary: null, logFile, exit: null });
      return;
    }

    /* 超时与同步版同口径：慢脚本 12 h、其余 10 min。到期 kill 并记为异常（不静默记绿）。 */
    const timeoutMs = suite.slow ? 12 * 3600 * 1000 : 10 * 60 * 1000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* 忽略 */ } }, timeoutMs);

    child.on('error', err => {
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
      resolve({ status: 'error', detail: err.code || err.message, ms: Date.now() - started, out: '', summary: null, logFile, exit: null });
    });

    child.on('close', code => {
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
      const ms = Date.now() - started;
      let out = '';
      try { out = fs.readFileSync(logFile, 'utf8'); } catch { out = ''; }
      if (timedOut) {
        resolve({ status: 'error', detail: `超时（>${Math.round(timeoutMs / 1000)}s）被终止`, ms, out, summary: parseSummary(out), logFile, exit: code });
        return;
      }
      if (!quiet && out) {
        if (sink) sink.push(out);            // 并行波：先收着，避免多脚本输出交错
        else process.stdout.write(out);
      }
      const summary = parseSummary(out);
      const verdict = classify(code, summary, out);
      resolve({ ...verdict, ms, out, summary, logFile, exit: code });
    });
  });
}

/**
 * 把"截至此刻的实跑账"落盘，供 `docs-cross-check` 比对权威值（P2-22 的单向契约）。
 *
 * 为什么每跑完一个脚本就写一次：`docs-cross-check` **本身就是 suite 成员**，
 * 它运行时需要读到"已经跑过的那些脚本的实跑数字"；若等 run-all 收尾才写，
 * 它读到的永远是上一轮的旧账（首版就是这么设计错的）。
 * 同时落 `expectedOffline`：权威区**逐脚本登记**的是 **13 个离线门禁**（需浏览器/长跑的那 3 个另有 `trace-check` 侧的口径），
 * 而权威区声明的**「合计」是全量 16 个脚本的总计** —— 两者**不是一回事**（E50 的根因就是混了这两者：
 * 判「跑全了没有」必须对**全量**判定，见 `verifyAuthorityTotals`；本字段只作 `docs-cross-check` 的账本覆盖前提）。
 */
/**
 * 把"截至此刻的实跑账"落盘。**只做留痕，不承担比对** —— 比对在收尾统一做
 * （见 verifyAuthorityTotals）；理由是 suite 成员读不到本轮最终账。
 *
 * **落盘路径**＝`ledgerFile()`（判据见上方 `E99` 段）：全量轮/`--fast` 写主账本
 * `run-totals.json`（`docs-cross-check` 第十一节的取数面，路径不得改），
 * `--only` 子集轮写自己的 `run-totals.subset-<pid>.json`（**不覆写主账本**，`E99` 的修法）。
 */
function writeRunTotals(results) {
  try {
    const agg = results.reduce((a, r) => {
      if (r.summary) { a.passed += r.summary.passed; a.failed += r.summary.failed; a.skipped += r.summary.skipped; }
      return a;
    }, { passed: 0, failed: 0, skipped: 0 });
    const byStatus = st => results.filter(r => r.status === st).length;
    const offlineNames = SUITES.filter(s => !s.needBrowser).map(s => s.name);
    const file = ledgerFile();
    const role = optValue('--ledger') ? 'explicit'
      : (optValue('--only') ? 'subset' : 'main');
    fs.writeFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      mode: hasFlag('--fast') ? '--fast' : (optValue('--only') ? `--only ${optValue('--only')}` : 'default'),
      /* 自述字段（**消费方不依赖它们**，只为让 `._verify\` 下的账本可自证来历）：
         `role`＝main（全量/--fast，主账本）｜subset（--only 子集轮，**不是**主账本）｜explicit（--ledger）；
         `mainLedger`＝主账本的仓库相对路径（子集轮据此说明"主账本在哪、我没动它"）；`pid`＝写它的进程。 */
      role,
      mainLedger: path.relative(env.paths.root, path.join(env.paths.verify, MAIN_LEDGER_NAME)),
      pid: process.pid,
      expectedOffline: offlineNames,
      ranSuites: results.map(r => r.suite.name),
      assertions: agg,
      scripts: { passed: byStatus('passed'), failed: byStatus('failed') + byStatus('error'),
        skipped: byStatus('skipped'), unverified: byStatus('unverified') },
      suites: results.map(r => ({ name: r.suite.name, status: r.status, summary: r.summary }))
    }, null, 2), 'utf8');
  } catch (err) {
    console.log(`  实跑合计落盘失败（不影响门禁结论）：${err && err.message}`);
  }
}

/**
 * **已登记偏差**（P3-6 的判据来源）—— 权威数字比对允许豁免的**唯一**依据。
 *
 * 为什么必须有它（2026-09-20，评审 A-2026-09-20-01 P3-6）：旧实现是**按脚本名**整体豁免
 * （`r.suite.name !== 'docs-check'`），于是 ① `docs-check` 出现**任何**新问题也照样放行 ——
 * 旧偏差成了新问题的挡箭牌；② 一旦别处有失败脚本，整段权威比对静默不执行，
 * 而"没比对"与"比对通过"在观感上几乎无法区分（实际因此发生两次：新增一个文本文件让
 * `docs-cross-check` 的"权威区扫描 N 个文本文件 ＝ files-check 实跑值"机械漂移，
 * 结果 `run-all` 只打印一句"权威数字未核对"，整个比对被跳过）。
 *
 * 现在豁免必须**同时**满足四条（见 `isRegisteredDeviation`）：
 *   ① 脚本名在册；② 状态是 `failed`（`error` / `unverified` 一律不豁免）；
 *   ③ 失败断言数 **≤** 登记数（**多于**登记数＝出现新问题 → 阻止比对）；
 *   ④ 失败清单里的断言名**全部**在登记清单内（多出一条未登记断言 → 阻止比对）。
 *
 * **数据来源（唯一真源，不要另起炉灶）**：`PROJECT_RULES.md` 6.4「已登记的历史偏差（不改写，只登记）」
 * + `tests\docs-check.js` D2 段（PROJECT_RULES 6.1/6.2）的实跑失败清单。6.4 明确要求两个数字分清：
 *   - **`docs-check` D2 段失败清单实际列出 13 条**（9 条缺 `类型:` 前缀 + 4 条超过 30 字；第 13 条＝
 *     `be63c37`（2026-09-30 本机 AI 提交，37 字），推送前由门禁当场发现）
 *     → `listedItems`（= 6.4 本表逐条登记 3 条 + 同类早期 10 条）；
 *   - **门禁断言数仍是 2 条**（D2 段只有两条 `check`）→ `failedAssertions`。
 *
 * **⚠ 数字变化时必须同步本常量**：6.4 增删登记条目、D2 段增删 `check`、失败清单条数变化，
 * 都要回来改这里；否则门禁会拿**旧数字**去豁免**新问题** —— 那正是 P3-6 要堵的口子。
 * 一致性由 `tests\harness-check.js` 第十一节独立复核（docs-check 源码静态比对 + `git log` 实算），
 * 常量写错当场变红，不靠"记得同步"。
 */
const REGISTERED_DEVIATIONS = Object.freeze({
  'docs-check': Object.freeze({
    /* D2 段失败断言条数（＝汇总行的 failed，也是 README 第三节 `docs-check 43/2` 里的那个 2） */
    failedAssertions: 2,
    /* 失败清单里逐条列出的偏差条数（README / 6.4 口径：9 条缺前缀 + 4 条超 30 字） */
    listedItems: 13,
    /* 允许失败的两条断言名（与 docs-check D2 段的 check 名逐字一致；改名即视为"换了豁免口子"） */
    assertions: Object.freeze([
      '每条提交都按「类型: 说明」书写',
      '提交说明不超过 30 字（6.1）'
    ]),
    /* 登记出处：判据存疑时先读这两处（本常量与它们同源） */
    source: 'PROJECT_RULES.md 6.4（12 条 = 本表 3 条 + 同类早期 9 条）/ tests\\docs-check.js D2 段（PROJECT_RULES 6.1/6.2）'
  })
});

/**
 * 从脚本输出里取出「失败清单」中的断言名（输出契约见 `lib/assert.js`：`  N. 断言名 —— 详情`）。
 * 用途：判断 `docs-check` 失败的**是不是那两条已登记断言** —— 只比条数会被"换个断言继续失败"骗过。
 * 实现要点：从**最后**一个 `=== 汇总 ===` 之后找 `失败清单：`（脚本正文里也可能出现这几个字）；
 * 解析不出时返回空数组，由调用方按"拿不出证据"处理。
 * @param {string} out 子进程输出全文
 * @returns {string[]}
 */
function failedAssertionNames(out) {
  const text = String(out || '');
  const sumAt = text.lastIndexOf('=== 汇总 ===');
  const region = sumAt >= 0 ? text.slice(sumAt) : text;
  const start = region.indexOf('失败清单：');
  if (start < 0) return [];
  const names = [];
  for (const line of region.slice(start).split(/\r?\n/).slice(1)) {
    const m = line.match(/^\s+\d+\.\s+(.+?)(?:\s+——\s+|$)/);
    if (!m) {
      if (!line.trim()) { if (names.length) break; continue; }   /* 空行：清单未开始或已结束 */
      if (names.length) break;                                   /* 非清单行：清单结束 */
      continue;
    }
    names.push(m[1].trim());
  }
  return names;
}

/**
 * 这一条结果能否算「已登记偏差」（四条判据见 `REGISTERED_DEVIATIONS` 的注释）。
 *
 * 只在**有输出**时才比对失败清单里的断言名：无输出（纯函数真值表用例传的就是无输出的行）
 * 不算证据、也不据此放行别的东西，条数判据 ③ 始终生效。汇总行缺失（脚本异常早退）时按登记数处理 ——
 * 那是旧实现也放行的情形，本次不收紧它；但**多于**登记数一定不放行。
 * @param {{suite:{name:string},status:string,summary?:object,out?:string}} r
 * @returns {boolean}
 */
function isRegisteredDeviation(r) {
  const name = r.suite && r.suite.name;
  const reg = name ? REGISTERED_DEVIATIONS[name] : null;
  if (!reg) return false;
  if (r.status !== 'failed') return false;
  const failed = r.summary && Number.isFinite(r.summary.failed) ? r.summary.failed : reg.failedAssertions;
  if (failed > reg.failedAssertions) return false;
  const text = String(r.out || '');
  if (text) {
    const names = failedAssertionNames(text);
    if (names.length === 0) return false;                          /* 有输出却读不到失败清单 → 无证据 */
    if (names.some(n => !reg.assertions.includes(n))) return false; /* 出现未登记断言 → 不算已登记偏差 */
  }
  return true;
}

/**
 * 权威数字比对的**前置条件**（纯函数，供 `harness-check` 做真值表回归）。
 *
 * 只有"失败/异常/未核实**全部是已登记偏差**"时，本轮账目才完整、才能拿去和权威区比。
 * 判据只认 `failed` / `error` / `unverified`：`skipped`（浏览器类脚本在本环境显式退 3）
 * **不是失败**，按既有口径不影响比对。
 *
 * **2026-09-20 修 P3-6**：判据从"按脚本名豁免 `docs-check`"改为逐条核对条数与断言名
 * （`REGISTERED_DEVIATIONS` + `isRegisteredDeviation`）；未登记的失败/异常/未核实一律阻止比对。
 *
 * @param {Array<{suite:{name:string},status:string,summary?:object,out?:string}>} results
 * @returns {string[]} 阻止比对的脚本名（空数组＝可以比对）
 */
function authorityBlockers(results) {
  const BLOCKING = ['failed', 'error', 'unverified'];
  const blockers = [];
  for (const r of results) {
    if (!BLOCKING.includes(r.status)) continue;
    if (isRegisteredDeviation(r)) continue;
    blockers.push(r.suite && r.suite.name);
  }
  return [...new Set(blockers)];
}

/** 本机是否有 git（**E55**）：目标机可能没装 git ⇒ `docs-check`/`harness-check` 里**依赖提交历史**的断言
 *  无法判定（harness 少 2 条、docs-check 的失败数也不同）⇒ 合计与权威区**结构性不可比**。
 *  此时**不做权威比对**：如实说"不可比"，**不是**"权威数字已漂移"。
 *  （现场 2026-09-29 实测：无 git 的机器上跑全量会在报告里打出指向"文档没同步"的**假红**。） */
function gitAvailable() {
  try {
    const r = require('node:child_process').spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 8000 });
    return r.status === 0 && /git version/i.test(String(r.stdout || ''));
  } catch { return false; }
}


/**
 * 收尾校验 `tests\README.md` 第三节的**权威数字**与本轮实跑是否一致（P2-22）。
 * 为什么放在 runner 而不是某个门禁脚本里：本 runner 是唯一持有"本轮最终账"的地方
 * （suite 成员跑到自己时还看不到后面的脚本），且它不会自递归。
 * 只在**跑全了权威区覆盖的全部门禁脚本**时判定，避免 `--only`/`--fast` 子集造成假失败。
 *
 * **输出契约（2026-09-20 修 P3-6 时钉住）**：任何"**比对未执行**"的分支（`blocked` / `skipped`）
 * 都必须在 `detail` 里写明**原因 + 涉及脚本名**，由 `main` 原样打印 —— 旧实现只留一句
 * "本轮账目不完整（…）权威数字未核对"，与"比对通过"在观感上几乎一样，于是缺陷被当成正常
 * （实际发生两次，见 P3-6）。未执行比对时**不**把 exit code 归因给权威校验
 * （真正的失败脚本明细才是主因，见 `main` 里的注释）。
 *
 * **已登记偏差容忍**：`docs-check` 的 2 项失败是 `PROJECT_RULES` 6.4 登记在案、长期保留的历史提交
 * 信息偏差，不会去修。故本判定在"剩下的失败全是已登记偏差"时接受两种权威值：
 * ①**含已登记偏差的合计**（`agg.passed`，即 README 当前写法）
 * ②**真实通过数**（`agg.passed - 已知偏差数`，即"偏差修掉后应达到"的值）
 * 这样无论那两项偏差将来修掉与否，权威区只要同步过就不会假失败。
 * 注意：豁免判据**不是**"脚本叫 docs-check"，而是 `REGISTERED_DEVIATIONS[脚本名]` 的条数与断言名。
 *
 * @param {{passed:number}} agg 本轮各脚本汇总行里 passed 的合计
 * @param {Array<{suite:{name:string},status:string,summary?:object,out?:string}>} results 本轮各脚本结果
 * @returns {{ok:boolean,kind:string,detail:string}}
 */
function verifyAuthorityTotals(agg, results, opts = {}) {
  /* 「本轮跑全了没有」必须对**权威区覆盖的全量脚本**判定 —— 不是 `!needBrowser` 的子集。
     立案（E50，2026-09-28）：权威区合计是**含浏览器/长跑脚本**的全量值（它们在 README 第三节
     被逐条登记），而这里原来按 `!needBrowser` 取集合 ⇒ `--fast`（过滤 slow ＋ needBrowser）下
     `browser-check`/`overlap-check`/`stress-check` **既不在集合里、也没跑** ⇒ `missing = []`，
     于是拿**全量**权威值去比**子集**实跑值，**误报"权威数字已漂移"**（与本函数自述"避免
     `--only`/`--fast` 子集造成假失败"直接矛盾；现场离线体检报告第六节就是这么出现假红的）。
     判据与夹具同源：`harness-check` 第十一节按同一集合口径构造用例（含 E50 定点回归）。 */
  const authorityAll = SUITES.map(s => s.name);
  const ran = new Set(results.map(r => r.suite.name));
  const missing = authorityAll.filter(n => !ran.has(n));
  if (missing.length) {
    return { ok: true, kind: 'skipped',
      detail: `**未执行**：本轮未跑全离线门禁（缺 ${missing.length} 个：${missing.join('、')}）` +
        ' —— 不拿残缺的账去比权威值（`--only`/`--fast` 跑子集时属正常）' };
  }
  /* E55（2026-09-29）：**没有 git 的机器不做权威比对** —— `harness-check` 有 2 条依赖提交历史的断言、
     `docs-check` 的失败数也与联网开发机不同 ⇒ 合计与权威区**结构性不可比**。旧实现在这里会拿"权威区
     1161"比"现场实跑 1160 左右"、报"权威数字已漂移，请同步 tests\README.md 第三节"，即**指向"文档没同步"
     的假红**（现场 2026-09-29 实测确认；当时因为只跑 `--fast`、落在上面的 `missing` 分支才没触发）。
     这里如实标"未执行：不可比"，而不是"漂移" —— 与 `missing` 分支同属"**没比对就说没比对**"（规范 9.5-5）。
     `opts.gitAvailable` 供自检注入（默认真探测），定点回归见 `harness-check` 第十一节。 */
  const gitOk = (opts && opts.gitAvailable !== undefined) ? opts.gitAvailable === true : gitAvailable();
  if (!gitOk) {
    return { ok: true, kind: 'skipped',
      detail: '**未执行**：本机没有 git（读不到提交历史）⇒ `docs-check`／`harness-check` 里依赖提交历史的断言无法判定，' +
        '合计与权威区**不可比** —— 不做权威数字比对（**这不是"漂移"**）；要核对数字请在装了 git 的机器上跑' };
  }

  let readme = '';
  try { readme = fs.readFileSync(path.join(env.paths.tests, 'README.md'), 'utf8'); } catch (err) {
    return { ok: false, kind: 'broken', detail: `读不到 tests\\README.md：${err.message}` };
  }
  const numeric = require('./lib/numeric');
  const line = readme.split('\n').find(l => l.includes('离线可跑部分')) || '';
  const stated = numeric.matchNumber(line, /合计\s*\*{0,2}\s*(\d+)\s*通过/);
  if (stated === null) return { ok: false, kind: 'broken', detail: '权威区里找不到"合计 N 通过"' };

  /* 前置条件：失败/异常/未核实必须**全部是已登记偏差**（判据见 REGISTERED_DEVIATIONS）。
     被挡下时逐条说明"为什么它不算已登记偏差"，并点名脚本 —— 不许只写一句"未核对"。
     判据演进：原来用 `status !== 'passed'`（把 skipped 也算成失败）→ 曾改为按脚本名整体豁免
     docs-check（就是 P3-6 的口子）→ 现在按条数与断言名逐条核对。 */
  const blockers = authorityBlockers(results);
  if (blockers.length) {
    const why = results.filter(r => blockers.includes(r.suite.name)).map(r => {
      const reg = REGISTERED_DEVIATIONS[r.suite.name];
      const failed = r.summary && Number.isFinite(r.summary.failed) ? r.summary.failed : null;
      if (!reg) return `${r.suite.name}（${r.status}，不在已登记偏差之列）`;
      if (r.status !== 'failed') return `${r.suite.name}（${r.status}，已登记偏差只认 failed，故不豁免）`;
      if (failed !== null && failed > reg.failedAssertions) {
        return `${r.suite.name}（失败 ${failed} 条 > 已登记 ${reg.failedAssertions} 条，属未登记的新问题）`;
      }
      return `${r.suite.name}（failed，但失败清单里有已登记清单之外的断言名）`;
    });
    return { ok: false, kind: 'blocked',
      detail: `**未执行**：本轮账目不完整 —— ${why.join('；')}；` +
        `涉及脚本：${blockers.join('、')}（先修它们，修完重跑再比；` +
        `权威区写 ${stated}、本轮实跑 ${agg.passed} 仅供参考，**未核对**）` };
  }
  const docsCheck = results.find(r => r.suite.name === 'docs-check');
  const knownDeviations = docsCheck && docsCheck.summary ? docsCheck.summary.failed : 0;
  const truePass = agg.passed - knownDeviations;
  /* 接受两个口径**之一**：
     ①"实跑合计"（`agg.passed`）—— 当前 README 的写法，含已登记偏差的失败项不计入通过；
     ②"真实通过数"（`agg.passed - 已知偏差数`）—— 那两项偏差若被修掉后应达到的值。
     注意：**不**接受两者的中间值（probing 时发现把 471 也放过了，那是错的）。 */
  const accepted = knownDeviations > 0 ? [agg.passed, truePass] : [agg.passed];
  if (!accepted.includes(stated)) {
    return { ok: false, kind: 'mismatch', detail: `权威区写 ${stated}，本轮实跑 ${agg.passed}` +
      `（真实通过 ${truePass}）—— 权威数字已漂移，请同步 tests\\README.md 第三节` };
  }
  const allowanceNote = knownDeviations > 0 ? `（含已登记偏差 ${knownDeviations} 项，真实通过 ${truePass}）` : '';

  /* 顺带校验：**权威区覆盖的每个门禁脚本**都必须在权威行里被逐个点名（新增脚本别忘登记）。
     集合口径同前（E50）：对全量判定，不用 `!needBrowser` 子集。 */
  const named = [...new Set([...line.matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1])
    .filter(n => n.endsWith('-check') || n === 'screenshot-diff'))];
  /* 命名提醒（2026-10-01 由 `notListed` 改名，T-20260930-32）：这个局部量落到 `kind='broken'`，
     而 **`broken` 被三因共用** —— 读不到 `tests\README.md`（本函数开头那处）、权威行里找不到
     "合计 N 通过"（紧随其后那处）、以及**这里**"漏列点名" —— 三者返回的 `kind` 完全一样，
     消费方只能靠 `detail` 区分（前者带 `读不到`、次者带 `找不到"合计 N 通过"`、本处带 `漏列离线门禁`）。
     ⇒ 写断言请用 `kind === 'broken'` ＋ detail 正则，**不要**按字面写 `kind === 'notListed'`
     （那会恒假：`notListed` 从来只是一个局部变量名，不是 `kind` 取值）。 */
  const missingGates = authorityAll.filter(n => !named.includes(n));
  if (missingGates.length) {
    return { ok: false, kind: 'broken', detail: `权威区漏列离线门禁：${missingGates.join('、')}` };
  }
  return { ok: true, kind: 'ok', detail: `权威区合计 ${stated} ＝ 本轮实跑 ${agg.passed}${allowanceNote}` };
}

/* ==========================================================================
   **工作区稳定性判定**（2026-09-20 新增；堵"被测文件正被并发写"这类假红）
   --------------------------------------------------------------------------
   事故形态（本会话实测）：门禁跑到一半，被测文件被**另一个进程**改写，于是门禁读到半写内容，
   报出"实跑未产出可解析的汇总行""账本值 94/92 翻面"这类**假红**；主代理据此误判子代理越界。
   这类结论**看起来**与"代码真的坏了"完全一样，光看输出分辨不出来 —— 所以要在机制上拦：
   一轮运行内工作区被改写 ⇒ 该轮结论不得当作证据，且**不得**继续拿它去和权威数字比对
   （否则会把"文件正在变"当成"权威区漂移"，进而去改 README —— 那是最坏的一种连锁误判）。
   规则本体在 `tests\lib\snapshot.js`（纯函数 `diffSnapshots`，真值表见 harness-check 第十二节）；
   这里只负责把规则结果翻译成"打印什么／退几"，并把这段判定抽成纯函数以便定点回归。
   ========================================================================== */

/**
 * 根据"工作区稳定性"与"权威数字校验"的结果，决定**打印哪一句、退哪个码**（纯函数）。
 *
 * 优先级（顺序即优先级，**不得**调换）：
 *   ① 工作区被改写 → 本轮结论不可作证据：跳过权威比对、退出码 1（先于一切"数字好不好看"）。
 *   ② 权威数字漂移 / 权威区不可用 → 退出码 1（要同步 tests\README.md 第三节）。
 *   ③ 本轮账目不完整（`blocked`）→ 退出码 1：**跳过了**对账就必须算不通过
 *      （旧实现只打印一句"未核对"然后按"全绿"退 0，于是"没比对"被当成"比对通过"）。
 *   ④ 离线门禁没跑全（`skipped`，如 `--only`/`--fast` 子集）→ 不构成失败（既有的正常形态）。
 *   ⑤ 其余 → 通过。
 *
 * @param {Array<{path:string,kind:string}>} changed 本轮被改写的文件（空数组＝稳定）
 * @param {{ok:boolean,kind:string,detail:string}} authority verifyAuthorityTotals 的结果
 * @returns {{unstable:boolean, exitCode:number, titles:string[], detail:string, evidence:string}}
 *          `titles` 为待打印的说明行（为空表示"按老样子收尾"）；`evidence` 是**证据状态**一行 ——
 *          只有"稳定**且**权威比对真的跑了（ok）"才敢写"本轮实跑可作为证据"，其余一律写明缺口。
 */
function resolveGateOutcome(changed, authority) {
  const list = Array.isArray(changed) ? changed : [];
  if (list.length > 0) {
    const shown = list.slice(0, 5).map(snapshot.describeChange).join('、');
    const more = list.length > 5 ? ` 等 ${list.length} 项` : '';
    return {
      unstable: true,
      exitCode: 1,
      titles: [],
      detail: `  ⚠ 本轮运行期间工作区被改写（${list.length} 个文件）：${shown}${more}`,
      evidence: '证据状态：**本轮结论不可作为证据** —— 运行期间被测文件正在变化，' +
        '读到的可能是半写内容，失败与通过都说明不了问题；**未与权威数字比对**（先让写入方停下，再复跑）'
    };
  }
  const auth = authority || { ok: false, kind: 'broken', detail: '（权威校验未产出结果）' };
  /* 证据标签只说**这轮到底核了什么**，不多说一个字：
     · `ok === true`：工作区稳定**且**权威数字比对通过 → 这轮的账可以当证据；
     · `kind === 'skipped'`：稳定，但**没跑全离线门禁 / 没做对账** → 只敢说"工作区比对已通过"，
       **不许**写成"工作区稳定"（那是没核过的事实，跟"没比对"一样是拿默认值当结论）；
     · `blocked` / `mismatch` / `broken`：核过但没过 → 明说"未经权威数字核对（对账未通过）"。 */
  const evidence = (auth.ok === true && auth.kind !== 'skipped')
    ? '证据状态：工作区稳定，且权威数字已核对（本轮实跑可作为证据）'
    : (auth.kind === 'skipped'
      ? '证据状态：运行期间工作区比对已通过（**未经权威数字核对**：本轮未跑全离线门禁 / 未做对账）'
      : '证据状态：工作区稳定（**未经权威数字核对**：本轮对账未通过，实跑不能作权威证据）');
  if (auth.kind === 'mismatch' || auth.kind === 'broken') {
    return { unstable: false, exitCode: 1,
      titles: ['\n失败：tests\\README.md 第三节的权威数字与本轮实跑对不上（或权威区不可用）。',
        '处置：同步 tests\\README.md 第三节（权威值唯一真源），再重跑。'],
      detail: '', evidence };
  }
  if (auth.kind === 'blocked') {
    return { unstable: false, exitCode: 1,
      titles: ['\n失败：本轮账目不完整，**已跳过**权威数字比对 —— 没比对就是没核实，不算通过。',
        '处置：先修上面点名的问题脚本（或补齐已登记偏差），修完重跑再做对账。'],
      detail: '', evidence };
  }
  return { unstable: false, exitCode: 0, titles: [], detail: '', evidence };
}

/**
 * **最终退出码的组合判据**（纯函数，供 `harness-check` 第十四节做真值表与 D22 定点变异）。
 *
 * 为什么必须单独抽出来（2026-09-21 修 P1：`51eed59` 那次重构引入的回归）：
 * `resolveGateOutcome` 只建模两件事 —— **工作区稳定性** 与 **权威数字对账**。它**不建模**
 * "有没有脚本失败"，于是"稳定 + 对账 ok"时它返回 `exitCode: 0`；旧实现拿它当唯一判据就落进
 * "成功收尾"，在有 `FAIL` 的轮次上打印"门禁全绿（无失败脚本）"并 `exit 0`（实测：
 * `FAIL docs-check 41 / 2 / 0` 与"门禁全绿"同屏、退出码 0）—— 同时违反规范 9.5-5
 * 「`1` = 有断言失败」与 `tests\README.md` 的「任一失败即非零退出」。现在两个来源**都要**看：
 *   · `verdict.exitCode`：不稳定轮 / 权威区漂移（`mismatch`、`broken`）/ 对账被跳过（`blocked`）
 *     ⇒ 1；`skipped`（`--only`/`--fast` 子集没跑全离线门禁）**不构成失败** ⇒ 0（既有语义不变）。
 *   · `failed` / `unverified` 非空：**无条件** 1 —— **包括**"失败项仅为 `PROJECT_RULES` 6.4
 *     已登记偏差"的情形（登记偏差只免"对账被阻止"，**不免退出码**：偏差仍是未修复的断言失败）。
 *
 * @param {{failed?:Array, unverified?:Array, verdict?:{exitCode?:number}}} entry
 * @returns {number} 0 = 无失败脚本且判定通过；1 = 有失败/未核实脚本，或判定本身为不通过
 */
function finalExitCode(entry) {
  const e = entry || {};
  const failed = Array.isArray(e.failed) ? e.failed : [];
  const unverified = Array.isArray(e.unverified) ? e.unverified : [];
  const verdict = e.verdict || {};
  if (failed.length > 0 || unverified.length > 0) return 1;
  return verdict.exitCode ?? 0;
}

/* ---------------- 失败明细的行选取（`E88⒝`：余量只有 3 行 ⇒ **不许静默丢"指名"**） ----------------
   立案（`E88⒝`，2026-10-02 由座位 5 在 C·19 报出）：旧实现是 `filter(…).slice(0, 8)`。
   现场读数（座位 4b 的 `T-20261002-11`，"只缺 1 个入口"那一轮）：过滤器命中 **8/8 用满**
   —— 其中 3 条是**名字里带"失败清单"的 `[PASS]` 噪声**，真正点名的 `[FAIL]` 恰在第 5 位、
   编号行在第 8 位 ⇒ **余量 0 行**。再多一条噪声，"点名的 `[FAIL]`／编号行"就会被**静默丢掉**
   （`D23`：判据必须能指名）。为什么这一层这么要紧：安静模式（`--tap` / `--fast`）**不回放**
   子进程输出，失败明细段是读者唯一的"指名"入口（`E88⒝` 的原话："一旦排到第 9 行之后就会丢指名"）。
   现在改为**按关键字分层选取**（放宽 **8 → 24** ＋ 优先保住指名行）：
     · 命中行 ≤ `DETAIL_MAX_LINES` ⇒ 全部打印（与旧行为一致，只是不再过早截断）；
     · 超过 ⇒ **先保住全部"指名行"**（`[FAIL]`／编号行／`脚本异常终止`），
       再用其余命中行按原顺序补足到上限；
       · 仍有被丢的行 ⇒ **显式打印"截断了几行 + 去哪看全文"**（截断必须可见，不许无声）。
   可证伪的判据：**任何一轮里，"含 `[FAIL]`／编号"的行一行都不会因截断而消失**；
   即使指名行本身多到超过上限，也只丢"非指名"的填充行。
   定点回归见本批回执（`tests\._verify\T-20261003-01\` 下的选取探针：同一条真输出分别过
   "旧 `.slice(0,8)`"与 `pickDetailLines()`，比对"点名行是否还在"）。 */
const DETAIL_LINE_RE = /\[FAIL\]|失败清单|^\s+\d+\.|脚本异常终止/;
/** "指名行"：真正报告"哪一条断言／哪个文件／哪一处"的行 —— 截断时**最后**才考虑它们（实际不丢） */
const DETAIL_NAMED_RE = /\[FAIL\]|^\s+\d+\.|脚本异常终止/;
const DETAIL_MAX_LINES = 24;

/**
 * 从一个失败脚本的输出里挑出"该打印的明细行"（**纯函数**，供定点回归直接调用）。
 * @param {string} out 子进程输出全文（拿不到时传 null/undefined ⇒ 返回空）
 * @returns {{lines:string[], dropped:number, named:number}} `dropped` > 0 表示有行被截掉（调用方必须**明写**）
 */
function pickDetailLines(out) {
  const hits = String(out || '').split('\n').filter(l => DETAIL_LINE_RE.test(l));
  const named = hits.filter(l => DETAIL_NAMED_RE.test(l));
  if (hits.length <= DETAIL_MAX_LINES) return { lines: hits, dropped: 0, named: named.length };
  const rest = hits.filter(l => !DETAIL_NAMED_RE.test(l));
  const kept = named.concat(rest.slice(0, Math.max(0, DETAIL_MAX_LINES - named.length)));
  return { lines: kept, dropped: hits.length - kept.length, named: named.length };
}

async function main() {
  if (hasFlag('--list')) {
    console.log('=== 门禁脚本清单 ===');
    for (const s of SUITES) {
      console.log(`  ${s.name.padEnd(20)} ${s.desc}${s.needBrowser ? '  [需浏览器]' : ''}${s.slow ? '  [耗时长]' : ''}${s.serialTail ? '  [串行尾]' : ''}`);
    }
    process.exit(0);
  }

  const only = optValue('--only');
  let suites = SUITES;
  if (only) {
    const want = only.split(',').map(s => s.trim()).filter(Boolean);
    suites = SUITES.filter(s => want.includes(s.name) || want.includes(s.name + '.js'));
    const unknown = want.filter(w => !SUITES.some(s => s.name === w || s.name + '.js' === w));
    if (unknown.length) {
      console.error(`未知脚本：${unknown.join(', ')}（用 --list 看清单）`);
      process.exit(2);
    }
  } else if (hasFlag('--fast')) {
    suites = SUITES.filter(s => !s.slow && !s.needBrowser);
  }

  console.log('=== 统一门禁（run-all） ===');
  console.log(`  ${env.describe()}`);
  console.log(`  共 ${suites.length} 个脚本${hasFlag('--fast') ? '（--fast：已跳过浏览器类与长跑）' : ''}${resolveJobs() > 1 ? `（--jobs ${resolveJobs()}：并行波 + 串行尾）` : ''}\n`);

  /* 本轮账本落哪 —— **必须一眼可见**：子集轮改道（`E99`）若只体现在行为上，读者会以为
     主账本被这轮刷新过（它其实**一字未动**）；反过来，全量轮也要能证明自己写的是主账本。
     这一行只是**说明**，不参与任何判据。 */
  {
    const lf = ledgerFile();
    const rel = path.relative(env.paths.root, lf);
    const isSubset = !optValue('--ledger') && Boolean(optValue('--only'));
    console.log(isSubset
      ? `  实跑账：${rel}（**子集轮写自己的账**，主账本 ${MAIN_LEDGER_NAME} **一字不改** —— 见 resolveLedgerFile 的 E99 说明）`
      : `  实跑账：${rel}（主账本：docs-cross-check 第十一节按此路径取"每个离线门禁的实跑值"）`);
  }

  /* **运行开始时**的工作区快照（见上方"工作区稳定性判定"与 lib/snapshot.js）。
     采集点很关键：必须在**任何子进程（含体检）启动之前** —— 体检与各门禁脚本都读工作区，
     它们之间的改写同样属于"运行期间被改写"。快照自身只读、且落点 `tests\._verify\` 已被排除，
     故不会自己把自己判成"不稳定"。**稳定轮不打印任何东西**：稳定态的行为与加本机制之前一致。 */
  const snapBefore = snapshot.collectSnapshot();

  /* 管道能力探测：只影响"是否回放子进程输出到主控台"的观感。注意 **不能** 再让它影响结论 ——
     本 runner 现在无论有没有管道都把输出落文件后解析（见 runScript），所以两种环境不会出现两套账。 */
  const pipes = probePipes();
  const quiet = hasFlag('--tap') || hasFlag('--fast');
  if (!pipes.ok && !quiet) {
    console.log('  ⚠ 本环境禁止子进程管道（EPERM）—— 环境限制，不是脚本失败。');
    console.log('     各脚本输出仍会落 tests\\._verify\\run-all\\*.log 并解析出断言数，');
    console.log('     主控台照旧回放明细；想只看结论行请加 --tap 或 --fast。\n');
  }

  /* 体检（默认先跑；仅在自身退出码非 0 时提示，不阻断）。
     与门禁脚本同样走"落文件后解析"，不再分管道/安静两套分支。 */
  if (!hasFlag('--no-preflight')) {
    const preFile = path.join(env.paths.tests, 'preflight.js');
    const preLog = path.join(env.ensureDir(path.join(env.paths.verify, 'run-all')), `preflight-${process.pid}.log`);
    if (fs.existsSync(preLog)) { try { fs.rmSync(preLog, { force: true }); } catch { /* 忽略 */ } }
    const fd = fs.openSync(preLog, 'a');
    const pre = spawnSync(process.execPath, [preFile], {
      cwd: env.paths.root, timeout: 3 * 60 * 1000, stdio: ['ignore', fd, fd]
    });
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
    let preOut = '';
    try { preOut = fs.readFileSync(preLog, 'utf8'); } catch { preOut = ''; }
    if (!quiet && preOut) process.stdout.write(preOut);
    const preSum = parseSummary(preOut);
    if (pre.status === 0 && preSum) {
      console.log(`  [体检] 通过 ${preSum.passed} 项（跳过 ${preSum.skipped} 项）`);
    } else if (pre.status === 0) {
      console.log('  [体检] 关键项通过（未产出可解析的汇总行）');
    } else {
      console.log('  [体检] 未通过 —— 请先排查环境问题，再解读下面的脚本结果');
      /* `E88⒝` 的**孪生点**（同一处缺陷的另一份实现）：这里原本也是"硬截断 6 行"，
         而安静模式（`--tap` / `--fast`）**不回放**体检输出 ⇒ 这一段同样是唯一的指名入口。
         改用同一个 `pickDetailLines()`（它的过滤器还多认 `脚本异常终止`，能接住 `[脚本异常]` 那种裸栈）。
         对现状**无行为变化**（体检失败项 ≤ 4 条，远低于上限），只是不再有"排到第 7 行就丢指名"的余量。 */
      const prePicked = pickDetailLines(preOut);
      if (prePicked.lines.length) {
        console.log(prePicked.lines.map(l => '    ' + l).join('\n'));
        if (prePicked.dropped > 0) {
          console.log(`    …（体检明细已截断：保住全部 ${prePicked.named} 条指名行，另有 ${prePicked.dropped} 行未展开）`);
        }
      }
    }
    console.log(`     体检日志：${path.relative(env.paths.root, preLog)}`);
    console.log('');
  }

  /* ---------------- 执行（串行 by default；--jobs N 时先并行波、再串行尾） ----------------
     **结论口径不变**：两种模式产出的 results 集合、顺序、状态判定、落盘账本与收尾对账完全一致；
     并行只改"谁和谁同时跑"。串行路径（jobs=1）走的是**原封不动**的同步实现。 */
  const jobs = resolveJobs();
  const plan = scheduleSuites(suites, jobs);
  const results = [];
  const resultsByName = new Map();
  const startedAt = Date.now();

  const pushResult = (s, r) => {
    resultsByName.set(s.name, { suite: s, ...r });
    results.push({ suite: s, ...r });
  };

  /* ---------------- `E91` 截图候选图**前置刷新**（位置必须在并行波之前） ----------------
     为什么在这里：`screenshot-diff` 读的是候选目录里的 PNG 文件（不是当场截图），
     故"刷新"必须先于它 —— 放在这里就与 `--jobs N` 的调度无关（见 refreshCaptureBaseline 注释）。
     只在**本轮确实要跑 `screenshot-diff`** 时才刷新（`--only` 跑别的脚本时不白花这几十秒，
     也让 `harness-check` 第十五／十四节里那些嵌套的 `run-all --only …` 不受影响）。
     刷不出来 ⇒ 记一条 failed（fail-closed）：它会进"失败脚本明细"与最终退出码，
     但**不会**让进程崩掉 —— 后面各脚本照跑，读者能一次看全所有问题。 */
  if (suites.some(s => s.name === 'screenshot-diff')) {
    process.stdout.write('  前置刷新 capture-baseline（E91：截图门禁读取候选目录之前必须先刷新候选图）… ');
    const cap = refreshCaptureBaseline();
    console.log(`${cap.ok ? '通过' : '失败'} ${(cap.ms / 1000).toFixed(1)}s` + (cap.ok
      ? `（候选 ${cap.fresh} 张全部被本次刷新重写，目录 ${path.relative(env.paths.root, env.paths.captures)}）`
      : ` —— ${cap.reasons.join('；')}`));
    if (!cap.ok && !quiet && cap.out) process.stdout.write(cap.out);
    pushResult(CAPTURE_SUITE, {
      status: cap.ok ? 'passed' : 'failed',
      detail: cap.ok ? '' : `候选图未刷新（fail-closed）：${cap.reasons.join('；')}`,
      ms: cap.ms,
      /* 这一行刻意做成**单行**且带 `[FAIL]`：`tail()` 的明细过滤按 `[FAIL]` 命中 ⇒ 失败原因
         必定出现在"失败脚本明细"里（`E88⒝` 之后仍保证点名）。 */
      out: cap.ok ? '' : `  [FAIL] capture-baseline 前置刷新（E91）—— 候选图未刷新（fail-closed）：`
        + `${cap.reasons.join('；')}。处置：确认 Edge 可用（见 preflight 第四节）后手工跑`
        + ' `node tests\\capture-baseline.js --out tests\\._verify\\captures`；在此之前'
        + ' `screenshot-diff` 的"绿"没有依据（E91/E92）',
      summary: null,
      logFile: cap.logFile,
      exit: cap.ok ? 0 : 1
    });
    console.log(`     刷新日志：${path.relative(env.paths.root, cap.logFile)}`);
    console.log('');
  }

  if (plan.parallel.length) {
    console.log(`  ▶ 并行波 ${plan.parallel.length} 个（并发 ${plan.jobs}）：${plan.parallel.map(s => s.name).join('、')}`);
    if (plan.serial.length) console.log(`  ▶ 串行尾 ${plan.serial.length} 个（对并发敏感，必须最后跑）：${plan.serial.map(s => s.name).join('、')}`);
    console.log('');
    if (quiet) plan.parallel.forEach(s => process.stdout.write(`  运行 ${s.name.padEnd(20)} … `));

    const buffers = new Map();
    const wave = await runPool(plan.parallel, plan.jobs, async (s) => {
      const sink = [];
      buffers.set(s.name, sink);
      const r = await runScriptAsync(s, pipes.ok, quiet, quiet ? null : sink);
      /* 非安静模式：该脚本的输出在它**跑完时**整段回放（并行时不能边跑边写，否则多脚本明细交错） */
      if (!quiet && sink.length) process.stdout.write(sink.join(''));
      if (quiet) {
        const mark = { passed: '通过', failed: '失败', skipped: '跳过', error: '异常', unverified: '未核实' }[r.status];
        const sum = r.summary ? `（通过 ${r.summary.passed} / 失败 ${r.summary.failed} / 跳过 ${r.summary.skipped}）` : '';
        process.stdout.write(`${mark} ${(r.ms / 1000).toFixed(1)}s ${sum}\n`);
      } else {
        const mark = { passed: '通过', failed: '失败', skipped: '跳过', error: '异常', unverified: '未核实' }[r.status];
        const sum = r.summary ? `（通过 ${r.summary.passed} / 失败 ${r.summary.failed} / 跳过 ${r.summary.skipped}）` : '';
        console.log(`${mark} ${(r.ms / 1000).toFixed(1)}s ${sum}${r.detail ? ' ' + r.detail : ''}`);
      }
      return { suite: s, ...r };
    });

    /* 账本按 **SUITES 原顺序** 落盘：writeRunTotals 的语义是"截至此刻已经跑完哪些脚本"，
       并行下完成顺序是乱的，按原顺序重建可让 `docs-cross-check` 读到的账与串行完全同形。 */
    wave.forEach(r => resultsByName.set(r.suite.name, r));
    const ordered = () => plan.parallel.map(s => resultsByName.get(s.name)).filter(Boolean);
    for (const r of ordered()) results.push(r);
    writeRunTotals(results);
  }

  /* 串行尾（以及 jobs=1 时的全部）：逐条跑，每跑完一条就更新落盘（保留 P2-22 的单向契约） */
  for (const s of plan.serial) {
    if (quiet) process.stdout.write(`  运行 ${s.name.padEnd(20)} … `);
    else console.log(`\n  ── 运行 ${s.name}（${s.desc}）──`);
    const r = runScript(s, pipes.ok, quiet);
    pushResult(s, r);
    const mark = { passed: '通过', failed: '失败', skipped: '跳过', error: '异常', unverified: '未核实' }[r.status];
    const sum = r.summary ? `（通过 ${r.summary.passed} / 失败 ${r.summary.failed} / 跳过 ${r.summary.skipped}）` : '';
    console.log(`${mark} ${(r.ms / 1000).toFixed(1)}s ${sum}${r.detail ? ' ' + r.detail : ''}`);
    /* **每跑完一个就更新落盘**，而不是等收尾 —— 因为 `docs-cross-check` 本身是 suite 成员，
       它要在自己运行时读到"截至此刻的实跑账"，等收尾写就永远读到上一轮的旧账（P2-22）。
       `docs-cross-check` 是**离线门禁**里的最后一个，故它运行时账本已含并行波的全部结果
       ＋ `docs-check`／`files-check`；`E70③` 之后尾段在它后面还有三个浏览器/CDP 脚本，
       但那些 **不** 是它的账目来源（它不是按全量 SUITES 比对 —— 那由本 runner 收尾做）。 */
    writeRunTotals(results);
  }

  /* 与串行模式逐字一致的"总耗时"参考（并行下墙钟 < 各脚本之和，属预期）。
     `E91` 之后 `startedAt` 取在**前置刷新之前** ⇒ 这条墙钟**含**候选图刷新那一段，
     与"各脚本之和"（刷新那条也按 ms 计进 results）同口径。 */
  if (jobs > 1) {
    const sumMs = results.reduce((a, r) => a + (r.ms || 0), 0);
    console.log(`\n  ⏱ 并行模式耗时：墙钟 ${((Date.now() - startedAt) / 1000).toFixed(1)}s ｜ 各脚本之和 ${(sumMs / 1000).toFixed(1)}s ｜ 并发 ${plan.jobs}`);
  }

  /* 安静模式：把各脚本日志路径列出来，保证输出仍可查阅（不隐藏信息） */
  if (quiet) {
    const logs = results.filter(r => r.logFile).map(r => r.logFile);
    if (logs.length) {
      console.log('\n  子进程输出已落文件（安静模式不逐条回放；需要明细时直接看这些文件）：');
      for (const p of logs) console.log(`    ${path.relative(env.paths.root, p)}`);
    }
  }

  /* ---------------- 汇总 ---------------- */
  const failed = results.filter(r => r.status === 'failed' || r.status === 'error');
  const skipped = results.filter(r => r.status === 'skipped');
  const unverified = results.filter(r => r.status === 'unverified');
  const passedScripts = results.filter(r => r.status === 'passed');
  const agg = results.reduce((a, r) => {
    if (r.summary) { a.passed += r.summary.passed; a.failed += r.summary.failed; a.skipped += r.summary.skipped; }
    return a;
  }, { passed: 0, failed: 0, skipped: 0 });

  console.log('\n=== 各脚本结果 ===');
  for (const r of results) {
    const sum = r.summary ? `${r.summary.passed} / ${r.summary.failed} / ${r.summary.skipped}` : '— / — / —';
    const mark = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP', error: 'ERR ', unverified: '??? ' }[r.status];
    console.log(`  ${mark}  ${r.suite.name.padEnd(20)} ${sum.padStart(12)}   ${r.suite.desc}`);
  }

  console.log('\n=== 合计 ===');
  if (agg.passed + agg.failed + agg.skipped > 0) {
    console.log(`  断言：通过 ${agg.passed} / 失败 ${agg.failed} / 跳过 ${agg.skipped}`);
    console.log('        （数字由各脚本输出落文件后解析得出；逐条明细见下表日志路径）');
  } else {
    console.log('  断言：**本次未采集**（各脚本输出里都没有可解析的汇总行）');
    console.log('        ⇒ 各脚本的权威数字见 tests\\README.md 第三节。');
  }
  console.log(`  脚本：${passedScripts.length} 通过 / ${failed.length} 失败 / ${skipped.length} 跳过${unverified.length ? ` / ${unverified.length} 未核实` : ''}`);
  if (skipped.length) {
    console.log(`  跳过脚本（环境不满足，**不是通过**）：${skipped.map(r => r.suite.name).join(', ')}`);
  }
  if (unverified.length) {
    console.log(`  未核实脚本（退出码 0 但拿不出"跑过断言"的证据，**不是通过**）：${unverified.map(r => r.suite.name).join(', ')}`);
  }

  /* 不通过时的理由：保留"未核实"与"跳过"的区别，便于定位 */
  if (unverified.length) {
    console.log('\n未核实明细：');
    for (const r of unverified) console.log(`  ── ${r.suite.name}：${r.detail}`);
  }

  /* ---------------- 权威数字校验与工作区稳定性复核 ----------------
     **位置很关键（2026-09-20 修正）**：必须放在下面 `if (failed.length)` 提前退出**之前**。
     原实现把它放在"全绿收尾"段里，而 `docs-check` 因 2 项 6.4 已登记偏差**永远失败**，
     于是这段校验从来没有执行过一次 —— 机制在源码里，但不可达（与 ADR-0004 要堵的
     "通过数字 ≠ 已验证"同类：**"写了机制" ≠ "机制在跑"**）。
     不可达性由 `harness-check` 的静态断言守着（调用点必须在提前退出之前）。

     **工作区稳定性复核（2026-09-20 新增）先于对账**：若本轮运行期间工作区被改写，结论本身
     就不是证据，此时再拿它去比 `tests\README.md` 的权威数字，只会把"文件正在被写"读成
     "权威区漂移"，进而误改权威区。故不稳定轮**根本不比对**（既不打印任何比对口径行，
     也不打印"对账成功"）。快照范围与排除规则见 `tests\lib\snapshot.js`；判定是纯函数，
     真值表见 harness-check 第十二节。`snapshot.collected === false`（目录读不到 / 采集出错）
     按"拿不出证据"处理 —— 不许因为"拿不到证据"就默认稳定（规范 9.5-5 第 6 条）。 */
  const snapAfter = snapshot.collectSnapshot();
  const rewriteChanges = snapshot.diffSnapshots(snapBefore, snapAfter);
  const snapshotProblem = snapBefore.collected ? '' : (snapBefore.reason || '基线快照采集失败');
  const snapshotProblem2 = snapAfter.collected ? '' : (snapAfter.reason || '结束快照采集失败');

  const auth = verifyAuthorityTotals(agg, results);
  /* `verifyAuthorityTotals` 在账目不完整时**不比对** —— 此刻若再叠加"工作区被改写"，
     就把它的口径改写为"未执行"，避免出现自相矛盾的输出（既说账目不完整、又说在比数）。 */
  if (rewriteChanges.length > 0 || snapshotProblem || snapshotProblem2) {
    const why = snapshotProblem ? `快照不可用（${snapshotProblem}）`
      : snapshotProblem2 ? `快照不可用（${snapshotProblem2}）`
        : `本轮运行期间工作区被改写（${rewriteChanges.length} 个文件）`;
    auth.kind = 'skipped';
    auth.ok = false;
    auth.detail = `**未执行**：${why} —— 本轮结论不可作为证据，**未与权威数字比对**`;
  }
  const changedForVerdict = (snapshotProblem || snapshotProblem2)
    ? [{ path: `快照不可用：${snapshotProblem || snapshotProblem2}`, kind: 'changed' }]
    : rewriteChanges;
  const verdict = resolveGateOutcome(changedForVerdict, auth);
  /* 最终退出码 = "脚本层面有没有失败/未核实" **与** "判定层面过没过" 的组合（见 finalExitCode）。
     只取其中一半就是本次要修的回归：只看 `verdict.exitCode` 会把"有 FAIL"的轮次退成 0。 */
  const finalCode = finalExitCode({ failed, unverified, verdict });
  /* 有失败脚本、但判定层面（稳定性 + 对账）仍然判过（典型：失败项**仅为已登记偏差**）时，
     必须**明写**为什么最终仍退 1 —— 否则读者只看到"权威数字校验：合计一致"会以为全绿。 */
  const failedNote = (failed.length > 0 && verdict.exitCode === 0)
    ? `\n门禁未全绿：失败项仅为已登记偏差（${failed.map(r => r.suite.name).join('、')} N 项；`
      + '见 PROJECT_RULES 6.4）—— 按规范 9.5-5 仍退 1。'
    : '';
  /* 不稳定轮**不打**权威数字校验那一行 —— 无论那一行写什么都容易被读成"比过了"（T2 既有设计，
     2026-09-20 由静态断言守着：`verdict.unstable ? ''`）。稳定轮则**一律打印**（含全绿轮）：
     旧实现只在失败分支打印它，绿轮把它丢掉，于是"这一轮到底核过没有"只能靠证据状态文字去猜 ——
     与"有 FAIL 却报全绿"是同一处重构留下的两个缺口。位置固定在证据状态行之前。
     写出口径说明：用 `fs.writeSync(1, …)` 直写 stdout（与下方 child 日志同一手法）。
     原因（2026-09-21 实测）：这一行是本轮**唯一的对账口径**，必须在任何环境下都落得下来；
     而同一位置的 `console.log(authLine)` 在 `--only` 子集轮里**没有产出任何字节**
     （同一分支内相邻的 `console.log(\`\\n${verdict.evidence}\`)` 却正常打印，钩住
     `console.log` 与 `fs.writeSync` 都观测不到它），换成直写后实测稳定可见。 */
  const authLine = verdict.unstable ? '' : `\n权威数字校验：${auth.detail}`;

  /* 失败明细只打一遍：合并进下面那一份（P2-22 修正之后 **不应**在权威校验处提前退出，
     否则会抢在"失败脚本明细"之前退出，把真正的失败原因盖掉）。 */
  const tail = () => {
    if (failed.length) {
      console.log('\n失败脚本明细（每个脚本的最关键几行；`E88⒝`：指名行**不因截断消失**）：');
      for (const r of failed) {
        const picked = pickDetailLines(r.out === undefined ? '' : r.out);
        console.log(`\n  ── ${r.suite.name} ──`);
        console.log(picked.lines.map(l => '  ' + l).join('\n') || '  （无失败行可解析，请单独运行该脚本）');
        if (picked.dropped > 0) {
          console.log(`  …（明细过长：已**保住全部 ${picked.named} 条指名行**，本段共打印 ${picked.lines.length} 行，`
            + `另有 ${picked.dropped} 行未展开 —— 完整输出：`
            + `${r.logFile ? path.relative(env.paths.root, r.logFile) : '（无日志文件）'}）`);
        }
      }
      console.log('\n提示：单独复跑某个脚本：node tests\\<名称>.js');
      console.log(`\n本次各脚本输出已落盘：${path.relative(env.paths.root, path.join(env.paths.verify, 'run-all'))}\\`);
    }
    if (unverified.length) {
      console.log('\n提示：未核实项说明脚本没给出可核实的结论（通常是不该退 0 却退了 0），须先修脚本。');
    }
    if (skipped.length) {
      console.log('\n提示：以上跳过项需在具备浏览器/命名管道权限的环境复跑，详见 tests\\README.md 第四节。');
    }
  };

  if (finalCode !== 0) {
    /* 不稳定轮：`authLine` 为空串，故这里不会打印对账行（T2 的冻结行为，由静态断言守着）。 */
    if (failedNote) console.log(failedNote);
    if (authLine) fs.writeSync(1, authLine + '\n');
    if (verdict.unstable) console.log(verdict.detail);
    else for (const line of verdict.titles) console.log(line);
    tail();
    console.log(`\n${verdict.evidence}`);
    if (verdict.unstable) {
      /* **结论行 token 统一**（2026-09-22 座位 R 立案；修 `harness-check` 第十四节那条端到端断言的偶发假红）：
         四句"不通过"结论行共用**同一个机器可读 token**`门禁结论：不通过`。本句原先写作
         `门禁结论：**本轮不通过**（…）` —— 于是任何按 token 读日志的消费者（首当其冲是
         `tests\harness-check.js` 那条搜 `门禁结论：不通过` 的端到端断言）在"本轮工作区被改写"
         这类轮次上**取不到结论**，变成假红。实测：N=20 次 `--only docs-check`（并发写方在改
         `tests\ui-check.js`）4 次取不到；而每次日志尾部**完整且以 `\n` 结尾** ⇒ 根因**不是**
         `console.log` 被 `process.exit` 截断（见上方 `authLine` 那段直写说明），而是**措辞分支不统一**。
         语义一字未减：仍写明"本轮结论不可作为证据"与"工作区在运行期间被改写"。 */
      console.log('门禁结论：不通过（**本轮结论不可作为证据**：工作区在运行期间被改写）。');
    } else if (verdict.exitCode !== 0) {
      console.log('门禁结论：不通过（详见上面的失败原因）。');
    } else {
      /* 走到这里：判定层面（稳定性 + 对账）是过的，不通过的只有脚本层面的 failed/unverified。 */
      console.log('门禁结论：不通过（有失败/未核实脚本，见上面的明细）。');
    }
    process.exit(finalCode);
  }

  tail();

  /* **稳定轮一律打印权威对账行**（含全绿轮）：这是"本轮到底核过没有"的唯一口径行。
     不稳定轮在 `authLine` 处已被置空，故此处不会打印（T2 的冻结行为不变）。
     位置固定在证据状态行之前 —— 让"核过什么"先于"证据状态"出现，避免读者只看结论文字。 */
  if (authLine) fs.writeSync(1, authLine + '\n');

  /* `finalCode === 0` 意味着**失败与未核实集合都为空**（`finalExitCode` 的判据），
     且判定层面也退 0。注意这里**不能**只写"没失败"就完事：`verdict.exitCode === 0` 只覆盖
     "工作区稳定 + 权威数字对账通过"这一段，脚本层面的通过与否由 `failed`/`unverified` 决定 ——
     旧注释（"到这一步说明本轮已经'没失败'了"）把两者的来源混为一谈，正是回归的温床。
     证据标签放在最后一行，保证"稳定"是被记录下来的事实，而不是"没打印东西"的默认解读。 */
  console.log(`\n${verdict.evidence}`);

  /* 收尾：清掉 24 小时前的临时区残留（P2-16 —— `harness.cleanup()` 此前只被"测试存在"，
     从未在真实运行里被调用过；放在全绿收尾处，既不干扰本轮用例，又能防止临时目录无限堆积）。
     `E90`（2026-10-03）后清扫对象＝**公共根** `tests\._verify\tmp`（`env.paths.tempRootBase`）
     下的**整轮目录** `run-<pid>-…` —— 本轮自己的那一轮目录刚建（mtime 新）绝不被它命中，
     另一路正在跑的整轮目录也不会（除非已过期 24 h）。**不要**改成 `cleanup(true)`：
     那正是 `E90` 的病灶（把"另一轮正在用的产物"当垃圾删）。 */
  try {
    const { cleanup } = require('./lib/harness');
    const swept = cleanup(false);
    if (swept && swept.removed > 0) {
      console.log(`\n  临时区收尾：清理 24 小时前的残留 ${swept.removed} 个整轮目录（保留 ${swept.kept} 个：本轮与其它仍在用的轮次）`);
    }
  } catch (err) {
    console.log(`\n  临时区收尾失败（不影响门禁结论）：${err && err.message}`);
  }

  /* "门禁全绿"这句是**结论**，只能贴在真正全绿上：显式包在"失败与未核实都为空"里，
     并由 `harness-check` 第十四节静态断言守住可达性（不许只靠上面那个提前退出"顺便"保证）。 */
  if (failed.length === 0 && unverified.length === 0) {
    console.log('\n门禁全绿（无失败脚本）。');
  } else {
    /* 理论不可达（上一处提前退出已退 1）；留着是为了"这句永不被无条件打印"。 */
    console.log(`\n门禁结论：不通过（有失败/未核实脚本 ${failed.length + unverified.length} 项）。`);
    process.exit(1);
  }
  process.exit(0);
}

/* 被 require 时**不执行**：`harness-check` 要直接引用 classify/parseSummary/authorityBlockers/
   REGISTERED_DEVIATIONS 做规则回归，不能因为 require 一下就把全部门禁跑一遍。 */
module.exports = { classify, parseSummary, isEnvSkip, SUITES, verifyAuthorityTotals, authorityBlockers,
  REGISTERED_DEVIATIONS, failedAssertionNames, resolveGateOutcome, finalExitCode,
  /* `E88⒝` 的明细选取是纯函数 ⇒ 一并导出，供定点回归直接调用（判据见该函数注释） */
  pickDetailLines, DETAIL_MAX_LINES, CAPTURE_SUITE,
  /* `E99` 的账本路径判定是纯函数 ⇒ 一并导出（主账本名也在内），供定点回归直接调用
     —— 判据：①全量 ⇒ 主账本；②`--only` ⇒ 自己的账本且**不是**主账本；③`--ledger` ⇒ 显式值优先。 */
  resolveLedgerFile, MAIN_LEDGER_NAME };

if (require.main === module) {
  main().catch(err => {
    console.error('\nrunner 异常终止：' + (err && err.stack ? err.stack : err));
    process.exit(2);
  });
}
