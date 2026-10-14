/**
 * 直接用 Cloudflare API 部署到 Pages，不依赖 wrangler。
 *
 * 认证二选一：
 *   - 环境变量 CLOUDFLARE_API_TOKEN（CI 里用；需 Cloudflare Pages: Edit 权限）；
 *   - 本机 wrangler 的 OAuth 凭据（没有上述变量时），过期自动续期
 *     （复刻 wrangler 的上传流程，对照 workers-sdk 的 pages/upload.ts）。
 *
 * 上传流程（与 wrangler 一致）：
 *   1. GET  /accounts                                  → account_id
 *   2. GET  /accounts/:id/pages/projects/:name/upload-token
 *   3. POST /pages/assets/check-missing                → 只上传缺的
 *   4. POST /pages/assets/upload                       → 每个 bucket 一条 JSON 数组
 *   5. POST /pages/assets/upsert-hashes
 *   6. POST /accounts/:id/pages/projects/:name/deployments（multipart manifest）
 *
 * 用法：node scripts/deploy-pages.mjs [目录] [项目名] [分支] [--env-only]
 * 默认：dist-web / 5blong / main
 * --env-only：只把 .dev-secrets.json 里的服务端凭证写进 Pages 环境变量，不上传站点
 *             （Pages 是整站替换，单独跑一次普通部署会把线上的 /desktop/ 更新源删掉，
 *              所以"只想同步密钥"时必须用这个开关）。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// BLAKE3 的校验副本（官方测试向量见 tests/blake3.test.ts；需与 src/shared/blake3.ts 同步）。
// 这里内联是为了让部署脚本在被 npm/构建工具隔离的环境里也能直接跑。
import { blake3Hex } from "./lib/blake3.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const directory = path.resolve(root, positional[0] ?? "dist-web");
const projectName = positional[1] ?? "5blong";
const branch = positional[2] ?? "main";
/** 只写 Pages 项目环境变量，不上传站点。 */
const envOnly = flags.includes("--env-only");

const API = "https://api.cloudflare.com/client/v4";
/** wrangler 的公开 OAuth 客户端；refresh 用 PKCE，不需要 client secret。 */
const OAUTH_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const WRANGLER_CONFIG = path.join(
  process.env.APPDATA ?? "",
  "xdg.config",
  ".wrangler",
  "config",
  "default.toml",
);

/** 与 wrangler 的常量保持一致。 */
const MAX_ASSET_SIZE = 25 * 1024 * 1024;
const MAX_BUCKET_SIZE = 40 * 1024 * 1024;
const MAX_BUCKET_FILE_COUNT = 1000;

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function log(step, message) {
  process.stdout.write(`[deploy] ${step.padEnd(10)} ${message}\n`);
}

function contentTypeOf(name) {
  return MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Cloudflare Pages 的资源指纹（与 wrangler 的 deploy-helpers 一致）：
 *   hex(blake3(base64(文件内容) + 扩展名不带点)).slice(0, 32)
 * 算错这个值，资产就永远进不了服务器的库，部署记录虽然 success，
 * 线上却会因为取不到资源而整站 500。
 */
function assetHash(fullPath, name) {
  const base64 = readFileSync(fullPath).toString("base64");
  const extension = path.extname(name).replace(/^\./, "");
  return blake3Hex(base64 + extension).slice(0, 32);
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      out.push(...walk(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

// ---------------------------------------------------------------- OAuth 续期

function readWranglerConfig() {
  if (!existsSync(WRANGLER_CONFIG)) {
    throw new Error(
      `找不到 wrangler 凭据：${WRANGLER_CONFIG}\n先在本机跑一次 npx wrangler pages deploy 完成登录。`,
    );
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
  if (!config.refreshToken) {
    throw new Error("凭据里没有 refresh_token，无法自动续期。请在浏览器里重新登录一次 wrangler。");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`刷新 OAuth 凭据失败（HTTP ${response.status}）：${await response.text()}`);
  }
  const token = await response.json();

  // 写回配置，让 wrangler 与我们后续的部署都能直接复用。
  const expiration = new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString();
  const updated = config.raw
    .replace(/oauth_token\s*=\s*"[^"]*"/, `oauth_token = "${token.access_token}"`)
    .replace(/expiration_time\s*=\s*"[^"]*"/, `expiration_time = "${expiration}"`)
    .replace(
      /refresh_token\s*=\s*"[^"]*"/,
      `refresh_token = "${token.refresh_token ?? config.refreshToken}"`,
    );
  writeFileSync(WRANGLER_CONFIG, updated, "utf8");
  return { token: token.access_token, expiration };
}

/** 拿一个可用的 access token：
 *  - CI 里设了 CLOUDFLARE_API_TOKEN（Pages: Edit 权限）就直接用；
 *  - 本机没有该变量则走 wrangler OAuth 凭据（过期自动续期）。 */
async function getToken() {
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  if (envToken) {
    log("auth", "使用环境变量 CLOUDFLARE_API_TOKEN");
    return envToken;
  }
  const config = readWranglerConfig();
  const expiresAt = Date.parse(config.expirationTime);
  if (config.oauthToken && Number.isFinite(expiresAt) && expiresAt - Date.now() > 120_000) {
    log("auth", "复用现用凭据");
    return config.oauthToken;
  }
  log("auth", "凭据已过期，正在续期");
  const { token, expiration } = await refreshOAuth(config);
  log("auth", `续期成功，有效期至 ${expiration}`);
  return token;
}

// -------------------------------------------------------------------- API

async function api(token, route, init = {}) {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init.headers,
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
      payload?.errors?.map((error) => `${error.code} ${error.message}`).join("; ") ?? text;
    throw new Error(`${init.method ?? "GET"} ${route} 失败（HTTP ${response.status}）：${detail}`);
  }
  return payload?.result;
}

// ------------------------------------------------------------- multipart

/** 手写 multipart：wrangler 注释里提过，边界/头部不对会直接 500。 */
function multipart(fields) {
  const boundary = `----5blong${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n` +
          `Content-Type: application/json\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ------------------------------------------------------------- 环境变量

/**
 * 把本机 `.dev-secrets.json` 的两组服务端凭证写进 Pages 项目的生产环境变量。
 *
 * 两组独立凭证，缺哪组就跳过哪组（与 `scripts/dev-sfu-server.mjs` 的读取顺序一致）：
 *   SFU_APP_ID / SFU_APP_SECRET      → `/sfu/*` 屏幕共享
 *   TURN_KEY_ID / TURN_KEY_API_TOKEN → `/ice`   打洞失败时的中继（TURN key 与 SFU 是两套）
 *
 * 为什么要有 `--env-only`：Pages 的部署是**整站替换**，单独跑一次普通部署会把线上的
 * `/desktop/` 更新源一起删掉。只想同步密钥时就用它，别顺手把站点重发了。
 *
 * 注意：环境变量是在**部署时**注入运行环境的，所以写完变量还得有一次部署才生效
 * （CI 里没有 `.dev-secrets.json`，靠项目上的历史配置带到下一次部署）。
 * 日志只打印键名，永不打印值。
 */
async function syncProjectEnv(token, account, project, required = false) {
  const secretsFile = path.join(root, ".dev-secrets.json");
  if (!existsSync(secretsFile)) {
    const hint = `未找到 ${secretsFile}，无法同步 Pages 环境变量`;
    if (required) throw new Error(hint);
    log("env", `跳过：${hint}`);
    return;
  }
  try {
    const secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
    const wanted = {};
    const appId = secrets.sfuAppId ?? secrets.appId;
    const appSecret = secrets.sfuAppSecret ?? secrets.appSecret;
    if (appId && appSecret) {
      wanted.SFU_APP_ID = appId;
      wanted.SFU_APP_SECRET = appSecret;
    }
    if (secrets.turnKeyId && secrets.turnKeyApiToken) {
      wanted.TURN_KEY_ID = secrets.turnKeyId;
      wanted.TURN_KEY_API_TOKEN = secrets.turnKeyApiToken;
    }
    if (Object.keys(wanted).length === 0) {
      log("env", "本机密钥文件里没有可用的凭证，跳过");
      return;
    }

    const existing = project.deployment_configs?.production?.env_vars ?? {};
    const changed = Object.entries(wanted).filter(([key, value]) => existing[key]?.value !== value);
    if (changed.length === 0) {
      log("env", "Pages 环境变量已是最新，无需写入");
      return;
    }

    // 合并写回：不动其它变量（项目上可能还有别处加的配置）。
    const env_vars = { ...existing };
    for (const [key, value] of Object.entries(wanted)) env_vars[key] = { value };
    await api(token, `/accounts/${account.id}/pages/projects/${projectName}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deployment_configs: { production: { env_vars } } }),
    });
    log("env", `已写入 Pages 环境变量：${changed.map(([key]) => key).join("、")}`);
  } catch (error) {
    if (required) throw error;
    log("env", `环境变量写入跳过：${error.message}`);
  }
}

// ------------------------------------------------------------------- 主流程

async function main() {
  // 注意：这两个路径在下面的部署表单阶段（main 尾部）还要用，
  // 声明必须留在 main() 函数作用域，不能挪进 if 块（const 是块级作用域，踩过坑）。
  const workerSource = path.join(root, "worker", "_worker.pages.js");
  const workerTarget = path.join(directory, "_worker.js");
  if (!envOnly) {
    if (!existsSync(directory) || !existsSync(path.join(directory, "index.html"))) {
      throw new Error(`${directory} 不像是构建产物（缺少 index.html），请先构建`);
    }

    // 屏幕共享同域接口：把 worker/_worker.pages.js 作为 _worker.js 附到部署里
    // （Pages 高级模式；非 /sfu 请求回落静态资源）。**始终覆盖**——
    // dist-deploy 会被复用，残留的旧 _worker.js 会把新修复顶掉（踩过坑）。
    if (existsSync(workerSource)) {
      const { copyFileSync } = await import("node:fs");
      copyFileSync(workerSource, workerTarget);
      log("worker", "已附加 _worker.js（/sfu 屏幕共享接口）");
    }
  }

  const token = await getToken();

  const accounts = await api(token, "/accounts?per_page=50");
  const account = accounts?.[0];
  if (!account) throw new Error("这个凭据下没有可用的 Cloudflare 账号");
  log("account", `${account.name} (${account.id})`);

  const project = await api(token, `/accounts/${account.id}/pages/projects/${projectName}`);
  log("project", `${project.name} · 生产分支 ${project.production_branch}`);

  await syncProjectEnv(token, account, project, envOnly);

  if (envOnly) {
    log("done", "只写了环境变量，未上传站点（线上产物保持不变）");
    return;
  }

  const files = walk(directory)
    .filter((name) => name !== "_worker.js") // _worker.js 不进静态清单，单独附到部署表单
    .map((name) => {
    const full = path.join(directory, name);
    const size = statSync(full).size;
    if (size > MAX_ASSET_SIZE) throw new Error(`${name} 超过 Pages 单文件上限（25 MiB）`);
    return {
      name,
      full,
      size,
      contentType: contentTypeOf(name),
      hash: assetHash(full, name),
    };
  });
  log("files", `${files.length} 个文件，共 ${(files.reduce((sum, f) => sum + f.size, 0) / 1024).toFixed(0)} KB`);

  const { jwt } = await api(
    token,
    `/accounts/${account.id}/pages/projects/${projectName}/upload-token`,
  );

  const missing = await api(token, "/pages/assets/check-missing", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ hashes: files.map((file) => file.hash) }),
  });
  const missingSet = new Set(missing ?? []);
  const toUpload = files.filter((file) => missingSet.has(file.hash));
  log("cache", `${files.length - toUpload.length} 个已存在，需要上传 ${toUpload.length} 个`);

  // 按从大到小装桶，桶内不超过 40 MiB / 1000 个文件（与 wrangler 一致）。
  const buckets = [];
  for (const file of [...toUpload].sort((a, b) => b.size - a.size)) {
    let bucket = buckets.find(
      (item) => item.remaining >= file.size && item.files.length < MAX_BUCKET_FILE_COUNT,
    );
    if (!bucket) {
      bucket = { files: [], remaining: MAX_BUCKET_SIZE };
      buckets.push(bucket);
    }
    bucket.files.push(file);
    bucket.remaining -= file.size;
  }

  for (const [index, bucket] of buckets.entries()) {
    const payload = bucket.files.map((file) => ({
      key: file.hash,
      value: readFileSync(file.full).toString("base64"),
      metadata: { contentType: file.contentType },
      base64: true,
    }));
    await api(token, "/pages/assets/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(payload),
    });
    log("upload", `第 ${index + 1}/${buckets.length} 批完成（${bucket.files.length} 个文件）`);
  }

  if (toUpload.length > 0) {
    await api(token, "/pages/assets/upsert-hashes", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ hashes: files.map((file) => file.hash) }),
    });
    log("hashes", "已登记资源指纹");
  }

  const manifest = {};
  for (const file of files) manifest[`/${file.name}`] = file.hash;

  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  form.set("branch", branch);
  // 高级模式 Worker：与 wrangler pages deploy 一致，单独作为 _worker.js 字段提交
  if (existsSync(workerTarget)) {
    form.set(
      "_worker.js",
      new File([readFileSync(workerTarget, "utf8")], "_worker.js", {
        type: "application/javascript+module",
      }),
    );
    log("worker", "_worker.js 已附到部署请求");
  }
  const deployment = await api(
    token,
    `/accounts/${account.id}/pages/projects/${projectName}/deployments`,
    { method: "POST", body: form },
  );

  log("done", `部署完成：${deployment.url}`);
  if (project.subdomain) log("alias", `https://${project.subdomain}`);
  process.stdout.write(`${deployment.url}\n`);
}

await main();
