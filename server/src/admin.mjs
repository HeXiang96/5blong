/**
 * 后台三页：反馈 / 账号 / 在线房间（+ 自助重置密码页）。
 *
 * 从 `worker/_worker.pages.js` 搬过来，但**不是照抄** —— 那边是 Workers 的
 * `fetch` + `Response` + D1，这里是 express + node:sqlite。业务语义保持一致：
 *   * 同一个主令牌（`FEEDBACK_TOKEN`）鉴权，令牌不对一律 401；
 *   * 账号页**永不显示密码**（只有哈希，从不查询 salt/hash 出来展示）；
 *   * 重置密码时密码只显示一次，且**不进 URL**（避免落进浏览器历史和访问日志）；
 *   * 所有"绕过用户端限制"的动作都写 admin_audit。
 *
 * 视觉上用同一套 CSS 变量，和 CF 上的后台看起来是同一个东西。
 */

import express from "express";
import { CONFIG, PBKDF2_ROUNDS, SESSION_COOKIE } from "./config.mjs";
import { pbkdf2Hex, randomHex, suggestPassword, toProfile } from "./util.mjs";

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
export const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** 定长比较，避免用 `===` 比令牌时泄漏长度/前缀信息。 */
function safeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** 毫秒时间戳 → 本地时间（账号类字段用毫秒）。 */
function fmtMs(ms) {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { hour12: false });
}

/** ISO 字符串 → 本地时间（房间/反馈类字段用 TEXT）。 */
function fmtIso(text) {
  if (!text) return "—";
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return String(text);
  return d.toLocaleString("zh-CN", { hour12: false });
}

/** 相对时间，"3 分钟前"这种，便于扫一眼知道新旧。 */
function ago(ms) {
  if (!ms) return "";
  const diff = Date.now() - Number(ms);
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

function fmtDuration(seconds) {
  const s = Number(seconds ?? 0);
  if (!s) return "—";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

// ---------------------------------------------------------------------------
// 页面骨架（CSS 与 CF 版后台同一套视觉）
// ---------------------------------------------------------------------------
const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 20px; background: #f6f4ef; color: #2b2620;
       font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
a { color: #2e4b3c; }
.top { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; margin-bottom: 16px; }
.nav { display: flex; gap: 8px; margin-left: auto; }
.nav a { text-decoration: none; padding: 5px 12px; border: 1px solid #e3ded4; border-radius: 999px; background: #fff; font-size: 13px; }
.nav a.on { background: #2e4b3c; border-color: #2e4b3c; color: #f7f5f0; }
.summary { color: #6b6257; margin: 0 0 16px; }
.card { background: #fff; border: 1px solid #e3ded4; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
.card.done { opacity: .62; }
.card header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.when { font-variant-numeric: tabular-nums; color: #6b6257; font-size: 13px; }
.tag { background: #efe7d8; border-radius: 999px; padding: 1px 10px; font-size: 12px; }
.tag-done { background: #d8ecdc; }
.tag-live { background: #d8ecdc; }
.meta { color: #8a8175; font-size: 12px; margin-left: auto; }
.msg { margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; }
.contact { margin: 0 0 8px; color: #6b6257; font-size: 13px; }
.ctx { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.ctx details.diag { flex-basis: 100%; }
.ctx details.diag summary { cursor: pointer; font-weight: 600; opacity: .85; }
.ctx details.diag pre { margin: 8px 0 0; padding: 10px; max-height: 340px; overflow: auto;
  background: rgba(0,0,0,.04); border-radius: 8px; font-size: 11.5px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-all; }
.kv { background: #f6f4ef; border-radius: 6px; padding: 2px 8px; font-size: 12px; color: #6b6257; }
form { margin: 0; }
button { border: 1px solid #d6cfc2; background: #fff; border-radius: 8px; padding: 5px 12px;
         font-size: 13px; cursor: pointer; font-family: inherit; }
button:hover { background: #faf8f4; }
button.primary { background: #2e4b3c; border-color: #2e4b3c; color: #f7f5f0; }
button.danger { color: #a33; border-color: #e0c4c0; }
.empty { color: #8a8175; }
code { background: #efe7d8; border-radius: 4px; padding: 1px 6px; }
.stats { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.stat { flex: 1 1 150px; background: #fff; border: 1px solid #e3ded4; border-radius: 12px;
        padding: 12px 16px; display: flex; flex-direction: column; gap: 2px; }
.stat .big { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat .label { font-size: 12.5px; color: #6b6257; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3ded4;
        border-radius: 12px; overflow: hidden; }
th, td { padding: 9px 12px; text-align: left; font-size: 13.5px; border-bottom: 1px solid #efeae0;
         vertical-align: top; }
th { background: #f6f4ef; font-weight: 600; color: #6b6257; font-size: 12.5px; white-space: nowrap; }
tr:last-child td { border-bottom: none; }
td.num { font-variant-numeric: tabular-nums; }
.acts { display: flex; flex-wrap: wrap; gap: 6px; }
.acts form { display: inline-flex; }
.searchbar { display: flex; gap: 8px; margin-bottom: 14px; }
.searchbar input { flex: 1 1 auto; border: 1px solid #d6cfc2; border-radius: 999px;
                   padding: 7px 16px; font: inherit; font-size: 14px; background: #fff; }
.flash-ok { background: #d8ecdc; border: 1px solid #b9d9c1; border-radius: 10px;
            padding: 10px 14px; margin-bottom: 14px; }
.flash-err { background: #f6dcd8; border: 1px solid #e0b8b2; border-radius: 10px;
             padding: 10px 14px; margin-bottom: 14px; }
.secret { font-size: 24px; font-weight: 700; letter-spacing: .08em; text-align: center;
          background: #fff8e8; border: 1px dashed #d8c9a8; border-radius: 10px; padding: 12px 16px; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; word-break: break-all; }
@media (prefers-color-scheme: dark) {
  body { background: #191714; color: #f2eee6; }
  .card, table, .stat, .nav a, button, .searchbar input { background: #221f1b; border-color: #35302a; }
  th { background: #2c2823; color: #a69c8e; }
  td, th { border-color: #2c2823; }
  .kv, code { background: #2c2823; color: #a69c8e; }
  a { color: #6e9a82; }
  .nav a.on { background: #6e9a82; border-color: #6e9a82; color: #191714; }
}
`;

export function page(title, bodyHtml, token) {
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>5blong · ${escapeHtml(title)}</title><style>${CSS}</style></head>
<body>
<div class="top">
  <h1>${escapeHtml(title)}</h1>
  <nav class="nav">
    <a href="/admin${q}"${title === "意见反馈" ? ' class="on"' : ""}>反馈</a>
    <a href="/accounts-admin${q}"${title === "账号" ? ' class="on"' : ""}>账号</a>
    <a href="/rooms${q}"${title === "在线房间" ? ' class="on"' : ""}>在线</a>
  </nav>
</div>
${bodyHtml}
</body></html>`;
}

// ---------------------------------------------------------------------------
// 重置令牌（与 worker 同一套 HMAC 方案，密钥复用 FEEDBACK_TOKEN）
// ---------------------------------------------------------------------------
const RESET_TTL_MS = 30 * 60_000;

function b64urlEncode(text) {
  return Buffer.from(text, "utf8").toString("base64url");
}
function b64urlDecode(text) {
  return Buffer.from(text, "base64url").toString("utf8");
}

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Buffer.from(sig).toString("hex").slice(0, 32);
}

async function makeResetToken(secret, accountId) {
  const payload = `${accountId}.${Date.now() + RESET_TTL_MS}`;
  return `${b64urlEncode(payload)}.${await hmacHex(secret, payload)}`;
}

async function readResetToken(secret, token) {
  if (!secret || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  let payload;
  try {
    payload = b64urlDecode(token.slice(0, dot));
  } catch {
    return null;
  }
  if ((await hmacHex(secret, payload)) !== token.slice(dot + 1)) return null;
  const [id, exp] = payload.split(".");
  if (!id || !/^\d{8}$/.test(id)) return null;
  if (!Number(exp) || Number(exp) < Date.now()) return null;
  return id;
}

export function createAdminRouter(db) {
  const router = express.Router();

  const staffToken = () => process.env.FEEDBACK_TOKEN ?? "";

  /** 令牌守卫：不对就 401，绝不渲染任何数据。 */
  const guard = (req, res) => {
    const provided = String(req.query.token ?? req.headers["x-admin-token"] ?? "");
    if (!staffToken()) {
      res
        .status(501)
        .send(page("尚未启用", "<p>服务端没有设置 <code>FEEDBACK_TOKEN</code> 环境变量。</p>", ""));
      return false;
    }
    if (!safeEqual(provided, staffToken())) {
      res.status(401).type("text/plain").send("未授权：令牌不正确");
      return false;
    }
    return true;
  };

  const audit = (actor, action, target, detail) =>
    db
      .prepare("INSERT INTO admin_audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
      .bind(Date.now(), actor, action, target, detail)
      .run();

  const tokenQ = (req) => String(req.query.token ?? "");

  // =========================================================================
  // 反馈
  // =========================================================================
  const CATEGORY_LABELS = {
    voice: "语音",
    mic: "麦克风",
    room: "进出房间",
    screen: "屏幕共享",
    lag: "卡顿掉线",
    other: "其它",
  };

  router.get("/admin", (req, res) => {
    if (!guard(req, res)) return;
    const token = tokenQ(req);
    const rows = db
      .prepare(
        "SELECT id, created_at, version, platform, category, message, contact, context_json, status " +
          "FROM feedback ORDER BY created_at DESC LIMIT 200",
      )
      .all().results;

    const pending = rows.filter((r) => r.status !== "done").length;
    const items = rows
      .map((r) => {
        const done = r.status === "done";
        let context = "";
        if (r.context_json) {
          try {
            const parsed = JSON.parse(r.context_json);
            context = Object.entries(parsed)
              .map(([k, v]) => {
                // 诊断包几十 KB：折叠起来，别把列表撑爆
                if (k === "diag") {
                  let pretty = String(v);
                  try {
                    pretty = JSON.stringify(JSON.parse(pretty), null, 2);
                  } catch {
                    /* 截断过的 JSON 解析不了，原样展示 */
                  }
                  return `<details class="diag"><summary>连接诊断（点开看）</summary><pre>${escapeHtml(
                    pretty,
                  )}</pre></details>`;
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
    <span class="when">${escapeHtml(fmtIso(r.created_at))}</span>
    <span class="tag">${CATEGORY_LABELS[r.category] ?? escapeHtml(r.category ?? "其它")}</span>
    ${done ? '<span class="tag tag-done">已处理</span>' : ""}
    <span class="meta">v${escapeHtml(r.version || "?")} · ${escapeHtml(r.platform || "?")}</span>
  </header>
  <p class="msg">${escapeHtml(r.message)}</p>
  ${r.contact ? `<p class="contact">联系方式：${escapeHtml(r.contact)}</p>` : ""}
  ${context ? `<div class="ctx">${context}</div>` : ""}
  <form method="post" action="/admin?token=${encodeURIComponent(token)}">
    <input type="hidden" name="id" value="${escapeHtml(r.id)}" />
    <input type="hidden" name="status" value="${done ? "new" : "done"}" />
    <button type="submit">${done ? "标记为未处理" : "标记为已处理"}</button>
  </form>
</article>`;
      })
      .join("\n");

    const body = `<p class="summary">共 ${rows.length} 条，待处理 <strong>${pending}</strong> 条（最多显示最近 200 条）</p>
${items || '<p class="empty">还没有收到反馈。</p>'}`;
    res.send(page("意见反馈", body, token));
  });

  router.post("/admin", (req, res) => {
    if (!guard(req, res)) return;
    const id = String(req.body?.id ?? "");
    const status = String(req.body?.status ?? "") === "done" ? "done" : "new";
    if (id) db.prepare("UPDATE feedback SET status = ? WHERE id = ?").bind(status, id).run();
    // 表单提交后 303 跳回列表，避免刷新重复提交
    res.redirect(303, `/admin?token=${encodeURIComponent(tokenQ(req))}`);
  });

  // =========================================================================
  // 账号
  // =========================================================================
  const ONLINE_MS = 75_000;

  router.get("/accounts-admin", (req, res) => {
    if (!guard(req, res)) return;
    const token = tokenQ(req);
    const keyword = String(req.query.q ?? "").trim().slice(0, 40);
    const where = keyword
      ? " WHERE a.id LIKE ? OR lower(a.username) LIKE ? OR lower(a.name) LIKE ?"
      : "";
    const like = `%${keyword.toLowerCase()}%`;
    const args = keyword ? [like, like, like] : [];
    const rows = db
      .prepare(
        "SELECT a.id, a.username, a.name, a.room_code, a.room_changes, a.created_at, " +
          "p.last_seen, p.room_code AS live_room FROM accounts a " +
          `LEFT JOIN account_presence p ON p.account_id = a.id${where} ORDER BY a.created_at DESC LIMIT 200`,
      )
      .bind(...args)
      .all().results;

    const now = Date.now();
    const tq = encodeURIComponent(token);
    const body = rows
      .map((row) => {
        const online = row.last_seen && now - Number(row.last_seen) <= ONLINE_MS;
        return `<tr>
  <td class="num"><strong>${escapeHtml(row.id)}</strong></td>
  <td>${escapeHtml(row.username)}<br /><span class="meta">${escapeHtml(row.name)}</span></td>
  <td class="num">${row.room_code ? escapeHtml(row.room_code) : '<span class="empty">—</span>'}
      ${Number(row.room_changes ?? 0) >= 1 ? '<span class="kv">已锁定</span>' : ""}</td>
  <td>${online ? '<span class="tag tag-live">在线</span>' : '<span class="empty">离线</span>'}
      ${row.live_room ? `<span class="kv">${escapeHtml(row.live_room)}</span>` : ""}
      <br /><span class="meta">${escapeHtml(ago(row.last_seen))}</span></td>
  <td class="meta">${escapeHtml(fmtMs(row.created_at))}</td>
  <td>
    <div class="acts">
      <form method="post" action="/accounts-admin?token=${tq}">
        <input type="hidden" name="action" value="set_room" />
        <input type="hidden" name="id" value="${escapeHtml(row.id)}" />
        <input name="code" placeholder="6 位房号" size="7" style="width:88px;border:1px solid #d6cfc2;border-radius:8px;padding:4px 8px;font:inherit;font-size:13px" />
        <button type="submit">改房号</button>
      </form>
      ${row.room_code ? `<form method="post" action="/accounts-admin?token=${tq}">
        <input type="hidden" name="action" value="clear_room" />
        <input type="hidden" name="id" value="${escapeHtml(row.id)}" />
        <button type="submit" class="danger">清空房号</button>
      </form>` : ""}
      <form method="post" action="/accounts-admin?token=${tq}">
        <input type="hidden" name="action" value="set_id" />
        <input type="hidden" name="id" value="${escapeHtml(row.id)}" />
        <input name="newId" placeholder="新 8 位 ID" size="9" style="width:96px;border:1px solid #d6cfc2;border-radius:8px;padding:4px 8px;font:inherit;font-size:13px" />
        <button type="submit" class="danger">改 ID</button>
      </form>
      <form method="post" action="/accounts-admin?token=${tq}">
        <input type="hidden" name="action" value="reset_pass" />
        <input type="hidden" name="id" value="${escapeHtml(row.id)}" />
        <button type="submit">重置密码</button>
      </form>
      <form method="post" action="/accounts-admin?token=${tq}">
        <input type="hidden" name="action" value="reset_link" />
        <input type="hidden" name="id" value="${escapeHtml(row.id)}" />
        <button type="submit">重置链接</button>
      </form>
    </div>
  </td>
</tr>`;
      })
      .join("\n");

    const list = rows.length
      ? `<table><thead><tr>
  <th>数字 ID</th><th>用户名 / 昵称</th><th>房号</th><th>在线</th><th>注册时间</th><th>操作</th>
</tr></thead><tbody>${body}</tbody></table>`
      : `<p class="empty">没有匹配「${escapeHtml(keyword)}」的账号。</p>`;

    const html = `<form class="searchbar" method="get" action="/accounts-admin">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <input type="text" name="q" value="${escapeHtml(keyword)}" placeholder="搜数字 ID / 用户名 / 昵称" />
  <button type="submit">搜索</button>
  ${keyword ? `<a href="/accounts-admin?token=${tq}">清除</a>` : ""}
</form>
<p class="summary">共 ${rows.length} 个账号${keyword ? "（已筛选）" : ""}，最多显示 200 个。</p>
${list}`;
    res.send(page("账号", html, token));
  });

  router.post("/accounts-admin", async (req, res) => {
    if (!guard(req, res)) return;
    const token = tokenQ(req);
    const action = String(req.body?.action ?? "");
    const id = String(req.body?.id ?? "").trim();
    const back = (msg, ok = true) =>
      res.send(page("账号", `<div class="${ok ? "flash-ok" : "flash-err"}">${msg}</div>
<p><a href="/accounts-admin?token=${encodeURIComponent(token)}">← 返回账号列表</a></p>`, token));

    const target = db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
    if (!target) return back(`找不到账号 <code>${escapeHtml(id)}</code>`, false);
    const actor = "staff";

    if (action === "set_room") {
      const code = String(req.body?.code ?? "").trim();
      if (!/^\d{6}$/.test(code)) return back("房号必须是 6 位数字", false);
      const taken = db
        .prepare("SELECT id FROM accounts WHERE room_code = ? AND id <> ?")
        .bind(code, id)
        .first();
      if (taken) return back(`房号 ${code} 已被账号 ${escapeHtml(taken.id)} 认领`, false);
      // 后台改号绕过"一次性"限制，但改完仍然锁死（与 worker 口径一致）
      db.prepare("UPDATE accounts SET room_code = ?, room_code_at = ?, room_changes = 1, updated_at = ? WHERE id = ?")
        .bind(code, Date.now(), Date.now(), id)
        .run();
      audit(actor, "room_set", id, `管理员把房号设为 ${code}（已锁定）`);
      return back(`已把 <code>${escapeHtml(id)}</code> 的房号设为 <strong>${escapeHtml(code)}</strong>，并锁定。`);
    }

    if (action === "clear_room") {
      db.prepare("UPDATE accounts SET room_code = NULL, room_code_at = NULL, room_changes = 0, updated_at = ? WHERE id = ?")
        .bind(Date.now(), id)
        .run();
      audit(actor, "room_clear", id, "管理员清空了房号，该号已回池");
      return back(`已清空 <code>${escapeHtml(id)}</code> 的房号，这个号可以重新被认领。`);
    }

    if (action === "set_id") {
      const nextId = String(req.body?.newId ?? "").trim();
      if (!/^\d{8}$/.test(nextId)) return back("新 ID 必须是 8 位数字", false);
      if (nextId === id) return back("新 ID 和旧 ID 一样", false);
      if (db.prepare("SELECT 1 AS x FROM accounts WHERE id = ?").bind(nextId).first()) {
        return back(`ID ${nextId} 已被占用`, false);
      }
      // 级联改所有外键，否则好友/邀请会指向一个不存在的号
      db.batch([
        db.prepare("UPDATE accounts SET id = ?, prev_id = ?, updated_at = ? WHERE id = ?").bind(nextId, id, Date.now(), id),
        db.prepare("UPDATE account_sessions SET account_id = ? WHERE account_id = ?").bind(nextId, id),
        db.prepare("UPDATE account_presence SET account_id = ? WHERE account_id = ?").bind(nextId, id),
        db.prepare("UPDATE friendships SET account_id = ? WHERE account_id = ?").bind(nextId, id),
        db.prepare("UPDATE friendships SET friend_id = ? WHERE friend_id = ?").bind(nextId, id),
        db.prepare("UPDATE friend_requests SET from_id = ? WHERE from_id = ?").bind(nextId, id),
        db.prepare("UPDATE friend_requests SET to_id = ? WHERE to_id = ?").bind(nextId, id),
        db.prepare("UPDATE room_invites SET from_id = ? WHERE from_id = ?").bind(nextId, id),
        db.prepare("UPDATE room_invites SET to_id = ? WHERE to_id = ?").bind(nextId, id),
        db.prepare("UPDATE knocks SET from_id = ? WHERE from_id = ?").bind(nextId, id),
        db.prepare("UPDATE knocks SET to_id = ? WHERE to_id = ?").bind(nextId, id),
        db.prepare("UPDATE recent_plays SET owner_id = ? WHERE owner_id = ?").bind(nextId, id),
        db.prepare("UPDATE recent_plays SET peer_id = ? WHERE peer_id = ?").bind(nextId, id),
        db.prepare("UPDATE daily_actions SET account_id = ? WHERE account_id = ?").bind(nextId, id),
      ]);
      audit(actor, "id_set", nextId, `从 ${id} 改为 ${nextId}（级联会话/好友/邀请）`);
      return back(`已把 <code>${escapeHtml(id)}</code> 改为 <code>${escapeHtml(nextId)}</code>。客户端下次打开会用旧号迁移本机房间钥匙。`);
    }

    if (action === "reset_pass") {
      const password = suggestPassword();
      const salt = randomHex(16);
      const hash = await pbkdf2Hex(password, salt);
      db.batch([
        db.prepare("UPDATE accounts SET salt = ?, hash = ?, updated_at = ? WHERE id = ?").bind(salt, hash, Date.now(), id),
        db.prepare("DELETE FROM account_sessions WHERE account_id = ?").bind(id),
      ]);
      audit(actor, "pass_reset", id, "管理员重置了登录密码，旧会话已全部失效");
      // 密码**不进 URL**：直接渲染，不做 303 跳转
      return res.send(page("密码已重置", `<div class="card">
  <p>账号 <code>${escapeHtml(id)}</code>（${escapeHtml(target.username)}）的新密码：</p>
  <p class="secret"><code>${escapeHtml(password)}</code></p>
  <p><b>这串只显示这一次</b>，刷新就没了 —— 先记下来再离开本页。</p>
  <p>该账号原来的登录状态已全部失效，需要用新密码重新登录。</p>
  <p><a href="/accounts-admin?token=${encodeURIComponent(token)}">← 返回账号列表</a></p>
</div>`, token));
    }

    if (action === "reset_link") {
      const secret = staffToken();
      const resetToken = await makeResetToken(secret, id);
      const origin = CONFIG.publicOrigin || `https://${req.headers.host ?? ""}`;
      const link = `${origin}/reset?t=${encodeURIComponent(resetToken)}`;
      audit(actor, "pass_reset_link", id, "生成了密码重置链接（30 分钟有效）");
      return res.send(page("重置链接已生成", `<div class="card">
  <p>账号 <code>${escapeHtml(id)}</code>（${escapeHtml(target.username)}）的重置链接：</p>
  <p class="mono"><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
  <p><b>30 分钟内有效</b>，且只能给这个人。发给他之后，他自己打开设新密码。</p>
  <p>对方设好后，该账号所有旧登录会失效。</p>
  <p><a href="/accounts-admin?token=${encodeURIComponent(token)}">← 返回账号列表</a></p>
</div>`, token));
    }

    return back("未知操作", false);
  });

  // =========================================================================
  // 在线房间
  // =========================================================================
  const ROOM_ONLINE_MS = 150_000;

  router.get("/rooms", (req, res) => {
    if (!guard(req, res)) return;
    const token = tokenQ(req);
    const code = String(req.query.code ?? "").trim().slice(0, 16);
    const sessionId = String(req.query.session ?? "").trim();
    const nowIso = new Date(Date.now() - ROOM_ONLINE_MS).toISOString();

    const live = db
      .prepare(
        "SELECT id, created_at, last_seen, members, sharing, version, runtime FROM rooms " +
          "WHERE last_seen > ? ORDER BY members DESC, last_seen DESC LIMIT 500",
      )
      .bind(nowIso)
      .all().results;

    const liveMembers = live.reduce((sum, row) => sum + Number(row.members ?? 0), 0);

    const sessions = code
      ? db
          .prepare("SELECT * FROM room_sessions WHERE code LIKE ? ORDER BY created_at DESC LIMIT 100")
          .bind(`%${code}%`)
          .all().results
      : db.prepare("SELECT * FROM room_sessions ORDER BY created_at DESC LIMIT 100").all().results;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayCount = sessions.filter(
      (s) => new Date(s.created_at).getTime() >= todayStart.getTime(),
    ).length;

    // 展开某一场：成员 / 事件 / 人数曲线
    let detail = "";
    if (sessionId) {
      const session = db.prepare("SELECT * FROM room_sessions WHERE id = ?").bind(sessionId).first();
      if (!session) {
        detail = `<div class="flash-err">找不到会话 <code>${escapeHtml(sessionId)}</code></div>`;
      } else {
        const members = db
          .prepare("SELECT * FROM room_members WHERE session_id = ? ORDER BY joined_at")
          .bind(sessionId)
          .all().results;
        const events = db
          .prepare("SELECT at, kind, detail FROM room_events WHERE session_id = ? ORDER BY at DESC LIMIT 50")
          .bind(sessionId)
          .all().results;
        const samples = db
          .prepare("SELECT at, members FROM room_samples WHERE session_id = ? ORDER BY at LIMIT 200")
          .bind(sessionId)
          .all().results;

        const memberRows = members
          .map(
            (m) => `<tr>
  <td>${escapeHtml(m.name || m.member_key)}</td>
  <td class="num">${escapeHtml(fmtIso(m.joined_at))}</td>
  <td class="num">${escapeHtml(fmtDuration(m.duration_s))}</td>
  <td class="num">${m.rtt_avg_ms ?? "—"}${m.rtt_max_ms ? ` / ${m.rtt_max_ms}` : ""}</td>
  <td class="num">${m.loss_pct != null ? Number(m.loss_pct).toFixed(1) + "%" : "—"}</td>
  <td>${escapeHtml(m.link ?? "—")}</td>
  <td>${escapeHtml(m.version ?? "—")}</td>
</tr>`,
          )
          .join("\n");

        const eventRows = events
          .map(
            (e) =>
              `<tr><td class="num">${escapeHtml(fmtIso(e.at))}</td><td>${escapeHtml(e.kind)}</td><td>${escapeHtml(
                e.detail ?? "",
              )}</td></tr>`,
          )
          .join("\n");

        const curve = samples
          .map((s) => `${new Date(s.at).toLocaleTimeString("zh-CN", { hour12: false })} ${"▇".repeat(
            Math.min(40, Number(s.members ?? 0)),
          )} ${s.members}`)
          .join("\n");

        detail = `<div class="card">
  <h2 style="font-size:17px;margin:0 0 10px">会话 ${escapeHtml(session.id)} · 房号 ${escapeHtml(session.code)}</h2>
  <p class="summary">开始 ${escapeHtml(fmtIso(session.created_at))} · 结束 ${escapeHtml(
          fmtIso(session.ended_at),
        )} · 时长 ${escapeHtml(fmtDuration(session.duration_s))} · 峰值 ${session.peak_members ?? "—"} 人</p>
  <h3 style="font-size:14px;margin:14px 0 8px">成员（${members.length}）</h3>
  ${
    members.length
      ? `<table><thead><tr><th>成员</th><th>加入</th><th>时长</th><th>RTT 均值/最大</th><th>丢包</th><th>链路</th><th>版本</th></tr></thead><tbody>${memberRows}</tbody></table>`
      : '<p class="empty">这场没有成员记录。</p>'
  }
  <h3 style="font-size:14px;margin:16px 0 8px">事件（最近 50）</h3>
  ${
    events.length
      ? `<table><thead><tr><th>时间</th><th>类型</th><th>详情</th></tr></thead><tbody>${eventRows}</tbody></table>`
      : '<p class="empty">没有事件。</p>'
  }
  <h3 style="font-size:14px;margin:16px 0 8px">人数曲线（采样 ${samples.length} 点）</h3>
  ${curve ? `<pre class="mono">${escapeHtml(curve)}</pre>` : '<p class="empty">没有采样。</p>'}
</div>`;
      }
    }

    const liveRows = live
      .map(
        (r) => `<tr>
  <td class="num"><strong>${escapeHtml(/^\d{4,6}$/.test(r.id) ? r.id : r.id.slice(0, 8))}</strong></td>
  <td class="num">${r.members}</td>
  <td>${r.sharing ? '<span class="tag">共享中</span>' : ""}</td>
  <td>${escapeHtml(r.runtime ?? "—")}</td>
  <td>${escapeHtml(r.version ?? "—")}</td>
  <td class="num">${escapeHtml(fmtIso(r.last_seen))}<br /><span class="meta">${escapeHtml(
          ago(new Date(r.last_seen).getTime()),
        )}</span></td>
</tr>`,
      )
      .join("\n");

    const sessionRows = sessions
      .map(
        (s) => `<tr>
  <td class="num"><a href="/rooms?token=${encodeURIComponent(token)}&session=${encodeURIComponent(s.id)}${
          code ? `&code=${encodeURIComponent(code)}` : ""
        }">${escapeHtml(s.id.slice(0, 8))}</a></td>
  <td class="num">${escapeHtml(s.code)}</td>
  <td class="num">${escapeHtml(fmtIso(s.created_at))}</td>
  <td class="num">${escapeHtml(fmtDuration(s.duration_s))}</td>
  <td class="num">${s.peak_members ?? "—"}</td>
  <td>${escapeHtml(s.host_version ?? "—")}</td>
</tr>`,
      )
      .join("\n");

    const html = `<div class="stats">
  <div class="stat"><span class="big">${live.length}</span><span class="label">在线房间</span></div>
  <div class="stat"><span class="big">${liveMembers}</span><span class="label">在线人数</span></div>
  <div class="stat"><span class="big">${todayCount}</span><span class="label">今日会话（近 100 条内统计）</span></div>
</div>

<h2 style="font-size:16px;margin:0 0 10px">正在开着的房间</h2>
${
  live.length
    ? `<table><thead><tr><th>房号</th><th>人数</th><th>共享</th><th>端</th><th>版本</th><th>最后心跳</th></tr></thead><tbody>${liveRows}</tbody></table>`
    : '<p class="empty">现在没有房间在线。房主创建房间并进入后，这里会实时出现（150 秒内有心跳即算在线）。</p>'
}

${detail}

<h2 style="font-size:16px;margin:22px 0 10px">历史会话</h2>
<form class="searchbar" method="get" action="/rooms">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <input type="text" name="code" value="${escapeHtml(code)}" placeholder="按房号筛选" />
  <button type="submit">筛选</button>
  ${code ? `<a href="/rooms?token=${encodeURIComponent(token)}">清除</a>` : ""}
</form>
${
  sessions.length
    ? `<table><thead><tr><th>会话</th><th>房号</th><th>开始</th><th>时长</th><th>峰值人数</th><th>房主版本</th></tr></thead><tbody>${sessionRows}</tbody></table>`
    : '<p class="empty">还没有历史会话。</p>'
}`;
    res.send(page("在线房间", html, token));
  });

  // =========================================================================
  // 自助重置密码（用户拿管理员发的链接打开，无需登录）
  // =========================================================================
  /*
   * 房间会话导出（CSV）。原来在 Pages Worker 里，客户端没调用过，只给后台用。
   * 带 BOM：Excel 打开中文表头不乱码。
   */
  router.get("/rooms/export", (req, res) => {
    if (!guard(req, res)) return;
    const sessions = db
      .prepare("SELECT * FROM room_sessions ORDER BY created_at DESC LIMIT 500")
      .all().results;
    const lines = ["房间号,创建时间,结束时间,时长(秒),峰值人数,客户端,版本,会话id"];
    for (const s of sessions) {
      lines.push(
        [s.code, s.created_at, s.ended_at ?? "", s.duration_s ?? "", s.peak_members ?? "", s.host_runtime ?? "", s.host_version ?? "", s.id]
          .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
          .join(","),
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="rooms.csv"');
    return res.send("\ufeff" + lines.join("\n"));
  });

  router.get("/reset", async (req, res) => {
    const token = String(req.query.t ?? "");
    const id = await readResetToken(staffToken(), token);
    if (!id) {
      return res.status(400).send(
        page("链接已失效", `<div class="card"><p>这条重置链接已经过期（或复制不全）。</p>
<p>找房主在后台重新生成一条吧。</p></div>`, ""),
      );
    }
    const who = db.prepare("SELECT username, name FROM accounts WHERE id = ?").bind(id).first();
    if (!who) {
      return res.status(404).send(page("找不到账号", `<div class="card"><p>这个账号可能已经被删掉了。</p></div>`, ""));
    }
    res.send(resetFormHtml(token, who, ""));
  });

  router.post("/reset", async (req, res) => {
    const token = String(req.query.t ?? "");
    const id = await readResetToken(staffToken(), token);
    if (!id) {
      return res.status(400).send(
        page("链接已失效", `<div class="card"><p>这条重置链接已经过期（或复制不全）。</p></div>`, ""),
      );
    }
    const who = db.prepare("SELECT username, name FROM accounts WHERE id = ?").bind(id).first();
    if (!who) {
      return res.status(404).send(page("找不到账号", `<div class="card"><p>账号不存在。</p></div>`, ""));
    }
    const next = String(req.body?.next ?? "");
    const confirm = String(req.body?.confirm ?? "");
    if (next !== confirm) return res.status(400).send(resetFormHtml(token, who, "两次输入的新密码不一样"));
    if (next.length < 8 || next.length > 64 || new Set(next).size < 4) {
      return res.status(400).send(resetFormHtml(token, who, "密码至少 8 位，且至少 4 种不同字符"));
    }

    const salt = randomHex(16);
    const hash = await pbkdf2Hex(next, salt);
    db.batch([
      db.prepare("UPDATE accounts SET salt = ?, hash = ?, updated_at = ? WHERE id = ?").bind(salt, hash, Date.now(), id),
      // 密码重置 = 把所有可疑会话踢掉；用户随后用新密码登录
      db.prepare("DELETE FROM account_sessions WHERE account_id = ?").bind(id),
    ]);
    audit("reset-link", "pass_reset", id, "通过重置链接自行修改了密码");
    res.send(
      page(
        "密码已设置",
        `<div class="card"><p>✅ 新密码已经生效。</p>
<p>回到 5blong 用新密码登录就行，其它设备需要重新登录。</p>
<p style="margin-top:14px"><a href="${escapeHtml(CONFIG.publicOrigin || "/")}">打开 5blong</a></p></div>`,
        "",
      ),
    );
  });

  /** 重置表单的 HTML（GET 与校验失败都要用，抽出来避免两份漂移）。 */
  function resetFormHtml(token, who, message) {
    const label = who?.name || who?.username || "你的账号";
    return page(
      "设置新密码",
      `<div class="card">
  <p>房主发来的是 <b>${escapeHtml(String(label))}</b> 的密码重置链接。</p>
  <p>设好新密码就能正常登录了。这条链接 <b>30 分钟内有效</b>。</p>
  ${message ? `<div class="flash-err">${escapeHtml(message)}</div>` : ""}
  <form method="post" action="/reset?t=${encodeURIComponent(token)}">
    <p style="margin:0 0 6px">新密码</p>
    <input name="next" type="password" autocomplete="new-password" required
           style="width:100%;padding:10px 12px;border:1px solid #d8cfc0;border-radius:10px;font:inherit;background:#fff" />
    <p style="margin:12px 0 6px">再输一次</p>
    <input name="confirm" type="password" autocomplete="new-password" required
           style="width:100%;padding:10px 12px;border:1px solid #d8cfc0;border-radius:10px;font:inherit;background:#fff" />
    <p style="margin:14px 0 0"><button type="submit" class="primary">设置新密码</button></p>
    <p class="summary" style="margin-top:10px">至少 8 位，且至少 4 种不同字符。设好后，其它设备上的登录会失效。</p>
  </form>
</div>`,
      "",
    );
  }

  return router;
}
