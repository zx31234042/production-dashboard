/* ==========================================================================
   看板整机快照（server/services/stateSnapshot.js）—— W5-①「服务端 SSE 业务推送」
   作用：把"看板这一刻的全量状态"组装成**一份**对象，供两个出口共用：
     · SSE 建连时的 `event: hello`（`data` 即 `{ok, at, seq, snapshot}`）
     · REST 的 `GET /state`（响应体同形）
   **同源要求（判据①）**：两处**必须**由本文件的 `snapshot()` 产出 —— 禁止两套拼装
   （否则 `hello` 与 `/state` 会各自演化，前端切源时必然对不上）。`at` / `seq` 由调用方
   （`http/router.js`）加在信封上，**不进** `snapshot` 本体，这样同一时刻两次读取可深比较。
   ---- snapshot 的键名（**一旦定下即契约**，W5-② 的前端切源按此表消费）----------------
     link     { state:'online'|'offline', online:boolean, staleMs:number,
                lastAcceptedAt:string|null, lastCollectTime:string|null, lastCollectMs:number|null }
              来源：`services/ingest.linkState()`（FR-2.6 的唯一真源，**不重算阈值**）
              ⚠ 刻意**不含** `ageMs` / `reason`：它们随"读的时刻"变化，会把"hello 与 /state 同源"
                这条判据变成时间敏感的；需要它们请读 `GET /ifd/status` 或 `GET /ifd/health`。
     task     { procOrderNo, batchNo, productCode, productName, productNo, drawingNo, orderNo,
                processNo, processName, planQty:number, status, planStartTime, planEndTime,
                actualStart, actualEnd, updatedAt } | null
              来源：`task` 表最近更新的一条（DR-02；无工单 ⇒ null）
     device   { equipCode, equipName } | null         来源：`device` 表（DR-01）
     frame    { equipCode, procOrderNo, collectTime, seq, depth, speed, velocity_x, velocity_y,
                frameRate, gain, shutter, cameraDepth, testStatus } | null
              来源：**最新 1 s 采样帧**（`ingest.lastSampledFrame()`），形状与上位机 `upper` 报文
              逐字段同名（前端 `applyUpperPayload()` 直接可消费）；缺测字段按报文原样缺省（不编造）
     stats    `services/stats.computeShiftStats()` 的全量产物（键名即其返回值）：
              { shift:{name,date,startAt,endAt,elapsedSec,totalSec}, planQty, startedQty,
                notStartedQty, doneQty, runningQty, waitingQty, passQty, failQty, retestQty,
                firstPassRate, runSec, idleSec, avgTestSec, capacityRate, oee,
                accumulate:{daySec,monthSec,yearSec,at,reset}, orderTotal, cycleSec }
              来源：**当班统计的唯一核算处**（FR-4 十五项口径不在此重写）
              ⚠ **计量单位（需求 V1.41 §0.2 / C-111）**：`FR-4.x` 的单位统一为「**测试任务（件）**」
                —— **派工**＝`DR-02` `task` 一行（`IF-A.1` 一条报文，含 `dispatchQty` 个测试任务），
                **测试任务/件**＝一次测试（以 `measure_rt.unit_index` 区分）。故：
                · `planQty`（FR-4.1）＝Σ 当班 `task.plan_qty`＝**测试任务数**；
                · `startedQty`（FR-4.2）＝当班 `measure_rt` 里 `unit_index IS NOT NULL`、
                  按 `(proc_order_no, unit_index)` 去重的**件数**；
                · `notStartedQty`（FR-4.3）＝`max(0, planQty − startedQty)` ⇒ **减数与被减数同单位**；
                · `orderTotal` ＝ 参与核算的**派工票数**（`task` 行数）—— **唯一保留的票级量**。
              取数（技术债 `E65` 的分离 ＋ `E69` 的单位修复）：
                · `planQty`/`notStartedQty` ← `task`（`plan_qty`、`plan_start_time` 落在当班窗口）；
                · `startedQty` ← `measure_rt`（`unit_index` 去重件数，窗口按帧 `collect_time`）；
                · `doneQty`/`passQty`/`failQty`/`retestQty`/`runningQty`/`waitingQty`/
                  `firstPassRate`/`avgTestSec` ← `result` 表（DR-05，`judged_at` 落在当班窗口）。
              ⚠ "已完成"的**取数真源＝`result` 表**，不是 `task.status`（后者全仓无写入方 ⇒
                "已完成"恒 0，与 `FR-5.11` 的 detail 同屏矛盾；E61／审查 P1-2 已裁定改源）。
              ⚠ **不用** `task.status` 判"已开工"（同一原因：无写入方）；开工判定＝`measure_rt`
                里有该件的采样数据且 `unit_index` 非空。
              ⚠ `src/config/board.config.js` 的 `production.planQty` **仅供前端演示**，本段不取它
                （计划数真源＝当班 `task.plan_qty` 之和；无派工 ⇒ 0，见 `E65`）。
     standard { productCode, processCode, versionNo:number|null, effectiveFrom:string|null,
                depth:{typical,upperDev,lowerDev,upper,lower,set}, speed:{同左},
                limits:{depth:{upper,lower,typical}|null, speed:{…}|null} } | null
              来源：`services/standard`（`getEffectiveStandard` + `toDisplayStandard` +
              `absoluteLimits`）；无工单/无生效版本 ⇒ null
     upload   { configured:boolean, baseUrl:string, responseStyle:'status'|'code',
                pendingCount:number, pendingOnly:number, failedAfterRetry:number, total:number,
                capacity:number, warnThreshold:number, oldestAt:string|null, alert:object,
                autoRetry:false }
              来源：**W4 的 `GET /upload/status` 同一真源**（`uploadReporter.status()` 的子集）
      notices  { notices:Array<{id,tag,text,lv,time}>, tips:Array<{id,tag,text,lv,time}>, todo:[] }
               来源：`repo/notice.js` 的 `listForBoard()`（`DR-10`；**写入口**同在该仓储，
               接线见 `server/index.js` 的 6d-3 段，`FR-7.12` P0）。**与前端 `state.notices` 同形**：
               `notices`/`tips` 的行＝`{id, tag, text, lv, time}`（`tag`←`sub_type`、`text`←`content`
               原文、`lv` 恒 `info`＝DR-10 没有等级列、`time`←`valid_from` 的 `HH:MM`）；
               `todo` **恒为空数组** —— 前端 `todo` 的行是派生量（`{name,value,unit,lv}`），
               `notice` 表里没有这些数 ⇒ 由前端既有空态承担（**不造数**）。
   ---- 口径与边界 --------------------------------------------------------------------
     · 时间：`snapshot` 本体**不含**"现在几点"；需要时刻读信封的 `at`（注入时钟给出，D17）。
       `stats.shift.elapsedSec` 等当班进度**随秒前进**（跨秒两次读取可能差 1 s），这是当班
       进度的应有语义；`link` 与 `frame` 在同一次状态变化之间是稳定的。
     · 缺什么给什么：无工单/无帧/无上报器 ⇒ 对应键为 null 或按上文缺省，**绝不编造**数值。
     · DR-17 累计运行（**ADR-0009 D4 落地**；**`E83` 起一次给两套投影**）：`stats.accumulate` 的
       日/月/年三档不再是恒 0 ——
       · **已固化部分**＝对 `shift_stat` 求和（读口 `repo/shiftStat.js` 的 `sumRunSec()`；
         周期键由本文件按注入时钟取）；
       · **当班增量**（`addRunSec`）＝当班实时 `runSec` − **该班次已固化的 `run_sec`**（读口
         `repo/shiftStat.js` 的 `getShiftRow()`）⇒ 已固化部分不会被重复相加，且新读数**不回退**；
       · 三档求和的结果与增量一起交给 `services/stats.js` 的 `accumulateRunTime()`（算式仍只此一处）。
       **`E83` 的两个投影（负责人 2026-10-04 裁定）** —— "当日/本月/年度累计"按**自然日**切，
       而班次指标按**班次边界**切；同一行 `shift_stat` 同时承载两套读数：
       · **自然日投影**（`FR-6.4/6.5/6.6` 的真源）＝`sumRunSec()` 按**零点切段**求和
         （`shift_date = D` 的 `run_sec_day1` ＋ `shift_date = D−1` 的 `run_sec_day2`）＋ 当班增量按段分配
         ⇒ 这就是 `stats.accumulate` 的日/月/年三档；
       · **班次投影**（`DR-06`／`FR-4.16`，`E83` 之前的读数逐字保留）＝同一读口给的
         `shiftDaySec/shiftMonthSec/shiftYearSec`（按 `shift_date` 对 `run_sec` 求和＝整班归开始日）；
       · 两者一并挂在 `snapshot.lastRunAccum`（`naturalDay` 与 `shiftProjection` 两段）供 `/health` 对账。
       实现细节与已知边界（跨零点班次配置下"当班增量"的归属）见 `statsOf()` 内注释与回执。
     · `snapshot.lastRunAccum`：本文件把上面那次 DR-17 读数**另挂在快照函数对象上**（**不进** `snapshot()`
       的返回体 —— 那是 hello/`GET /state` 的契约，不动它），供 `GET /health` 的 `runAccum` 字段只读引用
       （"addRunSec 到底从哪儿读的"要能被巡检看见；null ＝还没做过一次快照）。
     注：`createStateSnapshot()` 返回的函数体读者见文件头 schema 表；`statsForShift()` 是本模块**导出**的
     唯一取数口（`server/index.js` 的 DR-06 固化/补记复用它，禁两份 SQL）。
   依赖：`platform/clock.js`、`server/services/{shift,stats,standard}.js`、`src/config/board.config.js`。
   ========================================================================== */
'use strict';

const platformClock = require('../../platform/clock');
const boardConfig = require('../../src/config/board.config.js');
const { createShiftRules } = require('./shift');
const statsSvc = require('./stats');
const standardSvc = require('./standard');
/* DR-06（`shift_stat`）的仓储：本文件只用它的两个**读口**（`sumRunSec` / `getShiftRow`）取 DR-17 的
   累计值，**不写任何表**（写入口在 `repo/shiftStat.js`，接线在 `server/index.js` 的跨班固化点）。
   无循环依赖：`repo/shiftStat.js` 只依赖传入的 db 句柄。 */
const shiftStatRepo = require('../repo/shiftStat');
/* `DR-10`（`notice` 表）的**读口**：`FR-7.12`（P0）接线后，快照要带 `notices` 段
   （前端 `state.notices` 同形）。本文件**只读**该表（写入口在 `repo/notice.js`，接线在
   `server/index.js` 的 6d-3 段）—— 投影只有 `listForBoard()` 一份，`POST /notice` 的响应复用它。 */
const noticeRepo = require('../repo/notice');

/** 帧载荷的字段清单（**与 IF-D / fieldMap.upperToBoard 的 key 同名**；顺序只为可读） */
const FRAME_FIELDS = Object.freeze([
  'equipCode', 'procOrderNo', 'collectTime', 'seq',
  'depth', 'speed', 'velocity_x', 'velocity_y',
  'frameRate', 'gain', 'shutter', 'cameraDepth', 'testStatus'
]);

/** 工单关键字段（task 表的业务列；不算 SQL 结构真源 —— 结构真源仍是 `server/db/schema.sql`） */
const TASK_FIELDS = Object.freeze([
  ['procOrderNo', 'proc_order_no'], ['batchNo', 'batch_no'], ['productCode', 'product_code'],
  ['productName', 'product_name'], ['productNo', 'product_no'], ['drawingNo', 'drawing_no'],
  ['orderNo', 'order_no'], ['processNo', 'process_no'], ['processName', 'process_name'],
  ['planQty', 'plan_qty'], ['status', 'status'], ['planStartTime', 'plan_start_time'],
  ['planEndTime', 'plan_end_time'], ['actualStart', 'actual_start'], ['actualEnd', 'actual_end'],
  ['updatedAt', 'updated_at']
]);

/** 空值归一：库里的 null/undefined 统一成 null（"没有值"与"值是 0"必须分得开） */
function nullIfAbsent(v) {
  return v === undefined || v === null ? null : v;
}

/** 取配置段（容错：配置缺段时给空对象，不抛 —— 缺的是**参数**，不是结构） */
function segOf(config, name) {
  const v = config ? config[name] : null;
  return v && typeof v === 'object' ? v : {};
}

/** "没有库"时的 DR-17 三档求和读数（与 `repo/shiftStat.js` 的 `sumRunSec()` 返回**同形**，
 *  免得下游为了"没库"再写一套分支口径；全 0 ＝"一个班次都还没固化"的**真 0**）。 */
const EMPTY_RUN_SUMS = Object.freeze({
  daySec: 0,
  monthSec: 0,
  yearSec: 0,
  /* `E83` 的两套投影都要在"没有库"时同形（否则下游为"没库"还得再写一套分支） */
  shiftDaySec: 0,
  shiftMonthSec: 0,
  shiftYearSec: 0,
  undetermined: Object.freeze({ day: 0, month: 0, year: 0 }),
  rows: 0
});

/**
 * 取某班次窗口的当班统计（**唯一的取数口**）：`GET /state` 快照与 DR-06（`shift_stat`）的固化/补记
 * **共用这一份 SQL** —— 两份 SQL 就是两个口径（与 `repo/result.js` 的 `countDone()` 归口同一取舍）。
 *
 * **计量单位与取数（需求 V1.41 §0.2 / C-111；技术债 `E65` ＋ `E69`）**：
 *   ① **开工判定 ＝ 当班窗口内该件在 `measure_rt` 有采样行且 `unit_index` 非空**，
 *      按 `(proc_order_no, unit_index)` **去重**后数**件数**（库内可推、**不新增写点**、
 *      **不用 `task.status`）。`E69` 之前这里问的是"该票有没有帧"⇒ 数出来是**派工票数**，
 *      而 `planQty` 是**测试任务数** ⇒ `FR-4.3` 的减数与被减数不同单位（实测 30 件 / 3 票 / 未开工 27）。
 *      为什么不用 `task.status`／`actual_start`：这两列**全仓无写入方**（`dispatch.js:683` 自述
 *      `status` 不写 —— 它是本机进度列；`schema.sql` 缺省「待测试」）⇒ 若拿它判开工，"开工"恒 0
 *      （这是 `E65` 的**改前**形态）。也**不**在这里补写 `task.status`／`actual_start` —— 那是被
 *      负责人否决的选项 B（见 `E65`）。
 *   ② **当班归属**：票按 `task.plan_start_time` 落在班次窗口；件按 `result.judged_at` 落在班次窗口；
 *      **开工件按帧的 `collect_time`** 落在班次窗口；**无 `plan_start_time` 的票不参与统计**
 *      （不编造、也不按 0 计）。窗口用**既有班次真源** `services/shift.js`
 *      （`shift.startAt`/`shift.endAt` 本身就是 DR-16 文本，直接做半开区间
 *      `>= startAt AND < endAt` 比较 —— 不在这里另造时间源、不重算班次边界）。
 *   ③ **计划数 ＝ Σ 当班窗口内 `task.plan_qty`**（单位＝测试任务/件）；**无派工 ⇒ 计划 0**；
 *      **不用配置的演示值顶替**（`board.config.js` 的 `production.planQty` 自 `E65` 起**仅供前端演示**，
 *      本段**不再读它**）。
 *
 * **本函数只做取数**（取数层的活），十五条算式一条都不在这里（仍在 `stats.js`）：
 *  `DONE_STATUS`＝合格＋不合格由 `stats.js` 判；`待复检` 不计已完成的理由与 SQL 归口在
 *  `repo/result.js` 的 `countDone()`；`startedPieces`（开工件数）由本函数按上面的 SQL 数出来，
 *  它只描述**数据状态**，不是算式（`notStartedQty` 的算式仍在 `stats.js`）。
 *  ⚠ `task` 表仍供快照的 `task` 段（DR-02 工单信息）与标准段取数，本函数不动那两处。
 *
 * @param {object} db SQLite 句柄（只读；可为 null ＝"没有库"）
 * @param {{name:string, date:string, startAt:string, endAt:string, totalSec:number, elapsedSec:number}} shift
 *        班次对象（真源＝`services/shift.js` 的 `at()`；固化过去的班次时 `elapsedSec` 取 `totalSec`）
 * @param {{config?:object, now:string|Date, accum?:object, addRunSec?:number}} [options]
 *        `now` ＝ 注入时钟给出的当前时刻（DR-17 的推进基准，D17）；`accum`/`addRunSec` 原样转交
 *        `computeShiftStats()`（算式只此一处）。
 * @returns {{stats:object, fact:{orderTotal:number, startedPieces:number, pieceCount:number, frameCount:number}}}
 *        `stats` ＝ `computeShiftStats()` 的全量产物；`fact` ＝ **取数层的事实**（不是算式）：
 *        `frameCount` 是该窗口内 `measure_rt` 的行数 —— `0` 表示"这一档**没有采集数据**"
 *        （无法判定运行时长），供 `shift_stat` 的固化口把该事实写成**显式状态位**
 *        （`oee`/`pass_rate` 落 NULL），**不得**用 0 冒充"零运行"（技术债 `E38` 的既有口径）。
 */
function statsForShift(db, shift, options = {}) {
  const config = options.config || boardConfig;
  const now = options.now;
  const addRunSec = options.addRunSec === undefined ? 0 : options.addRunSec;
  /* ---- 票级取数（`task`）----
     只取"计划开工时刻落在当班窗口内且确实有派工数量"的票；`plan_start_time` 为空 ⇒ **整票不参与**
     （`plan_start_time IS NOT NULL AND plan_start_time <> ''`；不按 0 处理、不拿 `created_at` 顶替）。
     ⚠ `plan_qty` 的**单位＝测试任务（件）**（需求 V1.41 §0.2 计量单位口径 / C-111：一条 `IF-A.1`
     派工报文含 `dispatchQty` 个测试任务）—— 故它就是 `FR-4.1` 的"测试任务数"，与下面的开工件数同单位。 */
  let orders = [];
  let startedPieces = 0;
  if (db) {
    const rows = db.prepare(
      `SELECT proc_order_no AS procOrderNo, plan_qty AS planQty
         FROM task
        WHERE plan_start_time IS NOT NULL AND plan_start_time <> ''
          AND plan_start_time >= ? AND plan_start_time < ?`
    ).all(shift.startAt, shift.endAt);
    orders = rows.map(r => ({ planQty: r.planQty }));
    /* 开工判据（`FR-4.2` / C-111，技术债 `E69` 的修复点）：当班窗口内、`unit_index IS NOT NULL`、
       按 `(proc_order_no, unit_index)` **去重后的件数** —— 即"当班已开始测试的**测试任务数**"，
       判定依据＝该件在 `measure_rt` 有采样数据。窗口按**帧的 `collect_time`**（与 `started` 的
       旧口径同一个时间列），半开区间 `>= startAt AND < endAt`（与 `services/shift.js` 同一真源，
       不在这里另造时间源）。
       ⚠ **为什么必须去重 + 必须排除 NULL**（上一版的病灶，实测：30 件 / 3 票 / 未开工 27）：
         · 旧实现问的是"该票**有没有**采样帧"（`SELECT 1 … LIMIT 1`）⇒ 数出来是**派工票数**，
           而 `planQty` 是**测试任务数** ⇒ `FR-4.3` 的减数与被减数是**两种单位**（E69 的根因）；
         · 同一件推多帧（1 s 采样）⇒ 不去重就会把"件数"数成"帧数"；
         · `unit_index IS NULL` 的帧**没有件可归属**（帧没带/件序号非法 ⇒ 落库写 NULL）⇒ 不计入，
           否则等于把"拿不到"当成"开工了一件"（与 `judge.js` 的"拿不到不说"同一纪律）；
           这类帧的条数可从 `ingest.status().frameUnitIndex.withoutIndex`（`/health` 里）读到。
       ⚠ 与 `orders` 的**边界**（如实登记，不是新口径）：本数**不**按"票是否参与"过滤 —— 裁定原文
         只给"当班窗口 + `unit_index IS NOT NULL` + 按 `(proc_order_no, unit_index)` 去重"三条，
         故某票的 `plan_start_time` 落在窗外时，其当班帧仍计入开工件数；`FR-4.3` 的
         `max(0, 计划 − 开工)`（在 `stats.js`）保证未开工数不会因此为负。 */
    startedPieces = db.prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT 1 AS hit FROM measure_rt
          WHERE collect_time >= ? AND collect_time < ?
            AND unit_index IS NOT NULL
          GROUP BY proc_order_no, unit_index)`
    ).get(shift.startAt, shift.endAt).c;
  }
  /* ---- 件级取数（`result`，DR-05）----
     按 `judged_at` 落窗口取"当班件"；`result` 逐行原样映射给 `stats.js`（**不改写、不换算、不补 0**），
     五态取值域与 `stats.js` 的 `STATUS` 同一份（`repo/result.js` 已在写入口校验过）。 */
  let pieces = [];
  if (db) {
    const rows = db.prepare(
      `SELECT result, duration_sec AS durationSec
         FROM result
        WHERE judged_at IS NOT NULL AND judged_at >= ? AND judged_at < ?`
    ).all(shift.startAt, shift.endAt);
    pieces = rows.map(r => ({ result: r.result, durationSec: r.durationSec }));
  }
  /* 有效运行/待机推导仍用**当班窗口内**的采样时刻串（与票级"有无帧"同源，但用途不同：
     前者数条数、后者只判有无）。条数上限 1000 与既有实现逐字一致（本包不动该口径）。 */
  const measures = db
    ? db.prepare(
      `SELECT collect_time AS collectTime FROM measure_rt
        WHERE collect_time >= ? AND collect_time < ?
        ORDER BY id DESC LIMIT 1000`).all(shift.startAt, shift.endAt)
    : [];
  const computed = statsSvc.computeShiftStats({
    shift,
    orders,
    /* 开工数：**当班的测试任务（件）数**（`FR-4.2` / C-111）。字段名把单位写在脸上 ——
       它是**件数**，不是票数、更不是帧数（`stats.js` 的 docblock 同此口径）。 */
    startedPieces,
    pieces,
    measures: measures.map(r => r.collectTime),
    cycle: { sec: segOf(config, 'production').cycleSec },
    now,
    accum: options.accum,
    addRunSec
  });
  return {
    stats: computed,
    fact: {
      orderTotal: orders.length,
      startedPieces,
      pieceCount: pieces.length,
      frameCount: measures.length
    }
  };
}

/**
 * 创建整机快照构造器。
 * @param {{db?:object, ingest?:object, upload?:object, now?:Function, config?:object}} [options]
 *   `db`     —— SQLite 句柄（读 `task`／`device`／`measure_rt`／`result`；**只读**，不写任何表）
 *   `ingest` —— `services/ingest.js` 实例（`linkState()` / `lastSampledFrame()`）
 *   `upload` —— `services/uploadReporter.js` 实例（`status()`）；缺省 ⇒ `upload` 键为 null 的子集
 *   `now`    —— 注入时钟出口（与全进程同一份；缺省＝真实时钟，不新造第二套）
 * @returns {() => object} `snapshot()`：无参、纯读、同步；同一时刻两次调用结果可深比较
 */
function createStateSnapshot(options = {}) {
  const db = options.db || null;
  const ingest = options.ingest || null;
  const upload = options.upload || null;
  const nowFn = typeof options.now === 'function'
    ? options.now
    : platformClock.createClock({ mode: 'real' }).source();
  const config = options.config || boardConfig;
  /* 班次段：**两种入参形态都认**（向后兼容，且与 `server/index.js` 的 `start()` 同 ABI）：
     · 整个业务配置（含 `shift` 段，`config.shift` 为对象或数组）—— 常规用法；
     · 或**直接给 `shift` 段本身**（对象含 `list`）—— `contract-check` 等既有调用方就是这么传的。
     为什么要把整个 `shift` 段交给班次真源（而不是只给 `list`）：`E128` 的准入开关
     `allowCrossMidnight` 是**段上的键**，只传数组会把它静默丢掉（＝闸失效）。 */
  const shiftSeg = Array.isArray(config.shift) ? { list: config.shift }
    : (config.shift && typeof config.shift === 'object' ? config.shift
      : (Array.isArray(config.list) ? config : segOf(config, 'shift')));
  const shiftRules = createShiftRules(shiftSeg);
  /** 最近一次 DR-17 读数（日/月/年求和 ＋ 当班增量 ＋ 状态位）—— 挂在返回的 `snapshot` 函数对象上
   *  供 `GET /health` 的 `runAccum` 只读引用；**不进** `snapshot()` 的返回体（那是 hello/`GET /state`
   *  的契约，本次不动）。初值 `null` ＝"还没做过一次快照"。 */
  let lastRunAccum = null;

  /** 当前工单行（最近更新的一条；无 ⇒ null） */
  function taskRow() {
    if (!db) return null;
    return db.prepare('SELECT * FROM task ORDER BY updated_at DESC, proc_order_no ASC LIMIT 1').get() || null;
  }

  /** 设备行（DR-01 口径是"整套系统 1 个编号"，故取最近更新的一条） */
  function deviceRow() {
    if (!db) return null;
    return db.prepare('SELECT equip_code, equip_name FROM device ORDER BY updated_at DESC LIMIT 1').get() || null;
  }

  /** 快照里的工单段（键名固定见文件头） */
  function taskOf(row) {
    if (!row) return null;
    const out = {};
    for (const [key, col] of TASK_FIELDS) out[key] = nullIfAbsent(row[col]);
    return out;
  }

  /** 快照里的链路段（刻意剔除 ageMs/reason：随读时刻变化，见文件头说明） */
  function linkOf() {
    if (!ingest || typeof ingest.linkState !== 'function') return null;
    const st = ingest.linkState();
    return {
      state: st.state,
      online: st.online,
      staleMs: st.staleMs,
      lastAcceptedAt: nullIfAbsent(st.lastAcceptedAt),
      lastCollectTime: nullIfAbsent(st.lastCollectTime),
      lastCollectMs: nullIfAbsent(st.lastCollectMs)
    };
  }

  /** 快照里的帧段（**最新 1 s 采样帧**，形状与 upper 报文同名；无 ⇒ null） */
  function frameOf() {
    if (!ingest || typeof ingest.lastSampledFrame !== 'function') return null;
    const raw = ingest.lastSampledFrame();
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const key of FRAME_FIELDS) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
    return out;
  }

  /** 快照里的统计段（**唯一核算处**＝`services/stats.computeShiftStats()`；本文件不重写任何算式）
   *
   *  **取数在 `statsForShift()`**（本模块的**唯一取数口**，与 DR-06 的 `shift_stat` 固化共用同一份 SQL）
   *  —— 计量单位、当班归属、计划数口径的逐条说明都在那个函数的 docblock 里（本处不复制，避免两处漂移）。
   *
   *  **DR-17 累计运行（ADR-0009 D4 落地，2026-10-02）**：本函数把三样东西装配给 `computeShiftStats()`：
   *   ① `accum`（"上次落库值"）＝ **对 `shift_stat` 求和**（读口 `repo/shiftStat.js` 的 `sumRunSec()`）：
   *      日/月/年三档分别按 `shift_date` 相等 / 同月 / 同年求和 ⇒ **跨零点与跨月、跨年归属由 DR-06 的
   *      `shift_date` 承载**（它是"班次开始那一天"，正是 DR-06 明写的归属规则）；
   *   ② `addRunSec`（本周期增量）＝ **从 `shift_stat` 读"上次累计"**（读口 `getShiftRow()` 取当班已固化
   *      的那一行）算出来：`max(0, 当班实时 runSec − 该班次已固化的 run_sec)` —— 已固化部分不重复
   *      计入，且新读数不会小于旧读数（单调）；库里没有该班次的行 ⇒ 已固化 0、增量＝当班实时 `runSec`；
   *   ③ 求和是**每次快照现算**（对库求和，不是"上次结果 + 增量"）⇒ 天然幂等：同一时刻连读两次同值；
   *      跨日/月/年时按周期过滤自动归零（FR-6.4/6.5/6.6 的"跨零点/跨月/跨年归零"）。
   *      故 `accum` 的 `at` 直接给 `now`（"这套求和就是截至此刻的读数"）—— **不让 `rollAccum` 再滚一次**
   *      （再滚一次会把"按周期已算好的和"当成上一天的累计、重复滚入月/年）。
   *      `accumulate.reset` 因此恒为 `{day:false, month:false, year:false}`：**归零靠周期过滤、不靠
   *      `rollAccum`**（口径只有一处：周期过滤）。
   *   ⚠ **`E83`（2026-10-04）之后本函数报的是"两套投影"**（负责人裁定的跨零点口径）：
   *   · **自然日投影**（`FR-6.4/6.5/6.6` 的真源）＝`sums.daySec/monthSec/yearSec`（按零点切段求和，
   *     `repo/shiftStat.js` 的 `segmentsOf()`）＋ **当班未固化增量的切段**（`addRunSecSplit`）；
   *   · **班次投影**（`DR-06`／`FR-4.16` 的口径，`E83` 之前读数逐字保留）＝`sums.shiftDaySec/…`
   *     与 `runSec` 整段；两者一并挂在 `snapshot.lastRunAccum` 上供对账（`/health.runAccum`）。
   *     `E132`（2026-10-04）：月/年两档**不是**"跨零点只可能跨日、两段同月同年"（那句曾写在
   *     `stats.js` 里，是假的）—— 月末/年末那一班会同时跨月/跨年 ⇒ 本文件传下去的切段带**两段各自的
   *     日历归属**（`day1Date`/`day2Date`），由 `accumulateRunTime()` 按段分派到各自的自然月/年
   *     （不属于 `now` 所在周期的段不进本周期档，它们归上一个周期；读口 `sumRunSec()` 的分段归集
   *     对**已固化**的行做同一件事）。
   *     现配置（0-8/8-16/16-24）无跨零点班次 ⇒ 两套投影**恒同值**（这是硬保证，不是巧合：
   *     见 `services/stats.js` 的 `splitRunSecondsByDay()` 与 `tests\._verify\e83-*.js` 的逐字比对）。
   *   ⚠ **为什么切段结果必须落库（而不是只放内存累加器）**：本函数是"**每次快照从 DB 现算**"
   *     （对 `shift_stat` 求和，不是"上次结果 + 增量"）—— 这条设计换来的是**幂等**（同一时刻连读两次
   *     同值，`DR-17`）与**重启后一致**（进程内没有任何"必须记住"的状态）。若把切段只放在内存累加器里，
   *     这两条会同时破：重启后/第二条读路径（`GET /health`、固化点、探针）拿到的日/月/年读数就会
   *     与 `GET /state` 不同 —— 而它们本该是同一个数。⇒ 切段值随 `run_sec` 一起落 `shift_stat`
   *     （`run_sec_day1`/`run_sec_day2`），"现算"才仍然成立。
   *   ⚠ **为什么无跨零点配置时必须逐字不变**：自然日投影是**新**口径，旧读数是在产读数
   *     （`/health.runAccum`、`GET /state` 的 `stats.accumulate`、`db-check`／`logic-check` 的既有期望值
   *     都建立在它上面）。现配置不是跨零点 ⇒ 两套投影**必须**同值；一旦不同，说明改动**改变了在产行为**，
   *     那是回归而不是新功能。故 `splitRunSecondsByDay()` 在不跨自然日时**直接返回整段**（不查半点、不做除法），
   *     `accumulateRunTime()` 的第四入参缺省时也走**与改动前逐字相同**的那一支。
   *   ⚠ 三档求和的读数与增量**一并**挂到 `snapshot.lastRunAccum`（本文件导出的函数对象上的属性），
   *      供 `GET /health` 的 `runAccum` 字段只读引用 —— 读方要能看见"`addRunSec` 到底从哪儿来"。 */
  function statsOf(now) {
    const shift = shiftRules.at(now);
    /* 周期键：取**注入时钟**给出的那一刻（D17；本文件不读系统时间） */
    const day = platformClock.fmtDate(now);
    const period = { day, month: day.slice(0, 7), year: day.slice(0, 4) };
    const sums = db ? shiftStatRepo.sumRunSec(db, period) : EMPTY_RUN_SUMS;
    const frozen = db ? shiftStatRepo.getShiftRow(db, shift.date, shift.name) : null;
    const frozenRunSec = frozen && Number.isFinite(frozen.run_sec) ? frozen.run_sec : 0;
    /* 第一次核算只为取当班实时 `runSec`（它是增量算式的一项）；`accum`/`addRunSec` 随后用**同一算式**
       补上 —— 取数 SQL 只有 `statsForShift()` 一份，不存在第二个口径。 */
    const base = statsForShift(db, shift, { config, now, addRunSec: 0, accum: null });
    const addRunSec = Math.max(0, base.stats.runSec - frozenRunSec);
    /* `E83` 的自然日投影（**当班未固化增量**的切段）：与 `addRunSec` **同源同形** ——
       把"实时读数 − 已固化读数"这条增量算式**按段各算一遍**，而不是把整段增量塞进某一天。
       · 不跨自然日（现配置）⇒ `runSecDay2 ≡ 0` ⇒ `split.day2 = 0`、`split.day1 = addRunSec`
         ⇒ 下面 `accumulateRunTime()` 拿到 `{day1: add, day2: 0}`，与改动前逐字同值；
       · 跨零点且有**部分固化**时，两段各自减自己的已固化值（互不代偿）——
         已固化段的绝对值更大，故 `max(0, …)` 只会夹掉"库内比实时还大"这种不可能的分支。 */
    const frozenDay = shiftStatRepo.segmentsOf({
      fromDate: shift.date,
      runSec: frozenRunSec,
      runSecDay1: frozen ? frozen.run_sec_day1 : null,
      runSecDay2: frozen ? frozen.run_sec_day2 : null
    });
    const day1Frozen = frozenDay.reduce((s, x) => (x.day === shift.date ? s + x.sec : s), 0);
    const day2Frozen = frozenDay.reduce((s, x) => (x.day !== shift.date ? s + x.sec : s), 0);
    /* ⚠ 用展开保留切段结果自带的 `crossing` 与两段的**日历归属**（`day1Date`/`day2Date`）——
       只取 day1/day2 会把"这一次增量是否跨零点"丢掉，`accumulateRunTime()` 于是走"整段算当日"
       那一支（实测：次日 00:30 的日档由 192 变成 959）。 */
    const split = Object.assign({}, base.stats.runSecSplit, {
      day1: Math.max(0, base.stats.runSecDay1 - day1Frozen),
      day2: Math.max(0, base.stats.runSecDay2 - day2Frozen)
    });
    const accumPrev = {
      daySec: sums.daySec, monthSec: sums.monthSec, yearSec: sums.yearSec, at: now,
      /* `E83` 的第二套投影（班次投影）**不进** accum 的算式，只作为对账读数随读数一起报出去 */
      shiftDaySec: sums.shiftDaySec, shiftMonthSec: sums.shiftMonthSec, shiftYearSec: sums.shiftYearSec
    };
    /* 算式仍只此一处：`services/stats.js` 导出的 `accumulateRunTime()`（`computeShiftStats()` 内部用的
       就是它）—— 这里显式再调一次，是为了不必为"读一个 runSec"把整套取数跑第二遍。
       第 4 个入参＝`E83` 的自然日切段、第 5 个＝两段的**日历归属**（day1 归 `shift.date`、
       day2 归次日）：缺省时行为与改动前逐字相同；见 `splitRunSecondsByDay()`／`accumulateRunTime()`。 */
    base.stats.accumulate = statsSvc.accumulateRunTime(accumPrev, addRunSec, now, split, {
      shiftStartDate: shift.date
    });
    lastRunAccum = {
      at: platformClock.fmt(now),
      source: { sum: 'shift_stat.sumRunSec', current: 'shift_stat.getShiftRow' },
      period,
      daySec: base.stats.accumulate.daySec,
      monthSec: base.stats.accumulate.monthSec,
      yearSec: base.stats.accumulate.yearSec,
      /* `E83`：日/月/年三档的**自然日投影**与**班次投影**并列报出（读方按需取；对账靠两者之差） */
      naturalDay: {
        daySec: base.stats.accumulate.daySec,
        monthSec: base.stats.accumulate.monthSec,
        yearSec: base.stats.accumulate.yearSec
      },
      shiftProjection: {
        daySec: sums.shiftDaySec === undefined ? null : sums.shiftDaySec,
        monthSec: sums.shiftMonthSec === undefined ? null : sums.shiftMonthSec,
        yearSec: sums.shiftYearSec === undefined ? null : sums.shiftYearSec
      },
      undetermined: sums.undetermined,
      frozenShifts: sums.rows,
      currentShift: {
        date: shift.date, name: shift.name, frozenRunSec,
        frozenDay1: day1Frozen, frozenDay2: day2Frozen,
        liveDay1: base.stats.runSecDay1, liveDay2: base.stats.runSecDay2,
        crossing: Number(shift.end) <= Number(shift.start)
      },
      addRunSec,
      addRunSecSplit: split,
      liveRunSec: base.stats.runSec
    };
    return base.stats;
  }

  /** 快照里的标准段（`services/standard` 同源：生效版本 + 偏差显示 + 绝对值上下限） */
  function standardOf(task, at) {
    if (!db || !task) return null;
    const productCode = task.productCode === undefined || task.productCode === null ? '' : String(task.productCode);
    if (!productCode) return null;
    const processCode = task.processNo === undefined || task.processNo === null ? '' : String(task.processNo);
    const row = standardSvc.getEffectiveStandard(db, { productCode, processCode, at });
    if (!row) return null;
    const display = standardSvc.toDisplayStandard(row);
    return {
      productCode: row.productCode === undefined ? productCode : row.productCode,
      processCode: row.processCode === undefined ? processCode : row.processCode,
      versionNo: nullIfAbsent(display.versionNo),
      effectiveFrom: nullIfAbsent(display.effectiveFrom),
      depth: display.depth,
      speed: display.speed,
      limits: standardSvc.absoluteLimits(row)
    };
  }

  /** 快照里的上报段（**与 W4 的 `GET /upload/status` 同一真源**：`uploadReporter.status()` 的子集） */
  function uploadOf() {
    if (!upload || typeof upload.status !== 'function') return null;
    const s = upload.status();
    return {
      configured: s.configured,
      baseUrl: s.baseUrl,
      responseStyle: s.responseStyle,
      pendingCount: s.pendingCount,
      pendingOnly: s.pendingOnly,
      failedAfterRetry: s.failedAfterRetry,
      total: s.total,
      capacity: s.capacity,
      warnThreshold: s.warnThreshold,
      oldestAt: nullIfAbsent(s.oldestAt),
      alert: s.alert,
      autoRetry: false
    };
  }

  /** 快照里的公告段（`DR-10` / `FR-7.12`）：**前端 `state.notices` 同形**，读口只有
   *  `repo/notice.js` 的 `listForBoard()` 一份（`POST /notice` 的响应复用它，禁两套投影）。
   *  没有库 ⇒ 空态 `{notices:[],tips:[],todo:[]}`（**不编造**公告；前端据此走既有空态 UI-11）。 */
  function noticesOf() {
    if (!db) return { notices: [], tips: [], todo: [] };
    return noticeRepo.listForBoard(db);
  }

  /**
   * 组装整机快照（纯读、同步）。
   * @returns {object} 见文件头的 snapshot schema 表
   *   ⚠ 本函数同时把**最近一次 DR-17 读数**挂到 `snapshot.lastRunAccum`（函数对象属性，**不在返回体里**）
   *     —— `GET /health` 的 `runAccum` 字段据此只读引用（null ＝还没做过快照）。
   */
  function snapshot() {
    const now = platformClock.toDate(nowFn());
    const task = taskOf(taskRow());
    const frame = frameOf();
    /* 标准取值时刻：优先用**最新采样帧的采集时刻**（"当时生效版本"，与 W4 上报组装同口径）；
       没有帧时退到注入时钟的当前时刻（DR-16 文本）。 */
    const at = frame && frame.collectTime ? String(frame.collectTime) : platformClock.fmt(now);
    const dev = deviceRow();
    const out = {
      link: linkOf(),
      task,
      device: dev ? { equipCode: dev.equip_code, equipName: dev.equip_name } : null,
      frame,
      stats: statsOf(now),
      standard: standardOf(task, at),
      upload: uploadOf(),
      notices: noticesOf()
    };
    /* `statsOf()` 里已刷新 `lastRunAccum`；这里把它同步到函数对象上（同一份对象，不复制）。 */
    snapshot.lastRunAccum = lastRunAccum;
    return out;
  }

  return snapshot;
}

module.exports = { createStateSnapshot, statsForShift, FRAME_FIELDS, TASK_FIELDS, EMPTY_RUN_SUMS };
