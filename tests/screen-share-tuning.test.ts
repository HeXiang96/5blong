/**
 * 屏幕共享优化的纯逻辑单测。
 *
 * 覆盖本轮新增/改动的判断逻辑（都不需要真实 RTCPeerConnection）：
 * - 编解码器偏好重排（H.264 提前 = 才可能吃到 NVENC）
 * - P2P 上行分摊与降级阶梯
 * - 传输方式自动选择（人多切 SFU）
 * - getStats 读数摘要（发送端/接收端两个方向）
 * - 协议里的 simulcast 标记
 * - 设置迁移（传输方式缺省从 p2p 改 auto）
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  RESOLUTION_LADDER,
  autoTransportFor,
  perViewerBitrate,
  preferH264Sdp,
  summarizeScreenStats,
  type StatsEntry,
} from "../src/client/voice/screen-share";
import { loadSettings } from "../src/client/voice/settings";
import { parseGuestMessage, parseScreenShareState } from "../src/client/voice/protocol";

describe("preferH264Sdp（P2P 链路把协商拉回 H.264）", () => {
  const sdp = [
    "v=0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98",
    "a=rtpmap:96 VP8/90000",
    "a=rtpmap:97 rtx/90000",
    "a=rtpmap:98 H264/90000",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=rtpmap:111 opus/48000/2",
  ].join("\r\n");

  it("把 H.264 载荷提到 m=video 最前，且保持其余原序", () => {
    const out = preferH264Sdp(sdp);
    expect(out).toContain("m=video 9 UDP/TLS/RTP/SAVPF 98 96 97");
    // 音频段不许被动
    expect(out).toContain("m=audio 9 UDP/TLS/RTP/SAVPF 111");
  });

  it("幂等：已经排好就不再改（避免每帧重排）", () => {
    const once = preferH264Sdp(sdp);
    expect(preferH264Sdp(once)).toBe(once);
  });

  it("没有 H.264 时原样返回", () => {
    const vp8Only = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000";
    expect(preferH264Sdp(vp8Only)).toBe(vp8Only);
  });

  it("空串安全", () => {
    expect(preferH264Sdp("")).toBe("");
  });
});

describe("perViewerBitrate（P2P 上行分摊）", () => {
  it("按观众数均分档位码率", () => {
    expect(perViewerBitrate("fhd1080", 1)).toBe(8_000_000);
    expect(perViewerBitrate("fhd1080", 2)).toBe(4_000_000);
    expect(perViewerBitrate("hd720", 4)).toBe(1_250_000);
  });

  it("保底 1.2 Mbps：观众再多也不摊到这个线以下", () => {
    expect(perViewerBitrate("fhd1080", 7)).toBe(1_200_000);
    expect(perViewerBitrate("hd720", 20)).toBe(1_200_000);
  });

  it("非法观众数按 1 处理", () => {
    expect(perViewerBitrate("fhd1080", 0)).toBe(8_000_000);
    expect(perViewerBitrate("fhd1080", -3)).toBe(8_000_000);
  });
});

describe("RESOLUTION_LADDER（降级阶梯）", () => {
  it("严格递增（1080p → 720p → 540p → 380p）", () => {
    for (let i = 1; i < RESOLUTION_LADDER.length; i += 1) {
      expect(RESOLUTION_LADDER[i]!).toBeGreaterThan(RESOLUTION_LADDER[i - 1]!);
    }
    expect(RESOLUTION_LADDER[0]).toBe(1);
  });
});

describe("autoTransportFor（按人数自动选传输）", () => {
  it("自动：1~2 位观众走直连，3 位及以上走 SFU", () => {
    expect(autoTransportFor("auto", 1).transport).toBe("p2p");
    expect(autoTransportFor("auto", 3).transport).toBe("p2p");
    expect(autoTransportFor("auto", 4).transport).toBe("sfu");
    expect(autoTransportFor("auto", 8).transport).toBe("sfu");
  });

  it("显式选择永远优先", () => {
    expect(autoTransportFor("p2p", 8).transport).toBe("p2p");
    expect(autoTransportFor("sfu", 1).transport).toBe("sfu");
  });

  it("每种结果都给得出人话的理由", () => {
    expect(autoTransportFor("auto", 4).reason).toContain("SFU");
    expect(autoTransportFor("auto", 2).reason).toContain("直连");
    expect(autoTransportFor("p2p", 2).reason.length).toBeGreaterThan(0);
  });
});

describe("summarizeScreenStats（灯箱数据条）", () => {
  const sendSample: StatsEntry[] = [
    { id: "C1", type: "codec", mimeType: "video/H264" },
    {
      id: "O1",
      type: "outbound-rtp",
      kind: "video",
      codecId: "C1",
      bytesSent: 1_000_000,
      timestamp: 10_000,
      frameWidth: 1920,
      frameHeight: 1080,
      framesPerSecond: 60,
      encoderImplementation: "MediaFoundation",
      powerEfficientEncoder: true,
      qualityLimitationReason: "bandwidth",
      framesEncoded: 100,
      totalEncodeTime: 1.2,
      availableOutgoingBitrate: 3_500_000,
    },
  ];

  it("发送端：能读出分辨率/编码器/硬编/限流原因", () => {
    const s = summarizeScreenStats(sendSample, null);
    expect(s.role).toBe("send");
    expect(s.width).toBe(1920);
    expect(s.height).toBe(1080);
    expect(s.codec).toBe("H264");
    expect(s.implementation).toBe("MediaFoundation");
    expect(s.powerEfficient).toBe(true);
    expect(s.limitation).toBe("bandwidth");
    expect(s.kbps).toBe(0); // 第一次采样没有基线
    expect(s.text).toContain("1920×1080");
    expect(s.text).toContain("硬编");
    expect(s.text).toContain("带宽受限");
    expect(s.text).toContain("编码 12ms/帧");
    expect(s.text).toContain("可用 3500 kbps");
  });

  it("发送端：两次采样之间算出实际码率", () => {
    const first = summarizeScreenStats(sendSample, null);
    const second = summarizeScreenStats(
      [{ ...(sendSample[1] as StatsEntry), bytesSent: 2_000_000, timestamp: 12_000 }],
      first.sample,
    );
    // (2_000_000 - 1_000_000) * 8 / 2000ms = 4000 kbps
    expect(second.kbps).toBe(4000);
    expect(second.text).toContain("4000 kbps");
  });

  it("发送端：局限为 cpu 时话术可辨（说明没吃到硬编）", () => {
    const s = summarizeScreenStats(
      [{ ...(sendSample[1] as StatsEntry), qualityLimitationReason: "cpu" }],
      null,
    );
    expect(s.text).toContain("CPU 受限");
  });

  it("接收端：读解码器/软硬解/卡顿/丢包", () => {
    const recv: StatsEntry[] = [
      { id: "C9", type: "codec", mimeType: "video/VP8" },
      {
        id: "I1",
        type: "inbound-rtp",
        kind: "video",
        codecId: "C9",
        bytesReceived: 500_000,
        timestamp: 1_000,
        frameWidth: 1280,
        frameHeight: 720,
        framesPerSecond: 30,
        decoderImplementation: "libvpx",
        powerEfficientDecoder: false,
        freezeCount: 3,
        packetsReceived: 990,
        packetsLost: 10,
      },
    ];
    const s = summarizeScreenStats(recv, null);
    expect(s.role).toBe("recv");
    expect(s.codec).toBe("VP8");
    expect(s.powerEfficient).toBe(false);
    expect(s.frozen).toBe(3);
    expect(s.lossPct).toBe(1);
    expect(s.text).toContain("收到 1280×720");
    expect(s.text).toContain("软解");
    expect(s.text).toContain("卡顿 3 次");
    expect(s.text).toContain("丢包 1%");
  });

  it("没有视频流时返回空摘要（不抛错）", () => {
    const s = summarizeScreenStats([{ id: "A1", type: "transport" }], null);
    expect(s.role).toBeNull();
    expect(s.text).toBe("");
  });
});

describe("simulcast 标记（协议透传）", () => {
  const valid = {
    active: true,
    sharerId: "5b-g-abc",
    sessionId: "sess-1",
    trackName: "screen",
    trackNameAudio: "",
    label: "窗口",
    startedAt: 1,
    transport: "sfu",
  };

  it("带 simulcast 的状态被保留", () => {
    expect(parseScreenShareState({ ...valid, simulcast: true })?.simulcast).toBe(true);
  });

  it("没有 simulcast 时不凭空造字段（旧房主兼容）", () => {
    const parsed = parseScreenShareState({ ...valid });
    expect(parsed).not.toBeNull();
    expect("simulcast" in (parsed as object)).toBe(false);
  });

  it("访客申报里的 simulcast 也透传", () => {
    const start = parseGuestMessage({
      t: "screen-share-start",
      session: {
        sessionId: "s1",
        trackName: "screen",
        trackNameAudio: "",
        label: "屏幕",
        hasAudio: false,
        transport: "sfu",
        simulcast: true,
      },
    });
    expect(start?.t).toBe("screen-share-start");
    expect(start && start.t === "screen-share-start" && start.session.simulcast).toBe(true);
  });
});

describe("设置迁移：传输方式缺省从 p2p 改成 auto", () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  const stub = (payload: Record<string, unknown>) => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => JSON.stringify(payload),
      setItem: () => {},
      removeItem: () => {},
    };
  };

  it("没有任何存储时用 auto", () => {
    expect(loadSettings().shareTransport).toBe("auto");
  });

  it("旧配置（无版本号）里的 p2p 是当年的默认值，迁到 auto", () => {
    stub({ shareTransport: "p2p" });
    expect(loadSettings().shareTransport).toBe("auto");
  });

  it("旧配置里显式选的 sfu 保留", () => {
    stub({ shareTransport: "sfu" });
    const loaded = loadSettings();
    expect(loaded.shareTransport).toBe("sfu");
    expect(loaded.settingsVersion).toBe(2);
  });

  it("v2 配置里显式选的 p2p 保留（不再被迁走）", () => {
    stub({ settingsVersion: 2, shareTransport: "p2p" });
    expect(loadSettings().shareTransport).toBe("p2p");
  });
});
