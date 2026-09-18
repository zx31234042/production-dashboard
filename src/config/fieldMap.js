/* ==========================================================================
   三方字段映射表（config/fieldMap.js）
   作用：定义"看板内部字段 ↔ 上位机报文 ↔ 附录 2 上报字段"的对应关系。
        外部字段名一变，只改本文件；业务代码不动。
   对应待确认事项：
     - upperToBoard ← Q-21（上位机接口规范；字段名以对方最终版为准）
     - boardToReport ← Q-23 / 附录 2（上报字段名以最终接口文档为准）
   依赖：无（需在 services/api.js 之前加载）

   ── 用法说明 ──
   upperToBoard 的值支持三种写法：
     1) 字符串              直接取值：'depth' → 报文里的 depth
     2) { key, scale }      取值并做数值换算（如单位从 mm 换 m：scale: 0.001）
     3) { key, map }        取值并做字典翻译（如 testStatus 数值 → 运行模式文本）
   boardToReport 的值为内部字段路径（点号分隔），支持简单函数转换。
   ========================================================================== */
window.FieldMap = (function () {
  'use strict';

  return {
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

      /* 运行模式：上位机状态码 → 看板 5 种模式（FR-2.1、FR-2.8） */
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

      /* 测试标准阈值（设备参数） */
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

    /* 上报时的状态码取值（与 upperToBoard 的 map 反向对应） */
    modeToTestStatus: {
      '待机': 0, '测试运行': 1, '正常停机': 2,
      '维保检修': 2, '故障锁定': 3
    },

    /* 报文示例（供联调与自测工具使用；字段与 upperToBoard 的 key 一一对应） */
    samplePayload: {
      equipCode: 'SX-UNDERWATER-001',
      procOrderNo: 'MES20260918001',
      collectTime: '2026-09-18 15:10:27',
      testStatus: 1,
      stage: '运行',
      linkStatus: 'online',
      depth: 12.68,
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
      stdDepth: 12.50,
      stdGain: 2.5,
      stdFps: 400,
      stdShutter: 500,
      result: '测试中',
      unitIndex: 161,
      progress: 0.62
    }
  };
})();
