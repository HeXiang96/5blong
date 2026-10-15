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

    // /feedback → 应用内意见反馈（写 D1）。同样在静态资源之前拦。
    if (url.pathname === "/feedback") {
      return handleFeedback(request, env);
    }

    // /admin → 反馈查看页（令牌保护）。不提供令牌时形同 401，不影响静态站。
    if (url.pathname === "/admin") {
      return handleAdmin(request, env);
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

// ---------------------------------------------------------------------------
// /feedback —— 应用内意见反馈（D1）
// ---------------------------------------------------------------------------
//
// 契约（客户端 src/client/voice/feedback.ts 与此对应，改一处要改两处）：
//   POST /feedback  200 { ok:true, id } | 400 参数不合法 | 429 太频繁
//                   503 通道未就绪（Pages 项目还没建 D1 / 没绑定）
// 隐私：不接收房间链接与密码（客户端也不发送）；IP 只存不可逆哈希，用于限速。
// 状态码语义是契约：503 时客户端提示"反馈通道尚未启用"，不要当成失败重试。

/** 允许的分类（与前端下拉一致）。 */
const FEEDBACK_CATEGORIES = new Set(["voice", "mic", "room", "screen", "lag", "other"]);
/** 单条上限：描述 500 字、联系方式 120 字、环境信息 2KB。 */
const FEEDBACK_MAX_MESSAGE = 500;
const FEEDBACK_MAX_CONTACT = 120;
const FEEDBACK_MAX_CONTEXT = 2048;
/** 每个 IP 每小时最多提交条数。 */
const FEEDBACK_HOURLY_LIMIT = 5;

function feedbackCors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

async function handleFeedback(request, env) {
  // 桌面端（tauri.localhost）跨域提交必发 OPTIONS 预检；网页端同源无此问题。
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: feedbackCors() });
  }
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  // 通道未就绪（还没建库/没绑定）：明确 503，客户端据此提示而不是报网络错误。
  if (!env.DB) {
    return json({ error: "feedback channel not configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const message = clampText(body?.message, FEEDBACK_MAX_MESSAGE);
  if (message.length < 2) {
    return json({ error: "message too short" }, 400);
  }
  const category = FEEDBACK_CATEGORIES.has(body?.category) ? String(body.category) : "other";
  const contact = clampText(body?.contact, FEEDBACK_MAX_CONTACT);
  const version = clampText(body?.version, 40);
  const platform = clampText(body?.platform, 40);
  let contextJson = "";
  try {
    const raw = JSON.stringify(body?.context ?? {});
    contextJson = raw.length > FEEDBACK_MAX_CONTEXT ? "" : raw;
  } catch {
    contextJson = "";
  }

  const ipHash = await sha256Hex(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const since = new Date(Date.now() - 3600_000).toISOString();
  try {
    const counted = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM feedback WHERE ip_hash = ? AND created_at > ?",
    )
      .bind(ipHash, since)
      .first();
    if ((counted?.n ?? 0) >= FEEDBACK_HOURLY_LIMIT) {
      return json({ error: "too many requests" }, 429);
    }
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO feedback (id, created_at, version, platform, category, message, contact, context_json, ip_hash, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')",
    )
      .bind(id, new Date().toISOString(), version, platform, category, message, contact, contextJson, ipHash)
      .run();
    return json({ ok: true, id }, 200);
  } catch (error) {
    // 表还没建等情况：如实 500，但不把内部细节抛给客户端
    console.error("[feedback] insert failed", error?.message ?? error);
    return json({ error: "storage error" }, 500);
  }
}

/** 裁剪 + 去控制字符（前端也有限制，这里是服务端的最后一道闸）。 */
function clampText(value, max) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ---------------------------------------------------------------------------
// /admin —— 反馈查看页（令牌保护，纯服务端渲染，手机也能看）
// ---------------------------------------------------------------------------

async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? request.headers.get("x-admin-token") ?? "";

  if (!env.FEEDBACK_TOKEN) {
    return adminPage(
      "尚未启用",
      "<p>还没设置管理员令牌。在本机执行 <code>npm run feedback:setup</code>（会建库、绑定并写入令牌），然后再来。</p>",
      501,
    );
  }
  if (!safeEqual(token, env.FEEDBACK_TOKEN)) {
    return new Response("未授权：令牌不正确", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (!env.DB) {
    return adminPage("数据库未绑定", "<p>Pages 项目还没有绑定 D1 数据库（变量名 <code>DB</code>）。</p>", 503);
  }

  // 标记状态（表单 POST，处理完跳回列表页）
  if (request.method === "POST") {
    const form = await request.formData();
    const id = String(form.get("id") ?? "");
    const status = String(form.get("status") ?? "") === "done" ? "done" : "new";
    if (id) {
      await env.DB.prepare("UPDATE feedback SET status = ? WHERE id = ?").bind(status, id).run();
    }
    return Response.redirect(url.toString(), 303);
  }

  let rows = [];
  try {
    const result = await env.DB.prepare(
      "SELECT id, created_at, version, platform, category, message, contact, context_json, status " +
        "FROM feedback ORDER BY created_at DESC LIMIT 200",
    ).all();
    rows = result?.results ?? [];
  } catch (error) {
    return adminPage("读取失败", `<p>${escapeHtml(String(error?.message ?? error))}</p>`, 500);
  }
  return adminPage("意见反馈", feedbackListHtml(url, rows), 200);
}

const CATEGORY_LABELS = {
  voice: "语音",
  mic: "麦克风",
  room: "进出房间",
  screen: "屏幕共享",
  lag: "卡顿掉线",
  other: "其它",
};

function feedbackListHtml(url, rows) {
  const pending = rows.filter((r) => r.status !== "done").length;
  const items = rows
    .map((r) => {
      const when = escapeHtml(formatLocalTime(r.created_at));
      const category = CATEGORY_LABELS[r.category] ?? escapeHtml(r.category ?? "其它");
      const done = r.status === "done";
      let context = "";
      if (r.context_json) {
        try {
          const parsed = JSON.parse(r.context_json);
          context = Object.entries(parsed)
            .map(([k, v]) => `<span class="kv">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`)
            .join("");
        } catch {
          context = "";
        }
      }
      return `<article class="card${done ? " done" : ""}">
  <header>
    <span class="when">${when}</span>
    <span class="tag">${category}</span>
    ${done ? '<span class="tag tag-done">已处理</span>' : ""}
    <span class="meta">v${escapeHtml(r.version || "?")} · ${escapeHtml(r.platform || "?")}</span>
  </header>
  <p class="msg">${escapeHtml(r.message)}</p>
  ${r.contact ? `<p class="contact">联系方式：${escapeHtml(r.contact)}</p>` : ""}
  ${context ? `<div class="ctx">${context}</div>` : ""}
  <form method="post" action="${escapeHtml(url.pathname + url.search)}">
    <input type="hidden" name="id" value="${escapeHtml(r.id)}" />
    <input type="hidden" name="status" value="${done ? "new" : "done"}" />
    <button type="submit">${done ? "标记为未处理" : "标记为已处理"}</button>
  </form>
</article>`;
    })
    .join("\n");

  return `<p class="summary">共 ${rows.length} 条，待处理 <strong>${pending}</strong> 条（最多显示最近 200 条）</p>
${items || '<p class="empty">还没有收到反馈。</p>'}`;
}

function adminPage(title, contentHtml, status) {
  return new Response(
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>5blong · ${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 20px; background: #f6f4ef; color: #2b2620;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .summary { color: #6b6257; margin: 0 0 16px; }
  .card { background: #fff; border: 1px solid #e3ded4; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
  .card.done { opacity: .62; }
  .card header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
  .when { font-variant-numeric: tabular-nums; color: #6b6257; font-size: 13px; }
  .tag { background: #efe7d8; border-radius: 999px; padding: 1px 10px; font-size: 12px; }
  .tag-done { background: #d8ecdc; }
  .meta { color: #8a8175; font-size: 12px; margin-left: auto; }
  .msg { margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; }
  .contact { margin: 0 0 8px; color: #6b6257; font-size: 13px; }
  .ctx { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .kv { background: #f6f4ef; border-radius: 6px; padding: 2px 8px; font-size: 12px; color: #6b6257; }
  form { margin: 0; }
  button { border: 1px solid #d6cfc2; background: #fff; border-radius: 8px; padding: 5px 12px;
           font-size: 13px; cursor: pointer; }
  button:hover { background: #faf8f4; }
  .empty { color: #8a8175; }
  code { background: #efe7d8; border-radius: 4px; padding: 1px 6px; }
  @media (max-width: 480px) {
    body { padding: 14px; }
    .meta { margin-left: 0; width: 100%; }
  }
</style>
</head>
<body>
<h1>5blong · ${escapeHtml(title)}</h1>
${contentHtml}
</body>
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

function formatLocalTime(iso) {
  // D1 存 UTC ISO；服务器按东八区展示更符合使用习惯
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso ?? "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

/** 长度恒定比较，避免计时侧信道（令牌不长，够用）。 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
