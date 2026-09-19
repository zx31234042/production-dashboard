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
    if (q.get('unlock') === '1') M.setUnlocked(true);
    if (q.get('curve') === 'none') M.clearCurve();
    if (q.get('source')) CFG.dataSource = q.get('source');   // ?source=upper 用上位机报文驱动

    /* 启动上位机数据源：mock 模式下返回 'none'，由 mockData 自行驱动 */
    sourceKind = Api.startUpper(state, () => { /* 每帧回调，渲染由下方定时器统一执行 */ });

    /* 每秒推进一帧并整屏重绘（NFR-01）。
       upper 模式下**不能**再跑 mockData.tick()：否则报文值会被模拟数据覆盖（审查报告 P1-1②）。
       同时把"数据冻结/取数失败"同步到界面判据（IF-D.9 / P2-5）。 */
    function step() {
      if (sourceKind === 'none') M.tick(new Date());
      Api.syncLinkState(state, new Date());
      Dashboard.renderAll(state);
    }
    step();

    setInterval(step, CFG.refreshMs);

    /* 上报 MES：仅当配置了 MES 地址（Q-23 关闭后）才实际发送，否则为空操作 */
    if (CFG.mes.baseUrl) {
      setInterval(() => {
        /* 先补传历史失败报文（IF-B.9，P1-2），再上报本帧 */
        Api.flushPending().catch(err => console.warn('[main] MES 补传异常：' + err.message));
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
