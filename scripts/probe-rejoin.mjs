/**
 * 复现：A 建房 → B 进房（有声音）→ B 退出 → B 重进 → 检查 B 与 A 是否还有语音链路。
 *
 * 用法：node scripts/probe-rejoin.mjs
 * 前提：dist-web 在 http://127.0.0.1:5199；Edge 开着 9223。
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
  const m = JSON.parse(evt.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
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
  window.RTCPeerConnection = function (...a) {
    const pc = new Orig(...a);
    const rec = { kinds: [], pc };
    window.__pcs.push(rec);
    pc.addEventListener('track', (e) => rec.kinds.push(e.track.kind));
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
`;

async function client(label) {
  const { result } = await send("Target.createTarget", { url: "about:blank" });
  const targetId = result.targetId;
  const { result: at } = await send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = at.sessionId;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK }, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Page.navigate", { url: APP }, sessionId);
  await sleep(4000);
  const evaluate = async (expression) => {
    const r = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    return r.result?.result?.value ?? { __err: r.result?.exceptionDetails?.text };
  };
  const join = async (code) => {
    await evaluate(`(() => {
      const input = document.querySelector('.vx-code-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '${code}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.vx-code-row button')?.click();
      return true;
    })()`);
  };
  const state = async () =>
    evaluate(`({
      inRoom: !!document.querySelector('.vx-room'),
      landing: !!document.querySelector('.vx-landing'),
      audioPcs: (window.__pcs || []).filter((r) => r.kinds.includes('audio')).length,
      livePcs: (window.__pcs || []).filter((r) => r.pc.connectionState === 'connected' && r.kinds.includes('audio')).length,
      total: (window.__pcs || []).length,
      linkWarn: document.body.innerText.includes('语音链路连接中'),
      members: document.body.innerText.match(/(\\d+)\\/13/)?.[1] ?? null,
    })`);
  return { label, targetId, evaluate, join, state };
}

const A = await client("A");
await A.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent||'').includes('创建语音房'));
  b?.click(); return true;
})()`);
await sleep(6000);
const code = await A.evaluate(`document.querySelector('.vx-sign-code-value')?.textContent ?? null`);
console.log("房间码:", code);
if (!code) process.exit(1);

const B = await client("B");
await B.join(code);
await sleep(9000);
console.log("① B 首次进房:", JSON.stringify(await B.state()));

// B 退出
await B.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /离开|结束房间/.test(x.textContent||''));
  b?.click(); return b?.textContent?.trim() ?? null;
})()`);
await sleep(4000);
console.log("② B 已退出:", JSON.stringify(await B.state()));

// B 重进
await B.join(code);
await sleep(12000);
console.log("③ B 重进后:", JSON.stringify(await B.state()));

await send("Target.closeTarget", { targetId: A.targetId });
await send("Target.closeTarget", { targetId: B.targetId });
ws.close();
