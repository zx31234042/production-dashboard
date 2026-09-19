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
  for (const { candidate, baseline } of pairs) {
    try {
      const a = decodePng(path.join(BASELINE, baseline));
      const b = decodePng(path.join(CANDIDATE, candidate));
      const r = compare(a, b);
      const detail = r.sizeMismatch
        ? `尺寸不一致：基准 ${a.width}×${a.height} vs 候选 ${b.width}×${b.height}`
        : `不同像素 ${(r.ratio * 100).toFixed(2)}%（${r.diffPixels}/${r.pixels}），最大通道差 ${r.maxDelta}`;
      if (!r.sizeMismatch) console.log(`        实测：${detail}`);   // 通过时也留痕，便于跟踪趋势
      check(`${candidate} ↔ ${baseline} 差异 ≤ ${(TOLERANCE * 100).toFixed(1)}%`, !r.sizeMismatch && r.ratio <= TOLERANCE, detail);
    } catch (e) {
      check(`${candidate} ↔ ${baseline} 可解码比对`, false, e.message);
    }
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
