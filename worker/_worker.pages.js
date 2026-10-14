/**
 * 5blong · Cloudflare Pages 高级模式 Worker（_worker.js）。
 *
 * 作用：让 5blong.pages.dev 同域提供两件事——
 *   1. /sfu/*  屏幕共享接口：浏览器/桌面端 → /sfu/*（补 Bearer 密钥）→ rtc.live.cloudflare.com
 *   2. /ice    ICE 配置：现场签发 Cloudflare TURN 短期凭据（P2P 打洞失败时的唯一起作用的中继）
 *   其余请求 → 静态资源（网页本体）。
 *
 * 凭证：Pages 项目环境变量 SFU_APP_ID / SFU_APP_SECRET 与 TURN_KEY_ID / TURN_KEY_API_TOKEN
 * （项目设置里配置一次即可，由 scripts/deploy-pages.mjs 在本机发部署时从 .dev-secrets.json
 * 自动写入）。TURN key 与 SFU 的 appId/secret **是两套**，分别在 Cloudflare 后台
 * Realtime 下创建（见 README「打洞与 TURN 中继」）。
 *
 * ⚠️ 历史教训：TURN 凭据必须由服务端签发，长密钥绝不能进前端。前端拿到的
 * username/credential 是带 TTL 的一次性凭据，泄漏也只影响有限时间窗口。
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

    // /ice → ICE 配置（Cloudflare TURN 短期凭据）。必须在静态资源兜底之前拦。
    if (url.pathname === "/ice") {
      return handleIce(request, env);
    }

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

// ---------------------------------------------------------------------------
// /ice —— Cloudflare Realtime TURN 凭据签发
// ---------------------------------------------------------------------------

const TURN_API = "https://rtc.live.cloudflare.com/v1";

/**
 * 凭据 TTL（秒）。官方建议"大于预期最长一次通话"；
 * 语音房开一整晚是常态，取 24 小时。
 */
const TURN_TTL_SECONDS = 86400;

/** isolate 内复用签发结果：同一实例的进房请求不必每次都打 Cloudflare API。 */
let iceCache = null;

/**
 * 签发 ICE 配置。
 *
 * 状态码契约（客户端据此决定是否降级，不要改）：
 *   200 → { iceServers: [...] }
 *   501 → 服务端没配 TURN key（客户端静默降级为纯 STUN，不打扰用户）
 *   502 → 配了但签发失败（上游不可达 / 返回异常）
 */
async function handleIce(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  const now = Date.now();
  if (iceCache && iceCache.until > now) {
    return new Response(iceCache.body, { status: 200, headers: iceHeaders() });
  }

  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return json({ error: "turn key not configured" }, 501);
  }

  let upstream;
  try {
    upstream = await fetch(
      `${TURN_API}/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      },
    );
  } catch (error) {
    return json({ error: `turn upstream unreachable: ${error.message}` }, 502);
  }

  if (!upstream.ok) {
    return json({ error: `turn credential failed: ${upstream.status}` }, 502);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return json({ error: "turn credential not json" }, 502);
  }
  if (!Array.isArray(data?.iceServers) || data.iceServers.length === 0) {
    return json({ error: "turn credential malformed" }, 502);
  }

  // 提前 1 小时作废缓存，避免把"马上要过期"的凭据发给客户端。
  const body = JSON.stringify({ iceServers: data.iceServers });
  iceCache = { body, until: now + (TURN_TTL_SECONDS - 3600) * 1000 };
  return new Response(body, { status: 200, headers: iceHeaders() });
}

function iceHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    // 凭据有时效，且由服务端缓存控制，禁止中间层/CDN 再缓存一份。
    "Cache-Control": "no-store",
  };
}
