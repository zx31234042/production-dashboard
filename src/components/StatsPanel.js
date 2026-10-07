/* ==========================================================================
   组件：生产统计页（components/StatsPanel.js）
   需求：FR-4 当班任务统计 / 任务完成统计 / 质量质检统计 / 设备效率统计
   ========================================================================== */
window.Components = window.Components || {};
window.Components.StatsPanel = (function () {
  'use strict';

  const { setText, $ } = window.Dom;
  const F = window.Format;

  /* 两个新增承载位的 DOM id（集中在此，便于"只此一处"地对照 index.html）：
     · `EL_SOURCE_NOTE`＝`E197` 口径标注（标签后缀「（演示派生）」）；
     · `EL_FRAME_NOTE` ＝`E198` 帧缺件序号提示行。
     ⚠ 命名**刻意不以 `s` + 大写字母**开头：`tests/ui-check.js:1348` 用 `/id="(s[A-Z]\w*)"/`
       数"生产统计页 15 个指标位"，起名 `sXxx` 会把这个提示位也计入 ⇒ 那条既有断言会红
       （本包不得改断言 ⇒ 只能避开该命名形态；`c114` 前缀取自本轮需求登记号 `C-114`）。 */
  const EL_SOURCE_NOTE = 'c114StartedSource';
  const EL_FRAME_NOTE = 'c114FrameUnitNote';

  /* E38（★★，2026-09-27 真机验证查出）：**"无法计算"不得显示成"零产量"**。
     缺口帧里 `state.stats` 取的是数据层的无数据快照（`MockData.noDataStats()`：同键集 + `noData:true`），
     改前渲染层照原样格式化 ⇒ `#sPlan` 空 / `undefined`、`#sFpy`/`#sOee` 显示 `0.0%`，
     把"算不出来"读成了"当班一件没干"（D8 自己都拒绝伪造当班班次、把班次位写成"—"，同口径）。
     这里只认**显式状态位**（不靠"值是不是 0"去猜 —— 真实 0 仍要显示 0）：
     `noData === true` ⇒ 一律输出"—"（该页既有占位风格，见 index.html 的 `#stDepthTask`/`#alCode`）。
     自愈后 `tick()` 重新写入带 `noData:false` 的真实统计 ⇒ 本分支自动退出、回到真实值。 */
  const NO_DATA = '—';

  /* ==========================================================================
     `E197`（★，A 组）：**同一个标签 `#sStarted` 由两条不同口径的取数写入** ——
       · 演示：`MockData.computeStats()` 的 `started = Math.min(计划, 完成+在测+待复检)`（**派生**且
         封顶于计划数，见 `mockData.js:263`）；
       · 生产：`StateAdapter.applyServerStats()` 把服务端 `startedQty` 映射进**同一个** `state.stats.started`
         （`stateAdapter.js:42` 的 `STATS_KEY_MAP`，**实测**口径）。
     两种模式**同标签、不同含义**，现场看起来像"数据自相矛盾" ⇒ 本包给一个**口径标注位**。

     **形态选型与理由（ADR-0004 D21 要求写明）** —— 本包**不改数值语义、不改算式**，只加标注：
       ① **落点＝标签后缀**（`#c114StartedSource`，紧贴「实际开工总数」四字）：标注的判读对象就是
          **这一格的来源**，贴在同一行才不会被读成"整页都是演示"；写成脚注/标题角标都会与"这一格"脱开。
       ② **不做成"数值旁标注"**：`#sStarted` 那一行是 104 px 的 `.tile-value`，同一行再插字会抬行高并
          挤动 `cols-3` 的网格（`.tile` 是 `justify-content:center`），且 75″ 屏上数值行越干净越好。
       ③ **只用"演示模式出现、生产模式不出现"这一条判据**（不是"两种模式都写一句"）：生产模式是
          **实测**值，实测值是这条指标的正常形态，给它加标注反而会让人怀疑真值；而演示模式的
          **派生**性恰恰是"必须被读者知道"的信息（`E72②` 的原始建议即"加『（演示）』或按模式标注"）。

     **单一真源（硬约束）**：模式判据取 **`window.BoardConfig.dataSource`** —— 实测盘上该键
       **只此一处**（`src/config/board.config.js:35`，`grep -n "dataSource:" src/config/board.config.js`
       ⇒ 1 命中），`main.js` 与 `?source=` 参数也都改它；`MockData.CFG` **没有** `dataSource` 键
       （`mockData.js:50-85` 只逐项搬 `deviceName/planQty/…` 等，`grep -c dataSource src/services/mockData.js`
       ⇒ **0 命中**），故**不得**从那里取，也**不得**另造第二个真源。
       与 `UploadPanel.serverMode()`（`UploadPanel.js:61-63`）、`SelfCheckProbe.isServerMode()`
       （`selfCheckProbe.js:55-58`）**同一把尺子**：`state.serverMode` 优先、退配置。
       ⚠ **不在模块加载期缓存**该键（`mockData.js:38-40` 那种"加载期读一次"的写法在这里会失准：
       `main.js` 的 `?source=` 与 `BoardSource.fallbackToDemo()` 都在加载之后改它）⇒ **每帧现读**。
     ========================================================================== */

  /** 是否服务端（生产）模式 —— 与 `UploadPanel` / `SelfCheckProbe` 同判据（见上方注释③） */
  function isServerMode(state) {
    return !!(state && (state.serverMode === true ||
      ((window.BoardConfig || {}).dataSource === 'server')));
  }

  /** 演示派生值的标签后缀（**逐字**；字母表与 `.tile-label-note` 一一对应，见 global.css） */
  const DEMO_SOURCE_NOTE = '（演示派生）';

  /**
   * `E198`（★★，A 组）：**"帧没带件序号"必须有一个显式提示位**。
   *
   * 缺口（`项目记录\后续路线图.md` 的 `E198` 行）：服务端对"帧缺件序号 / 件序号非法"的帧
   * **照收**（`unit_index` 写 NULL）并计入 `ingest.status().frameUnitIndex.withoutIndex`，
   * 该读数经 `GET /health` 的**顶层** `frameUnitIndex` 暴露；而 `FR-4.2` 的开工数按
   * `unit_index` **去重** ⇒ **缺件序号的帧不计入开工数**。于是只看 75″ 屏会把"帧缺件序号"
   * 读成"真没开工" —— 与 `E38`（缺口帧把"算不出来"印成 `0`）**同族**。
   *
   * 四条口径（前三条对应 `E198` 的修法要求；第四条＝**负责人 2026-10-07 的口径变更**）：
   *  ① **只有服务端模式才有这个读数** ⇒ 演示模式**不得**用 `0` 冒充"没有缺件序号的帧"
   *     （`E38` 既有口径：把"算不出来"显示成 `0` 是缺陷）；
   *  ② `withoutIndex > 0` ⇒ 提示位**可见**，且文案**点名"件序号"**（下方 `text`）；
   *  ③ `withoutIndex === 0` ⇒ 提示位**不可见**（既不报警、也不占版面）；
   *  ④ **【负责人 2026-10-07 裁定：演示模式下本提示位不显示】**（本包 `T-20261007-02`）。
   *     **改了什么**：第一支由"可见 ＋ 文本『帧缺件序号：无此读数（演示模式未接入服务端）』"
   *       改为"**不可见 ＋ 文本为空**"（`show:false, text:''`）。
   *     **为什么**：同一格已由 `E197` 标了「（演示派生）」⇒ 演示屏不必再常驻一行"服务端口径的
   *       告警"；而"把帧缺件序号读成真没开工"这个**误读风险只存在于有真实帧的服务端模式**
   *       （演示模式根本没有 `/health` 这个读数，也就不存在"缺件序号的帧"）。4K 截图显示该行
   *       在演示模式下常驻两行、与 `E197` 后缀重复表达同一件事（`ADR-0004 D21`：写明改了什么、为什么）。
   *     **未改**：第 ②③ 支（服务端两档）与该读数的取数链（`selfCheckProbe.js` 的投影、
   *       `stateAdapter.js` 的 `state.health = null`）在本包中**一字未动**。
   *
   * ⚠ **两种"没有"必须分得开**（`D20`／`D23` 同族：`stateAdapter.js` 文件头③"缺失一律 `null`"、
   *   `E38`"无法计算不得显示成 0"）：演示模式的"**没有这个读数**"与服务端的
   *   "`withoutIndex === 0`（**真的**没有缺件序号的帧）"在裁定后**都不可见、文本都为空** ⇒
   *   光看"可见性 ＋ 文本"**再也分不开**。故本函数的返回值里带一个**机器可读标记 `mark`**，
   *   由 `render()` 写到 DOM 的 `data-note-lv`：`demo`（演示模式：无此读数）
   *   **≠** `ok`（服务端：读到 0，真的没有）。**标记与可见性解耦** —— 不可见时照样写
   *   ⇒ 隐藏不会吞掉"究竟是哪一种没有"。这也是 `mark` 由**本函数**给出、而非渲染层按模式
   *   再推一次的原因：两种"没有"的区分口径只此一处（避免同一判据两处实现、日后漂移）。
   *
   * **取数（渲染函数不发请求）**：`withoutIndex` 由 `services/selfCheckProbe.js` 的既有
   * `/health` 探测（`SelfCheckProbe.ensure()`，5 s 节流 ＋ 在途去重）落到 `state.health.frameUnitIndex`；
   * **本函数只读 `state`** —— 这正是 `tests/ui-check.js` 的 vm 夹具有能力构造它的原因。
   *
   * @param {object} state 看板状态
   * @returns {{text:string, lv:string, show:boolean, mark:'demo'|'warn'|'err'|'ok'}}
   *          `lv` 取既有配色档 `'' | 'warn' | 'err'`；`mark` 写进 `data-note-lv`（四个字面值互不相同）
   */
  function frameUnitIndexNote(state) {
    if (!isServerMode(state)) {
      /* ④ 演示模式（负责人 2026-10-07 裁定）：**不显示**、文本为空。
         但仍带 `mark:'demo'` —— 与下面服务端 `withoutIndex === 0` 的 `mark:'ok'` 分得开，
         两种"没有"不得混成同一个空（见上方 ⚠ 段）。 */
      return { text: '', lv: '', show: false, mark: 'demo' };
    }
    const h = (state && state.health) || null;
    const f = h && h.frameUnitIndex && typeof h.frameUnitIndex === 'object' ? h.frameUnitIndex : null;
    const withoutIndex = f ? f.withoutIndex : undefined;
    if (typeof withoutIndex !== 'number' || !Number.isFinite(withoutIndex)) {
      /* 服务端模式但**没读到**这个数（探测未回 / `/health` 没给该键）⇒ 如实说"未取得"，
         **绝不**写成 `0`（"没有这个数"与"这个数是 0"必须分得开 —— 与 `/health` 自己给 `null` 同口径）。 */
      return { text: '帧缺件序号：未取得 /health 读数（非 0，不等于"没有缺件序号"）', lv: 'warn', show: true, mark: 'warn' };
    }
    if (withoutIndex > 0) {
      /* `FR-4.2` 的开工数按 `unit_index` 去重 ⇒ 这 N 帧**不计入**上方开工数，必须点名说清 */
      return {
        text: '⚠ 本班 ' + withoutIndex + ' 帧未带件序号（未计入开工数；FR-4.2 按件序号去重）',
        lv: 'err', show: true, mark: 'err'
      };
    }
    /* `withoutIndex === 0` ⇒ 无可提示项（"正常"不占版面；但 `mark:'ok'` 与 `demo` 分得开） */
    return { text: '', lv: '', show: false, mark: 'ok' };
  }

  function render(state) {
    const s = state.stats;
    const noData = s.noData === true;          // 显式状态位；正常帧为 false（见 mockData.computeStats）
    const serverMode = isServerMode(state);    // 本帧只判一次（下方两处标注共用同一个结论）

    /* ---- `E197` 口径标注：**只改标签组成、不碰数值**（`s.started` 的算式与封顶语义一字未动） ----
       演示 ⇒ 写后缀「（演示派生）」；生产 ⇒ **清空**（实测值不加标注，见上方选型理由③）。 */
    setText(EL_SOURCE_NOTE, serverMode ? '' : DEMO_SOURCE_NOTE);

    /* ---- `E198` 帧缺件序号提示位：**只读 `state`**（取数在 `SelfCheckProbe` 的既有探测里） ---- */
    const note = frameUnitIndexNote(state);
    const noteEl = $(EL_FRAME_NOTE);
    if (noteEl) {
      noteEl.className = 'tile-note' + (note.lv ? ' ' + note.lv : '');
      noteEl.hidden = !note.show;
      /* 两道关闭一起用（与 `UploadPanel.js:77-89` 同一做法与理由）：`hidden` 属性 ＋ 行内 `display`。
         本元素的作者样式 `.tile-note` **不含** `display` 声明，按 `E127` 的全局兜底
         （`global.css` 末段 `[hidden]{display:none !important}`）单写 `hidden` 已足够；
         行内 `display` 是**第二道**（不依赖 CSS 是否加载）。 */
      if (noteEl.style) noteEl.style.display = note.show ? '' : 'none';
      /* 机器可读标记**直接取 `frameUnitIndexNote()` 的 `mark`**（不在渲染层按模式再推一次 ——
         两种"不可见"（演示 `demo` / 服务端读到 0 `ok`）的区分口径只此一处，见该函数 ⚠ 段）。
         四个字面值互不相同，且**与可见性解耦**：隐藏时照样写，隐藏不会吞掉"是哪一种没有"。
         （用 `dataset` 而非 `setAttribute`：真 DOM 上 `dataset.fooBar` ≡ `data-foo-bar`，
           对既有 `.tile-note` 样式零影响，也避免在只读夹具上引入新 API 依赖。） */
      noteEl.dataset.noteLv = note.mark;
    }
    setText(EL_FRAME_NOTE, note.text);

    /* 当班任务统计 */
    setText('sPlan', noData ? NO_DATA : s.plan);
    setText('sStarted', noData ? NO_DATA : s.started);
    setText('sNotStarted', noData ? NO_DATA : s.notStarted);

    /* 任务完成统计 */
    setText('sDone', noData ? NO_DATA : s.done);
    setText('sDoing', noData ? NO_DATA : s.testing);
    setText('sTodo', noData ? NO_DATA : s.pending);

    /* 质量质检统计 */
    setText('sQualified', noData ? NO_DATA : s.qualified);
    setText('sUnqualified', noData ? NO_DATA : s.unqualified);
    setText('sRecheck', noData ? NO_DATA : s.recheck);
    setText('sFpy', noData ? NO_DATA : s.firstPass.toFixed(1) + '%');

    /* 设备效率统计 */
    setText('sRunTime', noData ? NO_DATA : F.clock(s.runSec));
    setText('sIdleTime', noData ? NO_DATA : F.clock(s.idleSec));
    setText('sAvgTime', noData ? NO_DATA : F.duration(s.avgTest));
    setText('sCapacity', noData ? NO_DATA : s.capacity.toFixed(1) + '%');
    setText('sOee', noData ? NO_DATA : s.oee.toFixed(1) + '%');
  }

  return { render };
})();
