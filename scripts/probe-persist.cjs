/**
 * 验证"房间内快捷开关是否真的落盘"。
 *
 * 步骤：建房 → 打开语音快捷面板 → 改动开关与音量 → 读 localStorage 的实际内容。
 * 修复前这些改动只改内存，localStorage 里不会出现对应字段。
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SHELL = "D:/5blong/piik/node_modules/electron/dist/electron.exe";
const APP_DIR = "D:/5blong/piik/dist-desktop/probe-persist";
const CDP_PORT = 9341;
const TARGET = "http://127.0.0.1:8794/";

fs.rmSync(APP_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });
fs.writeFileSync(path.join(APP_DIR, "package.json"), JSON.stringify({ name: "p", main: "main.cjs" }));
fs.writeFileSync(
  path.join(APP_DIR, "main.cjs"),
  `
const { app, BrowserWindow, session } = require("electron");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("remote-debugging-port", "${CDP_PORT}");
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true));
  const win = new BrowserWindow({ width: 960, height: 760, show: true });
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
async function attach() {
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
}

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) {
    throw new Error(`页面异常: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r?.result?.value;
}

const SETTINGS_KEY = "5blong:v1:settings";

async function stored() {
  return evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}) || '{}')`);
}

async function main() {
  await attach();
  await sleep(4500);
  console.log("[1] 首屏:", (await evaluate("document.body.innerText.slice(0,60)")).replace(/\n+/g, " | "));

  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('创建语音房'));
    if (!b) throw new Error('没有创建按钮');
    b.click(); return 'ok';
  })()`);

  // 等进房
  for (let i = 0; i < 8; i++) {
    await sleep(2000);
    const text = await evaluate("document.body.innerText");
    if (text.includes("已连接")) break;
  }
  const inRoom = (await evaluate("document.body.innerText")).includes("已连接");
  console.log("[2] 已进房:", inRoom);

  const before = await stored();
  console.log("[3] 改动前的落盘内容:", JSON.stringify(before.processing ?? null), "micVolume=", before.micVolume);

  // 打开语音快捷面板
  await evaluate(`(() => {
    const b = document.querySelector('button[aria-label="语音快捷设置"]')
      || [...document.querySelectorAll('button')].find((x) => x.title === '语音快捷设置');
    if (!b) throw new Error('找不到语音快捷设置按钮');
    b.click(); return 'ok';
  })()`);
  await sleep(900);
  console.log("[4] 面板已开:", (await evaluate("document.body.innerText")).includes("麦克风音量"));

  // 点「回声消除」开关（面板内第二个 switch）
  const switches = await evaluate(`(() => [...document.querySelectorAll('[role="switch"]')].map((s) => s.getAttribute('aria-label') + '=' + s.getAttribute('aria-checked')))()`);
  console.log("[5] 面板内的开关:", JSON.stringify(switches));

  await evaluate(`(() => {
    const s = [...document.querySelectorAll('[role="switch"]')].find((x) => x.getAttribute('aria-label') === '回声消除');
    if (!s) throw new Error('找不到回声消除开关');
    s.click(); return 'ok';
  })()`);
  await sleep(1200);

  const afterFlag = await stored();
  console.log("[6] 点回声消除后落盘:", JSON.stringify(afterFlag.processing ?? null));

  // 拖动麦克风音量到 1.5
  await evaluate(`(() => {
    const r = document.querySelector('input[type="range"]');
    if (!r) throw new Error('找不到音量滑杆');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(r, '1.5');
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(1200);

  const afterVolume = await stored();
  console.log("[7] 拖音量后落盘: micVolume=", afterVolume.micVolume);

  // 点「AI 智能降噪」关掉
  await evaluate(`(() => {
    const s = [...document.querySelectorAll('[role="switch"]')].find((x) => x.getAttribute('aria-label') === 'AI 智能降噪');
    if (!s) throw new Error('找不到降噪开关');
    s.click(); return 'ok';
  })()`);
  await sleep(1500);
  const afterNs = await stored();
  console.log("[8] 关降噪后落盘: noiseSuppression=", afterNs.processing?.noiseSuppression);

  // 结论
  const okFlag = afterFlag.processing?.echoCancellation === false;
  const okVol = afterVolume.micVolume === 1.5;
  const okNs = afterNs.processing?.noiseSuppression === false;
  console.log("\n=== 结论 ===");
  console.log("回声消除落盘:", okFlag ? "✅" : "❌");
  console.log("麦克风音量落盘:", okVol ? "✅" : "❌");
  console.log("降噪开关落盘:", okNs ? "✅" : "❌");
  console.log(okFlag && okVol && okNs ? "全部通过" : "有项目未通过");

  // 面板标签是否按真实回读显示
  const tagVisible = await evaluate(`(() => document.body.innerText.includes('重进生效'))()`);
  console.log("面板当前是否显示'重进生效':", tagVisible, "（假设备不支持实时改，显示属预期）");

  ws.close();
  child.kill();
  process.exit(okFlag && okVol && okNs ? 0 : 1);
}

main().catch((e) => {
  console.error("失败:", e.message);
  try { child.kill(); } catch {}
  process.exit(1);
});
