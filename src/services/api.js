/* ==========================================================================
   接口适配层（services/api.js）
   需求版本：V1.46（双源采集＋实时深度/速度降级＋`IF-D.1` 的 `IF-F` 文件通道子注〔不新增条款号〕＋30 min 参考〔非硬性〕；`C-116`；不增删条款，仍 259 / P0 188 / AC 12 / Q 7）｜V1.45（十一处口径登记 `C-115`，负责人 2026-10-12 同批裁定：IF-D.8 频率／DR-13 端点标识／DR-04 件序号／DR-05 固化／FR-5.11 真源／FR-2.6 按端点＋验收／IF-D.3 只读展示／procOrderNo 看板注入／equipCode 过渡期／uploadId 归属）｜前版（C-114 两处口径登记〔①`equipCode` 的「给定方＝MES 方」在需求侧写准 —— `FR-1.2` 的「数据来源」列与 `IF-D.12` 同口径对齐（书面依据＝附录 2 的「数据来源」列＝MES 工单 与 `IF-A.4`），**取值路径与优先级一字未改**；②当班统计的「已完成」以 `result` 表为准 —— **单一真源、与 `FR-5.11` 的「已完成件数」同源**，见 `FR-4.4` 的真源声明〕；**不改任何算式、不增删条款**，仍 259 / P0 188 / AC 12 / Q 7；本文件只随需求版本戳同步，无行为改动；V1.43 / C-113 「13 张表」明确为业务表口径（`schema.sql` 实建 15 张 ＝ 13 业务表 ＋ `schema_meta` ＋ `auth_credential`；`db-check` 的 `REQUIRED_TABLES` ＝ 14），不增删条款，仍 259 / P0 188 / AC 12 / Q 7；V1.42 / C-112 三处口径补写〔DR-05 件序号与终态、FR-4.9 复检数〕；V1.41 / C-111 计量单位定义＋DR-04 件序号补登；V1.40 / C-109＋C-110 口径补写〔FR-5.11 起算点＋DR-05 写入口径〕；V1.39 / C-108 工单超时预警判据改「进度落后率超阈值率」且阈值率可配〔本文件只随需求版本戳同步，无行为改动〕；V1.38 / C-99～C-107 口径收口与接口修正；承 V1.37 / C-98「只统一 `testStatus` 码语义与运行阶段映射（改在 config/fieldMap.js
              与两处模拟上位机），本文件行为未变 —— 字典翻译机制与上报字段集均不动；
              V1.36 / C-96（U-5） 只精简测试标准区说明行文案；
              FR-3.18 显示 / FR-3.19 录入对象＝典型值 / 上偏差 / 下偏差，上下限由公式导出；
              `uclValue`/`lclValue` 报导出的上下限绝对值，见 IF-B.5）
   作用：把"外部报文"与"看板内部数据"互相转换，使接口规范/字段名变化时只需改配置。
   对应需求：
     - IF-D  上位机 → 看板：applyUpperPayload()、startUpper()
     - IF-B.8 看板 → MES：buildReportPayload()、uploadReport()（**附录 2 的 13 字段，不增不减**）
     - IF-B.5 看板 → MES：buildParamReportPayload()（**§1.2.5 关键运行参数**：深度/速度两条
               `dataList`，各带 `avgValue`/`maxValue`/`minValue`/`uclValue`/`lclValue`/`IsPass`；
               `uclValue`/`lclValue` 报**绝对值**＝典型值 ± 偏差，任一必要项缺失即该条走占位
               `65535` / `IsPass=null`）。该结构与附录 2 的 13 字段**相互独立**，不得混成一个字段集合
     - IF-B.9 失败缓存：uploadReport() 失败即写明失败原因并进补传队列，**不自动重试**（见下）
     - IF-B.9 人工重报：retryPending() —— **唯一**会主动重发补传报文的入口（供 UI-20 调用）；
                flushPending() 只刷新待补传状态，**不发送**（V1.31：不做任何自动重发）
   失败处置（2026-09-20 技术债 E10 起，**已定决策**）：
     上报失败时**只做两件事**：①**告警/暴露待补传条数**（getStatus().pendingCount）；②**把失败报文
     落库留存**。**不做自动重试**（无指数退避、无定时器）—— 重报由**人工触发**。
     落库的落地端是服务端：`server/services/uploadQueue.js`（写 `upload_log`，进程重启可读回）；
     本文件是浏览器侧的适配层（file:// 下无 require、无 SQLite），只保留**内存队列**供自检
     与状态展示，队列满时**拒绝入队并告警**（旧实现是 shift() 丢最旧，与 NFR-13 冲突）。
   依赖：config/board.config.js、config/fieldMap.js（需先加载）
   说明：本文件不操作 DOM，只做数据转换与网络收发（PROJECT_RULES 9.2）
   ========================================================================== */
window.Api = (function () {
  'use strict';

  const CFG = window.BoardConfig;
  const MAP = window.FieldMap;

  /* 上报失败待补传队列（浏览器侧内存态：仅用于自检与状态展示；
     持久化由服务端 server/services/uploadQueue.js 落 upload_log，见文件头 E10 说明） */
  let pending = [];
  /* 上报流水号状态：**按日重置**的当日序号（域 1～999999，永不产生 000000）。
     口径真源是 `platform/id.js` 的 `createUploadIdGenerator()`；本文件在浏览器 file:// 下
     无 require、不能直接共用该模块，故为**逐条对齐同一规则的等价实现** —— 改任一侧必须同步另一侧。
     R26-P3-3（2026-09-26 第三轮审查）：旧实现 `(uploadSeq + 1) % 1000` 第 1000 次起产 `…000`、
     且模块生命周期内从不按日重置，与 `platform/id.js` 的 `isUploadId`（判 001～999 合法）
     **两判相反**，使附录 2 的 uploadId 去重与回执核对（DR-13）语义漂移；已统一。
     `E31`（2026-10-07 负责人"按建议：放宽 uploadId 序号域"）：序号段 3 位 → **6 位**
     （域 1～999 → 1～999999），与 `platform/id.js` 的 `UPLOAD_SEQ_DIGITS`／`UPLOAD_SEQ_MAX`
     **逐字同值** —— 单日第 1000 次回绕（与当日第 1 次同号 ⇒ 可能被误判重复而丢数）就此消掉；
     取值依据（单日帧数上界 172800 ≤ 999999）见 `platform/id.js` 文件头。 */
  let uploadSeq = 0;
  /* 当前序号所属日期（yyyyMMdd）——与另一侧 fmtDate 同一"本地日期"边界 */
  let uploadSeqDate = null;
  /* 上位机数据源定时器 */
  let upperTimer = null;
  /* 最近一次成功收到上位机数据的时刻 */
  let lastUpperAt = 0;

  /**
   * 补传队列已满：**拒绝入队**，绝不静默丢弃已缓存报文（NFR-13 / 技术债 E10）。
   * 旧实现在超过 5000 条时 `shift()` 丢掉最旧一条，属"悄悄丢数据"，已废止。
   */
  function QueueFullError(limit, size) {
    const err = new Error(
      '上报补传队列已满（' + size + '/' + limit + '）：拒绝入队以避免丢弃已缓存报文（NFR-13），请人工处理待补传清单');
    err.name = 'QueueFullError';
    err.code = 'UPLOAD_QUEUE_FULL';
    err.limit = limit;
    err.size = size;
    return err;
  }

  /** 队列容量上限（缺省 5000，与旧实现同量级；由 CFG.mes.queueCap 配置，见 board.config.js） */
  function queueCap() {
    return CFG.mes.queueCap === undefined ? 5000 : CFG.mes.queueCap;
  }

  /**
   * 队列**告警阈值**（待补传条数 ≥ 该值即告警）。
   * 真源＝`board.config.js` 的 `CFG.mes.queueWarnThreshold`（缺省值与真源同值 1，改一处必须同步另一处）；
   * 服务端 `server/services/uploadQueue.js` 的 `DEFAULT_WARN_THRESHOLD` 读同一真源（R26-P3-4）。
   * ⚠ **不得**再由容量按比例推导（旧实现取容量 queueCap 的 90% 当告警线：容量 5000 时要积压 4500 条才亮，
   * 与服务端"积压 1 条即 warn"两判相反）。
   */
  function queueWarnThreshold() {
    return CFG.mes.queueWarnThreshold === undefined ? 1 : CFG.mes.queueWarnThreshold;
  }

  /* ---------------- 通用小工具 ---------------- */

  /** 按点号路径取深层属性，如 getPath(state,'task.real.depth') */
  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  /** 按点号路径写深层属性，中间层不存在时自动创建 */
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (cur[keys[i]] == null) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
  }

  /** 按小数位取整（digits 未定义时原样返回） */
  function round(value, digits) {
    if (typeof value !== 'number' || typeof digits !== 'number') return value;
    const p = Math.pow(10, digits);
    return Math.round(value * p) / p;
  }

  /** 补零（本地实现，避免依赖 utils/format.js 的加载顺序） */
  function pad(n) { return String(n).padStart(2, '0'); }

  /** 日期键（yyyyMMdd，本地日期）——与 platform/id.js 的 fmtDate 同一跨日边界 */
  function dayKey(t) {
    return t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate());
  }

  /**
   * 生成上传流水号：UP + yyyyMMddHHmmss + 6 位当日序号
   *
   * **与 `platform/id.js` 的 `createUploadIdGenerator().next()` 同步的口径（R26-P3-3 ＋ E31）**：
   *   ①**按日重置** —— 日期前缀变化即序号归零（改口径前本处从不重置）；
   *   ②**序号域 1～999999** —— `(seq % 999999) + 1`，**永不产生 `000000`**（改口径前
   *      `% 1000` 会产 `…000`；`E31` 之前是 `% 999` ⇒ 当日第 1000 次即回绕成 `001`）；
   *   ③格式同 `UP` + 14 位时间 + 6 位序号（共 **22** 字符），故 `platform/id.js` 的
   *      `isUploadId()` 判本处产物必合法 —— 两侧对同一输入序列产出**逐字节相同**的 id
   *      （`tests/platform-check.js` 有跨界对账断言；日志与回执核对（DR-13）依赖这一点）。
   */
  function nextUploadId(d) {
    const t = d || new Date();
    const day = dayKey(t);
    if (uploadSeqDate !== day) { uploadSeqDate = day; uploadSeq = 0; }
    /* 序号域 1～999999（`E31`）：(seq % 999999) + 1 使 +1 后落在 000001，回绕后仍不产生
       000000；回绕点由当日第 1000 次推到第 1000000 次（500 ms 节拍下单日 172800 帧上界，不可达） */
    uploadSeq = (uploadSeq % 999999) + 1;
    return 'UP' + day +
           pad(t.getHours()) + pad(t.getMinutes()) + pad(t.getSeconds()) +
           String(uploadSeq).padStart(6, '0');
  }

  /* ---------------- IF-D：上位机报文 → 看板内部 ---------------- */

  /**
   * 把一帧上位机报文并入看板状态
   * @param {object} state   看板状态（MockData.state）
   * @param {object} payload 上位机报文（字段见 fieldMap.upperToBoard 的 key）
   * @param {Date}   now     采集时刻，用于新鲜度判断
   * @returns {{applied:number, missing:string[]}} 应用字段数与缺失字段
   */
  function applyUpperPayload(state, payload, now) {
    if (!state || !payload) return { applied: 0, missing: [] };
    let applied = 0;
    const missing = [];

    Object.keys(MAP.upperToBoard).forEach(boardPath => {
      const spec = MAP.upperToBoard[boardPath];
      let key, value;

      if (typeof spec === 'string') {
        key = spec;
      } else {
        key = spec.key;
      }

      if (!(key in payload) || payload[key] === null || payload[key] === undefined) {
        missing.push(key);
        return;   // 字段缺失：保留看板原值，不清零（避免大屏闪 0）
      }

      value = payload[key];

      /* 字典翻译（如 testStatus → 运行模式） */
      if (spec && spec.map && typeof spec.map === 'object') {
        value = spec.map[value] !== undefined ? spec.map[value] : value;
      }
      /* 数值取整 */
      if (spec && typeof spec.digits === 'number') {
        value = round(Number(value), spec.digits);
        if (Number.isNaN(value)) { missing.push(key); return; }
      }

      setPath(state, boardPath, value);
      applied++;
    });

    /* 记录原始状态码，供上报 MES 使用（附录 2 的 testStatus 是整数） */
    if (typeof payload.testStatus === 'number') {
      state.task.testStatus = payload.testStatus;
    } else if (state.status && state.status.mode) {
      state.task.testStatus = MAP.modeToTestStatus[state.status.mode];
    }

    /* 标记录入时刻，供界面判断"数据是否冻结" */
    state.lastUpperAt = now ? now.getTime() : Date.now();
    lastUpperAt = state.lastUpperAt;
    state.upperValid = true;
    return { applied, missing };
  }

  /**
   * 校验一帧报文是否可用（App 2 要求设备编号必填）
   * @returns {{ok:boolean, reason:string}}
   */
  function validatePayload(payload) {
    if (!payload) return { ok: false, reason: '报文为空' };
    if (!payload.equipCode) return { ok: false, reason: '缺少必填字段 equipCode' };
    if (CFG.device.equipCode && payload.equipCode !== CFG.device.equipCode) {
      return { ok: false, reason: '设备编号不匹配：' + payload.equipCode };
    }
    return { ok: true, reason: '' };
  }

  /**
   * 判断上位机数据是否已过期（用于界面降级提示）
   *
   * **服务端模式（`?source=server`）**：新鲜度的真源是**服务端链路结论**（`ingest.linkState()`），
   * 前端不重算 —— 服务端已按 `upper.staleMs` 判定并在 `snapshot.link` / `link` 事件里给出
   * `online`；本函数在服务端模式下直接返回服务端的结论（不再看本地 `lastUpperAt`，
   * 因为本地只在收到事件时才更新它，两次事件之间会被误判成"冻结"，见 W5-② 判据③）。
   */
  function isUpperStale(now, state) {
    if (CFG.dataSource === 'server') {
      const st = state || ((window.MockData && window.MockData.state) ? window.MockData.state : null);
      const sl = st && st.serverLink;
      return !(sl && sl.online === true);
    }
    if (!lastUpperAt) return true;
    return ((now ? now.getTime() : Date.now()) - lastUpperAt) > CFG.upper.staleMs;
  }

  /**
   * 把"数据冻结 / 取数失败"同步到界面判据 state.device.link（IF-D.9 / FR-2.6）
   *
   * 两条模式各自成立、互不干扰：
   *   · `upper` 模式：`device.link` 由**上位机数据新鲜度**驱动
   *     （`isUpperStale` / `upperValid`）；
   *   · `server` 模式（W5-② / ADR-0008 D3）：`device.link` 由**服务端链路结论**驱动
   *     （`state.serverLink.online`；服务端 `ingest.linkState()` 是唯一真源），
   *     这样"SSE 断开 ⇒ 界面 ≤5 s 进入数据冻结/离线提示"这条判据才有单一依据；
   *   · `mock` 模式：`device.link` 由演示键 D 控制，**不能被覆盖**。
   * @returns {string} 同步后的链路状态
   */
  function syncLinkState(state, now) {
    if (!state) return 'online';
    if (CFG.dataSource === 'server') {
      const sl = state.serverLink;
      state.device.link = (sl && sl.online === true) ? 'online' : 'offline';
      return state.device.link;
    }
    if (CFG.dataSource !== 'upper') return state.device.link;
    state.device.link = (isUpperStale(now, state) || state.upperValid === false) ? 'offline' : 'online';
    return state.device.link;
  }

  /* ---------------- 看板服务端（W5-② / ADR-0008 D1/D2/D4） ----------------
     服务端契约（W5-① 已交付，见 `server/http/router.js`）：
       `GET  /state`          首帧全量快照 `{ok, at, seq, snapshot}`
       `GET  /events`         SSE 增量（`retry: 3000`；业务事件种类 frame/link/task/standard/upload/warning）
       `GET  /upload/pending` 待补传清单（UI-20 主数据源）
       `GET  /upload/status`  上报状态（配置 / 队列 / 告警阈值 / `autoRetry:false`）
       `POST /upload/retry`   人工一键重报（**唯一**会再次发送待补传报文的入口）
     口径（ADR-0008 D3/D4）：
       · 服务端模式下前端**不造数、不直接向 MES 上报**（上报由服务端 `uploadReporter.js` 独占）；
       · 所有失败路径只 `console.warn` + 优雅回退，**绝不 `console.error`、绝不抛未捕获异常**；
       · 未接入的模块一律**显式无数据**（`null` / 空列表），不用演示值顶替。 */

  /**
   * 服务端基地址（**基地址真源＝`services/boardSource.js` 的 `resolveBaseUrl()`，此处不得再自行推导**）。
   *
   * ⚠ **F18（2026-09-28 真机正向取证的真缺陷）**：改前本函数**自己读** `CFG.board.baseUrl`
   * （配置为空即返回空串），而 `boardSource.resolveBaseUrl()` 会按页面来源再判一次
   * （`location.protocol === 'file:'` ⇒ 回退 `http://127.0.0.1:8787`）。
   * 于是"基地址"这一份口径被**劈成两份**：`EventSource`（走 `boardSource`）拿对了 base，
   * 而本文件所有 REST 取数（`fetchSnapshot`/`fetchPending`/`fetchUploadStatus`/`retryPendingServer`）
   * 走的是**空串** ⇒ 在 `file://` 下发出 `file:///D:/state` 这种相对请求，被浏览器判 `ERR_FILE_NOT_FOUND`
   * ⇒ 首帧快照必失败 ⇒ 优雅回退演示源 ⇒ **ADR-0008 D2 专为"双击 index.html"开的
   * CORS `Origin: null` 白名单从来没被用上**（那条路径整条是断的）。
   *
   * 现口径（**单源**）：
   *   · `window.BoardSource.resolveBaseUrl` 存在 ⇒ **一律用它的返回值**（含同源情形的空串）；
   *   · 仅当 `BoardSource` **未加载**（旧夹具 / 裁剪环境）才退回读 `CFG.board.baseUrl`
   *     —— 并做能力检测，**不得**因 `BoardSource` 不存在而抛 `ReferenceError`。
   * @returns {string} 末尾无 `/` 的基地址（可为空串＝同源相对路径）
   */
  function serverBase() {
    const bs = window.BoardSource;
    if (bs && typeof bs.resolveBaseUrl === 'function') {
      try {
        const b = bs.resolveBaseUrl();
        if (typeof b === 'string') return b.replace(/\/+$/, '');
      } catch (err) {
        /* 真源自己坏了也不能让整条取数链崩：只 warn，退回配置读法（不静默吞掉原因） */
        console.warn('[Api] BoardSource.resolveBaseUrl() 抛错，暂按 CFG.board.baseUrl 解析：' +
          ((err && err.message) || String(err)));
      }
    }
    const b = (CFG.board && typeof CFG.board.baseUrl === 'string') ? CFG.board.baseUrl : '';
    return b.replace(/\/+$/, '');
  }

  /** 服务端单次 HTTP 超时（真源＝`board.timeoutMs`） */
  function serverTimeout() {
    return (CFG.board && CFG.board.timeoutMs) || 3000;
  }

  /** 从响应体取**机器可读**错误码（`routes/auth.js` 与 `routes/notice.js` 同形：`body.error` 与 `body.err.code`） */
  function errorCodeOf(body) {
    if (!body || typeof body !== 'object') return '';
    const v = (body.err && body.err.code) || body.error;
    return v === undefined || v === null ? '' : String(v);
  }

  /**
   * **统一 401 处理**（ADR-0007 D5 的第三件事："前端只做提交口令 / 保存令牌 / 统一处理 401"）。
   *
   * 为什么挂在 `httpJson()` 上：它是**全仓唯一的服务端 HTTP 出口**（本文件头与 T-20261002-08 均已
   * 固化该口径）——把"401 ⇒ 清会话 + 记一条可见说明"收在这一处，就不会出现"某些调用方记得处理、
   * 某些忘了"的分裂；也**不必**再起第二套 fetch。
   *
   * ⚠ 判定"是不是会话失效"的权力**不在本函数**：本函数只把 `{path, status, errorCode, reason}`
   * 原样交给 `window.BoardSession.noteUnauthorized()`，由它按机器可读码区分
   * `unauthorized`（会话失效）与 `bad_credentials`/`bad_init_code`（与登录态无关的 401，见
   * `services/auth.js` 的 `isSessionLoss()`）。这样"哪种 401 算掉线"只有一份口径。
   *
   * 三条纪律：①出口未装配（裁剪环境 / 测试桩件）⇒ **静默跳过**，不抛、不刷控制台（一次 401 不该
   * 因为缺一个可选出口就变成异常）；②`BoardSession` 自己抛错 ⇒ 只 `warn` 一次并照常把响应返回给
   * 调用方（绝不吞掉本次业务结论）；③本函数**不改** `r` 的字段（既有调用方读到的形状逐字节不变）。
   */
  function noteUnauthorized(status, path, body) {
    if (status !== 401) return;
    const bs = window.BoardSession;
    if (!bs || typeof bs.noteUnauthorized !== 'function') return;
    try {
      bs.noteUnauthorized({
        path: path, status: status, errorCode: errorCodeOf(body),
        reason: (body && ((body.err && body.err.message) || body.reason)) || ''
      });
    } catch (err) {
      console.warn('[Api] 统一 401 处理抛错（已忽略，本次响应照常返回）：' +
        ((err && err.message) || String(err)));
    }
  }

  /**
   * 统一的 HTTP JSON 出口（**本文件所有服务端取数都必须走它**）。
   * 错误形状沿用 `sendReport()` 的既有字段（`{ok,error,failReason,responseCode,responseText}`），
   * 便于界面与自检用同一套判据读两种来源的失败。
   *
   * ⚠ **能力检测先行**：`tests/ui-check.js` 的 vm 沙箱没有 `fetch`/`AbortSignal`，
   *    缺失时**返回失败结论**（`ok:false`）而**不抛** —— 调用方据此走优雅回退。
   *
   * @param {string} path    以 `/` 开头的路径（如 `/state`）
   * @param {{method?:string, body?:object, headers?:object}} [options]
   *   `headers`（可选，**追加型**）：额外请求头。为什么需要它：`FR-7.12` 的公告写路由
   *   （`POST /notice`）要带 ADR-0007 的会话令牌 `Authorization: Bearer <token>`，
   *   而"全仓唯一的服务端 HTTP 出口"就是本函数 ⇒ 在这里开一个口子，**不另起第二套 fetch**。
   *   既有调用方不传该键 ⇒ 请求头与改动前逐字节相同（`Accept` ＋ 有体时的 `Content-Type`）。
   * @returns {Promise<{ok:boolean, status?:number, body?:any, url:string,
   *                    error?:string, failReason?:string, responseCode?:string, responseText?:string}>}
   */
  function httpJson(path, options) {
    const opt = options || {};
    const url = serverBase() + path;
    const method = String(opt.method || 'GET').toUpperCase();
    if (typeof fetch !== 'function') {
      return Promise.resolve({
        ok: false, url, error: '运行环境不支持 fetch',
        failReason: '运行环境不支持 fetch（服务端源不可用）', responseCode: '不支持', responseText: ''
      });
    }
    let signal;
    try {
      if (typeof AbortSignal !== 'undefined' && AbortSignal && typeof AbortSignal.timeout === 'function') {
        signal = AbortSignal.timeout(serverTimeout());
      }
    } catch (e) { signal = undefined; }   // 老环境：退化为无超时（仍受浏览器自身超时约束）

    const init = { method: method, headers: { Accept: 'application/json' } };
    if (signal) init.signal = signal;
    if (opt.body !== undefined) {
      init.headers['Content-Type'] = 'application/json;charset=UTF-8';
      init.body = JSON.stringify(opt.body);
    }
    /* 额外请求头（如公告写入的 `Authorization`）：只**追加**，不覆盖上面两条既有头 */
    if (opt.headers && typeof opt.headers === 'object') {
      Object.keys(opt.headers).forEach(k => {
        if (opt.headers[k] !== undefined && opt.headers[k] !== null && opt.headers[k] !== '') {
          init.headers[k] = String(opt.headers[k]);
        }
      });
    }

    return fetch(url, init).then(res => res.text().then(text => {
      let parsed = null;
      let parseError = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (e) { parseError = e; }
      if (!res.ok) {
        /* HTTP 非 2xx：如实回报状态码与服务端错误体（**不 console.error**） */
        const reason = (parsed && parsed.err && parsed.err.message) || parseError && parseError.message || ('HTTP ' + res.status);
        /* ADR-0007 D5：唯一的 HTTP 出口在这里收敛"会话类 401"（清令牌 + 记一条可见说明） */
        noteUnauthorized(res.status, path, parsed);
        return {
          ok: false, status: res.status, body: parsed, url, responseText: text,
          failReason: String(reason), responseCode: String(res.status),
          error: '服务端返回 HTTP ' + res.status + '：' + String(reason)
        };
      }
      if (parseError) {
        return {
          ok: false, status: res.status, body: null, url, responseText: text,
          failReason: '响应不是合法 JSON：' + parseError.message, responseCode: String(res.status),
          error: '响应不是合法 JSON'
        };
      }
      return { ok: true, status: res.status, body: parsed, url, responseText: text };
    })).catch(err => {
      const msg = (err && err.message) || String(err);
      return {
        ok: false, url, error: msg, failReason: msg,
        responseCode: '网络错误', responseText: ''
      };
    });
  }

  /**
   * 取健康检查**并带回响应 `Date` 头**（W7-B 自检「NTP 时间同步」行要拿它比对本地时钟）。
   *
   * ⚠ 为什么**不**改 `httpJson()`／`fetchHealth()` 的返回形状：它们已被既有调用方与门禁使用，
   * 本包只许**新增**。故这里走一条**本函数专用**的 `fetch`（与 `httpJson` 同一套能力检测、
   * 同一套超时、同一套错误形状思想），把 `Date` 头一并回传。
   * @returns {Promise<{ok:boolean, health?:object, dateHeader?:string, error?:string,
   *                    failReason?:string, responseCode?:string, url:string}>}
   */
  function fetchHealthWithDate() {
    const url = serverBase() + '/health';
    if (typeof fetch !== 'function') {
      return Promise.resolve({
        ok: false, url, error: '运行环境不支持 fetch',
        failReason: '运行环境不支持 fetch（服务端自检不可用）', responseCode: '不支持'
      });
    }
    let signal;
    try {
      if (typeof AbortSignal !== 'undefined' && AbortSignal && typeof AbortSignal.timeout === 'function') {
        signal = AbortSignal.timeout(serverTimeout());
      }
    } catch (e) { signal = undefined; }
    const init = { method: 'GET', headers: { Accept: 'application/json' } };
    if (signal) init.signal = signal;
    return fetch(url, init).then(res => {
      const dateHeader = (res.headers && typeof res.headers.get === 'function') ? res.headers.get('date') : null;
      return res.text().then(text => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
        if (!res.ok) {
          const why = (parsed && parsed.err && parsed.err.message) || ('HTTP ' + res.status);
          return { ok: false, url, dateHeader: dateHeader || undefined, responseText: text,
            error: '服务端返回 HTTP ' + res.status + '：' + String(why),
            failReason: String(why), responseCode: String(res.status) };
        }
        if (!parsed) {
          return { ok: false, url, dateHeader: dateHeader || undefined, responseText: text,
            error: '响应不是合法 JSON', failReason: '响应不是合法 JSON', responseCode: String(res.status) };
        }
        return { ok: true, url, health: parsed, dateHeader: dateHeader || undefined };
      });
    }).catch(err => {
      const msg = (err && err.message) || String(err);
      return { ok: false, url, error: msg, failReason: msg, responseCode: '网络错误' };
    });
  }

  /**
   * 取首帧全量快照（`GET /state`）。
   * **成功判据是"`ok===true` 且 `snapshot` 是对象"** —— 只判 HTTP 200 会把
   * `{ok:false, err:{…}}` 这种"200 包着失败"误当成功（服务端 503 未挂载 SSE 时即如此）。
   * @returns {Promise<{ok:boolean, snapshot?:object, at?:string, seq?:number, error?:string, url:string}>}
   */
  function fetchSnapshot() {
    const path = (CFG.board && CFG.board.statePath) || '/state';
    return httpJson(path).then(r => {
      if (!r.ok) return { ok: false, url: r.url, error: r.error, failReason: r.failReason, responseCode: r.responseCode };
      const body = r.body;
      if (!body || body.ok !== true || !body.snapshot || typeof body.snapshot !== 'object') {
        const why = (body && body.err && body.err.message) || '响应体缺少 snapshot（ok!==true）';
        return { ok: false, url: r.url, error: String(why), failReason: String(why), responseCode: String(r.status) };
      }
      return { ok: true, url: r.url, snapshot: body.snapshot, at: body.at, seq: body.seq };
    });
  }

  /**
   * 取待补传清单（`GET /upload/pending`）—— UI-20 的主数据源。
   * @returns {Promise<{ok:boolean, count?:number, items?:Array<object>, capacity?:number,
   *                    warnThreshold?:number, alert?:object, error?:string, url:string}>}
   */
  function fetchPending() {
    return httpJson('/upload/pending').then(r => {
      if (!r.ok) return { ok: false, url: r.url, error: r.error, failReason: r.failReason, responseCode: r.responseCode };
      const b = r.body || {};
      return {
        ok: true, url: r.url,
        count: typeof b.count === 'number' ? b.count : (Array.isArray(b.items) ? b.items.length : 0),
        items: Array.isArray(b.items) ? b.items : [],
        pendingOnly: b.pendingOnly === undefined ? null : b.pendingOnly,
        failedAfterRetry: b.failedAfterRetry === undefined ? null : b.failedAfterRetry,
        capacity: b.capacity === undefined ? null : b.capacity,
        warnThreshold: b.warnThreshold === undefined ? null : b.warnThreshold,
        overflow: b.overflow === true,
        alert: b.alert === undefined ? null : b.alert
      };
    });
  }

  /**
   * 取健康检查（`GET /health`）—— W7-B（FR-8.5 / NFR-26「系统状态自检」的真实探测数据源）。
   * 响应口径（服务端 `server/index.js` 的 `healthPayload()`）：
   * `{ok, uptimeSec, dbWritable, version, listen, pid, env, dataRoot, dbFile, streams, lastError, ifd?}`
   * ⚠ 服务端**没有**磁盘余量与 NTP 偏差字段（演示期的两项是硬编码文案），故自检侧对这两项
   * 走"尽力探测 + 明确未接入"口径，**不得**编造数值（见 `services/selfCheckProbe.js`）。
   * @returns {Promise<{ok:boolean, health?:object, error?:string, url:string}>}
   */
  function fetchHealth() {
    return httpJson('/health').then(r => {
      if (!r.ok) return { ok: false, url: r.url, error: r.error, failReason: r.failReason, responseCode: r.responseCode };
      return { ok: true, url: r.url, health: r.body || {} };
    });
  }

  /**
   * 取 IF-D（上位机）链路状态（`GET /ifd/status`）—— 自检「PC 上位机连接」行的真源。
   * 响应口径（`server/http/routes/ifD.js` 的 `statusBody`）＝ `ingest.status()`：
   * `{ok, mount:'ifD', sources, counts, lastReject, lastStoredKey, lastStoredSecond, link:{state,online,staleMs,ageMs,…}}`
   * 其中 `link` 与 `GET /state` 的 `snapshot.link` **同源**（都来自 `ingest.linkState()`）。
   * @returns {Promise<{ok:boolean, status?:object, error?:string, url:string}>}
   */
  function fetchIfdStatus() {
    return httpJson('/ifd/status').then(r => {
      if (!r.ok) return { ok: false, url: r.url, error: r.error, failReason: r.failReason, responseCode: r.responseCode };
      return { ok: true, url: r.url, status: r.body || {} };
    });
  }

  /**
   * 取 IF-D **按端点**链路状态（`GET /ifd/endpoints`，P1-1b）—— 设备状态页「联网状态」逐端点行的真源。
   * 响应口径（`server/http/routes/ifD.js` 的路由）：`{ok, mount:'ifD', staleMs, total, onlineCount,
   * offlineCount, allOffline, unknownFrames, endpoints:[{endpointId, online, lastAcceptedAt, ageMs, frames}]}`
   * 语义**只搬运、不重判**（ADR-0008 D3 / PROJECT_RULES 9.6）：`online` 是服务端按
   * `board.config.upper.staleMs` 算好的结论，前端**不拿 ageMs 再比一次阈值**；
   * `allOffline` **只表示"所有端点都掉线"**（单点掉线 ≠ 整套离线）—— 故这里原样保留，
   * 不派生任何"整套断连"措辞。
   * 成功判据＝`ok === true` **且** `endpoints` 是数组（只判 HTTP 200 会把"200 包着失败"误当成功）。
   * @returns {Promise<{ok:boolean, staleMs?:number|null, total?:number, onlineCount?:number,
   *                    offlineCount?:number, allOffline?:boolean, unknownFrames?:number,
   *                    endpoints?:Array<object>, url:string, error?:string, failReason?:string,
   *                    responseCode?:string}>}
   */
  function fetchIfdEndpoints() {
    return httpJson('/ifd/endpoints').then(r => {
      if (!r.ok) return { ok: false, url: r.url, error: r.error, failReason: r.failReason, responseCode: r.responseCode };
      const b = r.body;
      if (!b || b.ok !== true || !Array.isArray(b.endpoints)) {
        const why = (b && b.err && b.err.message) || '响应体缺少 endpoints（ok!==true）';
        return { ok: false, url: r.url, error: String(why), failReason: String(why), responseCode: String(r.status) };
      }
      const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      return {
        ok: true, url: r.url,
        staleMs: num(b.staleMs),
        total: num(b.total),
        onlineCount: num(b.onlineCount),
        offlineCount: num(b.offlineCount),
        allOffline: b.allOffline === true,
        unknownFrames: num(b.unknownFrames),
        endpoints: b.endpoints.map(e => ({
          endpointId: e && e.endpointId !== undefined && e.endpointId !== null ? String(e.endpointId) : '',
          online: !!(e && e.online === true),
          lastAcceptedAt: e && e.lastAcceptedAt !== undefined ? e.lastAcceptedAt : null,
          ageMs: num(e && e.ageMs),
          frames: num(e && e.frames)
        }))
      };
    });
  }

  /**
   * 取 IF-A（接收 MES 派工/物料/工艺）状态（`GET /ifa/status`）—— 自检「看板主机网络」行的
   * 权威侧/鉴权信息真源。响应口径＝`server/services/dispatch.js` 的 `status()`：
   * `{ok, mount:'ifA', mounted, kinds, counts, last, auth:{enabled,degraded,warning,…}, authority:{…}}`
   * @returns {Promise<{ok:boolean, status?:object, error?:string, url:string}>}
   */
  function fetchIfaStatus() {
    return httpJson('/ifa/status').then(r => {
      if (!r.ok) return { ok: false, url: r.url, error: r.error, failReason: r.failReason, responseCode: r.responseCode };
      return { ok: true, url: r.url, status: r.body || {} };
    });
  }

  /**
   * 取上报状态（`GET /upload/status`）：配置 / 队列 / 告警阈值 / `autoRetry:false` 的显式声明。
   * @returns {Promise<{ok:boolean, status?:object, error?:string, url:string}>}
   */
  function fetchUploadStatus() {
    return httpJson('/upload/status').then(r => {
      if (!r.ok) return { ok: false, url: r.url, error: r.error, failReason: r.failReason, responseCode: r.responseCode };
      return { ok: true, url: r.url, status: r.body || {} };
    });
  }

  /**
   * **人工触发**服务端重报（`POST /upload/retry`）—— UI-20 唯一的重报出口。
   * 语义与 `retryPending()`（浏览器本地队列那一个）**不同**：本函数把重报交给服务端
   * `uploadReporter.retryPending()`（`upload_log` 单源、按 `created_at, id` 顺序、幂等），
   * 前端**不组装报文、不直接向 MES 上报**（ADR-0008 D3）。
   * **只在被调用时发一次请求**：无定时器、无指数退避、不自动重试（NFR-10 / NFR-13）。
   *
   * **E87（2026-10-05）—— 必须带会话令牌**：`POST /upload/retry` 与 `POST /notice` 同口径
   * （回环 ＋ 登录态，`ADR-0007` D3）：服务端缺令牌一律 **401 `unauthorized`**。
   * 令牌**只从唯一出口取** —— `services/auth.js` 的 `BoardSession.authHeaders()`（它把令牌装成
   * `{Authorization:'Bearer <token>'}`；未登录时返回 `{}`）。本文件**不自己拼 `Bearer`**：
   * 拼第二份必然与那一份漂移，而"请求头里到底带没带令牌"是安全口径，不能有两处判断。
   * 未登录时 `headers` 为 `{}` ⇒ 这一次请求与改动前的请求头**逐字节相同**，服务端如实 401、
   * 前端按 D5 的统一 401 处理当帧降级（**不假装已重报**）。
   * @param {{ids?:string[], limit?:number}} [options] 空体＝重报全部待补传；`limit:1`＝只补最旧 1 条
   * @returns {Promise<object>} 服务端响应体（含 `ok/sent/failed/remaining/skipped/reason`）或本机失败结论
   */
  function retryPendingServer(options) {
    const body = {};
    const opt = options || {};
    if (Array.isArray(opt.ids) && opt.ids.length) body.ids = opt.ids.slice();
    if (Number.isInteger(opt.limit) && opt.limit > 0) body.limit = opt.limit;
    const bs = window.BoardSession;
    const headers = (bs && typeof bs.authHeaders === 'function') ? bs.authHeaders() : {};
    return httpJson('/upload/retry', { method: 'POST', body: body, headers: headers }).then(r => {
      if (!r.ok) {
        return {
          ok: false, url: r.url, error: r.error, reason: r.failReason,
          failReason: r.failReason, responseCode: r.responseCode
        };
      }
      return Object.assign({ url: r.url }, r.body || {});
    });
  }

  /* ---------------- 设置页鉴权（ADR-0007 D1–D5；T-20261002-15 / 技术债 E86①） ----------------
     服务端契约（`server/http/routes/auth.js` 已落地，**本包不得改服务端**）：
       `POST /auth/init   {code, password}`              本机回环 + 一次性初始化码（D4）
       `POST /auth/login  {username?, password}`         `{ok,token,username,expiresAt}`（D3）
       `POST /auth/logout`（Bearer）                      令牌即刻失效
       `POST /auth/change {oldPassword, newPassword}`（Bearer）改密并**清该用户全部在途会话**（D5/D8④）
       `GET  /auth/status`                                 `{ok,initialized,locked,…}`（无秘密；D8⑦）
     HTTP 状态码口径（**唯一真源＝ADR-0007 D2/D4**，本文件**不重判**）：
       200 成功｜400 `bad_password`｜401 `bad_credentials` / `bad_init_code` / `unauthorized`
       ｜403 `not_loopback`｜409 `not_initialized` / `already_initialized`｜423 `locked`（带 `retryAfterSec`）
     本段的职责边界：**只做 HTTP 适配与归一化**（把 `httpJson` 的既有失败形状 + 服务端错误体
     整理成一份稳定形状），**不比对口令、不计数、不判定锁定**（那是浏览器不该做的事，D5）。
     调用方（`services/auth.js` 的 `window.BoardSession`）据此保存令牌 / 显示可操作提示。 */

  /**
   * 把 `httpJson()` 的响应整理成**鉴权结果的稳定形状**（调用方只读这一份，不再自己挖 `body` 的层级）。
   * @param {object} r `httpJson()` 的返回值
   * @returns {{ok:boolean, url:string, status:number|null, errorCode:string, reason:string, body:object|null}}
   *   成功时另带服务端给出的字段（`token`/`username`/`expiresAt`/`initialized`/`requireRelogin`/…）；
   *   失败时另带可操作字段（`retryAfterSec`/`lockedUntil`/`lockedUnknown`）。
   */
  function authResultOf(r) {
    const body = (r && r.body && typeof r.body === 'object') ? r.body : null;
    const out = {
      ok: !!(r && r.ok === true),
      url: (r && r.url) || '',
      status: (r && r.status === undefined) ? null : (r ? r.status : null),
      errorCode: errorCodeOf(body),
      reason: (body && ((body.reason) || (body.err && body.err.message))) ||
        (r && (r.failReason || r.error)) || '',
      body: body
    };
    const serverKeys = out.ok
      ? ['token', 'username', 'expiresAt', 'absoluteExpiresAt', 'initialized', 'isInitial',
        'requireRelogin', 'sessionsCleared', 'sessionsRemaining']
      : ['retryAfterSec', 'lockedUntil', 'lockedUnknown'];
    if (body) serverKeys.forEach(k => { if (body[k] !== undefined) out[k] = body[k]; });
    return out;
  }

  /**
   * 读服务端鉴权状态（`GET /auth/status`）—— **无需鉴权**、**不含任何秘密**（D8⑦）。
   * 用途：区分"未初始化（该走本机一次性初始化）"与"已初始化但没登录"，给出可操作提示。
   * @returns {Promise<object>} `{ok, initialized, locked, retryAfterSec, isInitial, sessions, …}`
   */
  function authStatus() {
    return httpJson('/auth/status').then(r => {
      if (!r.ok) return authResultOf(r);
      return Object.assign(authResultOf(r), r.body || {}, { ok: r.body && r.body.ok !== false });
    });
  }

  /**
   * 提交口令换取会话令牌（`POST /auth/login`）。
   * @param {string} password 口令（原样提交；前端**不做**哈希/比对，D5）
   * @param {string} [username] 缺省 `admin`（服务端同样缺省它）
   * @returns {Promise<object>} 成功 ⇒ `{ok:true, token, username, expiresAt, absoluteExpiresAt}`
   */
  function authLogin(password, username) {
    const body = { password: password === undefined || password === null ? '' : String(password) };
    if (username !== undefined && username !== null && username !== '') body.username = String(username);
    return httpJson('/auth/login', { method: 'POST', body: body }).then(authResultOf);
  }

  /**
   * 令牌即刻失效（`POST /auth/logout`，Bearer）。未携带/伪造令牌 ⇒ 服务端 401（本函数如实回报）。
   * @param {string} token 会话令牌
   */
  function authLogout(token) {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    return httpJson('/auth/logout', { method: 'POST', body: {}, headers: headers }).then(authResultOf);
  }

  /**
   * 改密（`POST /auth/change`，Bearer）：原口令 + 新口令。
   * 成功后服务端**清空该用户全部在途会话**（D8④）⇒ 调用方必须清本地会话并要求重新登录（D5）。
   * @param {string} oldPassword 原口令
   * @param {string} newPassword 新口令（4～64 位；口径由服务端判）
   * @param {string} token 会话令牌
   */
  function authChange(oldPassword, newPassword, token) {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    return httpJson('/auth/change', {
      method: 'POST',
      body: {
        oldPassword: oldPassword === undefined || oldPassword === null ? '' : String(oldPassword),
        newPassword: newPassword === undefined || newPassword === null ? '' : String(newPassword)
      },
      headers: headers
    }).then(authResultOf);
  }

  /**
   * 本机一次性初始化（`POST /auth/init {code, password}`）—— D4 的**唯一**初始化入口。
   * 回环判定与"码是否本次进程生成"都由服务端做；前端只是转发（并**只**在本机回环上才会成功）。
   * @param {string} code 服务端控制台打印的一次性初始化码
   * @param {string} password 要设置的口令
   */
  function authInit(code, password) {
    return httpJson('/auth/init', {
      method: 'POST',
      body: {
        code: code === undefined || code === null ? '' : String(code).trim(),
        password: password === undefined || password === null ? '' : String(password)
      }
    }).then(authResultOf);
  }

  /* ---------------- 数据源接入 ---------------- */
  /**
   * 启动数据源（**三个分支，三条互不干扰的路径**）。
   *
   * · `'mock'`  ⇒ 返回 `'none'`：由 `services/mockData.js` 的 `tick()` 自行驱动，适配层不介入
   *   （演示模式的行为与改前**一字不变**）；
   * · `'upper'` ⇒ 上位机报文驱动（内置模拟上位机 / 真实轮询两条子分支，与改前逐字相同）；
   * · `'server'` ⇒ **W5-② 新增**：服务端快照 + SSE 增量驱动。本分支**不造数**，
   *   只是"把服务端真源标记为已选中"——真正的取数与回退在 `services/boardSource.js`
   *   （`BoardSource.startServerSource()` 由 `src/main.js` 调用，保证"首帧快照到手才建流"）。
   *   为什么不在本函数里直接 `fetch`：`fetchSnapshot()` 是异步的，而本函数的返回值是
   *   `sourceKind`（同步判据，决定 `main.js` 是否跑 `M.tick()`）。让 `main.js` 先按 `'none'`
   *   停掉本地造数、再由 `boardSource` 拉快照，**任何时刻都不会出现"两处都在推进数据"**。
   *
   * @param {object}   state    看板状态
   * @param {Function} onFrame  每帧回调（state, applied, payload）
   * @returns {string} `'mock-upper'` / `'upper-http'` / `'none'`（mock 与 server 都返回 `'none'`）
   */
  function startUpper(state, onFrame) {
    stopUpper();
    const src = CFG.dataSource;

    if (src === 'upper' && window.MockUpperSource) {
      /* 联调前自测：用前端内置的"模拟上位机"产生符合契约的报文，走同一条适配链路。
         MockUpperSource.next() 的契约是"传上一帧的 inner、返回 {payload, inner}"，
         必须持有 inner 递推，否则第二帧起内部状态被写坏、数值全为 NaN（审查报告 P1-1①）。 */
      let inner = null;
      upperTimer = setInterval(() => {
        const frame = window.MockUpperSource.next(inner);
        inner = frame.inner;
        const payload = frame.payload;
        const v = validatePayload(payload);
        if (!v.ok) { console.warn('[Api] 报文校验未通过：' + v.reason); return; }
        const r = applyUpperPayload(state, payload, new Date());
        if (onFrame) onFrame(state, r.applied, payload);
      }, CFG.refreshMs);
      return 'mock-upper';
    }

    if (src === 'upper' && CFG.upper.url) {
      /* 真实模式：按 refreshMs 轮询上位机接口（如对方为推送模式，可改为 SSE/WebSocket） */
      upperTimer = setInterval(() => {
        fetch(CFG.upper.url, {
          method: 'GET',
          headers: CFG.upper.auth.type === 'bearer'
            ? { Authorization: 'Bearer ' + CFG.upper.auth.token }
            : {},
          signal: AbortSignal.timeout ? AbortSignal.timeout(CFG.upper.timeoutMs) : undefined
        })
          .then(res => res.json())
          .then(payload => {
            const v = validatePayload(payload);
            if (!v.ok) { console.warn('[Api] 报文校验未通过：' + v.reason); return; }
            const r = applyUpperPayload(state, payload, new Date());
            if (onFrame) onFrame(state, r.applied, payload);
          })
          .catch(err => {
            state.upperValid = false;
            console.warn('[Api] 上位机接口取数失败：' + err.message);
          });
      }, CFG.refreshMs);
      return 'upper-http';
    }

    /* `'server'`（W5-②）与 `'mock'` 都返回 `'none'`：
       · mock   —— 由 mockData 驱动；
       · server —— **不得**跑 `M.tick()`（ADR-0008 D3：前端只应用、不生成）；
         取数/回退由 `BoardSource.startServerSource()` 负责（见函数头说明）。 */
    return 'none';
  }

  function stopUpper() {
    if (upperTimer) { clearInterval(upperTimer); upperTimer = null; }
  }

  /* ---------------- IF-B：看板内部 → MES 上报 ---------------- */

  /**
   * 组装上报报文（附录 2 的 13 字段 ＋ N-7 的标准上下限与判定位）
   *
   * **V1.33 上下限口径（FR-3.18/FR-3.19，2026-09-22 负责人拍定）**：
   *   - `uclValue` / `lclValue` 报**绝对值**（上限＝典型值＋上偏差，下限＝典型值＋下偏差），
   *     与界面显示同值；**不是偏差本身**。派生规则写在 `fieldMap.reportTransform`（不在本文件写死）。
   *   - **任一必要项缺失 ⇒ 整条参数走占位**：`uclValue`/`lclValue` 取 `CFG.mes.reportPlaceholder`
   *     （默认 65535，澄清函 N-7 已发口径）、`IsPass` = `null`（表示"不做判定"），
   *     字段结构完整、不缺项 —— 与致 MES 方澄清函 N-7 §"标准值未到位期间的上报口径"一致。
   *   - `IsPass` 由本看板按标准上下限判定后上报，不需要 MES 判定（N-7）。
   * @param {object} state 看板状态
   * @param {Date}   now   采集时刻
   */
  function buildReportPayload(state, now) {
    const d = now || new Date();
    const out = {};
    Object.keys(MAP.boardToReport).forEach(field => {
      const src = MAP.boardToReport[field];
      if (src === '@uploadId') {
        out[field] = nextUploadId(d);
        return;
      }
      let v = getPath(state, src);
      if (v === undefined || v === null) {
        /* 缺值口径（W4 / ADR-0008 D3，2026-09-28 收口）：**一律 `null`**（"没有这个值"），
           **绝不用 `0` 顶替** —— `0` 是合法物理量（0 m 深度 / 0 m·s⁻¹ 速度 / 0 件），
           拿它当缺省会让 MES 侧把"本机没有数据"读成"测到了 0"，属语义失真
           （服务端 `uploadReporter.buildReport()` 已按 `null` 实现，前端切换真实源时须同口径）。
           两个**例外**（不是数值字段，且协议要求必有值，故按协议口径补齐而不是留 null）：
             · `collectTime` —— 报文时刻（`yyyy-MM-dd HH:mm:ss`，DR-16 格式真源）；
             · `testStatus`  —— 由运行模式反查附录 2 的状态码（`fieldMap.modeToTestStatus`），
                                反查不到时仍给 `null`（不伪造运行状态）。 */
        if (field === 'collectTime') {
          v = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
              `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        } else if (field === 'testStatus') {
          const code = MAP.modeToTestStatus[getPath(state, 'status.mode')];
          v = (typeof code === 'number') ? code : null;
        } else {
          v = null;
        }
      }
      out[field] = v;
    });
    return out;
  }

  /**
   * 组装 **§1.2.5 关键运行参数报文（IF-B.5 / `PARAM_INFO_RECV` / C-78）** —— 与附录 2 的
   * 13 字段**相互独立**：本结构以 `dataList` 承载检测参数，深度与速度各占**一条 `dataList`**
   * （`tagParam`＝`depth` / `speed`），每条带 `avgValue` / `maxValue` / `minValue` /
   * `uclValue` / `lclValue` / `IsPass`。
   *
   * V1.33 上下限口径（FR-3.18/FR-3.19，2026-09-22 负责人拍定 + 澄清函 N-7）：
   *   - `uclValue` / `lclValue` 报**绝对值**（上限＝典型值＋上偏差、下限＝典型值＋下偏差），
   *     与界面显示同值；**不是偏差本身**。派生规则在 `fieldMap.standardOf()`（单一真源）。
   *   - **任一必要项缺失 ⇒ 该条 `tagParam` 整条走占位**：`uclValue`/`lclValue` 取
   *     `CFG.mes.reportPlaceholder`（默认 65535，N-7 已发口径）、`IsPass` = `null`（不做判定），
   *     字段保留、结构不缺项；三类缺失组合（只设偏差未设典型值 / 只设上偏差 / 只设一项指标）
   *     都落到同一占位分支（`limits[kind]` 为 null）。
   *   - `IsPass` 由本看板按标准上下限判定后上报，不需要 MES 判定（N-7）。
   *   - 聚合口径：`avgValue`/`maxValue`/`minValue` 取**单次任务内的有效采样点**；逐点原始序列
   *     不外传、不落库（N-2）。前端 Demo 的采样缓冲是 `state.curveTick`（每设备秒推一个点）；
   *     服务端落库后改读库，取值口径不变。
   * @param {object} state 看板状态
   * @param {Date}   now   采集时刻
   * @returns {{workshopNo:string, procOrderNo:string, opCode:string, opName:string,
   *            equipCode:string, equipName:string, timestamp:string, dataList:Array<object>}}
   */
  function buildParamReportPayload(state, now) {
    const d = now || new Date();
    const task = (state && state.task) || {};
    const limits = standardLimits(state);
    const placeholder = (CFG.mes && CFG.mes.reportPlaceholder !== undefined)
      ? CFG.mes.reportPlaceholder : 65535;
    const stats = taskSampleStats(state);

    return {
      workshopNo: (state && state.workshop && state.workshop.no) || CFG.workshopNo || '19',
      procOrderNo: task.procOrderNo || '',
      opCode: task.processCode || CFG.processCode || '',
      opName: task.processName || CFG.processName || '',
      equipCode: getPath(state, 'device.code') || CFG.device.equipCode || '',
      equipName: getPath(state, 'device.name') || CFG.device.name || '',
      timestamp: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
                 `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      dataList: ['depth', 'speed'].map(kind => {
        const st = stats[kind] || {};
        /* 该条是否具备完整标准：典型值＋上偏差＋下偏差，缺一即**该条**走占位 */
        const lim = limits[kind] || null;
        return {
          tagParam: kind,
          avgValue: round(st.avg, 2),
          maxValue: round(st.max, 2),
          minValue: round(st.min, 2),
          uclValue: lim ? lim.upper : placeholder,
          lclValue: lim ? lim.lower : placeholder,
          /* 判定用**本条参数**的聚合值（标准齐备且有采样才判定；否则不做判定） */
          IsPass: (lim && st.hasData) ? isPassOne(kind, st.avg, lim) : null
        };
      })
    };
  }

  /**
   * 单参数是否落在标准上下限内（FR-3.19，V1.35 / C-90：**显示与录入对象＝典型值 / 上偏差 / 下偏差**；
   * **上下限为 `典型值 ± 偏差` 的导出值**，不可直接录入；**典型值不参与判定**，判定对象＝导出的上下限）。
   * 判据只有上下限。
   * @param {string} kind   'depth' | 'speed'
   * @param {number} value  待判定值（§1.2.5 用该参数的聚合值）
   * @param {{upper:number, lower:number}} lim 标准上下限绝对值（导出值）
   * @returns {boolean}
   */
  function isPassOne(kind, value, lim) {
    if (!lim || typeof value !== 'number' || !Number.isFinite(value)) return false;
    return value >= lim.lower && value <= lim.upper;
  }

  /**
   * 单次任务内的有效采样聚合（avg / max / min）与"是否有采样"标志。
   * 数据源：`state.curveTick`（当前任务逐秒缓冲）；无缓冲时退回"最近一次已完成任务"的
   * `state.curve`，保证报文结构完整（不出现 undefined）。
   * @returns {{depth:object, speed:object}} 每项 {avg:number|null, max:number|null, min:number|null, hasData:boolean}
   */
  function taskSampleStats(state) {
    const tick = (state && state.curveTick) || {};
    const curve = (state && state.curve) || {};
    const out = {};
    ['depth', 'speed'].forEach(kind => {
      const live = Array.isArray(tick[kind]) ? tick[kind].filter(isFiniteNum) : [];
      const done = (!live.length && curve[kind] && Array.isArray(curve[kind].values))
        ? curve[kind].values.filter(isFiniteNum) : [];
      const v = live.length ? live : done;
      out[kind] = v.length ? {
        avg: v.reduce((a, b) => a + b, 0) / v.length,
        max: Math.max.apply(null, v),
        min: Math.min.apply(null, v),
        hasData: true
      } : { avg: null, max: null, min: null, hasData: false };
    });
    return out;
  }

  /** 是否为有限数值（采样过滤用） */
  function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  /**
   * 取当前 (产品号＋工序号) 的**逐参数**标准上下限**绝对值**（FR-3.18 取值真源）。
   * 换算只有一份实现：`config/fieldMap.js` 的 `standardLimits()`（本函数只是空值防护），
   * 避免"界面一套、上报又一套"（规范 9.6 单一真源）。
   * 逐参数返回是 IF-B.5 的硬要求：**任一必要项缺失即"该条 `tagParam`"走占位**，
   * 缺深度那条不能连速度那条一起占位。
   * @returns {{depth:{upper:number,lower:number}|null, speed:{upper:number,lower:number}|null}}
   *          某项为 null = 该参数必要项（典型值/上偏差/下偏差）缺失 ⇒ 该条按占位上报
   */
  function standardLimits(state) {
    if (typeof MAP.standardLimits !== 'function') return { depth: null, speed: null };
    return MAP.standardLimits(state);
  }

  /**
   * 按标准上下限判定**当前实测值**是否合格（FR-3.19，V1.35 / C-90：**显示与录入对象＝典型值 / 上偏差 / 下偏差**；
   * **上下限为 `典型值 ± 偏差` 的导出值**，不可直接录入；**典型值不参与判定**，判定对象＝导出的上下限）。
   * 供界面自检复用；§1.2.5 报文里每条 `dataList` 的判定用单参数聚合值（见 isPassOne）。
   * @returns {boolean}
   */
  function isPassByStandard(state, limits) {
    const real = (state && state.task && state.task.real) || {};
    if (!limits) return false;
    return ['depth', 'speed'].every(kind => isPassOne(kind, real[kind], limits[kind]));
  }

  /** 生成接口 URL：/service/{serviceName}/{methodName} 模板替换 */
  function buildUrl(serviceName, methodName) {
    const base = (CFG.mes.baseUrl || '').replace(/\/$/, '');
    const path = (CFG.mes.pathTemplate || '/service/{serviceName}/{methodName}')
      .replace('{serviceName}', serviceName)
      .replace('{methodName}', methodName);
    return base + path;
  }

  /**
   * 把一帧报文发到 MES：**只发，不入队**，成功/失败都如实返回，队列记账交给调用方。
   * 抽出来是为了让 uploadReport()（首发失败即入队）与 retryPending()（人工重报）共用同一段发送逻辑：
   * 否则人工重报再走一遍 uploadReport()，"失败即入队"会给队列里同一报文添出重复条目。
   * @returns {Promise<{ok:boolean, receipt?:object, url:string, failReason?:string,
   *                    responseCode?:string, responseText?:string, error?:string}>}
   */
  async function sendReport(body, serviceName, methodName) {
    const url = buildUrl(serviceName || 'report', methodName || 'receiveReport');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json;charset=UTF-8' },
          CFG.mes.token ? { Authorization: 'Bearer ' + CFG.mes.token } : {}
        ),
        body: JSON.stringify(body)
      });
      const text = await res.text();
      let receipt = null;
      try { receipt = JSON.parse(text); } catch (e) { receipt = { raw: text }; }
      if (isReceiptOk(receipt)) return { ok: true, receipt, url };
      /* 回执判为失败：把失败原因一并带回（人工重报界面需要它，别只留一个 ok=false） */
      return {
        ok: false, receipt, url,
        failReason: receiptReason(receipt),
        responseCode: receipt && receipt.code !== undefined
          ? String(receipt.code)
          : (receipt && receipt.status !== undefined ? String(receipt.status) : '无回执'),
        responseText: text
      };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return { ok: false, url, error: msg, failReason: msg, responseCode: '网络错误', responseText: '' };
    }
  }

  /**
   * 上报一帧数据到 MES
   * 未配置 baseUrl 时为空操作（返回 skipped），便于开发期直接运行
   * 失败（回执判失败 / 网络异常）→ 写明失败原因并进补传队列；**队列满时拒绝入队并如实回报**
   * 注意：失败后**不自动重发**（IF-B.9 / V1.31），重报只由人工触发的 retryPending() 承担。
   * @returns {Promise<{ok:boolean, receipt?:object, url?:string, error?:string,
   *                    skipped?:boolean, reason?:string, queueFull?:boolean, pendingCount?:number}>}
   */
  async function uploadReport(payload, serviceName, methodName) {
    const body = payload || buildReportPayload(window.MockData ? window.MockData.state : {});
    if (!CFG.mes.baseUrl) return { ok: false, skipped: true, reason: '未配置 MES 地址（Q-23）' };

    const startedAt = Date.now();
    const r = await sendReport(body, serviceName, methodName);
    if (r.ok) return { ok: true, receipt: r.receipt, url: r.url };

    /* 失败即入队（唯一的一次入队点）；上报结果里带回原因与队列状态，供界面/告警使用 */
    const queued = queuePending({
      payload: body,
      failReason: r.failReason,
      responseCode: r.responseCode,
      responseText: r.responseText,
      elapsedMs: Date.now() - startedAt
    });
    const out = {
      ok: false, url: r.url,
      pendingCount: queued.pendingCount, queueFull: queued.queueFull
    };
    if (r.receipt !== undefined) out.receipt = r.receipt;
    if (r.error !== undefined) out.error = r.error;
    return out;
  }

  /** 判断回执是否成功（兼容两种回执风格，见 Q-23） */
  function isReceiptOk(receipt) {
    if (!receipt) return false;
    if (CFG.mes.responseStyle === 'code') return receipt.code === 200;
    return receipt.status === 1 || receipt.status === '1';
  }

  /** 从回执里取一句可读的失败原因（人工重报时要看"为什么失败"） */
  function receiptReason(receipt) {
    if (!receipt) return '无回执';
    const msg = receipt.msg || receipt.message || receipt.raw;
    if (msg) return String(msg);
    if (receipt.code !== undefined) return '回执 code=' + receipt.code;
    if (receipt.status !== undefined) return '回执 status=' + receipt.status;
    return '回执判为失败';
  }

  /**
   * 上报失败 → 进补传队列（浏览器侧内存队列；落库留在服务端，见文件头 E10 说明）
   * **队列满时抛 QueueFullError（拒绝入队）**，由 uploadReport() 捕获后如实回报，
   * 绝不静默丢弃最旧报文（旧实现 `pending.shift()` 已废止，与 IF-B.9 / NFR-13 冲突）。
   * @param {{payload:object, failReason:string, responseCode:string, responseText:string, elapsedMs:number}} entry
   * @returns {{queued:boolean, pendingCount:number, queueFull:boolean, error?:string}}
   */
  function queuePending(entry) {
    const limit = queueCap();
    if (pending.length >= limit) {
      const err = QueueFullError(limit, pending.length);
      console.error('[Api] ' + err.message);
      return { queued: false, pendingCount: pending.length, queueFull: true, error: err.message };
    }
    pending.push({
      payload: entry.payload,
      uploadId: entry.payload && entry.payload.uploadId,
      at: Date.now(),
      tries: 0,
      failReason: entry.failReason || '',
      responseCode: entry.responseCode || '',
      responseText: entry.responseText || '',
      elapsedMs: entry.elapsedMs === undefined ? null : entry.elapsedMs
    });
    /* 只暴露条数（告警用）；不做自动重试、不起定时器 —— 重报由人工触发（E10 已定决策） */
    return { queued: true, pendingCount: pending.length, queueFull: false };
  }

  /**
   * 刷新待补传状态：**只刷新，不发送**。
   * 按 IF-B.9（V1.31）：不做自动重发，本函数只刷新状态；发送一律由人工触发的 retryPending 承担。
   * 因此本函数**不发起任何网络请求**（无 fetch、无定时器、无退避），只重算并暴露
   * 待补传条数 / 队列容量 / 告警标志（getStatus() 的 pendingCount / queueAlert / queueFull）。
   * 旧实现在这里主动把队列逐条发出去，被 main.js 每秒调用一次 ⇒ 事实上就是自动重发，已按 V1.31 废止。
   * 仍保持 async 仅为兼容既有调用方写法 `Api.flushPending().catch(...)`（src/main.js），不产生异步副作用。
   * @returns {Promise<{sent:number, failed:number, left:number, remaining:number,
   *                    pendingCount:number, capacity:number,
   *                    queueAlert:boolean, queueFull:boolean}>}
   *          sent/failed 恒为 0（本函数不发送、不尝试）；left 为旧字段名（保留以免静默打断既有调用方），
   *          remaining 与 retryPending() 返回同名同义。
   */
  async function flushPending() {
    const s = getStatus();
    return {
      sent: 0,                        // 未发送任何报文（不自动重发）
      failed: 0,                      // 未做任何尝试
      left: s.pendingCount,
      remaining: s.pendingCount,
      pendingCount: s.pendingCount,
      capacity: s.pendingCapacity,
      queueAlert: s.queueAlert,
      queueFull: s.queueFull
    };
  }

  /**
   * 人工触发的补传重报（IF-B.9，V1.31）：**唯一会主动重发补传报文的入口**，供 UI-20 调用。
   * 语义：
   *   - 只在被调用时发送：无定时器、无指数退避、不自动重试（NFR-10 / NFR-13）；成功后也不追加后续发送；
   *   - 按队列顺序（FIFO）逐条重发；成功 → **移出队列**；仍失败 → **保留在队列里**并把 tries 累加 1，
   *     同时刷新 failReason / responseCode，**绝不丢弃报文**；
   *   - 未配置 MES 地址时只回报 skipped，不做任何发送与出队。
   * @param {{ids?:string[], limit?:number}} [options]
   *        ids   —— 只重报这些 uploadId（缺省＝全部待补传报文）
   *        limit —— 最多重报条数（正整数；缺省＝不限制）
   * @returns {Promise<{sent:number, failed:number, remaining:number,
   *                    results:Array<{uploadId:string, ok:boolean, error?:string, receipt?:object}>,
   *                    skipped?:boolean, reason?:string}>}
   */
  async function retryPending(options) {
    const opt = options || {};
    const wantIds = Array.isArray(opt.ids) && opt.ids.length
      ? new Set(opt.ids.map(String))
      : null;
    const selected = pending.filter(item => !wantIds || wantIds.has(String(item.uploadId)));
    const max = Number.isInteger(opt.limit) && opt.limit > 0 ? opt.limit : selected.length;
    const targets = selected.slice(0, max);
    const results = [];

    if (!CFG.mes.baseUrl) {
      return {
        sent: 0, failed: 0, remaining: pending.length, results,
        skipped: true, reason: '未配置 MES 地址（Q-23）'
      };
    }

    const attempted = new Set();
    const kept = new Set();
    let sent = 0;
    let failed = 0;

    for (const item of targets) {
      const r = await sendReport(item.payload, 'report', 'receiveReport');
      attempted.add(item);
      if (r.ok) {
        sent++;
        results.push({ uploadId: item.uploadId, ok: true, receipt: r.receipt });
        continue;
      }
      /* 仍失败：留在队列里、累加次数（人工重报界面据此显示"已试 N 次"） */
      failed++;
      kept.add(item);
      item.tries++;
      item.at = Date.now();
      item.failReason = r.error || r.failReason || '回执判为失败';
      item.responseCode = r.responseCode || item.responseCode;
      item.responseText = r.responseText || item.responseText;
      results.push({ uploadId: item.uploadId, ok: false, error: item.failReason });
    }

    /* 未选中的条目按原顺序留在队列；选中的成功条目出队，失败条目保留 */
    pending = pending.filter(item => !attempted.has(item) || kept.has(item));

    return { sent, failed, remaining: pending.length, results };
  }

  /**
   * 待补传清单（条数 + 明细），供后续"一键重报"界面与自检项使用。
   * 只读，不触发任何网络请求。
   * @param {number} [limit] 最多返回条数（缺省全量）
   * @returns {{count:number, capacity:number, overflow:boolean, full:boolean, items:Array<object>}}
   */
  function listPending(limit) {
    const cap = queueCap();
    const items = pending.map(item => ({
      uploadId: item.uploadId,
      tries: item.tries,
      at: item.at,
      failReason: item.failReason,
      responseCode: item.responseCode,
      elapsedMs: item.elapsedMs,
      payload: item.payload
    }));
    const sliced = Number.isInteger(limit) && limit > 0 ? items.slice(0, limit) : items;
    return {
      count: pending.length,
      capacity: cap,
      overflow: pending.length >= cap,
      full: pending.length >= cap,
      items: sliced
    };
  }

  /**
   * 供界面显示的自检信息。
   *
   * ⚠ **既有字段名一个都不改**（`dataSource` / `upperUrl` / `upperStale` / `mesUrl` /
   *   `pendingCount` / `pendingCapacity` / `queueAlert` / `queueFull` / `responseStyle`）：
   *   `tests/contract-check.js` 的 N 段（R26-P3-4）与 G 段都按这些键名取数，改名即打红。
   *   W5-② 只**追加**服务端源相关的只读字段（`sourceKind` / `server*` / `upload*`）。
   * @param {Date}   [now]   判定时刻（注入时钟）
   * @param {object} [state] 看板状态（服务端模式读 `serverLink`/`upload`；缺省取 `MockData.state`）
   */
  function getStatus(now, state) {
    const cap = queueCap();
    const pendingCount = pending.length;
    const st = state || ((window.MockData && window.MockData.state) ? window.MockData.state : null);
    const sl = st && st.serverLink;
    const up = st && st.upload;
    return {
      dataSource: CFG.dataSource,
      upperUrl: CFG.upper.url || '（未配置，待 Q-21）',
      upperStale: isUpperStale(now, st),
      mesUrl: CFG.mes.baseUrl || '（未配置，待 Q-23）',
      pendingCount: pendingCount,
      pendingCapacity: cap,
      /* 待补传条数达到告警阈值即置位，供界面与巡检**告警**（不再静默丢弃，见 E10）。
         阈值＝真源 CFG.mes.queueWarnThreshold（R26-P3-4：与容量 queueCap 分语义，不再按 90% 容量推导）。 */
      queueAlert: pendingCount >= queueWarnThreshold(),
      queueFull: pendingCount >= cap,
      responseStyle: CFG.mes.responseStyle,
      /* ---- W5-② 追加（只读；不改上面任何既有字段的语义） ---- */
      sourceKind: CFG.dataSource,
      boardBaseUrl: serverBase(),
      serverConnected: !!(sl && sl.online === true),
      serverLinkState: sl ? sl.state : null,
      serverPendingCount: (up && typeof up.pendingCount === 'number') ? up.pendingCount : null,
      serverQueueAlert: !!(up && up.alert && up.alert.warn),
      serverUploadAvailable: !!(up && up.available === true)
    };
  }

  return {
    /* 配置与映射（只读引用，便于排查） */
    CFG, MAP,
    /* IF-D */
    applyUpperPayload, validatePayload, isUpperStale, syncLinkState, startUpper, stopUpper,
    /* 看板服务端（W5-② / ADR-0008）：统一 HTTP 出口 + 首帧快照 + UI-20 的两个只读接口与人工重报 */
    httpJson, fetchSnapshot, fetchPending, fetchUploadStatus, retryPendingServer,
    /* ADR-0007（设置页鉴权；T-20261002-15 / E86①）：会话令牌的**唯一** HTTP 出口（走 httpJson） */
    authStatus, authLogin, authLogout, authChange, authInit,
    /* W7-B（FR-8.5 / NFR-26）：自检页真实探测所需的**只读**端点（新增，不改既有函数语义） */
    fetchHealth, fetchIfdStatus, fetchIfaStatus, fetchHealthWithDate,
    /* P1-1b（FR-2.6 按端点）：设备状态页逐端点链路状态的**只读**取数口（只搬运服务端结论） */
    fetchIfdEndpoints,
    serverBase, serverTimeout,
    /* IF-B */
    buildReportPayload, buildUrl, uploadReport, nextUploadId, isReceiptOk, receiptReason,
    /* IF-B.5 §1.2.5 关键运行参数报文（含 uclValue/lclValue/IsPass 占位口径） */
    buildParamReportPayload,
    /* IF-B 标准上下限口径（FR-3.18/FR-3.19、N-7）：供界面与联调自检复用 */
    standardLimits, isPassByStandard,
    /* 待补传清单（查询 / 人工重报） */
    listPending, retryPending,
    /* 状态刷新（不发送） */
    flushPending,
    /* 状态 */
    getStatus,
    /* 工具（供自测工具复用） */
    getPath, setPath
  };
})();
