/** 验证：登录弹窗点外面不再关闭，输入保留；Esc 才关。 */
const PORT = 9223;
const BASE = process.env.APP_URL ?? "http://127.0.0.1:5178";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let seq = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = seq++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { result: created } = await send("Target.createTarget", { url: `${BASE}/?account=demo` });
const { result: attached } = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
const sid = attached.sessionId;
await send("Runtime.enable", {}, sid);
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sid))
    .result?.result?.value;

await wait(6000);
await evaluate(`[...document.querySelectorAll('button')].find((b) => /开始使用|知道了/.test(b.textContent || ''))?.click()`);
await wait(400);
await evaluate(`document.querySelector('.vx-login-btn')?.click()`);
await wait(400);
await evaluate(`(() => {
  const input = document.querySelectorAll('.vx-sheet-input')[0];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'half-typed-name');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);
// 点背景（弹窗外、页面中央偏上）
await send(
  "Input.dispatchMouseEvent",
  { type: "mousePressed", x: 300, y: 120, button: "left", clickCount: 1 },
  sid,
);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 300, y: 120, button: "left" }, sid);
await wait(400);
console.log("点外面后:", await evaluate(`({
  open: !!document.querySelector('.vx-sheet'),
  value: document.querySelector('.vx-sheet-input')?.value ?? null,
})`));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sid);
await wait(400);
console.log("按 Esc 后:", await evaluate(`!!document.querySelector('.vx-sheet')`));

await send("Target.closeTarget", { targetId: created.targetId });
ws.close();
