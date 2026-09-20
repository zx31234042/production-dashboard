/* ==========================================================================
   看板运行配置（config/board.config.js）
   作用：把所有"会随外部答复变化"的参数**值**集中到这里，答复到达时原则上只改本文件，不动业务代码。
   例外：**统计公式不在本文件里** —— 按 ADR-0005 选项 B（2026-09-20 拍板）公式留在代码里，
   配置只存参数；Q-11 答复到达后**须同步修改的位置清单**见下方 production 段。
   对应待确认事项（需求清单 V1.30 第 12 章）：
     - shift            ← Q-10 班次定义
     - production       ← Q-11 统计参数（口径公式留在代码，不在此处）
     - faultDict        ← Q-12 故障代码字典（结构与示例；内容待补全）
     - maintenance      ← Q-13 维保周期与耗材
     - upper            ← Q-21 上位机接口规范（地址/频率/鉴权）
     - mes              ← Q-23 MES 接口契约（地址/回执风格/字段名见 fieldMap.js）
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
      retry: { max: 5, baseDelayMs: 1000 }   // 失败重试：指数退避（IF-B.9）
    },

    /* ---------------- 设备参数判定容差（FR-3.5～3.8、FR-3.16） ----------------
       用于把"设定值 vs 实测值"的偏差判为 正常 / 临近 / 超标；答复到达后只改这里 */
    params: {
      tolerance: {
        depth:   { unit: 'm',   warn: 0.10, err: 0.20, digits: 2 },
        gain:    { unit: '',    warn: 0.15, err: 0.30, digits: 1 },
        fps:     { unit: 'fps', warn: 1,    err: 2,    digits: 0 },
        shutter: { unit: '',    warn: 5,    err: 10,   digits: 0 }
      }
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
