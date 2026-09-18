/* ==========================================================================
   组件：公告备注页（components/NoticePanel.js）
   需求：FR-7 车间公告通知、测试工艺提示、待办事项提醒
   ========================================================================== */
window.Components = window.Components || {};
window.Components.NoticePanel = (function () {
  'use strict';

  const { setHTML } = window.Dom;

  function render(state) {
    const n = state.notices;

    /* 车间公告通知（含类型标签与发布时间） */
    setHTML('ntNoticeList', n.notices.map(x =>
      `<div class="list-item lv-${x.lv}"><span class="tag">${x.tag}</span>` +
      `<span class="body">${x.text}</span><span class="meta mono">${x.time}</span></div>`).join(''));

    /* 测试工艺提示 */
    setHTML('ntTipList', n.tips.map(x =>
      `<div class="list-item lv-info"><span class="tag">${x.tag}</span>` +
      `<span class="body">${x.text}</span></div>`).join(''));

    /* 待办事项提醒（含数量） */
    setHTML('ntTodoList', n.todo.map(x =>
      `<div class="list-item lv-${x.lv}"><span class="body">${x.name}</span>` +
      `<span class="meta mono ${x.lv}">${x.value} ${x.unit}</span></div>`).join(''));
  }

  return { render };
})();
