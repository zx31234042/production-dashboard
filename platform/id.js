/* ==========================================================================
   标识生成（platform/id.js）
   作用：统一生成各类业务标识，保证**全项目规则一致**：
         · 上报流水号 uploadId —— 附录 2 要求"用于 MES 去重、回执核对"，格式与
           `src/services/api.js` 现有实现保持一致：UP + yyyyMMddHHmmss + 3 位当日序号
         · 列表项/记录 id —— 时间戳 + 随机后缀（本地库主键仍由 SQLite 自增负责）
   依赖：node:crypto（randomUUID 可选）。时间经 platform/clock.js 注入。
   ========================================================================== */
'use strict';

const { fmt, fmtDate } = require('./clock');

/** 生成带当日序号的 uploadId 生成器（序号跨日自动重置） */
function createUploadIdGenerator(options = {}) {
  const clock = options.clock;
  const pad = n => String(n).padStart(2, '0');
  let seqDate = null;
  let seq = 0;

  return {
    /** 生成一个 uploadId（同秒内多次调用靠 3 位序号区分，上限 999） */
    next() {
      const now = clock ? clock.now() : new Date();
      const date = fmtDate(now);
      if (seqDate !== date) { seqDate = date; seq = 0; }
      seq = (seq % 999) + 1;
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      return `UP${stamp}${String(seq).padStart(3, '0')}`;
    },
    /** 当前序号（自检用） */
    seq: () => seq,
    reset() { seqDate = null; seq = 0; return this; }
  };
}

/** 生成一个本地唯一 id（日志关联、临时键用；不替代数据库主键） */
function localId(prefix = 'id', clock) {
  const now = clock ? clock.now() : new Date();
  const stamp = fmt(now).replace(/[-: ]/g, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}`;
}

/** 校验 uploadId 形状（供自检与联调核对；返回 {ok, reason}） */
function isUploadId(v) {
  if (typeof v !== 'string') return { ok: false, reason: '不是字符串' };
  if (!/^UP\d{17}$/.test(v)) return { ok: false, reason: `形状不符（应为 UP+14 位时间+3 位序号）：${v}` };
  const y = v.slice(2, 6), mo = v.slice(6, 8), d = v.slice(8, 10);
  const h = v.slice(10, 12), mi = v.slice(12, 14), s = v.slice(14, 16);
  const t = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
  if (Number.isNaN(t.getTime())) return { ok: false, reason: `时间部分非法：${v}` };
  const seq = Number(v.slice(16));
  if (!(seq >= 1 && seq <= 999)) return { ok: false, reason: `序号应在 001～999：${v}` };
  return { ok: true, reason: '' };
}

module.exports = { createUploadIdGenerator, localId, isUploadId };
