#!/usr/bin/env node
/**
 * 5blong 屏幕共享 · 本地 SFU 代理（开发/本地验证专用）。
 *
 * Cloudflare Realtime SFU 的 App Secret 只能放在可信后端（见 SCREENSHARE-PLAN.md §B）。
 * 本地验证时用这个 ~100 行的 Node 代理扮演 Worker 的角色：
 *   前端 → /sfu/*（无密钥） → 这里补 Bearer 密钥 → rtc.live.cloudflare.com
 *
 * 生产环境的等价物是 worker/index.js（Wrangler 部署），接口完全一致，
 * 所以前端代码在"本地代理"与"线上 Worker"之间零改动切换。
 *
 * 用法：
 *   node scripts/dev-sfu-server.mjs
 * 凭证读取顺序：环境变量 SFU_APP_ID / SFU_APP_SECRET → .dev-secrets.json。
 * 凭证文件已进 .gitignore，绝不入库。
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SFU_BASE = "https://rtc.live.cloudflare.com/v1";
const PORT = Number(process.env.SFU_PORT ?? 8789);

function loadSecrets() {
  if (process.env.SFU_APP_ID && process.env.SFU_APP_SECRET) {
    return { appId: process.env.SFU_APP_ID, appSecret: process.env.SFU_APP_SECRET };
  }
  try {
    const raw = JSON.parse(readFileSync(path.join(HERE, "..", ".dev-secrets.json"), "utf8"));
    if (typeof raw.appId === "string" && typeof raw.appSecret === "string") {
      return { appId: raw.appId, appSecret: raw.appSecret };
    }
  } catch {
    /* 文件不存在时由 /health 提示 */
  }
  return null;
}

const secrets = loadSecrets();

/*
 * 发布登记表（防串流双保险）。
 *
 * SFU 本身没有房间概念，订阅必须"点名"（sessionId + trackName），
 * 而这个 id 只在房间内经 HMAC 保护的 PeerJS 通道分发——别的房间拿不到
 * 就不可能串流。但按官方安全模型（"sessionId 不构成授权"），这里再拦一道：
 * 只有**经过本服务发布过**的 (sessionId, trackName) 才允许被订阅，
 * 泄漏的/瞎猜的 id 一律 403。
 */
const publications = new Map(); // sessionId -> { trackNames: Set<string>, at: number }
const PUB_TTL_MS = 2 * 60 * 60 * 1000;

function registerPublication(sessionId, trackNames) {
  const entry = publications.get(sessionId) ?? { trackNames: new Set(), at: Date.now() };
  for (const name of trackNames) entry.trackNames.add(name);
  entry.at = Date.now();
  publications.set(sessionId, entry);
}

function publicationsKnown(sessionId, trackNames) {
  const entry = publications.get(sessionId);
  if (!entry) return false;
  return trackNames.every((name) => entry.trackNames.has(name));
}

function forgetPublication(sessionId, trackNames) {
  const entry = publications.get(sessionId);
  if (!entry) return;
  for (const name of trackNames) entry.trackNames.delete(name);
  if (entry.trackNames.size === 0) publications.delete(sessionId);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of publications) {
    if (now - entry.at > PUB_TTL_MS) publications.delete(id);
  }
}, 10 * 60 * 1000).unref();

/** 解析 tracks/new 的 tracks 数组；形状不对返回 null。 */
function parseTracks(body) {
  try {
    const tracks = JSON.parse(body.toString("utf8"))?.tracks;
    if (!Array.isArray(tracks)) return null;
    return tracks.map((t) => ({
      location: t?.location === "remote" ? "remote" : "local",
      sessionId: typeof t?.sessionId === "string" ? t.sessionId : "",
      trackName: typeof t?.trackName === "string" ? t.trackName : "",
    }));
  } catch {
    return null;
  }
}

/** 允许转发的方法 + 路径形态（白名单，防沦为开放代理）。路径与 SFU 一致（复数 sessions）。 */
const ROUTES = [
  { method: "POST", pattern: /^\/sessions\/new$/ },
  { method: "POST", pattern: /^\/sessions\/[\w-]+\/tracks\/new$/ },
  { method: "PUT", pattern: /^\/sessions\/[\w-]+\/renegotiate$/ },
  { method: "PUT", pattern: /^\/sessions\/[\w-]+\/tracks\/close$/ },
  { method: "GET", pattern: /^\/sessions\/[\w-]+$/ },
];

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, secrets: Boolean(secrets), appId: secrets?.appId ?? null }));
    return;
  }

  if (!secrets) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing credentials: set SFU_APP_ID/SFU_APP_SECRET or .dev-secrets.json" }));
    return;
  }

  // /sfu/sessions/...（或旧的单数写法）→ SFU 的 /apps/{appId}/sessions/...
  const sub = url.pathname.replace(/^\/sfu\/sessions?\//, "/sessions/");
  const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(sub));
  if (!route) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  try {
    const body = req.method === "GET" ? undefined : await readBody(req);

    // 登记表校验：本地发布 → 登记；订阅 remote 轨 → 必须是本服务签发过的
    if (sub.endsWith("/tracks/new") && body) {
      const tracks = parseTracks(body);
      if (!tracks) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid tracks" }));
        return;
      }
      const locals = tracks.filter((t) => t.location === "local" && t.trackName);
      const remotes = tracks.filter((t) => t.location === "remote" && t.sessionId && t.trackName);
      if (tracks.length > 0 && locals.length + remotes.length === tracks.length) {
        const bad = remotes.find((t) => !publicationsKnown(t.sessionId, [t.trackName]));
        if (bad) {
          console.log(`[sfu-proxy] blocked subscribe to unknown publication ${bad.sessionId}/${bad.trackName}`);
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unknown publication" }));
          return;
        }
      }
    }

    const upstream = await fetch(`${SFU_BASE}/apps/${secrets.appId}${sub}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${secrets.appSecret}`,
        "Content-Type": "application/json",
      },
      body: body && body.length > 0 ? body : undefined,
    });
    const text = await upstream.text();

    // 发布成功后登记（2xx 才算）；本地关轨后撤销登记。
    // local 轨的 sessionId 不在 track 条目里，从 URL 取。
    if (upstream.ok && sub.endsWith("/tracks/new") && body) {
      const tracks = parseTracks(body);
      const pubSession = sub.match(/^\/sessions\/([\w-]+)\/tracks\/new$/)?.[1] ?? "";
      const locals = (tracks ?? []).filter((t) => t.location === "local" && t.trackName);
      if (pubSession && locals.length > 0) {
        registerPublication(pubSession, locals.map((t) => t.trackName));
      }
    }
    if (upstream.ok && sub.endsWith("/tracks/close") && body) {
      const tracks = parseTracks(body);
      const pubSession = sub.match(/^\/sessions\/([\w-]+)\/tracks\/close$/)?.[1] ?? "";
      const locals = (tracks ?? []).filter((t) => t.location === "local" && t.trackName);
      if (pubSession && locals.length > 0) {
        forgetPublication(pubSession, locals.map((t) => t.trackName));
      }
    }

    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(text);
    console.log(`[sfu-proxy] ${req.method} ${sub} -> ${upstream.status}`);
  } catch (error) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
    console.error(`[sfu-proxy] ${req.method} ${sub} failed:`, error);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sfu-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[sfu-proxy] credentials ${secrets ? "loaded (appId " + secrets.appId + ")" : "MISSING"}`);
});
