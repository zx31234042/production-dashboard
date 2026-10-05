/* ==========================================================================
   模拟上位机（services/mockUpperSource.js）
   需求版本：V1.43（V1.43 / C-113 「13 张表」明确为业务表口径（`schema.sql` 实建 15 张 ＝ 13 业务表 ＋ `schema_meta` ＋ `auth_credential`；`db-check` 的 `REQUIRED_TABLES` ＝ 14），不增删条款，仍 259 / P0 188 / AC 12 / Q 7；V1.42 / C-112 三处口径补写〔DR-05 件序号与终态、FR-4.9 复检数〕；V1.41 / C-111 计量单位定义＋DR-04 件序号补登；V1.40 / C-109＋C-110 口径补写〔FR-5.11 起算点＋DR-05 写入口径〕；V1.39 / C-108 工单超时预警判据改「进度落后率超阈值率」且阈值率可配〔本文件只随需求版本戳同步，无行为改动〕；V1.38 / C-99～C-107 口径收口与接口修正；承 C-98④ / FR-2.5：运行阶段由 `testStatus` 导出 ——
              准备=0／运行=1／判定=2／**完成=回到 0**；"完成"为过渡阶段）
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

  /* ---------------- 异常注入开关（E22 判据①；**默认关闭**） ----------------
     为什么需要它：附录 2 的码 `3`（设备异常 ⇒ 看板显示模式「故障锁定」）是**正交状态**，
     真实上位机偶发才出现、靠等是等不来的 —— 要把它变成**可复跑**的判据，必须能**定点注入**。
     语义（与 tools/mock-upper/mock-upper.js 的同一段**逐字一致**；两处是同一口径的模拟器）：
       · **默认关闭**：`testStatus` 只出现 0/1/2，**永不等于 3**，阶段按 FR-2.5 的四段推进；
       · 注入窗口 [afterSec, afterSec+durSec) **内**：`testStatus = 3`（设备异常），
         同时 `stage` **冻结**在进入窗口那一刻的阶段文本（阶段不随节拍推进）＝"阶段冻结"；
       · 窗口**结束后**：`stage` 从冻结处**继续推进**（恢复），`testStatus` 回到 0/1/2。
     实现方式：窗口内冻结的秒数从节拍里扣掉（`elapsed = rawElapsed - frozen`）⇒ 阶段原地不动。
     开启方式：① `MockUpperSource.setAbnormal({afterSec, durSec})`（自检与联调用）；
              ② 地址栏 `?source=upper&abnormal=<sec>&abnormalDur=<sec>`（演示用；不写＝关闭）。 */
  const ABNORMAL = { enabled: false, afterSec: 0, durSec: 20 };
  function setAbnormal(opts) {
    const o = opts || {};
    ABNORMAL.enabled = o.enabled === true || Number(o.afterSec) > 0;
    ABNORMAL.afterSec = Math.max(0, Number(o.afterSec) || 0);
    ABNORMAL.durSec = Math.max(0, Number(o.durSec) > 0 ? Number(o.durSec) : 20);
    return { enabled: ABNORMAL.enabled, afterSec: ABNORMAL.afterSec, durSec: ABNORMAL.durSec };
  }
  function abnormalState() {
    return { enabled: ABNORMAL.enabled, afterSec: ABNORMAL.afterSec, durSec: ABNORMAL.durSec };
  }
  function abnormalFromSearch(search) {
    const q = new URLSearchParams(search || '');
    if (!q.has('abnormal')) return abnormalState();
    return setAbnormal({ enabled: true, afterSec: Number(q.get('abnormal')), durSec: Number(q.get('abnormalDur') || 0) });
  }
  try {
    if (typeof window !== 'undefined' && window.location && window.location.search) {
      abnormalFromSearch(window.location.search);
    }
  } catch (e) { /* 无 location（vm/离线自检）⇒ 保持默认关闭，不抛错 */ }

  /** 初始化内部随机游走状态 */
  function init(now) {
    return {
      depth: 5.00,         // 航行器水下深度（量程 [4, 6] m；初值＝标准典型值 5.00，与 mockData 一致）
      vx: 5.00,            // 水平速度（初值＝速度标准典型值 ⇒ 合成速度 5.00）
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

    /* ---- 实测数据：随机游走，保持 speed = √(vx²+vy²) ----
       航行器深度量程 [4, 6] m（负责人 2026-09-22 确认，C-86）；游走区间 [4.77, 5.33]、步长 ±0.06/s
       与 services/mockData.js **同一组数值**（标准典型值 5.00、上下限 5.30/4.80；10 万 tick 实测
       正常 58.7% / 临近 26.8% / 超范围 14.5%）—— 否则 ?source=upper 与 mockData 演示口径不一致，
       开屏就判"超范围"，与「测试标准区」显示的标准自相矛盾。
       速度同口径：vx 游走 [4.78, 5.22]、步长 ±0.06/s（标准带 [4.80, 5.20]） */
    s.depth = clamp(round2(s.depth + (Math.random() - 0.5) * 0.12), 4.77, 5.33);
    s.vx = clamp(round2(s.vx + (Math.random() - 0.5) * 0.12), 4.78, 5.22);
    s.vy = clamp(round2(s.vy + (Math.random() - 0.5) * 0.04), -0.25, 0.35);
    const speed = round2(Math.sqrt(s.vx * s.vx + s.vy * s.vy));

    /* ---- 设备参数：帧率 0～1200 fps（本演示取 400 典型工况） ---- */
    s.fpsRaw = clamp(s.fpsRaw + (Math.random() - 0.5) * 1.6, 396, 404);
    s.gainRaw = clamp(s.gainRaw + (Math.random() - 0.5) * 0.06, 2.35, 2.65);
    s.shutterRaw = clamp(s.shutterRaw + (Math.random() - 0.5) * 6, 488, 512);
    s.cameraDepth = clamp(round2(s.cameraDepth + (Math.random() - 0.5) * 0.04), 11.80, 12.20);

    /* ---- 任务进度与运行阶段：4 阶段（准备 / 运行 / 判定 / 完成） ----
       **阶段 ↔ testStatus 的导出规则（C-98④ / FR-2.5；代码语义以附录 2 为准）**：
         准备 = 0（待机）／运行 = 1（测试中）／**判定 = 2（测试完成）**／**完成 = 回到 0**（待机）
       —— "完成"是**过渡阶段**（稳定显示 ≥2 s 或显示到下一次进入"运行"），故**回到 0**；
          "判定"的结束由本方判定（数据处理与 MES 通信完成），不新增"看板 → 上位机"反向信号；
          `3`（设备异常）为**正交状态**：任何阶段都可能出现、出现时阶段冻结（走「故障锁定」+ 单独告警）。
       ⚠ 必须与 tools/mock-upper/mock-upper.js 的同一段**逐字一致**（两处是同一口径的模拟器）。 */
    const cycle = CFG.production.cycleSec;
    const rawElapsed = Math.floor((d.getTime() - s.startedAt) / 1000);
    /* 异常注入窗口按**真实经过秒**判定；窗口内已冻结的秒数从节拍里扣掉 ⇒ 阶段原地不动（阶段冻结） */
    const abn = ABNORMAL.enabled
      ? {
        active: rawElapsed >= ABNORMAL.afterSec && rawElapsed < ABNORMAL.afterSec + ABNORMAL.durSec,
        frozen: Math.max(0, Math.min(rawElapsed, ABNORMAL.afterSec + ABNORMAL.durSec) - ABNORMAL.afterSec)
      }
      : { active: false, frozen: 0 };
    const elapsed = rawElapsed - abn.frozen;
    const unitSec = elapsed % cycle;
    const progress = unitSec / cycle;
    s.unitIndex = Math.floor(elapsed / cycle) + 1;

    let stage, result, testStatus;
    if (unitSec < 8)            { stage = '准备'; result = '待测试'; testStatus = 0; }
    else if (progress < 0.85)   { stage = '运行'; result = '测试中'; testStatus = 1; }
    else if (progress < 0.97)   { stage = '判定'; result = '测试中'; testStatus = 2; }
    else                        { stage = '完成'; result = '测试中'; testStatus = 0; }
    /* 注入窗口内：码换成 `3`（设备异常），`stage` 保持上面算出的**冻结值**不动 —— 阶段冻结＋单独状态码 */
    if (abn.active) testStatus = 3;
    s.abnormal = abn.active;
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

      /* 设定深度 ＝ **相机设定深度**（FR-3.5 / IF-D.3 的「设备参数」，由任务数据页二级菜单
         承载，属上位机侧、不参与本看板判定），**不是航行器深度** ⇒ 不随深度量程 [4, 6] m 迁移，
         保持 12.50（与 tools/mock-upper/mock-upper.js 同构、与 mockData 的"设定深度 12.50 m"公告一致）。 */
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

  return { next, sample, init, setAbnormal, abnormalState, abnormalFromSearch };
})();
