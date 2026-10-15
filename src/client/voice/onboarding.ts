/**
 * 首次打开的功能导览（只弹一次）。
 *
 * 存储：`5blong:v1:onboarding` = 看过的版本号（沿用 settings.ts 的 `5blong:v1:<KEY>` 命名）。
 * 内容版本 `ONBOARDING_VERSION` 只在**新增重要功能**时 +1，老用户才会再看一次——
 * 平时不动，免得每次发版都打扰人。
 *
 * 存储不可用（隐私模式等）时退化为"本次会话只弹一次"，避免每次刷新都弹。
 */

/** 导览内容版本：改动导览文案/新增功能时 +1。 */
export const ONBOARDING_VERSION = 1;

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
 */
export const ONBOARDING_ITEMS: { icon: string; title: string; text: string }[] = [
  {
    icon: "🔗",
    title: "开房 & 邀请",
    text: "点「创建房间」拿到房间码和链接，发给朋友就行——他们不用注册、不用装软件，浏览器点开即进。",
  },
  {
    icon: "🎙️",
    title: "说话",
    text: "进房默认静音（防炸麦），点麦克风图标开麦。音量、降噪、选麦克风都在右上角「设置」里。",
  },
  {
    icon: "🖥️",
    title: "一起看屏幕",
    text: "底部「共享」→ 选屏幕或窗口，全房同看一块大幕布；想连游戏/视频的声音一起共享就勾上「系统音频」，观众点幕布开音量。",
  },
  {
    icon: "🐷",
    title: "装个客户端更省心",
    text: "托盘常驻（关窗口不断线）、自动更新、麦克风免授权，共享系统声音也不挑声卡。",
  },
];
