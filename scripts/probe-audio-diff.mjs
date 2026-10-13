/**
 * 对比「网页版」与「桌面端」的音频环境差异。
 *
 * 思路：跑**同一段探测脚本**，一遍在 Chromium 打开 http://，
 * 一遍在桌面端打开 app://，把结果并排比。凡是只有一边有的能力，
 * 就是"网页版有声音、桌面端没声音"的嫌疑点。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/5blong/piik";
const SHELL = `${ROOT}/node_modules/electron/dist/electron.exe`;
const APP_DIR = `${ROOT}/dist-desktop/probe-audio-diff`;
const CDP_PORT = 9398;
const WEB = "http://127.0.0.1:8795/";
const PACKED = `${ROOT}/dist-desktop/5blong-win-x64/resources/app`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(`${PACKED}/dist-web/index.html`)) throw new Error("打包产物不存在，先打包");

fs.rmSync(APP_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });
fs.cpSync(PACKED, path.join(APP_DIR, "app"), { recursive: true });
fs.writeFileSync(path.join(APP_DIR, "package.json"), JSON.stringify({ name: "ad", main: "probe.cjs" }));

fs.writeFileSync(
  path.join(APP_DIR, "probe.cjs"),
  `
const { app, BrowserWindow, session, protocol } = require("electron");
const path = require("path");
const fs = require("fs");

// 与真实桌面端一致的协议特权声明
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportServiceWorkers: true, corsEnabled: true } },
]);

const WEB_ROOT = path.join(__dirname, "app", "dist-web");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm", ".png": "image/png", ".ico": "image/x-icon",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2",
};

app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("remote-debugging-port", "${CDP_PORT}");

app.whenReady().then(() => {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\\/+/, "");
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const full = path.normalize(path.join(WEB_ROOT, rel));
    if (!full.startsWith(path.normalize(WEB_ROOT))) return new Response("Forbidden", { status: 403 });
    try {
      const data = await fs.promises.readFile(full);
      return new Response(data, { headers: { "content-type": MIME[path.extname(full)] || "application/octet-stream" } });
    } catch { return new Response("Not Found", { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  const a = new BrowserWindow({ width: 800, height: 600, show: true, title: "WEB" });
  a.loadURL(${JSON.stringify(WEB)});
  const b = new BrowserWindow({ width: 800, height: 600, show: true, title: "APP" });
  b.loadURL("app://bundle/index.html");
});
`,
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VOX_SMOKE;
delete env.VOX_SMOKE_OUT;
const child = spawn(SHELL, [APP_DIR], { env, stdio: "ignore" });

async function attach(url) {
  const sock = new WebSocket(url);
  await new Promise((r) => sock.addEventListener("open", r, { once: true }));
  const pend = new Map();
  let id0 = 1;
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
async function evalOn(o, expr) {
  const r = await o.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r?.result?.value;
}

const PROBE = `(async () => {
  const out = {
    origin: location.origin,
    isSecureContext: window.isSecureContext,
    hasAudioContext: typeof AudioContext,
    hasMediaDevices: typeof navigator.mediaDevices,
    hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    hasEnumerate: !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices),
    hasSetSinkId: typeof HTMLMediaElement.prototype.setSinkId,
    hasSinkIdOnEl: typeof document.createElement('audio').setSinkId,
  };
  // AudioContext 能否起来
  try {
    const ctx = new AudioContext();
    out.ctxStateBefore = ctx.state;
    await ctx.resume().catch(() => {});
    out.ctxStateAfter = ctx.state;
    out.sampleRate = ctx.sampleRate;
    // 用它播一个振荡器，看能不能真的出声（电平不为 0）
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.2;
    const dest = ctx.createMediaStreamDestination();
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    osc.connect(g);
    g.connect(dest);
    g.connect(an);
    osc.start();
    const data = new Uint8Array(an.frequencyBinCount);
    let peak = 0;
    for (let i = 0; i < 10; i++) {
      an.getByteFrequencyData(data);
      let sum = 0;
      for (const v of data) sum += v;
      peak = Math.max(peak, sum / data.length);
      await new Promise((r) => setTimeout(r, 50));
    }
    osc.stop();
    out.oscLevel = +peak.toFixed(1);
    ctx.close();
  } catch (e) { out.ctxError = String(e && e.message); }
  // 设备枚举
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    out.deviceKinds = [...new Set(devs.map((d) => d.kind))];
    out.deviceCount = devs.length;
    out.audioOutputs = devs.filter((d) => d.kind === 'audiooutput').length;
  } catch (e) { out.deviceError = String(e && e.message); }
  // 麦克风能否拿到
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    out.micOk = s.getAudioTracks().length > 0;
    s.getTracks().forEach((t) => t.stop());
  } catch (e) { out.micError = String(e && e.message); }
  // 自动播放：不经过手势直接 play() 会不会被拒
  try {
    const ctx2 = new AudioContext();
    const osc2 = ctx2.createOscillator();
    const dest2 = ctx2.createMediaStreamDestination();
    osc2.connect(dest2);
    osc2.start();
    const el = document.createElement('audio');
    el.srcObject = dest2.stream;
    document.body.appendChild(el);
    await el.play();
    out.autoplayOk = !el.paused;
    el.remove();
    osc2.stop();
    ctx2.close();
  } catch (e) { out.autoplayError = String(e && e.name) + ': ' + String(e && e.message); }
  return out;
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
  if (pages.length < 2) throw new Error(`只找到 ${pages.length} 个页面`);

  const webPage = pages.find((p) => (p.url || "").startsWith("http")) ?? pages[0];
  const appPage = pages.find((p) => (p.url || "").startsWith("app://")) ?? pages[1];
  console.log("网页目标:", webPage.url);
  console.log("桌面目标:", appPage.url);

  const web = await attach(webPage.webSocketDebuggerUrl);
  const appSock = await attach(appPage.webSocketDebuggerUrl);
  await sleep(3500);

  const a = await evalOn(web, PROBE);
  const b = await evalOn(appSock, PROBE);

  console.log("");
  console.log("=== 环境差异对照 ===");
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();
  const diffs = [];
  for (const k of keys) {
    const va = JSON.stringify(a?.[k]);
    const vb = JSON.stringify(b?.[k]);
    const same = va === vb;
    if (!same) diffs.push(k);
    console.log(`  ${same ? " " : "!"} ${k.padEnd(20)} 网页=${String(va).padEnd(22)} 桌面=${vb}`);
  }

  console.log("");
  if (diffs.length === 0) {
    console.log('✅ 两个环境在音频能力上没有差异 —— 客户端的“没声音”不是环境能力缺失');
  } else {
    console.log(`发现 ${diffs.length} 处差异：${diffs.join(", ")}`);
  }

  web.sock.close();
  appSock.sock.close();
  child.kill();
}

main()
  .catch((e) => {
    console.error("探针失败:", e.message);
    try { child.kill(); } catch {}
  })
  .finally(() => setTimeout(() => process.exit(0), 500));
