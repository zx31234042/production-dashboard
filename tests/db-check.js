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
        2026-09-28（W4，服务层第二笔第 3 波）再加一节：
        **IF-B 上报 MES**（附录 2 的 13 字段组装与缺值口径 / `uploadId` 复用 `platform/id.js` 真源 /
        **失败留存不自动重试** / 唯一人工重报入口 `retryPending` 的按序与幂等 / `baseUrl` 未配置显式跳过 /
        告警阈值单一真源 / HTTP 端到端）＋ **`E16` 入库口强制校验**（`addVersion` 默认调 `assertInput`，
        半套 / 偏差正负号 / 超量程一律拒收，受控跳过出口单独断言）。
        这几节直接打在仓储/服务层上（`server/repo/standard.js`、`server/repo/opLog.js`、
        `server/services/standard.js`）—— 本批尚无 HTTP 路由接线，故不经路由验证。
        2026-09-28（W5-③，服务层第二笔）再加三节（**九 / 九之二 / 九之三**，原"临时区与残留"顺延为十）：
        **E18 迁移前强制备份**（不可跳过 / 失败即中止 / 无迁移不备份 / `op_log` 可审计）、
        **E44 备份文件名同秒不覆盖**（毫秒 + 冲突递增探测；5 次同秒备份 ⇒ 5 个文件）、
        **ADR-0007 鉴权**（scrypt 哈希非明文 / 错误次数锁定 / 内存会话令牌 / 本机一次性初始化 /
        与 IF-A 静态令牌互不通用 / 六类留痕含来源 IP / `POST /auth/*` 的 HTTP 端到端）。
        2026-10-01（T-20260930-23，座位 4b）再加一节（**六之九**）：
        **规范 v1.34 / 9.5 第 6 条「数据结构变更约束」的静态配套门禁** —— `schema.sql` 里
        『老库形态缺、新库形态有』的列必须在 `STRUCTURE_UPGRADES` 里有对应 `ADD COLUMN` 步骤
        （反方向：不许给 `schema.sql` 里不存在的列补列），判据只读源码 ＋ 手写的老库基线
        `LEGACY_BASELINE_COLUMNS`，**不建库、不跑 `initSchema()`**（故"没有老库"也能红）。
        2026-10-01（T-20260930-28，座位 4b）再加一节（**六之十**）：
        **技术债 `E74` 的门禁侧** —— 把 `STRUCTURE_UPGRADES` 的**步骤形态白名单**从"探针级证据"
        升级为**门禁级可证伪断言**（座位 6 的 `T-20260930-27` 已把判据实现并导出，但门禁断言归本节）：
        ①**清单全过** —— `STRUCTURE_UPGRADES` 每一条步骤都被 `classifyUpgradeStep()` 接受
        （条数在运行期读出并打印；"以后有人往清单里加违规步骤"由它兜底）；
        ②**真值表** —— 对 `classifyUpgradeStep()` / `assertUpgradeStepShape()` 逐条断言语义，
        **期望值构成性给出（D21）**：接受样例由清单里**真实存在的步骤**变换而来（改大小写／加空白／
        换标识符引号／加 `UNIQUE`／加结尾分号），拒绝样例的期望＝`unsupported` ＋ **必抛错** ＋
        消息含**步骤原文**、**全部允许形态**、**重建迁移函数的真名**（都由输入或模块导出算出）；
        ③**守门被接线（静态）** —— 调用点确实在步骤循环体内、在 `db.exec(step)` **之前**、且**不在**
        容忍 `duplicate column name|already exists` 的 `try` 块内（比源码字符下标，**先去注释** ——
        本文件注释里就写着 `db.exec(step)` 与 `assertUpgradeStepShape()`）。
        配 **D22 九组**定点变异（`tests\._verify\zz4b7-d22-mutation.js`；9 条断言**每条**都有靶子）：
        **实现侧 7 组** —— M-A 删调用点／M-C 挪进容忍 `try`／M-D 挪到 `db.exec` 之后／M-E 判据改成不抛／
        M-I 容忍 catch 改成全吞／M-B 往清单追加违规步骤／M-F 往白名单塞同 kind 的重复形态；
        **门禁本体 2 组**（对**本文件**做自变异，验子判据非空洞）—— M-G 去注释扫描器连行尾 `\r` 一起抹
        （开发期真踩到过）／M-H 删掉真值表里"空串"那一类拒绝样例。
   依据：DR-03 / DR-04 / DR-12 / DR-13 / DR-14 / DR-15 / DR-16 / DR-18 / DR-19、
        FR-3.19、IF-B.5（需求 V1.33）；ADR-0003（一用例一库）、ADR-0007（鉴权形态）、
        ADR-0006（改 schema 必须同步升版本）、ADR-0004 D19/D21/D22/D23（断言即证据／期望值构成性／
        防回潮须可证伪／静态防空洞）、规范 9.5 第 6 条（数据结构变更约束，v1.34）与 9.5-5
        「门禁机制必须可达」（判据抽成纯函数 ＋ 调用顺序静态断言）、技术债 E18 / E44 / E71 / **E74**。
   句柄约定：全程使用 `handle.db`；需要换连接时**必须**用 `handle.adopt()`，
             否则夹具自建连接不被跟踪 → Windows 上临时目录删不掉（曾实际踩到）。
   运行：node tests/db-check.js
   退出码：0 = 全部通过；1 = 有断言失败。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
/* W1 新增：IF-D 端到端那一段要在**进程内**起一个临时端口的 http.Server（最小验证，见八之四的说明） */
const http = require('node:http');

const env = require('./env');
const { createRunner } = require('./lib/assert');
const { makeTempDb, makeTempDir, allocPort } = require('./lib/harness');
const { createClock } = require('./lib/clock');
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
/* W1（IF-D 采集接入）的两处被测对象：服务层（校验/去重/1 s 采样落库/断连）与 HTTP 挂载口。
   它们在此之前**无任何服务端调用方**（本批新增），故这里的引用就是本节的被测对象本身。 */
const { createIngest } = require('../server/services/ingest');
const { mountIfD } = require('../server/http/routes/ifD');
const { createRouter } = require('../server/http/router');
/* W2（IF-A 接收）的两处被测对象：服务层（校验 / 幂等 / 权威与不一致提示 / op_log 留痕 / 访问控制）
   与 HTTP 挂载口。二者在本批之前**不存在**（`server/services/dispatch.js`、`server/http/routes/ifA.js`
   为 W2 新增），故这里的引用就是八之五那一节的被测对象本身。 */
const { createDispatch, KIND: IFA_KIND, OP_TYPE: IFA_OP_TYPE } = require('../server/services/dispatch');
const { mountIfA } = require('../server/http/routes/ifA');
/* W4（IF-B 上报 MES）的三处被测对象与两处口径真源：
    · `uploadId` 的**形状真源**在 `platform/id.js`（本段拿它判"上报器的 uploadId 是否同口径"）；
    · 配置真源 `src/config/board.config.js`（段⑦要在**内存里**改 `mes.queueWarnThreshold` 再改回来）；
    · 上报器（13 字段组装/单次发送/失败留存/人工重报）与它的 HTTP 挂载口 —— 本段之前
      **无任何服务端调用方**（W4 新增并接线），故这里的引用就是被测对象本身。 */
const platformId = require('../platform/id');
const boardConfig = require('../src/config/board.config.js');
const { createUploadReporter } = require('../server/services/uploadReporter');
const { mountUpload } = require('../server/http/routes/upload');
/* W5-③（服务层第二笔）的三处被测对象：
    · `server/services/auth.js`（scrypt 哈希 / 错误次数锁定 / 内存会话令牌 / 一次性初始化码）；
    · `server/http/routes/auth.js`（`mountAuth(router,{auth,logger,now})` 的 HTTP 适配）；
    · `server/db/index.js` 的 E18 迁移前强制备份 + `server/db/maintain.js` 的 E44 备份命名。
   三者在本批之前**不存在**（auth 服务/路由为 W5-③ 新增，另外两处是既有实现的技术债收口），
   故这里的引用就是九 / 九之二 / 九之三 三节的被测对象本身。 */
const authSvc = require('../server/services/auth');
const { mountAuth } = require('../server/http/routes/auth');
/* A1（T-20261002-06／ADR-0009 D1）的两处被测仓储：`shift_stat`（DR-06，唯一写入口 `upsertFrozen`
   ＋ 三个读口）与 `warning`（DR-08，唯一写入口 `insertWarning` ＋ 只读对账口）。
   二者在 `T-20261002-05` 之前**零写入点**，故这里的引用就是本章之十一的断言对象本身。
   ⚠ 本文件**只读它们、不改实现**；`repo/*` 不做业务判断（"什么时候固化、归属键怎么拼"在
   `server/index.js`，由第四节的 `harness-check` 端到端覆盖）。 */
const shiftStatRepo = require('../server/repo/shiftStat');
const warningRepo = require('../server/repo/warning');
/* `FR-7.12`（P0，`T-20261002-08`）的**唯一写入口**：`notice` 表（DR-10）的
   `publish` / `edit` / `remove` ＋ 三个读口（`list` / `listForBoard` / `getById` / `count`）。
   本节（十之十二）的断言对象就是它 —— 该模块在 `T-20261002-08` 之前**不存在**。 */
const noticeRepo = require('../server/repo/notice');

env.assertRuntime();
const t = createRunner('本地库结构自检（db-check）');
const NOW = '2026-09-19 10:00:00';

/** 需求 V1.32 第 7 章要求存在的表（DR-01～DR-12、DR-18）。
 *  这里只管"需求追溯"（哪几张表是需求点名的，少一张即缺陷）；
 *  **表数与表清单一律不写死** —— 期望表集由 `server/db/schema.sql` 的建表清单推导（见 parseSchemaTables）。 */
const REQUIRED_TABLES = [
  'device', 'task', 'standard', 'measure_rt', 'result', 'shift_stat',
  'alarm', 'warning', 'maintenance', 'notice', 'upload_log', 'op_log', 'task_curve',
  /* ADR-0007 D1（NFR-14 / FR-8.4）：设置页口令凭证表。它是**需求点名**的新表，
     故必须登记进来 —— 否则第一章的"schema.sql 多出需求未登记的表"判据会把它当成"私自加表"。 */
  'auth_credential'
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
  /* DR-04（需求 **V1.41** / C-111）：`measure_rt` 增列**件序号 `unit_index`**（＝`IF-D.4` 的 `unitIndex`，
     采集落库时写入）⇒ 它已是需求点名的关键列，必须登记进这份"独立于 schema.sql 的需求锚"
     （否则"把该列从 schema.sql 删掉"这份锚不会响，而 `FR-4.2` 的开工数将整段塌成 0）。 */
  measure_rt: ['equip_code', 'proc_order_no', 'unit_index', 'measure_depth', 'speed', 'velocity_x',
    'velocity_y', 'frame_rate', 'gain', 'shutter', 'camera_depth', 'test_status', 'collect_time'],
  result: ['proc_order_no', 'unit_index', 'result', 'judged_at', 'retest_count'],
  /* `E83`（2026-10-04，跨零点口径的**两个投影**）：`shift_stat` 增列 `run_sec_day1`/`run_sec_day2`
     （**自然日投影**：本班运行秒数按零点切成"班次开始日 day1 ＋ 次日 day2"两段，
     供 `FR-6.4/6.5/6.6` 的当日/本月/年度累计运行按**自然日**归零；班次指标仍整班归开始日，`DR-06`）。
     为什么登记进这份**独立于 `schema.sql` 的需求锚**：它们是需求点名的落盘（一行 `shift_stat`
     必须能表达"这一班里多少秒属于 D、多少属于 D+1"）⇒ "有人把这两列从 `schema.sql` 删掉"必须让
     本锚**响**（＝本章第一节"各表关键列齐全"当场变红），而不是等读代码时顺手发现。
     ⚠ 与 `LEGACY_BASELINE_COLUMNS.shift_stat` 的分工见那个常量上方的注释：
     **锚要求它们在、基线要求它们不在** —— 两处都写才是不矛盾的一致口径。 */
  shift_stat: ['shift_date', 'shift_name', 'plan_qty', 'started_qty', 'qualified_qty',
    'failed_qty', 'pass_rate', 'run_sec', 'run_sec_day1', 'run_sec_day2', 'idle_sec', 'oee'],
  alarm: ['alarm_code', 'alarm_type', 'level', 'occurred_at', 'brief', 'action', 'close_state'],
  warning: ['warn_type', 'trigger_cond', 'triggered_at', 'state'],
  maintenance: ['content', 'maint_time', 'handler', 'accept_state', 'cycle_days', 'next_due_at'],
  notice: ['category', 'content', 'valid_from', 'valid_to', 'priority', 'created_by'],
  upload_log: ['upload_id', 'interface', 'request_body', 'response_code', 'elapsed_ms',
    'retry_count', 'state'],
  op_log: ['op_time', 'operator', 'op_type', 'content', 'result'],
  task_curve: ['proc_order_no', 'unit_index', 'kind', 'samples', 'sample_count',
    'interval_sec', 'duration_sec', 'min_value', 'max_value', 'finished_at'],
  /* ADR-0007 D1 的 DDL **逐字**（列名与唯一键都按原文）：口令只存派生值与状态，永不存明文。 */
  auth_credential: ['username', 'algo', 'params', 'salt', 'hash', 'fail_count', 'locked_until',
    'is_initial', 'created_at', 'updated_at', 'changed_by', 'team_code']
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

/** 老库基线列集（规范 **9.5 第 6 条**「数据结构变更约束」配套**静态**门禁的**独立锚**，
 *  判据跑在第六章之九；那份断言**不建库、不跑 `initSchema()`**，只读本常量＋`schema.sql` 正文
 *  ＋`server/db/index.js` 导出的 `STRUCTURE_UPGRADES`，故"没有老库、只读源码"也能红）。
 *
 *  **是什么**：`表 -> 列名数组` ＝ **老库升级路径里"非 `ADD COLUMN` 的那部分"一定会交付的列**
 *  —— 具体三类来源：① 老库本来就有的列；② `schema.sql` 的 `CREATE TABLE IF NOT EXISTS`
 *  对老库**新建**的表（表还不是老库形态？那它整表由这一句建出来，列自然齐）；
 *  ③ `server/db/index.js` 的 `migrateLegacyStandard()` 对 legacy `standard` 的**重建**
 *  （该重建内联的建表 DDL 与 `schema.sql` 的 `standard` 段逐列一致，见该函数注释与六之七）。
 *  由此判据只有一句：**`schema.sql` 里落在这份基线之外的列，只能由 `STRUCTURE_UPGRADES`
 *  的 `ADD COLUMN` 步骤交付 ⇒ 必须有同表同列的步骤**（正方向）；反过来，每条 `ADD COLUMN`
 *  指向的列必须真实存在于 `schema.sql`、且**不得**同时出现在基线里（反方向＋口径一致）。
 *
 *  ⚠ **为什么必须手写、以及每次真实升级要复核什么**（本条最容易做错的地方）：
 *   · **不得**从 `schema.sql` 现推基线（例如拿"当前列集 − 步骤列集"当基线）—— 那样"期望"与
 *     "实际"同源，改 `schema.sql` 时两侧一起变，断言**恒真**：正是 ADR-0004 **D23** 要堵的
 *     自证式空洞写法（本文件 `REQUIRED_TABLES`/`REQUIRED_COLUMNS` 手写也是同一理由）。
 *   · **不得**从 git 历史现推（`git show <旧提交>:server/db/schema.sql`）：①本门禁要能在**任何**
 *     工作区复跑 —— 交付包/浅克隆/单文件拷贝里没有 `.git`，靠历史就整段跑不了（门禁"跑不了"
 *     只能退 3，等于这条规则在最需要它的现场交付形态里失效）；②历史给的是"**某次提交时**的
 *     形态"，而现场老库的真实形态未必等于它（可能更老、可能被人手改过），"提交形态"推不出
 *     "老库**一定**有的列"；③9.5-5 第 9 条（v1.34 勘误）已实测"提交/行尾规范化会改写工作区字节"，
 *     把判据挂在历史字节上等于给这条门禁引入与本题无关的漂移源。
 *   · **每次真实升级都要复核它**（这本就是 9.5 第 6 条"同批"的一部分），方向是具体的：
 *     ① **新增列不要写进这里** —— 写进来等于声明"老库不缺它"，本条门禁对该列**立刻失明**；
 *        正常升级后这里**一个字都不用改**（新列落在基线之外，而步骤已在 `STRUCTURE_UPGRADES` 里）。
 *     ② **删列／改列名**必须同批删掉这里的陈旧行（否则"基线列 ⊆ `schema.sql` 列"那一条必红），
 *        并按 9.5 第 6 条给"删列/改列"本身的迁移步骤。
 *     ③ 只有当**确实不再支持**缺某列的老库版本时，才把该列移进这里 —— 移入即"放弃对那批老库
 *        的补列义务"，请在同一行写清理由与被放弃的版本号。
 *   · 列名一律逐列手写（顺序与 `schema.sql` 一致，便于肉眼对账）。写错列名**不会**静默放过：
 *     漏写一列 ⇒ 正方向报"该列缺步骤"；多写/写错 ⇒ "基线列 ⊆ `schema.sql` 列"报陈旧行。
 *   · 本仓当前实例：`op_log` **无** `team_code`、`measure_rt` **无** `unit_index`、`upload_log` **无**
 *     `fail_reason`/`updated_at` —— 这四列正是
 *     `STRUCTURE_UPGRADES` 四条 `ADD COLUMN` 的交付物（先例 DR-12 / DR-04·C-111 / `E73` 的历史遗漏补齐），
 *     故都不在基线里。 */
const LEGACY_BASELINE_COLUMNS = {
  schema_meta: ['key', 'value', 'updated_at'],
  device: ['equip_code', 'equip_name', 'model', 'location', 'upper_host', 'upper_port',
    'mes_base_url', 'camera_count', 'updated_at'],
  task: ['proc_order_no', 'batch_no', 'product_code', 'product_name', 'product_no', 'drawing_no',
    'order_no', 'plan_qty', 'plan_start_time', 'plan_end_time', 'process_no', 'process_name',
    'status', 'actual_start', 'actual_end', 'created_at', 'updated_at'],
  /* `standard` 的旧库形态是 V1.33 之前的 set_* 结构（与当前列**完全不同**），由
     `migrateLegacyStandard()` **重建**交付 —— 重建内联 DDL 与 `schema.sql` 的 standard 段逐列一致，
     故这些列全部算"非 `ADD COLUMN` 部分交付"，不在基线之外。
     ⚠ 将来若给 `standard` **加列**：重建只对 legacy 形态触发（对已是新形态的库是空操作），
     所以新列**必须**走 `STRUCTURE_UPGRADES` 的 `ADD COLUMN`，并且**不要**把它补进这一行。 */
  standard: ['id', 'product_code', 'process_code', 'version_no', 'depth_upper_dev', 'depth_lower_dev',
    'depth_typical', 'speed_upper_dev', 'speed_lower_dev', 'speed_typical', 'effective_from',
    'created_by', 'team_code', 'created_at'],
  /* DR-04（需求 V1.41 / C-111）：老库（V1.41 之前的库）**没有** `unit_index`，
     它由 `STRUCTURE_UPGRADES` 的 `ALTER TABLE measure_rt ADD COLUMN unit_index INTEGER` 交付
     ⇒ 故意不列在这里（列在这里＝本门禁对"删掉那条 ALTER"失明）。 */
  measure_rt: ['id', 'equip_code', 'proc_order_no', 'measure_depth', 'speed', 'velocity_x',
    'velocity_y', 'frame_rate', 'gain', 'shutter', 'camera_depth', 'test_status', 'collect_time',
    'created_at'],
  result: ['id', 'proc_order_no', 'unit_index', 'result', 'judged_at', 'retest_count',
    'duration_sec', 'created_at', 'updated_at'],
  /* ⚠ `E83`（2026-10-04）：`run_sec_day1`/`run_sec_day2` **有意不在**这一行（老库基线）里 ——
     它们是给**已存在**的 `shift_stat` 加的列，由 `STRUCTURE_UPGRADES` 的两条
     `ALTER TABLE shift_stat ADD COLUMN run_sec_day1/2 INTEGER` 交付。
     Why（本门禁最容易失明的一处）：把这两列写进基线＝向六之九的判据**声明"老库不缺它们"**
     ⇒ **正方向**那条（"基线之外的列必须有同表同列 `ADD COLUMN` 步骤"）对它们**立刻失明**：
     删掉那两条 `ALTER` 也不会红，而现场老库升级后写 `run_sec_day1` 会报
     `table shift_stat has no column named run_sec_day1`（自然日投影整段拿不到数据）。
     这是与 `measure_rt.unit_index`／`upload_log.fail_reason`／`op_log.team_code` 三条先例**同一条纪律**：
     **新增列不要写进这里**。另外，十之十三的 `E83-2` 有一条**正面断言**把"它们不在基线里、
     且确有补列步骤"钉住 —— 免得日后有人"为了让某条断言变绿"把这两列顺手补进来。
     （若将来**确实不再支持**缺这两列的老库版本，按本常量上方的规则 ③ 把它们移进来，并同批改
     `E83-2` 与写明被放弃的版本号 —— 那是一次**有意的口径变更**，不是顺手补列。） */
  shift_stat: ['id', 'shift_date', 'shift_name', 'plan_qty', 'started_qty', 'finished_qty',
    'qualified_qty', 'failed_qty', 'retest_qty', 'pass_rate', 'run_sec', 'idle_sec', 'oee',
    'frozen_at', 'created_at'],
  alarm: ['id', 'alarm_code', 'alarm_type', 'level', 'occurred_at', 'brief', 'action',
    'close_state', 'handler', 'handled_at', 'closed_at', 'created_at', 'updated_at'],
  warning: ['id', 'warn_type', 'trigger_cond', 'triggered_at', 'state', 'created_at'],
  maintenance: ['id', 'kind', 'content', 'maint_time', 'handler', 'accept_state', 'cycle_days',
    'next_due_at', 'created_at'],
  notice: ['id', 'category', 'sub_type', 'content', 'valid_from', 'valid_to', 'priority',
    'created_by', 'created_at', 'updated_at'],
  /* E73（历史遗漏的补齐，规范 v1.35 · 9.5 第 6 条增补③）：`fail_reason`/`updated_at` 是 2026-09-21
     给**已存在**的 `upload_log` 加的列，却从没有过迁移步骤 —— 它们曾躺在这份基线里，于是本门禁
     对"老库拿不到这两列"**天然失明**（V2 老库实测：升级报成功，`enqueueFailed()` 抛
     `table upload_log has no column named fail_reason`）。现已按"同批"补上 `STRUCTURE_UPGRADES`
     的两条 `ADD COLUMN` 并从本行移除 ⇒ 故意不列在这里（列在这里＝本门禁对"删掉那两条 ALTER"再次失明）。 */
  upload_log: ['id', 'upload_id', 'interface', 'request_body', 'response_code', 'response_body',
    'elapsed_ms', 'retry_count', 'state', 'created_at'],
  /* DR-12（V1.33 第二批）：老库（V1.33 之前的库）**没有** `team_code`，同样由
     `STRUCTURE_UPGRADES` 的 `ALTER TABLE op_log ADD COLUMN team_code TEXT` 交付 ⇒ 不列在这里。 */
  op_log: ['id', 'op_time', 'operator', 'op_type', 'content', 'result', 'created_at'],
  task_curve: ['id', 'proc_order_no', 'unit_index', 'kind', 'samples', 'sample_count',
    'interval_sec', 'duration_sec', 'min_value', 'max_value', 'finished_at', 'created_at'],
  /* ADR-0007 D1 的表：整表由 `CREATE TABLE IF NOT EXISTS` 交付（老库里根本没这张表）。 */
  auth_credential: ['id', 'username', 'algo', 'params', 'salt', 'hash', 'fail_count', 'locked_until',
    'is_initial', 'created_at', 'updated_at', 'changed_by', 'team_code']
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

/** `E123` **口径关系**（纯函数：只吃两个集合，不读盘 ⇒ 可以直接喂变异体做 `D22`）。
 *
 *  **「13 张表」＝业务表口径**（2026-10-05 负责人按建议批准）。三套数各有其位：
 *    · `declared`（`schema.sql` 物理建表）含内部簿记 `schema_meta` 与鉴权 `auth_credential`；
 *    · `required`（`REQUIRED_TABLES` ＝门禁覆盖面）＝ 业务表 ＋ `auth_credential`；
 *    · 文档/权威区/门禁硬串里的「13 张表」＝ **业务表** ＝ `declared − {schema_meta, auth_credential}`。
 *
 *  判据（每条都**逐条指名**差集，不许"看着差不多就过"）：
 *    ① `declared − required` 必须**恰好**是 `[schema_meta]`（schema 里"需求未点名"的只能是内部簿记）；
 *    ② `required − declared` 必须为空（需求点名的表一张都不许少）；
 *    ③ `required − 业务表` 必须**恰好**是 `[auth_credential]`（门禁覆盖面唯一超出业务口径的那张）；
 *    ④ `declared` 必须被"业务／簿记／鉴权"**三分**：两两不交、并集 ＝ `declared`、无重复建表；
 *    ⑤ **业务表必须全被 `REQUIRED_TABLES` 覆盖**（"13 张业务表都得有人看着"——这条最直接：
 *       少登记一张业务表时它**第一个**指名那张表）。
 *
 *  @param {string[]} declared  `schema.sql` 的 `CREATE TABLE` 名单（可含重复，本函数会查重）
 *  @param {string[]} required  `REQUIRED_TABLES`
 *  @returns {{ok:boolean, problems:string[], business:string[], numbers:object}} */
function gaugeRelation(declared, required) {
  const BOOKKEEPING = 'schema_meta';        /* 内部簿记（结构版本/建表脚本指纹），不属于业务数据表 */
  const AUTH = 'auth_credential';           /* ADR-0007 D1：设置页口令凭证表（E86① 引入） */
  const uniq = a => [...new Set(a)];
  const declaredSet = uniq(declared);
  const requiredSet = uniq(required);
  const business = declaredSet.filter(t => t !== BOOKKEEPING && t !== AUTH);
  const diff = (a, b) => a.filter(x => !b.includes(x));
  const fmt = a => (a.length ? a.join('、') : '∅');
  const problems = [];

  const notRequired = diff(declaredSet, requiredSet);
  if (notRequired.length !== 1 || notRequired[0] !== BOOKKEEPING) {
    problems.push(`① schema.sql 里"REQUIRED_TABLES 未点名"的表应恰好是 [${BOOKKEEPING}]，`
      + `实际是 [${fmt(notRequired)}]`);
  }
  const missing = diff(requiredSet, declaredSet);
  if (missing.length) problems.push(`② REQUIRED_TABLES 点名但 schema.sql 里没有的表：[${fmt(missing)}]`);
  const beyondBusiness = diff(requiredSet, business);
  if (beyondBusiness.length !== 1 || beyondBusiness[0] !== AUTH) {
    problems.push(`③ REQUIRED_TABLES 相对"业务表口径"多出的表应恰好是 [${AUTH}]，`
      + `实际是 [${fmt(beyondBusiness)}]`);
  }
  const businessUncovered = diff(business, requiredSet);
  if (businessUncovered.length) {
    problems.push(`⑤ 业务表里 `+"`REQUIRED_TABLES`"+` 未覆盖的：[${fmt(businessUncovered)}]`
      + `（业务表必须全被结构门禁看着）`);
  }
  const buckets = [['业务表', business], ['内部簿记', [BOOKKEEPING]], ['鉴权', [AUTH]]];
  for (let i = 0; i < buckets.length; i++) {
    for (let j = i + 1; j < buckets.length; j++) {
      const both = buckets[i][1].filter(t => buckets[j][1].includes(t));
      if (both.length) problems.push(`④ "${buckets[i][0]}"与"${buckets[j][0]}"两个口径重叠：[${fmt(both)}]`);
    }
  }
  const union = uniq(buckets.flatMap(([, b]) => b));
  const unclassified = diff(declaredSet, union);
  const ghost = diff(union, declaredSet);
  if (unclassified.length) problems.push(`④ schema.sql 里落不进三桶的"第四类"表：[${fmt(unclassified)}]`);
  if (ghost.length) problems.push(`④ 三桶里有 schema.sql 并不存在的表（幽灵）：[${fmt(ghost)}]`);
  if (declared.length !== declaredSet.length) {
    problems.push(`④ schema.sql 有重复建表：${declared.length} 条声明 / ${declaredSet.length} 个名字`);
  }

  return {
    ok: problems.length === 0,
    problems,
    business,
    numbers: {
      declared: declaredSet.length,
      business: business.length,
      required: requiredSet.length,
      arithmeticA: `${declaredSet.length} − {${BOOKKEEPING}, ${AUTH}} = ${business.length}`,
      arithmeticB: `${business.length} ＋ {${AUTH}} = ${requiredSet.length}`
    }
  };
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

  /* ---------------- 一之二、`E123` 口径关系（「13 张表」＝业务表口径） ----------------
     **裁定**（2026-10-05 负责人按建议批准；门禁侧照此实现，**不改任何一处数字**）：
       三套数各有其位 ——
         · `schema.sql` 物理建表：含内部簿记 `schema_meta` 与鉴权 `auth_credential`；
         · `REQUIRED_TABLES`（**门禁覆盖面**）＝ 业务表 ＋ `auth_credential`；
         · 文档／权威区／门禁硬串里的「**13 张表**」＝ **业务表**
           （＝物理表 − `schema_meta` − `auth_credential`）。
     **为什么加这条**：同一事实有 3 个数字（15／14／13）散布在 schema、门禁与 6 处文档里，
     任何**单改一处**都会把门禁打红（`E123` 原文实测：`docs-cross-check.js:445` 是硬串），
     而不改又没人能判断"13"是笔误还是另一种口径 ⇒ 必须把**口径之间的关系**写成判据，
     让它**现算、逐条指名差集**，而不是让读者去猜。
     **为什么不写死 13／14／15**：写死就把"口径关系"退化成"三个常数比对" —— 合法地加一张
     业务表时判据只会喊"数字不对"，却说不出"关系哪里破了"。现算之后，加一张业务表 ⇒
     下面各条同时变红并**指名那张表** ⇒ 逼着先定"它算业务表还是簿记表"（与本题裁定同路）。
     **可证伪（`D22`）**：把任一张业务表从 `REQUIRED_TABLES` **内存删掉** ⇒ 必红并指名它
     （见本节末的 `E123 D22`）。 */
  {
    const rel = gaugeRelation(declaredTables, REQUIRED_TABLES);
    t.check(`E123 口径关系（现算）：schema.sql ${rel.numbers.declared} 张 `
      + `− {schema_meta, auth_credential} = 业务表 ${rel.numbers.business} 张；`
      + `业务表 ＋ {auth_credential} = REQUIRED_TABLES ${rel.numbers.required} 张`
      + `（差集必须**恰好**是那两张，否则判红并列出实际差集）`,
      rel.ok,
      rel.problems.length ? rel.problems.join('；')
        : `${rel.numbers.arithmeticA}；${rel.numbers.arithmeticB}；`
          + `业务表 ${rel.numbers.business} 张：${rel.business.join('、')}`);

    /* `D22`：内存变异（**不动盘上任何字节**）—— 从 `REQUIRED_TABLES` 删掉一张业务表 */
    const D22_DROP = 'notice';
    const relMut = gaugeRelation(declaredTables, REQUIRED_TABLES.filter(x => x !== D22_DROP));
    const namedDrop = relMut.problems.some(p => p.includes(D22_DROP));
    /* 盘上自证：本文件在本条前后逐字节相同（变异只发生在内存数组上） */
    const selfPath = path.join(env.paths.tests, 'db-check.js');
    const selfSha = b => require('node:crypto').createHash('sha256').update(b).digest('hex');
    const selfBytes = fs.readFileSync(selfPath);
    const selfSame = fs.readFileSync(selfPath).equals(selfBytes);
    t.check(`E123 D22（内存变异）：从 REQUIRED_TABLES 删掉业务表 \`${D22_DROP}\` ⇒ 判据**必红并指名它**；`
      + `未变异的当前源码同判据必绿；盘上文件逐字节未变`,
      !relMut.ok && namedDrop && rel.ok && selfSame && /'notice'/.test(selfBytes.toString('utf8')),
      `变异后 ok=${relMut.ok}（应 false）、命中问题 ${relMut.problems.length} 条、`
      + `其中指名 \`${D22_DROP}\`=${namedDrop}；未变异 ok=${rel.ok}（应 true）；`
      + `盘上 db-check.js sha256=${selfSha(selfBytes).slice(0, 12)}… 前后一致=${selfSame}；`
      + `变异后问题清单：${relMut.problems.join(' ｜ ') || '（空 ⇒ 判据没抓住）'}`);
  }

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
    /* `E117`（2026-10-04）：改用 `env.removeLinkSafe()` —— 它先 `lstatSync` 判"目录项自身"是不是链接
       （是链接 ⇒ **只拆链、不递归**），**不是**链接时走的仍是原来的 `rmSync(…, {recursive:true, force})`
       ⇒ 对"自建临时目录"这条正常路径**逐字等价**（`env.js` 的 `E46`/`E90` 段有实现与不变量说明）。
       本处 `lockDir` 是 `fs.mkdtempSync(tempRoot, 'openDb-lock-')` 刚建的一次性目录，
       **结构上不可能是链接**；改走安全删除是"即使判断错了也不会连带删到目标"的兜底，
       同时让 `harness-check` 的 `E103-B①` 判据不必再为它开存量豁免。 */
    try { env.removeLinkSafe(lockDir, { recursive: true, force: true }); removable = true; }
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
    /* 受控跳过校验：本用例要验的是**取号越界**那条路径（样本本身不是录入路径的真实输入），
       故显式走唯一出口（第 5 实参），不与 W4 的入库口判据互相干扰。 */
    standardRepo.addVersion(handle.db, {
      productCode: 'P-MAX', processCode: '', depthTypical: 1, depthUpperDev: 0.1, depthLowerDev: -0.1,
      speedTypical: 2, speedUpperDev: 0.1, speedLowerDev: -0.1
    }, '2026-09-19 10:00:00', NOW, { dangerouslySkipValidation: true });
  } catch (err) { overflowThrew = true; overflowKind = err.constructor.name; }
  let resumedAdd = null;
  try {
    resumedAdd = standardRepo.addVersion(handle.db, {
      productCode: 'P-AFTER-OVERFLOW', processCode: '', depthTypical: 1, depthUpperDev: 0.1,
      depthLowerDev: -0.1, speedTypical: 2, speedUpperDev: 0.1, speedLowerDev: -0.1
    }, '2026-09-19 10:00:00', NOW, { dangerouslySkipValidation: true });
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
    /* ⚠ 取值落在 **`board.config.js` 的 `standards.range` 内**（深度 [4, 6] m、速度 [3, 8] m/s）——
       W4 起 `addVersion` **默认**按量程校验（FR-3.19 第⑥步），量程外的入参会**正当地**被拒收。
       旧值（深度 12.60）是 V1.33 时代的演示值，在负责人 2026-09-22 把深度量程改定为 [4, 6] m 之后
       已越界：它当年能落库只因为入库口没校验（技术债 E16）。这里把**正常用例的样本**迁到区间内，
       而不是给它们挂"跳过校验"开关 —— 否则等于用一个开关把 E16 的判据又关掉。 */
    depthTypical: 5.00, depthUpperDev: 0.20, depthLowerDev: -0.20,
    speedTypical: 5.00, speedUpperDev: 0.30, speedLowerDev: -0.30
  };
  const stdV1 = standardRepo.addVersion(handle.db, appendBase, T1, NOW);
  const rowV1Snapshot = JSON.stringify(handle.db.prepare('SELECT * FROM standard WHERE id = ?').get(stdV1.id));
  t.check('DR-03：首版 addVersion 得 version_no=1，且按入参落 effective_from（生效时间由上层＝录入时刻给出）',
    stdV1.versionNo === 1 && stdV1.effectiveFrom === T1 && stdV1.id > 0,
    JSON.stringify(stdV1));

  const stdV2 = standardRepo.addVersion(handle.db, {
    ...appendBase, createdBy: '李娜', teamCode: '检验二班',
    depthTypical: 5.10, depthUpperDev: 0.30, depthLowerDev: -0.30,
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

  const stdV3 = standardRepo.addVersion(handle.db, { ...appendBase, depthTypical: 5.60 }, T3, NOW);
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
    content: '深度上下限 4.80～5.20', result: '成功', teamCode: TEAM_A
  }, NOW);
  opLogRepo.append(handle.db, {
    opTime: '2026-09-19 09:05:00', operator: '张伟', opType: '参数配置',
    content: '标准临近比例 15%', result: '成功', teamCode: TEAM_A
  }, NOW);
  opLogRepo.append(handle.db, {
    opTime: '2026-09-19 09:10:00', operator: '李娜', opType: '标准录入',
    content: '速度上下限 4.70～5.30', result: '成功', teamCode: TEAM_B
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
    teamARows.map(r => r.content).join('|') === '深度上下限 4.80～5.20|标准临近比例 15%',
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
  t.check('IF-B.5：完整标准 uclValue/lclValue 取**绝对值**（典型值±偏差）—— 深度 5.00±0.20 ⇒ 5.20/4.80、' +
    '速度 5.00±0.30 ⇒ 5.30/4.70；IsPass 由判定侧透传（true/false/未判定 null）',
    mesDepth.uclValue === 5.2 && mesDepth.lclValue === 4.8 && mesDepth.IsPass === true &&
    mesSpeed.uclValue === 5.3 && mesSpeed.lclValue === 4.7 && mesSpeed.IsPass === false &&
    standardSvc.mesLimits(completeStd, { kind: 'depth' }).IsPass === null,
    `depth=${JSON.stringify(mesDepth)}，speed=${JSON.stringify(mesSpeed)}，` +
    `未传 pass=${JSON.stringify(standardSvc.mesLimits(completeStd, { kind: 'depth' }).IsPass)}`);

  /* IF-B.5 点名的**三类缺失组合**（C-78 原文）：①只设偏差未设典型值 ②只设上偏差 ③只设一项指标。
     三类都必须在**两条 dataList（depth/speed）**上整条占位 —— 且 pass=true 也必须被占位覆盖，
     否则等于"带着半套标准去判定"，正是 MES 侧无从判断的情形。
     ⚠ 这三行是**故意畸形**的入库样本（"只设上偏差"＝ C-78 点名的**兼容旧数据的防御分支**）：
     W4 起 `addVersion` **默认**会正当地拒收它们（E16 入库口强制校验，见下方 W4 段），
     故这里必须走**显式的受控跳过出口**（第 5 实参），且每次跳过都在自检里留痕 ——
     不是"把校验关掉好让用例过"，而是"明知畸形、要验的是读取侧口径"。 */
  const HALF_FIXTURE_OPTS = {
    dangerouslySkipValidation: true,
    note: 'IF-B.5 占位用例的**畸形入库样本**（C-78 的"只设上偏差"防御分支）—— 受控跳过校验'
  };
  standardRepo.addVersion(handle.db, {
    productCode: 'P-HALF-METRIC', processCode: '',
    depthTypical: 5.00, depthUpperDev: 0.20, depthLowerDev: -0.20
  }, T1, NOW, HALF_FIXTURE_OPTS);
  standardRepo.addVersion(handle.db, {
    productCode: 'P-HALF-UPPER', processCode: '', depthUpperDev: 0.60, speedUpperDev: 0.30
  }, T1, NOW, HALF_FIXTURE_OPTS);
  standardRepo.addVersion(handle.db, {
    productCode: 'P-HALF-NOTYP', processCode: '',
    depthUpperDev: 0.20, depthLowerDev: -0.20, speedUpperDev: 0.30, speedLowerDev: -0.30
  }, T1, NOW, HALF_FIXTURE_OPTS);
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
     可证伪点：若 isComplete 被放宽成"该指标齐即可"，这里 depth 会返回 5.20/4.80（不再占位）而红。 */
  const stdOnlyOneMetric = incompleteStds[0];
  const absDepth = standardSvc.absoluteLimits(stdOnlyOneMetric).depth;
  t.check('IF-B.5：占位是**整条**而不是"缺哪个补哪个" —— 深度自身完整（绝对值可算出 5.20/4.80）但速度缺项 ⇒ 该条 depth 也占位',
    Boolean(absDepth) && absDepth.upper === 5.2 && absDepth.lower === 4.8 &&
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
      { depthTypical: 5.0, depthUpperDev: 0.2 },
      { depthUpperDev: 0.6 },
      { depthTypical: 5.0, depthUpperDev: 0.2, depthLowerDev: -0.2, speedUpperDev: 0.3 }
    ];
    let halfRejected = 0;
    for (const bad of halfInputs) {
      try { standardSvc.assertInput(bad); } catch { halfRejected++; }
    }
    let okAccepted = false;
    try {
      okAccepted = standardSvc.assertInput({
        depthTypical: 5.0, depthUpperDev: 0.2, depthLowerDev: -0.2,
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
      /* ⚠ 前两条是**符号填反**的样本、第三条是**超量程**的样本：W4 起量程校验默认参与，
         故第三条按"量程"拒收即可 —— 本条只要求"非法一律抛错"，不复判是哪一项判据拦下的
         （量程判据的逐条对账在下方 W4 段）。 */
      const badLimits = [
        { depthTypical: 5.0, depthUpperDev: -0.1, depthLowerDev: 0.1,
          speedTypical: 5.0, speedUpperDev: 0.3, speedLowerDev: -0.3 },
        { depthTypical: 5.0, depthUpperDev: 0.5, depthLowerDev: 0.2,
          speedTypical: 5.0, speedUpperDev: 0.3, speedLowerDev: -0.3 },
        { depthTypical: 12.6, depthUpperDev: 0.2, depthLowerDev: -0.2,
          speedTypical: 5.0, speedUpperDev: 0.3, speedLowerDev: -0.3 }
      ];
      let limitThrew = 0;
      for (const bad of badLimits) {
        try { standardSvc.assertLimits(bad); } catch { limitThrew++; }
      }
      return limitThrew === badLimits.length;
    })(), '3/3 抛错（前两条：下限 5.10 > 上限 4.90／典型值 5.00 不在 [5.20, 5.50]；第三条：量程外）');

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
       判据＝列真的补上了 **且旧留痕行一行没丢、原字段原样、新列为 NULL**（补列不是重建表）。
       ⚠ W5-③（E18）后旧库会**多出一条**留痕：迁移前的强制备份会写 `op_type='迁移前备份'` 的审计行
       （补列在它之后，故那条走的是兼容插入、`team_code` 同样是 NULL）。故行数由 1 变 2 —— 这里把
       "多出来的那条**只能是** E18 审计行"一并钉住（这是**加强**而不是放宽：原来只数行数，现在逐条点名）。 */
    const legacyOpLogCols = db.listColumns(legacy.db, 'op_log');
    const legacyOpLogRows = legacy.db.prepare('SELECT * FROM op_log ORDER BY id').all();
    const legacyAuditRows = opLogRepo.list(legacy.db, { opType: db.PRE_MIGRATION_BACKUP_OP_TYPE });
    const legacyFirst = legacyOpLogRows[0];
    const legacyTeamIndex = Boolean(legacy.db.prepare(
      "SELECT 1 AS hit FROM sqlite_master WHERE type = 'index' AND name = 'ix_op_log_team'").get());
    t.check('DR-12：旧库（op_log 无 team_code）经 initSchema 后列补齐且索引起来，**迁移前就存在的那条**留痕一行不丢、' +
      '原字段原样、team_code 为 NULL；新增的只允许是 E18「迁移前备份」审计行（故行数 1 → 2，逐条点名而非只数行数）',
      legacyOpLogCols.includes('team_code') && legacyTeamIndex &&
      legacyOpLogRows.length === 2 &&
      legacyFirst.op_type === '解锁' &&
      legacyFirst.content === '旧库留痕行（无班组列）' &&
      legacyFirst.operator === '张伟' && legacyFirst.team_code === null &&
      legacyAuditRows.length === 1 && legacyAuditRows[0].result === '成功' &&
      legacyOpLogRows[1].op_type === db.PRE_MIGRATION_BACKUP_OP_TYPE,
      `列=[${legacyOpLogCols.join(', ')}]，索引=${legacyTeamIndex}，` +
      `行=[${legacyOpLogRows.map(r => r.op_type).join(' / ')}]`);
  }
  legacy.close();   // 夹具自有连接：不关会在 Windows 上锁住临时目录（ADR-0003 D17）

/* ---------------- 六之八、DR-04 件序号 `unit_index` 的旧库升级路径（V1.41 / C-111，技术债 `E69`） ----------------
   立案：`measure_rt` 的件序号是 **V1.41 新增的列**，而 `schema.sql` 的 `CREATE TABLE IF NOT EXISTS`
   对**已存在的旧表是空操作** —— 旧库不会凭空长出这一列。若只有 `schema.sql` 而没有补列步骤，
   旧库升级后带该列的落库语句会报 `table measure_rt has no column named unit_index`
   ⇒ **采集链每帧失败**（不是"少记一个件序号"这种可容忍降级）。故本条把"旧库补列"这条路径
   变成可复跑断言：补列后**列在、既有行一行不丢、该列为 NULL（零回填）**，且这次升级命中
   `planMigration()` 的"结构版本升级"判据（E18 迁移前**强制备份**不可跳过）。
   手法：先按**当前**结构建库 + 写一行，再把它退回**上一版形态**（`DROP COLUMN unit_index` ＋
   `schema_version` 改成上一版）—— 旧形态由当前结构**现推**，不手写一份会随 schema 漂移的旧 DDL；
   版本号同样**现算**（`SCHEMA_VERSION − 1`），故以后再升版本段不用改。 */
  t.section('六之八、DR-04 件序号 `unit_index` 的旧库升级路径（V1.41 / C-111）');
  {
    const legacyUid = makeTempDb({ name: 'legacy-unit-index' });
    db.initSchema(legacyUid.db, NOW);
    const uidColsBefore = db.listColumns(legacyUid.db, 'measure_rt');
    legacyUid.db.prepare(
      `INSERT INTO measure_rt(equip_code, proc_order_no, unit_index, measure_depth, speed, collect_time, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`
    ).run('EQ-OLD', 'WO-OLD', 7, 5.25, 6.5, '2026-09-01 08:00:00', NOW);
    legacyUid.db.exec('ALTER TABLE measure_rt DROP COLUMN unit_index');   // 退回 V1.41 之前的列集
    const uidPrevVersion = String(Number(SCHEMA_VERSION) - 1);
    legacyUid.db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?')
      .run(uidPrevVersion, 'schema_version');
    const uidColsLegacy = db.listColumns(legacyUid.db, 'measure_rt');
    const uidPlanBefore = db.planMigration(legacyUid.db);
    if (t.requires('旧库前提：`measure_rt` 确已退回"无 `unit_index`"的旧形态、且库内结构版本＝上一版',
      uidColsBefore.includes('unit_index') && !uidColsLegacy.includes('unit_index') &&
      db.getSchemaVersion(legacyUid.db) === uidPrevVersion,
      `退回前列含 unit_index=${uidColsBefore.includes('unit_index')}；退回后列=[${uidColsLegacy.join(', ')}]；` +
      `库内版本=${db.getSchemaVersion(legacyUid.db)}（期望上一版 ${uidPrevVersion}）；当前 SCHEMA_VERSION=${SCHEMA_VERSION}`)) {
      const uidInit = db.initSchema(legacyUid.db, NOW);
      const uidColsAfter = db.listColumns(legacyUid.db, 'measure_rt');
      const uidRow = legacyUid.db.prepare(
        'SELECT * FROM measure_rt WHERE equip_code = ? AND proc_order_no = ?').get('EQ-OLD', 'WO-OLD');
      const uidRows = legacyUid.db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
      t.check('DR-04（V1.41 / C-111）：旧库（`measure_rt` 无 `unit_index`）经 `initSchema()` **补列** —— ' +
        '列补上了、**既有行一行不丢且逐列原样**、而该列是 `NULL`（**零回填**：绝不拿 0/1 冒充件序号，' +
        '否则一票 N 件会被静默归并成一件）',
        uidColsAfter.includes('unit_index') && uidRows === 1 && Boolean(uidRow) &&
        uidRow.unit_index === null && uidRow.measure_depth === 5.25 && uidRow.speed === 6.5 &&
        uidRow.collect_time === '2026-09-01 08:00:00',
        `退回时列=[${uidColsLegacy.join(', ')}] ⇒ 补列后列=[${uidColsAfter.join(', ')}]；` +
        `行数=${uidRows}、行=${JSON.stringify(uidRow)}`);

      t.check('DR-04/E18（V1.41 / C-111）：旧库的"结构版本升级（上一版 → 当前版）"**命中迁移计划并强制备份**，' +
        '升级后库内版本＝`SCHEMA_VERSION`、结构一致性校验通过（`schema.sql` 一改就必须升版本）',
        uidPlanBefore.needed === true &&
        uidPlanBefore.reasons.some(r => r.includes(`结构版本升级 ${uidPrevVersion} → ${SCHEMA_VERSION}`)) &&
        uidInit.migrationPlan.needed === true &&
        Boolean(uidInit.preMigrationBackup && uidInit.preMigrationBackup.path) &&
        fs.existsSync(uidInit.preMigrationBackup.path) && uidInit.preMigrationBackup.bytes > 0 &&
        db.getSchemaVersion(legacyUid.db) === SCHEMA_VERSION &&
        db.verifySchemaConsistency(legacyUid.db).ok === true,
        `升级计划原因=${JSON.stringify(uidPlanBefore.reasons)}；备份=${uidInit.preMigrationBackup && uidInit.preMigrationBackup.path}` +
        `（${uidInit.preMigrationBackup && uidInit.preMigrationBackup.bytes} 字节）；` +
        `升级后库内版本=${db.getSchemaVersion(legacyUid.db)}；` +
        `verifySchemaConsistency=${JSON.stringify(db.verifySchemaConsistency(legacyUid.db))}`);
    }
    legacyUid.close();
  }

/* ---------------- 六之九、9.5 第 6 条（数据结构变更约束）的**静态**配套门禁 ----------------
   立案：规范 v1.34 的 **9.5 第 6 条**（2026-10-01 新增）要求"改 `schema.sql`（增/删/改列或表）
   必须**同批**做两件事 ①升 `SCHEMA_VERSION` ②在 `STRUCTURE_UPGRADES` 加对应的幂等迁移步骤"，
   并**点名**配套门禁：`schema.sql` 里「老库形态缺、新库形态有」的列，必须在 `STRUCTURE_UPGRADES`
   里有对应步骤（由座位 4b 补，配 D22 变异反证）。现状是：①那半句由 `verifySchemaConsistency()`
   （库内结构版本 ↔ 声明）＋本章第一节的指纹断言守着；**②这半句此前没有任何门禁** ——
   `2026-09-30` 的 `E69` 轮 D22 M7（删掉 `ALTER TABLE measure_rt ADD COLUMN unit_index INTEGER`）
   能变红，靠的是本章**六之八**那条**运行期**断言（真临时库 + 真 `initSchema`），
   而本仓当时的缺陷形态恰恰是"开发机新建库天然不需要那一步、只有现场老库需要"
   （后果：老库每帧落库失败 `table measure_rt has no column named unit_index`），属**环境差异型**故障。
   故本条要的是**静态兜底**：**不建库、不跑 `initSchema()`**，只读 `schema.sql` 正文
   ＋ `server/db/index.js` 导出的 `STRUCTURE_UPGRADES`（＝`initSchema()` 真正执行的那份清单）
   ＋ 手写的老库基线 `LEGACY_BASELINE_COLUMNS`，所以**没有老库也能红**。它抓的正是规则要堵的形态：
   **"改了正本（`schema.sql`）、忘了迁移步骤"**（新增列落在基线之外 ⇒ 必须找到步骤）。
   判据（两个方向都要，缺一即为空洞）：
     正方向 —— `schema.sql` 声明的列 ∉ 老库基线 ⇒ 必须能在 `STRUCTURE_UPGRADES` 里找到
               同表同列的 `ADD COLUMN` 步骤；
     反方向 —— `STRUCTURE_UPGRADES` 的每条 `ADD COLUMN` 指向的表/列必须真实存在于 `schema.sql`
               （不许"给不存在的列补列"的死步骤），且该列**不得**同时出现在基线里
               （同一件事两处说法相反 ⇒ 要么步骤是死步骤、要么基线过宽而对本门禁失明）。
   边界（如实登记，不冒领）：①"改列类型/约束"（列集不变）**不在**本条判据内 —— 它没有
   `ADD COLUMN` 形态的步骤可查，属 9.5 第 6 条的评审纪律范围；②"删列"由"基线列 ⊆ `schema.sql` 列"
   那一条**兜住注意义务**（必须清理基线、并按规则给删列迁移步骤），但不假装能机器判定删列步骤写对没写对。 */
  t.section('六之九、9.5 第 6 条静态门禁（改 `schema.sql` 必须同批给迁移步骤；不建库、不跑 `initSchema`）');
  {
    /* ① `schema.sql` 侧：表 → 列集。复用本章既有的解析器（第一节、六之三用的是同一套，
       不另写一份会漂移的正则）。 */
    const schemaSqlText = db.readSchemaSql();
    const declaredNow = parseSchemaTables(schemaSqlText);
    const schemaCols = {};
    for (const table of declaredNow) schemaCols[table] = parseSchemaColumns(schemaSqlText, table);

    /* ② 步骤侧：解析 `initSchema()` 真正执行的那份清单（导出的数组本身，不是从源码文本另抄一份）。 */
    const addColumnSteps = [];
    const unclassifiedSteps = [];
    for (const raw of db.STRUCTURE_UPGRADES) {
      const m = /^\s*ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/i
        .exec(String(raw));
      if (m) { addColumnSteps.push({ table: m[1], col: m[2], raw: String(raw).trim() }); continue; }
      /* 除"补列"外本仓只允许"建索引"一类；出现别的形态必须**当场红** —— 否则新形态会被本段
         静默忽略（解析器腐烂 ⇒ 后面的判据全部假绿，正是 ADR-0004 D23 要防的"静态防空洞"）。 */
      if (!/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(String(raw))) {
        unclassifiedSteps.push(String(raw).trim());
      }
    }
    const stepColsOf = table => addColumnSteps.filter(s => s.table === table).map(s => s.col);
    const indexSteps = db.STRUCTURE_UPGRADES.length - addColumnSteps.length - unclassifiedSteps.length;

    /* ③ 解析器不空转（表数对得上、每张表都解析出非空列集）—— 否则下面的判据会变成假红或假绿。 */
    const emptyParsed = declaredNow.filter(tb => schemaCols[tb].length === 0);
    t.check('六之九/静态：`schema.sql` 声明的每张表都解析出**非空**列集（解析器不空转 —— ' +
      '否则"正方向"会把整表列都算成"缺步骤"、或反过来变成假绿）',
      declaredNow.length > 0 && emptyParsed.length === 0,
      `表数=${declaredNow.length}${emptyParsed.length ? `；解析为空列集的表：${emptyParsed.join(', ')}` : ''}`);

    t.check(`六之九/静态：\`STRUCTURE_UPGRADES\` 的 ${db.STRUCTURE_UPGRADES.length} 条步骤每条都能被分类为` +
      '「补列」或「建索引」（新形态步骤必须在本段**当场登记**，不得被静默忽略）',
      unclassifiedSteps.length === 0,
      unclassifiedSteps.length ? `未分类步骤：${unclassifiedSteps.join(' | ')}`
        : `补列 ${addColumnSteps.length} 条（${addColumnSteps.map(s => `${s.table}.${s.col}`).join('、')}）；` +
          `建索引 ${indexSteps} 条`);

    /* ④ 基线自身的完整性：表集必须与 `schema.sql` 完全一致（新增表要明确分类、删表要同批删基线行）。 */
    const baselineTables = Object.keys(LEGACY_BASELINE_COLUMNS);
    const tablesOnlyInSchema = declaredNow.filter(tb => !baselineTables.includes(tb));
    const tablesOnlyInBaseline = baselineTables.filter(tb => !declaredNow.includes(tb));
    const tableDiffDetail = [];
    if (tablesOnlyInSchema.length) tableDiffDetail.push(`schema.sql 有而基线未分类：${tablesOnlyInSchema.join(', ')}`);
    if (tablesOnlyInBaseline.length) tableDiffDetail.push(`基线有而 schema.sql 已无：${tablesOnlyInBaseline.join(', ')}`);
    t.check('六之九/静态：老库基线的表集 = `schema.sql` 声明的表集（新增表必须在 ' +
      '`LEGACY_BASELINE_COLUMNS` 里明确分类；删表必须同批删掉基线行）',
      tablesOnlyInSchema.length === 0 && tablesOnlyInBaseline.length === 0,
      tableDiffDetail.length ? tableDiffDetail.join('；') : `两处都是 ${declaredNow.length} 张表`);

    /* ⑤ 基线列必须真实存在（删列/改列名后基线里的陈旧行必须同批清理）。 */
    const staleBaselineCols = [];
    for (const [table, cols] of Object.entries(LEGACY_BASELINE_COLUMNS)) {
      if (!schemaCols[table]) continue;                       // 表级差异由④点名，这里不重复报
      for (const col of cols) if (!schemaCols[table].includes(col)) staleBaselineCols.push(`${table}.${col}`);
    }
    t.check('六之九/静态：基线里每一列都仍存在于 `schema.sql`（**删列/改列名**后必须同批清理基线的' +
      '陈旧行，并按 9.5 第 6 条给该变更本身的迁移步骤）',
      staleBaselineCols.length === 0,
      staleBaselineCols.length ? `基线里的陈旧列：${staleBaselineCols.join('、')}（schema.sql 已无这些列）`
        : '无陈旧列');

    /* ⑥ **正方向**（本门禁的主判据）：基线之外的列 ⇒ 必须有同表同列的 `ADD COLUMN` 步骤。
       可证伪点：①删掉 `STRUCTURE_UPGRADES` 里某条 `ADD COLUMN`（D22 的 M7）；②往 `schema.sql`
       加一列而不动 `STRUCTURE_UPGRADES`（M8"改了正本、忘了迁移"）—— 两者都必红，且**不需要**
       任何真库或 `initSchema()`（这正是本条相对六之八那条运行期断言的意义）。 */
    const colsNeedingSteps = [];
    const colsMissingSteps = [];
    for (const [table, cols] of Object.entries(LEGACY_BASELINE_COLUMNS)) {
      if (!schemaCols[table]) continue;
      const baseline = new Set(cols);
      const steps = new Set(stepColsOf(table));
      for (const col of schemaCols[table]) {
        if (baseline.has(col)) continue;                      // 老库一定有 ⇒ 无需步骤
        colsNeedingSteps.push(`${table}.${col}`);
        if (!steps.has(col)) colsMissingSteps.push(`${table}.${col}`);
      }
    }
    t.check('六之九/静态/**正方向**：`schema.sql` 里"老库基线之外"的列（＝只能由迁移步骤交付的新列）' +
      '在 `STRUCTURE_UPGRADES` 里都有同表同列的 `ADD COLUMN` 步骤（**改了正本、忘了迁移 ⇒ 必红**；' +
      '不建库、不跑 `initSchema()` ⇒ 没有老库也能红）',
      colsMissingSteps.length === 0,
      colsMissingSteps.length
        ? `缺补列步骤：${colsMissingSteps.join('、')}（须在 server/db/index.js 的 STRUCTURE_UPGRADES 里补 ` +
          '`ALTER TABLE … ADD COLUMN …` 并同批升 SCHEMA_VERSION）'
        : `须由步骤交付的列=[${colsNeedingSteps.join('、')}]，均有步骤`);

    /* ⑦ **反方向**：不许"给 `schema.sql` 里不存在的列补列"的死步骤（步骤清单与结构正本必须对得上）。 */
    const stepsWithoutColumn = addColumnSteps.filter(s =>
      !schemaCols[s.table] || !schemaCols[s.table].includes(s.col));
    t.check('六之九/静态/**反方向**：`STRUCTURE_UPGRADES` 每条 `ADD COLUMN` 指向的表/列都真实存在于 ' +
      '`schema.sql`（不许"给不存在的列补列"的死步骤 —— 那种步骤要么永远报错、要么悄悄建出结构正本' +
      '之外的列）',
      stepsWithoutColumn.length === 0,
      stepsWithoutColumn.length
        ? `指向 schema.sql 里不存在的列：${stepsWithoutColumn.map(s => `${s.table}.${s.col}`).join('、')}`
        : `每条都落在 schema.sql 上：${addColumnSteps.map(s => `${s.table}.${s.col}`).join('、') || '（无补列步骤）'}`);

    /* ⑧ 口径一致：有步骤的列不得同时被基线声称"老库已有"（两处说法相反时必红 —— 要么步骤是死步骤，
       要么基线过宽、对本门禁失明；真需要给**更老**的库补列时，正确动作是**收窄基线**、不是删步骤）。 */
    const baselineConflicts = addColumnSteps.filter(s =>
      (LEGACY_BASELINE_COLUMNS[s.table] || []).includes(s.col));
    t.check('六之九/静态/口径一致：带 `ADD COLUMN` 步骤的列**不得**同时写在老库基线里（同一件事两处' +
      '说法相反 ⇒ 要么步骤是死步骤，要么基线过宽而对本门禁失明）',
      baselineConflicts.length === 0,
      baselineConflicts.length
        ? `两处都声明：${baselineConflicts.map(s => `${s.table}.${s.col}`).join('、')}` +
          '（若确需给更老的库补列，请从 LEGACY_BASELINE_COLUMNS 里删掉该列，而不是删掉步骤）'
        : `${addColumnSteps.length} 条补列步骤与基线无重叠`);
  }

/* ---------------- 六之十、`STRUCTURE_UPGRADES` 步骤形态白名单（E74）的**门禁级**断言 ----------------
   立案：技术债 `E74`（`STRUCTURE_UPGRADES` 对"改列类型／删列"不够用、且失败方式**静默**；由座位 5 在
   `T-20260930-24` 的 C·12.6③ 提出并实测出"静默三连"）。座位 6 在 `T-20260930-27` 把判据**实现并导出**
   （`UPGRADE_STEP_FORMS` / `classifyUpgradeStep()` / `assertUpgradeStepShape()`），判定点落在
   `initSchema()` 的步骤循环里、`db.exec(step)` **之前**、且**在**容忍 `duplicate column name|already exists`
   的那个 `try` **之外**。本节把那套判据从"探针级证据"升级为**门禁级可证伪断言**（三条）：
     ① 清单全过 —— `STRUCTURE_UPGRADES` 里**每一条**步骤都被 `classifyUpgradeStep()` 接受。
        **条数在运行期读出并打印**（不写死 —— D21）；条件是"条数 > 0 且 0 条被拒 且 kind/form 自洽"
        （`>0` 是**非空转**要求：清单空了这条不许假绿，D23）。
     ② 真值表 —— 对 `classifyUpgradeStep()` / `assertUpgradeStepShape()` 逐条断言语义。
        **期望值构成性给出（D21）**：接受样例一律由**清单里真实存在的步骤**变换而来（`swapCase`／
        `toLowerCase`／`toUpperCase`／空白加宽／首尾空白／`;`／标识符引号／`CREATE UNIQUE`），
        **期望 kind 与源步骤相同**（不手抄魔数）；拒绝样例的期望＝`ok:false` ＋ `kind:'unsupported'`
        ＋ `form:null` ＋ 非空 `reason` ＋ `assertUpgradeStepShape()` **必抛**，且抛错消息必须含
        **步骤原文**（由输入算出）、**全部允许形态**（由 `UPGRADE_STEP_FORMS` 算出）、
        **重建迁移函数的真名**（由模块导出里 `migrate*` 那个名字算出）。多语句夹带那两条另配
        **反事实对照**：把夹带部分去掉后的前缀**必须被接受** ⇒ 证明"被拒"是因为夹带，不是因为前缀。
     ③ 守门被接线（**静态**）—— 调用点确实在步骤循环体内、在 `db.exec(step)` **之前**、且**不在**
        容忍 `duplicate column` 的 `try` 块内。做法仿 9.5-5「门禁机制必须可达」的先例
        （`tests\harness-check.js` 第十节之二：比较源码字符下标），但**本文件必须先去注释** ——
        `server\db\index.js` 的注释里就写着 `db.exec(step)`（docblock）与 `assertUpgradeStepShape()`
        （清单 docblock），不去注释就会把注释里的字样当成"调用点"（"删了却还是绿"）。
   可证伪性（D22，靶子见 `tests\._verify\zz4b7-d22-mutation.js`，**九组** —— 9 条断言每条都有靶子）：
     M-A 删掉判定点那一行 ⇒ ③①②③三条接线断言必红（含"调用点唯一"）；
     M-C 把判定点挪进容忍 `duplicate column` 的 `try` 内 ⇒ ③③ 必红；
     M-D 把判定点挪到 `db.exec(step)` **之后** ⇒ ③② 必红；
     M-E 把 `assertUpgradeStepShape()` 改成不抛（直接返回分类结果）⇒ ② 的**拒绝项**必红；
     M-I 把容忍 catch 改成"全吞"（删掉重抛那一支）⇒ ③④ 必红；
     M-F 往白名单塞一条**同 kind 的重复形态** ⇒ ① 与 ② 的**接受项**必红（汇总级）；
     M-G（对**本文件**自变异）去注释扫描器连行尾 `\r` 一起抹 ⇒ ③⓪ 必红；
     M-H（对**本文件**自变异）删掉真值表里"空串"那一类拒绝样例 ⇒ ② 的**覆盖**必红。
     **M-B 的如实登记**：往清单末尾追加一条违规步骤（`ALTER TABLE upload_log DROP COLUMN fail_reason`）时，
     `db-check` 在**第一节** `:347` 的 `initSchema()` 就当场抛错中止（**无汇总行**、退 1、栈帧指向 `main`）
     ⇒ **走不到**六之十，① 拿不到汇总级红；故 M-B 按"门禁中止 ＋ ① 的**判据级**探针为 false"取证，
     ① 的**汇总级**可证伪性由 **M-F** 补证。
   边界（如实登记，不冒领）：
     · ①② 只证"**判据函数**对给定样例给出正确判定"，**不证**"白名单够宽" —— 未来合法的**新**形态会被
       当场拒，这是**设计意图**（扩白名单＝改契约，必须同批配 D22），门禁证不了"白名单够宽"；
     · ③ 只证"**源码文本**里调用点的位置与唯一性"，**不证**运行期确实执行过（运行期证据在座位 6 的
       探针 `tests\._verify\zz6e-whitelist-probe.js` 与本章六之八的运行期断言里）；
     · 本节的判据**只覆盖 `ADD COLUMN`／`CREATE INDEX IF NOT EXISTS` 两种形态**（与 9.5 第 6 条
       v1.35 "覆盖面"一致）：**改列类型／删列**必须走重建迁移函数 ＋ 评审纪律，
       **不得**据此推断"门禁绿 ＝ 结构变更全部已迁移"（ADR-0004 D19）。 */
  t.section('六之十、`STRUCTURE_UPGRADES` 步骤形态白名单（E74）的门禁级断言（清单全过／真值表／守门接线）');
  {
    /* 判据的**唯一真源**＝模块导出（不是从源码文本另抄一份会漂移的正则）。 */
    const forms = db.UPGRADE_STEP_FORMS;
    const formWhatOfKind = new Map(forms.map(f => [f.kind, f.what]));
    const declaredKinds = forms.map(f => f.kind);
    const steps = Array.from(db.STRUCTURE_UPGRADES, s => String(s));

    /* ---------- ① 清单全过（"以后有人往清单里加违规步骤"的兜底） ---------- */
    const stepVerdicts = steps.map(s => db.classifyUpgradeStep(s));
    const rejectedSteps = [];
    const inconsistentSteps = [];
    const stepKindCount = {};
    steps.forEach((s, i) => {
      const v = stepVerdicts[i];
      if (!v || v.ok !== true) {
        rejectedSteps.push(`${JSON.stringify(s)}（${v ? v.reason : '判据没返回结果'}）`);
        return;
      }
      if (formWhatOfKind.get(v.kind) !== v.form) {
        inconsistentSteps.push(`${JSON.stringify(s)}（kind=${v.kind}、form=${JSON.stringify(v.form)}，` +
          '与 `UPGRADE_STEP_FORMS` 里同 kind 的 `what` 不一致）');
      }
      stepKindCount[v.kind] = (stepKindCount[v.kind] || 0) + 1;
    });
    t.check(`六之十/清单：\`STRUCTURE_UPGRADES\` 的 ${steps.length} 条步骤**逐条**通过 \`classifyUpgradeStep()\`` +
      '（＝`initSchema()` 真会执行的那份清单；**以后有人往清单里加违规步骤 ⇒ 必红**）',
      steps.length > 0 && rejectedSteps.length === 0 && inconsistentSteps.length === 0,
      rejectedSteps.length || inconsistentSteps.length
        ? [...rejectedSteps.map(x => `被拒：${x}`), ...inconsistentSteps.map(x => `不自洽：${x}`)].join('；')
        : `${steps.length} 条全部通过；形态分布：` +
          (Object.entries(stepKindCount).map(([k, n]) => `${k} ${n} 条`).join('、') || '（空）'));

    /* ---------- ② 真值表（期望值构成性给出：接受样例由清单里的真实步骤变换而来） ---------- */
    const swapCase = s => s.replace(/[A-Za-z]/g, c => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    const widenSpaces = s => s.replace(/\s+/g, '   ');
    const srcAdd = steps.find(s => { const v = db.classifyUpgradeStep(s); return v.ok && v.kind === 'add-column'; });
    const srcIndex = steps.find(s => { const v = db.classifyUpgradeStep(s); return v.ok && v.kind === 'create-index'; });
    const NO_SRC = '（清单里没有该形态的真实步骤，接受样例无从构造 —— 这本身就是红）';
    const addParts = srcAdd ? /^ALTER\s+TABLE\s+(\S+)\s+ADD\s+COLUMN\s+(\S+)([\s\S]*)$/i.exec(srcAdd) : null;
    const quotedAdds = addParts
      ? [['"', '"'], ['`', '`'], ['[', ']']].map(([l, r]) => ({
        text: `ALTER TABLE ${l}${addParts[1]}${r} ADD COLUMN ${l}${addParts[2]}${r}${addParts[3]}`,
        kind: 'add-column',
        why: `标识符引号 ${l}…${r}`
      }))
      : [];
    const accepts = [
      { text: srcAdd || NO_SRC, kind: 'add-column', why: '清单原文（`ALTER TABLE … ADD COLUMN` 基本形）' },
      { text: srcIndex || NO_SRC, kind: 'create-index', why: '清单原文（`CREATE INDEX IF NOT EXISTS`）' },
      { text: srcAdd ? swapCase(srcAdd) : NO_SRC, kind: 'add-column', why: '大小写混写' },
      { text: srcAdd ? srcAdd.toLowerCase() : NO_SRC, kind: 'add-column', why: '全小写' },
      { text: srcAdd ? srcAdd.toUpperCase() : NO_SRC, kind: 'add-column', why: '全大写' },
      { text: srcIndex ? swapCase(srcIndex) : NO_SRC, kind: 'create-index', why: '索引句大小写混写' },
      { text: srcAdd ? widenSpaces(srcAdd) : NO_SRC, kind: 'add-column', why: '词间多余空白' },
      { text: srcAdd ? `\n\t${srcAdd}  \t` : NO_SRC, kind: 'add-column', why: '首尾空白／换行' },
      { text: srcAdd ? `${srcAdd};` : NO_SRC, kind: 'add-column', why: '允许**一个**结尾分号' },
      { text: srcIndex ? srcIndex.replace(/^(\s*)CREATE\s+/i, (m0, p1) => `${p1}CREATE UNIQUE `) : NO_SRC,
        kind: 'create-index', why: '`CREATE UNIQUE INDEX IF NOT EXISTS`' },
      ...quotedAdds
    ];
    const acceptProblems = [];
    for (const e of accepts) {
      const v = db.classifyUpgradeStep(e.text);
      if (!v || v.ok !== true || v.kind !== e.kind || v.form !== formWhatOfKind.get(e.kind)) {
        acceptProblems.push(`${e.why}：期望 kind=${e.kind}、form=${JSON.stringify(formWhatOfKind.get(e.kind))}，` +
          `实得 ${JSON.stringify({ ok: v && v.ok, kind: v && v.kind, form: v && v.form, reason: v && v.reason })}` +
          `（样例 ${JSON.stringify(e.text)}）`);
        continue;
      }
      let asserted = null;
      try {
        asserted = db.assertUpgradeStepShape(e.text);
      } catch (err) {
        acceptProblems.push(`${e.why}：\`assertUpgradeStepShape()\` 对**合法**步骤抛了错 —— ${err && err.message}`);
        continue;
      }
      if (!asserted || asserted.ok !== true || asserted.kind !== e.kind) {
        acceptProblems.push(`${e.why}：\`assertUpgradeStepShape()\` 的返回与 \`classifyUpgradeStep()\` 不一致` +
          `（${JSON.stringify(asserted)}）`);
      }
    }
    t.check(`六之十/真值表/**接受项**：${accepts.length} 条构造样例逐条被接受、kind／form 与**源步骤同形**` +
      '（清单原文／全大写／全小写／大小写混写／多余空白／首尾空白／三种标识符引号／`UNIQUE` 索引／结尾分号；' +
      '样例全部由清单里的真实步骤变换而来，D21）',
      accepts.length > 0 && acceptProblems.length === 0,
      acceptProblems.length ? acceptProblems.join('；')
        : `${accepts.length} 条全部通过（kind＝${declaredKinds.join('／')}）`);

    /* 拒绝项：六类任务包点名形态 ＋ 非字符串；多语句夹带两条另配"反事实对照"（去掉夹带后必须被接受）。 */
    const migrateExports = Object.keys(db).filter(k => /^migrate[A-Z]/.test(k));
    const DECLARED_REJECT_CATS = [
      '删列 DROP COLUMN', '改名 RENAME TO', '非 DDL（UPDATE）', '多语句夹带',
      '建索引缺 IF NOT EXISTS', '空串', '非字符串'
    ];
    const rejects = [
      { cat: '删列 DROP COLUMN', text: 'ALTER TABLE upload_log DROP COLUMN fail_reason' },
      { cat: '改名 RENAME TO', text: 'ALTER TABLE upload_log RENAME TO upload_log_old' },
      { cat: '非 DDL（UPDATE）', text: "UPDATE upload_log SET state = '待补传'" },
      { cat: '多语句夹带', text: 'ALTER TABLE t ADD COLUMN a TEXT; DROP TABLE t',
        counterfactual: 'ALTER TABLE t ADD COLUMN a TEXT' },
      { cat: '多语句夹带', text: srcAdd ? `${srcAdd}; DROP TABLE op_log` : NO_SRC, counterfactual: srcAdd },
      { cat: '建索引缺 IF NOT EXISTS', text: 'CREATE INDEX ix_x ON upload_log(upload_id)' },
      { cat: '空串', text: '' },
      { cat: '非字符串', text: null }
    ];
    const rejectProblems = [];
    for (const e of rejects) {
      const v = db.classifyUpgradeStep(e.text);
      const problems = [];
      if (!v || v.ok !== false) problems.push(`ok 应为 false，实得 ${JSON.stringify(v && v.ok)}`);
      if (v && v.kind !== 'unsupported') problems.push(`kind 应为 unsupported，实得 ${JSON.stringify(v.kind)}`);
      if (v && v.form !== null) problems.push(`form 应为 null，实得 ${JSON.stringify(v.form)}`);
      if (v && (typeof v.reason !== 'string' || !v.reason)) problems.push('reason 应为非空说明');
      /* 判据必须无副作用／可重复：同入参再判一次必须逐字节同结果。 */
      if (JSON.stringify(db.classifyUpgradeStep(e.text)) !== JSON.stringify(v)) {
        problems.push('同入参两次判定结果不一致（判据带状态？）');
      }
      let threw = null;
      let msg = '';
      try {
        db.assertUpgradeStepShape(e.text);
      } catch (err) {
        threw = err;
        msg = err && err.message ? err.message : String(err);
      }
      if (!threw) {
        problems.push('`assertUpgradeStepShape()` **没有抛错**（该形态必须当场炸，否则又回到"静默空转"）');
      } else {
        if (!msg.includes(JSON.stringify(e.text))) {
          problems.push(`抛错消息不含**步骤原文**（应含 ${JSON.stringify(JSON.stringify(e.text))}）`);
        }
        const missingForms = forms.filter(f => !msg.includes(f.what)).map(f => f.what);
        if (missingForms.length) problems.push(`抛错消息没写全**允许形态**：缺 ${missingForms.join(' ／ ')}`);
        if (!migrateExports.length) {
          problems.push('模块没有导出任何 `migrate*` 重建迁移函数，无从核对"正确出路"是否被点名');
        } else if (!migrateExports.some(n => msg.includes(n))) {
          problems.push(`抛错消息没点名**重建迁移函数**（导出里现有 ${migrateExports.join('／')}）`);
        }
      }
      if (e.counterfactual) {
        const cv = db.classifyUpgradeStep(e.counterfactual);
        if (!cv || cv.ok !== true) {
          problems.push(`反事实对照（去掉夹带后的 ${JSON.stringify(e.counterfactual)}）本应被接受，` +
            `实得 ${JSON.stringify(cv)}`);
        }
      }
      if (problems.length) rejectProblems.push(`${e.cat}｜${JSON.stringify(e.text)}：${problems.join('；')}`);
    }
    t.check(`六之十/真值表/**拒绝项**：${rejects.length} 条违规样例逐条判 ${'`unsupported`'}` +
      '（`ok:false` / `kind` / `form:null` / 非空 `reason` / 同入参两次同结果），且 `assertUpgradeStepShape()` ' +
      '**必抛**、消息带**步骤原文**＋**全部允许形态**＋**重建迁移函数真名**（多语句夹带另验"去掉夹带即被接受"）',
      rejects.length > 0 && rejectProblems.length === 0,
      rejectProblems.length ? rejectProblems.join('；')
        : `${rejects.length} 条全部按期望被拒（含 ${DECLARED_REJECT_CATS.join('／')}）`);

    const missingKinds = declaredKinds.filter(k => !accepts.some(e => e.kind === k));
    const missingCats = DECLARED_REJECT_CATS.filter(c => !rejects.some(e => e.cat === c));
    const strayCats = rejects.map(e => e.cat).filter(c => !DECLARED_REJECT_CATS.includes(c));
    t.check('六之十/真值表/**覆盖**：每种允许形态都有接受样例、每类违规（' + DECLARED_REJECT_CATS.join('／') +
      '）都有拒绝样例 —— 真值表**不空转**（D23：两张表任何一个为空 ⇒ 上面的"逐条"都是恒真）',
      forms.length > 0 && accepts.length >= forms.length && accepts.length > 0 && rejects.length > 0 &&
      missingKinds.length === 0 && missingCats.length === 0 && strayCats.length === 0,
      [
        missingKinds.length ? `没有接受样例的形态：${missingKinds.join('、')}` : '',
        missingCats.length ? `没有拒绝样例的违规类别：${missingCats.join('、')}` : '',
        strayCats.length ? `未登记的违规类别：${strayCats.join('、')}` : ''
      ].filter(Boolean).join('；') ||
      `允许形态 ${forms.length} 种（接受样例 ${accepts.length} 条）、违规类别 ${DECLARED_REJECT_CATS.length} 类` +
      `（拒绝样例 ${rejects.length} 条）`);

    /* ---------- ③ 守门被接线（静态：比源码字符下标，**先去注释**） ---------- */
    /* 单趟扫描：`code` ＝ 把 `//` 与块注释抹成**等长空白**的副本（**字符下标不变**）；
       `mask[i]=1` ＝ 该下标属真代码（注释、字符串/模板串内容、正则内容都是 0）。
       为什么必须去注释：`server\db\index.js` 的注释里就写着 `db.exec(step)` 与 `assertUpgradeStepShape()`，
       直接对原文比下标会把"注释里的字样"算成调用点 ⇒ 调用点被删了、静态断言却照样绿。 */
    const scanJs = (src) => {
      const chars = src.split('');
      const mask = new Uint8Array(src.length);
      let prev = '';
      let i = 0;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '/' && src[i + 1] === '/') {
          /* 行尾的 `\r` 必须留着（本仓工作区是 CRLF）：否则"抹注释"会顺手改掉行尾，
             行数/下标虽不变，`\r\n` 却退化成 `\n` —— 自检那条"行数相等"就是为此而设。 */
          while (i < src.length && src[i] !== '\n') {
            if (src[i] !== '\r') chars[i] = ' ';
            i++;
          }
          continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
          while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
            if (src[i] !== '\n' && src[i] !== '\r') chars[i] = ' ';
            i++;
          }
          if (i < src.length) { chars[i] = ' '; chars[i + 1] = ' '; i += 2; }
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {                 /* 字符串/模板串：内容不算代码 */
          mask[i] = 1;
          i++;
          while (i < src.length && src[i] !== ch) {
            if (src[i] === '\\') { i += 2; continue; }
            i++;
          }
          if (i < src.length) { mask[i] = 1; i++; }
          prev = ch;
          continue;
        }
        if (ch === '/' && (prev === '' || /[=(,:[!&|?{};+\-*%~^<>]/.test(prev))) {   /* 正则字面量 */
          mask[i] = 1;
          i++;
          let inClass = false;
          while (i < src.length) {
            const c = src[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '\n') break;
            mask[i] = 1;
            if (c === '[') inClass = true;
            else if (c === ']') inClass = false;
            i++;
            if (c === '/' && !inClass) break;
          }
          while (i < src.length && /[a-z]/.test(src[i])) { mask[i] = 1; i++; }
          prev = '/';
          continue;
        }
        mask[i] = 1;
        if (!/\s/.test(ch)) prev = ch;
        i++;
      }
      return { code: chars.join(''), mask };
    };
    /* 配对扫描大括号（只数真代码里的括号，跳过字符串/正则 —— 与 harness-check 第十节之二的先例同法）。 */
    const matchBraceAt = (codeText, maskOf, openAt) => {
      let depth = 0;
      for (let i = openAt; i < codeText.length; i++) {
        if (!maskOf[i]) continue;
        if (codeText[i] === '{') depth++;
        else if (codeText[i] === '}') { depth--; if (depth === 0) return i; }
      }
      return -1;
    };

    /* ③-0 扫描器自检（真值表）：注释里的字样必须被抹掉，字符串/模板串/正则里的 `//`、`/*` 必须原样保留。 */
    const scanFixture = [
      'const a = 1; // db.exec(step)',
      '/* assertUpgradeStepShape(step); try { */',
      'const s = "// 不是注释";',
      'const r = /a\\/\\/b/;',
      'const t2 = `// 也不是注释`;',
      ''
    ].join('\r\n');
    const fixtureScanned = scanJs(scanFixture);
    t.check('六之十/静态/接线⓪ 扫描器自检：注释被抹成**等长空白**（字符下标不变），' +
      '而字符串／模板串／正则里的 `//`、`/*` **原样保留**（否则 ③①②③ 的下标比较全是错的）',
      fixtureScanned.code.length === scanFixture.length &&
      !fixtureScanned.code.includes('db.exec(step)') &&
      !fixtureScanned.code.includes('assertUpgradeStepShape(step);') &&
      !fixtureScanned.code.includes('try {') &&
      fixtureScanned.code.includes('"// 不是注释"') &&
      fixtureScanned.code.includes('`// 也不是注释`') &&
      fixtureScanned.code.includes('/a\\/\\/b/') &&
      fixtureScanned.code.split('\r\n').length === scanFixture.split('\r\n').length &&
      fixtureScanned.mask[0] === 1 && fixtureScanned.mask[scanFixture.indexOf('不是注释')] === 0,
      `长度 ${scanFixture.length} → ${fixtureScanned.code.length}；` +
      `注释字样残留=${fixtureScanned.code.includes('db.exec(step)')}；` +
      `字符串原样保留=${fixtureScanned.code.includes('"// 不是注释"')}`);

    const indexSrcPath = require.resolve('../server/db/index.js');
    const rawSrc = fs.readFileSync(indexSrcPath, 'utf8');
    const scanned = scanJs(rawSrc);
    const code = scanned.code;
    const mask = scanned.mask;
    const findRealNeedles = (needle) => {
      const hits = [];
      for (let at = code.indexOf(needle); at >= 0; at = code.indexOf(needle, at + 1)) if (mask[at]) hits.push(at);
      return hits;
    };
    const findRealRe = (re) => {
      const hits = [];
      re.lastIndex = 0;
      for (let m = re.exec(code); m; m = re.exec(code)) if (mask[m.index]) hits.push(m.index);
      return hits;
    };
    const lineOfAt = at => (at < 0 ? '未定位' : String(code.slice(0, at).split(/\r?\n/).length));

    const callSites = findRealRe(/assertUpgradeStepShape\s*\(\s*step\s*\)\s*;/g);
    const callAt = callSites.length === 1 ? callSites[0] : -1;
    const loopHits = findRealNeedles('for (const step of STRUCTURE_UPGRADES) {');
    const loopAt = loopHits.length ? loopHits[0] : -1;
    const loopBrace = loopAt >= 0 ? code.indexOf('{', loopAt) : -1;
    const loopEnd = loopBrace > 0 && mask[loopBrace] ? matchBraceAt(code, mask, loopBrace) : -1;
    const execSites = findRealRe(/db\.exec\(\s*step\s*\)/g);
    const execAt = execSites.length === 1 ? execSites[0] : -1;
    const trySites = findRealRe(/try\s*\{/g).filter(at => execAt >= 0 && at < execAt);
    const tryAt = trySites.length ? trySites[trySites.length - 1] : -1;
    const tryBrace = tryAt >= 0 ? code.indexOf('{', tryAt) : -1;
    const catchAt = execAt >= 0 ? code.indexOf('catch', execAt) : -1;
    const catchBrace = catchAt >= 0 ? code.indexOf('{', catchAt) : -1;
    const catchEnd = catchBrace > 0 && mask[catchBrace] ? matchBraceAt(code, mask, catchBrace) : -1;
    const catchBody = catchEnd > catchBrace ? code.slice(catchBrace, catchEnd) : '';

    t.check('六之十/静态/接线①：`assertUpgradeStepShape(step);` 在**去注释后**的源码里**唯一**，' +
      '且落在 `for (const step of STRUCTURE_UPGRADES)` 的**循环体内**（删调用点／挪出循环 ⇒ 必红）',
      callSites.length === 1 && loopBrace > 0 && loopEnd > loopBrace && callAt > loopBrace && callAt < loopEnd,
      `调用点 ${callSites.length} 处（第 ${lineOfAt(callAt)} 行）；循环头第 ${lineOfAt(loopAt)} 行、` +
      `循环体收口第 ${lineOfAt(loopEnd)} 行 —— 调用点必须在两者之间`);

    t.check('六之十/静态/接线②：调用点**早于** `db.exec(step)`（去注释后 `db.exec(step)` 唯一；' +
      '把判定点挪到执行**之后** ⇒ 必红）',
      callAt > 0 && execSites.length === 1 && callAt < execAt,
      callSites.length !== 1 ? `源码里找不到唯一调用点（命中 ${callSites.length} 处）`
        : execSites.length !== 1 ? `去注释后 \`db.exec(step)\` 命中 ${execSites.length} 处（要求恰好 1 处）`
        : `调用点第 ${lineOfAt(callAt)} 行（下标 ${callAt}） < exec 第 ${lineOfAt(execAt)} 行（下标 ${execAt}）`);

    t.check('六之十/静态/接线③：调用点**不在**容忍 `duplicate column name|already exists` 的那个 `try` 块内' +
      '（挪进 try ⇒ 形态违规被那张网吞掉、必红）',
      callAt > 0 && tryBrace > 0 && catchAt > tryBrace && !(callAt > tryBrace && callAt < catchAt),
      `try 第 ${lineOfAt(tryBrace)} 行、catch 第 ${lineOfAt(catchAt)} 行、调用点第 ${lineOfAt(callAt)} 行`);

    t.check('六之十/静态/接线④：那张容忍网确实**存在**且**只吞**"已存在"类错误（catch 体点名 ' +
      '`duplicate column name` 与 `already exists`，且**仍会重抛**别的错误）—— 这条防 ③③ 变成' +
      '"try 没了所以不在 try 里"的**空洞断言**（D23）',
      catchBody.length > 0 && catchBody.includes('duplicate column name') &&
      catchBody.includes('already exists') && /\bthrow\b/.test(catchBody),
      catchBody.length
        ? `catch 体 ${catchBody.length} 字符；含 duplicate column name=${catchBody.includes('duplicate column name')}、` +
          `含 already exists=${catchBody.includes('already exists')}、含重抛（\`throw\`）=${/\bthrow\b/.test(catchBody)}`
        : `定位不到容忍 catch 的块体（try@${tryAt}／catch@${catchAt}／catchBrace@${catchBrace}）`);
  }

/* ---------------- 七、备份（DR-15 / DEP-08） ---------------- */
  t.section('七、备份与校验（DR-15 / DEP-08）');
  /* E44（2026-09-28）：备份目录改为**每次运行独占**（原来是 `tempRoot/backup-case` 这个固定名）。
     固定名 + 秒级文件名 ⇒ 两个 db-check 并发跑（压测）时互相覆盖同一个文件，
     于是下面「保留策略只保留最近 N 份」偶发红 —— 根因是"同秒同名覆盖"，不是保留策略本身。 */
  const backupDir = makeTempDir('backup-case');
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

  /* **在同一秒内**再做 5 次备份（注入时刻连毫秒都相同）—— 正是 E44 的复现条件：
     改前（秒级文件名）这 5 次会落到同一个名字上、互相覆盖，`listBackups` 只会数到 1 份。 */
  const sameSecondAt = new Date(2026, 8, 19, 10, 0, 0);
  for (let i = 0; i < 5; i++) {
    await maintain.backupTo(handle.db, backupDir, { now: sameSecondAt });
  }
  const backupsBeforePrune = maintain.listBackups(backupDir);
  const pruned = maintain.pruneBackups(backupDir, 2);
  t.check('保留策略只保留最近 N 份并删除其余（E44：**同一秒内连做 5 次备份 ⇒ 5 个不同文件**，' +
    '不再互相覆盖；连同前面 1 次共 6 份 ⇒ 保留 2、删除 4）',
    backupsBeforePrune.length === 6 && new Set(backupsBeforePrune.map(b => b.name)).size === 6 &&
    maintain.listBackups(backupDir).length === 2 && pruned.removed.length === 4,
    `备份 6 份：[${backupsBeforePrune.map(b => b.name).join(', ')}] ⇒ 保留 ${maintain.listBackups(backupDir).length} 份，` +
    `删除 ${pruned.removed.length} 份`);

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

  /* ---------------- 八之四、IF-D 采集接入（W1：校验拒收 / 频率口径 / 幂等 / 退路口径 / 断连 / HTTP） ----------------
     被测对象＝`server/services/ingest.js` + `server/http/routes/ifD.js`（W1 新增）：
       ①脏帧拒收（缺字段/类型错/时间非法含毫秒与秒级/超量程）⇒ 拒收 + 可读原因 + **一行未落库**；
       ②频率口径（ADR-0001 D7）：1 s 采样落库、500 ms 原始帧**不落库**（只进内存）；
       ③幂等/去重（DR-13 主口径四字段）：同一键重复送 ⇒ **不产生第二行、也不改写既有行**；
       ④退路口径标注：无 seq 的帧走退路口径且返回值里**有明确标注**（同时带出误判风险，不隐藏）；
       ⑤断连状态（FR-2.6 / IF-D.9）：喂一帧 ⇒ 在线；**推进注入时钟** >5 s ⇒ 离线（不真等 5 s）；
       ⑥端到端（HTTP 那一层的**最小**验证）：起一个**进程内**临时端口的 http.Server，
          把同一 router 挂上去，POST 一帧断言落库、POST 脏帧断言 400 且不落库。
     ⚠ 为什么"进程内起 HTTP"而不是子进程起 `server/index.js`：`tests/harness-check.js`
       （**别的脚本**，本包不得改也不得跑）已经在验"子进程起停服务"。本包只需证明
       "`mountIfD` 注册的路由真的能被 HTTP 送到 ingest 上"，进程内起停最小、不与其交叉。
     判据口径（**幂等**的选择依据）：DR-13 原文允许"幂等 / 后到覆盖先到"二者之一；
       本实现选**幂等**，因为落库出口 `server/repo/measure.js` 用 `INSERT OR IGNORE` + 库层唯一索引
       `ux_measure_rt(equip_code, proc_order_no, collect_time)`，且该文件自述"只做 SQL、不做业务判断"
       —— 若在后到覆盖需另写 UPDATE，等于**在库唯一索引之外另起第二套去重真源**（任务书明令禁止）。
       故下面第 ③ 条断言的是"**行数不变 + 字段未被覆盖**"，依据即库层现状（本包不得改 repo/db）。 */
  t.section('八之四、IF-D 采集接入（校验拒收 / 1 s 采样 / 幂等去重 / 退路口径 / 断连 / HTTP）');

  const IFD_T0 = '2026-09-25 09:00:00';
  const ifdDb = makeTempDb({ name: 'ifd-ingest' });
  db.initSchema(ifdDb.db, NOW);
  /* 注入时钟（`tests/lib/clock.js`）：断连判据要"推进 5 s 以后"，不能真等 —— 这正是 D17 的用处 */
  const ifdClock = createClock({ mode: 'fixed', at: IFD_T0 });
  const ifdLogs = [];
  const ifdLogger = {
    info: m => ifdLogs.push('info:' + m),
    warn: m => ifdLogs.push('warn:' + m),
    error: m => ifdLogs.push('error:' + m)
  };
  const ingestSvc = createIngest({ db: ifdDb.db, now: ifdClock.source(), logger: ifdLogger });
  const ifdRows = () => ifdDb.db.prepare('SELECT COUNT(*) AS c FROM measure_rt').get().c;
  /** 取某键在库中的行（断言"字段未被覆盖"用） */
  const ifdRowOf = (equipCode, procOrderNo, collectTime) => ifdDb.db.prepare(
    'SELECT * FROM measure_rt WHERE equip_code = ? AND proc_order_no = ? AND collect_time = ?'
  ).get(equipCode, procOrderNo, collectTime);

  if (t.requires('八之四前提：采集服务已接线（createIngest 可用）且临时库为空',
    typeof createIngest === 'function' && typeof ingestSvc.ingestFrame === 'function' && ifdRows() === 0,
    `measure_rt ${ifdRows()} 行`)) {

    /* ---- ① 脏帧拒收：缺字段 / 类型错 / 时间非法（毫秒与秒级两种输入的预期）/ 超量程 ---- */
    const GOOD = fixture.makeFrame({ at: IFD_T0, i: 7000 });
    /* ⚠ 这三条"缺字段"的构帧用了 IIFE，**最后一句必须是 `return f;` 且前一句以 `;` 收尾**：
       写成 `delete f.equipCode`（无分号）换行再接 `return f;` 时，ASI 不会补分号
       （`return` 是关键字、不构成续行风险，但上一句会被解析成 `delete f.equipCode(return f)`）
       —— 实测后果是 `frame` 变成一个**函数**，一律命中 `FRAME_NOT_OBJECT`，
       于是"缺字段"这条判据被另一个原因冒充（本包首轮自检即踩到，见回执）。 */
    const dropField = name => { const f = Object.assign({}, GOOD); delete f[name]; return f; };
    const dirtyCases = [
      { name: '缺 equipCode', frame: dropField('equipCode'), code: 'MISSING_FIELD', field: 'equipCode' },
      { name: '缺 procOrderNo', frame: dropField('procOrderNo'), code: 'MISSING_FIELD', field: 'procOrderNo' },
      { name: '缺 collectTime', frame: dropField('collectTime'), code: 'MISSING_FIELD', field: 'collectTime' },
      { name: 'equipCode 类型错（数字）', frame: Object.assign({}, GOOD, { equipCode: 12345 }),
        code: 'BAD_TYPE', field: 'equipCode' },
      { name: 'depth 类型错（字符串）', frame: Object.assign({}, GOOD, { depth: '5.00' }),
        code: 'BAD_TYPE', field: 'depth' },
      { name: 'testStatus 非附录 2 码（9）', frame: Object.assign({}, GOOD, { testStatus: 9 }),
        code: 'BAD_TEST_STATUS', field: 'testStatus' },
      { name: '时间非法：带 T', frame: Object.assign({}, GOOD, { collectTime: '2026-09-25T09:00:00' }),
        code: 'BAD_COLLECT_TIME', field: 'collectTime' },
      { name: '时间非法：非法月日 2026-13-45', frame: Object.assign({}, GOOD, { collectTime: '2026-13-45 09:00:00' }),
        code: 'BAD_COLLECT_TIME', field: 'collectTime' },
      { name: '时间非法：空串', frame: Object.assign({}, GOOD, { collectTime: '' }),
        code: 'BAD_TYPE', field: 'collectTime' },
      { name: '时间非法：数字时间戳', frame: Object.assign({}, GOOD, { collectTime: 1789000000000 }),
        code: 'BAD_TYPE', field: 'collectTime' },
      { name: '超量程：帧率 1201（UI-08 量程 0～1200）', frame: Object.assign({}, GOOD, { frameRate: 1201 }),
        code: 'OUT_OF_RANGE', field: 'frameRate' },
      { name: '超量程：深度 -1', frame: Object.assign({}, GOOD, { depth: -1 }),
        code: 'OUT_OF_RANGE', field: 'depth' },
      { name: '超精度：深度 12.345（两位小数口径）', frame: Object.assign({}, GOOD, { depth: 12.345 }),
        code: 'OUT_OF_RANGE', field: 'depth' },
      { name: '非对象：字符串帧', frame: 'not-a-frame', code: 'FRAME_NOT_OBJECT', field: '(frame)' }
    ];
    /* ⚠ detail 字符串里**不得**再调 `ingestFrame()`：那会改动运行态计数（`rejectedFrames`），
       让紧随其后的"计数 = 脏帧数"断言莫名变红。下面这条 detail 只用上面循环留下的结果。 */
    const dirtyProblems = [];
    const dirtySeen = [];
    for (const c of dirtyCases) {
      const r = ingestSvc.ingestFrame(c.frame);
      dirtySeen.push(r);
      if (r.outcome !== 'rejected') { dirtyProblems.push(`${c.name} → 竟被收下（${r.outcome}）`); continue; }
      if (!r.error || r.error.code !== c.code || r.error.field !== c.field) {
        dirtyProblems.push(`${c.name} → ${r.error && r.error.code}/${r.error && r.error.field}` +
          `（期望 ${c.code}/${c.field}）`);
      }
      if (typeof r.error.reason !== 'string' || r.error.reason.length < 8) {
        dirtyProblems.push(`${c.name} → 拒收原因不可读：${JSON.stringify(r.error && r.error.reason)}`);
      }
    }
    t.check('IF-D 校验：缺字段 / 类型错 / 时间非法（带 T、非法月日、空串、数字）/ 超量程（帧率>1200、深度<0、超两位小数）/ 非对象 ' +
      `共 ${dirtyCases.length} 类脏帧**全部拒收**，且每类都给出可读原因（code + field + reason）`,
      dirtyProblems.length === 0,
      dirtyProblems.length ? dirtyProblems.join('；')
        : `${dirtyCases.length}/${dirtyCases.length} 拒收，样例：${String(dirtySeen[6].error.reason)}`);

    t.check('IF-D 校验：脏帧**一行未落库**（拒收挡在落库之前，不留半条）—— 表内仍 0 行，且计数 rejected = ' +
      `${dirtyCases.length}`,
      ifdRows() === 0 && ingestSvc.stats().rejectedFrames === dirtyCases.length,
      `measure_rt ${ifdRows()} 行；rejected=${ingestSvc.stats().rejectedFrames}`);

    t.check('IF-D 时间口径（DR-16 + C-101③）：**秒级与毫秒级两种输入都收**，落库前一律截断到秒 —— ' +
      '秒级输入原样、毫秒输入丢掉毫秒位（`…09:00:01.500` ⇒ `…09:00:01`）',
      (() => {
        const sec = ingestSvc.validate(Object.assign({}, GOOD, { collectTime: '2026-09-25 09:10:00', seq: 1 }));
        const ms = ingestSvc.validate(Object.assign({}, GOOD, { collectTime: '2026-09-25 09:10:01.500', seq: 2 }));
        const ms1 = ingestSvc.validate(Object.assign({}, GOOD, { collectTime: '2026-09-25 09:10:01.5', seq: 2 }));
        const bad = ingestSvc.validate(Object.assign({}, GOOD, { collectTime: '2026-09-25 09:10:01.5.5' }));
        return sec.ok && sec.collectTimeSec === '2026-09-25 09:10:00' && sec.collectMs === 0 &&
          ms.ok && ms.collectTimeSec === '2026-09-25 09:10:01' && ms.collectMs === 500 &&
          ms1.ok && ms1.collectTimeSec === '2026-09-25 09:10:01' && ms1.collectMs === 500 &&
          bad.ok === false;
      })(),
      (() => {
        const ms = ingestSvc.validate(Object.assign({}, GOOD, { collectTime: '2026-09-25 09:10:01.500' }));
        return `毫秒输入 ⇒ sec=${ms.collectTimeSec} ms=${ms.collectMs}`;
      })());

    /* 设备编号不一致**默认不拒收**：IF-D.12 的口径是"原样使用 / 以 IF-A 为准并给出可见提示"，
       拒收会丢掉真实测量数据（配置号与 MES 号不一致是**配置问题**，不是帧脏）。
       "可见提示"归 IF-A 包（W2）；本包只把它做成**显式可开启**的判据，不在缺省路径上拦数据。 */
    t.check('IF-D 设备编号（IF-D.12）：帧内 equipCode 与本机配置不一致时**默认收下**（不拒收、不丢真实测量数据）；' +
      '仅在 `enforceEquipCode:true` 显式开启时才拒收并给出 `EQUIP_CODE_MISMATCH`（该"可见提示"归 IF-A 包）',
      (() => {
        const other = Object.assign({}, GOOD, { equipCode: 'EQ-OTHER-999', collectTime: '2026-09-25 09:20:00', seq: 1 });
        const lenient = ingestSvc.validate(other);
        const strict = createIngest({ db: ifdDb.db, now: ifdClock.source(), enforceEquipCode: true })
          .validate(other);
        return lenient.ok === true && strict.ok === false && strict.code === 'EQUIP_CODE_MISMATCH';
      })(),
      `默认=${ingestSvc.validate(Object.assign({}, GOOD, { equipCode: 'EQ-OTHER-999' })).ok ? '收下' : '拒收'}；` +
      `enforceEquipCode=true 时拒收码=EQUIP_CODE_MISMATCH`);

    /* ---- ② 频率口径（ADR-0001 D7）：1 s 采样落库、500 ms 原始帧不落库 ---- */
    /** 造帧：在 `fixture.makeFrame` 的既有框上加 DR-13 主口径第四字段 `seq`（不另造字段名） */
    const frameWith = opts => Object.assign(fixture.makeFrame(opts), opts.seq === undefined ? {} : { seq: opts.seq });
    /** 频率口径断言的**基准行数**：本段前面已因别的用例写过若干行，故一律用**增量**断言，
     *  不写死绝对行数 —— 否则"前面多写一行"就会让本段变红，而那不是本段要证的事。
     *  ⚠ 必须在**喂帧之前**取基准（首版把这一行写在了 map(ingestFrame) 之后，基准里已经含了
     *  本段自己的 3 行，"净增 3 行"于是永远算不平 —— 这正是"基准取自喂帧之后"的典型错法）。 */
    /* ⚠ 行数一律**先取快照再断言**（`rowsAfterSec` / `rowsAfterRaw`），不要在断言式里现读 `ifdRows()`：
       断言式与 detail 是**两次独立求值**（`tests/lib/assert.js` 的 `t.check(name, ok, detail)` 收到的是
       求值后的值，runner 不做重放 —— 已用 `tests\._verify\w1\probe-replay.js` 实测确认）。
       把"随时可变"的读取分散写在两处，一旦中间又发生写库，两处就会读到不同的当刻值，
       输出成"自相矛盾"的失败详情（本包首版即踩到这个坑，浪费了一轮排查）。
       快照一次、断言与 detail 都用它，才谈得上可复核。 */
    const rowsBeforeFreq = ifdRows();
    const secFrames = [0, 1, 2].map(i => frameWith({
      at: `2026-09-25 10:00:0${i}`, i: 7100 + i, depth: Number((5 + i * 0.1).toFixed(2)), seq: 100 + i
    }));
    const secResults = secFrames.map(f => ingestSvc.ingestFrame(f));
    const rowsAfterSec = ifdRows();
    const rawFrames = [
      frameWith({ at: '2026-09-25 10:01:00.000', i: 7200, depth: 5.50, seq: 200 }),
      frameWith({ at: '2026-09-25 10:01:00.500', i: 7201, depth: 5.80, seq: 201 })
    ];
    const rawResults = rawFrames.map(f => ingestSvc.ingestFrame(f));
    const rowsAfterRaw = ifdRows();
    t.check('IF-D 频率口径（ADR-0001 D7）：**1 s 采样**（间隔 1 s、seq 递增）3 帧**全部落库**' +
      '（stored，净增 3 行）',
      secResults.length === 3 && secResults.every(r => r.outcome === 'stored' && r.stored === true) &&
      rowsAfterSec === rowsBeforeFreq + 3,
      `outcomes=${secResults.map(r => r.outcome).join('/')}；measure_rt ${rowsBeforeFreq} → ${rowsAfterSec} 行`);

    t.check('IF-D 频率口径（ADR-0001 D7）：**500 ms 原始帧**（同秒 `…10:01:00.000` 与 `…10:01:00.500`）' +
      '**一帧都不落库**（第 1 帧落库、同秒第 2 帧 → raw-500ms 只进内存），净增仍为 4 行',
      rawResults[0].outcome === 'stored' && rawResults[1].outcome === 'raw-500ms' &&
      rawResults[1].stored === false && rowsAfterRaw === rowsBeforeFreq + 4 &&
      ingestSvc.stats().rawFramesInMemory === 1,
      `outcomes=${rawResults.map(r => r.outcome).join('/')}；measure_rt ${rowsBeforeFreq} → ${rowsAfterRaw} 行；` +
      `原始帧内存计数=${ingestSvc.stats().rawFramesInMemory}`);

    t.check('IF-D 频率口径：落库行的 collect_time 一律是**秒级 19 字符**（毫秒位不落库，DR-16）',
      ifdDb.db.prepare("SELECT COUNT(*) AS c FROM measure_rt WHERE length(collect_time) <> 19").get().c === 0,
      '');

    /* ---- ③ 幂等/去重（DR-13 主口径四字段）：**幂等** —— 行数不变且字段未被覆盖 ---- */
    const rowsBeforeDup = ifdRows();
    const dupFrame = Object.assign(fixture.makeFrame({ at: '2026-09-25 11:00:00', i: 7300, depth: 5.11 }),
      { seq: 300, speed: 4.44 });
    const dupKeyB = Object.assign({}, dupFrame);
    const dupA = ingestSvc.ingestFrame(dupFrame);
    const dupB = ingestSvc.ingestFrame(dupKeyB);
    /* 同一四字段键、但**内容不同**的一帧：用来证明"幂等（不改写）"而不是"后到覆盖" */
    const overwriteTry = ingestSvc.ingestFrame(Object.assign({}, dupFrame, { depth: 9.99, speed: 9.99 }));
    const dupRowsA = ifdRows();
    const dupRow = ifdRowOf(dupFrame.equipCode, dupFrame.procOrderNo, '2026-09-25 11:00:00');
    t.check('IF-D 去重（DR-13 主口径四字段 equipCode+procOrderNo+collectTime+seq）：同一键连送 2 次 —— ' +
      '第 1 次 stored、第 2 次 duplicate，**净增恰好 1 行**（不产生第二条记录）',
      dupA.outcome === 'stored' && dupA.dedup.basis === 'primary-4field' &&
      dupB.outcome === 'duplicate' && dupB.stored === false &&
      dupRowsA === rowsBeforeDup + 1,
      `A=${dupA.outcome}(${dupA.dedup.basis}) / B=${dupB.outcome}；行数 ${rowsBeforeDup} → ${dupRowsA}，` +
      `键=${dupA.dedup.key}`);

    t.check('IF-D 去重口径＝**幂等**（不是"后到覆盖"）：同一键改内容再送 ⇒ 仍 `duplicate`，' +
      '且既有行的 depth/speed **未被改写**（依据：库层 `INSERT OR IGNORE` + 唯一索引 ux_measure_rt，' +
      'repo 层"只做 SQL 不做业务判断"，本包不得另起第二套去重真源）',
      overwriteTry.outcome === 'duplicate' && dupRowsA === rowsBeforeDup + 1 &&
      Number(dupRow.measure_depth) === 5.11 && Number(dupRow.speed) === 4.44,
      `第三次=${overwriteTry.outcome}；行内 depth=${dupRow && dupRow.measure_depth} speed=${dupRow && dupRow.speed}` +
      `（送的是 9.99/9.99）；行数仍 ${dupRowsA}`);

    /* ---- ④ 退路口径标注：无 seq 的帧必须走退路口径并**在返回里明确标注** ---- */
    const noSeqFrame = fixture.makeFrame({ at: '2026-09-25 12:00:00', i: 7400, depth: 5.22 });
    delete noSeqFrame.seq;
    const fb = ingestSvc.ingestFrame(noSeqFrame);
    t.check('IF-D 退路口径（DR-13 / 函件 U-5）：**无 seq** 的帧正常收下落库，但返回值里 ' +
      '`dedup.basis=fallback-3field`、`dedup.fallback=true`，并**带出跨工单同秒误判风险**（不隐藏）',
      fb.outcome === 'stored' && fb.dedup.basis === 'fallback-3field' && fb.dedup.fallback === true &&
      typeof fb.dedup.risk === 'string' && fb.dedup.risk.includes('退路口径') && fb.dedup.risk.includes('误判风险') &&
      fb.dedup.key === [noSeqFrame.equipCode, noSeqFrame.procOrderNo, '2026-09-25 12:00:00', ''].join('|'),
      `basis=${fb.dedup.basis} risk="${String(fb.dedup.risk).slice(0, 46)}…"`);

    t.check('IF-D 退路口径 ≠ 主口径：同一时刻若**带 seq** 则键里含 seq（两种口径的键必须可区分，' +
      '否则"标注"就成了空话）',
      (() => {
        const withSeq = ingestSvc.validate(Object.assign({}, noSeqFrame, { seq: 7 }));
        const without = ingestSvc.validate(noSeqFrame);
        return withSeq.ok && withSeq.seq === 7 && without.ok && without.seq === null;
      })(), `带 seq ⇒ seq=7；不带 ⇒ seq=null`);

    /* ---- ⑤ 断连状态（FR-2.6 / IF-D.9）：喂帧 ⇒ 在线；推进注入时钟 >5 s ⇒ 离线 ---- */
    const offlineDb = makeTempDb({ name: 'ifd-link' });
    db.initSchema(offlineDb.db, NOW);
    const linkClock = createClock({ mode: 'fixed', at: IFD_T0 });
    const linkSvc = createIngest({ db: offlineDb.db, now: linkClock.source() });
    const linkBefore = linkSvc.linkState();
    const linkFrame = Object.assign(fixture.makeFrame({ at: IFD_T0, i: 7500 }), { seq: 400 });
    const linkStored = linkSvc.ingestFrame(linkFrame);
    const linkOnline = linkSvc.linkState();
    /* 推进到"恰好阈值"（5 s）与"超过阈值"（5.001 s）：≤5 s 判在线、>5 s 判离线 */
    linkClock.advanceSec(5);
    const linkAt = linkSvc.linkState();
    linkClock.advanceMs(1);
    const linkAfter = linkSvc.linkState();
    t.check('IF-D 断连（FR-2.6 / IF-D.9，阈值真源＝board.config.js 的 upper.staleMs=5000）：' +
      '未收帧 ⇒ offline；喂一帧（有效）⇒ **online**；**推进注入时钟 5 s** ⇒ 仍 online（≤5 s 口径）；' +
      '再推进 1 ms（>5 s）⇒ **offline**（用注入时钟，不真等 5 s）',
      linkBefore.state === 'offline' && linkBefore.ageMs === null &&
      linkStored.outcome === 'stored' && linkOnline.state === 'online' && linkOnline.online === true &&
      linkOnline.staleMs === 5000 && linkAt.state === 'online' && linkAt.ageMs === 5000 &&
      linkAfter.state === 'offline' && linkAfter.ageMs === 5001,
      `未收帧=${linkBefore.state}；喂帧后=${linkOnline.state}；+5 s=${linkAt.state}(age=${linkAt.ageMs})；` +
      `+5.001 s=${linkAfter.state}(age=${linkAfter.ageMs})`);

    /* 脏帧**不得**刷新"最近有效帧"：否则断连判据会被脏帧喂活、永远显示在线（FR-2.6 就成了摆设）。
       单独一份时钟 + 单独实例，与上一条互不干扰。 */
    const dirtyClock = createClock({ mode: 'fixed', at: IFD_T0 });
    const dirtySvc = createIngest({ db: offlineDb.db, now: dirtyClock.source() });
    dirtySvc.ingestFrame(frameWith({ at: IFD_T0, i: 7600, seq: 500 }));
    const acceptedBeforeDirty = dirtySvc.stats().lastAcceptedAt;
    dirtyClock.advanceSec(6);
    const dirtyResult = dirtySvc.ingestFrame({ equipCode: 'X', collectTime: 'bogus' });
    const afterDirty = dirtySvc.linkState();
    t.check('IF-D 断连：**脏帧不刷新"最近有效帧"** —— 喂一帧脏帧后 `lastAcceptedAt` 未被改动、' +
      '状态仍随注入时钟走到 offline（否则断连判据会被脏帧喂活、永远显示在线）',
      dirtyResult.outcome === 'rejected' &&
      dirtySvc.stats().lastAcceptedAt === acceptedBeforeDirty &&
      afterDirty.state === 'offline' && afterDirty.ageMs === 6000,
      `脏帧=${dirtyResult.outcome}；lastAcceptedAt 未变=${dirtySvc.stats().lastAcceptedAt === acceptedBeforeDirty}；` +
      `link=${afterDirty.state}(age=${afterDirty.ageMs})`);
    offlineDb.close();

    /* ---- ⑥ 端到端（HTTP 那一层的**最小**验证）：进程内临时端口起 http.Server ----
       `getHealth` 里带上 IF-D 子集，是为了顺手断言"断连状态可被 `/health` 读到"这条留位要求；
       下面的 ifdMount 在回调**执行时**才被读，故 const 声明在后仍成立（回调晚于本行执行）。 */
    const ifdHttpErrors = [];
    const httpRouter = createRouter({
      getHealth: () => ({ ok: true, ifd: ifdMount.status() }),
      onError: err => { ifdHttpErrors.push(String(err && err.message)); }
    });
    const ifdMount = mountIfD(httpRouter, { ingest: ingestSvc });
    const ifdServer = http.createServer((req, res) => {
      Promise.resolve(httpRouter.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
    });
    const httpPort = await allocPort();
    await new Promise((resolve, reject) => {
      ifdServer.once('error', reject);
      ifdServer.listen(httpPort, '127.0.0.1', resolve);
    });
    const httpPost = async (pathname, body) => {
      const res = await fetch(`http://127.0.0.1:${httpPort}${pathname}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      return { status: res.status, body: await res.json() };
    };
    const rowsBeforeHttp = ifdRows();
    const e2eFrame = Object.assign(fixture.makeFrame({ at: '2026-09-25 13:00:00', i: 7800 }), { seq: 700 });
    const e2eOk = await httpPost('/ifd/frame', e2eFrame);
    const rowsAfterOk = ifdRows();
    const e2eDup = await httpPost('/ifd/frame', Object.assign({}, e2eFrame));
    const rowsAfterDup = ifdRows();
    const e2eBad = await httpPost('/ifd/frame', Object.assign({}, e2eFrame, { collectTime: '2026-09-25T13:00:00' }));
    const rowsAfterBad = ifdRows();
    const e2eNoPath = await fetch(`http://127.0.0.1:${httpPort}/ifd/nope`);
    const e2eStatus = await (await fetch(`http://127.0.0.1:${httpPort}/ifd/status`)).json();
    const e2eHealth = await (await fetch(`http://127.0.0.1:${httpPort}/health`)).json();
    await new Promise(resolve => ifdServer.close(resolve));

    t.check('IF-D 端到端（进程内临时端口，**最小**验证）：HTTP POST 一帧 ⇒ 200 / outcome=stored ' +
      '⇒ **库里多了一行**（HTTP 这一层确实落库，不是只回了个 200）',
      e2eOk.status === 200 && e2eOk.body.outcome === 'stored' && e2eOk.body.stored === true &&
      rowsAfterOk === rowsBeforeHttp + 1,
      `HTTP ${e2eOk.status} ${e2eOk.body.outcome}；measure_rt ${rowsBeforeHttp} → ${rowsAfterOk} 行`);

    t.check('IF-D 端到端：同一键再 POST ⇒ 200（DR-13"重复不算错误"）但 **outcome=duplicate、行数不变**',
      e2eDup.status === 200 && e2eDup.body.outcome === 'duplicate' && rowsAfterDup === rowsAfterOk,
      `HTTP ${e2eDup.status} ${e2eDup.body.outcome}；行数 ${rowsAfterOk} → ${rowsAfterDup}`);

    t.check('IF-D 端到端：POST 脏帧（collectTime 带 T）⇒ **400** + `ok:false` + error.code/field/reason，' +
      '且**一行都没落库**',
      e2eBad.status === 400 && e2eBad.body.ok === false && e2eBad.body.outcome === 'rejected' &&
      e2eBad.body.err && e2eBad.body.err.code === 'BAD_COLLECT_TIME' &&
      e2eBad.body.err.field === 'collectTime' && typeof e2eBad.body.err.message === 'string' &&
      rowsAfterBad === rowsAfterOk,
      `HTTP ${e2eBad.status} ${e2eBad.body.err && e2eBad.body.err.code}；行数 ${rowsAfterOk} → ${rowsAfterBad}；` +
      `body=${JSON.stringify(e2eBad.body).slice(0, 200)}`);

    t.check('IF-D 端到端：`GET /ifd/status` 可读到断连状态与 source 启用情况（推送 enabled=true、' +
      '轮询 enabled=false —— 形态待 U-0.1 答复），`GET /health` 亦带 IF-D 子集；未注册路径仍 404（**未另起路由表**）',
      e2eStatus.ok === true && e2eStatus.link && ['online', 'offline'].includes(e2eStatus.link.state) &&
      e2eStatus.sources.push.enabled === true && e2eStatus.sources.poller.enabled === false &&
      e2eStatus.sources.poller.implemented === true &&
      e2eHealth.ifd && e2eHealth.ifd.link && typeof e2eHealth.ifd.link.state === 'string' &&
      e2eNoPath.status === 404,
      `status.link=${e2eStatus.link && e2eStatus.link.state}；poller.enabled=${e2eStatus.sources.poller.enabled}；` +
      `/ifd/nope ⇒ ${e2eNoPath.status}`);

    t.check('IF-D 装配显式性：`mountIfD()` 返回 `mounted:true` 与已注册路由清单，且**不抛**（接线成功），' +
      '与 W6 空壳 `router.mountIfD()` 的 `mounted:false` 形成可核查对照（D23 反静默空转）',
      ifdMount.mounted === true && ifdMount.by === 'W1' && ifdMount.routes.length === 3 &&
      httpRouter.list().includes('POST /ifd/frame') &&
      httpRouter.list().includes('GET /ifd/status'),
      `mounted=${ifdMount.mounted}；routes=${ifdMount.routes.join(' , ')}`);

    /* 轮询形态：**已实现、默认未启用**（形态不确定性 U-0.1 的留位）。不启定时器、不接线，
       但能力必须真的在（`pollOnce` 在未配 url 时给出**可读**失败原因，而不是抛异常或静默）。 */
    const poller = ingestSvc.createPoller({ intervalMs: 10 });
    const pollResult = await poller.pollOnce();
    t.check('IF-D 轮询形态（`createPoller`）**已实现但默认未启用**（`enabled=false`、无定时器在跑）：' +
      '不接线也不抛；未配 `upper.url` 时 `pollOnce()` 返回**可读**失败原因（形态待 U-0.1 答复，留位而非静默）',
      poller.enabled === false && poller.running() === false &&
      pollResult.ok === false && pollResult.error && pollResult.error.code === 'NO_URL' &&
      typeof pollResult.error.reason === 'string' && pollResult.error.reason.length > 4,
      `poller.enabled=${poller.enabled}；pollOnce ⇒ ${pollResult.error && pollResult.error.code}`);

    /* 拒收必须**留痕**（不得静默收脏数据）：上面喂过的脏帧应在日志里留下 warn（由注入的 logger 收集） */
    t.check('IF-D 留痕（D23 反静默）：每一帧拒收都写了 warn 日志（注入 logger 收集到 ≥ 脏帧数 条 ' +
      'IF-D 拒收记录）—— 现场不会出现"界面没数据、日志里也什么都没有"',
      ifdLogs.filter(l => l.startsWith('warn:') && l.includes('帧被拒收')).length >= dirtyCases.length,
      `warn 日志 ${ifdLogs.filter(l => l.includes('帧被拒收')).length} 条（脏帧 ${dirtyCases.length} 类）`);
  }
  ifdDb.close();   // 夹具自有连接：不关会在 Windows 上锁住临时目录（ADR-0003 D17）

  /* ---------------- 八之五、IF-A 接收（幂等 / 权威与不一致提示 / 访问控制 / 失败日志 / HTTP 最小端到端） ----------------
     被测对象＝`server/services/dispatch.js` + `server/http/routes/ifA.js`（W2 新增）：
       ①**幂等**（逐类声明口径，返回值里带 `idempotency.{mode,key,basis}` 可读）：
          派工同 `procOrderNo` 重复下发**不产生第二行、也不改写既有行** —— 依据：库层主键
          `task.proc_order_no`（`schema.sql` DR-02）＋ `INSERT … ON CONFLICT DO NOTHING`；
          且 `task` 的 `status`/`actual_start`/`actual_end` 属**本机进度列**，"后到覆盖"会把本机进度抹掉，
          故不选覆盖（与 `repo/measure.js` 的 `INSERT OR IGNORE`、DR-13"幂等"口径同一先例）；
          物料/工艺以 `op_log(op_type ＋ 规范化报文签名)` 为幂等键（V1.38 §7 无物料表、`DR-03 standard`
          自 V1.33 起为深度/速度偏差版本模型 ⇒ 不新建表，以 DR-12 `op_log` 作可查询留痕）；
          设备（IF-A.4）按 `device.equip_code` **后到覆盖**（DR-01 的口径＝整套系统 1 个编号）。
       ②**权威与不一致提示**（FR-1.2 / IF-D.12 / C-100 / C-102）：IF-A 与本机配置 / IF-D 侧值冲突时
          响应带 `warnings[]`、`GET /ifa/status` 的 `authority` 段有状态位、且落一条 `op_log`
          （`op_type='IF-A权威不一致'`）；同时断言"**以 IF-A 为准**"真的生效（device 表恰 1 行＝IF-A 的编号）
          —— **不得静默以一侧为准**。
       ③**访问控制**（负责人 2026-09-27 裁定①）：未配置 ⇒ 放行 + 明确告警（挂载时 warn 与 error 各一次）；
          配置后 ⇒ 无令牌 401 / 错令牌 403，**鉴权先于报文校验**（脏报文 + 无令牌 ⇒ 401 而非 400），
          失败落 `op_log`（`result='失败'`）且**业务表一行不动**。
       ④**失败日志**：脏入站（缺字段 / 类型错 / 数量非法 / 时间非法 / 无可用业务内容 / 非对象 / 未知种类）
          ⇒ 全部拒收 + 可读原因（code + field + reason）+ 落 `op_log`；与 ③ 的成功留痕按 `op_type`/`result` 可区分。
       ⑤**HTTP 最小端到端**（进程内临时端口，手法同八之四）：三类各一次"成功 ＋ 幂等重复"，并打印原始输出。
     ⚠ 不新建测试脚本（任务书要求）；夹具沿用本文件既有手法（临时库 + 注入时钟 + 进程内 http.Server）。 */
  t.section('八之五、IF-A 接收（幂等 / 权威与不一致提示 / 访问控制 / 失败日志 / HTTP 最小端到端）');

  const IFA_T0 = '2026-09-27 09:00:00';
  const IFA_LOCAL_CODE = 'LOCAL-FALLBACK-001';   // 本机配置侧兜底编号（FR-8.6）
  const IFA_IFA_CODE = 'MES-EQ-9';               // IF-A 权威编号
  const IFA_TOKEN = 'W2-SECRET-TOKEN-9f3a';      // 自检注入的令牌：**只存在于测试**，业务代码不硬编码任何口令
  const ifaDb = makeTempDb({ name: 'ifa-dispatch' });
  db.initSchema(ifaDb.db, NOW);
  const ifaClock = createClock({ mode: 'fixed', at: IFA_T0 });
  const ifaLogs = [];
  const ifaLogger = {
    info: m => ifaLogs.push('info:' + m),
    warn: m => ifaLogs.push('warn:' + m),
    error: m => ifaLogs.push('error:' + m)
  };
  /** IF-D 侧"仅比对与展示"的取值快照（初始 null＝还没有可比对象；比对逻辑对 null 静默跳过，
      因为"没有可比对象"不等于"一致"）。 */
  let ifaIfdSnap = null;
  const ifaSvc = createDispatch({
    db: ifaDb.db,
    logger: ifaLogger,
    now: ifaClock.source(),
    auth: { enabled: false, token: '' },   // ③①：未配置 ⇒ 放行 + 告警
    localEquipCode: IFA_LOCAL_CODE,
    ifd: () => ifaIfdSnap
  });
  const ifaTaskRows = () => ifaDb.db.prepare('SELECT COUNT(*) AS c FROM task').get().c;
  const ifaDeviceRows = () => ifaDb.db.prepare('SELECT equip_code, equip_name FROM device ORDER BY equip_code').all();
  const ifaOpRows = opType => opLogRepo.list(ifaDb.db, { opType }, { limit: 200 });
  /* 基准报文（字段名＝需求 IF-A.1～A.3 的字段清单；形状与 `tools\mock-mes` 的 `/dispatch` 一致，
     真实契约待 Q-23 答复 —— 见回执"未决"）。 */
  const ifaDispatchA = {
    techNoticeNo: 'TJ20260927001', batchNo: 'PC20260927-01', procOrderNo: 'MES-2026-0001',
    productCode: 'CP-2026-A17', drawingNo: 'SJ-4471-02', productName: '水下振动测试件',
    heatBatchNo: 'LB20260927', processNo: '30', processName: '水下高速摄像检验', unit: '件',
    dispatchQty: 180, processRoute: 'RT-A17-01', processNum: '01',
    planStartTime: '2026-09-27 08:00:00', planEndTime: '2026-09-27 20:00:00',
    dispatchTarget: '检验一班/1#工位', equipCode: IFA_IFA_CODE, equipName: 'MES 主设备'
  };
  const ifaMaterialA = {
    techNoticeNo: 'TJ20260927001', batchNo: 'PC20260927-01', procOrderNo: 'MES-2026-0001',
    processNo: '30', processName: '水下高速摄像检验', materialCode: 'M-0001',
    materialName: '水下密封圈', materialType: '耗材', materialBatch: 'MB-2026-09',
    specModel: 'O-52×3.5', materialDesc: '耐压 2 MPa', qty: 12, unit: '件'
  };
  const ifaProcessA = {
    procOrderNo: 'MES-2026-0001', productCode: 'CP-2026-A17', drawingNo: 'SJ-4471-02',
    productName: '水下振动测试件', processNo: '30', processName: '水下高速摄像检验',
    processRoute: 'RT-A17-01', bomInstance: 'BOM-A17-01', workInstruction: 'WI-30-02',
    setDepth: 4.6, setGain: 3.5, setFrameRate: 500, setShutter: 2000
  };

  if (t.requires('八之五前提：IF-A 服务已接线（createDispatch / mountIfA 可用）且临时库为空',
    typeof createDispatch === 'function' && typeof mountIfA === 'function' &&
    typeof ifaSvc.receive === 'function' && typeof ifaSvc.authorize === 'function' &&
    ifaTaskRows() === 0 && opLogRepo.count(ifaDb.db) === 0,
    `task ${ifaTaskRows()} 行；op_log ${opLogRepo.count(ifaDb.db)} 行`)) {

    /* 先落一行"本机配置侧兜底"的 device 行（模拟 FR-8.6 已配、尚未收到 IF-A 的现场）；
       随后 IF-A 以**不同**编号下发 ⇒ 该兜底行必须让位（以 IF-A 为准），且旧编号只在 op_log 里可查。 */
    db.seedInitialData(ifaDb.db, { equipCode: IFA_LOCAL_CODE, equipName: '本机兜底设备名' }, NOW);
    const ifaDeviceSeeded = ifaDeviceRows();

    /* ---- ① 幂等：派工（IF-A.1 → DR-02 task） ---- */
    const ifaD1 = ifaSvc.receive(IFA_KIND.DISPATCH, ifaDispatchA);
    const ifaTaskAfterFirst = ifaTaskRows();
    /* 第 2 次**故意改内容**再送：只有"改内容也不改写既有行"才谈得上幂等（否则与"后到覆盖"不可区分） */
    const ifaD2 = ifaSvc.receive(IFA_KIND.DISPATCH,
      Object.assign({}, ifaDispatchA, { productName: '改名-不应覆盖', planQty: 999 }));
    const ifaTaskAfterSecond = ifaTaskRows();
    const ifaTaskRow = ifaDb.db.prepare('SELECT * FROM task WHERE proc_order_no = ?').get(ifaDispatchA.procOrderNo);
    t.check('IF-A 幂等（派工 / IF-A.1 → DR-02 `task`）：同一 `procOrderNo` 连送 2 次（第 2 次故意改产品名与数量）' +
      '⇒ 第 1 次 `stored`、第 2 次 `duplicate`，**行数不变（恰 1 行）且既有行未被改写**；口径＝**幂等**（不是后到覆盖）',
      ifaD1.outcome === 'stored' && ifaD1.stored === true &&
      ifaD2.outcome === 'duplicate' && ifaD2.stored === false &&
      ifaTaskAfterFirst === 1 && ifaTaskAfterSecond === 1 &&
      ifaTaskRow && ifaTaskRow.product_name === ifaDispatchA.productName &&
      Number(ifaTaskRow.plan_qty) === ifaDispatchA.dispatchQty,
      `A=${ifaD1.outcome} / B=${ifaD2.outcome}；task ${ifaTaskAfterFirst} → ${ifaTaskAfterSecond} 行；` +
      `行内 product_name=${ifaTaskRow && ifaTaskRow.product_name}（送的是「改名-不应覆盖」）、` +
      `plan_qty=${ifaTaskRow && ifaTaskRow.plan_qty}（送的是 999）`);

    t.check('IF-A 幂等依据**可被调用方读到**（不是只写在注释里）：返回值带 `idempotency.{mode,key,basis}`，' +
      '且派工＝幂等 @ `task.proc_order_no`（依据=库层主键 + ON CONFLICT DO NOTHING + 本机进度列不可被覆盖）',
      ifaD1.idempotency && ifaD1.idempotency.mode === 'idempotent' &&
      ifaD1.idempotency.key === 'task.proc_order_no' &&
      typeof ifaD1.idempotency.basis === 'string' &&
      ifaD1.idempotency.basis.includes('proc_order_no') &&
      ifaD1.idempotency.basis.includes('本机进度'),
      `mode=${ifaD1.idempotency && ifaD1.idempotency.mode}；key=${ifaD1.idempotency && ifaD1.idempotency.key}`);

    /* ---- ② 幂等：物料（IF-A.2）/ 工艺（IF-A.3）——DR 无专属表 ⇒ op_log 留痕 + 报文签名幂等键 ---- */
    const ifaM1 = ifaSvc.receive(IFA_KIND.MATERIAL, ifaMaterialA);
    const ifaM2 = ifaSvc.receive(IFA_KIND.MATERIAL, Object.assign({}, ifaMaterialA));
    const ifaMats = ifaOpRows(IFA_OP_TYPE.MATERIAL);
    const ifaP1 = ifaSvc.receive(IFA_KIND.PROCESS, ifaProcessA);
    const ifaP2 = ifaSvc.receive(IFA_KIND.PROCESS, Object.assign({}, ifaProcessA));
    const ifaProcs = ifaOpRows(IFA_OP_TYPE.PROCESS);
    t.check('IF-A 幂等（物料 / IF-A.2）：同一报文连送 2 次 ⇒ `stored` → `duplicate`，`op_log` 中该类留痕**恰 1 行**、' +
      '且该行 `result=成功`（可 `opLogRepo.list(db,{opType})` 直接查询）',
      ifaM1.outcome === 'stored' && ifaM2.outcome === 'duplicate' && ifaMats.length === 1 &&
      ifaMats[0].result === '成功' && String(ifaMats[0].content).includes('sig='),
      `A=${ifaM1.outcome} / B=${ifaM2.outcome}；op_log(${IFA_OP_TYPE.MATERIAL}) ${ifaMats.length} 行；` +
      `sig=${ifaM1.sig}（两次相同=${ifaM1.sig === ifaM2.sig}）`);

    t.check('IF-A 幂等（工艺 / IF-A.3）：同一报文连送 2 次 ⇒ `stored` → `duplicate`，`op_log` 中该类留痕**恰 1 行**；' +
      '幂等键＝`op_log(op_type, content 签名)`（返回值 `idempotency` 明示）',
      ifaP1.outcome === 'stored' && ifaP2.outcome === 'duplicate' && ifaProcs.length === 1 &&
      ifaP1.idempotency.mode === 'idempotent' && ifaP1.idempotency.key.includes('op_log'),
      `A=${ifaP1.outcome} / B=${ifaP2.outcome}；op_log(${IFA_OP_TYPE.PROCESS}) ${ifaProcs.length} 行；` +
      `key=${ifaP1.idempotency.key}`);

    const ifaMVariant = ifaSvc.receive(IFA_KIND.MATERIAL, Object.assign({}, ifaMaterialA, { qty: 13 }));
    const ifaMatsAfterVariant = ifaOpRows(IFA_OP_TYPE.MATERIAL);
    t.check('IF-A 幂等键**不是"按 procOrderNo 一刀切"**（否则改内容也会被当成重复、真变更被静默丢掉）：' +
      '同一工单的物料改一个字段（qty 12 → 13）再送 ⇒ 新签名 ⇒ `stored` 且留痕 1 → 2 行',
      ifaMVariant.outcome === 'stored' && ifaMatsAfterVariant.length === ifaMats.length + 1 &&
      ifaMVariant.sig !== ifaM1.sig,
      `outcome=${ifaMVariant.outcome}；op_log 行数 ${ifaMats.length} → ${ifaMatsAfterVariant.length}；` +
      `sig ${ifaM1.sig} → ${ifaMVariant.sig}`);

    /* ---- ③ 权威与不一致提示：IF-A vs 本机配置（FR-1.2 / IF-D.12 / C-100） ---- */
    const ifaMismatchRows = ifaOpRows(IFA_OP_TYPE.MISMATCH);
    const ifaWarnCodes = (ifaD1.warnings || []).map(w => w.code);
    const ifaDeviceAfter = ifaDeviceRows();
    const ifaMismatchRow = ifaMismatchRows.find(r => String(r.content).includes(IFA_LOCAL_CODE) &&
      String(r.content).includes(IFA_IFA_CODE));
    t.check('IF-A 权威不一致**不静默**（FR-1.2 / IF-D.12）：IF-A 的 `equipCode`＝' + IFA_IFA_CODE +
      ' 与本机配置＝' + IFA_LOCAL_CODE + ' 冲突时 ⇒ ①响应带可见警告 `warnings[]`（code=EQUIP_CODE_MISMATCH，' +
      '含两侧取值与人可读说明）②落一条 `op_log`（op_type=IF-A权威不一致，正文含两个编号）③`/ifa/status` 的 ' +
      '`authority.equipCode.conflict=true`（状态位）',
      ifaWarnCodes.includes('EQUIP_CODE_MISMATCH') &&
      ifaD1.warnings.some(w => w.authoritative === IFA_IFA_CODE && w.localConfig === IFA_LOCAL_CODE) &&
      typeof ifaD1.warning === 'string' && ifaD1.warning.includes(IFA_LOCAL_CODE) &&
      Boolean(ifaMismatchRow) && ifaMismatchRow.result === '成功' &&
      ifaSvc.status().authority.equipCode.conflict === true &&
      ifaSvc.status().authority.equipCode.localConfig === IFA_LOCAL_CODE,
      `warnings=[${ifaWarnCodes.join(',')}]；mismatch 留痕 ${ifaMismatchRows.length} 条；` +
      `status.conflict=${ifaSvc.status().authority.equipCode.conflict}`);

    t.check('IF-A 权威**真的以 IF-A 为准**（不是只给个提示就两边都留着）：device 表原有一行本机兜底编号 ' +
      IFA_LOCAL_CODE + '，收到 IF-A 的 ' + IFA_IFA_CODE + ' 后 ⇒ 该行**让位**（主键改写、不删行不增行），' +
      '表内恰 1 行且编号＝IF-A；旧编号只在 `op_log` 的权威不一致记录里可查',
      ifaDeviceSeeded.length === 1 && ifaDeviceSeeded[0].equip_code === IFA_LOCAL_CODE &&
      ifaDeviceAfter.length === 1 && ifaDeviceAfter[0].equip_code === IFA_IFA_CODE &&
      ifaD1.device && ifaD1.device.superseded.length === 1 &&
      ifaD1.device.superseded[0] === IFA_LOCAL_CODE && Boolean(ifaMismatchRow),
      `落库前 device=[${ifaDeviceSeeded.map(r => r.equip_code).join(',')}] → 落库后 ` +
      `device=[${ifaDeviceAfter.map(r => r.equip_code).join(',')}]；让位=${JSON.stringify(ifaD1.device && ifaD1.device.superseded)}`);

    /* ---- ③' 权威与不一致提示：IF-A vs IF-D 侧值（C-100 / C-102：IF-D 仅比对与展示） ---- */
    ifaIfdSnap = {
      equipCode: 'IFD-EQ-7', procOrderNo: 'IFD-ORDER-X',
      frameRate: 400, gain: 3.0, shutter: 2000, cameraDepth: 4.60
    };
    const ifaMismatchBeforeIfd = ifaOpRows(IFA_OP_TYPE.MISMATCH).length;
    const ifaProcessB = Object.assign({}, ifaProcessA, { procOrderNo: 'MES-2026-0002', setFrameRate: 500 });
    const ifaD3 = ifaSvc.receive(IFA_KIND.PROCESS, ifaProcessB);
    const ifaMismatchAfterIfd = ifaOpRows(IFA_OP_TYPE.MISMATCH);
    const ifaWarnIfd = (ifaD3.warnings || []).map(w => w.code);
    t.check('IF-A 权威 vs **IF-D 侧值**（C-100 / C-102：IF-D 仅比对与展示）：IF-D 最近帧的 `procOrderNo`／' +
      '`frameRate`（设定值）与 IF-A 工艺信息不一致 ⇒ 逐项给出可见警告（IFD_PROC_ORDER_MISMATCH / ' +
      'IFD_STANDARD_MISMATCH，含两侧取值）并各落一条 `op_log`；IF-A 仍被收下（`stored`），**不收 IF-D 侧的值**',
      ifaD3.outcome === 'stored' &&
      ifaWarnIfd.includes('IFD_PROC_ORDER_MISMATCH') && ifaWarnIfd.includes('IFD_STANDARD_MISMATCH') &&
      ifaD3.warnings.some(w => w.code === 'IFD_STANDARD_MISMATCH' && w.authoritative === 500 && w.ifd === 400) &&
      ifaMismatchAfterIfd.length >= ifaMismatchBeforeIfd + 2,
      `warnings=[${ifaWarnIfd.join(',')}]；mismatch 留痕 ${ifaMismatchBeforeIfd} → ${ifaMismatchAfterIfd.length} 条；` +
      `收下=${ifaD3.outcome}`);

    /* ---- ④ 访问控制 ---- */
    const ifaAuthWarns = ifaLogs.filter(l => l.includes('IF-A 访问控制告警'));
    t.check('IF-A 访问控制①**未配置**（本实例注入 enabled:false）⇒ **放行**（本节 ①～③ 的收下动作已证明）' +
      '且**明确告警**：挂载时 warn 与 error 各一次（W6「对外监听告警」同风格）、响应体与 `/ifa/status` 都带 ' +
      '`auth.warning`、`auth.degraded=true` —— 绝不静默放行',
      ifaSvc.auth.enabled === false && ifaSvc.auth.degraded === true &&
      ifaAuthWarns.filter(l => l.startsWith('warn:')).length >= 1 &&
      ifaAuthWarns.filter(l => l.startsWith('error:')).length >= 1 &&
      typeof ifaSvc.auth.warning === 'string' && ifaSvc.auth.warning.includes('未配置') &&
      ifaSvc.status().auth.degraded === true &&
      ifaSvc.authorize({}, { path: '/ifa/dispatch' }).auth.degraded === true,
      `auth.enabled=${ifaSvc.auth.enabled}；告警日志=${ifaAuthWarns.length} 条（warn ` +
      `${ifaAuthWarns.filter(l => l.startsWith('warn:')).length} / error ` +
      `${ifaAuthWarns.filter(l => l.startsWith('error:')).length}）`);

    const authSvc = createDispatch({
      db: ifaDb.db, logger: ifaLogger, now: ifaClock.source(),
      auth: { enabled: true, token: IFA_TOKEN },
      localEquipCode: '',        // 本机配置比对留空：本节只验鉴权，避免与 ③ 的告警混在一起
      ifd: () => null
    });
    const ifaAuthLogBefore = ifaOpRows(IFA_OP_TYPE.AUTH).length;
    const authNoToken = authSvc.authorize({}, { path: '/ifa/dispatch', kind: 'dispatch' });
    const authBadToken = authSvc.authorize({ 'x-if-token': 'WRONG-TOKEN' },
      { path: '/ifa/dispatch', kind: 'dispatch' });
    const authGoodToken = authSvc.authorize({ authorization: 'Bearer ' + IFA_TOKEN },
      { path: '/ifa/dispatch', kind: 'dispatch' });
    const ifaAuthLogAfter = ifaOpRows(IFA_OP_TYPE.AUTH);
    t.check('IF-A 访问控制②**配置令牌后**：无令牌 ⇒ 401／`AUTH_TOKEN_MISSING`，错令牌 ⇒ 403／`AUTH_TOKEN_INVALID`，' +
      '正确令牌（`Authorization: Bearer` 或 `X-IF-Token`）⇒ 放行；两次失败各落一条 `op_log`（op_type=IF-A访问控制、' +
      'result=失败），**且正文里不出现令牌本身**（不得把口令写进审计台账）',
      authNoToken.ok === false && authNoToken.httpStatus === 401 &&
      authNoToken.code === 'AUTH_TOKEN_MISSING' &&
      authBadToken.ok === false && authBadToken.httpStatus === 403 &&
      authBadToken.code === 'AUTH_TOKEN_INVALID' &&
      authGoodToken.ok === true &&
      ifaAuthLogAfter.length === ifaAuthLogBefore + 2 &&
      ifaAuthLogAfter.every(r => r.result === '失败') &&
      ifaAuthLogAfter.every(r => !String(r.content).includes(IFA_TOKEN)),
      `无令牌=${authNoToken.httpStatus}/${authNoToken.code}；错令牌=${authBadToken.httpStatus}/${authBadToken.code}；` +
      `对令牌 ok=${authGoodToken.ok}；留痕 ${ifaAuthLogBefore} → ${ifaAuthLogAfter.length} 条`);

    /* ---- ⑤ 失败日志：脏入站 ⇒ 拒收 + 可读原因 + op_log（与成功留痕可区分） ---- */
    const ifaRejectBefore = ifaOpRows(IFA_OP_TYPE.REJECT).length;
    const ifaTaskBeforeDirty = ifaTaskRows();
    const ifaDirtyCases = [
      { name: '缺必填 procOrderNo', kind: IFA_KIND.DISPATCH, body: { batchNo: 'PC-1' },
        code: 'MISSING_FIELD', field: 'procOrderNo' },
      { name: 'procOrderNo 类型错（数字）', kind: IFA_KIND.DISPATCH, body: { procOrderNo: 20260927 },
        code: 'BAD_TYPE', field: 'procOrderNo' },
      { name: '派工数量非法（负数）', kind: IFA_KIND.DISPATCH, body: { procOrderNo: 'MES-X', dispatchQty: -5 },
        code: 'BAD_VALUE', field: 'dispatchQty' },
      { name: '派工数量非法（小数）', kind: IFA_KIND.DISPATCH, body: { procOrderNo: 'MES-X', dispatchQty: 1.5 },
        code: 'BAD_VALUE', field: 'dispatchQty' },
      { name: '计划开工时间非法（带 T）', kind: IFA_KIND.DISPATCH,
        body: { procOrderNo: 'MES-X', planStartTime: '2026-09-27T08:00:00' }, code: 'BAD_TIME', field: 'planStartTime' },
      { name: '物料缺物料标识（代码/名称都没有）', kind: IFA_KIND.MATERIAL, body: { procOrderNo: 'MES-X' },
        code: 'MISSING_CONTENT', field: 'materialCode' },
      { name: '工艺无任何工艺内容字段', kind: IFA_KIND.PROCESS, body: { procOrderNo: 'MES-X' },
        code: 'MISSING_CONTENT', field: 'processNo' },
      { name: '设备缺 equipCode', kind: IFA_KIND.DEVICE, body: { equipName: 'X' },
        code: 'MISSING_FIELD', field: 'equipCode' },
      { name: '报文体是数组', kind: IFA_KIND.DISPATCH, body: [1, 2], code: 'BODY_NOT_OBJECT', field: '(body)' },
      { name: '未知入站种类', kind: 'nope', body: {}, code: 'UNKNOWN_KIND', field: '(kind)' }
    ];
    const ifaDirtyProblems = [];
    const ifaDirtySeen = [];
    for (const c of ifaDirtyCases) {
      const r = ifaSvc.receive(c.kind, c.body, { path: '/ifa/' + c.kind });
      ifaDirtySeen.push({ name: c.name, result: r });
      if (r.ok !== false || r.outcome !== 'rejected') {
        ifaDirtyProblems.push(`${c.name} → 竟被收下（${r.outcome}）`); continue;
      }
      if (!r.error || r.error.code !== c.code || r.error.field !== c.field) {
        ifaDirtyProblems.push(`${c.name} → ${r.error && r.error.code}/${r.error && r.error.field}` +
          `（期望 ${c.code}/${c.field}）`);
      }
      if (!r.error || typeof r.error.reason !== 'string' || r.error.reason.length < 8) {
        ifaDirtyProblems.push(`${c.name} → 拒收原因不可读：${JSON.stringify(r.error && r.error.reason)}`);
      }
      if (!r.error || r.error.httpStatus !== 400) {
        ifaDirtyProblems.push(`${c.name} → HTTP 状态码应为 400，实为 ${r.error && r.error.httpStatus}`);
      }
    }
    t.check(`IF-A 失败日志：缺字段 / 类型错 / 数量非法（负数与小数）/ 时间非法 / 无可用业务内容 / 非对象 / 未知种类 ` +
      `共 ${ifaDirtyCases.length} 类脏报文**全部拒收（400）**，每类都给出可读原因（code + field + reason）`,
      ifaDirtyProblems.length === 0,
      ifaDirtyProblems.length ? ifaDirtyProblems.join('；')
        : `${ifaDirtyCases.length}/${ifaDirtyCases.length} 拒收；样例：${ifaDirtySeen[4].result.error.field}／` +
          `${String(ifaDirtySeen[4].result.error.reason).slice(0, 40)}`);

    const ifaRejectRows = ifaOpRows(IFA_OP_TYPE.REJECT);
    t.check('IF-A 失败日志：**每一次拒收都留痕**（op_type=IF-A报文拒收、result=失败、正文含 code/field/原因），' +
      '且**业务表一行未变**；与成功留痕（IF-A派工接收 result=成功）按 op_type/result 可区分 —— ' +
      '这就是把技术债 E16 的"`op_log` 零调用方"接上的那一半',
      ifaRejectRows.length === ifaRejectBefore + ifaDirtyCases.length &&
      ifaRejectRows.every(r => r.result === '失败') &&
      ifaRejectRows.every(r => String(r.content).includes('code=') && String(r.content).includes('原因=')) &&
      ifaTaskRows() === ifaTaskBeforeDirty &&
      ifaOpRows(IFA_OP_TYPE.DISPATCH).some(r => r.result === '成功'),
      `拒收留痕 ${ifaRejectBefore} → ${ifaRejectRows.length} 条（脏报文 ${ifaDirtyCases.length} 类）；` +
      `task ${ifaTaskBeforeDirty} → ${ifaTaskRows()} 行；成功留痕 ` +
      `${ifaOpRows(IFA_OP_TYPE.DISPATCH).filter(r => r.result === '成功').length} 条`);

    /* ---- ⑥ HTTP 最小端到端（进程内临时端口；手法同八之四） ---- */
    const ifaHttpErrors = [];
    const ifaRouter = createRouter({
      getHealth: () => ({ ok: true }),
      onError: err => { ifaHttpErrors.push(String(err && err.message)); }
    });
    const ifaMount = mountIfA(ifaRouter, { dispatch: ifaSvc });
    const ifaServer = http.createServer((req, res) => {
      Promise.resolve(ifaRouter.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
    });
    const ifaAuthRouter = createRouter({ getHealth: () => ({ ok: true }) });
    const ifaAuthMount = mountIfA(ifaAuthRouter, { dispatch: authSvc });
    const ifaAuthServer = http.createServer((req, res) => {
      Promise.resolve(ifaAuthRouter.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
    });
    const ifaPort = await allocPort();
    const ifaAuthPort = await allocPort();
    await new Promise((resolve, reject) => {
      ifaServer.once('error', reject);
      ifaServer.listen(ifaPort, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => {
      ifaAuthServer.once('error', reject);
      ifaAuthServer.listen(ifaAuthPort, '127.0.0.1', resolve);
    });
    const ifaHttpPost = async (port, pathname, body, headers) => {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body)
      });
      return { status: res.status, body: await res.json() };
    };
    const ifaHttpGet = async (port, pathname) => {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
      return { status: res.status, body: await res.json() };
    };

    const ifaHttpDispatch = { procOrderNo: 'MES-2026-HTTP-1', productCode: 'CP-2026-A17', batchNo: 'PC-HTTP-1',
      dispatchQty: 60, planStartTime: '2026-09-27 08:00:00', planEndTime: '2026-09-27 20:00:00' };
    const ifaHttpMaterial = { procOrderNo: 'MES-2026-HTTP-1', materialCode: 'M-HTTP-1', materialName: '测试耗材',
      qty: 3, unit: '件' };
    const ifaHttpProcess = { procOrderNo: 'MES-2026-HTTP-1', processNo: '30', processName: '水下高速摄像检验',
      processRoute: 'RT-HTTP-1', workInstruction: 'WI-HTTP-1' };

    const ifaTaskBeforeHttp = ifaTaskRows();
    const ifaMatBeforeHttp = ifaOpRows(IFA_OP_TYPE.MATERIAL).length;
    const ifaProcBeforeHttp = ifaOpRows(IFA_OP_TYPE.PROCESS).length;
    const ifaH1 = await ifaHttpPost(ifaPort, '/ifa/dispatch', ifaHttpDispatch);
    const ifaH1Rows = ifaTaskRows();
    const ifaH2 = await ifaHttpPost(ifaPort, '/ifa/dispatch', Object.assign({}, ifaHttpDispatch));
    const ifaH2Rows = ifaTaskRows();
    t.check('IF-A 端到端（进程内临时端口）：`POST /ifa/dispatch` 第 1 次 ⇒ 200/`stored` 且 **task 真的多一行**；' +
      '同键第 2 次 ⇒ 200/`duplicate` 且**行数不变**（重复不算错误：MES 不会因此重发）',
      ifaH1.status === 200 && ifaH1.body.outcome === 'stored' && ifaH1Rows === ifaTaskBeforeHttp + 1 &&
      ifaH2.status === 200 && ifaH2.body.outcome === 'duplicate' && ifaH2Rows === ifaH1Rows,
      `#1 HTTP ${ifaH1.status}/${ifaH1.body.outcome} → task ${ifaTaskBeforeHttp}→${ifaH1Rows} 行；` +
      `#2 HTTP ${ifaH2.status}/${ifaH2.body.outcome} → task ${ifaH1Rows}→${ifaH2Rows} 行`);

    const ifaH3 = await ifaHttpPost(ifaPort, '/ifa/material', ifaHttpMaterial);
    const ifaH4 = await ifaHttpPost(ifaPort, '/ifa/material', Object.assign({}, ifaHttpMaterial));
    const ifaMatAfterHttp = ifaOpRows(IFA_OP_TYPE.MATERIAL).length;
    const ifaH5 = await ifaHttpPost(ifaPort, '/ifa/process', ifaHttpProcess);
    const ifaH6 = await ifaHttpPost(ifaPort, '/ifa/process', Object.assign({}, ifaHttpProcess));
    const ifaProcAfterHttp = ifaOpRows(IFA_OP_TYPE.PROCESS).length;
    t.check('IF-A 端到端：`POST /ifa/material` 与 `POST /ifa/process` 各"成功 + 幂等重复" ⇒ 两类留痕各**只多 1 行**' +
      '（`stored` 后 `duplicate` 不追加），HTTP 状态码一律 200',
      ifaH3.status === 200 && ifaH3.body.outcome === 'stored' && ifaH4.body.outcome === 'duplicate' &&
      ifaMatAfterHttp === ifaMatBeforeHttp + 1 &&
      ifaH5.status === 200 && ifaH5.body.outcome === 'stored' && ifaH6.body.outcome === 'duplicate' &&
      ifaProcAfterHttp === ifaProcBeforeHttp + 1,
      `物料 HTTP ${ifaH3.body.outcome}/${ifaH4.body.outcome} → op_log ${ifaMatBeforeHttp}→${ifaMatAfterHttp} 行；` +
      `工艺 HTTP ${ifaH5.body.outcome}/${ifaH6.body.outcome} → op_log ${ifaProcBeforeHttp}→${ifaProcAfterHttp} 行`);

    const ifaTaskBeforeHttpBad = ifaTaskRows();
    const ifaH7 = await ifaHttpPost(ifaPort, '/ifa/dispatch',
      { procOrderNo: 'MES-2026-HTTP-2', planStartTime: '2026-09-27T08:00:00' });
    const ifaH8 = await ifaHttpGet(ifaPort, '/ifa/status');
    const ifaH9 = await ifaHttpGet(ifaPort, '/ifa/nope');
    t.check('IF-A 端到端：`POST /ifa/dispatch` 脏报文（时间带 T）⇒ **400** + `ok:false` + `err.code/field/reason`，' +
      '且**一行未落库**；`GET /ifa/status` 可读到计数 / 访问控制状态 / 权威侧与冲突；未注册路径仍 404（**未另起路由表**）',
      ifaH7.status === 400 && ifaH7.body.ok === false && ifaH7.body.outcome === 'rejected' &&
      ifaH7.body.err && ifaH7.body.err.code === 'BAD_TIME' && ifaH7.body.err.field === 'planStartTime' &&
      ifaTaskRows() === ifaTaskBeforeHttpBad &&
      ifaH8.status === 200 && ifaH8.body.mount === 'ifA' && ifaH8.body.mounted === true &&
      ifaH8.body.counts && typeof ifaH8.body.counts.received === 'number' &&
      ifaH8.body.auth && typeof ifaH8.body.auth.enabled === 'boolean' &&
      ifaH8.body.authority && ifaH8.body.authority.equipCode &&
      ifaH8.body.authority.equipCode.authoritative === IFA_IFA_CODE &&
      ifaH9.status === 404,
      `脏报文 HTTP ${ifaH7.status}/${ifaH7.body.err && ifaH7.body.err.code}；task ${ifaTaskBeforeHttpBad} → ` +
      `${ifaTaskRows()} 行；/ifa/status=${ifaH8.status}（counts.received=${ifaH8.body.counts && ifaH8.body.counts.received}）；` +
      `/ifa/nope=${ifaH9.status}`);

    const ifaAuthTaskBefore = ifaTaskRows();
    const ifaAuthLogBeforeHttp = ifaOpRows(IFA_OP_TYPE.AUTH).length;
    /* ⚠ 用**另一个** procOrderNo：与 ⑥ 的成功用例区分开，否则这里拿到的是 `duplicate`，
       会把"鉴定通过 ⇒ 正常处理"误判成失败（同库同键）。 */
    const ifaAuthDispatch = Object.assign({}, ifaHttpDispatch, { procOrderNo: 'MES-2026-HTTP-AUTH-1' });
    const ifaH10 = await ifaHttpPost(ifaAuthPort, '/ifa/dispatch', ifaAuthDispatch);
    const ifaH11 = await ifaHttpPost(ifaAuthPort, '/ifa/dispatch', ifaAuthDispatch, { 'X-IF-Token': 'WRONG' });
    /* ⚠ 鉴权先于报文校验：脏报文 + 无令牌必须回 **401**（而不是 400）—— 拒绝原因＝鉴权，不是参数（W2 判据②） */
    const ifaH12 = await ifaHttpPost(ifaAuthPort, '/ifa/dispatch', { batchNo: 'no-proc-order-no' });
    const ifaH13 = await ifaHttpPost(ifaAuthPort, '/ifa/dispatch', ifaAuthDispatch,
      { Authorization: 'Bearer ' + IFA_TOKEN });
    const ifaAuthTaskAfter = ifaTaskRows();
    t.check('IF-A 端到端（访问控制）：配置令牌后 无令牌 ⇒ **401**、错令牌 ⇒ **403**，两者**都不落业务表**且各落一条 ' +
      '`op_log`；**脏报文 + 无令牌 ⇒ 401 而不是 400**（鉴权先于参数校验，W2 判据②）；正确令牌 ⇒ 200 且正常落库',
      ifaH10.status === 401 && ifaH10.body.err.code === 'AUTH_TOKEN_MISSING' &&
      ifaH11.status === 403 && ifaH11.body.err.code === 'AUTH_TOKEN_INVALID' &&
      ifaH12.status === 401 && ifaH12.body.err.code === 'AUTH_TOKEN_MISSING' &&
      ifaH13.status === 200 && ifaH13.body.outcome === 'stored' &&
      ifaAuthTaskAfter === ifaAuthTaskBefore + 1 &&
      ifaOpRows(IFA_OP_TYPE.AUTH).length === ifaAuthLogBeforeHttp + 3,
      `无令牌=${ifaH10.status}/${ifaH10.body.err && ifaH10.body.err.code}；错令牌=${ifaH11.status}/` +
      `${ifaH11.body.err && ifaH11.body.err.code}；脏报文无令牌=${ifaH12.status}/` +
      `${ifaH12.body.err && ifaH12.body.err.code}；对令牌=${ifaH13.status}/${ifaH13.body.outcome}；` +
      `task ${ifaAuthTaskBefore} → ${ifaAuthTaskAfter} 行`);

    t.check('IF-A 装配显式性：`mountIfA()` 返回 `mounted:true` 与已注册路由清单（四类入站 + 状态端点），' +
      '且**不抛**（接线成功），与 W6 空壳 `router.mountIfA()` 的 `mounted:false` 形成可核查对照（D23 反静默空转）',
      ifaMount.mounted === true && ifaMount.by === 'W2' && ifaMount.routes.length === 5 &&
      ifaRouter.list().includes('POST /ifa/dispatch') && ifaRouter.list().includes('GET /ifa/status') &&
      ifaAuthMount.mounted === true,
      `mounted=${ifaMount.mounted}；routes=${ifaMount.routes.join(' , ')}`);

    /* 原始输出取证（回执要引用"三类各一次成功 + 一次幂等重复"的原始响应） */
    t.info('IF-A 端到端原始输出（HTTP 层，未加工）：');
    t.info(`  #1 POST /ifa/dispatch  → HTTP ${ifaH1.status} ${JSON.stringify({ outcome: ifaH1.body.outcome, stored: ifaH1.body.stored, key: ifaH1.body.key, table: ifaH1.body.table })}`);
    t.info(`  #2 POST /ifa/dispatch  → HTTP ${ifaH2.status} ${JSON.stringify({ outcome: ifaH2.body.outcome, stored: ifaH2.body.stored, key: ifaH2.body.key })}`);
    t.info(`  #3 POST /ifa/material  → HTTP ${ifaH3.status} ${JSON.stringify({ outcome: ifaH3.body.outcome, sig: ifaH3.body.sig, table: ifaH3.body.table })}`);
    t.info(`  #4 POST /ifa/material  → HTTP ${ifaH4.status} ${JSON.stringify({ outcome: ifaH4.body.outcome, sig: ifaH4.body.sig })}`);
    t.info(`  #5 POST /ifa/process   → HTTP ${ifaH5.status} ${JSON.stringify({ outcome: ifaH5.body.outcome, sig: ifaH5.body.sig, table: ifaH5.body.table })}`);
    t.info(`  #6 POST /ifa/process   → HTTP ${ifaH6.status} ${JSON.stringify({ outcome: ifaH6.body.outcome, sig: ifaH6.body.sig })}`);
    t.info(`  #7 POST /ifa/dispatch  → HTTP ${ifaH7.status} ${JSON.stringify(ifaH7.body.err || ifaH7.body)}`);
    t.info(`  #8 GET  /ifa/status    → HTTP ${ifaH8.status} ${JSON.stringify({ counts: ifaH8.body.counts, auth: { enabled: ifaH8.body.auth.enabled, degraded: ifaH8.body.auth.degraded }, authority: ifaH8.body.authority.equipCode })}`);
    t.info(`  #9 POST /ifa/dispatch（无令牌） → HTTP ${ifaH10.status} ${JSON.stringify(ifaH10.body.err || ifaH10.body)}`);
    t.info(`  #10 POST /ifa/dispatch（错令牌）→ HTTP ${ifaH11.status} ${JSON.stringify(ifaH11.body.err || ifaH11.body)}`);
    t.info(`  #11 POST /ifa/dispatch（脏报文+无令牌）→ HTTP ${ifaH12.status} ${JSON.stringify(ifaH12.body.err || ifaH12.body)}`);
    t.info(`  #12 POST /ifa/dispatch（正确令牌）   → HTTP ${ifaH13.status} ${JSON.stringify({ outcome: ifaH13.body.outcome, stored: ifaH13.body.stored })}`);

    await new Promise(resolve => ifaServer.close(resolve));
    await new Promise(resolve => ifaAuthServer.close(resolve));
    t.check('IF-A 端到端：HTTP 处理期间无未捕获异常（onError 未收到 500）',
      ifaHttpErrors.length === 0, ifaHttpErrors.join(' / '));
  }
  ifaDb.close();   // 夹具自有连接：不关会在 Windows 上锁住临时目录（ADR-0003 D17）

  /* ---------------- 八之六、W4：IF-B 上报 MES（13 字段 / 失败留存 / 唯一人工重报）＋ E16 入库口强制校验 ----------------
     被测对象（W4 新增/接线）：
       · `server/services/uploadReporter.js`（13 字段组装 + 单次发送 + 失败留存 + `retryPending` 人工重报）；
       · `server/http/routes/upload.js` 的 `mountUpload()`（`GET /upload/{pending,status,last}`、`POST /upload/retry`）；
       · `server/repo/standard.js` 的 `addVersion`（**默认强制** `assertInput`）+ 受控跳过出口；
       · `server/services/standard.js` 的 `assertInput/assertLimits`（新增"超量程"判据，量程取配置真源）。
     判据（逐条对应任务书）：
       ① 13 字段齐备且语义正确（字段名与附录 2 逐项对齐；缺值表达符合既定口径）；
       ② `uploadId` 复用**真源** `platform/id.js`（形状/序号域/不产生 000）；
       ③ **失败不自动重试**：落 `upload_log` + 告警 + 待补传条数正确，且**注入时钟推进 5 分钟后仍只有 1 次尝试**；
       ④ **唯一人工入口** `retryPending`：**按序**补传、成功后改"已补传"、**重复调用幂等**（不重复发送）；
       ⑤ `baseUrl` 未配置 ⇒ 显式 `skipped`，**不落"成功"**、一条都不发；
       ⑥ `addVersion` 强制校验：半套 / 偏差正负号非法 / **量程外** 一律拒收且不落库；合法输入成功；
          受控跳过出口单独断言（"默认拒绝"与"显式跳过后成功"成对，防恒真）；
       ⑦ 告警阈值走**单一真源** `mes.queueWarnThreshold`（内存改配置即改判据）。
     手法：**进程内**起一个 `tools\mock-mes` **形状**的假 MES（只作形状参考，真实契约待 Q-23 答复），
     发送实现经 `options.fetch` 注入 ⇒ "HTTP 尝试次数"可被机器计数（证明没有隐藏重试）。
     ⚠ 不新建测试脚本（任务书要求）；夹具沿用本文件既有手法（临时库 + 注入时钟 + 进程内 http.Server）。 */
  t.section('八之六、W4：IF-B 上报 MES（13 字段/失败留存/唯一人工重报）＋ E16 入库口强制校验');

  /* 假 MES：形状照 `tools\mock-mes\mock-mes.js`（`POST /service/:service/:method` + `{status,msg,data}` 回执），
     `equipCode` 为空即回"异常回执"（与 mock-mes 的 makeReceipt 同判据）⇒ 据此制造可复现的失败路径。 */
  const mockHttp = { requests: [], calls: 0, ok: false };
  const mockMesServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      mockHttp.calls++;
      mockHttp.requests.push({ path: req.url, body: body });
      const abnormal = !mockHttp.ok || !body || !body.equipCode;
      const receipt = abnormal
        ? { status: 0, msg: '设备编号不存在/关键字段缺失', data: {} }
        : { status: 1, msg: '已接收', data: { uploadId: body.uploadId } };
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(receipt));
    });
  });
  const mockMesPort = await allocPort();
  await new Promise((resolve, reject) => {
    mockMesServer.once('error', reject);
    mockMesServer.listen(mockMesPort, '127.0.0.1', resolve);
  });
  const mockMesUrl = `http://127.0.0.1:${mockMesPort}`;

  const W4_T0 = '2026-09-28 08:00:00';
  const W4_CLOCK = createClock({ mode: 'fixed', at: W4_T0 });
  let W4_CLOCK_AT = W4_T0;                        // 便于在用例中途"推进时钟"（证明没有隐藏定时重试）
  const w4Now = () => new Date(String(W4_CLOCK_AT).replace(' ', 'T'));
  const w4Db = makeTempDb({ name: 'w4-upload' });
  db.initSchema(w4Db.db, W4_T0);
  const w4Logs = [];
  const w4Logger = {
    info: m => w4Logs.push('info:' + m),
    warn: m => w4Logs.push('warn:' + m),
    error: m => w4Logs.push('error:' + m)
  };
  /* 配置：**同一份真源的对象**（含 W4 起的新键 `reportPlaceholder`），只在内存里改，**不落盘**、不碰 src\*。
     为什么带 `reportPlaceholder`：IF-10 的 `dataList[].uclValue` 占位（N-7 已发口径）在真源文件里已有键；
     其余键与真源逐值一致，便于回执里对照。`dataSource:'mock'` 只用于"无实测帧时 testStatus 退 0=待机"这一
     防御分支的**确定性**（真源现值就是 'mock'）。 */
  const w4Config = {
    dataSource: 'mock',
    device: { equipCode: 'CFG-FALLBACK-EQ' },
    mes: {
      baseUrl: mockMesUrl,
      token: '',
      pathTemplate: '/service/{serviceName}/{methodName}',
      responseStyle: 'status',
      reportPlaceholder: 65535,
      queueCap: 5000,
      queueWarnThreshold: 1
    }
  };
  const w4Fetch = (url, init) => fetch(url, init);
  let w4Reporter = null;
  const buildW4Reporter = (extra = {}) => createUploadReporter(Object.assign({
    db: w4Db.db, logger: w4Logger, now: w4Now, config: w4Config, fetch: w4Fetch, timeoutMs: 2000
  }, extra));
  w4Reporter = buildW4Reporter();

  /* 取数来源（附录 2 的「数据来源」列语义）在库里的落点：device / task / measure_rt 最近一帧 / standard */
  const W4_SEED_AT = '2026-09-28 07:59:50';
  w4Db.db.prepare(
    `INSERT INTO device(equip_code, equip_name, model, location, mes_base_url, camera_count, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run('EQ-W4-001', '水池高速摄像检验设备', 'UC-19CAM', '水池测试间', mockMesUrl, 19, W4_SEED_AT);
  w4Db.db.prepare(
    `INSERT INTO task(proc_order_no, batch_no, product_code, product_name, drawing_no, plan_qty,
                      plan_start_time, plan_end_time, process_no, process_name, status, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('PO-W4-001', 'BATCH-W4', 'PRD-W4', '水下航行体检验件', 'SC710-UW-10', 120,
      '2026-09-28 08:00:00', '2026-09-28 16:00:00', '30', '水下高速摄像检验', '测试中', W4_SEED_AT, W4_SEED_AT);
  /* 故意**先插一条更早的帧、再插最近一帧**：证明"取最近一帧"是按落库先后（id）而不是按插入顺序意外命中。
     两帧都写 `speed=null`、`velocity_x/velocity_y=null`、`frame_rate/gain/shutter/camera_depth=null`
     —— 用来验"数值类缺值 → null（**不写 0**）"这条口径。 */
  const w4InsertFrame = w4Db.db.prepare(
    `INSERT INTO measure_rt(equip_code, proc_order_no, measure_depth, speed, velocity_x, velocity_y,
                            frame_rate, gain, shutter, camera_depth, test_status, collect_time, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  w4InsertFrame.run('EQ-W4-001', 'PO-W4-001', 4.90, null, null, null, null, null, null, null, 1,
    '2026-09-28 07:59:51', W4_SEED_AT);
  w4InsertFrame.run('EQ-W4-001', 'PO-W4-001', 5.12, null, null, null, null, null, null, null, 1,
    '2026-09-28 07:59:52', W4_SEED_AT);
  /* 该工单的生效标准：合法取值（在 `standards.range` 内）⇒ 走 `addVersion` 的**默认**（强制校验）路径 */
  standardRepo.addVersion(w4Db.db, {
    productCode: 'PRD-W4', processCode: '30', createdBy: '张伟', teamCode: 'TM-3901',
    depthTypical: 5.00, depthUpperDev: 0.20, depthLowerDev: -0.20,
    speedTypical: 5.00, speedUpperDev: 0.30, speedLowerDev: -0.30
  }, W4_T0, W4_T0);

  const w4UploadRows = () => w4Db.db.prepare('SELECT * FROM upload_log ORDER BY id').all();
  const w4StandardRows = () => w4Db.db.prepare('SELECT * FROM standard ORDER BY id').all();

  /* ---- ① 13 字段齐备且语义正确 ---- */
  const built1 = w4Reporter.buildReport({});
  const expect13 = {
    equipCode: 'EQ-W4-001', procOrderNo: 'PO-W4-001',
    frameRate: null, gain: null, shutter: null, cameraDepth: null,
    depth: 5.12, speed: null, velocity_x: null, velocity_y: null,
    collectTime: '2026-09-28 07:59:52', testStatus: 1
  };
  const misField = [];
  for (const k of Object.keys(expect13)) {
    if (built1.ok && built1.body[k] !== expect13[k]) {
      misField.push(`${k}: 实得 ${JSON.stringify(built1.body[k])} ≠ 期望 ${JSON.stringify(expect13[k])}`);
    }
  }
  t.check('W4/IF-B.8＋附录 2：`buildReport()` 组装的报文字段**恰为附录 2 的 13 项、不多不少**，' +
    '每个字段的取数与"数据来源"列一致（设备/工单来自 `device`/`task`、实测六项来自 `measure_rt` **最近一帧**、' +
    '`collectTime` 取该帧 `collect_time`、`testStatus` 取该帧 `test_status`）；' +
    '`uclValue`/`lclValue`/`IsPass` **不在** 13 字段里（C-78：属 §1.2.5，另由 `paramDataList` 承载）',
    built1.ok === true &&
    JSON.stringify(Object.keys(built1.body)) === JSON.stringify([...fixture.REPORT_FIELDS, 'paramDataList']) &&
    JSON.stringify(built1.fields) === JSON.stringify([...fixture.REPORT_FIELDS]) &&
    misField.length === 0 && !built1.fields.includes('paramDataList') &&
    built1.frameId === 2 && built1.collectTimeFallback === false,
    misField.length ? misField.join('；') : `字段=${built1.fields.join(',')}`);

  t.check('W4/IF-B.8：13 字段的**缺值口径**符合既定做法 —— 数值类缺值写 `null`（**不写 0**：0 是合法物理量，' +
    '写 0 会让 MES 把"没有数据"读成"测到 0"）；写 0 只保留给 `dataSource=mock` 且**库内一帧都没有**时的 ' +
    '`testStatus` 防御分支（那时代码语义＝待机，不是"缺值"）',
    built1.ok === true && ['frameRate', 'gain', 'shutter', 'cameraDepth', 'speed', 'velocity_x', 'velocity_y']
      .every(k => built1.body[k] === null) &&
    JSON.stringify(built1.missing) === JSON.stringify(['frameRate', 'gain', 'shutter', 'cameraDepth', 'speed', 'velocity_x', 'velocity_y']) &&
    built1.body.depth === 5.12 && built1.body.collectTime === '2026-09-28 07:59:52',
    `missing=${built1.missing.join(',')}；depth=${built1.body.depth}（该帧有值）；` +
    `speed=${JSON.stringify(built1.body.speed)}（该帧为空）`);

  t.check('W4/IF-B.5＋C-78：报文另带 §1.2.5 的 `paramDataList`（**两条**：`depth`/`speed`，按 `tagParam` 区分），' +
    '上下限取值**按报文时刻取"当时生效版本"**（DR-03）：本帧时刻（07:59:52）早于标准生效时刻（08:00:00）' +
    '⇒ **当时无生效版本** ⇒ 两条都走已发口径的**占位**（`uclValue`/`lclValue`＝65535、`IsPass`＝null，' +
    '字段保留、结构不缺项）；报文时刻在生效之后时的**绝对值**口径见下方"新帧"断言',
    built1.ok === true && Array.isArray(built1.body.paramDataList) && built1.body.paramDataList.length === 2 &&
    built1.body.paramDataList[0].tagParam === 'depth' && built1.body.paramDataList[0].uclValue === 65535 &&
    built1.body.paramDataList[0].lclValue === 65535 && built1.body.paramDataList[0].IsPass === null &&
    built1.body.paramDataList[1].tagParam === 'speed' && built1.body.paramDataList[1].uclValue === 65535 &&
    built1.body.paramDataList[1].lclValue === 65535 && built1.body.paramDataList[1].IsPass === null &&
    built1.standardVersionNo === null,
    JSON.stringify(built1.body.paramDataList));

  /* ---- ② uploadId 复用真源（platform/id.js 的形状与序号域） ---- */
  const idCheck = platformId.isUploadId(built1.body.uploadId);
  const idSeq = Number(String(built1.body.uploadId).slice(16));
  t.check('W4/DR-13＋E31：`uploadId` 由**真源** `platform/id.js` 生成 —— 形状 `UP+14 位时间+3 位序号`、' +
    '序号域 1～999、**永不产生 000**；时间部分＝注入时钟（`' + W4_T0 + '` ⇒ 20260928080000），序号从 001 起',
    idCheck.ok === true && String(built1.body.uploadId).startsWith('UP20260928080000') &&
    idSeq === 1 && !String(built1.body.uploadId).endsWith('000'),
    `uploadId=${built1.body.uploadId}；isUploadId=${JSON.stringify(idCheck)}`);

  const sameSec = [];
  for (let i = 0; i < 1000; i++) sameSec.push(w4Reporter.buildReport({}).body.uploadId);
  const sameSecSeqs = sameSec.map(v => Number(v.slice(16)));
  const uniqSeq = [...new Set(sameSecSeqs)].sort((a, b) => a - b);
  t.check('W4/E31：同一秒内连出 1000 个 `uploadId` ⇒ 序号**恰好覆盖 001～999 一轮**（不重不漏），' +
    '且**永不产生 000**（含 000 即回绕成了 `…000`，与 `isUploadId` 的"001～999 合法"两判相反 —— ' +
    '那正是 R26-P3-3 修掉的缺陷）；1000 个里恰好有 1 个重复（＝第二次回到起点）',
    uniqSeq.length === 999 && uniqSeq[0] === 1 && uniqSeq[998] === 999 &&
    sameSecSeqs.every(v => v >= 1 && v <= 999) &&
    new Set(sameSec).size === 999 &&
    sameSec.every(v => platformId.isUploadId(v).ok === true),
    `序号域 = [${uniqSeq[0]} .. ${uniqSeq[998]}]（互异 ${uniqSeq.length} 个）；` +
    `含 000=${sameSecSeqs.includes(0)}；首尾序列：[${sameSecSeqs.slice(0, 3).join(',')} … ${sameSecSeqs.slice(-3).join(',')}]`);

  /* ---- ③ 失败路径：留存 + 告警 + 待补传条数；且**不自动重试** ---- */
  mockHttp.ok = false;                     // 让假 MES 回"异常回执"（status:0）
  const mockCallsBefore = mockHttp.calls;
  const fail1 = await w4Reporter.report({});
  const rowsAfterFail = w4UploadRows();
  const row1 = rowsAfterFail[0];
  /* ⚠ 判据用 `fail1.uploadId`（本次上报**实际发出**的那一个），**不要**拿之前 `buildReport()` 的产物 ——
     每次组装都会从 `platform/id.js` 取一个新序号（这是真源的正确行为），两者的序号必然不同。 */
  t.check('W4/IF-B.9＋DR-11：上报失败（MES 回 `status:0` 异常回执）⇒ 报文**落 `upload_log` 留存**' +
    '（state=`待补传`、失败原因/响应码/耗时/请求报文逐项留痕，IF-B.10 的"请求、响应、耗时、结果"四栏齐）' +
    '＋**告警**（`alert.warn`）＋**待补传条数＝1**；`ok:false` 如实回报，**不当成成功**',
    fail1.ok === false && fail1.pendingCount === 1 && fail1.alert && fail1.alert.warn === true &&
    rowsAfterFail.length === 1 && row1 &&
    row1.state === '待补传' && row1.upload_id === fail1.uploadId &&
    row1.interface === 'report/receiveReport' &&
    row1.response_code === '0' && Number(row1.retry_count) === 0 &&
    typeof row1.fail_reason === 'string' && row1.fail_reason.includes('设备编号不存在') &&
    Number(row1.elapsed_ms) >= 0 &&
    (() => { try { return JSON.parse(row1.request_body).uploadId === row1.upload_id; } catch { return false; } })(),
    `state=${row1 && row1.state}；pending=${fail1.pendingCount}；code=${row1 && row1.response_code}；` +
    `原因=${row1 && row1.fail_reason}；id=${fail1.uploadId}`);

  t.check('W4/V1.31＋C-59：**不自动重试** —— 注入时钟**推进 5 分钟**后，`upload_log` 仍**恰 1 行**、' +
    '`retry_count=0`、假 MES 侧 HTTP 尝试次数仍**恰 1 次**（既无定时器也没有"延时再试一次"）、`attempts()=1`；' +
    '重报只能由**人工**入口触发',
    mockHttp.calls - mockCallsBefore === 1 && w4UploadRows().length === 1 &&
    Number(w4UploadRows()[0].retry_count) === 0 &&
    w4Reporter.pendingCount(true) === 1 && w4Reporter.attempts() === 1 &&
    (() => {
      const st = w4Reporter.status();
      return st.autoRetry === false && String(st.autoRetryNote).includes('不做自动重试') &&
        st.attemptCount === 1;
    })(),
    `HTTP 尝试=${mockHttp.calls - mockCallsBefore} 次；attempts()=${w4Reporter.attempts()}；` +
    `upload_log=${w4UploadRows().length} 行；retry_count=${w4UploadRows()[0].retry_count}`);

  /* 基准：把该条清空（模拟现场已人工处置），后两条用例各自独立造数 */
  w4Db.db.exec('DELETE FROM upload_log');

  /* ---- ④ 唯一人工入口：按序补传 + 幂等 ---- */
  mockHttp.ok = true;                      // 从这一刻起假 MES 正常收
  w4Db.db.prepare(
    `INSERT INTO measure_rt(equip_code, proc_order_no, measure_depth, speed, velocity_x, velocity_y,
                            frame_rate, gain, shutter, camera_depth, test_status, collect_time, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('EQ-W4-001', 'PO-W4-001', 5.30, null, null, null, null, null, null, null, 1,
      '2026-09-28 08:00:01', W4_SEED_AT);
  /* 新帧（collectTime 08:00:01 ≥ 标准生效时刻 08:00:00）⇒ 该帧的 `paramDataList` 必须取到绝对值 */
  const builtNewFrame = w4Reporter.buildReport({});
  t.check('W4/IF-B.5＋C-78：报文另带 §1.2.5 的 `paramDataList`（**两条**：`depth`/`speed`），' +
    '`uclValue`/`lclValue` 取**绝对值**（本用例标准 5.00±0.20 / 5.00±0.30）⇒ 5.2/4.8 与 5.3/4.7；' +
    '`IsPass` 由本机按导出上下限判定（帧值 5.30 落在 [4.8, 5.2] **之外** ⇒ false；speed 无实测值 ⇒ null＝不做判定）',
    builtNewFrame.ok === true && Array.isArray(builtNewFrame.body.paramDataList) &&
    builtNewFrame.body.paramDataList.length === 2 &&
    builtNewFrame.body.paramDataList[0].tagParam === 'depth' &&
    builtNewFrame.body.paramDataList[0].uclValue === 5.2 &&
    builtNewFrame.body.paramDataList[0].lclValue === 4.8 &&
    builtNewFrame.body.paramDataList[0].IsPass === false &&
    builtNewFrame.body.paramDataList[1].tagParam === 'speed' &&
    builtNewFrame.body.paramDataList[1].uclValue === 5.3 &&
    builtNewFrame.body.paramDataList[1].lclValue === 4.7 &&
    builtNewFrame.body.paramDataList[1].IsPass === null &&
    builtNewFrame.standardVersionNo === 1 && builtNewFrame.body.depth === 5.30,
    JSON.stringify(builtNewFrame.body.paramDataList));

  /* ⚠ **清空假 MES 台账**：本断言的"HTTP 次数"只统计本断言自己的发送（否则会带上 ③ 的首发失败那一次） */
  mockHttp.requests.length = 0;
  mockHttp.ok = false;
  const fail2 = await w4Reporter.report({});                     // 失败 #1 ⇒ 待补传（含 uploadId）
  mockHttp.ok = true;
  const realLast = await w4Reporter.report({});                  // 成功 ⇒ upload_log 记"成功"（首发成功留痕）
  const sent2 = await w4Reporter.report({});                     // 同一帧再组装 ⇒ 指纹相同 ⇒ **跳过**
  const rowsAfterOk = w4UploadRows();
  t.check('W4/IF-B.10：**首发成功也留痕**（三态齐：成功/失败/待补传）—— `state=成功`、失败原因清空、' +
    '响应码＝回执 `status`（1）；且**同一帧不重复上报**：报文（除 `uploadId`）与最近一次成功完全相同 ⇒ `skipped` 且**一次 HTTP 都不发**',
    fail2.ok === false && realLast.ok === true && sent2.skipped === true &&
    sent2.reason === 'STALE_FRAME' &&
    rowsAfterOk.length === 2 &&
    rowsAfterOk[1].state === '成功' && rowsAfterOk[1].fail_reason === null &&
    rowsAfterOk[1].response_code === '1' &&
    mockHttp.requests.length === 2 &&
    realLast.uploadId !== fail2.uploadId && sent2.uploadId !== realLast.uploadId,
    `首发失败 id=${fail2.uploadId}；首发成功 id=${realLast.uploadId}；再次组装 id=${sent2.uploadId}` +
    `（skipped=${sent2.skipped}，reason=${sent2.reason}）；upload_log=${rowsAfterOk.length} 行；` +
    `本轮 HTTP 台账=[${mockHttp.requests.map(r => r.body && r.body.uploadId).join(',')}]（首发失败 1 + 首发成功 1；第三次**未发**）`);

  w4Db.db.exec('DELETE FROM upload_log');
  mockHttp.requests.length = 0;
  /* 两条待补传：`created_at` 用注入时钟的两条不同时刻 ⇒ "按序（最旧优先）"可判 */
  const pendA = { uploadId: 'UP20260928075959001', interface: 'report/receiveReport', state: '待补传' };
  const pendB = { uploadId: 'UP20260928075959002', interface: 'report/receiveReport', state: '待补传' };
  w4Db.db.prepare(
    `INSERT INTO upload_log(upload_id, interface, request_body, response_code, response_body,
                            elapsed_ms, retry_count, state, created_at, fail_reason, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, 0, '待补传', ?, ?, ?)`)
    .run(pendA.uploadId, pendA.interface, JSON.stringify({ uploadId: pendA.uploadId, equipCode: 'EQ-W4-001', procOrderNo: 'PO-W4-001' }),
      '0', '异常回执', 12, '2026-09-28 07:59:59', '设备编号不存在/关键字段缺失', '2026-09-28 07:59:59');
  w4Db.db.prepare(
    `INSERT INTO upload_log(upload_id, interface, request_body, response_code, response_body,
                            elapsed_ms, retry_count, state, created_at, fail_reason, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, 0, '待补传', ?, ?, ?)`)
    .run(pendB.uploadId, pendB.interface, JSON.stringify({ uploadId: pendB.uploadId, equipCode: 'EQ-W4-001', procOrderNo: 'PO-W4-001' }),
      '0', '异常回执', 12, '2026-09-28 08:00:00', '设备编号不存在/关键字段缺失', '2026-09-28 08:00:00');
  const pendingBefore = w4Reporter.listPending({});
  const retry1 = await w4Reporter.retryPending({});
  const sentIds = mockHttp.requests.map(r => r.body.uploadId);
  const rowsAfterRetry1 = w4Db.db.prepare('SELECT * FROM upload_log ORDER BY id').all();
  const retry2 = await w4Reporter.retryPending({});
  t.check('W4/IF-B.9＋UI-20：**人工一键重报**按**顺序**（最旧优先）逐条补传 —— 假 MES 收到的 `uploadId` 序列' +
    '＝待补传清单顺序；成功后状态改为**已补传（`成功`）**、`fail_reason` 清空；**重复调用幂等**：' +
    '第二次 `requested=0`、**不再发送**（含 `state ∈ (待补传,失败)` 的查询口径）',
    pendingBefore.map(i => i.uploadId).join(',') === `${pendA.uploadId},${pendB.uploadId}` &&
    sentIds.join(',') === pendingBefore.map(i => i.uploadId).join(',') &&
    retry1.ok === true && retry1.requested === 2 && retry1.sent === 2 && retry1.failed === 0 &&
    retry1.remaining === 0 && retry1.alert.pendingCount === 0 &&
    rowsAfterRetry1.every(r => r.state === '成功' && r.fail_reason === null) &&
    retry2.requested === 0 && retry2.sent === 0 && retry2.failed === 0 && retry2.remaining === 0 &&
    mockHttp.requests.length === 2,
    `清单顺序=${pendingBefore.map(i => i.uploadId).join(',')}；MES 实收=${sentIds.join(',')}；` +
    `retry#1 sent=${retry1.sent}/failed=${retry1.failed}/remaining=${retry1.remaining}；` +
    `retry#2 requested=${retry2.requested}/sent=${retry2.sent}；HTTP 共 ${mockHttp.requests.length} 次`);

  /* 单条重报（`ids` 过滤）：只发指定那条，其余留在队列里，且**已成功的那条不会被重发** */
  w4Db.db.prepare(
    `INSERT INTO upload_log(upload_id, interface, request_body, response_code, response_body,
                            elapsed_ms, retry_count, state, created_at, fail_reason, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, 0, '待补传', ?, ?, ?)`)
    .run('UP20260928080001003', 'report/receiveReport',
      JSON.stringify({ uploadId: 'UP20260928080001003', equipCode: 'EQ-W4-001', procOrderNo: 'PO-W4-001' }),
      '0', '异常回执', 9, '2026-09-28 08:00:02', '设备编号不存在/关键字段缺失', '2026-09-28 08:00:02');
  const reqBefore4 = mockHttp.requests.length;
  const pendIdsBefore4 = w4Reporter.listPending({}).map(i => i.uploadId);
  const retry4 = await w4Reporter.retryPending({
    ids: ['UP20260928075959001', 'UP20260928075959002', 'UP20260928080001003']
  });
  const rowsAfterRetry4 = w4Db.db.prepare('SELECT upload_id, state FROM upload_log ORDER BY id').all();
  const sentIds4 = mockHttp.requests.slice(reqBefore4).map(r => r.body.uploadId);
  t.check('W4/UI-20：`retryPending({ids})` 的**幂等**语义 —— 点名 3 条（其中 2 条此前已补传成功）时：' +
    '只有**仍待补传**的那条被发出（`requested=1`），已成功的两条**一条都不发**（它们已不在 `state ∈ 待补传/失败` 的清单里，' +
    '`isPending()` 为 false）—— **绝不能**因为"被点名"就把已上报成功的报文再发一遍（IF-B.9 的"不重复"）',
    retry4.requested === 1 && retry4.sent === 1 && retry4.failed === 0 &&
    retry4.results.length === 1 && retry4.results[0].uploadId === 'UP20260928080001003' &&
    sentIds4.join(',') === 'UP20260928080001003' &&
    pendIdsBefore4.join(',') === 'UP20260928080001003' &&
    w4Reporter.queue.isPending('UP20260928075959001') === false &&
    rowsAfterRetry4.length === 3 && rowsAfterRetry4.every(r => r.state === '成功') &&
    mockHttp.requests.length - reqBefore4 === 1,
    `pendingBefore=[${pendingBefore.map(i => i.uploadId).join(',')}]；` +
    `pendIdsBefore4=[${pendIdsBefore4.join(',')}]；retry4.results=${JSON.stringify(retry4.results)}；` +
    `retry1(requested=${retry1.requested}/sent=${retry1.sent}/remaining=${retry1.remaining})；` +
    `retry2(requested=${retry2.requested}/sent=${retry2.sent})；` +
    `retry4(requested=${retry4.requested}/sent=${retry4.sent}/skipped=${retry4.results.filter(r => r.skipped).length})；` +
    `本轮实发=${sentIds4.join(',')}；MES 台账=[${mockHttp.requests.map(r => r.body && r.body.uploadId).join(',')}]；` +
    `upload_log 状态=[${rowsAfterRetry4.map(r => r.upload_id + ':' + r.state).join(',')}]`);

  /* ---- ⑤ baseUrl 未配置 ⇒ 显式 skipped，不落"成功" ---- */
  const cfgNoUrl = { mes: Object.assign({}, w4Config.mes, { baseUrl: '' }) };
  const noUrlReporter = buildW4Reporter({ config: cfgNoUrl });
  const noUrlReport = await noUrlReporter.report({});
  const noUrlStatus = noUrlReporter.status();
  t.check('W4/Q-23：`mes.baseUrl` **未配置** ⇒ `report()` 显式返回 `{ok:false, skipped:true, reason:\'未配置 MES 地址（Q-23）\'}`' +
    '（**不得当成成功**）；`status().configured=false` 且带 `configWarning`（界面/巡检据此显示"未配置"）',
    noUrlReport.ok === false && noUrlReport.skipped === true &&
    noUrlReport.reason === '未配置 MES 地址（Q-23）' &&
    noUrlStatus.configured === false && typeof noUrlStatus.configWarning === 'string' &&
    noUrlStatus.configWarning.includes('未配置 MES 地址'),
    `report ⇒ ${JSON.stringify({ ok: noUrlReport.ok, skipped: noUrlReport.skipped, reason: noUrlReport.reason })}；` +
    `status.configured=${noUrlStatus.configured}`);

  const reqBefore5 = mockHttp.requests.length;
  const noUrlRetry = await noUrlReporter.retryPending({});
  const stateBefore5 = w4Db.db.prepare('SELECT COUNT(*) AS c FROM upload_log WHERE state = ?').get('成功').c;
  const stateAfter5 = w4Db.db.prepare('SELECT COUNT(*) AS c FROM upload_log WHERE state = ?').get('成功').c;
  t.check('W4/Q-23：未配置 MES 地址时人工重报**一条都不发**（`skipped` + `sent=0`），且**不落任何"成功"**；' +
    '待补传清单原样保留（不因"没配置"而丢报文）',
    noUrlRetry.ok === false && noUrlRetry.skipped === true && noUrlRetry.sent === 0 &&
    noUrlRetry.requested === 0 && noUrlRetry.results.length === 0 &&
    noUrlRetry.remaining === 0 &&
    mockHttp.requests.length - reqBefore5 === 0 && stateBefore5 === stateAfter5,
    `retry ⇒ ${JSON.stringify({ skipped: noUrlRetry.skipped, sent: noUrlRetry.sent, requested: noUrlRetry.requested })}；` +
    `成功行 ${stateBefore5} → ${stateAfter5}`);

  const lastBodyStillPending = noUrlReporter.buildReport({});
  const reportPayload13 = lastBodyStillPending.ok ? lastBodyStillPending.body : null;
  t.check('W4/IF-B.8：**未配置地址也不影响报文组装**（组装是纯读库、无副作用）：仍能拿到完整的 13 字段报文' +
    '（供人工在界面上核对"要报什么"），只是**不发**',
    lastBodyStillPending.ok === true && reportPayload13 &&
    fixture.REPORT_FIELDS.every(f => Object.prototype.hasOwnProperty.call(reportPayload13, f)),
    reportPayload13 ? `uploadId=${reportPayload13.uploadId}，字段数=${Object.keys(reportPayload13).length}` : '组装失败');

  /* ---- ⑥ E16：addVersion 默认强制校验 + 受控跳过出口 ---- */
  const w4StdBefore = w4StandardRows().length;
  const rejectReasons = [];
  let halfThrew = false;
  try {
    standardRepo.addVersion(w4Db.db, { productCode: 'P-E16-1', processCode: '30', depthUpperDev: 0.30 }, W4_T0, W4_T0);
  } catch (e) { halfThrew = true; rejectReasons.push('半套：' + e.message); }
  const outOfRange = { rejected: 0, unmet: 0, messages: [] };
  for (const bad of [
    { productCode: 'P-E16-2', processCode: '30', depthTypical: 12.00, depthUpperDev: 0.20, depthLowerDev: -0.20,
      speedTypical: 5.00, speedUpperDev: 0.20, speedLowerDev: -0.20 },
    { productCode: 'P-E16-3', processCode: '30', depthTypical: 5.00, depthUpperDev: 0.20, depthLowerDev: -0.20,
      speedTypical: 20.00, speedUpperDev: 0.20, speedLowerDev: -0.20 }
  ]) {
    try {
      standardRepo.addVersion(w4Db.db, bad, W4_T0, W4_T0);
      outOfRange.unmet++;
    } catch (e) {
      outOfRange.rejected++;
      outOfRange.messages.push(e.message);
    }
  }
  const w4StdAfterReject = w4StandardRows().length;
  t.check('W4/E16①＋FR-3.19⑥：`addVersion` **默认强制**校验 —— **半套标准**（只给上偏差）与**量程外**' +
    '（深度 12.00 m 越出 [4, 6]、速度 20.00 m/s 越出 [3, 8]，量程取 `board.config.js` 的 `standards.range` 真源）' +
    '一律**拒收**，原因可读（含参数名/实际值/量程），且**一行都不落库**',
    halfThrew === true && outOfRange.rejected === 2 && outOfRange.unmet === 0 &&
    w4StdAfterReject === w4StdBefore &&
    rejectReasons[0].includes('同时给出') &&
    outOfRange.messages.every(m => m.includes('量程') && m.includes('depth') || m.includes('量程') && m.includes('speed')),
    `半套=${halfThrew}；量程外拒收=${outOfRange.rejected}/2；standard 行数 ${w4StdBefore} → ${w4StdAfterReject}；` +
    `样例：${outOfRange.messages[0]}`);

  const signBad = { productCode: 'P-E16-4', processCode: '30', depthTypical: 5.00, depthUpperDev: -0.10, depthLowerDev: 0.10,
    speedTypical: 5.00, speedUpperDev: 0.20, speedLowerDev: -0.20 };
  let signThrew = false;
  let signMessage = '';
  try {
    standardRepo.addVersion(w4Db.db, signBad, W4_T0, W4_T0);
  } catch (e) { signThrew = true; signMessage = e.message; }
  const legalAdd = standardRepo.addVersion(w4Db.db, {
    productCode: 'P-E16-OK', processCode: '30', depthTypical: 5.00, depthUpperDev: 0.20, depthLowerDev: -0.20,
    speedTypical: 5.00, speedUpperDev: 0.20, speedLowerDev: -0.20
  }, W4_T0, W4_T0);
  t.check('W4/E16①：**偏差正负号非法**（下偏差为正、上偏差为负 ⇒ 下限 5.10 > 上限 4.90）拒收且不落库；' +
    '**合法输入**（在量程内、三项齐、符号正确）⇒ 成功落库（负对照：证明不是"把什么都拒收"）',
    signThrew === true && signMessage.includes('下限') &&
    legalAdd.versionNo === 1 && legalAdd.validation === 'ok' && legalAdd.id > 0,
    `符号错 ⇒ ${signMessage.slice(0, 60)}；合法 ⇒ v${legalAdd.versionNo}（validation=${legalAdd.validation}）`);

  const skipE16Input = { productCode: 'P-E16-SKIP', processCode: '30', depthUpperDev: 0.30 };
  const skipAdd = standardRepo.addVersion(w4Db.db, skipE16Input, W4_T0, W4_T0, { dangerouslySkipValidation: true });
  let defaultRejectsSame = false;
  try { standardRepo.addVersion(w4Db.db, { ...skipE16Input, productCode: 'P-E16-SKIP2' }, W4_T0, W4_T0); }
  catch { defaultRejectsSame = true; }
  t.check('W4/E16：**受控跳过出口**单独断言 —— 只有**显式**传危险开关（`{dangerouslySkipValidation:true}`）才跳过校验，' +
    '且返回值**如实回显** `validation:\'dangerous-skip\'` + 说明文字（跳过**不静默**）；同一份入参走默认路径**仍然被拒**' +
    '（成对断言：证明"跳过"确实生效、且默认路径没有被悄悄放宽）',
    skipAdd.validation === 'dangerous-skip' &&
    String(skipAdd.validationMessage).includes('跳过') &&
    defaultRejectsSame === true,
    `跳过 ⇒ validation=${skipAdd.validation}；同入参默认路径 ⇒ ${defaultRejectsSame ? '拒收' : '竟被收下'}`);

  /* ---- ⑦ 告警阈值走单一真源（内存改配置，不落盘） ---- */
  const thresholdAt = at => createUploadReporter({
    db: w4Db.db, logger: w4Logger, now: w4Now, fetch: w4Fetch,
    config: { dataSource: 'mock', device: { equipCode: 'CFG-FALLBACK-EQ' },
      mes: Object.assign({}, w4Config.mes, { queueWarnThreshold: at }) }
  });
  const warnSrcBefore = boardConfig.mes.queueWarnThreshold;
  let warnAt1 = null;
  let warnAt2 = null;
  let reportedAt1 = null;
  let reportedAt2 = null;
  try {
    boardConfig.mes.queueWarnThreshold = 1;
    const rep1 = thresholdAt(1);
    rep1.queue.enqueueFailed({ uploadId: 'UP-W4-THRESH-1', interface: 'report/receiveReport', requestBody: { i: 1 }, failReason: '阈值用例' });
    warnAt1 = rep1.status().alert;
    reportedAt1 = rep1.status().warnThreshold;
    boardConfig.mes.queueWarnThreshold = 2;
    const rep2 = thresholdAt(2);
    warnAt2 = rep2.status().alert;
    reportedAt2 = rep2.status().warnThreshold;
  } finally {
    boardConfig.mes.queueWarnThreshold = warnSrcBefore;      // **必须还原**（内存真源，勿留污染）
  }
  t.check('W4/判据⑦＋R26-P3-4：告警阈值走**单一真源** `mes.queueWarnThreshold` —— 内存把真源改成 1 ⇒ ' +
    '1 条待补传即 `alert.warn=true`；改成 2 ⇒ 同一条**不告警**（`warn=false`）；两次都从配置读出阈值' +
    '（**不得**按容量比例换算，也不得写死在实现里）；用完已把真源还原为 ' + JSON.stringify(warnSrcBefore),
    warnAt1 && warnAt1.warn === true && warnAt1.pendingCount === 1 && reportedAt1 === 1 &&
    warnAt2 && warnAt2.warn === false && warnAt2.pendingCount === 1 && reportedAt2 === 2 &&
    boardConfig.mes.queueWarnThreshold === warnSrcBefore,
    `阈值 1 ⇒ warn=${warnAt1 && warnAt1.warn}（pending=${warnAt1 && warnAt1.pendingCount}）；` +
    `阈值 2 ⇒ warn=${warnAt2 && warnAt2.warn}；真源现值（已还原）=${boardConfig.mes.queueWarnThreshold}`);

  /* ---- ⑧ 端到端：mountUpload 的四条端点（进程内临时端口；手法同八之四/八之五） ---- */
  const w4HttpErrors = [];
  const w4Router = createRouter({
    getHealth: () => ({ ok: true }),
    onError: err => { w4HttpErrors.push(String(err && err.message)); }
  });
  const uploadStruct = mountUpload(w4Router, {
    db: w4Db.db, logger: w4Logger, now: w4Now, config: w4Config, fetch: w4Fetch, timeoutMs: 2000
  });
  const w4Server = http.createServer((req, res) => {
    Promise.resolve(w4Router.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
  });
  const w4Port = await allocPort();
  await new Promise((resolve, reject) => {
    w4Server.once('error', reject);
    w4Server.listen(w4Port, '127.0.0.1', resolve);
  });
  const w4Get = async pathname => {
    const res = await fetch(`http://127.0.0.1:${w4Port}${pathname}`);
    return { status: res.status, body: await res.json() };
  };
  const w4Post = async (pathname, body) => {
    const res = await fetch(`http://127.0.0.1:${w4Port}${pathname}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };

  /* 干净起点：清空 upload_log、**同时清空假 MES 侧请求台账**（否则"本轮 HTTP 次数"的计数会带上前面用例的发送），
     再**落一条新帧**（collectTime 08:00:05）—— 否则最近一帧与刚才成功上报的那帧逐字相同，`report()` 会按
     "同一帧不重复上报"正确地跳过（那是 §6 已断言过的行为，本节要验的是"首发失败 ⇒ 待补传"）。 */
  w4Db.db.exec('DELETE FROM upload_log');
  mockHttp.requests.length = 0;
  w4InsertFrame.run('EQ-W4-001', 'PO-W4-001', 5.40, null, null, null, null, null, null, null, 1,
    '2026-09-28 08:00:05', W4_SEED_AT);
  mockHttp.ok = false;
  const failH = await uploadStruct.instance.report({});
  const pendList = await w4Get('/upload/pending');
  const stat = await w4Get('/upload/status');
  const last = await w4Get('/upload/last');
  t.check('W4/UI-20 端到端：`GET /upload/pending` 可读待补传清单（条数 + 明细：接口名/时间/失败原因，' +
    '清单本身按最旧优先）；`GET /upload/status` 给出配置与告警（含"待补传条数"与 `autoRetry:false`）；' +
    '`GET /upload/last` 给出**完整 13 字段报文**（只组装、不发送）',
    failH.ok === false &&
    pendList.status === 200 && pendList.body.count === 1 &&
    pendList.body.items.length === 1 && pendList.body.items[0].uploadId === failH.uploadId &&
    pendList.body.items[0].interface === 'report/receiveReport' &&
    typeof pendList.body.items[0].failReason === 'string' &&
    typeof pendList.body.items[0].createdAt === 'string' &&
    pendList.body.alert.warn === true &&
    stat.status === 200 && stat.body.configured === true && stat.body.autoRetry === false &&
    stat.body.pendingCount === 1 && stat.body.warnThreshold === 1 &&
    stat.body.lastLogged && stat.body.lastLogged.state === '待补传' &&
    last.status === 200 && last.body.available === true &&
    fixture.REPORT_FIELDS.every(f => Object.prototype.hasOwnProperty.call(last.body.body, f)),
    `pending=${pendList.body.count}（${pendList.body.items[0] && pendList.body.items[0].failReason}）；` +
    `status.configured=${stat.body.configured}/autoRetry=${stat.body.autoRetry}/pending=${stat.body.pendingCount}；` +
    `last 字段数=${last.body.body ? Object.keys(last.body.body).length : 0}`);

  mockHttp.ok = true;
  const retryHttp = await w4Post('/upload/retry', {});
  const retryHttp2 = await w4Post('/upload/retry', {});
  const stateRows = w4Db.db.prepare('SELECT upload_id, state FROM upload_log ORDER BY id').all();
  t.check('W4/UI-20 端到端：`POST /upload/retry` 按序补传 ⇒ 200 + `sent=1`、状态改为**已补传（成功）**、' +
    '`remaining=0`；**重复调用幂等**（第二次 `sent=0`、`requested=0`）；`GET /upload/pending` 随之清空；' +
    '且人工重报**只发了一次** HTTP（假 MES 侧计到 `sent` 条，没有多发）',
    retryHttp.status === 200 && retryHttp.body.ok === true && retryHttp.body.sent === 1 &&
    retryHttp.body.failed === 0 && retryHttp.body.remaining === 0 &&
    retryHttp.body.results.length === 1 && retryHttp.body.results[0].uploadId === failH.uploadId &&
    retryHttp2.status === 200 && retryHttp2.body.requested === 0 && retryHttp2.body.sent === 0 &&
    stateRows.length === 1 && stateRows[0].state === '成功' &&
    mockHttp.requests.length === 2,
    `retry#1 ⇒ sent=${retryHttp.body.sent}/remaining=${retryHttp.body.remaining}；` +
    `retry#2 ⇒ requested=${retryHttp2.body.requested}/sent=${retryHttp2.body.sent}；` +
    `落库状态=${stateRows.map(r => r.state).join(',')}；本轮 HTTP（首发失败 1 + 人工补传 1）共 ${mockHttp.requests.length} 次`);

  mockHttp.requests.length = 0;
  /* 再落一条**新帧**（collectTime 08:00:09）：`report()` 的组装结果随帧变化 ⇒ 不会被"同一帧不重复上报"跳过 */
  w4InsertFrame.run('EQ-W4-001', 'PO-W4-001', 4.70, null, null, null, null, null, null, null, 1,
    '2026-09-28 08:00:09', W4_SEED_AT);
  mockHttp.ok = false;                     // 让假 MES 回异常回执 ⇒ 这一帧进"待补传"
  const failH2 = await uploadStruct.instance.report({});
  const pendingBeforeBad = w4Db.db.prepare("SELECT COUNT(*) AS c FROM upload_log WHERE state IN ('待补传','失败')").get().c;
  const successBeforeBad = w4Db.db.prepare("SELECT COUNT(*) AS c FROM upload_log WHERE state = '成功'").get().c;
  const retryHttpBad = await w4Post('/upload/retry', { limit: 0 });
  const retryHttpMissing = await w4Get('/upload/nope');
  const pendAfter = await w4Get('/upload/pending');
  t.check('W4 端到端：`POST /upload/retry` 入参非法（`limit: 0`）⇒ **400** + `err.code/field/reason`，且**一条都不发**、' +
    '`upload_log` 状态一行不变（待补传仍在）；未注册路径仍 **404**（**未另起路由表** —— 路由清单仍只有 ' +
    '`server/http/router.js` 一份真源）',
    failH2.ok === false && failH2.pendingCount === 1 && failH2.alert.warn === true &&
    pendingBeforeBad === 1 && successBeforeBad === 1 &&
    retryHttpBad.status === 400 &&
    retryHttpBad.body.err && retryHttpBad.body.err.code === 'BAD_VALUE' &&
    retryHttpBad.body.field === 'limit' &&
    retryHttpBad.body.ok === false &&
    retryHttpMissing.status === 404 && pendAfter.body.count === 1 &&
    mockHttp.requests.length === 1 &&
    w4Db.db.prepare("SELECT COUNT(*) AS c FROM upload_log WHERE state = '成功'").get().c === successBeforeBad,
    `limit:0 ⇒ HTTP ${retryHttpBad.status} ${JSON.stringify(retryHttpBad.body)}` +
    `（本轮 HTTP 共 ${mockHttp.requests.length} 次：先首发失败一次，再 limit:0 一次不应发）；` +
    `/upload/nope ⇒ HTTP ${retryHttpMissing.status}；待补传 ${pendingBeforeBad} → ${pendAfter.body.count} 条、` +
    `成功行仍 ${successBeforeBad} 行（**状态一行未变**）`);

  t.check('W4 装配显式性：`mountUpload()` 返回 `mounted:true` 与已注册路由清单（三条只读 + 一条人工重报），' +
    '且**不抛**（接线成功），与 W6 空壳 `router.mountUpload()` 的 `mounted:false` 形成可核查对照（D23 反静默空转）',
    uploadStruct.mounted === true && uploadStruct.by === 'W4' &&
    uploadStruct.routes.length === 4 &&
    w4Router.list().includes('GET /upload/pending') &&
    w4Router.list().includes('GET /upload/status') &&
    w4Router.list().includes('GET /upload/last') &&
    w4Router.list().includes('POST /upload/retry') &&
    uploadStruct.status().mount === 'upload',
    `mounted=${uploadStruct.mounted}；routes=${uploadStruct.routes.join(' , ')}`);

  /* 原始输出取证（回执要引用"端到端最小原始输出"） */
  t.info('W4 端到端原始输出（HTTP 层，未加工）：');
  t.info(`  假 MES 地址=${mockMesUrl}（形状照 tools\\mock-mes，契约待 Q-23）；本次共收到 ${mockHttp.calls} 次请求`);
  t.info(`  #1 GET  /upload/pending → HTTP ${pendList.status} ${JSON.stringify({ count: pendList.body.count, alert: pendList.body.alert, item: pendList.body.items[0] && { uploadId: pendList.body.items[0].uploadId, state: pendList.body.items[0].state, failReason: pendList.body.items[0].failReason } })}`);
  t.info(`  #2 GET  /upload/status  → HTTP ${stat.status} ${JSON.stringify({ configured: stat.body.configured, baseUrl: stat.body.baseUrl, pendingCount: stat.body.pendingCount, warnThreshold: stat.body.warnThreshold, autoRetry: stat.body.autoRetry, attemptCount: stat.body.attemptCount, lastLogged: stat.body.lastLogged && stat.body.lastLogged.state })}`);
  t.info(`  #3 GET  /upload/last    → HTTP ${last.status} ${JSON.stringify({ available: last.body.available, missing: last.body.missing, fields: last.body.fields, body: last.body.body })}`);
  t.info(`  #4 POST /upload/retry   → HTTP ${retryHttp.status} ${JSON.stringify({ ok: retryHttp.body.ok, requested: retryHttp.body.requested, sent: retryHttp.body.sent, failed: retryHttp.body.failed, remaining: retryHttp.body.remaining, results: retryHttp.body.results })}`);
  t.info(`  #5 POST /upload/retry（幂等重复） → HTTP ${retryHttp2.status} ${JSON.stringify({ requested: retryHttp2.body.requested, sent: retryHttp2.body.sent, remaining: retryHttp2.body.remaining })}`);
  t.info(`  #6 POST /upload/retry（limit:0）  → HTTP ${retryHttpBad.status} ${JSON.stringify(retryHttpBad.body.err)}`);
  t.info(`  #7 GET  /upload/nope    → HTTP ${retryHttpMissing.status} ${JSON.stringify(retryHttpMissing.body.err || {})}`);
  t.info(`  #8 未配置 baseUrl 时 report() → ${JSON.stringify(noUrlReport)}`);
  t.info(`  #9 全段累计（含前面的失败留存用例）：假 MES HTTP 尝试=${mockHttp.calls}、上报器 attempts()=${w4Reporter.attempts()}` +
    `（**不做自动重试**：两者都只随"人工/首发调用"线性增长，时钟推进不会让它们变大）`);

  await new Promise(resolve => w4Server.close(resolve));
  t.check('W4 端到端：HTTP 处理期间无未捕获异常（onError 未收到 500）',
    w4HttpErrors.length === 0, w4HttpErrors.join(' / '));

  await new Promise(resolve => mockMesServer.close(resolve));
  w4Db.close();   // 夹具自有连接：不关会在 Windows 上锁住临时目录（ADR-0003 D17）

  /* ---------------- 九、E18 迁移前强制备份（不可跳过 / 失败即中止 / 可审计） ----------------
     技术债 E18 原文（`项目记录\后续路线图.md` 第六节）：旧库迁移即 `DROP TABLE standard_legacy`，
     旧设定值不可恢复 ⇒ 迁移前必须**强制**备份 + 可审计日志。
     本节四条判据（逐条对应验收要求）：
       ① 迁移前**确实生成**备份，且备份内容含**迁移前**的数据（可证伪："迁移后才备份"必红）；
       ② 备份失败（注入故障 / 目录不可写）⇒ **抛错中止迁移**且旧数据完整（不得静默继续）；
       ③ 无迁移时**不产生**备份（幂等：重复 initSchema 不会每次多一份）；
       ④ `op_log` 有对应留痕（含备份文件路径、原因、结果），可查询。
     **一用例一库**：本节自带旧结构库，与六之七那个旧库用例互不复用（那边验"迁移后的结构"）。 */
  t.section('九、E18 迁移前强制备份（不可跳过 / 失败即中止 / 无迁移不备份 / 可审计）');
  const E18_INS = `INSERT INTO standard(product_code, set_depth, set_gain, set_frame_rate, set_shutter,
                                          effective_from, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)`;
  const seedLegacyStandard = (conn, rows) => {
    const stmt = conn.prepare(E18_INS);
    for (const r of rows) stmt.run(...r);
  };
  const LEGACY_ROWS = [
    ['P-E18-A', 12.5, 8, 60, 100, '2026-01-01 08:00:00', '2026-01-01 08:00:00'],
    ['P-E18-A', 13.5, 9, 50, 90, '2026-03-01 08:00:00', '2026-03-01 08:00:00'],
    ['P-E18-B', 7.25, 6, 30, 200, '2026-02-01 08:00:00', '2026-02-01 08:00:00']
  ];
  const e18Clock = createClock({ mode: 'fixed', at: '2026-09-19T10:00:00' });

  const e18Keep = makeTempDb({ name: 'e18-legacy', initSql: [LEGACY_STANDARD_SQL, LEGACY_OPLOG_SQL] });
  seedLegacyStandard(e18Keep.db, LEGACY_ROWS);
  const e18BackupDir = path.join(e18Keep.dir, 'backup');
  const e18Plan = db.planMigration(e18Keep.db);
  if (t.requires('E18 前提：旧库被判为"需要迁移前备份"（standard 旧结构 + 无结构版本记录），' +
    '且确有 3 行旧设定值可丢（否则"备份成功"证明不了什么）',
    e18Plan.needed === true && e18Plan.legacyStandard === 'legacy' &&
    e18Plan.reasons.length >= 1 &&
    db.listColumns(e18Keep.db, 'standard').includes('set_depth') &&
    e18Keep.db.prepare('SELECT COUNT(*) AS c FROM standard').get().c === 3,
    JSON.stringify(e18Plan))) {
    const e18Init = db.initSchema(e18Keep.db, NOW, { backupDir: e18BackupDir, now: e18Clock.now() });
    const e18Pre = e18Init.preMigrationBackup;
    const e18Files = maintain.listBackups(e18BackupDir);
    /* 判据①：备份确实发生，且 initSchema 把"路径/体积/原因/引擎"如实回报（可审计的前提）。
       ⚠ 这里对 `path`/`audit` 做**类型守卫**（`fs.existsSync(null)` 会抛 ERR_INVALID_ARG_TYPE）：
       变异取证时"备份根本没做"必须表现为**一条变红的断言**，而不是把整个自检脚本崩掉。
       D22 变异点：把 `initSchema()` 里 `plan.needed ? runPreMigrationBackup(...)` 改成恒 false ⇒ 本行变红。 */
    const e18PathOk = typeof e18Pre.path === 'string' && e18Pre.path !== '' && fs.existsSync(e18Pre.path);
    t.check('E18①：破坏性迁移**之前确实生成了备份** —— `initSchema()` 回报 `needed/ok/path/bytes/reason`，' +
      '备份目录里恰好 1 份文件，且本次迁移确实发生（migrated=true）',
      e18Pre.needed === true && e18Pre.ok === true && e18Files.length === 1 &&
      e18PathOk && e18Pre.bytes > 0 &&
      /standard 是旧结构/.test(String(e18Pre.reason)) &&
      e18Init.migration.migrated === true &&
      Boolean(e18Pre.audit) && e18Pre.audit.ok === true,
      `备份=${e18Pre.name}（${e18Pre.bytes} 字节，engine=${e18Pre.engine}）；原因=${e18Pre.reason}；` +
      `migration=${JSON.stringify(e18Init.migration)}；audit=${JSON.stringify(e18Pre.audit)}`);

    /* 判据①b：备份**内容**是迁移前的旧库 —— 把备份当独立库打开：
       旧列（set_depth 等）还在、`version_no` 还没有、3 行旧设定值一行不丢。
       D22 变异点：把备份调用挪到 `initSchema()` 的事务 COMMIT **之后** ⇒ 这里会看到新结构（set_depth 消失）
       ⇒ 本行变红（这正是"证明是迁移前而不是迁移后"的可证伪点）。 */
    let e18BkpCols = [];
    let e18BkpRows = [];
    let e18BkpProblem = e18PathOk ? '' : `备份文件不存在或路径非法（path=${JSON.stringify(e18Pre.path)}）`;
    if (e18PathOk) {
      const e18Backup = db.openDb(e18Pre.path, { journalMode: 'DELETE' });
      try {
        e18BkpCols = db.listColumns(e18Backup.db, 'standard');
        e18BkpRows = e18Backup.db.prepare('SELECT * FROM standard ORDER BY id').all();
      } catch (err) {
        e18BkpProblem = `打开备份库失败：${err.message}`;
      } finally {
        e18Backup.db.close();   // 独立句柄必须自己关（否则 Windows 上临时目录删不掉）
      }
    }
    t.check('E18①b：备份内容是**迁移前**的旧库 —— 备份内 `standard` 仍含 set_depth/set_gain/set_frame_rate/set_shutter、' +
      '**没有** version_no/process_code，且 3 行旧设定值原样（12.5 / 13.5 / 7.25）',
      e18BkpProblem === '' &&
      e18BkpCols.includes('set_depth') && e18BkpCols.includes('set_shutter') &&
      !e18BkpCols.includes('version_no') && !e18BkpCols.includes('process_code') &&
      e18BkpRows.length === 3 &&
      e18BkpRows[0].set_depth === 12.5 && e18BkpRows[1].set_depth === 13.5 && e18BkpRows[2].set_depth === 7.25 &&
      e18BkpRows[2].product_code === 'P-E18-B',
      e18BkpProblem || `备份内 standard 列=[${e18BkpCols.join(', ')}]，行数=${e18BkpRows.length}，` +
      `set_depth=${e18BkpRows.map(r => r.set_depth).join('/')}`);

    /* 备份**不挡路**：迁移照常完成（当前库已是新结构）—— 否则"备份"就成了新的阻断源 */
    const e18LiveCols = db.listColumns(e18Keep.db, 'standard');
    t.check('E18①c：备份**不挡路** —— 备份之后迁移照常完成（当前库已是新结构、旧列消失、结构版本＝SCHEMA_VERSION）',
      e18LiveCols.includes('version_no') && e18LiveCols.includes('process_code') &&
      !e18LiveCols.includes('set_depth') && db.getSchemaVersion(e18Keep.db) === SCHEMA_VERSION,
      `当前库列=[${e18LiveCols.join(', ')}]，版本=${db.getSchemaVersion(e18Keep.db)}`);

    /* 判据④：可审计 —— `op_log` 里能查到"备份文件路径 + 原因 + 结果"。
       注意：旧库的 `op_log` 在备份发生时**还没有 team_code 列**（补列在 schema.sql 之后），
       故这条留痕走的是 `db/index.js` 的兼容插入路径（`audit.compat=true`）—— 断言把它一并锁住：
       "最需要留痕的场合（旧库迁移）留痕不得丢"。 */
    const e18Audit = opLogRepo.list(e18Keep.db, { opType: db.PRE_MIGRATION_BACKUP_OP_TYPE }, { limit: 20 });
    t.check('E18④：备份动作与结果写 `op_log`（`op_type=迁移前备份`；content 含**备份文件路径、原因、结果**），可查询；' +
      '且这条留痕在"旧库 op_log 尚无 team_code"时也写得进去（兼容路径 compat=true，team_code 留 NULL）',
      e18Audit.length === 1 && e18Audit[0].result === '成功' &&
      String(e18Audit[0].content).includes(e18Pre.name) &&
      String(e18Audit[0].content).includes('standard 是旧结构') &&
      String(e18Audit[0].content).includes('结果=成功') &&
      e18Audit[0].teamCode === null &&
      e18Pre.audit.compat === true &&
      /* F19-5 对照：本来就有 `op_log` 表的库 ⇒ 迁移前那次审计成功 ⇒ **不得**再补写（仍恰 1 行、无 backfill） */
      e18Pre.auditBackfilled === false && e18Pre.backfillAudit === null &&
      !String(e18Audit[0].content).includes('backfill'),
      `op_log=#${e18Audit[0] && e18Audit[0].id}｜${e18Audit[0] && e18Audit[0].opType}｜${e18Audit[0] && e18Audit[0].result}｜` +
      `auditBackfilled=${e18Pre.auditBackfilled}｜${e18Audit[0] && e18Audit[0].content}`);

    /* 判据③：无迁移时**不再**产出备份（幂等）。
       D22 变异点：把触发判据改成"无条件备份"（去掉 `plan.needed` 分支）⇒ 本行变红（目录会变成 2 份）。 */
    const e18Second = db.initSchema(e18Keep.db, NOW, { backupDir: e18BackupDir, now: e18Clock.now() });
    const e18SecondPre = e18Second.preMigrationBackup;
    t.check('E18③：**无迁移时的再次 initSchema 不产生备份**（幂等）—— 第二次 `needed=false`/`path=null`/' +
      '`migration.migrated=false`，目录里仍是那 1 份',
      e18SecondPre.needed === false && e18SecondPre.path === null &&
      maintain.listBackups(e18BackupDir).length === 1 &&
      e18Second.migration.migrated === false && e18SecondPre.audit === null,
      `第二次 needed=${e18SecondPre.needed}、path=${JSON.stringify(e18SecondPre.path)}、` +
      `目录 ${maintain.listBackups(e18BackupDir).length} 份、migration=${JSON.stringify(e18Second.migration)}`);
  }
  e18Keep.close();

  /* ③b：**空库首建**也不需要备份（没有可丢的数据）—— 否则"每次首次启动都多一份备份" */
  const e18Fresh = makeTempDb({ name: 'e18-fresh' });
  const e18FreshDir = path.join(e18Fresh.dir, 'backup');
  const e18Fresh1 = db.initSchema(e18Fresh.db, NOW, { backupDir: e18FreshDir, now: e18Clock.now() });
  const e18Fresh2 = db.initSchema(e18Fresh.db, NOW, { backupDir: e18FreshDir, now: e18Clock.now() });
  t.check('E18③b：**空库首建**不需要迁移前备份（没有可丢的数据）—— 首建 `needed=false` 且**目录根本没被创建**；' +
    '紧接着的重复初始化同样不产出备份',
    e18Fresh1.preMigrationBackup.needed === false && e18Fresh2.preMigrationBackup.needed === false &&
    (!fs.existsSync(e18FreshDir) || maintain.listBackups(e18FreshDir).length === 0) &&
    e18Fresh1.migration.migrated === false,
    `首建 needed=${e18Fresh1.preMigrationBackup.needed}、目录存在=${fs.existsSync(e18FreshDir)}`);

  /* 判据②：备份失败 ⇒ **抛错中止**（两种造错方式：注入备份函数 / 备份目录不可写） */
  const e18Fail = makeTempDb({ name: 'e18-legacy-fail', initSql: [LEGACY_STANDARD_SQL, LEGACY_OPLOG_SQL] });
  seedLegacyStandard(e18Fail.db, LEGACY_ROWS);
  const e18FailSnapshot = () => JSON.stringify({
    cols: db.listColumns(e18Fail.db, 'standard'),
    rows: e18Fail.db.prepare('SELECT * FROM standard ORDER BY id').all(),
    tables: db.listTables(e18Fail.db).slice().sort(),
    version: db.getSchemaVersion(e18Fail.db)
  });
  const e18Before = e18FailSnapshot();
  let e18Threw = null;
  try {
    db.initSchema(e18Fail.db, NOW, {
      backupDir: path.join(e18Fail.dir, 'backup'), now: e18Clock.now(),
      backup: () => { throw new Error('注入的备份故障（自检用）'); }
    });
  } catch (err) { e18Threw = err; }
  t.check('E18②：备份失败 ⇒ **抛错并中止迁移**（`code=PRE_MIGRATION_BACKUP_FAILED`，信息写明"已中止、业务数据一行不动' +
    '（仅追加 1 条 E18 失败留痕）" —— 措辞按 F17-4 修正），**不是**"写不出就跳过备份继续迁移"',
    Boolean(e18Threw) && e18Threw.code === 'PRE_MIGRATION_BACKUP_FAILED' &&
    /已\*\*中止\*\*/.test(e18Threw.message) && /注入的备份故障/.test(e18Threw.message),
    e18Threw ? `${e18Threw.code}｜${e18Threw.message}` : '（竟未抛错 —— 缺陷）');
  t.check('E18②b：中止后**业务数据原样完整** —— `standard` 仍是旧结构、3 行一行不丢（逐列快照相等）、' +
    '无 standard_legacy 残表、结构版本未升（`op_log` 里则**追加了 1 条** E18 失败留痕，见下一条）',
    e18FailSnapshot() === e18Before &&
    !db.listTables(e18Fail.db).includes('standard_legacy') &&
    db.getSchemaVersion(e18Fail.db) === null,
    `中止前后快照相同=${e18FailSnapshot() === e18Before}；表=[${db.listTables(e18Fail.db).join(', ')}]；` +
    `版本=${JSON.stringify(db.getSchemaVersion(e18Fail.db))}`);
  t.check('E18②c：备份**失败也留痕**（`op_log` 里 `result=失败` + 错误原因），审计不因中止而缺失',
    (() => {
      const rows = opLogRepo.list(e18Fail.db, { opType: db.PRE_MIGRATION_BACKUP_OP_TYPE }, { limit: 20 });
      return rows.length === 1 && rows[0].result === '失败' &&
        String(rows[0].content).includes('注入的备份故障') &&
        String(rows[0].content).includes('结果=失败');
    })(),
    JSON.stringify(opLogRepo.list(e18Fail.db, { opType: db.PRE_MIGRATION_BACKUP_OP_TYPE }, { limit: 20 })
      .map(r => ({ result: r.result, content: r.content }))));
  /* 第二种造错方式：备份目录**不可写**（路径被同名文件占位 ⇒ mkdir ENOTDIR/EEXIST）。
     D22 变异点：把 `backupToSync` 的 `fs.mkdirSync` 去掉、或让 `runPreMigrationBackup` 吞掉异常 ⇒ 本行变红。 */
  const e18NotADir = path.join(e18Fail.dir, 'not-a-dir');
  fs.writeFileSync(e18NotADir, 'occupies the path');
  let e18DirThrew = null;
  try {
    db.initSchema(e18Fail.db, NOW, { backupDir: e18NotADir, now: e18Clock.now() });
  } catch (err) { e18DirThrew = err; }
  t.check('E18②d：备份**目录不可写**（路径被同名文件占位）同样**中止迁移**，且业务数据仍未被改动（快照不变）',
    Boolean(e18DirThrew) && e18DirThrew.code === 'PRE_MIGRATION_BACKUP_FAILED' &&
    /EEXIST|ENOTDIR|not a directory|already exists/i.test(e18DirThrew.message) &&
    e18FailSnapshot() === e18Before,
    e18DirThrew ? e18DirThrew.message : '（竟未抛错 —— 缺陷）');

  /* 第三种造错方式：**库文件路径推导不出来**（内存库）—— 迁移前备份不可跳过，这时宁可中止，
     也**不得**退化成"备份到当前工作目录"（那会把备份文件写进仓库工作目录，比不备份更糟）。
     D22 变异点：把 `runPreMigrationBackup()` 里"取不到库文件路径就抛错"改成 `dir = '.'` ⇒ 本行变红。 */
  {
    const { DatabaseSync } = require('node:sqlite');
    const mem = new DatabaseSync(':memory:');
    mem.exec(LEGACY_STANDARD_SQL);
    mem.exec(LEGACY_OPLOG_SQL);
    seedLegacyStandard(mem, LEGACY_ROWS.slice(0, 2));
    const before = JSON.stringify({
      cols: mem.prepare("SELECT name FROM pragma_table_info('standard')").all().map(r => r.name),
      rows: mem.prepare('SELECT * FROM standard ORDER BY id').all()
    });
    let memThrew = null;
    try { db.initSchema(mem, NOW, { now: e18Clock.now() }); } catch (err) { memThrew = err; }
    const after = JSON.stringify({
      cols: mem.prepare("SELECT name FROM pragma_table_info('standard')").all().map(r => r.name),
      rows: mem.prepare('SELECT * FROM standard ORDER BY id').all()
    });
    t.check('E18②e：**库文件路径推导不出来**（内存库）时同样**中止迁移**，且**不把备份落到当前工作目录**' +
      '（错误信息指明"无法确定库文件路径"）；旧数据原样',
      Boolean(memThrew) && memThrew.code === 'PRE_MIGRATION_BACKUP_FAILED' &&
      /无法确定库文件路径/.test(memThrew.message) && before === after,
      memThrew ? `${memThrew.code}｜${memThrew.message.slice(0, 120)}` : '（竟未抛错 —— 缺陷）');
    mem.close();
  }
  /* "不可跳过"本身也是判据：显式要求跳过 ⇒ 抛错（拒绝"关掉备份让迁移过去"） */
  t.check('E18：迁移前备份**不可跳过** —— 显式传 `skipBackup:true` 即抛错（该开关**只用于拒绝**，不是后门）',
    (() => {
      try { db.initSchema(e18Fresh.db, NOW, { skipBackup: true }); return false; }
      catch (err) { return /不可跳过/.test(err.message); }
    })(),
    'skipBackup:true ⇒ 抛错「迁移前备份**不可跳过**」');

  /* **F17-3 ＋ F19-5**：极旧的库里可能**连 `op_log` 表都还没有** ⇒ 迁移前那次审计必然失败。
     · F17-3：db 层**就地** `logger.warn` 告警 ＋ 返回值带 `auditDegraded:true`（不得静默），**迁移照常**；
     · F19-5：迁移成功、`op_log` 表建好之后，**补写**一条留痕（内容标注 `backfill（迁移后补写）`），
       把"可审计"从易失告警补成落库事实。
     D22 变异点（副本上做）：①`auditOrWarn()` 换回裸 `appendBackupLog()` ⇒ 告警丢；
     ②把 `initSchema()` 里的补写分支改成 `if (false)` ⇒ 补写行丢（两个方向各一组）。 */
  {
    const e18NoLog = makeTempDb({ name: 'e18-no-oplog', initSql: [LEGACY_STANDARD_SQL] });
    seedLegacyStandard(e18NoLog.db, LEGACY_ROWS.slice(0, 2));
    const e18Warns = [];
    let e18NoLogInfo = null;
    let e18NoLogThrew = null;
    try {
      e18NoLogInfo = db.initSchema(e18NoLog.db, NOW, {
        backupDir: path.join(e18NoLog.dir, 'backup'), now: e18Clock.now(),
        logger: { warn: m => e18Warns.push(String(m)) }
      });
    } catch (err) { e18NoLogThrew = err; }
    const e18NoLogPre = e18NoLogInfo && e18NoLogInfo.preMigrationBackup;
    /* 迁移后 `op_log` 已存在 ⇒ 应恰有 1 条补写行，且内容含 backfill */
    const e18BackfillRows = e18NoLogThrew ? [] : opLogRepo.list(
      e18NoLog.db, { opType: db.PRE_MIGRATION_BACKUP_OP_TYPE }, { limit: 20 });
    t.check('E18/F17-3：库内**没有 `op_log` 表**（极旧库）⇒ 迁移前审计写入必然失败，此时必须**显式告警出口**' +
      '（注入的 `logger.warn` 收到告警、返回值带 `auditDegraded:true`）—— 不得静默吞掉；' +
      '同时备份与迁移**照常完成**（"审计不了"不等于"不许迁移"）',
      e18NoLogThrew === null && Boolean(e18NoLogPre) &&
      e18NoLogPre.ok === true && e18NoLogPre.audit.ok === false && e18NoLogPre.auditDegraded === true &&
      /no such table|op_log/i.test(String(e18NoLogPre.audit.error)) &&
      e18Warns.length === 1 && /审计留痕写入失败/.test(e18Warns[0]) &&
      Boolean(e18NoLogInfo.migration) && e18NoLogInfo.migration.migrated === true &&
      fs.existsSync(e18NoLogPre.path) && e18NoLogPre.bytes > 0,
      e18NoLogThrew ? `抛异常（缺陷）：${e18NoLogThrew.message}`
        : `audit=${JSON.stringify(e18NoLogPre && e18NoLogPre.audit)}｜auditDegraded=${e18NoLogPre && e18NoLogPre.auditDegraded}｜` +
          `migration=${JSON.stringify(e18NoLogInfo && e18NoLogInfo.migration)}｜告警=${JSON.stringify(e18Warns)}`);
    t.check('E18/F19-5：迁移成功且**迁移前审计失败**时 ⇒ `initSchema()` 在 `op_log` 建好后**补写**一条 E18 留痕：' +
      '返回值 `auditBackfilled=true` ＋ `backfillAudit.ok=true`，库里**恰 1 行** `迁移前备份` 且 `content` 含 `backfill`' +
      '（把"可审计"从易失告警补成落库事实；不改变"审计不了也不中止迁移"的既定口径）',
      e18NoLogThrew === null && Boolean(e18NoLogPre) &&
      e18NoLogPre.auditBackfilled === true &&
      Boolean(e18NoLogPre.backfillAudit) && e18NoLogPre.backfillAudit.ok === true &&
      Number.isInteger(e18NoLogPre.backfillAudit.id) &&
      e18BackfillRows.length === 1 && e18BackfillRows[0].result === '成功' &&
      String(e18BackfillRows[0].content).includes('backfill') &&
      String(e18BackfillRows[0].content).includes(String(e18NoLogPre.name)),
      e18NoLogThrew ? `抛异常（缺陷）：${e18NoLogThrew.message}`
        : `auditBackfilled=${e18NoLogPre && e18NoLogPre.auditBackfilled}｜` +
          `backfillAudit=${JSON.stringify(e18NoLogPre && e18NoLogPre.backfillAudit)}｜` +
          `补写行=${JSON.stringify(e18BackfillRows.map(r => ({ op: r.opType, result: r.result, content: String(r.content).slice(0, 90) })))}`);
    e18NoLog.close();
  }
  e18Fail.close();
  e18Fresh.close();

  /* ---------------- 九之二、E44 备份文件名同秒不覆盖 ----------------
     技术债 E44 原文：`db-check` 的「保留策略只保留最近 N 份」在压测下偶发红，根因＝备份文件名**秒级**
     （同一秒内多次备份**同名互相覆盖**，于是"连做 N 次"实际只剩 1 份）。
     本节判据：同一秒（连毫秒都相同）内连做 5 次备份 ⇒ **5 个不同文件**，保留策略仍只保留最近 N 份；
     并且**两条备份路径（异步 `backupTo` / 同步 `backupToSync`）都要满足** —— 只修一条 = 另一条照样覆盖。 */
  t.section('九之二、E44 备份文件名同秒不覆盖（毫秒 + 冲突递增探测）');
  const e44Dir = makeTempDir('e44-backup');
  const e44Same = new Date(2026, 8, 19, 10, 0, 0);      // 同一秒、同一毫秒
  const e44Names = [];
  for (let i = 0; i < 5; i++) {
    const b = await maintain.backupTo(handle.db, e44Dir, { now: e44Same });
    e44Names.push(b.name);
  }
  t.check('E44①：**同一秒（同一毫秒）内连做 5 次备份 ⇒ 5 个不同文件**，5 份都真的落盘 ' +
    '（改前实测：秒级命名下这 5 次只剩 1 份 ⇒ `listBackups` 只数到 1）',
    new Set(e44Names).size === 5 && maintain.listBackups(e44Dir).length === 5 &&
    e44Names.every(n => fs.existsSync(path.join(e44Dir, n))),
    `5 次备份文件名=[${e44Names.join(', ')}]；目录内 ${maintain.listBackups(e44Dir).length} 份`);
  t.check('E44②：文件名带**毫秒**段 `board-YYYYMMDD-HHmmss-SSS.db`，且 **字典序＝时间序**' +
    '（保留策略按名字倒排删除，"删最旧"才删得对）；同毫秒冲突按 1 ms **递增探测**而不是加序号后缀',
    e44Names.every(n => maintain.BACKUP_FILE_RE.test(n)) &&
    JSON.stringify(e44Names.slice().sort()) === JSON.stringify(e44Names) &&
    e44Names[0] === 'board-20260919-100000-000.db' &&
    e44Names[1] === 'board-20260919-100000-001.db' &&
    e44Names[4] === 'board-20260919-100000-004.db',
    `名字=${e44Names.join(', ')}`);
  const e44Pruned = maintain.pruneBackups(e44Dir, 2);
  const e44Kept = maintain.listBackups(e44Dir).map(b => b.name).sort();
  t.check('E44③：保留策略**仍只保留最近 N 份**（5 份 ⇒ 保留 2 份、删除 3 份），且删掉的正是**最旧**的 3 份' +
    '（同秒内按毫秒序判定，不是随机删）',
    e44Pruned.kept === 2 && e44Pruned.removed.length === 3 &&
    JSON.stringify(e44Pruned.removed.slice().sort()) === JSON.stringify(e44Names.slice(0, 3).sort()) &&
    JSON.stringify(e44Kept) === JSON.stringify(e44Names.slice(3).sort()),
    `保留=[${e44Kept.join(', ')}]；删除=[${e44Pruned.removed.join(', ')}]`);

  /* 同步形态（E18 迁移前备份走的那条路）必须同样满足：只修异步那条 = 迁移前备份照样同秒覆盖。
     逐次 try/catch：`VACUUM INTO` 遇到已存在的目标会**直接报错**（这是它天然不覆盖的一面），
     故"覆盖缺陷"在这一路会表现为**异常**而不是静默少一份 —— 断言把它转成可指的 FAIL，
     不让整个自检脚本崩在异常上（"跳过不是通过"，崩溃更不是）。 */
  const e44SyncDir = makeTempDir('e44-sync');
  const e44SyncNames = [];
  const e44SyncErrors = [];
  for (let i = 0; i < 5; i++) {
    try { e44SyncNames.push(maintain.backupToSync(handle.db, e44SyncDir, { now: e44Same }).name); }
    catch (err) { e44SyncErrors.push(err && err.message ? err.message : String(err)); }
  }
  t.check('E44④：`backupToSync`（E18 的同步形态）同样"同秒 5 次 ⇒ 5 个不同文件"（两条备份路径不得只修一条）',
    new Set(e44SyncNames).size === 5 && maintain.listBackups(e44SyncDir).length === 5 &&
    e44SyncErrors.length === 0 && e44SyncNames.every(n => maintain.BACKUP_FILE_RE.test(n)),
    `同步形态 5 次=[${e44SyncNames.join(', ')}]${e44SyncErrors.length ? '｜异常：' + e44SyncErrors.join(' / ') : ''}`);

  /* 两种形态**产物等价可用**（都完整、表集相同）：佐证"同步形态不是第二套备份实现"，而是同一套能力的同步入口。
     ⚠ 两次调用都 try/catch：同步形态用的是 `VACUUM INTO`，**目标已存在时它直接抛错**（正是它"不覆盖"的一面），
     故"冲突探测被改坏"这组变异会在这里抛异常而不是静默少一份 —— 断言把它收成可指的 FAIL，
     绝不让整个自检脚本崩在异常上（D22 取证时"崩溃"会把汇总行一起丢掉）。 */
  const e44EqDir = makeTempDir('e44-eq');
  const e44EqErrors = [];
  let e44AsyncOne = null;
  let e44SyncOne = null;
  try { e44AsyncOne = await maintain.backupTo(handle.db, e44EqDir, { now: e44Same }); }
  catch (err) { e44EqErrors.push('异步：' + (err && err.message ? err.message : String(err))); }
  try { e44SyncOne = maintain.backupToSync(handle.db, e44EqDir, { now: e44Same }); }
  catch (err) { e44EqErrors.push('同步：' + (err && err.message ? err.message : String(err))); }
  const e44VerifyAsync = e44AsyncOne ? maintain.verifyBackup(e44AsyncOne.path) : { ok: false, detail: '未生成备份', tables: 0 };
  const e44VerifySync = e44SyncOne ? maintain.verifyBackup(e44SyncOne.path) : { ok: false, detail: '未生成备份', tables: 0 };
  t.check('E44⑤/交付说明：`backupTo`（异步内置 backup API）与 `backupToSync`（同步 VACUUM INTO）**产物等价可用** —— ' +
    '两份备份都能打开、`integrity_check=ok`、表数相同且覆盖需求点名的表；两者落在**同一目录**也不互相覆盖（E44 在两条路径上都生效）',
    e44EqErrors.length === 0 && e44VerifyAsync.ok && e44VerifySync.ok &&
    e44VerifyAsync.tables === e44VerifySync.tables &&
    e44VerifySync.tables >= REQUIRED_TABLES.length &&
    Boolean(e44AsyncOne) && Boolean(e44SyncOne) &&
    e44AsyncOne.name !== e44SyncOne.name && maintain.listBackups(e44EqDir).length === 2,
    `异步=${JSON.stringify(e44VerifyAsync)}；同步=${JSON.stringify(e44VerifySync)}；` +
    `同目录两份=${e44AsyncOne && e44AsyncOne.name} / ${e44SyncOne && e44SyncOne.name}` +
    `${e44EqErrors.length ? '｜异常：' + e44EqErrors.join(' / ') : ''}`);

  /* 历史（秒级）文件名仍被识别：升级不得把旧备份变成"看不见"的文件（既不清也不列） */
  const e44LegacyDir = makeTempDir('e44-legacy-name');
  if (e44SyncOne) fs.copyFileSync(e44SyncOne.path, path.join(e44LegacyDir, 'board-20260919-100000.db'));
  t.check('E44⑥：历史**秒级**备份名 `board-YYYYMMDD-HHmmss.db` 仍被 `listBackups` / 保留策略识别' +
    '（旧备份不因升级而失联）',
    maintain.listBackups(e44LegacyDir).length === 1 &&
    maintain.pruneBackups(e44LegacyDir, 5).kept === 1,
    `历史名目录内 ${maintain.listBackups(e44LegacyDir).length} 份`);

  /* **F17-1**（复核中危）：`backupToSync` 的失败清理原来是**无条件** `rmSync(target)` ——
     在"显式传 `name` 且同名文件已存在"这条路径上会把**既有备份删掉**（复核实测：预置一份 → VACUUM 报
     `output file already exists` → catch 删掉了它，目录 1 份 → 0 份）。现在：目标已存在 ⇒ **拒绝且不碰**。
     D22 变异点（副本上做）：把 `backupToSync()` 的 `existedBefore` 早退去掉、恢复无条件 rmSync ⇒ 本行变红。 */
  const e44PreDir = makeTempDir('e44-preexisting');
  const e44PreName = 'board-20260919-100000-000.db';
  const e44PreFile = path.join(e44PreDir, e44PreName);
  {
    /* 预置一份**合法的 SQLite 库**（带标记表 `mark`）—— 不能用随便一段文本：
       异步 `backup()` 会把目标当库打开（首版用文本 ⇒ 报 `file is not a database`），
       而"合法库 + 标记表"能在下面确定性证明"异步确实**覆盖**了它"（标记表消失）。 */
    const { DatabaseSync: PreDb } = require('node:sqlite');
    const pre = new PreDb(e44PreFile);
    pre.exec('CREATE TABLE mark(x INTEGER)');
    pre.exec('INSERT INTO mark(x) VALUES(1)');
    pre.close();
  }
  const e44PreBytes = fs.readFileSync(e44PreFile);
  let e44PreThrew = null;
  try {
    maintain.backupToSync(handle.db, e44PreDir, { name: e44PreName, now: e44Same });
  } catch (err) { e44PreThrew = err; }
  const e44PreAfter = fs.existsSync(e44PreFile) ? fs.readFileSync(e44PreFile) : null;
  t.check('E44/F17-1：`backupToSync` 遇到**已存在的同名文件** ⇒ 抛错**拒绝覆盖**，且那份既有备份' +
    '**逐字节原样仍在**（旧写法在 catch 里无条件 `rmSync` ⇒ 会把它删掉：目录 1 份 → 0 份）',
    Boolean(e44PreThrew) && /拒绝覆盖既有文件/.test(e44PreThrew.message) &&
    e44PreAfter !== null && e44PreAfter.equals(e44PreBytes) &&
    maintain.listBackups(e44PreDir).length === 1,
    e44PreThrew ? `${e44PreThrew.message.slice(0, 130)}｜既有文件字节不变=${Boolean(e44PreAfter && e44PreAfter.equals(e44PreBytes))}`
      : '（竟未抛错 —— 缺陷）');
  /* 对照（同名语义**故意不同**，两条都写死在 maintain.js 注释里）：异步 `backupTo` 命中同名 ⇒ 按原样覆盖。
     判据用"标记表 `mark` 消失 + 覆盖后是可用备份"来证，而不是比字节（同一逻辑状态产出的备份可能逐字节相同）。 */
  const e44Overwrite = await maintain.backupTo(handle.db, e44PreDir, { name: e44PreName, now: e44Same });
  const e44OverwriteCheck = (() => {
    const { DatabaseSync: PostDb } = require('node:sqlite');
    const c = new PostDb(e44PreFile);
    try {
      const mark = c.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='mark'").get().c;
      const oplog = c.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='op_log'").get().c;
      return { mark: Number(mark), oplog: Number(oplog) };
    } finally { c.close(); }
  })();
  t.check('E44/F17-1（对照）：异步 `backupTo` 显式同名 ⇒ **按原样覆盖**（预置的标记表 `mark` 消失、' +
    '覆盖后是可用备份）—— 两条路径的同名语义不同且都在注释里写死，避免"以为两边一样"',
    e44Overwrite.name === e44PreName && maintain.verifyBackup(e44Overwrite.path).ok &&
    e44OverwriteCheck.mark === 0 && e44OverwriteCheck.oplog === 1,
    `覆盖后 mark 表=${e44OverwriteCheck.mark}、op_log 表=${e44OverwriteCheck.oplog}、` +
    `verifyBackup=${maintain.verifyBackup(e44Overwrite.path).ok}`);

  /* **F17-5**（复核低危）：同一秒内"**秒级名（历史）vs 毫秒名（当前）**"混排时，次序键必须**优先 mtime** ——
     名字归一化会把秒级名当"最新"（SSS=999），只看名字就会**把真正最新的毫秒名那份删掉**。
     本用例刻意造出"名字序 与 mtime 序**相反**"：毫秒名（名字更旧）落盘**更晚**、秒级名（名字更新）落盘更早。
     D22 变异点（副本上做）：把 `listBackups()` 的排序改回"只按 `backupOrderKey`" ⇒ 本行变红
     （会保留名字新的秒级名、删掉真正最新的毫秒名 —— 正是复核实测的那条危害）。 */
  const e44MixDir = makeTempDir('e44-mixed-order');
  const e44MixLegacy = path.join(e44MixDir, 'board-20260919-100000.db');        // 名字序＝最新（秒级，SSS 归一 999）
  const e44MixMs = path.join(e44MixDir, 'board-20260919-100000-000.db');        // 名字序＝最旧（毫秒段 000）
  fs.copyFileSync(e44SyncOne.path, e44MixLegacy);
  fs.copyFileSync(e44SyncOne.path, e44MixMs);
  const e44MixT0 = new Date(Date.now() - 5000);          // 夹具层用真实时间：mtime 必须与"刚刚"有可辨差距
  fs.utimesSync(e44MixLegacy, e44MixT0, e44MixT0);       // 秒级名：**更早**落盘
  fs.utimesSync(e44MixMs, new Date(), new Date());       // 毫秒名：**刚刚**落盘（真正最新）
  const e44MixList = maintain.listBackups(e44MixDir);
  const e44MixPruned = maintain.pruneBackups(e44MixDir, 1);
  const e44MixKept = maintain.listBackups(e44MixDir).map(b => b.name);
  t.check('E44/F17-5：同一秒内**秒级名（历史）与毫秒名（当前）混排**时，保留策略按 **mtime** 判新旧 —— ' +
    '毫秒名虽"名字更旧"但落盘更晚 ⇒ 必须**保留它、删掉落盘更早的秒级名那份**' +
    '（只看名字会反过来删掉真正最新的备份，即复核实测的那条危害）',
    e44MixList[0] && e44MixList[0].name === 'board-20260919-100000-000.db' &&
    e44MixKept.length === 1 && e44MixKept[0] === 'board-20260919-100000-000.db' &&
    e44MixPruned.removed.length === 1 && e44MixPruned.removed[0] === 'board-20260919-100000.db',
    `排序后首份=${e44MixList[0] && e44MixList[0].name}；保留=[${e44MixKept.join(', ')}]；` +
    `删除=[${e44MixPruned.removed.join(', ')}]`);

  /* **F19-3**（结案复跑残留）：**mtime 回拨**时不得误删"名字更新"的那份 —— 复跑实测反证：
     只按 mtime 排序时，"名字更新（…100001-000）但 mtime 更早"的备份会被 `pruneBackups(dir,1)` 删掉。
     现在次序键＝`max(mtime, 名字声称时刻)` ⇒ **名字新**与**落盘新**任一为真都算新（两个方向都不误删）。
     D22 变异点（副本上做）：把 `backupOrderMs()` 退回纯 `entry.mtimeMs` ⇒ 本行变红。 */
  const e44RollDir = makeTempDir('e44-mtime-rollback');
  const e44RollNow = new Date();
  const e44RollNewName = maintain.backupName(new Date(e44RollNow.getTime() + 2000));   // 名字声称：+2 s
  const e44RollOldName = maintain.backupName(new Date(e44RollNow.getTime() + 1000));   // 名字声称：+1 s
  fs.copyFileSync(e44SyncOne.path, path.join(e44RollDir, e44RollNewName));
  fs.copyFileSync(e44SyncOne.path, path.join(e44RollDir, e44RollOldName));
  const e44RollBack = new Date(e44RollNow.getTime() - 10000);   // 把"名字更新"的那份 mtime **回拨 10 s**
  fs.utimesSync(path.join(e44RollDir, e44RollNewName), e44RollBack, e44RollBack);
  fs.utimesSync(path.join(e44RollDir, e44RollOldName), e44RollNow, e44RollNow);
  const e44RollList = maintain.listBackups(e44RollDir);
  const e44RollPruned = maintain.pruneBackups(e44RollDir, 1);
  const e44RollKept = maintain.listBackups(e44RollDir).map(b => b.name);
  t.check('E44/F19-3：**mtime 回拨**（名字更新但落盘更早）⇒ 保留策略仍必须**保留名字更新的那份**' +
    '（次序键＝max(mtime, 名字声称时刻)：只看 mtime 会删掉它 —— 复跑反证的那条）',
    e44RollList[0] && e44RollList[0].name === e44RollNewName &&
    e44RollKept.length === 1 && e44RollKept[0] === e44RollNewName &&
    e44RollPruned.removed.length === 1 && e44RollPruned.removed[0] === e44RollOldName &&
    maintain.backupNameTimeMs(e44RollNewName) > maintain.backupNameTimeMs(e44RollOldName),
    `名字新=${e44RollNewName}（mtime 回拨 10 s）｜名字旧=${e44RollOldName}（mtime 现在）；` +
    `保留=[${e44RollKept.join(', ')}]；删除=[${e44RollPruned.removed.join(', ')}]`);

  /* 本段收尾：自建的备份目录用完即删 —— `makeTempDir()` 只建不回收（能回收的是 `makeTempDb` 的句柄），
     不删就会在临时区里堆 e44-* 目录（与第十节"临时区与残留"的口径一致）。 */
  const e44OwnDirs = [e44Dir, e44SyncDir, e44EqDir, e44LegacyDir, e44PreDir, e44MixDir, e44RollDir];
  for (const d of e44OwnDirs) {
    /* `E117`（2026-10-04）：`env.removeLinkSafe()` —— 非链接时与原 `rmSync(recursive)` 逐字等价；
       这些目录全部由 `makeTempDir()` 在本轮临时区里刚建（结构上不可能是链接）。 */
    try { env.removeLinkSafe(d, { recursive: true, force: true }); } catch { /* 删不掉要能看见，故下面单独断言 */ }
  }
  t.check('E44：本段自建的备份目录（含同秒 5 份的那几个）用完即删，临时区不留 e44-* 残留',
    e44OwnDirs.every(d => !fs.existsSync(d)),
    e44OwnDirs.map(d => `${path.basename(d)}=${fs.existsSync(d) ? '仍在' : '已删'}`).join('，'));

  /* ---------------- 九之三、鉴权（ADR-0007：scrypt 哈希 / 错误次数锁定 / 内存会话令牌 / 本机一次性初始化） ----------------
     本节覆盖 ADR-0007 **D6.2** 点名的五类判据（①哈希非明文 ②错误次数 ③令牌 ④未初始化态 ⑤与 IF-A 静态令牌
     互不通用）＋ D6.3 的留痕口径（六类各一条、含来源 IP），并补 `POST /auth/*` 的 HTTP 端到端最小集。
     全部走**注入时钟**（ADR-0003 D17）：本节的锁定到期、令牌过期、滑动续期都靠 `clock.advanceXxx()` 复现，
     不读真实墙钟 ⇒ 任何时刻跑都稳定。**一用例一库**：鉴权用独立临时库（服务端模式口径）。 */
  t.section('九之三、鉴权（ADR-0007：scrypt / 错误次数锁定 / 内存会话令牌 / 一次性初始化）');
  const AUTH_DB = makeTempDb({ name: 'auth' });
  db.initSchema(AUTH_DB.db, NOW);
  const authClock = createClock({ mode: 'fixed', at: '2026-09-19T10:00:00' });
  const authLogLines = [];
  const authLogger = {
    info: m => authLogLines.push('info ' + m),
    warn: m => authLogLines.push('warn ' + m),
    error: m => authLogLines.push('error ' + m)
  };
  const AUTH_PW = 'W5-Auth-2026';
  const AUTH_PW2 = 'W5-Auth-Second-2026';
  const createAuthSvc = (over = {}) => authSvc.createAuth(Object.assign({
    db: AUTH_DB.db, logger: authLogger, now: authClock.source()
  }, over));
  const authUserId = authSvc.DEFAULT_USERNAME;
  let auth = createAuthSvc();

  /* ---- ④ 未初始化态（D4）：无凭证行；init 才可建立；非回环/错码一律拒 ---- */
  const authStatus0 = auth.status();
  const authCode0 = auth.initCode();
  t.check('鉴权④：无凭证行 ⇒ **未初始化**态（`status.initialized=false`、`login` 一律 409 `not_initialized`）；' +
    '服务对象创建时生成一次性初始化码（`randomBytes(6)` ⇒ 12 位 hex），且 **status 不下发码本身**',
    authStatus0.initialized === false && authStatus0.initCodePending === true &&
    auth.login({ password: AUTH_PW, remote: '127.0.0.1' }).httpStatus === 409 &&
    auth.login({ password: AUTH_PW, remote: '127.0.0.1' }).error === 'not_initialized' &&
    typeof authCode0 === 'string' && /^[0-9a-f]{12}$/.test(authCode0) &&
    !JSON.stringify(authStatus0).includes(authCode0),
    `initialized=${authStatus0.initialized}，initCodePending=${authStatus0.initCodePending}，` +
    `码形状=${/^[0-9a-f]{12}$/.test(authCode0) ? '12 位 hex' : '异常'}`);
  t.check('鉴权④：一次性初始化码**登记进 `op_log`**（`op_type=口令初始化码`，content 含码）—— 与"打印到控制台"同为 D4 的两条登记路径',
    opLogRepo.list(AUTH_DB.db, { opType: authSvc.OP_TYPE.INIT_CODE }).length === 1,
    `op_log 口令初始化码条数=${opLogRepo.list(AUTH_DB.db, { opType: authSvc.OP_TYPE.INIT_CODE }).length}`);
  const initNonLoop = auth.init({ code: authCode0, password: AUTH_PW, remote: '192.168.1.20' });
  t.check('鉴权④：**非回环即使带对码也拒**（403 `not_loopback`）—— 来源一律取 `req.socket.remoteAddress`、不信任何请求头',
    initNonLoop.httpStatus === 403 && initNonLoop.error === 'not_loopback',
    `HTTP ${initNonLoop.httpStatus} ${initNonLoop.error}`);
  const initBadCode = auth.init({ code: 'deadbeefdead', password: AUTH_PW, remote: '127.0.0.1' });
  const initBadPolicy = auth.init({ code: authCode0, password: 'ab', remote: '127.0.0.1' });
  t.check('鉴权④：错码拒（401 `bad_init_code`）；码正确但口令不符合口径（2 位）拒（400 `bad_password`）',
    initBadCode.httpStatus === 401 && initBadCode.error === 'bad_init_code' &&
    initBadPolicy.httpStatus === 400 && initBadPolicy.error === 'bad_password' &&
    !String(initBadPolicy.reason).includes('ab'),
    `错码=${initBadCode.httpStatus}/${initBadCode.error}；短口令=${initBadPolicy.httpStatus}/${initBadPolicy.error}`);
  const initOk = auth.init({ code: authCode0, password: AUTH_PW, remote: '::ffff:127.0.0.1' });
  const authRow0 = AUTH_DB.db.prepare('SELECT * FROM auth_credential WHERE username = ?').get(authUserId);
  /* ⚠ 以下三条对 `authRow0` 先做存在性守卫：变异取证时"凭证行没落库"必须表现为**变红的断言**，
     而不是 `undefined.salt` 把自检脚本崩掉（首版在 AUTH-1/AUTH-10 两组变异上各崩过一次）。 */
  const authRow0Salt = authRow0 ? authRow0.salt : '';
  const authRow0Hash = authRow0 ? authRow0.hash : '';
  t.check('鉴权①：对码 + 合法口令 ⇒ 成功（200）并落**一行**凭证：`algo=scrypt`、`params=N=16384,r=8,p=1,keylen=32`' +
    '（**逐字**照 ADR-0007 D1）、`is_initial=1`、`fail_count=0`、`team_code` 取当前生效班次',
    initOk.ok === true && initOk.initialized === true && Boolean(authRow0) &&
    authRow0.algo === 'scrypt' && authRow0.params === 'N=16384,r=8,p=1,keylen=32' &&
    authRow0.is_initial === 1 && authRow0.fail_count === 0 && authRow0.locked_until === null &&
    AUTH_DB.db.prepare('SELECT COUNT(*) AS c FROM auth_credential').get().c === 1,
    `列=${JSON.stringify({ algo: authRow0 && authRow0.algo, params: authRow0 && authRow0.params, is_initial: authRow0 && authRow0.is_initial, team_code: authRow0 && authRow0.team_code })}`);
  t.check('鉴权①：库里 `salt`/`hash` **≠ 口令本身**（也不含口令子串）；`hash`＝32 字节派生值 hex、`salt`＝16 字节随机盐 hex；' +
    '结构版本已升到 ' + SCHEMA_VERSION + ' 且新表为**纯新增**（旧库 `CREATE TABLE IF NOT EXISTS` 幂等生效）',
    Boolean(authRow0) &&
    authRow0Salt !== AUTH_PW && authRow0Hash !== AUTH_PW &&
    !authRow0Hash.includes(AUTH_PW) && !authRow0Salt.includes(AUTH_PW) &&
    /^[0-9a-f]{64}$/.test(authRow0Hash) && /^[0-9a-f]{32}$/.test(authRow0Salt) &&
    db.getSchemaVersion(AUTH_DB.db) === SCHEMA_VERSION,
    `salt=${authRow0Salt}（${authRow0Salt.length} hex），hash=${authRow0Hash}（${authRow0Hash.length} hex）`);
  t.check('鉴权①：**同盐同口令派生可复现**（确定性函数，不是随机占位）；换口令则派生值不同',
    Boolean(authRow0) &&
    authSvc.derive(AUTH_PW, authRow0Salt) === authRow0Hash &&
    authSvc.derive(AUTH_PW, authRow0Salt) === authSvc.derive(AUTH_PW, authRow0Salt) &&
    authSvc.derive(AUTH_PW + 'X', authRow0Salt) !== authRow0Hash,
    `derive(同口令,同盐) 与库内 hash 相同=${Boolean(authRow0) && authSvc.derive(AUTH_PW, authRow0Salt) === authRow0Hash}`);
  t.check('鉴权①：口令明文**不在库文件字节里**（原始文件扫描）—— ADR-0007 D1"任何位置不得出现明文"',
    !fs.readFileSync(AUTH_DB.path).includes(AUTH_PW) && !fs.readFileSync(AUTH_DB.path).includes(AUTH_PW2),
    `扫描 ${fs.statSync(AUTH_DB.path).size} 字节：未出现口令串`);

  /* ④ 续：码**成功后立即作废**。直接证据＝把凭证行删掉回到未初始化态，再用**同一个码**初始化 ⇒ 必须拒。
     若只断言"第二次 init 返回 409"，那只证明了"已初始化"，证明不了"码已作废"（本用例就是为此设计的）。 */
  AUTH_DB.db.exec('DELETE FROM auth_credential');     // D4 的"重置＝删行 + 重启"里的删行半步
  const codeReuse = auth.init({ code: authCode0, password: AUTH_PW2, remote: '127.0.0.1' });
  t.check('鉴权④：初始化码**成功后立即作废** —— 删行回到未初始化态后，同一个码再初始化 ⇒ 401 `bad_init_code`' +
    '（不是"码还能再用一次"）',
    codeReuse.httpStatus === 401 && codeReuse.error === 'bad_init_code',
    `HTTP ${codeReuse.httpStatus} ${codeReuse.error}`);
  /* 重启（新实例）⇒ 重新生成一次性初始化码；旧码在新实例上无效 */
  auth = createAuthSvc({ silent: true });
  const authCode1 = auth.initCode();
  const oldCodeOnNew = auth.init({ code: authCode0, password: AUTH_PW, remote: '127.0.0.1' });
  t.check('鉴权④：初始化码**仅内存、重启重新生成** —— 新实例的码 ≠ 旧实例的码，且**旧码在新实例上无效**（401）',
    typeof authCode1 === 'string' && authCode1 !== authCode0 &&
    /^[0-9a-f]{12}$/.test(authCode1) &&
    oldCodeOnNew.httpStatus === 401 && oldCodeOnNew.error === 'bad_init_code',
    `新码≠旧码=${authCode1 !== authCode0}；旧码在新实例=${oldCodeOnNew.httpStatus}/${oldCodeOnNew.error}`);
  const initOk1 = auth.init({ code: authCode1, password: AUTH_PW, remote: '::1' });
  t.check('鉴权④：新实例用**新码** + 合法口令 ⇒ 成功（回环三种写法 `::1` 亦可）；已初始化后再 init ⇒ 409 `already_initialized`',
    initOk1.ok === true &&
    (() => {
      const again = auth.init({ code: authCode1, password: AUTH_PW2, remote: '127.0.0.1' });
      return again.httpStatus === 409 && again.error === 'already_initialized';
    })(),
    `初始化=${initOk1.httpStatus}；二次 init=409 already_initialized`);

  /* ---- ②/③ 登录、错误次数、锁定 ---- */
  const authLogin1 = auth.login({ password: AUTH_PW, remote: '127.0.0.1' });
  /* F17-7（复核低危）：原来这里带一句 `authSvc.TOKEN_BYTES === 32` —— 那是**实现常量自比**，
     提供不了任何行为证据（改常量时断言跟着一起变，永远绿）。已删；token 的**行为证据**是下面
     `/^[0-9a-f]{64}$/`（256 bit ⇒ 64 位 hex，来自真实登录返回）。 */
  t.check('鉴权③：口令正确 ⇒ 200 `{token, username, expiresAt}`；令牌是 `randomBytes(32)` 的 hex（**64 位**，行为判据）；' +
    'TTL 默认 12 h（`expiresAt` 由注入时钟算出）',
    authLogin1.ok === true && authLogin1.username === authUserId &&
    /^[0-9a-f]{64}$/.test(authLogin1.token) &&
    authLogin1.expiresAt === '2026-09-19 22:00:00',
    `token 长度=${String(authLogin1.token || '').length} hex，expiresAt=${authLogin1.expiresAt}`);
  const authLogin2 = auth.login({ password: AUTH_PW, remote: '127.0.0.1' });
  /* 详情一律 `String(x || '')` 兜底：变异取证时"登录失败 ⇒ token 为 undefined"必须是**一条变红的断言**，
     而不是把自检脚本崩在 `.slice` 上（首版就崩过一次，取证日志因此丢了汇总行）。 */
  t.check('鉴权③：两次登录的 token **不同**（真随机，不是固定串/可预测）',
    authLogin1.token !== authLogin2.token,
    `#1=${String(authLogin1.token || '').slice(0, 12)}… #2=${String(authLogin2.token || '').slice(0, 12)}…`);
  const authWrong = auth.login({ password: 'definitely-wrong', remote: '10.20.30.40' });
  const authUnknown = auth.login({ username: 'not-exist', password: AUTH_PW, remote: '10.20.30.40' });
  t.check('鉴权②：口令错与**用户不存在**对外**不可区分**（都 401 `bad_credentials`，且不区分原因的字段都不出现）',
    authWrong.httpStatus === 401 && authWrong.error === 'bad_credentials' &&
    authUnknown.httpStatus === 401 && authUnknown.error === 'bad_credentials' &&
    authUnknown.failCount === undefined,
    `口令错=${authWrong.httpStatus}/${authWrong.error}；用户不存在=${authUnknown.httpStatus}/${authUnknown.error}`);
  /* 4 次失败后正确口令仍可登录并**清零**（ADR-0007 D6.2 原文口径） */
  for (let i = 0; i < 3; i++) auth.login({ password: 'wrong-' + i, remote: '127.0.0.1' });
  t.check('鉴权②：连续 **4** 次失败仍未锁定（`fail_count=4`、`locked=false`）—— 阈值是"第 5 次触发锁定"',
    auth.status().failCount === 4 && auth.status().locked === false,
    `failCount=${auth.status().failCount}，locked=${auth.status().locked}`);
  const authLoginAfter4 = auth.login({ password: AUTH_PW, remote: '127.0.0.1' });
  t.check('鉴权②：第 5 次用**正确口令** ⇒ 登录成功且失败计数**清零**（D2："成功即清零"）',
    authLoginAfter4.ok === true && auth.status().failCount === 0 && auth.status().locked === false,
    `登录=${authLoginAfter4.httpStatus}，清零后 failCount=${auth.status().failCount}`);
  /* 连续 5 次失败 ⇒ 第 5 次即锁定（423 + retryAfterSec 由注入时钟算出） */
  const authFive = [];
  for (let i = 0; i < 5; i++) authFive.push(auth.login({ password: 'bad-' + i, remote: '10.20.30.40' }));
  t.check('鉴权②：连续 5 次失败 ⇒ 前 4 次 401、**第 5 次即触发锁定**（423 `locked` + `retryAfterSec=300` = `lockMinutes×60`）',
    authFive.slice(0, 4).every(r => r.httpStatus === 401 && r.error === 'bad_credentials') &&
    authFive[4].httpStatus === 423 && authFive[4].error === 'locked' &&
    authFive[4].retryAfterSec === 300 && authFive[4].lockedUntil === '2026-09-19 10:05:00',
    `前 4 次=${authFive.slice(0, 4).map(r => r.httpStatus).join('/')}；第 5 次=${authFive[4].httpStatus} ` +
    `retryAfterSec=${authFive[4].retryAfterSec} lockedUntil=${authFive[4].lockedUntil}`);
  const authLockedRight = auth.login({ password: AUTH_PW, remote: '127.0.0.1' });
  const authLockSnapshot = AUTH_DB.db.prepare('SELECT fail_count, locked_until FROM auth_credential').get();
  t.check('鉴权②：锁定期间**口令正确也拒**（423 + 剩余秒数）；且锁定期间的尝试**不再放大**失败计数（不会被无限延长）',
    authLockedRight.httpStatus === 423 && authLockedRight.error === 'locked' &&
    authLockedRight.retryAfterSec === 300 &&
    authLockSnapshot.fail_count === 5 && authLockSnapshot.locked_until === '2026-09-19 10:05:00',
    `正确口令在锁定中=${authLockedRight.httpStatus}（剩余 ${authLockedRight.retryAfterSec} s）；库内 fail_count=${authLockSnapshot.fail_count}`);
  /* 重启不清零：**新建服务实例**（同一个库、新的内存会话表） */
  const authRestart = createAuthSvc({ silent: true });
  const authRestartLogin = authRestart.login({ password: AUTH_PW, remote: '127.0.0.1' });
  t.check('鉴权②：**新建服务实例（模拟进程重启）计数不清零** —— `fail_count`/`locked_until` 落库，重启后仍锁定、' +
    '正确口令仍被拒',
    authRestart.status().failCount === 5 && authRestart.status().locked === true &&
    authRestartLogin.httpStatus === 423 && authRestartLogin.retryAfterSec === 300,
    `重启后 failCount=${authRestart.status().failCount}、locked=${authRestart.status().locked}、` +
    `正确口令=${authRestartLogin.httpStatus}`);
  /* 注入时钟推进 ⇒ 恢复；顺带锁住一条**口径细化**：锁定期满≠计数清零（只有"成功"才清零） */
  authClock.advanceMin(6);
  const authWrongAfterExpiry = auth.login({ password: 'still-wrong', remote: '127.0.0.1' });
  t.check('鉴权②：锁定**到期后**的单次失败会立刻再次锁定（口径细化：`fail_count` 只有"登录成功"才清零 —— ' +
    'ADR-0007 D2 原文"成功即清零"，没有别的清零路径）',
    authWrongAfterExpiry.httpStatus === 423 && authWrongAfterExpiry.error === 'locked' &&
    authWrongAfterExpiry.retryAfterSec === 300,
    `到期后错一次=${authWrongAfterExpiry.httpStatus}/${authWrongAfterExpiry.error}（剩余 ${authWrongAfterExpiry.retryAfterSec} s）`);
  authClock.advanceMin(6);
  const authRecover = auth.login({ password: AUTH_PW, remote: '127.0.0.1' });
  t.check('鉴权②：锁定到期（注入时钟推进 > `lockMinutes`）+ **口令正确** ⇒ 恢复登录并清零 `fail_count`',
    authRecover.ok === true && auth.status().failCount === 0 && auth.status().locked === false,
    `恢复登录=${authRecover.httpStatus}，failCount=${auth.status().failCount}`);

  /* ---- ③ 令牌：滑动续期 / 绝对上限 / 登出 / 重启 / 缺失与伪造 ---- */
  authClock.reset();
  const authTokSlide = auth.login({ password: AUTH_PW, remote: '127.0.0.1' }).token;
  /* ⚠ 必须**两次续期**才走得到绝对上限（TTL 12 h < 绝对 24 h，单次登录后 12 h 内必然先过期）：
     登录(10:00, 到期 22:00) → 11 h 后(21:00) 续到次日 09:00 → 再 11 h(次日 08:00) 续到
     `min(08:00+12h, 上限次日 10:00)` ＝ **次日 10:00（＝绝对上限）**。
     第二步就是"不设上限就会一直续期"的可证伪点（不设上限会得到次日 20:00）。
     D22 变异点：把 `verify()` 里 `Math.min(now + TTL, absoluteExpiresAtMs)` 的 `Math.min` 去掉 ⇒ 变红。 */
  authClock.advanceSec(11 * 3600);
  const authSlide1 = auth.verify(authTokSlide);
  authClock.advanceSec(11 * 3600);
  const authSlide2 = auth.verify(authTokSlide);
  t.check('鉴权③：会话 TTL **滑动续期** —— 连续两次续期把到期时间一路推到 **24 h 绝对上限**，' +
    '而不是"每次 +12 h"（第二次若不设上限会得到次日 20:00）',
    authSlide1.ok === true && authSlide1.expiresAt === '2026-09-20 09:00:00' &&
    authSlide2.ok === true && authSlide2.expiresAt === '2026-09-20 10:00:00' &&
    authSlide2.expiresAt === authSlide2.absoluteExpiresAt,
    `第一次续期后=${authSlide1.expiresAt}；第二次续期后=${authSlide2.expiresAt}（绝对上限=${authSlide2.absoluteExpiresAt}）`);
  authClock.advanceSec(2 * 3600);
  const authAbsolute = auth.verify(authTokSlide);
  t.check('鉴权③：绝对上限 **24 h** 到点即失效（滑动续期也不能越过；会话被立即移除）',
    authAbsolute.httpStatus === 401 && authAbsolute.error === 'unauthorized' &&
    auth.verify(authTokSlide).httpStatus === 401,
    `24 h 后=${authAbsolute.httpStatus}/${authAbsolute.error}（${authAbsolute.reason}）`);
  authClock.reset();
  const authTokExpire = auth.login({ password: AUTH_PW, remote: '127.0.0.1' }).token;
  authClock.advanceSec(12 * 3600);
  const authExpired = auth.verify(authTokExpire);
  t.check('鉴权③：TTL 到点（不续期即整 12 h）⇒ 401 `unauthorized`（"登录已过期"）',
    authExpired.httpStatus === 401 && authExpired.error === 'unauthorized' && /过期/.test(String(authExpired.reason)),
    `12 h 后=${authExpired.httpStatus}：${authExpired.reason}`);
  authClock.reset();
  const authTokOut = auth.login({ password: AUTH_PW, remote: '127.0.0.1' }).token;
  const authLogout = auth.logout({ token: authTokOut, remote: '127.0.0.1' });
  t.check('鉴权③：`logout` ⇒ 200 且令牌**立刻失效**（再校验 401）；重复登出同样 401（不假装成功）',
    authLogout.ok === true && authLogout.requireRelogin === true &&
    auth.verify(authTokOut).httpStatus === 401 &&
    auth.logout({ token: authTokOut, remote: '127.0.0.1' }).httpStatus === 401,
    `登出=${authLogout.httpStatus}，登出后校验=${auth.verify(authTokOut).httpStatus}`);
  const authTokRestart = auth.login({ password: AUTH_PW, remote: '127.0.0.1' }).token;
  const authAfterRestart = createAuthSvc({ silent: true });
  t.check('鉴权③：**进程重启即全部失效**（会话表只在内存：新实例里任何旧令牌都不存在）+ 缺失/伪造令牌一律 401',
    authAfterRestart.verify(authTokRestart).httpStatus === 401 &&
    auth.verify('').httpStatus === 401 && auth.verify('f'.repeat(64)).httpStatus === 401 &&
    auth.verify(undefined).httpStatus === 401,
    `重启后旧令牌=${authAfterRestart.verify(authTokRestart).httpStatus}；缺失=${auth.verify('').httpStatus}；` +
    `伪造=${auth.verify('f'.repeat(64)).httpStatus}`);

  /* ---- 改密（FR-8.4）：同口令两次改密盐与派生值都不同；改密后强制清会话 ---- */
  authClock.reset();
  const authTokCh = auth.login({ password: AUTH_PW, remote: '127.0.0.1' }).token;
  const authChWrongOld = auth.change({ token: authTokCh, oldPassword: 'not-the-old-one', newPassword: AUTH_PW2, remote: '127.0.0.1' });
  t.check('鉴权(改密)：原口令错 ⇒ 401 `bad_credentials`，且**会话不清**（可继续用同一令牌）',
    authChWrongOld.httpStatus === 401 && authChWrongOld.error === 'bad_credentials' &&
    auth.verify(authTokCh).ok === true,
    `原口令错=${authChWrongOld.httpStatus}/${authChWrongOld.error}；令牌仍有效=${auth.verify(authTokCh).ok}`);
  const authChSame = auth.change({ token: authTokCh, oldPassword: AUTH_PW, newPassword: AUTH_PW, remote: '127.0.0.1' });
  const authChUser = auth.change({ token: authTokCh, oldPassword: AUTH_PW, newPassword: authUserId, remote: '127.0.0.1' });
  const authChLong = auth.change({ token: authTokCh, oldPassword: AUTH_PW, newPassword: 'x'.repeat(65), remote: '127.0.0.1' });
  t.check('鉴权(改密)：**新口令不得与原口令相同**、**不得与用户名相同**、长度 ≤64 ⇒ 400 `bad_password`（提示不含明文）',
    authChSame.httpStatus === 400 && authChSame.error === 'bad_password' &&
    authChUser.httpStatus === 400 && authChUser.error === 'bad_password' &&
    authChLong.httpStatus === 400 && authChLong.error === 'bad_password' &&
    !String(authChSame.reason).includes(AUTH_PW) && !String(authChLong.reason).includes('xxx'),
    `同旧=${authChSame.httpStatus}/${authChSame.reason}；同用户名=${authChUser.httpStatus}；超长=${authChLong.httpStatus}`);
  const authRowBeforeCh = AUTH_DB.db.prepare('SELECT salt, hash FROM auth_credential').get();
  const authChOk = auth.change({ token: authTokCh, oldPassword: AUTH_PW, newPassword: AUTH_PW2, remote: '127.0.0.1' });
  const authRowAfterCh1 = AUTH_DB.db.prepare('SELECT salt, hash, is_initial, changed_by FROM auth_credential').get();
  const authRowAfterCh1Salt = authRowAfterCh1 ? authRowAfterCh1.salt : '';
  const authRowBeforeChSalt = authRowBeforeCh ? authRowBeforeCh.salt : '';
  t.check('鉴权(改密)：改密成功 ⇒ 200 + `requireRelogin=true`，且**强制清当前会话**（原令牌立刻 401）；' +
    '`is_initial` 由 1 变 0、`changed_by` 记为设置页改密；库内 salt/hash 已换新',
    authChOk.ok === true && authChOk.requireRelogin === true &&
    auth.verify(authTokCh).httpStatus === 401 &&
    Boolean(authRowAfterCh1) && Boolean(authRowBeforeCh) &&
    authRowAfterCh1.is_initial === 0 && authRowAfterCh1.changed_by === '设置页改密' &&
    authRowAfterCh1Salt !== authRowBeforeChSalt &&
    authRowAfterCh1.hash !== authRowBeforeCh.hash,
    `改密=${authChOk.httpStatus}；原令牌=${auth.verify(authTokCh).httpStatus}；` +
    `清会话数=${authChOk.sessionsCleared}；is_initial=${authRowAfterCh1 && authRowAfterCh1.is_initial}`);
  t.check('鉴权(改密)：改密后**旧口令失效、新口令可登录**（换盐换派生值，不是"改了个标记"）',
    auth.login({ password: AUTH_PW, remote: '127.0.0.1' }).httpStatus === 401 &&
    auth.login({ password: AUTH_PW2, remote: '127.0.0.1' }).ok === true,
    `旧口令=${auth.login({ password: AUTH_PW, remote: '127.0.0.1' }).httpStatus}；` +
    `新口令=${auth.login({ password: AUTH_PW2, remote: '127.0.0.1' }).httpStatus}`);
  /* 同口令**两次改密**（A→B→A）：两次的盐与派生值都必须不同 —— 证明"每口令独立随机盐"（D1） */
  const authTokCh2 = auth.login({ password: AUTH_PW2, remote: '127.0.0.1' }).token;
  const authChBack = auth.change({ token: authTokCh2, oldPassword: AUTH_PW2, newPassword: AUTH_PW, remote: '127.0.0.1' });
  const authRowAfterCh2 = AUTH_DB.db.prepare('SELECT salt, hash FROM auth_credential').get();
  const authRowAfterCh2Salt = authRowAfterCh2 ? authRowAfterCh2.salt : '';
  t.check('鉴权①：**同口令两次改密盐与派生值都不同**（A→B→A：回到同一口令，但 salt 与 hash 都不等于首次）—— ' +
    '每口令独立随机盐（ADR-0007 D1）',
    authChBack.ok === true && Boolean(authRowAfterCh2) &&
    authRowAfterCh2Salt !== authRowBeforeChSalt &&
    authRowAfterCh2.hash !== authRowBeforeCh.hash &&
    authRowAfterCh2Salt !== authRowAfterCh1Salt &&
    authRowAfterCh2.hash !== authRowAfterCh1.hash,
    `首次(A) salt=${authRowBeforeChSalt.slice(0, 8)}… / 改后(B) ${authRowAfterCh1Salt.slice(0, 8)}… / ` +
    `改回(A) ${authRowAfterCh2Salt.slice(0, 8)}…`);

  /* ---- ⑤ 与 IF-A 静态令牌**严格分开**（D3）：互不复用、互不替代 ---- */
  const AUTH_STATIC_IF = 'STATIC-IF-TOKEN-W5-SELFCHECK';
  const authTokForIfa = auth.login({ password: AUTH_PW, remote: '127.0.0.1' }).token;
  const authDispatch = createDispatch({
    db: AUTH_DB.db, now: authClock.source(), auth: { enabled: true, token: AUTH_STATIC_IF }
  });
  const ifaWithSession = authDispatch.authorize({ authorization: 'Bearer ' + authTokForIfa });
  const ifaWithStatic = authDispatch.authorize({ authorization: 'Bearer ' + AUTH_STATIC_IF });
  const authWithStatic = auth.verify(AUTH_STATIC_IF);
  t.check('鉴权⑤：两套令牌**互不通用** —— 会话令牌调 IF-A 被拒（403，鉴权先于报文）、静态令牌调 `/auth/*` 被判 401；' +
    '而静态令牌调 IF-A **正常通过**（正对照，证明不是"两边都一律拒"的假绿）',
    ifaWithSession.ok === false && ifaWithStatic.ok === true &&
    authWithStatic.httpStatus === 401 && authWithStatic.error === 'unauthorized' &&
    authTokForIfa !== AUTH_STATIC_IF,
    `会话令牌→IF-A：${ifaWithSession.ok ? '通过(缺陷)' : '拒(' + ifaWithSession.code + ')'}；` +
    `静态令牌→IF-A：${ifaWithStatic.ok ? '通过' : '拒'}；静态令牌→/auth：${authWithStatic.httpStatus}/${authWithStatic.error}`);

  /* ---- ⑥ 留痕（D6.3）：六类各至少一条、含来源 IP、且**不含口令明文** ---- */
  const authLogs = opLogRepo.list(AUTH_DB.db, {}, { limit: 500 });
  const authLogCount = {};
  for (const r of authLogs) authLogCount[r.opType] = (authLogCount[r.opType] || 0) + 1;
  const AUTH_REQUIRED_OPS = [authSvc.OP_TYPE.INIT, authSvc.OP_TYPE.LOGIN, authSvc.OP_TYPE.LOGIN_FAIL,
    authSvc.OP_TYPE.LOCKED, authSvc.OP_TYPE.CHANGE, authSvc.OP_TYPE.LOGOUT];
  t.check('鉴权⑥：留痕**六类各至少一条**（口令初始化 / 解锁 / 解锁失败 / 账号锁定 / 改密 / 登出），' +
    '且每条都带**来源 IP**（取自 socket，不是请求头）',
    AUTH_REQUIRED_OPS.every(k => authLogCount[k] >= 1) &&
    authLogs.filter(r => /来源=/.test(String(r.content))).length >= AUTH_REQUIRED_OPS.length &&
    authLogs.some(r => /来源=10\.20\.30\.40/.test(String(r.content))) &&
    authLogs.some(r => /来源=192\.168\.1\.20/.test(String(r.content))),
    `各类条数=${JSON.stringify(authLogCount)}；带来源 IP 的 ${authLogs.filter(r => /来源=/.test(String(r.content))).length} 条`);
  t.check('鉴权①：`op_log` 里**任何一行都不含口令明文**（初始化/改密/失败/锁定各条都查）—— ' +
    'ADR-0007 D1"日志里、op_log.content 里不得出现明文"',
    !JSON.stringify(authLogs).includes(AUTH_PW) && !JSON.stringify(authLogs).includes(AUTH_PW2),
    `${authLogs.length} 条留痕全量序列化后未出现口令串`);
  t.check('鉴权①：**错误信息里**也不含口令明文（口令口径/原口令错/锁定三类响应正文都不含口令串）',
    [authChSame, authChLong, authChWrongOld, authLockedRight, initBadPolicy]
      .every(r => !String(r.reason).includes(AUTH_PW) && !String(r.reason).includes(AUTH_PW2)),
    [authChSame, authChLong, authChWrongOld, authLockedRight, initBadPolicy]
      .map(r => r.error + ':' + r.reason).join(' ｜ '));

  /* ---- **F17-2**（复核中危）：库内 `locked_until` 是**脏值**时不得 500，从严按"锁定未知"处理 ----
     旧写法 `platformClock.toDate(row.locked_until)` 直接抛 `clock: 无法解析时间` ⇒ `login()`/`status()`
     冒未捕获异常 ⇒ **HTTP 500**（`Number.isFinite` 那道守卫永远到不了，是死守卫）。裁定口径（从严）：
     `login` ⇒ **423**（`retryAfterSec = lockMinutes×60` 保守值、`lockedUnknown=true`、`lockedUntil=null`）；
     `status()` ⇒ **200** 且 `{locked:true, lockedUntil:null, lockedUnknown:true}`；并写一条含库内原值片段的留痕。
     D22 变异点（副本上做）：把 `lockedState()` 的 try/catch 去掉（恢复直接 `toDate`）⇒ 本行变红（抛异常）。
     放在本节末尾：脏值写入后立即恢复干净状态（`locked_until=NULL, fail_count=0`），不影响后续/复跑。 */
  {
    AUTH_DB.db.prepare("UPDATE auth_credential SET locked_until = '这不是时间' WHERE username = ?").run(authUserId);
    let authDirtyLogin = null;
    let authDirtyStatus = null;
    let authDirtyThrew = null;
    try {
      authDirtyLogin = auth.login({ password: AUTH_PW, remote: '127.0.0.1' });
      authDirtyStatus = auth.status();
    } catch (err) { authDirtyThrew = err; }
    const authDirtyAudit = opLogRepo.list(AUTH_DB.db, { opType: authSvc.OP_TYPE.LOGIN_FAIL }, { limit: 500 })
      .filter(r => /不可解析/.test(String(r.content)));
    t.check('鉴权②/F17-2：库内 `locked_until` **不可解析**（脏值）⇒ **不得冒异常（500）**；' +
      '`login` 从严按锁定 **423**（`retryAfterSec=300=lockMinutes×60`、`lockedUnknown=true`、`lockedUntil=null`）；' +
      '`status()` **200** 且 `{locked:true, lockedUntil:null, lockedUnknown:true}`；并留一条含库内原值片段的留痕',
      authDirtyThrew === null &&
      Boolean(authDirtyLogin) && authDirtyLogin.httpStatus === 423 && authDirtyLogin.error === 'locked' &&
      authDirtyLogin.retryAfterSec === 300 && authDirtyLogin.lockedUnknown === true &&
      authDirtyLogin.lockedUntil === null &&
      Boolean(authDirtyStatus) && authDirtyStatus.ok === true && authDirtyStatus.locked === true &&
      authDirtyStatus.lockedUntil === null && authDirtyStatus.lockedUnknown === true &&
      authDirtyAudit.length === 1 && String(authDirtyAudit[0].content).includes('这不是时间'),
      authDirtyThrew ? `抛异常（缺陷）：${authDirtyThrew.message}`
        : `login=${authDirtyLogin.httpStatus}/retry=${authDirtyLogin.retryAfterSec}/` +
          `lockedUnknown=${authDirtyLogin.lockedUnknown}/lockedUntil=${JSON.stringify(authDirtyLogin.lockedUntil)}；` +
          `status=${authDirtyStatus.locked}/${JSON.stringify(authDirtyStatus.lockedUntil)}/${authDirtyStatus.lockedUnknown}；` +
          `留痕=${authDirtyAudit.length} 条`);
    /* 恢复干净状态（供后续/复跑；脏值只在本用例内存在） */
    AUTH_DB.db.prepare('UPDATE auth_credential SET locked_until = NULL, fail_count = 0 WHERE username = ?').run(authUserId);
  }

  /* ---- **F19-1**（结案复跑残留）：`locked_until` 的"**纪元 0**"必须按**已过期放行**，不能当成"锁定未知"----
     旧写法用真值判断区分解析失败（`if (!untilMs)`），而 `1970-01-01 08:00:00`（UTC+8 纪元 0）解析出的毫秒数
     **恰是 0**，被误判成"锁定未知"⇒ 一律 423；SQLite 的 TEXT 亲和还会把数字 0 存成 `'0.0'`。
     现在用**显式布尔 `parsed`**，且 `'0.0'` 这类纯数字串按"毫秒时间戳"解释（TEXT 亲和兼容口径）。
     D22 变异点（副本上做）：把 `if (!parsed)` 改回 `if (!untilMs)`（真值判断）⇒ 本行变红。 */
  {
    const e19Cases = [
      { raw: '1970-01-01 08:00:00', label: 'UTC+8 纪元 0（毫秒数恰为 0）' },
      { raw: '0.0', label: "TEXT 亲和存的数字 0（'0.0'）" }
    ];
    const e19Results = [];
    for (const c of e19Cases) {
      AUTH_DB.db.prepare('UPDATE auth_credential SET locked_until = ?, fail_count = 0 WHERE username = ?')
        .run(c.raw, authUserId);
      const login = auth.login({ password: AUTH_PW, remote: '127.0.0.1' });
      const st = auth.status();
      e19Results.push({ raw: c.raw, label: c.label, login: login.httpStatus, err: login.error, locked: st.locked, unknown: st.lockedUnknown });
    }
    t.check('鉴权②/F19-1：`locked_until` 的**纪元 0**（`1970-01-01 08:00:00`，毫秒数恰好为 0）与 **`\'0.0\'`**' +
      '（TEXT 亲和存的数字 0）⇒ **按已过期放行**（`login` 200、`status.locked=false`）—— ' +
      '不得因为"毫秒数是 0"被真值判断误判成"锁定未知"而一律 423',
      e19Results.every(r => r.login === 200 && r.err === '' && r.locked === false && r.unknown === false),
      e19Results.map(r => `${r.raw}（${r.label}）⇒ login=${r.login}、locked=${r.locked}、lockedUnknown=${r.unknown}`).join('；'));
    AUTH_DB.db.prepare('UPDATE auth_credential SET locked_until = NULL, fail_count = 0 WHERE username = ?').run(authUserId);
  }

  /* ---- **F19-2**（结案复跑残留，主代理裁定"从严"）：`NULL` ＝未设置；**非 NULL 但不可解析（含空串 `''`）** ---- 
     ⇒ 一律"锁定未知"（423 / status 200 + lockedUnknown）。理由：只有一条规则更好守，库被写坏时应拒绝而非放行。
     D22 变异点（副本上做）：把"NULL 判定"从 `raw === null || raw === undefined` 改回 `!row.locked_until`
     ⇒ 空串会 fail-open（本行变红）。 */
  {
    const runOne = raw => {
      AUTH_DB.db.prepare('UPDATE auth_credential SET locked_until = ?, fail_count = 0 WHERE username = ?')
        .run(raw, authUserId);
      const login = auth.login({ password: AUTH_PW, remote: '127.0.0.1' });
      const st = auth.status();
      return { login: login.httpStatus, err: login.error, unknown: login.lockedUnknown, locked: st.locked, stUnknown: st.lockedUnknown };
    };
    const emptyCase = runOne('');
    const nullCase = runOne(null);
    t.check('鉴权②/F19-2：**空串 `locked_until` ⇒ 从严"锁定未知"**（`login` 423 + `lockedUnknown=true`、' +
      '`status` 200 且 `locked=true/lockedUnknown=true`）；**成对**：`locked_until=NULL` ⇒ 未设置（`login` 200、`status.locked=false`）' +
      '—— 只有 NULL 是"未设置"，非 NULL 而不可解析一律从严',
      emptyCase.login === 423 && emptyCase.err === 'locked' && emptyCase.unknown === true &&
      emptyCase.locked === true && emptyCase.stUnknown === true &&
      nullCase.login === 200 && nullCase.locked === false && nullCase.stUnknown === false,
      `空串 ⇒ login=${emptyCase.login}/${emptyCase.err}/lockedUnknown=${emptyCase.unknown}、status.locked=${emptyCase.locked}/${emptyCase.stUnknown}；` +
      `NULL ⇒ login=${nullCase.login}、status.locked=${nullCase.locked}/${nullCase.stUnknown}`);
    AUTH_DB.db.prepare('UPDATE auth_credential SET locked_until = NULL, fail_count = 0 WHERE username = ?').run(authUserId);
  }

  /* ---- **F19-4**（结案复跑残留）：内部字段**结构化**隔离 —— `toPublic()` 是唯一对外出口 ---- */
  {
    const rawFail = auth.login({ password: 'definitely-wrong-9', remote: '127.0.0.1' });
    const pubFail = authSvc.toPublic(rawFail);
    /* ok 分支也要过一遍：`toPublic()` 不得误伤正常对外字段（token/username/...） */
    const pubOk = authSvc.toPublic({ ok: true, error: '', token: 'x', username: authUserId, expiresAt: '2026-09-19 22:00:00' });
    t.check('鉴权/F19-4：服务层内部字段已挪进 `__internal`（原始返回里 `__internal.failCount` 存在，' +
      '顶层不再有 `failCount`/`remainingAttempts`）；`toPublic()` 输出**不含** `__internal`/`failCount`/`remainingAttempts`，' +
      '其余对外字段原样保留 —— 适配器只许输出 `toPublic()` 结果（结构层防护，不再只靠注释）',
      Boolean(rawFail.__internal) && Number.isInteger(rawFail.__internal.failCount) &&
      Number.isInteger(rawFail.__internal.remainingAttempts) &&
      rawFail.failCount === undefined && rawFail.remainingAttempts === undefined &&
      authSvc.INTERNAL_FIELDS.includes('failCount') &&
      pubFail.__internal === undefined && pubFail.failCount === undefined && pubFail.remainingAttempts === undefined &&
      pubFail.ok === false && pubFail.error === 'bad_credentials' && pubFail.httpStatus === 401 &&
      JSON.stringify(pubFail) === JSON.stringify({ ok: false, error: 'bad_credentials', httpStatus: 401, reason: '用户名或口令不正确' }) &&
      pubOk.token === 'x' && pubOk.username === authUserId && pubOk.expiresAt === '2026-09-19 22:00:00',
      `原始 __internal=${JSON.stringify(rawFail.__internal)}；toPublic=${JSON.stringify(pubFail)}；` +
      `ok 分支保留字段=${JSON.stringify(Object.keys(pubOk))}`);
    AUTH_DB.db.prepare('UPDATE auth_credential SET locked_until = NULL, fail_count = 0 WHERE username = ?').run(authUserId);
  }

  /* ---- HTTP 端到端（进程内 `createRouter()` + `mountAuth()`；阶段二已接进 server/index.js，真进程断言在 harness-check） ---- */
  const AUTH_HTTP_DB = makeTempDb({ name: 'auth-http' });
  db.initSchema(AUTH_HTTP_DB.db, NOW);
  const authHttp = authSvc.createAuth({ db: AUTH_HTTP_DB.db, logger: authLogger, now: authClock.source() });
  const authRouter = createRouter({ getHealth: () => ({ ok: true }), onError: err => authLogLines.push('500 ' + err.message) });
  const authMount = mountAuth(authRouter, { auth: authHttp, logger: authLogger, now: authClock.source() });
  const authServer = http.createServer((req, res) => {
    Promise.resolve(authRouter.handle(req, res)).catch(() => { try { res.destroy(); } catch { /* 已断 */ } });
  });
  const authPort = await allocPort();
  await new Promise((resolve, reject) => {
    authServer.once('error', reject);
    authServer.listen(authPort, '127.0.0.1', resolve);
  });
  const authCall = async (method, pathname, payload, headers, rawBody) => {
    const init = { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
    if (method === 'POST') init.body = rawBody === undefined ? JSON.stringify(payload === undefined ? {} : payload) : rawBody;
    const res = await fetch(`http://127.0.0.1:${authPort}${pathname}`, init);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 80) }; }
    return { status: res.status, body };
  };
  const authHttpGet = (p, h) => authCall('GET', p, undefined, h);
  const authHttpPost = (p, payload, h, rawBody) => authCall('POST', p, payload, h, rawBody);
  try {
    /* ⚠ 码要**先取下来存进局部变量**：`authHttp.initCode()` 在初始化成功后返回 null，
       而 `'...'.includes(null)` 会退化成"搜字符串 'null'"（JSON 里的 `null` 字段到处都是）——
       首版就是这么写出了一个恒假的条件。 */
    const authHttpCode = authHttp.initCode();
    const hStatus0 = await authHttpGet('/auth/status');
    const hLoginBefore = await authHttpPost('/auth/login', { password: AUTH_PW });
    /* ⚠ 本机 fetch 的来源恒为回环，**造不出**"非回环请求"（那一条由服务层探针覆盖，见九之三开头）；
       故这里不再发"伪非回环"请求 —— 它在 HTTP 面其实是一次**成功**的初始化（首版就是这么写错的）。 */
    const hInit = await authHttpPost('/auth/init', { code: authHttpCode, password: AUTH_PW });
    const hInitAgain = await authHttpPost('/auth/init', { code: authHttpCode, password: AUTH_PW2 });
    const hLogin = await authHttpPost('/auth/login', { password: AUTH_PW });
    const hLoginWrong = await authHttpPost('/auth/login', { password: 'nope-1234' });
    const hChangeNoToken = await authHttpPost('/auth/change', { oldPassword: AUTH_PW, newPassword: AUTH_PW2 });
    const hLogout = await authHttpPost('/auth/logout', {}, { Authorization: 'Bearer ' + hLogin.body.token });
    const hLogoutAgain = await authHttpPost('/auth/logout', {}, { Authorization: 'Bearer ' + hLogin.body.token });
    /* 改密用一个**新**会话；随后用**该会话**登出 ⇒ 必须 401（证明"改密即清当前会话"在 HTTP 面同样生效） */
    const hChangeSession = (await authHttpPost('/auth/login', { password: AUTH_PW })).body.token;
    const hChange = await authHttpPost('/auth/change', { oldPassword: AUTH_PW, newPassword: AUTH_PW2 },
      { Authorization: 'Bearer ' + hChangeSession });
    const hLogoutAfterChange = await authHttpPost('/auth/logout', {}, { Authorization: 'Bearer ' + hChangeSession });
    const hStatus = await authHttpGet('/auth/status');
    const hNope = await authHttpGet('/auth/nope');
    /* **F17-8①**：服务层对"用户不存在"会带回 `failCount`（`remainingAttempts` 同理）—— 那是**内部分支**，
       一旦被适配器转发，ADR-0007 D2 的"对外不区分原因"就被绕过（可枚举用户名）。HTTP 适配器的白名单里
       刻意没有这两个键；这里实测"两种失败的对外正文**逐字节同形状**"（时钟注入固定 ⇒ `at` 也相同）。 */
    const hWrongPw = hLoginWrong;                                   // 已存在用户 + 错口令
    const hUnknownUser = await authHttpPost('/auth/login', { username: 'no-such-user', password: AUTH_PW });
    /* 畸形请求的前置读数：两次畸形请求**都不该进到业务逻辑** ⇒ 失败计数必须一动不动 */
    const hFailBeforeMalformed = authHttp.status().failCount;
    const hBig = await authHttpPost('/auth/login', undefined, undefined, JSON.stringify({ password: 'x'.repeat(1024 * 1024 + 64) }));
    const hBadJson = await authHttpPost('/auth/login', undefined, undefined, '{not-json');
    const hFailAfterMalformed = authHttp.status().failCount;
    t.check('鉴权(HTTP)：`GET /auth/status` 在未初始化时返回 `{ok:true, initialized:false}`（**不含任何秘密**：无 hash/salt/token/初始化码）；' +
      '未初始化时 `POST /auth/login` ⇒ 409 `not_initialized`',
      hStatus0.status === 200 && hStatus0.body.ok === true && hStatus0.body.initialized === false &&
      hStatus0.body.initCodePending === true && hStatus0.body.token === undefined &&
      typeof authHttpCode === 'string' && authHttpCode.length === 12 &&
      !JSON.stringify(hStatus0.body).includes(authHttpCode) &&
      hLoginBefore.status === 409 && hLoginBefore.body.error === 'not_initialized',
      `status=${hStatus0.status}/initialized=${hStatus0.body.initialized}；login=${hLoginBefore.status}/${hLoginBefore.body.error}；` +
      `status 正文含初始化码=${JSON.stringify(hStatus0.body).includes(authHttpCode)}`);
    t.check('鉴权(HTTP)：`POST /auth/init` 对码成功 200、重复 init 409（幂等拒绝）；`POST /auth/login` 200 且返回 ' +
      'token/expiresAt；错口令 401 且**只回 error、不回原因**（不区分口令错与用户不存在）',
      hInit.status === 200 && hInit.body.ok === true && hInit.body.username === authUserId &&
      hInitAgain.status === 409 && hInitAgain.body.error === 'already_initialized' &&
      hLogin.status === 200 && /^[0-9a-f]{64}$/.test(hLogin.body.token) &&
      typeof hLogin.body.expiresAt === 'string' &&
      hLoginWrong.status === 401 && hLoginWrong.body.error === 'bad_credentials' &&
      hLoginWrong.body.reason === undefined,
      `init=${hInit.status}，initAgain=${hInitAgain.status}，login=${hLogin.status}，` +
      `loginWrong=${hLoginWrong.status}/${hLoginWrong.body.error}（reason 未下发=${hLoginWrong.body.reason === undefined}）`);
    t.check('鉴权(HTTP)/F17-8①：**用户不存在**与**口令错**的对外正文**逐字节同形状**（都 401 `bad_credentials`，' +
      '都不带 `reason`/`failCount`/`remainingAttempts`）—— 服务层那两个"只对真实用户出现"的字段**任何适配器都不得转发**',
      hWrongPw.status === 401 && hUnknownUser.status === 401 &&
      hWrongPw.body.error === 'bad_credentials' && hUnknownUser.body.error === 'bad_credentials' &&
      hWrongPw.body.reason === undefined && hUnknownUser.body.reason === undefined &&
      hWrongPw.body.failCount === undefined && hUnknownUser.body.failCount === undefined &&
      hWrongPw.body.remainingAttempts === undefined && hUnknownUser.body.remainingAttempts === undefined &&
      JSON.stringify(hWrongPw.body) === JSON.stringify(hUnknownUser.body),
      `口令错=${JSON.stringify(hWrongPw.body)}；用户不存在=${JSON.stringify(hUnknownUser.body)}`);
    t.check('鉴权(HTTP)：`POST /auth/change` 缺 Bearer ⇒ 401 `unauthorized`；带 Bearer ⇒ 200 且**清当前会话**' +
      '（随后用**同一个**令牌登出 ⇒ 401，证明会话真被清了，不是"只回了个 ok"）',
      hChangeNoToken.status === 401 && hChangeNoToken.body.error === 'unauthorized' &&
      hChange.status === 200 && hChange.body.requireRelogin === true &&
      hLogoutAfterChange.status === 401 && hLogoutAfterChange.body.error === 'unauthorized',
      `change 无令牌=${hChangeNoToken.status}；change=${hChange.status}；改密后同令牌 logout=${hLogoutAfterChange.status}`);
    t.check('鉴权(HTTP)：`POST /auth/logout`（Bearer）⇒ 200；重复登出 ⇒ 401；`GET /auth/nope` ⇒ 404（**未另起路由表**，' +
      '仍是 `server/http/router.js` 的 404 口径）；`mountAuth()` 显式自报 `mounted:true` 与 5 条路由',
      authMount.mounted === true && authMount.routes.length === 5 &&
      authRouter.list().includes('GET /auth/status') && authRouter.list().includes('POST /auth/init') &&
      authRouter.list().includes('POST /auth/login') && authRouter.list().includes('POST /auth/logout') &&
      authRouter.list().includes('POST /auth/change') &&
      hLogout.status === 200 && hLogout.body.ok === true && hLogoutAgain.status === 401 &&
      hNope.status === 404 && hNope.body.err && hNope.body.err.code === 'NOT_FOUND' &&
      hStatus.status === 200 && hStatus.body.initialized === true && hStatus.body.isInitial === false &&
      hStatus.body.username === authUserId && hStatus.body.sessions !== undefined,
      `挂载 routes=${authMount.routes.join(' , ')}；logout=${hLogout.status}；重复 logout=${hLogoutAgain.status}；` +
      `/auth/nope=${hNope.status}；status=${JSON.stringify({ initialized: hStatus.body.initialized, isInitial: hStatus.body.isInitial })}`);
    /* readJson 的既有口径不得被本单改动：超 1 MiB ⇒ 413、非法 JSON ⇒ 400（两者都在**鉴权/业务之前**） */
    t.check('鉴权(HTTP)：`readJson` 既有口径不变 —— 请求体超 1 MiB ⇒ **413** `PAYLOAD_TOO_LARGE`、非法 JSON ⇒ **400** `BAD_JSON`' +
      '（且两者都没进到业务逻辑：`/auth/login` 的失败计数**一动不动**）',
      hBig.status === 413 && hBig.body.err && hBig.body.err.code === 'PAYLOAD_TOO_LARGE' &&
      hBadJson.status === 400 && hBadJson.body.err && hBadJson.body.err.code === 'BAD_JSON' &&
      hFailAfterMalformed === hFailBeforeMalformed,
      `1 MiB+ ⇒ ${hBig.status}/${hBig.body.err && hBig.body.err.code}；坏 JSON ⇒ ${hBadJson.status}/` +
      `${hBadJson.body.err && hBadJson.body.err.code}；失败计数 ${hFailBeforeMalformed} → ${hFailAfterMalformed}`);
    t.check('鉴权(HTTP)：整段 HTTP 处理期间**无未捕获异常**（router 的 onError 未收到 500）',
      authLogLines.filter(l => l.startsWith('500 ')).length === 0,
      authLogLines.filter(l => l.startsWith('500 ')).join(' / '));
  } finally {
    await new Promise(resolve => authServer.close(resolve));
  }
  /* 收尾：本节自建的库与连接全部关闭（Windows 上不关会锁住临时目录；ADR-0003 D17） */
  AUTH_DB.close();
  AUTH_HTTP_DB.close();

  /* ---------------- 十、清理与残留 ---------------- */
  /* ---------------- 十之十一、A1：DR-06（shift_stat）与 DR-08（warning）的仓储层（T-20261002-06） ----------------
     本节覆盖 `T-20261002-05`（座位 3）交付的两处仓储；断言对象＝**仓储层自身的可观察行为**：
       · `repo/shiftStat.js` —— 唯一写入口 `upsertFrozen()`（`ux_shift_stat` 幂等 ＋ **信息单调守卫**）、
         三个读口（`getShiftRow` / `sumRunSec` / `countRows`·`listRows`）与入参校验；
       · `repo/warning.js` —— 唯一写入口 `insertWarning()`（**前缀条件插入**＝幂等，表无唯一索引）、
         `dedupeKeyOf()` 的取回、计数口径与入参校验。
     **期望值全部实测或构成性推导**（ADR-0004 D21）：幂等/单调的期望**不照抄被测实现的返回值**，
     而是由本节自带的 `foldGuard()` 在**同一库、同一初始状态**下独立复算一遍（写-读-比逐列）。
     "无采集帧的班次 `oee`/`pass_rate` 落 NULL 而非 0" 那条**状态位**的**产生**在装配层
     （`server/index.js` 的 `shiftStatRowOf()`，判据是 `fact.frameCount/pieceCount === 0`），
     故它由 `harness-check` 走真采集链路端到端断言；本节断言仓储层的**另一半**：
     用 `null` 写进去读出来就是 `null`（列允许 NULL、不被 Coerce 成 0），且它与 `oee = 0` 在库里**可分辨**。
     两半合起来才是"不用 0 顶替"。
     **一用例一库**：本节自建临时库与连接，跑完 `handle.close()` 当场删除（第十节的口径）。 */
  t.section('十之十一、A1：DR-06 shift_stat 与 DR-08 warning 的仓储层（幂等／信息单调／区间求和／前缀去重）');
  {
    const A1 = makeTempDb({ name: 'a1-repo' });
    try {
      db.initSchema(A1.db, NOW);
      const A1_T0 = '2026-10-02 10:00:00';
      /** 一行 `shift_stat` 的**独立复算器**（与 `tests\._verify\seat3-a1-probe.js` 的构造无关、不共用数字）：
       *  按 `ux_shift_stat` 的 INSERT-or-UPDATE 语义 ＋ 把 `UPSERT_SQL` 的 `WHERE` 守卫**逐条重写**一遍。
       *  它不是被测实现（不 require 任何 repo），只为"这次 upsert 到底改了哪些列"给出**独立**期望。 */
      const foldGuard = (row, payload) => {
        /* 守卫**逐条重写**（唯一要拦的组合＝"新行两列都为 NULL 且旧行至少一列非 NULL"） */
        const blocked = payload.passRate === null && payload.oee === null &&
          row !== null && (row.pass_rate !== null || row.oee !== null);
        const effect = !row ? 'insert' : (blocked ? 'blocked' : 'update');
        /* 被拦下 ⇒ 行**一个字节都不该变**（期望＝原行副本，不是"入参的那一行"） */
        if (blocked) return { effect: effect, updated: row !== null, row: Object.assign({}, row) };
        const r = Object.assign({}, row || {});
        Object.assign(r, {
          shift_date: payload.shiftDate, shift_name: payload.shiftName,
          plan_qty: payload.planQty, started_qty: payload.startedQty, finished_qty: payload.finishedQty,
          qualified_qty: payload.qualifiedQty, failed_qty: payload.failedQty, retest_qty: payload.retestQty,
          pass_rate: payload.passRate, run_sec: payload.runSec, idle_sec: payload.idleSec,
          oee: payload.oee, frozen_at: payload.frozenAt
        });
        if (!row) r.created_at = payload.createdAt;
        return { effect: effect, updated: row !== null, row: r };
      };
      const probeWrite = (payload) => {
        const before = shiftStatRepo.getShiftRow(A1.db, payload.shiftDate, payload.shiftName);
        const rowsBefore = shiftStatRepo.countRows(A1.db);
        const ret = shiftStatRepo.upsertFrozen(A1.db, payload);
        const rowsAfter = shiftStatRepo.countRows(A1.db);
        const after = shiftStatRepo.getShiftRow(A1.db, payload.shiftDate, payload.shiftName);
        const exp = foldGuard(before, payload);
        /* `id` 由 SQLite 自增；`created_at` 按契约只在 INSERT 落 ⇒ UPDATE 分支不参与逐列比对 */
        const cols = ['shift_date', 'shift_name', 'plan_qty', 'started_qty', 'finished_qty', 'qualified_qty',
          'failed_qty', 'retest_qty', 'pass_rate', 'run_sec', 'idle_sec', 'oee', 'frozen_at'];
        const colDiff = cols.filter(c => (after ? after[c] : undefined) !== exp.row[c])
          .map(c => `${c}: 实测 ${JSON.stringify(after ? after[c] : undefined)} ≠ 独立复算 ${JSON.stringify(exp.row[c])}`);
        /* 守卫是否**真的**生效，只能由"行内容有没有变"看出来 —— 见下面 DR-06-4 的实测登记。
           为什么**不能**拿 `ret.written` 当判据（`E85⒠③` 更正，理由与旧注释**相反**）：
           `written` 由 `changes > 0` 推出，而 `changes` 只说明"这次 upsert 确实改动了行"——
           **守卫放行的同值重算也计 1**（`frozen_at` 每次重算都会被刷新）⇒ 它区分不了
           "守卫拦下"与"放行但值恰好相同"，故不能用它当"守卫生效"的证据。
           实测（`tests\._verify\review\t2-e85-upsert-changes.js`：出厂 `UPSERT_SQL` ＋ 真仓储、连做两次）：
             · 守卫**拦下**（新行两列都 NULL / 旧行已知）⇒ SQLite 报 **`changes=0`**（两次都是 0，确定性）、
               `repo.written=false`／`updated=true`、行内容纹丝不动；
             · 守卫**放行**的同值重算 ⇒ `changes=1`（`frozen_at` 被刷新）。
           ⚠ 旧注释曾写"`WHERE` 为假时 `changes` **仍报 1**（它数的是'冲突被解决了'）"——与事实相反，
           本节据座位 5 的 C·18.6⒟ 与上面这次复测改正（**结论**"不拿 `written` 当判据"不变）。 */
        const contentUnchanged = JSON.stringify(before) === JSON.stringify(after);
        return {
          ret, before, after, exp, colDiff, contentUnchanged,
          dRows: rowsAfter - rowsBefore, updatedExpected: exp.updated
        };
      };
      const rowB = (date, name) => shiftStatRepo.getShiftRow(A1.db, date, name);
      const shiftRowInput = (over) => Object.assign({
        shiftDate: '2026-10-05', shiftName: '早班', planQty: 10, startedQty: 8, finishedQty: 6,
        qualifiedQty: 5, failedQty: 1, retestQty: 0, passRate: 83.3, runSec: 600, idleSec: 300,
        oee: 20.8, frozenAt: A1_T0, createdAt: A1_T0
      }, over);
      /** `null`（＝无法判定）形态的一行 —— 装配层 `shiftStatRowOf()` 在 `frameCount/pieceCount === 0` 时给出的就是它 */
      const placeholderRow = (over) => shiftRowInput(Object.assign({
        planQty: 0, startedQty: 0, finishedQty: 0, qualifiedQty: 0, failedQty: 0, retestQty: 0,
        passRate: null, runSec: 0, idleSec: 0, oee: null
      }, over));

      /* ---- ① 幂等（`ux_shift_stat` 命中即 UPDATE，不新增行） ---- */
      /* 幂等/守卫的**落点**是 SQL 文本（`repo/shiftStat.js` 导出的只读常量），而它是**结构级**契约：
         冲突目标必须是唯一索引 `ux_shift_stat(shift_date, shift_name)` 的两列 —— 换掉它 SQLite 会直接
         报 `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`（脚本退 2、
         一条断言都跑不出来，见回执里的 D22-M4）。故这里对**导出常量**补一条文本级断言，
         让"冲突目标被改"这件事在断言层面**指名**变红（而不是表现为整脚本崩溃）。 */
      t.check('A1/DR-06-0 幂等落点＝唯一索引 `ux_shift_stat(shift_date, shift_name)` 的两列' +
        '（对 `UPSERT_SQL` 纠错：把冲突目标换成任何别的列组合，SQLite 会以"不匹配唯一约束"直接拒绝执行）',
        /\bON CONFLICT\(shift_date, shift_name\) DO UPDATE SET\b/.test(shiftStatRepo.UPSERT_SQL) &&
        /WHERE NOT \(\(excluded\.pass_rate IS NULL AND excluded\.oee IS NULL\)/.test(shiftStatRepo.UPSERT_SQL),
        `UPSERT_SQL 的冲突目标与守卫形态均在场（见 repo/shiftStat.js 导出的 UPSERT_SQL）`);

      const w1 = probeWrite(shiftRowInput({}));
      t.check('A1/DR-06-1 唯一写入口首次 upsert ⇒ 恰 +1 行（`ux_shift_stat` 唯一索引生效）、`ret.written=true`、`updated=false`，' +
        '且写进去的行与独立复算**逐列相等**',
        w1.ret.written === true && w1.ret.updated === false && w1.dRows === 1 &&
        w1.ret.updated === w1.updatedExpected && w1.exp.effect === 'insert' &&
        w1.ret.shiftKey === '2026-10-05|早班' && w1.colDiff.length === 0,
        `effect=${w1.exp.effect}、written=${w1.ret.written}、updated=${w1.ret.updated}、Δrows=${w1.dRows}、` +
        `shiftKey=${w1.ret.shiftKey}｜列差异：${w1.colDiff.join('；') || '（无）'}`);

      const w2 = probeWrite(shiftRowInput({}));
      t.check('A1/DR-06-2 同一归属（逐字相同入参）再 upsert ⇒ **行数不变**（Δrows=0，不新增重复行），' +
        '且读回确认它就是**我们那两列**的那一行（键列逐字相等 ⇒ 幂等没有把行"挪"到别的归属上）',
        w2.dRows === 0 && w2.before !== null && shiftStatRepo.countRows(A1.db) === 1 &&
        w2.ret.written === true && w2.colDiff.length === 0 &&
        w2.after !== null && w2.after.shift_date === '2026-10-05' && w2.after.shift_name === '早班',
        `Δrows=${w2.dRows}、总行数=${shiftStatRepo.countRows(A1.db)}、written=${w2.ret.written}、updated=${w2.ret.updated}；` +
        `读回键=(${w2.after && w2.after.shift_date}, ${w2.after && w2.after.shift_name})`);

      const w3 = probeWrite(shiftRowInput({
        planQty: 12, startedQty: 9, finishedQty: 7, qualifiedQty: 6, failedQty: 1, retestQty: 1,
        passRate: 85.7, runSec: 700, idleSec: 200, oee: 24.3, frozenAt: '2026-10-05 16:00:30'
      }));
      t.check('A1/DR-06-3 同一归属、读数不同再 upsert ⇒ 仍 **Δrows=0**，`written=true`、`updated=true`，' +
        '且 UPDATE 逐列落在预期值上（幂等的实义是"覆盖同一行"）',
        w3.dRows === 0 && w3.ret.written === true && w3.ret.updated === true &&
        w3.ret.updated === w3.updatedExpected && w3.after !== null &&
        w3.after.plan_qty === 12 && w3.after.pass_rate === 85.7 &&
        w3.after.run_sec === 700 && w3.after.frozen_at === '2026-10-05 16:00:30' && w3.colDiff.length === 0,
        `Δrows=${w3.dRows}、updated=${w3.ret.updated}、plan_qty=${w3.after && w3.after.plan_qty}、` +
        `pass_rate=${w3.after && w3.after.pass_rate}、run_sec=${w3.after && w3.after.run_sec}、` +
        `frozen_at=${w3.after && w3.after.frozen_at}（仍只有一行）`);

      /* ---- ② 信息单调守卫（SQL 里的 `WHERE NOT (新行 unknown AND 旧行 known)`） ----
         ⚠ **判据口径（ADR-0004 D19／D21）**：本包**不**用 `ret.written` 判"守卫有没有拦住"，理由是
         它在这一族形态下**不稳定**：同一变异体在两次运行里既可读到 `false` 也可读到 `true`
         （同一 SQL、同一数据；SQLite 把"冲突被解决了"与"列被改了"混在 `changes` 里，
         见本文件 D22 记录与本包回执的"未验到/偏差"）。凡摇一次的读数都不能当判据 ——
         故这里的期望**全部落在行内容上**（`updated` / Δrows / 逐列比对 / 独立复算），
         它们与"这一行到底有没有被改写"一一对应。 */
      const g0 = rowB('2026-10-05', '早班');
      const w4 = probeWrite(placeholderRow({ frozenAt: '2026-10-05 16:05:00' }));
      t.check('A1/DR-06-4 **信息单调守卫**：已"可判定"的行（pass_rate/oee 非 NULL）不被"无法判定"的重算覆盖 —— ' +
        '`updated=true`（命中的确是既有行）、Δrows=0，且**行内容逐列纹丝不动**、独立复算认为该行不该变',
        w4.ret.updated === true && w4.ret.updated === w4.updatedExpected && w4.exp.effect === 'blocked' &&
        w4.dRows === 0 && w4.contentUnchanged && w4.colDiff.length === 0 &&
        w4.after.pass_rate === 85.7 && w4.after.oee === 24.3 && w4.after.frozen_at === '2026-10-05 16:00:30' &&
        JSON.stringify(w4.after) === JSON.stringify(g0),
        `守卫命中：updated=${w4.ret.updated}、Δrows=${w4.dRows}、行内容未变=${w4.contentUnchanged}、` +
        `列差异=${w4.colDiff.length} 处；pass_rate=${w4.after.pass_rate}、oee=${w4.after.oee}、` +
        `frozen_at=${w4.after.frozen_at}（仍是上一次写入的值）`);

      const w5 = probeWrite(placeholderRow({ shiftDate: '2026-10-06', frozenAt: '2026-10-06 00:05:00' }));
      t.check('A1/DR-06-5 守卫的**另一侧**：全新归属写占位行 ⇒ 首次 INSERT（Δrows=1、`updated=false`），' +
        '且落库确实是两个 **NULL** 状态位（未被守卫误拦、也未被写成 0）',
        w5.dRows === 1 && w5.ret.updated === false && w5.exp.effect === 'insert' &&
        w5.after.pass_rate === null && w5.after.oee === null && w5.after.run_sec === 0 &&
        w5.colDiff.length === 0,
        `首次 INSERT：updated=${w5.ret.updated}（期望 ${w5.updatedExpected}）、Δrows=${w5.dRows}、` +
        `pass_rate=${JSON.stringify(w5.after.pass_rate)}、oee=${JSON.stringify(w5.after.oee)}`);

      const w5b = probeWrite(placeholderRow({ shiftDate: '2026-10-06', frozenAt: '2026-10-06 00:06:00' }));
      t.check('A1/DR-06-5b 占位行 → 占位行（新行未知、旧行**也**未知）⇒ **不被守卫拦**：`frozen_at` 确实被刷新' +
        '（这条与 DR-06-4 合起来证明守卫只拦"未知覆盖已知"一种组合）',
        w5b.ret.updated === true && w5b.exp.effect === 'update' && w5b.dRows === 0 &&
        w5b.after.frozen_at === '2026-10-06 00:06:00' && !w5b.contentUnchanged && w5b.colDiff.length === 0,
        `updated=${w5b.ret.updated}（期望 ${w5b.updatedExpected}）、行内容已变=${!w5b.contentUnchanged}、` +
        `frozen_at=${w5b.after.frozen_at}（已刷新 ⇒ 真走了 UPDATE 分支）`);

      /* 占位行（两列 NULL）升级为可判定 ⇒ 必须允许（这是"迟到帧补足"的合法路径，不是回退） */
      const upPayload = shiftRowInput({ frozenAt: '2026-10-05 16:10:00' });
      const w6 = probeWrite(upPayload);
      t.check('A1/DR-06-6 单调是**单向**的：占位行（两列 NULL）被后续真实读数升级为可判定 ⇒ 允许写入（迟到帧补足不被守卫误拦）',
        w6.ret.written === true && w6.ret.updated === true && w6.exp.effect === 'update' &&
        w6.after.pass_rate === upPayload.passRate && w6.after.oee === upPayload.oee &&
        w6.after.frozen_at === '2026-10-05 16:10:00' && w6.colDiff.length === 0,
        `占位 → 可判定：written=${w6.ret.written}、pass_rate=${JSON.stringify(w6.after.pass_rate)}、` +
        `oee=${JSON.stringify(w6.after.oee)}、frozen_at=${w6.after.frozen_at}`);

      const w7 = probeWrite(shiftRowInput({ passRate: null, oee: 24.3, frozenAt: '2026-10-05 16:20:00' }));
      t.check('A1/DR-06-7 **两个状态位各自独立**：只把 `pass_rate` 写成 NULL（合格率无法计算）而 `oee` 仍可判定 ⇒ ' +
        '这是**部分信息更新**，守卫按"两列都为 NULL"判 ⇒ 允许写（不得把"只缺一列"也拦掉）',
        w7.ret.written === true && w7.exp.effect === 'update' &&
        w7.after.pass_rate === null && w7.after.oee === 24.3 && w7.colDiff.length === 0,
        `written=${w7.ret.written}（期望 ${w7.writtenExpected}）、pass_rate=${JSON.stringify(w7.after.pass_rate)}、` +
        `oee=${JSON.stringify(w7.after.oee)}`);

      /* ---- ③ 入库口校验（结构不动 ⇒ 脏入参只能靠这一层拦住） ---- */
      const a1Throws = (fn) => { try { fn(); return null; } catch (err) { return err; } };
      t.check('A1/DR-16-1 `frozenAt`/`createdAt` 非「yyyy-MM-dd HH:mm:ss」一律拒收（TypeError）：缺秒／带 T／带毫秒三种形态',
        a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ frozenAt: '2026-10-05 16:00' }))) instanceof TypeError &&
        a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ frozenAt: '2026-10-05T16:00:00' }))) instanceof TypeError &&
        a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ createdAt: '2026-10-05 16:00:00.123' }))) instanceof TypeError,
        '三种形态均抛 TypeError（文本列的区间比较依赖定长形态，混入即让"文本序＝时间序"静默失效）');

      t.check('A1/DR-06-8 秒数列上界＝一天（86400）：`runSec = 86401` ⇒ RangeError；`runSec = 0` ⇒ 合法（"确实没有新增"是合法读数，不是缺值）',
        a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ runSec: 86401 }))) instanceof RangeError &&
        shiftStatRepo.SHIFT_SEC_MAX === 86400 &&
        a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ idleSec: 0 }))) === null,
        `SHIFT_SEC_MAX=${shiftStatRepo.SHIFT_SEC_MAX}；86401 ⇒ RangeError；idleSec=0 ⇒ 不抛`);

      t.check('A1/DR-06-9 `passRate`/`oee` 的取值域＝`0～100 的有限数` 或 `null`：负值／超 100／NaN／Infinity 四种一律拒收',
        [() => shiftRowInput({ passRate: -0.1 }), () => shiftRowInput({ passRate: 100.1 }),
          () => shiftRowInput({ oee: NaN }), () => shiftRowInput({ oee: Infinity })]
          .every(mk => a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, mk())) instanceof TypeError),
        '四种均抛 TypeError（"无法判定"必须写成 null，不能写成 0／NaN 混进来）');

      t.check('A1/DR-06-10 计数列＝非负整数：负数／小数／字符串三种一律拒收；`shiftName` 空白与超长（200 上限）也拒收',
        a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ planQty: -1 }))) instanceof TypeError &&
        a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ startedQty: 1.5 }))) instanceof TypeError &&
        a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ finishedQty: '3' }))) instanceof TypeError &&
        a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ shiftName: '   ' }))) instanceof TypeError &&
        a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ shiftName: '班'.repeat(201) }))) instanceof RangeError &&
        shiftStatRepo.TEXT_MAX === 200,
        `TEXT_MAX=${shiftStatRepo.TEXT_MAX}（超长拒收而不是截断 —— 截断会悄悄改名、破坏归属键）`);

      t.check('A1/DR-06-11 归属键两列形态固定：`shiftDate` 非 `yyyy-MM-dd` ⇒ TypeError；库句柄缺失/非库对象 ⇒ TypeError（不静默不写）',
        a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ shiftDate: '2026-10-05 00:00:00' }))) instanceof TypeError &&
        a1Throws(() => shiftStatRepo.upsertFrozen(null, shiftRowInput({}))) instanceof TypeError &&
        a1Throws(() => shiftStatRepo.countRows({})) instanceof TypeError,
        '`shift_date` 是 DR-06 的归属键（含跨零点归属）⇒ 形态必须定长；无库句柄时报错而不是"看起来写成功了"');

      /* 校验**先于写入**：不合规的归属键被拒时必须**一行都没写**（不是"先写了再报错"、也不是"截断后再写"） */
      const badKeyRows0 = shiftStatRepo.countRows(A1.db);
      const badKeyBefore = JSON.stringify(shiftStatRepo.getShiftRow(A1.db, '2026-10-05', '早班'));
      const badKeyErr = a1Throws(() => shiftStatRepo.upsertFrozen(A1.db, shiftRowInput({ shiftDate: '2026-10-05x' })));
      t.check('A1/DR-06-11b 形态校验**先于写入**：非法 `shiftDate` 被拒后 `shift_stat` 行数一动不动、' +
        '既有行也**逐列未被改写**（拒收不是"写一半"）',
        badKeyErr instanceof TypeError && shiftStatRepo.countRows(A1.db) === badKeyRows0 &&
        JSON.stringify(shiftStatRepo.getShiftRow(A1.db, '2026-10-05', '早班')) === badKeyBefore,
        `抛 ${badKeyErr && badKeyErr.constructor.name}；行数 ${badKeyRows0} → ${shiftStatRepo.countRows(A1.db)}；` +
        `既有行逐列未变=${JSON.stringify(shiftStatRepo.getShiftRow(A1.db, '2026-10-05', '早班')) === badKeyBefore}`);

      /* ---- ④ 读口 `getShiftRow` / `countRows` / `listRows` ---- */
      const a1List = shiftStatRepo.listRows(A1.db, 10);
      t.check('A1/DR-06-12 读口一致性：`listRows` / `countRows` / `getShiftRow` 三者读到的是**同一份事实**（行数相等、该行逐列相等）',
        a1List.length === shiftStatRepo.countRows(A1.db) && a1List.length === 2 &&
        JSON.stringify(a1List.find(r => r.shift_date === '2026-10-05' && r.shift_name === '早班')) ===
        JSON.stringify(rowB('2026-10-05', '早班')),
        `listRows=${a1List.length} 行、countRows=${shiftStatRepo.countRows(A1.db)} 行（10-05 早班 ＋ 10-06 早班占位）`);

      const missingRow = shiftStatRepo.getShiftRow(A1.db, '2026-10-07', '早班');
      /* ⚠ 只断言"返回 null"是**不够**的：把查询的 WHERE 去掉 `shift_name` 那一半，在本节的数据下
         仍会"碰巧"返回 null（该日期下没有任何行）。故再加**同名不同日期**的对照 —— 两次读取必须
         各自命中自己那一行（键列逐字相等），这才真正锁住"读口按两列定位"。 */
      const keyScopedA = shiftStatRepo.getShiftRow(A1.db, '2026-10-05', '早班');
      const keyScopedB = shiftStatRepo.getShiftRow(A1.db, '2026-10-06', '早班');
      t.check('A1/DR-06-13 读口按**两列**定位：无该班次 ⇒ **null**（不编造一行零值）；' +
        '且同名不同日期的两行各读自己那一行（返回行的 `shift_date`/`shift_name` 必须逐字等于入参）',
        missingRow === null &&
        keyScopedA !== null && keyScopedA.shift_date === '2026-10-05' && keyScopedA.shift_name === '早班' &&
        keyScopedB !== null && keyScopedB.shift_date === '2026-10-06' && keyScopedB.shift_name === '早班',
        `getShiftRow(2026-10-07, 早班)=${JSON.stringify(missingRow)}；` +
        `10-05 行=(${keyScopedA && keyScopedA.shift_date}, ${keyScopedA && keyScopedA.shift_name})、` +
        `10-06 行=(${keyScopedB && keyScopedB.shift_date}, ${keyScopedB && keyScopedB.shift_name})`);

      /* 键的**值绑定**：请求"2026-10-05 晚班"（不存在的班次）时，同一日期下**存在**"早班"那一行 ——
         若读口把 `shift_name` 那一半丢了条件、或把绑定参数张冠李戴，这里会返回"早班"那行；
         正确实现必须返回 **null**（"问的是晚班，不能拿早班顶"）。 */
      const wrongName = shiftStatRepo.getShiftRow(A1.db, '2026-10-05', '晚班');
      t.check('A1/DR-06-13b 读口按**两列的值**定位：同一日期下存在"早班"行时，问"晚班"必须返回 **null**' +
        '（不拿同日的别的班次顶替；这条与 13 一起把"丢条件/错绑定"两种改法都钉死）',
        wrongName === null && keyScopedA !== null,
        `getShiftRow(2026-10-05, 晚班)=${JSON.stringify(wrongName)}（同日确实存在 2026-10-05 早班行）`);

      /* ---- ⑤ 区间求和 `sumRunSec`（DR-17 日/月/年三档的真源；归属键＝DR-06 的 shift_date） ---- */
      const dayRow = (date, name, runSec, passRate, oee) => shiftStatRepo.upsertFrozen(A1.db, {
        shiftDate: date, shiftName: name, planQty: 0, startedQty: 0, finishedQty: 0,
        qualifiedQty: 0, failedQty: 0, retestQty: 0,
        passRate, runSec, idleSec: 0, oee, frozenAt: A1_T0, createdAt: A1_T0
      });
      /* 参与求和的行（**每一行都为一个判据服务**，逐条注明它证伪什么）：
         10-02 早班 600（可判定）／
         10-02 中班 60（**两个状态位都 NULL** ⇒ 唯一的占位行，undetermined 的分子）／
         10-02 晚班 0（**oee=50 可判定、pass_rate=NULL**）—— 落在**日档**内，证伪"只判 pass_rate IS NULL"；
         10-02 早班之外的第二个 10-02 行还要有一条 **oee=NULL 而 pass_rate 非 NULL** 的：
         故 10-02 的行里再加 10-02 **早班 0 / pass_rate=88.8 / oee=NULL**（见下一行注释的说明），
         它证伪"只判 oee IS NULL"（**因为它在日档内**，只判 oee 会把它也数成无法判定）；
         10-03 早班 1800（可判定）／10-03 中班 0（**oee=0 而 pass_rate=NULL**，证伪"把 0 当无法判定"）／
         10-06 早班 0（占位：两列都 NULL，落在月/年档 ⇒ 使月档的 undetermined 与日档**不相等**）／
         10-07 早班 0（**oee=5 而 pass_rate=NULL**，证伪"只判 pass_rate IS NULL"）；
         2026-11-03 早班 1800（可判定，用于跨月过滤）。
         ⚠ **同一 `(shift_date, shift_name)` 只能落一行**（`ux_shift_stat`），且"两列都 NULL"的占位行
         被信息单调守卫保护（不能被别人覆盖）⇒ 每一行的身份都是**独占**的：10-02 早班＝可判定、
         10-02 中班＝占位（两列 NULL）、10-02 晚班＝**oee=NULL 而 pass_rate=88.8**。
         10-06 早班那一行**不在这里**写 —— 它已经由 DR-06-5 的占位写入建立（再写一次会被守卫按
         "占位行不可被覆盖"拦下，这一点本身就是 DR-06-4 的判据）。 */
      dayRow('2026-10-02', '早班', 600, 83.3, 20.8);
      dayRow('2026-10-02', '中班', 60, null, null);
      dayRow('2026-10-02', '晚班', 0, 88.8, null);
      dayRow('2026-10-03', '早班', 1800, 90, 62.5);
      dayRow('2026-10-03', '中班', 0, null, 0);
      dayRow('2026-10-07', '早班', 0, null, 5);
      dayRow('2026-11-03', '早班', 1800, 100, 62.5);
      /* 前提（ADR-0004 D20）：上面七次写入**一次都不能被守卫拦下** —— 被拦下时求和读数会被上一段的
         陈旧行污染（现场实测踩到过：把上一段的探针行留在同一归属上，月/年档会多出 600）。
         这里先钉住"参与求和的行集合恰为 9 行"，后面几条求和的期望值才成立。 */
      t.check('A1/DR-17-0 前提：本节求和夹具确已全部落库 —— 参与求和的 `shift_stat` 恰 **9 行**' +
        '（10-05 早班 ＋ 10-06 早班占位 ＋ 上面 7 行；一次都没被守卫拦下）',
        shiftStatRepo.countRows(A1.db) === 9 &&
        ['2026-10-02|早班', '2026-10-02|中班', '2026-10-02|晚班', '2026-10-03|早班', '2026-10-03|中班',
          '2026-10-06|早班', '2026-10-07|早班', '2026-11-03|早班']
          .every(k => {
            const [d, n] = k.split('|');
            return rowB(d, n) !== null;
          }),
        `行数=${shiftStatRepo.countRows(A1.db)}；键集（逐行实测，含两个状态位）=` +
        shiftStatRepo.listRows(A1.db, 20).map(r => `${r.shift_date}|${r.shift_name}(pr=${JSON.stringify(r.pass_rate)},oee=${JSON.stringify(r.oee)})`).join(' , '));

      const sA = shiftStatRepo.sumRunSec(A1.db, { day: '2026-10-02', month: '2026-10', year: '2026' });
      t.check('A1/DR-17-1 区间求和 ①：按 `shift_date` 分档 —— 日档＝当日 600+60+0=660；' +
        '月档＝**10 月的全部行**（10-02 660 ＋ 10-03 1800 ＋ 10-05/10-06/10-07 均为 0 = 3060）；' +
        '年档＝全表（＋ 11-03 的 1800 = 4860）（跨日的行不进日档；**同月的行不分日**，都进月档）',
        sA.daySec === 660 && sA.monthSec === 3060 && sA.yearSec === 4860 && sA.rows === 9,
        `日=${sA.daySec}、月=${sA.monthSec}、年=${sA.yearSec}、全表行数=${sA.rows}`);

      t.check('A1/DR-17-2 区间求和 ②：`undetermined` 只数"**两列都为 NULL**"的补记占位行 —— ' +
        '10-02 **日档 1 行**（中班）；月/年档 2 行（＋ 10-06 早班的占位行）；' +
        '而"只有一格 NULL"的行**都不算**：`oee=NULL,pass_rate=88.8`（10-02 晚班，**在日档内** ⇒ 证伪"只判 oee IS NULL"）、' +
        '`oee=0,pass_rate=NULL`（10-03 中班）、`oee=5,pass_rate=NULL`（10-07 早班）',
        sA.undetermined.day === 1 && sA.undetermined.month === 2 && sA.undetermined.year === 2 &&
        rowB('2026-10-02', '晚班').oee === null && rowB('2026-10-02', '晚班').pass_rate === 88.8,
        `无法判定行数：日=${sA.undetermined.day}、月=${sA.undetermined.month}、年=${sA.undetermined.year}；` +
        '（三行"只有一格 NULL"**都未**被计入 —— 条件是两个状态位**同时**为 NULL）');

      const sB = shiftStatRepo.sumRunSec(A1.db, { day: '2026-10-03', month: '2026-10', year: '2026' });
      t.check('A1/DR-17-3 区间求和 ③：日档随 `day` 变化（10-03 ⇒ 1800，含那行 0），而**月/年档保持**（跨日不清月）',
        sB.daySec === 1800 && sB.monthSec === 3060 && sB.yearSec === 4860 && sB.undetermined.day === 0,
        `10-03：日=${sB.daySec}、月=${sB.monthSec}、年=${sB.yearSec}、该日无法判定=${sB.undetermined.day}`);
      /* 跨月/跨年：**另起一个库**（`A1B`）—— 上一段那个库里 10 月既有 10-xx 的行、又有 11-03 的行，
         月档会同时含两者，用它验"跨月归零"会把两个口径搅在一起。新库里只有 11-03 一行。 */
      const A1B = makeTempDb({ name: 'a1-repo-cross' });
      let sC = null; let sD = null;
      try {
        db.initSchema(A1B.db, NOW);
        shiftStatRepo.upsertFrozen(A1B.db, {
          shiftDate: '2026-11-03', shiftName: '早班', planQty: 0, startedQty: 0, finishedQty: 0,
          qualifiedQty: 0, failedQty: 0, retestQty: 0, passRate: 100, runSec: 1800, idleSec: 0, oee: 62.5,
          frozenAt: A1_T0, createdAt: A1_T0
        });
        sC = shiftStatRepo.sumRunSec(A1B.db, { day: '2026-11-03', month: '2026-11', year: '2026' });
        sD = shiftStatRepo.sumRunSec(A1B.db, { day: '2027-01-01', month: '2027-01', year: '2027' });
        t.check('A1/DR-17-4 区间求和 ④：**跨月归零**（FR-6.5）—— 11 月档＝1800、10 月档＝0（上月的运行时长不再计入月累计），' +
          '而**年档 1800 保留**（跨月不清年）',
          sC.daySec === 1800 && sC.monthSec === 1800 && sC.yearSec === 1800 &&
          shiftStatRepo.sumRunSec(A1B.db, { day: '2026-11-03', month: '2026-10', year: '2026' }).monthSec === 0,
          `11-03：日=${sC.daySec}、月=${sC.monthSec}、年=${sC.yearSec}；` +
          `同库按 10 月档求和＝${shiftStatRepo.sumRunSec(A1B.db, { day: '2026-11-03', month: '2026-10', year: '2026' }).monthSec}（0 ⇒ 真归零）`);

        t.check('A1/DR-17-5 区间求和 ⑤：**跨年归零**（FR-6.6）—— 同一库按 2027 年档求和＝0' +
          '（空集是**真 0**，不是"算不出来"）；`rows` 仍报**全表**行数（对账用，不受周期过滤影响）',
          sD.daySec === 0 && sD.monthSec === 0 && sD.yearSec === 0 &&
          sD.undetermined.day === 0 && sD.undetermined.month === 0 && sD.undetermined.year === 0 &&
          sD.rows === shiftStatRepo.countRows(A1B.db) && sD.rows === 1,
          `2027：日/月/年档均 0，rows=${sD.rows}（全表 1 行）；无法判定 0（空档里没有行，不是"无法判定"）`);
      } finally {
        A1B.close();
      }
      t.check('A1：跨月/跨年用的第二个临时库跑完**当场关闭并删除**',
        !fs.existsSync(A1B.dir), A1B.dir);

      t.check('A1/DR-17-6 周期键形态校验：`day` 非 `yyyy-MM-dd`、`year` 非 `yyyy`、以及 `day`/`month`/`year` 缺项一律 TypeError' +
        '（否则会静默求和成 0 并冒充"跨月归零"）',
        a1Throws(() => shiftStatRepo.sumRunSec(A1.db, { day: '2026-10-02 00:00:00', month: '2026-10', year: '2026' })) instanceof TypeError &&
        a1Throws(() => shiftStatRepo.sumRunSec(A1.db, { day: '2026-10-02', month: '2026-10', year: '26' })) instanceof TypeError &&
        a1Throws(() => shiftStatRepo.sumRunSec(A1.db, {})) instanceof TypeError &&
        a1Throws(() => shiftStatRepo.sumRunSec(A1.db, { day: '2026-10-02', year: '2026' })) instanceof TypeError,
        '四种非法入参均抛 TypeError（`sumRunSec` 不读时钟：周期键由调用方按注入时钟给出，ADR-0003 D17）');

      /* ⚠ **未覆盖 / 已知边界（如实登记，不是通过）**：`SUM_SQL` 的月/年档用 `substr(shift_date, 1, 7)`
         与 `substr(shift_date, 1, 4)` 过滤，而 `sumRunSec()` 的 `MONTH_RE` 是 `/^\d{4}-\d{2}$/`
         —— **只校验形状、不校验月份取值域** ⇒ `month = '2026-13'` 不会抛错，而是静默返回
         `monthSec = 0`。它**不会**被读成"10 月跨月归零了"：`server/services/stateSnapshot.js` 的
         `period.month` 取自 `platformClock.fmtDate(now).slice(0, 7)`（永不为 13），
         故生产路径不可达。这里把实测读数**如实钉住**（防日后有人把校验改成"更松"而无声漂移），
         并明确它**不**是本包主张的正确行为：
         `month='2026-13'` ⇒ 不抛错、`monthSec === 0`、而同年 `yearSec` 仍为全表值。`day` 那一档
         有 `DATE_RE` 兜底，**月份取值域**这一档目前没有 —— 登记为未覆盖项（详见回执）。 */
      const monthShape = (() => {
        try { return { threw: false, value: shiftStatRepo.sumRunSec(A1.db, { day: '2026-10-02', month: '2026-13', year: '2026' }) }; }
        catch (err) { return { threw: true, name: err.constructor.name }; }
      })();
      t.check('A1/DR-17-7（**未覆盖项登记**：月份取值域不校验 —— 实测行为）`month = \'2026-13\'` **不抛错**、' +
        '`monthSec = 0`；同一次调用里 `yearSec` 仍是全表值 ⇒ 这条只锁"现状读数"，**不主张它是正确行为**',
        monthShape.threw === false && monthShape.value.monthSec === 0 &&
        monthShape.value.yearSec === sA.yearSec && monthShape.value.daySec === sA.daySec,
        `month='2026-13' ⇒ 抛错=${monthShape.threw}、日=${monthShape.value.daySec}、月=${monthShape.value.monthSec}、` +
        `年=${monthShape.value.yearSec}（＝全表值 ${sA.yearSec}）`);

      /* ---- ⑥ `null` 与 `0` 在库里**可分辨**（"不用 0 顶替"的状态位落点） ---- */
      const posRow = rowB('2026-10-02', '早班');
      const phRow = rowB('2026-10-06', '早班');
      const zeroRow = rowB('2026-10-03', '中班');
      t.check('A1/E38-1 两个状态位在**库内可分辨**：占位行 `oee` 与 `pass_rate` **都是 NULL**，' +
        '而"有帧但一帧都不足 ⇒ 真 0%"的行 `oee === 0`、`run_sec === 0` —— 读方不会把"算不出来"读成"零运行"',
        posRow.oee === 20.8 && posRow.pass_rate === 83.3 &&
        phRow.oee === null && phRow.pass_rate === null && phRow.run_sec === 0 && phRow.idle_sec === 0 &&
        zeroRow.oee === 0 && zeroRow.pass_rate === null && zeroRow.run_sec === 0,
        `占位行(oee/pass_rate)=(${JSON.stringify(phRow.oee)}, ${JSON.stringify(phRow.pass_rate)})、` +
        `真 0 行(oee/pass_rate)=(${JSON.stringify(zeroRow.oee)}, ${JSON.stringify(zeroRow.pass_rate)})、` +
        `可判定行=(${posRow.oee}, ${posRow.pass_rate})`);

      /* ---------------- DR-08（`warning`）仓储层 ---------------- */
      const WARN_T1 = '2026-10-02 16:00:01';
      const wrow = (over) => Object.assign({
        warnType: '参数超范围预警', triggerCond: '深度 5.31（标准 4.80～5.30）',
        dedupeKey: '参数|2026-10-02|工单WO-A1|第1件|depth', triggeredAt: WARN_T1, createdAt: WARN_T1
      }, over);

      const i1 = warningRepo.insertWarning(A1.db, wrow({}));
      const n1 = warningRepo.countAll(A1.db);
      const i2 = warningRepo.insertWarning(A1.db, wrow({ triggerCond: '深度 5.44（标准 4.80～5.30）' }));
      const n2 = warningRepo.countAll(A1.db);
      t.check('A1/DR-08-1 **前缀条件插入即幂等**：同一 `(warn_type, 归属键)` 第二次插入 `written=false`、**行数不变**；' +
        '且库内那行的 `trigger_cond` 仍是**第一次**的原文（幂等＝不覆盖既有事实，不是"最后一次赢"）',
        i1.written === true && i2.written === false && n1 === 1 && n2 === 1 &&
        i1.triggerCond === '参数|2026-10-02|工单WO-A1|第1件|depth｜深度 5.31（标准 4.80～5.30）',
        `首次 written=${i1.written}、再次 written=${i2.written}；行数 ${n1} → ${n2}；` +
        `trigger_cond=${JSON.stringify(i1.triggerCond)}`);

      const rowK = warningRepo.findByKey(A1.db, '参数超范围预警', '参数|2026-10-02|工单WO-A1|第1件|depth');
      t.check('A1/DR-08-2 落库形态＝`归属键 ＋ 分隔符 ＋ 触发条件描述`：`findByKey` 按前缀精确命中 1 行，' +
        '且 `triggered_at`＝**判定时刻**（调用方给）、`state` 缺省 `未处理`',
        rowK.length === 1 && rowK[0].triggered_at === WARN_T1 && rowK[0].state === '未处理' &&
        rowK[0].trigger_cond.indexOf('参数|2026-10-02|工单WO-A1|第1件|depth' + warningRepo.SEP) === 0 &&
        warningRepo.dedupeKeyOf(rowK[0].trigger_cond) === '参数|2026-10-02|工单WO-A1|第1件|depth',
        `命中 ${rowK.length} 行、triggered_at=${rowK[0] && rowK[0].triggered_at}、state=${rowK[0] && rowK[0].state}`);

      const i3 = warningRepo.insertWarning(A1.db, wrow({ warnType: '参数阈值临近预警' }));
      const i4 = warningRepo.insertWarning(A1.db, wrow({ dedupeKey: '参数|2026-10-02|工单WO-A1|第1件|speed' }));
      const i5 = warningRepo.insertWarning(A1.db, wrow({
        dedupeKey: '参数|2026-10-02|工单WO-A1|第1件|depth', triggerCond: '深度 5.31（标准 4.80～5.30）'
      }));
      t.check('A1/DR-08-3 幂等键是 **`(warn_type, 归属键)` 两元**：换等级（warn_type）⇒ 新行；换参数名（归属键尾段）⇒ 新行；' +
        '两者都不换 ⇒ 幂等命中（行数 1 → 3，第三次不增）',
        i3.written === true && i4.written === true && i5.written === false &&
        warningRepo.countAll(A1.db) === 3 &&
        warningRepo.countByType(A1.db, '参数超范围预警') === 2 &&
        warningRepo.countByType(A1.db, '参数阈值临近预警') === 1,
        `行数=${warningRepo.countAll(A1.db)}（超范围 ×2 ＋ 临近 ×1）；i3/i4/i5 written=${i3.written}/${i4.written}/${i5.written}`);

      const i6 = warningRepo.insertWarning(A1.db, wrow({ dedupeKey: '参数|2026-10-02|工单WO-A1|第1件|depth|附加' }));
      t.check('A1/DR-08-4 **前缀比较不是"包含"**：新归属键 `…|depth|附加` 以旧键为前缀、但旧键不是新键的前缀 ⇒ ' +
        '必须新增一行（若把前缀判定写成 `LIKE`／`includes`，这里会静默并条 ⇒ 丢预警）',
        i6.written === true && warningRepo.countAll(A1.db) === 4,
        `written=${i6.written}、行数=${warningRepo.countAll(A1.db)}`);

      const listW = warningRepo.listRows(A1.db, 10);
      t.check('A1/DR-08-5 读口：`listRows` 行数＝`countAll`；`findByKey` 查不存在的键 ⇒ **空数组**（不编造）',
        listW.length === warningRepo.countAll(A1.db) &&
        warningRepo.findByKey(A1.db, '参数超范围预警', '参数|无归属日|无工单|无件序号|depth').length === 0,
        `listRows=${listW.length}、countAll=${warningRepo.countAll(A1.db)}；不存在的键 ⇒ 0 行`);

      t.check('A1/DR-08-6 入库口校验：归属键**含分隔符**一律拒收（前缀会歧义 ⇒ 不猜）；空 `warnType`／非 DR-16 的 `triggeredAt` 同样拒收',
        a1Throws(() => warningRepo.insertWarning(A1.db, wrow({ dedupeKey: '参数|2026-10-02|a｜b' }))) instanceof TypeError &&
        a1Throws(() => warningRepo.insertWarning(A1.db, wrow({ warnType: '  ' }))) instanceof TypeError &&
        a1Throws(() => warningRepo.insertWarning(A1.db, wrow({ triggeredAt: '2026-10-02T16:00:01' }))) instanceof TypeError,
        '三种非法入参均抛 TypeError；`SEP` 只作分界符，不得出现在归属键里');

      t.check('A1/DR-08-7 `dedupeKeyOf` 的边界：无分隔符 ⇒ 原文返回（旧数据/人为写入不炸）；空串／非串 ⇒ 空串（"没有"就是空）',
        warningRepo.dedupeKeyOf('无分隔符的旧文本') === '无分隔符的旧文本' &&
        warningRepo.dedupeKeyOf('key' + warningRepo.SEP + 'desc') === 'key' &&
        warningRepo.dedupeKeyOf('') === '' && warningRepo.dedupeKeyOf(null) === '' &&
        warningRepo.dedupeKeyOf(undefined) === '',
        `SEP=${JSON.stringify(warningRepo.SEP)}；四种边界形态均按"取第一个分隔符之前"返回`);
    } finally {
      /* 本节自建的库当场关闭并删除（第十节"临时区与残留"的口径：不留给下一节、也不留给下次运行） */
      A1.close();
    }
    t.check('A1：本章自建的临时库跑完**当场关闭并删除**（一用例一库，不留残留）',
      !fs.existsSync(A1.dir), A1.dir);
  }

  /* ---------------- 十之十二、FR-7.12 公告仓储层（DR-10 唯一写入口 ＋ 同事务留痕 ＋ 读口） ----------------
     需求依据：`FR-7.12`（P0）「**仅本机解锁后可新增/编辑/删除公告**」；「操作记录保留」＝`FR-8.7`／`NFR-15`／`DR-12`。
     负责人已裁定的口径（本节逐条按它写）：
       · 三个动作都走 `server/repo/notice.js` 的**唯一写入口**，且都是 `BEGIN → 写表 → op_log.append → COMMIT`
         （**表与留痕同事务**："改了但没留痕"这个中间态不允许出现）；
       · **删除＝硬删 ＋ 原文进 `op_log`**（`valid_to` 是 DR-10 的**有效期**语义，**不是**软删标志）；
       · 投影 `lv` 恒 `'info'`、`todo` 恒 `[]`（表无等级/待办列 ⇒ **不得**要求实现编造）；
       · `valid_from` 缺省＝发布时刻、`valid_to` 缺省 NULL、`priority` 缺省 0 —— `FR-7.11` 的**有效期过滤与轮播
         未实现**（P1／技术债 `E3`），两列只是如实落库，故本节**不**为过滤/轮播写任何"已实现"断言。 ---- */
  t.section('十之十二、FR-7.12 公告仓储层（`repo/notice.js`：发布/编辑/删除 ＋ 同事务 `op_log` ＋ 四个读口）');
  {
    const NC = makeTempDb({ name: 'notice-repo' });
    try {
      db.initSchema(NC.db, NOW);
      const NC_T0 = '2026-10-02 09:30:00';
      const NC_T1 = '2026-10-02 09:31:00';
      const NC_T2 = '2026-10-02 10:00:00';
      const ctx0 = { now: NC_T0, operator: '张伟', teamCode: '检验一班' };
      const ctx1 = { now: NC_T1, operator: '李娜', teamCode: '检验二班' };
      const logs = opType => opLogRepo.list(NC.db, { opType }, { limit: 50 });

      /* ---- ① 发布 ---- */
      const pub = noticeRepo.publish(NC.db, {
        content: '仓储层公告原文（发布）', subType: '生产调整', createdBy: '张伟'
      }, ctx0);
      const rowPub = noticeRepo.getById(NC.db, pub.id);
      const pubLogs = logs(noticeRepo.OP_TYPE.PUBLISH);
      t.check('DR-10/FR-7.12-1 **发布**（唯一写入口 `publish`）：`notice` 表恰 +1 行、逐列如实落库' +
        '（`valid_from` 缺省＝发布时刻、`valid_to` 缺省 NULL、`priority` 缺省 0、`created_at`＝`updated_at`＝注入时刻）；' +
        '同一事务里 `op_log`（公告发布/成功）恰 +1 且带操作人与班组编号',
        pub.ok === true && pub.action === 'publish' && noticeRepo.count(NC.db) === 1 &&
        rowPub.content === '仓储层公告原文（发布）' && rowPub.sub_type === '生产调整' &&
        rowPub.category === noticeRepo.CATEGORY.NOTICE && rowPub.valid_from === NC_T0 &&
        rowPub.valid_to === null && Number(rowPub.priority) === 0 &&
        rowPub.created_by === '张伟' && rowPub.created_at === NC_T0 && rowPub.updated_at === NC_T0 &&
        Boolean(pub.row) && pub.opLogId !== null && pubLogs.length === 1 &&
        pubLogs[0].result === opLogRepo.RESULT.SUCCESS && pubLogs[0].operator === '张伟' &&
        pubLogs[0].teamCode === '检验一班' && pubLogs[0].opTime === NC_T0 &&
        /仓储层公告原文（发布）/.test(String(pubLogs[0].content)),
        `id=${pub.id}；行=${JSON.stringify(rowPub)}；留痕=${JSON.stringify(pubLogs)}`);

      /* ---- ② 编辑＝同一条更新 ---- */
      const beforeEdit = noticeRepo.getById(NC.db, pub.id);
      const ed = noticeRepo.edit(NC.db, { id: pub.id, content: '仓储层公告原文（编辑后）' }, ctx1);
      /* ⚠ `|| {}` 不是防御性摆设：若"编辑"把主键改掉（D22 靶子 `M7-edit-bumps-id` 就是这样），
         `getById(pub.id)` 会返 `null` —— 直接读 `null.created_at` 会让**整个脚本**以未捕获异常终止
         （无汇总行、退 2），于是这条断言**报不出红也不同名**（D22 首跑实测：`db-check` 侧"一条都没命中"）。
         改法：让"行没了"如实变成一条**指名**的失败。 */
      const afterEdit = noticeRepo.getById(NC.db, pub.id) || {};
      const editLogs = logs(noticeRepo.OP_TYPE.EDIT);
      t.check('DR-10/FR-7.12-2 **编辑**（`edit`）：仍是**同一条更新** —— `notice` 行数不变、`id` 与 `created_at` ' +
        '逐字不变，`content` 已改、`updated_at` 刷新为本次动作时刻，`created_by` **不动**（那是"谁发布的"）；' +
        '`op_log`（公告编辑/成功）恰 +1，留痕正文含逐字段变更清单（「旧」→「新」）',
        ed.ok === true && ed.action === 'edit' && noticeRepo.count(NC.db) === 1 &&
        Number(afterEdit.id) === Number(pub.id) && afterEdit.created_at === beforeEdit.created_at &&
        afterEdit.content === '仓储层公告原文（编辑后）' && afterEdit.updated_at === NC_T1 &&
        afterEdit.created_by === beforeEdit.created_by && afterEdit.valid_from === beforeEdit.valid_from &&
        ed.changed.length === 1 && /内容/.test(ed.changed[0]) &&
        /仓储层公告原文（发布）/.test(ed.changed[0]) && /仓储层公告原文（编辑后）/.test(ed.changed[0]) &&
        editLogs.length === 1 && editLogs[0].result === opLogRepo.RESULT.SUCCESS &&
        /仓储层公告原文（发布）/.test(String(editLogs[0].content)),
        `行数=${noticeRepo.count(NC.db)}（id ${beforeEdit.id}→${afterEdit.id}）；created_at ${beforeEdit.created_at}→` +
        `${afterEdit.created_at}；updated_at=${afterEdit.updated_at}；changed=${JSON.stringify(ed.changed)}；` +
        `留痕=${JSON.stringify(editLogs[0] || null)}`);

      /* ---- ③ 编辑"零变化"不是操作 ---- */
      const logsBeforeNoChange = opLogRepo.count(NC.db);
      const noChange = noticeRepo.edit(NC.db, { id: pub.id, content: '仓储层公告原文（编辑后）' }, ctx1);
      /* 同 ② 的理由：`getById(pub.id)` 可能返 `null`（`M7-edit-bumps-id` 变异体下就是）——
         不兜住会让脚本在这里未捕获异常终止，本条与后面所有条**都不进失败清单**（D22 首跑实测）。 */
      const rowForNoChange = noticeRepo.getById(NC.db, pub.id) || {};
      t.check('DR-10/FR-7.12-3 **编辑零变化**：一个字段都没改 ⇒ `{ok:false, error:\'no_change\'}` —— ' +
        '`notice` 表与 `op_log` 都**一行不写**（"什么都没改"不是操作），`updated_at` 也**不被刷新**',
        noChange.ok === false && noChange.error === 'no_change' && noChange.id === pub.id &&
        rowForNoChange.updated_at === NC_T1 &&
        noticeRepo.count(NC.db) === 1 && opLogRepo.count(NC.db) === logsBeforeNoChange &&
        logs(noticeRepo.OP_TYPE.EDIT).length === 1,
        `返=${JSON.stringify(noChange)}；updated_at=${rowForNoChange.updated_at}；` +
        `op_log ${logsBeforeNoChange}→${opLogRepo.count(NC.db)}（应不变）`);

      /* ---- ④ 删除＝硬删 ＋ 原文进 op_log ---- */
      const del = noticeRepo.remove(NC.db, { id: pub.id }, ctx1);
      const delLogs = logs(noticeRepo.OP_TYPE.DELETE);
      const delLog = delLogs[0] || {};
      t.check('DR-10/FR-7.12-4 **删除＝硬删 ＋ 原文进 `op_log`**：`notice` 表 −1 行、`getById` 返 `null`' +
        '（**不是**软删 —— `valid_to` 是 DR-10 的**有效期**列，不当删除标志用）；删除留痕恰 +1（公告删除/成功）' +
        '且正文里带**原文全文**、发布时刻与创建人；返回值 `deleted` ＝删除前那一行原文',
        del.ok === true && del.action === 'delete' && noticeRepo.count(NC.db) === 0 &&
        noticeRepo.getById(NC.db, pub.id) === null &&
        delLogs.length === 1 && delLog.result === opLogRepo.RESULT.SUCCESS &&
        /公告原文：仓储层公告原文（编辑后）/.test(String(delLog.content)) &&
        String(delLog.content).includes(NC_T0) && /张伟/.test(String(delLog.content)) &&
        Boolean(del.deleted) && Number(del.deleted.id) === Number(pub.id) &&
        del.deleted.content === '仓储层公告原文（编辑后）',
        `行数=${noticeRepo.count(NC.db)}（硬删）；留痕正文=${JSON.stringify(delLog.content)}；` +
        `deleted=${JSON.stringify(del.deleted || null)}`);

      /* ---- ⑤ 表与留痕**同事务**（D22 靶子：注入 opLog.append 抛错） ---- */
      const txSeed = noticeRepo.publish(NC.db, { content: '同事务用例：先正常写一行' }, ctx1);
      const txBefore = { n: noticeRepo.count(NC.db), logs: opLogRepo.count(NC.db) };
      const savedAppend = opLogRepo.append;
      let txErr = null;
      opLogRepo.append = () => { throw new Error('D22 注入：留痕写失败（表内容必须一并回滚）'); };
      try {
        noticeRepo.publish(NC.db, { content: '同事务用例：留痕失败 ⇒ 这一行不许留下' }, ctx1);
      } catch (err) {
        txErr = err;
      } finally {
        opLogRepo.append = savedAppend;
      }
      const txAfter = { n: noticeRepo.count(NC.db), logs: opLogRepo.count(NC.db) };
      const txLeftover = NC.db.prepare(
        "SELECT COUNT(*) AS c FROM notice WHERE content LIKE '同事务用例：留痕失败%'").get().c;
      t.check('DR-10/FR-7.12-5 **表与留痕同事务**（D22 靶子）：注入 `opLog.append` 抛错 ⇒ 异常如实抛出，' +
        '且 `notice` 表写入**一并回滚**（行数与 `op_log` 条数都回到动作前，"改了但没留痕"这个中间态不存在）；' +
        '注入还原后 `opLog.append` 逐字回到原函数（不污染后续用例）',
        txSeed.ok === true && txBefore.n === 1 &&
        txErr !== null && /D22 注入/.test(String(txErr && txErr.message)) &&
        txAfter.n === txBefore.n && txAfter.logs === txBefore.logs && txLeftover === 0 &&
        noticeRepo.count(NC.db) === 1 && opLogRepo.append === savedAppend,
        `动作前 notice=${txBefore.n} 行／op_log=${txBefore.logs} 条；抛错=${JSON.stringify(txErr && txErr.message)}；` +
        `动作后 notice=${txAfter.n} 行／op_log=${txAfter.logs} 条；半截行残留=${txLeftover}；` +
        `append 已还原=${opLogRepo.append === savedAppend}`);

      /* ---- ⑥ 目标行不存在：不新增、不静默成功、不写留痕 ---- */
      const logsBeforeMiss = opLogRepo.count(NC.db);
      /* ⚠ 包一层 `try` 不是"给实现留后路"：D22 靶子 `M13-not-found-throws` 正是把"返 not_found"
         改成"抛错"。不包的话那条变异会让**整个脚本**未捕获异常终止（无汇总行、退 2）⇒ 本条**报不出红
         也不同名**（D22 首跑实测）。包起来后"抛错"如实变成一条**指名**的失败，语义也更严：
         `edit`/`remove` 必须**返 not_found**，抛错同样算不合契约。 */
      const missOf = fn => { try { return fn(); } catch (err) { return { ok: false, error: 'threw:' + ((err && err.message) || String(err)) }; } };
      const missEdit = missOf(() => noticeRepo.edit(NC.db, { id: 999999, content: '不存在的行' }, ctx0));
      const missDel = missOf(() => noticeRepo.remove(NC.db, { id: 999999 }, ctx0));
      t.check('DR-10/FR-7.12-6 目标行不存在：`edit`/`remove` 一律返 `{ok:false, error:\'not_found\'}`' +
        '（**不新增行**、**不静默成功**），且**不写留痕** —— 连"操作"都没发生（调用方据此回 404，见 harness-check §17）',
        missEdit.ok === false && missEdit.error === 'not_found' &&
        missDel.ok === false && missDel.error === 'not_found' &&
        noticeRepo.count(NC.db) === 1 && opLogRepo.count(NC.db) === logsBeforeMiss,
        `edit=${JSON.stringify(missEdit)}；remove=${JSON.stringify(missDel)}；` +
        `notice=${noticeRepo.count(NC.db)}；op_log ${logsBeforeMiss}→${opLogRepo.count(NC.db)}（应不变）`);

      /* ---- ⑦ 读口一致（count / getById / list / listForBoard） ---- */
      const li1 = noticeRepo.publish(NC.db, { content: '读口用例：车间公告 A', subType: '生产调整' }, { now: NC_T2, operator: '张伟', teamCode: '检验一班' });
      const li2 = noticeRepo.publish(NC.db, { content: '读口用例：工艺提示 B', category: noticeRepo.CATEGORY.TIP }, { now: NC_T2, operator: '张伟', teamCode: '检验一班' });
      const li3 = noticeRepo.publish(NC.db, { content: '读口用例：车间公告 C', subType: '车间公示', priority: 5 }, { now: NC_T2, operator: '张伟', teamCode: '检验一班' });
      const listAll = noticeRepo.list(NC.db, {}, {});
      const board = noticeRepo.listForBoard(NC.db);
      t.check('DR-10/FR-7.12-7 读口一致：`count`＝库内行数；`getById` 命中/未命中（`null` —— 不猜）；' +
        '`list` 与 `listForBoard` **同一行集与同一排序**（`priority` 大者在前、同优先级按 `valid_from`/`id` 倒序）；' +
        '读口**不筛有效期**（`FR-7.11` 过滤未实现＝P1，本行不为它背书）',
        noticeRepo.count(NC.db) === 4 &&
        noticeRepo.getById(NC.db, li1.id).content === '读口用例：车间公告 A' &&
        noticeRepo.getById(NC.db, 999999) === null &&
        listAll.length === 4 &&
        listAll.map(r => Number(r.id)).join(',') === [li3.id, li2.id, li1.id, txSeed.id].join(',') &&
        board.notices.length + board.tips.length === 4 &&
        [board.notices, board.tips].every(a => Array.isArray(a)),
        `count=${noticeRepo.count(NC.db)}；list 顺序（id）=${listAll.map(r => r.id).join(',')}（期望 ${[li3.id, li2.id, li1.id, txSeed.id].join(',')} —— ` +
        `优先级 5 的那条在最前，同优先级按 valid_from/id 倒序，⑤ 的种子行（09:31）在最后）；` +
        `notices=${board.notices.length}、tips=${board.tips.length}`);

      /* ---- ⑧ 投影行形状（唯一一份投影） ---- */
      const itemC = board.notices.find(x => x.text === '读口用例：车间公告 C');
      const itemA = board.notices.find(x => x.text === '读口用例：车间公告 A');
      const itemB = board.tips[0];
      t.check('DR-10/FR-7.12-8 投影行形状（`listForBoard` 是**唯一**一份投影，`POST /notice` 响应与 `GET /state` 快照共用）：' +
        '行键恰 `{id,tag,text,lv,time}` —— `tag` ← `sub_type` 优先、缺则退 `category`；`text` ← `content` **原样**；' +
        '`lv` **恒 `info`**（表无等级列 ⇒ 不编造）；`time` ← `valid_from` 的 `HH:MM`；' +
        '`category = 工艺提示` 的行进 `tips`、其余进 `notices`；`todo` **恒 `[]`**（那些是派生量，表里没有）',
        Boolean(itemC) && Object.keys(itemC).sort().join(',') === 'id,lv,tag,text,time' &&
        itemC.tag === '车间公示' && itemC.text === '读口用例：车间公告 C' && itemC.lv === 'info' && itemC.time === '10:00' &&
        Boolean(itemA) && itemA.tag === '生产调整' && itemA.lv === 'info' &&
        board.notices.every(x => x.lv === 'info') &&
        board.tips.length === 1 && Boolean(itemB) && itemB.tag === noticeRepo.CATEGORY.TIP &&
        itemB.lv === 'info' && itemB.time === '10:00' &&
        Array.isArray(board.todo) && board.todo.length === 0,
        `notices=${JSON.stringify(board.notices)}；tips=${JSON.stringify(board.tips)}；todo=${JSON.stringify(board.todo)}`);

      /* ---- ⑨ 入参校验：一律抛错、一行不写（不归一、不猜） ---- */
      const gBefore = { n: noticeRepo.count(NC.db), logs: opLogRepo.count(NC.db) };
      const throwers = [
        ['content 为空白', () => noticeRepo.publish(NC.db, { content: '   ' }, ctx0), TypeError],
        ['content 超长（501 > 500）', () => noticeRepo.publish(NC.db, { content: 'x'.repeat(501) }, ctx0), RangeError],
        ['priority 非整数', () => noticeRepo.publish(NC.db, { content: '合法正文', priority: 1.5 }, ctx0), RangeError],
        ['priority 负数', () => noticeRepo.publish(NC.db, { content: '合法正文', priority: -1 }, ctx0), RangeError],
        ['validFrom 非 DR-16', () => noticeRepo.publish(NC.db, { content: '合法正文', validFrom: '2026-10-02T10:00:00' }, ctx0), TypeError],
        ['now 非 DR-16', () => noticeRepo.publish(NC.db, { content: '合法正文' }, { now: '2026/10/02 10:00:00' }), TypeError],
        ['edit 的 id 为 0', () => noticeRepo.edit(NC.db, { id: 0, content: '合法正文' }, ctx0), TypeError],
        ['remove 的 id 非数值', () => noticeRepo.remove(NC.db, { id: 'abc' }, ctx0), TypeError]
      ];
      const guard = throwers.map(([label, fn, Ctor]) => {
        let caught = null;
        try { fn(); } catch (err) { caught = err; }
        return { label, kind: caught ? caught.constructor.name : '（未抛）', ok: caught instanceof Ctor };
      });
      t.check('DR-10/FR-7.12-9 入参校验（不归一、不猜）：空白/超长 `content`、非整数或负的 `priority`、' +
        '非 DR-16 的时间（`validFrom`/`now`）、非法 `id`（0／非数值）**逐条抛错**（`TypeError`/`RangeError`），' +
        '且 `notice` 表与 `op_log` **一行不写** —— 被拒不是"静默改成合法值"',
        guard.every(g => g.ok) && noticeRepo.count(NC.db) === gBefore.n &&
        opLogRepo.count(NC.db) === gBefore.logs,
        `八种非法入参实测=${JSON.stringify(guard)}；notice ${gBefore.n}→${noticeRepo.count(NC.db)}；` +
        `op_log ${gBefore.logs}→${opLogRepo.count(NC.db)}`);

      /* ---- ⑩ 被拒留痕出口 `auditReject` ---- */
      const rejectLogsBefore = opLogRepo.count(NC.db);
      const rejUnknown = noticeRepo.auditReject(NC.db, { now: NC_T1, operator: '王强', teamCode: '检验三班' },
        'rename', 'bad_action', '动作名不在三态里');
      const rejPublish = noticeRepo.auditReject(NC.db, { now: NC_T1, operator: '王强', teamCode: '检验三班' },
        noticeRepo.ACTION.PUBLISH, 'bad_value', '正文缺失');
      const rejNoDb = noticeRepo.auditReject(null, { now: NC_T1 }, 'publish', 'x', 'y');
      const rejRows = opLogRepo.list(NC.db, {}, { limit: 200 })
        .filter(r => r.result === opLogRepo.RESULT.FAILED);
      t.check('DR-10/FR-7.12-10 被拒留痕出口 `auditReject`：写一条 `result=失败`、`op_type` **按动作归口**' +
        '（未知动作 ⇒ `公告写入拒绝`，已知动作 ⇒ 该动作词形）、带操作人与班组；**不抛**（留痕写不进去不该把 400 变成 500），' +
        '无 db 时返 `{id:null, error:\'no_db\'}` 而**不静默**（调用方据此 warn）',
        rejUnknown.id !== null && rejUnknown.error === null &&
        rejPublish.id !== null && rejPublish.error === null &&
        opLogRepo.count(NC.db) === rejectLogsBefore + 2 && rejRows.length === 2 &&
        rejRows[0].opType === noticeRepo.OP_TYPE.REJECT && rejRows[0].result === opLogRepo.RESULT.FAILED &&
        rejRows[1].opType === noticeRepo.OP_TYPE.PUBLISH && rejRows[1].result === opLogRepo.RESULT.FAILED &&
        rejRows.every(r => r.operator === '王强' && r.teamCode === '检验三班') &&
        /rename/.test(String(rejRows[0].content)) &&
        rejNoDb.id === null && rejNoDb.error === 'no_db',
        `两条留痕=${JSON.stringify(rejRows)}；无 db 返=${JSON.stringify(rejNoDb)}`);
    } finally {
      /* 本节自建的库当场关闭并删除（第十节"临时区与残留"的口径：不留给下一节、也不留给下次运行） */
      NC.close();
    }
    t.check('FR-7.12：本章自建的临时库跑完**当场关闭并删除**（一用例一库，不留残留）',
      !fs.existsSync(NC.dir), NC.dir);
  }

  /* ---------------- 十之十三、`E83`：`shift_stat` 的自然日切段两列与**两套投影** ----------------
     立案：技术债 `E83`（`2026-10-04` 负责人裁定口径、座位 3 于 `T-20261004-10` 落地并提交）——
     「当日」＝**自然日**（按零点切段），而**班次指标**仍整班归"班次开始那天"（`DR-06`）
     ⇒ 同一份运行秒数要有**两套投影**：`shift_stat.run_sec`（整班，班次投影）与
     `run_sec_day1`/`run_sec_day2`（前段归 D、后段归 D+1，自然日投影，`FR-6.4/6.5/6.6`）。
     本节只做**表结构与口径守据**（读数的端到端落在 `tests\logic-check.js` 第十三节）：
       ① **登记**：两列必须写在 `REQUIRED_COLUMNS.shift_stat`（独立于 `schema.sql` 的需求锚）；
       ② **老库基线不得含它们**（写了＝声明"老库不缺它" ⇒ 六之九的正方向门禁对该列失明）；
       ③ **切段恒等式**（对表行逐行扫描）：两列**同为 NULL 或同为非 NULL**（禁半给），
          同为非 NULL 时 `run_sec_day1 + run_sec_day2 === run_sec`（不丢秒、不重复计）；
       ④ **NULL 语义**：两列都为 NULL 的行（老库形态／旧写入口写的行）⇒ 读口按
          "**整段归班次开始日**"兜底 —— 与 `E83` 之前逐字相同；用**真的老库形态**
          （`DROP COLUMN` 退回上一版 ＋ 升版补列）验一次读数。
     可证伪性（D22，靶子见 `tests\._verify\t20261004-11-d22-mutation.js`，**字节副本**还原）：
       M-J1 把读口的 NULL 当 0（`segmentsOf()` 两处 `? null :` → `? 0 :`）⇒ `E83-6/7/8/10` 必红并指名；
       M-J2 关掉写入口的半给守卫（`if (hasD1 !== hasD2)` → `if (false)`）⇒ `E83-4/5` 必红（半给行落库）。
     **一用例一库**：本节自建临时库、跑完当场 `close()`（第十节口径）。 */
  t.section('十之十三、`E83`：`shift_stat` 自然日切段两列（`run_sec_day1/2`）与两套投影');
  {
    const E83 = makeTempDb({ name: 'e83-split' });
    try {
      db.initSchema(E83.db, NOW);
      const e83Cols = db.listColumns(E83.db, 'shift_stat');
      /* ① 登记（**独立锚**）。为什么不能只靠第一节那条"各表关键列齐全"：那一条读的**就是**
         `REQUIRED_COLUMNS` —— 若有人"实现与锚一起改"（删列 ＋ 删锚），它就永远绿。
         本条把**锚自身的内容**也钉住 ⇒ 删锚必红（删列而不删锚由第一节那条红）。 */
      t.check('E83-1 `REQUIRED_COLUMNS.shift_stat` 登记了 `run_sec_day1`/`run_sec_day2`（独立于 `schema.sql` 的' +
        '需求锚：删列 ⇒ 第一节"各表关键列齐全"必红，删锚 ⇒ 本条必红），且库内该表确有这两列',
        REQUIRED_COLUMNS.shift_stat.includes('run_sec_day1') &&
        REQUIRED_COLUMNS.shift_stat.includes('run_sec_day2') &&
        e83Cols.includes('run_sec_day1') && e83Cols.includes('run_sec_day2'),
        `锚=[${REQUIRED_COLUMNS.shift_stat.join(', ')}]；库内列=[${e83Cols.join(', ')}]`);

      /* ② 老库基线**不得**含这两列；且它们必须**由** `STRUCTURE_UPGRADES` 的两条 `ADD COLUMN` 交付 ——
         两件事要一起断言才有意义：只证"不在基线里"而步骤不存在 ⇒ 六之九的正方向会红（不是失明，是缺步骤）；
         只证"有步骤"而基线也写了 ⇒ 六之九 ⑧ 口径冲突会红（本条把**失明**的那种改法单独钉住）。 */
      const e83Base = LEGACY_BASELINE_COLUMNS.shift_stat || [];
      const e83Steps = Array.from(db.STRUCTURE_UPGRADES, s => String(s));
      const e83StepOf = col => e83Steps.some(s =>
        new RegExp(`ALTER\\s+TABLE\\s+shift_stat\\s+ADD\\s+COLUMN\\s+${col}\\b`, 'i').test(s));
      t.check('E83-2 老库基线 `LEGACY_BASELINE_COLUMNS.shift_stat` **有意不含**这两列（写进去＝声明"老库不缺它"' +
        ' ⇒ 六之九的**正方向**门禁对该列**失明**：删掉补列步骤也不会红），而 `STRUCTURE_UPGRADES` 确有两条同列 `ADD COLUMN`',
        !e83Base.includes('run_sec_day1') && !e83Base.includes('run_sec_day2') &&
        e83StepOf('run_sec_day1') && e83StepOf('run_sec_day2'),
        `基线列=[${e83Base.join(', ')}]；补列步骤命中 day1=${e83StepOf('run_sec_day1')}、day2=${e83StepOf('run_sec_day2')}`);

      /* ---- ③ 切段恒等式（真临时库：三种行形态共存） ---- */
      const E83_T = '2026-10-05 00:10:00';
      const e83Put = (over) => shiftStatRepo.upsertFrozen(E83.db, Object.assign({
        shiftDate: '2026-10-04', shiftName: '夜班', planQty: 0, startedQty: 0, finishedQty: 0,
        qualifiedQty: 0, failedQty: 0, retestQty: 0, passRate: 90, runSec: 180, idleSec: 0, oee: 10,
        runSecDay1: 120, runSecDay2: 60, frozenAt: E83_T, createdAt: E83_T
      }, over));
      const e83Throws = (fn) => { try { fn(); return null; } catch (err) { return err; } };
      const e83Row = (name) => shiftStatRepo.getShiftRow(E83.db, '2026-10-04', name);

      const e83w1 = e83Put({});                                                    // 跨零点、已切段 120＋60＝180
      const e83w2 = e83Put({ shiftName: '白班', runSec: 600, runSecDay1: 600, runSecDay2: 0 });
      const e83w3 = e83Put({ shiftName: '中班', runSec: 300, runSecDay1: null, runSecDay2: null });  // 老行形态
      const e83NightFrozen = JSON.stringify(e83Row('夜班'));                        // 切段行的"之前"副本（逐字节）
      const e83w4 = e83Put({ runSecDay1: null, runSecDay2: null });                 // 同归属但**没算切段**的重算
      const e83NightAfterGuard = JSON.stringify(e83Row('夜班'));
      const e83Rows = shiftStatRepo.listRows(E83.db, 50);
      const e83HalfRows = e83Rows.filter(r => (r.run_sec_day1 === null) !== (r.run_sec_day2 === null));
      const e83BrokenRows = e83Rows.filter(r => r.run_sec_day1 !== null && r.run_sec_day1 + r.run_sec_day2 !== r.run_sec);

      const e83Premise = t.requires('E83 夹具前提：三行都在库（夜班已切段 120/60、白班已切段 600/0、中班未切段 NULL）',
        e83Rows.length === 3 && Boolean(e83Row('夜班')) && Boolean(e83Row('白班')) && Boolean(e83Row('中班')) &&
        e83w1.written === true && e83w2.written === true && e83w3.written === true,
        `行数=${e83Rows.length}；键=[${e83Rows.map(r => `${r.shift_date}|${r.shift_name}`).join(' , ')}]`);
      if (e83Premise) {
        t.check('E83-3 **信息单调守卫的 `E83` 第二条**（`UPSERT_SQL` 的第二个 `WHERE NOT`）：已切段的行' +
          '（`run_sec_day1` 非 NULL）不被"没算切段"的重算（两列 NULL）清空 —— 写入口报 `written=false`、' +
          '`updated=true`，且该行**逐字节纹丝不动**',
          e83w4.written === false && e83w4.updated === true &&
          e83NightAfterGuard === e83NightFrozen && e83Row('夜班').run_sec_day1 === 120,
          `written=${e83w4.written}（期望 false）、updated=${e83w4.updated}；行内容未变=${e83NightAfterGuard === e83NightFrozen}；` +
          `day1/day2=${JSON.stringify(e83Row('夜班').run_sec_day1)}/${JSON.stringify(e83Row('夜班').run_sec_day2)}`);

        const e83Half1 = e83Throws(() => e83Put({ runSecDay1: 180, runSecDay2: null }));
        const e83Half2 = e83Throws(() => e83Put({ runSecDay1: null, runSecDay2: 0 }));
        const e83SumBad = e83Throws(() => e83Put({ runSecDay1: 120, runSecDay2: 61 }));
        const e83RowsAfterReject = shiftStatRepo.countRows(E83.db);
        t.check('E83-4 写入口**拒收半给**（只给 `runSecDay1`／只给 `runSecDay2` ⇒ `TypeError`）与' +
          '**不构成划分的切段**（`day1 + day2 ≠ run_sec` ⇒ `RangeError`）：切段是**划分**、不是估计；' +
          '且三次拒收**一行未写**（校验先于写入）',
          e83Half1 instanceof TypeError && e83Half2 instanceof TypeError && e83SumBad instanceof RangeError &&
          e83RowsAfterReject === 3 && JSON.stringify(e83Row('夜班')) === e83NightFrozen,
          `半给①=${e83Half1 && e83Half1.constructor.name}、半给②=${e83Half2 && e83Half2.constructor.name}、` +
          `不等等式=${e83SumBad && e83SumBad.constructor.name}；行数仍=${e83RowsAfterReject}；` +
          `夜班行未变=${JSON.stringify(e83Row('夜班')) === e83NightFrozen}`);

        t.check('E83-5 **切段恒等式**（对表行**逐行扫描**）：两列**同为 NULL 或同为非 NULL**（**禁半给**），' +
          '且同为非 NULL 时 `run_sec_day1 + run_sec_day2 === run_sec`（不丢秒、不重复计）',
          e83Rows.length === 3 && e83HalfRows.length === 0 && e83BrokenRows.length === 0,
          `行数=${e83Rows.length}、半给行=${e83HalfRows.length}、恒等式破的行=${e83BrokenRows.length}；` +
          `行=[${e83Rows.map(r => `${r.shift_name}(run=${r.run_sec},d1=${JSON.stringify(r.run_sec_day1)},` +
            `d2=${JSON.stringify(r.run_sec_day2)})`).join(' , ')}]`);

        /* NULL 语义的**定点**断言（读口纯函数，不依赖上面的夹具）：三种形态各给一次。 */
        const e83SegNull = shiftStatRepo.segmentsOf({ fromDate: '2026-10-04', runSec: 300, runSecDay1: null, runSecDay2: null });
        const e83SegCut = shiftStatRepo.segmentsOf({ fromDate: '2026-10-04', runSec: 180, runSecDay1: 120, runSecDay2: 60 });
        const e83SegFlat = shiftStatRepo.segmentsOf({ fromDate: '2026-10-04', runSec: 600, runSecDay1: 600, runSecDay2: 0 });
        t.check('E83-6 NULL 语义（读口定点 `segmentsOf()`）：两列都为 NULL ⇒ **整段归班次开始日**' +
          '（`[{day: D, sec: runSec}]` —— 与 `E83` 之前逐字相同，**不用 0 顶替**、也不切成两段）；' +
          '已切段 ⇒ 前段归 D、后段归 D+1；不跨零点（`day2 = 0`）⇒ 一段且恒等于整段',
          JSON.stringify(e83SegNull) === JSON.stringify([{ day: '2026-10-04', sec: 300 }]) &&
          JSON.stringify(e83SegCut) === JSON.stringify([{ day: '2026-10-04', sec: 120 }, { day: '2026-10-05', sec: 60 }]) &&
          JSON.stringify(e83SegFlat) === JSON.stringify([{ day: '2026-10-04', sec: 600 }]),
          `NULL ⇒ ${JSON.stringify(e83SegNull)}；切段 ⇒ ${JSON.stringify(e83SegCut)}；day2=0 ⇒ ${JSON.stringify(e83SegFlat)}`);

        /* ---- 两套投影在同一份行上分道（读口 `sumRunSec()` 一次给全） ---- */
        const e83S04 = shiftStatRepo.sumRunSec(E83.db, { day: '2026-10-04', month: '2026-10', year: '2026' });
        const e83S05 = shiftStatRepo.sumRunSec(E83.db, { day: '2026-10-05', month: '2026-10', year: '2026' });
        t.check('E83-7 **两套投影分道**（同一份行、两个口径）：10-04 档 自然日投影＝`day1` 之和（120＋600＋300＝**1020**）、' +
          '班次投影＝**整段**（180＋600＋300＝**1080**，差 60 ＝夜班跨到次日的那一段）；' +
          '10-05 档 自然日投影＝**次日段 `day2`**（**60**）、班次投影＝**0**（没有 `shift_date = 10-05` 的行）',
          e83S04.daySec === 1020 && e83S04.shiftDaySec === 1080 &&
          e83S05.daySec === 60 && e83S05.shiftDaySec === 0,
          `10-04：natural=${e83S04.daySec} / shift=${e83S04.shiftDaySec}；` +
          `10-05：natural=${e83S05.daySec} / shift=${e83S05.shiftDaySec}`);

        t.check('E83-8 **不丢秒、不重复计**：自然日投影的**日档之和**（1020 ＋ 60）＝ **总运行**（180＋600＋300＝1080）；' +
          '月/年两档**两套投影都**等于总运行 1080（一个班次最长 24 h、且月/年边界与零点同刻 ⇒ 两段必落同月/同年）',
          e83S04.daySec + e83S05.daySec === 1080 &&
          e83S04.monthSec === 1080 && e83S04.yearSec === 1080 &&
          e83S04.shiftMonthSec === 1080 && e83S04.shiftYearSec === 1080 &&
          e83S05.monthSec === 1080 && e83S05.yearSec === 1080,
          `日档和=${e83S04.daySec + e83S05.daySec}；10-04 月/年 natural=${e83S04.monthSec}/${e83S04.yearSec}、` +
          `shift=${e83S04.shiftMonthSec}/${e83S04.shiftYearSec}；10-05 月/年 natural=${e83S05.monthSec}/${e83S05.yearSec}`);
      }

      /* ---- ④ 老库形态（**无这两列**）经升版补列后，读口按"整段归开始日"兜底 ----
         手法与六之八（`unit_index`）同源：按**当前**结构建库 ＋ 写一行，再退回上一版形态
         （`DROP COLUMN` ＋ `schema_version` 退回**现算**的上一版），走一次 `initSchema()`。
         为什么值得建这个库（而不是只造 `runSecDay1: null` 的行）：老库的真实形态是**列都不存在**，
         它同时验证两件事 —— ①两条 `ADD COLUMN` 真的把列补回、既有行一行不丢、新列是 `NULL`（**不回填 0**）；
         ②补列之后的读口对 NULL 行给出的读数＝`E83` 之前的读数（整段归开始日）。 */
      const E83LEG = makeTempDb({ name: 'e83-legacy' });
      try {
        db.initSchema(E83LEG.db, NOW);
        shiftStatRepo.upsertFrozen(E83LEG.db, {
          shiftDate: '2026-10-04', shiftName: '夜班', planQty: 0, startedQty: 0, finishedQty: 0,
          qualifiedQty: 0, failedQty: 0, retestQty: 0, passRate: 90, runSec: 180, idleSec: 0, oee: 10,
          runSecDay1: 120, runSecDay2: 60, frozenAt: E83_T, createdAt: E83_T
        });
        E83LEG.db.exec('ALTER TABLE shift_stat DROP COLUMN run_sec_day1');
        E83LEG.db.exec('ALTER TABLE shift_stat DROP COLUMN run_sec_day2');
        const e83PrevVersion = String(Number(SCHEMA_VERSION) - 1);
        E83LEG.db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?')
          .run(e83PrevVersion, 'schema_version');
        const legColsBefore = db.listColumns(E83LEG.db, 'shift_stat');
        if (t.requires('E83 老库前提：`shift_stat` 确已退回"无 `run_sec_day1`/`run_sec_day2`"的上一版形态，' +
          '且库内结构版本＝上一版',
          !legColsBefore.includes('run_sec_day1') && !legColsBefore.includes('run_sec_day2') &&
          db.getSchemaVersion(E83LEG.db) === e83PrevVersion,
          `退回后列=[${legColsBefore.join(', ')}]；库内版本=${db.getSchemaVersion(E83LEG.db)}` +
          `（期望上一版 ${e83PrevVersion}）；当前 SCHEMA_VERSION=${SCHEMA_VERSION}`)) {
          db.initSchema(E83LEG.db, NOW);
          const legColsAfter = db.listColumns(E83LEG.db, 'shift_stat');
          const legRow = shiftStatRepo.getShiftRow(E83LEG.db, '2026-10-04', '夜班');
          const legRowCount = shiftStatRepo.countRows(E83LEG.db);
          t.check('E83-9 老库形态经 `initSchema()` **补列**：两列补上、**既有行一行不丢且读数原样**' +
            '（`run_sec = 180`）、新列是 `NULL`（＝"**未做切段**"，**绝不回填 0** —— 0 与 NULL 在' +
            '"跨没跨零点"上是两个相反的事实）、库内版本升到 `SCHEMA_VERSION`',
            legColsAfter.includes('run_sec_day1') && legColsAfter.includes('run_sec_day2') &&
            legRowCount === 1 && legRow !== null && legRow.run_sec === 180 &&
            legRow.run_sec_day1 === null && legRow.run_sec_day2 === null &&
            db.getSchemaVersion(E83LEG.db) === SCHEMA_VERSION,
            `补列后列含 day1/day2=${legColsAfter.includes('run_sec_day1')}/${legColsAfter.includes('run_sec_day2')}；` +
            `行数=${legRowCount}、行=${JSON.stringify(legRow)}；版本 ${e83PrevVersion} → ${db.getSchemaVersion(E83LEG.db)}`);

          const legS04 = shiftStatRepo.sumRunSec(E83LEG.db, { day: '2026-10-04', month: '2026-10', year: '2026' });
          const legS05 = shiftStatRepo.sumRunSec(E83LEG.db, { day: '2026-10-05', month: '2026-10', year: '2026' });
          t.check('E83-10 老库形态的**读数**（③ 的现场形态）：两列 NULL ⇒ 读口按"**整段归班次开始日**"兜底 ——' +
            '10-04 档自然日＝班次＝**180**（**不**切成 120/60：老行没有切段信息，读口不许凭空猜）、' +
            '10-05 档两套投影都是 **0**；即 `E83` 之前的老库读数**逐字保留**、两套投影同值',
            legS04.daySec === 180 && legS04.shiftDaySec === 180 &&
            legS04.monthSec === 180 && legS04.yearSec === 180 &&
            legS05.daySec === 0 && legS05.shiftDaySec === 0,
            `10-04：natural=${legS04.daySec} / shift=${legS04.shiftDaySec}（月=${legS04.monthSec}、年=${legS04.yearSec}）；` +
            `10-05：natural=${legS05.daySec} / shift=${legS05.shiftDaySec}`);
        }
      } finally {
        E83LEG.close();
      }
      t.check('E83：本节自建的两个临时库跑完**当场关闭并删除**（一用例一库，不留残留）',
        !fs.existsSync(E83LEG.dir), E83LEG.dir);
    } finally {
      E83.close();
    }
  }

  t.section('十、临时区与残留');
  const strayDb = fs.readdirSync(env.paths.tempRoot).filter(n => /\.db(-wal|-shm)?$/.test(n));
  t.check('临时库文件都不在临时区根目录（各用例自有子目录，不会互相干扰）',
    strayDb.length === 0, strayDb.slice(0, 3).join(', '));

  /* `E117`（2026-10-04）：`env.removeLinkSafe()` —— 非链接时与 `rmSync(recursive)` 逐字等价（含 force）。
     `backupDir` 是本节自建的备份目录（`makeTempDir()`），结构上不可能是链接。 */
  env.removeLinkSafe(backupDir, { recursive: true, force: true });
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

/* 先例写法（同 browser-check.js:828、contract-check.js:1624、docs-check.js:547 …）：
   `main()` 是 **async** ⇒ 它的 rejection **不会**被"顶层 try/catch"接住。**E76① 的记账口径
   （实测，勿沿用旧说法）**：这条路走成"无汇总行 ＋ 退 1" ⇒ `run-all.classify(1, null, out)`
   ⇒ `status='failed'`、`detail='退出码 1'`，与"有断言失败"在 `run-all` 台账上**逐字同形**
   （`unverified` 只对"**退 0** 且无汇总行／通过 0 项"成立）。故必须把 `.catch()` 挂在 promise 上
   接住，并按规范 9.5-5 退 **2**（脚本自身异常），异常**打印出来**（可 grep）。
   打印前缀现状见 `lib/assert.js` 末注：`[脚本异常]` 目前只有 E76 修的这 3 个脚本在用。 */
main().catch(err => {
  console.error('\n[脚本异常] 脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
