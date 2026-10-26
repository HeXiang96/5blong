/**
 * 复现：房间里点开「灯箱」（放大共享画面）是不是会白屏。
 *
 * 用法：node scripts/probe-tv-lightbox.mjs
 * 前提：vite 起在 8787（夹具 member-menu.html 支持 ?tv=1 模拟"有人在共享"）+ Edge 9223。
 *
 * 关键点：在页面加载**之前**注入错误钩子，这样渲染期抛的异常能被抓到，
 * 而不是只看到一片白。
 */
const CDP = Number(process.env.CDP_PORT ?? 9223);
const BASE = process.env.APP_URL ?? "http://127.0.0.1:8787";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const version = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let seq = 1;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const detail = msg.params?.exceptionDetails;
    errors.push(detail?.exception?.description ?? detail?.text ?? "unknown");
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
    errors.push(
      (msg.params.args ?? [])
        .map((arg) => arg.description ?? arg.value ?? "")
        .join(" ")
        .slice(0, 400),
    );
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = seq++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { result: created } = await send("Target.createTarget", {
  url: `${BASE}/tests/fixtures/member-menu.html?tv=1`,
});
const { result: attached } = await send("Target.attachToTarget", {
  targetId: created.targetId,
  flatten: true,
});
const sid = attached.sessionId;
await send("Runtime.enable", {}, sid);
await send("Log.enable", {}, sid).catch(() => {});
const evaluate = async (expression) =>
  (
    await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sid,
    )
  ).result?.result?.value;

await wait(3500);

// 夹具里幕布/电视的元素名（见 PenTV.tsx）
console.log("幕布元素:", await evaluate(`document.querySelectorAll('.vx-tv-screen, .vx-tv, .vx-screen').length`));
console.log("点击前节点数:", await evaluate(`document.querySelectorAll('*').length`));

const clicked = await evaluate(`(() => {
  const target = document.querySelector('.vx-tv-screen') ?? document.querySelector('.vx-tv');
  if (!target) return 'no-tv';
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 500, clientY: 300 }));
  return 'clicked';
})()`);
console.log("点击:", clicked);
await wait(1200);

console.log("灯箱是否存在:", await evaluate(`Boolean(document.querySelector('.vx-tv-lightbox'))`));
console.log("点击后节点数:", await evaluate(`document.querySelectorAll('*').length`));
console.log("body 文本长度:", await evaluate(`document.body.textContent.trim().length`));

const shot = await send("Page.captureScreenshot", { format: "png" }, sid);
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync("outputs", { recursive: true });
writeFileSync("outputs/tv-lightbox.png", Buffer.from(shot.result.data, "base64"));
console.log("截图: outputs/tv-lightbox.png");
console.log("捕获到的错误:", errors.length ? JSON.stringify(errors.slice(0, 3), null, 2) : "（无）");

await send("Target.closeTarget", { targetId: created.targetId });
ws.close();
