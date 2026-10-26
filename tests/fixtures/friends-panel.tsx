/**
 * 视觉夹具：好友面板 + 顶部信息提示（业主 2026-10-26 实拍的两处 UI bug）。
 *
 * 用法（dev server 起在 8787）：
 *   /tests/fixtures/friends-panel.html?theme=dark             深色主题
 *   /tests/fixtures/friends-panel.html?theme=light&daypart=night   浅色主题的夜晚
 *   &tab=add        打开「添加」tab（默认，复现输入框那屏）
 *   &toast=0        不显示顶部提示
 *
 * 目检要点：
 *   ① 非当前 tab 的文字要看得清（深色下不能是深棕字压深棕底）；
 *   ② tab / 搜索框不要变成一块块黑砖；
 *   ③ 顶部「账号 ID 已更新」提示的 × 与文字都要清楚。
 */
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { FriendsDrawer } from "../../src/client/voice/components/AccountPanels";
import { Banner } from "../../src/client/voice/components/ui";
import type { AccountAdapter, FriendsSnapshot } from "../../src/client/voice/account/types";
import "../../src/client/voice/styles.css";
import "../../src/client/voice/account.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
if (params.get("daypart")) document.documentElement.dataset.daypart = params.get("daypart")!;

const now = Date.now();
/** ?empty=1：空好友列表 —— 目检空状态标题/说明在深色主题下的对比度。 */
const empty = params.get("empty") === "1";

const snapshot: FriendsSnapshot = {
  friends: empty ? [] : [
    {
      account: { id: "53720018", username: "tangxiaofei", name: "无敌唐小菲大王", avatar: "", avatarVersion: 0, createdAt: now },
      since: now - 86_400_000,
      presence: { state: "online", lastSeen: now, roomCode: "235417" },
    },
    {
      account: { id: "48231907", username: "ye_li", name: "夜里看江南", avatar: "", avatarVersion: 0, createdAt: now },
      since: now - 172_800_000,
      presence: { state: "offline", lastSeen: now - 3_600_000 },
    },
    /*
     * 下面这些是为了看"排布密度 + 滚动条"补的（2026-10-27）：
     * 两三个好友时列表根本不出滚动条，截图看不出改了什么。
     */
    {
      account: { id: "61002847", username: "test2", name: "test2", avatar: "", avatarVersion: 0, createdAt: now },
      since: now - 3_600_000,
      presence: { state: "online", lastSeen: now },
    },
    {
      account: { id: "61002848", username: "test1", name: "test1", avatar: "", avatarVersion: 0, createdAt: now },
      since: now - 3_600_000,
      presence: { state: "offline", lastSeen: now - 7_200_000 },
    },
    {
      account: { id: "61002849", username: "koumi", name: "口米", avatar: "", avatarVersion: 0, createdAt: now },
      since: now - 3_600_000,
      presence: { state: "online", lastSeen: now },
    },
    {
      account: { id: "61002850", username: "anno", name: "anno", avatar: "", avatarVersion: 0, createdAt: now },
      since: now - 3_600_000,
      presence: { state: "offline", lastSeen: now - 7_200_000 },
    },
    {
      account: { id: "61002851", username: "foam", name: "FoamSadness", avatar: "", avatarVersion: 0, createdAt: now },
      since: now - 3_600_000,
      presence: { state: "online", lastSeen: now, roomCode: "612845" },
    },
    {
      account: { id: "61002852", username: "moz", name: "莫无z", avatar: "", avatarVersion: 0, createdAt: now },
      since: now - 3_600_000,
      presence: { state: "offline", lastSeen: now - 7_200_000 },
    },
    {
      account: { id: "61002853", username: "xiaofei2", name: "无敌唐小飞大王", avatar: "", avatarVersion: 0, createdAt: now },
      since: now - 3_600_000,
      presence: { state: "online", lastSeen: now },
    },
    {
      account: { id: "61002854", username: "longname", name: "一个名字特别特别长的人看看截断", avatar: "", avatarVersion: 0, createdAt: now },
      since: now - 3_600_000,
      presence: { state: "online", lastSeen: now, roomCode: "235417" },
    },
  ],
  incoming: [],
  outgoing: [],
};

/** 只为渲染：搜索用不到真实后端。 */
const adapter = {
  search: async () => [],
} as unknown as AccountAdapter;

function Fixture() {
  const tab = (params.get("tab") ?? "add") as "friends" | "invites" | "requests" | "add";
  return (
    <div className="vx-landing" style={{ minHeight: "100vh" }}>
      {params.get("toast") === "0" ? null : (
        <div className="vx-toast-layer">
          <Banner kind="info" onClose={() => {}}>
            你的账号 ID 已更新为 88888888
          </Banner>
        </div>
      )}
      <FriendsDrawer
        open
        adapter={adapter}
        snapshot={snapshot}
        onClose={() => {}}
        onChanged={() => {}}
        roomCode="235417"
        canInvite
        invites={[]}
        onInvite={async () => true}
      />
      {/* 直接点开指定 tab：FriendsDrawer 的 tab 是内部状态，靠点击切换 */}
      <AutoTab tab={tab} />
    </div>
  );
}

function AutoTab({ tab }: { tab: string }) {
  const label = ({ friends: "好友", invites: "邀请", requests: "请求", add: "添加" } as Record<string, string>)[tab] ?? "添加";
  useEffect(() => {
    // FriendsDrawer 的 tab 是内部状态，夹具只能靠点它自己的按钮切过去
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".vx-friends-tabs button"));
    buttons.find((button) => button.textContent?.trim().startsWith(label))?.click();
  }, [label]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
