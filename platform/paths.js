/* ==========================================================================
   路径与运行环境（platform/paths.js）
   作用：**业务代码不得出现硬编码路径**（ADR-0002 D11）—— 数据目录、日志目录、备份目录
        一律从这里取；`DSH_ENV` 决定用哪一套目录（ADR-0003 D16）。
   环境：dev（默认）｜ test（自检专用，落 tests/._verify/data/test）｜ prod（交付运行）
   依赖：仅 node:fs / node:path。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/* 仓库根目录。
   ⚠ 级数易错：__dirname 已是 `<仓库>\platform`，故只需退 **一级**。
   曾经误写成 `resolve(__dirname,'..','..')`（P1-1），把根解析到仓库的**上一级**，
   导致 dev/prod 数据目录落到仓库外、test 目录也不在 ADR-0003 D16 声明的位置。
   现在由下方 assertLayout() 在加载时自证，改错会立刻炸而不是悄悄写歪。 */
const ROOT = path.resolve(__dirname, '..');
const ENV_NAME = process.env.DSH_ENV || 'dev';

/** 三套环境的数据根目录 */
const DATA_ROOT = {
  dev: path.join(ROOT, 'data', 'dev'),
  test: path.join(ROOT, 'tests', '._verify', 'data', 'test'),
  prod: path.join(ROOT, 'data', 'prod')
};

/** target 是否位于 base 之内（含 base 自身） */
function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 自校验目录布局，**加载时立即执行**（与 tests/env.js 的 assertRuntime 同思路）。
 * 依据：ADR-0003 D16 —— 三套目录必须各就各位，测试只允许写 `tests\._verify\data\test`。
 * 不满足时抛错并终止：路径写歪会让数据落到仓库外/生产目录，属于"宁可直接停下"的错误。
 */
function assertLayout() {
  const problems = [];
  /* 仓库根必须真的像仓库根，防"少退/多退一层"复发。
     注意：本项目**零 npm 依赖、没有 package.json**（ADR-0001 D4），别拿它当标志物。
     标志物取"仓库独有且必然存在"的文件：PROJECT_RULES.md / index.html / tests 目录。 */
  for (const marker of ['PROJECT_RULES.md', 'index.html', 'tests']) {
    if (!fs.existsSync(path.join(ROOT, marker))) {
      problems.push(`仓库根 ${ROOT} 下找不到 ${marker} —— ROOT 层级算错了？`);
    }
  }
  for (const [name, dir] of Object.entries(DATA_ROOT)) {
    if (!isInside(ROOT, dir)) problems.push(`${name} 数据目录落到仓库外：${dir}`);
  }
  /* test 必须落在 tests/._verify 之内（D16：测试唯一允许写的地方） */
  if (!isInside(path.join(ROOT, 'tests', '._verify'), DATA_ROOT.test)) {
    problems.push(`test 数据目录不在 tests\\._verify 之内：${DATA_ROOT.test}`);
  }
  if (!DATA_ROOT[ENV_NAME]) {
    problems.push(`DSH_ENV 取值非法：${ENV_NAME}（只允许 dev | test | prod）`);
  }
  if (problems.length) {
    console.error('\n[路径布局自检未通过] platform/paths.js（ADR-0002 D11 / ADR-0003 D16）');
    for (const p of problems) console.error(`  - ${p}`);
    throw new Error(`路径布局自检未通过：${problems[0]}`);
  }
}

assertLayout();

const env = {
  name: ENV_NAME,
  isTest: ENV_NAME === 'test',
  isProd: ENV_NAME === 'prod',
  isDev: ENV_NAME === 'dev' || !DATA_ROOT[ENV_NAME]
};

const dataRoot = DATA_ROOT[ENV_NAME] || DATA_ROOT.dev;

/** 全部对外路径；**改路径只改这里** */
const paths = {
  root: ROOT,
  env: env.name,
  dataRoot,
  dbFile: path.join(dataRoot, 'board.db'),
  backupDir: path.join(dataRoot, 'backup'),
  logDir: path.join(dataRoot, 'log'),
  exportDir: path.join(dataRoot, 'export')
};

/** 确保目录存在（递归创建） */
function ensureDirs() {
  for (const p of [paths.dataRoot, paths.backupDir, paths.logDir, paths.exportDir]) {
    fs.mkdirSync(p, { recursive: true });
  }
  return paths;
}

/** 覆盖数据根目录（自检注入临时目录时用；不改其他路径的语义） */
function overrideDataRoot(dir) {
  const resolved = path.resolve(dir);
  /* test 环境下拒绝把数据根覆盖到 tests\._verify 之外（ADR-0003 D16：
     测试进程绝不允许指向生产/仓库内其他真实数据目录） */
  if (env.isTest && !isInside(path.join(ROOT, 'tests', '._verify'), resolved)) {
    throw new Error(`DSH_ENV=test 时数据根必须落在 tests\\._verify 之内，收到：${resolved}`);
  }
  paths.dataRoot = resolved;
  paths.dbFile = path.join(paths.dataRoot, 'board.db');
  paths.backupDir = path.join(paths.dataRoot, 'backup');
  paths.logDir = path.join(paths.dataRoot, 'log');
  paths.exportDir = path.join(paths.dataRoot, 'export');
  return paths;
}

module.exports = { ROOT, DATA_ROOT, env, paths, ensureDirs, overrideDataRoot, assertLayout, isInside };
