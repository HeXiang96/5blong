/**
 * DeepFilterNet3 实时降噪（2026-11-04 替换 RNNoise 成为"AI 智能降噪"的主力）。
 *
 * 为什么换：RNNoise（2018 年的开源模型）对风扇/电流这类**稳态**噪声效果不错，
 * 但对键盘、薯片袋这类**近距离瞬态脉冲声**天然乏力。DeepFilterNet3（2023）是
 * 新一代开源语音增强模型，对瞬态噪声的抑制明显更强。
 *
 * 引擎选型（实测过，不是看广告）：
 * - `@lofcz/deepfilternet-web`：wasm 里 df_create_default 输出全零（权重损坏），
 *   实测废案；
 * - `denoise-voice-clarity`（本包）：DFN3 权重烧在 wasm 里，Node 实测——
 *   稳态噪声抑制 25.8 dB、人声损耗 1.5 dB。**采用这个**。
 *
 * "下过没有"的识别（业主定的方案）：Cache Storage 做登记簿。
 * - 模型 wasm 已随应用打包（同源加载，不发 GitHub）；
 * - 首次用对话框引导下载（带进度条），下载完成在缓存仓库写登记；
 * - `hasDfModel()` 毫秒级识别；下载一次永久有效（除非清缓存/删应用数据）。
 */

// 该包的 exports 字段不开放 dist 子路径，用相对路径直接取（?url 由 Vite 发射资产）。
// 注意层级：本文件在 src/client/voice/，到项目根要三级。
import dfWasmUrl from "../../../node_modules/denoise-voice-clarity/dist/wasm/denoise_voice_core_bg.wasm?url";

const MODEL_CACHE = "5blong-models";
const MODEL_LEDGER = "df-model-ledger-v1";

export { dfWasmUrl };

function cacheStore(): Promise<Cache> {
  return caches.open(MODEL_CACHE);
}

/** 查登记簿：模型下载过没有（毫秒级）。 */
export async function hasDfModel(): Promise<boolean> {
  try {
    const cache = await cacheStore();
    return (await cache.match(MODEL_LEDGER)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * 预热：把模型 wasm 拉进 HTTP 缓存（浏览器会缓存同源资源，
 * 之后 denoise-voice-clarity 引擎自己 fetch 时直接命中缓存）。
 * 只在已登记过（下过）时才值得做；没登记过走对话框。
 */
export async function warmModelCache(): Promise<void> {
  try {
    await fetch(dfWasmUrl, { cache: "force-cache" });
  } catch {
    /* 预热失败无所谓：建链时会再试 */
  }
}

/**
 * 下载模型（带进度），完成后写登记簿。
 * 进度回调 value ∈ 0..1。失败抛错（对话框显示重试）。
 */
export async function downloadModel(onProgress?: (value: number) => void): Promise<void> {
  const response = await fetch(dfWasmUrl, { cache: "reload" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      if (total > 0) onProgress?.(Math.min(1, received / total));
    }
  }
  onProgress?.(1);
  // 写登记簿（顺带把字节也存一份，作为引擎加载失败的备用数据源）
  try {
    const cache = await cacheStore();
    const blob = new Blob(chunks as BlobPart[]);
    await cache.put(MODEL_LEDGER, new Response("ok", { status: 200 }));
    await cache.put(dfWasmUrl, new Response(blob, { status: 200 }));
  } catch {
    /* 缓存写不进去（隐私模式等）：本次仍可用，下次重新下载 */
  }
}
