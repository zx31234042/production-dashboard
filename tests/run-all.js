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
   退出码：0 = 无失败；1 = 有脚本失败；2 = 环境不满足（Node 版本等）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

/* ---------------- 门禁清单 ----------------
   needBrowser 脚本在受限环境（沙箱禁命名管道）会自行 SKIP，runner 据此归类为"跳过"。
   slow 脚本默认在 --fast 下不跑。 */
const SUITES = [
  { name: 'contract-check', desc: '字段契约与适配层', needBrowser: false, slow: false },
  { name: 'ui-check', desc: '界面结构与需求条款', needBrowser: false, slow: false },
  { name: 'tools-check', desc: '联调工具进程级行为', needBrowser: false, slow: false },
  { name: 'docs-check', desc: '文档与规范一致性', needBrowser: false, slow: false },
  { name: 'files-check', desc: '编码与文件卫生', needBrowser: false, slow: false },
  { name: 'harness-check', desc: '夹具自检（时钟/样本/注入/服务启停）', needBrowser: false, slow: false },
  { name: 'logic-check', desc: '当班统计与班次边界（FR-4 / DR-17）', needBrowser: false, slow: false },
  { name: 'db-check', desc: '本地库结构与仓储层', needBrowser: false, slow: false },
  { name: 'platform-check', desc: '平台适配层（路径/ID/日志）', needBrowser: false, slow: false },
  { name: 'trace-check', desc: '需求追溯', needBrowser: false, slow: false },
  { name: 'copy-check', desc: '界面文案与需求条款对照', needBrowser: false, slow: false },
  { name: 'screenshot-diff', desc: '界面视觉回归', needBrowser: false, slow: false },
  /* 放在**最后**：它是跨文档/总账性质的聚合检查，要靠前面跑完的实跑账去比对
     `tests\README.md` 的权威数字（P2-22）；排在前面会读到不完整的账。 */
  { name: 'docs-cross-check', desc: '跨文档一致性 + 权威数字校验', needBrowser: false, slow: false },
  { name: 'browser-check', desc: '真实浏览器（无头 Edge + CDP）', needBrowser: true, slow: false },
  { name: 'overlap-check', desc: '元素重叠检测', needBrowser: true, slow: false },
  /* slow 仍为 true：默认 20 分钟虽不再是"整夜浸泡"，但仍是本仓最耗时的一类（起真浏览器 + 采样），
     `--fast` 下跳过它是对的；整班次浸泡改由 `--soak` / `--hours 8` 显式触发（见 stress-check.js）。 */
  { name: 'stress-check', desc: '长跑稳定性（默认 20 分钟；--soak / --hours 8 为整班次浸泡）', needBrowser: true, slow: true }
];

/** 从脚本文本里数出 check( 调用条数（静态口径，仅作参考展示） */
function countCheckCalls(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    return (src.match(/\bcheck\(/g) || []).length;
  } catch { return 0; }
}

function parseSummary(out) {
  const m = out.match(/通过\s*(\d+)\s*项，失败\s*(\d+)\s*项(?:，跳过\s*(\d+)\s*项)?/);
  if (!m) return null;
  return { passed: Number(m[1]), failed: Number(m[2]), skipped: m[3] === undefined ? 0 : Number(m[3]) };
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
 * 把"截至此刻的实跑账"落盘，供 `docs-cross-check` 比对权威值（P2-22 的单向契约）。
 *
 * 为什么每跑完一个脚本就写一次：`docs-cross-check` **本身就是 suite 成员**，
 * 它运行时需要读到"已经跑过的那些脚本的实跑数字"；若等 run-all 收尾才写，
 * 它读到的永远是上一轮的旧账（首版就是这么设计错的）。
 * 同时落 `expectedOffline`：权威区只覆盖 13 个离线门禁，据此判断"这次跑得够不够全"。
 */
/**
 * 把"截至此刻的实跑账"落盘。**只做留痕，不承担比对** —— 比对在收尾统一做
 * （见 verifyAuthorityTotals）；理由是 suite 成员读不到本轮最终账。
 */
function writeRunTotals(results) {
  try {
    const agg = results.reduce((a, r) => {
      if (r.summary) { a.passed += r.summary.passed; a.failed += r.summary.failed; a.skipped += r.summary.skipped; }
      return a;
    }, { passed: 0, failed: 0, skipped: 0 });
    const byStatus = st => results.filter(r => r.status === st).length;
    const offlineNames = SUITES.filter(s => !s.needBrowser).map(s => s.name);
    const file = path.join(env.ensureDir(env.paths.verify), 'run-totals.json');
    fs.writeFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      mode: hasFlag('--fast') ? '--fast' : (optValue('--only') ? `--only ${optValue('--only')}` : 'default'),
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
 *   - **`docs-check` D2 段失败清单实际列出 12 条**（9 条缺 `类型:` 前缀 + 3 条超过 30 字）
 *     → `listedItems`（= 6.4 本表逐条登记 3 条 + 同类早期 9 条）；
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
    /* 失败清单里逐条列出的偏差条数（README / 6.4 口径：9 条缺前缀 + 3 条超 30 字） */
    listedItems: 12,
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
function verifyAuthorityTotals(agg, results) {
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
  const notListed = authorityAll.filter(n => !named.includes(n));
  if (notListed.length) {
    return { ok: false, kind: 'broken', detail: `权威区漏列离线门禁：${notListed.join('、')}` };
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

function main() {
  if (hasFlag('--list')) {
    console.log('=== 门禁脚本清单 ===');
    for (const s of SUITES) {
      console.log(`  ${s.name.padEnd(20)} ${s.desc}${s.needBrowser ? '  [需浏览器]' : ''}${s.slow ? '  [耗时长]' : ''}`);
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
  console.log(`  共 ${suites.length} 个脚本${hasFlag('--fast') ? '（--fast：已跳过浏览器类与长跑）' : ''}\n`);

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
      if (preOut) console.log(preOut.split('\n').filter(l => /\[FAIL\]|失败清单|^\s+\d+\./.test(l)).slice(0, 6).map(l => '    ' + l).join('\n'));
    }
    console.log(`     体检日志：${path.relative(env.paths.root, preLog)}`);
    console.log('');
  }

  const results = [];
  for (const s of suites) {
    if (quiet) process.stdout.write(`  运行 ${s.name.padEnd(20)} … `);
    else console.log(`\n  ── 运行 ${s.name}（${s.desc}）──`);
    const r = runScript(s, pipes.ok, quiet);
    results.push({ suite: s, ...r });
    const mark = { passed: '通过', failed: '失败', skipped: '跳过', error: '异常', unverified: '未核实' }[r.status];
    const sum = r.summary ? `（通过 ${r.summary.passed} / 失败 ${r.summary.failed} / 跳过 ${r.summary.skipped}）` : '';
    console.log(`${mark} ${(r.ms / 1000).toFixed(1)}s ${sum}${r.detail ? ' ' + r.detail : ''}`);
    /* **每跑完一个就更新落盘**，而不是等收尾 —— 因为 `docs-cross-check` 本身是 suite 成员，
       它要在自己运行时读到"截至此刻的实跑账"，等收尾写就永远读到上一轮的旧账（P2-22）。 */
    writeRunTotals(results);
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
      console.log('\n失败脚本明细（每个脚本的最关键几行）：');
      for (const r of failed) {
        const lines = r.out.split('\n').filter(l => /\[FAIL\]|失败清单|^\s+\d+\.|脚本异常终止/.test(l)).slice(0, 8);
        console.log(`\n  ── ${r.suite.name} ──`);
        console.log(lines.map(l => '  ' + l).join('\n') || '  （无失败行可解析，请单独运行该脚本）');
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
     从未在真实运行里被调用过；放在全绿收尾处，既不干扰本轮用例，又能防止临时目录无限堆积）。 */
  try {
    const { cleanup } = require('./lib/harness');
    const swept = cleanup(false);
    if (swept && swept.removed > 0) {
      console.log(`\n  临时区收尾：清理 24 小时前的残留 ${swept.removed} 项（保留 ${swept.kept} 项，均为本轮产物）`);
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
  REGISTERED_DEVIATIONS, failedAssertionNames, resolveGateOutcome, finalExitCode };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('\nrunner 异常终止：' + (err && err.stack ? err.stack : err));
    process.exit(2);
  }
}
