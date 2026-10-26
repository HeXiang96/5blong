/** 账号状态的 React 绑定：UI 只跟这里打交道，适配器可换（本地 / Worker）。 */
import { useCallback, useEffect, useState } from "react";

import type { AccountAdapter, AccountProfile, FriendsSnapshot } from "./types";

const EMPTY: FriendsSnapshot = { friends: [], incoming: [], outgoing: [] };

/** 适配器可以额外提供订阅（本地版靠 BroadcastChannel，线上版靠自己的 emit）。 */
export type AccountAdapterWithFeed = AccountAdapter & {
  subscribe?(listener: () => void): () => void;
  /** 线上版用来"重新核对登录态"；本地版没有这一步 */
  hydrate?(): Promise<void>;
};

export function useAccount(adapter: AccountAdapterWithFeed) {
  const [me, setMe] = useState<AccountProfile | null>(() => adapter.current());
  const [snapshot, setSnapshot] = useState<FriendsSnapshot>(EMPTY);

  const refresh = useCallback(async () => {
    setMe(adapter.current());
    setSnapshot(await adapter.snapshot());
  }, [adapter]);

  useEffect(() => {
    void refresh();
    const unsubscribe = adapter.subscribe?.(() => void refresh());
    // 在线状态靠心跳，5 秒刷一次足够（不缓存，必须新鲜）
    const timer = window.setInterval(() => void refresh(), 5_000);
    /*
     * 兜底：界面这会儿是"未登录"，但网络刚恢复 / 上次核对被刷新打断时，
     * 每 20 秒再问一次服务端。真没登录态时服务端回 401，成本可忽略；
     * 有登录态的话用户就不用重新登录了。
     */
    let tries = 0;
    const retry = window.setInterval(() => {
      if (!adapter.hydrate) return;
      if (adapter.current()) {
        tries = 0;
        return;
      }
      if (tries >= 6) return;
      tries += 1;
      void adapter.hydrate();
    }, 20_000);
    return () => {
      unsubscribe?.();
      window.clearInterval(timer);
      window.clearInterval(retry);
    };
  }, [adapter, refresh]);

  return { me, snapshot, refresh };
}
