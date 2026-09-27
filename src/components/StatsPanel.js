/* ==========================================================================
   组件：生产统计页（components/StatsPanel.js）
   需求：FR-4 当班任务统计 / 任务完成统计 / 质量质检统计 / 设备效率统计
   ========================================================================== */
window.Components = window.Components || {};
window.Components.StatsPanel = (function () {
  'use strict';

  const { setText } = window.Dom;
  const F = window.Format;

  /* E38（★★，2026-09-27 真机验证查出）：**"无法计算"不得显示成"零产量"**。
     缺口帧里 `state.stats` 取的是数据层的无数据快照（`MockData.noDataStats()`：同键集 + `noData:true`），
     改前渲染层照原样格式化 ⇒ `#sPlan` 空 / `undefined`、`#sFpy`/`#sOee` 显示 `0.0%`，
     把"算不出来"读成了"当班一件没干"（D8 自己都拒绝伪造当班班次、把班次位写成"—"，同口径）。
     这里只认**显式状态位**（不靠"值是不是 0"去猜 —— 真实 0 仍要显示 0）：
     `noData === true` ⇒ 一律输出"—"（该页既有占位风格，见 index.html 的 `#stDepthTask`/`#alCode`）。
     自愈后 `tick()` 重新写入带 `noData:false` 的真实统计 ⇒ 本分支自动退出、回到真实值。 */
  const NO_DATA = '—';

  function render(state) {
    const s = state.stats;
    const noData = s.noData === true;          // 显式状态位；正常帧为 false（见 mockData.computeStats）

    /* 当班任务统计 */
    setText('sPlan', noData ? NO_DATA : s.plan);
    setText('sStarted', noData ? NO_DATA : s.started);
    setText('sNotStarted', noData ? NO_DATA : s.notStarted);

    /* 任务完成统计 */
    setText('sDone', noData ? NO_DATA : s.done);
    setText('sDoing', noData ? NO_DATA : s.testing);
    setText('sTodo', noData ? NO_DATA : s.pending);

    /* 质量质检统计 */
    setText('sQualified', noData ? NO_DATA : s.qualified);
    setText('sUnqualified', noData ? NO_DATA : s.unqualified);
    setText('sRecheck', noData ? NO_DATA : s.recheck);
    setText('sFpy', noData ? NO_DATA : s.firstPass.toFixed(1) + '%');

    /* 设备效率统计 */
    setText('sRunTime', noData ? NO_DATA : F.clock(s.runSec));
    setText('sIdleTime', noData ? NO_DATA : F.clock(s.idleSec));
    setText('sAvgTime', noData ? NO_DATA : F.duration(s.avgTest));
    setText('sCapacity', noData ? NO_DATA : s.capacity.toFixed(1) + '%');
    setText('sOee', noData ? NO_DATA : s.oee.toFixed(1) + '%');
  }

  return { render };
})();
