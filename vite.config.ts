import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 5blong 的 Vite 配置。
 *
 * 应用只有两个入口相关的东西：index.html → src/client/main.tsx，
 * 以及 public/ 下的图标（由 Vite 原样复制到产物根目录）。
 *
 * 生产产物由 `npm run build:web:pages` 指定（--base ./ --outDir dist-web）；
 * 这里的 build.outDir 只是 `npm run dev`/默认构建时的兜底。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
  },
  server: {
    // host: true 让同一局域网里的手机也能打开调试。
    host: true,
    port: 8787,
    strictPort: true,
    // /sfu/*（屏幕共享）与 /ice（TURN 凭据）都转发到本地代理
    // （scripts/dev-sfu-server.mjs，需先启动）。两条路径在线上都由
    // worker/_worker.pages.js 提供，保持同源才能"本地能跑 = 线上能跑"。
    proxy: {
      "/sfu": {
        target: "http://127.0.0.1:8789",
        changeOrigin: true,
      },
      "/ice": {
        target: "http://127.0.0.1:8789",
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      "/sfu": {
        target: "http://127.0.0.1:8789",
        changeOrigin: true,
      },
      "/ice": {
        target: "http://127.0.0.1:8789",
        changeOrigin: true,
      },
    },
  },
});
