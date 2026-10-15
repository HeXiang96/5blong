/**
 * 意见反馈后台的小工具（本机用，不出网到别人的服务）：
 *
 *   npm run feedback:admin url            打印带管理员令牌的管理页链接（可直接存书签）
 *   npm run feedback:admin list [条数]    在终端列出最近反馈（默认 20 条）
 *   npm run feedback:admin rm <id>        删掉某条（比如自己发的测试数据）
 *
 * 凭据：令牌读 `.dev-secrets.json` 的 feedbackToken（gitignore）；D1 访问复用本机
 * wrangler OAuth 凭据（与 feedback:setup 同一套）。管理页本身是
 * `/admin?token=...`，手机浏览器也能看。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const OAUTH_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CONFIG = path.join(process.env.APPDATA ?? "", "xdg.config", ".wrangler", "config", "default.toml");
const SECRETS_PATH = path.join(root, ".dev-secrets.json");
const DB_NAME = "5blong-feedback";
const SITE = "https://5blong.pages.dev";

const [command = "url", ...rest] = process.argv.slice(2);

function readSecrets() {
  if (!existsSync(SECRETS_PATH)) throw new Error("找不到 .dev-secrets.json（先跑 npm run feedback:setup）");
  return JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
}

// ------------------------------------------------------------------ 凭据 / API

function readWranglerConfig() {
  const raw = readFileSync(WRANGLER_CONFIG, "utf8");
  const pick = (key) => new RegExp(`${key}\\s*=\\s*"([^"]+)"`).exec(raw)?.[1] ?? "";
  return { raw, oauthToken: pick("oauth_token"), refreshToken: pick("refresh_token"), expirationTime: pick("expiration_time") };
}

async function refreshOAuth(config) {
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  });
  if (!response.ok) throw new Error(`刷新 Cloudflare 凭据失败（HTTP ${response.status}）：重新跑 npx wrangler login`);
  const token = await response.json();
  const expiration = new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString();
  writeFileSync(
    WRANGLER_CONFIG,
    config.raw
      .replace(/oauth_token\s*=\s*"[^"]*"/, `oauth_token = "${token.access_token}"`)
      .replace(/expiration_time\s*=\s*"[^"]*"/, `expiration_time = "${expiration}"`)
      .replace(/refresh_token\s*=\s*"[^"]*"/, `refresh_token = "${token.refresh_token ?? config.refreshToken}"`),
    "utf8",
  );
  return token.access_token;
}

async function getToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const config = readWranglerConfig();
  const expiresAt = Date.parse(config.expirationTime);
  if (config.oauthToken && Number.isFinite(expiresAt) && expiresAt - Date.now() > 120_000) return config.oauthToken;
  return refreshOAuth(config);
}

async function api(token, route, init = {}) {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || (payload && payload.success === false)) {
    const detail = payload?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? text.slice(0, 200);
    throw new Error(`${init.method ?? "GET"} ${route} 失败（HTTP ${response.status}）：${detail}`);
  }
  return payload?.result;
}

async function query(sql, params = []) {
  const token = await getToken();
  const accounts = await api(token, "/accounts?per_page=50");
  const account = accounts?.[0];
  if (!account) throw new Error("凭据下没有可用账号");
  const databases = await api(token, `/accounts/${account.id}/d1/database?per_page=100`);
  const database = (databases ?? []).find((db) => db.name === DB_NAME);
  if (!database) throw new Error(`找不到数据库 ${DB_NAME}（先跑 npm run feedback:setup）`);
  const result = await api(token, `/accounts/${account.id}/d1/database/${database.uuid}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
  return result?.[0]?.results ?? [];
}

// ------------------------------------------------------------------ 子命令

const CATEGORY_LABELS = {
  voice: "语音",
  mic: "麦克风",
  room: "进出房间",
  screen: "屏幕共享",
  lag: "卡顿掉线",
  other: "其它",
};

function localTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso ?? "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function main() {
  const secrets = readSecrets();

  if (command === "url") {
    // 只打印链接，方便存书签；令牌即密钥，别贴到群里
    process.stdout.write(`${SITE}/admin?token=${secrets.feedbackToken}\n`);
    return;
  }

  if (command === "list") {
    const limit = Math.min(200, Math.max(1, Number(rest[0] ?? 20) || 20));
    const rows = await query(
      "SELECT id, created_at, version, platform, category, message, contact, context_json, status " +
        "FROM feedback ORDER BY created_at DESC LIMIT ?",
      [limit],
    );
    if (rows.length === 0) {
      process.stdout.write("（还没有收到反馈）\n");
      return;
    }
    const pending = rows.filter((row) => row.status !== "done").length;
    process.stdout.write(`最近 ${rows.length} 条（待处理 ${pending} 条）：\n\n`);
    for (const row of rows) {
      const mark = row.status === "done" ? "✔" : "•";
      process.stdout.write(
        `${mark} [${localTime(row.created_at)}] ${CATEGORY_LABELS[row.category] ?? row.category ?? "其它"}` +
          ` · v${row.version || "?"} · ${row.platform || "?"}\n`,
      );
      process.stdout.write(`   ${String(row.message).replace(/\n/g, "\n   ")}\n`);
      if (row.contact) process.stdout.write(`   联系方式：${row.contact}\n`);
      if (row.context_json) {
        try {
          const ctx = JSON.parse(row.context_json);
          process.stdout.write(`   环境：${Object.entries(ctx).map(([k, v]) => `${k}=${v}`).join(" · ")}\n`);
        } catch {
          /* 忽略脏 JSON */
        }
      }
      process.stdout.write(`   id: ${row.id}\n\n`);
    }
    return;
  }

  if (command === "rm") {
    const id = rest[0];
    if (!id) throw new Error("用法：npm run feedback:admin rm <id>");
    await query("DELETE FROM feedback WHERE id = ?", [id]);
    process.stdout.write(`已删除 ${id}\n`);
    return;
  }

  throw new Error(`未知子命令：${command}（可用：url / list / rm）`);
}

main().catch((error) => {
  process.stderr.write(`\n${error.message}\n`);
  process.exit(1);
});
