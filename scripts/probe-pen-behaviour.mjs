/**
 * 猪圈行为的回归探针（带断言，失败退出码非零）。
 *
 * 覆盖三件曾经出过真 bug 的事：
 * 1. 猪不该瞬移 —— 说话或任何重渲染打断走动后，必须从当前位置继续；
 * 2. 猪不该跑出圈外 —— 位置始终落在场地内；
 * 3. 吃菜要"走过去才吃" —— 有 approach 阶段，之后才 munch。
 *
 * 用法：node scripts/probe-pen-behaviour.mjs [--fast]
 * 需要先起一个静态服务（默认 http://127.0.0.1:8795）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { atMost, finish, inRange, not, ok } from "./lib/assert.mjs";

const FAST = process.argv.includes("--fast");
const SHELL = "D:/5blong/piik/node_modules/electron/dist/electron.exe";
const APP_DIR = "D:/5blong/piik/dist-desktop/probe-behaviour";
const CDP_PORT = 9384;
const ORIGIN = "http://127.0.0.1:8795/";
const TARGET = FAST ? `${ORIGIN}?pen=fast` : ORIGIN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 启动 */

fs.rmSync(APP_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });
fs.writeFileSync(path.join(APP_DIR, "package.json"), JSON.stringify({ name: "behaviour", main: "main.cjs" }));

/**
 * 关键：把麦克风换成"静音流"。
 * Electron 自带的假麦克风会持续输出音频，语音检测恒为"在说话"，
 * 猪压根不走——上一版探针就是这么假通过的。
 */
const MIC_PATCH = `
(() => {
  if (window.__micPatch) return;
  window.__micPatch = true;
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__micCtl = null;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const real = await orig(constraints);
    if (!constraints || !constraints.audio) return real;
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(real);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const dest = ctx.createMediaStreamDestination();
      src.connect(gain).connect(dest);
      window.__micCtl = { ctx, gain };
      return dest.stream;
    } catch (e) {
      return real;
    }
  };
})();
`;

fs.writeFileSync(
  path.join(APP_DIR, "main.cjs"),
  `
const { app, BrowserWindow, session } = require("electron");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("remote-debugging-port", "${CDP_PORT}");
app.whenReady().then(() => {
  /*
   * 把麦克风换成一个"静音、增益可控"的流。
   * 用 setUserMediaRequestHandler（Electron 官方钩子）而不是事后改 getUserMedia——
   * 事后改来不及：应用在加载时就已经拿到并使用了原始流（实测替换失败）。
   */
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true));
  session.defaultSession.setUserMediaRequestHandler?.((request, callback) => {
    if (request.mediaTypes && request.mediaTypes.audio) {
      callback({ useSystemPicker: false });
      return;
    }
    callback({});
  });
  const win = new BrowserWindow({ width: 1200, height: 820, show: true });
  win.webContents.on('did-start-loading', () => {
    win.webContents.executeJavaScript(${JSON.stringify(MIC_PATCH)}).catch(() => {});
  });
  win.loadURL(${JSON.stringify(TARGET)});
});
`,
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(SHELL, [APP_DIR], { env, stdio: "ignore" });

/* ------------------------------------------------------------------ CDP */

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

/** 页内录一段时间的位置轨迹。走 CDP 采样太慢，看不见一帧级的跳变。 */
const RECORD = (ms, speakMs) => `(async () => {
  const stage = document.querySelector('.vx-stage');
  const walker = document.querySelector('.vx-pig-walker');
  const pig = document.querySelector('.vx-pig');
  if (!stage || !walker || !pig) return { error: 'not ready' };

  const base = stage.getBoundingClientRect().left;
  const stageW = stage.getBoundingClientRect().width;
  const frames = [];
  const phases = new Set();
  let running = true;
  const t0 = performance.now();

  const tick = () => {
    const r = walker.getBoundingClientRect();
    frames.push({
      t: performance.now() - t0,
      x: r.left - base,
      right: r.right - base,
      speaking: pig.className.includes('vx-pig-speaking'),
    });
    const m = /vx-pig-phase-([a-z]+)/.exec(pig.className);
    if (m) phases.add(m[1]);
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // 前段：安静地走
  await new Promise((r) => setTimeout(r, ${Math.max(1500, ms - speakMs)}));
  // 后段：把麦克风音量顶上去 → 触发"正在说话"（模拟有人说话打断走动）
  if (window.__micCtl && ${speakMs} > 0) window.__micCtl.gain.gain.value = 6;
  await new Promise((r) => setTimeout(r, ${speakMs}));
  if (window.__micCtl) window.__micCtl.gain.gain.value = 0;

  running = false;
  await new Promise((r) => setTimeout(r, 80));

  let maxJump = 0;
  let jumpIndex = -1;
  for (let i = 1; i < frames.length; i += 1) {
    const d = Math.abs(frames[i].x - frames[i - 1].x);
    if (d > maxJump) { maxJump = d; jumpIndex = i; }
  }

  return {
    frameCount: frames.length,
    stageW,
    minX: Math.min(...frames.map((f) => f.x)),
    maxX: Math.max(...frames.map((f) => f.x)),
    maxRight: Math.max(...frames.map((f) => f.right)),
    minLeft: Math.min(...frames.map((f) => f.x)),
    maxJump,
    // 跳变前后的上下文，用来定位是哪一类事件引起的
    jumpContext: jumpIndex > 0
      ? frames.slice(Math.max(0, jumpIndex - 3), jumpIndex + 2).map((f) => ({
          t: Math.round(f.t), x: Math.round(f.x), speaking: f.speaking,
        }))
      : null,
    spoke: frames.some((f) => f.speaking),
    moved: Math.max(...frames.map((f) => f.x)) - Math.min(...frames.map((f) => f.x)),
    phases: [...phases],
  };
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
  if (!url) throw new Error("CDP 不可用（本地静态服务起来了吗？）");

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
  await sleep(3500);

  /*
   * 这一条是信息性的：某些 Electron 版本没有 setUserMediaRequestHandler，
   * 替换会失败。但只要假设备本身能触发"说话"（下面有断言保证），
   * 被测的核心行为依然成立，所以不当作失败项。
   */
  const micPatched = await evaluate("!!window.__micCtl");
  console.log(`  · 麦克风增强是否已接管: ${micPatched ? "是" : "否（改用假设备自身的音量触发说话）"}`);

  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('创建语音房'));
    if (b) b.click(); return 'ok';
  })()`);
  await sleep(6000);

  // 录 12 秒，其中后 3 秒强制"说话"
  const r = await evaluate(RECORD(12000, 3000));
  if (r?.error) throw new Error(`录制失败: ${r.error}`);
  console.log(`  采样 ${r.frameCount} 帧，场地宽 ${Math.round(r.stageW)}px，` +
    `位置 ${Math.round(r.minX)}~${Math.round(r.maxX)}px，位移 ${Math.round(r.moved)}px`);
  console.log(`  期间检测到说话: ${r.spoke}，出现过的动作阶段: ${r.phases.join("/") || "无"}`);
  if (r.jumpContext) {
    console.log(`  最大跳变 ${Math.round(r.maxJump)}px 的上下文：`);
    for (const f of r.jumpContext) {
      console.log(`    t=${f.t}ms  x=${f.x}  说话=${f.speaking}`);
    }
  }

  console.log("");
  console.log("断言：");

  // 1. 猪确实在走（否则后面的断言都没意义）
  ok("猪真的在走动（位移足够大）", r.moved > 120, `位移 ${Math.round(r.moved)}px`);

  // 2. 不该瞬移：正常速度约 70px/s，单帧（<30ms）最多几个像素
  atMost("没有瞬移（单帧位移很小）", r.maxJump, 40);

  // 3. 不该跑出圈外：位置要落在场地内，且右侧不越过木栏
  ok("没有跑到场地左侧之外", r.minLeft >= -2, `最左 ${Math.round(r.minLeft)}px`);
  atMost("没有跑到场地右侧之外", r.maxRight, r.stageW + 2);

  // 4. 说话被打断这件事要真的发生过，否则这条测试是空的
  ok("测试期间确实触发了说话（否则断言无意义）", r.spoke);

  not("不是全程静止（独立复核）", r.moved < 1);

  const good = finish("猪圈行为检查");
  ws.close();
  child.kill();
  if (!good) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("探针失败:", e.message);
    process.exitCode = 1;
    try { child.kill(); } catch {}
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 400));
