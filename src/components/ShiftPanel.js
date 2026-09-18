/* ==========================================================================
   组件：班次信息页（components/ShiftPanel.js）
   需求：生产班次时段、当班人员、当班时间进度
   ========================================================================== */
window.Components = window.Components || {};
window.Components.ShiftPanel = (function () {
  'use strict';

  const { setText, setHTML, setStyle, $ } = window.Dom;

  const ORDER = [
    { name: '早班', range: '08:00 - 16:00', key: '早班' },
    { name: '中班', range: '16:00 - 24:00', key: '中班' },
    { name: '晚班', range: '00:00 - 08:00', key: '晚班' }
  ];
  const SEQ = ['晚班', '早班', '中班'];

  /** 判断某个班次是否已经过去（用于显示"已结束 / 未开始"） */
  function isPassed(key, current) {
    return SEQ.indexOf(key) < SEQ.indexOf(current);
  }

  function render(state) {
    const sh = state.shift;

    /* 班次时段：标注已结束 / 进行中 / 未开始并显示进度 */
    setHTML('shShiftList', ORDER.map(o => {
      const on = o.key === sh.name;
      const passed = isPassed(o.key, sh.name);
      const stateText = on ? '进行中' : (passed ? '已结束' : '未开始');
      const pct = on ? sh.pct : (passed ? 100 : 0);
      return `<div class="shift-item${on ? ' on' : ''}">
        <span class="shift-name">${o.name}</span>
        <span class="shift-range mono">${o.range}</span>
        <span class="shift-state ${on ? 'accent' : 'muted'}">${stateText}</span>
        <span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span>
      </div>`;
    }).join(''));

    /* 当班人员 */
    setHTML('shStaffList', [
      ['所属班组', sh.team],
      ['在岗操作员', `${sh.operator}（工号 ${sh.operatorId}）`],
      ['当班班组长', `${sh.leader}（工号 ${sh.leaderId}）`],
      ['当前班次', `${sh.name} ${sh.range}`]
    ].map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join(''));

    /* 当班时间进度 */
    setText('shProgressPct', sh.pct.toFixed(0) + '%');
    setStyle('shProgressBar', 'width', sh.pct.toFixed(1) + '%');
    setText('shStart', sh.start);
    // 中班结束时刻是次日 00:00，显示为 24:00 更符合现场习惯
    setText('shEnd', sh.total === 8 * 3600 && sh.end === '00:00' ? '24:00' : sh.end);
    setText('shElapsed', window.Format.clock(sh.elapsed));
    setText('shRemaining', window.Format.clock(sh.total - sh.elapsed));
  }

  return { render };
})();
