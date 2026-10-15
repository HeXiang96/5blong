/**
 * 应用内意见反馈：环境信息收集 + 提交。
 *
 * 服务端契约（worker/_worker.pages.js 的 handleFeedback，改一处要改两处）：
 *   POST /feedback  → 200 {ok:true,id} | 400 参数不合法 | 429 太频繁 | 503 通道未就绪
 *
 * 设计原则：
 * - **不让用户打字填环境**：版本、系统、屏幕、网络类型都自动带上（用户可见可关）。
 * - **不收集隐私**：不发送房间链接/密码/聊天内容；联系方式的收集由用户自己填。
 * - **失败不打扰**：提交失败只回一个可读原因，绝不弹系统级错误、不影响语音。
 */
import { latestChangelog } from "./changelog";
import { isTauriRuntime } from "./loopback";

export type FeedbackCategory = "voice" | "mic" | "room" | "screen" | "lag" | "other";

/** 分类选项（与服务端白名单一致）。 */
export const FEEDBACK_CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: "voice", label: "语音（听不到 / 杂音 / 回声）" },
  { value: "mic", label: "麦克风" },
  { value: "room", label: "进出房间" },
  { value: "screen", label: "屏幕共享（画面或声音）" },
  { value: "lag", label: "卡顿 / 掉线" },
  { value: "other", label: "其它" },
];

/** 描述与联系方式的上限（与服务端一致）。 */
export const FEEDBACK_MAX_MESSAGE = 500;
export const FEEDBACK_MAX_CONTACT = 120;

export interface FeedbackDraft {
  category: FeedbackCategory;
  message: string;
  contact: string;
}

export interface FeedbackPayload {
  version: string;
  platform: string;
  category: FeedbackCategory;
  message: string;
  contact: string;
  context: Record<string, string>;
}

/**
 * 反馈端点。与 `/ice`、`/sfu` 同款判定：**桌面端加载的是本地资源（tauri.localhost），
 * 相对路径打到的是 WebView 自己而不是我们的 Worker**，必须打公网地址。
 * 跨域由 Worker 的 feedbackCors() 放行（含 OPTIONS 预检）。
 */
const FEEDBACK_ENDPOINT = (() => {
  if (import.meta.env.DEV) return "/feedback";
  const host = typeof location !== "undefined" ? location.hostname : "";
  if (host === "tauri.localhost" || host.endsWith(".tauri.localhost")) {
    return "https://5blong.pages.dev/feedback";
  }
  return "/feedback";
})();

export type FeedbackResult =
  | { ok: true }
  | { ok: false; reason: "not-configured" | "rate-limited" | "rejected" | "network"; detail?: string };

/** 环境信息的展示名（自动收集，界面里按这个顺序摊开给用户看）。 */
export interface FeedbackContextInput {
  /** 触发反馈的错误提示原文（错误条"反馈此问题"时自动带上） */
  errorText?: string;
}

function browserName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua)) return "Safari";
  return "浏览器";
}

/**
 * 自动收集环境信息（纯函数，便于单测）。
 * 键名保持英文短词，管理页直接以 `键: 值` 展示。
 */
export function collectFeedbackContext(input: FeedbackContextInput = {}): Record<string, string> {
  const runtime = isTauriRuntime() ? "client" : "web";
  const context: Record<string, string> = {
    version: latestChangelog()?.version ?? "",
    runtime,
    browser: runtime === "web" ? browserName() : "webview2",
    os: typeof navigator === "undefined" ? "" : navigator.platform || "",
  };
  if (typeof window !== "undefined" && window.screen) {
    context.screen = `${window.screen.width}x${window.screen.height}`;
  }
  // 网络类型（Chromium 有值，其它浏览器没有就省略——别塞空值占位）
  const connection = (navigator as unknown as { connection?: { effectiveType?: string; downlink?: number } })
    ?.connection;
  if (connection?.effectiveType) {
    context.network = connection.downlink
      ? `${connection.effectiveType}/${connection.downlink}Mbps`
      : connection.effectiveType;
  }
  // 语言与设备像素比：排查"界面错位/字体异常"时有用
  if (typeof navigator !== "undefined" && navigator.language) context.lang = navigator.language;
  if (typeof window !== "undefined") context.dpr = String(window.devicePixelRatio || 1);
  if (input.errorText) context.error = input.errorText.slice(0, 200);
  return context;
}

/** 组装提交载荷（纯函数：裁剪、兜底分类）。 */
export function buildFeedbackPayload(
  draft: FeedbackDraft,
  context: Record<string, string>,
  runtimePlatform?: string,
): FeedbackPayload {
  const message = draft.message.trim().slice(0, FEEDBACK_MAX_MESSAGE);
  const contact = draft.contact.trim().slice(0, FEEDBACK_MAX_CONTACT);
  const known = FEEDBACK_CATEGORIES.some((item) => item.value === draft.category);
  return {
    version: context.version ?? "",
    platform: runtimePlatform ?? context.runtime ?? "",
    category: known ? draft.category : "other",
    message,
    contact,
    context,
  };
}

/** 提交反馈。失败返回可读原因，由界面负责提示。 */
export async function submitFeedback(payload: FeedbackPayload): Promise<FeedbackResult> {
  try {
    const response = await fetch(FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.ok) return { ok: true };
    if (response.status === 503) return { ok: false, reason: "not-configured" };
    if (response.status === 429) return { ok: false, reason: "rate-limited" };
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string };
      detail = body?.error ?? "";
    } catch {
      /* 响应不是 JSON 也无妨 */
    }
    return { ok: false, reason: "rejected", detail };
  } catch (error) {
    return { ok: false, reason: "network", detail: error instanceof Error ? error.message : "" };
  }
}

/** 失败原因 → 给用户看的一句话。 */
export function feedbackErrorText(result: Extract<FeedbackResult, { ok: false }>): string {
  switch (result.reason) {
    case "not-configured":
      return "反馈通道还没启用（服务端未配置），可以先在群里直接说一声";
    case "rate-limited":
      return "提交太频繁了，过一小时再试";
    case "network":
      return "网络不通，没发出去——稍后再试";
    default:
      return "没提交成功，稍后再试";
  }
}
