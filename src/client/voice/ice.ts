/**
 * ICE 配置（STUN + TURN）集中管理。
 *
 * 为什么需要这个模块：
 * - "同机/同网能进房、跨网进不去"几乎只有一个原因——**打洞失败且没有可用中继**。
 *   进房握手本身也是一条 RTCPeerConnection（PeerJS 的数据通道），它和音视频一样
 *   要过 ICE；对称 NAT、公司网、校园网、运营商 CGNAT 都必须靠 TURN 兜底。
 * - 原先唯一的 TURN 是 OpenRelay 的**公开静态凭据**，而该服务已经关停：
 *   `openrelay.metered.ca` 现在解析到 `192.0.2.1`——RFC 5737 里专门留作文档示例的
 *   不可路由黑洞地址（本机 DNS 与腾讯 DoH 双份确认）。于是所有需要中继的组合
 *   都建不起连接，且因为失败原因被前端吞掉，表现成"进不去、也没提示"。
 * - 现在改为由服务端 `/ice` 现场签发 **Cloudflare Realtime TURN 短期凭据**。
 *
 * 两条设计约束（改代码时请保持）：
 * 1. **绝不阻塞进房**：拿不到凭据就退回纯 STUN 打洞，宁可这次打洞失败，也不让
 *    进房流程原地卡住。进房超时后 12 秒一次的整体重拨会自然重试，凭据热了就绪
 *    后下一次拨号即用上。
 * 2. **长密钥永远不进前端**：浏览器/客户端只拿到带 TTL 的一次性 username/credential，
 *    TURN key 本体留在 Worker 的 secret 里。
 */

/** 公共 STUN 兜底（无 TURN）。中外各两个，单个服务挂掉不至于全盲。 */
const FALLBACK: RTCIceServer[] = [
  {
    urls: [
      "stun:stun.cloudflare.com:3478",
      "stun:stun.miwifi.com:3478",
      "stun:stun.chat.bilibili.com:3478",
      "stun:stun.l.google.com:19302",
    ],
  },
];

/**
 * 取 ICE 配置的地址。与 SFU 同源的判断口径保持一致：
 * 桌面端加载的是本地资源（tauri.localhost），没有同域服务端，只能打公网地址。
 */
const ICE_ENDPOINT = (() => {
  if (import.meta.env.DEV) return "/ice";
  const host = typeof location !== "undefined" ? location.hostname : "";
  if (host === "tauri.localhost" || host.endsWith(".tauri.localhost")) {
    return "https://5blong.pages.dev/ice";
  }
  return "/ice";
})();

/** 单次拉取上限。进房体验优先：宁可这次不用 TURN，也不要让用户干等。 */
const FETCH_TIMEOUT_MS = 2500;

/** 客户端缓存时长。服务端签发的 TTL 是 24 小时，这里保守取 12 小时。 */
const CACHE_MS = 12 * 60 * 60 * 1000;

let current: RTCIceServer[] = FALLBACK;
let expiresAt = 0;
let inflight: Promise<void> | null = null;

/**
 * 当前生效的 ICE 配置。**同步**返回，供 PeerJS 在构造 Peer 时取值
 * （PeerJS 只在构造那一刻读 config，之后不再回看）。
 */
export function iceServers(): RTCIceServer[] {
  return current;
}

/** 是否已经拿到带 TURN 的配置（数据条/诊断用）。 */
export function iceHasTurn(): boolean {
  return current !== FALLBACK;
}

/** 结构校验：只认"至少一条、urls 非空且全是非空字符串"的数组。 */
function validIceServers(value: unknown): value is RTCIceServer[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const urls = (entry as RTCIceServer).urls;
    if (typeof urls !== "string" && !Array.isArray(urls)) return false;
    const list = typeof urls === "string" ? [urls] : urls;
    return list.length > 0 && list.every((u) => typeof u === "string" && u.length > 0);
  });
}

/**
 * 刷新 ICE 配置；**任何失败都只是保持现状，绝不抛错**。
 * 并发调用共用同一次请求（`inflight` 去重）。
 */
export function refreshIceServers(): Promise<void> {
  if (inflight) return inflight;
  if (expiresAt > Date.now()) return Promise.resolve();

  inflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(ICE_ENDPOINT, {
        signal: controller.signal,
        cache: "no-store",
      });
      // 501 = 服务端没配 TURN key；502 = 配了但签发失败。两者都退回纯 STUN。
      if (!res.ok) return;
      const data = (await res.json()) as { iceServers?: unknown };
      if (!validIceServers(data.iceServers)) return;
      // 静态 STUN 放前面：TURN 只在打洞失败时才被 ICE 选中，顺序不影响正确性，
      // 但先列 STUN 让"能直连就直连"的意图在配置上一眼可见。
      current = [...FALLBACK, ...data.iceServers];
      expiresAt = Date.now() + CACHE_MS;
    } catch {
      /* 网络不可达 / 超时 / 非 JSON —— 一律退回纯 STUN */
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * 进房/建房前调用：确保 ICE 配置可用，但**最多等 timeoutMs**。
 * 缓存命中时同步返回；未命中时与拉取赛跑，超时就先用纯 STUN 开始，
 * 后台那次拉取继续跑，下一次重拨就能用上。
 */
export async function ensureIceServers(timeoutMs = FETCH_TIMEOUT_MS): Promise<void> {
  if (expiresAt > Date.now()) return;
  await Promise.race([
    refreshIceServers(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
