/* ==========================================================================
   组件：设备状态页（components/DeviceStatusPanel.js）
   需求：FR-2 设备实时运行状态（运行模式、色标、深度与速度、设备参数、联网状态）
         FR-3.9～3.11 实测主参数；FR-3.15 两条任务曲线；FR-3.16 设备参数次要展示
   ========================================================================== */
window.Components = window.Components || {};
window.Components.DeviceStatusPanel = (function () {
  'use strict';

  const { setText, setHTML, setStyle, $ } = window.Dom;
  const curve = () => window.Components.CurveChart;

  /* 5 种运行模式与状态色标（FR-2.1、FR-2.2）
     待机=黄、测试运行=绿、正常停机/维保检修=灰、故障锁定=红
     色值统一取自 styles/variables.css（UI-03），此处只引用变量名 */
  const MODES = [
    { name: '待机',     color: 'var(--warn)' },
    { name: '测试运行', color: 'var(--ok)' },
    { name: '正常停机', color: 'var(--idle)' },
    { name: '维保检修', color: 'var(--idle)' },
    { name: '故障锁定', color: 'var(--err)' }
  ];
  const MODE_COLOR = MODES.reduce((m, x) => (m[x.name] = x.color, m), {});

  function render(state) {
    const s = state.status, t = state.task;

    /* 运行模式与阶段 */
    const color = MODE_COLOR[s.mode] || 'var(--idle)';
    setText('stMode', s.mode);
    setStyle('stMode', 'color', color);
    setStyle('stModeBand', 'background', color);
    setText('stStage', s.stage);

    /* 主要实测数据：航行器深度 + 航行速度（FR-3.9～3.11 / C-31、C-32） */
    setText('stDepth', t.real.depth.toFixed(2));
    setText('stSpeed', t.real.speed.toFixed(2));
    setText('stVx', t.real.vx.toFixed(2));
    setText('stVy', t.real.vy.toFixed(2));
    setText('stRunTime', window.Format.clock(state.stats.runSec || 0));
    setText('stDepthNote', '水下深度实测值 · 上位机整合后提供');
    setText('stSpeedNote', 'X-Y 平面合成速度 · vx / vy 为分速度');

    /* 设备参数：次要展示（FR-3.16） */
    setText('stFps', t.real.fps);
    setText('stGain', t.real.gain.toFixed(1));
    setText('stShutter', t.real.shutter);
    setText('stCamDepth', (t.real.cameraDepth === undefined ? '—' : t.real.cameraDepth.toFixed(2)));

    /* 联网状态（FR-2.6） */
    const online = state.device.link === 'online';
    setStyle('stLinkDot', 'background', online ? 'var(--ok)' : 'var(--err)');
    setStyle('stLinkDot', 'boxShadow', online ? '0 0 0 8px rgba(0,176,80,.18)' : '0 0 0 8px rgba(255,0,0,.18)');
    setText('stLinkText', online ? '在线正常' : '离线断连');
    setStyle('stLinkText', 'color', online ? 'var(--ok)' : 'var(--err)');
    setText('stLinkNote', online
      ? '上位机心跳正常 · 数据延迟 0.4 s'
      : '数据已冻结 · 最后更新 ' + state.lastRefresh);

    /* 5 种运行模式与色标，当前模式高亮 */
    setHTML('stLegend', MODES.map(m =>
      `<div class="legend-item${m.name === s.mode ? ' on' : ''}">` +
      `<span class="legend-dot" style="background:${m.color}"></span>${m.name}</div>`).join(''));

    /* 任务曲线：仅在任务完成后重绘整段曲线（不做秒级刷新） */
    curve().render('stDepthChart', 'stDepthTask', 'stDepthRange', state.curve.depth, 'var(--accent)', 'gDepth', 'm');
    curve().render('stSpeedChart', 'stSpeedTask', 'stSpeedRange', state.curve.speed, 'var(--ok)', 'gSpeed', 'm/s');
  }

  return { render };
})();
