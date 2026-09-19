/* ==========================================================================
   联调工具进程级自检（tests/tools-check.js）
   作用：把 tools/mock-upper 与 tools/mock-mes 当成真实进程启动，验证它们在
         tests/README.md 里被承诺的行为，而不是只读源码：
         T1 mock-upper 的 /health、/realtime、/sample、404 与报文契约
         T2 mock-upper 的 --push 推送（含 --once --push 的退出码）
         T3 mock-mes 的两种回执风格、--fail-rate、/log 与 DELETE /log
         T4 mock-mes 的派工下发：POST /dispatch 与 --dispatch-every
         T5 端口被占用时的失败行为
         T6 两个工具的命令行参数与各自 README 是否逐条一致
   依赖：仅 Node 内置模块（http / child_process / fetch）；只连本机回环端口。
   运行：node tests/tools-check.js
   退出码：0 = 全部通过；1 = 有断言失败；2 = 脚本自身异常。
   注意：Windows 沙箱下不能给子进程接管道，故子进程一律 stdio: 'ignore'，
         所有观测都通过 HTTP 回环或退出码完成。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const env = require('./env');
env.assertRuntime();

const ROOT = path.resolve(__dirname, '..');
const UPPER = path.join(ROOT, 'tools', 'mock-upper', 'mock-upper.js');
const MES = path.join(ROOT, 'tools', 'mock-mes', 'mock-mes.js');

/* ---------------- 断言框架 ---------------- */
let passed = 0;
const failures = [];
let skipped = 0;
const children = [];

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  [SKIP] ${name} —— ${reason}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ---------------- 子进程与 HTTP 小工具 ---------------- */

/** 启动一个工具进程（stdio 忽略，避免沙箱下的管道限制） */
function startTool(script, args) {
  const child = spawn(process.execPath, [script].concat(args), { stdio: 'ignore' });
  children.push(child);
  return child;
}

/** 轮询等待 HTTP 端点就绪 */
async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch (e) { /* 未就绪，继续等 */ }
    await sleep(100);
  }
  return false;
}

/** 起一个本机接收端，把收到的请求体收集起来（用于验证 --push / 派工） */
function startReceiver(port) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { parsed = { raw: body }; }
      received.push({ path: req.url, method: req.method, payload: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ status: 1, msg: 'ok' }));
    });
  });
  return new Promise(resolve => {
    server.listen(port, () => resolve({ server, received, port }));
  });
}

async function stopAll() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch (e) { /* 已退出 */ }
    }
  }
  await sleep(300);
}

/** 从源码里抽出实现过的命令行开关 */
function flagsInSource(relPath) {
  return new Set([...readText(relPath).matchAll(/'(--[a-z-]+)'/g)].map(m => m[1]));
}

/** 从 README 里抽出被文档化的命令行开关 */
function flagsInReadme(relPath) {
  const text = readText(relPath);
  return new Set([...text.matchAll(/(--[a-z][a-z-]*)/g)].map(m => m[1]).filter(f => f !== '--'));
}

async function main() {
  const P_UPPER = 18901;
  const P_PUSH = 18902;
  const P_MES = 18903;
  const P_MES_FAIL = 18904;
  const P_BOARD = 18905;
  const P_UPPER_TWICE = 18906;

  /* ===== T1 mock-upper 服务行为 ===== */
  section('T1 mock-upper HTTP 服务');
  startTool(UPPER, ['--port', String(P_UPPER)]);
  const upOk = await waitHealth(P_UPPER);
  if (!upOk) {
    skip('mock-upper 服务检查', `端口 ${P_UPPER} 未就绪`);
  } else {
    const health = await (await fetch(`http://127.0.0.1:${P_UPPER}/health`)).json();
    check('GET /health 返回 status=1 与设备编号', health.status === 1 && !!health.equipCode, JSON.stringify(health));

    const frame = await (await fetch(`http://127.0.0.1:${P_UPPER}/realtime`)).json();
    const sample = await (await fetch(`http://127.0.0.1:${P_UPPER}/sample`)).json();
    const frameKeys = Object.keys(frame).sort().join(',');
    const sampleKeys = Object.keys(sample).sort().join(',');
    check('GET /realtime 与 /sample 返回同构报文', frameKeys === sampleKeys, `realtime=${frameKeys.length} 字符，sample=${sampleKeys.length} 字符`);
    check('报文含必填字段 equipCode 且速度自洽', !!frame.equipCode &&
      Math.abs(Math.hypot(frame.velocity_x, frame.velocity_y) - frame.speed) < 0.02,
      `equipCode=${frame.equipCode} speed=${frame.speed} 由 vx/vy 合成的值=${Math.hypot(frame.velocity_x, frame.velocity_y).toFixed(2)}`);
    check('报文运行阶段与 testStatus 同时给出', typeof frame.stage === 'string' && Number.isInteger(frame.testStatus),
      `stage=${frame.stage} testStatus=${frame.testStatus}`);

    const notFound = await fetch(`http://127.0.0.1:${P_UPPER}/nope`);
    const nfBody = await notFound.json();
    check('未知路径返回 404 与 status=0', notFound.status === 404 && nfBody.status === 0, `HTTP ${notFound.status} ${JSON.stringify(nfBody)}`);
  }

  /* ===== T2 mock-upper --push 推送 ===== */
  section('T2 mock-upper 推送（--push / --once --push）');
  const recv = await startReceiver(P_PUSH);
  startTool(UPPER, ['--port', String(P_UPPER + 100), '--push', `http://127.0.0.1:${P_PUSH}/realtime`, '--interval', '300']);
  for (let i = 0; i < 40 && recv.received.length === 0; i++) await sleep(150);
  check('--push 能周期推送报文到目标地址', recv.received.length > 0,
    `接收端在 6 秒内收到 ${recv.received.length} 帧`);
  if (recv.received.length) {
    const p = recv.received[0].payload;
    check('推送的报文走 POST 且字段与契约一致', recv.received[0].method === 'POST' &&
      !!p.equipCode && 'cameraDepth' in p && 'collectTime' in p,
      `${recv.received[0].method} ${recv.received[0].path}，字段数 ${Object.keys(p).length}`);
  }
  recv.server.close();

  const recvOnce = await startReceiver(P_PUSH + 100);
  const onceChild = startTool(UPPER, ['--once', '--push', `http://127.0.0.1:${P_PUSH + 100}/realtime`]);
  const onceExit = await new Promise(resolve => {
    const t = setTimeout(() => resolve('timeout'), 6000);
    onceChild.on('exit', code => { clearTimeout(t); resolve(code); });
  });
  check('--once --push 推一帧后正常退出（退出码 0）', onceExit === 0, `退出码 ${onceExit}`);
  check('--once --push 确实送达了一帧', recvOnce.received.length === 1, `接收端收到 ${recvOnce.received.length} 帧`);
  recvOnce.server.close();

  /* ===== T3 mock-mes 回执与日志 ===== */
  section('T3 mock-mes 回执 / 日志 / 异常概率');
  startTool(MES, ['--port', String(P_MES), '--receipt', 'status']);
  const mesOk = await waitHealth(P_MES);
  if (!mesOk) {
    skip('mock-mes 回执检查', `端口 ${P_MES} 未就绪`);
  } else {
    const post = body => fetch(`http://127.0.0.1:${P_MES}/service/report/receiveReport`, {
      method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8' }, body: JSON.stringify(body)
    }).then(r => r.json());

    const good = { equipCode: 'SX-UNDERWATER-001', uploadId: 'UP20260918151027001', depth: 12.68, cameraDepth: 12.0, speed: 4.9 };
    const r1 = await post(good);
    check('status 风格：合法报文回 {status:1}', r1.status === 1, JSON.stringify(r1));
    const r2 = await post({ uploadId: 'X' });   // 缺 equipCode → 异常回执
    check('status 风格：缺 equipCode 回 {status:0}', r2.status === 0, JSON.stringify(r2));

    const log = await (await fetch(`http://127.0.0.1:${P_MES}/log`)).json();
    check('GET /log 记录了两条报文并统计异常数', log.count === 2 && log.abnormalCount === 1,
      `count=${log.count} abnormalCount=${log.abnormalCount} receiptStyle=${log.receiptStyle}`);
    check('/log 条目保留完整请求体（可核对 13 字段）',
      log.items.length > 0 && Object.keys(log.items[0].payload).length >= 5,
      `首条 payload 字段数=${log.items.length ? Object.keys(log.items[0].payload).length : 0}`);

    const del = await (await fetch(`http://127.0.0.1:${P_MES}/log`, { method: 'DELETE' })).json();
    const after = await (await fetch(`http://127.0.0.1:${P_MES}/log`)).json();
    check('DELETE /log 清空日志', del.status === 1 && after.count === 0, `清空后 count=${after.count}`);
  }

  startTool(MES, ['--port', String(P_MES_FAIL), '--receipt', 'code', '--fail-rate', '1']);
  if (!(await waitHealth(P_MES_FAIL))) {
    skip('code 风格与 fail-rate 检查', `端口 ${P_MES_FAIL} 未就绪`);
  } else {
    const r = await fetch(`http://127.0.0.1:${P_MES_FAIL}/service/a/b`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ equipCode: 'X' })
    }).then(x => x.json());
    check('code 风格 + --fail-rate 1：回 {code:5001}', r.code === 5001, JSON.stringify(r));
    const h = await (await fetch(`http://127.0.0.1:${P_MES_FAIL}/health`)).json();
    check('/health 反映回执风格', h.receiptStyle === 'code', JSON.stringify(h));
  }

  /* ===== T4 mock-mes 派工下发（IF-A） ===== */
  section('T4 mock-mes 派工下发（IF-A）');
  const board = await startReceiver(P_BOARD);
  const mesBoard = startTool(MES, ['--port', String(P_MES + 100), '--board', `http://127.0.0.1:${P_BOARD}/dispatch`, '--dispatch-every', '300']);
  if (!(await waitHealth(P_MES + 100))) {
    skip('派工下发检查', `端口 ${P_MES + 100} 未就绪`);
  } else {
    for (let i = 0; i < 40 && board.received.length === 0; i++) await sleep(150);
    check('--dispatch-every 会周期性向 --board 下发派工', board.received.length > 0,
      `接收端 6 秒内收到 ${board.received.length} 次`);
    if (board.received.length) {
      const p = board.received[0].payload;
      const need = ['techNoticeNo', 'procOrderNo', 'productCode', 'dispatchQty', 'planStartTime', 'planEndTime', 'dispatchTarget'];
      const missing = need.filter(k => !(k in p));
      check('派工报文含 IF-A 关键字段', missing.length === 0, missing.length ? `缺 ${missing.join('、')}` : `字段数 ${Object.keys(p).length}`);
    }
    const manual = await (await fetch(`http://127.0.0.1:${P_MES + 100}/dispatch`, { method: 'POST' })).json();
    check('POST /dispatch 手动触发一次下发并返回状态', manual.status === 1, JSON.stringify(manual));
    mesBoard.kill();
  }

  /* ===== T5 端口冲突行为 ===== */
  section('T5 端口被占用时的行为');
  const conflict = startTool(UPPER, ['--port', String(P_UPPER)]);
  const exited = await new Promise(resolve => {
    const t = setTimeout(() => resolve('timeout'), 5000);
    conflict.on('exit', code => { clearTimeout(t); resolve(code); });
  });
  check('同一端口起第二个实例会退出而不是静默假活', exited !== 'timeout' && exited !== 0,
    `退出码 ${exited}（期望非 0；若为 timeout 说明进程占着端口却没报错）`);

  /* ===== T6 参数与 README 一致性 ===== */
  section('T6 命令行参数 ↔ README 一致性');
  for (const [label, js, readme] of [
    ['mock-upper', 'tools/mock-upper/mock-upper.js', 'tools/mock-upper/README.md'],
    ['mock-mes', 'tools/mock-mes/mock-mes.js', 'tools/mock-mes/README.md']
  ]) {
    const src = flagsInSource(js);
    const doc = flagsInReadme(readme);
    const undocumented = [...src].filter(f => !doc.has(f));
    const unimplemented = [...doc].filter(f => !src.has(f) && f !== '--help');
    check(`${label}：实现的开关都在 README 里有说明`, undocumented.length === 0,
      undocumented.length ? `未文档化：${undocumented.join('、')}` : `共 ${src.size} 个开关`);
    check(`${label}：README 提到的开关都已实现`, unimplemented.length === 0,
      unimplemented.length ? `文档里有但代码没有：${unimplemented.join('、')}` : '');
  }

  await stopAll();

  /* ---------------- 汇总 ---------------- */
  console.log('\n=== 汇总 ===');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项，跳过 ${skipped} 项`);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ' —— ' + f.detail : ''}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async err => {
  console.error('\n自检脚本异常终止：' + (err && err.stack ? err.stack : err));
  await stopAll();
  process.exit(2);
});
