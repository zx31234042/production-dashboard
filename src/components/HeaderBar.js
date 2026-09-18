/* ==========================================================================
   组件：顶部固定信息区（components/HeaderBar.js）
   需求：FR-1 设备基础信息 / 实时时间 / 当班人员与班次（切换页面时常显）
   ========================================================================== */
window.Components = window.Components || {};
window.Components.HeaderBar = (function () {
  'use strict';

  const { setText, setClass, $ } = window.Dom;

  /** 渲染头部区（每帧调用） */
  function render(state) {
    setText('hdrDeviceName', state.device.name);
    setText('hdrDeviceCode', state.device.code);
    setText('hdrDate', state.clock.date);
    setText('hdrWeek', state.clock.week);
    setText('hdrClock', state.clock.time);
    setText('hdrShift', state.shift.name);
    setText('hdrShiftTime', state.shift.range);
    setText('hdrTeam', state.shift.team);
    setText('hdrOperator', state.shift.operator);
    setText('hdrLeader', state.shift.leader);

    // 上位机联网状态标识（FR-2.6）
    const online = state.device.link === 'online';
    const badge = $('hdrLinkBadge');
    badge.textContent = online ? '上位机在线' : '上位机断连';
    setClass('hdrLinkBadge', 'chip ' + (online ? 'chip-ok' : 'chip-err'));
  }

  return { render };
})();
