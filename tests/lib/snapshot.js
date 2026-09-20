/* ==========================================================================
   工作区快照（tests/lib/snapshot.js）
   作用：给门禁一轮运行提供"**运行期间工作区有没有被改写**"的机器判据。
        为什么必须有它（2026-09-20 立案）：门禁最怕的**不是**失败，而是"**被测对象正在被
        别的进程写**"——那时读到的半成品会被当成"代码坏了"。本会话已实际发生多起：
          · `docs-cross-check` 报 `files-check：实跑未产出可解析的汇总行`（该脚本正被并发写）；
          · 同一份 README 下 `harness-check` 的账本值在 94/92 之间翻面；
          · 变体文件被并发覆盖，导致"计数在两次运行间翻面"。
        结论：**一轮运行内若工作区被改写，该轮结论不得当作证据**（更不能拿去和权威数字比）。
   依据：ADR-0004 D19/D22（断言即证据、定点变异）；规范 9.5-5 第 6 条（跑不了要说跑不了）。
   依赖：仅 Node 内置模块（`node:fs` / `node:path` / `node:crypto`）。
   用法：
     const snap = require('./lib/snapshot');
     const a = snap.collectSnapshot();                 // 运行开始
     const b = snap.collectSnapshot();                 // 运行结束
     snap.diffSnapshots(a, b).length === 0;            // 空数组 = 运行期间工作区稳定
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ---------------- 范围（哪些文件算"门禁会读到的项目文件"） ----------------
   ① 目录：`src` / `server` / `platform` / `tests`（门禁实际读的项目代码与自检脚本都在这四棵树下）；
      `.git` / `来源文件` / `reference` / 需求文档 / 项目记录**不在内** —— 它们不是门禁的判据来源，
      且体积大、变动频繁（写文档的并发进程会让判定恒为"不稳定"，那就等于没有判据）。
   ② 只收**文本文件**（按扩展名，见 TEXT_EXTS）：图片/字体/数据库等二进制大件与"越改越乱"的
      稳定性判据无关，排除后每轮只需哈希约 0.3 MB，成本可忽略（性能契约：新增开销 ≤ 3 s）。
   ③ 排除 `tests\._verify\`（以及任何叫 `._verify` 的路径段）：那是本机制自己的落盘点
      （各脚本日志、账本 `run-totals.json`、临时库），**必然**在运行期间被写。
      若不排除，每一轮都会被判成"工作区不稳定" —— 这正是 D22 定点变异要反证的那条规则
      （见 `tests\harness-check.js` 第十二节）。 */
const PROJECT_DIRS = Object.freeze(['src', 'server', 'platform', 'tests']);
const EXCLUDE_SEGMENTS = Object.freeze(['._verify']);

/** 视为"文本文件"的扩展名（小写，含点）。判据按扩展名而非文件内容，保证**确定性**与可测性。 */
const TEXT_EXTS = Object.freeze([
  '.js', '.mjs', '.cjs', '.json', '.md', '.markdown', '.txt', '.css', '.html', '.htm',
  '.sql', '.yml', '.yaml', '.csv', '.log', '.ts', '.jsonl'
]);

/** 相对路径统一成 posix 风格：跨平台比较与打印都稳定（Windows 下 `path.relative` 会给反斜杠） */
function toPosix(rel) {
  return String(rel).replace(/\\/g, '/');
}

/** 判断路径是否落在被排除的路径段下（默认 `._verify`；按段比较，防 `x._verify/` 这类前缀误伤） */
function isExcluded(rel, segments = EXCLUDE_SEGMENTS) {
  const segs = toPosix(rel).split('/');
  return segs.some(s => segments.includes(s));
}

/** 判断是不是"文本文件"（按扩展名；大小写不敏感） */
function isTextFile(rel, exts = TEXT_EXTS) {
  const p = toPosix(rel);
  const i = p.lastIndexOf('.');
  if (i < 0) return false;
  return exts.includes(p.slice(i).toLowerCase());
}

/** 取文件字节的 SHA-256（十六进制）。读不到时返回 ``:err:<code>`` 这类**可比较**的标记串 ——
    记录失败本身也是一种"内容变化"，总比静默丢掉这个文件要好。 */
function hashFile(full) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  } catch (err) {
    return `:err:${(err && err.code) || (err && err.message) || 'unknown'}`;
  }
}

/** 递归遍历（不用 fs.walk）：`withFileTypes` 一次拿到类型，不额外 stat；符号链接一律不跟随。 */
function walk(dir, base, out, segments) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;                       /* 目录读不到（被删/被占用）：跳过，不影响其它树 */
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = toPosix(path.relative(base, full));
    if (isExcluded(rel, segments)) continue;
    if (ent.isDirectory()) { walk(full, base, out, segments); continue; }
    if (ent.isFile()) out.push({ full, rel });
  }
}

/**
 * 生成工作区快照：`{ at, root, files: { '相对路径': 'sha256' } }`。
 * **纯读取**，不写任何文件；目录不存在或读不到时如实记进 `reason` 并返回空清单。
 * @param {{root?:string, dirs?:string[], excludeSegments?:string[], exts?:string[]}} [options]
 * @returns {{at:string, root:string, files:Object<string,string>, reason:string}}
 */
function collectSnapshot(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..', '..'));
  const dirs = options.dirs || PROJECT_DIRS;
  const segments = options.excludeSegments || EXCLUDE_SEGMENTS;
  const exts = options.exts || TEXT_EXTS;
  const files = {};
  const reason = [];
  const collected = [];
  for (const d of dirs) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) { reason.push(`缺目录 ${d}/`); continue; }
    walk(abs, root, collected, segments);
  }
  for (const { full, rel } of collected) {
    if (!isTextFile(rel, exts)) continue;
    files[rel] = hashFile(full);
  }
  const snapshot = {
    at: new Date().toISOString(), root: toPosix(root), files, reason: reason.join('；')
  };
  /* 采集是否可用：**只**看"有没有出错"。走完清单且一个文本文件都没有、也没有任何错误时，
     视为"这棵树确实空"（任务已交付即已删除也走这条分支），返回 true —— 因为**两份都空**
     无法当成"有文件被写入"的证据；而"基线空、结束时冒出一堆"会被 diffSnapshots 判成 added。 */
  snapshot.collected = reason.length === 0;
  return snapshot;
}

/**
 * 比对两份快照，输出**被改写的文件**（纯函数，不碰文件系统）—— 供 `harness-check` 真值表断言。
 *
 * 判据（三种都算"改写"）：
 *   · `added`   本轮出现、上轮没有（新增文件／新建目录里的文件）
 *   · `removed` 上轮有、本轮没有了
 *   · `changed` 两轮都有但哈希不同（内容变化）
 * 边界：任一入参缺失/不是对象/没有 `files` 字段 → 返回 `[]`（**不抛错**）。
 *   **注意**：这时返回空数组**不等于**"稳定" —— 意思是"这份比对拿不出结论"，由调用方按
 *   "快照不可用"另行处理（门禁里的做法：不比对权威数字、结论标记为不可作证据）。
 *   之所以不把 `null` 当成"空清单"参与比对，是因为那样会让"基线整个缺失"被读成
 *   "清单里所有文件都是本轮新增"，报出一屏假改写。
 * 排序：按路径字典序，保证同一输入永远给同一份清单（判据要可复现，不能靠遍历顺序）。
 *
 * @param {{files?:Object<string,string>}|null} before 运行开始的快照
 * @param {{files?:Object<string,string>}|null} after  运行结束的快照
 * @returns {Array<{path:string, kind:'added'|'removed'|'changed', before:string|null, after:string|null}>}
 */
function diffSnapshots(before, after) {
  if (!before || typeof before !== 'object' || !before.files || typeof before.files !== 'object') return [];
  if (!after || typeof after !== 'object' || !after.files || typeof after.files !== 'object') return [];
  const a = before.files;
  const b = after.files;
  const changes = [];
  for (const p of Object.keys(a)) {
    if (!Object.prototype.hasOwnProperty.call(b, p)) {
      changes.push({ path: p, kind: 'removed', before: a[p], after: null });
    } else if (a[p] !== b[p]) {
      changes.push({ path: p, kind: 'changed', before: a[p], after: b[p] });
    }
  }
  for (const p of Object.keys(b)) {
    if (!Object.prototype.hasOwnProperty.call(a, p)) {
      changes.push({ path: p, kind: 'added', before: null, after: b[p] });
    }
  }
  return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** 改写清单 → 路径数组（调用方只需"哪几个文件"时用） */
function changedPaths(changes) {
  return (Array.isArray(changes) ? changes : []).map(c => c && c.path).filter(Boolean);
}

/** 快照是否"可用"（采集无错）：null/缺字段一律 false —— "拿不到证据"不算稳定 */
function snapshotOk(snap) {
  return Boolean(snap) && snap.collected === true;
}

const KIND_LABEL = Object.freeze({ added: '新增', removed: '删除', changed: '内容变化' });

/** 改写清单 → 人读短句（横幅里那条 `路径（内容变化）` 就是它） */
function describeChange(change) {
  const label = KIND_LABEL[change && change.kind] || String((change && change.kind) || '变化');
  return `${(change && change.path) || '(未知路径)'}（${label}）`;
}

module.exports = {
  PROJECT_DIRS,
  EXCLUDE_SEGMENTS,
  TEXT_EXTS,
  toPosix,
  isExcluded,
  isTextFile,
  hashFile,
  collectSnapshot,
  diffSnapshots,
  changedPaths,
  snapshotOk,
  describeChange
};
