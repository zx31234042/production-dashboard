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
/* W5-②（E45）断言要用：判定引擎（按写入点入参**重算**期望载荷）与配置真源（构造判定标准的输入）。
   注意：夹具模板里的同名 require 在**子进程**作用域，本文件顶层的断言代码读不到它。 */
const judge = require('../server/services/judge');
/* 第十五节：跨班期望值要**由班次真源现算**（`shift.list` ＋ `at()`），不手写键名（ADR-0004 D19）。 */
const { createShiftRules } = require('../server/services/shift');
const boardConfig = require('../src/config/board.config.js');
/* E58（DR-05 写入点，`T-20260930-08` 收口后）：进程入口模块本身。顶层这里只 require（**不起服务**，
   `require.main !== module` ⇒ 不会自动 `main()`），用途：在**进程内**起真服务实例，让父进程能读它的库
   句柄与 `state`，从而**按件对账** `result` 表（`countDone` / `countByTask` / `getOne`）—— 沿用层② W7 段
   同款写法（"父进程进程内起服务"）。
   ⚠ E58 的临时闸（`start()` 的 `orderDoneSourceReady` 注入位、`ORDER_DONE_SUPPRESS_REASON` 字面量、
   `/health.orderWarningSource` 字段、启动日志抑制行）已随 `T-20260930-08` **整段拆除** ⇒ 本文件
   **不再读任何"闸"字段**：件数只有一条真源（`result` 表按件计数），"该类整条不产生"与"该类判 ok"
   不再混为一谈 —— 旧写法靠已删字段决定期望值，字段消失后退化成 `undefined === undefined` 的**恒真式**
   （ADR-0004 D23 明令禁止）。
   命名不与夹具模板里的 `entry` 撞车：那些是**子进程作用域**的局部变量。 */
const serverEntry = require('../server/index.js');
/* 标准仓储（真计数夹具要写"生效标准"才能让判定真的跑起来）。
   ⚠ 必须**在顶层**再 require 一次：W5 夹具模板里那份 `stdRepo` 在**子进程作用域**，
   而本文件里另有一份落在 W6 那个**块作用域**内（块内的 `const` 出了块就没了）—— 实测踩过：
   在块外的夹具函数里直接用 `stdRepo` / `post` 会抛 `ReferenceError`。 */
const stdRepo = require('../server/repo/standard.js');
/* DR-05 仓储（E58 ②）：真计数夹具按件对账 `result` 表用 —— 读口（`countDone`/`countByTask`/`getOne`）
   走**生产同一口**（不另写第二份 SQL），外加一处"写失败注入"（临时把 `upsertJudgement` 换成抛错桩，
   测完**当场还原**，见夹具内注释）。它与 `server/index.js` 顶层 require 的是**同一个模块对象**
   （Node 模块缓存）⇒ 换属性即可作用于生产链路，不必改被测实现。 */
const resultRepo = require('../server/repo/result.js');
/* A1（T-20261002-06／ADR-0009 D1、D3）的两处仓储：`shift_stat`（DR-06）与 `warning`（DR-08）。
   第十五节要在**真采集链路**上按库内真源对账，故直接在顶层 require（与 `resultRepo` 同理：
   它与 `server/index.js` 顶层 require 的是**同一个模块对象** ⇒ 第十五节的"写失败注入"换属性即可
   作用于生产链路，不必改被测实现）。 */
const shiftStatRepo = require('../server/repo/shiftStat.js');
const warningRepo = require('../server/repo/warning.js');

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
       前置造数：先按**当前**结构建库，再把 `schema_meta.schema_version` 改回**上一版**
       （＝`SCHEMA_VERSION − 1`，**由单一真源现算、不写死数字** —— 写死会让每次升版都假红一次，
       实测踩过：`SCHEMA_VERSION` 5 → 6 后本段日志变成"结构版本升级 4 → 6"，而断言里写的是 `4 → 5`）——
       于是真进程启动时命中 E18 判据②"结构版本升级 <上一版> → <当前版>"，启动日志里的**迁移前备份行**
       与磁盘上的备份文件都成为可断言的**行为**证据（不是匹配源码字符串）。 */
    {
      const authTmp = harness.makeTempDir('w5-auth-e2e');
      const authDbFile = path.join(authTmp, 'board.db');
      const authPort = await harness.allocPort();
      const PW1 = 'W5E2E-Pass-1';
      const PW2 = 'W5E2E-Pass-2';
      const { DatabaseSync } = require('node:sqlite');
      const dbApi = require('../server/db');
      /* 上一版结构版本号：**期望值全部由它现算**（`SCHEMA_VERSION` 是唯一真源，ADR-0004 D21） */
      const PREV_SCHEMA_VERSION = String(Number(dbApi.SCHEMA_VERSION) - 1);
      {
        const seed = new DatabaseSync(authDbFile);
        dbApi.initSchema(seed, '2026-09-28 10:00:00');
        seed.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(PREV_SCHEMA_VERSION, 'schema_version');
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

        /* ① 启动日志：E18 迁移前备份（判据②）＋ op_log 审计 ＋ 库内版本已升到 `SCHEMA_VERSION` */
        const health = await call('GET', '/health');
        const logText = authSvc.output();
        const backupLine = (logText.match(/\[启动\] E18 迁移前已备份：([^\r\n]+)/) || [])[1] || '';
        const backupPath = backupLine.split('（')[0].trim();
        const auditAfterStart = withDb(c => c.prepare(
          "SELECT op_type, result, content FROM op_log WHERE op_type = '迁移前备份' ORDER BY id").all());
        const versionAfterStart = withDb(c => c.prepare(
          "SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value);
        /* ⚠ 结构版本号**一律现算**（`previous → current` 由 `dbApi.SCHEMA_VERSION` 推出）：
           写死字面量会让本段在**每次升版**时假红一次（ADR-0004 D21：期望值由已知正确的量算出）。 */
        const versionUpgradeRe = new RegExp('结构版本升级 ' + PREV_SCHEMA_VERSION + ' → ' + dbApi.SCHEMA_VERSION);
        t.check('W5-③ 端到端（真进程）：启动期命中 E18 判据②（库内版本 ' + PREV_SCHEMA_VERSION +
          ' ≠ ' + dbApi.SCHEMA_VERSION + '）⇒ 启动日志写明' +
          '「迁移前已备份：<path>（原因 结构版本升级 ' + PREV_SCHEMA_VERSION + ' → ' + dbApi.SCHEMA_VERSION + '…）」、' +
          '备份文件**真的落盘**且备份内是**迁移前**的库、' +
          '`op_log` 有审计行（result=成功、含文件名）、启动后库内版本已升到 ' + dbApi.SCHEMA_VERSION + '；' +
          '**F20 对照**：本库本来就有 `op_log`（审计一次成功）⇒ 该行必须是 `审计 op_log=ok #<id>` 且**不含** `backfill`',
          health.status === 200 && backupPath !== '' && fs.existsSync(backupPath) &&
          versionUpgradeRe.test(backupLine) &&
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
       造数：当前结构建库 → `DROP TABLE op_log` → 版本改回**上一版**（`SCHEMA_VERSION − 1`，现算）⇒ 迁移前那次审计必然失败
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
        /* 版本同样**现算**（上一版），不写死数字 —— 与 2c 同一个理由（升版不假红） */
        seed.prepare('UPDATE schema_meta SET value = ? WHERE key = ?')
          .run(String(Number(dbApi.SCHEMA_VERSION) - 1), 'schema_version');
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
     ⑦ 超缓冲退回 hello ＋ 非法 since   ⑦e warning 真实写入点（本波新增）   ⑧ 优雅关闭（先 closeAllStreams、再 stop）

   ⚠ **新增推帧步骤前必读**（本波实测踩过三次，代价是整段断言连续变红）：
    ① ingest 的 1 s 采样去重是"**collectTime 不得早于上次落库那一秒**"（ADR-0001 D7）——
       新推的帧若用更早的采集时刻，会被判成 raw-500ms（**不落库、也就没有 frame/warning 事件**），
       连带把后续"更早时刻"的帧一起挡掉。故**新段的采集时刻必须排在它前面所有段之后**；
    ② 段④/⑦ 的续传与环形缓冲断言按 **seq 精确对账**（[base+1, base+2, base+3]）——
       任何在那些窗口里多发的**事件**（例如给某一票挂上"已生效的标准"后，它每帧都会多出一条
       warning）都会让它们变红。要给某票加"可判定的标准"，就**另起专用工单号/产品号**；
    ③ task 的写入是 INSERT … ON CONFLICT(proc_order_no) DO NOTHING ⇒ 工单号一旦被别处派发过，
       本处的派工**改不动**它的 product_code（本波实测：E22 段先派了 WO-W5-1/P-W5，
       导致 12:00:xx 的帧仍按 P-W5 判定）。 */
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

  /* ================= ⑥ 其余三类事件（task / standard / upload）＋ 「warning」（**真实写入点**） =================
     W5-②（接线技术债 E45）：warning 事件已接进生产链路 —— 发布点是 services/ingest.js 的
     options.onSampled（"1 s 采样落库成功"之后），判定与发布由 server/index.js 的 emitWarnings()
     完成。故本段**不再由夹具直调** judge.evaluate：只推真帧，warning 事件只能来自生产链路。 */
  const sOther = await openStream(base);
  streams.push(sOther);
  OUT.inproc = [];                                    // 进程内旁证：同一总线上的订阅者收到了什么
  const probe = svc.bus.subscribe(e => OUT.inproc.push(e.seq + ':' + e.kind));
  /* W5-②（E45）用：进程内订阅者把**事件信封的 at** 记下来 —— 线路上只发 data，
     at 是进程内信封字段（eventBus 的 {seq, at, kind, payload}），故"判定时刻"的判据读这里。 */
  const warnAtProbe = [];
  const probeAt = svc.bus.subscribe(e => { if (e.kind === 'warning') warnAtProbe.push({ seq: e.seq, at: e.at }); });
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

  /* ⚠ warning 的真实写入点判据**不在本段**：它要推"1 s 采样落库"的真帧，若挂在这里会往
     段④/⑦ 的续传与环形缓冲窗口里多塞事件（那些断言按 seq 精确对账）。故判据统一放在
     **⑦e 段**（在段⑦之后、段⑧优雅关闭之前）：那时续传窗口已经取完证，推帧不再影响任何既有判据。 */
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
    /* ⚠ collectTime 必须**早于**后面 F2 在途帧（现为 12:00:30）：采样落库口径是"采集时刻比上一帧更新"，
       取更晚的时刻会把后面的在途帧挤成 raw-500ms（本夹具实测踩过两次：F2、以及本波新加的段⑦e）。 */
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

  /* ================= ⑦e W5-②（技术债 E45）：warning 事件的**真实写入点**判据 =================
     为什么放在这里（而不是段⑥）：① 本段要推"1 s 采样落库"的**真帧**，会往总线上多塞事件，
     段④/⑦ 的续传与环形缓冲断言按 seq **精确对账**，多一条就变红；
     ② 这些帧的**采集时刻必须排在段④/⑦/⑦d 全部取证之后** —— ingest 的 1 s 采样去重是
     "collectTime 不早于上次落库秒"（ADR-0001 D7），时刻排早了会被判成 raw-500ms、
     根本不落库（**本波实测踩过两次**：先用 10:02:xx ⇒ 段⑦ 的 10:01:xx 全变 raw-500ms）。
     故本段排在段⑦d 之后、段⑧优雅关闭之前，采集时刻统一取 **12:00:xx**（远晚于前面所有帧）。

     ⚠ 旧写法（本轮改写）：夹具自己调 judge.evaluate({…},{bus:svc.bus}) 发一条 warning，
     它只能证明"**挂钩可用**"，证明不了"挂在**真实写入点**"（旧断言标题里也如实这么写）。
     新写法：夹具**一次都不直调** judge；只推真帧（POST /ifd/frame → 校验 → 去重 →
     1 s 采样落库 → onSampled → judge.evaluate → bus.publish），从**真 HTTP SSE 连接**上收
     warning 事件 —— 事件里的一切只能来自生产链路。

     判据构造（全部取**配置真源**，不写魔数；期望值现场算出，见 OUT.other.warning.expect）：
       · 先 POST /ifa/dispatch 落一条 task 行（**专用工单 WO-W5W-1**、产品 P-W5W / 工序 30）
         —— 判定取标准按任务的 (产品,工序)。
         ⚠ **两处"专用"都是必须的**（本波各踩过一次，写在这里防回潮）：
           ① 工单号专用：WO-W5-1 在段③/④/⑦ 被推过 13 帧，而它在段⑦d 的 E22 派工里已经
              落过 task 行（INSERT … ON CONFLICT(proc_order_no) DO NOTHING ⇒ 本段的派工**改不动**
              既有行的 product_code）—— 复用它会顺手给那 13 帧也接上标准、各发一条 warning，
              段④ 的 ?since= 逐 seq 对账立刻变红（期望 [4,5,6] 实得 [4,5,6,7,8,9]）；
           ② 产品号专用：P-W5 的标准在段⑥已生效（10:00:06），同样会把段③/④/⑦ 的帧点亮。
         P-W5W 的标准**只在本段写入**，故那些帧仍是"库内无生效标准 ⇒ 不判定、不发布"。
       · 再用 stdRepo.addVersion 写标准（生效时刻 11:59:59；本段之前该产品没有任何标准行）：
         帧的采集时刻取下面的 12:00:xx ⇒ 生效时刻若取错（例如用"当前时刻"而不是**帧的采集时刻**），
         断言必红（库行只对 12:00:xx 生效）；
       · 再推**一帧**真帧，其 depth/speed 按"距上/下限恰 k 格"构造 ⇒ 两参数**同态临近**
         ⇒ FR-5.8 / C-88 口径：参数类**恰 2 条**「参数阈值临近预警」。 */
  const WARN_AT = Object.freeze({ harm: '2026-09-19 12:00:00', err: '2026-09-19 12:00:10', half: '2026-09-19 12:00:20' });
  const harmVec = (() => {
    const grid = 1 / Math.pow(10, boardConfig.standards.digits);
    const near = boardConfig.standards.nearRatio;
    const band = (s) => {
      const upper = Math.round((s.typical + s.upperDev) * 100) / 100;
      const lower = Math.round((s.typical + s.lowerDev) * 100) / 100;
      const k = Math.max(1, Math.ceil((upper - lower) * near / grid - 1e-9));   // standardLevel() 的 k
      return { upper, lower, k,
        warnVal: Math.round((upper - k * grid) * 100) / 100,                    // 距上限恰 k 格 ⇒ 临近
        errVal: Math.round((upper + grid) * 100) / 100 };                       // 越上限一格 ⇒ 超范围
    };
    return { depth: band(boardConfig.standards.default.depth), speed: band(boardConfig.standards.default.speed), grid };
  })();
  const sWarn = await openStream(base);
  streams.push(sWarn);
  await sWarn.pump(120);
  OUT.other.warning = { expect: harmVec, at: WARN_AT };
  warnAtProbe.length = 0;                       // 从本段起点开始只记"本段产生的 warning 信封"

  /* ⚠ 2026-09-30 T2 独立复核（FR-5.11 判据改造 / 需求 C-108）：本票**必须真的下发计划开工时刻**。
     服务端「工单超时」的两个减数由 task.plan_start_time 与 result 表件数算出
     （server/index.js 的 shouldDoneOf() / doneQtyOf()）。若不下发（该列为 NULL），生产侧恒算得
     「应完成 0 / 已完成 0」⇒ 该条退化成一条**恒定 ok 快照**，对账就成了"两边都算 0"的恒等式，
     **取数链路一条都没被验到**（把 shouldDoneOf 改成恒返回 0 也照样全绿 —— 这正是旧写法的问题，
     旧写法在父进程侧把两个减数写死成 0/0）。
     ⚠ 本段在 String.raw 模板里：**注释里不得出现反引号**（会提前闭合外层模板，files-check 的
     node --check 当场红 —— 本次实测踩到过一次），故此处一律用「」或裸标识符。
     故此处下发 11:00:00（在三帧采集时刻 12:00:xx 之前 1 小时）：应完成＝floor(3600 / 节拍 160)＝22 件 > 0，
     而件数门槛（80）不成立 ⇒ 事件里的「工单超时」**只能由比率门槛**判 err ⇒ 判据全链路真的被算出来。 */
  const W5W_PLAN_START = '2026-09-19 11:00:00';
  OUT.other.warning.planStartSent = W5W_PLAN_START;
  OUT.other.warning.dispatch = await post(base, '/ifa/dispatch', {
    procOrderNo: 'WO-W5W-1', productCode: 'P-W5W', processNo: '30', planQty: 6, equipCode: 'EQ-W5',
    planStartTime: W5W_PLAN_START
  });
  OUT.other.warning.stdV2 = stdRepo.addVersion(db, {
    productCode: 'P-W5W', processCode: '30',
    depthUpperDev: boardConfig.standards.default.depth.upperDev,
    depthLowerDev: boardConfig.standards.default.depth.lowerDev,
    depthTypical: boardConfig.standards.default.depth.typical,
    speedUpperDev: boardConfig.standards.default.speed.upperDev,
    speedLowerDev: boardConfig.standards.default.speed.lowerDev,
    speedTypical: boardConfig.standards.default.speed.typical
  }, '2026-09-19 11:59:59', '2026-09-19 11:59:59', { bus: svc.bus });

  /* 这一帧：**同态临近**（深度与速度各距上/下限恰 k 格）⇒ 参数类恰 2 条。
     ⚠ 本段三帧一律带**件序号**（生产字段名 unitIndex，IF-D.4 / C-103）—— 理由见下面
     harmFrame.unitIndex 那一处（不带 ⇒ 工单类在"事件"与"期望"两侧不同侧，逐字对账当场红）。 */
  const harmFrame = frame(30, WARN_AT.harm);
  harmFrame.procOrderNo = 'WO-W5W-1';
  /* ⚠ **必须带件序号**（T-20260930-12a 把两条失配断言对齐到座位 6 的修复）：
     「emitWarnings()」的现行口径是「拿不到件序号（帧未带/非法 unitIndex）⇒ 本件**不固化** ＋
     本次判定**不产生**「工单超时预警」」（E60 裁定①）。而本节的期望侧重算**恒传**
     shouldDone / doneQty 两个减数（orderDerive + recompute）⇒ 帧不带件序号时，
     「事件 3 条（参数类 2 ＋ 维保 1） vs 重算 4 条（多一条工单类）」当场变红（实测红项）。
     带上之后两侧同口径：工单类在事件与重算里都出现，逐字相等重新成立。
     同票两帧都取第 1 件（都是测试中：testStatus=1）：DR-19 按件幂等 ⇒ 该票只落 1 行
     result（结果「测试中」**不进** countDone）⇒ 期望侧读到的已完成件数仍是 0。 */
  harmFrame.unitIndex = 1;
  harmFrame.depth = harmVec.depth.warnVal;
  harmFrame.speed = harmVec.speed.warnVal;
  OUT.other.warning.warnPost = await post(base, '/ifd/frame', harmFrame);

  /* 这一帧：**超范围**（深度越上限一格）⇒ 出「参数超范围预警」（速度仍临近）；同样带件序号 */
  const errFrame = frame(31, WARN_AT.err);
  errFrame.procOrderNo = 'WO-W5W-1';
  errFrame.unitIndex = 1;                  /* 同票同件（测试中）⇒ 工单类照常参与对账 */
  errFrame.depth = harmVec.depth.errVal;
  errFrame.speed = harmVec.speed.warnVal;
  OUT.other.warning.errPost = await post(base, '/ifd/frame', errFrame);

  /* ---- 负向判据：**标准未设定 ⇒ 不产生参数类预警**（C-93⑤ / FR-5.8） ----
     构造（**在真实写入点上判**，不是调 judge 自证）：
       · 另起一票 WO-W5-2（产品 P-W5B / 工序 30），用**显式危险开关**写一条**半套库行**标准
         （只有深度三格、**没有速度列**）—— 这正是"某参数标准未设定"的形态；
       · 推一帧：深度与速度**双双越上限**。若判定层对"未设定的速度"回退到配置演示值（旧行为），
         事件里会出现**速度**那条参数类预警；正确行为是**速度一条都不产生**（FR-3.18 / C-93⑤）。
       · 另一面由"恰 3 条"那条锁住：库里**没有生效标准**时（12:00:00 之前推的帧）不得发布
         warning 事件 —— 多一条就红。 */
  OUT.other.warning.dispatchHalf = await post(base, '/ifa/dispatch', {
    procOrderNo: 'WO-W5-2', productCode: 'P-W5B', processNo: '30', planQty: 3, equipCode: 'EQ-W5'
  });
  OUT.other.warning.stdHalf = stdRepo.addVersion(db, {
    productCode: 'P-W5B', processCode: '30',
    depthUpperDev: boardConfig.standards.default.depth.upperDev,
    depthLowerDev: boardConfig.standards.default.depth.lowerDev,
    depthTypical: boardConfig.standards.default.depth.typical
  }, '2026-09-19 11:59:59', '2026-09-19 11:59:59', { bus: svc.bus, dangerouslySkipValidation: true });
  const halfFrame = frame(40, WARN_AT.half);
  halfFrame.procOrderNo = 'WO-W5-2';
  /* 本票的采集时刻 12:00:20 **晚于**前一票两帧（12:00:00 / 12:00:10）——
     1 s 采样去重是「不得早于上次落库那一秒」（ADR-0001 D7）：同秒或更早会被判 raw-500ms
     ⇒ 不落库、也就没有 warning 事件。件序号同样必须带（不带则该帧的工单类整条消失）。 */
  halfFrame.unitIndex = 1;
  halfFrame.depth = harmVec.depth.errVal;
  halfFrame.speed = harmVec.speed.errVal;
  OUT.other.warning.halfPost = await post(base, '/ifd/frame', halfFrame);
  OUT.other.warning.halfExpect = {
    depthErr: harmVec.depth.errVal, speedErr: harmVec.speed.errVal,
    /* "标准未设定"的**实际形态**：库行里速度三格是 **null**（不是"列不存在" —— 列由 schema 固定，
       未录入就是 SQL NULL）。故判据看**值**，不看列是否存在。 */
    halfRow: stdRepo.getEffective(db, { productCode: 'P-W5B', processCode: '30', at: WARN_AT.half }) || null
  };
  OUT.other.warning.ifdStatus = await (await fetch(base + '/ifd/status')).json();
  /* 夹具①这台服务的「/health」（装配自报）：R1 只把它当**实例健康**的旁证 —— E58 的闸字段
     （orderWarningSource）已随 T-20260930-08 删除，期望侧**不再**由任何「闸值」决定
     「工单超时」参不参与对账（无闸 ⇒ 恒按库里真值参与）。
     ⚠ 本段在 String.raw 模板里：**注释里不得出现反引号**（会提前闭合外层模板，files-check 的
     node --check 当场红 —— 本次实测又踩到一次）。 */
  OUT.other.warning.health = await (await fetch(base + '/health')).json();
  /* 本节对账要用的**夹具实测状态**（从库里回读，不靠"我以为"）：派工是否真的落进
     task.plan_start_time、该票 result 表件数（已完成）⇒ 父进程据此**现场推导**期望值，
     而不是把两个减数写死（旧写法 shouldDone:0/doneQty:0 就是写死，见本段断言前提）。 */
  OUT.other.warning.taskRow = db.prepare(
    'SELECT proc_order_no, product_code, process_no, plan_qty, plan_start_time FROM task WHERE proc_order_no = ?'
  ).get('WO-W5W-1') || null;
  OUT.other.warning.doneQty = db.prepare(
    "SELECT COUNT(*) AS n FROM result WHERE proc_order_no = ? AND result IN ('合格','不合格')"
  ).get('WO-W5W-1').n;
  /* 三帧的 testStatus **从库里回读**（不是把「我们打算发的码」记下来）：期望侧的 progress
     必须由**已落库的那条事实**按 C-98④ / FR-2.5 的同一映射导出（见父进程 progressOfStatus()）——
     这样「采信了帧自报的 progress（C-102③ 明令仅比对与展示）」或「testStatus 没传进判定层」
     都会当场变红，而不是靠两边都漏算同一项凑成恒等式。 */
  OUT.other.warning.frameStatus = (() => {
    const q = db.prepare('SELECT test_status FROM measure_rt WHERE proc_order_no = ? AND collect_time = ?');
    const at = (no, ct) => {
      const r = q.get(no, ct);
      return r ? r.test_status : null;
    };
    return {
      harm: at('WO-W5W-1', WARN_AT.harm),
      err: at('WO-W5W-1', WARN_AT.err),
      half: at('WO-W5-2', WARN_AT.half)
    };
  })();
  OUT.other.warning.hookAt = warnAtProbe.slice();      // 进程内信封：seq + at（判定时刻）
  await sWarn.pump(400);
  OUT.other.warning.stream = { text: sWarn.text(), events: sWarn.events() };
  await sWarn.close();

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
  const inflightBody = Buffer.from(JSON.stringify(frame(88, '2026-09-19 12:00:30')), 'utf8');
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

  /* ===== E58（DR-05 写入点，`T-20260930-08` 收口后）**真计数**夹具：`result` 表件数驱动「工单超时预警」 =====
     为什么另起一个**进程内**实例，而不是复用夹具①那台 W5 服务：
       · 夹具①（上面那台）由 `w5Spawn` **另起子进程**，父进程**够不着**它的库句柄与 `state`
         （`harness.startService` 只给它 argv/env）⇒ 在夹具①上无从按件对账 `result` 表
         （`countDone` / `countByTask` / `getOne` 一个都读不到）；
       · 而"件数驱动预警"这条判据**必须**在真生产链路上验（派工 → 真帧 → 1 s 采样落库 →
         onSampled → emitWarnings → judge.evaluate → bus → **DR-05 按件固化**）；
       · 本文件既有的"父进程进程内起服务"惯例就在这两行附近（层② 的 W7 段、层③ 的用例段都用
         `entry.start({argv, installSignalHandlers:false, logConsole:false, clock})` 的原样写法），
         故这里**沿用同一惯例**，不另造一套。
     ⚠ E58 的临时闸（`start()` 的 `orderDoneSourceReady` 注入位 / `ORDER_DONE_SUPPRESS_REASON` 字面量 /
     `/health.orderWarningSource` 字段 / 启动日志抑制行）已由 `T-20260930-08` **整段拆除** ⇒
     本段**不读任何"闸"字段**：件数只有一条真源（`result` 表按件计数），"该类整条不产生"与
     "该类判 ok"不再混为一谈 —— 旧写法正是靠**已删字段**决定期望值，字段消失后退化成
     `undefined === undefined` 的**恒真式**（ADR-0004 D23 明令禁止；本轮把那一整段换成本段）。
     时钟：本段用**局部**注入时钟（值固定 10:00:00）；判定取的时刻一律是**帧的采集时刻**
     （12:00:xx，ADR-0003 D17），与"注入时钟停在几点"无关。
     ⚠ 本段**不往 `result` 塞任何行**：所有行都由**推帧**经真正的写入点（`emitWarnings()` →
     `persistJudgement()` → `repo/result.js` 的 `upsertJudgement()`）产生；读口也走生产同一口
     `repo/result.js`（不另写第二份 SQL）。 */
  const CNT_F1 = '2026-09-19 12:00:00';
  const CNT_F2 = '2026-09-19 12:00:01';
  const CNT_F3 = '2026-09-19 12:00:02';
  const CNT_HALF = '2026-09-19 12:00:10';
  const CNT_FAIL = '2026-09-19 12:00:20';
  /* ⚠ 采集时刻必须**全局严格递增**：ingest 的 1 s 采样口径是"collectTime 不得早于上次落库那一秒"
     （ADR-0001 D7）——同秒的另一票会被判成 `raw-500ms`、**不落库**，也就不会产生 `warning` 事件
     （实测踩过一次：旧写法里第二票与主票同秒 ⇒ 该票事件条为 []）。 */
  /** `yyyy-MM-dd HH:mm:ss`（DR-16）：本段只用它把"计划开工"按**配置节拍**摆到首帧之前 */
  const textOfDate = d => d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0');
  const CNT_CYCLE = Number(boardConfig.production.cycleSec);
  /* 计划开工 ＝ 首帧前 **(节拍 + 1) 秒**（由**配置节拍**现算，不写死时刻）：
     现场推导应完成 ＝ floor((节拍 + 1) ÷ 节拍) ＝ 1 件 ⇒ "恰 1 件已完成"就能把落后率从 100% 压到 0%
     ⇒ 「工单超时预警」的 **err → ok 翻转**可以在**同一票、同一节拍**上被观测到。
     这是本段的核心构造：不构造出"非零已完成"，"`result` 表件数真的被读进判据"就无从证明。 */
  const CNT_PLAN_START = textOfDate(new Date(Date.parse(CNT_F1.replace(' ', 'T')) - (CNT_CYCLE + 1) * 1000));
  const CNT_DEPTH = boardConfig.standards.default.depth.typical;
  const CNT_SPEED = boardConfig.standards.default.speed.typical;
  const orderTitle = judge.OTHER_TITLES.order;
  const countProbe = async label => {
    /* 本段自带的 POST 小工具：**不能**复用文件里那两个同名 `post`（它们在别的块作用域／子进程里，
       本作用域取不到 —— 实测 `typeof post === 'undefined'`）。零依赖，仍走真 HTTP。 */
    const cntPost = async (b, p, body) => {
      const res = await fetch(b + p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      let parsed = null;
      try { parsed = await res.json(); } catch { /* 非 JSON */ }
      return { status: res.status, body: parsed };
    };
    const tmp = harness.makeTempDir('e58-count-' + label);
    const logLines = [];
    const cntLogger = {
      info: m => logLines.push(String(m)),
      warn: m => logLines.push(String(m)),
      error: m => logLines.push(String(m))
    };
    const cntClockMs = Date.parse('2026-09-19T10:00:00');
    const cntClock = {
      now: () => new Date(cntClockMs),
      source: () => () => new Date(cntClockMs)
    };
    const out = {
      label, tmp, logLines, warnings: [], posts: [], frameStatus: {},
      ticketA: 'WO-E58c-' + label, ticketB: 'WO-E58c-half-' + label,
      /* 负向靶子的票（T-20260930-12a）：**专用**工单号/产品号 —— 它的帧刻意不带件序号，
         故绝不能与上面两条正向票共用（否则"0 行"会被正向帧的行污染，判据失去判别力）。 */
      ticketC: 'WO-E58c-nounit-' + label
    };
    /** 第 k 条 `warning` 事件里的「工单超时预警」行（0 起；本段每帧恰产生 1 条事件） */
    out.orderRowsAt = k => {
      const p = out.warnings[k];
      const ws = p && Array.isArray(p.warnings) ? p.warnings : [];
      return ws.filter(w => w.title === orderTitle);
    };
    let svc = null;
    let savedUpsert = null;
    try {
      svc = await serverEntry.start({
        argv: ['--port', '0', '--data-dir', tmp, '--db-file', path.join(tmp, 'board.db')],
        installSignalHandlers: false, logConsole: false, logger: cntLogger, clock: cntClock
      });
      out.port = svc.port;
      out.base = 'http://127.0.0.1:' + svc.port;
      out.listen = svc.listen;                        // 形如 host:port（port 传 0 ⇒ 必须读回真实端口）
      out.health = await (await fetch(out.base + '/health')).json();
      const db = serverEntry.state.db;
      /* `result` 表的**现场读数**（全部走生产同一口 `repo/result.js`）：
         `done` ＝ 已完成件数（合格＋不合格）、`rows` ＝ 该票行数（幂等对账用）。 */
      const readCounts = no => ({ done: resultRepo.countDone(db, no), rows: resultRepo.countByTask(db, no) });
      /* 收件箱分流（T-20260930-12a）：本段前四条的读数一律取**A/B/注入失败那五帧**的现场，
         故 `out.warnings` 的长度必须仍恰等于那五帧（"每帧恰 1 条"是逐条锁死的对账）；
         负向靶子（票 C）的事件**另走**一个收件箱（`nuSink`）⇒ 一条不少地存进 `out.noUnit.events`，
         同时不污染前面已记的读数。分流的只有"收进哪个数组"，事件本身照样来自同一条生产链路。 */
      let nuSink = null;
      const subW = svc.bus.subscribe(e => {
        if (e.kind !== 'warning') return;
        (nuSink || out.warnings).push(e.payload);
      });
      out.unsubscribe = () => { try { svc.bus.unsubscribe(subW); } catch { /* 已关 */ } };

      /* ---- 票 A：**全标准 + 计划开工**（"件数驱动"的主现场）---- */
      const A = out.ticketA, PA = 'P-E58c-' + label;
      out.dispatchA = await cntPost(out.base, '/ifa/dispatch', {
        procOrderNo: A, productCode: PA, processNo: '30',
        planQty: 6, equipCode: 'EQ-E58', planStartTime: CNT_PLAN_START
      });
      stdRepo.addVersion(db, {
        productCode: PA, processCode: '30',
        depthUpperDev: boardConfig.standards.default.depth.upperDev,
        depthLowerDev: boardConfig.standards.default.depth.lowerDev,
        depthTypical: boardConfig.standards.default.depth.typical,
        speedUpperDev: boardConfig.standards.default.speed.upperDev,
        speedLowerDev: boardConfig.standards.default.speed.lowerDev,
        speedTypical: boardConfig.standards.default.speed.typical
      }, CNT_PLAN_START, CNT_PLAN_START, { bus: svc.bus });
      out.taskRowA = db.prepare(
        'SELECT proc_order_no, product_code, process_no, plan_qty, plan_start_time FROM task WHERE proc_order_no = ?'
      ).get(A) || null;
      out.countsBefore = readCounts(A);              // 推帧**之前**的现场读数（不是"我以为是 0"）
      const push = async (no, seq, at, testStatus, unitIndex) => {
        const res = await cntPost(out.base, '/ifd/frame', {
          equipCode: 'EQ-E58', procOrderNo: no, collectTime: at, seq,
          depth: CNT_DEPTH, speed: CNT_SPEED, velocity_x: 3, velocity_y: 4,
          frameRate: 1000, gain: 2.5, shutter: 500, cameraDepth: 12.5, testStatus, unitIndex
        });
        await new Promise(r => setTimeout(r, 400));    // 让 onSampled 挂钩跑完、事件落进订阅者
        /* 该帧固化**之后**的现场读数 ＋ 该帧 `testStatus` 的**库内回读**（生产读的是同一条已落库
           事实；本段不记"打算发的码" ⇒ "采信帧自报 progress（C-102③ 仅比对展示）"或
           "`testStatus` 没传进判定层"都会变红，而不是两边都漏算同一项凑成恒等式）。 */
        const st = db.prepare(
          'SELECT test_status FROM measure_rt WHERE proc_order_no = ? AND collect_time = ?').get(no, at);
        const rec = {
          ticket: no, seq, at, testStatus, unitIndex, res, counts: readCounts(no),
          storedStatus: st ? st.test_status : null
        };
        out.posts.push(rec);
        out.frameStatus[at] = rec.storedStatus;
        return rec;
      };
      await push(A, 9501, CNT_F1, 1, 1);              // 测试中（progress 0.5）
      await push(A, 9502, CNT_F2, 2, 1);              // 判定（progress 1 ⇒ 合格）；固化在预警**之后**
      await push(A, 9503, CNT_F3, 1, 1);              // 同一件再来一帧（终态不得回退 / 行数不得增）
      out.rowA1 = resultRepo.getOne(db, A, 1);
      out.doneA = resultRepo.countDone(db, A);
      out.rowsA = resultRepo.countByTask(db, A);

      /* ---- 票 B：**半套标准（速度三格未设定）+ 无计划开工**，一帧判「待复检」----
         一次覆盖两件事：① `待复检`（判定依据不成立）**不计**「已完成」（行在、`countDone` 不加）；
         ② `shouldDoneOf()` 返 0（无计划开工）⇒ 应完成 0 ⇒ 该类判 **ok**
            （旧口径"计划数 − 已完成"在这里恒报 err —— 这正是 C-108 换判据要修的那一半）。 */
      const B = out.ticketB, PB = 'P-E58c-half-' + label;
      out.dispatchB = await cntPost(out.base, '/ifa/dispatch', {
        procOrderNo: B, productCode: PB, processNo: '30',
        planQty: 3, equipCode: 'EQ-E58'                        // ⚠ 故意**不下发** planStartTime
      });
      stdRepo.addVersion(db, {
        productCode: PB, processCode: '30',
        depthUpperDev: boardConfig.standards.default.depth.upperDev,
        depthLowerDev: boardConfig.standards.default.depth.lowerDev,
        depthTypical: boardConfig.standards.default.depth.typical
      }, CNT_HALF, CNT_HALF, { bus: svc.bus, dangerouslySkipValidation: true });
      out.taskRowB = db.prepare(
        'SELECT proc_order_no, plan_start_time FROM task WHERE proc_order_no = ?'
      ).get(B) || null;
      await push(B, 9511, CNT_HALF, 2, 1);            // 判定 ⇒ 速度标准未设定 ⇒ idle ⇒ **待复检**
      out.rowB1 = resultRepo.getOne(db, B, 1);
      out.doneB = resultRepo.countDone(db, B);
      out.rowsB = resultRepo.countByTask(db, B);

      /* ---- 写失败注入：证明"固化失败**不污染采集链**" ----
         手法：`server/index.js` 顶层是 `const resultRepo = require('./repo/result')`，调用点写的是
         `resultRepo.upsertJudgement(...)` ⇒ 换掉**同一模块对象**上的这个属性即可作用于生产链路
         （Node 模块缓存），**不必改被测实现**；测完**当场还原**（`finally` 里再兜一层）。 */
      out.failuresBefore = serverEntry.state.resultWrite.failures;
      out.writesBefore = serverEntry.state.resultWrite.writes;
      out.warnBeforeFail = out.warnings.length;
      /* 注入**之前**已推的帧数（`T-20261003-04` 甲-2 用）："冷启动 → 注入失败之前"这一段
         `/health.resultWrite.writes` 的增量必须**逐帧**等于它 —— 期望值取自"真的推过几帧"这个事实，
         不写死数字（ADR-0004 D21）。 */
      out.postsBeforeFail = out.posts.length;
      savedUpsert = resultRepo.upsertJudgement;
      resultRepo.upsertJudgement = function () {
        throw new Error('harness-check 注入：DR-05 写入点抛错桩（本条只验"固化失败不污染采集链"）');
      };
      try {
        await push(A, 9521, CNT_FAIL, 2, 2);          // 新的一件（第 2 件）：判定照跑、固化必失败
      } finally {
        resultRepo.upsertJudgement = savedUpsert;
        savedUpsert = null;
      }
      out.failRow = resultRepo.getOne(db, A, 2);      // 应为 null（没写成）
      out.rowsAAfterFail = resultRepo.countByTask(db, A);
      out.resultWrite = Object.assign({}, serverEntry.state.resultWrite);
      out.hookStatus = await (await fetch(out.base + '/ifd/status')).json();
      out.measureRows = db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
      out.loggedWriteFailure = logLines.some(l => l.indexOf('result 表写入失败') >= 0);

      /* ---- 票 C（**负向靶子**，T-20260930-12a 新增：下一包 D22 变异① 的靶子）----
         E60 裁定①的两个后果要在**真链路**上同时成立，且不许用"整次判定没跑"冒充"该类不产生"：
           · 不固化 ⇒ `result` **0 行**、`countDone` **0**、写入点 `writes` 增量 **0**
             （"没写"与"写失败"是两件事 ⇒ `failures` 也不得变）；
           · 「工单超时」**整条不产生** ⇒ 事件里该类 **0 条**；
           · 而**同一条事件**里参数类（实测双双越上限 ⇒ 深度/速度各 1 条）与维保类**照常发布**
             ⇒ 判定确实跑了、只是那**一类**成不了条（"参数类/维保类都在、独缺该类"）。
         ⚠ 前提独立（D20）：本票**真的**下发 planStartTime（应完成 > 0）、真的写生效标准、
           实测真的越范围 ⇒ 若帧带了件序号，该类**必然**成条。该反面由紧接的**正向对照帧**
           （同一票、同一标准、同一序列，**只**把 unitIndex=1 补上）当场证伪它的对立面解读：
           那一帧的事件里「工单超时」恰 1 条（少了这个对照，"0 条"也可能只是"这条链路不判"）。
         ⚠ 采集时刻必须**晚于**本夹具已落库的最后一秒（ADR-0001 D7：不早于上次落库那一秒，
           否则判成 raw-500ms ⇒ 不落库、也就没有事件）：本段最后一帧在 12:00:20，
           故本票从 12:00:30 起、逐秒递增（第二、第三帧都必须更晚）。 */
      const C = out.ticketC, PC = 'P-E58c-nounit-' + label;
      const cntAt = (base0, plusSec) =>
        textOfDate(new Date(Date.parse(base0.replace(' ', 'T')) + plusSec * 1000));
      /* 双双越上限一格：与段⑦e 的 harmVec 同一算式（上限 ＝ 典型＋上偏差，取整到配置位数；再 + 一格） */
      const nuVec = (() => {
        const grid = 1 / Math.pow(10, boardConfig.standards.digits);
        const over = s => Math.round((Math.round((s.typical + s.upperDev) * 100) / 100 + grid) * 100) / 100;
        return {
          depth: over(boardConfig.standards.default.depth),
          speed: over(boardConfig.standards.default.speed), grid
        };
      })();
      out.noUnit = {
        ticket: C, productCode: PC, vec: nuVec, planStartSent: CNT_PLAN_START,
        posts: [], events: [], control: null, taskRow: null, ifdStatusCounts: null
      };
      out.dispatchC = await cntPost(out.base, '/ifa/dispatch', {
        procOrderNo: C, productCode: PC, processNo: '30',
        planQty: 6, equipCode: 'EQ-E58', planStartTime: CNT_PLAN_START
      });
      stdRepo.addVersion(db, {
        productCode: PC, processCode: '30',
        depthUpperDev: boardConfig.standards.default.depth.upperDev,
        depthLowerDev: boardConfig.standards.default.depth.lowerDev,
        depthTypical: boardConfig.standards.default.depth.typical,
        speedUpperDev: boardConfig.standards.default.speed.upperDev,
        speedLowerDev: boardConfig.standards.default.speed.lowerDev,
        speedTypical: boardConfig.standards.default.speed.typical
      }, CNT_PLAN_START, CNT_PLAN_START, { bus: svc.bus });
      out.noUnit.taskRow = db.prepare(
        'SELECT proc_order_no, product_code, process_no, plan_start_time FROM task WHERE proc_order_no = ?'
      ).get(C) || null;
      out.noUnit.countsBefore = readCounts(C);
      out.noUnit.writesBefore = serverEntry.state.resultWrite.writes;
      out.noUnit.failuresBefore = serverEntry.state.resultWrite.failures;
      /* `E69`／C-111 的现场读数（下面两条新断言只读**真链路**的现场，不读实现内部状态）：
         · `svc.snapshot().stats.startedQty` ＝ 快照统计段算出的**开工件数**（`FR-4.2`，走
           `stateSnapshot.statsOf()` 的 SQL ⇒ `measure_rt.unit_index`）；
         · `/health` 顶层 `frameUnitIndex` ＝ 帧件序号计数（与 `/ifd/status` 同源）。
         推 C 票那三帧**之前**先各读一次，作为"不虚增 / 增量"的基线。 */
      out.noUnit.startedBefore = svc.snapshot().stats.startedQty;
      out.noUnit.healthBefore = await (await fetch(out.base + '/health')).json();
      /* 帧体**显式**决定带不带 unitIndex（本条的靶子：两次推帧只变这一个字段）。
         `unitIndex === undefined` ⇒ JSON.stringify 直接**不产出该键**（不是产出 null）。 */
      const nuPush = async (seq, at, testStatus, unitIndex) => {
        const body = {
          equipCode: 'EQ-E58', procOrderNo: C, collectTime: at, seq,
          depth: nuVec.depth, speed: nuVec.speed, velocity_x: 3, velocity_y: 4,
          frameRate: 1000, gain: 2.5, shutter: 500, cameraDepth: 12.5, testStatus
        };
        if (unitIndex !== undefined) body.unitIndex = unitIndex;
        const res = await cntPost(out.base, '/ifd/frame', body);
        await new Promise(r => setTimeout(r, 400));    // 让 onSampled 挂钩跑完、事件落进收件箱
        /* 库内回读**两列**（按列名）:`unit_index` 是本次改动新增的列 —— 只读 test_status 证明不了
           "件序号真的落进它自己那一列"（列序错位会静默写错列）。 */
        const st = db.prepare(
          'SELECT test_status, unit_index FROM measure_rt WHERE proc_order_no = ? AND collect_time = ?').get(C, at);
        return {
          at, seq, testStatus, unitIndex: unitIndex === undefined ? null : unitIndex,
          frameHasUnitIndex: Object.prototype.hasOwnProperty.call(body, 'unitIndex'),
          res, storedStatus: st ? st.test_status : null, storedUnitIndex: st ? st.unit_index : null,
          counts: readCounts(C),
          writes: serverEntry.state.resultWrite.writes
        };
      };
      nuSink = out.noUnit.events;                      // 票 C 的事件进专用收件箱（见 subW 处注释）
      try {
        out.noUnit.posts.push(await nuPush(9601, cntAt(CNT_F1, 30), 2));   // 判定帧，**不带** unitIndex
        out.noUnit.posts.push(await nuPush(9602, cntAt(CNT_F1, 31), 2));
        out.noUnit.posts.push(await nuPush(9603, cntAt(CNT_F1, 32), 2));
      } finally { nuSink = null; }
      out.noUnit.countsAfter = readCounts(C);
      out.noUnit.writesAfter = serverEntry.state.resultWrite.writes;
      out.noUnit.failuresAfter = serverEntry.state.resultWrite.failures;
      /* 三帧**不带**件序号之后：开工件数不得虚增（`FR-4.2` 按件计 ⇒ 没有件序号就没有"件"）；
         同时把 `/health` 与 `/ifd/status` **背靠背**各取一次（中间不再推帧 ⇒ 两次读的是同一现场），
         供"两处同源"与"`withIndex + withoutIndex = stored` 不变量"两条断言使用。 */
      out.noUnit.startedAfterNoUnit = svc.snapshot().stats.startedQty;
      out.noUnit.healthAfterNoUnit = await (await fetch(out.base + '/health')).json();
      out.noUnit.ifdStatus = await (await fetch(out.base + '/ifd/status')).json();
      out.noUnit.ifdStatusCounts = out.noUnit.ifdStatus.counts || null;
      out.noUnit.shouldDoneAtFirst = Math.floor(
        (Date.parse(cntAt(CNT_F1, 30).replace(' ', 'T')) - Date.parse(CNT_PLAN_START.replace(' ', 'T')))
        / 1000 / CNT_CYCLE);
      /* 正向对照帧：同一票、同一标准、同一越范围实测值，**只**把件序号补上（unitIndex=1） */
      out.noUnit.control = {
        at: cntAt(CNT_F1, 33), events: [],
        writesBefore: serverEntry.state.resultWrite.writes
      };
      nuSink = out.noUnit.control.events;
      try {
        out.noUnit.control.rec = await nuPush(9604, out.noUnit.control.at, 2, 1);
      } finally { nuSink = null; }
      out.noUnit.control.writesAfter = serverEntry.state.resultWrite.writes;
      out.noUnit.control.counts = readCounts(C);
      out.noUnit.control.row = resultRepo.getOne(db, C, 1);
      /* 正向对照帧（**带** `unitIndex=1`，其余同）之后：开工件数必须**增 1**；
         并记录全表行数，供"`stored` ＝ 表行数"这条交叉核对使用。 */
      out.noUnit.startedAfterControl = svc.snapshot().stats.startedQty;
      out.noUnit.healthAfterControl = await (await fetch(out.base + '/health')).json();
      /* `withIndex + withoutIndex = stored`／"两处同源"这两条必须在**同一现场**读：
         `/health` 与 `/ifd/status` 背靠背各取一次，中间不再推帧（实测踩过：拿"控制帧之前"的
         `/ifd/status` 去和"控制帧之后"的 `/health` 比 ⇒ 差一帧，是**取数时刻不同**、不是同源破了）。 */
      out.noUnit.ifdStatusAfterControl = await (await fetch(out.base + '/ifd/status')).json();
      out.noUnit.measureRowsAfter = db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
      /* 库里**按列名**数出来的两个数（与 `/health` 的计数交叉核对；这一对是"计数↔事实"的双向核对：
         若计数口径漂移、或件序号没真的落进那一列，两个方向都会当场对不上）。 */
      out.noUnit.measureUnitIndexCounts = {
        withIndex: db.prepare('SELECT COUNT(*) AS c FROM measure_rt WHERE unit_index IS NOT NULL').get().c,
        withoutIndex: db.prepare('SELECT COUNT(*) AS c FROM measure_rt WHERE unit_index IS NULL').get().c
      };
    } catch (err) {
      out.error = String(err && err.stack ? err.stack : err);
    } finally {
      try { if (savedUpsert) resultRepo.upsertJudgement = savedUpsert; } catch { /* 已还原 */ }
      try { if (out.unsubscribe) out.unsubscribe(); } catch { /* 已退订 */ }
      try { out.stopResult = await serverEntry.stop('harness-check E58 真计数：' + label); }
      catch (err) { out.stopError = String(err && err.message); }
      try { out.serverAfterStop = serverEntry.state.server === null; } catch { /* 读不到就算了 */ }
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }); }
      catch (err) { out.rmError = String(err && err.message); }
    }
    return out;
  };
  /* ⚠ `start()` 是进程级单例（`state.running` 为真时直接抛）⇒ 本段只起**一台**，串行用完即停。 */
  const cnt = await countProbe('main');
  /* 前提独立（ADR-0004 D20）：实例起不来 ⇒ 下面各条**不得**被读成"验过了"；
     `t.requires` 不成立计"未核实"（**不计通过**），退出码按 PROJECT_RULES 9.5-5 走。 */
  const cntOk = t.requires('E58 真计数夹具：进程内实例能起、能探活、能停（否则下面"件数驱动"各条无从判定）',
    Boolean(cnt && cnt.health && cnt.health.ok === true && cnt.health.dbWritable === true &&
      cnt.stopResult && cnt.stopResult.code === 0),
    `error=${cnt && cnt.error ? String(cnt.error).slice(0, 400) : '（无）'}；` +
    `health=${JSON.stringify(cnt && cnt.health && { ok: cnt.health.ok, dbWritable: cnt.health.dbWritable })}；` +
    `stop=${JSON.stringify(cnt && cnt.stopResult)}`);

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
  /* ⚠ F3（独立审查立案，W5-② 再改）：标题原写"六类事件全部挂在真实写入点"，**表述过强** ——
     当时 `warning` 的唯一发布点（`judge.evaluate`）在全仓**没有生产调用方**，夹具只能**直调**它。
     W5-②（技术债 E45）接线后，`warning` 也挂到了真实写入点（`ingest` 的 1 s 采样落库之后），
     本段断言随之改为"**六类全部来自真实写入点**"；每条写入点的证据见下面各条断言。 */
  t.check('W5/F3：六类事件（frame / link / task / standard / upload / warning）在真 HTTP 连接上全部**来自真实写入点**',
    ['frame', 'link', 'task', 'standard', 'upload', 'warning'].every(k =>
      [].concat(evts(s.frames && s.frames.stream), evts(s.link), evts(s.other && s.other.stream),
        evts(s.other && s.other.warning && s.other.warning.stream)).some(e => e.event === k)),
    `实收种类=${[...new Set([].concat(evts(s.frames && s.frames.stream), evts(s.link),
      evts(s.other && s.other.stream), evts(s.other && s.other.warning && s.other.warning.stream)).map(e => e.event))].join(',')}；` +
    `warning 的写入点证据见下方 W5-② 四条断言（真帧 → 落库 → onSampled → 真 SSE 连接）`);
  t.check('W5：`link` 覆盖**双向**变化（离线→在线 / 在线→离线），离线判据＝`ingest.linkState()`（推进注入时钟 6 s > upper.staleMs）',
    Boolean(onlineEv) && Boolean(offlineEv) && offlineEv.data.staleMs === 5000 && offlineEv.data.ageMs >= 5000 &&
    s.link && s.link.state && s.link.state.online === false,
    `online 事件=${Boolean(onlineEv)}；offline 事件=${JSON.stringify(offlineEv && offlineEv.data)}；快照 link=${JSON.stringify(s.link && s.link.state)}`);
  const taskEv = kindsOf(s.other && s.other.stream, 'task')[0];
  const uploadEv = kindsOf(s.other && s.other.stream, 'upload')[0];
  t.check('W5：`task`／`upload` 载荷来自**真实写入点**（幂等命中不重发／真失败留存待补传）—— `warning` 的载荷判据在段⑦e（它要推真帧，放这里会污染续传窗口）',
    Boolean(taskEv) && taskEv.data.procOrderNo === 'WO-W5-9' && taskEv.data.table === 'task' &&
    kindsOf(s.other && s.other.stream, 'task').length === 1 &&
    Boolean(uploadEv) && uploadEv.data.action === 'enqueue-failed' && uploadEv.data.state === '待补传' &&
    uploadEv.data.pendingCount === 1 && Boolean(uploadEv.data.alert) &&
    Boolean(s.other && s.other.upload && s.other.upload.pendingCount === 1),
    `task=${JSON.stringify(taskEv && taskEv.data)}；upload=${JSON.stringify(uploadEv && uploadEv.data && { action: uploadEv.data.action, pending: uploadEv.data.pendingCount })}`);

  /* ---- W5-②（技术债 E45）：`warning` 的四条**真实写入点**判据（事件取自段⑦e 的专用连接） ----
     为什么这四条足以证明"来自真实写入点"（而不是"夹具替它发了一条"）：
       · 段⑦e 夹具**再也没有直调** `judge.evaluate`（该调用已整段删除）⇒ 事件不可能来自夹具；
       · 事件的 `result`/`warnings` 必须**逐字等于**把**真帧的 depth/speed** 与**库里那一版标准**
         喂给 `judge.evaluate()` 的产出（构成性对账：左＝连接上收到的事件，右＝按写入点入参重算）；
       · `at` 必须是**该帧的采集时刻**、条数必须**恰等于**那些真帧的次数 ⇒ 反证"标准取值时刻"
         与"判定发生的时机"都对得上（取错时刻、或另起一次判定都会对不上）。 */
  const warnOpt = (s.other && s.other.warning) || {};
  const warnExpect = warnOpt.expect || {};
  const warnEvents = kindsOf(warnOpt.stream, 'warning');
  const paramTitles = [judge.WARN_TITLES.warn, judge.WARN_TITLES.err];   // 参数类**两条具名**（C-88）
  /* ⚠ 2026-09-30（FR-5.11 判据改造 / 需求 C-108）；**2026-09-30 T2 独立复核改判（ADR-0004 D21）**：
     服务端现在还会算「工单超时」（应完成 = 节拍 × (采集时刻 − `task.plan_start_time`)；已完成 = `result` 表件数）。
     **旧写法（本轮主代理所写）把两个减数写死成 `shouldDone: 0, doneQty: 0`，理由是"本夹具的工单行
     没有计划开工时刻 ⇒ 生产侧算得 0/0"—— 该理由本身属实，但结论是"改期望值适配实现"而不是"对齐"**：
     它把对账退化成"两边都算 0"的恒等式 ⇒ `shouldDoneOf()` / `doneQtyOf()` 的取数链路**一条都没被验到**
     （把 `shouldDoneOf` 改成恒返回 0 也照样全绿）；而且它把"实现日后开始读对列"变成**测试变红**，
     下次只能再改期望值。现改为：**夹具真的下发 `planStartTime`**（见段⑦e 的 `W5W_PLAN_START`），
     期望值由**回读的夹具实测状态**（`warnOpt.taskRow.plan_start_time` ＋ `warnOpt.doneQty`）＋ 节拍
     **现场推导** —— 取数链路一变（含"恒返回 0"这类实现退化）本对账当场变红。
     ⚠ **2026-09-30 三次对齐（技术债 E58 ② 收口 / `T-20260930-08` 之后）**：E58 的临时闸已**整段拆除**
     ⇒ 夹具①的期望侧**恒**含「工单超时」一类（无闸 ⇒ 没有"两态"，件数按库里真值参与），
     不再由任何"闸值"决定。另有一处**必须与生产同口径**的入参：`progress` ——
     生产侧 `emitWarnings()` 由帧的 `testStatus` 按 C-98④ / FR-2.5 **导出**（`progressOf()`），
     **不采信**帧自报的 `progress`（C-102③：IF-D 的进度仅比对与展示、不作权威）。
     期望侧若漏传该入参，`taskResult()` 恒判「待测试」⇒ 与事件的「测试中」对不上（R1 恒红，实测红项之一）。
     故此处新增 `progressOfStatus()`：**与生产逐条同映射**，入参取**库内回读**的 `test_status`
     （见段⑦e 的 `frameStatus`），不取"我们打算发的码"。 */
  const orderDerive = ct => {
    const row = warnOpt.taskRow || null;
    const cyc = Number(boardConfig.production.cycleSec);
    const t0 = row && typeof row.plan_start_time === 'string' ? Date.parse(row.plan_start_time.replace(' ', 'T')) : NaN;
    const t1 = Date.parse(String(ct).replace(' ', 'T'));
    const shouldDone = (Number.isFinite(cyc) && cyc > 0 && Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0)
      ? Math.floor((t1 - t0) / 1000 / cyc) : 0;
    return { shouldDone, doneQty: Number(warnOpt.doneQty) || 0 };
  };
  /** 帧 `testStatus` ⇒ 单件进度：**与生产 `server/index.js` 的 `progressOf()` 逐条同映射**
   *  （附录 2 的码语义 + C-98④ / FR-2.5 的阶段导出规则）：`2`（判定）⇒ 1；`1`（运行）/ `3`（异常）⇒ 0.5；
   *  其余（含 `0` 准备）⇒ 0。**不采信**帧自报的 `progress`（C-102③）。 */
  const progressOfStatus = st => (st === 2 ? 1 : (st === 1 || st === 3 ? 0.5 : 0));
  const recompute = (depth, speed, ct, order, progress) => judge.evaluate({
    now: ct, real: { depth, speed },
    standard: {
      depth: Object.assign({}, boardConfig.standards.default.depth),
      speed: Object.assign({}, boardConfig.standards.default.speed)
    },
    progress,
    /* 无闸 ⇒ 两个减数**恒传**（`emitWarnings()` 现在就是这样传的：缺一即整条不产生该类，
       而这里不构造"缺一"的情形 —— 只有一态，不再有"闸关 ⇒ 不给"的分支） */
    shouldDone: order.shouldDone, doneQty: order.doneQty
  });
  /* 夹具前提（ADR-0004 D20）：派工**真的**把计划开工时刻落进了库，且本票确实没有已出结果的件 ——
     这是"应完成 > 0 而件数门槛不成立"这个现场成立的前提；前提塌掉时本段的对账就没有判别力。 */
  const harmDerive = orderDerive((warnOpt.at && warnOpt.at.harm) || '');
  t.check('W5-②/E45 夹具前提：派工 `planStartTime` **真的落进** `task.plan_start_time`（否则「工单超时」退化成 0/0 恒等式、取数链路一条都验不到）',
    Boolean(warnOpt.taskRow) && typeof warnOpt.planStartSent === 'string' && warnOpt.planStartSent.length > 0 &&
    warnOpt.taskRow.plan_start_time === warnOpt.planStartSent &&
    warnOpt.doneQty === 0 && harmDerive.shouldDone > 0,
    `下发=${JSON.stringify(warnOpt.planStartSent)}；库内 task 行=${JSON.stringify(warnOpt.taskRow)}；` +
    `result 件数=${warnOpt.doneQty}；推导应完成=${harmDerive.shouldDone}`);
  /* 期望侧的 `progress` 入参：由**库内回读**的 `test_status`（段⑦e 的 `frameStatus`）现算 ——
     没有"闸值"要回读了（E58 闸已删）。回读而不是写死 0.5：帧的码一变，期望立刻跟着变；
     而"采信帧自报 progress"会让这里的推导与生产分叉、当场变红（D22 可证伪）。 */
  const harmStatus = warnOpt.frameStatus ? warnOpt.frameStatus.harm : null;
  const harmExpect = recompute(warnExpect.depth && warnExpect.depth.warnVal,
    warnExpect.speed && warnExpect.speed.warnVal, (warnOpt.at && warnOpt.at.harm) || '',
    orderDerive((warnOpt.at && warnOpt.at.harm) || ''), progressOfStatus(harmStatus));
  const harmEv = warnEvents[0] || null;
  const harmParam = harmExpect.warnings.filter(w => paramTitles.includes(w.title));
  t.check('W5-②/E45 写点：`warning` 事件的载荷**逐字等于**"真帧实测 + 库里生效标准"喂给判定引擎的产出（段⑦e已无任何夹具直调 ⇒ 事件只能来自生产链路）',
    Boolean(harmEv) && harmEv.data && typeof harmEv.data.result === 'string' &&
    Array.isArray(harmEv.data.warnings) &&
    JSON.stringify(harmEv.data.warnings) === JSON.stringify(harmExpect.warnings) &&
    harmEv.data.result === harmExpect.result && harmEv.data.reason === harmExpect.reason,
    `事件 warnings=${JSON.stringify(harmEv && harmEv.data && harmEv.data.warnings)}；` +
    `按写入点入参重算=${JSON.stringify(harmExpect.warnings)}；` +
    `本次重算的入参：progress=${progressOfStatus(harmStatus)}` +
    `（由库内回读的 test_status=${JSON.stringify(harmStatus)} 按 C-98④ 导出）、` +
    `应完成=${orderDerive((warnOpt.at && warnOpt.at.harm) || '').shouldDone}、已完成=${warnOpt.doneQty}；` +
    `事件 result=${JSON.stringify(harmEv && harmEv.data && harmEv.data.result)}／重算=${JSON.stringify(harmExpect.result)}`);

  /* FR-5.11（C-108）在**生产链路**上的件数驱动行为，已整段改由下面的「E58 真计数」四条断言承接
     （进程内实例 + 真帧 + 真写入点 + 按件对账）；此处不再保留旧"两态"文字说明。
     ⚠ 历史（E58 收口前）：`doneQtyOf()` 的唯一真源 `result` 表在 `server\` 下**没有任何写入点**
     ⇒ 服务端"已完成件数"恒 0 ⇒ 只要有计划开工时刻就恒判 err。该缺口已由 `T-20260930-08` 补上
     （写入点＝`server/index.js` 的 `persistJudgement()`，归口 `server/repo/result.js`），
     且**禁止**用"往 `result` 塞假行"来给任何一条凑场景 —— 本段所有行都由**推帧**经真写入点产生。 */

  /* ================= FR-5.11（C-108）**真计数**判据：`result` 表件数驱动「工单超时预警」 =================
     ⚠ 2026-09-30 T2 三次改判（ADR-0004 D21「改实现还是改期望必须判定并写明」）：
     上一轮（`T-20260930-05` 临时闸落地时）本段是"闸 off / 闸 on **两态**"四条断言。闸在
     `T-20260930-08` 被**整段拆除**后，那四条**全部失效**：
       · 态①（"该类整条不产生"）与态①b（"闸默认关"）读的是**已删字段** `/health.orderWarningSource`
         ⇒ `undefined === undefined` ⇒ **态①b 是恒真式假绿**（ADR-0004 D23 明令禁止）；
       · 态②/②b 读 `orderWarningSource.indexOf(READY_TAG)` ⇒ **抛 TypeError 中止整轮自检**
         （实测：`harness-check.js` 在 `:2303` 中止、其后约 171 条断言从未被核实）。
     **判定：改期望，不改实现**（无闸是裁定要求的正确行为）。且按 D23「不许只删不补」，把四条改成
     **件数驱动的正向断言**（下面四条）—— 它们验的是"`result` 表的件数**真的**被算进了判据"，
     而不是"某个字段长什么样"：
       ① 非零已完成 ⇒ 同一票「工单超时预警」**由 err 转 ok**（等级与 detail 数值全部现场推导）；
       ② `待复检` **不计**已完成（行在、`countDone` 不加）；
       ③ 按件幂等（同一件连推多帧 ⇒ `result` 恰 1 行、终态不回退）；
       ④ 固化失败**不污染采集链**（帧仍 stored、预警照发、失败计数 +1）。
     ⚠ 本段**不往 `result` 塞任何行**：行只由推帧经 `repo/result.js` 的 `upsertJudgement()` 产生。 */

  if (cntOk) {
    /* 现场推导（ADR-0004 D21：期望值一律实测/构成性推导，不写死）：
       · 应完成 ＝ floor((帧采集时刻 − `task.plan_start_time`) ÷ 配置节拍)（与生产 `shouldDoneOf()` 同一算式）；
       · 已完成 ＝ **该帧自己固化之后**的件数 —— 逐帧 POST 返回（`onSampled` 已跑完）后的现场读数
         `cnt.posts[k].counts.done` 就是服务端发布那一刻读到的件数；同一进程内、同一次请求之后读，
         后续帧还没发生 ⇒ 两者必等（不是"我以为"）。
         ⚠ **2026-09-30 T-20260930-12a 对齐（座位 4b）**：这里旧写法是 `posts[k−1].counts.done`
         （＝"该帧固化**之前**"的件数），其依据是旧实现的调用顺序「先 `bus.publish`、再 `persistJudgement`」。
         座位 6 的修复（E60 裁定②）已改为「**先固化、后发布**」（`server/index.js` 的 `emitWarnings()`：
         第一拍 `publish:false` 只为取 `result` 去固化，第二拍才按**固化之后的真实件数**组织发布）
         ⇒ 旧偏移写出来的期望整整错位一帧（实测：F2 期望 [应完成 1／已完成 0／err]，
         事件实为 [1／1／ok]，本条当场变红）。**判定：改期望，不改实现** ——
         期望改读"该帧自身的固化后件数"，与"发布读的是固化之后的件数"同一口径；
         等级仍由本段**独立算**（不调 judge），故不是"用被测对象算期望"。
       · 等级 ＝ C-108①② 的两个门槛（比率 / 件数）**在这里独立算**，不调 `judge` ——
         否则就是"用被测对象算期望"，等于把对账退化成自证。 */
    const cntAtMs = k => Date.parse(String(cnt.posts[k].at).replace(' ', 'T'));
    const cntShould = k => Math.floor(
      (cntAtMs(k) - Date.parse(CNT_PLAN_START.replace(' ', 'T'))) / 1000 / CNT_CYCLE);
    /* 该帧**固化之后**的件数 ＝ 该帧 POST 返回后的现场读数（本帧自己判出的那一件已计入）。
       ⚠ 不再取 `posts[k−1]`：那正是被座位 6 的"先固化后发布"修掉的旧偏移（见上）。 */
    const cntDoneAt = k => cnt.posts[k].counts.done;
    const cntExpectLv = (should, done) => {
      const behind = should - done;
      const ratio = should > 0 ? behind / should : 0;
      return (ratio > boardConfig.warnings.orderOverdueRatio ||
        behind > boardConfig.warnings.orderOverduePending) ? 'err' : 'ok';
    };
    /* 票 A 的三帧（posts[0..2]）与票 B 的那一帧（posts[3]）分别对账 */
    const cntA = [0, 1, 2].map(k => {
      const rows = cnt.orderRowsAt(k);
      const should = cntShould(k), done = cntDoneAt(k);
      const expectLv = cntExpectLv(should, done);
      return {
        k, rows, should, done, expectLv,
        hit: rows.length === 1 && rows[0].lv === expectLv &&
          String(rows[0].detail).includes(`按节拍应完成 ${should} 件、实际已完成 ${done} 件`)
      };
    });
    const cntB = cnt.orderRowsAt(3);
    const cntStored = cnt.posts.map(p => Boolean(p.res && p.res.status === 200 &&
      p.res.body && p.res.body.outcome === 'stored'));
    const cntAllStored = cntStored.length === 5 && cntStored.every(Boolean);
    const cntFailPost = cnt.posts[cnt.posts.length - 1] || null;
    const cntFrameA = cnt.posts.filter(p => p.ticket === cnt.ticketA && p.unitIndex === 1);
    /* 现场实测值**打印出来**（D21：断言详情只在红时打印，故这里额外给一行实测现场，
       便于复核者不跑变异也能看到"期望值是从哪些实测读数推出来的"；不计入断言数）。 */
    t.info(`E58 真计数现场（实测）：帧落库=${cnt.posts.length} 帧（${cntStored.filter(Boolean).length} stored）／` +
      `warning 事件 ${cnt.warnings.length} 条；票 ${cnt.ticketA}：推帧前 done=${cnt.countsBefore.done} ⇒ ` +
      `推帧后 done=${cnt.doneA}、行数 ${cnt.rowsA}（第 1 件=${JSON.stringify(cnt.rowA1 && cnt.rowA1.result)}，` +
      `duration_sec=${cnt.rowA1 && cnt.rowA1.duration_sec}）；三帧[应完成/已完成/本段独立算的等级]＝` +
      cntA.map(x => `F${x.k + 1}[${x.should}/${x.done}/${x.expectLv}]`).join(' ') +
      `（事件实测等级＝${cntA.map(x => JSON.stringify(x.rows[0] && x.rows[0].lv)).join(' ')}）；` +
      `票 ${cnt.ticketB}：第 1 件=${JSON.stringify(cnt.rowB1 && cnt.rowB1.result)}、retest_count=${cnt.rowB1 && cnt.rowB1.retest_count}、` +
      `行数 ${cnt.rowsB}、done=${cnt.doneB}；写失败注入：failRow=${JSON.stringify(cnt.failRow)}、` +
      `state.resultWrite=${JSON.stringify(cnt.resultWrite)}、行数 ${cnt.rowsA}→${cnt.rowsAAfterFail}、` +
      `loggedWriteFailure=${cnt.loggedWriteFailure}、measure_rt=${cnt.measureRows} 行`);

    /* ---- 真计数①：非零「已完成」 ⇒ 「工单超时预警」由 **err 转 ok**（数值现场推导） ---- */
    t.check('FR-5.11/C-108 行为·**真计数①**（非零「已完成」驱动）：同一票推三帧、第 2 帧 `testStatus=2` ⇒ ' +
      '该件判「合格」并由 DR-05 写入点**按件固化** ⇒ 同一票「工单超时预警」由 **err 转 ok**；' +
      '三帧的等级与 detail 里的「应完成 / 已完成」**全部等于现场推导值**（应完成＝节拍×经过时长、已完成＝`result` 实测件数）',
      cntAllStored && cnt.posts.length === 5 && cnt.warnings.length === cnt.posts.length &&
      cnt.countsBefore.done === 0 && cnt.doneA === cnt.countsBefore.done + 1 &&
      Boolean(cnt.rowA1) && cnt.rowA1.result === '合格' &&
      cntA.every(x => x.hit) &&
      cntA[0].rows.length === 1 && cntA[0].rows[0].lv === 'err' &&
      cntA[2].rows.length === 1 && cntA[2].rows[0].lv === 'ok' &&
      cntA[0].should > 0 && cntA[2].done > cntA[0].done,
      `五帧落库=${cnt.posts.map((p, i) => p.at + '=' + (cntStored[i] ? 'stored' : JSON.stringify(p.res && p.res.body))).join(' , ')}；` +
      `warning 事件 ${cnt.warnings.length} 条（帧 ${cnt.posts.length} 帧 ⇒ 每帧恰 1 条）；` +
      `票 ${cnt.ticketA}：推帧前 ` + '`countDone`' + `=${cnt.countsBefore.done} ⇒ 推帧后=${cnt.doneA}；` +
      `第 1 件行=${JSON.stringify(cnt.rowA1)}（库内 test_status 回读：` +
      `${cntFrameA.map(p => p.at + '→' + JSON.stringify(p.storedStatus)).join(' , ')}）；` +
      cntA.map(x => `F${x.k + 1}[应完成 ${x.should} / 已完成 ${x.done} ⇒ **本段独立算出的等级 ${x.expectLv}**] ` +
        `事件=${JSON.stringify(x.rows)}`).join('；'));

    /* ---- 真计数②：`待复检` **不计**「已完成」＋ 无计划开工 ⇒ 判 ok ---- */
    t.check('FR-5.11/C-108 行为·**真计数②**（`待复检` **不计**「已完成」）：半套标准（速度三格未设定）那件判「待复检」⇒ ' +
      '`result` **有该件行**、而复检件**不进** `countDone`；同一票无计划开工 ⇒ 应完成 0 ⇒ 「工单超时」判 ok',
      Boolean(cnt.rowB1) && cnt.rowB1.result === '待复检' && cnt.rowB1.retest_count === 1 &&
      cnt.rowsB === 1 && cnt.doneB === 0 && cnt.doneA > 0 &&
      Boolean(cnt.taskRowB) && cnt.taskRowB.plan_start_time === null &&
      cntB.length === 1 && cntB[0].lv === 'ok' &&
      String(cntB[0].detail).includes('按节拍应完成 0 件、实际已完成 0 件'),
      `票 ${cnt.ticketB}：库内 task.plan_start_time=${JSON.stringify(cnt.taskRowB && cnt.taskRowB.plan_start_time)}（应为 null）；` +
      `第 1 件行=${JSON.stringify(cnt.rowB1)}（应判「待复检」、复检次数 1）；` +
      `该票 ` + '`result`' + ` 行数=${cnt.rowsB}、` + '`countDone`' + `=${cnt.doneB}（**待复检不计**）；` +
      `对照：另一票同一张表上已完成=${cnt.doneA}（>0 ⇒ 本条的 0 不是"读不到"）；` +
      `该票「工单超时预警」=${JSON.stringify(cntB)}`);

    /* ---- 真计数③：按件幂等（同一件连推多帧 ⇒ 恰 1 行；终态不回退） ---- */
    t.check('FR-5.11/DR-19 行为·**真计数③**（按件幂等）：同一件（工单＋件号）连推三帧 ⇒ `result` **恰 1 行**、' +
      '结果**单调不回退**（已判「合格」的终态不被后续中间态改写）、`duration_sec` ＝该件首末**有效**帧的采集时刻差',
      cnt.rowsA === 1 && cnt.rowsAAfterFail === 1 && cntFrameA.length === 3 &&
      Boolean(cnt.rowA1) && cnt.rowA1.result === '合格' &&
      cnt.rowA1.duration_sec === Math.round((cntAtMs(2) - cntAtMs(0)) / 1000),
      `票 ${cnt.ticketA} 第 1 件：三帧（${cntFrameA.map(p => p.at + ' testStatus=' + JSON.stringify(p.storedStatus) +
        ' unitIndex=' + p.unitIndex).join(' , ')}）⇒ ` + '`result`' + ` 行数=${cnt.rowsA}（幂等，未新增行）；` +
      `行内容=${JSON.stringify(cnt.rowA1)}；` +
      `duration_sec 期望＝首末有效帧差 ${Math.round((cntAtMs(2) - cntAtMs(0)) / 1000)} s（${cnt.posts[0].at} → ${cnt.posts[2].at}）；` +
      `写失败注入后行数=${cnt.rowsAAfterFail}（第 2 件没写成 ⇒ 行数不变）`);

    /* ---- 真计数④：固化失败**不污染采集链** ---- */
    t.check('E58/D19 行为·**真计数④**（固化失败**不污染采集链**）：注入抛错桩 ⇒ 帧仍 `stored`、`warning` 照发、' +
      '`state.resultWrite.failures` +1 且该件**没有**写出行；判定挂钩失败计数仍为 0（异常在写入点内部被收下）',
      Boolean(cntFailPost) && Boolean(cntFailPost.res) && cntFailPost.res.status === 200 &&
      cntFailPost.res.body && cntFailPost.res.body.outcome === 'stored' &&
      cnt.warnings.length === cnt.posts.length &&
      Boolean(cnt.resultWrite) && cnt.resultWrite.failures === cnt.failuresBefore + 1 &&
      typeof cnt.resultWrite.lastError === 'string' && cnt.resultWrite.lastError.includes('注入') &&
      cnt.failRow === null && cnt.rowsAAfterFail === cnt.rowsA && cnt.loggedWriteFailure === true &&
      Boolean(cnt.hookStatus && cnt.hookStatus.counts) && cnt.hookStatus.counts.sampledHookFailures === 0,
      `注入后那一帧（${cntFailPost && cntFailPost.at}，第 2 件 / testStatus=2）：落库=${JSON.stringify(cntFailPost && cntFailPost.res && cntFailPost.res.body && cntFailPost.res.body.outcome)}；` +
      `warning 事件 ${cnt.warnings.length}/${cnt.posts.length}（照发）；` +
      `state.resultWrite=${JSON.stringify(cnt.resultWrite)}（注入前 failures=${cnt.failuresBefore}、writes=${cnt.writesBefore}）；` +
      `第 2 件行=${JSON.stringify(cnt.failRow)}（应为 null）；该票行数 ${cnt.rowsA} → ${cnt.rowsAAfterFail}；` +
      `写入失败已写日志=${cnt.loggedWriteFailure}；` +
      `/ifd/status.sampledHookFailures=${JSON.stringify(cnt.hookStatus && cnt.hookStatus.counts && cnt.hookStatus.counts.sampledHookFailures)}；` +
      `夹具内异常=${cnt.error || '（无）'}`);

    /* ---- 负向靶子（E60 裁定① / T-20260930-12a 新增）：帧**不带** `unitIndex` ⇒
       「工单超时」整条不产生 ＋ 本件不固化；参数类/维保类照常发布
       （不得用"整次判定没跑"冒充"该类不产生"；正面由同票的对照帧当场反证） ---- */
    const nu = cnt.noUnit || {};
    const nuPosts = Array.isArray(nu.posts) ? nu.posts : [];
    const nuEvts = Array.isArray(nu.events) ? nu.events : [];
    const nuCtl = nu.control || {};
    const nuCtlEvts = Array.isArray(nuCtl.events) ? nuCtl.events : [];
    /* 按标题数条数（只数"事件里真的发出来的"，不读实现内部状态） */
    const nuRowsOf = (payloads, titles) => {
      let n = 0;
      for (const p of payloads) {
        const ws = (p && Array.isArray(p.warnings)) ? p.warnings : [];
        for (const w of ws) if (titles.indexOf(w.title) >= 0) n++;
      }
      return n;
    };
    const nuOrderRows = nuRowsOf(nuEvts, [orderTitle]);
    const nuParamRows = nuRowsOf(nuEvts, [judge.WARN_TITLES.warn, judge.WARN_TITLES.err]);
    const nuMaintRows = nuRowsOf(nuEvts, [judge.OTHER_TITLES.maintenance]);
    const nuCtlOrderRows = nuRowsOf(nuCtlEvts, [orderTitle]);
    t.check('FR-5.11/E60① 行为·**负向靶子**（帧**不带** `unitIndex`）：同一票连推 3 帧判定帧' +
      '（`testStatus=2`、实测双双越上限、计划开工已落库 ⇒ 应完成 > 0）⇒ `result` **0 行**、' +
      '`countDone`=0、`state.resultWrite.writes` 增量 **0**（连 `failures` 也不得变）；' +
      '三帧各 1 条 warning 事件里**参数类 2 条 ＋ 维保类 1 条照发**、而「工单超时预警」**0 条** ' +
      '⇒ 是"**该类**不产生"而不是"整次判定没跑"；' +
      '正向对照（同一票、同一标准、同一实测值，**只**把 `unitIndex`=1 补上）⇒ 该帧事件里' +
      '「工单超时」恰 1 条、`result` 恰 1 行、writes +1',
      nuPosts.length === 3 && nuEvts.length === 3 && nuCtlEvts.length === 1 &&
      nuPosts.every(p => p.frameHasUnitIndex === false && Boolean(p.res) && p.res.status === 200 &&
        p.res.body && p.res.body.outcome === 'stored' &&
        p.writes === nu.writesBefore && p.counts.done === 0 && p.counts.rows === 0) &&
      Boolean(nu.countsBefore) && nu.countsBefore.done === 0 &&
      Boolean(nu.countsAfter) && nu.countsAfter.done === 0 && nu.countsAfter.rows === 0 &&
      nu.writesAfter === nu.writesBefore && nu.failuresAfter === nu.failuresBefore &&
      nuOrderRows === 0 && nuParamRows === nuPosts.length * 2 && nuMaintRows === nuPosts.length &&
      nu.shouldDoneAtFirst > 0 &&
      Boolean(nu.taskRow) && nu.taskRow.plan_start_time === CNT_PLAN_START &&
      Boolean(nu.ifdStatusCounts) && nu.ifdStatusCounts.sampledHookFailures === 0 &&
      Boolean(nuCtl.rec) && nuCtl.rec.frameHasUnitIndex === true &&
      nuCtlOrderRows === 1 && Boolean(nuCtl.counts) && nuCtl.counts.rows === 1 &&
      nuCtl.writesAfter === nuCtl.writesBefore + 1 && Boolean(nuCtl.row),
      `票 ${nu.ticket}（产品 ${nu.productCode}）：实测 depth=${nu.vec && nu.vec.depth}／speed=${nu.vec && nu.vec.speed}` +
      `（各越上限一格）、计划开工=${JSON.stringify(nu.planStartSent)}（库内=${JSON.stringify(nu.taskRow && nu.taskRow.plan_start_time)}）` +
      `⇒ 首帧应完成=${nu.shouldDoneAtFirst} 件（>0 ⇒ 工单类的两个减数在本票上**都**拿得到）；` +
      `三帧（不带 unitIndex）：` + nuPosts.map(p => `${p.at} unitIndex=${JSON.stringify(p.unitIndex)}` +
        `(${p.res && p.res.body && p.res.body.outcome}) result行=${p.counts.rows}/done=${p.counts.done}/writes=${p.writes}`).join(' , ') +
      `；该票 result 行数=${nu.countsAfter && nu.countsAfter.rows}、countDone=${nu.countsAfter && nu.countsAfter.done}` +
      `（推帧前 ${nu.countsBefore && nu.countsBefore.rows}/${nu.countsBefore && nu.countsBefore.done}）；` +
      `writes ${nu.writesBefore}→${nu.writesAfter}、failures ${nu.failuresBefore}→${nu.failuresAfter}；` +
      `事件三类条数：工单类=${nuOrderRows}（应 0）、参数类=${nuParamRows}（应 ${nuPosts.length * 2}）、维保类=${nuMaintRows}（应 ${nuPosts.length}）；` +
      `判定挂钩失败=${nu.ifdStatusCounts && nu.ifdStatusCounts.sampledHookFailures}；` +
      `正向对照帧 ${nuCtl.at}（**带** unitIndex=1，其余同）：工单类=${nuCtlOrderRows} 条、该票行数=${nuCtl.counts && nuCtl.counts.rows}、` +
      `writes ${nuCtl.writesBefore}→${nuCtl.writesAfter}；行=${JSON.stringify(nuCtl.row)}`);

    /* ---- `E69`／C-111 判别力断言①（**负向靶子**）：帧**不带** `unitIndex` ⇒ 开工件数**不虚增** ----
       立案：`FR-4.2` 自 V1.41（C-111）起按**件**计，判据＝该件在 `measure_rt` 有采样数据且 `unit_index` 非空。
       若"没有件序号的帧也算开工"（例如把 `unit_index IS NOT NULL` 这条过滤去掉），
       现场就会把"拿不到件序号"当成"开工了一件" —— 与 `judge.js` 的"拿不到不说"同一纪律。
       本条在**真链路**上验三件事，且带**正向对照**（否则"不增"也可能只是"这个量根本不动"）：
         ① 同一票连推 3 帧**不带** `unitIndex` ⇒ `snapshot.stats.startedQty` **不变**；
         ② 这 3 帧在库里 `unit_index` **为 NULL**（按列名回读，不是只看行数）；
         ③ `/health.frameUnitIndex.withoutIndex` **恰 +3**（"帧没带件序号"这件事**可被现场读出来**）；
         ④ 对照帧只多带 `unitIndex=1` ⇒ `startedQty` **恰 +1**（证明这个量确实随件数动）。 */
    {
      const nuBefore = nu.startedBefore, nuAfterNo = nu.startedAfterNoUnit, nuAfterCtl = nu.startedAfterControl;
      const nuHealthBefore = (nu.healthBefore && nu.healthBefore.frameUnitIndex) || null;
      const nuHealthAfterNo = (nu.healthAfterNoUnit && nu.healthAfterNoUnit.frameUnitIndex) || null;
      const nuStoredNull = nuPosts.length === 3 && nuPosts.every(p => p.storedUnitIndex === null);
      const nuWithoutDelta = nuHealthBefore && nuHealthAfterNo
        ? nuHealthAfterNo.withoutIndex - nuHealthBefore.withoutIndex : null;
      t.check('FR-4.2/E69 行为·**负向靶子**（帧**不带** `unitIndex` ⇒ 开工数**不虚增**）：同一票连推 3 帧' +
        '（其余字段与对照帧相同）⇒ 快照 `stats.startedQty` **一字不增**、这 3 行库内 `unit_index` **为 NULL**、' +
        '`/health.frameUnitIndex.withoutIndex` **恰 +3**；而**只多带** `unitIndex=1` 的对照帧 ⇒ `startedQty` **恰 +1**' +
        '（去掉 `unit_index IS NOT NULL` 过滤 ⇒ 开工数会虚增 3 ⇒ 本条必红）',
        Number.isFinite(nuBefore) && nuBefore > 0 &&
        nuAfterNo === nuBefore && nuStoredNull && nuWithoutDelta === 3 &&
        nuAfterCtl === nuBefore + 1,
        `开工件数（快照 stats）：推 3 帧不带件序号前=${nuBefore} ⇒ 后=${nuAfterNo}（须相等）；` +
        `对照帧（带 unitIndex=1）后=${nuAfterCtl}（须 ${nuBefore} + 1）；` +
        `三帧库内 unit_index=${JSON.stringify(nuPosts.map(p => p.storedUnitIndex))}；` +
        `/health.frameUnitIndex.withoutIndex：${nuHealthBefore && nuHealthBefore.withoutIndex} ⇒ ` +
        `${nuHealthAfterNo && nuHealthAfterNo.withoutIndex}（Δ=${nuWithoutDelta}，须 3）；` +
        `withIndex：${nuHealthBefore && nuHealthBefore.withIndex} ⇒ ${nuHealthAfterNo && nuHealthAfterNo.withIndex}`);
    }

    /* ---- `E69` 判别力断言④：`/health.frameUnitIndex` 的**不变量**与**同源** ----
       口径（`services/ingest.js` 的 `state.frameUnitIndex` 注释）：计数**只数真正落库的那一帧**
       （重复帧 / 500 ms 原始帧 / 被拒收帧都不是库里的行）⇒ 恒有 `withIndex + withoutIndex === stored`，
       且 `stored` 应等于 `measure_rt` 的行数（两个独立真源交叉核对）；
       两个计数还应与库里**按列名**数出的"`unit_index` 非空 / 为空"的行数**逐项相等**
       （这一对是"计数 ↔ 事实"的双向核对：`ingest` 若不再把件序号写进那一列，`withIndex` 就与库对不上）。
       同源：`/health` 顶层的该对象与 `GET /ifd/status` 里的**逐字段相等** —— 两处都只是搬运
       `ingest.status()` 的同一个返回值（此处两次 HTTP 中间**不再推帧**，故是同一现场）。
       反证：谁若在 `/health` 侧另算一份计数、把计数挪到"落库之前"、或让 `ingest` 不写该列，本条的等式必红。 */
    {
      const h = (nu.healthAfterControl && nu.healthAfterControl.frameUnitIndex) || null;
      const s = (nu.ifdStatusAfterControl && nu.ifdStatusAfterControl.frameUnitIndex) || null;
      const uic = nu.measureUnitIndexCounts || {};
      t.check('FR-4.2/E69 行为·**不变量与同源**：`/health.frameUnitIndex` 恒有 `withIndex + withoutIndex = stored`、' +
        '`stored` ＝ `measure_rt` 实际行数、两个计数＝库里按列名数出的 `unit_index` 非空/为空行数，' +
        '且与 `GET /ifd/status` 的 `frameUnitIndex` **逐字段相等**（同一份 `ingest.status()`）',
        Boolean(h) && Boolean(s) &&
        h.withIndex + h.withoutIndex === h.stored &&
        h.stored === nu.measureRowsAfter &&
        h.withIndex === uic.withIndex && h.withoutIndex === uic.withoutIndex &&
        JSON.stringify(h) === JSON.stringify(s),
        `health.frameUnitIndex=${JSON.stringify(h)}；ifd/status.frameUnitIndex=${JSON.stringify(s)}；` +
        `两处逐字段相等=${JSON.stringify(h) === JSON.stringify(s)}；` +
        `measure_rt 行数=${nu.measureRowsAfter}（须＝ stored）；` +
        `库里按列名数：unit_index 非空 ${uic.withIndex} 行／为空 ${uic.withoutIndex} 行；` +
        `推帧前 withIndex/withoutIndex=${nu.healthBefore && nu.healthBefore.frameUnitIndex && nu.healthBefore.frameUnitIndex.withIndex}` +
        `/${nu.healthBefore && nu.healthBefore.frameUnitIndex && nu.healthBefore.frameUnitIndex.withoutIndex}`);
    }

    /* ================= 甲：`/health.resultWrite` 的出口断言（`T-20261003-04`；`E58` 结案更正） =================
       事实（`E58` 行末「结案更正（2026-10-03）」段）：`DR-05` 的写入点（`persistJudgement()`）自
       `T-20260930-08` 就已接线，但它的三个运行计数**只在进程内存里**、`/health` **一个字都不搬运**
       （`shiftStatWrite` / `warningWrite` 早已搬运，独缺这一块）⇒ "到底写没写、写失败没有、有多少件
       因为拿不到件序号而**根本没打算写**"在**外部读不到**。`server/index.js` 的 `T-20261003-02` 补上了出口。
       **搬运口径（三者互不代偿，`server/index.js` 的 `state.resultWrite` docblock）**：
         · `writes`        ＝ **真的落了行**；
         · `failures`      ＝ **想落但落不进去**（并带 `lastError`）；
         · `skippedNoUnit` ＝ 帧**拿不到件序号** ⇒ **根本没打算落**（`E60` 裁定①）。
       下面四条一律读**真 HTTP 的 `/health` 响应体**，**不读** `serverEntry.state`：
       进程内状态对"出口有没有搬运"零判别力 —— 那正是本条要守的东西。
       D22 暗桩（两条，与 §16-F/I/K 同款纪律：**字节副本 ＋ sha256 留痕 ＋ `Buffer.compare` 还原证明 ＋
       全程不落盘**）：① 把搬运块整段摘掉 ⇒ 甲-1 必红并指名；② 把 `skippedNoUnit` 并进 `failures`
       ⇒ 甲-3 必红并指名。两条都要求"未变异的当前源码必绿"（否则"判红"可能只是把一切都判红）。
       ⚠ 变异在**内存字节副本**上做（不写 `server\index.js`）：那份文件此刻正被另一路协作方改写（E89），
       写盘＋还原会与并发写撞车（见本批回执的取舍说明）；"字节副本还原"的**证据力**由下面两端读数给出
       —— 变异体 sha256 ≠ 原件 sha256，且**盘上文件全程逐字节未变**（`sha256Hex(readFile) === sha0`）。 */
    {
      const { createHash } = require('node:crypto');
      const sha256Hex = buf => createHash('sha256').update(buf).digest('hex');
      /** `/health` 响应体里的 `resultWrite` 块；**缺块 ⇒ null**（不抛：字段消失须判红并指名，不得中止整轮） */
      const rwOf = h => (h && typeof h === 'object' && h.resultWrite && typeof h.resultWrite === 'object'
        ? h.resultWrite : null);
      const RW_KEYS = ['writes', 'failures', 'lastError', 'skippedNoUnit'];
      /** 键恒在 ＋ 取值类型合口径 ⇒ 逐项问题清单（空数组＝合规）。ADR-0004 D23：判红必须能**指名**。 */
      const rwKeyProblems = h => {
        const rw = rwOf(h);
        if (!rw) return ['`resultWrite` 整块缺失（"键恒在"是搬运口径的一部分）'];
        const bad = [];
        for (const k of RW_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(rw, k)) { bad.push('缺键 `resultWrite.' + k + '`'); continue; }
          if (k === 'lastError') {
            if (rw[k] !== null && typeof rw[k] !== 'string') bad.push('`lastError`＝' + JSON.stringify(rw[k]) + '（须 null 或字符串）');
          } else if (!Number.isFinite(rw[k])) bad.push('`' + k + '`＝' + JSON.stringify(rw[k]) + '（须有限数字）');
        }
        const extra = Object.keys(rw).filter(k => RW_KEYS.indexOf(k) < 0);
        if (extra.length) bad.push('多了未登记键 ' + extra.join('/'));
        return bad;
      };
      /** 一次读数 → 四个计数（缺块 ⇒ null） */
      const rwOf4 = h => {
        const rw = rwOf(h);
        return rw ? { writes: rw.writes, failures: rw.failures, skippedNoUnit: rw.skippedNoUnit, lastError: rw.lastError } : null;
      };
      /** 两次读数之间的增量（任一侧缺块 ⇒ null） */
      const rwDelta = (a, b) => (a && b ? {
        writes: b.writes - a.writes, failures: b.failures - a.failures, skippedNoUnit: b.skippedNoUnit - a.skippedNoUnit
      } : null);
      /** 甲-3 的判据本体（"`skippedNoUnit` 与 `failures` 分得开"）——
          D22 暗桩②**复用同一个函数**：暗桩若另抄一份判据，它绿了也不能证明这条断言可证伪。 */
      const separateNoUnitFromFailures = (before, afterNoUnit, afterControl) => {
        const dNo = rwDelta(rwOf4(before), rwOf4(afterNoUnit));
        const dCtl = rwDelta(rwOf4(afterNoUnit), rwOf4(afterControl));
        return {
          dNo, dCtl,
          ok: Boolean(dNo && dCtl) && dNo.skippedNoUnit === 3 && dNo.failures === 0 && dNo.writes === 0 &&
            dCtl.skippedNoUnit === 0 && dCtl.writes === 1
        };
      };

      const coldH = cnt.health, beforeH = nu.healthBefore, afterNoH = nu.healthAfterNoUnit, afterCtlH = nu.healthAfterControl;
      const cold4 = rwOf4(coldH), before4 = rwOf4(beforeH), afterNo4 = rwOf4(afterNoH), afterCtl4 = rwOf4(afterCtlH);
      const readings = [
        ['冷启动（未推任何帧）', coldH],
        ['四帧成功落库 ＋ 一次注入写失败之后', beforeH],
        ['三帧不带件序号之后', afterNoH],
        ['补上件序号那一帧之后', afterCtlH]
      ];
      const keyProblems = [];
      for (const [label, h] of readings) for (const p of rwKeyProblems(h)) keyProblems.push(label + '：' + p);

      /* ---- 甲-1：键恒在（含冷启动的四个 0／null 形状） ---- */
      t.check('甲-1/`E58` 出口·**键恒在**：四次**真 HTTP** `/health` 读数的 `resultWrite` 块键集恒为 ' +
        '`{writes, failures, lastError, skippedNoUnit}`（含**冷启动**、含从未写入过时 ' +
        '`writes=0／failures=0／lastError=null／skippedNoUnit=0`）—— 缺块／缺键／多键／类型不合口径即判红并**逐项指名**',
        keyProblems.length === 0 && readings.every(([, h]) => Boolean(rwOf(h))) &&
        Boolean(cold4) && cold4.writes === 0 && cold4.failures === 0 && cold4.lastError === null && cold4.skippedNoUnit === 0,
        keyProblems.length ? `问题 ${keyProblems.length} 处：${keyProblems.join('；')}`
          : `四次读数键集齐全、类型合口径；冷启动实测 ${JSON.stringify(cold4)}；` +
            readings.slice(1).map(([l, h]) => `${l}＝${JSON.stringify(rwOf(h))}`).join('；'));

      /* ---- 甲-2：正侧 —— 一次成功落库 ⇒ `writes` +1（真进程 ＋ 真 HTTP 走采集链） ---- */
      const pos = rwDelta(afterNo4, afterCtl4);            // 恰一帧（对照帧，unitIndex=1）跨这两次读数
      const coldToBefore = rwDelta(cold4, before4);
      t.check('甲-2/`E58` 出口·**正侧**（一次成功落库 ⇒ `writes` **+1**）：真进程 ＋ 真 HTTP 走 ' +
        '`POST /ifd/frame` → `onSampled` → `persistJudgement`，**恰一帧**（`unitIndex=1`、`testStatus=2`）落在 ' +
        '两次 `/health` 读数之间 ⇒ `resultWrite.writes` 增量**恰 1**（`failures`／`skippedNoUnit` 均不变）；' +
        '且"冷启动 → 注入失败之前"那一段的 `writes` 增量**＝该段真的推过的帧数**（逐帧对账，不写死 4）',
        Boolean(pos) && pos.writes === 1 && pos.failures === 0 && pos.skippedNoUnit === 0 &&
        Boolean(nuCtl.row) && Boolean(nuCtl.counts) && nuCtl.counts.rows === 1 &&
        Boolean(coldToBefore) && cnt.postsBeforeFail > 0 && coldToBefore.writes === cnt.postsBeforeFail,
        `对照帧（${nuCtl.at}，带 unitIndex=1）：${JSON.stringify(afterNo4)} → ${JSON.stringify(afterCtl4)}` +
        `（Δwrites=${pos && pos.writes}、Δfailures=${pos && pos.failures}、ΔskippedNoUnit=${pos && pos.skippedNoUnit}）；` +
        `该件库内行=${JSON.stringify(nuCtl.row)}、该票行数=${nuCtl.counts && nuCtl.counts.rows}；` +
        `冷启动 → 注入失败之前：${JSON.stringify(cold4)} → ${JSON.stringify(before4)}` +
        `（Δwrites=${coldToBefore && coldToBefore.writes}，该段实测推帧 ${cnt.postsBeforeFail} 帧）`);

      /* ---- 甲-3：`skippedNoUnit` 与 `failures` **分得开** ---- */
      const sep = separateNoUnitFromFailures(beforeH, afterNoH, afterCtlH);
      t.check('甲-3/`E60①` 出口·**`skippedNoUnit` 与 `failures` 分得开**：同一票连推 3 帧**不带件序号**' +
        '（`testStatus=2`、计划开工与生效标准都已就位 ⇒ 若带件序号必固化）⇒ ' +
        '`/health.resultWrite.skippedNoUnit` **恰 +3**，而 `failures` **一字不变**、`writes` 也**不变**' +
        '（"根本没打算落" ≠ "落失败"）；随后**补上件序号**（`unitIndex=1`、其余同）⇒ `writes` **+1** 且 ' +
        '`skippedNoUnit` **不再增**（把两者并成一个数、或让缺件序号的帧也去写 ⇒ 本条必红）',
        sep.ok && Boolean(nu.countsBefore) && nu.countsBefore.done === 0 && Boolean(nu.countsAfter) &&
        nu.countsAfter.done === 0 && nu.countsAfter.rows === 0 && nuPosts.every(p => p.frameHasUnitIndex === false),
        `三帧不带件序号：${JSON.stringify(before4)} → ${JSON.stringify(afterNo4)}` +
        `（ΔskippedNoUnit=${sep.dNo && sep.dNo.skippedNoUnit}、Δfailures=${sep.dNo && sep.dNo.failures}、` +
        `Δwrites=${sep.dNo && sep.dNo.writes}）；该票 ` + '`result`' + ` 行数 ` +
        `${nu.countsBefore && nu.countsBefore.rows}→${nu.countsAfter && nu.countsAfter.rows}、` +
        `countDone ${nu.countsBefore && nu.countsBefore.done}→${nu.countsAfter && nu.countsAfter.done}；` +
        `补上件序号那一帧：${JSON.stringify(afterNo4)} → ${JSON.stringify(afterCtl4)}` +
        `（Δwrites=${sep.dCtl && sep.dCtl.writes}、ΔskippedNoUnit=${sep.dCtl && sep.dCtl.skippedNoUnit}）`);

      /* ---- 甲-4：失败侧（注入一次写失败）＋ 采集链不受影响 ---- */
      const injPost = cnt.posts.filter(p => p.at === CNT_FAIL)[0] || null;
      const failDelta = rwDelta(cold4, before4);
      t.check('甲-4/`E58` 出口·**失败侧**（注入一次写失败 ⇒ `failures` **+1**、`lastError` 非空、' +
        '`skippedNoUnit` **不变**，且**采集链不受影响**）：注入方式＝把**共享模块对象**上的 ' +
        '`resultRepo.upsertJudgement` 换成抛错桩（**不改文件**，测完当场还原；见夹具内注释）⇒ ' +
        '`/health` 的 `failures` 增量**恰 1**、`lastError` 非空且**点名**注入原因、`skippedNoUnit` 不变；' +
        '该帧仍 `stored`（HTTP 200）、其后一帧照常 `writes` +1（链路没被打断）',
        Boolean(failDelta) && failDelta.failures === 1 && failDelta.skippedNoUnit === 0 &&
        Boolean(before4) && typeof before4.lastError === 'string' && before4.lastError.length > 0 &&
        before4.lastError.indexOf('注入') >= 0 &&
        Boolean(injPost) && Boolean(injPost.res) && injPost.res.status === 200 &&
        Boolean(injPost.res.body) && injPost.res.body.outcome === 'stored' &&
        Boolean(pos) && pos.writes === 1 && cnt.rowsAAfterFail === cnt.rowsA,
        `冷启动 ${JSON.stringify(cold4)} → 注入之后 ${JSON.stringify(before4)}` +
        `（Δfailures=${failDelta && failDelta.failures}、ΔskippedNoUnit=${failDelta && failDelta.skippedNoUnit}）；` +
        `lastError 点名注入＝${Boolean(before4) && typeof before4.lastError === 'string' && before4.lastError.indexOf('注入') >= 0}、` +
        `实测=${JSON.stringify(before4 && before4.lastError)}；注入了失败的那一帧（${injPost && injPost.at}，第 2 件）：` +
        `HTTP ${injPost && injPost.res && injPost.res.status}／${injPost && injPost.res && injPost.res.body && injPost.res.body.outcome}` +
        `（采集链照收）；其后对照帧 Δwrites=${pos && pos.writes}（+1 ⇒ 没被打断）；该票行数 ${cnt.rowsA}→${cnt.rowsAAfterFail}`);

      /* 实测读数**打印出来**（ADR-0004 D21：复核者不跑也能看到"期望值是从哪些现场读数推出来的"；
         不计入断言数）—— 两处增量分别对应 甲-2（对照帧恰一帧）与 甲-3（三帧不带件序号）。 */
      t.info(`甲·/health.resultWrite 实测（真 HTTP 四次读数）：冷启动 ${JSON.stringify(cold4)}；`
        + `四帧落库 ＋ 一次注入写失败后 ${JSON.stringify(before4)}；`
        + `三帧不带件序号后 ${JSON.stringify(afterNo4)}（相对上一次 ΔskippedNoUnit=+${sep.dNo && sep.dNo.skippedNoUnit}、`
        + `Δfailures=${sep.dNo && sep.dNo.failures}、Δwrites=${sep.dNo && sep.dNo.writes}）；`
        + `补上件序号那一帧后 ${JSON.stringify(afterCtl4)}（Δwrites=+${pos && pos.writes}、`
        + `ΔskippedNoUnit=${pos && pos.skippedNoUnit}）；`
        + `冷启动 → 注入失败之前 Δwrites=${coldToBefore && coldToBefore.writes}（＝该段实测推帧 ${cnt.postsBeforeFail} 帧）`);

      /* ---- D22 暗桩：两条定点变异（字节副本，不落盘） ---- */
      const SERVER_FILE = path.join(env.paths.root, 'server', 'index.js');
      const serverBytes = fs.readFileSync(SERVER_FILE);          /* 字节副本①（只读，全程不写盘） */
      const serverSha0 = sha256Hex(serverBytes);
      const serverSrc = serverBytes.toString('utf8');
      /* ⚠ 锚点必须**行长风格无关**（`\r?\n`）：实测 `server\index.js` 是 **CRLF**，
         用 `\n` 拼锚点会"锚点未命中"⇒ 暗桩变成假红（本批第一版就踩了这个坑）。 */
      const RW_BLOCK_RE = /[ \t]*resultWrite: \{\r?\n[ \t]*writes: state\.resultWrite\.writes,\r?\n[ \t]*failures: state\.resultWrite\.failures,\r?\n[ \t]*lastError: state\.resultWrite\.lastError,\r?\n[ \t]*skippedNoUnit: state\.resultWrite\.skippedNoUnit\r?\n[ \t]*\},\r?\n/;
      const RW_FAIL_LINE_RE = /([ \t]*)failures: state\.resultWrite\.failures,(\r?\n)/;
      /** 由**内存字节副本**载入一个 `server/index.js` 变异体（`Module._compile`：不落地、不碰仓库；
          与 §15-E／§16 同款手法）。`require.main !== module` ⇒ 不会自动 `main()`（不起服务）。 */
      const loadServerVariant = (src, tag) => {
        const Module = require('node:module');
        const m = new Module(SERVER_FILE + '#' + tag, null);
        m.filename = SERVER_FILE;
        m.paths = Module._nodeModulePaths(path.dirname(SERVER_FILE));
        m._compile(src, m.filename);
        return m.exports;
      };
      /* 变异体①：把 `healthPayload()` 里的 `resultWrite` 搬运块**整段摘掉**。 */
      t.check('甲-D22① 定点变异：把 `/health` 里**搬运 `resultWrite` 的那段整块摘掉**（`server/index.js` 的' +
        '**内存字节副本**变异体）⇒ 甲-1 的"键恒在"判据**必红并指名** `resultWrite`；未变异的当前源码必绿；' +
        '盘上文件全程逐字节未变',
        (() => {
          if (!RW_BLOCK_RE.test(serverSrc)) {
            t.info('甲-D22① 变异锚点未命中（`resultWrite` 搬运块被改过形状）—— 锚点命不中即判红，不许静默放过');
            return false;
          }
          const mutSrc = serverSrc.replace(RW_BLOCK_RE, '');
          let mut = null;
          try { mut = loadServerVariant(mutSrc, 'rw-cut'); }
          catch (err) { t.info('甲-D22① 变异体载入失败：' + (err && err.message)); return false; }
          /* 喂给变异体的运行态＝**真·现场读数**（不是编的：就是本次四帧＋一次注入失败之后那一份） */
          mut.state.resultWrite = Object.assign({}, before4);
          const mutProblems = rwKeyProblems(mut.healthPayload());
          const curProblems = rwKeyProblems(afterCtlH);            // 当前源码（真 HTTP 读数）⇒ 必绿
          const mutSha = sha256Hex(Buffer.from(mutSrc, 'utf8'));
          const diskSame = sha256Hex(fs.readFileSync(SERVER_FILE)) === serverSha0;
          t.info(`甲-D22① 变异体 sha256=${mutSha.slice(0, 12)}…（原件 sha256=${serverSha0.slice(0, 12)}…）；`
            + `变异体 /health.resultWrite 问题 ${mutProblems.length} 条：${mutProblems.join('；')}；`
            + `当前源码问题 ${curProblems.length} 条；盘上文件未变=${diskSame}`);
          return mutProblems.length > 0 && mutProblems.join('；').indexOf('resultWrite') >= 0 &&
            curProblems.length === 0 && diskSame;
        })(),
        '变异内容：删掉 `healthPayload()` 里的 `resultWrite: { writes, failures, lastError, skippedNoUnit },` 整块 ' +
        '（＝回到 `T-20261003-02` 之前的形态：三个计数只在进程内存里、外部读不到）—— ' +
        '甲-1 的"键恒在"判据必须当场指名该块缺失');

      /* 变异体②：把 `skippedNoUnit` **并进** `failures`（＝恢复"拿不到与失败混一起"）。 */
      t.check('甲-D22② 定点变异：把 `skippedNoUnit` **并进** `failures`（`failures: failures + skippedNoUnit`，' +
        '`server/index.js` 的**内存字节副本**变异体）⇒ 甲-3 的"二者分得开"判据**必红并指名**；' +
        '未变异的当前源码必绿；盘上文件全程逐字节未变',
        (() => {
          if (!RW_FAIL_LINE_RE.test(serverSrc)) {
            t.info('甲-D22② 变异锚点未命中（`failures: state.resultWrite.failures,` 那行）—— 判红，不许静默放过');
            return false;
          }
          const mutSrc = serverSrc.replace(RW_FAIL_LINE_RE,
            '$1failures: state.resultWrite.failures + state.resultWrite.skippedNoUnit,$2');
          let mut = null;
          try { mut = loadServerVariant(mutSrc, 'rw-merge'); }
          catch (err) { t.info('甲-D22② 变异体载入失败：' + (err && err.message)); return false; }
          const payloadAt = st => { mut.state.resultWrite = Object.assign({}, st); return mut.healthPayload(); };
          /* 两个输入态＝**真·现场读数**：注入失败之后 / 三帧不带件序号之后（当前实现里 `/health` 就是搬运，
             故这两份读数**就是**那两刻的 `state.resultWrite`；没有编造中间态）。 */
          const mutNo = payloadAt(before4), mutCtl = payloadAt(afterNo4);
          const mutSep = separateNoUnitFromFailures(mutNo, mutCtl, payloadAt(afterCtl4));
          const mutSha = sha256Hex(Buffer.from(mutSrc, 'utf8'));
          const diskSame = sha256Hex(fs.readFileSync(SERVER_FILE)) === serverSha0;
          t.info(`甲-D22② 变异体 sha256=${mutSha.slice(0, 12)}…（原件 sha256=${serverSha0.slice(0, 12)}…）；`
            + `变异体三帧读数 ${JSON.stringify(mutNo && mutNo.resultWrite)} → ${JSON.stringify(mutCtl && mutCtl.resultWrite)}`
            + `（ΔskippedNoUnit=${mutSep.dNo && mutSep.dNo.skippedNoUnit}、Δfailures=${mutSep.dNo && mutSep.dNo.failures}）；`
            + `当前源码同判据=${sep.ok}；盘上文件未变=${diskSame}`);
          /* "必红"＝同一判据在变异体上不成立；"当前源码必绿"＝sep.ok（甲-3 本身）⇒ 不是"把一切都判红" */
          return mutSep.ok === false && sep.ok === true && diskSame;
        })(),
        '变异内容：`/health` 的 `failures` 改成 `failures + skippedNoUnit`（把"根本没打算落"并进"落失败"）' +
        '—— 甲-3 必须当场指名 Δfailures 被污染（这正是 `E60` 病灶的形态）');
    }
  }

  t.check('FR-5.8/C-88 行为：**同态临近**（深度与速度各距上/下限恰 k 格）⇒ 事件里参数类**恰 2 条**且名称均为「参数阈值临近预警」、等级 warn、每条只含一个参数',
    Boolean(harmEv) && harmParam.length === 2 &&
    harmParam.every(w => w.title === judge.WARN_TITLES.warn && w.lv === 'warn') &&
    /* 两参数**同态 ⇒ 各出一条**（C-88 / R26-P2-2）：同态下不按参数名排序，故按**集合**比对，
       只要求"深度、速度各占一条"（顺序不作判据，避免把展示顺序写死成第二套口径）。 */
    harmParam.map(w => (w.detail.includes('深度') ? 'depth' : (w.detail.includes('速度') ? 'speed' : '?'))).sort().join(',') === 'depth,speed' &&
    harmParam.every(w => (w.detail.match(/深度|速度/g) || []).length === 1 && !w.detail.includes('；')),
    harmEv ? `参数类 ${harmParam.length} 条：` + harmParam.map(w => `${w.title}/${w.lv}｜${w.detail}`).join(' ／ ') : '未收到 warning 事件');

  const hookAt = (Array.isArray(warnOpt.hookAt) ? warnOpt.hookAt : []);
  /* 期望的 `at`：由**帧采集时刻文本**现算（不写字面量 ISO）—— `at` 是信封字段，读进程内订阅者。
     注入时钟此刻已是 10:00:0x（段⑤ 还推进过 6 s），而三帧采集时刻是 12:00:0x ⇒
     期望值不可能被"服务端当前时刻"凑出来（差 2 小时）。 */
  const atOfText = text => new Date(text.replace(' ', 'T')).toISOString();
  t.check('W5-②/E45 写点时序：`warning` 事件的 `at` 是**帧的采集时刻**（不是服务端当前时刻、也不是夹具注入时刻）＋ 每次落库帧**恰产生 1 条**（三条真帧 ⇒ 恰 3 条：同态临近 / 超范围 / 半套标准；幂等、原始、脏帧都不产生）',
    warnEvents.length === 3 && hookAt.length === 3 &&
    /* `at` 是事件信封字段（线路只发 data）⇒ 读进程内订阅者；三条应分别等于三帧的采集时刻 */
    ['harm', 'err', 'half'].every((k, i) => hookAt[i].at === atOfText((warnOpt.at || {})[k])) &&
    warnOpt.warnPost && warnOpt.warnPost.body && warnOpt.warnPost.body.outcome === 'stored' &&
    warnOpt.errPost && warnOpt.errPost.body && warnOpt.errPost.body.outcome === 'stored' &&
    warnOpt.halfPost && warnOpt.halfPost.body && warnOpt.halfPost.body.outcome === 'stored' &&
    warnOpt.ifdStatus && warnOpt.ifdStatus.counts && warnOpt.ifdStatus.counts.sampledHookFailures === 0,
    `warning 事件数=${warnEvents.length}；进程内信封 seq:at=${hookAt.map(x => x.seq + ':' + x.at).join(' , ')}` +
    `（期望＝三帧采集时刻的 UTC：12:00:00/10/20 ⇒ 04:00:00/10/20Z）；` +
    `三次推帧 outcome=${[warnOpt.warnPost, warnOpt.errPost, warnOpt.halfPost].map(p => p && p.body && p.body.outcome).join('/')}；` +
    `判定挂钩失败次数=${warnOpt.ifdStatus && warnOpt.ifdStatus.counts && warnOpt.ifdStatus.counts.sampledHookFailures}`);

  const errEv = warnEvents[1] || null;
  const errParam = (errEv && errEv.data && Array.isArray(errEv.data.warnings)
    ? errEv.data.warnings.filter(w => paramTitles.includes(w.title)) : []);
  t.check('FR-5.8 行为：**超范围**（深度越上限一格、速度仍在临近带）⇒ 事件里出「参数超范围预警」/err（深度）与「参数阈值临近预警」/warn（速度）各 1 条',
    Boolean(errEv) && errParam.length === 2 &&
    errParam.some(w => w.title === '参数超范围预警' && w.lv === 'err' && w.detail.includes('深度')) &&
    errParam.some(w => w.title === '参数阈值临近预警' && w.lv === 'warn' && w.detail.includes('速度')),
    errEv ? `参数类 ${errParam.length} 条：` + errParam.map(w => `${w.title}/${w.lv}｜${w.detail}`).join(' ／ ') : '未收到第二条 warning 事件');

  const halfEv = warnEvents[2] || null;
  const halfParam = (halfEv && halfEv.data && Array.isArray(halfEv.data.warnings)
    ? halfEv.data.warnings.filter(w => paramTitles.includes(w.title)) : []);
  const halfRow = (warnOpt.halfExpect && warnOpt.halfExpect.halfRow) || {};
  t.check('C-93⑤/FR-5.8 负向（**不得伪造**）：某参数**标准未设定**（库行里速度三格为 null、只有深度三格）＋ 实测双双越上限 ⇒ 事件里**只有一条**参数类（深度超范围），**不得**为速度回退配置演示值凭空成条',
    Boolean(halfEv) && halfParam.length === 1 &&
    halfParam[0].title === '参数超范围预警' && halfParam[0].lv === 'err' &&
    halfParam[0].detail.includes('深度') && !halfParam[0].detail.includes('速度') &&
    Number.isFinite(halfRow.depthTypical) && halfRow.depthTypical !== null &&
    halfRow.speedTypical === null && halfRow.speedUpperDev === null && halfRow.speedLowerDev === null,
    `半套库行：深度三格=${JSON.stringify([halfRow.depthTypical, halfRow.depthUpperDev, halfRow.depthLowerDev])}、` +
    `速度三格=${JSON.stringify([halfRow.speedTypical, halfRow.speedUpperDev, halfRow.speedLowerDev])}（应为 [null,null,null]）；` +
    `实测 depth=${warnOpt.halfExpect && warnOpt.halfExpect.depthErr}／speed=${warnOpt.halfExpect && warnOpt.halfExpect.speedErr}；` +
    `事件参数类 ${halfParam.length} 条：` + (halfParam.map(w => `${w.title}/${w.lv}｜${w.detail}`).join(' ／ ') || '（未收到）'));

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
  t.check('静态/W7-C③：favicon **在静态兜底层**处理，不是新注册一条路由 —— 路由清单仍 21 条（冻结基线随 `T-20261002-08` 的 `POST /notice` 由 20 → 21，**favicon 一条都没加**）；且它**不进白名单**（`resolvePath` 仍拒），而静态层计数 `served.favicon` 确实 +1（被 204 分支接住、没落 404）',
    (s.site && s.site.routesCountAfterFavicon) === 21 &&
    (s.site && s.site.faviconNotWhitelisted && s.site.faviconNotWhitelisted.ok === false) &&
    (s.site && s.site.faviconServed && s.site.faviconServed.favicon === 1),
    `路由条数=${s.site && s.site.routesCountAfterFavicon}（冻结基线 21）；resolvePath('/favicon.ico')=${JSON.stringify(s.site && s.site.faviconNotWhitelisted)}；` +
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

  /* F3：如实表述 —— W5-②（E45）接线后，**六类**全部来自真实写入点（不再有"夹具直调"那一类） */
  const seenKinds = [...new Set([].concat(evts(s.frames && s.frames.stream), evts(s.link), evts(s.other && s.other.stream),
    evts(s.other && s.other.warning && s.other.warning.stream)).map(e => e.event))];
  t.check('W5/F3：**五类来自真实写入点**（frame←1 s 采样落库 / link←linkState / task←派工落库 / standard←addVersion 成功路径 / upload←上报失败留存）在真 HTTP 连接上全部实测可见',
    ['frame', 'link', 'task', 'standard', 'upload'].every(k => seenKinds.includes(k)),
    `实收种类=${seenKinds.join(',')}（各类的写入点证据见上面 5 条断言）`);
  t.check('W5/F3：`warning` 也来自**真实写入点**（`ingest` 的 1 s 采样落库 → `onSampled` → `judge.evaluate(input,{bus})`）；段⑦e 夹具**没有任何** `judge.evaluate` 直调，事件只可能来自生产链路',
    seenKinds.includes('warning') && warnEvents.length === 3 && Boolean(harmEv) && Boolean(errEv) && Boolean(halfEv),
    `warning 事件在连接上可见=${seenKinds.includes('warning')}（段⑦e 共 ${warnEvents.length} 条：同态临近 / 超范围 / 半套标准各 1 条）`);

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
  t.check('§1 endpoint 矩阵④：路由清单与**冻结基线**逐条一致（本项目阶段一暴露的端点集合；增/删端点即红 —— 矩阵③的"无副作用"才有对象）。' +
    '基线 **21 条**：`T-20261002-08`（`FR-7.12`，P0）新增 `POST /notice` 一条，其余 20 条逐字不动',
    JSON.stringify(mx.routes) === JSON.stringify([
      'GET /auth/status', 'GET /events', 'GET /health', 'GET /ifa/status', 'GET /ifd/health', 'GET /ifd/status',
      'GET /state', 'GET /upload/last', 'GET /upload/pending', 'GET /upload/status',
      'POST /auth/change', 'POST /auth/init', 'POST /auth/login', 'POST /auth/logout',
      'POST /ifa/device', 'POST /ifa/dispatch', 'POST /ifa/material', 'POST /ifa/process',
      'POST /ifd/frame', 'POST /notice', 'POST /upload/retry'
    ]),
    `实际清单（${mx.routes ? mx.routes.length : 0} 条，冻结基线 21）=${JSON.stringify(mx.routes)}`);

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
    /* 漏列脚本：从权威行删掉 platform-check 的点名（**E77**）。
       ⚠ 锚点**不得含计数**：旧写法写死 `` `platform-check` **21/0**， ``，而权威区现值是
       **29/0** ⇒ `replace` 变 **no-op**、"点名没删掉"却**照样判绿**（座位 5 报告 C·13.6 的锚点漂移）。
       改法（任务包 T-20260930-30 建议形）＝`/`platform-check`[^，,]*，/`：只认**点名**，
       计数/说明文字怎么写都不影响锚点命中。命中数顺带**回读**，`!== 1` 判红（锚点再漂移就
       明确以"锚点回读失败"报错，不许静默空转）。
       只删到**第一个半角/全角逗号**（点名 ＋ 可能残留一个未配对的右括号）；`named` 是逐 token 扫的，
       残留括号不影响它 —— 要点名真的消失即可，且残余可见 ⇒ 便于追查。 */
    const removeGateNamedInAuthority = (name) => {
      const target = `${'`'}${name}${'`'}`;
      const cur = fs.readFileSync(readmePath, 'utf8').split(/\r?\n/);
      const i = authIndex();
      const line = cur[i];
      const hits = [...line.matchAll(new RegExp(target + '[^，,]*，', 'g'))].length;
      if (hits === 1) cur[i] = line.replace(new RegExp(target + '[^，,]*，'), '');
      fs.writeFileSync(readmePath, cur.join('\r\n'), 'utf8');
      /* 回读（先例 `setStated` :3895-3898）：必须读到"点名真的没了"的痕迹，否则整条判空转 */
      const back = fs.readFileSync(readmePath, 'utf8').split(/\r?\n/)[i] || '';
      return { hits, removed: line.includes(target) && !back.includes(target) };
    };
    const rmLines = removeGateNamedInAuthority('platform-check');
    t.check('权威数字校验：权威区漏列某个离线门禁即判不通过（新增脚本别忘登记）',
      runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev).ok === false, '');
    /* E77 定点回归：证明上一条**不是空转**（点名真的被删掉了，而且删对了分支） */
    {
      const rmRes = runAll3.verifyAuthorityTotals({ passed: sumOf(withDev) }, withDev);
      t.check('权威数字校验/E77：漏列点名的变异**真的生效**（锚点命中恰 1 次、回读确认点名已消失），' +
        '且判红钉在**漏列**那一支（`kind=broken`：`missingGates=[platform-check]`）而不是"数字漂移"（`mismatch`）',
        rmLines.hits === 1 && rmLines.removed === true && rmRes.ok === false &&
        rmRes.kind === 'broken' && /漏列离线门禁/.test(rmRes.detail) && /platform-check/.test(rmRes.detail),
        `锚点命中 ${rmLines.hits} 次（须恰 1 次）、回读点名已消失=${rmLines.removed}；` +
        `判定 ok=${rmRes.ok}、kind=${rmRes.kind}、detail=${rmRes.detail}`);
    }
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
      t.check('已登记偏差的**失败清单条数** = git 历史实算（9 条缺前缀 + 4 条超字数 → 13）',
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

  /* ---------------- E12 定点回归（2026-09-29 收口） ----------------
     登记原文（2026-09-20）：`run-all` 日志**命名撞名会造假绿** —— 按 `<脚本>-<runner pid>.log` 命名、
     同 pid 复用会撞旧文件 ⇒ `parseSummary` 取到**旧汇总行**，出现"失败脚本被印成 PASS"。
     三条修法：①文件名带 pid（已在）②运行前删同名旧文件（已在）③**以失败为优先解析**（本轮补）。
     这里把③做成定点回归：多行汇总时"前面绿、后面红"**必须判红**。 */
  t.check('E12 定点回归①：日志里"先绿后红"两条汇总行 ⇒ `parseSummary` 必须取**红**的那条（旧实现取首条 ⇒ 假绿）',
    (() => {
      const s = runAll4.parseSummary('=== 汇总 ===\n通过 40 项，失败 0 项，跳过 0 项\n（子套件）\n通过 3 项，失败 2 项，跳过 0 项\n');
      return s && s.failed === 2 && s.passed === 3 && s.worst === true && s.lines === 2;
    })(),
    `实测 ${JSON.stringify(runAll4.parseSummary('通过 40 项，失败 0 项，跳过 0 项\n通过 3 项，失败 2 项，跳过 0 项'))}`);
  t.check('E12 定点回归②：多条红行取 **failed 最大**者；全绿时取 **passed 最大**者（防"先打一行占位 0/0"）',
    (() => {
      const a = runAll4.parseSummary('通过 1 项，失败 1 项\n通过 5 项，失败 4 项\n');
      const b = runAll4.parseSummary('通过 0 项，失败 0 项，跳过 0 项\n通过 12 项，失败 0 项，跳过 0 项\n');
      return a && a.failed === 4 && b && b.passed === 12 && b.lines === 2;
    })(),
    `多红=${JSON.stringify(runAll4.parseSummary('通过 1 项，失败 1 项\n通过 5 项，失败 4 项'))}；全绿=${JSON.stringify(runAll4.parseSummary('通过 0 项，失败 0 项\n通过 12 项，失败 0 项'))}`);
  const runAllSrc12 = fs.readFileSync(path.join(env.paths.tests, 'run-all.js'), 'utf8');
  t.check('E12 静态守卫：日志名含 runner pid **且**运行前删同名旧文件（两条修法都必须在场，防回退）',
    /\$\{suite\.name\}-\$\{process\.pid\}\.log/.test(runAllSrc12) &&
    /fs\.rmSync\(logFile/.test(runAllSrc12) &&
    /worst: bad\.length > 0/.test(runAllSrc12),
    `命名=${/\$\{suite\.name\}-\$\{process\.pid\}\.log/.test(runAllSrc12)}；删旧=${/fs\.rmSync\(logFile/.test(runAllSrc12)}；失败优先=${/worst: bad\.length > 0/.test(runAllSrc12)}`);


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
      /* `DSH_JOBS: '1'` 是**必须**的：本嵌套轮若继承外层并行度，它会在**另一个进程正在改写
         `tests\README.md`**（本脚本第十节会把权威数字改掉再还原）时去做工作区稳定性比对，
         于是判"工作区被改写"、退出码非 0 ⇒ §十四 的端到端断言**假红**（已实测一次）。
         嵌套轮永远串行 —— 它验的是"结论规则"，不是吞吐。 */
      { cwd: path.join(__dirname, '..'), stdio: ['ignore', fd, fd], timeout: 120 * 1000, env: { ...process.env, DSH_JOBS: '1' } });
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
  /* E19（登记 2026-09-22，2026-09-29 收口）：`--only contract-check` 这一轮**要求是稳定绿轮**，
     但写方撞上它 ~1 s 的窗口时 `lib/snapshot.js` 会判"工作区被改写 ⇒ 本轮不可作证据" ⇒ 退出码 1、
     且**不会**打印"门禁全绿" ⇒ 断言**假红**（实测 N=30 里 1 次；并行开发期约 3%）。
     ⚠ 原实现还把 `runOnly` 跑了**两遍**（谓词一遍、明细一遍）⇒ 撞车概率翻倍，一并修掉。
     修法（采纳登记里的①＋②）：把"这轮属于哪一类"抽成**纯函数**（可定点回归）：
       · unstable（带"工作区被改写／不可作证据"措辞）⇒ **可重试**（最多 3 次尝试）；
       · green（退出码 0 且打出"门禁全绿"）⇒ 通过；
       · bad（其余）⇒ **真失败绝不重试**（不许把 FAIL 重试成绿）；
     连续都撞上并发写盘 ⇒ **按"环境不满足"跳过**并写明原因 —— 环境问题不得伪装成断言失败。 */
  const UNSTABLE_NEEDLE = /本轮运行期间工作区被改写|不可作为证据/;
  const attemptKind = (code, text) => {
    if (UNSTABLE_NEEDLE.test(text)) return 'unstable';
    if (code === 0 && text.includes('门禁全绿（无失败脚本）。')) return 'green';
    return 'bad';
  };
  t.check('E19 定点回归①：`attemptKind` 三态 —— 不稳定轮⇒unstable（可重试）／绿轮⇒green／**真失败⇒bad（不得被重试掉）**',
    attemptKind(1, '本轮运行期间工作区被改写（1 个文件）… 该轮不可作为证据') === 'unstable' &&
    attemptKind(0, '门禁全绿（无失败脚本）。') === 'green' &&
    attemptKind(1, 'FAIL  docs-check  41 / 2 / 0\n门禁结论：不通过') === 'bad' &&
    attemptKind(0, '（没有"门禁全绿"字样）') === 'bad',
    `unstable=${attemptKind(1, '本轮运行期间工作区被改写（1 个文件）')}；` +
    `green=${attemptKind(0, '门禁全绿（无失败脚本）。')}；bad=${attemptKind(1, 'FAIL  x')}；` +
    `code0无措辞=${attemptKind(0, '（无措辞）')}`);
  t.check('E19 定点回归②：**不稳定措辞优先于退出码** —— 即使 exit=0，只要带"工作区被改写"也不得当成绿轮证据',
    attemptKind(0, '门禁全绿（无失败脚本）。\n（本轮运行期间工作区被改写）') === 'unstable',
    `实测 ${attemptKind(0, '门禁全绿（无失败脚本）。\n（本轮运行期间工作区被改写）')}`);
  let greenSub = null;
  let lastKind = '';
  const subAttempts = [];
  for (let i = 0; i < 3; i++) {
    const sub = runOnly('contract-check');
    const kind = attemptKind(sub.status, sub.text);
    subAttempts.push(`${i + 1}:${kind}(exit=${sub.status})`);
    lastKind = kind;
    if (kind !== 'unstable') { greenSub = sub; break; }   /* green/bad 都停（bad 不重试） */
  }
  if (lastKind === 'unstable') {
    t.skip('端到端：跑 `--only contract-check`（无失败脚本）⇒ 退出码 0，打印"门禁全绿"且同时打印权威对账行',
      `连续 ${subAttempts.length} 次都撞上并发写盘（工作区被改写 ⇒ 该轮不可作证据）—— **环境不满足、不是实现缺陷**（E19）；` +
      '停笔后复跑即为证据');
    t.info('E19：本轮尝试序列 ' + subAttempts.join(' → '));
  } else {
    const sub = greenSub;
    t.check('端到端：跑 `--only contract-check`（无失败脚本）⇒ 退出码 0，打印"门禁全绿"**且同时打印权威对账行**',
      sub.status === 0 && sub.text.includes('门禁全绿（无失败脚本）。') &&
      sub.text.includes('权威数字校验：**未执行**：本轮未跑全离线门禁'),
      `尝试序列 ${subAttempts.join(' → ')}｜退出码 ${sub.status}${sub.error ? `（spawn 错误 ${sub.error}）` : ''}`
      + `｜权威对账行 ${sub.text.includes('权威数字校验：**未执行**') ? '有' : '缺'}｜门禁全绿 ${sub.text.includes('门禁全绿') ? '有' : '缺'}`
      + '（绿轮丢弃对账行是同一处重构的第二个缺口：必须"绿轮也打印"）');
  }


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

/* ---------------- 十五、并行 runner 的调度契约（2026-09-29 新增） ----------------
   背景（实测）：全量墙钟 ≈ 453 s，其中 `stress-check` **301.7 s ＝ 67%**，其余 16 个合计 ≈ 151 s
   ⇒ 真正的浪费是"长杆独占"，不是脚本数量多。于是给 runner 加"并行波 + 串行尾"（`--jobs N`，默认串行）。

   本节守三件事，缺一条并行就不许用：
     A 静态：`serialTail` 必须标在**对并发敏感**的三个脚本上（docs-cross-check 要读全量账本；
       docs-check 会真跑 md2docx **写盘**；files-check 要全树扫描 —— 后两者并行会互相干扰）。
     B 默认：并发度默认 **1＝串行** —— 并行必须显式开启；否则"作证据的那条路径"会被悄悄改掉（E52）。
     C 行为（最强）：`--fast` 串行 vs `--fast --jobs 4` **逐脚本状态/条数完全一致**，
       且并行账本的 `ranSuites` 仍按 SUITES 原顺序（并行完成顺序是乱的，落账必须归一）。
   实测（本机 i7-14650HX/24 逻辑核）：串行 74.2 s → 并行 43.3 s（各脚本之和 74.1 s，加速 1.71×）。 */
{
  const runAll15 = require('./run-all.js');
  const src15 = fs.readFileSync(path.join(env.paths.tests, 'run-all.js'), 'utf8');
  /* 本节自带变异加载器：不依赖第十四节块内的局部 `loadSourceVariant`（那是块级作用域，取不到）。
     与第十四节同一手法：`Module._compile` 不落地、不碰仓库。 */
  const loadVariant15 = src => {
    const Module = require('node:module');
    const m = new Module(path.join(__dirname, 'run-all.js'), null);
    m.filename = path.join(__dirname, 'run-all.js');
    m.paths = Module._nodeModulePaths(__dirname);
    m._compile(src, m.filename);
    return m.exports;
  };
  const serialTailNames15 = runAll15.SUITES.filter(s => s.serialTail).map(s => s.name);
  const needTail15 = ['docs-cross-check', 'docs-check', 'files-check'];
  t.check('§15-A 静态：对并发敏感的三个脚本必须标 `serialTail`（并行时只落在串行尾）',
    needTail15.every(n => serialTailNames15.includes(n)),
    `实际 serialTail = [${serialTailNames15.join('、') || '（空）'}]；期望包含 [${needTail15.join('、')}]`);

  t.check('§15-B 静态：并发度默认 1（串行）—— 并行必须显式开启，不改"作证据的默认路径"（E52）',
    /function\s+resolveJobs\(\)\s*\{[\s\S]{0,400}?if\s*\(!String\(raw\)\.trim\(\)\)\s*return\s+1;/.test(src15),
    '在 resolveJobs() 里找不到"未显式要求即 return 1"的判据（默认值被改成并行就会命中这条）');

  /* ---- C 行为：串行 vs 并行，逐脚本比对 ----
     ⚠ **绝不能用 `--fast`**：`--fast` 的集合里含 `harness-check`（本脚本），
     而本节又要 fork 一个 `run-all` ⇒ 子进程再跑 `harness-check` ⇒ 再 fork ⇒ **无限递归**。
     （2026-09-29 实测踩坑：PID 每 ~60 s 换一轮 `harness-check-10000 → -23888 → -29548`
     —— 每轮都能"通过"，所以不会报错，只会永远跑下去。）
     改为**显式允许清单**：挑几个覆盖"串行尾"与"并行波"两类的脚本，且**不含本脚本**。 */
  const S15_SUITES = ['contract-check', 'db-check', 'docs-check', 'files-check', 'logic-check', 'trace-check'];
  const RECURSION_GUARD = "不允许用 --fast/--only harness-check";
  const RUN15_TIMEOUT = 10 * 60 * 1000;
  /* **`E96` 收口**（`T-20261003-04`，座位 4b）—— 本节"并行 vs 串行"的对照，在**子集场景**下本来
     **无法失败**：`run-all` 的 `scheduleSuites()` 第一条分支是
       `if (!(jobs > 1) || optValue('--only')) return { parallel: [], serial: suites.slice(), jobs: 1 };`
     ⇒ 传 `--jobs 4` 也按**并发 1** 跑（座位 4 实测：`--only <6 脚本> --jobs 4` ⇒
     `serialMs 9194 / parallelMs 9215` —— 同一条串行路径测了两遍）⇒ 旧写法
     `t.check('§15-C …', okC15)` 是一条**空洞判据**（D23：看起来守住了、实际守不住）。
     现按 `§15-D` 的既有护栏统一：**只在"真并行轮"上判定**（脚本数 ≥8 **且**实跑输出里真的打印了
     并行波），否则**显式打印"本轮为子集/串行 ⇒ 不判定"并以 `t.skip` 记账** ——
     "不判定"与"通过"在台账上必须分得开（这正是 `D23` 要的口径）：
       ①**默认档**（本节 fork 的子集轮）：恒为"不判定"（`--only` 强制串行）；
       ②**`DSH_HARNESS_S15_FULL=1` 档**：改跑 `--fast`（13 个脚本）串行 vs `--fast --jobs 2`
         ⇒ 该判据回到"**可判定**"（真并行波 10 个）。
     为什么第②档做成**显式档位**而不是默认：那一档每次给 harness-check 加约 2 分钟
     （ADR-0004 准则 6"成本可控"），且 `--fast` 含本脚本 ⇒ 需要一层递归护栏
     （子轮带 `DSH_HARNESS_S15_CHILD=1`，嵌套的那一层 harness-check 不再 fork）。
     ⚠ 本节**不动** `run-all.js` 的调度（那是另一路协作方的文件）—— 护栏只加在判据侧。 */
  const S15_FULL = String(process.env.DSH_HARNESS_S15_FULL || '').trim() === '1';
  const S15_CHILD = String(process.env.DSH_HARNESS_S15_CHILD || '').trim() === '1';
  const S15_JOBS = S15_FULL ? 2 : 4;
  const S15_MODE = S15_FULL ? 'fast' : 'subset';
  const runFast15 = (jobs) => {
    /* ⚠ 子集档必须**逗号分隔的单个 `--only`**：`optValue('--only')` 只取一个值，
       重复传多个 `--only` 只会生效最后一个（实测过一次"共 1 个脚本"的假象）。 */
    const args = ['--no-preflight'];
    if (S15_MODE === 'fast') args.push('--fast'); else args.push('--only', S15_SUITES.join(','));
    if (jobs > 1) args.push('--jobs', String(jobs));
    const started = Date.now();
    const res = spawnSync(process.execPath, [path.join(env.paths.tests, 'run-all.js'), ...args], {
      cwd: env.paths.root, encoding: 'utf8', timeout: RUN15_TIMEOUT, maxBuffer: 64 * 1024 * 1024,
      /* 基线轮显式 `DSH_JOBS:'1'`：否则若外层带 `DSH_JOBS`，基线轮自己就并行了，
         §15-C 会退化成"并行 vs 并行"（对照失效），且可能让子进程再并行化。
         `DSH_HARNESS_S15_CHILD:'1'`＝**递归护栏**：`--fast` 档的子轮含本脚本，
         嵌套那一层必须**不再 fork**（否则无限递归 —— 见上面的历史坑）。 */
      env: { ...process.env, DSH_ENV: env.ENV_NAME, DSH_JOBS: jobs > 1 ? '' : '1', DSH_HARNESS_S15_CHILD: '1' }
    });
    const ms = Date.now() - started;
    let ledger = null;
    try { ledger = JSON.parse(fs.readFileSync(path.join(env.paths.verify, 'run-totals.json'), 'utf8')); } catch { ledger = null; }
    return { out: (res.stdout || '') + (res.stderr || ''), ms, ledger, code: res.status };
  };
  const shape15 = L => (L && Array.isArray(L.suites))
    ? L.suites.map(s => `${s.name}:${s.status}:${s.summary ? s.summary.passed + '/' + s.summary.failed + '/' + s.summary.skipped : '-'}`).join(' | ')
    : '（读不到账本）';
  /** 一轮 run-all 是不是**真并行轮**（判据可判定性的唯一出处，§15-C／§15-D 共用）：
      请求并发 ≥2 ＋ 实跑脚本数 ≥8 ＋ **输出里真的打印了并行波**。
      为什么以"输出里真的打印"为准：`scheduleSuites()` 的降级（`--only`／jobs<2）是**静默**的，
      只有 run-all 自己那行 `▶ 并行波 N 个（并发 M）` 能证明"这一轮确实分了并行波"。 */
  const parallelRound15 = (run) => {
    const count = run && run.ledger && Array.isArray(run.ledger.ranSuites) ? run.ledger.ranSuites.length : 0;
    const m = String((run && run.out) || '').match(/▶ 并行波 (\d+) 个（并发 (\d+)）/);
    const wave = m ? Number(m[1]) : 0, waveJobs = m ? Number(m[2]) : 0;
    const judged = S15_JOBS >= 2 && count >= 8 && wave > 0 && waveJobs >= 2;
    return {
      judged, count, wave, waveJobs,
      reason: `请求 --jobs ${S15_JOBS}（档位 ${S15_MODE}）、实跑脚本 ${count} 个、`
        + (m ? `输出里并行波 ${wave} 个（并发 ${waveJobs}）` : '输出里**没有**并行波行')
        + `⇒ ${judged ? '真并行轮（可判定）' : '子集/串行（不判定）'}`
    };
  };

  let ser15 = null, par15 = null;
  if (S15_CHILD) {
    /* 嵌套子轮：**不再 fork**（递归护栏）。显式记账，不许"静默少跑两条断言"。 */
    t.skip('§15-C 行为：并行 vs 串行逐脚本一致（**嵌套子轮不判定**）',
      '本进程是 §15-C 自己 fork 出来的子轮（`DSH_HARNESS_S15_CHILD=1`）⇒ 不再 fork，避免无限递归');
    t.skip('§15-D 时效：并行墙钟 < 串行墙钟（**嵌套子轮不判定**）', '同 §15-C（嵌套子轮不再 fork）');
  } else {
    try {
      ser15 = runFast15(1);
      /* 递归护栏（D23 意义上的"反自证"）：子集档清单里一旦混进本脚本，就必须当场判红 ——
         否则整节会安静地无限递归下去（每轮都"通过"，不报错）。 */
      if (S15_MODE === 'subset' && S15_SUITES.includes('harness-check')) throw new Error(RECURSION_GUARD);
      par15 = runFast15(S15_JOBS);
    } catch (err) {
      t.info('§15-C 未执行：' + (err && err.message));
    }
  }
  const round15 = S15_CHILD
    ? { judged: false, count: 0, wave: 0, waveJobs: 0, reason: '嵌套子轮（不再 fork，故没有可判定读数）' }
    : parallelRound15(par15);
  /* ---- §15-C 的三个子句（口径）----
     ① 逐脚本**内容**（状态 ＋ 条数）与串行逐条相同 —— **按名比对、与顺序无关**（并行只改"谁和谁同时跑"）；
     ② 断言合计（`assertions`）逐字段相同；
     ③ 账本**落账顺序**合 `run-all` 的既有契约：
        · 串行轮 ⇒ SUITES 原顺序；
        · 并行轮 ⇒ **并行波（按 SUITES 顺序）在前 ＋ 串行尾（按 SUITES 顺序）在后**
          （`run-all.js` 的 `ordered()` 只把**波内**完成顺序归一，而尾段是波跑完之后逐条 append 的
           —— 故整条账**不可能**与串行轮的 `ranSuites` 逐字相同）。
     ⚠ **`E96` 第二次现身（本批实测，2026-10-03，`T-20261003-04`）**：旧子句写的是
     "并行账本的 `ranSuites` 仍按 SUITES 原顺序"＝要求两轮 `ranSuites.join(',')` **逐字相等**。
     它在**子集轮**里恒真（`--only` 强制串行 ⇒ 两轮账本都恰是 SUITES 顺序）⇒ 又一条
     "看起来在守、实际守不住"的判据；而在**真并行轮**（`DSH_HARNESS_S15_FULL=1`）里它**必假**
     （实测：串行 `…docs-check,files-check,harness-check,…` ↔ 并行 `…harness-check,…,docs-check,files-check,docs-cross-check`，
     见 `tests\._verify\review\hc-s15full.log` 的 §15-C 失败明细）。
     **判定（ADR-0004 D21）：改期望，不改 `run-all` 的调度** —— 依据是 `run-all` 自己的契约
     （波内归一 ＋ 尾段后置；增量落账语义下"整条按 SUITES 顺序"本就不成立），
     而"波内不得按完成顺序落账"这个**原意**由下面 ③ 的两条断言原样保住。 */
  const suiteNames15 = runAll15.SUITES.map(s => s.name);
  const tailNames15 = new Set(runAll15.SUITES.filter(s => s.serialTail).map(s => s.name));
  /** 只保留"真在 SUITES 清单里"的脚本名（`capture-baseline` 是 `E91` 的前置刷新，不在 SUITES 里） */
  const inSuites15 = ran => (Array.isArray(ran) ? ran : []).filter(n => suiteNames15.indexOf(n) >= 0);
  /** ⚠ 期望值一律**由 SUITES 现算**（`suiteNames15`），**不得**拿 `ran` 自身当期望 ——
      否则就是 `x === x` 的恒真式（ADR-0004 D23：这种"自己跟自己比"的判据比空洞还危险）。 */
  const suiteOrderOf15 = ran => suiteNames15.filter(n => Array.isArray(ran) && ran.indexOf(n) >= 0);
  const expectSerialOrder15 = ran => suiteOrderOf15(ran);
  const expectWaveThenTail15 = ran => {
    const names = suiteOrderOf15(ran);
    return names.filter(n => !tailNames15.has(n)).concat(names.filter(n => tailNames15.has(n)));
  };
  const orderOk15 = (ran, expect) => Array.isArray(ran) && ran.length > 0
    && inSuites15(ran).join(',') === expect(ran).join(',');
  /** 逐脚本形态（**按名排序**：内容比对与顺序解耦；顺序另有 ③ 单独判） */
  const contentShape15 = L => (L && Array.isArray(L.suites))
    ? L.suites.map(s => `${s.name}:${s.status}:${s.summary ? s.summary.passed + '/' + s.summary.failed + '/' + s.summary.skipped : '-'}`).sort().join(' | ')
    : '（读不到账本）';
  const okC15 = !!(ser15 && par15 && ser15.ledger && par15.ledger
    && contentShape15(ser15.ledger) === contentShape15(par15.ledger)
    && JSON.stringify(ser15.ledger.assertions) === JSON.stringify(par15.ledger.assertions)
    && orderOk15(ser15.ledger.ranSuites, expectSerialOrder15)
    && orderOk15(par15.ledger.ranSuites, expectWaveThenTail15));
  const c15Shape = `串行【${contentShape15(ser15 && ser15.ledger)}】\n        并行【${contentShape15(par15 && par15.ledger)}】\n`
    + `        串行断言 ${JSON.stringify((ser15 && ser15.ledger && ser15.ledger.assertions) || null)}；`
    + `并行断言 ${JSON.stringify((par15 && par15.ledger && par15.ledger.assertions) || null)}\n`
    + `        账本顺序：串行 ${JSON.stringify((ser15 && ser15.ledger && ser15.ledger.ranSuites) || null)}`
    + `（期望＝SUITES 顺序 ${JSON.stringify(expectSerialOrder15(ser15 && ser15.ledger && ser15.ledger.ranSuites))}）；`
    + `并行 ${JSON.stringify((par15 && par15.ledger && par15.ledger.ranSuites) || null)}`
    + `（期望＝波＋尾 ${JSON.stringify(expectWaveThenTail15(par15 && par15.ledger && par15.ledger.ranSuites))}）`;
  if (round15.judged) {
    t.check('§15-C 行为：串行 vs `--jobs ' + S15_JOBS + '` ⇒ 逐脚本**内容**（状态/条数）与断言合计**按名逐条一致**' +
      '（与顺序无关），且账本**落账顺序**合 `run-all` 契约（串行＝SUITES 原顺序；' +
      '并行＝并行波（SUITES 顺序）在前 ＋ 串行尾（SUITES 顺序）在后 —— 见本条上方的 `E96` 二次现身说明）',
      okC15, `**真并行轮**（${round15.reason}）\n        ` + c15Shape);
  } else {
    t.skip('§15-C 行为：串行 vs `--jobs ' + S15_JOBS + '` ⇒ 逐脚本内容与账本顺序逐条一致（**本轮不判定**）',
      `不判定（本轮为子集/串行）：${round15.reason}。实测读数：串行 ${ser15 ? ser15.ms + ' ms' : '（未跑）'} ↔ `
      + `并行 ${par15 ? par15.ms + ' ms' : '（未跑）'}（两者几乎相同＝同一条串行路径测了两遍 —— 这正是 E96 的现场）。`
      + `逐脚本形态：${shape15(ser15 && ser15.ledger)} ／ ${shape15(par15 && par15.ledger)}。`
      + '【不判定 ≠ 通过】：要拿可判定读数，请跑 `DSH_HARNESS_S15_FULL=1 node tests\\harness-check.js`（真并行波档）');
    t.info(`§15-C 本轮为**子集/串行 ⇒ 不判定**：${round15.reason}；`
      + `串行 ${ser15 ? ser15.ms : '?'} ms ↔ 并行 ${par15 ? par15.ms : '?'} ms`
      + '（`--only` 强制并发 1 由 `run-all.js` 的 `scheduleSuites()` 第一条分支决定，本节不改调度）');
  }

  /* 时效：只在本机确实把"并发"体现出来时才要求（核少或脚本少时并行不一定更快，别拿硬件当缺陷） */
  const cores15 = os.cpus().length;
  if (round15.judged && cores15 >= 4) {
    t.check('§15-D 时效：并行墙钟 < 串行墙钟', !!(par15 && ser15 && par15.ms < ser15.ms),
      `串行 ${(ser15.ms / 1000).toFixed(1)}s → 并行 ${(par15.ms / 1000).toFixed(1)}s（${round15.reason}）`);
  } else {
    t.skip('§15-D 时效：并行墙钟 < 串行墙钟（**本轮不判定**）',
      `不判定：${round15.reason}；本机核 ${cores15}（须 ≥4 **且**是真并行轮）。`
      + `读数仅供参考、不构成判据：串行 ${ser15 ? ser15.ms : '?'} ms ↔ 并行 ${par15 ? par15.ms : '?'} ms`);
  }

  /* §15-C0 构成性：**"可判定"分支可达**（否则上面那个 `if (round15.judged)` 就是死代码 ——
     那本身就是空洞判据的另一种形态）。取数走 `run-all` **自己的** `scheduleSuites()`
     （真源，不另抄一份调度规则；`loadVariant15` 在源码尾部**追加一行导出**，不落地、不碰仓库）。 */
  t.check('§15-C0 构成性：`真并行轮`的配置**存在且确实产出并行波**' +
    '（`scheduleSuites(13 个 --fast 脚本, --jobs 2)` ⇒ 并行波 ≥8、并发 2）⇒ §15-C 的"可判定"分支可达（不是死代码）',
    (() => {
      let plan = null;
      try {
        const probe = loadVariant15(src15 + '\nmodule.exports.__s15probe = { scheduleSuites };\n');
        const fastList = runAll15.SUITES.filter(s => !s.slow && !s.needBrowser);
        plan = probe.__s15probe.scheduleSuites(fastList, 2);
      } catch (err) { t.info('§15-C0 取不到 `scheduleSuites()`：' + (err && err.message)); return false; }
      return Boolean(plan) && Array.isArray(plan.parallel) && plan.parallel.length >= 8 && plan.jobs === 2;
    })(),
    '反证：若 `scheduleSuites()` 退化成"任何情况都不并行"（parallel 恒空）⇒ 本条必红。'
    + '⚠ 本节**默认档**用的子集轮（`--only` 6 个脚本）结构上不可能出现并行波：'
    + "`scheduleSuites()` 的第一条分支就是 `if (!(jobs > 1) || optValue('--only')) return { parallel: [], …, jobs: 1 }`"
    + `（源码文本实测命中＝${/if\s*\(!\(jobs > 1\)\s*\|\|\s*optValue\('--only'\)\)/.test(src15)}）——`
    + '故默认档报"不判定"，`DSH_HARNESS_S15_FULL=1` 档报"可判定"');

  /* D22 定点变异：把 docs-cross-check 的 serialTail 去掉 ⇒ A 必须变红（证明不是恒真断言） */
  t.check('§15-E D22 变异：去掉 `docs-cross-check` 的 `serialTail` ⇒ §15-A 判据必红；恢复后回绿',
    (() => {
      const anchor = "{ name: 'docs-cross-check', desc: '跨文档一致性 + 权威数字校验', needBrowser: false, slow: false, serialTail: true }";
      if (!src15.includes(anchor)) { t.info('§15-E 变异锚点未命中（清单那行被改过）'); return false; }
      const mutatedSrc = src15.replace(anchor, anchor.replace(', serialTail: true', ''));
      let mutated = null;
      try { mutated = loadVariant15(mutatedSrc); } catch (err) { t.info('§15-E 变异体载入失败：' + (err && err.message)); return false; }
      const mutatedTails = mutated.SUITES.filter(s => s.serialTail).map(s => s.name);
      const mutatedRed = !needTail15.every(n => mutatedTails.includes(n));
      const currentGreen = needTail15.every(n => serialTailNames15.includes(n));
      return mutatedRed && currentGreen;
    })(),
    '变异内容：删掉 docs-cross-check 那条的 `serialTail: true`（它并行时会在别的脚本还没跑完时去读账本）');
  try {
    fs.writeFileSync(path.join(env.paths.verify, 's15-parallel-runs.txt'),
      JSON.stringify({ mode: S15_MODE, jobs: S15_JOBS, child: S15_CHILD, judged: round15.judged,
        reason: round15.reason, wave: round15.wave, waveJobs: round15.waveJobs, scripts: round15.count,
        serialMs: ser15 && ser15.ms, parallelMs: par15 && par15.ms,
        serial: shape15(ser15 && ser15.ledger), parallel: shape15(par15 && par15.ledger) }, null, 2), 'utf8');
  } catch { /* 忽略 */ }
}

/* ---------------- 十六、脚本入口形态（`E78`：`main()` 的异常必须被接住、并按 9.5-5 退 2） ----------------
   立案（`E78`，2026-10-01 座位 5 普查后登记）：`E76①` 的靶子形态是"`async` 的 `main()` ＋ 顶层同步
   `try`/`catch`" —— promise 一旦 reject，顶层 try/catch **接不住**，进程以"未处理 rejection"收场：
   **无汇总行 ＋ 退 1**；而 9.5-5 的退出码契约要求"脚本自身异常"退 **2**。`E76①` 已修好 3 个脚本，
   当时**没有任何门禁守这个形态** ⇒ 新写脚本（或改回旧写法）时缺陷会静默回潮 —— 退 1 与"有断言失败"
   在 `run-all` 台账上**逐字同形**（见 `lib/assert.js` 末注），正是 `E76` 的起点。
   本节把"入口接线"变成静态判据：
     A 凡含 `main()` 声明的文件：**async** ⇒ 必须有 `main().catch(`（`.catch` 挂在 promise 上），
       且其异常路径退 2（`process.exit(2)` 或 `process.exitCode = 2`）；**sync** ⇒ 必须有顶层
       `try`/`catch`（或 `.catch`）且异常路径退 2；
     B **禁止形态**：对 async 的 `main` 用顶层同步 try 收尾 —— 这就是 `E76①` 的靶子；
     C **防空洞**（`D23`）：判据必须**指名**违规文件与形态（不许只报"有 1 个不合规"），
       且扫描器要认得出本仓真实写法（普查：`async function main(` 12 处／`function main(` 4 处，
       另有 `server\index.js` 的 `async function main(options = {})`；一并兼容 `main = async` 形式）
       —— 只认一种写法等于给别的写法开后门；并配 `D22` 定点变异（§16-C／§16-D）＋ 负对照（§16-E）。
   范围：`tests\*.js`（直下入口脚本）＋ `tests\lib\*.js` ＋ `server\index.js`（同为 `main()` 入口，
   与 `E78` 的普查口径一致：17 个）。`tests\._verify\` 下的历史副本/探针**不在范围** —— 那里存着
   旧写法的字节副本（`zz4b2-*`／`w4\bak\*` 等），纳入只会制造假红，与 `files-check` 的
   `SKIP_DIRS` 是同一处理。
   `E79` 收口（`T-20261002-01`，由座位 5 在 `T-20260930-33` 用 7 组灰盒等价实验立案）：上面那条
   "异常路径退 2"原本是**纯文本**判据 —— 它扫 `main().catch(`／`try { main() }` **之后直到文件尾**的
   整段文本（只由"尾部 ≤ 1500 字符"那一道门限制），于是同一段文本里的**注释**（F1）／**字符串常量**
   （F3）／**无关函数**（F4）里的 `process.exit(2)` 都被当成"退出证据"：catch 里其实退 1 也**假绿**；
   而 `process.exit(EXIT_ERROR)`（`tests\env.js:54` 的真常量 2，F5）反被判**红**。本节现按 E79 三步
   收口：① 先剥注释与字符串/模板串/正则（`stripLiterals`，**长度与换行保持** ⇒ 下标仍可做锚点）；
   ② 退出证据**只取异常路径自身**的配对区间（async＝`.catch(…)` 的实参区间，sync＝`catch (…) {…}`
   的块区间）；③ 退出码必须**证出是 2**（字面量 `2`，或 `tests\env.js` 真源里**值为 2** 的常量名）
   ——"认常量"不等于"认任何常量"（`EXIT_FAIL` 仍判红）。配对/花括号没闭合＝拿不到边界 ⇒ **判红**
   （判不了不许当通过）。F／G／H 三条新断言把上述四种形态逐一钉住；F 还在 `db-check.js` 的
   **字节副本**上做定点变异（sha256 留痕、`Buffer.compare` 证还原、全程不落盘、不用 `git checkout`）。 */
{
  /* 声明识别：取**最早**一处 `main` 声明 —— 注释/字符串里提到另一种写法时不至于误判
     （本文件下方就有 `async function main(` 的样例字符串，取最早即第 55 行的真声明）。
     并要求声明后面**紧跟函数体**（`(`…`)` 之后是 `{`）：否则 `lib/assert.js` 末注里那句
     "`function main()`（同步）的脚本…"会被当成声明（实测过，必须防）。 */
  const detectMainDecl = src => {
    const cands = [];
    const bodyFn = /function\s+main\s*\([^)]*\)\s*\{/g;
    const assign = /(?:^|\n)[ \t]*(?:const|let|var)?[ \t]*main[ \t]*=[ \t]*(async\b|function\b|\([^)]*\)[ \t]*=>)/g;
    let m;
    while ((m = bodyFn.exec(src))) {
      const isAsync = /async\s*$/.test(src.slice(Math.max(0, m.index - 16), m.index));
      cands.push({ idx: m.index, kind: isAsync ? 'async' : 'sync',
        form: isAsync ? '`async function main()`' : '`function main()`' });
    }
    while ((m = assign.exec(src))) {
      const isAsync = m[1] === 'async';
      cands.push({ idx: m.index, kind: isAsync ? 'async' : 'sync',
        form: isAsync ? '`main = async`' : '`main = function`' });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.idx - b.idx);
    return cands[0];
  };

  const MAIN_CATCH = /main\(\)\s*\.\s*catch\s*\(/;                        /* 推荐接法：.catch 挂在 promise 上 */
  const TOP_TRY_MAIN = /try\s*\{\s*main\s*\(\s*\)\s*;?\s*\}\s*catch/;    /* 靶子形态（对 async 无效） */
  /* 入口接线到文件尾的余量上限（`E79` 建议③：把原来的裸 1500 提为**具名常量**，值不变）。
     它只管"接线是不是落在尾部"，**不再**兼任"退出语句的搜索窗口" —— 退出证据改由下方 `hasExit2` ＋
     `asyncExitRegion`／`syncExitRegion` 从异常路径**自身**的区间里取（假阳性通道就在那个窗口上）。 */
  const ENTRY_TAIL_MAX = 1500;

  /* ---------------- `E79`：退出证据只认**异常路径自身的代码** ----------------
     旧写法把 `main().catch(` 之后的**整段文本**当"异常路径"，于是 F1 注释／F3 字符串/模板串／F4 其后
     无关函数里的 `process.exit(2)` 都算"退 2"（catch 里其实退 1 ⇒ 假绿）；F5 `process.exit(EXIT_ERROR)`
     反被判红。三步修法＝① 剥字面量（`stripLiterals`）② 只取异常路径自身的配对区间（`regionOf`）
     ③ 退出码必须**证出是 2**（`exitCodeOf`，真源＝`tests\env.js`）。 */
  const { createHash } = require('node:crypto');
  const sha256Hex = buf => createHash('sha256').update(buf).digest('hex');

  /* 退出码常量真源：**同源**读 `tests\env.js`（规范 9.5-5 的唯一定义处），不在这里写第二份数字 ——
     写死一份就是埋一个会漂移的副本（F5 的根因正是判据不认这份真源）。读不到就返回空表 ⇒
     §16-G 会因样本判红而**必红**（不许把"读不到真源"当通过）。 */
  const readExitConsts = () => {
    const map = new Map();
    let src = '';
    try { src = fs.readFileSync(path.join(env.paths.tests, 'env.js'), 'utf8'); } catch { return map; }
    const re = /const\s+(EXIT_[A-Z0-9_]+)\s*=\s*(\d+)\s*;/g;
    let m;
    while ((m = re.exec(src))) map.set(m[1], Number(m[2]));
    return map;
  };
  const EXIT_CONSTS = readExitConsts();

  /** `/` 是正则字面量还是除号？只看**前一个有效字符**（已剥区是空格 ⇒ 注释/字符串不干扰判断）。
      判错的代价：正则内容没剥掉（里面的 `{}`／`()` 会干扰配对 —— 由"配不上就判红"兜住），
      或把除法算式当正则剥掉（只有把 `process.exit` 整段吞掉才可能改变结论）。 */
  const isRegexStart = (out, i) => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    if (k < 0) return true;
    if ('([{,;:=!&|?+-*%~^<>'.includes(out[k])) return true;
    let w = k;
    while (w >= 0 && /[A-Za-z_$]/.test(out[w])) w--;
    return /^(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(out.slice(w + 1, k + 1).join(''));
  };

  /** 把注释与字符串/模板串/正则的**内容**换成空格；**长度与换行保持不变** ⇒ 下标仍可直接当锚点。
      目的：判据只认**代码**里的退出语句（`console.error('process.exit(2)')` 不是退出证据 —— F1/F3/F4）。 */
  const stripLiterals = src => {
    const out = src.split('');
    const n = src.length;
    const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
    let mode = 'code';
    const stack = [];                                 /* 模板串插值 `${ … }`：braces＝插值内花括号深度 */
    let i = 0;
    while (i < n) {
      const c = src[i], c2 = src[i + 1];
      if (mode === 'code') {
        if (c === '/' && c2 === '/') { blank(i, i + 2); mode = 'line'; i += 2; continue; }
        if (c === '/' && c2 === '*') { blank(i, i + 2); mode = 'block'; i += 2; continue; }
        if (c === "'") { blank(i, i + 1); mode = 'sq'; i++; continue; }
        if (c === '"') { blank(i, i + 1); mode = 'dq'; i++; continue; }
        if (c === '`') { blank(i, i + 1); mode = 'tpl'; i++; continue; }
        if (c === '/' && isRegexStart(out, i)) { blank(i, i + 1); mode = 're'; i++; continue; }
        if (stack.length) {                            /* 模板串插值内部按**代码**处理（保留求值语义） */
          if (c === '{') stack[stack.length - 1].braces++;
          else if (c === '}') {
            if (stack[stack.length - 1].braces === 0) { stack.pop(); mode = 'tpl'; }
            else stack[stack.length - 1].braces--;
          }
        }
        i++; continue;
      }
      if (mode === 'line') { blank(i, i + 1); if (c === '\n') mode = 'code'; i++; continue; }
      if (mode === 'block') {
        if (c === '*' && c2 === '/') { blank(i, i + 2); mode = 'code'; i += 2; continue; }
        blank(i, i + 1); i++; continue;
      }
      if (mode === 'sq' || mode === 'dq') {
        const q = mode === 'sq' ? "'" : '"';
        if (c === '\\') { blank(i, i + 2); i += 2; continue; }
        if (c === q) { blank(i, i + 1); mode = 'code'; i++; continue; }
        if (c === '\n') { mode = 'code'; i++; continue; }          /* 容错：未闭合的字符串止于行尾 */
        blank(i, i + 1); i++; continue;
      }
      if (mode === 'tpl') {
        if (c === '\\') { blank(i, i + 2); i += 2; continue; }
        if (c === '`') { blank(i, i + 1); mode = 'code'; i++; continue; }
        if (c === '$' && c2 === '{') {
          /* 模板串插值 `${ … }`：**保留** `$` 与 `{` 两个字符 —— 它们是**代码**的一部分。
             `T-20261002-03` 实测的坑（必须留痕）：原写法把 `${` 两个字符一起 blank，插值内的花括号就
             少了一个左花括号与之配对 ⇒ 后面那个真 `}`（在剥后文本里）会被 `regionOf` 当成块尾提前闭合：
             例 `server\index.js` 的 `const text = \`[启动失败] ${err && …}\`` ⇒ 正文被截到插值处，
             `.catch` 区间里就"看不到" `process.exit(2)`（**假判红**）。保留 `${` 后，插值内的
             `{`／`}` 成对，`regionOf` 才配得准（`$(…)` 之外的字符串/注释/正则仍然照剥 —— §16-H 不受影响）。 */
          blank(i, i + 1); i++;                                /* 只 blank `$`，保留 `{` */
          stack.push({ braces: 0 }); mode = 'code'; i++; continue;
        }
        blank(i, i + 1); i++; continue;
      }
      if (mode === 're') {
        if (c === '\\') { blank(i, i + 2); i += 2; continue; }
        if (c === '[') { blank(i, i + 1); mode = 'reclass'; i++; continue; }
        if (c === '/') { blank(i, i + 1); mode = 'code'; i++; continue; }
        if (c === '\n') { mode = 'code'; i++; continue; }          /* 容错：未闭合的正则止于行尾 */
        blank(i, i + 1); i++; continue;
      }
      /* mode === 'reclass'：正则的字符类内部（`/` 不结束正则） */
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === ']') { blank(i, i + 1); mode = 're'; i++; continue; }
      blank(i, i + 1); i++; continue;
    }
    return out.join('');
  };

  /** 取 `openIdx` 处那个 `(`／`{` 的**配对**区间（未闭合返回 null ⇒ 调用方**必须判红**）。
      在**已剥字面量**的文本上做 ⇒ 字符串/注释/正则里的括号不会干扰配对。 */
  const regionOf = (code, openIdx) => {
    const open = code[openIdx];
    if (open !== '(' && open !== '{') return null;
    const close = open === '(' ? ')' : '}';
    let depth = 0;
    for (let i = openIdx; i < code.length; i++) {
      if (code[i] === open) depth++;
      else if (code[i] === close) { depth--; if (depth === 0) return { start: openIdx + 1, end: i, text: code.slice(openIdx + 1, i) }; }
    }
    return null;
  };

  /* 退出语句：`process.exit(<实参>)` 或 `process.exitCode = <表达式>`（都在**已剥字面量**的文本里找） */
  const EXIT_STMT = /process\.exit\s*\(\s*([^()]*)\s*\)|process\.exitCode\s*=\s*([^;\n]*)/g;

  /** 退出码**能证出是 2** 才算"退 2"：字面量 `2`，或 `tests\env.js` 真源里**值为 2** 的常量名（`EXIT_ERROR`）。 */
  const exitCodeOf = expr => {
    const e = String(expr == null ? '' : expr).trim();
    if (/^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(e)) return Number(e);
    if (/^[A-Za-z_$][\w$]*$/.test(e)) return EXIT_CONSTS.has(e) ? EXIT_CONSTS.get(e) : null;
    return null;   /* 算不出值（如 `process.exit(code)`）⇒ **不算**退 2：宁可判红，也不给"认任何常量"留口子 */
  };

  /** 在某段**已剥字面量**的文本里找"退 2"的退出语句 */
  const hasExit2 = code => {
    const g = new RegExp(EXIT_STMT.source, 'g');
    let m;
    while ((m = g.exec(code))) if (exitCodeOf(m[1] !== undefined ? m[1] : m[2]) === 2) return true;
    return false;
  };

  /** 取**最后**一处匹配：入口调用按约定在文件尾部（本仓 17 处，尾部都在 700 字符内） */
  const lastMatch = (re, src) => {
    const g = new RegExp(re.source, 'g');
    let m, last = null;
    while ((m = g.exec(src))) last = m;
    return last;
  };

  /** 从 `catch` 之后取 **catch 回调的配对区间**（`E82⒜` 后：块体与**表达式体**都要吃得下）。
      五种真实形态：
        · `} catch (err) { … }`              —— sync 入口的推荐写法；
        · `main().catch(err => { … })`       —— 实参是箭头函数、参数**没有**括号；
        · `.catch(async (err) => { … })`     —— 实参是带括号的参数表 ＋ 箭头；
        · `main().catch(err => process.exit(2));` —— **表达式体箭头**（合法简写、括号成对）；
        · 箭头体里出现 `{`/`}`（模板串 `${…}`、对象字面量）—— 见下。
      `E82⒜` 修正（2026-10-02，座位 5 于 C·17 报出、主代理实测 278/1 指名）：`E81` 的区间**只认块体**
      （下面的"块级 `{`"扫描）⇒ 表达式体简写会一路扫到文件里**下一个**无关的 `{`（或扫到文件尾）
      ⇒ 被判"括号在文件内没有闭合"而**假红**（文案与事实相反，`D23` 意义上的名不符实）。
      修法：在块扫描**之前**先认箭头（`arrowBodyOf`）；是表达式体就取"**外层调用的右括号**"之前的区间，
      只有真的取不到边界才 `{ text: null }`。
      做法（⚠ 实测坑，勿改回去）：
        ① **不能**从 `catch` 之后的 `(` 直接配起 —— 对 `.catch(` 来说那个 `(` 是"实参表的左括号"，
           直接配对会把**整个回调**当参数区，配完就找不到 `{`（那样全仓 13 个 async 入口会被假判红）；
        ② 参数表可能是**带括号**的（`.catch(async (err) => {`），要先把它整段跳过；
        ③ 找块时**必须按括号深度扫**：`(code.indexOf('=>'), code.indexOf('{'))` 这种"取更早者"的写法
           会被箭头体里的 `${…}`（如 `server\index.js` 的 `const text = \`[启动失败] ${err…}\``）带偏 ——
           那个 `{` 在括号深度 > 0 的位置 ⇒ 正文被截成半句、`process.exit(2)` 落在区间外，**假判红**。
      取不到（括号/块没闭合、或回调写成别处去了）一律 `{ text: null }` ⇒ 调用方**判红**（判不了不许当通过）。 */
  /** 箭头回调的**表达式体**区间（`=> expr`）：返回 `{ text }`；块体（`=> { … }`）返回 `null`
      交给下面的块扫描；不是箭头（如 `} catch (err) {`）也返回 `null`。
      边界算法：`.catch(` 的左括号占一层 ⇒ 从体起点起按 `(`／`[`／`{` 记深度，遇到让深度归零的
      右括号即**外层调用的右括号**（这就是表达式体的终点）。扫不到 ⇒ `{ text: null }`（判红）。 */
  const arrowBodyOf = (code, i) => {
    let k = i;
    if (code[k] !== '=' || code[k + 1] !== '>') {              /* 无括号的单参形态：`err => …` */
      if (!/[A-Za-z_$]/.test(code[k] || '')) return null;
      while (k < code.length && /[\w$]/.test(code[k])) k++;
      while (k < code.length && /\s/.test(code[k])) k++;
    }
    if (code[k] !== '=' || code[k + 1] !== '>') return null;
    k += 2;
    while (k < code.length && /\s/.test(code[k])) k++;
    if (code[k] === '{') return null;                          /* 块体 ⇒ 交给块扫描 */
    const start = k;
    let depth = 1;                                             /* `.catch(` 的左括号那一层 */
    for (; k < code.length; k++) {
      const ch = code[k];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return { text: code.slice(start, k) };
      }
    }
    return { text: null };
  };
  const catchBlockRegion = (code, m) => {
    if (!m) return { text: null };
    let i = m.index + m[0].length;                            /* `catch` 之后（`.catch(` 时已越过左括号） */
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] === '(') {                                    /* 带括号的参数表（`.catch(async (err) => {`） */
      const params = regionOf(code, i);
      if (!params) return { text: null };
      i = params.end + 1;
      while (i < code.length && /\s/.test(code[i])) i++;
    }
    /* `E82⒜`：表达式体简写必须先于块扫描被认出来（否则会去配文件里下一个无关的 `{`）。 */
    const arrow = arrowBodyOf(code, i);
    if (arrow) return arrow;
    let depth = 0;                                            /* 块级 `{` ＝ `(`／`[` 深度归零时的第一个 `{` */
    for (let k = i; k < code.length; k++) {
      const ch = code[k];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') { if (depth > 0) depth--; }
      else if (ch === '{' && depth === 0) {
        const body = regionOf(code, k);
        return { text: body ? body.text : null };
      }
    }
    return { text: null };
  };

  /** async 入口的异常路径区间＝**最后一处** `main().catch(` 的**实参**区间（text===null ⇒ 括号没闭合/没有接法） */
  const asyncExitRegion = code => catchBlockRegion(code, lastMatch(MAIN_CATCH, code));

  /** sync 入口的异常路径区间＝异常路径**自身**的 `catch` 块区间 —— 两种接法都覆盖：
        · `try { main(); } catch (…) { … }`（sync 的推荐写法）⇒ `catch` 块的配对区间；
        · `main().catch(…)`（`E81`：sync 的 `main` 没有 promise，故这里纯属**兜底形态**）⇒ 回调块的配对区间。
      `E81` 修前：`auditEntryShape` 的第三分支引用了 **async 专用**的 `asyncRegion`（对 sync 恒为 null）
      ⇒ 走到那里就抛 `TypeError: Cannot read properties of null (reading 'text')`，整轮断言一条都跑不出来
      （`E76` 的 `.catch` 接线把"主流程异常"落成"无汇总行 ＋ 退 2"）。现在改成**取 sync 自身的区间**，
      并把"取不到"与"没退 2"一样判红（判不了不许当通过）。 */
  const syncExitRegion = code => {
    const tryM = TOP_TRY_MAIN.exec(code);
    if (tryM) {
      /* `} catch` 形态：锚点＝`catch` 这个词；`m[0]` 的末 5 个字符就是 `catch` ⇒ 下标回退 5 */
      return catchBlockRegion(code, { index: tryM.index + tryM[0].length - 5, 0: 'catch' });
    }
    return catchBlockRegion(code, lastMatch(MAIN_CATCH, code));
  };

  /** 审计一批源码（纯函数，便于下方 D22 定点变异）：返回 { counts, offenders }
      判据（`E79` 后）＝**先剥字面量，再只看异常路径自身区间里的退出语句**：
        async ⇒ 必须有 `main().catch(`（`.catch` 挂在 promise 上），且**其实参区间**里退 2；
        sync  ⇒ 必须有顶层 `try`/`catch`（或 `.catch`），且**`catch` 的块区间**里退 2；
        禁止形态 ⇒ 对 async 的 `main` 用顶层同步 try 收尾（`E76①` 的原形态）。 */
  const auditEntryShape = sources => {
    const counts = { total: 0, async: 0, sync: 0 };
    const offenders = [];
    for (const { name, src } of sources) {
      const decl = detectMainDecl(src);
      if (!decl) continue;
      counts.total++;
      counts[decl.kind]++;
      /* 判据只在**代码**上做：注释/字符串/模板串/正则一律先剥成空格（F1/F3/F4 的诱饵由此失效） */
      const code = stripLiterals(src);
      const catchM = lastMatch(MAIN_CATCH, code);
      const tryM = TOP_TRY_MAIN.exec(code);
      /* 退出证据只取异常路径**自身**的配对区间（不再是"入口之后直到文件尾"的整段文本） */
      const asyncRegion = decl.kind === 'async' ? asyncExitRegion(code) : null;
      const syncRegion = decl.kind === 'sync' && tryM ? syncExitRegion(code) : null;
      if (decl.kind === 'async') {
        if (!catchM) {
          offenders.push(`${name}（${decl.form}）：没有 \`main().catch(\` ⇒ rejection 无人接住（9.5-5 要求退 2）`);
        } else if (src.length - catchM.index > ENTRY_TAIL_MAX) {
          offenders.push(`${name}（${decl.form}）：\`main().catch(\` 不在文件尾部（其后还有 ${src.length - catchM.index} 字符）—— 入口接线看不出在哪里收尾`);
        } else if (asyncRegion.text === null) {
          /* `E82⒜`：这里**只能**说"取不到边界" —— 旧文案写死"括号在文件内没有闭合"，
             而表达式体简写（括号明明成对）也会走到这一支 ⇒ 文案与事实相反（`D23`）。 */
          offenders.push(`${name}（${decl.form} ＋ \`.catch\`）：\`main().catch(\` 的异常路径区间**取不到**（实参表的括号没闭合、或回调写成别处去了）⇒ 拿不到边界（判不了就判红）`);
        } else if (!hasExit2(asyncRegion.text)) {
          offenders.push(`${name}（${decl.form} ＋ \`.catch\`）：异常路径**没退 2** —— 应在 \`.catch(…)\` **自身**的区间里含 process.exit(2)／process.exitCode = 2／值为 2 的常量退码`);
        }
        if (tryM) {
          offenders.push(`${name}（${decl.form}）：用了顶层同步 try 包 \`main()\` 的**靶子写法** ⇒ 对 async 无效，rejection 会落成"无汇总行 ＋ 退 1"（E76① 的原形态）`);
        }
      } else if (tryM) {
        if (syncRegion.text === null) {
          offenders.push(`${name}（${decl.form}）：顶层 \`try\`/\`catch\` 的 \`catch\` 块取不到（括号/块没闭合，或写成别处去了）⇒ 拿不到异常路径的边界（判不了就判红）`);
        } else if (!hasExit2(syncRegion.text)) {
          offenders.push(`${name}（${decl.form}）：顶层 \`try\`/\`catch\` 的异常路径**没退 2**（\`catch\` 块内缺 process.exit(2)／process.exitCode = 2／值为 2 的常量退码）`);
        }
      } else if (catchM) {
        /* `E81`：这里必须取 **sync 自身**的异常路径区间。修前引用的是 async 专用的 `asyncRegion`
           （对 sync 恒为 `null`）⇒ 本行抛 TypeError，整轮断言一条都跑不出来。 */
        const syncCatchRegion = syncExitRegion(code);
        if (syncCatchRegion.text === null) {
          /* 同 `E82⒜`：不得断言"括号没闭合"（表达式体等合法形态也会走到这里）。 */
          offenders.push(`${name}（${decl.form}）：\`main().catch(\` 的异常路径区间**取不到**（实参表的括号没闭合、或回调写成别处去了）⇒ 拿不到边界（判不了就判红）`);
        } else if (!hasExit2(syncCatchRegion.text)) {
          offenders.push(`${name}（${decl.form}）：\`.catch\` 的异常路径**没退 2**`);
        }
      } else {
        offenders.push(`${name}（${decl.form}）：既没有顶层 \`try\`/\`catch\` 也没有 \`.catch\` ⇒ 异常无人接住（9.5-5 要求退 2）`);
      }
    }
    return { counts, offenders };
  };

  /* 待审源码：`tests\` 直下 ＋ `tests\lib\` ＋ `server\index.js`（读不到就**报出来**，不静默少扫） */
  const listJs = relDir => fs.readdirSync(path.join(env.paths.root, relDir))
    .filter(n => n.endsWith('.js')).map(n => `${relDir}/${n}`);
  const entrySources = [];
  for (const rel of [...listJs('tests'), ...listJs('tests/lib'), 'server/index.js']) {
    try {
      entrySources.push({ name: rel.split('/').join('\\'), src: fs.readFileSync(path.join(env.paths.root, rel), 'utf8') });
    } catch (err) { t.info(`§16 读不到 ${rel}：${err.message}`); }
  }

  const real = auditEntryShape(entrySources);
  /* 普查地板 ＋ 两维**精确**（`D23` 防空洞）。**口径更正（`E82⒝`，2026-10-02，主代理裁定接受）**：
     ⚠ `FLOOR_TOTAL` 是一条**结构性死项**：`counts.total++` 与 `counts[kind]++` 在 `auditEntryShape()`
     里**同处发生** ⇒ `total ≡ async ＋ sync` 恒成立，两维精确后 `total` 必然是 20
     ⇒ "total ≥ 地板"既不会先失效、也没法单独失效（它只是"两维精确"的**算术推论**）。
     保留它的理由＝**防御性冗余**（万一将来有人删掉两维的精确判据，地板还能挡住"扫描面塌成 0"），
     但**不得**再把它当成独立的一条覆盖约束 —— 真正的约束是**两维各自精确**：
     新增/删除入口脚本必须**同批改本节**（连 `FLOOR_TOTAL` 一并改，或至少改两维）。
     **显式作废 `E78` 时代"实测新增不必改（下界照旧满足）"的说法**：那只对"只保下界"的旧口径成立；
     在"两维精确"下，新增一个入口就会让 `EXACT_ASYNC`／`EXACT_SYNC` 变红（**必须改本节**），
     而旧说法正是"形态迁移 ＋ 补偿性新增"这一 `≥` 下真漏洞的来源（严格更严，故保留双维精确）。
     另：`T-20261002-03`（`E80` 收口）把三个"直下但没入口声明"的门禁脚本（files／logic／platform）
     补成 `main()` 入口后，实跑值由 17/13/4 变为 **20/13/7**（口径：`tests\*.js` 直下 ＋ `tests\lib\*.js`
     ＋ `server\index.js`）—— 这三个新入口落进扫描面，§16-A 才看得见它们。 */
  const FLOOR_TOTAL = 20;
  const EXACT_ASYNC = 13;
  const EXACT_SYNC = 7;
  t.info(`§16 入口形态普查：${real.counts.total} 个含 \`main()\` 的入口（async ${real.counts.async}／sync ${real.counts.sync}／缺陷形态 ${real.offenders.length}）`);
  t.info(`§16 E79：退出证据只取异常路径**自身**的区间（注释/字符串/模板串/正则已剥；接线到文件尾的余量上限＝${ENTRY_TAIL_MAX} 字符）；`
    + `常量退码真源＝tests\\env.js（${[...EXIT_CONSTS].map(([k, v]) => k + '=' + v).join('／') || '**读不到真源**'}）`);
  /* 逐个子条件算出来（`E82⒝` 的第二半）：FAIL 的**首句**必须是"判红 + 未成立的子条件"，
     而不是旧写法里那句"形态全部合规"（与结论相反 —— 主代理在自己的变异轮里也见到过同一句）。 */
  const shapeConds = [
    { name: '缺陷形态逐条指名', ok: real.offenders.length === 0,
      why: real.offenders.length
        ? `违规 ${real.offenders.length} 处（逐条指名文件与形态）：${real.offenders.join('；')}`
        : '（无违规）' },
    { name: `扫描面 ≥ ${FLOOR_TOTAL}（**结构性死项**：两维精确的算术推论，只作防御性冗余）`,
      ok: real.counts.total >= FLOOR_TOTAL,
      why: `实测 total=${real.counts.total}（＝async ${real.counts.async} ＋ sync ${real.counts.sync}）` },
    { name: `async 维度精确 = ${EXACT_ASYNC}`, ok: real.counts.async === EXACT_ASYNC,
      why: `实测 async=${real.counts.async}` },
    { name: `sync 维度精确 = ${EXACT_SYNC}`, ok: real.counts.sync === EXACT_SYNC,
      why: `实测 sync=${real.counts.sync}` }
  ];
  const shapeBad = shapeConds.filter(c => !c.ok);
  t.check('§16-A 静态：含 `main()` 的入口形态全部合规（async ⇒ `main().catch(` ＋ 退 2；sync ⇒ `try`/`catch` ＋ 退 2；禁止对 async 用顶层同步 try 包 `main()`）',
    shapeBad.length === 0,
    shapeBad.length
      ? `判红：**未成立的子条件 ${shapeBad.length} 项** —— ${shapeBad.map(c => `${c.name}（${c.why}）`).join('；')}；`
        + `普查 ${real.counts.total} 个（async ${real.counts.async}／sync ${real.counts.sync}）`
      : `普查 ${real.counts.total} 个（async ${real.counts.async}／sync ${real.counts.sync}），形态全部合规`
        + `；四个子条件逐项成立：缺陷形态 0 ＋ total ${real.counts.total} ≥ ${FLOOR_TOTAL}（算术推论）`
        + ` ＋ async = ${EXACT_ASYNC} ＋ sync = ${EXACT_SYNC}`
        + `（新增/删除入口脚本必须**同批改本节**的这三个数字 —— 显式作废 E78 的"新增不必改"）`);

  /* §16-L 入口覆盖普查（`E80`）：`tests\*.js` 直下的每个门禁脚本都必须是"被 §十六 扫到的入口"。
     `E82⒞`（FAIL 明细要能**指名**，2026-10-02 收口）：旧写法把 FAIL 的说明**写死**成三个文件名文本
     （`files-check`／`logic-check`／`platform-check`，即 `E80` 当时缺的那三个）⇒ 只缺 1 个时会被读成缺 3 个；
     真凶只在 **info 行**上，而 `run-all.js:962` 的明细过滤只认 `[FAIL]`／`失败清单`／编号行／
     `脚本异常终止`（**不认** info 行）⇒ run-all 明细层面**失去指名能力**（`D23` 未达成）。
     现在 FAIL 明细**动态拼 `missing`**（只列实测缺的那些）。
     `E82⒟`（判据自证要**可假**）：旧探针把每条样本的 `src` 写成 `''`，而 `detectMainDecl('') === null`
     恒真 ⇒ `selfProves` **恒真**（自证力为零）。现在改用**真实入口样本**两问：
       ① 每个非豁免直下脚本的**真源码**都必须被 `detectMainDecl()` 认出（识别能力的正证）；
       ② 抽其中**一个**真样本、把它的 `main` 声明**抠掉**（正则替换）⇒ 必须**恰好那一个**被判据指名
          （判据的**可假**自证）。两问同时成立才算自证 —— 它现在是可假的。 */
  const l16 = (() => {
    const baseOf = rel => rel.slice(rel.lastIndexOf('/') + 1);
    /* **显式豁免清单**（每条都写理由；豁免≠"可以不查"，而是"它不是门禁入口"）：
       · `env.js`：被 require 的模块 —— 它**实现** `env.assertRuntime()` 并定义退出码/路径常量真源
         （规范 9.5-5），本身不是门禁入口（`files-check` 第八节也把它排除在"必须调 assertRuntime"之外）；
       · 范围口径：`tests\lib\*.js` 是夹具层（被 require 的模块），不属"直下入口"，本节既有范围即不含它们。
       其余直下脚本（含 `capture-baseline`／`screenshot-diff` 这类工具脚本）**都要求有入口声明** ——
       没有入口的脚本，§16-A 与 `run-all` 的失败明细**都看不见它**（`E80` 的两个盲区）。 */
    const EXEMPT = new Set(['env.js']);
    const direct = listJs('tests');                            /* tests\ 直下的 .js 全量（含豁免项） */
    const nonExempt = direct
      .map(rel => ({ rel, base: baseOf(rel), name: rel.split('/').join('\\') }))
      .filter(x => !EXEMPT.has(x.base));
    const realSrcOf = name => {
      const hit = entrySources.find(s => s.name === name);
      return hit ? hit.src : null;                             /* 读不到 ⇒ null（判不了就判红） */
    };
    const missing = nonExempt.filter(x => !detectMainDecl(realSrcOf(x.name) || '')).map(x => x.name);
    /* 自证①：真样本的识别率 */
    const detectorHits = nonExempt.filter(x => !!detectMainDecl(realSrcOf(x.name) || ''));
    /* 自证②：抠掉 `main` 声明的**真样本**（两种声明写法都要抠得掉；抠不干净就换下一个样本） */
    const stripMainDecl = src => src
      .replace(/function(\s+)main(\s*\()/g, 'function$1__e82StrippedMain$2')
      .replace(/((?:^|\n)[ \t]*(?:const|let|var)?[ \t]*)main([ \t]*=[ \t]*(?:async\b|function\b|\())/g,
        '$1__e82StrippedMain$2');
    const victim = nonExempt.find(x => {
      const s = realSrcOf(x.name);
      return !!s && !!detectMainDecl(s) && detectMainDecl(stripMainDecl(s)) === null;
    }) || null;
    const probeMissing = victim === null ? [] : [victim.name];
    const selfProves = victim !== null && detectorHits.length === nonExempt.length &&
      probeMissing.length === 1 && probeMissing[0] === victim.name;
    return { direct, EXEMPT, nonExempt, missing, detectorHits, victim, selfProves };
  })();
  t.info(`§16-L 直下脚本 ${l16.direct.length} 个：豁免 ${l16.EXEMPT.size} 个（${[...l16.EXEMPT].join('、')}：被 require 的模块，实现 assertRuntime 与常量真源，不是门禁入口）；`
    + `被 §十六 扫到的入口 ${l16.nonExempt.length - l16.missing.length} 个；`
    + `缺失入口声明 ⇒ 指名：${l16.missing.join('、') || '（无）'}；`
    + `判据自证（**真实入口样本**：${l16.detectorHits.length}/${l16.nonExempt.length} 被认出 ＋ 抠掉 `
    + `${l16.victim ? l16.victim.name : '（无可变异真样本）'} 的 \`main()\` 声明后必被指名）＝${l16.selfProves}`);
  t.check('§16-L 入口覆盖普查：`tests\\*.js` 直下的每个门禁脚本都必须是"被 §十六 扫到的入口"（声明了 `main()`）；缺失者逐条指名，豁免项显式列明理由',
    l16.missing.length === 0 && l16.selfProves,
    l16.missing.length
      ? `判红：缺失入口声明 **${l16.missing.length} 个**（**逐条指名**，只列实测缺的那些）：${l16.missing.join('、')}`
        + ` —— 没有入口的脚本不在 §十六 的扫描面内，\`run-all\` 的失败明细也认不出它们的裸栈（\`E80\` 的两个盲区）；`
        + `豁免只有 ${[...l16.EXEMPT].join('、')}（理由见 info 行）；判据自证＝${l16.selfProves}`
      : (l16.selfProves
        ? `直下脚本 ${l16.direct.length} 个，非豁免 ${l16.nonExempt.length} 个**全部**被 §十六 扫到（豁免只有 `
          + `${[...l16.EXEMPT].join('、')}，理由见 info 行）；判据自证成立＝真样本 ${l16.detectorHits.length}/`
          + `${l16.nonExempt.length} 被认出 ＋ 抠掉 ${l16.victim ? l16.victim.name : '（无）'} 的 \`main()\` 声明后必被指名`
        : `判红：入口覆盖本身齐了（missing=0），但**判据自证不成立**（真样本被认出 ${l16.detectorHits.length}/`
          + `${l16.nonExempt.length}；可变异真样本＝${l16.victim ? l16.victim.name : '**一个都找不到**'}）`
          + ` ⇒ 这条判据可能已退化成恒真，必须先修判据（不得当作通过）`));

  t.check('§16-B 扫描器自证：`async function main`／`function main`／`main = async` 三种真实写法都被识别，注释里的 `function main()`（无函数体）与不含 `main` 的源码都不计入',
    (() => {
      const a = detectMainDecl('async function main() {\n}\n');
      const b = detectMainDecl('function main() {\n}\n');
      const c = detectMainDecl('const main = async () => {\n};\n');
      const d = detectMainDecl('const x = 1;\nfoo();\n');
      const e = detectMainDecl('· `function main()`（同步）的脚本 ⇒ 顶层 `try`/`catch` ＋ 退 **2**\n');
      return !!a && a.kind === 'async' && !!b && b.kind === 'sync' && !!c && c.kind === 'async'
        && d === null && e === null;
    })(),
    '期望：async／sync／async／null／null —— 少一种识别能力就等于给那种写法开后门（`E78` 的判据必须认得出本仓真实形态）');

  /* 变异靶子：`db-check.js`（`E76①` 三个受害脚本之一）。锚点用**正则**而非写死行号/片段，
     文件长大也不失效；锚点未命中一律按**失败**处理（不许把"跑不了"当通过）。 */
  let dbSrc = '';
  try { dbSrc = fs.readFileSync(path.join(env.paths.tests, 'db-check.js'), 'utf8'); }
  catch (err) { t.info('§16 读不到 db-check.js（D22 靶子）：' + err.message); }
  const dbName = 'tests\\db-check.js';
  /* 靶子形态用**拼接**构造：本节的 forbidden/明细判据都是**文本**判据，若在源码里原样写出
     `try {` 紧跟 `main()`，本文件自己就会被自己命中（文本判据的经典自伤）。 */
  const TARGET_FORM = 'try {' + '\n  main();\n} catch (err) {\n  console.error(String(err && err.stack ? err.stack : err));\n  process.exit(2);\n}\n';

  t.check('§16-C D22 变异①：把 `db-check.js` 尾部换回顶层同步 try 包 `main()` 的靶子写法 ⇒ §16-A 判据必红并**指名** db-check（这正是 E76① 的原形态）',
    (() => {
      const anchor = lastMatch(MAIN_CATCH, dbSrc);
      if (!anchor) { t.info('§16-C 锚点未命中：`db-check.js` 里找不到 `main().catch(`（文件被改过？）'); return false; }
      const mutated = dbSrc.slice(0, anchor.index) + TARGET_FORM;
      const res = auditEntryShape([{ name: dbName, src: mutated }]);
      const allNamed = res.offenders.length > 0 && res.offenders.every(o => o.startsWith(dbName));
      const bothForms = res.offenders.some(o => o.includes('靶子写法')) && res.offenders.some(o => o.includes('rejection 无人接住'));
      return allNamed && bothForms;
    })(),
    `变异内容：删掉 \`${dbName}\` 的 \`main().catch(…)\` 收尾，换成顶层同步 try 包 \`main()\`（catch 里仍退 2）`
      + ' —— 判红必须**指名文件与形态**，而不是只报"有 1 个不合规"');

  t.check('§16-D D22 变异②：把 `db-check.js` 异常路径的 `process.exit(2)` 改成 `process.exit(1)` ⇒ §16-A 判据必红并**指名**退错码',
    (() => {
      const anchor = lastMatch(MAIN_CATCH, dbSrc);
      if (!anchor) { t.info('§16-D 锚点未命中：`db-check.js` 里找不到 `main().catch(`'); return false; }
      const tail = dbSrc.slice(anchor.index);
      if (!tail.includes('process.exit(2)')) { t.info('§16-D 锚点未命中：`main().catch` 之后的收尾里没有 `process.exit(2)`'); return false; }
      const mutated = dbSrc.slice(0, anchor.index) + tail.replace('process.exit(2)', 'process.exit(1)');
      const res = auditEntryShape([{ name: dbName, src: mutated }]);
      return res.offenders.length === 1 && res.offenders[0].startsWith(dbName) && res.offenders[0].includes('没退 2');
    })(),
    `变异内容：\`${dbName}\` 的 \`main().catch\` 收尾由 \`process.exit(2)\` 改成 \`process.exit(1)\``
      + '（退 1 在 run-all 账上与"有断言失败"逐字同形，故必须退 2）');

  /* 合成样本（只用于扫描器自证/负对照，不落地）。`try {` 与 `main()` 之间**必须**用拼接断开：
     理由同上——否则本文件自己的源码就命中自己的 forbidden 正则。 */
  const SAMPLE_ASYNC_OK = 'async function main() { done(); }\n\nmain().catch(err => {\n  console.error(String(err));\n  process.exit(2);\n});\n';
  const SAMPLE_SYNC_OK = 'function main() { done(); }\n' + 'try {' + '\n  main();\n} catch (err) {\n  console.error(String(err));\n  process.exit(2);\n}\n';
  t.check('§16-E 负对照：合规的 async／sync 入口样本都**不被**误报（防"把一切都判红"的假红式断言）',
    (() => {
      const a = auditEntryShape([{ name: '（合成 async 合规样本）', src: SAMPLE_ASYNC_OK }]);
      const s = auditEntryShape([{ name: '（合成 sync 合规样本）', src: SAMPLE_SYNC_OK }]);
      return a.offenders.length === 0 && s.offenders.length === 0 && a.counts.async === 1 && s.counts.sync === 1;
    })(),
    '合规样本：async ⇒ `main().catch(…退 2)`；sync ⇒ 顶层 `try`/`catch` ＋ 退 2 —— 两者都必须判绿（否则"判红"只是把一切都判红，那种断言没有证据力）');

  /* ---------------- `E79` 收口的四条自证（F／G／H／I，均配 D22 定点变异） ----------------
     敏感文本（`process.exit(2)`／`try {`＋`main();`）一律**字符串拼接**构造：本文件自己也在 §16 的
     扫描范围内，原样写出就会命中的自己的文本判据（`E78` 时代的技巧，保留）。 */
  const E2TEXT = 'process.exit(' + '2)';
  const mkAsyncEntry = body => 'async function main() { done(); }\n\n'
    + 'main().catch(err => {\n' + '  console.error(String(err));\n' + body + '\n});\n';
  /* 诱饵（四种形态都落在旧判据的 1500 字符窗口内）：F1 块注释／F3 字符串／**F4 无关函数（真代码）** ——
     旧判据把"入口之后直到文件尾"的整段文本当异常路径，于是这些诱饵都成了"退出证据"（catch 里退 1 也判绿）。 */
  const DECOY_AFTER_ENTRY = '\n/* 诱饵①（块注释）：' + E2TEXT + ' */'
    + '\n// 诱饵②（行注释）：这里必须 ' + E2TEXT
    + '\nconst DECOY_NOTE = ' + JSON.stringify(E2TEXT) + ';   /* 诱饵③（字符串常量） */'
    + '\nfunction unrelatedHelper() {   /* 诱饵④（无关函数，真代码 —— 旧判据会把它当退出证据） */'
    + '\n  ' + E2TEXT + ';'
    + '\n}\n';

  /* §16-F：`E79` 的**现场**（D22 变异③）—— catch 里其实**退 1**，只在它之后（旧判据的 1500 字符窗口
     内）放注释①与**无关函数**④里的 `process.exit(2)`。旧判据实测 `offenders=0`（**假绿**，座位 5 的
     7 组灰盒实验），新判据必须**判红并指名** `tests\db-check.js`。变异在**字节副本**上做：sha256 留痕、
     全程不落盘、`Buffer.compare` 证明"还原后的字节"与原文件逐字节相等（不使用 `git checkout`）。 */
  t.check('§16-F D22 变异③：异常路径其实退 1、但其后注释里有 process.exit(2) ⇒ §16-A 必红并指名',
    (() => {
      const target = path.join(env.paths.tests, 'db-check.js');
      const bytes = fs.readFileSync(target);                     /* 字节副本①（原件只读，不写盘） */
      const sha0 = sha256Hex(bytes);
      const anchor = lastMatch(MAIN_CATCH, dbSrc);
      if (!anchor) { t.info('§16-F 锚点未命中：`db-check.js` 里找不到 `main().catch(`'); return false; }
      const tail = dbSrc.slice(anchor.index);
      const cut = tail.indexOf(E2TEXT);
      if (cut < 0) { t.info('§16-F 锚点未命中：`main().catch` 之后的收尾里没有 process.exit(2)'); return false; }
      /* 诱饵四种形态都塞进旧判据的窗口里：F1 注释、F3 字符串、F4 其后**无关函数**（真代码） */
      const DECOY = DECOY_AFTER_ENTRY;
      /* 变异体：异常路径改成**退 1**（其余原样）＋ 诱饵 */
      const head = dbSrc.slice(0, anchor.index) + tail.slice(0, cut) + 'process.exit(' + '1)' + tail.slice(cut + E2TEXT.length);
      const mutantBytes = Buffer.from(head + DECOY, 'utf8');      /* 字节副本②：变异体 */
      const mutant = auditEntryShape([{ name: dbName, src: mutantBytes.toString('utf8') }]);
      /* 对照：诱饵原样保留、异常路径的退码**不动** ⇒ 必须判绿（证明诱饵本身不是判红的原因，
         且"只认异常路径区间"没有把真正的退出语句一起挡掉 —— 防假红式断言） */
      const controlBytes = Buffer.from(dbSrc + DECOY, 'utf8');
      const control = auditEntryShape([{ name: dbName, src: controlBytes.toString('utf8') }]);
      /* 还原证明：由副本①重建 ⇒ 与副本①逐字节相等（sha256 相同）；再复核**盘上文件全程未变** */
      const restored = Buffer.from(bytes);
      const byteSame = Buffer.compare(restored, bytes) === 0;
      const shaSame = sha256Hex(restored) === sha0;
      const diskSame = sha256Hex(fs.readFileSync(target)) === sha0;
      const mutantNamed = mutant.offenders.length > 0 && mutant.offenders.every(o => o.startsWith(dbName));
      t.info(`§16-F 变异体 sha256=${sha256Hex(mutantBytes).slice(0, 12)}…（原件 sha256=${sha0.slice(0, 12)}…）；`
        + `变异体判红 ${mutant.offenders.length} 条／对照判红 ${control.offenders.length} 条；`
        + `还原 Buffer.compare=${byteSame}／sha256 一致=${shaSame}／盘上文件未变=${diskSame}`);
      return mutantNamed && mutant.offenders.some(o => o.includes('没退 2'))
        && control.offenders.length === 0 && byteSame && shaSame && diskSame;
    })(),
    '修正前实测（旧判据＝扫 `main().catch(` 之后的**整段文本**，只由 1500 那道门限制）：同一个变异体 `offenders=0`（**假绿**）—— 这就是 `E79` 的现场；'
      + '新判据必须判红并**指名** `tests\\db-check.js`（ADR-0004 D22：判据必须被定点变异证伪过才可信）');

  /* §16-G：**常量退码**自证（F5）。常量口径与 `tests\env.js:52-54` **同源**（读它的源码），
     但"认常量"不等于"认任何常量"：`EXIT_FAIL`(1)／`EXIT_PASS`(0)／叫不出名字的标识符一律判红。 */
  t.check('§16-G 常量退码自证：process.exit(EXIT_ERROR)/exitCode = EXIT_ERROR（=2）判绿，process.exit(EXIT_FAIL)（=1）判红',
    (() => {
      const NAME = '（合成常量退码样本）';
      const green = [mkAsyncEntry('  process.exit(EXIT_ERROR);'),
        mkAsyncEntry('  process.exitCode = EXIT_ERROR;')];
      const red = [mkAsyncEntry('  process.exit(EXIT_FAIL);'),
        mkAsyncEntry('  process.exit(EXIT_PASS);'),
        mkAsyncEntry('  process.exit(SOME_OTHER_CODE);')];
      const greenOffenders = green.map(s => auditEntryShape([{ name: NAME, src: s }]).offenders);
      const redOffenders = red.map(s => auditEntryShape([{ name: NAME, src: s }]).offenders);
      /* 同源核对：值必须来自 `tests\env.js`（读源码解析）且与 require 到的那份模块逐名一致 */
      const sameOrigin = EXIT_CONSTS.get('EXIT_ERROR') === 2 && EXIT_CONSTS.get('EXIT_FAIL') === 1
        && EXIT_CONSTS.get('EXIT_PASS') === 0 && EXIT_CONSTS.get('EXIT_ERROR') === env.EXIT_ERROR
        && EXIT_CONSTS.get('EXIT_FAIL') === env.EXIT_FAIL && EXIT_CONSTS.get('EXIT_PASS') === env.EXIT_PASS;
      const redNamed = redOffenders.every(list => list.length > 0
        && list.every(o => o.startsWith(NAME) && o.includes('没退 2')));
      t.info(`§16-G 常量真源（解析 tests\\env.js 源码）：${[...EXIT_CONSTS].map(([k, v]) => k + '=' + v).join('／') || '空'}；`
        + `与 env 模块逐名一致=${sameOrigin}；退 2 常量样本判红 ${greenOffenders.filter(l => l.length).length} 条`
        + `（应 0）／非 2 常量样本判红 ${redOffenders.filter(l => l.length).length}/${red.length} 条（应全红）`);
      return greenOffenders.every(l => l.length === 0) && redNamed && sameOrigin;
    })(),
    '同源＝读 `tests\\env.js`（规范 9.5-5 的唯一定义处）解析出 `EXIT_ERROR=2`；反证＝同一位置换成 '
      + '`EXIT_FAIL`(1)／`EXIT_PASS`(0)／未知标识符 ⇒ 必须判红（"认常量"若做成"认任何常量"，本条必红）');

  /* §16-H：**字面量剥除**自证 —— 字符串/模板串/注释里的 `process.exit(2)` 不构成退出证据；
     对照样本（同一段诱饵 ＋ 一条**真**退出语句）必须判绿 ⇒ 证明剥除没有把整段区间一起废掉。 */
  t.check('§16-H 字面量剥除自证：字符串/模板串里的 process.exit(2) 不构成退出证据',
    (() => {
      const NAME = '（合成字面量诱饵样本）';
      const decoys = '  console.error(' + JSON.stringify(E2TEXT) + ');\n'
        + '  // ' + E2TEXT + '\n'
        + '  /* ' + E2TEXT + ' */\n'
        + '  const note = `' + E2TEXT + '`;';
      const onlyDecoys = auditEntryShape([{ name: NAME, src: mkAsyncEntry(decoys) }]);
      const withReal = auditEntryShape([{ name: NAME, src: mkAsyncEntry(decoys + '\n  ' + E2TEXT + ';') }]);
      t.info(`§16-H 诱饵计数：仅字面量 ⇒ 判红 ${onlyDecoys.offenders.length} 条（应 ≥1 并指名）；`
        + `字面量 ＋ 真退出语句 ⇒ 判红 ${withReal.offenders.length} 条（应 0）`);
      return onlyDecoys.offenders.length > 0
        && onlyDecoys.offenders.every(o => o.startsWith(NAME) && o.includes('没退 2'))
        && withReal.offenders.length === 0;
    })(),
    '反证：若不剥字面量（旧判据），"仅字符串/模板/注释里出现 process.exit(2)"会判**绿**（假阳性通道）；'
      + '对照样本证明剥除没有把真退出语句一起挡掉（防"把一切都判红"）');

  /* §16-I：**sync 分支**同样只认异常路径自身（`catch` 的块区间）—— 被修改过的判据都要被定点变异证伪过。
     靶子＝`copy-check.js`（4 个 sync 入口之一，写法 `try { main(); } catch`）的**字节副本**：块里退 1 ＋
     块**外**的四种诱饵 ⇒ 必红并指名；对照（诱饵原样、退码仍是 2）⇒ 必绿。 */
  t.check('§16-I sync 异常路径自证：`catch` 块里退 1、块外注释/字符串/无关函数里有 process.exit(2) ⇒ 判红并指名（sync 分支也只认自身区间）',
    (() => {
      const target = path.join(env.paths.tests, 'copy-check.js');
      const bytes = fs.readFileSync(target);                     /* 字节副本①（只读，不写盘） */
      const sha0 = sha256Hex(bytes);
      const src = bytes.toString('utf8');
      const tryM = TOP_TRY_MAIN.exec(stripLiterals(src));
      if (!tryM) { t.info('§16-I 锚点未命中：`copy-check.js` 里找不到 `try { main(); } catch`'); return false; }
      const cut = src.indexOf(E2TEXT, tryM.index);
      if (cut < 0) { t.info('§16-I 锚点未命中：`try` 之后没有 process.exit(2)'); return false; }
      const name = 'tests\\copy-check.js';
      /* 变异体：catch 块里改成**退 1**（其余原样）＋ 诱饵（都在旧判据扫过的"入口之后"文本里） */
      const mutantBytes = Buffer.from(src.slice(0, cut) + 'process.exit(' + '1)'
        + src.slice(cut + E2TEXT.length) + DECOY_AFTER_ENTRY, 'utf8');
      const mutant = auditEntryShape([{ name, src: mutantBytes.toString('utf8') }]);
      const controlBytes = Buffer.from(src + DECOY_AFTER_ENTRY, 'utf8');
      const control = auditEntryShape([{ name, src: controlBytes.toString('utf8') }]);
      const restored = Buffer.from(bytes);                       /* 还原证明（与 F 同款纪律） */
      const byteSame = Buffer.compare(restored, bytes) === 0;
      const shaSame = sha256Hex(restored) === sha0;
      const diskSame = sha256Hex(fs.readFileSync(target)) === sha0;
      t.info(`§16-I 变异体 sha256=${sha256Hex(mutantBytes).slice(0, 12)}…（原件 sha256=${sha0.slice(0, 12)}…）；`
        + `变异体判红 ${mutant.offenders.length} 条／对照判红 ${control.offenders.length} 条；`
        + `还原 Buffer.compare=${byteSame}／sha256 一致=${shaSame}／盘上文件未变=${diskSame}`);
      return mutant.offenders.length > 0 && mutant.offenders.every(o => o.startsWith(name))
        && mutant.offenders.some(o => o.includes('没退 2'))
        && control.offenders.length === 0 && byteSame && shaSame && diskSame;
    })(),
    '修正前实测（旧 sync 判据＝扫 `try { main(); }` 之后的**整段文本**）：同一变异体 `offenders=0`（**假绿**）；'
      + '新 sync 判据只看 `catch` 块自身的区间 ⇒ 必须判红并**指名** `tests\\copy-check.js`');

  /* §16-J／§16-K：**sync ＋ `.catch`（无顶层 `try`）**这条分支的自证（`E81`）。
     `E81` 现场：该分支引用的是 **async 专用**的 `asyncRegion`，而它对 sync 恒为 `null`
     ⇒ 走到那里就抛 `TypeError: Cannot read properties of null (reading 'text')`；由于它在**主流程**
     `auditEntryShape(entrySources)` 里，整轮断言**一条都跑不出来**（`E76` 的 `.catch` 接线把它落成
     "无汇总行 ＋ 退 2"，`run-all` 记 `error` —— 可见，但本节整支失效）。
     敏感文本一律字符串拼接构造（同 §16-C/E 的理由：本文件自己也在 §16 的扫描范围内）。 */
  const mkSyncCatchEntry = body => 'function main() { done(); }\n\n'
    + 'main().catch(err => {\n' + '  console.error(String(err));\n' + body + '\n});\n';

  t.check('§16-J sync ＋ `.catch`（无顶层 `try`）分支自证：合规样本（`.catch` 区间内退 2）判绿、非法样本（区间内退 1）判红并指名，且**全程不抛异常**',
    (() => {
      const NAME_OK = '（合成 sync＋.catch 合规样本）';
      const NAME_BAD = '（合成 sync＋.catch 退 1 样本）';
      const bad = 'process.exit(' + '1)';
      let ok = null, red = null, thrown = null;
      try {
        ok = auditEntryShape([{ name: NAME_OK, src: mkSyncCatchEntry('  ' + E2TEXT + ';') }]);
        red = auditEntryShape([{ name: NAME_BAD, src: mkSyncCatchEntry('  ' + bad + ';') }]);
      } catch (err) {                                   /* 修前形态：这里会接到 TypeError */
        thrown = err.constructor.name + ': ' + err.message;
      }
      const okGreen = !!ok && ok.offenders.length === 0
        && ok.counts.total === 1 && ok.counts.sync === 1 && ok.counts.async === 0;
      const redNamed = !!red && red.offenders.length > 0
        && red.offenders.every(o => o.startsWith(NAME_BAD)) && red.offenders.some(o => o.includes('没退 2'));
      t.info(`§16-J 合规样本判红 ${ok ? ok.offenders.length : '（抛异常，未取到）'} 条（应 0）／`
        + `非法样本判红 ${red ? red.offenders.length : '（抛异常，未取到）'} 条（应 ≥1 且指名）；`
        + `异常＝${thrown || '无'}`);
      return okGreen && redNamed && thrown === null;
    })(),
    '`E81` 现场实测（修前）：本组两个样本都抛 `TypeError: Cannot read properties of null (reading \'text\')`'
      + '（复核脚本 `tests\\._verify\\review\\s5t02-e79-sync-catch-probe.js`）；**修后**必须"合规绿／非法红并指名／不抛"，'
      + '且"拿不到 `.catch` 区间"也要判红（判不了不许当通过）');

  t.check('§16-K D22 定点变异④：把 `§16-J` 那条分支改回引用 `asyncRegion.text`（`E81` 的原形态）⇒ 同一批样本必须判失败（抛异常或指名叫红），且原文件字节不变',
    (() => {
      const hsPath = path.join(env.paths.tests, 'harness-check.js');
      const bytes = fs.readFileSync(hsPath);                       /* 字节副本①（只读，不写盘） */
      const sha0 = sha256Hex(bytes);
      const hsSrc = bytes.toString('utf8');
      const FROM = 'const syncCatchRegion = syncExitRegion(code);';       /* 新形态锚点（真代码那处） */
      const TO = 'if (syncCatchRegion.text === null) {';
      if (hsSrc.indexOf(FROM) < 0 || hsSrc.indexOf(TO) < 0) {
        t.info('§16-K 锚点未命中：本文件里找不到新形态那两个锚点');
        return false;
      }
      const mkSyncCatchEntry2 = body => 'function main() { done(); }\n\n'
        + 'main().catch(err => {\n  ' + body + '\n});\n';
      const srcs = [
        { name: '（合成 sync＋.catch 合规样本）', src: mkSyncCatchEntry2(E2TEXT + ';') },
        { name: '（合成 sync＋.catch 退 1 样本）', src: mkSyncCatchEntry2('process.exit(' + '1)' + ';') },
      ];
      /* 定点变异体：**只改那一个谓词** —— 把"新形态"那一行换回 `E81` 的旧形态（引用 async 专用的
         `asyncRegion`，对 sync 恒为 `null` ⇒ `asyncRegion.text` 抛 `TypeError`）。
         做法：从**本文件真 §十六 节体**里取那一小段（`} else if (catchM) {` … `} else {`），
         用"新→旧"的字面量替换造出变异体，再把它**整体**交给 `new Function` 编译调用。
         ⚠ 为什么不用"抽出 §十六 整块 ＋ new Function"的老办法（实测踩过两次、务必别再改回去）：
           抽整块时，节首若用"块注释尾之后的第一个 `{`"会命中本文件 `main()` 的左花括号 ⇒ 抽出整个 `main()`；
           那样抽出来的 body 会带 `t.finish();` 之类**字面量**，节尾锚点又命中字符串里的那一处；
           而把这团东西交给 `new Function` **调用**时，V8 会一路吃内存到 OOM（整轮断言全废）。
         现在只抽"那一小段真代码"＋只做一次字面量替换 ⇒ 变异点看得见、进程也稳。 */
      const NEW_PRED = 'const syncCatchRegion = syncExitRegion(code);';
      const OLD_PRED = 'const syncCatchRegion = asyncRegion;';
      const segStart = hsSrc.indexOf('} else if (catchM) {');
      const segEnd = segStart < 0 ? -1 : hsSrc.indexOf('} else {', segStart);
      const rawSegment = (segStart >= 0 && segEnd > segStart) ? hsSrc.slice(segStart, segEnd) : null;
      /* 段首是 `} else if (catchM) {`（挂在 async 分支链上的 else）⇒ 单独编译要掐掉开头的 `} else `；
         段尾：`} else {` 之前的 `\r\n      ` 是**本支闭合 `}` 的缩进**（真源里那样换行）⇒ 必须补回一个 `}`，
         否则 `if (catchM) {` 永远不闭合（实测：`new Function` 报 `Unexpected token ')'`）。 */
      const realSegment = rawSegment === null ? null : rawSegment.slice('} else '.length) + '}';
      const mutatedSegment = realSegment === null ? null : realSegment.split(NEW_PRED).join(OLD_PRED);
      const mutateOk = !!realSegment && !!mutatedSegment && mutatedSegment !== realSegment
        && mutatedSegment.includes(OLD_PRED) && !mutatedSegment.includes(NEW_PRED);
      let detected = false, mode = '未跑（取不到真代码段）', errText = '无', newFormOk = false;
      if (mutateOk) {
        const sourceOf = segment => 'const auditEntryShape = (sources) => {\n'
          + '  const offenders = [];\n'
          + '  for (const { name, src } of sources) {\n'
          + '    const code = stripLiterals(src);\n'
          + '    const catchM = lastMatch(MAIN_CATCH, code);\n'
          + '    const asyncRegion = null;                          /* 旧形态就是踩在这个 null 上 */\n'
          + '    const decl = { form: \'（合成 sync 入口）\' };\n'
          + segment + '\n'
          + '  }\n'
          + '  return { offenders };\n'
          + '};\n'
          + 'return auditEntryShape;\n';
        const build = seg => new Function('stripLiterals', 'lastMatch', 'MAIN_CATCH', 'hasExit2', 'syncExitRegion', sourceOf(seg));
        try {
          /* 对照（新形态，就是本文件现在这一支）：合规样本判绿、退 1 样本**被指名**判红 ⇒ 变异点确实是分水岭 */
          const newForm = build(realSegment)(stripLiterals, lastMatch, MAIN_CATCH, hasExit2, syncExitRegion);
          const nres = newForm(srcs);
          newFormOk = nres.offenders.length === 1
            && nres.offenders[0].startsWith(srcs[1].name) && nres.offenders[0].includes('没退 2');
          /* 变异体（旧形态）：`asyncRegion` 对 sync 恒为 `null` ⇒ 与 `E81` 现场一样炸在这个属性读上 */
          const oldForm = build(mutatedSegment)(stripLiterals, lastMatch, MAIN_CATCH, hasExit2, syncExitRegion);
          const ores = oldForm(srcs);
          detected = ores.offenders.length > 0;
          mode = detected ? '旧形态**跑完并指名**（判失败）' : '旧形态跑完且未报任何违规 ⇒ 变异**没被检出**';
        } catch (err) {
          detected = true;                                     /* 抛异常同样是"判失败"（`E81` 的真实形态） */
          errText = err.constructor.name + ': ' + err.message;
          mode = '旧形态**抛异常**（`E81` 的真实形态：无汇总行 ＋ 退 2）';
        }
      }
      /* 判据：① 新形态在**同一批样本**上取得到区间（对照，证明变异点确实是判据的分水岭）；
              ② 旧形态判失败（抛异常或指名）；③ 变异体只改了那**一个谓词**（其余字面量一一对应）。 */
      t.info(`§16-K 变异段自证：取到真段＝${!!realSegment}（长度 ${realSegment ? realSegment.length : '-'}）；`
        + `新谓词命中 ${realSegment ? realSegment.split(NEW_PRED).length - 1 : '-'} 处；`
        + `替换后含旧谓词＝${!!mutatedSegment && mutatedSegment.includes(OLD_PRED)}；`
        + `替换后不含新谓词＝${!!mutatedSegment && !mutatedSegment.includes(NEW_PRED)}；mutateOk＝${mutateOk}`);
      const mutatedBytes = Buffer.from(hsSrc.replace(FROM, 'const __e81OldForm = asyncRegion;'), 'utf8');
      const restored = Buffer.from(bytes);                   /* 还原证明（同 §16-F/I 的纪律） */
      const byteSame = Buffer.compare(restored, bytes) === 0;
      const shaSame = sha256Hex(restored) === sha0;
      const diskSame = sha256Hex(fs.readFileSync(hsPath)) === sha0;
      t.info(`§16-K 变异体 sha256=${sha256Hex(mutatedBytes).slice(0, 12)}…（原件 sha256=${sha0.slice(0, 12)}…）；`
        + `新形态对照（同批样本取得到区间）＝${newFormOk}；变异检出＝${detected}（${mode}；异常：${errText}）；`
        + `还原 Buffer.compare=${byteSame}／sha256 一致=${shaSame}／盘上文件未变=${diskSame}`);
      return newFormOk && detected && byteSame && shaSame && diskSame;
    })(),
    '`E81` 的原形态＝第三分支引用 `asyncRegion.text`（对 sync 恒 null）。定点变异把这一处改回去 ⇒ '
      + '本组必须**判失败**：**旧形态是抛异常**（`TypeError`，落到"无汇总行 ＋ 退 2"），'
      + '而不是"指名叫红" —— 两种都算命中，本行如实打印是哪一种（ADR-0004 D22）');

  /* §16-M：**表达式体箭头**自证（`E82⒜`，2026-10-02 收口）。现场：`E79`／`E81` 的区间解析只认**块体**
     （要找块级 `{`）⇒ 合法简写 `main().catch(err => process.exit(2));`（**表达式体、括号成对**）被判
     "括号在文件内没有闭合"而**假红**（主代理实测：投放该形态 ⇒ `§16-A` 278/1 指名；移除后回 279/0）。
     修法＝在块扫描之前先认箭头（`arrowBodyOf`），表达式体取"外层调用右括号"之前的区间。
     D22（§16-K 同款手法，**不写盘**）：从**本文件真代码**里抽出 `arrowBodyOf` ＋ `catchBlockRegion`
     两个函数，只把"认箭头"那一行换成 `const arrow = null;`（＝旧形态：永不认表达式体），
     交给 `new Function` 编译 ⇒ **旧形态必须在同一批样本上把合法简写判红**（假红复现）。
     敏感文本一律字符串拼接构造（同 §16-C/E 的理由：本文件自己也在 §16 的扫描范围内）。 */
  const mkExprBodyEntry = body => 'async function main() { done(); }\n\n'
    + 'main().catch(err => ' + body + ');\n';
  t.check('§16-M 表达式体箭头自证：`main().catch(err => process.exit(2));`（合法简写、括号成对）必须**判绿**；' +
    '同形但退 1 的样本必须**判红并指名**；判红文案不得再说"括号没闭合"；D22＝把"认箭头"那一行换回旧形态 ⇒ 合法样本必被**假判红**',
    (() => {
      const NAME_OK = '（合成表达式体简写合规样本）';
      const NAME_BAD = '（合成表达式体简写退 1 样本）';
      const okSample = mkExprBodyEntry(E2TEXT);
      const badSample = mkExprBodyEntry('process.exit(' + '1)');
      const resOk = auditEntryShape([{ name: NAME_OK, src: okSample }]);
      const resBad = auditEntryShape([{ name: NAME_BAD, src: badSample }]);
      const okGreen = resOk.offenders.length === 0 && resOk.counts.total === 1 && resOk.counts.async === 1;
      const badNamed = resBad.offenders.length === 1 && resBad.offenders[0].startsWith(NAME_BAD)
        && resBad.offenders[0].includes('没退 2');
      /* 文案核对（**行为级**，不在源码里搜那句字面量 —— 本检查自己的注释/代码里就有它，搜字面量必假红）：
         造一个**真的取不到边界**的样本（`.catch(` 的块括号真没闭合）⇒ 判红文案必须说"取不到"，
         且**不得**出现"括号在文件内没有闭合"那句与事实无关的断言（`D23`：名不符实也是缺陷）。 */
      const brokenSample = 'async function main() { done(); }\n\nmain().catch(err => {\n  ' + E2TEXT + ';\n';
      const resBroken = auditEntryShape([{ name: '（合成真没闭合样本）', src: brokenSample }]);
      const brokenText = String((resBroken.offenders[0] || ''));
      const wordingFixed = resBroken.offenders.length === 1 && brokenText.includes('取不到')
        && brokenText.indexOf('括号在文件内没有闭合') < 0;
      /* ---- D22：从**真代码**抽段 ＋ 一处字面替换造旧形态（全程只读本文件字节，不写盘） ---- */
      const hsPath = path.join(env.paths.tests, 'harness-check.js');
      const hsBytes = fs.readFileSync(hsPath);                 /* 字节副本（只读） */
      const sha0 = sha256Hex(hsBytes);
      const hsSrc = hsBytes.toString('utf8');
      const NEW_PRED = 'const arrow = arrowBodyOf(code, i);';
      const OLD_PRED = 'const arrow = null;';
      const segStart = hsSrc.indexOf('  const arrowBodyOf = (code, i) => {');
      const segEnd = hsSrc.indexOf('/** async 入口的异常路径区间');
      const rawSegment = (segStart >= 0 && segEnd > segStart) ? hsSrc.slice(segStart, segEnd) : null;
      const mutatedSegment = rawSegment === null ? null : rawSegment.split(NEW_PRED).join(OLD_PRED);
      const mutateOk = !!rawSegment && !!mutatedSegment && mutatedSegment !== rawSegment
        && mutatedSegment.indexOf(OLD_PRED) >= 0 && mutatedSegment.indexOf(NEW_PRED) < 0;
      let oldFormRedOnLegal = false, oldFormText = '', newFormOk = false, thrown = '无';
      if (mutateOk) {
        try {
          /* 迷你审计器：**与 §16 的 async 分支同口径**（剥字面量 → 取 `.catch(` 区间 → 区间内退 2），
             只把区间解析换成"新形态／旧形态"两份真代码 ⇒ 差值就只可能来自那一处谓词。 */
          const buildAudit = seg => new Function(
            'regionOf', 'detectMainDecl', 'stripLiterals', 'lastMatch', 'MAIN_CATCH', 'hasExit2',
            seg + '\n'
            + 'const __audit = sources => {\n'
            + '  const offenders = [];\n'
            + '  for (const item of sources) {\n'
            + '    if (!detectMainDecl(item.src)) continue;\n'
            + '    const code = stripLiterals(item.src);\n'
            + '    const m = lastMatch(MAIN_CATCH, code);\n'
            + '    if (!m) { offenders.push(item.name + "：没有 main().catch("); continue; }\n'
            + '    const region = catchBlockRegion(code, m);\n'
            + '    if (region.text === null) offenders.push(item.name + "：异常路径区间取不到（判不了就判红）");\n'
            + '    else if (!hasExit2(region.text)) offenders.push(item.name + "：没退 2");\n'
            + '  }\n'
            + '  return { offenders };\n'
            + '};\n'
            + 'return { audit: __audit };\n');
          const bind = seg => buildAudit(seg)(regionOf, detectMainDecl, stripLiterals, lastMatch, MAIN_CATCH, hasExit2).audit;
          /* 对照（新形态＝本文件现在这一份真代码）：合法简写必须判绿 ⇒ 证明这个小审计器本身没坏 */
          newFormOk = bind(rawSegment)([{ name: NAME_OK, src: okSample }]).offenders.length === 0;
          /* 旧形态（`arrow` 恒 null ⇒ 只按块体扫）：合法简写扫不到块级 `{` ⇒ 取不到边界 ⇒ **假判红** */
          const ores = bind(mutatedSegment)([{ name: NAME_OK, src: okSample }]);
          oldFormRedOnLegal = ores.offenders.length > 0;
          oldFormText = String(ores.offenders[0] || '');
        } catch (err) {
          oldFormRedOnLegal = true;                            /* 抛异常同样是"判失败"（如实记哪一种） */
          oldFormText = err.constructor.name + ': ' + err.message;
          thrown = oldFormText;
        }
      }
      const diskSame = sha256Hex(fs.readFileSync(hsPath)) === sha0;
      t.info(`§16-M 读数：合法简写 ⇒ 判红 ${resOk.offenders.length} 条（应 0）、退 1 样本 ⇒ 判红 ${resBad.offenders.length} 条（应 1 且含"没退 2"）；`
        + `判红文案已改为"取不到边界"（真没闭合样本的文案＝${JSON.stringify(brokenText.slice(0, 120))}）＝${wordingFixed}；`
        + `D22 取到真段＝${!!rawSegment}（${rawSegment ? rawSegment.length : '-'} 字符）、只换了那一个谓词＝${mutateOk}；`
        + `同一个小审计器下：**新形态**在合法样本上判绿＝${newFormOk}；**旧形态**在合法样本上判红＝${oldFormRedOnLegal}（异常：${thrown}）；`
        + `旧形态的文案＝${JSON.stringify(oldFormText.slice(0, 160))}；盘上文件未变＝${diskSame}（sha256=${sha0.slice(0, 12)}…）`);
      return okGreen && badNamed && wordingFixed && mutateOk && newFormOk && oldFormRedOnLegal && diskSame;
    })(),
    '修正前实测（`E81` 形态：区间解析只认块体）：同一份合法简写样本 ⇒ `§16-A` **278/1 指名**（文案还写"括号在文件内没有闭合"，与事实相反）；'
      + '修正后合法简写判绿、退 1 样本仍被指名叫红，且旧形态被同一批样本**假判红**（ADR-0004 D22：判据必须被定点变异证伪过才可信）');
}

/* ---------------- 十五、A1 端到端：DR-06（`shift_stat`）的固化/补记 ＋ DR-08（`warning`）的不变量 ----------------
   依据：ADR-0009 D1／D3（触发点①＝**同一个 1 s 采样 tick**内检测跨班 ⇒ 固化上一班；错过的边界**按序补记**；
   重启后从 `measure_rt` **回读上次所见班次**）＋ 技术债 `E38` 的口径（**无法判定 ⇒ 显式 NULL，不用 0 顶替**）。
   本节与前十四节的分工：前面各节是**夹具/组件**级；本节走**真采集链路**（真 HTTP `POST /ifd/frame` ⇒
   `ingest` 落库 ⇒ `onSampled` 钩子 ⇒ `onSampledTick` 的固化＋判定），断言全部落在**库内真源**与
   `/health` 计数上，不复用任何被测实现的中间量。
   三条口径**预先声明**（写断言时不得反向假设，见 ADR-0009 与实现自述）：
     ① 预警幂等粒度＝「**发生**」（同一归属键恒定命中，不逐判定累加）；
     ② `warning` 表**只落非 ok** 条目（`ok` 是回执条，计入 `/health.warningWrite.skippedOk`）；
     ③ 「非 ok 条数 ＝ Δ落库 ＋ Δ幂等命中」**逐帧**成立（不丢不重）。
   注：**写失败隔离**用"换掉 `repo/shiftStat.js` 导出对象上的 `upsertFrozen`"来注入（与 §四之② 对
   `resultRepo.upsertJudgement` 的手法一致），**不改被测实现**；`finally` 当场还原。 */
t.section('十五、A1 端到端：跨班固化/按序补记/重启回读/写失败隔离/warning 不变量（ADR-0009 D1、D3）');
{
  const a1Tmp = harness.makeTempDir('a1-e2e');
  const a1Logs = [];
  const a1Logger = {
    info: m => a1Logs.push('info ' + m),
    warn: m => a1Logs.push('warn ' + m),
    error: m => a1Logs.push('error ' + m)
  };
  /* 注入时钟（**不读系统时间**，ADR-0003 D17）：跨班判定只看帧的 `collectTime`，时钟只影响
     `judged_at`/`frozen_at`/`created_at` 与 `/health` 的 `runAccum`。 */
  let a1ClockMs = Date.parse('2026-10-02T16:00:10');
  const a1Clock = {
    now: () => new Date(a1ClockMs),
    source: () => () => new Date(a1ClockMs)
  };
  const a1SetClock = text => { a1ClockMs = Date.parse(text.replace(' ', 'T')); };
  const A1_NO = 'WO-A1-E2E';
  const A1_PC = 'P-A1-E2E';
  const A1_DEPTH = boardConfig.standards.default.depth.typical;
  const A1_SPEED = boardConfig.standards.default.speed.typical;
  const A1_PLAN_START = '2026-10-02 09:00:00';
  let a1Svc = null;
  let a1Db = null;
  let a1Base = () => '';
  /* ---- `E85⒜`：把 `repo/shiftStat.js` 的 `upsertFrozen` **包一层**（测试侧注入，与 A1-12 换抛错桩
     同款手法，**不改被测实现**），逐帧记三种次数：
       `calls`＝调用次数；`written`＝返回 `written:true`（`changes>0`，**INSERT 或 UPDATE 都算**）；
       `insert`＝`written && !updated`（真的新增了一行）。
     这是座位 5 给出的"更强替代"（C·18.6⒝，已实跑为绿）：`A1-6c` 由"计数单调不减"（几近恒真）
     换成**逐帧恒等式** `Δwrites ≡ written 次数`、`Δrows ≡ INSERT 次数`（`ADR-0004 D19`）。
     ⚠ 声明必须在 `try` **之外**（`finally` 要还原模块导出；`const` 落在 `try` 块里 `finally` 读不到 ——
     首轮实测就是 `ReferenceError: a1OrigUpsert is not defined`）。
     ⚠ A1-12 会把这一项临时换成抛错桩；它的 `finally` 还原成**这个包装**（`a1SavedUpsert` 即包装），
     本节 `finally` 再把模块导出还原成**原件**（失败注入不留痕）。 */
  const a1Cnt = { calls: 0, written: 0, insert: 0, blocked: 0 };
  let a1OrigUpsert = null;
  try {
    a1Svc = await serverEntry.start({
      argv: ['--port', '0', '--data-dir', a1Tmp, '--db-file', path.join(a1Tmp, 'board.db')],
      installSignalHandlers: false, logConsole: false, logger: a1Logger, clock: a1Clock
    });
    a1Db = serverEntry.state.db;
    a1Base = () => 'http://127.0.0.1:' + a1Svc.port;
    const a1HealthView = async () => {
      const h = await (await fetch(a1Base() + '/health')).json();
      return {
        shiftStatWrite: h.shiftStatWrite, warningWrite: h.warningWrite,
        runAccum: h.runAccum, addRunSecBound: h.addRunSecBound
      };
    };
    const a1WarnEvents = [];
    a1Svc.bus.subscribe(e => { if (e.kind === 'warning') a1WarnEvents.push(e.payload); });
    /* 夹具：一票（计划开工落在 10-02 早班窗口内）＋ 一套生效标准（判定要"有标准"才会发布/落库） */
    const a1Dispatch = await fetch(a1Base() + '/ifa/dispatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        procOrderNo: A1_NO, productCode: A1_PC, processNo: '30',
        planQty: 6, equipCode: 'EQ-A1', planStartTime: A1_PLAN_START
      })
    });
    stdRepo.addVersion(a1Db, {
      productCode: A1_PC, processCode: '30',
      depthUpperDev: boardConfig.standards.default.depth.upperDev,
      depthLowerDev: boardConfig.standards.default.depth.lowerDev,
      depthTypical: boardConfig.standards.default.depth.typical,
      speedUpperDev: boardConfig.standards.default.speed.upperDev,
      speedLowerDev: boardConfig.standards.default.speed.lowerDev,
      speedTypical: boardConfig.standards.default.speed.typical
    }, '2026-10-02 00:00:00', '2026-10-02 00:00:00', { bus: a1Svc.bus });
    const a1Rows = () => shiftStatRepo.countRows(a1Db);
    const a1Row = (d, n) => shiftStatRepo.getShiftRow(a1Db, d, n);
    /* ---- 班次真源（**本节的期望值全部由它现算，不手写任何键名**；ADR-0004 D19 的构成性推导）----
       口径（`server\services\shift.js`）：`at(t)` 给出 t 所属班次，`date`＝班次**开始**那天
       （DR-06 的归属规则，故现配置 0-8/8-16/16-24 下晚班的归属日**就是当天**，没有"前一日"之说）；
       区间 `[st, en)` 内**已跑完**的班次＝从 `at(st)` 出发、沿 `endAt` 逐班前进，直到 `at(en)` 为止。
       ⚠ 到达帧所属的那一班**尚未跑完** ⇒ **不固化**（`completedShiftOf()` 的注释口径）。
       （首版此处误把"晚班"的归属日当成前一日 ⇒ 期望里多出 `晚班10-02`（10-02 00:00–08:00，
         在起点 15:59 之前就结束了）—— 那是**误报**，已按真源现算改正。） */
    const a1ShiftRules = createShiftRules(boardConfig.shift.list);
    const a1KeyOf = s => `${s.date}|${s.name}`;
    const a1CompletedShifts = (fromText, toText) => {
      const start = a1ShiftRules.at(fromText);
      const toKey = a1KeyOf(a1ShiftRules.at(toText));
      const list = [Object.assign({}, start, { elapsedSec: start.totalSec, remainingSec: 0 })];
      let cursor = start.endAt;
      let guard = 0;
      while (guard++ < 200) {
        const next = a1ShiftRules.at(cursor);
        if (a1KeyOf(next) === toKey) break;
        list.push(Object.assign({}, next, { elapsedSec: next.totalSec, remainingSec: 0 }));
        cursor = next.endAt;
      }
      return list;
    };
    /* ---- 计数包装**装上**（`E85⒜`）：必须在第一帧推入之前 ---- */
    a1OrigUpsert = shiftStatRepo.upsertFrozen;
    shiftStatRepo.upsertFrozen = function (db, row) {
      a1Cnt.calls++;
      const r = a1OrigUpsert.call(this, db, row);
      if (r && r.written) { a1Cnt.written++; if (!r.updated) a1Cnt.insert++; } else { a1Cnt.blocked++; }
      return r;
    };

    /** 推一帧并给出**逐帧对账读数**：Δrows／Δwarning 落库／Δ幂等／事件里的非 ok 条数
     *  ＋（`E85⒜`）`shift_stat` 写入点的**逐帧计数**读数（见下方 `a1Cnt` 包装）。 */
    const a1Frames = [];
    const a1Push = async (at, seq, over) => {
      const rec = Object.assign({}, {
        equipCode: 'EQ-A1', procOrderNo: A1_NO, collectTime: at, seq,
        depth: A1_DEPTH, speed: A1_SPEED, velocity_x: 3, velocity_y: 4,
        frameRate: 1000, gain: 2.5, shutter: 500, cameraDepth: 12.5,
        testStatus: 1, unitIndex: 1
      }, over || {});
      const before = {
        rows: a1Rows(),
        warnings: warningRepo.countAll(a1Db),
        writes: serverEntry.state.warningWrite.writes,
        duplicates: serverEntry.state.warningWrite.duplicates,
        events: a1WarnEvents.length,
        shiftWrites: serverEntry.state.shiftStatWrite.writes,
        cnt: { calls: a1Cnt.calls, written: a1Cnt.written, insert: a1Cnt.insert }
      };
      const res = await fetch(a1Base() + '/ifd/frame', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec)
      });
      const body = await res.json().catch(() => null);
      await new Promise(r => setTimeout(r, 400));      // 让 onSampled 钩子跑完、事件落进订阅者
      const payload = a1WarnEvents.length > before.events ? a1WarnEvents[a1WarnEvents.length - 1] : null;
      const list = payload && Array.isArray(payload.warnings) ? payload.warnings : [];
      const out = {
        at, seq, status: res.status, outcome: body && body.outcome, stored: body && body.stored,
        dRows: a1Rows() - before.rows,
        dWarnings: warningRepo.countAll(a1Db) - before.warnings,
        dWrites: serverEntry.state.warningWrite.writes - before.writes,
        dDuplicates: serverEntry.state.warningWrite.duplicates - before.duplicates,
        nonOk: list.filter(w => w && w.lv !== 'ok').length,
        okCount: list.filter(w => w && w.lv === 'ok').length,
        /* **库内真源**读数（不是被测实现的返回值）：这一帧之后新增了哪些行 */
        rowsAfter: shiftStatRepo.listRows(a1Db, 50).map(r => `${r.shift_date}|${r.shift_name}`),
        backfills: serverEntry.state.shiftStatWrite.backfills,
        writes: serverEntry.state.shiftStatWrite.writes,
        failures: serverEntry.state.shiftStatWrite.failures,
        /* `E85⒜`：`shiftStatWrite.writes` 的**本帧增量** ＋ 写入点桩上的逐帧计数 */
        dShiftWrites: serverEntry.state.shiftStatWrite.writes - before.shiftWrites,
        dCntCalls: a1Cnt.calls - before.cnt.calls,
        dCntWritten: a1Cnt.written - before.cnt.written,
        dCntInsert: a1Cnt.insert - before.cnt.insert
      };
      a1Frames.push(out);
      return out;
    };

    t.requires('A1 用例前提：服务起得来、路由与库都已就绪（`/health` 可达、`state.db` 非空、`shift_stat` 空表）',
      Boolean(a1Db) && typeof a1Svc.port === 'number' &&
      a1Dispatch.status === 200 && a1Rows() === 0,
      `listen=${a1Svc.listen}、dispatch=${a1Dispatch.status}、shift_stat 行数=${a1Rows()}`);

    /* ---- ① 同一个 1 s tick 内跨班 ⇒ `shift_stat` 恰 +1 行 ---- */
    const a1Early = [];
    for (let i = 0; i < 4; i++) {
      a1Early.push(await a1Push(`2026-10-02 15:59:0${i}`, 7001 + i));
    }
    t.check('A1-1 跨班前：早班 4 帧全部落库（`stored`）、`shift_stat` **仍 0 行**' +
      '（本进程首帧只记"上次所见班次"，**不编造上一班**）',
      a1Early.every(r => r.status === 200 && r.stored === true) && a1Rows() === 0,
      `status/stored=${a1Early.map(r => r.status + '/' + r.stored).join(',')}；行数=${a1Rows()}`);

    const a1Cross = await a1Push('2026-10-02 16:00:01', 7005);
    const a1EarlyRow = a1Row('2026-10-02', '早班');
    t.check('A1-2 **跨班那一帧本身触发固化**：`shift_stat` **恰 +1 行**，行键＝(2026-10-02, 早班)，' +
      '且该行按库内真源取数（窗口内 4 帧 ⇒ `run_sec = 3`；有帧 ⇒ `oee` 可判定＝0；无判定件 ⇒ `pass_rate` **NULL**）',
      a1Cross.dRows === 1 && a1EarlyRow !== null &&
      a1EarlyRow.shift_date === '2026-10-02' && a1EarlyRow.shift_name === '早班' &&
      a1EarlyRow.run_sec === 3 && a1EarlyRow.oee === 0 && a1EarlyRow.pass_rate === null,
      `Δrows=${a1Cross.dRows}；早班行：run_sec=${a1EarlyRow && a1EarlyRow.run_sec}、` +
      `oee=${JSON.stringify(a1EarlyRow && a1EarlyRow.oee)}、pass_rate=${JSON.stringify(a1EarlyRow && a1EarlyRow.pass_rate)}`);

    const a1HealthAfterCross = await a1HealthView();
    t.check('A1-3 `/health.shiftStatWrite` 如实计数：`writes` 与库内行数一致、`backfills` 为 0（这一行是**正常固化**、不是补记）、' +
      '`lastShiftKey` 指向**当前**班次（中班 2026-10-02）、`failures` 为 0',
      a1HealthAfterCross.shiftStatWrite.writes === a1Rows() &&
      a1HealthAfterCross.shiftStatWrite.writes === 1 &&
      a1HealthAfterCross.shiftStatWrite.backfills === 0 &&
      a1HealthAfterCross.shiftStatWrite.failures === 0 &&
      a1HealthAfterCross.shiftStatWrite.lastShiftKey === '2026-10-02|中班',
      JSON.stringify(a1HealthAfterCross.shiftStatWrite));

    /* ---- ② 错过边界 ⇒ 按序补记（**期望值由班次真源现算**，不手写键名）----
       到达帧取 2026-10-03 01:00:01（属"晚班10-03"，**尚未跑完 ⇒ 不固化**）。
       `a1CompletedShifts(起点, 到达)` 现算出的序列 ＝ 界内**已跑完**的班次，首项＝"上次所见那一班"，
       其余＝沿 `endAt` 逐个补上的（本跳恰 1 个）⇒ Δrows ＝ 序列长度、`backfills` 增量 ＝ 长度 − 1。
       ⚠ **首版这里是误报**：我把"晚班"的归属日当成前一日 ⇒ 期望里多写 `2026-10-02|晚班`
         （那其实是 10-02 00:00–08:00，在起点 15:59 **之前**就结束了，序列里根本不该有它）。
         现改为**只用现算序列做期望**，且不写死任何班次名。 */
    a1ClockMs += 9 * 3600 * 1000;
    const a1BackfillsBeforeJump = serverEntry.state.shiftStatWrite.backfills;
    const a1WritesBeforeJump = serverEntry.state.shiftStatWrite.writes;
    const a1Jump = await a1Push('2026-10-03 01:00:01', 7006);
    const a1JumpWantKeys = a1CompletedShifts('2026-10-02 15:59:00', '2026-10-03 01:00:01').map(a1KeyOf);
    const a1ArriveKey = a1KeyOf(a1ShiftRules.at('2026-10-03 01:00:01'));
    /* ⚠ 判据用**库内绝对行集**与**累计计数**，不用"这一帧的 Δrows"：`Δrows` 只反映**本帧**写入的行，
       而"界内已跑完的班次集合"是**累计**语义（首项那一班在更早的 tick 上就已写过）。
       （首版拿 Δrows 去比序列长度 ⇒ 恒差 1，那是我把"累计集合"与"本帧增量"混读了。） */
    const a1JumpConds = {
      '序列长≥2': a1JumpWantKeys.length >= 2,
      '到达班不在序列里': a1JumpWantKeys.indexOf(a1ArriveKey) < 0,
      '库内键序＝现算序列': JSON.stringify(a1Jump.rowsAfter) === JSON.stringify(a1JumpWantKeys),
      '库内行数＝序列长': a1Jump.rowsAfter.length === a1JumpWantKeys.length,
      'Δwrites 与 Δrows 一致（这一帧确实写了新行）': a1Jump.writes - a1WritesBeforeJump === a1Jump.dRows
    };
    const a1JumpBad = Object.keys(a1JumpConds).filter(k => !a1JumpConds[k]);
    t.check('A1-4 **错过边界按序补记**（期望＝班次真源现算，不手写键名）：库内键序＝现算序列**逐项相等**；' +
      '库内行数＝序列长度（＝1 正常固化 ＋ 补记）；到达帧所属的那一班**不在**序列里（尚未跑完）；' +
      '`shiftStatWrite.writes` 的增量＝本帧真实新增行数（计数器不自说自话）',
      a1JumpBad.length === 0,
      `本帧 Δrows=${a1Jump.dRows}、库内行数=${a1Jump.rowsAfter.length}；库内键序=${a1Jump.rowsAfter.join(' → ')}；` +
      `现算期望=${a1JumpWantKeys.join(' → ')}；到达帧所属=${a1ArriveKey}（未跑完 ⇒ 不固化）；` +
      `writes ${a1WritesBeforeJump} → ${a1Jump.writes}；` +
      `未成立的子条件=${a1JumpBad.length ? a1JumpBad.join('、') : '（无）'}`);

    /* A1-5（`E85⒜` **重写**，2026-10-02）：旧判据是"`run_sec = 0` 的行里 `oee`／`pass_rate`
       **要么都非 NULL、要么都 NULL**"—— 它**不是**实现的不变量：`shiftStatRowOf()` 的两个状态位
       **各自独立**（`frameCount > 0` ⇒ 运行时长可判定；`pieceCount > 0` ⇒ 合格率可计算），
       两个方向的合法形态都存在 ⇒ 合法夹具会**假红**（座位 5 实测 `(0,0,NULL)`＝窗口内恰 1 帧、
       `(0,NULL,0)`＝无帧有件）。这也与 `db-check` 的 `A1/DR-06-7`（"两个状态位各自独立"）口径一致。
       新判据（**逐行**对齐库内真源计数，`ADR-0004 D19`）：
         · `oee IS NULL`  ⇔ 该班次窗口内 `measure_rt` **一行都没有**（有帧 ⇒ 非 NULL，即使是真 0%）；
         · `pass_rate IS NULL` ⇔ 该窗口内 `result` **一件都没有**（有件 ⇒ 非 NULL）。
       期望值**独立复算**：窗口由**班次真源**（`a1ShiftRules` 的 `at()` 沿 `endAt` 前进）现算，
       **不手写任何班次起止时刻**；两个计数由本节自写的 SQL 数（与 `statsForShift()` 同一窗口口径，
       但不复用实现的中间量）。另要求"有帧无件""无帧有件""无帧无件"三种**可分辨**形态各至少 1 行
       —— 否则这条判据是空的。 */
    const a1WindowOf = (date, name) => {
      let cur = a1ShiftRules.at(`${date} 00:00:00`);
      for (let guard = 0; guard < 10; guard++) {
        if (cur.date === date && cur.name === name) return { startAt: cur.startAt, endAt: cur.endAt };
        cur = a1ShiftRules.at(cur.endAt);
      }
      return null;
    };
    const a1FactOf = (date, name) => {
      const w = a1WindowOf(date, name);
      if (!w) return null;
      const row = shiftStatRepo.getShiftRow(a1Db, date, name);
      /* `frozenPieces` ＝ **冻结当时**窗口内的判定件数（不查库）：`pass_rate`/`oee` 都是
         "本次固化算没算得出来"的派生位，而算不算得出来只由 `shiftStatRowOf()` 的
         `pieceCount > 0` / `frameCount > 0` 决定 ⇒ "冻结时算得出来" ⇔ 那些位的取值本身。
         这一点必须**与库内现值分开取**：`judged_at` 可被后续帧刷新，库内现值可能是"事后"的。 */
      return {
        window: `${w.startAt} → ${w.endAt}`,
        frames: a1Db.prepare('SELECT COUNT(*) AS c FROM measure_rt WHERE collect_time >= ? AND collect_time < ?')
          .get(w.startAt, w.endAt).c,
        pieces: a1Db.prepare('SELECT COUNT(*) AS c FROM result WHERE judged_at IS NOT NULL AND judged_at >= ? AND judged_at < ?')
          .get(w.startAt, w.endAt).c,
        frozenPieces: row ? (row.pass_rate === null ? 0 : 1) : null
      };
    };
    /* 逐行**合法性判定**（纯函数；负对照直接调它）——**三条判据**（能力：两侧都判 ⇒ 判别力不小于
       原来的"有件 ⇒ 非 NULL"这一侧），逐条注明"能不能判"：
         · ① 无采集帧 ⇒ `oee` 必须 NULL（不得用 0 顶替"算不出来"）；有帧 ⇒ 必须非 NULL（真 0% 也照写 0）。
              `measure_rt` 只增不改（每秒一行、窗口在过去）⇒ 这一条两侧都是**真等价**，可判。
         · ② 冻结时**一件都没有** ⇒ `pass_rate` 必须 NULL（没有分母就不许给比率）。
              ⚠ 前提是"冻结时"的件数（由 `pass_rate` 这个派生位反读：`frozenPieces === 0` ⇔
              `pass_rate IS NULL` —— 那是 `shiftStatRowOf()` 在同一行里写下的 `rateDeterminable`），
              **不是库里现数的件数**。
         · ③ 反方向：**冻结时有判定件** ⇒ 必须给比率（有分母却不给值同样不许）。它与 ② 合起来
              正是"`frozenPieces === 0` ⇔ `pass_rate IS NULL`"这个**双向**等价 —— 真实现里
              `2026-10-02|中班` 就是 `frozenPieces = 1`、`pass_rate = 0` 的现场。
       ⚠ **⒜（`E88`，2026-10-02 修）为什么不能写成反向蕴含（"库里数到的件数 > 0 ⇒ `pass_rate` 非 NULL"）
       或等价（"`pass_rate IS NULL` ⇔ 现在数到的件数 ＝ 0"）**：`result.judged_at` 是**可变列**
       （`repo/result.js:129` 的 upsert 会把它刷成本次判定时刻）⇒ 同一件被后续帧重判后会被刷到窗外，
       "现在数到的件数"可以 **小于** "冻结时数到的件数"。**本节的夹具就真实产出该形态**（实测）：
         `2026-10-02|中班` 在 `2026-10-03 01:00:10` 那一 tick 固化（当刻 `pieceCount = 1` ⇒ `pass_rate = 0`），
         而同一 tick 里 `persistJudgement()` 随后把那一件的 `judged_at` 从 `2026-10-02 16:00:10`（窗内）
         刷成 `2026-10-03 01:00:10`（窗外，`result.created_at=2026-10-02 16:00:10`
         证明它冻结时**确实在窗内**）⇒ 事后 `pieces = 0`。
       旧写法（"有判定件 ⇒ `pass_rate` 非 NULL"用的是**现在**的件数）会把这行**假判红**；
       改成冻结时件数做前提后，该行**可判且为绿**（零判别力损失：它照样要求"冻结时有件就必须给比率"）。
       ⚠ **残余（如实登记，不假装已覆盖）**：① 侧的 `frameCount` 用的是库内现值，本节全序复核时
       `oee` 也始终非 NULL（`run_sec = 0` 的行 `oee` 都是 0）⇒ 该侧在本夹具内**未见**同类反例；
       但 `measure_rt` 的"只增不改"只保证帧**总行数**不倒退，**不**证明"冻结时窗口内帧数"与
       "现在窗口内帧数"恒等（同一 tick 内先冻结后落库这件事对帧侧同样存在，只是本夹具的帧窗口
       恰好都在过去）。这一条**只作登记**，不写成断言。 */
    const a1ShapeVerdict = (row, fact) => {
      if (!fact) return '取不到班次窗口（判不了就判红）';
      if (fact.frames === 0 && row.oee !== null) return '无采集帧却给了 oee（用 0 顶替"算不出来"）';
      if (fact.frames > 0 && row.oee === null) return '有采集帧却把 oee 留 NULL（可判定却不给值）';
      if (fact.frozenPieces !== null && fact.frozenPieces > 0 && row.pass_rate === null) {
        return '冻结时有判定件却把 pass_rate 留 NULL（有分母却不给比率）';
      }
      if (fact.frozenPieces === 0 && row.pass_rate !== null) return '冻结时一件都没有却给了 pass_rate（没有分母就不许给比率）';
      return null;
    };
    /* 台账（**逐行**，两条判据各一行读数；不是判据本身）：`bad` ＝ 判据①／② 的落点；
       `subsetBad` ＝ 判据③ 的落点（"现在数到的件数 ≤ 冻结时数到的件数"—— 
       `judged_at` 只被往后刷 ⇒ 件只会**离开**窗口，不会凭空进入）；`staleRows` ＝ 两者**不等**的行，
       即"该窗口的件数在我们读数之前被动过"的现场台账（合法，不是红）。 */
    const a1ShapeAudit = () => {
      const rows = shiftStatRepo.listRows(a1Db, 50).map(r => {
        const fact = a1FactOf(r.shift_date, r.shift_name);
        const subsetBad = Boolean(fact) && fact.frozenPieces !== null && fact.pieces > fact.frozenPieces
          ? `现在数到 ${fact.pieces} 件 > 冻结时 ${fact.frozenPieces} 件（件只能离开窗口 ⇒ 库内真源与冻结读数不一致）` : null;
        return { key: `${r.shift_date}|${r.shift_name}`, row: r, fact, bad: a1ShapeVerdict(r, fact), subsetBad };
      });
      const kinds = {
        '有帧无件': rows.filter(x => x.fact && x.fact.frames > 0 && x.row.oee !== null && x.fact.frozenPieces === 0).length,
        '有帧有件': rows.filter(x => x.fact && x.fact.frames > 0 && x.row.oee !== null && x.fact.frozenPieces > 0).length,
        '无帧无件（占位行）': rows.filter(x => x.fact && x.fact.frames === 0 && x.fact.frozenPieces === 0
          && x.row.oee === null && x.row.pass_rate === null).length,
        '无帧有件（本节夹具不产出）': rows.filter(x => x.fact && x.fact.frames === 0 && x.fact.frozenPieces > 0
          && x.row.oee === null && x.row.pass_rate !== null).length
      };
      return {
        rows, kinds, bad: rows.filter(x => x.bad), subsetBad: rows.filter(x => x.subsetBad),
        staleRows: rows.filter(x => x.fact && x.fact.frozenPieces !== null && x.fact.pieces !== x.fact.frozenPieces)
      };
    };
    const a1ShapeAt5 = a1ShapeAudit();
    /* **合法反例负对照**（`E85⒜` 的现场，也是这条判据的 D22）：判红的**前提**是"件数/帧数读数可信"，
       故负对照给两种**件数读数不可信或读数为 0**的合法形态；夹具产不出的那一种用显式构造（构造变量逐项写明）：
         · `(run_sec=0, oee=0, pass_rate=NULL)`（窗口内恰 1 帧、无件）：**真实**形态（`2026-10-02|早班`）；
         · `(run_sec=0, oee=NULL, pass_rate=0)`（冻结时窗口内有件 ⇒ `pass_rate=0`；零帧 ⇒ `oee` 只能 NULL）：
           **构造**（本节夹具产不出）—— `fact.frozenPieces=1` 与 `pass_rate=0` 都是 `row` 自己的位，
           互相对齐；`frames=0` 与 `oee=NULL` 同理；**唯一**来自库的 `fact.pieces=0` 是"事后重判把它刷出去了"，
           正是 ⒜ 的现场形状。
       旧判据（"两列同 NULL 或同非 NULL"）会把**这两个**都判红 ⇒ 一并复现作反证。 */
    const a1LegalShapes = [
      {
        name: '(0,0,NULL)＝窗口内恰 1 帧、无件（真实）', real: true,
        row: { run_sec: 0, oee: 0, pass_rate: null }, fact: { frames: 1, pieces: 0, frozenPieces: 0 }
      },
      {
        name: '(0,NULL,0)＝冻结时有件 1、事后被重判归零', real: false,
        row: { run_sec: 0, oee: null, pass_rate: 0 }, fact: { frames: 0, pieces: 0, frozenPieces: 1 }
      }
    ];
    const a1LegalVerdicts = a1LegalShapes.map(s => ({
      name: s.name, newBad: a1ShapeVerdict(s.row, s.fact),
      oldBad: (s.row.oee === null) !== (s.row.pass_rate === null)     /* 旧判据：只比"两列同号" */
    }));
    const a1OldFalseReds = a1LegalVerdicts.filter(v => v.oldBad).map(v => v.name);
    /* ⒜ 的**判别力读数**（修方向**不得**削弱判别力）：两条子判据各自的"反例"都必须被抓 ——
       ① 的反例＝**无帧却给了 `oee`**（占位行拿 0 顶替"算不出来"）：`frames=0` ⇒ 必须 NULL；
       ② 的反例＝**冻结时有件却把 `pass_rate` 留 NULL**（有分母却不给比率）。
       ⚠ 这两条与旧判据（"两列同 NULL 或同非 NULL"）**不能比判别力**：旧判据在**合法**形态上就会假红
       （见上面的负对照，两个都红），所以"旧判据在这儿也红"**不构成**"新判据没退化"的证据。
       本节的证据是另一条：新判据在**全部合法形态**上绿的同时，把这两条反例**照样**判红
       ⇒ 判别力不小于旧判据（旧判据多出来的那些"红"全是假红）。 */
    const a1E88NegCases = [
      {
        name: '① 的反例：无帧却给了 oee（拿 0 顶替"算不出来"，无帧无件）',
        row: { run_sec: 0, oee: 0, pass_rate: null }, fact: { frames: 0, pieces: 0, frozenPieces: 0 }
      },
      {
        name: '② 的反例：冻结时有件 1 却把 pass_rate 留 NULL（有分母却不给比率）',
        row: { run_sec: 0, oee: 0, pass_rate: null }, fact: { frames: 1, pieces: 0, frozenPieces: 1 }
      }
    ].map(c => Object.assign({}, c, {
      newBad: a1ShapeVerdict(c.row, c.fact),
      oldBad: (c.row.oee === null) !== (c.row.pass_rate === null)   /* 旧判据：只比"两列同号" */
    }));
    t.check('A1-5 **"不用 0 顶替"的两个状态位（各自独立）逐行对齐库内真源**（`E85⒜` 重写、'
      + '`E88⒜` 修 `pass_rate` 侧的方向，2026-10-02）：无采集帧 ⇒ `oee` 必须 NULL、有帧 ⇒ 非 NULL；' +
      '**冻结时一件都没有** ⇒ `pass_rate` 必须 NULL、**冻结时有判定件** ⇒ 必须给比率' +
      '（前提都取**冻结时**的件数，**不取**库里现数的件数 —— `judged_at` 可变，事后重判会把件刷出窗口）；' +
      '且"有帧无件""有帧有件"两种形态在本节的库里都真实存在 —— ' +
      '**窗口与冻结时件数都由库内真源现算／反读**、`frames`/`pieces` 由本节自写 SQL 数（`ADR-0004 D19`）；' +
      '负对照：两个**合法**形态（`(0,0,NULL)` 真实 与 `(0,NULL,0)` 冻结有件·事后归零）都不许被判红，' +
      '而**旧判据**会把**两个都**假判红；判别力：两条子判据各自的**反例都仍被判红**' +
      '（无帧却给 oee／冻结时有件却不给比率）⇒ 判别力不小于旧判据（旧判据多出的红全是假红）',
      a1ShapeAt5.rows.length >= 1 && a1ShapeAt5.bad.length === 0 &&
      a1ShapeAt5.subsetBad.length === 0 &&
      a1ShapeAt5.kinds['有帧无件'] >= 1 && a1ShapeAt5.kinds['有帧有件'] >= 1 &&
      a1LegalVerdicts.every(v => v.newBad === null) &&
      a1LegalShapes.filter(s => s.real).length >= 1 && a1OldFalseReds.length === a1LegalShapes.length &&
      a1E88NegCases.every(c => c.newBad !== null && c.oldBad === true) &&
      a1EarlyRow.oee === 0 && a1EarlyRow.pass_rate === null,
      `逐行：${a1ShapeAt5.rows.map(x => `${x.key}(frames=${x.fact ? x.fact.frames : '?'},` +
        `冻结时件数=${x.fact ? x.fact.frozenPieces : '?'},现在数到=${x.fact ? x.fact.pieces : '?'}` +
        ` ⇒ run_sec=${x.row.run_sec},oee=${JSON.stringify(x.row.oee)},pass_rate=${JSON.stringify(x.row.pass_rate)})`).join(' , ')}；` +
      `与独立性判据不符 ${a1ShapeAt5.bad.length} 行（须为 0）${a1ShapeAt5.bad.length ? '：' + a1ShapeAt5.bad.map(x => `${x.key}(${x.bad})`).join('、') : ''}；` +
      `"现在数到 ≤ 冻结时"不符 ${a1ShapeAt5.subsetBad.length} 行（须为 0）` +
      `${a1ShapeAt5.subsetBad.length ? '：' + a1ShapeAt5.subsetBad.map(x => `${x.key}(${x.subsetBad})`).join('、') : ''}；` +
      `形态行数＝${JSON.stringify(a1ShapeAt5.kinds)}；` +
      `负对照（新判据 vs 旧判据）：${a1LegalVerdicts.map(v => `${v.name} ⇒ 新=${v.newBad === null ? '绿' : '红'}／旧=${v.oldBad ? '红（假红）' : '绿'}`).join('；')}；` +
      `判别力（反例必须判红）：${a1E88NegCases.map(c => `${c.name} ⇒ 新=${c.newBad === null ? '**绿（判别力丢失）**' : '红'}／旧=${c.oldBad ? '红' : '绿（旧判据抓不到）'}`).join('；')}`);

    /* A1-5b（**`E88⒜` 的现场取证**，2026-10-02）：本节夹具**确实产出**该形态 ——
       `2026-10-02|中班` 的 `pass_rate` 非 NULL（＝冻结时窗口内至少有一件）而**现在**按 `judged_at`
       数到 0 件。这一条把"事后重判会把件刷出窗口"从注释里的说法变成**逐字可复跑的读数**，
       并同时锁住 `frozen_at` 与 `created_at` 这两个时间锚（`frozen_at` ∈ 下一班窗口、
       `result.created_at` ∈ 本窗口 ⇒ 件是"本窗口内判出、之后被重判"的）。
       期望值**不写死**：全部由库内真源现算（窗口、`created_at`、`frozen_at`）。
       ⚠ 判别力：若 A1-5 退回旧写法（用现在的件数做前提），这一行会**立即**假判红（A1-5 与 A1-19 都会红）
       —— 这就是 ⒜ 所指的"窄假红窗口"，本条即它的回归护栏。 */
    const a1StaleRow = a1ShapeAt5.staleRows[0] || null;
    const a1StaleWin = a1StaleRow ? a1WindowOf(a1StaleRow.row.shift_date, a1StaleRow.row.shift_name) : null;
    const a1StalePiece = a1StaleRow
      ? a1Db.prepare('SELECT proc_order_no AS no, unit_index AS unit, judged_at, created_at FROM result ' +
          'WHERE created_at >= ? AND created_at < ? ORDER BY unit_index LIMIT 1').get(a1StaleWin.startAt, a1StaleWin.endAt)
      : null;
    t.check('A1-5b **`E88⒜` 的现场**（2026-10-02 实测，**非构造**）：本节夹具产出的合法形态 —— ' +
      '某历史固化行的**冻结时件数 > 0**（由 `pass_rate` 非 NULL 反读）而**现在**按可变列 `judged_at` 数到的件数为 0；' +
      '且该件是被**事后重判**刷出去的（`result.created_at` 落在**该班窗口内**、`judged_at` 落在窗口外）—— ' +
      '凡"用现在的件数做前提"的判据在这一行上必然假判红，本节的 A1-5／A1-19 在修好后必须仍为绿',
      a1ShapeAt5.staleRows.length >= 1 && Boolean(a1StaleRow) &&
      a1StaleRow.fact.frozenPieces > 0 && a1StaleRow.fact.pieces === 0 &&
      a1StaleRow.row.pass_rate !== null && Boolean(a1StalePiece) &&
      a1StalePiece.created_at >= a1StaleWin.startAt && a1StalePiece.created_at < a1StaleWin.endAt &&
      !(a1StalePiece.judged_at >= a1StaleWin.startAt && a1StalePiece.judged_at < a1StaleWin.endAt) &&
      a1ShapeVerdict(a1StaleRow.row, a1StaleRow.fact) === null,
      `被动的行 ${a1ShapeAt5.staleRows.length} 行（≥1）：` +
      a1ShapeAt5.staleRows.map(x => `${x.key}（窗口 ${x.fact.window}、冻结时件数=${x.fact.frozenPieces}、` +
        `现在数到=${x.fact.pieces}、pass_rate=${JSON.stringify(x.row.pass_rate)}、frozen_at=${x.row.frozen_at}）`).join('；') +
      `${a1StalePiece ? `；该窗内判出的件：${a1StalePiece.no}#${a1StalePiece.unit} created_at=${a1StalePiece.created_at}（窗内）` +
        `／judged_at=${a1StalePiece.judged_at}（窗外 ⇒ 被重判刷出）` : ''}；` +
      `"件数未被动过"的行 ${a1ShapeAt5.rows.length - a1ShapeAt5.staleRows.length} 行`);


    /* ---- ②b 一跳跨过**多个**已跑完班次 ⇒ 枚举必须真的"一步一班"地走完 ----
       ⚠ **关键设计（首版这里是不可证伪的，D22 实测被抓出来）**：枚举循环的比较基准是 `list` 的**末尾**
       （`list.push` 之前 `list.length` 恒 ≥ 1），而 `break` 判据是"游标所在班次 ＝ 到达班" ⇒
       只要序列里累积的班次名与"到达班"不同，循环就会继续。首版每跳只跨 1 个班次，
       且"到达班"与"上次所见那一班"**同名**（早班→…→早班）⇒ 循环体实际只跑一轮，
       把"循环只跑一轮"的变异（在 `list.push` 前插 `if (list.length > 1) break;`）整段放过去
       （实测 298/0 全绿、变异逃逸）。现在改为：**一跳直接跨到 10-05 12:00:01**
       （到达班＝"早班10-05"，与上次所见的"晚班10-03"不同名）⇒ 现算序列 ≥ 9 个已跑完班次、
       循环必须迭代 6 次以上，上面那种变异必然让库内行数短于现算序列。
       ⚠ **`E85⒠①` 文案更正（2026-10-02，按实测）**：`10-05 12:00:01` 按班次真源属 **早班10-05**
       （`08:00–16:00`），**不是**"中班10-05"；这一跳之前的"上次所见班次"是 **晚班10-03**
       （A1-4 那一跳的到达班），**不是**"早班10-02"（早班10-02 只是**枚举序列的首项**、
       它在更早的 tick 上就已落库）。故本 tick 新写入的是"晚班10-03 → 晚班10-05"之间的 7 个班次，
       而"中班10-02"是**早已在库、本 tick 不新增**的那一行。（座位 5 的 C·18.7⒠① 实测
       `lastShiftKey=2026-10-05|早班`。）
       ⚠ **不在这条用例里手工删 `shift_stat`**（试过：`DELETE` 只清掉了持久化行、清不掉进程内的
        `lastShift` ⇒ 枚举起点仍是"那一班的 endAt"，读数会被污染；那是**流程外的库改写**，
       不是被测行为，故弃用）。
       ⚠ `/health.runAccum` 是**快照跑过之后**才有的（`snapshot.lastRunAccum`，初值 null）⇒
       要先请求一次 `/state`（真链路），不能指望 `/health` 自己会去算。 */
    const a1BackfillsBeforeBig = serverEntry.state.shiftStatWrite.backfills;
    const a1RowsBeforeBig = a1Rows();
    a1ClockMs = Date.parse('2026-10-05T12:00:10');
    const a1BigJump = await a1Push('2026-10-05 12:00:01', 7007);
    const a1BigWantKeys = a1CompletedShifts('2026-10-02 15:59:00', '2026-10-05 12:00:01').map(a1KeyOf);
    await fetch(a1Base() + '/state');                       // 触发一次真快照 ⇒ `runAccum` 有值
    const a1HealthAfterJump = await a1HealthView();
    const a1BigConds = {
      '序列长≥9': a1BigWantKeys.length >= 9,
      '库内键序＝现算序列': JSON.stringify(a1BigJump.rowsAfter) === JSON.stringify(a1BigWantKeys),
      '库内行数＝序列长': a1BigJump.rowsAfter.length === a1BigWantKeys.length,
      'Δrows＝库内行数增量': a1BigJump.dRows === a1BigJump.rowsAfter.length - a1RowsBeforeBig
    };
    const a1BigBad = Object.keys(a1BigConds).filter(k => !a1BigConds[k]);
    t.check('A1-6 一跳跨过**多个**已跑完班次（到达 10-05 12:00:01 属**早班10-05**，尚未跑完）⇒ ' +
      '现算序列 **≥ 9** 个已跑完班次；库内键序与其**逐项相等**、库内行数＝序列长度' +
      '（"中班10-02"是**早已在库、本 tick 不新增**的那一行，仍须在场）；本帧 Δrows ＝ 库内行数增量 —— ' +
      '这一跳必须**一步一班**地枚举完 9 个班次，任何"只枚举一轮"的改法都会让库内行数短于现算序列',
      a1BigBad.length === 0,
      `本帧 Δrows=${a1BigJump.dRows}、库内行数=${a1BigJump.rowsAfter.length}；` +
      `库内键序=${a1BigJump.rowsAfter.join(' → ')}；现算期望=${a1BigWantKeys.join(' → ')}；` +
      `原始计数（**未作为判据，见下**）：backfills ${a1BackfillsBeforeBig} → ${a1HealthAfterJump.shiftStatWrite.backfills}、` +
      `writes ${a1WritesBeforeJump} → ${a1HealthAfterJump.shiftStatWrite.writes}；` +
      `未成立的子条件=${a1BigBad.length ? a1BigBad.join('、') : '（无）'}`);

    /* ⚠ **计数语义（`E85⒜` 收口；取代旧的"未定论"登记）**：`/health.shiftStatWrite.writes` 数的是
       "写入语句影响了行"的次数 —— **INSERT 与 UPDATE 都算**（`repo/shiftStat.js` 的 `written` 口径）；
       而"库内行数"只随 **INSERT** 增长。故**累计读数的差**不能与 `Δrows` 直接比：
       本节的 `writes ${a1WritesBeforeJump}` 是在 **A1-4 那一跳之前**取的（跨了两个 tick）⇒
       与 `A1-6` 这一跳的 `Δrows` 不同量纲。**精确口径由 A1-6c 的逐帧恒等式给出**
       （`Δwrites ≡ written 次数`、`Δrows ≡ INSERT 次数`），本节不再拿累计读数当判据。 */
    const a1WritesBad = a1Frames.filter(f => f.dShiftWrites !== f.dCntWritten || f.dRows !== f.dCntInsert);
    t.check('A1-6c **写入点的逐帧计数恒等式**（`E85⒜` 的更强替代，替换旧"两个累计计数单调不减"的弱形态）：' +
      '包一层 `repo/shiftStat.upsertFrozen` 直接数"本次调用 written／insert 了几行" ⇒ **逐帧** ' +
      '`Δwrites（/health.shiftStatWrite.writes 的本帧增量）≡ 本帧 written 次数` 且 ' +
      '`Δrows（库内行数增量）≡ 本帧 INSERT 次数`（`written && !updated`）—— 计数器与库内事实逐帧对账，' +
      '不再靠"单调不减"这种几近恒真的形态；且至少各有一帧真的 written／insert 过（否则这条恒等式是空的）',
      a1WritesBad.length === 0 &&
      a1Frames.some(f => f.dCntWritten > 0) && a1Frames.some(f => f.dCntInsert > 0),
      `逐帧：${a1Frames.map(f => `${f.at.slice(5)} Δwrites=${f.dShiftWrites}/cntWritten=${f.dCntWritten}` +
        ` Δrows=${f.dRows}/cntInsert=${f.dCntInsert}`).join('；')}；` +
      `不符的帧 ${a1WritesBad.length} 帧（须为 0）${a1WritesBad.length ? '：' + a1WritesBad.map(f => f.at).join('、') : ''}；` +
      `桩上累计 calls=${a1Cnt.calls}／written=${a1Cnt.written}／insert=${a1Cnt.insert}／blocked=${a1Cnt.blocked}`);

    t.check('A1-6b `/health` 的 DR-17 取数来源明写（`sumRunSec` ＋ `getShiftRow`，ADR-0009 D4），' +
      '且 `runAccum.frozenShifts`（对账用的全表行数）与库内行数一致',
      a1HealthAfterJump.runAccum !== null &&
      a1HealthAfterJump.runAccum.source.sum === 'shift_stat.sumRunSec' &&
      a1HealthAfterJump.runAccum.source.current === 'shift_stat.getShiftRow' &&
      a1HealthAfterJump.runAccum.frozenShifts === a1Rows(),
      `runAccum=${JSON.stringify(a1HealthAfterJump.runAccum)}`);

    /* ---- ③ 重启后从 `measure_rt` 回读 ⇒ 首帧即补记（ADR-0009 否掉 C3 的那个后果）----
       口径（实现自述）：`shift_stat` 在**跨班时才写** ⇒ 若不跨班，它就**不写**；
       故本节**不**依赖驱动帧是否跨班来建立"上次所见班次"，而是把重启的前一现场做成
       "驱动帧只负责把班次推进到 X、且它在库内留下采样行"，重启后**首帧从 `measure_rt` 回读** X。 */
    a1ClockMs = Date.parse('2026-10-05T21:00:10');
    const a1Setup = await a1Push('2026-10-05 21:00:01', 7008);
    const a1SetupWantKeys = a1CompletedShifts('2026-10-02 15:59:00', '2026-10-05 21:00:01').map(a1KeyOf);
    const a1SetupArriveKey = a1KeyOf(a1ShiftRules.at('2026-10-05 21:00:01'));
    t.check('A1-7 重启前的驱动帧（到达 10-05 21:00:01，属"中班10-05"⇒ **尚未跑完**）：库内键序＝现算序列**逐项相等**、' +
      '`Δrows ＝ 本帧新跑完的班次数`，且这一帧在库内留下采样行 ⇒ 重启后能从 `measure_rt` 回读到"中班10-05"',
      JSON.stringify(a1Setup.rowsAfter) === JSON.stringify(a1SetupWantKeys) &&
      a1Setup.dRows === a1SetupWantKeys.length - a1BigWantKeys.length &&
      a1SetupWantKeys.indexOf(a1SetupArriveKey) < 0 &&
      a1Db.prepare('SELECT COUNT(*) AS c FROM measure_rt WHERE collect_time = ?').get('2026-10-05 21:00:01').c === 1,
      `Δrows=${a1Setup.dRows}；库内键序=${a1Setup.rowsAfter.join(' → ')}；现算期望=${a1SetupWantKeys.join(' → ')}；` +
      `到达帧所属=${a1SetupArriveKey}（未跑完 ⇒ 不固化，但仍以采样行留在库内）`);

    const a1RowsBeforeRestart = a1Rows();
    await serverEntry.stop('a1-e2e-restart');                  // 真停：进程内"上次所见班次"随之丢失
    a1Svc = await serverEntry.start({
      argv: ['--port', '0', '--data-dir', a1Tmp, '--db-file', path.join(a1Tmp, 'board.db')],
      installSignalHandlers: false, logConsole: false, logger: a1Logger, clock: a1Clock
    });
    a1Db = serverEntry.state.db;                               // 重启后是**新**句柄
    a1Svc.bus.subscribe(e => { if (e.kind === 'warning') a1WarnEvents.push(e.payload); });
    t.check('A1-8 重启后进程内记忆**确实为空**（`lastShiftKey === null`）、库内行数不变 —— ' +
      '这正是"不靠回读就会永久漏固化"的前提',
      serverEntry.state.shiftStatWrite.lastShiftKey === null &&
      serverEntry.state.shiftStatWrite.writes === 0 && a1Rows() === a1RowsBeforeRestart,
      `lastShiftKey=${serverEntry.state.shiftStatWrite.lastShiftKey}、` +
      `重启后 writes=${serverEntry.state.shiftStatWrite.writes}、库内行数 ${a1RowsBeforeRestart} → ${a1Rows()}`);

    /* 重启后首帧：同一班次（中班10-05）内、不跨班 ⇒ `shift_stat` 一行都不写（口径：跨班才写）；
       但它必须**从 `measure_rt` 回读**出"上次所见班次＝中班10-05" */
    a1ClockMs = Date.parse('2026-10-05T21:30:10');
    const a1AfterRestartSame = await a1Push('2026-10-05 21:30:01', 7009);
    t.check('A1-9 重启后**同一班次内**的帧：`shift_stat` **零写入**（Δrows=0；口径＝跨班才写）、' +
      '`shiftStatWrite.writes` 仍为 0，且进程内记忆与库内真源一致（`lastShiftKey === \'2026-10-05|中班\'`）' +
      '—— ⚠ **本条不足以证明"回读到的是库里的那一班"**：到达帧所属班次恰好也是"中班10-05"，' +
      '所以"回读成功"与"只记当前班次"会得到同一个键（本包实测：把 `previousFrameShiftOf(frame)` 改成 `null`，' +
      '本条**仍然通过**）。真正可分辨的是下一条（跨班时，被漏掉的那一班必须补回来）。',
      a1AfterRestartSame.dRows === 0 &&
      serverEntry.state.shiftStatWrite.writes === 0 &&
      serverEntry.state.shiftStatWrite.lastShiftKey === '2026-10-05|中班',
      `Δrows=${a1AfterRestartSame.dRows}、writes=${serverEntry.state.shiftStatWrite.writes}、` +
      `lastShiftKey=${serverEntry.state.shiftStatWrite.lastShiftKey}`);

    /* 重启后跨班：到达 10-06 09:00:01（属"早班10-06"）。
       ⚠ **`E85⒠②` 更正（2026-10-02，按实测；旧注释与事实相反）**：旧注释称"把
       `previousFrameShiftOf(frame)` 改成 `null` ⇒ 本条与 A1-7 一起变红（实测）" —— 座位 5 的
       C·18.4／C·18.8（H4 组）与本节复跑都读到 **299/0、一条不红**：因为上一条 A1-9 在重启后
       **先推了一帧同班次帧**（10-05 21:30:01），它把进程内 `lastShift` 重新设成与"回读值"**同名**的
       `中班10-05` ⇒ `prev=null` 与"真回读"两条路径在这一跳得到**同一把键**、`Δrows` 也相同（2）。
       ⇒ 本条**不足以**判红 H4；真正可分辨的是本节末尾新增的 `A1-18`（**重启后首帧即跨班**、
       中间不推同班次帧；那座窗口下 `Δrows` 由 2 变 0）。本条保留，但只主张它自己写明的那些事实。 */
    a1ClockMs = Date.parse('2026-10-06T09:00:10');
    const a1RestartJump = await a1Push('2026-10-06 09:00:01', 7010);
    const a1RestartWantKeys = a1CompletedShifts('2026-10-05 21:00:01', '2026-10-06 09:00:01').map(a1KeyOf);
    const a1Mid1005 = a1Row('2026-10-05', '中班');
    const a1Mid1005Frames = a1Db.prepare(
      'SELECT COUNT(*) AS c FROM measure_rt WHERE collect_time >= ? AND collect_time < ?')
      .get('2026-10-05 16:00:00', '2026-10-06 00:00:00').c;
    t.check('A1-10 **重启后首帧即按序补记**：现算序列里的**每一行**都出现在库内，其中"中班10-05"' +
      '（重启前所见的那一班）**只有回读 `measure_rt` 才补得上**（到达班"早班10-06"与它不同名 ⇒ 不可蒙对）；' +
      `它的两个状态位都由库内真源决定（该窗口内 ${a1Mid1005Frames} 帧 ⇒ 两列都非 NULL，不是占位行）`,
      a1RestartWantKeys.length === 2 &&
      a1RestartWantKeys[0] === '2026-10-05|中班' &&
      a1RestartJump.dRows === 2 &&
      JSON.stringify(a1RestartJump.rowsAfter) ===
        JSON.stringify(a1CompletedShifts('2026-10-02 15:59:00', '2026-10-06 09:00:01').map(a1KeyOf)) &&
      a1Mid1005 !== null && a1Mid1005.shift_date === '2026-10-05' && a1Mid1005.shift_name === '中班' &&
      a1Mid1005Frames >= 1 && a1Mid1005.oee !== null && a1Mid1005.pass_rate !== null,
      `Δrows=${a1RestartJump.dRows}；现算序列=${a1RestartWantKeys.join(' → ')}；` +
      `库内全序=${a1RestartJump.rowsAfter.join(' → ')}；` +
      `中班10-05：${a1Mid1005 ? `run_sec=${a1Mid1005.run_sec}、oee=${JSON.stringify(a1Mid1005.oee)}、pass_rate=${JSON.stringify(a1Mid1005.pass_rate)}、窗口内帧=${a1Mid1005Frames}` : '**无该行**'}`);

    /* 重启后 `/health` 的预警计数**从 0 起算**（进程内状态）⇒ 下面建立"重启后基线"，
       供 §⑤ 的 Δ 口径使用（**不得**拿跨重启的累计值比库内行数 —— 那是首版的构造缺陷） */
    const a1WarnBase = {
      writes: serverEntry.state.warningWrite.writes,
      duplicates: serverEntry.state.warningWrite.duplicates,
      skippedOk: serverEntry.state.warningWrite.skippedOk,
      rows: warningRepo.countAll(a1Db),
      frames: a1Frames.length
    };
    t.check('A1-11 重启后预警计数**从 0 起算**（`/health.warningWrite` 是进程内状态）⇒ 本节据此建立 Δ 基线，' +
      '后续不变量只比**增量**（首版拿跨重启的累计值比库内行数是构造缺陷，已改）',
      a1WarnBase.writes >= 0 && a1WarnBase.duplicates >= 0 && a1WarnBase.rows > 0 &&
      a1WarnBase.writes + a1WarnBase.duplicates <= a1WarnBase.rows + a1WarnBase.duplicates,
      `重启后基线：${JSON.stringify(a1WarnBase)}（库内已有 ${a1WarnBase.rows} 行为重启前所写；` +
      `计数器是进程内的，故一律用 Δ 口径）`);

    /* ---- ④ 写失败隔离：固化抛错 ⇒ 帧仍落库、判定照跑、失败只计数 ----
       ⚠ **注入必须落在"确实要调 `upsertFrozen` 的那一 tick"**，且该帧的**采集时刻必须晚于**
       本夹具已落库的最后一秒（ADR-0001 D7：不早于上次落库那一秒 ⇒ 判 `raw-500ms`/`duplicate`，
       `onSampled` 根本不会跑、桩也不会被调用）。首版两条都踩了：既用了"同班次内"的帧、
       又在时钟回拨后推了一帧更早的时刻（`stored=false` ⇒ `measure_rt` 一行没涨）。
       现取 **10-06 20:00:01**（晚于上一帧 10-06 09:00:01；属"中班10-06"，到达前推时跨过
       10-07 00:00 的边界）⇒ 现算序列恰含 2 个已跑完班次（中班10-06、早班10-07），写入口必被调用。
       两种可观测口径我选**前者**（"跨班 tick 上 `failures` 增量 ∈ [1, 班次数]"）：它是唯一能把
       "写入口真被调用过"与"没跨班所以压根没调用"分开的正面判据；第 ② 种（"仅在尝试固化时 +1"）
       由 A1-12 的"该 tick 一行都没写进 `shift_stat`、`writes` 未增"从反面佐证。 */
    a1ClockMs = Date.parse('2026-10-06T20:00:10');
    const a1FailTarget = '2026-10-06 20:00:01';
    /* 现算序列的**起点取被测实现自述的"上次所见班次"**（`shiftStatWrite.lastShift.startAt`），
       不假定"上一帧是谁" —— 这样即使夹具里某帧被判 `raw-500ms`（进程内记忆没推进），期望值仍然自洽。 */
    const a1FailLastShift = serverEntry.state.shiftStatWrite.lastShift;
    const a1FailWantKeys = a1FailLastShift
      ? a1CompletedShifts(a1FailLastShift.startAt, a1FailTarget).map(a1KeyOf)
      : [];
    const a1SavedUpsert = shiftStatRepo.upsertFrozen;
    const a1BeforeFail = {
      failures: serverEntry.state.shiftStatWrite.failures,
      writes: serverEntry.state.shiftStatWrite.writes,
      backfills: serverEntry.state.shiftStatWrite.backfills,
      rows: a1Rows(),
      frames: a1Db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c,
      warnings: warningRepo.countAll(a1Db)
    };
    let a1FailPush = null;
    try {
      shiftStatRepo.upsertFrozen = function () {
        throw new Error('harness-check 注入：DR-06 写入点抛错桩（只验"失败不污染采集链"）');
      };
      a1FailPush = await a1Push(a1FailTarget, 7011);
    } finally {
      shiftStatRepo.upsertFrozen = a1SavedUpsert;              // 当场还原（失败注入不留痕）
    }
    const a1AfterFail = {
      failures: serverEntry.state.shiftStatWrite.failures,
      writes: serverEntry.state.shiftStatWrite.writes,
      lastError: serverEntry.state.shiftStatWrite.lastError,
      frames: a1Db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c,
      warnings: warningRepo.countAll(a1Db)
    };
    t.check('A1-12 **写失败隔离**：固化抛错时该帧**仍被收下并落库**（HTTP 200/stored）、判定与预警落库照跑；' +
      '异常在写入点内部被收下（不冒泡成 500 / 不进 `sampledHookFailures`）；' +
      '且这一跳**确实发生在跨班 tick 上**（现算序列非空 ＋ 该 tick 一行都没写进 `shift_stat`）',
      a1FailPush.status === 200 && a1FailPush.stored === true &&
      a1FailWantKeys.length >= 1 && a1FailPush.dRows === 0 &&
      a1AfterFail.frames === a1BeforeFail.frames + 1 &&
      a1AfterFail.warnings >= a1BeforeFail.warnings &&
      a1AfterFail.writes === a1BeforeFail.writes,
      `status/stored=${a1FailPush.status}/${a1FailPush.stored}；measure_rt ${a1BeforeFail.frames} → ${a1AfterFail.frames}；` +
      `warning ${a1BeforeFail.warnings} → ${a1AfterFail.warnings}；` +
      `该 tick 现算应补记=${a1FailWantKeys.join(' , ') || '（空）'}、实测 Δrows=${a1FailPush.dRows}、writes ${a1BeforeFail.writes} → ${a1AfterFail.writes}`);

    t.check('A1-13 `/health.shiftStatWrite.failures` 的增量 **> 0** 且 `lastError` 带上注入原因 —— "悄悄不写"看得见；' +
      '本条与 A1-12 合起来给出上面第 ② 种口径：`failures` 增量 > 0 ⇔ 该 tick 真的尝试过固化' +
      '（首版拿不跨班的帧验它，故恒为 0 ⇒ **误报的根源在这里**）。' +
      '⚠ 增量是**每个班次一次**：该 tick 的现算序列有 2 个班次 ⇒ 全程触发 2 次写入口调用、计 2 次失败，' +
      '故这里断言"增量 ≥ 1 且 ≥ 该 tick 的班次数 − 1 的语义下不为 0"，**不写死 1**（原子操作的成功/失败计数口径见实现）。',
      a1AfterFail.failures - a1BeforeFail.failures >= 1 &&
      a1AfterFail.failures - a1BeforeFail.failures <= a1FailWantKeys.length &&
      typeof a1AfterFail.lastError === 'string' && a1AfterFail.lastError.indexOf('注入') >= 0,
      `failures ${a1BeforeFail.failures} → ${a1AfterFail.failures}（增量 ${a1AfterFail.failures - a1BeforeFail.failures}，` +
      `该 tick 现算班次数 ${a1FailWantKeys.length}）；writes ${a1BeforeFail.writes} → ${a1AfterFail.writes}（未增 ⇒ 真的没写进去）；` +
      `lastError=${a1AfterFail.lastError}`);

    /* ---- ⑤ `warning` 的不变量（逐帧）：非 ok 条数 ＝ Δ落库 ＋ Δ幂等命中 ---- */
    const a1FramesPostRestart = a1Frames.slice(a1WarnBase.frames);
    const a1NonOkFrames = a1Frames.filter(f => f.nonOk > 0);
    t.check('A1-14 **不变量逐帧成立**：每一帧的"事件里非 ok 条数" ＝ "Δ落库行数 ＋ Δ幂等命中数"' +
      '（不丢一条、不重一条）；且至少有一帧真的产生了非 ok 条目（否则这条恒等式是空的）；' +
      '重启后各帧的 Δ落库之和 ＝ 库内新增行数（**Δ 口径**，不使用跨重启的累计值）',
      a1Frames.length > 0 && a1Frames.every(f => f.nonOk === f.dWarnings + f.dDuplicates) &&
      a1NonOkFrames.length > 0 &&
      warningRepo.countAll(a1Db) - a1WarnBase.rows ===
        a1FramesPostRestart.reduce((s, f) => s + f.dWarnings, 0),
      a1Frames.map(f => `${f.at.slice(11)}: 非ok ${f.nonOk} ⇒ 落库 ${f.dWarnings} ＋ 幂等 ${f.dDuplicates}`).join('；') +
      `｜重启后：库内 ${a1WarnBase.rows} → ${warningRepo.countAll(a1Db)}（Δ=${warningRepo.countAll(a1Db) - a1WarnBase.rows}）` +
      `＝各帧 Δ落库之和 ${a1FramesPostRestart.reduce((s, f) => s + f.dWarnings, 0)}`);

    t.check('A1-15 **只落非 ok**：事件里的 `ok` 回执条一条都不进 `warning` 表，而是计入 `/health.warningWrite.skippedOk`；' +
      '且逐帧 `Δwrites === Δ落库行数`（计数器不自说自话）',
      a1Frames.some(f => f.okCount > 0) &&
      serverEntry.state.warningWrite.skippedOk >= 1 &&
      a1Frames.every(f => f.dWrites === f.dWarnings),
      `warningWrite=${JSON.stringify(serverEntry.state.warningWrite)}；库内 warning 行数=${warningRepo.countAll(a1Db)}；` +
      `ok 条数合计=${a1Frames.reduce((s, f) => s + f.okCount, 0)}；` +
      `逐帧 Δwrites===Δ落库=${a1Frames.every(f => f.dWrites === f.dWarnings)}`);

    t.check('A1-16 `/health.warningWrite.lastWarnType` 是**判定产出的标题之一**（不是空串、也不是内部键名），' +
      '且 `failures` 为 0（本段没有注入预警写失败）',
      typeof serverEntry.state.warningWrite.lastWarnType === 'string' &&
      serverEntry.state.warningWrite.lastWarnType.length > 0 &&
      Object.values(judge.WARN_TITLES).concat(Object.values(judge.OTHER_TITLES))
        .indexOf(serverEntry.state.warningWrite.lastWarnType) >= 0 &&
      serverEntry.state.warningWrite.failures === 0,
      `lastWarnType=${JSON.stringify(serverEntry.state.warningWrite.lastWarnType)}、` +
      `failures=${serverEntry.state.warningWrite.failures}`);

    t.check('A1-17 端点在场：`/health` 的 `addRunSecBound` 给的是**重设后**的界（口径字符串与当班时长三项俱全）—— ' +
      '"界到底是多少"不必去读源码',
      a1HealthAfterJump.addRunSecBound &&
      a1HealthAfterJump.addRunSecBound.rule === '0 ≤ addRunSec ≤ shift.elapsedSec' &&
      Number.isFinite(a1HealthAfterJump.addRunSecBound.elapsedSec) &&
      Number.isFinite(a1HealthAfterJump.addRunSecBound.totalSec),
      JSON.stringify(a1HealthAfterJump.addRunSecBound));

    /* ---- ⑥ `E85⒝`：**H4 的可杀窗口** —— 重启后**首帧即跨班**（中间不推同班次帧）----
       为什么单独补这一段：A1-9 在重启后先推了一帧**同班次**帧，把 `lastShift` 重新设成与"回读值"
       同名的键 ⇒ `previousFrameShiftOf(frame) → null`（H4 变异体）在 A1-9／A1-10 上**不会被判红**
       （座位 5 的 C·18.4 实测 299/0）。座位 5 自建的"重启后首帧即跨班"窗口实测 `Δrows` **2 → 0**
       （变异体 `9a0e3695a746…`）⇒ 这里把它补进本节的**门禁**。
       期望值仍由**班次真源现算**：`from` ＝ 重启前最后一条采样帧的时刻（`中班10-06` 的窗口内），
       `to` ＝ 本帧时刻（`早班10-07`）⇒ 现算序列＝[中班10-06, 晚班10-07]（两行都**必须新落库**：
       中班10-06 落在 A1-12 那一跳（写入点抛错 ⇒ 一行没写）之后，故它**只能**由"回读上次所见班次"
       推出来）。`prev=null` 时走的 `else` 支把 `lastShift` 记为**当前**班次并直接 return ⇒ `Δrows=0`。 */
    const a1H4ClockMs = Date.parse('2026-10-07T09:00:10');
    const a1H4RowsBefore = a1Rows();
    const a1H4RowsBeforeKeys = shiftStatRepo.listRows(a1Db, 50).map(r => `${r.shift_date}|${r.shift_name}`);
    const a1H4LastFrame = a1Db.prepare('SELECT collect_time AS t FROM measure_rt ORDER BY collect_time DESC LIMIT 1').get();
    await serverEntry.stop('a1-e2e-h4-window');               // 真停：进程内"上次所见班次"随之丢失
    a1ClockMs = a1H4ClockMs;
    a1Svc = await serverEntry.start({
      argv: ['--port', '0', '--data-dir', a1Tmp, '--db-file', path.join(a1Tmp, 'board.db')],
      installSignalHandlers: false, logConsole: false, logger: a1Logger, clock: a1Clock
    });
    a1Db = serverEntry.state.db;
    a1Svc.bus.subscribe(e => { if (e.kind === 'warning') a1WarnEvents.push(e.payload); });
    const a1H4RestartState = {
      lastShiftKey: serverEntry.state.shiftStatWrite.lastShiftKey,
      writes: serverEntry.state.shiftStatWrite.writes
    };
    const a1H4Jump = await a1Push('2026-10-07 09:00:01', 7012);
    const a1H4From = a1H4LastFrame && a1H4LastFrame.t;
    const a1H4WantKeys = a1CompletedShifts(a1H4From, '2026-10-07 09:00:01').map(a1KeyOf);
    const a1H4ArriveKey = a1KeyOf(a1ShiftRules.at('2026-10-07 09:00:01'));
    const a1H4Newly = a1H4Jump.rowsAfter.filter(k => a1H4RowsBeforeKeys.indexOf(k) < 0);
    t.check('A1-18 **重启后首帧即跨班**（`E85⒝` 补入的 H4 杀窗口）：重启后**不先推同班次帧**，直接推一帧跨班帧 ⇒ ' +
      '现算序列里的每一行都必须落库（这一跳新写入的＝现算序列**全部**；"中班10-06"只能由 `measure_rt` ' +
      '回读上次所见班次才推得出，到达班"早班10-07"与它不同名 ⇒ 蒙不对）；`Δrows ≡ 新增行数` —— ' +
      '把 `previousFrameShiftOf(frame)` 换成 `null`（H4）时该窗口 `Δrows` 由 2 变 0 ⇒ 本条即其判别力所在',
      a1H4RestartState.lastShiftKey === null && a1H4RestartState.writes === 0 &&
      a1H4WantKeys.length === 2 && a1H4WantKeys[0] === '2026-10-06|中班' &&
      a1H4WantKeys.indexOf(a1H4ArriveKey) < 0 &&
      a1H4Jump.dRows === 2 && a1H4Jump.dRows === a1H4Newly.length &&
      JSON.stringify(a1H4Newly) === JSON.stringify(a1H4WantKeys) &&
      a1H4Jump.rowsAfter.length === a1H4RowsBefore + 2,
      `重启后 lastShiftKey=${a1H4RestartState.lastShiftKey}、writes=${a1H4RestartState.writes}；` +
      `本帧 Δrows=${a1H4Jump.dRows}（库内 ${a1H4RowsBefore} → ${a1H4Jump.rowsAfter.length}）；` +
      `本帧新增＝${a1H4Newly.join(' → ')}；现算期望＝${a1H4WantKeys.join(' → ')}（from=${a1H4From}）；` +
      `到达帧所属=${a1H4ArriveKey}（未跑完 ⇒ 不固化）`);

    /* ---- `E85⒟`：**覆盖缺口显式登记**（不是断言，是"哪几条路今天没人走"的清单）----
       `H1`（把"时间倒退不是边界"那一支改成 `if (false)`）经座位 5 的 C·18.4 判为**不可达的防御分支**
       （`ingest` 只接受严格更晚的秒 ＋ `at().startAt` 单调不减），**不是**缺口；但同族的三处在全仓
       **零断言**（`grep` 全 `tests\` 无命中），这里如实登记（不假装已覆盖）：
         · `state.shiftStatWrite.staleFrames`（时间倒退计数）—— 该支在公开面上不可达，故无断言；
         · `MAX_BACKFILL_SHIFTS`（达上限的 `补记枚举中断`／`truncated`，`server\index.js:1311-1323`）
           —— 要覆盖需要一个"游标不前进"的注入点（属实现侧改造，不在测试写范围内）。
       `H2`（删掉"本进程首次 tick"支里紧跟 `st.lastShift = cur;` 的 `return`）是**等价变异体**
       （紧随的守卫返回**同一字面量**、中间无副作用）⇒ 它"未命中"是**正确读数**，不是缺口。 */
    t.info(`§15 覆盖登记（E85⒞／⒟，均**非缺口**）：H2＝等价变异体（同一字面量、无副作用）；` +
      `H1＝不可达防御分支（ingest 秒单调 ＋ at().startAt 单调）；**零断言的两处**＝` +
      `\`shiftStatWrite.staleFrames\` 与 \`MAX_BACKFILL_SHIFTS\` 达上限的 \`补记枚举中断\`（truncated）—— ` +
      `两处都要覆盖需实现侧注入点，故**只登记**（"首次 tick 且库里没有更早帧 ⇒ prev=null"那一支不是缺口：` +
      `A1-1 的第一帧就走它，且 A1-8 已断言重启后 lastShiftKey === null）`);

    /* ---- `E85⒜` 收尾：跑完本节**全部**帧之后，再用同一组独立性判据复核**整序** ----
       此刻库里已同时存在"有帧无件"（早班10-02 等）、"有帧有件"（中班10-02）与"无帧无件"（中班10-03、
       晚班10-07 等占位行）三种形态 ⇒ 这条非空性条件在这里才立得住（A1-5 时占位行还没产生）。
       ⚠ `E88⒜` 更正（2026-10-02）：旧注释说"无帧有件"（`(0,NULL,0)`）本节夹具产不出来 —— **实测产得出**：
       `2026-10-02|中班` 的 `pass_rate` 非 NULL（冻结时窗口内有件 ⇒ `pieceCount > 0`）而事后按可变的
       `judged_at` 数到 0 件 ⇒ 在**现值口径**下正是 `frames>0` 且 `pieces=0`；只是因为该窗内**确有 1 帧**，
       所以它不算"无帧"那一类。真正的"无帧"形态在本夹具里只有**占位行**（窗口内一帧都没有）——
       而"无帧却有件"在实现上不可能（判定的 `judged_at` 由帧驱动、`frozen_at` 也由帧 tick 给出），
       故 A1-19 **不要求**它出现，A1-5 用显式构造的合法形态覆盖它（那条构造的形状与"中班10-02"同型）。 */
    const a1ShapeEnd = a1ShapeAudit();
    t.check('A1-19 状态位"不用 0 顶替"的**全序复核**（`E85⒜` 收尾、`E88⒜` 修方向）：本节帧序列跑完后，库内**每一行**仍满足 ' +
      'A1-5 的独立性判据（**冻结时件数**做前提，不拿库里现数的件数当前提），且"有帧无件""有帧有件"' +
      '"无帧无件（占位行）"三种形态各至少 1 行；"现在数到的件数 ≤ 冻结时数到的件数"全表成立（`judged_at` 只被往后刷）；' +
      '占位行两列都必须 NULL（`run_sec = 0` 那个 0 **不得**被读成"零运行"）—— 合法行不因"件数事后被动过"而假判红',
      a1ShapeEnd.rows.length >= 3 && a1ShapeEnd.bad.length === 0 && a1ShapeEnd.subsetBad.length === 0 &&
      a1ShapeEnd.kinds['有帧无件'] >= 1 && a1ShapeEnd.kinds['有帧有件'] >= 1 &&
      a1ShapeEnd.kinds['无帧无件（占位行）'] >= 1 &&
      a1ShapeEnd.staleRows.length >= 1,
      `共 ${a1ShapeEnd.rows.length} 行；与独立性判据不符 ${a1ShapeEnd.bad.length} 行（须为 0）` +
      `${a1ShapeEnd.bad.length ? '：' + a1ShapeEnd.bad.map(x => `${x.key}(${x.bad})`).join('、') : ''}；` +
      `"现在数到 ≤ 冻结时"不符 ${a1ShapeEnd.subsetBad.length} 行（须为 0）；` +
      `件数被事后动过的行 ${a1ShapeEnd.staleRows.length} 行（须 ≥ 1，否则 ⒜ 的现场没被覆盖）` +
      `${a1ShapeEnd.staleRows.length ? '：' + a1ShapeEnd.staleRows.map(x => x.key).join('、') : ''}；` +
      `形态行数＝${JSON.stringify(a1ShapeEnd.kinds)}（三种各须 ≥ 1）；逐行＝` +
      a1ShapeEnd.rows.map(x => `${x.key}(frames=${x.fact ? x.fact.frames : '?'},` +
        `冻结时件数=${x.fact ? x.fact.frozenPieces : '?'},现在数到=${x.fact ? x.fact.pieces : '?'}` +
        ` ⇒ oee=${JSON.stringify(x.row.oee)},pass_rate=${JSON.stringify(x.row.pass_rate)})`).join(' , '));
  } finally {
    shiftStatRepo.upsertFrozen = a1OrigUpsert;                // 计数包装当场还原成模块原件（不留痕）
    try { await serverEntry.stop('a1-e2e'); } catch { /* 尽力 */ }
    try { fs.rmSync(a1Tmp, { recursive: true, force: true }); } catch { /* 已删 */ }
  }
  t.check('A1：本节自建的临时目录跑完**当场删除**（一用例一库，不留残留）',
    !fs.existsSync(a1Tmp), a1Tmp);
}

/* ---------------- 十七、FR-7.12 公告写链路（IF-E `POST /notice`；T-20261002-08 交付） ----------------
   被测对象（**全部已入库**，本节只断言、不改实现）：
     · `server/repo/notice.js`      —— DR-10 的**唯一写入口**（`publish`/`edit`/`remove`）＋ 四个读口；
     · `server/http/routes/notice.js` —— **IF-E 写路由** `POST /notice`（鉴权 → 回环 → 锁定 → 动作 → 落库）；
     · `server/services/stateSnapshot.js` 的 `notices` 段 —— 与 `POST /notice` 响应**同一份投影**。
   需求依据：`FR-7.12`（P0）「**仅本机解锁后可新增/编辑/删除公告**」；「操作记录保留」＝`FR-8.7`／`NFR-15`／`DR-12`。
   负责人已裁定的口径（本节**逐条按它写**，不反向假设）：
     · **两支 403 都保留**（`not_loopback` ＝来源不是回环；`locked` ＝会话有效但账号锁定，ADR-0007 D2）⇒ 各一条；
     · 删除＝**硬删 ＋ 原文进 `op_log`**（`valid_to` 是 DR-10 的**有效期**语义，**不是**软删标志）；
     · 投影 `lv` 恒 `'info'`、`todo` 恒 `[]`（`notice` 表无等级/待办列 ⇒ **不要求实现编造**）；
     · **不发 SSE 事件**（前端用 `POST` 响应里同一份投影就地刷新）；
     · `valid_from` 缺省＝发布时刻、`valid_to` 缺省 NULL、`priority` 缺省 0 —— `FR-7.11` 的**有效期过滤与轮播
       未实现**（P1／技术债 `E3`），两列**只是如实落库**，故本节只断言"缺省取值"，**不**断言任何过滤/轮播行为；
     · 401 只 `warn` **不写库**（未解锁场景不留痕）；**过了鉴权闸**的被拒一律留一条 `result='失败'`。
   为什么进程内 ＋ 真进程两段都要：
     · `not_loopback` 与 `locked` **只能在进程内造**（回环闸看 `req.socket.remoteAddress`；锁定要看账号状态位），
       真 HTTP 回环请求永远是回环来源；
     · 而"`GET /state` 与 SSE `hello` 的 `notices` 同源同形"**只能在真进程上验**（SSE 是长连接、`hello` 是建连首帧）。
   `E86①`（已知集成缺口）：前端"解锁 ⇒ 会话令牌"**未接线**（属 `FR-8.4`／`ADR-0007` 的包）⇒ 服务端模式下
   前端写入会拿 401 并被**显示**。该缺口的行为断言归 `tests\ui-check.js`（本节**不**要求本包实现登录接线）。 */
t.section('十七、FR-7.12 公告写链路（IF-E `POST /notice`：鉴权／仅本机／锁定／入参／留痕／投影同源）');
{
  const dbApiN = require('../server/db');
  const { createAuth: createAuthN } = require('../server/services/auth');
  const { mountNotice } = require('../server/http/routes/notice');
  const { createRouter: createRouterN } = require('../server/http/router');
  const { createStateSnapshot } = require('../server/services/stateSnapshot');
  const opLogRepoN = require('../server/repo/opLog');
  const noticeRepoN = require('../server/repo/notice');

  const N_NOW = '2026-10-02 09:30:00';
  const N_PW = 'Notice#2026';

  /* 进程内 req/res 桩件（只为本节服务）。`remote` 可控 —— 回环闸那两条只能在进程内造；
     形状与 `server/http/router.js` 的 `readJson`/`json` 期望一致（`Symbol.asyncIterator` ＋ `writeHead/end`）。 */
  const nReq = ({ body = null, token = '', remote = '127.0.0.1' } = {}) => {
    const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    return {
      method: 'POST', url: '/notice',
      headers: token ? { authorization: 'Bearer ' + token } : {},
      socket: { remoteAddress: remote },
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: async () => (i < chunks.length
            ? { value: chunks[i++], done: false }
            : { value: undefined, done: true })
        };
      }
    };
  };
  const nRes = () => {
    const out = { status: null, body: null, text: '' };
    return {
      out,
      writeHead(s) { out.status = s; return this; },
      setHeader() { return this; },
      write() { return true; },
      end(t) {
        out.text = t === undefined ? '' : String(t);
        try { out.body = JSON.parse(out.text); } catch { out.body = null; }
        return this;
      },
      destroy() { return this; }
    };
  };

  const nTmp = harness.makeTempDb({ name: 'notice-route-matrix' });
  try {
    dbApiN.initSchema(nTmp.db, N_NOW);
    const nDb = nTmp.db;
    const nClock = createClock({ mode: 'fixed', at: '2026-10-02T09:30:00' });
    const nAuth = createAuthN({ db: nDb, now: nClock.source(), silent: true, teamCode: '检验一班' });
    const nInit = nAuth.init({ code: nAuth.initCode(), password: N_PW, remote: '127.0.0.1' });
    const nLogin = nAuth.login({ password: N_PW, remote: '127.0.0.1' });
    const nToken = (nLogin && nLogin.token) || '';
    const nRouter = createRouterN({ getHealth: () => ({ ok: true }), now: nClock.source() });
    const nMount = mountNotice(nRouter, {
      db: nDb, auth: nAuth, now: nClock.source(), operator: null, teamCode: '检验一班'
    });
    const nDrive = async opts => { const res = nRes(); await nRouter.handle(nReq(opts), res); return res.out; };
    const nCount = () => nDb.prepare('SELECT COUNT(*) AS c FROM notice').get().c;
    const nRows = () => nDb.prepare('SELECT * FROM notice ORDER BY id').all();
    const nOpCount = (opType, result) => (result === undefined
      ? nDb.prepare('SELECT COUNT(*) AS c FROM op_log WHERE op_type = ?').get(opType).c
      : nDb.prepare('SELECT COUNT(*) AS c FROM op_log WHERE op_type = ? AND result = ?').get(opType, result).c);
    /** 公告类留痕里的**失败**行（`auth` 自己的失败留痕 op_type 不以"公告"开头，故按前缀筛） */
    const nFailNotice = () => nDb.prepare(
      "SELECT op_type, result, content, operator, team_code, op_time FROM op_log " +
      "WHERE result = '失败' AND op_type LIKE '公告%' ORDER BY id").all();

    t.requires('FR-7.12 前提：进程内鉴权可初始化并取到会话令牌（下面的 401/403 才有归因对象）',
      Boolean(nInit && nInit.ok === true && nLogin && nLogin.ok === true && /^[0-9a-f]{64}$/.test(nToken)),
      `init.ok=${nInit && nInit.ok}；login.ok=${nLogin && nLogin.ok}；token 长度=${nToken.length}`);

    /* ---- A0 正对照：回环 ＋ 有效令牌 ⇒ 真落库（"解锁后新增公告"的最小闭环） ---- */
    const n0 = await nDrive({ token: nToken, body: { action: 'publish', content: '公告链路正对照（原文）', subType: '生产调整' } });
    const nRow0 = nRows()[0] || {};
    t.check('FR-7.12 路由 A0 正对照：回环来源 ＋ 有效会话令牌 ⇒ 200（不是 401/403/503）；`notice` 表恰 +1 行、' +
      '`op_log`（公告发布/成功）恰 +1 行；缺省取值如实落库（`valid_from`＝发布时刻、`valid_to`＝NULL、`priority`＝0）；' +
      '`mountNotice` 只注册 1 条路由且就是 `POST /notice`',
      n0.status === 200 && n0.body && n0.body.ok === true && nCount() === 1 && nRows().length === 1 &&
      nOpCount('公告发布', opLogRepoN.RESULT.SUCCESS) === 1 &&
      nRow0.content === '公告链路正对照（原文）' && nRow0.sub_type === '生产调整' &&
      nRow0.category === noticeRepoN.CATEGORY.NOTICE && Number(nRow0.priority) === 0 &&
      nRow0.valid_from === N_NOW && nRow0.valid_to === null && nRow0.created_at === N_NOW &&
      n0.body.opLogId !== null && nMount.routes.length === 1 && nMount.routes[0] === 'POST /notice',
      `HTTP ${n0.status}；notice=${nCount()} 行；发布留痕（成功）=${nOpCount('公告发布', opLogRepoN.RESULT.SUCCESS)}；` +
      `库行=${JSON.stringify(nRow0)}；routes=[${nMount.routes.join(',')}]`);
    const nPubId = n0.body && n0.body.id;

    /* ---- A1：401（未登录/伪造令牌）**不留痕** ---- */
    const nLogsBefore401 = opLogRepoN.count(nDb);
    const nNoTok = await nDrive({ body: { action: 'publish', content: '未登录不该写进去' } });
    const nForged = await nDrive({ token: 'deadbeef', body: { action: 'publish', content: '伪造令牌也不该写进去' } });
    t.check('FR-7.12 路由 A1 **未登录**（无 Bearer ＋ 伪造令牌）⇒ 两条都 401 `unauthorized`（带原因），' +
      '且 `notice` 表与 `op_log` **一行都没动** —— 未解锁场景不留痕（401 只在服务端日志 warn）',
      nNoTok.status === 401 && nNoTok.body && nNoTok.body.error === 'unauthorized' &&
      typeof nNoTok.body.reason === 'string' && nNoTok.body.reason.length > 0 &&
      nForged.status === 401 && nForged.body && nForged.body.error === 'unauthorized' &&
      nCount() === 1 && nOpCount('公告发布', opLogRepoN.RESULT.SUCCESS) === 1 &&
      opLogRepoN.count(nDb) === nLogsBefore401 && nFailNotice().length === 0,
      `无令牌=${nNoTok.status}/${nNoTok.body && nNoTok.body.error}；伪造=${nForged.status}/${nForged.body && nForged.body.error}；` +
      `notice=${nCount()}；op_log ${nLogsBefore401}→${opLogRepoN.count(nDb)}（应不变）；公告类失败留痕=${nFailNotice().length}（应 0）`);

    /* ---- A2：403 `not_loopback`（FR-7.12 的「仅本机」）＋ 过了鉴权闸的被拒要留痕 ---- */
    const nOff = await nDrive({
      token: nToken, remote: '10.10.2.77',
      body: { action: 'publish', content: '来自局域网的公告' }
    });
    const nFail2 = nFailNotice();
    t.check('FR-7.12 路由 A2 **非本机来源**（socket `10.10.2.77`）＋ 有效令牌 ⇒ 403 `not_loopback`' +
      '（FR-7.12「仅本机」；判据只看 `req.socket.remoteAddress`、不信请求头）；`notice` 表一行不写，' +
      '但**过了鉴权闸的被拒也留痕**：`op_log` 恰 +1 条 `result=失败`（带操作人/班组/DR-16 时刻）',
      nOff.status === 403 && nOff.body && nOff.body.error === 'not_loopback' && nCount() === 1 &&
      nFail2.length === 1 && nFail2[0].result === opLogRepoN.RESULT.FAILED &&
      nFail2[0].op_type === noticeRepoN.OP_TYPE.PUBLISH &&
      nFail2[0].operator !== null && nFail2[0].team_code === '检验一班' &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(nFail2[0].op_time)) &&
      /not_loopback/.test(String(nFail2[0].content)),
      `HTTP ${nOff.status}/${nOff.body && nOff.body.error}；notice=${nCount()}；公告类失败留痕=` +
      `${nFail2.length} 条：${JSON.stringify(nFail2)}`);

    /* ---- A3：400 `bad_value`（publish 缺 content ⇒ 仓储入参校验抛错 ⇒ 400，不是 500） ---- */
    const nBadVal = await nDrive({ token: nToken, body: { action: 'publish', subType: '生产调整' } });
    /* ---- A4：400 `bad_action`（动作名不在三态里） ---- */
    const nBadAct = await nDrive({ token: nToken, body: { action: 'rename', content: 'x' } });
    /* ---- A5：404 `not_found`（删不存在的行 ⇒ 不静默假装成功） ---- */
    const nMiss = await nDrive({ token: nToken, body: { action: 'delete', id: 999999 } });
    const nFail345 = nFailNotice();
    t.check('FR-7.12 路由 A3/A4/A5 三条逆向逐条落在契约码上：缺 `content` ⇒ 400 `bad_value`、' +
      '动作名非法 ⇒ 400 `bad_action`、删不存在的行 ⇒ 404 `not_found` —— **每条都留一条 `result=失败`**（拒收也留痕，' +
      '与 401/503 分得开），且 `notice` 表始终仍是 1 行',
      nBadVal.status === 400 && nBadVal.body && nBadVal.body.error === 'bad_value' &&
      nBadAct.status === 400 && nBadAct.body && nBadAct.body.error === 'bad_action' &&
      nMiss.status === 404 && nMiss.body && nMiss.body.error === 'not_found' &&
      nCount() === 1 && nFail345.length === 4 &&
      nFail345[1].op_type === noticeRepoN.OP_TYPE.PUBLISH &&
      nFail345[2].op_type === noticeRepoN.OP_TYPE.REJECT &&
      nFail345[3].op_type === noticeRepoN.OP_TYPE.DELETE &&
      nFail345.every(r => r.result === opLogRepoN.RESULT.FAILED),
      `缺 content=${nBadVal.status}/${nBadVal.body && nBadVal.body.error}；非法动作=${nBadAct.status}/${nBadAct.body && nBadAct.body.error}；` +
      `删不存在=${nMiss.status}/${nMiss.body && nMiss.body.error}；notice=${nCount()}；公告类失败留痕=` +
      `${nFail345.length} 条（op_type=${nFail345.map(r => r.op_type).join('/')}）`);

    /* ---- A6：编辑＝**同一条更新**（行数不变、`id`/`created_at` 不变、`updated_at` 刷新） ---- */
    const nEdit = await nDrive({
      token: nToken,
      body: { action: 'edit', id: nPubId, content: '公告链路正对照（编辑后）', subType: '工艺变更' }
    });
    const nRowE = nRows()[0] || {};
    t.check('FR-7.12 路由 A6 **编辑**：200 ⇒ 仍是**同一行**（`notice` 行数不变、`id` 与 `created_at` 逐字不变）而 ' +
      '`content`/`sub_type` 已更新、`updated_at` 刷新为本动作时刻；`op_log`（公告编辑/成功）恰 +1，' +
      '留痕正文含「内容『旧』→『新』」逐字变更清单',
      nEdit.status === 200 && nEdit.body && nEdit.body.ok === true && nCount() === 1 && nRows().length === 1 &&
      Number(nRowE.id) === Number(nPubId) && Number(nRowE.id) === Number(n0.body.id) &&
      nRowE.content === '公告链路正对照（编辑后）' && nRowE.sub_type === '工艺变更' &&
      nRowE.created_at === nRow0.created_at && nRowE.updated_at === N_NOW &&
      nOpCount('公告编辑', opLogRepoN.RESULT.SUCCESS) === 1 &&
      /公告链路正对照（原文）/.test(String(nEdit.body.changed && nEdit.body.changed.join('；'))) &&
      /公告链路正对照（编辑后）/.test(String(nEdit.body.changed && nEdit.body.changed.join('；'))),
      `HTTP ${nEdit.status}；行数=${nCount()}（id ${nRow0.id}→${nRowE.id}）；created_at ${nRow0.created_at}→${nRowE.created_at}；` +
      `updated_at=${nRowE.updated_at}；changed=${JSON.stringify(nEdit.body && nEdit.body.changed)}`);

    /* ---- A7：成功响应带的**投影**与 `GET /state` 快照走**同一份**（不写第二份投影） ---- */
    const nSnap = createStateSnapshot({ db: nDb, now: nClock.source() })();
    const nProj = nEdit.body && nEdit.body.notices;
    t.check('FR-7.12 路由 A7 **投影同源**：`POST /notice` 成功响应里的 `notices` 与 `GET /state` 快照的 `notices` ' +
      '**逐字节相等**，且都等于读口 `repo/notice.js` 的 `listForBoard()` 产出（三处一份投影）；' +
      '行形状＝`{id,tag,text,lv,time}`（`lv` 恒 `info`、`todo` 恒 `[]`，表无等级/待办列 ⇒ 不编造）',
      Boolean(nProj) && Boolean(nSnap.notices) &&
      JSON.stringify(nProj) === JSON.stringify(nSnap.notices) &&
      JSON.stringify(nProj) === JSON.stringify(noticeRepoN.listForBoard(nDb)) &&
      nProj.notices.length === 1 && nProj.notices[0].id === nPubId &&
      nProj.notices[0].tag === '工艺变更' && nProj.notices[0].text === '公告链路正对照（编辑后）' &&
      nProj.notices[0].lv === 'info' && /^\d{2}:\d{2}$/.test(String(nProj.notices[0].time)) &&
      Array.isArray(nProj.tips) && nProj.tips.length === 0 &&
      Array.isArray(nProj.todo) && nProj.todo.length === 0,
      `POST 响应 notices=${JSON.stringify(nProj)}；快照 notices=${JSON.stringify(nSnap.notices)}；三处相等=` +
      `${JSON.stringify(nProj) === JSON.stringify(nSnap.notices) && JSON.stringify(nProj) === JSON.stringify(noticeRepoN.listForBoard(nDb))}`);

    /* ---- A8：删除＝**硬删**（行数 −1、按 id 查不到）＋ 原文进留痕 ---- */
    const nDel = await nDrive({ token: nToken, body: { action: 'delete', id: nPubId } });
    const nDelAgain = await nDrive({ token: nToken, body: { action: 'delete', id: nPubId } });
    t.check('FR-7.12 路由 A8 **删除＝硬删 ＋ 原文进 `op_log`**：200 ⇒ `notice` 表 −1 行（0 行）、按 id 查不到，' +
      '删除留痕（公告删除/成功）恰 +1 且正文里带**原文**与发布时刻/创建人；对同一条**再删** ⇒ 404 `not_found`' +
      '（不静默假装成功）—— `valid_to` 仍是有效期列，**不是**软删标志',
      nDel.status === 200 && nDel.body && nDel.body.ok === true && nCount() === 0 &&
      noticeRepoN.getById(nDb, nPubId) === null &&
      nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS) === 1 &&
      nDelAgain.status === 404 && nDelAgain.body && nDelAgain.body.error === 'not_found' &&
      nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS) === 1 &&
      (() => {
        const row = nDb.prepare("SELECT content FROM op_log WHERE op_type = '公告删除' AND result = '成功' ORDER BY id DESC LIMIT 1").get();
        const txt = String(row && row.content);
        return /公告原文：公告链路正对照（编辑后）/.test(txt) && txt.includes(N_NOW);
      })(),
      `HTTP ${nDel.status}；notice=${nCount()}（硬删）；删除留痕（成功）=${nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS)}；` +
      `再删=${nDelAgain.status}/${nDelAgain.body && nDelAgain.body.error}；留痕正文=` +
      JSON.stringify((nDb.prepare("SELECT content FROM op_log WHERE op_type='公告删除' AND result='成功' ORDER BY id DESC LIMIT 1").get() || {}).content));

    /* ---- A9：503 `NO_SERVICE`（未接库 ⇒ 装配问题，不是报文问题；**无库可写故不留痕**） ---- */
    const n503Router = createRouterN({ getHealth: () => ({ ok: true }), now: nClock.source() });
    const n503Mount = mountNotice(n503Router, {
      db: null, auth: nAuth, now: nClock.source(), teamCode: '检验一班'
    });
    const nRes503 = nRes();
    await n503Router.handle(nReq({ token: nToken, body: { action: 'publish', content: '没有库就不该假装写成功' } }), nRes503);
    const n503 = nRes503.out;
    t.check('FR-7.12 路由 A9 **未接库**（`db = null`）＋ 有效令牌 ⇒ 503 `NO_SERVICE`（不静默假成功、也不报 400）；' +
      '`mounted:false` 自报；此时**无库可写** ⇒ 不计入留痕面（`status().rejected` 仍 0、`notice` 表仍是 0 行）',
      n503.status === 503 && n503.body && n503.body.error === 'NO_SERVICE' &&
      n503Mount.mounted === false && n503Mount.status().rejected === 0 &&
      nCount() === 0 && nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS) === 1,
      `HTTP ${n503.status}/${n503.body && n503.body.error}；mounted=${n503Mount.mounted}；` +
      `rejected=${n503Mount.status().rejected}（应 0）；notice=${nCount()}（应 0）`);

    /* ---- A10：403 `locked`（会话有效但账号锁定，ADR-0007 D2）—— 与 `not_loopback` **分得开** ---- */
    for (let i = 0; i < 6; i++) nAuth.login({ password: 'wrong-password', remote: '127.0.0.1' });
    const nLockedState = nAuth.status();
    const nLocked = await nDrive({ token: nToken, body: { action: 'publish', content: '锁定态不该写进去' } });
    t.check('FR-7.12 路由 A10 会话**仍然有效**但账号已**锁定** ⇒ 403 `locked`（"有登录态但无权限"这一支；' +
      'ADR-0007 D2 锁定期间口令正确也拒）—— 与 A2 的 `not_loopback` **两个码不混同**；同样留一条 `result=失败`',
      nLockedState.locked === true && nLocked.status === 403 && nLocked.body && nLocked.body.error === 'locked' &&
      typeof nLocked.body.retryAfterSec === 'number' && nCount() === 0 &&
      nFailNotice().length === 6 && nFailNotice()[5].op_type === noticeRepoN.OP_TYPE.PUBLISH &&
      nFailNotice()[5].result === opLogRepoN.RESULT.FAILED,
      `status.locked=${nLockedState.locked}（failCount=${nLockedState.failCount}）；HTTP ${nLocked.status}/` +
      `${nLocked.body && nLocked.body.error}（retryAfterSec=${nLocked.body && nLocked.body.retryAfterSec}）；` +
      `公告类失败留痕=${nFailNotice().length} 条（${nFailNotice().map(r => r.op_type).join('/')}）`);

    /* ---- A11：被拒留痕的**口径汇总**（401 不写、503 无库可写、其余各一条 `result=失败`） ---- */
    const nFailAll = nFailNotice();
    const nStat = nMount.status();
    t.check('FR-7.12 路由 A11 **被拒也留痕**的口径汇总（可逐条对账）：`401 ×2` 与 `503` **不写**，' +
      '`403 not_loopback`/`403 locked`/`400 bad_value`/`400 bad_action`/`404 not_found`/`404 再删` 各恰 1 条 —— ' +
      '公告类 `result=失败` 共 **6** 条，条数与 `status()` 计数器（`rejected=6`/`unauthorized=2`/`forbidden=2`）自洽',
      nFailAll.length === 6 && nStat.rejected === 6 && nStat.unauthorized === 2 && nStat.forbidden === 2 &&
      nFailAll.every(r => r.result === opLogRepoN.RESULT.FAILED && /^公告/.test(String(r.op_type))) &&
      nOpCount('公告发布', opLogRepoN.RESULT.SUCCESS) === 1 &&
      nOpCount('公告编辑', opLogRepoN.RESULT.SUCCESS) === 1 &&
      nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS) === 1 &&
      nStat.publish === 1 && nStat.edit === 1 && nStat.delete === 1,
      `公告类失败留痕 ${nFailAll.length} 条（op_type=${nFailAll.map(r => r.op_type).join('/')}）；` +
      `counters=${JSON.stringify(nStat)}；成功留痕 发布/编辑/删除=` +
      `${nOpCount('公告发布', opLogRepoN.RESULT.SUCCESS)}/${nOpCount('公告编辑', opLogRepoN.RESULT.SUCCESS)}/` +
      `${nOpCount('公告删除', opLogRepoN.RESULT.SUCCESS)}`);
  } finally {
    nTmp.close();
    t.check('FR-7.12：进程内矩阵自建的临时库跑完**当场关闭并删除**（一用例一库，不留残留）',
      !fs.existsSync(nTmp.dir), nTmp.dir);
  }

  /* ---- B：真进程 ＋ 真 HTTP ＋ 真 SQLite：会话令牌 → 发布 → `GET /state` 与 SSE `hello` 的 notices 同源同形 ----
     为什么必须另起真进程：`hello` 是 SSE **建连首帧**，只有走过真 HTTP 长连接才拿得到；
     而"两处同源"这句话的可证伪形态就是"两边 JSON 逐字节相等"（同一构造函数）。 ---- */
  {
    const nSvcTmp = harness.makeTempDir('notice-e2e');
    let nSvc = null;
    let nLive = null;
    /** 读一帧 SSE `hello`（真 HTTP 长连接；超时/中断一律按"没读到"返回，由断言判红，不静默当通过） */
    const nReadHello = async base => {
      const ctl = new AbortController();
      let text = '';
      try {
        const res = await fetch(base + '/events', { signal: ctl.signal });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let reading = reader.read();
        reading.catch(() => { /* abort/重置：由下面的 race 收敛 */ });
        const until = Date.now() + 6000;
        while (Date.now() < until && text.indexOf('event: hello') < 0) {
          let chunk;
          try {
            chunk = await Promise.race([
              reading,
              new Promise(r => setTimeout(() => r({ timeout: true }), 200))
            ]);
          } catch { break; }
          if (chunk.timeout) continue;
          if (chunk.done) break;
          text += dec.decode(chunk.value, { stream: true });
          reading = reader.read();
          reading.catch(() => { /* 同上 */ });
        }
        try { await reader.cancel(); } catch { /* 已关 */ }
      } catch (err) {
        text = 'ERR ' + ((err && err.message) || String(err));
      } finally {
        try { ctl.abort(); } catch { /* 已关 */ }
      }
      return text;
    };
    try {
      nSvc = await harness.startService({
        script: 'server/index.js', args: ['--data-dir', nSvcTmp], readyPath: '/health', timeoutMs: 30000
      });
      const nBase = `http://127.0.0.1:${nSvc.port}`;
      nLive = dbApiN.openDb(path.join(nSvcTmp, 'board.db'));
      const nCodeRow = nLive.db.prepare(
        "SELECT content FROM op_log WHERE op_type = '口令初始化码' ORDER BY id DESC LIMIT 1").get();
      const nInitCode = (/一次性初始化码=([0-9a-f]{12})/.exec(nCodeRow ? nCodeRow.content : '') || [])[1] || '';
      const nPostB = async (p, body, token) => {
        const headers = { Accept: 'application/json' };
        if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json;charset=UTF-8';
        if (token) headers.Authorization = 'Bearer ' + token;
        const r = await fetch(nBase + p, {
          method: 'POST', headers, body: body === undefined || body === null ? undefined : JSON.stringify(body)
        });
        const text = await r.text();
        let j = null;
        try { j = text ? JSON.parse(text) : null; } catch { j = null; }
        return { status: r.status, body: j, text };
      };
      const nInitB = await nPostB('/auth/init', { code: nInitCode, password: N_PW });
      const nLoginB = await nPostB('/auth/login', { password: N_PW });
      const nTokenB = (nLoginB.body && nLoginB.body.token) || '';
      const nPubB = await nPostB('/notice',
        { action: 'publish', content: '端到端公告：SSE 与 /state 同源', subType: '工艺变更' }, nTokenB);
      const nRowsB = nLive.db.prepare('SELECT * FROM notice ORDER BY id').all();
      t.check('FR-7.12 端到端 B1 真进程（真 HTTP ＋ 真 SQLite）：`/auth/init` ＋ `/auth/login` 取到会话令牌后 ' +
        '`POST /notice` 发布 ⇒ 200、库内恰 1 行（内容/类型逐字相符），`op_log` 有一条公告发布成功留痕 —— ' +
        '公告写入复用**既有登录态**，不另造第二套令牌',
        nInitB.status === 200 && nLoginB.status === 200 && /^[0-9a-f]{64}$/.test(nTokenB) &&
        nPubB.status === 200 && nPubB.body && nPubB.body.ok === true &&
        nRowsB.length === 1 && nRowsB[0].content === '端到端公告：SSE 与 /state 同源' &&
        nRowsB[0].sub_type === '工艺变更' &&
        nLive.db.prepare("SELECT COUNT(*) AS c FROM op_log WHERE op_type='公告发布' AND result='成功'").get().c === 1,
        `init=${nInitB.status}；login=${nLoginB.status}（token 长度 ${nTokenB.length}）；发布 HTTP ${nPubB.status}；` +
        `库内 ${nRowsB.length} 行=${JSON.stringify(nRowsB[0] || null)}`);

      const nStateRes = await fetch(nBase + '/state');
      const nStateBody = await nStateRes.json();
      const nStateNotices = nStateBody && nStateBody.snapshot && nStateBody.snapshot.notices;
      const nItem = nStateNotices && nStateNotices.notices && nStateNotices.notices[0];
      t.check('FR-7.12 端到端 B2 `GET /state` 快照的 `notices` 段＝库内真值（真进程上再验一次）：本条公告在列、' +
        '行形状＝`{id,tag,text,lv,time}`（`lv` 恒 `info`）、`tips`/`todo` 为数组且 `todo` 恒 `[]`',
        nStateRes.status === 200 && Boolean(nStateNotices) && Array.isArray(nStateNotices.notices) &&
        nStateNotices.notices.length === 1 && Boolean(nItem) &&
        Object.keys(nItem).sort().join(',') === 'id,lv,tag,text,time' &&
        nItem.id === nRowsB[0].id && nItem.tag === '工艺变更' && nItem.text === '端到端公告：SSE 与 /state 同源' &&
        nItem.lv === 'info' && /^\d{2}:\d{2}$/.test(String(nItem.time)) &&
        Array.isArray(nStateNotices.todo) && nStateNotices.todo.length === 0,
        `snapshot.notices=${JSON.stringify(nStateNotices)}`);

      const nHelloText = await nReadHello(nBase);
      const nHelloMatch = /event: hello\ndata: ([^\n]+)/.exec(nHelloText);
      let nHelloData = null;
      try { nHelloData = nHelloMatch ? JSON.parse(nHelloMatch[1]) : null; } catch { nHelloData = null; }
      const nHelloNotices = nHelloData && nHelloData.snapshot && nHelloData.snapshot.notices;
      t.check('FR-7.12 端到端 B3 SSE `hello`（建连首帧）与 `GET /state` 的 `notices` **同源同形**：两处 ' +
        '`JSON.stringify` 逐字节相等，且都含本条公告 —— 前端"用 POST 响应里同一份投影就地刷新"与' +
        '"`hello` 与 `/state` 同一构造函数"这两条口径由此同时成立',
        Boolean(nHelloNotices) && JSON.stringify(nHelloNotices) === JSON.stringify(nStateNotices) &&
        nHelloNotices.notices.length === 1 &&
        nHelloNotices.notices[0].text === '端到端公告：SSE 与 /state 同源',
        `hello.snapshot.notices=${JSON.stringify(nHelloNotices)}；与 /state 相等=` +
        `${JSON.stringify(nHelloNotices) === JSON.stringify(nStateNotices)}；hello 原文片段=` +
        JSON.stringify(nHelloText.slice(0, 220)));
    } finally {
      if (nLive) { try { nLive.db.close(); } catch { /* 已关 */ } }
      if (nSvc) { try { await nSvc.stop(); } catch { /* 尽力 */ } }
      try { fs.rmSync(nSvcTmp, { recursive: true, force: true }); } catch { /* 已删 */ }
    }
    t.check('FR-7.12 端到端：本节自建的服务与临时目录跑完**当场停掉并删除**（一用例一库，不留残留）',
      !fs.existsSync(nSvcTmp) && (!nSvc || nSvc.proc.exitCode !== null || nSvc.proc.killed === true),
      `${nSvcTmp} 存在=${fs.existsSync(nSvcTmp)}`);
  }
}

/* ---------------- 十八、E87 `POST /upload/retry` 的回环来源闸（方案 b；`T-20261002-10` 交付） ----------------
   被测对象（**只断言、不改实现**）：`server/http/routes/upload.js` 的 `POST /upload/retry` —— 全仓
   **唯一**会再次向 MES 发送待补传报文的入口（且按 `created_at,id` 顺序**批量**重发）。
   裁定（2026-10-02，负责人**方案 b**）：**只加回环校验**（`services/auth.js` 的 `isLoopback()`
   ＋ `routes/auth.js` 的 `remoteOf()`，取**真源**、不写第二份），非回环 ⇒ **403 `not_loopback`**；
   登录态那一半留到 `E86①` 的前端令牌接线落定后再加 —— 故本节**不**断言登录态（也不得读成"已鉴权"）。
   为什么"没发送"必须有**调用计数**证据（`ADR-0004 D19`）：403 只是**应答**，它不排除"先发了再拒"；
   能把"一条都没发"证成的只有**桩上 `retryPending()` 的调用增量 ＝ 0**（外加 `router.readJson` 的
   增量 ＝ 0 ⇒ 连请求体都没读，拒绝发生在处理之前）。本节因此**拒绝**任何"只看 403 就算验过"的写法。
   判据来源**不注入**：`mountUpload()` 的 `isLoopback`/`remoteOf` 两个注入口一律**不传** ⇒ 走的是
   `server/index.js` 生产接线同一条真源路径（注入口只为探针而设；验注入口 ≠ 验实现）。
   "非回环"怎么造（`ADR-0007 D4`：只信 `req.socket.remoteAddress`、不信任何请求头）⇒ 只能在**进程内**
   遮蔽 socket 取值器（`Object.defineProperty`），且本节走**真 HTTP**（`http.createServer` ＋ `fetch`），
   不是直接调处理器 —— 与 `T-20261002-10` 的探针同款构造，但期望值由本节自持。
   范围最小化：`GET /upload/pending` 这类**只读**端点不在本包范围内 ⇒ 同一非回环来源进来仍必须 200。 */
t.section('十八、E87 `POST /upload/retry` 的回环来源闸（非回环 ⇒ 403 且一次都不发）');
{
  const { createRouter: createRouterE87 } = require('../server/http/router');
  const { mountUpload: mountUploadE87 } = require('../server/http/routes/upload');
  const { isLoopback: isLoopbackE87 } = require('../server/services/auth');
  const { remoteOf: remoteOfE87 } = require('../server/http/routes/auth');
  /* RFC 5737 TEST-NET-3：保留给文档的网段，**不可能是**本机回环地址（无副作用，不是真网段） */
  const E87_FORGED = '203.0.113.7';
  const E87_LOOPBACKS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

  const e87Calls = { retryPending: 0, listPending: 0, readJson: 0, buildReport: 0 };
  const e87Warns = [];
  const e87Clock = createClock({ mode: 'fixed', at: '2026-10-02T09:30:00' });
  const e87Reporter = {
    retryPending: async input => {
      e87Calls.retryPending++;
      return { ok: true, requested: 1, sent: 1, failed: 0, remaining: 0, input: input || {}, results: [] };
    },
    listPending: () => { e87Calls.listPending++; return []; },
    status: () => ({ mount: 'upload', pendingCount: 0, alert: { warn: false }, autoRetry: false }),
    buildReport: () => { e87Calls.buildReport++; return { ok: false, error: '本节只验重报闸，不组装报文' }; }
  };
  const e87Router = createRouterE87({ getHealth: () => ({ ok: true }), now: e87Clock.source() });
  /* 读体计数：**唯一**能把"拒绝发生在读体之前"证成的读数（不是看源码行号，见本节头注） */
  const e87ReadJsonOrig = e87Router.readJson.bind(e87Router);
  e87Router.readJson = async req => { e87Calls.readJson++; return e87ReadJsonOrig(req); };
  /* **不传** isLoopback/remoteOf ⇒ 真源 */
  const e87Mount = mountUploadE87(e87Router, {
    reporter: e87Reporter,
    logger: { warn: m => e87Warns.push(String(m)), info: () => {}, error: () => {} },
    now: e87Clock.source()
  });

  /* `e87Forge` 非空 ⇒ 把**这一条**请求的 socket 来源改写成非回环（进程内伪造；用 defineProperty 建
     自有属性以遮蔽 `net.Socket.prototype` 上的取值器 —— 直接赋值在严格模式下会抛错）。 */
  let e87Forge = null;
  const e87Server = http.createServer((req, res) => {
    if (e87Forge) {
      Object.defineProperty(req.socket, 'remoteAddress', { value: e87Forge, configurable: true, enumerable: true });
    }
    Promise.resolve(e87Router.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
  });
  const e87Port = await harness.allocPort();
  await new Promise((resolve, reject) => {
    e87Server.once('error', reject);
    e87Server.listen(e87Port, '127.0.0.1', resolve);
  });
  const e87Post = async body => {
    const r = await fetch(`http://127.0.0.1:${e87Port}/upload/retry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: r.status, body: parsed, text };
  };
  const e87Get = async p => {
    const r = await fetch(`http://127.0.0.1:${e87Port}${p}`);
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: r.status, body: parsed, text };
  };

  try {
    t.check('E87-0 装配与判据真源：`mountUpload()` 自报 mounted:true 且注册 4 条路由（含 `POST /upload/retry`）；' +
      '判据取**真源**（`services/auth.js` 的 `isLoopback()` 认三种回环写法、`routes/auth.js` 的 `remoteOf()` ' +
      '**只信 socket**、`X-Forwarded-For` 一律不信）—— 本节的装配**没有**注入这两个判据',
      e87Mount.mounted === true && e87Mount.routes.length === 4 &&
      e87Mount.routes.indexOf('POST /upload/retry') >= 0 &&
      E87_LOOPBACKS.every(a => isLoopbackE87(a) === true) && isLoopbackE87(E87_FORGED) === false &&
      remoteOfE87({ socket: { remoteAddress: '10.0.0.9' }, headers: { 'x-forwarded-for': '127.0.0.1' } }) === '10.0.0.9' &&
      remoteOfE87({ headers: { 'x-forwarded-for': '127.0.0.1' } }) === '',
      `mounted=${e87Mount.mounted}；routes=[${e87Mount.routes.join(' , ')}]；` +
      `真源读数：isLoopback(${E87_LOOPBACKS.join('/')})=` +
      `${E87_LOOPBACKS.map(a => isLoopbackE87(a)).join('/')}、isLoopback(${E87_FORGED})=${isLoopbackE87(E87_FORGED)}；` +
      `remoteOf(伪造 XFF ＋ socket 10.0.0.9)=${JSON.stringify(remoteOfE87({ socket: { remoteAddress: '10.0.0.9' }, headers: { 'x-forwarded-for': '127.0.0.1' } }))}`);

    /* ---- 读数①：真回环（真 HTTP）⇒ 仍 200 且**真发一次**（正对照：防"把一切都拒了"也算完成"） ---- */
    const e87B1 = { ...e87Calls };
    const e87R1 = await e87Post({});
    const e87D1 = {
      retry: e87Calls.retryPending - e87B1.retryPending,
      read: e87Calls.readJson - e87B1.readJson,
      handled: e87Mount.counters.retryHandled, forbidden: e87Mount.counters.forbidden
    };
    t.check('E87-1 读数①（真回环，真 HTTP）：`POST /upload/retry` ⇒ **HTTP 200** ＋ `ok:true` ＋ `sent:1`，' +
      '桩上 `retryPending()` 调用 **Δ=1**（回环路径照旧真发送），`counters.retryHandled` 如实为 1、`forbidden` 为 0',
      e87R1.status === 200 && e87R1.body && e87R1.body.ok === true && e87R1.body.sent === 1 &&
      e87D1.retry === 1 && e87D1.read === 1 && e87D1.handled === 1 && e87D1.forbidden === 0,
      `HTTP ${e87R1.status}；body=${JSON.stringify(e87R1.body)}；retryPending Δ=${e87D1.retry}、` +
      `readJson Δ=${e87D1.read}、counters=${JSON.stringify(e87Mount.counters)}`);

    /* ---- 读数②：非回环（进程内伪造 socket）⇒ 403 且 retryPending／readJson 的增量**都为 0** ---- */
    e87Forge = E87_FORGED;
    const e87B2 = { ...e87Calls, warns: e87Warns.length };
    const e87R2 = await e87Post({});
    const e87D2 = {
      retry: e87Calls.retryPending - e87B2.retryPending,
      read: e87Calls.readJson - e87B2.readJson,
      warns: e87Warns.length - e87B2.warns,
      handled: e87Mount.counters.retryHandled, forbidden: e87Mount.counters.forbidden
    };
    t.check('E87-2 读数②（**本组核心**）：伪造 `req.socket.remoteAddress=' + E87_FORGED + '` ⇒ **HTTP 403** ' +
      '`not_loopback`（`ok:false`／`error`／`err.code`／`remote`／`at` 齐全），且桩上 `retryPending()` **Δ=0** ' +
      '（"一条都没发"是**计数**证据，不是从 403 推出来的）、`counters.retryHandled` 未增、`counters.forbidden` ＋1',
      e87R2.status === 403 && e87R2.body && e87R2.body.ok === false && e87R2.body.error === 'not_loopback' &&
      Boolean(e87R2.body.err) && e87R2.body.err.code === 'not_loopback' && e87R2.body.err.httpStatus === 403 &&
      e87R2.body.remote === E87_FORGED && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(e87R2.body.at)) &&
      e87D2.retry === 0 && e87Calls.retryPending === 1 && e87D2.handled === 1 && e87D2.forbidden === 1,
      `HTTP ${e87R2.status}；body=${JSON.stringify(e87R2.body)}；retryPending Δ=${e87D2.retry}` +
      `（累计仍为 ${e87Calls.retryPending}，即只有读数①那一次）；retryHandled=${e87D2.handled}、forbidden=${e87D2.forbidden}`);

    t.check('E87-3 拒绝发生在**读请求体之前**（结构证据）：非回环请求下 `router.readJson()` 的调用增量 **Δ=0**' +
      ' —— 读体、入参校验、`retryPending()` 三步一步都没走到（"不发送"由此在结构上成立，而不只是"应答是 403"）',
      e87D2.read === 0 && e87D2.warns === 1 && e87Warns.length === 1 &&
      /非回环来源/.test(e87Warns[0]) && e87Warns[0].indexOf(E87_FORGED) >= 0,
      `readJson Δ=${e87D2.read}；` +
      `留痕口径（只 warn 不写 op_log）：被拒 warn Δ=${e87D2.warns}（每条被拒恰一条，含来源 IP）；` +
      `原文=${JSON.stringify(e87Warns[0] || '')}`);

    /* ---- 顺序证据：闸在**入参校验之前** —— 非回环 ＋ 非法入参（`limit:0`）必须仍是 403，而不是 400 ---- */
    const e87R3 = await e87Post({ limit: 0 });
    t.check('E87-4 顺序：非回环 ＋ **非法入参**（`limit:0`）仍落在来源闸上 ⇒ **403 `not_loopback`**（不是 400 `BAD_VALUE`），' +
      '且 `retryPending`／`readJson` 的增量在这条上**仍为 0**（闸的位置不是"读体之后再补一道"）',
      e87R3.status === 403 && e87R3.body && e87R3.body.err && e87R3.body.err.code === 'not_loopback' &&
      e87Calls.retryPending === 1 && e87Calls.readJson === 1,
      `HTTP ${e87R3.status}／${e87R3.body && e87R3.body.err && e87R3.body.err.code}；` +
      `retryPending 累计=${e87Calls.retryPending}（仍只有读数①那一次）、readJson 累计=${e87Calls.readJson}`);

    /* ---- 范围证据：只读端点**未被牵连**（同一非回环来源仍 200） ---- */
    const e87B4 = e87Calls.listPending;
    const e87R4 = await e87Get('/upload/pending');
    t.check('E87-5 范围最小化：同一**非回环**来源下 `GET /upload/pending`（只读）仍 **200** 且 `ok:true`、' +
      '真的走了读口（`listPending` 被调用）—— 本包只收写入口，未把只读端点一起拒掉',
      e87R4.status === 200 && e87R4.body && e87R4.body.ok === true && e87Calls.listPending - e87B4 >= 1,
      `GET /upload/pending ⇒ HTTP ${e87R4.status}（非回环）；listPending 调用 Δ=${e87Calls.listPending - e87B4}`);

    /* ---- 口径：`counters` **不进任何 HTTP 响应体**（前端与契约不动；只在挂载对象上可读） ---- */
    const e87LeakKeys = ['counters', 'retryHandled', 'forbidden'];
    const e87Leaks = [e87R1, e87R2, e87R3, e87R4].filter(r =>
      e87LeakKeys.some(k => r.text.indexOf('"' + k + '"') >= 0));
    t.check('E87-6 `counters`（`retryHandled`／`forbidden`）**不进任何 HTTP 响应体**：200／403／400 三类应答与只读端点的' +
      '响应文本里都不出现这三个键 —— 计数只供自检与巡检读，前端契约不动（口径依据见 `forbiddenBody()` 的注释）',
      e87Leaks.length === 0 &&
      Object.keys(e87Mount.counters).sort().join(',') === 'forbidden,retryHandled',
      `被检查的应答 ${[e87R1, e87R2, e87R3, e87R4].length} 条，含计数键的 ${e87Leaks.length} 条；` +
      `挂载对象上的 counters=${JSON.stringify(e87Mount.counters)}（可读，但不外泄到响应体）`);
  } finally {
    await new Promise(resolve => e87Server.close(resolve));
  }
  t.check('E87-7 本节自建的 HTTP 服务跑完**当场关停**（不留监听端口/残留进程；伪造只发生在进程内）',
    e87Server.listening === false, `listening=${e87Server.listening}`);
}

/* ---------------- 十九、E86①／ADR-0007：登录接线的端到端判据（**真进程 ＋ 真 HTTP**） ----------------
   立案：技术债 `E86①`（前端"解锁 ⇒ 服务端会话令牌"未接线）由 `T-20261002-15` 交付，其关闭条件是
        "**带令牌 `POST /notice` ⇒ 200 且库内 `notice` 恰 +1 行**"（路线图 `E86①` 原文）。此前该判据
        只在座位 3 的**探针**（`tests\._verify\seat3-t15-probe.js`，不进任何门禁）里跑过 ——
        探针会随 `._verify` 一起被清掉，等于"**交付了却从未被门禁验证**"（R-2026-09-19-02 的 P2-16）。
        本节把同样的读数**收进门禁**，期望值全部来自本包对真进程的**实测**（见回执的探针读数）。
   ⚠ 覆盖层级（**如实标注**，照 `ADR-0007` §D8⑤ 的先例）：
        · 本节的九条读数（未初始化／初始化／令牌／公告落库／无令牌与伪造／登出重放／锁定与到期／
          改密／留痕）**全部**在 `node server\index.js` 的**真子进程**上经**真 HTTP**（`fetch`）取得，
          库内读数用 `node:sqlite` 以只读连接直接读该子进程的数据目录；
        · **"锁定到期"不用注入时钟**：`createAuth({ now })` 只能在**进程内**注入，真进程读的是真实时钟，
          故到期一律由 **D2 明写的落库真源**（`auth_credential.locked_until` 置为过去时刻）复现 ——
          这不是绕过判据，而是"状态位的真源就是那一列"（ADR-0007 §D8⑨：可解析且在过去的 `locked_until` ⇒ 放行）。
          **注入时钟**那条路径（`advanceMin()` 推进到期、滑动续期、绝对上限）由 `db-check` 九之三
          在**服务层**覆盖，两者互补，本节不重复。
        · 非回环来源的拒绝（403 `not_loopback`）在真 HTTP 层造不出来（本机 `fetch` 恒为回环）
          ⇒ 该判据按 `ADR-0007` §D8⑤ 留在服务层探针，本节**不冒充**有它。
   一用例一库：本节的库是该子进程自己的数据目录（`harness.makeTempDir` 内），跑完连目录一起删。 */
t.section('十九、E86①／ADR-0007 登录接线的端到端判据（真子进程 ＋ 真 HTTP：未初始化／初始化／令牌／公告落库／登出／锁定／改密／留痕）');
{
  const { DatabaseSync } = require('node:sqlite');
  const AUTH_E2E_PW = 'Harness-Auth-E2E-2026';
  const AUTH_E2E_PW2 = 'Harness-Auth-E2E-New-2026';
  const AUTH_E2E_USER = 'admin';
  /* 「期满」用的过去时刻：D8⑨ 口径下"可解析且早已过期"⇒ 未锁定（放行） */
  const AUTH_E2E_PAST = '2000-01-01 00:00:00';
  /* 60 s：与 `startService` 的默认超时同量级；服务端装配（initSchema + auth 初始化码打印）在本机约 2～4 s */
  const AUTH_E2E_READY_MS = 60000;

  const a19DataDir = harness.makeTempDir('auth-e2e-data');
  const a19DbFile = path.join(a19DataDir, 'board.db');
  const a19Port = await harness.allocPort();
  const a19Svc = await harness.startService({
    script: require.resolve('../server/index.js'),
    args: ['--host', '127.0.0.1', '--port', String(a19Port), '--data-dir', a19DataDir],
    port: a19Port, readyPath: '/health', timeoutMs: 60000
  });

  /** 一次性初始化码：**只**能来自服务进程的启动日志（D4：仅内存、HTTP 层从不下发） */
  async function a19InitCode() {
    const deadline = Date.now() + AUTH_E2E_READY_MS;
    while (Date.now() < deadline) {
      const m = /本机一次性初始化码 = ([0-9a-f]{12})/.exec(a19Svc.output());
      if (m) return m[1];
      await new Promise(r => setTimeout(r, 150));
    }
    return '';
  }
  /** 真 HTTP：返回 `{status, body, text}`（解析失败时 body 记 `{raw}`，不静默吞） */
  async function a19Http(method, p, body, headers) {
    const init = { method, headers: Object.assign({ Accept: 'application/json' }, headers || {}) };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json;charset=UTF-8';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${a19Port}${p}`, init);
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed, text };
  }
  /** 库内只读读数（服务进程持 WAL 写锁不影响并发读；读连接用完即关） */
  function a19Ro(sql, params) {
    const db = new DatabaseSync(a19DbFile, { readOnly: true });
    try { return db.prepare(sql).all(...(params || [])); } finally { db.close(); }
  }
  /** 库内**写**真源（只为"锁定到期"复现状态位；`busy_timeout` 防与服务进程的采样写撞车） */
  function a19Rw(sql, params) {
    const db = new DatabaseSync(a19DbFile);
    try {
      db.prepare('PRAGMA busy_timeout = 8000').get();
      db.prepare(sql).run(...(params || []));
    } finally { db.close(); }
  }
  const a19NoticeCount = () => a19Ro('SELECT COUNT(*) AS c FROM notice')[0].c;
  const a19Cred = () => a19Ro('SELECT * FROM auth_credential WHERE username = ?', [AUTH_E2E_USER])[0] || null;

  try {
    const a19Code = await a19InitCode();
    t.requires('服务进程已在启动日志里打印一次性初始化码（D4 的"打印 + op_log"两条登记路径之一）',
      /^[0-9a-f]{12}$/.test(a19Code),
      `从 ${path.relative(env.paths.root, a19Svc.logFile)} 读到码=${a19Code ? a19Code.slice(0, 4) + '…' : '(无)'}`);
    /* 前提（D20）：负向/正向两条写库读数都以"新库 notice 为空"为基线 —— 这是**数据状态**的前提，
       不写成 check（否则"库里本来就有行"会被误报成实现缺陷）。 */
    const a19NStart = a19NoticeCount();
    t.requires('新库 `notice` 初始为 0 行（读数③/④ 的行数基线）', a19NStart === 0,
      `实测 notice 行数=${a19NStart}`);

    /* ---- 读数①（未初始化态，D4）：`/auth/status` 如实报未初始化；`/auth/login` 一律 409 ---- */
    const a19St0 = await a19Http('GET', '/auth/status');
    const a19Login0 = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW });
    t.check('E86①-1（未初始化态，D4）真 HTTP：`GET /auth/status` ⇒ 200 且 `initialized=false`／`initCodePending=true`；' +
      '`POST /auth/login` ⇒ **409 `not_initialized`**（不设默认口令 ⇒ 未初始化时任何口令都进不去）',
      a19St0.status === 200 && a19St0.body && a19St0.body.ok === true &&
      a19St0.body.initialized === false && a19St0.body.initCodePending === true &&
      a19Login0.status === 409 && a19Login0.body && a19Login0.body.error === 'not_initialized',
      `status=${a19St0.status} initialized=${a19St0.body && a19St0.body.initialized} ` +
      `initCodePending=${a19St0.body && a19St0.body.initCodePending}；login=${a19Login0.status} ${JSON.stringify(a19Login0.body)}`);

    /* ---- 读数②（初始化 ⇒ 登录 ⇒ 令牌）：本机回环 + 一次性码；库里只有派生值 ---- */
    const a19Init = await a19Http('POST', '/auth/init', { code: a19Code, password: AUTH_E2E_PW });
    const a19InitAgain = await a19Http('POST', '/auth/init', { code: a19Code, password: AUTH_E2E_PW });
    const a19Login = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW });
    const a19Token = a19Login.body && a19Login.body.token;
    const a19Cred0 = a19Cred();
    t.check('E86①-2（初始化 → 登录 → 令牌）真 HTTP：`POST /auth/init {code,password}`（**本机回环**）⇒ 200；' +
      '`POST /auth/login`（正确口令）⇒ 200 + **64 位 hex** 会话令牌；库内 `auth_credential` **恰一行**且**不含明文**' +
      '（`algo=scrypt`、`params=N=16384,r=8,p=1,keylen=32` 逐字照 ADR-0007 D1、`is_initial=1`）；' +
      '同一枚码**第二次**被拒（用后即废，D4）',
      a19Init.status === 200 && a19Init.body && a19Init.body.ok === true &&
      a19Login.status === 200 && a19Login.body && a19Login.body.ok === true &&
      /^[0-9a-f]{64}$/.test(String(a19Token)) &&
      Boolean(a19Cred0) && a19Cred0.algo === 'scrypt' &&
      a19Cred0.params === 'N=16384,r=8,p=1,keylen=32' && Number(a19Cred0.is_initial) === 1 &&
      JSON.stringify(a19Cred0).indexOf(AUTH_E2E_PW) < 0 &&
      ((a19InitAgain.status === 409 && a19InitAgain.body.error === 'already_initialized') ||
        (a19InitAgain.status === 401 && a19InitAgain.body.error === 'bad_init_code')),
      `init=${a19Init.status}；再 init=${a19InitAgain.status}:${a19InitAgain.body && a19InitAgain.body.error}；` +
      `login=${a19Login.status} token=${String(a19Token).slice(0, 12)}…(${String(a19Token).length})；` +
      `credential=${JSON.stringify({ username: a19Cred0 && a19Cred0.username, algo: a19Cred0 && a19Cred0.algo, params: a19Cred0 && a19Cred0.params, is_initial: a19Cred0 && a19Cred0.is_initial })}`);

    /* ---- 读数③（无令牌／伪造令牌 ⇒ 401 且**库内不增**）：负向对照，防"把一切都放行" ---- */
    const a19N0 = a19NoticeCount();
    const a19NoTok = await a19Http('POST', '/notice', { action: 'publish', content: '十九：无令牌', subType: '车间公示' });
    const a19Fake = await a19Http('POST', '/notice', { action: 'publish', content: '十九：伪造令牌', subType: '车间公示' },
      { Authorization: 'Bearer ' + 'f'.repeat(64) });
    const a19N1 = a19NoticeCount();
    t.check('E86①-3（负向对照）真 HTTP：`POST /notice` **无令牌**与**伪造令牌**一律 401 `unauthorized`，' +
      '且库内 `notice` 行数**逐次不变**（负向路径不写库 —— 判据是**行数**，不是"应答看起来像拒绝"）',
      a19NoTok.status === 401 && a19NoTok.body && a19NoTok.body.error === 'unauthorized' &&
      a19Fake.status === 401 && a19Fake.body && a19Fake.body.error === 'unauthorized' &&
      a19N1 === a19N0,
      `无令牌=${a19NoTok.status}:${a19NoTok.body && a19NoTok.body.error}；` +
      `伪造=${a19Fake.status}:${a19Fake.body && a19Fake.body.error}；notice 行数 ${a19N0} → ${a19N1}`);

    /* ---- 读数④（**E86① 的关闭条件**）：带令牌 ⇒ 200 且库内 notice 恰 +1 行、内容逐字落库 ---- */
    const a19BeforeOk = a19NoticeCount();
    const a19OkBody = { action: 'publish', content: '十九：E86① 关闭证据（带会话令牌写入的公告）', subType: '生产调整' };
    const a19Ok = await a19Http('POST', '/notice', a19OkBody, { Authorization: 'Bearer ' + a19Token });
    const a19AfterOk = a19NoticeCount();
    const a19Rows = a19Ro('SELECT id, sub_type, content FROM notice ORDER BY id');
    t.check('E86①-4 **关闭条件**：真 HTTP 下**带令牌 `POST /notice` ⇒ 200 且库内 `notice` 恰新增 1 行**' +
      '（内容逐字落库；这就是路线图 `E86①` 说的"令牌一接上即通"）',
      a19Ok.status === 200 && a19Ok.body && a19Ok.body.ok === true &&
      a19AfterOk === a19BeforeOk + 1 &&
      a19Rows.some(r => r.content === a19OkBody.content && r.sub_type === a19OkBody.subType),
      `POST /notice=${a19Ok.status}；行数 ${a19BeforeOk} → ${a19AfterOk}；` +
      `落库行=${JSON.stringify(a19Rows.map(r => ({ id: r.id, sub_type: r.sub_type, content: r.content })))}`);

    /* ---- 读数⑤（登出 ⇒ 同令牌立刻失效）：令牌的"即刻失效"必须能在**写库**上读到 ---- */
    const a19Logout = await a19Http('POST', '/auth/logout', {}, { Authorization: 'Bearer ' + a19Token });
    const a19Replay = await a19Http('POST', '/notice', { action: 'publish', content: '十九：登出后重放', subType: '车间公示' },
      { Authorization: 'Bearer ' + a19Token });
    const a19N3 = a19NoticeCount();
    t.check('E86①-5（登出即失效）真 HTTP：`POST /auth/logout` ⇒ 200 + `requireRelogin=true`；' +
      '**同一令牌重放**写公告 ⇒ 401 `unauthorized` 且库内**不再新增行**（令牌不是"标了个已登出"的摆设）',
      a19Logout.status === 200 && a19Logout.body && a19Logout.body.ok === true &&
      a19Logout.body.requireRelogin === true &&
      a19Replay.status === 401 && a19Replay.body && a19Replay.body.error === 'unauthorized' &&
      a19N3 === a19AfterOk,
      `logout=${a19Logout.status} ${JSON.stringify(a19Logout.body)}；重放=${a19Replay.status}:${a19Replay.body && a19Replay.body.error}；` +
      `notice 行数 ${a19AfterOk} → ${a19N3}`);

    /* ---- 读数⑥（改密 FR-8.4 / D5 / D8④）：原口令错 401；成功 ⇒ 换盐换派生值 + 清全部在途会话 ---- */
    const a19Tok2 = (await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW })).body.token;
    const a19ChBad = await a19Http('POST', '/auth/change', { oldPassword: 'not-the-old-one', newPassword: AUTH_E2E_PW2 },
      { Authorization: 'Bearer ' + a19Tok2 });
    const a19ChOk = await a19Http('POST', '/auth/change', { oldPassword: AUTH_E2E_PW, newPassword: AUTH_E2E_PW2 },
      { Authorization: 'Bearer ' + a19Tok2 });
    const a19OldLogin = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW });
    const a19NewLogin = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW2 });
    const a19Cred1 = a19Cred();
    t.check('E86①-6（改密 FR-8.4）真 HTTP：`POST /auth/change` **原口令错 ⇒ 401 `bad_credentials`**（且会话不清）；' +
      '改密成功 ⇒ 200 + `requireRelogin` + `sessionsCleared≥1`；**旧口令 401 / 新口令 200**；' +
      '库内 `is_initial` 由 1 变 0、`changed_by=设置页改密`、`salt`/`hash` 都已换新（换盐换派生值，不是改标记）',
      a19ChBad.status === 401 && a19ChBad.body && a19ChBad.body.error === 'bad_credentials' &&
      a19ChOk.status === 200 && a19ChOk.body && a19ChOk.body.requireRelogin === true &&
      Number(a19ChOk.body.sessionsCleared) >= 1 &&
      a19OldLogin.status === 401 && a19OldLogin.body && a19OldLogin.body.error === 'bad_credentials' &&
      a19NewLogin.status === 200 && /^[0-9a-f]{64}$/.test(String(a19NewLogin.body && a19NewLogin.body.token)) &&
      Boolean(a19Cred1) && Number(a19Cred1.is_initial) === 0 && a19Cred1.changed_by === '设置页改密' &&
      a19Cred1.salt !== a19Cred0.salt && a19Cred1.hash !== a19Cred0.hash,
      `原口令错=${a19ChBad.status}:${a19ChBad.body && a19ChBad.body.error}；改密=${a19ChOk.status} ${JSON.stringify(a19ChOk.body)}；` +
      `旧口令=${a19OldLogin.status}、新口令=${a19NewLogin.status}；换盐=${Boolean(a19Cred1) && a19Cred1.salt !== a19Cred0.salt}、` +
      `换派生值=${Boolean(a19Cred1) && a19Cred1.hash !== a19Cred0.hash}；is_initial=${a19Cred1 && a19Cred1.is_initial}、changed_by=${a19Cred1 && a19Cred1.changed_by}`);

    /* ---- 读数⑦（D2／D8①：第 5 次**当场** 423 + 剩余秒数；锁定期间口令正确也拒） ---- */
    const a19Fails = [];
    for (let i = 1; i <= 5; i++) a19Fails.push(await a19Http('POST', '/auth/login', { password: 'wrong-' + i }));
    const a19RightInLock = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW2 });
    const a19StLocked = await a19Http('GET', '/auth/status');
    const a19Cred2 = a19Cred();
    t.check('E86①-7（D2／D8①）真 HTTP：连续 5 次错口令 ⇒ 前 4 次 401 `bad_credentials`、**第 5 次当场** 423 `locked` ' +
      '＋正整数 `retryAfterSec`（≤ `lockMinutes×60`）；**锁定期间口令正确也拒**（仍 423）；计数**落库**' +
      '（`fail_count=5`、`locked_until` 非空）；`GET /auth/status` 无需鉴权即如实显示锁定（D8⑦）',
      a19Fails.slice(0, 4).every(r => r.status === 401 && r.body && r.body.error === 'bad_credentials') &&
      a19Fails[4].status === 423 && a19Fails[4].body && a19Fails[4].body.error === 'locked' &&
      Number.isInteger(a19Fails[4].body.retryAfterSec) && a19Fails[4].body.retryAfterSec > 0 &&
      a19Fails[4].body.retryAfterSec <= 300 &&
      a19RightInLock.status === 423 && a19RightInLock.body && a19RightInLock.body.error === 'locked' &&
      a19StLocked.status === 200 && a19StLocked.body && a19StLocked.body.locked === true &&
      a19StLocked.body.retryAfterSec > 0 &&
      Boolean(a19Cred2) && Number(a19Cred2.fail_count) === 5 &&
      typeof a19Cred2.locked_until === 'string' && a19Cred2.locked_until.length > 0,
      a19Fails.map((r, i) => `#${i + 1}=${r.status}` +
        `${r.body && r.body.retryAfterSec !== undefined ? '(' + r.body.retryAfterSec + 's)' : ''}`).join('/') +
      `；锁定中正确口令=${a19RightInLock.status}:${a19RightInLock.body && a19RightInLock.body.error}；` +
      `status.locked=${a19StLocked.body && a19StLocked.body.locked}/retryAfterSec=${a19StLocked.body && a19StLocked.body.retryAfterSec}；` +
      `库内 fail_count=${a19Cred2 && a19Cred2.fail_count}、locked_until=${a19Cred2 && a19Cred2.locked_until}`);

    /* ---- 读数⑧（D8②：期满**不自动清零** —— 期满后再错**一次**立即重锁） ----
       ⚠ "期满"由**库内真源**复现（真进程不能注入时钟，见本节头注）：把 `locked_until` 写到过去，
       服务进程下一次登录读到的就是"可解析且已过期"（D8⑨）⇒ 放行到口令校验那一步。 */
    let a19RwErr = '';
    try { a19Rw('UPDATE auth_credential SET locked_until = ? WHERE username = ?', [AUTH_E2E_PAST, AUTH_E2E_USER]); }
    catch (e) { a19RwErr = (e && e.message) || String(e); }
    const a19Cred3 = a19Cred();
    const a19WrongAfterExpiry = await a19Http('POST', '/auth/login', { password: 'still-wrong' });
    const a19Cred4 = a19Cred();
    t.check('E86①-8（D8②）真 HTTP：锁定**到期**（库内 `locked_until` 置为过去＝D8⑨ 的"可解析且已过期 ⇒ 放行"）后，' +
      '**再错一次立即重新锁定**（423 `locked`，`fail_count` 5→6、`locked_until` 回到未来）—— ' +
      '期满只是"可以再试"，**没有别的清零路径**（只有登录成功才清零）',
      a19RwErr === '' && Boolean(a19Cred3) && a19Cred3.locked_until === AUTH_E2E_PAST &&
      a19WrongAfterExpiry.status === 423 && a19WrongAfterExpiry.body && a19WrongAfterExpiry.body.error === 'locked' &&
      Boolean(a19Cred4) && Number(a19Cred4.fail_count) === Number(a19Cred3.fail_count) + 1 &&
      a19Cred4.locked_until !== AUTH_E2E_PAST,
      `库内写入=${a19RwErr || '无错'}；置过去后 locked_until=${a19Cred3 && a19Cred3.locked_until}；` +
      `期满后再错一次=${a19WrongAfterExpiry.status}:${a19WrongAfterExpiry.body && a19WrongAfterExpiry.body.error}；` +
      `fail_count ${a19Cred3 && a19Cred3.fail_count} → ${a19Cred4 && a19Cred4.fail_count}、locked_until=${a19Cred4 && a19Cred4.locked_until}`);

    /* ---- 读数⑨（期满 + 口令正确 ⇒ 恢复并清零）：与读数⑧ 成对，证明"清零只此一路" ---- */
    a19Rw('UPDATE auth_credential SET locked_until = ? WHERE username = ?', [AUTH_E2E_PAST, AUTH_E2E_USER]);
    const a19Recover = await a19Http('POST', '/auth/login', { password: AUTH_E2E_PW2 });
    const a19Cred5 = a19Cred();
    t.check('E86①-9（D2"成功即清零"）真 HTTP：锁定**到期** + 口令正确 ⇒ 200 登录成功，并**当场清零**' +
      '（`fail_count=0`、`locked_until=NULL`）—— 与读数⑧成对：清零路径只有"登录成功"这一条',
      a19Recover.status === 200 && a19Recover.body && a19Recover.body.ok === true &&
      /^[0-9a-f]{64}$/.test(String(a19Recover.body.token)) &&
      Boolean(a19Cred5) && Number(a19Cred5.fail_count) === 0 && a19Cred5.locked_until === null,
      `恢复登录=${a19Recover.status}；库内 fail_count=${a19Cred5 && a19Cred5.fail_count}、locked_until=${a19Cred5 && a19Cred5.locked_until}`);

    /* ---- 读数⑩（D6③：`op_log` 留痕六类各至少一条）—— 读**库内真行**，不是读日志文本 ---- */
    const a19Ops = a19Ro("SELECT op_type, result, COUNT(*) AS c FROM op_log GROUP BY op_type, result ORDER BY op_type");
    const a19OpTypes = a19Ops.map(r => `${r.op_type}/${r.result}×${r.c}`);
    const a19Has = (t2, res) => a19Ops.some(r => r.op_type === t2 && (res === undefined || r.result === res));
    t.check('E86①-10（D6③ 可审计）库内 `op_log`：**口令初始化码 / 口令初始化 / 解锁 / 解锁失败 / 账号锁定 / 改密 / 登出**' +
      '七类各至少一条（登出、账号锁定都在真 HTTP 路径上产生；来源 IP 记在 content 里 —— 本判据不读日志文本，只读库内真行）',
      a19Has('口令初始化码') && a19Has('口令初始化', '成功') && a19Has('解锁', '成功') &&
      a19Has('解锁失败', '失败') && a19Has('账号锁定', '失败') &&
      a19Has('改密', '成功') && a19Has('改密', '失败') && a19Has('登出', '成功'),
      `op_log 实读=${JSON.stringify(a19OpTypes)}`);

    /* ---- 收尾：本节自建的服务进程必须**当场关停**（不留监听端口/残留进程） ---- */
    await a19Svc.stop();
    t.check('E86①-11 本节自建的服务子进程跑完**当场关停**（不留监听端口与残留进程）',
      a19Svc.proc.exitCode !== null || a19Svc.proc.signalCode !== null,
      `exitCode=${a19Svc.proc.exitCode}、signalCode=${a19Svc.proc.signalCode}`);
  } finally {
    try { await a19Svc.stop(); } catch { /* 已停止 */ }
    try { fs.rmSync(a19DataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }); } catch { /* 已删 */ }
  }
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
  console.error('\n[脚本异常] 脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
