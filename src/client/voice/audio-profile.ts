import type { MediaConnection } from "peerjs";

/**
 * 音频发送参数（对齐 Piik 的媒体质量契约）。
 *
 * 背景（2026-10-21 研读 Piik 后确定）：
 * - 我们此前完全不设码率与 Opus 参数，全交给浏览器默认：语音默认可能带 DTX，
 *   静音段停发、恢复时"起音"配合 AI 降噪会被听成发虚/空灵；
 * - 共享音频走默认多为单声道，人声与音乐都失真。
 *
 * 这里把两端都显式化：
 * - 语音：单声道、关 DTX、**64kbps**（业主 2026-10-28 口径：默认就要高音质，P2P 也一样）；
 * - 共享声音：立体声、关 DTX、128kbps（音乐/游戏声够用）。
 *
 * ⚠️ `maxaveragebitrate` 与 setParameters 的 `maxBitrate` 都是**上限**，不是固定值：
 * 链路不够时 WebRTC 的拥塞控制会自己往下压，所以"默认高音质"不会在弱网上硬扛。
 * 但 P2P 模式下每人都要给 N-1 个人各编一路，13 人时 12 路 × 64k ≈ 0.77 Mbps 上行，
 * 手机热点这种上行很窄的网络会各降各的——这是预期行为，不是 bug。
 */
export const VOICE_AUDIO_BITRATE = 64_000;
export const SCREEN_AUDIO_BITRATE = 128_000;

export type AudioProfile = "voice" | "music";

/** 按用途生成 SDP 改写：只动 Opus 那一行 fmtp，绝不碰视频。 */
export function opusSdpTransform(profile: AudioProfile) {
  /*
   * `useinbandfec=1` 显式写上：Chrome 默认发的 fmtp 本来就带它，
   * 但少数实现不给 fmtp 行（走下面"补一条"的分支），那种情况下会漏掉 FEC。
   * 丢包 5% 的房间里，它是"偶尔卡一下"和"基本听不出来"的分界。
   */
  const extra =
    profile === "music"
      ? ";stereo=1;sprop-stereo=1;usedtx=0;useinbandfec=1;maxaveragebitrate=128000"
      : ";stereo=0;sprop-stereo=0;usedtx=0;useinbandfec=1;maxaveragebitrate=64000";

  return (sdp: string): string => {
    // 先确认对端用了 Opus，并拿到它的 payload type
    const rtpmap = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!rtpmap) return sdp;
    const pt = rtpmap[1];
    const fmtpRe = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);

    if (fmtpRe.test(sdp)) {
      return sdp.replace(fmtpRe, (_line, params: string) => {
        // 去掉旧的同名参数，再追加我们的（避免出现两份 stereo/usedtx）
        const cleaned = params
          // sprop-stereo 必须排在 stereo 前面：否则 "stereo" 会先匹配到
          // "sprop-stereo" 的后半截，留下一个坏掉的 "sprop-" 前缀
          .replace(/;?(sprop-stereo|stereo|usedtx|useinbandfec|maxaveragebitrate)=[^;]*/gi, "")
          .replace(/;;+/g, ";")
          .replace(/;+$/, "");
        return `a=fmtp:${pt} ${cleaned}${extra}`;
      });
    }

    // 少数实现不给 fmtp 行：在 rtpmap 后补一条
    const line = `a=rtpmap:${pt} opus/48000/2`;
    return sdp.replace(line, `${line}\r\na=fmtp:${pt} ${extra.slice(1)}`);
  };
}

/**
 * 把码率上限与 contentHint 落到实际的发送端。
 *
 * SDP 里的 maxaveragebitrate 只是"期望值"，setParameters 的 maxBitrate 才是硬上限；
 * 两者一起设，弱网时不会被协商抬回去。
 */
export async function applyAudioProfile(
  pc: RTCPeerConnection | undefined,
  profile: AudioProfile,
): Promise<void> {
  if (!pc) return;
  const bitrate = profile === "music" ? SCREEN_AUDIO_BITRATE : VOICE_AUDIO_BITRATE;
  for (const sender of pc.getSenders()) {
    const track = sender.track;
    if (!track || track.kind !== "audio") continue;
    try {
      // contentHint 提示编码器：music 会启用立体声相关路径，voice 走语音优化
      track.contentHint = profile === "music" ? "music" : "speech";
    } catch {
      /* 个别实现不支持，忽略 */
    }
    try {
      const params = sender.getParameters() as RTCRtpSendParameters;
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings = params.encodings.map((encoding) => ({
        ...encoding,
        maxBitrate: bitrate,
      }));
      await sender.setParameters(params);
    } catch {
      /* 某些实现要等协商完成才能改，下一轮 watch 会再试 */
    }
  }
}

/** 从 PeerJS 的 MediaConnection 上取底层 pc（PeerJS 未公开，只能这样拿）。 */
export function peerConnectionOf(call: MediaConnection): RTCPeerConnection | undefined {
  return (call as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
}
