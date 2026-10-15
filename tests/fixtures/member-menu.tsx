/** 本地浏览器回归场景：真实 RoomView + 模拟成员，不连接信令也不采集麦克风。 */
import { StrictMode, useEffect, useRef, useState, type ComponentProps } from "react";

import { setLatestPenPoses } from "../../src/client/voice/pen-follow";
import { createRoot } from "react-dom/client";
import { RoomView } from "../../src/client/voice/components/RoomView";
import type { InteractKind } from "../../src/client/voice/protocol";
import "../../src/client/voice/styles.css";
import "../../src/client/voice/pen-scene.css";
import "../../src/client/voice/pen-life.css";
import "../../src/client/voice/pen-fence.css";
import "../../src/client/voice/pen-tv.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const events: { kind: string; args: unknown[] }[] = [];
Object.assign(window, { menuTestEvents: events });
const record = (kind: string, ...args: unknown[]) => { events.push({ kind, args }); };

function Fixture() {
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const host = params.get("host") !== "0";
  /*
   * ?pen=feed / ?pen=pat：注入一次 DDY 应召事件（投喂 / 摸一摸），
   * 供浏览器回归目检 DDY 走位、蔬菜落点与抚摸动画。
   */
  const penSeed = params.get("pen");
  const seedTs = Date.now();
  const penEvents: ComponentProps<typeof RoomView>["penEvents"] =
    penSeed === "feed"
      ? [
          {
            event: { kind: "toss", id: "fixture-toss", ts: seedTs - 1500, npc: "DDY", veg: { kind: "carrot", x: 0.45, lane: 0.5 } },
            expiresAt: seedTs + 40000,
          },
          {
            // 让目标猪进入"跑向食物"阶段（approach 持续 5s），目检快跑猪
            event: { kind: "eat", id: "fixture-eat", ts: seedTs - 500, actor: "guest", veg: "carrot" },
            expiresAt: seedTs + 12000,
          },
        ]
        : [];
  const interactions: ComponentProps<typeof RoomView>["interactions"] = (() => {
    // ?react=<kind>：注入一次互动事件，目检对应反应动画（?pen=pat 保留兼容）
    const kind = (params.get("react") ?? (penSeed === "pat" ? "pat" : null)) as InteractKind | null;
    if (!kind) return [];
    return [{ key: 1, event: { from: "self", to: "guest", kind, ts: seedTs - 600 } }];
  })();
  /*
   * ?poses=1&host=0：喂一组"房主权威位置"（走真实数据通道：pen-follow
   * store），目检访客端跟随模式——guest 猪应钉在 x=0.82、lane=0.15
   * 的固定点附近，而不是本地乱走。
   */
  const poseDemo = params.get("poses") === "1";
  useEffect(() => {
    if (!poseDemo) return;
    const timer = window.setInterval(() => {
      setLatestPenPoses([{ id: "guest", x: 0.82, lane: 0.15 }]);
    }, 50);
    return () => window.clearInterval(timer);
  }, [poseDemo]);
  /*
   * 猪位上报的迷你实现：把 PigActor 报的位置存下来，
   * getPenPosition/Lane/Facing 再读出去——与正式接线一致，
   * 这样"那一坨落在屁股后面"这类定位逻辑在夹具里也能目检。
   */
  const poseStore = useRef<Record<string, { x: number; lane: number }>>({});
  const reportPen = (id: string, x: number, lane: number) => {
    poseStore.current[id] = { x, lane };
  };
  const props: ComponentProps<typeof RoomView> = {
    status: "connected",
    members: [
      { id: "self", personId: "1000000001", sessionId: "local", name: "本机房主", avatar: "", color: "#f2704f", muted: false, hasMic: true, isHost: host, local: true },
      { id: "guest", personId: "1000000002", sessionId: "guest", name: "测试成员", avatar: "", color: "#e05f8a", muted: false, hasMic: true, isHost: !host, local: false, serverMuted: params.get("muted") === "1" },
    ],
    speaking: params.get("speak") ? ["guest"] : [], messages: [], invite: { code: "123456", hostId: "self", roomKey: "fixture" }, notice: null,
    chatOpen, unread: 0, displayNames: new Map(), isHost: host, maxMembers: 8,
    onCopyCode: () => record("copy-code"), onCopyInvite: async () => { record("copy-invite"); return true; },
    onToggleMute: () => record("mic-toggle"), onToggleChat: () => setChatOpen((value) => !value),
    onLeave: () => record("leave"), onSettings: () => record("settings"), onSend: (text) => record("send", text),
    onDismissNotice: () => {}, onOpenFeedback: () => {}, micVolume: volume,
    onSetMicVolume: (value) => { record("mic-volume", value); setVolume(value); },
    onSetPeerVolume: (...args) => record("peer-volume", ...args),
    onTogglePeerMuted: (peer) => { record("peer-mute", peer); setMuted(!muted); return !muted; },
    onGetPeerAudio: () => ({ volume: 1, muted }),
    processing: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
    captureLive: { echoCancellation: true, autoGainControl: true },
    onSetNoiseSuppression: (value) => record("noise", value), onSetProcessingFlag: (...args) => record("processing", ...args),
    penEvents, onReportPenActor: reportPen, getPenPosition: (id) => poseStore.current[id]?.x,
    audioBlocked: false, onResumeAudio: () => {}, mediaStates: {}, roomLocked: false, deaf: false,
    interactions, feedCounts: params.get("fed") ? { "1000000002": Number(params.get("fed")) } : {}, onToggleDeaf: () => record("deaf"),
    onKick: (...args) => record("kick", ...args), onForceMute: (...args) => record("force-mute", ...args),
    onToggleLock: () => record("lock"), onInteract: (...args) => record("interact", ...args),
    /*
     * ?tv=1：电视亮起（演示状态，无真实流 → 雪花待机）。
     * 目检掉落/聚集/散场动画与放大灯箱（sharer=guest，本机是观众视角）。
     */
    screenShare:
      params.get("tv") === "1"
        ? {
            active: true,
            sharerId: "guest",
            sessionId: "demo-local",
            trackName: "",
            trackNameAudio: "",
            label: "回归演示画面",
            startedAt: Date.now(),
            transport: "p2p",
          }
        : null,
    shareStream: null,
    onStartShare: (quality) => record("share-start", quality),
    onStopShare: () => record("share-stop"),
    shareQuality: "fhd1080",
    onSetShareQuality: (quality) => record("share-quality", quality),
    shareTransport: "p2p" as const,
    onSetShareTransport: (transport) => record("share-transport", transport),
    shareViewMode: "auto" as const,
    onSetShareViewMode: (mode) => record("share-view-mode", mode),
  };
  return <RoomView {...props} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
