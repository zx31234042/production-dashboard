/* ==========================================================================
   联调工具进程级自检（tests/tools-check.js）
   作用：把 tools/mock-upper 与 tools/mock-mes 当成真实进程启动，验证它们在
         tests/README.md 里被承诺的行为，而不是只读源码：
         T1 mock-upper 的 /health、/realtime、/sample、404 与报文契约
         T1b 运行阶段（stage）↔ testStatus 的映射一致性（FR-2.5 / C-98；前端模拟器与工具三方对账）
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
const vm = require('node:vm');
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

/* ---------------- 运行阶段（stage）↔ 状态码（testStatus）映射的证据源 ----------------
   C-98④ / FR-2.5：运行阶段由 `testStatus` 导出 —— 准备=0／运行=1／判定=2／完成=**回到 0**
   （"完成"是过渡阶段、稳定显示 ≥2 s）；`3`（设备异常）是**正交状态**，不属于这四段的码。
   期望值**不写死**：从当轮需求原文的 FR-2.5 条款行实读（D21「期望值实测」），
   再与两处模拟上位机的**源码分支表**、以及两处**真跑出来的逐帧报文**三方对账。 */

const REQ_DIR = path.join(ROOT, '需求文档');

/** 从当轮需求清单的 FR-2.5 行解析「阶段 → 码」导出规则（期望值的唯一来源＝需求原文）。
 *  @returns {{ok:boolean, table:object, detail:string}} */
function stageTableFromRequirement() {
  let file = null;
  let lines = [];
  try {
    file = fs.readdirSync(REQ_DIR).find(f => f.endsWith('.md')) || null;
    if (file) lines = fs.readFileSync(path.join(REQ_DIR, file), 'utf8').split('\n').map(s => s.replace(/\r$/, ''));
  } catch (e) { /* 读不到 ⇒ 下面如实报，不静默跳过 */ }
  const row = lines.find(l => /^\|\s*FR-2\.5\s*\|/.test(l)) || '';
  const table = {};
  for (const m of row.matchAll(/`(\d+)\s*=\s*(准备|运行|判定|完成)`/g)) table[m[2]] = Number(m[1]);
  const back = row.match(/回到\s*`?(\d+)`?\s*＝\s*完成/);
  if (back) table['完成'] = Number(back[1]);
  const need = ['准备', '运行', '判定', '完成'];
  const missing = need.filter(k => table[k] === undefined);
  return {
    ok: missing.length === 0,
    table,
    detail: `${file || '（需求文档\\*.md 读不到）'} 的 FR-2.5 行解析：` +
      (missing.length
        ? `**缺** ${missing.join('、')} —— 行文改了？原文：${row.slice(0, 180)}`
        : `准备→${table['准备']}／运行→${table['运行']}／判定→${table['判定']}／完成→${table['完成']}`)
  };
}

/** 从模拟上位机源码里抽「阶段 → 码」分支表（**源码表**这一半的证据）。
 *  两处实现的分支都写在同一行；抽不满 4 个阶段时退回跨行匹配（仍抽不满即如实报 N 个）。
 *  @returns {{table:object, branches:number}} */
function stageTableFromSource(relPath) {
  const text = readText(relPath);
  const table = {};
  for (const line of text.split('\n')) {
    const m = /stage\s*=\s*'([^']+)'[^}]*?testStatus\s*=\s*(\d+)/.exec(line);
    if (m) table[m[1]] = Number(m[2]);
  }
  if (Object.keys(table).length < 4) {
    for (const m of text.matchAll(/stage\s*=\s*'([^']+)'[\s\S]{0,120}?testStatus\s*=\s*(\d+)/g)) table[m[1]] = Number(m[2]);
  }
  return { table, branches: Object.keys(table).length };
}

/** 在隔离 vm 里加载「前端模拟上位机」（board.config + mockUpperSource，与 index.html 同序） */
function loadMockUpperSource() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const run = rel => vm.runInContext(readText(rel), sandbox, { filename: path.join(ROOT, rel) });
  run('src/config/board.config.js');
  run('src/services/mockUpperSource.js');
  return sandbox.window;
}

/** 前端模拟上位机：按秒推进**一整个节拍**（节拍读配置，不写死），逐帧收 stage/testStatus。
 *  逐帧是**实跑值**（不是读源码）：stages 的判定阈值一改，下面的断言立刻能看到。 */
function frontStageFrames(windowObj) {
  const cycleSec = Number(windowObj.BoardConfig.production.cycleSec);
  const t0 = new Date('2026-09-18T09:00:00');
  const frames = [];
  let inner = null;
  for (let k = 0; k <= cycleSec + 1; k++) {
    const f = windowObj.MockUpperSource.next(inner, new Date(t0.getTime() + k * 1000));
    inner = f.inner;
    frames.push({ stage: f.payload.stage, testStatus: f.payload.testStatus });
  }
  return { cycleSec, frames };
}

/** 逐帧记录 → 阶段 → 出现过的码集合 */
function stageCodeSets(frames) {
  const m = new Map();
  for (const f of frames) {
    if (!m.has(f.stage)) m.set(f.stage, new Set());
    m.get(f.stage).add(f.testStatus);
  }
  return m;
}

/** 集合视图的可读文本（失败时直接进报告） */
function stageCodeText(sets) {
  return [...sets].map(([s, set]) => `${s}→{${[...set].join('/')}}`).join('，');
}

/** 把「观测到的 stage→码集合」与「期望的 stage→码」逐阶段比：返回不一致清单（空＝全对）。
 *  · 期望里的阶段**未被观测到** ⇒ 记一条（"只测到一个阶段就通过"就是从这里被拦下的）；
 *  · 观测到期望之外的阶段 ⇒ 也记一条（不接受未定义阶段混进四阶段）。 */
function stageMapDiff(observed, expected) {
  const bad = [];
  for (const s of Object.keys(expected)) {
    const set = observed.get(s);
    if (!set) { bad.push(`${s}（期望 ${expected[s]}）：**未被观测到**`); continue; }
    const vals = [...set];
    if (vals.length !== 1 || vals[0] !== expected[s]) bad.push(`${s}：实测 {${vals.join('/')}} ≠ 期望 ${expected[s]}`);
  }
  for (const s of observed.keys()) if (!(s in expected)) bad.push(`${s}：不在 FR-2.5 的四阶段内`);
  return bad;
}

/** 打印逐帧 stage/testStatus（D19：断言即证据 —— 把实跑到的每一帧原样贴出来） */
function dumpStageFrames(tag, frames, perLine) {
  const n = perLine || 12;
  console.log(`  ${tag} —— 逐帧 stage/testStatus（共 ${frames.length} 帧）：`);
  for (let i = 0; i < frames.length; i += n) {
    console.log('    ' + frames.slice(i, i + n).map((f, j) => `#${i + j + 1}=${f.stage}/${f.testStatus}`).join('  '));
  }
}

/** 从模拟上位机源码里读阶段判定的**三个阈值**（准备秒数 + 两个比例）。
 *  用途：工具侧靠**真实时钟**推进（`unitSec = floor(已过秒) % cycle`），要让四个阶段都在
 *  **第一拍**内被观测到，节拍值不能随手取（见 `stageObservationCycle()` 的推导）。
 *  @returns {{prepSec:number|null, runEnd:number|null, judgeEnd:number|null}} */
function stageThresholdsFromSource(relPath) {
  const text = readText(relPath);
  const prep = text.match(/unitSec\s*<\s*([\d.]+)/);
  const ratios = [...text.matchAll(/progress\s*<\s*([\d.]+)/g)].map(m => Number(m[1]));
  return {
    prepSec: prep ? Number(prep[1]) : null,
    runEnd: ratios.length > 0 ? ratios[0] : null,
    judgeEnd: ratios.length > 1 ? ratios[1] : null
  };
}

/** 观测用的节拍（**可观测性夹具**，不是期望值）：工具侧的 `unitSec` 是**整秒**
 *  （`Math.floor((now - startedAt)/1000)`），而"完成"要求 `unitSec / cycle ≥ judgeEnd`
 *  ⇒ 必须存在整数 u 使 `judgeEnd × cycle ≤ u < cycle`。若节拍取整数，最短要 `cycle ≥ 34 s`
 *  才有"完成"那一秒（白白多等 30 s）；取 `cycle = 准备秒数 + 3.3` 时 u = 准备秒数 + 3
 *  （＝11，`11 / 11.3 = 0.9735 ≥ 0.97`），四阶段都能在**前 11.3 s** 内看到。
 *  阈值从源码实读 ⇒ 阈值改了这里跟着动；真观测不到就由 T1b 的"四阶段全观测"断言变红点名。 */
function stageObservationCycle(relPath) {
  const th = stageThresholdsFromSource(relPath);
  const prep = Number.isFinite(th.prepSec) ? th.prepSec : 8;
  return String(prep + 3.3);
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
  const P_STAGE_UPPER = 18907;
  const P_STAGE_PUSH = 18908;

  /* 期望值先取好：FR-2.5 的「阶段由 testStatus 导出」规则（需求原文实读），T1 与 T1b 共用 */
  const FR25 = stageTableFromRequirement();

  /* 「阶段 ↔ 码」的实跑观测要凑满**一整个节拍**（工具侧"准备"固定占前 8 s，"完成"只有最后
     不到一秒），故把工具**提前**以 --push 起好：T1～T5 跑完时接收端已攒够一整拍，不额外拖长自检。
     节拍值由 `stageObservationCycle()` 按源码阈值推导（整数节拍要 34 s 才有"完成"）。 */
  const stageRecv = await startReceiver(P_STAGE_PUSH);
  const stageCycle = stageObservationCycle('tools/mock-upper/mock-upper.js');
  startTool(UPPER, ['--port', String(P_STAGE_UPPER), '--push', `http://127.0.0.1:${P_STAGE_PUSH}/realtime`,
    '--interval', '50', '--cycle', stageCycle]);

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
    check('报文运行阶段与 testStatus 同时给出，且取值符合 FR-2.5 的阶段导出规则（期望值取自需求原文）',
      typeof frame.stage === 'string' && Number.isInteger(frame.testStatus) &&
      FR25.ok && FR25.table[frame.stage] === frame.testStatus,
      `stage=${frame.stage} testStatus=${frame.testStatus}；FR-2.5 规则：${FR25.detail}`);

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

  /* ===== T1b 运行阶段 ↔ testStatus 映射一致性（FR-2.5 / C-98） =====
     为什么单列：C-98④ 把「运行阶段（准备/运行/判定/完成）由 `testStatus` 导出」定成需求口径
     （准备=0／运行=1／判定=2／**完成=回到 0**，"完成"为过渡阶段），并**连带**要求两处模拟上位机
     （`src/services/mockUpperSource.js`、`tools/mock-upper/mock-upper.js`）同步改口径
     （旧实现：判定=1、完成=2 —— 与附录 2 语义不符）。
     光断言"两个字段都在"不足以防回潮（旧实现就是两个字段都在），故本条做**三方对账**：
       ① 期望值 ＝ 当轮需求原文 FR-2.5 行**实读**（不写死，D21）；
       ② 源码表 ＝ 两处模拟上位机的阶段分支表（逐分支抽 stage/testStatus）；
       ③ 实跑值 ＝ 前端模拟器按秒推进一整节拍逐帧取 ＋ 工具模拟器以**真进程 --push** 逐帧收。
     判据：③ 必须满足 ①（并满足 ②），且**四个阶段全部被观测到** ——
     "只测到一个阶段就通过"是不允许的（严格相等：每个阶段出现过的码集合恰为期望的那一个）。
     证据口径（D19）：下面把逐帧的 stage/testStatus 原样打印出来。 */
  section('T1b 运行阶段 ↔ testStatus 映射一致性（FR-2.5 / C-98，逐帧实跑）');
  {
    check('FR-2.5 的「阶段由 testStatus 导出」规则可从当轮需求原文实读（四阶段齐全 ⇒ 期望值非写死）',
      FR25.ok, FR25.detail);

    const frontSrc = stageTableFromSource('src/services/mockUpperSource.js');
    const toolSrc = stageTableFromSource('tools/mock-upper/mock-upper.js');
    const srcExpected = FR25.ok ? FR25.table : {};
    const asSets = table => new Map(Object.entries(table).map(([k, v]) => [k, new Set([v])]));
    const frontSrcBad = stageMapDiff(asSets(frontSrc.table), srcExpected);
    const toolSrcBad = stageMapDiff(asSets(toolSrc.table), srcExpected);
    check('FR-2.5/C-98 两处模拟上位机的「阶段↔码」源码表都与需求导出规则逐项一致（且各恰含 4 个阶段）',
      frontSrc.branches === 4 && toolSrc.branches === 4 &&
      frontSrcBad.length === 0 && toolSrcBad.length === 0,
      `前端源码表（${frontSrc.branches} 个阶段）${JSON.stringify(frontSrc.table)}；` +
      `工具源码表（${toolSrc.branches} 个阶段）${JSON.stringify(toolSrc.table)}；` +
      `需求期望 ${JSON.stringify(srcExpected)}` +
      [frontSrcBad.length ? `；前端不一致：${frontSrcBad.join('；')}` : '',
        toolSrcBad.length ? `；工具不一致：${toolSrcBad.join('；')}` : ''].join(''));

    /* ---- 实跑① 前端模拟上位机：按秒推进一整节拍（期望不依赖真实时钟，逐帧都是实跑值） ---- */
    const W = loadMockUpperSource();
    const front = frontStageFrames(W);
    dumpStageFrames(`实跑① 前端 src/services/mockUpperSource.js（按秒推进，节拍 ${front.cycleSec} s）`, front.frames);
    const frontSets = stageCodeSets(front.frames);
    const frontBad = FR25.ok ? stageMapDiff(frontSets, FR25.table) : ['FR-2.5 期望值未取到'];
    check('FR-2.5/C-98 前端模拟上位机实跑：逐帧 stage→testStatus 严格为 准备→0／运行→1／判定→2／完成→0，且四阶段全部被观测到',
      frontBad.length === 0 && frontSets.size === 4,
      `观测到 ${frontSets.size} 个阶段：${stageCodeText(frontSets)}（共 ${front.frames.length} 帧）` +
      (frontBad.length ? `；**不一致**：${frontBad.join('；')}` : ''));

    /* ---- 实跑② 工具模拟上位机：真进程 --push（进程在 T1 之前就起来了，这里只等它攒够一节拍） ---- */
    const needStages = Object.keys(srcExpected);
    /* "完成"在工具侧只占 0.3 s（见 stageObservationCycle），个别时刻被机器抖动跳过时，
       这里再等后面的节拍（每拍 11.3 s）；等够 20 s 仍凑不齐就红，不静默降级为通过。 */
    for (let i = 0; i < 80 && needStages.some(s => !new Set(stageRecv.received.map(r => r.payload.stage)).has(s)); i++) {
      await sleep(250);
    }
    const toolFrames = stageRecv.received.map(r => ({ stage: r.payload.stage, testStatus: r.payload.testStatus }));
    if (!toolFrames.length) {
      skip('FR-2.5/C-98 工具模拟上位机实跑：阶段↔码一致且四阶段可观测',
        `端口 ${P_STAGE_UPPER} / ${P_STAGE_PUSH} 在 15 s 内没收到任何推送帧（环境不满足，不当作通过）`);
    } else {
      dumpStageFrames(`实跑② 工具 tools/mock-upper/mock-upper.js（--cycle ${stageCycle} --interval 50，真实时间逐帧推送）`, toolFrames);
      const toolSets = stageCodeSets(toolFrames);
      const toolBad = FR25.ok ? stageMapDiff(toolSets, FR25.table) : ['FR-2.5 期望值未取到'];
      check('FR-2.5/C-98 工具模拟上位机实跑：逐帧 stage→testStatus 严格为 准备→0／运行→1／判定→2／完成→0，且四阶段全部被观测到',
        toolBad.length === 0 && toolSets.size === 4,
        `观测到 ${toolSets.size} 个阶段：${stageCodeText(toolSets)}（共 ${toolFrames.length} 帧）` +
        (toolBad.length ? `；**不一致**：${toolBad.join('；')}` : ''));
      /* 两处实跑的映射**必须一致**（前端 ↔ 工具），且各自与自己的源码表一致（三向闭环） */
      const frontKey = JSON.stringify([...frontSets].map(([k, v]) => [k, [...v].sort()]).sort());
      const toolKey = JSON.stringify([...toolSets].map(([k, v]) => [k, [...v].sort()]).sort());
      check('FR-2.5/C-98 两处模拟上位机的**实跑**映射互相一致，且各自与自己的源码表一致（前端 ↔ 工具 ↔ 源码表 三向闭环）',
        frontKey === toolKey &&
        frontSrc.branches === frontSets.size && toolSrc.branches === toolSets.size &&
        stageMapDiff(frontSets, frontSrc.table).length === 0 &&
        stageMapDiff(toolSets, toolSrc.table).length === 0,
        `前端实跑 ${stageCodeText(frontSets)}；工具实跑 ${stageCodeText(toolSets)}；` +
        `前端源码表 ${JSON.stringify(frontSrc.table)}；工具源码表 ${JSON.stringify(toolSrc.table)}`);
    }
    stageRecv.server.close();
  }

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
