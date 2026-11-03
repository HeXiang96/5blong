import { describe, it, expect } from "vitest";
import { MediaLink, type RtcSignal } from "../src/client/voice/media-link";

/**
 * 自建媒体协商的核心是"消息怎么走、超时怎么办、重复/迟到怎么容错"，
 * 这些都和真实 WebRTC 无关，所以用一个最小的假 PC 就能完整覆盖。
 */
class FakePc {
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  connectionState = "new";
  iceConnectionState = "new";
  onicecandidate: ((e: { candidate: null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: { streams: MediaStream[]; track: unknown }) => void) | null = null;
  closed = false;
  tracks: unknown[] = [];
  transceivers = 0;

  addTrack(track: unknown): void {
    this.tracks.push(track);
  }
  addTransceiver(): void {
    this.transceivers += 1;
  }
  async createOffer() {
    return { type: "offer", sdp: "OFFER" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "ANSWER" };
  }
  async setLocalDescription(desc: { type: string; sdp: string }) {
    this.localDescription = desc;
  }
  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc;
  }
  async addIceCandidate(): Promise<void> {
    /* 记录与否不影响断言 */
  }
  close(): void {
    this.closed = true;
  }
  /** 测试用：模拟 ICE 连通 */
  becomeConnected(): void {
    this.connectionState = "connected";
    this.iceConnectionState = "connected";
    this.onconnectionstatechange?.();
  }
}

const makePipe = () => {
  const sent: RtcSignal[] = [];
  return { sent, send: (msg: RtcSignal) => sent.push(msg) };
};

const stream = { getTracks: () => [{ id: "t1" }] } as unknown as MediaStream;

/** 等异步链跑完（createOffer / setLocalDescription 都是 microtask） */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("自建媒体协商（SDP/ICE 走数据通道）", () => {
  it("发起方：发出 offer，收到 answer 后设远端描述", async () => {
    const pcs: FakePc[] = [];
    const pipe = makePipe();
    const link = new MediaLink({
      role: "offer",
      pipe,
      stream,
      iceServers: () => [],
      createPc: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
      sdpTransform: (sdp) => `${sdp}+x`,
      answerTimeoutMs: 10_000,
    });

    await link.start();
    const offer = pipe.sent.find((m) => m.t === "rtc-offer");
    expect(offer).toBeTruthy();
    expect((offer as { sdp: string }).sdp).toBe("OFFER+x");

    await link.handle({ t: "rtc-answer", sdp: "ANSWER" });
    expect(pcs[0]!.remoteDescription).toEqual({ type: "answer", sdp: "ANSWER" });
  });

  it("应答方：收到 offer 就回 answer（带 SDP 整形）", async () => {
    const pcs: FakePc[] = [];
    const pipe = makePipe();
    const link = new MediaLink({
      role: "answer",
      pipe,
      stream: null,
      iceServers: () => [],
      createPc: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
      sdpTransform: (sdp) => `${sdp}+x`,
    });

    await link.handle({ t: "rtc-offer", sdp: "OFFER" });
    expect(pcs[0]!.remoteDescription).toEqual({ type: "offer", sdp: "OFFER" });
    const answer = pipe.sent.find((m) => m.t === "rtc-answer");
    expect(answer).toBeTruthy();
    expect((answer as { sdp: string }).sdp).toBe("ANSWER+x");
  });

  it("收不到 answer 时会重发 offer，超过次数才判失败", async () => {
    const pcs: FakePc[] = [];
    const pipe = makePipe();
    const states: string[] = [];
    const link = new MediaLink({
      role: "offer",
      pipe,
      stream,
      iceServers: () => [],
      createPc: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
      answerTimeoutMs: 8,
      maxRetries: 1,
      onState: (s) => states.push(s),
    });

    await link.start();
    expect(pipe.sent.filter((m) => m.t === "rtc-offer")).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 12)); // 第一次超时 → 重发
    await flush();
    expect(pipe.sent.filter((m) => m.t === "rtc-offer")).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 12)); // 第二次超时 → 失败
    expect(states).toContain("failed");
  });

  it("远端描述没设之前收到的候选会先缓存，不报错", async () => {
    const pcs: FakePc[] = [];
    const pipe = makePipe();
    const link = new MediaLink({
      role: "offer",
      pipe,
      stream,
      iceServers: () => [],
      createPc: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
      answerTimeoutMs: 10_000,
    });

    await link.start();
    // 还没收到 answer（remoteDescription 为空）时来一个候选
    await expect(
      link.handle({ t: "rtc-ice", cand: { candidate: "candidate:1", sdpMid: "0" } }),
    ).resolves.toBeUndefined();
    expect(pcs[0]!.remoteDescription).toBeNull();

    // 收到 answer 后应把缓存的候选灌进去，且不抛错
    await link.handle({ t: "rtc-answer", sdp: "ANSWER" });
    expect(pcs[0]!.remoteDescription).toEqual({ type: "answer", sdp: "ANSWER" });
  });

  it("收到 rtc-bye 立刻关闭，不再发 offer", async () => {
    const pipe = makePipe();
    const states: string[] = [];
    const link = new MediaLink({
      role: "offer",
      pipe,
      stream,
      iceServers: () => [],
      createPc: () => new FakePc() as unknown as RTCPeerConnection,
      answerTimeoutMs: 50,
      onState: (s) => states.push(s),
    });

    await link.start();
    await link.handle({ t: "rtc-bye" });
    expect(states).toContain("closed");
    expect(link.currentState).toBe("closed");
  });

  it("没麦克风时声明 recvonly，仍然建立音频链路", async () => {
    const pcs: FakePc[] = [];
    const link = new MediaLink({
      role: "answer",
      pipe: makePipe(),
      stream: null,
      iceServers: () => [],
      createPc: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    await link.handle({ t: "rtc-offer", sdp: "OFFER" });
    expect(pcs[0]!.tracks).toHaveLength(0);
    expect(pcs[0]!.transceivers).toBe(1);
  });

  it("ICE 连通后状态变成 connected（引擎据此更新界面与后台）", async () => {
    const pcs: FakePc[] = [];
    const states: string[] = [];
    const link = new MediaLink({
      role: "offer",
      pipe: makePipe(),
      stream,
      iceServers: () => [],
      createPc: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
      answerTimeoutMs: 10_000,
      onState: (s) => states.push(s),
    });
    await link.start();
    pcs[0]!.becomeConnected();
    expect(states).toContain("connected");
  });
});
