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
 * 每条 = 一个图标 + 粗标签 + 一句话说明，控制在"一屏能看完"。
 *
 * 2026-10-26：产品分成**两种房**，导览必须一开始就把这个分岔讲清楚——
 *   ① 临时房（主入口「创建语音房」）：随机 6 位房号，念个号就能进，不设门禁；
 *   ② 我的房间（登录账号的固定房号）：私密房，只认邀请链接或「房号 + 临时密码」。
 */
export const ONBOARDING_ITEMS: { icon: string; title: string; text: string }[] = [
  {
    icon: "🔗",
    title: "随手开一间（临时房）",
    text: "首页点「创建语音房」，几秒后拿到 6 位房号：念给对方，或把链接发过去，浏览器点开就能进——不用注册、不用装软件。",
  },
  {
    icon: "🏠",
    title: "我的房间（要登录）",
    text: "登录账号后能领一个永久属于你的房号，之后一直开这一间。它是私密房：只认邀请链接或「房号 + 临时密码」，光知道房号进不来。",
  },
  {
    icon: "🔑",
    title: "临时密码",
    text: "在房间里点顶栏的钥匙图标，生成 6 位临时密码发给不熟的朋友。换一个旧的立刻失效，关掉就只剩邀请链接能进。",
  },
  {
    icon: "👥",
    title: "加好友 & 看谁在线",
    text: "房间里点某个成员就能加好友（要对方同意）。好友面板里能看到谁在线、在哪个房。不登录也能正常开房、说话。",
  },
  {
    icon: "📨",
    title: "邀请不会错过",
    text: "好友在房间里点「邀请」，会直接推到你这边，并在好友面板的「邀请」里留一条记录——当时在忙没看到也不会丢。",
  },
  {
    icon: "🖥️",
    title: "一起看屏幕",
    text: "底部「共享」→ 选屏幕或窗口，全房同看一块大幕布；想连游戏/视频的声音一起共享就勾上「系统音频」，观众点幕布开音量。",
  },
  {
    icon: "🎨",
    title: "主题在首页右上角",
    text: "调色板里换雪原、万圣夜、春节；早中晚夜各有一套配色，首页和房间里一起变（房间里没有主题按钮）。",
  },
];
