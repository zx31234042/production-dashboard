#!/usr/bin/env node
/* ==========================================================================
   模拟上位机（tools/mock-upper/mock-upper.js）
   作用：在真实上位机接口（Q-21）到位前，模拟"相机系统 PC 上位机"对外提供实时测量数据。
   两种用法：
     ① 作为数据源被查询：启动 HTTP 服务，GET /realtime 返回一帧报文
     ② 作为推送方：用 --push <目标URL> 周期性 POST 报文到目标（联调时指向看板服务）
   字段契约：与 src/config/fieldMap.js 的 upperToBoard 键保持一致（改动须同步两处）
   依赖：仅 Node 内置模块，无需 npm install，不访问外网
   运行：node tools/mock-upper/mock-upper.js --help
   ========================================================================== */
'use strict';

const http = require('http');

/* ---------------- 命令行参数 ---------------- */
function parseArgs(argv) {
  const a = {
    port: 8801,             // HTTP 服务端口
    interval: 1000,         // 推送周期（毫秒）
    push: '',               // 推送目标 URL；为空则只提供服务不推送
    equip: 'SX-UNDERWATER-001',
    cycleSec: 160,          // 单件测试节拍（秒），与看板配置一致
    planQty: 180,
    once: false             // 只推一帧后退出
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--port') { a.port = Number(v); i++; }
    else if (k === '--interval') { a.interval = Number(v); i++; }
    else if (k === '--push') { a.push = v; i++; }
    else if (k === '--equip') { a.equip = v; i++; }
    else if (k === '--cycle') { a.cycleSec = Number(v); i++; }
    else if (k === '--plan') { a.planQty = Number(v); i++; }
    else if (k === '--once') { a.once = true; }
    else if (k === '--help' || k === '-h') { printHelp(); process.exit(0); }
  }
  return a;
}

function printHelp() {
  console.log(`
模拟上位机 —— 在真实接口（Q-21）到位前提供符合契约的实时测量数据

用法：
  node tools/mock-upper/mock-upper.js [参数]

参数：
  --port <n>         HTTP 服务端口，默认 8801
  --interval <ms>    推送周期（毫秒），默认 1000
  --push <url>       周期性 POST 报文到该地址（如 http://127.0.0.1:8802/service/upper/realtime）
  --equip <code>     设备编号，默认 SX-UNDERWATER-001
  --cycle <sec>      单件测试节拍（秒），默认 160
  --plan <n>         当班计划数量，默认 180
  --once             只发送一帧后退出（用于连通性自测）
  --help             显示本帮助

提供的接口：
  GET /realtime      返回一帧实时报文（JSON）
  GET /sample        同 /realtime
  GET /health        健康检查

示例：
  # 只看一帧报文
  node tools/mock-upper/mock-upper.js --once --push http://127.0.0.1:8802/service/upper/realtime

  # 起服务，供看板或联调方按 1s 轮询
  node tools/mock-upper/mock-upper.js --port 8801
`);
}

/* ---------------- 内部状态与报文生成 ---------------- */
const pad = n => String(n).padStart(2, '0');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round2 = v => Math.round(v * 100) / 100;
const round1 = v => Math.round(v * 10) / 10;

let inner = null;
let seq = 0;

function initInner(now) {
  return {
    depth: 5.00, vx: 5.00, vy: 0.10,
    fpsRaw: 400, gainRaw: 2.5, shutterRaw: 500,
    cameraDepth: 12.00,
    startedAt: now
  };
}

/** 产生一帧符合契约的报文（字段须与 src/config/fieldMap.js 的 upperToBoard 键一致） */
function nextPayload(args, now) {
  if (!inner) inner = initInner(now);
  const s = inner;

  /* 航行器深度：量程 [4, 6] m（需求 C-86），演示游走 [4.77, 5.33]、步长 ±0.06/s ——
     与 src/services/mockUpperSource.js / src/services/mockData.js **同一组数值**（三处同口径），
     避免"经工具产出的报文"与"经 mockUpperSource 产出的报文"在航行器深度上互相矛盾。
     速度同口径：vx 游走 [4.78, 5.22]、步长 ±0.06/s。
     注：cameraDepth（相机自身水下深度）与 stdDepth（相机设定深度）是**另外的物理量**，不随之迁移。 */
  s.depth = clamp(round2(s.depth + (Math.random() - 0.5) * 0.12), 4.77, 5.33);
  s.vx = clamp(round2(s.vx + (Math.random() - 0.5) * 0.12), 4.78, 5.22);
  s.vy = clamp(round2(s.vy + (Math.random() - 0.5) * 0.04), -0.25, 0.35);
  const speed = round2(Math.sqrt(s.vx * s.vx + s.vy * s.vy));

  s.fpsRaw = clamp(s.fpsRaw + (Math.random() - 0.5) * 1.6, 396, 404);
  s.gainRaw = clamp(s.gainRaw + (Math.random() - 0.5) * 0.06, 2.35, 2.65);
  s.shutterRaw = clamp(s.shutterRaw + (Math.random() - 0.5) * 6, 488, 512);
  s.cameraDepth = clamp(round2(s.cameraDepth + (Math.random() - 0.5) * 0.04), 11.80, 12.20);

  const elapsed = Math.floor((now - s.startedAt) / 1000);
  const unitSec = elapsed % args.cycleSec;
  const progress = unitSec / args.cycleSec;
  const unitIndex = Math.floor(elapsed / args.cycleSec) + 1;

  let stage, result, testStatus;
  if (unitSec < 8)          { stage = '准备'; result = '待测试'; testStatus = 0; }
  else if (progress < 0.85) { stage = '运行'; result = '测试中'; testStatus = 1; }
  else if (progress < 0.97) { stage = '判定'; result = '测试中'; testStatus = 1; }
  else                      { stage = '完成'; result = '测试中'; testStatus = 2; }

  const d = new Date(now);
  return {
    equipCode: args.equip,
    procOrderNo: 'MES20260918001',
    collectTime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
                 `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    testStatus, stage, linkStatus: 'online',

    /* 实测数据（主要展示对象） */
    depth: s.depth, speed, velocity_x: s.vx, velocity_y: s.vy,

    /* 设备参数（次要展示） */
    frameRate: Math.round(s.fpsRaw),
    gain: round1(s.gainRaw),
    shutter: Math.round(s.shutterRaw),
    cameraDepth: s.cameraDepth,

    /* 工单与测试标准 */
    productCode: 'CP-2026-A17',
    productName: '水下振动测试件',
    batchNo: 'PC20260918-03',
    drawingNo: 'SJ-4471-02',
    orderNo: 'DD20260917-118',
    planQty: args.planQty,
    stdDepth: 12.50, stdGain: 2.5, stdFps: 400, stdShutter: 500,

    /* 任务结果与进度 */
    result, unitIndex, progress: round2(progress)
  };
}

/* ---------------- 推送 ---------------- */
function pushOnce(args, now) {
  const payload = nextPayload(args, now);
  seq++;
  if (!args.push) {
    console.log(`[mock-upper] #${seq} ${payload.collectTime} 深度=${payload.depth} 速度=${payload.speed} 阶段=${payload.stage}（未指定 --push，仅生成报文）`);
    return Promise.resolve({ ok: true, skipped: true });
  }
  return new Promise(resolve => {
    const u = new URL(args.push);
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`[mock-upper] #${seq} → ${args.push}  HTTP ${res.statusCode}  深度=${payload.depth} 速度=${payload.speed} 阶段=${payload.stage}  回执=${data.slice(0, 120)}`);
        resolve({ ok: res.statusCode < 400, status: res.statusCode, body: data });
      });
    });
    req.on('error', err => {
      console.log(`[mock-upper] #${seq} → ${args.push}  失败：${err.message}`);
      resolve({ ok: false, error: err.message });
    });
    req.write(body);
    req.end();
  });
}

/* ---------------- HTTP 服务 ---------------- */
function startServer(args) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const send = (code, obj) => {
      const s = JSON.stringify(obj, null, 2);
      res.writeHead(code, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(s);
    };
    if (u.pathname === '/realtime' || u.pathname === '/sample') {
      return send(200, nextPayload(args, Date.now()));
    }
    if (u.pathname === '/health') {
      return send(200, { status: 1, msg: 'mock-upper 正常', equipCode: args.equip, sent: seq });
    }
    send(404, { status: 0, msg: '未知路径：' + u.pathname });
  });
  server.listen(args.port, () => {
    console.log(`[mock-upper] 服务已启动：http://127.0.0.1:${args.port}/realtime`);
    console.log(`[mock-upper] 设备编号=${args.equip}  节拍=${args.cycleSec}s  计划=${args.planQty}`);
    if (args.push) console.log(`[mock-upper] 推送目标：${args.push}  周期=${args.interval}ms`);
    if (args.once) {
      pushOnce(args, Date.now()).then(() => { server.close(); process.exit(0); });
      return;
    }
    if (args.push) setInterval(() => pushOnce(args, Date.now()), args.interval);
  });
}

/* ---------------- 入口 ---------------- */
const args = parseArgs(process.argv);
if (args.once && !args.push) {
  /* --once 但未指定目标：直接打印一帧样例报文后退出 */
  console.log(JSON.stringify(nextPayload(args, Date.now()), null, 2));
  process.exit(0);
}
startServer(args);
