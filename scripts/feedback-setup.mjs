/**
 * 意见反馈后台基建（一次性 / 幂等）：
 *   1. 建 D1 数据库 5blong-feedback（已存在则复用）
 *   2. 建表（worker/feedback-schema.sql，IF NOT EXISTS）
 *   3. 绑定到 Pages 项目（DB → 生产与预览环境，保留原有环境变量）
 *   4. 生成并写入管理员令牌 FEEDBACK_TOKEN（存 .dev-secrets.json，已 gitignore）
 *
 * 用法：npm run feedback:setup
 * 凭据：优先环境变量 CLOUDFLARE_API_TOKEN，否则复用本机 wrangler OAuth（需 d1:write + pages:write）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const OAUTH_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CONFIG = path.join(process.env.APPDATA ?? "", "xdg.config", ".wrangler", "config", "default.toml");
const SECRETS_PATH = path.join(root, ".dev-secrets.json");
const SCHEMA_PATH = path.join(root, "worker", "feedback-schema.sql");
const DB_NAME = "5blong-feedback";
const PROJECT_NAME = "5blong";

function log(step, message) {
  process.stdout.write(`[${step}] ${message}\n`);
}

// ------------------------------------------------------------------ 凭据

function readWranglerConfig() {
  if (!existsSync(WRANGLER_CONFIG)) {
    throw new Error(`找不到 wrangler 凭据：${WRANGLER_CONFIG}\n先在本机跑一次 npx wrangler whoami 完成登录。`);
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
    const detail = payload?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? text.slice(0, 200);
    throw new Error(`${init.method ?? "GET"} ${route} 失败（HTTP ${response.status}）：${detail}`);
  }
  return payload?.result;
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const token = await getToken();
  const accounts = await api(token, "/accounts?per_page=50");
  const account = accounts?.[0];
  if (!account) throw new Error("这个凭据下没有可用的 Cloudflare 账号");
  log("account", `${account.name} (${account.id})`);

  // 1. 建库（已存在则复用）
  const existing = await api(token, `/accounts/${account.id}/d1/database?per_page=100`);
  let database = (existing ?? []).find((db) => db.name === DB_NAME);
  if (database) {
    log("d1", `复用已有数据库 ${DB_NAME}（${database.uuid}）`);
  } else {
    database = await api(token, `/accounts/${account.id}/d1/database`, {
      method: "POST",
      body: JSON.stringify({ name: DB_NAME }),
    });
    log("d1", `已创建数据库 ${DB_NAME}（${database.uuid}）`);
  }

  // 2. 建表（幂等）
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const statements = schema
    .split(";")
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
  for (const sql of statements) {
    await api(token, `/accounts/${account.id}/d1/database/${database.uuid}/query`, {
      method: "POST",
      body: JSON.stringify({ sql }),
    });
  }
  log("schema", `已应用 ${statements.length} 条建表语句`);

  // 3. 管理员令牌
  let secrets = {};
  if (existsSync(SECRETS_PATH)) secrets = JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
  if (!secrets.feedbackToken) {
    secrets.feedbackToken = randomBytes(24).toString("base64url");
    writeFileSync(SECRETS_PATH, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
    log("token", "已生成管理员令牌并写入 .dev-secrets.json");
  } else {
    log("token", "复用 .dev-secrets.json 里已有的管理员令牌");
  }

  // 4. 绑定到 Pages 项目（保留原有环境变量与配置）
  const project = await api(token, `/accounts/${account.id}/pages/projects/${PROJECT_NAME}`);
  const patch = {};
  for (const envName of ["production", "preview"]) {
    const current = project?.deployment_configs?.[envName] ?? {};
    patch[envName] = {
      ...current,
      d1_databases: { ...(current.d1_databases ?? {}), DB: { id: database.uuid } },
      env_vars: {
        ...(current.env_vars ?? {}),
        FEEDBACK_TOKEN: { type: "secret_text", value: secrets.feedbackToken },
      },
    };
  }
  await api(token, `/accounts/${account.id}/pages/projects/${PROJECT_NAME}`, {
    method: "PATCH",
    body: JSON.stringify({ deployment_configs: patch }),
  });
  log("pages", `已绑定 DB → ${PROJECT_NAME}（生产 + 预览）`);

  const adminUrl = `https://${PROJECT_NAME}.pages.dev/admin?token=<.dev-secrets.json 里的 feedbackToken>`;
  log("done", `基建完成。管理页：${adminUrl}`);
  log("next", "执行一次部署后生效：npm run publish:desktop -- <当前版本>（会带上 dist-web 与 _worker.js）");
}

main().catch((error) => {
  process.stderr.write(`\n${error.message}\n`);
  process.exit(1);
});
