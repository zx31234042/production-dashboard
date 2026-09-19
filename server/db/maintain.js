/* ==========================================================================
   归档与备份（server/db/maintain.js）
   作用：①在线备份（DR-15 每日自动备份 + 保留 N 份）②数据保留策略（DR-14 统一保留 1 年）
        ③备份文件校验与列出（供一键恢复与自检页使用）。
   依据：DR-14、DR-15、DEP-08；ADR-0001 D5（用内置 backup API，不靠拷文件）。
   依赖：node:path、node:fs、node:sqlite（经 ./index.js 的 loadSqlite 间接使用）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadSqlite, flushWal, verifyIntegrity, formatNow } = require('./index');

/** 备份文件名：board-YYYYMMDD-HHmmss.db */
function backupName(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `board-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.db`;
}

/**
 * 在线备份（不阻塞读；备份前先 checkpoint，保证备份文件自包含）。
 * @param {object} db 已打开的数据库句柄
 * @param {string} backupDir 备份目录（不存在会创建）
 * @param {{name?:string, now?:Date}} [options]
 * @returns {Promise<{path:string, name:string, bytes:number, checkpoint:object}>}
 */
async function backupTo(db, backupDir, options = {}) {
  const { backup } = loadSqlite();
  const dir = path.resolve(backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = options.name || backupName(options.now || new Date());
  const target = path.join(dir, name);

  const checkpoint = flushWal(db);
  await backup(db, target);

  const st = fs.statSync(target);
  return { path: target, name, bytes: st.size, checkpoint };
}

/** 列出备份（按时间倒序），带体积与修改时间 */
function listBackups(backupDir) {
  const dir = path.resolve(backupDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => /^board-\d{8}-\d{6}\.db$/.test(n))
    .map(n => {
      const full = path.join(dir, n);
      const st = fs.statSync(full);
      return { name: n, path: full, bytes: st.size, modifiedAt: formatNow(st.mtime) };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/**
 * 只保留最近 keep 份备份，多余的删除（DR-15 的"保留 N 份"）。
 * @returns {{kept:number, removed:string[]}}
 */
function pruneBackups(backupDir, keep) {
  const all = listBackups(backupDir);
  const removed = [];
  for (const b of all.slice(Math.max(0, keep))) {
    try { fs.rmSync(b.path, { force: true }); removed.push(b.name); } catch { /* 忽略 */ }
  }
  return { kept: Math.min(keep, all.length), removed };
}

/**
 * 校验一个备份文件能否打开且完整（供"一键恢复"前的自查）。
 * @returns {{ok:boolean, detail:string, tables:number}}
 */
function verifyBackup(file) {
  const { DatabaseSync } = loadSqlite();
  let db = null;
  try {
    db = new DatabaseSync(file);
    const integrity = verifyIntegrity(db);
    const tables = db.prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).get().c;
    return { ok: integrity.ok, detail: integrity.detail, tables };
  } catch (err) {
    return { ok: false, detail: err.message, tables: 0 };
  } finally {
    if (db) { try { db.close(); } catch { /* 忽略 */ } }
  }
}

/** 默认保留策略：1 年（DR-14） */
const RETENTION_DAYS = 365;

/**
 * 按保留天数裁剪历史数据。**只删数据、不删表**。
 * 裁剪对象：measure_rt（采样）、task_curve（曲线）、alarm/warning/upload_log/op_log（台账与日志）。
 * task / result / shift_stat 属业务主数据，本函数不触碰（由归档流程另行处理）。
 * @param {object} db
 * @param {{days?:number, now?:Date}} [options]
 * @returns {{cutoff:string, deleted:object}}
 */
function applyRetention(db, options = {}) {
  const days = options.days === undefined ? RETENTION_DAYS : options.days;
  const now = options.now || new Date();
  const cutoffDate = new Date(now.getTime() - days * 24 * 3600 * 1000);
  const cutoff = formatNow(cutoffDate);

  const deleted = {};
  const run = (label, sql, col) => {
    const r = db.prepare(`DELETE FROM ${sql} WHERE ${col} < ?`).run(cutoff);
    deleted[label] = r.changes;
  };
  run('measure_rt', 'measure_rt', 'collect_time');
  run('task_curve', 'task_curve', 'finished_at');
  run('alarm', 'alarm', 'occurred_at');
  run('warning', 'warning', 'triggered_at');
  run('upload_log', 'upload_log', 'created_at');
  run('op_log', 'op_log', 'op_time');

  return { cutoff, deleted };
}

module.exports = {
  RETENTION_DAYS,
  backupName,
  backupTo,
  listBackups,
  pruneBackups,
  verifyBackup,
  applyRetention
};
