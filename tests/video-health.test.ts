import { describe, expect, it } from "vitest";

import {
  DEFAULT_LUMA_MAX,
  DEFAULT_MIN_SECONDS,
  initialBlackWatchState,
  stepBlackWatch,
  type BlackSample,
  type BlackWatchState,
} from "../src/client/voice/video-health";

/**
 * 黑屏状态机的判定规则。
 *
 * 这段逻辑判错的两种后果都很糟：
 * - 漏报 → 用户继续看着黑屏，以为是我们不修；
 * - 误报 → 共享暗色/黑场内容的人被莫名其妙切成软解。
 * 所以每个分支都值得钉一个用例。
 */

const T0 = 1_000_000;

function sample(overrides: Partial<BlackSample> = {}): BlackSample {
  return { now: T0, luma: 0, frames: 100, usable: true, ...overrides };
}

/** 连续喂若干次采样，返回最终状态与收到的所有诊断 */
function feed(
  samples: BlackSample[],
  opts?: { lumaMax?: number; minSeconds?: number },
): { state: BlackWatchState; diagnoses: { seconds: number; frames: number }[] } {
  let state = initialBlackWatchState();
  const diagnoses: { seconds: number; frames: number }[] = [];
  for (const item of samples) {
    const result = stepBlackWatch(state, item, opts);
    state = result.state;
    if (result.diagnosis) diagnoses.push(result.diagnosis);
  }
  return { state, diagnoses };
}

describe("stepBlackWatch", () => {
  it("画面有亮度时不判定", () => {
    const { diagnoses, state } = feed([
      sample({ luma: 120 }),
      sample({ now: T0 + 60_000, luma: 30 }),
    ]);
    expect(diagnoses).toHaveLength(0);
    expect(state.since).toBeNull();
  });

  it("全黑但帧数没涨（暂停/卡住）不判定为硬解故障", () => {
    // 这是最容易误报的场景：画面不动，亮度自然为 0，但解码器没在产出
    const samples = Array.from({ length: 40 }, (_, i) =>
      sample({ now: T0 + i * 500, luma: 0, frames: 100 }),
    );
    const { diagnoses } = feed(samples);
    expect(diagnoses).toHaveLength(0);
  });

  it("全黑且帧在涨，但不足 minSeconds 时不判定", () => {
    const before = DEFAULT_MIN_SECONDS * 1000 - 500;
    const samples = [
      sample({ now: T0, frames: 0 }),
      sample({ now: T0 + before, frames: 300 }),
    ];
    const { diagnoses } = feed(samples);
    expect(diagnoses).toHaveLength(0);
  });

  it("全黑 + 帧在涨 + 达到时长 → 判定一次，并带上时长与帧数", () => {
    const samples = [
      sample({ now: T0, frames: 0 }),
      sample({ now: T0 + DEFAULT_MIN_SECONDS * 1000, frames: 480 }),
    ];
    const { diagnoses } = feed(samples);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]).toEqual({ seconds: DEFAULT_MIN_SECONDS, frames: 480 });
  });

  it("确诊后不再重复上报（同一段黑屏只提示一次）", () => {
    const samples = Array.from({ length: 30 }, (_, i) =>
      sample({ now: T0 + i * 500, luma: 0, frames: i * 30 }),
    );
    const { diagnoses, state } = feed(samples);
    expect(diagnoses).toHaveLength(1);
    expect(state.reported).toBe(true);
  });

  it("中途亮过一下会重新计时（视频黑场切换不该累加）", () => {
    const samples = [
      sample({ now: T0, frames: 0 }),
      sample({ now: T0 + 5000, frames: 150 }),
      sample({ now: T0 + 5500, luma: 90, frames: 165 }), // 亮了 → 计时清零
      sample({ now: T0 + 6000, frames: 180 }), // 又黑，从这一刻重新算
      sample({ now: T0 + 11_000, frames: 330 }), // 只黑了 5 秒
    ];
    const { diagnoses } = feed(samples);
    expect(diagnoses).toHaveLength(0);
  });

  it("采样无效（暂停/页面隐藏）整轮作废，但保留'已上报'", () => {
    const reported: BlackWatchState = { since: T0, framesAtStart: 0, reported: true };
    const result = stepBlackWatch(reported, sample({ usable: false, now: T0 + 9000 }));
    expect(result.state.since).toBeNull();
    expect(result.state.reported).toBe(true);
    expect(result.diagnosis).toBeNull();
  });

  it("亮度阈值可调：暗色 PPT（平均 20）在默认阈值下不算黑", () => {
    const samples = [
      sample({ now: T0, luma: 20, frames: 0 }),
      sample({ now: T0 + DEFAULT_MIN_SECONDS * 1000, luma: 20, frames: 400 }),
    ];
    expect(feed(samples).diagnoses).toHaveLength(0);
    // 阈值拉到 30 时同样的采样就会被判定
    expect(feed(samples, { lumaMax: 30 }).diagnoses).toHaveLength(1);
  });

  it("默认阈值保持保守（纯黑附近才算黑）", () => {
    expect(DEFAULT_LUMA_MAX).toBeLessThanOrEqual(10);
  });
});
