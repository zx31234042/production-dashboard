/**
 * endpoint-link-probe.js —— **P1-1（服务端）自证探针**（零依赖；临时库）
 *
 * 验 `server/services/endpointLink.js` ＋ `ifD.js` 接线（`FR-2.6`）：
 *   1 两个端点各来一帧 ⇒ **两条都在线**（`onlineCount=2`）
 *   2 只让端点 A 超时（推进注入时钟 > staleMs）⇒ **A 掉线、B 仍在线**（**单点掉线不报整套离线**）
 *   3 两个都超时 ⇒ `allOffline=true`（这才是"整套离线"）
 *   4 端点标识回退链（`endpointId`→`endpoint`→`unitId`→`equipCode`）＋ 无标识 ⇒ `(unknown)` 计数
 *   5 真 HTTP：两帧来自不同 `endpointId` ⇒ `endpointLink()` 里两条；拒收帧（无派工）**不**计入链路证据
 *
 * 运行：node tools\endpoint-link-probe.js ／ 退出 0 全过、1 有失败
 */
'use strict';

const http = require('node:http');
const { makeTempDb } = require('../tests/lib/harness.js');
const dbmod = require('../server/db/index.js');
const { mountIfD } = require('../server/http/routes/ifD.js');
const { createRouter } = require('../server/http/router.js');
const { resolveEndpointId, createEndpointLinkTracker } = require('../server/services/endpointLink.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}${detail ? ' —— ' + detail : ''}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`); }
};
const noopLogger = { info() { }, warn() { }, error() { }, debug() { } };

function dbWithTask() {
  const h = makeTempDb({ name: 'endpoint-link' });
  const o = dbmod.openDb(h.path, {});
  h.adopt(o.db);
  dbmod.initSchema(h.db, '2026-10-19 08:00:00');
  h.db.prepare('INSERT INTO task (proc_order_no,status,plan_start_time,plan_end_time,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('PO-A', '测试中', '2026-10-19 08:00:00', '2026-10-19 18:00:00', '2026-10-19 08:00:00', '2026-10-19 08:00:00');
  return h;
}
const frameOf = (endpointId, extra = {}) => Object.assign({
  equipCode: 'EQ-UC-001', procOrderNo: 'PO-A', collectTime: '2026-10-19 09:00:00', testStatus: 2,
  frameRate: 500, gain: 12.5, shutter: 800, cameraDepth: 4.5, depth: 4.8, speed: 5.0, velocityX: 2.1, velocityY: 2.41
}, endpointId === undefined ? {} : { endpointId }, extra);

function main() {
  console.log('\n=== P1-1（服务端）· 按端点链路状态 ===');

  /* 1–3 纯模块：注入时钟 */
  {
    let fake = new Date('2026-10-19T09:00:00');
    const tr = createEndpointLinkTracker({ now: () => fake, staleMs: 5000 });
    tr.record(frameOf('A'), new Date('2026-10-19T09:00:00'));
    tr.record(frameOf('B'), new Date('2026-10-19T09:00:00'));
    let s = tr.snapshot();
    ok('1 两端点各一帧 ⇒ 都在线（onlineCount=2）', s.total === 2 && s.onlineCount === 2, JSON.stringify({ total: s.total, online: s.onlineCount }));
    /* 只让 A 超时：B 再补一帧 */
    fake = new Date('2026-10-19T09:00:06');
    tr.record(frameOf('B'), new Date('2026-10-19T09:00:06'));
    s = tr.snapshot();
    const a = s.endpoints.find(e => e.endpointId === 'A');
    const b = s.endpoints.find(e => e.endpointId === 'B');
    ok('2 A 超时、B 在线（单点掉线不报整套）', a && !a.online && b && b.online && s.allOffline === false,
      `A.online=${a && a.online}｜B.online=${b && b.online}｜allOffline=${s.allOffline}`);
    fake = new Date('2026-10-19T09:00:30');
    s = tr.snapshot();
    ok('3 两端点都超时 ⇒ allOffline=true', s.allOffline === true && s.offlineCount === 2, `allOffline=${s.allOffline}`);
  }

  /* 4 标识回退链 */
  {
    ok('4a endpointId 优先', resolveEndpointId({ endpointId: 'E1', equipCode: 'EQ' }) === 'E1');
    ok('4b 回退 endpoint', resolveEndpointId({ endpoint: 'E2', equipCode: 'EQ' }) === 'E2');
    ok('4c 回退 unitId', resolveEndpointId({ unitId: 7, equipCode: 'EQ' }) === '7');
    ok('4d 回退 equipCode', resolveEndpointId({ equipCode: 'EQ' }) === 'EQ');
    ok('4e 全无 ⇒ (unknown)', resolveEndpointId({}) === '(unknown)');
  }

  /* 5 真 HTTP（两帧不同端点 + 一帧拒收） */
  {
    const h = dbWithTask();
    const now = () => new Date('2026-10-19T09:00:00');
    const router = createRouter({ getHealth: () => ({ ok: true }), onError: () => { } });
    const mount = mountIfD(router, { db: h.db, now, logger: noopLogger });
    const srv = http.createServer((req, res) => {
      Promise.resolve(router.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
    });
    const post = (body) => fetch(`http://127.0.0.1:${srv.address().port}/ifd/frame`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    srv.listen(0, '127.0.0.1', async () => {
      try {
        const r1 = await post(frameOf('END-1'));
        const r2 = await post(frameOf('END-2', { collectTime: '2026-10-19 09:00:01' }));
        const r3 = await post(frameOf('END-3', { collectTime: '2026-10-19 09:00:02', testStatus: 9 }));
        const s = mount.endpointLink();
        ok('5 两帧不同端点 ⇒ 两条且在线上；拒收帧不计入',
          r1.status === 200 && r2.status === 200 && r3.status === 400 &&
          s.total === 2 && s.onlineCount === 2 && !s.endpoints.some(e => e.endpointId === 'END-3'),
          `statuses=${r1.status}/${r2.status}/${r3.status}｜total=${s.total}｜online=${s.onlineCount}｜ids=${s.endpoints.map(e => e.endpointId).join(',')}`);
      } catch (e) {
        ok('5 真 HTTP 异常', false, e && e.message);
      } finally {
        await new Promise(r => srv.close(r));
        h.close();
        console.log(`\n=== 汇总 ===\n通过 ${pass} 项，失败 ${fail} 项`);
        process.exit(fail ? 1 : 0);
      }
    });
  }
}

main();
