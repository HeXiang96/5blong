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
import {
  RESOLUTION_LADDER_LABEL,
  TRACK_AUDIO,
  TRACK_VIDEO,
  autoTransportFor,
  createDemoStream,
  debugTvDemoFrom,
  debugTvFrom,
  pickerHints,
  preferredRidFor,
  probeHardwareEncoders,
  publishScreen,
  randomSessionId,
  shareVideoConstraints,
  subscribeScreen,
  type ScreenPublication,
  type ScreenSubscription,
  type ShareQuality,
} from "./screen-share";
import type { ScreenViewPreference } from "./protocol";

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
  type ScreenShareState,
} from "./protocol";
import { refreshIceServers } from "./ice";
import { isTauriRuntime, startLoopbackAudio } from "./loopback";
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
  /** true = 不自动消失，等用户点 ×（用于必须让用户看到的失败说明）。 */
  sticky?: boolean;
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

  /*
   * 屏幕共享（围炉看 TV）。
   * 状态只有一条：房主权威广播的 ScreenShareState。SFU 的发布/订阅
   * 全部住在 use-voice 之外的 screen-share.ts，与语音链路零接触。
   */
  const [screenShare, setScreenShare] = useState<ScreenShareState | null>(() => {
    // ?tv=1：不开采集就能目检全套动画（电视播测试彩条）
    if (typeof location !== "undefined" && debugTvFrom(location.search)) {
      return {
        active: true,
        sharerId: "debug-tv",
        sessionId: "demo-local",
        trackName: "",
        trackNameAudio: "",
        label: "演示画面",
        startedAt: Date.now(),
        transport: "p2p",
      };
    }
    return null;
  });
  /** 订阅到的共享画面流（观看端；null = 雪花待机）。 */
  const [shareStream, setShareStream] = useState<MediaStream | null>(null);
  /** 订阅端 RTCPeerConnection（观众放大层拉 getStats 显示链路数据用）。 */
  const [sharePc, setSharePc] = useState<RTCPeerConnection | null>(null);

  const sharePubRef = useRef<ScreenPublication | null>(null);
  const shareSubRef = useRef<ScreenSubscription | null>(null);
  /** 当前订阅所用的画质偏好（变化时才重订阅）。 */
  const shareSubModeRef = useRef<ScreenViewPreference>("auto");
  /** 共享者本机采集的流（自己电视的播放源；订阅流供其他端用）。 */
  const shareLocalStreamRef = useRef<MediaStream | null>(null);
  /** 最新成员数：开播时据此决定 P2P 还是 SFU（避免闭包里的陈旧值）。 */
  const memberCountRef = useRef(0);
  memberCountRef.current = members.length;
  /** 自适应降档提示只弹一次（同一次共享里不刷屏）。 */
  const stepNoticeShown = useRef(false);
  /** 共享会话的清理（离房/重置时无条件执行）。 */
  const teardownShare = useCallback(() => {
    sharePubRef.current?.stop();
    sharePubRef.current = null;
    shareSubRef.current?.stop();
    shareSubRef.current = null;
    shareSubModeRef.current = "auto";
    setSharePc(null);
    for (const track of shareLocalStreamRef.current?.getTracks() ?? []) track.stop();
    shareLocalStreamRef.current = null;
    setShareStream(null);
  }, []);

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
    teardownShare();
    setScreenShare(null);
    setStatus("idle");
  }, [initialPenEvents, teardownShare]);

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
      /*
       * 屏幕共享状态（房主权威广播）。只更新 React 状态与订阅流，
       * 绝不触碰语音状态——这条回调的实现里没有一行音频代码。
       */
      screenShare: (state) => {
        setScreenShare(state);
      },
      screenStream: (stream, call) => {
        // P2P 直连：观众端收到共享者的画面流（引擎已按 sessionId 对上号）
        setSharePc((call as unknown as { peerConnection?: RTCPeerConnection }).peerConnection ?? null);
        setShareStream(stream);
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
    teardownShare();
  }, [teardownShare]);

  useEffect(() => teardown, [teardown]);

  // ------------------------------------------------------------ 屏幕共享（围炉看 TV）

  /**
   * 订阅副作用：电视亮起且不是自己在共享时，向 SFU 拉流。
   * 任何失败只降级为"电视雪花"（shareStream = null），不上抛、不动语音；
   * 失败后自动重试一次（SFU 偶发抖动不该让电视永远雪花）。
   */
  useEffect(() => {
    // 竞态输家清理：本地已经发布到 SFU，但广播里 sharer 不是自己
    // （两人同时开播，房主留了先到者）——立刻停掉自己的发布与采集。
    if (screenShare && sharePubRef.current) {
      const selfId = members.find((member) => member.local)?.id;
      if (selfId && screenShare.sharerId !== selfId) {
        stopScreenShareRef.current();
        return;
      }
    }

    if (!screenShare) {
      shareSubRef.current?.stop();
      shareSubRef.current = null;
      setSharePc(null);
      setShareStream(null);
      return;
    }
    const selfId = members.find((member) => member.local)?.id;
    // 自己在共享：电视播本机采集流（不走订阅）
    if (selfId && screenShare.sharerId === selfId) {
      setShareStream(shareLocalStreamRef.current);
      return;
    }
    // 调试假状态 / 已在订阅同一场：跳过
    if (screenShare.sessionId === "demo-local") return;
    if (shareSubRef.current) {
      // 画质偏好变了（SFU 模式）：偏好映射成订阅层，需要重新订阅；
      // 其它情况下保持不变（避免因成员数变化反复重订阅）。
      if (shareSubModeRef.current === settings.shareViewMode) return;
      shareSubRef.current.stop();
      shareSubRef.current = null;
    }

    // P2P 直连模式：观众被动应答共享者的画面呼叫（引擎经 screenStream 事件送流），
    // 这里无需主动动作；只处理 SFU 模式的拉流。
    if (screenShare.transport !== "sfu") return;

    let cancelled = false;
    let attemptNo = 0;
    let retryTimer = 0;
    // 退避重试（2/4/8/15s）：共享期间观众端可自愈（SFU 抖动、发布者刚连接等）
    const RETRY_DELAYS = [2000, 4000, 8000, 15000];
    const attempt = () => {
      const trackNames = [TRACK_VIDEO];
      if (screenShare.trackNameAudio) trackNames.push(TRACK_AUDIO);
      // 共享者用了 simulcast 就按层订阅：优先层由本机偏好决定
      // （清晰优先 = f 满档、流畅优先 = h 半档），带宽不足时 SFU 自动退层。
      // 没标 simulcast 的老房主按单档订阅，行为与以前一致。
      void subscribeScreen(screenShare.sessionId, trackNames, {
        simulcast: screenShare.simulcast === true,
        preferredRid: preferredRidFor(settings.shareViewMode),
        // 默认锁住所选的层（业主口径："默认就是最高的来"）——不许 SFU 按它自己的
        // 带宽估计擅自把满档降到 q 层（现场：观众选 f 却只收到 353×254）。
        // 只有观众主动选「流畅优先」时才放开自适应降层去换平滑。
        adaptive: settings.shareViewMode === "motion",
      })
        .then((sub) => {
          if (cancelled) {
            sub.stop();
            return;
          }
          shareSubRef.current = sub;
          shareSubModeRef.current = settings.shareViewMode;
          setSharePc(sub.pc);
          setShareStream(sub.stream);
        })
        .catch(() => {
          // 降级：电视雪花，不弹错（语音零影响的收敛出口）；按退避节奏重试
          if (cancelled) return;
          setShareStream(null);
          if (attemptNo < RETRY_DELAYS.length) {
            const delay = RETRY_DELAYS[attemptNo];
            attemptNo += 1;
            retryTimer = window.setTimeout(() => {
              if (!cancelled) attempt();
            }, delay);
          }
        });
    };
    attempt();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenShare, members.length, settings.shareViewMode]);

  /** 共享者本机：采集流变化时同步给电视（开播瞬间先有画面）。 */
  useEffect(() => {
    if (!screenShare) return;
    const selfId = members.find((member) => member.local)?.id;
    if (selfId && screenShare.sharerId === selfId && shareLocalStreamRef.current) {
      setShareStream(shareLocalStreamRef.current);
    }
  }, [screenShare, members.length]);

  /**
   * 共享者本机的"发送端连接"是**异步**才有的（P2P 时访客共享者要等房主广播
   * 回来才向各成员发起画面呼叫），开播那一刻拿不到。这里短轮询补上，
   * 让灯箱数据条从第一秒就有读数——没有读数等于闭眼调参。
   */
  useEffect(() => {
    if (!screenShare || sharePc) return;
    if (screenShare.transport === "sfu") return; // SFU 发布连接开播时已就位
    const selfId = members.find((member) => member.local)?.id;
    if (!selfId || screenShare.sharerId !== selfId) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const pc = engineRef.current?.screenSenderPeerConnection() ?? null;
      if (pc) setSharePc(pc);
      if (pc || tries >= 24) window.clearInterval(timer);
    }, 500);
    return () => window.clearInterval(timer);
  }, [screenShare, sharePc, members.length]);

  /** 开播：采集 → SFU 发布 → 向房主申报（申报失败自动回滚）。 */
  const startScreenShare = useCallback(
    async (quality: ShareQuality): Promise<boolean> => {
      const engine = engineRef.current;
      if (!engine?.isJoined) return false;
      if (screenShare || sharePubRef.current) {
        setNotice({ kind: "error", text: `电视被 ${screenShare?.label || "别人"} 占着，等关播再上` });
        return false;
      }
      let stream: MediaStream | null = null;
      try {
        // 带上系统/标签页声音（业主需求：观众要听得到）。回声风险：
        // 共享者用外放开声音时会被麦克风二次拾取——默认静音进房 +
        // 开播后提示戴耳机，可基本规避。
        /*
         * 采集策略（业主定的方案）：**选择器照常出现"共享系统音频"开关**，
         * 勾不勾由用户定；差别在客户端——**勾了但浏览器拿不到声音时**（死音轨 /
         * 采集被拒），自动改用内置 WASAPI 回环采集补上，保证"勾了就一定有声"，
         * 且不受播放设备（7.1/虚拟声卡）限制。网页版没有兜底，走提示。
         * 系统声音建不起来时 Chromium 可能直接拒绝整个采集（NotReadableError），
         * 这时退一步：不带声音重采一次（用户需再选一次共享源），客户端再补声音。
         */
        let systemAudioBroken = false;
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: shareVideoConstraints(quality),
            audio: true,
            ...(pickerHints(true) as Record<string, never>),
          } as DisplayMediaStreamOptions);
        } catch (firstError) {
          // 用户取消选择器：不算故障，静默返回
          if ((firstError as DOMException)?.name === "NotAllowedError") return false;
          console.warn("[screen-share] 带声音的采集失败，改试纯画面：", firstError);
          setNotice({
            kind: "info",
            sticky: true,
            text: "系统声音采集失败（设备原因）——请再选一次要共享的屏幕，这次不带声音",
          });
          try {
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: shareVideoConstraints(quality),
              audio: false,
              ...(pickerHints(false) as Record<string, never>),
            } as DisplayMediaStreamOptions);
            systemAudioBroken = true;
          } catch (retryError) {
            if ((retryError as DOMException)?.name === "NotAllowedError") return false;
            console.warn("[screen-share] 纯画面采集也失败：", retryError);
            throw retryError; // 交给统一错误提示（会带上错误名）
          }
        }
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) {
          for (const track of stream.getTracks()) track.stop();
          return false;
        }
        /*
         * 有些机器上"系统音频"轨**刚拿到就是 ended 的**：Windows 的系统音频靠
         * WASAPI 回环采集，对默认输出设备很敏感——虚拟声卡（VB-Cable / Voicemeeter）、
         * 没有音频通道的 HDMI（NVIDIA/AMD 音频）、蓝牙耳机、独占模式、或输出设备被
         * 禁用/切换，都会让回环建不起来。此时 Chromium 会直接给出（或很快结束）
         * 音频轨，而画面轨是好的。
         * 先把这种死轨剔掉，下面的 hasAudio 才不会说谎，也不会去订阅它。
         */
        let audioDied = false;
        for (const track of stream.getAudioTracks()) {
          if (track.readyState === "ended") {
            audioDied = true;
            stream.removeTrack(track);
            track.stop();
          }
        }
        let hasAudio = stream.getAudioTracks().length > 0;
        // "用户要了系统声音但浏览器没给上"的两种形态：死音轨 / 采集直接被拒。
        // 注意：用户**没勾**开关时（正常解析、无音轨、无报错）不算这里——尊重选择。
        const systemAudioUnavailable = audioDied || systemAudioBroken;
        /*
         * 客户端兜底：勾了系统声音但浏览器没给上（死轨/被拒）时，走内置 WASAPI
         * 回环采集——保证"勾了就一定有声"，且不受播放设备（7.1/虚拟声卡）限制。
         * 网页版没有这条路：systemAudioUnavailable 时走下面的提示。
         */
        let viaNativeAudio = false;
        if (!hasAudio && systemAudioUnavailable && isTauriRuntime()) {
          let nativeError = "";
          try {
            const native = await startLoopbackAudio((message) =>
              setNotice({ kind: "info", text: message }),
            );
            stream.addTrack(native.track);
            nativeLoopbackStopRef.current = native.stop;
            hasAudio = true;
            viaNativeAudio = true;
          } catch (error) {
            console.warn("[screen-share] 内置系统声音采集失败：", error);
            nativeError = "客户端内置系统声音采集失败（画面不受影响）";
          }
          if (nativeError) {
            setNotice({
              kind: "info",
              sticky: true,
              text: `${nativeError}；可把 Windows 默认播放设备换成普通立体声扬声器后重试`,
            });
          }
        }
        // 传输方式：显式选择优先，"自动"按观众数决定（1~2 人直连、3 人以上 SFU）——
        // P2P 的上行是"码率 × 观众数"，3 人以上会把家用上行打爆（P1-11）。
        const decision = autoTransportFor(settings.shareTransport, memberCountRef.current);
        let transport = decision.transport;
        stepNoticeShown.current = false;
        /*
         * AV1 的**双端判断**：本机有 AV1 硬编，且房间里每一位观众都报了 AV1 硬解
         * （hello/名册里的 av1Decode），才允许把 AV1 提到 H.264 之前。
         * 只要有一位观众得软解 1080p60，对他是灾难（AV1 软解比 H.264 还重）。
         * 单人共享（没有别人）时按本机能力放开。
         */
        const probe = await probeHardwareEncoders(quality);
        const everyViewerAv1 = members.every((member) => member.local || member.av1Decode === true);
        const preferAv1 = probe.av1 && everyViewerAv1;
        // SFU 模式：先向 SFU 发布并拿会话 id；P2P 模式：直接用随机会话 id（画面走直连）
        let sessionId: string;
        let simulcast = false;
        let transportNote = "";
        if (transport === "sfu") {
          try {
            const pub = await publishScreen(stream, {
              quality,
              preferAv1,
              /*
               * **不再请求 simulcast 多档**（2026-10-14 实测定性）：
               * Chrome 的多档一律用 `SimulcastEncoderAdapter` 包软件编码器
               * （实测 `OpenH264, OpenH264, OpenH264`），硬件编码单元在这种模式下
               * **根本不会被采用**——同一台机器单档时是 `NVIDIA H.264 Encoder MFT`。
               * 结果是：三档软编 1080p60 跑不动（12.2ms/帧、CPU 受限），
               * 帧率被压到 24~30fps，而单档硬编能轻松跑 60fps（3.4ms/帧）。
               * 代价是观众端失去了"按自己网络挑层"的能力，换来的是一路高质量流：
               * SFU 出口本来就只有一份上行，观众各自按链路收——
               * 用帧率和编码效率换"弱网观众能挑小层"，不划算。
               * （订阅侧仍完整支持多档，看 1.4.0/1.4.1 的发布端不会出问题。）
               */
              simulcast: false,
              onStep: (point) => {
                if (stepNoticeShown.current) return;
                stepNoticeShown.current = true;
                setNotice({
                  kind: "info",
                  text: `网络吃紧，画质已自动降到 ${RESOLUTION_LADDER_LABEL[point.step] ?? "更低档"} · ${point.fps}fps 继续直播`,
                });
              },
            });
            sharePubRef.current = pub;
            sessionId = pub.sessionId;
            // 单档发布（见上面的说明）：simulcast 恒为 false，广播时也就没有分档信息
            simulcast = pub.simulcast;
          } catch (error) {
            // SFU 这条路走不通（跨境/被限流）时，别让用户"共享失败"——
            // 退回 P2P 直连，能出画面最重要。
            console.warn("[screen-share] SFU 发布失败，回落 P2P 直连", error);
            transport = "p2p";
            sessionId = randomSessionId();
            // 自动模式下本该走 SFU 却回落了：明确告知，避免"人多还直连"悄悄打爆上行
            transportNote =
              decision.transport === "sfu"
                ? "SFU 不可用，人数较多时已改用直连（可能偏卡）"
                : "SFU 转发没连上，已改用直连（画质优先）";
          }
        } else {
          sessionId = randomSessionId();
        }
        const ok = engine.requestScreenShare(
          {
            sessionId,
            trackName: TRACK_VIDEO,
            trackNameAudio: hasAudio ? TRACK_AUDIO : "",
            label: videoTrack.label || "屏幕共享",
            hasAudio,
            transport,
            // 订阅端据此把"实收分辨率"换算成订阅层（f/h/q）显示在灯箱上
            quality,
            ...(simulcast ? { simulcast: true } : {}),
          },
          transport === "p2p" ? stream : undefined,
          quality,
        );
        if (!ok) {
          // 电视被占用（本地预检或房主拒绝）：连 SFU 发布一起回滚，不留半开连接
          sharePubRef.current?.stop();
          sharePubRef.current = null;
          for (const track of stream.getTracks()) track.stop();
          setNotice({ kind: "error", text: "电视被别人占着，晚点再来" });
          return false;
        }
        shareLocalStreamRef.current = stream;
        setShareStream(stream);
        // 灯箱要显示"发送端"数据（编码分辨率/实际码率/限流原因/编码器）：
        // SFU 用自己的发布连接，P2P 用引擎里那条直连——共享者自己也得看得见，
        // 否则调档位就是闭眼掷骰子。
        setSharePc(
          transport === "sfu" ? (sharePubRef.current?.pc ?? null) : engine.screenSenderPeerConnection(),
        );
        /*
         * 用户在系统选择器里点"停止共享"（或画面被掐断）→ 走正常停播流程。
         *
         * ⚠️ **只认画面轨**。原先这里对整个 stream.getTracks() 都挂"ended → 停播"，
         * 于是"系统音频轨结束"也会把整个共享关掉：Windows 上回环采集建不起来的
         * 机器（虚拟声卡 / HDMI 无音频 / 蓝牙 / 独占模式 / 输出设备被禁用）
         * **一勾"共享系统音频"就整个共享秒消失**——画面本来是好的，被我们误判了。
         * 现在音频轨断了只提示、不停播：画面继续，声音没了。
         */
        for (const track of stream.getVideoTracks()) {
          track.addEventListener("ended", () => stopScreenShareRef.current({ viaTrackEnded: true }));
        }
        for (const track of stream.getAudioTracks()) {
          track.addEventListener("ended", () => {
            setNotice({
              kind: "info",
              text: "系统声音已断开（画面继续共享看）；需要声音请停播后重新共享",
            });
          });
        }
        setNotice({
          kind: "info",
          sticky: !hasAudio && systemAudioUnavailable,
          text: [
            hasAudio
              ? viaNativeAudio
                ? "共享已带上系统声音（客户端内置采集）；观众点幕布可开音量"
                : "共享已带上系统声音；观众点幕布可开音量。戴耳机可避免回声"
              : systemAudioUnavailable
                ? "此浏览器拿不到系统声音（多声道/虚拟声卡设备常见），已改为只共享画面。两个办法：把 Windows 默认播放设备换成普通立体声扬声器；或改用桌面客户端共享（内置采集，不受设备限制，首页可下载）"
                : "共享已开始（此来源没有可共享的声音）",
            transportNote,
          ]
            .filter(Boolean)
            .join("；"),
        });
        shareStartedAtRef.current = Date.now();
        return true;
      } catch (error) {
        // 采集成功但发布/申报失败的：必须停掉采集，否则系统的"正在共享"指示灯常亮
        for (const track of stream?.getTracks() ?? []) track.stop();
        // SFU 会话可能已经建起来了（发布成功但后续步骤抛错）：一并收掉，别留半开连接
        sharePubRef.current?.stop();
        sharePubRef.current = null;
        setSharePc(null);
        // 用户取消选择器（NotAllowedError）不算错误，静默返回
        if ((error as DOMException)?.name === "NotAllowedError") return false;
        // 带上错误名：用户截图给我们时能直接定位是哪类失败；置顶不自动消失
        const errorName = (error as DOMException)?.name || "未知错误";
        setNotice({
          kind: "error",
          sticky: true,
          text: `共享没开起来（${errorName}），语音不受影响，稍后再试`,
        });
        return false;
      }
    },
    // settings 必须在依赖里：菜单里刚改完"共享方式"就点开始，闭包得拿到新值；
    // members 用于 AV1 双端判断（每位观众是否都支持 AV1 硬解）。
    [screenShare, settings, members],
  );

  /** 停播：通知房主 + 停 SFU 发布 + 停采集。订阅侧由副作用自动清理。
   *  `viaTrackEnded`：画面轨被系统/浏览器掐断（不是用户主动停）→ 给出解释，
   *  尤其"刚启动就被中断"——那正是系统声音采集失败连累共享的现场。 */
  const stopScreenShare = useCallback((opts?: { viaTrackEnded?: boolean }) => {
    // engine 内部会判断：有状态且是本人 → 停播广播；广播未到的窗口期 → 仍发停播申报
    engineRef.current?.stopScreenShare();
    sharePubRef.current?.stop();
    sharePubRef.current = null;
    for (const track of shareLocalStreamRef.current?.getTracks() ?? []) track.stop();
    shareLocalStreamRef.current = null;
    // 客户端内置系统声音采集（WASAPI 回环）随停播一起收线
    void nativeLoopbackStopRef.current?.();
    nativeLoopbackStopRef.current = null;
    setShareStream(null);
    if (opts?.viaTrackEnded) {
      const justStarted = Date.now() - shareStartedAtRef.current < 8000;
      if (justStarted) {
        // 刚开播就被掐：用户没点停，必须解释（这正是系统声音采集失败的现场）
        setNotice({
          kind: "error",
          sticky: true,
          text: isTauriRuntime()
            ? "共享刚启动就被浏览器中断了。若反复出现，可把 Windows 默认播放设备换成普通立体声扬声器后再试"
            : "共享刚启动就被浏览器中断了。若刚勾选了系统声音，多半是系统声音采集失败连累了共享——建议改用桌面客户端共享（内置采集，不受设备限制，首页可下载）",
        });
      } else {
        setNotice({ kind: "info", text: "共享已结束" });
      }
    }
  }, []);

  /** track ended 回调要拿到最新闭包，经 ref 转发。 */
  const stopScreenShareRef = useRef<(opts?: { viaTrackEnded?: boolean }) => void>(() => {});
  stopScreenShareRef.current = stopScreenShare;
  /** 客户端内置系统声音采集的清理（停播/画面被掐断时一并停）。 */
  const nativeLoopbackStopRef = useRef<(() => void) | null>(null);
  /** 本次共享的开始时刻（判断"刚启动就被中断"用）。 */
  const shareStartedAtRef = useRef(0);

  /** `?tv=demo`：进房后自动用演示画面开播（真实 SFU 链路，无需点选择器）。 */
  const demoAutoStarted = useRef(false);
  useEffect(() => {
    if (demoAutoStarted.current) return;
    if (typeof location === "undefined") return;
    if (!debugTvDemoFrom(location.search)) return;
    if (status !== "connected" || screenShare) return;
    const engine = engineRef.current;
    if (!engine?.isJoined) return;
    const demo = createDemoStream();
    if (!demo) return;
    demoAutoStarted.current = true;
    void (async () => {
      try {
        const decision = autoTransportFor(settings.shareTransport, memberCountRef.current);
        let transport = decision.transport;
        let sessionId: string;
        let simulcast = false;
        if (transport === "sfu") {
          try {
            const pub = await publishScreen(demo, { quality: "fhd1080", simulcast: false });
            sharePubRef.current = pub;
            sessionId = pub.sessionId;
            simulcast = pub.simulcast;
          } catch {
            transport = "p2p";
            sessionId = randomSessionId();
          }
        } else {
          sessionId = randomSessionId();
        }
        const ok = engine.requestScreenShare(
          {
            sessionId,
            trackName: TRACK_VIDEO,
            trackNameAudio: "",
            label: "演示画面",
            hasAudio: false,
            transport,
            quality: "fhd1080",
            ...(simulcast ? { simulcast: true } : {}),
          },
          transport === "p2p" ? demo : undefined,
          "fhd1080",
        );
        if (!ok) return;
        shareLocalStreamRef.current = demo;
        setShareStream(demo);
        setSharePc(
          transport === "sfu" ? (sharePubRef.current?.pc ?? null) : engine.screenSenderPeerConnection(),
        );
      } catch {
        /* 演示模式失败就当没这回事 */
      }
    })();
  }, [status, screenShare]);

  /**
   * 提示条自动消失。
   *
   * 之前 setNotice 只负责设置、**没有任何地方清除**，所以"已复制"这类提示
   * 会一直挂在页面上直到用户手动点 ×（实测就是这个现象）。
   * 按类型分档：操作成功的提示很快收掉，错误留久一点让人看清。
   */
  useEffect(() => {
    if (!notice || notice.sticky) return;
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

  /**
   * 启动即预热 ICE 配置（TURN 凭据）。
   *
   * 放到首页而不是进房时才拉，是因为进房路径上只给它 2.5 秒——在用户点"加入"
   * 到真正拨号之间把这次网络往返藏掉，跨网用户第一次点就能用上中继。
   * 失败无所谓：进房路径自己会再试，且拿不到就退回纯 STUN。
   */
  useEffect(() => {
    void refreshIceServers();
  }, []);

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

  /** 屏幕共享画质档位（开播时生效；落盘）。 */
  const setShareQuality = useCallback(
    (quality: ShareQuality) => {
      persistSettings({ ...settings, shareQuality: quality });
    },
    [persistSettings, settings],
  );

  const setShareTransport = useCallback(
    (transport: "p2p" | "sfu" | "auto") => {
      persistSettings({ ...settings, shareTransport: transport });
    },
    [persistSettings, settings],
  );

  /**
   * 观众端切换画质偏好（自动 / 清晰优先 / 流畅优先）。
   *
   * 三条落点：① 落盘（下次进房还用这个偏好）；② 告诉引擎——P2P 模式下由它
   * 经房主转达给共享者、只影响本机这一路发送链；③ SFU 模式下订阅副作用会
   * 因为偏好变化自动重订阅到对应层（见 shareViewMode 的依赖）。
   */
  const setShareViewMode = useCallback(
    (mode: ScreenViewPreference) => {
      persistSettings({ ...settings, shareViewMode: mode });
      engineRef.current?.setScreenViewPreference(mode);
    },
    [persistSettings, settings],
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
    // 屏幕共享（围炉看 TV）
    screenShare,
    shareStream,
    sharePc,
    startScreenShare,
    stopScreenShare,
    shareQuality: settings.shareQuality,
    setShareQuality,
    shareTransport: settings.shareTransport,
    setShareTransport,
    shareViewMode: settings.shareViewMode,
    setShareViewMode,
  };
}
