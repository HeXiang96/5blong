#!/usr/bin/env node
// check-docs.mjs — 文档一致性校验（挂进 npm run check，发版 SOP 的关卡之一）。
//
// 校验项：
//   1. AUTO-LOG 成对标记：README 的 START/END 数量相等且至少一对（防双区块复发）
//   2. AUTO:TESTS：标记配对、各处数字一致、且 == 实际收集的用例数（防手写腐化）
//   3. 本地链接：README.md 与 docs/（archive 外）引用的相对路径文件必须存在
//   4. 归档残留：archive/ 与 docs/README.md 索引之外不得再引用已归档文件名
//
// 用法：npm run docs:check   （数字过期时先 npm run docs:sync）

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const errors = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const err = (m) => {
  errors.push(m);
  console.error(`  ✗ ${m}`);
};

// ── 1. AUTO-LOG 配对 ───────────────────────────────────────────────────
{
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const s = (readme.match(/<!-- AUTO-LOG:START -->/g) || []).length;
  const e = (readme.match(/<!-- AUTO-LOG:END -->/g) || []).length;
  if (s !== e) err(`AUTO-LOG 标记不配对：START ${s} 个 / END ${e} 个`);
  else if (s === 0) err("AUTO-LOG 区块缺失（README 应有且仅有一对）");
  else if (s > 1) err(`AUTO-LOG 区块重复：${s} 对（应只有 1 对）`);
  else ok(`AUTO-LOG 配对正常（1 对）`);
}

// ── 2. AUTO:TESTS 数字一致且未过期 ─────────────────────────────────────
{
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const nums = [...readme.matchAll(/<!-- AUTO:TESTS -->([\s\S]*?)<!-- \/AUTO:TESTS -->/g)].map(
    (m) => m[1].trim(),
  );
  if (nums.length === 0) err("AUTO:TESTS 标记缺失（README 目录/自检章节应有）");
  else {
    const uniq = [...new Set(nums)];
    if (uniq.length > 1) err(`AUTO:TESTS 数字不一致：${uniq.join(" vs ")}`);
    else {
      let actual = null;
      try {
        const out = execFileSync(
          process.execPath,
          [path.join(ROOT, "node_modules/vitest/vitest.mjs"), "list"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        actual = out.split("\n").filter((l) => l.includes(" > ")).length;
      } catch {
        err("无法收集用例（vitest list 失败）");
      }
      if (actual != null) {
        if (uniq[0] === String(actual)) ok(`AUTO:TESTS = ${actual}（${nums.length} 处，与实际一致）`);
        else err(`AUTO:TESTS 过期：文档写 ${uniq[0]}，实际 ${actual} → 跑 npm run docs:sync`);
      }
    }
  }
}

// ── 3. 本地链接存在性（README + docs/，archive 只读不查）──────────────
{
  const files = [path.join(ROOT, "README.md")];
  for (const f of fs.readdirSync(path.join(ROOT, "docs"))) {
    const p = path.join(ROOT, "docs", f);
    if (f.endsWith(".md") && fs.statSync(p).isFile()) files.push(p);
  }
  let checked = 0;
  for (const file of files) {
    const dir = path.dirname(file);
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^(https?:|mailto:|#|data:)/.test(href)) continue;
      const target = path.resolve(dir, decodeURIComponent(href.split("#")[0]));
      if (!fs.existsSync(target)) {
        err(`${path.relative(ROOT, file)} 引用的 \`${href}\` 不存在`);
      }
      checked++;
    }
  }
  if (checked > 0) ok(`本地链接 ${checked} 处均可解析`);
}

// ── 4. 归档文件名不得在 archive/ 与 docs/README.md 之外被引用 ──────────
{
  const archived = fs
    .readdirSync(path.join(ROOT, "docs/archive"))
    .filter((f) => f.endsWith(".md"));
  const allow = new Set(["docs/README.md", "docs/archive"]);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist-web" || entry.name === "target") continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(md|ts|tsx|mjs|yml|html)$/.test(entry.name)) {
        const rel = path.relative(ROOT, p).replace(/\\/g, "/");
        if ([...allow].some((a) => rel.startsWith(a))) continue;
        const text = fs.readFileSync(p, "utf8");
        for (const name of archived) {
          // 指向 docs/archive/ 的链接（含 ./ 前缀）整体是合法的，先剔除再查残留
          const residual = text
            .replace(/\[[^\]]*\]\((?:\.\/)?docs\/archive\/[^)]*\)/g, "")
            .replace(/(?:\.\/)?docs\/archive\/[^\s)]*/g, "");
          if (residual.includes(name)) offenders.push(`${rel} → ${name}`);
        }
      }
    }
  };
  walk(ROOT);
  if (offenders.length) err(`归档残留引用：\n      ${offenders.join("\n      ")}`);
  else ok(`已归档文件（${archived.length} 份）无残留引用`);
}

console.log(
  errors.length ? `\ncheck-docs: ✗ ${errors.length} 项不通过` : "\ncheck-docs: ✓ 全部通过",
);
process.exit(errors.length ? 1 : 0);
