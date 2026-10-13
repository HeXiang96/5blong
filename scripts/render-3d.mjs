/**
 * 3D 模型渲染脚本（素材管线）。
 * 自己拉起 Edge headless（CDP 端口），puppeteer.connect 连上去，
 * 等 __renderReady 后截图。避开 puppeteer launch 在 Edge 上的兼容问题。
 *
 * 用法：node render-3d.mjs <yaw> <out.png> [pitch] [size] [clear|none]
 */
import puppeteer from "file:///C:/Users/hexia/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const [, , yawArg, outArg, pitchArg = 8, sizeArg = 720, clearArg = "f5e9d8"] = process.argv;
if (!yawArg || !outArg) {
  console.error("usage: node render-3d.mjs <yaw> <out.png> [pitch=8] [size=720] [clear=f5e9d8|none]");
  process.exit(1);
}
const out = path.resolve(outArg);
mkdirSync(path.dirname(out), { recursive: true });

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
if (!existsSync(EDGE)) throw new Error("找不到 Edge");
const PORT = 9337;
const PROFILE = "C:/Users/hexia/.workbuddy/pptr-edge-profile";

// 进程清理：退出时杀掉整个 Edge headless 实例
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-gl=angle",
    "--enable-unsafe-swiftshader",
    "--window-size=900,900",
    "about:blank",
  ],
  { stdio: "ignore", detached: false },
);
const cleanup = () => {
  try {
    edge.kill();
  } catch {}
  try {
    rmSync(path.join(PROFILE, "SingletonLock"), { force: true });
  } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

// 等 CDP 就绪
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
for (let i = 0; i < 40; i += 1) {
  await wait(250);
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${PORT}`,
      defaultViewport: null,
    });
    break;
  } catch {
    /* 还没起来，继续等 */
  }
}
if (!browser) {
  console.error("Edge CDP 连接失败");
  process.exit(1);
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(sizeArg), height: Number(sizeArg) });
  page.on("pageerror", (err) => console.error("[pageerror]", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("[console]", msg.text());
  });
  const url = `http://127.0.0.1:8787/tests/fixtures/model-3d.html?yaw=${yawArg}&pitch=${pitchArg}&size=${sizeArg}&clear=${clearArg}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => window.__renderReady === true, { timeout: 180000 });
  await wait(400);
  await page.screenshot({ path: out, omitBackground: clearArg === "none" });
  const errors = await page.evaluate(() => window.__errors ?? []);
  console.log("rendered:", out, errors.length ? `errors: ${errors.join("; ")}` : "(no errors)");
} finally {
  await browser.disconnect();
  cleanup();
}
