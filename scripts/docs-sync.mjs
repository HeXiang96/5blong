#!/usr/bin/env node
// docs-sync.mjs — 把"代码里查得到的事实"自动注入文档，杜绝手写数字腐化。
//
// 目前注入项（README.md，标记对包裹）：
//   <!-- AUTO:TESTS -->N<!-- /AUTO:TESTS -->  ← 用例总数（vitest list 收集）
//
// 用法：npm run docs:sync
// 原则：所有 AUTO:* 标记区块由本脚本独占写入，任何 AI / 人工不要手改区块内容。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const README = path.join(ROOT, "README.md");

const fail = (msg) => {
  console.error(`docs-sync: ✗ ${msg}`);
  process.exit(1);
};

// ── 1. 用例总数（收集口径；it.each 已按展开计）──────────────────────────
function countTests() {
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(ROOT, "node_modules/vitest/vitest.mjs"), "list"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.split("\n").filter((l) => l.includes(" > ")).length;
  } catch (e) {
    fail(`无法收集用例（vitest list 失败）：${e.message?.slice(0, 200)}`);
  }
}

// ── 2. 注入 ────────────────────────────────────────────────────────────
function inject(content, openTag, closeTag, value) {
  const re = new RegExp(
    `${openTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${closeTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "g",
  );
  const full = `${openTag}${value}${closeTag}`;
  const n = (content.match(re) || []).length;
  if (n === 0) fail(`README 中找不到标记对 ${openTag}…${closeTag}（README 目录章节应有它）`);
  return { out: content.replace(re, full), count: n };
}

const testCount = countTests();
let readme = fs.readFileSync(README, "utf8");
const before = readme;

const tests = inject(readme, "<!-- AUTO:TESTS -->", "<!-- /AUTO:TESTS -->", testCount);
readme = tests.out;

if (readme === before) {
  console.log(`docs-sync: 已是最新（用例 ${testCount} 项，注入 ${tests.count} 处），无需修改`);
} else {
  fs.writeFileSync(README, readme);
  console.log(`docs-sync: ✓ 用例总数 ${testCount} 已注入 README（${tests.count} 处）`);
}
