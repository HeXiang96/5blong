/**
 * 账号 / 好友 / 固定房号 → D1 建表（幂等，可反复跑）。
 *
 * 干什么：
 *   1. 复用已有 D1 库 `5blong-feedback`（Pages 项目的 DB 绑定就是它，不再新建第二个库）；
 *   2. 执行 worker/accounts-schema.sql（全部 IF NOT EXISTS，不会动既有数据）；
 *   3. 打印建出来的表，方便确认。
 *
 * 用法：npm run accounts:setup
 * 凭据：优先环境变量 CLOUDFLARE_API_TOKEN，否则复用本机 wrangler OAuth。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const OAUTH_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CONFIG = path.join(
  process.env.APPDATA ?? "",
  "xdg.config",
  ".wrangler",
  "config",
  "default.toml",
);
const SCHEMA_PATH = path.join(root, "worker", "accounts-schema.sql");
const DB_NAME = "5blong-feedback";

const log = (step, message) => process.stdout.write(`[${step}] ${message}\n`);

function readWranglerConfig() {
  if (!existsSync(WRANGLER_CONFIG)) {
    throw new Error(`找不到 wrangler 凭据：${WRANGLER_CONFIG}\n先跑一次 npx wrangler whoami 完成登录。`);
  }
  const raw = readFileSync(WRANGLER_CONFIG, "utf8");
  const pick = (key) => new RegExp(`${key}\\s*=\\s*"([^"]+)"`).exec(raw)?.[1] ?? "";
  return {
    raw,
    oauthToken: pick("oauth_token"),
    refreshToken: pick("refresh_token"),
    expirationTime: pick("expiration_time"),
  };
}

async function refreshOAuth(config) {
  if (!config.refreshToken) throw new Error("凭据里没有 refresh_token，请在浏览器里重新登录一次 wrangler。");
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  });
  if (!response.ok) throw new Error(`刷新 OAuth 凭据失败（HTTP ${response.status}）`);
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
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  if (envToken) {
    log("auth", "使用环境变量 CLOUDFLARE_API_TOKEN");
    return envToken;
  }
  const config = readWranglerConfig();
  const expiresAt = Date.parse(config.expirationTime);
  if (config.oauthToken && Number.isFinite(expiresAt) && expiresAt - Date.now() > 120_000) {
    log("auth", "复用本机 wrangler 凭据");
    return config.oauthToken;
  }
  log("auth", "凭据已过期，正在续期");
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
    const detail =
      payload?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? text.slice(0, 200);
    throw new Error(`${init.method ?? "GET"} ${route} 失败（HTTP ${response.status}）：${detail}`);
  }
  return payload?.result;
}

async function main() {
  const token = await getToken();
  const accounts = await api(token, "/accounts?per_page=50");
  const account = accounts?.[0];
  if (!account) throw new Error("这个凭据下没有可用的 Cloudflare 账号");
  log("account", `${account.name} (${account.id})`);

  const existing = await api(token, `/accounts/${account.id}/d1/database?per_page=100`);
  const database = (existing ?? []).find((db) => db.name === DB_NAME);
  if (!database) throw new Error(`没找到 D1 库 ${DB_NAME}，先跑 npm run feedback:setup 建库并绑定 Pages`);
  log("d1", `${DB_NAME}（${database.uuid}）`);

  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const statements = schema
    .split(";")
    .map((sql) => sql.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
  log("schema", `${statements.length} 条语句（全部 IF NOT EXISTS）`);
  for (const sql of statements) {
    try {
      await api(token, `/accounts/${account.id}/d1/database/${database.uuid}/query`, {
        method: "POST",
        body: JSON.stringify({ sql }),
      });
    } catch (error) {
      // 老库补列是 ALTER：重复执行会 duplicate column，这不是失败
      if (/duplicate column/i.test(String(error?.message ?? ""))) continue;
      throw error;
    }
  }

  const check = await api(token, `/accounts/${account.id}/d1/database/${database.uuid}/query`, {
    method: "POST",
    body: JSON.stringify({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    }),
  });
  const tables = (check?.[0]?.results ?? []).map((row) => row.name);
  log("tables", tables.join(", "));
  /*
   * 校验清单必须跟着 schema 走（2026-10-27）：
   * 上一版只查了 6 张老表，所以"新表没建成"也会打印 done —— 而少一张表
   * 就是一片接口 500（recent_plays 挂了，好友面板里的「最近玩」直接空）。
   */
  const required = [
    "accounts",
    "friendships",
    "friend_requests",
    "account_sessions",
    "account_presence",
    "room_invites",
    "recent_plays",
    "knocks",
    "daily_actions",
    "room_holds",
    "admin_audit",
  ];
  for (const needed of required) {
    if (!tables.includes(needed)) throw new Error(`建表失败：缺 ${needed}`);
  }

  /*
   * 列也要查：ALTER 那条被"duplicate column"跳过时无法区分"早就有了"
   * 和"这张表压根没有这一列"，只能靠 pragma 确认一次。
   */
  const columnsOf = async (table) => {
    const rows = await api(token, `/accounts/${account.id}/d1/database/${database.uuid}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: `PRAGMA table_info(${table})` }),
    });
    return (rows?.[0]?.results ?? []).map((row) => row.name);
  };
  const columns = [
    ["friendships", "alias"],
    ["friend_requests", "note"],
    ["friend_requests", "status"],
    ["room_invites", "room_key"],
    ["accounts", "room_changes"],
    ["accounts", "prev_id"],
  ];
  for (const [table, column] of columns) {
    const names = await columnsOf(table);
    if (!names.includes(column)) throw new Error(`加列失败：${table}.${column} 不存在`);
  }
  log("columns", "alias / note / status / room_key / room_changes / prev_id 均在位");
  log("done", "账号 / 好友 / 固定房号 / 邀请 / 最近一起玩 / 敲门 表已就绪");
}

main().catch((error) => {
  process.stderr.write(`\n❌ ${error.message}\n`);
  process.exitCode = 1;
});
