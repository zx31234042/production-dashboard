/* ==========================================================================
   组件：任务曲线图表（components/CurveChart.js）
   需求：FR-3.15 / UI-19 —— 按每次测试任务完成更新一次，绘制该任务的完整曲线；
        无已完成任务时显示空态（坐标网格框架 + 提示文案）
   实现要点：曲线对象未变化时直接返回，因此不会随秒级数据刷新而重绘
   ========================================================================== */
window.Components = window.Components || {};
window.Components.CurveChart = (function () {
  'use strict';

  const { $, setText } = window.Dom;

  /* 记录每个图表上次绘制的曲线对象，用于判断是否需要重绘 */
  const rendered = {};

  /** 绘制坐标网格框架（空态与有数据时都会先画框架）
      颜色一律取自 styles/variables.css 的 CSS 变量，避免色值在 JS 里重复维护 */
  function drawFrame() {
    const W = 800, H = 240, PAD_T = 16, PAD_B = 16;
    let frame = '';
    for (let i = 0; i <= 4; i++) {
      const y = PAD_T + (H - PAD_T - PAD_B) * (i / 4);
      frame += `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" ` +
               `style="stroke:var(--grid);stroke-width:1;stroke-dasharray:8 10" ` +
               `vector-effect="non-scaling-stroke"/>`;
    }
    return { frame, W, H, PAD_T, PAD_B };
  }

  /** 绘制整段任务曲线；curve 为空时只画框架并返回 null */
  function draw(svg, curve, color, gid) {
    const { frame, W, H, PAD_T, PAD_B } = drawFrame();
    if (!curve || !curve.values || curve.values.length < 2) {
      svg.innerHTML = frame;
      return null;
    }
    const v = curve.values;
    const pad = (curve.hi - curve.lo) * 0.18 || 0.1;
    const lo2 = curve.lo - pad, hi2 = curve.hi + pad, span = hi2 - lo2;
    const x = i => (i / (v.length - 1)) * W;
    const y = val => (H - PAD_B) - ((val - lo2) / span) * (H - PAD_T - PAD_B);
    const pts = v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
    const area = `${x(0).toFixed(1)},${H - PAD_B} ${pts} ${x(v.length - 1).toFixed(1)},${H - PAD_B}`;

    svg.innerHTML =
      `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" style="stop-color:${color};stop-opacity:0.34"/>` +
      `<stop offset="100%" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>` +
      frame +
      `<polygon points="${area}" fill="url(#${gid})"/>` +
      `<polyline points="${pts}" ` +
      `style="fill:none;stroke:${color};stroke-width:4;stroke-linejoin:round;stroke-linecap:round" ` +
      `vector-effect="non-scaling-stroke"/>`;
    return curve;
  }

  /**
   * 渲染一个曲线图
   * @param {string} svgId   曲线 SVG 元素 id
   * @param {string} taskId  图下"件号/采样点/时长"元素 id
   * @param {string} rangeId 图下"量程"元素 id
   * @param {object} curve   曲线对象（state.curve.depth / state.curve.speed）
   * @param {string} color   主色（CSS 变量引用，如 var(--accent)；色值只在 variables.css 维护）
   * @param {string} gid     渐变 id
   * @param {string} unit    单位（m / m/s）
   */
  function render(svgId, taskId, rangeId, curve, color, gid, unit) {
    if (rendered[svgId] === curve) return;   // 仅在任务完成后（对象变化）重绘
    rendered[svgId] = curve;

    const svg = $(svgId);
    const meta = draw(svg, curve, color, gid);
    if (svg.parentElement) svg.parentElement.classList.toggle('has-data', !!meta);

    if (meta) {
      setText(taskId, `第 ${meta.unitIndex} 件 · ${meta.sampleCount} 采样点 · ${meta.durationSec} s`);
      setText(rangeId, `量程 ${meta.lo.toFixed(2)} – ${meta.hi.toFixed(2)} ${unit}`);
    } else {
      setText(taskId, '—');
      setText(rangeId, '—');
    }
  }

  return { render, draw };
})();
