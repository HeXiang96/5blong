/**
 * 截图工具：登录演示账号 → 打开好友面板 → 存 PNG（供人工看 UI）。
 *
 * 用法：node scripts/shot-friends.mjs [输出路径]
 * 前提：dev server 在 5178、Edge 开着 9223。
 */
const OUT = process.argv[2] ?? "outputs/friends.png";
const PORT = 9223;
const URL_BASE = process.env.APP_URL ?? "http://127.0.0.1:5178";

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

const { result: created } = await send("Target.createTarget", {
  url: `${URL_BASE}/?account=demo`,
});
const { result: attached } = await send("Target.attachToTarget", {
  targetId: created.targetId,
  flatten: true,
});
const sid = attached.sessionId;
await send("Runtime.enable", {}, sid);
await send("Page.enable", {}, sid);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sid))
    .result?.result?.value;

await wait(6000);
// 1) 关掉首次引导
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /开始使用|知道了/.test(b.textContent || ''));
  btn?.click();
  return !!btn;
})()`);
await wait(600);
// 2) 登录演示账号
if (await evaluate(`!!document.querySelector('.vx-login-btn')`)) {
  await evaluate(`document.querySelector('.vx-login-btn')?.click()`);
  await wait(400);
  await evaluate(`(() => {
    const inputs = document.querySelectorAll('.vx-sheet-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inputs[0], 'duBu'); inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(inputs[1], '12345678'); inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.vx-sheet-actions button')].find((b) => b.textContent.trim() === '登录')?.click();
    return true;
  })()`);
  await wait(1200);
}
// 3) 打开好友面板
await evaluate(`document.querySelector('.vx-friends-btn')?.click()`);
await wait(700);

const shot = await send("Page.captureScreenshot", { format: "png" }, sid);
if (!shot.result?.data) {
  console.log("截图失败：", JSON.stringify(shot.error ?? shot.result));
} else {
  const fs = await import("node:fs");
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
  console.log("已保存", OUT);
}
await send("Target.closeTarget", { targetId: created.targetId });
ws.close();
