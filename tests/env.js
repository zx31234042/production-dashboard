/* ==========================================================================
   测试环境常量与校验（tests/env.js）
   作用：集中定义测试侧的环境开关、路径与运行时下限，供 tests/ 下所有脚本引用。
        业务代码**不得**引用本文件（业务走 platform/paths.js）。
   依据：ADR-0003（测试环境）D16 环境与目录隔离、D17 夹具与临时库策略；规范 9.5-5。
   依赖：仅 Node 内置模块。
   用法：const env = require('./env');  env.assertRuntime();  env.paths.testData
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ---------------- 运行时下限 ----------------
   node:sqlite 在 Node 22.5+ 存在但为实验性（需 --experimental-sqlite），Node 24 起免标志。
   见 ADR-0001 附件《依赖完备性核查》与 ADR-0002 D10。 */
const MIN_NODE_MAJOR = 24;

/** 解析 "v24.21.0" → 24 */
function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

/**
 * 校验运行时下限与测试环境安全性；不满足时**直接退出**（不是断言失败）。
 * 调用时机：每个测试脚本的第 3 行（require 之后立刻调用）。
 */
function assertRuntime() {
  const major = nodeMajor();
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    console.error(`\n[环境不满足] 需要 Node >= ${MIN_NODE_MAJOR}（当前 ${process.version}）。`);
    console.error(`原因：node:sqlite 在 Node 22.x 需 --experimental-sqlite，Node 24 起免标志（ADR-0002 D10）。`);
    process.exit(2);
  }
  /* D16：测试进程绝不允许指向生产数据目录 —— 宁可直接停下，也不能冒险写脏真实数据 */
  if (ENV_NAME === 'prod') {
    console.error('\n[环境不满足] DSH_ENV=prod：测试脚本拒绝在**生产环境**下运行（ADR-0003 D16）。');
    console.error('原因：测试会创建/删除临时库与样本数据，必须在 test 环境下执行。');
    process.exit(2);
  }
}

/* ---------------- 退出码契约（规范 9.5-5 第 6 条：跑不了必须显式跳过） ----------------
   0 = 全部断言通过（允许 0 项"跳过"的断言，如 ui-check 的需浏览器单项）
   1 = 有断言失败
   2 = 脚本自身异常（环境不满足导致的运行时错误、未捕获异常）
   3 = **本环境跑不了**，整脚本显式跳过 —— runner 据此归类为"跳过"，绝不计入通过
   为什么单独给 3：SKIP 场景过去以 0 退出，runner 只能靠子进程输出文本猜，
   而受限沙箱下输出可能拿不到（管道 EPERM），于是一个断言都没跑的脚本被记成 PASS。
   现有脚本**只用**这三个函数发退出码，不要在脚本里手写 process.exit(0/1/2/3)。 */
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_ERROR = 2;
const EXIT_ENV_SKIP = 3;

/* ---------------- 环境与路径 ---------------- */
const ENV_NAME = process.env.DSH_ENV || 'dev';                 // dev | test | prod
const ROOT = path.resolve(__dirname, '..');                    // 仓库根目录
const TESTS = path.join(ROOT, 'tests');

/** 测试可写区（已被 .gitignore 忽略）；临时库、日志、截图都落在这里 */
const VERIFY = path.join(TESTS, '._verify');

const paths = {
  root: ROOT,
  tests: TESTS,
  verify: VERIFY,                                              // 自检产物总目录（已忽略）
  tempRoot: path.join(VERIFY, 'tmp'),                          // 临时库与临时目录
  testData: path.join(VERIFY, 'data', 'test'),                 // D16：测试唯一允许写的数据目录
  captures: path.join(VERIFY, 'captures'),                     // 截图候选目录（screenshot-diff 默认读这里）
  baseline: path.join(TESTS, 'screenshots-baseline')           // 基准图（只读，不要写入）
};

/** 确保目录存在（递归创建） */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 判断路径是否位于测试可写区内（防误写生产数据；供断言与自查使用） */
function isInsideVerify(target) {
  const rel = path.relative(VERIFY, path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 清理过期的临时目录（默认 24 小时前）。
 * 返回 { removed, kept }；异常不抛出，避免影响门禁。
 */
function cleanupStaleTemp(maxAgeMs = 24 * 3600 * 1000) {
  const result = { removed: 0, kept: 0 };
  if (!fs.existsSync(paths.tempRoot)) return result;
  const now = Date.now();
  for (const name of fs.readdirSync(paths.tempRoot)) {
    const full = path.join(paths.tempRoot, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > maxAgeMs) { fs.rmSync(full, { recursive: true, force: true }); result.removed++; }
      else result.kept++;
    } catch { /* 忽略：被别人占用或已删除 */ }
  }
  return result;
}

/** 供日志/报告展示的简短环境摘要 */
function describe() {
  return [
    `Node ${process.version}`,
    `${process.platform}/${process.arch}`,
    `DSH_ENV=${ENV_NAME}`,
    `临时区=${path.relative(ROOT, paths.tempRoot)}`
  ].join(' ｜ ');
}

/* ---------------- 统一结论输出（规范 9.5-5 第 5、6 条） ---------------- */

/**
 * 打印"整脚本因环境不满足而跳过"，并以 EXIT_ENV_SKIP(3) 退出。
 * 输出格式与各脚本内的单项 skip 一致（`[SKIP] 名称 —— 原因`），
 * runner 优先据此归类；**不得**再退 0（那等于把跑不了的说成通过）。
 * @param {string} name   被跳过的东西（通常是"无头 Edge 启动与 CDP 连接"）
 * @param {string} reason 具体原因，必须写清是环境限制
 * @returns {never}
 */
function skipSuite(name, reason) {
  console.log(`  [SKIP] ${name} —— ${reason}`);
  console.log('\n=== 汇总 ===');
  console.log('通过 0 项，失败 0 项，跳过 1 项');
  console.log(`（整脚本跳过：${reason}）`);
  process.exit(EXIT_ENV_SKIP);
}

/**
 * 统一结论行。跳过数为 0 时**不写**"跳过"字段 —— 6.1 的冻结格式是
 * "通过 N 项，失败 N 项，跳过 N 项"，但 ui-check 等脚本已有历史口径，
 * 故此处仅在**真正有跳过**时补出该字段，避免把 0 跳过写成噪音。
 * @param {{passed:number, failed:number, skipped:number}} result
 */
function reportSummary(result) {
  const skipped = Number(result.skipped) || 0;
  const tail = skipped > 0 ? `，跳过 ${skipped} 项` : '';
  console.log('\n=== 汇总 ===');
  console.log(`通过 ${Number(result.passed) || 0} 项，失败 ${Number(result.failed) || 0} 项${tail}`);
}

module.exports = {
  MIN_NODE_MAJOR,
  EXIT_PASS,
  EXIT_FAIL,
  EXIT_ERROR,
  EXIT_ENV_SKIP,
  ENV_NAME,
  paths,
  isTest: ENV_NAME === 'test',
  isProd: ENV_NAME === 'prod',
  tmpdir: os.tmpdir(),
  nodeMajor,
  assertRuntime,
  ensureDir,
  isInsideVerify,
  cleanupStaleTemp,
  describe,
  skipSuite,
  reportSummary
};
