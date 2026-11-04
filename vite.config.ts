import react from "@vitejs/plugin-react";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin, type ViteDevServer, type PreviewServer } from "vite";

/**
 * 5blong 的 Vite 配置。
 *
 * 应用只有两个入口相关的东西：index.html → src/client/main.tsx，
 * 以及 public/ 下的图标（由 Vite 原样复制到产物根目录）。
 *
 * 生产产物由 `npm run build:web:pages` 指定（--base ./ --outDir dist-web）；
 * 这里的 build.outDir 只是 `npm run dev`/默认构建时的兜底。
 */
const pkgVersion = JSON.parse(readFileSync("./package.json", "utf8")).version as string;

/**
 * 降噪模型（DeepFilterNet3）不再打进产物。
 *
 * `denoise-voice-clarity` 内部写的是 `new URL("./wasm/xxx.wasm", import.meta.url)`，
 * Vite 会把这个 18MB 当成静态资源发射进 dist-web —— 网页端只是下载慢，
 * **桌面端会被整个塞进安装包**（7.16MB → 16.63MB 的主因，对局功能只占 10KB）。
 *
 * 这里在构建时把那一行改成一个运行时哨兵路径，产物体积立刻回落；
 * 真正的字节由 ns-deepfilter.ts 的 fetch 拦截器从服务器（或本地缓存）供给。
 * 注意必须用 `location.href` 当 base：Vite 只改写 `import.meta.url` 的写法。
 */
const DF_MODEL_SENTINEL = "__dfn_model__.wasm";
const DF_MODEL_FILE = "denoise_voice_core_bg.wasm";
const DF_MODEL_SOURCE = resolve("node_modules/denoise-voice-clarity/dist/wasm", DF_MODEL_FILE);

function dfnModelExternal(): Plugin {
  return {
    name: "dfn-model-external",
    enforce: "pre",
    transform(code, id) {
      // 只动这个库的产物；带 query 的 id（?v=xxx）也认
      if (!/denoise-voice-clarity\/dist\/index\.js/.test(id)) return null;
      const re = /new URL\(\s*"\.\/wasm\/denoise_voice_core_bg\.wasm"\s*,\s*import\.meta\.url\s*\)/g;
      if (!re.test(code)) return null;
      return code.replace(re, `new URL(${JSON.stringify(DF_MODEL_SENTINEL)}, location.href)`);
    },
  };
}

/** dev / preview 下把 /models/*.wasm 直接指向 node_modules，本地不用把 18MB 拷进产物。 */
function serveDfModel(): Plugin {
  const handler = (req: { url?: string }, res: any, next: () => void) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== `/models/${DF_MODEL_FILE}`) return next();
    if (!existsSync(DF_MODEL_SOURCE)) {
      res.statusCode = 404;
      res.end("model not found");
      return;
    }
    res.setHeader("Content-Type", "application/wasm");
    res.setHeader("Content-Length", String(statSync(DF_MODEL_SOURCE).size));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Access-Control-Allow-Origin", "*");
    createReadStream(DF_MODEL_SOURCE).pipe(res);
  };
  return {
    name: "dfn-model-dev-serve",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(handler as any);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(handler as any);
    },
  };
}

export default defineConfig({
  plugins: [react(), dfnModelExternal(), serveDfModel()],
  // 这个库必须走 transform（不能进 esbuild 预打包），否则上面那行改写看不到
  optimizeDeps: {
    exclude: ["denoise-voice-clarity"],
  },
  // 网页版显示"当前部署的版本"用（桌面端走 Tauri 的 getVersion，不需要这个）
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
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
