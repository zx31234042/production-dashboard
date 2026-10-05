/* ==========================================================================
   断言与汇总（tests/lib/assert.js）
   作用：把现有 11 个自检脚本里"各写一份"的 check/汇总/退出码逻辑抽成公共件，
        新脚本（尤其后端脚本）直接复用，保证**风格与口径完全一致**。
   输出契约（**不可改**）：汇总行必须是
        `通过 N 项，失败 N 项，跳过 N 项`
      因为 tests/run-all.js 与 tests/README.md 的门禁数字机制都解析这一行。
   依据：ADR-0003 D14（自写 check()、不引测试框架）、D15（统一 runner）。
   依赖：仅 Node 内置模块。
   用法：
     const t = createRunner('需求追溯自检（trace-check）');
     t.section('一、追溯表完整性');
     t.check('每条条款都有归属', ok, detail);
     t.skip('工作日志声明的规范版本一致', '工作日志里没有声明规范版本');
     t.finish();
   ========================================================================== */
'use strict';

/**
 * 创建一个 runner。返回对象各方法均返回自身，便于链式调用。
 * @param {string} title 脚本标题（打印在首行）
 * @param {{verbose?: boolean}} [options] verbose=true 时 [PASS] 也打印详情
 */
function createRunner(title, options = {}) {
  const verbose = options.verbose === true;
  let passed = 0;
  let skipped = 0;
  const failures = [];   // { name, detail }
  const skips = [];      // { name, reason }
  const unmet = [];      // { name, detail } 前提不成立（ADR-0004 D20）

  const head = (kind, name, extra) => console.log(`  [${kind}] ${name}${extra ? ' —— ' + extra : ''}`);

  return {
    title,

    /** 打印章节标题（沿用现有脚本的 `=== 标题 ===` 形式） */
    section(name) {
      console.log(`\n=== ${name} ===`);
      return this;
    },

    /** 普通输出（不计入断言） */
    info(text) {
      console.log(`  ${text}`);
      return this;
    },

    /** 一条断言；ok 为真即通过 */
    check(name, ok, detail) {
      if (ok) {
        passed++;
        if (verbose && detail) head('PASS', name, detail);
        else console.log(`  [PASS] ${name}`);
      } else {
        failures.push({ name, detail });
        head('FAIL', name, detail);
      }
      return this;
    },

    /**
     * **前提**（ADR-0004 D20）：声明"该段用例成立所依赖的数据/环境状态"。
     *
     * 为什么不写成 `check`：前提塌掉时，普通断言给出的是一条与"实现错误"**无法区分**的 FAIL，
     * 于是要么被误当实现 bug 排查，要么被顺手放宽期望 —— 后者会悄悄变成恒真断言。
     *
     * 判据（务必守住）：**前提只描述"数据/环境必须处于某状态"，
     * 不得描述"被测函数的返回值"** —— 后者属于断言，写这里就等于把被测对象当前提。
     *
     * 语义：成立 → 不计数（不是断言）；不成立 → 汇总单列"前提不成立 N 项"并**使退出码非 0**。
     * 与 `skip` 的区别：`skip` 是"环境不满足、本用例不适用"（不算失败）；
     * `requires` 是"**该用例的前提假设被破坏**"（算失败，必须查）。
     *
     * @returns {boolean} 是否成立 —— 调用方据此决定要不要进入该段（惯例：`if (!t.requires(...)) return;`）
     */
    requires(name, ok, detail) {
      if (ok) {
        if (verbose) console.log(`  [OK]   前提成立：${name}`);
      } else {
        unmet.push({ name, detail });
        head('UNMET', `前提不成立：${name}`, detail);
      }
      return Boolean(ok);
    },

    /** 跳过（不算通过也不算失败；会在汇总里单列原因） */
    skip(name, reason) {
      skipped++;
      skips.push({ name, reason });
      head('SKIP', name, reason);
      return this;
    },

    /* ---------------- 状态读取（供夹具或上层组合使用） ---------------- */
    get counts() {
      return { passed, failed: failures.length, skipped, unmet: unmet.length,
        total: passed + failures.length + skipped };
    },
    get failures() { return failures.slice(); },
    get skips() { return skips.slice(); },
    get unmetRequirements() { return unmet.slice(); },

    /**
     * 打印汇总并按退出码结束进程。
     * 退出码：0 全过 / 1 有断言失败**或前提不成立**（规范 9.5-5：没有证据不等于通过）。
     * 前提不成立单独成段列出，便于一眼区分"前提塌了"与"实现错了"。
     */
    finish() {
      console.log('\n=== 汇总 ===');
      console.log(`通过 ${passed} 项，失败 ${failures.length} 项，跳过 ${skipped} 项`);
      if (unmet.length) {
        console.log('\n前提不成立（**不是通过**，须先查前提假设或数据准备）：');
        unmet.forEach((u, i) => console.log(`  ${i + 1}. ${u.name}${u.detail ? ' —— ' + u.detail : ''}`));
      }
      if (failures.length) {
        console.log('\n失败清单：');
        failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ' —— ' + f.detail : ''}`));
      }
      if (skipped) {
        console.log('\n跳过清单（不计入失败）：');
        skips.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}${s.reason ? ' —— ' + s.reason : ''}`));
      }
      process.exit(failures.length || unmet.length ? 1 : 0);
    }
  };
}

/* 注（**2026-09-30 口径更正，T-20260930-31 ＋ T-20260930-32**）：`runMain(fn)`（带异常兜底的 main 包装，
   异常退 2）已于 2026-09-19 删除，当时的理由是"12 个脚本各自在尾部写了 try/catch"
   （R-2026-09-19-02 的 P2-16："交付了却从未被验证"）。**那个理由对 `async main()` 不成立**：
   顶层 `try` 包 `main()` 只能接住 **同步**抛错，`main()` 返回的 promise 一旦 reject，
   顶层 try/catch **抓不到** ⇒ 由 Node 以"未处理 rejection"结束进程，表现为"**无汇总行 ＋ 退 1**"。

   **记账口径更正（座位 5 实测 ＋ 本包对真函数复算；旧注记此句是错的）**：旧注记写的是
   "`run-all` 把它记成'没有断言失败'而不是'跑不起来'"（另一种写法是"记成 `error`／记成 `unverified`"）
   —— **实测均不成立**：`run-all.classify(1, null, out)` ⇒ `status='failed'`、`detail='退出码 1'`
   （输出连一个字节都没有时也照样 `failed`）；`unverified` **只**对"**退出码 0** 且（无汇总行／
   通过 0 项）"成立（就是 `classify` 的 ⑤⑦ 两支，见 `run-all.js`）。
   ⇒ **危害结论不变**：`E76①` 修前那种"rejection 静默退 1"与本文件里"**有断言失败**"在 `run-all`
   台账上**逐字同形**（都是 `failed` ＋ `退出码 1`）—— 只是注记必须按实测写，不能照旧说法抄。

   **当前口径（各脚本自查，不用共享包装）**：
     · `async main()` 的脚本 ⇒ 尾部把 `.catch()` 挂在 promise 上（异常**打印出来**），按 9.5-5 退 **2**；
     · `function main()`（同步）的脚本 ⇒ 顶层 `try`/`catch` ＋ 退 **2**
       （见 `copy-check.js` / `trace-check.js` / `docs-cross-check.js` / `screenshot-diff.js`）。
   **曾漏掉的三个**（座位 5 于 2026-09-30 实测，报告 C·13.5）：`tests\db-check.js`、
   `tests\harness-check.js`、`tests\preflight.js` —— 它们写了顶层 `try` 包 `main()` 而 `main()` 是
   **async**，故"脚本自身异常"落成"退 1"。`E76` 已修（三处均改为 `.catch()` 挂在 promise 上）。
   形态回潮由 `harness-check` 第十六节（`E78`）静态守住（async ⇒ 必有 `.catch()` ＋ 退 2；
   sync ⇒ `try`/`catch` ＋ 退 2；禁止对 async 用顶层 `try` 包 `main()`）。

   **异常打印前缀的现状（2026-10-01 普查，勿按"当前口径"读）**：含 `main()` 的 **16** 个 `tests\*.js` 里，
   **只有 E76 修的这 3 个**（`db-check`／`harness-check`／`preflight`）打 `[脚本异常]`；
   **5** 个打 `自检脚本异常终止：`（`browser-check`／`contract-check`／`docs-check`／`tools-check`／`ui-check`）；
   **7** 个打 `脚本异常终止：`（`capture-baseline`／`copy-check`／`docs-cross-check`／`overlap-check`／
   `screenshot-diff`／`stress-check`／`trace-check`）；`run-all.js` 自己打 `runner 异常终止：`
   （**不含** `脚本异常终止` 这几个字）。
   **红线**：`tests\run-all.js` 的失败明细过滤**按字面 `脚本异常终止` 命中**
   （该文件 `tail()` 里 `filter(l => /\[FAIL\]|失败清单|^\s+\d+\.|脚本异常终止/…)`）
   ⇒ 任何前缀统一**不得丢掉"脚本异常终止"这几个字**（否则明细行会静默消失）。
   "给其余脚本也加 `[脚本异常]`"属**可选**后续项（本包**未做**：要动 13 个文件的输出文案，
   收益只是整齐；且必须同时保留 `脚本异常终止`）。 */


/* ==========================================================================
   **源码字面量剥除器：`isRegexStart` ＋ `stripLiterals`（单一真源）**
   `T-20261004-01`（2026-10-04，`E103` 甲组）：原先它定义在 `tests\harness-check.js` 第十六节**块内**，
   于是 `E103` 的新判据（同文件第五节）够不着它 —— 要么复制第二份（必然漂移），要么搬家。选定**搬家**：
   落点＝本文件（共享的断言／静态判据基建），`harness-check` 顶层 `require` 后**同一个函数对象**两处共用。
   语义**逐字未变**（与搬迁前字节相同，仅去掉两级缩进）：
     · 把注释、字符串／模板串、正则的**内容**换成空格，**长度与换行保持不变** ⇒ 下标仍可直接当锚点；
     · 模板串插值 `${…}` 只 blank `$`、**保留** `{`／`}`（`T-20261002-03` 实测的坑，见下方注释原文）；
     · 容错：未闭合的字符串／正则止于行尾（宁可多剥，不可漏剥）。
   用途：判据只认**代码**里的形态 —— 说明文字里的同名写法不算证据（`E79` 的 F1/F3/F4 诱饵）。
   ========================================================================== */
const isRegexStart = (out, i) => {
  let k = i - 1;
  while (k >= 0 && /\s/.test(out[k])) k--;
  if (k < 0) return true;
  if ('([{,;:=!&|?+-*%~^<>'.includes(out[k])) return true;
  let w = k;
  while (w >= 0 && /[A-Za-z_$]/.test(out[w])) w--;
  return /^(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(out.slice(w + 1, k + 1).join(''));
};

/** 把注释与字符串/模板串/正则的**内容**换成空格；**长度与换行保持不变** ⇒ 下标仍可直接当锚点。
    目的：判据只认**代码**里的退出语句（`console.error('process.exit(2)')` 不是退出证据 —— F1/F3/F4）。 */
const stripLiterals = src => {
  const out = src.split('');
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  let mode = 'code';
  const stack = [];                                 /* 模板串插值 `${ … }`：braces＝插值内花括号深度 */
  let i = 0;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { blank(i, i + 2); mode = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { blank(i, i + 2); mode = 'block'; i += 2; continue; }
      if (c === "'") { blank(i, i + 1); mode = 'sq'; i++; continue; }
      if (c === '"') { blank(i, i + 1); mode = 'dq'; i++; continue; }
      if (c === '`') { blank(i, i + 1); mode = 'tpl'; i++; continue; }
      if (c === '/' && isRegexStart(out, i)) { blank(i, i + 1); mode = 're'; i++; continue; }
      if (stack.length) {                            /* 模板串插值内部按**代码**处理（保留求值语义） */
        if (c === '{') stack[stack.length - 1].braces++;
        else if (c === '}') {
          if (stack[stack.length - 1].braces === 0) { stack.pop(); mode = 'tpl'; }
          else stack[stack.length - 1].braces--;
        }
      }
      i++; continue;
    }
    if (mode === 'line') { blank(i, i + 1); if (c === '\n') mode = 'code'; i++; continue; }
    if (mode === 'block') {
      if (c === '*' && c2 === '/') { blank(i, i + 2); mode = 'code'; i += 2; continue; }
      blank(i, i + 1); i++; continue;
    }
    if (mode === 'sq' || mode === 'dq') {
      const q = mode === 'sq' ? "'" : '"';
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === q) { blank(i, i + 1); mode = 'code'; i++; continue; }
      if (c === '\n') { mode = 'code'; i++; continue; }          /* 容错：未闭合的字符串止于行尾 */
      blank(i, i + 1); i++; continue;
    }
    if (mode === 'tpl') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { blank(i, i + 1); mode = 'code'; i++; continue; }
      if (c === '$' && c2 === '{') {
        /* 模板串插值 `${ … }`：**保留** `$` 与 `{` 两个字符 —— 它们是**代码**的一部分。
           `T-20261002-03` 实测的坑（必须留痕）：原写法把 `${` 两个字符一起 blank，插值内的花括号就
           少了一个左花括号与之配对 ⇒ 后面那个真 `}`（在剥后文本里）会被 `regionOf` 当成块尾提前闭合：
           例 `server\index.js` 的 `const text = \`[启动失败] ${err && …}\`` ⇒ 正文被截到插值处，
           `.catch` 区间里就"看不到" `process.exit(2)`（**假判红**）。保留 `${` 后，插值内的
           `{`／`}` 成对，`regionOf` 才配得准（`$(…)` 之外的字符串/注释/正则仍然照剥 —— §16-H 不受影响）。 */
        blank(i, i + 1); i++;                                /* 只 blank `$`，保留 `{` */
        stack.push({ braces: 0 }); mode = 'code'; i++; continue;
      }
      blank(i, i + 1); i++; continue;
    }
    if (mode === 're') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '[') { blank(i, i + 1); mode = 'reclass'; i++; continue; }
      if (c === '/') { blank(i, i + 1); mode = 'code'; i++; continue; }
      if (c === '\n') { mode = 'code'; i++; continue; }          /* 容错：未闭合的正则止于行尾 */
      blank(i, i + 1); i++; continue;
    }
    /* mode === 'reclass'：正则的字符类内部（`/` 不结束正则） */
    if (c === '\\') { blank(i, i + 2); i += 2; continue; }
    if (c === ']') { blank(i, i + 1); mode = 're'; i++; continue; }
    blank(i, i + 1); i++; continue;
  }
  return out.join('');
};

module.exports = { createRunner, stripLiterals };
