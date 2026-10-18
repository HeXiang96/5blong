/**
 * 开黑圈的 URL 工具（纯字符串逻辑，无 React / 无引擎依赖）。
 *
 * 单独成文件的原因：App 首帧就要读 `?g=` 判断是否直接进开黑圈，
 * 若从 GameRoomView.tsx 里 import，会把 700+ 行视图和整条引擎链拉进首屏包，
 * 懒加载就形同虚设。这里保持**零依赖**，任何模块都可以安全引用。
 */

/** 复制用的邀请链接（桌面端页面在本地协议下，必须改写成网页可用地址）。 */
export function gameInviteUrl(code: string): string {
  const host = window.location.hostname;
  const desktop = host === "tauri.localhost" || host.endsWith(".tauri.localhost");
  const url = new URL(desktop ? "https://5blong.pages.dev/" : window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("g", code);
  return url.toString();
}

/** 从地址栏读开黑圈房间码（4 位数字）；没有或不合法返回 null。 */
export function gameCodeFromUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get("g");
  return value && /^[0-9]{4}$/.test(value) ? value : null;
}
