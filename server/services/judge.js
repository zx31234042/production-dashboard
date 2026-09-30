/* ==========================================================================
   判定引擎（server/services/judge.js）—— **服务端权威实现**（W3）
   作用：把"单任务结果"与"预警"从需求条款变成**纯函数**（可单测、不读系统时间、不碰 IO）：
     ① **标准上下限导出**（FR-3.18 / FR-3.19 / DR-03）：三格录入＝典型值 / 上偏差 / 下偏差，
        `上限 = 典型值 + 上偏差`、`下限 = 典型值 + 下偏差`；**取数一律复用既有实现**——
        · 换算公式与"必要项缺一即未设定"的语义 → `services/standard.js` 的 `metricLimits()`；
        · 运行期标准行的取值（指定时刻生效版本）→ `services/standard.js` 的
          `getEffectiveStandard()`（其内部是 `repo/standard.js` 的 DR-03 查询）。
        本文件**不重写第二套取数口径**，只负责"把三种形态的标准对象归一化后交给它"。
     ② **三态判据** `standardLevel()`（FR-3.14 / FR-3.18）：ok 正常 / warn 临近 / err 超范围 / idle 未设定。
        · **闭边界**：实测落闭区间 `[下限, 上限]` 之外才是 err ⇒ **压线（恰等于上/下限）算合格**；
        · **临近带含等号**：距上/下限边界的距离 ≤ `(上限−下限) × 临近比例` 即 warn
          ⇒ **距边界恰等于带宽判临近、再外一格判 ok**；
        · 比较全部换算到**显示精度网格**（两位小数 ⇒ 0.01）上的整数再做，无二进制浮点误差；
        · **`idle`（标准必要项缺失 或 实测缺测）⇒ 不判定**：既不判合格、也不判超范围、也不出参数类预警。
     ③ **单任务五态**（FR-3.13）`taskResult()`：待测试 / 测试中 / 合格 / 不合格 / 待复检
        （"待复检"的进入条件见该函数 docblock —— 需求只列了五个状态、**未定义进入规则**，
          本实现按"我方判定依据是否成立"选择，理由逐条写在函数上）。
     ④ **四类预警**（FR-5.8～5.11）`buildWarnings()`：参数类 0～2 条
        （C-88 两条具名「参数阈值临近预警」/「参数超范围预警」，**一个参数一条、同态也各出一条**）
        ＋ 维保到期 1 条 ＋ 耗材更换 / 工单超时各 1 条（后两类**入参拿不到时不产生**，
        理由与"为什么不编造"见 `buildWarnings()` 的 docblock）。**阈值一律从配置真源读**（见 `thresholds()`），
        代码里不写死任何阈值字面量。
   与前端演示实现的关系（**对账物，不是真源**）：
     `src/services/mockData.js` 的 `standardLevel()` / `buildParamWarnings()` / `buildWarnings()`
     是浏览器侧的**第二份同类实现**（演示用，本包一行不得改）。本文件的口径与之**逐条对齐**：
     三态公式、名称、等级、成条规则、detail 文案与顺序全部同规则；对账断言见
     `tests/logic-check.js` 的「九、跨实现对账」段（15 组输入序列逐条比对）。
     ⚠ 相机参数（帧率 / 增益 / 快门 / 相机设定深度）**不参与任何判定**（C-84④）—— 本文件里
       只有 `depth` / `speed` 两个判定对象，任何取数都不会碰到相机参数。
   依赖：`platform/clock.js`（时间注入与格式化）、`services/standard.js`（标准换算，只读复用）、
        `src/config/board.config.js`（阈值与临近比例的唯一真源，Node 侧同一份）。
   用法：
     const judge = require('./services/judge');
     judge.standardLevel(5.22, { typical: 5, upperDev: 0.3, lowerDev: -0.2, digits: 2 });  // → warn 临近
     judge.taskResult({ progress: 1, real: { depth: 5.22, speed: 5 }, standard: std });
     judge.buildWarnings({ now, real, standard, consumableHours, pendingQty });
   ========================================================================== */
'use strict';

const boardConfig = require('../../src/config/board.config.js');
const { toDate, fmtDate, DAY_MS } = require('../../platform/clock');
const standard = require('./standard');
const { KIND: EVENT_KIND } = require('./eventBus');

/** 判定对象（FR-3.14 / C-75：**只有深度与速度**；相机参数不参与，C-84④） */
const PARAMS = Object.freeze(['depth', 'speed']);
/** 参数中文名（FR-3.18 显示与 detail 文案的唯一口径，前端同为这两个词） */
const PARAM_CN = Object.freeze({ depth: '深度', speed: '速度' });
/** C-88 的两条具名预警：名称 ⇔ 等级色**一一对应**（warn = 黄 / err = 红） */
const WARN_TITLES = Object.freeze({ warn: '参数阈值临近预警', err: '参数超范围预警' });
/** 非参数类三类预警的标题（FR-5.9 / 5.10 / 5.11） */
const OTHER_TITLES = Object.freeze({
  maintenance: '设备维保到期预警', consumable: '耗材更换预警', order: '工单超时预警'
});
/** 显示精度缺省位数（与配置 `standards.digits` 同源；前端亦有同名缺省，两侧逐字对齐） */
const DEFAULT_DIGITS = 2;
/** 临近比例缺省值（真源＝配置 `standards.nearRatio`；本缺省与前端 `nearRatio()` 的缺省同值） */
const DEFAULT_NEAR_RATIO = 0.15;

/* ---------------- 配置真源（**每次调用现读**：内存覆盖配置后判据立即跟随，不做加载期快照） ---------------- */
function standardsCfg() { return boardConfig.standards || {}; }
function maintenanceCfg() { return boardConfig.maintenance || {}; }
function warningsCfg() { return boardConfig.warnings || {}; }

/** 有限数值判定（与 `services/standard.js` 的 `isNum` 同口径） */
const isNum = standard.isNum;
/** 保留两位小数（**复用** `services/standard.js` 的换算出口，不另写一份） */
const round2 = standard.round2;

/** 取配置里的**阈值型**数值：取不到即抛错，**绝不静默兜底成字面量**（阈值只在配置里） */
function requiredThreshold(value, key) {
  if (!isNum(value)) {
    throw new TypeError(`judge: 配置项 ${key} 必须是有限数值（阈值一律走配置真源，代码里不写死）`);
  }
  return value;
}

/** 临近带比例（FR-3.18 / C-85；真源＝`standards.nearRatio`，缺省同前端 0.15） */
function nearRatio() {
  const r = standardsCfg().nearRatio;
  return isNum(r) ? r : DEFAULT_NEAR_RATIO;
}

/** 显示精度位数（真源＝`standards.digits`，缺省 2） */
function digitsOf() {
  const d = standardsCfg().digits;
  return isNum(d) ? d : DEFAULT_DIGITS;
}

/** 四类预警的阈值/真源快照（供自检与调用方核对"阈值可配"；全部现读配置） */
function thresholds() {
  const c = (maintenanceCfg().consumables || [])[0] || {};
  return {
    nearRatio: nearRatio(),
    digits: digitsOf(),
    maintWarnDays: requiredThreshold(maintenanceCfg().warnDays, 'maintenance.warnDays'),
    maintCycleDays: requiredThreshold(maintenanceCfg().cycleDays, 'maintenance.cycleDays'),
    consumableName: c.name,
    consumableThreshold: requiredThreshold(c.threshold, 'maintenance.consumables[0].threshold'),
    consumableUnit: c.unit,
    orderOverduePending: requiredThreshold(warningsCfg().orderOverduePending, 'warnings.orderOverduePending')
  };
}

/* ---------------- 标准取数（三种形态归一化后交给 services/standard.js） ---------------- */

/** DR-03 库行里是否有该指标的列（小驼峰／下划线两种写法都认） */
function hasRowKeys(src, kind) {
  return src[`${kind}Typical`] !== undefined || src[`${kind}_typical`] !== undefined;
}

/** 取库行里某指标的三格（**只做字段名映射**；换算一律交给 `services/standard.js`） */
function rowMetricOf(src, kind) {
  const pick = (a, b) => (src[a] !== undefined ? src[a] : src[b]);
  return {
    typical: pick(`${kind}Typical`, `${kind}_typical`),
    upperDev: pick(`${kind}UpperDev`, `${kind}_upper_dev`),
    lowerDev: pick(`${kind}LowerDev`, `${kind}_lower_dev`)
  };
}

/**
 * 取某参数的标准规格（三格：典型值 / 上偏差 / 下偏差），**支持三种形态**：
 *   ① 运行期真源形态（FR-3.19 现场录入，前端 `state.task.standard[kind]` 同形）：
 *      `{ depth: { typical, upperDev, lowerDev, unit?, digits? }, speed: {...} }`；
 *   ② DR-03 库行形态（`repo/standard.js` 的 hydrate 产物）：`{ depthTypical, depthUpperDev,
 *      depthLowerDev, ... }`（下划线列名同样接受）；
 *   ③ 配置演示缺省（FR-3.18 的"未录入时用 `standards.default`"，**仅演示**）：与前端
 *      `standardSpecOf()` 的回退顺序**逐条一致**（运行期真源优先 → 缺省段兜底）。
 * ⚠ 两种"缺"的区别（有意为之）：**运行期真源**里缺某个参数 ⇒ 按 FR-3.18 回退配置演示段
 *   （与前端同口径）；而**库行形态**缺某个参数的列 ⇒ 该参数判"未设定"（**不回退演示值**）——
 *   库行是权威取数路径，拿演示值去顶真实标准会变成"用演示值判定真任务"。
 *   （`hasRowKeys()` 按**任一参数**有库行列名即认定"这是库行"；因此"只有深度列、没有速度列"的
 *    半套库行 ⇒ 深度照判、**速度判 idle**，不会悄悄用演示速度标准去判。）
 * 三形态都**不含**相机参数 ⇒ 判定对象恒只有深度与速度。
 * @returns {object|null} 规格对象；未设定 ⇒ null（`standardLevel` 会判 idle）
 */
function specOf(standardLike, kind) {
  /* 入参语义（**判定"标准未设定"的唯一口径**，生产侧 E45 接线后尤其关键）：
       · 没传 / 传了非对象 ⇒ "调用方根本没给标准" ⇒ 走 ③ 配置演示段（与前端演示同口径）；
       · 传了**对象**（哪怕空对象）⇒ "这就是本次判定的标准真源" ⇒ 只从里面取，取不到就是
         **未设定（null）**，**绝不回退演示值**。服务端生产装配用 `{depth:null, speed:null}`
         显式表达"库里没有生效版本"，正是走这一支 —— 拿 `standards.default` 去顶真实缺失
         会变成"用演示值判定真任务"。 */
  const src = (standardLike && typeof standardLike === 'object') ? standardLike : null;
  if (src) {
    const live = src[kind];
    if (live && typeof live === 'object') return live;                  // ① 运行期真源形态
    if (PARAMS.some(k => hasRowKeys(src, k))) {                          // ② 库行形态（DR-03 hydrate 产物）
      if (!hasRowKeys(src, kind)) return null;                           // 该参数没有列 ⇒ 未设定
      const m = rowMetricOf(src, kind);
      const dft = (standardsCfg().default || {})[kind] || {};
      /* 库内无单位列（需求把单位固定为 深度 m / 速度 m/s）⇒ 在**归一化处**补上，
         这样 detail 文案与前端一致（前端读 `spec.unit`）；不在这里写死 m / m/s 字面量。 */
      return { typical: m.typical, upperDev: m.upperDev, lowerDev: m.lowerDev, unit: dft.unit };
    }
    return null;                                                         // 传了对象但该指标没有值 ⇒ 未设定
  }
  /* ③ 演示缺省：**只在调用方根本没给标准**时才走这里（与前端 `standardSpecOf()` 的回退顺序一致）。
     ⚠ 反例（本波收口）：`standard` 传了对象但该指标的必要项缺测 ⇒ 上面两支已 `return null`，
     **不得**再走本行 —— 这与 FR-3.18 / C-93⑤"典型值缺失 ⇒ 不判定、不预警"、
     FR-5.8"标准未设定 ⇒ 两条都不产生"直接冲突。 */
  const dft = (standardsCfg().default || {})[kind];
  return dft || null;
}

/**
 * 深度 / 速度的**上下限绝对值**（FR-3.18 的"只读导出值"，也是判定对象 FR-3.14）。
 * 换算与"必要项缺一即 null（未设定）"的语义**全部复用** `services/standard.js` 的 `metricLimits()`。
 * @returns {{depth: {upper:number, lower:number, typical:number}|null, speed: object|null}}
 */
function limits(standardLike) {
  const out = {};
  for (const kind of PARAMS) out[kind] = standard.metricLimits(specOf(standardLike, kind));
  return out;
}

/**
 * 取**指定时刻生效**的标准行（DR-03：`effective_from ≤ t` 的最大 `version_no`；
 * 无生效版本 ⇒ null，**不回退最新版**）。转发给既有服务层，判定引擎不直接摸库。
 * @param {object} db
 * @param {{productCode:string, processCode?:string, at?:string}} query
 */
function resolveStandard(db, query) {
  return standard.getEffectiveStandard(db, query);
}

/* ---------------- 三态判据（与前端 mockData.standardLevel 逐字同规则） ---------------- */

/**
 * 测试标准三态（FR-3.14 / FR-3.18）—— 服务端权威实现。
 *   · err（红，超范围）：实测落在**闭区间** `[下限, 上限]` 之外 ⇒ **压线（恰等于上/下限）算合格**；
 *   · warn（黄，临近）  ：距上/下边界的距离 ≤ `(上限−下限) × 临近比例`（**含等号**，且至少一格）；
 *   · ok（正常）        ：其余；
 *   · idle（标准未设定）：实测非有限数（缺测）**或**标准必要项（典型值/上偏差/下偏差）缺一
 *                        ⇒ **不判定**（不判合格、也不判超范围）。
 * 比较口径：全部换算到**显示精度网格**（`digits` 位小数 ⇒ 一格 = 10^-digits）上的整数再比，
 * 判据即"距离格数 ≤ 带宽格数"，因此 `5.2 − 0.06` 这类浮点尾数不会漏判一格。
 * @param {number} real 实测值（深度 m / 速度 m/s）
 * @param {object|null} spec 标准规格（typical / upperDev / lowerDev / digits? / unit?）
 * @returns {{lv:'idle'|'ok'|'warn'|'err', text:'标准未设定'|'正常'|'临近'|'超范围'}}
 */
function standardLevel(real, spec) {
  if (!isNum(real) || !spec ||
      !isNum(spec.typical) || !isNum(spec.upperDev) || !isNum(spec.lowerDev)) {
    return { lv: 'idle', text: '标准未设定' };
  }
  const digits = isNum(spec.digits) ? spec.digits : digitsOf();
  const GRID = Math.pow(10, -digits);
  const upper = round2(spec.typical + spec.upperDev);
  const lower = round2(spec.typical + spec.lowerDev);
  const tol = (upper - lower) * nearRatio();
  const unit = 1 / GRID;
  /* 带宽格数 k = max(1, ceil(tol × 每单位格数))：**含等号**（距离 ≤ 带宽即临近）且至少一格；
     `- 1e-9` 是浮点容差修正（`0.4 × 0.15 = 0.06000000000000005`）。 */
  const k = Math.max(1, Math.ceil(tol * unit - 1e-9));
  const vU = Math.round(round2(real) * unit);
  const upU = Math.round(upper * unit);
  const loU = Math.round(lower * unit);
  /* 三态区间（上下对称）：
       err ：v < 下限 或 v > 上限（判定区间是**闭区间** [下限, 上限]，压线即合格）；
       warn：[上限−tol, 上限) 或 (下限, 下限+tol] —— **含等号**，但不含上/下限本身；
       否则 ok。 */
  if (vU > upU || vU < loU) return { lv: 'err', text: '超范围' };
  if ((upU - vU <= k && vU < upU) || (vU - loU <= k && vU > loU)) {
    return { lv: 'warn', text: '临近' };
  }
  return { lv: 'ok', text: '正常' };
}

/** 某参数"为什么没判定"（仅在 `standardLevel` 返回 idle 时有意义；供复检原因与自检取证） */
function idleWhy(real, spec) {
  if (!isNum(real)) return '实测缺测';
  if (!spec || !isNum(spec.typical) || !isNum(spec.upperDev) || !isNum(spec.lowerDev)) return '标准未设定';
  return null;
}

/* ---------------- 参数类预警（FR-5.8 / C-88） ---------------- */

/** 单条参数类预警的 detail（文案与前端 `buildParamWarnings().detailOf` 逐字同规则） */
function paramDetail(kind, spec, lvText, realValue) {
  const d = isNum(spec.digits) ? spec.digits : digitsOf();
  const unit = spec.unit ? ' ' + spec.unit : '';
  const upper = round2(spec.typical + spec.upperDev);
  const lower = round2(spec.typical + spec.lowerDev);
  return PARAM_CN[kind] + ' ' + round2(realValue).toFixed(d) + unit +
    '（标准 ' + lower.toFixed(d) + '～' + upper.toFixed(d) + unit + '）判' + lvText;
}

/**
 * 参数类预警（FR-5.8，P0）—— **两条具名**（C-88）：
 *   · 临近（warn）⇒「参数阈值临近预警」；超范围（err）⇒「参数超范围预警」（名称 ⇔ 等级色一一对应）。
 * **一个参数最多一条**：深度与速度**各自独立成条**（**同态也各出一条**，R26-P2-2 收口后的口径），
 * 每条 detail **只含一个参数**、不得用「；」拼接两参数；排序只为稳定展示（err 在前、warn 在后，
 * 同态则维持 深度 → 速度）。**标准未设定 / 实测缺测（idle）⇒ 该参数两条都不产生**；
 * 相机参数一律不参与（C-84④）。
 * 两参数都正常时给**一条 ok 回执条**（非预警，不计入 warnCount；detail 明示"均处于允许范围"），
 * 两参数都未设定时**一条都不出**（与 FR-5.8 的"标准未设定 ⇒ 两条都不产生"一致）。
 * @param {{real:object, standard?:object}} input
 * @returns {Array<{title:string, detail:string, lv:'ok'|'warn'|'err'}>} 0～2 条
 */
function buildParamWarnings(input = {}) {
  const real = (input.real && typeof input.real === 'object') ? input.real : {};
  const rows = PARAMS.map(kind => {
    const spec = specOf(input.standard, kind);
    return { kind, spec, lv: standardLevel(real[kind], spec) };
  }).filter(r => r.lv.lv !== 'idle');            // idle ⇒ 该参数不进任何一条
  const order = { err: 0, warn: 1, ok: 2 };
  const sorted = rows.filter(r => r.lv.lv !== 'ok')     // 正常态不单独成条（并入下方 ok 汇总回执）
    .sort((a, b) => order[a.lv.lv] - order[b.lv.lv]);
  const out = sorted.map(r => ({
    title: r.lv.lv === 'err' ? WARN_TITLES.err : WARN_TITLES.warn,
    detail: paramDetail(r.kind, r.spec, r.lv.text, real[r.kind]) +
      (r.lv.lv === 'warn'
        ? '（临近判据：实测距上/下限边界 ≤ (上限−下限)×' + nearRatio() + '）'
        : '（超出标准上下限闭区间，压线即合格）'),
    lv: r.lv.lv
  }));
  if (!out.length && rows.length) {
    out.push({
      title: WARN_TITLES.warn,
      detail: rows.map(r => paramDetail(r.kind, r.spec, r.lv.text, real[r.kind])).join('；') +
        '，均处于允许范围',
      lv: 'ok'
    });
  }
  return out;
}

/* ---------------- 维保 / 耗材 / 工单三类预警（FR-5.9～5.11，阈值全部读配置） ---------------- */

/**
 * 维保计划状态（FR-6.1～6.3 的日期推导，预警判据的输入）：
 * 下次维保 = 上次维保日 + 固定周期（天）；剩余天数 = `ceil((下次维保 − now) / 一天)`，下限 0。
 * 口径与前端演示实现一致（同一份配置、同一算式）；**now 必须由调用方注入**（业务代码不读系统时间）。
 */
function maintenanceState(now) {
  const m = maintenanceCfg();
  const lastDate = m.lastDate;
  if (typeof lastDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) {
    throw new TypeError(`judge: 配置项 maintenance.lastDate 必须是「yyyy-MM-dd」（收到 ${JSON.stringify(lastDate)}）`);
  }
  const lastAt = new Date(lastDate + 'T00:00:00');
  if (Number.isNaN(lastAt.getTime())) {
    throw new TypeError(`judge: 配置项 maintenance.lastDate 无法解析为日期（收到 ${JSON.stringify(lastDate)}）`);
  }
  const cycleDays = requiredThreshold(m.cycleDays, 'maintenance.cycleDays');
  const at = toDate(now);
  const nextAt = new Date(lastAt.getTime() + cycleDays * DAY_MS);
  return {
    lastDate, cycleDays, nextAt,
    next: fmtDate(nextAt),
    daysLeft: Math.max(0, Math.ceil((nextAt.getTime() - at.getTime()) / DAY_MS))
  };
}

/** 维保到期预警（FR-5.9）：剩余天数 ≤ 配置的提前天数 ⇒ warn，否则 ok */
function maintenanceWarning(now, warnDays) {
  const st = maintenanceState(now);
  const warn = st.daysLeft <= warnDays;
  return {
    title: OTHER_TITLES.maintenance,
    detail: warn ? `距计划维保还有 ${st.daysLeft} 天（${st.next}）` : `距计划维保还有 ${st.daysLeft} 天`,
    lv: warn ? 'warn' : 'ok'
  };
}

/** 耗材更换预警（FR-5.10）：累计点亮时长 > 配置阈值 ⇒ warn；阈值与名称/单位都取配置（无字面量） */
function consumableWarning(hours) {
  const t = thresholds();
  if (!isNum(hours)) {
    throw new TypeError(`judge: 耗材累计时长（consumableHours）必须是有限数值，收到 ${JSON.stringify(hours)}`);
  }
  const warn = hours > t.consumableThreshold;
  const name = t.consumableName;
  const unit = t.consumableUnit;
  return {
    title: OTHER_TITLES.consumable,
    detail: warn
      ? `${name}累计点亮 ${hours} ${unit}，建议更换（阈值 ${t.consumableThreshold} ${unit}）`
      : `光源累计点亮 ${hours} ${unit}，未达更换阈值（${t.consumableThreshold} ${unit}）`,
    lv: warn ? 'warn' : 'ok'
  };
}

/** 工单超时预警（FR-5.11）：设备侧待测队列件数 > 配置阈值 ⇒ err；阈值真源＝`warnings.orderOverduePending` */
function orderWarning(pendingQty) {
  const t = thresholds();
  if (!isNum(pendingQty)) {
    throw new TypeError(`judge: 待测队列件数（pendingQty）必须是有限数值，收到 ${JSON.stringify(pendingQty)}`);
  }
  const overdue = pendingQty > t.orderOverduePending;
  return {
    title: OTHER_TITLES.order,
    detail: overdue
      ? `设备侧待测队列 ${pendingQty} 件，预计超班次完成`
      : '当班工单按节拍推进，无超时风险',
    lv: overdue ? 'err' : 'ok'
  };
}

/**
 * 四类预警（FR-5.1～5.14 的预警部分）：参数类（0～2 条，C-88）＋ 维保 / 耗材 / 工单。
 * 建表顺序固定＝**参数类在前**，其后 维保 → 耗材 → 工单：这是门禁与界面识别"哪几条是参数类"的
 * 口径（不得靠名称筛）。函数**纯**：所有外部状态（时刻、累计时长、队列件数）都由入参注入。
 *
 * ⚠ **耗材 / 工单两类可缺**（本波接线 E45 时定；参数齐备时输出与原来**逐条相同**）：
 *   · `consumableHours` / `pendingQty` **未给**（`undefined`/`null`）⇒ 该类的**取数源当前拿不到**，
 *     于是**该类整条不产生**（FR-5.10 的"耗材台账/计数"、FR-5.11 的"工单计划/节拍"在服务端
 *     **都还没有数据源**：`server/` 全仓无累计点亮时长、无设备侧待测队列件数，也没有承载它们的列）；
 *   · 为什么不是"给个缺省值凑齐 5 条"：那是**伪造预警**（拿编造的耗材时长/队列件数驱动一条真实预警），
 *     与 FR-3.18/C-93⑤ 的"标准未设定 ⇒ 不判定、不预警"以及本文件"绝不静默兜底成字面量"同一纪律；
 *   · 显式传 `0` 仍然**参与**判定（`0 > 阈值` 为假 ⇒ 出 ok 条）—— "拿不到"与"真的是 0"是两件事，
 *     不得互相代言（调用方要知道自己在给什么）。
 * @param {object} input
 *   @param {Date|string} input.now 当前时刻（维保剩余天数按它算；必填，不读系统时间）
 *   @param {object} input.real 实测 `{depth, speed}`
 *   @param {object} [input.standard] 标准真源（运行期形态 / DR-03 库行形态；缺省回落配置演示段）
 *   @param {number} [input.consumableHours] 耗材（水下光源）累计点亮时长（h）；**缺 ⇒ 该类不产生**
 *   @param {number} [input.pendingQty] 设备侧待测队列件数；**缺 ⇒ 该类不产生**
 * @returns {Array<{title:string, detail:string, lv:string}>} 参数类 0～2 ＋ 维保 1 ＋（耗材/工单 各 0～1）
 */
function buildWarnings(input = {}) {
  const t = thresholds();                       // 阈值现读一次（同一帧内自洽）
  const out = [];
  buildParamWarnings(input).forEach(w => out.push(w));
  out.push(maintenanceWarning(input.now, t.maintWarnDays));
  /* 耗材 / 工单：**取数源拿不到就整条不出**（不编造），判据是"入参是否为有限数值"——`0` 是有效值 */
  if (isNum(input.consumableHours)) out.push(consumableWarning(input.consumableHours));
  if (isNum(input.pendingQty)) out.push(orderWarning(input.pendingQty));
  return out;
}

/* ---------------- 单任务五态（FR-3.13） ---------------- */

/**
 * 单任务结果（FR-3.13 五态：待测试 / 测试中 / 合格 / 不合格 / 待复检）。
 *
 * 判定路径（**判定由我方**，FR-3.13 来源列已明确；判定对象＝深度与速度的标准上下限，FR-3.14）：
 *   ① `progress` 非正数（未开工）⇒ **待测试**；
 *   ② `0 < progress < 1`（已开工、未判完）⇒ **测试中**；
 *   ③ `progress ≥ 1`（可判定）时按我方判定依据是否成立分三种：
 *        · 任一参数 idle（**标准必要项缺失** 或 **实测缺测**）⇒ **待复检**；
 *        · 任一参数 err（超范围）⇒ **不合格**；
 *        · 其余（含 warn 临近）⇒ **合格**。
 *
 * **"待复检"的进入条件（本实现的选择与理由）**：需求 FR-3.13 只列出五个状态，
 * 全篇**未定义**"待复检"的进入规则（FR-4.9 只说"复检数＝当班进入复检流程的任务数"，
 * FR-5.12 把"复检确认中"列为异常闭环状态之一，DR-05 有"复检次数"，均未给判据）。
 * 本实现选择"**我方判定依据不成立时进复检**"，理由三条：
 *   ① FR-3.18/C-93 明写"典型值缺失 ⇒ 不判定、不预警"，FR-5.8 明写"标准未设定 ⇒ 两条都不产生"
 *      ⇒ 此时既不能判合格、也不能判不合格，任务必须有一个**显式**的待处理状态（否则只能
 *      默认成合格 = 伪造判定，违背"不得伪造数据"）；
 *   ② FR-3.19 允许现场补录标准 ⇒ 补录后可**不再重测**直接复判，这正是"复检"语义；
 *   ③ 实测缺测同理（拿不到实测值就判不了），与标准未设定走同一条出口。
 *   **临近（warn）不进复检**：FR-3.14 只规定"黄=临近"的高亮与联动预警，红才是"超标"；
 *   ⇒ 临近仍判合格（但会出「参数阈值临近预警」）。⚠ 若负责人日后要求"临近即复检"，
 *   改这一处即可（**登记为待确认口径，本包只报告、不代替拍板**）。
 *
 * @param {object} input
 *   @param {number} input.progress 单任务进度 0～1（1 = 可判定；FR-3.12 的进度口径）
 *   @param {object} input.real 实测 `{depth, speed}`
 *   @param {object} [input.standard] 标准真源（缺省回落配置演示段）
 * @returns {{result:string, reason:string, levels:Array<{kind:string,lv:string,text:string,why:string|null}>, undetermined:Array<{kind:string,why:string}>}}
 */
function taskResult(input = {}) {
  const real = (input.real && typeof input.real === 'object') ? input.real : {};
  const levels = PARAMS.map(kind => {
    const spec = specOf(input.standard, kind);
    const lv = standardLevel(real[kind], spec);
    return { kind, lv: lv.lv, text: lv.text, why: idleWhy(real[kind], spec) };
  });
  const p = input.progress;
  if (!isNum(p) || p <= 0) {
    return { result: '待测试', reason: '未开工（单任务进度为 0 或缺失）', levels, undetermined: [] };
  }
  if (p < 1) {
    return { result: '测试中', reason: `测试进行中（进度 ${(p * 100).toFixed(0)}%）`, levels, undetermined: [] };
  }
  const undetermined = levels.filter(l => l.lv === 'idle').map(l => ({ kind: l.kind, why: l.why }));
  if (undetermined.length) {
    return {
      result: '待复检',
      reason: '判定依据不成立：' + undetermined.map(u => `${PARAM_CN[u.kind]}${u.why}`).join('、') +
        '（补录标准或补测后可复判，不需重测）',
      levels, undetermined
    };
  }
  const bad = levels.filter(l => l.lv === 'err').map(l => PARAM_CN[l.kind]);
  if (bad.length) {
    return { result: '不合格', reason: `${bad.join('、')}超出标准上下限（闭区间，压线即合格）`, levels, undetermined };
  }
  return { result: '合格', reason: '深度与速度均在标准上下限闭区间内（临近不算超标）', levels, undetermined };
}

/**
 * 一站式判定（供采集接入 / SSE 推送直接消费）：五态 + 参数类三态 + 四类预警一次给全。
 *
 * **W5-① 事件挂钩（可选、不破坏本文件的"纯函数"性质）**：传了 `options.bus` 时，把这一次的
 * **判定/预警产出**（`{result, reason, levels, warnings}`）发布成一条 `warning` 事件。
 * 为什么做成**显式可选**而不是默认发布：
 *   · 本文件是判定口径的**纯函数实现**（不读系统时间、不碰 IO），前端演示实现要与之逐条对账
 *     （见 `tests/logic-check.js` 第九节）——默认发布会让"算一次判定"这种纯调用产生副作用；
 *   · 谁调用判定、谁决定要不要推给看板（**发布与否是调用方的装配决定**）。
 * **接线现状（W5-②，2026-09-30）**：生产侧已有**唯一**调用方 —— `server/index.js` 的判定装配
 *   （`server/index.js` 里 `emitWarnings()`），由 `services/ingest.js` 的 `options.onSampled`
 *   在"**1 s 采样落库成功**"之后回调；即 `warning` 事件挂在真实写入点上（技术债 E45 已接线）。
 *   `tests/harness-check.js` 的第六/第九节按"**真实写入点**"判据断言，不再由夹具直调本函数。
 * `at` 取 `input.now`（业务上的"判定时刻"，由调用方注入）；未给则由总线用注入时钟兜底。
 * @param {object} input 见 `taskResult()` 与 `buildWarnings()`
 * @param {{bus?:object, publish?:boolean}} [options] `publish:false` 可显式关掉发布（默认：给了 bus 就发）
 * @returns {{result:string, reason:string, levels:object[], warnings:object[]}}
 */
function evaluate(input = {}, options = {}) {
  const r = taskResult(input);
  const out = { result: r.result, reason: r.reason, levels: r.levels, warnings: buildWarnings(input) };
  const bus = options.bus || null;
  if (bus && options.publish !== false) {
    if (typeof bus.publish !== 'function') {
      throw new TypeError('judge.evaluate: options.bus 传了但不是事件总线（缺 publish）——见 services/eventBus.js');
    }
    bus.publish(EVENT_KIND.WARNING, out, input.now === undefined ? undefined : { at: input.now });
  }
  return out;
}

module.exports = {
  PARAMS,
  PARAM_CN,
  WARN_TITLES,
  OTHER_TITLES,
  nearRatio,
  digitsOf,
  thresholds,
  specOf,
  limits,
  resolveStandard,
  maintenanceState,
  standardLevel,
  idleWhy,
  paramDetail,
  buildParamWarnings,
  maintenanceWarning,
  consumableWarning,
  orderWarning,
  buildWarnings,
  taskResult,
  evaluate
};
