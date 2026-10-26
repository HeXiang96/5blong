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
const send = (m, p = {}, s) => new Promise((res) => {
  const id = seq++; pending.set(id, res);
  ws.send(JSON.stringify({ id, method: m, params: p, ...(s ? { sessionId: s } : {}) }));
});
const { result: created } = await send("Target.createTarget", { url: `${BASE}/tests/fixtures/friend-toast.html` });
const { result: attached } = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
const sid = attached.sessionId;
await send("Runtime.enable", {}, sid);
await wait(3000);
const shot = await send("Page.captureScreenshot", { format: "png" }, sid);
const fs = await import("node:fs");
fs.writeFileSync("outputs/friend-toast.png", Buffer.from(shot.result.data, "base64"));
console.log("saved outputs/friend-toast.png");
await send("Target.closeTarget", { targetId: created.targetId });
ws.close();
