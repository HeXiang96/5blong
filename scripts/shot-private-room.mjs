/**
 * 截图：私密房「临时密码」浮层在各主题下的样子。
 *
 * 业主交代过：新增 UI 必须每套主题都适配。这个脚本一次跑完
 * 浅色 / 深色 / 浅色夜晚 / 雪原(日,夜) / 万圣夜 / 春节，全部落到 outputs/private-room-*.png。
 *
 * 依赖：vite（默认 8787）+ Edge headless 的 CDP（9223）
 *   npx vite --port 8787 --host 127.0.0.1
 *   msedge --headless=new --remote-debugging-port=9223 --remote-allow-origins=* --user-data-dir=<临时目录>
 */
import { mkdirSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.CDP_PORT ?? 9223);
const BASE = process.env.APP_URL ?? "http://127.0.0.1:8787";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const versions = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(versions.webSocketDebuggerUrl);
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
  url: `${BASE}/tests/fixtures/member-menu.html?pass=1`,
});
const { result: attached } = await send("Target.attachToTarget", {
  targetId: created.targetId,
  flatten: true,
});
const sid = attached.sessionId;
await send("Runtime.enable", {}, sid);
await wait(3500);

const evaluate = async (expression) =>
  (
    await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sid,
    )
  ).result?.result?.value;

const themes = [
  { name: "light", theme: "light", scene: "", daypart: "" },
  { name: "dark", theme: "dark", scene: "", daypart: "" },
  { name: "light-night", theme: "light", scene: "", daypart: "night" },
  { name: "snow-day", theme: "light", scene: "snow", daypart: "day" },
  { name: "snow-night", theme: "light", scene: "snow", daypart: "night" },
  { name: "halloween", theme: "dark", scene: "halloween", daypart: "night" },
  { name: "spring", theme: "dark", scene: "spring", daypart: "night" },
];

mkdirSync("outputs", { recursive: true });
for (const item of themes) {
  await evaluate(`(() => {
    const root = document.documentElement;
    root.dataset.theme = ${JSON.stringify(item.theme)};
    root.dataset.scene = ${JSON.stringify(item.scene)};
    root.dataset.daypart = ${JSON.stringify(item.daypart)};
    // 每次都要重新点开（切主题不影响开合，这里统一关一下再点，保证是同一状态）
    const btn = [...document.querySelectorAll('.vx-sign-friends')].find((b) => b.textContent.includes('密码') || b.textContent.includes('私密'));
    if (!btn) return 'no-button';
    if (!document.querySelector('.vx-pass-panel')) btn.click();
    return document.querySelector('.vx-pass-panel') ? 'open' : 'closed';
  })()`);
  await wait(260);
  const shot = await send("Page.captureScreenshot", { format: "png" }, sid);
  const file = `outputs/private-room-${item.name}.png`;
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  console.log("saved", file);
}

await evaluate(`document.querySelector('.vx-pass-panel .vx-pass-close')?.click()`);
await send("Target.closeTarget", { targetId: created.targetId });
ws.close();
