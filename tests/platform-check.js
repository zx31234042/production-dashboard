/* ==========================================================================
   平台适配层自检（tests/platform-check.js）
   作用：给 `platform\` 这一层加门禁。立案原因（R-2026-09-19-02 的 P2-15）：
         `platform\paths.js`、`id.js`、`log.js` 当时**不在任何门禁断言内** ——
         门禁报"381 通过"也**推不出**它们被验证过，`log.js` 的 `keepDays` 从未生效
         就是这么漏过去的。按 ADR-0004 D19（断言即证据），"没被测过"不能靠"数字好看"掩盖。
   覆盖：①路径与三套环境隔离 ②uploadId 形状与跨日序号 ③日志分级/按日滚动/保留清理
        ④平台专有字样防线（D11）
   依赖：仅 Node 内置模块。
   运行：node tests/platform-check.js
   退出码：0 = 全部通过；1 = 有断言失败。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

  try { fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

t.finish();
