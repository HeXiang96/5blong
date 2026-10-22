/**
 * 后台不节流的计时器。
 *
 * 为什么需要：页面/窗口被隐藏（切到游戏、最小化、托盘）后，Chromium 会做两级节流：
 *   1. 隐藏页的 DOM 定时器最小间隔被拉到 1000ms；
 *   2. 隐藏超过 5 分钟后进入"密集节流"（Intensive WakeUpThrottling），
 *      定时器被压到**约 1 分钟一次**，直到页面回到前台。
 * 对语音房来说这是硬伤：媒体看门狗、自愈重拨、小结采样都靠定时器，
 * 一旦被压到 1 分钟一次，单向无声要一分钟后才发现，小结时长也全错。
 *
 * 两条对策（缺一不可）：
 *   - 桌面端（Tauri/WebView2）：启动参数直接关掉节流（见 src-tauri/src/lib.rs），
 *     这是**唯一**能做到"真的不节流"的地方；
 *   - 网页端：浏览器策略改不了（网站无权关），但可以换执行线程——
 *     把关键循环放到 Web Worker 里计时，主线程只接消息。Chromium 的密集节流
 *     针对的是页面的 DOM 定时器，Worker 里的 setInterval 不受这条策略约束
 *     （项目里心跳本来就靠这招，实测有效：worker ticker 上线后"切出去就被踢"消失）。
 *
 * 不追求精确：回调仍在主线程执行，时序语义与 setInterval 一致。
 * Worker 不可用（旧内核/受限环境）时自动退回主线程 setInterval，行为不退化。
 */

interface Entry {
  ms: number;
  fn: () => void;
}

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const handlers = new Map<number, Entry>();
/** Worker 不可用时，退回主线程的 interval id。 */
const fallbacks = new Map<number, number>();

const WORKER_SOURCE = `
  const timers = new Map();
  onmessage = (event) => {
    const data = event.data || {};
    const id = data.id;
    if (data.op === "start") {
      const old = timers.get(id);
      if (old) clearInterval(old);
      timers.set(id, setInterval(() => postMessage(id), data.ms));
    } else if (data.op === "stop") {
      const t = timers.get(id);
      if (t) clearInterval(t);
      timers.delete(id);
    }
  };
`;

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (workerBroken || typeof Worker === "undefined") return null;
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    const created = new Worker(url);
    created.onmessage = (event: MessageEvent) => {
      handlers.get(event.data as number)?.fn();
    };
    // Worker 内部异常（被 CSP 拦、被终止）：整体退回主线程，别让关键循环悄悄停摆
    created.onerror = () => {
      workerBroken = true;
      worker = null;
      for (const [id, entry] of handlers) {
        if (!fallbacks.has(id)) fallbacks.set(id, window.setInterval(entry.fn, entry.ms));
      }
    };
    worker = created;
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** 启动一个"后台不节流"的周期任务，返回可交给 stopBackgroundInterval 的 id。 */
export function startBackgroundInterval(ms: number, fn: () => void): number {
  seq += 1;
  const id = 1_000_000 + seq; // 与 window 定时器 id 空间分开，避免误清
  handlers.set(id, { ms, fn });
  const target = ensureWorker();
  if (target) target.postMessage({ id, ms, op: "start" });
  else fallbacks.set(id, window.setInterval(fn, ms));
  return id;
}

/** 停掉一个周期任务（幂等）。 */
export function stopBackgroundInterval(id: number): void {
  if (!id) return;
  handlers.delete(id);
  const fallback = fallbacks.get(id);
  if (fallback) {
    window.clearInterval(fallback);
    fallbacks.delete(id);
  }
  worker?.postMessage({ id, op: "stop" });
}

/** 仅供诊断：当前是否真的跑在 Worker 上。 */
export function backgroundTimerMode(): "worker" | "main" {
  return worker ? "worker" : "main";
}
