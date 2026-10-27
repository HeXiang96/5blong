/**
 * 屏幕共享优化的纯逻辑单测。
 *
 * 覆盖本轮新增/改动的判断逻辑（都不需要真实 RTCPeerConnection）：
 * - 编解码器偏好重排（H.264 提前 = 才可能吃到 NVENC）
 * - P2P 上行分摊与降级阶梯
 * - 传输方式自动选择（人多切 SFU）
 * - getStats 读数摘要（发送端/接收端两个方向）
 * - ICE 链路类型（直连 / 经中继）与真实可用带宽的读数来源
 * - 降档判据：只看链路容量，不看实际码率（静态画面不得误降）
 * - 协议里的 simulcast 标记
 * - 设置迁移（传输方式缺省从 p2p 改 auto）
 */
import { afterEach, describe, expect, it } from "vitest";

import { canProbeShareAudio } from "../src/client/voice/screen-share";

import {
  JITTER_ADAPTIVE_MS,
  RESOLUTION_LADDER,
  SHARE_QUALITY_PRESETS,
  autoTransportFor,
  boostScreenOfferSdp,
  h264ProfileRank,
  injectStartBitrate,
  jitterBufferTargetFor,
  nearestLadderIndex,
  perViewerBitrate,
  preferCodecSdp,
  formatScreenLayers,
  preferH264Sdp,
  preferredRidFor,
  screenHintFor,
  screenLinkStrained,
  shouldUseSimulcast,
  simulcastSubscribeConfig,
  simulcastLayerBitrates,
  simulcastLayerLabel,
  summarizeScreenStats,
  tuneLadder,
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
  /*
   * 2026-10-27 调校：1080p60 档位上限 8 → 12 Mbps（业主："要最优画质"）。
   *
   * 含义变成「一对一给满 12M，多观众仍按 P2P_TOTAL_UPLINK_BUDGET=12M 总预算均分」——
   * 注意单档上限现在**等于**总预算，所以：
   *   - 1 人：12 Mbps（这就是提升画质的地方）；
   *   - 2 人：各 6 Mbps（原来是各 4）；
   *   - 人数再多，仍由"总预算 / n"和 1.2 Mbps 地板共同收口，不会顶爆上行。
   * 改这些数字前先想清楚：它们编码的是**上行预算的取舍**，不是随手一改的魔法数。
   */
  it("按观众数均分档位码率", () => {
    expect(perViewerBitrate("fhd1080", 1)).toBe(12_000_000);
    expect(perViewerBitrate("fhd1080", 2)).toBe(6_000_000);
    expect(perViewerBitrate("hd720", 4)).toBe(1_250_000);
  });

  it("保底 1.2 Mbps，但总上行不能顶爆（12 Mbps 预算）", () => {
    // 7 位观众：12/7 ≈ 1.71 Mbps，高于地板 → 按均分（总 12 Mbps，正好在预算上）
    expect(perViewerBitrate("fhd1080", 7)).toBe(1_714_286);
    // 12 位观众（房间上限）：地板会把总量顶到 14.4 Mbps，必须按预算压到 1.0 Mbps
    expect(perViewerBitrate("fhd1080", 12)).toBe(1_000_000);
    // 极端情况：预算优先，绝不放大到地板以上
    expect(perViewerBitrate("hd720", 20)).toBe(600_000);
  });

  it("非法观众数按 1 处理", () => {
    expect(perViewerBitrate("fhd1080", 0)).toBe(12_000_000);
    expect(perViewerBitrate("fhd1080", -3)).toBe(12_000_000);
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
  it("自动：观众 ≤2 走直连，3 位及以上走 SFU（2026-10-21 从 ≤4 收回）", () => {
    // 每一路直连都是一份完整上行：4 个观众 × 8Mbps = 32Mbps，家用上行必爆
    expect(autoTransportFor("auto", 1).transport).toBe("p2p"); // 0 位观众
    expect(autoTransportFor("auto", 3).transport).toBe("p2p"); // 2 位观众
    expect(autoTransportFor("auto", 4).transport).toBe("sfu"); // 3 位观众
    expect(autoTransportFor("auto", 6).transport).toBe("sfu"); // 5 位观众
    expect(autoTransportFor("auto", 8).transport).toBe("sfu"); // 7 位观众
  });

  it("30fps 档位的码率上限低于同分辨率 60fps 档", () => {
    expect(SHARE_QUALITY_PRESETS.hd720p30.fps).toBe(30);
    expect(SHARE_QUALITY_PRESETS.hd720p30.maxBitrate).toBeLessThan(
      SHARE_QUALITY_PRESETS.hd720.maxBitrate,
    );
    expect(SHARE_QUALITY_PRESETS.fhd1080p30.fps).toBe(30);
    expect(SHARE_QUALITY_PRESETS.fhd1080p30.maxBitrate).toBeLessThan(
      SHARE_QUALITY_PRESETS.fhd1080.maxBitrate,
    );
    expect(SHARE_QUALITY_PRESETS.hd720p30.width).toBe(SHARE_QUALITY_PRESETS.hd720.width);
  });

  it("显式选择永远优先", () => {
    expect(autoTransportFor("p2p", 8).transport).toBe("p2p");
    expect(autoTransportFor("sfu", 1).transport).toBe("sfu");
  });

  it("每种结果都给得出人话的理由", () => {
    expect(autoTransportFor("auto", 6).reason).toContain("SFU");
    expect(autoTransportFor("auto", 3).reason).toContain("直连");
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

/** 造一份发送端读数：可指定实际码率 / 自述受限原因 / 链路容量 / 候选类型。 */
function sendStats(p: {
  bytes: number;
  ts: number;
  limitation?: string;
  available?: number;
  localType?: string;
}): StatsEntry[] {
  return [
    { id: "C1", type: "codec", mimeType: "video/H264" },
    {
      id: "O1",
      type: "outbound-rtp",
      kind: "video",
      codecId: "C1",
      bytesSent: p.bytes,
      timestamp: p.ts,
      frameWidth: 1920,
      frameHeight: 1080,
      framesPerSecond: 60,
      qualityLimitationReason: p.limitation ?? "none",
    },
    { id: "L1", type: "local-candidate", candidateType: p.localType ?? "host" },
    {
      id: "P1",
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      localCandidateId: "L1",
      remoteCandidateId: "R1",
      ...(p.available === undefined ? {} : { availableOutgoingBitrate: p.available }),
    },
  ];
}

/** 连续两次采样（第二次才有码率差值）。 */
function readSend(p: Parameters<typeof sendStats>[0], second: Parameters<typeof sendStats>[0]) {
  const first = summarizeScreenStats(sendStats(p), null);
  return summarizeScreenStats(sendStats(second), first.sample);
}

describe("ICE 链路读数（链路真相在 candidate-pair 里）", () => {
  it("可用带宽取自 candidate-pair（outbound-rtp 上没有这个字段）", () => {
    const s = summarizeScreenStats(sendStats({ bytes: 1_000, ts: 1_000, available: 20_000_000 }), null);
    expect(s.availableKbps).toBe(20000);
    expect(s.text).toContain("可用 20000 kbps");
  });

  it("走 TURN 中继时数据条直说「经中继」（限速元凶一眼可见）", () => {
    const s = summarizeScreenStats(
      sendStats({ bytes: 1_000, ts: 1_000, localType: "relay", available: 500_000 }),
      null,
    );
    expect(s.linkType).toBe("relay");
    expect(s.text).toContain("经中继");
  });

  it("直连时标「直连」，且候选对没选出来时不乱猜", () => {
    const direct = summarizeScreenStats(sendStats({ bytes: 1_000, ts: 1_000 }), null);
    expect(direct.linkType).toBe("direct");
    expect(direct.text).toContain("直连");

    const unknown = summarizeScreenStats([{ id: "O1", type: "outbound-rtp", kind: "video" }], null);
    expect(unknown.linkType).toBe("unknown");
    expect(unknown.text).not.toContain("经中继");
  });
});

describe("screenLinkStrained（降档判据：看链路，不看码率）", () => {
  const CAP = 10_000_000;

  it("静态画面：码率只有 62 kbps 也不许降档（链路容量充足）", () => {
    // 1000ms 内只发了 7750 字节 ≈ 62 kbps，但链路可用 20 Mbps
    const s = readSend(
      { bytes: 1_000, ts: 10_000, available: 20_000_000 },
      { bytes: 8_750, ts: 11_000, available: 20_000_000 },
    );
    expect(s.kbps).toBe(62);
    expect(screenLinkStrained(s, CAP)).toBe(false);
  });

  it("链路容量真的不够（如公共 TURN 被限速）→ 该降", () => {
    const s = readSend(
      { bytes: 1_000, ts: 10_000, available: 800_000 },
      { bytes: 8_750, ts: 11_000, available: 800_000 },
    );
    expect(screenLinkStrained(s, CAP)).toBe(true);
    // 同一份读数：链路容量充足时就不该降——判据看的是容量，不是码率
    const ok = readSend(
      { bytes: 1_000, ts: 10_000, available: 20_000_000 },
      { bytes: 501_000, ts: 11_000, available: 20_000_000 },
    );
    expect(ok.kbps).toBe(4000); // 码率看着很健康
    expect(screenLinkStrained(ok, CAP)).toBe(false);
  });

  it("发送端自述受限（bandwidth / cpu）→ 该降，与容量读数无关", () => {
    const bw = readSend(
      { bytes: 1_000, ts: 10_000, available: 20_000_000, limitation: "bandwidth" },
      { bytes: 400_000, ts: 11_000, available: 20_000_000, limitation: "bandwidth" },
    );
    expect(screenLinkStrained(bw, CAP)).toBe(true);

    const cpu = summarizeScreenStats(
      sendStats({ bytes: 1_000, ts: 1_000, limitation: "cpu", available: 20_000_000 }),
      null,
    );
    expect(screenLinkStrained(cpu, CAP)).toBe(true);
  });

  it("浏览器不报可用带宽时宁可不动（不误降）", () => {
    const s = readSend(
      { bytes: 1_000, ts: 10_000 },
      { bytes: 3_000, ts: 11_000 },
    );
    expect(s.availableKbps).toBe(0);
    expect(screenLinkStrained(s, CAP)).toBe(false);
  });

  it("simulcast 多档发布不看容量（分层交给 SFU，源头降会连累观众）", () => {
    const s = readSend(
      { bytes: 1_000, ts: 10_000, available: 800_000 },
      { bytes: 8_750, ts: 11_000, available: 800_000 },
    );
    expect(screenLinkStrained(s, CAP, true)).toBe(false);
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

describe("H.264 profile 择优与编码重排（1.4.1）", () => {
  it("h264ProfileRank：High > Main > Baseline > 未知", () => {
    expect(h264ProfileRank("profile-level-id=640028")).toBe(3);
    expect(h264ProfileRank("profile-level-id=4d0032")).toBe(2);
    expect(h264ProfileRank("profile-level-id=42e01f")).toBe(1);
    expect(h264ProfileRank("packetization-mode=1")).toBe(0);
    expect(h264ProfileRank("")).toBe(0);
  });

  it("同一路 H.264 里把 High Profile 排到 Baseline 前面（硬编优先被选中）", () => {
    const sdp = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 98 99",
      "a=rtpmap:96 VP8/90000",
      "a=rtpmap:98 H264/90000",
      "a=fmtp:98 profile-level-id=42e01f;packetization-mode=1",
      "a=rtpmap:99 H264/90000",
      "a=fmtp:99 profile-level-id=640028;packetization-mode=1",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
    ].join("\r\n");
    const out = preferH264Sdp(sdp);
    // High（99）提到 Baseline（98）之前，VP8（96）垫后
    expect(out).toContain("m=video 9 UDP/TLS/RTP/SAVPF 99 98 96");
    // 音频段与 fmtp 行都不许被动
    expect(out).toContain("m=audio 9 UDP/TLS/RTP/SAVPF 111");
    expect(out).toContain("a=fmtp:99 profile-level-id=640028;packetization-mode=1");
    // 幂等
    expect(preferH264Sdp(out)).toBe(out);
  });

  it("preferCodecSdp('av1') 只把 AV1 提前（双端硬编通过时才用）", () => {
    const sdp = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
      "a=rtpmap:96 H264/90000",
      "a=rtpmap:97 AV1/90000",
    ].join("\r\n");
    expect(preferCodecSdp(sdp, "av1")).toContain("m=video 9 UDP/TLS/RTP/SAVPF 97 96");
  });
});

describe("injectStartBitrate（跳过开局爬坡）", () => {
  it("已有 fmtp 行 → 追加键；没有 fmtp 的编码 → 补一条", () => {
    const sdp = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 98",
      "a=rtpmap:96 VP8/90000",
      "a=rtpmap:98 H264/90000",
      "a=fmtp:98 profile-level-id=640028",
      "a=rtpmap:97 rtx/90000",
      "a=fmtp:97 apt=98",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
    ].join("\r\n");
    const out = injectStartBitrate(sdp, 6000);
    // H.264 的 fmtp 追加
    expect(out).toContain("a=fmtp:98 profile-level-id=640028;x-google-start-bitrate=6000");
    // VP8 原本没有 fmtp：在它 rtpmap 后面补一条
    expect(out).toContain("a=fmtp:96 x-google-start-bitrate=6000");
    // rtx 是辅助载荷，不许注入
    expect(out).not.toContain("a=fmtp:97 apt=98;x-google-start-bitrate");
    // 音频段完全不动
    expect(out).toContain("m=audio 9 UDP/TLS/RTP/SAVPF 111");
    expect(out).not.toContain("a=fmtp:111");
    // 幂等
    expect(injectStartBitrate(out, 6000)).toBe(out);
  });

  it("kbps 非法 / 没有 video 段时原样返回", () => {
    expect(injectStartBitrate("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96", 0)).toBe(
      "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96",
    );
    expect(injectStartBitrate("", 6000)).toBe("");
  });

  it("boostScreenOfferSdp：一次完成编码重排 + 起始码率", () => {
    const sdp = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 98",
      "a=rtpmap:96 VP8/90000",
      "a=rtpmap:98 H264/90000",
      "a=fmtp:98 profile-level-id=640028",
    ].join("\r\n");
    const out = boostScreenOfferSdp(sdp, { codec: "h264", startBitrateKbps: 4000 });
    expect(out).toContain("m=video 9 UDP/TLS/RTP/SAVPF 98 96");
    expect(out).toContain("x-google-start-bitrate=4000");
  });
});

describe("tuneLadder（降档顺序：帧率先让 vs 分辨率先让）", () => {
  it("auto：帧率先让到 30，再降分辨率，最后帧率让到 24", () => {
    expect(tuneLadder("auto", 60)).toEqual([
      { step: 0, fps: 60 },
      { step: 0, fps: 45 },
      { step: 0, fps: 30 },
      { step: 1, fps: 30 },
      { step: 2, fps: 30 },
      { step: 3, fps: 30 },
      { step: 3, fps: 24 },
    ]);
  });

  it("detail（清晰优先）：帧率一路让到 24 才开始降分辨率", () => {
    const ladder = tuneLadder("detail", 60);
    expect(ladder.slice(0, 4)).toEqual([
      { step: 0, fps: 60 },
      { step: 0, fps: 45 },
      { step: 0, fps: 30 },
      { step: 0, fps: 24 },
    ]);
    // 之后每一步才降分辨率，帧率保持最低
    expect(ladder[4]).toEqual({ step: 1, fps: 24 });
    expect(ladder[ladder.length - 1]).toEqual({ step: 3, fps: 24 });
  });

  it("motion（流畅优先）：先降分辨率保帧率，帧率最低只让到 30", () => {
    const ladder = tuneLadder("motion", 60);
    expect(ladder.slice(0, 4)).toEqual([
      { step: 0, fps: 60 },
      { step: 1, fps: 60 },
      { step: 2, fps: 60 },
      { step: 3, fps: 60 },
    ]);
    expect(ladder[ladder.length - 1]!.fps).toBeGreaterThanOrEqual(30);
    expect(ladder.every((point) => point.fps >= 30)).toBe(true);
  });

  it("档位上限低于阶梯时按上限收敛（例如 30 帧档位不会出现 45/24）", () => {
    const ladder = tuneLadder("auto", 30);
    expect(ladder[0]).toEqual({ step: 0, fps: 30 });
    expect(ladder.some((point) => point.fps > 30)).toBe(false);
  });

  it("相邻档位不重复（每一步都真的变了什么）", () => {
    for (const pref of ["auto", "detail", "motion"] as const) {
      const ladder = tuneLadder(pref, 60);
      for (let i = 1; i < ladder.length; i += 1) {
        expect(
          ladder[i]!.step !== ladder[i - 1]!.step || ladder[i]!.fps !== ladder[i - 1]!.fps,
        ).toBe(true);
      }
    }
  });
});

describe("nearestLadderIndex（切换偏好时不跳变）", () => {
  it("阶梯里有完全一致的档位就取它；没有就取观感最接近的", () => {
    const motion = tuneLadder("motion", 60);
    // 当前是"原始分辨率 60 帧"→ motion 阶梯里就是第 0 项
    expect(nearestLadderIndex(motion, { step: 0, fps: 60 })).toBe(0);
    // 380p30 在 motion 阶梯里正好存在（第 5 项）
    expect(nearestLadderIndex(motion, { step: 3, fps: 30 })).toBe(5);

    const auto = tuneLadder("auto", 60);
    // auto 阶梯里没有 380p60 这个组合：最接近的是"380p30"（第 5 项，档位一致优先）
    expect(nearestLadderIndex(auto, { step: 3, fps: 60 })).toBe(5);
  });
});

describe("simulcastLayerBitrates（分层码率：q 层不再被放大）", () => {
  it("1080p 档：8M / 2.48M / 800k（q 层封顶 800k）", () => {
    const tiers = simulcastLayerBitrates(8_000_000);
    expect(tiers.f).toBe(8_000_000);
    expect(tiers.h).toBe(2_480_000);
    expect(tiers.q).toBe(800_000);
  });

  it("720p 档按比例缩放，任何层都不会超过上一层", () => {
    const tiers = simulcastLayerBitrates(5_000_000);
    expect(tiers.f).toBe(5_000_000);
    expect(tiers.h).toBeLessThan(tiers.f);
    expect(tiers.q).toBeLessThan(tiers.h);
  });
});

describe("simulcastLayerLabel（观众看到的是哪一层）", () => {
  it("1080p 源：收到 1080 / 540 / 270 分别对应 f / h / q", () => {
    expect(simulcastLayerLabel(1080, 1080)).toContain("f");
    expect(simulcastLayerLabel(1080, 540)).toContain("h");
    expect(simulcastLayerLabel(1080, 270)).toContain("q");
  });

  it("比例对不上（被发送端降档过）时不猜，返回 null", () => {
    expect(simulcastLayerLabel(1080, 760)).toBeNull();
    expect(simulcastLayerLabel(0, 540)).toBeNull();
  });
});

describe("jitterBufferTargetFor（抖动缓冲自适应）", () => {
  it("拿不到抖动读数时取下限（画面更跟手）", () => {
    expect(jitterBufferTargetFor(0)).toBe(JITTER_ADAPTIVE_MS.min);
    expect(jitterBufferTargetFor(Number.NaN)).toBe(JITTER_ADAPTIVE_MS.min);
  });

  it("按 4 倍抖动取值，并夹在 150~1200ms 之间", () => {
    expect(jitterBufferTargetFor(0.01)).toBe(150); // 40ms → 下限
    expect(jitterBufferTargetFor(0.05)).toBe(200); // 50ms × 4
    expect(jitterBufferTargetFor(0.5)).toBe(1200); // 500ms × 4 → 上限
  });
});

describe("观众偏好聚合（多人共用一条轨时的取舍）", () => {
  /*
   * 2026-10-25 改口径：默认不再是 detail（detail 会被拥塞控制砍到 2fps）。
   * 现在：有人要流畅 → motion；**全员明确要清晰**才 detail；有「自动」就不设 hint。
   */
  it("只要有一位要流畅优先，整条轨就按 motion 走", () => {
    expect(screenHintFor(["detail", "motion"])).toBe("motion");
    expect(screenHintFor(["auto", "motion"])).toBe("motion");
  });

  it("全员明确要清晰才设 detail，混着「自动」就交给浏览器平衡", () => {
    expect(screenHintFor(["detail", "detail"])).toBe("detail");
    expect(screenHintFor(["auto", "detail"])).toBe("");
    expect(screenHintFor(["auto"])).toBe("");
  });

  it("没有观众（或没人表态）时不设 hint", () => {
    expect(screenHintFor([])).toBe("");
  });

  it("SFU 订阅层：清晰优先/自动取满档，流畅优先退半档", () => {
    expect(preferredRidFor("auto")).toBe("f");
    expect(preferredRidFor("detail")).toBe("f");
    expect(preferredRidFor("motion")).toBe("h");
  });
});

describe("simulcast 与硬件编码互斥（1.4.2 修）：有硬编就不开多档", () => {
  const probe = (h264: boolean, av1: boolean) => ({
    h264,
    av1,
    decH264: false,
    decAv1: false,
    checked: true,
  });

  it("有硬编 + 请求多档 → 拒绝多档（Chrome 会强制软编，实测画面糊到 353×254）", () => {
    expect(shouldUseSimulcast(true, probe(true, false))).toBe(false);
    expect(shouldUseSimulcast(true, probe(false, true))).toBe(false);
  });

  it("没有硬编 + 请求多档 → 保留多档（反正软编，多档至少让弱网观众拿小层）", () => {
    expect(shouldUseSimulcast(true, probe(false, false))).toBe(true);
  });

  it("没请求多档就永远单档", () => {
    expect(shouldUseSimulcast(false, probe(false, false))).toBe(false);
  });
});

describe("simulcastSubscribeConfig（订阅层配置）", () => {
  it("默认：满档 f + **锁层**（不许 SFU 按自己的带宽估计擅自降层）", () => {
    expect(simulcastSubscribeConfig({})).toEqual({
      preferredRid: "f",
      priorityOrdering: "none",
      ridNotAvailable: "asciibetical",
    });
  });

  it("观众主动选「流畅优先」时才放开自适应降层", () => {
    const config = simulcastSubscribeConfig({ preferredRid: "h", adaptive: true });
    expect(config.priorityOrdering).toBe("asciibetical");
    expect(config.preferredRid).toBe("h");
  });

  it("锁层不等于死等：发布端停掉该层时仍按 f→h→q 退层", () => {
    expect(simulcastSubscribeConfig({}).ridNotAvailable).toBe("asciibetical");
  });
});

describe("三分档读数（不再随机显示某一层）", () => {
  /** 造一条 simulcast 发送端 outbound-rtp。 */
  const layer = (rid: string, w: number, h: number, fps: number, bytes: number, ts: number) => ({
    id: `O-${rid}`,
    type: "outbound-rtp" as const,
    kind: "video",
    rid,
    frameWidth: w,
    frameHeight: h,
    framesPerSecond: fps,
    bytesSent: bytes,
    timestamp: ts,
    encoderImplementation: "SimulcastEncoderAdapter",
    powerEfficientEncoder: false,
  });

  it("代表条目取最高分辨率那层，码率是三档合计，并给出逐层读数", () => {
    const first = summarizeScreenStats(
      [
        layer("q", 353, 254, 53, 100_000, 10_000),
        layer("f", 1414, 1018, 53, 1_000_000, 10_000),
        layer("h", 707, 509, 53, 400_000, 10_000),
      ],
      null,
    );
    // 第一次采样：主层 = 1414×1018（而不是报告里排第一的 q 层）
    expect(first.width).toBe(1414);
    expect(first.text).toContain("1414×1018（主层）");
    expect(first.text).toContain("三层合计");
    expect(first.layers.map((item) => item.rid)).toEqual(["f", "h", "q"]);

    const second = summarizeScreenStats(
      [
        layer("q", 353, 254, 53, 200_000, 11_000),
        layer("f", 1414, 1018, 53, 2_000_000, 11_000),
        layer("h", 707, 509, 53, 800_000, 11_000),
      ],
      first.sample,
    );
    // 三档合计：(1500_000 - 1500_000)... 增量 100k+1M+400k = 1.5 MB*8/1000ms = 12000 kbps
    expect(second.kbps).toBe(12000);
    // 逐层：f 8000k、h 3200k、q 800k
    const byRid = new Map(second.layers.map((item) => [item.rid, item.kbps]));
    expect(byRid.get("f")).toBe(8000);
    expect(byRid.get("h")).toBe(3200);
    expect(byRid.get("q")).toBe(800);
  });

  it("单档保持原行为（layers 为空、文本不含「主层」）", () => {
    // 真实单档发布没有 rid（Chrome 只在 simulcast 编码上带 rid）
    const single = summarizeScreenStats(
      [{ ...layer("f", 1920, 1080, 60, 500_000, 1_000), rid: undefined }],
      null,
    );
    expect(single.layers).toEqual([]);
    expect(single.text).not.toContain("主层");
    expect(single.text).toContain("1920×1080");
    expect(formatScreenLayers(single.layers)).toBe("");
  });

  it("formatScreenLayers 只对多档出文本", () => {
    const summary = summarizeScreenStats(
      [layer("q", 353, 254, 30, 10_000, 1_000), layer("f", 1414, 1018, 60, 90_000, 1_000)],
      null,
    );
    const text = formatScreenLayers(summary.layers);
    expect(text).toContain("f 1414×1018");
    expect(text).toContain("q 353×254");
    expect(text).toContain("@30");
  });
});

describe("共享声音电平探针的准入（后进房的人白屏回归）", () => {
  const makeStream = (audioTracks: number) =>
    ({ getAudioTracks: () => Array.from({ length: audioTracks }) }) as unknown as MediaStream;

  it("没有音轨的流（后进者拿到的视频流）绝不能接探针", () => {
    expect(canProbeShareAudio(null)).toBe(false);
    expect(canProbeShareAudio(undefined)).toBe(false);
    expect(canProbeShareAudio(makeStream(0))).toBe(false); // 后进者的视频流：没有音轨
    expect(canProbeShareAudio(makeStream(1))).toBe(true);
    expect(canProbeShareAudio(makeStream(2))).toBe(true);
  });
});
