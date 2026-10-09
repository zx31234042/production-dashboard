/* ref-check.js —— 「路径型引用」可复跑核验器（规则 R）· 零依赖 · `tools\ref-check.js`（`E208` 的交付物）
 * 用途（`E208`）：把 `输出文件\交付物提纲-2026-10-03\⑩-用户操作手册与运维手册-提纲.md:306`
 *   那句无法复现的「反引号路径型引用 51 条…全部命中（失败 0 条）＝ 100%」换成**按规则 R 实测**的口径。
 * **不是门禁**（不在 `tests\run-all.js` 的 suite 清单里、不计入权威区条数）：它是**交付物文档的自检工具**，
 *   由那份提纲的收口句给出可复跑命令；是否接门禁归技术债 `E57`／`E193`（本仓纪律：**不新增元机制**）。
 *
 * ── 规则 R（v1，逐条可判） ──────────────────────────────────────────────
 *  R1 取数面：目标 `.md` 文件里，**同一行内成对反引号**包裹的行内代码段（`` `…` ``）；跨行不取。
 *  R2 候选形态（全部满足才算"路径型引用"）：
 *     a) 含路径分隔符 `\` 或 `/`；
 *     b) 不含任何空白；
 *     c) **不是任何 URL**（`^[a-z][a-z0-9+.-]*://` ⇒ 排除，含 `file://`）；
 *     d) 末段（去掉结尾分隔符后）非空、且含至少一个字母/数字/汉字，且**形如**「含 `.` 扩展名」或「以分隔符结尾（目录）」或「含省略号 `…`」
 *        —— **绝对路径（盘符 `C:\`／UNC `\\`）例外：不论扩展名一律入面**（现场路径如 `D:\production-dashboard` 无扩展名，不能漏）；
 *  R3 判定（**逐条分类，全部可见**）：
 *     ① EXTERNAL  盘符绝对路径（`C:\…`）或 UNC（`\\…`）⇒ 用真实存在性核，缺失归 `EXTERNAL-MISSING`（**单独一档**，
 *        不计入"本仓失败"，但**必须打印**）；
 *     ② GLOB      含 `*`／`?` ⇒ **展开后核命中数**（`-LiteralPath` 对通配**不适用** —— 这正是 `E208` 点名的第 2／3 条不成立项）；
 *        仅支持**末段**通配；通配出现在中间段 ⇒ 记 `GLOB-COMPLEX`（**明示未判定**，不静默放过）；
 *     ③ ABBREV    含 `…` ⇒ 把 `…` 当 `*` 展开：**恰命中 1** ⇒ 解析为该路径并核存在；**0 命中** ⇒ 失败（陈旧/不存在）；
 *        **>1 命中** ⇒ 失败（歧义）；
 *     ④ EXIST     仓库内相对路径 ⇒ 存在即通过；
 *     ⑤ MISSING   其余 ⇒ 失败。
 *  R4 计数口径：**条**＝唯一化后的不同 token 数；**处**＝出现次数（原句只写"51 条"属口径不明，新口径两者都给）。
 *  R5 退出码：**失败（MISSING ＋ ABBREV-0/歧义 ＋ GLOB-0）> 0 ⇒ 1**；否则 0。`EXTERNAL-MISSING` 与 `GLOB-COMPLEX`
 *     计入"待人工看"读数，**不计入**退出码（它们是"仓外/未判定"，不是"本仓引用错"）。
 *
 * 用法：node tools\ref-check.js <md文件> [--list] [--json] [--self-test]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = (() => {
  const i = process.argv.indexOf('--root');
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  return path.resolve(__dirname, '..');
})();

const EXT_OK = /\.(md|js|ps1|cmd|bat|json|jsonl|txt|csv|sql|png|jpg|jpeg|gif|svg|docx|xlsx|pptx|zip|rar|7z|msi|exe|db|log|yml|yaml|html|css|xml|ini|conf|map|pem|cer|sha256|sh|py|ts)$/i;

function isPathRef(tok) {
  if (!/[\\/]/.test(tok)) return false;                    // R2a
  if (/\s/.test(tok)) return false;                        // R2b
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(tok)) return false;  // R2c（含 `file://`，2026-10-09 实测：它曾被判 MISSING ＝ 假阳）
  if (tok.length > 400) return false;
  const isAbs = /^[A-Za-z]:[\\/]/.test(tok) || /^\\\\/.test(tok);
  const stripped = tok.replace(/[\\/]+$/, '');
  const last = stripped.split(/[\\/]/).pop() || '';
  if (!last) return false;                                 // R2d 末段非空
  if (!/[A-Za-z0-9\u4e00-\u9fa5]/.test(last)) return false; // 至少一个字母/数字/汉字（排掉 `\\`、`\|` 这类）
  if (isAbs) return true;                                  // R2d 绝对路径例外（不论扩展名）
  const isDir = /[\\/]$/.test(tok);
  const hasEllipsis = tok.includes('…');
  if (!isDir && !hasEllipsis && !EXT_OK.test(last)) return false; // R2d 形态
  return true;
}

/** 抽取消：返回 [{token, line}]（同一行内成对反引号；行内多次出现各记一次） */
function extractRefs(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const re = /`([^`]+)`/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const tok = m[1].trim();
      if (isPathRef(tok)) out.push({ token: tok, line: i + 1 });
    }
  });
  return out;
}

/** 通配展开（仅末段支持 `*`／`?`）；返回 {hits:[相对路径], complex:boolean} */
function globLastSeg(rel) {
  const norm = rel.replace(/\//g, '\\');
  const segs = norm.split('\\');
  const last = segs.pop();
  const dirSegs = segs.filter((s) => s !== '');
  if (dirSegs.some((s) => /[*?]/.test(s))) return { hits: [], complex: true };
  const dirRel = dirSegs.join('\\');
  const abs = path.join(ROOT, dirRel);
  let names;
  try { names = fs.readdirSync(abs); } catch { return { hits: [], complex: false }; }
  const re = new RegExp('^' + last.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '[^\\\\/]') + '$', 'i');
  return { hits: names.filter((n) => re.test(n)).map((n) => (dirRel ? dirRel + '\\' + n : n)), complex: false };
}

function classify(token) {
  if (/^[A-Za-z]:[\\/]/.test(token) || /^\\\\/.test(token)) {                 // ① EXTERNAL
    return { kind: 'EXTERNAL', ok: fs.existsSync(token), hits: [] };
  }
  if (/[*?]/.test(token)) {                                                  // ② GLOB
    const g = globLastSeg(token);
    if (g.complex) return { kind: 'GLOB-COMPLEX', ok: null, hits: [] };
    return { kind: 'GLOB', ok: g.hits.length > 0, hits: g.hits };
  }
  if (token.includes('…')) {                                                 // ③ ABBREV
    const g = globLastSeg(token.replace(/…/g, '*'));
    if (g.complex) return { kind: 'GLOB-COMPLEX', ok: null, hits: [] };
    if (g.hits.length !== 1) return { kind: 'ABBREV', ok: false, hits: g.hits, why: g.hits.length === 0 ? '0 命中（陈旧/不存在）' : '命中 ' + g.hits.length + ' 个（歧义）' };
    const abs = path.join(ROOT, g.hits[0]);
    return { kind: 'ABBREV', ok: fs.existsSync(abs), hits: g.hits };
  }
  const abs = path.join(ROOT, token.replace(/\//g, '\\'));                    // ④ EXIST ／ ⑤ MISSING
  const ok = fs.existsSync(abs) || fs.existsSync(abs.replace(/[\\/]+$/, ''));
  return { kind: ok ? 'EXIST' : 'MISSING', ok, hits: [] };
}

function selfTest() {
  const cases = [
    { tok: 'tests\\README.md', want: 'EXIST' },
    { tok: 'tests\\screenshots-baseline\\*.png', want: 'GLOB' },
    { tok: '需求文档\\…-V1.44.md', want: 'ABBREV' },
    { tok: '需求文档\\…-V9.99.md', want: 'ABBREV' },   /* 必须判**失败**（0 命中） */
    { tok: 'no\\such\\file.js', want: 'MISSING' },     /* 必须判**失败** */
    { tok: 'C:\\ProgramData\\USOPrivate\\UpdateStore\\store.db', want: 'EXTERNAL' },
    { tok: 'D:\\production-dashboard', want: 'EXTERNAL' },   /* 无扩展名的绝对路径**必须入面**（现场路径） */
    { tok: 'src\\utils\\format.js', want: 'EXIST' },
    { tok: 'E183-①', want: null },                     /* 非路径 ⇒ 不进面 */
    { tok: '--hours', want: null },
    { tok: '\\t', want: null },
    { tok: 'file://', want: null }                     /* URL 型 ⇒ 不进面（2026-10-09 实测曾误判 MISSING） */
  ];
  let ok = 0; const bad = [];
  for (const c of cases) {
    const inFace = isPathRef(c.tok);
    let got = null;
    if (inFace) got = classify(c.tok).kind;
    if (got === c.want) ok++;
    else bad.push(c.tok + ' ⇒ ' + got + '（期望 ' + c.want + '）');
  }
  console.log('[--self-test] ' + ok + '/' + cases.length + ' 例相符' + (bad.length ? '；不符：' + bad.join('；') : ''));
  return bad.length === 0;
}

function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  if (argv.includes('--self-test')) {
    const pass = selfTest();
    if (!file) process.exit(pass ? 0 : 1);
  }
  if (!file) { console.log('用法：node tools\\ref-check.js <md文件> [--list] [--json] [--self-test]'); process.exit(2); }
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { console.log('[脚本异常] 读不到 ' + abs + '：' + e.message); process.exit(2); }
  const refs = extractRefs(text);
  const uniq = [...new Set(refs.map((r) => r.token))];
  const rows = uniq.map((tok) => {
    const c = classify(tok);
    return { token: tok, kind: c.kind, ok: c.ok, hits: c.hits, why: c.why || '', places: refs.filter((r) => r.token === tok).map((r) => r.line) };
  });
  const tally = {};
  for (const r of rows) tally[r.kind] = (tally[r.kind] || 0) + 1;
  const failed = rows.filter((r) => r.ok === false);
  const extMissing = rows.filter((r) => r.kind === 'EXTERNAL' && !r.ok);
  const complex = rows.filter((r) => r.kind === 'GLOB-COMPLEX');
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ file: path.relative(ROOT, abs), rules: 'R1..R5', tokens: uniq.length, places: refs.length, tally, failed: failed.map((f) => ({ token: f.token, kind: f.kind, lines: f.places, why: f.why })), externalMissing: extMissing.map((f) => f.token), globComplex: complex.map((f) => f.token) }, null, 2));
  } else {
    console.log('=== 规则 R 实测：' + path.relative(ROOT, abs) + ' ===');
    console.log('  条（唯一 token）＝ ' + uniq.length + '｜处（出现次数）＝ ' + refs.length);
    console.log('  分类：' + Object.keys(tally).sort().map((k) => k + ' ' + tally[k]).join('｜'));
    console.log('  失败（应修）＝ ' + failed.length + (failed.length ? '：' : ''));
    for (const f of failed) console.log('    ' + f.kind + '  ' + f.token + '  （行 ' + f.places.join('、') + '）' + (f.why ? '  ' + f.why : ''));
    if (extMissing.length) console.log('  仓外缺失（不计失败、须可见）＝ ' + extMissing.length + '：' + extMissing.map((f) => f.token).join('、'));
    if (complex.length) console.log('  未判定（通配在中间段）＝ ' + complex.length + '：' + complex.map((f) => f.token).join('、'));
    if (argv.includes('--list')) {
      console.log('  ' + '-'.repeat(70));
      for (const r of rows) console.log('  [' + r.kind + '] ' + (r.ok === true ? 'OK  ' : r.ok === false ? 'FAIL' : 'N/A ') + ' ' + r.token + (r.hits.length ? '  ⇒ ' + r.hits.slice(0, 4).join('、') + (r.hits.length > 4 ? ' …(' + r.hits.length + ')' : '') : '') + '  （行 ' + r.places.join('、') + '）');
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main();
