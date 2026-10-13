/**
 * 语音活动判定（纯逻辑）。
 *
 * 从 engine.ts 里拆出来的原因有两个：
 * 1. 这块逻辑出过真 bug —— 原本用"瞬时音量过阈值"判定，
 *    而人开始说话时音量是渐强的，第一个音节够不到阈值，
 *    于是要等几百毫秒才被判成"正在说话"，表现为动作跟不上说话。
 * 2. 它本来是纯计算，却和定时器、AudioContext、名册混在一个 1600 行的类里，
 *    没法单独测。拆出来之后可以喂任意音量序列，断言输出的状态变化时刻。
 *
 * 现在只有两层，都是必要的：
 * - 包络跟随（指数平滑）：起音时间常数很小（几十毫秒），所以起音快；
 *   收音时间常数稍大，避免自然停顿把状态打得忽闪。
 * - 滞回：起音阈值高、收音阈值低，避免在阈值附近来回跳。
 *
 * 曾经还有第三层"预滚缓冲"（取最近一段的峰值），**已经移除**：
 * 它会把旧的高音量按窗口长度一直顶住，导致音量停下来的头几百毫秒
 * 状态回不到 idle（实测表现为猪一直停在"正在说话"）。
 * 加了短起音时间常数之后，预滚本来也不再提供额外收益。
 */

/** 判定参数。默认值即线上使用的值。 */
export interface VoiceActivityOptions {
  /** 起音阈值（音量 0~255 量级）。 */
  startThreshold?: number;
  /** 收音阈值；应低于起音阈值，形成滞回。 */
  stopThreshold?: number;
  /** 起音时间常数（ms）：越小越灵敏。 */
  attackMs?: number;
  /** 收音时间常数（ms）：越大越不容易闪。 */
  releaseMs?: number;
}

const DEFAULTS = {
  startThreshold: 16,
  stopThreshold: 11,
  attackMs: 30,
  releaseMs: 140,
};

export interface VoiceActivityState {
  /** 当前是否判定为"正在说话"。 */
  active: boolean;
  /** 平滑后的包络值（调试/显示用）。 */
  envelope: number;
}

export class VoiceActivityDetector {
  private readonly opt: Required<VoiceActivityOptions>;
  private envelope = 0;
  private active = false;

  constructor(options: VoiceActivityOptions = {}) {
    this.opt = { ...DEFAULTS, ...options };
  }

  get state(): VoiceActivityState {
    return { active: this.active, envelope: this.envelope };
  }

  /** 不再说话（例如被静音）：立刻复位。 */
  reset(): void {
    this.envelope = 0;
    this.active = false;
  }

  /**
   * 喂一帧音量，返回状态**是否发生了变化**。
   *
   * 参数：
   * - `level`：这一帧的音量（0~255 量级，通常取频谱均值）；
   * - `dtMs`：与上一帧的间隔，用来算与帧率无关的平滑系数；
   * - `allowed`：是否允许被判为说话（例如被静音的人不允许）。
   */
  push(level: number, dtMs: number, allowed = true): { changed: boolean; active: boolean } {
    // 不允许说话时直接复位：否则静音解除后会带着旧包络"立刻亮起来"。
    if (!allowed) {
      const changed = this.active;
      this.reset();
      return { changed, active: false };
    }

    // 指数平滑：起音快、收音慢。用 1-exp(-dt/tau) 而不是固定系数，
    // 这样采样间隔变化（掉帧、后台标签页）时行为不变。
    const tau = level > this.envelope ? this.opt.attackMs : this.opt.releaseMs;
    const alpha = 1 - Math.exp(-Math.max(0, dtMs) / Math.max(1, tau));
    this.envelope += (level - this.envelope) * alpha;

    // 滞回：已经在说话时用更低的阈值，避免在阈值附近闪烁
    const threshold = this.active ? this.opt.stopThreshold : this.opt.startThreshold;
    const next = this.envelope > threshold;

    if (next === this.active) return { changed: false, active: this.active };
    this.active = next;
    return { changed: true, active: next };
  }
}

