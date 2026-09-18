/* ==========================================================================
   组件：生产统计页（components/StatsPanel.js）
   需求：FR-4 当班任务统计 / 任务完成统计 / 质量质检统计 / 设备效率统计
   ========================================================================== */
window.Components = window.Components || {};
window.Components.StatsPanel = (function () {
  'use strict';

  const { setText } = window.Dom;
  const F = window.Format;

  function render(state) {
    const s = state.stats;

    /* 当班任务统计 */
    setText('sPlan', s.plan);
    setText('sStarted', s.started);
    setText('sNotStarted', s.notStarted);

    /* 任务完成统计 */
    setText('sDone', s.done);
    setText('sDoing', s.testing);
    setText('sTodo', s.pending);

    /* 质量质检统计 */
    setText('sQualified', s.qualified);
    setText('sUnqualified', s.unqualified);
    setText('sRecheck', s.recheck);
    setText('sFpy', s.firstPass.toFixed(1) + '%');

    /* 设备效率统计 */
    setText('sRunTime', F.clock(s.runSec));
    setText('sIdleTime', F.clock(s.idleSec));
    setText('sAvgTime', F.duration(s.avgTest));
    setText('sCapacity', s.capacity.toFixed(1) + '%');
    setText('sOee', s.oee.toFixed(1) + '%');
  }

  return { render };
})();
