/* ==========================================================================
   测试标准服务（server/services/standard.js）
   作用：把 `standard` 表里的**偏差/典型值**换算成界面与 MES 要的**绝对值口径**，并做录入校验：
         ① 上限＝典型值＋上偏差，下限＝典型值＋下偏差（基准＝**典型值**，草案第二节）；
         ② 校验「下限 ≤ 上限」「典型值在上下限之间」（FR-3.19 第 6 步：非法不写入）；
         ③ **MES 上报口径**：`uclValue` / `lclValue` 报**绝对值**；**任一必要项缺失 ⇒ 整条占位**
            （`65535` / `IsPass = null`，MES 澄清函 N-7）。
   依据：需求 V1.33 DR-03 / FR-3.18 / FR-3.19；草案第二节「负责人拍定的设计」与第四节 DR-03 增列；
         MES 澄清函《接口澄清函-第二批-致MES方》N-2 / N-7；需求评审报告 F-05。
   与前端的分工（**重要，避免各写一套口径**）：
     · 本文件是**服务端侧**的同一口径实现（判定引擎取值、MES 报文组装都在服务端）；
     · 浏览器侧的等价实现见 `src/config/fieldMap.js` 的 `standardOf()` / `reportTransform` /
       `reportFallback`（由前端座位维护）—— 两侧必须同口径：绝对值、任一必要项缺失即占位。
       本文件**不修改**前端文件，只在注释里点明对应关系。
   单位与精度：深度 **m**、速度 **m/s**；**库内与上报传数值**，两位小数由显示层格式化
     （`Math.round(v * 100) / 100`，与 `src/utils/format.js` 的 `round2` 同口径）。
   用法：
     const svc = require('./services/standard');
     const std = svc.getEffectiveStandard(db, { productCode, processCode, at });
     const limits = svc.absoluteLimits(std);         // { depth:{upper,lower}|null, speed:...|null }
     const mes = svc.mesLimits(std);                 // { uclValue, lclValue, IsPass } —— 缺失即占位
     svc.assertInput({ depthTypical: 12.6, depthUpperDev: 0.2, depthLowerDev: -0.2, ... });
   ========================================================================== */
'use strict';

const repo = require('../repo/standard');
/* 量程真源（FR-3.19 第⑥步"超量程须拒绝"；数值由负责人 2026-09-22 确认）：
   `standards.range.{depth,speed}` —— **实现里不写死任何量程**，改配置即改判据（NFR-19）。
   W4：`assertInput` 起**默认**按它做"超量程"校验（此前该判据只在前端 `TaskPanel.js` 有，
   服务端入库口没有 ⇒ 绕过界面直接调 `addVersion` 可以把量程外的标准写进库）。 */
const boardConfig = require('../../src/config/board.config.js');

/**
 * MES 占位口径（N-7，**接口契约级**，不得随意改）：
 * 标准值未设定（或任一必要项缺失）时，`uclValue` / `lclValue` 写 `65535` 表示"标准未设定"，
 * `IsPass` 写 `null` 表示"不做判定"；三者**按完整结构上报、不缺项**。
 */
const MES_PLACEHOLDER = Object.freeze({ uclValue: 65535, lclValue: 65535, IsPass: null });

/** 上下限形式：单个参数的三个必要项（缺一即"未设定"） */
const METRIC_FIELDS = ['typical', 'upperDev', 'lowerDev'];

/** 指标清单（键名与 `standard` 表的列前缀、fieldMap 的 depth/speed 一致） */
const METRICS = ['depth', 'speed'];

/** 是否为有限数值（`null` / `undefined` / `NaN` / 字符串一律不算） */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 保留两位小数（口径：深度 m、速度 m/s 均**保留两位小数**；与 `src/utils/format.js` 的 round2 同式）。
 *  为什么这里必须圆整而不是直接相加：`12.6 + 0.2 = 12.799999999999999`（二进制浮点），
 *  直接把该值报给 MES 会带一串尾数。**库内存的是数值真值（未圆整）**，圆整只发生在换算出口。 */
function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * 单个指标的上下限**绝对值**。
 * @param {{typical?:number, upperDev?:number, lowerDev?:number}} row 如 { typical:12.6, upperDev:0.2, lowerDev:-0.2 }
 * @returns {{upper:number, lower:number, typical:number}|null} 必要项缺一 → null（＝"未设定"）
 */
function metricLimits(row) {
  if (!row || typeof row !== 'object') return null;
  if (!METRIC_FIELDS.every(f => isNum(row[f]))) return null;
  return {
    upper: round2(row.typical + row.upperDev),
    lower: round2(row.typical + row.lowerDev),
    typical: row.typical
  };
}

/** 从库行（repo.hydrate 的产物，或直接传库行）取某指标的三项值 */
function metricOf(std, kind) {
  if (!std) return null;
  const key = `${kind}Typical`;
  const upperKey = `${kind}UpperDev`;
  const lowerKey = `${kind}LowerDev`;
  const col = `${kind}_typical`;
  const pick = (camel, colName) => (std[camel] !== undefined ? std[camel] : std[colName]);
  return {
    typical: pick(key, col),
    upperDev: pick(upperKey, `${kind}_upper_dev`),
    lowerDev: pick(lowerKey, `${kind}_lower_dev`)
  };
}

/**
 * 该标准行的深度/速度上下限绝对值。
 * @returns {{depth:object|null, speed:object|null}} 单个指标缺必要项时该指标为 null
 */
function absoluteLimits(std) {
  const out = {};
  for (const kind of METRICS) out[kind] = metricLimits(metricOf(std, kind));
  return out;
}

/**
 * 标准是否**完整可用**（两个指标的三个必要项都齐）。
 * 口径（F-05 的建议、负责人拍定）：**任一必要项缺失 ⇒ 整条占位** ——
 * 不是"缺哪个补哪个"，因为一条 `dataList` 同时承载深度与速度以外的判定语义，
 * 半套标准会让 MES 侧无从判断"这条到底做没做判定"。
 * @returns {boolean}
 */
function isComplete(std) {
  if (!std) return false;
  return METRICS.every(kind => metricLimits(metricOf(std, kind)) !== null);
}

/**
 * 组装 MES 的上下限与判定字段。
 *
 * · 标准完整 ⇒ `{ uclValue, lclValue, IsPass }`；`uclValue` / `lclValue` 取**绝对值**（按 `kind` 选指标）；
 * · 任何必要项缺失（含整条标准不存在）⇒ **整条占位**：`{ 65535, 65535, null }`。
 *
 * ⚠ `IsPass` 的**判定**不在本函数内（判定引擎按绝对值判合格与否后传入）；本函数只负责
 * "标准值这一侧"的取值与占位，避免把判定逻辑与取值口径混在一处。
 *
 * @param {object|null} std 标准行（repo.getEffective 的产物）
 * @param {{kind?:'depth'|'speed', pass?:boolean|null}} [options] kind 缺省 depth（附录 2 是深度/速度两条 dataList）
 * @returns {{uclValue:number, lclValue:number, IsPass:boolean|null}}
 */
function mesLimits(std, options = {}) {
  const kind = options.kind === 'speed' ? 'speed' : 'depth';
  const pass = options.pass === true ? true : (options.pass === false ? false : null);
  if (!isComplete(std)) return { ...MES_PLACEHOLDER };
  const lim = absoluteLimits(std)[kind];
  if (!lim) return { ...MES_PLACEHOLDER };   // 冗余兜底（isComplete 已覆盖，防以后放宽 isComplete 时漏掉）
  return { uclValue: lim.upper, lclValue: lim.lower, IsPass: pass };
}

/**
 * 界面显示用的标准快照（FR-3.18）：**偏差形式**（上下限按正负偏差显示与录入）＋典型值。
 * 数值**不做四舍五入**（库内即真值），小数位由显示层按 round2 处理。
 * @returns {{depth:object|null, speed:object|null, versionNo:number|null, effectiveFrom:string|null}}
 */
function toDisplayStandard(std) {
  if (!std) return { depth: null, speed: null, versionNo: null, effectiveFrom: null };
  const out = { versionNo: std.versionNo === undefined ? null : std.versionNo, effectiveFrom: std.effectiveFrom === undefined ? null : std.effectiveFrom };
  for (const kind of METRICS) {
    const m = metricOf(std, kind);
    const complete = METRIC_FIELDS.every(f => isNum(m[f]));
    out[kind] = {
      typical: isNum(m.typical) ? m.typical : null,
      upperDev: isNum(m.upperDev) ? m.upperDev : null,
      lowerDev: isNum(m.lowerDev) ? m.lowerDev : null,
      /* 绝对值（上限/下限）仅供界面直接显示；缺必要项则为 null，界面按"未设定"呈现 */
      upper: complete ? round2(m.typical + m.upperDev) : null,
      lower: complete ? round2(m.typical + m.lowerDev) : null,
      set: complete
    };
  }
  return out;
}

/**
 * 该指标的量程（FR-3.19 第⑥步"超量程"判据的**单一真源**）。
 * 取 `board.config.js` 的 `standards.range[kind]`；配置缺项/非法 ⇒ 返回 null
 * （＝本项校验不参与，**实现里不写死任何量程数字**；与前端 `TaskPanel.rangeOf()` 同款）。
 * @param {'depth'|'speed'} kind
 * @returns {{min:number|null, max:number|null}|null}
 */
function rangeOf(kind) {
  const seg = (boardConfig && boardConfig.standards && boardConfig.standards.range) || null;
  const r = seg && seg[kind];
  if (!r || typeof r !== 'object') return null;
  const min = typeof r.min === 'number' && Number.isFinite(r.min) ? r.min : null;
  const max = typeof r.max === 'number' && Number.isFinite(r.max) ? r.max : null;
  if (min === null && max === null) return null;
  return { min, max };
}

/**
 * 超量程校验（FR-3.19 第⑥步）：录入得到的**导出上限/下限绝对值**不得越出量程。
 * 为什么按"绝对值"而不是"偏差"判：需求原文就是"按导出的上/下限绝对值判定"（C-91/C-93④）。
 * @throws {RangeError} 越界时抛出，消息里点明参数名 + 实际值 + 量程（可读、可核对）
 */
function assertRange(raw) {
  const limits = absoluteLimits(raw);
  for (const kind of METRICS) {
    const lim = limits[kind];
    if (!lim) continue;                        // 该指标未算得出上下限（半套/未录入）⇒ 本项不参与
    const range = rangeOf(kind);
    if (!range) continue;                      // 配置无量程 ⇒ 不写死兜底，跳过
    for (const [name, v] of [['上限', lim.upper], ['下限', lim.lower]]) {
      const over = (range.min !== null && v < range.min) || (range.max !== null && v > range.max);
      if (over) {
        throw new RangeError(
          `standard: ${kind} 的${name} ${v} 超出量程 [${range.min}, ${range.max}] —— 拒绝写入（FR-3.19 第⑥步"超量程"）`);
      }
    }
  }
  return true;
}

/**
 * 校验"下限 ≤ 上限"、"典型值在上下限之间"与"不超量程"（FR-3.19 第 6 步）。
 * 输入可以是服务层的 `{ depthTypical, depthUpperDev, ... }`，也可以是直接传入的库行
 * （`metricOf` 会同时认小驼峰与下划线两种键名）。
 * @param {object} raw
 * @param {{requireComplete?:boolean, checkTypical?:boolean, checkRange?:boolean}} [options]
 *   requireComplete=true 时，指标"半套"（只填了三个必要项的一部分）也判非法；
 *   checkTypical=false 时跳过"典型值在区间内"（供"典型值未设定"的历史数据回放使用）；
 *   checkRange **缺省即校验**（`!== false`，W4 起）—— 超量程按 FR-3.19⑥ 拒收。显式传
 *   `false` 只用于"配置无量程的旧数据回放"这类**受控**场景，调用点必须写明理由。
 * @returns {boolean} 合法即 true；非法抛错
 */
function assertLimits(raw, options = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('standard.assertLimits: 入参必须是对象');
  }
  for (const kind of METRICS) {
    const m = metricOf(raw, kind);
    const present = METRIC_FIELDS.filter(f => m[f] !== undefined && m[f] !== null && m[f] !== '');
    /* 半套标准（三个必要项只填了一部分）一律拒收：否则会落一条"永远只能走占位"的行，
       在界面上却看起来像已录入的标准 —— 这正是 F-05 点出的歧义来源。 */
    if (options.requireComplete !== false && present.length > 0 && present.length < METRIC_FIELDS.length) {
      throw new TypeError(
        `standard: ${kind} 的典型值/上偏差/下偏差必须**同时给出**（当前只给了 ${present.join('、')}）—— ` +
        '半套标准无法判定，也保证不了"任一必要项缺失 ⇒ 占位"的口径');
    }
    for (const f of present) {
      const v = typeof m[f] === 'string' ? Number(m[f]) : m[f];
      if (!isNum(v)) {
        throw new TypeError(`standard: ${kind}.${f} 必须是有限数值，收到 ${JSON.stringify(m[f])}`);
      }
    }
  }
  const limits = absoluteLimits(raw);
  for (const kind of METRICS) {
    const lim = limits[kind];
    if (!lim) continue;                       // 该指标未录入：跳过限额校验（是否允许只录一个指标由调用方决定）
    if (lim.lower > lim.upper) {
      throw new RangeError(
        `standard: ${kind} 的下限 ${lim.lower} 大于上限 ${lim.upper} —— 拒绝写入（FR-3.19 第 6 步）`);
    }
    if (options.checkTypical !== false && (lim.typical < lim.lower || lim.typical > lim.upper)) {
      /* 典型值是上下限的基准，正常必然落在区间内；不落在区间只可能是偏差符号填反了。 */
      throw new RangeError(
        `standard: ${kind} 的典型值 ${lim.typical} 不在上下限 [${lim.lower}, ${lim.upper}] 之间 —— ` +
        '请检查上下偏差的正负号（下偏差默认负、上偏差默认正）');
    }
  }
  /* 超量程（默认参与；受控场景可显式关掉）：放在"符号"校验之后 —— 符号填反这类错误
     更根本，先报它，调用方修完再看量程，错误信息不会互相掩盖。 */
  if (options.checkRange !== false) assertRange(raw);
  return true;
}

/** 录入前的完整校验（FR-3.19 第 6 步）：非法即抛错，**绝不写入**（"修改前不做任何变更"）
 *
 *  三项判据**默认全开**：半套标准（`requireComplete`）、偏差正负号（`checkTypical`）、
 *  超量程（`checkRange`）。关掉任何一项都必须**显式传参**且自带理由 —— W4 的入库口
 *  （`repo/standard.addVersion` 与 `repo/standard` 的调用方）正是靠"默认全开"做到
 *  「宁可拒收，也不落脏标准」。 */
function assertInput(input, options = {}) {
  /* 只认标准自身的字段：更宽的对象（如整份 state）也能通过，多余键不参与判定也不落库。 */
  return assertLimits(input, Object.assign(
    { requireComplete: true, checkTypical: true, checkRange: true }, options));
}

/** 便捷函数：上面两个函数的组合（供调用方一次性拿到"绝对值 + MES 字段"） */
function limitsOf(std, options = {}) {
  return { absolute: absoluteLimits(std), mes: mesLimits(std, options), complete: isComplete(std) };
}

/**
 * 取**指定时刻生效**的标准（FR-3.18 的取值口径：来源 `standard` 按 (产品＋工序) 取值）。
 * @param {object} db
 * @param {{productCode:string, processCode?:string, at?:string}} query
 * @returns {object|null} repo.hydrate 后的标准行（无生效版本 → null，不回退到最新版）
 */
function getEffectiveStandard(db, query) {
  return repo.getEffective(db, query);
}

module.exports = {
  MES_PLACEHOLDER,
  METRICS,
  METRIC_FIELDS,
  isNum,
  round2,
  metricLimits,
  absoluteLimits,
  isComplete,
  mesLimits,
  toDisplayStandard,
  rangeOf,
  assertRange,
  assertLimits,
  assertInput,
  limitsOf,
  getEffectiveStandard
};
