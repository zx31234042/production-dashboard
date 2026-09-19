/* ==========================================================================
   零依赖日志（platform/log.js）
   作用：分级日志 + 按日滚动 + 体积上限（NFR-21：日志分级与滚动、保留 ≥30 天）。
        不引第三方库（ADR-0002 D13），用 node:fs 追加写即可满足。
   依赖：node:fs / node:path；时间经 platform/clock.js 注入，便于自检钉死时间。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fmt, fmtDate } = require('./clock');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DAY_MS = 24 * 3600 * 1000;

/**
 * 创建日志器。
 * @param {{dir:string, level?:string, clock?:object, maxBytes?:number, keepDays?:number, console?:boolean}} options
 *   dir       —— 日志目录（由 platform/paths.js 提供，不在此处硬编码）
 *   level     —— 最低输出级别，默认 info
 *   clock     —— 时钟（不传则用真实时间）
 *   maxBytes  —— 单文件体积上限，超出后当日文件换序号（默认 5 MB）
 *   keepDays  —— 保留天数，超过则删除旧日志（默认 30，NFR-21）
 */
function createLogger(options) {
  const dir = options.dir;
  const minLevel = LEVELS[options.level || 'info'] || LEVELS.info;
  const clock = options.clock;
  const maxBytes = options.maxBytes === undefined ? 5 * 1024 * 1024 : options.maxBytes;
  const keepDays = options.keepDays === undefined ? 30 : options.keepDays;
  const echo = options.console !== false;      // 默认同时打到控制台

  /* P2-7：keepDays 过去**只被赋值、从不生效**（prune() 存在但无人调用），
     NFR-21"保留 ≥30 天"的后半段等于没落地。这里做两件事：
       ①入参校验：0/负数/NaN/小数一律拒绝（否则 `mtime < now - 0` 会把**当天日志也删掉**）；
       ②**创建日志器时就剪一次** —— 服务每次启动都执行，且是 O(1) 次目录扫描，
         不放在每次 write 上，避免高频落库路径反复 statSync。 */
  if (!Number.isInteger(keepDays) || keepDays < 1) {
    throw new TypeError(`createLogger: keepDays 必须是 ≥ 1 的整数（收到 ${JSON.stringify(options.keepDays)}）`);
  }

  const now = () => (clock ? clock.now() : new Date());
  let cachedDate = null;
  let cachedSeq = 0;

  fs.mkdirSync(dir, { recursive: true });

  /** 解析当前应写入的文件名：<日期>-<序号>.log；当日超限自动换序号 */
  function currentFile() {
    const date = fmtDate(now());
    if (cachedDate !== date) { cachedDate = date; cachedSeq = 0; }
    for (let i = 0; i < 100; i++) {
      const seq = cachedSeq + i;
      const name = seq === 0 ? `${date}.log` : `${date}-${seq}.log`;
      const full = path.join(dir, name);
      if (!fs.existsSync(full) || fs.statSync(full).size < maxBytes) {
        cachedSeq = seq;
        return full;
      }
    }
    cachedSeq++;
    return path.join(dir, `${date}-${cachedSeq}.log`);
  }

  function write(level, msg, extra) {
    if (LEVELS[level] < minLevel) return null;
    const line = `[${fmt(now())}] [${level.toUpperCase()}] ${msg}` +
      (extra === undefined ? '' : ' ' + safeJson(extra));
    const file = currentFile();
    fs.appendFileSync(file, line + '\n', 'utf8');
    if (echo) {
      const sink = LEVELS[level] >= LEVELS.warn ? console.error : console.log;
      sink(line);
    }
    return { file, line };
  }

  const logger = {
    level: options.level || 'info',
    dir,
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
    /** 当前日志文件路径（自检用） */
    file: () => currentFile(),
    /** 列出本目录日志（按名倒序，便于自检与运维查看） */
    list: () => fs.readdirSync(dir).filter(n => n.endsWith('.log')).sort().reverse(),
    /** 删除超过 keepDays 的日志；返回 {removed, kept} */
    prune() {
      const cutoff = now().getTime() - keepDays * DAY_MS;
      const removed = [];
      let kept = 0;
      for (const n of logger.list()) {
        const full = path.join(dir, n);
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) { fs.rmSync(full, { force: true }); removed.push(n); }
        else kept++;
      }
      return { removed, kept, cutoff: new Date(cutoff), keepDays };
    }
  };

  /* 启动即剪一次（NFR-21 落地），并把结果留痕便于运维核对 */
  const startupPrune = logger.prune();
  logger.startupPrune = startupPrune;
  if (startupPrune.removed.length && echo) {
    console.log(`[日志] 启动清理：按 keepDays=${keepDays} 删除 ${startupPrune.removed.length} 个过期日志`);
  }
  return logger;
}

/** 序列化附加数据（避免循环引用把日志写崩） */
function safeJson(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return '[无法序列化]'; }
}

module.exports = { createLogger, LEVELS };
