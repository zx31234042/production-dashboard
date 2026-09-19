/* ==========================================================================
   组件：公告备注页（components/NoticePanel.js）
   需求：FR-7 车间公告通知、测试工艺提示、待办事项提醒
   ========================================================================== */
window.Components = window.Components || {};
window.Components.NoticePanel = (function () {
  'use strict';

  const { setHTML } = window.Dom;
  const { esc } = window.Format;

  /* UI-11：三类列表在无数据时必须给出占位文案，不得留下大片空白 */
  const EMPTY = {
    notice: '暂无车间公告',
    tip:    '暂无测试工艺提示',
    todo:   '暂无待办事项'
  };

  function emptyItem(id, text) {
    return `<div class="list-item lv-info is-empty" id="${id}">` +
           `<span class="body empty-note">${text}</span></div>`;
  }

  function render(state) {
    const n = state.notices || { notices: [], tips: [], todo: [] };

    /* 车间公告通知（含类型标签与发布时间）；正文为用户输入 → 必须转义后再拼 HTML */
    setHTML('ntNoticeList', (n.notices && n.notices.length)
      ? n.notices.map(x =>
          `<div class="list-item lv-${esc(x.lv)}"><span class="tag">${esc(x.tag)}</span>` +
          `<span class="body">${esc(x.text)}</span>` +
          `<span class="meta mono">${esc(x.time)}</span></div>`).join('')
      : emptyItem('ntNoticeEmpty', EMPTY.notice));

    /* 测试工艺提示 */
    setHTML('ntTipList', (n.tips && n.tips.length)
      ? n.tips.map(x =>
          `<div class="list-item lv-info"><span class="tag">${esc(x.tag)}</span>` +
          `<span class="body">${esc(x.text)}</span></div>`).join('')
      : emptyItem('ntTipEmpty', EMPTY.tip));

    /* 待办事项提醒（含数量） */
    setHTML('ntTodoList', (n.todo && n.todo.length)
      ? n.todo.map(x =>
          `<div class="list-item lv-${esc(x.lv)}"><span class="body">${esc(x.name)}</span>` +
          `<span class="meta mono ${esc(x.lv)}">${esc(x.value)} ${esc(x.unit)}</span></div>`).join('')
      : emptyItem('ntTodoEmpty', EMPTY.todo));
  }

  return { render };
})();
