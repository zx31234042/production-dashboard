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

/* 注：`runMain(fn)`（带异常兜底的 main 包装，异常退 2）已于 2026-09-19 删除 ——
   12 个脚本各自在尾部写了 try/catch，它从加进来起就**零引用**
   （R-2026-09-19-02 的 P2-16："交付了却从未被验证"）。留着只会让后来者以为它会生效。 */

module.exports = { createRunner };
