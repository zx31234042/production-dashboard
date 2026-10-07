/* ==========================================================================
   交付包离线自检（tests/offline-check.js）
   立案：路线图 `E9`（★★，**验收前必做**）＋ `ADR-0002` 待办 3 / `ADR-0001` 待办 5。
   --------------------------------------------------------------------------
   **为什么要有它**（`E9` 原文）：零依赖是本项目的**核心决策**（`ADR-0002` D9/D13、
   `NFR-25` 前端资源本地化不依赖任何外网资源、`AC-09` 无外网访问、需求 §12 网络为隔离局域网），
   但此前**只有 `docs-cross-check` 的静态扫描** —— 它扫的是**源码/文档里的外链与依赖**，
   属于"**仓库**这一层"；**"交付包形态"这一层（`输出文件\离线部署与体检包-V1.3\`）无人断言**。
   于是存在一条静默通道：源码全绿，但**打包时**把某个依赖、某个外链、某个自带 node_modules 的
   便携运行时塞进了包 ⇒ 到了无网现场才发现。本脚本把"零依赖"从**约定**变成**可验证**。
   --------------------------------------------------------------------------
   检查面（四组，逐条 `t.check`）：
     一、**包内无第三方依赖**：无 `node_modules\`、无带 `dependencies`/`devDependencies` 的
         `package.json`、无 `.tgz`/`vendor` 之类载荷；对**便携 Node** 只允许它**官方发行版自带**的
         `node_modules`（`npm`／`corepack`）—— 理由见 `PORTABLE_NODE_BUNDLED` 处的"允许面"注释。
     二、**包内无外网 URL**：扫包内**文本**（`.cmd`/`.ps1`/`.js`/`.md`/`.json`/`.html`/`.txt`…）
         里的 `http(s)://`／`cdn.`／`unpkg`／`jsdelivr` 等 ⇒ 命中白名单之外的**一律指名**
         （文件 ＋ 行号 ＋ 片段）。**每一条白名单都在 `URL_ALLOWLIST` 里列明并给出理由**，
         且白名单是**双向**的：包里有未登记的外链 ⇒ 红；登记了但包里已不命中 ⇒ **也红**
         （否则白名单会腐烂成"永久豁免"，与 `ADR-0004` D23"名实相符"相悖）。
     三、**形态自洽**：包内入口（`.cmd`/`.ps1`/`.md`）引用的**包内**路径真实存在；
         便携 Node 的**版本**满足 `ADR-0002` **D10**（Node ≥ 24，锁死下限、禁止降到 22.x），
         且与包内发行物文件名一致；发行物 SHA256 与包内 `SHASUMS256.txt` 一致。
     四、**`D22` 定点变异（两组，必红并指名）**＋**在役工具的端口冲突实测**：
         ① 往**临时夹具**里投放 `node_modules\`（＋带依赖的 `package.json`）⇒ 必红并指名；
         ② 往**临时夹具**的文本里插一条 `https://cdn.example.com/x.js` ⇒ 必红并指名；
         ③（承 `E98`/`E100`）**真工具**：端口被占时 `tools\mock-mes` 必须打印 `EADDRINUSE`
            ＋ **非 0 退码优雅退出**；把 `'error'` 监听摘掉（**内存字节副本**）⇒ 必回到
            "未捕获事件栈 ＋ 退 1"。变异全程只在**内存副本/临时夹具**上做，
            受管文件盘上字节**不变**（`Buffer.compare` ＋ SHA-256 留痕；禁用 git 还原）。
   依据：`ADR-0002` D9/D10/D13、`ADR-0004` D21（不删判据）/D22（定点变异＋字节还原）/D23（名实相符）、
         规范 9.5-5（退出码契约）。
   依赖：**仅 Node 内置模块** ＋ 本仓测试侧公共件（`tests\env.js`、`tests\lib\assert.js`）
         —— 本脚本自身也必须零依赖，否则它就自相矛盾。
   运行：
     node tests\offline-check.js            跑全部（含第四组的定点变异与端口冲突实测）
     node tests\offline-check.js --list     只打印检查面清单（不跑断言）
     node tests\offline-check.js --self     只跑"**工具自证**"：把两组缺陷**投放进临时夹具**，
                                            再用同一套判据扫 ⇒ 必须**红并指名**
                                            （＝证明判据不是恒真式；不重复跑真实包那一组）
   退出码：0 = 全部通过；1 = 有断言失败；2 = 脚本自身异常（规范 9.5-5）。
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const env = require('./env');
env.assertRuntime();

const { createRunner } = require('./lib/assert');
const ROOT = env.paths.root;

/* ==========================================================================
   包根定位
   --------------------------------------------------------------------------
   `E9` 盯的是"**交付包形态**"。包根＝`输出文件\离线部署与体检包-V1.3\`
   （含便携 Node、`.cmd` 双击入口、体检脚本、说明文档）。
   `DSH_OFFLINE_PKG` 可覆盖（供外层探针指向别的包，例如下一版 `V1.3`）。
   **包不存在 ⇒ 显式跳过**（退 3），绝不静默通过：包还没打出来时本门禁"没证据"，
   而"没证据"不得写成"通过"（规范 9.5-5 第 6 条、`ADR-0004` D20）。
   ========================================================================== */
const PKG_DIR_NAME = '离线部署与体检包-V1.3';
const PKG_ROOT = process.env.DSH_OFFLINE_PKG
  ? path.resolve(process.env.DSH_OFFLINE_PKG)
  : path.join(ROOT, '输出文件', PKG_DIR_NAME);

/* 便携 Node 的家目录：包内 `._node\`（点号前缀是**故意的**，见 `体检-双击运行.cmd` 的注释：
   该目录必须被仓库文件卫生门禁跳过）。另兼容 `node\` 与官方解压目录名 `node-v*-win-x64`。 */
const PORTABLE_NODE_PATTERNS = [/^\._node$/, /^node$/, /^\._node-v[\d.]+-win-x64$/, /^node-v[\d.]+-win-x64$/];

/* ==========================================================================
   允许面①：便携 Node 自带的 `node_modules\{npm,corepack}`
   --------------------------------------------------------------------------
   **这不是"我们引入的第三方依赖"，而是 Node 官方 win-x64 zip 发行版的一部分。**
   包内即可自证：`node-v24.21.0-win-x64.zip` 的实算 SHA256 ＝
   `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`，与包内
   `SHASUMS256.txt` 里 `node-v24.21.0-win-x64.zip` 那一行逐字相同（Node 官方发布页原样）。
   **允许的理由**：`ADR-0002` D9/D13 禁的是"**我们引入** npm 依赖"（＝业务或门禁要
   `npm install` 才能跑）；npm／corepack 是运行时**自带的包管理器**，不被任何业务代码 import。
   ⚠ **这条口径与它的落脚点（主代理 2026-10-03 裁定 B，已登记台账）**：
     · **"零第三方依赖"指的是"我方引入的"依赖**；**便携运行时官方发行版自带**的不计入。
       若将来口径改成"连自带的也不许"，须换**不带 npm/corepack 的最小运行时**（属出包侧改动）。
     · 上面那个 "**zip 实算 SHA256 ＝ 包内 `SHASUMS256.txt` 对应行、逐字相同**" 就是
       "**可自证属于官方发行版**"的**唯一证据**：没有它，`._node\node_modules` 就只是一个
       "来历不明的 node_modules"，本规则**不得**放行。该证据由 **第三组的第 ⑪ 条断言**
       （`checkPortableNodeVersion()` 里 `zipSha256 === shasumsSha256`）**每次运行都复核**，
       不是只在注释里声称 —— 注释与判据必须同源，否则属 `ADR-0004` D23 的"名不符实"。
     · **判据不放宽**（裁定 B 原文要求保留）：便携 Node 家目录之外的 `node_modules`、
       以及便携 Node 顶层出现第三个条目，**都必红并指名**。
   **边界（判据不许放宽成"有 node_modules 就放过"）**：
     · 只允许**便携 Node 家目录之内**的 `node_modules`；包内**其它任何位置**出现 ⇒ **红**并逐条指名；
     · 便携 Node 的 `node_modules` **顶层条目只允许** `npm`／`corepack`（含 npm 自带的嵌套
       `node_modules`）—— 出现第三个顶层条目（＝有人往便携运行时里装了东西）⇒ **红**。
   ========================================================================== */
const PORTABLE_NODE_BUNDLED = ['npm', 'corepack'];

/* 文本扩展名＝第二组的扫描面。**不含** `.msi`/`.zip`/`.exe`/`.png`：
   二进制里的 `http://` 是签名链/XML 命名空间等**载荷**（实测 Edge MSI 里成百上千条
   `http://crl.microsoft.com/…`），扫它只会制造噪音、并诱导后来者把白名单写烂。 */
const TEXT_EXTS = new Set([
  '.cmd', '.bat', '.ps1', '.psm1', '.js', '.mjs', '.cjs', '.json', '.md', '.txt',
  '.html', '.htm', '.css', '.yml', '.yaml', '.sh', '.xml', '.ini', '.cfg', '.sql'
]);

/* ---------------- 小工具 ---------------- */
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
/** 以 LF/CRLF 两种行尾都能正确切行的方式读文本；含 NUL ⇒ 返回 null（当二进制，不扫） */
function readTextLines(readFile, abs) {
  const raw = readFile(abs);
  if (raw.includes(0)) return null;
  return raw.toString('utf8').split(/\r?\n/);
}
/** 包根相对路径，统一用 `\` 分隔（判据里写的就是这个形态） */
const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('\\');
const isInside = (childAbs, parentAbs) => {
  const r = path.relative(parentAbs, childAbs);
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
};

/**
 * 递归列目录（**不跟随符号链接/junction** —— 否则扫描会被带出包外，与 `E46` 同族风险）。
 * @param {string} root
 * @param {(abs:string)=>Buffer} readFile 仅供测试注入；目录项一律读盘（夹具不新增**文件**）
 */
function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of list) {
      const abs = path.join(dir, ent.name);
      let kind = 'file';
      if (ent.isSymbolicLink()) kind = 'symlink';
      else if (ent.isDirectory()) kind = 'dir';
      let size = 0;
      if (kind === 'file') { try { size = fs.statSync(abs).size; } catch { size = -1; } }
      out.push({ abs, rel: relOf(root, abs), kind, size });
      if (kind === 'dir') stack.push(abs);
    }
  }
  return out;
}
const filesOf = es => es.filter(e => e.kind === 'file');
const dirsOf = es => es.filter(e => e.kind === 'dir');
const baseOf = rel => rel.split('\\').pop();

/** 便携 Node 家目录（包根第一层里的匹配目录），没有则 null */
function findPortableNodeRoot(root, entries) {
  const hit = dirsOf(entries).filter(e => !e.rel.includes('\\')).find(d => PORTABLE_NODE_PATTERNS.some(re => re.test(d.rel)));
  return hit ? hit.abs : null;
}

/* ==========================================================================
   一、包内无第三方依赖
   ========================================================================== */
/**
 * 依赖面扫描核心（**导出给 `--self` 的夹具复用**，判据只有这一份）。
 * 规则（任一命中 ⇒ 记一条 finding，逐条指名）：
 *   A `node_modules\` 出现在**便携 Node 家目录之外**；
 *   B 便携 Node 的 `node_modules` 顶层条目超出 `npm`/`corepack`；
 *   C 某个 `package.json` 声明了非空 `dependencies`/`devDependencies`/`optionalDependencies`/
 *     `peerDependencies`/`bundledDependencies`；零依赖的 `package.json` 必须写明用途；
 *   D 包内出现 `.tgz`/`.tar.gz`（＝可直接 npm install 的载荷）；
 *   E 包内出现 `vendor\` 目录（**在便携 Node 之外**；npm 自带的 vendor 归 A/B 管）。
 * @param {string} root
 * @param {(abs:string)=>Buffer} [readFile] 注入用，默认 `fs.readFileSync`
 * @returns {{findings:Array<{rule:string,where:string,detail:string}>, stats:object}}
 */
function scanDependencies(root, readFile = fs.readFileSync, virtualEntries = []) {
  const findings = [];
  /* ⚠ `walk` 只读**盘上**目录项；夹具的"投放"是**纯内存**的（不写盘，见 `buildSelfFixture`），
     故新增文件必须由 `virtualEntries` 补进枚举面 —— 否则投放了却枚举不到 ⇒ "该红不红"的假绿。
     去重后再排序，保证判据的遍历顺序稳定。 */
  const seen = new Set();
  const entries = walk(root).concat(virtualEntries)
    .filter(e => (seen.has(e.rel) ? false : (seen.add(e.rel), true)))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const nodeRoot = findPortableNodeRoot(root, entries);
  const add = (rule, where, detail) => findings.push({ rule, where, detail });

  const nmDirs = dirsOf(entries).filter(e => baseOf(e.rel) === 'node_modules');
  for (const d of nmDirs) {
    if (!nodeRoot || !isInside(d.abs, nodeRoot)) {
      add('A', d.rel, '包内出现 `node_modules\\`'
        + (nodeRoot
          ? `，且**不在**便携 Node 家目录 \`${relOf(root, nodeRoot)}\` 之内 ⇒ 是我们引入的依赖`
          : '，而本包没有便携 Node 家目录 ⇒ 任何 node_modules 都不该存在'));
    }
  }

  if (nodeRoot) {
    const topNm = path.join(nodeRoot, 'node_modules');
    let tops = [];
    try { tops = fs.readdirSync(topNm, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
    catch { tops = []; }
    const extra = tops.filter(n => !PORTABLE_NODE_BUNDLED.includes(n));
    if (extra.length) {
      add('B', relOf(root, topNm), `便携 Node 自带的 \`node_modules\` 顶层多出 ${extra.length} 项：${extra.join('、')}`
        + `（只允许 ${PORTABLE_NODE_BUNDLED.join('／')} —— 即 Node 官方发行版自带的那两个）`);
    }
  }

  const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies'];
  /* 诊断出口（默认关）：夹具/pack 出现"看起来该红却不红"时，用它确认判据到底枚举到了哪些清单 */
  if (process.env.DSH_OFFLINE_DEBUG) {
    console.log('[DEBUG] package.json 候选：' + JSON.stringify(filesOf(entries).filter(x => baseOf(x.rel) === 'package.json').map(x => x.rel))
      + '；nodeRoot=' + String(nodeRoot));
  }
  for (const e of filesOf(entries).filter(x => baseOf(x.rel) === 'package.json')) {
    if (nodeRoot && isInside(e.abs, nodeRoot)) continue;   // 发行版自带包的清单，不属"我们引入的依赖"
    let json;
    try { json = JSON.parse(readFile(e.abs).toString('utf8')); }
    catch (err) { add('C', e.rel, `package.json 无法解析：${err.message}`); continue; }
    const declared = DEP_KEYS.filter(k => json[k] && (Array.isArray(json[k]) ? json[k].length : Object.keys(json[k]).length));
    if (declared.length) {
      add('C', e.rel, `package.json 声明了依赖字段 ${declared.join('／')} ⇒ 交付包不再是零依赖（`
        + declared.map(k => `${k}=${JSON.stringify(json[k])}`).join('；') + '）');
    } else {
      const purpose = json.description || json.comment || json._purpose || '';
      if (!String(purpose).trim()) {
        add('C', e.rel, 'package.json 是零依赖的，但**没有说明用途**（`E9` 要求包内 package.json 必须写清用途：补 `description`）');
      }
    }
  }

  for (const e of filesOf(entries).filter(x => /\.(tgz|tar\.gz)$/i.test(x.rel))) {
    add('D', e.rel, '包内出现 `.tgz`/`.tar.gz`（＝可直接 npm install 的依赖载荷，零依赖交付包不该有）');
  }
  for (const e of dirsOf(entries).filter(x => baseOf(x.rel) === 'vendor')) {
    if (nodeRoot && isInside(e.abs, nodeRoot)) continue;   // npm 自带的 vendor 由 A/B 规则管
    add('E', e.rel, '包内出现 `vendor\\` 目录（便携 Node 之外的第三方源码转储，零依赖交付包不该有）');
  }

  return {
    findings,
    stats: {
      files: filesOf(entries).length,
      dirs: dirsOf(entries).length,
      symlinks: entries.filter(e => e.kind === 'symlink').length,
      nodeModulesDirs: nmDirs.length,
      portableNode: nodeRoot ? relOf(root, nodeRoot) : '(无)',
      outsideNodeModules: nmDirs.filter(d => !nodeRoot || !isInside(d.abs, nodeRoot)).map(d => d.rel)
    }
  };
}

/* ==========================================================================
   二、包内无外网 URL
   ========================================================================== */
const URL_RX = /(https?:\/\/|cdn\.|unpkg\.|jsdelivr\.|\bftp:\/\/)/i;
/** 白名单里登记的 URL 片段总数（判据与文案用同一个来源，避免两处各数一遍） */
const urlAllowCount = () => URL_ALLOWLIST.reduce((n, a) => n + a.urls.length, 0);

/**
 * URL 白名单（**每一条都必须给理由**；`E9` 原文要求）。
 * 形状 `{ file, line, urls: [...], reason }`：`file` 是包根相对路径（`\` 分隔）、`line` 是 1 起行号、
 * `urls` 是该行上**逐条登记**的外链片段（对不上 ⇒ 判"白名单腐烂"并**指名是哪一条**）。
 * ⚠ 为什么是"**一行可登记多条**"（**第一版的实测教训**）：真包 README 的**第 127 行同时含两条**外链
 * （`www.microsoft.com/edge/business/download` 与 `edgeupdates.microsoft.com/api/products`）。
 * 本脚本**第一版把白名单写成"一行一条"**（`{file, line, url}`，一条只装一个 URL），于是：
 * 第 127 行只能匹配到**先登记的那一条**，第二条永远对不上 ⇒ 白名单腐烂判据把**两条都报成"未使用"**、
 * 命中项里第二条被报成"未登记" ⇒ **在一个完全正确、零改动的包上报红（假红）**。
 * 修法＝把形状改成 `{file, line, urls:[…]}`（一行可登记多条）、命中粒度改为
 * **(文件, 行号, URL 片段)**（一行有 N 条就记 N 条）。⇒ 这是"判据必须能表达**真实形态**"的一例：
 * 形状写窄了，判据就会在正确输入上撒谎（`ADR-0004` D23）。
 * 判据**双向**：未登记的外链 ⇒ 红并指名（文件＋行号＋片段）；登记了但包里已不命中 ⇒ **也红**（防腐烂）。
 *
 * 为什么这 3 条可以留（逐条理由见下）：
 *   · 它们**不被任何脚本请求** —— 包内 `.cmd`/`.ps1`/`.js` 对这三个域名的引用数＝0；
 *   · 它们描述的是"**出包后人工复核/将来重下**"的出处，而对应的 MSI **已随包分发**
 *     （`._edge\MicrosoftEdgeEnterpriseX64-154.0.4258.37.msi`，212,643,840 B，SHA256 与 README 所载一致）
 *     ⇒ 现场**无网也能装**，不构成运行时外链；依据＝`E54`（现场 Edge 92 过旧、`--headless=new` 需 ≥112
 *     ⇒ 负责人 2026-09-29 裁定走**离线升级**）。
 *   · 删掉它们的代价＝**丢掉"包里那个 MSI 是哪一版、从哪来"的可复核出处**（审计上更差）。
 */
const URL_ALLOWLIST = [
  {
    file: 'README-离线部署与体检.md', line: 129,
    urls: ['https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/78f7562d-5160-419f-b64b-b9dc3da74bd7/MicrosoftEdgeEnterpriseX64.msi'],
    reason: '离线升级件的**官方直链**，出自原文「供复核/重下：直链 …」。该 MSI 已随包分发'
      + '（`._edge\\MicrosoftEdgeEnterpriseX64-154.0.4258.37.msi`），故现场无网也能装，不构成运行时外链；'
      + '留着的价值＝出包后人工复核"包里那个 MSI 是不是这一版"。依据＝`E54`（2026-09-29 负责人裁定走离线升级）。'
  },
  {
    file: 'README-离线部署与体检.md', line: 130,
    urls: [
      'https://www.microsoft.com/edge/business/download',
      'https://edgeupdates.microsoft.com/api/products?view=enterprise'
    ],
    reason: '同一条注记的两条：①Edge 企业版**官方入口页**（供人工核对下载通道）；'
      + '②Edge **版本元数据 API**（原文"可脚本复核版本/大小/SHA256"的出处）。'
      + '本包内**没有脚本调用它们**（离线现场本就无网）—— 记录的是"出包时如何核对"这一过程口径，'
      + '属文档性出处而非运行时依赖。⚠ 二者同在**第 127 行**，故本清单按"一行可多条"设计。'
  }
];

/** 应扫的文本文件（跳过便携 Node 家目录：官方发行版，理由见允许面①） */
function listTextFiles(root, entries, nodeRoot) {
  return filesOf(entries).filter(e => {
    if (nodeRoot && isInside(e.abs, nodeRoot)) return false;
    return TEXT_EXTS.has(path.extname(e.rel).toLowerCase());
  });
}

/**
 * URL 扫描核心（导出给夹具复用）。
 * 命中粒度＝**(文件, 行号, URL 片段)**：一行里有 N 条外链就记 N 条（真包 README 第 127 行有 2 条），
 * 故白名单也必须按"一行可登记多条"来写（`urls: [...]`）。
 * @param {string} root
 * @param {Array<{file:string,line:number,urls:string[]}>} allowlist
 * @param {string|null} nodeRoot
 * @param {(abs:string)=>Buffer} [readFile]
 * @param {Array} [virtualEntries] 纯内存"新增文件"（夹具用；`walk` 只读盘）
 * @returns {{hits:Array<{file:string,line:number,text:string,url:string,allowlisted:boolean}>,
 *            allowlistUnused:string[], files:number}}
 */
function scanUrls(root, allowlist, nodeRoot, readFile = fs.readFileSync, virtualEntries = []) {
  const seen = new Set();
  const entries = walk(root).concat(virtualEntries)
    .filter(e => (seen.has(e.rel) ? false : (seen.add(e.rel), true)))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hits = [];
  /** 取一行里出现的外链**片段**（用于指名；不追求完整 URL 归一化，够读、够 grep 即可） */
  const urlsInLine = line => {
    const out = [];
    for (const m of line.matchAll(/\b(?:https?|ftp):\/\/[^\s`"'<>）)，。；、|\\]+/gi)) out.push(m[0].replace(/[.,;）)]+$/, ''));
    for (const m of line.matchAll(/\b(?:cdn|unpkg|jsdelivr)\.[^\s`"'<>）)，。；、|\\]*/gi)) {
      if (!out.includes(m[0])) out.push(m[0]);
    }
    return out.length ? out : ['(URL_RX 命中但未取到片段)'];
  };
  const files = listTextFiles(root, entries, nodeRoot);
  for (const f of files) {
    const lines = readTextLines(readFile, f.abs);
    if (!lines) continue;                                  // 含 NUL ⇒ 当二进制跳过
    for (let i = 0; i < lines.length; i++) {
      if (!URL_RX.test(lines[i])) continue;
      const entry = allowlist.find(a => a.file === f.rel && a.line === i + 1);
      for (const u of urlsInLine(lines[i])) {
        hits.push({
          file: f.rel, line: i + 1, url: u, text: lines[i].trim().slice(0, 170),
          allowlisted: Boolean(entry && entry.urls.includes(u))
        });
      }
    }
  }
  /* 白名单腐烂：登记的那一条片段不再出现在该行 ⇒ 单列出来（判据双向） */
  const allowlistUnused = [];
  for (const a of allowlist) {
    const abs = path.join(root, ...a.file.split('\\'));
    const lines = fs.existsSync(abs) ? readTextLines(readFile, abs) : null;
    const line = lines && lines[a.line - 1];
    for (const u of a.urls) {
      if (!line || !line.includes(u)) allowlistUnused.push(`${a.file}:${a.line} 期望含 \`${u.slice(0, 72)}…\``);
    }
  }
  return { hits, allowlistUnused, files: files.length };
}

/* ==========================================================================
   三、形态自洽
   ========================================================================== */
/**
 * 包内入口引用登记表（**显式列举**，不靠正则满文猜 —— 猜出来的"引用"多半是散文里的词，
 * 会把判据变成噪音工厂）。逐条双向核对："登记表说某文件引用了某路径"必须为真，
 * 且被引用的路径必须真实存在（`ADR-0004` D23：登记表自己也不许说谎）。
 * `kind: 'internal'` ⇒ 必须存在于**包内**；`kind: 'external'` ⇒ 指向**仓库**（包内故意不含），
 * 但必须由包内文档/入口显式声明这个前置。
 */
const ENTRY_REFS = [
  { file: '体检-双击运行.cmd', ref: '._node\\node.exe', kind: 'internal', note: '包内便携 Node（入口优先用它）' },
  { file: '体检-双击运行.cmd', ref: '%~dp0*.ps1', kind: 'internal', note: '入口用 *.ps1 **通配**找同目录的 `部署环境体检.ps1`（不写字面名 —— `E49` 的教训：.cmd 里放中文会因 OEM 代码页 936 被误解码）' },
  { file: '体检-双击运行.cmd', ref: '._env-report', kind: 'internal', note: '"报告写在脚本旁边的 ._env-report 子目录"' },
  { file: '跑现场门禁.cmd', ref: '%~dp0*.ps1', kind: 'internal', note: '同上（`-RunFieldGates` 模式）' },
  { file: '配置-DEP04.cmd', ref: '%~dp0*.ps1', kind: 'internal', note: '同上（`-ConfigureDep04` 模式）' },
  { file: '体检-库结构核查.cmd', ref: '._node\\node.exe', kind: 'internal', note: '首选包内 Node；都没有才落到 PATH 的 node' },
  { file: '体检-库结构核查.cmd', ref: 'db-schema-check.js', kind: 'internal', note: '库结构核查脚本与启动器同目录' },
  { file: '体检-库结构核查.cmd', ref: '._env-report', kind: 'internal', note: '报告落点' },
  { file: '体检-库结构核查-执行方法.md', ref: 'db-schema-check.js', kind: 'internal', note: '执行方法说明与脚本同目录' },
  { file: '体检-库结构核查-执行方法.md', ref: '体检-库结构核查.cmd', kind: 'internal', note: '执行方法说明指向的入口（双击它）' },
  { file: 'README-离线部署与体检.md', ref: '._node\\node.exe', kind: 'internal', note: '§4.1 说明"包内 ._node\\ 便携 Node"' },
  { file: 'README-离线部署与体检.md', ref: 'SHASUMS256.txt', kind: 'internal', note: 'Node 官方校验清单随包，供离线核对' },
  { file: 'README-离线部署与体检.md', ref: '体检-库结构核查.cmd', kind: 'internal', note: '§ 库结构核查一节点名双击它' },
  { file: 'README-离线部署与体检.md', ref: '跑现场门禁.cmd', kind: 'internal', note: '§4.3 点名双击它' },
  { file: 'README-离线部署与体检.md', ref: '体检-双击运行.cmd', kind: 'internal', note: '§4.1 点名双击它' },
  { file: 'README-离线部署与体检.md', ref: '._edge\\MicrosoftEdgeEnterpriseX64-154.0.4258.37.msi', kind: 'internal', note: '§4.2 离线 Edge 升级件' },
  { file: '跑7日压测.cmd', ref: '%~dp0*.ps1', kind: 'internal', note: '新入口（E200）：用**通配**找同目录的 `部署环境体检.ps1`（不写字面中文名 —— E49 的教训）' },
  { file: '跑7日压测.cmd', ref: 'tests\\', kind: 'external', note: '新入口（E200）：它跑的 `tests\\stress-check.js` 在**仓库**里（包内不含），入口会自动找仓库' },
  { file: '核验7日台账.cmd', ref: '%~dp0*.ps1', kind: 'internal', note: '新入口（E200）：同上（`-VerifySoak` 模式）' },
  { file: '核验7日台账.cmd', ref: 'tests\\._verify\\soak', kind: 'external', note: '新入口（E200）：自动取 `<仓库>\\tests\\._verify\\soak\\*.jsonl` 里最近一份台账' },
  { file: 'README-离线部署与体检.md', ref: '跑7日压测.cmd', kind: 'internal', note: 'README §0／§4.4 点名双击它（AC-07 的 7 日压测入口）' },
  { file: 'README-离线部署与体检.md', ref: '核验7日台账.cmd', kind: 'internal', note: 'README §0／§4.4 点名双击它（台账核验入口）' },
  { file: '部署环境体检.ps1', ref: 'tests\\stress-check.js', kind: 'external', note: '新开关 `-RunSoak7Day`／`-VerifySoak` 调仓库侧 `tests\\stress-check.js`（包内不含）' },
  { file: '部署环境体检.ps1', ref: 'tests\\._verify\\soak', kind: 'external', note: '新开关的默认台账落点：`<仓库>\\tests\\._verify\\soak\\soak-7day-<时间戳>.jsonl`' },
  /* ---- 包外引用：包内**故意不含**仓库（`tests\` 与 `server\` 要整套拷到目标机）---- */
  { file: '跑现场门禁.cmd', ref: 'tests\\', kind: 'external', note: '浏览器/视觉类门禁脚本在**仓库**里（包内不含），入口会自动找仓库' },
  { file: '部署环境体检.ps1', ref: 'tests\\preflight.js', kind: 'external', note: '仓库定位的**唯一**锚点：找到含 tests\\preflight.js 的目录才算仓库' }
];

/** 形态自洽扫描核心（导出给夹具复用）
 *  `ref` 支持 **`*` 通配**（`.cmd` 用 `%~dp0*.ps1` 找同目录的 .ps1 —— 不写字面中文名是**故意的**，
 *  见 `E49`：cmd.exe 按 OEM 代码页 936 读 .cmd，中文字面量会被误解码。判据必须能表达这种形态，
 *  否则会把正确写法判红）。通配只允许用在**文件名**段，且必须在同目录内**恰好命中 ≥1 个**文件。 */
function scanShape(root, manifest, readFile = fs.readFileSync) {
  const findings = [];
  const externalDeclared = [];
  for (const r of manifest) {
    const declarerAbs = path.join(root, ...r.file.split('\\'));
    if (!fs.existsSync(declarerAbs)) {
      findings.push({ rule: 'F', where: r.file, detail: '登记为引用的**声明方**文件不存在' });
      continue;
    }
    const txt = readFile(declarerAbs).toString('utf8');
    if (!txt.includes(r.ref)) {
      findings.push({ rule: 'F', where: r.file, detail: `登记表说它引用了 \`${r.ref}\`，但该文件里找不到这个字样（登记表与事实不符）` });
      continue;
    }
    /* `.cmd` 引用的 `%~dp0` 前缀＝"本文件所在目录"，判据里剥掉它再在包根对应目录里找 */
    const bare = r.ref.replace(/^%~dp0/, '').replace(/\\+$/, '');
    if (bare.includes('*')) {
      const dirAbs = path.join(root, ...r.file.split('\\').slice(0, -1));
      const re = new RegExp('^' + bare.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\\\]*') + '$', 'i');
      let hitNames = [];
      try { hitNames = fs.readdirSync(dirAbs).filter(n => re.test(n)); } catch { hitNames = []; }
      if (hitNames.length === 0) {
        findings.push({ rule: 'F', where: r.file, detail: `通配引用 \`${r.ref}\` 在 \`${r.file}\` 所在目录里**一个都没命中**（${r.note}）` });
      }
      continue;
    }
    if (r.kind === 'internal') {
      if (!fs.existsSync(path.join(root, ...bare.split('\\')))) {
        findings.push({ rule: 'F', where: r.file, detail: `引用的**包内**路径不存在：\`${r.ref}\`（${r.note}）` });
      }
    } else {
      externalDeclared.push({ file: r.file, ref: r.ref, note: r.note });
    }
  }
  return { findings, externalDeclared };
}

/**
 * 便携 Node 版本 vs `ADR-0002` D10（**Node ≥ 24，禁止降到 22.x**）。
 * 三处口径必须一致：① `._node\node.exe` 实跑 `--version`；② 包内发行物文件名；
 * ③ `SHASUMS256.txt` 里该发行物的 SHA256 与包内 zip 实算值。
 * @param {Array} entries 预先 walk 好的包内条目（避免重复遍历 250 MB 的包）
 */
function checkPortableNodeVersion(root, entries) {
  const out = { findings: [], facts: {} };
  const nodeRoot = findPortableNodeRoot(root, entries);
  if (!nodeRoot) { out.facts.nodeRoot = '(无便携 Node)'; return out; }
  out.facts.nodeRoot = relOf(root, nodeRoot);
  const exe = path.join(nodeRoot, 'node.exe');
  if (!fs.existsSync(exe)) {
    out.findings.push({ rule: 'G', where: out.facts.nodeRoot, detail: '便携 Node 家目录里没有 `node.exe`（入口以它为首选，缺了只能落到 PATH —— 现场无网无 Node 时会失败）' });
    return out;
  }
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 30000 });
  const ver = String(r.stdout || '').trim();
  out.facts.exeVersion = ver || `(读不到：exit=${r.status}${r.error ? ' ' + r.error.message : ''})`;
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(ver);
  if (!m) {
    out.findings.push({ rule: 'G', where: relOf(root, exe), detail: `\`node.exe --version\` 的输出不是 \`vX.Y.Z\`：${JSON.stringify(ver)}` });
  } else {
    out.facts.major = Number(m[1]);
    if (Number(m[1]) < env.MIN_NODE_MAJOR) {
      out.findings.push({ rule: 'G', where: relOf(root, exe), detail: `便携 Node 是 ${ver}，低于 \`ADR-0002\` D10 的下限 \`Node >= ${env.MIN_NODE_MAJOR}\`（禁止降到 22.x）` });
    }
  }
  const zip = filesOf(entries).find(e => /^node-v[\d.]+-win-x64\.zip$/.test(e.rel));
  if (!zip) {
    out.findings.push({ rule: 'G', where: out.facts.nodeRoot, detail: '包内有便携 Node，但**没有** `node-vX.Y.Z-win-x64.zip` 发行物 ⇒ 无法离线自证"包内 Node 是官方发行版"' });
    return out;
  }
  const zm = /^node-v([\d.]+)-win-x64\.zip$/.exec(zip.rel);
  out.facts.zipName = zip.rel;
  out.facts.zipBytes = zip.size;
  if (zm && m && `v${zm[1]}` !== ver) {
    out.findings.push({ rule: 'G', where: zip.rel, detail: `发行物文件名声明 v${zm[1]}，而便携 \`node.exe\` 实跑 ${ver} ⇒ 两者不一致` });
  }
  const shasums = filesOf(entries).find(e => e.rel === 'SHASUMS256.txt');
  if (!shasums) {
    out.findings.push({ rule: 'G', where: 'SHASUMS256.txt', detail: '包里没有 Node 官方校验清单 ⇒ 离线无法自证发行物完整性' });
  } else {
    const line = (readTextLines(fs.readFileSync, shasums.abs) || []).find(l => l.trim().endsWith('  ' + zip.rel));
    if (!line) {
      out.findings.push({ rule: 'G', where: 'SHASUMS256.txt', detail: `没有 \`${zip.rel}\` 的校验行` });
    } else {
      const want = line.trim().split(/\s+/)[0].toLowerCase();
      const got = sha256(fs.readFileSync(zip.abs));
      out.facts.zipSha256 = got;
      out.facts.shasumsSha256 = want;
      if (want !== got) {
        out.findings.push({ rule: 'G', where: zip.rel, detail: `实算 SHA256=${got}，SHASUMS256.txt 声明=${want} ⇒ 发行物与官方校验清单不符` });
      }
    }
  }
  return out;
}

/* ==========================================================================
   D22 证据：真工具 `tools\mock-mes` 的端口冲突（承 `E98`/`E100`）
   ========================================================================== */
/**
 * 核对 `tests\contract-check.js` 的端口已动态化（`E100`②）：**代码区**（剥注释后）
 * 不再出现 18896～18899，且确实用了夹具的 `allocPort()`。
 * 为什么只认"剥注释后的代码"：那四个号作为**历史**留在注释与失败文案里是**对的**
 * （`E98` 的定位记录要能溯源）；若"文本里出现就当红"，就会逼后来者删掉溯源信息
 * —— `ADR-0004` D21/D23 都不许。
 */
function contractCheckPortsDynamic() {
  const f = path.join(ROOT, 'tests', 'contract-check.js');
  if (!fs.existsSync(f)) return { ok: false, detail: 'tests\\contract-check.js 不存在' };
  const code = fs.readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')        // 块注释
    .replace(/\/\/[^\n]*/g, ' ');             // 行注释
  const hard = [...code.matchAll(/\b1889[6-9]\b/g)].map(m => m[0]);
  const usesAlloc = /harness\.allocPort\s*\(/.test(code);
  return {
    ok: hard.length === 0 && usesAlloc,
    detail: `代码区（已剥注释）里 18896～18899 出现 ${hard.length} 次`
      + (hard.length ? `：${[...new Set(hard)].join('、')}` : '') + `；使用夹具 allocPort=${usesAlloc}`
  };
}

/**
 * 真端口冲突实测（`E100`①）：子进程先自己占住一个**随机空闲端口**（模拟"现场某进程常年占着它"），
 * 再让 `tools\mock-mes` 去听同一个端口。两种形态各跑一次：
 *   · 修复态（**盘上真字节**）⇒ 必须打印 `EADDRINUSE` ＋ 非 0 退码 ＋ **无**未捕获事件栈；
 *   · 变异体（把 `'error'` 监听整段摘掉，**内存 `Module._compile` 副本**）⇒ 必须回到
 *     "未捕获 `Unhandled 'error' event` ＋ 退 1"（＝改前 `HEAD` 版的实测形态）。
 *
 * ⚠ **argv 陷阱（实测踩过两次，与 `E97①` 的"注入层次/口径"同族，故写进注释）**：
 *   ① `mock-mes.js` 的 `parseArgs(process.argv)` 从 **`argv[2]`** 起读 ⇒ 用 `node -e` 注入时，
 *      `process.argv` 是 `[node, <MES>, <--port 之前的一切>…]`，若直接写 `['-e', code, '--port', P]`
 *      则 `--port` 落在 `argv[1]` ⇒ **完全不生效**，`listen(undefined)` 退化成随机端口、
 *      冲突根本不发生（探针挂到超时＝**假绿**）。
 *   ② 反向的坑同样致命：`node -e <code> node <MES> --port <P>` 里，`argv[2]` 是 **MES 路径**
 *      而不是端口 ⇒ 探针自己读端口就读到 `NaN`。⇒ **本探针一律不从 argv 取端口**，
 *      改用环境变量 `DSH_OFFLINE_PROBE_PORT`（对两种 argv 归一化都免疫）。
 */
function realToolPortProbe() {
  const empty = { exit: null, out: '', err: '', hasAddrInUse: false, hasUncaught: false };
  const MES = path.join(ROOT, 'tools', 'mock-mes', 'mock-mes.js');
  if (!fs.existsSync(MES)) {
    return { ok: false, reason: 'tools\\mock-mes\\mock-mes.js 不存在', port: 0, fixed: empty, mutant: empty,
      anchorHit: false, sha0: '', sha1: '', diskUnchanged: false, contractCheckPortsDynamic: contractCheckPortsDynamic() };
  }
  const bytes0 = fs.readFileSync(MES);
  const sha0 = sha256(bytes0);
  const src0 = bytes0.toString('utf8');
  /* 变异锚点：`E100`① 新加的那一整段（注释 ＋ `server.on('error', …)` 块 ＋ 尾随空行） */
  const ANCHOR = /  \/\* `E100`①（2026-10-03）[\s\S]*?process\.exit\(EXIT_LISTEN_FAILED\);\n  \}\);\n\n/;
  const anchorHit = ANCHOR.test(src0);
  const mutatedSrc = anchorHit ? src0.replace(ANCHOR, '') : '';

  const runOne = (source) => {
    const code = `const net=require('net'),M=require('module'),path=require('path');`
      + `const MES=${JSON.stringify(MES)};`
      + `const PORT=Number(process.env.DSH_OFFLINE_PROBE_PORT);`
      /* 先把端口占住 ⇒ **保证** mock-mes 一定撞上 EADDRINUSE；`.unref()` 让进程能自然退出 */
      + `const holder=net.createServer();`
      + `holder.on('error',e=>{console.error('HOLDER-ERR '+e.message);process.exit(9);});`
      + `holder.listen({port:PORT},()=>{holder.unref();`
      + `  const mut=${JSON.stringify(source)};`
      + `  if(mut!==null){const m=new M(MES,null);m.filename=MES;`
      + `    m.paths=M._nodeModulePaths(path.dirname(MES));`
      + `    try{m._compile(mut,MES);}catch(e){console.error('COMPILE-ERR '+e.message);process.exit(9);}}`
      + `  else{require(MES);}`
      + `});`;
    /* `['node', MES, '--port', P]` 补齐 CLI 前两格 ⇒ `parseArgs` 从 argv[2] 读到 `--port` */
    const r = spawnSync(process.execPath, ['-e', code, 'node', MES, '--port', String(port)],
      { encoding: 'utf8', timeout: 40000, cwd: ROOT,
        env: { ...process.env, DSH_OFFLINE_PROBE_PORT: String(port) } });
    const out = String(r.stdout || ''), err = String(r.stderr || '');
    return {
      exit: r.status, out, err,
      hasAddrInUse: /EADDRINUSE/.test(out + err),
      hasUncaught: /Unhandled 'error' event|Uncaught error event/.test(out + err)
    };
  };

  /* 取一个随机空闲端口：先 bind(0) 拿号再**立刻释放**（与 `harness.allocPort` 同手法），
     然后把它交给子进程去占 —— 窗口极短（只够一次 spawn），足够稳。 */
  const pick = spawnSync(process.execPath, ['-e', `
    const net=require('net');const s=net.createServer();
    s.listen({port:0},()=>{process.stdout.write(String(s.address().port));s.close(()=>process.exit(0));});
    setTimeout(()=>process.exit(0), 8000);
  `], { encoding: 'utf8', timeout: 15000 });
  const port = Number(String(pick.stdout || '').trim());

  let fixed = empty, mutant = empty;
  if (Number.isInteger(port) && port > 0) {
    fixed = runOne(null);
    mutant = anchorHit ? runOne(mutatedSrc) : empty;
  }
  const bytes1 = fs.readFileSync(MES);
  return {
    ok: Number.isInteger(port) && port > 0,
    port: Number.isInteger(port) ? port : 0,
    fixed, mutant, anchorHit,
    sha0, sha1: sha256(bytes1),
    diskUnchanged: Buffer.compare(bytes0, bytes1) === 0 && sha256(bytes1) === sha0,
    contractCheckPortsDynamic: contractCheckPortsDynamic()
  };
}

/* ==========================================================================
   D22 夹具：一个**最小但同形**的交付包（整棵树都在临时区里，绝不碰受管文件）
   --------------------------------------------------------------------------
   为什么不全量复制真包（≈250 MB）：真包 99.8% 的体积是 `._node\node.exe`（89 MB）、
   Edge MSI（203 MB）、Node zip（37 MB），而本脚本的判据**一条都不读这三者的内容**
   （唯一读 `node.exe` 的是第三组的版本断言，它只作用于**真包**）。
   夹具只需覆盖判据的**结构性**输入：便携 Node 家目录 ＋ 自带 `node_modules`(npm/corepack)、
   一条白名单外链、`.cmd` 入口引用一个包内 `.js`。
   变异**只在内存 `overrides` 里**做（judge 侧通过注入的 `readFile` 读到变异字节），
   故"还原"＝丢弃 overrides ＋ 逐文件 `Buffer.compare` 对快照 —— **不用** git。
   ========================================================================== */
function buildSelfFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-offline-fx-'));
  const put = (relPath, content) => {
    const abs = path.join(root, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  /* README 的行号必须与**真包**同形：真包里三条白名单 URL 恰在第 126／127 行
     （第 1 行是空行，第 126 行＝"直链"那行，第 127 行＝"官方入口 ＋ 元数据"那行）。
     ⚠ 这里**不硬编码 126/127**：行号从 `URL_ALLOWLIST` **直接派生** —— 白名单本来就是
     "行号真源"，若将来 README 增删行导致行号移动，只要同步白名单，夹具跟着走。
     **实测教训（本轮真的踩过一次）**：夹具第一版把两条 URL 写在第 126／127 行（自认为与真包同形），
     而真包实际是第 126 行**一条**、第 127 行**两条** ⇒ 夹具与白名单**差一行** ⇒
     夹具扫描报"3 处全部 allowlisted=false"，`--self`／D22 的"绿基线"断言当场假红。
     ⇒ 只要"夹具自己手抄行号"，就迟早与真包漂移；**从白名单派生**才不会有第二份真源。 */
  const urlEntries = URL_ALLOWLIST.filter(a => a.file === 'README-离线部署与体检.md');
  const maxLine = Math.max(...urlEntries.map(a => a.line));
  const readmeLines = new Array(maxLine + 3).fill('');
  readmeLines[0] = '';                                        // 第 1 行＝空行（与真包同形）
  readmeLines[1] = '# 夹具：离线部署与体检包（同形最小样本）';
  for (const a of urlEntries) readmeLines[a.line - 1] = '> 夹具注记：' + a.urls.map(u => '`' + u + '`').join('；') + '。';
  readmeLines[maxLine] = '| 文件 | `._edge\\MicrosoftEdgeEnterpriseX64-154.0.4258.37.msi`（夹具） |';
  readmeLines[maxLine + 1] = '包内 Node：`._node\\node.exe`；校验清单：`SHASUMS256.txt`。';
  readmeLines[maxLine + 2] = '双击 `体检-双击运行.cmd` / `跑现场门禁.cmd` / `体检-库结构核查.cmd`。';
  put('README-离线部署与体检.md', readmeLines.join('\n') + '\n');

  put('体检-双击运行.cmd', '@echo off\r\nrem 夹具：同形最小样本\r\n'
    + 'if exist "%~dp0._node\\node.exe" set "NODE_DIR=%~dp0._node"\r\n'
    + 'for %%f in ("%~dp0*.ps1") do set "SCRIPT=%%~ff"\r\n'
    + 'echo Report : written into the "._env-report" subfolder next to this script\r\n'
    + 'powershell.exe -NoProfile -File "%SCRIPT%"\r\n');
  put('跑现场门禁.cmd', '@echo off\r\nrem 夹具：仓库侧 tests\\ 里逐脚本跑\r\n'
    + 'for %%f in ("%~dp0*.ps1") do set "SCRIPT=%%~ff"\r\n'
    + 'powershell.exe -NoProfile -File "%SCRIPT%" -RunFieldGates\r\n');
  put('配置-DEP04.cmd', '@echo off\r\nrem 夹具\r\nfor %%f in ("%~dp0*.ps1") do set "SCRIPT=%%~ff"\r\n'
    + 'powershell.exe -NoProfile -File "%SCRIPT%" -ConfigureDep04\r\n');
  put('体检-库结构核查.cmd', '@echo off\r\nrem 夹具\r\n'
    + 'if exist "%~dp0._node\\node.exe" set "NODE_EXE=%~dp0._node\\node.exe"\r\n'
    + 'set "SCRIPT=%~dp0db-schema-check.js"\r\n'
    + 'echo Report : the "._env-report" subfolder next to this script\r\n'
    + '"%NODE_EXE%" "%SCRIPT%" %*\r\n');
  put('部署环境体检.ps1', '# 夹具：同形最小样本\nparam([switch]$ConfigureDep04, [switch]$RunFieldGates)\n'
    + "$node = Join-Path $PSScriptRoot '._node\\node.exe'\n"
    + "$repo = Get-ChildItem -Path (Split-Path $PSScriptRoot -Parent) -Filter 'tests\\preflight.js' -Recurse -ErrorAction SilentlyContinue\n");
  put('db-schema-check.js', "'use strict';\n// 夹具：零依赖，只用 Node 标准库\n");
  put('体检-库结构核查-执行方法.md', '# 夹具\n与 `db-schema-check.js` 同目录；双击 `体检-库结构核查.cmd` 即可。\n');
  put('SHASUMS256.txt', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  node-v24.21.0-win-x64.zip\n');
  put('node-v24.21.0-win-x64.zip', 'FAKE-ZIP');
  put('._node/node.exe', 'FAKE-EXE');
  put('._node/node_modules/npm/package.json',
    JSON.stringify({ name: 'npm', version: '11.0.0', description: 'npm 是 Node 官方发行版自带的包管理器（允许面①）' }, null, 2));
  put('._node/node_modules/corepack/package.json',
    JSON.stringify({ name: 'corepack', version: '0.31.0', description: 'corepack 是 Node 官方发行版自带（允许面①）' }, null, 2));
  put('._edge/MicrosoftEdgeEnterpriseX64-154.0.4258.37.msi', 'FAKE-MSI');
  put('._env-report/keep.txt', '夹具占位：._env-report 是报告目录\n');

  /* 夹具专用引用登记表：与真包那张**同判据**，只是缩到夹具能核对的粒度。
     ⚠ 与真包一致的口径：`.cmd` 用 `%~dp0*.ps1` **通配**找同目录的 .ps1（不写字面中文名，`E49`）。 */
  const FIXTURE_REFS = [
    { file: '体检-双击运行.cmd', ref: '._node\\node.exe', kind: 'internal', note: '夹具：包内便携 Node' },
    { file: '体检-双击运行.cmd', ref: '%~dp0*.ps1', kind: 'internal', note: '夹具：通配找同目录 .ps1' },
    { file: '体检-双击运行.cmd', ref: '._env-report', kind: 'internal', note: '夹具：报告目录' },
    { file: '跑现场门禁.cmd', ref: '%~dp0*.ps1', kind: 'internal', note: '夹具' },
    { file: '跑现场门禁.cmd', ref: 'tests\\', kind: 'external', note: '夹具：仓库侧脚本（包内不含）' },
    { file: '配置-DEP04.cmd', ref: '%~dp0*.ps1', kind: 'internal', note: '夹具' },
    { file: '体检-库结构核查.cmd', ref: '._node\\node.exe', kind: 'internal', note: '夹具' },
    { file: '体检-库结构核查.cmd', ref: 'db-schema-check.js', kind: 'internal', note: '夹具' },
    { file: '体检-库结构核查.cmd', ref: '._env-report', kind: 'internal', note: '夹具' },
    { file: '体检-库结构核查-执行方法.md', ref: 'db-schema-check.js', kind: 'internal', note: '夹具' },
    { file: '体检-库结构核查-执行方法.md', ref: '体检-库结构核查.cmd', kind: 'internal', note: '夹具' },
    { file: 'README-离线部署与体检.md', ref: '._node\\node.exe', kind: 'internal', note: '夹具' },
    { file: 'README-离线部署与体检.md', ref: 'SHASUMS256.txt', kind: 'internal', note: '夹具' },
    { file: 'README-离线部署与体检.md', ref: '体检-库结构核查.cmd', kind: 'internal', note: '夹具' },
    { file: 'README-离线部署与体检.md', ref: '跑现场门禁.cmd', kind: 'internal', note: '夹具' },
    { file: 'README-离线部署与体检.md', ref: '体检-双击运行.cmd', kind: 'internal', note: '夹具' },
    { file: 'README-离线部署与体检.md', ref: '._edge\\MicrosoftEdgeEnterpriseX64-154.0.4258.37.msi', kind: 'internal', note: '夹具' },
    { file: '部署环境体检.ps1', ref: 'tests\\preflight.js', kind: 'external', note: '夹具：仓库定位锚点' }
  ];

  /* 夹具的"README 得包含 ._edge\\…msi 这个名字"，否则上面那条登记核对会红 —— 已在行表里补齐 */

  const overrides = {};                       // relPath → Buffer（变异体；undefined ＝ 用盘上真字节）
  const snapshot = new Map();                 // relPath → 变异前的盘上字节
  const madeDirs = [];                        // 变异体新建的**空目录**（规则 A 是"目录级"判据，必须真的建出来）
  const listRel = () => {
    const out = [];
    (function rec(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) rec(abs);
        else out.push(path.relative(root, abs).split(path.sep).join('\\'));
      }
    })(root);
    return out.sort();
  };
  /** 判据侧的读：变异体优先，其余落盘 —— **不写盘**，所以真包/受管文件全程不动 */
  const readFile = abs => {
    const r = isInside(path.resolve(abs), root) ? relOf(root, path.resolve(abs)) : null;
    if (r && overrides[r] !== undefined) return overrides[r];
    return fs.readFileSync(abs);
  };
  /** 变异体在**盘上没有**的那些文件 → 合成"虚拟条目"补进判据的枚举面
   *  （`walk` 只读盘；不补的话，规则 C 永远枚举不到投放的 `package.json` ⇒ 该红不红）。 */
  const virtualEntries = () => Object.keys(overrides)
    .filter(r => !fs.existsSync(path.join(root, ...r.split('\\'))))
    .map(r => ({ abs: path.join(root, ...r.split('\\')), rel: r, kind: 'file', size: -1 }));
  const scan = () => scanDependencies(root, readFile, virtualEntries()).findings;
  const scanUrlHits = () => scanUrls(root, URL_ALLOWLIST, findPortableNodeRoot(root, walk(root)), readFile, virtualEntries());
  const shaAll = () => listRel().map(r => `${r}=${sha256(fs.readFileSync(path.join(root, ...r.split('\\'))))}`).join('\n');
  const takeSnapshot = () => { for (const r of listRel()) if (!snapshot.has(r)) snapshot.set(r, fs.readFileSync(path.join(root, ...r.split('\\')))); };

  return {
    root,
    FIXTURE_REFS,
    get files() { return listRel().length; },
    scan,
    scanUrlHits,
    scanShape: () => scanShape(root, FIXTURE_REFS, readFile),
    shaAll,
    /** 投放 `node_modules\` ＋ 带依赖的 `package.json`（文件字节只在**内存 overrides** 里；
     *  目录必须**真的建出来** —— 规则 A 是目录级判据，不建目录就等于没投放，会得到"假绿基线"） */
    mutateDependency() {
      takeSnapshot();
      const nmAbs = path.join(root, 'node_modules', 'left-pad');
      fs.mkdirSync(nmAbs, { recursive: true });
      madeDirs.push(path.join(root, 'node_modules'));
      overrides['node_modules\\left-pad\\package.json'] = Buffer.from(JSON.stringify({ name: 'left-pad', version: '1.3.0' }, null, 2));
      overrides['node_modules\\left-pad\\index.js'] = Buffer.from('module.exports = function leftPad() {};\n');
      overrides['package.json'] = Buffer.from(JSON.stringify({
        name: 'dashboard-offline-pkg', version: '1.2.0', description: '夹具投放的带依赖清单',
        dependencies: { 'left-pad': '^1.3.0' }
      }, null, 2));
      return ['新增 `node_modules\\left-pad\\`（目录 ＋ 2 个文件）', '新增 `package.json`（声明 `dependencies.left-pad`）'];
    },
    /** 往一条文本里插外链（**只在内存 overrides 里**） */
    mutateUrl() {
      takeSnapshot();
      const r = '体检-库结构核查-执行方法.md';
      const disk = fs.readFileSync(path.join(root, ...r.split('\\')));
      overrides[r] = Buffer.concat([disk, Buffer.from('\n<script src="https://cdn.example.com/x.js"></script>\n')]);
      return `${r}：追加 1 行 \`<script src="https://cdn.example.com/x.js"></script>\``;
    },
    /** 字节级还原：丢弃 overrides ＋ 删掉投放时新建的目录，再逐文件 `Buffer.compare` 对快照（禁用 git） */
    restore() {
      for (const k of Object.keys(overrides)) delete overrides[k];
      /* `E117`（2026-10-04）：`env.removeLinkSafe()` —— 判"目录项自身"是不是链接（是则只拆链、不递归），
         非链接时与 `rmSync(recursive)` 逐字等价；`madeDirs` 全部是本夹具自己 `mkdirSync` 出来的。 */
      for (const d of madeDirs.reverse()) { try { env.removeLinkSafe(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
      madeDirs.length = 0;
      for (const [r, bytes] of snapshot) {
        const abs = path.join(root, ...r.split('\\'));
        if (!fs.existsSync(abs)) throw new Error(`夹具还原失败（文件消失）：${r}`);
        if (Buffer.compare(fs.readFileSync(abs), bytes) !== 0) throw new Error(`夹具还原失败（字节不等）：${r}`);
      }
      snapshot.clear();
    },
    /* `E117`（2026-10-04）：`env.removeLinkSafe()` —— 非链接时与 `rmSync(recursive)` 逐字等价；
       `root` 是本夹具为"交付包形态"自建的临时包根，结构上不可能是链接。 */
    cleanup() { try { env.removeLinkSafe(root, { recursive: true, force: true }); } catch { /* 收尾忽略 */ } }
  };
}

/* ==========================================================================
   主流程
   ========================================================================== */
function main() {
  const t = createRunner('交付包离线自检（offline-check）');
  const LIST = process.argv.includes('--list');
  const SELF_ONLY = process.argv.includes('--self');

  if (LIST) {
    console.log('交付包离线自检（offline-check）检查面清单');
    console.log('包根：' + PKG_ROOT + (process.env.DSH_OFFLINE_PKG ? '（由 DSH_OFFLINE_PKG 覆盖）' : ''));
    console.log('\n一、包内无第三方依赖（scanDependencies 规则 A～E）');
    console.log('  A `node_modules\\` 只允许在便携 Node 家目录内');
    console.log('  B 便携 Node 的 node_modules 顶层条目只允许 ' + PORTABLE_NODE_BUNDLED.join('／'));
    console.log('  C package.json 不得声明 dependencies/devDependencies/…；零依赖的也必须写明用途');
    console.log('  D 包内不得有 .tgz/.tar.gz 依赖载荷');
    console.log('  E 包内不得有 vendor\\ 目录（便携 Node 之外）');
    console.log('\n二、包内无外网 URL（扫描扩展名：' + [...TEXT_EXTS].join(' ') + '）');
    console.log('  白名单 ' + URL_ALLOWLIST.length + ' 条（' + urlAllowCount() + ' 个 URL 片段；逐条附理由；双向判定：未登记⇒红，登记未命中⇒也红）');
    URL_ALLOWLIST.forEach((a, i) => console.log(`   ${i + 1}. ${a.file}:${a.line}（${a.urls.length} 条）`));
    console.log('\n三、形态自洽');
    console.log('  入口引用双向核对 ' + ENTRY_REFS.length + ' 条（包内引用必须存在；包外引用必须显式声明）');
    ENTRY_REFS.forEach((r, i) => console.log(`   ${i + 1}. [${r.kind}] ${r.file} → ${r.ref}`));
    console.log('  便携 Node 版本 vs ADR-0002 D10（>= ' + env.MIN_NODE_MAJOR + '）＋ 发行物 SHA256 vs SHASUMS256.txt');
    console.log('\n四、D22 定点变异（两组）＋ 在役工具端口冲突实测');
    console.log('   ① 夹具里放 node_modules\\／带依赖的 package.json ⇒ 必红并指名');
    console.log('   ② 夹具文本里插 https://cdn.example.com/x.js ⇒ 必红并指名');
    console.log('   ③ tools\\mock-mes 端口被占 ⇒ 打印 EADDRINUSE ＋ 非 0 退码；摘掉 error 监听（内存副本）⇒ 未捕获栈 ＋ 退 1');
    process.exit(env.EXIT_PASS);
  }

  if (!fs.existsSync(PKG_ROOT)) {
    env.skipSuite('交付包离线自检（offline-check）',
      `交付包目录不存在：${PKG_ROOT}（E9 盯的是"交付包形态"，包还没打出来 ⇒ 没有证据，不得记为通过）`);
  }

  const entries = walk(PKG_ROOT);
  const nodeRoot = findPortableNodeRoot(PKG_ROOT, entries);
  t.info(`包根：${PKG_ROOT}`);
  t.info(`包内 ${filesOf(entries).length} 个文件／${dirsOf(entries).length} 个目录；便携 Node：${nodeRoot ? relOf(PKG_ROOT, nodeRoot) : '(未找到)'}`);

  if (!SELF_ONLY) {
    /* ---------------- 一、包内无第三方依赖 ---------------- */
    t.section('一、包内无第三方依赖（ADR-0002 D9/D13；NFR-25 前端资源本地化）');
    {
      const dep = scanDependencies(PKG_ROOT);
      t.info(`扫描 ${dep.stats.files} 个文件／${dep.stats.dirs} 个目录；node_modules 目录 ${dep.stats.nodeModulesDirs} 个`
        + `（便携 Node **之外** ${dep.stats.outsideNodeModules.length} 个）；便携 Node＝${dep.stats.portableNode}`
        + (dep.stats.symlinks ? `；符号链接 ${dep.stats.symlinks} 个（**不跟随**，只记账）` : ''));
      t.check('① 包内没有"我们引入"的 node_modules（便携 Node **家目录之外**为零）',
        dep.stats.outsideNodeModules.length === 0,
        dep.stats.outsideNodeModules.length
          ? `命中 ${dep.stats.outsideNodeModules.length} 处：${dep.stats.outsideNodeModules.slice(0, 8).join('；')}`
          : `便携 Node 家目录之内有 ${dep.stats.nodeModulesDirs} 个 node_modules`
            + `（＝官方发行版自带的 ${PORTABLE_NODE_BUNDLED.join('／')}，见"允许面①"，**不算依赖**）`);
      const notA = dep.findings.filter(f => f.rule !== 'A');
      t.check('② 包内没有带 dependencies/devDependencies 的 package.json、没有 .tgz/.tar.gz 载荷、没有便携 Node 之外的 vendor\\',
        notA.length === 0,
        notA.length ? notA.map(f => `[${f.rule}] ${f.where}：${f.detail}`).join('；') : '三类均为零');
      t.check('③ 依赖面 finding 总数为零（**逐条指名**：任何一条都不得被"总数好看"掩盖）',
        dep.findings.length === 0,
        dep.findings.length
          ? `共 ${dep.findings.length} 条：\n        ` + dep.findings.map(f => `[${f.rule}] ${f.where}：${f.detail}`).join('\n        ')
          : '零 finding');
    }

    /* ---------------- 二、包内无外网 URL ---------------- */
    t.section('二、包内无外网 URL（NFR-25 / AC-09 无外网访问）');
    {
      const url = scanUrls(PKG_ROOT, URL_ALLOWLIST, nodeRoot);
      const bad = url.hits.filter(h => !h.allowlisted);
      t.info(`扫描 ${url.files} 个文本文件；URL 命中 ${url.hits.length} 处，其中白名单 ${url.hits.length - bad.length} 处`);
      t.check('④ 包内文本里的外网 URL 全部落在**逐条附理由**的白名单内（未登记的一律指名：文件＋行号＋片段）',
        bad.length === 0,
        bad.length
          ? `未登记 ${bad.length} 处：\n        ` + bad.map(h => `${h.file}:${h.line} → ${JSON.stringify(h.text)}`).join('\n        ')
          : (url.hits.map(h => `${h.file}:${h.line}（白名单）`).join('；') || '（包内文本无任何外网 URL）'));
      t.check('⑤ 白名单是**双向**的：登记了但包内已不命中 ⇒ **也红**（否则白名单会腐烂成"永久豁免"，ADR-0004 D23）',
        url.allowlistUnused.length === 0,
        url.allowlistUnused.length
          ? `腐烂 ${url.allowlistUnused.length} 条：${url.allowlistUnused.join('；')}`
          : `${URL_ALLOWLIST.length} 条（${urlAllowCount()} 个 URL 片段）全部命中`);
      t.check('⑥ 白名单每一条都写明了理由（`E9` 原文："每一条白名单都要在断言里列明并给出理由"）',
        URL_ALLOWLIST.every(a => typeof a.reason === 'string' && a.reason.trim().length >= 20),
        URL_ALLOWLIST.map(a => `${a.file}:${a.line} 理由 ${a.reason.trim().length} 字`).join('；'));
      t.check('⑦ 扫描面自证：确实扫到了包内文本文件（否则"零命中"是**空洞绿** —— 扫 0 个文件也会零命中）',
        url.files >= 5,
        `实扫 ${url.files} 个文本文件`);
    }

    /* ---------------- 三、形态自洽 ---------------- */
    t.section('三、形态自洽（入口引用 ↔ 包内实际文件；便携 Node 版本 vs ADR-0002 D10）');
    {
      const shape = scanShape(PKG_ROOT, ENTRY_REFS);
      t.info(`入口引用登记 ${ENTRY_REFS.length} 条；包外引用 ${shape.externalDeclared.length} 条：`
        + shape.externalDeclared.map(e => `${e.file}→${e.ref}`).join('；'));
      t.check('⑧ 入口（.cmd/.ps1/.md）引用的**包内**路径全部真实存在，且"登记表 ↔ 文件内容"双向一致（D23 名实相符）',
        shape.findings.length === 0,
        shape.findings.length
          ? `共 ${shape.findings.length} 条：\n        ` + shape.findings.map(f => `[${f.rule}] ${f.where}：${f.detail}`).join('\n        ')
          : `${ENTRY_REFS.length} 条全部核对通过`);
      t.check('⑨ 包外引用（仓库侧 tests\\）已由包内文档/入口**显式声明** —— 包内不含仓库是设计，但不得成为隐性前置',
        shape.externalDeclared.length >= 2
          && shape.externalDeclared.some(e => e.ref === 'tests\\preflight.js')
          && fs.readFileSync(path.join(PKG_ROOT, '部署环境体检.ps1'), 'utf8').includes('tests\\preflight.js'),
        shape.externalDeclared.map(e => `${e.file}→${e.ref}（${e.note}）`).join('；'));

      const ver = checkPortableNodeVersion(PKG_ROOT, entries);
      t.info('便携 Node 事实：' + JSON.stringify(ver.facts));
      const gFind = ver.findings.filter(f => f.rule === 'G');
      t.check('⑩ 便携 Node 版本满足 `ADR-0002` **D10**（Node >= ' + env.MIN_NODE_MAJOR
        + '，锁死下限、禁止降到 22.x），且与包内发行物文件名一致',
        ver.facts.major !== undefined && ver.facts.major >= env.MIN_NODE_MAJOR && gFind.length === 0,
        gFind.length ? gFind.map(f => f.detail).join('；') : `node.exe --version = ${ver.facts.exeVersion}（下限 ${env.MIN_NODE_MAJOR}）`);
      t.check('⑪ 包内 `node-vX.Y.Z-win-x64.zip` 的实算 SHA256 ＝ `SHASUMS256.txt`（Node 官方发布页原样）里那一行 ⇒ 离线可自证发行物完整性',
        Boolean(ver.facts.zipSha256) && ver.facts.zipSha256 === ver.facts.shasumsSha256,
        `实算=${ver.facts.zipSha256 || '(无)'}；SHASUMS256.txt=${ver.facts.shasumsSha256 || '(无)'}；`
          + `zip=${ver.facts.zipName || '(无)'}（${ver.facts.zipBytes || '?'} B）`);
    }
  }

  /* ---------------- 四、D22 定点变异（两组）＋ 在役工具端口冲突实测 ---------------- */
  if (SELF_ONLY) {
    t.section('--self：工具自证（把缺陷投放进临时夹具，再用同一套判据扫 ⇒ 必红并指名）');
    t.info('真实包那一组在 `node tests\\offline-check.js`（不带 --self）里跑；本模式只证"判据不是恒真式"。');
    const fx = buildSelfFixture();
    const clean = fx.scan();
    const cleanUrl = fx.scanUrlHits();
    t.check('S1 夹具基线是绿的：零依赖 finding，且外链全部落在白名单内（先有绿基线，"变红"才有意义）',
      clean.length === 0 && cleanUrl.hits.length >= 3 && cleanUrl.hits.every(h => h.allowlisted),
      `依赖 finding=${clean.length}；外链命中=${cleanUrl.hits.length}（白名单 ${cleanUrl.hits.filter(h => h.allowlisted).length}）`
        + (clean.length ? `：${clean.map(f => `[${f.rule}] ${f.where}`).join('；')}` : ''));
    const s1 = fx.scanShape();
    t.check('S2 夹具的入口引用也自洽（第三组判据在同形夹具上同样是绿的）',
      s1.findings.length === 0,
      s1.findings.map(f => `[${f.rule}] ${f.where}：${f.detail}`).join('；') || `${fx.FIXTURE_REFS.length} 条通过`);
    const hash0 = fx.shaAll();
    const mut1 = fx.mutateDependency();
    const f1 = fx.scan();
    t.check('S3 D22-①（依赖）：投放 `node_modules\\` ＋ 带 `dependencies` 的 `package.json` ⇒ 判据**必红并指名**',
      f1.length > 0 && f1.some(f => f.rule === 'A' && f.where.includes('node_modules'))
        && f1.some(f => f.rule === 'C' && f.where.includes('package.json')),
      `投放：${mut1.join('；')}\n        命中 ${f1.length} 条：` + f1.map(f => `[${f.rule}] ${f.where}：${f.detail}`).join(' ／ '));
    fx.restore();
    t.check('S4 D22-① 还原：夹具逐字节回到变异前（Buffer.compare ＋ 逐文件 SHA-256；**不用** git checkout/restore/stash）',
      fx.shaAll() === hash0 && fx.scan().length === 0,
      `还原后 sha 与变异前${fx.shaAll() === hash0 ? '相同' : '**不同**'}；依赖 finding=${fx.scan().length}`);
    const mut2 = fx.mutateUrl();
    const u2 = fx.scanUrlHits().hits.filter(h => !h.allowlisted);
    t.check('S5 D22-②（外链）：投放 `https://cdn.example.com/x.js` ⇒ 判据**必红并指名**（文件＋行号＋片段）',
      u2.length > 0 && u2.some(h => h.text.includes('https://cdn.example.com/x.js') && h.text.includes('cdn.')),
      `投放：${mut2}\n        未登记命中 ${u2.length} 处：` + u2.map(h => `${h.file}:${h.line} → ${JSON.stringify(h.text)}`).join(' ／ '));
    fx.restore();
    t.check('S6 D22-② 还原：夹具逐字节回到变异前，且原白名单仍被正确识别（⇒ 判据不是"见到 URL 就红"）',
      fx.shaAll() === hash0 && fx.scanUrlHits().hits.length >= 3 && fx.scanUrlHits().hits.every(h => h.allowlisted),
      `还原后 sha 与变异前${fx.shaAll() === hash0 ? '相同' : '**不同**'}；白名单命中 `
        + `${fx.scanUrlHits().hits.length} 处、全部 allowlisted=${fx.scanUrlHits().hits.every(h => h.allowlisted)}`);
    fx.cleanup();
  } else {
    t.section('四、D22 定点变异（两组，必红并指名）＋ 在役工具端口冲突实测（承 E98/E100）');
    /* ---- ① / ②：在**临时夹具**上投放两组缺陷，再用同一套判据扫 ⇒ 必红并指名 ---- */
    const fx = buildSelfFixture();
    t.info(`夹具：${fx.root}（${fx.files} 个文件；整棵树都在临时区里，**不碰受管文件**）`);
    const hash0 = fx.shaAll();

    t.check('⑫ D22-①／② 的**绿基线**：夹具本身是"零依赖、无未登记外链的好包"⇒ 判据绿（先有绿基线，"变红"才有意义）',
      fx.scan().length === 0 && fx.scanUrlHits().hits.every(h => h.allowlisted),
      `依赖 finding=${fx.scan().length}；外链命中=${fx.scanUrlHits().hits.length} 处（全部白名单=${fx.scanUrlHits().hits.every(h => h.allowlisted)}）`);

    const mut1 = fx.mutateDependency();
    const f1 = fx.scan();
    t.check('⑬ D22-①（依赖）：往夹具里投放 `node_modules\\` ＋ 带 dependencies 的 `package.json` ⇒ 判据**必红并指名**'
      + '（指名到"规则 ＋ 路径 ＋ 为什么"，不是只说"有 1 条失败"）',
      f1.length > 0
        && f1.some(f => f.rule === 'A' && f.where.includes('node_modules'))
        && f1.some(f => f.rule === 'C' && f.where.includes('package.json')),
      `投放：${mut1.join('；')}\n        命中 ${f1.length} 条：` + f1.map(f => `[${f.rule}] ${f.where}：${f.detail}`).join(' ／ '));

    fx.restore();
    t.check('⑭ D22-① 还原：夹具**逐字节**回到变异前（Buffer.compare ＋ 逐文件 SHA-256；禁用 git checkout/restore/stash）',
      fx.shaAll() === hash0 && fx.scan().length === 0,
      `还原后 sha 与变异前${fx.shaAll() === hash0 ? '相同' : '**不同**'}；依赖 finding=${fx.scan().length}`);

    const mut2 = fx.mutateUrl();
    const u2 = fx.scanUrlHits().hits.filter(h => !h.allowlisted);
    t.check('⑮ D22-②（外链）：往夹具文本里插一条 `https://cdn.example.com/x.js` ⇒ 判据**必红并指名**（文件＋行号＋片段）',
      u2.length > 0 && u2.some(h => h.text.includes('https://cdn.example.com/x.js') && h.text.includes('cdn.')),
      `投放：${mut2}\n        未登记命中 ${u2.length} 处：` + u2.map(h => `${h.file}:${h.line} → ${JSON.stringify(h.text)}`).join(' ／ '));

    fx.restore();
    t.check('⑯ D22-② 还原：夹具回到变异前（字节级），且原夹具里的**白名单**仍被正确识别（⇒ 判据不是"见到 URL 就红"）',
      fx.shaAll() === hash0 && fx.scanUrlHits().hits.length >= 3 && fx.scanUrlHits().hits.every(h => h.allowlisted),
      `还原后 sha 与变异前${fx.shaAll() === hash0 ? '相同' : '**不同**'}；白名单命中 `
        + `${fx.scanUrlHits().hits.length} 处、全部 allowlisted=${fx.scanUrlHits().hits.every(h => h.allowlisted)}`);
    fx.cleanup();

    /* ---- ③：真工具 `tools\mock-mes` 的端口冲突（`E100`，变异用**内存字节副本**） ---- */
    const probe = realToolPortProbe();
    t.info(`端口冲突实测：占住端口 ${probe.port}（现取的空闲端口）；修复态 exit=${probe.fixed.exit}；`
      + `变异体 exit=${probe.mutant.exit}；变异锚点命中=${probe.anchorHit}`);
    t.check('⑰ `E100`①（真工具、真端口）：端口被占时 `tools\\mock-mes` 打印 `EADDRINUSE` 字样'
      + '（`E98` 的 `collided` 分类**只认这个证据**，把它藏起来就等于让分类失效）＋ 可读的中文原因',
      probe.fixed.hasAddrInUse && /无法监听端口/.test(probe.fixed.err + probe.fixed.out),
      `exit=${probe.fixed.exit}；stderr=${JSON.stringify(probe.fixed.err.trim().split(/\r?\n/).slice(0, 2).join(' | '))}`);
    t.check('⑱ `E100`①（真工具、真端口）：端口被占时**以非 0 退码优雅退出**（不再抛未捕获事件栈把调用方当场打断）',
      probe.fixed.exit !== null && probe.fixed.exit !== 0 && !probe.fixed.hasUncaught,
      `exit=${probe.fixed.exit}（期望非 0）；含未捕获事件栈=${probe.fixed.hasUncaught}`);
    t.check('⑲ `E100` D22（承重性）：把新加的 `\'error\'` 监听**整段摘掉**（**内存 `Module._compile` 副本**，盘上不动）'
      + '⇒ 必回到"未捕获 `Unhandled \'error\' event` ＋ 退 1"（＝改前 `HEAD` 版的实测形态）；同一端口同一手法下两种形态的收场**必须不同**',
      probe.mutant.hasUncaught && probe.fixed.exit === 2 && probe.mutant.exit === 1,
      `修复态 exit=${probe.fixed.exit}／未捕获栈=${probe.fixed.hasUncaught}；`
        + `变异体 exit=${probe.mutant.exit}／未捕获栈=${probe.mutant.hasUncaught}；`
        + `变异体 stderr=${JSON.stringify(probe.mutant.err.trim().split(/\r?\n/).slice(0, 2).join(' | '))}`);
    t.check('⑳ `E100` D22（还原）：变异全程只在**内存副本**上做，`tools\\mock-mes\\mock-mes.js` 盘上字节'
      + '**逐字节不变**（Buffer.compare ＋ SHA-256；禁用 git checkout/restore/stash）',
      probe.diskUnchanged,
      `原件 sha=${probe.sha0.slice(0, 16)}… ↔ 事后 sha=${probe.sha1.slice(0, 16)}…；Buffer.compare 相等=${probe.diskUnchanged}`);
    t.check('㉑ `E100`②（contract-check）：`tests\\contract-check.js` 已不再**写死**端口，改用夹具 `allocPort()`'
      + '（判据取**剥注释后的代码区**：那四个端口号作为历史留在注释/文案里是对的，不逼后来者删掉溯源信息）',
      probe.contractCheckPortsDynamic.ok,
      probe.contractCheckPortsDynamic.detail);
  }

  t.finish();
}

try {
  main();
} catch (err) {
  console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
  process.exit(2);
}
