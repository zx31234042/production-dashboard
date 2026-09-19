/* ==========================================================================
   测试环境体检（tests/preflight.js）
   作用：跑门禁**之前**先确认环境可用，把"环境问题"与"代码问题"分开报 ——
        否则环境缺失会伪装成一堆断言失败，白花排查时间。
   检查项：Node 版本下限 / 运行时能力（node:sqlite、全局 fetch、AbortSignal.timeout）
          / 临时区可写 / 磁盘余量 / 端口可用性 / Edge 可用性（截图类脚本要用）
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

try {
  main();
} catch (err) {
  console.error('\n体检脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
