/**
 * 自动播放被拦之后的"补救"：先静音播，等用户的一次交互再自动开声。
 *
 * 为什么需要它：桌面客户端是 WebView2（Chromium 内核），而
 * `--autoplay-policy=no-user-gesture-required` **不在 WebView2 支持的启动参数
 * 白名单里**，会被静默忽略——所以客户端同样会被自动播放策略拦。
 * 网页版更不用说。
 *
 * 被拦时的正确姿势不是"再 play 一次"（没有手势，第二次一样被拒），而是：
 *   1. 先 muted 播起来，保证画面/时间线正常（用户至少能看到东西）；
 *   2. 挂一次性监听，用户第一次点/按键盘时把所有挂起的元素开声。
 */

const pending = new Set<HTMLMediaElement>();
let armed = false;

function arm(): void {
  if (armed) return;
  armed = true;
  const run = () => {
    armed = false;
    window.removeEventListener("pointerdown", run, true);
    window.removeEventListener("keydown", run, true);
    for (const element of pending) {
      // 用户点过之后这一下一定放行；失败的（比如元素已卸载）直接忽略
      element.muted = false;
      void element.play().catch(() => {});
    }
    pending.clear();
  };
  // capture 阶段：先于业务逻辑，用户点哪儿都算数
  window.addEventListener("pointerdown", run, true);
  window.addEventListener("keydown", run, true);
}

/**
 * 登记一个"因为自动播放策略而放不出声"的元素。
 * @param element 目标元素（调用方应已把它设为 muted 并 play 过）
 * @param onUnlock 开声后的回调（例如同步 UI 上的静音图标）
 */
export function onAutoplayBlocked(element: HTMLMediaElement, onUnlock?: () => void): void {
  pending.add(element);
  if (onUnlock) {
    const original = element;
    const once = () => {
      original.removeEventListener("volumechange", once);
      onUnlock();
    };
    // 开声由上面的 run() 改 muted，这里只负责通知 UI
    original.addEventListener("volumechange", once, { once: true });
  }
  arm();
}

/** 元素被销毁/换源时把它从待恢复名单里摘掉，避免泄漏。 */
export function forgetAutoplayElement(element: HTMLMediaElement): void {
  pending.delete(element);
}
