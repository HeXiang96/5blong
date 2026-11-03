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
 * ⚠️ 2026-11-03 删除了公共云兜底（原第二条 `0.peerjs.com`）。
 *
 * 原因不是"公共云不能用"，而是**兜底到那里的人其实是三无用户**：
 *   信令：能连上公共云 ✓
 *   /ice：拿不到（API 在我们服务器上）→ 没有中继凭据
 *   中继/账号/后台：全部失效
 * 他只会以为自己建了一间房（702621 实测就是这样：整份访问日志 0 命中，
 * 面板查无此房，排障一整天都在找错方向）。
 *
 * 现在只剩我们自己的服务器：连不上就**明确报错并重试**，而不是静默漂到一张空表上。
 * 这就是 `routeAt` 仍保留的原因 —— 将来加国内备用节点时，轮换规则直接可用。
 */
export interface SignalRoute {
  host: string;
  port: number;
  secure: boolean;
  key: string;
  label: string;
}

export const SIGNAL_ROUTES: SignalRoute[] = [
  /*
   * 只有一条：我们自己的香港信令服务（nginx 的 /peerjs 反代到 127.0.0.1:9001，
   * 进程叫 5blong-signal-node，代码在 server/src/signal.mjs）。
   *
   * DEV 也指向这里：本地 dev server 本来就连生产的账号/房间接口，
   * 本地没有信令服务可用；而随机 id 不会和真实用户撞号。
   */
  { host: "5blong.site", port: 443, secure: true, key: "peerjs", label: "own-hk" },
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
