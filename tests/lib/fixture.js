/* ==========================================================================
   确定性样本数据（tests/lib/fixture.js）
   作用：给后端自检提供**固定、可复现**的样本（设备/工单/标准/测量帧/曲线），
        使断言不受随机数与时间影响 —— 同一用例任何时刻跑，结果都一样。
   约定：字段名与 `src/config/fieldMap.js` 的三方映射一致
        （看板 ↔ 上位机报文 ↔ 附录 2 上报），避免测试里另造一套字段名。
       `cameraDepth` 与 `depth` **语义不同**（相机自身深度 / 航行器深度，C-32、IF-C.9）。
   依据：ADR-0003 D17；需求 FR-3.15、DR-04、DR-13、DR-18。
   依赖：仅 Node 内置模块。
   ========================================================================== */
'use strict';

/** 固定种子：换种子会改变所有派生样本，**不要在用例里随意改** */
const SEED = 20260919;

/**
 * 确定性伪随机数发生器（mulberry32：短小、无依赖、同种子同序列）。
 * 为什么要自带而不直接用 Math.random：基准图捕获已经用过"种子化 Math.random"的思路，
 * 测试里同样必须可复现，否则断言会随机飘。
 */
function makePrng(seed = SEED) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** [min, max) 浮点 */
    range: (min, max) => min + next() * (max - min),
    /** [min, max] 整数 */
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    /** 保留 d 位小数 */
    fixed: (min, max, d = 2) => Number((min + next() * (max - min)).toFixed(d)),
    pick: arr => arr[Math.floor(next() * arr.length)]
  };
}

/* ---------------- 静态样本 ---------------- */

/** 设备信息（DR-01）：整套系统 1 个编号，覆盖 19 台相机 */
const device = Object.freeze({
  equipCode: 'EQ-UC-001',
  equipName: '水池高速摄像产品检验设备',
  model: 'UC-19CAM',
  location: '水池测试间',
  upperHost: '127.0.0.1',
  upperPort: 8801,
  mesBaseUrl: 'http://127.0.0.1:8802',
  cameraCount: 19
});

/** 工单任务（DR-02 / IF-A）：字段与需求 §6.1 IF-A.1 对齐 */
const task = Object.freeze({
  procOrderNo: 'PO-20260919-001',
  batchNo: 'BATCH-A-001',
  productCode: 'PRD-UUV-01',
  productName: '水下航行体检验件',
  productNo: 'NO-0001',
  drawingNo: 'SC710-UW-10',
  planQty: 120,
  planStartTime: '2026-09-19 08:00:00',
  planEndTime: '2026-09-19 16:00:00',
  processNo: 'OP-30',
  processName: '水下高速摄像检验'
});

/** 测试标准阈值（DR-03 / FR-3.5～3.8）：属**设备参数**，次要展示 */
const standard = Object.freeze({
  productCode: 'PRD-UUV-01',
  setDepth: 12.0,      // 相机设定深度（m）
  setGain: 1.5,        // 相机设定增益
  setFrameRate: 400,   // 设定帧率（fps，量程 0～1200）
  setShutter: 5000,    // 快门速度（整型，单位待确认）
  effectiveFrom: '2026-09-19 00:00:00'
});

/** 上报字段全集（附录 2 的 13 项），供断言"字段齐全/顺序"用 */
const REPORT_FIELDS = Object.freeze([
  'equipCode', 'procOrderNo', 'frameRate', 'gain', 'shutter', 'cameraDepth', 'depth',
  'speed', 'velocity_x', 'velocity_y', 'collectTime', 'testStatus', 'uploadId'
]);

/* ---------------- 派生样本 ---------------- */

/**
 * 造一帧上位机报文（IF-D 接收侧 / 附录 2 上报侧通用）。
 * **自洽性**：`speed = √(vx²+vy²)`（需求术语表口径），调用方断言时可直接验这条。
 * @param {{at?:string, i?:number, depth?:number, vx?:number, vy?:number, testStatus?:number}} [opts]
 */
function makeFrame(opts = {}) {
  const i = opts.i === undefined ? 0 : opts.i;
  const vx = opts.vx === undefined ? Number((2.8 + Math.sin(i / 7) * 0.6).toFixed(2)) : opts.vx;
  const vy = opts.vy === undefined ? Number((0.9 + Math.cos(i / 11) * 0.25).toFixed(2)) : opts.vy;
  const speed = Number(Math.hypot(vx, vy).toFixed(2));
  const depth = opts.depth === undefined ? Number((12.0 + Math.sin(i / 10) * 0.8).toFixed(2)) : opts.depth;
  return {
    equipCode: device.equipCode,
    procOrderNo: task.procOrderNo,
    frameRate: 400,
    gain: Number((1.5 + Math.sin(i / 13) * 0.1).toFixed(1)),
    shutter: 5000,
    cameraDepth: Number((11.85 + Math.sin(i / 17) * 0.05).toFixed(2)),  // 相机自身深度，≠ depth
    depth,
    speed,
    velocity_x: vx,
    velocity_y: vy,
    collectTime: opts.at || '2026-09-19 10:00:00',
    testStatus: opts.testStatus === undefined ? 1 : opts.testStatus,     // 1=测试中
    uploadId: `UP-${String(i).padStart(6, '0')}`
  };
}

/**
 * 造一串测量帧（节拍内按 1 s 采样），供曲线固化与统计用例使用。
 * @param {{count?:number, startAt?:string, stepSec?:number, startIndex?:number}} [opts]
 *   startIndex 用于与其它批次**错开 collectTime**（否则会被 DR-13 去重键正确拦下）
 */
function makeFrames(opts = {}) {
  const count = opts.count === undefined ? 160 : opts.count;   // 单任务节拍 160 s（开发假设）
  const stepSec = opts.stepSec === undefined ? 1 : opts.stepSec;
  const startIndex = opts.startIndex === undefined ? 0 : opts.startIndex;
  const start = new Date((opts.startAt || '2026-09-19 10:00:00').replace(' ', 'T'));
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start.getTime() + i * stepSec * 1000);
    const pad = n => String(n).padStart(2, '0');
    const at = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    // 帧序号用 startIndex + i，保证"波形随机游走"与时间一一对应，避免不同批次波形完全相同
    out.push(makeFrame({ i: startIndex + i, at }));
  }
  return out;
}

/**
 * 造一条任务曲线的度量（DR-18：采样点序列 + 量程上下限）。
 * @param {{kind?:'depth'|'speed', count?:number, seed?:number}} [opts]
 */
function makeCurve(opts = {}) {
  const kind = opts.kind || 'depth';
  const count = opts.count === undefined ? 160 : opts.count;
  const prng = makePrng(opts.seed === undefined ? SEED : opts.seed);
  const values = [];
  for (let i = 0; i < count; i++) {
    const base = kind === 'depth' ? 12.0 : 3.0;
    const amp = kind === 'depth' ? 0.8 : 0.4;
    values.push(Number((base + Math.sin(i / 10) * amp + prng.range(-0.02, 0.02)).toFixed(2)));
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    procOrderNo: task.procOrderNo,
    unitIndex: 1,
    kind,
    samples: values,
    sampleCount: values.length,
    intervalSec: 1,                    // 与节拍/采样点数推导出来的采样间隔一致
    durationSec: values.length * 1,    // 语义＝秒（不是点数），避免 durationSec 与 sampleCount 混同
    minValue: min,
    maxValue: max,
    finishedAt: '2026-09-19 10:02:40'
  };
}

/** 一次性的完整样本包（多数用例直接用这个） */
function makeSnapshot() {
  return {
    device,
    task,
    standard,
    reportFields: [...REPORT_FIELDS],
    frames: makeFrames({ count: 5 }),
    curves: { depth: makeCurve({ kind: 'depth' }), speed: makeCurve({ kind: 'speed' }) }
  };
}

module.exports = {
  SEED,
  makePrng,
  device,
  task,
  standard,
  REPORT_FIELDS,
  makeFrame,
  makeFrames,
  makeCurve,
  makeSnapshot
};
