/**
 * 探针：无头进房 → 看共享流到底有没有音轨、有没有声音。
 *
 * 用法：node scripts/probe-room-audio.mjs 2354
 * 依赖：Edge（--remote-debugging-port），Node 22 自带 WebSocket / fetch。
 *
 * 判定只看两件事：
 *   1. 远端共享流里有没有 audio track；
 *   2. 那个 track 的实际振幅（peak）是不是 0。
 */
const CODE = process.argv[2] ?? "2354";
const PORT = 9223;
const URL_BASE = process.env.APP_URL ?? "https://5blong.pages.dev";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(targets.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

const consoleLines = [];
const netLines = [];
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args || [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
      .join(" ")
      .slice(0, 300);
    consoleLines.push(`[${msg.params.type}] ${text}`);
  }
  if (msg.method === "Network.requestWillBeSent" && /\/sfu\/|\/ice|peerjs/.test(msg.params.request.url)) {
    netLines.push(`→ ${msg.params.request.method} ${msg.params.request.url.slice(0, 130)}`);
  }
  if (msg.method === "Network.responseReceived" && /\/sfu\/|\/ice/.test(msg.params.response.url)) {
    netLines.push(`← ${msg.params.response.status} ${msg.params.response.url.slice(0, 130)}`);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    consoleLines.push(`[exception] ${d.exception?.description ?? d.text} ${d.url ?? ""}:${d.lineNumber ?? ""}`);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { result: created } = await send("Target.createTarget", { url: "about:blank" });
const targetId = created.targetId;
const { result: attached } = await send("Target.attachToTarget", { targetId, flatten: true });
const sessionId = attached.sessionId;

const evaluate = async (expression, awaitPromise = true) => {
  const res = await send(
    "Runtime.evaluate",
    { expression, awaitPromise, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (res.result?.exceptionDetails) {
    return { error: res.result.exceptionDetails.exception?.description ?? "eval error" };
  }
  return res.result?.result?.value;
};

const hook = `
  window.__pcs = [];
  const Orig = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Orig(...args);
    const rec = { index: window.__pcs.length, kinds: [], states: [], pc };
    window.__pcs.push(rec);
    pc.addEventListener('track', (event) => {
      rec.kinds.push(event.track.kind + ':' + (event.streams?.[0]?.id?.slice(0, 6) ?? 'nostream'));
    });
    pc.addEventListener('connectionstatechange', () => {
      rec.states.push(pc.connectionState);
    });
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
`;
await send("Page.addScriptToEvaluateOnNewDocument", { source: hook }, sessionId);
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Network.enable", {}, sessionId);
await send("Page.navigate", { url: `${URL_BASE}/#c=${CODE}` }, sessionId);
await sleep(6000);

// 确认页 → 静音加入
console.log("step1 页面:", await evaluate(`({
  url: location.href,
  title: document.title,
  primary: document.querySelector('.vx-btn-primary')?.textContent?.trim() ?? null,
  body: document.body.innerText.slice(0, 120),
})`));

// 首页内联房间码 → 填 4 位 → 点「加入」（React 受控输入要用原生 setter 才生效）
console.log("step1b 填码:", await evaluate(`(() => {
  const input = document.querySelector('.vx-code-input');
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '${CODE}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const btn = document.querySelector('.vx-code-row button');
  btn?.click();
  return { filled: input?.value ?? null, clicked: btn?.textContent?.trim() ?? null };
})()`));
await sleep(1500);
// 若落到确认页，点主按钮
console.log("step1c 确认页:", await evaluate(`(() => {
  const btn = document.querySelector('.vx-btn-primary.vx-btn-wide');
  if (!btn) return null;
  btn.click();
  return btn.textContent?.trim() ?? null;
})()`));

for (let i = 0; i < 10; i += 1) {
  await sleep(2000);
  const state = await evaluate(`({
    inRoom: !!document.querySelector('.vx-room'),
    tv: !!document.querySelector('.vx-tv, .vx-stage video'),
    videos: [...document.querySelectorAll('video')].map((v) => ({
      w: v.videoWidth, h: v.videoHeight, paused: v.paused, muted: v.muted,
      audio: v.srcObject ? v.srcObject.getAudioTracks().length : -1,
      video: v.srcObject ? v.srcObject.getVideoTracks().length : -1,
    })),
    notice: document.querySelector('.vx-notice, .vx-toast')?.textContent ?? null,
  })`);
  console.log(`step2 第 ${i + 1} 次:`, JSON.stringify(state));
  if (state?.videos?.some((v) => v.video > 0)) break;
}

// 关键测量：远端共享流的音轨振幅
const measured = await evaluate(`(async () => {
  const v = [...document.querySelectorAll('video')].find((x) => x.srcObject);
  if (!v) return { error: '没有带 srcObject 的 video（共享没到）' };
  const stream = v.srcObject;
  const audio = stream.getAudioTracks().map((t) => ({
    label: t.label, muted: t.muted, enabled: t.enabled, readyState: t.readyState,
  }));
  if (audio.length === 0) return { audio: [], note: '共享流里没有音轨' };
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let peak = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 3000) {
    analyser.getFloatTimeDomainData(buf);
    for (let i = 0; i < buf.length; i += 1) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { audio, peak, ctx: ctx.state, videoMuted: v.muted, videoVolume: v.volume };
})()`);
console.log("step3 振幅测量:", JSON.stringify(measured, null, 2));

// 共享到底到没到：把电视区域和全局调试句柄都打出来
const dump = await evaluate(`(() => {
  const tv = document.querySelector('.vx-tv');
  const room = document.querySelector('.vx-room');
  return {
    tvHtml: tv ? tv.outerHTML.slice(0, 500) : null,
    videoCount: document.querySelectorAll('video').length,
    audioCount: document.querySelectorAll('audio').length,
    roomText: room ? room.innerText.slice(0, 300) : null,
    globals: Object.keys(window).filter((k) => /^(__|voice|game)/i.test(k)).slice(0, 12),
  };
})()`);
console.log("step4 DOM:", JSON.stringify(dump, null, 2));
console.log("step5 控制台:", JSON.stringify(consoleLines.slice(-15), null, 2));
console.log("step6 网络:", JSON.stringify(netLines.slice(-20), null, 2));

// 每个 PC 的实况：建了几条、收到的轨道、入向字节数
const pcs = await evaluate(`(async () => {
  const out = [];
  for (const rec of window.__pcs || []) {
    const entry = { i: rec.index, kinds: rec.kinds, state: rec.pc?.connectionState, inbound: [] };
    try {
      const stats = await rec.pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp') {
          entry.inbound.push({ kind: r.kind || r.mediaType, bytes: r.bytesReceived, packets: r.packetsReceived });
        }
      });
    } catch (error) {
      entry.statsError = String(error);
    }
    out.push(entry);
  }
  return out;
})()`);
console.log("step7 PeerConnection:", JSON.stringify(pcs, null, 2));

await send("Target.closeTarget", { targetId });
ws.close();
