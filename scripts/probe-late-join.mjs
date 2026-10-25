/**
 * 端到端验证：A 房主开共享 → 5 秒后 B 进房 → 看 B 有没有收到共享（video PC / <video>）。
 *
 * 用法：node scripts/probe-late-join.mjs
 * 前提：
 *   - dist-web 已构建并起静态服务（默认 http://127.0.0.1:5199）
 *   - Edge 带 --remote-debugging-port=9223、--auto-select-desktop-capture-source 等参数
 *
 * 这条脚本专门验证「开播后进房的人收不到共享」这个 bug。
 */
const PORT = 9223;
const APP = process.env.APP_URL ?? "http://127.0.0.1:5199/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vinfo = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(vinfo.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});

let seq = 1;
const pending = new Map();
ws.addEventListener("message", (evt) => {
  const msg = JSON.parse(evt.data);
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

const HOOK = `
  window.__pcs = [];
  const Orig = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Orig(...args);
    const rec = { kinds: [], pc };
    window.__pcs.push(rec);
    pc.addEventListener('track', (e) => rec.kinds.push(e.track.kind));
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
`;

async function openClient(label) {
  const { result } = await send("Target.createTarget", { url: "about:blank" });
  const targetId = result.targetId;
  const { result: attached } = await send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attached.sessionId;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK }, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  const evaluate = async (expression) => {
    const res = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    const details = res.result?.exceptionDetails;
    if (details) return { __error: details.exception?.description ?? details.text };
    return res.result?.result?.value;
  };
  await send("Page.navigate", { url: APP }, sessionId);
  await sleep(4000);
  return { label, targetId, sessionId, evaluate };
}

const clickText = (text) => `(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().includes('${text}'));
  btn?.click();
  return btn ? (btn.textContent || '').trim() : null;
})()`;

// ---------------------------------------------------------------- A：建房 + 开播
const A = await openClient("A");
console.log("A 建圈:", await A.evaluate(clickText("创建语音房")));
await sleep(6000);
const code = await A.evaluate(`document.querySelector('.vx-sign-code-value')?.textContent ?? null`);
console.log("A 房间码:", code);
if (!code) {
  console.log("A 没建起来，body:", (await A.evaluate("document.body.innerText.slice(0,200)")));
  process.exit(1);
}

// 点共享 → getDisplayMedia（Edge 已配 --auto-select-desktop-capture-source）
console.log("A 点共享:", await A.evaluate(clickText("共享")));
await sleep(800);
console.log(
  "A 点开始共享:",
  await A.evaluate(clickText("选择窗口开始共享")),
);
await sleep(6000);
console.log(
  "A 共享状态:",
  await A.evaluate(`({
    body: document.body.innerText.includes('停止共享') ? 'sharing' : 'not-sharing',
    notice: document.querySelector('.vx-notice')?.textContent ?? null,
  })`),
);

// ---------------------------------------------------------------- B：后进房
const B = await openClient("B");
await B.evaluate(`(() => {
  const input = document.querySelector('.vx-code-input');
  if (!input) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '${code}');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.vx-code-row button')?.click();
  return 'joined-attempt';
})()`);
await sleep(12000);

const bState = await B.evaluate(`(async () => {
  const videos = [...document.querySelectorAll('video')].map((v) => ({
    w: v.videoWidth, h: v.videoHeight, paused: v.paused,
  }));
  const pcs = [];
  for (const rec of window.__pcs || []) {
    pcs.push({ kinds: rec.kinds, state: rec.pc?.connectionState });
  }
  return {
    inRoom: !!document.querySelector('.vx-room'),
    tvLive: !!document.querySelector('.vx-tv-live'),
    videos,
    pcs,
  };
})()`);
console.log("B 结果:", JSON.stringify(bState, null, 2));

await send("Target.closeTarget", { targetId: A.targetId });
await send("Target.closeTarget", { targetId: B.targetId });
ws.close();
