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
  { name: 'stress-check', desc: '整班次长跑（默认 8 小时）', needBrowser: true, slow: true }
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
 * 权威数字比对的**前置条件**（纯函数，供 `harness-check` 做真值表回归）。
 *
 * 只有"除 `docs-check` 外没有任何失败/未核实脚本"时，本轮账目才完整、才能拿去和权威区比。
 * 依据：`docs-check` 的 2 项失败是 `PROJECT_RULES` 6.4 登记在案、**长期保留**的历史提交信息偏差
 * （决定不改写历史，所以它永远是红的），因此它是唯一被允许的失败项；其余任何失败
 * （典型：候选图未抓取导致 `screenshot-diff` 失败）都会让本轮通过数偏低，
 * 此时比对只会报出**误导性的"权威数字漂移"**。
 *
 * 判据只认 `failed` / `error` / `unverified`：
 * `skipped`（浏览器类脚本在本环境显式退 3）**不是失败**，按既有口径不影响比对。
 *
 * @param {Array<{suite:{name:string},status:string}>} results
 * @returns {string[]} 阻止比对的脚本名（空数组＝可以比对）
 */
function authorityBlockers(results) {
  const BLOCKING = ['failed', 'error', 'unverified'];
  return results
    .filter(r => BLOCKING.includes(r.status) && r.suite.name !== 'docs-check')
    .map(r => r.suite.name);
}

/**
 * 收尾校验 `tests\README.md` 第三节的**权威数字**与本轮实跑是否一致（P2-22）。
 * 为什么放在 runner 而不是某个门禁脚本里：本 runner 是唯一持有"本轮最终账"的地方
 * （suite 成员跑到自己时还看不到后面的脚本），且它不会自递归。
 * 只在**跑全了全部离线门禁**时判定，避免 `--only`/`--fast` 子集造成假失败。
 *
 * **已知偏差容忍**：`docs-check` 的 2 项失败是 6.4 登记在案、长期保留的历史提交信息偏差，
 * 不会去修。故本判定在"仅剩 docs-check 一个失败脚本"时接受两种权威值：
 * ①**含已知偏差的合计**（`agg.passed`，即 README 当前写法）
 * ②**真实通过数**（`agg.passed - 已知偏差数`，即"全绿时应当达到"的值）
 * 这样无论那两项偏差将来修掉与否，权威区只要同步过就不会假失败。
 */
function verifyAuthorityTotals(agg, results) {
  const offlineAll = SUITES.filter(s => !s.needBrowser).map(s => s.name);
  const ran = new Set(results.map(r => r.suite.name));
  const missing = offlineAll.filter(n => !ran.has(n));
  if (missing.length) {
    return { ok: true, kind: 'skipped', detail: `本轮未跑全离线门禁（缺 ${missing.length} 个），跳过权威数字比对` };
  }
  let readme = '';
  try { readme = fs.readFileSync(path.join(env.paths.tests, 'README.md'), 'utf8'); } catch (err) {
    return { ok: false, kind: 'broken', detail: `读不到 tests\\README.md：${err.message}` };
  }
  const numeric = require('./lib/numeric');
  const line = readme.split('\n').find(l => l.includes('离线可跑部分')) || '';
  const stated = numeric.matchNumber(line, /合计\s*\*{0,2}\s*(\d+)\s*通过/);
  if (stated === null) return { ok: false, kind: 'broken', detail: '权威区里找不到"合计 N 通过"' };

  /* 前置条件：只允许"除 docs-check 外全绿"这一种情况。
     2026-09-20 修正判据：原来用 `status !== 'passed'`，把 `skipped`（浏览器类脚本在本环境
     显式退 3）也算成"失败脚本"。改为只认 failed/error/unverified（见 `authorityBlockers`）。
     返回值仍是 `ok:false`（既有 `harness-check` 回归断言按此口径），但**带上 kind='blocked'**，
     由调用方区分"账目不完整"与"权威数字真的漂移"——后者才是要把 exit code 归因给权威校验的那种。 */
  const blockers = authorityBlockers(results);
  if (blockers.length) {
    return { ok: false, kind: 'blocked',
      detail: `本轮账目不完整（${blockers.join('、')} 未通过），权威数字未核对 —— 先修它们` };
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

  /* 顺带校验：runner 认定的离线门禁必须在权威区被逐个点名（新增脚本别忘登记） */
  const named = [...new Set([...line.matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1])
    .filter(n => n.endsWith('-check') || n === 'screenshot-diff'))];
  const notListed = offlineAll.filter(n => !named.includes(n));
  if (notListed.length) {
    return { ok: false, kind: 'broken', detail: `权威区漏列离线门禁：${notListed.join('、')}` };
  }
  return { ok: true, kind: 'ok', detail: `权威区合计 ${stated} ＝ 本轮实跑 ${agg.passed}${allowanceNote}` };
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

  /* 权威数字校验（P2-22）：runner 是唯一持有本轮最终账的地方，故比对放这里做。
     不通过即视为门禁失败 —— "自称权威值却没人看着"正是这条缺陷要堵的洞。
     **位置很关键（2026-09-20 修正）**：必须放在下面 `if (failed.length)` 提前退出**之前**。
     原实现把它放在"全绿收尾"段里，而 `docs-check` 因 2 项 6.4 已登记偏差**永远失败**，
     于是这段校验从来没有执行过一次 —— 机制在源码里，但不可达（与 ADR-0004 要堵的
     "通过数字 ≠ 已验证"同类：**"写了机制" ≠ "机制在跑"**）。
     不可达性由 `harness-check` 的静态断言守着（调用点必须在提前退出之前）。 */
  const auth = verifyAuthorityTotals(agg, results);
  console.log(`\n权威数字校验：${auth.detail}`);
  /* 只有"权威数字真的漂移 / 权威区不可用"才把 exit code 归因给权威校验；
     `blocked`（本轮账目不完整）与 `skipped`（离线门禁没跑全）只如实报告，不在这里提前退出 ——
     否则会抢在下面"失败脚本明细"之前退出，把真正的失败原因盖掉（本轮修的就是这个位置问题）。 */
  if (auth.kind === 'mismatch' || auth.kind === 'broken') {
    console.log('\n失败：tests\\README.md 第三节的权威数字与本轮实跑对不上（或权威区不可用）。');
    console.log('处置：同步 tests\\README.md 第三节（权威值唯一真源），再重跑。');
    process.exit(1);
  }

  if (failed.length) {
    console.log('\n失败脚本明细（每个脚本的最关键几行）：');
    for (const r of failed) {
      const lines = r.out.split('\n').filter(l => /\[FAIL\]|失败清单|^\s+\d+\.|脚本异常终止/.test(l)).slice(0, 8);
      console.log(`\n  ── ${r.suite.name} ──`);
      console.log(lines.map(l => '  ' + l).join('\n') || '  （无失败行可解析，请单独运行该脚本）');
    }
    console.log('\n提示：单独复跑某个脚本：node tests\\<名称>.js');
    console.log(`\n本次各脚本输出已落盘：${path.relative(env.paths.root, path.join(env.paths.verify, 'run-all'))}\\`);
    process.exit(1);
  }

  if (unverified.length) {
    console.log('\n提示：未核实项说明脚本没给出可核实的结论（通常是不该退 0 却退了 0），须先修脚本。');
    process.exit(1);
  }

  if (skipped.length) {
    console.log('\n提示：以上跳过项需在具备浏览器/命名管道权限的环境复跑，详见 tests\\README.md 第四节。');
  }
  /* 权威数字校验已在上方（提前退出之前）完成；此处不再重复。
     收尾：清掉 24 小时前的临时区残留（P2-16 —— `harness.cleanup()` 此前只被"测试存在"，
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

  console.log('\n门禁全绿（无失败脚本）。');
  process.exit(0);
}

/* 被 require 时**不执行**：`harness-check` 要直接引用 classify/parseSummary 做规则回归，
   不能因为 require 一下就把 15 个门禁全跑一遍。 */
module.exports = { classify, parseSummary, isEnvSkip, SUITES, verifyAuthorityTotals, authorityBlockers };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('\nrunner 异常终止：' + (err && err.stack ? err.stack : err));
    process.exit(2);
  }
}
