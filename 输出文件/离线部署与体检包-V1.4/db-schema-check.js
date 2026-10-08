/* 库结构核查（只读）—— 现场核实工具（离线、零依赖、node:sqlite）
 * 技术债：E71（measure_rt.unit_index）／E73（upload_log.fail_reason、updated_at）
 *         ／E201（**检查面落后于** server\db\index.js 的 STRUCTURE_UPGRADES）
 *
 * 查什么：每个看板库文件（board.db / *.sqlite）里，"后来加给既有表"的结构到底在不在。
 *   检查面 ＝ 现行迁移清单 `server\db\index.js` 的 `STRUCTURE_UPGRADES` **全量**
 *   （2026-10-07 按 `E201` 逐条对照后补齐；此前只查 3 列、且**一个索引都不查**）：
 *     【列面 7 列】**顺序＝ `STRUCTURE_UPGRADES` 里的出现顺序**（逐列对得上，便于人眼对账）
 *       ① op_log.team_code         —— DR-12（V1.33）班组留痕
 *       ② measure_rt.unit_index    —— E71／DR-04 件序号（FR-4.2「开工数按件计」依赖它）
 *       ③ measure_rt.camera_depth  —— E28（2026-10-07）相机自身水下深度（IF-C.9 P0：
 *                                     与 measure_depth 语义不同、显示与上报均须严格区分）
 *       ④ upload_log.fail_reason   —— E73 MES 补传队列写入依赖它
 *       ⑤ upload_log.updated_at    —— E73 同上
 *       ⑥ shift_stat.run_sec_day1  —— E83 自然日投影（FR-6.4/6.5/6.6 跨零点切段）
 *       ⑦ shift_stat.run_sec_day2  —— E83 同上
 *     【索引面 2 个】
 *       ⑦ ix_op_log_team             ON op_log(team_code, op_time)
 *       ⑧ ix_measure_rt_collect_time ON measure_rt(collect_time) —— E170
 *   ⚠ **覆盖面口径（E201 的教训）**：**少查一项 ⇒ 本工具会对老库给出一个看起来正常的 `[OK]`**
 *     —— 正是 E71／E73／E201 要消灭的形态。故检查面**必须等于** `STRUCTURE_UPGRADES`：
 *     ① `--self-test` 把 9 项**逐一摘掉**各跑一遍（每项都必须**红并指名**；不摘 ⇒ 绿）；
 *     ② 正常跑时若能在本机定位到仓库，会把 `STRUCTURE_UPGRADES` 的步骤**逐条解析**出来与检查面
 *        对账（不一致 ⇒ 报告里显式打「覆盖面不一致」并逐项指名；`--self-test` 下判红）；
 *     ③ `--self-test` 再跑两行「**判别可证伪**」：拿一个**真库**与一个**非本产品库**各走一次
 *        真实判别路径（`isProductDb()` ＋ `judgeDatabase()`）⇒ 读数必须分别是"本产品库、进列面核查"
 *        与"非本产品库，跳过"，即**证明新增的"是否本产品库"判别不是恒真／恒假式**。
 *   ⚠ **覆盖面自证现在没钉死清单，但也还没做到"永远自动跟上"**（`E210-①` 实测，如实声明）：
 *     `NEED` 仍是**本文件里的一份硬编码清单**，`STRUCTURE_UPGRADES` 的唯一真源在
 *     `server\db\index.js`；本工具的判据是"**拿真源来对账**"（上方 ②），**不是**"清单自动生成"。
 *     · **能自动跟上的一半**：单项清单（`SYNTH_ITEMS`）、合成库的表／索引（`SYNTH_TABLES`／
 *       `SYNTH_INDEXES`）与自证行数**全部由 `NEED` 现推** ⇒ 不会再出现"`NEED` 加了、自证没加"
 *       这种**静默失明**（旧版 `SYNTH_ITEMS` 与 `NEED` 是两份手抄清单，两处都能单独落后）。
 *     · **不能自动跟上的那一半（＝长期义务）**：`NEED` 本身要**人**去补。`server\db\index.js`
 *       每加一条迁移步骤 ⇒ **必须同批**把对应项写进 `NEED`（否则 ② 会红并逐条指名 —— 这是
 *       fail-closed，不会静默放过）；**并且 ② 只在"能定位到仓库"时才跑得起来**：现场包里**没有**
 *       `server\db\index.js` ⇒ 现场那份报告会如实打「**未对账**」而**不是**「一致」。
 *     · **故本工具的长期做法有两条，缺一不可**：㈠**定位到仓库时**（开发机／带仓库的现场）靠 ②
 *       机器对账；㈡**定位不到时**（裸包现场）按**"每轮人工复核"**：出包前后各跑一次
 *       `--self-test`（②＋③ 两行都在 `[PASS]`）—— **出包前必须为 `一致`**，否则这一包不许发。
 *
 * 判读（**列面与索引面不是同一严重度 —— 措辞必须分开**，`E201` 明令）：
 *   [OK]     列齐 且 索引齐 ⇒ 无需动作。
 *   [缺列]   该库缺列 ⇒ **只要用"修复后的构建"启动一次看板服务就会自动补上**（`initSchema()`
 *            会无条件逐条执行 `STRUCTURE_UPGRADES`；既有行零回填，不丢数据、不改既有列）。
 *            ⇒ **结案口径：复查必须为「缺列 0」**。
 *            ⚠ **"缺列 N 项"只对"本产品库"报**（下方 `[跳过]` 那一档）：现场若看到某个库被报缺列，
 *            先按本工具读出的**项名**逐条对（**项名现报，不写死数字**），**别把它当成"我们的库全缺"**。
 *   [缺索引] **不影响正确性** —— 只影响"按该列取范围"那类查询的扫描成本（无该索引时走全表扫，
 *            `EXPLAIN QUERY PLAN` ＝ `SCAN <表>`）。同一次服务启动也会把它补上
 *            （`CREATE INDEX IF NOT EXISTS`）；**但它不构成结案闸门**，与缺列**不是**同一档。
 *   [索引形态不符] 索引**名字在、列集不符** ⇒ 判据按"**名字 ＋ 列集**"双核
 *            （只认名字会漏掉"被人改过形"的索引）。
 *   [SKIP]   打不开（正被服务独占、或是坏文件）⇒ 记下来人工看，**别当通过**。
 *   [跳过]   **非本产品库**（`E210-②`）⇒ 报告为「非本产品库，跳过」，**不按缺列报**。
 *            判别（**与"打不开"是两回事**）：该文件是**结构完好的 SQLite**，但既没有 `schema_meta`、
 *            也没有 `measure_rt`／`upload_log` 两张本产品业务表 ⇒ 它**不是看板的库**，缺不缺列
 *            与看板无关。**触发＝现场实测的假读数**：`C:\ProgramData\USOPrivate\UpdateStore\store.db`
 *            （Windows 更新存储库）曾被按「**缺列 6 项**」报出 ⇒ 现场会以为"是我们的库缺列"。
 *            **跳过 ≠ 通过**：它既不计入"列齐"，也不计入"缺列"，汇总里**单列一行**且明细逐条可查。
 *            与"判别可证伪"配套：`--self-test` 拿一个真库与一个非本产品库各跑一次（读数必须相反）。
 *
 * 版本口径：库里的结构版本一律**从 `schema_meta.schema_version` 现读**（本文件**不写死**任何
 *   版本串）；能定位到仓库时再打印"现行"值及其出处（`server\db\index.js` 的 `SCHEMA_VERSION`）
 *   供对照。若"库里＝现行"却仍缺列 ⇒ 报告会点明这是**升级报成功但结构没落地**的本体形态
 *   （`E71`／`E73`／`E201` 同形），不靠写死"= 6"来判断。
 *
 * 结案闭环（三步）：① 本工具扫出基线（缺列／缺索引清单）→ ② 部署修复后的构建、在每个库所在
 *   机器**启动一次**看板服务 → ③ 复查本工具：**列面末行必须为「缺列 0」**（索引面同批复查）。
 *   注意：**恢复旧备份后，也要启动一次**，否则等于恢复到缺列状态。
 *
 * 安全：真实库**全部**以 `{ readOnly: true }` 打开 —— 不建 journal、不写库、不改系统；唯一的写
 *   动作是把这次的报告文本写进 `._env-report\`（可用 `--no-report` 关掉）。`--self-test` 用的是
 *   **纯内存库**（`:memory:`），不落任何文件。要零风险可先复制一份库再扫。
 *
 * 用法（现场只需双击 `体检-库结构核查.cmd`；以下是等价命令行）：
 *   node db-schema-check.js                     // 自动找：本目录、上一级、桌面/文档、各盘一级子目录
 *   node db-schema-check.js "D:\看板"           // 指定看板程序目录（递归找 data\**\*.db 与 backup\**）
 *   node db-schema-check.js "D:\看板\data\prod\board.db"   // 也可直接指定单个库文件
 *   node db-schema-check.js --self-test         // **自证**：9 项逐一摘掉（内存库）＋ 覆盖面对账 ＋ 判别可证伪
 *   选项：--report-dir <目录>（默认本目录下 ._env-report\）｜--no-report（只打印，不落文件）
 *         --no-auto（不用自动候选，只用命令行给的路径）
 *
 * 退出码（**本工具自己的契约**）：0 = 列齐且索引齐；1 = 有缺列（**结案口径未闭合**）；
 *   2 = 用法/环境错误；4 = 列齐、仅索引面差异（**结案口径已闭合**，性能面待登记）。
 *   ⚠ 刻意**不用 3**：本仓 `tests\` 的退出码契约里 3 ＝"本环境跑不了（整脚本跳过）"，
 *   借用它会让"缺索引"被读成"跳过"（规范 `9.5-5`）。`--self-test`：0 = 全部自证通过；1 = 有失败。
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

/* ---------- 检查面：＝ server\db\index.js 的 STRUCTURE_UPGRADES 全量（唯一真源在那里） ----------
 * ⚠ **性质声明（`E210` 要求说清，不许含糊）**：`NEED` 是**本文件里的一份硬编码清单** ——
 *   · 它**不是**从 `STRUCTURE_UPGRADES` **生成**的（本工具零依赖、且现场包里没有仓库源码，
 *     生成不成立）；它靠 `compareCoverage()` **拿真源来对账**（不一致 ⇒ 红并逐项指名）。
 *   · 因此"检查面跟得上现行清单"靠的是**两条**：㈠`--self-test`／正常跑的**机器对账**（能定位到
 *     仓库时）；㈡**人工义务** —— `STRUCTURE_UPGRADES` 每加一步，**同批**在 `NEED` 补一项。
 *   · 单项清单、合成库、自证行数**全部从 `NEED` 现推**（见下方 `synthItems()`），故"加了 `NEED`
 *     却忘了加自证"这种静默失明已不可能发生；剩下唯一的落后形态由对账当场指名。
 * `depends`：该列缺失时**连带建不出来**的索引名（合成库与自证用；`judgeDatabase` 不读它）。
 */
const NEED_COLUMNS = [
  { table: 'op_log', column: 'team_code', debt: 'DR-12（V1.33）', depends: ['ix_op_log_team'] },
  { table: 'measure_rt', column: 'unit_index', debt: 'E71／DR-04' },
  /* `E28`（2026-10-07 才进 `STRUCTURE_UPGRADES`）：相机自身水下深度，与 `measure_depth`
     （航行器水下深度）语义不同（`IF-C.9` P0）。⚠ `E210-①` 的根因就是这一项 —— 包做得比仓库早一步，
     于是本工具**不查它**、却对老库照打 `[OK]`。它与 `unit_index` **不是同一件事**：不得合并、不得互推。 */
  { table: 'measure_rt', column: 'camera_depth', debt: 'E28' },
  { table: 'upload_log', column: 'fail_reason', debt: 'E73' },
  { table: 'upload_log', column: 'updated_at', debt: 'E73' },
  { table: 'shift_stat', column: 'run_sec_day1', debt: 'E83' },
  { table: 'shift_stat', column: 'run_sec_day2', debt: 'E83' }
];
const NEED_INDEXES = [
  { name: 'ix_op_log_team', table: 'op_log', columns: ['team_code', 'op_time'], debt: 'DR-12' },
  { name: 'ix_measure_rt_collect_time', table: 'measure_rt', columns: ['collect_time'], debt: 'E170' }
];
const NEED = { columns: NEED_COLUMNS, indexes: NEED_INDEXES };
const SKIP_DIRS = new Set(['node_modules', '.git', '._node', '._edge', '._env-report',
  'Windows', 'WinSxS', '$Recycle.Bin', 'System Volume Information', 'AppData', 'Program Files', 'Program Files (x86)']);

const colKey = (t, c) => String(t).toLowerCase() + '.' + String(c).toLowerCase();
const csvL = arr => arr.map(x => String(x).toLowerCase()).join(',');

/* ==========================================================================
   零、**"是否本产品库"判别**（`E210-②`，纯函数：同样只喂 reader）
   --------------------------------------------------------------------------
   **为什么要有这一步**：旧版对"凡是叫 `*.db` 的文件"都按本产品的检查面判，于是把
   `C:\ProgramData\USOPrivate\UpdateStore\store.db`（Windows 更新存储库，连 `schema_meta` 都没有）
   读成"**我们的库缺列 6 项**" ⇒ 现场会以为是我们库的问题（与 `E205` 同族：取数面过宽 ⇒ 误导性读数）。
   **判据**（全仓既有口径，不新造）：该文件是**结构完好的 SQLite**，且满足下面任一条即"本产品库" ——
     ① 有 `schema_meta` 表（本产品每个库都由 `initSchema()` 写它）；或
     ② 有 `measure_rt` 表；或 ③ 有 `upload_log` 表。
   **三条都不满足 ⇒ 判「非本产品库，跳过」**：不按缺列报、不计入"列齐"、**汇总里单列一行**。
   ⚠ 别把判别写成"有 `schema_meta` 才算"：
     旧库／半迁移库可能整表缺失，只认它会把真库误判成"非本产品库"（滑向"跳过＝静默放过"）。
   ⚠ 与"打不开"分开：坏文件 / 非 SQLite 文件走 `[SKIP]`（打不开），**不进**本判别的"跳过"计数。
   ========================================================================== */
/**
 * @param {{hasTable:(t:string)=>?boolean, hasAnySchema:()=>?boolean}} reader
 * @returns {{judged:boolean, product:boolean, why:string}}
 *   `judged:false` ⇒ **判不出来**（文件里连 `sqlite_master` 都读不出来）⇒ 调用方按"打不开/坏文件"处置。
 */
function isProductDb(reader, hints) {
  const h = hints || {};
  const names = (h.tables || ['schema_meta', 'measure_rt', 'upload_log']).slice();
  const anySchema = reader.hasAnySchema();
  if (anySchema === null) return { judged: false, product: false, why: '读不出 sqlite_master（坏文件或不是 SQLite）' };
  const found = [];
  for (const n of names) { if (reader.hasTable(n) === true) found.push(n); }
  if (found.length) {
    return { judged: true, product: true, why: '命中本产品表：' + found.join('、') };
  }
  return {
    judged: true, product: false,
    why: '无 ' + names.join('／') + ' 中任何一张（' + (anySchema ? '该文件有表，但不是看板的表' : '该文件里一张表都没有') + '）'
  };
}

/* ==========================================================================
   一、判定本体（**纯函数**：只喂 reader，不碰文件系统 —— 故可在合成样本上定点变异，D22）
   ========================================================================== */
/**
 * @param {{columnsOf:(t:string)=>?string[], indexListOf:(t:string)=>?Array<{name:string}>,
 *          indexColumnsOf:(n:string)=>?string[]}} reader
 * @param {{columns:Array<object>, indexes:Array<object>}} [needs]
 * @returns {{missingColumns:Array, missingIndexes:Array, wrongIndexes:Array}}
 */
function judgeDatabase(reader, needs) {
  const need = needs || NEED;
  const missingColumns = [];
  const missingIndexes = [];
  const wrongIndexes = [];
  const absentTables = new Set();
  for (const n of need.columns) {
    const cols = reader.columnsOf(n.table);
    if (!cols) { absentTables.add(n.table); missingColumns.push(Object.assign({}, n, { why: '表不存在' })); continue; }
    if (!cols.includes(n.column)) missingColumns.push(Object.assign({}, n, { why: '缺列' }));
  }
  for (const n of need.indexes) {
    if (absentTables.has(n.table)) { missingIndexes.push(Object.assign({}, n, { why: '表不存在' })); continue; }
    const list = reader.indexListOf(n.table);
    if (!list) { missingIndexes.push(Object.assign({}, n, { why: '表不存在' })); continue; }
    if (!list.some(i => i.name === n.name)) { missingIndexes.push(Object.assign({}, n, { why: '缺索引' })); continue; }
    const got = reader.indexColumnsOf(n.name) || [];
    if (csvL(got) !== csvL(n.columns)) wrongIndexes.push(Object.assign({}, n, { got }));
  }
  return { missingColumns, missingIndexes, wrongIndexes };
}

/** 退出码口径（**唯一一份**）：缺列 ⇒ 1；只余索引面差异 ⇒ 4；全齐 ⇒ 0 */
function verdictOf(j) {
  if (j.missingColumns.length) return 1;
  if (j.missingIndexes.length || j.wrongIndexes.length) return 4;
  return 0;
}

/** 逐库结论的**措辞**（列面／索引面分开；两处共用一份，口径不会分叉） */
const WORDING = Object.freeze({
  columnFix: '列面处置：用**修复后的构建**启动一次看板服务即可补上（initSchema() 无条件逐条执行迁移；既有行零回填）'
    + '；**结案口径＝复查列面必须「缺列 0」**（非本产品库跳过；跳过 ≠ 通过）',
  indexNote: '索引面说明：**缺索引不影响正确性**，只影响"按该列取范围"那类查询的扫描成本（无索引时走全表扫）'
    + '；同一次服务启动也会补上（CREATE INDEX IF NOT EXISTS）——**它不构成结案闸门**'
});

/* ==========================================================================
   二、覆盖面自证（E201 的正面判据：检查面 ↔ 现行迁移清单，双向对账）
   ========================================================================== */
/** 剥注释（只用于"读步骤清单"：注释里的示例 DDL 与 `schema_version='2'` 之类的引号串不能当步骤） */
function stripComments(code) {
  return String(code).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * 从 `server\db\index.js` 的源码里取出 `STRUCTURE_UPGRADES` 数组的**字符串字面量**（＝迁移步骤）。
 * 解析不出来 ⇒ `ok:false`（fail-closed：宁可判"读不出"，也不假装"清单是空的 ⇒ 一致"）。
 * @returns {{ok:boolean, reason?:string, steps?:string[]}}
 */
function parseUpgradeSteps(code) {
  const src = stripComments(code);
  const at = src.indexOf('STRUCTURE_UPGRADES');
  if (at < 0) return { ok: false, reason: '源码里找不到 STRUCTURE_UPGRADES' };
  const open = src.indexOf('[', at);
  const close = open < 0 ? -1 : src.indexOf('\n];', open);
  if (open < 0 || close < 0) return { ok: false, reason: 'STRUCTURE_UPGRADES 数组的起止位置没找到' };
  const body = src.slice(open + 1, close);
  const steps = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) steps.push(m[1].replace(/\\'/g, "'"));
  return { ok: true, steps };
}

/** 步骤分类：只认白名单里的两种形态（与 server\db\index.js 的 UPGRADE_STEP_FORMS 同源） */
function classifySteps(steps) {
  const columns = [];
  const indexes = [];
  const other = [];
  for (const raw of steps) {
    const s = String(raw).trim();
    let m = /^ALTER\s+TABLE\s+([A-Za-z_]\w*)\s+ADD\s+COLUMN\s+([A-Za-z_]\w*)/i.exec(s);
    if (m) { columns.push({ table: m[1], column: m[2] }); continue; }
    m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_]\w*)\s+ON\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/i.exec(s);
    if (m) {
      indexes.push({
        name: m[1], table: m[2],
        columns: m[3].split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean)
      });
      continue;
    }
    other.push(s);
  }
  return { columns, indexes, other };
}

/**
 * 检查面 ↔ 现行清单**双向**对账（多一项／少一项／索引列集不符 ⇒ 逐条指名）。
 * @returns {{problems:string[], live:object}}
 */
function compareCoverage(steps, needs) {
  const need = needs || NEED;
  const live = classifySteps(steps);
  const problems = [];
  if (live.other.length) {
    problems.push('现行清单里有 ' + live.other.length + ' 条步骤无法归类（形态不在已知两种内）：'
      + live.other.slice(0, 3).join(' ／ '));
  }
  const mineC = new Set(need.columns.map(n => colKey(n.table, n.column)));
  const liveC = new Set(live.columns.map(n => colKey(n.table, n.column)));
  for (const k of liveC) if (!mineC.has(k)) problems.push('现行清单有列 `' + k + '`，**本工具不查它**（E201 的根因形态：检查面落后于清单）');
  for (const k of mineC) if (!liveC.has(k)) problems.push('本工具查列 `' + k + '`，但现行清单里已没有这一步（检查面陈旧）');
  const liveI = new Map(live.indexes.map(n => [String(n.name).toLowerCase(), n]));
  const mineI = new Set(need.indexes.map(n => String(n.name).toLowerCase()));
  for (const [k, v] of liveI) if (!mineI.has(k)) problems.push('现行清单有索引 `' + v.name + '`，**本工具不查它**');
  for (const k of mineI) if (!liveI.has(k)) problems.push('本工具查索引 `' + k + '`，但现行清单里已没有它（检查面陈旧）');
  for (const n of need.indexes) {
    const l = liveI.get(String(n.name).toLowerCase());
    if (l && csvL(l.columns) !== csvL(n.columns)) {
      problems.push('索引 `' + n.name + '` 的列集：现行 [' + l.columns.join(', ')
        + '] ↔ 本工具 [' + n.columns.join(', ') + ']');
    }
  }
  return { problems, live };
}

/** 现行结构版本（`const SCHEMA_VERSION = 'N'`）＋ 它在源码里的行号（供"事实截止点"引用） */
function readSchemaVersion(code) {
  const m = /const\s+SCHEMA_VERSION\s*=\s*'([^']*)'/.exec(String(code));
  if (!m) return null;
  return { value: m[1], line: String(code).slice(0, m.index).split('\n').length };
}

/**
 * 从**本文件自己的注释**里现推仓库根候选（`E210` 实测的坑：包在开发机放在
 * `<仓库>\输出文件\离线部署与体检包-V1.x\`，**比旧候选的深度多一级** ⇒ 旧版连开发机都定位不到）。
 * 认的形态＝注释里那些带 `server\db\index.js` 的**反引号路径**（doc-hint）：
 *   · 开发机把包放在 `<仓库>\输出文件\离线部署与体检包-V1.x\` ⇒ 取它**上面两级**（输出文件 → 仓库根）；
 *   · 其它以 `…\server\db\index.js` 结尾的写法 ⇒ 取它**上面三级**。
 * 为什么用"从注释现推"：它随本文件一起走，**不需要现场改命令行**；⚠ 它**不是**"清单自动生成"
 * —— `NEED` 仍要人补（见头注的长期义务），这里只是把"仓库在哪儿"这个**环境事实**变得可自述。
 * @returns {string[]} 候选目录（去重、只保留盘上真有的）
 */
function repoHintCandidates() {
  const out = [];
  const nrm = p => String(p).replace(/[\/]+/g, '\\');
  const push = p => { if (p && out.indexOf(p) < 0) out.push(p); };
  for (const m of String(fs.readFileSync(__filename, 'utf8')).matchAll(/`([^`]*?server\\db\\index\.js)`/g)) {
    const raw = nrm(m[1]);
    const i = raw.toLowerCase().lastIndexOf('server\\db\\index.js');
    let base = raw.slice(0, i);
    if (/离线部署与体检包-V[\d.]+\\$/i.test(base)) base = base.replace(/离线部署与体检包-V[\d.]+\\$/i, '');
    if (/输出文件\\$/i.test(base)) base = base.replace(/输出文件\\$/i, '');
    push(base.replace(/\\+$/, ''));
  }
  return out.filter(b => { try { return fs.existsSync(b); } catch (e) { return false; } });
}

/**
 * 找仓库里的 `server\db\index.js`（找不到 ⇒ null：**不假装一致**，调用方按"未对账"处理）。
 * 候选顺序（**先近后远**；每一条都是"把该目录当仓库根"来试）：
 *   ①`__dirname`（工具就在仓库根时）与它的**父目录链**（逐级上找，覆盖"包在 `输出文件\` 深处"）；
 *   ②`path.dirname(__dirname)\production-dashboard`（包与仓库**并列**摆放的推荐布局，见 README §1）；
 *   ③`process.cwd()`；④上方每条**命令行给的路径**及其父目录；⑤源码注释里的仓库路径提示（doc-hint）。
 */
function findRepoIndexJs(roots) {
  const cands = [];
  const add = p => { if (p) cands.push(path.join(p, 'server', 'db', 'index.js')); };
  /* ① 本目录 ＋ 沿父目录链逐级上找（深度 4；`<仓库>\输出文件\<包>\` 这种布局要 3 级才够） */
  let cur = __dirname;
  add(cur);
  for (let i = 0; i < 4; i++) {
    const up = path.dirname(cur);
    if (!up || up === cur) break;
    cur = up;
    add(cur);
  }
  /* ② 包与仓库并列（推荐布局：`D:\production-dashboard\` ＋ `D:\离线部署与体检包-V1.x\`） */
  add(path.join(path.dirname(__dirname), 'production-dashboard'));
  /* ③ 当前工作目录 */
  add(process.cwd());
  /* ④ 命令行给的看板目录／库文件路径，及其父目录 */
  for (const r of (roots || []).slice(0, 40)) { add(r); add(path.dirname(r)); }
  /* ⑤ 源码注释里的仓库路径提示（doc-hint；见 `repoHintCandidates()`） */
  for (const h of repoHintCandidates()) add(h);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 逐个试下一个 */ }
  }
  return null;
}

/* ==========================================================================
   三、真实库的 reader（**只读**：调用方以 { readOnly: true } 打开）
   ========================================================================== */
function sqliteReader(db) {
  const q = sql => { try { return db.prepare(sql).all(); } catch (e) { return null; } };
  return {
    /** 表是否**真的存在**：`PRAGMA table_info(<不存在的表>)` 会返回**空集**（不是 null），
        故"表在不在"必须问 sqlite_master，不能拿 `columnsOf()` 反推（那会把空表读成不存在）。 */
    hasTable(name) {
      const r = q("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND lower(name)=lower('" + String(name) + "')");
      return r ? r.length > 0 : null;
    },
    /** 该文件里**有没有任何表**（读不出来 ⇒ null ⇒ 调用方按"坏文件"处置，不按"非本产品库"处置） */
    hasAnySchema() {
      const r = q("SELECT 1 AS ok FROM sqlite_master WHERE type='table'");
      return r ? r.length > 0 : null;
    },
    columnsOf(table) {
      const info = q('PRAGMA table_info(' + table + ')');
      return info ? info.map(c => String(c.name)) : null;
    },
    indexListOf(table) {
      const list = q('PRAGMA index_list(' + table + ')');
      return list ? list.map(r => ({ name: String(r.name), unique: Number(r.unique) === 1, origin: String(r.origin) })) : null;
    },
    indexColumnsOf(name) {
      const info = q('PRAGMA index_info(' + name + ')');
      return info ? info.map(r => String(r.name)) : null;
    },
    run(sql) { const r = q(sql); return r && r[0] ? r[0] : null; }
  };
}

/* ==========================================================================
   四、合成库 + `--self-test`（D22：检查面**逐项摘掉** ⇒ 必红并指名；不摘 ⇒ 绿）
   —— 项数＝`NEED.columns.length + NEED.indexes.length`（**现推**，见 `synthItems()`）。
   --------------------------------------------------------------------------
   · 全部建在**纯内存库**（`:memory:`）上 ⇒ 不落一个文件、不碰任何真实库（现场只读口径不破）；
   · 每个用例从**同一份模板**建库，只摘掉目标项（及其依赖的索引）⇒ "摘掉哪一项"是唯一变量。
   ========================================================================== */
/* ⚠ **下面三份"合成库清单"全部从 `NEED` 现推**（`E210` 的整改点之一）：旧版把 `SYNTH_TABLES`／
   `SYNTH_INDEXES`／`SYNTH_ITEMS` 与 `NEED` **各写一份**（三处独立列举）⇒ `NEED` 补了一项而这三处
   没跟，`--self-test` 会**照样全绿**，而新那一项**一次也没被摘掉过** —— 与 `E201` 同形的静默失明。
   现在单一真源＝`NEED`：`NEED` 加一项 ⇒ 合成库、逐项摘除自证、行数**同批自动跟上**，无第二处可落后。 */
/** 合成库里"列名 → 列类型"（`judgeDatabase` 只读列名，类型仅为形态真实；缺类型时按 TEXT 兜底） */
const SYNTH_COLUMN_TYPES = { camera_depth: 'REAL', unit_index: 'INTEGER', run_sec_day1: 'INTEGER',
  run_sec_day2: 'INTEGER', collect_time: 'TEXT', op_time: 'TEXT', equip_code: 'TEXT',
  fail_reason: 'TEXT', updated_at: 'TEXT', state: 'TEXT', run_sec: 'INTEGER' };
/** 合成库里非检查项的"陪衬列"（只为让表形态像真库；不进检查面、不被摘除） */
const SYNTH_EXTRA_COLUMNS = { measure_rt: ['equip_code'], upload_log: ['state'],
  shift_stat: ['run_sec'] };   /* `op_time`／`collect_time` 由上面的索引列覆盖，不再重复手抄 */
/** 检查面里的索引：列集与 `depends` 都从 `NEED` 取（**没有手抄副本**） */
const SYNTH_INDEXES = NEED_INDEXES.map(i => ({ name: i.name, table: i.table, columns: i.columns.slice() }));
/** 合成库的建表清单：检查列（来自 `NEED`）＋ 陪衬列；`schema_meta` 供"本产品库"判别与版本现读 */
function synthTables() {
  const byTable = new Map();
  for (const c of NEED_COLUMNS) {
    const arr = byTable.get(c.table) || [];
    arr.push(c.column + ' ' + (SYNTH_COLUMN_TYPES[c.column] || 'TEXT'));
    byTable.set(c.table, arr);
  }
  /* ⚠ **索引列也必须建出来**：`ix_op_log_team` 的第二列是 `op_time`，它不是检查项（不在 `NEED` 里），
     旧版手抄清单把它写死在 `SYNTH_TABLES` 里；改成"从 `NEED` 现推"后必须**显式把索引覆盖的列也建上**，
     否则 `CREATE INDEX` 会撞 `no such column: op_time`（本轮实测踩到）。 */
  for (const ix of SYNTH_INDEXES) {
    const arr = byTable.get(ix.table) || [];
    for (const c of ix.columns) if (!arr.some(x => x.split(' ')[0] === c)) arr.push(c + ' ' + (SYNTH_COLUMN_TYPES[c] || 'TEXT'));
    byTable.set(ix.table, arr);
  }
  for (const [t, extra] of Object.entries(SYNTH_EXTRA_COLUMNS)) {
    const arr = byTable.get(t) || [];
    for (const c of extra) if (!arr.some(x => x.split(' ')[0] === c)) arr.push(c + ' ' + (SYNTH_COLUMN_TYPES[c] || 'TEXT'));
    byTable.set(t, arr);
  }
  for (const t of Object.keys(SYNTH_EXTRA_COLUMNS)) if (!byTable.has(t)) byTable.set(t, []);
  /* `schema_meta` **永远在**：它由 `initSchema()` 写（`SCHEMA_VERSION` ＋ 指纹），不是"后来补的列"，
     故**不属检查面、也不参与逐项摘除**；自证里每个内存库都要有它（否则连版本都读不出来）。 */
  byTable.set('schema_meta', ['key TEXT PRIMARY KEY', 'value TEXT']);
  return [...byTable.entries()].map(([name, cols]) => ({ name, columns: cols }));
}
/** 9 个"应查项"（＝检查面的逐项展开）——**由 `NEED` 现推**，加一项即自动多一行自证 */
function synthItems() {
  return NEED_COLUMNS.filter(c => c.index !== false).map(c => ({
    key: colKey(c.table, c.column), kind: 'column', table: c.table, name: c.column, depends: c.depends || []
  })).concat(NEED_INDEXES.map(i => ({
    key: i.name, kind: 'index', table: i.table, name: i.name, depends: []
  })));
}

/** 建一份合成库（`omit` ＝ 要摘掉的项 key 集合）；返回 reader */
function buildSyntheticReader(omit) {
  const drop = new Set((omit || []).map(x => String(x)));
  const db = new DatabaseSync(':memory:');
  for (const t of synthTables()) {
    const cols = t.columns.filter(c => !drop.has(colKey(t.name, c.split(' ')[0])));
    if (!cols.length) continue;                       /* 极端情形：整表列都被摘掉 ⇒ 该表不建 */
    db.exec('CREATE TABLE ' + t.name + ' (' + cols.join(', ') + ')');
  }
  for (const ix of SYNTH_INDEXES) {
    if (drop.has(ix.name)) continue;
    if (ix.columns.some(c => drop.has(colKey(ix.table, c)))) continue;  /* 依赖的列没了 ⇒ 索引建不出来，一并摘掉 */
    db.exec('CREATE INDEX IF NOT EXISTS ' + ix.name + ' ON ' + ix.table + '(' + ix.columns.join(', ') + ')');
  }
  db.exec("INSERT INTO schema_meta(key,value) VALUES('schema_version','8')");
  return { reader: sqliteReader(db), close: () => { try { db.close(); } catch (e) { /* 已关 */ } } };
}

/**
 * 一个**非本产品库**样本（内存库）：形如 `C:\ProgramData\USOPrivate\UpdateStore\store.db`
 * —— **结构完好的 SQLite、有表**，但没有 `schema_meta`、也没有 `measure_rt`／`upload_log`。
 * 它是 `E210-②` 的**负对照**：没做判别时本工具会对它报"缺列 N 项"（误导现场），做了判别则"跳过"。
 * @returns {{reader:object, close:()=>void}}
 */
function buildForeignReader() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE UpdateStore (UpdateID TEXT PRIMARY KEY, RevisionNumber INTEGER, IsHidden INTEGER)');
  db.exec('CREATE TABLE UpdateHistory (UpdateID TEXT, EventType INTEGER, EventTime TEXT)');
  db.exec('CREATE INDEX ix_store_rev ON UpdateStore(RevisionNumber)');
  return { reader: sqliteReader(db), close: () => { try { db.close(); } catch (e) { /* 已关 */ } } };
}

/**
 * `--self-test`：**判据的可证伪性自证**（ADR-0004 D22 在本工具上的落点）。
 * 行数**全部由 `NEED` 现推**，不写死：1 行"自证台账 ↔ 检查面" ＋ 1 行绿基线 ＋ N 行"逐一摘掉"
 * （N ＝ 列数 ＋ 索引数，每行都必须红并指名）＋ 1 行覆盖面对账 ＋ 2 行"判别可证伪"。
 * @returns {{rows:Array<{name:string,pass:boolean,detail:string}>, failed:number}}
 */
function runSelfTest() {
  const rows = [];
  const add = (name, pass, detail) => rows.push({ name, pass: Boolean(pass), detail: String(detail) });
  const synthItemsList = synthItems();          /* 行数与项名**都从 NEED 现推**，不写死 8／9 */
  const DECLARED = NEED.columns.length + NEED.indexes.length;
  add('自证台账 ↔ 检查面（`NEED` 加项而自证没跟 ⇒ 本行当场红）',
    synthItemsList.length === DECLARED,
    '检查面声明 ' + NEED.columns.length + ' 列 ＋ ' + NEED.indexes.length + ' 索引 ＝ ' + DECLARED
    + ' 项 ↔ 逐一摘除自证 ' + synthItemsList.length + ' 项（\u2265 必须相等；少一项＝那一项**从未被摘掉过**）');

  const base = buildSyntheticReader([]);
  const baseJudge = judgeDatabase(base.reader);
  base.close();
  const baseVerdict = verdictOf(baseJudge);
  add('基线：' + DECLARED + ' 项全在（未变异）', baseJudge.missingColumns.length === 0
    && baseJudge.missingIndexes.length === 0 && baseJudge.wrongIndexes.length === 0 && baseVerdict === 0,
    '列面缺 ' + baseJudge.missingColumns.length + '／索引面缺 ' + baseJudge.missingIndexes.length
    + '／形态不符 ' + baseJudge.wrongIndexes.length + ' ⇒ 退出码 ' + baseVerdict + '（期望 0）');

  for (const item of synthItemsList) {
    const omit = [item.key].concat(item.depends || []);
    const fx = buildSyntheticReader(omit);
    const j = judgeDatabase(fx.reader);
    fx.close();
    const v = verdictOf(j);
    const namedCols = j.missingColumns.map(x => colKey(x.table, x.column));
    const namedIdx = j.missingIndexes.map(x => x.name);
    let pass;
    let detail;
    if (item.kind === 'column') {
      pass = namedCols.includes(item.key) && v === 1 && j.missingColumns.length > 0;
      detail = '摘掉 `' + omit.join('` ＋ `') + '` ⇒ 列面指名 ' + (namedCols.join('、') || '（无）')
        + '；索引面指名 ' + (namedIdx.join('、') || '（无）') + ' ⇒ 退出码 ' + v + '（期望 1）';
    } else {
      /* 索引档的**分离性**证明：列面必须**照样齐**（否则就不是"只缺索引"这一档） */
      pass = namedIdx.includes(item.key) && v === 4 && j.missingColumns.length === 0;
      detail = '摘掉 `' + item.key + '` ⇒ 索引面指名 ' + (namedIdx.join('、') || '（无）')
        + '；**列面仍齐**（缺列 ' + j.missingColumns.length + '）⇒ 退出码 ' + v + '（期望 4，与缺列分开）';
    }
    add((item.kind === 'column' ? '摘掉列 ' : '摘掉索引 ') + item.key, pass, detail);
  }

  /* 覆盖面自证：需要仓库在场（现场机也拷了整套仓库 ⇒ 通常在场） */
  const indexJs = findRepoIndexJs([]);
  if (!indexJs) {
    add('覆盖面自证（检查面 ↔ 现行迁移清单）', false,
      '[SKIP] 未定位到仓库的 `server\\db\\index.js` ⇒ **无从对账**（跳过不等于通过；请把本工具放回包内/仓库旁再跑）');
    rows[rows.length - 1].skipped = true;
  } else {
    const code = fs.readFileSync(indexJs, 'utf8');
    const parsed = parseUpgradeSteps(code);
    const ver = readSchemaVersion(code);
    if (!parsed.ok) {
      add('覆盖面自证（检查面 ↔ 现行迁移清单）', false, '解析失败：' + parsed.reason + '（出处 ' + indexJs + '）');
    } else {
      const cov = compareCoverage(parsed.steps, NEED);
      add('覆盖面自证（检查面 ↔ 现行迁移清单）', cov.problems.length === 0,
        (cov.problems.length ? '不一致 ' + cov.problems.length + ' 处：' + cov.problems.join('；')
          : '一致：现行清单 ' + cov.live.columns.length + ' 列 ＋ ' + cov.live.indexes.length
            + ' 索引 ＝ 本工具检查面 ' + NEED.columns.length + ' 列 ＋ ' + NEED.indexes.length + ' 索引')
        + '（出处 ' + indexJs + (ver ? '，SCHEMA_VERSION=' + ver.value + ' @' + ver.line + ' 行' : '') + '）');
    }
  }

  /* `E210-②` 的**可证伪自证**：拿一个**真库**与一个**非本产品库**各走一次**真实判别路径**
     （`sqliteReader()` ＋ `isProductDb()` ＋ `judgeDatabase()`，与主流程逐行同源）⇒ 两行读数必须**相反**：
     真库＝"本产品库、进列面核查"，非本产品库＝"非本产品库，跳过"。
     判据若被写成恒真式（例如"永远判 product"）⇒ 第二行当场红；写成恒假 ⇒ 第一行当场红。 */
  {
    const real = buildSyntheticReader([]);            /* 真库：9 项齐 ＋ schema_meta ＋ 业务表 */
    const probe = isProductDb(real.reader);
    const j = judgeDatabase(real.reader);
    real.close();
    add('判别可证伪①：**真库** ⇒ 判本产品库并进列面核查',
      probe.judged && probe.product === true && j.missingColumns.length === 0,
      '判别＝' + (probe.judged ? (probe.product ? '本产品库' : '非本产品库') : '判不出来')
      + '（' + probe.why + '）⇒ 列面缺 ' + j.missingColumns.length + ' 项（期望 0）');
  }
  {
    const foreignDbCount = buildForeignReader();             /* 非本产品库：有表、但没有一张是本产品的表 */
    const probe = isProductDb(foreignDbCount.reader);
    const j = judgeDatabase(foreignDbCount.reader);
    foreignDbCount.close();
    add('判别可证伪②：**非本产品库** ⇒ 判跳过、**不按缺列报**',
      probe.judged && probe.product === false && j.missingColumns.length === NEED.columns.length,
      '判别＝' + (probe.judged ? (probe.product ? '本产品库' : '非本产品库') : '判不出来')
      + '（' + probe.why + '）⇒ 若不做判别会被误报"缺列 ' + j.missingColumns.length + ' 项"（本工具=跳过）');
  }

  const failed = rows.filter(r => !r.pass && !r.skipped).length;
  console.log('===== --self-test：检查面 ' + DECLARED + ' 项逐一摘掉（D22：必红并指名）＋ 覆盖面自证 =====');
  console.log('内存库（:memory:）：不落文件、不碰任何真实库；每行都从同一份模板重建，只摘掉目标项。');
  console.log('检查面 ' + DECLARED + ' 项（' + NEED.columns.length + ' 列 ＋ ' + NEED.indexes.length + ' 索引；行数由 `NEED` 现推）');
  rows.forEach((r, i) => {
    const tag = r.skipped ? '[SKIP]' : (r.pass ? '[PASS]' : '[FAIL]');
    console.log('[' + (i + 1) + '/' + rows.length + '] ' + tag + ' ' + r.name + '\n        ' + r.detail);
  });
  console.log('自证通过 ' + (rows.length - failed - rows.filter(r => r.skipped).length) + '／' + rows.length
    + ' 行，失败 ' + failed + ' 行' + (rows.some(r => r.skipped) ? '，跳过 ' + rows.filter(r => r.skipped).length + ' 行（跳过≠通过）' : ''));
  return { rows, failed };
}

/* ==========================================================================
   五、主流程
   ========================================================================== */
const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('用法：node db-schema-check.js [路径...] [--report-dir <目录>] [--no-report] [--no-auto] [--self-test]');
  console.log('检查面（现行迁移清单全量）：列 ' + NEED_COLUMNS.length + ' 个（'
    + NEED_COLUMNS.map(c => c.table + '.' + c.column).join('、') + '）');
  console.log('                            索引 ' + NEED_INDEXES.length + ' 个（'
    + NEED_INDEXES.map(i => i.name).join('、') + '）');
  console.log('退出码：0 = 列齐且索引齐；1 = 有缺列（结案口径未闭合）；2 = 用法/环境错误；');
  console.log('        4 = 列齐、仅索引面差异（不影响正确性 —— 结案口径**已**闭合）。');
  process.exit(0);
}
if (argv.includes('--self-test')) {
  const r = runSelfTest();
  process.exit(r.failed ? 1 : 0);
}

const targets = [];
let reportDir = path.join(__dirname, '._env-report');
let writeReport = true;
let auto = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--report-dir') { reportDir = argv[++i]; continue; }
  if (a === '--no-report') { writeReport = false; continue; }
  if (a === '--no-auto') { auto = false; continue; }
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
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
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
  try { st = fs.statSync(root); } catch (e) { return; }
  if (st.isFile()) { if (/\.(db|sqlite|sqlite3)$/i.test(root)) out.push(root); return; }
  if (!st.isDirectory() || depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('$')) continue;
      collect(path.join(root, e.name), out, depth + 1);
    } else if (/\.(db|sqlite|sqlite3)$/i.test(e.name)) out.push(path.join(root, e.name));
  }
}

const roots = targets.length ? targets : (auto ? autoRoots() : []);
if (roots.length === 0) { console.error('[FATAL] 没有可扫的路径。请把看板程序目录作为参数传入。'); process.exit(2); }
const files = [];
for (const r of roots) collect(r, files, 0);
const uniq = [...new Set(files.map(f => path.resolve(f)))].sort();

/* ---------- 现行结构版本（能定位到仓库就读；读不到就**明说读不到**，不假装一致） ---------- */
const indexJsPath = findRepoIndexJs(roots);
let currentVer = null;
let coverage = null;
if (indexJsPath) {
  const code = fs.readFileSync(indexJsPath, 'utf8');
  currentVer = readSchemaVersion(code);
  const parsed = parseUpgradeSteps(code);
  coverage = parsed.ok
    ? { ok: true, ...compareCoverage(parsed.steps, NEED) }
    : { ok: false, reason: parsed.reason };
}

/* ---------- 逐个库只读检查 ---------- */
const L = [];
const W = s => { L.push(String(s)); console.log(String(s)); };
W('库结构核查报告（只读；技术债 E71／E73／E201 的现场核实）');
W('生成时间  ：' + new Date().toLocaleString('zh-CN', { hour12: false }));
W('主机名    ：' + os.hostname() + '    用户：' + (os.userInfo().username || '-'));
W('Node      ：' + process.version + '    ' + process.execPath);
W('工具位置  ：' + __filename);
W('扫描范围  ：' + roots.join(' ｜ '));
W('命中库文件：' + uniq.length + ' 个');
W('检查列    ：' + NEED_COLUMNS.map(c => c.table + '.' + c.column + '(' + c.debt + ')').join('、'));
W('检查索引  ：' + NEED_INDEXES.map(i => i.name + '(' + i.table + '(' + i.columns.join(',') + ')，' + i.debt + ')').join('、'));
W('本产品库判别：有 schema_meta ／ measure_rt ／ upload_log 中任一 ⇒ 本产品库（进上面这份检查面）；'
  + '三者皆无 ⇒ **非本产品库，跳过**（**不按缺列报**；跳过 = 单列一行读数，**不等于通过**）');
if (currentVer) {
  W('现行结构版本：' + currentVer.value + '（现读 ' + indexJsPath + ':' + currentVer.line + ' 的 SCHEMA_VERSION；库里的值逐库现读）');
} else {
  W('现行结构版本：**未定位到仓库**的 server\\db\\index.js ⇒ 只报"库里"的值，不与现行比对'
    + '（不假装一致；请对照仓库 server\\db\\index.js 的 SCHEMA_VERSION）');
}
if (coverage && coverage.ok) {
  W('覆盖面自证：检查面 ↔ 现行迁移清单 —— '
    + (coverage.problems.length
      ? '**不一致 ' + coverage.problems.length + ' 处**：' + coverage.problems.join('；')
      : '一致（现行清单 ' + coverage.live.columns.length + ' 列 ＋ ' + coverage.live.indexes.length + ' 索引）'));
} else if (coverage) {
  W('覆盖面自证：**无法判定**（' + coverage.reason + '）—— 不记为通过');
} else {
  W('覆盖面自证：**未对账**（未定位到仓库）—— 不记为通过；要机器自证请跑 --self-test');
}
W('');

let missingCol = 0, missIdx = 0, wrongIdx = 0, ok = 0, skipped = 0;
let foreignDbCount = 0;                                   /* **非本产品库**（`E210-②`）：跳过、不按缺列报 */
const idxBadSet = new Set();
const badCol = [];
const badIdx = [];
const foreignList = [];
for (const f of uniq) {
  let db;
  try { db = new DatabaseSync(f, { readOnly: true }); }
  catch (e) { skipped++; W('[SKIP] ' + f); W('        打不开（可能正被服务独占或不是 SQLite）：' + e.message); W(''); continue; }
  const reader = sqliteReader(db);

  /* ---- `E210-②`：**先判"是不是本产品的库"**，再谈缺列 ----
     不是本产品的库（例如 `C:\ProgramData\USOPrivate\UpdateStore\store.db`）**不按缺列报**：
     它对"看板库缺不缺列"零信息量，报出来只会让现场以为是我们库的问题（`E205` 同族）。
     ⚠ **跳过 ≠ 通过**：它不进 `ok`、不进 `missingCol`，汇总里**单列一行**、明细逐条可查。 */
  const probe = isProductDb(reader);
  if (!probe.judged) {
    skipped++;
    W('[SKIP] ' + f);
    W('        打不开（读不出 sqlite_master ⇒ 坏文件或不是 SQLite）：' + probe.why + '（**别当通过**）');
    W('');
    continue;
  }
  if (!probe.product) {
    foreignDbCount++;
    const kindForeign = /[\/]backup[\/]/i.test(f) ? '备份库' : (/data[\/]/i.test(f) ? '数据目录库' : '其它位置');
    foreignList.push({ f, why: probe.why, kind: kindForeign });
    W('[跳过] ' + f);
    W('        **非本产品库，跳过**（' + probe.why + '；类型=' + kindForeign + '）');
    W('        ⇒ 它与"看板库缺不缺列"无关，**不按缺列报**；**跳过 ≠ 通过**（不计入"列齐"）');
    W('');
    continue;
  }
  const verRow = reader.run("SELECT value FROM schema_meta WHERE key='schema_version'");
  const ver = verRow ? verRow.value : '(无 schema_meta)';
  /* 老库可能整张 `upload_log` 都没有 ⇒ 这一行查询会抛；**它只是附加读数**，不许炸掉整库结论 */
  let pend = null;
  try { pend = reader.run("SELECT COUNT(*) AS n FROM upload_log WHERE state='待补传'"); } catch (e) { pend = null; }
  const kind = /[\\/]backup[\\/]/i.test(f) ? '备份库' : (/data[\\/]/i.test(f) ? '数据目录库' : '其它位置');
  const j = judgeDatabase(reader);
  const v = verdictOf(j);
  const verLine = '库里=' + ver
    + (currentVer ? ('（现行=' + currentVer.value + '）') : '（现行=未定位到仓库）');
  const pendLine = '待补传行=' + (pend ? pend.n : '-') + '  类型=' + kind;

  const colBad = j.missingColumns.length > 0;
  const idxBad = j.missingIndexes.length > 0 || j.wrongIndexes.length > 0;
  if (colBad) {
    missingCol++;
    badCol.push({ f, ver, miss: j.missingColumns.map(x => x.table + '.' + x.column).join(', '), pend: pend ? pend.n : '-' });
  }
  if (j.missingIndexes.length) {
    missIdx++;
    idxBadSet.add(f);
    badIdx.push({ f, miss: j.missingIndexes.map(x => x.name + '（' + x.why + '）').join(', ') });
  }
  if (j.wrongIndexes.length) {
    wrongIdx++;
    idxBadSet.add(f);
    badIdx.push({ f, miss: j.wrongIndexes.map(x => x.name + '（形态不符：实际列集 [' + x.got.join(', ') + ']）').join(', ') });
  }
  if (v === 0) ok++;

  /* 逐库结论：列面与索引面**各印各的**（缺列时也不许把索引面的差异吞掉 —— E201 要的是两面都看得见） */
  W((colBad ? '[缺列] ' : (idxBad ? '[缺索引] ' : '[OK]   ')) + f);
  W('        结构版本：' + verLine + '  ' + pendLine);
  if (colBad) {
    W('        列面缺 ' + j.missingColumns.length + ' 项：'
      + j.missingColumns.map(x => x.table + '.' + x.column + '（' + x.why + '；' + x.debt + '）').join('、'));
    W('        ' + WORDING.columnFix);
    if (currentVer && String(ver) === String(currentVer.value)) {
      W('        ⚠ 库里版本**已经是现行值**却仍缺列 ⇒ 这是"升级报成功、结构没落地"的形态'
        + '（E71／E73／E201 同形；判据不写死版本串，此处由"库里＝现行"现算）');
    }
  } else {
    W('        **列面齐** ' + NEED_COLUMNS.length + ' 项（**结案口径已闭合**）');
  }
  if (idxBad) {
    if (j.missingIndexes.length) {
      W('        索引面缺 ' + j.missingIndexes.length + ' 项：'
        + j.missingIndexes.map(x => x.name + '（' + x.why + '；' + x.debt + '）').join('、'));
    }
    if (j.wrongIndexes.length) {
      W('        索引面**形态不符** ' + j.wrongIndexes.length + ' 项：'
        + j.wrongIndexes.map(x => x.name + '（期望 [' + x.columns.join(', ') + ']，实际 ['
          + x.got.join(', ') + ']）').join('、'));
    }
    W('        ' + WORDING.indexNote);
  } else {
    W('        索引面齐 ' + NEED_INDEXES.length + ' 项');
  }
  W('');
}
W('===== 汇总 =====');
W('列面：扫描 ' + uniq.length + ' 个库文件：列齐 ' + (uniq.length - skipped - foreignDbCount - missingCol) + ' 个，缺列 ' + missingCol
  + ' 个，打不开 ' + skipped + ' 个，**非本产品库跳过 ' + foreignDbCount + ' 个**（**结案口径：期望「缺列 0」**，本轮实测 ' + missingCol + '）');
W('跳过面：**非本产品库 ' + foreignDbCount + ' 个**（判别＝无 schema_meta 且无 measure_rt／upload_log）'
  + '——它们**不是本产品读数**：既不算"缺列"，也**不算"通过"**；明细见下方"跳过清单"');
W('索引面：索引齐 ' + (uniq.length - skipped - foreignDbCount - idxBadSet.size) + ' 个，缺索引 ' + missIdx + ' 个，索引形态不符 '
  + wrongIdx + ' 个（**不影响正确性**；期望 0，本轮实测 ' + idxBadSet.size + ' 个库有差异）');
W('两面全齐（[OK]）的库：' + ok + ' 个（**不含**打不开与跳过的）');
W('结论：退出码 ' + (missingCol ? 1 : ((missIdx || wrongIdx) ? 4 : 0))
  + (missingCol ? '（列面有缺 ⇒ **结案口径未闭合**：启动一次修复构建后复查）'
    : ((missIdx || wrongIdx) ? '（列面已闭合；只余索引面差异 ⇒ 性能面待登记）' : '（列齐且索引齐）')));
if (missingCol) {
  W('');
  W('缺列清单（带回开发机即可按此登记并追踪）：');
  for (const b of badCol) W('  · ' + b.f + '   结构版本=' + b.ver + '   缺=' + b.miss + '   待补传行=' + b.pend);
}
if (foreignDbCount) {
  W('');
  W('跳过清单（**非本产品库 ' + foreignDbCount + ' 个**：不是看板的库 ⇒ 它的「缺列」与看板无关；'
    + '**跳过 ≠ 通过**，若其中本该有看板的库，请用路径参数把看板程序目录指给本工具）：');
  for (const b of foreignList) W('  · ' + b.f + '   类型=' + b.kind + '   判别=' + b.why);
}
if (missIdx || wrongIdx) {
  W('');
  W('索引面清单（**与缺列不是同一档**：不影响正确性，只影响扫描成本）：');
  for (const b of badIdx) W('  · ' + b.f + '   ' + b.miss);
}
W('');
W('提醒：缺列不等于数据丢失；恢复旧备份后也必须启动一次服务。本工具只读，不改任何库。');
W('提醒：想自证"检查面没漏项"，跑 `node db-schema-check.js --self-test`（内存库，不碰真实库）。');
W('提醒："非本产品库跳过"是**判别结果、不是通过**：要让它进检查面，请用路径参数指定看板程序目录。');

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
process.exit(missingCol ? 1 : ((missIdx || wrongIdx) ? 4 : 0));
