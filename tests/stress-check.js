/* ==========================================================================
   长时间运行稳定性自检（tests/stress-check.js）
   作用：把看板挂在无头 Edge 里跑一段时间并周期采样，回答"能不能长时间挂着"：
         S1 页面是否一直活着（时钟每轮都在推进、无未捕获异常、无 console.error）
         S2 JS 堆是否无界增长（Chromium 的 performance.memory.usedJSHeapSize 趋势）
         S3 DOM 是否膨胀（元素总数、标签按钮数、激活面板数是否稳定）
         S4 整班次业务面：跨班次时 班次名/统计/曲线/待补传队列如何变化（**需 --hours 8**）
         S5 周期性负载：8 个页面轮一遍 + 两次断连/恢复（第 1 轮必跑，其后每小时一次）
   运行（**默认＝有限时长**，够门禁在一轮里跑完；整夜浸泡改为显式参数）：
         node tests/stress-check.js                                   # 默认 2 分钟、预期 3 个采样点
         node tests/stress-check.js --soak                            # 整班次浸泡（＝ --hours 8）
         node tests/stress-check.js --hours 8                         # 显式浸泡小时数
         node tests/stress-check.js --hours 168                       # **AC-07 的"≥7 天"**（7×24 h、真实时钟）
         node tests/stress-check.js --minutes 2 --interval-min 0.5    # 快速自检（机制验证用，非门禁）
         node tests/stress-check.js --verify-soak <台账.jsonl>        # AC-07 判据（不起浏览器，退 0/1）
         node tests/stress-check.js --help                            # 用法
   可选环境变量（与 CLI 同时给时 **CLI 优先**）：
         DSH_STRESS_HOURS=8          浸泡小时数（**给了它就按浸泡跑**，与 CLI --hours 同义）
         DSH_STRESS_INTERVAL_MIN=2   采样间隔（分钟；可为小数，便于快速自检）
         DSH_STRESS_SIZE=3840x2160   视口尺寸
         DSH_STRESS_EDGE=<path>      指定 msedge.exe
         DSH_STRESS_DAY_SECONDS=<S>  "证据日"长度（秒；见下面"证据日与留证"；缺省 86400）
   判据（**真断言计数**；runner 解析标准汇总行 `通过 N 项，失败 M 项，跳过 K 项`）：
         · **计划类（2 条，任何时长都跑）**：实际墙钟 ≥ **请求时长** − 90 s（"时长参数被遵守"）、
           采样点数 == floor(时长/间隔)+1；
         · **通用 8 条（任何时长都跑）**：采样成功率 / 时钟推进 / 标签数恒定 / 单激活面板 /
           无未捕获异常与 console.error / 堆增长 / DOM 增长 / 周期性负载至少 1 次且无失败；
         · **长跑专属 3 条（默认时长下计入"跳过"，**不是**假装通过；理由：需 `--hours 8`）**：
             ① S4 跨班次：班次名 ≥ 2 种且末次采样曲线已固化
             ② S5 周期性负载按小时重复 ≥ 2 次
             ③ 采样窗口 ≥ 1 小时（≥ 6 个采样点）
         · **自洽 1 条**：跳过项数 == 长跑专属判据条数（默认模式）/ 0（浸泡模式）
           —— 防"把长跑判据悄悄改成通过"（改错这条会红）。
         ⚠ 这 14 条回答的是"**挂了这么久稳不稳**"，**与 AC-07 的"连续 ≥7 天"不是一回事**：
           AC-07 另有一套判据（见下），判的是**证据日台账**，并且必须**另外**具备 ≥7 天真实时钟的留证。
         ⚠ "采样点数 == floor(时长/间隔)+1"现在是**按绝对时刻表**采样的（不是"睡满一个间隔"）：
           否则负载/采样自身耗时会在长跑里累计成漂移 —— 实测 8 h 档差 0～1 点、168 h 档差约 13 点，
           那条判据就会从"采样计划被遵守"退化成"看运气"。错过的采样点**不补采**，
           缺口如实记进证据日的 `maxGapSec`（由 AC-07 的判据④判）。

   ---------------------------------------------------------------------------
   **证据日与留证（`P-3`，`T-20261006-04`）** —— "≥7 天"可执行、可留证的那一半。
   ---------------------------------------------------------------------------
   ① **证据日**＝一个长度固定的墙钟区间（默认 **86400 s**，可用 `--day-seconds <S>` 或
      `DSH_STRESS_DAY_SECONDS` 压成 S 秒）。**每跨过一个证据日就向台账追加一行 JSON**，
      进程退出时补最后一行（可能 `partial:true`）。
   ② **台账**：`--soak-ledger <path>` 指定；缺省 `tests\._verify\soak\soak-<启动时刻>.jsonl`。
      **逐行 `fs.writeSync` ＋ `fs.fsyncSync` 落盘**（不攒内存 —— 7 天里进程随时可能被杀）；
      首行 `meta`（计划时长／证据日长度／采样间隔／**是否压缩时钟**／脚本 sha256），
      其后每行一个证据日（字段见 `closeDay()`）。
   ③ **压缩时钟（只作机制自检，绝不作 AC-07 证据）**：`--day-seconds 1` 把"一天"压成 1 s，
      于是十几秒就能跑出 ≥7 个证据日、把**留证与判据的机器**验证一遍。
      **压缩档一律在输出与每一行 jsonl 里显式标注** `clockCompressed:true` ＋ `daySeconds:S`
      —— 判据⑤据此**判红**（ADR-0010 D2"三档可作证性"：压缩时钟的读数不是 AC-07 的证据；
      要拿它作机制自检，必须显式加 `--allow-compressed`）。
   ④ **内存读数**：按证据日长度**按比例**取 `process.memoryUsage()`（真实档＝每小时一次，
      压缩档＝`daySeconds/24` 一次），逐日行给 `rssMin/max/lastBytes` ＋ `heapUsedLastBytes`。
   ⑤ **采样连续性**：逐日行给 `maxGapSec`＝本证据日内相邻观测（含该日的起止端点）的最大间隔。

   ---------------------------------------------------------------------------
   **AC-07 判据（`P-2`，`T-20261006-04`）** —— "通过"＝下面 5 条**全部成立**；判据本体是
   `verifySoakLedger()`（**纯函数**：只读台账、不碰文件系统，故可在合成样本上定点变异）。
         · ① **连续 ≥7 天无重启**：**完整**证据日 ≥ 7；逐日链连续（相邻行 `dayStartIso` ≈ 上一行
           `dayEndIso`，容差 max(2 s, 采样连续性阈值)）；`dayIndex` 逐行 +1；`uptimeSec`
           **严格递增**；`restarts === 0`；`closedAtIso` 落在该日结束后的一个采样窗内。
         · ② **无崩溃**：末行 `runComplete === true` ∧ `exitReason === 'completed'` ∧
           实到（`uptimeSec`）≥ 计划 − **90 s**（与"时长参数被遵守"同源）；`errorCount === 0`
           （未捕获异常与 console.error 逐日如实累计）。
         · ③ **无内存泄漏**：末日 `rssMaxBytes` ≤ 首日 `rssMaxBytes` × **1.25** ∧ `rssMaxBytes`
           **不呈严格单调上升**（K 的取法见 `SOAK_RSS_GROWTH_K`：太松会放过慢泄漏、太紧会假红）。
         · ④ **采样连续性**：每个证据日 `maxGapSec` ≤ **3 × 采样间隔 + 30 s**（容忍漏采 1～2 个点
           与调度抖动；连着漏 3 个即红。依据见 `SOAK_GAP_FACTOR`／`SOAK_GAP_SLACK_SEC`）。
         · ⑤ **可作证性**：`clockCompressed === false` ∧ `daySeconds === 86400` —— 压缩时钟的台账
           **只作机制自检**（`--allow-compressed` 跳过本条，并在输出里显式声明"非 AC-07 证据"）。
   ⚠ **判据存在 ≠ AC-07 已满足**（`E62`：建表 ≠ 功能覆盖）：本轮**没有** ≥7 天真实时钟的留证
   （`--hours 168` 要连续跑 7 天，泡机期间任何代码改动都作废该轮），故 `tests\trace-check.js`
   第六节仍如实记 `declared-gap`。

   产物：tests/._verify/stress-<时间戳>.csv（逐次采样）
         tests/._verify/stress-<时间戳>.log（进度日志）
         tests/._verify/stress-<时间戳>-summary.json
         tests/._verify/stress-<时间戳>-start.png / -end.png（首末截图）
         tests/._verify/soak/soak-<启动时刻>.jsonl（**证据日台账**；`--soak-ledger` 可改路径）
   权限：与 browser-check.js 相同——Chromium 需要正常创建命名管道/进程的权限；
         受限沙箱下会以 mojo platform_channel 拒绝访问 ⇒ 整脚本 SKIP（退 3），不产出汇总行。
   退出码：0 = 判据通过（跳过项不影响）；1 = 有判据不通过；2 = 脚本自身异常；3 = 环境不满足（整脚本跳过）。
          `--verify-soak` 模式：0 = 5 条判据全过；1 = 有判据不通过。**该模式不打标准汇总行**
          （它不是一个门禁轮，避免被 runner／人读成"门禁全绿"）。
   记账自检：本文件导出 `resolvePlan()` / `evaluateCriteria()` / `summaryLine()` /
             `resolveSoakClock()` / `parseSoakLedger()` / `verifySoakLedger()` **纯函数**，
             可在没有浏览器的环境里对"时长参数被遵守 / 跳过项如实 / 汇总行可被 runner 解析 /
             证据日台账可判"做定点验证（`tests\._verify\T-20261006-04\` 的两个探针即调用它们）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const env = require('./env');

/* D16 硬要求：Node 版本下限 + 拒绝在 prod 下运行（统一出口，见 tests/env.js） */
env.assertRuntime();

const ROOT = path.resolve(__dirname, '..');
const PAGE = pathToFileURL(path.join(ROOT, 'index.html')).href;
const OUT = path.join(ROOT, 'tests', '._verify');

/** 默认时长（分钟）：**有限时长**，门禁一轮跑得完；整夜浸泡走 `--soak` / `--hours 8`。
 * **为什么是 2 分钟**（2026-09-29 负责人追问"能不能再缩"，主代理实测后定）：
 *   ①本脚本是**全量墙钟的地板** —— 并行模式下全轮 335 s 里它独占 301.7 s（约 90%），
 *     串行模式 453 s 里占 67%；不缩它就只能在"并行重叠"上再挖（已被 `--jobs` 用掉）。
 *   ②**判据结构决定它不该按分钟计价值**：11 条断言全是"**首点 vs 末点**"比较（堆增长、DOM 增长、
 *     时钟推进、标签数恒定、面板独占），**没有"窗口越长越强"的判据**；3 条真正需要长跑的判据
 *     本来就只有 `--hours 8` 才生效（默认下如实计跳过）。
 *   ③所以取"**减半时长、同步减半间隔**"：5min/2min → **2min/1min** ⇒ **采样点数仍为 3**，
 *     窗口 5 min → 2 min，单轮省 **约 180 s**。**这不是削减覆盖，是保持采样密度而缩短窗口**。
 *   ④口径边界（不许含糊）：本脚本默认档是**回归冒烟**；`NFR-05` 的 72 h 与 `AC-07` 的 ≥7 天
 *     **靠 `--hours 168`（＝7×24 h）单独跑并留证**（`--soak` / `--hours 8` 只是"整班次"档），与默认档无关；**8 h 也不等于 7 天**（见文件后半的"证据日与留证"与 `--verify-soak` 的判据①）。 */
const DEFAULT_MINUTES = 2;
/** 默认采样间隔（分钟）：与 `DEFAULT_MINUTES` 配套 ⇒ `floor(2/1)+1 = 3` 个采样点
 * （20/10 与 5/2 同为 3 点 ⇒ 三代默认档的**采样点数一致**，只有窗口长度不同）。 */
const DEFAULT_INTERVAL_MIN = 1;
/* ⚠ 这一行必须保留 `DSH_STRESS_HOURS || 8` 的字面形态：tests\trace-check.js 的 AC-07 断言
   用正则 `DSH_STRESS_HOURS\s*\|\|\s*(\d+)` 从本文件取"浸泡默认时长"，据此判"8 h 不构成 7 天证据"。
   同时它也是本脚本的浸泡预设（`--soak` ≡ `--hours 8`）。 */
const SOAK_HOURS = Number(process.env.DSH_STRESS_HOURS || 8);
const SOAK_ONLY_MIN = SOAK_HOURS * 60;
/* ---------------- 证据日台账与 AC-07 判据的常量（`T-20261006-04`；判据读的**就是**这些值） ----------------
   ⚠ 这一组常量是"AC-07 怎么算过"的**唯一真源** —— `verifySoakLedger()` 与文件头注释都必须与它一致
   （`D21`：不许在第二处再写一份数）。 */

/** 真实证据日长度（秒）：86400 s ＝ 24 h。压缩档只改"机器自检用的时钟"，**不改这个真值** */
const REAL_DAY_SEC = 86400;
/** AC-07 的天数下限（需求原文"连续运行 ≥7 天"） */
const SOAK_MIN_DAYS = 7;
/** ③ 内存判据的倍数上限 K：**末日 rssMaxBytes ≤ 首日 rssMaxBytes × K**。
 *  为什么是 **1.25**（三个候选都实际算过账）：
 *   · **太紧**（如 1.05）：无头 Chromium 的 RSS 含 V8 堆之外的映射/缓存，正常抖动段就有几个百分点
 *     到十几个百分点（本机 2 分钟档实测 JS 堆平坦 9.5 MB，但那不是 RSS）⇒ 会制造**假红**；
 *     7 天一轮的假红要整轮作废重跑，代价极高。
 *   · **太松**（如 2.0）：一个"每天涨 10%"的真泄漏在 7 天后是 1.95× —— 会被放过。
 *   · 1.25 允许 7 天里**累计 25%** 的分配器/mmap 抖动，同时挡住"每天涨 ≥3.3%"的慢泄漏
 *     （1.033^7 ≈ 1.25）。**它不是"内存没泄漏"的证明**，而是一条**可证伪的下限判据**：
 *     真泄漏只要持续增长，末日的 rssMax 必然越界（D22 的㈡支＝"末日翻倍 ⇒ 必红"）。 */
const SOAK_RSS_GROWTH_K = 1.25;
/** ④ 采样连续性：`maxGapSec ≤ SOAK_GAP_FACTOR × 采样间隔 + SOAK_GAP_SLACK_SEC`。
 *  依据：**漏采 1～2 个采样点**（间隔 ×2／×3）必须容忍（CDP 单次求值偶发慢、GC/换页停顿）；
 *  **连着漏 3 个以上**必须红（那已经不是"抖动"而是"采样停了"）⇒ 阈值取 3×间隔，
 *  再加 30 s 固定余量吸收调度抖动与时间戳取整（真实档间隔 60 s ⇒ 阈值 210 s；压缩档间隔 6 s ⇒ 48 s）。 */
const SOAK_GAP_FACTOR = 3;
const SOAK_GAP_SLACK_SEC = 30;
/** ① 逐日链容差：`|dayStartIso(i) − dayEndIso(i−1)| ≤ max(2 s, 采样连续性阈值)`。
 *  台账里两个时刻**本来就取自同一根边界**（见 `closeDay()`）⇒ 合规证据的差**恒为 0**；容差
 *  **绑在采样连续性阈值上**（＝3 × 采样间隔 + 30 s，真实档 210 s），三条理由：
 *   · 不另立第二个口径（`D21`）——"链断"与"采样断"本来就是同一件事的两种表现；
 *   · 够宽以吸收取整/浮点噪声，又**窄到能抓住拼接/重启**（真重启换 t0 ⇒ 差是秒到天量级）；
 *   · **不用"证据日的百分之几"**：5% × 86400 s ＝ 72 min，会把一次拼接读成"连续"（实测过）。 */
const SOAK_CHAIN_TOL_SEC = 2;
/** ② "计划 vs 实到"的容差（秒）：与运行档判据"墙钟 ≥ 请求时长 − 90 s"**同源**（不写第二份口径） */
const SOAK_CRASH_TOL_SEC = 90;

/** AC-07 的 5 条判据名（判红/跳过**都指名到第几条**；`E62` 教训：建表 ≠ 功能覆盖） */
const SOAK_CRITERIA_NAMES = Object.freeze([
  '① 连续 ≥7 天无重启（完整证据日 ≥7 ＋ 逐日链连续 ＋ dayIndex 逐行 +1 ＋ uptimeSec 严格递增 ＋ restarts === 0）',
  '② 无崩溃（末行 runComplete ∧ exitReason=completed ∧ 实到 ≥ 计划 − 90 s，且 errorCount === 0）',
  '③ 无内存泄漏（末日 rssMaxBytes ≤ 首日 rssMaxBytes × 1.25 且 rssMaxBytes 不呈严格单调上升）',
  '④ 采样连续性（每个证据日 maxGapSec ≤ 3 × 采样间隔 + 30 s）',
  '⑤ 可作证性（clockCompressed === false 且 daySeconds === 86400；压缩时钟不作 AC-07 证据）'
]);
/** 判据序号（1 起；与 `SOAK_CRITERIA_NAMES` 一一对应，判红时逐条指名） */
const SOAK_CRITERION_TAGS = Object.freeze(['①', '②', '③', '④', '⑤']);


/** 长跑专属判据的**名字常量**（跳过/检查两处共用一份，口径不会分叉） */
const SOAK_ONLY_NAMES = Object.freeze([
  'S4 跨班次：班次名 ≥ 2 种且末次采样曲线已固化（需 --hours 8）',
  'S5 周期性负载按小时重复 ≥ 2 次（需 --hours 8）',
  '采样窗口 ≥ 1 小时（≥ 6 个采样点）（需 --hours 8）'
]);

const SIZE = String(process.env.DSH_STRESS_SIZE || '3840x2160').split('x').map(Number);
const PORT = Number(process.env.DSH_STRESS_PORT || 18930);
const EDGE_CANDIDATES = [
  process.env.DSH_STRESS_EDGE,
  process.env.MSEDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

const USAGE = [
  '用法：node tests/stress-check.js [选项]',
  '  （无选项）                     默认 2 分钟、预期 3 个采样点（门禁用有限时长；整班次浸泡走 --soak）',
  '  --soak                        整班次浸泡（＝ --hours 8）',
  '  --hours <N>                   浸泡 N 小时（如 --hours 8；**N ≥ 168 即"≥7 天"**，如 --hours 168）',
  '  --minutes <N>                 只跑 N 分钟（可为小数，快速自检用；与 --hours/--soak 互斥）',
  '  --interval-min <N>            采样间隔（分钟，可为小数；缺省 1 —— 与默认 2 分钟配成 3 个采样点）',
  '  --day-seconds <S>             一个"证据日"压成 S 秒（缺省 86400；压缩档会被标注为不可作 AC-07 证据）',
  '  --soak-ledger <path>          证据日台账（jsonl）落点；缺省 tests\\._verify\\soak\\soak-<启动时刻>.jsonl',
  '  --verify-soak <path>          **判据模式**：读一份台账、按 AC-07 的 5 条判据判 0/1（不起浏览器）',
  '  --allow-compressed            与 --verify-soak 同用：显式承认"压缩时钟、不作 AC-07 证据"',
  '  --help                        打印本用法',
  '环境变量：DSH_STRESS_HOURS / DSH_STRESS_INTERVAL_MIN / DSH_STRESS_SIZE / DSH_STRESS_EDGE / DSH_STRESS_DAY_SECONDS（CLI 优先）',
  '判据：计划类 2 条 + 通用 8 条 + 长跑专属 3 条（默认时长下如实计入"跳过"）+ 自洽 1 条',
  '      ＋ 证据日台账另配 AC-07 的 5 条判据（--verify-soak 判；压缩时钟只作机制自检）',
  '退出码：0 通过 / 1 有判据不通过 / 2 脚本异常 / 3 环境不满足（整脚本跳过）'
].join('\n');

/**
 * **纯函数**：解析运行计划（时长/间隔/预期采样点数/是否浸泡）。
 * 抽成纯函数是为了在没有浏览器的环境里验证"时长参数被遵守"这条判据（定点变异不必起 Edge）。
 * @param {{minutes?:string|number|null, hours?:string|number|null, soak?:boolean,
 *          envHours?:string|number|null, envIntervalMin?:string|number|null,
 *          defaultMinutes?:number, soakHours?:number}} o
 * @returns {{requestedMin:number, durationMin:number, intervalMin:number, expectedSamples:number,
 *            perHour:number, soakOnly:boolean, source:string}}
 * @throws {Error} 参数非法或互相冲突（不静默择一）
 */
function resolvePlan(o = {}) {
  const defaultMinutes = o.defaultMinutes === undefined ? DEFAULT_MINUTES : Number(o.defaultMinutes);
  const soakHours = o.soakHours === undefined ? SOAK_HOURS : Number(o.soakHours);
  const hasMinutes = o.minutes !== null && o.minutes !== undefined && o.minutes !== '';
  const hasHours = o.hours !== null && o.hours !== undefined && o.hours !== '';
  const soak = o.soak === true;
  if (hasMinutes && (hasHours || soak)) throw new Error('--minutes 与 --hours/--soak 不能同时给（口径必须唯一）');
  if (soak && hasHours) throw new Error('--soak 就是 --hours ' + soakHours + '；两者不能同时给（避免口径含糊）');
  let requestedMin;
  let source;
  if (hasMinutes) { requestedMin = Number(o.minutes); source = 'cli:--minutes'; }
  else if (hasHours) { requestedMin = Number(o.hours) * 60; source = 'cli:--hours'; }
  else if (soak) { requestedMin = soakHours * 60; source = 'cli:--soak'; }
  else if (o.envHours !== null && o.envHours !== undefined && o.envHours !== '') {
    requestedMin = Number(o.envHours) * 60; source = 'env:DSH_STRESS_HOURS';
  } else { requestedMin = defaultMinutes; source = 'default(' + defaultMinutes + ' 分钟)'; }
  const intervalRaw = (o.envIntervalMin === null || o.envIntervalMin === undefined || o.envIntervalMin === '')
    ? DEFAULT_INTERVAL_MIN : Number(o.envIntervalMin);
  if (!Number.isFinite(requestedMin) || requestedMin <= 0) {
    throw new Error('时长必须是正数（收到 ' + JSON.stringify(requestedMin) + '，来源 ' + source + '）');
  }
  if (!Number.isFinite(intervalRaw) || intervalRaw <= 0) {
    throw new Error('采样间隔必须是正数（收到 ' + JSON.stringify(intervalRaw) + '）');
  }
  const intervalMin = intervalRaw;
  return {
    requestedMin,
    durationMin: requestedMin,
    intervalMin,
    expectedSamples: Math.floor(requestedMin / intervalMin) + 1,
    perHour: Math.max(1, Math.round(60 / intervalMin)),
    soakOnly: requestedMin >= soakHours * 60,
    source
  };
}

/** runner 解析的标准汇总行（**这一行是契约**：`通过 N 项，失败 M 项，跳过 K 项`） */
const summaryLine = v => `通过 ${v.passed} 项，失败 ${v.failed} 项，跳过 ${v.skipped} 项`;

/**
 * **纯函数**：把一次运行的观测折算成判据结论。
 * 三种结果：`check`（pass 真/假）、`skip`（本时长下不适用，如实计入跳过，**不是**通过）。
 * @param {{samples:Array<object>, okSamples:Array<object>, pageErrors:string[], plan:object,
 *          workloadRuns:number, workloadFailures:number, wallMs:number}} ctx
 * @returns {{results:Array<{name:string, kind:'check'|'skip', pass:boolean|null, detail:string}>,
 *            passed:number, failed:number, skipped:number, shifts:string[]}}
 */
function evaluateCriteria(ctx) {
  const plan = ctx.plan || {};
  const samples = ctx.samples || [];
  const ok = ctx.okSamples || [];
  const pageErrors = ctx.pageErrors || [];
  const wallMs = Number(ctx.wallMs) || 0;
  const results = [];
  const check = (name, pass, detail) => results.push({ name, kind: 'check', pass: Boolean(pass), detail: detail || '' });
  const skip = (name, reason) => results.push({ name, kind: 'skip', pass: null, detail: reason || '' });
  const first = ok[0];
  const last = ok[ok.length - 1];

  /* ---- 计划类（任何时长都跑）：时长参数被遵守 + 采样点符合计划 ---- */
  check('本轮墙钟时长 ≥ 请求时长 − 90 s（"时长参数被遵守"）',
    wallMs >= plan.requestedMin * 60000 - 90000,
    `请求 ${plan.requestedMin} min（来源 ${plan.source}），实测墙钟 ${(wallMs / 60000).toFixed(1)} min`);
  check('采样点数 == floor(时长/间隔)+1（采样计划被遵守）',
    samples.length === plan.expectedSamples,
    `预期 ${plan.expectedSamples} 点，实测 ${samples.length} 点（间隔 ${plan.intervalMin} min）`);

  /* ---- 通用判据（任何时长都跑） ---- */
  check('采样成功率 100%（页面始终可响应）', samples.length > 0 && ok.length === samples.length,
    `${ok.length}/${samples.length} 次采样成功`);
  const clockStuck = ok.filter((s, i) => i > 0 && s.clock === ok[i - 1].clock).length;
  check('时钟持续推进（无卡死）', clockStuck === 0, `${clockStuck} 次相邻采样时钟相同`);
  check('标签按钮数恒定 8（无重复渲染累积）', ok.length > 0 && ok.every(s => s.tabs === 8),
    `出现过的取值：${[...new Set(ok.map(s => s.tabs))].join('/')}`);
  check('始终只有一个面板处于激活态', ok.length > 0 && ok.every(s => s.activePanels === 1),
    `出现过的取值：${[...new Set(ok.map(s => s.activePanels))].join('/')}`);
  check('无未捕获异常与 console.error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  const heapGrowthRatio = first && last ? last.heapMB / Math.max(first.heapMB, 1) : 1;
  check('JS 堆增长不超过首轮的 2 倍且增量 < 100 MB', Boolean(first && last) &&
    (heapGrowthRatio <= 2 || (last.heapMB - first.heapMB) < 100),
    `首轮 ${first ? first.heapMB : '—'} MB → 末轮 ${last ? last.heapMB : '—'} MB（${heapGrowthRatio.toFixed(2)}×，窗口 ${samples.length} 点）`);
  const nodeGrowth = first && last ? last.nodes / Math.max(first.nodes, 1) : 1;
  check('DOM 元素数增长不超过 50%', Boolean(first && last) && nodeGrowth <= 1.5,
    `首轮 ${first ? first.nodes : '—'} → 末轮 ${last ? last.nodes : '—'}（${nodeGrowth.toFixed(2)}×）`);
  check('周期性负载（8 页轮巡 + 断连/恢复）至少执行 1 次且无失败',
    Number(ctx.workloadRuns) >= 1 && Number(ctx.workloadFailures) === 0,
    `执行 ${ctx.workloadRuns} 次，失败 ${ctx.workloadFailures} 次`);

  /* ---- 长跑专属：默认时长下**如实跳过**（不是假装通过） ---- */
  const shifts = [...new Set(ok.map(s => s.shift))];
  if (plan.soakOnly) {
    check(SOAK_ONLY_NAMES[0], shifts.length >= 2 && Boolean(last && last.curveTask),
      `班次 ${shifts.join(' → ') || '—'}；末次曲线「${last ? last.curveTask : '—'}」`);
    check(SOAK_ONLY_NAMES[1], Number(ctx.workloadRuns) >= 2, `执行 ${ctx.workloadRuns} 次`);
    check(SOAK_ONLY_NAMES[2], samples.length >= 6, `${samples.length} 点`);
  } else {
    skip(SOAK_ONLY_NAMES[0], `需 --hours 8（本轮请求 ${plan.requestedMin} min，不跨班次）`);
    skip(SOAK_ONLY_NAMES[1], `需 --hours 8（本轮只跑第 1 轮负载）`);
    skip(SOAK_ONLY_NAMES[2], `需 --hours 8（本轮 ${samples.length} 点）`);
  }

  /* ---- 自洽判据：跳过项数必须与"长跑专属判据"条数一致（防把长跑判据悄悄改成通过） ---- */
  const counted = {
    passed: results.filter(r => r.kind === 'check' && r.pass).length,
    failed: results.filter(r => r.kind === 'check' && !r.pass).length,
    skipped: results.filter(r => r.kind === 'skip').length
  };
  const expectSkips = plan.soakOnly ? 0 : SOAK_ONLY_NAMES.length;
  check('跳过项数 == 长跑专属判据条数（防"把长跑判据悄悄改成通过"）',
    counted.skipped === expectSkips,
    `跳过 ${counted.skipped} 项，期望 ${expectSkips} 项（长跑专属共 ${SOAK_ONLY_NAMES.length} 条）`);

  return {
    results,
    passed: results.filter(r => r.kind === 'check' && r.pass).length,
    failed: results.filter(r => r.kind === 'check' && !r.pass).length,
    skipped: results.filter(r => r.kind === 'skip').length,
    shifts
  };
}

/* ==========================================================================
   **证据日时钟**（甲·2）：把"一个证据日"从 86400 s 压到 S 秒（只用于机器自检）
   --------------------------------------------------------------------------
   · 压缩**必须在输出与 jsonl 里显式标注**（`clockCompressed`）—— 防被人当 AC-07 证据
     （ADR-0010 D2：压缩时钟的读数不构成 AC-07 证据）；
   · 内存取样间隔按同比例缩放（真实档 86400/24 = 3600 s ＝ 每小时一次）；
   · 判据⑤据此判红（要作机制自检必须显式 `--allow-compressed`）。
   ========================================================================== */
function resolveSoakClock(o = {}) {
  const hasCli = !(o.daySeconds === null || o.daySeconds === undefined || o.daySeconds === '');
  const hasEnv = !(o.envDaySeconds === null || o.envDaySeconds === undefined || o.envDaySeconds === '');
  const raw = hasCli ? o.daySeconds : (hasEnv ? o.envDaySeconds : REAL_DAY_SEC);
  const daySeconds = Number(raw);
  if (!Number.isFinite(daySeconds) || daySeconds <= 0) {
    throw new Error('证据日长度必须是正有限数（收到 ' + String(raw) + '，typeof ' + typeof raw + '）');
  }
  return {
    daySeconds,
    realDaySec: REAL_DAY_SEC,
    clockCompressed: daySeconds !== REAL_DAY_SEC,
    memSampleIntervalSec: daySeconds / 24,
    source: hasCli ? 'cli:--day-seconds' : (hasEnv ? 'env:DSH_STRESS_DAY_SECONDS' : 'default(' + REAL_DAY_SEC + ' s)')
  };
}

/** 有限数？否则 NaN（判据里**不抛**：异常形态由判据判红并指名 —— 这正是"可证伪"的落点） */
function soakNum(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : NaN;
}
/** ISO 串 → 毫秒（不可解析 ⇒ NaN） */
function soakIsoMs(v) {
  return (typeof v === 'string' && Number.isFinite(Date.parse(v))) ? Date.parse(v) : NaN;
}
/** 读数取三位小数（只为可读；判据一律用原值比） */
function round3(v) {
  return Math.round(Number(v) * 1000) / 1000;
}

/**
 * **纯函数**：解析证据日台账（jsonl 文本）→ `{meta, days, badLines}`。
 * 只做"读得出来吗"这一件事：不合法的行**逐行指名**（不静默丢），判据①据此判红。
 * @param {string} text
 * @returns {{meta:?object, days:Array<object>, badLines:Array<{lineNo:number, reason:string, text:string}>}}
 */
function parseSoakLedger(text) {
  const days = [];
  const badLines = [];
  let meta = null;
  const lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
  lines.forEach((raw, i) => {
    const s = raw.trim();
    if (!s) return;                                        /* 空行（含文件末尾的空行）不算坏行 */
    let obj = null;
    try {
      obj = JSON.parse(s);
    } catch (e) {
      badLines.push({ lineNo: i + 1, reason: 'JSON 解析失败：' + e.message, text: s.slice(0, 120) });
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      badLines.push({ lineNo: i + 1, reason: '不是 JSON 对象', text: s.slice(0, 120) });
      return;
    }
    if (obj.type === 'meta') {
      if (meta) badLines.push({ lineNo: i + 1, reason: 'meta 行重复（首行之后又出现一行）', text: s.slice(0, 120) });
      else meta = obj;
      return;
    }
    if (obj.type === 'day') { days.push(obj); return; }
    badLines.push({ lineNo: i + 1, reason: '未知的 type=' + String(obj.type), text: s.slice(0, 120) });
  });
  return { meta, days, badLines };
}

/**
 * **纯函数**：AC-07 判据本体（`P-2`）。**只读**台账（不碰文件系统、不起浏览器），于是同一份判据
 * 可以在**合成样本**上做定点变异（ADR-0004 D22）—— 这就是"可判、可证伪、可复跑"的来源。
 * 5 条判据的名字/口径见文件头；逐条判红都把**冒犯对象**写进 detail（哪一行、哪个读数、阈值多少）。
 * @param {{meta:?object, days:Array<object>, badLines?:Array}} ledger `parseSoakLedger()` 的产物
 * @param {{allowCompressed?:boolean}} [opts] 仅 `--verify-soak --allow-compressed` 时为 true（判据⑤记 N/A）
 * @returns {{results:Array<{idx:number, tag:string, name:string, pass:boolean, skipped:boolean, detail:string}>,
 *            passed:number, failed:number, days:number, completeDays:number,
 *            daySec:number, intervalSec:number, gapLimitSec:number, chainTolSec:number, rssGrowthK:number}}
 */
function verifySoakLedger(ledger, opts = {}) {
  const meta = (ledger && ledger.meta) || null;
  const days = ((ledger && ledger.days) || []).slice();
  const badLines = (ledger && ledger.badLines) || [];
  const allowCompressed = opts.allowCompressed === true;
  const results = [];
  const add = (i, pass, detail, skipped) => results.push({
    idx: i + 1, tag: SOAK_CRITERION_TAGS[i], name: SOAK_CRITERIA_NAMES[i],
    pass: Boolean(pass), skipped: Boolean(skipped), detail: String(detail === undefined ? '' : detail)
  });

  const daySec = meta ? soakNum(meta.daySeconds) : NaN;
  const intervalSec = meta ? soakNum(meta.sampleIntervalSec) : NaN;
  const gapLimitSec = Number.isFinite(intervalSec)
    ? SOAK_GAP_FACTOR * intervalSec + SOAK_GAP_SLACK_SEC : NaN;
  /* 逐日链容差＝max(2 s, 采样连续性阈值)：见 `SOAK_CHAIN_TOL_SEC` 的说明（不写第二份口径） */
  const chainTolSec = Number.isFinite(gapLimitSec)
    ? Math.max(SOAK_CHAIN_TOL_SEC, gapLimitSec) : SOAK_CHAIN_TOL_SEC;
  const complete = days.filter(d => d.partial !== true);

  /* ---- ① 连续 ≥7 天无重启：完整日数 ＋ 逐日链 ＋ dayIndex ＋ uptimeSec ＋ restarts ---- */
  const p1 = [];
  if (!meta) p1.push('缺 meta 行（台账首行必须是计划/时钟元数据）');
  if (badLines.length) {
    p1.push('台账有 ' + badLines.length + ' 行读不出（首个：第 ' + badLines[0].lineNo + ' 行 ' + badLines[0].reason
      + '）⇒ 逐日链的完整性无从判定');
  }
  if (complete.length < SOAK_MIN_DAYS) {
    p1.push('完整证据日 ' + complete.length + ' 个 < ' + SOAK_MIN_DAYS + '（partial 行不算满日）');
  }
  const restartRows = days.filter(d => soakNum(d.restarts) !== 0);
  if (restartRows.length) {
    p1.push('restarts ≠ 0 的 ' + restartRows.length + ' 行：' + restartRows.slice(0, 3)
      .map(d => 'dayIndex=' + d.dayIndex + '(restarts=' + JSON.stringify(d.restarts) + ')').join('、'));
  }
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const s = soakIsoMs(d.dayStartIso);
    const e = soakIsoMs(d.dayEndIso);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      p1.push('第 ' + (i + 1) + ' 行（dayIndex=' + d.dayIndex + '）的 dayStartIso/dayEndIso 不可解析');
      continue;
    }
    if (!(e > s)) p1.push('第 ' + (i + 1) + ' 行（dayIndex=' + d.dayIndex + '）dayEndIso ≤ dayStartIso');
    const c = soakIsoMs(d.closedAtIso);
    if (Number.isFinite(c)) {
      if (c < e - chainTolSec * 1000) {
        p1.push('第 ' + (i + 1) + ' 行（dayIndex=' + d.dayIndex + '）closedAtIso 早于 dayEndIso（凭空早写）');
      } else if (Number.isFinite(gapLimitSec) && c > e + gapLimitSec * 1000) {
        p1.push('第 ' + (i + 1) + ' 行（dayIndex=' + d.dayIndex + '）closedAtIso 晚于 dayEndIso '
          + ((c - e) / 1000).toFixed(1) + ' s > 阈值 ' + gapLimitSec.toFixed(1)
          + ' s（该日的观测窗早已越界：进程被挂起/停了）');
      }
    }
    if (i > 0) {
      const prevE = soakIsoMs(days[i - 1].dayEndIso);
      if (!Number.isFinite(prevE) || Math.abs(s - prevE) > chainTolSec * 1000) {
        p1.push('链断裂：第 ' + (i + 1) + ' 行 dayStartIso=' + d.dayStartIso + ' 与上一行 dayEndIso='
          + days[i - 1].dayEndIso + ' 差 ' + (Number.isFinite(prevE) ? ((s - prevE) / 1000).toFixed(3) : 'NaN')
          + ' s > 容差 ' + chainTolSec.toFixed(3) + ' s');
      }
      if (soakNum(d.dayIndex) !== soakNum(days[i - 1].dayIndex) + 1) {
        p1.push('dayIndex 不连续：第 ' + i + ' 行 ' + JSON.stringify(days[i - 1].dayIndex)
          + ' → 第 ' + (i + 1) + ' 行 ' + JSON.stringify(d.dayIndex));
      }
      if (!(soakNum(d.uptimeSec) > soakNum(days[i - 1].uptimeSec))) {
        p1.push('uptimeSec 未严格递增：第 ' + i + ' 行 ' + JSON.stringify(days[i - 1].uptimeSec)
          + ' → 第 ' + (i + 1) + ' 行 ' + JSON.stringify(d.uptimeSec));
      }
    }
  }
  add(0, p1.length === 0, p1.length
    ? p1.slice(0, 4).join('；') + (p1.length > 4 ? '；（共 ' + p1.length + ' 处）' : '')
    : '完整证据日 ' + complete.length + ' 个 ≥ ' + SOAK_MIN_DAYS + '；' + days.length
      + ' 行逐日链连续、dayIndex 逐行 +1、uptimeSec 严格递增、restarts 全 0');

  /* ---- ② 无崩溃：自然跑满计划时长 ＋ errorCount 如实为 0 ---- */
  const p2 = [];
  const last = days.length ? days[days.length - 1] : null;
  const plannedSec = meta ? soakNum(meta.plannedSec) : NaN;
  if (!last) p2.push('台账里没有任何证据日行');
  else {
    if (last.runComplete !== true) {
      p2.push('末行（dayIndex=' + last.dayIndex + '）runComplete=' + JSON.stringify(last.runComplete)
        + ' ⇒ 进程**未**自然跑满计划时长');
    }
    if (last.exitReason !== 'completed') {
      p2.push('末行 exitReason=' + JSON.stringify(last.exitReason) + " ≠ 'completed'");
    }
    if (!Number.isFinite(plannedSec)) {
      p2.push('meta.plannedSec 缺失/非数 ⇒ "计划 vs 实到"无从判定');
    } else if (!(soakNum(last.uptimeSec) >= plannedSec - SOAK_CRASH_TOL_SEC)) {
      p2.push('实到 ' + JSON.stringify(last.uptimeSec) + ' s < 计划 ' + plannedSec + ' s − '
        + SOAK_CRASH_TOL_SEC + ' s');
    }
  }
  const errRows = days.filter(d => soakNum(d.errorCount) !== 0);
  if (errRows.length) {
    p2.push('errorCount ≠ 0 的 ' + errRows.length + ' 行（末日累计 ' + JSON.stringify(errRows[errRows.length - 1].errorCount)
      + '：未捕获异常与 console.error 逐日计入）');
  }
  add(1, p2.length === 0, p2.length ? p2.join('；')
    : '计划 ' + plannedSec + ' s、实到 ' + (last ? last.uptimeSec : '—') + " s、exitReason='completed'、errorCount 累积 0");

  /* ---- ③ 无内存泄漏：末日 rssMax ≤ 首日 × K，且不呈严格单调上升 ---- */
  const p3 = [];
  let d3 = '';
  const usable = complete.length >= 2 ? complete : days;
  if (usable.length < 2) p3.push('可用于内存比较的证据日 < 2');
  else {
    const first = usable[0];
    const lastD = usable[usable.length - 1];
    const f = soakNum(first.rssMaxBytes);
    const l = soakNum(lastD.rssMaxBytes);
    if (!Number.isFinite(f) || !Number.isFinite(l) || f <= 0) {
      p3.push('rssMaxBytes 缺失/非正（首日 ' + JSON.stringify(first.rssMaxBytes)
        + '、末日 ' + JSON.stringify(lastD.rssMaxBytes) + '）');
    } else {
      const inc = usable.filter((d, i) => i > 0 && soakNum(d.rssMaxBytes) > soakNum(usable[i - 1].rssMaxBytes)).length;
      if (!(l / f <= SOAK_RSS_GROWTH_K)) {
        p3.push('末日 dayIndex=' + lastD.dayIndex + ' 的 rssMaxBytes ' + l + ' B ÷ 首日 dayIndex='
          + first.dayIndex + ' 的 ' + f + ' B = ' + (l / f).toFixed(3) + '× > ' + SOAK_RSS_GROWTH_K + '×');
      }
      if (inc >= usable.length - 1) {
        p3.push('rssMaxBytes 呈**严格单调上升**（' + inc + '/' + (usable.length - 1) + ' 个相邻间隔全在涨）');
      }
      d3 = '首日 dayIndex=' + first.dayIndex + ' rssMax ' + f + ' B → 末日 dayIndex=' + lastD.dayIndex
        + ' rssMax ' + l + ' B（' + (l / f).toFixed(3) + '× ≤ ' + SOAK_RSS_GROWTH_K + '×）；未上升的相邻间隔 '
        + (usable.length - 1 - inc) + '/' + (usable.length - 1);
    }
  }
  add(2, p3.length === 0, p3.length ? p3.join('；') : d3);

  /* ---- ④ 采样连续性 ---- */
  const p4 = [];
  if (days.length === 0) p4.push('台账里没有任何证据日行');
  if (!Number.isFinite(gapLimitSec)) p4.push('meta.sampleIntervalSec 缺失/非数 ⇒ 阈值无从判定');
  else {
    const over = days.filter(d => !(soakNum(d.maxGapSec) <= gapLimitSec));
    if (over.length) {
      p4.push(over.length + '/' + days.length + ' 个证据日超阈（阈值 ' + gapLimitSec.toFixed(1) + ' s；首个：第 '
        + (days.indexOf(over[0]) + 1) + ' 行 dayIndex=' + over[0].dayIndex + ' maxGapSec='
        + JSON.stringify(over[0].maxGapSec) + '）');
    }
  }
  add(3, p4.length === 0, p4.length ? p4.join('；')
    : days.length + ' 个证据日的 maxGapSec 全部 ≤ 阈值 ' + gapLimitSec.toFixed(1) + ' s（＝'
      + SOAK_GAP_FACTOR + ' × ' + intervalSec + ' s ＋ ' + SOAK_GAP_SLACK_SEC + ' s）；'
      + '实测最大 ' + Math.max.apply(null, days.map(d => soakNum(d.maxGapSec) || 0)).toFixed(3) + ' s');

  /* ---- ⑤ 可作证性：真时钟才作 AC-07 证据（ADR-0010 D2 三档） ---- */
  const p5 = [];
  if (!meta) p5.push('缺 meta 行');
  else {
    if (typeof meta.clockCompressed !== 'boolean') {
      p5.push('meta.clockCompressed 未显式标注（收到 ' + JSON.stringify(meta.clockCompressed) + '）');
    }
    if (meta.clockCompressed === true) {
      p5.push('压缩时钟（daySeconds=' + JSON.stringify(meta.daySeconds) + ' ≠ ' + REAL_DAY_SEC
        + '）⇒ **不作 AC-07 证据**');
    }
    if (soakNum(meta.daySeconds) !== REAL_DAY_SEC) {
      p5.push('daySeconds=' + JSON.stringify(meta.daySeconds) + ' ≠ ' + REAL_DAY_SEC + ' s');
    }
  }
  if (allowCompressed) {
    add(4, true, '（--allow-compressed：显式承认压缩时钟，本台账**只作留证/判据机制的机器自检**，不构成 AC-07 证据）', true);
  } else {
    add(4, p5.length === 0, p5.length ? p5.join('；')
      : '真时钟（daySeconds=' + REAL_DAY_SEC + ' s、clockCompressed=false）⇒ 本条台账**可以**作 AC-07 证据');
  }

  const passed = results.filter(r => r.pass && !r.skipped).length;
  const failed = results.filter(r => !r.pass && !r.skipped).length;
  return {
    results, passed, failed,
    days: days.length, completeDays: complete.length,
    daySec, intervalSec, gapLimitSec, chainTolSec, rssGrowthK: SOAK_RSS_GROWTH_K,
    clockCompressed: meta ? meta.clockCompressed === true : null
  };
}

let edge = null;
let cdp = null;
const pageErrors = [];

/* ---------------- 极简 CDP 客户端 ---------------- */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = [];
    this.closed = false;
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      this.handlers.forEach(h => h(msg));
    });
    this.ws.addEventListener('close', () => { this.closed = true; });
  }

  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (e) {
        reject(e);
      }
    });
  }

  on(handler) {
    this.handlers.push(handler);
  }

  close() {
    try { this.ws.close(); } catch (e) { /* 已关闭 */ }
  }
}

let LOG = null;
let CSV = null;

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  if (LOG) fs.appendFileSync(LOG, text + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) { /* 未就绪 */ }
    await sleep(200);
  }
  return null;
}

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'page evaluate failed');
  return r.result.value;
}

async function launch() {
  const exe = EDGE_CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stress-'));
  edge = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    /* 长跑关键：禁掉后台节流，否则页面定时器在无头/遮挡时会被降频 */
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `--window-size=${SIZE[0]},${SIZE[1]}`,
    'about:blank'
  ], { stdio: 'ignore' });
  const version = await waitHttp(`http://127.0.0.1:${PORT}/json/version`, 30000);
  if (!version) return null;
  const list = await waitHttp(`http://127.0.0.1:${PORT}/json/list`, 5000);
  const target = (list || []).find(t => t.type === 'page');
  if (!target) return null;
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on(msg => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageErrors.push(new Date().toISOString() + ' console.error: ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(new Date().toISOString() + ' uncaught: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: SIZE[0], height: SIZE[1], deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 100; i++) {
    const ready = await evaluate('document.readyState').catch(() => null);
    if (ready === 'complete') break;
    await sleep(200);
  }
  return exe;
}

/** 页面内的采样表达式：一次取回所有关心的量 */
const SNAPSHOT_EXPR = `(() => {
  const m = performance.memory || {};
  const st = (window.MockData && window.MockData.state) || {};
  const q = window.Api && window.Api.getStatus ? window.Api.getStatus() : {};
  return {
    clock: (st.clock && st.clock.time) || '',
    lastRefresh: st.lastRefresh || '',
    shift: (st.shift && st.shift.name) || '',
    unitIndex: (st.task && st.task.unitIndex) || 0,
    done: (st.stats && st.stats.done) || 0,
    notStarted: (st.stats && st.stats.notStarted) || 0,
    pending: q.pendingCount === undefined ? -1 : q.pendingCount,
    heap: m.usedJSHeapSize || 0,
    nodes: document.getElementsByTagName('*').length,
    tabs: document.querySelectorAll('.tab-btn').length,
    activePanels: document.querySelectorAll('.tab-panel.active').length,
    hasData: !!document.querySelector('.chart-wrap.has-data'),
    banner: !!document.querySelector('.degraded-banner'),
    mode: (document.getElementById('stMode') || {}).textContent || '',
    curveTask: (document.getElementById('stDepthTask') || {}).textContent || ''
  };
})()`;

/** 周期性负载：8 个页面轮一遍 + 两次断连/恢复 */
async function workload() {
  for (let i = 0; i < 8; i++) {
    await evaluate(`(() => { const b = document.querySelectorAll('.tab-btn')[${i}]; if (b) b.click(); return true; })()`);
    await sleep(400);
  }
  await evaluate(`(() => { const b = document.querySelectorAll('.tab-btn')[0]; if (b) b.click(); return true; })()`);
  for (const type of ['keyDown', 'keyUp', 'keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, text: type === 'keyDown' ? 'd' : '' });
    await sleep(300);
  }
}

async function screenshot(file) {
  try {
    /* 4K 下 CDP 截图偶尔会挂住：加超时，绝不允许它拖死长跑 */
    const shot = await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png' }),
      sleep(30000).then(() => null)
    ]);
    if (!shot) {
      log(`截图超时，跳过 ${path.basename(file)}`);
      return 0;
    }
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return fs.statSync(file).size;
  } catch (e) {
    log(`截图失败：${e.message}`);
    return 0;
  }
}

/**
 * `--verify-soak <台账.jsonl>` 的入口：读文件 → `parseSoakLedger` → `verifySoakLedger` → 打印 → 退出。
 * **刻意不打标准汇总行**（`通过 N 项，失败 M 项，跳过 K 项`）：那不是门禁轮，打出来会被
 * runner／人读成"门禁全绿"（规范 9.5-5"没有证据不等于通过"的同一条精神）。
 * @param {string} ledgerPath @param {boolean} allowCompressed @returns {never}
 */
function runVerifySoak(ledgerPath, allowCompressed) {
  const abs = path.resolve(ROOT, ledgerPath);
  if (!fs.existsSync(abs)) {
    console.error('[--verify-soak] 台账不存在：' + abs);
    process.exit(2);
  }
  const ledger = parseSoakLedger(fs.readFileSync(abs, 'utf8'));
  const v = verifySoakLedger(ledger, { allowCompressed });
  const m = ledger.meta;
  console.log('=== AC-07 判据（--verify-soak；不是门禁轮，故不打标准汇总行）===');
  console.log('台账：' + path.relative(ROOT, abs) + '（' + ledger.days.length + ' 个证据日；其中完整 '
    + v.completeDays + ' 个' + (ledger.badLines.length ? '；**读不出的行 ' + ledger.badLines.length + ' 行**' : '') + '）');
  console.log(m
    ? '时钟：证据日 ' + m.daySeconds + ' s／采样间隔 ' + m.sampleIntervalSec + ' s／压缩时钟 '
      + (m.clockCompressed === true ? '**是**' : '否') + '／计划 ' + m.plannedSec + ' s／脚本 sha256 '
      + String(m.scriptSha256 || '—').slice(0, 12)
    : '时钟：缺 meta 行');
  for (const r of v.results) {
    console.log((r.skipped ? '[N/A] ' : (r.pass ? '[PASS] ' : '[FAIL] ')) + r.name + (r.detail ? ' —— ' + r.detail : ''));
  }
  if (allowCompressed) {
    console.log('⚠ --allow-compressed：本台账**不构成 AC-07 证据**（只作留证/判据机制的机器自检，ADR-0010 D2）。');
  }
  console.log('判据通过 ' + v.passed + '／' + v.results.length + ' 条，失败 ' + v.failed + ' 条'
    + (v.failed ? '（见上面 [FAIL] 行；每条都点名到"第几条判据 ＋ 哪个冒犯对象"）' : '')
    + (v.failed === 0 && v.clockCompressed !== true ? ' —— 若这是**真时钟 ≥7 天**的台账，则 AC-07 的机器判据成立' : ''));
  process.exit(v.failed ? 1 : 0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const optValue = name => {
    const i = argv.indexOf('--' + name);
    if (i < 0) return null;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? null : v;
  };
  /* `--verify-soak`：**判据模式**（不起浏览器、不打标准汇总行）—— 见文件头"AC-07 判据"一节 */
  if (argv.includes('--verify-soak')) {
    const ledgerArg0 = optValue('verify-soak');
    if (!ledgerArg0) { console.error('[参数非法] --verify-soak 需要一个台账路径（jsonl）\n\n' + USAGE); process.exit(2); }
    runVerifySoak(ledgerArg0, argv.includes('--allow-compressed'));
  }

  let plan;
  let clock;
  try {
    plan = resolvePlan({
      minutes: optValue('minutes'),
      hours: optValue('hours'),
      soak: argv.includes('--soak'),
      envHours: process.env.DSH_STRESS_HOURS,
      envIntervalMin: optValue('interval-min') !== null ? optValue('interval-min') : process.env.DSH_STRESS_INTERVAL_MIN,
      defaultMinutes: DEFAULT_MINUTES,
      soakHours: SOAK_HOURS
    });
    clock = resolveSoakClock({
      daySeconds: optValue('day-seconds'),
      envDaySeconds: process.env.DSH_STRESS_DAY_SECONDS
    });
  } catch (err) {
    console.error('[参数非法] ' + err.message + '\n\n' + USAGE);
    process.exit(2);
  }

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  CSV = path.join(OUT, `stress-${stamp}.csv`);
  LOG = path.join(OUT, `stress-${stamp}.log`);
  const ledgerArg = optValue('soak-ledger');
  const LEDGER = ledgerArg ? path.resolve(ROOT, ledgerArg) : path.join(OUT, 'soak', `soak-${stamp}.jsonl`);
  fs.writeFileSync(CSV, 'iso,elapsedMin,clock,shift,unitIndex,done,notStarted,pending,heapMB,nodes,tabs,activePanels,mode,hasData,banner,curveTask\n');
  log(`长跑开始：请求时长 ${plan.requestedMin} min（来源 ${plan.source}）、采样间隔 ${plan.intervalMin} min、` +
    `预期采样 ${plan.expectedSamples} 点、视口 ${SIZE[0]}×${SIZE[1]}、模式 ${plan.soakOnly ? '浸泡' : '默认短跑'}`);
  log(`页面 ${PAGE}`);
  log(`产物 ${path.relative(ROOT, CSV)} / ${path.relative(ROOT, LOG)}`);

  log(`时钟：证据日 ${clock.daySeconds} s（来源 ${clock.source}）、压缩时钟 ${clock.clockCompressed ? '**是**（不得作 AC-07 证据）' : '否'}、`
    + `内存读数每 ${clock.memSampleIntervalSec} s 一次、AC-07 天数下限 ${SOAK_MIN_DAYS} 天`);
  log(`计划时长 ${plan.requestedMin} min（${(plan.requestedMin / 1440).toFixed(3)} 天；'≥7 天' ＝ ${SOAK_MIN_DAYS * 24 * 60} min ＝ --hours ${SOAK_MIN_DAYS * 24}）`
    + (plan.requestedMin >= SOAK_MIN_DAYS * 24 * 60 && !clock.clockCompressed
      ? ' ⇒ 本轮满足 AC-07 的**时长前提**（还须判据 ①～⑤ 全过）' : ''));
  if (clock.clockCompressed) {
    log('⚠ 压缩时钟：本轮台账只作**留证/判据机制的机器自检**，不构成 AC-07 证据（ADR-0010 D2）；' +
      '要作 AC-07 证据须去掉 --day-seconds/DSH_STRESS_DAY_SECONDS，用真实 86400 s 证据日跑 --hours 168');
  }
  log(`证据日台账 ${path.relative(ROOT, LEDGER)}`);

  const exe = await launch();
  if (!exe) {
    /* 整脚本跳过：必须退 3（不是 0），否则 runner 会把"一个断言都没跑"记成 PASS（规范 9.5-5 第 6 条）。
       注意与内部的"长跑中途浏览器掉线"区分：那种情况有部分断言已跑，走下面的判据汇总而非整脚本跳过。 */
    log('整脚本跳过：无头 Edge 起不来');
    env.skipSuite('无头 Edge 启动与 CDP 连接', '未找到 msedge.exe 或沙箱不允许创建命名管道');
  }
  log(`浏览器 ${exe}`);
  await screenshot(path.join(OUT, `stress-${stamp}-start.png`));

  const t0 = Date.now();
  const deadline = t0 + plan.durationMin * 60000;
  const samples = [];
  let round = 0;
  let workloadRuns = 0;
  let workloadFailures = 0;

  /** 采一次样（写 CSV + 进 samples + 打日志） */
  /* ---------------- 证据日台账（甲·1）：**逐行 flush 落盘**，进程被杀也不丢已完成的证据日 ----------------
     口径见文件头"证据日与留证"：一个证据日＝一段固定长度的墙钟区间；每跨过一个就追加一行 JSON。
     行内字段（判据读的就是它们）：dayIndex／dayStartIso／dayEndIso／closedAtIso／partial／uptimeSec／
     rssMinBytes／rssMaxBytes／rssLastBytes／heapUsedLastBytes／samples／sampleAttempts／maxGapSec／
     errorCount／restarts／memSamples／workloadRuns／workloadFailures／runComplete／exitReason。 */
  const dayMs = clock.daySeconds * 1000;
  const HR0 = process.hrtime.bigint();
  const mono = () => Number(process.hrtime.bigint() - HR0) / 1e9;   /* 单调时钟：uptimeSec 严格递增的来源 */
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const ledgerFd = fs.openSync(LEDGER, 'a');
  /** 写一行并**立刻 fsync**（7 天里进程随时可能被杀；攒内存＝丢证据） */
  const ledgerWrite = (obj) => {
    fs.writeSync(ledgerFd, JSON.stringify(obj) + '\n');
    fs.fsyncSync(ledgerFd);
  };
  ledgerWrite({
    type: 'meta', schema: 'soak-ledger/1', startedAtIso: new Date(t0).toISOString(), pid: process.pid,
    plannedSec: Math.round(plan.durationMin * 60), daySeconds: clock.daySeconds, realDaySec: REAL_DAY_SEC,
    clockCompressed: clock.clockCompressed, daySecondsSource: clock.source,
    sampleIntervalSec: plan.intervalMin * 60, memSampleIntervalSec: clock.memSampleIntervalSec,
    sampleIntervalMin: plan.intervalMin, expectedSamples: plan.expectedSamples, soakOnly: plan.soakOnly,
    requestedMin: plan.requestedMin, planSource: plan.source, viewport: SIZE[0] + 'x' + SIZE[1],
    page: PAGE, node: process.version, script: 'tests/stress-check.js',
    scriptSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    criteria: SOAK_CRITERIA_NAMES, rssGrowthK: SOAK_RSS_GROWTH_K,
    gapLimitSec: SOAK_GAP_FACTOR * plan.intervalMin * 60 + SOAK_GAP_SLACK_SEC
  });
  if (!env.isInsideVerify(LEDGER)) {
    log('⚠ 台账落在 tests\\._verify 之外（ADR-0003 D16 只约束"测试产物默认落点"，此处只告警不拒绝）：'
      + path.relative(ROOT, LEDGER));
  }
  const ledgerRows = [];
  let dayIdx = 0;
  let dayStartMs = t0;
  let obsCur = [];                 /* 本证据日内的**观测时刻**（含失败采样：它在场就说明进程活着） */
  let okCur = [];                  /* 本证据日内**成功**的采样数 */
  let rssCur = [];
  let heapLast = 0;
  let memCount = 0;
  let memAtMs = t0;

  const memSample = (atMs) => {
    const mu = process.memoryUsage();
    rssCur.push(mu.rss);
    heapLast = mu.heapUsed;
    memCount++;
    memAtMs = atMs;
  };
  /** 关掉"当前证据日"并落一行（`endMs` 是**计划边界**；末行由调用方传真实退出时刻 ＋ partial:true） */
  const closeDay = (endMs, o = {}) => {
    const pts = [dayStartMs].concat(obsCur.filter(t => t > dayStartMs && t < endMs)).concat([endMs]);
    let maxGap = 0;
    for (let i = 1; i < pts.length; i++) maxGap = Math.max(maxGap, (pts[i] - pts[i - 1]) / 1000);
    /* 本日一次内存读数都没取过（短跑/压缩档的第一天）⇒ **兜底取一次真实读数**：
       `rss` 与 `heap` 都不许写成 0 —— 0 在机器可读的留证里会被读成"堆是 0"。 */
    const muFallback = rssCur.length ? null : process.memoryUsage();
    const rss = rssCur.length ? rssCur : [muFallback.rss];
    const row = {
      type: 'day',
      dayIndex: dayIdx,
      dayStartIso: new Date(dayStartMs).toISOString(),
      dayEndIso: new Date(endMs).toISOString(),
      closedAtIso: new Date().toISOString(),
      partial: o.partial === true,
      uptimeSec: round3(mono()),
      rssMinBytes: Math.min.apply(null, rss),
      rssMaxBytes: Math.max.apply(null, rss),
      rssLastBytes: rss[rss.length - 1],
      heapUsedLastBytes: heapLast || (muFallback ? muFallback.heapUsed : heapLast),
      samples: okCur.length,
      sampleAttempts: obsCur.length,
      maxGapSec: round3(maxGap),
      errorCount: pageErrors.length,
      restarts: 0,                                  /* 本进程恒 0（真重启必然换一个进程/一份台账）；字段留着给判据读 */
      memSamples: memCount,
      workloadRuns, workloadFailures,
      runComplete: o.final === true ? o.runComplete === true : false,
      exitReason: o.final === true ? String(o.exitReason || '') : 'running'
    };
    ledgerWrite(row);
    ledgerRows.push(row);
    dayIdx++;
    dayStartMs = t0 + dayIdx * dayMs;
    obsCur = []; okCur = []; rssCur = []; memCount = 0; heapLast = 0;
    return row;
  };
  /** 记一次观测：进本日序列 ＋ 按比例取内存读数 ＋ 跨过日边界就逐个关日（可能一次跨过多个） */
  const noteObservation = (obsMs, ok) => {
    /* **先关日、再记这次观测**：观测属于"跨日之后所在的那一天"。旧顺序（先记后关）会把一次
       跨过若干个证据日的观测的读数算进**最先那个**日 —— 压缩档下实测踩到（一次 4.4 s 的负载
       跨过 4 个 1 s 的日，readings 全落进第 1 个日）。 */
    while (obsMs >= t0 + (dayIdx + 1) * dayMs) closeDay(t0 + (dayIdx + 1) * dayMs, {});
    obsCur.push(obsMs);
    if (ok) okCur.push(obsMs);
    if (obsMs - memAtMs >= clock.memSampleIntervalSec * 1000) memSample(obsMs);
  };
  /** 收尾：先关掉所有已跨过的完整证据日，再补"最后一行"（可能 partial） */
  const syncDays = (nowMs, finalOpts) => {
    while (nowMs >= t0 + (dayIdx + 1) * dayMs) closeDay(t0 + (dayIdx + 1) * dayMs, {});
    if (nowMs > dayStartMs) closeDay(nowMs, Object.assign({ partial: true }, finalOpts || {}));
  };
  /* 进程被中断（Ctrl-C／被 kill）时也要补一行：如实记 exitReason，且 runComplete=false
     （AC-07 语义含"无重启"⇒ 被中断的这一轮**整段作废**，不许续跑；见运行手册）。 */
  const onSignal = (sig) => {
    try {
      syncDays(Date.now(), { final: true, runComplete: false, exitReason: 'signal:' + sig });
      fs.closeSync(ledgerFd);
    } catch (e) { /* 尽力而为：写不进去也不能改变退出码 */ }
    process.exit(env.EXIT_FAIL);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  async function takeSample(reason) {
    round++;
    const elapsedMin = Math.round((Date.now() - t0) / 60000);
    const obsMs = Date.now();
    let snap = null;
    let err = null;
    try {
      snap = await evaluate(SNAPSHOT_EXPR);
    } catch (e) {
      err = e.message;
    }
    if (err) {
      log(`采样 #${round}（${reason}）失败：${err}`);
      samples.push({ ok: false, elapsedMin, err });
      noteObservation(obsMs, false);
      return null;
    }
    const heapMB = Math.round((snap.heap / 1024 / 1024) * 10) / 10;
    fs.appendFileSync(CSV, [
      new Date().toISOString(), elapsedMin, snap.clock, snap.shift, snap.unitIndex, snap.done,
      snap.notStarted, snap.pending, heapMB, snap.nodes, snap.tabs, snap.activePanels,
      snap.mode, snap.hasData, snap.banner, JSON.stringify(snap.curveTask)
    ].join(',') + '\n');
    samples.push({ ok: true, elapsedMin, ...snap, heapMB });
    noteObservation(obsMs, true);
    log(`采样 #${round}（${reason}，+${elapsedMin} min）时钟=${snap.clock} 班次=${snap.shift} 件号=${snap.unitIndex} ` +
      `已完成=${snap.done} 未开工=${snap.notStarted} 待补传=${snap.pending} 堆=${heapMB}MB DOM=${snap.nodes} 错误累计=${pageErrors.length}`);
    return samples[samples.length - 1];
  }

  while (Date.now() < deadline) {
    await takeSample('周期');
    /* 周期性负载：**第 1 轮必跑**（默认短跑也要覆盖"8 页轮巡 + 断连/恢复"），其后每小时一次 */
    if ((round - 1) % plan.perHour === 0) {
      try {
        await workload();
        workloadRuns++;
        log(`第 ${round} 轮后的周期性负载完成（8 页轮巡 + 2 次断连/恢复；累计 ${workloadRuns} 次）`);
      } catch (e) {
        workloadFailures++;
        log(`负载执行失败：${e.message}`);
      }
    }
    if (cdp.closed) {
      log('CDP 连接已断开（浏览器可能退出），长跑提前结束');
      break;
    }
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    /* **按绝对时刻表**睡到下一个计划采样点（不是“睡满一个间隔”）：负载与采样自身耗时不再挤占计划 ——
       否则 `--hours 168` 这类长跑会累计漂移、少采十几个点，“采样点数 == floor(时长/间隔)+1” 就成了看运气的判据
       （实测：8 h 档差 0～1 点、168 h 档差约 13 点）。错过（单次采样耗时 > 间隔）的采样点**不补采** ——
       连发采样会把“时钟持续推进”判据搅乱；缺口如实记进证据日的 maxGapSec。 */
    const nextK = Math.floor((Date.now() - t0) / (plan.intervalMin * 60000)) + 1;
    const nextTarget = t0 + nextK * plan.intervalMin * 60000;
    await sleep(Math.min(Math.max(0, nextTarget - Date.now()), remain));
  }
  /* 收尾采样：让"采样点数 = floor(时长/间隔)+1"在默认短跑下也成立（20 min / 10 min ⇒ 3 点） */
  if (samples.length < plan.expectedSamples && !cdp.closed) await takeSample('收尾');

  /* 证据日台账收尾：**进程退出时补最后一行**（可能 partial）；runComplete 只在"自然跑满计划时长"时为 true */
  const exitReason = cdp.closed ? 'cdp-closed' : 'completed';
  syncDays(Date.now(), { final: true, runComplete: exitReason === 'completed', exitReason });
  try { fs.closeSync(ledgerFd); } catch (e) { /* 已关闭 */ }

  await screenshot(path.join(OUT, `stress-${stamp}-end.png`));
  const wallMs = Date.now() - t0;
  const verdict = evaluateCriteria({
    samples,
    okSamples: samples.filter(s => s.ok),
    pageErrors,
    plan,
    workloadRuns,
    workloadFailures,
    wallMs
  });

  for (const r of verdict.results) {
    if (r.kind === 'skip') log(`[SKIP] ${r.name} —— ${r.detail}`);
    else log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ' —— ' + r.detail : ''}`);
  }
  log(`覆盖班次：${verdict.shifts.join(' → ') || '—'}；末次运行模式 ${samples.filter(s => s.ok).slice(-1)[0] ? samples.filter(s => s.ok).slice(-1)[0].mode : '—'}`);

  const okSamples = samples.filter(s => s.ok);
  const summary = {
    startedAt: new Date(t0).toISOString(),
    requestedMin: plan.requestedMin,
    durationMin: plan.durationMin,
    intervalMin: plan.intervalMin,
    expectedSamples: plan.expectedSamples,
    soakOnly: plan.soakOnly,
    source: plan.source,
    wallMin: Math.round((wallMs / 60000) * 10) / 10,
    samples: samples.length,
    samplesOk: okSamples.length,
    workloadRuns,
    workloadFailures,
    shifts: verdict.shifts,
    first: okSamples[0] || null,
    last: okSamples[okSamples.length - 1] || null,
    pageErrors,
    results: verdict.results,
    csv: path.relative(ROOT, CSV),
    clock: {
      daySeconds: clock.daySeconds, daySecondsSource: clock.source,
      clockCompressed: clock.clockCompressed, memSampleIntervalSec: clock.memSampleIntervalSec
    },
    ledger: path.relative(ROOT, LEDGER),
    ledgerDays: ledgerRows.length,
    ledgerRows,
    log: path.relative(ROOT, LOG)
  };
  fs.writeFileSync(path.join(OUT, `stress-${stamp}-summary.json`), JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n=== 汇总 ===');
  console.log(`本轮：${plan.soakOnly ? '浸泡模式' : '默认短跑'} 请求 ${plan.requestedMin} 分钟（来源 ${plan.source}；` +
    `采样间隔 ${plan.intervalMin} min；采样 ${samples.length}/${plan.expectedSamples} 点；实际墙钟 ${summary.wallMin} min；` +
    `视口 ${SIZE[0]}×${SIZE[1]}）`);
  console.log(summaryLine(verdict));
  if (verdict.failed) {
    console.log('失败清单：');
    verdict.results.filter(r => r.kind === 'check' && !r.pass).forEach((r, i) => console.log(`  ${i + 1}. ${r.name}${r.detail ? ' —— ' + r.detail : ''}`));
  }
  if (verdict.skipped) {
    console.log('跳过清单（不计入失败；长跑专属判据需 --hours 8）：');
    verdict.results.filter(r => r.kind === 'skip').forEach((r, i) => console.log(`  ${i + 1}. ${r.name} —— ${r.detail}`));
  }
  console.log(`明细：${summary.csv} / ${summary.log} / stress-${stamp}-summary.json`);

  console.log(`证据日台账：${summary.ledger}（${ledgerRows.length} 行；证据日 ${clock.daySeconds} s；压缩时钟 `
    + `${clock.clockCompressed ? '**是 ⇒ 不构成 AC-07 证据**' : '否'}；判据用 --verify-soak <台账>）`);
  if (cdp) cdp.close();
  if (edge && edge.exitCode === null) {
    try { edge.kill(); } catch (e) { /* 已退出 */ }
  }
  process.exit(verdict.failed ? 1 : 0);
}

/* 被 require 时只导出纯函数（供记账自检/定点变异用），**不执行**长跑本体 */
if (require.main === module) {
  main().catch(err => {
    log('脚本异常终止：' + (err && err.stack ? err.stack : err));
    console.error(err);
    process.exit(2);
  });
}

module.exports = {
  resolvePlan,
  evaluateCriteria,
  summaryLine,
  SOAK_ONLY_NAMES,
  DEFAULT_MINUTES,
  resolveSoakClock,
  parseSoakLedger,
  verifySoakLedger,
  SOAK_CRITERIA_NAMES,
  SOAK_CRITERION_TAGS,
  REAL_DAY_SEC,
  SOAK_MIN_DAYS,
  SOAK_RSS_GROWTH_K,
  SOAK_GAP_FACTOR,
  SOAK_GAP_SLACK_SEC,
  SOAK_HOURS,
  SOAK_ONLY_MIN,
  USAGE
};
