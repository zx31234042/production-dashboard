-- ==========================================================================
-- 看板本地库表结构（server/db/schema.sql）
-- 依据：需求清单 V1.28 第 7 章「数据需求」DR-01～DR-19
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

/* ---------------- DR-03 测试标准表（设备参数类阈值，来源 IF-A 工艺信息） ---------------- */
CREATE TABLE IF NOT EXISTS standard (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_code    TEXT NOT NULL,
  set_depth       REAL,                          -- 相机设定深度（设备参数，次要展示）
  set_gain        REAL,
  set_frame_rate  INTEGER,
  set_shutter     INTEGER,
  effective_from  TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_standard_product ON standard(product_code, effective_from);

/* ---------------- DR-04 实测数据表（高频时序；DR-13 去重键） ----------------
   注意：只落 1 s 采样；500 ms 原始帧**只进内存不落库**（ADR-0001 D7） */
CREATE TABLE IF NOT EXISTS measure_rt (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  equip_code    TEXT NOT NULL,
  proc_order_no TEXT NOT NULL,
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

/* ---------------- DR-12 操作日志表（解锁后写操作留痕） ---------------- */
CREATE TABLE IF NOT EXISTS op_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  op_time       TEXT NOT NULL,
  operator      TEXT,                            -- 操作人
  op_type       TEXT NOT NULL,                   -- 维保录入/公告发布/异常闭环/参数配置/解锁 …
  content       TEXT,                            -- 操作内容
  result        TEXT,                            -- 成功/失败
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_op_log_time ON op_log(op_time);

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
