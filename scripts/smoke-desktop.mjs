/**
 * 桌面端启动烟测：真正启动打包好的 exe，确认窗口能渲染出界面，然后自动退出。
 *
 * 用法：node scripts/smoke-desktop.mjs
 *
 * 会做两件容易被忽略的事：
 *  1. 清掉 ELECTRON_RUN_AS_NODE —— 有它在，Electron 会退化成纯 node，表现是双击无反应；
 *  2. 应用侧以 VOX_SMOKE=1 启动，渲染完成后把结果写成 JSON 并退出，便于 CI 判定。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe = path.join(root, "dist-desktop", "5blong-win-x64", "5blong.exe");
const out = path.join(root, "dist-desktop", "smoke-result.txt");

if (!existsSync(exe)) {
  console.error(`找不到 ${exe}，请先运行 node scripts/package-desktop.mjs`);
  process.exit(1);
}

rmSync(out, { force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.VOX_SMOKE = "1";
env.VOX_SMOKE_OUT = out;

const result = spawnSync(exe, [], { env, encoding: "utf8", timeout: 90_000 });
const log = existsSync(out) ? readFileSync(out, "utf8").trim() : "";

if (log) console.log(log);

const ok = /SMOKE_RESULT ok/.test(log) && result.status === 0;
if (!ok) {
  console.error("启动烟测失败");
  if (result.error) console.error(`  spawn 错误：${result.error.message}`);
  if (result.stderr) console.error(result.stderr.split("\n").filter(Boolean).slice(-10).join("\n"));
  if (!log) console.error("  应用没有写出结果文件，说明主进程没能启动");
  process.exit(1);
}

console.log("桌面端启动烟测通过");
