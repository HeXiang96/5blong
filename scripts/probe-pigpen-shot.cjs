/**
 * 截取房间页（猪圈）的真实渲染结果，用于人工确认视觉。
 * 用法：node scripts/probe-pigpen-shot.cjs
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SHELL = "D:/5blong/piik/node_modules/electron/dist/electron.exe";
const APP_DIR = "D:/5blong/piik/dist-desktop/probe-shot";
const CDP_PORT = 9345;
const TARGET = "http://127.0.0.1:8794/";
const SHOT = "D:/5blong/piik/dist-desktop/pigpen.png";

fs.rmSync(APP_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });
fs.writeFileSync(path.join(APP_DIR, "package.json"), JSON.stringify({ name: "shot", main: "main.cjs" }));
fs.writeFileSync(
  path.join(APP_DIR, "main.cjs"),
  `
const { app, BrowserWindow, session } = require("electron");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("remote-debugging-port", "${CDP_PORT}");
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true));
  const win = new BrowserWindow({ width: 1200, height: 900, show: true });
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
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
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
  await sleep(4000);

  // 建房
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('创建语音房'));
    if (b) b.click(); return 'ok';
  })()`);
  await sleep(6000);

  const info = await evaluate(`(() => ({
    connected: document.body.innerText.includes('已连接'),
    pigs: document.querySelectorAll('.vx-pig').length,
    fences: document.querySelectorAll('.vx-fence').length,
    plates: document.querySelectorAll('.vx-pen-plate').length,
    penBox: (() => { const p = document.querySelector('.vx-pen'); if (!p) return null; const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    stageW: document.querySelector('.vx-pen-stage')?.clientWidth ?? -1,
    walkerAnim: getComputedStyle(document.querySelector('.vx-pig-walker') || document.body).animationName,
    walkerStyle: (() => { const w = document.querySelector('.vx-pig-walker'); if (!w) return null; const cs = getComputedStyle(w); const slot = w.parentElement; const ss = slot ? getComputedStyle(slot) : null; return { anim: cs.animationName, translate: cs.translate, scale: cs.scale, sizeVar: ss ? ss.getPropertyValue('--vx-pig-size').trim() : null, spanVar: ss ? ss.getPropertyValue('--vx-walk-span').trim() : null, startVar: ss ? ss.getPropertyValue('--vx-pig-start').trim() : null, slotW: slot ? slot.getBoundingClientRect().width : -1 }; })(),
    legAnim: getComputedStyle(document.querySelector('.vx-pig-leg') || document.body).animationName,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }))()`);
  console.log("页面状态:", JSON.stringify(info));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  console.log("截图已保存:", SHOT, Math.round(fs.statSync(SHOT).size / 1024) + " KB");

  ws.close();
  child.kill();
}

main()
  .catch((e) => {
    console.error("失败:", e.message);
    try { child.kill(); } catch {}
  })
  .finally(() => setTimeout(() => process.exit(0), 400));
