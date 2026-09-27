/* ==========================================================================
   入口（main.js）
   作用：舞台自适应、数据源接入、启动流程、定时刷新、演示快捷键
   加载顺序（见 index.html）：config → utils → services → components → pages → main
   需求：NFR-01 秒级刷新；UI-02 4K 等比缩放；FR-9 页面与交互
   数据源：
     - mock（默认）：由 services/mockData.js 产生全部数据
     - upper       ：由上位机报文经 services/api.js 适配层写入（?source=upper 可临时切换）
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

    /* 评审辅助参数：?tab= / ?link=off / ?unlock=1 / ?curve=none / ?source=upper */
    const q = new URLSearchParams(location.search);
    const tab = Number(q.get('tab'));
    if (Number.isInteger(tab) && tab >= 0 && tab < Dashboard.TABS.length) Dashboard.switchTab(tab);
    if (q.get('link') === 'off') M.toggleLink();
    const unlockByParam = q.get('unlock') === '1';
    if (unlockByParam) M.setUnlocked(true);
    if (q.get('curve') === 'none') M.clearCurve();
    if (q.get('source')) CFG.dataSource = q.get('source');   // ?source=upper 用上位机报文驱动

    /* 启动上位机数据源：mock 模式下返回 'none'，由 mockData 自行驱动 */
    sourceKind = Api.startUpper(state, () => { /* 每帧回调，渲染由下方定时器统一执行 */ });

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
      /* ① 数据推进：抛错时不吞、不静默，但**不阻断**下方两步（E34 方案①） */
      try {
        if (sourceKind === 'none') M.tick(now);
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

    /* 上报 MES：仅当配置了 MES 地址（Q-23 关闭后）才实际发送，否则为空操作 */
    if (CFG.mes.baseUrl) {
      setInterval(() => {
        /* 刷新待补传状态与告警（**不发送**；重报由人工触发的 Api.retryPending 承担），再上报本帧 */
        Api.flushPending().catch(err => console.warn('[main] 待补传状态刷新异常：' + err.message));
        Api.uploadReport(Api.buildReportPayload(state))
          .then(r => { if (!r.ok) console.warn('[main] MES 上报未成功：' + (r.reason || r.error || '回执异常')); });
      }, CFG.reportIntervalMs);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
