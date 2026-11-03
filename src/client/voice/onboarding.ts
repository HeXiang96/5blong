/**
 * 首次打开的功能导览（只弹一次）。
 *
 * 存储：`5blong:v1:onboarding` = 看过的版本号（沿用 settings.ts 的 `5blong:v1:<KEY>` 命名）。
 * 内容版本 `ONBOARDING_VERSION` 只在**新增重要功能**时 +1，老用户才会再看一次——
 * 平时不动，免得每次发版都打扰人。
 *
 * 存储不可用（隐私模式等）时退化为"本次会话只弹一次"，避免每次刷新都弹。
 */

/**
 * 导览内容版本：改动导览文案/新增功能时 +1。
 *
 * 2026-10-26 → 2：产品分成「临时房」与「我的房间（私密房）」两种，且主题入口
 * 早就不在房间里了（在首页右上角调色板），老文案会把人指到不存在的按钮上。
 */
export const ONBOARDING_VERSION = 2;

const KEY = "5blong:v1:onboarding";

/** 本次会话内是否已经弹过（localStorage 不可用时的兜底）。 */
let shownThisSession = false;

function readSeenVersion(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const value = raw === null ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    // 隐私模式等：读不到就当没看过，交给 shownThisSession 兜底
    return shownThisSession ? ONBOARDING_VERSION : 0;
  }
}

/** 这次打开要不要弹导览。 */
export function shouldShowOnboarding(): boolean {
  if (shownThisSession) return false;
  return readSeenVersion() < ONBOARDING_VERSION;
}

/** 标记导览已看过（关闭或点"开始使用"时调用）。 */
export function markOnboardingSeen(): void {
  shownThisSession = true;
  try {
    localStorage.setItem(KEY, String(ONBOARDING_VERSION));
  } catch {
    /* 写不进去也没关系：本次会话不会再弹 */
  }
}

/** 仅测试用：重置会话内标记。 */
export function resetOnboardingSessionFlag(): void {
  shownThisSession = false;
}

/**
 * 导览条目（文案集中在这里，便于以后改）。
 *
 * 2026-11-03 瘦身：原来 7 条、每条两三行，弹窗快占满一屏，而且写成了产品宣传
 * （"加好友 & 看谁在线"这种），不是"界面上按钮在哪"。
 * 功能清单属于介绍页（5blong.site），这里只留**进应用后马上要用的 4 条**。
 */
export const ONBOARDING_ITEMS: { icon: string; title: string; text: string }[] = [
  {
    icon: "🔗",
    title: "开一间，发个链接",
    text: "首页点「创建语音房」，拿到 6 位房号。念给对方，或复制链接发过去，浏览器点开就能进。",
  },
  {
    icon: "🏠",
    title: "我的房间（要登录）",
    text: "登录后固定一个房号，之后一直开这一间。它是私密房：只认邀请链接或「房号 + 临时密码」。",
  },
  {
    icon: "🎛️",
    title: "房间底部的三个按钮",
    text: "麦克风、共享屏幕、邀请。点某个成员还能加好友、调他的音量。",
  },
  {
    icon: "🎨",
    title: "想换个样子",
    text: "首页右上角的调色板：雪原、万圣夜、春节，早晚还各有一套配色。",
  },
];
