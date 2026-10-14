/**
 * 5blong 屏幕共享 · Cloudflare Worker（生产环境 SFU 代理）。
 *
 * 与本地验证用的 scripts/dev-sfu-server.mjs **接口完全一致**：
 *   前端 → /sfu/* → 这里补 Bearer 密钥 → rtc.live.cloudflare.com
 *
 * 防串流（发布登记表）：SFU 没有"房间/广播"概念，订阅必须点名
 * （sessionId + trackName），而这个 id 只在房间内经 HMAC 保护的通道分发——
 * 别的房间拿不到就不可能串流。但 sessionId 本身不构成授权（官方文档明说），
 * 所以这里用 Durable Object 记一本"本服务签发过的发布"账：
 * 订阅 remote 轨时逐条核对，不在账上的直接 403。
 *
 * 部署（上线时执行，本地验证不需要它）：
 *   1. wrangler secret put SFU_APP_ID
 *   2. wrangler secret put SFU_APP_SECRET
 *   3. wrangler deploy
 *   4. 前端把 SFU_BASE 指到 Worker 域名（或在 Pages 域名上挂 /sfu 路由）。
 */

const SFU_BASE = "https://rtc.live.cloudflare.com/v1";

const ROUTES = [
  { method: "POST", pattern: /^\/sessions\/new$/ },
  { method: "POST", pattern: /^\/sessions\/[\w-]+\/tracks\/new$/ },
  { method: "PUT", pattern: /^\/sessions\/[\w-]+\/renegotiate$/ },
  { method: "PUT", pattern: /^\/sessions\/[\w-]+\/tracks\/close$/ },
  { method: "GET", pattern: /^\/sessions\/[\w-]+$/ },
];

/** 发布登记表（全局单例 DO：多 isolate 下状态一致）。 */
export class PublicationRegistry {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const trackNames = (url.searchParams.get("tracks") ?? "").split(",").filter(Boolean);
    if (!sessionId || trackNames.length === 0) {
      return new Response(JSON.stringify({ error: "bad registry request" }), { status: 400 });
    }

    switch (url.pathname) {
      case "/register": {
        for (const name of trackNames) {
          await this.state.storage.put(`${sessionId}|${name}`, Date.now());
        }
        return new Response(JSON.stringify({ ok: true }));
      }
      case "/check": {
        // 每条 (sessionId, trackName) 都必须在账上
        const values = await Promise.all(
          trackNames.map((name) => this.state.storage.get(`${sessionId}|${name}`)),
        );
        const known = values.every((v) => v !== undefined);
        return new Response(JSON.stringify({ known }), {
          status: known ? 200 : 403,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
      case "/forget": {
        for (const name of trackNames) {
          await this.state.storage.delete(`${sessionId}|${name}`);
        }
        return new Response(JSON.stringify({ ok: true }));
      }
      default:
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, configured: Boolean(env.SFU_APP_ID && env.SFU_APP_SECRET) });
    }

    if (!env.SFU_APP_ID || !env.SFU_APP_SECRET || !env.REGISTRY) {
      return json({ error: "worker bindings not configured" }, 500);
    }

    // CORS 预检（桌面端 tauri.localhost 跨域调用必需）
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
    }

    // /sfu/sessions/...（或旧的单数写法）→ SFU 的 /apps/{appId}/sessions/...
    const sub = url.pathname.replace(/^\/sfu\/sessions?\//, "/sessions/");
    const route = ROUTES.find((r) => r.method === request.method && r.pattern.test(sub));
    if (!route) return json({ error: "not found" }, 404);

    const rawBody = request.method === "GET" ? undefined : await request.arrayBuffer();

    // ── 登记表校验/登记 ──
    const sessionMatch = sub.match(/^\/sessions\/([\w-]+)\/tracks\/(new|close)$/);
    if (sessionMatch && rawBody && rawBody.length > 0) {
      const sessionId = sessionMatch[1];
      const closing = sessionMatch[2] === "close";
      let tracks = [];
      try {
        tracks = JSON.parse(new TextDecoder().decode(rawBody))?.tracks ?? [];
      } catch {
        return json({ error: "invalid body" }, 400);
      }
      const locals = tracks.filter((t) => t.location === "local" && t.trackName).map((t) => t.trackName);
      const remotes = tracks.filter(
        (t) => t.location === "remote" && t.sessionId && t.trackName,
      );

      if (!closing && remotes.length > 0) {
        // 订阅：所有 remote 轨必须在登记表上（任一不在 → 403，防盗看/串流）
        for (const t of remotes) {
          const check = await registryFetch(env, "check", t.sessionId, [t.trackName]);
          if (!check.known) {
            return json({ error: "unknown publication" }, 403);
          }
        }
      }
      if (!closing && locals.length > 0) {
        await registryFetch(env, "register", sessionId, locals);
      }
      if (closing && locals.length > 0) {
        await registryFetch(env, "forget", sessionId, locals);
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

async function registryFetch(env, action, sessionId, trackNames) {
  const id = env.REGISTRY.idFromName("global");
  const stub = env.REGISTRY.get(id);
  const res = await stub.fetch(
    `https://registry.internal/${action}?sessionId=${encodeURIComponent(sessionId)}&tracks=${encodeURIComponent(trackNames.join(","))}`,
  );
  return res.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
