/* ==========================================================================
   数字解析小工具（tests/lib/numeric.js）
   作用：把"门禁数字"从人写的文档里抽出来做机器校验（ADR-0004 D19：断言即证据 ——
         自称"权威值"的数字必须有断言盯着，否则漂移永远不会被拦下）。
   依据：ADR-0004 D19/D20；R-2026-09-19-02 的 P2-14/P2-22。
   依赖：无。
   用法：
     const numeric = require('./lib/numeric');
     numeric.matchNumber('合计 **441 通过**', /合计\s*\*\*(\d+)\s*通过/);   // → 441
     numeric.sumScriptCounts('`a-check` **58/0**，`b-check` 40/0');        // → 98
   ========================================================================== */
'use strict';

/**
 * 取正则第一个捕获组并转成数字；不匹配或非数字返回 null。
 * @param {string} text
 * @param {RegExp} re 必须含至少一个捕获组
 * @returns {number|null}
 */
function matchNumber(text, re) {
  const m = String(text || '').match(re);
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 汇总一行文字里"`脚本名` 通过/失败"形式的通过数之和。
 *
 * 能吃的写法（README 权威区实际出现过的那几种）：
 *   `contract-check` **58/0**
 *   `ui-check` 40/0（+1 跳过；加 `--expose-gc` 为 41/0）
 *   `docs-check` **42/2**（**2 项＝…**）
 *   **`logic-check` 52/0**
 * 关键点：**加粗标记在脚本名前后都可能出现**，且脚本名后可能紧跟括号说明 ——
 * 这两个坑都踩过，故用容错正则并在括号前截断。
 *
 * 为什么不把 `--expose-gc` 的 41/0 也算进来：它在括号内（附加说明），
 * 主口径取括号外那个数（与 `run-all` 的默认口径一致）。
 *
 * @param {string} line
 * @returns {number} 通过数之和；解析不到任何一条返回 0
 */
function sumScriptCounts(line) {
  const text = String(line || '');
  const found = text.match(/`[a-z0-9-]+`\s*\*{0,2}\s*\d+\s*\/\s*\d+/g) || [];
  let sum = 0;
  for (const frag of found) {
    const m = frag.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) sum += Number(m[1]);
  }
  return sum;
}

module.exports = { matchNumber, sumScriptCounts };
