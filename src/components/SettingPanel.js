/* ==========================================================================
   组件：操作设置页（components/SettingPanel.js）
   需求：FR-8 密码解锁（含 5 分钟自动锁定）、系统时间设置、系统自检、关键参数配置
         FR-6.11 维保录入、FR-7.12 公告发布（解锁后可用）
         FR-8.7 / NFR-15 解锁后的写操作全程留痕（操作日志）
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

    /* 系统状态自检 */
    setHTML('setSelfCheckList', state.selfCheck.map(c =>
      `<div class="list-item lv-${c.lv}"><span class="body">${c.name}</span>` +
      `<span class="meta ${c.lv}">${c.state}</span></div>`).join(''));

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
   * @param {Function} onActivity 有操作时回调（用于重置"无操作自动返回首页"计时）
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
      onActivity();
    }

    /* 关键参数配置：把配置文件当前值载入输入框（只在绑定时写一次，避免秒级刷新覆盖用户输入） */
    $('cfgEquipCode').value = M.CFG.equipCode;
    $('cfgUpperUrl').value = CFG.upper.url || '';
    $('cfgMesUrl').value = CFG.mes.baseUrl || '';
    $('cfgWarnDays').value = String(M.CFG.maintWarnDays);

    $('setUnlockBtn').addEventListener('click', tryUnlock);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); onActivity(); });

    $('setLockBtn').addEventListener('click', () => {
      clearAutoLock();
      if (state.unlocked) M.pushLog('手动锁定', '操作人手动锁定看板输入');
      M.setUnlocked(false);
      msg.textContent = '已锁定';
      msg.className = 'pwd-msg';
      render(state);
      onActivity();
    });

    $('setSyncBtn').addEventListener('click', () => {
      msg.textContent = 'NTP 同步完成（模拟）';
      msg.className = 'pwd-msg ok';
      M.pushLog('时间同步', '手动触发 NTP 同步（模拟）');
    });
    $('setManualBtn').addEventListener('click', () => { msg.textContent = '演示版本不支持修改系统时间'; msg.className = 'pwd-msg'; });

    /* 维保录入（FR-6.11）：演示仅写入前端内存，真实系统须落库 + 留痕 */
    $('maintSave').addEventListener('click', () => {
      if (!state.unlocked) return;
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
      onActivity();
    });

    /* 公告发布（FR-7.12） */
    $('noticeSave').addEventListener('click', () => {
      if (!state.unlocked) return;
      const text = $('noticeText').value.trim();
      if (!text) { flashEntry('请填写公告内容后再发布', true); return; }
      const type = $('noticeType').value;
      /* 复用 state.clock（每秒刷新），不再手工拼 HH:MM（P3-7） */
      const hhmm = state.clock.time.slice(0, 5);
      state.notices.notices.unshift({ tag: type, text, lv: 'info', time: hhmm });
      state.notices.notices = state.notices.notices.slice(0, 6);
      $('noticeText').value = '';
      M.pushLog('公告发布', `公告类型：${type}；内容：${text}`);
      window.Components.NoticePanel.render(state);
      flashEntry('公告已发布并记录操作日志（演示）', false);
      onActivity();
    });

    /* 关键参数配置保存（FR-8.6）：写入配置与运行时参数，并记录操作日志 */
    $('cfgSaveBtn').addEventListener('click', () => {
      if (!state.unlocked) return;
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
      if (!changed.length) { flashEntry('参数未发生变化，无需保存', true); onActivity(); return; }
      M.pushLog('参数配置', changed.join('；'));
      flashEntry('参数已保存并记录操作日志：' + changed.join('；') + '（地址类参数刷新页面后生效）', false);
      render(state);
      onActivity();
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
