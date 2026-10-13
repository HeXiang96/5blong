/**
 * 语音活动判定的测试。
 *
 * 这块逻辑当初出过真 bug：用"瞬时音量过阈值"判定，而人开始说话时音量是
 * 渐强的，第一个音节够不到阈值，于是动作明显跟不上说话。
 * 所以这里重点测两件事：**起音要快**、**不能抖**。
 */
import { describe, expect, it } from "vitest";

import { VoiceActivityDetector } from "../src/client/voice/voice-activity";

/** 按固定帧间隔喂一串音量，返回首次判定为"在说话"的帧序号。 */
function framesUntilStart(
  detector: VoiceActivityDetector,
  levels: number[],
  dtMs = 50,
): number {
  for (let i = 0; i < levels.length; i += 1) {
    const result = detector.push(levels[i]!, dtMs);
    if (result.active) return i;
  }
  return -1;
}

describe("语音活动判定", () => {
  it("安静时不判定为说话", () => {
    const detector = new VoiceActivityDetector();
    for (let i = 0; i < 20; i += 1) detector.push(2, 50);
    expect(detector.state.active).toBe(false);
  });

  it("持续说话会判定为说话", () => {
    const detector = new VoiceActivityDetector();
    for (let i = 0; i < 10; i += 1) detector.push(60, 50);
    expect(detector.state.active).toBe(true);
  });

  /*
   * 回归测试：起音要快。
   * 模拟"音量渐强"——第一帧只有 6，逐帧涨到 30。
   * 旧的瞬时阈值实现在第 4 帧左右才亮；预滚 + 快速起音应该在前 2 帧内亮起。
   */
  it("音量渐强时也能很快被判为说话（起音延迟的核心回归）", () => {
    const detector = new VoiceActivityDetector();
    const ramp = [6, 12, 20, 28, 34, 40];
    const at = framesUntilStart(detector, ramp);
    expect(at).toBeGreaterThanOrEqual(0);
    // 50ms 一帧，所以 2 帧 ≈ 100ms，远好于旧实现的 300ms 量级
    expect(at).toBeLessThanOrEqual(2);
  });

  it("起音必须发生在音量越过起始阈值之前（靠预滚提前识别）", () => {
    const detector = new VoiceActivityDetector();
    // 一帧就冲过阈值：必须立刻亮
    expect(detector.push(80, 50).active).toBe(true);
  });

  it("滞回：上到阈值以上亮，掉回阈值附近不会立刻灭（防抖）", () => {
    const detector = new VoiceActivityDetector();
    expect(detector.push(60, 50).active).toBe(true);
    // 掉到 13（高于收音阈值 11、低于起始阈值 16）：应保持亮着
    detector.push(13, 50);
    detector.push(13, 50);
    expect(detector.state.active).toBe(true);
  });

  it("长时间安静后熄灭", () => {
    const detector = new VoiceActivityDetector();
    detector.push(60, 50);
    expect(detector.state.active).toBe(true);
    // 收音时间常数 220ms，喂 2 秒静音足够灭
    for (let i = 0; i < 40; i += 1) detector.push(1, 50);
    expect(detector.state.active).toBe(false);
  });

  it("不允许说话时（被静音）立刻复位，不会残留包络", () => {
    const detector = new VoiceActivityDetector();
    detector.push(60, 50);
    expect(detector.state.active).toBe(true);

    const result = detector.push(60, 50, false);
    expect(result.active).toBe(false);
    expect(result.changed).toBe(true);
    expect(detector.state.envelope).toBe(0);

    // 解禁后不会因为旧包络立刻亮起来：安静帧应保持熄灭
    expect(detector.push(1, 50).active).toBe(false);
  });

  /*
   * 回归：间歇性的音量（说话/停顿快速交替）必须能回到"没说话"。
   * 这是实测踩到的坑：假麦克风的音量是间歇性的，
   * 而引擎的"停止"上报被节流丢掉，界面就永远卡在"正在说话"。
   * 判定器本身必须能正确回落，否则上层再对也没用。
   */
  it("间歇音量能回落（说话/停顿交替，不能卡在说话状态）", () => {
    const detector = new VoiceActivityDetector();
    const pattern = [110, 0, 120, 0, 105, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let sawActive = false;
    let sawIdle = false;
    for (const level of pattern) {
      const result = detector.push(level, 50);
      if (result.active) sawActive = true;
      else if (sawActive) sawIdle = true;
    }
    expect(sawActive).toBe(true);
    expect(sawIdle).toBe(true);
    expect(detector.state.active).toBe(false);
  });

  it("长时间静音后包络确实衰减到阈值以下", () => {
    const detector = new VoiceActivityDetector();
    detector.push(110, 50);
    expect(detector.state.active).toBe(true);
    for (let i = 0; i < 60; i += 1) detector.push(0, 50);
    expect(detector.state.envelope).toBeLessThan(11);
    expect(detector.state.active).toBe(false);
  });

  /*
   * 回归：停下说话后必须在合理时间内回到 idle。
   * 之前有"预滚缓冲"（取最近一段峰值），它会把旧的高音量顶住，
   * 使音量停下后的头几百毫秒状态回不去（实测猪一直停在"正在说话"）。
   */
  it("停止说话后 400ms 内回到 idle（预滚缓冲的回归）", () => {
    const detector = new VoiceActivityDetector();
    for (let i = 0; i < 6; i += 1) detector.push(110, 50);
    expect(detector.state.active).toBe(true);

    let framesToIdle = -1;
    for (let i = 0; i < 20; i += 1) {
      const result = detector.push(0, 50);
      if (!result.active) {
        framesToIdle = i + 1;
        break;
      }
    }
    expect(framesToIdle).toBeGreaterThan(0);
    // 50ms 一帧 → 400ms 相当于 8 帧
    expect(framesToIdle).toBeLessThanOrEqual(8);
  });

  it("状态没变化时 changed 为 false（避免每帧都触发上报表）", () => {
    const detector = new VoiceActivityDetector();
    detector.push(60, 50);
    expect(detector.push(60, 50).changed).toBe(false);
  });

  it("采样间隔变化（掉帧/后台）不改变行为方向", () => {
    const fast = new VoiceActivityDetector();
    const slow = new VoiceActivityDetector();
    // 同样 1 秒时长，一个 50ms 一帧、一个 200ms 一帧
    for (let i = 0; i < 20; i += 1) fast.push(60, 50);
    for (let i = 0; i < 5; i += 1) slow.push(60, 200);
    expect(fast.state.active).toBe(true);
    expect(slow.state.active).toBe(true);
  });
});
