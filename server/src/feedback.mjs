/**
 * POST /feedback —— 应用内意见反馈（写本地库）。
 *
 * 客户端（网页 + 桌面）都往这里提交；后台 `/admin` 就是读这张表。
 * 语义与 worker 完全一致：字段名、裁剪长度、限流阈值、错误码都不改，
 * 否则客户端会显示"未知错误"或者干脆提交失败。
 */

import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_HOURLY_LIMIT,
  FEEDBACK_MAX_CONTACT,
  FEEDBACK_MAX_CONTEXT,
  FEEDBACK_MAX_MESSAGE,
} from "./config.mjs";

/** 裁剪 + 去控制字符（前端也有限制，这里是服务端最后一道闸）。 */
function clampText(value, max) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export function createFeedbackHandler(db) {
  return async (req, res) => {
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

    const body = req.body ?? {};
    const message = clampText(body.message, FEEDBACK_MAX_MESSAGE);
    if (message.length < 2) return res.status(400).json({ error: "message too short" });

    const category = FEEDBACK_CATEGORIES.has(body.category) ? String(body.category) : "other";
    const contact = clampText(body.contact, FEEDBACK_MAX_CONTACT);
    const version = clampText(body.version, 40);
    const platform = clampText(body.platform, 40);

    let contextJson = "";
    try {
      const ctx = body.context && typeof body.context === "object" ? body.context : {};
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
      }
      contextJson = raw;
    } catch {
      contextJson = "";
    }

    // 只存哈希：既能限流，又不落 IP（后台也看不到真实地址）
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    const ipHash = await sha256Hex(forwarded || req.socket?.remoteAddress || "unknown");

    const since = new Date(Date.now() - 3600_000).toISOString();
    try {
      const counted = db
        .prepare("SELECT COUNT(*) AS n FROM feedback WHERE ip_hash = ? AND created_at > ?")
        .bind(ipHash, since)
        .first();
      if (Number(counted?.n ?? 0) >= FEEDBACK_HOURLY_LIMIT) {
        return res.status(429).json({ error: "too many requests" });
      }
      const id = crypto.randomUUID();
      db.prepare(
        "INSERT INTO feedback (id, created_at, version, platform, category, message, contact, context_json, ip_hash, status) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')",
      )
        .bind(id, new Date().toISOString(), version, platform, category, message, contact, contextJson, ipHash)
        .run();
      return res.status(200).json({ ok: true, id });
    } catch (error) {
      // 表还没建等情况：如实 500，但不把内部细节抛给客户端
      console.error("[feedback] insert failed", error?.message ?? error);
      return res.status(500).json({ error: "storage error" });
    }
  };
}
