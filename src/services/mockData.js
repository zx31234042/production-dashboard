/* ==========================================================================
   模拟数据源（services/mockData.js）— 按需求清单 V1.30 口径编写
   作用：产生并逐秒推进看板所需的全部数据；界面组件只读取本文件输出的 state
   依赖：utils/format.js（需先加载）
   口径说明：
   - depth  : 航行器深度（相机系统测量的航行器水下深度，非相机自身下放深度）— C-32
   - speed  : 航行速度（X-Y 平面合成），velocity_x / velocity_y 为分速度 — C-23
   - 主要展示：航行器深度 + 航行速度；相机参数（帧率/增益/快门）为设备参数，次要展示 — C-31
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
    let vx = 4.90, vy = 0.10;
    for (let i = 0; i < CURVE_SAMPLES; i++) {
      const phase = i / (CURVE_SAMPLES - 1);
      const base = 12.62 + 0.16 * Math.sin(Math.PI * phase);   // 任务内深度呈缓升缓降形态
      depth.push(clamp(round2(base + (Math.random() - 0.5) * 0.05), 12.20, 13.10));
      vx = clamp(round2(vx + (Math.random() - 0.5) * 0.10), 4.50, 5.30);
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

  function shiftOf(now) {
    const h = now.getHours();
    const s = SHIFTS.find(x => h >= x.start && h < x.end) || SHIFTS[2];
    const start = new Date(now); start.setHours(s.start, 0, 0, 0);
    const end = new Date(now); setEnd(end, s);
    function setEnd(d, sh) { d.setHours(sh.end === 24 ? 0 : sh.end, 0, 0, 0); if (sh.end === 24) d.setDate(d.getDate() + 1); }
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
      /* 测试标准阈值（相机设备参数，次要展示） */
      std:  { depth: 12.50, gain: DEVICE_NOMINAL.gain, fps: DEVICE_NOMINAL.fps, shutter: DEVICE_NOMINAL.shutter },
      /* 实时实测：航行器深度与速度为实测主体；相机参数为设备参数 */
      real: { depth: 12.68, speed: 5.00, vx: 4.90, vy: 0.10,
              fps: DEVICE_NOMINAL.fps, gain: DEVICE_NOMINAL.gain, shutter: DEVICE_NOMINAL.shutter,
              cameraDepth: 12.00 },   // 相机自身水下深度（FR-3.16 / IF-D.1，与航行器深度 depth 严格区分）
      fpsRaw: DEVICE_NOMINAL.fps, gainRaw: DEVICE_NOMINAL.gain, shutterRaw: DEVICE_NOMINAL.shutter,
      unitIndex: 1, progress: 0, result: '测试中', lastResult: '合格', planQty: CFG.planQty
    },
    stats: {},
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
      shiftElapsed: elapsed, shiftTotal: total
    };
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

  /* ---------------- 预警计算 ---------------- */
  function buildWarnings() {
    const t = state.task, m = state.maint;
    const out = [];
    /* 1) 参数阈值临近：以设备参数（实际帧率 vs 设定帧率）判定 */
    const fpsDev = Math.abs(t.real.fps - t.std.fps);
    const fpsPct = t.std.fps > 0 ? (fpsDev / t.std.fps) * 100 : 0;
    out.push(fpsPct >= 0.5
      ? { title: '参数阈值临近预警', detail: `实时帧率偏差 ${fpsPct.toFixed(2)}%（设定 ${t.std.fps} fps / 实时 ${t.real.fps} fps）`, lv: 'warn' }
      : { title: '参数阈值临近预警', detail: `实时帧率偏差 ${fpsPct.toFixed(2)}%，处于允许范围`, lv: 'ok' });
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

    /* 班次 */
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
      elapsed, total: sh.total, pct: (elapsed / sh.total) * 100
    };

    /* 统计 */
    state.stats = computeStats(elapsed, sh.total);

    /* ---- 实测数据（模拟上位机整合后的单一结果值，看板不做二次聚合） ---- */
    const t = state.task;
    t.real.depth = clamp(round2(t.real.depth + (Math.random() - 0.5) * 0.06), 12.20, 13.10);
    t.real.vx = clamp(round2(t.real.vx + (Math.random() - 0.5) * 0.10), 4.50, 5.30);
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

  return { state, tick, toggleLink, injectAlarm, setUnlocked, pushLog, closeActiveAlarm, clearCurve, CFG, DEVICE_NOMINAL };
})();
