/**
 * 在线房间心跳（房主侧）。
 *
 * 背景：信令用公共 PeerJS 云，服务端看不到房间；SFU 只覆盖 4 人以上。
 * 想让运营后台知道"现在有几个房间开着"，只能由**房主主动报到**。
 *
 * 隐私红线（不可越界）：
 * - 上报的房间 id 由本模块 `newRoomId()` 随机生成，**与房间码/邀请链接无关**，
 *   拿到 id 也进不了房间；
 * - 只上报「人数 / 是否在共享屏幕 / 版本 / 客户端类型」，绝不上报窗口标题、
 *   文本内容、成员身份。
 *
 * 可靠性：全部失败静默（统计挂了就挂了，语音永远优先）；不重试轰炸。
 */
import { apiUrl } from "./feedback";
import { isTauriRuntime } from "./loopback";

/** 心跳间隔（与服务端的判定窗口对应：150 秒没心跳算离线）。 */
const HEARTBEAT_MS = 60_000;
/** 人数/共享状态变化的防抖补报间隔。 */
const CHANGE_DEBOUNCE_MS = 5_000;

/** 房间标识：32 位十六进制随机串（和服务端校验规则一致）。 */
export function newRoomId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    // 极老环境没有 randomUUID：退化为随机十六进制
    let out = "";
    for (let i = 0; i < 32; i += 1) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }
}

export type RoomBeatState = { members: number; sharing: boolean };
export type PresenceSend = (path: "beat" | "bye", body: Record<string, unknown>) => void | Promise<void>;

export interface RoomBeaconOptions {
  roomId: string;
  getState: () => RoomBeatState;
  send: PresenceSend;
  /** 客户端版本号（如 1.4.9），只用于后台按版本看分布 */
  version?: string;
  /** client | web */
  runtime?: string;
  intervalMs?: number;
  debounceMs?: number;
}

export interface RoomBeacon {
  /** 开房后调用：立刻报一次，之后按间隔心跳。 */
  start: () => void;
  /** 人数/共享状态变化时调用（内部防抖，不会打爆额度）。 */
  notifyChange: () => void;
  /** 关房/离开时调用：停心跳并报 bye（失败也无所谓，靠服务端过期）。 */
  stop: () => void;
}

/** 创建心跳器（依赖注入 send/时钟，便于单测）。 */
export function createRoomBeacon(options: RoomBeaconOptions): RoomBeacon {
  const intervalMs = options.intervalMs ?? HEARTBEAT_MS;
  const debounceMs = options.debounceMs ?? CHANGE_DEBOUNCE_MS;
  let timer: number | null = null;
  let debounceTimer: number | null = null;
  let running = false;

  const beat = () => {
    const { members, sharing } = options.getState();
    void options.send("beat", {
      id: options.roomId,
      members,
      sharing,
      version: options.version ?? "",
      // 客户端 / 网页版：后台按这个看"有多少人在用客户端"
      runtime: options.runtime ?? (isTauriRuntime() ? "client" : "web"),
    });
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      beat();
      timer = setInterval(beat, intervalMs) as unknown as number;
    },
    notifyChange: () => {
      if (!running) return;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        beat();
      }, debounceMs) as unknown as number;
    },
    stop: () => {
      running = false;
      if (timer !== null) clearInterval(timer);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      timer = null;
      debounceTimer = null;
      void options.send("bye", { id: options.roomId });
    },
  };
}

/** 发心跳（静默失败：网络不通/被限速都不打扰用户）。 */
export async function postPresence(path: "beat" | "bye", body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(apiUrl(`/rooms/${path}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // 关房上报要能在页面卸载途中发出去
      keepalive: path === "bye",
    });
  } catch {
    /* 静默 */
  }
}
