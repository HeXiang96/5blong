/**
 * 开黑圈「加入」弹窗的视觉/状态回归夹具。
 *
 * 用法：/tests/fixtures/game-join.html?code=829417&fill=1&theme=light|dark
 *   - 带 code：模拟点邀请链接进来（房间码已知，输入框隐藏）；
 *   - fill=1：把房间码与游戏 ID 都填满，验证「进圈」按钮会不会亮
 *     （房码 6 位那次漏改，这里按钮一直是灰的，肉眼看不出来是"还没填"还是"填了也不认"）。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { GameJoinDialog } from "../../src/client/game/GameRoomView";
import "../../src/client/voice/styles.css";
import "../../src/client/voice/account.css";
import "../../src/client/voice/pen-scene.css";
import "../../src/client/voice/pen-life.css";
import "../../src/client/voice/pen-fence.css";
import "../../src/client/voice/pen-tv.css";
import "../../src/client/voice/pen-themes.css";
import "../../src/client/game/game-theme.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const scene = params.get("scene");
if (scene) document.documentElement.dataset.scene = scene;
const daypart = params.get("daypart");
if (daypart) document.documentElement.dataset.daypart = daypart;

const code = params.get("code");

/** React 受控输入不接受直接赋 value，必须走原生 setter 再派发 input。 */
function fill(index: number, value: string): void {
  const input = document.querySelectorAll<HTMLInputElement>(".vx-game-modal .vx-input")[index];
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GameJoinDialog code={code} busy={false} error={null} onCancel={() => {}} onJoin={() => {}} />
  </StrictMode>,
);

if (params.get("fill") === "1") {
  window.setTimeout(() => {
    if (!code) fill(0, "829417"); // 6 位新码：以前这里最多只能输 4 位
    fill(code ? 0 : 1, "夜里看江南#8294");
  }, 120);
}
