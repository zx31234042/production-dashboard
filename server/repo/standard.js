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
   入库口校验（W4 / E16，负责人 2026-09-27 裁定⑥）：`addVersion` **默认强制**校验
        （半套标准 / 偏差正负号 / 超量程一律拒收，见下方 `DANGEROUS_VALIDATE_FALSE_FLAGS` 的说明）；
        唯一的跳过出口是显式的**危险开关**，返回值里如实回显 `validation`。
   用法：
     const repo = require('./repo/standard');
     const now = '2026-09-22 09:00:00';                     // 当前时刻（第 4 实参，必填；由调用方注入的时钟给出）
     const added = repo.addVersion(db, {
       productCode: 'P-1001', processCode: '30', createdBy: '张伟', teamCode: '检验一班',
       depthUpperDev: 0.30, depthLowerDev: -0.20, depthTypical: 5.00,    // 六值取自 board.config.js 的 standards.default
       speedUpperDev: 0.20, speedLowerDev: -0.20, speedTypical: 5.00    // 量程＝board.config.js 的 standards.range（深度 [4, 6] m／速度 [3, 8] m/s）：导出上/下限越界即抛 RangeError
     }, '2026-09-22 08:00:00', now);                       // 第 3 实参＝生效时间（可省，省＝now）；第 4 实参＝now
     repo.addVersion(db, {...}, undefined, now, { bus });   // 第 5 实参的 bus：新增成功后发布 `standard` 事件（W5-①）
     repo.getEffective(db, { productCode: 'P-1001', processCode: '30', at: '2026-09-22 09:00:00' });
     repo.listVersions(db, { productCode: 'P-1001', processCode: '30' });   // 版本历史
   注：生效时间只能走**第 3 个位置参数**；`input` 的键白名单＝productCode / processCode / createdBy /
         teamCode 与六个数值列（见 normalizeInput），**effectiveFrom 不在白名单** —— 写进 `input`
         会被**静默忽略**，不会报错，也不会生效。
   ========================================================================== */
'use strict';

/* 校验真源：**复用** `server/services/standard.js` 的 `assertInput`（半套 / 偏差正负号 / 超量程
   三项判据只有一份实现），不在这里另写一套。
   为什么仓储层要"向上"引用服务层：E16 的裁定就是**入库口强制校验** —— 校验必须发生在
   `INSERT` 之前，而 `addVersion` 正是那个入库口。若只在服务层校验，绕过服务层直调仓储
   （现场脚本/后续路由）仍能把半套标准写进库，等于判据形同虚设。
   ⚠ **必须延迟 require**（写在函数体内，不写文件顶部）：`services/standard.js` 在文件顶部
   `require` 了本模块（循环依赖）。若本模块在**加载期**就取服务层的导出，取决于先加载谁，
   `services/standard` 可能拿到本模块**尚未赋值**的 `module.exports`（`{}`），于是
   `repo.getEffective is not a function` —— 已实测：`node tests/db-check.js` 直接复现。
   延迟到**调用期**取，那时两个模块都已加载完成，引用必然完整。 */
function standardSvcOf() {
  return require('../services/standard');
}

/** W5-① 事件总线：**延迟 require**（理由同上：避免加载期循环依赖；只取一个纯常量表）。 */
function eventKindOf() {
  return require('../services/eventBus').KIND;
}

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

/** 校验模式词（`addVersion` 返回值里如实回显，供自检与调用方核对"这次到底校没校"） */
const VALIDATION = {
  /** 默认：完整校验（半套 / 偏差正负号 / 超量程），非法直接拒收 */
  CHECKED: 'ok',
  /** 受控跳过：仅在显式参数下出现（见 DANGEROUS_VALIDATE_FALSE_FLAGS） */
  SKIPPED: 'dangerous-skip'
};

/** 明确命名的"危险开关"：跳过校验。**故意起长名字**，避免被当成常规参数随手传。 */
const DANGEROUS_VALIDATE_FALSE_FLAGS = ['dangerouslySkipValidation', 'skipValidation'];

/** 校验开关归一：默认强制校验；只有显式"危险开关"才跳过。
 *  为什么还要接受 `false`/`0`/`'false'` 这类写法：它们语义等同于"关掉校验"，属同一类危险动作，
 *  一律**显式**归一为"跳过"（绝不静默当成默认值），并同样回显 `dangerous-skip`。 */
function validationModeOf(options) {
  if (!options || typeof options !== 'object') return VALIDATION.CHECKED;
  for (const flag of DANGEROUS_VALIDATE_FALSE_FLAGS) {
    if (options[flag] === true) return VALIDATION.SKIPPED;
  }
  const v = options.validate;
  if (v === false || v === 0 || v === 'false') return VALIDATION.SKIPPED;
  return VALIDATION.CHECKED;
}

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
 * **入库口强制校验（W4 落地技术债 E16；负责人 2026-09-27 裁定⑥）**：
 *   · **默认**在 `normalizeInput` 之后、`BEGIN` 之前调用 `services/standard.assertInput` ——
 *     半套标准（只有上偏差 / 缺下偏差 / 单指标半套）、偏差正负号非法（下限 > 上限、
 *     典型值不在上下限之间）、**超量程**（导出上/下限越出 `board.config.js` 的
 *     `standards.range[kind]`）一律**拒收**并给出可读原因；**一行不写**（校验早于事务）。
 *   · 确需跳过（**只用于回放当年录入的畸形旧数据**这类受控场景）只能走**显式危险开关**：
 *     `addVersion(db, input, effectiveFrom, now, { dangerouslySkipValidation: true })`
 *     —— 返回值里 `validation: 'dangerous-skip'` + `validationMessage` 如实回显，
 *     调用点必须自己再做断言/说明（见 `tests/db-check.js` 的受控出口断言）。
 *     传 `{ validate: false }` 语义相同，同样回显 `dangerous-skip`（不会静默变成默认值）。
 *
 * @param {object} db 数据库句柄
 * @param {object} input 见 normalizeInput：productCode / processCode / 六个数值 / createdBy / teamCode
 * @param {string} [effectiveFrom] 生效时间（'yyyy-MM-dd HH:mm:ss'）；缺省＝now
 * @param {string} now 当前时刻（'yyyy-MM-dd HH:mm:ss'，由调用方注入时钟给出）
 * @param {{dangerouslySkipValidation?:boolean, skipValidation?:boolean, validate?:boolean,
 *          bus?:object}} [options]
 *        第 5 个位置参数：**唯一**的校验跳过出口（默认不传＝强制校验）。
 *        `bus`（W5-①，可选）＝`services/eventBus.js` 的总线：新增成功后发布一条 `standard` 事件。
 *        它**不参与校验语义**（`validationModeOf()` 只认那两个危险开关）。
 * @returns {{id:number, productCode:string, processCode:string, versionNo:number, effectiveFrom:string,
 *            validation:'ok'|'dangerous-skip', validationMessage:string}}
 */
function addVersion(db, input, effectiveFrom, now, options) {
  const row = normalizeInput(input);
  const at = assertTime(now, 'now');
  const effective = effectiveFrom === undefined || effectiveFrom === null || effectiveFrom === ''
    ? at
    : assertTime(effectiveFrom, 'effectiveFrom');
  /* 入库口强制校验：**必须在 BEGIN 之前**（校验失败连事务都不该开） */
  const mode = validationModeOf(options);
  let validationMessage = '';
  if (mode === VALIDATION.SKIPPED) {
    validationMessage = '已按调用方显式要求**跳过**入库校验（半套/符号/量程三项均未校）—— ' +
      '只允许用于受控回放场景，调用方须自行断言（E16 受控出口）';
  } else {
    standardSvcOf().assertInput(row);
  }

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
    const added = {
      id: Number(r.lastInsertRowid),
      productCode: row.productCode,
      processCode: row.processCode,
      versionNo,
      effectiveFrom: effective,
      validation: mode,
      validationMessage
    };
    /* ---- W5-①：`standard` 事件挂在**新增版本真正提交之后**（COMMIT 之后）----
       为什么在这里：本函数是 `standard` 表的唯一写入口（追加式模型），"新版本生效"这件事
       只有这一处是真的。**被 `assertInput` 拒收的输入根本走不到这里**（校验早于 BEGIN），
       故"脏/半套标准不得发布 standard 事件"这条负向判据由**代码位置**保证，不由调用方自觉。
       走受控危险开关（`dangerouslySkipValidation`）写入的版本**也**发布：它确实新增了一行，
       payload 的 `validation` 如实标 `dangerous-skip`（不粉饰）。 */
    if (options && options.bus && typeof options.bus.publish === 'function') {
      options.bus.publish(eventKindOf().STANDARD, {
        id: added.id,
        productCode: added.productCode,
        processCode: added.processCode,
        versionNo: added.versionNo,
        effectiveFrom: added.effectiveFrom,
        createdBy: row.createdBy,
        teamCode: row.teamCode,
        validation: added.validation
      }, { at });
    }
    return added;
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
 *   · 选项键**白名单恰 `id` / `dryRun`**：多传任何键一律抛错并**指名该键**（不许静默忽略）；
 *   · `dryRun` 只报数不删。
 * 正常"改标准"请用 `addVersion()` 追加新版本；删除会让引用该版本的历史判定失去依据。
 *
 * **E17（2026-10-06，座位 3）**：本函数原有第三个可选参数 `maxDelete`（默认 1 行）"单次删除上限"，
 * 但它**永远不可能触发**：`id` 是主键（`schema.sql`：`id INTEGER PRIMARY KEY AUTOINCREMENT`）⇒
 * `SELECT COUNT(*) WHERE id = ?` 恒 ≤ 1，而 `maxDelete` 又被强制 ≥ 1 ⇒ `if (hit > maxDelete)`
 * 是**死分支**。死分支的害处不是"多几行代码"，而是**让人误以为有批量删除护栏**（实测 28 例全形态
 * 触发 0 次，物证见 `tests\._verify\T-20261006-09\`）。故**删掉该参数与其 `RangeError` 分支**
 * （按主键单删本就至多一行，不需要上限），并把它的入参形态**改为"未知选项键"拒收**：传了就抛错、
 * **指名键名**，不静默忽略 —— 静默忽略是同一个"虚假安全感"的另一副面孔。
 * 因此原先"**11 种非法入参抛错**"的口径**原样成立**，只是来源变了：
 *   · **6 种非法 `id`**（null/0/负数/小数/字符串/NaN）—— 仍按 `id` 校验抛 `TypeError`；
 *   · **5 种非法 `maxDelete`**（null/0/-1/1.5/'abc'）—— 现按**未知选项键**抛 `TypeError`。
 *
 * @param {object} db
 * @param {{id:number, dryRun?:boolean}} options **只接受 `id` 与 `dryRun`**；其他键（含已移除的 `maxDelete`）一律抛错
 * @returns {{deleted:number, dryRun:boolean}}
 * @throws {TypeError} `options` 非对象、含**未知选项键**（含已移除的 `maxDelete`）、或 `id` 不是 ≥ 1 的整数
 */
function deleteVersion(db, options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('standard.deleteVersion: 入参必须是对象');
  }
  /* 选项键白名单（E17）：允许集**恰** `{id, dryRun}` —— 即全仓普查到的**全部**真实用法
     （`{id}` / `{id, dryRun}`）。`maxDelete` 已随 E17 移除 ⇒ 多传的键一律**指名拒收**，
     不静默忽略（静默忽略＝"传了也不生效"，与死分支同族）。 */
  for (const key of Object.keys(options)) {
    if (key !== 'id' && key !== 'dryRun') {
      const why = key === 'maxDelete'
        ? '该参数已于 E17 移除：`id` 是主键 ⇒ 单删至多一行，"上限"分支永远不可达'
        : '本函数只接受 id 与 dryRun';
      throw new TypeError(
        `standard.deleteVersion: 不认识的选项 ${JSON.stringify(key)}（${why}；本函数只做按主键单删）`);
    }
  }
  const id = Number(options.id);
  if (!Number.isInteger(id) || id < 1) {
    throw new TypeError(`standard.deleteVersion: id 必须是 ≥ 1 的整数（收到 ${JSON.stringify(options.id)}）`);
  }
  const dryRun = options.dryRun === true;
  const hit = db.prepare('SELECT COUNT(*) AS c FROM standard WHERE id = ?').get(id).c;
  if (hit === 0) return { deleted: 0, dryRun };
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
  VALIDATION,
  DANGEROUS_VALIDATE_FALSE_FLAGS,
  assertTime,
  addVersion,
  getEffective,
  getLatest,
  listVersions,
  countVersions,
  count,
  deleteVersion
};
