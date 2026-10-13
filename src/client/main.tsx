import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./voice/App";
/*
 * 样式按模块引入。
 *
 * 注意：**不要用 CSS 里的 @import** —— Vite 的构建不会把 `@import "./x.css"`
 * 内联进最终产物（实测产物从 50KB 掉到 24KB，猪圈样式整块丢失）。
 * 从 TS 里 import 才会被正确合并，而且下面这个顺序就是最终层叠顺序。
 */
import "./voice/styles.css";
import "./voice/pen-scene.css";
import "./voice/pen-life.css";
import "./voice/pen-fence.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Application root was not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
