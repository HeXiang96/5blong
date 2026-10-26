/**
 * 验证「账号头像 + ID 入口 + 好友面板」三处 UI。
 * 用法：node scripts/verify-account-ui.mjs
 */
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
await send("Page.enable", {}, sid);
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sid))
    .result?.result?.value;
const shoot = async (file) => {
  const shot = await send("Page.captureScreenshot", { format: "png" }, sid);
  const fs = await import("node:fs");
  fs.writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  console.log("saved", file);
};

await wait(6000);
await evaluate(`[...document.querySelectorAll('button')].find((b) => /开始使用|知道了/.test(b.textContent || ''))?.click()`);
await wait(500);

// 登录（演示账号）
if (await evaluate(`!!document.querySelector('.vx-login-btn')`)) {
  await evaluate(`document.querySelector('.vx-login-btn').click()`);
  await wait(350);
  await evaluate(`(() => {
    const inputs = document.querySelectorAll('.vx-sheet-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inputs[0], 'duBu'); inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(inputs[1], '12345678'); inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.vx-sheet-actions button')].find((b) => b.textContent.trim() === '登录')?.click();
    return true;
  })()`);
  await wait(1400);
}
console.log("chip:", await evaluate(`({
  name: document.querySelector('.vx-id-name')?.textContent,
  hasIdBtn: !!document.querySelector('.vx-id-btn'),
  avatarImg: document.querySelector('.vx-id-chip img')?.getAttribute('src')?.slice(0, 30) ?? null,
})`));

// 塞一个头像 data URL，模拟"换头像"，刷新看 chip 是否跟着变
await evaluate(`(() => {
  const key = '5blong.accounts.v1';
  const data = JSON.parse(localStorage.getItem(key) || '{}');
  const id = Object.keys(data)[0];
  if (!id) return 'no-account';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#e2603c"/><circle cx="32" cy="26" r="12" fill="#ffe8c8"/><rect x="14" y="40" width="36" height="18" rx="9" fill="#ffe8c8"/></svg>';
  data[id].avatar = 'data:image/svg+xml;base64,' + btoa(svg);
  data[id].avatarVersion = (data[id].avatarVersion || 0) + 1;
  localStorage.setItem(key, JSON.stringify(data));
  return id;
})()`);
await evaluate(`location.reload()`);
await wait(4500);
console.log("刷新后 chip 头像:", await evaluate(`document.querySelector('.vx-id-chip img')?.getAttribute('src')?.slice(0, 40) ?? 'none'`));
await shoot("outputs/chip-with-avatar.png");

// 打开我的资料（点 ID 按钮）
await evaluate(`document.querySelector('.vx-id-btn')?.click()`);
await wait(600);
console.log("资料面板:", await evaluate(`(() => {
  const sheet = document.querySelector('.vx-sheet');
  return sheet ? sheet.innerText.replace(/\\n+/g, ' | ').slice(0, 120) : 'missing';
})()`));
await shoot("outputs/profile.png");

// 打开好友面板
await evaluate(`document.querySelector('.vx-sheet .vx-icon-btn')?.click()`);
await wait(300);
await evaluate(`document.querySelector('.vx-friends-btn')?.click()`);
await wait(700);
await shoot("outputs/friends-popover.png");

await send("Target.closeTarget", { targetId: created.targetId });
ws.close();
