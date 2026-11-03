/**
 * 开黑圈创建权限（原 Pages Worker 的 /game/entitle、/game/verify、/game-admin）。
 *
 * 安全模型（照搬原设计，改之前先读完）：
 * - 主令牌（FEEDBACK_TOKEN）只留在业主手里，用来签发员工令牌；
 * - 员工令牌只存 sha256 哈希（staff_tokens），scope=game，只能生成/吊销创建码；
 * - 创建码只存库（不落前端），前端通过 /game/entitle 换一枚 30 天 HMAC 签名令牌；
 * - 任何密钥都不下发前端，前端只拿签名结果。
 *
 * 为什么要签名令牌而不是"每次校验都查库"：
 *   建房前要校验一次，如果每次都查库，开黑圈高峰期会把 SQLite 打热。
 *   签名令牌自校验（HMAC + 过期时间），只有吊销/过期才需要查库。
 */

import express from "express";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { escapeHtml, page } from "./admin.mjs";

const GAME_DAY = 86_400_000;
const CODE_RE = /^BLONG-[A-Z0-9]{4,12}$/;

const hmacHex = (secret, text) => createHmac("sha256", secret).update(text).digest("hex");
const randomToken = (bytes = 16) => randomBytes(bytes).toString("hex");
/** 员工令牌只存哈希：库被拿走也拿不到可用的令牌。与原实现同口径（截 32 位）。 */
const sha256Hex = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32);

const safeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export function createGameRouter(db) {
  const router = express.Router();

  /** 签名密钥：允许单独配 GAME_SECRET，没配就复用主令牌（与原实现一致）。 */
  const secret = () => process.env.GAME_SECRET || process.env.FEEDBACK_TOKEN || "";
  const mainToken = () => process.env.FEEDBACK_TOKEN ?? "";

  const audit = (actor, action, detail) =>
    db
      .prepare("INSERT INTO game_audit (at, actor, action, detail) VALUES (?, ?, ?, ?)")
      .bind(Date.now(), actor, action, detail)
      .run();

  /**
   * 校验运营身份：主令牌 → role=main；员工令牌 → role=game（必须未吊销未过期）。
   * 返回 null 表示无效。
   */
  const authenticateStaff = (provided) => {
    if (!provided) return null;
    if (mainToken() && safeEqual(String(provided), mainToken())) {
      return { role: "main", name: "房主" };
    }
    const hash = sha256Hex(String(provided));
    const row = db
      .prepare("SELECT name, scope, expires_at, revoked FROM staff_tokens WHERE token_hash = ?")
      .bind(hash)
      .first();
    if (!row || Number(row.revoked) === 1) return null;
    if (row.expires_at && Number(row.expires_at) < Date.now()) return null;
    return { role: String(row.scope ?? "game"), name: String(row.name ?? "运营") };
  };

  // =========================================================================
  // POST /game/entitle —— 用创建码换 30 天签名令牌
  // =========================================================================
  router.post("/game/entitle", (req, res) => {
    const key = secret();
    if (!key) return res.status(501).json({ error: "服务未配置" });

    const code = String((req.body ?? {}).code ?? "")
      .trim()
      .toUpperCase();
    if (!CODE_RE.test(code)) return res.status(403).json({ error: "invalid code" });

    const now = Date.now();
    const row = db
      .prepare("SELECT code, uses_left, expires_at, revoked FROM game_codes WHERE code = ?")
      .bind(code)
      .first();
    if (!row || Number(row.revoked) === 1 || Number(row.expires_at) < now || Number(row.uses_left) <= 0) {
      return res.status(403).json({ error: "invalid code" });
    }

    db.prepare("UPDATE game_codes SET uses_left = uses_left - 1 WHERE code = ?").bind(code).run();
    const expiresAt = now + 30 * GAME_DAY;
    const token = `${expiresAt}.${code}.${hmacHex(key, `game:${expiresAt}:${code}`)}`;
    audit(code, "activate", `expiresAt=${expiresAt}`);
    return res.status(200).json({ token, expiresAt });
  });

  // =========================================================================
  // POST /game/verify —— 建房前校验（吊销/过期才拦）
  // =========================================================================
  router.post("/game/verify", (req, res) => {
    const key = secret();
    // 没配密钥时放行：宁可让人建不了房，也不要让所有人被一个配置问题挡在门外
    if (!key) return res.status(200).json({ ok: true, note: "服务未配置" });

    const parts = String((req.body ?? {}).token ?? "").split(".");
    if (parts.length !== 3) return res.status(403).json({ error: "invalid" });
    const [expiresAt, code, sig] = parts;

    if (!safeEqual(sig, hmacHex(key, `game:${expiresAt}:${code}`))) {
      return res.status(403).json({ error: "invalid" });
    }
    if (Number(expiresAt) < Date.now()) return res.status(403).json({ error: "invalid" });

    // uses_left 只约束"激活次数"（entitle 时扣），不影响已激活令牌的后续校验
    const row = db
      .prepare("SELECT expires_at, revoked FROM game_codes WHERE code = ?")
      .bind(code)
      .first();
    if (!row || Number(row.revoked) === 1 || Number(row.expires_at) < Date.now()) {
      return res.status(403).json({ error: "revoked" });
    }
    return res.status(200).json({ ok: true });
  });

  // =========================================================================
  // GET/POST /game-admin —— 运营后台（发码 / 吊销 / 员工令牌）
  // =========================================================================
  router.all("/game-admin", (req, res) => {
    const provided = String(req.query.staff ?? req.headers["x-admin-token"] ?? "");
    const who = authenticateStaff(provided);
    if (!who) {
      return res
        .status(401)
        .send(page("开黑圈运营 · 无权访问", "<p>令牌无效或已被吊销。</p>", ""));
    }

    const flash = [];
    if (req.method === "POST") {
      const form = req.body ?? {};
      const action = String(form.action ?? "");

      if (action === "new_code") {
        const uses = Math.max(1, Math.min(50, Number(form.uses) || 1));
        const days = Math.max(1, Math.min(365, Number(form.days) || 30));
        const note = String(form.note ?? "").slice(0, 60);
        const code = `BLONG-${randomToken(3).toUpperCase()}`;
        const now = Date.now();
        db.prepare(
          "INSERT INTO game_codes (code, note, uses_left, expires_at, revoked, created_at, created_by) " +
            "VALUES (?, ?, ?, ?, 0, ?, ?)",
        )
          .bind(code, note, uses, now + days * GAME_DAY, now, who.name)
          .run();
        audit(who.name, "new_code", `${code} uses=${uses} days=${days}`);
        flash.push(
          `<div class="flash-ok">🎟 新创建码 <code style="font-size:16px">${escapeHtml(code)}</code> · ${uses} 次 · ${days} 天 · <b>只显示这一次</b></div>`,
        );
      }

      if (action === "revoke_code") {
        const code = String(form.code ?? "");
        db.prepare("UPDATE game_codes SET revoked = 1 WHERE code = ?").bind(code).run();
        audit(who.name, "revoke_code", code);
        flash.push(`已吊销 ${escapeHtml(code)}`);
      }

      // 员工令牌只有主令牌能发/收，避免员工自己续命
      if (action === "new_staff" && who.role === "main") {
        const name = String(form.name ?? "运营").slice(0, 20);
        const token = randomToken(24);
        db.prepare(
          "INSERT INTO staff_tokens (id, name, scope, token_hash, created_at, expires_at, revoked) " +
            "VALUES (?, ?, 'game', ?, ?, ?, 0)",
        )
          .bind(randomToken(6), name, sha256Hex(token), Date.now(), Date.now() + 90 * GAME_DAY)
          .run();
        const link = `${req.protocol}://${req.get("host")}/game-admin?staff=${token}`;
        flash.push(
          `<div class="flash-ok">👤 员工令牌（${escapeHtml(name)}）· 90 天<br>` +
            `<code style="font-size:12px;word-break:break-all">${escapeHtml(link)}</code><br>` +
            `<b>只显示这一次</b>，把整条链接发给对方即可</div>`,
        );
      }

      if (action === "revoke_staff" && who.role === "main") {
        db.prepare("UPDATE staff_tokens SET revoked = 1 WHERE id = ?").bind(String(form.id ?? "")).run();
        audit(who.name, "revoke_staff", String(form.id ?? ""));
        flash.push("已吊销员工令牌");
      }

      /*
       * PRG（Post-Redirect-Get）：处理完 302 回本页。
       * 不这么做的话，业主刷新一次就会重复提交一次（实测踩过）。
       */
      const q = new URLSearchParams({ staff: provided });
      if (flash.length) q.set("flash", flash.join("\n"));
      return res.redirect(302, `/game-admin?${q.toString()}`);
    }

    const urlFlash = String(req.query.flash ?? "");
    if (urlFlash) flash.push(...urlFlash.split("\n").filter(Boolean));

    const codes = db
      .prepare("SELECT * FROM game_codes ORDER BY created_at DESC LIMIT 30")
      .all().results;
    const staff = db
      .prepare("SELECT id, name, scope, created_at, expires_at, revoked FROM staff_tokens ORDER BY created_at DESC LIMIT 20")
      .all().results;
    const audits = db
      .prepare("SELECT at, actor, action, detail FROM game_audit ORDER BY at DESC LIMIT 20")
      .all().results;

    const fmt = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace("T", " ") : "-");
    const now = Date.now();

    const codeRows = codes
      .map((c) => {
        const dead = Number(c.revoked) === 1;
        const expired = Number(c.expires_at) < now;
        const state = dead ? "已吊销" : expired ? "已过期" : `剩 ${c.uses_left} 次`;
        return `<tr>
  <td><code>${escapeHtml(c.code)}</code></td>
  <td>${escapeHtml(c.note || "-")}</td>
  <td class="num">${escapeHtml(state)}</td>
  <td class="dim">${escapeHtml(fmt(c.expires_at))}</td>
  <td class="dim">${escapeHtml(c.created_by || "-")}</td>
  <td>${
    dead || expired
      ? ""
      : `<form method="post" style="display:inline"><input type="hidden" name="action" value="revoke_code" />
         <input type="hidden" name="code" value="${escapeHtml(c.code)}" />
         <button class="a-ghost">吊销</button></form>`
  }</td>
</tr>`;
      })
      .join("");

    const staffRows = staff
      .map(
        (s) => `<tr>
  <td>${escapeHtml(s.name || "-")}</td>
  <td class="dim">${escapeHtml(s.scope || "-")}</td>
  <td class="dim">${escapeHtml(fmt(s.expires_at))}</td>
  <td class="num">${Number(s.revoked) === 1 ? '<span class="dim">已吊销</span>' : '<span class="tag tag-live">有效</span>'}</td>
  <td>${
    Number(s.revoked) === 1 || who.role !== "main"
      ? ""
      : `<form method="post" style="display:inline"><input type="hidden" name="action" value="revoke_staff" />
         <input type="hidden" name="id" value="${escapeHtml(s.id)}" />
         <button class="a-ghost">吊销</button></form>`
  }</td>
</tr>`,
      )
      .join("");

    const auditRows = audits
      .map(
        (a) => `<tr>
  <td class="dim">${escapeHtml(fmt(a.at))}</td>
  <td>${escapeHtml(a.actor || "-")}</td>
  <td>${escapeHtml(a.action || "-")}</td>
  <td class="dim">${escapeHtml(a.detail || "")}</td>
</tr>`,
      )
      .join("");

    const body = `
${flash.length ? flash.map((f) => `<div class="flash-ok">${f}</div>`).join("") : ""}

<div class="card">
  <h2 style="margin-top:0">发一个新创建码</h2>
  <form method="post" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <input type="hidden" name="action" value="new_code" />
    <label>次数 <input name="uses" type="number" min="1" max="50" value="1" style="width:80px"></label>
    <label>天数 <input name="days" type="number" min="1" max="365" value="30" style="width:80px"></label>
    <label style="flex:1 1 200px">备注 <input name="note" maxlength="60" placeholder="给谁用的" style="width:100%"></label>
    <button class="a-primary">生成</button>
  </form>
  <p class="dim" style="margin:10px 0 0">创建码只显示这一次，请立刻复制给对方。</p>
</div>

<div class="card">
  <h2 style="margin-top:0">创建码（最近 30 条）</h2>
  <table><thead><tr><th>码</th><th>备注</th><th>状态</th><th>到期</th><th>创建人</th><th></th></tr></thead>
  <tbody>${codeRows || '<tr><td colspan="6" class="dim">还没有创建码</td></tr>'}</tbody></table>
</div>

<div class="card">
  <h2 style="margin-top:0">员工令牌</h2>
  ${
    who.role === "main"
      ? `<form method="post" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
    <input type="hidden" name="action" value="new_staff" />
    <label style="flex:1 1 180px">名字 <input name="name" maxlength="20" placeholder="运营小明" style="width:100%"></label>
    <button class="a-primary">签发（90 天）</button>
  </form>`
      : '<p class="dim">只有主令牌可以签发员工令牌。</p>'
  }
  <table><thead><tr><th>名字</th><th>权限</th><th>到期</th><th>状态</th><th></th></tr></thead>
  <tbody>${staffRows || '<tr><td colspan="5" class="dim">还没有员工令牌</td></tr>'}</tbody></table>
</div>

<div class="card">
  <h2 style="margin-top:0">操作记录</h2>
  <table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>详情</th></tr></thead>
  <tbody>${auditRows || '<tr><td colspan="4" class="dim">暂无记录</td></tr>'}</tbody></table>
</div>`;

    return res.type("html").send(page("开黑圈运营", body, provided));
  });

  return router;
}
