/**
 * 「桌面端为什么听不见别人」的定位探针。
 *
 * 关键：用**真实打包产物**（resources/app 里的 dist-web 和真实 main.cjs），
 * 只在末尾追加"再开一个窗口"的代码。这样跑的就是用户手上那个客户端的
 * 协议注册、权限、webPreferences，排除"测试环境不对"的可能。
 *
 * 测法：A 窗口的麦克风换成可听见的音调，B 窗口进房，
 * 在 B 窗口里检查远端 audio 元素与它驱动的 Web Audio 输出。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/5blong/piik";
const SHELL = `${ROOT}/node_modules/electron/dist/electron.exe`;
const PACKED = `${ROOT}/dist-desktop/5blong-win-x64/resources/app`;
const APP_DIR = `${ROOT}/dist-desktop/probe-desktop-audio`;
const CDP_PORT = 9396;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(`${PACKED}/electron/main.cjs`)) {
  throw new Error(`找不到打包产物: ${PACKED}/electron/main.cjs（先打包）`);
}
if (!fs.existsSync(`${PACKED}/dist-web/index.html`)) {
  throw new Error(`打包产物里缺少 dist-web`);
}

fs.rmSync(APP_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });

// 把真实产物搬过来（保留结构：electron/ 与 dist-web/ 的相对关系）
fs.cpSync(PACKED, path.join(APP_DIR, "app"), { recursive: true });
fs.writeFileSync(path.join(APP_DIR, "package.json"), JSON.stringify({ name: "da", main: "app/electron/main.cjs" }));

// 追加载入第二个窗口的逻辑（真实 main.cjs 的逻辑一个字都没改）
// 只额外做两件事：开启 CDP 端口（否则探针连不上）、再加一个访客窗口。
const mainPath = path.join(APP_DIR, "app", "electron", "main.cjs");
const original = fs.readFileSync(mainPath, "utf8");
fs.writeFileSync(
  mainPath,
  `// 探针注入：开启远程调试端口（原产物没开，所以要先加上）
try { require("electron").app.commandLine.appendSwitch("remote-debugging-port", "${CDP_PORT}"); } catch {}

${original}

/* ---------------- 探针追加：再开一个"访客"窗口，并把音调注入第一个窗口 ---------------- */
const TONE_MIC = \`
(() => {
  if (window.__toneMic) return;
  window.__toneMic = true;
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.audio) return orig(constraints);
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.value = 0.3;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    window.__tone = { ctx, osc, gain };
    return dest.stream;
  };
})();
\`;
app.whenReady().then(() => {
  setTimeout(() => {
    try {
      mainWindow.webContents.executeJavaScript(TONE_MIC).catch(() => {});
      const guest = new BrowserWindow({
        width: 900, height: 700, show: true, title: "GUEST",
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      guest.loadURL("app://bundle/index.html");
      globalThis.__guest = guest;
    } catch (e) { /* 探针不阻断主流程 */ }
  }, 1500);
});
`,
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VOX_SMOKE;
delete env.VOX_SMOKE_OUT;
const child = spawn(SHELL, [APP_DIR], { env, stdio: "ignore" });

let nextId = 1;
const pending = new Map();
let ws;
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
async function attach(url) {
  const sock = new WebSocket(url);
  await new Promise((r) => sock.addEventListener("open", r, { once: true }));
  const pend = new Map();
  let id0 = 100000;
  sock.addEventListener("message", (e) => {
    const f = JSON.parse(e.data);
    if (f.id && pend.has(f.id)) {
      const { resolve } = pend.get(f.id);
      pend.delete(f.id);
      resolve(f.result);
    }
  });
  const s = (method, params = {}) =>
    new Promise((resolve) => {
      const id = id0++;
      pend.set(id, { resolve });
      sock.send(JSON.stringify({ id, method, params }));
    });
  await s("Runtime.enable");
  return { sock, send: s };
}
async function evalOn(sockObj, expr) {
  const r = await sockObj.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r?.result?.value;
}
const clickBy = (text) => `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)}));
  if (b) { b.click(); return b.textContent.trim(); }
  return null;
})()`;

const PROBE_REMOTE = `(async () => {
  const els = [...document.querySelectorAll('audio')];
  const info = els.map((el) => ({
    peer: el.dataset.peer || null,
    hasStream: !!el.srcObject,
    tracks: el.srcObject instanceof MediaStream
      ? el.srcObject.getAudioTracks().map((t) => ({ enabled: t.enabled, muted: t.muted, state: t.readyState }))
      : [],
    volume: el.volume, muted: el.muted, paused: el.paused, readyState: el.readyState,
  }));
  const ctxInfo = [];
  let level = null;
  if (els.length > 0 && els[0].srcObject) {
    try {
      const ctx = new AudioContext();
      ctxInfo.push({ state: ctx.state, sampleRate: ctx.sampleRate });
      await ctx.resume().catch(() => {});
      ctxInfo.push({ afterResume: ctx.state });
      const src = ctx.createMediaStreamSource(els[0].srcObject);
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      let peak = 0;
      for (let i = 0; i < 24; i++) {
        an.getByteFrequencyData(data);
        let sum = 0;
        for (const v of data) sum += v;
        peak = Math.max(peak, sum / data.length);
        await new Promise((r) => setTimeout(r, 50));
      }
      ctx.close();
      level = +peak.toFixed(1);
    } catch (e) { level = 'error: ' + e.message; }
  }
  return { count: els.length, info, ctxInfo, remoteLevel: level, href: location.href, origin: location.origin };
})()`;

async function main() {
  const deadline = Date.now() + 30000;
  let pages = [];
  while (Date.now() < deadline && pages.length < 2) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (pages.length < 2) await sleep(500);
  }
  if (pages.length < 2) throw new Error(`只找到 ${pages.length} 个页面目标`);

  const hostPage = pages.find((p) => (p.title || "").includes("5blong")) ?? pages[0];
  const guestPage = pages.find((p) => p.id !== hostPage.id) ?? pages[1];
  const host = await attach(hostPage.webSocketDebuggerUrl);
  const guest = await attach(guestPage.webSocketDebuggerUrl);
  await sleep(4500);

  console.log("host  href:", await evalOn(host, "location.href"));
  console.log("guest href:", await evalOn(guest, "location.href"));

  await evalOn(host, clickBy("创建语音房"));
  await sleep(6000);
  console.log("音调是否注入 host:", await evalOn(host, "!!window.__tone"));

  const invite = await evalOn(host, `(async () => {
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    let captured = null;
    navigator.clipboard.writeText = async (v) => { captured = v; try { return await orig(v); } catch { return; } };
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('复制邀请'));
    if (!b) return { error: 'no button' };
    b.click();
    for (let i = 0; i < 40 && !captured; i++) await new Promise((r) => setTimeout(r, 100));
    return { captured };
  })()`);
  const url = invite?.captured;
  console.log("邀请链接:", url);
  if (!url || !url.includes("#")) throw new Error("拿不到邀请链接");
  const frag = url.slice(url.indexOf("#"));

  /*
   * 关键：必须让访客页面**带着 hash 重新加载**。
   * 只改 hash 属于同文档导航、页面不重载，而读邀请的那个 effect 依赖是 []，
   * 只在挂载时跑一次——于是会一直停在落地页（我第一版探针就是这么假失败的）。
   */
  await evalOn(guest, `location.replace("app://bundle/index.html" + ${JSON.stringify(frag)}); 'ok'`);
  await sleep(1200);
  await evalOn(guest, `location.reload(); 'ok'`);
  await sleep(7000);
  const guestUi = await evalOn(guest, `(() => ({
    btns: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean),
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
  }))()`);
  console.log("访客页面按钮:", JSON.stringify(guestUi.btns));
  console.log("访客加入:", await evalOn(guest, clickBy("静音加入")) ?? await evalOn(guest, clickBy("加入")));
  await sleep(9000);

  const r = await evalOn(guest, PROBE_REMOTE);
  console.log("");
  console.log("=== 访客侧（真实打包产物，app:// 协议）===");
  console.log(JSON.stringify(r, null, 1));
  console.log("");
  if (r.count === 0) console.log("❌ 没有远端 audio 元素 —— 媒体连接没建立");
  else if (r.remoteLevel === 0) console.log("❌ 有元素但电平为 0");
  else if (typeof r.remoteLevel === "number" && r.remoteLevel > 5) console.log("✅ 桌面端确实能收到远端音频");
  else console.log("⚠️ 电平很低");

  host.sock.close();
  guest.sock.close();
  child.kill();
}

main()
  .catch((e) => {
    console.error("探针失败:", e.message);
    try { child.kill(); } catch {}
  })
  .finally(() => setTimeout(() => process.exit(0), 500));
