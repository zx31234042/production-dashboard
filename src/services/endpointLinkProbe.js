/* ==========================================================================
   按端点链路状态探测（services/endpointLinkProbe.js）—— P1-1b（FR-2.6 按端点）
   需求：FR-2.6「设备实时运行状态」里的「联网状态」要按**端点**显示（现场是多台 PLC／
        多个 IP:端口），且**单点掉线不得报成整套离线**（服务端 `endpointLink` 的
        `allOffline` 只表示"所有端点都掉线"）。
   本文件只做一件事：按既有渲染节拍**只读**取 `GET /ifd/endpoints`，把服务端结论搬到
        `state.endpointLink`；渲染层（`components/DeviceStatusPanel.js`）**只读 state、
        不自己发请求**（PROJECT_RULES 9.6 单一真源；与 `services/selfCheckProbe.js` 同款分工）。
   三条纪律：
     · **服务端模式才取数**：演示模式 `ensure()` 立即返回 `false`，一行都不写 ——
       演示模式（含 `?link=off`）的界面行为逐字节不变；
     · **不新起定时器**：调用方是渲染循环，内部按 `REFRESH_MS` 节流 ＋ 在途去重
       （节拍由 `src/main.js` 的 1 s `step()` 提供；不注册 `setInterval`）；
     · **只搬运、不重判**：`online` / `allOffline` 是服务端按 `board.config.upper.staleMs`
       算好的结论，本文件**不拿 `ageMs` 再比一次阈值**（阈值真源只有一处）。
   失败处置（ADR-0008 D4 同口径）：只 `console.warn`，**绝不 `console.error`、绝不抛**；
       失败时**保留上一次读数**（不把"没取到"写成 `0/0`），另写 `state.endpointLinkError`
       供现场排查 —— "没有这个数"（未取到）与"这个数是 0"（服务端确实 0 个端点）
       必须分得开（W4 缺值口径）。
   依赖：`services/api.js` 的 `fetchIfdEndpoints()`。零第三方依赖。
   ========================================================================== */
window.EndpointLinkProbe = (function () {
  'use strict';

  /** 取数节流周期（与自检探测同量级；FR-2.6 的"≤5 s 可察觉"由该周期 ＋ 服务端阈值共同保证） */
  const REFRESH_MS = 5000;

  let inFlight = false;
  let lastAt = 0;
  let lastResult = null;
  let probeCount = 0;
  let lastError = null;

  /** 是否服务端模式（`state.serverMode` 优先，退 `BoardConfig.dataSource`） */
  function isServerMode(state) {
    if (state && state.serverMode === true) return true;
    const cfg = window.BoardConfig;
    return !!(cfg && cfg.dataSource === 'server');
  }

  /** 失败原因文本：带可判读的失败类别（HTTP 状态码 / 网络错误），不只给一句"失败" */
  function errorText(res) {
    if (!res) return '未知原因';
    const reason = res.failReason || res.error || '';
    const code = res.responseCode === undefined || res.responseCode === null ? '' : String(res.responseCode);
    if (reason && code && code !== String(reason)) return reason + '（' + code + '）';
    return String(reason || code || '未知原因');
  }

  /**
   * 按渲染节拍调用：**服务端模式**下按 `REFRESH_MS` 刷新 `state.endpointLink`。
   * · 演示模式 ⇒ 立即返回 `false`（不写 state、不发请求）；
   * · 节流窗口内 / 已有请求在途 ⇒ 不重复发起；
   * · 结果只写 `state`：渲染层零取数即可逐端点显示（`DeviceStatusPanel.render()` 消费）。
   * @param {object} state 看板状态
   * @param {Date}   [now] 当前时刻（注入时钟；缺省 `new Date()`）
   * @returns {boolean} 本次是否**发起**了取数
   */
  function ensure(state, now) {
    if (!state || !isServerMode(state)) return false;
    const t = (now || new Date()).getTime();
    if (inFlight) return false;
    if (lastAt && t - lastAt < REFRESH_MS) return false;
    const api = window.Api;
    if (!api || typeof api.fetchIfdEndpoints !== 'function') {
      /* 适配层未加载/裁剪环境：显式记原因（不抛、不 console.error），保留上一次读数 */
      lastError = '适配层未加载 fetchIfdEndpoints()（按端点链路不可用）';
      state.endpointLinkError = lastError;
      return false;
    }
    inFlight = true;
    lastAt = t;
    probeCount++;
    api.fetchIfdEndpoints().then(res => {
      inFlight = false;
      if (!res || res.ok !== true) {
        lastError = errorText(res);
        state.endpointLinkError = lastError;
        console.warn('[EndpointLinkProbe] 按端点链路取数失败（保留上一次读数）：' + lastError);
        return;
      }
      lastError = null;
      state.endpointLinkError = null;
      const endpoints = Array.isArray(res.endpoints) ? res.endpoints : [];
      state.endpointLink = {
        at: new Date(t).toISOString(),
        staleMs: res.staleMs === undefined ? null : res.staleMs,
        total: res.total === undefined ? endpoints.length : res.total,
        onlineCount: res.onlineCount === undefined
          ? endpoints.filter(e => e.online === true).length : res.onlineCount,
        offlineCount: res.offlineCount === undefined
          ? endpoints.filter(e => e.online !== true).length : res.offlineCount,
        allOffline: res.allOffline === true,
        unknownFrames: res.unknownFrames === undefined ? null : res.unknownFrames,
        endpoints: endpoints,
        source: 'server'
      };
      lastResult = state.endpointLink;
    }).catch(err => {
      inFlight = false;
      lastError = '取数异常：' + ((err && err.message) || String(err));
      state.endpointLinkError = lastError;
      console.warn('[EndpointLinkProbe] ' + lastError + '（保留上一次读数）');
    });
    return true;
  }

  /** 只读状态（自检/回执用；**不改变任何 state**） */
  function status() {
    return {
      refreshMs: REFRESH_MS,
      inFlight: inFlight,
      lastAt: lastAt || null,
      probeCount: probeCount,
      lastError: lastError,
      endpoints: lastResult ? lastResult.endpoints.length : 0,
      onlineCount: lastResult ? lastResult.onlineCount : null
    };
  }

  /** 复位节流与在途标志（**仅供自检注入用**；不改变线上口径） */
  function reset() {
    inFlight = false;
    lastAt = 0;
    lastResult = null;
    probeCount = 0;
    lastError = null;
  }

  return { ensure: ensure, status: status, reset: reset, isServerMode: isServerMode, REFRESH_MS: REFRESH_MS };
})();
