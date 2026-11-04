import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { initSync, VoiceClarityWasm } from "../node_modules/denoise-voice-clarity/dist/wasm/denoise_voice_core.js";

/**
 * DeepFilterNet3 模型实测（2026-11-04，业主要求"先测有没有生效再推送"）。
 *
 * 不用 mock——在 Node 里直接实例化打包进应用的真 wasm，喂合成信号测：
 *   ① 模型能加载、帧长正确（480 样本 = 10ms @ 48kHz）；
 *   ② 稳态噪声（白噪声，模拟杂音底）被显著抑制；
 *   ③ 人声样的谐波信号基本保留（降噪不能把人声也压没）。
 *
 * 断言阈值来自 2026-11-04 的首轮实测（噪声 25.8dB / 人声 1.5dB）+ 余量。
 * 这组测试就是"模型有没有生效"的闸门：模型换版/构建坏了会在这里爆。
 *
 * ⚠️ 瞬态脉冲（键盘声）不进断言：DFN3 对短促脉冲的能量会被重叠窗平滑扩散，
 * 整帧 RMS 口径测不准（实测 -4.4dB ~ 0dB 波动），真实效果以人耳验收为准。
 */

const WASM_PATH = new URL(
  "../node_modules/denoise-voice-clarity/dist/wasm/denoise_voice_core_bg.wasm",
  import.meta.url,
);

function rms(x: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / x.length);
}

/** dB 形式的抑制量：正数 = 被压掉多少 dB。 */
function suppressionDb(inputRms: number, outputRms: number): number {
  return 20 * Math.log10(inputRms / Math.max(outputRms, 1e-9));
}

function createEngine(attenLim = 24): VoiceClarityWasm {
  const bytes = readFileSync(WASM_PATH);
  initSync(new Uint8Array(bytes.buffer.slice(bytes.byteOffset) as ArrayBuffer));
  const eng = new VoiceClarityWasm();
  // 与引擎一致的安全限幅：无限制时模型误判会把人声压掉 50dB+（实测）
  eng.set_attenuation_limit_db(attenLim);
  return eng;
}

describe("DeepFilterNet3 模型实测（真 wasm，非 mock）", () => {
  it("模型加载成功，帧长 = 480（10ms @ 48kHz）", () => {
    const eng = createEngine();
    expect(eng.frame_size).toBe(480);
    eng.free();
  });

  it("稳态噪声被显著抑制、人声谐波被保留", () => {
    const eng = createEngine();
    const L = eng.frame_size;

    // —— 稳态噪声：白噪声 0.2 幅度，2 秒（200 帧），统计后 1 秒（模型已收敛）
    let inRms = 0;
    let outRms = 0;
    let n = 0;
    for (let f = 0; f < 200; f++) {
      const frame = new Float32Array(L);
      for (let i = 0; i < L; i++) frame[i] = (Math.random() * 2 - 1) * 0.2;
      const before = rms(frame);
      eng.process(frame);
      if (f >= 100) {
        inRms += before;
        outRms += rms(frame);
        n += 1;
      }
    }
    const noiseSup = suppressionDb(inRms / n, outRms / n);
    console.log(`[实测] 稳态噪声抑制：${noiseSup.toFixed(1)} dB`);

    // —— 人声样谐波：150/300Hz 谐波 + 4Hz 幅度调制（类语音包络），2 秒
    let vi = 0;
    let vo = 0;
    let vn = 0;
    let t = 0;
    for (let f = 0; f < 200; f++) {
      const frame = new Float32Array(L);
      for (let i = 0; i < L; i++) {
        const pos = t + i;
        const env = 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * pos) / 48000);
        frame[i] =
          env *
          (0.32 * Math.sin((2 * Math.PI * 150 * pos) / 48000) +
            0.18 * Math.sin((2 * Math.PI * 300 * pos) / 48000));
      }
      t += L;
      const before = rms(frame);
      eng.process(frame);
      if (f >= 100) {
        vi += before;
        vo += rms(frame);
        vn += 1;
      }
    }
    const voiceSup = suppressionDb(vi / vn, vo / vn);
    console.log(`[实测] 人声样信号损耗：${voiceSup.toFixed(1)} dB（越小越保真）`);

    expect(noiseSup).toBeGreaterThan(15); // 稳态噪声：至少压掉 15 dB（实测 19.5 @ 限幅24）
    expect(voiceSup).toBeLessThan(3); // 人声：损耗必须小（实测 2.0）
    expect(noiseSup - voiceSup).toBeGreaterThan(10); // 降噪与保真的对比度
    eng.free();
  }, 60_000);

  it("键盘样瞬态脉冲被抑制（>10dB，实测 18.4）", () => {
    const eng = createEngine();
    const L = eng.frame_size;
    let ti = 0;
    let to = 0;
    let n = 0;
    for (let f = 0; f < 200; f++) {
      const frame = new Float32Array(L);
      for (let i = 0; i < L; i++) {
        const pos = f * L + i;
        frame[i] = pos % 2400 < 144 ? Math.sin(pos * 0.7) * 0.5 : 0;
      }
      const before = rms(frame);
      eng.process(frame);
      if (f >= 100) {
        ti += before;
        to += rms(frame);
        n += 1;
      }
    }
    const sup = suppressionDb(ti / n, to / n);
    console.log(`[实测] 键盘样瞬态抑制：${sup.toFixed(1)} dB`);
    expect(sup).toBeGreaterThan(10);
    eng.free();
  }, 60_000);

  it("类真实语音 + 稳态噪声混合：分段信噪比改善 >6dB（实测 9.5）", () => {
    const eng = createEngine();
    const L = eng.frame_size;
    const speechGen = (p: number) => {
      const period = 0.65 * 48000;
      const ph = p % period;
      const env = ph < 0.4 * 48000 ? Math.sin((Math.PI * ph) / (0.4 * 48000)) : 0;
      return (
        env *
        (0.3 * Math.sin((2 * Math.PI * 160 * p) / 48000) +
          0.2 * Math.sin((2 * Math.PI * 320 * p) / 48000) +
          0.12 * Math.sin((2 * Math.PI * 480 * p) / 48000))
      );
    };
    const sIn: number[] = [];
    const sOut: number[] = [];
    const nIn: number[] = [];
    const nOut: number[] = [];
    for (let f = 0; f < 400; f++) {
      const speaking = (f * L) % (0.65 * 48000) < 0.4 * 48000;
      const frame = new Float32Array(L);
      for (let i = 0; i < L; i++) frame[i] = speechGen(f * L + i) + (Math.random() * 2 - 1) * 0.05;
      const before = rms(frame);
      eng.process(frame);
      if (f >= 100) {
        (speaking ? sIn : nIn).push(before);
        (speaking ? sOut : nOut).push(rms(frame));
      }
    }
    const avg = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
    const snrBefore = suppressionDb(avg(sIn), avg(nIn));
    const snrAfter = suppressionDb(avg(sOut), avg(nOut));
    const gain = snrAfter - snrBefore;
    console.log(`[实测] 语音+噪声混合信噪比：${snrBefore.toFixed(1)}dB → ${snrAfter.toFixed(1)}dB（改善 ${gain.toFixed(1)}dB）`);
    expect(gain).toBeGreaterThan(6);
    eng.free();
  }, 60_000);

  it("纯静音输入输出也是静音（不注入底噪）", () => {
    const eng = createEngine();
    const L = eng.frame_size;
    for (let f = 0; f < 100; f++) eng.process(new Float32Array(L));
    const out = new Float32Array(L);
    eng.process(out);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(1e-4);
    eng.free();
  }, 60_000);
});
