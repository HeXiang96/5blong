/**
 * 校验打包出来的桌面端目录：外壳文件齐全、应用文件与源文件逐字节一致、清单入口正确。
 * 用法：node scripts/verify-desktop.mjs
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appDir = path.join(root, "dist-desktop", "5blong-win-x64");
const appRoot = path.join(appDir, "resources", "app");

if (!existsSync(appRoot)) {
  console.error(`找不到 ${appRoot}，请先运行 node scripts/package-desktop.mjs`);
  process.exit(1);
}

/** 外壳必须存在的文件；缺任何一个都会导致启动失败。 */
const SHELL_REQUIRED = [
  "5blong.exe",
  "icudtl.dat",
  "resources.pak",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "ffmpeg.dll",
  "locales",
];

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const problems = [];

for (const required of SHELL_REQUIRED) {
  if (!existsSync(path.join(appDir, required))) problems.push(`外壳缺少 ${required}`);
}

// default_app.asar 留着会让"找不到应用"时静默回退，掩盖真正的问题。
if (existsSync(path.join(appDir, "resources", "default_app.asar"))) {
  problems.push("resources/default_app.asar 未清理，会在应用缺失时静默回退");
}
if (existsSync(path.join(appDir, "resources", "app.asar"))) {
  problems.push("resources/app.asar 与 resources/app 同时存在，asar 会优先生效");
}

const manifestPath = path.join(appRoot, "package.json");
let manifest = null;
if (!existsSync(manifestPath)) {
  problems.push("应用清单 package.json 缺失");
} else {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.main !== "electron/main.cjs") {
    problems.push(`清单 main 入口不对：${manifest.main}`);
  }
  if (!existsSync(path.join(appRoot, manifest.main))) {
    problems.push(`清单指向的入口文件不存在：${manifest.main}`);
  }
}

// package.json 是打包时生成的，其余文件必须与仓库源文件逐字节一致。
const files = walk(appRoot);
const mismatched = [];
for (const relative of files) {
  if (relative === "package.json") continue;
  const source = path.join(root, relative);
  if (!existsSync(source)) {
    mismatched.push(`${relative}（源文件不存在）`);
    continue;
  }
  const a = readFileSync(path.join(appRoot, relative));
  const b = readFileSync(source);
  const same =
    a.length === b.length &&
    createHash("sha256").update(a).digest("hex") === createHash("sha256").update(b).digest("hex");
  if (!same) mismatched.push(relative);
}
for (const item of mismatched) problems.push(`与源文件不一致：${item}`);

const indexHtml = path.join(appRoot, "dist-web", "index.html");
if (existsSync(indexHtml)) {
  const html = readFileSync(indexHtml, "utf8");
  for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
    if (!existsSync(path.join(appRoot, "dist-web", match[1]))) {
      problems.push(`index.html 引用了不存在的产物：${match[1]}`);
    }
  }
} else {
  problems.push("dist-web/index.html 缺失");
}

const shellSize = existsSync(path.join(appDir, "5blong.exe"))
  ? statSync(path.join(appDir, "5blong.exe")).size
  : 0;

console.log(`外壳: 5blong.exe ${(shellSize / 1024 / 1024).toFixed(0)} MB，必备文件 ${SHELL_REQUIRED.length} 项`);
console.log(`应用: ${files.length} 个文件 → resources/app`);
console.log(`清单: ${JSON.stringify(manifest)}`);

if (problems.length > 0) {
  console.error("发现问题：");
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log("桌面端目录校验通过");
console.log("提示：启动验证请在普通 Windows 会话里运行 node scripts/smoke-desktop.mjs");
