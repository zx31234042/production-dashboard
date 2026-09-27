/* ==========================================================================
   模拟数据源（services/mockData.js）— 按需求清单 V1.38 口径编写
             （V1.38 / C-99～C-107 口径收口与接口修正；承 V1.37 / C-98「只统一 `testStatus` 码语义与运行阶段映射（改在 config/fieldMap.js
              与两处模拟上位机），本文件数据与口径未变；
              V1.36 / C-96（U-5） 只精简测试标准区说明行文案）
   作用：产生并逐秒推进看板所需的全部数据；界面组件只读取本文件输出的 state
   依赖：utils/format.js（需先加载）
   口径说明：
   - depth  : 航行器深度（相机系统测量的航行器水下深度，非相机自身下放深度）— C-32
   - speed  : 航行速度（X-Y 平面合成），velocity_x / velocity_y 为分速度 — C-23
   - 主要展示：航行器深度 + 航行速度；相机参数（帧率/增益/快门）为设备参数，次要展示 — C-31
   - 判定对象：**深度与速度的测试标准上下限**（FR-3.14 改写 C-75 / FR-3.18）；相机参数属上位机侧
     设备参数，本看板**既不做判定、也不做状态判定**（C-84④）⇒ 参数类预警（FR-5.8「参数阈值临近预警」
     / 「参数超范围预警」两类）一律**不得引用任何相机参数**；标准未设定（必要项缺失）时不做判定、
     不产生任何参数类预警
   - 参数类预警的**条数口径**（负责人 2026-09-22"预警名称需要细分"）：**一个参数最多一条** ——
     深度与速度各自按最坏态择名（临近 ⇒「参数阈值临近预警」warn；超范围 ⇒「参数超范围预警」err），
     互不合并 ⇒ 参数类最多 2 条，加上维保/耗材/工单三类固定各 1 条 ⇒ `state.warnings` 最多 5 条
   - 演示取值（负责人 2026-09-22 把深度量程改定为 [4, 6] m，并**批准调演示数据**使三态在几十秒的
     演示窗口内可见、且不再"超范围红常亮"）：**标准值不改**（深度标准典型值 5.00、上下限 5.30/4.80
     由需求 C-86 冻结；速度标准 5.00、上下限 5.20/4.80 为演示占位），只调**演示游走区间与步长**：
       · 深度游走 [4.77, 5.33]、步长 ±0.06/s ⇒ 实测 10 万 tick：正常 58.7% / 临近 26.8% / 超范围 14.5%
       · 速度（分速度 vx）游走 [4.78, 5.22]、步长 ±0.06/s ⇒ 正常 59.8% / 临近 25.5% / 超范围 14.7%
     两者目标分布均 ≈ 负责人要求的 60 / 25 / 15；演示值始终落在量程内（深度 [4,6] m、速度 [3,8] m/s）。
     改前口径（深度 [4.60,5.45]、vx [4.50,5.30]，步长 ±0.03/±0.05）实测 2 万 tick：
     深度 47/19/34、速度 32/14/55 ⇒「参数超范围预警」在 70% 的帧上常亮（现场会被读成"总在报警"）。
   - 测试标准来源（FR-3.18）：`state.task.standard`（FR-3.19 现场录入）优先，未建立时回退
     `config/board.config.js` 的 `standards.default`（仅演示）
   - 19 台相机的取值/整合由 PC 上位机完成，本看板按给定值直接展示，不做二次聚合 — C-30/IF-D.13
   - 统计口径与班次时间严格一致：班次进度、运行时长、产量均由当前时钟推导，跨班次自动清零（FR-4.16）
   后期接入真实接口时：本文件由 services/api.js 替代（见 PROJECT_RULES 9.2）
   ========================================================================== */
window.MockData = (function () {
  'use strict';

  /* ---------------- 基础参数：优先取 config/board.config.js，未加载时用默认值 ----------------
     这样"班次时间(Q-10)""统计参数(Q-11)""维保参数(Q-13)"答复后只需改配置文件。 */
  const BC = window.BoardConfig || {};
  const BCshift = BC.shift || {};
  const BCprod = BC.production || {};
  const BCmaint = BC.maintenance || {};
  const BCdev = BC.device || {};
  /* 耗材清单（Q-13）：第 1 项为水下光源，其 threshold 即更换阈值 */
  const BClamp = (BCmaint.consumables && BCmaint.consumables[0]) || {};

  const CFG = {
    deviceName: BCdev.name || '水池高速摄像检验设备',
    equipCode: BCdev.equipCode || 'SX-UNDERWATER-001',   // 整套系统 1 个编号（覆盖 19 台相机）
    team: (BCshift.roster && BCshift.roster.team) || '检验一班',
    operator: (BCshift.roster && BCshift.roster.operator) || '张伟',
    operatorId: (BCshift.roster && BCshift.roster.operatorId) || 'A1027',
    leader: (BCshift.roster && BCshift.roster.leader) || '李建国',
    leaderId: (BCshift.roster && BCshift.roster.leaderId) || 'A1003',
    planQty: BCprod.planQty || 180,              // 当班计划测试总数（Q-11）
    cycleSec: BCprod.cycleSec || 160,            // 单台测试节拍（秒）
    runRate: BCprod.runRate || 0.79,             // 有效运行占比 → 稼动率（Q-11）
    firstPassRate: BCprod.firstPassRate || 0.932,// 一次性测试合格率（Q-11）
    queueDepth: BCprod.queueDepth || 72,         // 设备侧待测试排队量
    maintLast: BCmaint.lastDate || '2026-08-28', // 上次维保日期（Q-13）
    maintCycleDays: BCmaint.cycleDays || 30,     // 固定维保周期（Q-13）
    maintWarnDays: BCmaint.warnDays || 14,       // 维保到期预警提前天数（Q-13，APP 6）
    lampBaseline: 780,                           // 水下光源"上次更换后"累计点亮时长（h，演示基准）
    lampThreshold: BClamp.threshold || 800,      // 水下光源更换阈值（h，Q-13 耗材清单第 1 项）
    unlockPassword: '8888'                       // 演示密码（正式实现由服务端校验，NFR-14）
  };

  /* 班次定义来自配置（Q-10）；未配置时用默认三段班 */
  const SHIFTS = (BCshift.list && BCshift.list.length)
    ? BCshift.list
    : [
        { name: '晚班', start: 0,  end: 8  },
        { name: '早班', start: 8,  end: 16 },
        { name: '中班', start: 16, end: 24 }
      ];

  /* 设备参数（相机侧）：实际帧率量程 0～1200 fps，此处按 SHS-201 典型工况取 400 fps */
  const DEVICE_NOMINAL = { fps: 400, gain: 2.5, shutter: 500 };

  /* 任务曲线：按任务完成更新，每个任务按 1 s 采样，采样点数与节拍一致 */
  const CURVE_SAMPLES = (BC.curve && BC.curve.samples) || CFG.cycleSec || 160;

  /* 单任务判定结果（FR-3.13 五态：待测试 / 测试中 / 合格 / 不合格 / 待复检）
     演示口径：绝大多数合格，每 31 件出现 1 件不合格、每 23 件出现 1 件待复检 */
  function verdictOf(unitIndex) {
    if (unitIndex % 23 === 0) return '待复检';
    if (unitIndex % 31 === 0) return '不合格';
    return '合格';
  }

  /* 生成"上一次任务"的完整曲线（仅用于演示：模拟上位机已整合完成的历史任务数据） */
  function synthCurve(unitIndex) {
    const depth = [], speed = [];
    let vx = 5.00, vy = 0.10;
    for (let i = 0; i < CURVE_SAMPLES; i++) {
      const phase = i / (CURVE_SAMPLES - 1);
      /* 深度演示取值（量程 [4, 6] m ⇒ 演示值必须落进该量程）：clamp 与下方 state.task.real.depth
         的游走区间取**同一段** [4.77, 5.33]；基线取标准带中点 5.05、振幅 0.24 ⇒ 曲线自"正常"缓升
         穿过"临近"带、峰值触到上限 5.30 附近（同一份判据下三态都出现，不会"曲线永远全绿"）。 */
      const base = 5.05 + 0.24 * Math.sin(Math.PI * phase);   // 任务内深度呈缓升缓降形态
      depth.push(clamp(round2(base + (Math.random() - 0.5) * 0.05), 4.77, 5.33));
      vx = clamp(round2(vx + (Math.random() - 0.5) * 0.12), 4.78, 5.22);
      vy = clamp(round2(vy + (Math.random() - 0.5) * 0.04), -0.25, 0.35);
      speed.push(round2(Math.sqrt(vx * vx + vy * vy)));
    }
    return { depth: makeCurve(depth, unitIndex), speed: makeCurve(speed, unitIndex) };
  }

  function makeCurve(values, unitIndex) {
    const v = values.slice();
    return {
      taskNo: '', unitIndex, values: v,
      /* 采样间隔 = 节拍 / 采样点数（默认 1 s/点）；时长由采样数与间隔推导，避免与 sampleCount 混同 */
      durationSec: v.length * (CFG.cycleSec / CURVE_SAMPLES), sampleCount: v.length,
      lo: Math.min.apply(null, v), hi: Math.max.apply(null, v)
    };
  }

  /* 故障代码字典来自配置（Q-12）；未配置时用内置示例 */
  const ALARM_POOL = (BC.faultDict && BC.faultDict.length)
    ? BC.faultDict.map(f => ({ code: f.code, type: f.type, desc: f.desc, level: f.level, action: f.action }))
    : [
        { code: 'E-2071', type: '相机通信中断', desc: '高速相机 GigE 链路瞬时丢包，已自动重连', level: '严重', action: '复核图像完整性' },
        { code: 'E-3115', type: '深度测量异常', desc: '航行器深度数据跳变超过 0.5 m，已复核并重新标定', level: '严重', action: '重新标定后复检' },
        { code: 'E-1042', type: '水池液位偏低', desc: '液位低于测试下限，请补充水量', level: '一般', action: '补充水量' },
        { code: 'W-2210', type: '快门参数超限', desc: '快门设定值超出工艺窗口上限', level: '预警', action: '核对工艺参数' },
        { code: 'E-4520', type: '上位机数据传输异常', desc: '实时测量数据上传中断超过 5 秒', level: '严重', action: '检查链路与上位机状态' }
      ];

  const MAINT_RECORDS = [
    { time: '2026-08-28 09:20', content: '更换水下光源密封圈、清洁镜头', owner: '李建国', state: '已验收' },
    { time: '2026-08-14 14:05', content: '深度传感器标定、相机增益校准', owner: '王强',  state: '已验收' },
    { time: '2026-07-30 10:40', content: '滑台导轨润滑、限位开关检查',   owner: '李建国', state: '已验收' },
    { time: '2026-07-16 15:15', content: '水池过滤网清洗、水质检测',     owner: '赵敏',  state: '已验收' }
  ];

  const NOTICES = [
    { tag: '生产调整', text: '本班次优先加工 CP-2026-A17 批次，其余型号顺延至下一班次', time: '16:05', lv: 'info' },
    { tag: '工艺变更', text: 'A17 型号相机增益由 2.2 调整为 2.5，设定深度 12.50 m，请确认参数已下发至设备', time: '15:40', lv: 'warn' },
    { tag: '临时管控', text: '水池区域动火作业需班组长现场确认后方可实施，作业期间设备须处于正常停机状态', time: '14:12', lv: 'err' },
    { tag: '车间公示', text: '9 月质量月活动方案已张贴于车间公告栏，请各班组长组织学习并签字确认', time: '09:30', lv: 'info' },
    { tag: '生产调整', text: '明日早班开展设备月度维保，预计占用 2 小时，请提前安排测试计划', time: '08:15', lv: 'info' }
  ];

  const TIPS = [
    { tag: '测试要求', text: '下潜速度 ≤ 0.15 m/s，入水后静置 3 秒再开始采集，避免气泡影响成像' },
    { tag: '质量管控', text: '航行器深度与航行速度为主要判据，数据跳变时须人工复核后再判定' },
    { tag: '操作注意', text: '更换工装后必须执行一次空载试运行，并确认相机实际帧率稳定在设定值 ±1%' },
    { tag: '设备保护', text: '连续运行 4 小时后应安排 10 分钟待机，防止光源过热导致图像偏暗' },
    { tag: '数据要求', text: '每班次结束前确认当班数据已完整上传 MES，异常报文需当日闭环' }
  ];

  /* ---------------- 通用工具（统一来自 utils/format.js） ---------------- */
  const { pad, clamp, round1, round2 } = window.Format;

  /* 班次推导（头屏 FR-1.9/1.10 的班次名与起止、FR-4.16 的跨零点归属都由它出）——
     ⚠ 与 `server/services/shift.js` 的 `at()` **同口径**（浏览器侧不能 require 服务端模块，
        故这里是**逐字同规则的第二份实现**），**改动须同步**，否则头屏班次与服务端统计会分叉
        （R26-P3-5）。四条同规则：
        ① 命中判据（半开区间）：`end > start` ⇒ `[start, end)`；`end < start`（跨零点，如 22→6）
           ⇒ `[start, 24) ∪ [0, end)`；
        ② `end === 24` 表示次日 0 点（结束日 +1）；
        ③ 归属日 = 班次**开始**那天（跨零点且处于 0～end 段时回退一天）；
        ④ 时刻不属任何班次（配置缺口）⇒ **显式抛错**，不静默兜底。旧实现 `|| SHIFTS[2]`
           既**不支持跨零点**（22→6 在 0～5 点恒无命中），又会在缺口时悄悄给出**末段**班次
           （实测：三段含跨零点配置下 03:00 被显示成末段「中班 14:00-22:00」、进度 0）。 */
  function shiftOf(now) {
    const hour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
    const inRule = (r, h) => (r.end > r.start ? (h >= r.start && h < r.end) : (h >= r.start || h < r.end));
    const s = SHIFTS.find(x => inRule(x, hour));
    if (!s) {
      throw new Error(`班次配置存在缺口：${pad(now.getHours())}:${pad(now.getMinutes())} 不属任何班次` +
        `（班次表 ${SHIFTS.map(x => `${x.name} ${x.start}-${x.end}`).join(' / ')}）`);
    }
    /* 跨零点规则且当前处于**次日凌晨**那一段（如 22→6 的 03:00）：班次开始于前一天 22:00，
       起止时刻随之回退一天（与 shift.js 的 `startDayOffset` 同一含义），total 仍为完整班次时长 */
    const back = (s.end < s.start && hour < s.end) ? -1 : 0;
    const start = new Date(now); start.setHours(s.start === 24 ? 0 : s.start, 0, 0, 0);
    start.setDate(start.getDate() + back);
    const end = new Date(now); end.setHours(s.end === 24 ? 0 : s.end, 0, 0, 0);
    end.setDate(end.getDate() + back);
    if (s.end === 24) end.setDate(end.getDate() + 1);
    if (s.end <= s.start) end.setDate(end.getDate() + 1);
    return { def: s, start, end, total: (end - start) / 1000 };
  }

  /* ---------------- 状态 ---------------- */
  const state = {
    cfg: CFG,
    device: { name: CFG.deviceName, code: CFG.equipCode, link: 'online', mes: 'online' },
    clock: { date: '', week: '', time: '' },
    shift: { list: SHIFTS },
    status: { mode: '测试运行', stage: '准备', online: '在线正常' },   // 深度/速度只由 task.real 维护，避免双份
    task: {
      procOrderNo: 'MES20260917001', productCode: 'CP-2026-A17', productName: '水下振动测试件',
      batchNo: 'PC20260917-03', drawingNo: 'SJ-4471-02', orderNo: 'DD20260916-118',
      /* 相机侧设备参数（FR-3.5 / IF-D.3 的「**相机设定深度**」等四项；键名对应 board.config.camera.rows
         的 `key`，由 TaskPanel.renderCameras() 渲染进任务数据页二级菜单（FR-3.16，只读展示））：
         `depth` ＝**相机设定深度**（与 `real.cameraDepth`＝相机自身水下深度**同侧**，典型 12.50），
         增益/帧率/快门同属此类。**设备参数不参与本看板判定**（C-84④）。
         ⚠ 这**不是**测试标准上下限 —— 测试标准（典型值 ± 上下偏差）在 `state.task.standard`（FR-3.18/3.19），
            两套数据语义不同、各有单一真源，切勿互相取值。 */
      std:  { depth: 12.50, gain: DEVICE_NOMINAL.gain, fps: DEVICE_NOMINAL.fps, shutter: DEVICE_NOMINAL.shutter },
      /* 实时实测：航行器深度与速度为实测主体；相机参数为设备参数。
         深度初值取标准典型值 5.00 —— 演示深度量程为 [4, 6] m（负责人 2026-09-22 确认）；
         速度初值同取典型值 5.00（vx 5.00 / vy 0.10 ⇒ 合成速度 5.00），故开屏即"正常"态、
         随游走在几十秒内依次出现"临近/超范围"（见本文件头部"演示取值"口径）。 */
      real: { depth: 5.00, speed: 5.00, vx: 5.00, vy: 0.10,
              fps: DEVICE_NOMINAL.fps, gain: DEVICE_NOMINAL.gain, shutter: DEVICE_NOMINAL.shutter,
              cameraDepth: 12.00 },   // 相机自身水下深度（FR-3.16 / IF-D.1，与航行器深度 depth 严格区分）
      fpsRaw: DEVICE_NOMINAL.fps, gainRaw: DEVICE_NOMINAL.gain, shutterRaw: DEVICE_NOMINAL.shutter,
      unitIndex: 1, progress: 0, result: '测试中', lastResult: '合格', planQty: CFG.planQty
    },
    /* 统计：加载期为"未算过"（空对象），首帧 `tick()` 写入 `computeStats()` 的结果；
       `noData` 是**显式状态位**（E38）：true ⇒ 本帧的统计值**不成立**（班次配置缺口 ⇒ 时刻无法归属），
       渲染层据此显示"无数据"占位，而不是把"算不出来"当成"产量为零"（0 / 0.0%）。 */
    stats: { noData: true },
    alarm: { active: null, queue: [], ledger: [] },
    warnings: [],
    maint: { last: CFG.maintLast, next: '', cycle: CFG.maintCycleDays, warnDays: CFG.maintWarnDays,
             daysLeft: 0, todayRun: 0, monthRun: 0, yearRun: 0, records: MAINT_RECORDS },
    notices: { notices: NOTICES, tips: TIPS, todo: [] },
    selfCheck: [],
    opLog: [],                       // 操作日志（FR-8.7 / NFR-15）
    /* 曲线：curve 为"上一次已完成任务"的完整曲线；curveTick 为当前任务的采样缓冲 */
    curve: { depth: null, speed: null },
    curveTick: { unitIndex: -1, depth: [], speed: [] },
    unlocked: false,
    lastRefresh: '--:--:--'
  };

  /* ---------------- 统计计算（由班次已进行时长推导，保证自洽） ---------------- */
  function computeStats(elapsed, total) {
    const C = CFG.cycleSec, P = CFG.planQty;
    const done = Math.min(P, Math.floor(elapsed / C));
    const testing = done < P ? 1 : 0;
    const qualified = Math.round(done * CFG.firstPassRate);
    const unqualified = done - qualified;
    const recheck = Math.round(unqualified * 0.6);
    const dispatched = Math.min(P, done + testing + recheck + CFG.queueDepth);
    const pending = Math.max(0, dispatched - done - testing - recheck);
    const started = Math.min(P, done + testing + recheck);   // 开工数封顶于计划数，避免"未开工"为负（FR-4.3）
    const runSec = elapsed * CFG.runRate;
    const idleSec = elapsed - runSec;
    const avgTest = done > 0 ? runSec / done : 0;
    return {
      plan: P, started, notStarted: P - started,
      done, testing, pending,
      qualified, unqualified, recheck,
      firstPass: done > 0 ? (qualified / done) * 100 : 0,
      runSec, idleSec, avgTest,
      capacity: (done / P) * 100,
      oee: elapsed > 0 ? (runSec / elapsed) * 100 : 0,
      shiftElapsed: elapsed, shiftTotal: total,
      /* 显式状态位（E38）：本帧统计值**成立** —— 与 `noDataStats()` 的键集逐键相同，
         渲染层只认这一位，不需要（也不得）靠"值是不是 0"去猜。 */
      noData: false
    };
  }

  /**
   * "统计无数据"快照（E38）—— **结构性占位**，不是一份手写的键集。
   *
   * 立案：`shiftOf()` 在 `tick()` 里**最先**执行且缺口时**显式抛错**（P3-5 口径，绝不静默兜底），
   * 于是本帧 `state.stats` 拿不到 `computeStats()` 的结果。改前由渲染循环（`src/main.js`）
   * **按既有字段名手写**一份全 0 兜底 —— 那份手写体既与 `computeStats()` 形成无人守的隐性契约
   * （改统计字段 → 只在缺口帧炸），又**已经漏掉了 `plan` 键**（实测 `#sPlan` 被写成 `undefined`），
   * 还把"无法计算"显示成"零产量"（`0.0%`），违背"不得伪造数据"。
   *
   * 现改为**由数据层给出显式状态**：键集**从 `computeStats()` 在运行期取**（`Object.keys`），
   * 数值一律置 0 且**恒带 `noData: true`** ⇒ ①键集不可能漂移（无需任何人"记得同步"）；
   * ②渲染层读 `noData` 显示"—"，不去解读 0；③真实 0 与"无数据"在状态上可区分。
   * @returns {object} 与正常帧**同键集**的统计快照，逐键标为无数据
   */
  function noDataStats() {
    const shape = computeStats(0, 0);
    const out = {};
    Object.keys(shape).forEach(k => { out[k] = 0; });
    /* ⚠ `noData` 必须**最后**赋值：上面的 `shape` 里也有这个键（`computeStats()` 的正常分支恒给
       `noData:false`），先置位会被循环里的 0 覆盖成 `0`（实测踩过：`s.noData === true` 恒假 ⇒
       缺口帧照旧显示 0.0%）。 */
    out.noData = true;
    return out;
  }

  /* ---------------- 累计运行时长 ----------------
     口径：当日 / 本月 / 年度 = "自该周期起点到此刻的时长 × 有效运行占比"。
     这样跨零点、跨月、跨年自然归零（FR-6.4～6.6），且累计值随时间单调不减，
     不会出现"交班后本月累计变小"（审查报告 P2-2）。 */
  function accumulateRun(now, runRate) {
    const secSince = start => Math.max(0, (now - start) / 1000) * runRate;
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    return {
      today: secSince(dayStart),
      month: secSince(monthStart),
      year: secSince(yearStart)
    };
  }

  /* ---------------- 自检项（含 MES 链路，C-29） ----------------
     队列长度与回执风格取自适配层实时状态，不再写死（审查报告 P2-4）。 */
  function buildSelfCheck() {
    const online = state.device.link === 'online';
    const mes = state.device.mes === 'online';
    const api = (window.Api && typeof window.Api.getStatus === 'function') ? window.Api.getStatus() : null;
    const pendingCount = api ? api.pendingCount : 0;
    const style = api ? api.responseStyle : 'status';
    const receiptText = style === 'code' ? 'code=200' : 'status=1';
    return [
      { name: '看板主机网络', state: '正常', lv: 'ok' },
      { name: 'PC 上位机连接', state: online ? '在线正常' : '离线断连', lv: online ? 'ok' : 'err' },
      { name: 'MES 接口连通性', state: mes ? `正常（最近回执 ${receiptText}）` : '异常', lv: mes ? 'ok' : 'err' },
      { name: 'MES 上报队列', state: `待补传 ${pendingCount} 条`, lv: pendingCount > 0 ? 'warn' : 'ok' },
      { name: '本地数据库', state: '正常（SQLite 12.4 MB）', lv: 'ok' },
      { name: '磁盘空间', state: '剩余 78.2 GB / 512 GB', lv: 'ok' },
      { name: 'NTP 时间同步', state: '已同步（偏差 32 ms）', lv: 'ok' }
    ];
  }

  /* ---------------- 测试标准（FR-3.18 / FR-3.19）与三态判据 ----------------
     判定对象＝**深度与速度的测试标准上下限**（FR-3.14 改写，C-75）；相机参数（帧率/增益/快门/
     相机水下深度）属**上位机侧设备参数**，本看板**既不做判定、也不做状态判定**（C-84④），
     故下方判据里**不出现任何相机参数**。
     标准来源（FR-3.18）：运行时真源 state.task.standard（FR-3.19 现场录入）优先，
     未建立时回退 config/board.config.js 的 standards.default（仅演示）；
     必要项＝典型值＋上偏差＋下偏差，缺一即"标准未设定"（不判定、也不产生预警）。 */
  const BCstd = BC.standards || {};
  const STD_DIGITS = typeof BCstd.digits === 'number' ? BCstd.digits : 2;
  const PARAM_CN = { depth: '深度', speed: '速度' };

  /** 测试标准配置段（每次调用现读：整套配置被替换后仍取到当前值，不做加载期快照） */
  function stdCfg() {
    const live = window.BoardConfig && window.BoardConfig.standards;
    return live || BCstd || {};
  }

  /** 临近带比例（FR-3.18 / C-84①，单一真源＝config standards.nearRatio） */
  function nearRatio() {
    const r = stdCfg().nearRatio;
    return typeof r === 'number' ? r : 0.15;
  }

  /** 取某参数（depth / speed）当前生效的标准规格；口径与 components/TaskPanel.js 的 ensureRow() 一致 */
  function standardSpecOf(kind) {
    const task = state.task || {};
    const live = (task.standard && task.standard[kind]) || null;
    if (live) return live;
    const dft = stdCfg().default || {};
    return dft[kind] || null;
  }

  const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);

  /**
   * 测试标准三态（FR-3.14 / FR-3.18）—— **唯一一份**判据实现。
   *   - 超范围 err（红）：实测值落在闭区间 [下限, 上限] 之外（压线即合格）；
   *   - 临近   warn（黄）：距上/下限边界的距离 ≤ (上限 − 下限) × `standards.nearRatio`（含等号、至少一格）；
   *   - 其余   ok（正常）；必要项缺失（典型值/上偏差/下偏差任一不是有限数）⇒ idle（标准未设定，不判定）。
   * `components/TaskPanel.js` 的 `levelOf()` **直接转发本函数** —— 界面三态（FR-3.18）与预警（FR-5.8）
   * 共用同一份公式与同一份配置，**不存在第二份口径**。
   * 细分对应（负责人 2026-09-22）：本函数返回的 `warn` ⇒「参数阈值临近预警」、`err` ⇒「参数超范围预警」，
   * 两个名称在 `buildParamWarnings()` 里按态择名；本函数本身**只出三态、不出名称**（名称不重复两份）。
   * 三态比较全部换算到**显示精度网格**（两位小数 ⇒ 0.01）上的整数再比较：实测值、上下限、
   * 临近带宽都化作"格数"，比较即 `距离格数 ≤ 带宽格数`，没有二进制浮点误差 ——
   * 否则 `5.2 − 0.06` 在浮点里是 5.140000000000001，恰好等于带宽的值会漏判一格。
   * @param {number} real 实测值（深度或速度）
   * @param {object|null} spec 标准规格（typical / upperDev / lowerDev / digits）
   * @returns {{lv:string, text:string}} lv ∈ idle / ok / warn / err
   */
  function standardLevel(real, spec) {
    if (!isFiniteNum(real) || !spec ||
        !isFiniteNum(spec.typical) || !isFiniteNum(spec.upperDev) || !isFiniteNum(spec.lowerDev)) {
      return { lv: 'idle', text: '标准未设定' };
    }
    const GRID = Math.pow(10, -(typeof spec.digits === 'number' ? spec.digits : STD_DIGITS));
    const upper = round2(spec.typical + spec.upperDev);
    const lower = round2(spec.typical + spec.lowerDev);
    const tol = (upper - lower) * nearRatio();
    const unit = 1 / GRID;
    /* 带宽格数 k = max(1, ceil(tol × 每单位格数))：含等号（距离 ≤ 带宽即临近），且至少一格，
       不会退化成空区间（`- 1e-9` 是浮点容差修正：`0.4 × 0.15 = 0.06000000000000005`）。 */
    const k = Math.max(1, Math.ceil(tol * unit - 1e-9));
    const vU = Math.round(round2(real) * unit);
    const upU = Math.round(upper * unit);
    const loU = Math.round(lower * unit);
    /* 三态区间（上下对称）：
         超范围 err（红）：v < 下限 或 v > 上限 —— 判定区间是闭区间 [下限, 上限]，压线即合格；
         临近   warn（黄）：[上限−tol, 上限) 或 (下限, 下限+tol] —— 含等号，但不含上/下限本身；
         其余 ok（正常）。 */
    if (vU > upU || vU < loU) return { lv: 'err', text: '超范围' };
    if ((upU - vU <= k && vU < upU) || (vU - loU <= k && vU > loU)) {
      return { lv: 'warn', text: '临近' };
    }
    return { lv: 'ok', text: '正常' };
  }

  /**
   * 参数类预警（FR-5.8，P0）——**两个细分名称**（负责人 2026-09-22 裁定"预警名称需要细分"）：
   *   · 临近（`lv='warn'`）  ⇒ 名称「**参数阈值临近预警**」；
   *   · 超范围（`lv='err'`）⇒ 名称「**参数超范围预警**」。
   * 判定对象＝**深度与速度的测试标准上下限**（FR-3.14 / FR-3.18），判据仍复用**唯一一份**
   * `standardLevel()`（与界面三态同一份实现）。**深度与速度分别成条**：每个参数按自身最坏态择名
   * （该参数临近 ⇒ 出临近条；该参数超范围 ⇒ 出超范围条），一条预警里**只含一个参数**。
   * **标准未设定（必要项缺失）⇒ 该参数两条预警都不产生**（无从判定则不报警）；
   * 相机参数（fps/gain/shutter/cameraDepth）不参与任何判定（C-84④）。
   * 条数口径：**一个参数最多一条** ⇒ 本函数返回 0～2 条；调用方 `buildWarnings()` 已按条展开，
   * 不存在"两个参数挤成一条"的旧设计。
   * @returns {Array<{title:string, detail:string, lv:string}>} 空数组 = 无参数类预警
   */
  function buildParamWarnings() {
    const real = (state.task && state.task.real) || {};
    const rows = ['depth', 'speed'].map(kind => {
      const spec = standardSpecOf(kind);
      return { kind, spec, lv: standardLevel(real[kind], spec) };
    }).filter(r => r.lv.lv !== 'idle');        // 标准未设定 ⇒ 该参数不进任何一条
    /* **逐参数成条：同态也各出一条**（R26-P2-2 修）。旧实现按态 `groups.find(x => x.lv === r.lv.lv)`
       把**同态的两参数合并进一条**（detail 以「；」拼接），与文档三处声明矛盾 —— 本文件头部 `:16-18`
       「互不合并 ⇒ 参数类最多 2 条」、上面 docblock「深度与速度分别成条，一条预警里只含一个参数」、
       `config/board.config.js:167-169`「一个参数＝一条预警，深度与速度各自独立成条」。现改为**条数由
       「参数的个数」决定**（最多 2 条），名称仍由该参数自身的态择名 ⇒ 同态时出两条同名同类、
       各自只含一个参数的预警。排序只为稳定展示顺序（err 在前、warn 在后；同态则维持 深度→速度）。 */
    const order = { err: 0, warn: 1, ok: 2 };
    const sorted = rows.filter(r => r.lv.lv !== 'ok')     // 正常态不单独成条（并入下方 ok 汇总提示）
      .sort((a, b) => order[a.lv.lv] - order[b.lv.lv]);
    const detailOf = r => {
      const d = typeof r.spec.digits === 'number' ? r.spec.digits : STD_DIGITS;
      const unit = r.spec.unit ? ' ' + r.spec.unit : '';
      const upper = round2(r.spec.typical + r.spec.upperDev);
      const lower = round2(r.spec.typical + r.spec.lowerDev);
      return PARAM_CN[r.kind] + ' ' + round2(real[r.kind]).toFixed(d) + unit +
        '（标准 ' + lower.toFixed(d) + '～' + upper.toFixed(d) + unit + '）判' + r.lv.text;
    };
    const out = sorted.map(r => ({
      title: r.lv.lv === 'err' ? '参数超范围预警' : '参数阈值临近预警',
      detail: detailOf(r) +
        (r.lv.lv === 'warn'
          ? '（临近判据：实测距上/下限边界 ≤ (上限−下限)×' + nearRatio() + '）'
          : '（超出标准上下限闭区间，压线即合格）'),
      lv: r.lv.lv
    }));
    /* 两参数都判正常时不需要预警；但为保持"参数类恒有回执"的旧展示形态（浅色 ok 条），
       仍给出唯一一条「参数阈值临近预警」ok 条：它不是预警（不计入 warnCount），文案明示均正常。 */
    if (!out.length && rows.length) {
      out.push({
        title: '参数阈值临近预警',
        detail: rows.map(detailOf).join('；') + '，均处于允许范围',
        lv: 'ok'
      });
    }
    return out;
  }

  /* ---------------- 预警计算 ---------------- */
  function buildWarnings() {
    const m = state.maint;
    const out = [];
    /* 1) 参数类预警（FR-5.8 细分后为两条名称）：判定对象＝深度与速度的测试标准上下限
          （FR-3.14 / FR-3.18）；**不再用相机参数（帧率/增益/快门/相机水下深度）做判定或状态** ——
          相机参数属上位机侧设备参数，本看板既不做判定也不做状态判定（C-84④）。
          标准未设定（必要项缺失）时该参数不出预警。条数口径：一个参数最多一条（深度/速度各按最坏态择名）。 */
    buildParamWarnings().forEach(w => out.push(w));
    /* 2) 维保到期（阈值取配置 maintenance.warnDays，不在代码里写死） */
    out.push(m.daysLeft <= CFG.maintWarnDays
      ? { title: '设备维保到期预警', detail: `距计划维保还有 ${m.daysLeft} 天（${m.next}）`, lv: 'warn' }
      : { title: '设备维保到期预警', detail: `距计划维保还有 ${m.daysLeft} 天`, lv: 'ok' });
    /* 3) 耗材更换（阈值取配置 maintenance.consumables[0].threshold） */
    const lamp = CFG.lampBaseline + Math.floor(state.stats.done || 0);
    out.push(lamp > CFG.lampThreshold
      ? { title: '耗材更换预警', detail: `水下光源累计点亮 ${lamp} h，建议更换（阈值 ${CFG.lampThreshold} h）`, lv: 'warn' }
      : { title: '耗材更换预警', detail: `光源累计点亮 ${lamp} h，未达更换阈值（${CFG.lampThreshold} h）`, lv: 'ok' });
    /* 4) 工单超时 */
    const overdue = state.stats.pending > 80;
    out.push(overdue
      ? { title: '工单超时预警', detail: `设备侧待测队列 ${state.stats.pending} 件，预计超班次完成`, lv: 'err' }
      : { title: '工单超时预警', detail: '当班工单按节拍推进，无超时风险', lv: 'ok' });
    return out;
  }

  /* ---------------- 异常台账 ---------------- */
  function buildLedger(now) {
    return [
      { time: shiftTime(now, 12, 40), code: 'E-3115', desc: '深度测量异常',   state: '已闭环' },
      { time: shiftTime(now, 38, 15), code: 'W-2210', desc: '快门参数超限',   state: '已闭环' },
      { time: shiftTime(now, 74, 2),  code: 'E-1042', desc: '水池液位偏低',   state: '复检确认中' },
      { time: shiftTime(now, 96, 31), code: 'E-2071', desc: '相机通信中断',   state: '已闭环' },
      { time: shiftTime(now, 118, 55), code: 'E-4520', desc: '上位机数据传输异常', state: '已闭环' }
    ];
  }
  function shiftTime(now, minsAgo, secAgo) {
    const d = new Date(now.getTime() - (minsAgo * 60 + secAgo) * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /* ---------------- 主循环 ---------------- */
  let activeAlarmIndex = 0;
  let alarmStartedAt = null;

  /* 并发报警队列（FR-5.6）：多条报警按"发生时间倒序"排队展示，新报警不覆盖旧报警。
     - 队列中的每条都会继续保留，直到闭环（演示口径：发生 2 分钟后自动闭环，也可在界面手工闭环）
     - state.alarm.active 恒为队首（当前展示的那条），其余在"并发报警队列"中列出
     - 闭环的报警转入"当班异常台账"，因此队列为空时故障卡显示"当班无故障报警" */
  const ALARM_QUEUE_MAX = 12;
  const ALARM_LEDGER_MAX = 8;       // 当班异常台账保留条数（演示）
  const ALARM_CLOSE_SEC = 120;      // 单条报警自动闭环时长（演示）；须小于 150 s 的轮换间隔，否则"无故障"空态永不可达
  const ALARM_HANDLE_SEC = 60;      // 转为"处理中"的时长（演示）
  let alarmSeq = 0;

  /** 把一条报警写入当班异常台账（最新在前，最多 ALARM_LEDGER_MAX 条） */
  function pushLedger(alarm) {
    state.alarm.ledger.unshift({
      time: alarm.time, code: alarm.code, desc: alarm.type || alarm.desc, state: '已闭环'
    });
    state.alarm.ledger = state.alarm.ledger.slice(0, ALARM_LEDGER_MAX);
  }

  function raiseAlarm(now, def) {
    state.alarm.queue.unshift({
      code: def.code, type: def.type, desc: def.desc, level: def.level || '一般', action: def.action || '',
      time: new Date(now).toTimeString().slice(0, 8),
      bornAt: now.getTime(), seq: ++alarmSeq, state: '未处理'
    });
    state.alarm.queue = state.alarm.queue.slice(0, ALARM_QUEUE_MAX);
    syncAlarmQueue();
  }

  /* 推进队列中各条报警的闭环状态；自动闭环的条目转入当班台账（不覆盖、不丢失） */
  function ageAlarmQueue(now) {
    let closed = 0;
    state.alarm.queue.forEach(q => {
      const age = (now.getTime() - q.bornAt) / 1000;
      q.state = age >= ALARM_CLOSE_SEC ? '已闭环' : (age >= ALARM_HANDLE_SEC ? '处理中' : '未处理');
    });
    state.alarm.queue = state.alarm.queue.filter(q => {
      if (q.state !== '已闭环') return true;
      pushLedger(q);
      closed++;
      return false;
    });
    syncAlarmQueue();
    return closed;
  }

  /** 手工闭环当前展示的报警（界面按钮）：从队列移除并写入台账 */
  function closeActiveAlarm() {
    const a = state.alarm.queue.shift();
    if (!a) return null;
    a.state = '已闭环';
    pushLedger(a);
    syncAlarmQueue();
    return a;
  }

  function syncAlarmQueue() {
    state.alarm.active = state.alarm.queue[0] || null;
  }

  function tick(now) {
    now = now || new Date();

    /* 时钟 */
    const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
    state.clock = {
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      week,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    };
    state.lastRefresh = state.clock.time;

    /* 班次列表（时间无关）**先写**：`shiftOf()` 缺口时会显式抛错，抛点之后的写入一律不执行，
       故与时刻无关的产物必须提前到它之前 —— 这样缺口帧的 `state.shift` 自身是完整的
       （E36：渲染层不必再"手写补键"），缺的只是"哪一班、进行到哪"这类**时刻派生**字段。 */
    state.shift.list = SHIFTS;              // 供班次页按配置渲染（P3-1）

    /* 班次（时刻派生）：缺口时 `shiftOf()` 显式抛错 ⇒ 本块不执行，`state.shift` 保留上一帧 */
    const sh = shiftOf(now);
    const elapsed = clamp((now - sh.start) / 1000, 0, sh.total);
    state.shift = {
      list: SHIFTS,                       // 供班次页按配置渲染（P3-1），每次 tick 一并带上
      name: sh.def.name,
      range: `${pad(sh.def.start)}:00 - ${pad(sh.def.end === 24 ? 0 : sh.def.end)}:00`,
      start: `${pad(sh.def.start)}:00`,
      end: `${pad(sh.def.end === 24 ? 0 : sh.def.end)}:00`,
      team: CFG.team, operator: CFG.operator, operatorId: CFG.operatorId,
      leader: CFG.leader, leaderId: CFG.leaderId,
      elapsed, total: sh.total, pct: (elapsed / sh.total) * 100,
      /* 显式状态位（E38）：班次**时刻派生量**（pct/elapsed/剩余）本帧成立 */
      noData: false
    };

    /* 统计 */
    state.stats = computeStats(elapsed, sh.total);

    /* ---- 实测数据（模拟上位机整合后的单一结果值，看板不做二次聚合） ---- */
    const t = state.task;
    /* 演示分布（负责人 2026-09-22 批准调**演示数据**，使三态在几十秒的演示窗口内可见）：
       深度标准带 [4.80, 5.30]（需求 C-86 冻结，未改）＋ 临近带宽 0.075（=0.15×跨度，按显示精度取整
       8 格）⇒ **只调演示游走**：区间 [4.77, 5.33]、步长 ±0.06/s。实测 10 万 tick：
       正常 58.7% / 临近 26.8% / 超范围 14.5%；新启动 60 s 内三态全现 ≈64%（首达临近 ≈20 s、超范围 ≈30 s）。
       改前（[4.60,5.45]、±0.03/s）超范围 34.3%、滚动 60 s 三态全现仅 38% ⇒"超范围红"近半时间常亮。
       速度同口径：vx 游走 [4.78, 5.22]、步长 ±0.06/s（标准带 [4.80, 5.20]）⇒
       正常 59.8% / 临近 25.5% / 超范围 14.7%，新启动 60 s 内三态全现 ≈80%。
       两参数的演示值恒在量程内（深度 [4,6] m、速度 [3,8] m/s），不会触发录入侧"超量程"拒绝。 */
    t.real.depth = clamp(round2(t.real.depth + (Math.random() - 0.5) * 0.12), 4.77, 5.33);
    t.real.vx = clamp(round2(t.real.vx + (Math.random() - 0.5) * 0.12), 4.78, 5.22);
    t.real.vy = clamp(round2(t.real.vy + (Math.random() - 0.5) * 0.04), -0.25, 0.35);
    t.real.speed = round2(Math.sqrt(t.real.vx * t.real.vx + t.real.vy * t.real.vy));   // X-Y 平面合成速度

    /* ---- 设备参数（相机侧，次要展示；实际帧率量程 0～1200 fps） ---- */
    t.fpsRaw = clamp(t.fpsRaw + (Math.random() - 0.5) * 1.6, 396, 404);
    t.real.fps = Math.round(t.fpsRaw);
    t.gainRaw = clamp(t.gainRaw + (Math.random() - 0.5) * 0.06, 2.35, 2.65);
    t.real.gain = round1(t.gainRaw);
    t.shutterRaw = clamp(t.shutterRaw + (Math.random() - 0.5) * 6, 488, 512);
    t.real.shutter = Math.round(t.shutterRaw);
    t.real.cameraDepth = clamp(round2(t.real.cameraDepth + (Math.random() - 0.5) * 0.04), 11.80, 12.20);

    /* ---- 当前工单进度、运行阶段与单任务结果 ----
       运行阶段按需求 FR-2.5（C-44）简化为 4 阶段：准备 → 运行 → 判定 → 完成
       切换阈值与单任务节拍 CFG.cycleSec 对齐：准备 5% / 运行 85% / 判定 95% / 完成收尾 5% */
    const unitSec = elapsed % CFG.cycleSec;
    t.progress = unitSec / CFG.cycleSec;
    t.unitIndex = Math.floor(elapsed / CFG.cycleSec) + 1;
    /* 判定收尾窗口取节拍末 5%（≥8 s），保证"完成"阶段的判定结果在 1 s 刷新下可见 */
    if (unitSec < 8)            { t.result = '待测试'; state.status.stage = '准备'; }
    else if (t.progress < 0.85) { t.result = '测试中'; state.status.stage = '运行'; }
    else if (t.progress < 0.95) { t.result = '测试中'; state.status.stage = '判定'; }
    else                        { t.result = verdictOf(t.unitIndex); state.status.stage = '完成'; }
    t.lastResult = verdictOf(Math.max(1, t.unitIndex - 1));

    /* ---- 运行模式 ---- */
    state.status.mode = unitSec < 3 ? '待机' : '测试运行';
    if (state.device.link !== 'online') {
      state.status.mode = '故障锁定'; state.status.online = '离线断连';
    } else {
      state.status.online = '在线正常';
    }

    /* ---- 任务曲线：任务进行中按 1 s 采样；任务完成时固化为完整曲线（不做秒级刷新） ---- */
    if (state.curveTick.unitIndex !== t.unitIndex) {
      if (state.curveTick.depth.length > 1) {
        state.curve.depth = makeCurve(state.curveTick.depth, state.curveTick.unitIndex);
        state.curve.speed = makeCurve(state.curveTick.speed, state.curveTick.unitIndex);
      } else if (state.curve.depth && state.curve.depth.unitIndex === 0) {
        /* 首次 tick：把演示预置曲线对齐为"上一件" */
        const prev = Math.max(1, t.unitIndex - 1);
        state.curve.depth.unitIndex = prev;
        state.curve.speed.unitIndex = prev;
      }
      state.curveTick = { unitIndex: t.unitIndex, depth: [], speed: [] };
    }
    state.curveTick.depth.push(t.real.depth);
    state.curveTick.speed.push(t.real.speed);

    /* ---- 维保 ---- */
    const lastD = new Date(CFG.maintLast + 'T00:00:00');
    const nextD = new Date(lastD.getTime() + CFG.maintCycleDays * 86400000);
    state.maint.next = `${nextD.getFullYear()}-${pad(nextD.getMonth() + 1)}-${pad(nextD.getDate())}`;
    state.maint.daysLeft = Math.max(0, Math.ceil((nextD - now) / 86400000));
    const acc = accumulateRun(now, CFG.runRate);
    state.maint.todayRun = acc.today;
    state.maint.monthRun = acc.month;
    state.maint.yearRun = acc.year;

    /* ---- 异常与预警（FR-5：实时报警 + 并发排队 + 当班台账） ---- */
    if (state.alarm.ledger.length === 0) state.alarm.ledger = buildLedger(now);   // 台账首次填充演示记录
    if (alarmStartedAt === null) {
      alarmStartedAt = now.getTime();
      raiseAlarm(now, ALARM_POOL[activeAlarmIndex]);
    }
    const alarmAge = (now.getTime() - alarmStartedAt) / 1000;
    if (alarmAge > 150) {
      activeAlarmIndex = (activeAlarmIndex + 1) % ALARM_POOL.length;
      alarmStartedAt = now.getTime();
      raiseAlarm(now, ALARM_POOL[activeAlarmIndex]);
      ageAlarmQueue(now);        // 新报警入队时统一老化一次，闭环条目转入台账
    }
    ageAlarmQueue(now);
    state.warnings = buildWarnings();

    /* ---- 待办 ---- */
    const lampHours = CFG.lampBaseline + state.stats.done;
    const warnCount = state.warnings.filter(w => w.lv === 'warn' || w.lv === 'err').length;
    state.notices.todo = [
      { name: '待复检任务', value: state.stats.recheck, unit: '件', lv: 'warn' },
      { name: '待维保作业', value: state.maint.daysLeft <= CFG.maintWarnDays ? 1 : 0, unit: '项', lv: 'warn' },
      { name: '未闭环异常', value: state.alarm.ledger.filter(r => r.state !== '已闭环').length, unit: '条', lv: 'err' },
      { name: '设备侧待测队列', value: state.stats.pending, unit: '件', lv: 'info' },
      { name: '耗材临近更换', value: lampHours > CFG.lampThreshold ? 1 : 0, unit: '项', lv: 'warn' },
      { name: '参数/工单预警', value: warnCount, unit: '项', lv: 'info' }
    ];

    state.selfCheck = buildSelfCheck();
    return state;
  }

  /* 演示用：切换上位机断连状态（UI-10 降级展示） */
  function toggleLink() {
    state.device.link = state.device.link === 'online' ? 'offline' : 'online';
    return state.device.link;
  }

  /* 演示用：立即触发一次新报警（FR-5.1）；新报警进入队首，旧报警保留在队列中 */
  function injectAlarm(now) {
    activeAlarmIndex = (activeAlarmIndex + 1) % ALARM_POOL.length;
    alarmStartedAt = (now ? now.getTime() : Date.now());
    raiseAlarm(new Date(alarmStartedAt), ALARM_POOL[activeAlarmIndex]);
    return ALARM_POOL[activeAlarmIndex];
  }
  /** 追加一条操作日志（FR-8.7 / NFR-15：解锁后的写操作全程留痕）
      内存中保留最近 20 条（正式实现按 DR-18 落库）；展示时按时间倒序取用 */
  function pushLog(action, detail, operator) {
    state.opLog.push({
      time: state.clock.time || '--:--:--',
      date: state.clock.date || '',
      action,
      detail: detail || '',
      operator: operator || CFG.operator
    });
    if (state.opLog.length > 20) state.opLog.shift();
    return state.opLog[state.opLog.length - 1];
  }

  function setUnlocked(v) { state.unlocked = v; return state.unlocked; }

  /* 演示用：清空曲线，查看"初始空态"（?curve=none） */
  function clearCurve() {
    state.curve.depth = null;
    state.curve.speed = null;
  }

  /* 启动时预置"上一次已完成任务"的完整曲线（演示用）；
     真实系统中该曲线由上一任务完成后写入本地库，页面加载时读取 */
  (function seedCurve() {
    const c = synthCurve(0);
    state.curve.depth = c.depth;
    state.curve.speed = c.speed;
    state.curveTick.unitIndex = -1;   // 由首次 tick 按当前任务初始化
  })();

  return { state, tick, toggleLink, injectAlarm, setUnlocked, pushLog, closeActiveAlarm, clearCurve, CFG, DEVICE_NOMINAL,
           /* 供渲染层在"统计不成立"的帧上取**同键集**的无数据快照（E38 / E36）：
              键集由 `computeStats()` 运行期给出，调用方不得（也不需要）手写键集 */
           noDataStats,
           /* 供界面与自检复用：三态判据与标准取值的**唯一实现**（TaskPanel.levelOf 直接转发本函数） */
           standardLevel, standardSpecOf };
})();
