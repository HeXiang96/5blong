/** 账号状态的 React 绑定：UI 只跟这里打交道，适配器可换（本地 / Worker）。 */
import { useCallback, useEffect, useState } from "react";

import type { LocalAccountAdapter } from "./local-adapter";
import type { AccountAdapter, AccountProfile, FriendsSnapshot } from "./types";

const EMPTY: FriendsSnapshot = { friends: [], incoming: [], outgoing: [] };

export function useAccount(adapter: AccountAdapter & Partial<Pick<LocalAccountAdapter, "subscribe">>) {
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
    return () => {
      unsubscribe?.();
      window.clearInterval(timer);
    };
  }, [adapter, refresh]);

  return { me, snapshot, refresh };
}
