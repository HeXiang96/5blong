#!/usr/bin/env node
// 升级版本号并发版：npm run bump -- 1.0.1
//
// 做四件事：
//   1. 把 package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml /
//      src-tauri/Cargo.lock 的版本号统一改成目标版本（桌面端版本号以这几处为准）；
//   2. git commit（消息：release: vX.Y.Z）；
//   3. 打标签 app-vX.Y.Z；
//   4. 推送 main 和标签 → GitHub Actions 自动出安装包并发布 Release，
//      已安装的桌面端会在下次启动或点托盘「检查更新」时收到更新；
//   5. **推送后 ls-remote 双确认**：两条引用都必须在远端落地，否则自动补推一次、
//      仍失败则报错退出（防止"标签推了、main 漏推"导致 GitHub 源码停在旧版）。
//
// CI 出包完成后（约 10 分钟），再跑一步把更新源发布到国内可直连的 Pages：
//   npm run publish:desktop -- X.Y.Z
//
// 注意：推送到 GitHub 需要本机 FlClash 代理在线（仓库已配置 git 走 127.0.0.1:7890）。
// 签名私钥在本机 %USERPROFILE%\.tauri\5blong.key，对应公钥已写进 tauri.conf.json，
// CI 用仓库 Secrets 里的同名私钥签名更新包。

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("用法：npm run bump -- <x.y.z>   例如 npm run bump -- 1.0.1");
  process.exit(1);
}

const run = (cmd, opts = {}) =>
  execSync(cmd, { cwd: root, stdio: "inherit", ...opts });

const repo = () => {
  const url = execSync("git remote get-url origin", { cwd: root, encoding: "utf8" }).trim();
  // git@github.com:Owner/Repo.git 或 https://github.com/Owner/Repo.git
  return url.replace(/^(git@github\.com:|https:\/\/github\.com\/)/, "").replace(/\.git$/, "");
};

// package.json / tauri.conf.json：直接 JSON 读写，保持字段顺序由 JSON.stringify 输出。
for (const rel of ["package.json", "src-tauri/tauri.conf.json"]) {
  const file = path.join(root, rel);
  const json = JSON.parse(readFileSync(file, "utf8"));
  if (json.version === version) {
    console.log(`${rel} 已是 ${version}`);
    continue;
  }
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  console.log(`${rel} → ${version}`);
}

// Cargo.toml / Cargo.lock：只替换 app 包自己的 version 行，不碰依赖。
for (const rel of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
  const file = path.join(root, rel);
  const text = readFileSync(file, "utf8");
  const next = text.replace(
    /(name = "app"\r?\nversion = ")[^"]+/,
    `$1${version}`,
  );
  if (next === text) {
    if (text.includes(`version = "${version}"`) && rel.endsWith(".lock")) {
      console.log(`${rel} 已是 ${version}`);
      continue;
    }
    console.error(`在 ${rel} 里找不到 app 包的 version 行，请手工检查`);
    process.exit(1);
  }
  writeFileSync(file, next);
  console.log(`${rel} → ${version}`);
}

/*
 * 公告栏 changelog 版本号自动同步（根治"公告栏版本号与客户端不同步"）：
 * 规则：CHANGELOG 首条必须是正在发布的版本——
 *   - 手动写过这个版本的条目（有内容）→ 保持不动；
 *   - 没有 → 自动插入空条目（公告栏回落到上一条有内容版本 = 纯修复版不上公告栏）。
 * 由此"忘记改 changelog"在流程上不可能发生。
 */
const changelogPath = path.join(root, "src/client/voice/changelog.ts");
try {
  const changelogSrc = readFileSync(changelogPath, "utf-8");
  const head = changelogSrc.match(/CHANGELOG: ChangelogEntry\[\] = \[\s*\{\s*version: "([^"]+)"/);
  if (!head) {
    console.error("changelog.ts 结构异常：找不到 CHANGELOG 首条，中止发版。");
    process.exit(1);
  }
  if (head[1] !== version) {
    const today = new Date().toISOString().slice(0, 10);
    const marker = "export const CHANGELOG: ChangelogEntry[] = [";
    const insertAt = changelogSrc.indexOf(marker) + marker.length;
    const entry = [
      "",
      "  {",
      "    // bump 自动插入（发版时保证首条 = 本次版本）；内容按需补充，留空 = 公告栏展示上一条有内容版本",
      `    version: "${version}",`,
      `    date: "${today}",`,
      "    lines: [],",
      "  },",
    ].join("\n");
    writeFileSync(changelogPath, changelogSrc.slice(0, insertAt) + entry + changelogSrc.slice(insertAt));
    console.log(`changelog.ts → 已自动插入 v${version} 条目（空内容 = 公告栏展示上一条有内容版本）`);
  } else {
    console.log(`changelog.ts 首条已是 v${version}（手动维护的内容保留）`);
  }
} catch (e) {
  console.error(`读取 changelog.ts 失败：${e}`);
  process.exit(1);
}

run("git add -A");
run(`git commit -m "release: v${version}"`);
run(`git tag app-v${version}`);

/*
 * 推送 + 远端双确认（2026-10-16 事故根因：标签推成功但 main 漏推，GitHub 源码停在旧版）：
 *   - 推送命令抛错（代理抖动）不立即中止，先核对远端是否其实已落地；
 *   - 核对用 ls-remote 对比 sha；若远端已被 CI 的 AUTO-LOG 自动提交推进，用祖先关系判定；
 *   - 任何一条未落地 → 自动补推一次 → 仍失败则明确报错并给出恢复步骤（exit 1）。
 */
const gitOut = (cmd) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
const localMain = gitOut("git rev-parse HEAD");
const localTag = gitOut(`git rev-parse refs/tags/app-v${version}`);

const pushOnce = (ref) => {
  try {
    run(`git push origin ${ref}`);
    return true;
  } catch {
    console.error(`⚠ 推送 ${ref} 报错（网络/代理？），稍后统一核对远端状态`);
    return false;
  }
};

/** 远端是否已包含该提交：exact = 恰好一致；contains = 已被 CI 自动提交推进；no = 未落地 */
const remoteState = (ref, want) => {
  try {
    const line = gitOut(`git ls-remote origin ${ref}`).split("\n")[0] ?? "";
    const got = line.split(/\s+/)[0] || "";
    if (got === want) return "exact";
    if (!got) return "no";
    execSync(`git fetch origin ${ref} --quiet`, { cwd: root, stdio: "ignore" });
    execSync(`git merge-base --is-ancestor ${want} FETCH_HEAD`, { cwd: root, stdio: "ignore" });
    return "contains";
  } catch {
    return "no";
  }
};

const targets = [
  { ref: "main", want: localMain, label: "main 分支" },
  { ref: `app-v${version}`, want: localTag, label: `标签 app-v${version}` },
];

for (const t of targets) pushOnce(t.ref);

const failed = [];
for (const t of targets) {
  let state = remoteState(t.ref, t.want);
  if (state === "no") {
    console.log(`✗ ${t.label} 远端未更新，自动补推…`);
    pushOnce(t.ref);
    state = remoteState(t.ref, t.want);
  }
  if (state === "no") failed.push(t);
  else console.log(`✓ ${t.label} 远端确认 ${state === "exact" ? "一致" : "已包含"}（${t.want.slice(0, 7)}）`);
}

if (failed.length) {
  console.error("\n✗ 发版不完整，以下引用未成功推送：");
  for (const t of failed) console.error(`   - ${t.label}（本地 ${t.want.slice(0, 7)}）`);
  console.error("\n请立即处理：① 确认代理在线；② git push origin main / git push origin app-vX 手动重试；");
  console.error("③ 仍不行按 README「发版 SOP」恢复：fetch → rebase（AUTO-LOG 冲突以 CI 版为准）→ 推 main → 补推标签。");
  process.exit(1);
}

console.log("");
console.log(`\n已推送 app-v${version}，GitHub Actions 开始出包：`);
console.log(`https://github.com/${repo()}/actions`);
console.log(`\n出包成功后 CI 会自动把更新源发布到 Pages（需在仓库 Secrets 配置 CLOUDFLARE_API_TOKEN）。`);
console.log(`若未配置 Secret，在本机（需代理在线）手动发布：`);
console.log(`npm run publish:desktop -- ${version}`);
