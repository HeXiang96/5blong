/**
 * 房号的"占位"：开房前先在服务端原子地占住这个号，避免撞上别人的固定房号。
 *
 * 背景（2026-10-26 业主口径）：
 * 临时房号原来是本地随机的，不看谁认领了什么——别人随手开一间可能正好是你
 * 「我的房间」的号。光"开房前查一次"还不够（查完到真正开房之间有空档，
 * 而且两端同时开也会撞）。所以改成**数据库唯一主键占位**：
 *
 *   POST /room-hold {code, token}  → ok（占到） / taken（已被账号认领） / busy（别人正开着）
 *   房主每 30 秒续一次（服务端 90 秒过期，扛得住切后台）
 *   关房 DELETE /room-hold?token=… 立刻释放
 *
 * 降级：接口不通就返回 offline，调用方照常开房——绝不能为了查重把人挡在门外。
 */

function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function apiBase(): string {
  const override = import.meta.env["VITE_ACCOUNT_API"] as string | undefined;
  if (override) return override.replace(/\/$/, "");
  if (isDesktopRuntime()) return "https://5blong.pages.dev/api/account";
  return "/api/account";
}

export type HoldResult = "ok" | "taken" | "busy" | "offline";

/** 占住房号。token 是这台机器这次开房的临时凭据（关房时用它释放）。 */
export async function holdRoomCode(code: string, token: string): Promise<HoldResult> {
  if (!/^\d{6}$/.test(code)) return "taken";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${apiBase()}/room-hold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, token }),
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (response.ok) return "ok";
    if (response.status === 409) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      return data.error === "busy" ? "busy" : "taken";
    }
    return "offline";
  } catch {
    return "offline";
  }
}

/** 关房释放（失败无所谓：90 秒后服务端自己过期）。 */
export async function releaseRoomHolds(token: string): Promise<void> {
  if (!token) return;
  try {
    await fetch(`${apiBase()}/room-hold?token=${encodeURIComponent(token)}`, {
      method: "DELETE",
      keepalive: true,
    });
  } catch {
    /* 忽略：过期即释放 */
  }
}
