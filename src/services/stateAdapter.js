/* ==========================================================================
   服务端快照 / 事件 → 看板 state 适配层（services/stateAdapter.js）—— W5-②（前端切真实源）
   需求版本：V1.44（V1.44 / C-114 两处口径登记〔①`equipCode` 的「给定方＝MES 方」在需求侧写准 —— `FR-1.2` 的「数据来源」列与 `IF-D.12` 同口径对齐（书面依据＝附录 2 的「数据来源」列＝MES 工单 与 `IF-A.4`），**取值路径与优先级一字未改**；②当班统计的「已完成」以 `result` 表为准 —— **单一真源、与 `FR-5.11` 的「已完成件数」同源**，见 `FR-4.4` 的真源声明〕；**不改任何算式、不增删条款**，仍 259 / P0 188 / AC 12 / Q 7；本文件只随需求版本戳同步，无行为改动；V1.43 / C-113 「13 张表」明确为业务表口径（`schema.sql` 实建 15 张 ＝ 13 业务表 ＋ `schema_meta` ＋ `auth_credential`；`db-check` 的 `REQUIRED_TABLES` ＝ 14），不增删条款，仍 259 / P0 188 / AC 12 / Q 7；V1.42 / C-112 三处口径补写〔DR-05 件序号与终态、FR-4.9 复检数〕；V1.41 / C-111 计量单位定义＋DR-04 件序号补登；V1.40 / C-109＋C-110 口径补写〔FR-5.11 起算点＋DR-05 写入口径〕；V1.39 / C-108 工单超时预警判据改「进度落后率超阈值率」且阈值率可配〔本文件只随需求版本戳同步，无行为改动〕；承 V1.38（承 ADR-0008 D3/D4：服务端模式下前端**只应用、不生成**）
   作用：把服务端的**两条出口**翻译成看板既有的 `state`（`MockData.state`）形状，供现有渲染层
         **零改动**消费：
           · `GET /state`（或 SSE `hello`）⇒ `snapshotToState(state, snapshot)`  ← 全量首帧
           · `GET /events` 的增量        ⇒ `eventToState(state, evt)`            ← 逐条应用
   三条硬口径（ADR-0008 D3，本文件是它们的**唯一落点**）：
     ① **`frame` 复用 `Api.applyUpperPayload()`**：服务端 `snapshot.frame` 与 `event.frame` 的载荷
        与上位机 `upper` 报文**逐字段同名**（`server/services/stateSnapshot.js` 的 `FRAME_FIELDS`
        ≡ `config/fieldMap.js` 的 `upperToBoard` 取值键）⇒ **不再写第二份帧映射**
        （写第二份必然在改字段名时漏改一处）。
     ② **`stats` 键名映射只此一份**：服务端 `services/stats.computeShiftStats()` 的键名
        （`planQty/startedQty/doneQty/…/firstPassRate/capacityRate/oee/avgTestSec/runSec/idleSec/accumulate`）
        与前端 `MockData.computeStats()` 的键名（`plan/started/done/…/firstPass/capacity/oee/avgTest/runSec/…`）
        **不同名**，且**语义单位也不同**（服务端三个"率"已是百分数）。映射**集中在本文件的
        `STATS_KEY_MAP` / `applyServerStats()`**，任何组件都**不得**再写一份（R-2026-09-19-02 的教训：
        复制两份必然漏改）。
     ③ **缺失一律 `null`**（W4 已定，ADR-0008 D3）：缺测/未接入一律 `null`，**绝不用 `0` 顶替**
        —— `0` 是合法物理量（0 m 深度、0 件产量），拿它顶"没有数据"会让界面把"测不到"读成"测到 0"。
        唯一例外是 `noData` 这类**显式状态位**（布尔）与 `state.stats.noData`（沿用既有键名）。
   未接入服务端的模块（ADR-0008 D3 点名）：维保 `maintenance`、异常台账 `alarm`、
   `selfCheck` 细项、`opLog`、`warnings` —— 服务端快照**没有**这些键，故本文件把它们**清空**
   （`[]` / `null`），由各组件走**既有的空态/占位**分支（`ui-check` 的 UI-11 已覆盖），
   **不得**残留 `mockData.js` 的演示记录（那会让界面分不清真实值与演示值）。
   ⚠ **公告 `notice` 已不在"未接入"之列**（`T-20261002-08` / `FR-7.12`，P0）：服务端快照自本轮起
   带 `notices` 段（`server/services/stateSnapshot.js` 的 `noticesOf()`，读口＝
   `server/repo/notice.js` 的 `listForBoard()`），本文件按下面的 `applyServerNotices()` **映射**它；
   **服务端确实没有数据**（`notices` 段缺失/为空）时仍走**既有空态**（UI-11 的"暂无车间公告"）。
   依赖：`services/api.js`（`Api.applyUpperPayload`）、`utils/format.js`（只借 `pad` 拼时刻文本）。
   **不得**依赖任何 DOM：本文件是纯函数适配层（PROJECT_RULES 9.2）。
   ========================================================================== */
window.StateAdapter = (function () {
  'use strict';

  /* ---------------- 服务端 stats → 前端 stats 的**唯一**键名映射表 ----------------
     左＝服务端 `computeShiftStats()` 键；右＝前端 `MockData.computeStats()` 键（渲染层读的键名）。
     值语义**不换算**：服务端的 `firstPassRate`/`capacityRate`/`oee` 已是 0～100 的百分数
     （`StatsPanel` 也是按百分数 `toFixed(1) + '%'` 渲染），原样搬运即可。 */
  const STATS_KEY_MAP = Object.freeze({
    planQty: 'plan',
    startedQty: 'started',
    notStartedQty: 'notStarted',
    doneQty: 'done',
    runningQty: 'testing',
    waitingQty: 'pending',
    passQty: 'qualified',
    failQty: 'unqualified',
    retestQty: 'recheck',
    firstPassRate: 'firstPass',
    capacityRate: 'capacity',
    oee: 'oee',
    avgTestSec: 'avgTest',
    runSec: 'runSec',
    idleSec: 'idleSec'
  });

  /* 班次时刻文本：服务端给 ISO/文本（`stats.shift.startAt` / `endAt`），前端要 `HH:MM`。
     只做"取值 + 截取"，**不重算班次**（班次口径的真源是服务端 `services/shift.js`）。 */
  function hhmmOf(value) {
    const s = value === undefined || value === null ? '' : String(value);
    const m = /T(\d{2}):(\d{2})/.exec(s) || /(\d{2}):(\d{2})/.exec(s);
    return m ? m[1] + ':' + m[2] : null;
  }

  /** 数值归一：非有限数一律 `null`（**不写 0**；理由见文件头 ③） */
  function numOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  /** 两位补零（本地实现，避免依赖 `utils/format.js` 的加载顺序 —— 与 `services/api.js` 同款做法） */
  function pad(n) { return String(n).padStart(2, '0'); }

  /* ---------------- stats ---------------- */

  /**
   * 把服务端 `snapshot.stats`（`computeShiftStats()` 的全量产物）写进 `state.stats`。
   * 键名映射走上方 `STATS_KEY_MAP`（只此一份）；`noData` 取服务端的**显式状态位**
   * （服务端无该位 ⇒ 视为 `false`，"有数据"），并保留服务端原始键（便于对账与排查）。
   * @param {object} state    看板状态
   * @param {object|null} s   服务端统计段
   */
  function applyServerStats(state, s) {
    if (!state) return null;
    if (!s || typeof s !== 'object') {
      /* 服务端没给统计段 ⇒ 显式"无数据"，**不伪造**一份全 0 */
      state.stats = { noData: true };
      return state.stats;
    }
    const out = {};
    Object.keys(STATS_KEY_MAP).forEach(serverKey => {
      out[STATS_KEY_MAP[serverKey]] = numOrNull(s[serverKey]);
    });
    /* **显式状态位** `noData`（与 `MockData.noDataStats()` / `computeStats()` 同一语义）：
       它是渲染层唯一的"这些数值不成立"判据（`StatsPanel`/`ShiftPanel`/`TaskPanel`/
       `DeviceStatusPanel` 四处都读它，且**只认这一位**、不靠"值是不是 0 去猜"）。
       三种情形都算"不成立"，否则渲染层会把 `null` 交给 `.toFixed()`（抛 TypeError）：
         ① 服务端显式给了 `noData: true`；
         ② 服务端没给可用的班次（`shift.name` 缺失）—— 当班统计以班次为基准，无班次即算不出来
            （与前端"班次配置缺口 ⇒ 无数据"同一口径）；
         ③ 服务端连 `stats` 段都没给（本函数上面的早退分支已处理）。
       ⚠ 这里**只传播结论**，不自己造统计值。 */
    const hasShift = !!(s.shift && typeof s.shift === 'object' && s.shift.name);
    out.noData = (s.noData === true) || !hasShift;
    /* 服务端原始键原样保留（值可能为对象，如 `accumulate` / `shift`）—— 供对账与排查，
       渲染层不读它们（读的是上面映射后的键）。 */
    out.server = s;
    state.stats = out;
    return out;
  }

  /* ---------------- 班次（时刻派生量由**本地时钟**给出，ADR-0008 D3） ---------------- */

  /**
   * 单个班次的起止（本地日期 + 配置的整点），与 `mockData.shiftOf()` 同一构造方式。
   * ⚠ 本函数**只**把配置的整点落成时刻对象，**不重做**"当前属于哪一班"的判定
   * （真源＝服务端 `stats.shift`）。
   * @returns {{start:Date, end:Date, total:number}}
   */
  function shiftBounds(def, now) {
    const startHour = def.start === 24 ? 0 : def.start;
    const endHour = def.end === 24 ? 0 : def.end;
    const start = new Date(now);
    start.setHours(startHour, 0, 0, 0);
    const end = new Date(now);
    end.setHours(endHour, 0, 0, 0);
    if (def.end === 24) end.setDate(end.getDate() + 1);
    if (def.end <= def.start) end.setDate(end.getDate() + 1);
    return { start, end, total: (end - start) / 1000 };
  }

  /**
   * 按**本地时钟**推进服务端模式下的"班次已进行/剩余/百分比"（ADR-0008 D3：服务端模式下
   * `state.clock`/`state.lastRefresh` 与班次进度**必须继续前进**，但本地**不得生成业务数据**）。
   *
   * 为什么本地算而不是照抄服务端 `stats.shift.elapsedSec`：①需求要的是"界面时钟与进度照常走"；
   * ②服务端快照只在建连/增量事件时到达，两次事件之间进度会停住（现场看到"钟停了"）；
   * ③两边的**班次归属**仍由服务端 `stats.shift.name` 决定，本函数只把"这一班从几点到几点"
   * 换算成进度 —— 口径仍是服务端给的班次。
   * @param {object} state 看板状态（需先由 `applyServerStats()` 写入 `stats.server.shift`）
   * @param {Date}   now   注入时刻
   */
  function applyShiftProgress(state, now) {
    if (!state || !state.shift) return null;
    const sh = state.shift;
    const serverShift = (state.stats && state.stats.server && state.stats.server.shift) || null;
    const list = sh.list || [];
    const def = serverShift && serverShift.name
      ? list.find(x => x && x.name === serverShift.name) || null
      : null;
    /* 当班人员（FR-1.6）不是"业务数据"，而是**配置真源**（`board.config.js` 的 `shift.roster`，
       `mockData` 的 `tick()` 每次也是从这里取）。服务端快照不含人员信息，且服务端模式下不跑
       `tick()` ⇒ 必须在这里补上，否则头屏的班组/操作员/班组长会渲染成 `undefined`
       （服务端模式下"人员"显示"尚未接入服务端"才是正确的，但那要改 `HeaderBar` 与文案基线；
       而人员本来就在配置里、不属"未接入模块"，故按配置真源补全，与演示模式同值）。 */
    const roster = (((window.BoardConfig || {}).shift || {}).roster) || {};
    if (roster.team !== undefined) sh.team = roster.team;
    if (roster.operator !== undefined) sh.operator = roster.operator;
    if (roster.operatorId !== undefined) sh.operatorId = roster.operatorId;
    if (roster.leader !== undefined) sh.leader = roster.leader;
    if (roster.leaderId !== undefined) sh.leaderId = roster.leaderId;
    if (!def) {
      /* 服务端没给班次（或配置里找不到同名班次）⇒ 只保留班次表与人员，时刻派生量显式无数据 */
      sh.elapsed = null;
      sh.pct = null;
      sh.noData = true;
      return sh;
    }
    const b = shiftBounds(def, now);
    const elapsed = Math.min(Math.max(0, (now - b.start) / 1000), b.total);
    sh.name = def.name;
    sh.range = pad(def.start) + ':00 - ' + pad(def.end === 24 ? 0 : def.end) + ':00';
    sh.start = pad(def.start) + ':00';
    sh.end = pad(def.end === 24 ? 0 : def.end) + ':00';
    sh.elapsed = elapsed;
    sh.total = b.total;
    sh.pct = (elapsed / b.total) * 100;
    sh.noData = false;
    return sh;
  }

  /* ---------------- 未接入模块（ADR-0008 D3 点名） ---------------- */

  /**
   * 把"服务端尚未接入"的模块显式清空（**只清空，不伪造**）。
   * 服务端快照里**没有**维保/异常台账/自检细项/操作日志/预警这几段，故它们在服务端模式下一律无数据
   * —— 由各组件走既有空态/占位分支呈现（`AlarmPanel` 的"当班无故障报警"、`MaintPanel` 的空表 …）。
   * ⚠ **公告（`notices`）不在这里清空**（`T-20261002-08` / `FR-7.12`）：它已接入服务端，
   * 由 `applyServerNotices()` 在 `snapshotToState()` 里**映射**；"服务端没数据 ⇒ 空态"由该函数
   * 自己保证（拿到 `notices` 段就搬，拿不到就给空态）。
   * @param {object} state 看板状态
   */
  function clearUnservedModules(state) {
    state.warnings = [];
    state.selfCheck = [];
    state.opLog = [];
    /* `E198`（2026-10-07 追加）／**`A-3①` 负责人裁定：此处不清 `state.health`**
       （裁定人＝项目负责人；裁定日期＝2026-10-07；本行原为 `state.health = null;`，已按裁定撤掉）。
       为什么可以不清：`state.health`（`{frameUnitIndex, at}`）**不是快照载荷** —— 它是 `GET /health` 的
       **运行期读数**，由 `services/selfCheckProbe.js` 的节流探测写入（`REFRESH_MS = 5000`），
       与"服务端快照每帧整体替换 `state.stats`"（见 `applyServerStats()` 的 `state.stats = out`）
       不是同一条通道；而该读数的**新鲜度由构造保证 ≤5 s**（探测节流上限）⇒ "清空 ⇒ 重填"这一对
       操作在屏上留下的只是一段必然 ≤5 s 的 `warn` 抖动，**不构成"过期读数上屏"**。
       **未改什么**：服务端模式下 `withoutIndex > 0`（红字点名）／`= 0`（不显示）／读数缺失
       （"未取得 /health 读数"黄字）**三档行为一字不动** —— 本处只撤"清理"，不改四态语义
       （服务端三档 ＋ 演示档；四态由 `tests\ui-check.js` 的 U11 守，本包不得改断言）。 */
    state.alarm = { active: null, queue: [], ledger: [] };
    if (state.maint) {
      /* 维保周期**参数**来自配置（`board.config.js` 的 maintenance 段，是配置真源不是演示数据），
         保留；**台账记录**是业务数据 ⇒ 清空（服务端未接入）。 */
      state.maint.records = [];
      state.maint.todayRun = null;
      state.maint.monthRun = null;
      state.maint.yearRun = null;
      state.maint.daysLeft = null;
    }
  }

  /* ---------------- task / standard / device ---------------- */

  /**
   * 用工单段覆盖 `state.task`（**只覆盖服务端给了的字段**；缺的一律 `null`）。
   * @param {object} state 看板状态
   * @param {object|null} t 服务端 `snapshot.task`
   */
  function applyServerTask(state, t) {
    if (!state || !state.task) return null;
    const task = state.task;
    if (!t || typeof t !== 'object') {
      /* 无工单：保留 `real`/`std` 的对象形状（否则渲染层取属性会抛），业务字段逐项置 null；
         单任务进度/结果同样置 null（服务端快照不含它们，不得残留演示种子值）。 */
      ['procOrderNo', 'productCode', 'productName', 'batchNo', 'drawingNo', 'orderNo',
        'processNo', 'processName', 'planQty', 'progress', 'unitIndex', 'result'].forEach(k => { task[k] = null; });
      return task;
    }
    task.procOrderNo = t.procOrderNo === undefined ? null : t.procOrderNo;
    task.productCode = t.productCode === undefined ? null : t.productCode;
    task.productName = t.productName === undefined ? null : t.productName;
    task.batchNo = t.batchNo === undefined ? null : t.batchNo;
    task.drawingNo = t.drawingNo === undefined ? null : t.drawingNo;
    task.orderNo = t.orderNo === undefined ? null : t.orderNo;
    task.processNo = t.processNo === undefined ? null : t.processNo;
    task.processName = t.processName === undefined ? null : t.processName;
    task.planQty = numOrNull(t.planQty);
    /* 单任务进度/结果：**不在服务端快照的键集之内**（快照的 `stats` 是当班统计，不含单件进度）
       ⇒ 一律置 `null`（"尚未接入服务端"）。为什么必须显式置 null 而不是"保留上一帧"：
       服务端模式下 `state.task` 的初值是 `mockData.js` 的**演示种子**（`result:'测试中'`、
       `progress:0`），若不清就会把演示值当成真实值显示（ADR-0008 D3 禁止"用演示值顶替"）。 */
    task.progress = null;
    task.unitIndex = null;
    task.result = null;
    return task;
  }

  /**
   * 把服务端标准段写进 `state.task.standard`（FR-3.18 的运行时真源）。
   * 服务端 `standard` 的形状（`stateSnapshot.js`）：`{depth:{typical,upperDev,lowerDev,upper,lower,set}, …}`
   * 与前端 `state.task.standard[kind]` 的形状**同名同义**（`typical`/`upperDev`/`lowerDev`/`unit`/`digits`），
   * 故原样搬运；服务端不给 ⇒ **删除**该行（而不是留演示值），让 `fieldMap.standardLimits()` 走
   * 它既有的"未建行 ⇒ 用配置默认（仅演示）/ 建了行但缺项 ⇒ 该参数不判定"的分支。
   * @param {object} state 看板状态
   * @param {object|null} std 服务端 `snapshot.standard`
   */
  function applyServerStandard(state, std) {
    if (!state || !state.task) return null;
    if (!std || typeof std !== 'object') {
      state.task.standard = undefined;
      return null;
    }
    const out = {
      productCode: std.productCode === undefined ? null : std.productCode,
      processCode: std.processCode === undefined ? null : std.processCode,
      versionNo: numOrNull(std.versionNo),
      effectiveFrom: std.effectiveFrom === undefined ? null : std.effectiveFrom
    };
    ['depth', 'speed'].forEach(kind => {
      const row = std[kind];
      if (!row || typeof row !== 'object') return;
      out[kind] = {
        unit: kind === 'depth' ? 'm' : 'm/s',
        digits: 2,
        typical: numOrNull(row.typical),
        upperDev: numOrNull(row.upperDev),
        lowerDev: numOrNull(row.lowerDev),
        /* 导出上下限：服务端已算好（`absoluteLimits`），直接带上；渲染层仍按公式现算并核对 */
        upper: numOrNull(row.upper),
        lower: numOrNull(row.lower),
        set: row.set === undefined ? null : !!row.set
      };
    });
    state.task.standard = out;
    return out;
  }

  /**
   * 设备段（`snapshot.device`）：`equipCode` / `equipName`。
   * 服务端无设备行 ⇒ **不覆盖**（设备名/编号是 FR-1.1 的配置真源，保留 `board.config.js` 的值）。
   */
  function applyServerDevice(state, d) {
    if (!state || !state.device) return null;
    if (!d || typeof d !== 'object') return state.device;
    if (typeof d.equipCode === 'string' && d.equipCode) state.device.code = d.equipCode;
    if (typeof d.equipName === 'string' && d.equipName) state.device.name = d.equipName;
    return state.device;
  }

  /* ---------------- 链路（FR-2.6 ≤5 s） ---------------- */

  /**
   * 链路判据（IF-D.9 / FR-2.6）：与 `Ingest.linkState()` **同口径**（不重算阈值，只应用结论）。
   * `snapshot.link` 里的 `online` 是服务端算好的结论；`lastCollectMs` 供"数据新鲜度"展示用。
   * @param {object} state 看板状态
   * @param {object|null} l 服务端 `snapshot.link`
   */
  function applyServerLink(state, l) {
    if (!state) return null;
    if (!l || typeof l !== 'object') {
      state.serverLink = null;
    } else {
      state.serverLink = {
        state: l.state === undefined ? null : l.state,
        online: l.online === true,
        staleMs: numOrNull(l.staleMs),
        lastAcceptedAt: l.lastAcceptedAt === undefined ? null : l.lastAcceptedAt,
        lastCollectTime: l.lastCollectTime === undefined ? null : l.lastCollectTime,
        lastCollectMs: numOrNull(l.lastCollectMs)
      };
    }
    state.upperValid = state.serverLink ? state.serverLink.online : false;
    /* 界面判据 `device.link`：服务端模式下**只由服务端链路结论驱动**（ADR-0008 D3）。
       （`Api.syncLinkState()` 对服务端模式有专门分支，见 api.js。） */
    state.device.link = state.serverLink && state.serverLink.online ? 'online' : 'offline';
    return state.device.link;
  }

  /* ---------------- UI-20 上报状态（`snapshot.upload` / `upload` 事件） ---------------- */

  /**
   * 服务端上报段 → `state.upload`（UI-20 卡片消费；见 `components/UploadPanel.js`）。
   * 服务端形状（`stateSnapshot.uploadOf()`）：`{configured, baseUrl, responseStyle, pendingCount,
   * pendingOnly, failedAfterRetry, total, capacity, warnThreshold, oldestAt, alert, autoRetry}`
   * `state.upload.items` 由 `UploadPanel` 异步从 `GET /upload/pending` 取明细（快照**不带明细**）。
   */
  function applyServerUpload(state, u, at) {
    if (!state) return null;
    if (!u || typeof u !== 'object') {
      state.upload = { available: false, pendingCount: null, items: [], itemsLoaded: false, at: at || null };
      state.device.mes = 'offline';
      return state.upload;
    }
    state.upload = {
      available: true,
      configured: u.configured === true,
      baseUrl: u.baseUrl === undefined ? null : u.baseUrl,
      responseStyle: u.responseStyle === undefined ? null : u.responseStyle,
      pendingCount: numOrNull(u.pendingCount),
      pendingOnly: numOrNull(u.pendingOnly),
      failedAfterRetry: numOrNull(u.failedAfterRetry),
      total: numOrNull(u.total),
      capacity: numOrNull(u.capacity),
      warnThreshold: numOrNull(u.warnThreshold),
      oldestAt: u.oldestAt === undefined ? null : u.oldestAt,
      alert: u.alert === undefined ? null : u.alert,
      autoRetry: false,
      /* 明细不由快照携带 ⇒ 保留上一次取回的清单并标记"待刷新" */
      items: Array.isArray(state.upload && state.upload.items) ? state.upload.items : [],
      itemsLoaded: false,
      at: at || null
    };
    /* MES 链路徽标：已配置且有地址 ⇒ 在线（真实连通性由服务端上报结果反映在 alert 上） */
    state.device.mes = state.upload.configured ? 'online' : 'offline';
    return state.upload;
  }

  /* ---------------- 公告（`FR-7.12`，P0） ---------------- */

  /**
   * 服务端公告段 → `state.notices`（**与前端既有形状同形**：`{notices, tips, todo}`）。
   *
   * 服务端形状（`server/services/stateSnapshot.js` 的 `noticesOf()` ← `repo/notice.js` 的
   * `listForBoard()`）：`{notices:[{id,tag,text,lv,time}], tips:[同左], todo:[]}` ——
   * 与 `mockData.js` 的 `state.notices` **逐键同名**（`tag`/`text`/`lv`/`time`），故原样搬运；
   * 服务端多给一个 `id`（`FR-7.12` 的编辑/删除入口要靠它指到具体某条），前端按**可缺省**处理。
   *
   * 三条口径：
   *  ① **不再清空**（`T-20261002-08` 之前本层把 `notices` 清成空态 ⇒ 服务端模式下图上看不到公告）；
   *  ② **服务端确实没有数据 ⇒ 走既有空态**：`notices` 段缺失/不是对象，或两列都为空数组 ⇒
   *     写 `{notices:[],tips:[],todo:[]}`，由 `NoticePanel` 的 UI-11 空态文案承担
   *     （**不得**残留 `mockData.js` 的演示公告 —— ADR-0008 D3）；
   *  ③ **不做任何字段派生**（不造 `lv`、不拼 `time`）：那些口径在服务端 `repo/notice.js` 一处。
   * @param {object} state 看板状态
   * @param {object|null} n 服务端 `snapshot.notices`
   * @returns {{notices:Array, tips:Array, todo:Array}} 写进 `state.notices` 的对象
   */
  function applyServerNotices(state, n) {
    if (!state) return null;
    /* 逐行搬运（**不做字段派生**：`tag`/`text`/`lv`/`time` 与 `id` 都按服务端给的值，
       缺的给 `null`/`''`，不猜；`id` 只在服务端确实给了时才带 —— 演示期的行没有它，
       渲染层与编辑/删除入口都按"可缺省"处理）。 */
    const rows = v => {
      const out = [];
      if (!Array.isArray(v)) return out;
      for (const x of v) {
        const row = {
          tag: x && x.tag !== undefined ? x.tag : null,
          text: x && x.text !== undefined ? x.text : null,
          lv: x && x.lv !== undefined ? x.lv : 'info',
          time: x && x.time !== undefined ? x.time : ''
        };
        if (x && x.id !== undefined && x.id !== null) row.id = x.id;
        out.push(row);
      }
      return out;
    };
    if (!n || typeof n !== 'object') {
      state.notices = { notices: [], tips: [], todo: [] };
      return state.notices;
    }
    state.notices = {
      notices: rows(n.notices),
      tips: rows(n.tips),
      /* `todo` 是**派生量**列表（`{name,value,unit,lv}`），服务端不提供 ⇒ 恒空 ⇒ 走既有空态 */
      todo: []
    };
    return state.notices;
  }

  /* ---------------- 帧 ---------------- */

  /**
   * 应用一帧实测数据 —— **复用 `Api.applyUpperPayload()`**（服务端帧载荷与 upper 报文逐字段同名）。
   * @param {object} state   看板状态
   * @param {object} payload 帧载荷（`snapshot.frame` 或 `event.frame` 的 payload）
   * @param {Date}   now     应用时刻（用于新鲜度判定）
   */
  function applyServerFrame(state, payload, now) {
    const api = window.Api;
    if (!state || !payload || typeof payload !== 'object' || !api || typeof api.applyUpperPayload !== 'function') {
      return { applied: 0, missing: [] };
    }
    return api.applyUpperPayload(state, payload, now || new Date());
  }

  /**
   * 把**来自报文的实测侧字段**逐键归 `null`（= 本机没有这个值）。
   *
   * ⚠ 为什么必须独立成函数、且在**帧分支之外**无条件调用（F15-2，2026-09-28 复核实测的真缺陷）：
   *   `applyUpperPayload()` 的既定语义是"**字段缺失就保留看板原值**"（演示期为了避免大屏闪 0）。
   *   但服务端模式下 `state.task.real` 的初值是 `mockData.js` 的**演示种子值**
   *   （`depth 5.00 / speed 5.00 / vx 5.00 / fps 400 …`）。改前"归零"写在 `applyServerFrame()`
   *   **内部**，而 `snapshotToState()` 只在 `s.frame` 是对象时才调它 ⇒ **`snapshot.frame === null`
   *   （服务端从未收到过任何帧：空库 / 上位机未连）时整个归零被跳过**，界面于是把演示种子值
   *   当成真实值显示（复核实测 `#stDepth="5.00" #stSpeed="5.00" #stVx="5.00" #stFps="400"`）
   *   —— 正是 ADR-0008 D3「不得用演示值顶替」要禁的情形。
   *   现在它**无条件**在帧分支之前执行：帧缺失 ⇒ 全部保持 `null` ⇒ 渲染层显示「—」；
   *   帧存在 ⇒ 随后由报文把真实存在的字段写回，缺测字段仍为 `null`。
   *
   * 只归零**来自报文的实测侧字段**（`fieldMap.upperToBoard` 的 `task.real.*` 取值键），
   * 不碰其它 state；`task.std.*`（相机设定值）不在报文里，由配置/上位机侧提供，**不归零**。
   */
  function resetRealtimeFields(state) {
    const api = window.Api;
    if (!state || !api || typeof api.setPath !== 'function') return false;
    Object.keys(((window.FieldMap || {}).upperToBoard) || {}).forEach(boardPath => {
      if (boardPath.indexOf('task.real.') !== 0) return;
      api.setPath(state, boardPath, null);
    });
    return true;
  }

  /* ---------------- 对外：全量快照 ---------------- */

  /**
   * 把整机快照写进 `state`（`GET /state` 或 SSE `hello` 的首帧）。
   * 纯应用：**不产生**任何服务端没有的数据；未接入的模块显式清空。
   * @param {object} state    看板状态（`MockData.state`）
   * @param {object} snapshot 服务端 `snapshot`（8 键：link/task/device/frame/stats/standard/upload/notices）
   * @param {Date}   [now]    应用时刻
   * @returns {object} 应用结果（供自检/回执读取；非业务状态）
   */
  function snapshotToState(state, snapshot, now) {
    const at = now || new Date();
    const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const result = { applied: 0, missing: [], keys: Object.keys(s) };

    /* ① 未接入模块先清空（ADR-0008 D3：不得残留演示值） */
    clearUnservedModules(state);

    /* ② 链路（决定 `device.link`，也是"数据是否冻结"的判据） */
    applyServerLink(state, s.link);

    /* ③ 工单 / 设备 / 标准（FR-1.1 / FR-3.18） */
    applyServerTask(state, s.task);
    applyServerDevice(state, s.device);
    applyServerStandard(state, s.standard);

    /* ④ 统计（键名映射只此一份）＋ 班次进度（本地时钟推进） */
    applyServerStats(state, s.stats);
    applyShiftProgress(state, at);

    /* ⑤ 帧（复用 upper 适配链路）。
       ⚠ **归 null 必须在帧分支之外无条件先做**（F15-2）：`s.frame === null`
       （服务端从未收到过任何帧）时也要把实测位清成 `null`，否则界面会把
       `mockData.js` 的演示种子值当成真实值显示（详见 `resetRealtimeFields()` 的说明）。
       顺序：先归零 ⇒ 再把报文里真实存在的字段写回 ⇒ 缺测字段最终仍是 `null`。 */
    resetRealtimeFields(state);
    if (s.frame && typeof s.frame === 'object') {
      const r = applyServerFrame(state, s.frame, at);
      result.applied = r.applied;
      result.missing = r.missing;
    } else {
      /* 帧缺失：如实记下"一条实测位都没应用"（供自检/回执读，不伪造） */
      result.frameMissing = true;
    }

    /* ⑥ UI-20 上报段 */
    applyServerUpload(state, s.upload, at);

    /* ⑦ 公告段（`FR-7.12` / DR-10）：**映射**（不再清空）；服务端没有数据就落空态（UI-11） */
    applyServerNotices(state, s.notices);

    state.serverMode = true;
    return result;
  }

  /* ---------------- 对外：增量事件 ---------------- */

  /**
   * 应用一条服务端事件（`{seq, at, kind, payload}`，见 `server/services/eventBus.js`）。
   * **未知 kind 一律忽略并返回 `applied:false`**（绝不抛 —— 服务端将来新增事件种类时，
   * 前端旧版本必须继续可用，这是"优雅降级"在事件层的落地）。
   * @param {object} state 看板状态
   * @param {object} evt   事件信封
   * @param {Date}   [now] 应用时刻
   * @returns {{applied:boolean, kind:string, note:string}}
   */
  function eventToState(state, evt, now) {
    const at = now || new Date();
    if (!state || !evt || typeof evt !== 'object') {
      return { applied: false, kind: '', note: '事件为空' };
    }
    const kind = String(evt.kind || '');
    const payload = evt.payload;
    switch (kind) {
      case 'frame': {
        /* 1 s 采样帧：与 upper 报文同名 ⇒ 复用同一适配链路。
           与快照路径同口径：**先归 null 再应用报文**（缺测字段保持"—"，不残留上一帧或演示值）。 */
        resetRealtimeFields(state);
        const r = applyServerFrame(state, payload, at);
        return { applied: true, kind, note: 'applied=' + r.applied + ' missing=' + r.missing.length };
      }
      case 'link': {
        /* 断连/恢复：`ingest.createLinkMonitor()` 的 payload 即 `linkState()` 的投影 */
        applyServerLink(state, payload);
        return { applied: true, kind, note: 'online=' + (state.device.link === 'online') };
      }
      case 'task': {
        /* 派工/工单新增：payload 只带该次派工的字段 ⇒ 逐字段覆盖（缺的置 null，不猜） */
        applyServerTask(state, payload);
        return { applied: true, kind, note: 'procOrderNo=' + String(state.task && state.task.procOrderNo) };
      }
      case 'standard': {
        /* 标准新版本：payload 是版本元信息（无 typical/upperDev/lowerDev）⇒ **不当作完整标准**，
           只登记版本与生效时刻；完整标准以 `GET /state` 的 `standard` 段为准
           （下一帧快照或 `standard` 事件后的快照刷新会带上）。 */
        if (state.task) {
          if (!state.task.standard || typeof state.task.standard !== 'object') state.task.standard = {};
          state.task.standard.versionNo = numOrNull(payload && payload.versionNo);
          state.task.standard.effectiveFrom = payload && payload.effectiveFrom !== undefined
            ? payload.effectiveFrom : null;
        }
        return { applied: true, kind, note: 'versionNo=' + String(payload && payload.versionNo) };
      }
      case 'upload': {
        /* UI-20：队列状态迁移（入队/成功/重报）。快照的 upload 段 + 本事件的计数即可刷新卡片；
           明细清单由 `GET /upload/pending` 取（见 UploadPanel）。 */
        const prev = (state.upload && typeof state.upload === 'object') ? state.upload : {};
        const back = v => (v === undefined ? null : v);
        applyServerUpload(state, {
          configured: payload ? payload.configured !== false : (prev.configured === true),
          baseUrl: back(prev.baseUrl),
          responseStyle: back(prev.responseStyle),
          pendingCount: payload ? payload.pendingCount : back(prev.pendingCount),
          pendingOnly: back(prev.pendingOnly),
          failedAfterRetry: back(prev.failedAfterRetry),
          total: back(prev.total),
          capacity: payload ? payload.capacity : back(prev.capacity),
          warnThreshold: payload ? payload.warnThreshold : back(prev.warnThreshold),
          oldestAt: back(prev.oldestAt),
          alert: payload ? payload.alert : prev.alert
        }, at);
        state.upload.lastAction = payload ? payload.action : null;
        state.upload.lastUploadId = payload ? payload.uploadId : null;
        /* 明细必然已变 ⇒ 标为待刷新，由 `UploadPanel` 的下一次周期刷新取回 */
        state.upload.itemsLoaded = false;
        return { applied: true, kind, note: 'action=' + String(payload && payload.action) };
      }
      case 'warning': {
        /* 判定/预警产出：服务端已给出预警数组（`judge.evaluate()` 的 out）⇒ 原样应用 */
        state.warnings = Array.isArray(payload) ? payload.slice()
          : (payload && Array.isArray(payload.warnings) ? payload.warnings.slice() : []);
        return { applied: true, kind, note: 'count=' + state.warnings.length };
      }
      default:
        /* 未知事件种类：**忽略且不抛**（前向兼容；服务端新增 kind 不该让旧前端崩） */
        return { applied: false, kind, note: '未知事件种类（已忽略）' };
    }
  }

  return {
    snapshotToState,
    eventToState,
    /* 细分出口（供自检与后续包复用；映射口径仍只在本文件内） */
    applyServerStats,
    applyShiftProgress,
    applyServerTask,
    applyServerStandard,
    applyServerDevice,
    applyServerLink,
    applyServerUpload,
    applyServerNotices,
    applyServerFrame,
    clearUnservedModules,
    /* 键名映射表（**只读**；便于自检断言"只此一份"） */
    STATS_KEY_MAP
  };
})();
