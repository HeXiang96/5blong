/** 截图：房间成员菜单（验证"加好友"按钮）。成员菜单夹具：/tests/fixtures/member-menu.html */
const PORT = 9223;
const BASE = process.env.APP_URL ?? "http://127.0.0.1:5178";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let seq = 1; const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = seq++; pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const { result: created } = await send("Target.createTarget", { url: `${BASE}/tests/fixtures/member-menu.html?anon=1` });
const { result: attached } = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
const sid = attached.sessionId;
await send("Runtime.enable", {}, sid);
await wait(4000);
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sid))
    .result?.result?.value;
// 点访客那只猪打开菜单
console.log("猪数量:", await evaluate(`document.querySelectorAll('.vx-pig-hit').length`));
await evaluate(`(() => {
  const pigs = document.querySelectorAll('.vx-pig-hit');
  pigs[pigs.length - 1]?.dispatchEvent(new MouseEvent('click', { clientX: 500, clientY: 400, bubbles: true }));
  return pigs.length;
})()`);
await wait(600);
console.log("菜单按钮:", await evaluate(`[...document.querySelectorAll('.vx-menu-btn')].map((b) => b.textContent.trim())`));
const shot = await send("Page.captureScreenshot", { format: "png" }, sid);
const fs = await import("node:fs");
fs.writeFileSync("outputs/member-menu-anon.png", Buffer.from(shot.result.data, "base64"));
console.log("saved outputs/member-menu-anon.png");
await send("Target.closeTarget", { targetId: created.targetId });
ws.close();
