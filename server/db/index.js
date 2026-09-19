/* ==========================================================================
   数据库连接与初始化（server/db/index.js）
   作用：打开本地 SQLite 库、执行建表脚本、写入结构版本与初始字典数据，
        并暴露备份/保留策略所需的最小能力。
   依据：DR-01～DR-19（需求清单 V1.29 第 7 章）、ADR-0001 D5（SQLite + WAL）、
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

/** 当前表结构版本；**改动 schema.sql 时必须同步 +1**，供后续迁移判断 */
const SCHEMA_VERSION = '1';

/** 建表脚本位置（与本文件同目录） */
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

/** 读取建表脚本正文 */
function readSchemaSql() {
  return fs.readFileSync(SCHEMA_FILE, 'utf8');
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
    if (foreignKeys) db.prepare('PRAGMA foreign_keys = ON').get();
    /* 多进程/多连接下避免"database is locked"直接报错（服务与备份任务并存时有用） */
    if (busyTimeoutMs > 0) db.prepare(`PRAGMA busy_timeout = ${busyTimeoutMs}`).get();
    return { db, path: path.resolve(dbPath), journalMode: journal && journal.journal_mode };
  } catch (err) {
    try { db.close(); } catch { /* 关闭失败不掩盖原始错误 */ }
    throw err;
  }
}

/** 建表（幂等：schema.sql 全部 IF NOT EXISTS），并写入结构版本 */
function initSchema(db, now) {
  db.exec(readSchemaSql());
  const at = now || formatNow();
  const stmt = db.prepare(
    'INSERT INTO schema_meta(key, value, updated_at) VALUES(?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  stmt.run('schema_version', SCHEMA_VERSION, at);
  return { schemaVersion: SCHEMA_VERSION, appliedAt: at };
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
  readSchemaSql,
  loadSqlite,
  openDb,
  initSchema,
  getSchemaVersion,
  seedInitialData,
  listTables,
  listColumns,
  flushWal,
  verifyIntegrity,
  formatNow
};
