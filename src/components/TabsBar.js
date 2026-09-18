/* ==========================================================================
   组件：底部标签栏与链路状态（components/TabsBar.js）
   需求：FR-9.1～FR-9.3 8 个标签页；状态区显示版本、最后刷新、上位机链路、MES 链路
   ========================================================================== */
window.Components = window.Components || {};
window.Components.TabsBar = (function () {
  'use strict';

  const { setText, setClass, $ } = window.Dom;

  /**
   * 生成标签按钮并绑定点击
   * @param {Array}  tabs      标签定义 [{ id, label }]
   * @param {number} homeIndex 默认页序号
   * @param {Function} onSelect 点击回调 (index) => void
   */
  function build(tabs, homeIndex, onSelect) {
    const nav = $('board-tabs');
    nav.innerHTML = tabs.map((t, i) =>
      `<button class="tab-btn${i === homeIndex ? ' active' : ''}" data-idx="${i}">${t.label}</button>`
    ).join('');
    nav.addEventListener('click', e => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      onSelect(Number(btn.dataset.idx));
    });
  }

  /** 高亮当前标签 */
  function setActive(index) {
    document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === index));
  }

  /** 渲染右下角状态区（FR-2.6 链路状态、UI-17 版本与刷新时间） */
  function renderLinkStatus(state) {
    setText('sbRefresh', state.lastRefresh);

    const online = state.device.link === 'online';
    setText('sbHeartbeat', online ? '正常' : '中断');
    setClass('sbHeartbeat', 'mono ' + (online ? 'ok' : 'err'));

    // MES 链路（C-29：MES 服务器与看板主机直连）
    const mes = state.device.mes === 'online';
    if ($('sbMes')) {
      setText('sbMes', mes ? '正常' : '异常');
      setClass('sbMes', 'mono ' + (mes ? 'ok' : 'err'));
    }
  }

  return { build, setActive, renderLinkStatus };
})();
