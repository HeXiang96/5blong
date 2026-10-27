/**
 * 「单向链路」判定的纯逻辑（2026-10-27）。
 *
 * 为什么要单独抽出来：这段阈值判断是"该不该拆掉一条还标着 connected 的语音链路"
 * 的唯一依据 —— 判早了会把好链路反复拆断（说话断断续续），判晚了用户就是
 * "一直没声音、点重连也没用"。放到纯函数里可以用单测把这条线钉住。
 *
 * 判定依据是**收到的音频包数**（`inbound-rtp.packetsReceived`），不是字节数：
 * 静音 / DTX 时字节数会长时间不动，但包数照涨，用包数误判更少。
 */

export interface OneWaySample {
  /** 上一次采样看到的累计包数 */
  packets: number;
  /** 连续"没涨"的次数 */
  hits: number;
}

/** 一次采样都应该涨一点（我们关掉了 DTX），所以"从没收到过"更可疑，阈值给短。 */
export const ONE_WAY_NEVER_LIMIT = 3;
/** 收到过又停了：可能是对方短暂断网，给长一点，别一停就拆。 */
export const ONE_WAY_STALLED_LIMIT = 5;

export interface OneWayStep {
  /** 本次采样后应该写回的状态 */
  next: OneWaySample;
  /** 包数在涨（链路是通的） */
  grew: boolean;
  /** 连续停滞已到阈值，该判定"收不到他的声音"并换路了 */
  trigger: boolean;
}

/**
 * 走一步判定。
 *
 * `prev` 为 undefined 表示这是第一次给这条链路采样。
 * 返回 `grew = true` 时调用方应该把"单向重连次数"也清零。
 */
export function oneWayStep(prev: OneWaySample | undefined, packets: number): OneWayStep {
  const grew = packets > 0 && packets > (prev?.packets ?? 0);
  if (grew) return { next: { packets, hits: 0 }, grew: true, trigger: false };
  const hits = (prev?.hits ?? 0) + 1;
  const limit = packets === 0 ? ONE_WAY_NEVER_LIMIT : ONE_WAY_STALLED_LIMIT;
  return { next: { packets, hits }, grew: false, trigger: hits >= limit };
}
