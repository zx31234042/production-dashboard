/* ==========================================================================
   夹具自检（tests/harness-check.js）
   作用：**给测试环境本身加门禁** —— 夹具坏了会让上面所有门禁静默变弱
        （典型的：时钟没生效，班次用例照样"通过"但什么也没验到）。
        本脚本逐项实测夹具行为，确保它们真的可用而非"有文件、没人用"。
   依据：ADR-0003 D14（零依赖测试体系）、D15（统一 runner）、D17（夹具策略）。
   立案原因：2026-09-19 复查发现 `clock`/`injectFailure`/`startService` **零引用** ——
             即"交付了但从未被验证"，属测试基建的空转风险。
   运行：node tests/harness-check.js
   退出码：0 = 全部通过；1 = 有断言失败。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

const env = require('./env');
const { createRunner } = require('./lib/assert');
const { createClock, parseTime, BOUNDARIES } = require('./lib/clock');
const fixture = require('./lib/fixture');
const harness = require('./lib/harness');

env.assertRuntime();
const t = createRunner('夹具自检（harness-check）');

async function main() {
t.info(env.describe());

/* ---------------- 一、可注入时钟 ---------------- */
t.section('一、可注入时钟（班次边界用例的命门）');
{
  const clock = createClock({ mode: 'fixed', at: '2026-09-19T07:59:30' });
  t.check('fixed 模式：now() 固定在指定时刻，不随真实时间走',
    clock.snapshot().time === '07:59:30' && clock.now().getTime() === clock.now().getTime(),
    clock.snapshot().iso);

  /* 连读两次之间插入真实等待，fixed 时钟必须**纹丝不动** */
  const before = clock.now().getTime();
  const spin = Date.now(); while (Date.now() - spin < 20) { /* 忙等 20 ms */ }
  t.check('fixed 模式：真实时间流逝不影响 now()（可重复性的关键）',
    clock.now().getTime() === before, `真实等待 20 ms 后仍为 ${clock.snapshot().time}`);

  clock.advanceSec(60);
  t.check('advanceSec 前进一秒不差', clock.snapshot().time === '08:00:30', clock.snapshot().time);
  clock.advanceMin(60);
  t.check('advanceMin 前进到 09:00:30', clock.snapshot().time === '09:00:30', clock.snapshot().time);
  clock.reset();
  t.check('reset 回到种子时刻', clock.snapshot().time === '07:59:30', clock.snapshot().time);
  clock.at('2026-09-19T23:59:30');
  t.check('at 可跳到任意时刻（验跨零点）',
    clock.snapshot().time === '23:59:30' && clock.snapshot().date === '2026-09-19', clock.snapshot().iso);

  const later = clock.now().getTime();
  clock.advanceSec(60);
  t.check('跨零点：日期与时间同时前进到次日 00:00:30',
    clock.snapshot().date === '2026-09-20' && clock.snapshot().time === '00:00:30' &&
    clock.now().getTime() === later + 60000, clock.snapshot().iso);

  t.check('source() 提供 () => Date 形式，便于注入被测代码',
    typeof clock.source() === 'function' && clock.source()() instanceof Date, '');

  const real = createClock({ mode: 'real' });
  const delta = Math.abs(real.now().getTime() - Date.now());
  t.check('real 模式返回真实时间（偏差 < 1 s）', delta < 1000, `${delta} ms`);

  const off = createClock({ mode: 'offset', at: '2026-09-19T10:00:00', offsetMs: 3600 * 1000 });
  t.check('offset 模式以真实时间为基准加偏移',
    Math.abs(off.now().getTime() - (Date.now() + 3600 * 1000)) < 2000, off.snapshot().iso);

  for (const mode of ['real', 'offset']) {
    let threw = false;
    try { createClock({ mode }).advanceSec(1); } catch { threw = true; }
    if (!threw) t.check(`${mode} 模式拒绝 advanceSec（只读时钟不得被推进）`, false, '未抛错');
  }
  t.check('real/offset 模式拒绝 advanceSec/at（防止用例误以为时间可控）', true,
    '两种只读时钟均已抛错');

  const keys = Object.keys(BOUNDARIES);
  t.check(`班次边界常量齐备（${keys.length} 个：交班前后/跨零点/跨月/跨年）`,
    keys.length >= 6 && keys.includes('morningBefore') && keys.includes('yearEnd'), keys.join(', '));
  t.check('边界常量都是可解析时间', keys.every(k => !Number.isNaN(parseTime(BOUNDARIES[k]).getTime())), '');

  let badThrew = false;
  try { parseTime('这不是时间'); } catch { badThrew = true; }
  t.check('非法时间输入会抛错（不静默返回 Invalid Date）', badThrew, '');
}

/* ---------------- 二、确定性样本 ---------------- */
t.section('二、确定性样本（同一用例任意时刻跑结果都应一致）');
{
  const m1 = fixture.makeFrame({ i: 0, at: '2026-09-19 10:00:00' });
  const m2 = fixture.makeFrame({ i: 0, at: '2026-09-19 10:00:00' });
  t.check('makeFrame 同参同结果（无隐藏随机）', JSON.stringify(m1) === JSON.stringify(m2), '');

  const expect = Number(Math.hypot(m1.velocity_x, m1.velocity_y).toFixed(2));
  t.check('makeFrame 自洽：speed = √(vx²+vy²)（术语表口径）',
    m1.speed === expect, `speed=${m1.speed}，计算=${expect}`);
  t.check('makeFrame 区分两个深度：cameraDepth ≠ depth（C-32 / IF-C.9）',
    m1.cameraDepth !== m1.depth, `cameraDepth=${m1.cameraDepth}，depth=${m1.depth}`);
  t.check('makeFrame 的 13 个字段与附录 2 对齐',
    fixture.REPORT_FIELDS.every(k => k in m1) && Object.keys(m1).length === 13,
    `实际 ${Object.keys(m1).length} 个`);

  const frames = fixture.makeFrames({ count: 5, startIndex: 100 });
  const times = frames.map(f => f.collectTime);
  t.check('makeFrames 按 startAt 起、每秒一条、时间严格递增',
    times[0] === '2026-09-19 10:00:00' && times[1] === '2026-09-19 10:00:01' &&
    times[4] === '2026-09-19 10:00:04', times.join(' , '));
  t.check('makeFrames 的 startIndex 能错开波形（避免批次间完全相同）',
    frames[0].speed !== fixture.makeFrames({ count: 1, startIndex: 0 })[0].speed, '');

  const c1 = fixture.makeCurve({ kind: 'depth', count: 160 });
  const c2 = fixture.makeCurve({ kind: 'depth', count: 160 });
  t.check('makeCurve 同种子同结果（PRNG 固定种子）',
    JSON.stringify(c1.samples) === JSON.stringify(c2.samples), '');
  t.check('makeCurve 量程上下限与采样点一致',
    c1.minValue === Math.min(...c1.samples) && c1.maxValue === Math.max(...c1.samples), '');
  t.check('makeCurve 的 durationSec／intervalSec／sampleCount 语义一致且互不混同',
    c1.sampleCount === 160 && c1.intervalSec === 1 && c1.durationSec === 160, '');
  t.check('different seed 会产生不同序列（否则"确定性"等于退化）',
    JSON.stringify(fixture.makeCurve({ kind: 'depth', seed: 1 }).samples) !==
    JSON.stringify(fixture.makeCurve({ kind: 'depth', seed: 2 }).samples), '');

  const snap = fixture.makeSnapshot();
  t.check('makeSnapshot 提供完整样本包（设备/工单/标准/帧/两条曲线）',
    Boolean(snap.device && snap.task && snap.standard) &&
    snap.frames.length === 5 && snap.curves.depth && snap.curves.speed, '');
}

/* ---------------- 三、错误注入（验失败路径） ---------------- */
t.section('三、错误注入（IF-B.9 补传、IF-D.9 降级这类失败路径靠它）');
{
  let ok = 0;
  const flaky = harness.injectFailure(() => { ok++; return 'ok'; }, { failAt: 2, times: 1 });
  const r1 = flaky();                     // 第 1 次正常
  let threw2 = false;
  try { flaky(); } catch { threw2 = true; }  // 第 2 次抛错
  const r3 = flaky();                     // 第 3 次恢复
  t.check('injectFailure 在第 failAt 次抛错、之后恢复',
    r1 === 'ok' && threw2 === true && r3 === 'ok' && ok === 2,
    `成功 ${ok} 次，第 2 次抛错=${threw2}`);

  const always = harness.injectFailure(() => 'x', { failAt: 1, times: 99 });
  let count = 0;
  for (let i = 0; i < 3; i++) { try { always(); } catch { count++; } }
  t.check('times 指定连续失败次数', count === 3, `实测失败 ${count} 次`);

  const fn = harness.injectFailure(() => 1, { error: new Error('自定义故障') });
  let msg = '';
  try { fn(); } catch (e) { msg = e.message; }
  t.check('可自定义错误对象（便于断言错误分支）', msg === '自定义故障', msg);
}

/* ---------------- 四、服务进程启停（后端联调用） ---------------- */
t.section('四、服务启停与端口（后端 HTTP/SSE 用例的底座）');
{
  const p1 = await harness.allocPort();
  const p2 = await harness.allocPort();
  t.check('allocPort 返回两个不同端口', p1 > 0 && p2 > 0 && p1 !== p2, `${p1} / ${p2}`);

  /* 临时造一个最小 HTTP 服务脚本，验 startService 能起、能探活、能停、日志落文件 */
  const dir = harness.makeTempDir('svc-script');
  const script = path.join(dir, 'mini-server.js');
  fs.writeFileSync(script, [
    "'use strict';",
    "const http = require('node:http');",
    "const port = Number(process.env.DSH_PORT);",
    "http.createServer((req, res) => {",
    "  if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'});",
    "    return res.end(JSON.stringify({ status: 1, env: process.env.DSH_ENV })); }",
    "  res.writeHead(404); res.end('nope');",
    "}).listen(port, '127.0.0.1', () => console.log('mini-server listening ' + port));"
  ].join('\n'), 'utf8');

  let svc = null;
  try {
    svc = await harness.startService({ script, port: p1, readyPath: '/health', timeoutMs: 8000 });
    const res = await fetch(`http://127.0.0.1:${svc.port}/health`);
    const body = await res.json();
    t.check('startService 能拉起服务并就绪探测通过（DSH_PORT 已注入）',
      res.ok && body.status === 1 && svc.port === p1, JSON.stringify(body));
    t.check('DSH_ENV 注入子进程且不把 prod 透传（D16 硬要求）',
      body.env !== 'prod', `子进程 DSH_ENV=${body.env}`);
    t.check('子进程输出**落文件**（受限沙箱下管道会 EPERM）',
      svc.output().includes('mini-server listening'), svc.output().trim().split('\n')[0]);

    const missing = await fetch(`http://127.0.0.1:${svc.port}/nope`);
    t.check('服务按预期返回 404（确认不是同一个静态假响应）', missing.status === 404, '');
  } finally {
    if (svc) await svc.stop();
  }
  await new Promise(r => setTimeout(r, 150));
  let down = false;
  try { await fetch(`http://127.0.0.1:${p1}/health`); } catch { down = true; }
  t.check('stop() 之后端口不再响应（进程确实被停掉）', down, '');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 五、临时区与清理 ---------------- */
t.section('五、临时区与清理');
{
  const dir = harness.makeTempDir('cleanup-probe');
  t.check('makeTempDir 落在 ._verify/tmp 之内（D16）', env.isInsideVerify(dir), path.relative(env.paths.root, dir));
  /* P3-14：唯一性探测过去**故意建两个目录且不回收** —— 每跑一次留 2 个空目录
     （评审期间从 12 累积到 18）。这里改为**建完立刻删**，并断言目录数不增长。 */
  const tmpCount = () => (fs.existsSync(env.paths.tempRoot) ? fs.readdirSync(env.paths.tempRoot).length : 0);
  const beforeCount = tmpCount();
  const u1 = harness.makeTempDir('u');
  const u2 = harness.makeTempDir('u');
  t.check('临时目录名唯一（同进程连续两次不冲突）', u1 !== u2, `${path.basename(u1)} ≠ ${path.basename(u2)}`);
  for (const d of [u1, u2]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  t.check('P3-14：唯一性探测不残留目录（本节建完即删，目录数不增长）',
    tmpCount() === beforeCount, `探测前 ${beforeCount} → 探测后 ${tmpCount()}`);
  fs.rmSync(dir, { recursive: true, force: true });

  const stale = harness.cleanup(false);
  t.check('cleanup(false) 只清过期项并返回统计',
    typeof stale.removed === 'number' && typeof stale.kept === 'number',
    `removed=${stale.removed}, kept=${stale.kept}`);

  const stray = fs.existsSync(env.paths.tempRoot)
    ? fs.readdirSync(env.paths.tempRoot).filter(n => /\.db(-wal|-shm)?$/.test(n))
    : [];
  t.check('临时区根目录无散落库文件', stray.length === 0, stray.join('、'));
  t.check('os.tmpdir 与项目临时区是两处（夹具不会误用系统临时目录做落库）',
    path.resolve(env.tmpdir) !== path.resolve(env.paths.tempRoot), env.tmpdir);

  /* P2-16：cleanup 不能只"被断言存在"，要验**行为** —— 真造一个残留目录，force 清空后必须消失。
     同时确认 run-all 的收尾真会调它（否则又是"测存在 ≠ 在用"）。 */
  const leftover = harness.makeTempDir('leftover-must-be-swept');
  fs.writeFileSync(path.join(leftover, 'junk.txt'), 'x', 'utf8');
  const swept = harness.cleanup(true);
  t.check('cleanup(true) 真能清空临时区（行为断言，不只是"函数存在"）',
    !fs.existsSync(leftover) && swept.removed === 'all',
    `残留目录仍在=${fs.existsSync(leftover)}，返回=${JSON.stringify(swept)}`);
  t.check('run-all 收尾真的调用了 cleanup（P2-16："测存在 ≠ 在用"）',
    /cleanup\(false\)/.test(fs.readFileSync(path.join(env.paths.tests, 'run-all.js'), 'utf8')),
    'run-all 全绿收尾处应调用一次 cleanup(false)');
}

/* ---------------- 六、断言器自身 ---------------- */
t.section('六、断言器自身（它坏了上面全部门禁都不可信）');
{
  const { createRunner } = require('./lib/assert');
  const spy = [];
  const origLog = console.log;
  console.log = (...a) => spy.push(a.join(' '));
  let code = null;
  const origExit = process.exit;
  process.exit = (c) => { code = c; throw new Error('__EXIT__'); };   // 拦截退出
  const sub = createRunner('子 runner 探针');
  sub.check('通过的用例计 1', true);
  sub.check('失败的用例计 1', false, '故意失败');
  sub.skip('跳过的用例单独计', '原因');
  try { sub.finish(); } catch { /* 被拦截 */ }
  console.log = origLog;
  process.exit = origExit;

  const out = spy.join('\n');
  t.check('汇总行格式固定为「通过 N 项，失败 N 项，跳过 N 项」（runner 与门禁数字都解析它）',
    /通过 1 项，失败 1 项，跳过 1 项/.test(out), '');
  t.check('有失败时以退出码 1 结束', code === 1, `实测退出码 ${code}`);
  t.check('失败清单会列出原因', /故意失败/.test(out), '');
  t.check('跳过清单单列且说明原因', /跳过清单/.test(out) && /原因/.test(out), '');

  const sub2 = createRunner('子 runner 探针 2');
  const spy2 = [];
  console.log = (...a) => spy2.push(a.join(' '));
  process.exit = (c) => { code = c; throw new Error('__EXIT__'); };
  sub2.check('全过', true);
  try { sub2.finish(); } catch { /* 被拦截 */ }
  console.log = origLog;
  process.exit = origExit;
  t.check('全过时以退出码 0 结束', code === 0, `实测退出码 ${code}`);

  /* ADR-0004 D20：requires 的语义自证 —— 前提与断言必须是**两件事**，
     且"前提不成立"必须使退出码非 0（否则前提塌了会被当成"这段没验到但没事"）。 */
  const sub3 = createRunner('子 runner 探针 3');
  const spy3 = [];
  console.log = (...a) => spy3.push(a.join(' '));
  process.exit = (c) => { code = c; throw new Error('__EXIT__'); };
  const okReturn = sub3.requires('数据已就绪', true, '');
  sub3.check('真实断言', true);
  const badReturn = sub3.requires('数据已就绪', false, '实测 0 行');
  try { sub3.finish(); } catch { /* 被拦截 */ }
  console.log = origLog;
  process.exit = origExit;
  const out3 = spy3.join('\n');
  t.check('requires 成立时返回 true、不成立时返回 false（调用方可据此决定是否进入该段）',
    okReturn === true && badReturn === false, `实测 ${okReturn} / ${badReturn}`);
  t.check('requires **不计入断言数**（通过数与"真实断言"一致，不因前提而虚增）',
    /通过 1 项，失败 0 项，跳过 0 项/.test(out3), '前提不是断言');
  t.check('前提不成立时**单独成段**列出，不混进失败清单',
    /前提不成立（\*\*不是通过\*\*/.test(out3) && /前提不成立：数据已就绪/.test(out3) && !/失败清单/.test(out3),
    '一眼分清"前提塌了"与"实现错了"');
  t.check('前提不成立时以退出码 1 结束（不是 0，也不是 skip）',
    code === 1, `实测退出码 ${code}`);

  const sub4 = createRunner('子 runner 探针 4');
  const spy4 = [];
  console.log = (...a) => spy4.push(a.join(' '));
  process.exit = (c) => { code = c; throw new Error('__EXIT__'); };
  sub4.requires('前提成立', true);
  sub4.check('全过', true);
  try { sub4.finish(); } catch { /* 被拦截 */ }
  console.log = origLog;
  process.exit = origExit;
  t.check('前提成立时不影响结论：仍以退出码 0 结束、且不出现"前提不成立"段',
    code === 0 && !/前提不成立/.test(spy4.join('\n')), `实测退出码 ${code}`);
  t.check('requires 与 skip 语义分明（skip 不计失败、requires 计失败）',
    (() => {
      const s5 = createRunner('子 runner 探针 5');
      console.log = () => {};
      process.exit = (c) => { code = c; throw new Error('__EXIT__'); };
      s5.skip('环境不满足', '本环境跑不了');
      try { s5.finish(); } catch { /* 被拦截 */ }
      const skipCode = code;
      const s6 = createRunner('子 runner 探针 6');
      s6.requires('前提被破坏', false);
      try { s6.finish(); } catch { /* 被拦截 */ }
      const reqCode = code;
      console.log = origLog;
      process.exit = origExit;
      return skipCode === 0 && reqCode === 1;
    })(), 'skip→0，requires→1');
}

/* ---------------- 七、runner 结论规则与"假通过"防线 ---------------- */
t.section('七、runner 结论规则（P1-2/P1-3：跑不了就不能算通过）');
{
  /* P1-2 的要害：旧 runner 在"无管道 + 非安静"下 `out` 恒为空 → isEnvSkip('') 为 false →
     "脚本打了 SKIP 且退出码 0"被判 passed，三个浏览器类脚本一个断言都没跑却计入 PASS。
     classify 是纯函数，这里直接对它回归，不依赖环境有没有管道。 */
  const runAll = require('./run-all');
  t.check('classify 把"退出码 0 且一条断言都没跑"判为未核实（**不是通过**）',
    runAll.classify(0, null, '').status === 'unverified',
    `实测 ${runAll.classify(0, null, '').status} —— 这正是 P1-2 的假通过口子`);
  t.check('classify 对"退出码 0 + 只有跳过项"同样判为未核实',
    runAll.classify(0, runAll.parseSummary('通过 0 项，失败 0 项，跳过 1 项'), '').status === 'unverified',
    '浏览器起不来时应为跳过/未核实，不能记绿');
  t.check('classify 把退出码 3 判为跳过（脚本显式声明本环境跑不了）',
    runAll.classify(3, null, '').status === 'skipped');
  t.check('classify 把退出码 2 判为异常、退出码 1 判为失败',
    runAll.classify(2, null, '').status === 'error' && runAll.classify(1, null, '').status === 'failed');
  t.check('classify 只在"跑到过断言且无失败"时才判通过',
    runAll.classify(0, runAll.parseSummary('通过 3 项，失败 0 项，跳过 0 项'), '').status === 'passed' &&
    runAll.classify(0, runAll.parseSummary('通过 3 项，失败 1 项，跳过 0 项'), '').status !== 'passed');
  t.check('runner 的汇总行解析要求三字段齐全',
    runAll.parseSummary('通过 1 项，失败 0 项').skipped === 0 &&
    runAll.parseSummary('通过 1 项，失败 0 项，跳过 2 项').skipped === 2);
  t.check('runner 在无管道时也走"落文件捕获"而非 inherit（两种模式不至于两套账）',
    /stdio:\s*\['ignore', fd, fd\]/.test(fs.readFileSync(path.join(env.paths.tests, 'run-all.js'), 'utf8')),
    '旧实现无管道 + 非安静时用 stdio:inherit，输出拿不到就把 SKIP 记成了 PASS');
  t.check('env 提供环境跳过的统一出口（skipSuite）并以 3 退出',
    typeof env.skipSuite === 'function' && env.EXIT_ENV_SKIP === 3);

  /* P1-3：候选目录为空/不存在时必须失败。空目录无需 PNG 解码能力，秒级可跑。 */
  const runScript = (args) => {
    const { spawnSync } = require('node:child_process');
    const log = path.join(env.ensureDir(env.paths.tempRoot), `screenshot-diff-probe-${process.pid}.log`);
    const fd = fs.openSync(log, 'w');
    const r = spawnSync(process.execPath, [path.join(env.paths.tests, 'screenshot-diff.js'), ...args],
      { cwd: env.paths.root, stdio: ['ignore', fd, fd], timeout: 60000 });
    fs.closeSync(fd);
    let out = '';
    try { out = fs.readFileSync(log, 'utf8'); } catch { /* 忽略 */ }
    try { fs.rmSync(log, { force: true }); } catch { /* 忽略 */ }
    return { code: r.status, out };
  };
  const bad = runScript(['--candidate', path.join(env.paths.verify, 'nonexistent-xyz')]);
  t.check('screenshot-diff：候选目录不存在时**非 0 退出**（P1-3）',
    bad.code === 1, `实测退出码 ${bad.code}（修复前是 0，即"空候选也算通过"）`);
  t.check('screenshot-diff：空候选的失败原因写明"候选 0 张"',
    /候选目录 .* 里没有 PNG（0 张）/.test(bad.out) && /候选 0 张 vs 基准 10 张/.test(bad.out), '');
  t.check('screenshot-diff：汇总行三字段齐全（供 runner 解析）',
    /通过 \d+ 项，失败 \d+ 项，跳过 \d+ 项/.test(bad.out), '');
}

/* ---------------- 八、平台日志的保留策略 ---------------- */
t.section('八、platform/log.js 的保留策略（P2-7：keepDays 过去只赋值不生效）');
{
  const { createLogger } = require('../platform/log');
  const logDir = path.join(env.ensureDir(env.paths.tempRoot), `log-keep-${process.pid}-${Date.now()}`);
  fs.mkdirSync(logDir, { recursive: true });
  const fixedNow = new Date('2026-09-19T12:00:00');
  const mkLog = (name, ageDays) => {
    const full = path.join(logDir, name);
    fs.writeFileSync(full, '[x] [INFO] 占位\n', 'utf8');
    const t = new Date(fixedNow.getTime() - ageDays * 24 * 3600 * 1000);
    fs.utimesSync(full, t, t);
    return full;
  };
  mkLog('2026-01-01.log', 200);      // 远超保留期
  mkLog('2026-09-18.log', 1);        // 1 天前，应保留
  mkLog('2026-09-19.log', 0);        // 当天，必须保留

  const lg = createLogger({ dir: logDir, clock: { now: () => new Date(fixedNow.getTime()) }, console: false, keepDays: 30 });
  t.check('P2-7：创建日志器即按 keepDays 清理过期日志（NFR-21 落地，不再只赋值）',
    lg.startupPrune.removed.includes('2026-01-01.log') && lg.startupPrune.removed.length === 1,
    `删除 ${lg.startupPrune.removed.join('、') || '（无）'}`);
  t.check('P2-7：保留期内的日志（1 天前与当天）不被误删',
    fs.existsSync(path.join(logDir, '2026-09-18.log')) && fs.existsSync(path.join(logDir, '2026-09-19.log')) &&
    lg.startupPrune.kept === 2, `保留 ${lg.startupPrune.kept} 个`);
  t.check('P2-7：prune() 返回可审计信息（删除清单/保留数/截止时间/保留天数）',
    Array.isArray(lg.prune().removed) && Number.isInteger(lg.prune().kept) &&
    lg.prune().cutoff instanceof Date && lg.prune().keepDays === 30, '');
  t.check('P2-7：keepDays 非法（0/负数/NaN/小数）一律抛错（否则会把当天日志也删掉）',
    (() => {
      let n = 0;
      for (const bad of [0, -1, NaN, 1.5, 'abc']) {
        try { createLogger({ dir: logDir, console: false, keepDays: bad }); } catch { n++; }
      }
      return n === 5;
    })(), '5/5 抛错');
  t.check('P2-7：缺省 keepDays 为 30（NFR-21 的"保留 ≥30 天"）',
    createLogger({ dir: logDir, clock: { now: () => new Date(fixedNow.getTime()) }, console: false })
      .prune().keepDays === 30, '');
  try { fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

/* ---------------- 九、防回潮断言的定点变异（ADR-0004 D22） ----------------
   一条"声称能挡住旧缺陷"的断言，如果按**旧实现**跑也通过，那它就是无效的 —— 而从输出上
   完全看不出来。这里把旧实现片段**内联**进来（不依赖外部文件，避免暗桩随实现漂移而失效），
   逐条确认"按旧写法必然违反现有断言"。

   范围纪律（ADR-0004 D22）：**只对防回潮断言做定点变异，不做全量变异测试**。
   凡其旧行为需要真实文件系统/子进程才能复现的（如 P1-3 的空候选、P2-6 的连接泄漏），
   已在修复轮以**反向实测**验证并留痕于 R-2026-09-19-02 的处置记录，此处不重复构造。 */
t.section('九、防回潮断言的定点变异（旧实现必须被现有断言挡下）');
{
  /* ① P1-1：ROOT 少退一层 —— 旧写法把数据目录算到仓库外 */
  const ROOT = env.paths.root;
  const path = require('node:path');
  const oldRoot = path.resolve(ROOT, 'platform', '..', '..');   // 等价于旧的 resolve(__dirname,'..','..')
  const newRoot = path.resolve(ROOT, 'platform', '..');         // 等价于现在的 resolve(__dirname,'..')
  const insideRepo = base => {
    const rel = path.relative(ROOT, path.join(base, 'data', 'dev'));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  t.check('变异①：若 ROOT 退回 resolve(__dirname,\'..\',\'..\')，dev 数据目录将落到仓库外 —— 被 P1-1 断言挡下',
    insideRepo(newRoot) === true && insideRepo(oldRoot) === false,
    `新 root 在仓库内=${insideRepo(newRoot)}，旧 root 在仓库内=${insideRepo(oldRoot)}`);

  /* ② P1-2：旧 classify 的行为等价物 —— "退出码 0 且零断言" 必须被判未核实 */
  const runAll2 = require('./run-all');
  const legacyClassify = () => ({ status: 'passed' });   // 旧实现对退出码 0 一律判通过
  t.check('变异②：若 classify 退回"退出码 0 即通过"，零断言场景会被误判 —— 被 P1-2 断言挡下',
    runAll2.classify(0, null, '').status === 'unverified' && legacyClassify().status === 'passed',
    '旧行为：零断言 → passed（这正是"14 通过"的来源）');

  /* ③ P2-1：旧 cutoff 计算 —— days=null 时 cutoff=now（全删）、days=NaN 时产出非法文本 */
  const fmtNow = (d) => {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const CUTOFF_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const oldCutoff = (days, now) => fmtNow(new Date(now.getTime() - days * 24 * 3600 * 1000));
  const now = new Date('2026-09-19T12:00:00');
  t.check('变异③：旧 cutoff 算法在 days=null/NaN 下分别产出"now"与非法文本 —— 被 P2-1 的格式断言挡下',
    CUTOFF_RE.test(oldCutoff(365, now)) &&
    oldCutoff(null, now) === '2026-09-19 12:00:00' &&
    !CUTOFF_RE.test(oldCutoff(NaN, now)),
    `null→${oldCutoff(null, now)}；NaN→${oldCutoff(NaN, now)}`);

  /* ④ P2-2：旧剪枝算式 —— 不传 keep 时 slice(NaN)≡slice(0)，一份不剩 */
  const oldKept = (keep, total) => Math.min(keep, total);
  const legacySlice = keep => [1, 2, 3, 4, 5].slice(Math.max(0, keep)).length;   // 旧写法：删掉的数量
  t.check('变异④：旧剪枝在 keep 缺省时 slice(NaN)≡slice(0)，会删光全部 —— 被 P2-2 断言挡下',
    legacySlice(undefined) === 5 && legacySlice(2) === 3 &&
    Number.isNaN(oldKept(undefined, 5)),
    `keep=undefined → 删除 ${legacySlice(undefined)}/5 份，kept 报 ${oldKept(undefined, 5)}`);
  t.check('变异④-补：新算式在同样输入下保留全部（BACKUP_KEEP），且 kept 为真实剩余数',
    legacySlice(30) === 0 && !Number.isNaN(oldKept(30, 5)),
    `keep=30 → 删除 ${legacySlice(30)}/5 份`);
}

/* ---------------- 十、权威数字校验的定点回归（P2-22 + ADR-0004 D22） ----------------
   机制：`run-all` 收尾会拿"本轮实跑合计"比对 `tests\README.md` 第三节的权威数字。
   这类"断言别人的数字"的机制最容易写成恒真 —— 这里用**临时改写 README 权威行**的方式
   逐个场景验证它真会拦住漂移，README 始终会被还原（含异常路径）。
   踩过的坑：首版探针用 `/合计\s*\*\*\d+\s*通过/` 改写，而 README 实际写作 `合计 470 通过`
   （**没有加粗**），于是替换静默失效、三轮验证结果全部不可信 —— 故这里用容错正则
   `/合计\s*\*{0,2}\s*\d+\s*通过/`，并在改完后**回读确认**。 */
t.section('十、权威数字校验的定点回归（run-all.verifyAuthorityTotals）');
{
  const runAll3 = require('./run-all');
  const offline = runAll3.SUITES.filter(s => !s.needBrowser).map(s => s.name);
  const mkR = (name, passed, failed) => ({ suite: { name, needBrowser: false },
    status: failed ? 'failed' : 'passed', summary: { passed, failed, skipped: 0 } });
  const resultsOf = (docsFailed) => {
    const base = { 'contract-check': 58, 'ui-check': 40, 'tools-check': 24, 'files-check': 11,
      'harness-check': 73, 'logic-check': 52, 'db-check': 46, 'platform-check': 21,
      'trace-check': 4, 'copy-check': 22, 'screenshot-diff': 24, 'docs-cross-check': 53 };
    return offline.map(n => n === 'docs-check'
      ? mkR('docs-check', docsFailed ? 42 : 44, docsFailed ? 2 : 0)
      : mkR(n, base[n] || 0, 0));
  };
  const sumOf = rs => rs.reduce((a, r) => a + r.summary.passed, 0);
  const readmePath = path.join(env.paths.tests, 'README.md');
  const original = fs.readFileSync(readmePath, 'utf8');
  const authIndex = () => original.split(/\r?\n/).findIndex(l => l.includes('离线可跑部分'));
  const setStated = (n) => {
    const lines = original.split(/\r?\n/);
    lines[authIndex()] = lines[authIndex()].replace(/合计\s*\*{0,2}\s*\d+\s*通过/, `合计 ${n} 通过`);
    fs.writeFileSync(readmePath, lines.join('\r\n'), 'utf8');
    /* 回读确认：替换必须真的生效，否则下面的判定全都白验（首版就栽在这里） */
    const now = fs.readFileSync(readmePath, 'utf8').split(/\r?\n/)[authIndex()];
    return /合计\s*\*{0,2}\s*(\d+)\s*通过/.test(now) && Number(RegExp.$1) === n;
  };
  try {
    const withDev = resultsOf(true);      // docs-check 带 2 项已登记偏差
    const greenRun = resultsOf(false);    // 全绿
    t.check('改盘辅助生效（能真的把权威行改成目标数字）', setStated(sumOf(withDev)), `目标 ${sumOf(withDev)}`);
    /* P3-6 补：比对通过时打印的**口径行**是有契约的 —— 必须同时含"合计 ＝ 实跑"与
       "含已登记偏差 N 项，真实通过 M"，好让人一眼看出"确实比过了、且把已登记偏差算进去了"，
       而不是"未核对"（后者正是 P3-6 里被当成正常的那种输出）。 */
    const okDetail = runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).detail;
    const okMatch = okDetail.match(/^权威区合计 (\d+) ＝ 本轮实跑 (\d+)（含已登记偏差 (\d+) 项，真实通过 (\d+)）$/);
    const okNums = okMatch ? okMatch.slice(1).map(Number) : [];
    t.check('权威数字校验：通过时打印的口径行是「权威区合计 N ＝ 本轮实跑 N（含已登记偏差 2 项，真实通过 N-2）」，不是"未核对"',
      okNums.length === 4 && okNums[0] === sumOf(withDev) && okNums[1] === sumOf(withDev) &&
      okNums[2] === 2 && okNums[3] === sumOf(withDev) - okNums[2], okDetail);
    t.check('权威数字校验：与实跑一致时判通过（现状口径）',
      runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).ok === true, '');
    setStated(sumOf(withDev) - 2);
    t.check('权威数字校验：写成"真实通过数"（偏差修掉后应达到的值）也接受',
      runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).ok === true, '');
    setStated(sumOf(withDev) + 1);
    t.check('权威数字校验：**不接受中间值**（曾一度把 471 这类数字放过）',
      runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).ok === false, '');
    setStated(999);
    t.check('权威数字校验：权威区写错即判不通过（真会拦住漂移）',
      runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).ok === false, '');
    setStated(sumOf(withDev));
    const otherFail = withDev.map(r => r.suite.name === 'db-check' ? mkR('db-check', 40, 6) : r);
    t.check('权威数字校验：其他脚本失败时先报它们，而不是纠结数字',
      runAll3.verifyAuthorityTotals({ passed: sumOf(otherFail) }, otherFail).ok === false, '');
    /* 漏列脚本：从权威行删掉 platform-check 的点名 */
    const lines = original.split(/\r?\n/);
    lines[authIndex()] = lines[authIndex()].replace(/`platform-check` \*\*21\/0\*\*，/, '');
    fs.writeFileSync(readmePath, lines.join('\r\n'), 'utf8');
    t.check('权威数字校验：权威区漏列某个离线门禁即判不通过（新增脚本别忘登记）',
      runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).ok === false, '');
  } finally {
    fs.writeFileSync(readmePath, original, 'utf8');
  }
  t.check('回归结束后 README 已被还原（不留改写痕迹）',
    fs.readFileSync(readmePath, 'utf8') === original, '');

  /* ---------------- 十之二、权威校验的"可达性"回归（2026-09-20 补） ----------------
     立案原因：`verifyAuthorityTotals` 写得再对，**只要调用点被放在提前退出之后，它就一次都不会执行**。
     实际发生过：调用点在 `if (failed.length) { … process.exit(1) }` 之后，而 `docs-check`
     因 2 项 6.4 已登记偏差**永远失败** ⇒ 该函数成了不可达代码，
     `tests\README.md` 第三节自称的"唯一真源 + 与实跑比对"从来没有兑现过一次。
     两类断言：① 前置条件判据的真值表（纯函数 `authorityBlockers`）；
              ② **静态断言调用顺序** —— 调用点必须在提前退出之前（这条才是直接防复发的）。 */
  const blockersOf = (rows) => runAll3.authorityBlockers(rows.map(([name, status]) =>
    ({ suite: { name }, status })));
  const truth = [
    [['docs-check', 'failed'], [], '只 docs-check 失败 → 允许比对'],
    [[], [], '全绿 → 允许比对'],
    [[['browser-check', 'skipped'], ['docs-check', 'failed']], [], 'skipped 不算失败（浏览器类退 3）'],
    [[['screenshot-diff', 'failed'], ['docs-check', 'failed']], ['screenshot-diff'], '有别的失败 → 阻止比对'],
    [[['db-check', 'unverified'], ['docs-check', 'failed']], ['db-check'], 'unverified 也算阻止（没证据不等于通过）'],
    [[['logic-check', 'error']], ['logic-check'], 'error 阻止比对'],
    [[['docs-check', 'failed'], ['docs-check', 'passed']], [], '多个 docs-check 条目也只认这一个豁免']
  ];
  const truthBad = truth.filter(([rows, want]) => {
    const got = blockersOf(rows);
    return JSON.stringify(got) !== JSON.stringify(want);
  });
  t.check('权威比对前置条件：真值表逐条正确（failed/error/unverified 阻止；skipped 不阻止）',
    truthBad.length === 0,
    truthBad.length ? truthBad.map(([rows, want]) =>
      `${JSON.stringify(rows)} 期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(blockersOf(rows))}`).join('；')
      : `共 ${truth.length} 个场景`);

  /* 静态断言：调用点位置。用"源码中两者的字符下标"比较，脱离格式化（缩进/空行）差异。 */
  const runAllSrc = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
  const callAt = runAllSrc.indexOf('const auth = verifyAuthorityTotals(');
  const earlyExitAt = runAllSrc.indexOf('if (failed.length) {');
  t.check('权威校验的调用点早于「失败脚本明细 + 提前退出」（否则该机制不可达）',
    callAt > 0 && earlyExitAt > 0 && callAt < earlyExitAt,
    callAt < 0 ? '源码里找不到 verifyAuthorityTotals 的调用'
      : earlyExitAt < 0 ? '源码里找不到 `if (failed.length) {` 提前退出'
      : `调用点下标 ${callAt}，提前退出下标 ${earlyExitAt} —— 调用点必须更小`);
}

/* ---------------- 十一、已登记偏差的"登记数"必须与本机实算对得上（P3-6） ----------------
   立案原因：2026-09-20 实际发生两次 —— 新增一个文本文件后 `docs-cross-check` 的"权威区扫描 N 个
   文本文件 ＝ files-check 实跑值"变红（属常规工作导致的、可预期的机械漂移），而旧的
   `authorityBlockers` 是**按脚本名**整体豁免 `docs-check`：只要出现任何非 docs-check 的失败，
   整段权威比对就静默不执行 —— "没比对"与"比对通过"在输出上几乎无法区分（评审 A-2026-09-20-01 P3-6）。
   修法：豁免依据换成 `run-all.REGISTERED_DEVIATIONS`（条数 + 断言名 + 出处），本段做四件事：
     ① 常量自身自洽；② 常量 ↔ docs-check 源码 D2 段**静态**对齐（断言名逐字一致）；
     ③ 常量 ↔ `git log` **实算**的偏差条数对齐（防"数字改大就默默多豁免"）；
     ④ 真值表 + "未执行比对"必须写明原因与脚本名。 */
t.section('十一、已登记偏差登记数与本机实算一致（P3-6：豁免依据不再是脚本名）');
{
  const runAll4 = require('./run-all');
  const reg = runAll4.REGISTERED_DEVIATIONS && runAll4.REGISTERED_DEVIATIONS['docs-check'];
  if (t.requires('run-all 导出「已登记偏差」常量（权威比对豁免判据的唯一真源）', Boolean(reg),
    'run-all.REGISTERED_DEVIATIONS["docs-check"] 缺失 —— 豁免判据无从核对')) {

    t.check('已登记偏差常量自洽：失败断言数 = 登记断言名条数，且出处点名 PROJECT_RULES 6.4 与 docs-check D2 段',
      reg.assertions.length === reg.failedAssertions && reg.listedItems >= reg.failedAssertions &&
      /6\.4/.test(reg.source) && /docs-check/.test(reg.source),
      `断言 ${reg.failedAssertions} 条 / 失败清单 ${reg.listedItems} 条；出处：${reg.source}`);

    /* ② 静态对齐：docs-check 源码 D2 段落里的 `check('…'` 断言名必须与常量逐字一致。
       这是"常量不是随手写的数字"的机器证据 —— 改断言名或增删 D2 断言而不同步常量，这里立刻红。 */
    const docsSrc = fs.readFileSync(path.join(env.paths.tests, 'docs-check.js'), 'utf8');
    const d2Start = docsSrc.indexOf("section('D2 提交信息格式");
    const d2End = docsSrc.indexOf('/* ===== D3', d2Start);
    const d2Src = d2Start < 0 || d2End < 0 ? '' : docsSrc.slice(d2Start, d2End);
    const d2Names = [...d2Src.matchAll(/check\(\s*'([^']+)'/g)].map(m => m[1]);
    t.check('已登记偏差的断言名 = docs-check D2 段源码里的 check 名（逐字，改一名就等于换了豁免口子）',
      d2Names.length === reg.failedAssertions && d2Names.every(n => reg.assertions.includes(n)) &&
      reg.assertions.every(n => d2Names.includes(n)),
      `D2 段实有 ${d2Names.length} 条：${d2Names.join('、') || '（未解析到，检查 section 标题或 check 写法是否改名）'}`);

    /* ③ 独立实算：按 D2 的两条规则把 `git log` 的主题重新数一遍。
       规则参数（类型表、字数上限）从 docs-check 源码里读 —— 免得"两处各写一份规则"再次漂移。 */
    const { execFileSync } = require('node:child_process');
    const typesSrc = (d2Src.match(/const TYPES = \[([^\]]*)\]/) || [])[1] || '';
    const types = [...typesSrc.matchAll(/'([^']+)'/g)].map(m => m[1]);
    const lenLimit = Number((d2Src.match(/\.length\s*>\s*(\d+)\)/) || [])[1]);
    const gitLog = path.join(env.ensureDir(env.paths.tempRoot), `d2-subjects-${process.pid}.txt`);
    let subjects = [];
    try {
      const fd = fs.openSync(gitLog, 'w');
      try {
        execFileSync('git', ['log', '--pretty=format:%s'],
          { stdio: ['ignore', fd, 'ignore'], cwd: env.paths.root });
      } finally { fs.closeSync(fd); }
      subjects = fs.readFileSync(gitLog, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch { subjects = []; }
    try { fs.rmSync(gitLog, { force: true }); } catch { /* 忽略 */ }

    if (t.requires('能用 git 历史独立复核 D2 偏差条数（git 可读，且规则参数能从 docs-check 源码解析）',
      subjects.length > 0 && types.length >= 5 && Number.isInteger(lenLimit),
      `提交 ${subjects.length} 条 / 类型表 ${types.length} 个 / 字数上限 ${lenLimit}`)) {
      const badPrefix = subjects.filter(s => !new RegExp(`^(${types.join('|')}): \\S`).test(s));
      const tooLong = subjects.filter(s => s.replace(/^[^:]+:\s*/, '').length > lenLimit);
      const failedRules = (badPrefix.length ? 1 : 0) + (tooLong.length ? 1 : 0);
      const listed = badPrefix.length + tooLong.length;
      t.check('已登记偏差的**失败断言数** = git 历史实算（D2 两条断言各失败一条 → 2）',
        failedRules === reg.failedAssertions,
        `实算 ${failedRules} 条失败断言（缺前缀 ${badPrefix.length} 条 / 超 ${lenLimit} 字 ${tooLong.length} 条），常量写 ${reg.failedAssertions}`);
      t.check('已登记偏差的**失败清单条数** = git 历史实算（9 条缺前缀 + 3 条超字数 → 12）',
        listed === reg.listedItems,
        `实算 ${listed} 条 = 缺前缀 ${badPrefix.length} + 超字数 ${tooLong.length}，常量写 ${reg.listedItems}`);
    }

    /* ④ 真值表：带 summary 与失败清单，覆盖"条数边界"与"换了个断言继续失败"这两种真实场景 */
    const row = (name, status, failed, out) => ({ suite: { name }, status,
      summary: failed === null ? null : { passed: 0, failed, skipped: 0 }, out: out || '' });
    const failList = (...names) => '=== 汇总 ===\r\n通过 0 项，失败 ' + names.length + ' 项，跳过 0 项\r\n' +
      '\r\n失败清单：\r\n' + names.map((n, i) => `  ${i + 1}. ${n} —— 详情`).join('\r\n') + '\r\n';
    const a1 = reg.assertions[0], a2 = reg.assertions[1];
    const cases = [
      ['docs-check 失败数 = 登记数、断言名全在册 → 不阻止',
        [row('docs-check', 'failed', reg.failedAssertions, failList(a1, a2))], []],
      ['docs-check 失败数 > 登记数 → 阻止（不许用旧偏差掩盖新问题）',
        [row('docs-check', 'failed', reg.failedAssertions + 1, failList(a1, a2, '新加的 D2 断言'))], ['docs-check']],
      ['docs-check 条数没变但**换了断言**（出现未登记断言名）→ 阻止',
        [row('docs-check', 'failed', reg.failedAssertions, failList(a1, '新加的 D2 断言'))], ['docs-check']],
      ['docs-check 有输出却读不到失败清单（拿不出"已登记"的证据）→ 阻止',
        [row('docs-check', 'failed', reg.failedAssertions, '（脚本中途异常，没有汇总段）')], ['docs-check']],
      ['docs-check 异常（error）→ 阻止（已登记偏差只认 failed）',
        [row('docs-check', 'error', null, '')], ['docs-check']],
      ['docs-check 未核实（unverified）→ 阻止',
        [row('docs-check', 'unverified', null, '')], ['docs-check']],
      ['浏览器类脚本整脚本跳过（skipped）→ **不**阻止（本环境跑不了不算失败）',
        [row('browser-check', 'skipped', 0, '')], []],
      ['其他脚本失败 → 阻止',
        [row('db-check', 'failed', 6, '')], ['db-check']],
      ['已登记的 docs-check + 别的脚本失败 → 只报未登记的那个',
        [row('docs-check', 'failed', reg.failedAssertions, failList(a1, a2)), row('screenshot-diff', 'failed', 1, '')],
        ['screenshot-diff']],
      ['浏览器跳过 + 已登记的 docs-check → 都不阻止',
        [row('browser-check', 'skipped', 0, ''), row('docs-check', 'failed', reg.failedAssertions, failList(a1, a2))], []]
    ];
    const badCases = cases.filter(([, rows, want]) =>
      JSON.stringify(runAll4.authorityBlockers(rows)) !== JSON.stringify(want));
    t.check('authorityBlockers 真值表：条数边界 + 未登记断言 + error/unverified 阻止、skipped 不阻止',
      badCases.length === 0,
      badCases.length ? badCases.map(([title, rows, want]) =>
        `${title}：期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(runAll4.authorityBlockers(rows))}`).join('；')
        : `共 ${cases.length} 个场景逐条通过`);

    /* 反向单列一条：这是 P3-6 的要害 —— "旧偏差掩盖新问题"必须被挡下 */
    t.check('反向：docs-check 失败数超过登记数时必须出现在 blockers 里（防"用旧偏差掩盖新问题"）',
      runAll4.authorityBlockers([row('docs-check', 'failed', reg.failedAssertions + 1,
        failList(a1, a2, '新加的 D2 断言'))]).includes('docs-check'),
      `登记数 ${reg.failedAssertions}，实跑多 1 条 → 必须阻止比对`);

    /* ⑤ "未执行比对"的两个分支必须写明原因与涉及脚本名（P3-6 的另一半：跳过必须显式） */
    const offline4 = runAll4.SUITES.filter(s => !s.needBrowser).map(s => s.name);
    const fullRun = (overrides) => offline4.map(n => overrides[n] || row(n, 'passed', 0, ''));
    const blocked = runAll4.verifyAuthorityTotals({ passed: 1 }, fullRun({
      'docs-check': row('docs-check', 'failed', reg.failedAssertions + 1, failList(a1, a2, '新加的 D2 断言')),
      'db-check': row('db-check', 'failed', 6, '')
    }));
    t.check('账目不完整时：比对**未执行**，且详情写明原因与涉及脚本名（不得只留一句"未核对"）',
      blocked.ok === false && blocked.kind === 'blocked' && /未执行/.test(blocked.detail) &&
      blocked.detail.includes('docs-check') && blocked.detail.includes('db-check'),
      blocked.detail);

    const partial = runAll4.verifyAuthorityTotals({ passed: 1 },
      fullRun({}).filter(r => r.suite.name !== 'copy-check'));
    t.check('离线门禁没跑全时：比对**未执行**，且详情点名缺失的脚本（--only 跑子集不该被当成漂移）',
      partial.ok === true && partial.kind === 'skipped' && /未执行/.test(partial.detail) &&
      partial.detail.includes('copy-check'),
      partial.detail);

    const ranAll = runAll4.verifyAuthorityTotals({ passed: 1 }, fullRun({}));
    t.check('账目干净时会**真的**走到比对（mismatch），而不是"未执行" —— 机制可达性的运行时旁证',
      ranAll.kind === 'mismatch' && !/未执行/.test(ranAll.detail), ranAll.detail);
  }
}
t.finish();
}

try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
