/* ==========================================================================
   本地库结构自检（tests/db-check.js）
   作用：用**一用例一库**的方式验证 schema.sql 与仓储层是否满足 DR-01～DR-19：
        建表齐全、字段与三方映射对齐、去重键生效、事务可回滚、曲线按件固化、
        备份可校验、保留策略只删该删的行。
        2026-09-22（需求 V1.33 第二批）另加五节（六之三～六之七）：
        **DR-03 追加式标准版本模型**（列集、唯一键 (产品,工序,版本)、不覆盖旧行、
        指定时刻生效、版本号只增）、**DR-12 班组留痕**（op_log.team_code 可写可读与计数）、
        **IF-B.5 服务层换算**（绝对值 / 任一必要项缺失即整条占位 / 半套拒收）、
        **旧结构库迁移只发生一次**（防"每次 initSchema 都重建"的静默毁数据）。
        这几节直接打在仓储/服务层上（`server/repo/standard.js`、`server/repo/opLog.js`、
        `server/services/standard.js`）—— 本批尚无 HTTP 路由接线，故不经路由验证。
   依据：DR-03 / DR-04 / DR-12 / DR-13 / DR-14 / DR-15 / DR-16 / DR-18 / DR-19、
        FR-3.19、IF-B.5（需求 V1.33）；ADR-0003（一用例一库）。
   句柄约定：全程使用 `handle.db`；需要换连接时**必须**用 `handle.adopt()`，
             否则夹具自建连接不被跟踪 → Windows 上临时目录删不掉（曾实际踩到）。
   运行：node tests/db-check.js
   退出码：0 = 全部通过；1 = 有断言失败。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const env = require('./env');
const { createRunner } = require('./lib/assert');
const { makeTempDb } = require('./lib/harness');
const fixture = require('./lib/fixture');
const db = require('../server/db');
/* 结构版本的**单一真源**：`server/db/index.js` 导出的 `SCHEMA_VERSION`
   （与上面的 `db` 是同一个模块实例，走 require 缓存；这里显式取出，让断言里的期望值来源一眼可见）。
   为什么这样写：断言里**不得再出现 `'2'` 这类写死数字** —— 实现座位升版（`'2'` → `'3'`）时，
   本文件必须一个字都不用改。 */
const { SCHEMA_VERSION } = require('../server/db/index.js');
const maintain = require('../server/db/maintain');
const measureRepo = require('../server/repo/measure');
const curveRepo = require('../server/repo/curve');
/* 需求 V1.33 第二批（DR-03 追加式标准 / DR-12 班组留痕 / IF-B.5 换算口径）的三处被测对象。
   注意：这三个模块本批**尚无 HTTP 路由调用方**（已在交付报告里如实登记），故本节只在
   仓储/服务层做单元级验证 —— 它们不是"顺带引用"，下面五节全部断言都落在这三处。 */
const standardRepo = require('../server/repo/standard');
const opLogRepo = require('../server/repo/opLog');
const standardSvc = require('../server/services/standard');
/* R26-P3-2（D5）：`measure` / `curve` 的 `deleteBefore` 原来**零调用方且入口无时间校验**，
   本批补校验。这里的引用**不是**"为了跑被测对象"—— 而是拿同层的 `uploadQueue.deleteSettledBefore`
   当**口径对照尺**（它本来就带 `assertTime`）：同类脏串必须两边同判，否则又是"同层三把尺子"。 */
const uploadQueueRepo = require('../server/repo/uploadQueue');

env.assertRuntime();
const t = createRunner('本地库结构自检（db-check）');
const NOW = '2026-09-19 10:00:00';

/** 需求 V1.32 第 7 章要求存在的表（DR-01～DR-12、DR-18）。
 *  这里只管"需求追溯"（哪几张表是需求点名的，少一张即缺陷）；
 *  **表数与表清单一律不写死** —— 期望表集由 `server/db/schema.sql` 的建表清单推导（见 parseSchemaTables）。 */
const REQUIRED_TABLES = [
  'device', 'task', 'standard', 'measure_rt', 'result', 'shift_stat',
  'alarm', 'warning', 'maintenance', 'notice', 'upload_log', 'op_log', 'task_curve'
];

/** 关键列（列名缺失即视为不满足对应 DR）。
 *
 *  ⚠ `standard`（DR-03）的列清单＝需求 **V1.33** 的「追加式版本模型」：旧模型的相机设定值
 *  （`set_depth`/`set_gain`/`set_frame_rate`/`set_shutter`）**已退出该表** —— 相机参数属上位机侧
 *  设备参数，判定与状态判定均不在本看板职责范围；新模型改为「产品号＋工序号＋版本号＋
 *  深度/速度的上下偏差与典型值＋生效时间＋录入人＋班组编号」。
 *  为什么这里仍是**硬编码**（而不是像表清单那样从 schema.sql 现推）：与上面的 `REQUIRED_TABLES`
 *  同理 —— 它必须是**独立于 schema.sql 的需求锚**；若两边都从 schema.sql 派生，改 schema.sql 时
 *  "期望"与"实际"会一起变、永远相等，等于没有判据（"改了 schema 却忘了核对需求"就查不出来）。
 *  防漂移的那一半由 `parseSchemaColumns()`（从 schema.sql 正文解析列集）与库内列**逐名比对**承担，
 *  见第六章之三"standard 库内列集 = schema.sql 声明的列集"。
 *  核对方式（改列时的自检手法，直接在内存库跑，不碰任何文件）：
 *    node -e "const s=require('node:sqlite'),d=require('./server/db');const c=new s.DatabaseSync(':memory:');d.initSchema(c);console.log(d.listColumns(c,'standard').join(','))"
 *  —— 输出须与需求 V1.33 §7 DR-03 行 + 下表逐字一致。 */
const REQUIRED_COLUMNS = {
  device: ['equip_code', 'equip_name', 'upper_host', 'mes_base_url'],
  task: ['proc_order_no', 'batch_no', 'product_code', 'product_name', 'drawing_no',
    'plan_qty', 'plan_start_time', 'plan_end_time', 'status'],
  standard: ['product_code', 'process_code', 'version_no',
    'depth_upper_dev', 'depth_lower_dev', 'depth_typical',
    'speed_upper_dev', 'speed_lower_dev', 'speed_typical',
    'effective_from', 'created_by', 'team_code', 'created_at'],
  measure_rt: ['equip_code', 'proc_order_no', 'measure_depth', 'speed', 'velocity_x',
    'velocity_y', 'frame_rate', 'gain', 'shutter', 'camera_depth', 'test_status', 'collect_time'],
  result: ['proc_order_no', 'unit_index', 'result', 'judged_at', 'retest_count'],
  shift_stat: ['shift_date', 'shift_name', 'plan_qty', 'started_qty', 'qualified_qty',
    'failed_qty', 'pass_rate', 'run_sec', 'idle_sec', 'oee'],
  alarm: ['alarm_code', 'alarm_type', 'level', 'occurred_at', 'brief', 'action', 'close_state'],
  warning: ['warn_type', 'trigger_cond', 'triggered_at', 'state'],
  maintenance: ['content', 'maint_time', 'handler', 'accept_state', 'cycle_days', 'next_due_at'],
  notice: ['category', 'content', 'valid_from', 'valid_to', 'priority', 'created_by'],
  upload_log: ['upload_id', 'interface', 'request_body', 'response_code', 'elapsed_ms',
    'retry_count', 'state'],
  op_log: ['op_time', 'operator', 'op_type', 'content', 'result'],
  task_curve: ['proc_order_no', 'unit_index', 'kind', 'samples', 'sample_count',
    'interval_sec', 'duration_sec', 'min_value', 'max_value', 'finished_at']
};

/** 需求 V1.33 明确要求**消失**的列（列名仍在即视为走了回头路）。
 *  DR-03：相机设定值 `set_depth`/`set_gain`/`set_frame_rate`/`set_shutter` 随"标准表重建为
 *  追加式版本模型"退出 `standard`（相机参数属上位机侧设备参数，不参与本看板判定）。
 *  为什么"必需列齐全"之外还要单独查**不该有的列**：只查齐全时，把旧列留着再补新列也能全绿 ——
 *  那等于两套口径并存（旧列无人维护却仍可被写入），正是本批要消除的歧义。
 *  核对方式：需求 V1.33 §7 DR-03 行（列清单里没有这四个）+ `server/db/schema.sql` 的 standard 建表段。 */
const FORBIDDEN_COLUMNS = {
  standard: ['set_depth', 'set_gain', 'set_frame_rate', 'set_shutter']
};

/** 附录 2 的 13 字段 → 落库位置（uploadId 落在上传日志表，不在实测表） */
const REPORT_TO_COLUMN = {
  equipCode: 'equip_code', procOrderNo: 'proc_order_no',
  frameRate: 'frame_rate', gain: 'gain', shutter: 'shutter',
  cameraDepth: 'camera_depth', depth: 'measure_depth',
  speed: 'speed', velocity_x: 'velocity_x', velocity_y: 'velocity_y',
  collectTime: 'collect_time', testStatus: 'test_status'
};

/* ---------------- 单一真源解析（schema.sql） ----------------
   为什么要有这两个函数：本脚本原先把"库内应有 13 张表"写死在断言里，于是**动 schema.sql
   （哪怕只改注释）都得连测试一起改**，而 schema.sql 才是建表的**单一真源**。
   现在改为：期望表集**从 schema.sql 正文解析**（加表/减表由它自动跟随），再与库内
   `sqlite_master` 的实际表（db.listTables）**逐名比对** —— 判据强度不降（两边必须完全相同）。 */

/** 去掉 SQL 注释（块注释 / 行注释），避免注释里出现的 `CREATE TABLE` 被误当成建表声明。
 *  边界：schema.sql 内没有字符串字面量，故不区分"字符串里的 `--`"。 */
function stripSqlComments(sql) {
  return String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ');
}

/** 从 schema.sql 解析建表清单（按正文出现顺序）。
 *  只认 `CREATE TABLE [IF NOT EXISTS] <name>`；`CREATE [UNIQUE] INDEX` 不会命中。
 *  边界：不支持带引号/方括号的标识符（schema.sql 未使用这种写法）。 */
function parseSchemaTables(sql) {
  const names = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(stripSqlComments(sql))) !== null) names.push(m[1]);
  return names;
}

/** 在**顶层逗号**处切分建表段（括号内的逗号不切，如 `UNIQUE(a, b)`） */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** 从 schema.sql 解析某张表的**列名清单**（按正文出现顺序）。
 *  为什么要它：`standard` 在 V1.33 里是**不兼容重建**（旧列消失 + 新增唯一键），旧库升级靠
 *  `server/db/index.js` 的 `migrateLegacyStandard()` 显式执行。若测试只比"本文件里那份需求列锚"，
 *  库内列集与 schema.sql 漂移（迁移建错列、只补了一半、旧表没被重建）就查不出来。这里从
 *  **schema.sql 正文**取列集，与库内 `PRAGMA table_info` 的实际列逐名比对（两边必须完全相同）。
 *  只认列定义段：以 UNIQUE / PRIMARY / FOREIGN / CHECK / CONSTRAINT 开头的**表级约束**跳过。
 *  边界：不支持带引号/方括号的标识符（schema.sql 未使用这种写法）。 */
function parseSchemaColumns(sql, table) {
  const src = stripSqlComments(sql);
  const head = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(`, 'i').exec(src);
  if (!head) return [];
  const start = head.index + head[0].length;
  let depth = 1;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return [];
  const cols = [];
  for (const part of splitTopLevel(src.slice(start, end))) {
    if (/^\s*(UNIQUE|PRIMARY|FOREIGN|CHECK|CONSTRAINT)\b/i.test(part)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part);
    if (m) cols.push(m[1]);
  }
  return cols;
}

async function main() {
  /* ---------------- 一、建表与结构 ---------------- */
  t.section('一、建表与结构（DR-01～DR-12、DR-18）');
  const handle = makeTempDb({ name: 'schema' });
  const opened = db.openDb(handle.path, {});
  handle.adopt(opened.db);                     // 走 adopt：夹具自建连接仍被跟踪
  const info = db.initSchema(handle.db, NOW);
  t.check('打开库时 WAL 模式生效', opened.journalMode === 'wal', `journal_mode=${opened.journalMode}`);
  t.check('建表脚本执行成功并写入结构版本', info.schemaVersion === db.SCHEMA_VERSION,
    `schema_version=${info.schemaVersion}`);
  db.initSchema(handle.db, NOW);                // 再跑一次验幂等
  t.check('重复初始化是幂等的（可重复执行）',
    db.getSchemaVersion(handle.db) === db.SCHEMA_VERSION, '');

  /* P3 表外 code-12：'改 schema.sql 必须同步升 SCHEMA_VERSION' 这条约定原无断言 ——
     只比"常量与自己"证明不了它被遵守。库里同时记了 schema 指纹，指纹不一致即说明改了 SQL 没升版本。 */
  {
    const fp = db.schemaFingerprint();
    const vsc = db.verifySchemaConsistency(handle.db);
    t.check('库内记录了 schema 指纹，且与当前 schema.sql 一致（改了 schema 必须升版本）',
      db.getSchemaFingerprint(handle.db) === fp && vsc.ok === true,
      vsc.reason || `fingerprint=${fp}`);
    /* 结构版本同样**不写死数字**：期望值取自单一真源 `server/db/index.js` 导出的 `SCHEMA_VERSION`
       （文件顶部 require 出来的那个常量）。判据强度未放松 —— 库内记的版本与代码版本不一致
       （漏跑 initSchema、迁移写错、连的是旧库）必红；"/^\d+$/" 那半句是防"两边同为空的假通过"。 */
    t.check('库内记录的结构版本 = server/db/index.js 导出的 SCHEMA_VERSION（单一真源，不写死数字）',
      /^\d+$/.test(SCHEMA_VERSION) && db.getSchemaVersion(handle.db) === SCHEMA_VERSION,
      `SCHEMA_VERSION=${SCHEMA_VERSION}，库内记录=${db.getSchemaVersion(handle.db)}`);
  }

  /* 期望表集**从 schema.sql 推导**（单一真源），再与库内实际表逐名比对 ——
     原先写死的"13 张"由 schema.sql 自动跟随：实现座位升版时本文件不用改（只加列，不加表）。
     为什么还要比 REQUIRED_TABLES：**两边都由 schema.sql 派生时，"加了一张表"会同时跟着变而永远相等**
     （指纹断言同理 —— 库是本次 initSchema 现建的）。故保留这份"需求点名表清单"作**独立参照**：
     加表必红（须先登记为需求），删表必红（需求点名的表没了）。 */
  const declaredTables = parseSchemaTables(db.readSchemaSql());
  const tables = db.listTables(handle.db);
  const notInDb = declaredTables.filter(x => !tables.includes(x));        // schema.sql 声明了、库内没有
  const notInSchema = tables.filter(x => !declaredTables.includes(x));    // 库内有、schema.sql 没声明
  const unregistered = declaredTables.filter(x => x !== 'schema_meta' && !REQUIRED_TABLES.includes(x));
  const missing = REQUIRED_TABLES.filter(x => !tables.includes(x));       // 需求点名、实际缺失
  const tableProblems = [];
  if (notInDb.length) tableProblems.push(`schema.sql 声明但库内缺：${notInDb.join(', ')}`);
  if (notInSchema.length) tableProblems.push(`库内有但 schema.sql 未声明：${notInSchema.join(', ')}`);
  if (unregistered.length) tableProblems.push(`schema.sql 多出需求未登记的表（须先在需求/REQUIRED_TABLES 里登记）：${unregistered.join(', ')}`);
  if (missing.length) tableProblems.push(`需求要求但缺失：${missing.join(', ')}`);
  t.check(`schema.sql 建表清单 = 库内实际表（共 ${declaredTables.length} 张，含 schema_meta），` +
    `且需求要求的 ${REQUIRED_TABLES.length} 张全在其中`,
    declaredTables.length > 0 && declaredTables.length === tables.length && tableProblems.length === 0,
    tableProblems.length ? tableProblems.join('；')
      : `schema.sql ${declaredTables.length} 张 = 库内 ${tables.length} 张：${tables.join(', ')}`);

  const colProblems = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = db.listColumns(handle.db, table);
    const miss = cols.filter(c => !actual.includes(c));
    if (miss.length) colProblems.push(`${table} 缺 ${miss.join('/')}`);
  }
  t.check('各表关键列齐全', colProblems.length === 0, colProblems.join('；'));

  /* DR-03（V1.33）：新模型之外，还必须确认**旧列已消失** —— 只查"齐全"时，留着 set_* 再补新列
     也能全绿（两套口径并存）。这里是可证伪点：把 set_depth 等加回 schema.sql 即红。 */
  const forbiddenProblems = [];
  for (const [table, cols] of Object.entries(FORBIDDEN_COLUMNS)) {
    const actual = db.listColumns(handle.db, table);
    const still = cols.filter(c => actual.includes(c));
    if (still.length) forbiddenProblems.push(`${table} 仍有 ${still.join('/')}`);
  }
  t.check('DR-03：standard 已删除相机设定值列 set_depth/set_gain/set_frame_rate/set_shutter（旧列不得与新模型并存）',
    forbiddenProblems.length === 0, forbiddenProblems.join('；'));
  t.check('完整性检查通过', db.verifyIntegrity(handle.db).ok, '');

  /* ---------------- 二、字段与三方映射对齐 ---------------- */
  t.section('二、字段与三方映射对齐（附录 2 的 13 项必须都能落库）');
  const measureCols = db.listColumns(handle.db, 'measure_rt');
  const uploadCols = db.listColumns(handle.db, 'upload_log');
  const unmapped = [];
  for (const f of fixture.REPORT_FIELDS) {
    if (f === 'uploadId') {
      if (!uploadCols.includes('upload_id')) unmapped.push('uploadId → upload_log.upload_id');
      continue;
    }
    const col = REPORT_TO_COLUMN[f];
    if (!col || !measureCols.includes(col)) unmapped.push(`${f} → ${col || '(未映射)'}`);
  }
  t.check('附录 2 的 13 个上报字段都有落库列（uploadId 落 upload_log）',
    unmapped.length === 0 && fixture.REPORT_FIELDS.length === 13,
    unmapped.length ? `未映射：${unmapped.join(', ')}` : `已映射 ${fixture.REPORT_FIELDS.length} 项`);
  t.check('相机深度与航行器深度分列存放（camera_depth ≠ measure_depth）',
    measureCols.includes('camera_depth') && measureCols.includes('measure_depth'), '');

  /* ---------------- 三、写入与去重键（DR-13） ---------------- */
  t.section('三、写入与去重键（DR-13）');
  const anchor = fixture.makeFrame({ at: '2026-09-19 10:00:00', i: 0 });
  const first = measureRepo.insertFrame(handle.db, anchor, NOW);
  const second = measureRepo.insertFrame(handle.db, anchor, NOW);
  t.check('首帧写入成功', first.inserted === true, '');
  t.check('同一 (equipCode, procOrderNo, collectTime) 再写被去重（不算错误）',
    second.inserted === false && measureRepo.countByTask(handle.db, anchor.procOrderNo) === 1,
    `表内 ${measureRepo.countByTask(handle.db, anchor.procOrderNo)} 行`);

  /* 批次时间必须与首帧**错开**，否则会被去重键正确拦下（那是上一句验过的行为） */
  const frames = fixture.makeFrames({ count: 60, startAt: '2026-09-19 12:00:00', startIndex: 1000 });
  const batch = measureRepo.insertFrames(handle.db, frames, NOW);
  t.check('批量写入走单事务且计数正确',
    batch.inserted === 60 && batch.skipped === 0, JSON.stringify(batch));

  const dupBatch = measureRepo.insertFrames(handle.db, frames.slice(0, 10), NOW);
  t.check('批量重复写入全部被去重', dupBatch.inserted === 0 && dupBatch.skipped === 10,
    JSON.stringify(dupBatch));

  /* P2-5：`listSecondSamples` 用 substr(collect_time,1,19) 做 1 s 去重，只在长度恰为 19 时成立。
     故入库口必须拒绝带毫秒/带 T/带时区等脏格式（否则同一秒被切成多组，曲线采样失真）。 */
  const dirtyTimes = ['2026-09-19 12:00:00.500', '2026-09-19T12:00:00', '2026/09/19 12:00:00',
    '2026-09-19 12:00', '', null, 20260919120000];
  const dirtyBase = fixture.makeFrame({ at: '2026-09-19 13:00:00', i: 500 });
  let timeRejected = 0;
  const timeAccepted = [];
  for (const bad of dirtyTimes) {
    try {
      measureRepo.insertFrame(handle.db, { ...dirtyBase, collectTime: bad }, NOW);
      timeAccepted.push(String(bad));            // 没抛错 = 被收下了，属缺陷
    } catch { timeRejected++; }
  }
  t.check('P2-5：collectTime 非「yyyy-MM-dd HH:mm:ss」一律拒收（含带毫秒/带 T/带斜杠/空/null/数字）',
    timeRejected === dirtyTimes.length,
    timeAccepted.length ? `被错误收纳：${timeAccepted.join('、')}` : `${timeRejected}/${dirtyTimes.length} 被拒`);
  t.check('P2-5：合规格式下 1 s 去重真的生效（同一秒多帧只留该秒最后一条）',
    (() => {
      /* 同一秒写 3 帧（不同毫秒信息无法表达，故用同秒不同内容模拟），再插下一秒 */
      const base = { ...fixture.makeFrame({ at: '2026-09-19 14:00:00', i: 600 }) };
      measureRepo.insertFrame(handle.db, base, NOW);
      measureRepo.insertFrame(handle.db, { ...base, speed: 9.9 }, NOW);   // 去重键相同 → 被忽略
      measureRepo.insertFrame(handle.db, { ...base, collectTime: '2026-09-19 14:00:01', i: 601 }, NOW);
      const samples = measureRepo.listSecondSamples(handle.db, { procOrderNo: base.procOrderNo })
        .filter(s => s.second >= '2026-09-19 14:00:00' && s.second <= '2026-09-19 14:00:01');
      return samples.length === 2 && samples.every(s => String(s.second).length === 19);
    })(), '两秒 → 两个采样点，且 second 恰为 19 字符');

  /* P2-6：openDb 的 PRAGMA 段抛错时必须**先关连接再抛**。
     否则文件句柄泄漏 → Windows 上文件被锁、临时目录删不掉（复审实测 rmSync 报 EPERM）。
     复现方式：写一个**非 SQLite 的坏文件** —— `new DatabaseSync` 会成功，但第一条 PRAGMA
     就抛 `file is not a database`，正好命中"连接已建立、PRAGMA 失败"这条路径。
     （注意：非法 journalMode / 负 busy_timeout 都**不会**抛错，SQLite 静默回退，构不成前提。） */
  {
    const lockDir = fs.mkdtempSync(path.join(env.paths.tempRoot, 'openDb-lock-'));
    const lockFile = path.join(lockDir, 'board.db');
    fs.writeFileSync(lockFile, Buffer.from('这不是一个 SQLite 数据库文件，故意写坏以触发 PRAGMA 失败'.repeat(20)));
    let threw = false;
    let detail = '';
    try {
      db.openDb(lockFile);
      detail = '未抛错（前提不成立）';
    } catch (err) { threw = true; detail = err.message.slice(0, 50); }
    let removable = false;
    try { fs.rmSync(lockDir, { recursive: true, force: true }); removable = true; }
    catch (err) { detail += ` | 删除失败:${err.code}（连接泄漏，文件被锁）`; }
    t.check('P2-6：openDb 在 PRAGMA 失败时抛错且不泄漏连接（临时文件可删，不锁文件）',
      threw && removable, detail);
  }

  /* ---------------- 四、事务与回滚 ---------------- */
  t.section('四、事务与回滚');
  const before = measureRepo.countByTask(handle.db, anchor.procOrderNo);
  const badRows = [
    fixture.makeFrame({ at: '2026-09-19 13:00:00', i: 2000 }),
    { procOrderNo: 'PO-ROLLBACK', collectTime: '2026-09-19 13:00:01' }  // 缺 equipCode → NOT NULL 失败
  ];
  let threw = false;
  try {
    measureRepo.insertFrames(handle.db, badRows, NOW);
  } catch {
    threw = true;
  }
  const after = measureRepo.countByTask(handle.db, anchor.procOrderNo);
  t.check('批量事务中某行失败 → 整批回滚（无部分写入）',
    threw && after === before, `抛错=${threw}，行数 ${before} → ${after}`);

  /* ---------------- 五、重启后不丢数据（DR-17 的库侧前提） ---------------- */
  t.section('五、重启后不丢数据');
  const liveBefore = handle.liveConnections();
  const reopened = handle.reopen();             // 夹具会关掉更早的连接，避免文件占用
  t.check('重开会关闭更早连接（避免文件占用导致临时目录删不掉）',
    liveBefore === 2 && handle.liveConnections() === 1,
    `活跃连接 ${liveBefore} → ${handle.liveConnections()}`);
  t.check('重开后行数不变且去重键仍生效',
    reopened === handle.db &&
    measureRepo.countByTask(handle.db, anchor.procOrderNo) === before &&
    measureRepo.insertFrame(handle.db, anchor, NOW).inserted === false,
    `重开后 ${measureRepo.countByTask(handle.db, anchor.procOrderNo)} 行`);

  /* ---------------- 六、任务曲线按件固化（DR-18 / DR-19） ---------------- */
  t.section('六、任务曲线按件固化（DR-18 / DR-19）');
  t.check('无曲线时 count=0（界面据此走空态，不抛错）', curveRepo.count(handle.db) === 0, '');
  t.check('latestCurve 在无数据时返回 null',
    curveRepo.latestCurve(handle.db, { kind: 'depth' }) === null, '');

  const depthCurve = fixture.makeCurve({ kind: 'depth', count: 160 });
  const saved = curveRepo.saveCurve(handle.db, depthCurve, NOW);
  t.check('固化一条曲线：采样点数与体积符合预期',
    saved.sampleCount === 160 && saved.sizeBytes > 800 && saved.sizeBytes < 1200,
    `${saved.sampleCount} 点 / ${saved.sizeBytes} 字节`);

  const roundTrip = curveRepo.getCurve(handle.db, depthCurve.procOrderNo, 1, 'depth');
  t.check('读回的采样序列与写入完全一致（JSON 往返无损）',
    JSON.stringify(roundTrip.samples) === JSON.stringify(depthCurve.samples), '');
  t.check('量程上下限与采样点一致（供图下标注）',
    roundTrip.minValue === Math.min(...depthCurve.samples) &&
    roundTrip.maxValue === Math.max(...depthCurve.samples), '');
  t.check('durationSec 语义为秒（≠ 采样点数，避免与 sampleCount 混同）',
    roundTrip.durationSec === 160 && roundTrip.sampleCount === 160 && roundTrip.intervalSec === 1, '');

  curveRepo.saveCurve(handle.db, fixture.makeCurve({ kind: 'depth', count: 160 }), NOW);
  t.check('同一件同一类型重复固化 → 覆盖而非新增行',
    curveRepo.count(handle.db, 'depth') === 1, `depth 曲线 ${curveRepo.count(handle.db, 'depth')} 条`);

  curveRepo.saveCurve(handle.db, fixture.makeCurve({ kind: 'speed', count: 160 }), NOW);
  const latest = curveRepo.latestCurve(handle.db, { kind: 'depth' });
  t.check('latestCurve 只按类型取最近一条',
    Boolean(latest) && latest.kind === 'depth' && latest.sampleCount === 160,
    latest ? `${latest.kind} ${latest.sampleCount} 点` : 'null');

  /* ---------------- 六之二、曲线覆盖写的 id 语义（P3 表外 code-11） ---------------- */
{
  /* 注意：fixture.makeCurve 的 procOrderNo 取自 fixture 的 task（不受参数影响），
     故用**不同 unitIndex** 造两条唯一键不同的曲线；同键的两条会互相覆盖，验不出 id 语义。 */
  const base = fixture.makeCurve({ kind: 'depth' });
  const cA = { ...base, unitIndex: 10 };   // 用 10/20 避开早前用例已占用的 1/2
  const cB = { ...base, unitIndex: 20 };
  /* 前提（D20）：这两个 unitIndex 在本库中尚未被占用，否则"不产生重复行"的断言基准就不成立 */
  const preA = curveRepo.listByTask(handle.db, base.procOrderNo).filter(x => x.unit_index === 10).length;
  const preB = curveRepo.listByTask(handle.db, base.procOrderNo).filter(x => x.unit_index === 20).length;
  t.requires('unitIndex 10/20 在本库中尚未被占用（前提）', preA === 0 && preB === 0,
    `实测已占用：unit10=${preA} 行、unit20=${preB} 行`);
  const firstA = curveRepo.saveCurve(handle.db, cA, NOW);
  const firstB = curveRepo.saveCurve(handle.db, cB, NOW);
  const againA = curveRepo.saveCurve(handle.db, { ...cA, samples: cA.samples.slice(0, 3) }, NOW);
  t.check('P3-code-11：覆盖写返回**被覆盖行**的 id（不是上一次插入的 rowid）',
    firstA.id !== firstB.id && againA.id === firstA.id,
    `插 unit1→id=${firstA.id}，插 unit2→id=${firstB.id}，再覆盖 unit1→id=${againA.id}（应等于 ${firstA.id}）`);
  t.check('P3-code-11：覆盖写后不产生重复行且样本已更新',
    curveRepo.listByTask(handle.db, base.procOrderNo).filter(x => x.unit_index === 10).length === 1 &&
    curveRepo.getCurve(handle.db, base.procOrderNo, 10, 'depth').samples.length === 3,
    `unit10 行数=${curveRepo.listByTask(handle.db, base.procOrderNo).filter(x => x.unit_index === 10).length}`);
}

/* ==========================================================================
   六之三～六之七（需求 V1.33 第二批）：DR-03 追加式标准 / DR-12 班组留痕 /
   IF-B.5 换算口径 / 旧结构库迁移。全部打在**仓储与服务层**上（本批尚无 HTTP 路由调用方）。
   一用例一库：旧库迁移自建**独立临时库**（ADR-0003 D17），不与主用例互相污染。
   ========================================================================== */

/* ---------------- 六之三、DR-03 标准表唯一键（产品＋工序＋版本） ---------------- */
  t.section('六之三、DR-03 标准表唯一键（产品＋工序＋版本，需求 V1.33）');

  /* 库内列集必须与 schema.sql 声明的列集**完全相同**（多一列/少一列都红）。
     这是"旧表没被重建、迁移只补了一半、库里偷偷多留一列"的唯一机器判据：
     需求锚（REQUIRED_COLUMNS.standard）只保证"该有的都有"，这里保证"与正本逐字一致"。 */
  const standardCols = db.listColumns(handle.db, 'standard');
  const declaredStandardCols = parseSchemaColumns(db.readSchemaSql(), 'standard');
  t.check('DR-03：standard 库内列集 = schema.sql 声明的列集（逐名一致，防旧表未迁移/迁移建错列）',
    declaredStandardCols.length > 0 &&
    JSON.stringify(standardCols.slice().sort()) === JSON.stringify(declaredStandardCols.slice().sort()),
    `schema.sql=[${declaredStandardCols.join(', ')}] 库内=[${standardCols.join(', ')}]`);

  const UNIQ_PRODUCT = 'P-UNIQ-1';       // 本用例独享的产品号，与其它用例的行互不干扰
  const UNIQ_PROCESS = '10';
  const insertStdSql =
    `INSERT INTO standard(product_code, process_code, version_no, depth_typical, effective_from, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`;
  const uniqRow = [UNIQ_PRODUCT, UNIQ_PROCESS, 1, 12.6, '2026-09-19 10:00:00', NOW];
  handle.db.prepare(insertStdSql).run(...uniqRow);
  let uniqRejected = false;
  let uniqMessage = '';
  try { handle.db.prepare(insertStdSql).run(...uniqRow); }
  catch (err) { uniqRejected = true; uniqMessage = String(err.message); }
  t.check('DR-03：唯一键 (product_code, process_code, version_no) 生效 —— 同键第二行被拒，报错点明三列',
    uniqRejected && /product_code/.test(uniqMessage) &&
    /process_code/.test(uniqMessage) && /version_no/.test(uniqMessage),
    uniqRejected ? uniqMessage.slice(0, 90) : '同键第二行竟被收下（唯一键缺失）');

  /* 判据要能区分"三列键"与"两列键"：同 (产品,版本) 但换工序号**必须能写入**。
     同时验证唯一键报错后连接状态可继续用（无悬挂事务、无失效句柄）——被拒后再写一行即证明。 */
  let crossAccepted = false;
  let stillUsable = false;
  try {
    handle.db.prepare(insertStdSql).run(UNIQ_PRODUCT, '20', 1, 12.6, '2026-09-19 10:00:00', NOW);
    crossAccepted = true;
    handle.db.prepare(insertStdSql).run(UNIQ_PRODUCT, UNIQ_PROCESS, 2, 12.6, '2026-09-19 11:00:00', NOW);
    stillUsable = standardRepo.countVersions(handle.db,
      { productCode: UNIQ_PRODUCT, processCode: UNIQ_PROCESS }) === 2;
  } catch (err) { uniqMessage += ` | 拒收后的写入失败：${err.message}`; }
  t.check('DR-03：唯一键含 process_code 三列（同产品同版本换工序可写入），且被拒后连接仍可继续写入（无悬挂事务）',
    crossAccepted && stillUsable, uniqMessage.slice(0, 160));

  /* addVersion 的"取号 + 插入"在同一事务内；失败路径必须回滚干净。
     构造"版本号已到上限"的库态（version_no = VERSION_MAX），下一次取号必然越界抛 RangeError；
     若实现漏了 ROLLBACK，紧随其后的 addVersion 会因"事务内再开事务"报错 ⇒ 这条断言必红。 */
  handle.db.prepare(insertStdSql).run('P-MAX', '', standardRepo.VERSION_MAX, 1, '2026-09-19 10:00:00', NOW);
  let overflowThrew = false;
  let overflowKind = '';
  try {
    standardRepo.addVersion(handle.db, {
      productCode: 'P-MAX', processCode: '', depthTypical: 1, depthUpperDev: 0.1, depthLowerDev: -0.1,
      speedTypical: 2, speedUpperDev: 0.1, speedLowerDev: -0.1
    }, '2026-09-19 10:00:00', NOW);
  } catch (err) { overflowThrew = true; overflowKind = err.constructor.name; }
  let resumedAdd = null;
  try {
    resumedAdd = standardRepo.addVersion(handle.db, {
      productCode: 'P-AFTER-OVERFLOW', processCode: '', depthTypical: 1, depthUpperDev: 0.1,
      depthLowerDev: -0.1, speedTypical: 2, speedUpperDev: 0.1, speedLowerDev: -0.1
    }, '2026-09-19 10:00:00', NOW);
  } catch (err) { resumedAdd = { versionNo: `抛错:${err.message.slice(0, 60)}` }; }
  const maxVersions = standardRepo.countVersions(handle.db, { productCode: 'P-MAX', processCode: '' });
  t.check('DR-03：addVersion 取号越界（已达 VERSION_MAX）抛 RangeError 且事务已回滚 —— 行数不变、连接可继续取号',
    overflowThrew && overflowKind === 'RangeError' && maxVersions === 1 &&
    Boolean(resumedAdd) && resumedAdd.versionNo === 1,
    `抛错=${overflowThrew}(${overflowKind})，P-MAX 版本数=${maxVersions}，随后取号=${JSON.stringify(resumedAdd && resumedAdd.versionNo)}`);

/* ---------------- 六之四、DR-03 追加式版本模型（不覆盖 / 指定时刻生效 / 只增不改） ---------------- */
  t.section('六之四、DR-03 追加式版本模型（不覆盖旧行 / 指定时刻生效 / 版本号只增）');
  const APPEND_PRODUCT = 'P-APPEND';
  const APPEND_PROCESS = '30';
  const T1 = '2026-09-20 08:00:00';
  const T2 = '2026-09-22 08:00:00';
  const T3 = '2026-09-23 08:00:00';
  const appendBase = {
    productCode: APPEND_PRODUCT, processCode: APPEND_PROCESS, createdBy: '张伟', teamCode: '检验一班',
    depthTypical: 12.60, depthUpperDev: 0.20, depthLowerDev: -0.20,
    speedTypical: 4.90, speedUpperDev: 0.30, speedLowerDev: -0.30
  };
  const stdV1 = standardRepo.addVersion(handle.db, appendBase, T1, NOW);
  const rowV1Snapshot = JSON.stringify(handle.db.prepare('SELECT * FROM standard WHERE id = ?').get(stdV1.id));
  t.check('DR-03：首版 addVersion 得 version_no=1，且按入参落 effective_from（生效时间由上层＝录入时刻给出）',
    stdV1.versionNo === 1 && stdV1.effectiveFrom === T1 && stdV1.id > 0,
    JSON.stringify(stdV1));

  const stdV2 = standardRepo.addVersion(handle.db, {
    ...appendBase, createdBy: '李娜', teamCode: '检验二班',
    depthTypical: 12.80, depthUpperDev: 0.30, depthLowerDev: -0.30,
    speedTypical: 5.10, speedUpperDev: 0.40, speedLowerDev: -0.40
  }, T2, NOW);
  const rowV2Snapshot = JSON.stringify(handle.db.prepare('SELECT * FROM standard WHERE id = ?').get(stdV2.id));
  const appendVersions = standardRepo.listVersions(handle.db,
    { productCode: APPEND_PRODUCT, processCode: APPEND_PROCESS });
  t.check('DR-03：第二版 version_no=2；getLatest 取最新版、listVersions 版本号倒序、countVersions=2',
    stdV2.versionNo === 2 &&
    standardRepo.getLatest(handle.db, { productCode: APPEND_PRODUCT, processCode: APPEND_PROCESS }).versionNo === 2 &&
    JSON.stringify(appendVersions.map(r => r.versionNo)) === '[2,1]' &&
    standardRepo.countVersions(handle.db, { productCode: APPEND_PRODUCT, processCode: APPEND_PROCESS }) === 2,
    `v2=${stdV2.versionNo}，版本序列=${JSON.stringify(appendVersions.map(r => r.versionNo))}`);

  const rowV1 = handle.db.prepare('SELECT * FROM standard WHERE id = ?').get(stdV1.id);
  t.check('DR-03：追加不覆盖 —— 写入第二版后 v1 行仍在且**逐列原样**（数值/生效时间/录入人/班组均未被改写）',
    Boolean(rowV1) && JSON.stringify(rowV1) === rowV1Snapshot,
    rowV1 ? `v1 现状=${JSON.stringify(rowV1)}` : 'v1 行消失（被覆盖或删除）');

  const effAt = at => standardRepo.getEffective(handle.db,
    { productCode: APPEND_PRODUCT, processCode: APPEND_PROCESS, at });
  const atT1 = effAt(T1);
  const betweenT1T2 = effAt('2026-09-21 12:00:00');
  const atT2 = effAt(T2);
  const afterT2 = effAt('2026-09-22 09:00:00');
  t.check('DR-03：指定时刻生效版本 —— t=T1 与 T1<t<T2 取 v1，t=T2 与 t>T2 取 v2（effective_from ≤ t 的最大 version_no）',
    Boolean(atT1) && atT1.versionNo === 1 && Boolean(betweenT1T2) && betweenT1T2.versionNo === 1 &&
    Boolean(atT2) && atT2.versionNo === 2 && Boolean(afterT2) && afterT2.versionNo === 2,
    `t=T1→v${atT1 && atT1.versionNo}，t=T1+→v${betweenT1T2 && betweenT1T2.versionNo}，` +
    `t=T2→v${atT2 && atT2.versionNo}，t=T2+→v${afterT2 && afterT2.versionNo}`);

  t.check('DR-03：生效时间之前（t<T1）无生效版本 ⇒ 返回 null，**不回退最新版**；无该 (产品,工序) 的行同样返回 null',
    effAt('2026-09-19 00:00:00') === null &&
    standardRepo.getEffective(handle.db,
      { productCode: 'P-NOT-EXIST', processCode: APPEND_PROCESS, at: T3 }) === null &&
    standardRepo.getEffective(handle.db,
      { productCode: APPEND_PRODUCT, processCode: '99', at: T3 }) === null,
    '三处都必须为 null（其中前两处库里明明有更晚生效的版本行）');

  const stdV3 = standardRepo.addVersion(handle.db, { ...appendBase, depthTypical: 13.00 }, T3, NOW);
  const threeRows = standardRepo.listVersions(handle.db,
    { productCode: APPEND_PRODUCT, processCode: APPEND_PROCESS });
  const rowV1After3 = JSON.stringify(handle.db.prepare('SELECT * FROM standard WHERE id = ?').get(stdV1.id));
  const rowV2After3 = JSON.stringify(handle.db.prepare('SELECT * FROM standard WHERE id = ?').get(stdV2.id));
  t.check('DR-03：version_no 只增不改 —— 再次 addVersion 得 v3，历史 v1/v2 两行逐列未被改写，且 t<T1 仍返回 null',
    stdV3.versionNo === 3 &&
    JSON.stringify(threeRows.map(r => r.versionNo)) === '[3,2,1]' &&
    rowV1After3 === rowV1Snapshot && rowV2After3 === rowV2Snapshot &&
    effAt('2026-09-22 12:00:00').versionNo === 2 && effAt('2026-09-19 00:00:00') === null,
    `v3=${stdV3.versionNo}，版本=${JSON.stringify(threeRows.map(r => r.versionNo))}，` +
    `t=T2+仍取 v${effAt('2026-09-22 12:00:00').versionNo}`);

  /* DR-16 是"指定时刻生效"的**前提**：生效时间靠 `effective_from <= at` 的**文本比较**实现，
     混入带斜杠/带 T/缺秒的时间会让文本序不再等于时间序 → 取到错误的"当时生效版本"，故入库口必须拒收。 */
  {
    const badTimes = ['2026/09/20 08:00:00', '2026-09-20T08:00:00', '2026-09-20 08:00', '2026-09-20 08:00:00.500'];
    const beforeBad = standardRepo.count(handle.db);
    let badThrew = 0;
    for (const bad of badTimes) {
      try { standardRepo.addVersion(handle.db, { ...appendBase, productCode: 'P-BADTIME' }, bad, NOW); }
      catch { badThrew++; }
    }
    const defaulted = standardRepo.addVersion(handle.db,
      { ...appendBase, productCode: 'P-DEFAULT-TIME' }, undefined, NOW);
    t.check('DR-03/DR-16：生效时间非「yyyy-MM-dd HH:mm:ss」一律拒收且一行不写；不传则＝录入时刻 now（不许悄悄按错误基准生效）',
      badThrew === badTimes.length && standardRepo.count(handle.db) === beforeBad + 1 &&
      defaulted.effectiveFrom === NOW,
      `${badThrew}/${badTimes.length} 抛错，行数 ${beforeBad} → ${standardRepo.count(handle.db)}，` +
      `缺省生效时间=${defaulted.effectiveFrom}`);
  }

  /* deleteVersion 是"误录入纠正"的窄口：纪律与保留策略同款 —— 非法入参抛错**且一行不删**、
     dryRun 只报数、真删只删目标行。（正常"改标准"只能追加新版本，见 addVersion 的注释。） */
  {
    const delTarget = standardRepo.addVersion(handle.db,
      { ...appendBase, productCode: 'P-DEL' }, T3, NOW);
    const beforeDel = standardRepo.count(handle.db);
    const dryDel = standardRepo.deleteVersion(handle.db, { id: delTarget.id, dryRun: true });
    const badIds = [null, 0, -1, 1.5, 'abc', NaN];
    let idThrew = 0;
    for (const bad of badIds) {
      try { standardRepo.deleteVersion(handle.db, { id: bad }); } catch { idThrew++; }
    }
    const badCaps = [null, 0, -1, 1.5, 'abc'];
    let capThrew = 0;
    for (const bad of badCaps) {
      try { standardRepo.deleteVersion(handle.db, { id: delTarget.id, maxDelete: bad }); } catch { capThrew++; }
    }
    t.check('DR-03：deleteVersion 的纠错纪律 —— 非法 id（null/0/负数/小数/字符串/NaN）与非法 maxDelete 一律抛错，' +
      'dryRun 只报数不删，行数一行未变',
      dryDel.deleted === 1 && dryDel.dryRun === true &&
      idThrew === badIds.length && capThrew === badCaps.length &&
      standardRepo.count(handle.db) === beforeDel,
      `dryRun=${JSON.stringify(dryDel)}，id 抛错 ${idThrew}/${badIds.length}，maxDelete 抛错 ${capThrew}/${badCaps.length}，` +
      `行数 ${beforeDel} → ${standardRepo.count(handle.db)}`);
    const realDel = standardRepo.deleteVersion(handle.db, { id: delTarget.id });
    t.check('DR-03：deleteVersion 真删只删目标一行（不误伤同产品的其它版本行）',
      realDel.deleted === 1 && realDel.dryRun === false &&
      standardRepo.count(handle.db) === beforeDel - 1 &&
      standardRepo.countVersions(handle.db, { productCode: APPEND_PRODUCT, processCode: APPEND_PROCESS }) === 3,
      `deleted=${realDel.deleted}，行数 ${beforeDel} → ${standardRepo.count(handle.db)}`);
  }

/* ---------------- 六之五、DR-12 操作日志班组留痕（op_log.team_code） ---------------- */
  t.section('六之五、DR-12 操作日志班组留痕（op_log.team_code）');
  const opLogCols = db.listColumns(handle.db, 'op_log');
  const TEAM_A = '检验一班';
  const TEAM_B = '检验二班';
  const TEAM_X = '本日不存在的班组';
  const opA1 = opLogRepo.append(handle.db, {
    opTime: '2026-09-19 09:00:00', operator: '张伟', opType: '标准录入',
    content: '深度上下限 12.40～12.80', result: '成功', teamCode: TEAM_A
  }, NOW);
  opLogRepo.append(handle.db, {
    opTime: '2026-09-19 09:05:00', operator: '张伟', opType: '参数配置',
    content: '标准临近比例 15%', result: '成功', teamCode: TEAM_A
  }, NOW);
  opLogRepo.append(handle.db, {
    opTime: '2026-09-19 09:10:00', operator: '李娜', opType: '标准录入',
    content: '速度上下限 4.60～5.20', result: '成功', teamCode: TEAM_B
  }, NOW);
  const opNoTeam = opLogRepo.append(handle.db, {
    opTime: '2026-09-19 09:15:00', operator: '王强', opType: '解锁',
    content: '未解锁场景不应写日志', result: '成功'
  }, NOW);

  t.check('DR-12：op_log 有 team_code 列（V1.33 增列），append 回传的班组编号与入参一致',
    opLogCols.includes('team_code') && opA1.teamCode === TEAM_A,
    `列=[${opLogCols.join(', ')}]，回传=${JSON.stringify(opA1)}`);

  const teamARows = opLogRepo.list(handle.db, { teamCode: TEAM_A });
  t.check('DR-12：班组编号可写可读 —— 按班组过滤查回的行数/内容与写入一致（不串号、不丢班组）',
    teamARows.length === 2 && teamARows.every(r => r.teamCode === TEAM_A) &&
    teamARows.map(r => r.content).join('|') === '深度上下限 12.40～12.80|标准临近比例 15%',
    `查回 ${teamARows.length} 行：${JSON.stringify(teamARows.map(r => [r.opType, r.teamCode, r.result]))}`);

  t.check('DR-12：countByTeam 计数正确（检验一班 2 / 检验二班 1 / 未知班组 0，且支持时间区间收窄）—— 审计"哪个班组做了什么"',
    opLogRepo.countByTeam(handle.db, TEAM_A) === 2 &&
    opLogRepo.countByTeam(handle.db, TEAM_B) === 1 &&
    opLogRepo.countByTeam(handle.db, TEAM_X) === 0 &&
    opLogRepo.countByTeam(handle.db, TEAM_A, { atFrom: '2026-09-19 09:05:00' }) === 1,
    `一班=${opLogRepo.countByTeam(handle.db, TEAM_A)}，二班=${opLogRepo.countByTeam(handle.db, TEAM_B)}，` +
    `未知=${opLogRepo.countByTeam(handle.db, TEAM_X)}`);

  const noTeamRow = handle.db.prepare('SELECT team_code FROM op_log WHERE id = ?').get(opNoTeam.id);
  t.check('DR-12：未传班组写 NULL（不猜、不按操作人反查）—— 与"班组来源唯一＝当前生效班次"一致',
    opNoTeam.teamCode === null && noTeamRow.team_code === null,
    `回传=${JSON.stringify(opNoTeam.teamCode)}，库内=${JSON.stringify(noTeamRow.team_code)}`);

  /* initSchema 幂等（此处的判据必须**在有真实业务行时**跑）：
     此刻库里已有 standard 的多个版本行与 op_log 的留痕行，快照含**逐表行数与逐列内容** ——
     若迁移被判成"每次执行都重建"，standard 行会被换成占位行（内容必变）⇒ 这条断言必红。 */
  {
    const fullSnap = () => JSON.stringify({
      version: db.getSchemaVersion(handle.db),
      tables: db.listTables(handle.db),
      cols: db.listTables(handle.db).map(tb => db.listColumns(handle.db, tb)),
      rows: db.listTables(handle.db).map(tb => handle.db.prepare(`SELECT COUNT(*) AS c FROM ${tb}`).get().c),
      standard: handle.db.prepare('SELECT * FROM standard ORDER BY id').all(),
      opLog: handle.db.prepare('SELECT * FROM op_log ORDER BY id').all()
    });
    const snapshotBeforeInit = fullSnap();
    const rerunInit = db.initSchema(handle.db, NOW);
    t.check('DR-03/DR-12：initSchema 幂等 —— 有真实 standard/op_log 数据时再跑一次，结构、版本与**业务行逐列**完全不变',
      fullSnap() === snapshotBeforeInit && rerunInit.migration.migrated === false,
      `第二次 migration=${JSON.stringify(rerunInit.migration)}`);
  }

/* ---------------- 六之六、IF-B.5 服务层换算（绝对值 / 缺失占位 / 半套拒收） ---------------- */
  t.section('六之六、IF-B.5 服务层换算（绝对值 / 任一必要项缺失即占位 / 半套拒收）');
  const completeStd = standardRepo.getEffective(handle.db,
    { productCode: APPEND_PRODUCT, processCode: APPEND_PROCESS, at: '2026-09-21 12:00:00' });
  t.check('IF-B.5/DR-03：完整标准 isComplete=true（深度与速度的典型值/上下偏差三项都齐）；本用例取到 v1',
    Boolean(completeStd) && completeStd.versionNo === 1 && standardSvc.isComplete(completeStd) === true,
    `版本=v${completeStd && completeStd.versionNo}，isComplete=${standardSvc.isComplete(completeStd)}`);

  const mesDepth = standardSvc.mesLimits(completeStd, { kind: 'depth', pass: true });
  const mesSpeed = standardSvc.mesLimits(completeStd, { kind: 'speed', pass: false });
  t.check('IF-B.5：完整标准 uclValue/lclValue 取**绝对值**（典型值±偏差）—— 深度 12.60±0.20 ⇒ 12.80/12.40、' +
    '速度 4.90±0.30 ⇒ 5.20/4.60；IsPass 由判定侧透传（true/false/未判定 null）',
    mesDepth.uclValue === 12.8 && mesDepth.lclValue === 12.4 && mesDepth.IsPass === true &&
    mesSpeed.uclValue === 5.2 && mesSpeed.lclValue === 4.6 && mesSpeed.IsPass === false &&
    standardSvc.mesLimits(completeStd, { kind: 'depth' }).IsPass === null,
    `depth=${JSON.stringify(mesDepth)}，speed=${JSON.stringify(mesSpeed)}，` +
    `未传 pass=${JSON.stringify(standardSvc.mesLimits(completeStd, { kind: 'depth' }).IsPass)}`);

  /* IF-B.5 点名的**三类缺失组合**（C-78 原文）：①只设偏差未设典型值 ②只设上偏差 ③只设一项指标。
     三类都必须在**两条 dataList（depth/speed）**上整条占位 —— 且 pass=true 也必须被占位覆盖，
     否则等于"带着半套标准去判定"，正是 MES 侧无从判断的情形。 */
  standardRepo.addVersion(handle.db, {
    productCode: 'P-HALF-METRIC', processCode: '',
    depthTypical: 12.60, depthUpperDev: 0.20, depthLowerDev: -0.20
  }, T1, NOW);
  standardRepo.addVersion(handle.db, {
    productCode: 'P-HALF-UPPER', processCode: '', depthUpperDev: 0.20, speedUpperDev: 0.30
  }, T1, NOW);
  standardRepo.addVersion(handle.db, {
    productCode: 'P-HALF-NOTYP', processCode: '',
    depthUpperDev: 0.20, depthLowerDev: -0.20, speedUpperDev: 0.30, speedLowerDev: -0.30
  }, T1, NOW);
  const incompleteStds = ['P-HALF-METRIC', 'P-HALF-UPPER', 'P-HALF-NOTYP']
    .map(code => standardRepo.getEffective(handle.db, { productCode: code, processCode: '', at: T3 }));
  const placeholderOk = incompleteStds.every(std => standardSvc.isComplete(std) === false &&
    ['depth', 'speed'].every(kind => {
      const m = standardSvc.mesLimits(std, { kind, pass: true });
      return m.uclValue === 65535 && m.lclValue === 65535 && m.IsPass === null;
    }));
  t.check('IF-B.5：三类缺失组合（只设一项指标 / 只设上偏差 / 只设偏差未设典型值）在 depth 与 speed 两条 dataList 上' +
    '全部整条占位 65535/IsPass=null（即使传入 pass=true 也不得下判定）',
    incompleteStds.length === 3 && incompleteStds.every(Boolean) && placeholderOk,
    `isComplete=${JSON.stringify(incompleteStds.map(std => standardSvc.isComplete(std)))}，` +
    `depth占位=${JSON.stringify(standardSvc.mesLimits(incompleteStds[0], { kind: 'depth', pass: true }))}`);

  /* "整条占位"与"缺哪个补哪个"的区别：深度自身完整时，只要**同一条标准**的速度缺项，深度也必须占位。
     可证伪点：若 isComplete 被放宽成"该指标齐即可"，这里 depth 会返回 13.10/12.50 而红。 */
  const stdOnlyOneMetric = incompleteStds[0];
  const absDepth = standardSvc.absoluteLimits(stdOnlyOneMetric).depth;
  t.check('IF-B.5：占位是**整条**而不是"缺哪个补哪个" —— 深度自身完整（绝对值可算出 12.80/12.40）但速度缺项 ⇒ 该条 depth 也占位',
    Boolean(absDepth) && absDepth.upper === 12.8 && absDepth.lower === 12.4 &&
    standardSvc.mesLimits(stdOnlyOneMetric, { kind: 'depth' }).uclValue === 65535,
    `depth 绝对值=${JSON.stringify(absDepth)}，mesLimits=${JSON.stringify(standardSvc.mesLimits(stdOnlyOneMetric, { kind: 'depth' }))}`);

  t.check('IF-B.5：标准整条不存在（null）时同样整条占位，且结构不缺项（恰好三个键）',
    (() => {
      const m = standardSvc.mesLimits(null, { kind: 'speed', pass: true });
      return m.uclValue === 65535 && m.lclValue === 65535 && m.IsPass === null && Object.keys(m).length === 3;
    })(), JSON.stringify(standardSvc.mesLimits(null)));

  /* FR-3.19 第⑥步"非法不写入"：半套标准在**服务层校验**必须被拒收（当前尚无路由调用 assertInput，
     接线缺口已在交付报告登记）。负对照（完整入参放行）用于防止"把什么都拒收"也算通过。 */
  {
    const beforeAssert = standardRepo.count(handle.db);
    const halfInputs = [
      { depthTypical: 12.6, depthUpperDev: 0.2 },
      { depthUpperDev: 0.2 },
      { depthTypical: 12.6, depthUpperDev: 0.2, depthLowerDev: -0.2, speedUpperDev: 0.3 }
    ];
    let halfRejected = 0;
    for (const bad of halfInputs) {
      try { standardSvc.assertInput(bad); } catch { halfRejected++; }
    }
    let okAccepted = false;
    try {
      okAccepted = standardSvc.assertInput({
        depthTypical: 12.6, depthUpperDev: 0.2, depthLowerDev: -0.2,
        speedTypical: 4.9, speedUpperDev: 0.3, speedLowerDev: -0.3
      }) === true;
    } catch { okAccepted = false; }
    t.check('FR-3.19⑥/IF-B.5：assertInput 拒收半套标准（缺下偏差 / 只设上偏差 / 单指标半套），' +
      '完整入参放行（负对照），且校验过程一行不写库',
      halfRejected === halfInputs.length && okAccepted &&
      standardRepo.count(handle.db) === beforeAssert,
      `拒收 ${halfRejected}/${halfInputs.length}，完整入参放行=${okAccepted}，` +
      `行数 ${beforeAssert} → ${standardRepo.count(handle.db)}`);
  }

  t.check('FR-3.19⑥：assertLimits 拒收"下限 > 上限"，并拒收"典型值不在上下限之间"（＝上下偏差正负号填反）',
    (() => {
      const badLimits = [
        { depthTypical: 12.6, depthUpperDev: -0.1, depthLowerDev: 0.1,
          speedTypical: 4.9, speedUpperDev: 0.3, speedLowerDev: -0.3 },
        { depthTypical: 12.6, depthUpperDev: 0.5, depthLowerDev: 0.2,
          speedTypical: 4.9, speedUpperDev: 0.3, speedLowerDev: -0.3 }
      ];
      let limitThrew = 0;
      for (const bad of badLimits) {
        try { standardSvc.assertLimits(bad); } catch { limitThrew++; }
      }
      return limitThrew === badLimits.length;
    })(), '2/2 抛错（第二条的下限 12.80 ≤ 上限 13.10，只可能被"典型值在区间内"那半条拦下）');

/* ---------------- 六之七、DR-03 旧结构库迁移只发生一次（防静默毁数据） ---------------- */
  t.section('六之七、DR-03 旧结构库迁移（只发生一次，防"每次执行都重建"）');
  /* 手工造一个 V1.33 之前的旧形态库：`standard` 只有相机设定值列、无 process_code/version_no
     （与 `git show <V1.32 提交>:server/db/schema.sql` 的建表段一致）。 */
  const LEGACY_STANDARD_SQL = `CREATE TABLE IF NOT EXISTS standard (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code    TEXT NOT NULL,
    set_depth       REAL,
    set_gain        REAL,
    set_frame_rate  INTEGER,
    set_shutter     INTEGER,
    effective_from  TEXT NOT NULL,
    created_at      TEXT NOT NULL
  )`;
  /* 旧库的 op_log 也缺 V1.33 的 team_code —— 它的补齐走 STRUCTURE_UPGRADES 的
     `ALTER TABLE op_log ADD COLUMN team_code TEXT`（schema.sql 的 CREATE TABLE IF NOT EXISTS
     对旧表是空操作，列不会凭空出现）。故旧库里必须有这张**旧形态**的表，否则那段升级路径无人覆盖。 */
  const LEGACY_OPLOG_SQL = `CREATE TABLE IF NOT EXISTS op_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    op_time     TEXT NOT NULL,
    operator    TEXT,
    op_type     TEXT NOT NULL,
    content     TEXT,
    result      TEXT,
    created_at  TEXT NOT NULL
  )`;
  const legacy = makeTempDb({ name: 'legacy-standard', initSql: [LEGACY_STANDARD_SQL, LEGACY_OPLOG_SQL] });
  const legacyInsert = legacy.db.prepare(
    `INSERT INTO standard(product_code, set_depth, set_gain, set_frame_rate, set_shutter,
                          effective_from, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`);
  legacyInsert.run('P-OLD-A', 12.5, 8, 60, 100, '2026-01-01 08:00:00', '2026-01-01 08:00:00');
  legacyInsert.run('P-OLD-A', 13.5, 9, 50, 90, '2026-03-01 08:00:00', '2026-03-01 08:00:00');
  legacyInsert.run('P-OLD-B', 7.25, 6, 30, 200, '2026-02-01 08:00:00', '2026-02-01 08:00:00');
  legacy.db.prepare(
    `INSERT INTO op_log(op_time, operator, op_type, content, result, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`)
    .run('2026-01-05 09:00:00', '张伟', '解锁', '旧库留痕行（无班组列）', '成功', '2026-01-05 09:00:00');
  const legacyCols = db.listColumns(legacy.db, 'standard');
  if (t.requires('旧库前提：standard 是旧形态（含 set_depth 等设定值列、**没有** version_no/process_code），' +
    '且 op_log 也缺 team_code',
    legacyCols.includes('set_depth') && !legacyCols.includes('version_no') && !legacyCols.includes('process_code') &&
    !db.listColumns(legacy.db, 'op_log').includes('team_code'),
    `standard 列=[${legacyCols.join(', ')}]，op_log 列=[${db.listColumns(legacy.db, 'op_log').join(', ')}]`)) {
    const legacyProducts = legacy.db.prepare(
      'SELECT DISTINCT product_code FROM standard ORDER BY product_code').all().map(r => r.product_code);
    const m1 = db.initSchema(legacy.db, NOW);
    const migratedCols = db.listColumns(legacy.db, 'standard');
    t.check('DR-03：旧结构库首次 initSchema 触发重建（migrated=true），重建后列集 = schema.sql 声明列集',
      m1.migration.migrated === true && migratedCols.includes('version_no') &&
      migratedCols.includes('process_code') &&
      JSON.stringify(migratedCols.slice().sort()) === JSON.stringify(declaredStandardCols.slice().sort()),
      `migration=${JSON.stringify(m1.migration)}，列=[${migratedCols.join(', ')}]`);

    const migRows = legacy.db.prepare('SELECT * FROM standard ORDER BY product_code, version_no').all();
    const productSet = [...new Set(migRows.map(r => r.product_code))].sort();
    const versionOk = legacyProducts.every(p => {
      const vs = migRows.filter(r => r.product_code === p).map(r => r.version_no).sort((a, b) => a - b);
      return vs.length > 0 && vs[0] === 1 && vs.every((v, i) => v === i + 1);
    });
    /* 这里**刻意不锁"每个产品恰好一版占位行"**：`server/db/index.js`/`schema.sql` 的注释写的是
       "按 product_code 归并成一版占位行"，而实测（ROW_NUMBER 的 INSERT…SELECT）是**每条旧行一版**
       —— 同一产品有 2 条旧行就迁出 v1、v2 两版（本次实测 2 个产品号 → 3 版）。两种做法都满足
       DR-03 在旧库迁移上的硬要求（产品号集合不丢、version_no 从 1 起、占位行不含设定值），
       故断言只锁这三条 —— 不去把一个尚未定论的实现选择固化成"正确"。该表述差异已在交付报告登记。 */
    t.check('DR-03：迁移不丢产品号（旧库 product_code 集合全在新表），且每个产品号的 version_no 从 1 起、连续、process_code 为空串',
      JSON.stringify(productSet) === JSON.stringify(legacyProducts) && versionOk &&
      migRows.every(r => r.process_code === ''),
      `旧=${legacyProducts.join(',')} 新=${productSet.join(',')}，迁移后行数=${migRows.length}`);

    t.check('DR-03：旧行的相机设定值**不被伪装成标准值** —— 占位行六个偏差/典型值列全 NULL（set_depth=12.5 等未落进任何标准列）',
      migRows.length > 0 && migRows.every(r =>
        r.depth_upper_dev === null && r.depth_lower_dev === null && r.depth_typical === null &&
        r.speed_upper_dev === null && r.speed_lower_dev === null && r.speed_typical === null &&
        r.created_by === '结构迁移'),
      JSON.stringify(migRows.slice(0, 2)));

    /* 本批的**防回潮断言**：实现座位实测踩到过"重建写在 schema.sql 里按每次执行跑"⇒
       每次 initSchema 都把真实版本行换成占位行（静默毁数据）。这里在**旧库跑完第一次之后
       再跑一次**，逐列比对快照：行被重建/清空/改写都必红。 */
    const legacySnapshot = JSON.stringify(migRows);
    const m2 = db.initSchema(legacy.db, NOW);
    const migRowsAgain = legacy.db.prepare('SELECT * FROM standard ORDER BY product_code, version_no').all();
    t.check('DR-03：旧库迁移**只发生一次** —— 再跑 initSchema 时 migrated=false 且既有版本行逐列原样（未被重建/未被清空）',
      m2.migration.migrated === false && JSON.stringify(migRowsAgain) === legacySnapshot,
      `第二次 migration=${JSON.stringify(m2.migration)}，行数 ${migRows.length} → ${migRowsAgain.length}`);

    const migratedStd = standardRepo.getEffective(legacy.db,
      { productCode: 'P-OLD-A', processCode: '', at: '2030-01-01 00:00:00' });
    const migratedMes = standardSvc.mesLimits(migratedStd, { kind: 'depth' });
    t.check('DR-03/IF-B.5：迁移出的占位行在服务层仍走占位（isComplete=false、65535/IsPass=null）—— 不会被当成可用标准',
      Boolean(migratedStd) && standardSvc.isComplete(migratedStd) === false &&
      migratedMes.uclValue === 65535 && migratedMes.lclValue === 65535 && migratedMes.IsPass === null,
      `占位行=${JSON.stringify(migratedStd && { versionNo: migratedStd.versionNo, depthTypical: migratedStd.depthTypical })}，` +
      `mes=${JSON.stringify(migratedMes)}`);

    const legacyTables = db.listTables(legacy.db).slice().sort();
    t.check('DR-03：迁移后不留 standard_legacy 残表，且表清单 = schema.sql 声明清单（与新建库同一套结构）',
      !legacyTables.includes('standard_legacy') &&
      JSON.stringify(legacyTables) === JSON.stringify(declaredTables.slice().sort()),
      `表=[${legacyTables.join(', ')}]`);

    /* DR-12 的旧库升级路径：`team_code` 靠 STRUCTURE_UPGRADES 补列（schema.sql 对旧表是空操作）。
       判据＝列真的补上了 **且旧留痕行一行没丢、原字段原样、新列为 NULL**（补列不是重建表）。 */
    const legacyOpLogCols = db.listColumns(legacy.db, 'op_log');
    const legacyOpLogRows = legacy.db.prepare('SELECT * FROM op_log ORDER BY id').all();
    const legacyTeamIndex = Boolean(legacy.db.prepare(
      "SELECT 1 AS hit FROM sqlite_master WHERE type = 'index' AND name = 'ix_op_log_team'").get());
    t.check('DR-12：旧库（op_log 无 team_code）经 initSchema 后列补齐且索引起来，旧留痕行一行不丢、原字段原样、team_code 为 NULL',
      legacyOpLogCols.includes('team_code') && legacyTeamIndex &&
      legacyOpLogRows.length === 1 && legacyOpLogRows[0].op_type === '解锁' &&
      legacyOpLogRows[0].content === '旧库留痕行（无班组列）' &&
      legacyOpLogRows[0].operator === '张伟' && legacyOpLogRows[0].team_code === null,
      `列=[${legacyOpLogCols.join(', ')}]，索引=${legacyTeamIndex}，行=${JSON.stringify(legacyOpLogRows)}`);
  }
  legacy.close();   // 夹具自有连接：不关会在 Windows 上锁住临时目录（ADR-0003 D17）

/* ---------------- 七、备份（DR-15 / DEP-08） ---------------- */
  t.section('七、备份与校验（DR-15 / DEP-08）');
  const backupDir = path.join(env.paths.tempRoot, 'backup-case');
  const bk = await maintain.backupTo(handle.db, backupDir,
    { name: maintain.backupName(new Date(2026, 8, 19, 10, 0, 0)) });
  t.check('在线备份生成文件且体积 > 0', fs.existsSync(bk.path) && bk.bytes > 0,
    `${path.basename(bk.path)} ${bk.bytes} 字节`);
  const verified = maintain.verifyBackup(bk.path);
  t.check('备份文件可打开、完整且含建好的表',
    verified.ok && verified.tables >= REQUIRED_TABLES.length,
    `integrity=${verified.detail}，表 ${verified.tables} 张`);
  t.check('备份前做了 WAL checkpoint（备份自包含）',
    bk.checkpoint.ok === true, bk.checkpoint.error || '');

  for (let i = 1; i <= 3; i++) {
    await maintain.backupTo(handle.db, backupDir,
      { name: maintain.backupName(new Date(2026, 8, 19, 10, 0, i)) });
  }
  const pruned = maintain.pruneBackups(backupDir, 2);
  t.check('保留策略只保留最近 N 份并删除其余',
    maintain.listBackups(backupDir).length === 2 && pruned.removed.length === 2,
    `保留 ${maintain.listBackups(backupDir).length} 份，删除 ${pruned.removed.length} 份`);

  /* ---------------- 八、保留策略（DR-14 保留 1 年） ---------------- */
  t.section('八、数据保留策略（DR-14）');
  const oldFrame = fixture.makeFrame({ at: '2024-01-01 00:00:00', i: 3000 });
  const newFrame = fixture.makeFrame({ at: '2026-09-19 12:00:00', i: 3001 });
  measureRepo.insertFrames(handle.db, [oldFrame, newFrame], NOW);
  const ret = maintain.applyRetention(handle.db, { days: 365, now: new Date('2026-09-19T12:00:00') });
  const remainsOld = measureRepo.listByTask(handle.db,
    { procOrderNo: oldFrame.procOrderNo, from: '2024-01-01 00:00:00', to: '2024-01-01 23:59:59' }).length;
  const remainsNew = measureRepo.listByTask(handle.db,
    { procOrderNo: newFrame.procOrderNo, from: '2026-09-19 12:00:00', to: '2026-09-19 12:00:00' }).length;
  t.check('超过 1 年的采样被删除、未超期的保留',
    remainsOld === 0 && remainsNew === 1,
    `cutoff=${ret.cutoff}，旧数据 ${remainsOld} 行 / 新数据 ${remainsNew} 行`);
  t.check('保留策略返回各类删除计数（可审计）',
    typeof ret.deleted.measure_rt === 'number' && 'task_curve' in ret.deleted,
    JSON.stringify(ret.deleted));

  /* ---------------- 八之二、参数脏掉时的"静默删光"防线（P2-1 / P2-2） ----------------
     复审实测：旧 applyRetention 传 days=null/NaN 会**清空六张表**；旧 pruneBackups 不传 keep
     会**删光全部备份**且报 kept:NaN。这里逐条验证"非法入参必须抛错**且一行/一份都不删**"。 */
  const countAll = () => {
    const tables = ['measure_rt', 'task_curve', 'alarm', 'warning', 'upload_log', 'op_log'];
    const out = {};
    for (const tb of tables) out[tb] = handle.db.prepare(`SELECT COUNT(*) AS c FROM ${tb}`).get().c;
    return out;
  };
  const snapBefore = countAll();
  const snapTotal = Object.values(snapBefore).reduce((a, b) => a + b, 0);
  t.check('前置：六张被裁剪表里确有数据可删（否则下面"没删"证明不了什么）',
    snapTotal > 0, JSON.stringify(snapBefore));

  const RET_NOW = new Date('2026-09-19T12:00:00');
  const badDays = [null, NaN, 0, -1, 1.5, 'abc', Infinity];
  let threwCount = 0;
  for (const d of badDays) {
    try { maintain.applyRetention(handle.db, { days: d, now: RET_NOW }); }
    catch { threwCount++; }
  }
  t.check('applyRetention：days 为 null/NaN/0/负数/小数/字符串/Infinity 时一律抛错（P2-1）',
    threwCount === badDays.length, `${threwCount}/${badDays.length} 抛错`);
  t.check('applyRetention：非法入参**一行都没删**（不是"退化为全删"）',
    JSON.stringify(countAll()) === JSON.stringify(snapBefore), `删除前后：${JSON.stringify(snapBefore)}`);
  t.check('applyRetention：now 传字符串/非法 Date 一律抛错（避免悄悄按错误基准裁剪）',
    (() => {
      let n = 0;
      for (const bad of ['2026-09-19 12:00:00', new Date('bad')]) {
        try { maintain.applyRetention(handle.db, { days: 365, now: bad }); } catch { n++; }
      }
      return n === 2;
    })(), '2/2 抛错（注意：now 为 0/空串属**假值**，会走"缺省即当前时间"的兜底，不抛错）');
  t.check('applyRetention：cutoff 永远是合法日期文本（文本比较下不会误删全部）',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(
      maintain.applyRetention(handle.db, { days: 365, now: RET_NOW, dryRun: true }).cutoff));
  t.check('applyRetention：dryRun 只报数不删除',
    (() => {
      const snap = JSON.stringify(countAll());
      const dr = maintain.applyRetention(handle.db, { days: 365, now: RET_NOW, dryRun: true });
      return dr.dryRun === true && typeof dr.totalDeleted === 'number' &&
        JSON.stringify(countAll()) === snap;
    })());
  t.check('applyRetention：删除量超过上限时中止（防"参数口径错了就把库清空"）',
    (() => {
      /* 前提要自己造：上面的 days=365 已把旧数据清掉，这里必须先插一条"够旧"的行，
         否则 total=0，maxDelete=0 自然不该抛 —— 断言会假过（首版就踩了这个坑）。 */
      const oldTime = '2020-01-01 00:00:00';
      handle.db.prepare(
        'INSERT INTO op_log (op_time, op_type, content, created_at) VALUES (?, ?, ?, ?)')
        .run(oldTime, '自检', 'probe:maxDelete', oldTime);
      const willDelete = maintain.applyRetention(handle.db, { days: 365, now: RET_NOW, dryRun: true }).totalDeleted;
      if (willDelete < 1) return false;
      try {
        maintain.applyRetention(handle.db, { days: 365, now: RET_NOW, maxDelete: 0 });
        return false;
      } catch (err) {
        return err instanceof RangeError;
      }
    })(), 'maxDelete=0 且确有可删行时必须抛 RangeError');

  for (let i = 4; i <= 6; i++) {
    await maintain.backupTo(handle.db, backupDir,
      { name: maintain.backupName(new Date(2026, 8, 19, 11, 0, i)) });
  }
  const backupsBefore = maintain.listBackups(backupDir).length;
  let pruneThrew = 0;
  for (const bad of [null, NaN, -1, 1.5, 'abc']) {
    try { maintain.pruneBackups(backupDir, bad); } catch { pruneThrew++; }
  }
  t.check('pruneBackups：keep 为 null/NaN/负数/小数/字符串时一律抛错（P2-2）',
    pruneThrew === 5, `${pruneThrew}/5 抛错`);
  t.check('pruneBackups：不传 keep 走缺省 30 份，**不抛错也不删光**（P2-2 的核心）',
    (() => {
      const r = maintain.pruneBackups(backupDir);
      return r.kept === backupsBefore && r.removed.length === 0;
    })(), `缺省保留 ${backupsBefore} 份`);
  t.check('pruneBackups：非法入参**一份备份都没删**（不是"一份不剩"）',
    maintain.listBackups(backupDir).length === backupsBefore,
    `删除前后 ${backupsBefore} → ${maintain.listBackups(backupDir).length} 份`);
  t.check('pruneBackups：缺省 keep 走 BACKUP_KEEP 而非删光',
    (() => {
      const r = maintain.pruneBackups(backupDir);
      /* 构成性写法：断言"保留份数 ≥ 缺省阈值则一份不删"，而不是把 30 抄进来 */
      const undereLimit = backupsBefore <= maintain.BACKUP_KEEP;
      return r.kept === maintain.listBackups(backupDir).length &&
        r.kept === backupsBefore && r.removed.length === 0 && undereLimit;
    })(), `缺省保留 ${maintain.listBackups(backupDir).length} 份（BACKUP_KEEP=${maintain.BACKUP_KEEP}）`);
  t.check('pruneBackups：kept 返回真实剩余数（不是 NaN/算式推断）',
    (() => {
      const r = maintain.pruneBackups(backupDir, 1);
      return Number.isInteger(r.kept) && r.kept === 1 && r.removed.length === backupsBefore - 1;
    })(), '');

  /* ---------------- 八之三、删除口的 cutoff 校验（R26-P3-2 / D5） ----------------
     三把尺子对账：`uploadQueue.deleteSettledBefore` 有 `assertTime(cutoff,'cutoff')`、
     `maintain.applyRetention` 自带 cutoff 格式断言，而 `measure` / `curve` 的 `deleteBefore`
     原来**什么都没有** ⇒ 同层口径不一。危害不是理论：`collect_time < ?` / `finished_at < ?`
     是**文本比较**，非时间文本（`'garbage'`、空串）让 `WHERE` 恒真 ⇒ **全表静默删除且照常
     返回删除行数**（改前实测：measure_rt 30 → 0 行、task_curve 3 → 0 行，均未抛错）。
     本段三分：①脏串拒绝（两处**分别**断言，因为表名/列名不同）；②合法 cutoff 只删该删的
     （负对照，防"把什么都拒收"也算通过）；③与同层 `uploadQueue` 口径一致（同一份脏串必须
     两边同判，且**只断言行为，不改 uploadQueue**）。 */
  t.section('八之三、删除口 cutoff 时间校验（R26-P3-2 / D5）');

  /* **一用例一库**（ADR-0003 D17）：本段必须自建库，不能在共享 `handle.db` 上做。
     原因：`deleteBefore` 是**全表**清理口（`DELETE FROM <表> WHERE <时间列> < ?`，不带任务过滤），
     共享库上别的用例早已埋了几十个任务的行 ⇒ 删除行数被它们左右，"只删该删的行"就证不出来
     （首版即踩：deleted=73 而本用例只有 30 行）。独占库后全表行数＝本用例行数，判据才闭合。 */
  const cutDb = makeTempDb({ name: 'delete-before-cutoff' });
  db.initSchema(cutDb.db, NOW);
  const CUT_T0 = '2026-09-20 09:00:00';
  const CUT_T10 = '2026-09-20 09:00:10';
  const CUT_T20 = '2026-09-20 09:00:20';
  const CUT_T30 = '2026-09-20 09:00:30';
  const cutFrames = [];
  for (let i = 0; i < 30; i++) {
    cutFrames.push(fixture.makeFrame({ at: `2026-09-20 09:00:${String(i).padStart(2, '0')}`, i: 9000 + i }));
  }
  const cutIns = measureRepo.insertFrames(cutDb.db, cutFrames, NOW);
  const cutMeasure = () => cutDb.db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
  const cutCurves = () => curveRepo.count(cutDb.db);
  const cutUpload = () => uploadQueueRepo.countAll(cutDb.db);

  /* 脏串取样：非数字开头（文本比较下必然 < 任何 '2026-…'）／空串／缺秒／带 T／数字／null。
     空串是**最危险**的一类：仓库里多处"非空即用"的写法会放它过，而 '' < '2026-…' 同样恒真。 */
  const cutDirty = ['garbage', '2026-09-19', '', '2026-09-19T10:00:00', 20260919100000, null];
  /* 前提（D20）：数据必须先真的在库里 —— 否则"脏串没删成"与"合法 cutoff 删了 10 行"都证明不了什么。
     （曲线与已了结上报在各自小段前另行插、另行设前提；本句只管采样。） */
  if (t.requires('八之三前提：独占库中已入库 30 行采样（脏串危害与合法删除的判据基准）',
    cutIns.inserted === 30 && cutMeasure() === 30,
    `插入=${JSON.stringify(cutIns)}，measure_rt ${cutMeasure()} 行`)) {
    /* ① 脏串被拒 —— measure 侧 */
    const mBadMsgs = [];
    let mBadThrew = 0;
    for (const bad of cutDirty) {
      try { measureRepo.deleteBefore(cutDb.db, bad); mBadMsgs.push(`未抛错：${JSON.stringify(bad)}`); }
      catch (err) {
        const msg = String(err && err.message);
        if (err instanceof TypeError && msg.includes('cutoff') && msg.includes(JSON.stringify(bad))) mBadThrew++;
        else mBadMsgs.push(`${JSON.stringify(bad)} → ${msg.slice(0, 70)}`);
      }
    }
    t.check('R26-P3-2：measure.deleteBefore 的脏串 cutoff（garbage／缺秒／空串／带 T／数字／null）一律拒收' +
      '（TypeError，信息含参数名 cutoff 与实际值），且**一行都没被删** —— 不再出现"WHERE 恒真 ⇒ 全表静默删除"',
      mBadThrew === cutDirty.length && mBadMsgs.length === 0 && cutMeasure() === 30,
      mBadMsgs.length ? mBadMsgs.join('；')
        : `${mBadThrew}/${cutDirty.length} 抛错且点明 cutoff，measure_rt 仍 ${cutMeasure()}/30 行`);

    /* ② 合法 cutoff 正常删除且只删该删的行 —— measure 侧（负对照，防"什么都拒收"也算通过） */
    const mRes = measureRepo.deleteBefore(cutDb.db, CUT_T10);
    const mLeft = measureRepo.listByTask(cutDb.db, { procOrderNo: fixture.task.procOrderNo, from: CUT_T10, to: CUT_T30 }).length;
    t.check('R26-P3-2：measure.deleteBefore 合法 cutoff 正常删除且只删该删的行（30 行中 [T0,T10) 共 10 行 ⇒ 剩 20 行、最小剩时恰为 cutoff）',
      mRes.deleted === 10 && cutMeasure() === 20 && mLeft === 20 &&
      measureRepo.timeRange(cutDb.db, fixture.task.procOrderNo).firstTime === CUT_T10,
      `deleted=${mRes.deleted}，全表剩 ${cutMeasure()} 行，[T10,T30] 内 ${mLeft} 行，` +
      `最早剩 ${measureRepo.timeRange(cutDb.db, fixture.task.procOrderNo).firstTime}`);

    /* ── curve 侧：表/列名不同（finished_at），故**分别**断言，不抽公共函数（授权边界） ── */
    const cutCurveRows = [
      { u: 1, at: CUT_T10 },
      { u: 2, at: CUT_T20 },
      { u: 3, at: CUT_T30 }
    ];
    for (const r of cutCurveRows) {
      curveRepo.saveCurve(cutDb.db, {
        procOrderNo: fixture.task.procOrderNo, unitIndex: r.u, kind: 'depth',
        samples: [1, 2, 3], intervalSec: 1, durationSec: 3, minValue: 1, maxValue: 3,
        finishedAt: r.at
      }, NOW);
    }
    if (t.requires('八之三前提：curve 侧 3 条曲线已入库（finished_at 分别 = T10/T20/T30）',
      cutCurves() === 3, `task_curve ${cutCurves()} 行`)) {
      const cBadMsgs = [];
      let cBadThrew = 0;
      for (const bad of cutDirty) {
        try { curveRepo.deleteBefore(cutDb.db, bad); cBadMsgs.push(`未抛错：${JSON.stringify(bad)}`); }
        catch (err) {
          const msg = String(err && err.message);
          if (err instanceof TypeError && msg.includes('cutoff') && msg.includes(JSON.stringify(bad))) cBadThrew++;
          else cBadMsgs.push(`${JSON.stringify(bad)} → ${msg.slice(0, 70)}`);
        }
      }
      t.check('R26-P3-2：curve.deleteBefore 的脏串 cutoff 一律拒收（TypeError，信息含参数名 cutoff 与实际值），' +
        '且**一行都没被删**（与 measure 侧分别断言：两者的表名/时间列不同）',
        cBadThrew === cutDirty.length && cBadMsgs.length === 0 && cutCurves() === 3,
        cBadMsgs.length ? cBadMsgs.join('；')
          : `${cBadThrew}/${cutDirty.length} 抛错且点明 cutoff，task_curve 仍 ${cutCurves()}/3 行`);

      /* cutoff 是**严格小于**（`finished_at < ?`）：用 T30 才恰好命中 T10/T20 两条，
         并顺手证明"等于 cutoff 的那一条**不**被删"（边界语义，与 measure 侧的 firstTime 断言同口径）。 */
      const cRes = curveRepo.deleteBefore(cutDb.db, CUT_T30);
      t.check('R26-P3-2：curve.deleteBefore 合法 cutoff 正常删除且只删该删的行（finished_at < T30 共 2 条被删 ⇒ 剩 1 条且是 T30 那条）',
        cRes.deleted === 2 && cutCurves() === 1 &&
        curveRepo.getCurve(cutDb.db, fixture.task.procOrderNo, 1, 'depth') === null &&
        curveRepo.getCurve(cutDb.db, fixture.task.procOrderNo, 2, 'depth') === null &&
        Boolean(curveRepo.getCurve(cutDb.db, fixture.task.procOrderNo, 3, 'depth')),
        `deleted=${cRes.deleted}，剩 ${cutCurves()} 条（unit1/unit2 已删、unit3 仍在）`);

      /* ③ 与同层 uploadQueue 口径一致：同一份脏串两边必须同判，且两表一行未删。
         这里**只断言行为，uploadQueue.js 一个字节都不动**（超出本任务授权）。
         upload_log 也要先有"可删的行"，否则"没删"是空谈（该表按 state=成功 才算已了结）。 */
      for (const u of ['UP-CUT-1', 'UP-CUT-2']) {
        uploadQueueRepo.enqueueFailed(cutDb.db, {
          uploadId: u, interface: 'report/receiveReport', requestBody: '{}',
          responseCode: '0000', elapsedMs: 5
        }, NOW);
        uploadQueueRepo.markRetrySuccess(cutDb.db, u, 'report/receiveReport', NOW);
      }
      const settledBefore = cutUpload();
      if (t.requires('八之三前提：upload_log 中有 2 条已了结（成功）记录可被清理口删到',
        settledBefore === 2, `upload_log ${settledBefore} 行`)) {
        const parProblems = [];
        const parBothRejected = [];
        for (const bad of cutDirty) {
          let mThrewBad = false;
          let uThrewBad = false;
          try { measureRepo.deleteBefore(cutDb.db, bad); } catch { mThrewBad = true; }
          try { uploadQueueRepo.deleteSettledBefore(cutDb.db, bad); } catch { uThrewBad = true; }
          /* 判据＝两边同判（都拒收）；任一边放行，紧随的行数检查就会抓到（脏串放行即删全表） */
          if (mThrewBad && uThrewBad) parBothRejected.push(JSON.stringify(bad));
          else parProblems.push(`${JSON.stringify(bad)}：measure=${mThrewBad ? '拒收' : '放行'} / ` +
            `uploadQueue=${uThrewBad ? '拒收' : '放行'}`);
        }
        const parRowsOk = cutMeasure() === 20 && cutCurves() === 1 && cutUpload() === settledBefore;        /* 报错文案也须同形：裁掉前置「模块名＋参数名」段后必须**逐字相同** ——
           两把尺子不能只在"抛不抛"上一致。 */
        const shapeOf = fn => {
          let msg = null;
          try { fn(); } catch (err) { msg = String(err && err.message); }
          if (msg === null) return { msg: null, shape: '未抛错' };
          const at = msg.indexOf('（DR-16');
          return { msg, shape: at < 0 ? msg : msg.slice(at) };
        };
        const mShape = shapeOf(() => measureRepo.deleteBefore(cutDb.db, 'garbage'));
        const cShape = shapeOf(() => curveRepo.deleteBefore(cutDb.db, 'garbage'));
        const uShape = shapeOf(() => uploadQueueRepo.deleteSettledBefore(cutDb.db, 'garbage'));
        const shapeOk = mShape.msg !== null && cShape.msg !== null && uShape.msg !== null &&
          mShape.shape === cShape.shape && cShape.shape === uShape.shape &&
          [mShape, cShape, uShape].every(s => s.msg.includes('cutoff') && s.msg.includes('"garbage"'));
        t.check('R26-P3-2：与同层 uploadQueue.deleteSettledBefore 口径一致 —— 同一份脏串三处（measure/curve/uploadQueue）' +
          '同判为拒收、三表行数一行未变、报错文案除模块名前缀外逐字同形（只断言行为，未改 uploadQueue）',
          parProblems.length === 0 && parRowsOk && shapeOk,
          parProblems.length ? `口径不一：${parProblems.join('；')}`
            : `脏串 ${parBothRejected.length}/${cutDirty.length} 三处同拒，行数不变` +
              `（measure ${cutMeasure()}／curve ${cutCurves()}／upload_log ${cutUpload()}）；` +
              `文案同形「…${uShape.shape.slice(0, 38)}…」`);
      }
    }
  }
  cutDb.close();   // 夹具自有连接：不关会在 Windows 上锁住临时目录（ADR-0003 D17）

  /* ---------------- 九、清理与残留 ---------------- */
  t.section('九、临时区与残留');
  const strayDb = fs.readdirSync(env.paths.tempRoot).filter(n => /\.db(-wal|-shm)?$/.test(n));
  t.check('临时库文件都不在临时区根目录（各用例自有子目录，不会互相干扰）',
    strayDb.length === 0, strayDb.slice(0, 3).join(', '));

  fs.rmSync(backupDir, { recursive: true, force: true });
  const tempDir = handle.dir;
  const closeProblems = handle.close();
  const leftover = fs.existsSync(tempDir);
  t.check('用例结束清理临时库（关闭全部连接后目录可删，且不静默吞错）',
    !leftover && closeProblems.length === 0,
    leftover
      ? `残留：${path.relative(env.paths.root, tempDir)}；问题：${closeProblems.join(' / ') || '（close 未报错，说明仍有未跟踪的连接）'}`
      : '');

  t.finish();
}

try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
