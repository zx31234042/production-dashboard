/* ==========================================================================
   三方字段映射表（config/fieldMap.js）
   需求版本：V1.46（双源采集＋实时深度/速度降级＋`IF-D.1` 的 `IF-F` 文件通道子注〔不新增条款号〕＋30 min 参考〔非硬性〕；`C-116`；不增删条款，仍 259 / P0 188 / AC 12 / Q 7）｜V1.45（十一处口径登记 `C-115`，负责人 2026-10-12 同批裁定：IF-D.8 频率／DR-13 端点标识／DR-04 件序号／DR-05 固化／FR-5.11 真源／FR-2.6 按端点＋验收／IF-D.3 只读展示／procOrderNo 看板注入／equipCode 过渡期／uploadId 归属）｜前版（C-114 两处口径登记〔①`equipCode` 的「给定方＝MES 方」在需求侧写准 —— `FR-1.2` 的「数据来源」列与 `IF-D.12` 同口径对齐（书面依据＝附录 2 的「数据来源」列＝MES 工单 与 `IF-A.4`），**取值路径与优先级一字未改**；②当班统计的「已完成」以 `result` 表为准 —— **单一真源、与 `FR-5.11` 的「已完成件数」同源**，见 `FR-4.4` 的真源声明〕；**不改任何算式、不增删条款**，仍 259 / P0 188 / AC 12 / Q 7；本文件只随需求版本戳同步，无行为改动；V1.43 / C-113 「13 张表」明确为业务表口径（`schema.sql` 实建 15 张 ＝ 13 业务表 ＋ `schema_meta` ＋ `auth_credential`；`db-check` 的 `REQUIRED_TABLES` ＝ 14），不增删条款，仍 259 / P0 188 / AC 12 / Q 7；V1.42 / C-112 三处口径补写〔DR-05 件序号与终态、FR-4.9 复检数〕；V1.41 / C-111 计量单位定义＋DR-04 件序号补登；V1.40 / C-109＋C-110 口径补写〔FR-5.11 起算点＋DR-05 写入口径〕；V1.39 / C-108 工单超时预警判据改「进度落后率超阈值率」且阈值率可配〔本文件只随需求版本戳同步，无行为改动〕；V1.38 / C-99～C-107 口径收口与接口修正；承 V1.37 / C-98：**`testStatus` 状态码口径统一到需求清单附录 2**，并登记
              「运行阶段由 `testStatus` 导出」的规则 —— 本文件改两处：①`upperToBoard['status.mode']`
              的**代码语义**按附录 2 重述（`0=待机`／`1=测试中`／`2=测试完成`／`3=设备异常`；
              码 `2` 的**界面显示模式**仍取「正常停机」，见 D1）；②`modeToTestStatus` 的
              **「维保检修」2 → 0**（附录 2 无语义对应码，按 0＝待机上报，见 D2/C-98③）。
              **显示模式取值、api.js 字典翻译、DeviceStatusPanel 图例与颜色均未改**；
              V1.36 / C-96（U-5） 只精简测试标准区说明行文案，本文件映射未变；
              FR-3.18 显示 / FR-3.19 录入：典型值 / 上偏差 / 下偏差三格录入，上下限为导出值）
   作用：定义"看板内部字段 ↔ 上位机报文 ↔ 附录 2 上报字段"的对应关系。
         外部字段名一变，只改本文件；业务代码不动。
   对应待确认事项：
     - upperToBoard ← Q-21（上位机接口规范；字段名以对方最终版为准）
     - boardToReport ← Q-23 / 附录 2（上报字段名以最终接口文档为准）
     - standardOf() ← IF-B.5 / FR-3.18（§1.2.5 的 uclValue / lclValue 取值真源）
   依赖：无（需在 services/api.js 之前加载）

   ── 用法说明 ──
   upperToBoard 的值支持三种写法：
     1) 字符串              直接取值：'depth' → 报文里的 depth
     2) { key, scale }      取值并做数值换算（如单位从 mm 换 m：scale: 0.001）
     3) { key, map }        取值并做字典翻译（如 testStatus 数值 → 运行模式文本）
   boardToReport 的值为内部字段路径（点号分隔），**恰为附录 2 的 13 字段**。
   §1.2.5（PARAM_INFO_RECV）的 `dataList[]` 结构**不在此处映射**：它是另一个报文结构，
   由 services/api.js 的 buildParamReportPayload() 组装，上下限取值复用本文件 standardOf()。
   ========================================================================== */
window.FieldMap = (function () {
  'use strict';

  const MAP = {
    /* ---------------- 上位机报文 → 看板内部 ---------------- */
    upperToBoard: {
      /* 设备与工单 */
      'device.code':            'equipCode',
      'task.procOrderNo':       'procOrderNo',
      'task.productCode':       'productCode',
      'task.productName':       'productName',
      'task.batchNo':           'batchNo',
      'task.drawingNo':         'drawingNo',
      'task.orderNo':           'orderNo',
      'task.planQty':           { key: 'planQty', digits: 0 },

      /* 运行模式：上位机状态码 → 看板 5 种**显示模式**（FR-2.1、FR-2.8；C-98①）
         **代码语义以需求清单附录 2 为准**（负责人 2026-09-24 裁定，C-98）：
             0 = 待机 ／ 1 = 测试中 ／ 2 = 测试完成 ／ 3 = 设备异常
         **D1（代码语义与显示模式并存，不冲突）**：
           · 码 `2` 的**代码语义＝「测试完成」**（上位机侧含义），在**界面显示**为
             「**正常停机**」（灰）—— 本表右值即"看板显示模式"，故 `2 → '正常停机'`，
             **不得**改成 `'测试完成'`（FR-2.1 的五态文案是看板显示口径）；
           · 「**维保检修**」**无对应状态码**（其来源为**本机维保状态**，不由上位机
             `testStatus` 给出）⇒ 本表只覆盖 5 种显示模式中的 4 种，第 5 种由本机维保
             状态注入；上报侧对「维保检修」按 0＝待机 兜底，见下方 `modeToTestStatus`。
         ⚠ 本表**只做"码 → 显示模式"的字典翻译**，不承担阶段（`status.stage`）语义；
             运行阶段由 `testStatus` 导出的规则是「准备=0／运行=1／判定=2／完成=0」，
             见 FR-2.5 / C-98④，落在两处模拟上位机（`services/mockUpperSource.js`、
             `tools/mock-upper/mock-upper.js`）内 —— 与"阶段文本字段"并非同一映射。 */
      'status.mode': {
        key: 'testStatus',
        map: { 0: '待机', 1: '测试运行', 2: '正常停机', 3: '故障锁定' }
      },
      /* 运行阶段：4 阶段（FR-2.5 / C-44） */
      'status.stage':           'stage',
      /* 联网状态（FR-2.6） */
      'status.online': {
        key: 'linkStatus',
        map: { online: '在线正常', offline: '离线断连', error: '数据传输异常' }
      },

      /* 实测数据（主要展示对象） */
      'task.real.depth':        { key: 'depth',       digits: 2 },
      'task.real.speed':        { key: 'speed',       digits: 2 },
      'task.real.vx':           { key: 'velocity_x',  digits: 2 },
      'task.real.vy':           { key: 'velocity_y',  digits: 2 },

      /* 设备参数（次要展示） */
      'task.real.fps':          { key: 'frameRate',   digits: 0 },
      'task.real.gain':         { key: 'gain',        digits: 1 },
      'task.real.shutter':      { key: 'shutter',     digits: 0 },
      'task.real.cameraDepth':  { key: 'cameraDepth', digits: 2 },

      /* 测试标准阈值（设备参数）：`stdDepth` ＝ **相机设定深度**（FR-3.5 / IF-D.3 的「设备参数」，
         由任务数据页二级菜单展示、不参与本看板判定），与航行器深度（`task.real.depth`，量程
         [4, 6] m）是**两个物理量** ⇒ 不随深度量程迁移，保持 12.50；其余三项为相机设备参数 */
      'task.std.depth':         { key: 'stdDepth',   digits: 2 },
      'task.std.gain':          { key: 'stdGain',    digits: 1 },
      'task.std.fps':           { key: 'stdFps',     digits: 0 },
      'task.std.shutter':       { key: 'stdShutter', digits: 0 },

      /* 任务结果与进度 */
      'task.result':            'result',
      'task.unitIndex':         { key: 'unitIndex', digits: 0 },
      'task.progress':          { key: 'progress',  digits: 3 },

      /* 采集时间（用于判定数据新鲜度） */
      'lastCollectTime':        'collectTime'
    },

    /* ---------------- 看板内部 → 附录 2 上报报文（13 字段） ---------------- */
    boardToReport: {
      equipCode:     'device.code',
      procOrderNo:   'task.procOrderNo',
      frameRate:     'task.real.fps',
      gain:          'task.real.gain',
      shutter:       'task.real.shutter',
      cameraDepth:   'task.real.cameraDepth',   // 相机水下深度
      depth:         'task.real.depth',         // 航行器水下深度
      speed:         'task.real.speed',
      velocity_x:    'task.real.vx',
      velocity_y:    'task.real.vy',
      collectTime:   'lastCollectTime',
      testStatus:    'task.testStatus',         // 整数状态码（与报文同源）
      uploadId:      '@uploadId'                // 由 api.js 生成，非 state 字段
    },

    /* (F15-3) 该 `standardLimits` 是否**允许回退演示默认上下限**：缺省允许（演示模式原样），
       但服务端模式必须禁止（见 `board.config.js` 的 `dataSource === 'server'`）。 */
    allowDemoStandardFallback: true,

    /* 说明：`uclValue` / `lclValue` / `IsPass` 属 **§1.2.5 关键运行参数报文**（IF-B.5 / C-78），
       **不是**附录 2 的 13 个字段，故**不列进 boardToReport**（否则 IF-B.8 的字段数会变）。
       该结构的组装在 `services/api.js` 的 `buildParamReportPayload()`；
       其上下限取值复用本文件的 `standardOf()`（单一真源），不在这里另写一份映射。 */

    /* 上报 MES 的状态码取值（FR-2.8 / C-98③；反查上方 `upperToBoard['status.mode']` 的显示模式）
       **以需求清单附录 2 的代码语义为准**：0 = 待机 ／ 1 = 测试中 ／ 2 = 测试完成 ／ 3 = 设备异常

         显示模式      上报码   依据
         待机      →   0       附录 2：待机
         测试运行  →   1       附录 2：测试中
         正常停机  →   2       附录 2：测试完成（显示模式为「正常停机」，见 D1）
         维保检修  →   0       **附录 2 中「维保检修」无对应状态码**（来源为本机维保状态）
                              ⇒ 按 0（待机）上报（D2 / C-98③：**原实现误写为 `2`**，
                                在附录 2 语义下等于"上报：测试完成"，**语义失真，必须为 0**）
         故障锁定  →   3       附录 2：设备异常 */
    modeToTestStatus: {
      '待机': 0, '测试运行': 1, '正常停机': 2,
      '维保检修': 0, '故障锁定': 3
    },

    /* 报文示例（供联调与自测工具使用；字段与 upperToBoard 的 key 一一对应） */
    samplePayload: {
      equipCode: 'SX-UNDERWATER-001',
      procOrderNo: 'MES20260918001',
      collectTime: '2026-09-18 15:10:27',
      testStatus: 1,
      stage: '运行',
      linkStatus: 'online',
      depth: 5.00,                              // 航行器深度（量程 [4, 6] m，演示典型值 5.00）
      speed: 4.89,
      velocity_x: 4.89,
      velocity_y: 0.10,
      frameRate: 400,
      gain: 2.5,
      shutter: 500,
      cameraDepth: 12.00,
      productCode: 'CP-2026-A17',
      productName: '水下振动测试件',
      batchNo: 'PC20260918-03',
      drawingNo: 'SJ-4471-02',
      orderNo: 'DD20260917-118',
      planQty: 180,
      stdDepth: 12.50,                          // 相机设定深度（设备参数，与航行器深度无关）
      stdGain: 2.5,
      stdFps: 400,
      stdShutter: 500,
      result: '测试中',
      unitIndex: 161,
      progress: 0.62
    }
  };

  /**
   * 取 (产品号 + 工序号) 对应的标准上下限**绝对值**。
   * 单一真源：现场录入后的运行值 `state.task.standard`（FR-3.19）；
   * 未录入时回退 `BoardConfig.standards.default` —— **仅作演示**（真实系统该回退不存在，
   * 未录入即"标准未设定"，上报按占位，见 N-7）。
   * @param {object} state 看板状态
   * @returns {{depth:{upper:number,lower:number}, speed:{upper:number,lower:number}}|null}
   *          null = 必要项（典型值 / 上偏差 / 下偏差）缺失，调用方按占位上报
   */
  function standardOf(state) {
    const limits = standardLimits(state);
    return (limits.depth && limits.speed) ? limits : null;
  }

  /**
   * 取**每个检测参数各自**的标准上下限（绝对值）——IF-B.5 要求"**任一必要项缺失即该条
   * `tagParam` 走占位**"：缺的是深度那条，就不该连速度那条一起占位，故必须按参数分别判定。
   *
   * 取值口径：
   *   - 该参数已在 `state.task.standard` 建过行（DR-03）⇒ **只认这一行**；缺必要项 ⇒ 该项为 null
   *     （＝标准未设定，调用方按占位 `65535` / `IsPass=null` 上报）；
   *   - 未建行 ⇒ 用 `BoardConfig.standards.default` 兜底（**仅演示**；真实系统此处也是"未录入"）；
   *   - ⚠ **服务端模式下禁止该兜底**（F15-3，2026-09-28 负责人裁定，依据 ADR-0008 D3）：
   *     `dataSource === 'server'` 时，`standard` 表为空 ⇒ 快照 `standard = null` ⇒
   *     `state.task.standard` 未建行；若此处仍回退演示默认，就会出现
   *     **界面空、而 `Api.standardLimits()` 却有值（depth 5.30/4.80 · speed 5.20/4.80）的
   *     三方不一致**（服务端 `standard.mesLimits()` 在没有标准时一律回占位 `65535` / `IsPass:null`，
   *     从不回退演示默认）。故服务端模式下一律 `null` ⇒ 界面「标准未设定」/「—」、
   *     上报侧沿用 N-7 既有哨兵。**演示模式行为保持原样**（仍回退演示默认）。
   *     旁路开关：`MAP.allowDemoStandardFallback`（供自检显式控制；缺省 true）。
   * @param {object} state 看板状态
   * @returns {{depth:{upper:number,lower:number}|null, speed:{upper:number,lower:number}|null}}
   */
  function standardLimits(state) {
    const spec = (window.BoardConfig || {}).standards || {};
    const dp = typeof spec.digits === 'number' ? spec.digits : 2;
    const r = Math.pow(10, dp);
    /** 单参数换算：上限＝典型值＋上偏差，下限＝典型值＋下偏差；必要项缺一即 null */
    const norm = row => {
      if (!row || !isNum(row.typical) || !isNum(row.upperDev) || !isNum(row.lowerDev)) return null;
      return {
        upper: Math.round((row.typical + row.upperDev) * r) / r,
        lower: Math.round((row.typical + row.lowerDev) * r) / r
      };
    };
    const run = (state && state.task && state.task.standard) || null;
    /* 服务端模式禁止回退演示默认（F15-3）；`allowDemoStandardFallback === false` 亦禁止 */
    const serverMode = !!((window.BoardConfig || {}).dataSource === 'server');
    const dft = (serverMode || MAP.allowDemoStandardFallback === false) ? null : (spec.default || null);
    const out = {};
    ['depth', 'speed'].forEach(kind => {
      const recorded = !!(run && Object.prototype.hasOwnProperty.call(run, kind));
      out[kind] = recorded ? norm(run[kind]) : (dft ? norm(dft[kind]) : null);
    });
    return out;
  }

  /** 是否为有限数值 */
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  /* 暴露取值函数：api.js 的 MES 报文组装必须复用同一份换算，不得各写一份。
     `standardLimits` 按参数分别返回（IF-B.5 的"该条 tagParam 走占位"需要），
     `standardOf` 是"两项都齐才算有标准"的便捷视图（界面判定用）。 */
  MAP.standardLimits = standardLimits;
  MAP.standardOf = standardOf;
  return MAP;
})();
