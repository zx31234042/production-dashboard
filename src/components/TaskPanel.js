/* ==========================================================================
   组件：任务数据页（components/TaskPanel.js）
   需求版本：V1.37（V1.37 / C-98 只统一 `testStatus` 码语义与运行阶段映射（改在 config/fieldMap.js
              与两处模拟上位机），**本文件判定与展示逻辑未变**；
              V1.36 / C-96（U-5） 精简测试标准区说明行文案：`#tkStdMeta` 只留一句「典型值 / 上偏差 /
              下偏差三格可录入」，删去导出公式长句与尾部 meta（班组/生效时间/版本）；
              V1.35 / C-90 + C-91 起「显示与录入对象」＝典型值 / 上偏差 / 下偏差，上限/下限为导出值）
   需求：FR-3 工单信息、实时实测数据、测试进度与结果
         FR-3.16 任务数据页右下角为**测试标准区**（深度/速度的典型值、上偏差、下偏差）；
                         相机参数移入**二级菜单**，菜单项**只含参数名 + 设定值**
                         （不做状态判定、不显示实测值/偏差）
         FR-3.5～3.8（改归属）相机设定深度/增益/帧率/快门速度的**设定值**由二级菜单承载
         FR-3.18（V1.35 / C-90 改显示对象）**显示**：深度与速度分别显示**典型值、上偏差、下偏差**
                         （三者均为录入单元格），并由 `上限＝典型值＋上偏差`、`下限＝典型值＋下偏差`
                         **导出**上下限（表内第 5 格以**只读导出值**给出，供判定核对）；
                         单位 深度 m / 速度 m/s，均两位小数；超范围红、临近黄（三态仅用于深度与速度）；
                         典型值可录入可修改，**但不参与判定**（判定对象＝导出的上下限）
         FR-3.19（V1.35 / C-90 + C-91）三个单元格的**录入与修改**：八步逻辑
                         （解锁 → 任务数据页 → ③点**典型值/上偏差/下偏差**任一数字 →
                         ④反色 + 高亮框 2 px + **1 s ± 50 ms** 闪烁 → ⑤输入（下偏差默认负、
                         上偏差默认正、不带符号按默认口径；典型值为非负绝对量、不带符号）→
                         ⑥回车或点击其他区域退出并注入；先校验、任一不通过即弹窗且**不写入**：
                           a) 非法值（非数值）/ 小数位非法（> standards.digits）
                           b) `下偏差 ≤ 上偏差`（按两位小数取整后的隐含下限比较）
                           c) `上偏差 ≥ 0 ≥ 下偏差`（典型值存在时；等价"典型值在导出上下限之间"）
                              —— 典型值为空时跳过本项
                           d) 上/下偏差须**同时存在或同时为空**
                           e) 超量程：按**导出的上/下限绝对值**是否落在 `standards.range[kind]`（深度 4～6 m、
                              速度 3～8 m/s，单一真源在 config/board.config.js）内
                         → ⑦**成功与被拒均逐单元格留痕**（成功记被改单元格 + 前后值 + 导出上下限 + 时间戳 + 班组编号；
                             被拒记被改单元格 + 拒绝原因 + 时间戳 + 班组编号，两者同一条可对号）
                         → ⑧主动锁定或 5 分钟无操作即锁定，锁定后点数字不响应）
                         改典型值 ⇒ 上下限随偏差**整体平移**；改偏差 ⇒ **仅对应一侧**变化
         FR-3.14 三态判定的对象是**导出的上下限**，参数只有深度与速度
         AC-09 未解锁不得修改测试标准（任务数据页入口同受密码保护）
   口径（V1.35：负责人 2026-09-24 手动测试反馈裁定 U-3 / C-90 + C-91）：
     - 录入对象＝典型值 / 上偏差 / 下偏差，**三个单元格均可录入**；
       上限＝典型值＋上偏差、下限＝典型值＋下偏差为**导出值**（只读，不参与录入）。
     - 下偏差默认负、上偏差默认正；输入不带正负号按默认口径处理；典型值为非负绝对量、不带符号。
     - 典型值**可录入、可修改，但不参与判定**；判定只用导出的上下限；修改前不改动现有值与显示
       （任一校验不通过时 `state.task.standard` **逐字不变**、不留半成品）；单人操作、无二次复核；
       历史判定**不追溯**。
     - 数值/单位/精度/量程/三态阈值一律取自 config/board.config.js 的 `standards` 段与 state，**不写死**。
   口径（V1.36 / C-96（U-5）：说明行文案精简）：
     - `#tkStdMeta` 逐字为「典型值 / 上偏差 / 下偏差三格可录入」**一句、无括号、无 meta 后缀**；
       index.html 的初值与渲染结果同句（锁定态的 `#tkStdMsg` 文案不动）。
     - 界面事实未因此丢失：班组在页头常显（FR-1.6）、标准生效时间与版本仍在留痕与操作日志
       （FR-3.19⑦）、上限/下限本身仍以第 5 格**只读导出值**呈现在界面上。
   ========================================================================== */
window.Components = window.Components || {};
window.Components.TaskPanel = (function () {
  'use strict';

  const { setText, setHTML, setStyle, setClass, $ } = window.Dom;
  const { esc, round2 } = window.Format;
  const BC = window.BoardConfig || {};

  /* 测试标准规格（FR-3.18 / FR-3.19）：单位、精度、三态阈值、默认演示值全在配置里 */
  const STD = BC.standards || {};
  const STD_DIGITS = typeof STD.digits === 'number' ? STD.digits : 2;
  /* 临近带比例（tolerance = (上限 − 下限) × nearRatio）与三态判据本身**不在本文件**：
     公式的唯一实现在 services/mockData.js 的 standardLevel()（FR-5.8 预警与界面三态共用一份，
     避免出现第二份口径），本组件只转发调用 —— 见下方 levelOf()。 */

  /* 相机参数二级菜单（FR-3.16 修正口径）：**只含参数名 + 设定值**。
     四项相机参数是设备 PC 上位机的设备参数，**不参与本看板判定**，
     故此处**不做状态判定、不显示实测值/偏差/状态**（判定不在本看板职权范围内）。 */
  const CAM = BC.camera || {};
  const CAM_ROWS = (CAM.rows && CAM.rows.length) ? CAM.rows : [
    { key: 'depth',   label: '相机设定深度', unit: 'm',   digits: 2 },
    { key: 'gain',    label: '相机增益',     unit: '',    digits: 1 },
    { key: 'fps',     label: '设定帧率',     unit: 'fps', digits: 0 },
    { key: 'shutter', label: '快门速度',     unit: '',    digits: 0 }
  ];

  const PARAM_LABEL = { depth: '深度', speed: '速度' };

  /* 三个可录入单元格（FR-3.19③ / C-90）：单元格后缀 → state 字段。
     后缀与 DR-03 / 服务端的字段名**同名**（`depthTypical` / `depthUpperDev` / `depthLowerDev`），
     于是 `data-edit` 值、留痕文案、落库字段三处可一一对应，不再各起一套名字。 */
  const FIELDS = [
    { suffix: 'Typical',  key: 'typical',  name: '典型值' },
    { suffix: 'UpperDev', key: 'upperDev', name: '上偏差' },
    { suffix: 'LowerDev', key: 'lowerDev', name: '下偏差' }
  ];
  const FIELD_OF = {};
  FIELDS.forEach(f => { FIELD_OF[f.suffix] = f; });

  /* 演示用兜底标准（仅当配置段缺失时生效；运行时真源是 state.task.standard）——
     取值与 config `standards.default` 同步（深度量程 [4, 6] m 由负责人 2026-09-22 确认） */
  const FALLBACK_STD = {
    depth: { unit: 'm',   typical: 5.00, upperDev: 0.30, lowerDev: -0.20 },
    speed: { unit: 'm/s', typical: 5.00,  upperDev: 0.20, lowerDev: -0.20 }
  };

  /* 录入会话（FR-3.19 第 3～6 步的中途态；**不进 state** —— 它是界面中途态，不是业务数据） */
  let session = null;      // { type:'depthUpper'|'depthLower'|… }
  let lastErr = null;      // 最近一次非法录入的提醒文案（由 render 显示）
  let lastInfo = null;     // 最近一次成功注入的回执文案（由 render 显示）
  let booted = false;      // 交互是否已装配（装配只在浏览器里做一次）

  const isNum = v => typeof v === 'number' && Number.isFinite(v);

  /** 固定小数位（两位小数口径：FR-3.18 单位写法） */
  function fmt(v, digits) {
    const d = typeof digits === 'number' ? digits : STD_DIGITS;
    return isNum(v) ? v.toFixed(d) : '—';
  }

  /** 带符号偏差文本（+0.30 / -0.20） */
  function devTxt(d, digits) {
    return isNum(d) ? (d >= 0 ? '+' : '') + d.toFixed(digits) : '—';
  }

  /** 该参数在配置里的默认段（(产品＋工序) 未命中现场录入值时使用；仅演示） */
  function cfgRow(kind) {
    const dft = STD.default || {};
    return dft[kind] || FALLBACK_STD[kind] || null;
  }

  /**
   * 取一条参数规格：现场录入值优先，**未命中时才**回退配置默认（仅演示）。
   * 注：只要 state 里已为该参数建了行（哪怕只有典型值、缺偏差），就**不做逐项补默认** ——
   *     必要项缺失必须如实显示"标准未设定"，否则半套默认值会伪造出一条看起来合法的标准，
   *     并把 MES 上报从"占位"错误地变成"有标准"（FR-3.19 的"不写入"语义 / IF-B.5）。
   * @returns {object|null} 该参数的规格（含 unit / digits / typical / upperDev / lowerDev）
   */
  function ensureRow(state, kind) {
    const task = state && state.task;
    const cur = (task && task.standard && task.standard[kind]) || null;
    const row = cur ? cur : cfgRow(kind);
    if (!row) return null;
    if (typeof row.unit !== 'string') row.unit = '';
    if (typeof row.digits !== 'number') row.digits = STD_DIGITS;
    return row;
  }

  /**
   * 取（必要时**整体播种**）state 里的标准记录行（FR-3.19"注入"的落点：运行时真源）。
   * 播种口径：把配置默认段的四项（典型值 / 上偏差 / 下偏差 / 单位）**一次写全**，
   * 这样"标准齐备"与"标准缺失"两态在 state 里始终可区分，不会出现半套标准
   * （半套会让上报口径退化为"有标准"，与 IF-B.5 的占位要求冲突）。
   */
  function ensureStd(state, kind) {
    const task = state && state.task;
    if (!task) return null;
    if (!task.standard) task.standard = { productCode: task.productCode || '', processCode: STD.processCode || '' };
    const std = task.standard;
    if (!std[kind]) {
      const seed = cfgRow(kind);
      if (!seed) return null;
      std[kind] = {
        unit: seed.unit || '',
        digits: typeof seed.digits === 'number' ? seed.digits : STD_DIGITS,
        typical: seed.typical,
        upperDev: seed.upperDev,
        lowerDev: seed.lowerDev
      };
    }
    const row = std[kind];
    if (typeof row.unit !== 'string') row.unit = '';
    if (typeof row.digits !== 'number') row.digits = STD_DIGITS;
    return row;
  }

  /**
   * 是否满足"有标准可显示"：必要项＝典型值＋上偏差＋下偏差（V1.35：三格均可录入）。
   * **典型值可录入、可修改，但不参与判定** —— 少了任一必要项就不算"标准已设定"（R-18 判据），
   * 此时该行不产生导出上下限、三态为 idle（标准未设定）。
   */
  function hasStandard(state, kind) {
    const row = ensureRow(state, kind);
    return !!(row && isNum(row.typical) && isNum(row.upperDev) && isNum(row.lowerDev));
  }

  /**
   * 标准三态（FR-3.18 / FR-3.14）：超范围 → err（红）；临近 → warn（黄）；否则 ok；
   * 必要项缺失 ⇒ idle（标准未设定，不判定）。**判定对象只有深度与速度**
   * （相机参数属上位机侧设备参数，本看板不做判定也不做状态判定 —— C-84④）。
   *
   * 判据的**唯一实现在 services/mockData.js 的 standardLevel()**（同一份公式、同一份配置
   * `standards.nearRatio` / `standards.digits`）：界面三态（FR-3.18）与预警（FR-5.8）
   * 共用它，故本函数只做转发，不再复制一份 —— 复制两份必然在改口径时漏改一处
   * （R-2026-09-19-02 审查的教训）。`window.MockData` 是渲染的既有硬依赖（本文件 render() 也取
   * `MockData.CFG.cycleSec`），故判据实现在加载顺序上恒可用。
   * @param {number} real 实测值
   * @param {object|null} spec 标准规格（typical / upperDev / lowerDev / digits）
   * @returns {{lv:string, text:string}}
   */
  function levelOf(real, spec) {
    const M = window.MockData;
    if (M && typeof M.standardLevel === 'function') return M.standardLevel(real, spec);
    return { lv: 'idle', text: '标准未设定' };
  }

  /** 上限 / 下限绝对值（显示与上报同值：典型值 ± 偏差） */
  function limitOf(spec, side) {
    if (!spec || !isNum(spec.typical)) return null;
    const dev = side === 'upper' ? spec.upperDev : spec.lowerDev;
    if (!isNum(dev)) return null;
    return round2(spec.typical + dev);
  }

  /** 当前生效班次的班组编号（与 FR-1.6 头部班组同一真源：config.shift.roster） */
  function teamOf(state) {
    const roster = ((BC.shift || {}).roster) || {};
    const shift = (state && state.shift) || {};
    return roster.teamId || shift.teamId || shift.team || '';
  }

  /** 录入成功留痕（FR-3.19 第 7 步）：内容 + 时间戳 + 班组编号（时间戳由 pushLog 记 state.clock） */
  function logEntry(text) {
    const M = window.MockData;
    if (!M || typeof M.pushLog !== 'function') return;
    M.pushLog('测试标准录入', text + '；班组编号 ' + (teamOf(M.state) || '—'));
  }

  /**
   * 通知"有操作"（FR-3.19 第③步）：重置"无操作回首页"计时（FR-9.4），
   * 并重新登记 5 分钟自动锁定（FR-8.2 —— 与设置页**同一份**计时逻辑，
   * 通过 SettingPanel 导出的 armAutoLock() 复用，不另起第二个定时器）。
   * 为什么直接调 `Dashboard.resetIdleTimer()` 而不走 bind 的 onActivity 回调：
   * 任务数据页的装配点不在 `Dashboard.init()` 的装配列表里，本组件只能在 DOM 就绪后
   * 自行装配，拿不到 init 注入的回调；而 `resetIdleTimer` 是 Dashboard 导出的同一份实现，
   * 调用它与回调等价（同一真源）。
   */
  function activity() {
    if (window.Pages && window.Pages.Dashboard && typeof window.Pages.Dashboard.resetIdleTimer === 'function') {
      window.Pages.Dashboard.resetIdleTimer();
    }
    if (window.Components.SettingPanel && typeof window.Components.SettingPanel.armAutoLock === 'function') {
      window.Components.SettingPanel.armAutoLock();
    }
  }

  /* ---------------- 录入会话（FR-3.19 第 3～6 步） ---------------- */

  /** 录入单元格类型：`{depth|speed}{Typical|UpperDev|LowerDev}`（FR-3.19③ / C-90） */
  function kindOf(type) {
    return type.indexOf('depth') === 0 ? 'depth' : 'speed';
  }

  /** 该单元格对应的字段规格（{ suffix, key, name }）；不在三格之内 ⇒ null */
  function fieldOf(type) {
    return FIELD_OF[type.slice(kindOf(type).length)] || null;
  }

  /** 录入行的标题文案：「深度 典型值」/「深度 上偏差」/「深度 下偏差」（渲染时前置"录入 "） */
  function labelOf(type) {
    const f = fieldOf(type);
    return PARAM_LABEL[kindOf(type)] + (f ? ' ' + f.name : '');
  }

  /** 第 3～4 步：点击典型值/上偏差/下偏差数字 ⇒ 反色 + 高亮框（2 px）+ 1 s ± 50 ms 闪烁，随后进入输入 */
  function startSession(state, type) {
    if (!state || !state.unlocked) return;      /* 第 8 步：锁定后点击数字无响应 */
    if (!fieldOf(type)) return;                 /* 非三格之一（旧上限/下限格已不存在）不进入录入态 */
    session = { type };
    lastErr = null;
    lastInfo = null;
    activity();
    render(state);                              /* 先画出闪烁中的数字（第 4 步） */
    /* 0.3 s 后聚焦输入框；闪烁自点击瞬间就在跑，闪烁周期由 styles/global.css 定为 1 s */
    window.setTimeout(() => {
      if (!session || session.type !== type) return;
      const input = document.getElementById(DOM_INPUT);
      if (input && typeof input.focus === 'function') {
        input.focus();
        if (typeof input.select === 'function') input.select();
      }
    }, 300);
  }

  /** Escape / 取消：不注入、不改动任何值，只留痕 */
  function cancelSession(state) {
    if (!session) return;
    const label = labelOf(session.type);
    session = null;
    clearEditing();
    setEditVisible(false);
    lastErr = null;
    lastInfo = null;
    logEntry('取消' + label + '录入（未改动任何数值）');
    render(state);
  }

  function clearEditing() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    document.querySelectorAll('.std-limits td.is-editing').forEach(td => td.classList.remove('is-editing'));
  }

  /** 退出录入：隐藏录入行并释放输入框（不 blur 到其它控件，避免"失焦即提交"再触发一次） */
  function clearEditor() {
    setEditVisible(false);
  }

  /**
   * 第 6 步：回车或点击其他区域 ⇒ 退出录入并注入。**先校验、后注入** —— 任何一支不通过都立即
   * return，既不写 state、也不改动显示（FR-3.19 第⑥步 + 配套约束"修改成功前不改动现有值与显示"）。
   * 校验分支（V1.35 / C-91 按**偏差模型**重述，判定对象仍是**导出的上下限**）：
   *   ① 非法值（非数值）；② 典型值带负号（非负绝对量、不带符号）；
   *   ③ 小数位非法（> `standards.digits`）；
   *   ④ 上偏差与下偏差**须同时存在或同时为空**；
   *   ⑤ `下偏差 ≤ 上偏差`（按两位小数取整后的**隐含下限/上限**比较）；
   *   ⑥ `上偏差 ≥ 0 ≥ 下偏差`（典型值存在时；等价"典型值在导出上下限之间"）—— 典型值为空时跳过；
   *   ⑦ 超量程：按**导出的上/下限绝对值**是否落在 `standards.range[kind]` 内。
   * 校验全程只读 state：候选值写在**临时对象** `next` 上，故任一不通过时 `state.task.standard` 逐字不变。
   */
  function commitSession(state) {
    if (!session) return;
    const type = session.type;
    const typed = readInput();
    session = null;
    clearEditing();
    clearEditor();

    const kind = kindOf(type);
    const f = fieldOf(type);
    const row = ensureRow(state, kind);
    if (!row || !f) return;
    const digits = typeof row.digits === 'number' ? row.digits : STD_DIGITS;
    const label = labelOf(type);

    /* 校验①：非法值（非数值） */
    const n = normalizeNum(typed, f.key);
    if (n === null) {
      fail(state, label, '「' + label + '」未识别到有效数值，本次不写入（原有数值与显示保持不变）');
      return;
    }
    /* 校验②：典型值为**非负绝对量、不带符号**（FR-3.19⑤）—— 输入负号一律拒绝，不做"取绝对值"的猜测 */
    if (f.key === 'typical' && /^-/.test(normalizeChars(typed))) {
      fail(state, label, '校验未通过：典型值为非负绝对量、不带符号（本次输入 "' + String(typed) +
        '" 带负号），本次不写入');
      return;
    }
    /* 校验③：小数位非法（FR-3.19 第⑥步）。精度由配置单一真源 `standards.digits` 决定（默认 2），
       多于该位数一律拒绝 —— 绝不让 normalizeNum 把任意位数的小数照单全收地写进标准值。 */
    const typedDigits = decimalsOf(typed);
    if (typedDigits > digits) {
      fail(state, label, '校验未通过：小数位非法，「' + label + '」最多 ' + digits + ' 位小数（本次输入 ' +
        typedDigits + ' 位），本次不写入');
      return;
    }

    /* 校验：把本次输入替换到**临时规格**上（不碰 state，也不碰 row） */
    const next = {
      typical: f.key === 'typical' ? n : row.typical,
      upperDev: f.key === 'upperDev' ? n : row.upperDev,
      lowerDev: f.key === 'lowerDev' ? n : row.lowerDev
    };
    const hasU = isNum(next.upperDev);
    const hasL = isNum(next.lowerDev);
    const hasT = isNum(next.typical);

    /* 校验④：上/下偏差须**同时存在或同时为空**（FR-3.19⑥ 既有规则）—— 半套偏差无法形成区间 */
    if (hasU !== hasL) {
      fail(state, label, '校验未通过：上偏差与下偏差必须同时存在或同时为空（当前'
        + (hasU ? '只设了上偏差' : '只设了下偏差') + '），本次不写入');
      return;
    }

    /* 导出上限/下限（典型值与偏差都齐备时才有值；缺任一项 ⇒ null，"缺项不产生导出值"） */
    const upper = (hasT && hasU) ? round2(next.typical + next.upperDev) : null;
    const lower = (hasT && hasL) ? round2(next.typical + next.lowerDev) : null;

    /* 校验⑤：下偏差 ≤ 上偏差 —— 比较的是**两位小数取整后的隐含下限/上限**（C-84 D-3 / C-91）。
       典型值为空时仍校本项（用偏差自身比较，等价于以 0 为基准的同一约束）。 */
    if (hasU && hasL) {
      const upCmp = isNum(upper) ? upper : round2(next.upperDev);
      const loCmp = isNum(lower) ? lower : round2(next.lowerDev);
      if (loCmp > upCmp) {
        fail(state, label, '校验未通过：下偏差 ≤ 上偏差 不成立（导出下限 ' + fmt(loCmp, digits) + ' 大于导出上限 ' +
          fmt(upCmp, digits) + '；上限＝典型值＋上偏差、下限＝典型值＋下偏差），本次不写入');
        return;
      }
    }
    /* 校验⑥：上偏差 ≥ 0 ≥ 下偏差（典型值存在时）。等价于"典型值落在导出的上下限之间"（C-91）；
       典型值为空 ⇒ **跳过本项**（IF-B.5"只设偏差未设典型值"的兼容防御分支）。 */
    if (hasT && hasU && hasL) {
      if (round2(next.upperDev) < 0) {
        fail(state, label, '校验未通过：上偏差 ' + devTxt(next.upperDev, digits) + ' 小于 0（要求上偏差 ≥ 0 ≥ 下偏差）⇒' +
          '典型值 ' + fmt(next.typical, digits) + ' 高于导出上限 ' + fmt(upper, digits) + '，本次不写入');
        return;
      }
      if (round2(next.lowerDev) > 0) {
        fail(state, label, '校验未通过：下偏差 ' + devTxt(next.lowerDev, digits) + ' 大于 0（要求上偏差 ≥ 0 ≥ 下偏差）⇒' +
          '典型值 ' + fmt(next.typical, digits) + ' 低于导出下限 ' + fmt(lower, digits) + '，本次不写入');
        return;
      }
    }
    /* 校验⑦：超量程（FR-3.19 第⑥步）—— 量程取自配置**单一真源** `standards.range[参数种类]`，
       校验本次录入得到的**导出上限/下限绝对值**是否落在量程内；越界即拒绝（实现里不写死量程数值）。
       典型值缺失 ⇒ 没有导出值可判（导出格显示"—"），本项不参与。 */
    const range = rangeOf(kind);
    if (range) {
      const over = [['上限', upper], ['下限', lower]].find(([, v]) =>
        isNum(v) && ((range.min !== null && v < range.min) || (range.max !== null && v > range.max)));
      if (over) {
        const unit = row.unit ? ' ' + row.unit : '';
        fail(state, label, '校验未通过：' + over[0] + ' ' + fmt(over[1], digits) + unit + ' 超出' +
          PARAM_LABEL[kind] + '量程 [' + fmt(range.min, digits) + ', ' + fmt(range.max, digits) + ']' + unit +
          '，本次不写入');
        return;
      }
    }

    /* 注入：只写 state（运行时真源），并记录生效时间戳（标准自生效时间起生效，历史不追溯）。
       改典型值 ⇒ 上下限随偏差整体平移；改偏差 ⇒ 仅对应一侧变化（由导出公式自然成立）。 */
    const beforeTxt = f.key === 'typical' ? fmt(row.typical, digits) : devTxt(row[f.key], digits);
    const afterTxt = f.key === 'typical' ? fmt(n, digits) : devTxt(n, digits);
    const beforeUp = limitOf(row, 'upper');
    const beforeLo = limitOf(row, 'lower');

    const target = ensureStd(state, kind);
    target[f.key] = n;
    const std = state.task.standard;
    std.effectiveAt = ((state.clock && state.clock.date) || '') + ' ' + ((state.clock && state.clock.time) || '');
    std.operator = (state.shift && state.shift.operator) || '';
    std.revision = (isNum(std.revision) ? std.revision : 1) + 1;

    const afterUp = limitOf(target, 'upper');
    const afterLo = limitOf(target, 'lower');
    const unit = (target.unit || '');
    const limitTxt = '导出上限 ' + fmt(beforeUp, digits) + ' → ' + fmt(afterUp, digits) +
      '、导出下限 ' + fmt(beforeLo, digits) + ' → ' + fmt(afterLo, digits) + (unit ? ' ' + unit : '');
    lastErr = null;
    lastInfo = '「' + label + '」已更新：' + beforeTxt + ' → ' + afterTxt + '（' + limitTxt + '）';
    /* 第⑦步 成功留痕（逐单元格）：被改单元格 + 修改前后值 + 导出上下限 + 生效时间（班组编号由 logEntry 追加）；
       被拒留痕同口径（同一条同时给出被改单元格与拒绝原因），见 fail()。 */
    logEntry('被改单元格「' + label + '」：' + beforeTxt + ' → ' + afterTxt + '；' + limitTxt +
      '；生效时间 ' + std.effectiveAt);
    activity();
    render(state);
  }

  /**
   * 非法录入：弹窗提醒 + **逐单元格**画面留痕，**不改动任何数值**。
   * 留痕同时给出「**哪一格被拒**」与「**为什么被拒**」（DR-12 `op_log` 是审计台账，两者必须同一条可对号，
   * 否则现场排查只看得到原因、看不到对象）：
   *   被改单元格「深度 典型值」：录入被拒绝 —— 校验未通过：上限 6.20 m 超出深度量程 [4.00, 6.00] m，本次不写入；班组编号 TM-3901
   * 时间戳与班组编号仍由 logEntry 追加；弹窗文案保持原样（只说校验原因，不改口径）。
   * @param {object} state 看板状态
   * @param {string} label 被改单元格名（如「深度 典型值」，来自 labelOf(type)）
   * @param {string} msg   校验未通过的具体原因（原样进入 alert 与留痕）
   */
  function fail(state, label, msg) {
    lastErr = msg;
    lastInfo = null;
    logEntry('被改单元格「' + label + '」：录入被拒绝 —— ' + msg);
    window.alert(msg);
    render(state);
  }

  /**
   * 该参数的量程（FR-3.19 第⑥步"超量程"校验）：**单一真源**＝config `standards.range[kind]`。
   * min/max 为可配置项（当前为演示默认值、待甲方确认）；未配置或两端都非数值 ⇒ 返回 null
   * （返回 null 时本项校验不参与，实现里不写死任何量程）。
   * @returns {{min:number|null, max:number|null}|null}
   */
  function rangeOf(kind) {
    const r = (STD.range || {})[kind] || null;
    if (!r) return null;
    const min = isNum(r.min) ? r.min : null;
    const max = isNum(r.max) ? r.max : null;
    return (min === null && max === null) ? null : { min, max };
  }

  /**
   * 录入文本的字符归一化（全角数字 / 全角句号 / 兼容正负号 → 半角），**保留正负号**。
   * 归一化链**只此一份**：`normalizeNum()`（取值）与 `decimalsOf()`（小数位校验）共用，
   * 避免"取值口径"与"数位校验口径"各写一套而互相不一致。
   */
  function normalizeChars(raw) {
    if (raw === null || raw === undefined) return '';
    return String(raw).trim()
      .replace(/[，。]/g, '.')
      .replace(/[＋﹢]/g, '+')
      .replace(/[－–—−]/g, '-')
      .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  }

  /**
   * 录入文本的小数位数（FR-3.19 第⑥步"小数位非法"校验用）：取第一个小数点之后的位数。
   * 与 normalizeNum 共用同一份归一化（全角输入按同一口径折算位数）；无小数点即 0 位。
   * @returns {number} 小数位数（文本为空时返回 0 —— 非法输入由 normalizeNum 先行拦下）
   */
  function decimalsOf(raw) {
    const s = normalizeChars(raw).replace(/[^0-9.]/g, '');
    const m = /\.(\d+)/.exec(s);
    return m ? m[1].length : 0;
  }

  /**
   * 解析录入数值并按默认符号口径归一化（FR-3.19 第 5 步）：
   *   下偏差（lowerDev）默认负 —— 不带符号按负数处理；上偏差（upperDev）默认正 —— 不带符号按正数处理；
   *   典型值（typical）为**非负绝对量** —— 一律返回绝对值，负号由调用方按"非法"拦下（见 commitSession 校验②）。
   * @param {string} raw 输入框原文
   * @param {string} key 字段名 `typical` / `upperDev` / `lowerDev`（兼容旧的 'upper' / 'lower' 写法）
   * @returns {number|null} null = 无法识别为有限数值（调用方按"不写入"处理）
   */
  function normalizeNum(raw, key) {
    const k = key === 'upper' ? 'upperDev' : (key === 'lower' ? 'lowerDev' : key);
    const t = normalizeChars(raw);
    if (!t) return null;
    const explicit = /[+-]/.test(t);
    const isNeg = t.charAt(0) === '-';
    const s = t.replace(/[^0-9.]/g, '');
    if (!s || !/\d/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    const mag = Math.abs(n);
    if (k === 'typical') return mag;
    /* 不带正负号 ⇒ 按默认口径（下偏差负、上偏差正）；带符号 ⇒ 以操作人输入的符号为准 */
    if (k === 'lowerDev') return (explicit && !isNeg) ? mag : -mag;
    return (explicit && isNeg) ? -mag : mag;
  }

  /* ---------------- 交互装配（只做一次；render 不得注册监听/写控件 value，见 ui-check U4） ---------------- */

  const DOM_INPUT = 'tkStdInput';

  /** 显示/隐藏录入行（hidden 属性由渲染切换；**不写控件 value、不挂监听**） */
  function setEditVisible(on) {
    const box = $('tkStdEdit');
    if (box) box.hidden = !on;
  }

  /** 读取输入框当前值 */
  function readInput() {
    const input = typeof document !== 'undefined' && document.getElementById
      ? document.getElementById(DOM_INPUT) : null;
    return input ? input.value : '';
  }

  function setup() {
    if (booted || typeof document === 'undefined' || !document.getElementById) return;
    const panel = document.getElementById('panel-task');
    if (!panel || typeof panel.addEventListener !== 'function') return;
    booted = true;

    /* 第 3 步：点击**典型值 / 上偏差 / 下偏差**任一数字（`data-edit` = 参数种类 + 字段后缀）。
       事件委托：表格每秒重绘也不会丢监听；**不给每个 td 单独挂监听**。
       第 6 步：正在录入时点击其他区域 ⇒ 先退出并注入，再处理本次点击。 */
    panel.addEventListener('mousedown', e => {
      const state = window.MockData ? window.MockData.state : null;
      if (!state) return;
      const td = climbTo(e.target, 'std-num');
      if (td && td.dataset && td.dataset.edit) {
        if (session) commitSession(state);
        startSession(state, td.dataset.edit);
        return;
      }
      if (session && !climbTo(e.target, 'std-edit')) commitSession(state);
    });

    const input = document.getElementById(DOM_INPUT);
    if (input && typeof input.addEventListener === 'function') {
      /* 回车确认；Esc 取消（第 6 步） */
      input.addEventListener('keydown', e => {
        const state = window.MockData ? window.MockData.state : null;
        if (!state || !session) return;
        if (e.key === 'Enter') { e.preventDefault(); commitSession(state); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelSession(state); }
      });
      /* 点击其他区域导致失焦 ⇒ 同样"退出并注入"（第 6 步） */
      input.addEventListener('blur', () => {
        if (session && window.MockData) commitSession(window.MockData.state);
      });
    }
  }

  /** 从事件目标向上找第一个带指定 class 的祖先（DOM 遍历，不依赖 Element.closest） */
  function climbTo(el, cls) {
    let cur = el;
    while (cur && cur.classList) {
      if (cur.classList.contains(cls)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  /* ---------------- 渲染 ---------------- */

  /**
   * 测试标准区（FR-3.18 / V1.35 / C-90）：**典型值 / 上偏差 / 下偏差三格可录入**，
   * 上限＝典型值＋上偏差、下限＝典型值＋下偏差作为**只读导出值**在第 5 格给出（不含 std-num、无 data-edit）。
   * 任一必要项（典型值 / 上偏差 / 下偏差）缺失 ⇒ 该格显示 `—`，且该行**不产生**导出上下限（导出格 `—`）。
   *
   * 说明行文案（V1.36 / C-96，负责人手动测试反馈 U-5）：`#tkStdMeta` **只保留一句**「典型值 / 上偏差 / 下偏差三格可录入」——
   * 精简掉原长句（导出公式与"典型值不参与判定"）与尾部括号 meta（班组 / 标准生效时间 / 版本）。
   * 界面事实未丢失：班组在页头常显（FR-1.6）、生效时间与版本仍在留痕与操作日志（FR-3.19⑦）、
   * 导出的上下限本身仍以第 5 格只读值呈现在界面上。故本函数**不再计算 meta**，也不带任何括号后缀。
   */
  function renderStandards(state) {
    const task = (state && state.task) || {};
    const table = $('tkStdTable');
    const tbody = table ? table.querySelector('tbody') : null;

    setText('tkStdMeta', '典型值 / 上偏差 / 下偏差三格可录入');

    if (tbody) {
      tbody.innerHTML = ['depth', 'speed'].map(kind => {
        const spec = ensureRow(state, kind);
        const real = (task.real || {})[kind];
        const lv = levelOf(real, spec);
        const unit = (spec && spec.unit) ? ' ' + spec.unit : '';
        const digits = spec && typeof spec.digits === 'number' ? spec.digits : STD_DIGITS;
        /* 可录入单元格（FR-3.19③）：`data-edit` = 参数种类 + 字段后缀（与 DR-03 字段同名） */
        const numCell = (suffix, css, text, extra) => {
          const type = kind + suffix;
          const editing = !!(session && session.type === type);
          return '<td class="std-num ' + css + (editing ? ' is-editing' : '') + '" data-edit="' + type + '">' +
            '<span class="std-value">' + esc(text) + '</span>' + (extra || '') + '</td>';
        };
        /* 导出上下限：典型值与两侧偏差齐备时才有值（缺项 ⇒ 不产生导出值，显示 —） */
        const upper = limitOf(spec, 'upper');
        const lower = limitOf(spec, 'lower');
        const derived = (isNum(upper) && isNum(lower))
          ? '上限 ' + upper.toFixed(digits) + ' · 下限 ' + lower.toFixed(digits)
          : '—';
        return '<tr data-kind="' + kind + '">' +
          '<td class="std-name">' + esc(PARAM_LABEL[kind]) +
          '<span class="std-state ' + lv.lv + '">' + esc(lv.text) + '</span></td>' +
          numCell('Typical', 'std-typical', spec ? fmt(spec.typical, digits) : '—',
            '<span class="std-unit">' + esc(unit) + '</span>') +
          numCell('UpperDev', 'std-upperdev', devTxt(spec && spec.upperDev, digits)) +
          numCell('LowerDev', 'std-lowerdev', devTxt(spec && spec.lowerDev, digits)) +
          '<td class="std-derived">' + esc(derived) + '</td>' +
          '</tr>';
      }).join('');
    }
    renderEditRow(state);
    renderMsg(state);
  }

  /** 录入行（第 4～6 步的界面态）：只切显隐与标题，绝不覆盖用户正在输入的值 */
  function renderEditRow(state) {
    const box = $('tkStdEdit');
    if (!box) return;
    box.hidden = !session;
    if (session) setText('tkStdEditLabel', '录入 ' + labelOf(session.type));
  }

  /** 提示行：未解锁说明（AC-09）/ 录入中说明 / 成功回执 / 非法提醒 */
  function renderMsg(state) {
    const unlocked = !!(state && state.unlocked);
    setClass('tkStdTable', 'data-table compact std-limits' + (unlocked ? '' : ' is-locked'));
    if (lastErr) setEditMsg('err', lastErr);
    else if (lastInfo) setEditMsg('ok', lastInfo);
    else if (session) setEditMsg('', '录入中：回车确认并注入，Esc 取消，点击其他区域同样确认');
    else if (!unlocked) setEditMsg('', '当前已锁定：解锁后方可录入典型值、上偏差与下偏差' +
      '（请在「操作设置」页输入密码解锁，演示密码 8888）');
    else setEditMsg('', '已解锁：点击典型值、上偏差或下偏差数字即可录入（单人操作、无二次复核）');
  }

  function setEditMsg(cls, text) {
    const el = $('tkStdMsg');
    if (!el) return;
    el.className = 'std-msg' + (cls ? ' ' + cls : '');
    el.textContent = text;
  }

  /**
   * 相机参数二级菜单（FR-3.16 最终口径）：**只含参数名 + 设定值**。
   * 四项相机参数是设备 PC 上位机的设备参数，**不参与本看板系统测试判定**，
   * 状态判定在本看板职权范围外 ⇒ 此处不做任何三态判定，也不显示实测值/偏差/状态。
   * @param {object} state 看板状态
   */
  function renderCameras(state) {
    const task = (state && state.task) || {};
    const std = task.std || {};
    const table = $('tkCompareTable');
    const tbody = table ? table.querySelector('tbody') : null;
    if (!tbody) return;
    tbody.innerHTML = CAM_ROWS.map(row => {
      const digits = typeof row.digits === 'number' ? row.digits : STD_DIGITS;
      const unit = typeof row.unit === 'string' ? row.unit : '';
      const sv = std[row.key];
      return '<tr><td>' + esc(row.label) + '</td>' +
        '<td class="mono">' + esc(isNum(sv) ? sv.toFixed(digits) : '—') +
        (unit ? ' ' + esc(unit) : '') + '</td></tr>';
    }).join('');
  }

  /** FR-3.17：无在测工单时的空态（业务数值留空，但测试标准区与相机菜单仍可见 —— FR-3.16～3.19） */
  function renderWaiting(state) {
    setHTML('tkOrderList', '<div class="kv-row is-empty"><span class="k">工单</span>' +
      '<span class="v empty-note">等待工单（上位机尚未派工）</span></div>');
    ['tkDepth', 'tkSpeed', 'tkVx', 'tkVy'].forEach(id => setText(id, '—'));
    setText('tkProgressPct', '0.0%');
    setStyle('tkProgressBar', 'width', '0%');
    setHTML('tkProgressText', '等待工单：当前无在测工单，收到派工后自动刷新');
    setText('tkResult', '等待工单');
    setStyle('tkResult', 'color', 'var(--idle)');
    setText('tkResultNote', '等待工单 · 无单任务判定结果');
    document.querySelectorAll('.flow-step').forEach(el => el.classList.toggle('on', false));
    renderStandards(state);
    renderCameras(state);
  }

  /**
   * E39（★★，2026-09-27）：**"无法计算"不得显示成"零完成"**（E38 的同族残留）。
   * 缺口帧里 `state.stats` 是数据层的无数据快照（`MockData.noDataStats()`：同键集 + `noData:true`，
   * 逐键值均为 0），改前 `#tkProgressText` 照原样取 `state.stats.done / state.stats.plan`
   * ⇒ 显示「当班已完成 0 / 0 件」（基线同为 52 / 180 件），把"时刻无法归属、算不出完成数"
   * 读成了"当班一件没干"，违背"不得伪造数据"。
   * 判据与统计页（`StatsPanel`）／班次页（`ShiftPanel`）**同一口径**：只认**显式状态位**
   * `state.stats.noData === true`（不靠"值是不是 0"去猜 —— 真实 0 仍显示 0），
   * 缺口帧只保留与时刻无关的事实（当前件序号），把完成数换成显式无数据「—」；
   * 自愈后 `tick()` 重新写入带 `noData:false` 的真实统计 ⇒ 自动退出本分支、回到真实完成数。
   */
  const NO_DATA = '—';

  function render(state) {
    const t = (state && state.task) || {};
    /* E39：本帧统计是否"不成立"（班次配置缺口 ⇒ 时刻无法归属）——**只认显式状态位**，
       与统计页/班次页同一判据；正常帧为 false（见 mockData.computeStats），真实 0 仍照常显示。 */
    const noData = state.stats.noData === true;

    /* 无在测工单：给出空态占位并结束本次渲染 */
    if (!t || !t.procOrderNo || !t.real || !t.std) { renderWaiting(state); return; }

    /* 当前工单信息（IF-A 派工 / IF-D 转发的字段） */
    setHTML('tkOrderList', [
      ['工单编号', t.procOrderNo],
      ['产品型号', t.productCode],
      ['产品名称', t.productName],
      ['产品批次', t.batchNo],
      ['生产订单编号', t.orderNo],
      ['图号', t.drawingNo],
      ['计划测试数量', `${t.planQty} 件`],
      ['工序', '水下高速摄像检验（工序号 30）']
    ].map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v mono">${v}</span></div>`).join(''));

    /* 主要实测数据：航行器深度与航行速度（FR-3.9～3.11 / C-31、C-32）
       三态着色只用于深度与速度（FR-3.14 判定对象改写 / FR-3.18）：超范围红、临近黄 */
    setText('tkDepth', isNum(t.real.depth) ? t.real.depth.toFixed(2) : '—');
    setText('tkSpeed', isNum(t.real.speed) ? t.real.speed.toFixed(2) : '—');
    setStyle('tkDepth', 'color', styleOfLevel(levelOf(t.real.depth, ensureRow(state, 'depth')).lv));
    setStyle('tkSpeed', 'color', styleOfLevel(levelOf(t.real.speed, ensureRow(state, 'speed')).lv));
    setText('tkVx', t.real.vx.toFixed(2));
    setText('tkVy', t.real.vy.toFixed(2));

    /* 测试标准区（FR-3.16 改写 / FR-3.18）＋相机参数二级菜单（FR-3.16 改写） */
    renderStandards(state);
    renderCameras(state);

    /* 测试实时进度 */
    const pct = t.progress * 100;
    setText('tkProgressPct', pct.toFixed(1) + '%');
    setStyle('tkProgressBar', 'width', pct.toFixed(1) + '%');
    setText('tkProgressText', noData
      ? `当前第 ${t.unitIndex} 件 · 当班已完成 ${NO_DATA} 件`
      : `当前第 ${t.unitIndex} 件 · 当班已完成 ${state.stats.done} / ${state.stats.plan} 件`);

    /* 单任务测试结果（五态流转）；色值引用 styles/variables.css 的 CSS 变量（UI-03） */
    const colors = { '合格': 'var(--ok)', '不合格': 'var(--err)', '待复检': 'var(--warn)', '待测试': 'var(--idle)' };
    setText('tkResult', t.result);
    setStyle('tkResult', 'color', colors[t.result] || 'var(--accent)');
    setText('tkResultNote', `上一件判定结果：${t.lastResult} · 节拍 ${window.MockData.CFG.cycleSec}s/件`);
    document.querySelectorAll('.flow-step').forEach(el =>
      el.classList.toggle('on', el.dataset.step === t.result));
  }

  /** 三态 → CSS 变量（仅着色深度/速度两个主参数） */
  function styleOfLevel(lv) {
    if (lv === 'err') return 'var(--err)';
    if (lv === 'warn') return 'var(--warn)';
    return '';
  }

  /* 交互装配：等 DOM 就绪后装配一次。不写在 render() 里 —— render 每秒执行，
     在其中挂监听会累积（ui-check U4），也会覆盖用户正在输入的值。 */
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
    else if (typeof window.setTimeout === 'function') window.setTimeout(setup, 0);
    else setup();
  }

  return {
    render, bind: setup,
    /* 供自检/后续座位复用：标准取值与判据（单一真源仍在本组件内） */
    limitOf, levelOf, hasStandard, normalizeNum, ensureStd,
    /* 三格录入单元格（FR-3.19③ / C-90）的类型解析：`depthUpperDev` → { suffix, key, name } */
    fieldOf, kindOf, labelOf
  };
})();
