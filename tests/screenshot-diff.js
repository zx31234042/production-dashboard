/* ==========================================================================
   界面基准图比对（tests/screenshot-diff.js）
   作用：把候选截图与 tests/screenshots-baseline/ 的基准逐像素比对，
         按"不同像素占比 ≤ 5%"判定是否通过（阈值与规则见基准目录的 README）。
         D1 自比（基准 vs 基准）必须为 0.00%——用来验证本工具自身的解码与比对无误
         D2 候选比对：逐张给出不同像素占比、最大通道差、是否超阈值
   依赖：仅 Node 内置模块（自实现 PNG 解码：8 位、非隔行、灰度/RGB/RGBA）。
   运行：
         node tests/screenshot-diff.js                                  # 基准 vs tests/._verify
         node tests/screenshot-diff.js --candidate <目录>
         node tests/screenshot-diff.js --baseline <目录> --candidate <目录>
         node tests/screenshot-diff.js --tolerance 0.05 --channel 8     # 阈值与通道容差
         node tests/screenshot-diff.js --self                           # 只做自比（验证工具）
   退出码：0 = 全部通过；1 = 有图超过阈值、或缺图/候选为空；2 = 脚本自身异常。
   注意（P1-3 修复后）：候选目录空或不存在**不再算通过** —— 会以"候选张数/可配对张数"断言失败退 1。
         只有 `--self` 是例外（只验工具自身，不要求候选目录）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const env = require('./env');
env.assertRuntime();

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const BASELINE = path.resolve(ROOT, String(arg('baseline', path.join('tests', 'screenshots-baseline'))));
/* 候选目录默认指向确定性捕获的输出目录（tests\capture-baseline.js 的 --out）；
   注意：基准图是"固定时间+种子随机+冻结定时器"的确定性捕获（1920×1080），
   拿即时截图（4K、时钟与数值在变）来比会被判为尺寸/内容不一致，属预期行为。 */
const CANDIDATE = path.resolve(ROOT, String(arg('candidate', path.join('tests', '._verify', 'captures'))));
const TOLERANCE = Number(arg('tolerance', 0.05));       // 不同像素占比上限
const CHANNEL_TOL = Number(arg('channel', 8));          // 单通道容差（0~255）
const SELF_ONLY = arg('self', false) === true;

/* ---------------- 候选图**新鲜度**（E91：门禁的"绿"必须有依据） ----------------
   立案（`E91`／`E92`，2026-10-02）：本脚本比的是**候选目录**里的 PNG，而不是当场截图；
   而 `run-all.js`／`preflight.js` **都不跑** `capture-baseline`（候选图是否新鲜，只取决于上一次手工捕获）。
   实测后果：至少从 2026-09-28 起，某次 `screenshot-diff 24/0` 用的是**回归之前的候选图** ⇒
   `05bcf7b` 引入的 **4.59%** 真实版面回归**静默通过约 4 天**（`E92` 定量取证）。故本脚本新增
   **fail-closed 的新鲜度断言**：候选图**不得**早于"参与渲染的源码"的最新 mtime。

   口径（本节自定义，写在这里以便复核）：
     · **参与渲染的源码** ＝ `index.html`（脚本注册真源 ＋ 静态 DOM）
                              ＋ `src\**\*.js`（全部前端脚本，含 `config\`／`services\`／`components\`／`pages\`／`utils\`）
                              ＋ `src\**\*.css`（样式）。
       为什么是这三类：本仓无打包器，页面加载的就是这些文件（`ui-check` 的 `indexScriptRels()` 已经证明
       "每个前端脚本都必须被 `index.html` 显式枚举"）—— 它们任何一处变动都可能改变渲染结果。
       **不含** `tests\**`（测试改动不改变渲染）、`项目记录\**` 与文档（同上）、基准 PNG 本身。
     · 判定：**逐张**候选 PNG 的 mtime ≥ `srcNewest − TOLERANCE`；任一张更旧 ⇒ FAIL 并**指名**。
       取"逐张"而不是"最新那张"：一次局部重捕获会留下新旧混杂的候选目录，取最新那张会把旧的放过去。
     · 容差 `FRESH_TOLERANCE_MS = 30 s` 的**理由**（不是随手给的数）：
       捕获流程是"读源码 → 启动 Edge → 逐张截图落盘"，本身要花几秒（本机实测：10 张 PNG 的落盘时间跨度
       约 **6.1 s**，见 2026-10-02 的候选目录 mtime：19:32:44.541 → 19:32:50.690）；而 `src\styles\global.css`
       恰在 19:32:41.612 被改（CSS 修复）⇒ 候选比它晚 **2.93 s**。也就是说"源码在捕获窗口内被改"这件事
       天然无法被候选图反映，30 s 覆盖整个捕获窗口并留足余量。它与要防的失效模式差了 **4 个数量级**
       （`E92` 的现场是 ≈ 4 天 ＝ 345,600 s），不会把"真的陈旧"放过：任何"先改源码、隔一会儿再看门禁"
       的节奏（分钟级）都会被判红。
     · **fail-closed**：候选目录**不存在/为空**时，本组断言一律**红**并给出与陈旧同一条指路提示
       （`node tests\capture-baseline.js --out tests\._verify\captures`）—— 绝不静默通过。
       例外只有 `--self`（只验工具自身，文档口径本就不要求候选目录），与本脚本既有设计一致。 */
const FRESH_TOLERANCE_MS = 30000;
const CAPTURE_HINT = '先跑 `node tests/capture-baseline.js --out tests\\._verify\\captures` 重新捕获候选图 —— ' +
  '候选图不新鲜时，本门禁比的是"陈旧的候选图 vs 基准"，绿得没有依据（E91/E92 的现场就是 4.59% 的回归静默通过约 4 天）';

/** 参与渲染的源码集合（口径见上）：`index.html` ＋ `src\**\*.js` ＋ `src\**\*.css` */
function renderSources() {
  const out = [];
  const html = path.join(ROOT, 'index.html');
  if (fs.existsSync(html)) out.push(html);
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.(js|css)$/i.test(n)) out.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

/** 最新 mtime（毫秒）与其文件（供"指名"用）；取不到返回 null */
function newestSource() {
  let best = null;
  for (const f of renderSources()) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }   // 竞态：刚被删掉的源文件跳过（下一轮会重算）
    if (!best || st.mtimeMs > best.ms) best = { ms: st.mtimeMs, file: f };
  }
  return best;
}

/** 人读的本地时间（毫秒 → `yyyy-MM-dd HH:mm:ss.SSS`） */
function stamp(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:` +
    `${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  [FAIL] ${name}${detail ? ' —— ' + detail : ''}`);
  }
}

/* ---------------- PNG 解码（8 位、非隔行、灰度/RGB/RGBA） ---------------- */
function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`仅支持 8 位非隔行 PNG（实际 bitDepth=${bitDepth} interlace=${interlace}）`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${colorType}（需 灰度/RGB/RGBA）`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const base = y * stride;
    const prevBase = base - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[base + x - channels] : 0;
      const b = y > 0 ? out[prevBase + x] : 0;
      const c = (y > 0 && x >= channels) ? out[prevBase + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) {
        throw new Error(`未知 PNG 行过滤器 ${filter}`);
      }
      out[base + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** 逐像素比对；返回不同像素占比、最大通道差、有效像素数 */
function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeMismatch: true, ratio: 1, maxDelta: 255, pixels: a.width * a.height };
  }
  const ca = a.channels;
  const cb = b.channels;
  const use = Math.min(ca, cb, 3);          // 只比 RGB，忽略 alpha 差异
  let diff = 0;
  let maxDelta = 0;
  const total = a.width * a.height;
  for (let i = 0; i < total; i++) {
    const ia = i * ca;
    const ib = i * cb;
    let differs = false;
    for (let k = 0; k < use; k++) {
      const d = Math.abs(a.data[ia + k] - b.data[ib + k]);
      if (d > maxDelta) maxDelta = d;
      if (d > CHANNEL_TOL) differs = true;
    }
    if (differs) diff++;
  }
  return { sizeMismatch: false, ratio: diff / total, maxDelta, pixels: total, diffPixels: diff };
}

function listPngs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.png')).sort();
}

/* 候选按基准同名配对；不再做"别名映射"，避免把不同口径（4K 即时截图 vs 1080p 确定性基准）拿来比 */
function resolveBaseline(name, baseFiles) {
  return baseFiles.includes(name) ? name : null;
}

/* ---------------- `E202`：`实测：` 行的**归属靠文本、不靠位置**（`T-20261007-09`） ----------------
   立案（复核实测）：本脚本的打印顺序一度是 `实测：…` **在 `check()` 之前**（`console.log` 早于判定），
   于是那一行的**读数归属**只能靠"紧跟着的那条 check"来推 —— 一旦多张图交错、或有人调换两行顺序，
   百分比就挂到了别的图上。修法（已定）＝**把打印挪到 `check()` 之后**，并**在该行里带上文件名**
   （`NN-页面名.png：不同像素 …`）⇒ 归属**靠文本不靠位置**。
   ⚠ **不许删那行**：本文件的本地 `check()` 在**通过分支只打 `[PASS] <名称>`、不打 `detail`**
   ⇒ 绿的时候，这一行是**唯一**能看到不同像素百分比的地方。
   D22（本批三处改动的可证伪要求）：把打印顺序换回旧形态（**内存副本，不落盘**）⇒ 必红并指名；
   故本段用**同一把尺子** `measuredFollowsVerdict()` 往返喂几组**真实捕获过**的行（不是重排的）：
     · 旧形态（`实测：` 在 `check` **之前**，新格式、含文件名）⇒ **必红**（"归属回到靠位置"）；
     · 新形态但**不带文件名** ⇒ **必红**（文本归属必须点名，不许宽松匹配）；
     · 新形态但**姓名被篡改**（`NN-页面名-mutant.png`）⇒ **必红**；
     · 判据自己**先自证**（"连文件名都不认"的冒牌判据在那两组上必须判绿 ⇒ 说明上面两个红不是判据恒假）；
     · 未变异（盘上现测）⇒ 绿。
   ⚠ 条数：本段**只加一处断言**（循环里逐张图各自过同一把尺子、读数收进 `e202Readings`，
   循环后**一次**判定）—— 若按"每张图一条"写，本脚本会 +10 而不是 +1，那是无谓的条数膨胀。
   实测：修前（有候选时）**27/0/0** ⇒ 修后 **28/0/0**（+1；`--self` 口径不变，仍 11 项）。
   > ⚠️ 与 `tests\README.md` 第三节（门禁数字**唯一真源**，写明"有候选时共 24 项"）的
   > 28 项口径差，属**权威区滞后**：按《项目协作与权限说明》第十一节 RACI，该文件归主代理，
   > 座位 4b 不写它 ⇒ 本行只作**事实留痕**，请主代理在收口时同步权威区（本批不改该文件一个字节）。 */
/** 捕获 `console.log`：把一段过程中的输出行收进数组，**同时照旧打印出去**
 *  （`E202` 的修法要求那一行**真的打印**在本图那条 check 之后 ⇒ 观察者不许吞掉它）。
 *  实现：临时把 `console.log` 指向"收一份 ＋ 转交真实 `console.log`"的包装（收尾**恢复**）。 */
function spyCapture(fn) {
  const real = console.log;
  const lines = [];
  console.log = function () {
    lines.push([...arguments].join(' '));
    real.apply(console, arguments);                  /* 照旧打到 stdout（不吞行） */
  };
  try { fn(); } finally { console.log = real; }
  return lines;
}

/** 从捕获到的输出行里取那条 `实测：` 行（找不到 ⇒ `null`）；口径逐字：缩进 8 空格 ＋ `实测：`。 */
function measuredLineOf(lines) {
  return lines.find(l => l.startsWith('        实测：')) || null;
}

/** 该图那条判定的**判定行**（`check()` 的 `[PASS]`／`[FAIL]` 两路都可能） */
function verdictLineOf(lines, verdict) {
  return lines.find(l => l === `  [PASS] ${verdict.name}` || l.startsWith(`  [FAIL] ${verdict.name}`)) || null;
}

/** `E202` 的**同一把尺子**（纯函数）：
 *  ① `实测：` 行必须在**该图那条判定的判定行之后**（＝把打印挪到 check 之后；旧形态在此**必红**）；
 *  ② 该行必须**含该图文件名** ⇒ 归属**靠文本不靠位置**（不带文件名／姓名被篡改 ⇒ 红）；
 *  ③ 该行必须逐字符合新格式（`NN-页面名.png：不同像素 X.XX%（D/P），最大通道差 M`）。
 *  ⚠ **两路输入必须成对**：`captured` 里那些行是**同一次观测**的产物（`order` 校验），
 *  而喂**合成读数**（换序／改名）时必须只喂那一对 —— 否则"文件名 ↔ 判定"会配错对而假红。
 *  @param {{candidate:string, baseline:string}} pair 当前这一对（归属用 `candidate` 的文件名）
 *  @param {{name:string}} verdict 该图那条 check 的实参（`name`）
 *  @param {string[]} captured **同一次观测**里的输出行（真实捕获或合成的一对）
 *  @param {{idx:number, names:string[], lines:string[]}} [live] 观测量纲：本次是第几张（`idx`）、
 *    全部 pair 的文件名（`names`，与 `lines` **同序**）、各次捕获的行数组（`lines`）。
 *    只在判"整体读数与该次观测一致"时需要；喂合成的一对时省略（`idx` 缺省 ⇒ 不做该核）。
 *  @returns {{ok:boolean, why:string}} */
function measuredFollowsVerdict(pair, verdict, captured, live) {
  /* 量纲核：真实观测时 `captured` 必须**就是**该 pair 自己那一次捕获的行（同序对齐）⇒
     防止把"这一张的行"错配到"那一张的判定"上（那正是 `E202` 要防的读数归属问题）。 */
  const orderOk = !live || live.idx === undefined ? true :
    (Array.isArray(live.names) && live.names.length === live.lines.length &&
      live.names[live.idx] === pair.candidate && live.lines[live.idx] === captured);
  const line = measuredLineOf(captured);
  const vline = verdictLineOf(captured, verdict);
  const idxLine = line === null ? -1 : captured.indexOf(line);
  const idxVerdict = vline === null ? -1 : captured.indexOf(vline);
  const fmt = new RegExp(`^ {8}实测：${pair.candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}：不同像素 ` +
    `\\d+\\.\\d{2}%（\\d+\\/\\d+），最大通道差 \\d+$`);
  const ok = orderOk && line !== null && vline !== null && idxVerdict >= 0 && idxLine > idxVerdict && fmt.test(line);
  return { ok, why: `量纲核（该次捕获 ↔ 该 pair）=${orderOk}；` +
    `判定行位置=${idxVerdict} / 实测行位置=${idxLine}（须前者 < 后者：打印在 check 之后）；` +
    `实测行=${line === null ? '（未捕获到）' : JSON.stringify(line)}；` +
    `含该图文件名=${line !== null && line.includes(pair.candidate)}（应 true）、格式逐字合规=${line !== null && fmt.test(line)}（应 true）` };
}

/** **行序守据**（与上面那条**互补**，纯函数）：只看两行**在真实 stdout 里的先后**（不看捕获数组）。
 *  为什么需要它：`check()` 内部就是 `console.log` ⇒ 被 `spyCapture` 一并收走 ⇒
 *  「判定行 vs 实测行」的先后在捕获数组里**照样成立**（它与实现同序）⇒ 单靠捕获数组**分辨不出**
 *  "打印挪到 check 之后"这一步。故本判据读**真实 stdout 文本**（调用方传入），
 *  口径＝两个锚点各自的**字符下标**（`console.log` 的产物与 `check()` 的产物都在真实输出里）：
 *    · 该图那条判定的行（`  [PASS] <name>`／`  [FAIL] <name> —— …`）必须先出现；
 *    · 该图那条 `实测：<文件名>：…` 行必须后出现（**旧形态在此必红**）。
 *  @param {string} stdoutText 本次比较过程中**真实打印到 stdout** 的文本（由调用方捕获）
 *  @param {{candidate:string}} pair 当前这一对
 *  @param {{name:string}} verdict 该图那条 check 的实参（`name`）
 *  @returns {{ok:boolean, why:string}} */
function measuredInRealStdout(stdoutText, pair, verdict) {
  const s = String(stdoutText);
  const iVerdict = s.indexOf(`  [PASS] ${verdict.name}\n`) >= 0
    ? s.indexOf(`  [PASS] ${verdict.name}\n`)
    : s.indexOf(`  [FAIL] ${verdict.name}`);
  const iMeasured = s.indexOf(`        实测：${pair.candidate}：不同像素 `);
  const ok = iVerdict >= 0 && iMeasured >= 0 && iVerdict < iMeasured;
  return { ok, why: `真实 stdout 里：判定行 @${iVerdict}、实测行 @${iMeasured}（须判定在前；` +
    `旧形态＝打印在 check 之前 ⇒ 此判据必红）；片段=` + JSON.stringify(s.slice(iMeasured, iMeasured + 70)) };
}

function main() {
  console.log(`基准目录：${path.relative(ROOT, BASELINE)}`);
  console.log(`候选目录：${path.relative(ROOT, CANDIDATE)}`);
  console.log(`判定规则：不同像素占比 ≤ ${(TOLERANCE * 100).toFixed(1)}%，单通道容差 ±${CHANNEL_TOL}`);

  const baseFiles = listPngs(BASELINE);
  if (!baseFiles.length) {
    console.log('\n基准目录里没有 PNG，无法比对（先把基准图放进去）');
    process.exit(1);
  }
  check(`基准目录含 10 张界面图`, baseFiles.length === 10, `实际 ${baseFiles.length} 张`);

  console.log('\n=== 自比（验证解码与比对链路） ===');
  for (const name of baseFiles) {
    const img = decodePng(path.join(BASELINE, name));
    const r = compare(img, img);
    check(`${name} 自比差异为 0`, r.ratio === 0,
      `不同像素 ${(r.ratio * 100).toFixed(2)}%，尺寸 ${img.width}×${img.height}，通道 ${img.channels}`);
  }

  if (SELF_ONLY) {
    finish();
    return;
  }

  console.log('\n=== 候选比对 ===');
  const candFiles = listPngs(CANDIDATE);

  /* ---- E91：候选图**新鲜度**（fail-closed；放在"缺候选"早退之前，保证目录缺失时也走这里变红） ----
     三条读数：①源码侧可算 ②候选目录存在 ③逐张不早于源码最新 mtime。 */
  const newest = newestSource();
  const srcCount = renderSources().length;
  check('E91① 参与渲染的源码集合可算（`index.html` ＋ `src\\**\\*.js` ＋ `src\\**\\*.css`）—— 新鲜度判据的前提，' +
    '拿不到就说明目录结构变了（不静默跳过）',
    srcCount > 0 && Boolean(newest) && Number.isFinite(newest.ms),
    newest ? `源码 ${srcCount} 个文件；最新 mtime＝${stamp(newest.ms)}（${path.relative(ROOT, newest.file)}）`
      : `参与渲染的源码一个都没找到（index.html 与 src\\**\\*.{js,css} 都取不到）`);

  const candDirExists = fs.existsSync(CANDIDATE) && (() => {
    try { return fs.statSync(CANDIDATE).isDirectory(); } catch { return false; }
  })();
  check('E91② 候选目录存在且可读（**缺失 ⇒ 明确红**，绝不静默通过）',
    candDirExists,
    candDirExists ? `候选目录 ${path.relative(ROOT, CANDIDATE)} 存在`
      : `候选目录 ${path.relative(ROOT, CANDIDATE)} **不存在**（或不是目录）—— ${CAPTURE_HINT}`);

  /* 逐张判定；陈旧者逐张指名（"哪一张、比源码旧多少"都要能一眼看出） */
  const stale = [];
  let newestCandMs = null;
  if (candDirExists) {
    for (const n of candFiles) {
      let st;
      try { st = fs.statSync(path.join(CANDIDATE, n)); } catch { continue; }
      if (newestCandMs === null || st.mtimeMs > newestCandMs) newestCandMs = st.mtimeMs;
      if (newest && Number.isFinite(newest.ms) && st.mtimeMs < newest.ms - FRESH_TOLERANCE_MS) {
        stale.push(`${n}（候选 ${stamp(st.mtimeMs)}，比源码最新 mtime 旧 ${((newest.ms - st.mtimeMs) / 1000).toFixed(1)} s）`);
      }
    }
  }
  check(`E91③ 候选图**逐张**不早于"参与渲染源码的最新 mtime"（容差 ${FRESH_TOLERANCE_MS / 1000} s，口径见本文件注释）` +
    ' —— 陈旧候选 ⇒ 门禁的"绿"没有依据（`E91`／`E92`：4.59% 的真实回归曾因此静默通过约 4 天）',
    candDirExists && candFiles.length > 0 && Boolean(newest) && stale.length === 0,
    !candDirExists
      ? `候选目录不存在 ⇒ 无法判定新鲜度（**按不通过处理**）—— ${CAPTURE_HINT}`
      : (!candFiles.length
        ? `候选目录里没有 PNG（0 张）⇒ 没有可比对的候选图 —— ${CAPTURE_HINT}`
        : (stale.length
          ? `陈旧候选 ${stale.length}/${candFiles.length} 张：${stale.join('；')}；` +
            `源码最新 mtime＝${stamp(newest.ms)}（${path.relative(ROOT, newest.file)}）—— ${CAPTURE_HINT}`
          : `候选 ${candFiles.length} 张，最新候选 mtime＝${stamp(newestCandMs)}` +
            ` ≥ 源码最新 mtime ${stamp(newest.ms)} − ${FRESH_TOLERANCE_MS / 1000} s（${path.relative(ROOT, newest.file)}）`)));

  /* P1-3：候选目录空/不存在时，过去只跑"基准自比"就 finish() → 11 项全 PASS、退出码 0，
     视觉回归形同虚设却报绿。现在把"候选可配对张数"本身当断言：
     候选为空、或同名配对后缺图，一律 FAIL（不是通过）。 */
  check(`候选目录可访问且含候选图`, candFiles.length > 0,
    `候选目录 ${path.relative(ROOT, CANDIDATE)} 里没有 PNG（${candFiles.length} 张）—— 没比对任何东西，不能算通过`);
  check(`候选图张数与基准一致（${baseFiles.length} 张）`, candFiles.length === baseFiles.length,
    `候选 ${candFiles.length} 张 vs 基准 ${baseFiles.length} 张`);

  const pairs = [];
  for (const n of candFiles) {
    const base = resolveBaseline(n, baseFiles);
    if (base) pairs.push({ candidate: n, baseline: base });
  }
  if (!pairs.length) {
    console.log(`  候选目录里没有能与基准配对的图（候选 ${candFiles.length} 张：${candFiles.join('、') || '（空）'}）`);
    console.log('  说明：候选图需与基准同名（见 tests/screenshots-baseline/README.md）。');
    check('候选图能与基准同名配对', false, '配对成功 0 张');
    finish();
    return;
  }
  /* `E202`（`T-20261007-09`，口径见文件头 `E202` 段）：逐张比对时**把 `实测：` 行打印挪到 `check()` 之后**，
     并在该行里**带上文件名** —— 读数归属靠文本、不靠位置。
     ⚠ 顺序**不许再换回去**：换回去（＝旧形态）时那条 `E202` 断言**必红并指名**（D22 用**内存副本**
     在断言里当场演示，见 `measuredFollowsVerdict()` 的那几组读数）。
     ⚠ **条数**：本段**只加一处断言**（逐张图各自过同一把尺子、结果收集到 `e202Readings`，
     循环后**一次**判定）—— 若改成"每张图一条"，本脚本会从 +1 变成 +10，那是无谓的条数膨胀
     （同一把尺子同一件事；一张红也足够定位到图名，因为 `why` 里带着文件名）。 */
  const measuredDetail = (name, r) =>
    `${name}：不同像素 ${(r.ratio * 100).toFixed(2)}%（${r.diffPixels}/${r.pixels}），最大通道差 ${r.maxDelta}`;
  const realConsoleLog = console.log;            /* 只作"spy 已恢复"的读数（断言里打印） */
  /* 真实 stdout 捕获（与 `spyCapture` **互补**）：`check()` 内部就是 `console.log` ⇒
     "打印到底在 check 之前还是之后"这件事，在**逐次捕获的数组**里与实现同序、分辨不出；
     只有在**真实输出流**里才分辨得出（下面对每次观测取"截至此刻的尾部文本"来量）。 */
  let stdoutText = '';
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, enc, cb) {
    stdoutText += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return realStdoutWrite(chunk, enc, cb);
  };
  const e202Readings = [];
  try {
    for (const { candidate, baseline } of pairs) {
      const pair = { candidate, baseline };
      const verdict = { name: `${candidate} ↔ ${baseline} 差异 ≤ ${(TOLERANCE * 100).toFixed(1)}%` };
      const lines = spyCapture(() => {
        try {
          const a = decodePng(path.join(BASELINE, baseline));
          const b = decodePng(path.join(CANDIDATE, candidate));
          const r = compare(a, b);
          const detail = r.sizeMismatch
            ? `尺寸不一致：基准 ${a.width}×${a.height} vs 候选 ${b.width}×${b.height}`
            : measuredDetail(candidate, r);
          check(verdict.name, !r.sizeMismatch && r.ratio <= TOLERANCE, detail);
          /* `E202` 修法：**打印在 `check()` 之后** ＋ 行内**带文件名**（归属靠文本）。
             ⚠ 不许删：通过分支的 `check()` 只打 `[PASS] <名称>`、不打 `detail`，绿时这里
             是**唯一**能看到不同像素百分比的地方。尺寸不一致时该行也照打（读数即原因）。 */
          console.log(`        实测：${detail}`);
        } catch (e) {
          check(`${candidate} ↔ ${baseline} 可解码比对`, false, e.message);
        }
      });
      const v = { ok: null, why: '（第一遍：量纲核在第二遍补齐）' };      const real = measuredInRealStdout(stdoutText, pair, verdict);
      /* **D22 的读数全部收进"这一个读数"里**（下面的**一条**断言读它）——
         这样本段的条数不随图数膨胀（+1 张图不 +1 条断言），但每张图都过同一把尺子。
         合成副本用的是**内存字符串/数组**，与盘上零关系。 */
      const oldForm = [`        实测：${candidate}：不同像素 1.00%（1/100），最大通道差 3`, `  [PASS] ${verdict.name}`];
      const noName = [`  [PASS] ${verdict.name}`, '        实测：不同像素 1.00%（1/100），最大通道差 3'];
      const mutantName = [`  [PASS] ${verdict.name}`,
        `        实测：${candidate.replace(/\.png$/, '-mutant.png')}：不同像素 1.00%（1/100），最大通道差 3`];
      /* 旧形态的**真实 stdout 副本**（内存串，不落盘）：先打印、后判定 ⇒ 行序判据必红 */
      const oldFormStdout = `  [PASS] 别的图\n        实测：${candidate}：不同像素 1.00%（1/100），最大通道差 3\n` +
        `  [PASS] ${verdict.name}\n`;
      e202Readings.push({
        pair, verdict, lines, v, real,
        d22: {
          /* `baseOk`（"未变异 ⇒ 绿"那一支）**在第二遍量纲核补齐后**再算 —— 见下面 `forEach` 里
             的 `x.d22.baseOk = ...`：第一遍 `v.ok` 还是 `null`（量纲核未做），此刻算会误红。 */
          oldFormRed: measuredFollowsVerdict(pair, verdict, oldForm).ok === false,
          noNameRed: measuredFollowsVerdict(pair, verdict, noName).ok === false,
          mutantRed: measuredFollowsVerdict(pair, verdict, mutantName).ok === false,
          oldFormRealRed: measuredInRealStdout(oldFormStdout, pair, verdict).ok === false,
          realBaseOk: real.ok === true
        }
      });
    }
    /* 量纲核（第二遍补齐）：每张图的捕获行必须与它自己在列表里的序号对齐 ——
       判据拿 `names[idx]` 与 `lines[idx]` 核，防止"这一张的行"被错配到"那一张的判定"。 */
    const liveNames = e202Readings.map(x => x.pair.candidate);
    const liveLines = e202Readings.map(x => x.lines);
    e202Readings.forEach((x, idx) => {
      x.v = measuredFollowsVerdict(x.pair, x.verdict, x.lines, { idx, names: liveNames, lines: liveLines });
      x.d22.baseOk = x.v.ok === true;                 /* D22 的"未变异 ⇒ 绿"那一支（此刻才算得准） */
    });  } finally {
    process.stdout.write = realStdoutWrite;      /* 无论成败都还原（不得让旁路留下） */
  }
  /* `E202` 的**一条**断言（每张图都过同一把尺子；读数在 `e202Readings` 里逐张可见）：
     · 正向：该图那条判定之后**真的**打印了带该图文件名的 `实测：` 行（真实 stdout 行序 ＋ 捕获读数）；
     · D22（同一把尺子喂**内存副本**，不落盘）：旧形态 ⇒ 必红；不带文件名 ⇒ 必红；姓名被篡改 ⇒ 必红；
       判据自证：把"文件名"与"顺序"任一项拿掉，上面那些红**同时**出现在每一张图上（不是个别偶然）。 */
  {
    const allV = e202Readings.length === pairs.length && e202Readings.every(x => x.v.ok === true);
    const allReal = e202Readings.every(x => x.real.ok === true);
    const allD22 = e202Readings.every(x => x.d22.baseOk && x.d22.oldFormRed && x.d22.noNameRed &&
      x.d22.mutantRed && x.d22.oldFormRealRed && x.d22.realBaseOk);
    const r0 = e202Readings[0] || null;
    check(`E202 逐张（${e202Readings.length} 张）：\`实测：\` 行打印在该图那条 check **之后**（真实 stdout 行序）、` +
      `且**含本图文件名**（归属靠文本，不靠位置；旧形态 ⇒ 必红并指名）；D22 用**内存副本**当场演示，盘上零改动`,
      allV && allReal && allD22 && e202Readings.length === 10,
      `逐张读数（须全绿）=[` + e202Readings.map(x =>
        `${x.pair.candidate}: 捕获=${x.v.ok === true}/真实行序=${x.real.ok === true}/D22=${x.d22.baseOk && x.d22.oldFormRed && x.d22.noNameRed && x.d22.mutantRed && x.d22.oldFormRealRed}`).join('、') + `]；` +
      (r0 ? `第 1 张真实行序读数：${r0.real.why}；第 1 张捕获读数：${r0.v.why}；` : '') +
      `D22（内存副本，**不改盘**，逐张都跑）：旧形态捕获判据红=${e202Readings.filter(x => x.d22.oldFormRed).length}/${e202Readings.length}、` +
      `旧形态**真实行序**判据红=${e202Readings.filter(x => x.d22.oldFormRealRed).length}/${e202Readings.length}、` +
      `不带文件名红=${e202Readings.filter(x => x.d22.noNameRed).length}/${e202Readings.length}、` +
      `姓名篡改红=${e202Readings.filter(x => x.d22.mutantRed).length}/${e202Readings.length}；` +
      `\`console.log\` 已恢复=${console.log === realConsoleLog}、\`process.stdout.write\` 已恢复=${process.stdout.write === realStdoutWrite}`);
  }
  const compared = pairs.map(p => p.baseline);
  const notCompared = baseFiles.filter(n => !compared.includes(n));
  if (notCompared.length) {
    console.log(`  未比对（候选目录缺图）：${notCompared.join('、')}`);
  }
  /* 报告建议的"候选缺一张即 FAIL"：把缺图本身当断言，而不是只打印一行提示 */
  check('每张基准图都有同名候选图参与比对', notCompared.length === 0,
    notCompared.length ? `缺 ${notCompared.length} 张：${notCompared.join('、')}` : '');
  finish();
}

function finish() {
  console.log('\n=== 汇总 ===');
  /* 冻结格式（规范 9.5-5 第 5 条）：三字段齐全，`run-all` 与 tests\README 都解析这一行 */
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项，跳过 0 项`);
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ' —— ' + f.detail : ''}`));
    process.exit(1);
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
