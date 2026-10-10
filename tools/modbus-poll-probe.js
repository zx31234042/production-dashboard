/* modbus-poll-probe.js —— 「看板侧轮询探针（Modbus TCP **主站**）」· **零依赖** · `tools\modbus-poll-probe.js`
 * ---------------------------------------------------------------------------
 * 用途：把看板**接收链**在真 PLC 与真映射表到位之前先跑通，并**当场产出两条最要命口径的证据**：
 *   ㈠ **同一次刷新被读多次 ⇒ 只落一条**（去重键命中 ⇒ 幂等丢弃）
 *   ㈡ **两次刷新落在同一秒 ⇒ 两条都落**（`seq`（数据更新序号）不同 ⇒ 键不同）
 * 它同时是 `src\services\api.js` 将来那条 Modbus 路径的**原型**（只用 `node:net`，零依赖）。
 * 口径来源（**逐字对齐**）：`输出文件\上位机方\接口需求函（第三批）-致设备上位机方.md` **§2.2** 寄存器规划
 *   与 §2.4（`collectTime` 由从站写入）／§2.5（缺值：`null` 或哨兵 **65535**，**不得用 0**）。
 * **不是门禁**（不在 `run-all` 的 suite 清单里）：它是开发/联调夹具；**是否接门禁归负责人**（要接则断言归座位 4b）。
 *
 * 映射（与 §2.2 表逐项一致）：
 *   数值区 `0x0000`×16：`testStatus` UINT16｜**`seq`** UINT16｜`collectTime` UINT32（自 2000-01-01 秒，**高字在前**）｜
 *     `frameRate` UINT16 fps｜`gain` INT16 ×10｜`shutter` UINT16 μs｜`cameraDepth` INT16 ×100 m｜`depth` INT16 ×100 m｜
 *     `speed` INT16 ×100 m/s｜`velocity_x`/`velocity_y` INT16 ×100 m/s｜保留｜设定深度 INT16 ×100｜设定增益 INT16 ×10｜设定帧率 UINT16
 *   字符串区 `0x0020`×10：`equipCode` 8 字符（4 寄存器）＋ `procOrderNo` 12 字符（6 寄存器）
 * 缺值：数值型 `0xFFFF`（哨兵 65535）⇒ **映射为 `null`**（§2.5；**不得用 0**）。
 * 去重键（`DR-13` ＋ `E25` 的修法）：`equipCode ＋ procOrderNo ＋ collectTime ＋ seq`；口径＝**后到覆盖先到**（幂等）。
 *
 * 用法：
 *   node tools\modbus-poll-probe.js --self-test               自测：映射/解码/键构造 ＋ **两条口径的现场读数**
 *   node tools\modbus-poll-probe.js --emit-map                打印 `fieldMap` 设计稿（真映射表到手即可填）
 *   node tools\modbus-poll-probe.js --port 8502 [--interval 200] [--rounds 10] [--verbose]
 *                                                            轮询**已在运行的**从站（如 mock-modbus-slave）
 * ---------------------------------------------------------------------------
 */
'use strict';

const net = require('node:net');
const sim = require('./mock-modbus-slave.js');   /* 同进程用；被 require 时它不跑任何东西 */

const { N, NUM_BASE, NUM_LEN, STR_BASE, STR_LEN } = sim;
const SENTINEL = 0xFFFF;

/* ============================ 映射（§2.2 表） ============================ */
/** 字段表：name ＋ 取值器（regs 为数值区 Uint16Array） */
const FIELDS = [
  { name: 'testStatus', unit: '—', get: (r) => r[N.testStatus] },
  { name: 'seq', unit: '—', get: (r) => r[N.seq] },
  { name: 'collectTime', unit: 's(2000 起)', get: (r) => ((r[N.ctHi] << 16) | r[N.ctLo]) >>> 0 },
  { name: 'frameRate', unit: 'fps', get: (r) => u16(r[N.frameRate]) },
  { name: 'gain', unit: 'dB', get: (r) => scaled(i16(r[N.gainX10]), 10), scale: '÷10' },
  { name: 'shutter', unit: 'μs', get: (r) => u16(r[N.shutter]) },
  { name: 'cameraDepth', unit: 'm', get: (r) => scaled(i16(r[N.cameraDepthX100]), 100), scale: '÷100' },
  { name: 'depth', unit: 'm', get: (r) => scaled(i16(r[N.depthX100]), 100), scale: '÷100' },
  { name: 'speed', unit: 'm/s', get: (r) => scaled(i16(r[N.speedX100]), 100), scale: '÷100' },
  { name: 'velocity_x', unit: 'm/s', get: (r) => scaled(i16(r[N.vxX100]), 100), scale: '÷100' },
  { name: 'velocity_y', unit: 'm/s', get: (r) => scaled(i16(r[N.vyX100]), 100), scale: '÷100' },
  { name: 'setDepth', unit: 'm', get: (r) => scaled(i16(r[N.setDepthX100]), 100), scale: '÷100' },
  { name: 'setGain', unit: 'dB', get: (r) => scaled(i16(r[N.setGainX10]), 10), scale: '÷10' },
  { name: 'setFrameRate', unit: 'fps', get: (r) => u16(r[N.setFrameRate]) }
];
/** 标度**必须先判缺值再除**：`null / 10` 会变成 `0`（＝把"缺值"伪装成合法读数）—— 自测抓到的真缺陷。 */
const scaled = (v, d) => (v === null ? null : v / d);
const u16 = (w) => (w === SENTINEL ? null : w);                       /* §2.5：哨兵 ⇒ null（**0 是合法值，不当作缺值**） */
const i16 = (w) => (w === SENTINEL ? null : (w & 0x8000 ? w - 0x10000 : w));
const ascii = (regs, base, chars) => {
  let s = '';
  for (let i = 0; i < chars; i += 2) {
    const w = regs[base + (i >> 1)];
    s += String.fromCharCode((w >> 8) & 0xFF) + String.fromCharCode(w & 0xFF);
  }
  return s.replace(/\0+$/, '');
};

/** 把两段寄存器解释为一条记录（§2.2 布局） */
function decodeRecord(numRegs, strRegs) {
  const rec = { equipCode: ascii(strRegs, 0, 8), procOrderNo: ascii(strRegs, 4, 12) };
  for (const f of FIELDS) rec[f.name] = f.get(numRegs);
  return rec;
}
/** 去重键（`DR-13` ＋ `E25` 的修法）：`equipCode ＋ procOrderNo ＋ collectTime ＋ seq` */
const keyOf = (rec) => [rec.equipCode, rec.procOrderNo, rec.collectTime, rec.seq].join('|');

/* ============================ Modbus TCP 主站（客户端） ============================ */
/** 一个极简的"读保持寄存器"客户端：**只用 node:net**（零依赖），带超时与按 MBAP 切帧 */
function readHolding({ host = '127.0.0.1', port, unit = 1, addr, qty, timeoutMs = 1500 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let acc = Buffer.alloc(0), done = false;
    const finish = (err, val) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(val); };
    sock.setTimeout(timeoutMs, () => finish(new Error('读超时')));
    sock.on('error', (e) => finish(e));
    sock.on('connect', () => {
      const body = Buffer.from([unit, 0x03, (addr >> 8) & 0xFF, addr & 0xFF, (qty >> 8) & 0xFF, qty & 0xFF]);
      const head = Buffer.from([0x00, 0x01, 0x00, 0x00, (body.length >> 8) & 0xFF, body.length & 0xFF]);
      sock.write(Buffer.concat([head, body]));
    });
    sock.on('data', (d) => {
      acc = Buffer.concat([acc, d]);
      if (acc.length < 6) return;
      const len = acc.readUInt16BE(4);
      if (acc.length < 6 + len) return;
      const pdu = acc.subarray(7, 6 + len);
      if ((pdu[0] & 0x80) !== 0) return finish(new Error('从站异常 0x' + pdu[1].toString(16)));
      if (pdu[0] !== 0x03) return finish(new Error('非 0x03 应答：0x' + pdu[0].toString(16)));
      const out = new Uint16Array(qty);
      for (let i = 0; i < qty; i++) out[i] = pdu.readUInt16BE(2 + i * 2);
      finish(null, out);
    });
  });
}

/** 从一次"轮询"取回一条记录（两段：数值区 ＋ 字符串区） */
async function pollOnce(opts) {
  const num = await readHolding({ ...opts, addr: NUM_BASE, qty: NUM_LEN });
  const str = await readHolding({ ...opts, addr: STR_BASE, qty: STR_LEN });
  return decodeRecord(num, str);
}

/* ============================ 去重（后到覆盖先到） ============================ */
function createStore() {
  const byKey = new Map();
  const stats = { received: 0, inserted: 0, overwritten: 0, identical: 0 };
  const put = (rec) => {
    stats.received += 1;
    const k = keyOf(rec);
    if (!byKey.has(k)) { byKey.set(k, rec); stats.inserted += 1; return 'inserted'; }
    const same = JSON.stringify(byKey.get(k)) === JSON.stringify(rec);
    byKey.set(k, rec);
    if (same) { stats.identical += 1; return 'identical'; }
    stats.overwritten += 1; return 'overwritten';
  };
  return { byKey, stats, put };
}

/* ============================ fieldMap 设计稿 ============================ */
function emitMap() {
  const rows = [
    ['testStatus', 'UINT16', '4x', NUM_BASE + N.testStatus, '—', '0=待机／1=测试中／2=测试完成／3=设备异常'],
    ['seq', 'UINT16', '4x', NUM_BASE + N.seq, '—', '**每次数据刷新 +1**（去重键成员）'],
    ['collectTime', 'UINT32（高字在前）', '4x', NUM_BASE + N.ctHi, 's（自 2000-01-01）', '**由从站写入**（接收侧不得盖章）'],
    ['frameRate', 'UINT16', '4x', NUM_BASE + N.frameRate, 'fps', ''],
    ['gain', 'INT16 ÷10', '4x', NUM_BASE + N.gainX10, 'dB', ''],
    ['shutter', 'UINT16', '4x', NUM_BASE + N.shutter, 'μs', ''],
    ['cameraDepth', 'INT16 ÷100', '4x', NUM_BASE + N.cameraDepthX100, 'm', '相机自身深度 ≠ depth'],
    ['depth', 'INT16 ÷100', '4x', NUM_BASE + N.depthX100, 'm', '航行器深度'],
    ['speed', 'INT16 ÷100', '4x', NUM_BASE + N.speedX100, 'm/s', ''],
    ['velocity_x', 'INT16 ÷100', '4x', NUM_BASE + N.vxX100, 'm/s', ''],
    ['velocity_y', 'INT16 ÷100', '4x', NUM_BASE + N.vyX100, 'm/s', ''],
    ['(保留)', 'UINT16', '4x', NUM_BASE + N.reserved, '—', ''],
    ['setDepth', 'INT16 ÷100', '4x', NUM_BASE + N.setDepthX100, 'm', '设定值类（`IF-D.3`）'],
    ['setGain', 'INT16 ÷10', '4x', NUM_BASE + N.setGainX10, 'dB', '设定值类'],
    ['setFrameRate', 'UINT16', '4x', NUM_BASE + N.setFrameRate, 'fps', '设定值类'],
    ['equipCode', 'ASCII 8 字符（4 寄存器）', '4x', STR_BASE, '—', '每寄存器 2 字符、**高字节在前**、补 0x00'],
    ['procOrderNo', 'ASCII 12 字符（6 寄存器）', '4x', STR_BASE + 4, '—', '同上']
  ];
  console.log('/* fieldMap 设计稿（由 `tools\\modbus-poll-probe.js --emit-map` 生成）');
  console.log(' * 依据：`输出文件\\上位机方\\接口需求函（第三批）-致设备上位机方.md` §2.2／§2.4／§2.5；');
  console.log(' * ⚠ 真映射表到手后**逐项替换**本表（地址/类型/字序/标度/无效值以贵方答复为准）。 */');
  console.log('const FIELDS = [');
  for (const [name, type, area, addr, unit, note] of rows) {
    const a = '0x' + addr.toString(16).padStart(4, '0').toUpperCase();
    console.log(`  { name: '${name}', area: '${area}', addr: '${a}', type: '${type}', unit: '${unit}'${note ? ", note: '" + note + "'" : ''} },`);
  }
  console.log('];');
  console.log(`const DEDUP_KEY = ['equipCode', 'procOrderNo', 'collectTime', 'seq'];   /* DR-13 ＋ E25 修法 */`);
  console.log(`const INVALID = 0xFFFF;                                            /* 哨兵 ⇒ null（§2.5；0 是合法值） */`);
}

/* ============================ 自测（含两条口径的现场读数） ============================ */
async function selfTest() {
  const cases = [];
  const push = (label, got, want) => cases.push({ label, got, want, ok: JSON.stringify(got) === JSON.stringify(want) });
  const slave = sim.createSlave({ unit: 1 });
  slave.refresh({ testStatus: 1, frameRate: 500, gainX10: 125, shutter: 800, cameraDepthX100: 450, depthX100: 480,
    speedX100: 320, vxX100: 210, vyX100: 241, setDepthX100: 500, setGainX10: 100, setFrameRate: 400 }, Date.UTC(2026, 9, 10, 10, 3, 20));
  const srv = await sim.startServer(slave, { port: 0, host: '127.0.0.1' });
  const port = srv.address().port;
  const opts = { port, unit: 1, host: '127.0.0.1' };

  /* ① 解码：一次性读回并映射（含字符串区与标度） */
  const rec = await pollOnce(opts);
  push('① 解码 `equipCode`／`procOrderNo`（ASCII 高字节在前）', [rec.equipCode, rec.procOrderNo], ['SX-UND-1', 'WO-20261010']);
  push('① 解码标度（gain ÷10、depth ÷100、cameraDepth ÷100）', [rec.gain, rec.depth, rec.cameraDepth], [12.5, 4.8, 4.5]);
  push('① 解码 `collectTime`（UINT32 高字在前，自 2000-01-01 秒）', rec.collectTime, 844941800);
  push('① `testStatus` 原样（不做标度）', rec.testStatus, 1);

  /* ② 缺值：哨兵 65535 ⇒ null；**0 是合法值，必须原样保留** */
  slave.bank[N.gainX10] = 0xFFFF; slave.bank[N.depthX100] = 0;
  const rec2 = await pollOnce(opts);
  push('② 哨兵 65535 ⇒ `null`（§2.5）', rec2.gain, null);
  push('② `0` 原样保留（**不得当缺值**）', rec2.depth, 0);
  slave.bank[N.gainX10] = 125; slave.bank[N.depthX100] = 480;

  /* ③ 去重键：`equipCode ＋ procOrderNo ＋ collectTime ＋ seq` */
  const r3 = await pollOnce(opts);
  push('③ 键＝四段拼接（含 `seq`）', keyOf(r3), ['SX-UND-1', 'WO-20261010', r3.collectTime, r3.seq].join('|'));

  /* ④ **口径㈠现场读数**：同一次刷新被读 5 次 ⇒ 键全同 ⇒ **只落 1 条** */
  const storeA = createStore();
  const seqPinned = slave.bank[N.seq];
  for (let i = 0; i < 5; i++) { const r = await pollOnce(opts); storeA.put(r); }
  push('④ 口径㈠：同一次刷新读 5 次 ⇒ 键相同（`seq` 不变）', [storeA.stats.received, storeA.byKey.size, slave.bank[N.seq] === seqPinned], [5, 1, true]);
  console.log(`      现场读数㈠：读到 ${storeA.stats.received} 条 ⇒ 落库 **${storeA.byKey.size}** 条（inserted ${storeA.stats.inserted}／identical ${storeA.stats.identical}）`);

  /* ⑤ **口径㈡现场读数**：同一秒内两次刷新（`seq` +1、`collectTime` 秒不变）⇒ **两条都落** */
  const storeB = createStore();
  const nowMs = Date.now();
  slave.refresh({ testStatus: 1 }, nowMs);              /* 第一次刷新（同秒） */
  const rA = await pollOnce(opts); storeB.put(rA);
  slave.refresh({ testStatus: 2 }, nowMs + 300);        /* 第二次刷新：**同一秒内**（+300 ms） */
  const rB = await pollOnce(opts); storeB.put(rB);
  push('⑤ 口径㈡：同秒两次刷新 ⇒ `collectTime` 相同而 `seq` 不同', [rA.collectTime === rB.collectTime, rB.seq === ((rA.seq + 1) & 0xFFFF)], [true, true]);
  push('⑤ 口径㈡：⇒ **两条都落**（键不同）', [storeB.stats.received, storeB.byKey.size], [2, 2]);
  console.log(`      现场读数㈡：读到 ${storeB.stats.received} 条 ⇒ 落库 **${storeB.byKey.size}** 条（` +
    `collectTime ${rA.collectTime}／${rB.collectTime}，seq ${rA.seq}／${rB.seq}）`);

  /* ⑥ 键相同但内容不同 ⇒ **后到覆盖先到**（`DR-13` 口径） */
  const storeC = createStore();
  const base = await pollOnce(opts);
  storeC.put(base);
  storeC.put({ ...base, depth: 9.99 });                 /* 同键、内容不同 */
  push('⑥ 同键不同内容 ⇒ 覆盖（`overwritten`）且库里仍 1 条', [storeC.stats.overwritten, storeC.byKey.size, storeC.byKey.get(keyOf(base)).depth], [1, 1, 9.99]);

  srv.close();
  let ok = 0;
  for (const c of cases) {
    if (c.ok) ok += 1;
    console.log((c.ok ? '  [PASS] ' : '  [FAIL] ') + c.label + ' —— 实测 ' + JSON.stringify(c.got) + (c.ok ? '' : '（期望 ' + JSON.stringify(c.want) + '）'));
  }
  console.log('\n汇总：' + ok + '/' + cases.length + ' 相符');
  return ok === cases.length;
}

/* ============================ CLI ============================ */
function usage() {
  console.log('用法：node tools\\modbus-poll-probe.js --self-test | --emit-map');
  console.log('      node tools\\modbus-poll-probe.js --port 8502 [--interval 200] [--rounds 10] [--unit 1] [--verbose]');
  console.log('（轮询模式需要已运行的从站，例如：node tools\\mock-modbus-slave.js --port 8502 --step-ms 200）');
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  if (has('--help') || has('-h')) { usage(); return; }
  if (has('--emit-map')) { emitMap(); return; }
  if (has('--self-test')) { process.exit((await selfTest()) ? 0 : 1); }
  if (!has('--port')) { usage(); return; }
  const port = Number(val('--port')), unit = Number(val('--unit', 1));
  const interval = Number(val('--interval', 200)), rounds = Number(val('--rounds', 10));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口非法：' + val('--port', ''));
  const store = createStore();
  console.log(`[probe] 轮询 ${rounds} 轮 × ${interval} ms（127.0.0.1:${port}，unit=${unit}）`);
  for (let i = 0; i < rounds; i++) {
    const t0 = Date.now();
    try {
      const rec = await pollOnce({ port, unit, host: '127.0.0.1' });
      const act = store.put(rec);
      console.log(`[probe] #${i + 1} ${act.padEnd(11)} key=${keyOf(rec)} depth=${rec.depth} speed=${rec.speed}（${Date.now() - t0} ms）`);
    } catch (e) { console.log(`[probe] #${i + 1} 失败：${e.message}`); }
    if (i < rounds - 1) await new Promise((r) => setTimeout(r, Math.max(0, interval)));
  }
  console.log(`[probe] 读数：收到 ${store.stats.received} 条 ⇒ 落库 ${store.byKey.size} 条（inserted ${store.stats.inserted}／identical ${store.stats.identical}／overwritten ${store.stats.overwritten}）`);
}

if (require.main === module) {
  main().catch((err) => { console.error('\n[脚本异常] 脚本异常终止：' + (err && err.stack ? err.stack : err)); process.exit(2); });
}

module.exports = { FIELDS, keyOf, decodeRecord, readHolding, pollOnce, createStore, SENTINEL };
