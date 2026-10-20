/**
 * orderResolver.js —— **P0-1：接收侧的 `procOrderNo` 注入**（V1.45 第 8 处 / `C-115`；`FR-3.1`）
 *
 * 背景（为什么需要它）
 *   `IF-D` 的 `procOrderNo` **不由上位机方提供**（对方答复"我方不自动生成，建议由贵方直接从 MES 取"；
 *   负责人 2026-10-12 裁定"`procOrderNo` 仅限我方与 MES 方，不再涉及上位机方"）⇒ 看板必须在**接收侧**
 *   把"当前生效工单"填进帧里，否则 `ingestFrame()` 会以 `MISSING_FIELD` 拒收（`REQUIRED_FIELDS` 含它）。
 *
 * 口径（负责人 2026-10-12「按建议」）
 *   ①**权威来源＝`IF-A`**：`task` 表（IF-A.1 派工落库）的 `plan_start_time` / `plan_end_time` 时间窗；
 *   ②**以派工生效时间窗为准**：`plan_start_time ≤ at ≤ plan_end_time` ⇒ 该工单生效；
 *   ③**窗口外（跨工单切换瞬间 / 无派工就开测）⇒ 该帧不落库 ＋ 计数 ＋ 告警**，**不兜底、不编造工单号**；
 *   ④帧里**自带** `procOrderNo`（非空）⇒ **原样放行**（仅比对/展示用途，`C-102`）。
 *
 * 纪律
 *   · **不猜**：没有可判定的时间窗 ⇒ 拒收并给出 `NO_WINDOW`（让运维去补 IF-A 派工，而不是随便挂一个号）；
 *   · **不改 ingest 的必填口径**：本模块只是"在调用 `ingestFrame()` 之前把值填进去"，`DR-04` 的
 *     `proc_order_no NOT NULL` 与 `ux_measure_rt` 唯一索引都保持可用；
 *   · **纯函数式注入 ＋ 可观测计数**：不写库、不改全局状态；计数由调用方持有（`createStats()`）。
 *
 * 依据：`需求文档\…V1.46.md` 的 `IF-D.12`（`C-115`）｜`FR-3.1`｜`DR-04`／`DR-13`
 */

'use strict';

/** 拒收码（调用方据此分流：400 + 计数 + 告警） */
const INJECT_REJECT = Object.freeze({
  /** 没有任何 task 行可判（IF-A 从未派工） */
  NO_ACTIVE_ORDER: 'NO_ACTIVE_ORDER',
  /** 有 task 行，但都不在该时刻的生效窗口内（跨工单切换瞬间 / 已完工 / 未开工） */
  OUT_OF_WINDOW: 'OUT_OF_WINDOW',
  /** 有 task 行但缺时间窗（IF-A 没给 `planStartTime/planEndTime`）⇒ 不可判定 */
  NO_WINDOW: 'NO_WINDOW'
});

/** `YYYY-MM-DD HH:mm:ss`（与项目其余时间口径一致：北京时间、秒级、可直接字符串比较） */
function fmtLocal(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 非空字符串守卫（`undefined`／`null`／空串／纯空白 都算"没有"） */
function present(v) {
  return typeof v === 'string' ? v.trim() !== '' : (typeof v === 'number' && Number.isFinite(v));
}

/**
 * 取"某时刻生效的工单"（**只读**）。
 * @param {object} db node:sqlite 句柄（`server/db/index.js` 的 openDb 返回）
 * @param {{at?: Date|string}} [opts] `at` 缺省＝现在
 * @returns {{ok:true, procOrderNo:string, planStartTime:string, planEndTime:string, taskCount:number}
 *          |{ok:false, code:string, reason:string, at:string, taskCount:number}}
 */
function resolveActiveOrder(db, opts = {}) {
  /* 时钟注入出口（ADR-0003 D17）：**不在此处裸取当前时间** —— 由调用方传 `at`（`ifD.js` 用 `deps.now`）。 */
  if (opts.at === undefined) {
    throw new TypeError('resolveActiveOrder: 必须传入 opts.at（时钟注入出口，ADR-0003 D17）');
  }
  const at = fmtLocal(opts.at);
  if (!db || typeof db.prepare !== 'function') {
    return { ok: false, code: INJECT_REJECT.NO_ACTIVE_ORDER, reason: '无库句柄，无法判定当前工单', at, taskCount: 0 };
  }
  let rows;
  try {
    rows = db.prepare(
      'SELECT proc_order_no, plan_start_time, plan_end_time, status FROM task ORDER BY proc_order_no'
    ).all();
  } catch (e) {
    return { ok: false, code: INJECT_REJECT.NO_ACTIVE_ORDER, reason: `读 task 失败：${e.message}`, at, taskCount: 0 };
  }
  if (!rows || rows.length === 0) {
    return { ok: false, code: INJECT_REJECT.NO_ACTIVE_ORDER, reason: 'task 表为空（IF-A 未派工）', at, taskCount: 0 };
  }
  const withWindow = rows.filter(r => present(r.plan_start_time) && present(r.plan_end_time));
  if (withWindow.length === 0) {
    return { ok: false, code: INJECT_REJECT.NO_WINDOW, reason: `${rows.length} 条 task 行均缺 planStartTime/planEndTime，无法判定生效窗口`, at, taskCount: rows.length };
  }
  /* 窗口内命中（同一时刻可能多条：按 plan_start_time 取最晚＝最新派工） */
  const hit = withWindow
    .filter(r => String(r.plan_start_time) <= at && at <= String(r.plan_end_time))
    .sort((a, b) => String(b.plan_start_time).localeCompare(String(a.plan_start_time)))[0];
  if (hit) {
    return {
      ok: true, procOrderNo: String(hit.proc_order_no),
      planStartTime: String(hit.plan_start_time), planEndTime: String(hit.plan_end_time),
      taskCount: rows.length
    };
  }
  return { ok: false, code: INJECT_REJECT.OUT_OF_WINDOW, reason: `${rows.length} 条 task 行均不在 ${at} 的生效窗口内`, at, taskCount: rows.length };
}

/**
 * 把"当前生效工单"注入帧（**在 `ingestFrame()` 之前**调用）。
 * @param {object} db
 * @param {object} frame 扁平帧（**不要**传 `{frame:{…}}` 包装形态；路由侧先归一）
 * @param {{at?: Date|string}} [opts]
 * @returns {{ok:true, frame:object, source:'frame'|'injected', procOrderNo:string}
 *          |{ok:false, code:string, reason:string, at:string}}
 */
function injectOrderIntoFrame(db, frame, opts = {}) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    return { ok: false, code: INJECT_REJECT.NO_ACTIVE_ORDER, reason: '帧不是对象', at: fmtLocal(opts.at) };
  }
  /* ① 帧里自带 ⇒ 原样放行（不覆盖、不改写） */
  if (present(frame.procOrderNo)) {
    return { ok: true, frame, source: 'frame', procOrderNo: String(frame.procOrderNo) };
  }
  /* ② 否则按 IF-A 的生效窗口注入 */
  const r = resolveActiveOrder(db, opts);
  if (!r.ok) return { ok: false, code: r.code, reason: r.reason, at: r.at };
  const injected = Object.assign({}, frame, { procOrderNo: r.procOrderNo });
  return { ok: true, frame: injected, source: 'injected', procOrderNo: r.procOrderNo };
}

/**
 * 计数与告警的载体（**调用方持有**；本模块不写全局状态）。
 * `now` **必须注入**（ADR-0003 D17；`ifD.js` 传 `deps.now` 的包装）。
 * `bump(kind)` 后 `snapshot()` 给出累计值；`lastReject` 保留最近一次拒收原因（供告警/health 展示）。
 */
function createStats(now) {
  if (typeof now !== 'function') {
    throw new TypeError('createStats: 必须传入 now()（时钟注入出口，ADR-0003 D17）');
  }
  const counts = { injected: 0, passthrough: 0, NO_ACTIVE_ORDER: 0, OUT_OF_WINDOW: 0, NO_WINDOW: 0 };
  let lastReject = null;
  return {
    bump(kind, info) {
      if (kind === 'injected' || kind === 'passthrough') counts[kind] += 1;
      else if (Object.prototype.hasOwnProperty.call(counts, kind)) {
        counts[kind] += 1;
        lastReject = Object.assign({ at: new Date(now()).toISOString(), code: kind }, info || {});
      }
      return counts;
    },
    snapshot() {
      return Object.assign({}, counts, { lastReject: lastReject ? Object.assign({}, lastReject) : null });
    }
  };
}

module.exports = { INJECT_REJECT, fmtLocal, resolveActiveOrder, injectOrderIntoFrame, createStats };
