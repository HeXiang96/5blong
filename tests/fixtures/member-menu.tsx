/** 本地浏览器回归场景：真实 RoomView + 模拟成员，不连接信令也不采集麦克风。
 *  ?scene=snow|halloween|spring 可强制场景主题（目检猪装扮与场景装饰）。 */
import { StrictMode, useEffect, useRef, useState, type ComponentProps } from "react";

import { setLatestPenPoses } from "../../src/client/voice/pen-follow";
import { createRoot } from "react-dom/client";
import { RoomView } from "../../src/client/voice/components/RoomView";
import type { InteractKind } from "../../src/client/voice/protocol";
import { parseSceneTheme } from "../../src/client/voice/scene-theme";
import "../../src/client/voice/account.css";
import "../../src/client/voice/styles.css";
import "../../src/client/voice/pen-scene.css";
import "../../src/client/voice/pen-life.css";
import "../../src/client/voice/pen-fence.css";
import "../../src/client/voice/pen-tv.css";
import "../../src/client/voice/pen-themes.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
/*
 * ?desktop=1：让 isTauriRuntime() 为真，走"桌面客户端"那条分支
 * （共享菜单里才有 指定应用 / 老系统回退 这些行，业主截图正是这一屏）。
 * invoke 桩返回空数组：没有可采集的窗口，但布局照样能目检。
 */
if (params.get("desktop") === "1") {
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: async () => [] } });
}
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
   * ?sharemenu=1：自动点开「共享」菜单。
   * 菜单开合是 RoomView 的内部状态，无头截图点不了，只能让夹具代点一下，
   * 用来目检画质档位/声音来源/长说明的排版（2026-10-26 业主实拍文字被裁）。
   */
  const autoShareMenu = params.get("sharemenu") === "1";
  useEffect(() => {
    if (!autoShareMenu) return;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>('.vx-ctl[aria-haspopup="menu"]')?.click();
      // ?shareadv=1 顺带展开"高级"折叠，目检里面那几行的排版
      if (params.get("shareadv") === "1") {
        window.setTimeout(() => {
          document.querySelector<HTMLElement>(".vx-share-adv > summary")?.click();
        }, 80);
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [autoShareMenu]);
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
      { id: "guest", personId: "1000000002", sessionId: "guest", name: "测试成员", avatar: "", color: "#e05f8a", muted: false, hasMic: true, isHost: !host, local: false, serverMuted: params.get("muted") === "1", accountId: "53720018" },
    ],
    speaking: params.get("speak") ? ["guest"] : [], messages: [], invite: { code: "123456", hostId: "self", roomKey: "fixture" }, notice: null,
    chatOpen, unread: 0, displayNames: new Map(), isHost: host, maxMembers: 13,
    onCopyCode: async () => {
      record("copy-code");
      return true;
    }, onCopyInvite: async () => { record("copy-invite"); return true; },
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
    onRetryLink: (peerId: string) => record("retry-link", peerId),
    topic: "", onSetTopic: (text) => record("topic", text),
    sceneTheme: parseSceneTheme(params.get("scene")),
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
    shareAudio: params.get("shareAudio") === "1",
    onSetShareAudio: (on) => record("share-audio", on),
    shareAppPid: params.get("sharePid") ? Number(params.get("sharePid")) : null,
    onSetShareAppPid: (pid) => record("share-app", pid),
    shareFallbackDuck: false,
    onSetShareFallbackDuck: (on) => record("share-duck", on),
    friendsInRoomByName: new Map(),
    shareLatency: "balanced" as const,
    onSetShareLatency: (mode) => record("share-latency", mode),
    // ?anon=1 模拟未登录：菜单里应出现"登录后可加好友"
    selfAccountId: params.get("anon") === "1" ? null : "48231907",
    onOpenAccount: () => record("open-account"),
    friendRequestCount: params.get("requests") ? Number(params.get("requests")) : 0,
    onOpenFriends: () => record("open-friends"),
    friendAccountIds: new Set(params.get("friend") === "1" ? ["53720018"] : []),
    onAddFriend: async (accountId) => {
      record("add-friend", accountId);
      return true;
    },
    // ?pass=1 模拟"这是登录账号的私密房、临时密码开着"：
    // 顶栏应出现钥匙图标 + 浮层里的大号密码（各主题都要能看清）
    privateRoom: params.get("pass") === "1" || params.get("pass") === "off",
    guestPass: params.get("pass") === "1" ? "831204" : "",
    onRenewGuestPass: () => {
      record("renew-pass");
      return "831204";
    },
    onCloseGuestPass: () => record("close-pass"),
    onCopyPassInvite: async () => {
      record("copy-pass");
      return true;
    },
    onWatchScreen: (state) => record("share-watch", state),
    shareViewMode: "auto" as const,
    onSetShareViewMode: (mode) => record("share-view-mode", mode),
  };
  return <RoomView {...props} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
