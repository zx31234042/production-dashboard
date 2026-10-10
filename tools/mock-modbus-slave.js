/* mock-modbus-slave.js —— 「模拟上位机（Modbus TCP 从站）」· **零依赖** · `tools\mock-modbus-slave.js`
 * ---------------------------------------------------------------------------
 * 用途：在**真 PLC 与寄存器映射表到位之前**，让看板接收侧（Modbus TCP 客户端 ＋ 字段映射 ＋ 去重 ＋ 落库）
 *   **现在就能端到端开发与自测**；并当场验证"**零依赖**"这条红线 —— 本文件只用 `node:net`，
 *   MBAP 头、PDU、CRC16 全部自写，**不引入任何第三方模块**。
 * 口径来源（**逐字对齐，改则两处同改**）：`输出文件\上位机方\接口需求函（第三批）-致设备上位机方.md` **§2.2**
 *   「我方理解的样例」：**数值区 `0x0000` 起 16 个寄存器**（`testStatus`／**数据更新序号**／`collectTime`〔UINT32，
 *   自 2000-01-01 起的秒，高字在前〕／`frameRate`／`gain`×10／`shutter`／`cameraDepth`×100／`depth`×100／`speed`×100／
 *   `velocity_x`／`velocity_y`／保留／设定深度／设定增益／设定帧率）＋ **字符串区 `0x0020` 起 10 个寄存器**
 *   （`equipCode` 8 字符＝4 寄存器 ＋ `procOrderNo` 12 字符＝6 寄存器；ASCII、每寄存器 2 字符、高字节在前、补 `0x00`）。
 * **不是门禁**（不在 `tests\run-all.js` 的 suite 清单里、不计入权威区条数）：它是**开发/联调夹具**，
 *   证据由本文件的 `--self-test` 与使用方的实测给出；**是否接门禁归负责人**（本仓纪律：不新增元机制）。
 *
 * ── 从站功能（我方作主站时会用到的都在） ──────────────────────────────────
 *   0x03 读保持寄存器（主用）｜0x04 读输入寄存器（**同折射**，容错：真 PLC 若把它放 3xxxx 也能读回）
 *   0x06 写单个寄存器／0x10 写多个寄存器 —— **仅供测试注入**（驱动"集采/场景"，真从站不需要）
 *   异常响应：0x01 非法功能／0x02 非法数据地址／0x03 非法数据值（数量越界）
 *
 * ── 场景（`--mode cycle`，默认） ────────────────────────────────────────────
 *   按 `testStatus` **0→1→2→2→0** 循环（对应待机／测试中／测试完成〔保持 ≥2 s〕／待机），**每步**刷新
 *   `collectTime` 并把**数据更新序号 `seq` ＋1** —— 这正是接收侧去重最需要的那种形态：
 *   **同一次刷新被读多次 ⇒ `seq` 相同（应判重复帧丢弃）；两次刷新即使落在同一秒 ⇒ `seq` 不同（应各自落库）**。
 *   `--mode static`：数据不动、`seq` 只在被写入后变化（用来测"同键重复"）。
 *
 * 用法：
 *   node tools\mock-modbus-slave.js --port 8502 [--unit 1] [--mode cycle|static] [--step-ms 3000] [--verbose]
 *   node tools\mock-modbus-slave.js --print-sample         只打印 §2.2 的请求/应答帧（十六进制）后退出
 *   node tools\mock-modbus-slave.js --self-test            自测：CRC/MBAP/编解码/异常/写读/seq/**回环 TCP 端到端**
 * ---------------------------------------------------------------------------
 */
'use strict';

const net = require('node:net');

/* ============================ 寄存器布局（与函件 §2.2 逐字一致） ============================ */
const BANK_SIZE = 64;                       /* 0x0000–0x003F，够放数值区 ＋ 字符串区 */
const NUM_BASE = 0x0000, NUM_LEN = 16;      /* 数值区 */
const STR_BASE = 0x0020, STR_LEN = 10;      /* 字符串区 */
/** 数值区偏移（下标即寄存器偏移，名称与函件 §2.2 表一致） */
const N = {
  testStatus: 0, seq: 1, ctHi: 2, ctLo: 3, frameRate: 4, gainX10: 5, shutter: 6,
  cameraDepthX100: 7, depthX100: 8, speedX100: 9, vxX100: 10, vyX100: 11, reserved: 12,
  setDepthX100: 13, setGainX10: 14, setFrameRate: 15
};
/** `collectTime` 基准：自 2000-01-01 00:00:00（与函件 §2.2 同口径） */
const EPOCH_2000 = Date.UTC(2000, 0, 1);
const secondsSince2000 = (ms) => Math.floor((ms - EPOCH_2000) / 1000);

/* ============================ CRC16（Modbus） ============================ */
function crc16(bytes) {
  let crc = 0xFFFF;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
  }
  return crc & 0xFFFF;
}
/** 追加 CRC16（**低字节在前**，与 §2.2 的帧同序） */
function withCrc(body) {
  const c = crc16(body);
  return Buffer.from([...body, c & 0xFF, (c >> 8) & 0xFF]);
}
const hex = (buf) => Buffer.from(buf).toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim();

/* ============================ 从站实现 ============================ */
/** 建一个从站实例：寄存器库 ＋ 刷新逻辑（`seq` 每次刷新 +1） */
function createSlave(opts = {}) {
  const bank = new Uint16Array(BANK_SIZE);
  const state = { unit: opts.unit == null ? 1 : opts.unit, verbose: Boolean(opts.verbose), reads: 0, writes: 0, refreshCount: 0, lastError: null };
  /** 按 ASCII 写字符串区（每寄存器 2 字符、高字节在前、不足补 0x00） */
  const writeAscii = (base, text, chars) => {
    const padded = String(text).padEnd(chars, '\0').slice(0, chars);
    for (let i = 0; i < chars; i += 2) {
      const hi = padded.charCodeAt(i) & 0xFF, lo = padded.charCodeAt(i + 1) & 0xFF;
      bank[base + (i >> 1)] = (hi << 8) | lo;
    }
  };
  const readAscii = (base, chars) => {
    let s = '';
    for (let i = 0; i < chars; i += 2) {
      const w = bank[base + (i >> 1)];
      s += String.fromCharCode((w >> 8) & 0xFF) + String.fromCharCode(w & 0xFF);
    }
    return s.replace(/\0+$/, '');
  };
  /** 刷新：`collectTime` 取"现在"、`seq` +1（**这是去重口径里"一次刷新"的语义**） */
  const refresh = (patch = {}, nowMs = Date.now()) => {
    const ct = secondsSince2000(nowMs);
    bank[N.ctHi] = (ct >>> 16) & 0xFFFF;
    bank[N.ctLo] = ct & 0xFFFF;
    state.refreshCount += 1;
    bank[N.seq] = (bank[N.seq] + 1) & 0xFFFF;
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'equipCode' || k === 'procOrderNo') continue;
      if (N[k] === undefined) throw new Error('未知字段：' + k);
      bank[N[k]] = v < 0 ? (v + 0x10000) & 0xFFFF : v & 0xFFFF;
    }
    if (patch.equipCode !== undefined) writeAscii(STR_BASE, patch.equipCode, 8);
    if (patch.procOrderNo !== undefined) writeAscii(STR_BASE + 4, patch.procOrderNo, 12);
    return state.refreshCount;
  };
  /* 初值：与函件 §2.2 的样例帧一致（便于"我方假设 ↔ 模拟器"互证） */
  writeAscii(STR_BASE, 'SX-UND-1', 8);
  writeAscii(STR_BASE + 4, 'WO-20261010', 12);
  refresh({ testStatus: 1, frameRate: 500, gainX10: 125, shutter: 800, cameraDepthX100: 450, depthX100: 480,
    speedX100: 320, vxX100: 210, vyX100: 241, setDepthX100: 500, setGainX10: 100, setFrameRate: 400 }, Date.UTC(2026, 9, 10, 10, 3, 20));

  /** 处理一条 PDU（不含 MBAP、不含 CRC）→ 返回应答 PDU（Buffer）；异常时返回异常 PDU */
  const handlePdu = (pdu) => {
    const fc = pdu[0];
    const exc = (code) => Buffer.from([(fc | 0x80) & 0xFF, code]);
    if (fc !== 0x03 && fc !== 0x04 && fc !== 0x06 && fc !== 0x10) { state.lastError = 'illegal function 0x' + fc.toString(16); return exc(0x01); }
    if (fc === 0x03 || fc === 0x04) {
      const addr = pdu.readUInt16BE(1), qty = pdu.readUInt16BE(3);
      if (qty < 1 || qty > 125) { state.lastError = 'illegal quantity ' + qty; return exc(0x03); }
      if (addr + qty > BANK_SIZE) { state.lastError = 'illegal address ' + addr + '+' + qty; return exc(0x02); }
      const out = Buffer.alloc(2 + qty * 2);
      out[0] = fc; out[1] = qty * 2;
      for (let i = 0; i < qty; i++) out.writeUInt16BE(bank[addr + i], 2 + i * 2);
      state.reads += 1;
      return out;
    }
    if (fc === 0x06) {
      const addr = pdu.readUInt16BE(1), val = pdu.readUInt16BE(3);
      if (addr >= BANK_SIZE) return exc(0x02);
      bank[addr] = val; state.writes += 1;
      return Buffer.from([0x06, pdu[1], pdu[2], pdu[3], pdu[4]]);
    }
    /* 0x10 写多个 */
    const addr = pdu.readUInt16BE(1), qty = pdu.readUInt16BE(3), bc = pdu[5];
    if (qty < 1 || qty > 123 || bc !== qty * 2) { state.lastError = 'illegal value (qty/bc)'; return exc(0x03); }
    if (addr + qty > BANK_SIZE) return exc(0x02);
    for (let i = 0; i < qty; i++) bank[addr + i] = pdu.readUInt16BE(6 + i * 2);
    state.writes += 1;
    return Buffer.from([0x10, pdu[1], pdu[2], pdu[3], pdu[4]]);
  };

  /** 处理一帧 **MBAP ＋ PDU**（TCP 侧收到的完整帧）→ 返回应答帧（MBAP ＋ PDU） */
  const handleMbap = (frame) => {
    if (frame.length < 8) { state.lastError = 'frame too short'; return null; }
    const txn = frame.readUInt16BE(0), proto = frame.readUInt16BE(2), len = frame.readUInt16BE(4), unit = frame[6];
    if (proto !== 0) { state.lastError = 'bad protocol id ' + proto; return null; }
    if (len < 2 || len + 6 > frame.length) { state.lastError = 'bad length ' + len; return null; }
    if (unit !== state.unit && unit !== 0xFF) { state.lastError = 'not my unit ' + unit; return null; }   /* 非本从站：静默（真从站行为） */
    const pdu = frame.subarray(7, 6 + len);
    const respPdu = handlePdu(Buffer.from(pdu));
    const out = Buffer.alloc(7 + respPdu.length);
    out.writeUInt16BE(txn, 0); out.writeUInt16BE(0, 2); out.writeUInt16BE(1 + respPdu.length, 4);
    out[6] = unit; respPdu.copy(out, 7);
    return out;
  };

  /** 组一帧 **RTU**（`从站地址 ＋ PDU ＋ CRC16`）—— 仅 `--self-test`／`--print-sample` 用（现场是 TCP） */
  const rtuRequest = (fc, addr, qty) => withCrc([state.unit, fc, (addr >> 8) & 0xFF, addr & 0xFF, (qty >> 8) & 0xFF, qty & 0xFF]);
  const rtuResponse = (fc, addr, qty) => {
    const pdu = handlePdu(Buffer.from([fc, (addr >> 8) & 0xFF, addr & 0xFF, (qty >> 8) & 0xFF, qty & 0xFF]));
    return withCrc([state.unit, ...pdu]);
  };
  return { bank, state, refresh, handlePdu, handleMbap, rtuRequest, rtuResponse, readAscii, writeAscii, secondsSince2000 };
}

/* ============================ 场景 ============================ */
/** `--mode cycle`：testStatus 0→1→2→2→0，每步刷新（`seq` +1） */
const CYCLE = [
  { testStatus: 0 }, { testStatus: 1 }, { testStatus: 2 }, { testStatus: 2 }, { testStatus: 0 }
];

function startServer(slave, { port, host = '127.0.0.1' }, onReady) {
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      /* TCP 是字节流：按 MBAP 的 length 字段切帧（length 不含前 6 字节） */
      while (buf.length >= 6) {
        const len = buf.readUInt16BE(4);
        if (buf.length < 6 + len) break;
        const frame = buf.subarray(0, 6 + len);
        buf = buf.subarray(6 + len);
        const resp = slave.handleMbap(frame);
        if (!resp) { if (slave.state.verbose) console.log('[mock-modbus] 丢帧：' + (slave.state.lastError || '未知')); continue; }
        if (slave.state.verbose) console.log('[mock-modbus] ← ' + hex(frame) + '  → ' + hex(resp));
        sock.write(resp);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { if (onReady) onReady(server.address()); resolve(server); });
  });
}

/* ============================ 自测 ============================ */
async function selfTest() {
  const cases = [];
  const push = (label, got, want) => cases.push({ label, got, want, ok: JSON.stringify(got) === JSON.stringify(want) });
  const s = createSlave({ unit: 1 });

  /* ① CRC16 已知向量（与函件 §2.2 的请求帧同源） */
  push('① CRC16：`01 03 00 00 00 10` ⇒ 0x0644（低字节在前 `44 06`）', crc16([0x01, 0x03, 0x00, 0x00, 0x00, 0x10]), 0x0644);
  push('① CRC16：`01 03 00 20 00 0A` ⇒ 0x07C4', crc16([0x01, 0x03, 0x00, 0x20, 0x00, 0x0A]), 0x07C4);
  push('① 组帧（RTU 请求）与函件 §2.2 逐字相同', hex(s.rtuRequest(0x03, 0x0000, 0x0010)), '01 03 00 00 00 10 44 06');

  /* ② 数值区应答 = 函件 §2.2 样例帧的字节（**互证"我方假设 ↔ 模拟器"**）
     ⚠ `seq` 与 `collectTime` 是**动态量**（构造时已刷新一次 ⇒ `seq=1`、`collectTime=现在`）⇒
     先把这两个**钉到样例值**再逐字节比：样例 `seq=1234=0x04D2`、`collectTime=844941800`
     ⇒ 高字 `0x325C`、低字 `0xC9E8`（与函件 §2.2 的帧 `… 00 01 04 D2 32 5C C9 E8 …` 同源）。 */
  s.bank[N.seq] = 1234; s.bank[N.ctHi] = 0x325C; s.bank[N.ctLo] = 0xC9E8;
  const wantNum = '01 03 20 00 01 04 D2 32 5C C9 E8 01 F4 00 7D 03 20 01 C2 01 E0 01 40 00 D2 00 F1 00 00 01 F4 00 64 01 90 ED 6D';
  push('② 数值区应答（RTU）＝函件 §2.2 样例字节（**钉住动态字段后**逐字节比）', hex(s.rtuResponse(0x03, 0x0000, 0x0010)), wantNum);
  const wantStr = '01 03 14 53 58 2D 55 4E 44 2D 31 57 4F 2D 32 30 32 36 31 30 31 30 00 9E DE';
  push('② 字符串区应答（RTU）＝函件 §2.2 样例字节', hex(s.rtuResponse(0x03, 0x0020, 0x000A)), wantStr);

  /* ③ 字符串解码（ASCII／每寄存器 2 字符／高字节在前／补 0x00） */
  push('③ `equipCode` 解码＝"SX-UND-1"', s.readAscii(STR_BASE, 8), 'SX-UND-1');
  push('③ `procOrderNo` 解码＝"WO-20261010"', s.readAscii(STR_BASE + 4, 12), 'WO-20261010');

  /* ④ `collectTime`／`seq` 语义：一次刷新 ⇒ seq +1；**不刷新再读 ⇒ seq 不变**（＝接收侧应判重复帧） */
  const seqBefore = s.bank[N.seq];
  push('④ 一次刷新 ⇒ `seq` +1', s.refresh({ testStatus: 1 }) === s.state.refreshCount && s.bank[N.seq] === ((seqBefore + 1) & 0xFFFF), true);
  const seqA = s.bank[N.seq];
  s.handlePdu(Buffer.from([0x03, 0x00, 0x00, 0x00, 0x10]));
  s.handlePdu(Buffer.from([0x03, 0x00, 0x00, 0x00, 0x10]));
  push('④ 同一次刷新被读两次 ⇒ `seq` 相同（重复帧）', s.bank[N.seq] === seqA, true);
  const ct = (s.bank[N.ctHi] << 16) | s.bank[N.ctLo];
  push('④ `collectTime` ＝ 自 2000-01-01 起的秒（高字在前）', ct > 800000000 && ct < 900000000, true);

  /* ⑤ 异常响应 */
  push('⑤ 非法功能码 0x99 ⇒ 异常 0x01', [...s.handlePdu(Buffer.from([0x99, 0, 0, 0, 1]))], [0x99 | 0x80, 0x01]);
  push('⑤ 地址越界（0x0031＋16 = 65 > 64）⇒ 异常 0x02', [...s.handlePdu(Buffer.from([0x03, 0x00, 0x31, 0x00, 0x10]))], [0x83, 0x02]);
  push('⑤ 边界内（0x0030＋16 = 64，恰好合法）⇒ 正常应答 0x03', s.handlePdu(Buffer.from([0x03, 0x00, 0x30, 0x00, 0x10]))[0], 0x03);
  push('⑤ 数量越界（126）⇒ 异常 0x03', [...s.handlePdu(Buffer.from([0x03, 0x00, 0x00, 0x00, 0x7E]))], [0x83, 0x03]);

  /* ⑥ 写读往返（06H／10H，仅注入用） */
  s.handlePdu(Buffer.from([0x06, 0x00, 0x0C, 0x12, 0x34]));
  push('⑥ 06H 写单寄存器后可读回', s.bank[0x0C], 0x1234);
  s.handlePdu(Buffer.from([0x10, 0x00, 0x0D, 0x00, 0x02, 0x04, 0x00, 0x64, 0x01, 0x90]));
  push('⑥ 10H 写 2 个寄存器后可读回', [s.bank[0x0D], s.bank[0x0E]], [0x64, 0x190]);
  push('⑥ 06H 应答回显地址与值', [...s.handlePdu(Buffer.from([0x06, 0x00, 0x0C, 0x12, 0x34]))], [0x06, 0x00, 0x0C, 0x12, 0x34]);

  /* ⑦ MBAP 组帧/解帧（非本从站 ⇒ 静默不回） */
  const mbap = Buffer.concat([Buffer.from([0x00, 0x2A, 0x00, 0x00, 0x00, 0x06, 0x01]), Buffer.from([0x03, 0x00, 0x00, 0x00, 0x01])]);
  const r = s.handleMbap(mbap);
  push('⑦ MBAP 应答：事务号回显 0x002A／协议 0／单位 1／长度 1+PDU', [r.readUInt16BE(0), r.readUInt16BE(2), r[6], r.readUInt16BE(4)], [0x2A, 0, 1, 5]);
  push('⑦ 非本从站（unit=9）⇒ 静默（返回 null）', s.handleMbap(Buffer.concat([Buffer.from([0, 1, 0, 0, 0, 6, 9]), Buffer.from([0x03, 0, 0, 0, 1])])), null);

  /* ⑧ 场景：`--mode cycle` 的 testStatus 序列 */
  push('⑧ 场景序列＝ 0→1→2→2→0', CYCLE.map(x => x.testStatus), [0, 1, 2, 2, 0]);

  /* ⑨ **回环 TCP 端到端**（真起服务端、真连 socket、真收帧） */
  const srvSlave = createSlave({ unit: 1 });
  srvSlave.refresh({ testStatus: 1, frameRate: 500, gainX10: 125, shutter: 800, cameraDepthX100: 450, depthX100: 480,
    speedX100: 320, vxX100: 210, vyX100: 241, setDepthX100: 500, setGainX10: 100, setFrameRate: 400 }, Date.UTC(2026, 9, 10, 10, 3, 20));
  const srv = await startServer(srvSlave, { port: 0, host: '127.0.0.1' });
  const port = srv.address().port;
  const got = await new Promise((resolve, reject) => {
    const c = net.connect({ port, host: '127.0.0.1' }, () => {
      c.write(Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01]), Buffer.from([0x03, 0x00, 0x00, 0x00, 0x10])]));
    });
    let acc = Buffer.alloc(0);
    c.setTimeout(3000, () => { c.destroy(); reject(new Error('回环超时')); });
    c.on('data', (d) => { acc = Buffer.concat([acc, d]); if (acc.length >= 6 + acc.readUInt16BE(4)) { c.destroy(); resolve(acc); } });
    c.on('error', reject);
  }).catch((e) => { srv.close(); return e; });
  srv.close();
  if (got instanceof Error) push('⑨ 回环 TCP 端到端（03H 读 16 寄存器）', 'ERROR: ' + got.message, '无错');
  else {
    const pdu = got.subarray(7);
    push('⑨ 回环 TCP：03H 应答 ＝ 0x03 ＋ 32 数据字节', [pdu[0], pdu[1], pdu.length], [0x03, 32, 34]);
    /* ⚠ 构造 `createSlave()` 时**已经刷新过一次**（`seq=1`），本测试又刷了一次 ⇒ 应答里应为 `seq=2`。 */
    push('⑨ 回环 TCP：`testStatus` 与 `seq` 落在应答里（构造期 1 次 ＋ 测试 1 次 ⇒ seq=2）', [pdu.readUInt16BE(2), pdu.readUInt16BE(4)], [1, 2]);
  }

  let ok = 0;
  for (const c of cases) {
    if (c.ok) ok += 1;
    console.log((c.ok ? '  [PASS] ' : '  [FAIL] ') + c.label + ' —— 实测 ' + JSON.stringify(c.got) + (c.ok ? '' : '（期望 ' + JSON.stringify(c.want) + '）'));
  }
  console.log('\n汇总：' + ok + '/' + cases.length + ' 相符');
  return ok === cases.length;
}

/* ============================ CLI ============================ */
function printSample() {
  const s = createSlave({ unit: 1 });
  s.refresh({ testStatus: 1, frameRate: 500, gainX10: 125, shutter: 800, cameraDepthX100: 450, depthX100: 480,
    speedX100: 320, vxX100: 210, vyX100: 241, setDepthX100: 500, setGainX10: 100, setFrameRate: 400 }, Date.UTC(2026, 9, 10, 10, 3, 20));
  /* ⚠ `seq`／`collectTime` 是**动态量**（构造期已刷新一次）⇒ 钉到函件 §2.2 样例的那组值，
     这样本节打印的帧与**函件里的样例逐字节相同**（否则"一致"这句话就是假的）。 */
  s.bank[N.seq] = 1234; s.bank[N.ctHi] = 0x325C; s.bank[N.ctLo] = 0xC9E8;
  console.log('数值区请求：' + hex(s.rtuRequest(0x03, 0x0000, 0x0010)));
  console.log('字符串区请求：' + hex(s.rtuRequest(0x03, 0x0020, 0x000A)));
  console.log('数值区应答：' + hex(s.rtuResponse(0x03, 0x0000, 0x0010)));
  console.log('字符串区应答：' + hex(s.rtuResponse(0x03, 0x0020, 0x000A)));
  console.log('（`seq=1234`／`collectTime=844941800` 为**钉住的样例值**；以上与 `输出文件\\上位机方\\接口需求函（第三批）-致设备上位机方.md` §2.2 的样例帧**逐字节相同**）');
}

function usage() {
  console.log('用法：node tools\\mock-modbus-slave.js --port 8502 [--unit 1] [--mode cycle|static] [--step-ms 3000] [--verbose]');
  console.log('      node tools\\mock-modbus-slave.js --print-sample | --self-test');
}

function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  if (has('--help') || has('-h')) { usage(); return; }
  if (has('--self-test')) { return selfTest().then((ok) => process.exit(ok ? 0 : 1)); }
  if (has('--print-sample')) { printSample(); return; }
  const port = Number(val('--port', 8502)), unit = Number(val('--unit', 1));
  const mode = val('--mode', 'cycle'), stepMs = Number(val('--step-ms', 3000));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口非法：' + val('--port', ''));
  if (!Number.isInteger(unit) || unit < 1 || unit > 247) throw new Error('从站地址非法（1–247）：' + val('--unit', ''));
  if (mode !== 'cycle' && mode !== 'static') throw new Error('--mode 只能是 cycle 或 static');
  const slave = createSlave({ unit, verbose: has('--verbose') });
  let step = 0;
  const tick = () => {
    const patch = mode === 'cycle' ? CYCLE[step % CYCLE.length] : { testStatus: slave.bank[N.testStatus] };
    slave.refresh(patch);
    step += 1;
    if (has('--verbose')) console.log(`[mock-modbus] 刷新 #${slave.state.refreshCount} testStatus=${slave.bank[N.testStatus]} seq=${slave.bank[N.seq]}`);
  };
  tick();
  return startServer(slave, { port }, (addr) => {
    console.log(`[mock-modbus] 从站已起：${addr.address}:${addr.port}（unit=${unit}，mode=${mode}，step-ms=${stepMs}）`);
    console.log('[mock-modbus] 读数值区 03H @0x0000×16；读字符串区 03H @0x0020×10；测试注入可用 06H/10H');
    setInterval(tick, Math.max(50, stepMs)).unref();
  }).then(() => { /* 常驻：不主动退出 */ });
}

/* 导出：供其它工具（如 `tools\modbus-poll-probe.js`）**在同进程内**起从站、直接驱动场景 ——
   **被 require 时一行都不跑**（与 `tests\run-all.js` 同款守卫；`E78` 一族的口径）。 */
module.exports = {
  createSlave, startServer, CYCLE, crc16, withCrc, hex,
  N, NUM_BASE, NUM_LEN, STR_BASE, STR_LEN, EPOCH_2000, secondsSince2000
};

if (require.main === module) {
  try { main(); } catch (err) { console.error('\n[脚本异常] 脚本异常终止：' + (err && err.stack ? err.stack : err)); process.exit(2); }
}
