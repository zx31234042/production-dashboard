/* ==========================================================================
   组件：维保台账页（components/MaintPanel.js）
   需求：FR-6 维保周期信息、设备累计运行、近期检修维保记录
   ========================================================================== */
window.Components = window.Components || {};
window.Components.MaintPanel = (function () {
  'use strict';

  const { setText, setHTML, setStyle, setClass, $ } = window.Dom;
  const F = window.Format;
  const { esc } = F;

  function render(state) {
    const m = state.maint;

    /* 维保周期信息 */
    setHTML('mtCycleList', [
      ['上次维保时间', m.last],
      ['计划下次维保', m.next],
      ['固定维保周期', m.cycle + ' 天']
    ].map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v mono">${v}</span></div>`).join(''));

    /* 距下次维保进度：阈值跟随配置 maintenance.warnDays（提前一半转红、到期预警转黄） */
    const warnDays = m.warnDays || 14;
    setText('mtDaysLeft', m.daysLeft + ' 天');
    const pct = Math.max(0, Math.min(100, ((m.cycle - m.daysLeft) / m.cycle) * 100));
    setStyle('mtProgressBar', 'width', pct.toFixed(1) + '%');
    setClass('mtProgressBar', 'progress-fill ' +
      (m.daysLeft <= warnDays / 2 ? 'err' : (m.daysLeft <= warnDays ? 'warn' : '')));

    /* 设备累计运行 */
    setText('mtTodayRun', F.clock(m.todayRun));
    setText('mtMonthRun', F.hours(m.monthRun));
    setText('mtYearRun', F.hours(m.yearRun));

    /* 近期检修维保记录（检修内容/责任人为用户输入 → 转义后拼 HTML） */
    const tb = $('mtTable').querySelector('tbody');
    tb.innerHTML = m.records.map(r =>
      `<tr><td class="mono">${esc(r.time)}</td><td>${esc(r.content)}</td><td>${esc(r.owner)}</td>` +
      `<td class="${r.state === '已验收' ? 'ok' : 'warn'}">${esc(r.state)}</td></tr>`).join('');
  }

  return { render };
})();
