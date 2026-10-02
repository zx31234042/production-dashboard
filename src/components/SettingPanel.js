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

  /* ---------------- FR-7.12（T-20261002-08）：服务端模式下的公告新增/编辑/删除 ----------------
     需求原文（`需求文档\…-V1.41.md:533`）：「**仅本机解锁后可新增/编辑/删除公告**」。
     本模块此前只有"发布"一条内存路径（刷新即丢）⇒ 本波把它接到服务端的 `POST /notice`
     （唯一写入口＝`server/repo/notice.js`，落 `notice` 表并**同批**写 `op_log`）。
     边界（本包**不做**、也不假装做）：
       · **解锁仍走既有演示口令**（`MockData.CFG.unlockPassword`）：服务端会话令牌（ADR-0007 的
         `POST /auth/login`）的前端接线属 `FR-8.4` 的包，不在本波；`sessionToken()` 留出出口，
         取不到令牌时 `POST /notice` 会如实回 **401**，本页把该失败**显示出来**（绝不静默）。
       · **演示模式一行都不改**：服务端分支只在 `serverMode(state)` 为真时进入。 */

  /** 正在编辑的公告 id（服务端模式；`null` ＝ 新增）。演示模式恒为 null、不参与任何分支。 */
  let noticeEditingId = null;

  /** 是否服务端模式（与 `UploadPanel.serverMode()` **同一判据**：状态位优先，配置兜底） */
  function serverMode(state) {
    return !!(state && (state.serverMode === true ||
      ((window.BoardConfig || {}).dataSource === 'server')));
  }

  /** 会话令牌（ADR-0007 D3 的 `Bearer`）：提交给 `POST /notice` 的鉴权头。
   *  **由登录接线包提供**（`window.BoardSession.token()`，或状态位 `state.sessionToken`）；
   *  取不到就返回空串 —— 调用方**不伪造令牌**，服务端会回 401 并把原因显示给操作人。 */
  function sessionToken(state) {
    const bs = window.BoardSession;
    try {
      if (bs && typeof bs.token === 'function') {
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
    const unlocked = state.unlocked;

    /* 解锁状态 */
    setClass('setLockDot', 'lock-dot' + (unlocked ? ' on' : ''));
    setText('setLockText', unlocked ? '已解锁：可录入维保信息、修改公告' : '当前已锁定');
    $('setSyncBtn').disabled = !unlocked;
    $('setManualBtn').disabled = !unlocked;

    /* 维保录入 / 公告发布：解锁后才可编辑（FR-6.11、FR-7.12） */
    ['maintContent', 'maintOwner', 'maintState', 'maintSave',
     'noticeType', 'noticeText', 'noticeSave'].forEach(id => { $(id).disabled = !unlocked; });

    /* FR-7.12（服务端模式）：编辑态把按钮文案换成「保存修改」；锁定时**退出编辑态**
       （锁定后按钮已 disabled，若留着编辑态，解锁后一次误点就会改到别的那条公告）。
       ⚠ 演示模式**一字不改**：`serverMode(state)` 为假时下面这段整段不执行。 */
    if (serverMode(state)) {
      if (!unlocked && noticeEditingId !== null) noticeEditingId = null;
      setText('noticeSave', noticeEditingId === null ? '发布公告' : '保存修改');
    }

    /* 关键参数配置：解锁后才可编辑（FR-8.6）；此处只切禁用态，不写 value（避免秒级刷新清空输入） */
    ['cfgEquipCode', 'cfgUpperUrl', 'cfgMesUrl', 'cfgWarnDays', 'cfgSaveBtn']
      .forEach(id => { $(id).disabled = !unlocked; });

    const em = $('entryMsg');
    if (!em.dataset.sticky) {
      em.textContent = unlocked
        ? '已解锁：录入内容保存后写入本地库并记录操作日志'
        : '当前已锁定：请先在左侧输入解锁密码（演示密码 8888）';
      em.className = 'entry-note' + (unlocked ? ' ok' : '');
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
       （与"请填写…后再保存"同一处文案位、同样 4 s 后自动恢复默认文案），给出可观察反馈。 */
    function denyLocked(action) {
      flashEntry(`当前已锁定：${action}未保存，请先在左侧输入解锁密码（演示密码 8888）`, true);
    }

    function tryUnlock() {
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

    /* 关键参数配置：把配置文件当前值载入输入框（只在绑定时写一次，避免秒级刷新覆盖用户输入） */
    $('cfgEquipCode').value = M.CFG.equipCode;
    $('cfgUpperUrl').value = CFG.upper.url || '';
    $('cfgMesUrl').value = CFG.mes.baseUrl || '';
    $('cfgWarnDays').value = String(M.CFG.maintWarnDays);

    $('setUnlockBtn').addEventListener('click', tryUnlock);
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
