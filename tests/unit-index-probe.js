/**
 * unit-index-probe.js —— **P0-4 自证探针**（零依赖；临时库）
 *
 * 验 `server/services/unitIndexInfer.js` ＋ `ifD.js` 的接入口径（V1.45 第 6 处／`DR-04`）：
 *   1 待机帧（testStatus=0）⇒ 不构成一件（unitIndex=null）
 *   2 0 → 1（测试中）⇒ 新一件：1
 *   3 周期内（连续 1）⇒ 仍是第 1 件
 *   4 1 → 2（完成）⇒ 归属第 1 件
 *   5 2 → 1 ⇒ 第 2 件（新周期）
 *   6 重启安全：新推断器实例（内存边沿丢失）⇒ 仍从库里 max+1 得 3（不是回到 1）
 *   7 帧自带合法件序号 ⇒ 放行（不覆盖）
 *   8 真 HTTP：测试中帧（不带 unitIndex）⇒ 200，库里 unit_index 被写为推断值
 *
 * 运行：node tests\unit-index-probe.js ／ 退出 0 全过、1 有失败
 */
'use strict';
require('./env').assertRuntime();          /* tests\*.js 入口必须自校验（files-check 第八节） */

const http = require('node:http');
const { makeTempDb } = require('./lib/harness.js');
const dbmod = require('../server/db/index.js');
const { createIngest } = require('../server/services/ingest.js');
const { mountIfD } = require('../server/http/routes/ifD.js');
const { createRouter } = require('../server/http/router.js');
const { createUnitIndexInferrer } = require('../server/services/unitIndexInfer.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}${detail ? ' —— ' + detail : ''}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`); }
};
const noopLogger = { info() { }, warn() { }, error() { }, debug() { } };
const now = () => new Date('2026-10-19T09:00:00');

/** 一帧（默认不带 unitIndex） */
const frame = (procOrderNo, testStatus, extra = {}) => Object.assign({
  equipCode: 'EQ-UC-001', procOrderNo, collectTime: '2026-10-19 09:00:00',
  testStatus, frameRate: 500, gain: 12.5, shutter: 800,
  cameraDepth: 4.5, depth: 4.8, speed: 5.0, velocityX: 2.1, velocityY: 2.41
}, extra);

function dbWithTask() {
  const h = makeTempDb({ name: 'unit-index' });
  const o = dbmod.openDb(h.path, {});
  h.adopt(o.db);
  dbmod.initSchema(h.db, '2026-10-19 08:00:00');
  h.db.prepare('INSERT INTO task (proc_order_no,status,plan_start_time,plan_end_time,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('PO-A', '测试中', '2026-10-19 08:00:00', '2026-10-19 18:00:00', '2026-10-19 08:00:00', '2026-10-19 08:00:00');
  return h;
}
const lastUnitIndex = (db) => {
  const r = db.prepare('SELECT unit_index FROM measure_rt ORDER BY rowid DESC LIMIT 1').get();
  return r ? r.unit_index : undefined;
};
const countRows = (db) => db.prepare('SELECT COUNT(*) AS n FROM measure_rt').get().n;

function main() {
  console.log('\n=== P0-4 · 件序号按测试周期生成（unitIndexInfer ＋ ifD 接线） ===');
  const h = dbWithTask();
  /* **真实写入路径**：落库一律走 ingestFrame（避免手写列名与 schema 漂移） */
  const ingest = createIngest({ db: h.db, now, logger: noopLogger });
  const store = (f) => ingest.ingestFrame(f);

  /* 1–5：一个"两件"的完整周期 */
  const a = createUnitIndexInferrer({ db: h.db, now });
  {
    const r0 = a.infer(frame('PO-A', 0));
    ok('1 待机（0）⇒ 不构成一件', r0.unitIndex === null, `unitIndex=${r0.unitIndex}｜${r0.reason}`);

    const f1 = frame('PO-A', 1);
    const r1 = a.infer(f1);
    ok('2 0→1 ⇒ 新一件：1', r1.unitIndex === 1, `unitIndex=${r1.unitIndex}｜${r1.reason}`);
    store(Object.assign({}, f1, { unitIndex: r1.unitIndex }));

    const r1b = a.infer(frame('PO-A', 1, { collectTime: '2026-10-19 09:00:01' }));
    ok('3 周期内连续 1 ⇒ 仍是第 1 件', r1b.unitIndex === 1, `unitIndex=${r1b.unitIndex}｜${r1b.reason}`);

    const r2 = a.infer(frame('PO-A', 2, { collectTime: '2026-10-19 09:00:02' }));
    ok('4 1→2（完成）⇒ 归属第 1 件', r2.unitIndex === 1, `unitIndex=${r2.unitIndex}｜${r2.reason}`);

    const r3 = a.infer(frame('PO-A', 1, { collectTime: '2026-10-19 09:00:03' }));
    ok('5 2→1 ⇒ 第 2 件', r3.unitIndex === 2, `unitIndex=${r3.unitIndex}｜${r3.reason}`);
    store(Object.assign({}, frame('PO-A', 1, { collectTime: '2026-10-19 09:00:03' }), { unitIndex: r3.unitIndex }));
  }

  /* 6：重启安全（新实例 ⇒ 库里 max+1） */
  {
    const b = createUnitIndexInferrer({ db: h.db, now });
    const r = b.infer(frame('PO-A', 1, { collectTime: '2026-10-19 09:00:04' }));
    ok('6 重启后（新实例）⇒ 库里 max+1 = 3', r.unitIndex === 3, `unitIndex=${r.unitIndex}｜${r.reason}`);
  }

  /* 7：帧自带 ⇒ 放行 */
  {
    const c = createUnitIndexInferrer({ db: h.db, now });
    const r = c.infer(frame('PO-A', 1, { unitIndex: 9 }));
    ok('7 帧自带 9 ⇒ 原样放行（不覆盖）', r.unitIndex === 9 && r.source === 'frame', `unitIndex=${r.unitIndex}｜source=${r.source}`);
  }

  /* 8：真 HTTP */
  {
    const router = createRouter({ getHealth: () => ({ ok: true }), onError: () => { } });
    const mount = mountIfD(router, { db: h.db, now, logger: noopLogger });
    const srv = http.createServer((req, res) => {
      Promise.resolve(router.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
    });
    srv.listen(0, '127.0.0.1', async () => {
      try {
        const before = countRows(h.db);
        const res = await fetch(`http://127.0.0.1:${srv.address().port}/ifd/frame`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(frame('PO-A', 1, { collectTime: '2026-10-19 09:00:05' }))
        });
        const body = await res.json();
        const ui = lastUnitIndex(h.db);
        ok('8 真 HTTP：测试中帧不带件号 ⇒ 200 且库里写入推断件号',
          res.status === 200 && body.outcome === 'stored' && ui === 3,
          `status=${res.status}｜outcome=${body.outcome}｜unit_index=${ui}（期望 3＝库中 max 2 ＋ 1；⑥ 推断出的 3 未落库）｜行数 ${before}→${countRows(h.db)}`);
        const inf = mount.unitIndexInference();
        ok('8b 推断计数（inferred ≥1）', inf.counts.inferred >= 1, JSON.stringify(inf.counts));
      } catch (e) {
        ok('8 真 HTTP 异常', false, e && e.message);
      } finally {
        await new Promise(r => srv.close(r));
        h.close();
        console.log(`\n=== 汇总 ===\n通过 ${pass} 项，失败 ${fail} 项`);
        process.exit(fail ? 1 : 0);
      }
    });
  }
}
try {
  main();
} catch (err) {
  console.error('\n[脚本异常] 脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
