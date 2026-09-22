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
 *    该表结构变化是**不兼容**的（旧列消失、新增唯一键），故必须升版；旧库升级路径见 schema.sql 注释。 */
const SCHEMA_VERSION = '4';

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
 */
const STRUCTURE_UPGRADES = [
  /* DR-12（V1.33）：op_log 增列 team_code（班组编号）。schema.sql 的新建表语句里已有该列，
     旧库（SCHEMA_VERSION '3'）需要这一步补上；重复执行时报 `duplicate column name` 被吞掉。 */
  'ALTER TABLE op_log ADD COLUMN team_code TEXT',
  /* 上面的列补齐后才能建这个索引（旧表补列前建会报 `no such column: team_code`）；
     `IF NOT EXISTS` 本身幂等。 */
  'CREATE INDEX IF NOT EXISTS ix_op_log_team ON op_log(team_code, op_time)'
];

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
 * @param {object} db 已打开且在事务中的数据库句柄
 * @returns {{migrated:boolean, reason:string, rows:number}} 迁移结果（可审计）
 */
function migrateLegacyStandard(db) {
  let tableExists = false;
  try {
    tableExists = Boolean(db.prepare(
      "SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'standard'"
    ).get());
  } catch (err) {
    return { migrated: false, reason: `无法读取 sqlite_master：${err.message}`, rows: 0 };
  }
  if (!tableExists) return { migrated: false, reason: 'standard 表尚不存在（新建库，无需迁移）', rows: 0 };

  /* 结构判据：`pragma_table_info` 里有没有新列 `version_no`（以及 `process_code`）。
     为什么不用 `CREATE TEMP VIEW ... SELECT version_no` 探针：**SQLite 建视图时并不校验列**，
     要等真正 SELECT 才报 `no such column`（已实测），拿它当判据会误判成"已是新结构"。 */
  const cols = db.prepare("SELECT name FROM pragma_table_info('standard')").all().map(r => r.name);
  if (cols.includes('version_no') && cols.includes('process_code')) {
    return { migrated: false, reason: 'standard 已是新结构（含 version_no/process_code）', rows: 0 };
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
 *  @returns {{schemaVersion:string, fingerprint:string, appliedAt:string, migration:object}}
 *    `migration` 为本次旧结构迁移的结果（`{migrated, reason, rows}`），供调用方审计；
 *    无迁移时 `migrated=false`。 */
function initSchema(db, now) {
  const sql = readSchemaSql();
  db.exec('BEGIN');
  let migration;
  try {
    /* 先在**事务内**做旧结构迁移：`schema.sql` 的索引建在 standard 上，旧表没有 process_code 列，
       必须先重建再跑建表脚本（顺序颠倒会在旧库上报 `no such column: process_code`）。 */
    migration = migrateLegacyStandard(db);
    db.exec(sql);
    for (const step of STRUCTURE_UPGRADES) {
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
  return { schemaVersion: SCHEMA_VERSION, fingerprint: schemaFingerprint(), appliedAt: at, migration };
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
  STRUCTURE_UPGRADES,
  readSchemaSql,
  schemaFingerprint,
  loadSqlite,
  openDb,
  initSchema,
  migrateLegacyStandard,
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
