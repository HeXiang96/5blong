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
 * 内容版本：3 = 2026-11-03「换域名 + 强制更新」这一波。
 * 只有真的想让人再看一次时才 +1，小修补别动（否则每次发版都弹，很烦）。
 */
export const WHATS_NEW_VERSION = 3;

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
  | "hash"
  | "globe"
  | "link"
  | "refresh";

export interface WhatsNewItem {
  icon: WhatsNewIcon;
  title: string;
  body: string;
}

/**
 * 2026-11-03：只讲"对用户有什么影响"，三条说完。
 * 以前这里是七条功能罗列，弹窗快占满一屏——功能该在介绍页讲，不在这里。
 */
export const WHATS_NEW: { title: string; lead: string; items: WhatsNewItem[] } = {
  title: "换地方了，四件事先说清",
  lead: "",
  items: [
    {
      icon: "globe",
      title: "网页版搬到了新地址",
      body: "现在是 web.5blong.site。旧书签打开会停在介绍页，点「开始使用」就能进。",
    },
    {
      icon: "refresh",
      title: "这次要更新才能用",
      body: "低于 1.9.13 的客户端会看到不能关闭的更新提示。装完自动回到原来的界面，房间和好友都还在。",
    },
    {
      icon: "link",
      title: "旧邀请链接会失效",
      body: "以前发出去的 5blong.site/#c=… 链接不再进房。进房间重新复制一次邀请，新链接就是对的。",
    },
    {
      icon: "user",
      title: "要重新登录一次",
      body: "换了域名，登录状态不会跟过来。重新登录一次就好——账号、好友、房号都还在原来的地方。",
    },
  ],
};
