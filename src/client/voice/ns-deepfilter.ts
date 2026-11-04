/**
 * DeepFilterNet3 实时降噪（2026-11-04 替换 RNNoise 成为"AI 智能降噪"的主力）。
 *
 * 为什么换：RNNoise（2018 年的开源模型）对风扇/电流这类**稳态**噪声效果不错，
 * 但对键盘、薯片袋这类**近距离瞬态脉冲声**天然乏力（几十毫秒的爆发，频谱又和
 * 人声重叠，模型的抑制量来不及合上）。DeepFilterNet3（2022~）是新一代开源
 * 语音增强模型，对瞬态噪声的抑制明显更强。
 *
 * 实现：@lofcz/deepfilternet-web（libDF 的 wasm SIMD 构建，MIT/Apache 双协议），
 * 权重烧在 wasm 里。它提供的是 AudioWorkletProcessor（"deepfilternet-processor"），
 * 需要主线程把**编译好的 WebAssembly.Module** 通过 processorOptions 传进去
 * （worklet 里 initSync）。
 *
 * 代价要说清楚：wasm 34 MB（gzip 后 ~13 MB）。所以：
 * - 资源懒加载：只在"AI 降噪要启用"时才下载/编译，不用的人一个字节都不下；
 * - 加载失败自动回落 RNNoise（原来的模型还在，作为兜底），再不行直通。
 */

import dfWorkletUrl from "@lofcz/deepfilternet-web/worklet?url";
import dfWasmUrl from "@lofcz/deepfilternet-web/df_bg.wasm?url";

const PROCESSOR_NAME = "deepfilternet-processor";

export { dfWasmUrl };

/** 编译好的 wasm 模块缓存：同一个 AudioContext 们可以复用，避免重复编译 34 MB。 */
let compiledModule: WebAssembly.Module | null = null;
let compiling: Promise<WebAssembly.Module> | null = null;

async function compileWasm(): Promise<WebAssembly.Module> {
  if (compiledModule) return compiledModule;
  if (!compiling) {
    compiling = (async () => {
      // compileStreaming 需要服务器给 application/wasm 头；拿不到就退回数组缓冲。
      try {
        const response = await fetch(dfWasmUrl, { cache: "force-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const module = await WebAssembly.compileStreaming(response);
        compiledModule = module;
        return module;
      } catch {
        const buffer = await (await fetch(dfWasmUrl, { cache: "force-cache" })).arrayBuffer();
        const module = await WebAssembly.compile(buffer);
        compiledModule = module;
        return module;
      }
    })();
    compiling.catch(() => {
      // 失败了允许下次重试
      compiling = null;
    });
  }
  return compiling;
}

/**
 * 在 ctx 上注册 worklet 并创建降噪节点。
 * 抛错由调用方处理（引擎会回落 RNNoise）。
 */
export async function createDeepFilterNode(ctx: AudioContext, attenuationLimit = 100): Promise<AudioWorkletNode> {
  await ctx.audioWorklet.addModule(dfWorkletUrl);
  const wasmModule = await compileWasm();
  return new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { wasmModule, attenuationLimit },
  });
}

/** 预热：把 wasm 拉进 HTTP 缓存（不编译，不占内存）。首开降噪能省一大截等待。 */
export function preloadDeepFilter(): void {
  void fetch(dfWasmUrl, { cache: "force-cache" }).catch(() => {});
}
