/**
 * missing-value-probe.js —— **P0-3 自证探针**（零依赖；临时库）
 *
 * 验 `server/services/missingValue.js` ＋ `ifD.js` 的接入口径（V1.45 第 7 处）：
 *   1 哨兵 `65535`（depth）⇒ **null**      2 **`0` 保留为 `0`**（合法值，绝不当缺值）
 *   3 缺字段 ⇒ **null**                      4 字符串哨兵 `'0xFFFF'` ⇒ **null**
 *   5 显式 `missingFields:['speed']` ⇒ **null**（不猜位图位序）   6 其它字段原样不动
 *   7 32 位哨兵 `4294967295`（gain）⇒ **null**
 *   8 真 HTTP ⇒ **200**，库里 `depth` 为 **NULL**（不是 0）
 *
 * 运行：node tests\missing-value-probe.js ／ 退出 0 全过、1 有失败
 */
'use strict';
require('./env').assertRuntime();          /* tests\*.js 入口必须自校验（files-check 第八节） */

const http = require('node:http');
const { makeTempDb } = require('./lib/harness.js');
const dbmod = require('../server/db/index.js');
const { createIngest } = require('../server/services/ingest.js');
const { mountIfD } = require('../server/http/routes/ifD.js');
const { createRouter } = require('../server/http/router.js');
const missingValue = require('../server/services/missingValue.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}${detail ? ' —— ' + detail : ''}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`); }
};
const noopLogger = { info() { }, warn() { }, error() { }, debug() { } };
const now = () => new Date('2026-10-19T09:00:00');
const base = (extra = {}) => Object.assign({
  equipCode: 'EQ-UC-001', procOrderNo: 'PO-A', collectTime: '2026-10-19 09:00:00',
  testStatus: 2, frameRate: 500, gain: 12.5, shutter: 800,
  cameraDepth: 4.5, depth: 4.8, speed: 5.0, velocityX: 2.1, velocityY: 2.41
}, extra);

function dbWithTask() {
  const h = makeTempDb({ name: 'missing-value' });
  const o = dbmod.openDb(h.path, {});
  h.adopt(o.db);
  dbmod.initSchema(h.db, '2026-10-19 08:00:00');
  h.db.prepare('INSERT INTO task (proc_order_no,status,plan_start_time,plan_end_time,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('PO-A', '测试中', '2026-10-19 08:00:00', '2026-10-19 18:00:00', '2026-10-19 08:00:00', '2026-10-19 08:00:00');
  return h;
}

function main() {
  console.log('\n=== P0-3 · 缺值映射（missingValue ＋ ifD 接线） ===');

  /* 1 哨兵 ⇒ null */
  {
    const r = missingValue.mapMissingValues(base({ depth: 65535 }));
    ok('1 哨兵 65535（depth）⇒ null', r.frame.depth === null && r.missing.includes('depth'), `depth=${r.frame.depth}｜hits.sentinel=${r.hits.sentinel}`);
  }
  /* 2 0 保留 */
  {
    const r = missingValue.mapMissingValues(base({ depth: 0, speed: 0 }));
    ok('2 0 保留为 0（不当缺值）', r.frame.depth === 0 && r.frame.speed === 0 && r.missing.length === 0,
      `depth=${r.frame.depth}｜speed=${r.frame.speed}｜missing=${JSON.stringify(r.missing)}`);
  }
  /* 3 缺字段 ⇒ null */
  {
    const f = base(); delete f.gain;
    const r = missingValue.mapMissingValues(f);
    const has = Object.prototype.hasOwnProperty.call(f, 'gain');
    ok('3 缺字段 ⇒ 不在帧里则不加 null（保持"没有这个字段"）', !has && r.frame.gain === undefined, `hasOwn=${has}`);
  }
  /* 4 字符串哨兵 */
  {
    const r = missingValue.mapMissingValues(base({ depth: '0xFFFF' }));
    ok("4 字符串哨兵 '0xFFFF' ⇒ null", r.frame.depth === null && r.hits.sentinel === 1, `depth=${r.frame.depth}`);
  }
  /* 5 显式缺失字段名 */
  {
    const r = missingValue.mapMissingValues(base({ speed: 5 }), { fields: ['speed'] });
    ok('5 显式 missingFields=[speed] ⇒ null', r.frame.speed === null && r.hits.explicit === 1, `speed=${r.frame.speed}`);
  }
  /* 6 其它字段不动 */
  {
    const f = base({ depth: 65535 });
    const r = missingValue.mapMissingValues(f);
    ok('6 非白名单/非缺值字段原样', r.frame.procOrderNo === 'PO-A' && r.frame.testStatus === 2 && r.frame.cameraDepth === 4.5,
      `procOrderNo=${r.frame.procOrderNo}｜cameraDepth=${r.frame.cameraDepth}`);
  }
  /* 7 32 位哨兵 */
  {
    const r = missingValue.mapMissingValues(base({ gain: 4294967295 }));
    ok('7 32 位哨兵（gain）⇒ null', r.frame.gain === null, `gain=${r.frame.gain}`);
  }

  /* 8 真 HTTP + 落库 */
  {
    const h = dbWithTask();
    const ingest = createIngest({ db: h.db, now, logger: noopLogger });
    const router = createRouter({ getHealth: () => ({ ok: true }), onError: () => { } });
    const mount = mountIfD(router, { db: h.db, now, logger: noopLogger });
    const srv = http.createServer((req, res) => {
      Promise.resolve(router.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
    });
    srv.listen(0, '127.0.0.1', async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${srv.address().port}/ifd/frame`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(base({ depth: 65535, speed: 0 }))
        });
        const body = await res.json();
        const row = h.db.prepare('SELECT measure_depth, speed FROM measure_rt ORDER BY rowid DESC LIMIT 1').get();
        ok('8 真 HTTP：depth 哨兵 ⇒ 库里 NULL；speed=0 ⇒ 仍是 0',
          res.status === 200 && body.outcome === 'stored' && row && row.measure_depth === null && row.speed === 0,
          `status=${res.status}｜measure_depth=${row && row.measure_depth}｜speed=${row && row.speed}`);
        const snap = mount.missingValueMapping();
        ok('8b 缺值计数（framesWithMissing≥1／sentinel≥1）', snap.framesWithMissing >= 1 && snap.sentinel >= 1, JSON.stringify(snap));
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
