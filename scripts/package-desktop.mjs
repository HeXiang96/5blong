/**
 * 零依赖 Windows 桌面端打包器。
 *
 * 环境里没有 npm / npx / electron-builder，所以这里只做 Electron 原生认的两件事：
 *  1. 把网页产物与应用代码复制成 resources/app（目录形式的应用）；
 *  2. 复制官方 Electron 运行时作为外壳。
 * 结果是一个免安装的便携目录。
 *
 * 用法：node scripts/package-desktop.mjs
 * 校验：node scripts/verify-desktop.mjs
 */

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "dist-desktop");
const appDir = path.join(outDir, "5blong-win-x64");
const electronDist = path.join(root, "node_modules", "electron", "dist");

const APP_NAME = "5blong";
const APP_FILES = ["dist-web", path.join("electron", "main.cjs"), path.join("electron", "assets")];

function log(step, message) {
  process.stdout.write(`[package] ${step.padEnd(12)} ${message}\n`);
}

async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, base)));
    else if (entry.isFile()) files.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return files;
}
async function main() {
  // 注意：electronDist 已是绝对路径，不能再和 root 拼一次。
  for (const required of [path.join(root, "dist-web"), electronDist]) {
    if (!existsSync(required)) {
      throw new Error(`缺少 ${required}，请先构建（vite build --base ./ --outDir dist-web）`);
    }
  }  if (!existsSync(path.join(root, "dist-web", "index.html"))) {
    throw new Error("dist-web/index.html 不存在，网页产物不完整");
  }

  /*
   * 清理旧目录。
   * Windows 上如果上一次打包出来的 exe 还开着（例如刚跑过烟测没退干净），
   * rmdir 会抛 EBUSY，然后整个打包半途而废——而且**已经删掉一半**，
   * 留下一个没有 resources/ 的残缺目录，看起来像"打包成功但应用打不开"。
   * 所以这里重试几次，并在仍然失败时给出可执行的建议。
   */
  log("clean", "清理旧的打包目录");
  let cleaned = false;
  for (let attempt = 0; attempt < 5 && !cleaned; attempt += 1) {
    try {
      await rm(outDir, { recursive: true, force: true });
      cleaned = true;
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      if (attempt === 0) {
        log("clean", "目录被占用（多半是上次的 5blong.exe 还在跑），等待释放…");
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  if (!cleaned) {
    throw new Error(
      `打包目录被占用，无法清理：${outDir}\n` +
        "请先关掉正在运行的 5blong.exe，或执行：\n" +
        "  Get-Process 5blong -ErrorAction SilentlyContinue | Stop-Process -Force",
    );
  }
  await mkdir(outDir, { recursive: true });

  log("collect", "收集应用文件");
  const files = [];
  for (const entry of APP_FILES) {
    const full = path.join(root, entry);
    if (!existsSync(full)) continue;
    const info = await stat(full);
    // 目录要走相对 root 的路径，这样 asar 内的层级才是 dist-web/... 而不是 assets/...
    if (info.isDirectory()) files.push(...(await walk(full, root)));
    else files.push(path.relative(root, full).split(path.sep).join("/"));
  }

  const appManifest = await readFile(path.join(root, "package.json"), "utf8");
  const manifest = JSON.parse(appManifest);
  const appPackage = {
    name: "5blong",
    productName: APP_NAME,
    version: manifest.version ?? "1.0.0",
    private: true,
    type: "commonjs",
    main: "electron/main.cjs",
    description: manifest.description ?? "5blong 语音房桌面端",
  };

  log("shell", "复制 Electron 运行时");
  await cp(electronDist, appDir, { recursive: true });

  /**
   * 应用以目录形式放进 resources/app。
   *
   * 为什么不用 resources/app.asar：Windows 版 Electron 启用了 asar 头部完整性校验 fuse，
   * 自制的 asar 没有签名会让它 LOG(FATAL) 直接退出（表现为双击无反应）。
   * Electron 的解析顺序是 app.asar → app → default_app.asar，目录形式同样受支持，
   * 而且不经过完整性门。本应用只有十几个文件，目录读取的启动开销可以忽略。
   */
  const resources = path.join(appDir, "resources");
  const appRoot = path.join(resources, "app");
  await mkdir(appRoot, { recursive: true });

  for (const relative of files) {
    const target = path.join(appRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, relative), target, { recursive: true });
  }
  await writeFile(path.join(appRoot, "package.json"), `${JSON.stringify(appPackage, null, 2)}\n`);

  const staged = await walk(appRoot);
  const stagedBytes = await dirSize(appRoot);
  log("app", `写入 ${staged.length} 个文件，${(stagedBytes / 1024).toFixed(0)} KB → resources/app`);

  // 保留内置默认应用会让「找不到应用」时静默回退，反而掩盖问题；直接删掉。
  await rm(path.join(resources, "default_app.asar"), { force: true });

  const exeSource = path.join(appDir, "electron.exe");
  const exeTarget = path.join(appDir, `${APP_NAME}.exe`);
  if (existsSync(exeSource)) {
    await rename(exeSource, exeTarget);
    log("rename", `${APP_NAME}.exe`);
  }

  /*
   * 把自定义图标嵌进 exe 的文件资源里。
   * 只改名是不够的：资源管理器/桌面上显示的仍是 Electron 默认图标
   *（窗口和任务栏图标走 BrowserWindow({ icon })，那个本来就生效）。
   * 嵌入失败不阻断打包，只是没有自定义文件图标——会把原因打出来。
   */
  const icoPath = path.join(root, "electron", "assets", "icon.ico");
  if (existsSync(exeTarget) && existsSync(icoPath)) {
    const embed = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "embed-exe-icon.mjs"), exeTarget, icoPath],
      { encoding: "utf8" },
    );
    if (embed.status === 0) {
      const lastLines = (embed.stdout ?? "").trim().split(/\r?\n/).slice(-2).join(" / ");
      log("icon", `已嵌入自定义图标（${lastLines}）`);
    } else {
      log("icon", `嵌入失败，保留默认图标（${(embed.stderr ?? "").split("\n")[0] || "未知原因"}）`);
    }
  }

  const readme = [
    `${APP_NAME} 桌面端（免安装便携版）`,
    "",
    "双击 5blong.exe 启动。首次运行会自动生成身份并保存在本机。",
    "",
    "· 关窗口 = 最小化到系统托盘，语音继续；右键托盘图标可显示窗口或退出。",
    "· 再次双击 exe 不会开新进程，而是聚焦已有窗口。",
    "· 网页端地址：https://5blong.pages.dev",
    "",
    "· 图标说明：窗口/任务栏/托盘图标，以及 exe 文件的图标，都已换成自定义图标。",
    "",
    "上游 Piik（MIT）版权声明见应用内及 dist-web/third-party-licenses.txt。",
    "",
  ].join("\r\n");
  await writeFile(path.join(appDir, "使用说明.txt"), readme, "utf8");

  const total = await dirSize(appDir);
  log("done", `${appDir}（${(total / 1024 / 1024).toFixed(1)} MB）`);
  process.stdout.write(`${appDir}\n`);
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

await main();
