/**
 * endpointLink.js —— **P1-1（服务端）：按端点统计链路状态**（`FR-2.6`；V1.45 第 11 处）
 *
 * 口径
 *   ①现场是**多端点**（多台 PLC／多个 IP:端口），`FR-2.6` 要的是"**按端点**显示链路状态"；
 *   ②**单点掉线不得报成"整套离线"** —— 每个端点各自算 `online/offline`，另给汇总（`onlineCount`／`staleCount`）；
 *   ③阈值**只认一个真源**：`board.config.js` 的 `upper.staleMs`（缺省 5000 ms，`FR-2.6` 的"≤5 s 可察觉"）；
 *   ④**纯内存**（不改库、不改 schema）—— 端点标识来自帧：`endpointId` → `endpoint` → `unitId` → `equipCode`（回退链，
 *      **不猜**：都没有则记在 `(unknown)` 名下并计数）。
 *
 * 与 P0-2 的关系
 *   `DR-13` 要把"端点标识"进**去重键**（需改 schema，属 P0-2）；本模块只做**链路观测**，不改去重口径 ⇒
 *   可以先上线；P0-2 落地后端点键直接复用它（把 `resolveEndpointId()` 换成去重键里的同一取值即可）。
 *
 * 纪律：无裸 `new Date()`（`ADR-0003` D17：`now` 必须注入）。
 */

'use strict';

/** 端点标识的解析（回退链；都没有 ⇒ `(unknown)`） */
function resolveEndpointId(frame) {
  if (!frame || typeof frame !== 'object') return '(unknown)';
  for (const k of ['endpointId', 'endpoint', 'unitId', 'equipCode']) {
    const v = frame[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s !== '') return s;
  }
  return '(unknown)';
}

/**
 * @param {{now:Function, staleMs:number}} opts `now` 与 `staleMs` 都必须注入（阈值真源＝配置）
 */
function createEndpointLinkTracker(opts = {}) {
  if (typeof opts.now !== 'function') throw new TypeError('createEndpointLinkTracker: 必须传入 now()（ADR-0003 D17）');
  if (!Number.isFinite(opts.staleMs) || opts.staleMs <= 0) {
    throw new TypeError('createEndpointLinkTracker: staleMs 必须是正数（真源＝board.config.js 的 upper.staleMs）');
  }
  const staleMs = opts.staleMs;
  /** endpointId → { lastAcceptedAt:number, frames:number } */
  const byEndpoint = new Map();
  let unknownFrames = 0;

  return {
    /** 记一帧（**只在落库/去重/原始帧被接受时调用**；拒收帧不算链路证据） */
    record(frame, at) {
      const t = at === undefined ? opts.now() : at;
      const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
      if (!Number.isFinite(ms)) throw new TypeError(`record: at 非法（${JSON.stringify(at)}）`);
      const id = resolveEndpointId(frame);
      if (id === '(unknown)') unknownFrames += 1;
      const cur = byEndpoint.get(id) || { lastAcceptedAt: 0, frames: 0 };
      cur.lastAcceptedAt = Math.max(cur.lastAcceptedAt, ms);
      cur.frames += 1;
      byEndpoint.set(id, cur);
      return id;
    },
    /** 每个端点一条：`online` 按"距最近一次接受 ≤ staleMs"判；并给汇总 */
    snapshot() {
      const nowMs = new Date(opts.now()).getTime();
      const endpoints = Array.from(byEndpoint.entries()).map(([id, v]) => {
        const ageMs = Math.max(0, nowMs - v.lastAcceptedAt);
        return {
          endpointId: id,
          online: ageMs <= staleMs,
          lastAcceptedAt: new Date(v.lastAcceptedAt).toISOString(),
          ageMs,
          frames: v.frames
        };
      }).sort((a, b) => (a.endpointId < b.endpointId ? -1 : 1));
      const onlineCount = endpoints.filter(e => e.online).length;
      return {
        staleMs,
        total: endpoints.length,
        onlineCount,
        offlineCount: endpoints.length - onlineCount,
        /** **单点掉线不报整套离线**：本字段只表示"是否所有端点都掉线" */
        allOffline: endpoints.length > 0 && onlineCount === 0,
        unknownFrames,
        endpoints
      };
    }
  };
}

module.exports = { resolveEndpointId, createEndpointLinkTracker };
