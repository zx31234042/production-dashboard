/* ==========================================================================
   公告信息仓储（server/repo/notice.js）—— DR-10（`notice` 表）的**唯一写入口**与只读口
   作用：把 `FR-7.12`（P0「仅本机解锁后可新增/编辑/删除公告」）的三个动作落到 `notice` 表，
         并在**同一个事务里**写一条 `op_log`（DR-12 留痕）；
         另给两个读口：`list()`（库行原样）与 `listForBoard()`（**前端 `state.notices` 同形**，
         供 `GET /state` 快照与 `POST /notice` 的响应共用 —— 两处同源，不写第二份投影）。
   依据（负责人 2026-10-02 裁定 + 登记在 `项目记录\ADR\ADR-0009-库表写入链路与真源口径.md`）：
     · 需求 `需求文档\…-V1.43.md:547`：**FR-7.12（P0）**「仅本机解锁后可新增/编辑/删除公告」；
       「操作记录保留」的依据＝`FR-8.7`／`NFR-15`／`DR-12`；
       `FR-7.11`（:546，有效期与优先级、滚动/分页轮播）是 **P1**，**轮播仍不做**（技术债 `E3`）。
     · `ADR-0009` D5：**不改 `schema.sql`、不新增列** ⇒ 本模块只用 `notice` 表**已有**的 10 列
       （`id / category / sub_type / content / valid_from / valid_to / priority / created_by /
       created_at / updated_at`），一行 DDL 都不加。
   依赖：`server/repo/opLog.js`（**留痕的唯一写入口**，本模块不自己拼 INSERT INTO op_log）、
         传入的 db 句柄。**零第三方依赖**；**不 requires 任何 services/**（避免与装配层成环）。
   ------------------------------------------------------------------------------------------
   【删除口径 = **硬删 ＋ 原文进 `op_log`**（为什么这么定，必读）】
   `notice` 表**没有**（也不许新增）"已删除"标志列；可用的 `valid_to` 是 **DR-10 的有效期列**
   （`FR-7.11` 的语义：公告在有效期内生效），拿它当"软删标志"＝**改语义**、会让日后 `FR-7.11`
   的有效期过滤把"已删除"读成"过期"，两种事实混成一个 —— 故**不采用**软删。改为：
     · **物理删除**该行（`DELETE FROM notice WHERE id = ?`）；
     · 删除**之前**把整行读出来，把**原文**（`content` 全文 ＋ 类型 ＋ 发布时刻 ＋ 创建人）写进
       `op_log.content`（`op_type='公告删除'`、`result='成功'`）—— 留痕表就是"删了什么"的凭据，
       `FR-8.7`／`NFR-15`／`DR-12` 要的"操作记录保留"由此成立（**不是**靠把已删数据留在业务表里）。
     · 留痕正文超长时**显式**标注 `…（原文超长已截断）`（不静默丢信息；上限真源＝
       `opLog.CONTENT_MAX`）—— ⚠ 该截断是**已知边界**：`notice.content` 与 `op_log.content`
       同宽（均 500），而删除留痕还要装类型/时刻等头部 ⇒ 接近上限的长公告在留痕里只能留前段。
   【同批 ＝ 同一事务】三个动作都是 `BEGIN → 表写入 → op_log 追加 → COMMIT`：
   表要么与它的留痕一起生效，要么一起不生效（"改了但没留痕"是不允许出现的中间态）。
   【时区/时间】全部时间列都是 DR-16 的 `yyyy-MM-dd HH:mm:ss` 文本，**由调用方注入时钟给出**
   （`ctx.now`）—— 本文件**不出现** `new Date()` / `Date.now()`（ADR-0003 D17）。
   【未自述边界（如实登记，读前必知；技术债 `E88⒠`）】
    · ① **`op_log` 留痕不是永久的 —— 它受 `DR-14` 保留策略裁剪**：裁剪目标表清单**含 `op_log`**
      （真源＝`server/db/maintain.js:327`，按 `op_time` 判老；保留期＝同文件 `:277` 的
      `RETENTION_DAYS = 365`，即 **1 年**），删除动作由该文件的 `applyRetention()`（`:297`）执行。
      **读者须知**：审计口径下**留痕有寿命** —— 拿 `op_log` 反查"这条公告当年被谁怎么改过"，
      其地平线是**保留策略（1 年）**而不是永久；又因 `notice` 走**硬删**（见上「删除口径」）⇒
      裁剪一旦执行，超过保留期的被删公告原文就**不再存在于任何一张表**（本模块没有第二份副本）。
      **该裁剪的自动调度已就位**（技术债 `E89` 于 **2026-10-03 落地**）：`server/index.js` 的 1 s 采样
      tick（`onSampledTick()` 第③拍）调 `runDailyRetention()`，按**跨自然日**触发上面的
      `applyRetention()` —— **不新增定时器**（ADR-0009 D3①）、进程内每自然日 1 次（失败也不重扫），
      可观测出口＝`/health.retentionWrite`（`runs`／`failures`／`lastRunDay`／`lastCutoff`／`deleted`，
      读口＝`GET /health`）；`tests/db-check.js` 的直调仍在，但**已不是唯一调用方**。
      **留痕寿命仍是 `DR-14` 的 1 年**，且裁剪只在**日切那一刻**真的发生 ⇒ 别把"1 年后一定没了"
      读成"现在已经被清过"。
    · ② **`listForBoard()` 的投影有上限（`BOARD_LIMIT = 50`），且截断是静默的**：`BOARD_LIMIT`
      （本文件「一、口径常量」的常量，当前值 **50**）是 `list()` 与 `listForBoard()` 的缺省
      `LIMIT`；库内公告多于 50 条时**不报错、不告警、也不返回 `truncated` / `total` 之类的
      指示键**，只按 `ORDER_SQL` 取前 50 行（priority 大者、再 `valid_from` 新者优先）**再**按
      `category` 分进 `notices` / `tips` ⇒ 该投影的两列**合计最多 50 行**（不是每列各 50）。
      **读者须知**：界面上的公告条数**不等于**库内总数 —— 审计／对账时须另取本文件已导出的
      `count()`（`SELECT COUNT(*)`）自行核对总数，**不得**把投影条数当成库内条数，
      也不得据此断言"公告只有这些"。
   ========================================================================== */
'use strict';

const opLogRepo = require('./opLog');

/* ---------------- 一、口径常量 ---------------- */

/** 时间格式：真源＝`repo/opLog.js` 的 `TIME_RE`（同层共用一把尺子，不另写第二份正则） */
const TIME_RE = opLogRepo.TIME_RE;

/** `notice.category` 的取值（`schema.sql` 的注释：车间公告/工艺提示/待办提醒）。
 *  本模块只把 **工艺提示** 单独分出去（前端 `state.notices.tips` 是另一张列表），其余一律进
 *  `notices`（前端 `notices` 与 `tips` 的行形状都是 `{tag,text,...}`，故不会渲染不出来）。 */
const CATEGORY = Object.freeze({
  NOTICE: '车间公告',
  TIP: '工艺提示',
  TODO: '待办提醒'
});

/** 三个动作的机器可读名（`POST /notice` 的 `action` 取值；路由与仓储共用同一份，避免拼错） */
const ACTION = Object.freeze({ PUBLISH: 'publish', EDIT: 'edit', DELETE: 'delete' });

/** `op_log.op_type` 的**本模块词形**：DR-10 的三个动作各一条，另加一条"写入被拒"。
 *  为什么不加进 `repo/opLog.js` 的 `OP_TYPE` 约定表：那个表是**别的包的文件边界**
 *  （先例＝`services/auth.js` 第 76～86 行，同样在本文件内固定词形并保持稳定）。 */
const OP_TYPE = Object.freeze({
  PUBLISH: '公告发布',
  EDIT: '公告编辑',
  DELETE: '公告删除',
  REJECT: '公告写入拒绝'
});

/** 文本上限：`content` 与 `op_log.content` 同宽（删除留痕要尽量装下原文，见文件头） */
const CONTENT_MAX = opLogRepo.CONTENT_MAX;   // 500
const TEXT_MAX = opLogRepo.TEXT_MAX;         // 200（category / sub_type / created_by）
/** 优先级上限（只有下界 0 是硬的：schema 的 `DEFAULT 0`；上界只为挡住明显的脏值） */
const PRIORITY_MAX = 9999;
/** 读口的条数上限（默认）—— 前端演示期每类列表只显示 6 条，服务端给一个更宽的默认值，
 *  并把 limit 留在调用方（快照与路由响应都用同一个默认，避免两处不一致）。 */
const BOARD_LIMIT = 50;

/* ---------------- 二、入参校验（纯函数，可逐条断言） ---------------- */

/** 校验 DR-16 时间文本 */
function assertTime(value, field) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new TypeError(
      `notice: ${field} 必须是「yyyy-MM-dd HH:mm:ss」（DR-16，19 字符），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 必填非空文本 + 上限（超长**拒收**，不截断 —— 截断会静默改变业务内容） */
function assertText(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`notice: ${field} 不能为空（收到 ${JSON.stringify(value)}）`);
  }
  const s = value.trim();
  if (s.length > max) throw new RangeError(`notice: ${field} 长度 ${s.length} 超过上限 ${max}`);
  return s;
}

/** 可选文本：空/缺 ⇒ null（"没写"与"空串"分得开），非空则校验上限 */
function textOrNull(value, field, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new RangeError(`notice: ${field} 长度 ${s.length} 超过上限 ${max}`);
  return s;
}

/** 公告正文（必填；上限＝`op_log.content` 同宽） */
function assertContent(value) {
  return assertText(value, 'content', CONTENT_MAX);
}

/** 优先级：整数 0～`PRIORITY_MAX`；缺省 0（与 schema 的 `DEFAULT 0` 同值） */
function priorityOf(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > PRIORITY_MAX) {
    throw new RangeError(`notice: priority 必须是 0～${PRIORITY_MAX} 的整数，收到 ${JSON.stringify(value)}`);
  }
  return n;
}

/** 主键：正整数（拒收 0/负数/小数/非数值 —— 不归一、不猜） */
function idOf(value) {
  const n = (typeof value === 'string' && /^\d+$/.test(value.trim())) ? Number(value.trim()) : value;
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError(`notice: id 必须是 ≥ 1 的整数，收到 ${JSON.stringify(value)}`);
  }
  return n;
}

/** 取调用上下文：`now` 必填（DR-16，注入时钟给出）；`operator`/`teamCode` 缺省 null（**不猜**） */
function contextOf(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const at = assertTime(c.now, 'now');
  return {
    at,
    operator: textOrNull(c.operator, 'operator', TEXT_MAX),
    /* 班组编号：与 `FR-1.6` 同一真源（当前生效班次的班组），**由调用方给**——
       `repo/opLog.js` 的文件头明写"本模块只负责把调用方给的值落库"。 */
    teamCode: textOrNull(c.teamCode, 'teamCode', TEXT_MAX)
  };
}

/* ---------------- 三、留痕正文（显式截断，不静默丢信息） ---------------- */

/**
 * 拼 `op_log.content`：`<头部>：<明细>`；超长时截断明细并**显式**标注。
 * @param {string} head 头部（短、必留）
 * @param {string} detail 明细（可能很长，如公告原文）
 */
function auditContent(head, detail) {
  const max = opLogRepo.CONTENT_MAX;
  const h = String(head);
  if (h.length >= max) return h.slice(0, max);
  const room = max - h.length - 1;                 // 1 ＝ 分隔符「：」
  const d = String(detail === undefined || detail === null ? '' : detail);
  if (d.length <= room) return `${h}：${d}`;
  const tail = '…（原文超长已截断）';
  return `${h}：${d.slice(0, Math.max(0, room - tail.length))}${tail}`;
}

/* ---------------- 四、读口 ---------------- */

/** 库行 → 前端 `state.notices` 的**行形状**（`NoticePanel` 读 `tag`/`text`/`lv`/`time`）。
 *  · `tag`  ← `sub_type`（公告类型：生产调整/工艺变更/…；`#noticeType` 的取值）优先，缺则退 `category`；
 *  · `text` ← `content`（**原样**，转义由渲染层做 —— `NoticePanel` 用 `esc()`）；
 *  · `lv`   ← 恒 `'info'`：DR-10 **没有等级列** ⇒ 不编造等级（前端演示期的 lv 是演示数据）；
 *  · `time` ← `valid_from`（发布即生效）优先，缺则 `created_at`，取 `HH:MM`；
 *  · `id`   ← 主键（前端 `FR-7.12` 的编辑/删除入口要靠它指到具体某条；演示期无此键，故前端按缺失容错）。 */
function rowToItem(row) {
  const stamp = row.valid_from || row.created_at || '';
  const m = /(\d{2}):(\d{2})/.exec(String(stamp));
  return {
    id: Number(row.id),
    tag: row.sub_type || row.category,
    text: row.content,
    lv: 'info',
    time: m ? `${m[1]}:${m[2]}` : ''
  };
}

/** 公告展示**优先序**（`FR-7.11` 的优先级列已就位）：priority 大者在前，再按发布时刻新者在前。 */
const ORDER_SQL = 'ORDER BY priority DESC, valid_from DESC, id DESC';

/** 读库行（原样列名，供审计/探针核对；`FR-7.11` 的有效期过滤**未实现**＝P1，本读口不筛有效期） */
function list(db, query = {}, options = {}) {
  if (!db) return [];
  const where = [];
  const args = [];
  if (query.category) { where.push('category = ?'); args.push(String(query.category)); }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : BOARD_LIMIT;
  return db.prepare(
    `SELECT * FROM notice${where.length ? ' WHERE ' + where.join(' AND ') : ''} ${ORDER_SQL} LIMIT ?`
  ).all(...args, limit);
}

/** 单行（按主键）；不存在 ⇒ null（调用方据此回 `not_found`，**不猜**） */
function getById(db, id) {
  if (!db) return null;
  return db.prepare('SELECT * FROM notice WHERE id = ?').get(Number(id)) || null;
}

/** 全表行数（探针/巡检对账用） */
function count(db) {
  if (!db) return 0;
  return db.prepare('SELECT COUNT(*) AS c FROM notice').get().c;
}

/**
 * **前端 `state.notices` 同形的读口**（`GET /state` 快照与 `POST /notice` 响应共用，只此一份投影）。
 * @param {object} db
 * @param {{limit?:number}} [options]
 * @returns {{notices:Array<object>, tips:Array<object>, todo:Array<object>}}
 *   `todo` **恒为空数组**：前端 `todo` 的行形状是 `{name,value,unit,lv}` 的**派生量**
 *   （待复检件数 / 待维保 / 未闭环异常 / 队列深度），`DR-10` 表里没有这些数、也不该由公告表承担
 *   ⇒ 走前端既有空态（`UI-11` 的「暂无待办事项」），**不造数**。
 */
function listForBoard(db, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : BOARD_LIMIT;
  const rows = db ? list(db, {}, { limit }) : [];
  const notices = [];
  const tips = [];
  for (const row of rows) {
    if (row.category === CATEGORY.TIP) tips.push(rowToItem(row)); else notices.push(rowToItem(row));
  }
  return { notices, tips, todo: [] };
}

/* ---------------- 五、唯一写入口（三个动作；每个都在同一事务里写 op_log） ---------------- */

const INSERT_SQL =
  `INSERT INTO notice(category, sub_type, content, valid_from, valid_to, priority, created_by,
                      created_at, updated_at)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** 事务包装：`BEGIN → body() → COMMIT`；body 抛错即 `ROLLBACK` 并把原错抛出去（不吞不掩） */
function inTransaction(db, body) {
  db.exec('BEGIN');
  try {
    const out = body();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误 */ }
    throw err;
  }
}

/** 留痕追加（同事务内调用）。`opTime`＝业务动作时刻（注入时钟），与 `created_at` 同一把尺子。 */
function audit(db, ctx, opType, content, result) {
  return opLogRepo.append(db, {
    opTime: ctx.at,
    operator: ctx.operator,
    opType,
    content,
    result,
    teamCode: ctx.teamCode
  }, ctx.at);
}

/**
 * **发布**一条公告（新增）。
 * @param {object} db
 * @param {{category?:string, subType?:string, content:string, validFrom?:string, validTo?:string,
 *          priority?:number, createdBy?:string}} input
 * @param {{now:string, operator?:string, teamCode?:string}} ctx 注入时钟给出的 DR-16 时刻 ＋ 留痕身份
 * @returns {{ok:true, action:'publish', id:number, opType:string, opLogId:number|null, row:object}}
 *   `validFrom` 缺省＝`now`（**发布即生效**，与 `FR-7.11` 的"有效期"语义一致；不是编造数据：
 *   "这一刻发布的公告自这一刻生效"）；`validTo` 缺省 null（长期有效，等待 `FR-7.11` 的 P1 口径）。
 *   ⚠ `FR-7.11` 的**有效期过滤与滚动/分页轮播未实现**（P1／技术债 `E3`）—— 这两列只是如实落库。
 */
function publish(db, input, ctx) {
  if (!db) throw new Error('notice.publish: 缺少 db 句柄（调用方应先判空并回 503）');
  const c = contextOf(ctx);
  const row = {
    category: textOrNull(input && input.category, 'category', TEXT_MAX) || CATEGORY.NOTICE,
    subType: textOrNull(input && input.subType, 'subType', TEXT_MAX),
    content: assertContent(input && input.content),
    validFrom: (input && input.validFrom) ? assertTime(input.validFrom, 'validFrom') : c.at,
    validTo: (input && input.validTo) ? assertTime(input.validTo, 'validTo') : null,
    priority: priorityOf(input && input.priority),
    createdBy: textOrNull((input && input.createdBy) || c.operator, 'createdBy', TEXT_MAX)
  };
  return inTransaction(db, () => {
    const r = db.prepare(INSERT_SQL).run(
      row.category, row.subType, row.content, row.validFrom, row.validTo, row.priority,
      row.createdBy, c.at, c.at);
    const id = Number(r.lastInsertRowid);
    const logged = audit(db, c, OP_TYPE.PUBLISH,
      auditContent(`公告 #${id} 发布（${row.subType || row.category}｜优先级 ${row.priority}）`, row.content),
      opLogRepo.RESULT.SUCCESS);
    return {
      ok: true, action: ACTION.PUBLISH, id, opType: OP_TYPE.PUBLISH,
      opLogId: logged ? logged.id : null, row: getById(db, id)
    };
  });
}

/** 字段名（库列）→ 中文名，仅用于留痕正文（**不参与任何逻辑判断**） */
const FIELD_CN = Object.freeze({
  category: '类目', sub_type: '公告类型', content: '内容',
  valid_from: '生效时刻', valid_to: '失效时刻', priority: '优先级'
});

/** 逐字段比较（库列名对库列名）→ 留痕用的人读变更清单；无变化 ⇒ 空数组 */
function changesOf(before, after) {
  const out = [];
  for (const col of Object.keys(FIELD_CN)) {
    const a = before[col] === undefined ? null : before[col];
    const b = after[col] === undefined ? null : after[col];
    if (a === b) continue;
    out.push(`${FIELD_CN[col]}「${a === null ? '（空）' : a}」→「${b === null ? '（空）' : b}」`);
  }
  return out;
}

const UPDATE_SQL =
  `UPDATE notice SET category = ?, sub_type = ?, content = ?, valid_from = ?, valid_to = ?,
                     priority = ?, updated_at = ?
    WHERE id = ?`;

/**
 * **编辑**一条公告（同一条**更新**，绝不新增行）。
 * 只改**显式给了**的字段（其余保留库内原值）；一个字段都没给 ⇒ `{ok:false, error:'no_change'}`
 * （不写库、不写留痕 —— "什么都没改"不是操作）。
 * `updated_at` 一律刷新为本动作时刻；`created_at` / `created_by` **不动**（那是"谁发布的"）。
 * @returns {{ok:true, id, opLogId, changed:string[], row:object}|{ok:false, error:'not_found'|'no_change', id}}
 */
function edit(db, input, ctx) {
  if (!db) throw new Error('notice.edit: 缺少 db 句柄（调用方应先判空并回 503）');
  const c = contextOf(ctx);
  const id = idOf(input && input.id);
  const before = getById(db, id);
  if (!before) return { ok: false, error: 'not_found', id, action: ACTION.EDIT };
  const given = key => input && Object.prototype.hasOwnProperty.call(input, key) &&
    input[key] !== undefined && input[key] !== null && input[key] !== '';
  const after = {
    category: given('category') ? (textOrNull(input.category, 'category', TEXT_MAX) || CATEGORY.NOTICE) : before.category,
    sub_type: given('subType') ? textOrNull(input.subType, 'subType', TEXT_MAX) : before.sub_type,
    content: given('content') ? assertContent(input.content) : before.content,
    valid_from: given('validFrom') ? assertTime(input.validFrom, 'validFrom') : before.valid_from,
    valid_to: given('validTo') ? assertTime(input.validTo, 'validTo') : before.valid_to,
    priority: given('priority') ? priorityOf(input.priority) : before.priority
  };
  const changed = changesOf(before, after);
  if (!changed.length) return { ok: false, error: 'no_change', id, action: ACTION.EDIT };
  return inTransaction(db, () => {
    db.prepare(UPDATE_SQL).run(after.category, after.sub_type, after.content, after.valid_from,
      after.valid_to, after.priority, c.at, id);
    const logged = audit(db, c, OP_TYPE.EDIT,
      auditContent(`公告 #${id} 编辑`, changed.join('；')), opLogRepo.RESULT.SUCCESS);
    return {
      ok: true, action: ACTION.EDIT, id, opType: OP_TYPE.EDIT,
      opLogId: logged ? logged.id : null, changed, row: getById(db, id)
    };
  });
}

/**
 * **删除**一条公告（**硬删 ＋ 原文进 `op_log`**，理由见文件头）。
 * @returns {{ok:true, id, opLogId, deleted:object}|{ok:false, error:'not_found', id}}
 *   `deleted` ＝ 删除**之前**那一行的原文（已在同一事务里进了留痕表；探针据此逐字核对）。
 */
function remove(db, input, ctx) {
  if (!db) throw new Error('notice.remove: 缺少 db 句柄（调用方应先判空并回 503）');
  const c = contextOf(ctx);
  const id = idOf(input && input.id);
  const before = getById(db, id);
  if (!before) return { ok: false, error: 'not_found', id, action: ACTION.DELETE };
  return inTransaction(db, () => {
    db.prepare('DELETE FROM notice WHERE id = ?').run(id);
    const logged = audit(db, c, OP_TYPE.DELETE,
      auditContent(`公告 #${id} 删除（${before.sub_type || before.category}）`,
        `公告原文：${before.content}；发布时刻=${before.created_at}；创建人=${before.created_by || '（未记）'}`),
      opLogRepo.RESULT.SUCCESS);
    return {
      ok: true, action: ACTION.DELETE, id, opType: OP_TYPE.DELETE,
      opLogId: logged ? logged.id : null, deleted: before
    };
  });
}

/**
 * **被拒写入的留痕**（`result='失败'`）：只在**已过鉴权闸**之后拒绝时调用（401 不写 —— 见路由文件头）。
 * 独立一条 INSERT（业务表一行没动，无需事务）；**不抛**：留痕写不进去不该把 400 变成 500，
 * 但**也不静默** —— 由调用方把 warn 打到日志（返回值带 `opLogId:null`）。
 * @returns {{id:number|null, error:string|null}}
 */
function auditReject(db, ctx, action, code, message) {
  if (!db) return { id: null, error: 'no_db' };
  const c = contextOf(ctx);
  const opType = action === ACTION.PUBLISH ? OP_TYPE.PUBLISH
    : action === ACTION.EDIT ? OP_TYPE.EDIT
      : action === ACTION.DELETE ? OP_TYPE.DELETE : OP_TYPE.REJECT;
  try {
    const r = audit(db, c, opType,
      auditContent(`公告写入被拒（action=${JSON.stringify(action === undefined ? null : action)}；${code}）`,
        message), opLogRepo.RESULT.FAILED);
    return { id: r ? r.id : null, error: null };
  } catch (err) {
    return { id: null, error: String((err && err.message) || err) };
  }
}

module.exports = {
  TIME_RE, CATEGORY, ACTION, OP_TYPE, CONTENT_MAX, TEXT_MAX, PRIORITY_MAX, BOARD_LIMIT,
  assertTime, assertText, textOrNull, assertContent, priorityOf, idOf, contextOf,
  auditContent, rowToItem,
  list, getById, count, listForBoard,
  publish, edit, remove, auditReject
};
