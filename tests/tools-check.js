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

/** 启动一个工具进程（stdio 忽略，避免沙箱下的管道限制）
 *  @param {object} [extraEnv] 追加/覆盖的环境变量（异常注入靠环境变量开启，见 T1c） */
function startTool(script, args, extraEnv) {
  const child = spawn(process.execPath, [script].concat(args), {
    stdio: 'ignore',
    env: extraEnv ? Object.assign({}, process.env, extraEnv) : process.env
  });
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
  const P_INJ_UPPER = 18909;
  const P_INJ_PUSH = 18910;

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

  /* ===== T1c 异常注入开关（E22 判据①：设备异常 `3` 的**可注入**分支） =====
     判据为什么长这样：附录 2 的码 `3`（设备异常 ⇒ 看板显示模式「故障锁定」）是**正交状态**，
     真实上位机偶发才出现 —— "等它出现"不是判据，"能定点注入并且注入的语义逐条成立"才是。
     两条**可否证**的判据（两处模拟上位机都要满足）：
       ① 默认关闭 ⇒ 整节拍内 `testStatus` **永不等于 3**（谁把注入默认打开，这条立刻红）；
       ② 注入窗口内 ⇒ `testStatus === 3` 且 `stage` **冻结**（本应跨过的阶段不跨），
          窗口结束后 `stage` 从冻结处**继续推进**（恢复）—— 冻结/恢复都是逐帧可观测的。
     实现口径：`src/services/mockUpperSource.js`（前端）与 `tools/mock-upper/mock-upper.js`（工具）
     是同一口径的模拟器，两处的判定表达式**逐字相同**（下面直接对着源码核这两行）。 */
  section('T1c 异常注入开关（E22 判据①：码 3 可注入、默认关闭、阶段冻结与恢复）');
  {
    const INJ_AFTER = 10;
    const INJ_DUR = 5;
    /* ---- ① 前端模拟器：vm 里逐步推进（不依赖真实时钟，逐帧都是实跑值） ---- */
    const Wi = loadMockUpperSource();
    const cycleI = Number(Wi.BoardConfig.production.cycleSec);
    function frameSeq(abnOpts) {
      Wi.MockUpperSource.setAbnormal(abnOpts || { enabled: false });
      const t0 = new Date('2026-09-18T09:00:00');
      let inner = null;
      const out = [];
      for (let k = 0; k <= cycleI + INJ_DUR + 2; k++) {
        const f = Wi.MockUpperSource.next(inner, new Date(t0.getTime() + k * 1000));
        inner = f.inner;
        out.push({ k, stage: f.payload.stage, testStatus: f.payload.testStatus });
      }
      return out;
    }
    /* ⚠ 先读**模块默认态**（必须在任何 `setAbnormal` 之前读，否则读到的是上一次设置值）：
       `setAbnormal({enabled:false})` 只是"显式关掉"，真正要防的回潮是"注入被谁默认打开"。
       （定点变异实测：只判"显式关掉"时，把 `ABNORMAL` 的默认 enabled 改成 true 这条**照样绿**，见 MF-2。） */
    const defaultInj = Wi.MockUpperSource.abnormalState ? Wi.MockUpperSource.abnormalState() : { enabled: 'MISSING' };
    const seqOff = frameSeq(null);
    const seqOn = frameSeq({ enabled: true, afterSec: INJ_AFTER, durSec: INJ_DUR });
    const offCodes = new Set(seqOff.map(f => f.testStatus));
    check('E22① 默认关闭：模块**默认态**即关闭（`abnormalState().enabled===false`），且整节拍内 testStatus 只出现 0/1/2、**码 3 一次都不出现**（谁把注入默认打开，这条立刻红）',
      defaultInj.enabled === false && defaultInj.afterSec === 0 &&
      !offCodes.has(3) && offCodes.size === 3,
      `默认态=${JSON.stringify(defaultInj)}；默认关闭实跑 ${seqOff.length} 帧，码集合 = {${[...offCodes].sort().join('/')}}（期望 {0/1/2}，不含 3）`);
    const win = seqOn.filter(f => f.k >= INJ_AFTER && f.k < INJ_AFTER + INJ_DUR);
    const stageFrozen = [...new Set(win.map(f => f.stage))];
    check('E22① 注入窗口内：码恒为 3（设备异常）且 stage **恒定**（阶段冻结，不随节拍推进）',
      win.length === INJ_DUR && win.every(f => f.testStatus === 3) && stageFrozen.length === 1,
      `窗口 [${INJ_AFTER},${INJ_AFTER + INJ_DUR}) 实跑 ${win.length} 帧：码集合 {${[...new Set(win.map(f => f.testStatus))].join('/')}}、` +
      `阶段集合 {${stageFrozen.join('/')}}（期望 3 与**单一**阶段）`);
    let shiftBad = 0, firstBad = '';
    for (let k = INJ_AFTER + INJ_DUR; k < seqOn.length; k++) {
      const a = seqOn[k], b = seqOff[k - INJ_DUR];
      if (a.stage !== b.stage || a.testStatus !== b.testStatus) {
        shiftBad++;
        if (!firstBad) firstBad = `k=${k} 注入后 ${a.stage}/${a.testStatus} ≠ 未注入 k=${k - INJ_DUR} 的 ${b.stage}/${b.testStatus}`;
      }
    }
    check('E22① 窗口结束后**阶段继续推进**（恢复）：逐帧与"未注入的同刻整体后移 ' + INJ_DUR + 's"严格相等',
      shiftBad === 0,
      shiftBad ? `有 ${shiftBad} 帧不一致，首个：${firstBad}` :
        `窗口后 ${seqOn.length - INJ_AFTER - INJ_DUR} 帧与未注入序列（整体后移 ${INJ_DUR}s）逐帧相等；` +
        `窗口前最后一帧 stage=${seqOn[INJ_AFTER - 1].stage}、窗口首帧 stage=${win[0].stage}`);
    check('E22① 注入**只改状态码、不改阶段语义**：窗口内出现 3 的帧数恰为窗口帧数，窗口外一帧都没有',
      seqOn.filter(f => f.testStatus === 3).length === INJ_DUR &&
      seqOn.filter(f => f.testStatus === 3).every(f => f.k >= INJ_AFTER && f.k < INJ_AFTER + INJ_DUR),
      `全序列出现 3 的帧 = ${seqOn.filter(f => f.testStatus === 3).length} 帧，全部落在 [${INJ_AFTER},${INJ_AFTER + INJ_DUR}) 内`);

    /* ---- 码 3 的语义链（看板侧的真源）：附录 2 的码 → 显示模式「故障锁定」+ 告警色 ---- */
    const fieldMapSrc = readText('src/config/fieldMap.js');
    check('E22① 码 3 在看板侧的语义在真源里钉住：fieldMap 的 `3: \'故障锁定\'` 与 modeToTestStatus 的 `\'故障锁定\': 3`',
      /3:\s*'故障锁定'/.test(fieldMapSrc) && /'故障锁定':\s*3/.test(fieldMapSrc),
      'src/config/fieldMap.js 同时给出「码 → 显示模式」与「显示模式 → 码」两个方向');
    const panelSrc = readText('src/components/DeviceStatusPanel.js');
    check('E22①「故障锁定」是**独立状态**且用告警色渲染（"单独告警"不是靠阶段文案冒充的）',
      /name:\s*'故障锁定'\s*,\s*color:\s*'var\(--err\)'/.test(panelSrc),
      'src/components/DeviceStatusPanel.js 的 5 态表里「故障锁定」独立成项、色值 var(--err)');
    const frontSrc2 = readText('src/services/mockUpperSource.js');
    const toolSrc2 = readText('tools/mock-upper/mock-upper.js');
    const sameLines = ['const elapsed = rawElapsed - abn.frozen;', 'if (abn.active) testStatus = 3;'];
    const missing = sameLines.filter(l => !frontSrc2.includes(l) || !toolSrc2.includes(l));
    check('E22① 两处模拟上位机的注入判定**逐字同口径**（冻结扣秒 + 窗口内改码两行在两处完全相同）',
      missing.length === 0,
      missing.length ? `**未逐字一致**：${missing.join('；')}` : `两处都含：${sameLines.join(' ｜ ')}`);

    /* ---- ② 工具模拟器：真进程 + 环境变量注入 + 真 --push（进程级可复跑） ---- */
    const injRecv = await startReceiver(P_INJ_PUSH);
    startTool(UPPER, ['--port', String(P_INJ_UPPER), '--push', `http://127.0.0.1:${P_INJ_PUSH}/realtime`,
      '--interval', '250', '--cycle', '12'], { MOCK_UPPER_ABNORMAL: '7', MOCK_UPPER_ABNORMAL_DUR: '4' });
    /* 窗口（真实经过秒 7～11）故意**跨过**"准备→运行"的分界（第 8 秒）：冻结成立时窗口内应全是「准备」 */
    const injDeadline = Date.now() + 14000;
    while (Date.now() < injDeadline && injRecv.received.length < 48) await sleep(250);
    const injFrames = injRecv.received.map(r => ({ stage: r.payload.stage, testStatus: r.payload.testStatus }));
    injRecv.server.close();
    if (!injFrames.length) {
      skip('E22① 工具模拟上位机：环境变量注入 → 真进程逐帧可观测',
        `端口 ${P_INJ_PUSH} 在 14 s 内没收到任何推送帧（环境不满足，不当作通过）`);
    } else {
      const winFrames = injFrames.filter(f => f.testStatus === 3);
      const winStages = [...new Set(winFrames.map(f => f.stage))];
      check('E22① 工具模拟上位机（真进程）：注入窗口内逐帧 testStatus=3 且 stage 冻结在「准备」——' +
        '窗口跨过第 8 秒（未注入时该秒已是「运行」），冻结成立才会全是「准备」',
        winFrames.length >= 4 && winStages.length === 1 && winStages[0] === '准备',
        `收到 ${injFrames.length} 帧，其中码 3 共 ${winFrames.length} 帧，阶段集合 = {${winStages.join('/')}}` +
        `（期望 {准备}；若为 {准备/运行} 说明阶段在异常期间仍在推进）`);
      check('E22① 工具模拟上位机（真进程）：码 3 只出现在注入窗口内，窗口无关帧不受影响',
        winFrames.length < injFrames.length &&
        injFrames.slice(0, Math.max(0, injFrames.indexOf(winFrames[0]))).every(f => f.testStatus !== 3) &&
        injFrames.slice(injFrames.lastIndexOf(winFrames[winFrames.length - 1]) + 1).every(f => f.testStatus !== 3),
        `码 3 首次出现在第 ${injFrames.indexOf(winFrames[0]) + 1} 帧、末次在第 ${injFrames.lastIndexOf(winFrames[winFrames.length - 1]) + 1} 帧（共 ${injFrames.length} 帧）`);
      const afterWin = injFrames.slice(injFrames.lastIndexOf(winFrames[winFrames.length - 1]) + 1);
      check('E22① 工具模拟上位机（真进程）：窗口结束后**恢复推进**（后续帧不再是 3，且出现「运行」等正常阶段）',
        afterWin.length > 0 && afterWin.every(f => f.testStatus !== 3) &&
        new Set(afterWin.map(f => f.stage)).size >= 1 &&
        afterWin.every(f => ['准备', '运行', '判定', '完成'].includes(f.stage)),
        afterWin.length ? `窗口后 ${afterWin.length} 帧阶段集合 = {${[...new Set(afterWin.map(f => f.stage))].join('/')}}、码集合 = {${[...new Set(afterWin.map(f => f.testStatus))].join('/')}}`
          : '窗口后没有帧（观察窗太短）');
    }
  }

  /* ===== T7 转换工具的**工具级守据**（E107：E14／E15／E106 的行为原来只有 `._verify` 里的
     一次性夹具，**没有任何门禁会因它们退化而变红**）=====
     背景（`项目记录\后续路线图.md` 的 `E107` 行 ＋ 座位 10 在 `T-20261005-02` 回执里的普查）：
       在门禁里搜 `请先关闭`／`FileShare`／`BOM SELF-CHECK`／`exit 3` **全部 0 命中**
       ⇒ 只要有人"顺手重构"，占用提示可以退化回 IO 异常、BOM 自检可以变成恒真式、
       安全写可以退回"先删旧件再写"…… **门禁照绿**。本节把这三条钉住。

     ── 判据为什么不写"全文子串"（`E151`／`E158` 的教训）──
     静态证据一律在**剥掉注释与字符串之后的代码文本**上判（`stripPsCommentsAndStrings`），
     并对**逐字节冻结区**取 SHA256 锚点：锚点一变即红，且报出"该区已改，请重新复核"。
     只查"字面串在场"的写法正是 `E151` 说的**装饰性守护**（形状在场、语义不在）。

     ── 为什么必须真跑工具，且为什么只在 `._verify` 的副本上跑 ──
     "占用时给可读提示并保住旧件""缺 BOM 必退 3""失败时不毁旧件"都是**行为**，
     光读源码证不了 ⇒ 本节用 `tests\._verify\tools-check-guards\` 下的**字节副本**真跑
     （仓库真文件全程只读，跑完用 `Buffer.compare` 逐字节复核）；产物与残留全部落在该目录内。

     ── 如实边界（不粉饰）──
     ① `E15` 的"缺 BOM ⇒ 退 3"在**本仓这两个脚本上跑不出来**：它们正文含大量中文，PS 5.1
        按 CP936 读**BOM-less** 文件会**先解析失败**，脚本内任何自检都来不及跑（工具说明第十节
        已记载，本门禁实测复现）；故契约用**同一段自检代码的 ASCII 孪生驱动**证明（正对照），
        并在真脚本上实测"自检被改成恒真 ⇒ 坏正文照样产出 ⇒ 必红"（反面）。
     ② stderr 按 **GBK** 回读：PS 5.1 把中文写进重定向流是 GBK 字节，按 UTF-8 读会得到乱码，
        照乱码写断言就等于没断言。 */
  section('T7 转换工具的守据：E14 占用预检 / E15 BOM 自检 / E106 安全写（E107）');
  {
    const GUARD_DIR = path.join(ROOT, 'tests', '._verify', 'tools-check-guards');
    const PS = process.env.DSH_POWERSHELL || 'powershell.exe';
    const TEXTS = [{ rel: 'tools/md2docx.ps1', tag: 'md' }, { rel: 'tools/md2docx-img.ps1', tag: 'img' }];

    /** `true` 当且仅当剥离器在**整份文件**上真的跑完（防"剥离器半路失效 ⇒ 判据看不见东西
     *  却照样判绿"—— 这正是 `E160` 的教训）。判法：剥后文本与原文**逐字符长度相同**（约定），
     *  且换行数相同、且至少剥掉了 1 个字符。 */
    function strippedWholeFile(src) {
      const out = stripPsCommentsAndStrings(src);
      return { ok: out.length === src.length && (out.match(/\n/g) || []).length === (src.match(/\n/g) || []).length && out !== src, out };
    }

    /** **PowerShell 专用的"剥注释/字符串"**（`E151` 口径：判据只认代码里的形态）。
     *  为什么不直接用 `tests\lib\assert.js` 的 `stripLiterals`（**单一真源**，`harness-check` 也用同一个
     *  函数对象）：那是 **JS** 的词法
     *  （`//`、块注释、`'…'`），而本仓的 `.ps1` 用 `#` 行注释 ＋ `<# #>` 块注释 ⇒
     *  用 JS 剥离器会把**注释里的 `Remove-Item $target`** 当成代码（首版实测：E106-③
     *  被一句纯注释判红 ⇒ 假红）。两者都是"内容换成空格、长度与换行不变"，可互换使用。
     *  覆盖：`#` 行注释、`<# … #>` 块注释、`'…'`（`''` 为转义）、`"…"`（反引号转义）、
     *  单引号 here-string `@' … '@`、双引号 here-string `@" … "@`。
     *  容错口径：未闭合的字符串止于行尾（宁可多剥，不可漏剥 —— 与 JS 那份同口径）。 */
    function stripPsCommentsAndStrings(src) {
      const out = src.split('');
      const n = src.length;
      const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
      let mode = 'code';
      let i = 0;
      while (i < n) {
        const c = src[i]; const c2 = src[i + 1]; const c3 = src[i + 2];
        if (mode === 'code') {
          if (c === '<' && c2 === '#') { blank(i, i + 2); mode = 'block'; i += 2; continue; }
          if (c === '#') { blank(i, i + 1); mode = 'line'; i++; continue; }
          if (c === '@' && (c2 === "'" || c2 === '"')) { blank(i, i + 2); mode = c2 === "'" ? 'hsq' : 'hdq'; i += 2; continue; }
          if (c === "'") { blank(i, i + 1); mode = 'sq'; i++; continue; }
          if (c === '"') { blank(i, i + 1); mode = 'dq'; i++; continue; }
          i++; continue;
        }
        if (mode === 'line') { blank(i, i + 1); if (c === '\n') mode = 'code'; i++; continue; }
        if (mode === 'block') {
          if (c === '#' && c2 === '>') { blank(i, i + 2); mode = 'code'; i += 2; continue; }
          blank(i, i + 1); i++; continue;
        }
        if (mode === 'hsq' || mode === 'hdq') {
          const q = mode === 'hsq' ? "'" : '"';
          if (c === '@' && c2 === q && (i === 0 || src[i - 1] === '\n')) { blank(i, i + 2); mode = 'code'; i += 2; continue; }
          blank(i, i + 1); i++; continue;
        }
        if (mode === 'sq') {
          if (c === "'" && c2 === "'") { blank(i, i + 2); i += 2; continue; }   /* PS 的 '' 是转义的单引号 */
          if (c === "'") { blank(i, i + 1); mode = 'code'; i++; continue; }
          if (c === '\n') { mode = 'code'; i++; continue; }
          blank(i, i + 1); i++; continue;
        }
        if (mode === 'dq') {
          if (c === '`') { blank(i, i + 2); i += 2; continue; }                 /* PS 的转义符是反引号 */
          if (c === '"' && c2 === '"') { blank(i, i + 2); i += 2; continue; }
          if (c === '"') { blank(i, i + 1); mode = 'code'; i++; continue; }
          if (c === '\n') { mode = 'code'; i++; continue; }
          blank(i, i + 1); i++; continue;
        }
        void c3;
        blank(i, i + 1); i++;
      }
      return out.join('');
    }

    /** 取"以 `start` 子串为起、以 `end` 子串为止"的**原始字节区间**（`end` 不含）。
     *  用于 `E15` 自检区的**逐字节冻结**（原文里是逐字节扫描自己的字节，不可失真）。 */
    function regionBytes(buf, start, end) {
      const a = buf.indexOf(Buffer.from(start, 'utf8'));
      const z = a < 0 ? -1 : buf.indexOf(Buffer.from(end, 'utf8'), a);
      return a < 0 || z < 0 ? null : buf.subarray(a, z);
    }
    const sha256 = b => require('node:crypto').createHash('sha256').update(b).digest('hex').toUpperCase();
    const h16 = b => sha256(b).slice(0, 16);

    /** 按 `latin1` 视图在**原始字节串**上做替换（与 `origin.toString('latin1')` 同一表达，
     *  否则中文锚点会因"UTF-8 文本 vs latin1 文本"两种表示而不命中）。 */
    const l1 = s => Buffer.from(s, 'utf8').toString('latin1');

    /** 解码子进程输出：**先严格 UTF-8，失败退 GBK**（PS 5.1 的中文重定向流是 GBK 字节）。 */
    function decodePs(buf) {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch { try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('latin1'); } }
    }

    /** 跑一个 `.ps1`：stdio 一律**落文件**（沙箱下不给子进程接管道），退出码＝脚本自身退出码。 */
    function runPs(scriptAbs, args, cwd, logName) {
      const log = path.join(GUARD_DIR, logName);
      const fd = fs.openSync(log, 'w');
      let code; let spawnError = '';
      try {
        require('node:child_process').execFileSync(PS,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptAbs].concat(args),
          { stdio: ['ignore', fd, fd], cwd: cwd || GUARD_DIR });
        code = 0;
      } catch (e) {
        code = e.status === undefined ? -1 : e.status;
        if (e.status === undefined) spawnError = String(e.code || e.message || e);
      } finally { fs.closeSync(fd); }
      return { code, spawnError, out: decodePs(fs.readFileSync(log)) };
    }

    const SRC_MD = ['# 工具守据探针', '', '一段中文正文，含**加粗**与 `行内代码`。', '',
      '| 列 | 值 |', '| --- | --- |', '| 甲 | 乙 |', '', '- 第一项', '- 第二项'].join('\n') + '\n';
    const OLD_BYTES = Buffer.from('OLD-DOCX-BYTES-KEEP-ME', 'utf8');
    /** 锁持有者（**纯 ASCII** —— BOM-less 的 `.ps1` 含中文本身就是 E15 那个病）：
     *  以 `FileShare::None` 独占**只读**打开目标 ⇒ 等价于"Word/WPS 正开着这份文档"。
     *  就绪信号走**另一个文件**：目标本身被独占锁着，`openSync(target)` 是拿不到锁的
     *  （首版实测 `EBUSY` 把门禁自己打崩 —— 那是最坏的一种假红）。 */
    const LOCK_HOLDER = [
      'param([Parameter(Mandatory=$true)][string]$Target, [Parameter(Mandatory=$true)][string]$ReadyMarker)',
      '$ErrorActionPreference = "Stop"',
      '$fs = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)',
      'try {',
      '  $utf8 = New-Object System.Text.UTF8Encoding($false)',
      '  [System.IO.File]::WriteAllText($ReadyMarker, ("LOCKED pid=" + $PID), $utf8)',
      '  Start-Sleep -Seconds 12',
      '} finally { $fs.Dispose() }',
      ''
    ].join('\r\n');

    /* ---- 夹具：把两个真工具的**原样字节**连同源 md 拷进 `._verify`（真文件只读） ----
       每轮先把本节的私有工作目录清干净（`env.removeLinkSafe` —— 本仓唯一的"安全删除"出口，
       `E46`：先 `lstat` 判链接、是链接只拆链不递归）；工作目录固定在 `._verify` 内。 */
    const ORIGIN = {};
    if (fs.existsSync(GUARD_DIR)) env.removeLinkSafe(GUARD_DIR, { recursive: true, force: true });
    fs.mkdirSync(GUARD_DIR, { recursive: true });
    fs.writeFileSync(path.join(GUARD_DIR, 'lock-holder.ps1'), LOCK_HOLDER, 'latin1');
    for (const t of TEXTS) {
      const abs = path.join(ROOT, ...t.rel.split('/'));
      const bytes = fs.readFileSync(abs);
      ORIGIN[t.tag] = { bytes, sha: sha256(bytes), bom: bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF };
      const dir = path.join(GUARD_DIR, t.tag);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'origin.ps1'), bytes);
      fs.writeFileSync(path.join(dir, 'in.md'), SRC_MD, 'utf8');
      if (t.tag === 'img') {
        fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'img', 'p.png'), Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
      }
    }

    /** 一次真跑：私有目录 ＋ 旧件（可预置 `~$` 锁文件）＋ 可选用锁持有者独占目标。 */
    function realRun(tag, copyBytes, opts) {
      const o = opts || {};
      const base = path.join(GUARD_DIR, tag);
      const caseDir = path.join(base, 'case-' + o.name);
      fs.mkdirSync(caseDir, { recursive: true });
      const script = path.join(caseDir, 'tool.ps1');
      fs.writeFileSync(script, copyBytes);
      const srcMd = path.join(caseDir, 'in.md');
      fs.copyFileSync(path.join(base, 'in.md'), srcMd);
      if (tag === 'img') {
        fs.mkdirSync(path.join(caseDir, 'img'), { recursive: true });
        fs.copyFileSync(path.join(base, 'img', 'p.png'), path.join(caseDir, 'img', 'p.png'));
      }
      if (o.siblingLock) fs.writeFileSync(path.join(caseDir, '~$out.docx'), 'LOCK');
      const target = path.join(caseDir, 'out.docx');
      if (o.oldTarget !== false) fs.writeFileSync(target, OLD_BYTES);
      let holder = null;
      let lockReady = true;
      if (o.lockTarget) {
        const marker = path.join(caseDir, 'lock-ready.txt');
        holder = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
          path.join(GUARD_DIR, 'lock-holder.ps1'), '-Target', target, '-ReadyMarker', marker], { stdio: 'ignore' });
        const t0 = Date.now();
        while (Date.now() - t0 < 8000 && !fs.existsSync(marker)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
        /* 锁没起来 ⇒ 这一轮的"占用"前提不成立：如实置位，**绝不当成"预检通过"** */
        lockReady = fs.existsSync(marker);
      }
      let r;
      try {
        r = runPs(script, ['-InPath', srcMd, '-OutPath', target, '-DocTitle', 'probe'], caseDir,
          `run-${tag}-${o.name}.out.txt`);
      } finally {
        if (holder) {
          try { holder.kill(); } catch (e) { /* 已退出 */ }
          /* 独占锁是**操作系统级**的：进程死了句柄不一定马上释放 ⇒ 等到能读了再读，
             否则 `readFileSync` 会抛 `EBUSY` 把**门禁自己**打崩（首版实测：最坏的一种假红）。 */
          const t0 = Date.now();
          for (;;) {
            try { fs.closeSync(fs.openSync(target, 'r')); break; } catch (e) { /* 还没释放 */ }
            if (Date.now() - t0 > 5000) break;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          }
        }
      }
      let exists = false;
      let bytes = null;
      try {
        exists = fs.existsSync(target);
        bytes = exists ? fs.readFileSync(target) : null;
      } catch (e) {
        /* 仍被外部句柄占住 ⇒ 如实标注（读数记为"读不到"，绝不当作"旧件原样"） */
        r.readError = e.code || String(e);
        exists = false;
      }
      r.exists = exists;
      r.lockReady = lockReady;
      r.oldKept = bytes ? bytes.equals(OLD_BYTES) : false;
      r.size = bytes ? bytes.length : 0;
      r.residue = fs.readdirSync(caseDir).filter(n => n.startsWith('._') || n === '_md2docx_pkg.new' || /\.md2docx\.bak$/.test(n));
      return r;
    }

    /* ---- 逐字节冻结区的 SHA256 锚点（改了就红；见本节头部"判据卫生"）---- */
    /*  `E15` 区：从"入口 BOM 自检"小标题到"目标占用预检"小标题之间（自检自身逐字节扫描本文件）。 */
    /*  `E106` 区：从打包函数定义到"E106-SWAP:"标记之间（临时件 ⇒ 自证 ⇒ 只落位不删旧件）。 */
    const E15_START = '# ===== E15 入口 BOM 自检';
    const E15_END = '# ===== E14 目标占用预检';
    const E106_PACK_END = '# 把**已经完整**的临时件落位到目标';
    const E106_SWAP_END = 'E106-SWAP:';
    const FROZEN = {
      md: {
        e15: 'B3F2082BC6D5EF3ECC762076E8B0CA34DE6884B9DFDFD62BC31EBA1028C6735C',
        pack: 'D834203A63186D9310C3983EDDD0CEA84AA2874EB6752D428049C0CF74D602CF',
        swap: 'C0FF74ECA662A594CA7F78F011AB0EA9DCC83679FAF18774623C01520CEE1725'
      },
      img: {
        e15: 'B3F2082BC6D5EF3ECC762076E8B0CA34DE6884B9DFDFD62BC31EBA1028C6735C',
        pack: 'D834203A63186D9310C3983EDDD0CEA84AA2874EB6752D428049C0CF74D602CF',
        swap: 'C0FF74ECA662A594CA7F78F011AB0EA9DCC83679FAF18774623C01520CEE1725'
      }
    };

    /* ---- E14-①：静态 —— 独占探测的**形态**必须在**剥注释/字符串后**的代码里在场 ---- */
    const staticScan = {};
    for (const t of TEXTS) {
      const src = ORIGIN[t.tag].bytes.toString('utf8');
      const st = strippedWholeFile(src);
      staticScan[t.tag] = {
        stripOk: st.ok,
        exclusiveOpen: /\[System\.IO\.File\]::Open\s*\([^)]*\[System\.IO\.FileShare\]::None\s*\)/.test(st.out),
        occupiedFn: /function\s+Write-Md2DocxOccupied\s*\(/.test(st.out),
        occupiedCall: /Write-Md2DocxOccupied\s+\$targetFile/.test(st.out),
        exit1: /exit\s+1/.test(st.out)
      };
    }
    check('E14-① 两个工具的"独占探测"是**代码**里的形态（剥注释/字符串后仍命中 `File::Open(…FileShare::None)`）'
      + '，且占用分支调用 `Write-Md2DocxOccupied $targetFile` 并 `exit 1`（不靠全文子串，E151 口径）',
      TEXTS.every(t => {
        const s = staticScan[t.tag];
        return s.stripOk && s.exclusiveOpen && s.occupiedFn && s.occupiedCall && s.exit1;
      }),
      TEXTS.map(t => {
        const s = staticScan[t.tag];
        return `${t.rel}：剥离完成=${s.stripOk} 独占探测=${s.exclusiveOpen} 占用函数=${s.occupiedFn} 调用点带目标=${s.occupiedCall} 退 1=${s.exit1}`;
      }).join('；'));

    /** E14-②：可读提示与 `~$` 锁文件名（**真跑**的一条 —— 提示必须落在 stderr 且按名点到锁文件） */
    const e14runs = {};
    for (const t of TEXTS) {
      e14runs[t.tag] = realRun(t.tag, ORIGIN[t.tag].bytes,
        { name: 'e14-locked', lockTarget: true, siblingLock: true });
    }
    const e14ok = t => {
      const r = e14runs[t.tag];
      return r.lockReady && r.code === 1 && r.exists && r.oldKept && r.out.includes('请先关闭')
        && r.out.includes('~$out.docx') && /being used by another process/.test(r.out);
    };
    check('E14-② 目标被**独占锁住**时真跑：退出码 1 ＋ stderr 出现可读提示"请先关闭"＋ **按名点到 `~$` 锁文件** '
      + '＋ 原因指向"被别的进程占用"＋ **旧件字节逐一未变**（提示不再退化成 IO 异常）',
      TEXTS.every(e14ok),
      TEXTS.map(t => {
        const r = e14runs[t.tag];
        return `${t.rel}：锁就绪=${r.lockReady} 退出码=${r.code} 旧件原样=${r.oldKept} 提示=${r.out.includes('请先关闭')} `
          + `锁文件名=${r.out.includes('~$out.docx')} 原因=${/being used by another process/.test(r.out)}`;
      }).join('；'));

    /* ---- E14 的 D22（内存字节变异 ⇒ 真跑 ⇒ 必红并指名）---- */
    const d22E14 = [
      ['E14-D22① 把预检的独占共享改成共享可写（`FileShare::None` ⇒ `ReadWrite`）⇒ 预检不再发现占用',
        b => Buffer.from(b.toString('latin1').replace(l1('[System.IO.FileShare]::None'), l1('[System.IO.FileShare]::ReadWrite')), 'latin1'),
        'E14-①', /独占探测=false/],
      ['E14-D22② 把可读提示文案换掉（"请先关闭" ⇒ 中性 "IO error"）⇒ 用户再也读不到真因',
        b => Buffer.from(b.toString('latin1').replace(l1('请先关闭 $leafName'), l1('IO error on $leafName')), 'latin1'),
        'E14-②', /提示=false/]
    ];
    for (const [label, mutate, expectName, expectDetail] of d22E14) {
      const per = [];
      for (const t of TEXTS) {
        const mut = mutate(ORIGIN[t.tag].bytes);
        const changed = Buffer.compare(mut, ORIGIN[t.tag].bytes) !== 0;
        const r = realRun(t.tag, mut, { name: 'e14-mut-' + expectName, lockTarget: true, siblingLock: true });
        const src = mut.toString('utf8');
        const s = strippedWholeFile(src);
        const staticOk = /\[System\.IO\.File\]::Open\s*\([^)]*\[System\.IO\.FileShare\]::None\s*\)/.test(s.out);
        const runtimeOk = r.lockReady && r.code === 1 && r.exists && r.oldKept && r.out.includes('请先关闭') && r.out.includes('~$out.docx');
        per.push({ tag: t.tag, changed, staticOk, runtimeOk, lockReady: r.lockReady, code: r.code, oldKept: r.oldKept });
      }
      const st = per.map(p => `${p.tag}：变异生效=${p.changed}、静态判据=${p.staticOk}、真跑判据=${p.runtimeOk}（锁就绪=${p.lockReady} 退出码=${p.code} 旧件原样=${p.oldKept}）`).join('；');
      const red = per.every(p => p.changed && p.lockReady && ((expectName === 'E14-①') ? !p.staticOk : !p.runtimeOk));
      const others = per.every(p => (expectName === 'E14-①') ? p.runtimeOk : p.staticOk);
      check(`${label} ⇒ ① 判据必红并**指名 ${expectName}** ② 另一条判据不受影响 ③ 盘上真工具逐字节未变`,
        red && others, `${st}；期望红的是 ${expectName}（另一条仍须成立）`);
    }

    /* ---- E15-①：自检区**逐字节冻结**（区间摘要锚点）＋ 契约字面在场 ---- */
    const e15info = {};
    for (const t of TEXTS) {
      const buf = ORIGIN[t.tag].bytes;
      const region = regionBytes(buf, E15_START, E15_END);
      e15info[t.tag] = { region, sha: region ? sha256(region) : '(取不到)', len: region ? region.length : 0 };
    }
    check('E15-① "BOM 自检区"逐字节未被动过（区间摘要锚点 ＝ 冻结值；改动即红并给出该区实际 SHA256 与长度）',
      TEXTS.every(t => e15info[t.tag].sha === FROZEN[t.tag].e15),
      TEXTS.map(t => `${t.rel}：区长=${e15info[t.tag].len} 实测 sha256=${e15info[t.tag].sha.slice(0, 16)}… `
        + `冻结=${FROZEN[t.tag].e15.slice(0, 16)}…（不等即须复核该区并同步锚点）`).join('；'));

    const e15src = {};
    for (const t of TEXTS) {
      const region = e15info[t.tag].region;
      e15src[t.tag] = {
        bomConst: region.includes(Buffer.from('$md2docxBom = [byte[]]@(0xEF,0xBB,0xBF)', 'utf8')),
        readsSelfBytes: /ReadAllBytes\(\$md2docxScriptPath\)/.test(region.toString('utf8')),
        cnProbe: region.includes(Buffer.from('$md2docxCnProbeText = "微软雅黑"', 'utf8')),
        failFn: region.includes(Buffer.from('New-Md2DocxBomFailure', 'utf8')),
        banner: region.includes(Buffer.from('BOM SELF-CHECK FAILED', 'utf8')),
        exit3: region.includes(Buffer.from('exit 3', 'utf8')),
        keyControl: region.includes(Buffer.from('if (-not $md2docxBomOk) {', 'utf8'))
          && region.includes(Buffer.from('if (-not $md2docxProbeFound) {', 'utf8')),
        readsBytesNotText: !/Get-Content/.test(region.toString('utf8'))
      };
    }
    check('E15-② 自检区的**契约**在场："前 3 字节必须是 EF BB BF" ＋ "本文件字节里必须还能找到中文探针的 '
      + 'UTF-8 序列" ＋ 失败首行 `BOM SELF-CHECK FAILED` ＋ **退 3** ＋ 两条控制流真的用了结果'
      + '（`if (-not …)`）＋ **只读原始字节**（不用 `Get-Content` 文本读取）',
      TEXTS.every(t => {
        const s = e15src[t.tag];
        return s.bomConst && s.readsSelfBytes && s.cnProbe && s.failFn && s.banner && s.exit3 && s.keyControl && s.readsBytesNotText;
      }),
      TEXTS.map(t => `${t.rel}：${JSON.stringify(e15src[t.tag])}`).join('；'));

    /* ---- E15-③：契约**可运行的**证明（ASCII 孪生正对照 ＋ 反面） ---- */
    const TPL = [
      'param([Parameter(Mandatory=$true)][string]$Probe)',
      '$scriptBytes = [System.IO.File]::ReadAllBytes($Probe)',
      '$ok = ($scriptBytes.Length -ge 3) -and ($scriptBytes[0] -eq 0xEF) -and ($scriptBytes[1] -eq 0xBB) -and ($scriptBytes[2] -eq 0xBF)',
      'if (-not $ok) { [Console]::Error.WriteLine("  [FAIL] BOM SELF-CHECK FAILED - this script cannot produce a trustworthy .docx."); exit 3 }',
      '[Console]::Error.WriteLine("SELFCHECK-PASSED")',
      ''
    ].join('\r\n');
    const driver = path.join(GUARD_DIR, 'e15-driver.ps1');
    fs.writeFileSync(driver, TPL, 'latin1');
    const noBomFile = path.join(GUARD_DIR, 'e15-fake-nobom.ps1');
    const bomFile = path.join(GUARD_DIR, 'e15-fake-bom.ps1');
    fs.writeFileSync(noBomFile, 'Write-Output hi\r\n', 'latin1');
    fs.writeFileSync(bomFile, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('Write-Output hi\r\n', 'latin1')]));
    const twinNo = runPs(driver, ['-Probe', noBomFile], GUARD_DIR, 'run-e15-twin-nobom.out.txt');
    const twinYes = runPs(driver, ['-Probe', bomFile], GUARD_DIR, 'run-e15-twin-bom.out.txt');
    check('E15-③ 自检契约**可运行**（同一段自检代码的 ASCII 孪生驱动）：目标缺 BOM ⇒ 退 **3** 且 stderr 出现 '
      + '`BOM SELF-CHECK`；目标有 BOM ⇒ 退 0（正对照；"跳过 ≠ 通过"不适用 —— 这里两条都真跑了）',
      twinNo.code === 3 && twinNo.out.includes('BOM SELF-CHECK') && twinYes.code === 0 && twinYes.out.includes('SELFCHECK-PASSED'),
      `缺 BOM：退出码=${twinNo.code}（期望 3）命中首行=${twinNo.out.includes('BOM SELF-CHECK')}；`
      + `有 BOM：退出码=${twinYes.code}（期望 0）`);

    /* E15 的反面：把 BOM 检查改成恒真 ⇒ 正文已损坏的脚本照样产出 docx（自检形同虚设）。 */
    const e15MutRuns = {};
    for (const t of TEXTS) {
      const mut = Buffer.from(ORIGIN[t.tag].bytes.toString('latin1')
        .replace('if (-not $md2docxBomOk) {', 'if ($false) {'), 'latin1');
      const changed = Buffer.compare(mut, ORIGIN[t.tag].bytes) !== 0;
      const region = regionBytes(mut, E15_START, E15_END);
      e15MutRuns[t.tag] = {
        changed, sha: region ? sha256(region) : '(取不到)',
        r: realRun(t.tag, mut, { name: 'e15-vacuous' })
      };
    }
    check('E15-④ D22 反面：把 BOM 检查改成**恒真**（`if (-not $mdxBomOk)` ⇒ `if ($false)`）⇒ '
      + '① 冻结锚点必红并指名（该区 SHA256 变了）② 真跑证明危害：正文未变的坏脚本照样写出 docx（自检形同虚设）',
      TEXTS.every(t => {
        const m = e15MutRuns[t.tag];
        return m.changed && m.sha !== FROZEN[t.tag].e15 && m.r.code === 0 && m.r.exists && m.r.size > 0 && !m.r.oldKept;
      }),
      TEXTS.map(t => {
        const m = e15MutRuns[t.tag];
        return `${t.rel}：变异生效=${m.changed} 锚点由 ${FROZEN[t.tag].e15.slice(0, 12)}… 变为 ${m.sha.slice(0, 12)}…（必红）；`
          + `真跑退出码=${m.r.code}、目标被新件覆盖=${m.r.exists && !m.r.oldKept}（大小 ${m.r.size} 字节）`;
      }).join('；'));

    /* ---- E106-①：静态 —— 安全写三件事（不删旧件 ＋ 临时件 ＋ 一次原子替换）＋ 残留白名单 ----
       注：两个脚本的**目标变量名不同**（`md2docx.ps1` 用 `$OutPath`、`md2docx-img.ps1` 用
       `$outFull`）⇒ 判据一律用 `$TARGET_VAR` 形态类（`$(?:OutPath|outFull|TargetPath)`），
       写死某一个名字会在另一个脚本上**假红**（首版实测）。 */
    const TARGET_VAR = '\\$(?:OutPath|outFull|TargetPath)\\b';
    /*  "安全写窗口"内允许出现的删除目标白名单（临时件／构建目录／备份件／构建目录内的条目） */
    const DEL_WHITELIST = /\$(?:zipTemp|build|buildDir|bak|bakResidue)\b|\$_\.FullName\b/;
    const e106 = {};
    for (const t of TEXTS) {
      const buf = ORIGIN[t.tag].bytes;
      /*  打包区 ＝ 打包函数定义 → 落位函数前（**落位动作在它之外**，故这里必须"碰不到目标"）；
          落位区 ＝ 落位函数定义 → `E106-SWAP:` 标记（**唯一**允许动到旧件的地方）。 */
      const packRegion = regionBytes(buf, 'function New-DocxPackage', '# 把**已经完整**的临时件落位到目标');
      const swapRegion = regionBytes(buf, 'function Set-DocxAtomically', 'E106-SWAP:');
      const winRegion = regionBytes(buf, 'function New-DocxPackage', 'E106-SWAP:');
      const tailRegion = (() => {
        const s = buf.toString('utf8');
        const a = s.indexOf('E106-SWAP:');
        const z = s.indexOf('} finally { Clear-Md2DocxResidue }');
        return a < 0 || z < 0 ? null : s.slice(a, z);
      })();
      const pack = packRegion ? strippedWholeFile(packRegion.toString('utf8')).out : '';
      const win = winRegion ? strippedWholeFile(winRegion.toString('utf8')).out : '';
      const swap = swapRegion ? strippedWholeFile(swapRegion.toString('utf8')).out : '';
      const tail = tailRegion ? strippedWholeFile(tailRegion).out : '';
      /* 判据口径（否定式）：在"安全写窗口"（打包函数 → `E106-SWAP:` 落位动作之前）内，
         每一句删除调用的目标**都必须落在这个白名单里**（临时件／构建目录／备份件／构建目录内的条目），
         即**不存在一句"删到目标"的语句**。这正是 `E106` 的成因形态（旧逻辑第一句 `Remove-Item $target`）。 */
      const stmts = win.split(/\r?\n/).map(l => l.trim())
        .filter(l => /(?:^|[\s;{])(?:Remove-Item|Remove-ItemProperty)\b/.test(l));
      const offWhitelist = stmts.filter(l => !DEL_WHITELIST.test(l));
      /*  否定式的**精确口径**：窗口内**任何一句删除调用**的目标都不得是目标变量。 */
      const targetRe = new RegExp(TARGET_VAR);
      const resetRe = new RegExp(TARGET_VAR + '\\s*=\\s*\\$false\\)');
      const reachesTarget = stmts.some(l => targetRe.test(l))
        || /\[System\.IO\.File\]::Delete/.test(win)
        || /(?:^|[\s;{])(?:del|erase|rd|rmdir)\s/i.test(win)
        || resetRe.test(win);
      e106[t.tag] = {
        packLen: packRegion ? packRegion.length : 0,
        packSha: packRegion ? sha256(packRegion) : '(取不到)',
        winSha: winRegion ? sha256(winRegion) : '(取不到)',
        swapLen: swapRegion ? swapRegion.length : 0,
        swapSha: swapRegion ? sha256(swapRegion) : '(取不到)',
        fnSig: /function\s+New-DocxPackage\s*\(\s*\[string\]\s*\$SourceDir\s*\)/.test(pack),
        tempName: winRegion ? winRegion.toString('utf8').includes('_md2docx_pkg.new') : false,
        selfCheck: /ZipFile\]::OpenRead\(\$zipTemp\)/.test(win),
        delStmts: stmts.length, offWhitelist, reachesTarget,
        fnSigLands: /function\s+Set-DocxAtomically\s*\(\s*\[string\]\s*\$TempPath\s*,\s*\[string\]\s*\$TargetPath\s*\)/.test(swap),
        usedInReplace: /\[System\.IO\.File\]::Replace\s*\(\s*\$TempPath\s*,\s*\$TargetPath/.test(swap),
        usedInMove: /\[System\.IO\.File\]::Move\s*\(\s*\$TempPath\s*,\s*\$TargetPath/.test(swap),
        callPassesTemp: new RegExp('Set-DocxAtomically\\s+\\$pkgTempFile\\s+'
          + '\\$(?:OutPath|outFull)\\b').test(tail),
        swapMarks: buf.toString('latin1').indexOf(l1('E106-SWAP:')) >= 0
          && buf.toString('latin1').indexOf(l1('E106-SWAP-REPLACE:')) >= 0,
        whitelist: buf.toString('latin1').includes(l1('._docx_build'))
      };
    }
    check('E106-① "安全写"的**形态**在剥注释/字符串后的代码里在场：打包函数**不接收目标路径**'
      + '（签名只有 `$SourceDir`）⇒ 结构上碰不到旧件；临时件 `_md2docx_pkg.new` ＋ 自证（`OpenRead`）＋ '
      + '落位只由 `File::Replace($TempPath,$TargetPath)` / `File::Move` 完成，且**唯一**的落位调用把'
      + '临时件与目标一起传入（`Set-DocxAtomically $pkgTempFile $OutPath`）',
      TEXTS.every(t => {
        const e = e106[t.tag];
        return e.fnSig && e.tempName && e.selfCheck && e.fnSigLands
          && (e.usedInReplace || e.usedInMove) && e.callPassesTemp && e.swapMarks;
      }),
      TEXTS.map(t => {
        const e = e106[t.tag];
        return `${t.rel}：${JSON.stringify({ 打包签名无目标: e.fnSig, 临时件: e.tempName, 自证: e.selfCheck,
          落位签名: e.fnSigLands, 原子替换: e.usedInReplace, 改名: e.usedInMove, 落位调用: e.callPassesTemp, 标记: e.swapMarks })}`;
      }).join('；'));

    check('E106-② 两个冻结区**逐字节未被动**（打包区 ＋ 落位区各自的区间摘要锚点 ＝ 冻结值）'
      + '—— 任何人改这两段都必须重跑本节的 D22 并同步锚点',
      TEXTS.every(t => e106[t.tag].packSha === FROZEN[t.tag].pack && e106[t.tag].swapSha === FROZEN[t.tag].swap),
      TEXTS.map(t => `${t.rel}：打包区 ${e106[t.tag].packLen} B sha256=${e106[t.tag].packSha.slice(0, 16)}…`
        + `（冻结 ${FROZEN[t.tag].pack.slice(0, 16)}…）；落位区 ${e106[t.tag].swapLen} B `
        + `sha256=${e106[t.tag].swapSha.slice(0, 16)}…（冻结 ${FROZEN[t.tag].swap.slice(0, 16)}…）`).join('；'));

    check('E106-③ **否定式**判据：在"安全写窗口"（打包函数 → 落位动作之前）里，每一句删除调用的目标'
      + '**都必须**落在白名单内（`$zipTemp` / `$build` / `$buildDir` / `$bak` / `$bakResidue` / 构建目录内条目），'
      + '且**任何一句删除调用的目标都不是目标变量**（`$OutPath`／`$outFull`／`$TargetPath`）'
      + '、整段也不出现 `File::Delete`／`del`／`rd` 形态 —— 即"结构上不可能删到旧件"'
      + '（这正是 `E106` 的成因形态：旧逻辑第一句就是删目标）',
      TEXTS.every(t => {
        const e = e106[t.tag];
        return e.offWhitelist.length === 0 && !e.reachesTarget && e.delStmts >= 1;
      }),
      TEXTS.map(t => {
        const e = e106[t.tag];
        return `${t.rel}：窗口内删除语句 ${e.delStmts} 句、其中目标不在白名单的 ${e.offWhitelist.length} 句`
          + `（${e.offWhitelist.join(' ｜ ') || '无'}）；触碰目标变量＝${e.reachesTarget}`;
      }).join('；'));

    /* ---- E106-D22：把"先删目标再替换"插回**落位函数** ⇒ 必红并指名 E106-③ ---- */
    for (const t of TEXTS) {
      const s = ORIGIN[t.tag].bytes.toString('latin1');
      const anchor = '  $item = Get-Item -LiteralPath $TargetPath -Force\n';
      /* 危险形态由**片段拼接**构造：本文件里不出现可直接复制的一句完整危险命令 */
      const badStmt = '  ' + ['Remove', 'Item'].join('-') + ' -LiteralPath $TargetPath -Force -ErrorAction Stop\n';
      const mut = Buffer.from(s.replace(anchor, badStmt + anchor), 'latin1');
      const changed = Buffer.compare(mut, ORIGIN[t.tag].bytes) !== 0;
      /* 判据侧复算（与 E106-③ 同一口径）：打包区被"触碰目标"污染 ⇒ 必红 */
      const mPack = regionBytes(mut, 'function New-DocxPackage', E106_PACK_END);
      const mCode = mPack ? strippedWholeFile(mPack.toString('utf8')).out : '';
      const mWin = regionBytes(mut, 'function New-DocxPackage', E106_SWAP_END);
      const mWinCode = mWin ? strippedWholeFile(mWin.toString('utf8')).out : '';
      const mStmts = mWinCode.split(/\r?\n/).map(l => l.trim())
        .filter(l => /(?:^|[\s;{])(?:Remove-Item|Remove-ItemProperty)\b/.test(l));
      const nowDangerous = mStmts.some(l => !DEL_WHITELIST.test(l))
        || mStmts.some(l => new RegExp(TARGET_VAR).test(l))
        || /\[System\.IO\.File\]::Delete/.test(mWinCode)
        || /(?:^|[\s;{])(?:del|erase|rd|rmdir)\s/i.test(mWinCode) || !mCode;
      const mSwap = regionBytes(mut, 'function Set-DocxAtomically', E106_SWAP_END);
      const r = realRun(t.tag, mut, { name: 'e106-mut-' + t.tag });
      check(`E106-D22 把"先删目标再替换"插回落位函数（${t.rel}）⇒ ① E106-③ 必红并指名`
        + ` ② 真跑证明危害：退出码≠0 **且旧件被毁（目标不存在）** ③ 盘上真工具逐字节未变`,
        changed && nowDangerous && mSwap !== null && r.code !== 0 && !r.exists && !r.oldKept,
        `${t.rel}：变异生效=${changed} 复算 E106-③ 命中"删到非临时件/触碰目标"=${nowDangerous}（⇒ 必红）；`
        + `真跑退出码=${r.code}（期望非 0）目标还存在=${r.exists}（期望 false）`
        + `旧件原样=${r.oldKept}；未变异同场景见 E106-④`);
    }

    /* ---- E106-④：未变异同场景必绿（排除"本来就红"）＋ 成功路径不留白名单外的残留 ---- */
    const e106Runs = {};
    for (const t of TEXTS) {
      e106Runs[t.tag] = realRun(t.tag, ORIGIN[t.tag].bytes, { name: 'e106-origin' });
    }
    check('E106-④ 未变异的当前工具在同场景（目标已存在）真跑必绿：退出码 0 ＋ 产出新件（覆盖旧件）'
      + '＋ **不在目标目录留下白名单外的残留**（白名单＝`._docx_build` / `_md2docx_pkg.new` / `*.md2docx.bak`，'
      + '都只允许瞬时存在）',
      TEXTS.every(t => {
        const r = e106Runs[t.tag];
        return r.code === 0 && r.exists && !r.oldKept && r.size > 0 && r.residue.length === 0;
      }),
      TEXTS.map(t => {
        const r = e106Runs[t.tag];
        return `${t.rel}：退出码=${r.code} 新件大小=${r.size} 残留=[${r.residue.join('、')}]`;
      }).join('；'));

    check('残留白名单自证：本节的跑法只可能产生 `._docx_build` / `_md2docx_pkg.new` / `*.md2docx.bak` 三类，'
      + '且工作区（`._verify\\tools-check-guards`）与仓库内**都应为 0** —— 逐条给出实测数',
      (() => {
        const names = [];
        for (const dir of [GUARD_DIR, path.join(ROOT, '输出文件'), path.join(ROOT, 'tools'), ROOT]) {
          if (!fs.existsSync(dir)) continue;
          for (const n of fs.readdirSync(dir)) {
            if (n.startsWith('._docx_build') || n === '_md2docx_pkg.new' || /\.md2docx\.bak$/.test(n)) names.push(path.join(dir, n));
          }
        }
        return names.length === 0;
      })(),
      '扫描面：`._verify\\tools-check-guards` 顶层 ＋ 仓库根/`tools`/`输出文件` 顶层；命中即列出');

    /* ---- 真工具字节复核（本节的**全部**运行都在副本上 ⇒ 真文件必须逐字节未变）---- */
    check('T7 收口：两个真 `.ps1` 在本节全程只读、逐字节未变（`Buffer.compare`）＋ BOM 仍在'
      + '（`edit` 工具会吃 BOM ⇒ 这条同时是 E15 那半静态守据的复核）',
      TEXTS.every(t => {
        const now = fs.readFileSync(path.join(ROOT, ...t.rel.split('/')));
        return Buffer.compare(now, ORIGIN[t.tag].bytes) === 0 && ORIGIN[t.tag].bom;
      }),
      TEXTS.map(t => {
        const now = fs.readFileSync(path.join(ROOT, ...t.rel.split('/')));
        return `${t.rel}：sha256=${h16(now)}… 与本节开头一致=${Buffer.compare(now, ORIGIN[t.tag].bytes) === 0} BOM=${ORIGIN[t.tag].bom}`;
      }).join('；'));

    /* 读数留痕：把三支的锚点与真跑结论落进 `._verify`（人工复核用；不写受管文件） */
    fs.writeFileSync(path.join(GUARD_DIR, 'guards-report.json'), JSON.stringify({
      at: new Date().toISOString(),
      origin: Object.keys(ORIGIN).map(k => ({ tag: k, sha256: ORIGIN[k].sha, bom: ORIGIN[k].bom })),
      frozen: FROZEN, e15: { md: e15info.md.sha, img: e15info.img.sha },
      pack: { md: e106.md.packSha, img: e106.img.packSha }, swap: { md: e106.md.swapSha, img: e106.img.swapSha },
      e14: TEXTS.map(t => ({ rel: t.rel, code: e14runs[t.tag].code, lockReady: e14runs[t.tag].lockReady, oldKept: e14runs[t.tag].oldKept, prompt: e14runs[t.tag].out.includes('请先关闭') })),
      e106runs: TEXTS.map(t => ({ rel: t.rel, code: e106Runs[t.tag].code, size: e106Runs[t.tag].size, residue: e106Runs[t.tag].residue }))
    }, null, 1) + '\n', 'utf8');
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
