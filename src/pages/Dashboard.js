/* ==========================================================================
   页面装配（pages/Dashboard.js）
   作用：把各组件拼成完整看板 —— 标签页切换、统一渲染、降级提示
   需求：FR-9 页面与交互（默认首页、无操作自动返回、头部常显）
   ========================================================================== */
window.Pages = window.Pages || {};
window.Pages.Dashboard = (function () {
  'use strict';

  const { $ } = window.Dom;

  /* 8 个标签页（FR-9.1） */
  const TABS = [
    { id: 'panel-status',  label: '设备状态' },
    { id: 'panel-task',    label: '任务数据' },
    { id: 'panel-shift',   label: '班次信息' },
    { id: 'panel-stats',   label: '生产统计' },
    { id: 'panel-alarm',   label: '设备异常' },
    { id: 'panel-maint',   label: '维保台账' },
    { id: 'panel-notice',  label: '公告备注' },
    { id: 'panel-setting', label: '操作设置' }
  ];
  const HOME_TAB = 0;                        // 默认首页（FR-9.2）
  /* 5 分 10 秒；须晚于 FR-8.2 的 5 分钟锁定，确保锁定先发生——审查 F-02（原 3 分钟早于锁定，回首页时解锁态仍可能有效） */
  const IDLE_RETURN_MS = 5 * 60 * 1000 + 10 * 1000;   // FR-9.4：无操作自动回默认首页（可配置）

  let idleTimer = null;

  /* ---------------- 标签页切换 ---------------- */
  function switchTab(index) {
    TABS.forEach((t, i) => $(t.id).classList.toggle('active', i === index));
    window.Components.TabsBar.setActive(index);
    resetIdleTimer();
  }

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => switchTab(HOME_TAB), IDLE_RETURN_MS);
  }

  /* ---------------- 降级提示（UI-10） ---------------- */
  function renderDegraded(state) {
    const stage = $('stage');
    const offline = state.device.link !== 'online';
    let banner = document.querySelector('.degraded-banner');
    if (offline && !banner) {
      banner = document.createElement('div');
      banner.className = 'degraded-banner';
      banner.textContent = '⚠ 上位机连接中断 · 数据已冻结（显示最后有效数据）';
      stage.appendChild(banner);
    } else if (!offline && banner) {
      banner.remove();
    }
  }

  /* ---------------- 初始化与整体渲染 ---------------- */
  function init(state) {
    window.Components.TabsBar.build(TABS, HOME_TAB, switchTab);
    window.Components.SettingPanel.bind(state, resetIdleTimer);
    window.Components.AlarmPanel.bind(state, resetIdleTimer);
    resetIdleTimer();
  }

  /* 整屏渲染的组件顺序（NFR-11：任一组件异常只跳过该组件，不影响其余组件） */
  const RENDER_ORDER = [
    ['HeaderBar', 'render'],
    ['TabsBar', 'renderLinkStatus'],
    ['DeviceStatusPanel', 'render'],
    ['TaskPanel', 'render'],
    ['ShiftPanel', 'render'],
    ['StatsPanel', 'render'],
    ['AlarmPanel', 'render'],
    ['MaintPanel', 'render'],
    ['NoticePanel', 'render'],
    ['SettingPanel', 'render']
  ];

  function renderAll(state) {
    RENDER_ORDER.forEach(([name, method]) => {
      try {
        window.Components[name][method](state);
      } catch (err) {
        /* 单组件故障降级：记录后继续渲染后续组件，保持整屏可用（NFR-11） */
        console.error(`[看板] 组件 ${name}.${method} 渲染异常，已跳过：`, err);
      }
    });
    try {
      renderDegraded(state);
    } catch (err) {
      console.error('[看板] 降级提示渲染异常，已跳过：', err);
    }
  }

  return { TABS, HOME_TAB, init, renderAll, switchTab, resetIdleTimer };
})();
