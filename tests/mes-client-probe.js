/**
 * mes-client-probe.js —— **A4 自证探针**（零依赖；本地假 MES，不连真实环境）
 *
 * 验 `server/services/mesClient.js`：
 *   1 URL 模板拼接（`{base}/service/{service}/{method}`，含编码）
 *   2 形态 A 成功（`errcode:1`）⇒ `ok`
 *   3 形态 B 成功（`status:true`）⇒ `ok`
 *   4 形态 B 成功（`status:200`）⇒ `ok`
 *   5 业务失败 `errcode:-1` ⇒ `biz-fail` 且带 `resultMsg`
 *   6 业务失败 `status:false` ⇒ `biz-fail` 且带 `msg`
 *   7 HTTP 500 ⇒ `http-fail`
 *   8 不可识别响应（`{foo:1}`）⇒ **`bad-response`**（**绝不猜成功**）
 *   9 非 JSON 响应 ⇒ `bad-response`
 *  10 超时（服务端 sleep > timeoutMs）⇒ `timeout`
 *  11 计数快照（calls/ok/bizFail/httpFail/badResponse/timeout）
 *
 * 运行：node tests\mes-client-probe.js ／ 退出 0 全过、1 有失败
 */
'use strict';

require('./env').assertRuntime();
const http = require('node:http');
const { OUTCOME, createMesClient } = require('../server/services/mesClient.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}${detail ? ' —— ' + detail : ''}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`); }
};
const now = () => new Date('2026-10-20T10:00:00');

function main() {
  console.log('\n=== A4 · MES 接口传输层（mesClient） ===');

  /* 1 URL 模板 */
  {
    const c = createMesClient({ baseUrl: 'http://h:18000/fxzg-be', now });
    ok('1 URL 模板拼接', c.urlOf('S_ME_MG_0001', 'reportWork') === 'http://h:18000/fxzg-be/service/S_ME_MG_0001/reportWork', c.urlOf('S_ME_MG_0001', 'reportWork'));
    const c2 = createMesClient({ protocol: 'http', host: 'h', port: 18000, context: 'fxzg-be', now });
    ok('1b 分片参数拼 baseUrl', c2.baseUrl() === 'http://h:18000/fxzg-be', c2.baseUrl());
  }

  /* 2–11 假 MES */
  const srv = http.createServer((req, res) => {
    const send = (code, obj, raw) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(raw === undefined ? JSON.stringify(obj) : raw); };
    if (req.url.endsWith('/slow')) { setTimeout(() => send(200, { errcode: 1 }), 400); return; }
    if (req.url.endsWith('/raw')) { send(200, null, 'not-json'); return; }
    if (req.url.endsWith('/A-ok')) { send(200, { errcode: 1, resultMsg: '成功' }); return; }
    if (req.url.endsWith('/B-ok')) { send(200, { status: true, msg: 'ok', data: { id: 1 } }); return; }
    if (req.url.endsWith('/B-200')) { send(200, { status: 200, msg: 'ok' }); return; }
    if (req.url.endsWith('/A-fail')) { send(200, { errcode: -1, resultMsg: '工单不存在' }); return; }
    if (req.url.endsWith('/B-fail')) { send(200, { status: false, msg: '参数错误' }); return; }
    if (req.url.endsWith('/http500')) { send(500, { errcode: -1 }, 'boom'); return; }
    if (req.url.endsWith('/unknown')) { send(200, { foo: 1 }); return; }
    send(404, { errcode: -1 });
  });

  srv.listen(0, '127.0.0.1', async () => {
    const port = srv.address().port;
    const c = createMesClient({ host: '127.0.0.1', port, context: 'fxzg-be', timeoutMs: 150, now });
    try {
      const a = await c.call('S_ME_MG_0001', 'A-ok', { x: 1 });
      ok('2 形态 A 成功（errcode:1）⇒ ok', a.outcome === OUTCOME.OK && a.httpStatus === 200, `outcome=${a.outcome}｜msg=${a.message}`);
      const b = await c.call('S_ME_MG_0001', 'B-ok', {});
      ok('3 形态 B 成功（status:true）⇒ ok 且带 data', b.outcome === OUTCOME.OK && b.data && b.data.id === 1, `outcome=${b.outcome}`);
      const b2 = await c.call('S_ME_MG_0001', 'B-200', {});
      ok('4 形态 B 成功（status:200）⇒ ok', b2.outcome === OUTCOME.OK, `outcome=${b2.outcome}｜code=${b2.code}`);
      const af = await c.call('S_ME_MG_0001', 'A-fail', {});
      ok('5 业务失败（errcode:-1）⇒ biz-fail 且带 resultMsg', af.outcome === OUTCOME.BIZ_FAIL && af.message.includes('工单不存在'), `msg=${af.message}`);
      const bf = await c.call('S_ME_MG_0001', 'B-fail', {});
      ok('6 业务失败（status:false）⇒ biz-fail 且带 msg', bf.outcome === OUTCOME.BIZ_FAIL && bf.message.includes('参数错误'), `msg=${bf.message}`);
      const h5 = await c.call('S_ME_MG_0001', 'http500', {});
      ok('7 HTTP 500 ⇒ http-fail', h5.outcome === OUTCOME.HTTP_FAIL && h5.httpStatus === 500, `outcome=${h5.outcome}`);
      const un = await c.call('S_ME_MG_0001', 'unknown', {});
      ok('8 不可识别响应 ⇒ bad-response（绝不猜成功）', un.outcome === OUTCOME.BAD_RESPONSE, `outcome=${un.outcome}`);
      const rw = await c.call('S_ME_MG_0001', 'raw', {});
      ok('9 非 JSON ⇒ bad-response', rw.outcome === OUTCOME.BAD_RESPONSE, `outcome=${rw.outcome}`);
      const to = await c.call('S_ME_MG_0001', 'slow', {});
      ok('10 超时 ⇒ timeout', to.outcome === OUTCOME.TIMEOUT, `outcome=${to.outcome}`);
      const s = c.snapshot();
      ok('11 计数快照完整', s.calls === 9 && s.ok === 3 && s.bizFail === 2 && s.httpFail === 1 && s.badResponse === 2 && s.timeout === 1,
        JSON.stringify(s));
    } catch (e) {
      ok('探针异常', false, e && e.message);
    } finally {
      await new Promise(r => srv.close(r));
      console.log(`\n=== 汇总 ===\n通过 ${pass} 项，失败 ${fail} 项`);
      process.exit(fail ? 1 : 0);
    }
  });
}

try { main(); } catch (e) { console.log('FATAL ' + (e && e.message)); process.exit(2); }
