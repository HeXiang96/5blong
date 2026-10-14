/**
 * 5blong 协议核心：房间编址、握手认证、准入裁决、心跳常量。
 *
 * 这一层是纯逻辑（不碰 DOM、不碰 PeerJS），因此可以在 node 环境下直接单测。
 * 引擎与 UI 只消费这里导出的类型与函数。
 *
 * 设计要点（对应走查报告）：
 * - 房间码只用于"找到人"，本身不是凭据；准入由房主亲手裁决。
 * - 房主 ID 不可猜（不应期由短码推导），邀请链接额外携带 roomKey。
 * - roomKey 只存在于 URL fragment（# 后面的部分不会发给任何服务器）。
 * - 握手用 HMAC-SHA256 双向证明：访客证明自己持链接，房主证明自己持密钥。
 */

import { VEGETABLE_KINDS, type PenEvent, type VegetableKind } from "./pen";
import { parseSoundEvent, type SoundEvent } from "./sounds";

/**
 * 等待 welcome 的超时到点时，是否应该向用户报"房主没有响应"。
 *
 * 必须是纯函数并且有测试：之前这里忘了清定时器，导致**进房成功后 8 秒**
 * 仍然报"连接失败"，但人其实一直在房间里。
 * 返回 true 只应在"还连着这条连接、而且一直没进过房"的情况下发生。
 */
export function shouldReportWelcomeTimeout(state: {
  /** 超时触发时，当前这条连接是否仍是正在使用的那条。 */
  stillCurrentConnection: boolean;
  /** 是否已经进过房间。 */
  joined: boolean;
  /** 是否已销毁。 */
  destroyed: boolean;
}): boolean {
  if (state.destroyed) return false;
  if (state.joined) return false;
  return state.stillCurrentConnection;
}

/** 校验从线上收到的猪圈事件；形状不对就丢弃，不让它进渲染层。 */
export function parsePenEvent(input: unknown): PenEvent | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const kind = raw["kind"];
  const id = typeof raw["id"] === "string" ? raw["id"].slice(0, 64) : "";
  const ts = typeof raw["ts"] === "number" && Number.isFinite(raw["ts"]) ? raw["ts"] : 0;
  if (!id || !ts) return null;

  if (kind === "toss") {
    const vegRaw = raw["veg"];
    if (!vegRaw || typeof vegRaw !== "object") return null;
    const veg = vegRaw as Record<string, unknown>;
    const vegKind = veg["kind"];
    if (typeof vegKind !== "string" || !VEGETABLE_KINDS.includes(vegKind as VegetableKind)) {
      return null;
    }
    const x = typeof veg["x"] === "number" && Number.isFinite(veg["x"]) ? veg["x"] : 0.5;
    const lane = typeof veg["lane"] === "number" && Number.isFinite(veg["lane"]) ? veg["lane"] : 0.5;
    return {
      kind: "toss",
      id,
      ts,
      npc: typeof raw["npc"] === "string" ? raw["npc"].slice(0, 24) : "",
      veg: {
        kind: vegKind as VegetableKind,
        x: Math.min(1, Math.max(0, x)),
        lane: Math.min(1, Math.max(0, lane)),
      },
    };
  }

  if (kind === "eat") {
    const actor = typeof raw["actor"] === "string" ? raw["actor"].slice(0, 64) : "";
    if (!actor) return null;
    const vegKind = raw["veg"];
    return {
      kind: "eat",
      id,
      ts,
      actor,
      veg:
        typeof vegKind === "string" && VEGETABLE_KINDS.includes(vegKind as VegetableKind)
          ? (vegKind as VegetableKind)
          : "carrot",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 房间码：4 位数字
// ---------------------------------------------------------------------------

/** 房间码只用数字，方便口头报码与手动输入。 */
export const CODE_ALPHABET = "0123456789";
export const ROOM_CODE_LEN = 4;

/** PeerJS 的 ID 校验规则是 ^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$，故用 '-' 分段。 */
export const ROOM_PREFIX = "5b";
export const HOST_ID_PREFIX = "5b-h-";
export const GUEST_ID_PREFIX = "5b-g-";

/** 10^4 = 10,000 种组合。 */
export const CODE_SPACE = CODE_ALPHABET.length ** ROOM_CODE_LEN;

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${ROOM_CODE_LEN}}$`);

export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, "");
}

export function isRoomCode(value: string): boolean {
  return CODE_PATTERN.test(value);
}

/** 生成房间码。随机源由调用方注入，便于测试与使用 crypto。 */
export function makeRoomCode(random: (max: number) => number): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  }
  return code;
}

/** 房主 PeerID。留出前缀长度后仍在 PeerJS 的 64 字符上限内。 */
export function hostPeerId(hostToken: string): string {
  return HOST_ID_PREFIX + hostToken;
}

export function guestPeerId(guestToken: string): string {
  return GUEST_ID_PREFIX + guestToken;
}

/**
 * 由房间码推导房主 PeerID，让"只输房间码"也能定位房主：
 * 房主直接注册在这个固定 ID 上，访客算出 ID 就能连，无需任何注册后端。
 *
 * 取舍：知道房间码就能找到房间（码即门票），这是"裸码进房"的固有代价；
 * 邀请链接额外携带 roomKey 做 HMAC 证明，想更私密就发链接。
 */
export function hostPeerIdForCode(code: string): string {
  return hostPeerId(code);
}

// ---------------------------------------------------------------------------
// 编码与随机
// ---------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 随机令牌。**只用字母数字**，因为 PeerJS 的 ID 校验是
 *   ^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$
 * 也就是说 `-` 和 `_` 只能当"单个分隔符"，两边都必须是非空字母数字段。
 * base64url 会产生 `-`/`_`，像 `5b-h-HX4evyEA0_Dm086Y` 这种 ID 会被判非法、
 * peer 直接建不起来（表现为访客永远连不上房主）。
 *
 * 用 base64url 再去掉 `-`/`_`：32 字符的 base64url 去掉约 2.3 个字符仍是 29+，
 * 每个字符约 5.95 bit 熵，对 ID/密钥都绰绰有余。
 */
export function randomToken(bytes = 16): string {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(bytes))).replace(
    /[-_]/g,
    "",
  );
  // 极端情况下（例如只取 1 字节）可能被清空，兜底再取一次。
  return token || toBase64Url(crypto.getRandomValues(new Uint8Array(8))).replace(/[-_]/g, "");
}

export function randomIndex(max: number): number {
  return crypto.getRandomValues(new Uint8Array(1))[0]! % max;
}

/** PeerJS 的 ID 校验规则（见其 validateId）：`-`/`_` 只能当单个分隔符。 */
const PEER_ID_PATTERN = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;

/** 是否是一个 PeerJS 能接受的 ID。用于在调用前就给出可读错误，而不是静默卡住。 */
export function isValidPeerId(value: string): boolean {
  return PEER_ID_PATTERN.test(value) && value.length <= 64;
}

// ---------------------------------------------------------------------------
// 握手证明
// ---------------------------------------------------------------------------

export async function hmac(roomKey: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(roomKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return toBase64Url(new Uint8Array(signature));
}

/** 访客证明："我知道 roomKey，且我是这个 peer、要进这个房"。 */
export function guestProofMessage(
  nonce: string,
  peerId: string,
  code: string,
): string {
  return `5blong/guest/${code}/${peerId}/${nonce}`;
}

/** 房主证明：只签访客的 nonce，避免被中继重放给第三方。 */
export function hostProofMessage(nonce: string): string {
  return `5blong/host/${nonce}`;
}

export function signGuestProof(
  roomKey: string,
  nonce: string,
  peerId: string,
  code: string,
): Promise<string> {
  return hmac(roomKey, guestProofMessage(nonce, peerId, code));
}

export function signHostProof(roomKey: string, nonce: string): Promise<string> {
  return hmac(roomKey, hostProofMessage(nonce));
}

export function verifyHostProof(
  roomKey: string,
  nonce: string,
  proof: string,
): Promise<boolean> {
  return signHostProof(roomKey, nonce).then((expected) => expected === proof);
}

// ---------------------------------------------------------------------------
// 邀请链接
// ---------------------------------------------------------------------------

export const PUBLIC_WEB_BASE = "https://5blong.pages.dev";

export interface Invite {
  code: string;
  hostId: string;
  roomKey: string;
}

/**
 * 邀请链接：https://5blong.pages.dev/#c=<码>&h=<房主ID>&k=<密钥>
 * fragment 不参与 HTTP 请求，因此 roomKey 不会落到任何服务器日志里。
 */
export function buildInviteUrl(invite: Invite): string {
  const url = new URL("/", PUBLIC_WEB_BASE);
  const params = new URLSearchParams({
    c: invite.code,
    h: invite.hostId,
    k: invite.roomKey,
  });
  url.hash = params.toString();
  return url.toString();
}

export interface JoinTarget {
  code: string;
  hostId: string;
  /** 只有从邀请链接进入时才有；手输房间码时为空。 */
  roomKey: string;
}

function readFragment(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, ""));
}

/** 从 location.hash 读取邀请。 */
export function parseInviteHash(hash: string): Invite | null {
  const params = readFragment(hash);
  const code = normalizeCode(params.get("c") ?? "");
  const hostId = (params.get("h") ?? "").trim();
  const roomKey = (params.get("k") ?? "").trim();
  if (!isRoomCode(code) || !hostId || !roomKey) return null;
  return { code, hostId, roomKey };
}

/**
 * 解析加入输入：完整邀请链接、纯房间码，或"码 + 密钥"两段式。
 * 返回值里 roomKey 为空表示只能尝试裸码加入（由房主决定是否放行）。
 */
export function parseJoinInput(input: string): JoinTarget | null {
  const raw = input.trim();
  if (!raw) return null;

  if (raw.includes("#")) {
    const fragment = raw.slice(raw.indexOf("#") + 1);
    const params = readFragment(fragment);
    const code = normalizeCode(
      params.get("c") ?? params.get("code") ?? params.get("r") ?? "",
    );
    const hostId = (
      params.get("h") ??
      params.get("host") ??
      params.get("r") ??
      ""
    ).trim();
    const roomKey = (params.get("k") ?? params.get("key") ?? "").trim();
    if (isRoomCode(code)) {
      return { code, hostId, roomKey };
    }
    // 兼容旧格式 #r=<房主ID>&c=<码>：hostId 可能就是 5b-xxx。
    const legacyId = hostId;
    if (legacyId.startsWith(ROOM_PREFIX)) {
      const legacyCode = normalizeCode(
        params.get("c") ?? legacyId.slice(ROOM_PREFIX.length),
      );
      if (isRoomCode(legacyCode)) {
        return { code: legacyCode, hostId: legacyId, roomKey };
      }
    }
  }

  const compact = normalizeCode(raw);
  if (isRoomCode(compact)) {
    return { code: compact, hostId: "", roomKey: "" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 线上消息（房主 ↔ 访客）
// ---------------------------------------------------------------------------

/** 房间里的小猪互动动作：戳一戳 / 打招呼 / 投喂。 */
/** 允许的小猪互动种类。 */
export const INTERACT_KINDS = [
  "poke",
  "wave",
  "feed",
  "pat",
  "tickle",
  "hug",
  "boo",
  "cheer",
  // 后加的"吊起来"：把对方的猪用绳子吊到半空晃悠。新版本追加在末尾，
  // 旧版本解析时整条互动被安全忽略（不崩、只是看不到效果）。
  "hoist",
] as const;
export type InteractKind = (typeof INTERACT_KINDS)[number];

export interface InteractEvent {
  /** 发起互动的成员 id。 */
  from: string;
  /** 被互动的成员 id（投喂时是被喂的那只猪）。 */
  to: string;
  kind: InteractKind;
  ts: number;
}

/** 校验一条互动事件（房主下发，或投喂时复用）。 */
export function parseInteractEvent(input: unknown): InteractEvent | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const from = typeof raw["from"] === "string" ? raw["from"].slice(0, 64) : "";
  const to = typeof raw["to"] === "string" ? raw["to"].slice(0, 64) : "";
  const kind = raw["kind"];
  const ts = typeof raw["ts"] === "number" && Number.isFinite(raw["ts"]) ? raw["ts"] : 0;
  if (!from || !to || !ts) return null;
  if (typeof kind !== "string" || !(INTERACT_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  return { from, to, kind: kind as InteractKind, ts };
}

// ---------------------------------------------------------------------------
// 屏幕共享（围炉看 TV）
// ---------------------------------------------------------------------------

/**
 * 房间的屏幕共享状态（房主权威，一台电视，同时最多一个共享者）。
 *
 * 设计约束（见 SCREENSHARE-PLAN.md §H）：这是**房间状态上的一个可空字段**，
 * 成员表与语音链路完全不读也不写它——共享链路崩了只表现为"电视雪花"。
 */
export interface ScreenShareState {
  active: boolean;
  /** 共享者的成员 id（掉线/退出由房主清理）。 */
  sharerId: string;
  /** 共享者在 SFU 的会话 id（订阅方据此拉流）。 */
  sessionId: string;
  /** SFU 媒体轨名（视频）。 */
  trackName: string;
  /** SFU 媒体轨名（系统/标签页声音，无则为空串）。 */
  trackNameAudio: string;
  /** 电视上显示的来源名（窗口标题）。 */
  label: string;
  startedAt: number;
}

/** 校验从线上收到的屏幕共享状态；形状不对就丢弃。 */
export function parseScreenShareState(input: unknown): ScreenShareState | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (raw["active"] !== true) return null;
  const sharerId = typeof raw["sharerId"] === "string" ? raw["sharerId"].slice(0, 64) : "";
  const sessionId = typeof raw["sessionId"] === "string" ? raw["sessionId"].slice(0, 128) : "";
  const trackName = typeof raw["trackName"] === "string" ? raw["trackName"].slice(0, 64) : "";
  if (!sharerId || !sessionId || !trackName) return null;
  return {
    active: true,
    sharerId,
    sessionId,
    trackName,
    trackNameAudio:
      typeof raw["trackNameAudio"] === "string" ? raw["trackNameAudio"].slice(0, 64) : "",
    label: typeof raw["label"] === "string" ? raw["label"].slice(0, 120) : "",
    startedAt: typeof raw["startedAt"] === "number" && Number.isFinite(raw["startedAt"]) ? raw["startedAt"] : 0,
  };
}

/** 共享者向房主申报的 SFU 发布信息。 */
export interface ScreenSharePublication {
  sessionId: string;
  trackName: string;
  trackNameAudio: string;
  label: string;
  hasAudio: boolean;
}

export function parseScreenSharePublication(input: unknown): ScreenSharePublication | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const sessionId = typeof raw["sessionId"] === "string" ? raw["sessionId"].slice(0, 128) : "";
  const trackName = typeof raw["trackName"] === "string" ? raw["trackName"].slice(0, 64) : "";
  if (!sessionId || !trackName) return null;
  return {
    sessionId,
    trackName,
    trackNameAudio:
      typeof raw["trackNameAudio"] === "string" ? raw["trackNameAudio"].slice(0, 64) : "",
    label: typeof raw["label"] === "string" ? raw["label"].slice(0, 120) : "",
    hasAudio: raw["hasAudio"] === true,
  };
}

export interface WireMember {  id: string;
  /** 本机个人 ID，仅用于重名消歧展示，不作为身份凭据。 */
  personId: string;
  /** 会话级短标识：同一个人开两个窗口也能区分开。 */
  sessionId: string;
  name: string;
  avatar: string;
  color: string;
  muted: boolean;
  hasMic: boolean;
  isHost: boolean;
  /** 被房主强制禁言（本人无法自行解除）。 */
  serverMuted?: boolean;
  /** 是否闭听（戴耳罩，闭听时一定静音）。 */
  deafened?: boolean;
}

/** 访客 → 房主。 */
export type GuestMessage =
  | { t: "hello"; personId: string; sessionId: string; name: string; avatar: string; color: string; hasMic: boolean; muted: boolean; nonce: string; proof: string }
  | { t: "identity"; name: string; avatar: string; color: string }
  | { t: "joined" }
  | { t: "chat"; text: string }
  | { t: "muted"; muted: boolean; deafened?: boolean }
  | { t: "speaking"; speaking: boolean }
  | { t: "interact"; to: string; kind: InteractKind }
  | { t: "screen-share-start"; session: ScreenSharePublication }
  | { t: "screen-share-stop" }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number };

/** 房主 → 访客。 */
export type HostMessage =
  | { t: "welcome"; code: string; hostId: string; proof: string; roster: WireMember[]; you: string; locked?: boolean; screenShare?: ScreenShareState }
  | { t: "reject"; reason: RejectReason }
  | { t: "kick"; id: string }
  | { t: "force-mute"; id: string; muted: boolean }
  | { t: "lock"; locked: boolean }
  | { t: "interact"; event: InteractEvent }
  /** state 为 null 表示停播（电视回雪花）。 */
  | { t: "screen-share"; state: ScreenShareState | null }
  | { t: "chat"; id: string; name: string; text: string; ts: number }
  | { t: "roster"; members: WireMember[] }
  | { t: "peer-join"; member: WireMember }
  | { t: "peer-leave"; id: string }
  | { t: "speaking"; id: string; speaking: boolean }
  | { t: "pen"; event: PenEvent }
  /*
   * 房主权威猪位：每 ~600ms 一条，把每头猪的横向（0~1）与纵深（0~1）
   * 播给访客。访客的猪据此平滑跟随，两端看到的是同一片猪圈，
   * 而不是各自随机散步（旧版本收到未知类型会安全忽略）。
   */
  | { t: "pen-poses"; ts: number; poses: PenPose[] }
  | { t: "sound"; event: SoundEvent }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number };

/** 一头猪的权威位置快照（房主模拟，全房一致）。 */
export interface PenPose {
  /** 成员 id。 */
  id: string;
  /** 横向 0~1（猪中心 / 场地宽）。 */
  x: number;
  /** 纵深 0（最远）~1（最近）。 */
  lane: number;
  /** 朝向（1=面右 -1=面左），那一坨落在屁股后面用。 */
  facing?: 1 | -1;
}

export type WireMessage = GuestMessage | HostMessage;

export type RejectReason =
  | "bad-key"
  | "full"
  | "closed"
  | "locked"
  | "duplicate"
  | "version";

const LIMITS = {
  name: 24,
  avatar: 400_000,
  color: 32,
  text: 2000,
} as const;

/** 把所有来自网络的数据当不可信输入处理：逐字段校验后再进内部状态。 */
export function parseGuestMessage(data: unknown): GuestMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  switch (msg["t"]) {
    case "hello": {
      if (typeof msg["nonce"] !== "string" || typeof msg["proof"] !== "string") return null;
      return {
        t: "hello",
        personId: str(msg["personId"], 16),
        sessionId: str(msg["sessionId"], 16),
        name: str(msg["name"], LIMITS.name) || "匿名",
        avatar: str(msg["avatar"], LIMITS.avatar),
        color: str(msg["color"], LIMITS.color),
        hasMic: msg["hasMic"] === true,
        muted: msg["muted"] === true,
        nonce: str(msg["nonce"], 64),
        proof: str(msg["proof"], 128),
      };
    }
    case "joined":
      return { t: "joined" };
    case "chat": {
      const text = str(msg["text"], LIMITS.text).trim();
      return text ? { t: "chat", text } : null;
    }
    case "muted": {
      const muted = msg["muted"] === true;
      // deafened 可缺省，只有真的闭听时才带，保持消息精简。
      return msg["deafened"] === true
        ? { t: "muted", muted, deafened: true }
        : { t: "muted", muted };
    }
    case "speaking":
      return { t: "speaking", speaking: msg["speaking"] === true };
    case "interact": {
      const to = str(msg["to"], 64);
      const kind = msg["kind"];
      if (!to || typeof kind !== "string" || !(INTERACT_KINDS as readonly string[]).includes(kind)) {
        return null;
      }
      return { t: "interact", to, kind: kind as InteractKind };
    }
    case "screen-share-start": {
      const session = parseScreenSharePublication(msg["session"]);
      return session ? { t: "screen-share-start", session } : null;
    }
    case "screen-share-stop":
      return { t: "screen-share-stop" };
    case "ping": {
      const ts = num(msg["ts"]);
      return ts === null ? null : { t: "ping", ts };
    }
    case "pong": {
      const ts = num(msg["ts"]);
      return ts === null ? null : { t: "pong", ts };
    }
    case "identity": {
      const name = str(msg["name"], LIMITS.name) || "匿名";
      const avatar = str(msg["avatar"], LIMITS.avatar);
      const color = str(msg["color"], LIMITS.color);
      if (!name || !color) return null;
      return { t: "identity", name, avatar, color };
    }
    default:
      return null;  }
}

export function parseHostMessage(data: unknown): HostMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  switch (msg["t"]) {
    case "welcome": {
      const code = normalizeCode(str(msg["code"], 32));
      const hostId = str(msg["hostId"], 64);
      const proof = str(msg["proof"], 128);
      const you = str(msg["you"], 64);
      if (!isRoomCode(code) || !hostId || !proof || !you) return null;
      return {
        t: "welcome",
        code,
        hostId,
        proof,
        you,
        roster: parseRoster(msg["roster"]),
        locked: msg["locked"] === true,
        // 中途进房的人也要知道"电视亮没亮"（缺席 = 没在共享，向后兼容）。
        screenShare: msg["screenShare"] === undefined ? undefined : parseScreenShareState(msg["screenShare"]) ?? undefined,
      };
    }
    case "screen-share": {
      // state 显式为 null = 停播；其余形状不对才丢弃。
      if (msg["state"] === null) return { t: "screen-share", state: null };
      const state = parseScreenShareState(msg["state"]);
      return state ? { t: "screen-share", state } : null;
    }
    case "reject": {
      const reason = msg["reason"];
      const reasons: RejectReason[] = ["bad-key", "full", "closed", "locked", "duplicate", "version"];
      if (typeof reason !== "string" || !reasons.includes(reason as RejectReason)) return null;
      return { t: "reject", reason: reason as RejectReason };
    }
    case "kick": {
      const id = str(msg["id"], 64);
      return id ? { t: "kick", id } : null;
    }
    case "force-mute": {
      const id = str(msg["id"], 64);
      return id ? { t: "force-mute", id, muted: msg["muted"] === true } : null;
    }
    case "lock":
      return { t: "lock", locked: msg["locked"] === true };
    case "interact": {
      const event = parseInteractEvent(msg["event"]);
      return event ? { t: "interact", event } : null;
    }
    case "chat": {
      const text = str(msg["text"], LIMITS.text);
      const id = str(msg["id"], 64);
      if (!text || !id) return null;
      return {
        t: "chat",
        id,
        name: str(msg["name"], LIMITS.name) || "匿名",
        text,
        ts: num(msg["ts"]) ?? Date.now(),
      };
    }
    case "roster":
      return { t: "roster", members: parseRoster(msg["members"]) };
    case "peer-join": {
      const member = parseMember(msg["member"]);
      return member ? { t: "peer-join", member } : null;
    }
    case "peer-leave": {
      const id = str(msg["id"], 64);
      return id ? { t: "peer-leave", id } : null;
    }
    case "speaking": {
      const id = str(msg["id"], 64);
      return id ? { t: "speaking", id, speaking: msg["speaking"] === true } : null;
    }
    case "pen": {
      const event = parsePenEvent(msg["event"]);
      return event ? { t: "pen", event } : null;
    }
    case "pen-poses": {
      const ts = num(msg["ts"]);
      const raw = msg["poses"];
      if (ts === null || !Array.isArray(raw) || raw.length === 0 || raw.length > 16) return null;
      const poses: PenPose[] = [];
      for (const item of raw) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        const id = str(record["id"], 64);
        const x = num(record["x"]);
        const lane = num(record["lane"]);
        if (!id || x === null || lane === null) continue;
        poses.push({
          id,
          x: Math.min(1, Math.max(0, x)),
          lane: Math.min(1, Math.max(0, lane)),
          facing: num(record["facing"]) === -1 ? -1 : 1,
        });
      }
      return poses.length > 0 ? { t: "pen-poses", ts, poses } : null;
    }
    case "sound": {
      const event = parseSoundEvent(msg["event"]);
      return event ? { t: "sound", event } : null;
    }
    case "pong": {
      const ts = num(msg["ts"]);
      return ts === null ? null : { t: "pong", ts };
    }
    default:
      return null;
  }
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRoster(value: unknown): WireMember[] {
  if (!Array.isArray(value)) return [];
  const members: WireMember[] = [];
  for (const raw of value.slice(0, MAX_MEMBERS)) {
    const member = parseMember(raw);
    if (member) members.push(member);
  }
  return members;
}

function parseMember(value: unknown): WireMember | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  const id = str(m["id"], 64);
  if (!id) return null;
  return {
    id,
    personId: str(m["personId"], 16),
    sessionId: str(m["sessionId"], 16),
    name: str(m["name"], LIMITS.name) || "匿名",
    avatar: str(m["avatar"], LIMITS.avatar),
    color: str(m["color"], LIMITS.color),
    muted: m["muted"] === true,
    hasMic: m["hasMic"] === true,
    isHost: m["isHost"] === true,
    serverMuted: m["serverMuted"] === true,
    deafened: m["deafened"] === true,
  };
}

// ---------------------------------------------------------------------------
// 准入裁决（房主侧，纯函数，便于单测）
// ---------------------------------------------------------------------------

/** 单房人数上限。全互联 mesh 的边数是 n(n-1)/2，8 人即 28 条媒体连接。 */
export const MAX_MEMBERS = 8;

export const HEARTBEAT_MS = 2000;
/**
 * 心跳超时。3 次心跳（6s）足够容忍一次抖动与后台标签页节流，
 * 又比"关掉页面后还显示在线"的体感短。
 */
export const HEARTBEAT_TIMEOUT_MS = 6000;
/** 访客连续收不到房主 pong 多久后判定掉线并尝试重连。 */
export const HOST_SILENCE_TIMEOUT_MS = 10_000;
/** 连上信令后等待房主 welcome 的上限。 */
export const WELCOME_TIMEOUT_MS = 12_000;

export type AdmissionVerdict =
  | { ok: true }
  | { ok: false; reason: RejectReason };

export interface AdmissionInput {
  /** 房主是否已就绪（peer 已 open 且房间未结束）。 */
  hostReady: boolean;
  /** 房间是否已被房主关闭。 */
  closed: boolean;
  /** 房间是否已被房主上锁（上锁后不接受新面孔，断线重连放行）。 */
  locked: boolean;
  /** 房间码是否与访客声明一致。 */
  codeMatches: boolean;
  /** 握手证明是否验过。 */
  proofValid: boolean;
  /** 同 ID 是否已在名册里（重连覆盖）。 */
  existing: boolean;
  /** 当前名册人数（不含本次）。 */
  memberCount: number;
}

/**
 * 判定顺序很重要：先证明身份，再看是否上锁、容量，最后看重复。
 * 未通过证明的连接一律不进入名册、也拿不到名单（避免暴露房间是否上锁）。
 */
export function decideAdmission(input: AdmissionInput): AdmissionVerdict {
  if (input.closed) return { ok: false, reason: "closed" };
  if (!input.hostReady) return { ok: false, reason: "closed" };
  if (!input.codeMatches) return { ok: false, reason: "bad-key" };
  if (!input.proofValid) return { ok: false, reason: "bad-key" };
  if (input.locked && !input.existing) return { ok: false, reason: "locked" };
  if (!input.existing && input.memberCount >= MAX_MEMBERS) {
    return { ok: false, reason: "full" };
  }
  if (input.existing && input.memberCount >= MAX_MEMBERS * 2) {
    // 同一 ID 反复握手属于异常，避免被拿来做内存放大。
    return { ok: false, reason: "duplicate" };
  }
  return { ok: true };
}

export function rejectText(reason: RejectReason): string {
  switch (reason) {
    case "bad-key":
      return "房间密钥不正确，请使用房主发的完整邀请链接";
    case "full":
      return `房间已满（最多 ${MAX_MEMBERS} 人）`;
    case "closed":
      return "房间已结束";
    case "locked":
      return "房间已上锁，暂不接受新成员加入";
    case "duplicate":
      return "该身份已在房间中";
    case "version":
      return "客户端版本不一致，请刷新页面后重试";
  }
}

// ---------------------------------------------------------------------------
// 加入输入的提示文案（与实现保持同一处真相）
// ---------------------------------------------------------------------------

export const CODE_HINT = `${ROOM_CODE_LEN} 位房间码`;
export const CODE_PLACEHOLDER = `例如 ${"1234".slice(0, ROOM_CODE_LEN)} 或邀请链接`;
export const JOIN_PARSE_ERROR = `请输入${CODE_HINT}，或粘贴完整邀请链接`;
