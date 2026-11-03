/**
 * GET /ice —— 签发**本机 coturn** 的短期中继凭据。
 *
 * 演进过程（改之前先读，别退回旧实现）：
 *   最早这条在 `5blong.pages.dev` 上，调 Cloudflare Realtime 换凭据。
 *   那条链路跨境到洛杉矶，实测 8 次里有 1 次超过 6 秒无响应，
 *   而客户端只等 2.5 秒（`src/client/voice/ice.ts` 的 FETCH_TIMEOUT_MS）。
 *   一超时就退回纯 STUN → 打洞失败时没有中继可用 →
 *   表现就是「两个人都显示已连接，却互相听不到」。
 *
 *   第一步是把签发搬到本机（仍是 Cloudflare 的 TURN）。这解决了超时，
 *   但中继服务器还在洛杉矶，中继用户单程 200ms。
 *
 *   现在是第二步：中继自己跑（coturn），凭据本地签，**一个外部 API 都不调**。
 *   中继路径从「绕太平洋」变成「香港直连」，这才是中继用户真正感觉到的那一步。
 *
 * 凭据规范（TURN REST API，coturn 的 `use-auth-secret`）：
 *   username   = "<过期时间戳(秒)>:<标签>"
 *   credential = base64(HMAC-SHA1(static-auth-secret, username))
 * coturn 收到后自己按同样算法验一遍，不存用户表、不用提前分配账号。
 *
 * 状态码契约（客户端据此决定降级，不要改）：
 *   200 → { iceServers: [...] }
 *   501 → 没配 TURN_SECRET（客户端静默降级为纯 STUN）
 */

import { createHmac } from "node:crypto";
import { CONFIG, TURN_LOCAL } from "./config.mjs";

const iceHeaders = () => ({
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  // 凭据带时效，禁止中间层缓存
  "Cache-Control": "no-store",
});

/** 按 TURN REST API 现算一对 username/credential（一次 HMAC，不需要缓存）。 */
function makeCredential(label) {
  const expiry = Math.floor(Date.now() / 1000) + TURN_LOCAL.ttlSeconds;
  const username = `${expiry}:${label}`;
  const credential = createHmac("sha1", TURN_LOCAL.secret).update(username).digest("base64");
  return { username, credential };
}

/**
 * 三个地址按优先级排：UDP 最快，UDP 被封时退 TCP，
 * TCP 也被封（公司网只放 443 的情况）再退 TLS。
 * 浏览器会按顺序试，全都失败才判定没有中继。
 */
function turnUrls() {
  const { host, port, tlsPort } = TURN_LOCAL;
  return [
    `turn:${host}:${port}?transport=udp`,
    `turn:${host}:${port}?transport=tcp`,
    `turns:${host}:${tlsPort}?transport=tcp`,
  ];
}

export function createIceHandler() {
  return (req, res) => {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "86400");
      return res.status(204).end();
    }
    if (req.method !== "GET") {
      return res.status(405).json({ error: "method not allowed" });
    }

    // 没配共享密钥就没法签，宁可明确 501 让客户端退回纯 STUN，
    // 也不要发一个 coturn 验不过的假凭据（那样连接会卡在 30 秒超时）。
    if (!TURN_LOCAL.secret) {
      return res.status(501).json({ error: "turn not configured" });
    }

    const { username, credential } = makeCredential("5blong");
    const body = JSON.stringify({
      iceServers: [{ urls: turnUrls(), username, credential }],
    });

    for (const [key, value] of Object.entries(iceHeaders())) res.setHeader(key, value);
    return res.status(200).send(body);
  };
}

/** 供 /healthz 报告配置状态，不泄漏密钥本身。 */
export function iceStatus() {
  return {
    turnConfigured: Boolean(TURN_LOCAL.secret),
    // 把中继地址暴露出来：排查"到底有没有中继"时这行最有用
    turnHost: TURN_LOCAL.secret ? `${TURN_LOCAL.host}:${TURN_LOCAL.port}` : null,
    publicOrigin: CONFIG.publicOrigin || null,
  };
}
