/**
 * 直接用 Cloudflare API 部署到 Pages，不依赖 wrangler。
 *
 * 环境里没有 npm / npx / wrangler，但本机已有 wrangler 的 OAuth 凭据，
 * 所以这里复刻 wrangler 的上传流程（对照 workers-sdk 的 pages/upload.ts）：
 *   1. 刷新 OAuth token（refresh token 存在就自动续期，不需要 client secret）
 *   2. GET  /accounts                                  → account_id
 *   3. GET  /accounts/:id/pages/projects/:name/upload-token
 *   4. POST /pages/assets/check-missing                → 只上传缺的
 *   5. POST /pages/assets/upload                       → 每个 bucket 一条 JSON 数组
 *   6. POST /pages/assets/upsert-hashes
 *   7. POST /accounts/:id/pages/projects/:name/deployments（multipart manifest）
 *
 * 用法：node scripts/deploy-pages.mjs [目录] [项目名] [分支]
 * 默认：dist-web / 5blong / main
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// BLAKE3 的校验副本（官方测试向量见 tests/blake3.test.ts；需与 src/shared/blake3.ts 同步）。
// 这里内联是为了让部署脚本在被 npm/构建工具隔离的环境里也能直接跑。
import { blake3Hex } from "./lib/blake3.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.resolve(root, process.argv[2] ?? "dist-web");
const projectName = process.argv[3] ?? "5blong";
const branch = process.argv[4] ?? "main";

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

/** 拿一个可用的 access token：没过期就直接用，过期就续期。 */
async function getToken() {
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

// ------------------------------------------------------------------- 主流程

async function main() {
  if (!existsSync(directory) || !existsSync(path.join(directory, "index.html"))) {
    throw new Error(`${directory} 不像是构建产物（缺少 index.html），请先构建`);
  }

  const token = await getToken();

  const accounts = await api(token, "/accounts?per_page=50");
  const account = accounts?.[0];
  if (!account) throw new Error("这个凭据下没有可用的 Cloudflare 账号");
  log("account", `${account.name} (${account.id})`);

  const project = await api(token, `/accounts/${account.id}/pages/projects/${projectName}`);
  log("project", `${project.name} · 生产分支 ${project.production_branch}`);

  const files = walk(directory).map((name) => {
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
