/**
 * 房主权威猪位的"订阅制"分发。
 *
 * 为什么不走 React state：快照到达如果每条都 setState，RoomView 会
 * 以广播频率整体重渲染，叠加动画重建与强制布局，规模一大就把主线程
 * 拖垮（曾被 50ms 广播放大成"猪的动画很卡"的根因）。
 * 这里把最新位置存进模块级 store，各猪的渲染循环按帧自行读取，
 * 数据到达不触发任何 React 渲染。
 */

export interface PenPoseTarget {
  /** 猪中心横向 0~1（视口/舞台宽）。 */
  x: number;
  /** 纵深 0（最远）~1（最近）。 */
  lane: number;
}

const latest = new Map<string, PenPoseTarget>();

/** 引擎收到房主快照时调用（整表替换，不需要读旧值）。 */
export function setLatestPenPoses(poses: { id: string; x: number; lane: number }[]): void {
  latest.clear();
  for (const pose of poses) latest.set(pose.id, { x: pose.x, lane: pose.lane });
}

/** 清空（离房/重置用）。 */
export function clearPenPoses(): void {
  latest.clear();
}

/** 读某头猪的最新权威位置；没有就 undefined。 */
export function latestPenPose(id: string): PenPoseTarget | undefined {
  return latest.get(id);
}

/*
 * 访客端渲染驱动：所有跟随猪共用一个"推进器"。
 * - 前台：rAF 每帧推进（平滑）；
 * - 后台（rAF 会停）：Worker 计时器 100ms 一次小步推进，不节流——
 *   隐藏期间猪位持续收敛，回到前台时和权威位置只差一小步，
 *   不会出现"回来后猛跳/猛冲"。
 */
type Step = (now: number) => void;
const followers = new Map<string, Step>();
let rafId = 0;
let workerStop: (() => void) | null = null;

function stepAll(now: number): void {
  for (const step of followers.values()) step(now);
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

function startTickerIfNeeded(): void {
  if (rafId !== 0) return;
  const tick = (now: number) => {
    rafId = window.requestAnimationFrame(tick);
    stepAll(now);
  };
  rafId = window.requestAnimationFrame(tick);

  if (workerStop) return;
  if (typeof Worker !== "undefined") {
    const source =
      "let t=null;onmessage=(e)=>{if(e.data==='start'&&!t)t=setInterval(()=>postMessage(0),100);" +
      "if(e.data==='stop'&&t){clearInterval(t);t=null;}}";
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    worker.onmessage = () => {
      if (isHidden()) stepAll(performance.now());
    };
    worker.postMessage("start");
    workerStop = () => worker.terminate();
  } else if (typeof setInterval !== "undefined") {
    // 无 Worker 环境（单测）：退化为普通定时器
    const id = setInterval(() => {
      if (isHidden()) stepAll(performance.now());
    }, 100);
    workerStop = () => clearInterval(id);
  }
}

function stopTickerIfIdle(): void {
  if (followers.size > 0) return;
  if (rafId !== 0) {
    window.cancelAnimationFrame(rafId);
    rafId = 0;
  }
  workerStop?.();
  workerStop = null;
}

/** 注册一头访客猪的推进函数（返回注销）。 */
export function registerPigFollower(id: string, step: Step): () => void {
  followers.set(id, step);
  startTickerIfNeeded();
  return () => {
    if (followers.get(id) === step) followers.delete(id);
    stopTickerIfIdle();
  };
}
