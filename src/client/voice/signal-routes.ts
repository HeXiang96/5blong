/**
 * 信令路由（语音房与开黑圈共用）。
 *
 * 背景（2026-10-15 测试者实测）：PeerJS 客户端默认连 `wss://0.peerjs.com/peerjs`，
 * 部分网络直达不了（校内网/公司网/代理规则/DNS 污染），报错就是"没能进入房间"。
 * 而这些网络通常**能打开本站**，所以第一条线路用我们自己的域名；
 * **最后一条走直连**，万一我们的中转出问题也不至于全断。本地开发直接用直连。
 *
 * 2026-11-03 起第一条从 `5blong.pages.dev` 换成 `5blong.site`：
 * 自建的信令服务跑在**香港**（和静态站、账号接口同一台机器），
 * 而 `pages.dev` 被 Cloudflare 路由到**洛杉矶** —— 实测候选交换慢、打洞更容易失败，
 * 打洞一失败就落到中继，中继又在洛杉矶，语音就废了。
 * 到香港 20–41ms，到洛杉矶 154–220ms，这是这条改动唯一的理由。
 *
 * ⚠️ 信令是**全局注册表**：改这个地址等于把用户分成两拨。
 * 旧客户端（还写着 pages.dev 的）连不到新服务器上的人，
 * 表现是"同一个房号，彼此看不见"。所以这个改动必须和
 * 「强制更新到新版本」一起发，不能只放网页端。
 *
 * ⚠️ 第二条 `0.peerjs.com` 是公共云，和我们的服务器**不是同一个注册表**。
 * 它只在第一条彻底连不上时兜底（两边都连公共云才可能相遇），
 * 所以它是"总比进不去强"，不是"无缝切换"。别指望跨线路能互相发现。
 */
export interface SignalRoute {
  host: string;
  port: number;
  secure: boolean;
  key: string;
  label: string;
}

export const SIGNAL_ROUTES: SignalRoute[] = import.meta.env.DEV
  ? [{ host: "0.peerjs.com", port: 443, secure: true, key: "peerjs", label: "peerjs-cloud" }]
  : [
      { host: "5blong.site", port: 443, secure: true, key: "peerjs", label: "own-hk" },
      { host: "0.peerjs.com", port: 443, secure: true, key: "peerjs", label: "peerjs-cloud" },
    ];

/**
 * 从 `start` 起按 `attempt` 轮换线路（越界自动绕回）。
 *
 * 为什么抽成纯函数：**必须支持"从中间某条开始"**。
 * 原实现每次重拨都从 `SIGNAL_ROUTES[0]` 起，于是跨注册表的情况永远试不到第二条线路——
 * 2026-11-03 实测：房主兜底到了公共云，访客死磕自建香港，重拨三次都在同一张表上找，
 * 最终报"房主不在线"，而对方明明建了房、别人也进得去。
 *
 * `routes` 可注入，便于把轮换规则钉在单测里（生产只有一条线路的 DEV 构建测不出来）。
 */
export function routeAt(
  start: number,
  attempt: number,
  routes: SignalRoute[] = SIGNAL_ROUTES,
): SignalRoute {
  const total = routes.length;
  const index = (((start + attempt) % total) + total) % total;
  return routes[index]!;
}
