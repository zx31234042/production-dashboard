/* ==========================================================================
   组件：设备异常页（components/AlarmPanel.js）
   需求：FR-5 实时故障报警、异常闭环状态、预防性预警、当班异常台账
   ========================================================================== */
window.Components = window.Components || {};
window.Components.AlarmPanel = (function () {
  'use strict';

  const { setText, setHTML, setStyle, $ } = window.Dom;

  function render(state) {
    const a = state.alarm.active;
    const hasAlarm = !!a;

    /* 有故障时整卡转为红色主题 */
    $('alarmCard').classList.toggle('normal', !hasAlarm);
    setText('alCode', hasAlarm ? a.code : '—');
    setText('alType', hasAlarm ? a.type : '当班无故障报警');

    /* 故障简述与处理信息 */
    setHTML('alDetail', (hasAlarm ? `<div class="alarm-desc">${a.desc}</div>` : '') +
      (hasAlarm ? [
        ['故障发生时间', a.time],
        ['处理人', '李建国'],
        ['处理措施', '已自动重连并复核图像，待确认闭环']
      ].map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('') : ''));

    /* 异常闭环状态（未处理 / 处理中 / 已闭环 / 复检确认中） */
    const st = $('alState');
    st.textContent = hasAlarm ? `异常闭环状态：${a.state}` : '异常闭环状态：正常';
    st.style.color = !hasAlarm ? '#00B050' : (a.state === '未处理' ? '#FF0000' : '#FFC000');
    st.style.background = !hasAlarm ? 'rgba(0,176,80,.16)'
      : (a.state === '未处理' ? 'rgba(255,0,0,.16)' : 'rgba(255,192,0,.16)');

    /* 预防性预警（4 类） */
    setHTML('alWarningList', state.warnings.map(w =>
      `<div class="list-item lv-${w.lv}"><span class="body"><b>${w.title}</b><br>${w.detail}</span></div>`).join(''));

    /* 当班异常台账：最新 5 条及闭环记录 */
    const tb = $('alTable').querySelector('tbody');
    tb.innerHTML = state.alarm.ledger.map(r =>
      `<tr><td class="mono">${r.time}</td><td class="mono">${r.code}</td><td>${r.desc}</td>` +
      `<td class="${r.state === '已闭环' ? 'ok' : 'warn'}">${r.state}</td></tr>`).join('');
  }

  return { render };
})();
