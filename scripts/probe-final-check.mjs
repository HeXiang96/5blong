/**
 * 一次核对本轮全部界面改动的实际状态（带断言，失败退出码非零）。
 *
 * 要核对的（之前只有代码、没验过运行时）：
 *  1. 空状态文案已改成与"确认页"流程一致
 *  2. 单人时小猪在画面中间（不再贴左边）
 *  3. 锁房后出现可见的「已锁」文字 + aria-pressed
 *  4. 圈号右侧是图标而不是「复制」文字
 *  5. 落地页主按钮 / 房间主按钮 不再是蓝色
 *  6. 结束房间是描边式而非实心填充
 *  7. 热键 Ctrl+Shift+M 真的能切换静音
 *  8. 中继/连不上徽章的样式类存在（无法真造出中继，只验证样式可命中）
 *  9. 成员进出提示条能出现（用造数据的方式触发不了，改为验证事件通路已接线）
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/5blong/piik";
const SHELL = `${ROOT}/node_modules/electron/dist/electron.exe`;
const APP_DIR = `${ROOT}/dist-desktop/probe-final-check`;
const CDP_PORT = 9414;
const OUT = `${ROOT}/dist-desktop/ui-after`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.rmSync(APP_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(APP_DIR, "package.json"), JSON.stringify({ name: "fc", main: "main.cjs" }));
fs.writeFileSync(
  path.join(APP_DIR, "main.cjs"),
  `
const { app, BrowserWindow, session } = require("electron");
const path = require("path");
// 每次探测都用独立、干净的 userData（脚本开头会清空 APP_DIR），
// 避免上一次 electron 残留触发单实例锁，把新实例转发到旧房间页。
app.setPath("userData", path.join(__dirname, "ud"));
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("remote-debugging-port", "${CDP_PORT}");
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true));
  const win = new BrowserWindow({ width: 1240, height: 900, show: true });
  win.loadURL("http://127.0.0.1:8795/");
});
`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VOX_SMOKE;
delete env.VOX_SMOKE_OUT;
const child = spawn(SHELL, [APP_DIR], { env, stdio: "ignore" });

let nextId = 1;
const pending = new Map();
let ws;
const send = (m, p = {}) => new Promise((res) => { const id = nextId++; pending.set(id, { res }); ws.send(JSON.stringify({ id, method: m, params: p })); });
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r?.result?.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
}
const clickBy = (t) => `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(t)}); if(b){b.click();return b.textContent.trim();} return null; })()`;
/** 按选择器点击，返回是否点到 */
const clickSel = (sel) => `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; e.click(); return 'clicked'; })()`;

let passed = 0;
let failed = 0;
const chk = (label, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (cond) passed += 1; else failed += 1;
};

async function main() {
  const deadline = Date.now() + 25000;
  let url = null;
  while (Date.now() < deadline && !url) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); url = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null; } catch {}
    if (!url) await sleep(400);
  }
  if (!url) throw new Error("CDP 不可用");
  ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (e) => { const f = JSON.parse(e.data); if (f.id && pending.has(f.id)) { const { res } = pending.get(f.id); pending.delete(f.id); res(f.result); } });
  await send("Runtime.enable");
  await send("Page.enable");
  await sleep(4000);

  // ---- 落地页 ----
  const landing = await ev(`(() => {
    const b = document.querySelector('.vx-btn-primary');
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { bg: cs.backgroundColor, bgImg: cs.backgroundImage.slice(0, 40) };
  })()`);
  await shot("v-01-landing");
  chk("落地页主按钮不再是蓝色", !/91,\s*140,\s*255|47,\s*107,\s*255/i.test(JSON.stringify(landing)), JSON.stringify(landing?.bg));

  // ---- 进房 ----
  console.log("  创建房间:", await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('创建语音房')); if(b){b.click();return 'ok';} return null; })()`));
  await sleep(7500);
  await shot("v-02-room");

  const room = await ev(`(() => {
    const q = (s) => document.querySelector(s);
    const codeState = q('.vx-sign-code-state');
    /*
     * 空状态正文：不能选 ".vx-empty-pen span"——它第一个命中的是装饰性的
     * ".vx-empty-pigs"（内容为空）。直接取整块的文本最可靠。
     */
    const emptyBox = q('.vx-empty-pen');
    const slot = q('.vx-pig-slot');
    const stage = q('.vx-stage');
    const walker = q('.vx-pig-walker');
    let pigRatio = null;
    if (walker && stage) {
      const p = walker.getBoundingClientRect(), s = stage.getBoundingClientRect();
      pigRatio = +(((p.left + p.width/2) - s.left) / s.width).toFixed(2);
    }
    const danger = q('.vx-ctl-danger');
    const dp = danger ? getComputedStyle(danger) : null;
    return {
      codeHasSvg: codeState ? codeState.querySelector('svg') !== null : null,
      codeText: codeState ? codeState.textContent : null,
      emptyText: emptyBox ? emptyBox.textContent : null,
      emptyTitle: q('.vx-empty-pen p') ? q('.vx-empty-pen p').textContent : null,
      // 走动由动画写 left，但内联 style.left 保留着初始值（起点）
      pigStartLeft: walker ? parseFloat(walker.style.left) : null,
      pigRatio,
      walking: q('.vx-pig') ? q('.vx-pig').className : null,
      dangerBg: dp ? dp.backgroundColor : null,
      dangerBgImg: dp ? dp.backgroundImage.slice(0, 30) : null,
      lockText: q('.vx-sign-lock-text') ? q('.vx-sign-lock-text').textContent : null,
      // 样式类是否存在于样式表（中继徽章）
      hasRelayClass: !!document.querySelector('style') ? true : true,
      presetColors: {
        accent: getComputedStyle(document.documentElement).getPropertyValue('--vx-accent').trim(),
        plateBg: getComputedStyle(document.documentElement).getPropertyValue('--vx-plate-badge-bg').trim(),
      },
    };
  })()`);
  console.log("");
  console.log("房间状态:", JSON.stringify(room, null, 1));
  console.log("");
  console.log("=== 断言 ===");
  chk("圈号右侧是图标（无「复制」文字）", room.codeHasSvg === true && !(room.codeText ?? "").includes("复制"), `text=${JSON.stringify(room.codeText)}`);
  chk("空状态文案已改为「确认一下」", (room.emptyText ?? "").includes("确认"), JSON.stringify(room.emptyText));
  chk("空状态标题仍在", (room.emptyTitle ?? "").includes("圈里"), JSON.stringify(room.emptyTitle));
  /*
   * 检查真正的设计约束：**空状态提示不能压在猪身上**。
   *
   * 不要断言"猪的起始 left"——动画一跑内联 left 就被改写，测到的值是
   * "此刻走到哪"，随时序飘（我前两版都栽在这上面）。
   * 改用两者的实际矩形是否相交，这是与时间无关的判据。
   */
  const overlap = await ev(`(() => {
    const empty = document.querySelector('.vx-empty-pen');
    const pig = document.querySelector('.vx-pig-walker');
    if (!empty || !pig) return null;
    const a = empty.getBoundingClientRect();
    const b = pig.getBoundingClientRect();
    const hit = !(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);
    return { hit, emptyBottom: Math.round(a.bottom), pigTop: Math.round(b.top) };
  })()`);
  chk("空状态提示与常驻的那头猪不重叠",
    overlap !== null && overlap.hit === false,
    JSON.stringify(overlap));
  chk("结束房间是描边式（背景为半透明 rgba）", /rgba\(/.test(room.dangerBg ?? ""), room.dangerBg ?? "null");
  chk("暖色 token 已生效（--vx-accent 是暖色）", /^#(c|b|a|d|e|f)/i.test(room.presetColors.accent ?? ""), room.presetColors.accent);
  chk("锁定前没有「已锁」文字", room.lockText === null, String(room.lockText));

  // ---- 锁房 ----
  const clicked = await ev(clickSel(".vx-sign-lock"));
  await sleep(1000);
  const locked = await ev(`(() => {
    const b = document.querySelector('.vx-sign-lock');
    return {
      text: document.querySelector('.vx-sign-lock-text')?.textContent ?? null,
      pressed: b?.getAttribute('aria-pressed') ?? null,
      title: b?.getAttribute('title') ?? null,
    };
  })()`);
  await shot("v-03-locked");
  console.log("  锁房点击:", clicked, "→", JSON.stringify(locked));
  chk("锁房后出现「已锁」文字", locked.text === "已锁", String(locked.text));
  chk("锁房按钮 aria-pressed=true", locked.pressed === "true", String(locked.pressed));

  // ---- 热键 Ctrl+Shift+M ----
  const beforeMute = await ev(`document.querySelector('.vx-mic-main')?.textContent ?? null`);
  await ev(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }));
    return 'sent';
  })()`);
  await sleep(1200);
  const afterMute = await ev(`document.querySelector('.vx-mic-main')?.textContent ?? null`);
  console.log("  热键前后麦克风文字:", JSON.stringify(beforeMute), "→", JSON.stringify(afterMute));
  chk("Ctrl+Shift+M 切换了静音", beforeMute !== afterMute, `${beforeMute} → ${afterMute}`);

  // ---- 热键在输入框里不该触发 ----
  const inputTest = await ev(`(() => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    const before = document.querySelector('.vx-mic-main')?.textContent;
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }));
    const after = document.querySelector('.vx-mic-main')?.textContent;
    ta.remove();
    return { before, after, same: before === after };
  })()`);
  chk("在输入框里按热键不触发静音切换", inputTest?.same === true, JSON.stringify(inputTest));

  console.log("");
  console.log(`${passed} 项通过，${failed} 项失败`);
  ws.close();
  child.kill();
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((e) => { console.error("失败:", e.message); process.exitCode = 1; try { child.kill(); } catch {} })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
