/**
 * 猪位快照注册表。
 *
 * 为什么需要它：背景标签页里 requestAnimationFrame 会停跑，
 * 而猪的走位用的是 Web Animations（合成器上继续跑）。如果只靠
 * rAF 采样，房主切后台后广播出去的坐标就冻在最后一帧，全房跟着卡住。
 * 这里让每头猪注册一个**解析式读取器**：直接从动画的 currentTime
 * 算出此刻位置——不依赖 rAF，后台标签页也能读到真实位置。
 */

export interface PenPoseSnapshot {
  /** 横向 0~1（猪中心 / 场地宽）。 */
  x: number;
  /** 纵深 0（最远）~1（最近）。 */
  lane: number;
}

type Reader = () => PenPoseSnapshot | null;

const readers = new Map<string, Reader>();

/** 注册一头猪的位置读取器；返回注销函数。 */
export function registerPenPoseReader(id: string, reader: Reader): () => void {
  readers.set(id, reader);
  return () => {
    if (readers.get(id) === reader) readers.delete(id);
  };
}

/** 读取当前所有猪的位置快照（单个读取器出错不影响整批）。 */
export function readPenSnapshots(): Map<string, PenPoseSnapshot> {
  const out = new Map<string, PenPoseSnapshot>();
  for (const [id, read] of readers) {
    try {
      const snap = read();
      if (snap) out.set(id, snap);
    } catch {
      // 忽略单个读取器的异常
    }
  }
  return out;
}
