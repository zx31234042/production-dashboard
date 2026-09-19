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

/** 默认保留份数：每日一份 ≈ 30 天（DR-15） */
const BACKUP_KEEP = 30;

/**
 * 只保留最近 keep 份备份，多余的删除（DR-15 的"保留 N 份"）。
 *
 * ⚠ 2026-09-19 修（复审 P2-2）：旧写法 `Math.max(0, keep)` 在 `keep` 缺省/undefined 时得
 * `NaN`，`slice(NaN)` 等价 `slice(0)` —— **一次删光全部备份**，还返回 `kept: NaN` 且不报错
 * （已复现：3 份备份 → 删后 0 份）。现在：缺省走 `BACKUP_KEEP`、入参非法即抛错、
 * `kept` 返回**真实剩余数**，并把删除名单一并返回供审计。
 *
 * @param {string} backupDir
 * @param {number} [keep] 保留份数（默认 30）；必须是 ≥ 0 的整数
 * @returns {{kept:number, removed:string[], dir:string}}
 */
function pruneBackups(backupDir, keep = BACKUP_KEEP) {
  const dir = path.resolve(backupDir);
  const n = typeof keep === 'string' && keep.trim() !== '' ? Number(keep) : keep;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`pruneBackups: keep 必须是 ≥ 0 的整数（收到 ${JSON.stringify(keep)}）`);
  }
  const all = listBackups(dir);
  const removed = [];
  for (const b of all.slice(n)) {
    try { fs.rmSync(b.path, { force: true }); removed.push(b.name); } catch { /* 忽略 */ }
  }
  const kept = listBackups(dir).length;   // 真实剩余数（不靠算式推断）
  return { kept, removed, dir };
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

/** 单次裁剪删除行数上限：超过即视为"参数或口径出问题"，先停下而不是悄悄清库 */
const RETENTION_MAX_DELETE = 5_000_000;

/**
 * 按保留天数裁剪历史数据。**只删数据、不删表**。
 * 裁剪对象：measure_rt（采样）、task_curve（曲线）、alarm/warning/upload_log/op_log（台账与日志）。
 * task / result / shift_stat 属业务主数据，本函数不触碰（由归档流程另行处理）。
 *
 * ⚠ 2026-09-19 修（复审 P2-1，已复现的**静默删光**路径）：
 * 旧写法对 `days` 不做校验 —— `null` 被当成 0（cutoff=now，历史全删）、
 * `NaN` 让 `formatNow` 产出 `"NaN-NaN-NaN NaN:NaN:NaN"`，而 SQLite 里日期是**文本比较**，
 * 任何正常日期都 `< "N..."`，结果六张表被**清空**（探针实测剩余 0 行）。
 * 现在：入口强校验 `days`、cutoff 必须可解析、单次删除设上限并返回可审计信息。
 *
 * @param {object} db
 * @param {{days?:number, now?:Date, maxDelete?:number, dryRun?:boolean}} [options]
 * @returns {{cutoff:string, deleted:object, totalDeleted:number, dryRun:boolean}}
 */
function applyRetention(db, options = {}) {
  const rawDays = options.days === undefined ? RETENTION_DAYS : options.days;
  const days = typeof rawDays === 'string' && rawDays.trim() !== '' ? Number(rawDays) : rawDays;
  if (!Number.isInteger(days) || days < 1) {
    throw new TypeError(`applyRetention: days 必须是 ≥ 1 的整数（收到 ${JSON.stringify(options.days)}）—— 拒绝退化为"全删"`);
  }
  const maxDelete = options.maxDelete === undefined ? RETENTION_MAX_DELETE : Number(options.maxDelete);
  if (!Number.isInteger(maxDelete) || maxDelete < 0) {
    throw new TypeError(`applyRetention: maxDelete 必须是 ≥ 0 的整数（收到 ${JSON.stringify(options.maxDelete)}）`);
  }
  const now = options.now || new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('applyRetention: now 必须是合法 Date');
  }
  const cutoffDate = new Date(now.getTime() - days * 24 * 3600 * 1000);
  if (!Number.isFinite(cutoffDate.getTime())) {
    throw new RangeError(`applyRetention: 由 days=${days} 推出的 cutoff 非法 —— 拒绝执行删除`);
  }
  const cutoff = formatNow(cutoffDate);
  /* cutoff 必须是可比较的日期文本；否则文本比较下会误删全部（P2-1 的根因） */
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cutoff)) {
    throw new RangeError(`applyRetention: cutoff 格式异常「${cutoff}」—— 拒绝执行删除`);
  }

  const targets = [
    ['measure_rt', 'measure_rt', 'collect_time'],
    ['task_curve', 'task_curve', 'finished_at'],
    ['alarm', 'alarm', 'occurred_at'],
    ['warning', 'warning', 'triggered_at'],
    ['upload_log', 'upload_log', 'created_at'],
    ['op_log', 'op_log', 'op_time']
  ];

  /* 先数后删：既能做上限保护，也让 dryRun 可用（恢复演练/评审时先看会删多少） */
  const deleted = {};
  let total = 0;
  for (const [label, table, col] of targets) {
    const c = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} < ?`).get(cutoff).c;
    deleted[label] = c;
    total += c;
  }
  if (total > maxDelete) {
    throw new RangeError(
      `applyRetention: 本次将删除 ${total} 行，超过上限 ${maxDelete}（cutoff=${cutoff}）—— 已中止，请核对 days 与数据范围`);
  }
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    for (const [, table, col] of targets) {
      db.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(cutoff);
    }
  }
  return { cutoff, deleted, totalDeleted: total, dryRun };
}

module.exports = {
  RETENTION_DAYS,
  RETENTION_MAX_DELETE,
  BACKUP_KEEP,
  backupName,
  backupTo,
  listBackups,
  pruneBackups,
  verifyBackup,
  applyRetention
};
