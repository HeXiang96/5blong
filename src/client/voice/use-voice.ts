import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  VoiceMesh,
  type ChatMessage,
  type EndReason,
  type EngineStatus,
  type MediaLinkState,
  type Member,
} from "./engine";
import { loadIdentity, resolveDisplayNames, saveIdentity, type Identity } from "./identity";
import { debugPoseFrom, eventTtl, pruneEvents, type PenEvent } from "./pen";
import { clearPenPoses, setLatestPenPoses } from "./pen-follow";

/**
 * 提示条停留多久（毫秒）。
 * 成功的操作提示看一眼就够；错误要留足阅读时间，但不能永远不退。
 */
const NOTICE_DISMISS_MS: Record<"info" | "error", number> = {
  info: 2800,
  error: 7000,
};
import {
  buildInviteUrl,
  parseInviteHash,
  parseJoinInput,
  type InteractEvent,
  type InteractKind,
  type Invite,
  type JoinTarget,
} from "./protocol";
import { loadSettings, saveSettings, type VoiceSettings } from "./settings";
import { readJson, writeJson } from "./storage";

/** 互动动画（戳/打招呼/投喂的气泡与跳动）在头顶停留多久。 */
const INTERACT_TTL_MS = 3200;
/** 本机记录投喂次数的存储键。 */
const FEED_STORAGE_KEY = "5blong:feed";

export type View = "landing" | "confirm" | "room" | "settings";

export interface Notice {
  kind: "info" | "error";
  text: string;
}

/**
 * 引擎与 React 之间的唯一桥接点。
 * 状态分成两半：房间状态（成员/说话/消息）由引擎推送，界面状态（视图/未读/提示）归这里管。
 */
export function useVoice() {
  const [identity, setIdentity] = useState<Identity>(() => loadIdentity());
  const [identitySaving, setIdentitySaving] = useState(false);
  const [settings, setSettings] = useState<VoiceSettings>(() => loadSettings());
  const [view, setView] = useState<View>("landing");
  const [settingsReturn, setSettingsReturn] = useState<View>("landing");

  const [status, setStatus] = useState<EngineStatus>("idle");
  const [members, setMembers] = useState<Member[]>([]);
  const [speaking, setSpeaking] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [pending, setPending] = useState<JoinTarget | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [ended, setEnded] = useState<{ reason: EndReason; detail?: string } | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [joined, setJoined] = useState(false);
  /**
   * 对方的音频被浏览器自动播放策略拦下了（用户听不见别人说话）。
   * 界面据此显示"点一下恢复"的提示——以前这种情况是完全静默的。
   */
  const [audioBlocked, setAudioBlocked] = useState(false);
  /** 与每个成员的媒体连接状态：直连 / 中继 / 连接中 / 失败（诊断跨网无声）。 */
  const [mediaStates, setMediaStates] = useState<Record<string, MediaLinkState>>({});
  /** 房间是否上锁（仅房主可切换）。 */
  const [roomLocked, setRoomLocked] = useState(false);
  /** 本机是否闭听（deaf：闭麦且不听任何人）。 */
  const [deaf, setDeaf] = useState(false);
  /** 最近的小猪互动（带序号，超时自动移除）。 */
  const [interactions, setInteractions] = useState<{ key: number; event: InteractEvent }[]>([]);

  const interactSeq = useRef(0);
  /** 本机对各成员（按个人 ID）的投喂次数。 */
  const [feedCounts, setFeedCounts] = useState<Record<string, number>>(() =>
    readJson<Record<string, number>>(FEED_STORAGE_KEY, {}),
  );
  /**
   * 回声消除 / 自动增益是否已**实时**应用到当前麦克风轨道（回读确认）。
   * 为 false 时界面继续显示"重进生效"，不骗用户。
   */
  const [captureLive, setCaptureLive] = useState({
    echoCancellation: false,
    autoGainControl: false,
  });

  /**
   * 猪圈里正在播的事件（丢蔬菜 / 吃 / 拉屎）。
   * 房主统一下发，所有端看到的是同一件事。
   */
  /**
   * 调试用：`?pen=pose:eat` 直接摆出吃菜动作，方便人工看效果。
   * 只在开发构建、或线上手动打开 `localStorage['5blong:debugPen']='1'` 时生效
   * （见 pen.ts 的 debugPoseFrom）——正式包里不能靠手输参数就改行为。
   * 用 ref 求值一次，且不能被 resetRoom 清掉，否则建房时就没了。
   */
  const debugPose = useRef<PenEvent | null>(
    (() => {
      if (typeof location === "undefined") return null;
      const pose = debugPoseFrom(location.search);
      if (!pose) return null;
      const now = Date.now();
      return { kind: "eat", id: "debug-eat", ts: now, actor: "*", veg: "carrot" };
    })(),
  );

  const initialPenEvents = useCallback(() => {
    const pose = debugPose.current;
    return pose ? [{ event: pose, expiresAt: Date.now() + 10 * 60_000 }] : [];
  }, []);

  /**
   * 猪圈里正在播的事件（丢蔬菜 / 吃 / 拉屎）。
   * 房主统一下发，所有端看到的是同一件事。
   */
  const [penEvents, setPenEvents] = useState<{ event: PenEvent; expiresAt: number }[]>(
    initialPenEvents,
  );

  /** 各猪最新上报的横向位置（0~1），用来把那一坨拉在它当时站的地方。 */
  const penPositionsRef = useRef(new Map<string, { x: number; at: number }>());

  const engineRef = useRef<VoiceMesh | null>(null);
  const chatOpenRef = useRef(false);
  const joinedRef = useRef(false);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const resetRoom = useCallback(() => {
    setMembers([]);
    setSpeaking([]);
    setMessages([]);
    setInvite(null);
    setEnded(null);
    setUnread(0);
    setJoined(false);
    joinedRef.current = false;
    setChatOpen(false);
    chatOpenRef.current = false;
    setMediaStates({});
    setRoomLocked(false);
    setDeaf(false);
    setInteractions([]);
    clearPenPoses();
    setPenEvents(initialPenEvents());
    setStatus("idle");
  }, [initialPenEvents]);

  const makeEngine = useCallback(() => {
    return new VoiceMesh({
      status: (next, detail) => {
        setStatus(next);
        if (next === "error") {
          // 引擎算出来的具体原因必须到达用户，而不是被换成一句"连接失败"。
          setJoinError(detail ?? "连接失败，请重试");
        } else if (next === "preparing" && detail) {
          setNotice({ kind: "info", text: detail });
        } else if (next === "connected") {
          setJoinError(null);
          setJoined(true);
          joinedRef.current = true;
        }
      },
      members: setMembers,
      speaking: setSpeaking,
      chat: (message) => {
        setMessages((prev) => [...prev, message]);
        if (!message.self && !chatOpenRef.current) setUnread((value) => value + 1);
      },
      ended: (reason, detail) => setEnded({ reason, detail }),
      ready: setInvite,
      pen: (event) => {
        const now = Date.now();
        setPenEvents((prev) => [
          ...pruneEvents(prev, now),
          { event, expiresAt: now + eventTtl(event) },
        ]);
        // "吃掉才长"：eat 事件到达后等走过去的时间（approach 5s），
        // 猪开始低头嚼的那一刻体型 +1，因果顺序才对（之前投喂瞬间就涨）。
        if (event.kind === "eat" && event.actor !== "*") {
          const actor = event.actor;
          window.setTimeout(() => {
            setFeedCounts((prev) => {
              const next = { ...prev, [actor]: (prev[actor] ?? 0) + 1 };
              writeJson(FEED_STORAGE_KEY, next);
              return next;
            });
          }, 5200);
        }
      },
      /*
       * 房主权威猪位（只有访客会收到）：写进模块级 store，各猪的
       * 渲染循环按帧自取。**刻意不 setState**——50ms 一条快照要是每条
       * 都触发 React 渲染，主线程会被拖垮（"动画很卡"的根因）。
       */
      penPoses: (poses) => {
        setLatestPenPoses(poses);
      },
      // 提示音由引擎合成播放（房主统一广播，全房间同时响）
      sound: (event) => {
        engineRef.current?.playSound(event);
      },
      /*
       * 远端音频被浏览器拦下了。
       * 以前这类失败是被静默吞掉的（注释里承诺的提示 UI 根本不存在），
       * 用户只会觉得"别人说话我听不见"。现在明确提示并允许一键恢复。
       */
      playbackBlocked: () => {
        setAudioBlocked(true);
        setNotice({
          kind: "error",
          text: "浏览器拦下了对方的声音，点一下页面即可恢复",
        });
      },
      /*
       * 成员进出：给一条带名字的可见提示。
       * 原来只有提示音、人数从 1/8 悄悄变 2/8，房主在别的窗口很容易错过。
       */
      rosterChange: ({ kind, name }) => {
        setNotice({
          kind: "info",
          text: kind === "join" ? `${name} 进圈了` : `${name} 离开了`,
        });
      },
      mediaState: (peerId, state) => {
        setMediaStates((prev) => ({ ...prev, [peerId]: state }));
      },
      roomFlags: (flags) => {
        setRoomLocked(flags.locked);
      },
      interact: (event) => {
        interactSeq.current += 1;
        const key = interactSeq.current;
        setInteractions((prev) => [...prev, { key, event }]);
        window.setTimeout(() => {
          setInteractions((prev) => prev.filter((item) => item.key !== key));
        }, INTERACT_TTL_MS);
      },
    });
  }, []);

  /** 每次尝试都是干净的引擎：避免上一次的 peer / 心跳影响这一次。 */
  const startEngine = useCallback(() => {
    engineRef.current?.destroy();
    const engine = makeEngine();
    engineRef.current = engine;
    return engine;
  }, [makeEngine]);

  const teardown = useCallback(() => {
    engineRef.current?.destroy();
    engineRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  /**
   * 提示条自动消失。
   *
   * 之前 setNotice 只负责设置、**没有任何地方清除**，所以"已复制"这类提示
   * 会一直挂在页面上直到用户手动点 ×（实测就是这个现象）。
   * 按类型分档：操作成功的提示很快收掉，错误留久一点让人看清。
   */
  useEffect(() => {
    if (!notice) return;
    const ms = NOTICE_DISMISS_MS[notice.kind] ?? 3200;    const timer = window.setTimeout(() => setNotice(null), ms);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!ended) return;
    const wasJoined = joinedRef.current;
    const detail = ended.detail;
    const reason = ended.reason;
    teardown();
    setStatus("idle");
    setMembers([]);
    setSpeaking([]);

    if (!wasJoined) {
      // 根本没进去：留在原地把原因说清楚，允许直接重试。
      setEnded(null);
      setJoinError(detail ?? "无法进入房间");
      return;
    }

    const timer = window.setTimeout(() => {
      setEnded(null);
      resetRoom();
      setView("landing");
      setNotice(
        detail
          ? { kind: "info", text: detail }
          : reason === "host-left"
            ? { kind: "info", text: "房主已结束房间" }
            : null,
      );
      const clean = window.location.href.split("#")[0] ?? "";
      window.history.replaceState(null, "", clean);
    }, reason === "rejected" ? 2400 : 1400);
    return () => window.clearTimeout(timer);
  }, [ended, resetRoom, teardown]);

  const createRoom = useCallback(async () => {
    // 房间状态整体重置，但先把 invite 清掉避免闪一下旧房间码。
    resetRoom();
    setNotice(null);
    setJoinError(null);
    setInvite(null);
    setView("room");
    const engine = startEngine();
    await engine.host(identityRef.current, settings, true);
  }, [resetRoom, settings, startEngine]);

  const joinRoom = useCallback(
    async (target: JoinTarget, muted: boolean) => {
      resetRoom();
      setNotice(null);
      setJoinError(null);
      const engine = startEngine();
      // 注意：这里不能靠 await join() 的返回来切页。
      // 引擎在收到房主欢迎的那一刻就已经算进房（status → connected → joined），
      // 而 join() 的 promise 还要等更久；若期间心跳判定超时，房间会被拆掉，
      // 视图就永远停在确认页。切页统一交给下面的 joined 副作用。
      await engine.join(target, identityRef.current, settings, muted);
    },
    [resetRoom, settings, startEngine],
  );

  /** 进房成功即切到房间视图（由引擎事件驱动，不依赖 join() 何时返回）。 */
  useEffect(() => {
    if (joined && !ended) {
      setView("room");
      // 新采集到的轨道上，采集参数的真实状态要重新回读一次，
      // 否则界面会一直显示"重进生效"。
      setCaptureLive(
        engineRef.current?.readCaptureProcessing() ?? {
          echoCancellation: false,
          autoGainControl: false,
        },
      );
    }
  }, [joined, ended]);

  /** 邀请链接直达：先落到确认页（一次点击同时解决隐私与浏览器自动播放策略）。 */
  const autoJoinRef = useRef(false);
  useEffect(() => {
    if (autoJoinRef.current) return;
    const parsed = parseInviteHash(window.location.hash);
    if (!parsed) return;
    autoJoinRef.current = true;
    setPending({ code: parsed.code, hostId: parsed.hostId, roomKey: parsed.roomKey });
    setView("confirm");
  }, []);

  const clearHash = useCallback(() => {
    const clean = window.location.href.split("#")[0] ?? "";
    window.history.replaceState(null, "", clean);
  }, []);

  const cancelJoin = useCallback(() => {
    teardown();
    resetRoom();
    setPending(null);
    setJoinError(null);
    setView("landing");
    clearHash();
  }, [clearHash, resetRoom, teardown]);

  const leave = useCallback(() => {
    teardown();
    resetRoom();
    setPending(null);
    setNotice(null);
    setJoinError(null);
    setView("landing");
    clearHash();
  }, [clearHash, resetRoom, teardown]);

  const openSettings = useCallback(() => {
    setSettingsReturn(view);
    setView("settings");
  }, [view]);

  /**
   * 把设置落盘。
   *
   * 房间里的快捷开关（麦克风音量 / 降噪 / 采集参数）以前只改内存、从不写盘，
   * 于是刷新或重新进房就回默认值——用户看到的现象是"改了没用、重进就没了"。
   * 这里统一在每次改动后立刻写入，并在写入失败时如实告知。
   *
   * peerVolumes / peerMuted 的运行时真相在引擎里，落盘时一并快照，
   * 否则会把已记住的成员音量覆盖成空。
   */
  const persistSettings = useCallback((next: VoiceSettings) => {
    const engine = engineRef.current;
    const merged = engine ? { ...next, ...engine.snapshotPeerAudio() } : next;
    setSettings(merged);
    if (!saveSettings(merged)) {
      setNotice({ kind: "error", text: "设置无法写入本机存储，重开页面后会丢失" });
    }
    return merged;
  }, []);

  const closeSettings = useCallback(() => setView(settingsReturn), [settingsReturn]);

  const saveAll = useCallback(
    (nextIdentity: Identity, nextSettings: VoiceSettings) => {
      setIdentity(nextIdentity);
      setIdentitySaving(!saveIdentity(nextIdentity));

      const engine = engineRef.current;
      const settingsToSave = persistSettings(nextSettings);
      if (engine) {
        void engine.updateAudioSettings(settingsToSave);
        engine.applySpeaker(settingsToSave);
        // 昵称/头像/颜色改动立即同步运行中的会话（铭牌不再停留在旧名字）
        engine.updateIdentity(nextIdentity);
        // 设置页保存后同步一下采集参数的真实状态，供房间面板显示。
        void engine
          .applyCaptureProcessing(settingsToSave.processing)
          .then(setCaptureLive);
      }
      setView(settingsReturn);
    },
    [persistSettings, settingsReturn],
  );

  const toggleChat = useCallback(() => {
    setChatOpen((open) => {
      const next = !open;
      chatOpenRef.current = next;
      if (next) setUnread(0);
      return next;
    });
  }, []);

  const copyInvite = useCallback(async (): Promise<boolean> => {
    const current = engineRef.current?.invite ?? null;
    if (!current) return false;
    /*
     * 必须用 buildInviteUrl（它固定指向公开网址），**不能用 window.location**。
     *
     * 桌面端窗口加载的是本地资源（tauri.localhost），不是公网地址，
     * 按 window.location 拼出来的邀请链接只有本机能打开，别人收到完全没用。
     *
     * 之前这里是手拼的，和 protocol.ts 里的 buildInviteUrl 重复实现，
     * 于是改了公开地址那处、漏了这处。现在只保留唯一实现。
     */
    const url = buildInviteUrl(current);
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      setNotice({ kind: "error", text: "复制失败，请手动选中房间码分享" });
      return false;
    }
  }, []);

  const copyText = useCallback(async (value: string, okText: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ kind: "info", text: okText });
      return true;
    } catch {
      setNotice({ kind: "error", text: "复制失败，请手动选中复制" });
      return false;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const current = members.find((member) => member.local);
    engine.setMuted(!(current?.muted ?? true));
  }, [members]);

  

  

  /** 麦克风音量/增强（0..2），通话中立即生效并立刻落盘。 */
  const setMicVolume = useCallback(
    (volume: number) => {
      engineRef.current?.setMicVolume(volume);
      persistSettings({ ...settings, micVolume: volume });
    },
    [persistSettings, settings],
  );

  /**
   * AI 智能降噪（RNNoise）开关：通话中实时生效，并立刻落盘。
   * 引擎应用失败（worklet/wasm 不可用）时把开关拨回去并明确提示，
   * 不再让用户以为已经开了。
   */
  const setNoiseSuppression = useCallback(
    (on: boolean) => {
      const engine = engineRef.current;
      const commit = (value: boolean) =>
        persistSettings({
          ...settings,
          processing: { ...settings.processing, noiseSuppression: value },
        });

      if (!engine) {
        commit(on);
        return;
      }
      const previous = settings.processing.noiseSuppression;
      commit(on);
      void engine.setNoiseSuppression(on).then((ok) => {
        if (!ok && on) {
          commit(previous);
          setNotice({
            kind: "error",
            text: "智能降噪在当前浏览器不可用，已保持关闭（回声消除仍生效）",
          });
        }
      });
    },
    [persistSettings, settings],
  );

  /**
   * 回声消除 / 自动增益：先尝试通话中实时应用并回读，改不动才提示"重进生效"。
   * 采集参数在下次 openMic 时一定生效，所以落盘是必须的。
   */
  const setProcessingFlag = useCallback(
    (key: "echoCancellation" | "autoGainControl", value: boolean) => {
      const nextProcessing = { ...settings.processing, [key]: value };
      persistSettings({ ...settings, processing: nextProcessing });
      const engine = engineRef.current;
      if (!engine) return;
      void engine.applyCaptureProcessing(nextProcessing).then((live) => {
        setCaptureLive(live);
      });
    },
    [persistSettings, settings],
  );

  /** 调某个成员的本地收听音量（0..1）。 */
  const setPeerVolume = useCallback((peerId: string, volume: number) => {
    engineRef.current?.setPeerVolume(peerId, volume);
  }, []);

  /** 对某个成员本地静音/取消，返回是否处于静音。 */
  const togglePeerMuted = useCallback((peerId: string): boolean => {
    return engineRef.current?.togglePeerMuted(peerId) ?? false;
  }, []);

  const getPeerAudio = useCallback(
    (peerId: string): { volume: number; muted: boolean } => {
      return engineRef.current?.getPeerAudio(peerId) ?? { volume: 1, muted: false };
    },
    [],
  );

  const sendChat = useCallback((text: string) => {
    engineRef.current?.sendChat(text);
  }, []);

  const submitJoinInput = useCallback(
    (raw: string): boolean => {
      const target = parseJoinInput(raw);
      if (!target) return false;
      const bareCode = !target.hostId && !target.roomKey;
      if (!bareCode && (!target.hostId || !target.roomKey)) {
        // 残缺链接（例如有房主 ID 没密钥）：如实说明并落到确认页，而不是转圈。
        setJoinError("邀请链接不完整，请让房主重新发一次完整链接");
        setView("confirm");
        setPending(target);
        return true;
      }
      // 只输房间码：房主 ID 由房间码推导，直接进房。
      void joinRoom(target, true);
      return true;
    },
    [joinRoom, settings.joinMuted],
  );

  /**
   * 借一次用户手势恢复远端音频的播放。
   * 用户点页面任意处或点提示条上的按钮都会走这里。
   */
  const resumeAudio = useCallback(() => {
    engineRef.current?.unlockAudio();
    setAudioBlocked(false);
    setNotice(null);
  }, []);

  /** 猪把当前位置报给引擎（横向 0~1 + 纵深 0~1），房主据此挑最近的猪去吃菜。 */
  const reportPenActor = useCallback((id: string, x: number, lane: number) => {
    // 本地也记一份，用来把蔬菜放在猪当时站的位置
    penPositionsRef.current.set(id, { x, at: Date.now() });
    engineRef.current?.reportPenActor(id, x, lane);
  }, []);

  /** 取某头猪最近一次上报的位置；没有就返回 undefined 由界面兜底。 */
  const getPenPosition = useCallback((id: string): number | undefined => {
    return penPositionsRef.current.get(id)?.x;
  }, []);

  /** 取某头猪最近一次上报的纵深（0=最远 1=最近）。 */
  const getPenLane = useCallback((id: string): number | undefined => {
    return engineRef.current?.getPenLane(id);
  }, []);

  const displayNames = useMemo(
    () =>
      resolveDisplayNames(
        members.map((member) => ({
          id: member.id,
          name: member.name,
          personId: member.personId,
          sessionId: member.sessionId,
        })),
      ),
    [members],
  );

  // ------------------------------------------------------------ 闭听 / 房主管理 / 互动

  const toggleDeaf = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const next = !engine.isDeafened;
    engine.setDeaf(next);
    setDeaf(next);
  }, []);

  const kickMember = useCallback((id: string) => {
    engineRef.current?.kickMember(id);
  }, []);

  const forceMute = useCallback((id: string, muted: boolean) => {
    engineRef.current?.forceMute(id, muted);
  }, []);

  const toggleRoomLock = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setLockedRoom(!engine.isLocked);
  }, []);

  const interact = useCallback((peerId: string, _personId: string, kind: InteractKind) => {
    engineRef.current?.interactWith(peerId, kind);
    // 注意：喂食计数在猪**真的吃掉**时才 +1（见下方 pen 事件处理），
    // 之前是投喂瞬间就涨——猪还没动体型先变大，观感很怪。
  }, []);

  return {
    identity,
    identitySaving,
    settings,
    view,
    status,
    members,
    speaking,
    messages,
    invite,
    pending,
    notice,
    joinError,
    ended,
    chatOpen,
    unread,
    joined,
    displayNames,
    maxMembers: engineRef.current?.maxMembers ?? 8,
    createRoom,
    joinRoom,
    submitJoinInput,
    cancelJoin,
    leave,
    openSettings,
    closeSettings,
    settingsReturn,
    saveAll,
    toggleChat,
    toggleMute,
    sendChat,
    copyInvite,
    copyText,
    setIdentity,
    setNotice,
    setJoinError,
    micVolume: settings.micVolume,
    setMicVolume,
    setNoiseSuppression,
    setProcessingFlag,
    processing: settings.processing,
    captureLive,
    penEvents,
    reportPenActor,
    getPenPosition,
    getPenLane,
    audioBlocked,
    mediaStates,
    resumeAudio,
    setPeerVolume,
    togglePeerMuted,
    getPeerAudio,
    roomLocked,
    deaf,
    interactions,
    feedCounts,
    toggleDeaf,
    kickMember,
    forceMute,
    toggleRoomLock,
    interact,
  };
}
