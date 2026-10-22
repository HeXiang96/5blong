/** 首页视觉回归夹具：直接渲染 LandingView，支持 ?theme=dark|light 与 ?empty=1（无上次房间）。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LandingView } from "../../src/client/voice/components/pages";
import "../../src/client/voice/styles.css";

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
