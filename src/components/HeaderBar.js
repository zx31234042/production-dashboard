/* ==========================================================================
   组件：顶部固定信息区（components/HeaderBar.js）
   需求：FR-1 设备基础信息 / 实时时间 / 当班人员与班次（切换页面时常显）
   ========================================================================== */
window.Components = window.Components || {};
window.Components.HeaderBar = (function () {
  'use strict';

  const { setText, setClass } = window.Dom;

  /** 渲染头部区（每帧调用） */
  function render(state) {
    setText('hdrDeviceName', state.device.name);
    setText('hdrDeviceCode', state.device.code);
    setText('hdrDate', state.clock.date);
    setText('hdrWeek', state.clock.week);
    setText('hdrClock', state.clock.time);

    // 上位机联网状态标识（FR-2.6）：走 Dom 封装，值未变化时不触发重排。
    // 放在班次分支**之前**：班次配置异常不是链路故障，两者必须各报各的（E34 只影响班次那五个位）。
    const online = state.device.link === 'online';
    setText('hdrLinkBadge', online ? '上位机在线' : '上位机断连');
    setClass('hdrLinkBadge', 'chip ' + (online ? 'chip-ok' : 'chip-err'));

    /* E34（★★★，2026-09-27 负责人裁定＝方案①）：班次配置缺口时给出**显式、用户可见**的异常状态。
       数据侧仍按服务端口径**保留抛错**（`mockData.shiftOf()` 绝不静默兜底），由渲染循环
       （`src/main.js` 的 `step()`）捕获后置 `state.shiftAlert` —— 本组件只负责**呈现**：
       头屏班次位显示「班次配置异常」，其余人员/班组位显示"—"，与"上位机断连"同一类降级写法
       （复用既有节点与样式变量，不新增节点、不改 index.html）。无缺口时走下方原路径逐字不变。 */
    const shiftAlert = !!state.shiftAlert;
    /* E37（★，2026-09-27 真机验证查出）：班次徽标的 class 必须**两个分支都写**。
       改前只有缺口分支 `setClass('hdrShift','chip chip-err')`，正常分支只 `setText` ⇒
       缺口恢复自愈后**文本回来了、class 仍是 `chip chip-err`**（真机实测 className 与
       computed color 都停在红色，`index.html:32` 的初始类 `shift-badge` 再也回不来）。
       这里把 class 的**唯一真源**提成下方一条三元：正常分支恢复为「与初始一致的非错误样式」
       （`shift-badge`，逐字取自 index.html，**不改 index.html / 不改 CSS 变量**）。 */
    const shiftClass = shiftAlert ? 'chip chip-err' : 'shift-badge';
    if (shiftAlert) {
      setText('hdrShift', '班次配置异常');
      setText('hdrShiftTime', '—');
      setClass('hdrShift', shiftClass);
      setText('hdrTeam', '—');
      setText('hdrOperator', '—');
      setText('hdrLeader', '—');
      return;
    }
    setText('hdrShift', state.shift.name);
    setClass('hdrShift', shiftClass);
    setText('hdrShiftTime', state.shift.range);
    setText('hdrTeam', state.shift.team);
    setText('hdrOperator', state.shift.operator);
    setText('hdrLeader', state.shift.leader);
  }

  return { render };
})();
