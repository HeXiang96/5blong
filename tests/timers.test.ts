/**
 * 定时器登记表的测试（node 环境，所以自己补一个最小的 window 假实现）。
 *
 * 这块对应两个真实问题：
 * - 原来 `timers` 集合混装 interval / timeout 的 id，却一律用 clearInterval 清；
 * - 用的假计时器能断言"该清的真的清了"，而不依赖浏览器共用 id 空间的巧合。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Timers } from "../src/client/voice/timers";

/** 记录每次 clear 用的是哪个 API，用来验证"类型配对"。 */
interface FakeWindow {
  setInterval: (fn: () => void, ms: number) => number;
  setTimeout: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  clearTimeout: (id: number) => void;
  clearedIntervals: number[];
  clearedTimeouts: number[];
}

let fake: FakeWindow;
let seq = 0;
const live = new Map<number, () => void>();

beforeEach(() => {
  seq = 0;
  live.clear();
  fake = {
    setInterval: (fn) => {
      seq += 1;
      live.set(seq, fn);
      return seq;
    },
    setTimeout: (fn) => {
      seq += 1;
      live.set(seq, fn);
      return seq;
    },
    clearInterval: (id) => {
      fake.clearedIntervals.push(id);
      live.delete(id);
    },
    clearTimeout: (id) => {
      fake.clearedTimeouts.push(id);
      live.delete(id);
    },
    clearedIntervals: [],
    clearedTimeouts: [],
  };
  vi.stubGlobal("window", fake);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("定时器登记表", () => {
  it("interval 用 clearInterval 清、timeout 用 clearTimeout 清（类型配对）", () => {
    const timers = new Timers();
    const intervalId = timers.every(100, () => {});
    const timeoutId = timers.after(100, () => {});

    timers.clear();

    expect(fake.clearedIntervals).toContain(intervalId);
    expect(fake.clearedIntervals).not.toContain(timeoutId);
    expect(fake.clearedTimeouts).toContain(timeoutId);
    expect(fake.clearedTimeouts).not.toContain(intervalId);
  });

  it("clear 之后不留下任何活着的定时器", () => {
    const timers = new Timers();
    timers.every(50, () => {});
    timers.after(50, () => {});
    expect(live.size).toBe(2);
    timers.clear();
    expect(live.size).toBe(0);
    expect(timers.size).toEqual({ intervals: 0, timeouts: 0 });
  });

  it("after 到点会执行回调，并把自己从登记表摘掉", () => {
    const timers = new Timers();
    const fn = vi.fn();
    timers.after(10, fn);
    expect(timers.size.timeouts).toBe(1);

    const run = [...live.values()][0]!;
    run();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(timers.size.timeouts).toBe(0);
  });

  it("cancel 能撤掉还没触发的 timeout（等 welcome 成功时用）", () => {
    const timers = new Timers();
    const fn = vi.fn();
    const id = timers.after(10, fn);
    timers.cancel(id);
    expect(fake.clearedTimeouts).toContain(id);
    expect(timers.size.timeouts).toBe(0);
    // 即使有人拿着旧回调跑一遍，也不该有任何残留
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel(0) 是安全的空操作（未设置时的默认值）", () => {
    const timers = new Timers();
    expect(() => timers.cancel(0)).not.toThrow();
    expect(fake.clearedTimeouts).toHaveLength(0);
    expect(fake.clearedIntervals).toHaveLength(0);
  });

  it("cancel 也认识 interval", () => {
    const timers = new Timers();
    const id = timers.every(10, () => {});
    timers.cancel(id);
    expect(fake.clearedIntervals).toContain(id);
    expect(timers.size.intervals).toBe(0);
  });

  it("everyBackground 在没有 Worker 的环境里退回主线程 interval，且能正常停", () => {
    // node 环境没有 Worker：这正是"老内核/受限环境"的等价情形
    vi.stubGlobal("Worker", undefined);
    const timers = new Timers();
    const fn = vi.fn();
    const id = timers.everyBackground(10, fn);
    expect(timers.size.intervals).toBe(1);

    // 退回主线程后，回调仍由 window.setInterval 驱动
    const run = [...live.values()][0]!;
    run();
    expect(fn).toHaveBeenCalledTimes(1);

    timers.cancel(id);
    expect(live.size).toBe(0);
    expect(timers.size.intervals).toBe(0);
  });
});
