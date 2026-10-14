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
 * 本身就串不了流；这里再拦一道发布登记表（同 isolate 内存账本，尽力而为）：
 * 只有本服务签发过的 (sessionId, trackName) 才允许被订阅，未登记一律 403。
 * （完整版 Durable Object 账本见 worker/index.js，可部署到自定义域名加强。）
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

/** 发布登记表（isolate 级内存账本；进程回收后自然失效，只影响拦截的覆盖面）。 */
const publications = new Map();
const PUB_TTL_MS = 2 * 60 * 60 * 1000;

function registerPublication(sessionId, trackNames) {
  const entry = publications.get(sessionId) ?? { trackNames: new Set(), at: Date.now() };
  for (const name of trackNames) entry.trackNames.add(name);
  entry.at = Date.now();
  publications.set(sessionId, entry);
  if (publications.size > 500) {
    const now = Date.now();
    for (const [id, item] of publications) {
      if (now - item.at > PUB_TTL_MS) publications.delete(id);
    }
  }
}

function publicationsKnown(sessionId, trackNames) {
  const entry = publications.get(sessionId);
  if (!entry) return false;
  return trackNames.every((name) => entry.trackNames.has(name));
}

function forgetPublication(sessionId, trackNames) {
  const entry = publications.get(sessionId);
  if (!entry) return;
  for (const name of trackNames) entry.trackNames.delete(name);
  if (entry.trackNames.size === 0) publications.delete(sessionId);
}

function parseTracks(raw) {
  try {
    const tracks = JSON.parse(raw)?.tracks;
    if (!Array.isArray(tracks)) return null;
    return tracks.map((t) => ({
      location: t?.location === "remote" ? "remote" : "local",
      sessionId: typeof t?.sessionId === "string" ? t.sessionId : "",
      trackName: typeof t?.trackName === "string" ? t.trackName : "",
    }));
  } catch {
    return null;
  }
}

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

    // 登记表：本地发布 → 登记；订阅 remote 轨 → 必须是本服务签发过的
    const trackMatch = sub.match(/^\/sessions\/([\w-]+)\/tracks\/(new|close)$/);
    if (trackMatch && rawBody && rawBody.byteLength > 0) {
      const sessionId = trackMatch[1];
      const closing = trackMatch[2] === "close";
      const tracks = parseTracks(new TextDecoder().decode(rawBody));
      if (!tracks) return json({ error: "invalid tracks" }, 400);
      const locals = tracks.filter((t) => t.location === "local" && t.trackName).map((t) => t.trackName);
      const remotes = tracks.filter((t) => t.location === "remote" && t.sessionId && t.trackName);
      if (!closing && remotes.length > 0) {
        const bad = remotes.find((t) => !publicationsKnown(t.sessionId, [t.trackName]));
        if (bad) return json({ error: "unknown publication" }, 403);
      }
      if (locals.length > 0) {
        if (closing) forgetPublication(sessionId, locals);
        else registerPublication(sessionId, locals);
      }
    }

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
