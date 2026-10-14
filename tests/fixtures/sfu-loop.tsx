/**
 * SFU 全链路回环验证（本地浏览器回归，不碰语音/信令）：
 *
 *   canvas 演示流 → publishScreen（Realtime SFU）→ subscribeScreen 回拉
 *   → 校验收到的视频帧确实有像素变化 → window.__sfuLoop = "ok"
 *
 * 需要先启动 scripts/dev-sfu-server.mjs（vite 已把 /sfu 代理过去）。
 * 打开 /tests/fixtures/sfu-loop.html，几秒后读 window.__sfuLoop。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import {
  createDemoStream,
  publishScreen,
  subscribeScreen,
} from "../../src/client/voice/screen-share";

declare global {
  interface Window {
    __sfuLoop?: string;
  }
}

async function run(): Promise<string> {
  const stream = createDemoStream();
  if (!stream) return "fail: no demo stream";

  const pub = await publishScreen(stream, "fhd1080");
  const sub = await subscribeScreen(pub.sessionId, ["screen"]);

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = sub.stream;
  document.getElementById("root")!.appendChild(video);
  await video.play();

  // 等画面真正渲染出来（最长 8s），然后采两帧比较像素
  const sample = (): number => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0, 160, 90);
    const data = ctx.getImageData(0, 0, 160, 90).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i]! + data[i + 1]! + data[i + 2]!;
    return sum;
  };

  const deadline = Date.now() + 8000;
  while (video.readyState < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const a = sample();
  await new Promise((resolve) => setTimeout(resolve, 700));
  const b = sample();
  sub.stop();
  pub.stop();

  if (a === 0 && b === 0) return "fail: 收到的画面全黑";
  if (a === b) return "fail: 画面静止（两帧相同，疑似未真的收到流）";
  return `ok: 帧像素和 ${a} -> ${b}（画面在动）`;
}

window.__sfuLoop = "running";
run().then(
  (result) => {
    window.__sfuLoop = result;
    document.getElementById("root")!.textContent = result;
  },
  (error) => {
    window.__sfuLoop = `fail: ${String(error)}`;
    document.getElementById("root")!.textContent = window.__sfuLoop;
  },
);

createRoot(document.getElementById("root")!).render(<StrictMode>{null}</StrictMode>);
