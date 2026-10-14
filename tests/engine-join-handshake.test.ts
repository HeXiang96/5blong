/**
 * VoiceMesh 引擎级握手测试。
 *
 * 覆盖：
 * 1. 持完整邀请链接（roomKey）的访客自动握手 + 媒体建立；
 * 2. 只输房间码（无 roomKey、空证明）的访客同样放行；
 * 3. 非空但错误的证明（伪造）被拒；
 * 4. joined 之前 ping 不回、joined 之后 ping 回 pong（守卫顺序 catch-22 回归）；
 * 5. welcome 超时后自动整体重拨（新 Peer + 新访客 ID）并成功；
 * 6. 房主不在线（信令回 peer-unavailable）时立刻报错，不空等 12s×3。
 *
 * PeerJS 与浏览器能力全部打桩：peerjs 模块被 vi.mock 替换，
 * AudioContext / AudioWorkletNode / navigator / document 在导入前
 * （vi.hoisted）就挂好——RNNoise 包在模块求值时就 `extends AudioWorkletNode`。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------- 浏览器环境打桩
vi.hoisted(() => {
  function setup() {
    const passiveNode = () => ({ connect() {}, disconnect() {} });
    class FakeAudioContext {
      state = "running" as const;
      audioWorklet = { addModule: async () => {} };
      createMediaStreamSource() {
        return passiveNode();
      }
      createGain() {
        return { ...passiveNode(), gain: { value: 1 } };
      }
      createMediaStreamDestination() {
        return { stream: { getTracks: () => [], getAudioTracks: () => [] } };
      }
      createAnalyser() {
        return {
          ...passiveNode(),
          fftSize: 256,
          frequencyBinCount: 8,
          getByteFrequencyData(a: Uint8Array) {
            a.fill(0);
          },
        };
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    class FakeWorkletNode {
      connect() {}
      disconnect() {}
    }
    const makeAudio = () => {
      const el: any = {
        play: async () => {},
        pause: () => {},
        remove: () => {},
        dataset: {},
        style: {},
      };
      Object.defineProperty(el, "srcObject", { value: null, writable: true });
      return el;
    };
    (globalThis as any).AudioContext = FakeAudioContext;
    (globalThis as any).webkitAudioContext = FakeAudioContext;
    (globalThis as any).AudioWorkletNode = FakeWorkletNode;
    (globalThis as any).window = globalThis;
    (globalThis as any).document = {
      createElement: () => makeAudio(),
      documentElement: { dataset: {} },
      body: { appendChild: () => {} },
    };
    const track = () => ({
      enabled: true,
      addEventListener: () => {},
      stop: () => {},
    });
    const makeStream = () => ({
      getAudioTracks: () => [track()],
      getTracks: () => [track()],
    });
    Object.defineProperty(globalThis, "navigator", {
      value: {
        mediaDevices: {
          getUserMedia: async () => makeStream(),
          enumerateDevices: async () => [],
          addEventListener: () => {},
          removeEventListener: () => {},
        },
      },
      configurable: true,
      writable: true,
    });
    (globalThis as any).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
  }
  setup(); // 必须在 import 求值前完成（hoisted 回调保证）
});

// ---------------------------------------------------------- PeerJS 打桩
const mocks = vi.hoisted(() => {
  class Emitter {
    _ls: Record<string, Function[]> = {};
    on(ev: string, fn: Function): this {
      (this._ls[ev] ??= []).push(fn);
      return this;
    }
    emit(ev: string, ...args: any[]): boolean {
      (this._ls[ev] ?? []).slice().forEach((f) => f(...args));
      return true;
    }
    removeAllListeners(): this {
      this._ls = {};
      return this;
    }
  }

  const fakeRemoteStream = () => ({ getTracks: () => [], getAudioTracks: () => [] });

  class FakeConn extends Emitter {
    peer: string;
    label = "peerjs";
    connectionId: string;
    sent: any[] = [];
    open = false;
    constructor(peer: string) {
      super();
      this.peer = peer;
      this.connectionId = "dc" + Math.random().toString(36).slice(2, 10);
    }
    send(m: any): void {
      this.sent.push(m);
    }
    close(): void {
      this.emit("close");
    }
  }

  class FakeCall extends Emitter {
    peer: string;
    answered: any = null;
    constructor(peer: string) {
      super();
      this.peer = peer;
    }
    answer(stream?: any): void {
      this.answered = stream ?? null;
      const s = fakeRemoteStream();
      queueMicrotask(() => this.emit("stream", s));
    }
    close(): void {
      this.emit("close");
    }
  }

  const peers: FakePeer[] = [];
  let connectCalls = 0;
  let stallFirst = false;

  class FakePeer extends Emitter {
    id: string;
    opts: any;
    constructor(id: string, opts: any) {
      super();
      this.id = id;
      this.opts = opts;
      peers.push(this);
      queueMicrotask(() => this.emit("open"));
    }
    connect(dst: string): FakeConn {
      connectCalls += 1;
      const mine = new FakeConn(dst);
      const target = peers.find((p) => p.id === dst);
      // 模拟信令黑洞：第一次 connect 永不建立
      if (stallFirst && connectCalls === 1) return mine;
      if (!target) {
        // 与 peerjs 1.5.5 一致：错误消息里带目标 ID（引擎据此判断"是不是房主"）
        queueMicrotask(() =>
          this.emit("error", {
            type: "peer-unavailable",
            message: `Could not connect to peer ${dst}`,
          }),
        );
        return mine;
      }
      const theirs = new FakeConn(this.id);
      mine.send = (m) => queueMicrotask(() => theirs.emit("data", m));
      theirs.send = (m) => queueMicrotask(() => mine.emit("data", m));
      mine.close = () => queueMicrotask(() => theirs.emit("close"));
      theirs.close = () => queueMicrotask(() => mine.emit("close"));
      queueMicrotask(() => {
        target.emit("connection", theirs);
        // 真实 DataConnection 两端都会触发 open 并把 open 置 true（引擎 send 依赖它）
        theirs.open = true;
        theirs.emit("open");
        mine.open = true;
        mine.emit("open");
      });
      return mine;
    }
    call(dst: string): FakeCall {
      const mine = new FakeCall(dst);
      const target = peers.find((p) => p.id === dst);
      if (!target) {
        queueMicrotask(() =>
          this.emit("error", {
            type: "peer-unavailable",
            message: `Could not connect to peer ${dst}`,
          }),
        );
        return mine;
      }
      const theirs = new FakeCall(this.id);
      theirs.answer = (s?: any) => {
        theirs.answered = s ?? null;
        const s1 = fakeRemoteStream();
        const s2 = fakeRemoteStream();
        queueMicrotask(() => {
          mine.emit("stream", s1);
          theirs.emit("stream", s2);
        });
      };
      queueMicrotask(() => target.emit("call", theirs));
      return mine;
    }
    reconnect(): void {
      /* noop */
    }
    destroy(): void {
      this.removeAllListeners();
    }
  }

  return {
    FakeConn,
    FakePeer,
    peers,
    reset() {
      peers.length = 0;
      connectCalls = 0;
      stallFirst = false;
    },
    setStall(v: boolean) {
      stallFirst = v;
      connectCalls = 0;
    },
  };
});

vi.mock("peerjs", () => ({ Peer: mocks.FakePeer }));
// 把 welcome 超时缩短到 250ms，专为重拨测试；正常握手远快于此。
vi.mock("../src/client/voice/protocol", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, WELCOME_TIMEOUT_MS: 250 };
});

// ---------------------------------------------------------- 被测模块
import { VoiceMesh } from "../src/client/voice/engine";
import { defaultSettings } from "../src/client/voice/settings";
import type { Identity } from "../src/client/voice/identity";

const identity: Identity = {
  personId: "1234567890",
  name: "测试小猪",
  avatar: "",
  color: "#88aaff",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEvents() {
  const statuses: Array<{ status: string; detail?: string }> = [];
  const membersSnapshots: any[][] = [];
  return {
    statuses,
    membersSnapshots,
    events: {
      status: (status: string, detail?: string) => statuses.push({ status, detail }),
      members: (members: any[]) => membersSnapshots.push(members),
      speaking: () => {},
      chat: () => {},
      ended: () => {},
      ready: (_v?: any) => {},
      pen: () => {},
      roomFlags: () => {},
      interact: () => {},
      sound: () => {},
      playbackBlocked: () => {},
      rosterChange: () => {},
      mediaState: (_peerId?: string, _state?: string) => {},
    },
  };
}

const lastStatus = (holder: ReturnType<typeof makeEvents>) =>
  holder.statuses[holder.statuses.length - 1]?.status;
const lastMembers = (holder: ReturnType<typeof makeEvents>) =>
  holder.membersSnapshots[holder.membersSnapshots.length - 1];

let engines: VoiceMesh[] = [];

beforeEach(() => {
  mocks.reset();
  engines = [];
});
afterEach(() => {
  for (const engine of engines) engine.destroy();
});

const startHost = async (): Promise<{ host: VoiceMesh; holder: any; invite: any }> => {
  const holder = makeEvents();
  const host = new VoiceMesh(holder.events as any);
  engines.push(host);
  let invite: any = null;
  holder.events.ready = (v: any) => {
    invite = v;
  };
  await host.host(identity, defaultSettings(), false);
  return { host, holder, invite };
};

const startGuest = async (target: {
  code: string;
  hostId: string;
  roomKey: string;
}): Promise<{ guest: VoiceMesh; holder: any }> => {
  const holder = makeEvents();
  const guest = new VoiceMesh(holder.events as any);
  engines.push(guest);
  await guest.join(target, identity, defaultSettings(), false);
  return { guest, holder };
};

describe("VoiceMesh 加入握手", () => {
  it("持完整邀请链接（roomKey）的访客能自动握手并建立媒体", async () => {
    const { holder: hostHolder, invite } = await startHost();
    expect(invite.code).toHaveLength(4);

    const { holder: guestHolder } = await startGuest({
      code: invite.code,
      hostId: invite.hostId,
      roomKey: invite.roomKey,
    });

    await sleep(30);
    expect(lastStatus(guestHolder)).toBe("connected");
    expect(lastMembers(hostHolder)).toHaveLength(2);
    expect(lastMembers(guestHolder)).toHaveLength(2);
  });

  it("只输房间码（空证明）的访客同样能进", async () => {
    const { invite } = await startHost();
    // 裸码：hostId 由房间码推导、roomKey 为空
    const { holder: guestHolder } = await startGuest({
      code: invite.code,
      hostId: "",
      roomKey: "",
    });

    await sleep(30);
    expect(lastStatus(guestHolder)).toBe("connected");
    expect(lastMembers(guestHolder)).toHaveLength(2);
  });

  it("非空但错误的证明被房主拒绝", async () => {
    const { host, holder: hostHolder } = await startHost();
    // 手动构造一条持错误证明的 hello（host 已生成 roomKey，proof 伪造）
    const conn = new mocks.FakeConn("5b-g-forged1");
    const hostPeer = mocks.peers.find((p) => p.id === hostPeerIdForCodePublic(inviteCode(host)));
    hostPeer!.emit("connection", conn);
    conn.open = true;
    conn.emit("open");
    conn.emit("data", {
      t: "hello",
      personId: "111",
      sessionId: "s1",
      name: "伪造者",
      avatar: "",
      color: "#fff",
      hasMic: true,
      nonce: "nonce-x",
      proof: "forged-proof",
    });
    await sleep(10);

    const reject = conn.sent.find((m) => m.t === "reject");
    expect(reject).toBeTruthy();
    expect(reject.reason).toBe("bad-key");
    // 被拒者不进名册
    expect(lastMembers(hostHolder)).toHaveLength(1);
  });

  it("joined 之前 ping 不回，joined 之后 ping 回 pong", async () => {
    const { host } = await startHost();
    const code = inviteCode(host);
    const conn = new mocks.FakeConn("5b-g-manual1");
    const hostPeer = mocks.peers.find((p) => p.id === hostPeerIdForCodePublic(code))!;
    hostPeer.emit("connection", conn);
    conn.open = true;
    conn.emit("open");
    conn.emit("data", {
      t: "hello",
      personId: "222",
      sessionId: "s2",
      name: "手动猪",
      avatar: "",
      color: "#eee",
      hasMic: true,
      nonce: "n2",
      proof: "", // 裸码
    });
    await sleep(5);
    expect(conn.sent.some((m) => m.t === "welcome")).toBe(true);

    // joined 前发 ping：守卫丢弃，无 pong
    conn.emit("data", { t: "ping", ts: 1 });
    await sleep(5);
    expect(conn.sent.some((m) => m.t === "pong")).toBe(false);

    // 完成 joined
    conn.emit("data", { t: "joined" });
    await sleep(5);
    conn.emit("data", { t: "ping", ts: 2 });
    await sleep(5);
    const pongs = conn.sent.filter((m) => m.t === "pong");
    expect(pongs).toHaveLength(1);
    expect(pongs[0].ts).toBe(2);
  });

  it("welcome 超时后自动整体重拨并成功", async () => {
    const { holder: hostHolder, invite } = await startHost();
    mocks.setStall(true); // 访客第一次连接石沉大海

    const holder = makeEvents();
    const guest = new VoiceMesh(holder.events as any);
    engines.push(guest);
    await guest.join(
      { code: invite.code, hostId: invite.hostId, roomKey: invite.roomKey },
      identity,
      defaultSettings(),
      false,
    );

    // 250ms 首次超时 → 重拨 → 握手完成；留足时间
    await sleep(450);
    expect(lastStatus(holder)).toBe("connected");
    expect(lastMembers(hostHolder)).toHaveLength(2);
    // 访客侧先后建了两个 Peer
    const guestPeers = mocks.peers.filter((p) =>
      p.id.startsWith("5b-g-"),
    );
    expect(guestPeers.length).toBe(2);
  });

  it("房主不在线（信令回 peer-unavailable）→ 立刻把原因说清楚，不空等超时", async () => {
    // 没有任何房主注册过这个码：peer.connect 会立刻收到 peer-unavailable。
    const holder = makeEvents();
    const guest = new VoiceMesh(holder.events as any);
    engines.push(guest);
    const startedAt = Date.now();
    await guest.join(
      { code: "9999", hostId: "", roomKey: "" },
      identity,
      defaultSettings(),
      false,
    );
    await sleep(60);

    // 这条断言是本次修复的核心：以前 peer-unavailable 被 openPeer 的 settled
    // 守卫吞掉，只能等 12s×3 才知道"房主不在线"（表现为长时间无任何提示）。
    expect(lastStatus(holder)).toBe("error");
    expect(holder.statuses.at(-1)?.detail).toContain("房主不在线");

    // 重拨仍然要做满 3 次（换 ID 可能换到更通的后端），但每次都是毫秒级：
    // 远快于「250ms 超时 × 3」的旧路径。
    const guestPeers = mocks.peers.filter((p) => p.id.startsWith("5b-g-"));
    expect(guestPeers).toHaveLength(3);
    expect(Date.now() - startedAt).toBeLessThan(200);
  });
});

// 测试辅助：引擎未公开 code/hostId，用 ready 事件之外的途径取——
// startHost 已捕获 invite；以下两个函数供手动构造场景按当前房主 Peer 定位。
function inviteCode(host: VoiceMesh): string {
  return (host as any).code as string;
}
function hostPeerIdForCodePublic(code: string): string {
  return "5b-h-" + code;
}
