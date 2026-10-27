import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./voice/App";
import { UpdateOverlay } from "./voice/components/UpdateOverlay";
import { ErrorBoundary } from "./voice/components/ErrorBoundary";
/*
 * 样式按模块引入。
 *
 * 注意：**不要用 CSS 里的 @import** —— Vite 的构建不会把 `@import "./x.css"`
 * 内联进最终产物（实测产物从 50KB 掉到 24KB，猪圈样式整块丢失）。
 * 从 TS 里 import 才会被正确合并，而且下面这个顺序就是最终层叠顺序。
 */
import "./voice/styles.css";
import "./voice/account.css";
import "./voice/pen-scene.css";
import "./voice/pen-life.css";
import "./voice/pen-fence.css";
import "./voice/pen-tv.css";
// 场景主题（雪原/万圣夜）必须最后加载：按时段配色的覆盖靠层叠顺序取胜。
import "./voice/pen-themes.css";
// 开黑圈（独立子系统）的电竞主题
import "./game/game-theme.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Application root was not found");
}

/**
 * 屏蔽页面右键菜单（2026-10-27，业主实拍）。
 *
 * 起因：浏览器/WebView 的原生右键菜单里就是「返回 / 刷新 / 另存为 / 打印」，
 * 用户随手右键、手一滑点到**刷新**，页面一重载房主就掉线——而 P2P 房间跟着
 * 房主存在，他这一刷新，整间房就散了（其他人集体掉线，还以为是被踢）。
 *
 * 两个必须保留原生的地方：
 *   1. 输入框 / 可编辑区（复制粘贴是刚需，右键菜单里有"粘贴"）；
 *   2. 显式标了 `data-allow-context-menu` 的元素（以后要给某个区域留自定义菜单时用）。
 *
 * 用捕获阶段：某些组件自己 stopPropagation 时也拦得住。
 */
document.addEventListener(
  "contextmenu",
  (event) => {
    /*
     * 用 `instanceof Element` 兜一下：contextmenu 的 target 理论上总是元素，
     * 但 document / text 节点上 `closest` 不存在，会把整个监听抛异常
     * —— 那等于右键屏蔽在自己身上失效了。
     */
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, [contenteditable='true'], [data-allow-context-menu]")
    ) {
      return;
    }
    event.preventDefault();
  },
  { capture: true },
);

createRoot(root).render(
  <StrictMode>
    {/* 顶层兜底：任何未捕获的渲染异常都只显示一个可重载的卡片，而不是整窗白屏 */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    {/* 桌面端更新进度（网页版自动不渲染） */}
    <UpdateOverlay />
  </StrictMode>,
);
