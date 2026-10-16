/**
 * 把 Pages 项目与自建信令 Worker 绑起来（service binding `SIGNAL`）。
 *
 * 为什么需要：客户端只连 5blong.pages.dev/peerjs，Pages Worker 通过服务绑定
 * 把请求转给 5blong-signal —— 不走公网（workers.dev 在大陆常不可达）、
 * 不产生流量费，也不受第三方域名拦截影响。
 *
 * 用法：npm run signal:setup（幂等；会同时写生产与预览环境）
 * 凭据：环境变量 CLOUDFLARE_API_TOKEN，否则复用本机 wrangler OAuth（需 pages:write）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const OAUTH_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CONFIG = path.join(process.env.APPDATA ?? "", "xdg.config", ".wrangler", "config", "default.toml");
const PROJECT_NAME = "5blong";
const SIGNAL_SERVICE = "5blong-signal";
const SECRETS_PATH = path.join(root, ".dev-secrets.json");

const log = (step, msg) => process.stdout.write(`[${step}] ${msg}\n`);

function readWranglerConfig() {
  const raw = readFileSync(WRANGLER_CONFIG, "utf8");
  const pick = (k) => new RegExp(`${k}\\s*=\\s*"([^"]+)"`).exec(raw)?.[1] ?? "";
  return { raw, oauthToken: pick("oauth_token"), refreshToken: pick("refresh_token"), expirationTime: pick("expiration_time") };
}

async function refreshOAuth(config) {
  const res = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: config.refreshToken, client_id: OAUTH_CLIENT_ID }),
  });
  if (!res.ok) throw new Error(`刷新凭据失败（HTTP ${res.status}）：重新跑一次 wrangler login`);
  const token = await res.json();
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
  log("auth", "凭据过期，正在续期");
  return refreshOAuth(config);
}

async function api(token, route, init = {}) {
  const res = await fetch(`${API}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!res.ok || (payload && payload.success === false)) {
    const detail = payload?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? text.slice(0, 200);
    throw new Error(`${init.method ?? "GET"} ${route} 失败（HTTP ${res.status}）：${detail}`);
  }
  return payload?.result;
}

async function main() {
  const token = await getToken();
  const accounts = await api(token, "/accounts?per_page=50");
  const account = accounts?.[0];
  if (!account) throw new Error("凭据下没有可用账号");

  const project = await api(token, `/accounts/${account.id}/pages/projects/${PROJECT_NAME}`);
  const secrets = existsSync(SECRETS_PATH) ? JSON.parse(readFileSync(SECRETS_PATH, "utf8")) : {};
  if (!secrets.feedbackToken) throw new Error("找不到 feedbackToken：先跑 npm run feedback:setup");
  const patch = {};
  for (const envName of ["production", "preview"]) {
    const current = project?.deployment_configs?.[envName] ?? {};
    patch[envName] = {
      ...current,
      // Pages 的 service binding：绑定名 → 目标 Worker
      services: { ...(current.services ?? {}), SIGNAL: { service: SIGNAL_SERVICE } },
      // 预览环境也要有令牌（否则预览站的面板会 501）
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
  log("pages", `已绑定 SIGNAL → ${SIGNAL_SERVICE}（生产 + 预览）`);

  // 信令 Worker 需要同一把令牌来校验 /rooms-live 的访问（存成 Secret，不进仓库）
  await api(token, `/accounts/${account.id}/workers/scripts/${SIGNAL_SERVICE}/secrets`, {
    method: "PUT",
    body: JSON.stringify({ name: "FEEDBACK_TOKEN", text: secrets.feedbackToken, type: "secret_text" }),
  });
  log("worker", `已写入 ${SIGNAL_SERVICE} 的 FEEDBACK_TOKEN Secret`);

  const after = await api(token, `/accounts/${account.id}/pages/projects/${PROJECT_NAME}`);
  const bound = after?.deployment_configs?.production?.services?.SIGNAL;
  log("verify", bound ? `生产环境绑定确认：${JSON.stringify(bound)}` : "⚠️ 没读到绑定，请检查 API 形态");
  log("next", "跑一次部署（含 _worker.js）后生效：node scripts/deploy-pages.mjs dist-web 5blong <分支>");
}

main().catch((error) => {
  process.stderr.write(`\n${error.message}\n`);
  process.exit(1);
});
