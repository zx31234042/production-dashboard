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
const { spawnSync, spawn } = require('node:child_process');

const env = require('./env');
const { createRunner } = require('./lib/assert');
const { createClock, parseTime, BOUNDARIES } = require('./lib/clock');
const fixture = require('./lib/fixture');
const harness = require('./lib/harness');
const snapshot = require('./lib/snapshot');

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

  /* ====================== W6：进程入口与运行骨架（server\index.js / server\http\router.js） ======================
     本节原来只验"夹具自身能起停一个临时 mini-server"，验不到**真交付的进程入口**。
     W6 落地后在这里扩断言：能起、能查、监听范围、能优雅退、SSE 骨架、异常不静默 —— 全部是**行为判据**
     （真的起进程、真的打 HTTP 请求、真的读日志），不匹配源码字符串（D23）。
     夹具脚本在本节内**写成文件**再以子进程运行（与本节上面的 mini-server 同一手法）：
       · 为什么必须另起进程：优雅退出要验"进程退出码 + 端口释放 + 无残留进程"，进程内证明不了；
       · 为什么结果走文件而不是 stdout：受限环境下子进程管道会 EPERM（见本节上方与 tests/env.js）；
       · 为什么夹具写在 tests\._verify 之下：该目录已被 .gitignore 忽略（D16：测试产物只允许落这里）。 */
  const w6Root = path.join(env.paths.root, 'server');
  t.check('W6：进程入口文件存在（server\\index.js + server\\http\\router.js）',
    fs.existsSync(path.join(w6Root, 'index.js')) && fs.existsSync(path.join(w6Root, 'http', 'router.js')),
    path.relative(env.paths.root, w6Root));

  if (fs.existsSync(path.join(w6Root, 'index.js'))) {
    const w6 = require('../server/index.js');        // 只为读配置解析与挂载位（不起服务）
    const { createRouter } = require('../server/http/router');

    /* ---- 1. 配置解析：默认仅回环 + 可被环境变量/命令行覆盖 ---- */
    {
      const d = w6.resolveConfig({ argv: [], env: {}, boardConfig: {} });
      t.check('W6：默认监听 127.0.0.1:8787（默认仅回环，遵 NFR-25/AC-09）',
        d.host === '127.0.0.1' && d.port === 8787 && d.sources.host === 'default' && d.sources.port === 'default',
        `${d.host}:${d.port}（来源 ${d.sources.host}/${d.sources.port}）`);

      const e = w6.resolveConfig({ argv: [], env: { DSH_BOARD_PORT: '19001', DSH_BOARD_HOST: '127.0.0.2' }, boardConfig: {} });
      t.check('W6：DSH_BOARD_PORT / DSH_BOARD_HOST 能覆盖默认值（来源被记录）',
        e.port === 19001 && e.host === '127.0.0.2' && e.sources.port === 'env:DSH_BOARD_PORT',
        `${e.host}:${e.port}（${e.sources.port}）`);

      const c = w6.resolveConfig({ argv: ['--port', '19002'], env: { DSH_BOARD_PORT: '19001' }, boardConfig: {} });
      t.check('W6：命令行 --port 覆盖环境变量（优先级＝默认＜配置＜环境变量＜命令行）',
        c.port === 19002 && c.sources.port === 'cli', `port=${c.port}（${c.sources.port}）`);

      let badPort = false;
      try { w6.resolveConfig({ argv: ['--port', 'abc'], env: {}, boardConfig: {} }); } catch { badPort = true; }
      t.check('W6：非法端口被显式拒绝（不静默回落到默认端口 —— 否则 `--prot 9000` 这类笔误会隐身）',
        badPort, '--port abc 应抛错');
    }

    /* ---- 2. 挂载位：四个 W6 空壳注册位必须在，且必须**自报未挂载** ----
       （W5-③ 口径推进见下面 2b：**总挂载位＝5**（4 个空壳 ＋ auth 真实挂载）；
        本条的四个空壳断言**原样保留** —— 它是"未装配时不许假装已挂载"的裸 router 形态断言。） */
    {
      const r = createRouter({ getHealth: () => ({ ok: true }) });
      const mounts = [r.mountIfA(), r.mountIfD(), r.mountUpload(), r.mountSSE()];
      t.check('W6：四个挂载位（IF-A/IF-D/上传/SSE 推送）齐备且显式自报"未挂载"（本包不实现业务逻辑）',
        mounts.every(m => m && m.mounted === false && typeof m.by === 'string' && m.by.length > 0) &&
        mounts.map(m => m.mount).join(',') === 'ifA,ifD,upload,sse',
        mounts.map(m => `${m.mount}→${m.by}`).join(' / '));
      t.check('W6：本包只注册 /health 与 /events（业务路由留给 W1/W2/W4/W5，不越界）',
        r.list().join(' , ') === 'GET /events , GET /health', r.list().join(' , '));
    }

    /* ---- 2b. W5-③ 挂载位**总数**：4 个 W6 空壳 ＋ auth 真实挂载 ＝ 5 ----
       口径推进说明（回执要逐字交代）：原断言只数 W6 的 4 个空壳（`router.js` 内建描述符）。
       auth **不是** `router.js` 的空壳 —— 本仓既有分工是"注册动作写进对应包的路由文件"
       （见 `router.js` 挂载位注释与 6b/6c/6d 段的写法），故 `mountAuth()` 在 `routes/auth.js` 内部注册，
       自报 `mounted:true` / `by:'W5-3'` / 5 条路由。这里**两条都留**：四个空壳仍必须自报未挂载（上面 2），
       总清单必须是 5 且 auth 必须自报已接线（本条）—— "总数变 5"是推进，不是把空壳判据删掉换松的。 */
    {
      const mountDb = harness.makeTempDb({ name: 'w5-auth-mount' });
      try {
        const dbApi = require('../server/db');
        dbApi.initSchema(mountDb.db, '2026-09-28 10:00:00');
        const { createAuth } = require('../server/services/auth');
        const { mountAuth } = require('../server/http/routes/auth');
        const r5 = createRouter({ getHealth: () => ({ ok: true }) });
        const authMount = mountAuth(r5, {
          auth: createAuth({ db: mountDb.db, silent: true, now: () => new Date('2026-09-28T10:00:00') })
        });
        const slots = [r5.mountIfA(), r5.mountIfD(), r5.mountUpload(), r5.mountSSE(), authMount];
        t.check('W5-③：挂载位清单共 **5** 个（W6 的 ifA/ifD/upload/SSE 四个空壳 ＋ auth 真实挂载 W5-3）；' +
          'auth 自报 `mounted:true` 且注册 5 条 `/auth/*` 路由，四个空壳仍自报 `mounted:false`',
          slots.length === 5 &&
          slots.slice(0, 4).every(m => m.mounted === false) &&
          authMount.mounted === true && authMount.by === 'W5-3' && authMount.routes.length === 5 &&
          slots.map(m => m.mount).join(',') === 'ifA,ifD,upload,sse,auth' &&
          r5.list().filter(p => p.includes('/auth/')).length === 5,
          slots.map(m => `${m.mount}(${m.by})${m.mounted ? '已接线' : '空壳'}`).join(' , '));
      } finally {
        mountDb.close();
      }
    }

    /* ---- 2c. W5-③（ADR-0007）**真起进程**的鉴权端到端 ----
       为什么必须另起进程：ADR-0007 的判据横跨"启动期（初始化码登记到 op_log / E18 备份日志）→
       HTTP 面（init/login/change/logout）→ 库内状态"，进程内建服务证明不了"装配真的生效"。
       手法与本节上面一致：`harness.startService`（stdio 落文件，受限环境下管道会 EPERM）、
       临时库/端口/目录全部唯一（门禁允许并发跑）。
       前置造数：先按**当前**结构建库，再把 `schema_meta.schema_version` 改回 '4' ——
       于是真进程启动时命中 E18 判据②"结构版本升级 4 → 5"，启动日志里的**迁移前备份行**
       与磁盘上的备份文件都成为可断言的**行为**证据（不是匹配源码字符串）。 */
    {
      const authTmp = harness.makeTempDir('w5-auth-e2e');
      const authDbFile = path.join(authTmp, 'board.db');
      const authPort = await harness.allocPort();
      const PW1 = 'W5E2E-Pass-1';
      const PW2 = 'W5E2E-Pass-2';
      const { DatabaseSync } = require('node:sqlite');
      const dbApi = require('../server/db');
      {
        const seed = new DatabaseSync(authDbFile);
        dbApi.initSchema(seed, '2026-09-28 10:00:00');
        seed.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'").run();
        seed.close();
      }
      let authSvc = null;
      try {
        authSvc = await harness.startService({
          script: path.join(env.paths.root, 'server', 'index.js'),
          args: ['--port', String(authPort), '--data-dir', authTmp, '--db-file', authDbFile],
          port: authPort, readyPath: '/health', timeoutMs: 20000
        });
        const base = `http://127.0.0.1:${authSvc.port}`;
        const call = async (method, p, body, headers) => {
          const init = { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
          if (method === 'POST') init.body = JSON.stringify(body === undefined ? {} : body);
          const res = await fetch(base + p, init);
          const text = await res.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* 非 JSON 正文 */ }
          return { status: res.status, body: parsed, text };
        };
        const withDb = fn => {
          const c = new DatabaseSync(authDbFile);
          try { return fn(c); } finally { c.close(); }
        };

        /* ① 启动日志：E18 迁移前备份（判据②）＋ op_log 审计 ＋ 库内版本已升到 5 */
        const health = await call('GET', '/health');
        const logText = authSvc.output();
        const backupLine = (logText.match(/\[启动\] E18 迁移前已备份：([^\r\n]+)/) || [])[1] || '';
        const backupPath = backupLine.split('（')[0].trim();
        const auditAfterStart = withDb(c => c.prepare(
          "SELECT op_type, result, content FROM op_log WHERE op_type = '迁移前备份' ORDER BY id").all());
        const versionAfterStart = withDb(c => c.prepare(
          "SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value);
        t.check('W5-③ 端到端（真进程）：启动期命中 E18 判据②（库内版本 4 ≠ 5）⇒ 启动日志写明' +
          '「迁移前已备份：<path>（原因 结构版本升级 4 → 5…）」、备份文件**真的落盘**且备份内是**迁移前**的库、' +
          '`op_log` 有审计行（result=成功、含文件名）、启动后库内版本已升到 5；' +
          '**F20 对照**：本库本来就有 `op_log`（审计一次成功）⇒ 该行必须是 `审计 op_log=ok #<id>` 且**不含** `backfill`',
          health.status === 200 && backupPath !== '' && fs.existsSync(backupPath) &&
          /结构版本升级 4 → 5/.test(backupLine) &&
          auditAfterStart.length === 1 && auditAfterStart[0].result === '成功' &&
          String(auditAfterStart[0].content).includes(path.basename(backupPath)) &&
          versionAfterStart === dbApi.SCHEMA_VERSION &&
          /审计 op_log=ok #\d+/.test(backupLine) && !backupLine.includes('backfill') &&
          (() => {
            const v = require('../server/db/maintain').verifyBackup(backupPath);
            return v.ok && v.tables > 0;
          })(),
          `备份行=${backupLine || '(未出现)'}；审计=${JSON.stringify(auditAfterStart)}；版本=${versionAfterStart}`);

        /* ② 挂载位清单（启动日志）与路由清单：5 项（含 auth(W5-3)已接线）＋ 5 条 /auth/* */
        const routeLine = (logText.match(/\[路由\] 已注册：([^\r\n]+)/) || [])[1] || '';
        const mountLine = (logText.match(/挂载位状态[^\r\n]*/) || [])[0] || '';
        t.check('W5-③ 端到端（真进程）：启动日志的**挂载位清单共 5 项**（ifA/ifD/upload/SSE/auth，' +
          'auth 自报 `auth(W5-3)已接线`），路由清单里 `/auth/*` 恰好 5 条（init/login/logout/change/status）',
          (mountLine.match(/(?:ifA|ifD|upload|sse|auth)\((?:W\d(?:-\d)?)\)(?:已接线|空壳)/g) || []).length === 5 &&
          mountLine.includes('auth(W5-3)已接线') &&
          (routeLine.match(/\/auth\//g) || []).length === 5 &&
          ['GET /auth/status', 'POST /auth/init', 'POST /auth/login', 'POST /auth/logout', 'POST /auth/change']
            .every(p => routeLine.includes(p)),
          `挂载位行=${mountLine.slice(0, 200)}；路由行含 /auth/* ${(routeLine.match(/\/auth\//g) || []).length} 条`);

        /* ③ 未初始化态：status 200/不含秘密；login ⇒ 409；初始化码**从 op_log 读**（不依赖控制台） */
        const st0 = await call('GET', '/auth/status');
        const codeRow = withDb(c => c.prepare(
          "SELECT content FROM op_log WHERE op_type = '口令初始化码' ORDER BY id DESC LIMIT 1").get());
        const initCode = (/一次性初始化码=([0-9a-f]{12})/.exec(codeRow ? codeRow.content : '') || [])[1] || '';
        const login0 = await call('POST', '/auth/login', { password: PW1 });
        t.check('W5-③ 端到端（真进程）：未初始化 ⇒ `GET /auth/status` 200 且 `initialized=false`、' +
          '**正文不含任何秘密**（无 salt/hash/token/初始化码）；`POST /auth/login` ⇒ 409 `not_initialized`；' +
          '一次性初始化码**从 op_log 读得到**（12 位 hex，不依赖控制台打印）',
          st0.status === 200 && st0.body && st0.body.ok === true && st0.body.initialized === false &&
          !/"(salt|hash|token)"/.test(st0.text) && !st0.text.includes(initCode) &&
          login0.status === 409 && login0.body && login0.body.error === 'not_initialized' &&
          /^[0-9a-f]{12}$/.test(initCode),
          `status=${st0.status}/initialized=${st0.body && st0.body.initialized}；login=${login0.status}/` +
          `${login0.body && login0.body.error}；码形状=${/^[0-9a-f]{12}$/.test(initCode) ? '12 位 hex' : '异常'}`);

        /* ④ init ⇒ 200；同码第二次 ⇒ 409（唯一入口只走一次）；库里只存派生值 */
        const init1 = await call('POST', '/auth/init', { code: initCode, password: PW1 });
        const init2 = await call('POST', '/auth/init', { code: initCode, password: PW2 });
        const cred = withDb(c => c.prepare('SELECT username, algo, params, salt, hash FROM auth_credential').all());
        t.check('W5-③ 端到端（真进程）：`POST /auth/init{code,password}` ⇒ **200**（且正文不回显码）；' +
          '同码第二次 ⇒ **409** `already_initialized`；库里只有一行凭证且 **`salt`/`hash` ≠ 口令**、' +
          '`algo=scrypt`、`params=N=16384,r=8,p=1,keylen=32`',
          init1.status === 200 && init1.body && init1.body.initialized === true &&
          !init1.text.includes(initCode) &&
          init2.status === 409 && init2.body && init2.body.error === 'already_initialized' &&
          cred.length === 1 && cred[0].algo === 'scrypt' &&
          cred[0].params === 'N=16384,r=8,p=1,keylen=32' &&
          cred[0].salt !== PW1 && cred[0].hash !== PW1 && !cred[0].hash.includes(PW1) &&
          /^[0-9a-f]{64}$/.test(cred[0].hash) && /^[0-9a-f]{32}$/.test(cred[0].salt),
          `init=${init1.status}；initAgain=${init2.status}；凭证=${JSON.stringify(cred.map(x => ({ u: x.username, algo: x.algo, params: x.params })))}`);

        /* ⑤ 登录 200（64 位 hex 令牌）⇒ 改密 200 ⇒ 旧令牌立即失效（logout 401）⇒ 新口令登录 200、旧口令 401 */
        const login1 = await call('POST', '/auth/login', { password: PW1 });
        const token = login1.body && login1.body.token;
        const wrong = await call('POST', '/auth/login', { password: 'definitely-wrong-1' });
        const chg = await call('POST', '/auth/change', { oldPassword: PW1, newPassword: PW2 },
          { Authorization: 'Bearer ' + token });
        const outOld = await call('POST', '/auth/logout', {}, { Authorization: 'Bearer ' + token });
        const loginNew = await call('POST', '/auth/login', { password: PW2 });
        const loginOldPw = await call('POST', '/auth/login', { password: PW1 });
        /* 改密后的**新**令牌再登出一次 ⇒ 200（留痕里才会出现"登出"这一类；上一条旧令牌登出按设计是 401） */
        const outNew = await call('POST', '/auth/logout', {},
          { Authorization: 'Bearer ' + String(loginNew.body && loginNew.body.token) });
        t.check('W5-③ 端到端（真进程）：`POST /auth/login` ⇒ **200** 且 token 为 64 位 hex（含 `expiresAt`）；' +
          '`POST /auth/change`（Bearer）⇒ **200** 并**强制清会话**（旧令牌 `logout` ⇒ **401**）；' +
          '新口令登录 **200**（其令牌 `logout` ⇒ 200）、旧口令 **401**；错误口令 **401 且响应体不下发原因**',
          login1.status === 200 && /^[0-9a-f]{64}$/.test(String(token)) &&
          typeof (login1.body && login1.body.expiresAt) === 'string' &&
          wrong.status === 401 && wrong.body && wrong.body.error === 'bad_credentials' &&
          wrong.body.reason === undefined &&
          chg.status === 200 && chg.body && chg.body.requireRelogin === true &&
          outOld.status === 401 && outOld.body && outOld.body.error === 'unauthorized' &&
          loginNew.status === 200 && /^[0-9a-f]{64}$/.test(String(loginNew.body && loginNew.body.token)) &&
          loginOldPw.status === 401 && outNew.status === 200,
          `login=${login1.status}(token ${String(token).length} hex)；wrong=${wrong.status}/${wrong.body && wrong.body.error}` +
          `（reason 未下发=${wrong.body && wrong.body.reason === undefined}）；change=${chg.status}；` +
          `旧令牌登出=${outOld.status}；新口令登录=${loginNew.status}（其令牌登出=${outNew.status}）；` +
          `旧口令登录=${loginOldPw.status}`);

        /* ⑥ 错误次数与锁定（HTTP 面）：连续失败达到阈值 ⇒ 423 `locked` + `retryAfterSec`；
           此后**即使口令正确也 423**（ADR-0007 D2 —— 这一条在 HTTP 面也要能被看到，不能只在服务层验）。 */
        const lockAttempts = [];
        for (let i = 0; i < 5; i++) lockAttempts.push(await call('POST', '/auth/login', { password: 'lock-probe-' + i }));
        const lockedRight = await call('POST', '/auth/login', { password: PW2 });
        t.check('W5-③ 端到端（真进程）：连续失败达到阈值（`maxFailures`）后 ⇒ **423 `locked`** 且带 ' +
          '`retryAfterSec`；锁定期间**口令正确也 423**（不是 200）—— ADR-0007 D2 的"锁定"在 HTTP 面同样成立',
          lockAttempts.some(r => r.status === 423 && r.body && r.body.error === 'locked' &&
            typeof r.body.retryAfterSec === 'number' && r.body.retryAfterSec > 0) &&
          lockedRight.status === 423 && lockedRight.body && lockedRight.body.error === 'locked' &&
          typeof lockedRight.body.retryAfterSec === 'number' && lockedRight.body.reason !== undefined,
          `5 次错误口令的状态=${lockAttempts.map(r => r.status).join('/')}；` +
          `正确口令在锁定中=${lockedRight.status}/${lockedRight.body && lockedRight.body.error}` +
          `（retryAfterSec=${lockedRight.body && lockedRight.body.retryAfterSec}）`);

        /* ⑦ 留痕与明文（真进程口径）：六类各≥1、含来源 IP；库里/op_log 里不含口令明文 */
        const auditRows = withDb(c => c.prepare(
          'SELECT op_type, result, content FROM op_log ORDER BY id').all());
        const types = auditRows.map(r => r.op_type);
        const dbBytes = fs.readFileSync(authDbFile);
        t.check('W5-③ 端到端（真进程）：留痕含 **口令初始化码 / 口令初始化 / 解锁 / 解锁失败 / 账号锁定 / 改密 / 登出**，' +
          '且带**来源 IP**（取自 socket）；库文件字节与 op_log 全量序列化里**都没有口令明文**',
          ['口令初始化码', '口令初始化', '解锁', '解锁失败', '账号锁定', '改密', '登出'].every(k => types.includes(k)) &&
          auditRows.filter(r => /来源=/.test(String(r.content))).length >= 5 &&
          !dbBytes.includes(PW1) && !dbBytes.includes(PW2) &&
          !JSON.stringify(auditRows).includes(PW1) && !JSON.stringify(auditRows).includes(PW2),
          `留痕类型=${JSON.stringify(types)}；带来源 IP ${auditRows.filter(r => /来源=/.test(String(r.content))).length} 条`);

        /* ⑦ 码**立即作废**（跨 HTTP 边界的直接证据）：把凭证行删掉回到未初始化态，再用**同一个码**初始化 ⇒ 401。
           ⚠ 为什么必须这么造：只断言"第二次 init ⇒ 409"证明不了码已作废 —— 那一步在 `countCredentials()>0`
           的"已初始化"检查上就短路了（服务层用例 `tests\db-check.js` 九之三用同一手法，这里补跨 HTTP 的同一证据）。 */
        withDb(c => c.exec('DELETE FROM auth_credential'));
        const stAfterDelete = await call('GET', '/auth/status');
        const codeReuse = await call('POST', '/auth/init', { code: initCode, password: PW2 });
        t.check('W5-③ 端到端（真进程）：一次性初始化码**成功后立即作废** —— 删掉凭证行回到未初始化态后，' +
          '用**同一个码**再初始化 ⇒ **401 `bad_init_code`**（不是 200，也不是靠"已初始化"检查短路躲过去）',
          stAfterDelete.status === 200 && stAfterDelete.body && stAfterDelete.body.initialized === false &&
          codeReuse.status === 401 && codeReuse.body && codeReuse.body.error === 'bad_init_code',
          `删行后 initialized=${stAfterDelete.body && stAfterDelete.body.initialized}；同码再初始化=` +
          `${codeReuse.status}/${codeReuse.body && codeReuse.body.error}`);

        /* ⑧ 真进程优雅停止：端口释放、服务日志目录随 stop() 清掉（不留残留） */
        await authSvc.stop();
        const logFileAfterStop = authSvc.logFile;
        authSvc = null;
        await new Promise(r => setTimeout(r, 150));
        let stillUp = false;
        try { await fetch(`${base}/health`); stillUp = true; } catch { /* 已停 */ }
        t.check('W5-③ 端到端（真进程）：`stop()` 之后端口不再响应（服务真被停掉，无残留进程/句柄），' +
          '且 `startService` 的临时日志目录随 stop() 一起清掉',
          stillUp === false && !fs.existsSync(logFileAfterStop),
          stillUp ? '仍在响应（缺陷）' : `已停止（日志目录已清=${!fs.existsSync(logFileAfterStop)}）`);
      } finally {
        if (authSvc) await authSvc.stop();
        fs.rmSync(authTmp, { recursive: true, force: true });
      }
    }

    /* ---- 2d. W5-③/**F20**：**极旧库（连 `op_log` 表都没有）**的启动日志必须如实标"已 backfill"（真起进程）----
       造数：当前结构建库 → `DROP TABLE op_log` → 版本改回 '4' ⇒ 迁移前那次审计必然失败
       （`no such table: op_log`），迁移后由 db 层**补写**（`backfill（迁移后补写）`）。
       **改前复现**（F20 立案）：该行会打印"审计 op_log=写入失败（已告警，auditDegraded=true）"，
       而库里其实已有 backfill 行 ⇒ **日志与事实不符**。改后应打印"写入失败→已 backfill #<id>"。
       为什么单起一次进程：本判据的造数（无 `op_log` 表）与 2c 的库互斥，必须各起一个服务。 */
    {
      const f20Tmp = harness.makeTempDir('f20-backfill-log');
      const f20DbFile = path.join(f20Tmp, 'board.db');
      const f20Port = await harness.allocPort();
      const { DatabaseSync } = require('node:sqlite');
      const dbApi = require('../server/db');
      {
        const seed = new DatabaseSync(f20DbFile);
        dbApi.initSchema(seed, '2026-09-28 10:00:00');
        seed.exec('DROP TABLE op_log');       // 极旧库的形态：连 op_log 表都没有
        seed.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'").run();
        seed.close();
      }
      let f20Svc = null;
      try {
        f20Svc = await harness.startService({
          script: path.join(env.paths.root, 'server', 'index.js'),
          args: ['--port', String(f20Port), '--data-dir', f20Tmp, '--db-file', f20DbFile],
          port: f20Port, readyPath: '/health', timeoutMs: 20000
        });
        const f20Line = (f20Svc.output().match(/\[启动\] E18 迁移前已备份：[^\r\n]*/) || [''])[0];
        const f20Db = new DatabaseSync(f20DbFile);
        const f20Rows = f20Db.prepare(
          "SELECT id, result, content FROM op_log WHERE op_type = '迁移前备份'").all();
        f20Db.close();
        const f20LoggedId = Number((f20Line.match(/已 backfill #(\d+)/) || [])[1]);
        t.check('W5-③/F20 端到端（真进程）：**极旧库（连 `op_log` 表都没有）** ⇒ 启动日志的审计子句必须如实标' +
          '「写入失败→已 backfill #<id>」，且**不再打印**"（已告警，auditDegraded=true）"；' +
          '同时库里确有该 backfill 行（**日志里的 id 与库内行 id 一致**）',
          /审计 op_log=写入失败→已 backfill #\d+/.test(f20Line) &&
          !f20Line.includes('（已告警，auditDegraded=true）') &&
          f20Rows.length === 1 && String(f20Rows[0].content).includes('backfill') &&
          f20LoggedId === Number(f20Rows[0].id) && f20Rows[0].result === '成功',
          `日志行=${f20Line || '(未出现)'}；op_log=${JSON.stringify(f20Rows.map(r => ({ id: r.id, result: r.result })))}`);
      } finally {
        if (f20Svc) await f20Svc.stop();
        fs.rmSync(f20Tmp, { recursive: true, force: true });
      }
    }

    /* ---- 3~6. 起真服务做行为断言（子进程夹具） ---- */
    const w6Tmp = harness.makeTempDir('w6-entry-skeleton');
    const w6Scratch = path.join(env.paths.root, 'tests', '._verify', 'w6');
    fs.mkdirSync(w6Scratch, { recursive: true });
    /* ⚠ 夹具文件名带**本次运行的唯一标签**：门禁允许并发跑（E19 现实），固定文件名 + "收尾删整个目录"
       会让两个 harness-check 互相删对方的夹具（实测：并发轮次里本轮在写 `fixture-b.js` 时目录已被
       另一轮删掉 ⇒ ENOENT 崩在夹具中途）。只删自己写的文件，不删目录。 */
    const w6RunTag = process.pid + '-' + Date.now().toString(36);
    /** 本节点写过的夹具文件（收尾只删它们，不删共用目录） */
    const w6Written = [];

    const w6Write = (name, lines) => {
      const full = path.join(w6Scratch, name);
      fs.writeFileSync(full, lines.join('\r\n') + '\r\n', 'utf8');
      w6Written.push(full);
      return full;
    };
    const w6ReadResult = file => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    };
    const w6LogPath = name => path.join(w6Tmp, name + '.log');
    /** 原地起子进程（不删日志文件：调用方要读它）；stdout/stderr 一律落文件，避免管道 EPERM */
    const w6Spawn = (script, name, extraEnv) => {
      const logFile = w6LogPath(name);
      const fd = fs.openSync(logFile, 'a');
      const proc = spawn(process.execPath, [script], {
        cwd: env.paths.root,
        env: Object.assign({}, process.env, { DSH_ENV: 'test' }, extraEnv),
        windowsHide: true,
        stdio: ['ignore', fd, fd]
      });
      let settled = null;
      proc.on('exit', (code, signal) => { settled = { code, signal }; });
      return { proc, logFile, exitInfo: () => settled, log: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
        async waitDone(ms) {
          const until = Date.now() + ms;
          while (!settled && Date.now() < until) await new Promise(r => setTimeout(r, 100));
          try { fs.closeSync(fd); } catch { /* 已关 */ }
          return settled;
        } };
    };

    /* ---------------- 一、能起 · 能查 · 监听范围 · 优雅退 · SSE（夹具①，单次跑完一并取证） ----------------
       为什么要合成一个夹具：起停一次要真开库、真监听、真收尾 —— 每条断言各起一次会让门禁明显变慢；
       下面这些 check 彼此独立，只是**共用同一份取证**。 */
    const w6PortA = await harness.allocPort();
    const w6DataA = path.join(w6Tmp, 'data-a');
    const w6DbA = path.join(w6Tmp, 'custom-board.db');   // 用 --db-file 起，顺带验该覆盖项与 /health 的 dbFile
    const w6ResAFile = path.join(w6Tmp, 'result-a.json');
    const fA = w6Write('fixture-a-' + w6RunTag + '.js', [
      "'use strict';",
      "/* 由 tests/harness-check.js 生成：起真服务 → 逐条打真请求 → 结果写 JSON 文件。 */",
      "const fs = require('node:fs');",
      "const net = require('node:net');",
      "const path = require('node:path');",
      "const ROOT = path.resolve(__dirname, '..', '..', '..');",
      "process.env.DSH_ENV = 'test';",
      "const entry = require(path.join(ROOT, 'server', 'index.js'));",
      "const out = {};",
      "const save = () => fs.writeFileSync(process.env.DSH_W6_RESULT, JSON.stringify(out), 'utf8');",
      "const canBind = (host, port) => new Promise(resolve => {",
      "  const s = net.createServer();",
      "  s.once('error', err => resolve({ ok: false, code: err.code }));",
      "  s.listen({ host, port }, () => s.close(() => resolve({ ok: true })));",
      "});",
      "const externalIPv4 = () => {",
      "  for (const list of Object.values(require('node:os').networkInterfaces())) {",
      "    for (const it of list || []) if (it.family === 'IPv4' && !it.internal) return it.address;",
      "  }",
      "  return null;",
      "};",
      "(async () => {",
      "  const port = Number(process.env.DSH_W6_PORT);",
      "  const base = 'http://127.0.0.1:' + port;",
      "  const svc = await entry.start({",
      "    argv: ['--port', String(port), '--data-dir', process.env.DSH_W6_DATA, '--db-file', process.env.DSH_W6_DB],",
      "    installSignalHandlers: false,",
      "    logConsole: false,",
      "    heartbeatMs: 300,        // SSE 心跳周期：线上默认 15 s；这里调到 300 ms 才验得动（不改线上口径）",
      "    testRoutes: true",     // 只多注册一个"读体回显"端点，用于 400/413 的行为判据
      "  });",
      "  out.listen = svc.listen;",
      "  const hRes = await fetch(base + '/health');",
      "  out.health = { status: hRes.status, body: await hRes.json() };",
      "  const r404 = await fetch(base + '/no-such-endpoint');",
      "  out.e404 = { status: r404.status, body: await r404.json() };",
      "  const r405 = await fetch(base + '/health', { method: 'POST' });",
      "  out.e405 = { status: r405.status, allow: r405.headers.get('allow'), body: await r405.json() };",
      "  const r400 = await fetch(base + '/__w6/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });",
      "  out.e400 = { status: r400.status, body: await r400.json() };",
      "  const r413 = await fetch(base + '/__w6/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' },",
      "    body: JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 1024) }) });",   // 必须**超过**路由默认上限 1 MiB
      "  out.e413 = { status: r413.status, body: await r413.json() };",
      "  const ctl = new AbortController();",
      "  const evRes = await fetch(base + '/events', { signal: ctl.signal });",
      "  const reader = evRes.body.getReader();",
      "  const dec = new TextDecoder();",
      "  let sseText = '';",
      "  const until = Date.now() + 8000;",
      "  while (Date.now() < until && sseText.indexOf(': ping') < 0) {",
      "    /* 读一帧，但**最多等 1500 ms**：`reader.read()` 挂起时不会有超时，",
      "       不设上限的话这个 while 会把夹具拖到永远（本项目曾因此把一条断言拖成假绿）。 */",
      "    const chunk = await Promise.race([",
      "      reader.read(),",
      "      new Promise(r => setTimeout(() => r({ timeout: true }), 1500))",
      "    ]);",
      "    if (chunk.timeout || chunk.done) break;",
      "    sseText += dec.decode(chunk.value, { stream: true });",
      "  }",
      "  const streamsDuring = svc.router.streamCount();",
      "  ctl.abort();",
      "  try { await reader.cancel(); } catch { }",
      "  await new Promise(r => setTimeout(r, 300));",
      "  out.sse = { status: evRes.status, contentType: evRes.headers.get('content-type'),",
      "    retryFrame: /retry:\\s*3000/.test(sseText), heartbeat: /: ping /.test(sseText),",
      "    frames: sseText.split('\\n\\n').filter(Boolean).length, sample: sseText.slice(0, 200),",
      "    streamsDuring, streamsAfter: svc.router.streamCount() };",
      "  const ext = externalIPv4();",
      "  out.externalIPv4 = ext;",
      "  out.externalBind = ext ? await canBind(ext, port) : null;",
      "  out.loopbackBind = await canBind('127.0.0.1', port);",
      "  /* 先落盘，再 stop()：stop 的实现一变（比如直接 process.exit）也不至于让结果文件写不出来，",
      "     否则「变异把断言改红」会退化成「夹具没结果」（D22 要的是**指名**，不是一团空）。 */",
      "  save();",
      "  out.stopResult = await entry.stop('harness-check 夹具');",
      "  out.serverAfterStop = entry.state.server === null;",
      "  out.dbAfterStop = entry.state.db === null;",
      "  out.rebindAfterStop = await canBind('127.0.0.1', port);",
      "  save();",
      "})().catch(err => { out.error = String(err && err.stack ? err.stack : err); save(); process.exitCode = 1; });"
    ]);
    const runA = w6Spawn(fA, 'fixture-a', { DSH_W6_PORT: String(w6PortA), DSH_W6_DATA: w6DataA, DSH_W6_RESULT: w6ResAFile, DSH_W6_DB: w6DbA });
    /* watchdog：夹具异常时不至于把门禁挂住（正常路径不会触发） */
    const watchdogA = setTimeout(() => { try { runA.proc.kill(); } catch { /* 已退出 */ } }, 25000);
    const exitA = await runA.waitDone(25000);
    clearTimeout(watchdogA);
    const A = w6ReadResult(w6ResAFile);
    if (!t.requires('W6 夹具① 能取到结果文件（result-a.json）', Boolean(A), runA.log().slice(-400) || '无日志')) {
      t.info('W6：夹具①未产出结果，本节相关断言按失败处理（不许把"跑不了"当通过）');
    }
    const a = A || {};

    /* 能起：/health 200 且 JSON 含 ok/uptimeSec/dbWritable/version/listen，且库确实可写 */
    const hb = (a.health && a.health.body) || {};
    t.check('W6：GET /health 返回 200，且含 ok / uptimeSec / dbWritable / version / listen，dbWritable===true',
      a.health && a.health.status === 200 && hb.ok === true && typeof hb.uptimeSec === 'number' &&
      hb.dbWritable === true && typeof hb.version === 'string' && /:\d+$/.test(String(hb.listen)),
      `status=${a.health && a.health.status} body=${JSON.stringify(hb).slice(0, 220)}`);
    t.check('W6：/health 的 version 取自需求基线真源（board.config.js「需求版本：Vx.yz」）',
      typeof hb.version === 'string' && /^V\d+(\.\d+)*$/.test(hb.version) && hb.version === w6.readBaselineVersion(),
      `${hb.version}（readBaselineVersion()=${w6.readBaselineVersion()}）`);
    t.check('W6：/health 的 dbFile 反映 --db-file 覆盖项（库路径与"库可写"同源，不是各自猜）',
      path.resolve(String(hb.dbFile || '')) === path.resolve(w6DbA) && fs.existsSync(w6DbA),
      `health.dbFile=${hb.dbFile}`);

    /* 能查：404 / 405 / 400 / 413 形状稳定且带可读 message */
    const e404 = a.e404 || {}; const e405 = a.e405 || {}; const e400 = a.e400 || {}; const e413 = a.e413 || {};
    const errOf = r => (r && r.body && r.body.err) || {};
    t.check('W6：未知路径 ⇒ 404，且错误体形状稳定（ok 包裹的 err.code/httpStatus/message + path/method）',
      e404.status === 404 && errOf(e404).code === 'NOT_FOUND' && errOf(e404).httpStatus === 404 &&
      typeof errOf(e404).message === 'string' && errOf(e404).message.length > 0 &&
      e404.body.path === '/no-such-endpoint' && e404.body.method === 'GET',
      JSON.stringify(e404.body));
    t.check('W6：已知路径 + 不支持的方法 ⇒ 405（并给出 Allow，与 404 可区分）',
      e405.status === 405 && e405.allow === 'GET' && errOf(e405).code === 'METHOD_NOT_ALLOWED',
      `status=${e405.status} Allow=${e405.allow}`);
    t.check('W6：坏 JSON 请求体 ⇒ 400（指名"不是合法 JSON"，不是笼统 500）',
      e400.status === 400 && errOf(e400).code === 'BAD_JSON' && /JSON/.test(String(errOf(e400).message)),
      JSON.stringify(e400.body).slice(0, 200));
    t.check('W6：超大请求体 ⇒ 413（默认上限 1 MiB，附可读 message，不是把连接抛掉了事）',
      e413.status === 413 && errOf(e413).code === 'PAYLOAD_TOO_LARGE' && /上限/.test(String(errOf(e413).message)),
      JSON.stringify(e413.body).slice(0, 200));

    /* 监听范围：默认只回环 —— 行为判据：回环同端口绑定失败（被占用），非回环地址同端口仍可绑定（无人监听） */
    const extAddr = a.externalIPv4;
    const onlyLoopback = a.loopbackBind && a.loopbackBind.ok === false &&
      (!extAddr || (a.externalBind && a.externalBind.ok === true));
    t.check('W6：默认只监听回环（回环同端口已被占用、非回环地址同端口仍可绑定 ⇒ 局域网不可达）',
      onlyLoopback,
      `回环绑定=${JSON.stringify(a.loopbackBind)}；外部地址 ${extAddr || '（本机无非回环 IPv4）'} 绑定=${JSON.stringify(a.externalBind)}；listen=${a.listen}`);

    /* SSE 骨架：建连 + Content-Type + 心跳注释帧 + 关闭后连接数归零 */
    const sse = a.sse || {};
    t.check('W6：GET /events 建立 SSE 连接并收到心跳注释帧（Content-Type=text/event-stream，含 : ping 与 retry）',
      sse.status === 200 && /^text\/event-stream/.test(String(sse.contentType)) && sse.heartbeat === true && sse.retryFrame === true,
      `status=${sse.status} ctype=${sse.contentType} 帧数=${sse.frames} 原始帧=${JSON.stringify(sse.sample)}`);
    t.check('W6：SSE 客户端断开后连接被释放（在途连接数 1 → 0，定时器不残留）',
      sse.streamsDuring === 1 && sse.streamsAfter === 0,
      `断开前 ${sse.streamsDuring} 条、断开后 ${sse.streamsAfter} 条`);

    /* 优雅退出：stop() 返回 0 ⇒ 端口释放并可在同端口再次绑定 ⇒ 进程以 0 退出 ⇒ 无残留子进程 */
    t.check('W6：优雅退出后端口被释放（stop() 返回 code=0，内部状态已清空，且同端口可再次绑定）',
      a.stopResult && a.stopResult.code === 0 && a.serverAfterStop === true && a.dbAfterStop === true &&
      a.rebindAfterStop && a.rebindAfterStop.ok === true,
      `stop=${JSON.stringify(a.stopResult)} server=null:${a.serverAfterStop} db=null:${a.dbAfterStop} 再绑定=${JSON.stringify(a.rebindAfterStop)}`);
    t.check('W6：优雅退出的进程以退出码 0 结束（自然排空事件循环，无信号残留/无未关句柄）',
      exitA && exitA.code === 0,
      `exit=${JSON.stringify(exitA)}` + (a.error ? ` 夹具异常：${String(a.error).slice(0, 200)}` : ''));

    /* ---------------- 二、不静默：启动自检失败 ⇒ 退非零（夹具②） ----------------
       夹具② 造的是**"只有自检能挡住"**的失败：在 `backupDir`（`<数据根>\backup`）这个**路径上**
       放一个同名普通文件，于是自检往"备份目录"里写探针文件必然失败（ENOTDIR）。
       为什么必须这样精确：若用"数据根不可用"或"库文件只读"当故障源，进程会在**更早**的
       建日志 / `openDb`（`PRAGMA journal_mode` 需要写权限）处就退出 —— 那样即使把启动自检
       整段删掉，退出码依然非零，断言会**假绿**（D22 变异 a 前两次就踩到了这两种"更早失败"）。
       而 `backupDir` 的可写性**只由启动自检检查**：sqlite 不管它、日志不管它 ⇒
       去掉自检后进程会一路起到监听（夹具随即以退出码 9 报"缺陷"），断言这才真的变红。 */
    const w6PortB = await harness.allocPort();
    const w6DataB = path.join(w6Tmp, 'data-b');
    const fB = w6Write('fixture-b-' + w6RunTag + '.js', [
      "'use strict';",
      "/* 启动自检②：backupDir 被同名**文件**占位（写探针必然失败 ENOTDIR）⇒ 自检必须挡住 ⇒ 退非零。 */",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const ROOT = path.resolve(__dirname, '..', '..', '..');",
      "process.env.DSH_ENV = 'test';",
      "const entry = require(path.join(ROOT, 'server', 'index.js'));",
      "const dataDir = process.env.DSH_W6_DATA;",
      "const blocker = path.join(dataDir, 'backup');          // 备份目录路径上放一个**同名普通文件**",
      "fs.rmSync(dataDir, { recursive: true, force: true });",
      "fs.mkdirSync(dataDir, { recursive: true });",
      "fs.writeFileSync(blocker, 'W6 夹具②：本文件占住“备份目录”这个路径（它本该是个目录）', 'utf8');",
      "/* 反向自检：确认这个占位真的让“写探针文件”失败（否则夹具没造出目标场景，不许假绿） */",
      "let blocked = false;",
      "try { fs.writeFileSync(path.join(blocker, '.w6-write-probe-selfcheck'), 'ok', 'utf8'); } catch (e) { blocked = true; }",
      "console.log('夹具②：备份目录写探针被挡住 = ' + blocked);",
      "if (!blocked) { console.error('夹具②：没造出“备份目录不可写”的场景'); process.exit(5); }",
      "const failFast = setTimeout(() => { console.error('W6 夹具②：10 s 内启动自检仍未拦住（缺陷）'); process.exit(9); }, 10000);",
      "entry.start({ argv: ['--port', String(process.env.DSH_W6_PORT), '--data-dir', dataDir],",
      "    installSignalHandlers: false, logConsole: true })",
      "  .then(() => { clearTimeout(failFast); console.error('W6 夹具②：启动自检没有拦住不可写的备份目录 —— 服务照常起来了（缺陷）'); process.exit(9); })",
      "  .catch(err => { clearTimeout(failFast); console.error('W6 夹具②：start() 抛出（可接受路径）：' + (err && err.message)); process.exit(8); });"
    ]);
    const runB = w6Spawn(fB, 'fixture-b', { DSH_W6_PORT: String(w6PortB), DSH_W6_DATA: w6DataB });
    const watchdogB = setTimeout(() => { try { runB.proc.kill(); } catch { /* 已退出 */ } }, 20000);
    const exitB = await runB.waitDone(20000);
    clearTimeout(watchdogB);
    const logB = runB.log();
    if (exitB && exitB.code === 5) {
      t.skip('W6：启动自检失败（备份目录不可写）⇒ 进程退非零且日志指名是哪一项，绝不"假活"（夹具②）',
        '本机没能造出"备份目录不可写"的场景（占位文件下仍能写探针）—— 环境不支持该故障源');
    } else {
      t.check('W6：启动自检失败（备份目录不可写）⇒ 进程退非零且日志指名是哪一项，绝不"假活"（夹具②）',
        Boolean(exitB) && exitB.code !== 0 && /启动自检未通过/.test(logB) && /backupDir/.test(logB),
        `exit=${JSON.stringify(exitB)} 日志尾部=${logB.trim().split('\n').slice(-2).join(' ｜ ').slice(0, 240)}`);
    }

    /* ---------------- 三、不静默：未捕获异常/未处理 rejection ⇒ 退非零 + 日志有记录（夹具③） ---------------- */
    for (const mode of ['uncaught', 'rejection']) {
      const w6PortC = await harness.allocPort();
      const w6DataC = path.join(w6Tmp, 'data-c-' + mode);
      const fC = w6Write('fixture-c-' + mode + '-' + w6RunTag + '.js', [
        "'use strict';",
        "const path = require('node:path');",
        "const ROOT = path.resolve(__dirname, '..', '..', '..');",
        "process.env.DSH_ENV = 'test';",
        "const mode = process.env.DSH_W6_CRASH;",
        "const entry = require(path.join(ROOT, 'server', 'index.js'));",
        "entry.main({ argv: ['--port', String(process.env.DSH_W6_PORT), '--data-dir', process.env.DSH_W6_DATA, '--crash', mode],",
        "  logConsole: true })",
        "  .then(() => { console.log('W6 夹具③：已监听，等待注入的 ' + mode + ' 生效'); })",
        "  .catch(err => { console.error('W6 夹具③：main() 失败：' + (err && err.message)); process.exit(7); });"
      ]);
      const runC = w6Spawn(fC, 'fixture-c-' + mode,
        { DSH_W6_PORT: String(w6PortC), DSH_W6_DATA: w6DataC, DSH_W6_CRASH: mode });
      /* 先证明"服务真的起来过"（否则"崩"可能只是没启动起来，断言会变成假的绿） */
      let wasUp = false;
      const readyUntil = Date.now() + 6000;
      while (Date.now() < readyUntil && !wasUp) {
        try { wasUp = (await fetch(`http://127.0.0.1:${w6PortC}/health`)).status === 200; }
        catch { await new Promise(r => setTimeout(r, 120)); }
      }
      const exitC = await runC.waitDone(15000);
      const logC = runC.log();
      const kindText = mode === 'uncaught' ? '未捕获异常' : '未处理的 Promise rejection';
      t.check(`W6：${kindText}不静默（服务确实起来过 ⇒ 注入后进程退非零 ⇒ 日志留痕，夹具③）`,
        wasUp === true && Boolean(exitC) && exitC.code !== 0 && logC.includes(kindText),
        `起来过=${wasUp} exit=${JSON.stringify(exitC)} 日志尾部=${logC.trim().split('\n').slice(-2).join(' ｜ ').slice(0, 200)}`);
    }

    try { fs.rmSync(w6Tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    /* 只删本节点的夹具文件，不删整个 w6 目录（并发轮次共用该目录，见上方 w6RunTag 说明） */
    for (const f of w6Written) { try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ } }
  } else {
    t.info('W6：server\\index.js 不存在 —— 上述进程入口断言未执行（不许把"跑不了"当通过）');
  }
}

/* ---------------- 四之②、W5-① 服务端 SSE 业务推送（快照同源／断线续传／六类事件／CORS／静态托管／优雅关闭） ----------------
   覆盖 W5-① 的九条判据（①建连快照同源 ②断线续传 ③脏输入不发布 ④帧事件与采样表逐条对账 ⑤心跳可预测
   ⑥优雅关闭 ⑦缓冲溢出计数 ⑧无裸时间 ⑨端口/监听）＋ 负责人 2026-09-28 裁定「选项 A」的 CORS 与静态托管。
   手法沿用本节上半段：**真起进程、真打 HTTP、真读响应**（行为判据，不匹配源码字符串，遵 D23）。
   夹具源码内联在本节（写成文件后以子进程跑）；产物一律落 tests\._verify\w5sse\（D16：测试只写这里）。 */
t.section('四之②、W5-① 服务端 SSE 业务推送（快照同源／断线续传／六类事件／CORS／静态托管／优雅关闭）');
{
  /* 夹具源内联在这里（写成文件后以子进程真起服务）：**门禁只改本脚本一个文件**，
     夹具不进仓库 —— 它们每次都重新写到 tests\._verify\w5sse\（已 gitignore）。
     内联用 String.raw：夹具里的 `\n` / `\r\n` 等转义按字面写进文件（不在这里被解释）。 */
  const W5_FIXTURE_SSE = String.raw`'use strict';
/* W5-① 服务端 SSE 业务推送 —— 端到端夹具（由 tests/harness-check.js 生成到 tests/._verify/w5sse/）
   真起服务（真 HTTP 回环）→ 逐条打真请求 → 结果写 JSON 文件；本文件**不做断言**（断言在 harness-check）。
   阶段划分（每段一条连接，避免"哪些事件落在哪个窗口"含糊）：
     ① hello 快照与 /state 同源   ② 心跳计数   ③ 帧事件（1 s 采样才发）＋链路在线
     ④ 断线续传（?since= / Last-Event-ID）   ⑤ 链路离线（推进注入时钟）   ⑥ 其余四类事件
     ⑦ 超缓冲退回 hello ＋ 非法 since   ⑧ 优雅关闭（先 closeAllStreams、再 stop） */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
process.env.DSH_ENV = 'test';
const entry = require(path.join(ROOT, 'server', 'index.js'));
const { createUploadReporter } = require(path.join(ROOT, 'server', 'services', 'uploadReporter.js'));
const stdRepo = require(path.join(ROOT, 'server', 'repo', 'standard.js'));
const judge = require(path.join(ROOT, 'server', 'services', 'judge.js'));
const boardConfig = require(path.join(ROOT, 'src', 'config', 'board.config.js'));

const OUT = {};
const SAVE = () => fs.writeFileSync(process.env.DSH_W5_RESULT, JSON.stringify(OUT, null, 1), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 注入时钟：固定时刻 + 可手动推进（链路离线判据要能确定性地跨过 upper.staleMs = 5000） */
let fixedMs = Date.parse('2026-09-19T10:00:00');
const injectedAt = new Date(fixedMs).toISOString();
const clock = {
  now: () => new Date(fixedMs),
  source: () => () => new Date(fixedMs),
  advanceMs: ms => { fixedMs += ms; return fixedMs; }
};

/* ---- SSE 客户端：真 HTTP + 按 SSE 规范切块 ---- */
function parseFrames(text) {
  const out = [];
  for (const block of String(text).split('\n\n')) {
    if (!block.trim()) continue;
    const f = { retry: null, comment: null, id: null, event: null, data: null };
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) f.comment = line.slice(1).trim();
      else if (line.startsWith('retry:')) f.retry = line.slice(6).trim();
      else if (line.startsWith('id:')) f.id = line.slice(3).trim();
      else if (line.startsWith('event:')) f.event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) f.data = dataLines.join('\n');
    out.push(f);
  }
  return out;
}

async function openStream(base, opts = {}) {
  const ctl = new AbortController();
  const res = await fetch(base + (opts.path || '/events'), { headers: opts.headers || {}, signal: ctl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let done = false;
  const chunks = [];
  /* ⚠ 两条硬约束（都是实测踩出来的）：
     ① 任何时刻**只允许一个在途 read()**：超时的 race 只能放弃"超时 promise"，绝不能让
        「reader.read()」悬空 —— 悬空的读稍后 resolve 时它带回的字节没人接收，会**静默丢帧**；
     ② 每个 read 都**预挂一个 catch**：「abort()」会让挂起的读以 AbortError 拒绝，
        没挂 catch 时就是一条未处理拒绝 ⇒ 夹具进程直接崩（本夹具实测崩过一次）。 */
  let reading = null;
  const arm = () => { reading = reader.read(); reading.catch(() => { /* abort/重置：由 pump 收敛 */ }); };
  arm();
  async function pump(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !done) {
      let chunk;
      try {
        chunk = await Promise.race([
          reading,
          new Promise(r => setTimeout(() => r({ timeout: true }), Math.max(1, until - Date.now())))
        ]);
      } catch { done = true; break; }        // 连接被 abort/重置 ⇒ 当作流结束
      if (chunk.timeout) break;
      if (chunk.done) { done = true; break; }
      text += dec.decode(chunk.value, { stream: true });
      chunks.push({ at: Date.now(), len: text.length });
      arm();
    }
    return text;
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    pump,
    text: () => text,
    chunks: () => chunks.slice(),
    finished: () => done,
    frames: () => parseFrames(text),
    events: () => parseFrames(text).filter(f => f.event).map(f => ({
      id: Number(f.id), event: f.event, data: f.data ? JSON.parse(f.data) : null
    })),
    async close() { try { ctl.abort(); } catch { /* 已关 */ } try { await reader.cancel(); } catch { /* 已关 */ } }
  };
}

/** 合法帧（字段名与 IF-D 契约一致） */
function frame(i, collectTime) {
  return {
    equipCode: 'EQ-W5', procOrderNo: 'WO-W5-1', collectTime,
    seq: i, depth: 5.0 + i / 100, speed: 5 + i / 100,
    velocity_x: 3 + i / 100, velocity_y: 4 + i / 100,
    frameRate: 1000, gain: 2.5, shutter: 500, cameraDepth: 12.5, testStatus: 1
  };
}

async function post(base, p, body) {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body: parsed };
}
const seqNow = async base => (await (await fetch(base + '/state')).json()).seq;

const streams = [];
(async () => {
  const port = Number(process.env.DSH_W5_PORT);
  const base = 'http://127.0.0.1:' + port;
  const svc = await entry.start({
    argv: ['--port', String(port), '--data-dir', process.env.DSH_W5_DATA, '--db-file', process.env.DSH_W5_DB],
    installSignalHandlers: false,
    logConsole: false,
    heartbeatMs: 100,
    linkIntervalMs: 100,
    busCapacity: 8,          // 小容量：端到端也能验"超缓冲退回 hello"
    clock
  });
  const db = entry.state.db;
  const rowCount = () => db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
  /* 连接级取证：优雅退出时"到底是谁让 server.close() 等"必须看得见（否则只能猜） */
  const conns = [];
  const bySock = new Map();
  entry.state.server.on('connection', sock => {
    const rec = { openedAt: Date.now(), closedAt: null, remote: sock.remotePort, urls: [] };
    conns.push(rec);
    bySock.set(sock, rec);
    sock.on('close', () => { rec.closedAt = Date.now(); });
  });
  entry.state.server.on('request', (req) => {
    const rec = bySock.get(req.socket);
    if (rec) rec.urls.push(req.method + ' ' + req.url);
  });

  OUT.listen = svc.listen;
  OUT.injectedAt = injectedAt;
  OUT.mountSSE = svc.router.mountSSE();          // 无参：接线后必须自报**真实**状态
  OUT.routes = svc.router.list();
  OUT.config = { defaultHost: entry.DEFAULT_HOST, defaultPort: entry.DEFAULT_PORT, heartbeatMs: 100, busCapacity: svc.bus.capacity };

  /* ================= ① 建连快照：/state 与 hello 同源 ================= */
  const state0Res = await fetch(base + '/state');
  const state0Text = await state0Res.text();
  OUT.state0 = {
    status: state0Res.status, contentType: state0Res.headers.get('content-type'),
    text: state0Text, body: JSON.parse(state0Text)
  };
  const sHello = await openStream(base);
  streams.push(sHello);
  OUT.hello0 = { status: sHello.status, contentType: sHello.contentType, text: await sHello.pump(400), events: sHello.events() };
  await sHello.close();

  /* ================= ② 心跳：注入 100 ms，观测 2000 ms（公式 E=floor(D/H)） ================= */
  if (!String(process.env.W5_SKIP || '').includes('hb')) {
  const sHb = await openStream(base);
  streams.push(sHb);
  const hbStart = Date.now();
  const hbText = await sHb.pump(2000);
  OUT.heartbeat = {
    windowMs: 2000, heartbeatMs: 100, elapsedMs: Date.now() - hbStart,
    text: hbText, chunks: sHb.chunks()
  };
  await sHb.close();
  } else { OUT.heartbeat = { skipped: true }; }

  /* ================= ③ 帧事件（1 s 采样才发；500 ms 原始帧与脏帧都不发）＋链路在线 ================= */
  const sFrames = await openStream(base);
  streams.push(sFrames);
  await sleep(150);                                   // 让链路监控建立基线（首次 tick 只记基线）
  const rowsBefore = rowCount();
  OUT.frames = { rowsBefore, posts: [] };
  OUT.frames.posts.push(await post(base, '/ifd/frame', frame(1, '2026-09-19 10:00:00')));   // stored
  OUT.frames.posts.push(await post(base, '/ifd/frame', frame(2, '2026-09-19 10:00:00')));   // 同秒异键 ⇒ raw-500ms
  const dirty = frame(3, '2026-09-19 10:01:00');
  delete dirty.procOrderNo;                                                                  // 脏帧 ⇒ 400
  OUT.frames.posts.push(await post(base, '/ifd/frame', dirty));
  await sFrames.pump(500);                             // 覆盖：帧事件 + 链路"离线→在线"
  OUT.frames.rowsAfter = rowCount();
  OUT.frames.stream = { text: sFrames.text(), events: sFrames.events() };
  await sFrames.close();

  /* ================= ④ 断线续传：?since= / Last-Event-ID（此时链路在线 ⇒ 窗口内只有帧事件） ================= */
  const cursorBase = await seqNow(base);               // = 帧事件与链路在线事件的最大 seq
  for (let i = 0; i < 3; i++) {
    OUT.frames.posts.push(await post(base, '/ifd/frame', frame(10 + i, '2026-09-19 10:00:1' + i)));
  }
  OUT.replay = { cursorBase, expectedFrames: ['2026-09-19 10:00:10', '2026-09-19 10:00:11', '2026-09-19 10:00:12'] };
  const sReplay = await openStream(base, { path: '/events?since=' + cursorBase });
  streams.push(sReplay);
  OUT.replay.byQuery = { status: sReplay.status, text: await sReplay.pump(400) };
  OUT.replay.byQuery.events = sReplay.events();
  await sReplay.close();
  const sHeader = await openStream(base, { headers: { 'Last-Event-ID': String(cursorBase + 1) } });
  streams.push(sHeader);
  OUT.replay.byHeader = { status: sHeader.status, text: await sHeader.pump(400) };
  OUT.replay.byHeader.events = sHeader.events();
  await sHeader.close();

  /* ================= ⑤ 链路"在线→离线"：注入时钟推进 6 s（> upper.staleMs = 5000） ================= */
  const sLink = await openStream(base);
  streams.push(sLink);
  await sLink.pump(150);
  clock.advanceMs(6000);
  OUT.afterAdvanceAt = new Date(fixedMs).toISOString();   // 注释帧时间戳只允许取这两个注入值之一（D17 判据）
  OUT.link = { afterAdvance: await sLink.pump(450) };
  OUT.link.events = sLink.events();
  OUT.link.state = (await (await fetch(base + '/state')).json()).snapshot.link;
  await sLink.close();

  /* ================= ⑥ 其余三类事件（task / standard / upload）＋ 「warning」（**夹具直调** judge） =================
     ⚠ F12：「warning」 的**唯一发布点**（「judge.evaluate」）在全仓没有生产调用方，这里是**夹具直调** ——
     它证明的是"挂钩可用"，不是"挂在真实写入点"（生产发布点待接线：技术债 E45）。 */
  const sOther = await openStream(base);
  streams.push(sOther);
  OUT.inproc = [];                                    // 进程内旁证：同一总线上的订阅者收到了什么
  const probe = svc.bus.subscribe(e => OUT.inproc.push(e.seq + ':' + e.kind));
  OUT.other = { task: [], standard: {}, upload: {}, warning: {} };
  OUT.other.task.push(await post(base, '/ifa/dispatch',
    { procOrderNo: 'WO-W5-9', productCode: 'P-W5', processNo: '30', planQty: 12, equipCode: 'EQ-W5' }));
  OUT.other.task.push(await post(base, '/ifa/dispatch',
    { procOrderNo: 'WO-W5-9', productCode: 'P-W5', processNo: '30', planQty: 12, equipCode: 'EQ-W5' })); // 幂等命中

  const nowText = '2026-09-19 10:00:06';
  OUT.other.standard.added = stdRepo.addVersion(db, {
    productCode: 'P-W5', processCode: '30', depthUpperDev: 0.2, depthLowerDev: -0.2, depthTypical: 5,
    speedUpperDev: 0.3, speedLowerDev: -0.3, speedTypical: 5
  }, undefined, nowText, { bus: svc.bus });
  OUT.other.standard.rejected = { threw: false, message: null };
  try {
    stdRepo.addVersion(db, { productCode: 'P-W5', processCode: '30', depthUpperDev: 0.2 }, undefined, nowText, { bus: svc.bus });
  } catch (err) {
    OUT.other.standard.rejected.threw = true;
    OUT.other.standard.rejected.message = String(err && err.message).slice(0, 200);
  }
  OUT.other.standard.versions = stdRepo.countVersions(db, { productCode: 'P-W5', processCode: '30' });

  const failingFetch = async () => { throw new Error('W5 夹具注入的网络错误'); };
  const rep = createUploadReporter({
    db, bus: svc.bus, now: clock.source(), fetch: failingFetch,
    config: Object.assign({}, boardConfig, { mes: Object.assign({}, boardConfig.mes, { baseUrl: 'http://127.0.0.1:9/x' }) })
  });
  OUT.other.upload.report = await rep.report({});
  OUT.other.upload.pendingCount = rep.pendingCount(true);

  OUT.other.warning.result = judge.evaluate({
    now: new Date(fixedMs),
    real: { depth: 5.22, speed: 5 },
    standard: {
      depth: { typical: 5, upperDev: 0.3, lowerDev: -0.2, unit: 'm' },
      speed: { typical: 5, upperDev: 0.3, lowerDev: -0.2, unit: 'm/s' }
    },
    consumableHours: 10, pendingQty: 1
  }, { bus: svc.bus });

  await sOther.pump(500);
  OUT.other.stream = { text: sOther.text(), events: sOther.events() };
  OUT.other.sseStatus = svc.router.sseStatus();
  svc.bus.unsubscribe(probe);
  await sOther.close();
  OUT.stateFinal = await (await fetch(base + '/state')).json();
  OUT.uploadStatus = await (await fetch(base + '/upload/status')).json();

  /* ================= ⑦ 超缓冲退回 hello ＋ 非法 since 不得 500 ================= */
  for (let i = 0; i < 10; i++) {
    OUT.frames.posts.push(await post(base, '/ifd/frame', frame(20 + i, '2026-09-19 10:01:' + String(i).padStart(2, '0'))));
  }
  const sOverflow = await openStream(base, { path: '/events?since=' + (cursorBase + 3) });
  streams.push(sOverflow);
  OUT.replay.overflow = { status: sOverflow.status, text: await sOverflow.pump(400) };
  OUT.replay.overflow.events = sOverflow.events();
  OUT.replay.busStats = svc.bus.stats();
  await sOverflow.close();

  OUT.replay.invalid = {};
  for (const bad of ['abc', '-5', '1.5', '']) {
    const s = await openStream(base, { path: '/events?since=' + encodeURIComponent(bad) });
    streams.push(s);
    const text = await s.pump(250);
    OUT.replay.invalid[bad === '' ? '(空串)' : bad] = { status: s.status, text };
    await s.close();
  }
  const sBadHeader = await openStream(base, { headers: { 'Last-Event-ID': 'xyz' } });
  streams.push(sBadHeader);
  OUT.replay.invalid.header = { status: sBadHeader.status, text: await sBadHeader.pump(250) };
  await sBadHeader.close();

  /* ================= ⑦b CORS 与静态托管（裁定「选项 A」） ================= */
  const net = require('node:net');
  const probeHttp = async (p, opts = {}) => {
    const r = await fetch(base + p, opts);
    const buf = Buffer.from(await r.arrayBuffer());      // 按**字节**计数（文本/二进制都准）
    const ct = r.headers.get('content-type') || '';
    const all = buf.toString('utf8');
    const textual = /^text\/|json|javascript|xml/.test(ct);
    const h = k => r.headers.get(k);
    return {
      status: r.status,
      acao: h('access-control-allow-origin'),
      acam: h('access-control-allow-methods'),
      acah: h('access-control-allow-headers'),
      acac: h('access-control-allow-credentials'),
      maxAge: h('access-control-max-age'),
      vary: h('vary'),
      contentType: ct,
      cacheControl: h('cache-control'),
      contentLength: h('content-length'),
      len: buf.length,
      textual,
      /* 二进制（png）不入结果文件：留 64 字符样本即可，否则账本里会塞进几百 KB 乱码 */
      text: textual ? all : all.slice(0, 64)
    };
  };
  /** 原始请求行探针：反斜杠/编码穿越这类形态 fetch 会先做 URL 归一，必须用裸 socket 才测得准。
   *  返回**状态码 + body 指纹**（便于断言"同一文件不因拼写产生两种判定"：200 的 body 哈希必须相等）。 */
  const rawGet = p => new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET ' + p + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', c => { data += c; });
    sock.on('close', () => {
      const text = String(data);
      const i = text.indexOf('\r\n\r\n');
      const head = i < 0 ? text : text.slice(0, i);
      const body = i < 0 ? '' : text.slice(i + 4);
      resolve({
        statusLine: head.split('\r\n')[0],
        status: Number((/^HTTP\/1\.1 (\d+)/.exec(head) || [])[1] || 0),
        bodyLen: body.length,
        bodyHash: require('node:crypto').createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16),
        bodyHasIndexJs: /启动自检|createRouter|module\.exports/.test(text),
        bodyTail: text.slice(-200),
        text
      });
    });
    sock.on('error', err => resolve({ statusLine: 'ERR ' + err.message, status: 0, bodyLen: 0, bodyHash: '', bodyHasIndexJs: false, bodyTail: '', text: '' }));
  });

  OUT.cors = {};
  OUT.cors.nullOrigin = await probeHttp('/state', { headers: { Origin: 'null' } });
  OUT.cors.loopbackOrigin = await probeHttp('/state', { headers: { Origin: 'http://127.0.0.1:' + port } });
  OUT.cors.localhostOrigin = await probeHttp('/state', { headers: { Origin: 'http://localhost:' + port } });
  OUT.cors.otherPort = await probeHttp('/state', { headers: { Origin: 'http://127.0.0.1:' + (port + 1) } });
  OUT.cors.evilOrigin = await probeHttp('/state', { headers: { Origin: 'http://evil.example' } });
  OUT.cors.noOrigin = await probeHttp('/state');
  OUT.cors.preflightNull = await probeHttp('/upload/retry', {
    method: 'OPTIONS',
    headers: {
      Origin: 'null', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type, Authorization'
    }
  });
  OUT.cors.preflightEvil = await probeHttp('/upload/retry', { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } });
  OUT.cors.preflightUnknown = await probeHttp('/no-such-path', { method: 'OPTIONS', headers: { Origin: 'null' } });
  OUT.cors.optionsNoOrigin = await probeHttp('/state', { method: 'OPTIONS' });
  /* F6：未注册路径**一个 CORS 头都不挂**（含 GET 形态；旧写法会在 404 上带 ACAO，口径不自洽） */
  OUT.cors.getUnknownWithOrigin = await probeHttp('/no-such-path', { headers: { Origin: 'null' } });
  OUT.cors.status = svc.cors.status();

  OUT.site = {};
  OUT.site.root = await probeHttp('/');
  OUT.site.indexHtml = await probeHttp('/index.html');
  OUT.site.js = await probeHttp('/src/main.js');
  OUT.site.config = await probeHttp('/src/config/board.config.js');
  OUT.site.css = await probeHttp('/src/styles/global.css');
  OUT.site.png = await probeHttp('/src/assets/screenshots/01-%E8%AE%BE%E5%A4%87%E7%8A%B6%E6%80%81-%E4%BB%BB%E5%8A%A1%E6%9B%B2%E7%BA%BF.png');
  OUT.site.served = svc.site.status().served;
  /* W7-C：/favicon.ico（浏览器打开同源入口时**自动**请求）⇒ 必须 **204 空体**（否则控制台多一条 network error）；
     同时记下"处理它**没有**新增路由"的证据（路由清单条数）与静态层计数（证明是被 204 分支接住、不是落 404）。 */
  OUT.site.favicon = await probeHttp('/favicon.ico');
  OUT.site.faviconServed = svc.site.status().served;
  OUT.site.routesCountAfterFavicon = svc.router.list().length;
  OUT.site.faviconNotWhitelisted = svc.site.resolve('/favicon.ico');

  /* 白名单外 + 穿越（fetch 形态） */
  const deniedPaths = [
    '/server/index.js', '/server/http/router.js', '/tests/README.md', '/tools/mock-upper/mock-upper.js',
    '/%E9%A1%B9%E7%9B%AE%E8%AE%B0%E5%BD%95/%E5%B7%A5%E4%BD%9C%E6%97%A5%E5%BF%97.md',
    '/.git/config', '/data/dev/board.db', '/%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3/', '/no-such-endpoint',
    '/src/../server/index.js', '/src/%2e%2e%2fserver/index.js', '/src/%2E%2E/server/index.js',
    '/%2e%2e%2fserver/index.js', '/src/config/../../../server/index.js', '/src/nope.js', '/src/'
  ];
  OUT.site.denied = {};
  for (const p of deniedPaths) OUT.site.denied[p] = await probeHttp(p);

  /* 穿越（裸 socket 形态：反斜杠 / 双斜杠 / 绝对路径） */
  OUT.raw = {};
  for (const p of ['/src\\..\\server\\index.js', '/src\\..%5cserver\\index.js', '//server/index.js',
    '/src/%252e%252e%252fserver/index.js', '/C:/Windows/win.ini', '/src/%00index.html']) {
    const text = await rawGet(p);
    OUT.raw[p] = {
      statusLine: text.statusLine,
      bodyHasIndexJs: text.bodyHasIndexJs,
      bodyTail: text.bodyTail
    };
  }

  /* F7：**规范化拼写**口径（裸 socket，绕开客户端 URL 归一）——同一文件不得因拼写给出两种判定 */
  OUT.canonical = {};
  for (const p of ['/index.html', '/index.HTML', '/index.html/', '/src/main.js', '/src/main.js/',
    '//index.html', '/./index.html', '/src/MAIN.JS', '/src//main.js', '//src/main.js']) {
    const r = await rawGet(p);
    OUT.canonical[p] = { status: r.status, bodyLen: r.bodyLen, bodyHash: r.bodyHash, bodyTail: r.bodyTail };
  }

  /* F4/F9：**realpath 复核**的两种越界（都在临时根里做，**不往仓库 src\ 里建任何链接**）：
     · 「serve/src/linkdir」  → junction → 「tmpRoot/outside」（**出根**）        ⇒ 必须 404（F4）
     · 「serve/src/inrepo」   → junction → 「serve/inRoot」（**在 serve 根之内、但在 serve/src 之外**）
       —— 这正是 F9 的形态（仓库内 「src\x -> tests」）：realpath 上界若仍是"根"，它会被托管出去。
     拆链接只用 「cmd /c rmdir <link>」（**绝不** 「fs.rmSync(recursive)」：那可能顺链接删到目标目录），
     并逐个确认目标目录仍在（把安全动作也留成证据）。 */
  OUT.realpathProbe = { junctionCreated: false, note: '' };
  try {
    const os = require('node:os');
    const httpRaw = require('node:http');
    const { spawnSync } = require('node:child_process');
    const { createRouter: createRouter2 } = require(path.join(ROOT, 'server', 'http', 'router.js'));
    const { mountSite } = require(path.join(ROOT, 'server', 'http', 'site.js'));
    const tmpRoot = path.join(os.tmpdir(), 'w5-serve-' + process.pid + '-' + Date.now());
    const outside = path.join(tmpRoot, 'outside');                 // 根之外（F4）
    const serveRoot = path.join(tmpRoot, 'serve');
    const inRoot = path.join(serveRoot, 'inRoot');                 // **根之内、但在 root/src 之外**（F9 的形态）
    const linkOut = path.join(serveRoot, 'src', 'linkdir');
    const linkIn = path.join(serveRoot, 'src', 'inrepo');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(inRoot, { recursive: true });
    fs.mkdirSync(path.join(serveRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(serveRoot, 'src', 'ok.js'), 'window.W5_PROBE_OK = 1;\n', 'utf8');
    fs.writeFileSync(path.join(outside, 'secret.js'), 'window.W5_SECRET = "OUTSIDE-SECRET-MARKER";\n', 'utf8');
    fs.writeFileSync(path.join(inRoot, 'tests-like.js'), 'window.W5_INREPO = "IN-ROOT-BUT-OUTSIDE-SRC-MARKER";\n', 'utf8');
    fs.symlinkSync(outside, linkOut, 'junction');
    fs.symlinkSync(inRoot, linkIn, 'junction');
    OUT.realpathProbe.junctionCreated = true;
    const probeLogs = [];
    const r2 = createRouter2({});
    mountSite(r2, {
      root: serveRoot,
      logger: { warn: (m, x) => probeLogs.push({ msg: String(m), reason: x && x.reason }), info: () => {}, error: () => {} }
    });
    const srv2 = httpRaw.createServer((rq, rs) => {
      Promise.resolve(r2.handle(rq, rs)).catch(() => { try { rs.destroy(); } catch { /* 已断 */ } });
    });
    const port2 = await new Promise(res => srv2.listen(0, '127.0.0.1', () => res(srv2.address().port)));
    const g2 = async p => {
      const r = await fetch('http://127.0.0.1:' + port2 + p);
      const t = await r.text();
      return {
        status: r.status, len: t.length,
        hasSecret: t.includes('OUTSIDE-SECRET-MARKER'),
        hasInRepoMarker: t.includes('IN-ROOT-BUT-OUTSIDE-SRC-MARKER'),
        hasOk: t.includes('W5_PROBE_OK')
      };
    };
    OUT.realpathProbe.normalFile = await g2('/src/ok.js');
    OUT.realpathProbe.escapedLink = await g2('/src/linkdir/secret.js');          // 出根（F4）
    OUT.realpathProbe.inRepoLink = await g2('/src/inrepo/tests-like.js');        // 根内、src 之外（F9）
    OUT.realpathProbe.indexMissing = await g2('/');                              // 临时根没有 index.html ⇒ 404
    OUT.realpathProbe.resolveSaysEscape = JSON.stringify(
      require(path.join(ROOT, 'server', 'http', 'site.js')).resolvePath('/src/linkdir/secret.js'));
    OUT.realpathProbe.resolveSaysInRepo = JSON.stringify(
      require(path.join(ROOT, 'server', 'http', 'site.js')).resolvePath('/src/inrepo/tests-like.js'));
    OUT.realpathProbe.reasons = probeLogs.map(x => x.reason).filter(Boolean);
    await new Promise(res => srv2.close(res));
    /* 只拆"链接本身"（rmdir），再确认目标目录仍在，最后才删临时根 */
    const rmdir = p => spawnSync('cmd', ['/c', 'rmdir', p], { stdio: 'ignore', windowsHide: true });
    rmdir(linkOut); rmdir(linkIn);
    OUT.realpathProbe.cleanup = {
      linkOutGone: !fs.existsSync(linkOut),
      linkInGone: !fs.existsSync(linkIn),
      outsideStillThere: fs.existsSync(path.join(outside, 'secret.js')),
      inRepoStillThere: fs.existsSync(path.join(inRoot, 'tests-like.js'))
    };
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    OUT.realpathProbe.note = 'junction/符号链接实验不可用：' + ((err && err.code) || (err && err.message) || String(err)) +
      '（本机 EPERM：Windows 建链接需开发者模式或管理员）—— realpath 防护为**代码级**，此路未做实验';
  }

  /* ================= ⑦c F1：客户端游标**领先服务端**不得变成静默黑洞 ================= */
  const cursorNow = await seqNow(base);
  OUT.cursorAhead = { cursorNow, probes: {} };
  let probeSeq = 0;
  for (const k of [1, 7, 999]) {
    probeSeq++;
    const s = await openStream(base, { path: '/events?since=' + (cursorNow + k) });
    streams.push(s);
    const helloText = await s.pump(250);
    /* 连上之后**立刻发一条新帧**：旧实现在这里会把新事件全滤掉（黑洞），故这是判据的核心一步 */
    OUT.frames.posts.push(await post(base, '/ifd/frame',
      frame(40 + probeSeq, '2026-09-19 10:30:0' + probeSeq)));
    const afterText = await s.pump(350);
    OUT.cursorAhead.probes[k] = {
      since: cursorNow + k, status: s.status, helloText,
      afterText, events: s.events()
    };
    await s.close();
  }
  /* F10：读**日志文件**，取"游标领先"那条留痕（验证打的是客户端原始报数） */
  OUT.cursorAhead.logLines = (() => {
    try {
      const dir = path.join(process.env.DSH_W5_DATA, 'log');
      return fs.readdirSync(dir).filter(f => f.endsWith('.log'))
        .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join('\n').split(/\r?\n/).filter(l => l.includes('游标领先'));
    } catch (err) { return ['ERR:' + ((err && err.code) || err.message)]; }
  })();

  /* ================= ⑦d E22②：testStatus 上行**不伪造**（码原样到 MES；无帧时拒发而不是编一个） =================
     为什么单列：附录 2 的 testStatus 来源＝**PC 上位机**；服务端只能**照抄最近一帧的码** ——
     既不许自造（无帧时编 0/1/2），也不许改写（把「3 设备异常」按本机「维保检修 → 0」那类规则折叠掉）。
     判据（可否证）：① 逐码 0/1/2/3 落帧 ⇒ 报文里的 testStatus 与**落库那一帧**逐个相等；
                    ② 无帧且 dataSource≠mock ⇒「NO_TEST_STATUS」**拒发**、且一条 upload_log 都不写；
                    ③「维保检修 → 0」是**本机**显示模式的反查规则（真源 fieldMap.modeToTestStatus），
                      服务端**不参与**改写 —— 所以码 3 到 MES 仍是 3（与 ① 互为对照）。 */
  OUT.e22 = { order: 'WO-W5-E22', noFrameOrder: 'WO-W5-NOF', codes: [], noFrame: {} };
  OUT.e22.task = await post(base, '/ifa/dispatch',
    { procOrderNo: OUT.e22.order, productCode: 'P-W5', processNo: '30', planQty: 5, equipCode: 'EQ-W5' });
  OUT.e22.taskNoFrame = await post(base, '/ifa/dispatch',
    { procOrderNo: OUT.e22.noFrameOrder, productCode: 'P-W5', processNo: '30', planQty: 5, equipCode: 'EQ-W5' });
  const mesCfg = Object.assign({}, boardConfig, {
    dataSource: 'server',                       /* 关键：**去掉** mock 的 0 兜底，逼出"无帧怎么办" */
    mes: Object.assign({}, boardConfig.mes, { baseUrl: 'http://127.0.0.1:9/mes' })
  });
  const e22Sends = [];
  const e22Fetch = async (url, opts) => {
    e22Sends.push({ url: String(url), body: JSON.parse(opts.body) });
    return { status: 200, text: async () => JSON.stringify({ status: 1, msg: 'ok' }) };
  };
  const repE22 = createUploadReporter({ db, now: clock.source(), fetch: e22Fetch, config: mesCfg });
  const e22LogCount = () => db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c;
  for (const [k, code] of [0, 1, 2, 3].entries()) {
    /* ⚠ collectTime 必须**早于**后面 F2 在途帧的 10:40:00：采样落库口径是"采集时刻比上一帧更新"，
       取更晚的时刻会把后面的 10:40:00 挤成 raw-500ms（本夹具实测踩过一次，F2 因此变红）。 */
    const f = frame(70 + k, '2026-09-19 10:31:0' + k);
    f.procOrderNo = OUT.e22.order;
    f.testStatus = code;
    const posted = await post(base, '/ifd/frame', f);
    const built = repE22.buildReport({ procOrderNo: OUT.e22.order });
    const stored = db.prepare(
      'SELECT test_status FROM measure_rt WHERE proc_order_no = ? ORDER BY id DESC LIMIT 1'
    ).get(OUT.e22.order);
    OUT.e22.codes.push({
      code, post: posted,
      built: built.ok ? { ok: true, testStatus: built.body.testStatus, frameId: built.frameId } : built,
      storedTestStatus: stored ? stored.test_status : null
    });
  }
  const e22LogBefore = e22LogCount();
  const e22PendingBefore = repE22.pendingCount(true);       /* 队列里可能已有别的腿留下的待补传件 */
  OUT.e22.noFrame.build = repE22.buildReport({ procOrderNo: OUT.e22.noFrameOrder });
  OUT.e22.noFrame.report = await repE22.report({ procOrderNo: OUT.e22.noFrameOrder });
  OUT.e22.noFrame.logBefore = e22LogBefore;
  OUT.e22.noFrame.logAfter = e22LogCount();
  OUT.e22.noFrame.attempts = repE22.attempts();
  OUT.e22.noFrame.pendingBefore = e22PendingBefore;
  OUT.e22.noFrame.pendingAfter = repE22.pendingCount(true);
  OUT.e22.noFrame.sourceOfTestStatus = repE22.sources().testStatus;
  OUT.e22.sends = e22Sends.length;
  OUT.e22.modeMap = (() => {                       /* 本机显示模式 → 附录 2 码的**真源**（vm 里实跑） */
    try {
      const vm = require('node:vm');
      const sb = { console };
      sb.window = sb;
      vm.createContext(sb);
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'config', 'board.config.js'), 'utf8'), sb);
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'config', 'fieldMap.js'), 'utf8'), sb);
      return Object.assign({}, sb.window.FieldMap.modeToTestStatus);
    } catch (err) { return { ERR: String((err && err.message) || err) }; }
  })();

  /* ================= ⑧ 优雅关闭 ================= */
  const sA = await openStream(base);
  streams.push(sA);
  await sA.pump(150);
  const closedCount = svc.router.closeAllStreams();
  const textA1 = await sA.pump(250);                   // 应收敛到「: bye」+ 连接结束
  const before = sA.text();
  await sA.pump(500);                                  // 5×心跳周期：不应再有任何新字节
  OUT.close = {
    closedCount, textA1, sawBye: /: bye /.test(textA1), streamDone: sA.finished(),
    afterByeBytes: sA.text().length - before.length,
    streamsAfterCloseAll: svc.router.streamCount()
  };
  await sA.close();

  /* F2：**在途 keep-alive POST + 停机**（旧实现只在 server.close() 后回收一次空闲连接，
     在途请求应答完变空闲后就再没人回收 ⇒ 只能等对端 FIN，审查实测被拖到 ~6.35 s）。
     构造：裸 socket 先送请求头 + 一半 body（服务端已开始处理 ⇒ 在途），停机窗口内补齐 body。 */
  const sB = await openStream(base);
  streams.push(sB);
  const inflightBody = Buffer.from(JSON.stringify(frame(88, '2026-09-19 10:40:00')), 'utf8');
  const postSock = net.connect(port, '127.0.0.1');
  let postResponse = '';
  let postClosedAt = null;
  postSock.setEncoding('utf8');
  postSock.on('data', c => { postResponse += c; });
  postSock.on('close', () => { postClosedAt = Date.now(); });
  await new Promise(r => postSock.on('connect', r));
  const rowsBeforeInflight = rowCount();
  postSock.write('POST /ifd/frame HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\n' +
    'Content-Type: application/json\r\nContent-Length: ' + inflightBody.length + '\r\n' +
    'Connection: keep-alive\r\n\r\n' + inflightBody.slice(0, 8).toString('utf8'));
  await sleep(60);                                     // 让服务端确实读到请求头（进入"在途"）
  const t0 = Date.now();
  OUT.close.connsBeforeStop = conns.filter(c => c.closedAt === null).length;
  /* 停机各阶段的墙钟留痕（自检用：把"到底卡在哪一步"变成可读证据） */
  const marks = [];
  const lg = entry.state.logger;
  if (lg && typeof lg.info === 'function') {
    const orig = lg.info.bind(lg);
    lg.info = (m, x) => { marks.push((Date.now() - t0) + 'ms ' + String(m).slice(0, 70)); return orig(m, x); };
  }
  const origWarn = lg && typeof lg.warn === 'function' ? lg.warn.bind(lg) : null;
  if (lg && origWarn) lg.warn = (m, x) => { marks.push((Date.now() - t0) + 'ms [warn] ' + String(m).slice(0, 70)); return origWarn(m, x); };
  /* 停机开始后再补齐 body（此时请求处于在途；停机**不得**把它打断） */
  const finishBody = setTimeout(() => { try { postSock.write(inflightBody.slice(8)); } catch { /* 已断 */ } }, 120);
  OUT.close.stopResult = await entry.stop('w5 夹具：优雅退出（含在途 keep-alive POST）');
  OUT.close.stopMs = Date.now() - t0;
  OUT.close.marks = marks;
  clearTimeout(finishBody);
  await sleep(250);                                    // 收尾读响应
  OUT.close.inflight = {
    responseStatusLine: String(postResponse).split('\r\n')[0],
    responseOutcome: ((/\"outcome\":\"([a-z0-9-]+)\"/.exec(postResponse) || [])[1]) || null,
    bodyCompletedAt: null,
    closedAfterStop: postClosedAt === null ? null : postClosedAt - t0,
    rowsBefore: rowsBeforeInflight,
    rowsAfter: (() => {
      try {                                       // 库已关：另开**只读**连接数行数（单源对账）
        const { DatabaseSync } = require('node:sqlite');
        const d2 = new DatabaseSync(process.env.DSH_W5_DB, { readOnly: true });
        const c = d2.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
        d2.close();
        return c;
      } catch (err) { return 'ERR:' + ((err && err.code) || err.message); }
    })()
  };
  OUT.close.conns = conns.map(c => ({
    openedAfterStop: c.openedAt - t0,
    closedAfterStop: c.closedAt === null ? null : c.closedAt - t0,
    urls: c.urls
  }));
  await sB.pump(300);
  OUT.close.streamB = { text: sB.text(), done: sB.finished(), sawBye: /: bye /.test(sB.text()) };
  OUT.close.afterStop = {
    streams: svc.router.streamCount(),
    serverNull: entry.state.server === null,
    dbNull: entry.state.db === null,
    busClosed: svc.bus.isClosed(),
    busSubscribers: svc.bus.stats().subscribers,
    busDropped: svc.bus.dropped(),
    linkRunning: svc.linkMonitor.running(),
    sseStatus: svc.router.sseStatus()
  };
  try { postSock.destroy(); } catch { /* 已断 */ }
  await sB.close();
  for (const s of streams) await s.close();

  OUT.done = true;
  SAVE();
})().catch(err => {
  OUT.error = String(err && err.stack ? err.stack : err);
  SAVE();
  process.exitCode = 1;
});
`;
  const W5_FIXTURE_NONLOOP = String.raw`'use strict';
/* W5-① 追加（裁定「选项 A」）：**非回环绑定**下不得回任何 CORS 头（守 NFR-25 / AC-09）。
   为什么必须另起一个夹具进程：监听地址只在「start()」时定，一个进程内改不了。 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
process.env.DSH_ENV = 'test';
const entry = require(path.join(ROOT, 'server', 'index.js'));

const OUT = {};
const SAVE = () => fs.writeFileSync(process.env.DSH_W5_RESULT, JSON.stringify(OUT, null, 1), 'utf8');

(async () => {
  const port = Number(process.env.DSH_W5_PORT);
  const base = 'http://127.0.0.1:' + port;         // 从回环侧去连（服务确实绑在 0.0.0.0）
  const svc = await entry.start({
    argv: ['--host', '0.0.0.0', '--port', String(port), '--data-dir', process.env.DSH_W5_DATA, '--db-file', process.env.DSH_W5_DB],
    installSignalHandlers: false,
    logConsole: false
  });
  const probe = async (p, opts = {}) => {
    const r = await fetch(base + p, opts);
    const text = await r.text();
    return {
      status: r.status,
      acao: r.headers.get('access-control-allow-origin'),
      acac: r.headers.get('access-control-allow-credentials'),
      len: text.length,
      text: text.slice(0, 120)
    };
  };
  OUT.listen = svc.listen;
  OUT.bind = entry.listenAddress();
  OUT.corsStatus = svc.cors.status();
  OUT.nullOrigin = await probe('/state', { headers: { Origin: 'null' } });
  OUT.loopbackOrigin = await probe('/state', { headers: { Origin: 'http://127.0.0.1:' + port } });
  OUT.evilOrigin = await probe('/state', { headers: { Origin: 'http://evil.example' } });
  OUT.preflightNull = await probe('/upload/retry', {
    method: 'OPTIONS',
    headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' }
  });
  OUT.siteRoot = await probe('/');
  OUT.stopResult = await entry.stop('w5 非回环夹具');
  SAVE();
})().catch(err => {
  OUT.error = String(err && err.stack ? err.stack : err);
  SAVE();
  process.exitCode = 1;
});
`;

  /* ============ 一、进程内事件总线（有界环形缓冲 / seq / since / 隔离 / close） ============ */
  const { createEventBus, KIND: SSE_KIND, KINDS: SSE_KINDS } = require('../server/services/eventBus');
  const busClock = createClock({ mode: 'fixed', at: '2026-09-19T10:00:00' });
  const injectedBusAt = busClock.now().toISOString();
  const busLog = { errors: [], warns: [], infos: [] };
  const busLogger = {
    error: (m, d) => busLog.errors.push([String(m), d]),
    warn: (m, d) => busLog.warns.push([String(m), d]),
    info: (m, d) => busLog.infos.push([String(m), d])
  };
  const bus = createEventBus({ capacity: 3, now: busClock.source(), logger: busLogger });
  const pHolder = { a: 1, b: '二' };
  const e1 = bus.publish(SSE_KIND.FRAME, pHolder);
  const e2 = bus.publish(SSE_KIND.FRAME, pHolder);
  const e3 = bus.publish(SSE_KIND.FRAME, pHolder);
  const e4 = bus.publish(SSE_KIND.LINK, { online: false });
  const e5 = bus.publish(SSE_KIND.TASK, { procOrderNo: 'WO-1' });
  t.check('W5：事件总线 `seq` 从 1 起、逐条 +1，且 `at` 一律取自**注入时钟**（不是裸 new Date）',
    [e1, e2, e3, e4, e5].every((e, i) => e && e.seq === i + 1 && e.at === injectedBusAt) &&
    e5.kind === SSE_KIND.TASK && e5.payload.procOrderNo === 'WO-1',
    `seq=${e1.seq}..${e5.seq} at=${e1.at}（注入=${injectedBusAt}）`);

  t.check('W5-⑦：有界环形缓冲（容量 3）溢出 ⇒ **丢最旧**且 `dropped` 如实计数（不得静默丢）',
    bus.dropped() === 2 && bus.stats().buffered === 3 && bus.stats().capacity === 3 &&
    bus.range().oldest === 3 && bus.range().newest === 5,
    `dropped=${bus.dropped()} buffered=${bus.stats().buffered} oldest=${bus.range().oldest} newest=${bus.range().newest}`);

  const subReplay = bus.subscribe(() => { /* 只验补发清单 */ }, { since: 2 });
  const subHole = bus.subscribe(() => { /* 只验补不齐 */ }, { since: 1 });
  t.check('W5-②：`subscribe(since)` 补得齐 ⇒ replay 按序不重不漏；补不齐（超出缓冲）⇒ 退回 hello 且 `missed` 如实',
    subReplay.mode === 'replay' && subReplay.replay.map(e => e.seq).join(',') === '3,4,5' &&
    subHole.mode === 'hello' && subHole.missed === 1 && subHole.replay.length === 0,
    `可补：mode=${subReplay.mode} seq=[${subReplay.replay.map(e => e.seq).join(',')}]；补不齐：mode=${subHole.mode} missed=${subHole.missed}`);
  t.check('W5-②：非法 `since`（非数字／负数／小数／空串）一律按"无 since"处理 ⇒ hello（不抛错、不 500）',
    [null, undefined, '', 'abc', '-5', '1.5', 1.5, -1, '9e9'].every(v => {
      const h = bus.subscribe(() => { /* 探针 */ }, { since: v });
      const ok = h.mode === 'hello';
      h.unsubscribe();
      return ok;
    }),
    '九种非法/缺省取值全部得到 hello 模式');
  t.check('W5：未知事件种类直接抛 `RangeError`（种类固定，防"同义名"在前后端分叉）',
    (() => {
      let threw = false;
      try { bus.publish('frame2', {}); } catch (err) { threw = err instanceof RangeError; }
      return threw && SSE_KINDS.join(',') === 'frame,link,task,standard,upload,warning';
    })(), `固定种类=${SSE_KINDS.join(',')}`);

  const order = [];
  bus.subscribe(() => { throw new Error('W5 夹具注入的订阅者错误'); }, { since: 5 });
  bus.subscribe(evt => order.push(evt.seq), { since: 5 });
  let publishThrew = false;
  let e6 = null;
  try { e6 = bus.publish(SSE_KIND.WARNING, { lv: 'warn' }); } catch { publishThrew = true; }
  t.check('W5：订阅者抛错**逐订阅者隔离**（其它订阅者照收、发布方不抛），且**不吞**（logger.error + 计数留痕）',
    publishThrew === false && e6 && e6.seq === 6 && order.join(',') === '6' &&
    bus.stats().handlerErrors === 1 && bus.stats().errors.length === 1 &&
    busLog.errors.length === 1 && /订阅者抛错/.test(busLog.errors[0][0]) &&
    busLog.errors[0][1].seq === 6 && /注入的订阅者错误/.test(busLog.errors[0][1].message),
    `handlerErrors=${bus.stats().handlerErrors} logger.error=${busLog.errors.length} 其它订阅者收到=[${order.join(',')}]`);

  const subsBeforeClose = bus.size();
  const closedCount = bus.close();
  const afterCloseEvent = bus.publish(SSE_KIND.FRAME, { i: 9 });
  t.check('W5：`close()` 清空订阅者与缓冲；关闭后 publish **不静默**（返回 null + 计数 + 日志）',
    subsBeforeClose === 4 && closedCount === subsBeforeClose && bus.size() === 0 && afterCloseEvent === null &&
    bus.stats().afterClose === 1 && bus.stats().buffered === 0 && busLog.warns.length === 1 &&
    /总线已关闭/.test(busLog.warns[0][0]),
    `关前订阅者=${subsBeforeClose} 清掉=${closedCount} 关后 size=${bus.size()} afterClose=${bus.stats().afterClose} warn=${busLog.warns.length}`);

  /* ============ 二、夹具①：真起服务跑完整 SSE 流程（含 CORS 与静态托管） ============ */
  const w5Scratch = path.join(env.paths.root, 'tests', '._verify', 'w5sse');
  fs.mkdirSync(w5Scratch, { recursive: true });
  const w5Tmp = harness.makeTempDir('w5-sse');
  /* ⚠ 夹具文件名带**本次运行的唯一标签**（pid＋时间戳）：本仓门禁允许并发跑（E19 现实），
     固定文件名会让两个 harness-check 互相覆盖/互删（实测：并发轮次里 W6 段的共享临时目录被
     另一轮删掉，直接以 ENOENT 崩在夹具中途）。只删自己写的文件，不删目录。 */
  const w5RunTag = process.pid + '-' + Date.now().toString(36);
  const w5Write = (name, text) => {
    const full = path.join(w5Scratch, name);
    fs.writeFileSync(full, text, 'utf8');
    return full;
  };
  const w5Read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  /** 原地起子进程（stdout/stderr 落文件：受限沙箱下管道会 EPERM；日志留给失败排查） */
  const w5Spawn = (script, name, extraEnv) => {
    const logFile = path.join(w5Tmp, name + '.log');
    const fd = fs.openSync(logFile, 'a');
    const proc = spawn(process.execPath, [script], {
      cwd: env.paths.root,
      env: Object.assign({}, process.env, { DSH_ENV: 'test' }, extraEnv),
      windowsHide: true,
      stdio: ['ignore', fd, fd]
    });
    let settled = null;
    proc.on('exit', (code, signal) => { settled = { code, signal }; });
    return {
      proc, logFile, exitInfo: () => settled,
      log: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
      async waitDone(ms) {
        const until = Date.now() + ms;
        while (!settled && Date.now() < until) await new Promise(r => setTimeout(r, 100));
        try { fs.closeSync(fd); } catch { /* 已关 */ }
        return settled;
      }
    };
  };

  const fSse = w5Write('fixture-sse-' + w5RunTag + '.js', W5_FIXTURE_SSE);
  const fNonLoop = w5Write('fixture-nonloopback-' + w5RunTag + '.js', W5_FIXTURE_NONLOOP);

  const w5Port = await harness.allocPort();
  const w5Data = path.join(w5Tmp, 'data-sse');
  const w5Result = path.join(w5Tmp, 'sse-result.json');
  const runSse = w5Spawn(fSse, 'fixture-sse', {
    DSH_W5_PORT: String(w5Port), DSH_W5_DATA: w5Data,
    DSH_W5_DB: path.join(w5Data, 'board.db'), DSH_W5_RESULT: w5Result
  });
  const w5Watchdog = setTimeout(() => { try { runSse.proc.kill(); } catch { /* 已退出 */ } }, 90000);
  const w5Exit = await runSse.waitDone(90000);
  clearTimeout(w5Watchdog);
  const S = w5Read(w5Result);
  if (!t.requires('W5 夹具① 能取到结果文件（sse-result.json）', Boolean(S), runSse.log().slice(-500) || '无日志')) {
    t.info('W5：夹具①未产出结果，本节相关断言按失败处理（不许把"跑不了"当通过）');
  }
  const s = S || {};
  const evts = o => (o && Array.isArray(o.events) ? o.events : []);
  const kindsOf = (o, k) => evts(o).filter(e => e.event === k);
  const idsOf = o => evts(o).map(e => e.id);

  /* ---- 判据①：建连 hello 与 GET /state 逐字节同源 ---- */
  const helloEv = evts(s.hello0).find(e => e.event === 'hello');
  t.check('W5-①：`GET /state` 200（**不是** 503 未接线）且响应体与 `hello` 事件的 data **逐字节相等**（同一构造函数产出）',
    s.state0 && s.state0.status === 200 && Boolean(helloEv) &&
    JSON.stringify(helloEv.data) === s.state0.text &&
    /^text\/event-stream/.test(String(s.hello0 && s.hello0.contentType)),
    `state0.status=${s.state0 && s.state0.status}；hello.data≡state0.body：${JSON.stringify(helloEv && helloEv.data) === s.state0.text}；` +
    `ctype=${s.hello0 && s.hello0.contentType}`);
  t.check('W5-①：`snapshot` 键集齐备（link/task/device/frame/stats/standard/upload）＋ 信封含 ok/at/seq —— W5-② 切源按此表消费',
    Boolean(s.state0 && s.state0.body && s.state0.body.snapshot) &&
    ['link', 'task', 'device', 'frame', 'stats', 'standard', 'upload'].every(k => k in s.state0.body.snapshot) &&
    s.state0.body.ok === true && typeof s.state0.body.at === 'string' && typeof s.state0.body.seq === 'number',
    `snapshot.keys=${s.state0 && s.state0.body ? Object.keys(s.state0.body.snapshot).join(',') : '(无)'}`);

  /* ---- 判据④：frame 事件数 == 采样表新增行数；500 ms 原始帧与脏帧都不发布 ---- */
  const frameEvents = kindsOf(s.frames && s.frames.stream, 'frame');
  const rowsAdded = s.frames ? s.frames.rowsAfter - s.frames.rowsBefore : -1;
  t.check('W5-④：`frame` 事件数 == 同时段 `measure_rt` **新增行数**（单一真源逐条对账：1 行 = 1 条事件）',
    rowsAdded === 1 && frameEvents.length === 1 &&
    frameEvents[0].data.collectTime === '2026-09-19 10:00:00' && frameEvents[0].data.seq === 1,
    `采样表新增 ${rowsAdded} 行，frame 事件 ${frameEvents.length} 条（collectTime=${frameEvents.map(e => e.data.collectTime).join('/')}）`);
  t.check('W5-④：**500 ms 原始帧不产生 frame 事件**（同秒异键 ⇒ raw-500ms）＋ 脏帧被拒（400）后同样不发布（负向）',
    Boolean(s.frames && s.frames.posts[1] && s.frames.posts[1].body && s.frames.posts[1].body.outcome === 'raw-500ms') &&
    Boolean(s.frames && s.frames.posts[2] && s.frames.posts[2].status === 400) &&
    frameEvents.length === 1 && frameEvents.every(e => e.data.seq === 1),
    `post1=${s.frames && s.frames.posts[1] && s.frames.posts[1].body && s.frames.posts[1].body.outcome}；` +
    `post2=${s.frames && s.frames.posts[2] && s.frames.posts[2].status}；frame 事件 seq=[${frameEvents.map(e => e.data.seq).join(',')}]`);

  /* ---- 判据③：assertInput 拒收的标准版本不发布（负向）＋ 合法录入发布（正向） ---- */
  const stdEvents = kindsOf(s.other && s.other.stream, 'standard');
  const std = (s.other && s.other.standard) || {};
  t.check('W5-③：`assertInput` 拒收的标准版本 ⇒ **0 条** standard 事件（负向）＋ 合法录入 ⇒ **恰 1 条**（正向），库内也只 1 版',
    Boolean(std.rejected && std.rejected.threw === true) && std.versions === 1 && stdEvents.length === 1 &&
    stdEvents[0].data.versionNo === 1 && stdEvents[0].data.validation === 'ok' &&
    stdEvents[0].data.productCode === 'P-W5',
    `拒收=${std.rejected && std.rejected.threw}；库内版本=${std.versions}；standard 事件=${stdEvents.length}`);

  /* ---- 判据②：断线续传（按序/不重/不漏、超缓冲退回 hello、非法 since 不 500） ---- */
  const base = s.replay ? s.replay.cursorBase : -1;
  const qIds = idsOf(s.replay && s.replay.byQuery);
  const hIds = idsOf(s.replay && s.replay.byHeader);
  t.check('W5-②：`?since=<seq>` 续传**按序、不重、不漏**（只补发 seq > since，且不发 hello），载荷与源帧逐条一致',
    JSON.stringify(qIds) === JSON.stringify([base + 1, base + 2, base + 3]) &&
    !/event: hello/.test(String(s.replay && s.replay.byQuery.text)) &&
    s.replay.byQuery.status === 200 &&
    kindsOf(s.replay.byQuery, 'frame').map(e => e.data.collectTime).join(',') === String((s.replay.expectedFrames || []).join(',')),
    `since=${base} ⇒ ids=[${qIds.join(',')}]（期望 ${[base + 1, base + 2, base + 3].join(',')}）；` +
    `collectTime=${kindsOf(s.replay.byQuery, 'frame').map(e => e.data.collectTime).join(',')}`);
  t.check('W5-②：标准 `Last-Event-ID` 头与 `?since=` **同一口径**（同样按序不重不漏、不发 hello）',
    JSON.stringify(hIds) === JSON.stringify([base + 2, base + 3]) &&
    !/event: hello/.test(String(s.replay && s.replay.byHeader.text)),
    `Last-Event-ID=${base + 1} ⇒ ids=[${hIds.join(',')}]`);
  t.check('W5-②：超出环形缓冲 ⇒ **退回 hello 快照**（不得假装补上、也不得 500；其后只允许是**新**事件）',
    (() => {
      const ov = evts(s.replay && s.replay.overflow);
      /* 首帧必须是 hello；请求的补发区间（since+1 .. 缓冲最旧-1）里一条都不许出现 ——
         那一段已被环形缓冲丢掉，只能靠快照补齐（"假装补上"就是把丢的那段编出来）。 */
      return ov.length >= 1 && ov[0].event === 'hello' &&
        Boolean(ov[0].data && ov[0].data.snapshot && ov[0].data.snapshot.frame) &&
        s.replay.overflow.status === 200 &&
        ov.slice(1).every(e => e.id > ov[0].id) &&
        !ov.slice(1).some(e => e.id <= base + 3) &&
        !/event: (frame|task|standard|upload|warning|link)/.test(String(s.replay.overflow.text).split('event: hello')[0]);
    })(),
    `since=${base + 3} ⇒ 帧序=[${evts(s.replay && s.replay.overflow).map(e => e.id + ':' + e.event).join(',')}]` +
    `（缓冲最旧 seq=${s.replay && s.replay.busStats && s.replay.busStats.oldestSeq}）`);
  t.check('W5-②：非法 `since`（非数字/负数/小数/空串）与非法 `Last-Event-ID` ⇒ 按无 since 处理（200 + hello，绝不 500）',
    ['abc', '-5', '1.5', '(空串)', 'header'].every(k => s.replay && s.replay.invalid && s.replay.invalid[k] &&
      s.replay.invalid[k].status === 200 && /event: hello/.test(s.replay.invalid[k].text)),
    Object.keys((s.replay && s.replay.invalid) || {}).map(k =>
      `${k}=${s.replay.invalid[k].status}${/event: hello/.test(s.replay.invalid[k].text) ? '/hello' : '/无hello'}`).join(' '));

  /* ---- 判据⑤：心跳注释帧条数可预测（公式 E=floor(D/H)） ---- */
  const pings = ((s.heartbeat && s.heartbeat.text) || '').match(/: ping /g) || [];
  const hbExpect = s.heartbeat ? Math.floor(s.heartbeat.windowMs / s.heartbeat.heartbeatMs) : -1;
  t.check('W5-⑤/F8：真定时器下的心跳实测**在预期带内**（H=100 ms、D=2000 ms ⇒ E=20；**条数等式**由下方"注入定时器"那条钉死，这条只给真实调度下的分布）',
    pings.length >= 5 && pings.length <= hbExpect + 2 && hbExpect === 20 && pings.length <= s.heartbeat.chunks.length + 1,
    `实测 ${pings.length} 条 / ${s.heartbeat && s.heartbeat.elapsedMs} ms（E=${hbExpect}；H=${s.heartbeat && s.heartbeat.heartbeatMs} ms）——` +
    '真实定时器在窗口边界与事件循环负载下会少 0–2 条，故这里只断言"必须是 100 ms 级而非 15 s 级"的下界与上界，' +
    '条数与"关闭时清定时器"的确定性判据在 F8 那条断言里');

  /* ---- 判据⑧：无裸时间（at 与注释帧时间戳只允许是注入时钟的两个取值） ---- */
  const allowedAt = [s.injectedAt, s.afterAdvanceAt];
  const commentStamps = (String((s.frames && s.frames.stream && s.frames.stream.text) || '') +
    String((s.heartbeat && s.heartbeat.text) || ''))
    .match(/: (?:ready|ping|bye) ([0-9T:.\-Z]+)/g);
  const stamps = (commentStamps || []).map(x => x.replace(/^: (?:ready|ping|bye) /, ''));
  t.check('W5-⑧：SSE 注释帧时间戳与 `hello`/`/state` 的 `at` **全部来自注入时钟**（固定 2026-09-19T10:00:00 ⇒ 只允许注入值或其推进值）',
    stamps.length >= 5 && stamps.every(v => allowedAt.includes(v)) &&
    Boolean(helloEv && helloEv.data && allowedAt.includes(helloEv.data.at)) &&
    Boolean(s.state0 && allowedAt.includes(s.state0.body.at)),
    `允许值=${allowedAt.join(' / ')}；注释帧样本=${[...new Set(stamps)].join(' / ')}；hello.at=${helloEv && helloEv.data && helloEv.data.at}`);

  /* ---- 六类事件全覆盖 ＋ link 双向 ＋ task/upload/warning 载荷 ---- */
  const linkEvtsAll = [].concat(kindsOf(s.frames && s.frames.stream, 'link'), kindsOf(s.link, 'link'));
  const onlineEv = linkEvtsAll.find(e => e.data && e.data.online === true);
  const offlineEv = linkEvtsAll.find(e => e.data && e.data.online === false);
  /* ⚠ F3（独立审查立案）：这里原写"六类事件全部挂在真实写入点"，**表述过强** ——
     `warning` 的唯一发布点（`judge.evaluate`）在全仓**没有生产调用方**，本夹具是**直调**它。
     故：
       · "五类来自真实写入点"由上方的 F3 断言承担（frame/link/task/standard/upload 各有写入点证据）；
       · "六类**挂钩**都可用"由下方这条承担，标题里明写 warning 的来源是夹具直调（不冒充生产链路）。 */
  t.check('W5/F3：六类事件**挂钩**都可用（frame / link / task / standard / upload 来自真实写入点；**warning 由夹具直调**）',
    ['frame', 'link', 'task', 'standard', 'upload', 'warning'].every(k =>
      [].concat(evts(s.frames && s.frames.stream), evts(s.link), evts(s.other && s.other.stream))
        .some(e => e.event === k)),
    `实收种类=${[...new Set([].concat(evts(s.frames && s.frames.stream), evts(s.link), evts(s.other && s.other.stream)).map(e => e.event))].join(',')}`);
  t.check('W5：`link` 覆盖**双向**变化（离线→在线 / 在线→离线），离线判据＝`ingest.linkState()`（推进注入时钟 6 s > upper.staleMs）',
    Boolean(onlineEv) && Boolean(offlineEv) && offlineEv.data.staleMs === 5000 && offlineEv.data.ageMs >= 5000 &&
    s.link && s.link.state && s.link.state.online === false,
    `online 事件=${Boolean(onlineEv)}；offline 事件=${JSON.stringify(offlineEv && offlineEv.data)}；快照 link=${JSON.stringify(s.link && s.link.state)}`);
  const taskEv = kindsOf(s.other && s.other.stream, 'task')[0];
  const uploadEv = kindsOf(s.other && s.other.stream, 'upload')[0];
  const warnEv = kindsOf(s.other && s.other.stream, 'warning')[0];
  t.check('W5：`task`／`upload` 载荷来自**真实写入点**（幂等命中不重发／真失败留存待补传）；`warning` 载荷形状由**夹具直调** judge 产出（生产调用方待接线 E45）',
    Boolean(taskEv) && taskEv.data.procOrderNo === 'WO-W5-9' && taskEv.data.table === 'task' &&
    kindsOf(s.other && s.other.stream, 'task').length === 1 &&
    Boolean(uploadEv) && uploadEv.data.action === 'enqueue-failed' && uploadEv.data.state === '待补传' &&
    uploadEv.data.pendingCount === 1 && Boolean(uploadEv.data.alert) &&
    Boolean(s.other && s.other.upload && s.other.upload.pendingCount === 1) &&
    Boolean(warnEv) && Array.isArray(warnEv.data.warnings) && warnEv.data.warnings.length >= 3 &&
    typeof warnEv.data.result === 'string',
    `task=${JSON.stringify(taskEv && taskEv.data)}；upload=${JSON.stringify(uploadEv && uploadEv.data && { action: uploadEv.data.action, pending: uploadEv.data.pendingCount })}；` +
    `warning（夹具直调）result=${warnEv && warnEv.data.result} warnings=${warnEv && warnEv.data.warnings && warnEv.data.warnings.length}`);

  /* ---- 判据①：snapshot 的 frame / upload 与各自真源同源 ---- */
  t.check('W5-①：`snapshot.frame` 是**最新 1 s 采样帧**（与 frame 事件同源，不是另拼一份字段）',
    Boolean(s.stateFinal && s.stateFinal.snapshot && s.stateFinal.snapshot.frame) &&
    s.stateFinal.snapshot.frame.collectTime === '2026-09-19 10:00:12' &&
    s.stateFinal.snapshot.frame.depth === 5.12 &&
    ['equipCode', 'procOrderNo', 'collectTime', 'seq', 'depth', 'speed', 'velocity_x', 'velocity_y',
      'frameRate', 'gain', 'shutter', 'cameraDepth', 'testStatus'].every(k => k in s.stateFinal.snapshot.frame),
    JSON.stringify(s.stateFinal && s.stateFinal.snapshot && s.stateFinal.snapshot.frame));
  t.check('W5-①：`snapshot.upload` 与 W4 的 `GET /upload/status` **同源**（pendingCount/capacity/warnThreshold/alert 逐项相等）',
    Boolean(s.uploadStatus && s.stateFinal && s.stateFinal.snapshot && s.stateFinal.snapshot.upload) &&
    s.uploadStatus.pendingCount === s.stateFinal.snapshot.upload.pendingCount &&
    s.uploadStatus.pendingOnly === s.stateFinal.snapshot.upload.pendingOnly &&
    s.uploadStatus.capacity === s.stateFinal.snapshot.upload.capacity &&
    s.uploadStatus.warnThreshold === s.stateFinal.snapshot.upload.warnThreshold &&
    JSON.stringify(s.uploadStatus.alert) === JSON.stringify(s.stateFinal.snapshot.upload.alert),
    `/upload/status.pending=${s.uploadStatus && s.uploadStatus.pendingCount}；snapshot.upload.pending=${s.stateFinal && s.stateFinal.snapshot && s.stateFinal.snapshot.upload && s.stateFinal.snapshot.upload.pendingCount}`);

  /* ---- 判据⑨ E22②：testStatus 上行不伪造（码原样到 MES ／ 无帧拒发 ／ 维保检修→0 只是本机反查规则） ---- */
  const e22 = s.e22 || {};
  const e22codes = e22.codes || [];
  t.check('E22②：逐码 0/1/2/3 落帧后，MES 报文里的 testStatus 与**落库那一帧**逐个相等（服务端只照抄、不折叠）',
    e22codes.length === 4 &&
    e22codes.every(c => c.post && c.post.status === 200 && c.built && c.built.ok === true &&
      c.storedTestStatus === c.code && c.built.testStatus === c.code),
    `实跑四帧：${e22codes.map(c => `落库${c.storedTestStatus}→报文${c.built && c.built.testStatus}`).join('，')}` +
    `（POST 状态码 ${e22codes.map(c => c.post && c.post.status).join('/')}）`);
  t.check('E22②：码 `3`（设备异常）**不得**被"维保检修 → 0"那类本机规则改写成 0 —— ' +
    '真源 `fieldMap.modeToTestStatus` 里「维保检修=0」与「故障锁定=3」并存，服务端不套用它',
    (e22codes.find(c => c.code === 3) || {}).built &&
    e22codes.find(c => c.code === 3).built.testStatus === 3 &&
    (e22.modeMap || {})['维保检修'] === 0 && (e22.modeMap || {})['故障锁定'] === 3,
    `码 3 的报文 testStatus=${JSON.stringify((e22codes.find(c => c.code === 3) || {}).built && e22codes.find(c => c.code === 3).built.testStatus)}；` +
    `本机反查表=${JSON.stringify(e22.modeMap)}`);
  t.check('E22②：无实测帧且 `dataSource≠mock` ⇒ `NO_TEST_STATUS` **拒发**：一次都不发、不写 upload_log、不进待补传、不落假成功',
    e22.noFrame && e22.noFrame.build && e22.noFrame.build.ok === false &&
    e22.noFrame.build.error && e22.noFrame.build.error.code === 'NO_TEST_STATUS' &&
    e22.noFrame.build.error.field === 'testStatus' &&
    e22.noFrame.report && e22.noFrame.report.ok === false && e22.noFrame.report.skipped === true &&
    e22.noFrame.attempts === 0 && e22.noFrame.logBefore === e22.noFrame.logAfter &&
    e22.noFrame.pendingBefore === e22.noFrame.pendingAfter && e22.sends === 0,
    `buildReport.ok=${e22.noFrame && e22.noFrame.build && e22.noFrame.build.ok}` +
    `／error.code=${e22.noFrame && e22.noFrame.build && e22.noFrame.build.error && e22.noFrame.build.error.code}` +
    `／尝试发送次数=${e22.noFrame && e22.noFrame.attempts}／upload_log 行数 ${e22.noFrame && e22.noFrame.logBefore}→${e22.noFrame && e22.noFrame.logAfter}` +
    `／待补传 ${e22.noFrame && e22.noFrame.pendingBefore}→${e22.noFrame && e22.noFrame.pendingAfter}／真实 fetch 调用=${e22.sends}`);
  t.check('E22②：13 字段的**取数来源**在真源里写明 `testStatus` 来自 PC 上位机、缺值口径是"不伪造运行状态"（不是注释里的一句话）',
    Boolean(e22.noFrame && e22.noFrame.sourceOfTestStatus) &&
    e22.noFrame.sourceOfTestStatus.source === 'PC上位机' &&
    /不伪造/.test(String(e22.noFrame.sourceOfTestStatus.missing || '')) &&
    /measure_rt\.test_status/.test(String(e22.noFrame.sourceOfTestStatus.table || '')),
    JSON.stringify(e22.noFrame && e22.noFrame.sourceOfTestStatus));
  t.check('E22②「维保检修 → 0」的本机反查规则在真源里**逐项**成立（待机0／测试运行1／正常停机2／维保检修0／故障锁定3；' +
    '旧实现把维保检修写 2＝"上报：测试完成"）',
    JSON.stringify(e22.modeMap) === JSON.stringify({ '待机': 0, '测试运行': 1, '正常停机': 2, '维保检修': 0, '故障锁定': 3 }),
    `vm 实跑 fieldMap.modeToTestStatus = ${JSON.stringify(e22.modeMap)}`);

  /* ---- 判据⑥：优雅关闭（在途流收尾 / 定时器清零 / stop 按时返回 / 进程自然退出码 0） ---- */
  const cl = s.close || {};
  const sseMark = ((cl.marks || []).find(x => /SSE 连接/.test(x)) || '');
  const sseMarkMs = sseMark ? Number(String(sseMark).split('ms')[0]) : -1;
  t.check('W5-⑥：`closeAllStreams()` 让每条在途流收到结束信号（`: bye`）并结束、流计数归零；其后 5×心跳周期**再无新字节**（心跳定时器已清）',
    cl.closedCount === 1 && cl.sawBye === true && cl.streamDone === true &&
    cl.afterByeBytes === 0 && cl.streamsAfterCloseAll === 0,
    `closed=${cl.closedCount} 收到bye=${cl.sawBye} 流已结束=${cl.streamDone} 之后新增字节=${cl.afterByeBytes} 流计数=${cl.streamsAfterCloseAll}`);
  t.check('W5-⑥：`stop()` **按时返回**（在途 SSE 收尾留痕 ≤1 s；总耗时 < 4 s，远低于 8 s 上限）且夹具进程**自然退出码 0**（无残留句柄）',
    Boolean(cl.stopResult) && cl.stopResult.code === 0 && cl.stopMs < 4000 && sseMarkMs >= 0 && sseMarkMs <= 1000 &&
    Boolean(w5Exit) && w5Exit.code === 0,
    `exit=${JSON.stringify(w5Exit)}；stopMs=${cl.stopMs}；收尾留痕=${sseMark || '(无)'}；在途流B收到bye=${cl.streamB && cl.streamB.sawBye}`);
  t.check('W5-⑥：stop 后**无残留**：在途流 0 / 监听已关 / 库已关 / 事件总线已关闭（订阅者 0、缓冲释放）/ 链路监控定时器已停',
    Boolean(cl.afterStop) && cl.afterStop.streams === 0 && cl.afterStop.serverNull === true &&
    cl.afterStop.dbNull === true && cl.afterStop.busClosed === true &&
    cl.afterStop.busSubscribers === 0 && cl.afterStop.linkRunning === false,
    JSON.stringify(cl.afterStop && {
      streams: cl.afterStop.streams, serverNull: cl.afterStop.serverNull, dbNull: cl.afterStop.dbNull,
      busClosed: cl.afterStop.busClosed, subscribers: cl.afterStop.busSubscribers, linkRunning: cl.afterStop.linkRunning
    }));
  t.check('W5-⑦：端到端也能验缓冲溢出——容量 8 时 `dropped = seq − capacity`，`oldestSeq = seq − capacity + 1`（如实计数）',
    Boolean(s.replay && s.replay.busStats) && s.replay.busStats.capacity === 8 &&
    s.replay.busStats.dropped === s.replay.busStats.seq - s.replay.busStats.capacity &&
    s.replay.busStats.oldestSeq === s.replay.busStats.seq - s.replay.busStats.capacity + 1,
    JSON.stringify(s.replay && s.replay.busStats));

  /* ---- 判据⑨：监听范围不变 ---- */
  t.check('W5-⑨：监听仍**只回环**（夹具实际绑定 127.0.0.1）且默认仍是 127.0.0.1:8787（本单未改端口口径）',
    /^127\.0\.0\.1:\d+$/.test(String(s.listen)) &&
    Boolean(s.config) && s.config.defaultHost === '127.0.0.1' && s.config.defaultPort === 8787,
    `listen=${s.listen}；默认=${s.config && s.config.defaultHost}:${s.config && s.config.defaultPort}`);

  /* ---- 追加（裁定「选项 A」）：CORS ---- */
  const c = s.cors || {};
  t.check('CORS①：回环绑定 + `Origin: null`（双击 index.html 的 file://）⇒ 回 `Access-Control-Allow-Origin: null`',
    Boolean(c.nullOrigin) && c.nullOrigin.acao === 'null' && c.nullOrigin.status === 200,
    `acao=${c.nullOrigin && c.nullOrigin.acao} status=${c.nullOrigin && c.nullOrigin.status}`);
  t.check('CORS②：回环源 `http://127.0.0.1:<实际端口>` 与 `http://localhost:<实际端口>` ⇒ 回显该源（端口取**实际监听端口**，不是写死 8787）',
    Boolean(c.loopbackOrigin) && c.loopbackOrigin.acao === `http://127.0.0.1:${w5Port}` &&
    c.localhostOrigin.acao === `http://localhost:${w5Port}` &&
    Boolean(c.status) && !c.status.origins.includes('http://127.0.0.1:8787'),
    `127.0.0.1 ⇒ ${c.loopbackOrigin && c.loopbackOrigin.acao}；localhost ⇒ ${c.localhostOrigin && c.localhostOrigin.acao}；白名单=${JSON.stringify(c.status && c.status.origins)}`);
  t.check('CORS③：非白名单源（`http://evil.example`、**同主机异端口**）⇒ **不回**任何 `Access-Control-Allow-Origin`；`Origin` 缺失（同源/curl）行为不变',
    Boolean(c.evilOrigin) && c.evilOrigin.acao === null && c.otherPort && c.otherPort.acao === null &&
    c.noOrigin && c.noOrigin.acao === null && c.noOrigin.status === 200,
    `evil=${c.evilOrigin && c.evilOrigin.acao}；异端口=${c.otherPort && c.otherPort.acao}；无 Origin=${c.noOrigin && c.noOrigin.acao}`);
  t.check('CORS⑤：预检 ⇒ 204 + 允许方法/允许头/Max-Age 正确，且**绝不**回 `Access-Control-Allow-Credentials`',
    Boolean(c.preflightNull) && c.preflightNull.status === 204 &&
    c.preflightNull.acao === 'null' && c.preflightNull.acam === 'GET, POST, OPTIONS' &&
    c.preflightNull.acah === 'Content-Type, Authorization' && c.preflightNull.maxAge === '600' &&
    c.preflightNull.acac === null && c.nullOrigin.acac === null,
    JSON.stringify(c.preflightNull && {
      status: c.preflightNull.status, acao: c.preflightNull.acao, methods: c.preflightNull.acam,
      headers: c.preflightNull.acah, maxAge: c.preflightNull.maxAge, credentials: c.preflightNull.acac
    }));
  t.check('CORS：非白名单源的预检 ⇒ 403 且**一个 CORS 头都不回**；未注册路径的 OPTIONS 仍走既有 404/405 口径',
    Boolean(c.preflightEvil) && c.preflightEvil.status === 403 && c.preflightEvil.acao === null &&
    c.preflightUnknown && c.preflightUnknown.status === 404 &&
    c.optionsNoOrigin && c.optionsNoOrigin.status === 405,
    `evil 预检=${c.preflightEvil && c.preflightEvil.status}/acao=${c.preflightEvil && c.preflightEvil.acao}；` +
    `未注册路径 OPTIONS=${c.preflightUnknown && c.preflightUnknown.status}；无 Origin 的 OPTIONS=${c.optionsNoOrigin && c.optionsNoOrigin.status}`);

  /* ---- 追加：非回环绑定 ⇒ 任何源都无 CORS 头（另起一个夹具进程，监听地址进程内改不了） ---- */
  const w5PortB = await harness.allocPort();
  const w5DataB = path.join(w5Tmp, 'data-nonloop');
  const w5ResultB = path.join(w5Tmp, 'nonloop-result.json');
  const runNB = w5Spawn(fNonLoop, 'fixture-nonloopback', {
    DSH_W5_PORT: String(w5PortB), DSH_W5_DATA: w5DataB,
    DSH_W5_DB: path.join(w5DataB, 'board.db'), DSH_W5_RESULT: w5ResultB
  });
  const nbWatchdog = setTimeout(() => { try { runNB.proc.kill(); } catch { /* 已退出 */ } }, 40000);
  const nbExit = await runNB.waitDone(40000);
  clearTimeout(nbWatchdog);
  const N = w5Read(w5ResultB);
  if (!t.requires('W5 夹具②（非回环绑定）能取到结果文件', Boolean(N), runNB.log().slice(-400) || '无日志')) {
    t.info('W5：夹具②未产出结果，CORS④ 断言按失败处理（不许把"跑不了"当通过）');
  }
  const n = N || {};
  t.check('CORS④：**非回环绑定**（0.0.0.0）⇒ 任何源都无 CORS 头（含 `null`）、预检 403；静态首页仍可托管（守 NFR-25/AC-09）',
    /^0\.0\.0\.0:/.test(String(n.listen)) && n.corsStatus && n.corsStatus.loopback === false &&
    n.nullOrigin && n.nullOrigin.acao === null && n.loopbackOrigin && n.loopbackOrigin.acao === null &&
    n.evilOrigin && n.evilOrigin.acao === null && n.preflightNull && n.preflightNull.acao === null &&
    n.preflightNull.status === 403 && n.siteRoot && n.siteRoot.status === 200 &&
    Boolean(nbExit) && nbExit.code === 0,
    `listen=${n.listen} loopback=${n.corsStatus && n.corsStatus.loopback}；null源 acao=${n.nullOrigin && n.nullOrigin.acao}；` +
    `预检=${n.preflightNull && n.preflightNull.status}/acao=${n.preflightNull && n.preflightNull.acao}；exit=${JSON.stringify(nbExit)}`);

  /* ---- 追加（裁定「选项 A」）：静态托管（白名单式 + 路径穿越） ---- */
  const idxText = fs.readFileSync(path.join(env.paths.root, 'index.html'), 'utf8');
  t.check('静态⑥：`GET /`（与 `/index.html`）返回**仓库根 index.html 本体**——内容与磁盘文件逐字节相等，不是只看状态码；并带 `Cache-Control: no-store`',
    Boolean(s.site && s.site.root) && s.site.root.status === 200 && s.site.root.text === idxText &&
    /text\/html/.test(String(s.site.root.contentType)) && s.site.root.cacheControl === 'no-store' &&
    s.site.indexHtml.text === idxText,
    `status=${s.site && s.site.root && s.site.root.status} 内容相等=${Boolean(s.site && s.site.root && s.site.root.text === idxText)} ` +
    `长度=${s.site && s.site.root && s.site.root.text.length}/${idxText.length} cache=${s.site && s.site.root && s.site.root.cacheControl}`);
  t.check('静态⑦：`GET /src/**` 能取到前端真实文件并按扩展名给正确 `Content-Type`（.js 含 javascript / .css / .png）',
    Boolean(s.site) && s.site.config.status === 200 && /javascript/.test(String(s.site.config.contentType)) &&
    s.site.js.status === 200 && /javascript/.test(String(s.site.js.contentType)) &&
    /text\/css/.test(String(s.site.css.contentType)) &&
    /image\/png/.test(String(s.site.png.contentType)) && s.site.png.len > 1000 &&
    s.site.config.text.includes('window.BoardConfig'),
    `board.config.js: ${s.site && s.site.config && s.site.config.status}/${s.site && s.site.config && s.site.config.contentType}；` +
    `main.js: ${s.site && s.site.js && s.site.js.status}/${s.site && s.site.js && s.site.js.contentType}；` +
    `global.css: ${s.site && s.site.css && s.site.css.contentType}；png: ${s.site && s.site.png && s.site.png.len}B`);
  /* ---- W7-C：`/favicon.ico` ⇒ 204（服务端托管是首选入口，浏览器会自动请求它） ---- */
  const fav = (s.site && s.site.favicon) || {};
  t.check('静态/W7-C①：`GET /favicon.ico` ⇒ **204 No Content**、**body 为空**、`Content-Length: 0`、`Cache-Control: no-store`（浏览器自动请求不留 network error）',
    fav.status === 204 && fav.len === 0 && fav.text === '' &&
    String(fav.contentLength) === '0' && fav.cacheControl === 'no-store',
    `status=${fav.status} body=${fav.len}B content-length=${JSON.stringify(fav.contentLength)} cache=${JSON.stringify(fav.cacheControl)} content-type=${JSON.stringify(fav.contentType)}`);
  t.check('静态/W7-C② 正对照：新增 favicon 分支**没有**把静态口顺手关掉 —— `GET /` 仍 200 且内容仍是 `index.html` 本体、`GET /src/main.js` 仍 200/javascript、`GET /src/nope.js` 仍 404',
    Boolean(s.site) && s.site.root.status === 200 && s.site.root.text === idxText &&
    s.site.js.status === 200 && /javascript/.test(String(s.site.js.contentType)) &&
    Boolean(s.site.denied && s.site.denied['/src/nope.js']) && s.site.denied['/src/nope.js'].status === 404,
    `首页=${s.site && s.site.root && s.site.root.status}（内容相等=${Boolean(s.site && s.site.root && s.site.root.text === idxText)}）；` +
    `main.js=${s.site && s.site.js && s.site.js.status}/${s.site && s.site.js && s.site.js.contentType}；` +
    `nope.js=${s.site && s.site.denied && s.site.denied['/src/nope.js'] && s.site.denied['/src/nope.js'].status}`);
  t.check('静态/W7-C③：favicon **在静态兜底层**处理，不是新注册一条路由 —— 路由清单仍 20 条；且它**不进白名单**（`resolvePath` 仍拒），而静态层计数 `served.favicon` 确实 +1（被 204 分支接住、没落 404）',
    (s.site && s.site.routesCountAfterFavicon) === 20 &&
    (s.site && s.site.faviconNotWhitelisted && s.site.faviconNotWhitelisted.ok === false) &&
    (s.site && s.site.faviconServed && s.site.faviconServed.favicon === 1),
    `路由条数=${s.site && s.site.routesCountAfterFavicon}（冻结基线 20）；resolvePath('/favicon.ico')=${JSON.stringify(s.site && s.site.faviconNotWhitelisted)}；` +
    `served=${JSON.stringify(s.site && s.site.faviconServed)}`);

  t.check('静态⑧：白名单外路径（server / tests / tools / .git / data / 项目记录 / 需求文档 / 未知路径）一律 404＋JSON 形状，且响应体**不含**被禁文件内容（按真实文件的 40 字符指纹逐条比对）',
    (() => {
      const d = (s.site && s.site.denied) || {};
      /* 指纹取自**磁盘上的真实文件**（不是手写字面量）：这样"禁文件内容没被回"是硬判据，
         也不会被 404 响应体里回显的**路径**误判（上一版用 'mock-upper' 当特征串就踩了这个坑）。 */
      const targets = ['server/index.js', 'server/http/router.js', 'tests/README.md',
        'tools/mock-upper/mock-upper.js', '.git/config', '项目记录/工作日志.md'];
      const fingerprints = targets.map(rel => {
        try {
          const text = fs.readFileSync(path.join(env.paths.root, rel), 'utf8').replace(/\s+/g, '');
          return { rel, marker: text.slice(24, 64) };
        } catch { return null; }
      }).filter(x => x && x.marker.length === 40);
      const bodies = Object.values(d).map(v => String(v.text || '').replace(/\s+/g, ''));
      const all404Json = Object.keys(d).length >= 14 &&
        Object.values(d).every(v => v.status === 404 && /application\/json/.test(String(v.contentType)));
      const noLeak = fingerprints.length >= 4 &&
        fingerprints.every(f => bodies.every(b => !b.includes(f.marker)));
      const jsonShape = Boolean(d['/no-such-endpoint']) && (() => {
        try { return JSON.parse(d['/no-such-endpoint'].text).err.code === 'NOT_FOUND'; } catch { return false; }
      })();
      const dbMagic = Boolean(d['/data/dev/board.db']) &&
        !String(d['/data/dev/board.db'].text).includes('SQLite format 3');
      return all404Json && noLeak && jsonShape && dbMagic;
    })(),
    `受访 ${Object.keys((s.site && s.site.denied) || {}).length} 条路径（全部 404+JSON）；` +
    `指纹比对条数=${['server/index.js', 'server/http/router.js', 'tests/README.md', 'tools/mock-upper/mock-upper.js', '.git/config', '项目记录/工作日志.md'].length}；` +
    `db 魔数未泄露=${!/SQLite format 3/.test(String((s.site && s.site.denied && s.site.denied['/data/dev/board.db'] || {}).text || ''))}`);
  t.check('静态⑧b：**路径穿越**（`/src/../server/index.js`、`%2e%2e%2f`、`%2E%2E`、绝对路径、反斜杠、双重编码、`%00`）一律 404 且绝不返回文件内容',
    (() => {
      const d = (s.site && s.site.denied) || {};
      const fetchCases = ['/src/../server/index.js', '/src/%2e%2e%2fserver/index.js', '/src/%2E%2E/server/index.js',
        '/%2e%2e%2fserver/index.js', '/src/config/../../../server/index.js'];
      const fetchOk = fetchCases.every(p => d[p] && d[p].status === 404 &&
        !String(d[p].text).includes('createRouter') && !String(d[p].text).includes('启动自检'));
      const raw = (s.raw) || {};
      const rawKeys = Object.keys(raw);
      const rawOk = rawKeys.length === 6 && rawKeys.every(k =>
        / 404 /.test(String(raw[k].statusLine)) && raw[k].bodyHasIndexJs === false);
      return fetchOk && rawOk;
    })(),
    `fetch 形态穿越=${(() => {
      const d = (s.site && s.site.denied) || {};
      return ['/src/../server/index.js', '/src/%2e%2e%2fserver/index.js', '/src/%2E%2E/server/index.js',
        '/%2e%2e%2fserver/index.js', '/src/config/../../../server/index.js']
        .map(p => `${p}=${d[p] && d[p].status}`).join(' ');
    })()}；裸 socket 形态=${Object.keys(s.raw || {}).map(k => `${k}=${String(s.raw[k].statusLine).split(' ')[1]}`).join(' ')}`);

  /* ============ 三、F1～F8 修复回归（独立审查 R-2026-09-28-01） ============ */

  /* F1：客户端游标**领先服务端** ⇒ 必须回 hello 且**重置投递下界**（旧实现的静默黑洞） */
  {
    /* 用一条**新总线**（上面那条已按"close() 语义"关掉了，不能拿来发事件） */
    const busAhead = createEventBus({ now: busClock.source(), capacity: 8 });
    for (let i = 0; i < 3; i++) busAhead.publish(SSE_KIND.FRAME, { i });
    const seqNowBus = busAhead.seq();
    const aheadSub = busAhead.subscribe(() => { /* 只验模式 */ }, { since: seqNowBus + 7 });
    const aheadGot = [];
    const aheadSub2 = busAhead.subscribe(evt => aheadGot.push(evt.seq), { since: seqNowBus + 999 });
    const aheadEvt = busAhead.publish(SSE_KIND.LINK, { online: true });
    t.check('W5-②/F1：客户端游标**领先服务端**（since > seq）⇒ 回 hello 且**投递下界重置为当前 seq**（旧实现：无 hello、此后新事件全被 `seq <= since` 滤掉＝静默黑洞）',
      aheadSub.mode === 'hello' && aheadSub.cursorAhead === true && aheadSub.since === seqNowBus &&
      aheadSub2.mode === 'hello' && aheadSub2.cursorAhead === true && aheadSub2.since === seqNowBus &&
      Boolean(aheadEvt) && aheadEvt.seq === seqNowBus + 1 && aheadGot.join(',') === String(aheadEvt.seq) &&
      busAhead.unsubscribe(aheadSub) === true && busAhead.unsubscribe(aheadSub2) === true &&
      busAhead.size() === 0 && busAhead.stats().buffered === 4,
      `seq=${seqNowBus}（已发 3 条）；since=${seqNowBus + 7} ⇒ mode=${aheadSub.mode}/cursorAhead=${aheadSub.cursorAhead}/subSince=${aheadSub.since}；` +
      `随后新事件 seq=${aheadEvt && aheadEvt.seq} 收到=[${aheadGot.join(',')}]；退订后订阅者=${busAhead.size()}`);
  }
  t.check('W5-②/F1：真 HTTP 上「游标领先」也不是黑洞（`?since=seq+k`，k=1/7/999 ⇒ 收到 hello **且随后新帧事件可达**）',
    [1, 7, 999].every(k => {
      const pr = s.cursorAhead && s.cursorAhead.probes ? s.cursorAhead.probes[String(k)] : null;
      if (!pr) return false;
      const ev = pr.events || [];
      return pr.status === 200 && ev.length >= 2 && ev[0].event === 'hello' && ev[0].data && ev[0].data.snapshot &&
        ev.slice(1).some(e => e.event === 'frame' && e.id > ev[0].id);
    }),
    [1, 7, 999].map(k => {
      const pr = (s.cursorAhead && s.cursorAhead.probes && s.cursorAhead.probes[String(k)]) || {};
      return `k=${k}: [${(pr.events || []).map(e => e.id + ':' + e.event).join(',')}]`;
    }).join('；') + `（服务端 seq=${s.cursorAhead && s.cursorAhead.cursorNow}）`);

  /* F2：停机窗口内的**在途 keep-alive 请求**不得被误伤，且 stop() 不得被它拖住 */
  t.check('W5-⑥/F2：停机窗口内**在途 keep-alive 请求**不被误伤（200 + outcome=stored + 采样表 +1 行）且 `stop()` ≤ 1000 ms（旧实现只回收一次空闲连接 ⇒ 被拖到 ~6.35 s）',
    Boolean(cl.inflight) && /200 OK/.test(String(cl.inflight.responseStatusLine)) &&
    cl.inflight.responseOutcome === 'stored' &&
    typeof cl.inflight.rowsAfter === 'number' && cl.inflight.rowsAfter === cl.inflight.rowsBefore + 1 &&
    cl.stopMs <= 1000,
    `响应=${cl.inflight && cl.inflight.responseStatusLine}／outcome=${cl.inflight && cl.inflight.responseOutcome}；` +
    `采样表 ${cl.inflight && cl.inflight.rowsBefore}→${cl.inflight && cl.inflight.rowsAfter}；stopMs=${cl.stopMs}；` +
    `在途连接关闭于 stop+${cl.inflight && cl.inflight.closedAfterStop} ms`);

  /* F3：如实表述 —— 前五类来自真实写入点，`warning` 是"挂钩可用、生产调用方待接线" */
  const seenKinds = [...new Set([].concat(evts(s.frames && s.frames.stream), evts(s.link), evts(s.other && s.other.stream))
    .map(e => e.event))];
  t.check('W5/F3：**五类来自真实写入点**（frame←1 s 采样落库 / link←linkState / task←派工落库 / standard←addVersion 成功路径 / upload←上报失败留存）在真 HTTP 连接上全部实测可见',
    ['frame', 'link', 'task', 'standard', 'upload'].every(k => seenKinds.includes(k)),
    `实收种类=${seenKinds.join(',')}（各类的写入点证据见上面 5 条断言）`);
  t.check('W5/F3：`warning` 仅证明**挂钩可用**——本夹具**直调** `judge.evaluate(input,{bus})`（生产发布点**待接线**：技术债 E45，负责人 2026-09-28 裁定本轮不接）',
    seenKinds.includes('warning') && Boolean(s.other && s.other.warning && s.other.warning.result),
    `warning 事件在连接上可见=${seenKinds.includes('warning')}；夹具直调 judge.evaluate(...,{bus}) 返回 result=` +
    `${s.other && s.other.warning && s.other.warning.result && s.other.warning.result.result}（**不是**生产调用方）`);

  /* F4：realpath 复核（root 之内指向 root 之外的 junction ⇒ 拒）＋ 普通文件不误伤
     F9：realpath 的**上界**必须是"被托管的那一层"（资源 ⇒ `<root>\src`，首页 ⇒ 恰好 index.html） */
  const rp = s.realpathProbe || {};
  t.check('静态/F4：静态托管对**普通文件**仍正常（realpath 复核没有误伤正常路径）',
    Boolean(rp.normalFile) && rp.normalFile.status === 200 && rp.normalFile.hasOk === true,
    JSON.stringify(rp.normalFile));
  if (rp.junctionCreated) {
    t.check('静态/F4：root 之内指向 root 之外的 **junction（目录联接）** ⇒ 404 且**不泄露**被指向文件的内容（realpath 复核可达、可被变异证伪）',
      Boolean(rp.escapedLink) && rp.escapedLink.status === 404 && rp.escapedLink.hasSecret === false &&
      /"ok":true/.test(String(rp.resolveSaysEscape)),
      `越界联接 ⇒ ${rp.escapedLink && rp.escapedLink.status}／含外部标记=${rp.escapedLink && rp.escapedLink.hasSecret}；` +
      `解析层认为路径合法（${rp.resolveSaysEscape}）⇒ 拦截确实发生在 realpath 复核`);
    t.check('静态/F9：**仓库内** junction（`src` 之内 → 根内但 `src` 之外，等价于审查实测的 `src\\x -> tests`）⇒ 404 且不泄露（上界必须是 `<root>\\src`，不是仓库根）',
      Boolean(rp.inRepoLink) && rp.inRepoLink.status === 404 && rp.inRepoLink.hasInRepoMarker === false &&
      /"ok":true/.test(String(rp.resolveSaysInRepo)) &&
      Array.isArray(rp.reasons) && rp.reasons.filter(r => r === 'OUTSIDE_SRC_REALPATH').length >= 2,
      `根内-越 src 联接 ⇒ ${rp.inRepoLink && rp.inRepoLink.status}／含被禁标记=${rp.inRepoLink && rp.inRepoLink.hasInRepoMarker}；` +
      `解析层认为路径合法（${rp.resolveSaysInRepo}）；拒收原因=${JSON.stringify(rp.reasons)}`);
    t.check('静态/F9 · 正对照：`/index.html`、`/src/main.js`、`/src/config/board.config.js` 仍 200 且与磁盘内容一致（不是把静态口一起关了）',
      Boolean(s.site && s.site.root) && s.site.root.status === 200 && s.site.root.text === idxText &&
      s.site.js.status === 200 && s.site.config.status === 200 && s.site.config.text.includes('window.BoardConfig') &&
      rp.normalFile.status === 200,
      `index ${s.site && s.site.root && s.site.root.status}（内容相等=${Boolean(s.site && s.site.root && s.site.root.text === idxText)}）；` +
      `main.js ${s.site && s.site.js && s.site.js.status}；board.config.js ${s.site && s.site.config && s.site.config.status}`);
    t.check('静态/F9 · 清理安全：junction 用 `rmdir` 拆掉后**目标目录仍在**（禁止 `fs.rmSync(recursive)` —— 那可能顺链接删到目标）',
      Boolean(rp.cleanup) && rp.cleanup.linkOutGone === true && rp.cleanup.linkInGone === true &&
      rp.cleanup.outsideStillThere === true && rp.cleanup.inRepoStillThere === true,
      JSON.stringify(rp.cleanup));
  } else {
    t.skip('静态/F4+F9：越界/根内 junction ⇒ 404 且不泄露（本机不能建链接：EPERM）',
      String(rp.note || '未做实验 —— realpath 防护为**代码级**，此路未做实验'));
  }

  /* F10：领先游标留痕必须打**客户端原始报数**（`sub.since` 已被改成投递下界，不能用它） */
  t.check('W5-②/F10：`cursorAhead` 日志里带**客户端原始报数**（`reportedSince` ＝ 请求里报的那个数）＋ 服务端当前 `seq` ＋ 改写后的 `subSince` —— 领先幅度可读',
    (() => {
      const lines = (s.cursorAhead && s.cursorAhead.logLines) || [];
      const reported = lines.map(l => (/"reportedSince":(\d+)/.exec(l) || [])[1]).filter(Boolean).map(Number);
      const wanted = [1, 7, 999].map(k => (s.cursorAhead && s.cursorAhead.cursorNow) + k);
      return lines.length >= 3 && wanted.every(v => reported.includes(v)) &&
        lines.every(l => /"seq":\d+/.test(l) && /"subSince":\d+/.test(l)) &&
        /游标领先/.test(lines[0]);
    })(),
    ((s.cursorAhead && s.cursorAhead.logLines) || []).map(l => l.replace(/^\[[^\]]+\] /, '')).join(' ｜ ').slice(0, 300));

  /* F5：新文件的换行/BOM 口径（仓库既有 73/76 为 CRLF-only） */
  t.check('文件卫生/F5：本单 4 个新文件统一 **CRLF 且无 BOM**（与仓库既有换行口径一致；BOM 仍为 false）',
    ['server/services/eventBus.js', 'server/services/stateSnapshot.js', 'server/http/cors.js', 'server/http/site.js']
      .every(f => {
        const b = fs.readFileSync(path.join(env.paths.root, f));
        if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return false;
        const txt = b.toString('utf8');
        return txt.includes('\r\n') && !/(^|[^\r])\n/.test(txt);
      }),
    '逐个读字节：4 个新文件均含 CRLF、无孤立 LF、无 BOM');

  /* F6：未注册路径**一个 CORS 头都不挂**（与"非白名单源一个头都不回"口径自洽） */
  t.check('CORS/F6：未注册路径**不挂任何 CORS 头**（`GET /no-such-path` + `Origin: null` ⇒ 404 且无 `Access-Control-Allow-Origin`），与"非白名单源一个头都不回"口径自洽',
    Boolean(c.getUnknownWithOrigin) && c.getUnknownWithOrigin.status === 404 && c.getUnknownWithOrigin.acao === null &&
    Boolean(c.preflightUnknown) && c.preflightUnknown.status === 404 && c.preflightUnknown.acao === null,
    `GET 未知路径：${c.getUnknownWithOrigin && c.getUnknownWithOrigin.status}/acao=${c.getUnknownWithOrigin && c.getUnknownWithOrigin.acao}；` +
    `OPTIONS 未知路径：${c.preflightUnknown && c.preflightUnknown.status}/acao=${c.preflightUnknown && c.preflightUnknown.acao}`);

  /* F7：规范化拼写口径（同一文件不因大小写/尾随斜杠给出两种判定） */
  t.check('静态/F7：**规范化拼写**口径自洽——`/index.HTML`≡`/index.html`（同 body 哈希）／`/index.html/`、`/src/main.js/` 一律 404／`/src/MAIN.JS`≡`/src/main.js`（本机 NTFS 不区分大小写）；`//src/main.js` **不是**首页（落到 404）',
    (() => {
      const C = s.canonical || {};
      const st = p => (C[p] || {}).status;
      const h = p => (C[p] || {}).bodyHash;
      return st('/index.html') === 200 && st('/index.HTML') === 200 && Boolean(h('/index.html')) &&
        h('/index.html') === h('/index.HTML') &&
        st('/index.html/') === 404 && st('/src/main.js/') === 404 &&
        st('/src/main.js') === 200 && st('/src/MAIN.JS') === 200 && h('/src/main.js') === h('/src/MAIN.JS') &&
        st('/src//main.js') === 404 &&
        h('//index.html') === h('/index.html') && h('/./index.html') === h('/index.html') &&
        st('//src/main.js') === 404 && h('//src/main.js') !== h('/index.html');
    })(),
    Object.keys(s.canonical || {}).map(p => `${p}=${s.canonical[p].status}${s.canonical[p].bodyHash ? '/' + s.canonical[p].bodyHash : ''}`).join(' ') +
    '（F11 更正成因：`//index.html` 之所以落回首页，是因为 `//x` 被当作**协议相对 URL** —— ' +
    '`new URL("//index.html","http://127.0.0.1")` 解析为 host=`index.html`、path=`/`，服务端收到的 pathname 就是 `/`；' +
    '`/./index.html` 才是"路径归一"（去掉 `.` 段）。两者都不是服务端给出两种判定；' +
    '`//src/main.js` 同理会变成 path=`/main.js` ⇒ 未注册路径 ⇒ 404，可作区分性对照）');

  /* F8：心跳条数**确定性**判据（注入定时器）＋ 关闭时 clearInterval 的确定性证据 */
  {
    const { createRouter: createRouterForHeartbeat } = require('../server/http/router');
    const hv = { ticks: [], cleared: [], written: [] };
    const hbClock = createClock({ mode: 'fixed', at: '2026-09-19T10:00:00' });
    const routerH = createRouterForHeartbeat({
      heartbeatMs: 100,
      now: hbClock.source(),
      setIntervalImpl: (fn, ms) => { const t = { fn, ms }; hv.ticks.push(t); return t; },
      clearIntervalImpl: t => { hv.cleared.push(t); }
    });
    const busH = createEventBus({ now: hbClock.source(), capacity: 8 });
    routerH.mountSSE({ bus: busH, snapshot: () => ({ probe: true }) });
    const resH = {
      headersSent: false, writableEnded: false, destroyed: false, socket: null,
      writeHead() { this.headersSent = true; }, setHeader() { /* 头内容不是本条判据 */ },
      write(s) { hv.written.push(String(s)); return true; },
      end() { this.writableEnded = true; },
      on() { /* 不模拟客户端断开 */ }
    };
    routerH.events({ url: '/events', method: 'GET', headers: {} }, resH);
    for (let i = 0; i < 5; i++) hv.ticks[0].fn();          // 手动驱动 5 个周期
    const pingCount = (hv.written.join('').match(/: ping /g) || []).length;
    const streamsBefore = routerH.streamCount();
    const closedN = routerH.closeAllStreams();
    t.check('W5-⑤/F8：心跳定时器**可注入** ⇒ 条数完全确定（驱动 k 次恰得 k 条 `: ping`，时间戳＝注入时钟），且 `closeAllStreams()` 真的调了 `clearInterval`（定时器清零的确定性证据）',
      hv.ticks.length === 1 && hv.ticks[0].ms === 100 && pingCount === 5 &&
      hv.written.join('').includes(': ping ' + hbClock.now().toISOString()) &&
      streamsBefore === 1 && closedN === 1 && hv.cleared.length === 1 && hv.cleared[0] === hv.ticks[0] &&
      resH.writableEnded === true && routerH.streamCount() === 0,
      `注册定时器 ${hv.ticks.length} 个（周期 ${hv.ticks[0] && hv.ticks[0].ms} ms）；驱动 5 次 ⇒ ping ${pingCount} 条；` +
      `closeAllStreams 清掉 ${hv.cleared.length} 个定时器；在途 ${streamsBefore}→${routerH.streamCount()}`);
  }

  try { fs.rmSync(w5Tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  /* 只删本节点名的**夹具文件**，不删整个 tests\._verify\w5sse\：
     该目录是同座位复核/定点变异的工作区（整目录 rm 会把别人的临时产物一并清掉）。 */
  for (const f of [fSse, fNonLoop]) { try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ } }
}

/* ---------------- 四之③ W7-A-3 DoD：mock-upper（真进程）→ 服务端 → mock-mes（真进程） ----------------
   为什么这样搭：DoD 要证明的是**三段真链路**接得上，而不是"三个模块各自单测过了"：
     · 上游：`tools/mock-upper/mock-upper.js` 作为**独立进程** `--once --push` 打服务端 `/ifd/frame`；
     · 中段：本仓真服务（`server/index.js` 的 `start()`，真 HTTP + 真 SQLite + 真采样落库）；
     · 下游：`tools/mock-mes/mock-mes.js` 作为**独立进程**收 IF-B 上报，并用自己的 `/log` 出证。
   ⚠ 一处**口径差异**必须写明（不许含糊过去）：`server/index.js` 的 `mountUpload(router, {db,logger,now,bus})`
     没有把 `config` 传下去，而 `board.config.js` 的 `mes.baseUrl` 是空串（Q-23 未答）且**不在本轮可改文件内** ——
     故"报告腿"用**同一套路由模块**（`createRouter` + 真实 `mountUpload`）在夹具内二次挂载、只把
     `mes.baseUrl` 注入成 mock-mes 的地址（这是 `mountUpload` 既有的注入出口）。下游仍是真的：
     真 HTTP POST、真 `upload_log` 落库、mock-mes 真收到并留痕。
   六条判据（E22/DoD）：①上游真进程推送 ⇒ 服务端落库一行（字段自洽）
                        ②报告组装 13 字段齐、首发打到**死端口** ⇒ 真失败入队（待补传 1 条）
                        ③注入时钟推进 **5 分钟** ⇒ 一次自动重发都没有（尝试数/日志行数/待补传/mock-mes 计数全不动）
                        ④人工 `POST /upload/retry` ⇒ 真发送成功、mock-mes 真收到 1 条、日志转"成功"、待补传归零
                        ⑤再点一次重报 ⇒ 幂等（没有可发条目、mock-mes 计数不涨）
                        ⑥全程 **零未捕获异常/零 console.error**（把"跑通了"与"带着错误跑通"分开） */
const W7_DOD_FIXTURE = String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
process.env.DSH_ENV = 'test';
const entry = require(path.join(ROOT, 'server', 'index.js'));
const { createRouter } = require(path.join(ROOT, 'server', 'http', 'router.js'));
const { mountUpload } = require(path.join(ROOT, 'server', 'http', 'routes', 'upload.js'));
const { createUploadReporter } = require(path.join(ROOT, 'server', 'services', 'uploadReporter.js'));
const boardConfig = require(path.join(ROOT, 'src', 'config', 'board.config.js'));

const OUT = { errors: [], consoleErrors: [], children: [] };
const SAVE = () => fs.writeFileSync(process.env.DSH_W7_RESULT, JSON.stringify(OUT, null, 1), 'utf8');
process.on('uncaughtException', e => { OUT.errors.push('uncaughtException: ' + String((e && e.stack) || e)); });
process.on('unhandledRejection', e => { OUT.errors.push('unhandledRejection: ' + String((e && e.stack) || e)); });
const origErr = console.error.bind(console);
console.error = function () {
  const line = Array.prototype.map.call(arguments, String).join(' ').slice(0, 300);
  OUT.consoleErrors.push(line);
  return origErr.apply(null, arguments);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MOCK_UPPER = path.join(ROOT, 'tools', 'mock-upper', 'mock-upper.js');
const MOCK_MES = path.join(ROOT, 'tools', 'mock-mes', 'mock-mes.js');
const ORDER = 'MES20260918001';        /* mock-upper 报文里写死的工单号（与 tools-check 的契约一致） */

function spawnTool(script, args, name) {
  const logFile = path.join(process.env.DSH_W7_TMP, name + '.log');
  const fd = fs.openSync(logFile, 'a');
  const proc = spawn(process.execPath, [script].concat(args), {
    cwd: ROOT, env: Object.assign({}, process.env, { DSH_ENV: 'test' }),
    windowsHide: true, stdio: ['ignore', fd, fd]
  });
  let settled = null;
  proc.on('exit', (code, signal) => { settled = { code, signal }; });
  OUT.children.push({ name, argv: [path.basename(script)].concat(args) });
  return {
    proc,
    log: () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } },
    exitInfo: () => settled,
    async waitDone(ms) {
      const until = Date.now() + ms;
      while (!settled && Date.now() < until) await sleep(100);
      try { fs.closeSync(fd); } catch { /* 已关 */ }
      return settled;
    },
    kill() { try { fs.closeSync(fd); } catch { /* 已关 */ } try { proc.kill(); } catch { /* 已退出 */ } }
  };
}

(async () => {
  const port = Number(process.env.DSH_W7_PORT);
  const mesPort = Number(process.env.DSH_W7_MES_PORT);
  const retryPort = Number(process.env.DSH_W7_RETRY_PORT);
  const base = 'http://127.0.0.1:' + port;

  /* 注入时钟（ADR-0003 D17）：DoD 的"推进 5 分钟看有没有偷偷重发"必须能确定性推进 */
  let fixedMs = Date.parse('2026-09-19T10:00:00');
  const clock = {
    now: () => new Date(fixedMs),
    source: () => () => new Date(fixedMs),
    advanceMs: ms => { fixedMs += ms; return fixedMs; }
  };

  /* ---- ① 下游先起来：mock-mes 真进程 + 清空它的接收日志 ---- */
  const mes = spawnTool(MOCK_MES, ['--port', String(mesPort)], 'mock-mes');
  OUT.mesReady = false;
  for (let i = 0; i < 80 && !OUT.mesReady; i++) {
    try { const r = await fetch('http://127.0.0.1:' + mesPort + '/health'); if (r.ok) OUT.mesReady = true; } catch (e) { /* 未就绪 */ }
    if (!OUT.mesReady) await sleep(100);
  }
  if (OUT.mesReady) await fetch('http://127.0.0.1:' + mesPort + '/log', { method: 'DELETE' });
  const mesLog = async () => {
    try { return await (await fetch('http://127.0.0.1:' + mesPort + '/log')).json(); }
    catch (e) { return { ERR: String((e && e.message) || e) }; }
  };

  /* ---- ② 中段：真服务进程内实例（真 HTTP + 真 SQLite） ---- */
  const svc = await entry.start({
    argv: ['--port', String(port), '--data-dir', process.env.DSH_W7_DATA, '--db-file', process.env.DSH_W7_DB],
    installSignalHandlers: false, logConsole: false, clock
  });
  const db = entry.state.db;
  OUT.service = { port, routes: svc.router.list(), mesBaseUrl: boardConfig.mes.baseUrl };
  const post = async (b, p, body) => {
    const r = await fetch(b + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return { status: r.status, body: j };
  };

  /* ---- ③ 派工（真路由）⇒ 报告组装需要的 task 行 ---- */
  OUT.dispatch = await post(base, '/ifa/dispatch',
    { procOrderNo: ORDER, productCode: 'P-DOD', processNo: '30', planQty: 3, equipCode: 'EQ-DOD' });

  /* ---- ④ 上游真进程：mock-upper --once --push ⇒ 服务端 /ifd/frame ---- */
  const rowsBefore = db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
  const upper = spawnTool(MOCK_UPPER, ['--once', '--equip', 'EQ-DOD', '--cycle', '160',
    '--push', base + '/ifd/frame'], 'mock-upper');
  OUT.upperExit = await upper.waitDone(20000);
  OUT.upperLog = upper.log().slice(-500);
  const rowsAfter = db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
  const fr = db.prepare('SELECT * FROM measure_rt ORDER BY id DESC LIMIT 1').get() || null;
  OUT.ingest = {
    rowsBefore, rowsAfter,
    frame: fr ? {
      equipCode: fr.equip_code, procOrderNo: fr.proc_order_no, collectTime: fr.collect_time,
      depth: fr.measure_depth, speed: fr.speed, testStatus: fr.test_status
    } : null
  };

  /* ---- ④b 端点矩阵：**正面**（每个端点一条 200）＋**逆向**（未知路径/方法不符/坏 JSON/缺字段/参数越界）
         ＋**无副作用**（被拒请求不得落库、不得发事件） ----
     为什么放在这里：服务是真的、库是真的、总线是真的 —— 逆向用例的"没留下痕迹"才有意义。 */
  const probe = async (p, opts) => {
    const r = await fetch(base + p, opts);
    let text = '';
    try { text = await r.text(); } catch (e) { text = ''; }
    let j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    return {
      status: r.status, code: (j && (j.err || j.error) && (j.err || j.error).code) || null,
      allow: r.headers.get('allow'), acao: r.headers.get('access-control-allow-origin'),
      text: text.slice(0, 100)
    };
  };
  const jsonPost = (p, body) => probe(p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body
  });
  const rowsOf = () => db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
  const logsOf = () => db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c;
  const seqOf = async () => (await (await fetch(base + '/state')).json()).seq;
  const mSeqBefore = await seqOf();
  const mRowsBefore = rowsOf();
  const mLogsBefore = logsOf();
  OUT.matrix = {
    routes: svc.router.list(),
    positive: {
      health: await probe('/health'),
      state: await probe('/state'),
      uploadStatus: await probe('/upload/status'),
      uploadPending: await probe('/upload/pending'),
      siteRoot: await probe('/'),
      staticJs: await probe('/src/main.js')
    },
    negative: {
      unknown: await probe('/no-such-path'),
      wrongMethod: await probe('/state', { method: 'DELETE' }),
      wrongMethodPost: await jsonPost('/upload/pending', {}),
      badJsonFrame: await jsonPost('/ifd/frame', '{ 这不是 JSON'),
      missingFieldFrame: await jsonPost('/ifd/frame', { equipCode: 'EQ-DOD' }),
      badJsonDispatch: await jsonPost('/ifa/dispatch', '{ 也不是 JSON'),
      limitZero: await probe('/upload/pending?limit=0'),
      badJsonRetry: await jsonPost('/upload/retry', '{ 仍然不是 JSON')
    }
  };
  OUT.matrix.sideEffects = {
    seqBefore: mSeqBefore, seqAfter: await seqOf(),
    rowsBefore: mRowsBefore, rowsAfter: rowsOf(),
    logsBefore: mLogsBefore, logsAfter: logsOf()
  };

  /* ---- ⑤ 报告腿：同一套路由模块 + 只注入 MES 地址；首发打**死端口** ⇒ 确定性失败 ---- */
  const cfg = Object.assign({}, boardConfig, {
    dataSource: 'server',
    mes: Object.assign({}, boardConfig.mes, { baseUrl: 'http://127.0.0.1:9/mes' })
  });
  const router2 = createRouter({ getHealth: () => ({ status: 1, msg: 'dod-report-face' }), now: clock.source() });
  /* ⚠ 必须**显式传 reporter**：mountUpload 的 reporter 池按 db 缓存（resolveReporter 的 pool.byDb），
     同一个 db 第二次挂载会**复用**上一次的实例（那天服务自己挂的那个读不到 MES 地址）——
     显式注入既绕开缓存、又恰好是"给这条报告腿配上 MES 地址"的既有出口。 */
  const rep2 = createUploadReporter({ db, now: clock.source(), config: cfg, logger: null });
  const up2 = mountUpload(router2, { db, now: clock.source(), config: cfg, reporter: rep2, logger: null });
  const server2 = http.createServer((req, res) => {
    Promise.resolve(router2.handle(req, res)).catch(() => { try { res.destroy(); } catch (e) { /* 已断 */ } });
  });
  await new Promise(resolve => server2.listen(retryPort, '127.0.0.1', resolve));
  const retryBase = 'http://127.0.0.1:' + retryPort;

  const built = up2.instance.buildReport({ procOrderNo: ORDER });
  OUT.report = {
    builtOk: built.ok,
    fields: built.ok ? built.fields.length : 0,
    testStatus: built.ok ? built.body.testStatus : null,
    missing: built.ok ? built.missing : null,
    collectTimeFallback: built.ok ? built.collectTimeFallback : null,
    url: up2.instance.buildUrl()
  };
  const first = await up2.instance.report({ procOrderNo: ORDER });
  OUT.report.first = {
    ok: first.ok, skipped: first.skipped === true, responseCode: first.responseCode,
    failReason: first.failReason, pendingCount: first.pendingCount, httpStatus: first.httpStatus
  };
  OUT.report.logRowsAfterFirst = db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c;
  OUT.report.firstRow = db.prepare('SELECT state, retry_count FROM upload_log ORDER BY id DESC LIMIT 1').get() || null;

  /* ---- ⑥ 时间推进 5 分钟：**任何定时器都不该因此重发**（V1.31 / C-59 / E10） ---- */
  const attemptsBefore = up2.instance.attempts();
  const logRowsBeforeWait = db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c;
  const pendingBeforeWait = up2.instance.pendingCount(true);
  clock.advanceMs(5 * 60 * 1000);
  await sleep(1500);                       /* 给 1.5 s 墙钟：有定时器的话这里就会动 */
  OUT.noAutoRetry = {
    advancedTo: new Date(fixedMs).toISOString(),
    attemptsBefore, attemptsAfter: up2.instance.attempts(),
    logRowsBefore: logRowsBeforeWait, logRowsAfter: db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c,
    pendingBefore: pendingBeforeWait, pendingAfter: up2.instance.pendingCount(true),
    mesReceived: ((await mesLog()).count === undefined ? null : (await mesLog()).count)
  };

  /* ---- ⑦ 人工一键重报（真 HTTP POST /upload/retry）：先把 MES 地址改对 ---- */
  cfg.mes.baseUrl = 'http://127.0.0.1:' + mesPort;      /* 配置是活引用（运维改地址后即可重报） */
  const r1 = await post(retryBase, '/upload/retry', {});
  const log1 = await mesLog();
  OUT.retry = {
    status: r1.status, sent: r1.body && r1.body.sent, failed: r1.body && r1.body.failed,
    requested: r1.body && r1.body.requested, remaining: r1.body && r1.body.remaining,
    mesCount: log1.count === undefined ? null : log1.count,
    mesItems: (log1.items || []).map(it => ({
      path: it.path,
      testStatus: it.payload && it.payload.testStatus,
      uploadId: it.payload && it.payload.uploadId,
      depth: it.payload && it.payload.depth
    })),
    uploadLogRows: db.prepare('SELECT COUNT(*) AS c FROM upload_log').get().c,
    lastRow: db.prepare('SELECT state, response_code, retry_count FROM upload_log ORDER BY id DESC LIMIT 1').get() || null,
    alert: r1.body && r1.body.alert
  };
  const r2 = await post(retryBase, '/upload/retry', {});   /* 再点一次：应当没有可发条目（幂等） */
  const log2 = await mesLog();
  OUT.retry2 = {
    status: r2.status, sent: r2.body && r2.body.sent, requested: r2.body && r2.body.requested,
    remaining: r2.body && r2.body.remaining, mesCount: log2.count === undefined ? null : log2.count
  };

  /* ---- ⑧ 收尾：报告面 → 服务 → 下游，逐层关掉（顺序与真实运维相反，故意的：先断"触发方"） ---- */
  await new Promise(resolve => server2.close(() => resolve()));
  OUT.stopResult = await entry.stop('w7 DoD 夹具');
  mes.kill();
  await sleep(300);
  OUT.done = true;
  SAVE();
})().catch(err => {
  OUT.error = String((err && err.stack) || err);
  SAVE();
  process.exitCode = 1;
});
`;

/* ---------------- 四之③ W7-A-3 DoD：端到端链路（真进程 mock-upper → 真服务 → 真进程 mock-mes） ---------------- */
t.section('四之③、W7-A-3 DoD：mock-upper（真进程）→ 服务端 → mock-mes（真进程）端到端');
{
  const w7Scratch = path.join(env.paths.root, 'tests', '._verify', 'w7dod');
  fs.mkdirSync(w7Scratch, { recursive: true });
  const w7Tmp = harness.makeTempDir('w7-dod');
  const w7RunTag = process.pid + '-' + Date.now().toString(36);
  const w7File = path.join(w7Scratch, 'fixture-dod-' + w7RunTag + '.js');
  fs.writeFileSync(w7File, W7_DOD_FIXTURE, 'utf8');

  const w7Port = await harness.allocPort();
  const w7MesPort = await harness.allocPort();
  const w7RetryPort = await harness.allocPort();
  const w7Data = path.join(w7Tmp, 'data-dod');
  const w7Result = path.join(w7Tmp, 'dod-result.json');
  const w7Log = path.join(w7Tmp, 'fixture-dod.log');
  const w7Fd = fs.openSync(w7Log, 'a');
  const w7Proc = spawn(process.execPath, [w7File], {
    cwd: env.paths.root,
    env: Object.assign({}, process.env, {
      DSH_ENV: 'test', DSH_W7_PORT: String(w7Port), DSH_W7_MES_PORT: String(w7MesPort),
      DSH_W7_RETRY_PORT: String(w7RetryPort), DSH_W7_DATA: w7Data,
      DSH_W7_DB: path.join(w7Data, 'board.db'), DSH_W7_TMP: w7Tmp, DSH_W7_RESULT: w7Result
    }),
    windowsHide: true,
    stdio: ['ignore', w7Fd, w7Fd]
  });
  let w7Settled = null;
  w7Proc.on('exit', (code, signal) => { w7Settled = { code, signal }; });
  const w7Watchdog = setTimeout(() => { try { w7Proc.kill(); } catch { /* 已退出 */ } }, 90000);
  const w7Until = Date.now() + 90000;
  while (!w7Settled && Date.now() < w7Until) await new Promise(r => setTimeout(r, 150));
  clearTimeout(w7Watchdog);
  try { fs.closeSync(w7Fd); } catch { /* 已关 */ }
  const w7LogText = (() => { try { return fs.readFileSync(w7Log, 'utf8'); } catch { return ''; } })();
  const D = (() => { try { return JSON.parse(fs.readFileSync(w7Result, 'utf8')); } catch { return null; } })();
  if (!t.requires('W7 DoD 夹具能取到结果文件（dod-result.json）', Boolean(D), w7LogText.slice(-500) || '无日志')) {
    t.info('W7 DoD：夹具未产出结果，本节断言按失败处理（不许把"跑不了"当通过）');
  }
  const d = D || {};
  const dUpper = (d.ingest || {});
  const dFrame = dUpper.frame || {};

  /* ---- 判据①：上游真进程 → 服务端落库 ---- */
  t.check('DoD①：`tools/mock-upper` **独立进程** `--once --push` ⇒ 服务端 `/ifd/frame` **落库一行**（字段与推送报文同源：设备号/工单号/深度量程/首帧 testStatus=0）',
    d.upperExit && d.upperExit.code === 0 && /HTTP 200/.test(String(d.upperLog || '')) &&
    dUpper.rowsAfter === dUpper.rowsBefore + 1 &&
    dFrame.equipCode === 'EQ-DOD' && dFrame.procOrderNo === 'MES20260918001' &&
    dFrame.testStatus === 0 && Number(dFrame.depth) >= 4.7 && Number(dFrame.depth) <= 5.4 &&
    Number(dFrame.speed) > 0,
    `上游退出码=${d.upperExit && d.upperExit.code}（stdout 末段=${String(d.upperLog || '').replace(/\s+/g, ' ').slice(-120)}）；` +
    `measure_rt 行数 ${dUpper.rowsBefore}→${dUpper.rowsAfter}；落库帧=${JSON.stringify(dFrame)}`);

  /* ---- 判据②：报告组装 + 首发失败入队（真 upload_log） ---- */
  t.check('DoD②：报告组装 13 字段齐、`testStatus` 取自**刚落库的那一帧**（=0，不伪造）；首发打到死端口 ⇒ 真失败、`upload_log` 落"待补传"、待补传 1 条',
    d.report && d.report.builtOk === true && d.report.fields === 13 && d.report.testStatus === 0 &&
    d.report.first && d.report.first.ok === false && d.report.first.skipped !== true &&
    d.report.first.pendingCount === 1 && d.report.logRowsAfterFirst === 1 &&
    d.report.firstRow && d.report.firstRow.state === '待补传',
    `组装的 testStatus=${d.report && d.report.testStatus}（13 字段=${d.report && d.report.fields}）；` +
    `首发 ok=${d.report && d.report.first && d.report.first.ok}／原因=${d.report && d.report.first && d.report.first.failReason}；` +
    `upload_log 行数=${d.report && d.report.logRowsAfterFirst}／末行=${JSON.stringify(d.report && d.report.firstRow)}`);

  /* ---- 判据③：时间推进 5 分钟 ⇒ 零自动重发 ---- */
  t.check('DoD③：注入时钟推进 **5 分钟** ⇒ **没有任何自动重发**（尝试次数/`upload_log` 行数/待补传条数/mock-mes 收到条数 四项全不动）',
    d.noAutoRetry && d.noAutoRetry.attemptsAfter === d.noAutoRetry.attemptsBefore &&
    d.noAutoRetry.logRowsAfter === d.noAutoRetry.logRowsBefore &&
    d.noAutoRetry.pendingAfter === d.noAutoRetry.pendingBefore && d.noAutoRetry.pendingAfter === 1 &&
    d.noAutoRetry.mesReceived === 0,
    `时钟推进到 ${d.noAutoRetry && d.noAutoRetry.advancedTo}；尝试 ${d.noAutoRetry && d.noAutoRetry.attemptsBefore}→${d.noAutoRetry && d.noAutoRetry.attemptsAfter}；` +
    `upload_log ${d.noAutoRetry && d.noAutoRetry.logRowsBefore}→${d.noAutoRetry && d.noAutoRetry.logRowsAfter}；` +
    `待补传 ${d.noAutoRetry && d.noAutoRetry.pendingBefore}→${d.noAutoRetry && d.noAutoRetry.pendingAfter}；mock-mes 收到=${d.noAutoRetry && d.noAutoRetry.mesReceived}`);

  /* ---- 判据④：人工一键重报（真 HTTP）⇒ 真发送成功 ---- */
  t.check('DoD④：人工 `POST /upload/retry`（真 HTTP）⇒ 200 + `sent=1`，**mock-mes 真进程收到 1 条**（其 `/log` 出证：路径/uploadId/testStatus 都在），`upload_log` **同一行**由"待补传"迁到"成功"、待补传归零',
    d.retry && d.retry.status === 200 && d.retry.sent === 1 && d.retry.failed === 0 &&
    d.retry.requested === 1 && d.retry.remaining === 0 && d.retry.mesCount === 1 &&
    d.retry.uploadLogRows === 1 && d.retry.lastRow && d.retry.lastRow.state === '成功' &&
    d.retry.mesItems && d.retry.mesItems.length === 1 && d.retry.mesItems[0].testStatus === 0 &&
    d.retry.mesItems[0].path === '/service/report/receiveReport' &&
    typeof d.retry.mesItems[0].uploadId === 'string' && Number(d.retry.mesItems[0].depth) >= 4.7,
    `HTTP ${d.retry && d.retry.status} requested/sent/failed/remaining=${d.retry && d.retry.requested}/${d.retry && d.retry.sent}/${d.retry && d.retry.failed}/${d.retry && d.retry.remaining}；` +
    `mock-mes /log count=${d.retry && d.retry.mesCount} items=${JSON.stringify(d.retry && d.retry.mesItems)}；` +
    `upload_log 末行=${JSON.stringify(d.retry && d.retry.lastRow)}`);

  /* ---- 判据⑤：幂等（再点一次不重复发） ---- */
  t.check('DoD⑤：**再点一次**重报 ⇒ 幂等：没有可发条目（`requested=0`/`sent=0`），mock-mes 计数**不涨**（不重复上报同一帧）',
    d.retry2 && d.retry2.status === 200 && d.retry2.sent === 0 && d.retry2.requested === 0 &&
    d.retry2.remaining === 0 && d.retry2.mesCount === 1,
    `第二次：HTTP ${d.retry2 && d.retry2.status} requested/sent/remaining=${d.retry2 && d.retry2.requested}/${d.retry2 && d.retry2.sent}/${d.retry2 && d.retry2.remaining}；mock-mes count=${d.retry2 && d.retry2.mesCount}`);

  /* ---- 判据⑥：全程零未捕获异常 / 零 console.error ---- */
  t.check('DoD⑥：整条链路**零未捕获异常、零 `console.error`**（"跑通了"与"带着错误跑通"分开记），且夹具正常退出',
    Array.isArray(d.errors) && d.errors.length === 0 &&
    Array.isArray(d.consoleErrors) && d.consoleErrors.length === 0 &&
    w7Settled && w7Settled.code === 0 && d.done === true,
    `未捕获异常=${JSON.stringify(d.errors || [])}；console.error=${JSON.stringify(d.consoleErrors || [])}；` +
    `夹具退出码=${w7Settled && w7Settled.code}${d.error ? '；夹具内异常：' + String(d.error).slice(0, 300) : ''}`);

  /* ---- 判据⑦ §1：端点矩阵（正面 / 逆向 / 无副作用 / 清单冻结） ---- */
  const mx = d.matrix || {};
  const pos = mx.positive || {};
  const neg = mx.negative || {};
  const side = mx.sideEffects || {};
  const posNames = { health: 200, state: 200, uploadStatus: 200, uploadPending: 200, siteRoot: 200, staticJs: 200 };
  t.check('§1 endpoint 矩阵①：现有端点的**正面**用例逐条 200（/health、/state、/upload/status、/upload/pending、站点首页、/src/main.js 静态件）',
    Object.keys(posNames).every(k => pos[k] && pos[k].status === posNames[k]),
    Object.keys(posNames).map(k => `${k}=${pos[k] && pos[k].status}`).join('，'));
  const negExpect = {
    unknown: [404, 'NOT_FOUND'], wrongMethod: [405, 'METHOD_NOT_ALLOWED'], wrongMethodPost: [405, 'METHOD_NOT_ALLOWED'],
    badJsonFrame: [400, 'BAD_JSON'], badJsonDispatch: [400, 'BAD_JSON'], badJsonRetry: [400, 'BAD_JSON'],
    missingFieldFrame: [400, null], limitZero: [400, 'BAD_VALUE']
  };
  const negBad = Object.keys(negExpect).filter(k => {
    const want = negExpect[k];
    const got = neg[k] || {};
    return got.status !== want[0] || (want[1] !== null && got.code !== want[1]);
  });
  t.check('§1 endpoint 矩阵②：**逆向**用例逐条落在文档口径上（未知路径 404 NOT_FOUND／方法不符 405 METHOD_NOT_ALLOWED＋Allow／坏 JSON 400 BAD_JSON／缺必填字段 400／参数越界 400 BAD_VALUE）',
    negBad.length === 0 && /GET/.test(String((neg.wrongMethod && neg.wrongMethod.allow) || '')),
    (negBad.length ? `**不一致**：${negBad.map(k => k + ' 期望 ' + JSON.stringify(negExpect[k]) + ' 实得 ' + JSON.stringify(neg[k])).join('；')}；` : '') +
    Object.keys(neg).map(k => `${k}=${neg[k] && neg[k].status}${neg[k] && neg[k].code ? '/' + neg[k].code : ''}`).join('，') +
    `；405 的 Allow=${JSON.stringify(neg.wrongMethod && neg.wrongMethod.allow)}`);
  t.check('§1 endpoint 矩阵③：被拒请求**无副作用** —— 8 条逆向用例跑完后 `measure_rt`/`upload_log` 行数与总线 `seq` **一个都没动**（不落库、不发事件）',
    side.rowsAfter === side.rowsBefore && side.logsAfter === side.logsBefore &&
    side.seqAfter === side.seqBefore,
    `measure_rt ${side.rowsBefore}→${side.rowsAfter}；upload_log ${side.logsBefore}→${side.logsAfter}；总线 seq ${side.seqBefore}→${side.seqAfter}`);
  t.check('§1 endpoint 矩阵④：路由清单与**冻结基线**逐条一致（本项目阶段一暴露的端点集合；增/删端点即红 —— 矩阵③的"无副作用"才有对象）',
    JSON.stringify(mx.routes) === JSON.stringify([
      'GET /auth/status', 'GET /events', 'GET /health', 'GET /ifa/status', 'GET /ifd/health', 'GET /ifd/status',
      'GET /state', 'GET /upload/last', 'GET /upload/pending', 'GET /upload/status',
      'POST /auth/change', 'POST /auth/init', 'POST /auth/login', 'POST /auth/logout',
      'POST /ifa/device', 'POST /ifa/dispatch', 'POST /ifa/material', 'POST /ifa/process',
      'POST /ifd/frame', 'POST /upload/retry'
    ]),
    `实际清单=${JSON.stringify(mx.routes)}`);

  try { fs.rmSync(w7Tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(w7File, { force: true }); } catch { /* 忽略 */ }
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
  /* 集合口径与实现**同源**（E50，2026-09-28）：权威区覆盖**全部** suite（含浏览器/长跑脚本），
     故这里造账也必须造满全量 —— 只造 `!needBrowser` 的子集会让下面每条断言都退化成
     "未跑全 ⇒ skipped"，从而**静默失去**"真会拦住漂移"的证明力。 */
  const allSuites3 = runAll3.SUITES.map(s => s.name);
  const mkR = (name, passed, failed) => ({ suite: { name, needBrowser: false },
    status: failed ? 'failed' : 'passed', summary: { passed, failed, skipped: 0 } });
  const resultsOf = (docsFailed) => {
    const base = { 'contract-check': 58, 'ui-check': 40, 'tools-check': 24, 'files-check': 11,
      'harness-check': 73, 'logic-check': 52, 'db-check': 46, 'platform-check': 21,
      'trace-check': 4, 'copy-check': 22, 'screenshot-diff': 24, 'docs-cross-check': 53,
      'browser-check': 33, 'overlap-check': 27, 'stress-check': 11 };
    return allSuites3.map(n => n === 'docs-check'
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

    /* ⑤ "未执行比对"的两个分支必须写明原因与涉及脚本名（P3-6 的另一半：跳过必须显式）
       ⚠ 集合口径（E50，2026-09-28 修）：**权威区覆盖的是全部 suite**（含浏览器/长跑脚本 ——
       它们在 `tests\README.md` 第三节被逐条登记），故"这轮跑全了没有"必须对**全量**判定；
       此前这里与 `run-all` 的实现都用 `!needBrowser` 当全集 ⇒ `--fast`（过滤 slow ＋
       needBrowser）下"缺脚本"检测不到，拿**全量**权威值去比**子集**实跑值，**误报
       "权威数字已漂移"**（现场离线体检报告第六节就是这么出现假红的）。夹具与实现必须同源，
       故一并改；E50 定点回归见本段末尾。 */
    const allSuites4 = runAll4.SUITES.map(s => s.name);
    const fullRun = (overrides) => allSuites4.map(n => overrides[n] || row(n, 'passed', 0, ''));
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

    /* E50 定点回归（2026-09-28）：`--fast` 的子集形态必须落 `skipped`，**不得**判"权威数字已漂移"。
       构造方式与 runner 的 `--fast` 完全同源：`SUITES.filter(s => !s.slow && !s.needBrowser)`。 */
    const fastSuites = runAll4.SUITES.filter(s => !s.slow && !s.needBrowser).map(s => s.name);
    const fastMissing = allSuites4.filter(n => !fastSuites.includes(n));
    const fast = runAll4.verifyAuthorityTotals({ passed: 1 }, fastSuites.map(n => row(n, 'passed', 0, '')));
    t.check('E50 定点回归：`run-all --fast` 的子集（slow ＋ needBrowser 未跑）⇒ `kind=skipped`、`ok=true`，' +
      '且详情**点名**被跳过的脚本（判"漂移"即为回潮）',
      fast.ok === true && fast.kind === 'skipped' && /未执行/.test(fast.detail) &&
      fastMissing.length === 3 && fastMissing.every(n => fast.detail.includes(n)),
      `fast 缺失集=${JSON.stringify(fastMissing)}（期望 3 个）；实得 ok=${fast.ok}、kind=${fast.kind}；` +
      `detail=${fast.detail}`);

    /* E55 定点回归（2026-09-29）：**没有 git 的机器不得判"权威数字漂移"** —— 目标机可能没装 git，
       `harness-check` 少 2 条（依赖提交历史）、`docs-check` 的失败数也不同 ⇒ 合计与权威区**结构性不可比**。
       旧行为会报"权威数字已漂移，请同步 tests\README.md 第三节"（现场 2026-09-29 实测的**假红**）。 */
    const noGit = runAll4.verifyAuthorityTotals({ passed: 1 }, fullRun({}), { gitAvailable: false });
    t.check('E55 定点回归：本机无 git ⇒ `kind=skipped`、`ok=true`，详情写明"不可比／这不是漂移"（判 `mismatch` 即回潮）',
      noGit.ok === true && noGit.kind === 'skipped' && /不可比/.test(noGit.detail) && /这不是/.test(noGit.detail),
      `实得 ok=${noGit.ok}、kind=${noGit.kind}；detail=${noGit.detail}`);
    const withGit = runAll4.verifyAuthorityTotals({ passed: 1 }, fullRun({}), { gitAvailable: true });
    t.check('E55 正对照：**有** git 时照旧走到比对（新分支不得把正常路径一并吞掉）',
      withGit.kind === 'mismatch', `实得 kind=${withGit.kind}`);

    /* 静态守卫：两处新实现的**在场证明**（E54 的 Edge 版本断言、E55 的 docs-cross-check 环境跳过）——
       防"下一轮改动把它悄悄回退掉而没人发现"。 */
    const preflightSrc = fs.readFileSync(path.join(env.paths.tests, 'preflight.js'), 'utf8');
    const dccSrc = fs.readFileSync(path.join(env.paths.tests, 'docs-cross-check.js'), 'utf8');
    t.check('静态：`preflight` 含"Edge 主版本 ≥ 112"断言（E54）且 `docs-cross-check` 含"无 git 环境跳过"处理（E55）',
      /Edge 主版本 ≥ 112/.test(preflightSrc) && /GIT_DEPENDENT/.test(dccSrc) && /环境跳过（本机无 git）/.test(dccSrc),
      `preflight 命中=${/Edge 主版本 ≥ 112/.test(preflightSrc)}；docs-cross-check 命中=${/GIT_DEPENDENT/.test(dccSrc)}／${/环境跳过（本机无 git）/.test(dccSrc)}`);

  }
}
/* ---------------- 十二、"工作区稳定性"判定的真值表（2026-09-20 新增） ----------------
   立案原因：门禁最怕的**不是**失败，而是"**被测文件正在被别的进程写**"——那时读到的半写内容
   会被当成"代码坏了"。本会话已实际发生多起：`docs-cross-check` 报"files-check 实跑未产出可解析的
   汇总行"（该脚本正被并发写）、同一份 README 下 `harness-check` 的账本值在 94/92 之间翻面、
   变体被并发覆盖导致"计数在两次运行间翻面"，主代理据此误判子代理越界。
   判据：一轮运行内工作区被改写 ⇒ 该轮结论不得当作证据（横幅 + 跳过权威比对 + 非 0 退出）。

   本节只对**纯函数**做真值表（`snapshot.diffSnapshots` / `snapshot.isExcluded`），
   不依赖"真有人并发写我的仓库"这种不可复现的条件；`run-all` 侧的可达性与调用顺序在第十三节。 */
t.section('十二、工作区稳定性判定的真值表（运行期间被改写 ⇒ 本轮结论不可作证据）');
{
  const m = pairs => Object.fromEntries(pairs);
  const A = m([['src/a.js', 'h1'], ['src/b.js', 'h2'], ['tests/x-check.js', 'h3']]);

  {
    const got = snapshot.diffSnapshots({ files: A }, { files: m([['src/a.js', 'h1'], ['src/b.js', 'H2'], ['tests/x-check.js', 'h3']]) });
    t.check('内容变化被识别（kind=changed，且带上两轮哈希）',
      got.length === 1 && got[0].path === 'src/b.js' && got[0].kind === 'changed' &&
      got[0].before === 'h2' && got[0].after === 'H2', JSON.stringify(got));
  }
  {
    const got = snapshot.diffSnapshots({ files: A }, { files: m([['src/a.js', 'h1'], ['src/b.js', 'h2'], ['tests/x-check.js', 'h3'], ['tests/n.yml', 'hY']]) });
    t.check('新增文件被识别（kind=added，before=null）',
      got.length === 1 && got[0].path === 'tests/n.yml' && got[0].kind === 'added' && got[0].before === null,
      JSON.stringify(got));
  }
  {
    const got = snapshot.diffSnapshots({ files: A }, { files: m([['src/a.js', 'h1'], ['src/b.js', 'h2']]) });
    t.check('删除文件被识别（kind=removed，after=null）',
      got.length === 1 && got[0].path === 'tests/x-check.js' && got[0].kind === 'removed' && got[0].after === null,
      JSON.stringify(got));
  }
  {
    const got = snapshot.diffSnapshots({ files: A }, { files: { ...A } });
    t.check('稳定态返回空清单（**不是**"有变化但没打印"）', Array.isArray(got) && got.length === 0, JSON.stringify(got));
  }
  t.check('空清单边界：两份都空 → 空；空 → 有内容仍判**新增**（不许因"基线为空"就放行）',
    snapshot.diffSnapshots({ files: {} }, { files: {} }).length === 0 &&
    snapshot.diffSnapshots({ files: {} }, { files: m([['a.js', 'h']]) }).length === 1,
    '空清单不能当成"没有变化"的挡箭牌');
  t.check('缺失条目的边界：null/undefined/无 files 字段一律返回 []（**不抛错**），且不误报差异',
    snapshot.diffSnapshots(null, null).length === 0 &&
    snapshot.diffSnapshots(undefined, { files: A }).length === 0 &&
    snapshot.diffSnapshots({ files: A }, undefined).length === 0 &&
    snapshot.diffSnapshots({}, { files: {} }).length === 0 &&
    snapshot.diffSnapshots({ files: A }, { files: A }).length === 0,
    '入参缺失＝拿不到证据，由调用方另行处理（门禁里按"快照不可用"处理，不当成稳定）');
  t.check('多种改写同时发生时全部列出，且按路径排序（判据必须可复现，不能靠遍历顺序）',
    (() => {
      const got = snapshot.diffSnapshots({ files: A },
        { files: m([['src/a.js', 'H1'], ['src/c.js', 'h4'], ['tests/x-check.js', 'h3']]) });
      const paths = got.map(c => c.path);
      return got.length === 3 && paths.join('|') === 'src/a.js|src/b.js|src/c.js' &&
        JSON.stringify(paths) === JSON.stringify([...paths].sort());
    })(),
    'a 改内容 / b 被删 / c 新增 —— 三条都要在，且顺序稳定');
  t.check('路径统一为 posix 风格（跨平台清单可比、可打印；Windows 下 `path.relative` 会给反斜杠）',
    (() => {
      const r = snapshot.collectSnapshot();
      return Object.keys(r.files).every(p => !p.includes('\\')) && snapshot.toPosix('a\\b\\c.js') === 'a/b/c.js';
    })(), '');

  /* 排除规则：`tests\._verify\` 是本机制自己的落盘点（各脚本日志、账本、临时库），
     **必然**在运行期间被写；不排除则每轮都"不稳定"（D22 定点变异见下一条）。 */
  t.check('排除规则：`._verify` 路径段被排除（含运 runners 的 run-all 日志与账本），其它目录不误伤',
    snapshot.isExcluded('tests/._verify/run-all/x.log') &&
    snapshot.isExcluded('tests/._verify/run-totals.json') &&
    snapshot.isExcluded('tests/._verify/tmp/db/test.db') &&
    !snapshot.isExcluded('tests/README.md') &&
    !snapshot.isExcluded('src/x._verify.js') &&
    !snapshot.isExcluded('tests/foo/._verifyish/a.js'),
    '按**路径段**比较；`x._verify.js` 这类前缀不得误伤');
  {
    /* 真扫一遍（对临时目录采样，不动仓库）：`._verify` 下的改写必须看不见，`src/` 下的改写必须看见。
       为什么采样而不是扫真仓：本节断言的是"扫描器的过滤行为"，用临时目录既能证明行为，
       又不会因为"真仓里恰好写了什么"而红。 */
    const root = harness.makeTempDir('stability-scan');
    const put = (rel, text) => {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
    };
    put(path.join('src', 'a.js'), 'const a = 1;\n');
    put(path.join('server', 'b.sql'), 'select 1;\n');
    put(path.join('tests', '._verify', 'run-all', 'a.log'), 'x\n');
    put(path.join('tests', '._verify', 'run-totals.json'), '{}\n');
    put(path.join('src', 'assets', 'shot.png'), 'not-really-png\n');
    put(path.join('tests', 'screenshots-baseline', 'x.png'), 'not-really-png\n');
    const listed = () => {
      const snap = snapshot.collectSnapshot({ root });
      return Object.keys(snap.files).sort();
    };
    const beforeList = listed();
    put(path.join('tests', '._verify', 'run-all', 'a.log'), 'x changed\n');
    put(path.join('tests', '._verify', 'run-totals.json'), '{"changed":1}\n');
    const afterVerifyWrite = listed();
    const verifyInvisible = JSON.stringify(beforeList) === JSON.stringify(afterVerifyWrite);
    put(path.join('src', 'a.js'), 'const a = 2;\n');
    const afterSrcWrite = listed();
    const diff = snapshot.diffSnapshots(
      snapshot.collectSnapshot({ root: root, dirs: snapshot.PROJECT_DIRS }),
      { files: Object.fromEntries(afterSrcWrite.map(p => [p, 'x'])) });
    t.check('零误伤（真扫）：`._verify` 下的落盘（脚本日志与账本）**不**计入清单',
      verifyInvisible && !beforeList.some(p => p.includes('._verify')),
      `扫描器给出 ${beforeList.length} 个文件：${beforeList.join('、')}`);
    t.check('真扫：`src/` 下的内容改写会被清单看见（不是只扫不比对）；非文本文件（png）不入清单',
      diff.some(c => c.path === 'src/a.js') &&
      !beforeList.some(p => p.endsWith('.png')),
      `清单含 ${beforeList.filter(p => p.startsWith('src/')).join('、')}`);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  t.check('`describeChange` 的中文标签与 kind 一一对应（不稳定横幅直接复用它，不另写一份）',
    ['added', 'removed', 'changed'].every(k => /新增|删除|内容变化/.test(snapshot.describeChange({ path: 'a.js', kind: k }))) &&
    snapshot.describeChange({ path: 'a.js', kind: 'changed' }) === 'a.js（内容变化）',
    snapshot.describeChange({ path: 'a.js', kind: 'changed' }));

  t.check('快照自身可采（`collected === true`）且哈希取的是 SHA-256（64 位十六进制）',
    (() => {
      const snap = snapshot.collectSnapshot();
      const keys = Object.keys(snap.files);
      return snap.collected === true && keys.length > 0 &&
        keys.every(k => /^[0-9a-f]{64}$/.test(snap.files[k])) &&
        keys.every(k => snapshot.isTextFile(k)) &&
        keys.every(k => !snapshot.isExcluded(k));
    })(),
    (() => { const s = snapshot.collectSnapshot(); return `${Object.keys(s.files).length} 个文本文件；` +
      `root=${s.root}`; })());
  t.check('本机清单只覆盖约定的四棵树，且不含 `._verify` / 二进制（判据范围可复核）',
    (() => {
      const keys = Object.keys(snapshot.collectSnapshot().files);
      return keys.length > 0 &&
        keys.every(k => snapshot.PROJECT_DIRS.some(d => k.startsWith(d + '/'))) &&
        keys.every(k => snapshot.isTextFile(k) && !snapshot.isExcluded(k));
    })(),
    `范围：${snapshot.PROJECT_DIRS.join('、')}（共 ${Object.keys(snapshot.collectSnapshot().files).length} 个文本文件）`);
}

/* ---------------- 十三、稳定性判据与"跳过对账"的 runner 契约（含 D22 定点变异） ----------------
   第十二节证明"判定算得对"，本节证明"runner 真的按它办"：横幅、跳过权威比对、退出码、
   以及**调用顺序**（先复核稳定性，再对账）。D22：一条声称能挡住旧缺陷的断言，
   用**旧写法**跑也必须被挡下 —— 否则它就是恒真的装饰。 */
t.section('十三、稳定性判据与"跳过对账"的 runner 契约');
{
  const runAll5 = require('./run-all');
  const runAllSrc5 = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
  const authOk = { ok: true, kind: 'ok', detail: '权威区合计 1 ＝ 本轮实跑 1' };

  const unstableV = runAll5.resolveGateOutcome([{ path: 'src/a.js', kind: 'changed' }], authOk);
  t.check('不稳定 ⇒ 退出码非 0、标记 unstable、横幅含约定横幅头与"不可作为证据"',
    unstableV.exitCode !== 0 && unstableV.unstable === true &&
    unstableV.detail.includes('本轮运行期间工作区被改写（1 个文件）') &&
    unstableV.detail.includes('src/a.js') &&
    unstableV.evidence.includes('不可作为证据'),
    unstableV.detail);
  t.check('不稳定 ⇒ 证据标签写明"未与权威数字比对"（即使权威值当时是"对得上"）',
    /未与权威数字比对/.test(unstableV.evidence), unstableV.evidence);
  t.check('稳定 + 权威对账成功 ⇒ 退出码 0，且证据标签写明"权威数字已核对"',
    (() => {
      const v = runAll5.resolveGateOutcome([], authOk);
      return v.exitCode === 0 && v.unstable === false && v.titles.length === 0 &&
        /权威数字已核对/.test(v.evidence);
    })(), runAll5.resolveGateOutcome([], authOk).evidence);
  t.check('稳定但**未执行**比对（skipped）⇒ 不许谎称"已核对"、也不是失败',
    (() => {
      const v = runAll5.resolveGateOutcome([], { ok: true, kind: 'skipped', detail: '**未执行**：本轮未跑全离线门禁' });
      return v.exitCode === 0 && v.unstable === false && /未经权威数字核对/.test(v.evidence) &&
        !/已核对/.test(v.evidence);
    })(), runAll5.resolveGateOutcome([], { ok: true, kind: 'skipped', detail: 'x' }).evidence);
  t.check('稳定但权威数字漂移 ⇒ 退出码 1，且给出"同步 tests\\README.md 第三节"的处置',
    (() => {
      const v = runAll5.resolveGateOutcome([], { ok: false, kind: 'mismatch', detail: '权威区写 9，本轮实跑 1' });
      return v.exitCode === 1 && v.unstable === false &&
        v.titles.some(l => l.includes('处置：同步 tests\\README.md 第三节'));
    })(), '漂移仍是退出码 1');
  t.check('稳定但账目不完整（blocked）⇒ 退出码 1，且说明"已跳过权威数字比对"（没比对就是没核实）',
    (() => {
      const v = runAll5.resolveGateOutcome([], { ok: false, kind: 'blocked', detail: '**未执行**：本轮账目不完整' });
      return v.exitCode === 1 && v.titles.some(l => l.includes('已跳过') && l.includes('权威数字比对'));
    })(), 'blocked 由"只报告"收紧为失败：跳过对账不得当通过');

  /* 静态契约：不稳定轮**不许**打印权威数字校验那一行（任何写法都容易被读成"比过了"）。 */
  const authLineBranch = runAllSrc5.indexOf('verdict.unstable ?');
  t.check('静态：不稳定时**不打**权威数字校验那一行（`verdict.unstable ? \'\' : …`）',
    authLineBranch > 0 && /unstable\s*\?\s*''/.test(runAllSrc5.slice(authLineBranch, authLineBranch + 60)),
    authLineBranch > 0 ? '已找到该分支' : 'run-all 里找不到"不稳定轮不打对账行"的分支');
  t.check('静态：稳定性复核（`collectSnapshot` + `diffSnapshots`）先于对账（`verifyAuthorityTotals` 调用）',
    (() => {
      const after = runAllSrc5.indexOf('const snapAfter = snapshot.collectSnapshot()');
      const diffAt = runAllSrc5.indexOf('const rewriteChanges = snapshot.diffSnapshots(');
      const authAt = runAllSrc5.indexOf('const auth = verifyAuthorityTotals(');
      return after > 0 && diffAt > after && authAt > diffAt;
    })(), '顺序：结束快照 → 比对清单 → 对账（顺序反了就会拿"正在变"的账去比权威值）');

  /* ---------------- D22 定点变异：旧写法必须被上面的断言挡下 ---------------- */
  const legacyDiff = (before, after) => Object.keys(before.files || {})
    .filter(k => (after.files || {})[k] !== before.files[k])
    .map(k => ({ path: k, kind: 'changed' }));
  t.check('变异①：旧写法（只比双方都有的键、只看内容变化）漏掉**新增与删除** —— 被第十二节断言挡下',
    (() => {
      const before = { files: { 'a.js': 'h1' } };
      const rewritten = { files: { 'a.js': 'H1' } };                  // 内容变化：新旧写法都应看见
      const added = { files: { 'a.js': 'h1', 'b.js': 'h2' } };         // 新增：旧写法看不见
      const removed = { files: {} };                                  // 删除：旧写法靠"undefined ≠ 旧哈希"偶然看见
      /* 旧写法的真实盲区是**新增**：它只遍历旧清单的键，"本轮多出来的文件"根本没有机会被看见。
         删除能被旧写法偶然抓到（键还在、值变成 undefined）—— 这一条也要一并记下来，
         免得把旧写法说得比实际更糟（夸大同样会让人不信判据）。 */
      return legacyDiff(before, added).length === 0 && snapshot.diffSnapshots(before, added).length === 1 &&
        snapshot.diffSnapshots(before, added)[0].kind === 'added' &&
        legacyDiff(before, rewritten).length === 1 && snapshot.diffSnapshots(before, rewritten).length === 1 &&
        legacyDiff(before, removed).length === 1 && snapshot.diffSnapshots(before, removed).length === 1 &&
        snapshot.diffSnapshots(before, removed)[0].kind === 'removed';
    })(), '旧写法下"新增文件/删除文件"的轮次会被判成稳定（只有内容变化看得见）');
  t.check('变异②：若排除规则失效（把 `._verify` 一并纳入清单），本机制会把自己的落盘判成"工作区被改写" —— 被第十二节排除断言挡下',
    (() => {
      const all = snapshot.collectSnapshot({ excludeSegments: [] });
      const only = snapshot.collectSnapshot();
      const leaked = Object.keys(all.files).filter(p => p.includes('/._verify/'));
      const legacyVerdict = snapshot.diffSnapshots({ files: all.files }, { files: only.files });
      return leaked.length > 0 && legacyVerdict.some(c => c.path.includes('/._verify/')) &&
        snapshot.isExcluded(leaked[0]) && snapshot.diffSnapshots({ files: only.files }, { files: only.files }).length === 0;
    })(), (() => {
      const all = snapshot.collectSnapshot({ excludeSegments: [] });
      const leaked = Object.keys(all.files).filter(p => p.includes('/._verify/')).length;
      return `不排除时清单里多出 ${leaked} 个 ._verify 文件（每轮必然被写 → 每轮都"不稳定"）`;
    })());
  t.check('变异③：旧写法把"工作区被改写"只当警告、继续对账（退出码 0）—— 被第十三节的 `unstable ⇒ 退出码 ≠ 0` 挡下',
    (() => {
      const legacyOutcome = () => ({ exitCode: 0, compare: true });
      const legacy = legacyOutcome();
      return legacy.exitCode === 0 && legacy.compare === true &&
        runAll5.resolveGateOutcome([{ path: 'src/a.js', kind: 'changed' }], authOk).exitCode !== 0;
    })(), '旧写法：打个警告然后照旧与权威数字比对，把"文件正在变"读成"权威区漂移"');
  t.check('变异④：旧写法把"跳过对账（blocked）"当通过（退出码 0）—— 被第十三节的 blocked 断言挡下',
    (() => {
      const legacyBlocked = () => 0;
      const blockedV = runAll5.resolveGateOutcome([], { ok: false, kind: 'blocked', detail: '**未执行**：本轮账目不完整' });
      return legacyBlocked() === 0 && blockedV.exitCode !== 0;
    })(), '旧写法：`blocked` 只打印"未核对"然后按全绿退 0');
}

/* ---------------- 十四、最终退出码的组合判据（P1：有 FAIL 却退 0 并打印"门禁全绿"） ----------------
   事故（提交 `51eed59` 引入，2026-09-21 修）：`tests\run-all.js` 收尾把"最终退出码"交给
   `resolveGateOutcome` 一个来源决定，而那个纯函数**只建模"工作区稳定性 + 权威数字对账"**，
   不建模"有没有脚本失败" ⇒ 稳定 + 对账 ok 时返回 0 ⇒ 执行落到成功收尾，在有 `FAIL` 的轮次上
   打印"门禁全绿（无失败脚本）"并退 0（实测：`FAIL docs-check 41 / 2 / 0` 与"门禁全绿"同屏）。
   本节把两件事钉死：
     ① **真值表**：`failed`/`unverified` 非空 ⇒ 无条件 1（**含"失败项仅为已登记偏差"**）；
        判定层面的 `blocked`/`mismatch`/`broken`/`unstable` ⇒ 1；`skipped`（子集）与"干净轮" ⇒ 0。
     ② **可达性静态断言**：源码里"门禁全绿"那句必须只在"失败集合为空"的路径上可达。
   真值表与静态断言各自都能被**定点变异**证伪（见下方变异⑤）—— 只写静态文本检查会漏掉
   "函数体被改成只看 exitCode"，这正是事故本体的形状。 */
t.section('十四、最终退出码的组合判据（有 FAIL 不得退 0／"门禁全绿"不得被顺带打印）');
{
  const runAll6 = require('./run-all');
  const runAllSrc6 = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
  const gateSrc = runAllSrc6.split(/\r?\n/);

  /* 真值表用的最小夹具：`finalExitCode` 只读 suite.name / 数组长度，故无需真结果对象。 */
  const script = name => ({ suite: { name } });
  const verdictOf = code => ({ unstable: false, exitCode: code, titles: [], detail: '', evidence: '' });
  const codeOf = (failed, unverified, verdict) => runAll6.finalExitCode({ failed, unverified, verdict });

  t.check('组合判据是纯函数且已导出（真值表与 D22 变异都要直接调它）',
    typeof runAll6.finalExitCode === 'function', typeof runAll6.finalExitCode);

  t.check('有失败脚本（判定层面"稳定 + 对账 ok"⇒ exitCode 0）⇒ **最终仍退 1** —— 事故本体',
    codeOf([script('docs-check')], [], verdictOf(0)) === 1 &&
    codeOf([script('ui-check'), script('db-check')], [], verdictOf(0)) === 1,
    `failed=1/verdict=0 ⇒ ${codeOf([script('docs-check')], [], verdictOf(0))}（修复前是 0）`);

  t.check('**失败项仅为已登记偏差**（docs-check 2 项 6.4 偏差）⇒ 仍退 1（豁免只免"阻止对账"，不免退出码）',
    (() => {
      /* 用真实的已登记偏差判据造这条场景：它是"能继续对账"的，绝不能因此被算成"全绿"。 */
      const dev = { suite: { name: 'docs-check' }, status: 'failed',
        summary: { passed: 41, failed: 2, skipped: 0 }, out: '' };
      const blocked = runAll6.authorityBlockers([dev]);
      return blocked.length === 0 && codeOf([dev], [], verdictOf(0)) === 1;
    })(), '已登记偏差：对账放行（blockers 空），退出码仍为 1 —— 两件事必须分开建模');

  t.check('未核实脚本（退出码 0 但拿不出断言证据）⇒ 非 0，与失败同档',
    codeOf([], [script('browser-check')], verdictOf(0)) === 1 &&
    codeOf([], [script('browser-check')], { unstable: false, exitCode: 1 }) === 1,
    `failed=0/unverified=1 ⇒ ${codeOf([], [script('browser-check')], verdictOf(0))}`);

  t.check('`blocked` / `mismatch` / `broken` / 不稳定（判定层面 exitCode 1）⇒ 1，与失败集合无关',
    codeOf([], [], verdictOf(1)) === 1 && codeOf([], [], verdictOf(2)) !== 0 &&
    codeOf([], [], { unstable: true, exitCode: 1 }) === 1,
    '四类判定层不通过都由 verdict.exitCode 带出来（本函数不得把它抹成 0）');

  t.check('干净轮（无失败/未核实 + 判定层面 0，含 `skipped` 子集轮）⇒ 0 —— 不得把正常形态误判为失败',
    codeOf([], [], verdictOf(0)) === 0 &&
    /* `--only contract-check`：对账 skipped 仍是 exitCode 0，最终码必须跟着是 0 */
    codeOf([], [], verdictOf(0)) === 0 &&
    codeOf([], [], { unstable: false, exitCode: 0 }) === 0,
    '`skipped`（未跑全离线门禁）不构成失败：既有语义不变');

  t.check('组合判据**不许**只看 `verdict.exitCode`（旧写法的定义式：那样上面第 2 条必红）',
    !/return\s+verdict\.exitCode\s*;/.test(runAllSrc6) &&
    /failed\.length\s*>\s*0/.test(runAllSrc6.slice(runAllSrc6.indexOf('function finalExitCode'))),
    '函数体里必须出现"失败集合非空即 1"这一支');

  /* ---------------- "门禁全绿"的可达性：静态守住，不靠"上面的提前退出顺便保证" ---------------- */
  /* 锚点取**唯一的完整字面量**（含 `\n` 转义与句号）：只搜"门禁全绿"四个字会先命中上方注释。 */
  const greenNeedle = "console.log('\\n门禁全绿（无失败脚本）。')";
  const greenAt = runAllSrc6.indexOf(greenNeedle);
  const guardAt = greenAt > 0 ? runAllSrc6.lastIndexOf('if (failed.length === 0 && unverified.length === 0) {', greenAt) : -1;
  /* 守卫块的收口大括号靠**配对扫描**取（跳过字符串与注释）：直接 `foundAt + indexOf('}')` 会命中
     `else {` 左近的括号，`lastIndexOf('}', greenAt)` 又会退到 `} else if` 去 —— 两种都会把块切错。 */
  const matchBrace = (src, openAt) => {
    let depth = 0;
    for (let i = openAt; i < src.length; i++) {
      const ch = src[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        for (i++; i < src.length && src[i] !== ch; i++) { if (src[i] === '\\') i++; }
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
      if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return -1; i++; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  };
  const guardBrace = guardAt > 0 ? runAllSrc6.indexOf('{', guardAt) : -1;
  const guardEnd = guardBrace > 0 ? matchBrace(runAllSrc6, guardBrace) : -1;
  const greenBlock = guardEnd > guardBrace && greenAt < guardEnd ? runAllSrc6.slice(guardBrace, guardEnd) : '';
  const lineOf = at => runAllSrc6.slice(0, at).split(/\r?\n/).length;
  t.check('静态：`门禁全绿` 那句 `console.log` 唯一一处，且落在 `if (failed.length === 0 && unverified.length === 0)` 的块内',
    greenAt > 0 && runAllSrc6.split(greenNeedle).length - 1 === 1 && guardAt > 0 && guardEnd > guardBrace &&
      greenAt < guardEnd && greenBlock.includes(greenNeedle),
    greenAt > 0
      ? `源码第 ${lineOf(greenAt)} 行；守卫在第 ${lineOf(guardAt)} 行、块收口在第 ${lineOf(guardEnd)} 行`
      : '源码里找不到那句"门禁全绿"');
  t.check('静态：那句 `console.log` 之后经 `} else { … process.exit(1) }` 紧跟 `process.exit(0)`（打印与退 0 成对、中间无第二个成功出口）',
    greenAt > 0 && /门禁全绿（无失败脚本）。'\);\r?\n\s*\}\s*else\s*\{[\s\S]{0,220}?process\.exit\(1\);\r?\n\s*\}\r?\n\s*process\.exit\(0\);/
      .test(runAllSrc6.slice(greenAt, greenAt + 400)),
    '打印"全绿"之后不许继续走到别的收尾；守卫的 else 支只能是退 1 的兜底');
  t.check('静态：提前退出用组合后的 `finalCode`，且它取自 `finalExitCode({ failed, unverified, verdict })`',
    (() => {
      const finalAt = runAllSrc6.indexOf('const finalCode = finalExitCode({ failed, unverified, verdict });');
      const exitAt = runAllSrc6.indexOf('if (finalCode !== 0) {');
      const greenPool = runAllSrc6.indexOf(greenNeedle);
      /* 反向断言：**提前退出那处**不得再拿 `verdict.exitCode` 当判据 —— 事故本体就是
         `if (verdict.exitCode !== 0) { … }` 把"脚本失败"整段漏掉。措辞分支里的
         `} else if (verdict.exitCode !== 0) {`（只选打印哪句话、不退出）不算违规，故按行首形态区分。 */
      const oldGuard = /(^|\r?\n)\s*if \(verdict\.exitCode !== 0\) \{/.test(runAllSrc6);
      return finalAt > 0 && exitAt > finalAt && greenPool > exitAt && !oldGuard;
    })(),
    '提前退出的判据必须是组合后的最终码；旧写法行首的 `if (verdict.exitCode !== 0) {` 就是事故入口');
  t.check('静态：权威对账行在**失败分支与绿轮收尾**各打印一次（旧实现只在失败分支打印，绿轮丢弃）',
    runAllSrc6.split("fs.writeSync(1, authLine + '\\n')").length - 1 === 2 &&
      runAllSrc6.includes('if (authLine) fs.writeSync(1, authLine'),
    `源码里该打印语句出现 ${runAllSrc6.split("fs.writeSync(1, authLine + '\\n')").length - 1} 次（应为 2）`);

  /* 立案（2026-09-22 座位 R）：`node tests\harness-check.js` 偶发 133 通过 / 1 失败，红的就是下面那条端到端断言，
     失败明细形如 `退出码 1｜FAIL docs-check 有｜"门禁全绿" 缺（应为"缺"）` —— 即它的第四条判据
     `t2.includes('门禁结论：不通过')` 取不到。**实测根因不是截断**：N=20 次 `--no-preflight --only docs-check`
     有 4 次取不到该字面量，但每次日志尾部都**完整且以 `\n` 结尾**（尾部原文："门禁结论：**本轮不通过**
     （工作区在运行期间被改写，结论不可作为证据）。"）—— 真正的根因是**结论行 token 不统一**：
     并发写方在改 `tests\ui-check.js` 时，`lib/snapshot.js` 的稳定性判定按设计把该轮判成"不稳定"，
     于是 run-all 走的是**另一句措辞**，那句话里没有"门禁结论：不通过"这个机器可读的 token
     （run-all 侧已按此把四句结论统一成同一 token）。
     故冻结：run-all 里**每一句**打印结论的行都必须带 `门禁结论：不通过`；并要求 ≥ 4 处 ——
     防"把结论行删掉"这种把断言弄成恒真的绕过（本断言只认**打印语句行**：含 `console.log(` 或 `fs.writeSync(`）。 */
  const verdictToken = '门禁结论：不通过';
  const verdictPrints = runAllSrc6.split(/\r?\n/)
    .filter(l => /console\.log\(|fs\.writeSync\(/.test(l) && l.includes('门禁结论：'));
  const verdictMissing = verdictPrints.filter(l => !l.includes(verdictToken));
  t.check('静态：run-all 每句"门禁结论"打印都带 `门禁结论：不通过` 这个 token（不稳定轮也不例外；≥4 处，防删行绕过）',
    verdictPrints.length >= 4 && verdictMissing.length === 0,
    `结论打印语句 ${verdictPrints.length} 处（应 ≥ 4），缺 token 的 ${verdictMissing.length} 处`
      + (verdictMissing.length ? `：${verdictMissing.map(l => l.trim().slice(0, 56)).join(' ｜ ')}` : ''));

  /* ---------------- 端到端：真跑一次 runner，看输出里到底有没有对账行（防"静态看着对、跑起来没有"） ----------------
     为什么要真跑：本节上面所有断言都是**对源码文本/纯函数**的检查，而本次回归恰恰是
     "文本都对、跑起来结论错"这一类（实测：同一分支里相邻的 `console.log` 能打印、`authLine` 那行没有产出）。
     **只允许 `--only <单个脚本>`**：跑全量会把 harness-check（本脚本）自己再拉起来一层，
     而本节的端到端断言又在那一层里再 spawn —— 实测直接递归到拿不到任何输出（status=null）。
     `docs-check` 这条既是"有 FAIL 的轮次"（41/2 已登记偏差）又足够快，且不会递归。 */
  const runAllPath = path.join(__dirname, 'run-all.js');
  const runOnly = suite => {
    const tmpOut = path.join(os.tmpdir(), `t1-runall-${process.pid}-${suite}.log`);
    const fd = fs.openSync(tmpOut, 'w');
    const r = spawnSync(process.execPath, [runAllPath, '--no-preflight', '--only', suite],
      { cwd: path.join(__dirname, '..'), stdio: ['ignore', fd, fd], timeout: 120 * 1000 });
    fs.closeSync(fd);
    const text = fs.readFileSync(tmpOut, 'utf8');
    fs.rmSync(tmpOut, { force: true });
    return { status: r.status, text, error: r.error ? (r.error.code || r.error.message) : '' };
  };
  let failRun = null;
  t.check('端到端：跑含 FAIL 的轮次（`--only docs-check`）⇒ 退出码 1、打印 FAIL 行，且**不含**"门禁全绿"',
    (() => {
      failRun = runOnly('docs-check');
      const t2 = failRun.text;
      return failRun.status === 1 && /FAIL {2}docs-check/.test(t2) && !t2.includes('门禁全绿') &&
        t2.includes('门禁结论：不通过');
    })(), (() => {
      if (!failRun) return '未能取到该轮输出';
      const has = s => (failRun.text.includes(s) ? '有' : '缺');
      return `退出码 ${failRun.status}${failRun.error ? `（spawn 错误 ${failRun.error}）` : ''}`
        + `｜FAIL docs-check ${has('FAIL  docs-check')}｜"门禁全绿" ${has('门禁全绿')}（应为"缺"）`;
    })());
  t.check('端到端：跑 `--only contract-check`（无失败脚本）⇒ 退出码 0，打印"门禁全绿"**且同时打印权威对账行**',
    (() => {
      const sub = runOnly('contract-check');
      return sub.status === 0 && sub.text.includes('门禁全绿（无失败脚本）。') &&
        sub.text.includes('权威数字校验：**未执行**：本轮未跑全离线门禁');
    })(), (() => {
      const sub = runOnly('contract-check');
      return `退出码 ${sub.status}${sub.error ? `（spawn 错误 ${sub.error}）` : ''}`
        + `｜权威对账行 ${sub.text.includes('权威数字校验：**未执行**') ? '有' : '缺'}｜门禁全绿 ${sub.text.includes('门禁全绿') ? '有' : '缺'}`
        + '（绿轮丢弃对账行是同一处重构的第二个缺口：必须"绿轮也打印"）';
    })());

  /* ---------------- D22 定点变异⑤：旧写法（只看 verdict.exitCode）必须被上面的断言挡下 ---------------- */
  const finalFn = runAllSrc6.match(/function finalExitCode\(entry\) \{[\s\S]*?\n\}/);
  /* 变异内容：把组合判据换回旧写法 —— 删掉"失败/未核实集合非空 ⇒ 1"那一支，只认 verdict.exitCode。 */
  const mutatedFinalFn = 'function finalExitCode(entry) {\n'
    + '  const e = entry || {};\n'
    + '  const verdict = e.verdict || {};\n'
    + '  return verdict.exitCode ?? 0;\n'
    + '}';
  const mutateSrc = src => src.replace(finalFn[0], mutatedFinalFn);
  /* 载入一段变异的 run-all 源码：只替换"最终退出码"函数体，其余（含 resolveGateOutcome）原样保留。
     用 `Module._compile` 而非写临时文件：不落地、不碰仓库；`require('./lib/snapshot')` 走真实模块。 */
  const loadSourceVariant = (src, id) => {
    const Module = require('node:module');
    const m = new Module(id, null);
    m.filename = path.join(__dirname, 'run-all.js');
    m.paths = Module._nodeModulePaths(__dirname);
    m._compile(src, m.filename);
    return m.exports;
  };

  t.check('变异⑤：把组合判据改回"只看 verdict.exitCode" ⇒ 第十四节断言必红；恢复后回绿',
    (() => {
      let lookupHit = false;
      try {
        if (!finalFn) { lookupHit = true; throw new Error('变异锚点未命中：源码里找不到 `function finalExitCode(entry) { … }`'); }
        const mutated = loadSourceVariant(mutateSrc(runAllSrc6), path.join(__dirname, 'run-all.js'));
        const mutFailed = mutated.finalExitCode({ failed: [script('docs-check')], unverified: [], verdict: verdictOf(0) });
        const mutUnverified = mutated.finalExitCode({ failed: [], unverified: [script('browser-check')], verdict: verdictOf(0) });
        const mutClean = mutated.finalExitCode({ failed: [], unverified: [], verdict: verdictOf(0) });
        const curFailed = runAll6.finalExitCode({ failed: [script('docs-check')], unverified: [], verdict: verdictOf(0) });
        const curClean = runAll6.finalExitCode({ failed: [], unverified: [], verdict: verdictOf(0) });
        /* 变异后：有 FAIL 却退 0（旧缺陷活回来了）；恢复后：同样输入退 1；干净轮两侧都必须 0
           （否则"挡下"可能只是把一切都判红 —— 那种断言同样不可信）。 */
        return mutFailed === 0 && mutUnverified === 0 && mutClean === 0 && curFailed === 1 && curClean === 0;
      } catch (err) {
        lookupHit = true;
        t.info('变异⑤未执行：' + (err && err.message));
        return false;
      } finally {
        if (lookupHit) t.info('变异⑤：变异体未能载入，本条按失败处理（不许把"跑不了"当通过）');
      }
    })(), '变异内容：finalExitCode 只 `return verdict.exitCode ?? 0`（删掉 failed/unverified 那一支）；'
      + '变异后实测：failed=1/verdict=0 → 0 且 unverified=1 → 0（红）；恢复后实测：failed=1 → 1、干净轮 → 0（绿）');
}

t.finish();
}

try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
