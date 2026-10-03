#!/usr/bin/env node
/* ==========================================================================
   模拟 MES 端（tools/mock-mes/mock-mes.js）
   作用：在真实 MES 接口（Q-23）到位前，提供联调用的"假 MES"：
     ① 作为接收方：接收看板上报的报文（附录 2 的 13 个字段），按配置返回回执
     ② 作为发起方：模拟 MES 向看板下发派工信息（IF-A）
   设计目的：
     - 让看板的"上报 + 回执 + 失败补传"逻辑在联调前就能自测；
     - 回执风格可在 {status,msg,data} 与 {code,msg,uploadId} 之间切换，
       便于验证 Q-23 中"回执结构以哪套为准"的两种可能。
   依赖：仅 Node 内置模块，无需 npm install，不访问外网
   运行：node tools/mock-mes/mock-mes.js --help
   ========================================================================== */
'use strict';

const http = require('http');

/* 退出码契约（`E100`①，2026-10-03）：
   0 = 正常（`--help`；或服务被 SIGINT/外部终止）
   2 = **监听失败**（端口被占等）—— 与 `tests\env.js` 的 `EXIT_ERROR = 2` 同值同义。
       为什么不用 1：1 在本项目里专指"有断言失败"（`tests\lib\assert.js` 的退码契约），
       而"起不来"属于**脚本自身异常/环境不满足**，正是 2 的含义（规范 9.5-5）。 */
const EXIT_LISTEN_FAILED = 2;

/* ---------------- 命令行参数 ---------------- */
function parseArgs(argv) {
  const a = {
    port: 8802,          // 本服务端口
    receipt: 'status',   // 回执风格：status = {status,msg,data}；code = {code,msg,uploadId}
    failRate: 0,         // 模拟异常回执的概率（0~1），用于测试失败补传
    board: '',           // 看板服务地址；用于模拟 IF-A 派工下发
    dispatchEvery: 0     // 每隔多少毫秒下发一次派工（0 = 不下发）
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--port') { a.port = Number(v); i++; }
    else if (k === '--receipt') { a.receipt = v; i++; }
    else if (k === '--fail-rate') { a.failRate = Number(v); i++; }
    else if (k === '--board') { a.board = v; i++; }
    else if (k === '--dispatch-every') { a.dispatchEvery = Number(v); i++; }
    else if (k === '--help' || k === '-h') { printHelp(); process.exit(0); }
  }
  return a;
}

function printHelp() {
  console.log(`
模拟 MES 端 —— 联调用的"假 MES"，可接收上报、返回回执、下发派工

用法：
  node tools/mock-mes/mock-mes.js [参数]

参数：
  --port <n>            本服务端口，默认 8802
  --receipt <style>     回执风格：status（{status,msg,data}）或 code（{code,msg,uploadId}），默认 status
  --fail-rate <0~1>     按概率返回异常回执（测试失败补传用），默认 0
  --board <url>         看板服务地址，用于模拟 IF-A 派工下发
  --dispatch-every <ms> 每隔多少毫秒向 --board 下发一次派工（默认 0 = 不下发）
  --help                显示本帮助

提供的接口（模拟 MES 对外）：
  POST /service/:serviceName/:methodName   接收看板上报，返回回执
  POST /dispatch                           手动触发一次派工下发（需 --board）
  GET  /log                                查看已收到的报文
  DELETE /log                              清空日志
  GET  /health                             健康检查

示例：
  # 起一个回执风格为 status 的假 MES
  node tools/mock-mes/mock-mes.js --receipt status

  # 验证失败补传：30% 概率返回异常回执
  node tools/mock-mes/mock-mes.js --fail-rate 0.3
`);
}

/* ---------------- 收到的报文日志（内存） ---------------- */
const received = [];
let abnormalCount = 0;

/* ---------------- 回执生成 ---------------- */
function makeReceipt(args, payload) {
  const forceFail = args.failRate > 0 && Math.random() < args.failRate;
  const abnormal = forceFail || !payload || !payload.equipCode;

  if (abnormal) {
    abnormalCount++;
    return args.receipt === 'code'
      ? { code: 5001, msg: '设备编号不存在/关键字段缺失', uploadId: payload && payload.uploadId }
      : { status: 0, msg: '设备编号不存在/关键字段缺失', data: {} };
  }
  return args.receipt === 'code'
    ? { code: 200, msg: '数据接收成功', uploadId: payload.uploadId }
    : { status: 1, msg: '已接收', data: { uploadId: payload.uploadId } };
}

/* ---------------- 模拟 IF-A：向看板下发派工 ---------------- */
function dispatchToBoard(args) {
  if (!args.board) {
    console.log('[mock-mes] 未配置 --board，跳过派工下发');
    return Promise.resolve({ ok: false, reason: '未配置 --board（看板服务地址）' });
  }
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const body = JSON.stringify({
    techNoticeNo: 'TJ' + stamp,
    batchNo: 'PC20260918-03',
    procOrderNo: 'MES' + stamp,
    productCode: 'CP-2026-A17',
    drawingNo: 'SJ-4471-02',
    productName: '水下振动测试件',
    heatBatchNo: 'LB20260918',
    processNo: '30',
    processName: '水下高速摄像检验',
    unit: '件',
    dispatchQty: 180,
    processRoute: 'RT-A17-01',
    processNum: '01',
    planStartTime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 08:00:00`,
    planEndTime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 20:00:00`,
    dispatchTarget: '检验一班/1#工位'
  });
  const u = new URL(args.board);
  return new Promise(resolve => {
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`[mock-mes] 派工下发 → ${args.board}  HTTP ${res.statusCode}  回执=${data.slice(0, 120)}`);
        resolve({ ok: res.statusCode < 400, status: res.statusCode });
      });
    });
    req.on('error', err => {
      console.log(`[mock-mes] 派工下发失败：${err.message}`);
      resolve({ ok: false, error: err.message });
    });
    req.write(body);
    req.end();
  });
}

/* ---------------- HTTP 服务 ---------------- */
function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
  });
}

function startServer(args) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(obj, null, 2));
    };

    /* 接收看板上报（IF-B / 附录 2） */
    if (req.method === 'POST' && u.pathname.startsWith('/service/')) {
      const raw = await readBody(req);
      let payload = null;
      try { payload = JSON.parse(raw); } catch (e) { payload = null; }
      const receipt = makeReceipt(args, payload);
      received.push({ at: new Date().toISOString(), path: u.pathname, receipt, payload });
      if (received.length > 2000) received.shift();
      const ok = args.receipt === 'code' ? receipt.code === 200 : receipt.status === 1;
      console.log(`[mock-mes] ← ${u.pathname}  ${ok ? '接收成功' : '异常回执'}  ` +
                  `uploadId=${payload && payload.uploadId}  depth=${payload && payload.depth}  ` +
                  `cameraDepth=${payload && payload.cameraDepth}  speed=${payload && payload.speed}`);
      return send(200, receipt);
    }

    /* 手动触发派工下发 */
    if (req.method === 'POST' && u.pathname === '/dispatch') {
      const r = await dispatchToBoard(args);
      return send(200, { status: r.ok ? 1 : 0, msg: r.ok ? '已下发' : (r.reason || r.error || '下发失败') });
    }

    /* 查看/清空收到的报文 */
    if (u.pathname === '/log') {
      if (req.method === 'DELETE') { received.length = 0; return send(200, { status: 1, msg: '已清空' }); }
      return send(200, {
        status: 1,
        count: received.length,
        abnormalCount,
        receiptStyle: args.receipt,
        items: received.slice(-50)
      });
    }

    if (u.pathname === '/health') {
      return send(200, { status: 1, msg: 'mock-mes 正常', received: received.length, receiptStyle: args.receipt });
    }

    send(404, { status: 0, msg: '未知路径：' + u.pathname });
  });

  /* `E100`①（2026-10-03）：`listen` 必须有 `'error'` 监听。
     改前只有下面这句 `server.listen(args.port, …)`，**没有** `'error'` 处理 ⇒ 端口被占时
     Node 抛**未捕获**事件 `Error: listen EADDRINUSE: address already in use :::<port>`
     ⇒ 调用方（`tests\contract-check.js` 在**进程内** require 本文件）**当场退出 1
     且来不及打印 `=== 汇总 ===`**（`E98` 现场读数 `尝试序列 1:bad(exit=1)`）。
     处置（照 `E98` 登记的建议②）：
       · **保持 `EADDRINUSE` 字样可见** —— 它是 `run-all` 把这一轮归为 `collided`
         （有证据的环境条件、可重试）的**唯一**证据门槛（`tests\harness-check.js` 的
         `COLLISION_NEEDLE = /EADDRINUSE/`）；把字样藏起来会让 `E98` 的分类**失效**；
       · **以非 0 退码优雅退出**（`EXIT_LISTEN_FAILED = 2`，与 `tests\env.js` 的 `EXIT_ERROR`
         同值、同语义："脚本自身异常／环境不满足导致的运行时错误"）并打印可读原因
         ＋ 一行可照做的处置（换 `--port`）。不再让裸 `EADDRINUSE` 栈把调用方打断。
     ⚠ 副作用如实记账：进程内调用方（`contract-check`）现在会得到一个"**非 0 退码 ＋ 无汇总行**"的
     收场，而不是"崩栈"；`run-all` 对这两种形态的归类相同（`failed`／`collided`），
     故 `E98` 的判据不受影响。真进程调用方（`tools-check`／`harness-check`）不受影响：
     端口就绪探针照旧拿不到 `/health`，它们本来就按"未就绪 ⇒ skip"处理。 */
  server.on('error', (err) => {
    const code = (err && err.code) || '(无 code)';
    console.error(`[mock-mes] 启动失败：无法监听端口 ${args.port} —— ${err && err.message ? err.message : err}`);
    console.error(`[mock-mes] 错误码=${code}${code === 'EADDRINUSE'
      ? `（EADDRINUSE：端口 ${args.port} 已被占用 —— 换一个 --port，或先释放该端口）`
      : '（非端口占用类错误，请照上面的消息排查）'}`);
    process.exit(EXIT_LISTEN_FAILED);
  });

  server.listen(args.port, () => {
    console.log(`[mock-mes] 服务已启动：http://127.0.0.1:${args.port}`);
    console.log(`[mock-mes] 上报接收端点：POST http://127.0.0.1:${args.port}/service/{serviceName}/{methodName}`);
    console.log(`[mock-mes] 回执风格=${args.receipt}  异常概率=${args.failRate}  日志查看：GET /log`);
    if (args.board) console.log(`[mock-mes] 派工下发目标：${args.board}`);
    if (args.dispatchEvery > 0) setInterval(() => dispatchToBoard(args), args.dispatchEvery);
  });
}

/* ---------------- 入口 ---------------- */
startServer(parseArgs(process.argv));
