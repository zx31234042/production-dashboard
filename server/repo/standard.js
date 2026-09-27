/* ==========================================================================
   测试标准仓储（server/repo/standard.js）
   作用：`standard` 表（DR-03）的读写。模型＝「**(产品,工序,版本) 追加式**」：
         一条标准＝一行；改标准＝**新增一行（version_no +1）**，旧行原样保留、永不覆盖。
         这样"历史判定不追溯"才成立 —— 判定当时引用的版本行仍在库里，事后回查不被改写。
         本模块**只做 SQL 与参数校验，不做业务判断**（上下限换算、判定、MES 口径在
         `server/services/standard.js`）。
   依据：DR-03（需求 V1.33）、草案第四节 DR-03 增列、FR-3.18 / FR-3.19、
         DR-16（时间格式 yyyy-MM-dd HH:mm:ss）、ADR-0002 D11（不碰平台专有行为）。
   表与列（唯一真源：`server/db/schema.sql`，本模块不做运行时补列/迁移）：
         standard.product_code      产品号（标准维度之一）
         standard.process_code     工序号（标准维度之二；'' = 该产品通用）
         standard.version_no       版本号（同一 产品+工序 内从 1 起，唯一键的一部分）
         standard.depth_upper_dev  深度上偏差（m，默认正）
         standard.depth_lower_dev  深度下偏差（m，默认负）
         standard.depth_typical    深度典型值（m，只显示、不参与判定）
         standard.speed_upper_dev  速度上偏差（m/s）
         standard.speed_lower_dev  速度下偏差（m/s）
         standard.speed_typical    速度典型值（m/s）
         standard.effective_from   生效时间（取"指定时刻生效版本"用它）
         standard.created_by       录入人
         standard.team_code        录入时当前生效班次的班组编号（与 FR-1.6 同一真源）
         standard.created_at       落库时间
   单位口径：速度 **m/s**、深度 **m**，库内**存数值**（偏差可为负）；两位小数由上层换算。
   用法：
     const repo = require('./repo/standard');
     const now = '2026-09-22 09:00:00';                     // 当前时刻（第 4 实参，必填；由调用方注入的时钟给出）
     const added = repo.addVersion(db, {
       productCode: 'P-1001', processCode: '30', createdBy: '张伟', teamCode: '检验一班',
       depthUpperDev: 0.20, depthLowerDev: -0.20, depthTypical: 12.60,
       speedUpperDev: 0.30, speedLowerDev: -0.30, speedTypical: 4.90
     }, '2026-09-22 08:00:00', now);                       // 第 3 实参＝生效时间（可省，省＝now）；第 4 实参＝now
     repo.getEffective(db, { productCode: 'P-1001', processCode: '30', at: '2026-09-22 09:00:00' });
     repo.listVersions(db, { productCode: 'P-1001', processCode: '30' });   // 版本历史
   注：生效时间只能走**第 3 个位置参数**；`input` 的键白名单＝productCode / processCode / createdBy /
         teamCode 与六个数值列（见 normalizeInput），**effectiveFrom 不在白名单** —— 写进 `input`
         会被**静默忽略**，不会报错，也不会生效。
   ========================================================================== */
'use strict';

/* DR-16 时间格式：yyyy-MM-dd HH:mm:ss（恰好 19 字符）。
   为什么在**入库口**校验（与 server/repo/measure.js 同一铁律）：`standard` 的"指定时刻生效版本"
   是靠 `effective_from <= at` 的**文本比较**实现的，一旦混入带毫秒/带 T/带时区的时间，
   文本序就不再是时间序，取到的"当时生效版本"会静默取错 —— 宁可拒收，也不落脏时间。 */
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** 单条标准里，数值列的上下界（防"手滑多打几个 0"这类脏值落库；与业务量程无关，只做粗筛） */
const NUMERIC_ABS_LIMIT = 1e6;

/** 版本号上界：允许续版，但拒绝"明显不是版本号"的值（如时间戳、负数） */
const VERSION_MAX = 1_000_000;

/** 文本列最大长度（产品号/工序号/录入人/班组编号；超长一律拒收而不是截断，避免悄悄改名） */
const TEXT_MAX = 200;

/** 数值列（行对象键 → 库列名），顺序即 INSERT 参数顺序的一部分 */
const NUMERIC_FIELDS = [
  ['depthUpperDev', 'depth_upper_dev'],
  ['depthLowerDev', 'depth_lower_dev'],
  ['depthTypical', 'depth_typical'],
  ['speedUpperDev', 'speed_upper_dev'],
  ['speedLowerDev', 'speed_lower_dev'],
  ['speedTypical', 'speed_typical']
];

/** 数值列在 hydrate 后的键名（row.xxx ↔ row.xxx_dev 的映射，给直接传库行的调用方兜底） */
const NUMERIC_COLUMNS = new Map(NUMERIC_FIELDS.map(([key, col]) => [key, col]));

/** 校验时间文本（DR-16）；不合规即抛错并指出实际值 */
function assertTime(value, field) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new TypeError(
      `standard: ${field} 必须是「yyyy-MM-dd HH:mm:ss」（DR-16，19 字符），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 校验必填文本（去首尾空白后非空）；`allowEmpty` 为真时允许空串（工序号缺省＝通用） */
function assertText(value, field, allowEmpty) {
  if (value === undefined || value === null) {
    if (allowEmpty) return '';
    throw new TypeError(`standard: ${field} 不能为空`);
  }
  if (typeof value !== 'string') {
    throw new TypeError(`standard: ${field} 必须是字符串，收到 ${JSON.stringify(value)}`);
  }
  const s = value.trim();
  if (!s && !allowEmpty) throw new TypeError(`standard: ${field} 去空白后为空`);
  if (s.length > TEXT_MAX) {
    throw new RangeError(`standard: ${field} 长度 ${s.length} 超过上限 ${TEXT_MAX}`);
  }
  return s;
}

/** 校验可选文本（空值/空串 → null，便于"未录入"与空串区分开） */
function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/** 校验数值列：缺省/空串 → null（"未设定"）；否则必须是有限数、且在粗筛界内 */
function assertNumber(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new TypeError(`standard: ${field} 必须是有限数值或留空，收到 ${JSON.stringify(value)}`);
  }
  if (Math.abs(n) > NUMERIC_ABS_LIMIT) {
    throw new RangeError(`standard: ${field} 的绝对值 ${Math.abs(n)} 超过上限 ${NUMERIC_ABS_LIMIT}`);
  }
  return n;
}

/** 归一化写入入参（键名一律用小驼峰；也接受库列名的下划线写法），脏值一律抛错 */
function normalizeInput(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('standard: 录入内容必须是对象');
  }
  const raw = (key, col) => (input[key] !== undefined ? input[key] : input[col]);
  const row = {
    productCode: assertText(raw('productCode', 'product_code'), 'productCode', false),
    processCode: assertText(raw('processCode', 'process_code'), 'processCode', true),
    createdBy: optionalText(raw('createdBy', 'created_by'), 'createdBy'),
    teamCode: optionalText(raw('teamCode', 'team_code'), 'teamCode')
  };
  for (const [key, col] of NUMERIC_FIELDS) {
    row[key] = assertNumber(raw(key, col), key);
  }
  return row;
}

const INSERT_SQL =
  `INSERT INTO standard(product_code, process_code, version_no,
                        depth_upper_dev, depth_lower_dev, depth_typical,
                        speed_upper_dev, speed_lower_dev, speed_typical,
                        effective_from, created_by, team_code, created_at)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * **追加**一个标准版本（DR-03 的追加式模型：**只新增，绝不覆盖旧行**）。
 *
 * 版本号规则：同一 (product_code, process_code) 内取 `MAX(version_no) + 1`（首版＝1）。
 * 取号与插入在**同一个事务**里完成，避免并发下两人同时录入拿到同一个版本号而撞唯一键。
 *
 * ⚠ 刻意**不提供**"覆盖既有版本"的接口：任何"改标准"都必须是新版本行，
 * 否则"历史判定不追溯"立刻失效（旧判定引用的行被改写，回查不到当时的阈值）。
 *
 * @param {object} db 数据库句柄
 * @param {object} input 见 normalizeInput：productCode / processCode / 六个数值 / createdBy / teamCode
 * @param {string} [effectiveFrom] 生效时间（'yyyy-MM-dd HH:mm:ss'）；缺省＝now
 * @param {string} now 当前时刻（'yyyy-MM-dd HH:mm:ss'，由调用方注入时钟给出）
 * @returns {{id:number, productCode:string, processCode:string, versionNo:number, effectiveFrom:string}}
 */
function addVersion(db, input, effectiveFrom, now) {
  const row = normalizeInput(input);
  const at = assertTime(now, 'now');
  const effective = effectiveFrom === undefined || effectiveFrom === null || effectiveFrom === ''
    ? at
    : assertTime(effectiveFrom, 'effectiveFrom');

  db.exec('BEGIN');
  try {
    const hit = db.prepare(
      `SELECT COALESCE(MAX(version_no), 0) AS max_version FROM standard
        WHERE product_code = ? AND process_code = ?`
    ).get(row.productCode, row.processCode);
    const versionNo = Number(hit.max_version) + 1;
    if (!Number.isInteger(versionNo) || versionNo < 1 || versionNo > VERSION_MAX) {
      throw new RangeError(`standard: 版本号 ${versionNo} 超出可用范围（1～${VERSION_MAX}）`);
    }
    const r = db.prepare(INSERT_SQL).run(
      row.productCode, row.processCode, versionNo,
      row.depthUpperDev, row.depthLowerDev, row.depthTypical,
      row.speedUpperDev, row.speedLowerDev, row.speedTypical,
      effective, row.createdBy, row.teamCode, at
    );
    db.exec('COMMIT');
    return {
      id: Number(r.lastInsertRowid),
      productCode: row.productCode,
      processCode: row.processCode,
      versionNo,
      effectiveFrom: effective
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 查询条件归一：产品号必填，工序号缺省 ''（＝该产品通用） */
function normalizeQuery(query) {
  if (!query || typeof query !== 'object') {
    throw new TypeError('standard: 查询条件必须是对象');
  }
  return {
    productCode: assertText(query.productCode, 'productCode', false),
    processCode: assertText(query.processCode === undefined ? '' : query.processCode, 'processCode', true)
  };
}

/**
 * 取**指定时刻生效**的版本（DR-03 的核心查询，供 FR-3.18 显示与判定引擎取值）。
 *
 * 语义：`effective_from <= at` 的行里，取**生效时间最晚**的一条；同一生效时刻有多个版本时
 * 取 `version_no` 最大的一条（latest wins）。没有生效版本时返回 `null`
 * —— **不是**回退到"最新一版"，因为"历史不追溯"要求"当时没标准就是没标准"。
 *
 * @param {object} db
 * @param {{productCode:string, processCode?:string, at?:string}} query at 缺省＝不设上界（取最新一版）
 * @returns {object|null} hydrate 后的标准行
 */
function getEffective(db, query) {
  const q = normalizeQuery(query);
  const args = [q.productCode, q.processCode];
  let sql = 'SELECT * FROM standard WHERE product_code = ? AND process_code = ?';
  if (query.at !== undefined && query.at !== null && query.at !== '') {
    sql += ' AND effective_from <= ?';
    args.push(assertTime(query.at, 'at'));
  }
  sql += ' ORDER BY effective_from DESC, version_no DESC LIMIT 1';
  const row = db.prepare(sql).get(...args);
  return row ? hydrate(row) : null;
}

/** 取该 (产品,工序) 的**最新一版**（等价于不设时刻上界的 getEffective；语义更直白） */
function getLatest(db, query) {
  return getEffective(db, query);
}

/**
 * 版本历史（新版在前）。供"标准沿革/审计"查看 —— 旧行永不删除，故这里天然完整。
 * @param {{productCode:string, processCode?:string, limit?:number}} query
 */
function listVersions(db, query) {
  const q = normalizeQuery(query);
  const limit = Number.isInteger(query.limit) && query.limit > 0 ? ` LIMIT ${query.limit}` : '';
  return db.prepare(
    `SELECT * FROM standard WHERE product_code = ? AND process_code = ?
      ORDER BY version_no DESC${limit}`
  ).all(q.productCode, q.processCode).map(hydrate);
}

/** 某 (产品,工序) 的版本数（供自检与审计计数） */
function countVersions(db, query) {
  const q = normalizeQuery(query);
  return db.prepare(
    'SELECT COUNT(*) AS c FROM standard WHERE product_code = ? AND process_code = ?'
  ).get(q.productCode, q.processCode).c;
}

/** 全表行数（供保留策略与自检） */
function count(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM standard').get().c;
}

/**
 * 按主键删除一个版本（**只用于误录入的纠正**，不是"改标准"的正常路径）。
 *
 * ⚠ 纪律（沿用本仓既有铁律）：
 *   · 入参非法一律**抛错且一行不删**；
 *   · 单次删除有**上限**（默认 1 行）——"删一个版本"就只该删一行，防止参数口径错误时连删；
 *   · `dryRun` 只报数不删。
 * 正常"改标准"请用 `addVersion()` 追加新版本；删除会让引用该版本的历史判定失去依据。
 *
 * @param {object} db
 * @param {{id:number, maxDelete?:number, dryRun?:boolean}} options
 * @returns {{deleted:number, dryRun:boolean}}
 */
function deleteVersion(db, options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('standard.deleteVersion: 入参必须是对象');
  }
  const id = Number(options.id);
  if (!Number.isInteger(id) || id < 1) {
    throw new TypeError(`standard.deleteVersion: id 必须是 ≥ 1 的整数（收到 ${JSON.stringify(options.id)}）`);
  }
  const maxDelete = options.maxDelete === undefined ? 1 : Number(options.maxDelete);
  if (!Number.isInteger(maxDelete) || maxDelete < 1) {
    throw new TypeError(`standard.deleteVersion: maxDelete 必须是 ≥ 1 的整数（收到 ${JSON.stringify(options.maxDelete)}）`);
  }
  const dryRun = options.dryRun === true;
  const hit = db.prepare('SELECT COUNT(*) AS c FROM standard WHERE id = ?').get(id).c;
  if (hit === 0) return { deleted: 0, dryRun };
  if (hit > maxDelete) {
    throw new RangeError(
      `standard.deleteVersion: 本次将删除 ${hit} 行，超过上限 ${maxDelete}（id=${id}）—— 已中止，请核对入参`);
  }
  if (dryRun) return { deleted: hit, dryRun: true };
  const r = db.prepare('DELETE FROM standard WHERE id = ?').run(id);
  return { deleted: r.changes, dryRun: false };
}

/** 行 → 对象（库列名转小驼峰；数值列原样保留 null 表示"未设定"） */
function hydrate(row) {
  const out = {
    id: row.id,
    productCode: row.product_code,
    processCode: row.process_code,
    versionNo: row.version_no,
    effectiveFrom: row.effective_from,
    createdBy: row.created_by === undefined ? null : row.created_by,
    teamCode: row.team_code === undefined ? null : row.team_code,
    createdAt: row.created_at
  };
  for (const [key, col] of NUMERIC_COLUMNS) {
    out[key] = row[col] === undefined ? null : row[col];
  }
  return out;
}

module.exports = {
  TIME_RE,
  NUMERIC_ABS_LIMIT,
  VERSION_MAX,
  TEXT_MAX,
  assertTime,
  addVersion,
  getEffective,
  getLatest,
  listVersions,
  countVersions,
  count,
  deleteVersion
};
