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

  /* ---------------- 降级提示（UI-10） ----------------
     ⚠ F15-1（2026-09-28 复核实测的真缺陷）：本函数**不能**把"源降级横幅"当成"上位机断连横幅"。
     曾经的写法是 `document.querySelector('.degraded-banner')`，而 `services/boardSource.js`
     自建的"看板服务端不可用"横幅**也带** `degraded-banner` 类（为沿用它的位置/配色）⇒
     那条查找会命中源降级横幅；一旦链路被判为在线（当时的 `fallbackToDemo()` 还会把
     `device.link` 置 online），本函数就走 `!offline && banner ⇒ banner.remove()`，
     **把源降级提示在 1 帧内删掉**（复核实测 5 帧后两条横幅全没，页面上只剩页脚小角标）。
     现口径＝**两个不同的状态位 + 两个不同的类名**，互不误删：
       · "上位机链路断连"        ⇒ `state.device.link`（`Api.syncLinkState()` 驱动）
                                   ⇒ 本函数自建的 `.degraded-banner`；
       · "看板服务端不可用/已回退" ⇒ `state.sourceFallback`（`BoardSource` 驱动）
                                   ⇒ `boardSource.js` 自建的 `.source-fallback-banner`
                                     （它**只**由 BoardSource 的 `hideFallbackBanner()` 摘除）。
     本函数的查找因此**排除**源降级横幅（按它的专用类名精确排除；`document.querySelector`
     不支持 `:not()` 的桩件环境下也能工作）。 */
  const LINK_BANNER_EXCLUDE = 'source-fallback-banner';

  /** 取"上位机断连"横幅（**排除源降级横幅**）；桩件/真 DOM 都能用。
   *  ⚠ 当 `state.sourceFallback === true`（已回退演示源）时本函数**恒返回 null**：
   *  源降级横幅已经把"当前不可信/已降级"这件事说清楚了，再叠一条
   *  「上位机连接中断 · 数据已冻结」既是 ADR-0008 D4 禁止的"提示叠加"，**且语义是错的**
   *  —— 演示源的数据**不冻结**、照常逐秒推进（`M.tick()` 已恢复），
   *  "数据已冻结（显示最后有效数据）"那句话在回退态下不成立。
   *  若上位机**确实**断连，`state.device.link === 'offline'` 这一事实仍由头屏徽标
   *  （`HeaderBar` 的「上位机断连」）与状态页链路卡片如实呈现，不因本条而丢失。 */
  function linkBanner(state) {
    if (state && state.sourceFallback === true) return null;
    /* `querySelectorAll` 优先：它能一次拿到全部同类节点，便于逐个排除 */
    if (typeof document.querySelectorAll === 'function') {
      const found = document.querySelectorAll('.' + 'degraded-banner');
      if (found && typeof found.length === 'number' && found.length) {
        for (let i = 0; i < found.length; i++) {
          const el = found[i];
          if (!el || typeof el.className !== 'string') continue;
          if (el.className.indexOf(LINK_BANNER_EXCLUDE) >= 0) continue;   // 源降级横幅：不是本函数的
          return el;
        }
        return null;   // 只有源降级横幅 ⇒ 本函数的横幅不存在
      }
    }
    /* 退化路径（桩件可能没有 querySelectorAll）：按单选择器取，再自行排除 */
    const one = typeof document.querySelector === 'function'
      ? document.querySelector('.' + 'degraded-banner') : null;
    if (!one || typeof one.className !== 'string') return one || null;
    return one.className.indexOf(LINK_BANNER_EXCLUDE) >= 0 ? null : one;
  }

  function renderDegraded(state) {
    const stage = $('stage');
    const offline = state.device.link !== 'online';
    /* ⚠ 顺序很重要（F15-1）：
       ① **先**处理"已回退演示源"分支：它恒返回，且顺手把可能残留的**链路**横幅摘掉
          （保留源降级横幅）。若放在后面，`linkBanner()` 在回退态恒返回 null ⇒
          后面两个分支都不执行 ⇒ 旧的链路横幅会一直挂在屏上（"叠加"的来源）。
       ② 再按常规处理链路横幅的有无。 */
    if (state.sourceFallback === true) {
      removeStaleLinkBanner();
      return;
    }
    let banner = linkBanner(state);
    if (offline && !banner) {
      banner = document.createElement('div');
      banner.className = 'degraded-banner';
      banner.textContent = '⚠ 上位机连接中断 · 数据已冻结（显示最后有效数据）';
      stage.appendChild(banner);
    } else if (!offline && banner) {
      banner.remove();
    }
  }

  /** 摘掉**链路**横幅（保留源降级横幅）；无同类节点时什么都不做 */
  function removeStaleLinkBanner() {
    if (typeof document.querySelectorAll !== 'function') return;
    const all = document.querySelectorAll('.' + 'degraded-banner');
    if (!all || typeof all.length !== 'number') return;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!el || typeof el.className !== 'string') continue;
      if (el.className.indexOf(LINK_BANNER_EXCLUDE) >= 0) continue;   // 源降级横幅：留着
      if (typeof el.remove === 'function') el.remove();
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
    ['SettingPanel', 'render'],
    /* W5-②：UI-20「待补传清单与人工重报入口」卡片（**只在服务端模式可见**，组件的 render
       自己按 `state.serverMode` 切显隐 ⇒ 演示模式下不出现，10 张截图基准不受影响）。 */
    ['UploadPanel', 'render']
  ];

  function renderAll(state) {
    RENDER_ORDER.forEach(([name, method]) => {
      try {
        const comp = window.Components[name];
        /* 组件未加载 ⇒ **跳过**（不是故障）：`tests/ui-check.js`/`browser-check.js` 的夹具按
           固定组件清单装配（新组件不在其清单里），直接取值会抛 TypeError 并被下方 catch 记一条
           `console.error`，从而污染那些用例的"零 console.error"判据。这里的跳过是**静默**的，
           真故障（组件在、但 render 抛错）仍走下方 catch 并留痕。 */
        if (!comp || typeof comp[method] !== 'function') return;
        comp[method](state);
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
