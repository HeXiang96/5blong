/**
 * 冒烟：私密房（「我的房间」）的门禁是否真的拦得住。
 *
 * 跑的是**生产包**（dist-web）+ 本地账号适配器（`?local-account=1`，因为本地没有 /api/account）。
 *
 * 场景：
 *   A：登录 demo 账号 → 「认领我的房间」→ 拿到固定房号（私密）→ 开临时密码
 *   B（未登录访客）：
 *     ① 只输房号 → 必须被拒（页面提示要临时密码，并展开密码输入行）
 *     ② 输房号 + 临时密码 → 必须进房，A 的名册变成 2 人
 *
 * 用法：node scripts/probe-private-room.mjs
 * 前提：npx vite preview --outDir dist-web --port 5199 + Edge 9223
 */
const PORT = 9223;
const APP = process.env.APP_URL ?? "http://127.0.0.1:5199/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function openClient(url) {
  const { result } = await send("Target.createTarget", { url });
  const { result: attached } = await send("Target.attachToTarget", {
    targetId: result.targetId,
    flatten: true,
  });
  const sid = attached.sessionId;
  await send("Runtime.enable", {}, sid);
  await send("Page.enable", {}, sid);
  const evaluate = async (expression) =>
    (
      await send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        sid,
      )
    ).result?.result?.value;
  return { targetId: result.targetId, sid, evaluate };
}

const fail = (message) => {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
};

// ------------------------------------------------------------------ A：房主
const host = await openClient(`${APP}?local-account=1&account=demo`);
await sleep(3500);
// 种演示账号会刷新一次页面，等它稳定
await sleep(2500);

const loginState = await host.evaluate(`(async () => {
  if (!document.querySelector('.vx-login-btn')) return 'already';
  document.querySelector('.vx-login-btn').click();
  await new Promise((r) => setTimeout(r, 400));
  const inputs = [...document.querySelectorAll('.vx-modal input, .vx-auth input, input')];
  const user = inputs.find((i) => (i.placeholder || '').includes('字母开头')) ?? inputs[0];
  const pass = inputs.find((i) => i.type === 'password');
  if (!user || !pass) return 'no-form';
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setValue(user, 'duBu');
  setValue(pass, '12345678');
  await new Promise((r) => setTimeout(r, 200));
  // 只在账号面板里找提交按钮：顶栏那个「登录」按钮也是这三个字，点它只会把面板关掉
  const sheet = document.querySelector('.vx-sheet');
  if (!sheet) return 'no-sheet';
  const submit = [...sheet.querySelectorAll('button')].find((b) => b.textContent.trim() === '登录');
  if (!submit) return 'no-submit';
  submit.click();
  await new Promise((r) => setTimeout(r, 1500));
  // 登录成功：顶栏的「登录」按钮消失（换成账号胶囊）；面板可能还开着（我的资料）
  const stillLoggedOut = Boolean(document.querySelector('.vx-login-btn'));
  const signedIn = document.body.textContent.includes('独步吟客') || !stillLoggedOut;
  if (signedIn) {
    const close = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '关闭');
    close?.click();
    await new Promise((r) => setTimeout(r, 300));
  }
  return signedIn ? 'ok' : 'failed';
})()`);
console.log('A 登录:', loginState);
if (loginState !== 'ok' && loginState !== 'already') fail(`房主登录失败：${loginState}`);
await sleep(800);

// 认领 / 开自己的房间（私密房）
const claimed = await host.evaluate(`(async () => {
  const btn = [...document.querySelectorAll('button')].find((b) => /我的房间|认领我的房间/.test(b.textContent));
  if (!btn) return 'no-button';
  btn.click();
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (document.querySelector('.vx-sign-code-value')) break;
  }
  const code = document.querySelector('.vx-sign-code-value')?.textContent?.trim() ?? '';
  return code;
})()`);
console.log('A 房号:', claimed);
if (!claimed || claimed.length < 4) fail('房主没能开起「我的房间」');

// 生成临时密码（钥匙入口 → 生成密码），读出密码
await sleep(600);
const pass = await host.evaluate(`(async () => {
  const key = [...document.querySelectorAll('.vx-sign-friends')].find((b) => /密码|私密/.test(b.textContent));
  if (!key) return 'no-key-btn';
  key.click();
  await new Promise((r) => setTimeout(r, 300));
  const panel = document.querySelector('.vx-pass-panel');
  if (!panel) return 'no-panel';
  let value = panel.querySelector('.vx-pass-value')?.textContent?.trim() ?? '';
  if (!value) {
    const gen = [...panel.querySelectorAll('button')].find((b) => /生成密码|换一个/.test(b.textContent));
    gen?.click();
    await new Promise((r) => setTimeout(r, 400));
    value = document.querySelector('.vx-pass-value')?.textContent?.trim() ?? '';
  }
  return value;
})()`);
console.log('A 临时密码:', pass);
if (!/^\d{6}$/.test(String(pass))) fail(`没拿到 6 位临时密码：${pass}`);

// ------------------------------------------------------------------ B：访客
const guest = await openClient(APP);
await sleep(3000);

const tryCode = (code, extra) => `(async () => {
  const input = document.querySelector('.vx-code-input');
  if (!input) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(code)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  ${extra ?? ''}
  const joinBtn = [...document.querySelectorAll('button')].find((b) => /^(加入|带密码进)$/.test(b.textContent.trim()));
  if (!joinBtn) return 'no-join-button';
  joinBtn.click();
  /*
   * 私密房的拒绝要等 P2P 数据通道建起来才收得到（房主先要握手），
   * 加上引擎的自动重拨，短等 2.5 秒只能看到"还在连"。这里轮询到有结论为止。
   */
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    const inRoom = Boolean(document.querySelector('.vx-stage'));
    const passRow = Boolean(document.querySelector('.vx-pass-row'));
    const ended = Boolean(document.querySelector('.vx-overlay-card, .vx-summary'));
    if (inRoom || passRow) break;
    if (ended && i > 6) break;
  }
  const errorText =
    document.querySelector('.vx-channel-error')?.textContent?.trim() ??
    document.querySelector('.vx-overlay-card')?.textContent?.trim() ??
    '';
  return {
    inRoom: Boolean(document.querySelector('.vx-stage')),
    error: errorText,
    passRow: Boolean(document.querySelector('.vx-pass-row')),
    members: document.querySelector('.vx-sign-count')?.textContent?.trim() ?? '',
  };
})()`;

const rejected = await guest.evaluate(tryCode(claimed));
console.log('B 只输房号:', JSON.stringify(rejected));
if (rejected?.inRoom) fail('私密房被裸码进了（门禁失效）');
if (!rejected?.passRow) fail('被拒后没有展开临时密码输入行');

await sleep(600);
const entered = await guest.evaluate(
  tryCode(
    claimed,
    `const passInput = document.querySelector('.vx-pass-input');
     if (passInput) {
       const setter2 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
       setter2.call(passInput, ${JSON.stringify(String(pass))});
       passInput.dispatchEvent(new Event('input', { bubbles: true }));
       await new Promise((r) => setTimeout(r, 150));
     }`,
  ),
);
console.log('B 房号+密码:', JSON.stringify(entered));
if (!entered?.inRoom) fail('带正确临时密码仍进不去');

await sleep(1200);
const hostMembers = await host.evaluate(
  `document.querySelector('.vx-sign-count')?.textContent?.trim() ?? ''`,
);
console.log('A 名册:', hostMembers);
if (!hostMembers.includes("2/")) fail(`房主名册不是 2 人：${hostMembers}`);

await send("Target.closeTarget", { targetId: host.targetId });
await send("Target.closeTarget", { targetId: guest.targetId });
ws.close();
if (!process.exitCode) console.log('✅ 私密房门禁冒烟通过');
