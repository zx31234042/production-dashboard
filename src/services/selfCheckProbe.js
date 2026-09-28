/* ==========================================================================
   系统状态自检的**真实探测**（services/selfCheckProbe.js）—— W7-B（FR-8.5 / NFR-26）
   需求：FR-8.5「系统状态自检」列出**网络状态 / PC 上位机连接状态 / MES 连通性**等；
        NFR-26 要求自检结果可被读取、可被现场判读。
   问题（本包立案）：设置页那一栏此前是 `mockData.buildSelfCheck()` 的**演示数据**
        （且服务端模式下按 ADR-0008 D3 被清空 ⇒ 什么都看不到）⇒ 现场无法用它判断真实链路。
   本文件把服务端**已有**的只读端点映射成**既有那 7 条自检行**（行名逐字沿用
        `mockData.buildSelfCheck()` 的文案 —— `tests/copy-check.js` 的 FR-8.5 映射锁住它们，
        本包**不改行名**）：
       ┌ 行名（逐字）           数据源                       三态口径
       ├ 看板主机网络          GET /health                 200 且 ok ⇒ ok；非 2xx/超时 ⇒ err
       ├ PC 上位机连接         GET /ifd/status             link.online ⇒ ok；离线 ⇒ err（带距最近有效帧 ms）
       ├ MES 接口连通性        GET /upload/status          200 ⇒ ok/warn（未配地址 ⇒ warn，Q-23）
       ├ MES 上报队列          GET /upload/status          条数 ≥ 阈值 ⇒ warn；未知 ⇒ warn
       ├ 本地数据库            GET /health                 dbWritable ⇒ ok；false ⇒ err
       ├ 磁盘空间              navigator.storage（尽力）    探测不到 ⇒ warn「尚未接入服务端」
       └ NTP 时间同步          /health 的 Date 头 与本地时钟  偏差 ≤ 阈值 ⇒ ok；超出 ⇒ warn
   硬纪律（ADR-0008 D3/D4 与既有 E38/E39 的"显式降级"同一口径）：
     · **绝不 `console.error`、绝不抛未捕获异常**（每个端点各自 try/catch，失败收敛成行结论）；
     · **绝不把探测失败显示成通过**：拿不到证据就是 `warn` + 明写原因，拿到坏证据就是 `err`；
     · **绝不编造数值**：服务端没给的量（磁盘余量 / NTP 偏差）要么如实探测，要么显式"尚未接入"；
     · **不新起定时器**：调用方（`SettingPanel.render()`）按既有渲染节拍调用本文件的
       `ensure()`，内部按 `REFRESH_MS` 节流 + `inFlight` 去重；
     · **不影响演示模式**：`isServerMode()` 为假时 `ensure()` 立即返回，演示仍走
       `mockData.buildSelfCheck()`（成对断言见 `tests/ui-check.js` 的 W7-B-c）。
   依赖：`services/api.js` 的只读取数函数（新增的 `fetchHealth`/`fetchIfdStatus`/`fetchIfaStatus`
        ＋既有 `fetchUploadStatus`）。**不引第三方依赖。**
   ========================================================================== */
window.SelfCheckProbe = (function () {
  'use strict';

  /** 探测节流周期（沿用设置页既有刷新节拍量级；**不新起定时器**，由渲染循环驱动） */
  const REFRESH_MS = 5000;
  /** `link.staleMs` 缺省（服务端真源是 `upper.staleMs`，这里只作读不到时的展示兜底） */
  const DEFAULT_STALE_MS = 5000;
  /** NTP 判据：与响应 `Date` 头的偏差绝对值的阈值（ms）—— 超过即"同步偏差偏大" */
  const NTP_WARN_MS = 2000;

  let inFlight = false;
  let lastAt = 0;
  let lastRows = null;
  let probeCount = 0;

  /** 是否服务端模式（`state.serverMode` 优先，退 `BoardConfig.dataSource`） */
  function isServerMode(state) {
    if (state && state.serverMode === true) return true;
    const cfg = window.BoardConfig;
    return !!(cfg && cfg.dataSource === 'server');
  }

  /** 数值取整（`null`/非有限数一律 `null`，不写 0 —— 与 W4/ADR-0008 D3 的缺值口径一致） */
  function numOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  /**
   * 失败原因文本（**必须带上可判读的失败类别**，供现场区分"服务端 503 没装配"与"网络不通"）：
   * 依次取 `failReason`（服务端 `err.message` 或网络异常原文）＋ `responseCode`（HTTP 状态码 /
   * `网络错误` / `不支持`）。只取 `failReason` 会把"503"这类关键信息丢掉 —— 这正是
   * `tests/ui-check.js` 的 W7-B-b 断言抓出来的（它要求行文本能读出状态码）。
   */
  function whyOf(res, fallback) {
    if (!res) return fallback || '未知原因';
    const reason = res.failReason || res.error || '';
    const code = res.responseCode === undefined || res.responseCode === null ? '' : String(res.responseCode);
    const bits = [];
    if (reason) bits.push(String(reason));
    if (code && code !== String(reason)) bits.push('（' + code + '）');
    if (!bits.length) bits.push(fallback || '未知原因');
    return bits.join('');
  }

  /** 时长文本（秒 → `Xd HH:MM:SS` / `HH:MM:SS`） */
  function uptimeText(sec) {
    const s = numOrNull(sec);
    if (s === null) return null;
    const pad = n => String(n).padStart(2, '0');
    const d = Math.floor(s / 86400);
    const h = Math.floor(s % 86400 / 3600);
    const m = Math.floor(s % 3600 / 60);
    const ss = Math.floor(s % 60);
    return (d > 0 ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(ss);
  }

  /* ---------------- 七行（行名逐字沿用 copy-check 锁住的文案） ---------------- */

  /** ① 看板主机网络：服务端可达 + 监听地址 + 运行时长 + 累计会话数（`/health` + `/ifa/status`） */
  function rowHostNetwork(health, ifa) {
    const name = '看板主机网络';
    if (!health.ok) {
      return { name, state: '探测失败：' + whyOf(health), lv: 'err', reason: whyOf(health), src: health.url };
    }
    const h = health.health || {};
    const bits = [];
    if (h.listen) bits.push(h.listen);
    if (h.version) bits.push('v' + h.version);
    const up = uptimeText(h.uptimeSec);
    if (up) bits.push('运行 ' + up);
    if (typeof h.streams === 'number') bits.push('SSE ' + h.streams);
    /* IF-A 是"本机对外提供的接口"，其鉴权降级也属"看板主机网络"的可观测面 */
    if (ifa && ifa.ok && ifa.status && ifa.status.auth && ifa.status.auth.degraded) {
      return { name, state: '正常（' + bits.join(' · ') + '）· 注意：' + (ifa.status.auth.warning || 'IF-A 接口未启用鉴权'),
        lv: 'warn', reason: ifa.status.auth.warning || 'IF-A 接口未启用鉴权', src: [health.url, ifa.url].join(' / ') };
    }
    if (h.lastError) {
      return { name, state: '正常（' + bits.join(' · ') + '）· 最近错误：' + String(h.lastError.message || h.lastError),
        lv: 'warn', reason: '服务端 lastError 非空', src: health.url };
    }
    return { name, state: '正常（' + bits.join(' · ') + '）', lv: 'ok', reason: null, src: health.url };
  }

  /** ② PC 上位机连接：`link.online` + 距最近有效帧（`/ifd/status` 的 `link`，与 `/state` 同源） */
  function rowUpperLink(ifd) {
    const name = 'PC 上位机连接';
    if (!ifd.ok) {
      return { name, state: '探测失败：' + whyOf(ifd), lv: 'err', reason: whyOf(ifd), src: ifd.url };
    }
    const link = (ifd.status && ifd.status.link) || {};
    const staleMs = numOrNull(link.staleMs) === null ? DEFAULT_STALE_MS : link.staleMs;
    const ageMs = numOrNull(link.ageMs);
    const ageTxt = ageMs === null ? '尚无有效帧' : '距最近有效帧 ' + Math.round(ageMs / 1000) + ' s';
    if (link.online === true) {
      return { name, state: '在线正常（' + ageTxt + '，判据 ' + staleMs + ' ms）', lv: 'ok', reason: null, src: ifd.url };
    }
    return { name, state: '离线断连（' + ageTxt + '，判据 ' + staleMs + ' ms）', lv: 'err',
      reason: '上位机链路离线（' + ageTxt + '，阈值 ' + staleMs + ' ms）', src: ifd.url };
  }

  /** ③ MES 接口连通性：`/upload/status` 的 `configured`/`baseUrl`/`responseStyle` */
  function rowMesLink(upload) {
    const name = 'MES 接口连通性';
    if (!upload.ok) {
      return { name, state: '探测失败：' + whyOf(upload), lv: 'err', reason: whyOf(upload), src: upload.url };
    }
    const s = upload.status || {};
    if (s.configured === false) {
      return { name, state: '未配置地址（Q-23）· 上报只回报"跳过"，一条都不发', lv: 'warn',
        reason: s.configWarning || '未配置 MES 地址（Q-23）', src: upload.url };
    }
    const url = s.baseUrl ? String(s.baseUrl) : '';
    const style = s.responseStyle ? String(s.responseStyle) : '';
    const last = s.lastResult || null;
    if (last && last.ok === false && last.skipped !== true) {
      /* 有地址但最近一次真发失败：这是**坏证据**，必须 err（不得显示成通过） */
      return { name, state: '最近一次上报失败：' + String(last.failReason || last.reason || '回执异常') +
        (url ? '（' + url + '）' : ''), lv: 'err',
        reason: String(last.failReason || last.reason || '最近一次上报失败'), src: upload.url };
    }
    return { name, state: '已配置（' + (url || '地址未知') + (style ? ' · 回执 ' + style : '') + '）' +
      (last && last.skipped ? ' · 最近一次：' + String(last.reason || '跳过') : ''),
      lv: 'ok', reason: null, src: upload.url };
  }

  /** ④ MES 上报队列：`pendingCount` / `warnThreshold` / `capacity` */
  function rowMesQueue(upload) {
    const name = 'MES 上报队列';
    if (!upload.ok) {
      return { name, state: '探测失败：' + whyOf(upload), lv: 'err', reason: whyOf(upload), src: upload.url };
    }
    const s = upload.status || {};
    const pending = numOrNull(s.pendingCount);
    const thr = numOrNull(s.warnThreshold);
    const cap = numOrNull(s.capacity);
    if (pending === null) {
      return { name, state: '条数未知（服务端未给出 pendingCount）', lv: 'warn',
        reason: '服务端 /upload/status 未给出 pendingCount', src: upload.url };
    }
    const detail = '待补传 ' + pending + ' 条' +
      (cap === null ? '' : ' / 容量 ' + cap) + (thr === null ? '' : ' · 告警阈值 ' + thr);
    if (thr !== null && pending >= thr) {
      return { name, state: detail + '（已达告警阈值，需人工重报）', lv: 'warn',
        reason: '待补传 ' + pending + ' 条 ≥ 告警阈值 ' + thr, src: upload.url };
    }
    return { name, state: detail, lv: 'ok', reason: null, src: upload.url };
  }

  /** ⑤ 本地数据库：`/health` 的 `dbWritable` + `dbFile`（服务端启动自检已真写过临时表） */
  function rowLocalDb(health) {
    const name = '本地数据库';
    if (!health.ok) {
      return { name, state: '探测失败：' + whyOf(health), lv: 'err', reason: whyOf(health), src: health.url };
    }
    const h = health.health || {};
    const file = h.dbFile ? String(h.dbFile).split(/[\\/]/).pop() : '';
    if (h.dbWritable === true) {
      return { name, state: '正常' + (file ? '（' + file + '，服务端启动自检：临时表写入/回读/删除均成功）' : '（服务端启动自检通过）'),
        lv: 'ok', reason: null, src: health.url };
    }
    return { name, state: '库不可写（服务端 dbWritable=false）', lv: 'err',
      reason: '服务端 /health 的 dbWritable 为 false', src: health.url };
  }

  /**
   * ⑥ 磁盘空间：服务端 `/health` **没有**磁盘余量字段（演示期那条是硬编码文案）。
   * 本函数**尽力**用浏览器 `navigator.storage` 探测"本页可用配额"，探不到就**显式未接入** ——
   * 绝不编造"剩余 78.2 GB"这类数值（ADR-0008 D3 的"不得用演示值顶替"）。
   */
  function rowDiskSpace(health) {
    const name = '磁盘空间';
    if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.estimate !== 'function') {
      return { name, state: '尚未接入服务端（浏览器未提供存储配额探测；服务端 /health 暂无磁盘余量字段）' +
        '· 口径来源：浏览器配额口径，非磁盘剩余空间',
        lv: 'warn', reason: '磁盘余量无数据源（本机浏览器 API 不可用且服务端未提供）', src: health && health.url, pending: false };
    }
    return { name, state: '探测中…', lv: 'warn', reason: null, src: health && health.url, pending: true };
  }

  /** 把 `navigator.storage.estimate()` 的结果落成文本（只报**真实**的配额与用量，不猜磁盘） */
  function diskTextFrom(est) {
    const quota = numOrNull(est && est.quota);
    const usage = numOrNull(est && est.usage);
    const gb = v => (v / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    if (quota === null) {
      return { state: '尚未接入服务端（浏览器未给出存储配额数值）· 口径来源：浏览器配额口径，非磁盘剩余空间',
        lv: 'warn', reason: 'navigator.storage.estimate() 未给出 quota' };
    }
    return {
      state: '本页可用配额 ' + gb(quota) + (usage === null ? '' : '，已用 ' + gb(usage)) +
        '（服务端 /health 暂无磁盘余量字段）· 口径来源：浏览器配额口径，非磁盘剩余空间',
      lv: 'ok', reason: null
    };
  }

  /**
   * ⑦ NTP 时间同步：用 `/health` 响应头 `Date`（服务端时钟）与本地时钟比对偏差。
   * 服务端**没有**直接的"偏差 ms"字段，故这项是**真探测出来的**（不是演示值）；
   * 响应头拿不到（桩件/裁剪环境）⇒ 显式未接入，不得写成"已同步 · 偏差 32 ms"。
   */
  function rowNtp(health, localNow) {
    const name = 'NTP 时间同步';
    if (!health.ok) {
      return { name, state: '探测失败：' + whyOf(health), lv: 'err', reason: whyOf(health), src: health.url };
    }
    const dateHdr = health.dateHeader;
    if (!dateHdr) {
      return { name, state: '尚未接入服务端（本环境读不到响应 Date 头，无法测量时钟偏差）· 口径来源：响应头 Date 与本地钟偏差',
        lv: 'warn', reason: '无 Date 响应头可比对', src: health.url };
    }
    const serverMs = Date.parse(dateHdr);
    if (!Number.isFinite(serverMs)) {
      return { name, state: '尚未接入服务端（Date 头无法解析：' + String(dateHdr) + '）· 口径来源：响应头 Date 与本地钟偏差',
        lv: 'warn', reason: 'Date 响应头无法解析', src: health.url };
    }
    const skewMs = Math.round((localNow || Date.now()) - serverMs);
    const abs = Math.abs(skewMs);
    if (abs > NTP_WARN_MS) {
      return { name, state: '与看板服务端时钟偏差 ' + skewMs + ' ms（超过 ' + NTP_WARN_MS + ' ms，建议核对系统时间）· 口径来源：响应头 Date 与本地钟偏差',
        lv: 'warn', reason: '时钟偏差 ' + skewMs + ' ms > ' + NTP_WARN_MS + ' ms', src: health.url };
    }
    return { name, state: '与看板服务端时钟同步（偏差 ' + skewMs + ' ms）· 口径来源：响应头 Date 与本地钟偏差',
      lv: 'ok', reason: null, src: health.url };
  }

  /** 组装七行（固定顺序＝`mockData.buildSelfCheck()` 的顺序，供逐项对账） */
  function buildRows(ctx) {
    return [
      rowHostNetwork(ctx.health, ctx.ifa),
      rowUpperLink(ctx.ifd),
      rowMesLink(ctx.upload),
      rowMesQueue(ctx.upload),
      rowLocalDb(ctx.health),
      rowDiskSpace(ctx.health),
      rowNtp(ctx.health, ctx.at)
    ];
  }

  /**
   * 跑一轮探测（**只读、无副作用**；每项失败各自收敛成行结论，绝不抛）。
   * @param {Date} [now] 本地时刻
   * @returns {Promise<Array<object>>} 七行 `{name, state, lv, reason, src}`
   */
  function probe(now) {
    const at = (now || new Date()).getTime();
    probeCount++;
    const api = window.Api;
    if (!api || typeof api.fetchHealth !== 'function') {
      /* 适配层未加载/裁剪环境：七行一律显式 err + 原因（**不抛、不 console.error**） */
      const why = '适配层未加载 fetchHealth()（服务端自检不可用）';
      return Promise.resolve(buildRows({
        health: { ok: false, failReason: why, url: '' },
        ifd: { ok: false, failReason: why, url: '' },
        upload: { ok: false, failReason: why, url: '' },
        at
      }));
    }
    return Promise.all([
      (typeof api.fetchHealthWithDate === 'function' ? api.fetchHealthWithDate() : api.fetchHealth())
        .catch(err => ({ ok: false, failReason: '探测异常：' + ((err && err.message) || String(err)), url: '' })),
      api.fetchIfdStatus().catch(err => ({ ok: false, failReason: '探测异常：' + ((err && err.message) || String(err)), url: '' })),
      api.fetchIfaStatus().catch(err => ({ ok: false, failReason: '探测异常：' + ((err && err.message) || String(err)), url: '' })),
      api.fetchUploadStatus().catch(err => ({ ok: false, failReason: '探测异常：' + ((err && err.message) || String(err)), url: '' }))
    ]).then(([health, ifd, ifa, upload]) => {
      const rows = buildRows({ health, ifd, ifa, upload, at });
      /* 「磁盘空间」行的浏览器侧配额是**异步**的：这里补一次，拿到就换成真实配额文本，
         拿不到就保留"尚未接入"（**绝不编造余量数值**）。失败只 warn，不影响其余六行。 */
      const diskRow = rows[5];
      if (diskRow && diskRow.pending && typeof navigator !== 'undefined' && navigator.storage &&
          typeof navigator.storage.estimate === 'function') {
        return navigator.storage.estimate().then(est => {
          const t = diskTextFrom(est);
          diskRow.state = t.state; diskRow.lv = t.lv; diskRow.reason = t.reason; diskRow.pending = false;
          return rows;
        }).catch(err => {
          diskRow.state = '尚未接入服务端（存储配额探测失败：' + ((err && err.message) || String(err)) + '）';
          diskRow.lv = 'warn'; diskRow.reason = 'navigator.storage.estimate() 失败'; diskRow.pending = false;
          return rows;
        });
      }
      return rows;
    });
  }

  /**
   * 按既有渲染节拍调用：**服务端模式**下按 `REFRESH_MS` 节流刷新 `state.selfCheck`。
   * · 演示模式 ⇒ 立即返回 `false`（一行都不写，演示仍走 `mockData.buildSelfCheck()`）；
   * · 节流窗口内 / 已有请求在途 ⇒ 不重复发起（**不新起定时器**，调用方是渲染循环）；
   * · 结果写入 `state.selfCheck`（渲染层零改动即可显示）＋ `state.selfCheckAt`（探测时刻）。
   * @param {object} state 看板状态
   * @param {Date}   [now] 当前时刻
   * @returns {boolean} 本次是否**发起了**探测
   */
  function ensure(state, now) {
    if (!state || !isServerMode(state)) return false;
    const t = (now || new Date()).getTime();
    if (inFlight) return false;
    if (lastAt && t - lastAt < REFRESH_MS) return false;
    inFlight = true;
    lastAt = t;
    probe(now).then(rows => {
      inFlight = false;
      lastRows = rows;
      state.selfCheck = rows;
      state.selfCheckAt = new Date(t).toISOString();
      state.selfCheckSource = 'server-probe';
    }).catch(err => {
      /* `probe()` 自己已经把每项失败收敛成行结论；走到这里说明连 Promise.all 都炸了 —— 兜底成显式 err */
      inFlight = false;
      const why = '自检探测整体异常：' + ((err && err.message) || String(err));
      state.selfCheck = [{ name: '看板主机网络', state: why, lv: 'err', reason: why }];
      state.selfCheckAt = new Date(t).toISOString();
      state.selfCheckSource = 'server-probe-failed';
      console.warn('[SelfCheckProbe] ' + why);
    });
    return true;
  }

  /** 只读状态（自检/回执用） */
  function status() {
    return { refreshMs: REFRESH_MS, inFlight, lastAt: lastAt || null, probeCount, rows: lastRows ? lastRows.length : 0 };
  }

  /** 复位节流与在途标志（**仅供自检注入用**；不改变线上口径） */
  function reset() {
    inFlight = false;
    lastAt = 0;
    lastRows = null;
    probeCount = 0;
  }

  return { probe, ensure, status, reset, isServerMode, REFRESH_MS, NTP_WARN_MS };
})();
