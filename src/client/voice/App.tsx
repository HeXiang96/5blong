import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { preloadRnnoise } from "./engine";
import { shouldShowOnboarding } from "./onboarding";
import { hostPeerIdForCode, isJoinInFlight, makeRoomCode, randomIndex } from "./protocol";
import { ensureRoomKey, migrateRoomKey, normalizeFixedRoomCode } from "./my-room";
import { useVoice } from "./use-voice";
import { ConfirmView, LandingView, SessionSummaryCard } from "./components/pages";
import { RoomView } from "./components/RoomView";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { OnboardingDialog } from "./components/OnboardingDialog";
import { WhatsNewDialog } from "./components/WhatsNewDialog";
import { shouldShowWhatsNew } from "./whats-new";
import { SettingsView } from "./components/SettingsView";
import { AccountDialog, FriendsDrawer } from "./components/AccountPanels";
import { FriendRequestToast } from "./components/FriendRequestToast";
import { KnockToast } from "./components/KnockToast";
import { buildInviteText } from "./invite-text";
import { LocalAccountAdapter, seedDemoAccounts } from "./account/local-adapter";
import { WorkerAccountAdapter } from "./account/worker-adapter";
import { startInbox, type InboxHandle } from "./account/inbox";
import { useAccount } from "./account/use-account";
import {
  ACCOUNT_ERROR_TEXT,
  type AccountProfile,
  type Knock,
  type RecentPlay,
  type RoomInvite,
} from "./account/types";
import { Banner } from "./components/ui";
import { gameCodeFromUrl } from "../game/game-links";
/*
 * 开黑圈整体懒加载（含 useGame 与 1088 行的 game-mesh）：不进首屏包，
 * 只有点击入口或带 ?g= 打开时才下载。首屏 JS 从 568KB 降到预计 400KB 级。
 */
const GameEntry = lazy(() => import("../game/GameEntry").then((m) => ({ default: m.GameEntry })));

export function App() {
  /*
   * 账号是**可选增强层**：不登录一切照旧。
   * - 线上：WorkerAccountAdapter（Pages Worker 的 /api/account，数据在 D1）；
   * - 本地 vite dev：没有 Worker，用 LocalAccountAdapter 演示（两个窗口 = 两台设备）；
   * - `?local-account=1` 可在线上强制用本地适配器（调试用，不影响别人）。
   */
  const [accountAdapter] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const forceLocal = import.meta.env.DEV || params.has("local-account");
    if (!forceLocal) return new WorkerAccountAdapter();
    const adapter = new LocalAccountAdapter();
    // 预览入口：?account=demo 时种两个演示账号，一个人也能点完加好友闭环
    // 注意：URL 是 ?account=demo，键是 account、值是 demo —— 不能写成 params.has("account=demo")
    if (params.get("account") === "demo" && !sessionStorage.getItem("5blong.demoSeeded")) {
      // 只种一次并刷新一次，避免死循环
      sessionStorage.setItem("5blong.demoSeeded", "1");
      void seedDemoAccounts().then(() => window.location.reload());
    }
    return adapter;
  });
  const [accountOpen, setAccountOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  /*
   * 好友快照的节奏随面板状态走（2026-10-27）：
   * - 面板开着 → 20 秒，看到的就是"现在"（谁会为了一分钟前的状态点开面板）；
   * - 关着 → 90 秒（业主 10-26 定的额度口径，绝大多数时间面板是关的）。
   * 只影响 /friends 一个接口，邀请/敲门走下面那条更短的节奏。
   */
  const account = useAccount(accountAdapter, { pollMs: friendsOpen ? 20_000 : 90_000 });
  /*
   * 房间内收到好友请求：排一条轻提示，能就地同意（不用退出房间去好友面板）。
   * seen 记录已经提示过的账号，避免每次刷新重复弹。
   */
  const [incomingQueue, setIncomingQueue] = useState<string[]>([]);
  const seenRequests = useRef<Set<string>>(new Set());

  const voice = useVoice();

  /*
   * 固定房号「我的房间 235417」**只属于登录账号**（业主 2026-10-26 口径）：
   * - 房号存在账号档案里（accountAdapter.updateProfile({ roomCode })），换设备登录
   *   同一个账号还是这个号；
   * - 房间钥匙存在本机、按账号分开（my-room.ts）——它只给邀请链接签证明；
   * - 未登录 → 开的是随机房号的一次性房间，首页也不会出现「我的房间」。
   */
  const myRoomCode = account.me?.roomCode ?? null;

  /**
   * 好友发来的房间邀请。
   *
   * 业主口径（2026-10-26）：**不能只靠弹窗**——没看见、在忙、关了电脑就耽误了。
   * 所以邀请存在后端（room_invites），好友抽屉里留档，
   * 顶栏「好友」图标上的红点把「请求 + 邀请」一起算进去。
   *
   * 拉取节奏（2026-10-26 业主质疑请求量后改）：邀请**没有任何实时通道**，
   * 轮询间隔就等于邀请延迟，所以只在收件箱连上时才敢放慢：
   * - 收件箱连着 → 60 秒兜底一次（正常由服务端推送触发，这是防漏网）；
   * - 收件箱断开 → 回到 8 秒（代理/弱网下推送不可用，轮询就是唯一通路）。
   */
  const [invites, setInvites] = useState<RoomInvite[]>([]);
  /** 我收到的敲门（房主侧）：10 分钟内有效，同意后转成一条带钥匙的邀请 */
  const [knocks, setKnocks] = useState<Knock[]>([]);
  /** 最近一起玩过的人：只在打开好友面板时拉，随快照一起展示 */
  const [recentPlays, setRecentPlays] = useState<RecentPlay[]>([]);
  const [inboxLive, setInboxLive] = useState(false);
  /**
   * 服务端声明"在线状态我代管"（收件箱里 `presence: true`）。
   * 只有它为 true 才停掉 30 秒的 HTTP 心跳 —— 否则好友会全员离线。
   */
  const [inboxPresence, setInboxPresence] = useState(false);
  const inboxRef = useRef<InboxHandle | null>(null);
  /**
   * 收件箱回调里要"拉一次账号数据"，但把 `account` 塞进 effect 依赖会让它
   * 每次渲染都重连。用 ref 拿最新的 refresh（useCallback 本身稳定，这里只是
   * 让依赖数组保持干净）。
   */
  const refreshAccountRef = useRef(account.refresh);
  refreshAccountRef.current = account.refresh;
  useEffect(() => {
    if (!account.me) {
      setInvites([]);
      setKnocks([]);
      setRecentPlays([]);
      return;
    }
    let alive = true;
    let tick = 0;
    const load = () => {
      void accountAdapter.invites().then((list) => {
        if (alive) setInvites(list);
      });
      /*
       * 敲门单独放慢：inbox 断开时这条循环是 8 秒一轮，
       * 每轮都拉 /knocks 会在弱网环境下多花一个数量级的请求，
       * 所以只在"推送可用"或每第 8 轮（≈64 秒）兜底拉一次。
       */
      if (inboxLive || tick === 0 || tick % 8 === 0) {
        void accountAdapter.knocks().then((list) => {
          if (alive) setKnocks(list);
        });
      }
      tick += 1;
    };
    load();
    const timer = window.setInterval(load, inboxLive ? 60_000 : 8_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [account.me?.id, accountAdapter, inboxLive]);

  /*
   * 账号收件箱：登录后挂一条常驻连接，服务端存完邀请就敲一下。
   *
   * 收到的提示**只当"去拉一次"**：界面数据永远来自 /invites，
   * 所以推送即使被伪造也变不出假邀请。切账号/登出必须清理，
   * 否则旧连接会在后台一直重连上一个账号。
   */
  useEffect(() => {
    const meId = account.me?.id;
    if (!meId) {
      setInboxLive(false);
      setInboxPresence(false);
      return;
    }
    const handle = startInbox(meId, {
      onInvite: () => {
        void accountAdapter.invites().then(setInvites);
        // 敲门复用 INVITE 这条提示（见 worker 里的说明：不改信令 Worker 的推送白名单）
        void accountAdapter.knocks().then(setKnocks);
      },
      /*
       * 好友关系变了（对方加我/同意我/拒绝我/删我）：立刻拉一次全量快照。
       * 90 秒轮询下，原来的红点最坏要等一分半才亮；有了这条就是秒级。
       * 推送只带"去拉一次"这个指令，数据永远来自查询接口，伪造不了。
       */
      onFriend: () => {
        void refreshAccountRef.current();
      },
      onStatus: (status) => setInboxLive(status === "live"),
      onPresence: (enabled) => setInboxPresence(enabled),
    });
    inboxRef.current = handle;
    return () => {
      inboxRef.current = null;
      handle.close();
    };
  }, [account.me?.id, accountAdapter]);

  /**
   * 打开好友面板时先拉一次快照（2026-10-27）。
   *
   * 好友快照是 20 秒一轮（面板关着是 90 秒），如果只靠定时器，点开面板那一刻看到的
   * 可能是上一轮的数据 —— 刚被同意的好友还没出现、刚发的请求还没消。
   * 每次点开多 1 次请求，换来"看到的就是现在"，很划算。
   *
   * 「最近一起玩」也在这时候拉：它只在面板里有用，没必要常驻轮询。
   */
  useEffect(() => {
    if (!friendsOpen) return;
    void refreshAccountRef.current();
    if (!account.me) return;
    void accountAdapter.recentPlays().then(setRecentPlays);
  }, [friendsOpen, account.me?.id, accountAdapter]);

  /**
   * 后台改过数字 ID：把本机房间钥匙搬到新 ID 名下，再告诉服务端已迁移。
   * 不做这一步，房号还在、但之前发出去的邀请链接会全部失效。
   *
   * 只许跑一次（业主实拍 bug，2026-10-26）：原来的依赖里有整个 `voice` 对象，
   * 而它是每次渲染都新建的字面量 → 这个 effect 每渲染必跑 → 每次都 setNotice
   * 一个新对象 → 再渲染 → 再跑，形成自激循环。表现就是这条提示**永远退不掉**：
   * use-voice 里的自动消失计时器被反复重置，点 × 也会被立刻重新挂上。
   * 现在依赖只留原始值 + 稳定的 setNotice，并用 ref 按「旧 ID→新 ID」去重。
   */
  const ackIdChangeDoneRef = useRef<string | null>(null);
  const setNotice = voice.setNotice;
  useEffect(() => {
    const me = account.me;
    if (!me?.previousId || me.previousId === me.id) return;
    const key = `${me.previousId}->${me.id}`;
    if (ackIdChangeDoneRef.current === key) return;
    ackIdChangeDoneRef.current = key;
    const moved = migrateRoomKey(me.previousId, me.id);
    void accountAdapter.ackIdChange();
    setNotice({
      kind: "info",
      text: moved
        ? `你的账号 ID 已更新为 ${me.id}，房间钥匙已迁过来，旧邀请链接继续有效`
        : `你的账号 ID 已更新为 ${me.id}`,
    });
  }, [account.me?.id, account.me?.previousId, accountAdapter, setNotice]);

  /*
   * 在线状态：进/出房时报一次房号就够了，不再自己每 30 秒打 HTTP。
   *
   * 为什么能省：收件箱那条常驻连接本身就是"我在线"的证据，服务端每 30 秒
   * 把所有挂着的连接统一写进 account_presence（一个 DO alarm 管所有人，
   * 一天固定 2,880 次，不随在线人数增长）。原来的做法是**每个窗口**每 30 秒
   * 一次 HTTP，20 个人就是一天上万次。
   *
   * 前提：必须等服务端回 `presence: true`。老版本 Worker、没绑 D1、
   * 或者收件箱断开时，一律退回原来的 HTTP 心跳 —— 这里绝不能想当然。
   */
  useEffect(() => {
    if (!account.me) return;
    const room = voice.invite?.code;
    if (inboxPresence) {
      inboxRef.current?.setRoom(room);
      return;
    }
    accountAdapter.heartbeat(room);
    const timer = window.setInterval(() => accountAdapter.heartbeat(room), 30_000);
    return () => window.clearInterval(timer);
  }, [account.me?.id, voice.invite?.code, accountAdapter, inboxPresence]);

  /** 加入邀请：先消掉这条记录，再走正常的进房流程（私密房会就地要临时密码）。 */
  const joinInvite = useCallback(
    (invite: RoomInvite) => {
      setInvites((list) => list.filter((item) => item.from.id !== invite.from.id));
      void accountAdapter.dismissInvite(invite.from.id);
      setFriendsOpen(false);
      /*
       * 带钥匙就按"完整邀请链接"进（一键直达）；没钥匙（普通房 / 老邀请）只给房号。
       * 这里拼的是协议内用的 fragment 形式：#c=房号&h=房主ID&k=钥匙
       */
      const raw = invite.roomKey
        ? `#c=${invite.code}&h=${hostPeerIdForCode(invite.code)}&k=${invite.roomKey}`
        : invite.code;
      voice.submitJoinInput(raw);
    },
    [accountAdapter, voice],
  );

  const dismissInvite = useCallback(
    (invite: RoomInvite) => {
      setInvites((list) => list.filter((item) => item.from.id !== invite.from.id));
      void accountAdapter.dismissInvite(invite.from.id);
    },
    [accountAdapter],
  );

  /**
   * 邀请好友进我这间房：
   * 先走推送（对方好友面板里会留一条记录，离线也不丢）；推送不了才退回复制文案。
   * 私密房还要额外把临时密码告诉他——密码不进库，只能房主自己发。
   */
  const inviteFriend = useCallback(
    async (target: AccountProfile) => {
      const code = voice.invite?.code;
      if (!code) return false;
      // 私密房必须连钥匙一起推：只给房号，对方点「加入」只会被要求临时密码
      const roomKey = voice.privateRoom ? voice.invite?.roomKey : undefined;
      const result = await accountAdapter.sendInvite(target.id, code, roomKey);
      if (!result.error) {
        voice.setNotice({
          kind: "info",
          text: voice.privateRoom
            ? `已邀请 ${target.name}：他在好友面板的「邀请」里点一下就能进来`
            : `已邀请 ${target.name}，他在好友面板的「邀请」里能看到`,
        });
        return true;
      }
      // 推送不通（还不是好友 / 后端未上线）→ 退回"复制文案"，别让按钮点了没反应
      return voice.copyText(
        buildInviteText(code, {
          count: voice.members.length,
          topic: voice.topic,
          pass: voice.privateRoom && voice.guestPass ? voice.guestPass : undefined,
        }),
        "已复制邀请，直接发给他",
      );
    },
    [accountAdapter, voice],
  );

  /**
   * 敲门（2026-10-27）：好友在别的房间、而我进不去时用。
   *
   * 为什么不是"直接进"：私密房没有钥匙就是进不去，硬闯只会看到"需要临时密码"。
   * 所以改成请求——房主同意后，由**他的客户端**把带钥匙的邀请发回来，
   * 安全边界和"只有房主能邀请"完全一致。
   */
  const knockFriend = useCallback(
    async (target: AccountProfile) => {
      const result = await accountAdapter.knock(target.id);
      if (result.error) {
        voice.setNotice({ kind: "error", text: ACCOUNT_ERROR_TEXT[result.error] });
        return false;
      }
      voice.setNotice({
        kind: "info",
        text: `已请求进入 ${target.name} 的房间，等他同意（他同意后会在「待处理」里出现一条邀请）`,
      });
      return true;
    },
    [accountAdapter, voice],
  );

  /** 房主同意敲门：把我这间房（私密房连钥匙）作为邀请发给他。 */
  const acceptKnock = useCallback(
    (knock: Knock) => {
      const code = voice.invite?.code;
      if (!code) return;
      const roomKey = voice.privateRoom ? voice.invite?.roomKey : undefined;
      setKnocks((list) => list.filter((item) => item.from.id !== knock.from.id));
      void accountAdapter.acceptKnock(knock.from.id, code, roomKey).then((result) => {
        voice.setNotice(
          result.error
            ? { kind: "error", text: ACCOUNT_ERROR_TEXT[result.error] }
            : {
                kind: "info",
                text: voice.privateRoom
                  ? `已放 ${knock.from.name} 进来：他那边收到的是带钥匙的邀请，点一下就能进`
                  : `已放 ${knock.from.name} 进来：他那边会收到一条邀请`,
              },
        );
      });
    },
    [accountAdapter, voice],
  );

  const dismissKnock = useCallback(
    (knock: Knock) => {
      setKnocks((list) => list.filter((item) => item.from.id !== knock.from.id));
      void accountAdapter.dismissKnock(knock.from.id);
    },
    [accountAdapter],
  );

  /** 主操作：有账号就开自己那间，没登录就随手开一间。 */
  const startRoom = useCallback(async () => {
    const me = account.me;
    if (!me) {
      await voice.createRoom();
      return;
    }
    let code = me.roomCode ?? "";
    if (!code) {
      // 第一次开房才分配房号：不登录不占号，登录了也只占一个。
      const fresh = makeRoomCode(randomIndex);
      const result = await accountAdapter.updateProfile({ roomCode: fresh });
      if (result.account) {
        code = fresh;
        void account.refresh();
      } else {
        // 极少见（本机存储写不进去）：这次先开随机房，下次再试
        voice.setNotice({ kind: "error", text: "房号没能存进账号，这次先开一间临时的" });
      }
    }
    // 自己账号的固定房号 = 私密房：只认邀请链接或临时密码（业主 2026-10-26 口径）
    await voice.createRoom(code ? { code, roomKey: ensureRoomKey(me.id), private: true } : undefined);
  }, [account, accountAdapter, voice]);

  /** 手填固定房号（6 位）。被别的账号占了就返回 false，让首页就地报错。 */
  const claimRoomCode = useCallback(
    async (raw: string) => {
      const me = account.me;
      if (!me) return false;
      const code = normalizeFixedRoomCode(raw);
      if (!code) return false;
      const result = await accountAdapter.updateProfile({ roomCode: code });
      if (result.error) {
        // 别只回 false：被占用和已锁定要让人分清（前者还能换，后者没机会了）
        voice.setNotice({ kind: "error", text: ACCOUNT_ERROR_TEXT[result.error] });
        return false;
      }
      void account.refresh();
      voice.setNotice({ kind: "info", text: `固定房号已改成 ${code}` });
      return true;
    },
    [account, accountAdapter, voice],
  );


  /**
   * 房主刷新 / 关页前确认（2026-10-27 业主实拍）。
   *
   * 屏蔽右键只是关掉**一个**误触入口：F5、点地址栏刷新、习惯性关标签页都还在。
   * P2P 房间跟着房主存在，房主一刷新，其他人集体掉线——所以这里再兜一层系统确认。
   *
   * 只对房主生效（`voice.invite` 非空 = 我是这间房的主人），访客刷新只影响自己。
   * 开发环境跳过：dev 下每次热更新都弹，没法干活。
   */
  useEffect(() => {
    const code = voice.invite?.code;
    if (!code || import.meta.env.DEV) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // 现代浏览器不显示自定义文案，但必须给 returnValue 一个值才会真的拦一下
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [voice.invite?.code]);

  // 账号 ID 只用于「加好友」：登录/退出时同步给引擎，不参与任何进房校验
  useEffect(() => {
    voice.setAccountId(account.me?.id ?? null);
  }, [account.me?.id, voice.setAccountId]);

  // 发现"新的"好友请求 → 入队（同一个账号只提示一次）
  useEffect(() => {
    const fresh = account.snapshot.incoming
      .map((request) => request.account.id)
      .filter((id) => !seenRequests.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seenRequests.current.add(id);
    setIncomingQueue((queue) => [...queue, ...fresh]);
  }, [account.snapshot.incoming]);

  /*
   * 登录后昵称/头像跟随账号（2026-10-26 反馈："房间里的名字和外面不同步"）。
   * 账号是权威，房间只是展示——所以登录时把本地身份对齐到账号，
   * 而不是反过来。未登录时仍然用本地昵称，行为不变。
   */
  useEffect(() => {
    const me = account.me;
    if (!me) return;
    if (voice.identity.name === me.name && voice.identity.avatar === me.avatar) return;
    voice.setIdentity({ ...voice.identity, name: me.name, avatar: me.avatar });
  }, [account.me, voice.identity, voice.setIdentity]);
  /*
   * 开黑圈是**独立子系统**：引擎、状态、界面都不复用语音房
   * （语音房的连接拓扑/共享/猪圈互动对开黑圈都不适用）。
   * 它整体住在懒加载的 <GameEntry/> 里，App 只保留三个轻量状态：
   * 是否挂载、该弹哪个窗、是否已接管整屏（接管时卸载首页，省掉猪圈动画的 CPU）。
   */
  const [gameMounted, setGameMounted] = useState<boolean>(() => !!gameCodeFromUrl());
  const [gamePrompt, setGamePrompt] = useState<"create" | "join" | null>(() =>
    gameCodeFromUrl() ? "join" : null,
  );
  const [gameActive, setGameActive] = useState(false);
  const openGame = useCallback((prompt: "create" | "join") => {
    setGameMounted(true);
    setGamePrompt(prompt);
  }, []);
  const closeGamePrompt = useCallback(() => setGamePrompt(null), []);

  /*
   * 打开页面就预热 AI 降噪（RNNoise）的 wasm/worklet 资源：
   * 不需要麦克风权限，进房开启智能降噪时秒生效。
   */
  useEffect(() => {
    preloadRnnoise();
  }, []);

  /*
   * 把标签页可见性同步到 <html data-vx-hidden>，供样式表停掉挂机时的循环动画。
   * 猪圈的常驻动画有近 40 个（infinite），开黑挂两三个小时时它们一直烧 CPU；
   * 切到后台或最小化时停掉，回来立刻恢复。
   */
  useEffect(() => {
    const sync = () => {
      document.documentElement.dataset["vxHidden"] = document.hidden ? "1" : "0";
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  /*
   * 从**房间里**打开设置：房间保持挂载、设置盖在上面。
   *
   * 曾经的实现是整页切走（early return），后果是房主一进设置，8 个
   * PigActor 全部卸载 → 位置快照清空 → 房主停止广播 → **全房间的猪
   * 瞬间冻结**；回来时整棵重建，还伴随一波挂载卡顿与位置跳变。
   * 现在设置页是覆盖层，猪圈在下面继续走、广播不断，回来无缝。
   */
  const settingsOverRoom = voice.view === "settings" && voice.settingsReturn === "room";

  /*
   * 意见反馈弹窗：三处入口共用一份 state——设置页、错误提示条（带错误原文）、
   * 以及桌面端托盘菜单（Rust 侧发 feedback:open 事件，见下方 effect）。
   */
  const [feedback, setFeedback] = useState<{ open: boolean; errorText?: string }>({ open: false });
  const openFeedback = useCallback((errorText?: string) => setFeedback({ open: true, errorText }), []);
  const closeFeedback = useCallback(() => setFeedback({ open: false }), []);

  /*
   * 首次打开的功能导览：**只在首页**、首帧之后再弹（等场景画出来，不抢首帧）。
   * 通过邀请链接直接进房的人不打扰——那时 view 不是 landing，等他回首页自然会看到。
   * `?tv=demo`（调试/全链路验证）跳过，免得挡着自动开播。
   */
  /**
   * 房间内"昵称 → 账号 ID"兜底映射：旧客户端（1.8.9 之前）名册不带 accountId，
   * 但好友在服务端的心跳里报过"自己在哪个房"。同房同名唯一匹配才收录，
   * 同名多人置空串放弃匹配——宁可显示"版本较旧"，也不把好友请求发错人。
   */
  const friendsInRoomByName = useMemo(() => {
    const map = new Map<string, string>();
    const code = voice.roomCode;
    if (!code) return map;
    for (const { account: friend, presence } of account.snapshot.friends) {
      if (presence.roomCode !== code || !friend.name) continue;
      if (map.has(friend.name)) map.set(friend.name, "");
      else map.set(friend.name, friend.id);
    }
    return map;
  }, [account.snapshot.friends, voice.roomCode]);

  /**
   * 「最近一起玩」上报（2026-10-27）。
   *
   * 名册里本来就带 accountId（1.8.9 起），所以"同房过"这件事客户端最清楚。
   * 只报有账号的人；服务端再校验账号是否存在、去重、7 天过期、最多 30 条。
   *
   * 为什么节流 5 分钟：进房、切页面、成员进出都会让这段重跑，
   * 每次重渲染写一次库的话，一个下午就能把 D1 写额度磨掉。
   */
  const roomMemberIds = useMemo(
    () =>
      voice.members
        .map((member) => member.accountId)
        .filter((id): id is string => Boolean(id))
        .sort(),
    [voice.members],
  );
  const roomMemberKey = roomMemberIds.join(",");
  const lastReportRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  useEffect(() => {
    const me = account.me;
    if (!me || !roomMemberKey) return;
    const ids = roomMemberIds.filter((id) => id !== me.id);
    if (ids.length === 0) return;
    const now = Date.now();
    if (lastReportRef.current.key === roomMemberKey && now - lastReportRef.current.at < 300_000) {
      return;
    }
    lastReportRef.current = { key: roomMemberKey, at: now };
    void accountAdapter.reportRecentPlays(ids);
  }, [account.me?.id, roomMemberKey, accountAdapter]);

  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  useEffect(() => {
    if (voice.view !== "landing") return;
    if (typeof location !== "undefined" && /[?&]tv=demo/.test(location.search)) return;
    if (!shouldShowOnboarding()) return;
    const timer = window.setTimeout(() => setOnboardingOpen(true), 500);
    return () => window.clearTimeout(timer);
  }, [voice.view]);
  const closeOnboarding = useCallback(() => setOnboardingOpen(false), []);
  const closeWhatsNew = useCallback(() => setWhatsNewOpen(false), []);

  /*
   * 大更新公告：只在首页、且导览没弹的时候弹，避免两个弹窗叠一起。
   * 导览关掉之后会重新跑一遍（依赖 onboardingOpen）。
   */
  useEffect(() => {
    if (voice.view !== "landing") return;
    if (onboardingOpen) return;
    if (typeof location !== "undefined" && /[?&]tv=demo/.test(location.search)) return;
    if (!shouldShowWhatsNew()) return;
    const timer = window.setTimeout(() => setWhatsNewOpen(true), 700);
    return () => window.clearTimeout(timer);
  }, [voice.view, onboardingOpen]);
  useEffect(() => {
    const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isDesktop) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("feedback:open", () => setFeedback({ open: true })))
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {
        /* 事件桥不可用不影响设置页里的入口 */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /*
   * "正在进房"的统一定义（preparing / connecting / reconnecting），
   * 首页与确认页共用一份。reconnecting 必须算进来：那是超时后的自动整体重拨，
   * 以前不认它，确认页会在那 24 秒里把按钮变回"加入并开麦"，看着像没在连。
   */
  const joinInFlight = isJoinInFlight(voice.status);

  /*
   * 桌面端标题栏颜色跟随主题与时段（覆盖层/房间/首页都协调）：
   * 深色外观跟 --vx-bg，浅色外观跟各时段天空顶色。
   * 用 MutationObserver 监听 html 属性变化，主题/时段一变就同步。
   */
  useEffect(() => {
    const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isDesktop) return;
    const SKY_TOP: Record<string, string> = {
      morning: "#f9e9e3",
      day: "#f7e9d4",
      dusk: "#f8e3c8",
      night: "#171c2c",
    };
    const apply = () => {
      const theme = document.documentElement.dataset.theme;
      const daypart = document.documentElement.dataset.daypart ?? "day";
      const color =
        theme === "dark" ? "#14110d" : (SKY_TOP[daypart] ?? "#f7e9d4");
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("set_window_bg", { color }))
        .catch(() => {});
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-daypart"],
    });
    return () => observer.disconnect();
  }, []);

  if (voice.view === "settings" && !settingsOverRoom) {
    return (
      <>
        <SettingsView
          identity={voice.identity}
          settings={voice.settings}
          onSave={voice.saveAll}
          onClose={voice.closeSettings}
          onNotice={(kind, text) => voice.setNotice({ kind, text })}
          onOpenFeedback={openFeedback}
          onOpenOnboarding={() => setOnboardingOpen(true)}
          onExportDiagnostics={() => void voice.exportDiagnostics()}
        />
        <FeedbackDialog
          open={feedback.open}
          errorText={feedback.errorText}
          onCollectDiagnostics={voice.collectDiagnostics}
          onClose={closeFeedback}
        />
        <OnboardingDialog open={onboardingOpen} onClose={closeOnboarding} />
        <WhatsNewDialog open={whatsNewOpen} onClose={closeWhatsNew} />
      </>
    );
  }

  // ---------------------------------------------------------------- 开黑圈
  /*
   * 懒加载图层：挂载后常驻（进出房间不重建引擎）；gameActive（房间/结算接管整屏）
   * 时首页整体卸载，避免猪圈那几十个常驻动画在开黑的两三个小时里背后空转。
   */
  const gameLayer = gameMounted ? (
    <Suspense fallback={null}>
      <GameEntry prompt={gamePrompt} onPromptConsumed={closeGamePrompt} onActiveChange={setGameActive} />
    </Suspense>
  ) : null;

  if (voice.view === "confirm" && voice.pending) {
    return (
      <ConfirmView
        code={voice.pending.code}
        hostId={voice.pending.hostId || voice.pending.code}
        identity={voice.identity}
        joining={joinInFlight}
        error={voice.joinError}
        onJoin={(muted) => void voice.joinRoom(voice.pending!, muted)}
        onCancel={voice.cancelJoin}
        onSettings={voice.openSettings}
        settings={voice.settings}
      />
    );
  }

  if (voice.view === "room" || settingsOverRoom) {
    return (
      <>
      <RoomView
        selfAccountId={account.me?.id ?? null}
        onOpenAccount={() => setAccountOpen(true)}
        friendRequestCount={account.snapshot.incoming.length + invites.length + knocks.length}
        onOpenFriends={() => setFriendsOpen(true)}
        friendAccountIds={new Set(account.snapshot.friends.map((entry) => entry.account.id))}
        onAddFriend={(accountId) =>
          accountAdapter.addFriend(accountId).then((result) => {
            void account.refresh();
            return !result.error;
          })
        }
        status={voice.status}
        friendsInRoomByName={friendsInRoomByName}
        members={voice.members}
        speaking={voice.speaking}
        messages={voice.messages}
        invite={voice.invite}
        notice={voice.notice}
        audioBlocked={voice.audioBlocked}
        onResumeAudio={voice.resumeAudio}
        chatOpen={voice.chatOpen}
        unread={voice.unread}
        displayNames={voice.displayNames}
        isHost={voice.invite !== null}
        maxMembers={voice.maxMembers}
        onCopyCode={() => {
          // 把真实结果交回给界面：只有复制成功才打勾（评审 #6）
          if (!voice.invite) return Promise.resolve(false);
          return voice.copyText(voice.invite.code, `房间码 ${voice.invite.code} 已复制`);
        }}
        onCopyInvite={voice.copyInvite}
        privateRoom={voice.privateRoom}
        guestPass={voice.guestPass}
        onRenewGuestPass={voice.renewGuestPass}
        onCloseGuestPass={voice.closeGuestPass}
        onCopyPassInvite={voice.copyPassInvite}
        onToggleMute={voice.toggleMute}
        onToggleChat={voice.toggleChat}
        onLeave={voice.leave}
        onSettings={voice.openSettings}
        onSend={voice.sendChat}
        onDismissNotice={() => voice.setNotice(null)}
        micVolume={voice.micVolume}
        onSetMicVolume={voice.setMicVolume}
        onSetPeerVolume={voice.setPeerVolume}
        onTogglePeerMuted={voice.togglePeerMuted}
        onGetPeerAudio={voice.getPeerAudio}
        processing={voice.processing}
        captureLive={voice.captureLive}
        penEvents={voice.penEvents}
        onReportPenActor={voice.reportPenActor}
        getPenPosition={voice.getPenPosition}
        onSetNoiseSuppression={voice.setNoiseSuppression}
        onSetProcessingFlag={voice.setProcessingFlag}
        mediaStates={voice.mediaStates}
        roomLocked={voice.roomLocked}
        deaf={voice.deaf}
        interactions={voice.interactions}
        feedCounts={voice.feedCounts}
        onToggleDeaf={voice.toggleDeaf}
        onKick={voice.kickMember}
        onForceMute={voice.forceMute}
        onToggleLock={voice.toggleRoomLock}
        onInteract={voice.interact}
        onRetryLink={voice.retryMemberLink}
        topic={voice.topic}
        onSetTopic={voice.setRoomTopic}
        sceneTheme={voice.sceneTheme}
        screenShare={voice.screenShare}
        shareStream={voice.shareStream}
        sharePc={voice.sharePc}
        onStartShare={(quality) => void voice.startScreenShare(quality)}
        onStopShare={voice.stopScreenShare}
        shareQuality={voice.shareQuality}
        onSetShareQuality={voice.setShareQuality}
        shareTransport={voice.shareTransport}
        onSetShareTransport={voice.setShareTransport}
        shareAudio={voice.shareAudio}
        onSetShareAudio={voice.setShareAudio}
        shareAppPid={voice.shareAppPid}
        onSetShareAppPid={voice.setShareAppPid}
        shareFallbackDuck={voice.shareFallbackDuck}
        onSetShareFallbackDuck={voice.setShareFallbackDuck}
        shareLatency={voice.shareLatency}
        onSetShareLatency={voice.setShareLatency}
        onWatchScreen={voice.setScreenWatch}
        shareViewMode={voice.shareViewMode}
        onSetShareViewMode={voice.setShareViewMode}
        onOpenFeedback={openFeedback}
      />
      {settingsOverRoom ? (
        <div className="vx-overlay-layer">
          <SettingsView
            identity={voice.identity}
            settings={voice.settings}
            onSave={voice.saveAll}
            onClose={voice.closeSettings}
            onNotice={(kind, text) => voice.setNotice({ kind, text })}
            onOpenFeedback={openFeedback}
            onOpenOnboarding={() => setOnboardingOpen(true)}
          onExportDiagnostics={() => void voice.exportDiagnostics()}
          />
        </div>
      ) : null}
      <FeedbackDialog
          open={feedback.open}
          errorText={feedback.errorText}
          onCollectDiagnostics={voice.collectDiagnostics}
          onClose={closeFeedback}
        />
      <OnboardingDialog open={onboardingOpen} onClose={closeOnboarding} />
      <WhatsNewDialog open={whatsNewOpen} onClose={closeWhatsNew} />

      {/*
        房间里同样要挂账号/好友面板（2026-10-26 修"点了好友没反应"）：
        房间这条分支是**提前 return** 的，之前这些面板只写在首页分支里，
        所以房间里的按钮点了什么也不会发生。
      */}
      {incomingQueue.length > 0
        ? (() => {
            const request = account.snapshot.incoming.find(
              (item) => item.account.id === incomingQueue[0],
            );
            if (!request) return null;
            return (
              <FriendRequestToast
                request={request}
                onAccept={() => {
                  const id = request.account.id;
                  setIncomingQueue((queue) => queue.filter((item) => item !== id));
                  void accountAdapter.acceptFriend(id).then(() => account.refresh());
                }}
                onDismiss={() => setIncomingQueue((queue) => queue.slice(1))}
              />
            );
          })()
        : null}
      {/*
        敲门提示（2026-10-27）：只有在房间里才可能"放人进来"，
        不在房间时这条会留在好友面板的「待处理」里（红点已经算进去了）。
      */}
      {knocks.length > 0 ? (
        <KnockToast
          knock={knocks[0]!}
          canAccept={Boolean(voice.invite?.code)}
          onAccept={() => acceptKnock(knocks[0]!)}
          onDismiss={() => dismissKnock(knocks[0]!)}
        />
      ) : null}
      <AccountDialog
        open={accountOpen}
        adapter={accountAdapter}
        account={account.me}
        onClose={() => setAccountOpen(false)}
        onChanged={() => void account.refresh()}
        onOpenFriends={() => {
          setAccountOpen(false);
          setFriendsOpen(true);
        }}
      />
      <FriendsDrawer
        open={friendsOpen}
        adapter={accountAdapter}
        snapshot={account.snapshot}
        onClose={() => setFriendsOpen(false)}
        onChanged={() => {
          void account.refresh();
          // 加好友之后「最近一起玩」里那条就该消失，顺手刷新一次
          void accountAdapter.recentPlays().then(setRecentPlays);
        }}
        roomCode={voice.invite?.code ?? null}
        canInvite={voice.members.some((member) => member.local && member.isHost)}
        onInvite={inviteFriend}
        invites={invites}
        onJoinInvite={joinInvite}
        onDismissInvite={dismissInvite}
        knocks={knocks}
        onKnock={knockFriend}
        onAcceptKnock={acceptKnock}
        onDismissKnock={dismissKnock}
        recentPlays={recentPlays}
      />
      </>
    );
  }

  return (
    <>
      {/*
       * gameActive（开黑圈房间/结算接管整屏）时整块卸载：猪圈常驻动画不再空转。
       * 条件分支占一个固定子槽位，gameLayer 的挂载位置因此保持稳定——React 不会
       * 因为首页卸载而重建 GameEntry（否则游戏引擎会被销毁重连）。
       */}
      {gameActive ? null : (
        <>
          {voice.notice ? (
            <div className="vx-toast-layer">
              <Banner kind={voice.notice.kind} onClose={() => voice.setNotice(null)}>
                {voice.notice.text}
              </Banner>
            </div>
          ) : null}
          <FeedbackDialog
          open={feedback.open}
          errorText={feedback.errorText}
          onCollectDiagnostics={voice.collectDiagnostics}
          onClose={closeFeedback}
        />
          <OnboardingDialog open={onboardingOpen} onClose={closeOnboarding} />
      <WhatsNewDialog open={whatsNewOpen} onClose={closeWhatsNew} />
          <LandingView
            identity={voice.identity}
            onIdentityChange={voice.setIdentity}
            // 主按钮：临时房（主流）；「我的房间」走 onStartMyRoom
            onCreate={() => void voice.createRoom()}
            onStartMyRoom={() => void startRoom()}
            onJoin={voice.submitJoinInput}
            onSettings={voice.openSettings}
            sceneTheme={voice.sceneTheme}
            onSetSceneTheme={voice.setRoomSceneTheme}
            onCopyId={() => {
              void voice.copyText(voice.identity.personId, "个人 ID 已复制");
            }}
            joining={joinInFlight}
            retrying={voice.status === "reconnecting"}
            error={voice.joinError}
            onCancelJoin={voice.cancelJoin}
            onDismissError={() => voice.setJoinError(null)}
            lastRoom={voice.lastRoom}
            onResumeLastRoom={() => void voice.resumeLastRoom()}
            myRoom={
              myRoomCode
                ? { code: myRoomCode, locked: account.me?.roomCodeLocked === true }
                : null
            }
            onClaimMyRoom={claimRoomCode}
            needsPass={voice.needsPass}
            account={account.me}
            friendRequests={account.snapshot.incoming.length + invites.length + knocks.length}
            onOpenAccount={() => setAccountOpen(true)}
            onOpenFriends={() => setFriendsOpen(true)}
            onCreateGame={() => openGame("create")}
            onJoinGame={() => openGame("join")}
          />
          {voice.lastSummary ? (
            <SessionSummaryCard summary={voice.lastSummary} onClose={voice.dismissEnded} />
          ) : voice.ended ? (
            <div className="vx-overlay">
              <div className="vx-overlay-card">
                <p>
                  {voice.ended.reason === "host-left"
                    ? "房主已离开，房间已结束"
                    : voice.ended.detail ?? "连接已结束"}
                </p>
              </div>
            </div>
          ) : null}
        </>
      )}
      {/*
        房间内的好友请求提示：一条轻卡片，8 秒自动收起；
        点「同意」就地完成，不用退出房间。只在房间里出现，首页不打扰。
      */}
      {incomingQueue.length > 0
        ? (() => {
            const request = account.snapshot.incoming.find(
              (item) => item.account.id === incomingQueue[0],
            );
            if (!request) return null;
            return (
              <FriendRequestToast
                request={request}
                onAccept={() => {
                  const id = request.account.id;
                  setIncomingQueue((queue) => queue.filter((item) => item !== id));
                  void accountAdapter.acceptFriend(id).then(() => account.refresh());
                }}
                onDismiss={() => setIncomingQueue((queue) => queue.slice(1))}
              />
            );
          })()
        : null}

      {gameLayer}

      {/* 账号 / 好友：与房间逻辑完全解耦，关闭即回到原来的界面 */}
      <AccountDialog
        open={accountOpen}
        adapter={accountAdapter}
        account={account.me}
        onClose={() => setAccountOpen(false)}
        onChanged={() => void account.refresh()}
        onOpenFriends={() => {
          setAccountOpen(false);
          setFriendsOpen(true);
        }}
      />
      <FriendsDrawer
        open={friendsOpen}
        adapter={accountAdapter}
        snapshot={account.snapshot}
        onClose={() => setFriendsOpen(false)}
        onChanged={() => {
          void account.refresh();
          // 加好友之后「最近一起玩」里那条就该消失，顺手刷新一次
          void accountAdapter.recentPlays().then(setRecentPlays);
        }}
        roomCode={voice.invite?.code ?? null}
        canInvite={voice.members.some((member) => member.local && member.isHost)}
        onInvite={inviteFriend}
        invites={invites}
        onJoinInvite={joinInvite}
        onDismissInvite={dismissInvite}
        knocks={knocks}
        onKnock={knockFriend}
        onAcceptKnock={acceptKnock}
        onDismissKnock={dismissKnock}
        recentPlays={recentPlays}
      />
    </>
  );
}
