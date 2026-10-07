/* ==========================================================================
   标识生成（platform/id.js）
   作用：统一生成各类业务标识，保证**全项目规则一致**：
         · 上报流水号 uploadId —— 附录 2 要求"用于 MES 去重、回执核对"。**本文件是序号口径的
           真源**：UP + yyyyMMddHHmmss + 6 位**当日**序号，即**按日重置、序号域 1～999999、
           永不产生 `000000`**。`src/services/api.js` 的 `nextUploadId()` 与这里的
           `createUploadIdGenerator().next()` **逐条同规则**（浏览器侧 file:// 下无 require，
           不能共用本模块，故为等价实现 —— 改动任一侧必须同步另一侧）。
           注（R26-P3-3，2026-09-26 第三轮审查）：统一之前 `api.js` 用 `%1000` 会产 `…000`
           且从不按日重置，与 `isUploadId` 的"001～999 合法"两判相反，本行原写的"保持一致"
           因而**不实**；现已按本节口径统一，`tests/platform-check.js` 有跨界对账断言守线。
           注（`E31`，2026-10-07 负责人"E31 按建议：放宽 uploadId 序号域／加日期段"）：序号段由
           **3 位扩到 6 位**（域 `1～999` → `1～999999`）。原口径下**单个自然日内第 1000 次生成
           即回绕**为 `001` —— 与当日第 1 次**同号**；而 `uploadId` 在附录 2 的用途正是
           "MES 数据去重、回执核对"，若对方或我方以它作**幂等键**，回绕后的同号报文可能被
           **误判重复而静默丢弃**（静默丢数，比报错更难发现）。
           **为什么选"放宽域"而不选"加日期段"**：时间戳段 `yyyyMMddHHmmss` **已经**含日期，
           再加一段日期**不增加单日容量**（回绕点仍是当日第 1000 次）⇒ 只有放宽域能消掉回绕。
           **为什么是 6 位**（**构成性**推导，不手抄魔数）：落库帧频＝每设备每秒 1 行
           （ADR-0001 D7：500 ms 原始帧只进内存）⇒ 单日帧数上界 ＝ 86400 ÷ 0.5 ＝ **172800**，
           而 `uploadId` 的生成频率**不高于**帧频 ⇒ 6 位域 999999 ≥ 172800（余量 5.79 倍）
           ⇒ **在本仓已文档化的节拍下，"单日回绕"不可达**。
           ⚠ **格式变化是对外可见的**（`UP` ＋ 14 位时间 ＋ 序号：19 → 22 字符）⇒ 发函/联调前
           须**对外确认**：`U-5①/⑤` 已向 MES 方问 `uploadId` 的唯一性范围，**尚未答复**；
           **不得**自行假定对方接受长度/位数变化。
         · 列表项/记录 id —— 时间戳 + 随机后缀（本地库主键仍由 SQLite 自增负责）
   依赖：node:crypto（randomUUID 可选）。时间经 platform/clock.js 注入。
   ========================================================================== */
'use strict';

const { fmt, fmtDate } = require('./clock');

/** uploadId 序号段的**位数**与**上界**（`E31`）：两侧（本文件与浏览器侧 `src/services/api.js`）
 *  各写一份字面量（浏览器 file:// 下无 require、不能共用本模块），**两处必须逐字相同**；
 *  4～6 位里取 6 的依据见文件头（单日帧数上界 172800 ≤ 999999 —— 构成性推导）。 */
const UPLOAD_SEQ_DIGITS = 6;
const UPLOAD_SEQ_MAX = 999999;

/** 生成带当日序号的 uploadId 生成器（序号跨日自动重置；序号域 1～999999，永不产生 000000） */
function createUploadIdGenerator(options = {}) {
  const clock = options.clock;
  const pad = n => String(n).padStart(2, '0');
  let seqDate = null;
  let seq = 0;

  return {
    /** 生成一个 uploadId（同秒内多次调用靠 6 位序号区分，上限 999999；见 `E31` 与文件头） */
    next() {
      const now = clock ? clock.now() : new Date();
      const date = fmtDate(now);
      if (seqDate !== date) { seqDate = date; seq = 0; }
      /* 序号域 1～999999（`E31`）：(seq % UPLOAD_SEQ_MAX) + 1 使 +1 后落在 000001，
         回绕后仍**不产生 000000** —— 与下方 isUploadId 的判定边界（000001～999999 合法）
         同一条口径。回绕点由"当日第 1000 次"推到"当日第 1000000 次" ⇒ 在已文档化的
         500 ms 节拍（单日 172800 帧上界）下**不可达**。 */
      seq = (seq % UPLOAD_SEQ_MAX) + 1;
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      return `UP${stamp}${String(seq).padStart(UPLOAD_SEQ_DIGITS, '0')}`;
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
 * 判定口径与 createUploadIdGenerator().next() **一一对应**：时间部分 14 位 + 序号
 * 000001～999999（6 位；`E31` 由 001～999 放宽），故 `…000000` 必判非法（生成侧永不产生）。
 * R26-P3-3：两侧若不同规则，附录 2 的去重与回执核对（DR-13）就会语义漂移 —— 判定与生成必须同源。
 * ⚠ 本判据的**形状是单一形态**（只认新位数）：它是"生成侧自检"的判据、不是历史数据的解析器
 *   （全仓运行期无调用方，读方无需兼容旧 id）；若日后要校验**旧格式**历史 id，须**显式**加宽，
 *   不得靠"看起来差不多"悄悄放过（`E31` 的对外兼容面另见文件头那段）。
 */
function isUploadId(v) {
  if (typeof v !== 'string') return { ok: false, reason: '不是字符串' };
  if (!/^UP\d{20}$/.test(v)) return { ok: false, reason: `形状不符（应为 UP+14 位时间+6 位序号）：${v}` };
  const y = v.slice(2, 6), mo = v.slice(6, 8), d = v.slice(8, 10);
  const h = v.slice(10, 12), mi = v.slice(12, 14), s = v.slice(14, 16);
  const t = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
  if (Number.isNaN(t.getTime())) return { ok: false, reason: `时间部分非法：${v}` };
  const seq = Number(v.slice(16));
  if (!(seq >= 1 && seq <= UPLOAD_SEQ_MAX)) return { ok: false, reason: `序号应在 000001～999999：${v}` };
  return { ok: true, reason: '' };
}

module.exports = {
  createUploadIdGenerator, localId, isUploadId,
  /* `E31`：序号段的位数与上界（**对外可读的常量**，供自检/联调按构成性推导出期望值） */
  UPLOAD_SEQ_DIGITS, UPLOAD_SEQ_MAX
};
