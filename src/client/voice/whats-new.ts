/**
 * 「大更新」公告弹窗的内容与开关。
 *
 * 存储：`5blong:v1:whatsNew` = 看过的内容版本号（沿用 `5blong:v1:<KEY>` 命名）。
 * `WHATS_NEW_VERSION` 只在**真的想让人再看一次**时 +1；小修补不要动，
 * 否则每次发版都弹，会很烦。
 *
 * 存储不可用（隐私模式等）时退化成"本次会话只弹一次"。
 */

export const WHATS_NEW_VERSION = 1;

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

export type WhatsNewIcon = "headphones" | "mute" | "target" | "film" | "pulse" | "home";

export interface WhatsNewItem {
  /** 图标名（组件里映射到 lucide 组件；不用 emoji，避免字体缺失变方块） */
  icon: WhatsNewIcon;
  title: string;
  body: string;
}

export const WHATS_NEW: { title: string; lead: string; items: WhatsNewItem[] } = {
  title: "这次更新改了不少",
  lead: "挑六件最影响日常使用的说：",
  items: [
    {
      icon: "headphones",
      title: "断线不用退房重进了",
      body: "网络卡一下、切去别的窗口、甚至短暂断网，语音都会自己接回来。以前这几种情况会被当成掉线，直接被移出房间。",
    },
    {
      icon: "mute",
      title: "共享屏幕不再有回声",
      body: "以前共享声音会把房间里的人声一起采走，同一句话你能听到两遍。现在共享的声音里不含人声，说话的人照样听得见。",
    },
    {
      icon: "target",
      title: "只共享一个应用的声音",
      body: "桌面端在设置里指定程序，就只采它的声音。通知音、背景音乐、浏览器里的杂音都不会混进去。",
    },
    {
      icon: "film",
      title: "画质多了省流量档",
      body: "看文档、看网页可以选 30 帧：带宽省一半，字一样清楚。60 帧留给游戏。",
    },
    {
      icon: "pulse",
      title: "出问题能一键导出了",
      body: "设置 → 帮助 → 导出诊断信息，会生成一个文件，里面是连接状态、延迟丢包和最近的自动重连记录。以后出问题发给我们，比截图描述准得多。",
    },
    {
      icon: "home",
      title: "房间会记住了",
      body: "关掉客户端再打开，首页点「我的房间」就回到同一间，之前发出去的邀请链接照样能用。",
    },
  ],
};
