import { describe, expect, it } from "vitest";
import { opusSdpTransform, SCREEN_AUDIO_BITRATE, VOICE_AUDIO_BITRATE } from "../src/client/voice/audio-profile";

const SDP = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=rtpmap:96 VP8/90000",
  "a=fmtp:96 max-fs=12288;max-fr=60",
].join("\r\n");

describe("opusSdpTransform", () => {
  it("语音：关 DTX、单声道、40k", () => {
    const out = opusSdpTransform("voice")(SDP);
    expect(out).toContain("usedtx=0");
    expect(out).toContain("stereo=0");
    expect(out).toContain(`maxaveragebitrate=${VOICE_AUDIO_BITRATE}`);
    expect(out).toContain("useinbandfec=1"); // 原有参数保留
  });

  it("共享声音：立体声、关 DTX、128k", () => {
    const out = opusSdpTransform("music")(SDP);
    expect(out).toContain("stereo=1");
    expect(out).toContain("sprop-stereo=1");
    expect(out).toContain(`maxaveragebitrate=${SCREEN_AUDIO_BITRATE}`);
  });

  it("不会碰视频的 fmtp", () => {
    const out = opusSdpTransform("voice")(SDP);
    expect(out).toContain("a=fmtp:96 max-fs=12288;max-fr=60");
  });

  it("重复应用不会叠加参数", () => {
    const once = opusSdpTransform("music")(SDP);
    const twice = opusSdpTransform("music")(once);
    // 注意：sprop-stereo=1 里也含 "stereo=1"，所以要连前面的分号一起匹配
    expect(twice.match(/;stereo=1(;|\r|$)/g)?.length).toBe(1);
    expect(twice.match(/;usedtx=0(;|\r|$)/g)?.length).toBe(1);
  });

  it("没有 Opus 时原样返回", () => {
    const pcm = ["v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 0", "a=rtpmap:0 PCMU/8000"].join("\r\n");
    expect(opusSdpTransform("voice")(pcm)).toBe(pcm);
  });
});
