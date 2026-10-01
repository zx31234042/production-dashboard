/* ==========================================================================
   测试环境体检（tests/preflight.js）
   作用：跑门禁**之前**先确认环境可用，把"环境问题"与"代码问题"分开报 ——
        否则环境缺失会伪装成一堆断言失败，白花排查时间。
   检查项：Node 版本下限 / 运行时能力（node:sqlite、全局 fetch、AbortSignal.timeout）
          / 临时区可写 / 磁盘余量 / 端口可用性 / Edge 可用性（截图类脚本要用）＋ **Edge 版本下限 ≥ 112**（`--headless=new` 的前提，E54）
          / 子进程管道能力（决定 browser-check、overlap-check、stress-check 能否跑）
   依据：ADR-0003 D15/D17；规范 9.5-5 第 6 条（跑不了的脚本必须显式说明，不得静默通过）。
   运行：node tests/preflight.js
   退出码：0 = 关键项全通过（可能有非关键警告）；1 = 有关键项不通过。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const env = require('./env');
const { createRunner } = require('./lib/assert');
const { makeTempDb, allocPort } = require('./lib/harness');

const t = createRunner('测试环境体检（preflight）');
const warnings = [];

async function main() {
  t.info(env.describe());

  /* ---------------- 一、运行时下限与能力 ---------------- */
  t.section('一、运行时下限与内置能力');
  t.check(
    `Node 版本不低于 ${env.MIN_NODE_MAJOR}（node:sqlite 免实验标志的前提，ADR-0002 D10）`,
    env.nodeMajor() >= env.MIN_NODE_MAJOR,
    `当前 ${process.version}`
  );
  /* 注意：本脚本**故意不调用 env.assertRuntime()** —— 它是"跑门禁之前的体检"，
     职责是把"环境问题"**报成检查项**（好让人知道缺什么），而不是自己先退 2。
     故 D16 的 prod 拒绝在此以断言形式表达（preflight 自身免于"必须调 assertRuntime"的静态断言）。 */
  t.check('DSH_ENV 合法且不是 prod（D16：测试进程不得指向生产数据目录）',
    env.ENV_NAME !== 'prod' && ['dev', 'test'].includes(env.ENV_NAME),
    `DSH_ENV=${env.ENV_NAME}`);

  let sqliteOk = false;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const h = makeTempDb({ initSql: 'CREATE TABLE t(a INTEGER);' });
    h.db.prepare('INSERT INTO t VALUES(1)').run();
    const n = h.db.prepare('SELECT COUNT(*) AS c FROM t').get().c;
    sqliteOk = n === 1 && h.journalMode === 'wal';
    /* 顺带验证"一个用例一个库"确实生效：两个临时库互不可见 */
    const h2 = makeTempDb();
    const isolated = h.path !== h2.path;
    h.close(); h2.close();
    t.check('node:sqlite 可用且 WAL 生效、临时库互相隔离', sqliteOk && isolated,
      `journal_mode=${h.journalMode}，路径隔离=${isolated}`);
  } catch (err) {
    t.check('node:sqlite 可用且 WAL 生效、临时库互相隔离', false, err.message);
  }

  t.check('全局 fetch 可用（IF-B 上报与就绪探测都依赖它）', typeof fetch === 'function');
  t.check('AbortSignal.timeout 可用（上报超时中断）',
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function');
  t.check('node:net 可用（TCP 探活，替代 ping 的零子进程方案）',
    typeof net.createServer === 'function');

  /* ---------------- 二、临时区可写与磁盘余量 ---------------- */
  t.section('二、临时区与磁盘');
  try {
    const dir = env.ensureDir(env.paths.tempRoot);
    const probeFile = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probeFile, 'ok', 'utf8');
    const ok = fs.readFileSync(probeFile, 'utf8') === 'ok';
    fs.rmSync(probeFile, { force: true });
    t.check('测试临时区可写（tests/._verify/tmp，已被 .gitignore 忽略）', ok,
      path.relative(env.paths.root, dir));
  } catch (err) {
    t.check('测试临时区可写（tests/._verify/tmp，已被 .gitignore 忽略）', false, err.message);
  }

  t.check('测试数据目录位于 ._verify 之下（D16：绝不写生产目录）',
    env.isInsideVerify(env.paths.testData),
    path.relative(env.paths.root, env.paths.testData));

  try {
    const st = fs.statfsSync(env.paths.root);
    const freeGB = Number(st.bavail) * Number(st.bsize) / 1073741824;
    t.check('磁盘剩余空间 ≥ 1 GB（1 年落库约 0.34 GB，且测试会产生临时库）', freeGB >= 1,
      `可用 ${freeGB.toFixed(1)} GB`);
  } catch (err) {
    t.check('磁盘剩余空间 ≥ 1 GB（1 年落库约 0.34 GB，且测试会产生临时库）', false, err.message);
  }

  /* ---------------- 三、端口可用性 ---------------- */
  t.section('三、端口可用性（联调工具与后端服务要用）');
  try {
    const p1 = await allocPort();
    const p2 = await allocPort();
    t.check('能取得两个空闲本地端口且互不相同', p1 > 0 && p2 > 0 && p1 !== p2, `分配 ${p1} / ${p2}`);
  } catch (err) {
    t.check('能取得两个空闲本地端口且互不相同', false, err.message);
  }

  /* ---------------- 四、浏览器与子进程能力（决定哪些脚本能跑） ---------------- */
  t.section('四、浏览器与子进程能力（决定哪些脚本可跑）');
  const edgePaths = [
    process.env.MSEDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  const edge = edgePaths.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  t.check('能找到 Edge 可执行文件（browser-check / capture-baseline / overlap-check 需要）',
    Boolean(edge), edge || '未找到（可用环境变量 MSEDGE_PATH 指定）');
  if (!edge) warnings.push('未找到 Edge：浏览器类脚本将无法运行');
  /** 读 Edge 主版本（E54）：① 优先看安装目录下的**版本号目录**（`Application\154.0.4258.37\`，不依赖子进程）；
   *  ② 退路 `msedge.exe --version`；两路都读不到则 major=0（断言如实判失败并写明"读取失败"）。 */
  function readEdgeMajor(exe) {
    try {
      const vs = fs.readdirSync(path.dirname(exe)).filter(n => /^\d+\.\d+\.\d+\.\d+$/.test(n));
      if (vs.length) {
        const best = vs.map(s => s.split('.').map(Number))
          .sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]) || (b[2] - a[2]) || (b[3] - a[3]))[0];
        if (best && best[0] > 0) return { major: best[0], raw: best.join('.') + '（版本目录）' };
      }
    } catch { /* 落到 ② */ }
    try {
      const r = require('node:child_process').spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 8000 });
      const s = String((r.stdout || '') + (r.stderr || '')).trim();
      const m = s.match(/(\d+)\./);
      return { major: m ? Number(m[1]) : 0, raw: s };
    } catch { return { major: 0, raw: '' }; }
  }

  /* E54（2026-09-29 登记，现场实测暴露）：浏览器类门禁脚本用 `--headless=new`，**需要 Edge ≥ 112**。
     现场首份报告（DESKTOP-1K4A22L）Edge 为 **92.0.902.67** ⇒ 四个脚本跑不了，而失败信息**不点名"Edge 太旧"**
     （原实现只查"能不能找到 Edge"）。这里把版本要求显式化：找到 Edge 就断言主版本；找不到则按
     "环境能力缺失"**跳过**（上一条已如实判失败），并把升级办法写进原因，避免现场看不懂红项。 */
  if (edge) {
    const ev = readEdgeMajor(edge);
    t.check('Edge 主版本 ≥ 112（`--headless=new` 的前提：browser-check / capture-baseline / overlap-check / stress-check 依赖）',
      ev.major >= 112,
      `${edge} → ${ev.raw || '版本读取失败'}` +
      (ev.major >= 112 ? '' : '　⇒ **版本过旧**：请用离线升级件升级 Edge（否则浏览器类脚本拿不到证据），或在 Edge ≥ 112 的机器上跑'));
  } else {
    t.skip('Edge 主版本 ≥ 112（`--headless=new` 的前提）', '未找到 Edge（见上一条断言）—— 浏览器类脚本在本环境无法运行');
  }


  /* 子进程管道能力：受限沙箱会以 EPERM 拒绝；这属于**环境能力缺失**而非体检失败，
     故记为跳过（同时进警告），避免"环境问题伪装成断言失败"——这正是体检要避免的事。 */
  let pipeOk = false;
  let pipeReason = '';
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, ['-e', 'console.log(1)'], { encoding: 'utf8', timeout: 8000 });
    pipeOk = r.status === 0 && String(r.stdout).trim() === '1';
    if (!pipeOk) pipeReason = r.error ? `error=${r.error.code}` : `status=${r.status}`;
  } catch (err) {
    pipeReason = err.code || err.message;
  }
  if (pipeOk) {
    t.check('子进程管道可用（浏览器类与长跑脚本可运行）', true, '');
  } else {
    t.skip('子进程管道可用（浏览器类与长跑脚本可运行）',
      `不可用（${pipeReason}）—— 环境限制，run-all 将显式跳过相关脚本，不算失败`);
    warnings.push('子进程管道不可用：browser-check / overlap-check / stress-check 将被跳过');
  }

  /* ---------------- 汇总 ---------------- */
  if (warnings.length) {
    t.section('非关键警告（不影响门禁结果）');
    warnings.forEach(w => t.info('· ' + w));
  }
  t.finish();
}

/* 先例写法（同 browser-check.js:828、contract-check.js:1624、docs-check.js:547 …）：
   `main()` 是 **async** ⇒ 它的 rejection **不会**被"顶层 try/catch"接住。**E76① 的记账口径
   （实测，勿沿用旧说法）**：这条路走成"无汇总行 ＋ 退 1" ⇒ `run-all.classify(1, null, out)`
   ⇒ `status='failed'`、`detail='退出码 1'`，与"有断言失败"在 `run-all` 台账上**逐字同形**
   （`unverified` 只对"**退 0** 且无汇总行／通过 0 项"成立）。故必须把 `.catch()` 挂在 promise 上
   接住，并按规范 9.5-5 退 **2**（脚本自身异常），异常**打印出来**（可 grep）。
   打印前缀现状见 `lib/assert.js` 末注：`[脚本异常]` 目前只有 E76 修的这 3 个脚本在用。 */
main().catch(err => {
  console.error('\n[脚本异常] 体检脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
