/* ==========================================================================
   DOM 工具（utils/dom.js）
   作用：封装最常用的元素查找与文本设置，避免各组件重复写样板代码
   写法：普通脚本 + 全局命名空间（不用 ES module，保证双击 index.html 可打开）
   ========================================================================== */
window.Dom = (function () {
  'use strict';

  /** 按 id 取元素 */
  const $ = id => document.getElementById(id);

  /** 设置元素文本，值未变化时不触发重排 */
  const setText = (id, v) => {
    const e = $(id);
    if (e && e.textContent !== String(v)) e.textContent = v;
  };

  /** 设置元素内部 HTML */
  const setHTML = (id, v) => {
    const e = $(id);
    if (e) e.innerHTML = v;
  };

  /** 设置元素 class（整体替换） */
  const setClass = (id, v) => {
    const e = $(id);
    if (e) e.className = v;
  };

  /** 设置元素行内样式属性 */
  const setStyle = (id, prop, value) => {
    const e = $(id);
    if (e) e.style[prop] = value;
  };

  /** 切换元素 class */
  const toggleClass = (id, cls, on) => {
    const e = $(id);
    if (e) e.classList.toggle(cls, !!on);
  };

  return { $, setText, setHTML, setClass, setStyle, toggleClass };
})();
