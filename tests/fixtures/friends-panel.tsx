/**
 * 视觉夹具：好友面板（2026-10-27 重做后的版本）。
 *
 * 用法（dev server 起在 8787）：
 *   /tests/fixtures/friends-panel.html?theme=dark                  深色主题
 *   /tests/fixtures/friends-panel.html?theme=light&daypart=night   浅色主题的夜晚
 *   &tab=friends|pending|add   打开指定 tab（默认 friends）
 *   &menu=1                    自动点开第一个 ⋯ 菜单（看 portal 菜单在不在视口内）
 *   &empty=1                   空列表（目检空状态）
 *   &toast=0                   不显示顶部提示
 *
 * 目检要点：
 *   ① 三个分组（在房间里 / 在线 / 离线）的标题与分隔线；
 *   ② 每行「主按钮 + ⋯」不打架，长名字被截断但状态不被挤掉；
 *   ③ ⋯ 菜单是 portal 渲染的，靠底部的行也要完整可见（不被列表 overflow 裁掉）；
 *   ④ 待处理里三种东西（请求带附言 / 邀请带房主在线状态 / 敲门）分得清；
 *   ⑤ 最近一起玩折叠区、附言输入在深色下的对比度。
 */
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { FriendsDrawer } from "../../src/client/voice/components/AccountPanels";
import { Banner } from "../../src/client/voice/components/ui";
import type {
  AccountAdapter,
  FriendsSnapshot,
  Knock,
  RecentPlay,
  RoomInvite,
} from "../../src/client/voice/account/types";
import "../../src/client/voice/styles.css";
import "../../src/client/voice/account.css";
// 场景主题必须最后加载（靠层叠顺序取胜），和 main.tsx 的顺序一致
import "../../src/client/voice/pen-themes.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
if (params.get("daypart")) document.documentElement.dataset.daypart = params.get("daypart")!;
// 场景主题（雪原 / 万圣夜 / 春节）：面板配色要跟着变，这里也要能复现
if (params.get("scene")) document.documentElement.dataset.scene = params.get("scene")!;

const now = Date.now();
/** ?empty=1：空好友列表 —— 目检空状态标题/说明在深色主题下的对比度。 */
const empty = params.get("empty") === "1";

const profile = (id: string, username: string, name: string) => ({
  id,
  username,
  name,
  avatar: "",
  avatarVersion: 0,
  createdAt: now,
});

const snapshot: FriendsSnapshot = {
  friends: empty
    ? []
    : [
        {
          account: profile("61002851", "foam", "FoamSadness"),
          since: now - 86_400_000,
          presence: { state: "online", lastSeen: now, roomCode: "612845" },
        },
        {
          account: profile("61002854", "longname", "一个名字特别特别长的人看看截断"),
          since: now - 86_400_000,
          presence: { state: "online", lastSeen: now, roomCode: "235417" },
        },
        {
          account: profile("53720018", "tangxiaofei", "无敌唐小菲大王"),
          since: now - 172_800_000,
          presence: { state: "online", lastSeen: now },
          alias: "唐小菲（公司）",
        },
        {
          account: profile("61002849", "koumi", "口米"),
          since: now - 172_800_000,
          presence: { state: "online", lastSeen: now },
        },
        {
          account: profile("48231907", "ye_li", "夜里看江南"),
          since: now - 259_200_000,
          presence: { state: "offline", lastSeen: now - 3_600_000 },
        },
        {
          account: profile("61002847", "test2", "test2"),
          since: now - 3_600_000,
          presence: { state: "offline", lastSeen: now - 7_200_000 },
        },
        {
          account: profile("61002852", "moz", "莫无z"),
          since: now - 3_600_000,
          presence: { state: "offline", lastSeen: now - 7_200_000 },
        },
        {
          account: profile("61002850", "anno", "anno"),
          since: now - 3_600_000,
          presence: { state: "offline", lastSeen: now - 7_200_000 },
        },
      ],
  incoming: empty
    ? []
    : [
        {
          account: profile("61002999", "newbie", "隔壁新来的"),
          at: now - 120_000,
          note: "我是昨天在 612845 房里一起听歌的那个，加个好友",
        },
      ],
  outgoing: [],
};

const invites: RoomInvite[] = empty
  ? []
  : [
      {
        from: profile("61002851", "foam", "FoamSadness"),
        code: "612845",
        at: now - 180_000,
        roomKey: "abcdefghijklmnopqrstuvwx",
        fromPresence: { state: "online", lastSeen: now, roomCode: "612845" },
      },
      {
        from: profile("48231907", "ye_li", "夜里看江南"),
        code: "235417",
        at: now - 7_200_000,
        fromPresence: { state: "offline", lastSeen: now - 3_600_000 },
      },
    ];

const knocks: Knock[] = empty
  ? []
  : [{ from: profile("61002849", "koumi", "口米"), at: now - 40_000 }];

const recentPlays: RecentPlay[] = empty
  ? []
  : [
      { account: profile("61003111", "stranger1", "刚一起玩过的 A"), at: now - 3_600_000 },
      { account: profile("61003112", "stranger2", "刚一起玩过的 B"), at: now - 90_000_000 },
    ];

/** 只为渲染：搜索用不到真实后端。 */
const adapter = {
  search: async () => [],
} as unknown as AccountAdapter;

function Fixture() {
  const tab = (params.get("tab") ?? "friends") as "friends" | "pending" | "recent" | "add";
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
        invites={invites}
        onInvite={async () => true}
        knocks={knocks}
        recentPlays={recentPlays}
      />
      <AutoTab tab={tab} />
      {params.get("menu") === "1" ? <AutoMenu /> : null}
    </div>
  );
}

function AutoTab({ tab }: { tab: string }) {
  const label =
    ({ friends: "好友", pending: "待处理", recent: "最近玩", add: "添加" } as Record<string, string>)[tab] ?? "好友";
  useEffect(() => {
    // FriendsDrawer 的 tab 是内部状态，夹具只能靠点它自己的按钮切过去
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".vx-friends-tabs button"),
    );
    buttons.find((button) => button.textContent?.trim().startsWith(label))?.click();
  }, [label]);
  return null;
}

/** 点开某一行的 ⋯ 菜单：验证 portal 菜单在底部行也不会被裁掉。 */
function AutoMenu() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".vx-friend-more"));
      // 点最后一个（最靠下的行），那是最容易被 overflow 裁掉的位置
      buttons.at(-1)?.click();
    }, 60);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
