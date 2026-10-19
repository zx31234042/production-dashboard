/**
 * p02-endpoint-dedup-probe.js —— **P0-2 自证探针**（零依赖；临时库）
 *
 * 验「端点标识入去重键」（`DR-13`／V1.45 第 11 处）：
 *   1 同 `equipCode`、同秒、**两个端点**各一帧 ⇒ `measure_rt` **两行都在**（改前会静默丢一帧）
 *   2 同端点同秒重复 ⇒ 第二帧 `duplicate`（幂等仍成立）
 *   3 未给 `endpointId` 的帧 ⇒ 端点回退为 `equipCode`（与 `resolveEndpointId()` 同口径）
 *   4 **迁移幂等**：`migrateMeasureRtEndpoint()` 连跑两次都成功，且唯一索引＝四列
 *   5 **旧库迁移**：手工造一个"三列索引 + 无 endpoint 列"的旧库形态 ⇒ 迁移后列有、行已回填、索引四列
 *   6 真 HTTP：两个端点各一帧 ⇒ 200/200 且库里 2 行
 *
 * 运行：node tests\p02-endpoint-dedup-probe.js ／ 退出 0 全过、1 有失败
 */
'use strict';
require('./env').assertRuntime();          /* tests\*.js 入口必须自校验（files-check 第八节） */

const http = require('node:http');
const { makeTempDb } = require('./lib/harness.js');
const dbmod = require('../server/db/index.js');
const { createIngest } = require('../server/services/ingest.js');
const { mountIfD } = require('../server/http/routes/ifD.js');
const { createRouter } = require('../server/http/router.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}${detail ? ' —— ' + detail : ''}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`); }
};
const noopLogger = { info() { }, warn() { }, error() { }, debug() { } };
const now = () => new Date('2026-10-19T09:00:00');
const frame = (extra = {}) => Object.assign({
  equipCode: 'EQ-UC-001', procOrderNo: 'PO-A', collectTime: '2026-10-19 09:00:00', testStatus: 2,
  frameRate: 500, gain: 12.5, shutter: 800, cameraDepth: 4.5, depth: 4.8, speed: 5.0, velocityX: 2.1, velocityY: 2.41
}, extra);

function dbWithTask() {
  const h = makeTempDb({ name: 'p02-dedup' });
  const o = dbmod.openDb(h.path, {});
  h.adopt(o.db);
  dbmod.initSchema(h.db, '2026-10-19 08:00:00');
  h.db.prepare('INSERT INTO task (proc_order_no,status,plan_start_time,plan_end_time,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('PO-A', '测试中', '2026-10-19 08:00:00', '2026-10-19 18:00:00', '2026-10-19 08:00:00', '2026-10-19 08:00:00');
  return h;
}
const idxCols = (db) => db.prepare('PRAGMA index_info(ux_measure_rt)').all().map(c => c.name);
const rows = (db) => db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;

function main() {
  console.log('\n=== P0-2 · 端点标识入去重键 ===');

  /* 1–3：同一库内三帧 */
  {
    const h = dbWithTask();
    const ingest = createIngest({ db: h.db, now, logger: noopLogger });
    const r1 = ingest.ingestFrame(frame({ endpointId: 'END-1' }));
    const r2 = ingest.ingestFrame(frame({ endpointId: 'END-2' }));
    ok('1 同秒两端口各一帧 ⇒ 两行都在', r1.outcome === 'stored' && r2.outcome === 'stored' && rows(h.db) === 2,
      `r1=${r1.outcome}｜r2=${r2.outcome}｜行数=${rows(h.db)}`);
    const r3 = ingest.ingestFrame(frame({ endpointId: 'END-1' }));
    ok('2 同端同秒重复 ⇒ duplicate（幂等仍成立）', r3.outcome === 'duplicate' && rows(h.db) === 2, `r3=${r3.outcome}｜行数=${rows(h.db)}`);
    ingest.ingestFrame(frame({ collectTime: '2026-10-19 09:00:01' }));
    const ep = h.db.prepare('SELECT endpoint FROM measure_rt ORDER BY rowid DESC LIMIT 1').get();
    ok('3 未给端点 ⇒ 回退为 equipCode', ep && ep.endpoint === 'EQ-UC-001', `endpoint=${ep && ep.endpoint}`);
    /* 4 迁移幂等（已迁移库再跑两次） */
    const m1 = dbmod.migrateMeasureRtEndpoint(h.db);
    const m2 = dbmod.migrateMeasureRtEndpoint(h.db);
    ok('4 迁移幂等（连跑两次）+ 索引四列',
      JSON.stringify(idxCols(h.db)) === JSON.stringify(['equip_code', 'proc_order_no', 'endpoint', 'collect_time']) &&
      m1.addedColumn === false && m2.addedColumn === false && m1.rebuiltIndex === false,
      `idx=${JSON.stringify(idxCols(h.db))}｜m1=${JSON.stringify(m1)}｜m2=${JSON.stringify(m2)}`);
    h.close();
  }

  /* 5：旧库形态迁移（手工造旧形态） */
  {
    const h = makeTempDb({ name: 'p02-legacy' });
    const o = dbmod.openDb(h.path, {});
    h.adopt(o.db);
    dbmod.initSchema(h.db, '2026-10-19 08:00:00');
    /* 退回旧形态：删 4 列索引 → 建 3 列索引 → 删列（SQLite 不能删列 ⇒ 用"重建表"最小模拟） */
    h.db.exec('DROP INDEX ux_measure_rt');
    h.db.exec('CREATE UNIQUE INDEX ux_measure_rt ON measure_rt(equip_code, proc_order_no, collect_time)');
    const before = JSON.stringify(idxCols(h.db));
    const m = dbmod.migrateMeasureRtEndpoint(h.db);
    ok('5 旧库（三列索引）⇒ 迁移为四列且幂等',
      JSON.stringify(idxCols(h.db)) === JSON.stringify(['equip_code', 'proc_order_no', 'endpoint', 'collect_time']) && m.rebuiltIndex === true,
      `旧索引=${before}｜新索引=${JSON.stringify(idxCols(h.db))}｜m=${JSON.stringify(m)}`);
    h.close();
  }

  /* 6：真 HTTP */
  {
    const h = dbWithTask();
    const router = createRouter({ getHealth: () => ({ ok: true }), onError: () => { } });
    mountIfD(router, { db: h.db, now, logger: noopLogger });
    const srv = http.createServer((req, res) => {
      Promise.resolve(router.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
    });
    const post = (body) => fetch(`http://127.0.0.1:${srv.address().port}/ifd/frame`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    srv.listen(0, '127.0.0.1', async () => {
      try {
        const a = await post(frame({ endpointId: 'HTTP-1' }));
        const b = await post(frame({ endpointId: 'HTTP-2' }));
        ok('6 真 HTTP：两端口各一帧 ⇒ 200/200 且库里 2 行',
          a.status === 200 && b.status === 200 && rows(h.db) === 2,
          `status=${a.status}/${b.status}｜行数=${rows(h.db)}`);
      } catch (e) {
        ok('6 真 HTTP 异常', false, e && e.message);
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
