/**
 * 硬件编解码预检的单测（2026-10-14 实测推翻旧实现后新增）。
 *
 * 背景（必须钉住，否则必然复发）：
 * WebCodecs 的 `VideoEncoder.isConfigSupported({codec:"avc1.640028", hardwareAcceleration:"require-hardware"})`
 * 在 Chrome/Windows 上**对 H.264 一律回答 false**——它不暴露 MediaFoundation/NVENC。
 * 而真实 WebRTC 协商时同一个 H.264 走的是硬编（灯箱读数 `NVIDIA H.264 Encoder MFT 硬编`）。
 * 结果是"有硬编就关掉 simulcast"的判据永不成立 → 共享端继续用 OpenH264 软编三档 →
 * 实测 12.2ms/帧、CPU 受限、帧率被压到 24~30fps。
 *
 * 现在改为优先问 `navigator.mediaCapabilities`（`type: "webrtc"` 才是 WebRTC 这条路的答案），
 * WebCodecs 只作没有该 API 时的兜底。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  probeHardwareEncoders,
  resetHardwareProbeCache,
} from "../src/client/voice/screen-share";

/** 造一个 navigator.mediaCapabilities 桩：按 contentType + kind 给答案。 */
function stubMediaCapabilities(
  answers: Record<string, { supported: boolean; powerEfficient: boolean }>,
) {
  vi.stubGlobal("navigator", {
    mediaCapabilities: {
      encodingInfo: async (config: { video?: { contentType?: string } }) =>
        answers[`enc:${config.video?.contentType ?? ""}`] ?? { supported: false, powerEfficient: false },
      decodingInfo: async (config: { video?: { contentType?: string } }) =>
        answers[`dec:${config.video?.contentType ?? ""}`] ?? { supported: false, powerEfficient: false },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetHardwareProbeCache();
});

describe("probeHardwareEncoders（mediaCapabilities 优先）", () => {
  it("mediaCapabilities 说 H.264 走硬编 → h264=true（旧实现会在这里误报 false）", async () => {
    stubMediaCapabilities({
      "enc:video/H264": { supported: true, powerEfficient: true },
    });
    const probe = await probeHardwareEncoders("fhd1080");
    expect(probe.checked).toBe(true);
    expect(probe.h264).toBe(true);
    // 没报的服务一律按"没有"处理（保守：宁可用 H.264 软编也不用错编码）
    expect(probe.av1).toBe(false);
  });

  it("supported 但不省电（软编）→ false", async () => {
    stubMediaCapabilities({
      "enc:video/H264": { supported: true, powerEfficient: false },
      "enc:video/AV1": { supported: true, powerEfficient: true },
    });
    const probe = await probeHardwareEncoders("fhd1080");
    expect(probe.h264).toBe(false);
    expect(probe.av1).toBe(true);
  });

  it("解码能力同样取自 mediaCapabilities（观众端 AV1 上报与双端判断的输入）", async () => {
    stubMediaCapabilities({
      "dec:video/AV1": { supported: true, powerEfficient: true },
      "dec:video/H264": { supported: true, powerEfficient: true },
    });
    const probe = await probeHardwareEncoders("fhd1080");
    expect(probe.decAv1).toBe(true);
    expect(probe.decH264).toBe(true);
  });

  it("没有 mediaCapabilities（旧浏览器）→ 退回 WebCodecs 预检", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("VideoEncoder", {
      isConfigSupported: async (config: { codec?: string }) => ({
        supported: config.codec?.startsWith("avc1") === true,
      }),
    });
    vi.stubGlobal("VideoDecoder", { isConfigSupported: async () => ({ supported: false }) });
    const probe = await probeHardwareEncoders("fhd1080");
    expect(probe.checked).toBe(true);
    expect(probe.h264).toBe(true);
    expect(probe.av1).toBe(false);
  });

  it("什么都没有（无 WebCodecs 也无 mediaCapabilities）→ 未探到", async () => {
    vi.stubGlobal("navigator", {});
    const probe = await probeHardwareEncoders("fhd1080");
    expect(probe.checked).toBe(false);
    expect(probe.h264).toBe(false);
  });

  it("结果按会话缓存（同一个浏览器不会变）", async () => {
    stubMediaCapabilities({ "enc:video/H264": { supported: true, powerEfficient: true } });
    const first = await probeHardwareEncoders("fhd1080");
    // 换一套答案（模拟"第二次调用不该再问"）
    stubMediaCapabilities({ "enc:video/H264": { supported: true, powerEfficient: false } });
    const second = await probeHardwareEncoders("hd720");
    expect(second).toBe(first);
  });
});
