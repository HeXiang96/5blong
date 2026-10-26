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
    /*
     * 幂等：文件已经是目标版本就直接跳过（.toml 与 .lock 一视同仁）。
     * 原来只允许 .lock 走这条路——于是发版中断后重试时，已经被改过的
     * Cargo.toml 会被判成"找不到 version 行"而中止（v1.7.1 就卡在这）。
     */
    if (text.includes(`version = "${version}"`)) {
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
  /*
   * 不能写死 "{\s*version"：自动插入的条目在 version 前面带一行注释
   * （见下方 entry 的生成逻辑），写死就会匹配失败——v1.7.0 发完之后
   * v1.7.1 直接卡在"changelog.ts 结构异常"。改成在数组开头附近找第一个 version。
   */
  const tail = changelogSrc.slice(changelogSrc.indexOf("CHANGELOG: ChangelogEntry[] = ["));
  const head = tail.match(/version: "([^"]+)"/);
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

const pushOnce = (ref, force = false) => {
  try {
    run(`git push ${force ? "--force " : ""}origin ${ref}`);
    return true;
  } catch {
    console.error(`⚠ 推送 ${ref} 报错（网络/代理/被拒？），稍后统一核对远端状态`);
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

/*
 * 顺序很重要：**先 main、确认落地，再推 tag**。
 *
 * 2026-10-26 踩过：main 推被拒（远端被 CI 的 README 提交推进了），但同一条命令里
 * 紧接着把 tag 推成功了 → CI 立刻按旧提交跑了一次 Release；等人工 rebase 后重指 tag
 * 再推，又触发第二次。同一个版本跑了两次构建，还会整站替换两次更新源。
 *
 * 现在：main 被拒就先 rebase 到远端、重指 tag（此时 tag 还没推，改它零成本），
 * 成功之后再推 tag —— 一次发版只触发一次 CI。
 */
const releaseTagName = `app-v${version}`;

const pointTagAtReleaseCommit = () => {
  const releaseSha = gitOut(`git log --format=%H --grep="release: v${version}" -1`);
  if (!releaseSha) throw new Error(`找不到 v${version} 的发版提交，无法重指标签`);
  run(`git tag -f ${releaseTagName} ${releaseSha}`);
  return releaseSha;
};

/** main 推送被拒时（远端被 CI 自动提交推进），rebase 后重来。最多两轮。 */
const pushMainWithRebase = () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const head = gitOut("git rev-parse HEAD");
    if (pushOnce("main")) {
      const state = remoteState("main", head);
      if (state !== "no") return head;
    }
    if (attempt === 2) break;
    console.log("… main 未落地（多半是远端被 CI 的 README 提交推进了），自动 rebase 后重试");
    run("git fetch origin main");
    run("git rebase origin/main");
    // rebase 改写了提交哈希：标签必须重新指向新的发版提交
    pointTagAtReleaseCommit();
  }
  return null;
};

const pushedHead = pushMainWithRebase();

if (!pushedHead) {
  console.error("\n✗ 发版不完整：main 分支没能推上去（标签**没有**推送，CI 未被触发）。");
  console.error("   ① 确认代理在线后手动：git fetch origin main && git rebase origin/main");
  console.error("   ② git tag -f " + releaseTagName + " $(git log --format=%H --grep=\"release: v" + version + "\" -1)");
  console.error("   ③ git push origin main && git push origin " + releaseTagName);
  process.exit(1);
}
console.log(`✓ main 分支 远端确认（${pushedHead.slice(0, 7)}）`);

// main 已落地，现在才推标签（一次发版一次 CI）
const tagSha = gitOut(`git rev-parse refs/tags/${releaseTagName}`);
const tagAlreadyRemote = remoteState(releaseTagName, tagSha);
if (tagAlreadyRemote === "exact") {
  console.log(`✓ 标签 ${releaseTagName} 已在远端一致（${tagSha.slice(0, 7)}）`);
} else {
  // 同一个标签先前推过一次（内容被 rebase 改写了才会走到这里）：只能强制更新，
  // 这会再触发一次 CI，所以必须显式说清楚。
  const force = tagAlreadyRemote !== "no";
  if (force) console.log(`⚠ 标签 ${releaseTagName} 远端已存在但指向旧提交，强制更新（会再触发一次 CI）`);
  if (!pushOnce(releaseTagName, force)) pushOnce(releaseTagName, force);
  const state = remoteState(releaseTagName, tagSha);
  if (state === "no") {
    console.error(`\n✗ 标签 ${releaseTagName} 未能推送到远端（本地 ${tagSha.slice(0, 7)}）`);
    process.exit(1);
  }
  console.log(`✓ 标签 ${releaseTagName} 远端确认 ${state === "exact" ? "一致" : "已包含"}（${tagSha.slice(0, 7)}）`);
}
console.log("");
console.log(`\n已推送 app-v${version}，GitHub Actions 开始出包：`);
console.log(`https://github.com/${repo()}/actions`);
console.log(`\n出包成功后 CI 会自动把更新源发布到 Pages（需在仓库 Secrets 配置 CLOUDFLARE_API_TOKEN）。`);
console.log(`若未配置 Secret，在本机（需代理在线）手动发布：`);
console.log(`npm run publish:desktop -- ${version}`);
