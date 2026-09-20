/* ==========================================================================
   需求追溯自检（tests/trace-check.js）
   作用：建立「需求清单条款 → 承接证据」的追溯关系，把"间接验证"也计入可追溯覆盖，
         并强制每一条条款都有明确状态（没有归属的条款即报 FAIL，防止覆盖情况含糊）。
         追溯表内嵌在本文件的 MAP 中：每条 = [条款匹配, 状态, 证据脚本, 证据文本]
         条款匹配支持：精确 ID、逗号分隔多 ID、`FR-1.*` 通配（匹配该前缀全部条款）
   依赖：仅 Node 内置模块。
   运行：node tests/trace-check.js（可选 --list 打印每条条款的归属）
   退出码：0 = 追溯表完整且证据有效；1 = 有未归属条款或证据失效。
   状态词表：
         covered-direct    门禁里有直接断言（断言名或注释含该条款编号）
         covered-indirect  由其他断言间接覆盖（组件渲染、流程行为等），证据指向具体断言
         fix-pending       已确认缺陷、待修（对应《审查报告-2026-09-19》的缺陷清单）
         declared-gap      Demo 明确不做且已在 README「已知限制」登记
         backend-phase     属后端/部署/目标硬件阶段，纯前端 Demo 无法验证
         manual            需人工判断（观感、编码规范等）
         subjective        主观项（动效、防烧屏等）
         out-of-scope      已声明不在本期范围
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const env = require('./env');
env.assertRuntime();

const ROOT = path.resolve(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const LIST = process.argv.includes('--list');

/* ---------------- 追溯表 ---------------- */
const MAP = [
  /* FR-1 头部基础信息 */
  ['FR-1.*', 'covered-direct', 'ui-check.js', 'FR-1.1～1.10 头部十项均渲染出非空值'],

  /* FR-2 设备实时运行状态 */
  ['FR-2.1,FR-2.3,FR-2.5,FR-2.8', 'covered-direct', 'ui-check.js', 'FR-2.1 设备状态页列出 5 种运行模式色标'],
  ['FR-2.2', 'manual', '', '状态→颜色映射（绿/黄/红/灰）须人工核对观感；原证据为"UI-04 字号"，与颜色标识无关（2026-09-19 改判）'],
  ['FR-2.4,FR-2.7', 'covered-indirect', 'ui-check.js', 'UI-08 深度与速度数值格式统一'],
  ['FR-2.6', 'covered-direct', 'browser-check.js', '?link=off 进入降级态'],

  /* FR-3 实时测试任务数据 */
  ['FR-3.1,FR-3.2,FR-3.3,FR-3.4', 'covered-indirect', 'ui-check.js', '当前工单信息渲染 8 项'],
  ['FR-3.5,FR-3.6,FR-3.7,FR-3.8', 'covered-indirect', 'ui-check.js', '超阈值判定：帧率超标、增益临近'],
  ['FR-3.16', 'covered-direct', 'copy-check.js', '设备参数次要展示区用词：实时帧率 / 相机增益 / 快门速度 / 相机水下深度'],
  ['FR-3.9,FR-3.10,FR-3.11,FR-3.12', 'covered-indirect', 'ui-check.js', '深度与速度数值格式统一'],
  ['FR-3.13', 'covered-indirect', 'ui-check.js', '单任务五态在模拟数据中可达'],
  ['FR-3.14', 'covered-direct', 'ui-check.js', 'FR-3.14 超阈值判定'],
  ['FR-3.15', 'backend-phase', '', '曲线"按任务完成刷新一次"需服务端固化流程（DR-19）+ 任务完成事件，纯前端 Demo 只有一个节拍，无法验证刷新时机'],
  ['FR-3.17', 'covered-indirect', 'ui-check.js', '无在测工单时应显示'],

  /* FR-4 当班生产统计
     2026-09-19：服务层 services/stats.js 落地后，15 项指标改为由逻辑层断言逐项承接
     （此前只靠"StatsPanel 写入 15 个指标"的界面断言间接覆盖）。 */
  ['FR-4.1,FR-4.4,FR-4.5,FR-4.6,FR-4.7,FR-4.8,FR-4.9,FR-4.10,FR-4.11,FR-4.12,FR-4.13,FR-4.14,FR-4.15', 'covered-indirect', 'logic-check.js', '三、15 项当班指标'],
  ['FR-4.2', 'covered-direct', 'ui-check.js', 'FR-4.2/4.3 实际开工数不得超过计划总数'],
  ['FR-4.3', 'covered-indirect', 'logic-check.js', '开工数超过计划时，未开工封顶为 0（不出现负数）'],
  ['FR-4.16', 'covered-direct', 'logic-check.js', '班次边界自动切换与跨零点归属（FR-4.16）'],
  ['FR-4.17', 'subjective', '', '数值变化增速高亮属动效，需人工评估'],

  /* FR-5 设备异常与预警
     2026-09-19（P2-9～12）：这批证据原为"无故障时占位文案"（**断言的是反面**）与"现状快照/常量集中化"
     （与条款无关）。已在 ui-check 的 U3b 段补**有故障、有台账**的真实断言，证据改指它们。 */
  ['FR-5.1,FR-5.2,FR-5.3,FR-5.4', 'covered-direct', 'ui-check.js', 'FR-5.1 报警卡显示报警编号与类型'],
  ['FR-5.5,FR-5.7', 'declared-gap', '', 'README 已知限制 3：报警以卡片+横幅呈现，未实现弹窗动画'],
  ['FR-5.6', 'covered-direct', 'ui-check.js', 'FR-5.6 多条并发报警时排队说明与队列列表都渲染'],
  ['FR-5.8,FR-5.9,FR-5.10,FR-5.11', 'covered-direct', 'ui-check.js', 'FR-5.8～5.11 预防性预警区按字典渲染标题与详情'],
  ['FR-5.12,FR-5.13,FR-5.14', 'covered-direct', 'ui-check.js', 'FR-5.12/FR-5.13/FR-5.14 当班异常台账按行渲染'],

  /* FR-6 维保台账
     2026-09-19（P2-11）：原 7+2 条共用"15 个指标全部由 StatsPanel 写入"—— 那条断言只遍历生产统计的
     15 个 s* 元素，与维保台账/进度条/检修表**毫无关系**。已补 MaintPanel 的真实断言（U3b 段）。 */
  ['FR-6.1,FR-6.2,FR-6.3', 'covered-direct', 'ui-check.js', 'FR-6.1/FR-6.2 维保周期台账渲染出三行'],
  ['FR-6.4,FR-6.5,FR-6.6', 'covered-direct', 'ui-check.js', 'FR-6.4/FR-6.5/FR-6.6 距离下次维保天数渲染为'],
  ['FR-6.7,FR-6.8,FR-6.9', 'covered-direct', 'ui-check.js', 'FR-6.7/FR-6.8/FR-6.9 三项累计运行都有**真实格式值**'],
  ['FR-6.10', 'covered-direct', 'ui-check.js', 'FR-6.10 检修记录表按行渲染'],
  ['FR-6.11', 'covered-direct', 'browser-check.js', '?unlock=1 启动即解锁'],
  ['FR-6.12', 'backend-phase', '', '累计运行与实际数据对账需真实数据源'],

  /* FR-7 公告与备注 */
  ['FR-7.1,FR-7.2,FR-7.3,FR-7.4,FR-7.5,FR-7.6,FR-7.7,FR-7.8,FR-7.9', 'covered-indirect', 'contract-check.js', '公告正文（用户输入）不得原样写入 HTML'],
  ['FR-7.10', 'covered-indirect', 'contract-check.js', '待办"未闭环异常"的判据不得比较一个永不出现的状态值'],
  ['FR-7.11', 'declared-gap', '', 'README 已知限制 8：本期只做发布与展示，编辑/删除与有效期/轮播留待实施阶段（2026-09-19 已补登记，P3-11）'],
  ['FR-7.12', 'covered-direct', 'contract-check.js', '检修内容/负责人（用户输入）不得原样写入 HTML'],

  /* FR-8 系统设置 */
  ['FR-8.1', 'covered-direct', 'browser-check.js', '?unlock=1 启动即解锁'],
  ['FR-8.2', 'covered-indirect', 'ui-check.js', 'FR-8.2 解锁状态超时'],
  ['FR-8.3,FR-8.4', 'declared-gap', '', 'README 已知限制 1：前端明文密码，正式实现须服务端校验与哈希'],
  ['FR-8.5,FR-8.6', 'covered-indirect', 'ui-check.js', 'FR-8.6 设置页提供关键参数配置入口'],
  ['FR-8.7', 'covered-indirect', 'ui-check.js', 'FR-8.7 / NFR-15 解锁后的写操作留痕'],

  /* FR-9 页面与交互 */
  ['FR-9.1,FR-9.3', 'covered-direct', 'browser-check.js', '切换 8 个标签页'],
  ['FR-9.2', 'covered-indirect', 'browser-check.js', '默认首页是「设备状态」'],
  ['FR-9.4', 'covered-direct', 'browser-check.js', '快进 200 秒后自动回到'],
  ['FR-9.5', 'declared-gap', '', 'README 已知限制 11：标签页未做自动轮播；路线图技术债 E3（2026-09-19 补登记，P3-11）'],
  ['FR-9.6', 'covered-indirect', 'ui-check.js', '单次 tick + 10 个组件全量重绘耗时'],
  ['FR-9.7', 'covered-indirect', 'ui-check.js', 'FR-9.7 大屏交互屏蔽'],
  ['FR-9.8', 'covered-indirect', 'ui-check.js', 'UI-04 字号：'],   /* 大屏远距离可读性：字号下限断言是直接证据；有线键鼠支持另见 ENV-13（属硬件） */

  /* FR-10 历史查询与报表（已声明不在 Demo 范围） */
  ['FR-10.*', 'out-of-scope', '', 'README：未包含历史查询与报表导出（P1，需后端）'],

  /* UI 界面需求 */
  ['UI-01,UI-02,UI-03,UI-04', 'covered-direct', 'ui-check.js', 'UI-03 色彩规范'],
  ['UI-05', 'subjective', '', '颜色+文字+图标三重编码需人工观感确认'],
  ['UI-06,UI-07', 'covered-direct', 'ui-check.js', 'FR-6.1/FR-6.2 维保周期台账渲染出三行'],
  ['UI-08', 'covered-direct', 'ui-check.js', 'UI-08 深度与速度数值格式统一'],
  ['UI-09,UI-18', 'subjective', '', '动效与防烧屏需人工评估'],
  ['UI-10', 'covered-direct', 'browser-check.js', '?link=off 进入降级态'],
  ['UI-11', 'covered-indirect', 'ui-check.js', 'UI-11 无公告/无提示/无待办时应给出占位文案'],
  ['UI-12', 'manual', '', '字体规范（思源黑体/微软雅黑 + 等宽）需人工核对，暂无断言'],
  ['UI-13', 'declared-gap', '', 'README 已知限制 3：报警弹窗未实现'],
  ['UI-14', 'covered-indirect', 'ui-check.js', 'UI-04 字号：'],
  ['UI-15', 'covered-indirect', 'browser-check.js', '?curve=none 显示空态且不画曲线'],
  ['UI-16', 'manual', '', '界面语言为简体中文，需人工核对'],
  ['UI-17', 'covered-direct', 'browser-check.js', '页脚显示版本号与最后刷新时刻'],
  ['UI-19', 'covered-indirect', 'browser-check.js', '?curve=none 显示空态且不画曲线'],

  /* IF 接口需求 */
  ['IF-A.*', 'backend-phase', '', 'IF-A 需看板服务端接收端点，纯静态 Demo 无服务端'],
  ['IF-B.1,IF-B.2,IF-B.3,IF-B.4,IF-B.5,IF-B.6,IF-B.7,IF-B.10', 'backend-phase', '', '需真实 MES 接口与日志留存（DR-11）'],
  ['IF-B.8', 'covered-direct', 'contract-check.js', '上报报文含附录 2 全部 13 个字段'],
  ['IF-B.9', 'covered-indirect', 'contract-check.js', '补传：链路恢复后 flushPending 补齐队列'],
  ['IF-C.1', 'covered-direct', 'contract-check.js', 'fieldMap.boardToReport 的字段名与附录 2 完全一致'],
  ['IF-C.2,IF-C.3,IF-C.4,IF-C.5,IF-C.6,IF-C.7,IF-C.9', 'covered-indirect', 'docs-check.js', 'MES 澄清函覆盖附录 2 的全部上报字段'],
  ['IF-C.8', 'manual', '', '字段命名风格混用属文档约定，需人工确认'],
  ['IF-D.1', 'covered-direct', 'contract-check.js', 'fieldMap 映射的报文键'],
  ['IF-D.2,IF-D.3,IF-D.4,IF-D.5,IF-D.6,IF-D.8,IF-D.11,IF-D.13', 'covered-indirect', 'contract-check.js', '上报报文含附录 2 全部 13 个字段'],
  ['IF-D.7', 'backend-phase', '', '传输方式（推送/长连接）待与上位机方确认（Q-21）'],
  ['IF-D.9', 'covered-indirect', 'contract-check.js', '数据冻结时界面判据 state.device.link 转为断连'],
  ['IF-D.10,IF-D.12', 'backend-phase', '', '补发落库与编号传递方式需后端与 Q-21 结论'],
  ['IF-E.1,IF-E.2', 'backend-phase', '', '本地推送端点（SSE）与本地 Web API，属后端阶段'],
  /* 2026-09-19（P3-9）：IF-E.3（事务与并发读写）**已有断言**（db-check 的批量事务整批回滚 +
     WAL 生效 + busy_timeout），不再整段归 backend-phase。 */
  ['IF-E.3', 'covered-indirect', 'db-check.js', '批量事务中某行失败 → 整批回滚（无部分写入）'],
  ['IF-0.*', 'backend-phase', '', '通用传输规范（鉴权/请求方式）待 Q-23 收口'],

  /* DR 数据需求 —— 2026-09-19 数据层落地后按"有实证承接"逐条登记（原为整段 backend-phase）
     证据来自 tests/db-check.js 的章节与断言名；断言文本必须能在该脚本里找到（本脚本会校验）。 */
  ['DR-01,DR-02,DR-03,DR-05,DR-06,DR-07,DR-08,DR-09,DR-10,DR-12,DR-18', 'covered-indirect', 'db-check.js', '一、建表与结构（DR-01～DR-12、DR-18）'],
  ['DR-04', 'covered-indirect', 'db-check.js', '相机深度与航行器深度分列存放'],
  ['DR-11', 'covered-indirect', 'db-check.js', '附录 2 的 13 个上报字段都有落库列（uploadId 落 upload_log）'],
  ['DR-13', 'covered-indirect', 'db-check.js', '三、写入与去重键（DR-13）'],
  ['DR-14', 'covered-indirect', 'db-check.js', '八、数据保留策略（DR-14）'],
  ['DR-15', 'covered-indirect', 'db-check.js', '七、备份与校验（DR-15 / DEP-08）'],
  ['DR-17', 'covered-indirect', 'logic-check.js', '累计运行持久化：重启不倒退、跨班次不清零（DR-17）'],
  ['DR-19', 'covered-indirect', 'db-check.js', '六、任务曲线按件固化（DR-18 / DR-19）'],
  /* 2026-09-19（P3-9）：DR-16 的**格式**部分已可断言（`platform/clock.js` 的 fmt + 入库校验），
     故由 backend-phase 改判；NTP 同步精度仍属现场。 */
  ['DR-16', 'covered-indirect', 'db-check.js', 'P2-5：collectTime 非「yyyy-MM-dd HH:mm:ss」一律拒收'],

  /* ENV 运行环境与显示约束 —— 2026-09-19 补齐归属（此前整段被正则漏掉）
     2026-09-19（P2-9）：这四条原来**全部**指向 ui-check 的"UI-04 字号："—— 其中只有 ENV-03 沾边，
     ENV-01/02/04 在目标脚本里根本查不到对应断言。现按子项分开：ENV-03 记 covered（字号有真断言），
     ENV-01 的 4K 舞台有断言但 30Hz 刷新率要真机，ENV-02/04 改 manual（需真机与人工观感）。 */
  ['ENV-01', 'manual', '', '4K 舞台尺寸已有断言（ui-check U1），但 30Hz 刷新能力须真机实测（ENV-06 同因）'],
  ['ENV-02', 'manual', '', '16:9 与"无滚动条"需在目标机实际分辨率下人工确认（browser-check 有 3 分辨率断言但本环境不可运行）'],
  ['ENV-03', 'covered-direct', 'ui-check.js', 'UI-04 字号：'],
  ['ENV-04', 'manual', '', '高对比/防反光须在 75 寸屏现场观感确认，属主观项'],
  ['ENV-05', 'subjective', '', '防烧屏/残影需在 75 寸屏长期观察，属主观项'],
  ['ENV-06,ENV-10', 'manual', '', 'HDMI ≥1.4 与 4K@30Hz 输出能力须现场用同规格电视实测'],
  ['ENV-07', 'manual', '', '独立专用电视为现场硬件配置，非软件可验'],
  ['ENV-08,ENV-09,ENV-11,ENV-12,ENV-13,ENV-14,ENV-16', 'backend-phase', '', '主机型号/系统版本/内存/存储/输入设备/运行时许可/缩放：属硬件与部署阶段（Q-26 我方实测）'],
  ['ENV-15', 'covered-indirect', 'docs-check.js', 'index.html 不引用任何外链资源（NFR-25 内网隔离）'],
  ['ENV-17', 'backend-phase', '', '禁用休眠/睡眠/屏保/自动更新：部署脚本阶段落实'],
  ['ENV-18', 'backend-phase', '', 'NTP 同步与 ≤1 s 时钟偏差：需现场网络与上位机/MES 联调实测'],
  ['ENV-19', 'covered-indirect', 'docs-check.js', 'index.html 不引用任何外链资源（NFR-25 内网隔离）'],
  ['ENV-20', 'backend-phase', '', '开机自启与自动拉起：属部署脚本（DEP-02/03）'],

  /* NFR 非功能需求 */
  ['NFR-01', 'covered-direct', 'ui-check.js', '单次 tick + 10 个组件全量重绘耗时'],
  ['NFR-02', 'backend-phase', '', '端到端延迟需真实链路测量'],
  ['NFR-03', 'covered-indirect', 'browser-check.js', '切换 8 个标签页'],
  ['NFR-04', 'manual', '', '开机到就绪 ≤60 s 需目标硬件实测'],
  ['NFR-05,NFR-06,NFR-07,NFR-08', 'backend-phase', '', '资源上限/72 h/30 天/真机 4K 需目标硬件'],
  ['NFR-09,NFR-10,NFR-12', 'backend-phase', '', '看门狗、断电恢复、数据库保护属后端与部署'],
  ['NFR-11', 'covered-indirect', 'ui-check.js', 'NFR-11 单一组件异常不导致整屏刷新中断'],
  ['NFR-13', 'covered-indirect', 'contract-check.js', '补传：链路恢复后 flushPending 补齐队列'],
  ['NFR-14', 'declared-gap', '', 'README 已知限制 1：口令哈希与错误次数限制待服务端实现'],
  ['NFR-15', 'covered-indirect', 'ui-check.js', 'FR-8.7 / NFR-15 解锁后的写操作留痕'],
  ['NFR-16', 'covered-indirect', 'docs-check.js', 'index.html 不引用任何外链资源'],
  ['NFR-17,NFR-18', 'backend-phase', '', '接口鉴权与凭证管理属后端'],
  ['NFR-19', 'covered-indirect', 'contract-check.js', '字段映射可配置：改 fieldMap 的 key 后按新字段名取值'],
  ['NFR-20', 'out-of-scope', '', '不提供远程操控即满足（无需实现）'],
  ['NFR-21', 'backend-phase', '', '日志分级与滚动属后端'],
  ['NFR-22', 'manual', '', '主题/字段增减可配需人工确认覆盖范围'],
  ['NFR-23', 'out-of-scope', '', '多设备扩展属预留能力，本期不实现'],
  ['NFR-24', 'backend-phase', '', '兆芯平台兼容性需目标硬件实测'],
  ['NFR-25', 'covered-direct', 'docs-check.js', 'index.html 不引用任何外链资源（NFR-25 内网隔离）'],
  ['NFR-26', 'covered-indirect', 'contract-check.js', '自检「MES 上报队列」应与实际待补传条数一致'],
  ['NFR-27', 'covered-indirect', 'browser-check.js', '页脚显示版本号与最后刷新时刻'],

  /* DEP 部署与运维需求
     2026-09-19（P3-8）：原整段 `backend-phase` 不准确 —— 其中**文档交付物**与**商务/现场条款**
     不是"后端阶段"，`DEP-08` 的自动备份更是**已在 maintain.js 实现**（db-check 有断言）。
     故按性质拆开登记。 */
  ['DEP-01', 'backend-phase', '', 'Windows 安装包（含运行环境依赖）属部署阶段'],
  ['DEP-02,DEP-03,DEP-04,DEP-05,DEP-06', 'backend-phase', '', '自启/服务注册/系统配置/固定 IP/端口清单属部署阶段（D12、Q-26）'],
  ['DEP-07', 'declared-gap', '', '部署手册/运维手册/故障排查手册为**文档交付物**，尚未编写（非后端阶段；见后续路线图）'],
  /* DEP-08：自动备份与恢复已有实现与断言；"恢复说明"文档部分另计 */
  ['DEP-08', 'covered-indirect', 'db-check.js', '七、备份与校验（DR-15 / DEP-08）'],
  ['DEP-09,DEP-10,DEP-11', 'backend-phase', '', '磁盘监控告警、断电恢复、版本回滚属部署与运维阶段'],
  ['DEP-12,DEP-13,DEP-14,DEP-15', 'declared-gap', '', '现场实施清单 / 技术支持方式 / 质保与响应时效 / 三方联调计划：均属**商务与现场条款**，非软件可验证（现场实施与合同阶段落实）']
];

/* ---------------- AC 验收标准追溯表（AC-01～AC-12） ----------------
   ⚠️ **AC 走独立分母，绝不并入上面的 256 条**：需求 §0.2（`需求文档\…V1.30.md:153`）已声明
   AC「**不计入上方需求条款合计**（验收口径，非功能条目；重复计入会与"每条条款都有归属"的追溯分母冲突）」。
   故本表的归属**只进"AC 覆盖 X / 12"这一行**，`可追溯覆盖合计 X / 256` 的分子分母一律不受影响。
   条目格式与 MAP 完全一致：[AC 编号, 状态, 证据脚本, 证据文本]；状态词表沿用本文件头部。
   **证据纪律**：本表只登记**现有**证据，不刷覆盖率 —— 没有对应断言的一律 `script: ''`，
   并在第 5 列写明"为什么没有"；把 8 小时当 7 天、把 SKIP 当通过都属不合格（见 AC-07 / AC-12）。
   立案：架构评审报告 A-2026-09-20-01 的 P1-2（`项目记录\架构评审报告-2026-09-20-01.md:69`–`76`）。 */

/**
 * 全部 AC 验收标准（AC-01～AC-12），取自需求清单的表格行。
 * ⚠️ 与 `requirementClauses()` **故意分开**：那个函数的口径是 §0.2 的 256 条需求条款，
 *    AC 不在其中；混进去就不是"顺带补覆盖"，而是把验收口径并进需求分母（§0.2 明令禁止）。
 * ⚠️ AC 表的列是「编号 / 验收项 / 判定标准」**三列**，判定标准在**第 3 格**（第 2 格是"稳定性测试"这类名称）。
 *    取错格会让下面的 AC-07 专项断言读到空串（实测踩过：写 `([^|]*)` 取到的是"稳定性测试"）。
 * @returns {Map<string,string>} AC 编号 → 判定标准摘要（压平换行与多余空格，截 60 字）
 */
function acceptanceCriteria() {
  const file = fs.readdirSync(path.join(ROOT, '需求文档')).find(f => f.endsWith('.md'));
  const lines = fs.readFileSync(path.join(ROOT, '需求文档', file), 'utf8').split('\n');
  const map = new Map();
  for (const l of lines) {
    const m = l.match(/^\|\s*(AC-\d+)\s*\|\s*([^|]*)\|\s*([^|]*)\|/);
    if (m) map.set(m[1], m[3].trim().replace(/\s+/g, ' ').slice(0, 60));
  }
  return map;
}

/** AC 追溯表（见上方口径说明） */
const AC_MAP = [
  /* ——— 有机器证据可复跑的一类 ——— */
  ['AC-03', 'covered-indirect', 'ui-check.js', '单次 tick + 10 个组件全量重绘耗时',
    'NFR-01/NFR-02 的"秒级刷新"侧：ui-check 实测单次 tick + 10 个组件全量重绘 < 200 ms（实跑约 0.1 ms，见 tests\\README.md:190），1 秒周期余量充足；但"状态与参数秒级刷新"的端到端时延与时钟推进本身要真机/浏览器（stress-check 的"时钟持续推进"断言在本环境整脚本跳过），故记间接。'],
  ['AC-06', 'covered-direct', 'contract-check.js', '数据冻结时界面判据 state.device.link 转为断连',
    '断链降级判据有直接断言：数据冻结后 state.device.link 转 offline；补收/补传由 flushPending 补齐队列（contract-check）+ 重开后行数不变且去重键仍生效（db-check）承接。界面横幅与离线文案由 browser-check 断言（本环境不可复跑）。'],
  ['AC-08', 'covered-direct', 'ui-check.js', 'FR-5.4 报警卡显示闭环状态',
    '故障→报警→处理→闭环的界面链路：报警编号/类型、描述与处理信息（发生时间/等级/处理人/处理措施）、闭环状态均按行断言，且当班异常台账接收新闭环报警（contract-check）。"留痕可追溯"的**存储侧**需后端/部署阶段。'],
  ['AC-09', 'covered-indirect', 'docs-check.js', 'index.html 不引用任何外链资源（NFR-25 内网隔离）',
    '"无外网访问"有直接断言：index.html 不外链任何资源、src/ 不引第三方库；"未解锁无法修改维保/公告"由 browser-check 的 ?unlock=1 启动即解锁断言承接（**依赖浏览器权限，本环境不可复跑**）；"密码策略有效"属 declared-gap（README 已知限制 1：前端明文口令，须服务端校验与哈希）。'],

  /* ——— 只有间接/前置件的一类 ——— */
  ['AC-04', 'covered-indirect', 'ui-check.js', 'UI-03 色彩规范',
    '**可机检的只有前置件**：大屏关键数据的字号下限（UI-04 逐角色断言）、UI-03 色彩规范、"航行器深度"已渲染（browser-check）都有断言；但"75 寸 4K@30Hz、4～8 m 距离清晰可读"是**现场人工观感判定**，机器断言只能证明"字号不低于规范下限"，**不构成**距离可读性的验收结论。'],
  ['AC-10', 'covered-indirect', 'logic-check.js', '累计运行持久化：重启不倒退、跨班次不清零（DR-17）',
    '"断电重启后数据恢复"的**数据侧**：logic-check 断言累计运行重启不倒退、db-check 断言重开后行数不变且去重键仍生效；但"重启后**无需人工干预自动恢复显示**"属部署/无人值守（DEP-02～DEP-06、ENV-20 自启与自动拉起），纯前端 Demo 无法验证。'],

  /* ——— 无机器证据的一类（如实标注，不用 8 小时或跳过充当通过） ——— */
  ['AC-01', 'manual', '', '',
    '"P0 条目 100% 实现并现场演示通过"的判定对象是**现场演示**与"P0 清单逐条过"的组织动作；trace-check 的"优先级×状态"只是**旁证**（P0 184 条中可追溯覆盖 126 条），该比率**不等于**实现完备度（分子含间接验证，且部分 P0 依赖后端/硬件/现场），故不得据此声称 AC-01 满足，须人工/现场判定。'],
  ['AC-02', 'declared-gap', '', '',
    '"与 PC 上位机源头抽样比对一致率 100%"需要**真实上位机数据源**逐点抽样比对；Demo 用的是 mock 报文（contract-check 只证明缺字段不清零、字段映射可配置），**无从比对源头数据**，故为已声明缺口。'],
  ['AC-05', 'backend-phase', '', '',
    'IF-D 与上位机、IF-A/IF-B 与 MES 的**联调通过**属三方现场联调（IF-B.1～B.7/B.10、IF-D.7/D.10/D.12 亦整段归 backend-phase）；现有机器证据只到**契约层**（13 字段上报报文、两种回执风格、失败进入待补传队列——contract-check），接口函数名有断言而实现整批 pending，不足以构成联调结论。'],
  ['AC-07', 'declared-gap', '', '',
    '**⚠️ 唯一相关证据不构成满足**：验收要求"连续运行 ≥7 天无重启、无崩溃、无内存泄漏"（需求 :705），而现有唯一证据是 tests\\stress-check.js 的**默认 8 小时**整班次长跑（HOURS 默认 8，`stress-check.js:39`；tests\\README.md:257 自己写明"**8 小时 ≠ 验收要求**"，另参照 NFR-05 的 72 h 与 NFR-06 的 30 天）；**且该脚本在本受限环境整脚本 SKIP**（`stress-check.js:252` 的 env.skipSuite；本环境禁命名管道 ⇒ 退出码 3，按项目口径"**跳过 ≠ 通过**"）。**8 小时不得当 7 天、SKIP 不得当通过**：现有证据 0 条，故记 declared-gap。'],
  ['AC-11', 'declared-gap', '', '',
    '"看板软硬件成套实物交付 + 现场演示验收通过 + 与父项目 M6 对齐"属**商务与硬件交付**条款（与 DEP-12～DEP-15 同类），验收动作在现场/合同阶段，仓库内无对应机器证据，亦非纯软件可验。'],
  ['AC-12', 'declared-gap', '', '',
    '第 10 章 12 项交付物现况（实盘点）：`输出文件\\` 只有 4 份函件 + 1 份 Demo 说明（甲方 2 + 上位机方 1 + MES 方 1，各含 .md/.docx）；其中"需求规格说明书"对应需求清单本身，**其余 10 项**（系统设计说明书、界面原型/UI 设计稿、数据库脚本与初始化数据、源代码与构建说明、安装包与部署手册、接口联调文档与测试报告、测试报告、用户操作手册/运维手册、培训与验收报告、质保承诺书）无交付件；trace-check 侧仅 DEP-07 一条 declared-gap 登记了部署/运维/排障手册的缺失。"通过审核"属人工评审。']
];

/** AC 归属类型词表（与本文件头部状态词表一致；AC 段靠它拦"写了个不存在的分类"） */
const STATUS_WORDS = new Set([
  'covered-direct', 'covered-indirect', 'fix-pending', 'declared-gap',
  'backend-phase', 'manual', 'subjective', 'out-of-scope'
]);

/* ---------------- 断言与工具 ---------------- */
let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

/** 需求清单里"表格行"口径的全部条款（与 §0.2 条目数一致）
 *  ⚠️ 2026-09-19 修复：原正则**漏掉了 ENV 系列（20 条）** —— 导致"每条条款都有归属"是**假的全覆盖**，
 *     且条款总数被少算成 236（真实 256）。ENV 是 §2「运行环境与显示约束」的编号，属需求正文的一部分。 */
function requirementClauses() {
  const file = fs.readdirSync(path.join(ROOT, '需求文档')).find(f => f.endsWith('.md'));
  const lines = fs.readFileSync(path.join(ROOT, '需求文档', file), 'utf8').split('\n');
  const map = new Map();
  for (const l of lines) {
    const m = l.match(/^\|\s*((?:FR|UI|DR|NFR|DEP|ENV)-\d+(?:\.\d+)?|IF-[A-Z0-9]+\.\d+)\s*\|\s*([^|]*)\|/);
    if (m) map.set(m[1], m[2].trim().slice(0, 40));
  }
  return map;
}

/**
 * 条款 → 优先级（P0/P1/P2）。**不假设优先级在第几列** —— 需求里各表结构不同：
 * FR/UI/NFR 表的末列是优先级，而 DR / IF-C / IF-0 表的末列是"备注/说明"。
 * 故扫描该行**任意单元格**里的独立 `P0`/`P1`/`P2`；取不到即返回 null
 * （不计入优先级统计，避免用错值算 AC-01 的分母）。
 *
 * 为什么要它（P3-12）：AC-01 要求"P0 条目 100% 实现"，而追溯覆盖率的分母是**全部 256 条**
 * （含 P1/P2 与 out-of-scope），两个口径不通 —— 直接拿覆盖率当"AC-01 实现完备度"会误判。
 */
function requirementPriorities() {
  const file = fs.readdirSync(path.join(ROOT, '需求文档')).find(f => f.endsWith('.md'));
  const lines = fs.readFileSync(path.join(ROOT, '需求文档', file), 'utf8').split('\n');
  const map = new Map();
  for (const l of lines) {
    const m = l.match(/^\|\s*((?:FR|UI|DR|NFR|DEP|ENV)-\d+(?:\.\d+)?|IF-[A-Z0-9]+\.\d+)\s*\|/);
    if (!m) continue;
    const cells = l.split('|').slice(1, -1).map(c => c.trim());
    const hit = cells.find(c => /^P[0-2]\b/.test(c));
    if (hit) map.set(m[1], hit.match(/^(P[0-2])/)[1]);
  }
  return map;
}

/** 展开匹配式（精确 ID / 逗号分隔 / 前缀*）到具体条款 */function expand(pattern, universe) {
  return pattern.split(',').map(s => s.trim()).flatMap(p => {
    if (p.endsWith('*')) {
      const prefix = p.slice(0, -1);
      return [...universe.keys()].filter(id => id.startsWith(prefix));
    }
    return [p];
  });
}

function main() {
  const universe = requirementClauses();
  console.log(`需求条款（表格行口径）：${universe.size} 条`);
  console.log(`追溯表条目：${MAP.length} 组\n`);

  /* 1) 每条条款必须且只能归属一组 */
  const owner = new Map();
  const dup = [];
  for (const [pattern, status, script, evidence] of MAP) {
    for (const id of expand(pattern, universe)) {
      if (!universe.has(id)) {
        failures.push({ name: `追溯表引用了不存在的条款 ${id}`, detail: pattern });
        continue;
      }
      if (owner.has(id)) dup.push(`${id}（${owner.get(id)[0]} 与 ${pattern}）`);
      owner.set(id, [pattern, status, script, evidence]);
    }
  }
  const unassigned = [...universe.keys()].filter(id => !owner.has(id));

  console.log('=== 一、追溯表完整性 ===');
  check('追溯表没有重复归属的条款', dup.length === 0, dup.slice(0, 6).join('；'));
  check(
    `每条需求条款都有归属（未归属 0 条）`,
    unassigned.length === 0,
    unassigned.length ? `未归属 ${unassigned.length} 条：${unassigned.slice(0, 12).join(', ')}${unassigned.length > 12 ? ' …' : ''}` : `已归属 ${owner.size} 条`
  );

  /* 2) 证据有效性：脚本存在、且证据断言文本确实在该脚本里 */
  console.log('\n=== 二、证据有效性 ===');
  const badScript = [];
  const badEvidence = [];
  for (const [pattern, status, script, evidence] of MAP) {
    if (!script) continue;
    const p = path.join(TESTS, script);
    if (!fs.existsSync(p)) { badScript.push(`${pattern} → ${script}`); continue; }
    if (evidence && !fs.readFileSync(p, 'utf8').includes(evidence)) badEvidence.push(`${pattern} → ${script} 中找不到「${evidence}」`);
  }
  check('证据指向的脚本都存在', badScript.length === 0, badScript.join('；'));
  check('证据指向的断言确实存在于该脚本', badEvidence.length === 0, badEvidence.slice(0, 6).join('；'));

  /* 2b) 证据"共用度"提示（P2-9～12 的辅助，**不判失败**）
     为何不判失败：一条断言被多条条款共用**很多时候是正当的** —— 例如
     `IF-B.8`（上报报文 13 字段）与 `IF-D.1/D.2…`（报文键映射）本就指向同一份字段清单；
     `UI-06/UI-07`（进度条/图表）与 `FR-6.1～6.3`（维保周期台账）指向同一次面板渲染也正确。
     故这里只**列出**高共用度的证据供人工复核，并把判据写清楚：
     **"证据是否对题"属语义判断，无法用文本规则可靠判定；能机械化的是"证据脚本存在"
     与"证据文本确实在该脚本里"（上两条），其余靠评审。** */
  const evidenceUsers = new Map();
  for (const [pattern, status, script, evidence] of MAP) {
    if (!script || !evidence) continue;
    const key = `${script} ← ${evidence}`;
    if (!evidenceUsers.has(key)) evidenceUsers.set(key, []);
    evidenceUsers.get(key).push(...expand(pattern, universe));
  }
  const shared = [...evidenceUsers].filter(([, ids]) => ids.length >= 5)
    .map(([key, ids]) => `${key} → ${ids.length} 条`);
  if (shared.length) {
    console.log(`  [提示] ${shared.length} 条证据被 ≥5 条条款共用（需人工复核是否对题，不计失败）：`);
    for (const s of shared.slice(0, 5)) console.log(`         · ${s}`);
  } else {
    console.log('  [提示] 没有证据被 ≥5 条条款共用');
  }

  /* 3) 覆盖统计 */
  console.log('\n=== 三、覆盖统计（按状态）===');
  const byStatus = new Map();
  for (const [id, [, status]] of owner) byStatus.set(status, (byStatus.get(status) || 0) + 1);
  for (const [k, v] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${String(v).padStart(3)} 条  (${(v / owner.size * 100).toFixed(1)}%)`);
  }
  const covered = (byStatus.get('covered-direct') || 0) + (byStatus.get('covered-indirect') || 0);
  console.log(`  ${'—'.repeat(16)}`);
  console.log(`  可追溯覆盖合计      ${String(covered).padStart(3)} / ${owner.size} 条  (${(covered / owner.size * 100).toFixed(1)}%)`);
  console.log(`    其中直接断言      ${String(byStatus.get('covered-direct') || 0).padStart(3)} 条`);
  console.log(`    其中间接验证      ${String(byStatus.get('covered-indirect') || 0).padStart(3)} 条`);

  /* 3b) 离线可验证覆盖率（P3-10）
     症状：`covered-*` 里有若干条证据来自**本环境跑不了的** `browser-check`/`overlap-check`/`stress-check`
     （受限沙箱禁子进程管道）。把它们与可离线复跑的断言混在一起报"覆盖率"，会高估随时可验证的程度。
     故**并列**给出"离线可验证"口径 —— 便于在无浏览器权限的环境（含目标机初装）判断可信度。 */
  const ONLINE_ONLY = new Set(['browser-check.js', 'overlap-check.js', 'stress-check.js']);
  const onlineOnlyIds = [];
  for (const [id, [, status, script]] of owner) {
    if ((status === 'covered-direct' || status === 'covered-indirect') && ONLINE_ONLY.has(script)) {
      onlineOnlyIds.push(id);
    }
  }
  const offlineCovered = covered - onlineOnlyIds.length;
  console.log(`  ${'—'.repeat(16)}`);
  console.log(`  离线可验证覆盖      ${String(offlineCovered).padStart(3)} / ${owner.size} 条  (${(offlineCovered / owner.size * 100).toFixed(1)}%)`);
  console.log(`    依赖需浏览器权限的脚本 ${String(onlineOnlyIds.length).padStart(3)} 条  ← 本环境不可复跑（browser-check / overlap-check / stress-check）`);

  console.log('\n=== 四、按类别（可追溯覆盖 / 该类条款数）===');
  for (const cat of ['FR', 'UI', 'IF', 'DR', 'NFR', 'DEP', 'ENV']) {
    const ids = [...owner.keys()].filter(id => id.startsWith(cat + '-'));
    const hit = ids.filter(id => {
      const s = owner.get(id)[1];
      return s === 'covered-direct' || s === 'covered-indirect';
    });
    console.log(`  ${cat.padEnd(4)} ${String(hit.length).padStart(3)} / ${String(ids.length).padStart(3)}`);
  }

  console.log('\n=== 五、待修缺陷对应的条款（fix-pending）===');
  console.log('  ' + [...owner].filter(([, v]) => v[1] === 'fix-pending').map(([id]) => id).join(', '));

  /* 五之二、优先级 × 状态交叉表（P3-12）
     AC-01 要求"P0 条目 100% 实现" —— 与"可追溯覆盖率"是**两个不同口径**，必须分开报，
     否则容易把 162/256 误当作"AC-01 的实现完备度"（分子含间接验证、分母含 P1/P2 与 out-of-scope）。 */
  console.log('\n=== 五之二、优先级 × 状态（AC-01 口径，**不是**可追溯覆盖率）===');
  const prio = requirementPriorities();
  const prioOrder = ['P0', 'P1', 'P2'];
  const byPrio = new Map(prioOrder.map(k => [k, { total: 0, covered: 0, direct: 0 }]));
  let noPrio = 0;
  for (const [id, [, status]] of owner) {
    const pv = prio.get(id);
    if (!pv || !byPrio.has(pv)) { noPrio++; continue; }
    const row = byPrio.get(pv);
    row.total++;
    if (status === 'covered-direct' || status === 'covered-indirect') {
      row.covered++;
      if (status === 'covered-direct') row.direct++;
    }
  }
  for (const k of prioOrder) {
    const r = byPrio.get(k);
    const pctTxt = r.total ? `${((r.covered / r.total) * 100).toFixed(1)}%` : '—';
    console.log(`  ${k}  可追溯覆盖 ${String(r.covered).padStart(3)} / ${String(r.total).padStart(3)}  (${pctTxt})，其中直接断言 ${r.direct} 条`);
  }
  if (noPrio) {
    console.log(`  （另有 ${noPrio} 条条款**在需求里本就没有优先级字段**（DR 表为「编号/数据表/关键字段/说明」四列、`);
    console.log('    IF-C / IF-0 部分行末列为备注），故不计入上表；AC-01 的"P0 条目"基数仅指**标注了优先级的**那些。）');
  }
  const p0 = byPrio.get('P0');
  console.log(`  **AC-01 提示**：标注为 P0 的共 ${p0.total} 条，可追溯覆盖 ${p0.covered} 条 —— 该比率**不等于**"P0 100% 实现"（分子含间接验证，且部分 P0 依赖后端/硬件/现场）。`);

  /* 六、AC 验收标准追溯（AC-01～AC-12；P1-2）
     为什么单列一节而不是塞进 MAP：需求 §0.2（`需求文档\…V1.30.md:153`）声明 AC「不计入需求条款合计」，
     故 AC 必须走**独立分母（12）**，不得改动"可追溯覆盖合计 X / 256"。 */
  console.log('\n=== 六、AC 验收标准追溯（AC-01～AC-12，**不计入上面的 256 条分母**）===');
  const acUniverse = acceptanceCriteria();
  /* 第 3 步"证据文本确实在该脚本里"的容器提前取出：AC 段与主表**同规格**校验。 */
  const MAP_SRC = new Map(MAP.map(([pattern, , script]) => [pattern, script]));

  const acFlat = [];
  for (const [id, status, script, evidence, basis] of AC_MAP) acFlat.push(`${id}\t${status}\t${script}\t${evidence}\t${basis}`);
  const acOwner = new Map();
  const acDup = [];
  for (const [id, status, script, evidence, basis] of AC_MAP) {
    if (acOwner.has(id)) acDup.push(`${id}（与 ${acOwner.get(id)[0]} 重复）`);
    acOwner.set(id, [status, script, evidence, basis]);
  }
  const acUnassigned = [...acUniverse.keys()].filter(id => !acOwner.has(id));
  const acInvalid = [
    ...AC_MAP.filter(([id]) => !acUniverse.has(id)).map(([id]) => `${id}（需求清单里没有这条 AC）`),
    ...AC_MAP.filter(([, status]) => !STATUS_WORDS.has(status)).map(([id, status]) => `${id}（状态词「${status}」不在词表内）`),
    ...AC_MAP.filter(([, , script, evidence]) => (script && !evidence) || (!script && evidence))
      .map(([id]) => `${id}（证据脚本与证据文本必须同时给出或同时为空）`),
    ...AC_MAP.filter(([, , , , basis]) => !basis || !basis.trim()).map(([id]) => `${id}（缺"依据"一句话）`)
  ];
  /* 判据（与第 1 步同规格）：每条 AC 都必须**在表里出现**，且状态/证据/依据都写实。
     ⚠️ 为何还要 `AC_MAP.length === acOwner.size`：防止**重复登记**（同一 AC 写两遍会让"条数"看着够）。
     反证（ADR-0004 D22 定点变异）：把某条 AC 的编号改掉（等价于删掉该条），本条由全绿转红并点名该编号 ——
     实测把 `AC-09` 改成 `AC-XX-MUTATED-AWAY` 后，detail 直接给出「未归属 1 条：AC-09」、汇总由 8/0/0 变 7/1/0、退 1。 */
  check('AC-01～AC-12 每条都有归属、无遗漏（缺一即红）',
    AC_MAP.length === acOwner.size && acUnassigned.length === 0 && acDup.length === 0 && acInvalid.length === 0,
    acUnassigned.length
      ? `未归属 ${acUnassigned.length} 条：${acUnassigned.join(', ')}`
      : (acDup.length || acInvalid.length ? [...acDup, ...acInvalid].join('；') : `已归属 ${acOwner.size} 条 = 需求表 ${acUniverse.size} 条`));

  /* AC 段证据有效性：与第 2 步同规格（脚本存在 + 证据文本确实在该脚本里），不是"登记了就算数"。 */
  const acBadScript = [];
  const acBadEvidence = [];
  for (const [id, , script, evidence] of AC_MAP) {
    if (!script) continue;
    const p = path.join(TESTS, script);
    if (!fs.existsSync(p)) { acBadScript.push(`${id} → ${script}`); continue; }
    if (evidence && !fs.readFileSync(p, 'utf8').includes(evidence)) acBadEvidence.push(`${id} → ${script} 中找不到「${evidence}」`);
  }
  check('AC 证据指向的脚本都存在', acBadScript.length === 0, acBadScript.join('；'));
  check('AC 证据指向的断言确实存在于该脚本', acBadEvidence.length === 0, acBadEvidence.slice(0, 6).join('；'));

  /* AC 分区汇总（AC 的状态词允许与主表不同：backend-phase / declared-gap 在 AC 里同样正当）。
     分母一律取**需求表的条数**（acUniverse.size），不取追溯表行数 —— 否则漏登一条时会显示"12 条"自欺。 */
  const byAc = new Map();
  for (const [id, [status]] of acOwner) byAc.set(status, (byAc.get(status) || 0) + 1);
  console.log(`  AC 合计（需求 §0.2 声明 ${acUniverse.size} 条，**不计入上面的 256 条分母**）：已登记 ${AC_MAP.length} 条，覆盖到 ${[...acOwner.keys()].filter(id => acUniverse.has(id)).length} / ${acUniverse.size} 条`);
  for (const [k, v] of [...byAc].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${String(v).padStart(3)} 条`);

  /* AC 覆盖率单独成行 + 逐条清单（编号 / 归属类型 / 证据脚本或"无" / 依据一句话）。
     两种分子都报，避免"AC 覆盖高"被误读：可复跑＝不依赖 browser/overlap/stress 的机器证据。 */
  const acCov = (byAc.get('covered-direct') || 0) + (byAc.get('covered-indirect') || 0);
  const acScriptDependent = [...acOwner].filter(([, v]) => {
    const s = v[0];
    return (s === 'covered-direct' || s === 'covered-indirect') && ONLINE_ONLY.has(v[1]);
  }).length;
  const acNoMachine = acUniverse.size - acCov;
  console.log(`  AC 覆盖 ${acCov}/${acUniverse.size}（可复跑 ${acCov - acScriptDependent}/${acUniverse.size}、含需浏览器权限 ${acScriptDependent} 条；无机器证据 ${acNoMachine} 条）`);
  console.log(`  AC 逐条归属（编号 / 归属类型 / 证据脚本或"无" / 依据一句话）：`);
  for (const [id, [status, script, evidence, basis]] of acOwner) {
    console.log(`    ${id}  ${status.padEnd(16)} ${(script || '无').padEnd(18)} ${basis}`);
  }

  /* AC-07 专项如实标注：要求 ≥7 天，证据只有 8 小时且整脚本跳过 —— 不构成满足。
     为什么单独立一条：这是本次唯一"证据看着有、其实不成立"的条目，必须被定点变异之外的第二道机器检查钉住，
     否则以后很容易被写成"已有 8 小时长跑 ⇒ 基本满足"。 */
  const ac07reqDays = Number((acUniverse.get('AC-07') || '').match(/≥\s*(\d+)\s*天/)?.[1] || 0);
  const stressHours = Number(fs.readFileSync(path.join(TESTS, 'stress-check.js'), 'utf8').match(/DSH_STRESS_HOURS\s*\|\|\s*(\d+)/)?.[1] || 0);
  const ac07rec = acOwner.get('AC-07') || ['', '', '', ''];
  check('AC-07 如实登记为无有效证据（≥7 天 vs 现有 8 小时且整脚本跳过，不构成满足）',
    ac07reqDays >= 7 && stressHours > 0 && stressHours < ac07reqDays * 24 &&
    ac07rec[0] === 'declared-gap' && !ac07rec[1] && /跳过/.test(ac07rec[3] || ''),
    `AC-07 要求 ≥${ac07reqDays} 天、stress-check 默认 ${stressHours} 小时（整脚本跳过）、登记状态 ${ac07rec[0]}, 证据脚本 ${ac07rec[1] || '无'}`);

  /* AC 与需求条款两套分母的隔离：AC 段本身不得与主表的证据引用混同（同一个脚本名两侧都用得到，
     但"AC 覆盖率"绝不能改写主表口径）—— 这里只作提示，真正的隔离由本节的独立计数与
     上面"可追溯覆盖合计 / owner.size(=256)"保证。 */
  const acSharedScripts = [...new Set(AC_MAP.map(([, , s]) => s).filter(Boolean))]
    .filter(s => [...MAP_SRC.values()].includes(s));
  if (acSharedScripts.length) {
    console.log(`  [提示] AC 段与需求条款主表共用 ${acSharedScripts.length} 个证据脚本（正当）：${acSharedScripts.join('、')}`);
  }

  if (LIST) {
    console.log('\n=== 附：全部条款归属 ===');
    for (const [id, [pattern, status, script, evidence]] of [...owner].sort()) {
      console.log(`  ${id.padEnd(10)} ${status.padEnd(16)} ${script}${evidence ? ' ← ' + evidence : ''}`);
    }
  }

  console.log('\n=== 汇总 ===');
  /* 冻结格式（规范 9.5-5）：三字段齐全，`run-all` 与 tests\README 都解析这一行 */
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项，跳过 0 项`);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ' —— ' + f.detail : ''}`));
    process.exit(1);
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
