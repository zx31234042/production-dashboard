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

  /* E39（★★，2026-09-27）：**"无法计算"不得显示成"零运行"**（E38 的同族残留）。
     缺口帧里 `state.stats` 取的是数据层的无数据快照（`MockData.noDataStats()`：同键集 + `noData:true`，
     逐键值均为 0），改前此处写 `state.stats.runSec || 0` ⇒ `#stRunTime` 显示 `00:00:00`，
     把"时刻无法归属、算不出运行时长"读成了"本班一秒都没运行"（D8 自己都拒绝伪造当班班次、
     把班次位写成"—"，同口径）。
     这里只认**显式状态位**（不靠"值是不是 0"去猜 —— 真实 0 仍要显示 `00:00:00`）：
     `noData === true` ⇒ 输出"—"（该页既有占位风格，见 `#stCamDepth` 与统计页 15 位）。
     自愈后 `tick()` 重新写入带 `noData:false` 的真实统计 ⇒ 本分支自动退出、回到真实时长。 */
  const NO_DATA = '—';

  /**
   * 缺失值口径（W4 / ADR-0008 D3，2026-09-28 收口）：数值缺失一律显示**显式无数据 `—`**，
   * **绝不 `.toFixed()` 一个 `null`**（那会抛 `TypeError: Cannot read properties of null`），
   * 也**绝不**把 `null` 显示成 `0.00`（`0` 是合法实测值，两者必须分得开）。
   * 判据＝`Number.isFinite`，`undefined` / `null` / `NaN` 一律走占位。
   * 服务端模式下这些位来自 `snapshot.frame`（缺测字段**按报文原样缺省**，不编造）⇒ 本守卫是必需项。
   * ⚠ `digits === 0` 时按**原样**输出（与改前 `setText('stFps', t.real.fps)` 的文本逐字一致：
   *   整型量不补小数位），其余按固定小数位输出。
   * @param {*} v 原始值
   * @param {number} digits 小数位
   * @returns {string} 数值文本或 `—`
   */
  function fixedOrNoData(v, digits) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return NO_DATA;
    return digits > 0 ? v.toFixed(digits) : String(v);
  }

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

    /* 主要实测数据：航行器深度 + 航行速度（FR-3.9～3.11 / C-31、C-32）
       ⚠ 缺失值守卫（W4 / ADR-0008 D3）：`depth/speed/vx/vy` 可能是 `null`（服务端缺测帧），
         一律经 `fixedOrNoData()` 显示 `—`，**不得**直接 `.toFixed()`（null 上没有该方法 ⇒ TypeError）。 */
    setText('stDepth', fixedOrNoData(t.real.depth, 2));
    setText('stSpeed', fixedOrNoData(t.real.speed, 2));
    setText('stVx', fixedOrNoData(t.real.vx, 2));
    setText('stVy', fixedOrNoData(t.real.vy, 2));
    setText('stRunTime', state.stats.noData === true ? NO_DATA : window.Format.clock(state.stats.runSec || 0));
    setText('stDepthNote', '水下深度实测值 · 上位机整合后提供');
    setText('stSpeedNote', 'X-Y 平面合成速度 · vx / vy 为分速度');

    /* 设备参数：次要展示（FR-3.16）
       `fps`/`shutter` 是整型量（无小数位），同样必须过守卫；`gain`/`cameraDepth` 为小数位量。 */
    setText('stFps', fixedOrNoData(t.real.fps, 0));
    setText('stGain', fixedOrNoData(t.real.gain, 1));
    setText('stShutter', fixedOrNoData(t.real.shutter, 0));
    setText('stCamDepth', fixedOrNoData(t.real.cameraDepth, 2));

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
