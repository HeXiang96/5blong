/**
 * 5blong · Cloudflare Pages 高级模式 Worker（_worker.js）。
 *
 * 作用：让 5blong.pages.dev 同域提供 /sfu/* 屏幕共享接口——
 *   浏览器/桌面端 → /sfu/*（补 Bearer 密钥）→ rtc.live.cloudflare.com
 *   其余请求 → 静态资源（网页本体）。
 *
 * 凭证：Pages 项目环境变量 SFU_APP_ID / SFU_APP_SECRET（项目设置里配置一次即可，
 * 由 scripts/deploy-pages.mjs 在本机发部署时从 .dev-secrets.json 自动写入）。
 *
 * 防串流：SFU 没有房间概念，订阅必须"点名"（256-bit sessionId 只在房间内分发），
 * 别的房间物理上拿不到这个 key，串流不成立。
 * **教训（2026-10-14 线上事故）**：这里不要加"发布登记表"之类的实例内校验——
 * Cloudflare 会把请求落到不同 isolate，发布者的登记与订阅者的查验不在同一份
 * 内存里，正常观众会被误杀成 403（表现为观众端永远雪花）。
 * 需要全局账本的强化版见 worker/index.js（Durable Object 版，可部署到自定义域名）。
 *
 * 部署：scripts/deploy-pages.mjs / publish-desktop.mjs 会把本文件作为
 * `_worker.js` 附到部署请求里（与 wrangler pages deploy 的行为一致）。
 */

const SFU_BASE = "https://rtc.live.cloudflare.com/v1";

const ROUTES = [
  { method: "POST", pattern: /^\/sessions\/new$/ },
  { method: "POST", pattern: /^\/sessions\/[\w-]+\/tracks\/new$/ },
  { method: "PUT", pattern: /^\/sessions\/[\w-]+\/renegotiate$/ },
  { method: "PUT", pattern: /^\/sessions\/[\w-]+\/tracks\/close$/ },
  { method: "GET", pattern: /^\/sessions\/[\w-]+$/ },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 非 /sfu 请求 → 静态网页资源
    if (!/^\/sfu\/sessions?\//.test(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    if (!env.SFU_APP_ID || !env.SFU_APP_SECRET) {
      return json({ error: "pages env vars not configured" }, 500);
    }

    // CORS 预检：桌面端（tauri.localhost）跨域调用带 Authorization/Content-Type，
    // 浏览器必发 OPTIONS 探测——不答它，桌面端发布永远静默失败（网页端同源无此问题）。
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // /sfu/sessions/...（或旧的单数写法）→ SFU 的 /apps/{appId}/sessions/...
    const sub = url.pathname.replace(/^\/sfu\/sessions?\//, "/sessions/");
    const route = ROUTES.find((r) => r.method === request.method && r.pattern.test(sub));
    if (!route) return json({ error: "not found" }, 404);

    const rawBody = request.method === "GET" ? undefined : await request.arrayBuffer();

    const upstream = await fetch(`${SFU_BASE}/apps/${env.SFU_APP_ID}${sub}${url.search}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${env.SFU_APP_SECRET}`,
        "Content-Type": "application/json",
      },
      body: rawBody && rawBody.byteLength > 0 ? rawBody : undefined,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
