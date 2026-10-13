#!/usr/bin/env node
// 自动把最近的提交记录写进 README 的「近期提交」小节。
//
// 由 .github/workflows/readme-log.yml 在每次 push main 后自动调用；
// 本地也可直接 `node scripts/readme-log.mjs` 预览效果。
//
// 防循环：只统计的提交里跳过带 [skip ci] 的自动提交，
// 且自动提交的信息本身带 [skip ci]，工作流也忽略 README.md 的单独变更。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = path.join(root, "README.md");
const START = "<!-- AUTO-LOG:START -->";
const END = "<!-- AUTO-LOG:END -->";
const HEADING = "### 近期提交（自动生成）";

// 取最近 12 条提交（一行一条：hash、时间、说明）
const log = execFileSync(
  "git",
  ["log", "--pretty=format:%h|%ad|%s", "--date=format:%m-%d %H:%M", "-12"],
  { cwd: root, encoding: "utf8" },
);

const lines = log
  .split("\n")
  .filter((line) => line.trim())
  .filter((line) => !/\[skip ci\]/.test(line))
  .map((line) => {
    const [hash, date, ...rest] = line.split("|");
    return `- \`${hash.slice(0, 7)}\` ${rest.join("|")}（${date}）`;
  });

const section = `${START}\n${HEADING}\n\n${lines.join("\n")}\n${END}`;
const readme = readFileSync(readmePath, "utf8");

if (readme.includes(START)) {
  const re = new RegExp(`${START.replace(/[/*]/g, "\\$&")}[\\s\\S]*?${END.replace(/[/*]/g, "\\$&")}`);
  const next = readme.replace(re, section);
  if (next === readme) {
    console.log("README 提交记录无变化");
    process.exit(0);
  }
  writeFileSync(readmePath, next);
  console.log("README 提交记录已更新");
} else {
  // 首次：插到「## 怎么用」之前；找不到就追加到文末
  const anchor = "\n## 怎么用";
  const idx = readme.indexOf(anchor);
  if (idx === -1) {
    writeFileSync(readmePath, `${readme}\n\n${section}\n`);
  } else {
    writeFileSync(readmePath, readme.slice(0, idx) + "\n" + section + "\n" + readme.slice(idx));
  }
  console.log("README 已插入「近期提交」小节");
}
