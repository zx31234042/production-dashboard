/* ==========================================================================
   组件：班次信息页（components/ShiftPanel.js）
   需求：生产班次时段、当班人员、当班时间进度
   ========================================================================== */
window.Components = window.Components || {};
window.Components.ShiftPanel = (function () {
  'use strict';

  const { setText, setHTML, setStyle } = window.Dom;
  const { pad } = window.Format;

  /* 班次列表来自配置（state.shift.list ← board.config.shift.list），不在组件里写死；
     展示顺序按开始时刻升序，start=0 的班次视为当日时序末尾（00:00 属"次日 0 点"段） */
  function shiftRows(list) {
    return (list || []).map(s => ({
      key: s.name,
      sort: s.start === 0 ? 24 : s.start,
      range: `${pad(s.start)}:00 - ${s.end === 24 ? '24:00' : pad(s.end) + ':00'}`
    })).sort((a, b) => a.sort - b.sort);
  }

  /** 判断某个班次是否已经过去（按配置顺序＝当日时序） */
  function isPassed(key, current, seq) {
    return seq.indexOf(key) < seq.indexOf(current);
  }

  function render(state) {
    const sh = state.shift;
    const rows = shiftRows(sh.list);
    const seq = (sh.list || []).map(s => s.name);

    /* 班次时段：标注已结束 / 进行中 / 未开始并显示进度 */
    setHTML('shShiftList', rows.map(o => {
      const on = o.key === sh.name;
      const passed = isPassed(o.key, sh.name, seq);
      const stateText = on ? '进行中' : (passed ? '已结束' : '未开始');
      const pct = on ? sh.pct : (passed ? 100 : 0);
      return `<div class="shift-item${on ? ' on' : ''}">
        <span class="shift-name">${o.key}</span>
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
