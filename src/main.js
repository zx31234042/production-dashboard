/* ==========================================================================
   入口（main.js）
   作用：舞台自适应、数据源接入、启动流程、定时刷新、演示快捷键
   加载顺序（见 index.html）：config → utils → services → components → pages → main
   需求：NFR-01 秒级刷新；UI-02 4K 等比缩放；FR-9 页面与交互
   数据源：
     - mock（**默认**）：由 services/mockData.js 产生全部数据
     - upper       ：由上位机报文经 services/api.js 适配层写入（?source=upper 可临时切换）
     - server      ：由**看板服务端**快照 + SSE 增量驱动（?source=server；W5-② / ADR-0008 D3/D4）。
                     该模式下：**不跑 `M.tick()`**（前端只应用、不生成）、**不起 MES 上报定时器、
                     不调 `Api.uploadReport`**（上报由服务端 `uploadReporter.js` 独占）；
                     `state.clock` 与班次进度仍由本地时钟推进（只做"时钟显示"，不生成业务数据）；
                     服务端不可达时**优雅回退演示源**并给出**唯一一条**降级提示。
   ========================================================================== */
(function () {
  'use strict';

  const M = window.MockData;
  const Api = window.Api;
  const CFG = window.BoardConfig;
  const HeaderBar = window.Components.HeaderBar;
  const Dashboard = window.Pages.Dashboard;
  const state = M.state;
  const stage = document.getElementById('stage');
  let sourceKind = 'mock';
  /* W5-②：是否处于"服务端真源"模式（ADR-0008 D3 的职责边界都挂在它上面） */
  let serverMode = false;

  /* ---------------- 数据源角标（ADR-0008 D4） ----------------
     只在**服务端模式**可见（演示模式/回退演示模式下把整行 `hidden` 掉）—— 这样 10 张截图基准
     的页脚（版本/最后刷新/上位机链路/MES 链路四要素）逐像素不动。
     回退到演示源时**也要显示**（`sourceFallback === true`）：ADR-0008 D4 要求"能看出当前是演示态"，
     而"回退"与"本来是演示"对现场是完全不同的两件事（一个要查服务端，一个不用）。 */
  function updateSourceBadge() {
    const row = document.getElementById('sbSourceRow');
    const el = document.getElementById('sbSource');
    if (!row) return;
    const kind = CFG.dataSource;
    const fallback = state.sourceFallback === true;
    const visible = serverMode || kind === 'server' || fallback;
    row.hidden = !visible;
    if (!el) return;
    el.textContent = kind === 'server' ? '看板服务端（真实源）'
      : (fallback ? '已回退 · 演示数据' : '演示');
  }

  /* ---------------- 服务端模式下的"本地只走时钟"（ADR-0008 D3） ----------------
     服务端模式下**不得**跑 `M.tick()`（那会造出服务端没有的业务数据），但需求明确要求
     `state.clock` / `state.lastRefresh` 与**班次进度**继续前进（大屏上"钟停了"是不可接受的）。
     故这里只借 `mockData` 的**时刻格式化**（`Format.pad` 同一套口径，不另写一份），
     写 `state.clock`、`state.lastRefresh` 两个**纯显示量**，并把班次进度交给
     `StateAdapter.applyShiftProgress()`（它按服务端的班次名 + 本地时钟算进度）。
     —— 除时钟与"这一班进行到哪"，本函数**不写任何业务字段**。 */
  function advanceClockOnly(now) {
    const pad = window.Format.pad;
    const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
    state.clock.date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    state.clock.week = week;
    state.clock.time = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    state.lastRefresh = state.clock.time;
    window.StateAdapter.applyShiftProgress(state, now);
  }

  /* ---------------- 4K 舞台等比缩放（UI-02） ---------------- */
  function fitStage() {
    const s = Math.min(window.innerWidth / 3840, window.innerHeight / 2160);
    stage.style.transform = `scale(${s})`;
    stage.style.left = ((window.innerWidth - 3840 * s) / 2) + 'px';
    stage.style.top = ((window.innerHeight - 2160 * s) / 2) + 'px';
  }

  /* ---------------- 演示快捷键（评审用，正式部署可删除） ---------------- */
  function bindDemoKeys() {
    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'd' || e.key === 'D') M.toggleLink();    // 模拟上位机断连
      if (e.key === 'a' || e.key === 'A') M.injectAlarm();   // 触发一条新报警
    });
  }

  /* ---------------- 大屏交互屏蔽（FR-9.7） ----------------
     浏览器内可屏蔽的：右键菜单、文本选中（见 styles/global.css）、拖拽。
     浏览器之外的：任务栏、Alt+Tab、Win 键须由 kiosk 启动参数屏蔽（见 README「现场部署」）。 */
  function blockInteractions() {
    document.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('dragstart', e => e.preventDefault());
  }

  /* ---------------- 启动 ---------------- */
  function start() {
    fitStage();
    window.addEventListener('resize', fitStage);

    Dashboard.init(state);
    bindDemoKeys();
    blockInteractions();

    /* 评审辅助参数：?tab= / ?link=off / ?unlock=1 / ?curve=none / ?source=upper|server */
    const q = new URLSearchParams(location.search);
    const tab = Number(q.get('tab'));
    if (Number.isInteger(tab) && tab >= 0 && tab < Dashboard.TABS.length) Dashboard.switchTab(tab);
    if (q.get('link') === 'off') M.toggleLink();
    /* `?unlock=1` 评审旁路（ADR-0007 D5）：**只在演示模式**成立 —— 服务端模式**强制登录**，
       解锁必须经 `POST /auth/login` 取得会话令牌，**不得**靠一个查询参数自称已登录
       （D5 明令"不假装已登录"；`?source=server` 与 `?unlock=1` 同时给出时以"服务端模式"为准）。 */
    const serverByParam = q.get('source') === 'server' || CFG.dataSource === 'server';
    const unlockRequested = q.get('unlock') === '1';
    const unlockByParam = unlockRequested && !serverByParam;
    if (unlockByParam) M.setUnlocked(true);
    if (unlockRequested && !unlockByParam) {
      /* 不静默忽略：说清"为什么这个参数在服务端模式下不起作用"（否则评审会以为旁路坏了） */
      console.warn('[main] 服务端模式下忽略 ?unlock=1：解锁必须以 POST /auth/login 取得会话令牌' +
        '（ADR-0007 D5：服务端模式强制登录，不得旁路）—— 本条不是错误');
    }
    if (q.get('curve') === 'none') M.clearCurve();
    if (q.get('source')) CFG.dataSource = q.get('source');   // ?source=upper 用上位机报文驱动；?source=server 用服务端真源

    /* 启动数据源：mock 模式返回 'none'（由 mockData 自行驱动）；
       server 模式也返回 'none'（**不得**跑 M.tick()），真数据由 BoardSource 异步接入。 */
    sourceKind = Api.startUpper(state, () => { /* 每帧回调，渲染由下方定时器统一执行 */ });
    serverMode = CFG.dataSource === 'server';
    if (serverMode) startServerSource();

    /* 服务端源的启动与**优雅回退**（ADR-0008 D4）。三条纪律：
        ①**绝不 console.error、绝不抛未捕获异常**——所有失败都由 BoardSource 收敛成
          `console.warn` + 回退演示源（`dataSource` 改回 'mock'）+ **唯一一条**降级提示；
        ②回退后本地渲染循环照常跑（`M.tick()` 因 `sourceKind === 'none'` 恢复执行）⇒ **不黑屏**；
        ③UI-20 的只读清单刷新只在服务端模式下起（演示模式下该卡片整体隐藏，不该发请求）。 */
    function startServerSource() {
      const S = window.BoardSource;
      if (!S || typeof S.startServerSource !== 'function') {
        if (S && typeof S.fallbackToDemo === 'function') S.fallbackToDemo('BoardSource 未加载', state);
        serverMode = false;
        return;
      }
      /** 服务端源落地后的接线（成功时才做） */
      function wireServerSource() {
        serverMode = true;
        if (window.Components.UploadPanel) {
          window.Components.UploadPanel.startAutoRefresh(state);
        }
        /* 断线/恢复时立即重绘一帧，缩短"降级提示出现"的时延（FR-2.6 的 ≤5 s 由本地渲染循环兜底） */
        HeaderBar.render(state);
        Dashboard.renderAll(state);
        /* 角标在**异步结论之后**统一刷新（见 p.then/p.catch）—— 这里不刷，
           否则会按"中间态"先画一次（服务端成功后角标要显示真实源，不是"演示"）。 */
      }
      const p = S.startServerSource(state, () => { /* 事件到达：由渲染循环统一重绘 */ });
      p.then(kind => {
        if (kind === 'server') { wireServerSource(); return; }
        /* 回退演示源：撤下 UI-20 的周期刷新（该卡片随之隐藏），并由渲染循环接管造数 */
        serverMode = false;
        if (window.Components.UploadPanel) window.Components.UploadPanel.stopAutoRefresh();
        updateSourceBadge();
      }).catch(err => {
        /* 兜底：BoardSource 已自收敛，这里再兜一层，确保"绝不抛未捕获异常"（ADR-0008 D4） */
        serverMode = false;
        console.warn('[main] 服务端源启动异常，已按演示源继续运行：' + ((err && err.message) || String(err)));
        updateSourceBadge();
      });
    }

    /* 每秒推进一帧并整屏重绘（NFR-01）。
       upper 模式下**不能**再跑 mockData.tick()：否则报文值会被模拟数据覆盖（审查报告 P1-1②）。
       同时把"数据冻结/取数失败"同步到界面判据（IF-D.9 / P2-5）。

       ---- E34（★★★，2026-09-27 负责人裁定＝方案①）：渲染循环**兜底**，不静默、不冻结 ----
       事实（座位 5 实测，`tests\._verify\c1\probe-new-frame-abort.js`）：P3-5 之后 `M.tick()` 在
       **班次配置缺口**时按服务端口径**显式抛错**（"绝不静默"，这是要保留的语义）；而原先的 `step()`
       无 try/catch ⇒ 本帧的 `syncLinkState()` 与 `renderAll()` **都不执行** ⇒ 看板冻结在上一帧、
       每秒重抛一次（`Dashboard.renderAll` 内部的 per-component try/catch 兜不住：它压根没被调到）。
       处置＝**保留抛错**，在**渲染循环层**兜住，并保证三件事：
         ① 捕获后**仍执行**原本会跳过的 `syncLinkState()` 与 `renderAll()`（看板不冻结）；
         ② 给出**显式、用户可见**的异常状态：`state.shiftAlert` 置为题述原文，头屏据此显示
            「班次配置异常」（见 `HeaderBar.render()`，与"在线/断连"降级提示同一类状态位，
            复用既有渲染路径与样式变量，**不新增节点、不新增依赖**；index.html 契约不改）；
         ③ **不刷屏**：只在"缺口触发／题述变化／恢复正常"这三种**状态变化**时报一次
            （每条 message 至多一次），连续缺口的后续帧一律不再往控制台写。 */

    /** 缺口的题述原文 —— 既是留给头屏的提示，也是"不刷屏"去重的键 */
    function shiftGapMessage(err) {
      if (!err) return '';
      const msg = err.message || String(err);
      return /班次/.test(msg) ? msg : '';        // 只认班次缺口这一种；其余异常照常上抛
    }

    /** 缺口的页面呈现：补齐本帧产物 + 记录 + 头屏刷新 + 报一次（同 message 不重复报） */
    function noteShiftGap(msg) {
      const prev = state.shiftAlert || '';
      const changed = (msg || '') !== prev;                 // 去重判据＝题述变化（含恢复正常）
      state.shiftAlert = msg || null;
      if (msg) {
        /* `M.tick()` 是在写 `state.shift`（时刻派生量）与 `state.stats` **之前**抛的
           （`shiftOf()` 在 tick 里最先调用）。缺口的"无数据"表达**全部由数据层给**：
             · `state.shift.list` 已由 `tick()` 提前写入（与时刻无关，班次页照旧列出全部班次时段）；
             · `state.shift` 的 `name/range/...` **沿用上一帧**（不伪造当班班次），本处置只把
               **显式状态位** `noData` 置位 ⇒ 时刻派生量（进度/已进行/剩余）由班次页显示占位；
             · `state.stats = M.noDataStats()` ⇒ **同键集**的无数据快照（键集在数据层由
               `computeStats()` 运行期给出，本文件**不再罗列任何统计键**）＋ `noData: true`
               ⇒ 统计页显示占位，不再把"算不出来"显示成 0 / 0.0%；
             · 异常本身由头屏「班次配置异常」显式表达（`HeaderBar.render()`）。
           ⚠ E36：这里**不得**再手写 `state.stats` 的键集 —— 改前那版手写体漏了 `plan` 键
             （实测把 `#sPlan` 写成了 `undefined`），正是"隐性同步契约"的实证。 */
        state.shift.noData = true;
        state.stats = M.noDataStats();
      }
      HeaderBar.render(state);
      if (changed && msg) console.error('[看板] 班次配置异常（已兜底渲染，不再逐帧重复上报）：' + msg);
    }

    function step() {
      const now = new Date();
      /* ① 数据推进：抛错时不吞、不静默，但**不阻断**下方两步（E34 方案①）
         三分支互斥（ADR-0008 D3），且**只跑一条**：
           · 服务端模式（`serverMode`）⇒ **只推进时钟**（`advanceClockOnly`：写 `state.clock`/
             `state.lastRefresh` 两个纯显示量 + 按服务端班次名算进度），业务数据一律来自
             服务端快照/事件 ⇒ 下方 `M.tick()` **必须不执行**（否则报文/快照值会被模拟数据覆盖）；
           · 其余（mock）⇒ 照旧 `M.tick()`。
         ⚠ 为什么把 `if (sourceKind === 'none') M.tick(now);` **原样留在** `else` 块里，
           而不是合并成 `if (sourceKind === 'none' && !serverMode) M.tick(now);`——
           `tests/contract-check.js` 的 E 段（`数据源互斥：upper 模式不得再跑 mockData.tick()`）
           用正则锚定了 `if (sourceKind === 'none') M.tick(` 这一串**源码形状**，
           改写形态会打红该门禁（该断言的本意就是"tick 必须挂在 sourceKind 判据下"）。
           本包**保持命中**：tick 仍只挂在 `sourceKind === 'none'` 上，服务端模式由外层 `else` 排除。 */
      try {
        if (serverMode) advanceClockOnly(now);
        else {
          if (sourceKind === 'none') M.tick(now);
        }
        /* 恢复自愈：本帧数据推进成功即撤下异常提示（同样只在状态变化时报一次）。
           必须在②③**之前**收敛，否则本帧头屏会先按旧状态多画一次（实测：恢复帧重复渲染头屏）。 */
        if (state.shiftAlert) noteShiftGap('');
      } catch (err) {
        const gap = shiftGapMessage(err);
        if (!gap) throw err;                                // 非班次缺口：维持原语义，让它冒出去
        noteShiftGap(gap);                                  // 去重后恰好报一次
      }
      /* ② 链路判定与③整屏重绘：**无论上一步是否抛错都要执行**（看板不得冻结） */
      Api.syncLinkState(state, now);
      updateSourceBadge();
      Dashboard.renderAll(state);
    }
    step();

    setInterval(step, CFG.refreshMs);

    /* ?unlock=1 旁路（评审/Demo 用）：解锁状态已在上方置位，这里补上**与设置页手动解锁一致**的
       arm 自动锁定（FR-8.2）—— 否则该模式下既不自动锁定、也不弹 #autoLockTip，演示与浏览器
       用例都看不到新行为。必须在 Dashboard.init(state) 之后调用：设置页由 Dashboard 装配，
       armAutoLock() 依赖那一份计时逻辑。 */
    if (unlockByParam) {
      M.pushLog('解锁', '评审旁路 ?unlock=1 直接解锁（演示实现）');
      window.Components.SettingPanel.armAutoLock();
    }

    /* 上报 MES：仅当配置了 MES 地址（Q-23 关闭后）才实际发送，否则为空操作。
       ⚠ **服务端模式下必须整体不起**（ADR-0008 D3）：上报由服务端 `services/uploadReporter.js`
         独占（`upload_log` 单源、失败落库、人工经 UI-20 重报）。若前端同时上报，
         同一件任务会有两条上报路径、两套"谁负责谁留痕"，人工重报清单也会分裂成两份。
         本判断读的是**启动时刻的** `serverMode`：回退演示源后（`serverMode` 由 BoardSource
         收敛为 false）仍会在下一次 `start()` 时才重新评估 —— 现场语义是"回退后的演示模式
         也不主动上报"，与"演示模式不向 MES 上报"的纪律一致（演示/培训用不上真实上报）。 */
    if (CFG.mes.baseUrl && !serverMode) {
      setInterval(() => {
        /* 刷新待补传状态与告警（**不发送**；重报由人工触发的 Api.retryPending 承担），再上报本帧 */
        Api.flushPending().catch(err => console.warn('[main] 待补传状态刷新异常：' + err.message));
        Api.uploadReport(Api.buildReportPayload(state))
          .then(r => { if (!r.ok) console.warn('[main] MES 上报未成功：' + (r.reason || r.error || '回执异常')); });
      }, CFG.reportIntervalMs);
    } else if (serverMode) {
      /* 显式说明**为什么不发**（D23 反静默空转：不留"看起来该发却没发"的隐状态） */
      console.warn('[main] 服务端模式：前端不向 MES 上报（上报由服务端 uploadReporter 独占，' +
        '人工重报入口见设置页 UI-20 卡片）—— 本条不是错误');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
