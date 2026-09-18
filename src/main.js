/* ==========================================================================
   入口（main.js）
   作用：舞台自适应、启动流程、定时刷新、演示快捷键
   加载顺序（见 index.html）：utils → services → components → pages → main
   需求：NFR-01 秒级刷新；UI-02 4K 等比缩放；FR-9 页面与交互
   ========================================================================== */
(function () {
  'use strict';

  const M = window.MockData;
  const Dashboard = window.Pages.Dashboard;
  const state = M.state;
  const stage = document.getElementById('stage');

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

    /* 评审辅助参数：?tab= / ?link=off / ?unlock=1 / ?curve=none */
    const q = new URLSearchParams(location.search);
    const tab = Number(q.get('tab'));
    if (Number.isInteger(tab) && tab >= 0 && tab < Dashboard.TABS.length) Dashboard.switchTab(tab);
    if (q.get('link') === 'off') M.toggleLink();
    if (q.get('unlock') === '1') M.setUnlocked(true);
    if (q.get('curve') === 'none') M.clearCurve();

    M.tick(new Date());
    Dashboard.renderAll(state);

    setInterval(() => { M.tick(new Date()); Dashboard.renderAll(state); }, 1000);   // 秒级刷新（NFR-01）
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
