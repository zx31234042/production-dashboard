/**
 * missingValue.js —— **P0-3：缺值映射**（V1.45 第 7 处；`IF-B.5`／`C-78` 的接收侧对偶）
 *
 * 口径（负责人 2026-10-12 裁定，登记在 V1.45 第 7 处）
 *   ①**缺值一律映射为 `null`**（看板显示「—」；不得落 0）；
 *   ②**不要拿 0 当缺值** —— `0` 是**合法测量值**（速度 0、深度 0 都可能真实出现）⇒ 本模块**永不**把 0 改成 null；
 *   ③采用**哨兵值**约定：整型 16 位 `0xFFFF`（65535）、32 位 `0xFFFFFFFF`（4294967295）——含其字符串形态；
 *   ④若对方**明确给出**"哪些字段缺失"（`missingFields` 数组，或单帧的 `missing` 数组）⇒ 按名字置 `null`；
 *      **不猜位图位序**（对方尚未提供整帧有效位图；盲解位序会把"有值"读成"缺值"）。
 *
 * 纪律
 *   · **纯函数**：不读库、不取时间（`ADR-0003` D17 的"不留裸 `new Date()`"照旧）；
 *   · **只动"测量/参数"字段**（白名单），其余字段（`procOrderNo`／`collectTime`／`testStatus` 等）**不碰**；
 *   · **不改 `ingest` 的校验口径**：本模块只把值归一成 `null`／原值，是否落库由 `ingestFrame()` 决定。
 */

'use strict';

/** 视为"缺值"的测量/参数字段（白名单；与 `src\config\fieldMap.js` 的 `task.real.*` 对齐） */
const MEASURE_FIELDS = Object.freeze([
  'depth', 'speed', 'velocityX', 'velocityY', 'cameraDepth', 'frameRate', 'gain', 'shutter'
]);

/** 哨兵值（数值形态 ＋ 常见字符串形态） */
const SENTINEL_NUMBERS = Object.freeze([0xFFFF, 0xFFFFFFFF]);
const SENTINEL_STRINGS = Object.freeze(['0xffff', '0xFFFF', '65535', '0xffffffff', '4294967295']);

/** 是否"空"（`undefined`／`null`／空串／`NaN`） */
function isBlank(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'number') return Number.isNaN(v);
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

/** 是否哨兵值（数值或字符串形态；**0 永远不是哨兵**） */
function isSentinel(v) {
  if (typeof v === 'number') return SENTINEL_NUMBERS.includes(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (SENTINEL_STRINGS.includes(s)) return true;
    const n = Number(s);
    return Number.isFinite(n) && SENTINEL_NUMBERS.includes(n);
  }
  return false;
}

/**
 * 把一帧里的缺值归一成 `null`（返回**新对象**，不改入参）。
 * @param {object} frame 扁平帧
 * @param {{fields?:string[]}} [opts] `fields` 可显式指定"本帧缺失的字段名"（等价于 `frame.missingFields`）
 * @returns {{frame:object, missing:string[], hits:{sentinel:number, blank:number, explicit:number}}}
 */
function mapMissingValues(frame, opts = {}) {
  const out = { frame: frame, missing: [], hits: { sentinel: 0, blank: 0, explicit: 0 } };
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return out;

  const explicit = new Set(
    [].concat(frame.missingFields || [], frame.missing || [], opts.fields || []).filter(v => typeof v === 'string')
  );
  const next = Object.assign({}, frame);
  const missing = [];

  for (const name of MEASURE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(frame, name) && !explicit.has(name)) continue;
    const v = frame[name];
    if (explicit.has(name)) {
      if (next[name] !== null) { next[name] = null; out.hits.explicit += 1; }
      missing.push(name);
      continue;
    }
    if (isBlank(v) || isSentinel(v)) {
      if (next[name] !== null) { next[name] = null; }
      if (isSentinel(v)) out.hits.sentinel += 1; else out.hits.blank += 1;
      missing.push(name);
      continue;
    }
    /* 其余原样保留 —— **0 是合法值，绝不当缺值** */
  }

  out.frame = next;
  out.missing = missing;
  return out;
}

/** 计数载体（调用方持有；`now` 必须注入 —— `ADR-0003` D17） */
function createStats(now) {
  if (typeof now !== 'function') {
    throw new TypeError('createStats: 必须传入 now()（时钟注入出口，ADR-0003 D17）');
  }
  const counts = { frames: 0, framesWithMissing: 0, fieldsNulled: 0, sentinel: 0, blank: 0, explicit: 0 };
  let lastAt = null;
  return {
    bump(result) {
      counts.frames += 1;
      if (result && result.missing.length > 0) {
        counts.framesWithMissing += 1;
        counts.fieldsNulled += result.missing.length;
        counts.sentinel += result.hits.sentinel;
        counts.blank += result.hits.blank;
        counts.explicit += result.hits.explicit;
        lastAt = new Date(now()).toISOString();
      }
      return counts;
    },
    snapshot() {
      return Object.assign({}, counts, { lastAt });
    }
  };
}

module.exports = { MEASURE_FIELDS, SENTINEL_NUMBERS, SENTINEL_STRINGS, isBlank, isSentinel, mapMissingValues, createStats };
