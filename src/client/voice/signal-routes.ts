/**
 * 信令路由（语音房与开黑圈共用）。
 *
 * 背景（2026-10-15 测试者实测）：PeerJS 客户端默认连 `wss://0.peerjs.com/peerjs`，
 * 部分网络直达不了（校内网/公司网/代理规则/DNS 污染），报错就是"没能进入房间"。
 * 而这些网络通常**能打开本站**，所以第一条线路借我们自己的域名（Worker 里
 * `/peerjs*` 做了透明转发，协议不变）；**最后一条走直连**，万一我们的中转
 * 出问题也不至于全断。本地开发没有 Worker，直接用直连。
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
      { host: "5blong.pages.dev", port: 443, secure: true, key: "peerjs", label: "own-domain" },
      { host: "0.peerjs.com", port: 443, secure: true, key: "peerjs", label: "peerjs-cloud" },
    ];
