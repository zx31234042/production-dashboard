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
  { name: 'docs-cross-check', desc: '跨文档一致性', needBrowser: false, slow: false },
  { name: 'trace-check', desc: '需求追溯', needBrowser: false, slow: false },
  { name: 'copy-check', desc: '界面文案与需求条款对照', needBrowser: false, slow: false },
  { name: 'screenshot-diff', desc: '界面视觉回归', needBrowser: false, slow: false },
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

function runScript(suite, pipesOk, quiet) {
  const file = path.join(env.paths.tests, suite.name + '.js');
  const started = Date.now();
  const opts = {
    cwd: env.paths.root,
    timeout: suite.slow ? 12 * 3600 * 1000 : 10 * 60 * 1000,
    env: { ...process.env, DSH_ENV: env.isProd ? 'test' : env.ENV_NAME }
  };
  /* 三种输出模式：
     ① 有管道   —— 捕获输出并解析断言汇总（最优）
     ② 无管道 + 安静 —— 输出重定向到日志文件，主控台只留结果行（输出仍可事后查阅）
     ③ 无管道 + 非安静 —— stdio=inherit 直通（实时看得见，但主控台会很长）
     注意：受限沙箱禁止管道，此时**绝不能**把无法解析当成失败。 */
  let logFile = null;
  let fd = null;
  let stdioOpt;
  if (pipesOk) {
    stdioOpt = { ...opts, encoding: 'utf8' };
  } else if (quiet) {
    const dir = env.ensureDir(path.join(env.paths.verify, 'run-all'));
    logFile = path.join(dir, `${suite.name}-${process.pid}.log`);
    fd = fs.openSync(logFile, 'a');
    stdioOpt = { ...opts, stdio: ['ignore', fd, fd] };
  } else {
    stdioOpt = { ...opts, stdio: 'inherit' };
  }

  const res = spawnSync(process.execPath, [file], stdioOpt);
  const ms = Date.now() - started;
  if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }

  let out = '';
  if (pipesOk) out = `${res.stdout || ''}${res.stderr || ''}`;
  else if (logFile) { try { out = fs.readFileSync(logFile, 'utf8'); } catch { out = ''; } }

  const summary = parseSummary(out);

  /* 管道不可用时，输出不可解析属于**预期**，不得据此判失败；仅退出码 2 视为异常 */
  if (res.error && res.error.code !== 'EPERM') {
    return { status: 'error', detail: res.error.code || res.error.message, ms, out, summary, logFile };
  }
  if (res.status === 2) {
    return { status: 'error', detail: '脚本以退出码 2 终止（异常）', ms, out, summary, logFile };
  }
  if (res.status !== 0 && isEnvSkip(out)) {
    return { status: 'skipped', detail: '环境不满足（脚本自行 SKIP）', ms, out, summary, logFile };
  }
  if (res.status !== 0) {
    return { status: 'failed', detail: `退出码 ${res.status}`, ms, out, summary, logFile };
  }
  /* 退出码 0 但脚本内部有跳过项：算通过，跳过数一并带出 */
  return { status: 'passed', detail: '', ms, out, summary, logFile };
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

  /* 管道能力探测：决定能否"捕获"子进程输出（注：安静模式下输出落文件，仍可解析出断言数） */
  const pipes = probePipes();
  const quiet = hasFlag('--tap') || hasFlag('--fast');
  if (!pipes.ok) {
    console.log('  ⚠ 本环境禁止子进程管道（EPERM）—— 环境限制，不是脚本失败。');
    if (quiet) {
      console.log('     安静模式：各脚本输出落 tests\\._verify\\run-all\\*.log，仍可解析断言数；');
      console.log('     需要逐条明细时直接看那些日志文件（下方会列出路径）。\n');
    } else {
      console.log('     非安静模式：改走 stdio 直通，主控台会完整打印各脚本输出，末尾只按退出码汇总。');
      console.log('     想用安静模式（输出落文件、主控台精简）请加 --tap 或 --fast。\n');
    }
  }

  /* 体检（默认先跑；仅在自身退出码非 0 时提示，不阻断）。安静模式下同样落文件，避免刷屏 */
  if (!hasFlag('--no-preflight')) {
    const preFile = path.join(env.paths.tests, 'preflight.js');
    const preOpts = { cwd: env.paths.root, timeout: 3 * 60 * 1000 };
    let preLog = null;
    let preStdio;
    if (pipes.ok) {
      preStdio = { ...preOpts, encoding: 'utf8' };
    } else if (quiet) {
      const dir = env.ensureDir(path.join(env.paths.verify, 'run-all'));
      preLog = path.join(dir, `preflight-${process.pid}.log`);
      const fd = fs.openSync(preLog, 'a');
      preStdio = { ...preOpts, stdio: ['ignore', fd, fd] };
    } else {
      preStdio = { ...preOpts, stdio: 'inherit' };
    }
    const pre = spawnSync(process.execPath, [preFile], preStdio);
    const preOut = pipes.ok ? `${pre.stdout || ''}${pre.stderr || ''}`
      : (preLog ? (() => { try { return fs.readFileSync(preLog, 'utf8'); } catch { return ''; } })() : '');
    const preSum = parseSummary(preOut);
    if (pre.status === 0 && preSum) {
      console.log(`  [体检] 通过 ${preSum.passed} 项（跳过 ${preSum.skipped} 项）`);
    } else if (pre.status === 0) {
      console.log('  [体检] 关键项通过（断言数未采集）');
    } else {
      console.log('  [体检] 未通过 —— 请先排查环境问题，再解读下面的脚本结果');
      if (preOut) console.log(preOut.split('\n').filter(l => /\[FAIL\]|失败清单|^\s+\d+\./.test(l)).slice(0, 6).map(l => '    ' + l).join('\n'));
    }
    if (preLog) console.log(`     体检日志：${path.relative(env.paths.root, preLog)}`);
    console.log('');
  }

  const results = [];
  for (const s of suites) {
    if (pipes.ok) process.stdout.write(`  运行 ${s.name.padEnd(20)} … `);
    else if (quiet) process.stdout.write(`  运行 ${s.name.padEnd(20)} … `);
    else console.log(`\n  ── 运行 ${s.name}（${s.desc}）──`);
    const r = runScript(s, pipes.ok, quiet);
    results.push({ suite: s, ...r });
    const mark = { passed: '通过', failed: '失败', skipped: '跳过', error: '异常' }[r.status];
    const sum = r.summary ? `（通过 ${r.summary.passed} / 失败 ${r.summary.failed} / 跳过 ${r.summary.skipped}）` : '';
    if (pipes.ok || quiet) console.log(`${mark} ${(r.ms / 1000).toFixed(1)}s ${sum}${r.detail ? ' ' + r.detail : ''}`);
    else console.log(`  → ${mark}（${(r.ms / 1000).toFixed(1)}s${r.detail ? '，' + r.detail : ''}）`);
  }

  /* 安静模式：把各脚本日志路径列出来，保证输出仍可查阅（不隐藏信息） */
  if (!pipes.ok && quiet) {
    const logs = results.filter(r => r.logFile).map(r => r.logFile);
    if (logs.length) {
      console.log('\n  子进程输出已落文件（本环境无管道，故不逐条打印；需要时直接看这些文件）：');
      for (const p of logs) console.log(`    ${path.relative(env.paths.root, p)}`);
    }
  }

  /* ---------------- 汇总 ---------------- */
  const failed = results.filter(r => r.status === 'failed' || r.status === 'error');
  const skipped = results.filter(r => r.status === 'skipped');
  const agg = results.reduce((a, r) => {
    if (r.summary) { a.passed += r.summary.passed; a.failed += r.summary.failed; a.skipped += r.summary.skipped; }
    return a;
  }, { passed: 0, failed: 0, skipped: 0 });

  console.log('\n=== 各脚本结果 ===');
  for (const r of results) {
    const sum = r.summary ? `${r.summary.passed} / ${r.summary.failed} / ${r.summary.skipped}` : '— / — / —';
    const mark = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP', error: 'ERR ' }[r.status];
    console.log(`  ${mark}  ${r.suite.name.padEnd(20)} ${sum.padStart(12)}   ${r.suite.desc}`);
  }

  console.log('\n=== 合计 ===');
  if (agg.passed + agg.failed + agg.skipped > 0) {
    console.log(`  断言：通过 ${agg.passed} / 失败 ${agg.failed} / 跳过 ${agg.skipped}`);
    if (!pipes.ok) console.log('        （本环境无管道，数字由安静模式的日志文件解析得出）');
  } else {
    console.log(`  断言：**本次未采集**（原因：${quiet ? '各脚本日志里未找到可解析的汇总行' : '非安静模式 + 无管道，输出已直通到主控台'}）`);
    console.log('        ⇒ 想拿到断言级合计：加 --tap / --fast，或在有管道权限的环境运行；');
    console.log('        ⇒ 各脚本的权威数字见 tests\\README.md 第三节。');
  }
  console.log(`  脚本：${results.length - failed.length - skipped.length} 通过 / ${failed.length} 失败 / ${skipped.length} 跳过`);
  if (skipped.length) {
    console.log(`  跳过脚本（环境不满足，**不是通过**）：${skipped.map(r => r.suite.name).join(', ')}`);
  }

  if (failed.length) {
    console.log('\n失败脚本明细（每个脚本的最关键几行）：');
    for (const r of failed) {
      const lines = r.out.split('\n').filter(l => /\[FAIL\]|失败清单|^\s+\d+\.|脚本异常终止/.test(l)).slice(0, 8);
      console.log(`\n  ── ${r.suite.name} ──`);
      console.log(lines.map(l => '  ' + l).join('\n') || '  （无失败行可解析，请单独运行该脚本）');
    }
    console.log('\n提示：单独复跑某个脚本：node tests\\<名称>.js');
    process.exit(1);
  }

  if (skipped.length) {
    console.log('\n提示：以上跳过项需在具备浏览器/命名管道权限的环境复跑，详见 tests\\README.md 第四节。');
  }
  console.log('\n门禁全绿（无失败脚本）。');
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('\nrunner 异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
