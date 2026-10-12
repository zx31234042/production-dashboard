/* ==========================================================================
   模拟数据源（services/mockData.js）— 按需求清单 V1.45 口径编写
             （V1.44 / C-114 两处口径登记〔①`equipCode` 的「给定方＝MES 方」在需求侧写准 —— `FR-1.2` 的「数据来源」列与 `IF-D.12` 同口径对齐（书面依据＝附录 2 的「数据来源」列＝MES 工单 与 `IF-A.4`），**取值路径与优先级一字未改**；②当班统计的「已完成」以 `result` 表为准 —— **单一真源、与 `FR-5.11` 的「已完成件数」同源**，见 `FR-4.4` 的真源声明〕；**不改任何算式、不增删条款**，仍 259 / P0 188 / AC 12 / Q 7；本文件数据与口径未变；V1.43 / C-113 「13 张表」明确为业务表口径〔`schema.sql` 实建 15 张 ＝ 13 业务表 ＋ `schema_meta` ＋ `auth_credential`；`db-check` 的 `REQUIRED_TABLES` ＝ 14〕，不增删条款，仍 259 / P0 188 / AC 12 / Q 7；V1.42 / C-112 三处口径补写〔DR-05 件序号与终态、FR-4.9 复检数〕；V1.41 / C-111 计量单位定义＋DR-04 件序号补登；V1.40 / C-109＋C-110 口径补写〔FR-5.11 起算点＋DR-05 写入口径〕；V1.39 / C-108 工单超时预警判据改「进度落后率超阈值率」且阈值率可配：工单预警按「应完成 / 已完成」重写，**演示旋钮 production.outputRatio 已移出配置真源**（2026-09-30 负责人裁定 B）；V1.38 / C-99～C-107 口径收口与接口修正；承 V1.37 / C-98「只统一 `testStatus` 码语义与运行阶段映射（改在 config/fieldMap.js
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
     **"给了对象但该指标缺项"一律判"标准未设定"（不回退演示值）** —— 与 `server/services/judge.js`
     的 `specOf()` 逐条同口径（`E45` 余项①，负责人裁定以服务端为单一真源），见下方 `standardSpecOf()`
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
  /* 预警阈值段（FR-5.11 判据变更后新增读取；与 judge.js 同源，不各自硬编码） */
  const BCwarn = BC.warnings || {};

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
    /* 演示场景旋钮（**非判据参数**）：实际产出达成率。1＝按计划节拍推进；<1 表示实际产出慢于计划 ⇒
       演示现场真的落后（FR-5.11 的 err 分支由此可复现）。正式实现取 MES 派工进度与 result 表，
       与本旋钮无关。
       ⚠ 该键**不在配置真源 `src/config/board.config.js`** 里（2026-09-30 已从该文件删除，见其
         `production` 段注释；本行读到的 `BCprod.outputRatio` 因此恒为 `undefined`）。由此四条口径：
         ① 本文件**默认 1（中性）**：缺键时按"按计划节拍推进"取，不改变任何演示数值；
         ② **仅供测试在内存沙箱里覆盖**（`tests/logic-check.js` 的 `loadFrontEnd({outputRatio})` 用法：
            在加载本文件**之前**改内存里的 `window.BoardConfig.production.outputRatio`，只改内存、不落盘）；
         ③ **生产不读**它 —— 它是演示/测试注入位，不是业务配置项，改它不影响任何判据口径；
         ④ 若要把它恢复成**正式配置项**，须先走需求侧（`NFR-19`：配置项口径进需求/配置清单）与架构
            文档登记，**不得**只在本文件与 `board.config.js` 之间私自加回来（那会让"配置真源"分叉两份）。 */
    outputRatio: (BCprod.outputRatio === undefined ? 1 : BCprod.outputRatio),
    maintLast: BCmaint.lastDate || '2026-08-28', // 上次维保日期（Q-13）
    maintCycleDays: BCmaint.cycleDays || 30,     // 固定维保周期（Q-13）
    maintWarnDays: BCmaint.warnDays || 14,       // 维保到期预警提前天数（Q-13，APP 6）
    lampBaseline: 780,                           // 水下光源"上次更换后"累计点亮时长（h，演示基准）
    lampThreshold: BClamp.threshold || 800,      // 水下光源更换阈值（h，Q-13 耗材清单第 1 项）
    /* 工单超时判据阈值（FR-5.11，2026-09-30 判据变更）—— **一律读配置真源、本处不写死**：
       ratio ＝ 进度落后率阈值；pending ＝ 落后件数阈值（两者取或）。 */
    orderOverdueRatio: BCwarn.orderOverdueRatio,
    orderOverduePending: BCwarn.orderOverduePending,
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

  /* `E203`（2026-10-07 收紧）：**"本件被完整观察到"的下界** —— 节拍边界处缓冲至少要有这么多采样点才允许固化。
     比例取值依据：① 采样 1 s/点、节拍 `CFG.cycleSec`（160 s）⇒ 完整观察一件恰好得 `CURVE_SAMPLES`（160）个点；
     ② 浏览器 `setInterval(1000)` 的真实周期略大于 1 s（定时器/重绘抖动，实测常见 1.00～1.01 s）⇒ 一件内可能少 1～5 帧，
     故不能要求"恰好 160 点"；③ 取 **90%**（160 s ⇒ 144 点／≥144 s）：它挡掉"刚打开页面的 2～3 帧"（占比 1.25%～1.9%）
     与"从节拍中点起看"（≤50%）这类**残缓冲**，同时给定时器抖动留 ~16 帧余量。
     ⚠ 口径是"**近似完整**观察"，不是逐字"首帧观察到"（比例值由座位 3 定；`E203` 行授权的正是"合理比例"）。 */
  const CURVE_FREEZE_MIN_SAMPLES = Math.ceil(CURVE_SAMPLES * 0.9);

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
    /* 实际产出 = 计划节拍产出 × 达成率（默认 1 ⇒ 按计划节拍推进，与旧演示数据逐值相同；
       <1 ⇒ 实际慢于计划，FR-5.11 的"已完成 < 应完成"由此成立） */
    const done = Math.min(P, Math.floor((elapsed / C) * CFG.outputRatio));
    const testing = done < P ? 1 : 0;
    const qualified = Math.round(done * CFG.firstPassRate);
    const unqualified = done - qualified;
    const recheck = Math.round(unqualified * 0.6);
    const dispatched = Math.min(P, done + testing + recheck + CFG.queueDepth);
    const pending = Math.max(0, dispatched - done - testing - recheck);
    const started = Math.min(P, done + testing + recheck);   // 开工数封顶于计划数，避免"未开工"为负（FR-4.3）
    const runSec = elapsed * CFG.runRate;
    const idleSec = elapsed - runSec;
    /* FR-4.13 单台平均测试时长：**与服务端 `server/services/stats.js` 的 `avgTestSec` 同一算式** ——
       Σ(已完成件的件级测试时长) ÷ 完成数（合格＋不合格），依据需求 FR-4.13
       「完成测试总时长 ÷ 完成数量」。
       ⚠ `E67`（负责人 2026-09-30 裁定③）与上一版的差别（如实登记）：上一版写 `runSec / done`，
         分子是**设备**口径的运行时长（`elapsed × runRate`）；而服务端自 `E65` 起用**件级**时长之和
         ⇒ 同一指标两份实现各自取数、门禁 M 段的"输入等价性"构造又把两侧绑成相等 ⇒ 分叉无人守。
       件级时长**由演示数据现算**（不另造一个与服务端矛盾的量）：
         · 演示里一件的测试时长 ＝ 单件节拍 `CFG.cycleSec`（`tick()` 的件序号与四阶段都按它推进）；
         · 演示旋钮 `outputRatio` < 1 表示"实际产出慢于计划"（见上面 `done` 的算式）⇒ 实际节拍被
           拉长为 `cycleSec / outputRatio`，与 `done = floor(elapsed / cycleSec × ratio)` 同一口径。
       集合与服务端 `DONE_STATUS` **同集合**：`待复检`／`测试中`／`待测试` **不计入分子**
       （它们仍进 `demoPieces`，只为让"这条过滤"本身是可读、可被定点变异证伪的一条真过滤）。 */
    const pieceSec = CFG.outputRatio > 0 ? CFG.cycleSec / CFG.outputRatio : CFG.cycleSec;
    const demoPieces = [];
    for (let i = 0; i < qualified; i++) demoPieces.push({ result: '合格', durationSec: pieceSec });
    for (let i = 0; i < unqualified; i++) demoPieces.push({ result: '不合格', durationSec: pieceSec });
    for (let i = 0; i < recheck; i++) demoPieces.push({ result: '待复检', durationSec: pieceSec });
    if (testing > 0) demoPieces.push({ result: '测试中', durationSec: 0 });
    const testSecSum = demoPieces.reduce((s, p) =>
      s + ((p.result === '合格' || p.result === '不合格') && Number.isFinite(p.durationSec)
        ? Math.max(0, p.durationSec) : 0), 0);
    const avgTest = done > 0 ? testSecSum / done : 0;
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
    /* ⚠ **逐键由 `0` 改 `null`**（W4 / ADR-0008 D3，2026-09-28 口径统一）：
       改前这里逐键写 0，于是"缺口帧"在**数据层**就已经把"算不出来"表达成了"零产量/零时长"——
       只有渲染层读 `noData` 那一位才不显示 0（`StatsPanel`/`ShiftPanel`/`TaskPanel`/`DeviceStatusPanel`
       四处各自读一次，任一处漏读就把 0 显示出去）。改成 `null` 后，**即使**某个渲染点忘了读状态位，
       它也只会显示"—"或不显示，而**不会**显示一个看起来合法的 `0`（"不得伪造数据"落到数据结构上）。
       为什么不用 `undefined`：`undefined` 在 `||`、模板串、JSON 里会退化成空串/0，语义不如 `null` 明确。
       `noData` 本身是**布尔状态位**，保持最后赋值（见下方 ⚠）。 */
    Object.keys(out).forEach(k => { if (k !== 'noData') out[k] = null; });
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
     必要项＝典型值＋上偏差＋下偏差，缺一即"标准未设定"（不判定、也不产生预警）。
     ⚠ **"传了对象但该指标缺项"不回退演示值**（`E45` 余项①）：该分支的口径真源＝服务端
     `server/services/judge.js` 的 `specOf()`，本文件只做**镜像**，见下方 `standardSpecOf()` 的长注释。 */
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

  /** 取某参数（depth / speed）当前生效的标准规格。
   *  **单一真源＝服务端判定引擎** `server/services/judge.js` 的 `specOf(standardLike, kind)`
   *  （`E45` 余项①：负责人裁定"以服务端 `specOf()` 为准"）—— 分支逐条对齐，前端**不留第二种判断**：
   *    ① **传了对象**（哪怕 `{}`、哪怕只带 `productCode`）⇒ 该对象就是本次的**标准真源**：
   *       只从里面取；该指标缺项（或不是对象）⇒ **`null` ＝"标准未设定"**，**绝不**回退演示值；
   *    ② **没给标准对象**（`undefined` / `null` / 非对象）⇒ 才轮到演示缺省段；而"**本模式下许不许回退**"
   *       这一判定**不在这里重写**：唯一真源＝`config/fieldMap.js` 的 `standardLimits()`
   *       （`F15-3`：`dataSource === 'server'` 一律不许回退演示默认，依据 `ADR-0008 D3`）。
   *  ⚠ 为什么是"逐条对齐"而不是"直接调用服务端那份代码"：浏览器侧不能 `require` `server/` 下的模块，
   *     而本包**不得新增受管文件** ⇒ 无法把 `specOf()` 抽成双端共享模块。故本函数是它的**镜像**，
   *     由 `tests\._verify\T-20261005-20\p-e45-specof-parity.js` 对同一输入矩阵逐字对账两侧输出。 */
  function standardSpecOf(kind) {
    const task = state.task || {};
    const std = task.standard;
    if (std && typeof std === 'object') {
      const live = std[kind];
      return (live && typeof live === 'object') ? live : null;
    }
    const FM = window.FieldMap;
    if (FM && typeof FM.standardLimits === 'function' && !FM.standardLimits(state)[kind]) {
      return null;
    }
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
    /* 4) 工单超时预警（FR-5.11，**判据 2026-09-30 由负责人裁定变更**）：由"待测队列件数 > 固定阈值"
          改为**进度落后率** —— 应完成 = 节拍 × 实际经过时长；落后率 = (应完成 − 已完成) / 应完成；
          告警 = 落后率 > CFG.orderOverdueRatio **或** 落后件数 > CFG.orderOverduePending。
         为什么改：旧口径的"队列 = 计划 − 已完成"在班初必然等于全部计划量 ⇒ 恒定越过任何固定阈值，
         正常与落后两种情形判定完全相同（零判别力，2026-09-30 实测）。新口径下"正常推进 ⇒ 落后≈0"。
         ⚠ 落后率**允许为负**（超前于计划）—— 负值绝不告警（不得取绝对值、不得当成异常）。
         ⚠ 阈值一律读配置（`orderOverdueRatio` / `orderOverduePending`），本处**不写死**。 */
    const cycleSec = CFG.cycleSec || 160;
    const elapsedSec = Math.max(0, Number(state.shift && state.shift.elapsed) || 0);
    const shouldDone = Math.floor(elapsedSec / cycleSec);
    const doneQty = Math.floor(state.stats.done || 0);
    const behindQty = shouldDone - doneQty;                        // 允许为负
    const behindRatio = shouldDone > 0 ? behindQty / shouldDone : 0;
    const overdue = behindRatio > CFG.orderOverdueRatio || behindQty > CFG.orderOverduePending;
    const overduePct = (behindRatio * 100).toFixed(1);
    out.push(overdue
      ? { title: '工单超时预警', detail: `按节拍应完成 ${shouldDone} 件、实际已完成 ${doneQty} 件，落后 ${behindQty} 件（${overduePct}%，阈值 ${(CFG.orderOverdueRatio * 100).toFixed(0)}%），预计超班次完成`, lv: 'err' }
      : { title: '工单超时预警', detail: `按节拍应完成 ${shouldDone} 件、实际已完成 ${doneQty} 件，落后 ${behindQty} 件（${overduePct}%），按节拍推进`, lv: 'ok' });
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

    /* ---- 任务曲线：任务进行中按 1 s 采样；任务完成时固化为完整曲线（不做秒级刷新） ----
       `E203`（★★，A 组）—— **"节拍边界固化"的判据 2026-10-07 收紧**（**裁定人＝项目负责人；裁定日期＝2026-10-07**；**依据＝**
       `项目记录\后续路线图.md` 的 `E203` 行）。
       · **为什么收紧（改前的病灶）**：改前本分支的判据只有"本轮缓冲长度 > 1" ⇒ 页面恰在节拍边界前 1～2 s 打开时，
         边界那一帧就把**这 2 个采样点**固化成一条曲线、并**覆盖**预置的完整曲线，屏上于是出现
         「第 N 件 · 2 采样点 · 2 s」这种**标着整件号却没有整件数据**的曲线（`T-20261007-07` 用例 B/D 实测：
         真机与 vm 均复现；**不带** `?curve=none` 时同样覆盖预置曲线）。它与 `E38`（"算不出来"不得显示成 0）**同族**：
         把"页面刚打开看到的两帧"当成了"整件任务的完整曲线"；对 `?curve=none` 则意味着空态窗口可短至 ~1 s
         （`E202`／`B2` 那条判据相位抖动的根因）。
       · **改后（本处即本包全部实现改动）**：**本件未被完整观察到就不固化** —— 两条同时成立才固化：
         ① `buf.unitIndex === t.unitIndex - 1`：缓冲所属的件就是**紧邻的上一件** ⇒ 缓冲里的点属于**同一件**，且这一道
            边界是**真实边界**（时钟跳变／标签页被节流跨过整件时，稀疏缓冲不再被当成 1 s 均匀曲线）；
         ② `buf.depth.length >= CURVE_FREEZE_MIN_SAMPLES`：缓冲达到 `board.config.js` 的 `curve.samples`（经
            `CURVE_SAMPLES` 读入）的**合理比例**（**90%**）—— 比例取值的依据写在 `CURVE_FREEZE_MIN_SAMPLES` 的注释里。
         两条不同时成立时**保留上一件曲线原样**：既不覆盖、也不写 0 或任何占位值（**不许**用 `DEFAULT`／假值把
         "没观察到"写成"观察到了" —— `E38` 既定口径）。
       · **未改什么**：`?curve=none` 仍是"**启动时清一次**"的语义（`src\main.js:116` 的调用点一字未动；变的只是
         "清掉之后多久会被重新固化"＝由"下一道边界"变为"观察到一整件之后"，即空态窗口 ≤2 个节拍 —— 该窗口口径的
         更新由主代理落在 `P3-13`）；生产侧固化路径（`server\repo\curve.js` 的 `saveCurve()`，由 DR-05／DR-19 驱动）
         **一字未动**；`FR-3.15` 的正式口径（"任务完成时固化为**该任务的完整曲线**"）**一字未动** —— 本处只是让
         演示侧不再在"没观察到整件"时冒充实测。 */
    if (state.curveTick.unitIndex !== t.unitIndex) {
      const buf = state.curveTick;                                         // 上一件（或首帧之前）的采样缓冲
      const isAdjacentPiece = buf.unitIndex === t.unitIndex - 1;           // ① 缓冲属于紧邻的上一件
      const observedEnough = buf.depth.length >= CURVE_FREEZE_MIN_SAMPLES; // ② 近似完整观察（≥90%）
      if (isAdjacentPiece && observedEnough) {
        state.curve.depth = makeCurve(buf.depth, buf.unitIndex);
        state.curve.speed = makeCurve(buf.speed, buf.unitIndex);
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
