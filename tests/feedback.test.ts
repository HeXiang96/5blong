/**
 * 意见反馈的纯函数单测（服务端契约见 worker/_worker.pages.js 的 handleFeedback）。
 * 重点钉：裁剪上限、分类兜底、环境信息不做假（缺项不塞空值）。
 */
import { describe, expect, it } from "vitest";

import {
  FEEDBACK_MAX_CONTACT,
  FEEDBACK_MAX_MESSAGE,
  buildFeedbackPayload,
  feedbackErrorText,
} from "../src/client/voice/feedback";

describe("buildFeedbackPayload", () => {
  it("裁剪描述与联系方式到服务端上限", () => {
    const payload = buildFeedbackPayload(
      { category: "voice", message: `  ${"啊".repeat(600)}  `, contact: "q".repeat(200) },
      { version: "1.4.7" },
    );
    expect(payload.message).toHaveLength(FEEDBACK_MAX_MESSAGE);
    expect(payload.contact).toHaveLength(FEEDBACK_MAX_CONTACT);
    expect(payload.category).toBe("voice");
    expect(payload.version).toBe("1.4.7");
    // 描述首尾空白被裁掉
    expect(payload.message.startsWith("啊")).toBe(true);
  });

  it("未知分类兜底为 other（不让脏值进库）", () => {
    const payload = buildFeedbackPayload(
      { category: "hack" as never, message: "你好", contact: "" },
      {},
    );
    expect(payload.category).toBe("other");
  });

  it("环境信息原样带上（含错误原文）", () => {
    const payload = buildFeedbackPayload(
      { category: "screen", message: "共享没声音", contact: "abc" },
      { version: "1.4.7", runtime: "client", error: "共享没开起来（NotReadableError）" },
      "client-win32",
    );
    expect(payload.platform).toBe("client-win32");
    expect(payload.context.error).toContain("NotReadableError");
  });
});

describe("feedbackErrorText", () => {
  it("每种失败都给得出人话（不暴露内部错误码）", () => {
    expect(feedbackErrorText({ ok: false, reason: "not-configured" })).toContain("还没启用");
    expect(feedbackErrorText({ ok: false, reason: "rate-limited" })).toContain("过一小时");
    expect(feedbackErrorText({ ok: false, reason: "network" })).toContain("网络");
    expect(feedbackErrorText({ ok: false, reason: "rejected", detail: "bad json" })).toContain("稍后");
  });
});
