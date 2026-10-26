/**
 * 「大更新」公告弹窗的内容与开关。
 *
 * 存储：`5blong:v1:whatsNew` = 看过的内容版本号（沿用 `5blong:v1:<KEY>` 命名）。
 * `WHATS_NEW_VERSION` 只在**真的想让人再看一次**时 +1；小修补不要动，
 * 否则每次发版都弹，会很烦。
 *
 * 存储不可用（隐私模式等）时退化成"本次会话只弹一次"。
 */

/**
 * 内容版本：2 = 2026-10-26「账号 / 我的房间 / 好友」这一波。
 * 只有真的想让人再看一次时才 +1，小修补别动（否则每次发版都弹，很烦）。
 */
export const WHATS_NEW_VERSION = 2;

const KEY = "5blong:v1:whatsNew";

/** 本次会话内是否已经弹过（localStorage 不可用时的兜底）。 */
let shownThisSession = false;

function readSeenVersion(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const value = raw === null ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return shownThisSession ? WHATS_NEW_VERSION : 0;
  }
}

export function shouldShowWhatsNew(): boolean {
  if (shownThisSession) return false;
  return readSeenVersion() < WHATS_NEW_VERSION;
}

/** 单测用：清掉"本次会话已弹过"的标记（正式代码不要调用）。 */
export function resetWhatsNewSessionFlag(): void {
  shownThisSession = false;
}

export function markWhatsNewSeen(): void {
  shownThisSession = true;
  try {
    localStorage.setItem(KEY, String(WHATS_NEW_VERSION));
  } catch {
    /* 存不进去就靠 shownThisSession 兜底 */
  }
}

/** 图标名 → 组件在弹窗里映射（不用 emoji：部分环境缺字体，会渲染成方块）。 */
export type WhatsNewIcon =
  | "headphones"
  | "mute"
  | "target"
  | "volume"
  | "film"
  | "pulse"
  | "home"
  | "user"
  | "lock"
  | "key"
  | "users"
  | "mail"
  | "hash";

export interface WhatsNewItem {
  icon: WhatsNewIcon;
  title: string;
  body: string;
}

export const WHATS_NEW: { title: string; lead: string; items: WhatsNewItem[] } = {
  title: "现在有「我的房间」了",
  lead: "挑七件最影响日常使用的说：",
  items: [
    {
      icon: "user",
      title: "可以登录账号了（可选）",
      body: "登录后能加好友、看谁在线、有自己固定的房号。不登录一切照旧：开房、说话、看共享都不受影响。",
    },
    {
      icon: "home",
      title: "我的房间：一个永久的房号",
      body: "登录账号领一个 6 位房号，之后一直开这一间。关掉再打开，首页点「我的房间 · 开始」就回来了。",
    },
    {
      icon: "lock",
      title: "我的房间是私密房",
      body: "光知道房号进不来：要么用邀请链接，要么用「房号 + 临时密码」。随手开的临时房不受影响，报个号就能进。",
    },
    {
      icon: "key",
      title: "临时密码，随时能换能关",
      body: "房间顶栏点钥匙图标生成 6 位密码，发给临时朋友；换一个旧的立刻失效，关掉后只剩邀请链接能进。",
    },
    {
      icon: "users",
      title: "好友：谁在线、在哪个房",
      body: "房间里点成员就能加好友，双方同意后，好友面板能看到对方在线状态和所在房间。",
    },
    {
      icon: "mail",
      title: "邀请会留一条记录",
      body: "在房间里点「邀请」，对方好友面板的「邀请」里会留下「谁、哪个房、几分钟前」，当时没空也不会错过。",
    },
    {
      icon: "hash",
      title: "房号扩到 6 位，老码还能用",
      body: "新房间号是 6 位，撞号概率从约四成降到几乎为零；以前发出去的 4 位房号和旧邀请链接照样能进。",
    },
  ],
};
