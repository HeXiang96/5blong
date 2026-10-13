/**
 * 探针脚本共用的断言工具。
 *
 * 起因：这些探针原来只会打印数字和存一张截图，对错全靠我看图判断。
 * 结果就是——"猪有没有瞬移"这种问题，我两次都判成了通过，其实是假通过。
 * 现在把判定写成断言，失败就退出码非零，能进 CI 也可以被我自己复查。
 */

let failed = 0;
let passed = 0;

const PASS = "\u001b[32m✓\u001b[0m";
const FAIL = "\u001b[31m✗\u001b[0m";

/** 断言为真。 */
export function ok(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ${PASS} ${label}${detail ? "  " + detail : ""}`);
  } else {
    failed += 1;
    console.log(`  ${FAIL} ${label}${detail ? "  " + detail : ""}`);
  }
  return condition;
}

/** 数值落在区间内。 */
export function inRange(label, value, min, max) {
  const good = typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  return ok(label, good, `实测 ${value}，期望 ${min}~${max}`);
}

/** 数值不超过上限（用于"不该出现大跳变"这类断言）。 */
export function atMost(label, value, max) {
  return ok(label, typeof value === "number" && value <= max, `实测 ${value}，上限 ${max}`);
}

/** 断言为假（用于"不该发生"的事）。 */
export function not(label, condition, detail = "") {
  return ok(label, !condition, detail);
}

/** 收尾：打印汇总，有失败则退出码 1。 */
export function finish(title = "检查结果") {
  console.log("");
  console.log(`${title}：${passed} 项通过，${failed} 项失败`);
  if (failed > 0) {
    console.log("有断言失败，退出码置为 1");
    process.exitCode = 1;
  }
  return failed === 0;
}

export function summary() {
  return { passed, failed };
}
