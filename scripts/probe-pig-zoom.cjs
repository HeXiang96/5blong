/**
 * 放大检查猪的造型：把猪的 SVG 单独放大到画面中心，
 * 便于人工核对比例（头身比、耳朵、眼睛、有没有穿模）。
 *
 * 用法：node scripts/probe-pig-zoom.cjs [side|front]
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const POSE = process.argv[2] || "side";
const SHELL = "D:/5blong/piik/node_modules/electron/dist/electron.exe";
const APP_DIR = "D:/5blong/piik/dist-desktop/probe-zoom";
const CDP_PORT = 9356;
// front：靠假麦克风的语音检测进入"说话"姿态（正面、张嘴、竖耳朵）
// side：用"拉"的调试姿势（停下、身体前倾），是侧面姿态
const TARGET =
  POSE === "front"
    ? "http://127.0.0.1:8795/"
    : "http://127.0.0.1:8795/?pen=pose:poop";
const OUT = `D:/5blong/piik/dist-desktop/pig-zoom-${POSE}.png`;

fs.rmSync(APP_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });
fs.writeFileSync(path.join(APP_DIR, "package.json"), JSON.stringify({ name: "zoom", main: "main.cjs" }));
fs.writeFileSync(
  path.join(APP_DIR, "main.cjs"),
  `
const { app, BrowserWindow, session } = require("electron");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("remote-debugging-port", "${CDP_PORT}");

/**
 * 把 getUserMedia 拿到的音频大幅放大后再交给页面。
 * 这样引擎自己的音量检测会认为"有人在说话"，从而切到正面姿态。
 */
function boostMic() {
  return \`
    (() => {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await orig(constraints);
        if (!constraints || !constraints.audio) return stream;
        try {
          const ctx = new AudioContext();
          const src = ctx.createMediaStreamSource(stream);
          const gain = ctx.createGain();
          gain.gain.value = 40;
          const dest = ctx.createMediaStreamDestination();
          src.connect(gain).connect(dest);
          return dest.stream;
        } catch (e) {
          return stream;
        }
      };
    })();
  \`;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true));
  const win = new BrowserWindow({ width: 900, height: 700, show: true });
  ${POSE === "front" ? "win.webContents.on('did-start-loading', () => { win.webContents.executeJavaScript(boostMic()).catch(() => {}); });" : ""}
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

/** 把猪单独拎出来放大居中，隐藏其余 UI。 */
const MAGNIFY = `(() => {
  const pig = document.querySelector('.vx-pig');
  if (!pig) return { ok: false, reason: 'no pig' };
  const hide = ['.vx-room-top', '.vx-controls', '.vx-empty-pen', '.vx-member-menu',
                '.vx-pen-props', '.vx-fence-left', '.vx-fence-right', '.vx-pig-tag'];
  for (const sel of hide) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none';
  }
  // 停掉所有动画，保证截图是稳定姿态
  for (const el of document.querySelectorAll('.vx-pig-walker, .vx-pig-flip, .vx-pig, .vx-pig-body-group')) {
    el.style.animation = 'none';
    el.style.transition = 'none';
  }
  const slot = pig.closest('.vx-pig-slot');
  if (slot) {
    slot.style.animation = 'none';
    // 用 position:fixed 定位**外层槽位**（SVG 自身在带 transform 的祖先里，
    // 直接给 SVG 设 fixed 不会生效）。
    slot.style.position = 'fixed';
    slot.style.left = '50%';
    slot.style.top = '50%';
    slot.style.bottom = 'auto';
    slot.style.width = '460px';
    slot.style.height = '460px';
    slot.style.transform = 'translate(-50%, -50%)';
    slot.style.zIndex = '9999';
  }
  pig.style.width = '100%';
  pig.style.height = '100%';
  return { ok: true, moved: !!slot };
})()`;

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

  const info = await evaluate(MAGNIFY);
  console.log("放大结果:", JSON.stringify(info));

  /*
   * 说话 / 走动会周期性交替，而正面姿态只在"说话"时出现（由 React 的 pose
   * 属性决定，光改 CSS 类没用）。这里等它进入说话状态再截图。
   */
  let speaking = false;
  for (let i = 0; i < 30; i += 1) {
    speaking = await evaluate(`(() => {
      const pig = document.querySelector('.vx-pig');
      return !!pig && pig.className.includes('vx-pig-speaking');
    })()`);
    if (speaking) break;
    await sleep(500);
  }
  console.log("截图时处于说话状态:", speaking);
  await sleep(120);

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
