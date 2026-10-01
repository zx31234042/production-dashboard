/* ==========================================================================
   需求追溯自检（tests/trace-check.js）
   作用：建立「需求清单条款 → 承接证据」的追溯关系，把"间接验证"也计入可追溯覆盖，
         并强制每一条条款都有明确状态（没有归属的条款即报 FAIL，防止覆盖情况含糊）。
         追溯表内嵌在本文件的 MAP 中：每条 = [条款匹配, 状态, 证据脚本, 证据文本]
         条款匹配支持：精确 ID、逗号分隔多 ID、`FR-1.*` 通配（匹配该前缀全部条款）
         第六节：AC-01～AC-12 验收标准追溯（**独立分母**，见需求 §0.2）。
         第七节：第 10 章 12 项交付物**逐项存在性台账**（落点 / 部分 / 缺失 + 覆盖计数，供 AC-12 用；
                 同样**不计入 259 条分母**；清单从需求原文解析，不硬编码）。
          条款分母口径（需求 V1.38）：分母一律取 `requirementClauses()` 从需求原文**逐行解析**出的条数
          （当前 **259** 条 —— V1.37 / C-98 只把 `testStatus` 的取值语义统一到附录 2 并登记「运行阶段」
           的导出规则（连带 FR-2.5 / FR-2.8 的证据改判），**不新增、不删除条款**，
           条款数不变；需求 §0.2 的合计行见 `需求文档\…-V1.41.md:279`），**不另建第二份真源**。
          本文件注释里凡写死"259"之处都只是该口径的**镜像**；与之配套的核对手法是第一节的
          `需求 §0.2 自述的条款合计 ＝ 逐条解析出的条款数` 断言（两个独立来源互校）——
          需求升版时它先变红并点名两个数字，改注释里的 259 之前必须先让它变绿。
   依赖：仅 Node 内置模块 + tests/lib/assert.js（统一 runner，ADR-0003 D14/D15）。
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
const { createRunner } = require('./lib/assert');
env.assertRuntime();

const ROOT = path.resolve(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const LIST = process.argv.includes('--list');
const t = createRunner('需求追溯自检（trace-check）');

/* ---------------- 追溯表 ---------------- */
const MAP = [
  /* FR-1 头部基础信息 */
  ['FR-1.*', 'covered-direct', 'ui-check.js', 'FR-1.1～1.10 头部十项均渲染出非空值'],

  /* FR-2 设备实时运行状态
     V1.37 / C-98 改判（FR-2.5、FR-2.8）：`testStatus` 口径统一到附录 2 后，这两条各有更对题的
     机器判据 —— FR-2.5「运行阶段由 `testStatus` 导出」（准备=0／运行=1／判定=2／完成=回到 0，
     "完成"为过渡阶段）由 tools-check 的**逐帧实跑**映射一致性断言承接；FR-2.8「四者映射表配置化 +
     维保检修上报 0」由 contract-check **实读反查表**的断言承接。
     原先把它们与 FR-2.1/FR-2.3 合挂在"设备状态页列出 5 种运行模式色标"这条**图例**断言上 ——
     那条只证明图例列了 5 项，证明不了上面两件事，故按 C-98 拆出来单独登记（条款归属总数不变，
     仍 259 条；P0 仍 188）。⚠️ 如实登记：这两条的**绿**取决于实现侧把 C-98 落到位
     （`modeToTestStatus['维保检修']`、两处模拟上位机的 判定=2/完成=0）；断言先按新口径写死，
     实现未落完时它们就是红的（不为变绿弱化断言）。 */
  ['FR-2.1,FR-2.3', 'covered-direct', 'ui-check.js', 'FR-2.1 设备状态页列出 5 种运行模式色标'],
  ['FR-2.5', 'covered-direct', 'tools-check.js', 'FR-2.5/C-98 前端模拟上位机实跑：逐帧 stage→testStatus 严格为 准备→0／运行→1／判定→2／完成→0，且四阶段全部被观测到'],
  ['FR-2.8', 'covered-direct', 'contract-check.js', 'FR-2.8/IF-B.8/D2 上报 MES 反查表 modeToTestStatus 逐项对账'],
  ['FR-2.2', 'manual', '', '状态→颜色映射（绿/黄/红/灰）须人工核对观感；原证据为"UI-04 字号"，与颜色标识无关（2026-09-19 改判）'],
  ['FR-2.4,FR-2.7', 'covered-indirect', 'ui-check.js', 'UI-08 深度与速度数值格式统一'],
  ['FR-2.6', 'covered-direct', 'browser-check.js', '?link=off 进入降级态'],

  /* FR-3 实时测试任务数据 */
  ['FR-3.1,FR-3.2,FR-3.3,FR-3.4', 'covered-indirect', 'ui-check.js', '当前工单信息渲染 8 项'],
  /* V1.33 改判（FR-3.5～3.8）：这四条由"测试标准阈值"改写为**设备参数**，改由任务数据页
     二级菜单承载、**不参与本看板判定**。原证据「超阈值判定：帧率超标、增益临近」的载体
     （`#tkCompareTable` 的实测值/偏差/状态列）已随 FR-3.16 改写一并移走（该断言在 ui-check 里
     已不存在），故改指二级菜单的"参数名 + 设定值"断言 —— 它对号入座的正是这四项
     （相机设定深度＝FR-3.5、相机增益＝FR-3.6、设定帧率＝FR-3.7、快门速度＝FR-3.8），
     且该断言名不含 FR-3.5～3.8 的编号、验证的也不是"阈值判定"（判定已不适用于相机参数），
     故状态仍记 covered-indirect（不因改写而升 covered-direct）。 */
  ['FR-3.5,FR-3.6,FR-3.7,FR-3.8', 'covered-indirect', 'ui-check.js', 'FR-3.16 菜单项为参数名 + 设定值（值取自 state.task.std 的设定值，逐项按配置位数格式化：相机设定深度/相机增益/设定帧率/快门速度）'],
  /* V1.33 改写（FR-3.16，P1→P0）：任务数据页右下角改为「测试标准区」（显示上下限与典型值、
     并作为 FR-3.19 的录入入口），相机参数移入**二级菜单**且菜单项**仅含参数名与设定值**。
     原证据（copy-check 的"设备参数次要展示区用词"）对应的是被移走的旧版面，故改指 ui-check
     的新断言。同一段的另两条也可承接本条（列此备核，本行只登记一条）：
       · `FR-3.16 相机二级菜单不含实测值/偏差/状态：正文无"偏差"、无三态字面量；且只改 real 段实测值后菜单渲染**逐字不变**`
       · `FR-3.16 二级菜单下给出归属说明行（上位机侧设备参数，不参与本看板判定）` */
  ['FR-3.16', 'covered-direct', 'ui-check.js', 'FR-3.16 相机参数二级菜单只含参数名 + 设定值两列：表头列集恰为「参数/设定值」、每行恰 2 格'],
  ['FR-3.9,FR-3.10,FR-3.11,FR-3.12', 'covered-indirect', 'ui-check.js', '深度与速度数值格式统一'],
  ['FR-3.13', 'covered-indirect', 'ui-check.js', '单任务五态在模拟数据中可达'],
  /* V1.33 改判（FR-3.14）：判定对象明确为**深度与速度的测试标准值**，三态（正常/临近/超范围）
     **只用于深度与速度**，相机参数不做判定。原证据「FR-3.14 超阈值判定」已随本批改写消失
     （ui-check 里已不存在），故改指新口径的断言。同段另一条可承接"相机参数不做判定"（备核）：
       · `FR-3.14/FR-3.16 相机参数不做判定：四项实测值推成离群值后二级菜单渲染逐字不变、且无三态字面量` */
  ['FR-3.14', 'covered-direct', 'ui-check.js', 'FR-3.14/FR-3.18 三态判定只用于深度与速度：#tkStdTable 的深度/速度两行都渲染出三态列（std-state）'],
  ['FR-3.15', 'backend-phase', '', '曲线"按任务完成刷新一次"需服务端固化流程（DR-19）+ 任务完成事件，纯前端 Demo 只有一个节拍，无法验证刷新时机'],
  ['FR-3.17', 'covered-indirect', 'ui-check.js', '无在测工单时应显示'],
  /* V1.33 新增条款（P0）：FR-3.18「测试标准上下限与典型值的**显示**」、
     FR-3.19「测试标准上下限的**录入与修改**（八步）」。两条的现有证据都在 ui-check 的 U3c 段。
     V1.35 / C-90 改判（**显示与录入对象**）：「上限 / 下限绝对值」→「**典型值 / 上偏差 / 下偏差**」
     （三个单元格均可录入）；上限＝典型值＋上偏差、下限＝典型值＋下偏差为**只读导出值**
     （第 5 格 `.std-derived`，无 `data-edit`、无 `std-num`）；**判定对象仍是导出的上下限**
     （三态/临近/超量程与 `DR-03` 列均不变）。C-89 另改 FR-3.19④ 的量化参数：**1 s ± 50 ms 闪烁、高亮框 2 px**。
     V1.36 / C-95（**版面**，U-4）：消除测试标准区"预期外换行" —— 参数名与三态徽标同排不换行、
     第 5 格只读导出值一行显示（不得省略号截断、不得丢"上限/下限"字样）、**表头仍允许换行**（有意保留）；
     C-95 明示修法**限于样式与列宽**（`white-space`／列宽／内边距）、**不改 DOM 结构、不改判定与数据语义**。
     V1.36 / C-96（**文案**，U-5）：说明行 `#tkStdMeta` 精简为**只有一句**「典型值 / 上偏差 / 下偏差三格可录入」，
     长句与尾部 meta 删除；**界面事实未丢失**（只读导出值仍在第 5 格显示、班组在页头、生效时间与版本在留痕）。
     本段**只改描述与判据、不新增/不删除条款归属**（分母仍 259、P0 仍 188 —— 与 §0.2 自述一致）。
     ⚠️ 本表结构是"一条条款一条证据"，故每条只登记一条；同段其余断言列此备核（均逐字取自 ui-check.js，
     改名即由第二节/第八节⑤的"证据可核实"检查当场变红）：
     FR-3.18（显示类：五列结构 / 三格可录入 + 导出值只读 / 导出值实算 / 单位与两位小数 / 说明行逐字口径 / **不换行的版面声明** / 三态 /"临近"判据）：
       · `FR-3.18 测试标准区显示深度/速度两行、五列（检测参数/典型值/上偏差/下偏差/上限·下限（导出）），且每行恰三个可录入格（data-edit = <kind>Typical / UpperDev / LowerDev）`
       · `FR-3.18/FR-3.19 上限·下限为**只读导出值**：第 5 格 .std-derived 无 data-edit、无 std-num（上下限不可直接录入）`
       · `FR-3.18 深度单位 m、速度单位 m/s，且三格与导出值一律保留两位小数（位数读配置 standards.digits）`
       · `FR-3.18（U-5 / C-96）说明行逐字只有一句「典型值 / 上偏差 / 下偏差三格可录入」：不含导出公式长句、不含「只读导出值」「典型值不参与判定」、不含尾部 meta（班组/生效时间/版本），且渲染仍不写 state`
       · `FR-3.18（U-4 / C-95）**根因修复点**：第 5 格只读导出值不换行 —— `.std-limits.compact .std-derived` 的 white-space === nowrap`
       · `FR-3.18（U-4 / C-95）参数名与三态徽标同排不换行：`.std-limits.compact .std-name` 与 `.std-limits .std-state` 的 white-space 均 === nowrap`
       · `FR-3.16（U-4 / C-95 有意保留）表头仍允许换行：`.std-limits th` 的 white-space === normal（正向断言，防"顺手改掉"）`
       · `FR-3.18（U-4 / C-95 宽度账）第 5 格字号取 U-1 区间 [36,40] px（实测上界 40）且 `.std-limits.compact td` 横向内边距 6 px（余量来源）`
       · `FR-3.18/FR-3.14 超范围红、临近黄（三态只用于深度与速度）：临近判据＝实测距边界 ≤ (上限−下限)×nearRatio（比例读配置）`
     ⚠️ U-4 的**渲染结果**（真机上是否真的只有一行）机器证明不了静态声明：那份证据在
     browser-check 的 B5b 段（3840×2160、`?tab=1`、强制徽标＝「超范围」、逐格量 `Range` 包围盒）——
     它**依赖浏览器权限**、在本受限环境整脚本跳过，故**不登记为本行的证据**（本行仍记 ui-check 的实算断言），
     也不计入"离线可验证覆盖"（browser-check 在 `ONLINE_ONLY` 集合内）。
     ⚠️ V1.36（U-1）另有一条**版面**要求：「测试标准区**占满卡片剩余高度**」。它的**真机**证据由
     `browser-check` 的 **B5c** 段承接（3840×2160、`?tab=1`：量 `#tkStdTable` 实际高度与卡片剩余高度之比、
     两行行高相对自然高度的拉伸倍数，并含页内 `flex:none` 对照），与 B5b **同口径**：
     **browser-class，不登记为离线可追溯覆盖**（browser-check 在 `ONLINE_ONLY` 集合内）；
     本行仍只登记 ui-check 的**声明层**断言（`.std-limits{flex:1;min-height:0;height:100%}`）。
     FR-3.19（录入类：三格均可录入 / 反色+高亮 2 px+1 s 闪烁 / 回车与失焦注入 / 整体平移 / 六类校验弹窗且不写入 /
              逐单元格留痕含时间戳与班组编号 / 锁定后点击无响应）：
       · `FR-3.19 第4步 反色、高亮框（2 px）与 1 s ± 50 ms 闪烁的样式契约齐备（@keyframes stdBlink + .is-editing 的 animation/box-shadow/反色文字）`
       · `FR-3.19 第⑤⑥步 无符号输入按默认口径（下偏差默认负）：回车退出并注入，导出下限＝典型值＋(输入取负)，画面随之刷新`
       · `FR-3.19 第⑤⑥步 无符号输入按默认口径（上偏差默认正）：失焦（点击其他区域）退出并注入，导出上限＝典型值＋输入、下限不动`
       · `FR-3.19 第⑥步/FR-3.18 改典型值 ⇒ 导出上下限**整体平移**（同幅同向）、两个偏差格与跨度不变（按 state 实算，非硬编码）`
       · `FR-3.19 第⑦步 成功留痕（①内容）：state.opLog 末条写明**被改单元格名**与**修改前后值**（按元数据实算，非字面比对）`
       · `FR-3.19 第⑧步 锁定后点击数字不进入录入态并给出可观察反馈（#tkStdEdit 隐藏、该格无 is-editing、#tkStdMsg 明示"当前已锁定…解锁"）` */
  ['FR-3.18', 'covered-direct', 'ui-check.js', 'FR-3.18 上限＝典型值＋上偏差、下限＝典型值＋下偏差（按配置 default 段与 state 实算，非硬编码）'],
  ['FR-3.19', 'covered-direct', 'ui-check.js', 'FR-3.19 第⑥步 校验用例齐备（≥6 条：非数值 / 小数位非法 / 典型值带负号 / 下偏差 > 上偏差 / 上偏差为负 / 下偏差为正 / 超量程），每条都「弹窗 + state 逐字不变 + 无残留 is-editing + 被拒留痕」'],

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
  /* V1.34（C-88）改判（FR-5.8 细分）：参数类预防性预警由**一条**细分为**两条具名** ——
     「参数阈值临近预警」（黄，实测落入临近带）与「参数超范围预警」（红，实测越过上/下限）；
     判定对象＝**深度与速度的测试标准上下限**（FR-3.14 / FR-3.18）、**相机参数不参与**、
     标准未设定则两条都不产生；参数类**最多 2 条**（一个参数最多一条，深度/速度各按最坏态择名）。
     故把 FR-5.8 从"预警区按字典渲染（覆盖 5.8～5.11）"这行**粗归属**里拆出来单独登记 ——
     原行只证明"预警列表会渲染"，证明不了 FR-5.8 细分后的**名称集合与条数口径**。
     同段另一条可承接本条（备核，逐字取自 ui-check.js）：
       · `FR-5.8～5.11 预防性预警区按字典渲染标题与详情（判定对象＝深度与速度的标准上下限，相机参数不参与）`
         —— 它锁住两条具名预警的**标题/详情/黄红等级色**都按字典渲染（夹具已按 C-88 换成两个新名）。 */
  ['FR-5.8', 'covered-direct', 'ui-check.js', 'FR-5.8 参数类预警为两条具名（参数阈值临近预警 / 参数超范围预警）且至多 2 条、名称与等级色一一对应、相机参数不参与（无相机参数类预警名）'],
  ['FR-5.9,FR-5.10', 'covered-direct', 'ui-check.js', 'FR-5.8～5.11 预防性预警区按字典渲染标题与详情'], ['FR-5.11', 'covered-direct', 'harness-check.js', 'FR-5.11/C-108 行为·**真计数①**（非零「已完成」驱动）：同一票推三帧、第 2 帧 `testStatus=2` ⇒'],
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
  /* 2026-09-22（F-02 跟随单）：原证据是源码正则（"有没有 5*60 的计时"），属静态写法匹配，
     且 F-02 的时序缺陷正说明它锁不住语义。改指 ui-check 的行为断言 —— 它走真路径
     SettingPanel.bind → 解锁 → 触发 300000 ms 回调，断言锁定态与 2 s 弹窗显隐，故升 covered-direct。 */
  ['FR-8.2', 'covered-direct', 'ui-check.js', 'F-02 自动锁定行为（FR-8.2）：解锁后登记 300000 ms 定时器 → 回调置为锁定并弹出提示 → 2000 ms 后自动隐藏'],
  ['FR-8.3,FR-8.4', 'declared-gap', '', 'README 已知限制 1：前端明文密码，正式实现须服务端校验与哈希'],
  ['FR-8.5,FR-8.6', 'covered-indirect', 'ui-check.js', 'FR-8.6 设置页提供关键参数配置入口'],
  ['FR-8.7', 'covered-indirect', 'ui-check.js', 'FR-8.7 / NFR-15 解锁后的写操作留痕'],

  /* FR-9 页面与交互 */
  ['FR-9.1,FR-9.3', 'covered-direct', 'browser-check.js', '切换 8 个标签页'],
  ['FR-9.2', 'covered-indirect', 'browser-check.js', '默认首页是「设备状态」'],
  /* 2026-09-22（F-02 跟随单）：原证据 browser-check 的 B6 需浏览器权限、本环境不可复跑（属 §3b 的
     在线类）。改指 ui-check 的 F-02 时序护栏 —— 它**离线**直接锁住 FR-9.4 的两个可机检口径：
     默认值 310000 ms（5 分 10 秒）与"须晚于 FR-8.2 的锁定时刻"（差值恰 10000 ms）。
     残留（如实登记）：**"无操作后真的切换回首页"这一行为**仍只有 B6 断言（B6 断言未删，
     只是不再是本行证据），纯前端离线夹具不跑定时器链 + `TabsBar.setActive`，故不冒充。
     归属仍记 covered-direct：证据的断言名含条款编号，且直接断言的正是该条款的数值与先后关系。 */
  ['FR-9.4', 'covered-direct', 'ui-check.js', 'F-02 时序护栏（FR-8.2/FR-9.4）：AUTO_LOCK_MS < IDLE_RETURN_MS 且差值恰为 10000 ms（锁定先于回首页 10 s）'],
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
  /* V1.31（C-62）新增条款 UI-20：待补传清单与人工重报入口（P0）。
     **2026-09-28 改判（W7-A 收口件）**：本条原记 declared-gap（"需求要了、界面未开发"；需求 :595），
     现改判 **covered-indirect** —— 依据两条**已落地**的机器证据（逐条见第 5 列"依据一句话"）：
     ① 服务端（主证据，锚点即第 4 列）：`GET /upload/{pending,status}` 与 `POST /upload/retry`
        （人工一键重报：按最旧优先逐条补传、重复调用幂等、失败仍留存）已有 db-check 端到端断言（真 HTTP + 真 upload_log）；
     ② 前端：W5-② 已实现设置页"待补传清单 + 人工重报入口"并接 `fetchPending()` → `/upload/pending`（ui-check 覆盖取数接线）。
     ⚠ 界面**交互**专项断言待 W7-B 在 `tests/ui-check.js` 落地后可再升 `covered-direct`；本行**不冒领**：证据文本逐字取自所引脚本。 */
  ['UI-20', 'covered-indirect', 'db-check.js', 'W4/IF-B.9＋UI-20：**人工一键重报**按**顺序**（最旧优先）逐条补传', 'V1.31（C-62）新增条款，2026-09-28 由 declared-gap **改判 covered-indirect**：服务端 `/upload/{pending,status}`＋`POST /upload/retry` 的端到端（按序补传、幂等、失败留存）已有 db-check 断言；前端 W5-② 已实现设置页待补传清单与人工重报入口并接 `/upload/pending`（ui-check 覆盖取数接线）。界面交互专项断言待 W7-B 在 ui-check 落地后可升 covered-direct；本行**不冒领**界面断言'],

  /* IF 接口需求 */
  ['IF-A.*', 'backend-phase', '', 'IF-A 需看板服务端接收端点，纯静态 Demo 无服务端'],
  ['IF-B.1,IF-B.2,IF-B.3,IF-B.4,IF-B.6,IF-B.7,IF-B.10', 'backend-phase', '', '需真实 MES 接口与日志留存（DR-11）'],
  /* V1.33 改写（IF-B.5）：`uclValue`/`lclValue` **取绝对值**（＝典型值 ± 偏差）、**任一必要项缺失即该条
     `tagParam` 整条占位**（`65535` / `IsPass=null`），并覆盖三类缺失组合。该条**已有服务层实证**
     （db-check 六之六段），故从上面那行"需真实 MES 接口"的整段 backend-phase 里**拆出来单独登记** ——
     整段归属对它过粗（原登记既没证明也没否定它有实证）。同段其余断言列此备核（逐字取自 db-check.js）：
       · `IF-B.5：三类缺失组合（只设一项指标 / 只设上偏差 / 只设偏差未设典型值）在 depth 与 speed 两条 dataList 上`
         （断言名首段，原式在源文件里跨行拼接）
       · `IF-B.5：标准整条不存在（null）时同样整条占位，且结构不缺项（恰好三个键）` */
  ['IF-B.5', 'covered-indirect', 'db-check.js', 'IF-B.5：占位是**整条**而不是"缺哪个补哪个" —— 深度自身完整（绝对值可算出 5.20/4.80）但速度缺项 ⇒ 该条 depth 也占位'],
  ['IF-B.8', 'covered-direct', 'contract-check.js', '上报报文含附录 2 全部 13 个字段'],
  /* V1.31（C-58）改判证据：原「补传：链路恢复后 flushPending 补齐队列」已随需求废止
     （flushPending 现在**只刷新状态、不发送**；发送只走人工入口 retryPending）。
     证据改指 contract-check D 段新建的**人工重报**断言 —— 它同时锁住
     "不自动重发 + 失败报文留存队列 + 人工入口才发送"三件事。 */
  ['IF-B.9', 'covered-indirect', 'contract-check.js', '人工入口才发送：retryPending 重报后仍失败者保留且次数累加、成功者移出队列（6.10 后半 · IF-B.9 V1.31）'],
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
  ['DR-01,DR-02,DR-05,DR-06,DR-07,DR-08,DR-09,DR-10,DR-18', 'covered-indirect', 'db-check.js', '一、建表与结构（DR-01～DR-12、DR-18）'],
  /* V1.33 改写（DR-03，追加式版本模型）：`standard` 改为**新标准＝新版本行、不覆盖旧行**，
     唯一键 =(product_code, process_code, version_no)，列集换成深度/速度的典型值与上下偏差，
     **指定时刻 t 的生效版本＝该 (产品,工序) 下 `effective_from ≤ t` 的最大 `version_no`**
     （FR-3.18 的显示与判定即按此取值）。旧模型的相机设定值列（set_depth/set_gain/
     set_frame_rate/set_shutter）随之退出 `standard`（相机参数不参与本看板判定）。
     故从上面那行"一、建表与结构"的**粗归属**里拆出来单独登记（原行只证明"表在"，
     证明不了追加模型的三条语义）。同段其余断言列此备核（逐字取自 db-check.js）：
       · `DR-03：唯一键 (product_code, process_code, version_no) 生效 —— 同键第二行被拒，报错点明三列`
       · `DR-03：指定时刻生效版本 —— t=T1 与 T1<t<T2 取 v1，t=T2 与 t>T2 取 v2（effective_from ≤ t 的最大 version_no）`
       · `DR-03：version_no 只增不改 —— 再次 addVersion 得 v3，历史 v1/v2 两行逐列未被改写，且 t<T1 仍返回 null`
       · `DR-03：旧库迁移**只发生一次** —— 再跑 initSchema 时 migrated=false 且既有版本行逐列原样（未被重建/未被清空）`
       · 段标题（section）：`六之三、DR-03 标准表唯一键（产品＋工序＋版本，需求 V1.33）`、`六之四、DR-03 追加式版本模型（不覆盖旧行 / 指定时刻生效 / 版本号只增）` */
  ['DR-03', 'covered-indirect', 'db-check.js', 'DR-03：追加不覆盖 —— 写入第二版后 v1 行仍在且**逐列原样**（数值/生效时间/录入人/班组均未被改写）'],
  /* V1.33 改写（DR-12）：`op_log` **增列班组编号 `team_code`**（来源＝当前生效班次的班组，
     与 FR-1.6 同一真源）。同样把它从"一、建表与结构"的粗归属里拆出来单独登记。
     同段其余断言列此备核（逐字取自 db-check.js）：
       · `DR-12：班组编号可写可读 —— 按班组过滤查回的行数/内容与写入一致（不串号、不丢班组）`
       · `DR-12：countByTeam 计数正确（检验一班 2 / 检验二班 1 / 未知班组 0，且支持时间区间收窄）—— 审计"哪个班组做了什么"`
       · `DR-12：未传班组写 NULL（不猜、不按操作人反查）—— 与"班组来源唯一＝当前生效班次"一致`
       · `DR-12：旧库（op_log 无 team_code）经 initSchema 后列补齐且索引起来，旧留痕行一行不丢、原字段原样、team_code 为 NULL` */
  ['DR-12', 'covered-indirect', 'db-check.js', 'DR-12：op_log 有 team_code 列（V1.33 增列），append 回传的班组编号与入参一致'],
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
  /* V1.31（C-60）改判证据：NFR-13「数据不丢失」的 MES 侧新口径 = **本地持久化留存、由人工重报**（见 UI-20）。
     故改指人工重报断言 —— 它正对题地锁住两句：①"仍失败者保留在队列且次数累加"＝留存不丢；
     ②"只由人工入口发送"＝由人工重报。（另一条「只刷新不发送…」措辞更贴近 NFR-10 的"补传由人工触发"，
     本行不采用；NFR-10 归属本文件维持 backend-phase 不动。） */
  ['NFR-13', 'covered-indirect', 'contract-check.js', '人工入口才发送：retryPending 重报后仍失败者保留且次数累加、成功者移出队列（6.10 后半 · IF-B.9 V1.31）'],
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
   ⚠️ **AC 走独立分母，绝不并入上面的 259 条**：需求 §0.2（`需求文档\…-V1.41.md:280`）已声明
   AC「**不计入上方需求条款合计**（验收口径，非功能条目；重复计入会与"每条条款都有归属"的追溯分母冲突）」。
   故本表的归属**只进"AC 覆盖 X / 12"这一行**，`可追溯覆盖合计 X / 259` 的分子分母一律不受影响。
   条目格式与 MAP 完全一致：[AC 编号, 状态, 证据脚本, 证据文本]；状态词表沿用本文件头部。
   **证据纪律**：本表只登记**现有**证据，不刷覆盖率 —— 没有对应断言的一律 `script: ''`，
   并在第 5 列写明"为什么没有"；把**浸泡预设 8 小时**（`--soak` / `--hours 8`）当 7 天、把 SKIP 当通过都属不合格（见 AC-07 / AC-12）。
   立案：架构评审报告 A-2026-09-20-01 的 P1-2（`项目记录\架构评审报告-2026-09-20-01.md:69`–`76`）。 */

/**
 * 全部 AC 验收标准（AC-01～AC-12），取自需求清单的表格行。
 * ⚠️ 与 `requirementClauses()` **故意分开**：那个函数的口径是 §0.2 的 259 条需求条款，
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

/* ==========================================================================
   第 10 章交付物清单（第七节的数据源；T-20260920-06）
   --------------------------------------------------------------------------
   为什么单列：AC-12（需求 :841「第 10 章交付物齐全并通过审核」）的判定对象是**第 10 章
   （需求 §10 :805 起、表在 :809–822）的 12 项交付物**。原先 AC-12 的依据只按 `输出文件\` 一个目录
   得出"其余 10 项无交付件"这样的**粗判定**；本节把 12 项**逐项**对上仓库落点，
   把"有没有"变成可核查的数字（口径与 AC 一致：**不计入 259 条分母**）。

   三条纪律：
     ① **清单从需求原文解析**（`deliveryItems()`），不把 12 项写死在断言里 —— 需求升版增删
        交付物时，解析结果与台账立刻对不上，断言变红逼人复核，而不是继续"数着旧清单"；
     ② 判定只回答"**仓库里有没有对应产物**"，**不能**回答"是否齐全""是否通过审核"
        （后两者属人工评审；机器证明不了）；
     ③ "尚未产出"在 10 月开发冲刺之前**属时间表内的正常状态**（交付方式见需求 :807：
        与硬件一起实物交付、交付节点 = 12 月底父项目 M6 现场终验收），故一律记"待交付"，
        **不写成项目缺陷**。
   ========================================================================== */

/** 需求原文第 10 章交付物表的每一行 → {seq, name, desc}（**不硬编码清单**） */
function deliveryItems() {
  const out = [];
  try {
    const file = fs.readdirSync(path.join(ROOT, '需求文档')).find(f => f.endsWith('.md'));
    const lines = fs.readFileSync(path.join(ROOT, '需求文档', file), 'utf8').split('\n');
    const start = lines.findIndex(l => /^##\s*10\./.test(l));
    if (start < 0) return out;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break;                       // 第 10 章结束（下一个二级标题）
      const m = lines[i].match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]*)\|\s*$/);
      if (m) out.push({ seq: Number(m[1]), name: m[2].trim(), desc: m[3].trim().replace(/\s+/g, ' ') });
    }
  } catch { /* 读不到就当解析不出，由第七节的 requires 如实报"前提不成立" */ }
  return out;
}

/** 交付物判定词表：present＝仓库内有直接产物；partial＝只有组成部分/素材，本体待成文；
 *  missing＝仓库内无任何对应产物（**待交付**）。写错词会让第七节的计数自洽断言变红。 */
const DELIVERY_VERDICTS = new Set(['present', 'partial', 'missing']);

/* 冻结基线：需求 V1.38 §10 的交付物**行数**（实测 12）。
   注意这**不是**交付物清单 —— 清单逐项从需求原文解析（`deliveryItems()`）。
   冻结一个数的目的：需求若增删交付物，本断言必须**变红**，逼人回来复核台账。 */
const BASELINE_DELIVERABLE_COUNT = 12;

/** 第 10 章 12 项交付物的**逐项落点与判定**（按 `name` 与需求原文对号，空白差异已归一）。
 *  `paths` 为仓库相对路径；判 missing 的项必须为空数组（否则判定与证据自相矛盾）。 */
const DELIVERY_LEDGER = [
  { name: '看板系统实物', verdict: 'missing', paths: [],
    basis: '需求 :811：看板主机（软件预装）+ 独立 75″ 电视 + 有线键鼠 + 线材的**成套实物**。仓库内无任何产物（无硬件清单、无装机记录），记"待交付"；交付方式见需求 :807（与硬件一起实物交付，节点 = 12 月底父项目 M6 现场终验收），属时间表内状态。' },
  { name: '需求规格说明书', verdict: 'present',
    paths: ['需求文档\\水池高速摄像生产管理看板-详细需求清单-V1.41.md',
      '需求文档\\水池高速摄像生产管理看板-详细需求清单-V1.41.docx'],
    basis: '需求 :812「本清单评审定稿后形成基线」—— **需求清单本身即该交付物**：.md 为基线正文、.docx 为交付件，两者都在库。⚠️ "是否已评审定稿"属人工评审，本节只能证明文件在库。' },
  { name: '系统设计说明书', verdict: 'partial',
    paths: ['项目架构与技术栈.md', '项目记录\\ADR\\ADR-0001-后端形态与运行时选型.md',
      'server\\db\\schema.sql', 'src\\config\\fieldMap.js'],
    basis: '需求 :813 要求的四类内容（架构、模块、数据库设计、字段映射表）在库都有**素材**：架构与技术栈说明、ADR-0001（DB 形态/运行时）、建表脚本、三方字段映射。但**未成文为《系统设计说明书》**（无该交付件），本体待编制。' },
  { name: '界面原型 / UI 设计稿', verdict: 'partial',
    paths: ['src\\assets\\screenshots', 'tests\\screenshots-baseline'],
    basis: '需求 :814「按 4K@30Hz 大屏设计，8 个标签页全量出图」：`src\\assets\\screenshots\\` 有 10 张 4K 交付截图（8 标签页 + 曲线空态 + 上位机断连降级），`tests\\screenshots-baseline\\` 有 10 张 1080p 基准图。但那是**已实现界面的运行截图**，不是设计稿/原型（无设计源文件、无原型工程、无交互标注），故记部分。' },
  { name: '数据库脚本与初始化数据', verdict: 'partial',
    paths: ['server\\db\\schema.sql', 'server\\db\\index.js', 'src\\config\\board.config.js'],
    basis: '需求 :815「建表脚本、字典数据」：建表脚本在库（`schema.sql` 13 张表、幂等、DR-01～DR-19）、初始化写入在库（`index.js` 的 `initSchema()` 落结构版本与指纹、`seedInitialData()` 落设备初始数据）；但**字典数据只有结构与示例**（`board.config.js` 的 `faultDict` 自注"内容待补全"），内容待上位机方答复 Q-12/Q-13（快照 §5.1），故记部分。' },
  { name: '源代码与构建说明', verdict: 'partial',
    paths: ['src', 'server', 'platform', 'index.html', 'README.md'],
    basis: '需求 :816「看板服务 + 前端 + 配置」：源代码在库（前端 `src\\`、看板服务起始 `server\\`、平台适配 `platform\\`、入口 `index.html`）。但**构建说明没有成文交付件** —— 本项目本就无构建步骤（纯静态 + Node 内置、零 npm 依赖），`README.md` §一 只给"怎么跑起来"；且 `server\\` 尚无进程入口（只有 db/repo/services），"看板服务"还没成形为可构建产物，故记部分。' },
  { name: '安装包与部署手册', verdict: 'missing', paths: [],
    basis: '需求 :817「支持现场一次部署成功」：仓库内无安装包（根目录无 `package.json`，无 .msi/.exe/打包产物）也无部署手册；需求侧对应 DEP-01/DEP-07（本文件主表已分别记 backend-phase / declared-gap），快照 §六 第 6 项"部署脚本与运维文档"仍为"待开始"。记"待交付"。' },
  { name: '接口联调文档与测试报告', verdict: 'partial',
    paths: ['输出文件\\上位机方\\接口需求函-致设备上位机方.md', '输出文件\\MES方\\接口澄清函-致MES方.md',
      'tools\\mock-upper\\README.md', 'tools\\mock-mes\\README.md'],
    basis: '需求 :818「IF-D（上位机）与 IF-A/IF-B（MES）联调、补传验证记录」：**接口契约侧**文档在库（致上位机方接口需求函、致 MES 方接口澄清函、模拟上位机与模拟 MES 的说明）；但**联调本身尚未发生**（三方答复待 09-25，Q-21/Q-23），无联调记录、无补传验证记录文档，故记部分。' },
  { name: '测试报告', verdict: 'partial',
    paths: ['tests\\README.md', '项目记录\\审查报告-2026-09-19.md', '项目记录\\审查报告-2026-09-19-第二次.md'],
    basis: '需求 :819「功能、性能、4K 显示、断链、7×24 稳定性」：机器可复跑的测试资产与两轮审查报告在库（`tests\\` 13 个离线门禁 + 脚本表 + 缺陷清单与处置）。但**面向交付的《测试报告》未成文**，且需求点名的"性能 / 4K 显示 / 7×24 稳定性"三项**无结论**（7×24 稳定性即 AC-07：现有证据只有 `stress-check` 的**浸泡预设 8 小时**（`--soak` / `--hours 8`；该脚本**默认运行只有 20 分钟**，8 小时不是默认值），且在本受限环境整脚本跳过），故记部分。' },
  { name: '用户操作手册 / 运维手册', verdict: 'missing', paths: [],
    basis: '需求 :820「解锁、维保录入、公告维护、故障处理」：仓库内无面向用户/运维的手册；`README.md` §三「演示交互」与 §四「数据口径」是**开发者向**说明，不构成本交付物；DEP-07 已登记部署/运维/排障手册缺失（declared-gap）。记"待交付"。' },
  { name: '培训与验收报告', verdict: 'missing', paths: [],
    basis: '需求 :821「现场培训记录与实物演示验收结论」：培训与实物演示验收都发生在交付节点（12 月底父项目 M6 现场终验收）的现场，仓库内无记录。记"待交付"。' },
  { name: '质保承诺书', verdict: 'missing', paths: [],
    basis: '需求 :822「质保 2 年，含响应时限」：仓库内无质保承诺书文本；需求 DEP-14（:800）的"质保 2 年、故障响应 ≤4 小时 / 重大故障 ≤24 小时恢复"是**要求**，不是已出具的承诺书。记"待交付"。' }
];

/**
 * 逐项统计：需求解析结果 × 台账判定 × **声明路径的真实存在性**。
 * `evidenced` 是**独立于判定词**的第二个来源（只认"声明路径全部真实存在"的项数），
 * 用来发现"判定与文件系统脱节"——判定写 present 而文件不在、或写 missing 却还挂着路径。
 * @returns {{items:Array, rows:Array, present:number, partial:number, missing:number,
 *            inRepo:number, evidenced:number, unmatched:Array<string>,
 *            unmatchedLedger:Array<string>, badVerdicts:Array<string>}}
 */
function deliveryTally() {
  const key = (s) => String(s).replace(/\s+/g, '');
  const items = deliveryItems();
  const byName = new Map(DELIVERY_LEDGER.map(e => [key(e.name), e]));
  const rows = items.map(it => {
    const e = byName.get(key(it.name)) || null;
    const paths = e ? e.paths.slice() : [];
    return {
      seq: it.seq, name: it.name, desc: it.desc,
      verdict: e ? e.verdict : null, basis: e ? e.basis : '',
      paths, missingPaths: paths.filter(p => !fs.existsSync(path.resolve(ROOT, p)))
    };
  });
  const count = (v) => rows.filter(r => r.verdict === v).length;
  const present = count('present');
  const partial = count('partial');
  const missing = count('missing');
  return {
    items, rows, present, partial, missing,
    inRepo: present + partial,
    evidenced: rows.filter(r => r.paths.length && r.missingPaths.length === 0).length,
    unmatched: rows.filter(r => !r.verdict).map(r => `${r.seq}.${r.name}`),
    unmatchedLedger: DELIVERY_LEDGER
      .filter(e => !rows.some(r => key(r.name) === key(e.name))).map(e => e.name),
    badVerdicts: DELIVERY_LEDGER
      .filter(e => !DELIVERY_VERDICTS.has(e.verdict)).map(e => `${e.name}=${e.verdict}`)
  };
}

/** AC-12 的"依据"文句：**在库项数由台账派生**，避免"清单里 7 项、依据里写 5 项"这种两处各写一份。
 *  （第七节的第 6 条断言仍会把落盘数字与**当场重新派生**的数字比一遍，防手改这份文句。） */
const DELIVERY_TALLY = deliveryTally();

/** AC 追溯表（见上方口径说明） */
const AC_MAP = [
  /* ——— 有机器证据可复跑的一类 ——— */
  ['AC-03', 'covered-indirect', 'ui-check.js', '单次 tick + 10 个组件全量重绘耗时',
    'NFR-01/NFR-02 的"秒级刷新"侧：ui-check 实测单次 tick + 10 个组件全量重绘 < 200 ms（实跑约 0.1 ms，见 tests\\README.md 的性能微基准（U5）实测；该文件本轮重排过，故只引小节名、不钉行号），1 秒周期余量充足；但"状态与参数秒级刷新"的端到端时延与时钟推进本身要真机/浏览器（stress-check 的"时钟持续推进"断言在本环境整脚本跳过），故记间接。'],
  ['AC-06', 'covered-direct', 'contract-check.js', '数据冻结时界面判据 state.device.link 转为断连',
    '断链降级判据有直接断言：数据冻结后 state.device.link 转 offline；**MES 方向由人工重报不缺失**（contract-check：6.10 前半"异常回执判为失败并进入待补传队列"锁住失败报文留存，6.10 后半"人工入口才发送：retryPending 重报后仍失败者保留且次数累加、成功者移出队列"锁住人工重报不丢数；flushPending 只刷新状态与告警、不发送）+ 重开后行数不变且去重键仍生效（db-check）承接；**该验收方式变更已获批准**（2026-09-21 经项目负责人审批；**审批权限由甲方下放**）（需求 C-61：恢复后上位机方向自动补收无缺失；MES 方向由人工经 UI-20 重报、不缺失）。界面横幅与离线文案由 browser-check 断言（本环境不可复跑）。'],
  ['AC-08', 'covered-direct', 'ui-check.js', 'FR-5.4 报警卡显示闭环状态',
    '故障→报警→处理→闭环的界面链路：报警编号/类型、描述与处理信息（发生时间/等级/处理人/处理措施）、闭环状态均按行断言，且当班异常台账接收新闭环报警（contract-check）。"留痕可追溯"的**存储侧**需后端/部署阶段。'],
  ['AC-09', 'covered-indirect', 'ui-check.js', 'FR-3.19 第⑧步/AC-09 未解锁时点击典型值/上偏差/下偏差任一数字都不进入录入态：#tkStdEdit 保持隐藏、正文无 is-editing、录入行内无可聚焦的 #tkStdInput',
    'V1.35（C-93②：FR-8.1 / FR-8.6 / NFR-19 同措辞对齐）把判定标准补成"未解锁无法修改**维保 / 公告 / 测试标准典型值与上/下偏差**"（**上/下限是 `典型值 ± 偏差` 的导出值、不可直接录入**）——**任务数据页的录入入口同受设置页密码保护**。' +
    '"测试标准"这半句有直接断言：ui-check 走真路径（未解锁时**逐格**点击典型值/上偏差/下偏差 ⇒ `#tkStdEdit` 保持隐藏、正文无 `is-editing`、录入行内无可聚焦的 `#tkStdInput`；解锁后才进入录入态），' +
    '并与"锁定后点击数字不进入录入态并给出可观察反馈"互为对照；"维保 / 公告"的改动同由设置页解锁门控（同一个 `state.unlocked`），其解锁入口另有断言（ui-check 的 F-02 自动锁定行为、browser-check 的 ?unlock=1 启动即解锁 —— 后者依赖浏览器权限，本环境不可复跑）。' +
    '"无外网访问"有直接断言：index.html 不外链任何资源、src/ 不引第三方库（docs-check，NFR-25）；"密码策略有效"属 declared-gap（README 已知限制 1：前端明文口令，须服务端校验与哈希）。'],

  /* ——— 只有间接/前置件的一类 ——— */
  ['AC-04', 'covered-indirect', 'ui-check.js', 'UI-03 色彩规范',
    '**可机检的只有前置件**：大屏关键数据的字号下限（UI-04 逐角色断言）、UI-03 色彩规范、"航行器深度"已渲染（browser-check）都有断言；但"75 寸 4K@30Hz、4～8 m 距离清晰可读"是**现场人工观感判定**，机器断言只能证明"字号不低于规范下限"，**不构成**距离可读性的验收结论。'],
  ['AC-10', 'covered-indirect', 'logic-check.js', '累计运行持久化：重启不倒退、跨班次不清零（DR-17）',
    '"断电重启后数据恢复"的**数据侧**：logic-check 断言累计运行重启不倒退、db-check 断言重开后行数不变且去重键仍生效；但"重启后**无需人工干预自动恢复显示**"属部署/无人值守（DEP-02～DEP-06、ENV-20 自启与自动拉起），纯前端 Demo 无法验证。'],

  /* ——— 无机器证据的一类（如实标注，不用 8 小时或跳过充当通过） ——— */
  ['AC-01', 'manual', '', '',
    '"P0 条目 100% 实现并现场演示通过"的判定对象是**现场演示**与"P0 清单逐条过"的组织动作；trace-check 的"优先级×状态"只是**旁证**（V1.37 实跑口径：P0 188 条中可追溯覆盖 131 条 —— 以第五之二节的实跑输出为准 —— 这两个数**以第五之二节的实跑输出为准**，本节只作旁证引用，不另立真源），该比率**不等于**实现完备度（分子含间接验证，且部分 P0 依赖后端/硬件/现场），故不得据此声称 AC-01 满足，须人工/现场判定。'],
  ['AC-02', 'declared-gap', '', '',
    '"与 PC 上位机源头抽样比对一致率 100%"需要**真实上位机数据源**逐点抽样比对；Demo 用的是 mock 报文（contract-check 只证明缺字段不清零、字段映射可配置），**无从比对源头数据**，故为已声明缺口。'],
  ['AC-05', 'backend-phase', '', '',
    'IF-D 与上位机、IF-A/IF-B 与 MES 的**联调通过**属三方现场联调（IF-B.1～B.7/B.10、IF-D.7/D.10/D.12 亦整段归 backend-phase）；现有机器证据只到**契约层**（13 字段上报报文、两种回执风格、失败进入待补传队列——contract-check），接口函数名有断言而实现整批 pending，不足以构成联调结论。'],
  ['AC-07', 'declared-gap', '', '',
    '**⚠️ 唯一相关证据不构成满足**：验收要求"连续运行 ≥7 天无重启、无崩溃、无内存泄漏"（需求 :836），而现有唯一证据是 tests\\stress-check.js 的**浸泡预设 8 小时**整班次长跑（`--soak` / `--hours 8` 触发的浸泡预设；该脚本**默认运行只有 5 分钟**＝`DEFAULT_MINUTES = 5`，8 小时取自 `DSH_STRESS_HOURS || 8`，`stress-check.js`；tests\\README.md 的 5.3 节自己写明"**8 小时 ≠ 验收要求**"，另参照 NFR-05 的 72 h 与 NFR-06 的 30 天）；**且该脚本在本受限环境整脚本 SKIP**（`stress-check.js:252` 的 env.skipSuite；本环境禁命名管道 ⇒ 退出码 3，按项目口径"**跳过 ≠ 通过**"）。**浸泡预设 8 小时不得当 7 天、SKIP 不得当通过**：现有证据 0 条，故记 declared-gap。'],
  ['AC-11', 'declared-gap', '', '',
    '"看板软硬件成套实物交付 + 现场演示验收通过 + 与父项目 M6 对齐"属**商务与硬件交付**条款（与 DEP-12～DEP-15 同类），验收动作在现场/合同阶段，仓库内无对应机器证据，亦非纯软件可验。'],
  ['AC-12', 'declared-gap', '', '',
    /* 2026-09-20（T-20260920-06）：原依据只用**一个目录**（`输出文件\`）实盘，得"其余 10 项无交付件"；
       现改为**逐项落点**（第七节的台账），"在库 N/12"由台账派生，逐项依据见该节清单。
       归属类型**保持 declared-gap**：不升 `covered-*`（没有任何断言能证明"齐全/通过审核"），
       也不改 `manual`（"不齐全"是文件系统上的客观事实，不是人工判断）。 */
    `第 10 章交付物的**逐项落点**见本文件第七节（第 10 章交付物存在性台账，从需求原文解析、逐项 fs.existsSync 核实）：` +
    `**在库 ${DELIVERY_TALLY.inRepo}/${DELIVERY_TALLY.items.length}**（存在 ${DELIVERY_TALLY.present} 项＝②需求规格说明书即需求清单本身；` +
    `部分 ${DELIVERY_TALLY.partial} 项＝③系统设计说明书/④界面原型与 UI 设计稿/⑤数据库脚本与初始化数据/⑥源代码与构建说明/⑧接口联调文档/⑨测试报告，` +
    `均只有素材或阶段性产物、**本体待成文**）；**纯缺失待交付 ${DELIVERY_TALLY.missing} 项**＝①看板系统实物/⑦安装包与部署手册/⑩用户操作手册与运维手册/⑪培训与验收报告/⑫质保承诺书。` +
    '⚠️ **机器只能证明"有无"（文件在不在、有几项），不能证明"齐全"，更不能证明"通过审核"** —— ' +
    'AC-12 的判定对象是"12 项齐全 + 通过审核"，后半句属人工评审；交付方式见需求 :807（与硬件一起实物交付、节点 = 12 月底父项目 M6 现场终验收），' +
    '故"尚未产出"是时间表内的正常状态、**不是缺陷**，本项**不得**因本节的存在性断言而被读成"AC-12 已满足"。']
];

/** AC 归属类型词表（与本文件头部状态词表一致；AC 段靠它拦"写了个不存在的分类"） */
const STATUS_WORDS = new Set([
  'covered-direct', 'covered-indirect', 'fix-pending', 'declared-gap',
  'backend-phase', 'manual', 'subjective', 'out-of-scope'
]);

/* ---------------- 断言与工具 ----------------
   2026-09-20（T-20260920-06）：本脚本原自带一份 `check()`/`passed`/`failures`（与
   `tests\lib\assert.js` **逐字同规格**的手写副本）。为用上 `t.requires()`（ADR-0004 D20 前提独立）
   并统一风格，改用公共 runner：**8 条既有断言一一对应保留**（名字、判定式、detail 均未改），
   唯一语义变化是原先把"追溯表引用了不存在的条款"写成一条**匿名 failure**（不计入 passed），
   现按 D20 归入 `t.requires()` —— 前提成立时不计入断言数，前提塌掉时汇总单列"前提不成立"并退 1。 */

/** 需求清单里"表格行"口径的全部条款（与 §0.2 条目数一致）
 *  ⚠️ 2026-09-19 修复：原正则**漏掉了 ENV 系列（20 条）** —— 导致"每条条款都有归属"是**假的全覆盖**，
 *     且条款总数被少算成 236（V1.30 口径真实 256；V1.31 为 257；**V1.33 升版后为 259**）。ENV 是 §2「运行环境与显示约束」的编号，属需求正文的一部分。 */
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

/** 需求 §0.2 自述的"需求条款合计"（`| **合计（需求条款）** | **259** |` 那一行的数字）。
 *  用途：与 `requirementClauses()` **逐行解析**出的条数做**两个独立来源**的互校。
 *  为什么单列（V1.33）：本文件注释里凡写死"259"之处都只是解析口径的**镜像**；
 *  只靠 `owner.size` 动态打印时，注释与需求漂移没有任何东西会发现。
 *  核对手法：需求升版（或改 §0.2 合计）后本函数值与解析值立刻不等 ⇒ 第一节那条互校断言变红并点名两个数字，
 *  逼人先对齐分母、再改注释里的字面量。取不到（表结构改了）同样变红，不静默放过。
 *  @returns {number|null} §0.2 声明的条款合计；解析不到返回 null */
function declaredClauseTotal() {
  const file = fs.readdirSync(path.join(ROOT, '需求文档')).find(f => f.endsWith('.md'));
  const lines = fs.readFileSync(path.join(ROOT, '需求文档', file), 'utf8').split('\n');
  const row = lines.find(l => /^\|\s*\**合计（需求条款）\**\s*\|/.test(l));
  const m = row && row.match(/^\|\s*\**合计（需求条款）\**\s*\|\s*\**(\d+)\**\s*\|/);
  return m ? Number(m[1]) : null;
}

/**
 * 条款 → 优先级（P0/P1/P2）。**不假设优先级在第几列** —— 需求里各表结构不同：
 * FR/UI/NFR 表的末列是优先级，而 DR / IF-C / IF-0 表的末列是"备注/说明"。
 * 故扫描该行**任意单元格**里的独立 `P0`/`P1`/`P2`；取不到即返回 null
 * （不计入优先级统计，避免用错值算 AC-01 的分母）。
 *
 * 为什么要它（P3-12）：AC-01 要求"P0 条目 100% 实现"，而追溯覆盖率的分母是**全部 259 条**
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

/* ==========================================================================
   注释里的「需求行号引用」自检（第九节的数据与规则；T-20260924-T3）
   --------------------------------------------------------------------------
   立案依据（**实测**）：2026-09-24 的诚实性探针 M7 证明 —— 把本文件注释里的
   `需求 … :265` 改成 `:264`，脚本照样 **20/0 全绿、exit 0**。也就是说：本文件里**成体系**的
   需求行号引用当时**没有任何机器校验**，升版时极易集体漂移（V1.37 这一批就重导了 20 余处）。

   做法（三条，缺一不可）：
     ① **真源仍是当轮需求文件本身**（`需求文档\*.md`）。本节**不复制**任何需求正文，
        只做「引用 ↔ 真源」的对账：引用处的语义锚点 + 被引用行号那一行的原文，
        两边都要命中同一个锚点 —— 任一错位即红。
     ② `CITATION_LEDGER` ＝ **逐处清单**（哪一行、第几处、引用了需求第几行），
        `ANCHORS` ＝ 与它一一对应的锚点表（引用处长什么样 + 需求那一行该长什么样）。
        两侧由第九节的**双向对账**核实：源码里扫到的引用集合 ↔ 清单 ∪ 锚点 ∪ 豁免，
        多一处、少一处都变红（不许"把校验范围缩小到自己能过"）。
     ③ 判不出锚点的引用一律进 `CITATION_EXEMPT` / `XFILE_EXEMPT` 并**逐条给理由**；
        豁免清单为空是"当前没有"，不是"允许静默跳过" —— 豁免计数参与对账。

   ⚠️ 维护纪律（升版时）：需求升版重导行号后，本节的清单/锚点表**必须同步**；
      改完跑 `node tests\trace-check.js`，第九节会把"哪一处引用的行号或锚点对不上"直接点名。
      本文件顶部注释里写死的 `:242` 等行号，就是靠这一节守着的。
   ⚠️ 本节是"引用 ↔ 真源"的对账，**不构成**任何条款的实现证据（D19）。
   ========================================================================== */

/** 归一（比对用）：去掉空白与反引号 —— 只用于**比对**，绝不用于改写真源（真源仍是需求文件原文）。 */
function normSpace(s) {
  return String(s == null ? '' : s)
    .replace(/[`\s]/g, '')
    .replace(/¦/g, '')
    .replace(/（/g, '(').replace(/）/g, ')');
}

const REQ_DIR = path.join(ROOT, '需求文档');
const REQ_FILE = fs.readdirSync(REQ_DIR).find(f => f.endsWith('.md')) || null;
const REQ_LINES = REQ_FILE
  ? fs.readFileSync(path.join(REQ_DIR, REQ_FILE), 'utf8').split('\n').map(s => s.replace(/\r$/, ''))
  : [];
/** 本文件自身源码（**被检对象**：注释里的行号引用就在这里）。
 *  ⚠️ **锚点表与形态表所在的区块整段掩掉**：那些行里写的是"引用该长什么样"的**模式**，
 *  自身也含 `需求 …:805` 之类的字面 —— 不掩掉就会被当成真的引用（本节的自指陷阱，实测踩过）。
 *  掩码用空串替换，**行号与其余行的偏移量不变**。 */
const ANCHOR_REGION = (() => {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n').map(s => s.replace(/\r$/, ''));
  const a = lines.findIndex(l => /^const ANCHORS = \{/.test(l));
  const b = a < 0 ? -1 : lines.findIndex((l, i) => i > a && /^\};/.test(l));
  const c = lines.findIndex(l => /^const CITATION_PATTERNS = \[/.test(l));
  const d = c < 0 ? -1 : lines.findIndex((l, i) => i > c && /^\];/.test(l));
  return { lines, spans: [a >= 0 && b > a ? [a, b] : null, c >= 0 && d > c ? [c, d] : null].filter(Boolean) };
})();
const SELF_LINES = ANCHOR_REGION.lines.map((l, i) =>
  ANCHOR_REGION.spans.some(([a, b]) => i >= a && i <= b) ? '' : l);

/** 引用形态表（"需求行号引用"的**定义**）。要增删形态必须同步第九节的冻结基线，
 *  否则"清单 ⊆ 扫描"或"扫描 ⊆ 清单"当场变红 —— 形态表本身也是被对账的对象。 */
const CITATION_PATTERNS = [
  /* ⚠️ 两个坑（都是**实测踩过**的，不是预防性设计）：
     ① `需求` 之后必须紧跟空白或 `§`：否则会从「需求**文档**\…-V1.41.md:279」中间起匹配，
        把**跨文件引用**误当成本文件对需求清单的行号引用；
     ② 命中里含反引号的要丢掉：`需求文档\…-V1.41.md:279` 写在反引号里，而
        「需求 §0.2 的合计行见 `需求文档…`:256」这种写法会让非贪婪匹配跨过反引号，
        把行内代码段吞进来 —— 掩掉代码段并丢掉含反引号的命中，剩下的才是真正的"引用需求清单行号"。 */
  { name: '需求 §X.Y …:NNN', re: /需求(?=\s|§)[^\n]{0,40}?:\s*\d+/g },
  { name: '需求 <编号> …（:NNN）', re: /需求(?=\s|§)[^\n]{0,40}?（\s*:\s*\d+\s*）/g },
  { name: '需求 <编号> …（:NNN）半角', re: /需求(?=\s|§)[^\n]{0,40}?\(\s*:\s*\d+\s*\)/g },
  /* 区间连接写法：`需求 §10 :782 起、表在 :785–798` 里，第二处是**裸 `:A–B`**（冒号前紧邻的是
     汉字"在"而不是"需求…"）。故这一形态要求"冒号前是中文连接词（在/至/到/见/起）、
     且前面不是文件名/标识符"，由 `expandBareCitations()` 先补成"需求 …:A–B"的统一写法。 */
  { name: '需求 …:A–B（区间，含裸写法补全）', re: /(?<![\w.\-\\/:'"$}>])[\u4e00-\u9fa5]\s*:\s*\d+\s*[–—]\s*\d+/g }
];

/** 行内代码段（反引号）区间的起止位置。落在其中的 `:NNN` **不是**本文件对需求清单的引用
 *  —— 写成反引号的都是**文件名 + 行号**（如 `需求文档\…-V1.41.md:279`）或**示例写法**。 */
function codeSpans(line) {
  const spans = [];
  const re = /`[^`]*`/g;
  let m;
  while ((m = re.exec(line)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** 扫描前把**行内代码段**整段替换为**等长空格** —— 于是"本文件注释里举的例子"与
 *  "文件名 + 行号"都不会被算成引用。等长替换保证偏移量与源码原文一致（可与原文逐字对账）。 */
function maskCodeSpans(line) {
  let out = line;
  for (const [a, b] of codeSpans(line)) out = out.slice(0, a) + ' '.repeat(b - a) + out.slice(b);
  return out;
}

/** 把**依赖同一轮引用的裸 `:NNN` 写法**补全为统一的 `需求 …:NNN`。
 *  只有"冒号前紧邻的是**中文**（需求侧措辞：`在` / `见` / `起` …）且前 8 字里出现 `需求` / `§` / 条款编号"
 *  才补 —— 其余裸 `:NNN`（`stress-check.js:39`、`07:59:30`、`{0,24}` 之类）一律不动：
 *  它们是**非需求文件**的行号或时间字面量，不属本节口径。
 *  ⚠️ 输入必须是**已掩码**的文本（调用方先 `maskCodeSpans`），否则会把示例写法补成引用；
 *  ⚠️ 同一分支里带 `需求` 前缀的成文引用置于前，避免把裸 `:数字` 这种写法又补一次前缀；
 *  ⚠️ 冒号前是 `$` / `}` / `>` 的一律不补 —— 那是本文件的 `${n}`、`=>` 等**代码语法**里的冒号。 */
function expandBareCitations(masked) {
  return masked.replace(
    /需求(?=\s|§)[^\n]{0,40}?:\s*\d+|(?<![\w.\-\\/:'"$}>])([\u4e00-\u9fa5])\s*:(\d+)(?![\d:])/g,
    (m, cn, d, off) => {
      if (cn === undefined) return m;                                   // 已是成文引用，原样保留
      const before = masked.slice(Math.max(0, off - 8), off);
      return /需求|§|[A-Z]{2,}-\d/.test(before) ? `需求 …:${d}` : m;
    }
  );
}

/** 从一行文本里扫出全部「需求行号引用」。
 *  排除规则：**行内代码段（反引号）里的不算**（本节自己的示例、文件名 + 行号都在里面）。
 *  再做两件事：
 *   ① **去重**：重叠命中按"更长者胜、同起点的靠前者胜"；
 *   ② **粘合**：相邻两处引用若间距 ≤ 16 个字符，则**合并为一次引用**并把区间一并收进来
 *      （`§10 :782 起、表在 :785–798`＝一次引用；`需求 :798` 与 `需求 DEP-14（:776）`
 *      在同一句里紧挨着 ⇒ 各自独立，因为它们之间的文字超过 16 字）。 */
function scanCitations(line) {
  const text = expandBareCitations(maskCodeSpans(line));
  const raw = [];
  for (const p of CITATION_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const filePart = m[0].split(':')[0];
      if (/\.md|\\/.test(filePart)) continue;                          // 跨文件引用 ⇒ 不算
      const seg = m[0].match(/^([\s\S]*?):\s*(\d+)/);
      if (!seg) continue;
      raw.push({ lineNo: Number(seg[2]), text: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  raw.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const hits = [];
  for (const h of raw) {
    if (hits.some(o => o.start < h.end && h.start < o.end)) continue;   // 重叠 ⇒ 同一次引用
    hits.push(h);
  }
  for (let i = 0; i < hits.length; i++) {
    while (i + 1 < hits.length && hits[i + 1].start - hits[i].end <= 16) {   // ① 粘合
      hits[i] = { ...hits[i], text: text.slice(hits[i].start, hits[i + 1].end), end: hits[i + 1].end };
      hits.splice(i + 1, 1);
    }
    if (i === hits.length - 1) {                                             // ② 行尾粘连（区间另一头）
      const tail = text.slice(hits[i].end, hits[i].end + 16);
      const m2 = tail.match(/^\s*[–—]\s*\d+/);
      if (m2) hits[i] = { ...hits[i], text: hits[i].text + tail.slice(0, m2[0].length), end: hits[i].end + m2[0].length };
    }
    /* ③ **区间续写**：`需求 §10 :782 起、表在 :785–798` —— 第二处是**裸 `:A–B`**
       （两处引用之间的"起、表在 "是连接词）。把两处**并成一次引用**，区间端点才能被逐端点核对；
       否则 `:785–798` 这一头会从引用文本里漏掉（定点变异实测：止点改成 `:797` 时其余断言全绿）。 */
    if (i + 1 < hits.length && text.slice(hits[i].end, hits[i + 1].start).includes('–')) {
      hits[i] = { ...hits[i], text: text.slice(hits[i].start, hits[i + 1].end), end: hits[i + 1].end };
      hits.splice(i + 1, 1);
    }
    /* 引用原文**去掉两侧空白**：命中是从某处开始到某处结束的片段，行首/连接词前的空白
       不算引用的一部分（否则"锚点 ↔ 引用原文"的比对会被空白搅乱）。 */
    hits[i].text = hits[i].text.trim();
    const m3 = hits[i].text.match(/^([\s\S]*?):\s*(\d+)/);
    hits[i].lineNo = Number(m3[2]);
    /* 区间止点：整段引用里**最后一个**「:数字」或「–数字」—— 与起点无关，故用最后一次命中。 */
    const rangeTail = hits[i].text.match(/(?::|[–—])\s*(\d+)(?![\d\S])/g);
    hits[i].range = rangeTail && rangeTail.length > 1
      ? [hits[i].lineNo, Number(rangeTail[rangeTail.length - 1].replace(/[^\d]/g, ''))]
      : null;
  }
  return hits;
}

/** 扫描用的**放宽版**：连"落在行内代码段里"的候选也算 —— 只给**跨文件/示例引用**（xfile）登记用。
 *  ⚠️ 取命中的**第 1 处**（按出现位置）。 */
function scanCitationsRaw(line) {
  const hits = [];
  for (const p of CITATION_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(line)) !== null) {
      const seg = m[0].match(/^([\s\S]*?):\s*(\d+)/);
      if (!seg) continue;
      hits.push({ lineNo: Number(seg[2]), text: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  for (const h of hits) {
    if (out.some(o => o.start < h.end && h.start < o.end)) continue;
    out.push(h);
  }
  return out;
}

/** 逐处清单：[源码行号(1 起), 该行第几处(0 起), 引用的需求行号, 类型]。
 *  `type`：req＝本文件对需求清单的行号引用 / xfile＝**跨文件/示例**引用
 *         （`需求文档\…-V1.41.md:279` 这种"文件名 + 行号"，或本节注释里的示例写法）。
 *  ⚠️ 本清单是**逐处**登记的（同一行两处就写两条），不是"每行一条" —— 少登一处会被扫描侧抓到。 */
const CITATION_LEDGER = [
  /* —— in-scope：本文件对需求清单行号的引用（逐处锚定） —— */
  ['L224', 0, 595, 'req'],
  ['L387', 0, 841, 'req'],
  ['L388', 0, 822, 'req', '区间引用：止点＝被引用行号，起点另记在末位', 805],
  ['L397', 0, 807, 'req'],
  ['L432', 0, 811, 'req'],
  ['L432', 1, 807, 'req'],
  ['L436', 0, 812, 'req'],
  ['L440', 0, 813, 'req'],
  ['L443', 0, 814, 'req'],
  ['L446', 0, 815, 'req'],
  ['L449', 0, 816, 'req'],
  ['L451', 0, 817, 'req'],
  ['L455', 0, 818, 'req'],
  ['L458', 0, 819, 'req'],
  ['L460', 0, 820, 'req'],
  ['L462', 0, 821, 'req'],
  ['L464', 0, 822, 'req'],
  ['L464', 1, 800, 'req'],
  ['L537', 0, 836, 'req'],
  ['L550', 0, 807, 'req'],
  ['L1297', 0, 830, 'req'],
  /* —— 跨文件 / 示例：引的是**别的文件**自己的行号，或本节注释里的示例写法 —— */
  ['L13', 0, 279, 'xfile', '需求文档\\…-V1.41.md'],
  ['L357', 0, 280, 'xfile', '需求文档\\…-V1.41.md'],
  ['L633', 0, 265, 'xfile', '需求文档\\…-V1.41.md（示例）'],
  ['L668', 0, 805, 'xfile', '本节注释里的示例写法（裸 :A–B 补全）'],
  ['L1476', 0, 805, 'xfile', '本节注释里第二次举同一示例']
];

/** 清单 → 引用对象（带源码行原文），供锚点表与对账共用。
 *  `hit` 为 null 表示该处**扫不到**（清单登记错了或源码被改坏）。
 *  in-scope 用严格扫描（反引号里的不算）；xfile 用放宽扫描（它们本来就在反引号里）。 */
function buildManifest(ledger, allLines) {
  const out = [];
  for (const [srcRaw, idx, reqNo, type, file, rangeStart] of ledger) {
    const srcNo = typeof srcRaw === 'number' ? srcRaw : Number(String(srcRaw).replace(/^L/, ''));
    const line = allLines[srcNo - 1];
    /* 源码行号用 `L123` 写：这样本节源码里就不会出现形如 `[123, 0, 456, 'req'],` 的"裸数字 + 冒号"
       片段被自己的扫描器当成引用（自指陷阱的第三道闸）。
       第 6 个元素（可选）＝**区间起点**：仅"区间引用"用，`reqNo` 取的是区间**止点**
       （因为锚点核的就是止点那一行；起点由第九节⑭的端点断言按**位置严格相等**核）。 */
    const hits = line === undefined ? [] : (type === 'xfile' ? scanCitationsRaw(line) : scanCitations(line));
    const hit = hits[idx] || null;
    out.push({
      srcNo, idx, reqNo, type, file: file || '', line, hit, rangeStart: rangeStart || null,
      text: hit ? hit.text : '**扫不到引用（清单登记错 / 源码被改坏，需人工核）**',
      key: `${srcNo}:${idx}`
    });
  }
  return out;
}

const CITATIONS = buildManifest(CITATION_LEDGER, SELF_LINES);
const IN_SCOPE = CITATIONS.filter(c => c.type !== 'xfile');
const XFILE = CITATIONS.filter(c => c.type === 'xfile');

/** 「锚点 ↔ 引用原文」的自洽判定（**双向包含**）：
 *  锚点里带 `${n}` 占位，去掉占位符后的**字面部分**天然是被截断的前缀/后缀：
 *  · `交付方式见需求 :${n}` 的字面部分 `交付方式见需求:` ⊂ 引用原文 `需求 :769` ＋ 前后文；
 *  · `需求 :${n}` 的字面部分 `需求:` 是引用原文 `需求 :557` 的**前缀**。
 *  故判据取双向包含（任一侧含另一侧即可），两侧都归一（去空白/反引号/全角括号）。
 *  这条判据保证"锚点确实锚在这一处引用上"：把锚点键挪到别处、或把锚点改成别的语义标签，都会红。
 *  空字面部分一律判不成立。 */
function anchorFitsPhrase(literal, phrase) {
  const l = normSpace(literal), p = normSpace(phrase);
  if (!l || !p) return false;
  return p.includes(l) || l.includes(p);
}

/** **源码侧锚点是否仍成立**：把锚点的源码侧写法按占位符切成**字面片段**，逐段按顺序在
 *  **归一后的源码行**里定位（允许片段之间夹着行号数字，如 `需求 §` …` 起、表在 :` … `）。
 *  足以拦住"锚点写着老短语、引用已被改写"（定点变异实测：语义标签改成「交付方式见交付说明」⇒ 红）。 */
function sourceAnchorHolds(c, srcHalf) {
  if (!c.hit || !c.line) return false;
  if (c.line.indexOf(c.hit.text) < 0) return false;            // 引用原文已不在该行 ⇒ 清单登记错了
  const nsLine = normSpace(c.line);
  const frags = String(srcHalf).replace(/\$\{[^}]*\}/g, '{号}').split('{号}')
    .map(normSpace).filter(Boolean);
  if (!frags.length) return false;
  let from = 0;
  for (const part of frags) {
    const at = nsLine.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/** 锚点表（键＝`源码行号:第几处`，与 `CITATION_LEDGER` 的 **in-scope** 条目一一对应）。
 *  每项的 `anchor` 格式为 `源码侧写法（含锚点）¦需求那一行该含的正则`。
 *  · **源码侧**是字面短语（去掉 `${n}` 与 `「」` 后须逐字出现在该行源码里）；
 *  · **需求行侧**是正则（只归一空白与反引号 ⇒ 带 `**` / `|` 的写法要写成 `\*\*` / `\|`）；
 *  · 行号一律用 `${n}` 占位（如 `:${n + 17}`），写死会被九⑧ 拦下。 */
const ANCHORS = {
  '224:0': { anchor: '需求 :${n}¦^\\|UI-20\\|\\*\\*待补传清单与人工重报入口\\*\\*', name: 'UI-20 条款行（锚点＝条款编号本身）' },
  '387:0': { anchor: '需求 :${n}¦^\\|AC-12\\|文档完整性\\|', name: 'AC-12 判定标准原文' },
  '388:0': { anchor: '需求 §{号} :{号} 起、表在 :{号}¦^\\|12\\|质保承诺书\\|', name: '第 10 章交付物表末行（＝区间止点 :798）；`{号}` 是**行号占位**（对应 ${rangeStart}/${n}/${rangeEnd}），区间两端另由 `RANGE_ANCHORS` 逐端点核' },
  '397:0': { anchor: '交付方式见需求 :${n}¦^\\*\\*交付方式：\\*\\*', name: '第 10 章"交付方式"整段' },
  '432:0': { anchor: '需求 :${n}¦^\\|1\\|看板系统实物\\|', name: '交付物①「看板系统实物」表行' },
  '432:1': { anchor: '与硬件一起实物交付¦^\\*\\*交付方式：\\*\\*', name: '同行第二处引用仍指"交付方式"段' },
  '436:0': { anchor: '需求 :${n}¦^\\|2\\|需求规格说明书\\|', name: '交付物②「需求规格说明书」表行' },
  '440:0': { anchor: '需求 :${n}¦^\\|3\\|系统设计说明书\\|', name: '交付物③「系统设计说明书」表行' },
  '443:0': { anchor: '需求 :${n}¦^\\|4\\|界面原型/UI设计稿\\|', name: '交付物④「界面原型 / UI 设计稿」表行' },
  '446:0': { anchor: '需求 :${n}¦^\\|5\\|数据库脚本与初始化数据\\|', name: '交付物⑤「数据库脚本与初始化数据」表行' },
  '449:0': { anchor: '需求 :${n}¦^\\|6\\|源代码与构建说明\\|', name: '交付物⑥「源代码与构建说明」表行' },
  '451:0': { anchor: '需求 :${n}¦^\\|7\\|安装包与部署手册\\|', name: '交付物⑦「安装包与部署手册」表行' },
  '455:0': { anchor: '需求 :${n}¦^\\|8\\|接口联调文档与测试报告\\|', name: '交付物⑧「接口联调文档与测试报告」表行' },
  '458:0': { anchor: '需求 :${n}¦^\\|9\\|测试报告\\|', name: '交付物⑨「测试报告」表行' },
  '460:0': { anchor: '需求 :${n}¦^\\|10\\|用户操作手册/运维手册\\|', name: '交付物⑩「用户操作手册 / 运维手册」表行' },
  '462:0': { anchor: '需求 :${n}¦^\\|11\\|培训与验收报告\\|', name: '交付物⑪「培训与验收报告」表行' },
  '464:0': { anchor: '需求 :${n}¦^\\|12\\|质保承诺书\\|', name: '交付物⑫「质保承诺书」表行' },
  '464:1': { anchor: '需求 DEP-14（:${n}¦^\\|DEP-${n - 786}\\|', name: 'DEP-14 条款行（锚点＝条款编号本身；偏移量随需求升版重导，V1.39 起为 771）' },
  '537:0': { anchor: '连续运行 ≥7 天无重启、无崩溃、无内存泄漏"（需求¦^\\|AC-07\\|稳定性测试\\|', name: 'AC-07 判定标准原文（含"≥7 天"）' },
  '550:0': { anchor: '交付方式见需求 :${n}¦^\\*\\*交付方式：\\*\\*', name: '第 10 章"交付方式"整段（与 :397 同源、两处都核）' },
  '1297:0': { anchor: 'AC-01（需求 :${n}¦^\\|AC-01\\|功能完整性\\|', name: 'AC-01 判定标准原文（锚点＝AC 编号本身）' }
};

/** 区间引用的**端点说明**（键＝`源码行号:第几处`）：
 *  `需求 §10 :782 起、表在 :785–798` 一次带了三个行号（引用行 782＝第 10 章标题、
 *  区间起 785＝交付物表表头、区间止 798＝表末行）。本节的锚点表只核**被引用行号所指的那一行**，
 *  故这里注明：① 该引用为**区间起**（行号 767）时，其锚点直接取**区间那一头**的端点行；
 *  ② 区间那一头由**扫描侧解析出的区间端点**（`hit.range`）与本表 `rangeEnd` 的**位置严格相等**断言兜住
 *  —— 只核"被引用行"会漏掉端点（定点变异实测：把 `:798` 改成 `:797` 时其余断言全绿）。 */
const RANGE_ANCHORS = {
  '388:0': {
    rangeStart: { at: '+4', mustMatch: '^\\|序号\\|交付物\\|说明\\|', name: '第 10 章交付物表**表头行**（区间起点）' },
    rangeEnd: { at: '+17', mustMatch: '^\\|12\\|质保承诺书\\|', name: '第 10 章交付物表**末行（第 12 项）**（区间止点）' }
  }
};


/** 跨文件 / 示例引用的**逐条理由**（键＝`源码行号:第几处`）。 */
const XFILE_EXEMPT = {
  '13:0': '写法为 `需求文档\\…-V1.41.md:279`（行内代码段里的跨文件引用）；指需求文件自己的行号，其正确性由第七节 §0.2 台账与需求文件本身核实，本节不另行锚定。',
  '357:0': '`需求文档\\…-V1.41.md:280` —— AC 段口径说明里的跨文件引用；同行的 in-scope 引用由锚点表覆盖，此处仅为"文件名 + 行号"写法。',
  '633:0': '`需求文档\\…-V1.41.md:279` —— 本文件注释里**举例说明**"跨文件写法"的一处；该行位于 `CITATION_PATTERNS` 区块内（已掩码，严格扫描看不到）。',
  '668:0': '本节注释里**举例说明**裸 `:A–B` 写法的示例（位于锚点代码块内、已掩码）；不是本文件对需求清单的行号引用。',
  '1476:0': '本节注释里第二次举同一示例（说明"裸写法会被补全成引用"）；在代码段内，不是对需求清单的引用。'
};

/** 无锚点且**不属于跨文件/示例引用**的 in-scope 引用（必须为空）。
 *  与 `XFILE_EXEMPT` 的区别：后者是"设计上就不锚"，这里是"本可锚却没锚"。 */
const CITATION_EXEMPT = {};

/** 「锚点里带有非行号数字」的**显式豁免**（键＝`源码行号:第几处`）：只有"该数字是
 *  **引用文本里本来就有的语义锚点**（不是被引用的行号）"才允许登记 —— 例如区间引用
 *  `需求 §10 :782 起、表在 :785–798` 里的 `:782`：它是**第 10 章标题的行号**，
 *  与"被引用行（798）"同值，写死在源码侧锚点里不会随升版漂移（需求侧另有 `${n}` 占位核对）。
 *  其余锚点一律不得出现字面行号 —— 写死会随升版漂移，等于没锚。 */
const ANCHOR_DIGIT_EXEMPT = {
  '388:0': '源码侧锚点里的 `:782` 是**引用文本自身的语义锚点**（第 10 章标题行号，与"被引用行 782"同值，不随升版漂移）；需求行侧仍用 `${n}` 占位核对，故不构成"写死行号"。'
};

/** 冻结基线（V1.38 实测，本文件源码实扫）：
 *  · `CITATION_BASELINE_INSCOPE` ＝ **21 处** in-scope 引用（对需求清单行号的引用，逐处锚定）
 *  · `CITATION_BASELINE_XFILE`  ＝ **5 处** 跨文件/示例引用（逐条登记理由）
 *  · `CITATION_BASELINE_TOTAL`  ＝ **26 处** 合计（＝清单总条数）
 *  为什么冻结：形态表 `CITATION_PATTERNS` 一旦被改窄（或某类引用整体写错），
 *  "清单 ⊆ 扫描"仍可能成立但引用数会缩水 —— 这些基线就是那种"悄悄缩小校验范围"的红线。 */
const CITATION_BASELINE_INSCOPE = 21;
const CITATION_BASELINE_XFILE = 5;
const CITATION_BASELINE_TOTAL = 26;

function main() {
  const universe = requirementClauses();
  console.log(`需求条款（表格行口径）：${universe.size} 条`);
  console.log(`追溯表条目：${MAP.length} 组\n`);

  /* 1) 每条条款必须且只能归属一组 */
  const owner = new Map();
  const dup = [];
  const badRefs = [];
  for (const [pattern, status, script, evidence] of MAP) {
    for (const id of expand(pattern, universe)) {
      if (!universe.has(id)) {
        badRefs.push(`${id}（来自 ${pattern}）`);
        continue;
      }
      if (owner.has(id)) dup.push(`${id}（${owner.get(id)[0]} 与 ${pattern}）`);
      owner.set(id, [pattern, status, script, evidence]);
    }
  }
  const unassigned = [...universe.keys()].filter(id => !owner.has(id));

  console.log('=== 一、追溯表完整性 ===');
  /* 前提（ADR-0004 D20）：追溯表引用的条款必须真实存在 —— 这是"逐条归属"这件事成立的**前提**，
     不是对被测对象的断言。原实现写成一条匿名 failure（连断言名都不进 passed 计数），
     故改判为前提：成立时不计入断言数，塌掉时汇总单列「前提不成立」并使退出码非 0。 */
  t.requires('追溯表引用的条款都存在于需求清单', badRefs.length === 0, badRefs.slice(0, 6).join('；'));
  t.check('追溯表没有重复归属的条款', dup.length === 0, dup.slice(0, 6).join('；'));
  t.check(
    `每条需求条款都有归属（未归属 0 条）`,
    unassigned.length === 0,
    unassigned.length ? `未归属 ${unassigned.length} 条：${unassigned.slice(0, 12).join(', ')}${unassigned.length > 12 ? ' …' : ''}` : `已归属 ${owner.size} 条`
  );

  /* 0) 分母口径互校（V1.33）：需求 §0.2 **自述**的合计 vs `requirementClauses()` **逐行解析**的条数。
     两个来源互相独立：一边是需求自己写的数字，一边是真去数表格行。
     为什么要有它：本文件（以及 tests\README.md）里会写死"259"这类字面量作注释，
     若只靠动态打印 `owner.size`，需求升版后注释与现实漂移不会有任何东西发现。
     实测可证伪：把需求 §0.2 的合计改成 258 ⇒ 本条立刻 FAIL 并同时点名 258 与 259。 */
  const declaredTotal = declaredClauseTotal();
  t.check('需求 §0.2 自述的条款合计 ＝ 逐条解析出的条款数（分母的两个独立来源互校，防注释与实际漂移）',
    declaredTotal !== null && declaredTotal === universe.size,
    `§0.2 合计=${declaredTotal === null ? '**未解析到**（§0.2 表结构变了？）' : declaredTotal} 条；` +
    `requirementClauses() 逐行解析=${universe.size} 条`);

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
  t.check('证据指向的脚本都存在', badScript.length === 0, badScript.join('；'));
  t.check('证据指向的断言确实存在于该脚本', badEvidence.length === 0, badEvidence.slice(0, 6).join('；'));

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
     否则容易把"可追溯覆盖合计 X / 259"（分子含间接验证）误当作"AC-01 的实现完备度"（分母含 P1/P2 与 out-of-scope）。 */
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
     为什么单列一节而不是塞进 MAP：需求 §0.2（`需求文档\…-V1.41.md:280`）声明 AC「不计入需求条款合计」，
     故 AC 必须走**独立分母（12）**，不得改动"可追溯覆盖合计 X / 259"。 */
  console.log('\n=== 六、AC 验收标准追溯（AC-01～AC-12，**不计入上面的 259 条分母**）===');
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
  t.check('AC-01～AC-12 每条都有归属、无遗漏（缺一即红）',
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
  t.check('AC 证据指向的脚本都存在', acBadScript.length === 0, acBadScript.join('；'));
  t.check('AC 证据指向的断言确实存在于该脚本', acBadEvidence.length === 0, acBadEvidence.slice(0, 6).join('；'));

  /* AC 分区汇总（AC 的状态词允许与主表不同：backend-phase / declared-gap 在 AC 里同样正当）。
     分母一律取**需求表的条数**（acUniverse.size），不取追溯表行数 —— 否则漏登一条时会显示"12 条"自欺。 */
  const byAc = new Map();
  for (const [id, [status]] of acOwner) byAc.set(status, (byAc.get(status) || 0) + 1);
  console.log(`  AC 合计（需求 §0.2 声明 ${acUniverse.size} 条，**不计入上面的 259 条分母**）：已登记 ${AC_MAP.length} 条，覆盖到 ${[...acOwner.keys()].filter(id => acUniverse.has(id)).length} / ${acUniverse.size} 条`);
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

  /* AC-07 专项如实标注：要求 ≥7 天，证据只有**浸泡预设 8 小时**（`--soak` / `--hours 8` 才跑 8 小时，默认仅 5 分钟）且整脚本跳过 —— 不构成满足。
     为什么单独立一条：这是本次唯一"证据看着有、其实不成立"的条目，必须被定点变异之外的第二道机器检查钉住，
     否则以后很容易被写成"已有浸泡预设 8 小时长跑 ⇒ 基本满足"。⚠ 判据读的是**代码**里的字面量（`process.env.DSH_STRESS_HOURS || N`），不读注释里的示例。 */
  const ac07reqDays = Number((acUniverse.get('AC-07') || '').match(/≥\s*(\d+)\s*天/)?.[1] || 0);
  const stressHours = Number(fs.readFileSync(path.join(TESTS, 'stress-check.js'), 'utf8').match(/process\.env\.DSH_STRESS_HOURS\s*\|\|\s*(\d+)/)?.[1] || 0);
  const ac07rec = acOwner.get('AC-07') || ['', '', '', ''];
  t.check('AC-07 如实登记为无有效证据（≥7 天 vs 现有浸泡预设 8 小时且整脚本跳过，不构成满足）',
    ac07reqDays >= 7 && stressHours > 0 && stressHours < ac07reqDays * 24 &&
    ac07rec[0] === 'declared-gap' && !ac07rec[1] && /跳过/.test(ac07rec[3] || ''),
    `AC-07 要求 ≥${ac07reqDays} 天、stress-check 浸泡预设 ${stressHours} 小时（默认运行仅 5 分钟，整脚本跳过）、登记状态 ${ac07rec[0]}, 证据脚本 ${ac07rec[1] || '无'}`);

  /* AC 与需求条款两套分母的隔离：AC 段本身不得与主表的证据引用混同（同一个脚本名两侧都用得到，
     但"AC 覆盖率"绝不能改写主表口径）—— 这里只作提示，真正的隔离由本节的独立计数与
     上面"可追溯覆盖合计 / owner.size(=259)"保证。 */
  const acSharedScripts = [...new Set(AC_MAP.map(([, , s]) => s).filter(Boolean))]
    .filter(s => [...MAP_SRC.values()].includes(s));
  if (acSharedScripts.length) {
    console.log(`  [提示] AC 段与需求条款主表共用 ${acSharedScripts.length} 个证据脚本（正当）：${acSharedScripts.join('、')}`);
  }

  /* 七、第 10 章交付物存在性台账（T-20260920-06；AC-12 的口径细化）
     与 AC 段同样**走独立口径**：本节的项数（12）与计数**绝不并入 `可追溯覆盖合计 X / 259`**
     —— 交付物不是需求条款（需求 §0.2 明令 AC/交付口径不计入条款合计）。
     本节只回答"仓库里有没有"，不回答"是否齐全/是否通过审核"。 */
  t.section('七、第 10 章交付物存在性台账（AC-12 口径；**不计入上面的 259 条分母**）');

  const dlOk = t.requires(
    '第 10 章交付物表可从需求原文解析（需求 §10 的 "序号 / 交付物 / 说明" 表行非空）',
    DELIVERY_TALLY.items.length > 0,
    `${DELIVERY_TALLY.items.length} 行`);

  if (dlOk) {
    const dl = deliveryTally();                                  // 当场重新派生（不用模块加载期的缓存）
    const VERDICT_TXT = { present: '存在', partial: '部分', missing: '缺失/待交付' };
    console.log(`  需求原文（${path.basename(path.join(ROOT, '需求文档',
      fs.readdirSync(path.join(ROOT, '需求文档')).find(f => f.endsWith('.md'))))}）第 10 章交付物表：${dl.items.length} 行`);
    for (const r of dl.rows) {
      console.log(`    ${String(r.seq).padStart(2)}. ${r.name} ［${VERDICT_TXT[r.verdict] || '**未归属**'}］`);
      console.log(`        落点：${r.paths.length ? r.paths.join('、') : '（仓库内无对应产物）'}`);
      console.log(`        依据：${r.basis}`);
    }
    /* 覆盖计数**单独成行**（口径与 AC 一致：不计入 259 条分母）。下面的断言会把这一行
       **回读**并与逐项统计比一遍 —— 手改这个数字会让断言变红（D22 定点变异②）。 */
    const countLine = `第 10 章交付物在库 ${dl.inRepo}/${dl.items.length}` +
      `（存在 ${dl.present}、部分 ${dl.partial}、纯缺失待交付 ${dl.missing}）`;
    console.log(`  ${countLine} —— 与 AC 同口径，**不计入上面的 259 条分母**`);

    const seqOk = dl.items.every((it, i) => it.seq === i + 1);
    t.check(`第 10 章交付物清单＝冻结基线 ${BASELINE_DELIVERABLE_COUNT} 项、序号 1..N 连续、说明非空（需求升版须同步本基线）`,
      dl.items.length === BASELINE_DELIVERABLE_COUNT && seqOk &&
      dl.items.every(it => it.name && it.desc),
      `解析出 ${dl.items.length} 行，序号 ${dl.items.map(i => i.seq).join(',')}${seqOk ? '（连续）' : '（**不连续**）'}`);

    t.check('交付物台账与需求原文逐项对号：无未归属、无多余条目、判定词合法',
      dl.unmatched.length === 0 && dl.unmatchedLedger.length === 0 && dl.badVerdicts.length === 0,
      [`需求里未归属：${dl.unmatched.join('、') || '无'}`,
        `台账里多余：${dl.unmatchedLedger.join('、') || '无'}`,
        `判定词非法：${dl.badVerdicts.join('、') || '无'}`].join('；'));

    t.check('判「存在/部分」的交付物，其声明的仓库落点逐个真实存在（fs.existsSync 核实）',
      dl.present + dl.partial > 0 && dl.rows
        .filter(r => r.verdict === 'present' || r.verdict === 'partial')
        .every(r => r.paths.length > 0 && r.missingPaths.length === 0),
      dl.rows.filter(r => (r.verdict === 'present' || r.verdict === 'partial') &&
        (r.paths.length === 0 || r.missingPaths.length > 0)).map(r =>
        `${r.seq}.${r.name}${r.paths.length ? ' → 不存在：' + r.missingPaths.join('、') : ' → 未声明任何落点'}`).join('；') ||
      `在库项共 ${dl.present + dl.partial} 项，声明路径 ${dl.rows.reduce((n, r) => n + r.paths.length, 0)} 条全部存在`);

    t.check('判「缺失/待交付」的交付物不声明任何仓库落点（判定与证据不得互相矛盾）',
      dl.rows.filter(r => r.verdict === 'missing').every(r => r.paths.length === 0),
      dl.rows.filter(r => r.verdict === 'missing' && r.paths.length).map(r =>
        `${r.seq}.${r.name} 判缺失却声明了 ${r.paths.join('、')}`).join('；') ||
      `缺失项 ${dl.missing} 项，落点声明均为空`);

    /* 覆盖计数自洽（验收判据 ④）：报告值（**回读刚打印的那一行**）＝逐项统计值，
       且"声明路径全部存在"的项数（独立于判定词、来自文件系统）＝在库项数。 */
    const reported = Number((countLine.match(/在库\s*(\d+)\s*\/\s*(\d+)/) || [])[1]);
    t.check('覆盖计数与逐项判定自洽（报告值＝逐项统计值；且"声明路径存在"的项数＝在库项数）',
      reported === dl.inRepo && dl.inRepo === dl.present + dl.partial &&
      dl.present + dl.partial + dl.missing === dl.items.length && dl.evidenced === dl.inRepo,
      `报告值 ${reported}；判定统计 存在 ${dl.present}+部分 ${dl.partial}=${dl.inRepo}/${dl.items.length}（缺失 ${dl.missing}）；路径存在的项数 ${dl.evidenced}`);

    /* AC-12 的归属不得悄悄升级：仍 declared-gap、仍**不冒领**机器证据（证据脚本留空），
       依据里必须写明"在库 N/12"与"机器只证有无、不证审核"。 */
    const ac12rec = acOwner.get('AC-12') || ['', '', '', ''];
    t.check('AC-12 仍记 declared-gap 且不冒领机器证据，依据写明"在库 N/12"与"机器只证有无、不证审核"',
      ac12rec[0] === 'declared-gap' && ac12rec[1] === '' &&
      (ac12rec[3] || '').includes(`在库 ${dl.inRepo}/${dl.items.length}`) &&
      /通过审核/.test(ac12rec[3] || '') && /不能证明/.test(ac12rec[3] || ''),
      `归属 ${ac12rec[0] || '无'}、证据脚本 ${ac12rec[1] || '无'}、依据${(ac12rec[3] || '').includes(`在库 ${dl.inRepo}/${dl.items.length}`) ? '含' : '**缺**'}「在库 ${dl.inRepo}/${dl.items.length}」`);
  }

  /* 八、AC-01「逐条签核清单」：P0 中**未被"直接断言"承接**的条款（T-20260920-09）
     ---------------------------------------------------------------------------
     立案：AC-01（需求 :830「本清单 P0 条目 100% 实现并现场演示通过」）的判定对象是**现场演示**
      与"P0 清单逐条过"的组织动作 —— 机器证明不了"是否已实现"。而第五之二节的
      `P0 可追溯覆盖 130/188`（V1.37 实跑值；与 V1.36 相同 —— 本批只统一 `testStatus` 口径并改判
   FR-2.5 / FR-2.8 的**证据指向**，条款归属与优先级均未变；**以第五之二节输出为准**，本处只作引用）
      分子里**含间接验证**，被读成"实现完备度"就高估了。
     故按负责人批准的口径 (a)「只标注有无断言承接」：**"有断言承接"＝ covered-direct**，
     其余**一律**进清单，逐条打印【编号 / 状态 / 一句话原因】供现场/终验收**逐条签核**。
     机器只保证**清单完整、可核对**（不漏项、不藏项），**不判定"是否已实现"**。

     三条纪律：
      ① 清单**从现有追溯表派生**（MAP → owner），**不另建第二份 P0 名单** —— 否则就是第二个真源；
         优先级沿用 `requirementPriorities()`（与第五之二节同一个函数），不新写解析规则；
      ② 只读取、只汇总，**不重分类**：清单里每条的状态一律取自 owner，断言④会把这一点逐条比一遍；
      ③ 本清单**不计入 259 条分母**（与 AC 段同属验收口径，需求 §0.2 明令不计入条款合计），
         也不改动第五 / 六 / 七节的任何数字与判定。
     ⚠️ 需求里 DR 表是「编号/数据表/关键字段/说明」**四列**、IF-C / IF-0 部分行的末列是**备注** ——
        这些行**没有优先级字段**，故**不计入 P0**（第五之二节已同口径排除，本节沿用同一个 prio 表）。 */
  t.section('八、AC-01 逐条签核清单：P0 中未被"直接断言"承接的条款（口径 (a)；**不计入上面的 259 条分母**）');

  const p0Ids = [...universe.keys()].filter(id => prio.get(id) === 'P0');
  const noPrioIds = [...universe.keys()].filter(id => !prio.has(id));
  const p0Ready = t.requires('需求原文里能解析出标注为 P0 的条款（AC-01 的判定基数，非空）',
    p0Ids.length > 0, `P0 ${p0Ids.length} 条、无优先级字段 ${noPrioIds.length} 条`);

  if (p0Ready) {
    /* 清单条目的状态**一律取自 owner**（不重分类）；owner 缺失的 P0 显式记「未归属」**并进清单**，
       使"不许藏项"在归属塌掉时也不会静默丢条。 */
    const p0All = p0Ids.map(id => {
      const r = owner.get(id);
      return r ? { id, status: r[1], script: r[2], evidence: r[3] }
        : { id, status: '(未归属)', script: '', evidence: '追溯表（MAP）里没有这条 P0 的归属' };
    });
    const p0Unowned = p0All.filter(it => it.status === '(未归属)').map(it => it.id);
    const directAll = p0All.filter(it => it.status === 'covered-direct');
    const p0List = p0All.filter(it => it.status !== 'covered-direct');

    /* 「有断言承接」的**第二条独立来源**：状态词写着 covered-direct 还不够，必须**证据可核实**
       （脚本存在 + 证据文本确实在该脚本里，与第 2 步同规格）。有了它，"把没有直接断言的条款
       标成 covered-direct"会让「有断言承接 ＋ 清单 ＝ P0 总数」当场不成立 —— D22 定点变异①的红点。 */
    const srcCache = new Map();
    const scriptSrc = (s) => {
      if (!srcCache.has(s)) {
        const p = path.join(TESTS, s);
        srcCache.set(s, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
      }
      return srcCache.get(s);
    };
    const backable = (it) => {
      const src = it.script ? scriptSrc(it.script) : null;
      return Boolean(src) && (!it.evidence || src.includes(it.evidence));
    };
    const directBacked = directAll.filter(backable);
    const directUnbacked = directAll.filter(it => !backable(it));

    /* 一句话原因：状态词给出"为什么不算直接断言"，再接追溯表里的原始证据/原因文本（**不改写**）。 */
    const LEAD = {
      'covered-indirect': '仅间接验证（有可复跑断言，但它验证的不是本条本身）',
      'fix-pending': '已确认缺陷待修',
      'declared-gap': '已声明缺口（Demo 明确不做，README「已知限制」已登记）',
      'backend-phase': '属后端/部署/目标硬件阶段，纯前端 Demo 无法验证',
      'manual': '须人工判断（观感/规范等），当前无断言',
      'subjective': '主观项（动效/防烧屏等）',
      'out-of-scope': '已声明不在本期范围'
    };
    const reasonOf = (it) => {
      const lead = LEAD[it.status] || `状态词「${it.status}」不在词表内（须复核）`;
      return it.script ? `${lead}；现有证据：${it.script} ← ${it.evidence}`
        : `${lead}；${it.evidence || '（追溯表未写原因）'}`;
    };

    console.log(`  口径：清单只收**需求里标注了优先级的 P0**；另有 ${noPrioIds.length} 条条款在需求原文里` +
      '本就没有优先级字段（DR 表四列、IF-C / IF-0 部分行末列为备注），**不计入 P0、也不进本清单**。');
    console.log(`  P0 共 ${p0Ids.length} 条；其中"有断言承接"（covered-direct 且证据可核实）${directBacked.length} 条。`);

    /* 单行计数：**回读**这一行做断言（手改数字即红 —— D22 定点变异②）。 */
    const tally = new Map();
    for (const it of p0List) tally.set(it.status, (tally.get(it.status) || 0) + 1);
    const tallyTxt = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k} ${v}`).join('、');
    const countLine = `P0 未被直接断言承接 ${p0List.length}/${p0Ids.length}（其中 ${tallyTxt}）`;
    console.log(`  ${countLine} —— 供现场/终验收**逐条签核**；**不计入上面的 259 条分母**`);

    console.log('  逐条清单（编号 / 状态 / 一句话原因）—— 机器不判定"是否已实现"，只保证不漏项、不藏项：');
    const printed = [];
    for (const it of p0List) {
      const line = `    ${it.id.padEnd(10)} ${String(it.status).padEnd(16)} ${reasonOf(it)}`;
      printed.push(line);
      console.log(line);
    }
    console.log(`  （清单 ${printed.length} 条；签核动作＝逐条确认"是否已实现"，与本清单是否完整无关。）`);

    /* 回读计数行与逐条清单行 —— 断言比的是**打印出来的产物**，不是内存里的中间量。 */
    const cm = countLine.match(/^P0 未被直接断言承接 (\d+)\/(\d+)（其中 (.*)）$/);
    const repX = cm ? Number(cm[1]) : NaN;
    const repTotal = cm ? Number(cm[2]) : NaN;
    const repTally = new Map((cm ? cm[3].split('、') : []).map(s => {
      const mm = s.trim().match(/^(\S+)\s+(\d+)$/);
      return [mm ? mm[1] : s.trim(), mm ? Number(mm[2]) : NaN];
    }));
    const tallyMismatch = [...new Set([...tally.keys(), ...repTally.keys()])]
      .filter(k => (tally.get(k) || 0) !== (repTally.get(k) || 0))
      .map(k => `${k}：报告 ${repTally.has(k) ? repTally.get(k) : '缺'} vs 逐条 ${tally.get(k) || 0}`);
    const parsed = printed.map(l => {
      const m = l.match(/^\s{4}(\S+)\s+(\S+)\s+(.+)$/);
      return m ? { id: m[1], status: m[2], reason: m[3] } : { id: l.trim(), status: '(解析失败)', reason: '' };
    });

    /* ① P0 每条都有归属（不得有未归属的 P0）；基数与第五之二节**同源**（两处各写一份必漂移）。 */
    t.check('AC-01 清单①：P0 条款在追溯表里逐条有归属（未归属 0 条），P0 基数与第五之二节报告值一致',
      p0Unowned.length === 0 && p0Ids.length === p0.total && noPrioIds.length === noPrio,
      p0Unowned.length ? `未归属 ${p0Unowned.length} 条：${p0Unowned.join(', ')}`
        : `P0 ${p0Ids.length} 条 ＝ 第五之二节 ${p0.total} 条；无优先级字段 ${noPrioIds.length} 条 ＝ 第五之二节 ${noPrio} 条`);

    /* ② 报告计数自洽 + 不漏不重（回读刚打印的计数行；把计数改错、或把某条判成 covered-direct，都会红）。
       "不漏不重"的锚是 directBacked（**证据可核实**的直接断言数），**不是**状态词本身。 */
    t.check('AC-01 清单②：报告计数与逐条清单自洽（回读值＝清单条数、分类子计数＝逐条统计值），且"有断言承接 ＋ 清单 ＝ P0 总数"',
      repX === p0List.length && repTotal === p0Ids.length && tallyMismatch.length === 0 &&
      directBacked.length + p0List.length === p0Ids.length,
      `报告 ${repX}/${repTotal}；逐条清单 ${p0List.length} 条；有证据的直接断言 ${directBacked.length} 条；` +
      `分类差异：${tallyMismatch.join('；') || '无'}；不漏不重 ${directBacked.length}＋${p0List.length}＝${directBacked.length + p0List.length} vs P0 ${p0Ids.length}`);

    /* ③ 不漏不重（**打印出来的清单** vs 归属）：清单＝P0 中全部非 covered-direct、无重复、
       无 covered-direct 混入，且"清单 id 集合"与"直接断言 id 集合"互补、并集＝全部 P0。 */
    const listedIds = parsed.map(r => r.id);
    const dupIds = listedIds.filter((id, i) => listedIds.indexOf(id) !== i);
    const leaked = parsed.filter(r => r.status === 'covered-direct');
    /* 互补集的另一半取 **directBacked（证据可核实）**，不取状态词派生的 directAll ——
       这样"把某条 P0 的状态从 backend-phase 改成 covered-direct"会让并集少一条，本断言当场变红。 */
    const backedIds = directBacked.map(it => it.id);
    const union = new Set([...listedIds, ...backedIds]);
    t.check('AC-01 清单③：不漏不重（清单 ＋ 有断言承接 ＝ P0 全集、无重复、无 covered-direct 混入清单）',
      parsed.length === p0List.length && dupIds.length === 0 && leaked.length === 0 &&
      union.size === p0Ids.length && union.size === backedIds.length + listedIds.length,
      `清单 ${listedIds.length} 条（重复 ${dupIds.join('、') || '无'}；混入 covered-direct ${leaked.length} 条）；` +
      `有断言承接（证据可核实）${backedIds.length} 条；并集 ${union.size} vs P0 ${p0Ids.length}`);

    /* ④ 清单每条的状态词合法且 ≠ covered-direct、与追溯表登记状态**逐条一致**、原因非空。 */
    const badWord = parsed.filter(r => !STATUS_WORDS.has(r.status));
    const notDirect = parsed.filter(r => r.status === 'covered-direct');
    const statusDrift = parsed.filter(r => !owner.has(r.id) || owner.get(r.id)[1] !== r.status);
    const emptyReason = parsed.filter(r => !r.reason.trim());
    t.check('AC-01 清单④：清单每条状态词合法且 ≠ covered-direct、与追溯表登记状态逐条一致、原因非空',
      parsed.length === p0List.length && badWord.length === 0 && notDirect.length === 0 &&
      statusDrift.length === 0 && emptyReason.length === 0,
      `解析出 ${parsed.length} 条；状态词非法：${badWord.map(r => `${r.id}=${r.status}`).join('、') || '无'}；` +
      `covered-direct 混入：${notDirect.map(r => r.id).join('、') || '无'}；` +
      `与追溯表不一致：${statusDrift.map(r => r.id).join('、') || '无'}；原因为空：${emptyReason.map(r => r.id).join('、') || '无'}`);

    /* ⑤ "有断言承接"必须**条条有可核实的证据**（脚本存在 + 证据文本在该脚本里）——
       这是拦"把无直接断言的 P0 悄悄升级成 covered-direct"的第二道机器闸（第一道是清单②的"不漏不重"）。 */
    t.check('AC-01 清单⑤：判为"有断言承接"（covered-direct）的 P0 每条都有可核实证据（防止无直接断言者被升级）',
      directUnbacked.length === 0,
      directUnbacked.length
        ? `无证据却判 covered-direct 的 ${directUnbacked.length} 条：${directUnbacked.map(it => `${it.id}（脚本 ${it.script || '无'}）`).join('、')}`
        : `有断言承接 ${directBacked.length} 条，脚本与证据文本均已核实（同第 2 步规格：脚本存在 + 证据文本在该脚本里）`);
  }

  /* 九、注释里的「需求行号引用」自检（T-20260924-T3）
     ---------------------------------------------------------------------------
     立案（实测）：诚实性探针 M7 证明 —— 把本文件注释里某处需求行号引用（例如合计行那处）改成相邻的错号，
     脚本照样 20/0 全绿、exit 0 ⇒ **代码里成体系的需求行号引用当时完全没有机器校验**。
     本节把"引用 ↔ 当轮需求文件"的**双向对账**做起来：源码侧的行号引用逐处登记、逐处锚定，
     被引用的那一行必须命中同一锚点；源码里多一处、少一处都变红。
     口径：**不复制需求正文**（真源仍是当轮需求文件），只加对账；
          本节的计数**不并入上面的 259 条分母**（与 AC 段、交付物台账同属旁证口径）。
     ⚠️ 渲染结果类的真机证据不在这里（见 B5b / B5c，属 browser-class）。 */
  t.section('九、注释里的需求行号引用自检（引用 ↔ 当轮需求文件双向对账）');

  const citeOk = t.requires('当轮需求清单（需求文档\\*.md）可读',
    REQ_FILE !== null && REQ_LINES.length > 0,
    REQ_FILE ? `${REQ_FILE}：${REQ_LINES.length} 行` : '需求文档\\ 下没有 .md');

  if (citeOk) {
    /* 源码侧扫描（**全文件逐行**，与清单无关）：只认"本文件对需求清单行号"的引用 */
    const found = [];
    SELF_LINES.forEach((l, i) => scanCitations(l).forEach((h, idx) =>
      found.push({ srcNo: i + 1, idx, text: h.text, reqNo: h.lineNo, range: h.range })));
    /* 计数对账用的两个量（同一口径：去空白与反引号）：
       ① 「需求…:数字」的**出现次数**；② 裸「:数字」的出现次数
       （形如 `需求 §10 :805`、`需求 DEP-14（:799）` —— 这些**没有被"需求…:"形态覆盖**，
         正是最容易整体漂移却没人看的那一类）。 */
    const rawReqColon = SELF_LINES.reduce((n, l) => n + (normSpace(l).match(/需求[^\n]{0,24}?:\d+/g) || []).length, 0);
    const bareColon = SELF_LINES.reduce((n, l) => n + (normSpace(l).match(/:\d+/g) || []).length, 0);

    console.log(`  引用形态（共 ${CITATION_PATTERNS.length} 种）：${CITATION_PATTERNS.map(p => p.name).join('；')}`);
    console.log(`  源码实测：in-scope 引用 ${found.length} 处；清单登记 ${CITATIONS.length} 处（in-scope ${IN_SCOPE.length} + 跨文件/示例 ${XFILE.length}）。`);
    console.log(`  计数对账：源码里「需求…:数字」出现 ${rawReqColon} 次、裸「:数字」出现 ${bareColon} 次；` +
      `冻结基线 in-scope ${CITATION_BASELINE_INSCOPE} / 跨文件 ${CITATION_BASELINE_XFILE} / 合计 ${CITATION_BASELINE_TOTAL}。`);

    /* 逐处解析锚点：源码侧在哪、锚点是什么、需求那一行该含什么、实际命中没有 */
    const resolved = IN_SCOPE.map(c => {
      const a = ANCHORS[c.key];
      if (!a) return { c, anchored: false };
      const parts = String(a.anchor).split('¦');
      /* 源码侧锚点里若残留 `|` 分隔符 ⇒ 该条还没按新写法迁移（`|` 同时是正则元字符） */
      const badSeparator = parts.length < 2 || parts[0].split('¦')[0].includes('|');
      const rangeStartNo = c.hit && c.hit.range ? c.hit.range[0] : c.reqNo;
      /* 源码侧锚点的**字面部分**：去掉**所有** `${…}` 占位（含 `${rangeStart}` / `${rangeEnd}`）与「」。
         此前只去掉 `${n…}` ⇒ 区间那条的字面里还留着 `${rangeStart}`，源码侧核对必然假红（实测踩过）。 */
      const srcHalf = parts[0].replace(/\$\{[^}]*\}/g, '').replace(/[「」]/g, '');
      const srcP = parts[0]
        .replace(/\$\{rangeStart\}/g, String(rangeStartNo))
        .replace(/\$\{rangeEnd\}/g, String(c.hit && c.hit.range ? c.hit.range[1] : c.reqNo))
        .replace(/\$\{n\}/g, String(c.reqNo));
      const docP = parts.slice(1).map(s => s
        .replace(/\$\{rangeStart\}/g, String(rangeStartNo))
        .replace(/\$\{rangeEnd\}/g, String(c.hit && c.hit.range ? c.hit.range[1] : c.reqNo))
        .replace(/\$\{n \+ (\d+)\}/g, (_, d) => String(c.reqNo + Number(d)))
        .replace(/\$\{n - (\d+)\}/g, (_, d) => String(c.reqNo - Number(d)))
        .replace(/\$\{n\}/g, String(c.reqNo)));
      const target = normSpace(REQ_LINES[c.reqNo - 1] || '');
      const srcTarget = normSpace(c.line || '');
      const docMatch = docP.map((p, i) => {
        let re = null, m2 = null, lines_hit = 0;
        try {
          re = new RegExp(normSpace(p));
          m2 = target.match(re);
          /* **跨行干扰检查**：该锚点模式在整份需求文件里应当**只**命中被引用那一行 */
          lines_hit = REQ_LINES.filter(l => re.test(normSpace(l))).length;
        } catch (e) { /* 模式非法 ⇒ 下面如实报 */ }
        return {
          pat: String(parts[i + 1]), re, ok: Boolean(m2), linesHit: lines_hit,
          hit: m2 ? String(m2[0]).slice(0, 60) : '',
          index: m2 ? +((target.indexOf(m2[0]) / Math.max(1, target.length)).toFixed(3)) : null
        };
      });
      return {
        c, anchored: true, a, srcHalf, badSeparator,
        /* 源码侧核对（**只认字面锚点**）：锚点里写的字面部分（去掉 ${…} 占位与「」）与
           **该处引用原文**必须互相包含（锚点可带语义前缀如「交付方式见需求 」，也可只是引用原文的一部分）
           —— 即"这条锚点还锚在这一处引用上"。
           ⚠️ 不能拿含 `${n}` 的整串去比源码行：区间引用的被引用行号是**止点**（777），
           而源码行里写的是区间起止（`:782 起、表在 :785–798`），整串比对必然假红（实测踩过）。 */
        srcOk: !badSeparator && sourceAnchorHolds(c, srcHalf),        reqLine: REQ_LINES[c.reqNo - 1] || '',
        docMatch
      };
    });

    const anchoredKeys = new Set(resolved.filter(r => r.anchored).map(r => r.c.key));
    const exemptKeys = new Set(Object.keys(CITATION_EXEMPT));
    const xfileKeys = new Set(XFILE.map(c => c.key));
    const missing = IN_SCOPE.filter(c => !anchoredKeys.has(c.key) && !exemptKeys.has(c.key));
    const orphanAnchors = Object.keys(ANCHORS).filter(k => !IN_SCOPE.some(c => c.key === k));
    const anchorKeySrcCount = (fs.readFileSync(__filename, 'utf8').match(/^\s*'\d+:\d+':\s*\{\s*anchor:/gm) || []).length;
    /* 锚点里的行号**一律用 `${n}` 占位**：需求行侧若出现"冒号/区间号 + 具体数字"（`:782` 这种）即红。
       （`4K@30Hz`、`7×24`、`NFR-05` 这类**内容**数字不含冒号，不受此规则约束。） */
    const anchorDigits = Object.keys(ANCHORS)
      .filter(k => /[:–—]\s*\d/.test(String(ANCHORS[k].anchor).split('¦').slice(1).join('¦')
        .replace(/\$\{n[^}]*\}/g, '')))
      .filter(k => !Object.prototype.hasOwnProperty.call(ANCHOR_DIGIT_EXEMPT, k));
    if (Object.keys(ANCHOR_DIGIT_EXEMPT).length) {
      console.log('  锚点数字豁免清单（逐条给理由）：');
      for (const [k, reason] of Object.entries(ANCHOR_DIGIT_EXEMPT)) console.log(`    · ${k}：${reason}`);
    }

    const manifestMissing = found.filter(f => !IN_SCOPE.some(c => c.srcNo === f.srcNo && c.idx === f.idx));
    const scanMissing = CITATIONS.filter(c => !c.hit);
    if (process.env.T3_DEBUG) {
      for (const r of resolved.filter(x => !x.srcOk)) {
        console.log(`    [dbg] ${r.c.key} srcHalf=「${r.srcHalf}」 hit=「${r.c.hit ? r.c.hit.text : '(无)'}」`);
      }
    }
    const badAnchor = resolved.filter(r => r.anchored && (!r.srcOk || r.docMatch.some(d => !d.ok)));
    const weakAnchor = resolved.filter(r => r.anchored && r.docMatch.some(d => d.ok && d.linesHit !== 1));

    if (badAnchor.length) {
      console.log('  锚点未命中的逐条明细（源码侧写法 / 需求那一行实际内容）：');
      for (const r of badAnchor) {
        console.log(`    ❌ ${r.c.srcNo}:${r.c.idx} 引用「${r.c.text}」→ 需求 :${r.c.reqNo}（${r.a.name}）`);
        console.log(`       源码侧应有锚点：${r.srcHalf}  ⇒ ${r.srcOk ? '命中' : '**未命中**'}`);
        console.log(`       需求 :${r.c.reqNo} 实际内容：${r.reqLine.slice(0, 140)}`);
        r.docMatch.forEach((d, i) => console.log(`       需求行锚点 ${i + 1}：/${d.re ? d.re.source : d.pat}/ ⇒ ` +
          `${d.ok ? '命中「' + d.hit + '」@位置比 ' + d.index : '**未命中**'}`));
      }
    } else {
      for (const r of resolved) {
        console.log(`    ${r.c.srcNo}:${r.c.idx} 引用「${r.c.text}」→ 需求 :${r.c.reqNo}（${r.a.name}）：源码侧锚点「${r.srcHalf}」命中；` +
          `需求行 ${r.docMatch.map(d => `锚点=「${d.hit}」@${d.index}（全文件命中 ${d.linesHit} 行）`).join('、')}`);
      }
    }
    if (weakAnchor.length) {
      console.log('  ⚠️ 锚点不够"唯一"（同一模式在需求文件别处也命中 ⇒ 行号漂移时可能照样绿）：');
      for (const r of weakAnchor) {
        console.log(`    · ${r.c.srcNo}:${r.c.idx} → 需求 :${r.c.reqNo}：` +
          r.docMatch.filter(d => d.ok && d.linesHit !== 1).map(d => `「${d.hit}」命中 ${d.linesHit} 行`).join('；'));
      }
    }
    if (missing.length) console.log(`  ⚠️ 无锚点且未登记豁免的引用：${missing.map(c => `${c.srcNo}:${c.idx}「${c.text}」`).join('；')}`);
    console.log(`  跨文件 / 示例引用豁免清单（${XFILE.length} 条，逐条给理由）：`);
    for (const [k, reason] of Object.entries(XFILE_EXEMPT)) console.log(`    · ${k}：${reason}`);
    console.log('  「本可锚却没锚」的豁免清单：**空**（in-scope 引用全部可自动判定锚点，无静默跳过）');
    console.log(`  对账：in-scope 扫描 ${found.length} 处 ＝ 清单 ${IN_SCOPE.length} 条 ＝ 锚点 ${anchoredKeys.size} + 豁免 ${exemptKeys.size}；` +
      `跨文件/示例 ${XFILE.length} 条；${found.length === IN_SCOPE.length ? '✅ 引用总数与源码出现次数一致' : '❌ 不一致'}`);

    const before = t.counts.passed;
    const insN = IN_SCOPE.length, nxN = XFILE.length;
    t.check('九① 需求清单可被本节读取（真源存在，行号有落点）',
      REQ_LINES.length >= CITATION_BASELINE_INSCOPE && REQ_LINES.length >= Math.max(...CITATIONS.map(c => c.reqNo)),
      `${REQ_FILE}：${REQ_LINES.length} 行；引用到的最大行号 ${Math.max(...CITATIONS.map(c => c.reqNo))}`);
    t.check('九② 引用的需求行号不越界（行号必须落在当轮需求文件里）',
      CITATIONS.every(c => c.reqNo >= 1 && c.reqNo <= REQ_LINES.length &&
        (!c.hit || !c.hit.range || c.hit.range[1] <= REQ_LINES.length)),
      CITATIONS.filter(c => c.reqNo < 1 || c.reqNo > REQ_LINES.length).map(c => `${c.srcNo}:${c.idx}→:${c.reqNo}`).join('；') ||
      `全部 ${CITATIONS.length} 处行号 ∈ [1, ${REQ_LINES.length}]`);
    t.check('九③ 源码扫到的引用 ↔ 逐条清单**双向对账**（多一处、少一处都红 —— 这就是"引用总数 vs 源码出现次数"的构成性对账）',
      manifestMissing.length === 0 && scanMissing.length === 0 && found.length === IN_SCOPE.length,
      [`扫描 ${found.length} 处 / 清单 ${IN_SCOPE.length} 处`,
        `源码有而清单没有：${manifestMissing.map(f => `${f.srcNo}「${f.text}」`).join('；') || '无'}`,
        `清单有而源码扫不到：${scanMissing.map(c => `${c.srcNo}:${c.idx}`).join('；') || '无'}`].join('；'));
    t.check('九④ 引用总数 ≥ 冻结基线（in-scope 与跨文件各一条；形态表被改窄 / 某类引用整体写错时变红）',
      found.length >= CITATION_BASELINE_INSCOPE && XFILE.length >= CITATION_BASELINE_XFILE &&
      CITATIONS.length === CITATION_BASELINE_TOTAL,
      `in-scope ${found.length} 处（基线 ${CITATION_BASELINE_INSCOPE}）、跨文件/示例 ${XFILE.length} 条（基线 ${CITATION_BASELINE_XFILE}）、` +
      `清单合计 ${CITATIONS.length}（基线 ${CITATION_BASELINE_TOTAL}）` +
      (found.length < CITATION_BASELINE_INSCOPE || XFILE.length < CITATION_BASELINE_XFILE
        ? ' —— **引用数缩水**：形态表或源码被改窄了？' : ''));
    t.check('九⑤ 逐条清单逐处登记：每条都在源码里扫得到、行号与源码一致、类型合法（req/xfile）、无重复登记',
      scanMissing.length === 0 &&
      CITATIONS.every(c => c.hit && ['req', 'xfile'].includes(c.type) &&
        /* 行号一致性：区间引用的 `reqNo` 记的是**区间止点**，故与扫描起点比时取区间起点 */
        c.hit.lineNo === (c.rangeStart !== null ? c.rangeStart : c.reqNo)) &&
      new Set(CITATIONS.map(c => c.key)).size === CITATIONS.length,
      `清单 ${CITATIONS.length} 条（唯一键 ${new Set(CITATIONS.map(c => c.key)).size} 个）；` +
      `扫不到：${CITATIONS.filter(c => !c.hit).map(c => c.key).join('；') || '无'}；` +
      `行号不一致：${CITATIONS.filter(c => c.hit && c.hit.lineNo !== (c.rangeStart !== null ? c.rangeStart : c.reqNo)).map(c => `${c.key} 登记 ${c.rangeStart !== null ? c.rangeStart : c.reqNo} vs 实测 ${c.hit.lineNo}`).join('；') || '无'}`);
    t.check('九⑥ 每处 in-scope 引用都携带可判定锚点（源码侧写法 + 被引用行的原文），且**每处都真的命中了**（不许静默跳过）',
      badAnchor.length === 0 && resolved.length === insN,
      badAnchor.map(r => `${r.c.srcNo}:${r.c.idx}「${r.c.text}」→ 需求 :${r.c.reqNo}（${r.srcOk ? '需求行未命中' : '源码侧未命中'}）`).join('；') ||
      `${insN} 处全部命中（源码侧锚点 + 需求行锚点各 ≥1 个）`);
    t.check('九⑦ 锚点表与 in-scope 清单一 一对应、键唯一（无孤儿锚点、无重复键、每条锚点都有可读名称、分隔符已迁移）',
      anchorKeySrcCount === Object.keys(ANCHORS).length &&
      orphanAnchors.length === 0 &&
      anchoredKeys.size === Object.keys(ANCHORS).length &&
      resolved.every(r => !r.anchored || (r.a.name && r.a.name.length > 0 && !r.badSeparator)),
      `锚点表键 ${Object.keys(ANCHORS).length} 个（源码里字面量键 ${anchorKeySrcCount} 个）；in-scope 带锚点 ${anchoredKeys.size} 条；` +
      `孤儿锚点：${orphanAnchors.join('；') || '无'}；分隔符未迁移：${resolved.filter(r => r.badSeparator).map(r => r.c.key).join('；') || '无'}`);
    t.check('九⑧ 锚点的需求行侧不写死行号（行号只用 `${n}` 占位；写死 ⇒ 行号漂移时锚点跟着漂，等于没锚）',
      anchorDigits.length === 0,
      anchorDigits.length ? `写死了行号的锚点：${anchorDigits.join('；')}`
        : `${Object.keys(ANCHORS).length} 个锚点的需求行侧除 \${n} 占位符外无字面行号`);
    t.check('九⑨ 无法自动判定锚点的引用**必须**逐条登记豁免并给理由（in-scope 豁免为空＝当前没有此类引用，不是"允许跳过"）',
      missing.length === 0 &&
      Object.entries(CITATION_EXEMPT).every(([, reason]) => String(reason).trim().length >= 12) &&
      xfileKeys.size === XFILE.length &&
      XFILE.every(c => String(XFILE_EXEMPT[c.key] || '').trim().length >= 12),
      missing.length ? `未登记豁免：${missing.map(c => `${c.srcNo}:${c.idx}`).join('；')}`
        : `in-scope 无锚点引用 0 处（豁免 ${Object.keys(CITATION_EXEMPT).length} 条）；` +
          `跨文件/示例 ${XFILE.length} 条均已逐条写明理由（${Object.keys(XFILE_EXEMPT).length} 条）`);
    t.check('九⑩ 引用总数守恒：清单数 ＝ in-scope 扫描 + 跨文件数 ＝ 锚点数 + 豁免数 + 跨文件数（三路计数互相钉住）',
      CITATIONS.length === found.length + nxN && CITATIONS.length === CITATION_BASELINE_TOTAL &&
      found.length === anchoredKeys.size + exemptKeys.size &&
      found.length >= CITATION_BASELINE_INSCOPE && nxN >= CITATION_BASELINE_XFILE,
      `清单 ${CITATIONS.length}（基线 ${CITATION_BASELINE_TOTAL}）＝ in-scope ${found.length} + 跨文件/示例 ${nxN}；` +
      `in-scope ＝ 锚点 ${anchoredKeys.size} + 豁免 ${exemptKeys.size}；` +
      `基线 in-scope ${CITATION_BASELINE_INSCOPE} / 跨文件 ${CITATION_BASELINE_XFILE}`);
    t.check('九⑪ 引用**不出现在断言/可执行代码里**（只允许出现在注释与说明字符串中，避免把行号写进运行时逻辑）',
      CITATIONS.every(c => !/\bcheck\s*\(/.test(c.line || '')),
      CITATIONS.filter(c => /\bcheck\s*\(/.test(c.line || '')).map(c => `${c.srcNo}`).join('；') ||
      `${CITATIONS.length} 处引用所在行均不含 check( 调用`);
    t.check('九⑫ "引用总数 vs 源码出现次数"的**独立计数对账**：源码里 \'需求…:数字\' 的出现次数 ≥ 清单条数；' +
      '且裸 \':数字\' 形态出现次数 ≥ in-scope 引用数（裸形态没被"需求…:"覆盖，最容易整体漂移）',
      rawReqColon >= CITATIONS.length && bareColon >= found.length,
      `「需求…:数字」出现 ${rawReqColon} 次 ≥ 清单 ${CITATIONS.length} 条；` +
      `裸「:数字」出现 ${bareColon} 次 ≥ in-scope ${found.length} 处（差 ${bareColon - found.length} 次＝区间端点、非需求文件的 :39/:252、示例写法等）`);
    t.check('九⑬ 锚点具备**跨行唯一性**：每条需求行锚点模式在整份需求文件里只命中被引用的那一行' +
      '（否则行号漂到另一行、锚点照样命中 ⇒ 该锚点等于没核住）',
      weakAnchor.length === 0,
      weakAnchor.length
        ? weakAnchor.map(r => `${r.c.srcNo}:${r.c.idx}→:${r.c.reqNo}：` +
            r.docMatch.filter(d => d.ok && d.linesHit !== 1).map(d => `「${d.hit}」命中 ${d.linesHit} 行`).join('；')).join('｜')
        : `${resolved.length} 处锚点模式在需求文件内均只命中 1 行`);
    t.check('九⑭ 区间引用的**两个端点**逐端点核对（位置严格相等）：区间起/止处那一行必须命中该端点的锚点' +
      '（只核"被引用行"会漏掉端点 —— 定点变异实测：把 `:798` 改成 `:797` 时其余断言全绿）',
      Object.keys(RANGE_ANCHORS).every(k => {
        const c = IN_SCOPE.find(x => x.key === k);
        const r = RANGE_ANCHORS[k];
        if (!c || !c.hit || !c.hit.range || c.rangeStart === null) return false;
        const base = c.hit.lineNo;   // 区间偏移以**被引用行**（＝区间起点）为基准
        /* 左右两侧**位置严格相等**：清单登记的（区间起, 被引用行号）＝扫描解析出的区间
           —— 止点改成 :797 会让 `c.hit.range[1] !== c.reqNo` 当场变红（定点变异实测过）。 */
        if (c.hit.range[0] !== c.rangeStart || c.hit.range[1] !== c.reqNo) return false;   // 扫描解析的 [起点, 止点] 与清单登记的 (rangeStart, reqNo) 位置严格相等
        return [r.rangeStart, r.rangeEnd].every(e => {
          const at = base + Number(String(e.at).replace('+', ''));
          const line = REQ_LINES[at - 1];
          return typeof line === 'string' && new RegExp(e.mustMatch).test(normSpace(line));
        });
      }),
      Object.keys(RANGE_ANCHORS).map(k => {
        const c = IN_SCOPE.find(x => x.key === k);
        const r = RANGE_ANCHORS[k];
        if (!c || !c.hit) return `${k}: 引用扫不到`;
        if (!c.hit.range) return `${k}: 该引用没解析出区间（range=null）`;
        return `${k} 「${c.hit.text}」→ 扫描解析区间 [${c.hit.range.join(', ')}]、清单登记 [起点 ${c.rangeStart}, 止点 ${c.reqNo}]；` +
          [r.rangeStart, r.rangeEnd].map(e => {
            const at = c.hit.lineNo + Number(String(e.at).replace('+', ''));
            const line = normSpace(REQ_LINES[at - 1] || '');
            const ok = new RegExp(e.mustMatch).test(line);
            return `${e.name} 应在 :${at} ⇒ ${ok ? '命中' : '**未命中**'}（该行=${line.slice(0, 40)}）`;
          }).join('；');
      }).join(' ｜ '));
    console.log(`  （本节按上述断言计 ${t.counts.passed - before} 条；数字不写死，以汇总行为准）`);
  }

  if (LIST) {
    console.log('\n=== 附：全部条款归属 ===');
    for (const [id, [pattern, status, script, evidence]] of [...owner].sort()) {
      console.log(`  ${id.padEnd(10)} ${status.padEnd(16)} ${script}${evidence ? ' ← ' + evidence : ''}`);
    }
  }

  /* 汇总与退出码交给公共 runner（冻结格式见规范 9.5-5 / assert.js 的"输出契约"：
     `通过 N 项，失败 N 项，跳过 N 项` —— `run-all`、`tests\README.md` 权威区都解析这一行）。 */
  t.finish();
}

try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
