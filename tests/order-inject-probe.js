/**
 * order-inject-probe.js —— **P0-1 自证探针**（零依赖；只读契约 + 临时库，不碰真实库）
 *
 * 验的是 `server/services/orderResolver.js` ＋ `server/http/routes/ifD.js` 的注入口径：
 *   ①帧自带 `procOrderNo` ⇒ **原样放行**（passthrough，不覆盖）
 *   ②帧不带、且 `IF-A` 派工**在生效窗口内** ⇒ **注入成功**，且 `ingestFrame()` **落库成功**
 *   ③帧不带、且**窗口外** ⇒ **不落库**（rejected，`OUT_OF_WINDOW`），计数 +1
 *   ④**无任何派工**（task 空表） ⇒ 不落库（`NO_ACTIVE_ORDER`），计数 +1
 *   ⑤**有派工但缺时间窗** ⇒ 不落库（`NO_WINDOW`，**不猜**）
 *   ⑥HTTP 面（`mountIfD` + 真 `http` 路由）：带 `task` 时不带 `procOrderNo` 的帧 ⇒ **200 + injected**；
 *      窗口外 ⇒ **400 + `OUT_OF_WINDOW`**
 *
 * 运行：node tests\order-inject-probe.js
 * 退出：0 全过／1 有失败
 */
'use strict';
require('./env').assertRuntime();          /* tests\*.js 入口必须自校验（files-check 第八节） */

const path = require('node:path');
const http = require('node:http');
const { makeTempDb } = require('./lib/harness.js');
const dbmod = require('../server/db/index.js');
const { createIngest } = require('../server/services/ingest.js');
const { mountIfD } = require('../server/http/routes/ifD.js');
const { createRouter } = require('../server/http/router.js');
const orderResolver = require('../server/services/orderResolver.js');

let pass = 0, fail = 0;
/** 完整 logger 桩：services/ingest.js 会调 logger.info（只给 warn 会 500 ⇒ 探针自身坑，已踩过） */
const noopLogger = { info() { }, warn() { }, error() { }, debug() { } };
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}${detail ? ' —— ' + detail : ''}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`); }
};

/** 一帧合法样本（`collectTime` 取固定值，便于断言去重/落库） */
const frameOf = (extra = {}) => Object.assign({
  equipCode: 'EQ-UC-001', collectTime: '2026-10-19 09:00:00',
  testStatus: 2, frameRate: 500, gain: 12.5, shutter: 800,
  cameraDepth: 4.5, depth: 4.8, speed: 5.0, velocityX: 2.1, velocityY: 2.41
}, extra);

function dbWithTasks(tasks) {
  const handle = makeTempDb({ name: 'order-inject' });
  const opened = dbmod.openDb(handle.path, {});
  handle.adopt(opened.db);
  dbmod.initSchema(handle.db, '2026-10-19 09:00:00');
  const ins = handle.db.prepare(
    'INSERT INTO task (proc_order_no, status, plan_start_time, plan_end_time, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const t of tasks) {
    ins.run(t.procOrderNo, t.status || '测试中', t.planStartTime || null, t.planEndTime || null,
      '2026-10-19 08:00:00', '2026-10-19 08:00:00');
  }
  return handle;
}

function main() {
  console.log('\n=== P0-1 · procOrderNo 接收侧注入（orderResolver ＋ ifD 接线） ===');

  /* ① 帧自带 ⇒ 放行，不覆盖 */
  {
    const h = dbWithTasks([{ procOrderNo: 'PO-A', planStartTime: '2026-10-19 08:00:00', planEndTime: '2026-10-19 18:00:00' }]);
    const r = orderResolver.injectOrderIntoFrame(h.db, frameOf({ procOrderNo: 'PO-FRAME' }), { at: '2026-10-19 09:00:00' });
    ok('① 帧自带 procOrderNo ⇒ 原样放行', r.ok && r.source === 'frame' && r.frame.procOrderNo === 'PO-FRAME', `source=${r.source}`);
    h.close();
  }

  /* ② 注入成功 ＋ ingestFrame 真落库 */
  {
    const h = dbWithTasks([{ procOrderNo: 'PO-A', planStartTime: '2026-10-19 08:00:00', planEndTime: '2026-10-19 18:00:00' }]);
    const ingest = createIngest({ db: h.db, now: () => new Date('2026-10-19T09:00:00') });
    const inj = orderResolver.injectOrderIntoFrame(h.db, frameOf(), { at: '2026-10-19 09:00:00' });
    ok('② 窗口内 ⇒ 注入成功', inj.ok && inj.source === 'injected' && inj.frame.procOrderNo === 'PO-A', `procOrderNo=${inj.procOrderNo || '-'}`);
    if (inj.ok) {
      const res = ingest.ingestFrame(inj.frame);
      const n = h.db.prepare('SELECT COUNT(*) AS n FROM measure_rt').get().n;
      ok('②b 注入后 ingestFrame 落库', res.outcome === 'stored' && n === 1, `outcome=${res.outcome}｜measure_rt=${n}`);
    } else { ok('②b 注入后 ingestFrame 落库', false, '注入未成功，跳过'); }
    h.close();
  }

  /* ③ 窗口外 ⇒ 拒收 OUT_OF_WINDOW（不落库） */
  {
    const h = dbWithTasks([{ procOrderNo: 'PO-A', planStartTime: '2026-10-19 08:00:00', planEndTime: '2026-10-19 10:00:00' }]);
    const r = orderResolver.injectOrderIntoFrame(h.db, frameOf(), { at: '2026-10-19 12:00:00' });
    ok('③ 窗口外 ⇒ OUT_OF_WINDOW', !r.ok && r.code === orderResolver.INJECT_REJECT.OUT_OF_WINDOW, `code=${r.code || '-'}`);
    h.close();
  }

  /* ④ 无派工 ⇒ NO_ACTIVE_ORDER */
  {
    const h = dbWithTasks([]);
    const r = orderResolver.injectOrderIntoFrame(h.db, frameOf(), { at: '2026-10-19 09:00:00' });
    ok('④ 无派工 ⇒ NO_ACTIVE_ORDER', !r.ok && r.code === orderResolver.INJECT_REJECT.NO_ACTIVE_ORDER, `code=${r.code || '-'}`);
    h.close();
  }

  /* ⑤ 有派工但缺窗口 ⇒ NO_WINDOW（不猜） */
  {
    const h = dbWithTasks([{ procOrderNo: 'PO-A' }]);
    const r = orderResolver.injectOrderIntoFrame(h.db, frameOf(), { at: '2026-10-19 09:00:00' });
    ok('⑤ 缺时间窗 ⇒ NO_WINDOW（不猜）', !r.ok && r.code === orderResolver.INJECT_REJECT.NO_WINDOW, `code=${r.code || '-'}`);
    h.close();
  }

  /* ⑥ HTTP 面（进程内临时端口；范式照 tests\db-check.js 的既有做法）：
        A 挂载（now=09:00 在窗口内）⇒ 不带 procOrderNo 的帧 **200 + stored（已注入）**；
        B 挂载（now=12:00 在窗口外）⇒ **400 + OUT_OF_WINDOW**；计数按**每个挂载**各自累积。 */
  {
    const h = dbWithTasks([{ procOrderNo: 'PO-A', planStartTime: '2026-10-19 08:00:00', planEndTime: '2026-10-19 10:00:00' }]);
    const routeErrs = [];
    const mkRouter = () => createRouter({ getHealth: () => ({ ok: true }), onError: (e) => { routeErrs.push(String(e && e.message)); } });
    const routeA = mkRouter();
    const mountA = mountIfD(routeA, { db: h.db, now: () => new Date('2026-10-19T09:00:00'), logger: noopLogger });
    const routeB = mkRouter();
    const mountB = mountIfD(routeB, { db: h.db, now: () => new Date('2026-10-19T12:00:00'), logger: noopLogger });
    const serve = (r) => new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        Promise.resolve(r.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const post = (srv, body) => fetch(`http://127.0.0.1:${srv.address().port}/ifd/frame`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    (async () => {
      const srvA = await serve(routeA);
      const srvB = await serve(routeB);
      const r1 = await post(srvA, frameOf());
      ok('⑥a HTTP 不带 procOrderNo（窗口内）⇒ 200 且注入',
        r1.status === 200 && r1.body.outcome === 'stored', `status=${r1.status}｜outcome=${r1.body.outcome}`);
      const snapA = mountA.orderInjection();
      ok('⑥b 挂载 A 计数 injected=1／OUT_OF_WINDOW=0',
        snapA.injected === 1 && snapA.OUT_OF_WINDOW === 0,
        `injected=${snapA.injected}｜OUT_OF_WINDOW=${snapA.OUT_OF_WINDOW}`);
      const r2 = await post(srvB, frameOf());
      ok('⑥c HTTP 窗口外（B 挂载 now=12:00）⇒ 400 + OUT_OF_WINDOW',
        r2.status === 400 && r2.body.err && r2.body.err.code === 'OUT_OF_WINDOW',
        `status=${r2.status}｜code=${r2.body.err && r2.body.err.code}`);
      const snapB = mountB.orderInjection();
      ok('⑥d 挂载 B 计数 OUT_OF_WINDOW=1 且 lastReject 有值',
        snapB.OUT_OF_WINDOW === 1 && snapB.lastReject && snapB.lastReject.code === 'OUT_OF_WINDOW',
        `OUT_OF_WINDOW=${snapB.OUT_OF_WINDOW}｜lastReject=${snapB.lastReject ? snapB.lastReject.code : 'null'}`);
      await new Promise(r => srvA.close(r));
      await new Promise(r => srvB.close(r));
      h.close();
      console.log(`\n=== 汇总 ===\n通过 ${pass} 项，失败 ${fail} 项`);
      process.exit(fail ? 1 : 0);
    })().catch((e) => {
      ok('⑥ HTTP 面异常', false, e && e.message);
      try { h.close(); } catch { /* ignore */ }
      console.log(`\n=== 汇总 ===\n通过 ${pass} 项，失败 ${fail} 项`);
      process.exit(1);
    });
  }
}
try {
  main();
} catch (err) {
  console.error('\n[脚本异常] 脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
