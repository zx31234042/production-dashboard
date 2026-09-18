/* ==========================================================================
   模拟上位机（services/mockUpperSource.js）
   作用：在真实上位机接口（Q-21）到位前，产生**符合接口契约的报文**，
        经 services/api.js 的适配层喂给看板，用于端到端自测。
   与 tools/mock-upper/mock-upper.js（Node 版）**同构**：
        两者产出的字段必须与 config/fieldMap.js 的 upperToBoard 键一致。
   用法：地址栏加 ?source=upper 即用本数据源驱动看板（默认走 mockData）
   依赖：config/board.config.js、config/fieldMap.js
   ========================================================================== */
window.MockUpperSource = (function () {
  'use strict';

  const CFG = window.BoardConfig;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const round2 = v => Math.round(v * 100) / 100;
  const round1 = v => Math.round(v * 10) / 10;
  const pad = n => String(n).padStart(2, '0');

  /** 初始化内部随机游走状态 */
  function init(now) {
    return {
      depth: 12.68,        // 航行器水下深度
      vx: 4.90,            // 水平速度
      vy: 0.10,            // 垂直速度
      fpsRaw: CFG.production ? 400 : 400,
      gainRaw: 2.5,
      shutterRaw: 500,
      cameraDepth: 12.00,  // 相机水下深度
      unitIndex: 1,
      result: '测试中',
      lastResult: '合格',
      startedAt: (now || new Date()).getTime()
    };
  }

  /**
   * 产生下一帧报文
   * @param {object} prev 上一帧内部状态（首次传入 null）
   * @param {Date}   now  当前时刻
   * @returns {{payload:object, inner:object}}
   */
  function next(prev, now) {
    const d = now || new Date();
    const s = prev || init(d);

    /* ---- 实测数据：随机游走，保持 speed = √(vx²+vy²) ---- */
    s.depth = clamp(round2(s.depth + (Math.random() - 0.5) * 0.06), 12.20, 13.10);
    s.vx = clamp(round2(s.vx + (Math.random() - 0.5) * 0.10), 4.50, 5.30);
    s.vy = clamp(round2(s.vy + (Math.random() - 0.5) * 0.04), -0.25, 0.35);
    const speed = round2(Math.sqrt(s.vx * s.vx + s.vy * s.vy));

    /* ---- 设备参数：帧率 0～1200 fps（本演示取 400 典型工况） ---- */
    s.fpsRaw = clamp(s.fpsRaw + (Math.random() - 0.5) * 1.6, 396, 404);
    s.gainRaw = clamp(s.gainRaw + (Math.random() - 0.5) * 0.06, 2.35, 2.65);
    s.shutterRaw = clamp(s.shutterRaw + (Math.random() - 0.5) * 6, 488, 512);
    s.cameraDepth = clamp(round2(s.cameraDepth + (Math.random() - 0.5) * 0.04), 11.80, 12.20);

    /* ---- 任务进度与运行阶段：4 阶段（准备 / 运行 / 判定 / 完成） ---- */
    const cycle = CFG.production.cycleSec;
    const elapsed = Math.floor((d.getTime() - s.startedAt) / 1000);
    const unitSec = elapsed % cycle;
    const progress = unitSec / cycle;
    s.unitIndex = Math.floor(elapsed / cycle) + 1;

    let stage, result, testStatus;
    if (unitSec < 8)            { stage = '准备'; result = '待测试'; testStatus = 0; }
    else if (progress < 0.85)   { stage = '运行'; result = '测试中'; testStatus = 1; }
    else if (progress < 0.97)   { stage = '判定'; result = '测试中'; testStatus = 1; }
    else                        { stage = '完成'; result = '测试中'; testStatus = 2; }
    s.result = result;

    const payload = {
      equipCode: CFG.device.equipCode,
      procOrderNo: 'MES20260918001',
      collectTime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
                   `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      testStatus,
      stage,
      linkStatus: 'online',

      depth: s.depth,
      speed,
      velocity_x: s.vx,
      velocity_y: s.vy,

      frameRate: Math.round(s.fpsRaw),
      gain: round1(s.gainRaw),
      shutter: Math.round(s.shutterRaw),
      cameraDepth: s.cameraDepth,

      productCode: 'CP-2026-A17',
      productName: '水下振动测试件',
      batchNo: 'PC20260918-03',
      drawingNo: 'SJ-4471-02',
      orderNo: 'DD20260917-118',
      planQty: CFG.production.planQty,

      stdDepth: 12.50,
      stdGain: 2.5,
      stdFps: 400,
      stdShutter: 500,

      result,
      unitIndex: s.unitIndex,
      progress: round2(progress) / 1
    };

    return { payload, inner: s };
  }

  /** 生成一帧样例报文（供手工粘贴测试） */
  function sample() {
    return next(null, new Date()).payload;
  }

  return { next, sample, init };
})();
