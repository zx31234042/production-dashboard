/* ==========================================================================
   模拟数据源（services/mockData.js）— 按需求清单 V1.24 口径编写
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

  /* ---------------- 基础参数（可由配置覆盖） ---------------- */
  const CFG = {
    deviceName: '水池高速摄像检验设备',
    equipCode: 'SX-UNDERWATER-001',      // 整套系统 1 个编号（覆盖 19 台相机）
    team: '检验一班',
    operator: '张伟', operatorId: 'A1027',
    leader: '李建国', leaderId: 'A1003',
    planQty: 180,          // 当班计划测试总数
    cycleSec: 160,         // 单台测试节拍（秒）
    runRate: 0.79,         // 有效运行占比 → 稼动率
    firstPassRate: 0.932,  // 一次性测试合格率
    queueDepth: 72,        // 设备侧待测试排队量
    maintLast: '2026-08-28',
    maintCycleDays: 30,
    unlockPassword: '8888' // 演示密码
  };

  const SHIFTS = [
    { name: '晚班', start: 0,  end: 8  },
    { name: '早班', start: 8,  end: 16 },
    { name: '中班', start: 16, end: 24 }
  ];

  /* 设备参数（相机侧）：实际帧率量程 0～1200 fps，此处按 SHS-201 典型工况取 400 fps */
  const DEVICE_NOMINAL = { fps: 400, gain: 2.5, shutter: 500 };

  /* 任务曲线：按任务完成更新，每个任务按 1 s 采样，采样点数与节拍一致 */
  const CURVE_SAMPLES = 160;

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
      durationSec: v.length, sampleCount: v.length,
      lo: Math.min.apply(null, v), hi: Math.max.apply(null, v)
    };
  }

  const ALARM_POOL = [
    { code: 'E-2071', type: '相机通信中断', desc: '高速相机 GigE 链路瞬时丢包，已自动重连' },
    { code: 'E-3115', type: '深度测量异常', desc: '航行器深度数据跳变超过 0.5 m，已复核并重新标定' },
    { code: 'E-1042', type: '水池液位偏低', desc: '液位低于测试下限，请补充水量' },
    { code: 'W-2210', type: '快门参数超限', desc: '快门设定值超出工艺窗口上限' },
    { code: 'E-4520', type: '上位机数据传输异常', desc: '实时测量数据上传中断超过 5 秒' }
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
    shift: {},
    status: { mode: '测试运行', stage: '拍摄中', online: '在线正常', depth: 12.68, speed: 5.00 },
    task: {
      procOrderNo: 'MES20260917001', productCode: 'CP-2026-A17', productName: '水下振动测试件',
      batchNo: 'PC20260917-03', drawingNo: 'SJ-4471-02', orderNo: 'DD20260916-118',
      /* 测试标准阈值（相机设备参数，次要展示） */
      std:  { depth: 12.50, gain: DEVICE_NOMINAL.gain, fps: DEVICE_NOMINAL.fps, shutter: DEVICE_NOMINAL.shutter },
      /* 实时实测：航行器深度与速度为实测主体；相机参数为设备参数 */
      real: { depth: 12.68, speed: 5.00, vx: 4.90, vy: 0.10,
              fps: DEVICE_NOMINAL.fps, gain: DEVICE_NOMINAL.gain, shutter: DEVICE_NOMINAL.shutter },
      fpsRaw: DEVICE_NOMINAL.fps, gainRaw: DEVICE_NOMINAL.gain, shutterRaw: DEVICE_NOMINAL.shutter,
      unitIndex: 1, progress: 0, result: '测试中', lastResult: '合格', planQty: CFG.planQty
    },
    stats: {},
    alarm: { active: null, ledger: [] },
    warnings: [],
    maint: { last: CFG.maintLast, next: '', cycle: CFG.maintCycleDays, daysLeft: 0, todayRun: 0, monthRun: 0, yearRun: 0, records: MAINT_RECORDS },
    notices: { notices: NOTICES, tips: TIPS, todo: [] },
    selfCheck: [],
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
    const started = done + testing + recheck;
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

  /* ---------------- 累计运行时长 ---------------- */
  function accumulateRun(now, todayRun) {
    const dayOfMonth = now.getDate();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const dayOfYear = Math.floor((now - startOfYear) / 86400000) + 1;
    return {
      today: todayRun,
      month: (dayOfMonth - 1) * 6.2 * 3600 + todayRun,
      year: (dayOfYear - 1) * 6.1 * 3600 + todayRun
    };
  }

  /* ---------------- 自检项（含 MES 链路，C-29） ---------------- */
  function buildSelfCheck() {
    const online = state.device.link === 'online';
    const mes = state.device.mes === 'online';
    return [
      { name: '看板主机网络', state: '正常', lv: 'ok' },
      { name: 'PC 上位机连接', state: online ? '在线正常' : '离线断连', lv: online ? 'ok' : 'err' },
      { name: 'MES 接口连通性', state: mes ? '正常（最近回执 code=200）' : '异常', lv: mes ? 'ok' : 'err' },
      { name: 'MES 上报队列', state: '待补传 0 条', lv: 'ok' },
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
      ? { title: '参数阈值临近预警', detail: `实际帧率偏差 ${fpsPct.toFixed(2)}%（设定 ${t.std.fps} fps / 实际 ${t.real.fps} fps）`, lv: 'warn' }
      : { title: '参数阈值临近预警', detail: `实际帧率偏差 ${fpsPct.toFixed(2)}%，处于允许范围`, lv: 'ok' });
    /* 2) 维保到期 */
    out.push(m.daysLeft <= 14
      ? { title: '设备维保到期预警', detail: `距计划维保还有 ${m.daysLeft} 天（${m.next}）`, lv: 'warn' }
      : { title: '设备维保到期预警', detail: `距计划维保还有 ${m.daysLeft} 天`, lv: 'ok' });
    /* 3) 耗材更换 */
    const lamp = 780 + Math.floor(state.stats.done || 0);
    out.push(lamp > 800
      ? { title: '耗材更换预警', detail: `水下光源累计点亮 ${lamp} h，建议更换（阈值 800 h）`, lv: 'warn' }
      : { title: '耗材更换预警', detail: `光源累计点亮 ${lamp} h，未达更换阈值`, lv: 'ok' });
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

    state.status.depth = t.real.depth;
    state.status.speed = t.real.speed;

    /* ---- 当前工单进度与单任务结果 ---- */
    const unitSec = elapsed % CFG.cycleSec;
    t.progress = unitSec / CFG.cycleSec;
    t.unitIndex = Math.floor(elapsed / CFG.cycleSec) + 1;
    if (unitSec < 8)            { t.result = '待测试'; state.status.stage = '上料对位'; }
    else if (t.progress < 0.35) { t.result = '测试中'; state.status.stage = '下潜'; }
    else if (t.progress < 0.75) { t.result = '测试中'; state.status.stage = '拍摄中'; }
    else if (t.progress < 0.95) { t.result = '测试中'; state.status.stage = '上浮'; }
    else                        { t.result = '测试中'; state.status.stage = '结果判定'; }
    t.lastResult = t.unitIndex % 23 === 0 ? '待复检' : (t.unitIndex % 31 === 0 ? '不合格' : '合格');

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
    const acc = accumulateRun(now, state.stats.runSec);
    state.maint.todayRun = acc.today;
    state.maint.monthRun = acc.month;
    state.maint.yearRun = acc.year;

    /* ---- 异常与预警 ---- */
    if (alarmStartedAt === null) alarmStartedAt = now.getTime();
    const alarmAge = (now.getTime() - alarmStartedAt) / 1000;
    if (alarmAge > 150) {
      activeAlarmIndex = (activeAlarmIndex + 1) % ALARM_POOL.length;
      alarmStartedAt = now.getTime();
    }
    const a = ALARM_POOL[activeAlarmIndex];
    state.alarm.active = {
      code: a.code, type: a.type, desc: a.desc,
      time: new Date(alarmStartedAt).toTimeString().slice(0, 8),
      state: alarmAge > 90 ? '处理中' : '未处理'
    };
    state.alarm.ledger = buildLedger(now);
    state.warnings = buildWarnings();

    /* ---- 待办 ---- */
    const lampHours = 780 + state.stats.done;
    const warnCount = state.warnings.filter(w => w.lv === 'warn' || w.lv === 'err').length;
    state.notices.todo = [
      { name: '待复检任务', value: state.stats.recheck, unit: '件', lv: 'warn' },
      { name: '待维保作业', value: state.maint.daysLeft <= 14 ? 1 : 0, unit: '项', lv: 'warn' },
      { name: '未闭环异常', value: state.alarm.active.state === '已闭环' ? 0 : 1, unit: '条', lv: 'err' },
      { name: '设备侧待测队列', value: state.stats.pending, unit: '件', lv: 'info' },
      { name: '耗材临近更换', value: lampHours > 800 ? 1 : 0, unit: '项', lv: 'warn' },
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

  /* 演示用：立即触发一次新报警 */
  function injectAlarm() {
    activeAlarmIndex = (activeAlarmIndex + 1) % ALARM_POOL.length;
    alarmStartedAt = Date.now();
    return ALARM_POOL[activeAlarmIndex];
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

  return { state, tick, toggleLink, injectAlarm, setUnlocked, clearCurve, CFG, DEVICE_NOMINAL };
})();
