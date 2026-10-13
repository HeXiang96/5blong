/**
 * 双猪实测：宿主建圈 + 访客进圈，截图确认"房主大猪 + 成员小猪"与分道摆放。
 * 用法：node scripts/probe-two-pigs.cjs
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SHELL = "D:/5blong/piik/node_modules/electron/dist/electron.exe";
const APP_DIR = "D:/5blong/piik/dist-desktop/probe-two";
const CDP_PORT = 9348;
const TARGET = "http://127.0.0.1:8794/";
const SHOT = "D:/5blong/piik/dist-desktop/two-pigs.png";

fs.rmSync(APP_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });
fs.writeFileSync(path.join(APP_DIR, "package.json"), JSON.stringify({ name: "two", main: "main.cjs" }));
fs.writeFileSync(
  path.join(APP_DIR, "main.cjs"),
  `
const { app, BrowserWindow, session } = require("electron");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("remote-debugging-port", "${CDP_PORT}");
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true));
  globalThis.__host = new BrowserWindow({ width: 1100, height: 800, show: true, x: 0, y: 0, title: "HOST" });
  globalThis.__guest = new BrowserWindow({ width: 1100, height: 800, show: false, x: 1100, y: 0, title: "GUEST" });
  globalThis.__host.loadURL(${JSON.stringify(TARGET)});
  globalThis.__guest.loadURL(${JSON.stringify(TARGET)});
  globalThis.__go = (hash) => globalThis.__guest.loadURL(${JSON.stringify(TARGET)} + hash);
});
`,
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(SHELL, [APP_DIR], { env, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
const sessions = new Map();
function makeSession(ws) {
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const f = JSON.parse(e.data);
    if (f.id && pending.has(f.id)) {
      const { resolve } = pending.get(f.id);
      pending.delete(f.id);
      resolve(f.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send };
}

async function attach(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const s = makeSession(ws);
  await s.send("Runtime.enable");
  await s.send("Page.enable");
  return s;
}

async function evaluate(s, expr) {
  const r = await s.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r?.result?.value;
}

const SNAP = `(() => ({
  pigs: [...document.querySelectorAll('.vx-pig-slot')].map((slot) => {
    const pig = slot.querySelector('.vx-pig');
    const plate = slot.querySelector('.vx-pig-tag-name');
    const cs = getComputedStyle(slot);
    return {
      name: plate ? plate.textContent : '',
      size: cs.getPropertyValue('--vx-pig-size').trim(),
      depth: cs.getPropertyValue('--vx-depth').trim(),
      bottom: cs.getPropertyValue('--vx-pig-bottom').trim(),
      walkerAnim: getComputedStyle(slot.querySelector('.vx-pig-walker')).animationName,
      speaking: pig ? pig.className.includes('speaking') : false,
    };
  }),
  count: document.querySelectorAll('.vx-pig-slot').length,
  connected: document.body.innerText.includes('已连接'),
}))()`;

async function main() {
  const deadline = Date.now() + 25000;
  let pages = [];
  while (Date.now() < deadline && pages.length < 2) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (pages.length < 2) await sleep(400);
  }
  if (pages.length < 2) throw new Error("CDP 目标不足两个");

  const hostPage = pages.find((p) => (p.title || "").includes("HOST")) ?? pages[0];
  const guestPage = pages.find((p) => p.id !== hostPage.id) ?? pages[1];
  const host = await attach(hostPage.webSocketDebuggerUrl);
  const guest = await attach(guestPage.webSocketDebuggerUrl);
  await sleep(4000);

  // 宿主建圈
  await evaluate(host, `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('创建语音房'));
    if (b) b.click();
    return 'ok';
  })()`);
  await sleep(6000);

  // 用页内拦截 writeText 拿邀请链接（窗口失焦时不能 readText）
  const invite = await evaluate(host, `(async () => {
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    let captured = null;
    navigator.clipboard.writeText = async (v) => { captured = v; return orig(v).catch(() => {}); };
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('复制邀请'));
    if (!b) return null;
    b.click();
    for (let i = 0; i < 40 && !captured; i++) await new Promise((r) => setTimeout(r, 100));
    return captured;
  })()`);
  const hash = invite && invite.includes("#") ? invite.slice(invite.indexOf("#")) : "";
  console.log("邀请链接:", invite);
  if (!hash) throw new Error("拿不到邀请链接");

  // 访客真正加载邀请链接并进圈
  await evaluate(guest, `location.replace(${JSON.stringify(TARGET.replace(/#.*$/, "") + hash)}); 'ok'`);
  await sleep(3000);
  await evaluate(guest, "location.reload(); 'ok'");
  await sleep(6000);
  await evaluate(guest, `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('静音加入'));
    if (b) b.click();
    return 'ok';
  })()`);

  // 等两边都稳定
  for (let i = 0; i < 10; i++) {
    await sleep(2500);
    const h = await evaluate(host, SNAP);
    const g = await evaluate(guest, SNAP);
    console.log(`[${i * 2.5}s] host 猪=${h.count} 连接=${h.connected} | guest 猪=${g.count} 连接=${g.connected}`);
    if (h.count >= 1 && g.count >= 1) break;
  }

  const hostSnap = await evaluate(host, SNAP);
  const guestSnap = await evaluate(guest, SNAP);
  console.log("\n宿主视角:", JSON.stringify(hostSnap, null, 1));
  console.log("\n访客视角:", JSON.stringify(guestSnap, null, 1));

  const shot = await host.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  console.log("\n截图:", SHOT);

  host.ws.close();
  guest.ws.close();
  child.kill();
}

main()
  .catch((e) => {
    console.error("失败:", e.message);
    try { child.kill(); } catch {}
  })
  .finally(() => setTimeout(() => process.exit(0), 500));
