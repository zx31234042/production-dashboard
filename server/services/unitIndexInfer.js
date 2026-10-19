/**
 * unitIndexInfer.js —— **P0-4：件序号按"测试周期"生成**（V1.45 第 6 处 `C-115`；`DR-04`／`DR-05`）
 *
 * 背景（为什么要它）
 *   上位机方答复：**`unitIndex` 不提供**（负责人口径："对方不给则由看板按 `testStatus` 的**测试周期边沿**生成"）。
 *   而改动前 `unit_index` **只认帧里的值**（`services/ingest.js` 的 `parseUnitIndex()`：缺 ⇒ 写 NULL），
 *   于是一票多件时件序号永远为空 ⇒ `DR-05` 的"按件固化"、`FR-4.2` 的开工数、`FR-5.11` 的按件统计都缺件维度。
 *
 * 口径（负责人 2026-10-12 裁定，登记在 V1.45 第 6 处）
 *   ①**件＝一个测试周期**：`testStatus` **0/2/3 → 1（测试中）** 的那一帧＝**新一件开始**；
 *   ②**同一工单内从 1 起**、只增不减（`DR-05` 的"终态单调不回退"同精神）；
 *   ③**待机（0）／异常（3）帧**：不构成一件 ⇒ `unitIndex` 为 `null`（不由本模块编造）；
 *   ④帧里**自带**合法件序号（整数 ≥1）⇒ **原样放行**（不覆盖，`DR-05` 的"以帧为准"优先）。
 *
 * 纪律
 *   · **重启安全**：新一件的序号＝`1 + max(unit_index)`（该工单在 `measure_rt` 里已有的最大值），**不靠内存计数**；
 *     内存里只存"**上一帧的 testStatus**"（用于识别边沿；丢了也不会编造序号 —— 最坏情况是多算一件，且由 `--verify` 式的
 *     人工复核可见，绝不静默把两件并成一件）。
 *   · **不猜**：读不到库 ⇒ 返回 `null`（调用方照常落库，`unit_index` 为 NULL）；**绝不**用 0 或"上一件"顶替。
 *   · **不改 `ingest` 的校验口径**：本模块只回答"这一帧属于第几件"，`ingestFrame()` 仍旧"缺/非法件号 ⇒ NULL 不拒收"。
 */
'use strict';

/** `testStatus` 取值域（附录 2）：0 待机 / 1 测试中 / 2 测试完成 / 3 设备异常 */
const TEST_STATUS = Object.freeze({ IDLE: 0, RUNNING: 1, DONE: 2, ERROR: 3 });

/** 合法件序号：整数且 ≥1（与 `services/ingest.js` 的 `parseUnitIndex()` 同口径） */
function isValidUnitIndex(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return true;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim()) >= 1;
  return false;
}

/**
 * 创建一个**按工单**记录"上一帧 testStatus"的推断器。
 * `now` 必须注入（`ADR-0003` D17）；`db` 可为 `null`（则读不到已有最大件号 ⇒ 只在内存里从 1 起，仍不编造）。
 * @param {{db?:object, now:Function}} opts
 */
function createUnitIndexInferrer(opts = {}) {
  if (typeof opts.now !== 'function') {
    throw new TypeError('createUnitIndexInferrer: 必须传入 now()（时钟注入出口，ADR-0003 D17）');
  }
  const db = opts.db || null;
  /** 工单 → 上一帧的 testStatus（只用于识别边沿；不参与序号计算） */
  const lastStatus = new Map();

  /** 该工单已落库的最大件序号（读不到 ⇒ 0） */
  function maxStoredUnitIndex(procOrderNo) {
    if (!db || !procOrderNo) return 0;
    try {
      const row = db.prepare(
        'SELECT MAX(unit_index) AS m FROM measure_rt WHERE proc_order_no = ?'
      ).get(String(procOrderNo));
      const m = row && row.m;
      return Number.isFinite(m) && m > 0 ? m : 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 算这一帧的件序号（**纯读 + 边沿状态**，不写库）。
   * @returns {{unitIndex:number|null, source:'frame'|'inferred'|'none', reason:string}}
   */
  function infer(frame) {
    if (!frame || typeof frame !== 'object') return { unitIndex: null, source: 'none', reason: '帧不是对象' };
    const order = frame.procOrderNo === undefined || frame.procOrderNo === null ? '' : String(frame.procOrderNo).trim();
    const st = Number(frame.testStatus);
    const prev = order ? lastStatus.get(order) : undefined;

    /* ① 帧自带合法件序号 ⇒ 放行（并把它记为"本单已到过的最大件"参考，不影响序号来源） */
    if (isValidUnitIndex(frame.unitIndex)) {
      if (order) lastStatus.set(order, Number.isFinite(st) ? st : prev);
      return { unitIndex: Number(frame.unitIndex), source: 'frame', reason: '帧自带件序号' };
    }

    /* ② 件＝一个测试周期：上一帧不是"测试中"，这一帧是"测试中" ⇒ 新一件开始 */
    let unitIndex = null;
    let source = 'none';
    let reason = '';
    if (st === TEST_STATUS.RUNNING) {
      const edge = prev !== TEST_STATUS.RUNNING;           // 0/2/3（或首帧/重启后无记录）→ 1
      if (edge) {
        unitIndex = maxStoredUnitIndex(order) + 1;
        source = 'inferred';
        reason = `测试周期边沿（${prev === undefined ? '首帧' : prev} → 1）⇒ 新一件：${unitIndex}`;
      } else {
        /* 周期内：沿用"本次周期开始时定下的那件" —— 从库里的最大件号推（同周期内多次调用结果稳定） */
        const m = maxStoredUnitIndex(order);
        unitIndex = m > 0 ? m : null;
        source = unitIndex === null ? 'none' : 'inferred';
        reason = unitIndex === null ? '测试中但库中尚无本单件号（首帧尚未落库）' : `周期内 ⇒ 沿用第 ${unitIndex} 件`;
      }
    } else if (st === TEST_STATUS.DONE) {
      /* 完成帧：属于刚结束的那一件（若库里有） */
      const m = maxStoredUnitIndex(order);
      unitIndex = m > 0 ? m : null;
      source = unitIndex === null ? 'none' : 'inferred';
      reason = unitIndex === null ? '完成帧但库中无本单件号' : `完成帧 ⇒ 归属第 ${unitIndex} 件`;
    } else {
      reason = `testStatus=${Number.isFinite(st) ? st : '非法'}（待机/异常）⇒ 不构成一件`;
    }

    if (order) lastStatus.set(order, Number.isFinite(st) ? st : prev);
    return { unitIndex, source, reason };
  }

  return {
    infer,
    /** 只读：当前内存里的"上一帧状态"（供探针/健康检查；不是序号真源） */
    snapshot() {
      return { trackedOrders: lastStatus.size, lastStatus: Array.from(lastStatus.entries()) };
    }
  };
}

module.exports = { TEST_STATUS, isValidUnitIndex, createUnitIndexInferrer };
