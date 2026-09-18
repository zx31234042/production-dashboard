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

  /* ---------------- 启动 ---------------- */
  function start() {
    fitStage();
    window.addEventListener('resize', fitStage);

    Dashboard.init(state);
    bindDemoKeys();

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

    M.tick(new Date());
    Dashboard.renderAll(state);

    setInterval(() => { M.tick(new Date()); Dashboard.renderAll(state); }, CFG.refreshMs);   // 秒级刷新（NFR-01）

    /* 上报 MES：仅当配置了 MES 地址（Q-23 关闭后）才实际发送，否则为空操作 */
    if (CFG.mes.baseUrl) {
      setInterval(() => {
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
