#!/usr/bin/env node
/**
 * 网页版同步（2026-11-03）
 * ---------------------------------------------------------------------------
 * 干什么：把 CI 打进 Release 的 `dist-web.tar.gz` 拉到本机，覆盖静态站
 * `/var/www/5blong`，让 5blong.site 跟上这次发版。
 *
 * 为什么是"服务器拉"而不是"CI 推"：
 * 推就得把服务器 SSH 私钥放进 GitHub Secrets，一旦仓库或 Runner 出问题，
 * 代价是整台机器。让服务器主动来拉，CI 侧不需要任何凭据。
 *
 * 三条必须守住的底线：
 *
 * 1. **绝不删 desktop/**。静态站根目录里还有桌面端更新源（exe + latest.json），
 *    它们不在网页包里。rsync 必须带 `--exclude=desktop/`，否则一次同步就把
 *    所有人的自动更新打断。
 * 2. **先覆盖、再清理**，中间隔几秒。反过来做的话，旧 assets 被删、新 index.html
 *    还没落地，正好在加载的页面会白屏。assets 带内容哈希，新旧共存无害。
 * 3. **包是从公网下的，先验再用**：条目里不许有绝对路径或 `..`（防路径穿越），
 *    必须有 index.html 和非空 assets/。
 *
 * 用法：
 *   node sync-web.mjs                     # 正常同步
 *   node sync-web.mjs --dry-run           # 只检查，不动文件
 *   node sync-web.mjs --archive a.tar.gz  # 用本地包（测试用）
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";

const DEST = process.env.WEB_DIR || "/var/www/5blong";
const STATE = process.env.WEB_STATE || "/data/5blong/web-sha";
const OWNER = process.env.WEB_OWNER || "www-data:www-data";
const REPO = "HeXiang96/5blong";
const FALLBACK_URL = `https://github.com/${REPO}/releases/latest/download/dist-web.tar.gz`;

/**
 * 解析要下载的地址。
 *
 * **为什么不用 `releases/latest/download/...`**：那个地址有 CDN 缓存，刚发完版
 * 那几分钟还指着上一版——上一版根本没有 dist-web.tar.gz（1.9.12 及更早没有），
 * 于是每次发版后的头几轮都白跑一次。用 API 问出确切 tag，直链不带那层缓存。
 */
async function resolveArchiveUrl() {
  if (process.env.WEB_ARCHIVE_URL) return process.env.WEB_ARCHIVE_URL;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/vnd.github+json", "cache-control": "no-cache" },
    });
    if (res.ok) {
      const json = await res.json();
      if (typeof json.tag_name === "string" && json.tag_name) {
        return `https://github.com/${REPO}/releases/download/${json.tag_name}/dist-web.tar.gz`;
      }
    } else {
      log("warn", `问最新版本失败：HTTP ${res.status}`);
    }
  } catch (e) {
    log("warn", `问最新版本失败：${e.message}`);
  }
  return FALLBACK_URL;
}

const DRY = process.argv.includes("--dry-run");
const archiveArg = (() => {
  const i = process.argv.indexOf("--archive");
  return i > 0 ? process.argv[i + 1] : "";
})();

const log = (step, message) => process.stdout.write(`[sync-web] ${step.padEnd(9)} ${message}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function grab(dest) {
  if (archiveArg) {
    copyFileSync(archiveArg, dest);
    log("source", `本地包 ${archiveArg}`);
    return true;
  }
  const url = await resolveArchiveUrl();
  log("source", url.replace("https://github.com/HeXiang96/5blong/releases/download/", ""));
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(180_000),
    headers: { "cache-control": "no-cache" },
  });
  if (res.status === 404 || res.status === 410) {
    // 1.9.12 及更早的 Release 上没有这个资产。**这不算故障**——
    // 报错会让定时器每 5 分钟亮一次红灯，真正的故障反而被淹掉。
    log("skip", "该 Release 上还没有 dist-web.tar.gz（1.9.12 及更早没有），下次再看");
    return false;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  log("source", `github ${(statSync(dest).size / 1024).toFixed(0)} KB`);
  return true;
}

/** GNU tar 在 Windows 上会把 `C:\...` 当成远程主机（host:path），加 --force-local 才认本地路径。 */
const TAR_LOCAL = process.platform === "win32" ? ["--force-local"] : [];

/** 包内容校验：不许有逃逸路径，必须有入口和资源目录。 */
function inspect(archive) {
  const list = execFileSync("tar", [...TAR_LOCAL, "-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const entry of list) {
    const clean = entry.replace(/^\.\//, "");
    if (clean.startsWith("/") || clean.split("/").includes("..")) {
      throw new Error(`包里出现可疑路径：${entry}`);
    }
  }
  if (!list.some((e) => /^\.?\/?index\.html$/.test(e))) {
    throw new Error("包里没有 index.html，不像网页产物");
  }
  log("inspect", `${list.length} 个条目，路径与入口都正常`);
}

async function main() {
  // 下载落在系统临时目录：不污染静态站目录，dry-run 也不留垃圾。
  const tmp = path.join(os.tmpdir(), `5blong-dist-web-${process.pid}.tar.gz`);
  const next = DEST + ".next";

  if (!(await grab(tmp))) return;
  const sha = sha256File(tmp);
  log("sha256", sha.slice(0, 16) + "…");

  const prev = existsSync(STATE) ? readFileSync(STATE, "utf8").trim() : "";
  if (!DRY && prev === sha) {
    log("skip", "内容与上次部署完全一致，什么都不做");
    rmSync(tmp, { force: true });
    return;
  }

  inspect(tmp);

  if (DRY) {
    log("dry-run", `会把 ${tmp} 解到 ${next}，再同步进 ${DEST}（保留 desktop/）`);
    return;
  }

  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  execFileSync("tar", [...TAR_LOCAL, "-xzf", tmp, "-C", next, "--no-same-owner"]);
  if (!existsSync(path.join(next, "index.html"))) throw new Error("解压后没有 index.html");
  const assets = path.join(next, "assets");
  if (!existsSync(assets) || readdirSync(assets).length === 0) throw new Error("解压后 assets/ 是空的");
  log("unpack", `已解到 ${next}`);

  // 第一步：只覆盖新增，不删。index.html 是原子替换，旧 assets 先留着。
  // ⚠️ 必须同时排除 app/ 与 desktop/：
  //   desktop/ = 桌面端更新源；app/ = web.5blong.site 的应用目录。
  //   2026-11-03 真踩过：只排除了 desktop/，第一次跑同步就把 app/ 整个删了，
  //   两个域名一起挂。这次是补上第二道 exclude。
  execFileSync("rsync", ["-a", "--exclude=desktop/", "--exclude=app/", `${next}/`, `${DEST}/`]);
  log("copy", `已覆盖 ${DEST}（desktop/ 与 app/ 未动）`);

  // 第二步：等几秒让正在加载的页面把旧 assets 取完，再清理孤儿文件。
  await sleep(5000);
  execFileSync("rsync", ["-a", "--delete", "--exclude=desktop/", "--exclude=app/", `${next}/`, `${DEST}/`]);
  execFileSync("chown", ["-R", OWNER, DEST]);
  log("prune", "旧资源已清理，属主已修正");

  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, `${sha}\n`);
  rmSync(tmp, { force: true });
  rmSync(next, { recursive: true, force: true });
  log("done", `网页版已更新（${sha.slice(0, 12)}…）`);
}

main().catch((e) => {
  process.stderr.write(`[sync-web] 失败：${e.message}\n`);
  process.exit(1);
});
