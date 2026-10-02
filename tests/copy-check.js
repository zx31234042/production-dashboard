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
    files: ['src/components/SettingPanel.js', 'index.html'] }
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
