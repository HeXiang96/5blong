/**
 * 运行环境判据（全仓唯一一份）。
 *
 * 之前这段逻辑散在三个地方，其中对局那处写的是 `navigator.userAgent` 里找 "tauri"——
 * 而 Tauri v2 + Windows WebView2 的 UA 里**没有这个词**，于是桌面端一直当自己是网页，
 * 把请求打到 tauri.localhost 的静态资源上（1.9.24「邀请几秒消失」的真因之一）。
 * 现在统一在这里判断，新增代码不许再自己写一份。
 */
export function isDesktopRuntime(): boolean {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) return true;
  const host = typeof location !== "undefined" ? location.hostname : "";
  return host === "tauri.localhost" || host.endsWith(".tauri.localhost");
}
