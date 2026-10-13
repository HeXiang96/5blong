#!/usr/bin/env node
// 把桌面端更新产物发布到 Cloudflare Pages（与网页版同域：https://5blong.pages.dev）。
//
// 背景：更新源原来只有 GitHub Releases，国内没代理的用户基本连不上。
// Tauri 安装包只有 ~2.5 MB，远低于 Pages 单文件 25 MiB 上限，
// 所以 latest.json + 安装包直接挂在 Pages 的 /desktop/ 路径下，GitHub 降级为备源。
//
// 用法：npm run publish:desktop -- <x.y.z>        （先在 CI 发好对应 Release）
//       npm run publish:desktop -- <x.y.z> --no-build   （复用现有 dist-web）
//
// 做四件事：
//   1. 构建网页产物 dist-web（已存在且传了 --no-build 则跳过）；
//   2. 从 GitHub Release 下载 5blong_<v>_x64-setup.exe / .sig / latest.json
//      （直连失败自动改走本机 FlClash 代理 127.0.0.1:7890）；
//   3. 改写 latest.json 里各平台的下载地址 → Pages 域名
//      （minisign 签名校验的是安装包内容，与下载地址无关，改 URL 不影响验签）；
//   4. 组装 dist-deploy/（网页 + desktop/），复用 deploy-pages.mjs 一次部署上线。
//
// 注意：Pages 的部署是整站替换（manifest 定义全部文件），所以每次发布都会把
// 当时版本的网页和桌面端产物一起重新上线；旧版本安装包会从线上消失（更新器
// 只需要 latest.json 指向的当前版本，不受影响）。

import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const noBuild = process.argv.includes("--no-build");
const version = process.argv.slice(2).filter((a) => a !== "--no-build")[0];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("用法：npm run publish:desktop -- <x.y.z>   例如 npm run publish:desktop -- 1.0.2");
  process.exit(1);
}

const project = "5blong";
const branch = "main";
const pagesBase = "https://5blong.pages.dev";
const releaseBase = `https://github.com/HeXiang96/5blong/releases/download/app-v${version}`;
const exeName = `5blong_${version}_x64-setup.exe`;
const sigName = `${exeName}.sig`;
const PROXY = "http://127.0.0.1:7890";

const distWeb = path.join(root, "dist-web");
const distDeploy = path.join(root, "dist-deploy");
const desktopDir = path.join(distDeploy, "desktop");

function log(step, message) {
  process.stdout.write(`[desktop] ${step.padEnd(10)} ${message}\n`);
}

// ---------------------------------------------------------------- 下载

/** curl 下载：先直连，失败自动走本机代理。返回 "direct" 或 "proxy"。 */
function fetchTo(url, dest) {
  const attempts = [
    { label: "direct", extra: [] },
    { label: "proxy", extra: ["-x", PROXY] },
  ];
  for (const { label, extra } of attempts) {
    try {
      execFileSync(
        "curl",
        ["-fsSL", "--max-time", "300", "--retry", "1", ...extra, "-o", dest, url],
        { stdio: "pipe" },
      );
      if (existsSync(dest) && statSync(dest).size > 0) {
        log("download", `${path.basename(dest)} ← ${label}`);
        return label;
      }
    } catch {
      // 换下一条通道
    }
  }
  throw new Error(
    `下载失败（直连和代理都不通）：${url}\n` +
      "GitHub 直连被墙且本机 FlClash（127.0.0.1:7890）未在线——请打开 FlClash 后重试。",
  );
}

// ---------------------------------------------------------------- 主流程

async function main() {
  // 1. 网页产物
  if (!noBuild) {
    log("build", "构建网页产物 dist-web …");
    execSync("npm run build:web:pages", { cwd: root, stdio: "inherit" });
  }
  if (!existsSync(path.join(distWeb, "index.html"))) {
    throw new Error(`${distWeb} 缺少 index.html——先跑 npm run build:web:pages`);
  }

  // 2. 从 GitHub Release 下载桌面端产物
  mkdirSync(desktopDir, { recursive: true });
  const latestJsonPath = path.join(desktopDir, "latest.json");
  fetchTo(`${releaseBase}/${exeName}`, path.join(desktopDir, exeName));
  fetchTo(`${releaseBase}/${sigName}`, path.join(desktopDir, sigName));
  fetchTo(`${releaseBase}/latest.json`, latestJsonPath);

  // 3. 改写 latest.json：下载地址换成 Pages，签名原样保留
  const manifest = JSON.parse(readFileSync(latestJsonPath, "utf8"));
  if (manifest.version !== version) {
    throw new Error(`latest.json 版本（${manifest.version}）与参数（${version}）不一致，检查 Release 是否发对`);
  }
  const pagesUrl = `${pagesBase}/desktop/${exeName}`;
  for (const platform of Object.values(manifest.platforms ?? {})) {
    if (platform.url) platform.url = pagesUrl;
  }
  if (!Object.values(manifest.platforms ?? {}).some((p) => p.signature)) {
    throw new Error("latest.json 里没有签名信息，更新器会拒绝安装——检查 CI 产物");
  }
  writeFileSync(latestJsonPath, JSON.stringify(manifest, null, 2) + "\n");
  log("rewrite", `下载地址 → ${pagesUrl}`);

  // 4. 组装 dist-deploy/ 并复用现有部署脚本上线
  rmSync(distDeploy, { recursive: true, force: true });
  cpSync(distWeb, distDeploy, { recursive: true });
  log("stage", `dist-deploy/ = dist-web + desktop/${exeName}`);

  execSync(`node scripts/deploy-pages.mjs dist-deploy ${project} ${branch}`, {
    cwd: root,
    stdio: "inherit",
  });

  log("done", [
    `更新源     ${pagesBase}/desktop/latest.json`,
    `安装包直链 ${pagesUrl}`,
  ].join("\n                     "));
}

main().catch((error) => {
  console.error(`[desktop] 失败：${error.message}`);
  process.exit(1);
});
