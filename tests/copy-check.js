/* ==========================================================================
   界面文案与需求条款对照（tests/copy-check.js）
   作用：把需求清单里"规定了界面文案"的条款，与 `index.html` / 组件 / 数据源里的实际
         文案逐条对照，形成可执行的断言；未确认的映射先列为"待确认"，不参与断言。
         映射按 **(条款 + 界面构件)** 逐条拆分：同一条款若有多个独立构件（如 FR-3.16 的
         「测试标准区标题」「二级菜单归属说明」「菜单项参数名」），拆成多条各自断言 ——
         否则一条 items 里混装时，只要任一项命中就会掩盖其余项缺失。
   判据：status = 'confirmed' 的条目，其每条预期文案必须出现在 files 列出的任一文件里；
         status = 'pending' 的条目只打印，供人工确认映射后再升级为 confirmed。
   依赖：仅 Node 内置模块（源码级文本核对，不启浏览器）。
   运行：node tests/copy-check.js（--list 打印全部条目）
   退出码：0 = 已确认条目全部命中；1 = 有确认条目未命中（文案被改动或写错）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const env = require('./env');
env.assertRuntime();

const ROOT = path.resolve(__dirname, '..');
const LIST = process.argv.includes('--list');

/* ---------------- 对照表 ----------------
   条目字段：clause 需求条款 | note 需求原文摘要 | items 预期文案 | files 应出现的文件 | status
   ------------------------------------------------------------------------------------------ */
const MAP = [
  { clause: 'FR-2.1', note: '运行模式 5 种：待机、测试运行、正常停机、维保检修、故障锁定', status: 'confirmed',
    items: ['待机', '测试运行', '正常停机', '维保检修', '故障锁定'],
    files: ['src/components/DeviceStatusPanel.js', 'src/config/fieldMap.js'] },

  { clause: 'FR-2.5', note: '运行阶段 4 阶段：准备 / 运行 / 判定 / 完成', status: 'confirmed',
    items: ['准备', '运行', '判定', '完成'],
    files: ['src/services/mockData.js', 'src/services/mockUpperSource.js'] },

  { clause: 'FR-2.6', note: '联网状态：在线正常 / 离线断连 / 数据传输异常', status: 'confirmed',
    items: ['在线正常', '离线断连', '数据传输异常'],
    files: ['src/config/fieldMap.js', 'src/services/mockData.js', 'src/components/DeviceStatusPanel.js'] },

  { clause: 'FR-3.13', note: '单任务结果五态：待测试 / 测试中 / 合格 / 不合格 / 待复检', status: 'confirmed',
    items: ['待测试', '测试中', '合格', '不合格', '待复检'],
    files: ['index.html', 'src/services/mockData.js'] },

  { clause: 'FR-4.1-FR-4.15', note: '当班生产统计 15 项指标名', status: 'confirmed',
    items: ['计划测试总数', '实际开工总数', '未开工数量', '已完成测试数', '测试中数量', '待测试数量',
      '合格数', '不合格数', '复检数', '一次性合格率', '有效运行时长', '待机时长', '平均测试时长',
      '产能达成率', '设备稼动率'],
    files: ['index.html'] },

  /* V1.34（C-88）改判（FR-5.8 细分）：参数类预防性预警由**一条**细分为**两条具名** ——
     「参数阈值临近预警」（黄，实测落入临近带）与「参数超范围预警」（红，实测越过上/下限）；
     判定对象＝**深度与速度的测试标准上下限**（FR-3.14 / FR-3.18），**相机参数不参与**；
     标准未设定（必要项缺失）⇒ 两条都不产生。
     故本条目由"四类"改为"**参数类 2 个细分名 + 维保/耗材/工单 3 类 = 5 个名称**"逐名核对
     —— **不削弱**：原 4 个名称一个不减，新增第 5 个「参数超范围预警」；
     条数口径写进 note：参数类**最多 2 条**（深度/速度各按最坏态择名，一个参数最多一条）、
     标准未设定时**可用 0 条**（不判定即不报案，不得用占位名充数）。 */
  { clause: 'FR-5.8-FR-5.11',
    note: '预防性预警名称：参数类**两条具名**（「参数阈值临近预警」黄、「参数超范围预警」红；判定对象＝深度与速度的测试标准上下限，相机参数不参与；参数类**最多 2 条**、标准未设定时**可用 0 条**）+ 维保/耗材/工单三类（设备维保到期 / 耗材更换 / 工单超时）',
    status: 'confirmed',
    items: ['参数阈值临近预警', '参数超范围预警', '设备维保到期预警', '耗材更换预警', '工单超时预警'],
    files: ['src/services/mockData.js'] },

  { clause: 'FR-5.12', note: '异常闭环状态四态：未处理 / 处理中 / 已闭环 / 复检确认中', status: 'confirmed',
    items: ['未处理', '处理中', '已闭环', '复检确认中'],
    files: ['src/services/mockData.js'] },

  { clause: 'FR-5.13', note: '异常台账四列：发生时间 / 代码 / 故障简述 / 闭环状态', status: 'confirmed',
    items: ['发生时间', '代码', '故障简述', '闭环状态'],
    files: ['index.html'] },

  { clause: 'FR-6.7-FR-6.10', note: '检修记录四列：检修时间 / 检修内容 / 责任人 / 验收状态', status: 'confirmed',
    items: ['检修时间', '检修内容', '责任人', '验收状态'],
    files: ['index.html'] },

  { clause: 'FR-7.1-FR-7.4', note: '车间公告四类标签：生产调整 / 工艺变更 / 临时管控 / 车间公示', status: 'confirmed',
    items: ['生产调整', '工艺变更', '临时管控', '车间公示'],
    files: ['src/services/mockData.js', 'index.html'] },

  { clause: 'FR-7.5-FR-7.7', note: '测试工艺提示三类：测试要求 / 质量管控 / 操作注意', status: 'confirmed',
    items: ['测试要求', '质量管控', '操作注意'],
    files: ['src/services/mockData.js'] },

  { clause: 'FR-7.8-FR-7.10', note: '待办提醒三项：待复检任务 / 待维保作业 / 未闭环异常', status: 'confirmed',
    items: ['待复检任务', '待维保作业', '未闭环异常'],
    files: ['src/services/mockData.js'] },

  { clause: 'FR-8.1', note: '解锁状态文案：当前已锁定 / 已解锁', status: 'confirmed',
    items: ['当前已锁定', '已解锁'],
    files: ['index.html', 'src/components/SettingPanel.js'] },

  { clause: 'FR-8.3', note: '时间设置按钮：立即同步 NTP / 手工设置时间', status: 'confirmed',
    items: ['立即同步 NTP', '手工设置时间'],
    files: ['index.html'] },

  { clause: 'FR-8.5', note: '系统自检七项名称', status: 'confirmed',
    items: ['看板主机网络', 'PC 上位机连接', 'MES 接口连通性', 'MES 上报队列', '本地数据库', '磁盘空间', 'NTP 时间同步'],
    files: ['src/services/mockData.js'] },

  { clause: 'FR-9.1', note: '底部八个标签名称', status: 'confirmed',
    items: ['设备状态', '任务数据', '班次信息', '生产统计', '设备异常', '维保台账', '公告备注', '操作设置'],
    files: ['src/pages/Dashboard.js', 'index.html'] },

  { clause: 'UI-17', note: '页脚四要素标签：版本 / 最后刷新 / 上位机链路 / MES 链路', status: 'confirmed',
    items: ['版本', '最后刷新', '上位机链路', 'MES 链路'],
    files: ['index.html'] },

  { clause: 'UI-19', note: '曲线空态文案', status: 'confirmed',
    items: ['暂无已完成任务数据', '完成一次测试任务后自动绘制完整曲线'],
    files: ['index.html'] },

  { clause: 'FR-1.6-FR-1.9', note: '头部人员字段标签：班组 / 操作员 / 班组长', status: 'confirmed',
    items: ['班组', '操作员', '班组长'],
    files: ['index.html'] },

  { clause: 'FR-1.3-FR-1.4', note: '日期与星期只要求"显示取值"，不要求文字标签；此处按格式/取值集合判定', status: 'confirmed',
    items: ["pad(now.getMonth() + 1)", "pad(now.getDate())", "hdrDate", "'星期日', '星期一'"],
    files: ['src/services/mockData.js', 'index.html'] },

  { clause: 'FR-6.4-FR-6.6', note: '累计运行三项展示名（当日/本月/年度累计运行）；经确认为等价表述，数值单位由 h 与时钟格式体现', status: 'confirmed',
    items: ['当日累计运行', '本月累计运行', '年度累计运行'],
    files: ['index.html'] },

  /* V1.33（C-73/C-71/C-72/C-84）：任务数据页右下角由「设备参数次要展示区」改写为「测试标准区」，
     相机参数移入二级菜单。旧条目（"实时帧率 / 相机增益 / 快门速度 / 相机水下深度"出现在 index.html）
     的载体已随改写移走，按新口径**改判**（原条目删除、新条目逐条对应 FR-3.16 的三个界面构件）。 */
  { clause: 'FR-3.16', note: '测试标准区承载 FR-3.18 显示与 FR-3.19 录入入口（任务数据页右下角，就地替换原次要参数位）',
    status: 'confirmed', items: ['测试标准区', '深度 / 速度（FR-3.18 显示 · FR-3.19 录入）'],
    files: ['index.html'] },

  { clause: 'FR-3.16', note: '相机参数移入任务数据页二级菜单：菜单标题 + 归属说明行（上位机侧设备参数，不参与本看板判定）',
    status: 'confirmed', items: ['相机参数（二级菜单）', '上位机侧设备参数，不参与本看板判定'],
    files: ['index.html'] },

  { clause: 'FR-3.16', note: '二级菜单表头为「参数 / 设定值」两列（真源：index.html 的 #tkCompareTable）',
    status: 'confirmed', items: ['参数', '设定值'],
    files: ['index.html'] },

  { clause: 'FR-3.16', note: '二级菜单四项参数名（相机设定深度 / 相机增益 / 设定帧率 / 快门速度）由配置段列出、组件按配置渲染',
    status: 'confirmed', items: ['相机设定深度', '相机增益', '设定帧率', '快门速度'],
    files: ['src/config/board.config.js', 'src/components/TaskPanel.js'] },

  /* V1.35（C-90 / C-91 / C-92）改判：FR-3.18 / FR-3.19 的**显示与录入对象**由「上限 / 下限绝对值」
     改为「**典型值 / 上偏差 / 下偏差**」（三格均可录入；上限＝典型值＋上偏差、下限＝典型值＋下偏差为
     **只读导出值**；判定对象仍是导出的上下限）。故本组映射按**源码实际字符串**逐条重取：
     表头 5 列（index.html 的 `#tkStdTable` 的 `<thead>`）＋ 说明行（`TaskPanel.js` 的 `setText('tkStdMeta', …)`）。
     V1.36（C-96 / U-5）**再改判说明行**：`#tkStdMeta` 精简为**只有一句**「典型值 / 上偏差 / 下偏差三格可录入」
     （删去导出公式长句与尾部 meta「（班组/生效时间/版本）」）。
     ⚠️ 故本条目**删掉** 3 项旧文案（`上限＝典型值＋上偏差、下限＝典型值＋下偏差`、
     `为只读导出值`、`典型值不参与判定（判定对象＝导出的上下限）`）—— 它们**不是界面事实消失**，
     而是**载体换了**：C-96 明示「只读导出值本身仍在第 5 格界面显示」（FR-3.18 语义不变），
     该事实的机器证据在 **ui-check 的第 5 格 `.std-derived` 反向断言**（无 `data-edit`、无 `std-num`）
     与**真机判据**（browser-check B5b）里；本表只保留"文案在哪"的源码级事实。
     ⚠️ 为什么说明行这一项要写成**整段标签＋正文**而不是只写那句话：旧长句在 index.html 的
     HTML 注释与 `#tkStdEdit` 的提示行里**仍然存在**（那里是录入提示，不是说明行），
     只写裸句会被那些残留命中而"看着还在"⇒ 无法证明说明行已精简。整段字面量才能锁住它。 */
  { clause: 'FR-3.18', note: '测试标准区表头五列（检测参数 / 典型值 / 上偏差 / 下偏差 / 上限·下限（导出））+ 说明行**只写**「典型值 / 上偏差 / 下偏差三格可录入」（V1.36 / C-96；整段字面量＝逐字核对）',
    status: 'confirmed',
    items: ['检测参数', '典型值', '上偏差', '下偏差', '上限 / 下限（导出）',
      '<div class="std-note" id="tkStdMeta">典型值 / 上偏差 / 下偏差三格可录入</div>',
      /* 说明行删掉的「只读导出值」语义由**第 5 格**承担（C-96）：这里登记它的源码落点，
         与 ui-check 的 `.std-derived` 反向断言、browser-check 的真机判据同一对象。 */
      '<td class="std-derived">'],
    files: ['index.html', 'src/components/TaskPanel.js'] },

  { clause: 'FR-3.19', note: '录入入口的提示文案：输入框占位、操作提示（回车/Esc/点击其他区域）、未解锁提示与解锁后提示（V1.35 改对象为「典型值、上偏差与下偏差」）',
    status: 'confirmed',
    items: ['输入数值后回车', '回车确认 · Esc 取消 · 点击其他区域同样确认',
      '当前已锁定：解锁后方可录入典型值、上偏差与下偏差',
      '已解锁：点击典型值、上偏差或下偏差数字即可录入（单人操作、无二次复核）',
      '录入中：回车确认并注入，Esc 取消，点击其他区域同样确认'],
    files: ['index.html', 'src/components/TaskPanel.js'] },

  { clause: 'FR-3.19', note: '第④步录入态样式口径（C-89）：高亮框 2 px、间隔 1 s ± 50 ms；第⑥步校验弹窗口径：六类非法一律弹窗提醒且写明「本次不写入」；配套约束「单人操作、无二次复核」',
    status: 'confirmed',
    items: ['校验未通过：', '本次不写入', '单人操作、无二次复核',
      '非负绝对量、不带符号', '小数位非法', '同时存在或同时为空', '上偏差 ≥ 0 ≥ 下偏差'],
    files: ['src/components/TaskPanel.js'] },

  { clause: 'FR-3.19', note: '第⑦步逐单元格留痕文案：被改单元格 + 修改前后值 + 导出上下限 + 生效时间（班组编号由 logEntry 追加）；被拒路径同样含被改单元格名',
    status: 'confirmed',
    items: ['被改单元格「', '导出上限 ', '导出下限 ', '生效时间 ', '班组编号 ', '录入被拒绝'],
    files: ['src/components/TaskPanel.js'] },

  /* FR-7.12（P0「**仅本机解锁后可新增/编辑/删除公告**」；`T-20261002-08` 交付、
     `T-20261002-09` 按**源码实际字符串**登记文案）：编辑/删除入口只在**服务端模式**渲染
     （演示模式不渲染 ⇒ 10 张截图基准版面零变化，该判据在 ui-check 的 U8/FR-7.12-a），
     故这里的文案核对对象就是 `NoticePanel.js` 的入口拼装与 `SettingPanel.js`/`index.html` 的
     按钮与提示词。**逐字取自源码**，不写"应该是什么"。 */
  { clause: 'FR-7.12', note: '公告列表的「编辑 / 删除」入口（服务端模式才渲染）：容器类名与两个动作属性＋按钮文案',
    status: 'confirmed',
    items: ['notice-acts', 'data-notice-act="edit"', 'data-notice-act="delete"', '>编辑</button>', '>删除</button>'],
    files: ['src/components/NoticePanel.js'] },

  { clause: 'FR-7.12', note: '设置页公告写入的按钮/编辑态/成功与失败提示文案（服务端模式走真实路由；失败一律显示在 #entryMsg）',
    status: 'confirmed',
    items: ['>发布公告</button>', '保存修改', '公告已发布（服务端已落库并写入操作日志 op_log）',
      '已保存修改（服务端已落库并写入操作日志 op_log）', '已删除（原文已写入服务端操作日志 op_log）',
      '公告未保存（HTTP ', '公告未保存：服务端接口未装配（window.Api.httpJson 不可用）',
      '正在编辑公告 #', '改完点「保存修改」（再点一次「编辑」可取消）', '已取消编辑（回到「发布公告」）',
      '找不到这条公告（列表可能已刷新），请重新选择', '删除公告 #',
      '删除后原文仍保留在服务端操作日志（op_log）里。', '已解锁：可录入维保信息、修改公告'],
    files: ['src/components/SettingPanel.js', 'index.html'] },

  /* ---------------- ADR-0007 / E86①（`T-20261002-15`）本波新增与变更的文案 ----------------
     **逐字取自源码**（不写"应该是什么"）；两套模式提示**分开登记**，因为它们承载相反的义务：
       · 演示模式那句是 ADR-0007 D5 的**原句**、且被 10 张截图基准冻结 ⇒ 改一个字就变红；
       · 服务端模式**不得**出现演示口令「8888」（D4 明令），故它单独占一条、逐句核。
     与公告那两条的关系（**复核无遗漏**）：`FR-7.12` 的编辑/删除入口与写入提示已在上面的两条里登记，
     本波未改动 `NoticePanel.js`／SettingPanel 的公告文案 ⇒ **不重复登记**（重复只会让"命中于哪个文件"变模糊），
     只把本波**新引入**的鉴权文案补齐（演示模式提示／登录态／未登录过期／锁定剩余秒数／改密三项／本机初始化）。
     ⚠ 本节只判"文案在哪、逐字对不对"，**行为**判据在 `ui-check` 的 U9 段与 `harness-check` 的第十九节。 */
  { clause: 'ADR-0007 D5', note: '演示模式提示：ADR-0007 D5 的原句（`index.html` 的静态初值 + `render()` 同句写入；两种模式下都必须显示）',
    status: 'confirmed',
    items: ['演示模式：未启用服务端口令校验（口令由服务端校验）'],
    files: ['index.html', 'src/components/SettingPanel.js'] },

  { clause: 'NFR-14', note: '服务端模式的模式提示与登录态文案（写明校验方＝`POST /auth/login`；登录/未登录/尚未初始化三态，不含任何秘密，D8⑦）',
    status: 'confirmed',
    items: ['服务端模式：口令由服务端校验（POST /auth/login）', '；当前已登录（会话令牌在本窗口内）', '；当前未登录',
      '；服务端尚未初始化：请用一次性初始化码设置口令（ADR-0007 D4）'],
    files: ['src/components/SettingPanel.js'] },

  { clause: 'FR-8.1', note: '未登录/会话过期的**可见降级**文案（统一 401 处理的记账串 + 设置页锁定位与录入位的服务端口径提示）',
    status: 'confirmed',
    items: ['未登录或登录已过期',
      '当前已锁定：未登录或登录已过期，请先在左侧输入解锁密码（口令由服务端校验）',
      '已解锁：录入内容保存后写入服务端库并记录操作日志'],
    files: ['src/components/SettingPanel.js', 'src/services/auth.js'] },

  { clause: 'NFR-14', note: '口令错误与**锁定剩余时间**文案（423 的 `retryAfterSec` 由服务端算出；"锁定期间口令正确也会被拒"必须写在文案里，D2/D8①）',
    status: 'confirmed',
    items: ['账号已锁定：请在 ', ' 秒后', '重试（口令正确也会被拒；连续失败 5 次锁定 5 分钟）',
      '解锁被拒（HTTP 423 locked）：账号锁定中，',
      '密码错误，请重新输入（服务端校验；连续失败 5 次将锁定 5 分钟）',
      '解锁被拒（HTTP 401 bad_credentials）：口令不正确（服务端对外不区分原因）'],
    files: ['src/components/SettingPanel.js'] },

  { clause: 'FR-8.4', note: '改密（FR-8.4）三输入框与按钮，以及三类提示（两次输入不一致／改密成功须重新解锁／原口令不正确）',
    status: 'confirmed',
    items: ['id="setOldPwd"', 'id="setNewPwd"', 'id="setNewPwd2"', 'id="setPwdChangeBtn"', '>修改密码</button>',
      'placeholder="原口令"', 'placeholder="新口令（4～64 位）"', 'placeholder="确认新口令"',
      '两次输入的新口令不一致：本次不提交（服务端未收到任何改密请求）',
      '口令已修改：当前会话已被服务端清除，请用新口令重新解锁',
      '原口令不正确（服务端校验失败，会话未清除）'],
    files: ['index.html', 'src/components/SettingPanel.js'] },

  { clause: 'ADR-0007 D4', note: '本机一次性初始化（**唯一**初始化入口）的两个输入框与按钮，以及三类提示（提示走本机初始化／初始化成功且码作废／仅回环可用）',
    status: 'confirmed',
    items: ['id="setInitCode"', 'id="setInitPwd"', 'id="setInitBtn"', '>初始化口令</button>',
      'placeholder="一次性初始化码"', 'placeholder="设置新口令（4～64 位）"',
      '服务端尚未初始化（409 not_initialized）：请在本机用服务端控制台打印的',
      '口令初始化成功：请用刚设置的口令解锁（一次性初始化码已立即作废）',
      '初始化只允许来自本机回环（403 not_loopback）：请在本机浏览器打开设置页'],
    files: ['index.html', 'src/components/SettingPanel.js'] }

  /* ---------------- `T-20261007-03`（座位 4b）的**不登记**判定，逐条给理由 ----------------
     判定对象＝本波（`E197`／`E198`）新引入的三句界面文案：
       ①「（演示派生）」                      —— `src/components/StatsPanel.js:65`（`DEMO_SOURCE_NOTE`）
       ② `帧缺件序号：未取得 /health 读数（非 0，不等于"没有缺件序号"）` —— 同文件 `frameUnitIndexNote()` 的 warn 支
       ③ `⚠ 本班 N 帧未带件序号（未计入开工数；FR-4.2 按件序号去重）`   —— 同函数 err 支（`N` 是运行时值）
     **结论：三条都不登记**（本表仍 **37** 条已确认映射，`登记待改` 仍 0 条）。理由逐条如下：

      一、**没有任何需求条款规定过这三句的字面量**（这是决定性理由）。
          `E197`／`E198` 的立项出处是 `项目记录\后续路线图.md` 的 `E72②`／`E72③`（技术债），
          分别于 2026-10-07 由负责人裁定"各自立号"；需求基线 **V1.44** 全文
          （`grep -n '演示派生|未取得|未带件序号' 需求文档\…-V1.44.md` ⇒ 三项**均 0 命中**）里
          与它们相关的只有 **`FR-4.2`**（"当班已开始测试的测试任务数；判定依据＝该件在 `DR-04`
          有采样数据"）与 **`FR-4.1～4.15`** 的**指标名**（"实际开工总数"等 15 个名字 —— 那 15 个
          名字**已经**在下面 `FR-4.1-FR-4.15` 那条里逐字登记）。
          `FR-4.2` 是**口径条款**（开工数按 `unit_index` 去重 ⇒ 缺件序号的帧不计入），
          **没有**规定界面文案；负责人 2026-10-07 的裁定（"演示模式不显示该提示行"）也不是条款文本。
          ⇒ 本表的判据是"**条款规定了文案 ⇒ 逐字锁住**"（见文件头第 8～9 行）；
          无条款来源的文案登记进来，只是把**实现现状**抄成一份"看着像真源"的副本。
      二、**即使放宽到"有条款出处就算"，这里也走不通**：
          `FR-4.2` 只要求"读数被如实区分"，**不指定措辞**；而 `E198` 的三支里有两支是
          **可证伪的行为**（出现/消失、红/黄档、`data-note-lv` 取值），措辞是实现细节。
          把它们登记成"必须逐字出现"，会把**自由措辞**冻成硬约束（改一个字就要动需求口径），
          而真正该守的"该不该显示、是哪一档"反倒不受本表保护 —— 保护错了对象。
      三、**含运行时变量的那一句（③）在本表的机制下必然退化**：
          本表只做源码级 `includes` 整串比对；③的 `N` 是每帧不同的实际值
          （`frameUnitIndexNote()` 里 `'⚠ 本班 ' + withoutIndex + ' 帧未带件序号…'`）。
          要登记就只能登记固定子串（"本班 "／" 帧未带件序号"），
          ⇒ 文案在中间被改断（例如成了"本班 N 帧缺件序号"）**照样命中 ⇒ 照样绿**，
          比 `ui-check` 的 U11（逐字 `errText(7)`）**更弱**。登记它=用一条更弱的判据换掉一条更强的。
      四、**同源会变三份**（ADR-0004 D23 要防的"没落在真集成路径上"的镜像形态）：
          这三句的**真源在实现里**（`StatsPanel.js`），`index.html` 的注释里也已有一份说明；
          再进 `copy-check` 就是第三处。三处各自自洽、改一处漂两处，且本表**验不到**"渲染时到底
          显示没显示"（它只读源码文本）。
      五、**本波已有更强、且落在真集成路径上的承接**（`ADR-0004 D19`：证据要指得出脚本名 + 断言名）：
          · 假 DOM + 真 `StatsPanel.render()`：`tests\ui-check.js` 的 U11 段
            `E197-①`／`E197-②`／`E197-③`／`E198-①`（四态五项逐字）／`E198-②`（两种"没有"分得开）／
            `E198-③`（渲染不发请求）／`E197/E198-④`（`#sStarted` 数值口径未变）
            ＋ 两条 `D22` 定点变异；`FR-4.1～4.15` 的 15 位指标名判据也在本次收紧为按真实指标位计数。
          · `file://` 真页面（无头 Edge）：`tests\browser-check.js` 的 `B5d` 段
            —— 三档分辨率下"可见文本含「（演示派生）」／不含"帧缺件序号"／该格未撑破"。
          ⇒ 文案的**存在性**与**可见性**都已被更强的判据覆盖；本表再登记只是重复，且更弱。
      六、**反向成本**：一旦登记，`E197`/`E198` 后续任何**正当**的措辞调整（负责人改口径、
          或 `Q-21` 回填后改"件序号"的叫法）都要**同批改本表**，否则门禁红；
          而这类改动**不该**被本表拦（它拦的是"条款规定的文案被改错"）。
      七、**追溯性**：技术债 → 裁定的链条在 `项目记录\后续路线图.md` 的 `E197`／`E198` 行与
          `StatsPanel.js` 的头注里；本表不承担技术债的追溯（`trace-check` 的追溯表也不含本表条目）。
      ⇒ 三句文案的追溯与防回潮落点**不在本表**，而在 `ui-check` U11 与 `browser-check` B5d。
      **若将来**需求侧为它们补了条款（例如在 `FR-4.2` 里写死"缺件序号帧须在界面上点名"这类字面要求），
      本判定须**同批复审**：那时按该条款号登记，并把 `FR-4.1-FR-4.15` 式的 15 位口径一并核一遍。 */
];

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failures.push({ name, detail }); console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`); }
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function main() {
  const confirmed = MAP.filter(m => m.status === 'confirmed');
  const pending = MAP.filter(m => m.status === 'fix-pending');
  console.log(`对照表条目：${MAP.length} 条（已确认断言 ${confirmed.length}、登记待改 ${pending.length}）\n`);

  console.log('=== 一、已确认条目的文案核对（源码级） ===');
  for (const m of confirmed) {
    const texts = m.files.map(f => ({ f, t: readText(f) }));
    const missing = m.items.filter(item => !texts.some(x => x.t.includes(item)));
    check(
      `${m.clause} 文案（${m.items.length} 项）`,
      missing.length === 0,
      missing.length ? `未找到：${missing.join('、')}（查了 ${m.files.join('、')}）` : `命中于 ${texts.filter(x => m.items.some(i => x.t.includes(i))).map(x => x.f).join('、')}`
    );
  }

  console.log('\n=== 二、已登记待改的条目（不参与断言，改完再升级为 confirmed） ===');
  for (const m of pending) {
    console.log(`  [!] ${m.clause}：${m.note}`);
    console.log(`      改完应出现：${m.items.join('、')}（文件：${m.files.join('、')}）`);
  }

  if (LIST) {
    console.log('\n=== 附：全部条目 ===');
    for (const m of MAP) console.log(`  ${m.status.padEnd(9)} ${m.clause.padEnd(14)} ${m.items.join('、')}`);
  }

  console.log('\n=== 汇总 ===');
  /* 冻结格式（规范 9.5-5）：三字段齐全且**在最前**，`run-all` 与 tests\README 都解析这一行；
     "登记待改"是本脚本特有的补充信息，接在其后不影响解析。 */
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项，跳过 0 项；登记待改 ${pending.length} 条`);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ' —— ' + f.detail : ''}`));
    process.exit(1);
  }
  process.exit(0);
}

try { main(); } catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
