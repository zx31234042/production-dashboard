/* ==========================================================================
   组件：公告备注页（components/NoticePanel.js）
   需求：FR-7 车间公告通知、测试工艺提示、待办事项提醒
         FR-7.12（P0，T-20261002-08）**仅本机解锁后可新增/编辑/删除公告** —— 本组件负责渲染
         「编辑 / 删除」两个**入口按钮**（动作绑定在 `SettingPanel.bind()` 里，见那里的说明）。
   ------------------------------------------------------------------------------------------
   两条硬口径：
    ① **演示模式的版面与行为一字不变**（10 张截图基准 `tests/screenshots-baseline/`）：
       编辑/删除入口**只在服务端模式**渲染（判据与 `UploadPanel.serverMode()` 同一份），
       演示模式走**原来那条**拼装分支（逐字节相同，不带任何 data-* 属性）；
    ② **正文一律 `esc()` 转义**（用户输入 ⇒ `contract-check` 的"HTML 注入"断言盯着这一条），
       删除/编辑按钮上的 `id` 也走 `esc()`（它来自服务端，同样不可信）。
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

  /** 是否服务端模式（与 `UploadPanel.serverMode()` **同一判据**：状态位优先，配置兜底）。
   *  演示模式（默认 `dataSource:'mock'`）恒为 false ⇒ 入口按钮不渲染 ⇒ 版面零变化。 */
  function serverMode(state) {
    return !!(state && (state.serverMode === true ||
      ((window.BoardConfig || {}).dataSource === 'server')));
  }

  /**
   * FR-7.12 的**编辑 / 删除入口**（只有服务端模式 ＋ 该条带 `id` 时才产出；否则返回空串）。
   *
   * 「仅解锁态可用」（需求原文）在这里落成：**解锁态 → 可点；锁定态 → 渲染但 `disabled`**。
   * 为什么保留而不是隐藏：锁定后"入口还在、但点不动"比"入口凭空消失"更能说明当前状态，
   * 且与设置页其余写操作（`#noticeSave` 等 disabled）的既有切法一致。
   * @param {object} x 公告行（服务端行形状 `{id,tag,text,lv,time}`）
   * @param {boolean} unlocked 当前是否解锁
   */
  function actionsOf(x, unlocked) {
    if (!x || x.id === undefined || x.id === null) return '';
    const dis = unlocked ? '' : ' disabled';
    return `<span class="notice-acts">` +
      `<button type="button" class="btn tiny" data-notice-act="edit" data-notice-id="${esc(x.id)}"${dis}>编辑</button>` +
      `<button type="button" class="btn tiny danger" data-notice-act="delete" data-notice-id="${esc(x.id)}"${dis}>删除</button>` +
      `</span>`;
  }

  /** 服务端模式下的公告行（既有三段的**逐字**保留 ＋ 末尾追加动作入口） */
  function rowWithActions(x, unlocked) {
    return `<div class="list-item lv-${esc(x.lv)}"><span class="tag">${esc(x.tag)}</span>` +
      `<span class="body">${esc(x.text)}</span>` +
      `<span class="meta mono">${esc(x.time)}</span>` +
      actionsOf(x, unlocked) + `</div>`;
  }

  /** 演示模式下的公告行 —— **与改动前逐字节相同**（不带 data-*、不带按钮） */
  function rowPlain(x) {
    return `<div class="list-item lv-${esc(x.lv)}"><span class="tag">${esc(x.tag)}</span>` +
      `<span class="body">${esc(x.text)}</span>` +
      `<span class="meta mono">${esc(x.time)}</span></div>`;
  }

  function render(state) {
    const n = state.notices || { notices: [], tips: [], todo: [] };
    /* FR-7.12：服务端模式下渲染编辑/删除入口（演示模式：不渲染 ⇒ 版面与行为一字不变） */
    const editable = serverMode(state);
    const unlocked = !!(state && state.unlocked);
    const rowOf = x => (editable ? rowWithActions(x, unlocked) : rowPlain(x));

    /* 车间公告通知（含类型标签与发布时间）；正文为用户输入 → 必须转义后再拼 HTML */
    setHTML('ntNoticeList', (n.notices && n.notices.length)
      ? n.notices.map(rowOf).join('')
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
