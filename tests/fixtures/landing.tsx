/** 首页视觉回归夹具：直接渲染 LandingView，支持 ?theme=dark|light 与 ?empty=1（无上次房间）。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LandingView } from "../../src/client/voice/components/pages";
import "../../src/client/voice/styles.css";
// 首页用到木栅栏 / 场景层 / 猪圈：这几个 CSS 在 main.tsx 里是分开引入的，
// 夹具只引 styles.css 会让 PenFrame 渲染成一块黑（截图里那块就是它）。
import "../../src/client/voice/pen-scene.css";
import "../../src/client/voice/pen-life.css";
import "../../src/client/voice/pen-fence.css";
import "../../src/client/voice/pen-tv.css";
import "../../src/client/voice/pen-themes.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";

const identity = {
  personId: "9165556823",
  name: "爱笑的小鹿",
  avatar: "",
  color: "#b783d9",
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LandingView
      identity={identity}
      onIdentityChange={() => {}}
      onCreate={() => {}}
      onJoin={() => true}
      onSettings={() => {}}
      onCopyId={() => {}}
      lastRoom={params.get("empty") ? null : { code: "4821", role: "host", savedAt: Date.now() }}
      onResumeLastRoom={() => {}}
      onCreateGame={() => {}}
      onJoinGame={() => {}}
    />
  </StrictMode>,
);
