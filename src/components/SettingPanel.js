/* ==========================================================================
   组件：操作设置页（components/SettingPanel.js）
   需求：FR-8 密码解锁（含 5 分钟自动锁定）、系统时间设置、系统自检、关键参数配置
         FR-6.11 维保录入、FR-7.12 公告发布（解锁后可用）
         FR-8.7 / NFR-15 解锁后的写操作全程留痕（操作日志）
         FR-8.2 / FR-3.19⑧ / C-84③：本页**每一个写操作与录入框键入**都刷新与任务页**同一个**
         5 分钟锁定计时（`noteActivity()` 双动作，参考 `TaskPanel.activity()`）；锁定后的保存
         必须给出可观察反馈，不得静默 return。
   ========================================================================== */
window.Components = window.Components || {};
window.Components.SettingPanel = (function () {
  'use strict';

  const { setText, setHTML, setClass, $ } = window.Dom;
  const { esc } = window.Format;
  const CFG = window.BoardConfig;

  /* FR-8.2：解锁后超过该时长自动回到锁定状态（演示取 5 分钟） */
  const AUTO_LOCK_MS = 5 * 60 * 1000;
  let autoLockTimer = null;

  /* 已用 bind() 装配过的 arm 闭包；供 `armAutoLock()` 这个**导出接口**使用。
     为什么要导出：`?unlock=1` 评审旁路（src/main.js）直接调 `MockData.setUnlocked(true)`，
     不走设置页的 `#setUnlockBtn` → tryUnlock()，若不 arm 就永远不自动锁定、也不弹提示。
     计时逻辑仍只有一份（bind 内的 armAutoLock），这里只是把同一份逻辑的引用拿出来。 */
  let autoLockArmer = null;

  /* ================= ADR-0007（T-20261002-15 / 技术债 E86①）：登录接线与模式提示 =================
     口径真源＝`项目记录\ADR\ADR-0007-设置页口令与登录鉴权形态.md`（D1–D9）。本页只承担 **D5** 的两件事：
       · **演示模式**（`dataSource:'mock'`）：**不启用**登录拦截 —— 解锁仍走 `MockData.CFG.unlockPassword`
         的**演示口令**（`8888` **只允许存在于演示模式**，D4/D5），界面**显式提示**"未启用服务端口令校验"；
       · **服务端模式**：**强制**登录 —— 解锁＝`POST /auth/login`（由 `window.BoardSession` 提交口令，
         本页**不做**任何哈希 / 口令比对 / 错误计数 / 锁定判定，D5），成功即保存服务端下发的会话令牌
         （内存 + `sessionStorage`，D3/D7），失败按服务端给出的码显示（401/423 含剩余秒数/409 走本机初始化）。
     **统一 401 处理**：`services/api.js` 的 `httpJson()`（全仓唯一 HTTP 出口）把每个 401 交给
       `window.BoardSession.noteUnauthorized()`；本页在 `render()` 里读它的记账并**可见降级**
       （提示"未登录或登录已过期"，回到锁定态，**不黑屏、不抛未捕获异常**）。
     自动锁定（FR-8.2）：5 分钟到点在**既有**计时器回调里**同步**调 `logout`（令牌即失效）——
       **前端计时器与服务端令牌不各管一套**（D5）；**不新增第二个计时器**，
       提示弹窗仍沿用既有 `#autoLockTip`（DOM 契约与时长都不动）。
     ⚠ 刷新页面的口径（显式，不假装已登录）：`sessionStorage` 里的令牌仍在（同标签页刷新不丢），
       但 `state.unlocked` 一并复位；前端**不凭一个未经校验的令牌自称已登录**（D5 禁止"假装已登录"），
       重新解锁会重新走 `POST /auth/login` 换发新令牌。 */
  /** 演示模式提示（**逐字**照 ADR-0007 D5；演示模式下界面必须显示它） */
  const DEMO_MODE_NOTE = '演示模式：未启用服务端口令校验（口令由服务端校验）';
  /** 服务端模式提示（说明校验方；后半句由 render() 按登录态/失效态补） */
  const SERVER_MODE_NOTE = '服务端模式：口令由服务端校验（POST /auth/login）';
  /** 服务端模式下的口令长度上限（ADR-0007 D1：4～64 位）——`#setPwd` 的 `maxlength="8"` 是按演示口令定的 */
  const SERVER_PWD_MAX = 64;
  /** 「服务端尚未初始化」态（**只有**收到 409 `not_initialized` 才置位）⇒ 显示本机一次性初始化行（D4） */
  let needsInit = false;

  /* ---------------- FR-7.12（T-20261002-08）：服务端模式下的公告新增/编辑/删除 ----------------
     需求原文（`需求文档\…-V1.42.md:541`）：「**仅本机解锁后可新增/编辑/删除公告**」。
     本模块此前只有"发布"一条内存路径（刷新即丢）⇒ 本波把它接到服务端的 `POST /notice`
     （唯一写入口＝`server/repo/notice.js`，落 `notice` 表并**同批**写 `op_log`）。
     鉴权出口（**T-20261002-15 / E86① 已接线**）：服务端模式下"解锁"＝`POST /auth/login` 取得会话令牌
     （见下方 ADR-0007 段与 `sessionToken()`），`POST /notice` 带 `Authorization: Bearer <令牌>`；
     取不到令牌时服务端回 **401**，本页把该失败**显示出来**（绝不静默），并把登录态**如实降级**。
     边界（本包**不做**、也不假装做）：**演示模式一行都不改** —— 服务端分支只在 `serverMode(state)` 为真时进入。 */

  /** 正在编辑的公告 id（服务端模式；`null` ＝ 新增）。演示模式恒为 null、不参与任何分支。 */
  let noticeEditingId = null;

  /** 是否服务端模式（与 `UploadPanel.serverMode()` **同一判据**：状态位优先，配置兜底） */
  function serverMode(state) {
    return !!(state && (state.serverMode === true ||
      ((window.BoardConfig || {}).dataSource === 'server')));
  }

  /** 会话出口（`services/auth.js` 的 `window.BoardSession`）：**能力检测**，缺了返回 null（不抛）。
   *  为什么要有能力检测：`index.html` 未注册该文件、或裁剪环境/测试桩件里没有它时，
   *  本页必须**如实降级**（提示"服务端登录未装配"）而不是抛 `ReferenceError` 把整帧渲染打断。 */
  function session() {
    const bs = window.BoardSession;
    return (bs && typeof bs.token === 'function') ? bs : null;
  }

  /** 会话失效（统一 401 处理）的可读说明；无则空串。取用一律走能力检测。 */
  function lostNoteText() {
    const bs = session();
    if (!bs || typeof bs.lostNote !== 'function') return '';
    try { return String(bs.lostNote() || ''); } catch (err) { return ''; }
  }

  /** 设置元素 `hidden`（能力检测：节点缺失时静默跳过 —— `Dom.$` 在真 DOM 里可能返回 null） */
  function setHidden(id, on) {
    const el = $(id);
    if (el) el.hidden = !!on;
  }

  /** 会话令牌（ADR-0007 D3 的 `Bearer`）：提交给 `POST /notice` 的鉴权头。
   *  **唯一出口**＝`window.BoardSession.token()`（`services/auth.js`，内存 + `sessionStorage`）；
   *  兜底读状态位 `state.sessionToken`（**有意的兼容出口**：`T-20261002-08` 的公告写入与本仓若干
   *  夹具按它取令牌，二者至少一个可用）；取不到就返回空串 —— 调用方**不伪造令牌**，
   *  服务端会回 401，本页把原因显示给操作人并把登录态如实降级。 */
  function sessionToken(state) {
    const bs = session();
    try {
      if (bs) {
        const t = bs.token();
        if (t) return String(t);
      }
    } catch (err) {
      console.warn('[SettingPanel] 会话令牌出口抛错（按未登录处理，失败会显示在提示位）：' +
        ((err && err.message) || String(err)));
    }
    if (state && typeof state.sessionToken === 'string' && state.sessionToken) return state.sessionToken;
    return '';
  }

  /** 从点击目标向上找带 `data-notice-act` 的元素（**不用 `Element.closest`**：桩件 DOM 未必实现它）。
   *  只向上爬有限层（结构固定＝button → span.notice-acts → div.list-item），避免误命中。 */
  function actionButtonOf(node) {
    let el = node;
    for (let i = 0; el && i < 5; i++) {
      const get = typeof el.getAttribute === 'function' ? el.getAttribute.bind(el) : null;
      const act = get ? get('data-notice-act') : null;
      if (act) return { act: String(act), id: get('data-notice-id'), el };
      el = el.parentNode || el.__parent || null;
    }
    return null;
  }

  /* ---------------- 自动锁定提示弹窗（FR-8.2：自动锁定时弹提示性弹窗，显示 2 s） ----------------
     DOM 契约（测试可断言）：
       节点     index.html `#autoLockTip`（role="status"，初始带 `hidden` 属性）
       显示     `hidden` 属性移除 + 加 class `show`（CSS：.auto-lock-tip.show 为 display:flex）
       隐藏     `hidden` 属性加回 + 去 class `show`（两者由本文件同一处代码同步切换）
       文案     `#autoLockTipTitle` = 自动锁定；`#autoLockTipText` = 解锁已超过 5 分钟，系统已自动锁定
       计时     显示后 setTimeout(2000) 自动隐藏；重复触发清掉上一个定时器（复用同一节点，不堆叠） */
  const AUTO_LOCK_TIP_MS = 2000;
  let autoLockTipTimer = null;

  function showAutoLockTip() {
    const tip = $('autoLockTip');
    if (!tip) return;
    tip.hidden = false;
    tip.classList.add('show');
    if (autoLockTipTimer) clearTimeout(autoLockTipTimer);
    autoLockTipTimer = setTimeout(() => {
      autoLockTipTimer = null;
      tip.hidden = true;
      tip.classList.remove('show');
    }, AUTO_LOCK_TIP_MS);
  }

  /* ---------------- 渲染 ---------------- */
  function render(state) {
    const server = serverMode(state);
    const lost = server ? lostNoteText() : '';

    /* ADR-0007 D5 的**统一 401 处理**在本页的落点：会话失效 ⇒ 可见降级回锁定态
       （`httpJson()` 已在出口处清掉令牌并记账，这里只做"界面如实反映"）。
       三条纪律：①不黑屏（照常 render）；②不抛异常（全部能力检测）；③不假装已登录。 */
    if (server && lost && state.unlocked) {
      const MM = window.MockData;
      if (MM && typeof MM.setUnlocked === 'function') MM.setUnlocked(false);
      if (autoLockArmer) autoLockArmer.clear();      /* 已回到锁定态：撤下 FR-8.2 的锁定计时（与手动锁定同口径） */
    }
    const unlocked = !!state.unlocked;
    const loggedIn = server && !!sessionToken(state);

    /* 解锁状态 */
    setClass('setLockDot', 'lock-dot' + (unlocked ? ' on' : ''));
    setText('setLockText', unlocked ? '已解锁：可录入维保信息、修改公告' : '当前已锁定');
    $('setSyncBtn').disabled = !unlocked;
    $('setManualBtn').disabled = !unlocked;

    /* ADR-0007 D5：**模式提示**（显式降级，不静默、不假装已登录）
       · 演示模式 ⇒ 逐字给出 ADR 指定的那句"未启用服务端口令校验"；
       · 服务端模式 ⇒ 说明校验方，并如实标注登录态 / 会话失效（失效文案由统一 401 处理记账）。 */
    setText('setAuthNote', !server ? DEMO_MODE_NOTE
      : SERVER_MODE_NOTE + (lost ? '；' + lost
        : (loggedIn ? '；当前已登录（会话令牌在本窗口内）' : '；当前未登录')
          + (needsInit ? '；服务端尚未初始化：请用一次性初始化码设置口令（ADR-0007 D4）' : '')));

    /* 服务端模式独有的两行（**演示模式恒 hidden** ⇒ 10 张截图基准版面零变化）：
       · 改密行：要 Bearer（D5/D8④）⇒ 只在"服务端模式且已登录"时出现；
       · 初始化行：只有服务端**确实未初始化**（409）时才出现（D4：不设默认口令、不许远程初始化）。
       ⚠ `hidden` 挂在**无 class 的外层 div** 上（`#setPwdChangeWrap`/`#setInitWrap`）：内层是
         `.pwd-row`（`display:flex`，作者样式会盖掉 UA 的 `[hidden]{display:none}`），挂内层等于没挂。 */
    setHidden('setPwdChangeWrap', !(server && loggedIn));
    setHidden('setInitWrap', !(server && needsInit));

    /* 维保录入 / 公告发布：解锁后才可编辑（FR-6.11、FR-7.12） */
    ['maintContent', 'maintOwner', 'maintState', 'maintSave',
     'noticeType', 'noticeText', 'noticeSave'].forEach(id => { $(id).disabled = !unlocked; });

    /* FR-7.12（服务端模式）：编辑态把按钮文案换成「保存修改」；锁定时**退出编辑态**
       （锁定后按钮已 disabled，若留着编辑态，解锁后一次误点就会改到别的那条公告）。
       ⚠ 演示模式**一字不改**：`serverMode(state)` 为假时下面这段整段不执行。 */
    if (server) {
      if (!unlocked && noticeEditingId !== null) noticeEditingId = null;
      setText('noticeSave', noticeEditingId === null ? '发布公告' : '保存修改');
    }

    /* 关键参数配置：解锁后才可编辑（FR-8.6）；此处只切禁用态，不写 value（避免秒级刷新清空输入） */
    ['cfgEquipCode', 'cfgUpperUrl', 'cfgMesUrl', 'cfgWarnDays', 'cfgSaveBtn']
      .forEach(id => { $(id).disabled = !unlocked; });

    const em = $('entryMsg');
    if (!em.dataset.sticky) {
      /* ⚠ 两条分支的文案**必须分开写死**（不做拼接抽象）：
         · 演示模式那两句与被 10 张截图基准冻结的版面**逐字相同**（含"演示密码 8888"）；
         · 服务端模式**不得**出现演示口令，且未登录/会话失效时如实写"未登录或登录已过期"（D4/D5）。 */
      if (server) {
        em.textContent = lost
          ? lost + '：请先在左侧输入解锁密码重新登录（口令由服务端校验）'
          : (unlocked
            ? '已解锁：录入内容保存后写入服务端库并记录操作日志'
            : '当前已锁定：未登录或登录已过期，请先在左侧输入解锁密码（口令由服务端校验）');
        em.className = 'entry-note' + (unlocked && !lost ? ' ok' : '');
      } else {
        em.textContent = unlocked
          ? '已解锁：录入内容保存后写入本地库并记录操作日志'
          : '当前已锁定：请先在左侧输入解锁密码（演示密码 8888）';
        em.className = 'entry-note' + (unlocked ? ' ok' : '');
      }
    }

    /* 系统时间设置（ENV-18 / FR-8.3：以 NTP 同步优先） */
    setHTML('setTimeList', [
      ['当前系统时间', state.clock.date + ' ' + state.clock.time],
      ['时间来源', 'NTP 同步（优先）'],
      ['NTP 服务器', '10.10.2.21（内网）'],
      ['同步状态', '已同步 · 偏差 32 ms']
    ].map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v mono">${v}</span></div>`).join(''));

    /* 系统状态自检。
       W7-B（FR-8.5 / NFR-26）：**服务端模式下用真实端点探测**（`services/selfCheckProbe.js`
       把 `GET /health`、`/ifd/status`、`/ifa/status`、`/upload/status` 映射成既有那 7 条行）。
       · 这里按**既有渲染节拍**调用 `SelfCheckProbe.ensure(state)`：内部 5 s 节流 + 在途去重
         ⇒ **不新起定时器**、不会每秒重复打服务端；探测结果写进 `state.selfCheck` 后本函数照旧渲染。
       · **演示模式一行都不动**：`ensure()` 在非服务端模式下立即返回 false，
         `state.selfCheck` 仍由 `mockData.buildSelfCheck()` 提供（成对断言见 ui-check 的 W7-B-c）。
       · 探测失败**绝不影响本帧渲染**：`ensure()` 不抛（它自己把每项失败收敛成行结论）。 */
    try {
      if (window.SelfCheckProbe && typeof window.SelfCheckProbe.ensure === 'function') {
        window.SelfCheckProbe.ensure(state);
      }
    } catch (err) {
      console.warn('[SettingPanel] 自检探测触发异常（已跳过，不影响渲染）：' + ((err && err.message) || String(err)));
    }
    setHTML('setSelfCheckList', (state.selfCheck || []).map(c =>
      `<div class="list-item lv-${esc(c.lv)}"><span class="body">${esc(c.name)}</span>` +
      `<span class="meta ${esc(c.lv)}">${esc(c.state)}</span></div>`).join('') ||
      /* 服务端模式下首帧快照还没被探测结果填上时（`state.selfCheck` 暂空），给出**显式进行中**占位
         —— 不留空白，也不假装"七项全过"（演示模式永远有 7 行，走不到这里）。 */
      '<div class="list-item lv-info is-empty"><span class="body empty-note">' +
      '尚未接入服务端自检结果：正在探测 /health、/ifd/status、/upload/status…</span></div>');

    /* 操作日志（FR-8.7 / NFR-15）：解锁后的写操作全程留痕；展示取最近 20 条、时间倒序 */
    const logs = (state.opLog || []).slice().reverse();
    setHTML('setOpLogList', logs.length
      ? logs.map(o =>
          `<div class="list-item lv-info"><span class="body"><b class="mono">${esc(o.time)}</b> ${esc(o.action)}` +
          (o.detail ? `<br>${esc(o.detail)}` : '') + `</span>` +
          `<span class="meta mono">${esc(o.operator)}</span></div>`).join('')
      : '<div class="list-item lv-info is-empty"><span class="body empty-note">' +
        '暂无操作日志（解锁后的维保录入 / 公告发布 / 参数修改都会留痕）</span></div>');
  }

  /* ---------------- 交互绑定 ---------------- */
  /**
   * @param {object}   state      数据状态
   * @param {Function} onActivity 有操作时回调（用于重置"无操作自动返回首页"计时，FR-9.4）。
   *        注意分工：本回调**只**管回首页计时；锁定计时由本函数内的 `noteActivity()`
   *        另外调 `armAutoLock()` 完成（与任务页 `TaskPanel.activity()` 的双动作同一口径）。
   */
  function bind(state, onActivity) {
    const M = window.MockData;
    const input = $('setPwd');
    const msg = $('setMsg');
    const entryMsg = $('entryMsg');

    /* 提示信息短暂显示后恢复默认文案 */
    function flashEntry(text, isErr) {
      entryMsg.dataset.sticky = '1';
      entryMsg.textContent = text;
      entryMsg.className = 'entry-note ' + (isErr ? 'err' : 'ok');
      setTimeout(() => { delete entryMsg.dataset.sticky; render(state); }, 4000);
    }

    /* FR-8.2：解锁后启动自动锁定计时；超时或手动锁定时清除 */
    function armAutoLock() {
      if (autoLockTimer) clearTimeout(autoLockTimer);
      autoLockTimer = setTimeout(() => {
        autoLockTimer = null;
        if (!state.unlocked) return;
        M.setUnlocked(false);
        /* ADR-0007 D5：5 分钟到点**同步调 `logout`**（令牌即失效）——
           "前端计时器与服务端令牌不各管一套"。**只在服务端模式下调**：演示模式没有服务端会话，
           也不该因为一次自动锁定发出任何请求（演示模式行为逐字不变）。 */
        if (serverMode(state)) logoutSession();
        M.pushLog('自动锁定', '解锁后超过 5 分钟，系统自动回到锁定状态');
        msg.textContent = '解锁已超过 5 分钟，系统已自动锁定';
        msg.className = 'pwd-msg';
        showAutoLockTip();          /* FR-8.2：仅"自动锁定"弹提示弹窗（手动点「锁定」不弹），2 s 后自动消失 */
        render(state);
      }, AUTO_LOCK_MS);
    }
    function clearAutoLock() {
      if (autoLockTimer) { clearTimeout(autoLockTimer); autoLockTimer = null; }
    }
    /* 把同一份 arm/clear 逻辑暴露给模块级 `armAutoLock()`（见文件顶部变量注释）：
       旁路解锁（?unlock=1）与手动解锁走的是**同一个定时器与同一个回调**，行为完全一致。 */
    autoLockArmer = { arm: armAutoLock, clear: clearAutoLock };

    /**
     * 登出服务端会话（ADR-0007 D5：自动锁定 / 手动锁定都走这一条出口，不各管一套）。
     * **同步发起**（`BoardSession.logout()` 内部**先清本地令牌**再发请求 ⇒ 返回时本地已失效）；
     * 失败只如实 `console.warn`，**绝不抛**（锁定这一事实不因登出请求失败而改变）。
     */
    function logoutSession() {
      const bs = session();
      if (!bs || typeof bs.logout !== 'function') return;
      try {
        bs.logout().then(r => {
          if (r && r.ok === false && !r.skipped) {
            console.warn('[SettingPanel] 服务端登出未成功（本地令牌已清除，界面按未登录处理）：' +
              ((r && (r.reason || r.errorCode)) || '未知原因'));
          }
        }).catch(err => {
          console.warn('[SettingPanel] 服务端登出异常（本地令牌已清除，界面按未登录处理）：' +
            ((err && err.message) || String(err)));
        });
      } catch (err) {
        console.warn('[SettingPanel] 服务端登出同步抛错（本地令牌已在 logout 内清除）：' +
          ((err && err.message) || String(err)));
      }
    }

    /* FR-8.2 / FR-3.19⑧ / C-84③：设置页的**每一个写操作与录入框键入**都按任务页**同一口径**刷新 ——
       ① `onActivity()` 重置 FR-9.4"无操作自动返回首页"计时；
       ② `armAutoLock()` 重挂 FR-8.2 的 5 分钟锁定计时（内部先 clearTimeout 再计时，不堆叠第二个定时器）。
       为什么是这两个动作：任务页 `TaskPanel.activity()`（见 src/components/TaskPanel.js 的注释
       "与设置页**同一份**计时逻辑…不另起第二个定时器"）就是这两步；本页先前只做了①，
       于是设置页保存/键入后锁定计时不刷新（审查 R-2026-09-26 的 R26-P2-1）。
       `armAutoLock()` 即便在锁定态被调用也只是登记一个到点即 return 的计时（回调内有解锁态守卫），
       故此处不做状态分支，保持与任务页逐字同口径。 */
    function noteActivity() {
      onActivity();
      armAutoLock();
    }

    /* FR-8.2 / C-84③：锁定后的保存**不得静默失效**。复用本页既有的 #entryMsg 提示机制
       （与"请填写…后再保存"同一处文案位、同样 4 s 后自动恢复默认文案），给出可观察反馈。
       ⚠ 演示模式那句**逐字不变**（含"演示密码 8888"）；服务端模式**不得**出现演示口令（D4）。 */
    function denyLocked(action) {
      flashEntry(serverMode(state)
        ? `当前已锁定：${action}未保存，请先在左侧输入解锁密码（服务端校验）`
        : `当前已锁定：${action}未保存，请先在左侧输入解锁密码（演示密码 8888）`, true);
    }

    /**
     * 演示模式的解锁（**行为与接线前逐字不变**，ADR-0007 D5 明示保留）。
     * 这里的比对对象**只是演示口令**（`MockData.CFG.unlockPassword`，`8888` 仅此模式存在）——
     * 它**不是**口令校验的实现：服务端模式一个字节都不走这条路（下面的 `tryUnlockServer`）。
     */
    function tryUnlockDemo() {
      // 演示实现：真实系统须由服务端校验口令（NFR-14），不得在前端存放明文
      if (input.value === M.CFG.unlockPassword) {
        M.setUnlocked(true);
        M.pushLog('解锁', '输入解锁口令成功（演示实现，正式系统由服务端校验）');
        msg.textContent = '解锁成功，维保录入与公告修改已开放（5 分钟无操作自动锁定）';
        msg.className = 'pwd-msg ok';
        input.value = '';
        armAutoLock();
      } else {
        msg.textContent = '密码错误，请重新输入（演示密码：8888）';
        msg.className = 'pwd-msg err';
      }
      render(state);
      noteActivity();
    }

    /**
     * 服务端模式的解锁（FR-8.1 / ADR-0007 D5）＝把口令**原样**交给 `POST /auth/login`：
     * 本页**不比对、不哈希、不计数、不判定锁定** —— 服务端给什么就显示什么：
     *   · 200 ⇒ 保存会话令牌（`sessionStorage`）并置解锁位；
     *   · 401 `bad_credentials` ⇒ 口令不正确（对外不区分"用户不存在"，D2）；
     *   · 423 `locked` ⇒ 如实显示 `retryAfterSec` 剩余秒数（锁定期间口令正确也拒，D2/D8①）；
     *   · 409 `not_initialized` ⇒ 提示走**本机**一次性初始化（D4），并显示初始化行；
     *   · 其余（403 非回环 / 400 / 网络失败）⇒ 一律落到 `#setMsg` 与 `#entryMsg`（**绝不静默**）。
     */
    function tryUnlockServer() {
      const bs = session();
      const pwd = String(input.value === undefined || input.value === null ? '' : input.value);
      if (!bs || typeof bs.login !== 'function') {
        msg.textContent = '服务端登录未装配：window.BoardSession 不可用（检查 index.html 是否已注册 src/services/auth.js）';
        msg.className = 'pwd-msg err';
        flashEntry('解锁未提交：服务端登录出口未装配（window.BoardSession 不可用）', true);
        return;
      }
      if (!pwd) {
        msg.textContent = '请输入解锁口令（服务端口令由 POST /auth/login 校验）';
        msg.className = 'pwd-msg err';
        return;
      }
      msg.textContent = '正在提交服务端校验…';
      msg.className = 'pwd-msg';
      bs.login(pwd).then(r => {
        if (r && r.ok) {
          M.setUnlocked(true);
          M.pushLog('解锁', '服务端校验通过（POST /auth/login）：已取得会话令牌（本窗口内存 + sessionStorage）');
          msg.textContent = '解锁成功，维保录入与公告修改已开放（5 分钟无操作自动锁定）';
          msg.className = 'pwd-msg ok';
          input.value = '';
          needsInit = false;
          armAutoLock();
          render(state);
          noteActivity();
          return;
        }
        msg.className = 'pwd-msg err';
        const code = String((r && r.errorCode) || '');
        const status = r ? r.status : null;
        const why = (r && r.reason) ? String(r.reason) : '未知原因';
        if (status === 423) {
          /* D2/D8①：锁定中（口令正确也拒）——**如实显示剩余秒数**（由服务端注入时钟算出） */
          const sec = (r && r.retryAfterSec !== undefined && r.retryAfterSec !== null)
            ? Number(r.retryAfterSec) : null;
          msg.textContent = '账号已锁定：请在 ' +
            (sec === null || !Number.isFinite(sec) ? '服务端给出的剩余时间后' : sec + ' 秒后') +
            '重试（口令正确也会被拒；连续失败 5 次锁定 5 分钟）' +
            (r && r.lockedUnknown === true ? '［服务端：锁定时间不可解析，从严按锁定处理］' : '');
          flashEntry('解锁被拒（HTTP 423 locked）：账号锁定中，' +
            (sec === null || !Number.isFinite(sec) ? '请稍后重试' : '剩余 ' + sec + ' 秒') +
            '（服务端令牌未下发）', true);
        } else if (status === 409) {
          /* D4：无凭证行 ⇒ 未初始化。**唯一**初始化入口是本机回环 + 一次性初始化码（不设默认口令） */
          needsInit = true;
          msg.textContent = '服务端尚未初始化（409 not_initialized）：请在本机用服务端控制台打印的' +
            '一次性初始化码设置口令（下方「口令初始化」，仅回环可用）';
          flashEntry('解锁被拒（HTTP 409 not_initialized）：服务端尚无凭证行，请先在本机初始化口令' +
            '（一次性码由服务端在本机给出；不设默认口令）', true);
        } else if (status === 401 && (code === 'bad_credentials' || code === '')) {
          msg.textContent = '密码错误，请重新输入（服务端校验；连续失败 5 次将锁定 5 分钟）';
          flashEntry('解锁被拒（HTTP 401 bad_credentials）：口令不正确（服务端对外不区分原因）', true);
        } else if (status === 401) {
          msg.textContent = '登录态无效：' + why + '，请重新输入口令';
          flashEntry('解锁被拒（HTTP 401 ' + (code || 'unauthorized') + '）：' + why, true);
        } else {
          msg.textContent = '解锁失败：' + (status === null ? '' : 'HTTP ' + status + ' ') + why;
          flashEntry('解锁未成功：' + (status === null ? '' : 'HTTP ' + status + ' ') + why, true);
        }
        render(state);            /* 统一 401 处理/初始化态的可见降级由 render 落到 #entryMsg 与模式提示 */
        noteActivity();
      }).catch(err => {
        /* 兜最后一层：`BoardSession` 已自收敛，这里只是保证"绝不抛未捕获异常" */
        msg.textContent = '解锁失败：' + ((err && err.message) || String(err));
        msg.className = 'pwd-msg err';
        flashEntry('解锁未成功：' + ((err && err.message) || String(err)), true);
      });
    }

    /** 解锁入口：**两条互不干扰的路径**（ADR-0007 D5）——服务端模式强制登录，演示模式走演示口令 */
    function tryUnlock() {
      if (serverMode(state)) { tryUnlockServer(); return; }
      tryUnlockDemo();
    }

    /* 关键参数配置：把配置文件当前值载入输入框（只在绑定时写一次，避免秒级刷新覆盖用户输入） */
    $('cfgEquipCode').value = M.CFG.equipCode;
    $('cfgUpperUrl').value = CFG.upper.url || '';
    $('cfgMesUrl').value = CFG.mes.baseUrl || '';
    $('cfgWarnDays').value = String(M.CFG.maintWarnDays);

    /* ADR-0007 D1/D5：服务端口令口径是 **4～64 位**，而 `#setPwd` 的 `maxlength="8"` 是按演示口令
       8888 定的 ⇒ **服务端模式**放宽到 64（否则现场设的长口令根本打不进来）。
       演示模式**一字不改**（仍是 8）—— 这就是"演示模式行为逐字不变"的一部分。 */
    if (serverMode(state)) input.maxLength = SERVER_PWD_MAX;

    /* ADR-0007 D4/D5：`index.html` 的**静态初值**是演示模式的文案（"演示密码：8888"）——
       服务端口径里**不得**出现演示口令（D4 明令）。故服务端模式下在绑定时**一次性**换成本模式的文案：
         · `#setMsg` 是提示位，服务端模式下 `render()` **不**改写它（只有解锁/改密动作会写）⇒ 必须在这里初始化；
         · `#entryMsg` 由 `render()` 每帧维护（服务端模式下第一帧就会写成"未登录或登录已过期…"），
           这里顺手换掉只是为了"静态初值也不出现演示口令"。
       演示模式**一字不改**（下面这段整段不执行）⇒ 10 张截图基准与本模式行为都不受影响。 */
    if (serverMode(state)) {
      if (/演示密码|8888/.test(String(msg.textContent || ''))) {
        msg.textContent = '服务端口令由服务端校验（POST /auth/login）';
      }
      if (/演示密码|8888/.test(String(entryMsg.textContent || ''))) {
        entryMsg.textContent = '当前已锁定：未登录或登录已过期，请先在左侧输入解锁密码（口令由服务端校验）';
      }
    }

    /**
     * 改密（FR-8.4 / ADR-0007 D5）：原口令 + 新口令 + 确认 ⇒ `POST /auth/change`（Bearer）。
     * 成功后**强制清当前会话并要求重新登录**（服务端已清该用户全部在途会话，D8④）。
     * 前端只做两件**本地**事：两项非空、两次输入一致（确认框存在的意义）；
     * 口令策略（4～64 位 / 不得与原口令相同）与"原口令是否正确"**全部由服务端判** ——
     * 这里**不比对**任何口令（D5：不得在浏览器里做哈希/比对/计数/锁定判定）。
     */
    function doPwdChange() {
      if (!serverMode(state)) {
        flashEntry('演示模式未启用服务端口令校验：修改密码仅在服务端模式可用（口令由服务端校验）', true);
        return;
      }
      const bs = session();
      if (!bs || typeof bs.change !== 'function') {
        flashEntry('改密未提交：服务端会话出口未装配（window.BoardSession 不可用）', true);
        return;
      }
      const oldPw = String($('setOldPwd').value === undefined ? '' : $('setOldPwd').value);
      const newPw = String($('setNewPwd').value === undefined ? '' : $('setNewPwd').value);
      const again = String($('setNewPwd2').value === undefined ? '' : $('setNewPwd2').value);
      if (!oldPw || !newPw) { flashEntry('请填写原口令与新口令后再提交改密', true); return; }
      if (newPw !== again) { flashEntry('两次输入的新口令不一致：本次不提交（服务端未收到任何改密请求）', true); return; }
      msg.textContent = '正在提交服务端改密…';
      msg.className = 'pwd-msg';
      bs.change(oldPw, newPw).then(r => {
        if (r && r.ok) {
          $('setOldPwd').value = ''; $('setNewPwd').value = ''; $('setNewPwd2').value = '';
          M.setUnlocked(false);                    /* D5：改密成功后**强制**清当前会话并要求重新登录 */
          clearAutoLock();
          msg.textContent = '口令已修改：当前会话已被服务端清除，请用新口令重新解锁';
          msg.className = 'pwd-msg ok';
          flashEntry('口令已修改（服务端已换盐换派生值并清空全部在途会话）：本窗口登录态已清除，请用新口令重新解锁', false);
          render(state);
          return;
        }
        msg.className = 'pwd-msg err';
        const status = r ? r.status : null;
        const code = String((r && r.errorCode) || '');
        const why = (r && r.reason) ? String(r.reason) : '未知原因';
        if (status === 401 && code === 'bad_credentials') {
          msg.textContent = '原口令不正确（服务端校验失败，会话未清除）';
          flashEntry('改密被拒（HTTP 401 bad_credentials）：原口令不正确，服务端未改任何东西', true);
        } else if (status === 401) {
          msg.textContent = '未登录或登录已过期，请重新解锁后再改密';
          flashEntry('改密被拒（HTTP 401 ' + (code || 'unauthorized') + '）：' + why + '；请重新解锁', true);
        } else if (status === 409) {
          needsInit = true;
          msg.textContent = '凭证行不存在（409）：请先在本机重新初始化口令';
          flashEntry('改密被拒（HTTP 409）：' + why, true);
        } else if (status === 400) {
          msg.textContent = '新口令不符合口径：' + why;
          flashEntry('改密被拒（HTTP 400 ' + (code || 'bad_password') + '）：' + why, true);
        } else {
          msg.textContent = '改密失败：' + (status === null ? '' : 'HTTP ' + status + ' ') + why;
          flashEntry('改密未成功：' + (status === null ? '' : 'HTTP ' + status + ' ') + why, true);
        }
        render(state);
      }).catch(err => {
        msg.textContent = '改密失败：' + ((err && err.message) || String(err));
        msg.className = 'pwd-msg err';
        flashEntry('改密未成功：' + ((err && err.message) || String(err)), true);
      });
    }

    /**
     * 本机一次性初始化（ADR-0007 D4）：`POST /auth/init {code, password}` —— **唯一**初始化入口。
     * 两条硬约束由**服务端**判：①请求必须来自回环；②码必须是本次进程启动生成的那一枚（用后即废）。
     * 前端只是转发：**不设默认口令**、不生成码、不做任何本地放行（D4 明令禁止默认口令进服务端口径）。
     */
    function doInitPassword() {
      /* 演示模式**不碰**服务端：该行在演示模式下恒 `hidden`，但按钮监听是照绑的 ⇒ 这里再显式挡一层，
         保证"即使被脚本点到"也**不会**朝服务端发一次初始化请求（演示模式行为逐字不变的硬要求）。 */
      if (!serverMode(state)) {
        flashEntry('演示模式未启用服务端口令校验：口令初始化仅在服务端模式可用（一次性码由服务端在本机给出）', true);
        return;
      }
      const bs = session();
      if (!bs || typeof bs.init !== 'function') {
        flashEntry('初始化未提交：服务端会话出口未装配（window.BoardSession 不可用）', true);
        return;
      }
      const code = String($('setInitCode').value === undefined ? '' : $('setInitCode').value).trim();
      const pwd = String($('setInitPwd').value === undefined ? '' : $('setInitPwd').value);
      if (!code || !pwd) { flashEntry('请填写一次性初始化码与要设置的口令后再初始化（两项都必填）', true); return; }
      msg.textContent = '正在提交本机初始化…';
      msg.className = 'pwd-msg';
      bs.init(code, pwd).then(r => {
        if (r && r.ok) {
          needsInit = false;
          $('setInitCode').value = ''; $('setInitPwd').value = '';
          msg.textContent = '口令初始化成功：请用刚设置的口令解锁（一次性初始化码已立即作废）';
          msg.className = 'pwd-msg ok';
          flashEntry('口令初始化成功（服务端已写入派生值与独立盐；一次性初始化码已立即作废）：请用新口令解锁', false);
          render(state);
          return;
        }
        msg.className = 'pwd-msg err';
        const status = r ? r.status : null;
        const code2 = String((r && r.errorCode) || '');
        const why = (r && r.reason) ? String(r.reason) : '未知原因';
        if (status === 403 && code2 === 'not_loopback') {
          msg.textContent = '初始化只允许来自本机回环（403 not_loopback）：请在本机浏览器打开设置页';
          flashEntry('初始化被拒（HTTP 403 not_loopback）：' + why, true);
        } else if (status === 401) {
          msg.textContent = '一次性初始化码不正确或已作废（401 ' + (code2 || 'bad_init_code') + '）：见服务端控制台打印的码';
          flashEntry('初始化被拒（HTTP 401 ' + (code2 || 'bad_init_code') + '）：' + why, true);
        } else if (status === 409) {
          needsInit = false;
          msg.textContent = '服务端已初始化过（409 ' + (code2 || 'already_initialized') + '）：请直接解锁';
          flashEntry('初始化被拒（HTTP 409 ' + (code2 || 'already_initialized') + '）：' + why, true);
          /* 用只读的 `GET /auth/status`（**无需鉴权**、不含秘密，D8⑦）把服务端实况补进提示，
             避免"已初始化过"这句在操作人看来无从下手（还剩几次会话/是否锁定服务端说了算）。 */
          if (typeof bs.status === 'function') {
            bs.status().then(st => {
              if (!st || !st.ok) return;
              setText('setAuthNote', SERVER_MODE_NOTE + '；服务端已初始化（在途会话 ' +
                (st.sessions === undefined ? '—' : st.sessions) + ' 个' +
                (st.locked === true ? '；当前处于锁定中，剩余 ' + (st.retryAfterSec || 0) + ' 秒' : '') + '）');
            }).catch(() => { /* 只读状态取不到不影响任何判定：提示位保持上面那句 */ });
          }
        } else if (status === 400) {
          msg.textContent = '口令不符合口径：' + why;
          flashEntry('初始化被拒（HTTP 400 ' + (code2 || 'bad_password') + '）：' + why, true);
        } else {
          msg.textContent = '初始化失败：' + (status === null ? '' : 'HTTP ' + status + ' ') + why;
          flashEntry('初始化未成功：' + (status === null ? '' : 'HTTP ' + status + ' ') + why, true);
        }
        render(state);
      }).catch(err => {
        msg.textContent = '初始化失败：' + ((err && err.message) || String(err));
        msg.className = 'pwd-msg err';
        flashEntry('初始化未成功：' + ((err && err.message) || String(err)), true);
      });
    }

    $('setUnlockBtn').addEventListener('click', tryUnlock);
    /* 服务端模式独有的两个入口（演示模式下这两行恒 `hidden`，本监听永不命中 ⇒ 行为一字不变）：
       · 「修改密码」（FR-8.4）：原口令 + 新口令 + 确认；
       · 「口令初始化」（ADR-0007 D4）：一次性初始化码 + 要设置的口令（仅本机回环可用）。 */
    $('setPwdChangeBtn').addEventListener('click', doPwdChange);
    $('setInitBtn').addEventListener('click', doInitPassword);
    /* 密码框键入也属于"设置页键入"：同样刷新回首页计时与 5 分钟锁定计时（原实现只调 onActivity()）。
       回车另走 tryUnlock()（其内部已 noteActivity()），故对回车不重复刷新。 */
    input.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); else noteActivity(); });

    /* FR-8.2：录入框键入刷新计时（原实现只有密码框绑了 keydown ⇒ 维保内容/公告正文/参数四框
       键入不触发任何刷新）。只绑 keydown，与密码框同一写法，不新增定时器。 */
    ['maintContent', 'maintOwner', 'noticeText',
     'cfgEquipCode', 'cfgUpperUrl', 'cfgMesUrl', 'cfgWarnDays']
      .forEach(id => { $(id).addEventListener('keydown', noteActivity); });

    $('setLockBtn').addEventListener('click', () => {
      clearAutoLock();          /* 手动锁定：只清锁定计时，**不**重挂（锁定态无需再计时） */
      if (state.unlocked) M.pushLog('手动锁定', '操作人手动锁定看板输入');
      M.setUnlocked(false);
      /* ADR-0007 D5：锁定 ⇒ 服务端会话**同步**失效（自动锁定与手动锁定走同一条出口，
         不留"界面已锁、令牌还在"的分裂状态）。演示模式不调：没有服务端会话，行为逐字不变。 */
      if (serverMode(state)) logoutSession();
      msg.textContent = '已锁定';
      msg.className = 'pwd-msg';
      render(state);
      onActivity();             /* 仅刷新 FR-9.4 回首页计时（见上方 clearAutoLock 注释） */
    });

    $('setSyncBtn').addEventListener('click', () => {
      /* FR-8.2 / C-84③：与上方三处保存**同一口径**的锁定守卫（E35）。
         原先此处既无锁定判断也无 `flashEntry`：真机上 `#setSyncBtn` 的 `disabled` 使得本缺口当前
         不可达，但把按钮改回可点（或键盘/脚本触发）就会在**锁定态**写下 `pushLog('时间同步')` 并
         提示"NTP 同步完成" —— 属防御性缺口，按三处保存的既有处置补上（复用 `denyLocked()`，
         不新造提示机制）。 */
      if (!state.unlocked) { denyLocked('时间同步'); return; }
      msg.textContent = 'NTP 同步完成（模拟）';
      msg.className = 'pwd-msg ok';
      M.pushLog('时间同步', '手动触发 NTP 同步（模拟）');
      noteActivity();           /* FR-8.2：时间同步属设置页写操作，同样刷新两套计时 */
    });
    $('setManualBtn').addEventListener('click', () => {
      msg.textContent = '演示版本不支持修改系统时间';
      msg.className = 'pwd-msg';
      noteActivity();
    });

    /* 维保录入（FR-6.11）：演示仅写入前端内存，真实系统须落库 + 留痕 */
    $('maintSave').addEventListener('click', () => {
      if (!state.unlocked) { denyLocked('维保记录'); return; }   /* FR-8.2 / C-84③：不静默失效 */
      const content = $('maintContent').value.trim();
      if (!content) { flashEntry('请填写检修内容后再保存', true); return; }
      const owner = $('maintOwner').value.trim() || '—';
      const mstate = $('maintState').value;
      state.maint.records.unshift({
        time: `${state.clock.date} ${state.clock.time.slice(0, 5)}`,
        content, owner, state: mstate
      });
      state.maint.records = state.maint.records.slice(0, 6);
      $('maintContent').value = ''; $('maintOwner').value = '';
      M.pushLog('维保录入', `检修内容：${content}；责任人：${owner}；验收状态：${mstate}`);
      window.Components.MaintPanel.render(state);
      flashEntry('维保记录已保存并记录操作日志（演示）', false);
      noteActivity();
    });

    /* ---- FR-7.12（T-20261002-08）：服务端公告写入（发布/编辑/删除共用一个出口） ----
       走 `Api.httpJson()`（**全仓唯一的服务端 HTTP 出口**，不另起第二套 fetch）；
       成功 ⇒ 用响应里的 `notices`（与 `GET /state` 同源、同一份投影）就地刷新，不重拉快照；
       失败 ⇒ 一律落到 `#entryMsg`（与"锁定后保存"同一处可见反馈位），**绝不静默**。 */
    function postNotice(st, payload, okText) {
      const api = window.Api;
      if (!api || typeof api.httpJson !== 'function') {
        flashEntry('公告未保存：服务端接口未装配（window.Api.httpJson 不可用）', true);
        return;
      }
      const token = sessionToken(st);
      const headers = token ? { Authorization: 'Bearer ' + token } : {};
      api.httpJson('/notice', { method: 'POST', body: payload, headers }).then(r => {
        if (!r || r.ok !== true) {
          const body = r && r.body;
          const code = (body && ((body.err && body.err.code) || body.error)) || '';
          const why = (body && body.err && body.err.message) || (r && (r.failReason || r.error)) || '未知原因';
          flashEntry('公告未保存（HTTP ' + ((r && r.status) || '—') + (code ? ' ' + code : '') + '）：' + why, true);
          /* ADR-0007 D5：**统一 401 处理**的界面动作要**当帧**落地（不等下一秒的渲染循环）——
             若是会话失效，`services/api.js` 已在 HTTP 出口清掉令牌并记账，这里 render 一次即可
             把"未登录或登录已过期"写进 `#entryMsg`/`#setAuthNote` 并**如实降级**回锁定态。
             `flashEntry` 已把 `#entryMsg` 置为 sticky ⇒ 本次 render 不会覆盖上面那句失败提示。 */
          render(st);
          return;
        }
        /* 服务端已落库（且已写 op_log）⇒ 用响应里的同一份投影刷新界面 */
        if (r.body && r.body.notices && typeof r.body.notices === 'object') {
          st.notices = {
            notices: Array.isArray(r.body.notices.notices) ? r.body.notices.notices : [],
            tips: Array.isArray(r.body.notices.tips) ? r.body.notices.tips : [],
            todo: []
          };
        }
        noticeEditingId = null;
        render(st);
        try { window.Components.NoticePanel.render(st); } catch (err) {
          console.warn('[SettingPanel] 公告刷新渲染异常（服务端已保存，界面下一帧会补上）：' +
            ((err && err.message) || String(err)));
        }
        flashEntry(okText, false);
      }).catch(err => {
        /* 网络异常/超时：同样**可见**（`httpJson` 通常自己收敛成 ok:false，这里兜最后一层） */
        flashEntry('公告未保存：' + ((err && err.message) || String(err)), true);
      });
    }

    /** 在 `state.notices.notices` 里按 id 找那一条（找不到 ⇒ null：**不猜**） */
    function noticeById(st, id) {
      const list = (st && st.notices && st.notices.notices) || [];
      const key = String(id);
      for (const x of list) { if (x && String(x.id) === key) return x; }
      return null;
    }

    /** 点「编辑」：把该条内容装进 `#noticeText` 并进入编辑态（**再点一次同一条＝取消**） */
    function startEditNotice(st, id) {
      const hit = noticeById(st, id);
      if (!hit) { flashEntry('找不到这条公告（列表可能已刷新），请重新选择', true); return; }
      if (noticeEditingId !== null && String(noticeEditingId) === String(hit.id)) {
        noticeEditingId = null;
        $('noticeText').value = '';
        render(st);
        flashEntry('已取消编辑（回到「发布公告」）', false);
        noteActivity();
        return;
      }
      noticeEditingId = hit.id;
      $('noticeText').value = hit.text === undefined || hit.text === null ? '' : String(hit.text);
      /* 类型回填：值不在下拉项里时赋值不生效（select 的选项集**不由本包改动**） */
      if (hit.tag) $('noticeType').value = String(hit.tag);
      render(st);
      flashEntry('正在编辑公告 #' + hit.id + '：改完点「保存修改」（再点一次「编辑」可取消）', false);
      noteActivity();
    }

    /** 点「删除」：二次确认后提交（删除是**硬删**；原文由服务端写进 `op_log`，见 `repo/notice.js` 文件头） */
    function requestDeleteNotice(st, id) {
      const hit = noticeById(st, id);
      if (!hit) { flashEntry('找不到这条公告（列表可能已刷新），请重新选择', true); return; }
      const ask = '删除公告 #' + hit.id + '？\n删除后原文仍保留在服务端操作日志（op_log）里。';
      /* `confirm` 不可用（桩件/裁剪环境）⇒ 不拦，直接提交：**不得**因为环境缺 API 就让删除静默失效 */
      if (typeof window.confirm === 'function' && !window.confirm(ask)) return;
      postNotice(st, { action: 'delete', id: hit.id },
        '公告 #' + hit.id + ' 已删除（原文已写入服务端操作日志 op_log）');
      noteActivity();
    }

    /* FR-7.12：公告列表里的「编辑 / 删除」入口用**一个委托监听**（入口按钮由 `NoticePanel`
       只在服务端模式渲染；演示模式下这些节点根本不存在 ⇒ 本监听永不命中，行为一字不变）。
       为什么不改 `pages/Dashboard.js` 的装配顺序、也不给每条公告各挂一个监听：
       一个监听点即可覆盖"列表整体重渲染"，且不动本页之外的装配生命周期。 */
    const noticeListEl = $('ntNoticeList');
    if (noticeListEl && typeof noticeListEl.addEventListener === 'function') {
      noticeListEl.addEventListener('click', e => {
        const hit = actionButtonOf(e && e.target);
        if (!hit) return;
        if (hit.act !== 'edit' && hit.act !== 'delete') return;   /* 未知动作：忽略（不猜） */
        if (!state.unlocked) {                                    /* FR-8.2 / C-84③：不静默失效 */
          denyLocked(hit.act === 'edit' ? '公告编辑' : '公告删除');
          return;
        }
        if (hit.act === 'edit') startEditNotice(state, hit.id);
        else requestDeleteNotice(state, hit.id);
      });
    }

    /* 公告发布（FR-7.12） */
    $('noticeSave').addEventListener('click', () => {
      if (!state.unlocked) { denyLocked('公告'); return; }       /* FR-8.2 / C-84③：不静默失效 */
      const text = $('noticeText').value.trim();
      if (!text) { flashEntry('请填写公告内容后再发布', true); return; }
      const type = $('noticeType').value;
      /* FR-7.12（T-20261002-08）：**服务端模式走真实路由**（`POST /notice`）——失败可见、绝不静默；
         演示模式保持原行为（写内存 ＋ 操作日志），版面与行为**一字不变**。 */
      if (serverMode(state)) {
        const editing = noticeEditingId;
        postNotice(state, editing === null
          ? { action: 'publish', content: text, subType: type }
          : { action: 'edit', id: editing, content: text, subType: type },
        editing === null
          ? '公告已发布（服务端已落库并写入操作日志 op_log）'
          : '公告 #' + editing + ' 已保存修改（服务端已落库并写入操作日志 op_log）');
        $('noticeText').value = '';
        noteActivity();
        return;
      }
      /* 复用 state.clock（每秒刷新），不再手工拼 HH:MM（P3-7） */
      const hhmm = state.clock.time.slice(0, 5);
      state.notices.notices.unshift({ tag: type, text, lv: 'info', time: hhmm });
      state.notices.notices = state.notices.notices.slice(0, 6);
      $('noticeText').value = '';
      M.pushLog('公告发布', `公告类型：${type}；内容：${text}`);
      window.Components.NoticePanel.render(state);
      flashEntry('公告已发布并记录操作日志（演示）', false);
      noteActivity();
    });

    /* 关键参数配置保存（FR-8.6）：写入配置与运行时参数，并记录操作日志 */
    $('cfgSaveBtn').addEventListener('click', () => {
      if (!state.unlocked) { denyLocked('参数'); return; }       /* FR-8.2 / C-84③：不静默失效 */
      const code = $('cfgEquipCode').value.trim();
      const upperUrl = $('cfgUpperUrl').value.trim();
      const mesUrl = $('cfgMesUrl').value.trim();
      const warnDays = Number($('cfgWarnDays').value.trim());
      const changed = [];
      if (code && code !== M.CFG.equipCode) {
        M.CFG.equipCode = code; CFG.device.equipCode = code; state.device.code = code;
        changed.push(`设备编号=${code}`);
      }
      if (upperUrl !== (CFG.upper.url || '')) {
        CFG.upper.url = upperUrl;
        changed.push(`上位机地址=${upperUrl || '（已清空）'}`);
      }
      if (mesUrl !== (CFG.mes.baseUrl || '')) {
        CFG.mes.baseUrl = mesUrl;
        changed.push(`MES 地址=${mesUrl || '（已清空）'}`);
      }
      if (Number.isFinite(warnDays) && warnDays > 0 && warnDays !== M.CFG.maintWarnDays) {
        M.CFG.maintWarnDays = warnDays;
        state.maint.warnDays = warnDays;
        changed.push(`维保预警阈值=${warnDays} 天`);
      }
      if (!changed.length) { flashEntry('参数未发生变化，无需保存', true); noteActivity(); return; }
      M.pushLog('参数配置', changed.join('；'));
      flashEntry('参数已保存并记录操作日志：' + changed.join('；') + '（地址类参数刷新页面后生效）', false);
      render(state);
      noteActivity();
    });
  }

  /**
   * FR-8.2：arm 自动锁定（导出接口，供 `?unlock=1` 旁路等**非设置页**解锁路径复用）。
   *
   * 行为与设置页手动解锁（`#setUnlockBtn` → tryUnlock → armAutoLock）**完全一致**：
   * 登记一个 AUTO_LOCK_MS（300000 ms = 5 分钟）定时器；到点若仍处于解锁态则
   * `setUnlocked(false)` + 写操作日志 + 弹 2 s 提示（#autoLockTip，AUTO_LOCK_TIP_MS = 2000）；
   * 重复调用会先 clearTimeout 再重新计时，**不堆叠定时器**。
   *
   * @returns {boolean} true = 已登记计时；false = 尚未 bind()（此时设置页未装配，无法自动锁定，
   *          调用方应视为配置错误而不是静默放过 —— 故同时 console.warn 提示）
   */
  function armAutoLock() {
    if (!autoLockArmer) {
      console.warn('[SettingPanel] armAutoLock() 在 bind() 之前被调用：自动锁定未登记（FR-8.2）');
      return false;
    }
    autoLockArmer.arm();
    return true;
  }

  return { render, bind, armAutoLock };
})();
