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

    // /peerjs* → 信令：转到我们**自建的信令服务**（service binding SIGNAL）。
    // 背景：公共 PeerJS 云会对握手返回 Cloudflare 1020（按浏览器签名封禁），
    // 部分用户完全进不去房间；借道转发也无效（它连我们 Worker 的请求一起拦）。
    // 所以自建服务端：协议与 PeerJS 客户端完全兼容（见 worker/signal/index.js）。
    if (url.pathname === "/peerjs" || url.pathname.startsWith("/peerjs/")) {
      return proxyPeerJs(url, request, env);
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

/** GET/POST /game-admin?staff=TOKEN */
async function handleGameAdmin(request, env) {
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
      flash.push(`新创建码：<code>${code}</code>（可用 ${uses} 次 / ${days} 天有效，只显示这一次）`);
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
      flash.push(`员工令牌（${name}，90 天）：<code>${token}</code><br/>发给对方，让他打开 <code>/game-admin?staff=${token}</code>`);
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

  const codeRows = codes
    .map(
      (row) => `<tr><td><code>${row.code}</code></td><td>${row.note ?? ""}</td><td>${row.uses_left}</td>
      <td>${cnTime(row.expires_at).slice(0, 10)}</td>
      <td>${row.revoked ? "已吊销" : "有效"}</td>
      <td><form method="post" style="display:inline"><input type="hidden" name="action" value="revoke_code"/>
        <input type="hidden" name="code" value="${row.code}"/><button type="submit">吊销</button></form></td></tr>`,
    )
    .join("");
  const staffRows = staff
    .map(
      (row) => `<tr><td>${row.name}</td><td>${row.scope}</td><td>${cnTime(row.expires_at).slice(0, 10)}</td>
      <td>${row.revoked ? "已吊销" : "有效"}</td>
      <td><form method="post" style="display:inline"><input type="hidden" name="action" value="revoke_staff"/>
        <input type="hidden" name="id" value="${row.id}"/><button type="submit">吊销</button></form></td></tr>`,
    )
    .join("");
  const auditRows = audit
    .map((row) => `<tr><td>${cnTime(row.at)}</td><td>${row.actor}</td><td>${row.action}</td><td>${row.detail ?? ""}</td></tr>`)
    .join("");

  const html = `
    ${flash.map((line) => `<p class="flash">${line}</p>`).join("")}
    <h2>生成创建码</h2>
    <form method="post">
      <input type="hidden" name="action" value="new_code"/>
      <label>次数 <input name="uses" value="1" size="3"/></label>
      <label>有效天数 <input name="days" value="30" size="3"/></label>
      <label>备注 <input name="note" placeholder="给谁用" size="14"/></label>
      <button type="submit">生成</button>
    </form>
    <h2>创建码</h2>
    <table><tr><th>码</th><th>备注</th><th>剩余</th><th>到期</th><th>状态</th><th></th></tr>${codeRows || "<tr><td colspan='6'>还没有码</td></tr>"}</table>
    ${who.role === "main" ? `<h2>新增员工（仅主令牌）</h2>
      <form method="post"><input type="hidden" name="action" value="new_staff"/>
        <label>名字 <input name="name" placeholder="运营-小王" size="12"/></label>
        <button type="submit">生成员工令牌</button></form>
      <h2>员工</h2>
      <table><tr><th>名字</th><th>权限</th><th>到期</th><th>状态</th><th></th></tr>${staffRows || "<tr><td colspan='5'>还没有员工</td></tr>"}</table>` : ""}
    <h2>操作日志</h2>
    <table><tr><th>时间</th><th>操作者</th><th>动作</th><th>详情</th></tr>${auditRows || "<tr><td colspan='4'>暂无</td></tr>"}</table>
  `;
  return adminPage(`开黑圈运营 · ${who.name}`, html);
}
