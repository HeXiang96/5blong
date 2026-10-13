/**
 * 定时器登记表。
 *
 * 从 engine.ts 拆出来的原因：原来的实现有一个**混装**问题——
 * `timers` 集合里既有 `setInterval` 也有 `setTimeout` 返回的 id，
 * 清理时却一律用 `clearInterval`。浏览器里两者共用 id 空间，
 * 所以"碰巧能用"，但这是靠实现细节，而且掩盖了两个真问题：
 *
 * 1. 心跳与语音轮询这两个 interval **根本没被加进集合**，
 *    也就是 destroy() 时压根没清（长时间开关房间会累积定时器）；
 * 2. 谁也看不出哪些是 interval、哪些是 timeout。
 *
 * 现在按类型分开登记，各自用对应的 clear，并且顺手把上面第 1 点补上。
 */

export class Timers {
  private readonly intervals = new Set<number>();
  private readonly timeouts = new Set<number>();

  /** 登记一个 interval（会立刻启动）。 */
  every(ms: number, fn: () => void): number {
    const id = window.setInterval(fn, ms);
    this.intervals.add(id);
    return id;
  }

  /** 登记一个 timeout（会立刻启动）。 */
  after(ms: number, fn: () => void): number {
    const id = window.setTimeout(() => {
      // 先摘掉自己，避免集合长期持有已完成的 id
      this.timeouts.delete(id);
      fn();
    }, ms);
    this.timeouts.add(id);
    return id;
  }

  /** 手动撤掉一个 timeout（例如"等 welcome"的超时在成功时不再需要）。 */
  cancel(id: number): void {
    if (!id) return;
    if (this.timeouts.delete(id)) {
      window.clearTimeout(id);
      return;
    }
    if (this.intervals.delete(id)) window.clearInterval(id);
  }

  /** 全部清掉。 */
  clear(): void {
    for (const id of this.intervals) window.clearInterval(id);
    for (const id of this.timeouts) window.clearTimeout(id);
    this.intervals.clear();
    this.timeouts.clear();
  }

  /** 当前挂着的数量，供调试与测试断言使用。 */
  get size(): { intervals: number; timeouts: number } {
    return { intervals: this.intervals.size, timeouts: this.timeouts.size };
  }
}
