/* ==========================================================================
   IF-B 上报/人工重报路由挂载（server/http/routes/upload.js）—— W4（服务层第二笔 · 第 3 波）
   作用：把 `server/services/uploadReporter.js` 的能力接到 HTTP 面上，供 **UI-20**（待补传清单与
        人工重报入口）与巡检消费。本文件**只做 HTTP 适配**：读查询串 → 服务层 → 稳定 JSON；
        不写第二条组装/发送/留存路径（口径只有一份，见 uploadReporter.js）。
   端点（路径**定长**，与 `server/http/router.js` 的精确匹配器能力匹配，**未扩展路由表**）：
     · `GET  /upload/pending` 待补传清单（条数 + 明细，最旧优先）+ 告警快照（含"待补传条数"）
     · `GET  /upload/status`  上报状态：配置（含 baseUrl 未配置的**显式**告警）/ 队列 / 告警阈值
                              / 13 字段的取数来源与缺值口径 / 最近一次上报结果 / 是否**不做自动重试**
     · `GET  /upload/last`    最近一次**组装出来**的报文（13 字段 + §1.2.5 的 `paramDataList`）
     · `POST /upload/retry`   人工一键重报（**唯一**会再次发送待补传报文的入口）：
                              入参 `{ids?:string[], limit?:number}`（空体＝全部待补传）；
                              **按序补传**、**幂等**（已成功的不再发）；未配置 MES 地址 ⇒
                              200 + `{ok:false, skipped:true, reason:'未配置 MES 地址（Q-23）'}`，
                              **一条都不发**、也不落"成功"。
   来源校验（**E87**，2026-10-02 负责人裁定**方案 b**）：`POST /upload/retry` 在**进入处理前**
     先判来源 —— **非回环 ⇒ 403 `not_loopback`**，且**不读请求体、绝不调用 `reporter.retryPending()`**
     （"不发送"是硬口径：它是全仓唯一会再次向 MES 发报文的入口，且是**批量**重发）。
     判据**只取真源、不写第二份**：`services/auth.js` 的 `isLoopback()`（ADR-0007 D4 白名单）
     ＋ `routes/auth.js` 的 `remoteOf()`（**只信 `req.socket.remoteAddress`**，不信任何请求头）
     —— 与 `routes/notice.js` 用的是同一个出口。**本轮不做登录态**（裁定原文：登录态那一半留到
     `E86①` 前端"解锁 ⇒ 会话令牌"接线落定后另行加）⇒ 零前端依赖、不引 `readBearer`、不改前端。
     留痕口径（**只 `warn`，不写 `op_log`** —— 理由见下方 `forbiddenBody()` 的注释）。
   状态码：200（正常，含"跳过"与"本次仍失败"—— 失败已作为业务结果如实回在响应体里）；
           400（入参非法：`ids`/`limit` 形态不对）；**403（非回环来源，E87）**；
           405/404 由路由器给；500 内部故障（路由器留痕）。
   装配语义（**E48**，2026-10-05；同日**补修②**＝独立复核 `C·26②` 判"指纹覆盖面不够"）：上报器
     实例池的键是 `db` 句柄，**值里带"行为指纹"** —— 同一个库上第二次 `mountUpload()` 若行为配置
     与第一次不同 ⇒ **显式抛错并逐项指名差异**（绝不复用第一个实例的配置快照：那正是"上报静默发到
     旧地址"的成因）；配置相同 ⇒ 复用并**打一条日志**；`deps.config` 进**必填**（缺失即抛；装配点
     `server/index.js` 与这里同批传 `boardCfg`，**不读全局配置兜底**）。
     补修②把复核实测出来的三个洞一并补上：
       ① 配置覆盖面：由"只挑几个"改为**显式白名单**（含 `config.dataSource`／
          `config.device.equipCode`／`config.mes.*`（**除 `queueWarnThreshold`**：它不是注入配置的读点，队列阈值的真源在磁盘那份 `board.config.js`，见 `E179`），逐项附代码出处）—— 见 `CONFIG_KEY_PATHS`；
       ② 标量选项**按类型严格校验与比较**（`timeoutMs: 2000` ≠ `'2000'`；后者过去会静默回落
          `mes.timeoutMs`/3000）—— 见 `assertOptionTypes()`／`canonScalar()`；
       ③ `logger`/`now`/`fetch`/`queue`/`bus`/`idGenerator` 这类**无法按值比较的注入**，本次与创建时
          不是同一实例 ⇒ **默认抛错**（复核实测：沿用旧时钟 ⇒ 发报时间戳落旧时刻；沿用旧 bus ⇒
          本次挂载的订阅者 **0** 条事件），只有显式 `allowReuseWithDifferentDeps: true` 才降级为
          "逐项点名 ＋ 告警"。**默认路径里不再有"不同注入、静默复用、只在日志里说一句"**。
     详见下方 `resolveReporterDetail()` 及其上方的白名单注释。
   ⚠ 本包**不做**：定时上报/自动重试（W5 接线后才会有周期触发；即使那时也只调 `report()` 一次）、
      SSE 业务推送（W5）、前端切真实源（W5）、登录与口令（后续包）。
   依赖：`server/services/uploadReporter.js`、`server/http/router.js`（复用 json/readJson）、
        `server/services/auth.js`（`isLoopback`）、`server/http/routes/auth.js`（`remoteOf`）、
        `platform/clock.js`（时间唯一出口）。**零第三方依赖**。
   ========================================================================== */
'use strict';

const platformClock = require('../../../platform/clock');
const { createUploadReporter } = require('../../services/uploadReporter');
const { errorBody } = require('../router');
/* **E87**：回环判据与来源 IP 的**唯一真源**，本文件不另写第二份（两份必然漂移）：
     · `isLoopback`  —— `services/auth.js`（ADR-0007 D4：127.0.0.1 / ::1 / ::ffff:127.0.0.1）；
     · `remoteOf`    —— `routes/auth.js`（**只取 socket 地址**，`X-Forwarded-For` 一律不信），
                        与 `routes/notice.js:41` 复用同一个出口。
   本轮**不引 `readBearer`**：负责人 2026-10-02 裁定方案 b —— 只加回环校验，登录态留到 `E86①` 之后。 */
const { isLoopback } = require('../../services/auth');
const { remoteOf } = require('./auth');

/** 进程内实例池：`POST /upload/*` 是**进程级**端点，而站点实例持有"尝试次数/最近结果"等状态；
 *  每请求各建一份会让 `/upload/status` 永远显示"还没发过"（等于没有状态可观测）。
 *  键＝`db` 句柄本身（`WeakMap`，不把句柄转字符串），与 `routes/ifA.js` 的池同款。
 *
 *  ⚠ **E48（2026-10-05；补修②同日，复核 `C·26②`）**：原来"命中 `db` 键就 `return cached`"——
 *  **不再看本次的 config／logger／now／fetch／bus**，于是"同一个库上再挂一份指向别的 MES 的
 *  上报器"会**静默复用第一个实例（连同它的配置快照）**：上报打到旧地址、阈值用旧值，而且**不报错**
 *  （现场只能看到"上报发去了旧地址"）。现在池里的值带**行为指纹**（见 `behaviorOf()`）：
 *    ①指纹相同 ⇒ 复用（`E48②`），并**打一条日志**说明复用了哪个实例；
 *    ②指纹不同 ⇒ **显式抛错并逐项指名差异**（`E48②`），绝不静默换用旧配置；
 *    ③`config` 进**必填**（`E48③`）：创建路径缺 `config` 直接抛，**不读全局配置兜底** ——
 *      装配点 `server/index.js` 与本文件同批传 `boardCfg`；
 *    ④**注入项**（`logger`/`now`/`fetch`/`queue`/`bus`/`idGenerator`）与创建时**不是同一实例**
 *      ⇒ **默认也抛错**（补修②：复核实测"沿用旧时钟 ⇒ 发报时间戳落旧时刻""沿用旧 bus ⇒ 本次
 *      挂载的订阅者 **0** 条事件"都是**真的发错**，不是"只是日志不好看"）；只有显式
 *      `allowReuseWithDifferentDeps: true` 才降级为"逐项点名 ＋ `logger.warn` 告警"；
 *    ⑤标量选项**按类型严格校验与比较**（`timeoutMs: 2000` ≠ `'2000'`，见 `E48①-b`）。 */
const pool = { byDb: new WeakMap(), nullDb: null };

/* ---------------------------------------------------------------------------
   `E48①`（补修②）：**"创建实例时读了哪些 config 键"＝显式白名单**（复核 `C·26②` 判"覆盖面不够"）
   ---------------------------------------------------------------------------
   **推导依据＝代码里实际读过的键**（`server/services/uploadReporter.js`，逐处指行）：
     · `config.mes.baseUrl`            :219 `configured()`、:221 `baseUrl()`
     · `config.mes.pathTemplate`       :222 `pathTemplate()`
     · `config.mes.responseStyle`      :223 `responseStyle()`
     · `config.mes.token`              :224 `token()`
     · `config.mes.timeoutMs`          :196（`timeoutMs` 的缺省来源）
     · `config.mes.reportPlaceholder`  :197（`paramDataList` 的占位哨兵）
     · `config.mes.queueCap`           :548（`status().queueCap` 的读数；只影响状态输出，仍属"读到过"）
     · **`config.mes.queueWarnThreshold` 不在本表**（`E179`，2026-10-05 落地）：
       它**不是注入配置的读点** —— 队列告警阈值的**唯一真源＝「磁盘那份」** `src/config/board.config.js`
       （`require` 在 `services/uploadQueue.js`：模块级 `DEFAULT_WARN_THRESHOLD` ＋ 运行期
       `configWarnThreshold()`；本入口注入的 `deps.config` 里那个**同名键没有任何调用点读它**）。
       上一版的"保守纳入（宁可吵闹不可静默）"**已按 `C·27` 的实测撤销**：纳入它并不守任何行为
       （实测摘掉后行为**完全不变**），却会把"改了一个不生效的键"变成一次**假冲突**（拒绝复用，
       而队列实际用的阈值一字未动）⇒ 那是**指向错方向**的吵闹。**真读点**仍由本表逐条守住：
       负对照靶子改用 `config.mes.queueCap`（摘掉它 ⇒ "同一 db 第二次挂载必须拒绝复用并逐项指名"**必红**，
       取证＝`tests\._verify\T-20261005-20\p-e179-queue-threshold-source.js` 的 `E179-C1`／`E179-B2`）。
       ⚠ 若**将来**把队列阈值改成读注入配置，必须把它**同时**加回本表 —— 那时它才属于行为指纹。
     · `config.device.equipCode`       :272（报文 `equipCode` 的本机兜底，FR-8.6）
     · `config.dataSource`             :277（`'mock'` ⇒ 无帧时 `testStatus=0` **照发**；否则**拒发**
                                        `NO_TEST_STATUS`）—— 复核实测的两处漏项之一
   为什么用**枚举白名单**，而不是"整段 `config` 归一化"（复核给的另一条路）：
     · 枚举的**强项＝点名**：报错直接说 `config.dataSource（首次 … ⇒ 本次 …）`，现场不必自己 diff
       两份配置对象；整段归一只能回显一大坨 JSON，且会把 `shift`/`server`/`upper` 等**上报器一行都
       没读过**的段算进来 ⇒ "改了班次表却拒绝复用上报器"这类**假冲突**（吵闹且与上报行为无关）；
     · 枚举的**弱项＝会漏**（`uploadReporter.js` 以后多读一个键而这里不跟手 ⇒ 又回到静默）——这条
       弱项**不靠"整段归一"补偿**，而靠**机械对账**：`tests\._verify\T-20261005-18\
       p-e48-config-coverage.js` 扫描 `uploadReporter.js` 里所有 `config.`／`q().` 读点并与本表逐项
       对账（本批已跑，读数见回执）。⚠ 该探针**不是受管门禁**（`tests\*` 受管面不属本包可改）⇒
       **改了 `uploadReporter.js` 的人必须重跑它**；这条已登记为残留。
   **不可序列化字段怎么处理**（"归一化"必然要回答的问题）：本表是**纯数据路径 ＋ 按值比较**，不引入
     对象身份；若读段内出现**函数／`symbol`／`RegExp`／`Map`／`Set`／类实例**（`JSON.stringify` 下会
     **坍缩**成同一形态 ⇒ 两个不同实例会给出**同一指纹** ＝"假同"），`lossyConfigPaths()` 会**列出来
     并默认抛错**（要求配置是纯数据，或显式注入 `deps.reporter`）；只有
     `allowReuseWithDifferentDeps: true` 才降级为告警。`Date` 不在此列（`toISOString()` 可按值比较）。
   --------------------------------------------------------------------------- */
/** 上报器**会读**的顶层配置段（其余顶层段与上报行为无关 ⇒ 不进指纹，避免假冲突） */
const CONFIG_READ_TOP = Object.freeze(['dataSource', 'device', 'mes']);

/** 扁平白名单：每条＝代码里**确实读过**的配置路径（推导逐处见上方注释）。
 *  ⚠ **新增读取点必须同步本表**（否则指纹漏项 ⇒ 又回到"改了配置却复用"）；同步后重跑上面那条对账探针。
 *  ⚠ `'mes.queueWarnThreshold'` **已于 2026-10-05 移出**（`E179`）：它不是注入配置的读点
 *    （队列阈值的真源＝**磁盘那份** `src/config/board.config.js`，读点在 `services/uploadQueue.js`），
 *    列入本表只会把"改了一个不生效的键"变成一次**假冲突**。理由与 D22 替代靶子见上方注释。 */
const CONFIG_KEY_PATHS = Object.freeze([
  'dataSource',
  'device.equipCode',
  'mes.baseUrl',
  'mes.pathTemplate',
  'mes.responseStyle',
  'mes.token',
  'mes.timeoutMs',
  'mes.reportPlaceholder',
  'mes.queueCap'
]);

/** 键名排序的稳定序列化（**只用于指纹**：同一份内容的不同对象实例必须给出同一个字符串；
 *  函数／symbol／`Date`／循环引用都要有**稳定表示**，不能被 `JSON.stringify` 悄悄丢掉）。
 *  `undefined` 与 `null` 同形（"没有这个键"与"显式 null"对上报器行为一致）。 */
function stableJson(value) {
  const seen = new WeakSet();
  const norm = v => {
    if (v === undefined || v === null) return null;
    const t = typeof v;
    if (t === 'function') return '[function]';
    if (t === 'symbol') return '[symbol]';
    if (t !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    if (v instanceof Date) return '[date:' + v.toISOString() + ']';
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
    return out;
  };
  return JSON.stringify(norm(value));
}

/** 标量指纹：**带上类型**（`2000` ≠ `'2000'`、`true` ≠ `'true'`）—— `E48①-b`。
 *  复核实测：旧实现用 `String()` 归一 ⇒ `timeoutMs: 2000` 与 `'2000'` **同指纹**，而后者本会
 *  回落 `mes.timeoutMs`/3000（"被当成同一份配置复用、实例却仍是 2000"）。 */
function canonScalar(v) {
  if (v === undefined) return 'absent';
  if (v === null) return 'null';
  return typeof v + ':' + stableJson(v);
}

/** 按路径读值（白名单是扁平路径串；读不到＝`undefined`） */
function readPath(root, path) {
  let cur = root;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 读段内**不可按值比较**的配置值（函数／`symbol`／`RegExp`／`Map`／`Set`／类实例…）。
 *  这类值经 `stableJson` 会**坍缩**（`'[function]'`／`'{}'`）⇒ 两个不同实例给出同一指纹 ＝**假同**
 *  （"改了配置却复用"的另一条路）。故**不静默**：默认抛错点名（见 `resolveReporterDetail()`）。 */
function isLossyConfigValue(v) {
  if (typeof v === 'function' || typeof v === 'symbol') return true;
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v) || v instanceof Date) return false;
  const proto = Object.getPrototypeOf(v);
  return proto !== Object.prototype && proto !== null;
}

/** 遍历读段（`CONFIG_READ_TOP`）收集 lossy 值的路径（深度上限 8：配置是数据，不是深树） */
function lossyConfigPaths(config) {
  const out = [];
  const walk = (node, prefix, depth) => {
    if (depth > 8) return;
    if (isLossyConfigValue(node)) {
      const ctor = (node.constructor && node.constructor.name) || typeof node;
      out.push(prefix + '（' + ctor + '）');
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, prefix + '[' + i + ']', depth + 1)); return; }
    for (const k of Object.keys(node).sort()) walk(node[k], prefix ? prefix + '.' + k : k, depth + 1);
  };
  if (config && typeof config === 'object') {
    for (const top of CONFIG_READ_TOP) {
      if (!Object.prototype.hasOwnProperty.call(config, top)) continue;
      walk(config[top], 'config.' + top, 1);
    }
  }
  return out;
}

/** 值的可读描述（**带类型**）—— 报错文案不许把 `NaN`/`Infinity` 说成 "null"（`E135` 同族：
 *  `JSON.stringify(NaN) === 'null'` 会把症状指向错方向，故一律 `String(v) ＋ 类型`；
 *  长度截到 40 字符：函数体的 `String(fn)` 可能很长，报错文案不该被它淹没）。 */
function describeValue(v) {
  const s = String(v);
  return (s.length > 40 ? s.slice(0, 40) + '…' : s) + '（类型 ' + typeof v + '）';
}

/** 上报器**行为**的逐项读数（`E48①`：缓存键＝`db` ＋ 这份指纹）。
 *  范围＝**白名单**（`CONFIG_KEY_PATHS`，推导见上方注释）＋ 显式标量选项（按类型严格比较）。
 *  `logger`／`now`／`fetch`／`queue`／`bus`／`idGenerator` 是**不可按值比较**的注入（函数／句柄），
 *  不放进指纹（否则"同一时钟的两个闭包"会被误判成"配置不同"而制造假冲突），改为在复用时
 *  **按引用比较**：不同 ⇒ **默认抛错**（见 `resolveReporterDetail()` 的第④条取舍）。 */
const TRACKED_OPTIONS = ['serviceName', 'methodName', 'capacity', 'warnThreshold', 'timeoutMs', 'strict'];
function behaviorOf(deps) {
  const parts = {};
  for (const path of CONFIG_KEY_PATHS) parts['config.' + path] = stableJson(readPath(deps.config, path));
  for (const k of TRACKED_OPTIONS) parts['options.' + k] = canonScalar(deps[k]);
  return parts;
}

/** 指纹＝逐项读数的稳定序列化（报错时可直接回显，便于定位"哪一项不同"） */
function fingerprintOf(parts) { return stableJson(parts); }

/** 指纹的**短号**（只用于日志里"两边是不是同一个指纹"的可读标识；**不参与判等** ——
 *  判等永远是整串 `fingerprint` 逐字比较）。djb2：零依赖、稳定、够短。 */
function fingerprintTag(fp) {
  let h = 5381;
  for (let i = 0; i < fp.length; i++) h = ((h * 33) ^ fp.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** 可注入的**不可按值比较**项（函数／句柄）。
 *  `idGenerator` 由**补修②**加入：它原来经 `mountUpload` 被**静默丢弃**（`createUploadReporter()`
 *  支持它，但本文件没转发，复核 `C·26②` 顺带实测到）—— 现在**转发**，于是"换一个序号域"也必须
 *  显式（不许悄悄沿用旧实例的生成器）。 */
const INJECTED_KEYS = ['logger', 'now', 'fetch', 'queue', 'bus', 'idGenerator'];

/** 创建时**实际用到的引用**快照（`undefined`/`null` 一律记 `null` ＝"没有这一项注入"） */
function depsSnapshot(deps) {
  const out = {};
  for (const k of INJECTED_KEYS) out[k] = (deps[k] === undefined || deps[k] === null) ? null : deps[k];
  return out;
}

/** 本次挂载**传了、但与创建时不是同一个实例**的注入项（＝本次的注入不会被采纳，必须显式处置）。
 *  判据＝"本次显式传了（非 undefined/null）∧ 与创建时的引用不同"——与实例自身"没传就用缺省"
 *  的语义一致：**没传**不算冲突（本次没提出相反要求），**传了不同的**才算。 */
function injectedConflicts(createdDeps, deps) {
  const cur = depsSnapshot(deps);
  return INJECTED_KEYS.filter(k => cur[k] !== null && cur[k] !== createdDeps[k]);
}

/** 入口类型校验（补修②）：**不许**"传了字符串／`null` 却被静默忽略或回落"。
 *  · 数值项必须是有限数（`timeoutMs` 还要 `> 0`：否则 `createUploadReporter` 会**回落**
 *    `mes.timeoutMs`/3000 —— 那正是"传了值但没生效"的静默形态）；
 *  · `strict` 只认布尔（`strict: 'yes'` 会被 `options.strict === true` 静默吃掉）；
 *  · `serviceName`/`methodName` 只认非空字符串（否则会被 `join('/')` 隐式转字符串）；
 *  · `idGenerator` 必须带 `next()`（否则在更深处才炸，症状指向错方向）；
 *  · **`null` 一律拒绝**：要表示"不传"请**省略该键** —— 与 `E131` 同一条纪律"含糊即拒绝，
 *    拒绝优于替调用方猜意图"（`E33①` 的残留正是"`null` 被 `Number()` 收下 ⇒ 恒告警"）。 */
const NUMBER_OPTIONS = ['capacity', 'warnThreshold', 'timeoutMs'];
const STRING_OPTIONS = ['serviceName', 'methodName'];
function assertOptionTypes(deps) {
  for (const k of NUMBER_OPTIONS) {
    const v = deps[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError('mountUpload/resolveReporter: `' + k + '` 必须是**有限数值**，收到 ' +
        describeValue(v) + '；要表示"不传"请**省略该键**（不认 `null`／数字字符串 —— ' +
        "`timeoutMs: '2000'` 过去会静默回落到 `mes.timeoutMs`/3000，见 E48①-b）");
    }
    if (k === 'timeoutMs' && !(v > 0)) {
      throw new TypeError('mountUpload/resolveReporter: `timeoutMs` 必须 **> 0**，收到 ' + describeValue(v) +
        '（否则 `createUploadReporter` 会静默回落到 `mes.timeoutMs`/3000）');
    }
  }
  for (const k of STRING_OPTIONS) {
    const v = deps[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v === '') {
      throw new TypeError('mountUpload/resolveReporter: `' + k + '` 必须是**非空字符串**，收到 ' + describeValue(v));
    }
  }
  if (deps.strict !== undefined && typeof deps.strict !== 'boolean') {
    throw new TypeError('mountUpload/resolveReporter: `strict` 只认布尔值（`true` ＝"同一帧重复上报即抛错"），' +
      '收到 ' + describeValue(deps.strict));
  }
  if (deps.idGenerator !== undefined &&
      (!deps.idGenerator || typeof deps.idGenerator.next !== 'function')) {
    throw new TypeError('mountUpload/resolveReporter: `idGenerator` 必须带 `next()`（见 platform/id.js），收到 ' +
      describeValue(deps.idGenerator));
  }
  if (deps.allowReuseWithDifferentDeps !== undefined && typeof deps.allowReuseWithDifferentDeps !== 'boolean') {
    throw new TypeError('mountUpload/resolveReporter: `allowReuseWithDifferentDeps` 只认布尔值，收到 ' +
      describeValue(deps.allowReuseWithDifferentDeps));
  }
}

/**
 * 取（或惰性创建）上报器实例，并**如实报告来源**（`E48` 的装配显式性）。
 * 显式注入（`deps.reporter`）优先 —— 自检据此注入 mock 发送／固定时钟；此时**不查池、不要求
 * `config`**（实例由调用方自建自持，"配置"在这条路径上不存在）。
 *
 * **同库多实例的正解**（写在这里，别只在返回值的注释里）：本入口的池是"一个库一份实例"，
 * 想在同一库上同时挂**两份行为不同**的上报器（多网卡／多 MES／测试并行）⇒ **显式注入
 * `deps.reporter`（自建实例，装配方自持）** 或**另建一个库句柄**；本入口**不会**替调用方
 * "悄悄换用旧实例"，也**不会**替调用方"悄悄新建第二个实例"（那会让 `/upload/status` 的状态分叉）。
 *
 * @param {object} [deps] 同 `mountUpload`
 * @returns {{reporter:object|null, source:'injected'|'created'|'reused'|'none',
 *            fingerprint:string|null, ignored:string[],
 *            depsConflict:'n/a'|'none'|'allowed-by-opt-in'}}
 *          `ignored` ＝ 本次传入但**不会被采纳**的注入项（默认路径下必然为空：不同就抛错）。
 * @throws {TypeError} 创建路径缺 `deps.config`（`E48③`）／标量选项类型非法（补修②）／
 *                     读段内出现不可按值比较的配置值（补修②）
 * @throws {Error} 同库第二次挂载且**行为指纹不同**（`E48②`；消息里逐项指名差异）
 * @throws {Error} 同库第二次挂载且**注入项与创建时不是同一实例**（补修②：默认拒绝复用；
 *                 消息里逐项指名"本次传入的 X 与创建时不是同一个实例 ⇒ 拒绝复用"）
 */
function resolveReporterDetail(deps = {}) {
  if (deps.reporter) {
    return { reporter: deps.reporter, source: 'injected', fingerprint: null, ignored: [], depsConflict: 'n/a' };
  }
  /* `E48③`：`config` **必填**。刻意**不**回落到 `require(board.config)` —— 那正是把"忘了传"
     掩盖成"配置正确"的形态（与 `server/index.js` 里 `createStateSnapshot({…})` 那处记录过的
     同类静默分叉同一机理；**不写行号**：注释里的行号会先烂）。 */
  if (deps.config === undefined || deps.config === null) {
    throw new TypeError('mountUpload/resolveReporter: deps.config 是**必填项**（E48③）：' +
      '必须显式传**已解析的业务配置**（装配点 server/index.js 传 boardCfg）；' +
      '本模块刻意**不读全局配置兜底**（那会把"忘了传"掩盖成"配置正确"，与 E48 要防的静默错误同类）');
  }
  if (typeof deps.config !== 'object' || Array.isArray(deps.config)) {
    throw new TypeError('mountUpload/resolveReporter: deps.config 必须是**对象**，收到 ' + describeValue(deps.config));
  }
  assertOptionTypes(deps);
  /* 读段内出现**无法按值比较**的配置值 ⇒ **默认抛错**（否则 `Map`／类实例会"假同"，见白名单注释末段） */
  const allowDiffDeps = deps.allowReuseWithDifferentDeps === true;
  const lossy = lossyConfigPaths(deps.config);
  if (lossy.length && !allowDiffDeps) {
    throw new TypeError('mountUpload/resolveReporter: 读段（' + CONFIG_READ_TOP.join(' / ') + '）里出现了' +
      '**无法按值比较**的配置值 ⇒ 拒绝用它做"行为指纹"（`JSON.stringify` 下会坍缩成同一形态 ⇒ ' +
      '被判成同一指纹 ⇒ 静默复用，正是 E48 要防的形态）：' + lossy.join('；') +
      '。配置必须是**纯数据**（对象／数组／原始值／Date）；若确需如此，请显式注入 deps.reporter' +
      '（自建实例），或显式 `allowReuseWithDifferentDeps: true`（接受这几项上指纹不保真）。');
  }
  const db = deps.db || null;
  const parts = behaviorOf(deps);
  const fingerprint = fingerprintOf(parts);
  const cached = db ? pool.byDb.get(db) : pool.nullDb;
  if (cached) {
    /* ---- ①行为配置不同 ⇒ 抛错并逐项指名（`E48②`） ---- */
    if (cached.fingerprint !== fingerprint) {
      const diff = Object.keys(parts)
        .filter(k => cached.parts[k] !== parts[k])
        .map(k => k + '（首次 ' + cached.parts[k] + ' ⇒ 本次 ' + parts[k] + '）')
        .join('；');
      throw new Error('mountUpload: 同一个 db 句柄上**第二次挂载的行为配置与第一次不同** —— ' +
        '拒绝静默复用旧上报器（E48②）。差异项：' + (diff || '（指纹不同但逐项读数相同：请报告此形态）') +
        '。三种正当做法：①传**同一份**配置（内容相同即可）；②显式注入 deps.reporter（自建实例）；' +
        '③另建一个库句柄。');
    }
    /* ---- ②注入项与创建时不是同一实例 ⇒ **默认也抛错**（补修②，复核 `C·26②` 的实测） ----
       为什么默认抛错而不是"点名 ＋ 日志"：这几项**无法按值比较**，而"沿用旧实例"会**真的发错**
       （旧 `now` ⇒ 发报时间戳落旧时刻；旧 `bus` ⇒ 本次挂载的订阅者 0 条事件；旧 `fetch` ⇒ 本次的
       发送实现不被采纳）；只打一条日志时，错误行为**照旧发生**，只是多了一行不一定被读的日志 ⇒
       这不是"不静默"，而是"静默 + 一行字"。默认拒绝、把选择权交给调用方（opt-in 降级），
       才能保证"现场看到的失败 = 调用方**显式接受**的失败"。 */
    const conflicts = injectedConflicts(cached.deps, deps);
    if (conflicts.length && !allowDiffDeps) {
      throw new Error('mountUpload: 同一个 db 句柄上**第二次挂载传了与创建时不同的注入项** —— ' +
        '拒绝复用已经建好的上报器（E48②·补修②，复核 C·26②）：' +
        conflicts.map(k => '本次传入的 ' + k + ' 与创建时不是同一个实例 ⇒ 拒绝复用').join('；') +
        '。这六项注入**无法按值比较**（函数／句柄），「沿用旧实例」会真的发错：旧 `now` ⇒ 本次的' +
        '时间戳／留痕落在**旧时钟**的时刻；旧 `bus` ⇒ 本次挂载的订阅者**一条 `upload` 事件都收不到**；' +
        '旧 `fetch` ⇒ 本次的发送实现不被采纳。三种正当做法：①传**同一个**实例（引用相同）；' +
        '②显式注入 deps.reporter（自建实例，本入口只看注入项、不查池）；③确实要沿用旧实例并接受' +
        '「本次注入不生效」：显式 `allowReuseWithDifferentDeps: true`（此时降级为**逐项点名 ＋ ' +
        'logger.warn 告警**，并且该降级事实会回在 `reporterDepsConflict` 上）。');
    }
    const ignored = conflicts;
    /* ---- ③配置相同、注入项相同（或已显式 opt-in）⇒ 带日志复用（`E48②`） ---- */
    const logLine = '[上报] 复用同一 db 句柄上已建的上报器实例（E48②：行为指纹相同 ' +
      fingerprintTag(fingerprint) + '）' +
      (ignored.length
        ? '；**allowReuseWithDifferentDeps 已显式开启**：本次传入的 ' + ignored.join('/') +
          ' 与创建时不是同一个实例，**不会被采纳**（实例已建好）—— 这是被**显式允许**的降级，不是默认路径'
        : '');
    if (ignored.length) {
      /* 降级路径的告警打到**两边**：本次调用方的 logger（它看得见）＋ 实例实际用的 logger（它写日志）。
         一个 logger 都没有时也不静默：事实仍在返回值 `reporterIgnoredDeps`／`reporterDepsConflict` 上。 */
      const sinks = [deps.logger, cached.deps.logger].filter((l, i, arr) =>
        l && typeof l.warn === 'function' && arr.indexOf(l) === i);
      for (const l of sinks) l.warn(logLine);
    } else if (deps.logger && typeof deps.logger.info === 'function') {
      /* 配置与注入项都相同 ⇒ 普通复用：日志走**本次**传入的 logger；若本次没传 logger，
         同一事实仍可从 `mountUpload()` 的返回值 `reporterSource:'reused'` 读到（不静默）。 */
      deps.logger.info(logLine);
    }
    return {
      reporter: cached.reporter, source: 'reused', fingerprint, ignored,
      depsConflict: ignored.length ? 'allowed-by-opt-in' : 'none'
    };
  }
  const created = createUploadReporter({
    db,
    logger: deps.logger || null,
    now: deps.now,
    config: deps.config,
    fetch: deps.fetch,
    queue: deps.queue,
    serviceName: deps.serviceName,
    methodName: deps.methodName,
    capacity: deps.capacity,
    warnThreshold: deps.warnThreshold,
    timeoutMs: deps.timeoutMs,
    /* 补修②：`strict` 与 `idGenerator` 原来经本函数**被静默丢弃**（复核 `C·26②` 顺带实测到）
       —— 现在**转发**（要"不支持"就明说，不许丢）：`strict` 进了指纹，`idGenerator` 进了注入判据。 */
    strict: deps.strict,
    idGenerator: deps.idGenerator,
    /* W5-①：事件总线透传（`upload` 事件在待补传队列的真实状态迁移点发布） */
    bus: deps.bus
  });
  const entry = {
    reporter: created,
    fingerprint,
    parts,
    /* 创建时**实际用到的引用**（供复用时逐项判"本次注入项是否与创建时同一实例"） */
    deps: depsSnapshot(deps)
  };
  if (db) pool.byDb.set(db, entry); else pool.nullDb = entry;
  return { reporter: created, source: 'created', fingerprint, ignored: [], depsConflict: 'none' };
}

/** 取（或惰性创建）上报器实例 —— `E48` 之前的**公开形状保持不变**（只返回实例本身）。 */
function resolveReporter(deps = {}) {
  return resolveReporterDetail(deps).reporter;
}

/** 查询串解析（只支持 `?k=v&k2=v2` 这一层，够本端点的 `limit` / `ids` 用；不引第三方解析器） */
function queryOf(req) {
  const raw = req && req.url ? String(req.url) : '';
  const i = raw.indexOf('?');
  if (i < 0) return {};
  const out = {};
  for (const part of raw.slice(i + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const v = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

/** 入参校验：`limit` 必须是正整数；`ids` 必须是字符串数组（逗号分隔或数组）。非法 ⇒ 抛 400。 */
function normalizeRetryInput(body) {
  const out = {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('请求体必须是 JSON 对象（可空体 ＝ 重报全部待补传）');
    err.status = 400; err.code = 'BAD_BODY'; err.field = '(body)';
    throw err;
  }
  if (body.limit !== undefined && body.limit !== null && body.limit !== '') {
    const n = Number(body.limit);
    if (!Number.isInteger(n) || n < 1) {
      const err = new Error(`limit 必须是 ≥ 1 的整数，收到 ${JSON.stringify(body.limit)}`);
      err.status = 400; err.code = 'BAD_VALUE'; err.field = 'limit';
      throw err;
    }
    out.limit = n;
  }
  if (body.ids !== undefined && body.ids !== null && body.ids !== '') {
    const arr = Array.isArray(body.ids) ? body.ids : String(body.ids).split(',');
    const ids = arr.map(s => String(s).trim()).filter(Boolean);
    if (!ids.length) {
      const err = new Error('ids 不能是空数组/空串（要重报全部请传空体或省略该键）');
      err.status = 400; err.code = 'BAD_VALUE'; err.field = 'ids';
      throw err;
    }
    out.ids = ids;
  }
  return out;
}

/** 未接库/未接上报器时的稳定错误体（装配问题，不是报文问题） */
function noServiceBody(path, method) {
  return Object.assign({
    ok: false, mount: 'upload', mounted: false, path, method,
    note: '上报服务未装配（缺少 SQLite 句柄或显式注入的上报器）'
  }, errorBody('NO_SERVICE', '上传/重报服务未装配：既没有 db 也没有注入 reporter', 503));
}

/** 入参非法的 400 响应体（统一 `err` 形状 + `ok:false` + 机器可读的 `field`）。
 *  为什么不直接用 `router.fail()`：它只给 `{err,path,method,extra}`，**没有 `ok:false`** ——
 *  而本模块的成功/跳过/失败响应一律带 `ok`，缺了它前端得靠"有没有 err"分支，形状不齐。
 *  `field` 照 `routes/ifA.js` 的 `rejectBody()` 放在**顶层**（与 `POST /ifd|/ifa/*` 的 400 同形）。 */
function badInputBody(err, path, method) {
  const status = Number(err && err.status) || 400;
  const b = errorBody((err && err.code) || 'BAD_VALUE', (err && err.message) || '入参非法', status);
  return Object.assign({
    ok: false, mount: 'upload', path, method,
    field: (err && err.field) || null
  }, b);
}

/**
 * **非回环来源**的 403 响应体（E87 / 方案 b）。形状与既有错误体一致：机器可读 `err.code`
 * ＋ 顶层 `ok:false`（本模块成功/跳过/失败一律带 `ok`，见上方 `badInputBody()` 的说明）
 * ＋ 顶层 `error`（与 `/auth/*`、`/notice` 的 `error` 同一词形 `not_loopback`，两种读者都能读）。
 *
 * **留痕口径＝只 `warn`，不写 `op_log`**（本包的选择，理由三条，均可核查）：
 *   ① `server/repo/opLog.js:91-92` 明写"**未解锁场景不该写日志**，故这里不设缺省班组" ——
 *      本包按裁定**没有登录闸** ⇒ 非回环来源连"本机会话"都不成立，正属"未解锁场景"；
 *   ② `/notice` 的先例（`routes/notice.js:24-25`）已把"**未过鉴权闸**的拒绝"排除在留痕之外
 *      （那里的 401 只 warn）；本包的 403 发生在**任何身份成立之前**，与那一支同类，
 *      而**不是**与"过了鉴权闸的 `403 not_loopback`"同类（那需要先有有效会话）；
 *   ③ 防"给未认证方一个落盘写原语"：E87 的暴露面正是"**LAN 内任意主机**"，若每条 403 都写
 *      一条 `op_log`，任何局域网主机都能反复触发数据库写入（审计表膨胀／淹没真正的留痕），
 *      与"把暴露收掉"的目标相悖。
 * **不静默**：调用方同时打一条 `logger.warn`（含来源、时刻、被拒原因），并在挂载对象的
 * `counters.forbidden` 上计数（供探针与巡检读取；**不进任何 HTTP 响应体**，前端与契约不动）。
 * @param {string} path 请求路径
 * @param {string} method HTTP 方法
 * @param {string} remote 来源地址（`remoteOf()` 的结果；空串＝读不到，**按非回环从严**）
 * @param {string} at 本次判定的时刻（注入时钟给出，DR-16 格式）
 */
function forbiddenBody(path, method, remote, at) {
  const b = errorBody('not_loopback',
    `人工重报（${method} ${path}）只允许来自本机回环（127.0.0.1 / ::1 / ::ffff:127.0.0.1），` +
    `实际来源 ${remote || '(未知)'} —— 已拒绝：**未读取请求体、未调用 reporter.retryPending()**，` +
    '一条报文都没有发出（E87 / 2026-10-02 负责人裁定方案 b）', 403);
  return Object.assign({
    ok: false, mount: 'upload', path, method,
    error: 'not_loopback', remote: remote || null, at
  }, b);
}

/**
 * 挂载 IF-B 上报的 HTTP 面。
 * @param {object} router `server/http/router.js` 的 createRouter() 产物
 * `config` 是**必填**（`E48③`，见模块头）：创建路径缺它直接抛；**只有**显式注入 `reporter` 的那条
 *          路径才允许不传（实例由调用方自建自持）。装配点见 `server/index.js` 的 `boardCfg`。
 * @param {{db?:object, reporter?:object, logger?:object, now?:Function, config:object,
 *          fetch?:Function, queue?:object, serviceName?:string, methodName?:string,
 *          capacity?:number, warnThreshold?:number, timeoutMs?:number, strict?:boolean,
 *          idGenerator?:object, bus?:object, allowReuseWithDifferentDeps?:boolean,
 *          isLoopback?:Function, remoteOf?:Function}} [deps]
 *          `isLoopback`/`remoteOf` 是**判据注入口**（缺省＝上面的真源）：只为自检能把来源伪造为
 *          非回环地址而设，**不给生产接线用**（`server/index.js` 不传这两项）。这两项是**每次挂载
 *          各自生效**的（本函数内取用），故第二次挂载传不同的判据**不会**触发下面的注入冲突。
 *          `strict`/`idGenerator`（补修②）：过去经本入口会**被静默丢弃**，现在**转发**并纳入
 *          指纹／注入判据（`strict` 布尔进指纹；`idGenerator` 是句柄 ⇒ 换了必须显式 opt-in）。
 *          `allowReuseWithDifferentDeps`（补修②）：**默认 false** ⇒ 同库第二次挂载若传了与创建时
 *          不同的 `logger`/`now`/`fetch`/`queue`/`bus`/`idGenerator`，**直接抛错并逐项指名**；
 *          显式置 `true` 才降级为"逐项点名 ＋ `logger.warn` 告警"（`reporterDepsConflict` 上可见）。
 * @returns {{mount:'upload', mounted:boolean, by:'W4', routes:string[], instance:object|null,
 *          reporterSource:'injected'|'created'|'reused'|'none', reporterFingerprint:string|null,
 *          reporterIgnoredDeps:string[], reporterDepsConflict:'n/a'|'none'|'allowed-by-opt-in',
 *          counters:object, status:Function}}
 *          `mounted:true` 才是"已接线"的**显式**状态（与 W6 空壳 `router.mountUpload()` 的
 *          `mounted:false` 形成可核查对照，D23 反静默空转）。
 */
function mountUpload(router, deps = {}) {
  if (!router || typeof router.post !== 'function' || typeof router.get !== 'function') {
    throw new TypeError('mountUpload: 必须传入 server/http/router.js 的 router（缺少 post/get）');
  }
  const routes = [];
  const logger = deps.logger || null;
  /* `E48`：实例来源要**显式**（`injected`／`created`／`reused`／`none`）—— 复用是允许的，但必须
     能被看见：旧写法"命中即复用"在多实例装配下会把**第一个实例的配置快照**（地址／阈值／回执
     风格）静默套到第二次挂载上，现场表现为"上报打到旧地址"且**不报错**。 */
  const resolved = (deps.reporter || deps.db)
    ? resolveReporterDetail(deps)
    : { reporter: null, source: 'none', fingerprint: null, ignored: [], depsConflict: 'n/a' };
  const reporter = resolved.reporter;
  /* 判据注入口（自检用）：缺省一律走**真源**，不另造判定 */
  const isLoopbackOf = typeof deps.isLoopback === 'function' ? deps.isLoopback : isLoopback;
  const remoteOfReq = typeof deps.remoteOf === 'function' ? deps.remoteOf : remoteOf;
  /* 时刻出口（ADR-0003 D17：不裸用 `new Date()`）；缺省＝platform/clock 真实时钟，与 `notice.js` 同款 */
  const nowFn = typeof deps.now === 'function'
    ? deps.now
    : platformClock.createClock({ mode: 'real' }).source();
  const atNow = () => platformClock.fmt(nowFn());
  /** 计数（可读、可断言；**不落库**、也不进任何 HTTP 响应体 —— 留痕口径见 `forbiddenBody()`）：
   *  `retryHandled` ＝ 已过来源校验、**进入发送步骤**的请求数（非回环被拒时它必然是 0，
   *  这正是"不发送"的结构性证据之一；发送次数的权威读数由探针在 `reporter` 桩上计数）。 */
  const counters = { retryHandled: 0, forbidden: 0 };

  /* ---- ① 待补传清单（UI-20 的主数据源） ---- */
  router.get('/upload/pending', (req, res) => {
    if (!reporter) return router.json(res, 503, noServiceBody('/upload/pending', 'GET'));
    const query = queryOf(req);
    const limit = query.limit === undefined || query.limit === '' ? undefined : Number(query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return router.fail(res, 400, 'BAD_VALUE', `limit 必须是 ≥ 1 的整数，收到 ${JSON.stringify(query.limit)}`,
        { path: '/upload/pending', method: 'GET', field: 'limit' });
    }
    const items = reporter.listPending({ limit });
    const st = reporter.status();
    return router.json(res, 200, {
      ok: true, mount: 'upload', path: '/upload/pending',
      count: st.pendingCount,
      pendingOnly: st.pendingOnly,
      failedAfterRetry: st.failedAfterRetry,
      capacity: st.capacity,
      warnThreshold: st.warnThreshold,
      overflow: st.pendingCount >= st.capacity,
      alert: st.alert,
      items
    });
  });
  routes.push('GET /upload/pending');

  /* ---- ② 上报状态（配置 / 队列 / 13 字段来源 / 最近一次 / 不做自动重试的显式声明） ---- */
  router.get('/upload/status', (req, res) => {
    if (!reporter) return router.json(res, 503, noServiceBody('/upload/status', 'GET'));
    return router.json(res, 200, Object.assign(reporter.status(), { routes }));
  });
  routes.push('GET /upload/status');

  /* ---- ③ 最近一次组装的报文（人工核对"到底要报什么"；不发送、不落库） ---- */
  router.get('/upload/last', (req, res) => {
    if (!reporter) return router.json(res, 503, noServiceBody('/upload/last', 'GET'));
    const built = reporter.buildReport({});
    if (!built.ok) {
      return router.json(res, 200, {
        ok: false, mount: 'upload', path: '/upload/last',
        available: false, error: built.error,
        note: '当前无法组装报文（原因见 error）；本端点**只读不发送**'
      });
    }
    return router.json(res, 200, {
      ok: true, mount: 'upload', path: '/upload/last', available: true,
      fields: built.fields, missing: built.missing, collectTimeFallback: built.collectTimeFallback,
      frameId: built.frameId, standardVersionNo: built.standardVersionNo,
      url: built.url, body: built.body,
      note: '本端点只组装、不发送（**不做自动上报**）；发送只在 POST /upload/retry（人工）与后续周期接线里发生'
    });
  });
  routes.push('GET /upload/last');

  /* ---- ④ 人工一键重报（**唯一**会再次发送待补传报文的入口；按序 + 幂等） ----
     **E87 来源校验在第一位**：非回环来源**在读请求体之前**就被拒（403），
     因而"读体/校验入参/调用 `retryPending()`"这三步一步都不会走到（"一条都不发"由此在结构上成立）。 */
  router.post('/upload/retry', async (req, res) => {
    /* ---- ⓪ 来源校验（E87 / 方案 b）：非回环 ⇒ 403，**绝不调用 reporter.retryPending()** ---- */
    const remote = remoteOfReq(req);
    if (!isLoopbackOf(remote)) {
      counters.forbidden++;
      const at = atNow();
      if (logger) {
        logger.warn(`[上报] 人工重报被拒（非回环来源）：${remote || '(未知)'} 于 ${at} 请求 POST /upload/retry` +
          ' —— 未读请求体、未调用 retryPending()（**一条报文都没发**）；' +
          '留痕口径＝只 warn 不写 op_log（理由见 routes/upload.js 的 forbiddenBody()）');
      }
      return router.json(res, 403, forbiddenBody('/upload/retry', 'POST', remote, at));
    }
    if (!reporter) return router.json(res, 503, noServiceBody('/upload/retry', 'POST'));
    /* 读体：坏 JSON ⇒ 400、超限 ⇒ 413（router 的统一口径；空体 ＝ 重报全部待补传） */
    const body = await router.readJson(req);
    let input;
    try {
      input = normalizeRetryInput(body);
    } catch (err) {
      return router.json(res, err.status || 400, badInputBody(err, '/upload/retry', 'POST'));
    }
    counters.retryHandled++;
    const r = await reporter.retryPending(input);
    return router.json(res, 200, Object.assign({ mount: 'upload', path: '/upload/retry', method: 'POST' }, r));
  });
  routes.push('POST /upload/retry');

  return {
    mount: 'upload',
    mounted: Boolean(reporter),
    by: 'W4',
    routes,
    instance: reporter,
    /* `E48`：实例来源显式化 —— `injected`（显式注入，装配方自持）／`created`（本次新建）／
       `reused`（复用同库已建实例：**行为指纹相同** ＋ 注入项相同；日志里已如实说明）／`none`（未装配）。
       补修②：`allowReuseWithDifferentDeps: true` 下复用可以"注入项不同"，这一降级事实不在日志里
       藏着 —— `reporterIgnoredDeps`（哪些注入项没被采纳）＋ `reporterDepsConflict`
       （`n/a` 未装配／`none` 无冲突／`allowed-by-opt-in` 显式放行）两处都能读到。 */
    reporterSource: resolved.source,
    reporterFingerprint: resolved.fingerprint,
    reporterIgnoredDeps: resolved.ignored,
    reporterDepsConflict: resolved.depsConflict,
    /** 来源校验的计数（E87；供自检/巡检读取，**不进 HTTP 响应体**） */
    counters,
    status: () => (reporter ? reporter.status() : { mounted: false, by: 'W4', routes })
  };
}

module.exports = { mountUpload, resolveReporter, resolveReporterDetail, normalizeRetryInput, queryOf };
