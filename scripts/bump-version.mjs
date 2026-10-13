#!/usr/bin/env node
// 升级版本号并发版：npm run bump -- 1.0.1
//
// 做四件事：
//   1. 把 package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml /
//      src-tauri/Cargo.lock 的版本号统一改成目标版本（桌面端版本号以这几处为准）；
//   2. git commit（消息：release: vX.Y.Z）；
//   3. 打标签 app-vX.Y.Z；
//   4. 推送 main 和标签 → GitHub Actions 自动出安装包并发布 Release，
//      已安装的桌面端会在下次启动或点托盘「检查更新」时收到更新。
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

run("git add -A");
run(`git commit -m "release: v${version}"`);
run(`git tag app-v${version}`);
run("git push origin main");
run(`git push origin app-v${version}`);
console.log(`\n已推送 app-v${version}，GitHub Actions 开始出包：`);
console.log(`https://github.com/${repo()}/actions`);
console.log(`\n出包成功后 CI 会自动把更新源发布到 Pages（需在仓库 Secrets 配置 CLOUDFLARE_API_TOKEN）。`);
console.log(`若未配置 Secret，在本机（需代理在线）手动发布：`);
console.log(`npm run publish:desktop -- ${version}`);
