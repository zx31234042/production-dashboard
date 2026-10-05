/* ==========================================================================
   平台适配层自检（tests/platform-check.js）
   作用：给 `platform\` 这一层加门禁。立案原因（R-2026-09-19-02 的 P2-15）：
         `platform\paths.js`、`id.js`、`log.js` 当时**不在任何门禁断言内** ——
         门禁报"381 通过"也**推不出**它们被验证过，`log.js` 的 `keepDays` 从未生效
         就是这么漏过去的。按 ADR-0004 D19（断言即证据），"没被测过"不能靠"数字好看"掩盖。
   覆盖：①路径与三套环境隔离 ②uploadId 形状与跨日序号 ③日志分级/按日滚动/保留清理
        ④平台专有字样防线（D11）
   R26-P3-3 追加：②段补"序号域 1～999 / 永不产 000 / 跨日重置"的生成侧断言、`isUploadId` 与
        生成口径的一一对应断言，以及 **id.js ↔ api.js 的跨界对账**（api.js 真源码在 vm 里跑）；
        立案原因＝两侧曾**两判相反**（api.js `%1000` 产 `000` 且不按日重置）。
   依赖：仅 Node 内置模块（跨界对账用 node:vm）。
   运行：node tests/platform-check.js
   退出码：0 = 全部通过；1 = 有断言失败。
   ========================================================================== */
'use strict';

/* ---------------- 入口与异常兜底（`E80③`／规范 9.5-5 第 5 条） ----------------
   本脚本是一道**门禁**，但长期没有 `main()` 声明、也没有任何异常兜底 ⇒ 两个后果：
     ① `harness-check` 第十六节只审"声明了 `main()`"的文件 ⇒ 本脚本**不在扫描面内**；
     ② 脚本自身异常时抛裸栈、进程退 **1** ⇒ `run-all` 的失败明细过滤
        （`/\[FAIL\]|失败清单|^\s+\d+\.|脚本异常终止/`）认不出它，与"有断言失败"逐字同形。
   现按既有 sync 家族（`copy-check`／`docs-cross-check`／`trace-check`／`screenshot-diff`）同形收口：
   `function main()` ＋ 顶层 `try`/`catch`，异常**打印出来**（含字面 `脚本异常终止`，供 `run-all` 命中）并退 **2**。
   **断言与条数一字未改**（本例只是把原来的顶层语句搬进 `main()`）。 */
function main() {
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const env = require('./env');
const { createRunner } = require('./lib/assert');

env.assertRuntime();
const t = createRunner('平台适配层自检（platform-check）');
const ROOT = env.paths.root;

/** 在指定 DSH_ENV 下重新加载 platform/paths（进程内换环境，不靠读源码猜） */
function loadPathsUnder(envName) {
  const prev = process.env.DSH_ENV;
  process.env.DSH_ENV = envName;
  const abs = require.resolve('../platform/paths');
  delete require.cache[abs];
  try {
    return require(abs);
  } finally {
    if (prev === undefined) delete process.env.DSH_ENV; else process.env.DSH_ENV = prev;
    delete require.cache[abs];
  }
}

/**
 * 在独立 vm 上下文里按浏览器脚本方式加载 `src/services/api.js`（R26-P3-3 跨界对账用）。
 * 手法与 `tests/ui-check.js` 的夹具一致（`vm.createContext` + 假 `window`）：api.js 是
 * `window.Api = (function(){...})()` 的 IIFE，只依赖 `window.BoardConfig` / `window.FieldMap`，
 * **不碰 DOM**，故无需桩件即可跑**真源码** —— 跨界对账要的是浏览器侧真实现，不能靠读源码猜。
 * 每次调用返回**全新实例**（序号状态是模块级闭包变量，跨用例复用会互相干扰）。
 */
function loadBrowserApi() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const run = rel => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox,
    { filename: path.join(ROOT, rel) });
  run('src/config/board.config.js');
  run('src/config/fieldMap.js');
  run('src/services/api.js');
  return sandbox.window.Api;
}

/* ---------------- 一、路径与三套环境隔离 ---------------- */
t.section('一、路径与三套环境隔离（ADR-0002 D11 / ADR-0003 D16）');
{
  const pDev = loadPathsUnder('dev');
  t.info(`仓库根：${pDev.ROOT}`);
  t.check('ROOT 指向真正的仓库根（含 PROJECT_RULES.md / index.html / tests）',
    ['PROJECT_RULES.md', 'index.html', 'tests'].every(m => fs.existsSync(path.join(pDev.ROOT, m))),
    `ROOT=${pDev.ROOT}`);
  t.check('三套环境的数据目录两两不同（dev/test/prod 不互相覆盖）',
    new Set(Object.values(pDev.DATA_ROOT)).size === 3,
    Object.entries(pDev.DATA_ROOT).map(([k, v]) => `${k}=${path.basename(path.dirname(v))}`).join(' / '));
  t.check('dev/prod 数据目录都在仓库根之内（曾因 ROOT 少退一层落到仓库外）',
    pDev.isInside(pDev.ROOT, pDev.DATA_ROOT.dev) && pDev.isInside(pDev.ROOT, pDev.DATA_ROOT.prod),
    `dev=${path.relative(pDev.ROOT, pDev.DATA_ROOT.dev)}`);
  const pTest = loadPathsUnder('test');
  t.check('test 数据目录在 tests\\._verify 之内（D16：测试唯一允许写的地方）',
    pTest.isInside(path.join(pTest.ROOT, 'tests', '._verify'), pTest.DATA_ROOT.test),
    `test=${path.relative(pTest.ROOT, pTest.DATA_ROOT.test)}`);
  t.check('paths 暴露的 dbFile/backupDir/logDir/exportDir 都挂在当前 dataRoot 下',
    [pDev.paths.dbFile, pDev.paths.backupDir, pDev.paths.logDir, pDev.paths.exportDir]
      .every(p => pDev.isInside(pDev.paths.dataRoot, p)),
    path.relative(pDev.ROOT, pDev.paths.dataRoot));
  t.check('test 环境下 overrideDataRoot 拒绝越界（防止测试写进真实数据目录）',
    (() => {
      try { pTest.overrideDataRoot(path.join(pTest.ROOT, 'data', 'test')); return false; }
      catch { return true; }
    })(), '越界覆盖必须抛错');
  t.check('非法 DSH_ENV 会被断言拒绝（不是静默落到 dev）',
    (() => { try { loadPathsUnder('staging'); return false; } catch { return true; } })(),
    'DSH_ENV=staging 必须抛错');
  t.check('平台代码里没有盘符路径（D11：本地路径不得硬编码）',
    !/[A-Za-z]:\\/.test(fs.readFileSync(path.join(ROOT, 'platform', 'paths.js'), 'utf8')),
    'paths.js 只允许用 path.join/resolve');
}

/* ---------------- 二、uploadId 生成与校验 ---------------- */
t.section('二、uploadId 生成与校验（附录 2 / IF-B 去重与回执核对）');
{
  const { createUploadIdGenerator, localId, isUploadId } = require('../platform/id');
  const fixed = new Date('2026-09-19T10:20:30');
  const clock = { now: () => new Date(fixed.getTime()) };
  const gen = createUploadIdGenerator({ clock });

  const first = gen.next();
  const second = gen.next();
  t.check('uploadId 形如 UP + yyyyMMddHHmmss + 3 位序号（总长 19）',
    /^UP20260919102030\d{3}$/.test(first) && /^UP20260919102030\d{3}$/.test(second),
    `实测 ${first} / ${second}（长度 ${first.length}）`);
  t.check('同秒内连续调用靠 3 位序号区分（不重复）',
    first !== second && Number(second.slice(16)) === Number(first.slice(16)) + 1,
    `序号 ${first.slice(16)} → ${second.slice(16)}`);
  t.check('isUploadId 认自己生成的 id',
    isUploadId(first).ok === true, isUploadId(first).reason);
  t.check('isUploadId 拒绝错误形状（前缀/长度/非法时间/序号越界/非字符串）',
    (() => {
      const bad = ['UP20260919102030001x', 'XX20260919102030001', 'UP2026091910203', 
        'UP20261319102030001', 'UP20260919102030000', 'UP20260919102030999', 12345, null];
      /* 注意 UP…999 是合法的（序号上限 999），用它验证"边界内通过"而不是当非法样本 */
      const rejected = bad.filter(v => isUploadId(v).ok === false).length;
      return rejected === bad.length - 1 && isUploadId('UP20260919102030999').ok === true;
    })(), '非法样本应被拒，且序号 999 属合法边界');
  t.check('localId 带前缀且两次调用不重复',
    localId('probe', clock).startsWith('probe-') && localId('probe', clock) !== localId('probe', clock),
    localId('probe', clock));

  /* ---------------- R26-P3-3：口径统一后的守线断言 ---------------- */
  /* 立案事实（`项目记录\审查报告-2026-09-26.md` P3-3）：id.js 按日重置、域 1～999、判 `000` 非法；
     api.js 用 `%1000` 第 1000 次起产 `…000` 且不按日重置 ⇒ 同一系统两个生成器形状不完全互换、
     声明"保持一致"不实。下方三条分别守住：生成侧、判定侧、跨界对账。 */

  /** 取 uploadId 的 3 位序号（UP + 14 位时间 = 前 16 字符） */
  const seqOf = id => Number(String(id).slice(16));

  /* ① 生成侧：连跑 1000 次（跨过 999 回绕点）不出现 000、序号恒在 1～999 */
  const walk = createUploadIdGenerator({ clock });
  const ids = [];
  for (let i = 0; i < 1000; i++) ids.push(walk.next());
  const zeroSeq = ids.filter(id => seqOf(id) === 0);
  const outOfDomain = ids.filter(id => !(seqOf(id) >= 1 && seqOf(id) <= 999));
  t.info(`实测：id.js 连跑 1000 次 —— 后缀 …000 出现 ${zeroSeq.length} 次；序号越界 ${outOfDomain.length} 次；` +
    `示例 ${ids[0]} / 第 999 次 ${ids[998]} / 第 1000 次（回绕）${ids[999]}`);
  t.check('①id.js 连跑 1000 次不产生 000 后缀、序号恒在 1～999（含第 1000 次回绕）',
    ids.length === 1000 && zeroSeq.length === 0 && outOfDomain.length === 0,
    `…000 ${zeroSeq.length} 次、越界 ${outOfDomain.length} 次`);

  /* ① 跨日重置：可注入时钟直接跨过零点（不靠"等一天"） */
  let dayMs = new Date('2026-09-19T23:59:59').getTime();
  const dayGen = createUploadIdGenerator({ clock: { now: () => new Date(dayMs) } });
  const beforeDay = [dayGen.next(), dayGen.next()];
  dayMs = new Date('2026-09-20T00:00:00').getTime();
  const afterDay = [dayGen.next(), dayGen.next()];
  t.check('①跨日自动重置：跨日前续号、跨日后首号回到 001（日期前缀同步换日）',
    seqOf(beforeDay[1]) === 2 && afterDay[0] === 'UP20260920000000001' && seqOf(afterDay[1]) === 2,
    `${beforeDay[1]} → ${afterDay[0]}（次号 ${afterDay[1]}）`);

  /* ② 判定侧：isUploadId 与生成口径一一对应（生成的必合法；人工构造的 …000 必非法） */
  t.check('②isUploadId 与生成口径一一对应：生成的 1000 个全部判合法',
    ids.every(id => isUploadId(id).ok === true),
    `首个不合法样本：${ids.find(id => !isUploadId(id).ok) || '（无）'}`);
  t.check('②序号域逐项核对：001～999 全部判合法、000 判非法（与"永不产生 000"同一条线）',
    Array.from({ length: 999 }, (_, i) => String(i + 1).padStart(3, '0'))
      .every(s => isUploadId(`UP20260919102030${s}`).ok === true) &&
    isUploadId('UP20260919102030000').ok === false,
    `000 的判定：${isUploadId('UP20260919102030000').reason}`);

  /* ③ 跨界对账：把浏览器侧 api.js 的**真源码**在 vm 里跑起来（夹具见文件上方 loadBrowserApi） */
  const Api = loadBrowserApi();
  if (t.requires('浏览器侧 api.js 能在 vm 里加载并暴露 nextUploadId（无 DOM 依赖）',
    !!Api && typeof Api.nextUploadId === 'function', 'Api.nextUploadId 缺失（契约被改？）')) {
    const apiIds = [];
    for (let i = 0; i < 1000; i++) apiIds.push(Api.nextUploadId(fixed));
    const apiZero = apiIds.filter(id => seqOf(id) === 0);
    const apiOutOfDomain = apiIds.filter(id => !(seqOf(id) >= 1 && seqOf(id) <= 999));
    t.info(`实测：api.js（vm 真源码）连跑 1000 次 —— 后缀 …000 出现 ${apiZero.length} 次；` +
      `序号越界 ${apiOutOfDomain.length} 次；示例 ${apiIds[0]} / 第 1000 次（回绕）${apiIds[999]}`);

    let firstDiff = -1;
    for (let i = 0; i < ids.length; i++) if (apiIds[i] !== ids[i]) { firstDiff = i; break; }
    t.check('③跨实现对账：两侧对同一输入序列产出**逐字节相同**的 uploadId（格式与序号规则同源）',
      firstDiff === -1,
      firstDiff === -1 ? `1000/1000 逐字节相同（样例 ${apiIds[0]}）`
        : `第 ${firstDiff + 1} 次不同：id.js=${ids[firstDiff]} vs api.js=${apiIds[firstDiff]}`);
    t.check('③浏览器侧同样不产生 000、序号恒在 1～999（连跑 1000 次）',
      apiZero.length === 0 && apiOutOfDomain.length === 0,
      `…000 ${apiZero.length} 次、越界 ${apiOutOfDomain.length} 次`);

    /* 跨日重置：另起一个全新 api.js 实例（序号状态是模块级闭包，不能与上面的 1000 次共用） */
    const ApiDay = loadBrowserApi();
    const apiDayBefore = [ApiDay.nextUploadId(new Date('2026-09-19T23:59:59')),
      ApiDay.nextUploadId(new Date('2026-09-19T23:59:59'))];
    const apiDayAfter = [ApiDay.nextUploadId(new Date('2026-09-20T00:00:00')),
      ApiDay.nextUploadId(new Date('2026-09-20T00:00:00'))];
    t.check('③浏览器侧按日重置：与 id.js 同一跨日边界，次日首号回到 001',
      seqOf(apiDayBefore[1]) === 2 && apiDayAfter[0] === 'UP20260920000000001' &&
      seqOf(apiDayAfter[1]) === 2,
      `${apiDayBefore[1]} → ${apiDayAfter[0]}（次号 ${apiDayAfter[1]}）`);
    t.check('③浏览器侧产物全部通过 id.js 的 isUploadId（去重与回执核对同一判据）',
      apiIds.every(id => isUploadId(id).ok === true) &&
      apiDayAfter.every(id => isUploadId(id).ok === true),
      `首个不合法样本：${apiIds.find(id => !isUploadId(id).ok) || '（无）'}`);
  }
}

/* ---------------- 三、日志：分级 / 按日滚动 / 保留 ---------------- */
t.section('三、日志分级、按日滚动与保留清理（NFR-21）');
{
  const { createLogger } = require('../platform/log');
  const logDir = path.join(env.ensureDir(env.paths.tempRoot), `platform-log-${process.pid}-${Date.now()}`);
  fs.mkdirSync(logDir, { recursive: true });

  let nowMs = new Date('2026-09-19T09:00:00').getTime();
  const clock = { now: () => new Date(nowMs) };
  const lg = createLogger({ dir: logDir, clock, level: 'info', console: false });

  lg.debug('这条不该落盘');
  lg.info('普通信息');
  lg.error('出错', { code: 500 });
  const files = lg.list();
  t.check('低于 level 的日志被过滤，info 及以上落盘',
    files.length === 1 && fs.readFileSync(path.join(logDir, files[0]), 'utf8').includes('普通信息') &&
    !fs.readFileSync(path.join(logDir, files[0]), 'utf8').includes('不该落盘'),
    `文件 ${files.join('、')}`);
  t.check('附加对象被序列化进日志（含 code=500）',
    fs.readFileSync(path.join(logDir, files[0]), 'utf8').includes('500'), '');
  t.check('日志文件名按日期滚动（含 yyyy-MM-dd）',
    /^2026-09-19\.log$/.test(files[0]), files[0]);
  t.check('循环引用不会把日志写崩（降级为占位文本）',
    (() => {
      const a = {}; a.self = a;
      lg.info('循环引用', a);
      return fs.readFileSync(path.join(logDir, files[0]), 'utf8').includes('无法序列化');
    })(), '');

  nowMs = new Date('2026-09-20T09:00:00').getTime();
  lg.info('次日信息');
  t.check('跨日写入新文件（当天两个日期文件都来自本用例，不含伪造的旧文件）',
    lg.list().filter(n => /^\d{4}-\d{2}-\d{2}\.log$/.test(n)).length === 2,
    lg.list().join('、'));

  /* 伪造一个"很久以前"的日志（放在跨日断言之后，避免干扰它的计数） */
  const old = path.join(logDir, '2026-01-01.log');
  fs.writeFileSync(old, '很久以前\n', 'utf8');
  const past = new Date('2026-01-01T00:00:00');
  fs.utimesSync(old, past, past);

  const pruned = lg.prune();
  t.check('prune() 删掉超 keepDays 的日志、保留期内的不动',
    pruned.removed.includes('2026-01-01.log') && fs.existsSync(path.join(logDir, '2026-09-20.log')),
    `删除 ${pruned.removed.join('、')}，保留 ${pruned.kept}`);
  t.check('prune() 返回可审计信息（删除清单/保留数/截止时间/保留天数）',
    Array.isArray(pruned.removed) && Number.isInteger(pruned.kept) &&
    pruned.cutoff instanceof Date && pruned.keepDays === 30, `keepDays=${pruned.keepDays}`);

  t.check('单文件超 maxBytes 时换序号文件（避免单个日志无限增长）',
    (() => {
      const small = path.join(logDir, 'small');
      fs.mkdirSync(small, { recursive: true });
      const lg2 = createLogger({ dir: small, clock, console: false, maxBytes: 80 });
      for (let i = 0; i < 6; i++) lg2.info(`填充行 ${i} 用于超过 ${80} 字节上限`);
      return lg2.list().length >= 2;
    })(), '应出现 -1.log 之类的序号文件');

  /* `E117`（2026-10-04）：`env.removeLinkSafe()` —— 判"目录项自身"是不是链接（是则只拆链、不递归），
     非链接时与 `fs.rmSync(recursive)` 逐字等价。`logDir` 由本节 `fs.mkdirSync` 自建，结构上不可能是链接；
     本脚本仍**不加载** `lib/harness.js`（用 `env` 已导出的同名函数，不新增依赖）。 */
  try { env.removeLinkSafe(logDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  /* `T-20261003-10`（2026-10-03）单一真源化后，`env.paths.tempRoot` 是**本轮专属**目录
     （定义在 `tests/env.js`：`<公共根>\run-<pid>-<启动时刻>-<4hex>`）—— 收口前本脚本
     看到的还是公共根。本脚本**不加载** `lib/harness.js`，故没人替它收尾本轮目录。
     上面已删掉本节自建的日志目录，这里**只在本轮目录已空时**把它一并收掉，免得每跑一次
     就在公共根下留一个空目录（与 `preflight` 收掉写探针那一轮同一理由，P3-14）。
     `rmdirSync` **非递归**：目录非空（还有别的产物）或已不存在 ⇒ 抛错被吞 ⇒
     那些产物归公共根的 **2 小时**清扫（`env.cleanupStaleTemp`；窗口＝`env.STALE_MAX_AGE_MS`
     ＝`2*3600*1000`，且判据是"**年龄 > 2h 且该轮次名字里的 pid 不存活**"**双条件** ——
     `T-20261005-37`（2026-10-05 负责人裁定）由 24h 收到 2h），绝不误删他物。 */
  try { fs.rmdirSync(env.paths.tempRoot); } catch { /* 非空或已不在：交给 2h 清扫 */ }
}

  t.finish();
}

/* 与既有脚本一致：异常以退出码 2 结束（打印行含字面 `脚本异常终止`，`run-all` 的失败明细据此命中） */
try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
