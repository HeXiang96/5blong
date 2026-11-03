/**
 * 信令线路轮换。
 *
 * 背景（2026-11-03 线上实测）：自建香港（own-hk）与公共云（peerjs-cloud）
 * 是**两张互不相通的全局注册表**。房主被兜底到公共云、访客死磕自建香港时，
 * 访客得到 `peer-unavailable`（界面"房主不在线"），而对方明明建了房、别人也进得去。
 * 原实现每次重拨都从第 0 条线路开始，跨注册表的情况永远试不到第二条。
 */
import { describe, expect, it } from "vitest";

import { routeAt, type SignalRoute } from "../src/client/voice/signal-routes";

const routes: SignalRoute[] = [
  { host: "own.example", port: 443, secure: true, key: "peerjs", label: "own-hk" },
  { host: "cloud.example", port: 443, secure: true, key: "peerjs", label: "peerjs-cloud" },
];

describe("routeAt（信令线路轮换）", () => {
  it("从第一条起，第二次换到第二条", () => {
    expect(routeAt(0, 0, routes).label).toBe("own-hk");
    expect(routeAt(0, 1, routes).label).toBe("peerjs-cloud");
  });

  it("可以从第二条起 —— 跨注册表重试的关键（不能永远从 0 开始）", () => {
    expect(routeAt(1, 0, routes).label).toBe("peerjs-cloud");
    expect(routeAt(1, 1, routes).label).toBe("own-hk");
  });

  it("越界/负数下标自动绕回，不返回 undefined", () => {
    expect(routeAt(7, 0, routes).label).toBe("peerjs-cloud");
    expect(routeAt(-1, 0, routes).label).toBe("peerjs-cloud");
    expect(routeAt(0, 9, routes).label).toBe("peerjs-cloud");
  });

  it("只有一条线路时（DEV 构建）永远返回它，不会绕成空", () => {
    const single = [routes[0]!];
    expect(routeAt(5, 3, single).label).toBe("own-hk");
  });
});
