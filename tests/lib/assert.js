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

    /** 跳过（不算通过也不算失败；会在汇总里单列原因） */
    skip(name, reason) {
      skipped++;
      skips.push({ name, reason });
      head('SKIP', name, reason);
      return this;
    },

    /* ---------------- 状态读取（供夹具或上层组合使用） ---------------- */
    get counts() {
      return { passed, failed: failures.length, skipped, total: passed + failures.length + skipped };
    },
    get failures() { return failures.slice(); },
    get skips() { return skips.slice(); },

    /**
     * 打印汇总并按退出码结束进程（与现有脚本一致：0 全过 / 1 有失败）。
     * 跳过项会在汇总后列出，**但不影响退出码** —— 与既有脚本行为一致。
     */
    finish() {
      console.log('\n=== 汇总 ===');
      console.log(`通过 ${passed} 项，失败 ${failures.length} 项，跳过 ${skipped} 项`);
      if (failures.length) {
        console.log('\n失败清单：');
        failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ' —— ' + f.detail : ''}`));
      }
      if (skipped) {
        console.log('\n跳过清单（不计入失败）：');
        skips.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}${s.reason ? ' —— ' + s.reason : ''}`));
      }
      process.exit(failures.length ? 1 : 0);
    }
  };
}

/**
 * 带异常兜底的 main 包装：脚本抛异常时以退出码 2 结束，并把堆栈打出来。
 * 与现有脚本尾部的 try/catch 约定一致。
 */
function runMain(fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      r.catch(err => {
        console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
        process.exit(2);
      });
    }
  } catch (err) {
    console.error('\n脚本异常终止：' + (err && err.stack ? err.stack : err));
    process.exit(2);
  }
}

module.exports = { createRunner, runMain };
