/* ==========================================================================
   看板运行配置（config/board.config.js）
   需求版本：V1.35（FR-3.16 任务数据页测试标准区；FR-3.18 显示 / FR-3.19 录入按 C-90 改为
              「典型值 / 上偏差 / 下偏差」三格录入、上下限为导出值；校验按 C-91 的偏差模型）
   作用：把所有"会随外部答复变化"的参数**值**集中到这里，答复到达时原则上只改本文件，不动业务代码。
   例外：**统计公式不在本文件里** —— 按 ADR-0005 选项 B（2026-09-20 拍板）公式留在代码里，
   配置只存参数；Q-11 答复到达后**须同步修改的位置清单**见下方 production 段。
   对应待确认事项（需求清单 V1.35 第 12 章）：
     - shift            ← Q-10 班次定义
     - production       ← Q-11 统计参数（口径公式留在代码，不在此处）
     - faultDict        ← Q-12 故障代码字典（结构与示例；内容待补全）
     - maintenance      ← Q-13 维保周期与耗材
     - upper            ← Q-21 上位机接口规范（地址/频率/鉴权）
     - mes              ← Q-23 MES 接口契约（地址/回执风格/字段名见 fieldMap.js）
     - standards        ← 甲方"检测标准值/典型值"答复（FR-3.18；未到位时用 default 段演示）
   依赖：无（需最先加载）
   ========================================================================== */
/* 服务端（Node）与浏览器共用本文件：浏览器挂到 window，Node 挂到 module.exports。
   单一真源很重要 —— 班次口径/判定容差等**参数**若各存一份，前后端必然算出两套结果。
   （统计公式不属于"配置真源"：按 ADR-0005 选项 B 它留在实现里，见下方 production 段说明。） */
const BOARD_CONFIG = (function () {
  'use strict';

  const CFG = {
    /* ---------------- 数据源 ---------------- */
    /* 'mock'  = 用内置模拟数据驱动（默认，评审演示用）
       'upper' = 用"上位机报文 + 适配层"驱动（联调前自测用；?source=upper 可临时切换） */
    dataSource: 'mock',

    refreshMs: 1000,          // 界面刷新周期（NFR-01）
    reportIntervalMs: 1000,   // 向 MES 上报周期（附录 2：周期定时上传）

    /* ---------------- 设备基础信息（FR-1.1、FR-1.2） ---------------- */
    device: {
      name: '水池高速摄像检验设备',
      equipCode: 'SX-UNDERWATER-001'   // 整套系统 1 个编号，覆盖 19 台相机
    },

    /* ---------------- §1.2.5 关键运行参数报文的报文头（IF-B.5） ----------------
       `workshopNo` / `opCode` / `opName` 的取值真源；`opCode`/`opName` 按 MES 定义与派工报文同源
       （见接口澄清函 N-2 第五节示例报文）。真实接口契约（Q-23）到位后只改这里。 */
    workshopNo: '19',
    processCode: '30',                  // 工序号
    processName: '水下高速摄像检验',

    /* ---------------- 班次定义（Q-10 答复后修改此处） ----------------
       规则：start/end 为 24 小时制整点；end=24 表示次日 0 点。
       跨零点归属、节假日与计划停线是否计入，见下方两个开关。 */
    shift: {
      list: [
        { name: '晚班', start: 0,  end: 8  },
        { name: '早班', start: 8,  end: 16 },
        { name: '中班', start: 16, end: 24 }
      ],
      countHoliday: true,       // 节假日是否计入当班时长（Q-10）
      countPlannedStop: false,  // 计划停线是否计入当班时长（Q-10）
      roster: {                 // 当班人员（Q-10；联调后由 MES 人员班组资质接口提供）
        team: '检验一班',
        /* 班组编号（FR-3.19 留痕要记"班组编号"，与 FR-1.6 头部班组同一真源；
           Q-10 答复/人员接口到位后只改这里） */
        teamId: 'TM-3901',
        operator: '张伟', operatorId: 'A1027',
        leader: '李建国', leaderId: 'A1003'
      }
    },

    /* ---------------- 产能与统计参数（Q-11 答复后修改参数值） ----------------
       ⚠ 本段只存**参数值**，不存**统计公式**（ADR-0005 选项 B，2026-09-20 负责人拍板）：
         统计口径的**权威实现**在 `server/services/stats.js`（服务端，FR-4 唯一核算处），
         前端演示的**第二份同类实现**在 `src/services/mockData.js` 的 stats 段；
         **本配置不参与任何公式求值** —— 改本文件不会改变统计口径。
       口径备忘（**历史占位，并非可执行配置**，当前无任何读取点，改它不影响任何统计结果）：
         firstPass = qualified / done    capacity = done / plan
         oee       = runSec / elapsed    avgTest  = runSec / done
       （原先的 `production.formula` 键因**零读取点**已按 ADR-0005 删除，其内容仅保留于此说明。）
       Q-11 答复到达后**须同步修改的位置清单**（改任一处都必须同步其它处，缺一即前后端口径不一致）：
         1) `server/services/stats.js`  —— 派生指标算式 firstPassRate/capacityRate/oee/avgTestSec
         2) `src/services/mockData.js`  —— stats 段的同类实现（前端演示）
         3) `tests/logic-check.js`      —— 按新口径推导的**期望值**（不得沿用旧公式做同源推导）
         4) `tests/contract-check.js`   —— 占位断言（OEE 段）与跨实现一致性断言（M 段）
         5) 文档承诺（`项目架构与技术栈.md`、`README.md`、`项目记录/当前状态快照.md`）如仍写
            "只改配置"，须一并改为"须同步改上述各处"
       下方参数原样保留；只改这些参数值 ≠ 改口径。 */
    production: {
      planQty: 180,          // 当班计划测试总数
      cycleSec: 160,         // 单件测试节拍（秒）—— 任务曲线的采样点数与它一致
      runRate: 0.79,         // 有效运行占比（用于推导运行/待机时长）
      firstPassRate: 0.932,  // 一次性合格率（模拟数据用）
      queueDepth: 72         // 设备侧待测试排队量
    },

    /* ---------------- 故障代码字典（Q-12 答复后补全内容） ----------------
       结构固定：code 代码 / type 类型 / level 等级 / desc 简述 / action 处理建议 */
    faultDict: [
      { code: 'E-2071', type: '相机通信中断', level: '严重', desc: '高速相机链路丢包，已自动重连', action: '复核图像完整性' },
      { code: 'E-3115', type: '深度测量异常', level: '严重', desc: '航行器深度数据跳变超过 0.5 m', action: '重新标定后复检' },
      { code: 'E-1042', type: '水池液位偏低', level: '一般', desc: '液位低于测试下限', action: '补充水量' },
      { code: 'W-2210', type: '快门参数超限', level: '预警', desc: '快门设定值超出工艺窗口上限', action: '核对工艺参数' },
      { code: 'E-4520', type: '上位机数据传输异常', level: '严重', desc: '实时测量数据上传中断超过 5 秒', action: '检查链路与上位机状态' }
    ],

    /* ---------------- 维保参数（Q-13 答复后修改此处） ---------------- */
    maintenance: {
      lastDate: '2026-08-28',   // 上次维保日期
      cycleDays: 30,            // 固定维保周期（天）
      warnDays: 14,             // 到期预警提前天数
      consumables: [            // 耗材清单与更换判据
        { name: '水下光源', threshold: 800, unit: 'h', desc: '累计点亮时长达到阈值建议更换' },
        { name: '密封圈',   threshold: 12,  unit: '月', desc: '按周期更换' }
      ]
    },

    /* ---------------- 上位机接口（Q-21 答复后填写此处） ---------------- */
    upper: {
      url: '',                  // 例：http://10.10.2.31:8080/api/realtime
      auth: { type: 'none', token: '' },
      timeoutMs: 3000,
      /* 字段名与取值映射见 config/fieldMap.js；此处只放连接与频率参数 */
      staleMs: 5000             // 超过该时长未收到数据即判定"数据已冻结"（FR-2.6）
    },

    /* ---------------- MES 接口（Q-23 答复后填写此处） ---------------- */
    mes: {
      baseUrl: '',              // 例：http://10.10.x.x:8080/mes
      token: '',
      pathTemplate: '/service/{serviceName}/{methodName}',
      /* 回执风格：'status' = {status,msg,data}（接口定义）；'code' = {code,msg,uploadId}（附录 2） */
      responseStyle: 'status',
      /* 标准值未到位时的占位哨兵（继续沿用致 MES 方澄清函 N-7 已发口径：
         `uclValue` / `lclValue` = 65535、`IsPass` = null；不新增报文结构）。
         FR-3.18/FR-3.19 的任一必要项（典型值 / 上偏差 / 下偏差）缺失时，整条参数按本占位上报。
         贵方若指定其它空值哨兵，只改本项。 */
      reportPlaceholder: 65535,
      /* 补传队列容量上限（E10）：达到上限时**拒绝入队并告警**，绝不静默丢弃已缓存报文（NFR-13）。
         落库持久化在服务端 server/services/uploadQueue.js（写 upload_log，重启后从库读回），
         本项供浏览器侧适配层（src/services/api.js）自检与状态展示使用。 */
      queueCap: 5000,
      /* 说明（E10，2026-09-20 已定决策）：**不做自动重试** —— 不实现指数退避、不加定时器；
         上报失败只做两件事：①告警/暴露待补传条数；②把失败报文落库留存。重报由**人工触发**
         （src/services/api.js 的 retryPending()；flushPending() 只刷新状态、不发送）。
         原先的 `retry: { max, baseDelayMs }` 键自 V1.31 起**已删除** —— 它在 E10 后就没有任何读取点，
         按 ADR-0005「死配置不留」清理，不再为兼容 `CFG.mes.retry.*` 保留键位。 */
    },

    /* ---------------- 测试标准（FR-3.18 显示 / FR-3.19 录入） ----------------
       口径（V1.35 / C-90 + C-91：负责人 2026-09-24 手动测试反馈裁定 U-3）：
         - **显示与录入对象＝典型值 / 上偏差 / 下偏差**（FR-3.19③ 三个单元格均可录入）；
         - **上限 = 典型值 + 上偏差**、**下限 = 典型值 + 下偏差**，在表内以**只读导出值**给出
           （不参与录入）；**判定对象＝导出的上下限**（FR-3.14 / FR-3.18）；
           改典型值 ⇒ 上下限随偏差**整体平移**；改偏差 ⇒ **仅对应一侧**变化；
         - 符号口径：**下偏差默认负、上偏差默认正**（不带正负号按此口径）；**典型值为非负绝对量、不带符号**；
         - 校验（FR-3.19⑥ / C-91）：`下偏差 ≤ 上偏差`（含两位小数取整后的隐含下限）＋
           `上偏差 ≥ 0 ≥ 下偏差`（等价"典型值在导出上下限之间"，**典型值为空时跳过**）＋
           上/下偏差**同时存在或同时为空**；非数值 / 小数位非法 / 超量程一律弹窗且不写入；
         - 维度 = **产品号 + 工序号**（rows 的 code 即 DR-03 `standard` 的唯一键）；
         - 历史判定**不追溯**：修改成功后写新的 `effectiveAt`，自该时刻起生效；
         - 标准值由甲方现场录入（FR-3.19 / AC-09），未录入时用 `default` 段演示。
       本段四个待定值（`nearRatio` / `range.depth` / `range.speed` / `default` 的演示深度）已于
       **2026-09-22 由负责人确认**（详见各项行内注释）—— 不再是"演示默认值、待甲方确认"。

       单位与精度（第二节"单位写法"）：速度 **m/s**、深度 **m**，**均保留两位小数**。
       三态阈值（FR-3.14 / FR-3.18）：实测值 **超范围 → 红**；偏离边界不足 `nearRatio` 时 **临近 → 黄**。
         tolerance = (上限 − 下限) × nearRatio，纯参数、公式留在实现里（ADR-0005）。
         **一个参数 = 一条预警**（负责人 2026-09-22"预警名称需要细分"，见 services/mockData.js
         `buildParamWarnings()`）：临近态出「参数阈值临近预警」（warn），超范围态出「参数超范围预警」（err）；
         深度与速度各自独立成条 —— 两参数可同时越界 ⇒ 参数类预警最多 2 条。

       ⚠ 改本段只影响**默认演示取值**；现场录入后的运行值在 `state.task.standard`（运行时真源），
         不会被本段覆盖（见 components/TaskPanel.js 的 resolveStandard()）。 */
    standards: {
      processCode: '30',
      processName: '水下高速摄像检验',
      digits: 2,                                   // 显示/录入统一保留两位小数
      nearRatio: 0.15,                             // 临近带占上下限跨度比例 —— 负责人 2026-09-22 确认（15%）
      /* 量程（FR-3.19 第⑥步"超量程"校验的**唯一真源**）：录入得到的上限/下限**绝对值**
         超出本量程即拒绝写入（弹窗提醒、不写入）。需求只规定"超量程须拒绝"的机制、
         **未给定数值**；下列 min/max 由**负责人 2026-09-22 确认**（原先的演示值 depth 10~15 /
         speed 3~8 中，depth 一段已被改定），实现仍不写死任何量程 —— 若日后量程再变**只改本处**。 */
      range: {
        depth: { min: 4.00,  max: 6.00 },          // 负责人 2026-09-22 确认（单位 m）
        speed: { min: 3.00,  max: 8.00 }           // 负责人 2026-09-22 确认（单位 m/s）
      },
      /* 演示用默认标准（Q：任务剖面/检测指标/标准/典型值 未回，界面须可空可录）。
         三项即测试标准区的**三个录入单元格**（FR-3.18 / FR-3.19③）：`typical`＝典型值（非负、不带符号）、
         `upperDev`＝上偏差（默认正）、`lowerDev`＝下偏差（默认负）；导出的上限＝typical＋upperDev、
         下限＝typical＋lowerDev **不在此处配置**（由公式导出，避免"导出值也被配置"而两处不一致）。
         ⚠ 演示取值必须落在上方 `range` 内，否则演示自相矛盾（录入一个量程外的标准会被自己的校验拒绝）；
         负责人 2026-09-22 把深度量程改定为 [4, 6] m 后，下面的 depth 一行同步从 12.50（导出上下限 12.80/12.30）
         对齐为 5.00（导出上下限 5.30/4.80），与 `services/mockData.js` 的演示实测同区间。 */
      default: {
        depth: { unit: 'm',   typical: 5.00,  upperDev: 0.30, lowerDev: -0.20 },
        speed: { unit: 'm/s', typical: 5.00,  upperDev: 0.20, lowerDev: -0.20 }
      },
      /* 按 (产品号 + 工序号) 持久保存的现场标准；键形如 `CP-2026-A17|30`（DR-03 唯一键）。
         本行为演示留空：真实取值由 DR-03 `standard` 表读入（服务层另一座位）。 */
      rows: {}
    },

    /* ---------------- 相机设备参数（FR-3.5～3.8、FR-3.16 最终口径） ----------------
       任务数据页「相机参数」二级菜单：菜单项**只含参数名 + 设定值**
       （不展示实测值、偏差与状态）—— 四项相机参数是设备 PC 上位机的设备参数，
       **不参与本看板系统测试判定**，状态判定不在本看板职权范围内。
       表中 `key` 对应 `state.task.std` 的字段名（`state.task.real` 里同名字段仍由上位机
       报文写入，供上报附录 2 的 frameRate/gain/shutter/cameraDepth 使用，但**不参与判定**）。 */
    camera: {
      rows: [
        { key: 'depth',   label: '相机设定深度', unit: 'm',   digits: 2 },
        { key: 'gain',    label: '相机增益',     unit: '',    digits: 1 },
        { key: 'fps',     label: '设定帧率',     unit: 'fps', digits: 0 },
        { key: 'shutter', label: '快门速度',     unit: '',    digits: 0 }
      ]
    },

    /* ---------------- 任务曲线（FR-3.15、UI-19） ---------------- */
    curve: {
      samples: 160,     // 单个任务的采样点数（与 production.cycleSec 一致）
      keepLast: 1       // 页面展示保留的最近任务数（正式实现按 DR-18 落库后可扩大）
    }
  };

  /* 服务端（Node）也要用同一份配置 —— 班次口径、判定容差等**参数**必须**单一真源**，
     否则前后端会各算一套（这正是"配置集中地"的初衷，见规范 9.6）。
     （统计公式不在此列：按 ADR-0005 选项 B 它留在实现里，见上方 production 段说明。）
     故本文件同时支持两种加载方式：浏览器全局 window.BoardConfig ／ Node 的 module.exports。 */
  if (typeof window !== 'undefined') window.BoardConfig = CFG;
  if (typeof module !== 'undefined' && module.exports) module.exports = CFG;
  return CFG;
})();
