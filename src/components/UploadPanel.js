/* ==========================================================================
   组件：UI-20 待补传清单与人工重报入口（components/UploadPanel.js）—— W5-②
   需求原文（UI-20，P0，需求 V1.38 `:572`）：
     「在设置页提供 MES 上报失败的**待补传清单**（显示**待补传条数、接口名、时间、失败原因**），
       支持操作人员**按序 / 批量触发重报**；重报动作与结果写入操作日志（与 FR-8.7 一致）；
       **不做自动重试**（与 IF-B.9 一致）」
   相关：IF-B.9（失败本地留存、人工按序补传）、NFR-10 / NFR-13（不自动重试）、AC-06
        （MES 方向由人工经 UI-20 重报、不缺失）、ADR-0008 D3（人工重报入口按需求落在设置页）。
   数据源（**全部走服务端；浏览器本地不存任何副本** —— 真源是服务端 `upload_log`）：
     · `GET  /upload/pending` 待补传清单（条数 + 明细：`uploadId`/`interface`/`createdAt`/`failReason`）
     · `GET  /upload/status`  上报状态（配置 / 队列容量 / 告警阈值 / `autoRetry:false` 的显式声明）
     · `POST /upload/retry`   **唯一**会再次发送待补传报文的入口（人工触发；服务端按 `created_at, id` 顺序）
   两个重报按钮的语义（需求原文"按序 / 批量"）：
     · **按序重报**：每次只补最旧的 1 条（`{limit:1}`）⇒ 操作人员可逐条确认、逐条看结果；
     · **批量重报**：一次补全部待补传（`{}`）⇒ 现场批量收口。
   纪律（本文件刻意不做的事）：
     · **不做自动重试**：没有任何重试定时器/退避；只有"上电时取一次 + 人工点击"两类请求。
       `startAutoRefresh()` 只做**只读**清单刷新，**从不**调用 `POST /upload/retry`
       （判据⑥的"注入时钟推进后请求次数不增加"即以此为界）。
     · **浏览器本地不留副本**：清单由服务端留存，刷新页面即从服务端读回。
     · **不改 `tests/**`、不打印 `console.error`**：网络失败一律 `console.warn` + 卡片内提示。
   渲染契约（供自检断言）：`#upPendingCount` 条数、`#upPendingBody` 明细表体、
   `#upSeqBtn` 按序重报、`#upBatchBtn` 批量重报、`#upMsg` 结果提示。
   ========================================================================== */
window.Components = window.Components || {};
window.Components.UploadPanel = (function () {
  'use strict';

  const { setText, setHTML, setClass, setStyle, $ } = window.Dom;

  /** 只读清单刷新周期（需求只要求"显示"，未规定周期；取与界面刷新同量级，避免无谓请求） */
  const REFRESH_MS = 5000;

  let booted = false;         // 交互是否已装配（装配只做一次；render 不得注册监听）
  let refreshTimer = null;    // 只读刷新定时器（**只 GET**，与重报无关）
  let refreshing = false;     // 刷新在途标志（防止重叠请求）
  let lastMsg = null;         // 最近一次操作结果（{lv, text}；由 render 呈现）
  let lastRetriedAt = 0;      // 最近一次人工重报时刻（自检可读）

  const esc = v => window.Format.esc(v);

  /** 界面文案（缺失一律显式"—"，不猜、不填 0） */
  const NO_DATA = '—';

  /** 本条记录的"时间"：服务端 `createdAt`（首次失败留存时刻）优先，退 `updatedAt` */
  function timeOf(it) {
    if (!it) return NO_DATA;
    const t = it.createdAt || it.updatedAt || it.at;
    return t ? String(t) : NO_DATA;
  }

  /** 失败原因：服务端 `failReason` 优先；没有就退响应码；都没有显式"—" */
  function reasonOf(it) {
    if (!it) return NO_DATA;
    if (it.failReason) return String(it.failReason);
    if (it.responseCode) return '响应码 ' + String(it.responseCode);
    return NO_DATA;
  }

  /** 是否处于"服务端模式"（演示模式下本卡片整体隐藏 ⇒ 不影响任何截图基准） */
  function serverMode(state) {
    return !!(state && (state.serverMode || window.BoardConfig.dataSource === 'server'));
  }

  /* ---------------- 渲染 ---------------- */

  /**
   * 渲染卡片。**只在服务端模式可见**（ADR-0008 D4：提供只在服务端模式可见的"数据源"角标，
   * 演示模式下不出现 ⇒ 不影响 10 张截图基准）。
   * @param {object} state 看板状态
   */
  function render(state) {
    const card = $('upCard');
    if (!card) return;
    const on = serverMode(state);
    card.hidden = !on;
    /* ★ 两道显式关闭一起用，保证**默认演示模式下零版面变化**：
       · `hidden`（HTML 属性）—— 静态兜底，连 CSS 都没加载时也不显示；
       · `style.display='none'` —— 行内样式，直接压过 `.card{display:flex}`（class 选择器）。
         为什么必须显式写 `display`：CSS 的 `display:none` 元素**不生成盒子、不参与布局**
         （含网格自动放置与网格轨道尺寸计算）⇒ 演示模式下 `#panel-setting` 的渲染结果与
         改动前**逐像素一致**，10 张截图基准（含 `08-操作设置`）不受影响。
         若只写 `hidden`，一旦某处的 `display` 声明覆盖了 UA 的 `[hidden]{display:none}`，
         卡片会以"空卡片"形态挤进网格，`08-操作设置` 就会漂移。 */
    if (card.style) card.style.display = on ? '' : 'none';
    /* `upCardHidden` 供自检读取（证明演示模式确实把它关掉了，不是靠"没渲染"蒙过） */
    state.upCardHidden = !on;
    if (!on) return;

    const up = (state && state.upload) || {};
    const items = Array.isArray(up.items) ? up.items : [];

    /* ① 待补传条数（需求原文点名要显示） */
    const count = up.pendingCount === null || up.pendingCount === undefined ? NO_DATA : up.pendingCount;
    setText('upPendingCount', '待补传 ' + count + ' 条');
    /* ② 容量与告警阈值：让人一眼看出"离满还有多远"（真源＝服务端 status，不在前端写死） */
    const cap = up.capacity === null || up.capacity === undefined ? NO_DATA : up.capacity;
    const warn = up.warnThreshold === null || up.warnThreshold === undefined ? NO_DATA : up.warnThreshold;
    setText('upQueueMeta', '队列容量 ' + cap + ' · 告警阈值 ' + warn +
      (up.configured === false ? ' · MES 地址未配置（重报只回报"跳过"，一条都不发）' : ''));
    /* ③ 告警位：达到阈值即亮（与 `Api.getStatus().queueAlert` / 服务端 `alert()` 同一判据） */
    const alertOn = !!(up.alert && up.alert.warn) || (typeof up.pendingCount === 'number' &&
      typeof up.warnThreshold === 'number' && up.pendingCount >= up.warnThreshold);
    setClass('upAlertBadge', 'chip ' + (alertOn ? 'chip-err' : 'chip-ok'));
    setText('upAlertBadge', alertOn ? '需人工处置' : '队列正常');

    /* ④ 明细表：**条数 / 接口名 / 时间 / 失败原因**（需求原文四项；uploadId 一并带上便于对号） */
    const rows = items.map(it =>
      '<tr data-upload-id="' + esc(it.uploadId) + '">' +
      '<td class="mono">' + esc(it.uploadId || NO_DATA) + '</td>' +
      '<td class="mono">' + esc(it.interface || NO_DATA) + '</td>' +
      '<td class="mono">' + esc(timeOf(it)) + '</td>' +
      '<td class="up-reason">' + esc(reasonOf(it)) +
      (typeof it.retryCount === 'number' && it.retryCount > 0 ? '（已重报 ' + it.retryCount + ' 次）' : '') +
      '</td></tr>').join('');
    setHTML('upPendingBody', rows);
    setText('upPendingNote', (up.itemsLoaded === false ? '清单待刷新 · ' : '') +
      '按 `created_at` 最旧优先排列 · 共 ' + items.length + ' 行（上限 ' + cap + '）');
    /* 空态：需求 UI-11 口径 —— 无数据不留空白，也不显示"0 条"以外的任何编造值 */
    const emptyEl = $('upPendingEmpty');
    if (emptyEl) emptyEl.hidden = items.length > 0;

    /* ⑤ 提示行：人工重报的动作与结果（与操作日志同一份内容摘要） */
    if (lastMsg) {
      setClass('upMsg', 'std-msg ' + (lastMsg.lv || ''));
      setText('upMsg', lastMsg.text);
    } else {
      setClass('upMsg', 'std-msg');
      setText('upMsg', '人工重报入口（**不做自动重试**）：按序＝每次补传最旧 1 条；批量＝一次补传全部待补传；' +
        '每次动作与结果都写入操作日志（FR-8.7）。');
    }
    /* ⑥ 按钮可用性：无待补传时禁用，避免"点了没反应"的静默 */
    const hasPending = typeof up.pendingCount === 'number' ? up.pendingCount > 0 : items.length > 0;
    const pending = !!refreshing;
    const seqBtn = $('upSeqBtn');
    const batchBtn = $('upBatchBtn');
    if (seqBtn) seqBtn.disabled = !hasPending || pending;
    if (batchBtn) batchBtn.disabled = !hasPending || pending;
    setStyle('upProgress', 'display', pending ? '' : 'none');
  }

  /* ---------------- 只读刷新（**从不发送重报**） ---------------- */

  /**
   * 从服务端取回待补传清单与上报状态（**只读**；ADR-0008：前端不造数、不直接向 MES 上报）。
   * 失败只 `console.warn` + 卡片提示，**绝不 `console.error`、绝不抛**。
   * @param {object} state 看板状态
   * @returns {Promise<{ok:boolean, count:number, note?:string}>}
   */
  function refreshPending(state) {
    if (refreshing) return Promise.resolve({ ok: false, count: 0, note: '刷新在途' });
    const api = window.Api;
    if (!api || typeof api.fetchPending !== 'function') {
      return Promise.resolve({ ok: false, count: 0, note: '适配层未加载 fetchPending()' });
    }
    if (typeof fetch !== 'function') {
      return Promise.resolve({ ok: false, count: 0, note: '运行环境不支持 fetch' });
    }
    refreshing = true;
    render(state);
    return api.fetchPending().then(res => {
      refreshing = false;
      if (!res || res.ok !== true) {
        const note = (res && (res.error || res.failReason)) || '未知原因';
        console.warn('[UploadPanel] 待补传清单取数失败（保留上一次清单）：' + note);
        lastMsg = { lv: 'err', text: '清单取数失败：' + note + '（重报动作未被触发；本卡片不做自动重试）' };
        render(state);
        return { ok: false, count: 0, note: note };
      }
      if (!state.upload || typeof state.upload !== 'object') state.upload = {};
      state.upload.items = Array.isArray(res.items) ? res.items : [];
      state.upload.itemsLoaded = true;
      state.upload.pendingCount = typeof res.count === 'number' ? res.count : state.upload.items.length;
      state.upload.pendingOnly = res.pendingOnly === undefined ? null : res.pendingOnly;
      state.upload.failedAfterRetry = res.failedAfterRetry === undefined ? null : res.failedAfterRetry;
      state.upload.capacity = res.capacity === undefined ? state.upload.capacity : res.capacity;
      state.upload.warnThreshold = res.warnThreshold === undefined ? state.upload.warnThreshold : res.warnThreshold;
      state.upload.alert = res.alert === undefined ? state.upload.alert : res.alert;
      state.upload.at = new Date().toISOString();
      render(state);
      return { ok: true, count: state.upload.pendingCount };
    }).catch(err => {
      refreshing = false;
      const note = (err && err.message) || String(err);
      console.warn('[UploadPanel] 待补传清单请求异常：' + note);
      lastMsg = { lv: 'err', text: '清单请求异常：' + note + '（重报动作未被触发）' };
      render(state);
      return { ok: false, count: 0, note: note };
    });
  }

  /* ---------------- 人工重报（**唯一**发送入口；只在按钮点击时发生） ---------------- */

  /**
   * 触发一次人工重报。
   * @param {object} state 看板状态
   * @param {'seq'|'batch'} mode 'seq'＝按序（只补最旧 1 条）；'batch'＝批量（补全部）
   * @returns {Promise<object>} 服务端响应（或本机失败结论）
   */
  function triggerRetry(state, mode) {
    const api = window.Api;
    const label = mode === 'batch' ? '批量重报' : '按序重报';
    if (!api || typeof api.retryPendingServer !== 'function' || typeof fetch !== 'function') {
      lastMsg = { lv: 'err', text: label + '未执行：本环境不支持服务端重报接口' };
      writeOpLog(label + '未执行', '本环境不支持服务端重报接口（未发出任何请求）');
      render(state);
      return Promise.resolve({ ok: false, error: '环境不支持' });
    }
    if (refreshing) {
      lastMsg = { lv: 'err', text: label + '未执行：上一次取数/重报仍在进行' };
      render(state);
      return Promise.resolve({ ok: false, error: '在途' });
    }
    refreshing = true;
    lastRetriedAt = Date.now();
    render(state);
    /* 按序＝只补最旧 1 条（`limit:1`，服务端按 created_at, id 顺序取）；批量＝不传限值＝全部 */
    const options = mode === 'batch' ? {} : { limit: 1 };
    return api.retryPendingServer(options).then(res => {
      refreshing = false;
      const okRes = res && res.ok === true;
      const sent = res && typeof res.sent === 'number' ? res.sent : null;
      const failed = res && typeof res.failed === 'number' ? res.failed : null;
      const remaining = res && typeof res.remaining === 'number' ? res.remaining : null;
      const skipped = !!(res && res.skipped);
      const why = (res && (res.reason || res.error || res.failReason)) || '原因未知';
      let lv = 'ok';
      let text;
      if (!okRes) {
        lv = 'err';
        text = label + '未成功：' + why;
      } else if (skipped) {
        lv = 'warn';
        text = label + '已跳过：' + why + '（一条都没发，服务端未记"成功"）';
      } else {
        text = label + '完成：发出 ' + sent + ' 条 · 仍失败 ' + failed + ' 条 · 剩余待补传 ' + remaining + ' 条';
        if (failed > 0) lv = 'warn';
      }
      lastMsg = { lv, text };
      /* FR-8.7 / NFR-15：**重报动作与结果写入操作日志**（需求原文点名要求） */
      writeOpLog(label, text + '（人工触发；本卡片不做自动重试）');
      /* 重报必然改变清单 ⇒ 立即回读服务端（"重报后清单与服务端状态一致"） */
      return refreshPending(state).then(() => ({ ok: okRes, sent, failed, remaining, skipped, reason: why }));
    }).catch(err => {
      refreshing = false;
      const note = (err && err.message) || String(err);
      lastMsg = { lv: 'err', text: label + '请求异常：' + note };
      writeOpLog(label + '异常', note);
      render(state);
      return { ok: false, error: note };
    });
  }

  /** 写操作日志（与设置页/任务页同一入口 `MockData.pushLog`；缺则只 warn，不抛） */
  function writeOpLog(action, detail) {
    const M = window.MockData;
    if (M && typeof M.pushLog === 'function') {
      M.pushLog(action, detail);
      return true;
    }
    console.warn('[UploadPanel] MockData.pushLog 不可用，重报留痕未写入操作日志');
    return false;
  }

  /* ---------------- 生命周期 ---------------- */

  /**
   * 装配交互（**只做一次**；由 `src/main.js` 在服务端模式下调用）。
   * `render()` 内**不注册监听、不写控件 value**（ui-check 的 U4 口径），
   * 故监听一律在本函数里挂。
   * @param {object} state 看板状态
   */
  function bind(state) {
    if (booted || typeof document === 'undefined' || !document.getElementById) return false;
    const seqBtn = $('upSeqBtn');
    const batchBtn = $('upBatchBtn');
    if (!seqBtn || !batchBtn || typeof seqBtn.addEventListener !== 'function') return false;
    booted = true;
    seqBtn.addEventListener('click', () => { triggerRetry(state, 'seq'); });
    batchBtn.addEventListener('click', () => { triggerRetry(state, 'batch'); });
    return true;
  }

  /**
   * 启动只读周期刷新（**只 GET `/upload/pending`**，绝不触发重报）。
   * 幂等：重复调用不叠加定时器。
   * @param {object} state 看板状态
   */
  function startAutoRefresh(state) {
    if (refreshTimer) return refreshTimer;
    bind(state);
    refreshPending(state);
    /* 防御式取定时器：受限环境（无 `setInterval` 的桩件）下不得抛，
       此时退化为"只在渲染循环里按需刷新"，界面仍可用。 */
    let timer = null;
    try {
      if (typeof setInterval === 'function') {
        timer = setInterval(() => { refreshPending(state); }, REFRESH_MS);
      } else {
        console.warn('[UploadPanel] 运行环境无 setInterval —— 待补传清单改为按需刷新（不自动重试）');
      }
    } catch (err) {
      console.warn('[UploadPanel] 周期刷新注册失败（改为按需刷新）：' + ((err && err.message) || String(err)));
    }
    refreshTimer = timer;
    return timer;
  }

  /** 停止周期刷新（回退演示源时调用：演示模式下本卡片隐藏，不该继续发请求） */
  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    return true;
  }

  /** 运行态快照（自检/回执用；**只读**） */
  function panelStatus() {
    return {
      booted,
      refreshing,
      lastRetriedAt: lastRetriedAt || null,
      autoRefresh: !!refreshTimer,
      refreshMs: REFRESH_MS,
      autoRetry: false,
      storageKeys: 'none（浏览器本地不存任何副本：清单真源＝服务端 upload_log）'
    };
  }

  return { render, bind, startAutoRefresh, stopAutoRefresh, refreshPending, triggerRetry, panelStatus, REFRESH_MS };
})();
