/* ==========================================================================
   数据库连接与初始化（server/db/index.js）
   作用：打开本地 SQLite 库、执行建表脚本、写入结构版本与初始字典数据，
        并暴露备份/保留策略所需的最小能力。
   依据：DR-01～DR-19（需求清单 V1.32 第 7 章）、ADR-0001 D5（SQLite + WAL）、
        ADR-0002 D9/D10（Node 24 LTS、零 npm 依赖，使用内置 node:sqlite）。
   依赖：node:path、node:fs 与内置 node:sqlite。**不依赖任何第三方包**。
   用法：
     const { openDb, initSchema, flushWal, verifyIntegrity } = require('./db');
     // 路径由 platform/paths.js 给（业务代码不得出现盘符或平台字样，ADR-0002 D11）
     const handle = openDb(require('../../platform/paths').paths.dbFile);
     initSchema(handle.db);
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 当前表结构版本；**改动 schema.sql 时必须同步 +1**，供后续迁移判断
 *  2026-09-19 由 '1' 升到 '2'：`schema_meta` 新增 `schema_fingerprint` 键（P3 表外 code-12）。
 *  2026-09-20 由 '2' 升到 '3'（技术债 E10）：`upload_log` 增列 `fail_reason`、`updated_at`
 *    —— 该表兼作"上报失败待补传队列"的持久化载体（IF-B.9 / NFR-13），失败原因与最近变更时间
 *    是人工重报清单的必要字段。**升版是必须的**：schema.sql 正文一变，指纹即变，
 *    `verifySchemaConsistency()` 会以"指纹变了而结构版本没变"报错（本条约定的机器守护）。
 *  2026-09-22 由 '3' 升到 '4'（需求 V1.33 第二批 · 标准值录入与显示，草案第四节 DR-03/DR-12）：
 *    ① `standard` **重建**为「(产品,工序,版本) 追加式」—— 维度加工序号 `process_code`、加版本号
 *       `version_no`，阈值改为深度/速度的上下偏差与典型值（旧列的相机设定值 set_* 退出该表）；
 *       唯一键 `(product_code, process_code, version_no)`；旧库由本文件的 `migrateLegacyStandard()` 重建。
 *    ② `op_log` 增列 `team_code`（班组编号，来源＝当前生效班次，与 FR-1.6 同一真源，由
 *       `STRUCTURE_UPGRADES` 对旧库补列）。
 *    该表结构变化是**不兼容**的（旧列消失、新增唯一键），故必须升版；旧库升级路径见 schema.sql 注释。
 *  2026-09-28 由 '4' 升到 '5'（ADR-0007 D1 / D6.1，NFR-14 与 FR-8.4 的设置页口令表）：
 *    `schema.sql` 新增 `auth_credential`（口令**派生值**与失败计数/锁定状态；**永不存明文**）。
 *    该表是**纯新增**：`CREATE TABLE IF NOT EXISTS` 对旧库幂等生效，**不做重建迁移**；
 *    升版仍是必须的（ADR-0006 D2：schema.sql 正文一变指纹即变，`verifySchemaConsistency()`
 *    会以"指纹变了而结构版本没变"报错），且"旧库结构版本 ≠ 当前版本"正是 **E18 迁移前强制备份**
 *    的判据之一（见 `planMigration()`）。
 *  2026-09-30 由 '5' 升到 '6'（需求 **V1.41 / C-111**：`FR-4.x` 计量单位定义 ＋ `DR-04` 件序号补登；
 *    技术债 `E69`）：`measure_rt` **增列** `unit_index`（件序号 ＝ IF-D.4 的 `unitIndex`，
 *    采集落库时写入）。该列**允许 NULL**（帧未带/非法件序号 ⇒ NULL），故：
 *      ① **不需要任何数据回填** —— 既有行的 NULL 就是"这一帧没有件序号"的诚实表达
 *         （**绝不用 0/1 代言"拿不到"**，与本仓 `judge.js` 的"拿不到不说"同一纪律）；
 *      ② 旧库的补列走 `STRUCTURE_UPGRADES`（下一条）—— 理由与 `op_log.team_code` 逐字相同：
 *         `CREATE TABLE IF NOT EXISTS` 对旧表是**空操作**，SQLite 又写不出 `ADD COLUMN IF NOT EXISTS`。
 *    升版同样是必须的（正文一变指纹即变），且"库内版本 5 ≠ 当前 6"会命中 `planMigration()`
 *    ⇒ 旧库启动前**强制备份**（E18 不可跳过）。
 *  2026-10-05 由 '7' 升到 '8'（技术债 `E170`，实现 `E166` 的首选修法）：`measure_rt` 新增
 *    **索引** `ix_measure_rt_collect_time(collect_time)` —— 给"只按采集时刻取窗口"的那条查询
 *    （`stateSnapshot.js` 的 `statsForShift()`，`FR-4.11`／`FR-4.15` 两个 P0 的取数口）一个可服务的索引。
 *    **为什么这算结构变更、必须与迁移同批**（`E71`／`E74` 的教训，见下方 `STRUCTURE_UPGRADES` 那一条）：
 *    索引是**结构**（在 `sqlite_master` 里），不是代码行为 —— 只改 `schema.sql` 的话
 *    `CREATE INDEX IF NOT EXISTS` 对**已存在** `measure_rt` 的老库是**空操作**（与 `CREATE TABLE IF NOT EXISTS`
 *    同一个坑）：开发机新建库全绿，现场老库却**永远没有这个索引** ⇒ 那条查询在老库上仍是全表扫，
 *    而且**没有任何读数会红**（`verifySchemaConsistency()` 在结构已分化的库上照样返回 `ok:true`）。
 *    ⇒ 故本包**同一批**做完三件：①升版本（本行）；②`STRUCTURE_UPGRADES` 加幂等建索引步骤；
 *    ③`schema.sql` 的新建库路径加同一句索引。三处缺一不可。
 *    另：**本次不涉及任何列**（只建索引）⇒ `tests/db-check.js` 的 `LEGACY_BASELINE_COLUMNS` 维护纪律
 *    不受影响（那份基线只声明"列"，新索引不进基线、也不需要进）。 */
const SCHEMA_VERSION = '9';

/** 建表脚本位置（与本文件同目录） */
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

/**
 * 幂等升级步骤（**只增列/只建索引**，绝不删数据）：跑在 `schema.sql` 之后、同一个事务里。
 *
 * 为什么需要这一层：`schema.sql` 的 `CREATE TABLE IF NOT EXISTS` 只保证**新建库**结构正确；
 * 对**已存在旧表的库**它是空操作 —— 旧库缺的新列不会凭空出现。而这类"补一列"的动作
 * SQLite **写不出幂等 DDL**（已实测：`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 语法错误），
 * 故只能由读取 schema 的模块按同一份结构声明去补齐（两侧必须同步，见下方每条的出处注释）。
 *
 * 容错口径：这些步骤**只可能因"列/索引已存在"而失败**，此时吞掉该错误继续。其余错误照常抛出，
 * 由 `initSchema()` 回滚整个事务 —— 保证"要么整套结构到位，要么一行不动"。
 * 每条步骤都必须是**可重复执行且不破坏数据**的；带重建语义的迁移见 `migrateLegacyStandard()`。
 *
 * **形态白名单（E74，2026-10-01）**：本清单**只接受**两种形态 —— (a) `ALTER TABLE <表> ADD COLUMN <列> …`、
 * (b) `CREATE INDEX IF NOT EXISTS <索引> …`（`UNIQUE` 可选）；由 `assertUpgradeStepShape()` 在**执行每条
 * 之前**判定，不匹配即**当场抛错**，且**不被**下面那句 `duplicate column name` 的容忍 catch 吞掉。
 * 判据本体与"为什么"见紧接着的 `UPGRADE_STEP_FORMS` / `assertUpgradeStepShape()` docblock。
 */

/**
 * `STRUCTURE_UPGRADES` 步骤的**形态白名单** —— 唯一一份判据（纯函数：不建库、不碰数据库句柄、无副作用）。
 *
 * **白名单是什么**：只接受下面两种形态（大小写不敏感、允许多余空白、允许 `"x"` / `` `x` `` / `[x]` 三种标识符引号）
 *   (a) `ALTER TABLE <表> ADD COLUMN <列> …`
 *   (b) `CREATE INDEX IF NOT EXISTS <索引> …`（`UNIQUE` 可选）
 * 其余一律**当场抛错**（见 `assertUpgradeStepShape()`），由 `initSchema()` 回滚整个事务。
 *
 * **为什么（技术债 `E74`；判据由座位 5 在 `T-20260930-24` 的 C·12.6③ 提出、X1 实验实测）**：
 * 本清单在 `initSchema()` 里被**无条件逐条执行**，而单条步骤的失败**只**在
 * `duplicate column name|already exists` 时被吞 ⇒ "改列类型／删列"这类**不在白名单里**的变更会走出
 * 一条**静默三连**（X1 实测签名）：
 *   ① **静默空操作**：`ALTER TABLE … ALTER COLUMN …` 这类语句在 SQLite 下对**已存在**的表什么都不改，
 *      步骤却"执行成功"；`ALTER TABLE … RENAME TO …` 更糟 —— 它会**真改名**，且**照样不报错**；
 *   ② **结构分化**：新库与老库由此**静默不同**（X1 造出"缺 `fail_reason`"的库）；
 *   ③ **没有任何读数报警**：`verifySchemaConsistency()` 在**已经分化**的库上仍返回 `{"ok":true}`，
 *      直到**第一次真实写入**才抛 `table upload_log has no column named fail_reason`
 *      ⇒ "门禁绿、库却分叉"，与 `E71`／`E73` 同族（ADR-0004 D19："门禁绿"≠"结构已迁移"）。
 * 这条白名单把"静默空转"换成"**响亮失败**"：形态不对 ⇒ 连试都不试，错误信息直接带**步骤原文**与**正确出路**。
 *
 * **新形态要进来必须先扩白名单并配 D22**：白名单是**判据**、不是说明文档 —— 增加一种形态等于**改契约**，
 * 必须同批给出"按旧白名单跑**必红**"的定点变异证据（ADR-0004 D22），否则新形态会像 X1 那样被静默漏过。
 * **正确出路**：删列／改列类型／改约束请写**有名有姓的重建迁移函数**（先例 `migrateLegacyStandard()`：
 * 整表重建、自带判据与自检、可审计），并配 D22 靶子。
 */
const UPGRADE_STEP_FORMS = [
  {
    kind: 'add-column',
    what: 'ALTER TABLE <表> ADD COLUMN <列> …',
    re: /^ALTER\s+TABLE\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)/i
  },
  {
    kind: 'create-index',
    what: 'CREATE INDEX IF NOT EXISTS <索引> …（`UNIQUE` 可选）',
    re: /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)/i
  }
];

/**
 * 判定一条升级步骤属于哪种**允许形态**（纯函数，可对真值表逐条断言）。
 *
 * 判据刻意**只锚定前缀**、不锚定整句：列类型/DEFAULT/约束的合法写法太多，写全必然要么漏、要么把
 * 现有步骤拒之门外（后者正是"白名单写窄了"）。唯一额外的一条正文约束是"**单语句**"：
 * 允许一个结尾分号，但不允许语句体内再出现分号 —— 否则 `ALTER TABLE t ADD COLUMN a TEXT; DROP TABLE t`
 * 这种"合法前缀 ＋ 夹带"会整条通过，白名单当场形同虚设。
 *
 * @param {*} step 步骤原文（`STRUCTURE_UPGRADES` 的一项）
 * @returns {{ok:boolean, kind:'add-column'|'create-index'|'unsupported', form:string|null, reason:string}}
 *   命中时 `kind` 为形态名、`form` 为等价写法；未命中时 `ok=false` 且 `reason` 说明为什么。
 */
function classifyUpgradeStep(step) {
  if (typeof step !== 'string') {
    return { ok: false, kind: 'unsupported', form: null, reason: '步骤不是字符串' };
  }
  const text = step.trim();
  if (!text) return { ok: false, kind: 'unsupported', form: null, reason: '步骤是空串' };
  const body = text.replace(/;\s*$/, '');
  if (body.includes(';')) {
    return { ok: false, kind: 'unsupported', form: null, reason: '一条步骤里出现了多条语句（`;` 不止结尾那一个）' };
  }
  for (const form of UPGRADE_STEP_FORMS) {
    if (form.re.test(body)) return { ok: true, kind: form.kind, form: form.what, reason: '' };
  }
  return { ok: false, kind: 'unsupported', form: null, reason: '不匹配任何允许形态' };
}

/**
 * 断言一条升级步骤在白名单内；不在则**抛错**（错误信息**带违规步骤原文**与**正确出路**）。
 *
 * **调用位置有讲究**：调用点在 `initSchema()` 的步骤循环里、`db.exec(step)` **之前**，且刻意放在
 * 容忍 `duplicate column name|already exists` 的那个 `try` **之外** —— 形态违规**不得**被那张网吞掉。
 *
 * @param {*} step 步骤原文（`STRUCTURE_UPGRADES` 的一项）
 * @returns {{ok:true, kind:string, form:string, reason:string}} 通过时的分类结果（供调用方记录）
 * @throws {Error} 形态不在白名单内（消息含 `违规步骤原文：…`）
 */
function assertUpgradeStepShape(step) {
  const verdict = classifyUpgradeStep(step);
  if (verdict.ok) return verdict;
  throw new Error(
    `STRUCTURE_UPGRADES 步骤形态不被允许（E74）：${verdict.reason}。` +
    `只接受两种形态：${UPGRADE_STEP_FORMS.map(f => f.what).join(' ／ ')}。` +
    `违规步骤原文：${JSON.stringify(step)}。` +
    '删列/改列类型请写**有名有姓的重建迁移函数**（先例 migrateLegacyStandard()）并配 D22 靶子：' +
    '这两类变更在 SQLite 下对老库是**静默空操作**（改类型）或**静默真删/真改名**（DROP COLUMN／RENAME），' +
    '而 verifySchemaConsistency() 在已经分化的库上仍返回 ok:true —— 只有第一次真实写入才会炸。'
  );
}

const STRUCTURE_UPGRADES = [
  /* DR-12（V1.33）：op_log 增列 team_code（班组编号）。schema.sql 的新建表语句里已有该列，
     旧库（SCHEMA_VERSION '3'）需要这一步补上；重复执行时报 `duplicate column name` 被吞掉。 */
  'ALTER TABLE op_log ADD COLUMN team_code TEXT',
  /* 上面的列补齐后才能建这个索引（旧表补列前建会报 `no such column: team_code`）；
     `IF NOT EXISTS` 本身幂等。 */
  'CREATE INDEX IF NOT EXISTS ix_op_log_team ON op_log(team_code, op_time)',
  /* DR-04（V1.41 / C-111）：measure_rt 增列 unit_index（件序号，采集落库时写入）。
     旧库（SCHEMA_VERSION < '6'）需要这一步补上；`CREATE TABLE IF NOT EXISTS` 对旧表是空操作。
     ① 列**允许 NULL** ⇒ 既有行天然合法、**无需数据回填**（这里刻意不写成 NOT NULL + DEFAULT 1：
        "缺件序号"必须能与"真的是第 1 件"分开，用 DEFAULT 1 会把一票 N 件静默归并成一件）；
     ② 重复执行时报 `duplicate column name` 被下面的容错吞掉，天然幂等；
     ③ **不得**顺带改 `measure_rt` 的唯一索引 `ux_measure_rt`（DR-13 的幂等键列集固定为
        equip_code + proc_order_no + collect_time，与本题无关，动它等于换去重口径）。 */
  'ALTER TABLE measure_rt ADD COLUMN unit_index INTEGER',
  /* `DR-13`（V1.45 第 11 处，2026-10-19）：`measure_rt` 增列 `endpoint`（端点标识）并**进唯一键**。
     ① **列追加在表尾**（`schema.sql` 的 measure_rt 末尾）⇒ 前 13 列列序不变，`repo/measure.js` 的
        按位置绑定与 `logic-check` 的列序断言照旧；`repo/measure.js` 的 `toParams()` / `INSERT_SQL`
        把 `endpoint` 放在**末位**。
     ② **本步骤只补列**；**索引重建**（三列 → 四列）与**旧行回填**（`endpoint = equip_code`）由
        `migrateMeasureRtEndpoint()` 在 `initSchema()` 尾部完成（`STRUCTURE_UPGRADES` 只接受
        `ADD COLUMN` / `CREATE INDEX` 两种形态，见下方形态白名单）。
     ③ 列可空、重复执行报 `duplicate column name` 被容错吞掉 ⇒ 天然幂等；`schema.sql` 已同步该列 ⇒
        `SCHEMA_VERSION` 升 `'8' → '9'`。 */
  'ALTER TABLE measure_rt ADD COLUMN endpoint TEXT',
  /* `E28`（2026-10-07，负责人原文："`E28` 按建议 —— `measure_rt` 增 `cameraDepth` 列，与
     `depth` 严格区分；同批走迁移清单与 `db-check`"）：`measure_rt` 增列 `camera_depth`
     （**相机自身水下深度** `cameraDepth`），与 `measure_depth`（**航行器水下深度** `depth`）
     **语义不同**（`IF-C.9` P0："`depth` 与 `cameraDepth` 语义不同、显示与上报均须严格区分"）
     ⇒ **两列各写各的：不得合并、不得互相回填**（回填＝把两个物理量混成一个，显示与上报都会失真）。
     ① **列名/类型以 `schema.sql` 的 DR-04 段为唯一正本**（`camera_depth REAL`，可空）；
        与落库口 `repo/measure.js` 的 `toParams()` / `INSERT_SQL`、读口
        `services/uploadReporter.js`（附录 2 的 `cameraDepth`）三处逐列同名同序。
     ② **本步骤是"老库拿到该列"的唯一交付路径**：`schema.sql` 的 `CREATE TABLE IF NOT EXISTS`
        对**已存在**的旧表是**空操作**（`E71` / `E73` / `E170` 同一形态）⇒ 只改 `schema.sql`
        的话，新建库全绿、而结构分化的老库**没有任何门禁会红**，直到第一次真实写入才炸
        （`table measure_rt has no column named camera_depth` ⇒ 采集链**每一帧都失败**，
        不是"少记一个相机深度"这种可容忍的降级）。
     ③ 列**可空** ⇒ 既有行天然合法、**无需数据回填**（一行都不 UPDATE）；"拿不到相机深度"与
        "相机深度真的是 0"必须分得开 ⇒ **不写** `NOT NULL`、**不放** `DEFAULT`（与
        `unit_index` 的同族理由）。
     ④ 重复执行时报 `duplicate column name`，被下面的容错吞掉 —— **天然幂等**。
     ⑤ **本包不改 `schema.sql`**（该列自首个 `schema.sql` 起就在）⇒ 按 9.5 第 6 条
        **不升** `SCHEMA_VERSION`：指纹由 `schema.sql` 正文算出、正文未动（先例＝`E73`）。
     ⑥ ⚠ **配套的 `db-check` 口径必须同批跟上**（判据在 `tests/db-check.js` 里，归座位 4b）：
        该列当前躺在 `LEGACY_BASELINE_COLUMNS.measure_rt`（＝"老库一定有"）里，而"六之九/静态/
        口径一致"明写**带 `ADD COLUMN` 步骤的列不得同时写在老库基线里** ⇒ 本步骤落地后，须
        **同批**把 `camera_depth` 从那条基线里**移出**（不是删步骤）。理由：两处说法相反时，
        要么步骤是死步骤、要么基线过宽而对该列**失明**；负责人的原话"同批走迁移清单与
        `db-check`"指的正是这一对动作（读数与 4b 清单见本轮回执）。 */
  'ALTER TABLE measure_rt ADD COLUMN camera_depth REAL',
  /* E73（**历史遗漏的补齐**，规范 v1.35 · 9.5 第 6 条增补③）：`upload_log` 的 `fail_reason` 与
     `updated_at` 是 2026-09-21（`349feba`）给**已存在**的表加的两列 —— 当时既没有 `STRUCTURE_UPGRADES`
     这一层，也没有任何 `ALTER TABLE` 补列动作（当时的自述是"运行时不再有 `ALTER TABLE` 补列，
     由结构版本判据**显式迁移或重建**"，但那半句"显式迁移"**从未落地**），于是：
       · 新建库由下方 `schema.sql` 的 `CREATE TABLE` 天然带这两列；
       · **V2 老库**（`schema_version='2'`）升级时 `CREATE TABLE IF NOT EXISTS` 是**空操作**，
         两列永远不会出现 —— 而 `repo/uploadQueue.js` 的 `enqueueFailed()` 的 INSERT 显式引用它们
         ⇒ 实测抛 `table upload_log has no column named fail_reason`（升级却报"成功"：版本 6、指纹一致、
         `verifySchemaConsistency()` 返回 `ok:true`，见 `tests\._verify\zz6d-e73-probe.js`）。
     ① 列名/类型以 `schema.sql` 的 `upload_log` 段为**正本**（`:246-247`）：`fail_reason TEXT`、
        `updated_at TEXT`，本处顺序与那两列的相邻关系一致；
     ② 两列**可空**（`schema.sql` 就是可空）⇒ 既有行天然合法、**无需数据回填**，
        "老库既有行"的两个新列诚实地是 NULL；
     ③ 重复执行时报 `duplicate column name`，被下面的容错吞掉 —— 天然幂等；
     ④ **本包不改 `schema.sql`**，故按 9.5 第 6 条**不升** `SCHEMA_VERSION`：指纹由 `schema.sql` 正文算出，
        正文没动 ⇒ 指纹不变 ⇒ `verifySchemaConsistency()` 的"正文变了却没升版"判据不受影响；
        而 `initSchema()` 是**无条件**逐条执行本清单的（见其注释与实现），所以"老库补列"这件事
        不依赖版本号变化也能落地。 */
  'ALTER TABLE upload_log ADD COLUMN fail_reason TEXT',
  'ALTER TABLE upload_log ADD COLUMN updated_at TEXT',
  /* `E83`（2026-10-04，跨零点口径的两个投影）：`shift_stat` 增列 `run_sec_day1`/`run_sec_day2`
     —— **自然日投影**（FR-6.4／6.5／6.6 的"当日/本月/年度累计运行"按**自然日**零点切段）。
     旧库（SCHEMA_VERSION < '7'）需要这两步补上；`CREATE TABLE IF NOT EXISTS` 对旧表是空操作。
     ① 两列**可空**（`schema.sql` 就是可空）⇒ 既有行天然合法、**无需数据回填**：
        NULL 的读法只有一条 —— **"本行按旧口径写入、未做自然日切段"** ⇒ 读口
        （`repo/shiftStat.js` 的 `runDaysOf()`）按"整段归班次开始日"兜底，与 `E83` 之前的读数逐字相同。
        **刻意不用 DEFAULT 0 回填**：0 只能表达"这一段确实是 0 秒"，而老行的真相是"我们没算过"
        —— 用 0 顶替就是把"拿不到"写成"量到了"（技术债 `E38` 的既有口径），而 `run_sec_day2 = 0`
        与 `run_sec_day2 IS NULL` 在"跨零点班次有没有被切段"上是**两个相反的事实**。
     ② 恒等式 `run_sec_day1 + run_sec_day2 = run_sec` 由**写入口**（`repo/shiftStat.js` 的
        `upsertFrozen()`）校验后落库 —— 不在库里加 CHECK 约束（那属"改约束"，在 SQLite 下对老库
        是静默空操作，见 `E74` 的白名单口径），故恒等式由代码侧拒收保证；
     ③ 重复执行时报 `duplicate column name`，被下面的容错吞掉 —— 天然幂等；
     ④ **本包改了 `schema.sql`** ⇒ 按 9.5 第 6 条**同批升版**（上面 `SCHEMA_VERSION` 6 → 7）
        ＋ 同批同步 `tests/db-check.js` 的 `REQUIRED_COLUMNS`（需求锚，新列**不进**
        `LEGACY_BASELINE_COLUMNS`）；本文件只负责①升版与②补列两步，③归测试侧（座位 4b）。 */
  'ALTER TABLE shift_stat ADD COLUMN run_sec_day1 INTEGER',
  'ALTER TABLE shift_stat ADD COLUMN run_sec_day2 INTEGER',
  /* `E170`（2026-10-05，实现 `E166` 的首选修法；`E129` 的取数改动的配套结构变更）：
     `measure_rt` 增**索引** `ix_measure_rt_collect_time(collect_time)`。
     **为什么必须有这一步（而不是只改 `schema.sql`）**：`schema.sql` 的 `CREATE INDEX IF NOT EXISTS`
     对**已存在** `measure_rt` 的老库是**空操作**（与 `CREATE TABLE IF NOT EXISTS` 对老表空操作同一个坑），
     老库不会凭空长出这个索引 —— 于是"开发机新建库全绿、现场老库那条查询仍全表扫"，且**没有任何门禁会红**
     （`E71`／`E74` 立下的形态：结构分化在 `verifySchemaConsistency()` 眼里仍是 `ok:true`，
     直到第一次真实写入/第一次真实变慢才暴露）。故本步骤是"老库拿到该索引"的**唯一**交付路径。
     **为什么需要这个索引**（读数出处：座位 5 在 `T-20261005-10` 的 `C·25.6`，以及本包的 `q1` 探针）：
     `statsForShift()` 的窗口取数（`measure_rt` 上只按 `collect_time` 取半开区间）在**无可用索引**时
     `EXPLAIN QUERY PLAN` ＝ `SCAN measure_rt`（全表扫）—— 表上原有两个索引
     `ux_measure_rt(equip_code, proc_order_no, collect_time)` 与
     `ix_measure_rt_task_time(proc_order_no, collect_time)` 的**首列都不是 `collect_time`**
     ⇒ **服务不了**"只按 `collect_time` 取范围"的查询（"有索引"与"服务得了这条查询"是两件事）。
     `E129` 把该查询从 `LIMIT 1000`（靠早停，成本不随表增长）改成按时间范围取全量之后，
     这一步的代价变成 O(表行数)：实测 1/30/100 天 ＝ 10.8/77.8/239.0 ms，且随保留期（365 天）线性增长
     ⇒ 加索引是唯一**对症**的修法（`COUNT(*)`＋`MIN/MAX` 同样躲不掉扫描）。
     ① 形态在白名单内（`CREATE INDEX IF NOT EXISTS`，`E74` 的形态判据当场认它）；
     ② `IF NOT EXISTS` **天然幂等**：重复执行（含"已是版本 8 的库再启动一次"）是空操作，
        而"索引已存在"这类报错也已被下面那句容错吞掉；
     ③ **不得**顺带动 `ux_measure_rt` 的去重键列集（DR-13 幂等键固定为
        equip_code + proc_order_no + collect_time，动它等于换去重口径）——
        本步骤只**新增**一个索引，不删不改任何既有索引；
     ④ 索引**不含**任何"新增列"语义 ⇒ `tests/db-check.js` 的 `LEGACY_BASELINE_COLUMNS`（列基线）
        与本步骤无关：那条"正方向"判据只对**列**要求 `ADD COLUMN` 步骤，索引由
        `classifyUpgradeStep()` 单独归类（`create-index`），两处口径不冲突。 */
  'CREATE INDEX IF NOT EXISTS ix_measure_rt_collect_time ON measure_rt(collect_time)'
];

/**
 * `standard` 旧结构判据 —— **唯一一份**（`migrateLegacyStandard()` 与 `planMigration()` 共用）。
 *
 * 为什么要抽出来：E18 要求"**只有**本次初始化确实会做破坏性迁移时才预先备份"。若判据在这里写一份、
 * 在那边再写一份，两边迟早漂移 —— 漂移的后果是"备份没做却真迁移了"（数据不可恢复）或
 * "没迁移却天天备份"（幂等性破功）。故判据只此一处，两个调用方共用。
 *
 * @param {object} db 数据库句柄
 * @returns {{state:'absent'|'current'|'legacy'|'unknown', tableExists:boolean, cols:string[], reason:string}}
 *   `absent`  = 表还不存在（新建库，无需迁移）
 *   `current` = 已是新结构（含 version_no/process_code）
 *   `legacy`  = V1.33 之前的旧结构（会被重建，**判据成立即需要迁移前备份**）
 *   `unknown` = 读不到 sqlite_master（库有问题，迁移与备份都要显式中止）
 */
function legacyStandardState(db) {
  let tableExists = false;
  try {
    tableExists = Boolean(db.prepare(
      "SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'standard'"
    ).get());
  } catch (err) {
    return { state: 'unknown', tableExists: false, cols: [], reason: `无法读取 sqlite_master：${err.message}` };
  }
  if (!tableExists) {
    return { state: 'absent', tableExists: false, cols: [], reason: 'standard 表尚不存在（新建库，无需迁移）' };
  }
  /* 结构判据：`pragma_table_info` 里有没有新列 `version_no`（以及 `process_code`）。
     为什么不用 `CREATE TEMP VIEW ... SELECT version_no` 探针：**SQLite 建视图时并不校验列**，
     要等真正 SELECT 才报 `no such column`（已实测），拿它当判据会误判成"已是新结构"。 */
  const cols = db.prepare("SELECT name FROM pragma_table_info('standard')").all().map(r => r.name);
  if (cols.includes('version_no') && cols.includes('process_code')) {
    return { state: 'current', tableExists: true, cols, reason: 'standard 已是新结构（含 version_no/process_code）' };
  }
  return {
    state: 'legacy', tableExists: true, cols,
    reason: `standard 是旧结构（缺 ${['version_no', 'process_code'].filter(c => !cols.includes(c)).join('/')}）`
  };
}

/**
 * DR-03 旧结构迁移：把 V1.33 之前的 `standard` 表**重建**为「(产品,工序,版本) 追加式」。
 *
 * 为什么需要显式判据（而不是写在 schema.sql 里）：SQLite 写不出"条件 DDL" ——
 * `ALTER TABLE ... RENAME` 没有 `IF EXISTS`；`RAISE()` 只能出现在触发器体内；
 * 临时触发器守卫需要内层事务，与外层事务冲突（三条路本次均已实测，结论写在 schema.sql 的注释里）。
 * 早先版本把重建语句直接写进 schema.sql 按"每次执行"跑，实测后果是**每次 initSchema 都把真实
 * 版本行替换成占位行**（追加式模型下等于静默毁数据）—— 故改为在这里按**结构判据**显式执行。
 *
 * 判据：`standard` 表存在、且**没有**新列 `version_no`/`process_code`
 *  ⇒ 判定为 V1.33 之前的旧结构，执行重建。重建后判据不再成立 ⇒ **天然幂等**。
 *
 * 数据去向：旧行只有相机设定值（set_depth/set_gain/set_frame_rate/set_shutter），**不携带任何
 * 偏差/典型值**，新模型没有可承载的语义，故按 product_code 归并成一版占位行
 * （version_no 从 1 起、process_code=''、created_by='结构迁移'、偏差与典型值留 NULL
 * ⇒ 在服务层走"必要项缺失 ⇒ 占位"路径）。**不把设定值伪装成标准值**。
 *
 * ⚠ E18：本函数会 `DROP TABLE standard_legacy` / `ALTER TABLE standard RENAME`（**破坏性**），
 * 故 `initSchema()` 在调用它**之前**先做一次强制备份（不可跳过、失败即中止），见 `planMigration()`。
 *
 * @param {object} db 已打开且在事务中的数据库句柄
 * @returns {{migrated:boolean, reason:string, rows:number}} 迁移结果（可审计）
 */
function migrateLegacyStandard(db) {
  const st = legacyStandardState(db);
  if (st.state === 'unknown' || st.state === 'absent' || st.state === 'current') {
    return { migrated: false, reason: st.reason, rows: 0 };
  }

  /* 旧结构：重建。整段沿用 schema.sql 里的新建结构（列定义两边必须一致）。 */
  db.exec('DROP TABLE IF EXISTS standard_legacy');
  db.exec('ALTER TABLE standard RENAME TO standard_legacy');
  db.exec(`CREATE TABLE IF NOT EXISTS standard (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code      TEXT NOT NULL,
    process_code      TEXT NOT NULL DEFAULT '',
    version_no        INTEGER NOT NULL,
    depth_upper_dev   REAL,
    depth_lower_dev   REAL,
    depth_typical     REAL,
    speed_upper_dev   REAL,
    speed_lower_dev   REAL,
    speed_typical     REAL,
    effective_from    TEXT NOT NULL,
    created_by        TEXT,
    team_code         TEXT,
    created_at        TEXT NOT NULL,
    UNIQUE(product_code, process_code, version_no)
  )`);
  const ins = db.prepare(
    `INSERT INTO standard(product_code, process_code, version_no, effective_from, created_by, created_at)
       SELECT l.product_code, '', ROW_NUMBER() OVER (PARTITION BY l.product_code ORDER BY l.effective_from ASC, l.id ASC),
              l.effective_from, '结构迁移', l.created_at
         FROM standard_legacy l
        WHERE NOT EXISTS (SELECT 1 FROM standard s WHERE s.product_code = l.product_code)`
  ).run();
  const before = db.prepare('SELECT COUNT(DISTINCT product_code) AS c FROM standard_legacy').get().c;
  const after = db.prepare('SELECT COUNT(*) AS c FROM standard').get().c;
  /* 迁完先自检：**旧库里每个产品号都必须在新表中有一版占位行**（本次是"按产品号归并"，
     行数本就不等 —— 旧库同一产品可能有多行设定值，故比对的是**产品号集合**而不是行数）。
     不成立说明没搬全，直接抛错让 initSchema 整体回滚，绝不带着半份数据继续（`standard_legacy`
     此时还在库里，数据不会丢）。 */
  const missing = db.prepare(
    `SELECT COUNT(*) AS c FROM (
       SELECT DISTINCT product_code FROM standard_legacy
        WHERE product_code NOT IN (SELECT product_code FROM standard))`
  ).get().c;
  if (Number(missing) > 0) {
    throw new Error(
      `standard 旧结构迁移不完整：旧库有 ${missing} 个产品号没有对应的新版本行 —— 已回滚（旧表仍为 standard），请人工处理`);
  }
  db.exec('DROP TABLE IF EXISTS standard_legacy');
  db.exec('CREATE INDEX IF NOT EXISTS ix_standard_pair ON standard(product_code, process_code, effective_from DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_standard_product ON standard(product_code, effective_from)');
  return { migrated: true, reason: `旧结构重建完成（${before} 个产品号 → ${after} 版占位行）`, rows: Number(ins.changes) };
}

/* ==========================================================================
   E18（技术债）：**迁移前强制备份** —— 不可跳过、失败即中止、可审计
   --------------------------------------------------------------------------
   立案原文（`项目记录\后续路线图.md` 第六节）：旧库迁移即 `DROP TABLE standard_legacy`，
   旧设定值不可恢复 ⇒ 迁移前必须强制备份 + 可审计日志。
   本段的**唯一入口**是 `initSchema()`：它先算 `planMigration()`，只有"本次确实会做破坏性迁移/
   结构变更"时才备份（幂等：无迁移的第二次 initSchema **不产生**第二份备份）。
   备份本体**复用 `server/db/maintain.js`**（本仓唯一的备份实现），不另起第二套。
   ========================================================================== */

/** 迁移前备份的留痕口径（`op_log.op_type`）：成功/失败都用它，`result` 区分；content 含路径与原因 */
const PRE_MIGRATION_BACKUP_OP_TYPE = '迁移前备份';

/** 备份留痕正文上限（`repo/opLog.js` 的 CONTENT_MAX ＝ 500；这里留一点余量避免边界抛错） */
const BACKUP_LOG_CONTENT_MAX = 480;

/** 取当前连接对应的**库文件路径**（`node:sqlite` 的 `location()`；内存库返回 null） */
function dbFilePath(db) {
  try {
    if (db && typeof db.location === 'function') {
      const loc = db.location();
      return typeof loc === 'string' && loc && loc !== ':memory:' ? loc : null;
    }
  } catch { /* 取不到就按"无文件路径"处理，由调用方决定是否中止 */ }
  return null;
}

/**
 * 迁移前备份的**默认目录**：与被迁移的库**同目录树**下的 `backup/`。
 * 为什么这样推而不写死盘符：ADR-0002 D11 禁止业务代码出现硬编码路径；而生产布局下
 * `platform/paths.js` 的 `dbFile = <dataRoot>/board.db`、`backupDir = <dataRoot>/backup`，
 * 本式结果与它**逐字相同**；自检用临时库时则自然落在临时目录里（不污染真实数据目录）。
 * @param {string} dbPath 库文件路径
 */
function defaultBackupDir(dbPath) {
  return path.join(path.dirname(path.resolve(dbPath)), 'backup');
}

/**
 * **迁移计划**（E18 的判据）：本次 `initSchema()` 会不会做破坏性迁移 / 结构变更？
 *
 * 任一成立 ⇒ 需要迁移前备份（**不可跳过**）：
 *  ① `standard` 旧结构判据成立（`migrateLegacyStandard()` 会 DROP 旧表，属破坏性）；
 *  ② 库内结构版本 ≠ 当前 `SCHEMA_VERSION`（旧库升级会改结构：补列/建索引/新表）；
 *  ③ 库里有业务表但**没有**结构版本记录（结构未知，按"可能要动结构"处理）。
 * 反面（**必须为空才不备份**）：空库（一行业务表都没有）不需要备份 —— 没有可丢的数据，
 * 且"新建库"每次首次启动都会走到这里，若也备份，就把"每次启动都产出一份备份"写进了默认路径。
 *
 * @param {object} db
 * @returns {{needed:boolean, reasons:string[], reason:string, storedVersion:string|null,
 *            schemaVersion:string, businessTables:number, legacyStandard:string}}
 */
function planMigration(db) {
  const reasons = [];
  const st = legacyStandardState(db);
  if (st.state === 'unknown') {
    /* 读不到结构就不敢说"不需要备份"：按需要处理（预检本身就是中止信号，见 initSchema） */
    return {
      needed: true, reasons: [st.reason], reason: st.reason,
      storedVersion: null, schemaVersion: SCHEMA_VERSION, businessTables: -1, legacyStandard: st.state
    };
  }
  const businessTables = listTables(db).filter(t => t !== 'schema_meta').length;
  const storedVersion = getSchemaVersion(db);
  if (st.state === 'legacy') reasons.push(`${st.reason} ⇒ 需重建 standard（会 DROP 旧表）`);
  if (storedVersion !== null && storedVersion !== SCHEMA_VERSION) {
    reasons.push(`结构版本升级 ${storedVersion} → ${SCHEMA_VERSION}`);
  }
  if (storedVersion === null && businessTables > 0) {
    reasons.push(`库内有 ${businessTables} 张业务表但没有结构版本记录（结构未知）`);
  }
  return {
    needed: reasons.length > 0,
    reasons,
    reason: reasons.length ? reasons.join('；') : '无破坏性迁移/结构变更（不需要迁移前备份）',
    storedVersion, schemaVersion: SCHEMA_VERSION, businessTables, legacyStandard: st.state
  };
}

/** 真实时钟的兜底出口（ADR-0003 D17）：**本文件只此一处**，且刻意写成**单参默认值**形态 ——
 *  这是 `tests\docs-cross-check.js` 的 D17 门禁认的"注入出口"形态之一（`return new Date();` 会被判裸取时间）。 */
function realNow(d = new Date()) { return d; }

/** 备份时刻候选：`options.now` → 本次初始化的 `now` 文本（DR-16）→ 真实时钟。
 *  注入时钟优先是自检可重复的前提（ADR-0003 D17）—— 备份文件名里的毫秒段同样要能被钉死。 */
function resolveBackupWhen(options = {}, nowText) {
  for (const cand of [options.now, nowText]) {
    if (cand === undefined || cand === null || cand === '') continue;
    const d = cand instanceof Date ? new Date(cand.getTime()) : new Date(cand);
    if (Number.isFinite(d.getTime())) return d;
  }
  return realNow();
}

/** 写一条迁移前备份的留痕（`op_log`）；**审计失败不掩盖**原始错误，如实返回 {ok,error}。
 *
 *  ⚠ 为什么这里有一小段"兼容插入"：迁移前备份发生在 `schema.sql` 与 `STRUCTURE_UPGRADES`
 *  **之前**，而 **V1.33 之前的旧库 `op_log` 还没有 `team_code` 列** —— 仓储层
 *  `repo/opLog.append()` 的 INSERT 含该列，会报 `table op_log has no column named team_code`。
 *  偏偏"旧库迁移"正是最需要这条留痕的场合，所以只在**这一种**错误上降级为"按迁移前的列集写同一行"
 *  （`team_code` 留给补列后为 NULL，语义与 `repo/opLog.js` 的"不猜班组"一致）；
 *  其它错误一律如实回报 `{ok:false, error}`，**不静默**。 */
function appendBackupLog(db, entry, at) {
  const content = String(entry.content).slice(0, BACKUP_LOG_CONTENT_MAX);
  const payload = {
    opTime: at, operator: '系统', opType: PRE_MIGRATION_BACKUP_OP_TYPE,
    content, result: entry.result,
    teamCode: null      // 与 opLog 同口径：班组来源是"当前生效班次"，这里没有班次上下文 ⇒ **不猜**
  };
  try {
    const opLogRepo = require('../repo/opLog');
    const r = opLogRepo.append(db, payload, at);
    return { ok: true, id: r.id, error: '', compat: false };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (!/no column named team_code/i.test(message)) return { ok: false, id: null, error: message, compat: false };
    try {
      const r = db.prepare(
        'INSERT INTO op_log(op_time, operator, op_type, content, result, created_at) VALUES(?, ?, ?, ?, ?, ?)'
      ).run(at, payload.operator, payload.opType, payload.content, payload.result, at);
      return { ok: true, id: Number(r.lastInsertRowid), error: '', compat: true };
    } catch (err2) {
      return { ok: false, id: null, error: err2 && err2.message ? err2.message : String(err2), compat: true };
    }
  }
}

/**
 * 执行迁移前**强制**备份：**不可跳过**、失败即抛错（调用方 `initSchema()` 据此中止迁移，
 * **业务数据一行不动** —— 若库内已有 `op_log` 表，本函数会**追加 1 条** E18 失败留痕，
 * 见 `tests\db-check.js` 九之②b/②c 的逐列快照断言）。
 * 成功/失败都会写 `op_log`（含备份文件路径、原因、结果）。
 *
 * **F17-3（复核低危，已修）**：`op_log` 表可能**不存在**（极旧的库还没建该表）⇒ 审计写入必然失败。
 * 旧写法把 `audit.ok===false` 静默吞掉（迁移照做、备份 1 份、0 行留痕、无任何日志出口）。
 * 现在：审计失败时 ①经 `options.logger.warn`（缺省 `console.warn`）**显式告警**；
 * ②返回值/抛出对象的 `.backup` 带 `auditDegraded:true`（调用方据此可断言/再告警）。
 *
 * @param {object} db
 * @param {object} plan `planMigration()` 的产物
 * @param {object} options `{backupDir?, backup?, now?, logger?}` —— `backup` 是**同步**备份函数注入出口
 *        （自检用它制造"备份失败"，见 `tests\db-check.js` 第九章②）；`logger` 仅用于 F17-3 的告警出口
 * @param {Date} when 备份时刻
 * @returns {{needed:true, ok:true, path:string, name:string, dir:string, bytes:number,
 *            engine:string|null, reason:string, at:string, audit:object, auditDegraded:boolean}}
 */
function runPreMigrationBackup(db, plan, options, when) {
  const at = formatNow(when);
  const reason = plan.reason;
  /** F17-3 的告警出口：有 logger 就走 logger.warn，否则 console.warn（**绝不静默**） */
  const warn = message => {
    if (options.logger && typeof options.logger.warn === 'function') options.logger.warn(message);
    else console.warn(message);
  };
  /**
   * 统一收口：审计失败 ⇒ 告警 + `auditDegraded` 标记（返回值与抛出对象都带）。
   *
   * ⚠ **口径已由主代理裁定（2026-09-28，F17-3）：审计失败时"告警 + 标记 + 迁移照常"，不得改回"中止迁移"。**
   * 裁定理由（照抄，免得后人再翻）：E18 的硬要求是"**破坏性迁移前必须备份**"；极旧库（连 `op_log`
   * 表都没有）场景里**备份本身是成功的**，失败的只是"审计行写不进去"。若为此中止，那条库将**永远无法迁移**
   * （死锁），代价远大于收益。故正确形态＝显式告警出口（本函数）＋ `auditDegraded:true` ＋ 迁移照常，
   * 且告警**只打一条、可被判据观察到**（`tests\db-check.js` 的 `E18/F17-3` 断言注入 logger 数告警条数）。
   * 要改成"中止"，须先改 ADR/E18 收口口径，不得在实现里单方面收紧。
   */
  const auditOrWarn = payload => {
    const audit = appendBackupLog(db, payload, at);
    if (!audit.ok) {
      warn(`[⚠ E18 迁移前备份] 审计留痕写入失败（备份本身${payload.result === '成功' ? '已产出' : '未产出'}，` +
        `但 op_log 里查不到 ⇒ 可审计性降级）：${audit.error}｜备份文件=${payload.content}`);
    }
    return audit;
  };
  /* 备份目录：显式注入优先；否则取"库文件同目录树下的 backup/"。
     取不到库文件路径（内存库）时**宁可直接抛错**也不落到 cwd（那会把备份写进仓库工作目录）——
     迁移前备份不可跳过，内存库要重建旧结构就只能显式给 backupDir。 */
  let dir;
  try {
    if (options.backupDir) {
      dir = path.resolve(String(options.backupDir));
    } else {
      const file = dbFilePath(db);
      if (!file) throw new Error('无法确定库文件路径（内存库？）—— 迁移前备份不可跳过，请显式注入 backupDir');
      dir = defaultBackupDir(file);
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const audit = auditOrWarn({
      result: '失败',
      content: `迁移前备份（E18）｜结果=失败｜目录=（未确定）｜原因=${reason}｜错误=${message}`
    });
    const e = new Error(`迁移前强制备份失败（E18）：已**中止**本次初始化，业务数据一行不动` +
      `（仅追加 1 条 E18 失败留痕）—— ${message}`);
    e.code = 'PRE_MIGRATION_BACKUP_FAILED';
    e.backup = { dir: null, reason, at, error: message, audit, auditDegraded: !audit.ok };
    throw e;
  }

  const backupFn = typeof options.backup === 'function'
    ? options.backup
    /* 备份实现**只有一份**（server/db/maintain.js）；这里用它的**同步**形态 ——
       理由（同步调用点 + 异步 backup API 的冲突）见 maintain.js 的 `backupToSync()` 注释。 */
    : require('./maintain').backupToSync;

  let result;
  try {
    result = backupFn(db, dir, { now: when, reason });
    if (result && typeof result.then === 'function') {
      throw new TypeError('迁移前备份**必须同步**（initSchema 是同步调用点）：注入的备份函数返回了 Promise');
    }
    if (!result || !result.path) throw new Error('备份函数没有返回落盘路径（无法审计 ⇒ 按失败处理）');
    if (!fs.existsSync(result.path)) throw new Error(`备份函数报告成功但文件不存在：${result.path}`);
    const bytes = fs.statSync(result.path).size;
    if (!(bytes > 0)) throw new Error(`备份文件为空（0 字节）：${result.path}`);
    result.bytes = bytes;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const audit = auditOrWarn({
      result: '失败',
      content: `迁移前备份（E18）｜结果=失败｜目录=${dir}｜原因=${reason}｜错误=${message}`
    });
    const e = new Error(`迁移前强制备份失败（E18）：已**中止**本次初始化，业务数据一行不动` +
      `（仅追加 1 条 E18 失败留痕）—— ${message}`);
    e.code = 'PRE_MIGRATION_BACKUP_FAILED';
    e.backup = { dir, reason, at, error: message, audit, auditDegraded: !audit.ok };
    throw e;
  }

  const audit = auditOrWarn({
    result: '成功',
    content: `迁移前备份（E18）｜结果=成功｜备份文件=${result.path}｜体积=${result.bytes} 字节｜原因=${reason}`
  });
  const out = {
    needed: true, ok: true, path: result.path, name: result.name || path.basename(result.path),
    dir, bytes: result.bytes, engine: result.engine || 'backup-api', reason, at, audit,
    /** F17-3：审计写入降级标记（`true`＝备份成功但 `op_log` 里查不到，已同时告警） */
    auditDegraded: !audit.ok,
    /** F19-5：迁移后**补写**留痕的结果 —— 只有"此前 `audit.ok===false`"才会被 `initSchema()` 填上 */
    auditBackfilled: false,
    backfillAudit: null
  };
  return out;
}

/**
 * **F19-5（结案复跑建议，主代理裁定"做"）**：破坏性迁移**成功之后**补写一条 E18 备份留痕。
 *
 * 背景：极旧库可能**连 `op_log` 表都没有**，迁移前那次审计必然写不进去 ⇒ 只能留下一条易失告警
 * （`auditDegraded:true`），E18 的"可审计"在该形态下降级。而 `schema.sql` 执行**之后** `op_log`
 * 已经存在，补写成本极低 —— 于是这里补一条，内容显式标注 `backfill（迁移后补写）`，并保留
 * "原先写入失败"的原因，**不改变**"审计不了也不中止迁移"的既定口径（F17-3 裁定）。
 *
 * @param {object} db 已建表（`op_log` 已存在）的库句柄
 * @param {object} pre `runPreMigrationBackup()` 的返回值
 * @returns {{ok:boolean, id:number|null, error:string, backfilled:boolean}}
 */
function backfillBackupAudit(db, pre) {
  const content = `迁移前备份（E18）｜结果=成功｜**backfill（迁移后补写）**｜备份文件=${pre.path}｜` +
    `体积=${pre.bytes} 字节｜原因=${pre.reason}｜原先审计写入失败：${pre.audit && pre.audit.error ? pre.audit.error : '未知'}`;
  const r = appendBackupLog(db, { result: '成功', content }, pre.at);
  return { ok: r.ok, id: r.id, error: r.error, backfilled: true };
}

/** 读取建表脚本正文 */
function readSchemaSql() {
  return fs.readFileSync(SCHEMA_FILE, 'utf8');
}

/** schema.sql 正文指纹（SHA-256 前 16 位）：用于校验"改了 schema 是否同步升版本" */
function schemaFingerprint() {
  return require('node:crypto').createHash('sha256').update(readSchemaSql(), 'utf8').digest('hex').slice(0, 16);
}

/** 取内置 SQLite 实现（Node 22.5+ 存在，Node 24 起免实验标志） */
function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (err) {
    throw new Error(
      `node:sqlite 不可用（当前 ${process.version}）。本项目要求 Node >= 24（ADR-0002 D10）：${err.message}`
    );
  }
}

/**
 * 打开数据库并设置运行 PRAGMA。
 * @param {string} dbPath 数据库文件路径（目录不存在会自动创建）
 * @param {{journalMode?:string, foreignKeys?:boolean, busyTimeoutMs?:number}} [options]
 */
function openDb(dbPath, options = {}) {
  const { DatabaseSync } = loadSqlite();
  const journalMode = options.journalMode || 'WAL';
  const foreignKeys = options.foreignKeys !== false;
  const busyTimeoutMs = options.busyTimeoutMs === undefined ? 5000 : options.busyTimeoutMs;

  const dir = path.dirname(path.resolve(dbPath));
  fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  /* P2-6：PRAGMA 段若抛错（参数非法、文件只读等），必须**先关连接再抛**。
     否则 Windows 上文件句柄泄漏 → 文件被锁、临时目录删不掉（复审实测 rmSync 报 EPERM）。 */
  try {
    const journal = db.prepare(`PRAGMA journal_mode = ${journalMode}`).get();
    /* ⚠ 2026-09-19（P3 表外 code-13）：这里原本无条件开 `PRAGMA foreign_keys = ON`，
       但 `schema.sql` 全文**没有任何 FOREIGN KEY / REFERENCES** —— 该 PRAGMA 是**空操作**，
       会让人误以为引用完整性已被数据库守着。现改为：**只在 schema 真的声明了外键时才开**
       （扫描 schema.sql 判断），并在都没声明时保持默认（SQLite 默认即关闭）。
       为什么不直接补外键：`measure_rt`/`result`/`task_curve` 都是先有采集与判定、再落 task 的
       异步链路，加外键会把"上游先到"变成硬失败，属**决策级改动**（需 ADR），不在本轮范围。 */
    const hasForeignKeys = /FOREIGN\s+KEY|REFERENCES/i.test(readSchemaSql());
    if (foreignKeys && hasForeignKeys) db.prepare('PRAGMA foreign_keys = ON').get();
    /* 多进程/多连接下避免"database is locked"直接报错（服务与备份任务并存时有用） */
    if (busyTimeoutMs > 0) db.prepare(`PRAGMA busy_timeout = ${busyTimeoutMs}`).get();
    return { db, path: path.resolve(dbPath), journalMode: journal && journal.journal_mode };
  } catch (err) {
    try { db.close(); } catch { /* 关闭失败不掩盖原始错误 */ }
    throw err;
  }
}

/** 建表（幂等：schema.sql 全部 IF NOT EXISTS ＋ STRUCTURE_UPGRADES 补列），并写入结构版本与 schema 指纹
 *
 *  ⚠ 2026-09-22（V1.33 第二批）：整段 `schema.sql`（＋旧结构迁移 ＋补列升级）**包在一个事务里**执行。
 *  为什么要动这里：`node:sqlite` 的 `db.exec()` **不会**自动把多语句包成事务 —— 已实测：
 *  脚本中途报错时，**先前已执行的 DDL（如 `ALTER TABLE ... RENAME`）仍然生效**，
 *  于是旧 standard 表重建一旦走到一半失败，库里会留下半迁移状态（表被改名、数据还在但没有新表）。
 *  加上 `BEGIN` / `COMMIT` 后，任何一步失败都整体回滚，库回到执行前的自洽状态
 *  —— 即"要么整套结构到位，要么一行不动"。
 *  ⚠ 因此**不要**绕过本函数直接 `db.exec(schema.sql)`：那样会失去这层原子性。
 *
 *  ⚠ 2026-09-28（**E18**）：破坏性迁移**之前**强制备份，且**不可跳过**：
 *   ① 先 `planMigration()` 判断本次是否真的会做破坏性迁移/结构变更（判据见该函数）；
 *   ② 需要 ⇒ 调 `server/db/maintain.js` 的**同步**备份（`backupToSync`）落一份**迁移前**的库文件，
 *      并把"路径/原因/结果"写进 `op_log`（`op_type='迁移前备份'`）；
 *   ③ 备份**失败 ⇒ 抛错中止**（带 `code='PRE_MIGRATION_BACKUP_FAILED'`），**业务数据一行不动**
 *      （若库内已有 `op_log` 表，会**追加 1 条** E18 失败留痕 —— 措辞按 F17-4 修正）——
 *      迁移是 `DROP TABLE standard_legacy` 这一类不可逆动作，没有备份就不许继续（不得静默跳过）；
 *   ④ 不需要（新库首建 / 无迁移的重复调用）⇒ **不产出任何备份**（幂等：不会"每次启动多一份"）。
 *   ⑤ 审计写入失败（`op_log` 表不存在等）⇒ **显式告警**（`options.logger.warn` / `console.warn`）
 *      并在返回值里带 `auditDegraded:true`（F17-3）。
 *  备份发生在 `BEGIN` **之前**：事务里写备份会让快照语义含混（也可能因写事务被拒），
 *  而"先备份后迁移"正是本条的语义；备份成功但迁移失败并回滚时，多出的那份备份无害（可审计为"未使用"）。
 *
 *  @param {object} db 数据库句柄
 *  @param {string} [now] 当前时刻（DR-16 文本，由调用方注入时钟给出）
 *  @param {{backupDir?:string, backup?:Function, now?:Date|string|number, logger?:object,
 *           skipBackup?:boolean, skipPreMigrationBackup?:boolean}} [options]
 *    `backupDir` —— 迁移前备份目录（缺省＝库文件同目录树下的 `backup/`）
 *    `backup`    —— **同步**备份函数注入出口（自检制造失败用；缺省＝maintain.backupToSync）
 *    `now`       —— 备份文件名/留痕用的时刻（缺省＝`now` 文本，再缺省＝真实时钟）
 *    `logger`    —— F17-3 的告警出口（审计写入失败时 `logger.warn`；缺省退 `console.warn`）
 *    `skipBackup` / `skipPreMigrationBackup` —— **只用于"拒绝跳过"**：传了就抛错（E18 不可跳过）
 *
 *  @returns {{schemaVersion:string, fingerprint:string, appliedAt:string, migration:object,
 *             preMigrationBackup:object}}
 *    `migration` 为本次旧结构迁移的结果（`{migrated, reason, rows}`），供调用方审计；
 *    无迁移时 `migrated=false`。
 *    `preMigrationBackup` 为本次迁移前备份的结果：`{needed, ok, path, name, dir, bytes, engine,
 *    reason, at, audit, auditDegraded}`；`needed=false` 时 `path=null`（**没有产出备份**，这是幂等的可核查证据）。 */
/**
 * `DR-13`（V1.45 第 11 处）迁移：把 `measure_rt` 的**去重键加上端点标识**。
 *
 * 三步（幂等、事务）：
 *   A. `ALTER TABLE measure_rt ADD COLUMN endpoint TEXT`（仅当列不存在）
 *   B. 回填 `endpoint = equip_code`（仅当有 NULL）—— **不留 NULL**：SQLite 唯一索引里 NULL 互不相等，
 *      留 NULL 会让"升级前的行"与"升级后同帧"判不成重复 ⇒ 多插一行。回填值＝`services/endpointLink.js`
 *      的 `resolveEndpointId()` 回退链的默认值。
 *   C. 唯一索引重建为四列（仅当索引列不符）—— **只加列不重建索引＝去重口径没变**。
 *
 * 失败 ⇒ 事务回滚并**抛出**（调用方拒绝启动，不静默带病运行）。
 *
 * @returns {{addedColumn:boolean, backfilled:number, rebuiltIndex:boolean}}
 */
function migrateMeasureRtEndpoint(db) {
  db.exec('BEGIN');
  try {
    const cols = db.prepare('PRAGMA table_info(measure_rt)').all().map(c => c.name);
    const addedColumn = !cols.includes('endpoint');
    if (addedColumn) db.exec('ALTER TABLE measure_rt ADD COLUMN endpoint TEXT');

    const nullRows = db.prepare('SELECT COUNT(*) AS c FROM measure_rt WHERE endpoint IS NULL').get().c;
    if (nullRows > 0) db.exec('UPDATE measure_rt SET endpoint = equip_code WHERE endpoint IS NULL');

    const want = ['equip_code', 'proc_order_no', 'endpoint', 'collect_time'];
    const hasIdx = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='ux_measure_rt'").get().c;
    const cur = hasIdx ? db.prepare('PRAGMA index_info(ux_measure_rt)').all().map(c => c.name) : [];
    const rebuiltIndex = JSON.stringify(cur) !== JSON.stringify(want);
    if (rebuiltIndex) {
      db.exec('DROP INDEX IF EXISTS ux_measure_rt');
      db.exec('CREATE UNIQUE INDEX ux_measure_rt ON measure_rt(equip_code, proc_order_no, endpoint, collect_time)');
    }
    db.exec('COMMIT');
    return { addedColumn, backfilled: nullRows, rebuiltIndex };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw new Error(`migrateMeasureRtEndpoint 失败（已回滚，拒绝带病运行）：${e.message}`);
  }
}

function initSchema(db, now, options = {}) {
  if (options.skipBackup || options.skipPreMigrationBackup) {
    /* 不提供"跳过"开关：旧库迁移会 DROP 旧表，跳过备份 = 不可恢复。显式拒绝优于"悄悄支持"。 */
    throw new Error('initSchema: 迁移前备份**不可跳过**（E18 —— 旧库迁移会 DROP 旧表，无备份不可恢复）');
  }
  const plan = planMigration(db);
  const when = resolveBackupWhen(options, now);
  const preMigrationBackup = plan.needed
    ? runPreMigrationBackup(db, plan, options, when)
    : {
      needed: false, ok: true, path: null, name: null,
      dir: options.backupDir ? path.resolve(String(options.backupDir)) : null,
      bytes: 0, engine: null, reason: plan.reason, at: formatNow(when), audit: null, auditDegraded: false
    };

  const sql = readSchemaSql();
  db.exec('BEGIN');
  let migration;
  try {
    /* 先在**事务内**做旧结构迁移：`schema.sql` 的索引建在 standard 上，旧表没有 process_code 列，
       必须先重建再跑建表脚本（顺序颠倒会在旧库上报 `no such column: process_code`）。 */
    migration = migrateLegacyStandard(db);
    db.exec(sql);
    for (const step of STRUCTURE_UPGRADES) {
      /* E74：**先判形态、再执行** —— 且刻意放在下面这个 try **之外**，让
         `duplicate column name|already exists` 的那张容忍网**吞不到**"形态违规"这一步。 */
      assertUpgradeStepShape(step);
      try {
        db.exec(step);
      } catch (err) {
        /* 只吞"已存在"类错误：补列/建索引都幂等，重复执行必然走到这里；其余错误照常抛。 */
        if (!/duplicate column name|already exists/i.test(err.message)) throw err;
      }
    }
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误 */ }
    throw err;
  }
  db.exec('COMMIT');
  const at = now || formatNow();
  const stmt = db.prepare(
    'INSERT INTO schema_meta(key, value, updated_at) VALUES(?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  stmt.run('schema_version', SCHEMA_VERSION, at);
  /* 同时落 schema 指纹（P3 表外 code-12）：让"改 schema 必须同步升 SCHEMA_VERSION"
     这条约定**可被机器校验** —— 见下方 verifySchemaConsistency()。 */
  stmt.run('schema_fingerprint', schemaFingerprint(), at);

  /* **F19-5**：迁移成功、且此前审计写入失败（典型＝极旧库连 `op_log` 表都没有）⇒ 此刻 `op_log`
     已由 `schema.sql` 建好，**补写**一条 E18 备份留痕（内容标注 `backfill（迁移后补写）`）。
     不改变"审计不了也不中止迁移"的既定口径，只是把"可审计"从易失告警补成落库事实。 */
  if (preMigrationBackup && preMigrationBackup.needed && preMigrationBackup.audit &&
      preMigrationBackup.audit.ok === false) {
    const backfill = backfillBackupAudit(db, preMigrationBackup);
    preMigrationBackup.auditBackfilled = backfill.ok === true;
    preMigrationBackup.backfillAudit = backfill;
  }

  /* `DR-13`（V1.45 第 11 处）：把 `measure_rt` 去重键加上端点标识（幂等；失败即抛 ⇒ 调用方拒绝启动） */
  const endpointMigration = migrateMeasureRtEndpoint(db);

  return {
    schemaVersion: SCHEMA_VERSION, fingerprint: schemaFingerprint(), appliedAt: at,
    migration, preMigrationBackup, migrationPlan: plan, endpointMigration
  };
}

/** 读取结构版本 */
function getSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    return row ? row.value : null;
  } catch {
    return null;   // 表还没建
  }
}

/** 读取库里记录的 schema 指纹（未记录返回 null） */
function getSchemaFingerprint(db) {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_fingerprint'").get();
    return row ? row.value : null;
  } catch {
    return null;
  }
}

/**
 * 校验"改 schema.sql 必须同步升 SCHEMA_VERSION"（P3 表外 code-12）。
 *
 * 为什么需要：原来只有"写进去的值 == 常量自己"的断言，**证明不了**这条约定被遵守 ——
 * 有人改了 `schema.sql` 却忘了 +1 时，程序照样自洽、迁移判断却会错。
 * 做法：`schema_meta` 里同时记**结构版本**与**schema 指纹**（正文 SHA-256 前 16 位）；
 * 指纹不一致即说明"SQL 改了而版本没跟着变"。
 *
 * @returns {{ok:boolean, reason:string, version:string|null, stored:string|null, current:string}}
 */
function verifySchemaConsistency(db) {
  const current = schemaFingerprint();
  const stored = getSchemaFingerprint(db);
  const version = getSchemaVersion(db);
  if (stored === null) {
    return { ok: false, reason: '库里没有 schema 指纹（旧库或未 initSchema）—— 无法判断版本是否同步', version, stored, current };
  }
  if (stored !== current) {
    return {
      ok: false,
      reason: `schema.sql 已改动（指纹 ${stored} → ${current}）但库里的结构版本仍是 ${version} —— 请同步升 SCHEMA_VERSION`,
      version, stored, current
    };
  }
  return { ok: true, reason: '', version, stored, current };
}

/**
 * 写入初始数据（幂等）：设备 1 条。
 * 其余基础数据（工单、标准、公告）由 IF-A/本机录入产生，不在此预置。
 */
function seedInitialData(db, device, now) {
  const at = now || formatNow();
  db.prepare(
    `INSERT INTO device(equip_code, equip_name, model, location, upper_host, upper_port,
                        mes_base_url, camera_count, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(equip_code) DO UPDATE SET
       equip_name = excluded.equip_name, model = excluded.model, location = excluded.location,
       upper_host = excluded.upper_host, upper_port = excluded.upper_port,
       mes_base_url = excluded.mes_base_url, camera_count = excluded.camera_count,
       updated_at = excluded.updated_at`
  ).run(
    device.equipCode, device.equipName, device.model || null, device.location || null,
    device.upperHost || null, device.upperPort || null, device.mesBaseUrl || null,
    device.cameraCount || 19, at
  );
  return { equipCode: device.equipCode };
}

/** 列出全部业务表名（不含 schema_meta），供自检与迁移使用 */
function listTables(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(r => r.name);
}

/** 列出某表列名（供 schema ↔ fieldMap 交叉核对） */
function listColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
}

/**
 * 把 WAL 内容合并回主库文件（备份前调用，保证备份文件自包含）。
 * 返回 { ok, error }，不抛出 —— 备份流程不应因 checkpoint 失败而中断。
 */
function flushWal(db) {
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 完整性检查（PRAGMA integrity_check），返回 { ok, detail } */
function verifyIntegrity(db) {
  const row = db.prepare('PRAGMA integrity_check').get();
  const detail = row ? Object.values(row)[0] : '';
  return { ok: detail === 'ok', detail };
}

/** 本地时间格式（DR-16：yyyy-MM-dd HH:mm:ss，本机时间基准） */
function formatNow(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = {
  SCHEMA_VERSION,
  SCHEMA_FILE,
  UPGRADE_STEP_FORMS,
  classifyUpgradeStep,
  assertUpgradeStepShape,
  STRUCTURE_UPGRADES,
  PRE_MIGRATION_BACKUP_OP_TYPE,
  readSchemaSql,
  schemaFingerprint,
  loadSqlite,
  openDb,
  initSchema,
  migrateMeasureRtEndpoint,
  migrateLegacyStandard,
  legacyStandardState,
  planMigration,
  defaultBackupDir,
  dbFilePath,
  getSchemaVersion,
  getSchemaFingerprint,
  verifySchemaConsistency,
  seedInitialData,
  listTables,
  listColumns,
  flushWal,
  verifyIntegrity,
  formatNow
};
