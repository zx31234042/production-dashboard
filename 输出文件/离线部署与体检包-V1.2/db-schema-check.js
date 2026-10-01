/* 库结构核查（只读）—— 技术债 E71 / E73 的现场核实工具（离线、零依赖、node:sqlite）
 *
 * 查什么：每个看板库文件（board.db / *.sqlite）里，"后来加给既有表"的那几列到底在不在：
 *   ① measure_rt.unit_index      —— E71：FR-4.2「开工数按件计」依赖它
 *   ② upload_log.fail_reason     —— E73：MES 补传队列写入依赖它
 *   ③ upload_log.updated_at      —— E73：同上
 *
 * 判读（关键：缺列 ≠ 数据丢失）：
 *   [OK]   列齐 ⇒ 无需动作。
 *   [缺列] 该库缺列 ⇒ **只要用"修复后的构建"启动一次看板服务就会自动补上**（initSchema() 会
 *          无条件逐条执行迁移步骤；既有行零回填，不丢数据、不改既有列）。
 *          其中"结构版本 = 6 且缺列"＝ E73 的本体形态（曾被修复前的代码升到 6）。
 *   [SKIP] 打不开（正被服务独占、或不是 SQLite）⇒ 记下来人工看，别当通过。
 *
 * 闭环（三步）：① 本工具扫出基线（缺列清单）→ ② 部署修复后的构建、在每个库所在机器**启动一次**
 *   看板服务 → ③ 复查本工具，末行必须为「缺列 0」。这就是"环境待确认项"的结案证据。
 *   注意：**恢复旧备份后，也要启动一次**，否则等于恢复到缺列状态。
 *
 * 安全：全部以 { readOnly: true } 打开 —— 不建 journal、不写库、不改系统；唯一的写动作是把
 *   这次的报告文本写进 ._env-report\（可用 --no-report 关掉）。要零风险可先复制一份库再扫。
 *
 * 用法（现场只需双击 体检-库结构核查.cmd；以下是等价命令行）：
 *   node db-schema-check.js                     // 自动找：本目录、上一级、桌面/文档、各盘一级子目录
 *   node db-schema-check.js "D:\看板"           // 指定看板程序目录（递归找 data\**\*.db 与 backup\**）
 *   node db-schema-check.js "D:\看板\data\prod\board.db"   // 也可直接指定单个库文件
 *   选项：--report-dir <目录>（默认本目录下 ._env-report\）｜--no-report（只打印，不落文件）
 *   --no-auto（不用自动候选，只用命令行给的路径）
 *
 * 退出码：0 = 无缺列；1 = 有缺列（需按上面闭环处理）；2 = 用法/环境错误。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('[FATAL] 本 Node 没有 node:sqlite（需要 Node 22.5+/24）：' + e.message);
  process.exit(2);
}

const NEED = {
  upload_log: ['fail_reason', 'updated_at'],
  measure_rt: ['unit_index']
};
const SKIP_DIRS = new Set(['node_modules', '.git', '._node', '._edge', '._env-report',
  'Windows', 'WinSxS', '$Recycle.Bin', 'System Volume Information', 'AppData', 'Program Files', 'Program Files (x86)']);

const argv = process.argv.slice(2);
const targets = [];
let reportDir = path.join(__dirname, '._env-report');
let writeReport = true;
let auto = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--report-dir') { reportDir = argv[++i]; continue; }
  if (a === '--no-report') { writeReport = false; continue; }
  if (a === '--no-auto') { auto = false; continue; }
  if (a === '-h' || a === '--help') {
    console.log('用法：node db-schema-check.js [路径...] [--report-dir <目录>] [--no-report] [--no-auto]');
    process.exit(0);
  }
  targets.push(a);
}

/* ---------- 收集要扫的根 ---------- */
function autoRoots() {
  const c = [__dirname, path.dirname(__dirname),
    path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Documents')];
  for (const d of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
    const root = d + ':\\';
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('$')) continue;
      c.push(path.join(root, e.name));
    }
  }
  return c;
}

/* ---------- 递归找库文件（有界） ---------- */
function collect(root, out, depth) {
  let st;
  try { st = fs.statSync(root); } catch { return; }
  if (st.isFile()) { if (/\.(db|sqlite|sqlite3)$/i.test(root)) out.push(root); return; }
  if (!st.isDirectory() || depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (SKIP_DIRS.has(e.name) || e.name.startsWith('$')) continue; collect(path.join(root, e.name), out, depth + 1); }
    else if (/\.(db|sqlite|sqlite3)$/i.test(e.name)) out.push(path.join(root, e.name));
  }
}

const roots = targets.length ? targets : (auto ? autoRoots() : []);
if (roots.length === 0) { console.error('[FATAL] 没有可扫的路径。请把看板程序目录作为参数传入。'); process.exit(2); }
const files = [];
for (const r of roots) collect(r, files, 0);
const uniq = [...new Set(files.map(f => path.resolve(f)))].sort();

/* ---------- 逐个库只读检查 ---------- */
const L = [];
const W = s => { L.push(String(s)); console.log(String(s)); };
W('库结构核查报告（只读；技术债 E71/E73 的现场核实）');
W('生成时间  ：' + new Date().toLocaleString('zh-CN', { hour12: false }));
W('主机名    ：' + os.hostname() + '    用户：' + (os.userInfo().username || '-'));
W('Node      ：' + process.version + '    ' + process.execPath);
W('工具位置  ：' + __filename);
W('扫描范围  ：' + roots.join(' ｜ '));
W('命中库文件：' + uniq.length + ' 个');
W('检查列    ：' + Object.entries(NEED).map(([t, c]) => `${t}(${c.join('/')})`).join('、'));
W('');

let missing = 0, ok = 0, skipped = 0;
const bad = [];
for (const f of uniq) {
  let db;
  try { db = new DatabaseSync(f, { readOnly: true }); }
  catch (e) { skipped++; W(`[SKIP] ${f}`); W('        打不开（可能正被服务独占或不是 SQLite）：' + e.message); W(''); continue; }
  const q = sql => { try { return db.prepare(sql).all(); } catch { return null; } };
  const verRow = q("SELECT value FROM schema_meta WHERE key='schema_version'");
  const ver = verRow && verRow[0] ? verRow[0].value : '(无 schema_meta)';
  const miss = [];
  const have = {};
  for (const [t, cols] of Object.entries(NEED)) {
    const info = q(`PRAGMA table_info(${t})`);
    if (!info) { miss.push(`${t}:表不存在`); continue; }
    const names = new Set(info.map(c => c.name));
    have[t] = names;
    for (const c of cols) if (!names.has(c)) miss.push(`${t}.${c}`);
  }
  const pend = q("SELECT COUNT(*) AS n FROM upload_log WHERE state='待补传'");
  const kind = /[\\/]backup[\\/]/i.test(f) ? '备份库' : (/data[\\/]/i.test(f) ? '数据目录库' : '其它位置');
  if (miss.length) {
    missing++;
    bad.push({ f, ver, miss: miss.join(', '), pend: pend ? pend[0].n : '-' });
    W(`[缺列] ${f}`);
    W(`        结构版本=${ver}  类型=${kind}  待补传行=${pend ? pend[0].n : '-'}`);
    W(`        缺：${miss.join(', ')}`);
    W(`        处置：用修复后的构建启动一次看板服务即可补上（既有行零回填）；然后**复查应归零**`);
  } else {
    ok++;
    W(`[OK]   ${f}`);
    W(`        结构版本=${ver}  类型=${kind}  待补传行=${pend ? pend[0].n : '-'}`);
  }
  W('');
  try { db.close(); } catch { }
}
W('===== 汇总 =====');
W(`扫描 ${uniq.length} 个库文件：列齐 ${ok} 个，缺列 ${missing} 个，打不开 ${skipped} 个（**期望 缺列 0**，本轮实测 ${missing}）`);
if (missing) {
  W('');
  W('缺列清单（带回开发机即可按此登记并追踪）：');
  for (const b of bad) W(`  · ${b.f}   结构版本=${b.ver}   缺=${b.miss}   待补传行=${b.pend}`);
}
W('');
W('提醒：缺列不等于数据丢失；恢复旧备份后也必须启动一次服务。本工具只读，不改任何库。');

/* ---------- 落报告（UTF-8 带 BOM，记事本可直接看） ---------- */
if (writeReport) {
  try {
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    const ts = new Date();
    const p2 = n => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${p2(ts.getMonth() + 1)}${p2(ts.getDate())}-${p2(ts.getHours())}${p2(ts.getMinutes())}${p2(ts.getSeconds())}`;
    const out = path.join(reportDir, `库结构核查报告-${os.hostname()}-${stamp}.txt`);
    fs.writeFileSync(out, '\uFEFF' + L.join('\r\n') + '\r\n', 'utf8');
    console.log('\n报告已落盘：' + out);
  } catch (e) {
    console.error('[WARN] 报告写不进去：' + e.message + '（结果仍已打印在上面）');
  }
}
process.exit(missing ? 1 : 0);
