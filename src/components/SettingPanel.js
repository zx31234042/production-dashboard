/* ==========================================================================
   组件：操作设置页（components/SettingPanel.js）
   需求：FR-8 密码解锁、系统时间设置、系统自检
         FR-6.11 维保录入、FR-7.12 公告发布（解锁后可用）、FR-8.7 操作留痕
   ========================================================================== */
window.Components = window.Components || {};
window.Components.SettingPanel = (function () {
  'use strict';

  const { setText, setHTML, setClass, $ } = window.Dom;

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

    function tryUnlock() {
      // 演示实现：真实系统须由服务端校验口令（NFR-14），不得在前端存放明文
      if (input.value === M.CFG.unlockPassword) {
        M.setUnlocked(true);
        msg.textContent = '解锁成功，维保录入与公告修改已开放';
        msg.className = 'pwd-msg ok';
        input.value = '';
      } else {
        msg.textContent = '密码错误，请重新输入（演示密码：8888）';
        msg.className = 'pwd-msg err';
      }
      render(state);
      onActivity();
    }

    $('setUnlockBtn').addEventListener('click', tryUnlock);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); onActivity(); });

    $('setLockBtn').addEventListener('click', () => {
      M.setUnlocked(false);
      msg.textContent = '已锁定';
      msg.className = 'pwd-msg';
      render(state);
      onActivity();
    });

    $('setSyncBtn').addEventListener('click', () => { msg.textContent = 'NTP 同步完成（模拟）'; msg.className = 'pwd-msg ok'; });
    $('setManualBtn').addEventListener('click', () => { msg.textContent = '演示版本不支持修改系统时间'; msg.className = 'pwd-msg'; });

    /* 维保录入（FR-6.11）：演示仅写入前端内存，真实系统须落库 + 留痕 */
    $('maintSave').addEventListener('click', () => {
      if (!state.unlocked) return;
      const content = $('maintContent').value.trim();
      if (!content) { flashEntry('请填写检修内容后再保存', true); return; }
      state.maint.records.unshift({
        time: `${state.clock.date} ${state.clock.time.slice(0, 5)}`,
        content,
        owner: $('maintOwner').value.trim() || '—',
        state: $('maintState').value
      });
      state.maint.records = state.maint.records.slice(0, 6);
      $('maintContent').value = ''; $('maintOwner').value = '';
      window.Components.MaintPanel.render(state);
      flashEntry('维保记录已保存并记录操作日志（演示）', false);
      onActivity();
    });

    /* 公告发布（FR-7.12） */
    $('noticeSave').addEventListener('click', () => {
      if (!state.unlocked) return;
      const text = $('noticeText').value.trim();
      if (!text) { flashEntry('请填写公告内容后再发布', true); return; }
      const d = new Date();
      state.notices.notices.unshift({
        tag: $('noticeType').value, text, lv: 'info',
        time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      });
      state.notices.notices = state.notices.notices.slice(0, 6);
      $('noticeText').value = '';
      window.Components.NoticePanel.render(state);
      flashEntry('公告已发布并记录操作日志（演示）', false);
      onActivity();
    });
  }

  return { render, bind };
})();
