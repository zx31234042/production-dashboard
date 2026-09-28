/* ==========================================================================
   服务端数据源（services/boardSource.js）—— W5-②（前端切真实源，ADR-0008 D1/D2/D4）
   作用：把看板从"演示造数"切到"服务端真源"，并保证**任何失败都不影响现场可用性**。
   形态（ADR-0008 D1/D2）：
     · **同源优先**：服务端托管静态页时 `baseUrl = ''`（相对路径），无 CORS、无预检；
     · `file://` 双击：回退到 `http://127.0.0.1:8787`（服务端 `cors.js` **仅在回环绑定时**
       才放行 `Origin: null`）。
   取数顺序（一步都不能少，顺序也不能换）：
     ① `GET /state` 拿**首帧全量快照**（HTTP 非 2xx / 网络异常 / JSON 解析失败 ⇒ 优雅回退）；
     ② 首帧成功后 `new EventSource(<base>/events)` 消费增量；服务端自带 `retry: 3000`
        ⇒ 重连由浏览器负责（不自己写重连定时器，避免两套重连节奏）。
   失败路径的**统一处置**（ADR-0008 D4；与 E34/E38/E39 的"显式降级"同一口径）：
     · **只 `console.warn`，绝不 `console.error`、绝不抛未捕获异常**；
     · 回退到演示源（`dataSource` 改回 `'mock'`）⇒ 主循环的 `sourceKind === 'none'` 分支
       自然开始 `M.tick()`，界面**不黑屏**；
     · 降级提示**只出现一条**（本文件自建的 `#sourceFallbackBanner`），**不与**既有的
       `.degraded-banner`（UI-10 上位机断连）叠加 —— 两条同屏会让人分不清是"服务端没起来"
       还是"上位机断链"。
   与演示源的边界：本文件**不跑** `MockData.tick()`（那是 `src/main.js` 的职责），
   只负责"取/退"，故不会出现两处都在推进数据的情形。
   依赖：`services/api.js`（网络出口）、`services/stateAdapter.js`（形状翻译）、
        `config/board.config.js` 的 `board` 段。**零第三方依赖。**
   ========================================================================== */
window.BoardSource = (function () {
  'use strict';

  /** 降级提示的 DOM 契约（F15-1 定稿口径）。
   *
   *  ⚠ **类名必须与 UI-10 的链路横幅可区分**（F15-1）：`Dashboard.renderDegraded()` 用
   *  `document.querySelector('.degraded-banner')` 找"上位机断连"横幅，并在链路恢复时
   *  `banner.remove()`。若本文件的横幅也带 `degraded-banner`，它就会被那条查找命中，
   *  进而被误删（复核实测：回退后 1 帧内两条横幅全没，"降级提示"等于不存在）。
   *  故类名这样分：
   *   · `QUERY_CLASS` = `source-fallback-banner` —— **本横幅的专用类**：本文件的查找/去重、
   *     以及 `renderDegraded()` 的"排除"判据，都用它；
   *   · `BASE_CLASS` = `degraded-banner` —— **只为沿用既有位置/配色**（`styles/global.css`
   *     不在本包可改边界内，见 F15 边界；`.degraded-banner` 那条规则同时提供
   *     `position/left/transform/bottom/z-index/padding/圆角/黄底`）。
   *   · 最终 `className = BASE_CLASS + ' ' + QUERY_CLASS`，而 `renderDegraded()` 只给
   *     **它自己的**那条横幅加 `QUERY_CLASS` 之外的第三个类（见下），从而互不误删。
   *
   *  ⚠ `className` 含**两个** class 名，故"按 class 查一遍"时必须用其中的**单个**类名
   *  （`QUERY_CLASS`）：`querySelector('.source-fallback-banner ')` 之类拼错、或写成
   *  `'.' + className`（含空格）都是**非法选择器**，真浏览器会抛 `SyntaxError`、
   *  桩件则永远查不到 ⇒ "复用已有横幅"这条防线失效、每次回退都新插一条。
   *  这是 2026-09-28 用桩浏览器压"优雅回退"时查出的真实缺陷，已修。 */
  const BANNER_ID = 'sourceFallbackBanner';
  const BASE_CLASS = 'degraded-banner';
  const QUERY_CLASS = 'source-fallback-banner';
  /** 写入节点的完整 class（两者都要：前者给样式，后者给"可被本文件与渲染层区分"的身份） */
  const BANNER_CLASS = BASE_CLASS + ' ' + QUERY_CLASS;

  /** 运行态（模块内单例：同一页面只可能有一个服务端连接） */
  let es = null;              // EventSource 实例
  let started = false;        // 是否已成功建立过服务端连接（"成功过"才允许在断线时谈"恢复"）
  let lastEventAt = 0;        // 最近一次收到服务端事件的时刻（自检/回执用）
  let lastErrorNote = '';     // 最近一次失败原因（人类可读；只进 console.warn 与角标）
  let counters = { snapshotOk: 0, snapshotFail: 0, events: 0, errors: 0, fallbacks: 0 };

  /** 关掉 EventSource（幂等；`close()` 后浏览器不再重连） */
  function closeStream() {
    if (es) {
      try { es.close(); } catch (e) { /* 已关闭/环境不支持：忽略 */ }
      es = null;
    }
  }

  /* ---------------- 降级横幅（唯一一条） ---------------- */

  /**
   * 显示降级提示。**同屏只允许一条**（ADR-0008 D4）：
   * 先按 id 复用，再按 class 查一遍 —— 万一别的路径已插过同款横幅，就复用它而不是再插一条。
   *
   * ⚠ **复用前必须先确认它"真的挂在文档里"**（F15-1 修复的第二半）：
   * `hideFallbackBanner()` 会把节点 `remove()` 掉，但**移除后节点对象仍以同一个 id 留在
   * `document.getElementById()` 的应答里**（真 DOM 里 detached 节点也确实还能被"变量引用"，
   * 只是不再出现在 `document.querySelector('#'+id)` 的结果里；而**桩件**的 `getElementById`
   * 按 id 缓存，照样把它还回来）。若直接复用这个"游离节点"，就会 `textContent = …` 写在一个
   * 不在 DOM 里的节点上 ⇒ **横幅永远不会出现在屏上**（实测：接口回退后横幅 0 条，
   * 页面上只剩页脚角标）。故这里显式判一次"是否已插入"：`isConnected` 优先（真 DOM），
   * 退化用 `parentNode`；两样都拿不到时按"未插入"处理并新建，宁可多建也不把提示丢掉。
   * @param {string} text 提示文案
   */
  function showFallbackBanner(text) {
    if (typeof document === 'undefined') return null;
    const stage = document.getElementById ? document.getElementById('stage') : null;
    if (!stage || typeof stage.appendChild !== 'function') return null;
    /** 节点是否已插入文档：`isConnected`（真 DOM）→ `parentNode` → 保守判"未插入" */
    const isGrafted = el => {
      if (!el || typeof el !== 'object') return false;
      if (typeof el.isConnected === 'boolean') return el.isConnected;
      return !!(el.parentNode || el.__parent);
    };
    let el = document.getElementById ? document.getElementById(BANNER_ID) : null;
    if (el && !isGrafted(el)) {
      /* 拿到的是一条已从文档摘掉的游离节点：先让它别再以这个 id 被查回来，再走新建 */
      if (typeof el.remove === 'function') { try { el.remove(); } catch (e) { /* 已摘掉 */ } }
      el = null;
    }
    if (!el && document.querySelector) el = document.querySelector('.' + QUERY_CLASS);
    if (el && !isGrafted(el)) el = null;
    if (!el) {
      if (typeof document.createElement !== 'function') return null;
      el = document.createElement('div');
      el.id = BANNER_ID;
      el.className = BANNER_CLASS;
      stage.appendChild(el);
    }
    if ('textContent' in el) el.textContent = text;
    return el;
  }

  /** 隐藏降级提示（幂等；节点不存在时什么都不做） */
  function hideFallbackBanner() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById ? document.getElementById(BANNER_ID) : null;
    if (el && typeof el.remove === 'function') el.remove();
  }

  /* ---------------- 地址与能力检测 ---------------- */

  /**
   * 解析服务端基地址（ADR-0008 D1/D2）。
   * · 页面来自 `file://`（`location.protocol === 'file:'`）⇒ 用配置的 `board.baseUrl`
   *   （默认 `http://127.0.0.1:8787`）；
   * · 其余情况（同源托管）⇒ 优先用配置里的相对/绝对地址；配置为空则用**空串**（相对路径）。
   * @returns {string} 末尾无 `/` 的基地址（可为空串）
   */
  function resolveBaseUrl() {
    const cfg = (window.BoardConfig && window.BoardConfig.board) || {};
    const configured = typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '';
    const loc = (typeof location !== 'undefined' && location) ? location : null;
    const isFile = !!loc && loc.protocol === 'file:';
    if (isFile) {
      return (configured || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    }
    return configured.replace(/\/+$/, '');
  }

  /** 能力检测：`fetch` / `EventSource` 是否可用（vm 夹具与老浏览器可能都没有） */
  function capability() {
    return {
      fetch: typeof fetch === 'function',
      eventSource: typeof EventSource !== 'undefined' && EventSource !== null
    };
  }

  /* ---------------- 回退到演示源 ---------------- */

  /**
   * 优雅回退到演示源（ADR-0008 D4）。**绝不 `console.error`、绝不抛**。
   * 语义：①关掉服务端连接；②把 `dataSource` 改回 `'mock'`（于是 `main.js` 的
   * `Api.startUpper()` 返回 `'none'`、渲染循环恢复 `M.tick()`）；③显示**唯一一条**降级提示；
   * ④`console.warn` 留痕（不静默）。
   * @param {string} reason 人类可读的失败原因（进提示与 warn）
   * @param {object} [state] 看板状态（可省；给了就把"数据源"状态位写清楚）
   * @returns {boolean} 恒为 true（调用方据此继续走演示源；不抛也不返回空）
   */
  function fallbackToDemo(reason, state) {
    const why = reason ? String(reason) : '未给出原因';
    lastErrorNote = why;
    counters.fallbacks++;
    closeStream();
    const cfg = window.BoardConfig;
    if (cfg) cfg.dataSource = 'mock';
    if (state) {
      state.sourceMode = 'mock';
      state.sourceFallback = true;
      state.sourceFallbackReason = why;
      /* ⚠ **不要**在这里改 `state.device.link`（F15-1 教训，2026-09-28 复核实测）：
         曾经的写法是"顺带把接口位恢复成 online，免得渲染层再插一条上位机断连横幅"，
         但 `Dashboard.renderDegraded()` 用 `document.querySelector('.degraded-banner')` 找横幅，
         而本函数的降级横幅 className 里**本来含** `degraded-banner` ⇒ 被它命中；
         `device.link` 一旦置 online，同一次 `renderAll` 就走
         `!offline && banner ⇒ banner.remove()`，**把源降级提示在 1 帧内删掉**
         （复核在真启动路径实测：5 帧后 `removeLog=[degraded-banner, sourceFallbackBanner]`，
          两条全没，页面上只剩页脚小角标 —— 降级提示等于不存在）。
         正确做法是**两个不同的状态位 + 两个不同的类名**：
           · "上位机链路断连" ⇒ `state.device.link`（由 `Api.syncLinkState()` 驱动）
             ⇒ `renderDegraded()` 的 `.degraded-banner`；
           · "看板服务端不可用、已回退演示源" ⇒ `state.sourceFallback`（由本函数驱动）
             ⇒ 本文件自建的 `#sourceFallbackBanner.degraded-banner.source-fallback-banner`。
         两者互不干扰、也不会互相删（见 `pages/Dashboard.js` 里 `renderDegraded()` 的类名口径）。
         链路状态**保持原值不动**：回退后 `CFG.dataSource` 已变回 `'mock'`，
         `Api.syncLinkState()` 在 mock 模式下**不介入**（`device.link` 由演示键 D 控制）
         —— 也就是说"回退到演示源之后链路不再被判定"是有意的：演示数据不冻结，
         此时再去判"数据冻结"没有依据。若上位机**确实**断连，由演示键 D 或后续
         服务端模式下的 `serverLink` 表达，不由本函数代劳。 */
    }
    showFallbackBanner('⚠ 看板服务端不可用（' + why + '）· 已回退演示数据源（界面仍可用，数据为演示值）');
    /* ★ 立刻重绘一帧（F15-1 的收尾）：`showFallbackBanner()` 刚把源降级横幅插上，而此刻
       屏上**可能还挂着**上一条"上位机断连"链路横幅（它由 `Dashboard.renderDegraded()` 在
       回退之前的那一帧插的）。若等到渲染循环的下一跳（最多 1 s）才清，用户会看到**两条横幅
       短暂同屏** —— 正是 ADR-0008 D4 禁止的"叠加"。
       `renderAll()` 在回退态下会走 `renderDegraded()` 的"回退分支"把链路横幅摘掉
       （保留源降级横幅）。失败一律只 warn，绝不因为渲染层而让回退本身失败。 */
    try {
      const D = window.Pages && window.Pages.Dashboard;
      if (D && typeof D.renderAll === 'function') D.renderAll(state);
    } catch (err) {
      console.warn('[BoardSource] 回退后的即时重绘失败（渲染循环会补上）：' +
        ((err && err.message) || String(err)));
    }
    console.warn('[BoardSource] 服务端数据源不可用，已优雅回退演示源：' + why);
    return true;
  }

  /* ---------------- 启动 ---------------- */

  /**
   * 启动服务端数据源。
   * @param {object}   state    看板状态（`MockData.state`）
   * @param {Function} [onEvent] 每收到一条增量事件后的回调（`(evt, applied)`；用于按需刷新界面）
   * @returns {Promise<string>}  `'server'` = 已切到服务端源；`'mock'` = 已回退演示源
   */
  function startServerSource(state, onEvent) {
    const cap = capability();
    if (!cap.fetch) {
      /* vm 夹具/极老浏览器：**静默**走演示源（不抛、不 console.error；ADR-0008 D4） */
      console.warn('[BoardSource] 运行环境不支持 fetch —— 本次不启用服务端源（静默使用演示源）');
      if (state) { state.sourceMode = 'mock'; state.sourceFallback = false; }
      return Promise.resolve('mock');
    }
    const base = resolveBaseUrl();
    const api = window.Api;
    if (!api || typeof api.fetchSnapshot !== 'function') {
      return Promise.resolve(fallbackToDemo('适配层未加载 fetchSnapshot()', state) ? 'mock' : 'mock');
    }
    hideFallbackBanner();
    if (state) { state.sourceMode = 'server'; state.sourceFallback = false; state.sourceFallbackReason = ''; }

    return api.fetchSnapshot().then(res => {
      if (!res || res.ok !== true || !res.snapshot) {
        counters.snapshotFail++;
        fallbackToDemo('快照接口未返回可用数据（' + ((res && (res.error || res.failReason)) || '原因未知') + '）', state);
        return 'mock';
      }
      counters.snapshotOk++;
      /* ① 首帧全量快照（**先有数据再建流**：这样 EventSource 不可用时界面也已经是真实值） */
      window.StateAdapter.snapshotToState(state, res.snapshot, new Date());
      started = true;
      lastErrorNote = '';
      /* ② 建流消费增量。`EventSource` 不可用**不回退** —— 首帧快照已经是服务端真源，
            只是"不再自动更新"；此时由 `main.js` 的周期刷新兜住界面时钟并给出断开提示。 */
      if (!cap.eventSource) {
        console.warn('[BoardSource] 运行环境不支持 EventSource —— 仅使用首帧快照，不订阅增量');
        state.sourceStream = false;
        return 'server';
      }
      openStream(base, state, onEvent);
      state.sourceStream = true;
      return 'server';
    }).catch(err => {
      /* 网络异常 / 超时 / 解析失败：统一走优雅回退（**不 console.error、不抛**） */
      counters.snapshotFail++;
      fallbackToDemo('快照请求失败（' + ((err && err.message) || String(err)) + '）', state);
      return 'mock';
    });
  }

  /**
   * 建立 SSE 连接并逐条应用增量。服务端已写 `retry: 3000` ⇒ **重连交给浏览器**。
   * @param {string} base  服务端基地址（可为空串＝同源相对路径）
   * @param {object} state 看板状态
   * @param {Function} [onEvent] 增量回调
   */
  function openStream(base, state, onEvent) {
    const path = ((window.BoardConfig && window.BoardConfig.board) || {}).eventsPath || '/events';
    let src;
    try {
      src = new EventSource(base + path);
    } catch (err) {
      /* 构造失败（畸形地址等）：**只 warn**，界面继续用首帧快照（ADR-0008 D4 的"不黑屏"） */
      counters.errors++;
      console.warn('[BoardSource] EventSource 建立失败（继续使用首帧快照）：' + ((err && err.message) || String(err)));
      state.sourceStream = false;
      return null;
    }
    es = src;

    /** 逐条应用（应用层抛错也要兜住：一条坏事件不得打断整屏） */
    function consume(evt) {
      try {
        lastEventAt = Date.now();
        counters.events++;
        const r = window.StateAdapter.eventToState(state, evt, new Date());
        if (typeof onEvent === 'function') onEvent(evt, r);
      } catch (err) {
        counters.errors++;
        console.warn('[BoardSource] 事件应用异常（已跳过该条）：' + ((err && err.message) || String(err)));
      }
    }

    /* 业务事件：服务端给的 `event:` 名即 kind（frame/link/task/standard/upload/warning）。
       **必须逐个 `addEventListener`**：`onmessage` 只收"无 event 名"的默认消息，
       而 `writeEvent()` 每条都带 `event: <kind>` ⇒ 只听 onmessage 会一条都收不到。 */
    const KINDS = ['frame', 'link', 'task', 'standard', 'upload', 'warning'];
    KINDS.forEach(kind => {
      if (typeof src.addEventListener !== 'function') return;
      src.addEventListener(kind, msg => {
        let payload = null;
        try { payload = JSON.parse(msg && msg.data); } catch (e) { payload = null; }
        if (payload === null) {
          /* 单条坏 JSON：只 warn 一次并跳过（绝不 console.error） */
          counters.errors++;
          console.warn('[BoardSource] 收到无法解析的事件载荷（已跳过）kind=' + kind);
          return;
        }
        consume({ seq: Number(msg && msg.lastEventId) || 0, at: null, kind, payload });
      });
    });
    /* `hello`：建连快照（无 `?since` 时服务端必发），与 `GET /state` **同源**（同一构造函数） */
    if (typeof src.addEventListener === 'function') {
      src.addEventListener('hello', msg => {
        try {
          const body = JSON.parse(msg && msg.data);
          if (body && body.snapshot) {
            window.StateAdapter.snapshotToState(state, body.snapshot, new Date());
            lastEventAt = Date.now();
            if (typeof onEvent === 'function') onEvent({ kind: 'hello', payload: body }, { applied: true, kind: 'hello' });
          }
        } catch (err) {
          counters.errors++;
          console.warn('[BoardSource] hello 快照解析失败（沿用 GET /state 的首帧）：' + ((err && err.message) || String(err)));
        }
      });
    }

    /* 连接错误：SSE 规范下 error 也代表"正在重连"⇒ **不关流、不回退**，
       只把链路标为断开（界面据此显示"数据冻结/离线"，FR-2.6 ≤5 s）。
       真正的"回退演示源"只发生在**首帧快照都没拿到**时（见 startServerSource）。 */
    src.onerror = () => {
      counters.errors++;
      if (state && started) {
        state.device.link = 'offline';
        if (state.serverLink) state.serverLink.online = false;
      }
      console.warn('[BoardSource] SSE 连接中断（浏览器将按服务端 retry 自动重连；期间界面显示数据冻结）');
    };
    src.onopen = () => {
      if (state && started) {
        state.device.link = 'online';
        if (state.serverLink) state.serverLink.online = true;
      }
    };
    return src;
  }

  /** 关闭服务端数据源（优雅退出/切回演示源；幂等） */
  function stopServerSource() {
    closeStream();
    started = false;
    return true;
  }

  /** 运行态快照（自检/回执用；**只读**，不改变任何状态） */
  function sourceStatus() {
    return {
      mode: window.BoardConfig ? window.BoardConfig.dataSource : null,
      baseUrl: resolveBaseUrl(),
      capability: capability(),
      connected: !!es,
      started,
      lastEventAt: lastEventAt || null,
      lastErrorNote: lastErrorNote || null,
      counters: Object.assign({}, counters)
    };
  }

  return { startServerSource, stopServerSource, fallbackToDemo, sourceStatus, resolveBaseUrl, BANNER_ID, BANNER_CLASS, QUERY_CLASS };
})();
