/* ==========================================================================
   组件：设备状态页（components/DeviceStatusPanel.js）
   需求：FR-2 设备实时运行状态（运行模式、色标、深度与速度、设备参数、联网状态）
         FR-3.9～3.11 实测主参数；FR-3.15 两条任务曲线；FR-3.16 设备参数次要展示
         FR-2.6 / FR-3.9～3.11（V1.46 / C-116）：深度/速度＝**文件通道**（坐标 Excel 于
         **测试完成后**生成）⇒ 实时阶段标「待测试完成后更新」、**不得按实时值展示**；
         `testStatus` 与相机参数（帧率/增益/快门/相机水下深度）**仍实时**（PLC 链）。
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

  /* ==========================================================================
     `FR-2.6`（V1.46 / C-116 追注）＋ `FR-3.9～3.11`：**深度/速度改由文件通道提供** ——
     坐标 Excel 于**测试完成后**生成（参考约 30 min，**非硬性**），实时阶段**没有值**。
     故服务端模式下本页必须：
       · `depth`/`speed`/`vx`/`vy` 四个值位一律显式「—」（沿用 W4「缺失值＝—」口径；
         **不得**拿 0、演示种子值或上一帧冒充 —— FR-2.6「不得按实时值展示」）；
       · 两个说明位 `#stDepthNote`/`#stSpeedNote` **逐字**标「待测试完成后更新」；
       · 两条任务曲线在**尚无已完成件**时，图下说明位也标该文案（不画假曲线、不写 0）。
     `testStatus` 与相机参数（帧率/增益/快门/相机水下深度）**仍实时**（PLC 链）⇒ 本段只动深度/速度四项。
     ⚠ **演示模式保持改前行为**（数值照旧、说明位原文、不出现该标注 —— 以免误导）。
     ⚠ 文件通道尚未接入 ⇒ 服务端模式下本区**始终**是"待更新"；将来接入后应把判据改为
       "文件数据是否到位"，而不是仅看 `dataSource === 'server'`。
     ========================================================================== */
  const PENDING = '待测试完成后更新';

  /**
   * 是否"深度/速度＝文件通道、测试完成后才有值"（V1.46 / C-116）。
   * 判据与各组件"服务端模式"同一把尺子（`state.serverMode` 优先、退配置），并额外排除
   * "已回退演示源"（`state.sourceFallback === true` ⇒ 板面是演示值，不得再标"待更新"）。
   */
  function fileChannelPending(state) {
    if (state && state.sourceFallback === true) return false;
    if (state && state.serverMode === true) return true;
    const cfg = window.BoardConfig;
    return !!(cfg && cfg.dataSource === 'server');
  }

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

  /* ---------------- 联网状态（FR-2.6）· P1-1b 按端点 ----------------
     服务端模式：逐端点行 ＋ 汇总（`onlineCount/total`；`allOffline` 才说"整套离线"）；
     演示/上位机模式：保持改前单条文案与写入顺序**逐字节不变**（`?link=off` 的判据依赖它）。 */

  /** 是否服务端模式（`state.serverMode` 优先，退 `BoardConfig.dataSource`；与 BoardSource/SelfCheckProbe 同一口径） */
  function isServerMode(state) {
    if (state && state.serverMode === true) return true;
    const cfg = window.BoardConfig;
    return !!(cfg && cfg.dataSource === 'server');
  }

  /** 三态文案取自 `fieldMap` 的 `status.online` 映射（FR-2.6 的文案真源）；取不到才用同值兜底 */
  function linkTextOf(online) {
    const spec = window.FieldMap && window.FieldMap.upperToBoard
      ? window.FieldMap.upperToBoard['status.online'] : null;
    const map = spec && spec.map ? spec.map : null;
    const key = online === true ? 'online' : 'offline';
    return (map && map[key]) || (online === true ? '在线正常' : '离线断连');
  }

  /** 距最近接受的时长文本（**只格式化服务端给的 ageMs**，不拿本地时钟重算阈值） */
  function ageText(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return NO_DATA;
    if (ms < 1000) return '刚接受';
    if (ms < 60000) return (Math.round(ms / 100) / 10) + ' s 前';
    if (ms < 3600000) return (Math.round(ms / 6000) / 10) + ' min 前';
    return (Math.round(ms / 360000) / 10) + ' h 前';
  }

  /** ISO 时刻 → 本地 HH:MM:SS（取不到时返回空串，由调用方走占位） */
  function clockOf(iso) {
    if (!iso) return '';
    const t = new Date(iso);
    if (!t || Number.isNaN(t.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
  }

  /** 逐端点行 HTML。`data-online` 是机器可读落点（真机与假 DOM 判据都读它，不靠抠文案）。 */
  function endpointRowsHtml(list) {
    const esc = (window.Format && typeof window.Format.esc === 'function')
      ? window.Format.esc : v => String(v === null || v === undefined ? '' : v);
    return '<div class="link-eps">' + list.map(e => {
      const online = !!(e && e.online === true);
      const color = online ? 'var(--ok)' : 'var(--err)';
      const id = esc(e && e.endpointId !== undefined && e.endpointId !== null ? e.endpointId : '(unknown)');
      const at = clockOf(e && e.lastAcceptedAt);
      const frames = (e && typeof e.frames === 'number' && Number.isFinite(e.frames)) ? e.frames : null;
      const meta = '最近接受 ' + (at || NO_DATA) + ' · ' + ageText(e && e.ageMs) +
        (frames === null ? '' : ' · 累计 ' + frames + ' 帧');
      return '<div class="link-ep" data-ep="' + id + '" data-online="' + online + '">' +
        '<span class="link-ep-dot" style="background:' + color + '"></span>' +
        '<span class="link-ep-id" title="' + id + '">' + id + '</span>' +
        '<span class="link-ep-state" style="color:' + color + '">' + esc(linkTextOf(online)) + '</span>' +
        '<span class="link-ep-meta">' + esc(meta) + '</span></div>';
    }).join('') + '</div>';
  }

  /**
   * 联网状态渲染（分支边界只在这里）。
   * · 演示/上位机模式 ⇒ 改前的 5 次写入原样保留（`stLinkDot` 2 次、`stLinkText` 2 次、`stLinkNote` 1 次）；
   * · 服务端模式 ⇒ 汇总写 `#stLinkText`、逐端点行写 `#stLinkNote` 的 innerHTML。
   *   读数未到/服务端 0 端点 ⇒ **显式"读取中/尚无端点数据"**，绝不写成"整套离线"或"在线正常"。
   */
  function renderLink(state) {
    if (!isServerMode(state)) {
      const online = state.device.link === 'online';
      setStyle('stLinkDot', 'background', online ? 'var(--ok)' : 'var(--err)');
      setStyle('stLinkDot', 'boxShadow', online ? '0 0 0 8px rgba(0,176,80,.18)' : '0 0 0 8px rgba(255,0,0,.18)');
      setText('stLinkText', online ? '在线正常' : '离线断连');
      setStyle('stLinkText', 'color', online ? 'var(--ok)' : 'var(--err)');
      setText('stLinkNote', online
        ? '上位机心跳正常 · 数据延迟 0.4 s'
        : '数据已冻结 · 最后更新 ' + state.lastRefresh);
      return;
    }

    const el = state.endpointLink && typeof state.endpointLink === 'object' ? state.endpointLink : null;
    const errNote = state.endpointLinkError ? '（读数失败：' + String(state.endpointLinkError) + '）' : '';
    if (!el) {
      /* 服务端模式但还没取到读数：显式"读取中"，不伪造在线/离线 */
      setStyle('stLinkDot', 'background', 'var(--idle)');
      setStyle('stLinkDot', 'boxShadow', '0 0 0 8px rgba(128,128,128,.18)');
      setText('stLinkText', '端点链路读取中');
      setStyle('stLinkText', 'color', 'var(--muted)');
      setHTML('stLinkNote', '<div class="link-eps-head">按端点链路状态 · 正在读取 /ifd/endpoints' +
        escText(errNote) + '</div>');
      return;
    }

    const list = Array.isArray(el.endpoints) ? el.endpoints : [];
    const total = (typeof el.total === 'number' && Number.isFinite(el.total)) ? el.total : list.length;
    const onlineCount = (typeof el.onlineCount === 'number' && Number.isFinite(el.onlineCount))
      ? el.onlineCount : list.filter(e => e && e.online === true).length;
    const staleMs = (typeof el.staleMs === 'number' && Number.isFinite(el.staleMs)) ? el.staleMs : null;
    const unknownFrames = (typeof el.unknownFrames === 'number' && Number.isFinite(el.unknownFrames))
      ? el.unknownFrames : 0;
    const allOffline = el.allOffline === true && total > 0;

    let color;
    let summary;
    if (total <= 0) {
      /* 服务端确实 0 个端点（≠ 所有端点掉线）：既不是"在线正常"也不是"整套离线" */
      color = 'var(--idle)';
      summary = '尚无端点数据';
    } else if (allOffline) {
      color = 'var(--err)';
      summary = '整套离线';
    } else if (onlineCount >= total) {
      color = 'var(--ok)';
      summary = '在线正常';
    } else {
      /* 单点掉线：只陈述"部分"，**不得**出现"整套离线" */
      color = 'var(--warn)';
      summary = '部分端点离线';
    }
    const counts = total > 0 ? ' · ' + onlineCount + '/' + total + ' 端点' : '';

    setStyle('stLinkDot', 'background', color);
    setStyle('stLinkDot', 'boxShadow', color === 'var(--ok)' ? '0 0 0 8px rgba(0,176,80,.18)'
      : (color === 'var(--err)' ? '0 0 0 8px rgba(255,0,0,.18)' : '0 0 0 8px rgba(255,192,0,.18)'));
    setText('stLinkText', summary + counts);
    setStyle('stLinkText', 'color', color);
    setHTML('stLinkNote',
      '<div class="link-eps-head">按端点链路状态 · 阈值 ' + (staleMs === null ? NO_DATA : staleMs + ' ms') +
      (unknownFrames > 0 ? ' · 其中 ' + unknownFrames + ' 帧未带端点标识' : '') + escText(errNote) + '</div>' +
      endpointRowsHtml(list));
  }

  /** 文本转义（失败原因等也进 innerHTML，统一走 Format.esc） */
  function escText(v) {
    const esc = (window.Format && typeof window.Format.esc === 'function')
      ? window.Format.esc : x => String(x === null || x === undefined ? '' : x);
    return esc(v);
  }

  function render(state) {
    const s = state.status, t = state.task;

    /* P1-1b（FR-2.6 按端点）：按既有渲染节拍**触发**按端点链路的节流取数入口。
       取数本身在 `EndpointLinkProbe` 内（5 s 节流 ＋ 在途去重，**不新起定时器**）；
       演示模式立即返回（不发请求、不写 state）⇒ 演示行为不变。
       本函数只读 `state.endpointLink` 渲染（渲染层不直接 `fetch`）。 */
    if (window.EndpointLinkProbe && typeof window.EndpointLinkProbe.ensure === 'function') {
      window.EndpointLinkProbe.ensure(state, new Date());
    }

    /* 运行模式与阶段 */
    const color = MODE_COLOR[s.mode] || 'var(--idle)';
    setText('stMode', s.mode);
    setStyle('stMode', 'color', color);
    setStyle('stModeBand', 'background', color);
    setText('stStage', s.stage);

    /* 主要实测数据：航行器深度 + 航行速度（FR-3.9～3.11 / C-31、C-32）
       ⚠ 缺失值守卫（W4 / ADR-0008 D3）：`depth/speed/vx/vy` 可能是 `null`（服务端缺测帧），
         一律经 `fixedOrNoData()` 显示 `—`，**不得**直接 `.toFixed()`（null 上没有该方法 ⇒ TypeError）。
       V1.46 / C-116：服务端模式下四个值位**不是实时值**（文件通道测试完成后才生成）⇒ 一律「—」，
         说明位标「待测试完成后更新」；演示/上位机模式逐字保持改前行为。 */
    const pending = fileChannelPending(state);
    if (pending) {
      setText('stDepth', NO_DATA);
      setText('stSpeed', NO_DATA);
      setText('stVx', NO_DATA);
      setText('stVy', NO_DATA);
      setText('stDepthNote', PENDING);
      setText('stSpeedNote', PENDING);
    } else {
      setText('stDepth', fixedOrNoData(t.real.depth, 2));
      setText('stSpeed', fixedOrNoData(t.real.speed, 2));
      setText('stVx', fixedOrNoData(t.real.vx, 2));
      setText('stVy', fixedOrNoData(t.real.vy, 2));
      setText('stDepthNote', '水下深度实测值 · 上位机整合后提供');
      setText('stSpeedNote', 'X-Y 平面合成速度 · vx / vy 为分速度');
    }
    setText('stRunTime', state.stats.noData === true ? NO_DATA : window.Format.clock(state.stats.runSec || 0));

    /* 设备参数：次要展示（FR-3.16）
       `fps`/`shutter` 是整型量（无小数位），同样必须过守卫；`gain`/`cameraDepth` 为小数位量。 */
    setText('stFps', fixedOrNoData(t.real.fps, 0));
    setText('stGain', fixedOrNoData(t.real.gain, 1));
    setText('stShutter', fixedOrNoData(t.real.shutter, 0));
    setText('stCamDepth', fixedOrNoData(t.real.cameraDepth, 2));

    /* 联网状态（FR-2.6 / P1-1b）：服务端模式逐端点行＋汇总；演示/上位机模式保持改前文案 */
    renderLink(state);

    /* 5 种运行模式与色标，当前模式高亮 */
    setHTML('stLegend', MODES.map(m =>
      `<div class="legend-item${m.name === s.mode ? ' on' : ''}">` +
      `<span class="legend-dot" style="background:${m.color}"></span>${m.name}</div>`).join(''));

    /* 任务曲线：仅在任务完成后重绘整段曲线（不做秒级刷新）
       V1.46 / C-116：服务端模式下文件通道未接入 ⇒ 深度/速度曲线**本来就没有**：
       `mockData.js` 启动时预置的"上一次已完成任务"曲线是**演示种子**，不得在服务端模式冒充真实曲线
       （ADR-0008 D3「不得用演示值顶替」）⇒ 传 null 走空态，图下说明位标「待测试完成后更新」
       （不画假曲线、不写 0）。将来文件链接入后，改为传 `state.curve.*` 并把判据改为"文件数据是否到位"。 */
    const cv = state.curve || {};
    const shown = pending ? { depth: null, speed: null } : cv;
    curve().render('stDepthChart', 'stDepthTask', 'stDepthRange', shown.depth, 'var(--accent)', 'gDepth', 'm');
    curve().render('stSpeedChart', 'stSpeedTask', 'stSpeedRange', shown.speed, 'var(--ok)', 'gSpeed', 'm/s');
    if (pending) {
      setText('stDepthTask', PENDING);
      setText('stSpeedTask', PENDING);
    }
  }

  return { render };
})();
