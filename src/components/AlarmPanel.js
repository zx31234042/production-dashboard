/* ==========================================================================
   组件：设备异常页（components/AlarmPanel.js）
   需求：FR-5 实时故障报警、异常闭环状态、预防性预警、当班异常台账
   ========================================================================== */
window.Components = window.Components || {};
window.Components.AlarmPanel = (function () {
  'use strict';

  const { setText, setHTML, setStyle, $ } = window.Dom;
  const { esc } = window.Format;

  function render(state) {
    const a = state.alarm.active;
    const hasAlarm = !!a;
    /* 并发报警队列（FR-5.6）：active 为队首，其余为"待处理"条目 */
    const queue = state.alarm.queue || [];

    /* 有故障时整卡转为红色主题 */
    $('alarmCard').classList.toggle('normal', !hasAlarm);
    setText('alCode', hasAlarm ? a.code : '—');
    setText('alType', hasAlarm ? a.type : '当班无故障报警');
    setText('alQueueNote', queue.length > 1
      ? `并发报警队列：${queue.length} 条未闭环 · 当前展示队首（其余 ${queue.length - 1} 条按发生时间排队）`
      : '并发报警队列：无其他待处理报警');

    /* 故障简述与处理信息（处理措施取自故障字典的 action，不再写死） */
    setHTML('alDetail', (hasAlarm ? `<div class="alarm-desc">${esc(a.desc)}</div>` : '') +
      (hasAlarm ? [
        ['故障发生时间', a.time],
        ['等级', a.level || '—'],
        ['处理人', '李建国'],
        ['处理措施', a.action || '按故障字典处理建议执行']
      ].map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('') : ''));

    /* 异常闭环状态（未处理 / 处理中 / 已闭环 / 复检确认中）；色值引用 variables.css 变量 */
    setText('alState', hasAlarm ? `异常闭环状态：${a.state}` : '异常闭环状态：正常');
    setStyle('alState', 'color', !hasAlarm ? 'var(--ok)' : (a.state === '未处理' ? 'var(--err)' : 'var(--warn)'));
    setStyle('alState', 'background', !hasAlarm ? 'rgba(0,176,80,.16)'
      : (a.state === '未处理' ? 'rgba(255,0,0,.16)' : 'rgba(255,192,0,.16)'));

    /* 闭环录入按钮：仅在展示中的报警还未闭环时可用 */
    $('alHandleBtn').disabled = !hasAlarm || a.state !== '未处理';
    $('alCloseBtn').disabled = !hasAlarm;

    /* 并发报警队列明细：不覆盖、不丢失（FR-5.6） */
    const rest = queue.slice(1);
    setHTML('alQueueList', rest.length
      ? rest.map((q, i) =>
          `<div class="list-item lv-${q.level === '严重' ? 'err' : (q.level === '一般' ? 'warn' : 'info')}">` +
          `<span class="tag">${esc(q.level || '—')}</span>` +
          `<span class="body"><b class="mono">${esc(q.code)}</b> ${esc(q.type)}<br>${esc(q.desc)}</span>` +
          `<span class="meta mono">队列 ${i + 2} · ${esc(q.time)} · ${esc(q.state)}</span></div>`).join('')
      : '<div class="list-item lv-info is-empty"><span class="body empty-note">无其他待处理报警</span></div>');

    /* 预防性预警（4 类） */
    setHTML('alWarningList', state.warnings.map(w =>
      `<div class="list-item lv-${esc(w.lv)}"><span class="body"><b>${esc(w.title)}</b><br>${esc(w.detail)}</span></div>`).join(''));

    /* 当班异常台账：最新 5 条及闭环记录 */
    const tb = $('alTable').querySelector('tbody');
    tb.innerHTML = state.alarm.ledger.map(r =>
      `<tr><td class="mono">${esc(r.time)}</td><td class="mono">${esc(r.code)}</td><td>${esc(r.desc)}</td>` +
      `<td class="${r.state === '已闭环' ? 'ok' : 'warn'}">${esc(r.state)}</td></tr>`).join('');
  }

  /* ---------------- 交互绑定（闭环状态本机录入，FR-5.4/5.11） ---------------- */
  /**
   * @param {object}   state      数据状态
   * @param {Function} onActivity 有操作时回调（用于重置"无操作自动返回首页"计时）
   */
  function bind(state, onActivity) {
    const M = window.MockData;
    $('alHandleBtn').addEventListener('click', () => {
      const a = state.alarm.active;
      if (!a || a.state !== '未处理') return;
      a.state = '处理中';
      M.pushLog('异常处置', `${a.code} ${a.type} 标记为处理中`);
      render(state);
      if (onActivity) onActivity();
    });
    $('alCloseBtn').addEventListener('click', () => {
      const a = state.alarm.active;
      if (!a) return;
      const closed = M.closeActiveAlarm();
      if (closed) M.pushLog('异常闭环', `${closed.code} ${closed.type} 确认闭环（${closed.action || '按处理建议执行'}）`);
      render(state);
      if (onActivity) onActivity();
    });
  }

  return { render, bind };
})();
