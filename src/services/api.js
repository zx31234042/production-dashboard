/* ==========================================================================
   接口适配层（services/api.js）
   作用：把"外部报文"与"看板内部数据"互相转换，使接口规范/字段名变化时只需改配置。
   对应需求：
     - IF-D  上位机 → 看板：applyUpperPayload()、startUpper()
     - IF-B  看板 → MES  ：buildReportPayload()、uploadReport()（附录 2，13 字段）
     - IF-B.9 失败缓存与重试：pending 队列 + 指数退避
   依赖：config/board.config.js、config/fieldMap.js（需先加载）
   说明：本文件不操作 DOM，只做数据转换与网络收发（PROJECT_RULES 9.2）
   ========================================================================== */
window.Api = (function () {
  'use strict';

  const CFG = window.BoardConfig;
  const MAP = window.FieldMap;

  /* 上报失败待补传队列（内存态；正式实现应落库，见 DR-18/DR-19） */
  let pending = [];
  /* 上报流水号序号，保证同一秒内多次上报也不重复 */
  let uploadSeq = 0;
  /* 上位机数据源定时器 */
  let upperTimer = null;
  /* 最近一次成功收到上位机数据的时刻 */
  let lastUpperAt = 0;

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

  /** 生成上传流水号：UP + yyyyMMddHHmmss + 3 位序号 */
  function nextUploadId(d) {
    const t = d || new Date();
    uploadSeq = (uploadSeq + 1) % 1000;
    return 'UP' + t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) +
           pad(t.getHours()) + pad(t.getMinutes()) + pad(t.getSeconds()) +
           String(uploadSeq).padStart(3, '0');
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

  /** 判断上位机数据是否已过期（用于界面降级提示） */
  function isUpperStale(now) {
    if (!lastUpperAt) return true;
    return ((now ? now.getTime() : Date.now()) - lastUpperAt) > CFG.upper.staleMs;
  }

  /* ---------------- 数据源接入 ---------------- */

  /**
   * 启动上位机数据源
   * @param {object}   state    看板状态
   * @param {Function} onFrame  每帧回调（state, applied, payload）
   */
  function startUpper(state, onFrame) {
    stopUpper();
    const src = CFG.dataSource;

    if (src === 'upper' && window.MockUpperSource) {
      /* 联调前自测：用前端内置的"模拟上位机"产生符合契约的报文，走同一条适配链路 */
      let s = null;
      upperTimer = setInterval(() => {
        s = window.MockUpperSource.next(s);
        const payload = s.payload;
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

    return 'none';   // mock 模式：由 mockData 自行驱动，适配层不介入
  }

  function stopUpper() {
    if (upperTimer) { clearInterval(upperTimer); upperTimer = null; }
  }

  /* ---------------- IF-B：看板内部 → MES 上报 ---------------- */

  /**
   * 组装附录 2 上报报文（13 字段）
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
        /* 缺值时给出安全默认，避免上报报文缺关键字段被 MES 退回 */
        if (field === 'collectTime') {
          v = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
              `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        } else if (field === 'testStatus') {
          v = MAP.modeToTestStatus[getPath(state, 'status.mode')] ?? 0;
        } else {
          v = 0;
        }
      }
      out[field] = v;
    });
    return out;
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
   * 上报一帧数据到 MES
   * 未配置 baseUrl 时为空操作（返回 skipped），便于开发期直接运行
   */
  async function uploadReport(payload, serviceName, methodName) {
    const body = payload || buildReportPayload(window.MockData ? window.MockData.state : {});
    if (!CFG.mes.baseUrl) return { ok: false, skipped: true, reason: '未配置 MES 地址（Q-23）' };

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
      const ok = isReceiptOk(receipt);
      if (!ok) queuePending(body);
      return { ok, receipt, url };
    } catch (err) {
      queuePending(body);
      return { ok: false, error: err.message, url };
    }
  }

  /** 判断回执是否成功（兼容两种回执风格，见 Q-23） */
  function isReceiptOk(receipt) {
    if (!receipt) return false;
    if (CFG.mes.responseStyle === 'code') return receipt.code === 200;
    return receipt.status === 1 || receipt.status === '1';
  }

  function queuePending(body) {
    pending.push({ payload: body, at: Date.now(), tries: 0, uploadId: body.uploadId });
    if (pending.length > 5000) pending.shift();   // 防止无限增长
  }

  /** 补传：按指数退避重试待传队列（IF-B.9） */
  async function flushPending() {
    if (!CFG.mes.baseUrl || pending.length === 0) return { sent: 0, left: pending.length };
    const now = Date.now();
    const rest = [];
    let sent = 0;
    for (const item of pending) {
      const delay = CFG.mes.retry.baseDelayMs * Math.pow(2, item.tries);
      if (now - item.at < delay) { rest.push(item); continue; }
      const r = await uploadReport(item.payload, 'report', 'receiveReport');
      if (r.ok) { sent++; } else { item.tries++; item.at = now; rest.push(item); }
    }
    pending = rest;
    return { sent, left: pending.length };
  }

  /** 供界面显示的自检信息 */
  function getStatus(now) {
    return {
      dataSource: CFG.dataSource,
      upperUrl: CFG.upper.url || '（未配置，待 Q-21）',
      upperStale: isUpperStale(now),
      mesUrl: CFG.mes.baseUrl || '（未配置，待 Q-23）',
      pendingCount: pending.length,
      responseStyle: CFG.mes.responseStyle
    };
  }

  return {
    /* 配置与映射（只读引用，便于排查） */
    CFG, MAP,
    /* IF-D */
    applyUpperPayload, validatePayload, isUpperStale, startUpper, stopUpper,
    /* IF-B */
    buildReportPayload, buildUrl, uploadReport, flushPending, nextUploadId, isReceiptOk,
    /* 状态 */
    getStatus,
    /* 工具（供自测工具复用） */
    getPath, setPath
  };
})();
