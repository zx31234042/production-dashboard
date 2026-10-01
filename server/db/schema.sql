-- ==========================================================================
-- 看板本地库表结构（server/db/schema.sql）
-- 依据：需求清单 V1.33 第 7 章「数据需求」DR-01～DR-19
-- 引擎：SQLite（node:sqlite 内置模块），WAL 模式，见 ADR-0001 D5
-- 约定：
--   * 时间统一为文本 'yyyy-MM-dd HH:mm:ss'（DR-16，本机 NTP 时间基准）
--   * 表名与字段名一律小写下划线；与需求/上报的字段映射仍以 src/config/fieldMap.js 为准
--   * 幂等：全部 IF NOT EXISTS，初始化脚本可重复执行
-- ==========================================================================

/* ---------------- 结构版本（供后续迁移判断） ---------------- */
CREATE TABLE IF NOT EXISTS schema_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

/* ---------------- DR-01 设备信息表 ---------------- */
CREATE TABLE IF NOT EXISTS device (
  equip_code      TEXT PRIMARY KEY,              -- 整套系统 1 个编号，覆盖 19 台相机
  equip_name      TEXT NOT NULL,
  model           TEXT,
  location        TEXT,
  upper_host      TEXT,                          -- PC 上位机地址（Q-21）
  upper_port      INTEGER,
  mes_base_url    TEXT,                          -- MES 接口地址（Q-23）
  camera_count    INTEGER DEFAULT 19,
  updated_at      TEXT NOT NULL
);

/* ---------------- DR-02 工单任务表（来源 IF-A） ---------------- */
CREATE TABLE IF NOT EXISTS task (
  proc_order_no   TEXT PRIMARY KEY,              -- 生产任务编号
  batch_no        TEXT,
  product_code    TEXT,
  product_name    TEXT,
  product_no      TEXT,
  drawing_no      TEXT,
  order_no        TEXT,                          -- 生产订单编号（FR-3.4）
  plan_qty        INTEGER DEFAULT 0,             -- 派工数量
  plan_start_time TEXT,
  plan_end_time   TEXT,
  process_no      TEXT,
  process_name    TEXT,
  status          TEXT NOT NULL DEFAULT '待测试', -- 待测试/测试中/合格/不合格/待复检
  actual_start    TEXT,                          -- 实际开工时间
  actual_end      TEXT,                          -- 实际完工时间
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_task_status ON task(status);
CREATE INDEX IF NOT EXISTS ix_task_plan_start ON task(plan_start_time);

/* ---------------- DR-03 测试标准表（(产品,工序,版本) 追加式，来源 IF-A 工艺信息 + 本机录入）
   模型定稿（2026-09-22，需求评审报告 F-04 的 C1 条件）：**追加式版本行** ——
   一条标准＝一行；改标准＝**新增一行（version_no +1）**，旧行原样保留、永不覆盖。
   由此"历史判定不追溯"（草案第二节）才可实现：判定当时引用的版本行仍在库里，事后回查不被改写。
   列与单位口径：
     product_code / process_code  标准维度＝**产品号＋工序号**（process_code 缺省 '' 表示该产品通用）
     version_no                   同一 (产品,工序) 内的版本序号，从 1 起、只增不改
     depth_upper_dev / depth_lower_dev   深度上下**偏差**（m；下偏差为负；基准＝深度典型值）
     depth_typical                       深度典型值（m；**只显示、不参与判定**）
     speed_upper_dev / speed_lower_dev   速度上下偏差（m/s；口径同上）
     speed_typical                       速度典型值（m/s；只显示）
     effective_from               生效时间（本机时间文本，DR-16）；查询"指定时刻生效版本"用它
     created_by                   录入人
     team_code                    录入时**当前生效班次**的班组编号（与 FR-1.6 同一真源，见 DR-12）
     created_at                   落库时间
   单位与精度：速度 **m/s**、深度 **m**，**库内存数值**（两位小数由上层换算与显示）；
   偏差允许为负。上下限绝对值＝典型值 ± 偏差，由服务层换算（server/services/standard.js）。 */
CREATE TABLE IF NOT EXISTS standard (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_code      TEXT NOT NULL,
  process_code      TEXT NOT NULL DEFAULT '',    -- 工序号；'' = 该产品通用
  version_no        INTEGER NOT NULL,            -- 版本号（同 产品+工序 内从 1 起）
  depth_upper_dev   REAL,                        -- 深度上偏差（m，默认正）
  depth_lower_dev   REAL,                        -- 深度下偏差（m，默认负）
  depth_typical     REAL,                        -- 深度典型值（m，只显示）
  speed_upper_dev   REAL,                        -- 速度上偏差（m/s，默认正）
  speed_lower_dev   REAL,                        -- 速度下偏差（m/s，默认负）
  speed_typical     REAL,                        -- 速度典型值（m/s，只显示）
  effective_from    TEXT NOT NULL,               -- 生效时间（yyyy-MM-dd HH:mm:ss）
  created_by        TEXT,                        -- 录入人
  team_code         TEXT,                        -- 班组编号（取当前生效班次）
  created_at        TEXT NOT NULL,
  UNIQUE(product_code, process_code, version_no) -- 唯一键：追加式，同版本号不得重复
);
-- 取「指定时刻生效版本」的查询索引：WHERE product_code=? AND process_code=? AND effective_from<=? ORDER BY effective_from DESC, version_no DESC
CREATE INDEX IF NOT EXISTS ix_standard_pair ON standard(product_code, process_code, effective_from DESC);
CREATE INDEX IF NOT EXISTS ix_standard_product ON standard(product_code, effective_from);
/* ⚠ 旧库兼容（V1.33 之前的 `standard` 只有 set_depth/set_gain/set_frame_rate/set_shutter，无工序与版本号）：
   那是**不兼容的结构变更**，光靠 `CREATE TABLE IF NOT EXISTS`（对旧表是空操作）升不上来，必须重建表。
   SQLite 写不出"条件 DDL"（`ALTER TABLE ... RENAME` 没有 `IF EXISTS`；`RAISE()` 只能出现在触发器体内；
   临时触发器守卫又要内层事务，会与外层事务冲突 —— 三条路都已实测不通），**所以重建不写在本文件里**，
   而是由 `server/db/index.js` 的 `initSchema()` 按结构判据显式执行（见那边的 `migrateLegacyStandard()`）：
   判据成立才重建、重建后判据不再成立 ⇒ 天然幂等；`schema.sql` 只负责**新建库的结构正本**。
   这一段旧库重建曾被误写在 schema.sql 里按"每次执行"跑，实测后果是**每次 initSchema 都把真实版本行
   换成占位行**（追加式模型下等于静默毁数据），已改掉 —— 详情见本次交付说明。 */

/* ---------------- DR-04 实测数据表（高频时序；DR-13 去重键） ----------------
   注意：只落 1 s 采样；500 ms 原始帧**只进内存不落库**（ADR-0001 D7）
   列序依据**需求 V1.41 §7 DR-04 的字段次序**（`procOrderNo、件序号 unit_index、depth、speed…`），
   故 `unit_index` 紧邻 `proc_order_no`：落库口 `server/repo/measure.js` 的 `toParams()`/`INSERT_SQL`
   是**按位置**绑定的，两处必须与下面这段逐位一致（错位会静默写错列）。 */
CREATE TABLE IF NOT EXISTS measure_rt (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  equip_code    TEXT NOT NULL,
  proc_order_no TEXT NOT NULL,
  unit_index    INTEGER,                         -- 件序号（＝IF-D.4 的 unitIndex；**采集落库时写入**，V1.41 / C-111）
                                                 --   帧未带 / 非法（非整数、<1）⇒ NULL ＝"拿不到"，**不得用 0/1 代言**
                                                 --   真实字段名与取值域待 Q-21 答复
  measure_depth REAL,                            -- 航行器水下深度 depth（≠ 相机深度）
  speed         REAL,
  velocity_x    REAL,
  velocity_y    REAL,
  frame_rate    INTEGER,
  gain          REAL,
  shutter       INTEGER,
  camera_depth  REAL,                            -- 相机自身水下深度 cameraDepth
  test_status   INTEGER,                         -- 0 待机 / 1 测试中 / 2 测试完成 / 3 设备异常
  collect_time  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
-- DR-13：以 equipCode + procOrderNo + collectTime 为去重键
CREATE UNIQUE INDEX IF NOT EXISTS ux_measure_rt ON measure_rt(equip_code, proc_order_no, collect_time);
CREATE INDEX IF NOT EXISTS ix_measure_rt_task_time ON measure_rt(proc_order_no, collect_time);
/* 旧库兼容（V1.41 之前建的库，`measure_rt` 没有 `unit_index` 列）：该列**允许 NULL**
   ⇒ 既有行天然合法、**不需要任何数据回填**（一行都不 UPDATE）。但 SQLite 的
   `CREATE TABLE IF NOT EXISTS` 对**已存在的旧表是空操作**、列不会凭空出现（且 SQLite 写不出
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`），故旧库的补列交给 `server/db/index.js` 的
   `STRUCTURE_UPGRADES`（`SCHEMA_VERSION` 驱动的幂等升级步骤，与 `op_log.team_code` 同一先例）。
   分工与本仓既有一致：**schema.sql 描述新建库的结构正本，升级动作由读取它的那个模块统一执行**。
   为什么必须补：不补列时老库上带 `unit_index` 的落库语句会报
   `table measure_rt has no column named unit_index` ⇒ 采集链整条断（每一帧都失败），
   而不是"少记一个件序号"这种可容忍的降级。 */

/* ---------------- DR-05 测试结果表 ---------------- */
CREATE TABLE IF NOT EXISTS result (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  proc_order_no TEXT NOT NULL,
  unit_index    INTEGER NOT NULL DEFAULT 1,      -- 第几件（按件固化，DR-19）
  result        TEXT NOT NULL,                   -- 待测试/测试中/合格/不合格/待复检
  judged_at     TEXT,
  retest_count  INTEGER NOT NULL DEFAULT 0,      -- 复检次数
  duration_sec  INTEGER,                         -- 单件测试时长（秒）
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_result_unit ON result(proc_order_no, unit_index);
CREATE INDEX IF NOT EXISTS ix_result_result ON result(result, judged_at);

/* ---------------- DR-06 班次统计表（班次结束时固化） ---------------- */
CREATE TABLE IF NOT EXISTS shift_stat (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_date    TEXT NOT NULL,                   -- 班次日期（跨零点按班次归属规则）
  shift_name    TEXT NOT NULL,                   -- 早班/中班/晚班
  plan_qty      INTEGER NOT NULL DEFAULT 0,
  started_qty   INTEGER NOT NULL DEFAULT 0,
  finished_qty  INTEGER NOT NULL DEFAULT 0,
  qualified_qty INTEGER NOT NULL DEFAULT 0,
  failed_qty    INTEGER NOT NULL DEFAULT 0,
  retest_qty    INTEGER NOT NULL DEFAULT 0,
  pass_rate     REAL,                            -- 一次性测试合格率
  run_sec       INTEGER NOT NULL DEFAULT 0,      -- 有效运行时长
  idle_sec      INTEGER NOT NULL DEFAULT 0,      -- 待机时长
  oee           REAL,                            -- 稼动率
  frozen_at     TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_shift_stat ON shift_stat(shift_date, shift_name);

/* ---------------- DR-07 异常台账表 ---------------- */
CREATE TABLE IF NOT EXISTS alarm (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  alarm_code    TEXT NOT NULL,
  alarm_type    TEXT,
  level         TEXT,                            -- 故障等级（来自故障字典）
  occurred_at   TEXT NOT NULL,                   -- 发生时间（秒级）
  brief         TEXT,                            -- 故障简述
  action        TEXT,                            -- 处理建议（字典）
  close_state   TEXT NOT NULL DEFAULT '未处理',   -- 未处理/处理中/已闭环/复检确认中
  handler       TEXT,                            -- 处理人
  handled_at    TEXT,
  closed_at     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_alarm_occurred ON alarm(occurred_at);
CREATE INDEX IF NOT EXISTS ix_alarm_state ON alarm(close_state);

/* ---------------- DR-08 预警记录表 ---------------- */
CREATE TABLE IF NOT EXISTS warning (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  warn_type     TEXT NOT NULL,                   -- 参数临近/维保到期/耗材更换/工单超时
  trigger_cond  TEXT,                            -- 触发条件描述
  triggered_at  TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT '未处理',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_warning_time ON warning(triggered_at);

/* ---------------- DR-09 维保记录表 ---------------- */
CREATE TABLE IF NOT EXISTS maintenance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT '检修',     -- 检修 / 周期维保
  content       TEXT NOT NULL,                   -- 检修内容
  maint_time    TEXT NOT NULL,                   -- 检修时间
  handler       TEXT,                            -- 责任人员
  accept_state  TEXT,                            -- 验收状态
  cycle_days    INTEGER,                         -- 维保周期（可配）
  next_due_at   TEXT,                            -- 下次维保时间
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_maintenance_time ON maintenance(maint_time);

/* ---------------- DR-10 公告信息表 ---------------- */
CREATE TABLE IF NOT EXISTS notice (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category      TEXT NOT NULL,                   -- 车间公告/工艺提示/待办提醒
  sub_type      TEXT,                            -- 生产调整/工艺变更/临时管控/公示 …
  content       TEXT NOT NULL,
  valid_from    TEXT,
  valid_to      TEXT,
  priority      INTEGER NOT NULL DEFAULT 0,      -- 越大越优先（FR-7.11）
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notice_valid ON notice(valid_from, valid_to);

/* ---------------- DR-11 MES 上传日志表（去重与追溯） ----------------
   本表同时是**上报失败待补传队列的持久化载体**（技术债 E10 / IF-B.9 / NFR-13）：
   上报失败的报文以 state = '待补传' 落在这里，进程重启后按 `state IN ('待补传','失败')`
   读回补齐清单（读写实现见 server/repo/uploadQueue.js、server/services/uploadQueue.js）。 */
CREATE TABLE IF NOT EXISTS upload_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id     TEXT NOT NULL,                   -- 幂等键（MES 去重、回执核对）
  interface     TEXT NOT NULL,                   -- 接口名（serviceName/methodName）
  request_body  TEXT,                            -- 请求报文（JSON 文本）
  response_code TEXT,                            -- 响应码
  response_body TEXT,                            -- 响应报文
  elapsed_ms    INTEGER,                         -- 耗时
  retry_count   INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL,                   -- 成功 / 失败 / 待补传
  created_at    TEXT NOT NULL,
  fail_reason   TEXT,                            -- E10：失败原因（人工重报清单要看"为什么失败"）
  updated_at    TEXT                             -- E10：最近一次状态变更时间（重报成功/仍失败均刷新）
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_upload_log_id ON upload_log(upload_id, interface);
CREATE INDEX IF NOT EXISTS ix_upload_log_state ON upload_log(state, created_at);

/* ---------------- DR-12 操作日志表（解锁后写操作留痕） ----------------
   `team_code`（班组编号）＝ V1.33 增列：留痕要能回答"**哪个班组**在什么时候改了什么"。
   来源**唯一**：录入时**当前生效班次**的班组，与 FR-1.6（看板头部"所属班组"）**同一真源**
   —— `src/config/board.config.js` 的 `shift.roster.team`（联调后由 MES 人员班组资质接口提供）。
   本表只存值、不自己推导班组（仓储层写入见 server/repo/opLog.js）；
   禁止另起一套"按操作人姓名反查班组"之类的来源，否则审计口径会与头部显示分裂。 */
CREATE TABLE IF NOT EXISTS op_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  op_time       TEXT NOT NULL,
  operator      TEXT,                            -- 操作人
  op_type       TEXT NOT NULL,                   -- 维保录入/公告发布/异常闭环/参数配置/解锁/标准录入 …
  content       TEXT,                            -- 操作内容
  result        TEXT,                            -- 成功/失败
  team_code     TEXT,                            -- 班组编号（取当前生效班次，与 FR-1.6 同一真源）
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_op_log_time ON op_log(op_time);
/* 旧库兼容：V1.33 之前的 op_log 无 `team_code` 列。这里**故意不是**纯 DDL 幂等语句 ——
   SQLite 不支持 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（已实测：`near "EXISTS": syntax error`），
   `CREATE TABLE IF NOT EXISTS` 对旧表又是空操作、列不会凭空出现。因此 `team_code` 的补齐
   交给 `server/db/index.js` 的 `initSchema()`：它在执行完本文件后跑一小段**幂等升级步骤**
   （`ALTER TABLE op_log ADD COLUMN team_code TEXT`，已存在时吞掉 `duplicate column name`）。
   这与本仓既有分工一致：schema.sql 描述**结构正本**（新建库/新表），`SCHEMA_VERSION` 驱动的
   升级动作由读取 schema 的那个模块统一执行。相关索引也放在升级步骤里建（旧表补列前建会报错）。 */

/* ---------------- DR-18 任务曲线表（每完成一件固化一条完整曲线） ----------------
   samples 以 JSON 数组存采样序列（实测 160 点约 915 字节，见 ADR-0001 附件） */
CREATE TABLE IF NOT EXISTS task_curve (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  proc_order_no TEXT NOT NULL,
  unit_index    INTEGER NOT NULL DEFAULT 1,      -- 件号
  kind          TEXT NOT NULL,                   -- depth / speed
  samples       TEXT NOT NULL,                   -- JSON 数组（按 1 s 采样）
  sample_count  INTEGER NOT NULL,
  interval_sec  REAL NOT NULL DEFAULT 1,         -- 采样间隔（秒）
  duration_sec  REAL NOT NULL,                   -- 任务时长（秒）
  min_value     REAL,                            -- 量程下限（图下标注）
  max_value     REAL,                            -- 量程上限
  finished_at   TEXT NOT NULL,                   -- 任务完成时间
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_curve ON task_curve(proc_order_no, unit_index, kind);
CREATE INDEX IF NOT EXISTS ix_task_curve_finished ON task_curve(finished_at);

/* ---------------- NFR-14 / FR-8.4 设置页口令凭证表 ----------------
   只存派生值与状态，**永不存明文**；本轮只有一行 username='admin'（设置页口令），
   唯一键按 username 设计，为将来"操作人/管理员分权"留位，不提前实现。 */
CREATE TABLE IF NOT EXISTS auth_credential (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL,                   -- 本轮恒为 'admin'
  algo         TEXT NOT NULL,                   -- 'scrypt'
  params       TEXT NOT NULL,                   -- 'N=16384,r=8,p=1,keylen=32'
  salt         TEXT NOT NULL,                   -- 16 字节随机盐（hex）
  hash         TEXT NOT NULL,                   -- 派生密钥（hex）
  fail_count   INTEGER NOT NULL DEFAULT 0,      -- 连续失败次数（落库 ⇒ 重启不清零）
  locked_until TEXT,                            -- 锁定截止（本机时间文本，DR-16；NULL=未锁定）
  is_initial   INTEGER NOT NULL DEFAULT 0,      -- 1=由初始化码设置、人工尚未改过
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  changed_by   TEXT,
  team_code    TEXT,                            -- 与 op_log 同源：改密时当前生效班次的班组
  UNIQUE(username)
);
