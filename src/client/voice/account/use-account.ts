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
    const me = adapter.current();
    setMe(me);
    /*
     * 没登录就不问服务端：Worker 适配器的 request() 不看有没有 token，一律真发，
     * 而一个只打开网页没登录的标签页每小时会白烧 720 次请求
     * （Workers 免费额度 10 万/天，已用到九成）。
     *
     * 但必须**显式清空**快照——否则登出后好友列表会残留上一个账号的联系人
     * （以前是靠在服务端回空 200 把它冲掉的）。
     */
    if (!me) {
      setSnapshot(EMPTY);
      return;
    }
    setSnapshot(await adapter.snapshot());
  }, [adapter]);

  useEffect(() => {
    void refresh();
    const unsubscribe = adapter.subscribe?.(() => void refresh());
    /*
     * 90 秒一次（5 秒 → 15 秒 → 90 秒，2026-10-26 业主定）。
     *
     * 依据：好友在线状态的数据源是服务端 `account_presence`，由信令 Worker 的
     * alarm 每 30 秒批量续写一次，75 秒没续上才判离线。所以在线的人 last_seen
     * 年龄永远 < 30 秒，**轮询再快也不会更准**，只是把请求量成倍放大。
     * 90 秒时一个常开窗口好友快照只花 40 次/小时（原 5 秒是 720 次）。
     *
     * 代价（业主已知情并接受）：
     *   - 好友上线/进房：最坏晚 90 秒才显示
     *   - 好友离线：服务端 75 秒判定 + 本端 90 秒轮询，最坏约 2 分 45 秒
     *   - 好友申请：最坏晚 90 秒才弹出来
     *
     * ⚠️ 改这个值之前先看 `PRESENCE_ONLINE_MS`（服务端 75 秒）：只要 alarm 周期
     * 仍是 30 秒，轮询间隔调到多大都不会让状态判错，只会让它更新得更晚。
     */
    const timer = window.setInterval(() => void refresh(), 90_000);
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
