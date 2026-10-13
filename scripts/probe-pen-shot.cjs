/**
 * 拍一张猪圈道具的定妆照：地上有菜 / 猪在吃 / 猪在拉 + 那一坨。
 *
 * 用法：node scripts/probe-pen-shot.cjs [eat|poop|veg]
 * 用调试姿势参数（?pen=pose:*）确保动作一定出现，不用等随机事件。
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MODE = process.argv[2] || "poop";
const SHELL = "D:/5blong/piik/node_modules/electron/dist/electron.exe";
const APP_DIR = "D:/5blong/piik/dist-desktop/probe-penshot";
const CDP_PORT = 9353;
const BASE = "http://127.0.0.1:8795/";
// 既开加速（会有菜丢进来），又强制姿势（保证动作可见）
const TARGET = `${BASE}?pen=fast&pen=pose:${MODE === "veg" ? "eat" : MODE}`;
const OUT = `D:/5blong/piik/dist-desktop/pen-showcase.png`;

fs.rmSync(APP_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });
fs.writeFileSync(path.join(APP_DIR, "package.json"), JSON.stringify({ name: "penshot", main: "main.cjs" }));
fs.writeFileSync(
  path.join(APP_DIR, "main.cjs"),
  `
const { app, BrowserWindow, session } = require("electron");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("remote-debugging-port", "${CDP_PORT}");
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true));
  const win = new BrowserWindow({ width: 1280, height: 880, show: true });
  win.loadURL(${JSON.stringify(TARGET)});
});
`,
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(SHELL, [APP_DIR], { env, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method, params }));
  });
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r?.result?.value;
}

async function main() {
  const deadline = Date.now() + 25000;
  let url = null;
  while (Date.now() < deadline && !url) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      url = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null;
    } catch {}
    if (!url) await sleep(400);
  }
  if (!url) throw new Error("CDP 不可用");
  ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (e) => {
    const f = JSON.parse(e.data);
    if (f.id && pending.has(f.id)) {
      const { resolve } = pending.get(f.id);
      pending.delete(f.id);
      resolve(f.result);
    }
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await sleep(3500);

  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('创建语音房'));
    if (b) b.click(); return 'ok';
  })()`);
  await sleep(5500);

  const snap = await evaluate(`(() => ({
    veg: document.querySelectorAll('.vx-veg').length,
    poop: document.querySelectorAll('.vx-poop').length,
    eat: document.querySelectorAll('.vx-pig-action-eat').length,
    pooping: document.querySelectorAll('.vx-pig-action-poop').length,
    npc: document.querySelector('.vx-npc-badge')?.textContent?.trim() ?? null,
  }))()`);
  console.log("当前画面:", JSON.stringify(snap));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log("截图:", OUT);

  ws.close();
  child.kill();
}

main()
  .catch((e) => {
    console.error("失败:", e.message);
    try { child.kill(); } catch {}
  })
  .finally(() => setTimeout(() => process.exit(0), 500));
