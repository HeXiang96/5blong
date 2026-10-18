#!/usr/bin/env node
// 自动把最近的提交记录写进 README 的「近期提交」小节。
//
// 由 .github/workflows/readme-log.yml 在每次 push main 后自动调用；
// 本地也可直接 `node scripts/readme-log.mjs` 预览效果。
//
// 防循环：只统计的提交里跳过带 [skip ci] 的自动提交，
// 且自动提交的信息本身带 [skip ci]，工作流也忽略 README.md 的单独变更。
//
// 2026-10-18 加固：README 里曾出现"孤儿块"（只有内容和 END、没有 START 的
// 半截区块，旧的替换正则永远匹配不到它，导致两份"近期提交"并存）。
// 现在先清理一切现存区块（完整对 / 孤儿 / 单只标记），再插入唯一的新区块，
// 写完断言标记恰好一对，畸形即报错退出。

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

const escapeRe = (s) => s.replace(/[/*]/g, "\\$&");

// ① 清掉所有完整的标记对（可能有多对）
let body = readme.replace(
  new RegExp(`${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}`, "g"),
  "",
);
// ② 清掉孤儿块：没有 START 包裹的「近期提交」小节（到下一个 --- / 二级标题 / 文末为止）
body = body.replace(
  /\n*### 近期提交（自动生成）\n[\s\S]*?(?=\n---|\n## |$)/g,
  "",
);
// ③ 清掉任何残留的单只标记行
body = body
  .split("\n")
  .filter((line) => line.trim() !== START && line.trim() !== END)
  .join("\n");
// ④ 收敛清理留下的多余空行
body = body.replace(/\n{3,}/g, "\n\n");

// 插入唯一的新区块：优先放在「## 怎么用」之前，找不到就追加到文末
const anchor = "\n## 怎么用";
const idx = body.indexOf(anchor);
const next =
  idx === -1
    ? `${body.trimEnd()}\n\n${section}\n`
    : body.slice(0, idx) + "\n" + section + "\n" + body.slice(idx);

// 断言：标记必须恰好各出现一次（畸形即失败，宁可不写）
const count = (s, marker) => s.split(marker).length - 1;
if (count(next, START) !== 1 || count(next, END) !== 1) {
  console.error("AUTO-LOG 标记数量异常，已放弃写入，请人工检查 README.md");
  process.exit(1);
}

if (next === readme) {
  console.log("README 提交记录无变化");
  process.exit(0);
}
writeFileSync(readmePath, next);
console.log("README 提交记录已更新");
