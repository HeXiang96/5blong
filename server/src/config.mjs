/**
 * 服务端配置：所有可调项集中在这里，环境变量覆盖默认值。
 *
 * 常量命名与 `worker/_worker.pages.js` 保持一致 —— 将来对照两边代码时
 * 不需要做名字映射，值不一样就是 bug。
 */

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const CONFIG = {
  /**
   * 监听地址：默认只绑本机回环。
   *
   * 8788 / 9000 是内部端口，对外一律走 nginx（TLS + 限流 + 日志都在那一层）。
   * 绑 0.0.0.0 意味着别人可以绕开 nginx 直接打明文 HTTP —— 那样 cookie 会裸奔。
   * 真要在没有 nginx 的情况下临时代理，再设 HOST=0.0.0.0。
   */
  host: process.env.HOST ?? "127.0.0.1",
  /** 业务接口端口（nginx 反代到这里） */
  port: num("PORT", 8788),
  /** PeerJS 信令端口（nginx 反代 /peerjs 到这里） */
  peerPort: num("PEER_PORT", 9000),
  /** SQLite 文件路径 */
  dbPath: process.env.DB_PATH ?? "/data/5blong/app.db",
  /**
   * cookie 是否带 Secure。
   * 生产一定走 https（nginx + certbot），本地 http 调试时设 COOKIE_SECURE=0。
   */
  cookieSecure: process.env.COOKIE_SECURE !== "0",
  /** 对外基址，用于拼 cookie 的域与 CORS 判断（例：https://5blong.site） */
  publicOrigin: process.env.PUBLIC_ORIGIN ?? "",
};

// ---------------------------------------------------------------------------
// 与 worker 完全一致的业务常量（改一个就要两边一起改）
// ---------------------------------------------------------------------------
export const SESSION_COOKIE = "5blong_sess";
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const PBKDF2_ROUNDS = 100_000;

export const PRESENCE_ONLINE_MS = 75_000;
export const MAX_AVATAR_CHARS = 120_000;

export const INVITE_TTL_MS = 24 * 3600_000;
export const KNOCK_TTL_MS = 10 * 60_000;
export const REQUEST_COOLDOWN_MS = 24 * 3600_000;
export const RECENT_PLAY_TTL_MS = 7 * 24 * 3600_000;

export const FRIEND_REQUEST_DAILY = 20;
export const INVITE_DAILY = 50;
export const KNOCK_DAILY = 20;

export const ROOM_HOLD_TTL_MS = 90_000;

// ---------------------------------------------------------------------------
// 意见反馈（与 worker 的限额逐项一致，客户端按这些值做过前端校验）
// ---------------------------------------------------------------------------
export const FEEDBACK_CATEGORIES = new Set(["voice", "mic", "room", "screen", "lag", "other"]);
export const FEEDBACK_MAX_MESSAGE = 500;
export const FEEDBACK_MAX_CONTACT = 120;
export const FEEDBACK_MAX_CONTEXT = 64 * 1024;
export const FEEDBACK_HOURLY_LIMIT = 5;

export const ACCOUNT_USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{2,15}$/;
export const ACCOUNT_ROOM_CODE_RE = /^\d{6}$/;

/**
 * 自建 TURN（coturn）配置。
 *
 * 2026-11-03 起中继不再走 Cloudflare：那台在洛杉矶，中继单程约 200ms，
 * 比这台香港机器慢 5 倍。改成 coturn 跑在本机之后，
 * 「打洞失败的人」也能拿到 ~37ms 的中继，而不是绕着太平洋跑。
 *
 * 凭据用 TURN REST API 规范本地签发（HMAC-SHA1），不再调任何外部 API：
 *   username   = "<过期时间戳秒>:<随便一个标签>"
 *   credential = base64(HMAC-SHA1(sharedSecret, username))
 * coturn 配 `use-auth-secret` + `static-auth-secret` 就能验。
 *
 * 没配 `TURN_SECRET` 时 `/ice` 返回 501，客户端退回纯 STUN（与原来一致）。
 */
export const TURN_LOCAL = {
  /** 中继对外的域名/IP：客户端拿到的 candidate 就用这个地址 */
  host: process.env.TURN_HOST ?? "5blong.site",
  port: num("TURN_PORT", 3478),
  /** turns:// 走 TLS，用同一张 Let's Encrypt 证书 */
  tlsPort: num("TURN_TLS_PORT", 5349),
  secret: process.env.TURN_SECRET ?? "",
  /** 凭据有效期，与原来 worker 的 TURN_TTL_SECONDS 对齐 */
  ttlSeconds: 86_400,
};
