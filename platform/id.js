/* ==========================================================================
   标识生成（platform/id.js）
   作用：统一生成各类业务标识，保证**全项目规则一致**：
         · 上报流水号 uploadId —— 附录 2 要求"用于 MES 去重、回执核对"。**本文件是序号口径的
           真源**：UP + yyyyMMddHHmmss + 3 位**当日**序号，即**按日重置、序号域 1～999、
           永不产生 `000`**。`src/services/api.js` 的 `nextUploadId()` 与这里的
           `createUploadIdGenerator().next()` **逐条同规则**（浏览器侧 file:// 下无 require，
           不能共用本模块，故为等价实现 —— 改动任一侧必须同步另一侧）。
           注（R26-P3-3，2026-09-26 第三轮审查）：统一之前 `api.js` 用 `%1000` 会产 `…000`
           且从不按日重置，与 `isUploadId` 的"001～999 合法"两判相反，本行原写的"保持一致"
           因而**不实**；现已按本节口径统一，`tests/platform-check.js` 有跨界对账断言守线。
         · 列表项/记录 id —— 时间戳 + 随机后缀（本地库主键仍由 SQLite 自增负责）
   依赖：node:crypto（randomUUID 可选）。时间经 platform/clock.js 注入。
   ========================================================================== */
'use strict';

const { fmt, fmtDate } = require('./clock');

/** 生成带当日序号的 uploadId 生成器（序号跨日自动重置；序号域 1～999，永不产生 000） */
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
      /* 序号域 1～999：(seq % 999) + 1 使 +1 后落在 001，回绕后仍**不产生 000**
         —— 与下方 isUploadId 的判定边界（001～999 合法）同一条口径 */
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

/**
 * 校验 uploadId 形状（供自检与联调核对；返回 {ok, reason}）
 * 判定口径与 createUploadIdGenerator().next() **一一对应**：时间部分 14 位 + 序号 001～999，
 * 故 `…000` 必判非法（生成侧永不产生）。R26-P3-3：两侧若不同规则，附录 2 的去重与
 * 回执核对（DR-13）就会语义漂移 —— 判定与生成必须同源。
 */
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
