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

    // /api/account/* → 账号 / 好友 / 固定房号（D1，表结构见 worker/accounts-schema.sql）。
    // 「我的房间」的房号就是 accounts.room_code，绑在 8 位数字账号 ID 上。
    if (url.pathname === "/api/account" || url.pathname.startsWith("/api/account/")) {
      return handleAccount(request, env, url);
    }

    // /peerjs* → 信令：转到我们**自建的信令服务**（service binding SIGNAL）。
    // 背景：公共 PeerJS 云会对握手返回 Cloudflare 1020（按浏览器签名封禁），
    // 部分用户完全进不去房间；借道转发也无效（它连我们 Worker 的请求一起拦）。
    // 所以自建服务端：协议与 PeerJS 客户端完全兼容（见 worker/signal/index.js）。
    if (url.pathname === "/peerjs" || url.pathname.startsWith("/peerjs/")) {
      return proxyPeerJs(url, request, env);
    }

    // /game/* 是给桌面客户端跨域调用的：必须先应答 CORS 预检，
    // 否则 WebView2 直接判网络错误（症状："网络异常，请稍后重试"）。
    if (url.pathname.startsWith("/game/") && request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // /game/entitle → 开黑圈创建码校验（换 30 天签名令牌）
    if (url.pathname === "/game/entitle") {
      return handleGameEntitle(request, env);
    }
    // /game/verify → 建房前校验令牌（码被吊销/次数用尽 → 拒绝）
    if (url.pathname === "/game/verify") {
      return handleGameVerify(request, env);
    }
    // /game-admin → 开黑圈运营页（员工令牌 scope=game，看不到反馈与房间遥测）
    if (url.pathname === "/game-admin") {
      return handleGameAdmin(request, env);
    }
    // /accounts-admin → 账号后台（用户名/昵称/房号/数字 ID；永不显示密码）
    if (url.pathname === "/accounts-admin") {
      return handleAccountsAdmin(request, env);
    }

    // /rooms → 在线房间面板（令牌保护；与反馈页分开，避免一页太臃肿）
    if (url.pathname === "/rooms") {
      return handleRooms(request, env);
    }
    // /rooms/beat → 房主心跳；/rooms/bye → 关房上报；/rooms/summary → JSON（令牌保护）
    if (url.pathname === "/rooms/beat") {
      return handleRoomBeat(request, env);
    }
    if (url.pathname === "/rooms/bye") {
      return handleRoomBye(request, env);
    }
    if (url.pathname === "/rooms/summary") {
      return handleRoomsSummary(request, env);
    }
    if (url.pathname === "/rooms/export") {
      return handleRoomsExport(request, env);
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

/**
 * 把信令请求透传给公共 PeerJS 云。
 *
 * 为什么要有这一步：PeerJS 客户端连的是 `wss://<host>/peerjs?key=…&id=…`，
 * 默认 host 是 0.peerjs.com；部分网络（校内网、公司网、代理规则、DNS 污染）
 * 直达不了它，表现就是"没能进入房间 / 与信令服务器的连接中断"。而这些网络
 * 通常**能打开本站**（网站、/ice、/feedback 都在同一个域名上），所以借道我们
 * 的域名做一层透明转发，协议零改动。
 *
 * 注意：Worker 的 fetch 支持 WebSocket 直通（把带 Upgrade 的请求原样转发，
 * 返回的 101 响应直接还给客户端即完成双向管道）。
 */
function proxyPeerJs(url, request, env) {
  // 首选：转到我们自己的信令 Worker（service binding，不走公网、不花流量费）。
  // 客户端因此始终只连 5blong.pages.dev —— 已验证可达，且不受第三方域名拦截影响。
  if (env?.SIGNAL) return env.SIGNAL.fetch(request);

  // 兜底：还没绑定 SIGNAL 时，退回"借道转发公共 PeerJS 云"（实测对 1020 拦截无效，
  // 仅作为未完成绑定时的临时通路，绑好后不会走到这里）。
  const upstream = new URL(request.url);
  upstream.protocol = "https:";
  upstream.host = "0.peerjs.com";
  upstream.port = "";
  return fetch(upstream.toString(), request);
}

const CN_TIME = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
function cnTime(at) {
  try {
    return CN_TIME.format(new Date(at));
  } catch {
    return String(at);
  }
}

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
/**
 * 上下文（自动附带的诊断信息）上限。
 *
 * 原来是 2048，且**超长就整包丢弃**——而连接诊断动辄几十 KB，
 * 等于"附了也白附"。现在放宽到 64KB，超长时只截断 diag 字段，其余照存。
 * D1 单行上限 1MB，64KB 很安全。
 */
const FEEDBACK_MAX_CONTEXT = 64 * 1024;
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
    const ctx = body?.context && typeof body.context === "object" ? body.context : {};
    let raw = JSON.stringify(ctx);
    if (raw.length > FEEDBACK_MAX_CONTEXT) {
      // 超长：先保其余字段，再把 diag 截到剩余额度；实在放不下才整体丢弃
      const rest = { ...ctx };
      delete rest.diag;
      const budget = FEEDBACK_MAX_CONTEXT - JSON.stringify({ ...rest, diag: "" }).length;
      if (typeof ctx.diag === "string" && budget > 200) {
        rest.diag = ctx.diag.slice(0, budget);
      }
      raw = JSON.stringify(rest);
      if (raw.length > FEEDBACK_MAX_CONTEXT) raw = "";
    }
    contextJson = raw;
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
            .map(([k, v]) => {
              // 诊断包是几十 KB 的 JSON：折叠起来，别把列表撑爆
              if (k === "diag") {
                let pretty = String(v);
                try {
                  pretty = JSON.stringify(JSON.parse(pretty), null, 2);
                } catch {
                  /* 截断过的 JSON 解析不了，原样展示 */
                }
                return `<details class="diag"><summary>连接诊断（点开看）</summary><pre>${escapeHtml(pretty)}</pre></details>`;
              }
              return `<span class="kv">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`;
            })
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
  .ctx details.diag { flex-basis: 100%; }
  .ctx details.diag summary { cursor: pointer; font-weight: 600; opacity: .85; }
  .ctx details.diag pre {
    margin: 8px 0 0; padding: 10px; max-height: 340px; overflow: auto;
    background: rgba(0,0,0,.04); border-radius: 8px;
    font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;
  }
  .kv { background: #f6f4ef; border-radius: 6px; padding: 2px 8px; font-size: 12px; color: #6b6257; }
  form { margin: 0; }
  button { border: 1px solid #d6cfc2; background: #fff; border-radius: 8px; padding: 5px 12px;
           font-size: 13px; cursor: pointer; }
  button:hover { background: #faf8f4; }
  .empty { color: #8a8175; }
  code { background: #efe7d8; border-radius: 4px; padding: 1px 6px; }
  /* 在线房间面板：三个大数字 + 房间表 */
  .stats { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; }
  .stat { flex: 1 1 140px; background: #fff; border: 1px solid #e3ded4; border-radius: 12px;
          padding: 12px 16px; display: flex; flex-direction: column; gap: 2px; }
  .stat .big { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat .label { font-size: 12.5px; color: #6b6257; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3ded4;
          border-radius: 12px; overflow: hidden; }
  th, td { padding: 9px 12px; text-align: left; font-size: 13.5px; border-bottom: 1px solid #efeae0; }
  th { background: #f6f4ef; font-weight: 600; color: #6b6257; font-size: 12.5px; }
  tr:last-child td { border-bottom: none; }
  td.num { font-variant-numeric: tabular-nums; font-weight: 600; }
  .tag-live { background: #d8ecdc; }
  @media (max-width: 640px) {
    table { display: block; overflow-x: auto; white-space: nowrap; }
  }
  @media (max-width: 480px) {
    body { padding: 14px; }
    .meta { margin-left: 0; width: 100%; }
  }
  /* —— 运营后台（/rooms）—— */
  .page-sub { color: #6b6257; font-size: 13px; margin: 0 0 16px; }
  .sec-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; margin: 24px 0 10px; }
  .sec-title::before { content: ""; width: 4px; height: 16px; border-radius: 2px; background: #b07a34; }
  .stat { gap: 4px; }
  .stat .ico { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 17px; margin-bottom: 4px; }
  .ico-live { background: #e2f2e6; } .ico-people { background: #fdf0dc; } .ico-share { background: #e7ecf9; }
  .searchbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 14px; }
  .searchbar input[type=text] { flex: 0 1 280px; border: 1px solid #d6cfc2; border-radius: 999px; padding: 8px 16px; font-size: 13.5px; background: #fff; outline: none; }
  .searchbar input[type=text]:focus { border-color: #b07a34; box-shadow: 0 0 0 3px rgba(176,122,52,.15); }
  .btn-accent { background: #b07a34; border-color: #b07a34; color: #fff; font-weight: 600; border-radius: 999px; padding: 8px 18px; }
  .btn-accent:hover { background: #9c692a; }
  .export-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #d6cfc2; background: #fff; border-radius: 999px; padding: 8px 16px; font-size: 13px; color: #2b2620; text-decoration: none; }
  .export-btn:hover { background: #faf8f4; }
  details.room-card { background: #fff; border: 1px solid #e3ded4; border-radius: 14px; margin-bottom: 12px; overflow: hidden; }
  details.room-card > summary { list-style: none; cursor: pointer; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 13px 16px; }
  details.room-card > summary::-webkit-details-marker { display: none; }
  details.room-card > summary:hover { background: #faf6ee; }
  details.room-card.done { background: #fdfcf9; }
  details.room-card.done .badge-code { background: #8a8175; }
  .badge-code { background: #2b2620; color: #ffefd0; border-radius: 8px; padding: 3px 12px; font-weight: 700; font-size: 14px; letter-spacing: .06em; font-variant-numeric: tabular-nums; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot-on { background: #22a55c; box-shadow: 0 0 0 3px rgba(34,165,92,.18); }
  .dot-off { background: #b3a894; }
  .live-word { color: #22a55c; font-weight: 600; font-size: 13px; }
  .room-meta { color: #6b6257; font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 10px; }
  .room-body { padding: 0 16px 14px; }
  .chev { margin-left: auto; color: #8a8175; transition: transform .15s ease; font-size: 11px; }
  details[open] > summary .chev { transform: rotate(90deg); }
  .empty-box { background: #fff; border: 1px dashed #d6cfc2; border-radius: 14px; padding: 28px; text-align: center; color: #8a8175; font-size: 13.5px; }
  .empty-emoji { font-size: 30px; margin-bottom: 6px; }
  .empty-sub { color: #a89c8c; font-size: 12.5px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .tag-warn { background: #fdeaea; color: #b3403a; }
  td.dim, .dim { color: #8a8175; font-size: 12.5px; }
  .ev { color: #6b6257; font-size: 12.5px; }
  .curve { color: #8a8175; font-size: 12.5px; }
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

// ---------------------------------------------------------------------------
// /rooms —— 在线房间（房主心跳）
// ---------------------------------------------------------------------------
//
// 背景：信令是公共 PeerJS 云，服务端看不到任何房间；SFU 只覆盖 4 人以上。
// 所以"有多少房间开着"只能由**房主主动报到**（见 src/client/voice/presence.ts）。
//
// 契约：
//   POST /rooms/beat  { id, members, sharing, version, runtime } → 200 { ok:true }
//                     400 参数不合法 | 429 太频繁 | 503 未就绪
//   POST /rooms/bye   { id } → 200（失败无所谓，靠过期兜底）
//   GET  /rooms       → 面板页（令牌保护，与 /admin 分开）
//   GET  /rooms/summary → JSON（令牌保护）
//
// 隐私红线：id 是房主随机生成的标识，**与房间码/邀请链接无关**；
// 只记人数与是否在共享，不记任何标题、内容、成员身份。
// 在线判定：last_seen 在 150 秒内（心跳 60 秒 × 2.5，容忍一次丢包/休眠）。

/** 心跳间隔 60 秒；150 秒没心跳即视为离线。 */
const ROOM_ONLINE_WINDOW_MS = 150_000;
/** 每次访问面板顺手清掉 10 分钟前的死行。 */
const ROOM_GC_MS = 600_000;
/** 每个 IP 每小时最多 130 次心跳（60 秒一次 = 每小时 60 次，留足重试余量）。 */
const ROOM_HOURLY_LIMIT = 130;
/** 同一 IP 同时最多 4 个活跃房间（正常一个人不会开更多）。 */
const ROOM_MAX_PER_IP = 4;

function roomsCors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

async function handleRoomBeat(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: roomsCors() });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.DB) return json({ error: "rooms channel not configured" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const id = typeof body?.id === "string" ? body.id.trim().toLowerCase() : "";
  // 只收 8~64 位十六进制：房主用 crypto.randomUUID()（含连字符，32 位 hex）生成
  if (!/^[0-9a-f]{8,64}$/.test(id.replace(/-/g, ""))) {
    return json({ error: "bad room id" }, 400);
  }
  const members = Math.max(1, Math.min(64, Math.round(Number(body?.members) || 1)));
  const sharing = body?.sharing === true ? 1 : 0;
  const version = clampText(body?.version, 40);
  const runtime = clampText(body?.runtime, 20);
  const ipHash = await sha256Hex(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const nowIso = new Date().toISOString();

  try {
    // 限速 1：这个 IP 最近一小时的心跳总量
    const since = new Date(Date.now() - 3600_000).toISOString();
    const counted = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM rooms WHERE ip_hash = ? AND last_seen > ?",
    )
      .bind(ipHash, since)
      .first();
    // 注意：行是 UPSERT 的，同一房间一小时只算一行；这里用"活跃行数"防的是
    // 恶意刷大量房间 id 的情况，配合下面的 ROOM_MAX_PER_IP 双保险。
    if ((counted?.n ?? 0) > ROOM_HOURLY_LIMIT) {
      return json({ error: "too many requests" }, 429);
    }
    // 限速 2：同一 IP 同时活跃的房间数
    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM rooms WHERE ip_hash = ? AND last_seen > ?",
    )
      .bind(ipHash, new Date(Date.now() - ROOM_ONLINE_WINDOW_MS).toISOString())
      .first();
    if ((active?.n ?? 0) >= ROOM_MAX_PER_IP) {
      return json({ error: "too many rooms" }, 429);
    }

    await env.DB.prepare(
      "INSERT INTO rooms (id, created_at, last_seen, members, sharing, version, runtime, ip_hash) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, members = excluded.members, " +
        "sharing = excluded.sharing, version = excluded.version, runtime = excluded.runtime",
    )
      .bind(id, nowIso, nowIso, members, sharing, version, runtime, ipHash)
      .run();
    return json({ ok: true }, 200);
  } catch (error) {
    console.error("[rooms] beat failed", error?.message ?? error);
    return json({ error: "storage error" }, 500);
  }
}

async function handleRoomBye(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: roomsCors() });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.DB) return json({ error: "rooms channel not configured" }, 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const id = typeof body?.id === "string" ? body.id.trim().toLowerCase() : "";
  if (!/^[0-9a-f-]{8,64}$/.test(id)) return json({ error: "bad room id" }, 400);
  try {
    await env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(id).run();
    return json({ ok: true }, 200);
  } catch {
    // 关房上报失败无所谓：150 秒后自动离线
    return json({ ok: true }, 200);
  }
}

/** 在线房间列表（面板与 JSON 共用）。 */
async function loadOnlineRooms(env) {
  const onlineSince = new Date(Date.now() - ROOM_ONLINE_WINDOW_MS).toISOString();
  const staleBefore = new Date(Date.now() - ROOM_GC_MS).toISOString();
  // 顺手清理死行（低频，免费额度内）
  await env.DB.prepare("DELETE FROM rooms WHERE last_seen < ?").bind(staleBefore).run();
  const result = await env.DB.prepare(
    "SELECT id, created_at, last_seen, members, sharing, version, runtime FROM rooms " +
      "WHERE last_seen > ? ORDER BY members DESC, last_seen DESC LIMIT 500",
  )
    .bind(onlineSince)
    .all();
  return result?.results ?? [];
}

async function requireAdminToken(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? request.headers.get("x-admin-token") ?? "";
  if (!env.FEEDBACK_TOKEN) return { error: adminPage("尚未启用", "<p>还没设置管理员令牌，先在本机执行 <code>npm run feedback:setup</code>。</p>", 501) };
  if (!safeEqual(token, env.FEEDBACK_TOKEN)) {
    return { error: new Response("未授权：令牌不正确", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } }) };
  }
  if (!env.DB) return { error: adminPage("数据库未绑定", "<p>Pages 项目还没有绑定 D1（变量名 <code>DB</code>）。</p>", 503) };
  return {};
}

async function handleRooms(request, env) {
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  const guard = await requireAdminToken(request, env);
  if (guard.error) return guard.error;
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? request.headers.get("x-admin-token") ?? "";
  const code = (url.searchParams.get("code") ?? "").trim().slice(0, 16);
  try {
    const [live, history] = await Promise.all([loadLiveRooms(env, token), loadHistory(env, code)]);
    return adminPage("在线房间与历史", roomsPanelHtml(live, history, code, token), 200);
  } catch (error) {
    return adminPage("读取失败", `<p>${escapeHtml(String(error?.message ?? error))}</p>`, 500);
  }
}

/** 在线房间：从自建信令服务的内存态读（实时、秒级）。 */
async function loadLiveRooms(env, token) {
  if (!env.SIGNAL) return [];
  try {
    const res = await env.SIGNAL.fetch("https://signal.internal/rooms-live", {
      headers: { "x-admin-token": token },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.rooms) ? data.rooms : [];
  } catch {
    return [];
  }
}

/** 历史档案：会话 + 成员明细 + 事件 + 人数采样（支持按房间号搜索）。 */
async function loadHistory(env, code) {
  if (!env.DB) return { sessions: [], daily: [] };
  await gcOldRoomSessions(env);
  const sessions = code
    ? (await env.DB.prepare("SELECT * FROM room_sessions WHERE code LIKE ? ORDER BY created_at DESC LIMIT 100").bind(`%${code}%`).all()).results ?? []
    : (await env.DB.prepare("SELECT * FROM room_sessions ORDER BY created_at DESC LIMIT 100").all()).results ?? [];
  for (const session of sessions) {
    session.members = (await env.DB.prepare("SELECT * FROM room_members WHERE session_id = ? ORDER BY joined_at").bind(session.id).all()).results ?? [];
    session.events = (await env.DB.prepare("SELECT at, kind, detail FROM room_events WHERE session_id = ? ORDER BY at DESC LIMIT 50").bind(session.id).all()).results ?? [];
    session.samples = (await env.DB.prepare("SELECT at, members FROM room_samples WHERE session_id = ? ORDER BY at LIMIT 200").bind(session.id).all()).results ?? [];
  }
  const daily = (await env.DB.prepare(
    "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS sessions, SUM(peak_members) AS peak_total " +
      "FROM room_sessions GROUP BY day ORDER BY day DESC LIMIT 14",
  ).all()).results ?? [];
  return { sessions, daily };
}

/** 历史保留 30 天：面板打开时顺手清理（低频）。 */
async function gcOldRoomSessions(env) {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const stale = (await env.DB.prepare("SELECT id FROM room_sessions WHERE created_at < ? LIMIT 50").bind(cutoff).all()).results ?? [];
  for (const row of stale) {
    await env.DB.prepare("DELETE FROM room_members WHERE session_id = ?").bind(row.id).run();
    await env.DB.prepare("DELETE FROM room_events WHERE session_id = ?").bind(row.id).run();
    await env.DB.prepare("DELETE FROM room_samples WHERE session_id = ?").bind(row.id).run();
    await env.DB.prepare("DELETE FROM room_sessions WHERE id = ?").bind(row.id).run();
  }
}

/** 历史会话导出 CSV（留档/做表用）。 */
async function handleRoomsExport(request, env) {
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  const guard = await requireAdminToken(request, env);
  if (guard.error) return guard.error;
  if (!env.DB) return new Response("database not bound", { status: 503 });
  const sessions = (await env.DB.prepare("SELECT * FROM room_sessions ORDER BY created_at DESC LIMIT 500").all()).results ?? [];
  const lines = ["房间号,创建时间,结束时间,时长(秒),峰值人数,客户端,版本,会话id"];
  for (const s of sessions) {
    lines.push([s.code, s.created_at, s.ended_at ?? "", s.duration_s ?? "", s.peak_members ?? "", s.host_runtime ?? "", s.host_version ?? "", s.id]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  }
  return new Response("\ufeff" + lines.join("\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="rooms.csv"' },
  });
}

function fmtDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 60) return `${n} 秒`;
  const m = Math.floor(n / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function relSeconds(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "-";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.round(seconds / 60)} 分钟前`;
}

function onlineMinutes(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "-";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function roomsPanelHtml(live, history, code, token) {
  const liveMembers = live.reduce((sum, room) => sum + (room.members ?? []).filter((m) => !m.leftAt).length, 0);
  const sharing = live.reduce((sum, room) => sum + ((room.share?.active) ? 1 : 0), 0);

  const liveCards = live.length === 0
    ? '<div class="empty-box"><div class="empty-emoji">🐷</div>现在没有房间在线<br><span class="empty-sub">房主创建房间并进入后，这里会实时出现（秒级）</span></div>'
    : live.map((room) => {
        const rows = (room.members ?? []).map((m) => {
          const active = !m.leftAt;
          const rtt = m.link === "self" ? "—" : (m.rttCount > 0 ? `${Math.round(m.rttSum / m.rttCount)}ms（峰值 ${m.rttMax}ms）` : "采样中…");
          const linkText = m.link === "relay" ? "经中继" : m.link === "self" ? "房主本人" : m.link === "direct" ? "直连" : m.link || "—";
          const extra = m.link === "self" ? "—" : `抖动 ${escapeHtml(String(m.jitterMax || 0))}ms · 丢包 ${escapeHtml(String(m.lossPct || 0))}% · 重连 ${escapeHtml(String(m.reconnects || 0))} · 说话 ${fmtDuration(m.speakingS)}`;
          return `<tr>
  <td><b>${escapeHtml(m.name || "-")}</b>${active ? "" : ' <span class="tag">已离开</span>'}</td>
  <td class="num">${active ? "在房" : "—"}</td>
  <td>${escapeHtml(relSeconds(m.joinedAt))}</td>
  <td>${escapeHtml(m.leftAt ? relSeconds(m.leftAt) : "-")}</td>
  <td class="num">${escapeHtml(rtt)}</td>
  <td>${escapeHtml(linkText)}</td>
  <td class="dim">${extra}</td>
</tr>`;
        }).join("");
        return `<details class="room-card live" open>
  <summary>
    <span class="badge-code">${escapeHtml(room.code)}</span>
    <span class="dot dot-on"></span><span class="live-word">在线</span>
    <span class="room-meta">${room.runtime === "client" ? "🖥 客户端" : "🌐 网页"} v${escapeHtml(room.version || "?")} · 已持续 ${fmtDuration(Math.round((Date.now() - Date.parse(room.createdAt)) / 1000))} · 当前 ${(room.members ?? []).filter((m) => !m.leftAt).length} 人</span>
    <span class="chev">▶</span>
  </summary>
  <div class="room-body">
    <table><thead><tr><th>成员</th><th>状态</th><th>加入</th><th>离开</th><th>延迟(RTT)</th><th>接入</th><th>其它</th></tr></thead><tbody>${rows}</tbody></table>
  </div>
</details>`;
      }).join("");

  // 闪断/刷新记录（<15 秒且峰值 ≤1）默认隐藏，避免刷屏
  const flash = history.sessions.filter((s) => (s.duration_s ?? 0) < 15 && (s.peak_members ?? 0) <= 1);
  const realSessions = history.sessions.filter((s) => !flash.includes(s));
  const flashNote = flash.length ? `<p class="summary">另有 ${flash.length} 条刷新/秒开秒关产生的空记录未显示。</p>` : "";

  const historyRows = realSessions.map((s) => {
    const memberRows = (s.members ?? []).map((m) => {
      const rtt = m.rtt_avg_ms != null ? `${m.rtt_avg_ms}ms（峰值 ${m.rtt_max_ms ?? "-"}）` : "-";
      const linkText = m.link === "relay" ? "经中继" : m.link === "direct" ? "公网直连" : m.link === "lan" ? "局域网" : m.link === "self" ? "房主本人" : m.link || "-";
      return `<tr>
  <td><b>${escapeHtml(m.name || "-")}</b> <code>${escapeHtml(String(m.member_key).slice(0, 8))}</code></td>
  <td>${escapeHtml(formatLocalTime(m.joined_at))}</td>
  <td>${escapeHtml(m.left_at ? formatLocalTime(m.left_at) : "未记录")}</td>
  <td class="num">${fmtDuration(m.duration_s)}</td>
  <td class="num">${escapeHtml(rtt)}</td>
  <td>${escapeHtml(linkText)}</td>
  <td class="dim">抖动 ${escapeHtml(String(m.jitter_avg_ms ?? 0))}ms · 丢包 ${escapeHtml(String(m.loss_pct ?? 0))}% · 重连 ${escapeHtml(String(m.reconnects ?? 0))} · 说话 ${fmtDuration(m.speaking_s)}</td>
</tr>`;
    }).join("");
    const eventRows = (s.events ?? []).map((e) => `<div class="ev">· ${escapeHtml(formatLocalTime(e.at))} ${escapeHtml(e.kind)} — ${escapeHtml(e.detail || "")}</div>`).join("");
    const curve = (s.samples ?? []).map((p) => `${formatLocalTime(p.at).slice(5, 16)} ${p.members}人`).join(" · ");
    const endedBad = s.ended_at ? "" : ' <span class="tag tag-warn">未正常结束</span>';
    return `<details class="room-card done">
  <summary>
    <span class="badge-code">${escapeHtml(s.code)}</span>
    <span class="dot dot-off"></span>
    <span class="room-meta">${escapeHtml(formatLocalTime(s.created_at))} → ${s.ended_at ? escapeHtml(formatLocalTime(s.ended_at)) : "进行中"} · ${fmtDuration(s.duration_s)} · 峰值 ${s.peak_members ?? "?"} 人 · 成员 ${s.members?.length ?? 0}${endedBad}</span>
    <span class="chev">▶</span>
  </summary>
  <div class="room-body">
    ${memberRows ? `<table><thead><tr><th>成员</th><th>加入</th><th>离开</th><th>在房</th><th>延迟(RTT)</th><th>接入</th><th>其它</th></tr></thead><tbody>${memberRows}</tbody></table>` : '<p class="summary">该会话没有成员记录（打开后很快关闭）。</p>'}
    ${curve ? `<p class="summary curve">人数曲线：${escapeHtml(curve)}</p>` : ""}
    ${eventRows ? `<p class="summary">事件流水：${eventRows}</p>` : ""}
  </div>
</details>`;
  }).join("");

  const dailyChips = history.daily.map((d) => `<span class="kv">${escapeHtml(d.day)} · ${d.sessions} 场 · 峰值合计 ${d.peak_total ?? 0} 人</span>`).join(" ");

  return `<p class="page-sub">实时数据来自房主的信令连接（断开即离线，秒级）；历史档案保留 30 天。排障：让用户报<b>房间号 + 大概时间</b>，在下面搜索即可调出整段记录。</p>
<div class="stats">
  <div class="stat"><span class="ico ico-live">🏠</span><span class="big">${live.length}</span><span class="label">在线房间</span></div>
  <div class="stat"><span class="ico ico-people">👥</span><span class="big">${liveMembers}</span><span class="label">在线人数</span></div>
  <div class="stat"><span class="ico ico-share">📺</span><span class="big">${sharing}</span><span class="label">正在共享屏幕</span></div>
</div>
<form method="get" class="searchbar">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <input type="text" name="code" value="${escapeHtml(code)}" placeholder="按房间号搜索，如 7490" />
  <button type="submit" class="vx-btn-small btn-accent">搜索</button>
  <a class="export-btn" href="/rooms/export?token=${encodeURIComponent(token)}">⬇ 导出全部历史 CSV</a>
</form>
<div class="sec-title">在线房间（点开看成员明细）</div>
${liveCards}
<div class="sec-title">每日汇总（近 14 天）</div>
<p class="chips">${dailyChips || '<span class="kv">暂无数据</span>'}</p>
<div class="sec-title">历史房间（${realSessions.length} 场${code ? ` · 按房间号「${escapeHtml(code)}」过滤` : ""}）</div>
${historyRows || '<div class="empty-box"><div class="empty-emoji">🗂️</div>还没有历史房间<br><span class="empty-sub">房主正常关房后，这里会出现完整档案（含每个成员的进出与网络质量）</span></div>'}
<p class="summary"><a class="export-btn" href="/rooms/export?token=${encodeURIComponent(token)}">⬇ 导出全部历史 CSV</a></p>`;
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


// ============================================================ 开黑圈权限（内联）
/**
 * 开黑圈创建权限（Pages Functions 的 /game/entitle 与 /game-admin）。
 *
 * 安全模型：
 * - 主令牌（FEEDBACK_TOKEN）只留在业主手里，用来**签发员工令牌**；
 * - 员工令牌只存哈希（staff_tokens 表），scope=game，只能生成/吊销创建码；
 * - 创建码只存 D1（不落前端），前端通过 /game/entitle 换一枚 30 天签名令牌；
 * - 任何密钥都不下发前端，前端只拿 HMAC 签名结果。
 */

const GAME_DAY = 86_400_000;

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function gameRandomToken(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function entitlementSecret(env) {
  return env.GAME_SECRET || env.FEEDBACK_TOKEN || "";
}

/** POST /game/entitle { code } → { token, expiresAt } */
async function handleGameEntitle(request, env) {
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const secret = entitlementSecret(env);
  if (!secret) return json({ error: "服务未配置" }, 501);
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const code = String(payload?.code ?? "").trim().toUpperCase();
  if (!/^BLONG-[A-Z0-9]{4,12}$/.test(code)) return json({ error: "invalid code" }, 403);
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT code, uses_left, expires_at, revoked FROM game_codes WHERE code = ?",
  )
    .bind(code)
    .first();
  if (!row || row.revoked || row.expires_at < now || row.uses_left <= 0) {
    return json({ error: "invalid code" }, 403);
  }
  await env.DB.prepare("UPDATE game_codes SET uses_left = uses_left - 1 WHERE code = ?").bind(code).run();
  const expiresAt = now + 30 * GAME_DAY;
  const sig = await hmacHex(secret, `game:${expiresAt}:${code}`);
  const token = `${expiresAt}.${code}.${sig}`;
  await env.DB.prepare(
    "INSERT INTO game_audit (at, actor, action, detail) VALUES (?, ?, ?, ?)",
  )
    .bind(now, code, "activate", `expiresAt=${expiresAt}`)
    .run();
  return json({ token, expiresAt });
}

/** POST /game/verify { token } → { ok } | 403（吊销/次数用尽/过期/签名不符） */
async function handleGameVerify(request, env) {
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const secret = entitlementSecret(env);
  if (!secret) return json({ ok: true, note: "服务未配置" });
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const parts = String(payload?.token ?? "").split(".");
  if (parts.length !== 3) return json({ error: "invalid" }, 403);
  const [expiresAt, code, sig] = parts;
  const expect = await hmacHex(secret, `game:${expiresAt}:${code}`);
  if (sig !== expect || Number(expiresAt) < Date.now()) return json({ error: "invalid" }, 403);
  // 注意：uses_left 只约束"激活次数"（entitle 时扣），不影响已激活令牌的后续校验。
  // 吊销/过期才是校验时要拦的。
  const row = await env.DB.prepare("SELECT expires_at, revoked FROM game_codes WHERE code = ?")
    .bind(code)
    .first();
  if (!row || row.revoked || row.expires_at < Date.now()) {
    return json({ error: "revoked" }, 403);
  }
  return json({ ok: true });
}

/** 校验员工令牌；返回 { role, name } 或 null。主令牌返回 role=main。 */
async function authenticateStaff(url, env) {
  const token = url.searchParams.get("staff") ?? "";
  if (!token) return null;
  if (env.FEEDBACK_TOKEN && safeEqual(token, env.FEEDBACK_TOKEN)) return { role: "main", name: "业主" };
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT name, scope, expires_at, revoked FROM staff_tokens WHERE token_hash = ?",
  )
    .bind(hash)
    .first();
  if (!row || row.revoked) return null;
  if (row.expires_at && row.expires_at < Date.now()) return null;
  if (!String(row.scope ?? "").includes("game")) return null;
  return { role: "staff", name: row.name || "运营" };
}

/**
 * 账号后台：/accounts-admin?staff=TOKEN
 *
 * 业主需求（2026-10-26）：列出用户名 / 昵称 / 认领的房号，能在后台改房号、改数字 ID。
 * 三条硬规矩：
 *   1. **永不显示密码**：SQL 里就不选 salt/hash，页面上也没有任何"查看密码"的入口
 *      （哈希本来就不可逆，能"看到"的只可能是被拖库的东西）；
 *   2. 改房号要绕过"每个账号只能改一次"的用户限制——这是管理员的特权，
 *      改完仍保持锁定状态，且会写审计；
 *   3. 改数字 ID 是账号主键，会级联到好友/请求/会话/在线/邀请，只在 main 令牌下允许，
 *      用 D1 batch（一个事务）做完，避免改一半。
 */
const ADMIN_ID_RE = /^\d{8}$/;

async function adminAudit(env, actor, action, target, detail) {
  try {
    await env.DB.prepare(
      "INSERT INTO admin_audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(Date.now(), actor, action, target, detail)
      .run();
  } catch {
    // 审计表缺失也不能挡住操作（老库没建表时）
  }
}

/** GET/POST /accounts-admin?staff=TOKEN */
async function handleAccountsAdmin(request, env) {
  try {
    return await accountsAdminInner(request, env);
  } catch (error) {
    return adminPage(
      "账号后台 · 出错",
      `<pre>${escapeHtml(String((error && error.stack) || error))}</pre>`,
      500,
    );
  }
}

async function accountsAdminInner(request, env) {
  const url = new URL(request.url);
  const who = await authenticateStaff(url, env);
  if (!who) {
    return adminPage("账号后台 · 无权访问", "<p>令牌无效或已被吊销。</p>", 401);
  }
  // flash 走 URL（PRG 模式：POST 后 303 回来，刷新不会重复提交）
  const flash = (url.searchParams.get("flash") ?? "").split("|").filter(Boolean);
  const tokenQuery = `?staff=${encodeURIComponent(url.searchParams.get("staff") ?? "")}`;

  if (request.method === "POST") {
    const form = await request.formData();
    const action = String(form.get("action") ?? "");
    const id = String(form.get("id") ?? "").trim();

    if (action === "set_room") {
      const raw = String(form.get("code") ?? "").trim();
      const clear = form.get("clear") === "1" || raw === "";
      if (clear) {
        await env.DB.prepare(
          "UPDATE accounts SET room_code = NULL, room_code_at = NULL, room_changes = 0, updated_at = ? WHERE id = ?",
        )
          .bind(Date.now(), id)
          .run();
        await adminAudit(env, who.name, "room_clear", id, "管理员清空固定房号（号回池）");
        flash.push(`已清空 ${id} 的房号，这个号回到池子里`);
      } else if (!/^\d{6}$/.test(raw)) {
        flash.push("房号必须是 6 位数字");
      } else {
        const occupied = await env.DB.prepare(
          "SELECT id FROM accounts WHERE room_code = ? AND id <> ?",
        )
          .bind(raw, id)
          .first();
        if (occupied) {
          flash.push(`房号 ${raw} 已被账号 ${occupied.id} 认领，先清掉那边`);
        } else {
          await env.DB.prepare(
            "UPDATE accounts SET room_code = ?, room_code_at = ?, room_changes = 1, updated_at = ? WHERE id = ?",
          )
            .bind(raw, Date.now(), Date.now(), id)
            .run();
          await adminAudit(env, who.name, "room_set", id, `管理员把房号改成 ${raw}`);
          flash.push(`已把 ${id} 的房号改成 ${raw}`);
        }
      }
    }

    if (action === "set_id") {
      if (who.role !== "main") {
        flash.push("只有业主令牌能改数字 ID");
      } else {
        const next = String(form.get("newid") ?? "").trim();
        if (!ADMIN_ID_RE.test(next)) {
          flash.push("新数字 ID 必须是 8 位数字");
        } else if (next === id) {
          flash.push("新旧 ID 一样，什么都没做");
        } else {
          const taken = await env.DB.prepare("SELECT 1 AS x FROM accounts WHERE id = ?")
            .bind(next)
            .first();
          if (taken) {
            flash.push(`数字 ID ${next} 已被占用`);
          } else {
            await env.DB.batch([
              env.DB.prepare("UPDATE account_sessions SET account_id = ? WHERE account_id = ?").bind(next, id),
              env.DB.prepare("UPDATE friendships SET account_id = ? WHERE account_id = ?").bind(next, id),
              env.DB.prepare("UPDATE friendships SET friend_id = ? WHERE friend_id = ?").bind(next, id),
              env.DB.prepare("UPDATE friend_requests SET from_id = ? WHERE from_id = ?").bind(next, id),
              env.DB.prepare("UPDATE friend_requests SET to_id = ? WHERE to_id = ?").bind(next, id),
              env.DB.prepare("UPDATE room_invites SET from_id = ? WHERE from_id = ?").bind(next, id),
              env.DB.prepare("UPDATE room_invites SET to_id = ? WHERE to_id = ?").bind(next, id),
              // presence 是主键，先把旧行删掉再插新的，避免主键冲突
              env.DB.prepare("DELETE FROM account_presence WHERE account_id = ?").bind(id),
              // prev_id：客户端下次 /me 会拿到它，用来把本机 roomKey 迁到新 ID
              env.DB.prepare("UPDATE accounts SET id = ?, prev_id = ?, updated_at = ? WHERE id = ?").bind(
                next,
                id,
                Date.now(),
                id,
              ),
            ]);
            await adminAudit(env, who.name, "id_set", id, `管理员把数字 ID 改成 ${next}`);
            flash.push(`已把数字 ID ${id} 改成 ${next}（好友与会话已同步）`);
          }
        }
      }
    }

    return new Response(null, {
      status: 303,
      headers: {
        location: `/accounts-admin${tokenQuery}${
          flash.length ? `&flash=${encodeURIComponent(flash.join("|"))}` : ""
        }`,
      },
    });
  }

  const rows =
    (
      await env.DB.prepare(
        "SELECT a.id, a.username, a.name, a.room_code, a.room_changes, a.created_at, " +
          "p.last_seen, p.room_code AS live_room FROM accounts a " +
          "LEFT JOIN account_presence p ON p.account_id = a.id ORDER BY a.created_at DESC LIMIT 200",
      ).all()
    ).results ?? [];

  const now = Date.now();
  const fmt = (ms) => (ms ? new Date(Number(ms)).toLocaleString("zh-CN", { hour12: false }) : "—");
  const online = (last) => last && now - Number(last) < 3 * 60_000;

  const body = rows.length
    ? `<table class="a-table">
  <thead><tr>
    <th>数字 ID</th><th>用户名</th><th>昵称</th><th>认领房号</th><th>状态</th><th>注册</th><th>操作</th>
  </tr></thead>
  <tbody>
  ${rows
    .map((row) => {
      const locked = Boolean(row.room_code) && Number(row.room_changes ?? 0) >= 1;
      return `<tr>
    <td><code>${escapeHtml(row.id)}</code></td>
    <td>${escapeHtml(row.username ?? "")}</td>
    <td>${escapeHtml(row.name ?? "")}</td>
    <td>${
      row.room_code
        ? `<b class="a-room">${escapeHtml(row.room_code)}</b>${locked ? ' <span class="a-tag">已锁定</span>' : ' <span class="a-tag a-tag-ok">可改一次</span>'}`
        : '<span class="a-empty">未认领</span>'
    }</td>
    <td>${
      online(row.last_seen)
        ? `在线${row.live_room ? ` · 在 ${escapeHtml(row.live_room)} 房` : ""}`
        : `<span class="a-empty">离线${row.last_seen ? ` · ${fmt(row.last_seen)}` : ""}</span>`
    }</td>
    <td class="a-when">${fmt(row.created_at)}</td>
    <td class="a-ops">
      <form method="post">
        <input type="hidden" name="action" value="set_room" />
        <input type="hidden" name="id" value="${escapeHtml(row.id)}" />
        <input class="a-input" name="code" maxlength="6" inputmode="numeric" placeholder="6 位房号"
               value="${escapeHtml(row.room_code ?? "")}" />
        <button>改房号</button>
        <button name="clear" value="1" class="a-ghost">清空回池</button>
      </form>
      ${
        who.role === "main"
          ? `<form method="post" class="a-idform">
        <input type="hidden" name="action" value="set_id" />
        <input type="hidden" name="id" value="${escapeHtml(row.id)}" />
        <input class="a-input" name="newid" maxlength="8" inputmode="numeric" placeholder="新 8 位 ID" />
        <button class="a-danger">改数字 ID</button>
      </form>`
          : `<span class="a-empty">改数字 ID 需要业主令牌</span>`
      }
    </td>
  </tr>`;
    })
    .join("\n")}
  </tbody>
</table>`
    : '<p class="a-empty">还没有账号。注册后这里会出现。</p>';

  const content = `
<style>
  .a-summary { color: #6b6257; margin: 0 0 14px; }
  .a-table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3ded4; border-radius: 12px; overflow: hidden; }
  .a-table th, .a-table td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #f0ebe2; vertical-align: middle; font-size: 13.5px; }
  .a-table th { background: #faf7f1; font-weight: 600; color: #5b5348; white-space: nowrap; }
  .a-table tr:last-child td { border-bottom: none; }
  .a-room { font-family: ui-monospace, Menlo, monospace; font-size: 15px; letter-spacing: .06em; }
  .a-tag { background: #f1e6cf; color: #8a5b1c; border-radius: 999px; padding: 1px 8px; font-size: 11.5px; white-space: nowrap; }
  .a-tag-ok { background: #e2f0e4; color: #2f6b3a; }
  .a-when { color: #8a8175; font-size: 12.5px; white-space: nowrap; }
  .a-empty { color: #9a9186; font-size: 12.5px; }
  .a-ops { display: flex; flex-direction: column; gap: 6px; }
  .a-ops form { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .a-input { width: 108px; border: 1px solid #d8cfc0; border-radius: 8px; padding: 5px 8px; font-size: 13px; background: #fffdf9; }
  .a-ghost { color: #8a5b1c; }
  .a-danger { border-color: #e0b4ac; color: #9c3222; }
  .a-flash { background: #fdf6e6; border: 1px solid #ecdcb4; border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; }
  .a-flash div + div { margin-top: 4px; }
</style>
<p class="a-summary">共 ${rows.length} 个账号 · 以 ${escapeHtml(who.name)}（${who.role === "main" ? "业主" : "员工"}）身份查看 · <b>密码不在此页展示（数据库里只有不可逆哈希）</b></p>
${flash.length ? `<div class="a-flash">${flash.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>` : ""}
${body}`;

  return adminPage("账号后台", content, 200);
}

/** GET/POST /game-admin?staff=TOKEN */
async function handleGameAdmin(request, env) {
  try {
    return await handleGameAdminInner(request, env);
  } catch (error) {
    return adminPage("开黑圈运营 · 出错", `<pre>${String((error && error.stack) || error)}</pre>`, 500);
  }
}

async function handleGameAdminInner(request, env) {
  const url = new URL(request.url);
  const who = await authenticateStaff(url, env);
  if (!who) {
    return adminPage("开黑圈运营 · 无权访问", "<p>令牌无效或已被吊销。</p>", 401);
  }
  const flash = [];
  const urlFlash = url.searchParams.get("flash");
  if (urlFlash) flash.push(urlFlash);
  if (request.method === "POST") {
    const form = await request.formData();
    const action = String(form.get("action") ?? "");
    if (action === "new_code") {
      const uses = Math.max(1, Math.min(50, Number(form.get("uses") ?? 1)));
      const days = Math.max(1, Math.min(365, Number(form.get("days") ?? 30)));
      const note = String(form.get("note") ?? "").slice(0, 60);
      const code = `BLONG-${gameRandomToken(3).toUpperCase()}`;
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO game_codes (code, note, uses_left, expires_at, revoked, created_at, created_by) VALUES (?, ?, ?, ?, 0, ?, ?)",
      )
        .bind(code, note, uses, now + days * GAME_DAY, now, who.name)
        .run();
      await env.DB.prepare("INSERT INTO game_audit (at, actor, action, detail) VALUES (?, ?, ?, ?)")
        .bind(now, who.name, "new_code", `${code} uses=${uses} days=${days}`)
        .run();
      flash.push(`<div class="g-newcode"><span class="g-newcode-label">🎟 新创建码</span><code class="g-newcode-code">${code}</code><button type="button" class="g-copy" data-code="${code}">复制</button><span class="g-newcode-meta">${uses} 次 · ${days} 天 · 只显示这一次</span></div>`);
    }
    if (action === "revoke_code") {
      const code = String(form.get("code") ?? "");
      await env.DB.prepare("UPDATE game_codes SET revoked = 1 WHERE code = ?").bind(code).run();
      await env.DB.prepare("INSERT INTO game_audit (at, actor, action, detail) VALUES (?, ?, ?, ?)")
        .bind(Date.now(), who.name, "revoke_code", code)
        .run();
      flash.push(`已吊销 ${code}`);
    }
    if (action === "new_staff" && who.role === "main") {
      const name = String(form.get("name") ?? "运营").slice(0, 20);
      const token = gameRandomToken(24);
      const hash = await sha256Hex(token);
      await env.DB.prepare(
        "INSERT INTO staff_tokens (id, name, scope, token_hash, created_at, expires_at, revoked) VALUES (?, ?, 'game', ?, ?, ?, 0)",
      )
        .bind(gameRandomToken(6), name, hash, Date.now(), Date.now() + 90 * GAME_DAY)
        .run();
      const staffUrl = `${url.origin}/game-admin?staff=${token}`;
      flash.push(`<div class="g-newcode g-staffcard"><span class="g-newcode-label">👤 员工令牌（${name}）· 90 天</span><code class="g-newcode-code">${token.slice(0, 8)}…</code><button type="button" class="g-copy" data-code="${staffUrl}">复制登录链接</button><span class="g-newcode-meta">把复制的完整链接发给对方即可，只显示这一次</span></div>`);
    }
    if (action === "revoke_staff" && who.role === "main") {
      const id = String(form.get("id") ?? "");
      await env.DB.prepare("UPDATE staff_tokens SET revoked = 1 WHERE id = ?").bind(id).run();
    }
    // PRG：POST 处理完 302 回本页（提示随参数带回），刷新永远不会重复提交（业主实测踩坑）
    return new Response(null, {
      status: 302,
      headers: { location: url.pathname + "?staff=" + encodeURIComponent(url.searchParams.get("staff") ?? "") + "&flash=" + encodeURIComponent(flash.join("<br/>")) },
    });
  }

  const codes = (await env.DB.prepare("SELECT * FROM game_codes ORDER BY created_at DESC LIMIT 30").all()).results ?? [];
  const staff = who.role === "main"
    ? (await env.DB.prepare("SELECT id, name, scope, created_at, expires_at, revoked FROM staff_tokens ORDER BY created_at DESC LIMIT 20").all()).results ?? []
    : [];
  const audit = (await env.DB.prepare("SELECT * FROM game_audit ORDER BY at DESC LIMIT 30").all()).results ?? [];

  /*
   * 业主口径（重要）：**已用完 ≠ 吊销**。
   * 次数用尽的码仍然"有效"——已激活的设备还能继续建房，只是不能再激活新设备；
   * 因此它留在"有效"区（状态显示"已用完"），并且**随时可以吊销**（吊销会让已激活令牌失效）。
   */
  const valid = codes.filter((row) => !row.revoked && row.expires_at >= Date.now());
  const gone = codes.filter((row) => row.revoked || row.expires_at < Date.now());
  const codeRow = (row, canRevoke) =>
    `<tr><td><code>${row.code}</code></td><td>${row.note ?? ""}</td><td>${row.uses_left}</td>
      <td>${cnTime(row.expires_at)}</td><td>${row.revoked ? "已吊销" : row.uses_left <= 0 ? "已用完" : "有效"}</td>
      <td>${canRevoke ? `<form method="post" style="display:inline"><input type="hidden" name="action" value="revoke_code"/>
        <input type="hidden" name="code" value="${row.code}"/><button class="g-revoke" type="submit">吊销</button></form>` : ""}</td></tr>`;
  const codeRows = valid.map((row) => codeRow(row, true)).join("");
  const staffRows = staff
    .map(
      (row) => `<tr><td>${row.name}</td><td>${row.scope}</td><td>${cnTime(row.expires_at)}</td>
      <td>${row.revoked ? "已吊销" : "有效"}</td>
      <td><form method="post" style="display:inline"><input type="hidden" name="action" value="revoke_staff"/>
        <input type="hidden" name="id" value="${row.id}"/><button type="submit">吊销</button></form></td></tr>`,
    );
  const auditRows = audit
    .map((row) => `<tr><td>${cnTime(row.at)}</td><td>${row.actor}</td><td>${row.action}</td><td>${row.detail ?? ""}</td></tr>`);

  const totalCodes = codes.length;
  const totalActivated = (audit.filter((row) => row.action === "activate").length) || 0;
  const rowsHead = (rows, visible = 5) => rows.slice(0, visible).join("");
  const CODE_HEAD = "<tr><th>码</th><th>备注</th><th>剩余次数</th><th>到期</th><th>状态</th><th>操作</th></tr>";
  const STAFF_HEAD = "<tr><th>名字</th><th>权限</th><th>到期</th><th>状态</th><th>操作</th></tr>";
  const AUDIT_HEAD = "<tr><th>时间</th><th>操作者</th><th>动作</th><th>详情</th></tr>";
  const rowsRest = (rows, visible, head) => {
    const rest = rows.slice(visible);
    return rest.length
      ? `<details><summary>展开其余 ${rest.length} 条</summary><table>${head}${rest.join("")}</table></details>`
      : "";
  };

  const html = `
    <style>
      .g-form { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 8px 0 16px; }
      .g-form label { font-size: 13px; color: #6b532c; }
      .g-form input { border: 1px solid #d8cba8; border-radius: 8px; padding: 6px 9px; background: #fffdf7; }
      .g-form button { border: none; border-radius: 999px; padding: 7px 16px; background: #a4762c; color: #fff; cursor: pointer; }
      .g-flash { background: #faeeda; border: 0.5px solid #d8b98a; color: #6b532c; padding: 10px 14px; border-radius: 10px; }
      .g-badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; }
      .g-ok { background: #eaf3de; color: #3b6d11; }
      .g-dead { background: #f1efe8; color: #8a744a; }
      .g-revoke { background: none; border: 1px solid #d8b98a; color: #a4762c; border-radius: 8px; padding: 4px 10px; cursor: pointer; }
      .g-newcode { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; width: fit-content; max-width: 100%; background: #fdf6e3; border: 1px solid #d8b98a; border-radius: 999px; padding: 7px 14px 7px 12px; margin: 0 0 10px; }
      .g-newcode-label { font-size: 13px; color: #8a744a; }
      .g-newcode-code { font-size: 17px; font-weight: 700; letter-spacing: 0.05em; color: #6b532c; background: #fffdf7; border: 1px solid #e0d3b4; border-radius: 8px; padding: 3px 10px; }
      .g-copy { background: #a4762c; color: #fff; border: none; border-radius: 999px; padding: 5px 13px; font-size: 12.5px; cursor: pointer; }
      .g-copy:hover { background: #8a6222; }
      .g-newcode-meta { font-size: 12px; color: #a08d68; }
      details { margin: 6px 0 10px; }
      summary { cursor: pointer; font-size: 13px; color: #8a744a; padding: 6px 2px; }
      summary:hover { color: #a4762c; }
      details table { margin: 6px 0 14px; }
    </style>
    ${(() => {
      const cards = flash.filter((line) => line.includes("g-newcode"));
      const lastCode = cards.filter((line) => !line.includes("g-staffcard")).pop() ?? "";
      const lastStaff = cards.filter((line) => line.includes("g-staffcard")).pop() ?? "";
      const others = flash.filter((line) => !line.includes("g-newcode"));
      return lastCode + lastStaff + others.map((line) => `<p class="g-flash">${line}</p>`).join("");
    })()}
    <script>
      document.addEventListener("click", function (event) {
        var btn = event.target.closest ? event.target.closest(".g-copy") : null;
        if (!btn) return;
        navigator.clipboard.writeText(btn.dataset.code).then(function () {
          btn.textContent = "已复制";
          setTimeout(function () { btn.textContent = "复制"; }, 1500);
        });
      });
    </script>
    <p class="page-sub">创建码由你或运营发放；群友激活后 30 天内可以创建开黑圈。吊销立即生效。</p>
    <div class="stats">
      <div class="stat"><span class="ico ico-live">🎟️</span><span class="big">${valid.length}</span><span class="label">有效创建码</span></div>
      <div class="stat"><span class="ico ico-people">🧾</span><span class="big">${totalCodes}</span><span class="label">累计生成</span></div>
      <div class="stat"><span class="ico ico-share">✅</span><span class="big">${totalActivated}</span><span class="label">累计激活</span></div>
    </div>
    <div class="sec-title">生成创建码</div>
    <form method="post" class="g-form">
      <input type="hidden" name="action" value="new_code"/>
      <label>次数 <input name="uses" value="1" size="3"/></label>
      <label>有效天数 <input name="days" value="30" size="3"/></label>
      <label>备注 <input name="note" placeholder="给谁用" size="14"/></label>
      <button type="submit" class="vx-btn-small btn-accent">生成</button>
    </form>
    <div class="sec-title">创建码 · 有效（${valid.length}）</div>
    ${valid.length ? `<table>${"<tr><th>码</th><th>备注</th><th>剩余次数</th><th>到期</th><th>状态</th><th>操作</th></tr>"}${rowsHead(valid.map((row) => codeRow(row, true)))}</table>${rowsRest(valid.map((row) => codeRow(row, true)), 5, CODE_HEAD)}` : '<div class="empty-box"><div class="empty-emoji">🎟️</div>还没有有效码<br><span class="empty-sub">在上面生成一条，发给要开黑的群友</span></div>'}
    <div class="sec-title">创建码 · 已吊销 / 已过期（${gone.length}）</div>
    ${gone.length ? `<table>${"<tr><th>码</th><th>备注</th><th>剩余次数</th><th>到期</th><th>状态</th><th>操作</th></tr>"}${rowsHead(gone.map((row) => codeRow(row, false)))}</table>${rowsRest(gone.map((row) => codeRow(row, false)), 5, CODE_HEAD)}` : '<span class="kv">暂无</span>'}
    ${who.role === "main" ? `<div class="sec-title">新增员工（仅主令牌）</div>
      <form method="post" class="g-form"><input type="hidden" name="action" value="new_staff"/>
        <label>名字 <input name="name" placeholder="运营-小王" size="12"/></label>
        <button type="submit" class="vx-btn-small btn-accent">生成员工令牌</button></form>
      <div class="sec-title">员工（${staff.length}）</div>
      ${staff.length ? `<table><tr><th>名字</th><th>权限</th><th>到期</th><th>状态</th><th></th></tr>${rowsHead(staffRows)}</table>${rowsRest(staffRows, 5, STAFF_HEAD)}` : '<span class="kv">还没有员工</span>'}` : ""}
    <div class="sec-title">操作日志（${audit.length}）</div>
    ${audit.length ? `<table><tr><th>时间</th><th>操作者</th><th>动作</th><th>详情</th></tr>${rowsHead(auditRows)}</table>${rowsRest(auditRows, 5, AUDIT_HEAD)}` : '<span class="kv">暂无</span>'}
  `;
  return adminPage(`开黑圈运营 · ${who.name}`, html);
}



// ---------------------------------------------------------------------------
// /api/account/* —— 账号 / 好友 / 固定房号（D1）
//
// 为什么和静态站同域：网页端不需要 CORS、cookie 是 first-party（httpOnly 才真的
// 防 XSS 偷令牌）；桌面端（tauri.localhost）跨域，这里按 Origin 回 ARC + credentials
// 兜住，另外还接受 Authorization: Bearer（WebView2 对第三方 cookie 不稳）。
//
// 数据口径见 worker/accounts-schema.sql：账号主键是 8 位数字 ID，
// 「我的房间」的房号是 accounts.room_code，绑在这个 ID 上。
// ---------------------------------------------------------------------------

const ACCOUNT_PREFIX = "/api/account";
const SESSION_COOKIE = "5blong_sess";
const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** 心跳超过这个时间没更新就算离线（客户端 30 秒一跳，留两倍容差）。 */
const PRESENCE_ONLINE_MS = 75_000;
const MAX_AVATAR_CHARS = 120_000;
/**
 * PBKDF2-SHA256 迭代次数。
 *
 * ⚠️ Workers **硬上限是 100000**：超过就直接抛
 * `Pbkdf2 failed: iteration counts above 100000 are not supported`，
 * 而这句话会被下面的 try 吞成一句 "internal"（2026-10-26 线上注册全 500 的根因）。
 * 取上限值；哈希串里自带次数（pbkdf2$<rounds>$<hex>），将来调整不影响老密码。
 */
const PBKDF2_ROUNDS = 100_000;

function accountCorsHeaders(request) {
  const origin = request.headers.get("Origin");
  const self = new URL(request.url).origin;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  /*
   * 带 cookie 的跨域请求不允许 ACAO: *，必须回显具体 Origin。
   * 同源请求（浏览器不带 Origin）不需要 ACAO，带上反而容易被误判成宽松策略。
   */
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  void self;
  return headers;
}

function accountJson(request, data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...accountCorsHeaders(request), ...extraHeaders },
  });
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie");
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

function sessionCookie(request, token, maxAgeSeconds) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

const hexOf = (buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function randomHex(bytes) {
  return hexOf(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}

/**
 * 生成密码哈希：`pbkdf2$<迭代次数>$<hex>`。
 *
 * 为什么把迭代次数写进串里：Workers 免费计划有 CPU 时间上限，万一 12 万次在线上
 * 被卡（表现为 1102 错误），调低这个常量即可——老用户的哈希自带次数，照样能验过。
 */
async function pbkdf2Hex(password, salt, rounds = PBKDF2_ROUNDS) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: rounds, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2$${rounds}$${hexOf(bits)}`;
}

/** 校验密码：兼容没有前缀的旧格式（纯 hex，按默认次数）。 */
async function verifyPassword(password, salt, stored) {
  const match = /^pbkdf2\$(\d+)\$([0-9a-f]+)$/.exec(String(stored ?? ""));
  if (match) {
    const rounds = Number(match[1]);
    const hash = await pbkdf2Hex(password, salt, rounds);
    return hash === stored;
  }
  const hash = await pbkdf2Hex(password, salt);
  return hash.endsWith(`$${String(stored ?? "")}`) || hash.split("$")[2] === stored;
}

const ACCOUNT_USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{2,15}$/;
const ACCOUNT_ROOM_CODE_RE = /^\d{6}$/;

function toProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    avatar: row.avatar ?? "",
    avatarVersion: row.avatar_version ?? 0,
    createdAt: row.created_at,
    // 固定房号：只有登录账号才有；NULL 时不带这个字段（与客户端契约一致）
    ...(row.room_code ? { roomCode: row.room_code } : {}),
    /*
     * 房号是否已锁死（业主 2026-10-26）：每个账号只有**一次**改号机会，
     * 改完这个号就永久属于该账号，别人抢同一号会被唯一索引挡下。
     */
    roomCodeLocked: Boolean(row.room_code) && Number(row.room_changes ?? 0) >= 1,
    // 只在"刚被改过 ID"时出现：客户端用它迁移本机的房间钥匙
    ...(row.prev_id ? { previousId: row.prev_id } : {}),
  };
}

async function accountById(env, id) {
  return env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
}

async function currentAccount(request, env) {
  const header = request.headers.get("Authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const cookie = readCookie(request, SESSION_COOKIE);
  /*
   * 两个凭据都试一遍：桌面端带 Bearer、网页端靠 cookie，两边都可能只有其中一个有效
   * （比如 WebView2 里的 cookie 被清、或本地令牌写坏了）。
   * 只认第一个会让"另一个其实有效"的用户莫名被登出。
   */
  const candidates = [bearer, cookie].filter((value, index, list) => value && list.indexOf(value) === index);
  for (const token of candidates) {
    const session = await env.DB.prepare(
      "SELECT account_id, expires_at FROM account_sessions WHERE token = ?",
    )
      .bind(token)
      .first();
    if (session && session.expires_at >= Date.now()) return accountById(env, session.account_id);
  }
  return null;
}

async function createSession(request, env, accountId) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO account_sessions (token, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(token, accountId, now + SESSION_TTL_MS, now)
    .run();
  // 顺手清掉这个账号过期的会话，别让表越滚越大
  await env.DB.prepare("DELETE FROM account_sessions WHERE account_id = ? AND expires_at < ?")
    .bind(accountId, now)
    .run();
  return token;
}

/** 8 位数字账号 ID：好友用它加人，也是「我的房间」的绑定键。 */
async function makeAccountId(env) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // 账号 ID 是主键也是加好友的凭据之一，别用可预测的 Math.random
    const bucket = crypto.getRandomValues(new Uint32Array(1))[0] % 90_000_000;
    const id = String(10_000_000 + bucket);
    const taken = await env.DB.prepare("SELECT 1 AS x FROM accounts WHERE id = ?").bind(id).first();
    if (!taken) return id;
  }
  // 极端情况（号池快满）：退回时间戳后 8 位，仍保证唯一性检查
  return String(Date.now()).slice(-8);
}

function clampName(value) {
  return String(value ?? "").trim().slice(0, 24);
}

async function accountRegister(request, env) {
  const body = await request.json().catch(() => null);
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  if (!ACCOUNT_USERNAME_RE.test(username)) return accountJson(request, { error: "username-invalid" }, 400);
  if (password.length < 8 || password.length > 64 || new Set(password).size < 4) {
    return accountJson(request, { error: "password-weak" }, 400);
  }
  const taken = await env.DB.prepare("SELECT 1 AS x FROM accounts WHERE lower(username) = lower(?)")
    .bind(username)
    .first();
  if (taken) return accountJson(request, { error: "username-taken" }, 409);

  const id = await makeAccountId(env);
  const salt = randomHex(16);
  const hash = await pbkdf2Hex(password, salt);
  const now = Date.now();
  const name = clampName(body?.name) || username;
  await env.DB.prepare(
    "INSERT INTO accounts (id, username, name, salt, hash, avatar, avatar_version, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, '', 0, ?, ?)",
  )
    .bind(id, username, name, salt, hash, now, now)
    .run();
  const token = await createSession(request, env, id);
  const row = await accountById(env, id);
  return accountJson(request, { account: toProfile(row), token }, 200, {
    "Set-Cookie": sessionCookie(request, token, Math.floor(SESSION_TTL_MS / 1000)),
  });
}

async function accountLogin(request, env) {
  const body = await request.json().catch(() => null);
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE lower(username) = lower(?)")
    .bind(username)
    .first();
  // 账号不存在与密码错给同一个错误，不泄漏"这个名字注册过"
  if (!row) return accountJson(request, { error: "bad-credentials" }, 401);
  if (!(await verifyPassword(password, row.salt, row.hash))) {
    return accountJson(request, { error: "bad-credentials" }, 401);
  }
  const token = await createSession(request, env, row.id);
  return accountJson(request, { account: toProfile(row), token }, 200, {
    "Set-Cookie": sessionCookie(request, token, Math.floor(SESSION_TTL_MS / 1000)),
  });
}

async function accountLogout(request, env) {
  const header = request.headers.get("Authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const token = bearer || readCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare("DELETE FROM account_sessions WHERE token = ?").bind(token).run();
  }
  return accountJson(request, { ok: true }, 200, {
    "Set-Cookie": sessionCookie(request, "", 0),
  });
}

/**
 * 客户端迁完本机房间钥匙后调一次，清掉 prev_id。
 * 不清的问题：每次 /me 都会带着旧 ID，客户端反复尝试迁移（幂等但多余），
 * 账号面板也会一直提示"ID 变过"。
 */
async function accountAckIdChange(request, env) {
  const me = await currentAccount(request, env);
  if (!me) return accountJson(request, { ok: false }, 401);
  await env.DB.prepare("UPDATE accounts SET prev_id = NULL WHERE id = ?").bind(me.id).run();
  return accountJson(request, { ok: true }, 200);
}

/**
 * 公开查询：这个房号是否已被某账号认领。
 *
 * 只回 true/false，**不返回归属人**——开临时房的人只需要知道"要不要换一个号"。
 * 不需要登录：未注册用户开房同样会查一次，否则"免注册"就得让位给查重。
 */
/** 房间占位的存活时间：客户端 30 秒续一次，留三倍容差（断网/切后台）。 */
const ROOM_HOLD_TTL_MS = 90_000;

/**
 * 占住房号（开房前调；唯一主键保证"同一刻只有一个客户端拿到这个号"）。
 *
 * 规则（业主 2026-10-26）：
 *   1. 号已被某账号认领（accounts.room_code）→ 409 taken，**认领优先**；
 *   2. 号被别的客户端占着且没过期 → 409 busy；
 *   3. 自己占的 / 已过期 / 没人占 → 续期成功。
 * 客户端拿到 409 就换一个号；接口不通则降级照常开（不能为了查重把人挡在门外）。
 */
async function accountHoldRoom(request, env) {
  const body = await request.json().catch(() => null);
  const code = String(body?.code ?? "").trim();
  const token = String(body?.token ?? "").trim();
  if (!ACCOUNT_ROOM_CODE_RE.test(code) || !/^[a-zA-Z0-9_-]{8,64}$/.test(token)) {
    return accountJson(request, { error: "bad request" }, 400);
  }
  const claimed = await env.DB.prepare("SELECT 1 AS x FROM accounts WHERE room_code = ? LIMIT 1")
    .bind(code)
    .first();
  if (claimed) return accountJson(request, { error: "taken" }, 409);

  const now = Date.now();
  const hold = await env.DB.prepare("SELECT token, expires_at FROM room_holds WHERE code = ?")
    .bind(code)
    .first();
  if (hold && hold.expires_at > now && hold.token !== token) {
    return accountJson(request, { error: "busy" }, 409);
  }
  await env.DB.prepare(
    "INSERT INTO room_holds (code, token, expires_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(code) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at",
  )
    .bind(code, token, now + ROOM_HOLD_TTL_MS)
    .run();
  return accountJson(request, { ok: true, code, ttl: ROOM_HOLD_TTL_MS }, 200);
}

/** 关房时释放自己占的号（token 只认自己的，别误放别人的）。 */
async function accountReleaseHold(request, env, url) {
  const token = String(url.searchParams.get("token") ?? "").trim();
  if (!token) return accountJson(request, { ok: false }, 400);
  await env.DB.prepare("DELETE FROM room_holds WHERE token = ?").bind(token).run();
  return accountJson(request, { ok: true }, 200);
}

async function accountRoomClaim(request, env, url) {
  const code = String(url.searchParams.get("code") ?? "").trim();
  if (!ACCOUNT_ROOM_CODE_RE.test(code)) return accountJson(request, { taken: false }, 200);
  const row = await env.DB.prepare("SELECT 1 AS x FROM accounts WHERE room_code = ? LIMIT 1")
    .bind(code)
    .first();
  return accountJson(request, { taken: Boolean(row) }, 200, {
    // 公开只读、随房号变化：让浏览器缓存 10 分钟，省点 D1 读
    "Cache-Control": "public, max-age=600",
  });
}

async function accountUpdateProfile(request, env) {
  const me = await currentAccount(request, env);
  if (!me) return accountJson(request, { error: "not-found" }, 401);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return accountJson(request, { error: "bad json" }, 400);

  const patch = {};
  if (body.username !== undefined) {
    const username = String(body.username).trim();
    if (!ACCOUNT_USERNAME_RE.test(username)) return accountJson(request, { error: "username-invalid" }, 400);
    const taken = await env.DB.prepare(
      "SELECT 1 AS x FROM accounts WHERE lower(username) = lower(?) AND id <> ?",
    )
      .bind(username, me.id)
      .first();
    if (taken) return accountJson(request, { error: "username-taken" }, 409);
    patch.username = username;
  }
  if (body.name !== undefined) {
    const name = clampName(body.name);
    if (name) patch.name = name;
  }
  if (body.avatar !== undefined) {
    const avatar = String(body.avatar ?? "");
    if (avatar.length > MAX_AVATAR_CHARS) return accountJson(request, { error: "avatar too large" }, 413);
    if (avatar && !avatar.startsWith("data:image/")) return accountJson(request, { error: "bad avatar" }, 400);
    patch.avatar = avatar;
  }
  if (body.roomCode !== undefined) {
    /*
     * 「我的房间」绑定账号：房号存在 accounts.room_code，靠唯一索引兜住"一个号只能一个账号"。
     * 只是格式不对 → 用 room-taken 一并回给客户端（客户端文案是同一句"换一个试试"）。
     */
    const roomCode = String(body.roomCode ?? "").trim();
    if (!ACCOUNT_ROOM_CODE_RE.test(roomCode)) return accountJson(request, { error: "room-taken" }, 409);
    // 每个账号只有一次改号机会（业主 2026-10-26）：改过就锁死，前端连入口都不再显示
    if (me.room_code && Number(me.room_changes ?? 0) >= 1) {
      return accountJson(request, { error: "room-locked" }, 409);
    }
    const occupied = await env.DB.prepare(
      "SELECT id FROM accounts WHERE room_code = ? AND id <> ?",
    )
      .bind(roomCode, me.id)
      .first();
    if (occupied) return accountJson(request, { error: "room-taken" }, 409);
    /*
     * 这个号现在正被别人当临时房开着（有未过期的占位）：也不能认领，
     * 否则他一开着、你一认领，同一个号就有两个房主候选了。
     */
    const heldNow = await env.DB.prepare(
      "SELECT 1 AS x FROM room_holds WHERE code = ? AND expires_at > ?",
    )
      .bind(roomCode, Date.now())
      .first();
    if (heldNow) return accountJson(request, { error: "room-taken" }, 409);
    patch.roomCode = roomCode;
    // 已经有号 → 这次就是那唯一一次修改；首次领号不计数
    patch.roomChanges = me.room_code ? 1 : 0;
  }

  const sets = [];
  const values = [];
  if (patch.username !== undefined) {
    sets.push("username = ?");
    values.push(patch.username);
  }
  if (patch.name !== undefined) {
    sets.push("name = ?");
    values.push(patch.name);
  }
  if (patch.avatar !== undefined) {
    sets.push("avatar = ?", "avatar_version = avatar_version + 1");
    values.push(patch.avatar);
  }
  if (patch.roomCode !== undefined) {
    sets.push("room_code = ?", "room_code_at = ?", "room_changes = ?");
    values.push(patch.roomCode, Date.now(), patch.roomChanges ?? 0);
  }
  if (sets.length === 0) return accountJson(request, { account: toProfile(me) }, 200);
  sets.push("updated_at = ?");
  values.push(Date.now(), me.id);
  try {
    await env.DB.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).bind(...values).run();
  } catch (error) {
    // 唯一索引兜底（并发抢同一个房号/用户名）
    const message = String(error?.message ?? "");
    if (message.includes("room_code")) return accountJson(request, { error: "room-taken" }, 409);
    if (message.includes("username")) return accountJson(request, { error: "username-taken" }, 409);
    throw error;
  }
  return accountJson(request, { account: toProfile(await accountById(env, me.id)) }, 200);
}

async function accountSearch(request, env, url) {
  const me = await currentAccount(request, env);
  const keyword = (url.searchParams.get("q") ?? "").trim();
  if (!keyword) return accountJson(request, { accounts: [] }, 200);
  const like = `%${keyword.toLowerCase()}%`;
  const rows = await env.DB.prepare(
    "SELECT * FROM accounts WHERE id <> ? AND (id = ? OR lower(username) LIKE ? OR lower(name) LIKE ?) " +
      "ORDER BY id LIMIT 8",
  )
    .bind(me?.id ?? "", keyword, like, like)
    .all();
  return accountJson(request, { accounts: (rows.results ?? []).map(toProfile) }, 200);
}

async function accountSnapshot(request, env) {
  const me = await currentAccount(request, env);
  if (!me) return accountJson(request, { friends: [], incoming: [], outgoing: [] }, 200);
  const friends = await env.DB.prepare(
    "SELECT a.*, f.since AS since, p.last_seen AS last_seen, p.room_code AS p_room " +
      "FROM friendships f JOIN accounts a ON a.id = f.friend_id " +
      "LEFT JOIN account_presence p ON p.account_id = a.id " +
      "WHERE f.account_id = ? ORDER BY f.since DESC",
  )
    .bind(me.id)
    .all();
  const incoming = await env.DB.prepare(
    "SELECT a.*, r.at AS at FROM friend_requests r JOIN accounts a ON a.id = r.from_id " +
      "WHERE r.to_id = ? ORDER BY r.at DESC",
  )
    .bind(me.id)
    .all();
  const outgoing = await env.DB.prepare(
    "SELECT a.*, r.at AS at FROM friend_requests r JOIN accounts a ON a.id = r.to_id " +
      "WHERE r.from_id = ? ORDER BY r.at DESC",
  )
    .bind(me.id)
    .all();
  const now = Date.now();
  const presence = (row) =>
    row.last_seen && now - row.last_seen <= PRESENCE_ONLINE_MS
      ? { state: "online", lastSeen: row.last_seen, ...(row.p_room ? { roomCode: row.p_room } : {}) }
      : { state: "offline", lastSeen: row.last_seen ?? 0 };
  return accountJson(
    request,
    {
      friends: (friends.results ?? []).map((row) => ({
        account: toProfile(row),
        since: row.since ?? now,
        presence: presence(row),
      })),
      incoming: (incoming.results ?? []).map((row) => ({ account: toProfile(row), at: row.at ?? now })),
      outgoing: (outgoing.results ?? []).map((row) => ({ account: toProfile(row), at: row.at ?? now })),
    },
    200,
  );
}

async function accountAddFriend(request, env) {
  const me = await currentAccount(request, env);
  if (!me) return accountJson(request, { error: "not-found" }, 401);
  const body = await request.json().catch(() => null);
  const targetId = String(body?.id ?? "").trim();
  if (!/^\d{8}$/.test(targetId)) return accountJson(request, { error: "not-found" }, 404);
  if (targetId === me.id) return accountJson(request, { error: "self" }, 400);
  const target = await accountById(env, targetId);
  if (!target) return accountJson(request, { error: "not-found" }, 404);

  const friend = await env.DB.prepare(
    "SELECT 1 AS x FROM friendships WHERE account_id = ? AND friend_id = ?",
  )
    .bind(me.id, targetId)
    .first();
  if (friend) return accountJson(request, { error: "already-friend" }, 409);

  // 对方已经请求过我 → 直接互相成为好友（少一次点击）
  const reverse = await env.DB.prepare(
    "SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ?",
  )
    .bind(targetId, me.id)
    .first();
  const now = Date.now();
  if (reverse) {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO friendships (account_id, friend_id, since) VALUES (?, ?, ?)").bind(me.id, targetId, now),
      env.DB.prepare("INSERT OR IGNORE INTO friendships (account_id, friend_id, since) VALUES (?, ?, ?)").bind(targetId, me.id, now),
      env.DB.prepare("DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)").bind(me.id, targetId, targetId, me.id),
    ]);
    return accountJson(request, { account: toProfile(target) }, 200);
  }

  await env.DB.prepare("INSERT OR IGNORE INTO friend_requests (from_id, to_id, at) VALUES (?, ?, ?)")
    .bind(me.id, targetId, now)
    .run();
  return accountJson(request, { account: toProfile(target) }, 200);
}

async function accountAcceptFriend(request, env) {
  const me = await currentAccount(request, env);
  if (!me) return accountJson(request, { error: "not-found" }, 401);
  const body = await request.json().catch(() => null);
  const fromId = String(body?.id ?? "").trim();
  const pending = await env.DB.prepare(
    "SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ?",
  )
    .bind(fromId, me.id)
    .first();
  if (!pending) return accountJson(request, { error: "not-found" }, 404);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO friendships (account_id, friend_id, since) VALUES (?, ?, ?)").bind(me.id, fromId, now),
    env.DB.prepare("INSERT OR IGNORE INTO friendships (account_id, friend_id, since) VALUES (?, ?, ?)").bind(fromId, me.id, now),
    env.DB.prepare("DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(fromId, me.id),
  ]);
  return accountJson(request, { account: toProfile(await accountById(env, fromId)) }, 200);
}

async function accountRejectFriend(request, env) {
  const me = await currentAccount(request, env);
  if (!me) return accountJson(request, { error: "not-found" }, 401);
  const body = await request.json().catch(() => null);
  const fromId = String(body?.id ?? "").trim();
  await env.DB.prepare("DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?")
    .bind(fromId, me.id)
    .run();
  return accountJson(request, { ok: true }, 200);
}

async function accountRemoveFriend(request, env, targetId) {
  const me = await currentAccount(request, env);
  if (!me) return accountJson(request, { error: "not-found" }, 401);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM friendships WHERE account_id = ? AND friend_id = ?").bind(me.id, targetId),
    env.DB.prepare("DELETE FROM friendships WHERE account_id = ? AND friend_id = ?").bind(targetId, me.id),
  ]);
  return accountJson(request, { ok: true }, 200);
}

async function accountPresence(request, env) {
  const me = await currentAccount(request, env);
  if (!me) return accountJson(request, { ok: false }, 200);
  const body = await request.json().catch(() => null);
  // 只收 6 位新码与 4 位老码；其它一律当"不在房间"
  const room = String(body?.roomCode ?? "").trim();
  const roomCode = /^\d{4}$|^\d{6}$/.test(room) ? room : "";
  await env.DB.prepare(
    "INSERT INTO account_presence (account_id, last_seen, room_code) VALUES (?, ?, ?) " +
      "ON CONFLICT(account_id) DO UPDATE SET last_seen = excluded.last_seen, room_code = excluded.room_code",
  )
    .bind(me.id, Date.now(), roomCode || null)
    .run();
  return accountJson(request, { ok: true }, 200);
}

/**
 * 发一条房间邀请（只有房主会调）。
 *
 * 只写"谁 → 谁，进哪个房"，**不写密码**：临时密码是房主当面/群里另发的，
 * 落到库里就等于永久凭证，房主关掉密码也收不回来了。
 */
async function accountSendInvite(request, env) {
  const me = await currentAccount(request, env);
  if (!me) return accountJson(request, { error: "not-found" }, 401);
  const body = await request.json().catch(() => null);
  const toId = String(body?.id ?? "").trim();
  const code = String(body?.code ?? "").trim();
  if (!/^\d{8}$/.test(toId)) return accountJson(request, { error: "not-found" }, 404);
  if (toId === me.id) return accountJson(request, { error: "self" }, 400);
  if (!/^\d{4}$|^\d{6}$/.test(code)) return accountJson(request, { error: "room-taken" }, 400);
  const friend = await env.DB.prepare(
    "SELECT 1 AS x FROM friendships WHERE account_id = ? AND friend_id = ?",
  )
    .bind(me.id, toId)
    .first();
  // 只给好友发：陌生人靠好友请求那套，别让邀请变成骚扰通道
  if (!friend) return accountJson(request, { error: "not-found" }, 403);
  /*
   * 钥匙（roomKey）只在私密房才带：普通房知道房号就能进，没必要把钥匙落库。
   * 带上它，「加入」才是**一键直达**——否则对方只会被要求临时密码。
   */
  const roomKey = String(body?.roomKey ?? "").trim();
  const safeKey = /^[A-Za-z0-9_-]{16,128}$/.test(roomKey) ? roomKey : null;
  await env.DB.prepare(
    "INSERT INTO room_invites (from_id, to_id, code, at, room_key) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(from_id, to_id) DO UPDATE SET code = excluded.code, at = excluded.at, room_key = excluded.room_key",
  )
    .bind(me.id, toId, code, Date.now(), safeKey)
    .run();
  return accountJson(request, { ok: true }, 200);
}

/** 我收到的邀请（好友刚发出的、还没处理的）。 */
async function accountInvites(request, env) {
  const me = await currentAccount(request, env);
  if (!me) return accountJson(request, { invites: [] }, 200);
  // 只保留 24 小时内的：再久的房间基本早就散了，留着只会让人白点一次
  const alive = Date.now() - 24 * 3600_000;
  const rows = await env.DB.prepare(
    "SELECT a.*, i.code AS invite_code, i.at AS invite_at, i.room_key AS invite_key FROM room_invites i " +
      "JOIN accounts a ON a.id = i.from_id WHERE i.to_id = ? AND i.at > ? ORDER BY i.at DESC LIMIT 20",
  )
    .bind(me.id, alive)
    .all();
  return accountJson(
    request,
    {
      invites: (rows.results ?? []).map((row) => ({
        from: toProfile(row),
        code: row.invite_code,
        at: row.invite_at,
        ...(row.invite_key ? { roomKey: row.invite_key } : {}),
      })),
    },
    200,
  );
}

/** 处理掉一条邀请（加入或忽略都一样：从列表里消失）。 */
async function accountDismissInvite(request, env, fromId) {
  const me = await currentAccount(request, env);
  if (!me) return accountJson(request, { ok: false }, 401);
  await env.DB.prepare("DELETE FROM room_invites WHERE from_id = ? AND to_id = ?")
    .bind(fromId, me.id)
    .run();
  return accountJson(request, { ok: true }, 200);
}

async function handleAccount(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: accountCorsHeaders(request) });
  }
  if (!env.DB) return accountJson(request, { error: "accounts not configured" }, 503);

  const path = url.pathname.slice(ACCOUNT_PREFIX.length) || "/";
  try {
    if (path === "/register" && request.method === "POST") return await accountRegister(request, env);
    if (path === "/login" && request.method === "POST") return await accountLogin(request, env);
    if (path === "/logout" && request.method === "POST") return await accountLogout(request, env);
    if (path === "/me" && request.method === "GET") {
      return accountJson(request, { account: toProfile(await currentAccount(request, env)) }, 200);
    }
    if (path === "/me" && request.method === "PATCH") return await accountUpdateProfile(request, env);
    if (path === "/me/ack-id-change" && request.method === "POST") {
      return await accountAckIdChange(request, env);
    }
    if (path === "/room-claim" && request.method === "GET") return await accountRoomClaim(request, env, url);
    if (path === "/room-hold" && request.method === "POST") return await accountHoldRoom(request, env);
    if (path === "/room-hold" && request.method === "DELETE") return await accountReleaseHold(request, env, url);
    if (path === "/search" && request.method === "GET") return await accountSearch(request, env, url);
    if (path === "/friends" && request.method === "GET") return await accountSnapshot(request, env);
    if (path === "/friends" && request.method === "POST") return await accountAddFriend(request, env);
    if (path === "/friends/accept" && request.method === "POST") return await accountAcceptFriend(request, env);
    if (path === "/friends/reject" && request.method === "POST") return await accountRejectFriend(request, env);
    const removeMatch = /^\/friends\/(\d{8})$/.exec(path);
    if (removeMatch && request.method === "DELETE") return await accountRemoveFriend(request, env, removeMatch[1]);
    if (path === "/presence" && request.method === "POST") return await accountPresence(request, env);
    if (path === "/invites" && request.method === "POST") return await accountSendInvite(request, env);
    if (path === "/invites" && request.method === "GET") return await accountInvites(request, env);
    const inviteMatch = /^\/invites\/(\d{8})$/.exec(path);
    if (inviteMatch && request.method === "DELETE") return await accountDismissInvite(request, env, inviteMatch[1]);
    return accountJson(request, { error: "not found" }, 404);
  } catch (error) {
    /*
     * 别把内部错误抛给客户端，但也别让它无声消失：
     * 2026-10-26 的"注册全 500"就是被这里吞掉的一句话
     * （Pbkdf2 迭代超上限），只能靠 Workers 日志才看得见。
     */
    console.error("[account]", error?.stack ?? error?.message ?? error);
    return accountJson(request, { error: "internal" }, 500);
  }
}
