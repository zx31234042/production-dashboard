/* ==========================================================================
   组件：设备异常页（components/AlarmPanel.js）
   需求：FR-5 实时故障报警、异常闭环状态、预防性预警、当班异常台账
         FR-5.5（P0）故障发生**高亮弹窗**预警，且不阻塞头部与关键状态显示 —— 见下方「报警弹窗」段
         FR-5.7（P1）弹窗**停留时长 / 自动收起 / 手动确认**规则**可配置** —— 唯一真源＝
                    `src/config/board.config.js` 的 `alarmPopup` 段（代码里不写内建缺省值）
         FR-5.6（P0）多条并发报警排队、不覆盖不丢失 —— 本文件既有实现（报警卡 ＋ 队列），弹窗**只读不写**
         UI-18（P2）避免长时间大面积纯色停留（防烧屏）、不使用重度 GPU 特效 —— 弹窗样式口径的依据
   ========================================================================== */
window.Components = window.Components || {};
window.Components.AlarmPanel = (function () {
  'use strict';

  const { setText, setHTML, setStyle, $ } = window.Dom;
  const { esc } = window.Format;

  function render(state) {
    const a = state.alarm.active;
    const hasAlarm = !!a;
    /* 并发报警队列（FR-5.6）：active 为队首，其余为"待处理"条目 */
    const queue = state.alarm.queue || [];

    /* 有故障时整卡转为红色主题 */
    $('alarmCard').classList.toggle('normal', !hasAlarm);
    setText('alCode', hasAlarm ? a.code : '—');
    setText('alType', hasAlarm ? a.type : '当班无故障报警');
    setText('alQueueNote', queue.length > 1
      ? `并发报警队列：${queue.length} 条未闭环 · 当前展示队首（其余 ${queue.length - 1} 条按发生时间排队）`
      : '并发报警队列：无其他待处理报警');

    /* 故障简述与处理信息（处理措施取自故障字典的 action，不再写死） */
    setHTML('alDetail', (hasAlarm ? `<div class="alarm-desc">${esc(a.desc)}</div>` : '') +
      (hasAlarm ? [
        ['故障发生时间', a.time],
        ['等级', a.level || '—'],
        ['处理人', '李建国'],
        ['处理措施', a.action || '按故障字典处理建议执行']
      ].map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('') : ''));

    /* 异常闭环状态（未处理 / 处理中 / 已闭环 / 复检确认中）；色值引用 variables.css 变量 */
    setText('alState', hasAlarm ? `异常闭环状态：${a.state}` : '异常闭环状态：正常');
    setStyle('alState', 'color', !hasAlarm ? 'var(--ok)' : (a.state === '未处理' ? 'var(--err)' : 'var(--warn)'));
    setStyle('alState', 'background', !hasAlarm ? 'rgba(0,176,80,.16)'
      : (a.state === '未处理' ? 'rgba(255,0,0,.16)' : 'rgba(255,192,0,.16)'));

    /* 闭环录入按钮：仅在展示中的报警还未闭环时可用 */
    $('alHandleBtn').disabled = !hasAlarm || a.state !== '未处理';
    $('alCloseBtn').disabled = !hasAlarm;

    /* 并发报警队列明细：不覆盖、不丢失（FR-5.6） */
    const rest = queue.slice(1);
    setHTML('alQueueList', rest.length
      ? rest.map((q, i) =>
          `<div class="list-item lv-${q.level === '严重' ? 'err' : (q.level === '一般' ? 'warn' : 'info')}">` +
          `<span class="tag">${esc(q.level || '—')}</span>` +
          `<span class="body"><b class="mono">${esc(q.code)}</b> ${esc(q.type)}<br>${esc(q.desc)}</span>` +
          `<span class="meta mono">队列 ${i + 2} · ${esc(q.time)} · ${esc(q.state)}</span></div>`).join('')
      : '<div class="list-item lv-info is-empty"><span class="body empty-note">无其他待处理报警</span></div>');

    /* 预防性预警（4 类） */
    setHTML('alWarningList', state.warnings.map(w =>
      `<div class="list-item lv-${esc(w.lv)}"><span class="body"><b>${esc(w.title)}</b><br>${esc(w.detail)}</span></div>`).join(''));

    /* 当班异常台账：最新 5 条及闭环记录 */
    const tb = $('alTable').querySelector('tbody');
    tb.innerHTML = state.alarm.ledger.map(r =>
      `<tr><td class="mono">${esc(r.time)}</td><td class="mono">${esc(r.code)}</td><td>${esc(r.desc)}</td>` +
      `<td class="${r.state === '已闭环' ? 'ok' : 'warn'}">${esc(r.state)}</td></tr>`).join('');

    /* FR-5.5 / FR-5.7：真模态报警弹窗（**新增**；上面每一行一字未动）。
       调用点放在 render 的**最后**，且弹窗只写 `#alPopup*` 自己的节点 ⇒ 即使它出问题，
       FR-5.1～5.4 的报警卡与 FR-5.6 的并发队列也已经渲染完毕（不回归）。 */
    refreshPopup(state);
  }

  /* ==========================================================================
     报警弹窗（FR-5.5 高亮弹窗预警 / FR-5.7 停留时长·自动收起·手动确认）—— T-20261007-23
     --------------------------------------------------------------------------
     需求原文（`需求文档\…-V1.45.md`）：
       · `FR-5.5`（P0，`:510`）「故障发生**高亮弹窗**预警，且**不阻塞头部与关键状态显示**」；
       · `FR-5.7`（P1，`:512`）「**弹窗停留时长**、**自动收起**、**手动确认**规则**可配置**」；
       · `UI-18`（P2，`:613`）「避免长时间大面积纯色停留，配合防烧屏策略；不使用重度 GPU 特效」。
     本段只做 `FR-5.5` / `FR-5.7` 这两条。`FR-5.6`（并发排队 / 手工闭环 / 闭环入台账）与
     `FR-5.1～5.4`（卡片内容）的既有实现**一行不动**：弹窗**只读** `state.alarm.queue`，
     绝不写它、绝不调 `closeActiveAlarm()`、绝不碰 `#alQueueList` / `#alQueueNote` / `#alCloseBtn`。

     DOM 契约（稳定可判据；供 4b 写真机 / 假 DOM 断言）：
       挂点     `#alPopup`（`role="alert"`），由 `popupRoot()` **按需创建**后挂到 `#stage`
       显隐     `hidden` 属性 ＋ class `show`（与既有 `#autoLockTip` **逐字同形**，两者同步切换）
       子节点   `#alPopupCode`（报警代码）/ `#alPopupType` / `#alPopupDesc` / `#alPopupMeta`
                / `#alPopupQueue`（排队情况）/ `#alPopupNote`（停留与确认口径）/ `#alPopupConfirm`（确认按钮）
       机器可读状态（`dataset`，**双向钉住**；与 `E197`/`E198` 的 `data-note-lv` **同一风格**，
                    不新造机制）：
         `data-popup-state`         = `shown` ｜ `hidden` ｜ `off`
                                      （`off` ＝**没有这个机制**〔配置未启用 / 挂点不可得〕，
                                       与"机制在、此刻未显示"**必须分得开** —— 同 `demo ≠ ok` 口径）
         `data-popup-code`          = 当前弹窗那条的报警代码（未显示时为空串）
         `data-popup-queue-len`     = 当帧未闭环报警条数
         `data-popup-dismiss`       = 最近一次收起原因：`none`／`timeout`／`confirm`／`closed`
         `data-popup-dwell-ms`      = 生效的停留时长（毫秒；配置给不出数值时写 `—`）
         `data-popup-auto-dismiss`  = `true`／`false`／`unavailable`（无计时能力时如实标 unavailable）
         `data-popup-manual-confirm`= 手动确认规则（配置原值；未配置写 `—`）
       为什么挂点不写在 `index.html`：本轮的写范围**只有** `src\`／`server\`／`platform\`
         （任务包硬要求①），而规范 9.5-4 的口径本就是"`index.html` 只保留骨架、具体内容由组件渲染"。
         能力检测全兜底（无 `createElement`／无 `#stage`／无计时器）⇒ 写 `off` 并**不影响**报警卡渲染。

     三条口径（防回归 / 防烧屏 / 不阻塞）：
       ① **首帧口径**（显式）：页面打开时**已经存在**的报警**不入弹窗** —— 弹窗是「故障**发生**」
          这一刻的即时提醒（`FR-5.5` 的措辞），不是"页面一打开就补一次"；首帧的既有报警由
          `#alarmCard` 如实呈现（`FR-5.1～5.4`）。判据＝"这一条的自然键**此前有没有被观测过**"，
          而不是"此刻队列里有没有报警"。这条同时使 10 张界面基准图（全部是首帧口径）不受影响。
       ② **自动消隐**：停留时长到点即收起（`FR-5.7`「弹窗停留时长」＋「自动收起」），
          **只有这一个计时器**（显示 / 再次触发 / 手动确认 / 停用 都先 `clearTimeout` 再决定挂不挂）
          ⇒ 不长时间遮挡（`UI-18` 防烧屏）、不堆叠、不泄漏。
       ③ **不阻塞**：无遮罩层、根节点 `pointer-events:none`（只有确认按钮收 `pointer-events:auto`），
          挂点位置在 `#board-header` **之下**（`global.css` 的 `.alarm-popup{top:272px}`，注释里有算术）。
       ④ **确认 ≠ 闭环**：`#alPopupConfirm` 只收起本提示，**不改变异常闭环状态**
          （`FR-5.12` 的闭环仍是卡片上的「标记处理中 / 确认闭环」；`FR-5.6` 的"手工闭环"一字未动）。
     ========================================================================== */
  const POPUP_ID = 'alPopup';
  const POPUP_CONFIRM_ID = 'alPopupConfirm';
  /** 弹窗静态结构（**只在这里写一次**；创建后只改文本与 dataset，不重建节点） */
  const POPUP_MARKUP =
    '<div class="alarm-popup-head">' +
      '<span class="alarm-popup-tag">报警</span>' +
      '<span class="alarm-popup-code mono" id="alPopupCode">—</span>' +
      '<span class="alarm-popup-type" id="alPopupType">—</span>' +
    '</div>' +
    '<div class="alarm-popup-body">' +
      '<span class="alarm-popup-desc" id="alPopupDesc">—</span>' +
      '<span class="alarm-popup-queue" id="alPopupQueue">—</span>' +
      '<span class="alarm-popup-meta" id="alPopupMeta">—</span>' +
      '<span class="alarm-popup-note" id="alPopupNote">—</span>' +
    '</div>' +
    '<button class="btn primary alarm-popup-btn" id="alPopupConfirm" type="button">确认知悉</button>';

  /* 弹窗运行时状态（模块级单例）。**计时器只有 `popupTimer` 一个**（口径②）。 */
  let seenKeys = null;          // 已观测过的报警自然键；`null` ＝ 尚未观测过任何一帧（首帧口径的判据）
  let popupShownKey = '';       // 当前弹窗展示的是哪一条（自然键；空串＝未显示）
  let popupShownCode = '';      // 供 `data-popup-code` 回报
  let popupDismiss = 'none';    // 最近一次收起原因（口径②的机器可读落点）
  let popupTimer = null;        // 停留计时（唯一一个）
  let popupQueueLen = 0;        // 最近一帧的未闭环报警条数（供确认动作收起时如实回报）
  let popupBound = false;       // 确认监听是否已挂（挂点一生只创建一次 ⇒ 只挂一次）
  let popupOnActivity = null;   // `bind()` 交进来的"有操作"回调（与卡片两个闭环按钮同一口径）

  /** 弹窗配置段（**唯一真源**＝`src/config/board.config.js` 的 `alarmPopup`）。
   *  这里**刻意不写任何内建缺省值**：段不在／不是对象 ⇒ 视为"弹窗机制未启用"（写 `off`），
   *  而不是拿代码里的魔数顶上 —— 那条路会让"配置写的"与"实际生效的"分叉成两份（规范 9.6）。 */
  function popupCfg() {
    const c = window.BoardConfig && window.BoardConfig.alarmPopup;
    return (c && typeof c === 'object') ? c : null;
  }

  /** 一条报警的**自然键**（判"是不是同一次故障发生"）。
   *  取 `code|time`（报警自带 `seq` 时一并带上）。**不用对象引用**：`raiseAlarm()` 每次发生都给
   *  新对象，而夹具/服务端映射可能逐帧重建对象 ⇒ 按引用判"新发生"会**每帧误弹**。 */
  function alarmKeyOf(a) {
    if (!a) return '';
    const seq = (a.seq === undefined || a.seq === null) ? '' : String(a.seq);
    return String(a.code === undefined ? '' : a.code) + '|' +
      String(a.time === undefined ? '' : a.time) + '|' + seq;
  }

  /** 生效口径（纯函数，便于逐条对照 `FR-5.7` 的三个配置项）：
   *  `auto` ＝**是否挂自动收起计时**（要求：`autoDismiss !== false` ∧ `manualConfirm !== 'required'`
   *  ∧ 有计时能力 ∧ `dwellMs` 是正数）；`required` ＝必须手动确认；`ms` ＝停留时长。 */
  function popupPolicy(cfg) {
    const hasTimer = (typeof setTimeout === 'function' && typeof clearTimeout === 'function');
    const required = !!(cfg && cfg.manualConfirm === 'required');
    const ms = (cfg && cfg.dwellMs !== undefined && cfg.dwellMs !== null) ? Number(cfg.dwellMs) : NaN;
    const auto = !!(cfg && cfg.autoDismiss !== false) && !required && hasTimer &&
      Number.isFinite(ms) && ms > 0;
    return { auto, ms, required, hasTimer };
  }

  /** 停留/确认口径的**可见文案**（`#alPopupNote`）：把"为什么现在会/不会自动收起"说清楚，
   *  不让操作人面对一个"不动也不收"的弹窗去猜（不静默）。 */
  function popupNoteText(pol) {
    const tail = '　·　「确认知悉」仅收起本提示，**不改变**异常闭环状态（闭环仍走卡片上的按钮）';
    if (pol.auto) return '停留 ' + (pol.ms / 1000) + ' 秒后自动收起（FR-5.7；防烧屏 UI-18）' + tail;
    if (pol.required) return '手动确认规则＝required：需点「确认知悉」收起（FR-5.7）' + tail;
    if (!pol.hasTimer) return '本环境无计时能力：停留时长不可用，请点「确认知悉」收起' + tail;
    return '停留时长未配置（alarmPopup.dwellMs 非正数）：不自动收起，请点「确认知悉」' + tail;
  }

  /** 把弹窗状态**双向钉住**到 DOM（`dataset` ＋ `hidden` ＋ class `show`）。
   *  `off`／`hidden`／`shown` 三态都写 dataset ⇒ "没有这个机制""机制在但没显示""正在显示"
   *  在 DOM 上分得开（同 `E198` 的 `data-note-lv` 口径）。 */
  function writePopupState(root, st, cfg, queueLen) {
    /* 条数缺省（`undefined`/`null`）⇒ **沿用上一帧**（不写 0：0 是"真的没有未闭环报警"这个事实，
       拿它顶"这次没给读数"会把状态位变成假的） */
    if (queueLen !== undefined && queueLen !== null) popupQueueLen = Number(queueLen);
    const pol = popupPolicy(cfg);
    if (!root) return;
    const ds = root.dataset || (root.dataset = {});
    ds.popupState = st;
    ds.popupCode = st === 'shown' ? popupShownCode : '';
    ds.popupQueueLen = String(popupQueueLen);
    ds.popupDismiss = popupDismiss;
    ds.popupDwellMs = Number.isFinite(pol.ms) ? String(pol.ms) : '—';
    ds.popupAutoDismiss = pol.auto ? 'true' : (pol.hasTimer ? 'false' : 'unavailable');
    ds.popupManualConfirm = (cfg && cfg.manualConfirm !== undefined && cfg.manualConfirm !== null)
      ? String(cfg.manualConfirm) : '—';
  }

  /** 拿弹窗挂点：**已存在就复用**（同一 id 恒等）；不存在则按需创建并挂到 `#stage`。
   *  能力检测：`$` 取不到 ＋ 无 `createElement`／无 `#stage`／`appendChild` 不可用 ⇒ 返回 null
   *  （调用方写 `off`，**不抛异常**、不影响报警卡）。
   *  ⚠ 本函数**不注册监听**：监听统一在 `bind()`（装配期）挂 —— `render()` **不得注册事件监听**
   *    是本仓既有断言（`tests\ui-check.js`「render() 不得注册事件监听（否则每秒累积监听器）」），
   *    首帧渲染时创建节点又顺手挂监听会踩它。 */
  function popupRoot() {
    const found = $('alPopup');
    if (found) return found;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    const stage = $('stage');
    if (!stage || typeof stage.appendChild !== 'function') return null;
    const wrap = document.createElement('div');
    wrap.id = POPUP_ID;
    wrap.className = 'alarm-popup';
    if (typeof wrap.setAttribute === 'function') {
      wrap.setAttribute('role', 'alert');
      wrap.setAttribute('aria-live', 'assertive');
    }
    wrap.hidden = true;
    wrap.innerHTML = POPUP_MARKUP;
    stage.appendChild(wrap);
    return $('alPopup');
  }

  /** 确认按钮的监听：**只挂一次**（`popupBound`），挂载点＝`bind()`（装配期）。
   *  监听挂在**根节点**上（委托）而不是按钮上 —— 这样"节点何时被创建"与"监听何时挂"解耦，
   *  且只留一个监听。根节点 `pointer-events:none`（见 `global.css`），只有确认按钮可点
   *  ⇒ 真实点击必然来自它。桩件环境的 `__fire('click')` 不带 `target` ⇒ 按"确认"处理（不静默失败）。 */
  function bindPopupOnce(el) {
    if (popupBound || !el || typeof el.addEventListener !== 'function') return;
    popupBound = true;
    el.addEventListener('click', e => {
      const t = e && e.target;
      const id = (t && t.id) ? String(t.id) : '';
      if (id && id !== POPUP_CONFIRM_ID) return;      // 不是确认按钮：忽略（不猜）
      hidePopup($('alPopup'), popupCfg(), popupQueueLen, 'confirm');
      if (typeof popupOnActivity === 'function') popupOnActivity();
    });
  }

  /** 收起弹窗（**唯一的收起出口**：计时到点 / 手动确认 / 那条报警已闭环 / 机制被停用）。
   *  一律先清计时器 ⇒ 不留第二个计时器（口径②）。 */
  function hidePopup(root, cfg, queueLen, reason) {
    if (popupTimer !== null && typeof clearTimeout === 'function') {
      clearTimeout(popupTimer);
      popupTimer = null;
    }
    popupDismiss = reason || 'none';
    popupShownKey = '';
    popupShownCode = '';
    if (!root) return;
    root.hidden = true;
    if (root.classList && typeof root.classList.remove === 'function') root.classList.remove('show');
    writePopupState(root, 'hidden', cfg, queueLen);
  }

  /** 弹出一条报警（`FR-5.5`）：写文案 → 显示 → 钉状态 → 挂**唯一**的停留计时。
   *  重复触发（又一条新报警）时：先清旧计时再挂新的 ⇒ 停留时长按"最后一条"重新计。
   *  本函数**不写任何业务状态**（队列、闭环状态一概不动）。 */
  function showPopup(root, cfg, alarm, queue) {
    popupShownKey = alarmKeyOf(alarm);
    popupShownCode = String(alarm.code === undefined || alarm.code === null ? '' : alarm.code);
    popupDismiss = 'none';
    const pol = popupPolicy(cfg);
    setText('alPopupCode', alarm.code || '—');
    setText('alPopupType', alarm.type || '—');
    setText('alPopupDesc', alarm.desc || '—');
    setText('alPopupMeta', '发生时间 ' + (alarm.time || '—') + '　·　等级 ' + (alarm.level || '—') +
      '　·　闭环状态 ' + (alarm.state || '—'));
    setText('alPopupQueue', queue.length > 1
      ? '并发排队：第 1 条 / 共 ' + queue.length + ' 条未闭环（按发生时间排队，不覆盖不丢失）'
      : '并发排队：当前仅此 1 条未闭环');
    setText('alPopupNote', popupNoteText(pol));
    root.hidden = false;
    if (root.classList && typeof root.classList.add === 'function') root.classList.add('show');
    writePopupState(root, 'shown', cfg, queue.length);
    if (pol.auto) {
      if (popupTimer !== null) clearTimeout(popupTimer);
      popupTimer = setTimeout(() => {
        popupTimer = null;
        hidePopup($('alPopup'), cfg, queue.length, 'timeout');
      }, pol.ms);
    }
  }

  /** 每帧刷新（由 `render()` 末尾调用）：判"有没有**新发生**的报警"→ 弹 / 收 / 只刷读数。
   *  四种帧：①机制停用 ⇒ `off`；②首帧 ⇒ 只登记（口径①）；③有新键 ⇒ 弹；④显示中而那条已闭环
   *  ⇒ 跟着收起；⑤其余 ⇒ 只刷新 dataset（不重置停留计时、不改显隐）。 */
  function refreshPopup(state) {
    const queue = (state && state.alarm && state.alarm.queue) || [];
    const keys = [];
    for (let i = 0; i < queue.length; i++) keys.push(alarmKeyOf(queue[i]));
    const root = popupRoot();
    const cfg = popupCfg();

    /* ① 机制未启用 / 配置段不在 / 挂点不可得 ⇒ 写 `off`（"没有这个机制"），并同步"已见"，
          免得启用之后把历史报警当成新发生。已挂的停留计时一并撤掉（不留孤儿计时器）。 */
    if (!root || !cfg || cfg.enabled !== true) {
      if (popupTimer !== null && typeof clearTimeout === 'function') {
        clearTimeout(popupTimer);
        popupTimer = null;
      }
      popupShownKey = '';
      popupShownCode = '';
      seenKeys = keys;
      writePopupState(root, 'off', cfg, keys.length);
      return;
    }

    /* ② 首帧口径：页面打开时就存在的报警**只登记、不弹**（见上方口径①） */
    if (seenKeys === null) {
      seenKeys = keys;
      writePopupState(root, 'hidden', cfg, keys.length);
      return;
    }

    /* ③ 新发生（自然键**首次**出现）⇒ 弹窗；同一帧内多于一条新报警时取**队列最前**那条（最新） */
    let fresh = -1;
    for (let i = 0; i < keys.length; i++) {
      if (seenKeys.indexOf(keys[i]) < 0) { fresh = i; break; }
    }
    seenKeys = keys;
    if (fresh >= 0) {
      showPopup(root, cfg, queue[fresh], queue);
      return;
    }

    /* ④ 显示中、但那条报警已不在队列里（被手工闭环 / 老化转台账）⇒ 跟着收起，不留过时读数 */
    if (popupShownKey && keys.indexOf(popupShownKey) < 0) {
      hidePopup(root, cfg, keys.length, 'closed');
      return;
    }

    /* ⑤ 其余帧：只刷新读数（不动显隐、不重置停留计时） */
    writePopupState(root, root.hidden ? 'hidden' : 'shown', cfg, keys.length);
  }

  /* ---------------- 交互绑定（闭环状态本机录入，FR-5.4/5.11） ---------------- */
  /**
   * @param {object}   state      数据状态
   * @param {Function} onActivity 有操作时回调（用于重置"无操作自动返回首页"计时）
   */
  function bind(state, onActivity) {
    const M = window.MockData;

    /* FR-5.5 / FR-5.7：确认按钮的监听（`onActivity` 与下面卡片上两个闭环按钮**同一口径**）。
       挂点在这里**按需创建**（装配期，`Dashboard.init` 调本函数时就有）——
       `render()` 里**不注册任何监听**，否则会踩既有断言「render() 不得注册事件监听」。 */
    popupOnActivity = typeof onActivity === 'function' ? onActivity : null;
    bindPopupOnce(popupRoot());

    $('alHandleBtn').addEventListener('click', () => {
      const a = state.alarm.active;
      if (!a || a.state !== '未处理') return;
      a.state = '处理中';
      M.pushLog('异常处置', `${a.code} ${a.type} 标记为处理中`);
      render(state);
      if (onActivity) onActivity();
    });
    $('alCloseBtn').addEventListener('click', () => {
      const a = state.alarm.active;
      if (!a) return;
      const closed = M.closeActiveAlarm();
      if (closed) M.pushLog('异常闭环', `${closed.code} ${closed.type} 确认闭环（${closed.action || '按处理建议执行'}）`);
      render(state);
      if (onActivity) onActivity();
    });
  }

  return { render, bind };
})();
