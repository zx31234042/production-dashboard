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

const ROOT = path.resolve(__dirname, '..', '..');        // 仓库根目录
const ENV_NAME = process.env.DSH_ENV || 'dev';

/** 三套环境的数据根目录 */
const DATA_ROOT = {
  dev: path.join(ROOT, 'data', 'dev'),
  test: path.join(ROOT, 'tests', '._verify', 'data', 'test'),
  prod: path.join(ROOT, 'data', 'prod')
};

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
  paths.dataRoot = path.resolve(dir);
  paths.dbFile = path.join(paths.dataRoot, 'board.db');
  paths.backupDir = path.join(paths.dataRoot, 'backup');
  paths.logDir = path.join(paths.dataRoot, 'log');
  paths.exportDir = path.join(paths.dataRoot, 'export');
  return paths;
}

module.exports = { ROOT, env, paths, ensureDirs, overrideDataRoot };
