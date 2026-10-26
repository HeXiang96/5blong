/** 首页视觉回归夹具：直接渲染 LandingView，支持 ?theme=dark|light、?scene=snow|halloween、?daypart=morning|day|dusk|night 与 ?empty=1（无上次房间）。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LandingView } from "../../src/client/voice/components/pages";
import type { SceneThemeId } from "../../src/client/voice/scene-theme";
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
// 场景主题 / 时段：验证首页卡片与公告栏在雪原、万圣夜下的配色适配
const scene = params.get("scene");
if (scene) document.documentElement.dataset.scene = scene;
const daypart = params.get("daypart");
if (daypart) document.documentElement.dataset.daypart = daypart;

/*
 * ?thememenu=1：自动点开右上角调色板的主题菜单。
 * 菜单开合是 LandingView 的内部状态，无头截图点不了，让夹具代点一下，
 * 目检深色主题下菜单里的文字对比度（业主 2026-10-26 实拍：菜单像空的）。
 */
if (params.get("thememenu") === "1") {
  window.setTimeout(() => {
    document.querySelector<HTMLButtonElement>(".vx-scene-wrap .vx-icon-btn")?.click();
  }, 150);
}

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
      sceneTheme={(params.get("scene") as SceneThemeId | null) ?? ""}
      onSetSceneTheme={() => {}}
      lastRoom={params.get("empty") ? null : { code: "482193", role: "guest", savedAt: Date.now() }}
      onResumeLastRoom={() => {}}
      // 固定房号：?nomyroom 看"还没认领"的形态（主按钮回到「创建语音房」）
      myRoom={
        params.has("nomyroom") ? null : { code: "235417", locked: params.has("locked") }
      }
      onClaimMyRoom={() => true}
      onStartMyRoom={() => {}}
      onCreateGame={() => {}}
      onJoinGame={() => {}}
    />
  </StrictMode>,
);
