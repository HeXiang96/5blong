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
 * 模型怎么到用户机器上（业主定的方案，2026-11-04 改）：
 * - **不再随安装包发布**。18MB 的 wasm 以前用 `?url` 打进产物，安装包从 7MB 涨到
 *   16.6MB，网页端首包也被拖大；对局功能总共才 10KB，不该背这个锅。
 * - 改成**用户自己选择下载**：首次用到时弹对话框，点「下载」才从服务器拉
 *   （`/models/denoise_voice_core_bg.wasm`，桌面端走 https://5blong.site）。
 * - 下载进度、缓存登记都沿用原来的 Cache Storage 方案：下一次启动毫秒级识别，
 *   不再重复下载。
 * - 没下载 / 下载失败 → 引擎调用会抛错 → 上层自动降级 RNNoise，不影响通话。
 *
 * 实现要点：库内部写死了 `new URL("./wasm/…", import.meta.url)`，构建时由
 * vite.config.ts 的插件改写成哨兵地址；这里拦截 fetch，命中哨兵就返回缓存里的字节。
 * 所以"库里那行代码"始终不变，我们只在最外层接管数据来源。
 */
import { isDesktopRuntime } from "../runtime";

const MODEL_CACHE = "5blong-models";
const MODEL_LEDGER = "df-model-ledger-v1";
/** 模型字节的缓存键：固定字符串，换版本也不会因为资源哈希变化而失效。 */
const MODEL_BYTES_KEY = "dfn3-model-bytes-v1";
/** 构建期改写的哨兵文件名（与 vite.config.ts 里保持一致）。 */
const MODEL_SENTINEL = "__dfn_model__.wasm";
const MODEL_PATH = "/models/denoise_voice_core_bg.wasm";
/** 模型正常大小约 17.4MB；小于这个数多半是服务器返回了错误页。 */
const MODEL_MIN_BYTES = 8 * 1024 * 1024;

/**
 * 模型下载地址。
 * - 桌面端：WebView 里没有同源后端，直接打域名；
 * - 网页版：同源 `/models/…`（和站点一起发在 5blong.site 上）。
 * 需要临时指到别处时用 `VITE_DF_MODEL_URL`。
 */
export function modelUrl(): string {
  const override = import.meta.env["VITE_DF_MODEL_URL"] as string | undefined;
  if (override) return override;
  if (isDesktopRuntime()) return `https://5blong.site${MODEL_PATH}`;
  return MODEL_PATH;
}

function cacheStore(): Promise<Cache> {
  return caches.open(MODEL_CACHE);
}

/** 读缓存里的模型字节；没有 / 缓存不可用都返回 null。 */
async function readCachedBytes(): Promise<ArrayBuffer | null> {
  try {
    const cache = await cacheStore();
    const hit = await cache.match(MODEL_BYTES_KEY);
    return hit ? await hit.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/**
 * 老版本把字节存在"带哈希的 wasm 资源地址"下，升级后按新键找不到。
 * 这里扫一遍缓存，把认得出的那份搬到新键，省得老用户重下 17MB。
 */
async function migrateLegacyBytes(): Promise<ArrayBuffer | null> {
  try {
    const cache = await cacheStore();
    const keys = await cache.keys();
    for (const request of keys) {
      if (!/denoise_voice_core_bg.*\.wasm/i.test(request.url)) continue;
      const hit = await cache.match(request);
      if (!hit) continue;
      const bytes = await hit.arrayBuffer();
      if (bytes.byteLength < MODEL_MIN_BYTES) continue;
      await cache.put(MODEL_BYTES_KEY, new Response(bytes, { headers: { "Content-Type": "application/wasm" } }));
      return bytes;
    }
    return null;
  } catch {
    return null;
  }
}

let bytesPromise: Promise<ArrayBuffer | null> | null = null;

function loadBytes(): Promise<ArrayBuffer | null> {
  bytesPromise ??= readCachedBytes().then(async (cached) => cached ?? migrateLegacyBytes());
  return bytesPromise;
}

/** 查登记簿：模型下载过没有（毫秒级）。 */
export async function hasDfModel(): Promise<boolean> {
  try {
    const cache = await cacheStore();
    if (!(await cache.match(MODEL_LEDGER))) return false;
    return (await readCachedBytes()) !== null || (await migrateLegacyBytes()) !== null;
  } catch {
    return false;
  }
}

/**
 * 预热：把模型字节读进内存，第一次建链就不用等缓存 IO。
 * 只对"已经下过"的用户有意义；没下过返回得也很快。
 */
export async function warmModelCache(): Promise<void> {
  await loadBytes();
}

/**
 * 拦截库对哨兵地址的抓取：
 * - 缓存里有字节 → 直接喂给它（不产生任何网络请求）；
 * - 没有 → 回 404，让库失败、上层降级 RNNoise。
 *   **绝不在这里偷偷下载**：下不下 17MB 是用户点「下载」决定的。
 */
export function installDfModelFetchShim(): void {
  if (typeof window === "undefined" || shimInstalled) return;
  shimInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = "";
    try {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : String((input as Request).url ?? "");
    } catch {
      /* 取不到就当普通请求 */
    }
    if (!url.includes(MODEL_SENTINEL)) return nativeFetch(input as RequestInfo, init);
    const bytes = await loadBytes();
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(bytes, {
      status: 200,
      headers: { "Content-Type": "application/wasm", "Content-Length": String(bytes.byteLength) },
    });
  };
}

let shimInstalled = false;
// 模块被 App 引用即生效（早于任何一次麦克风建链）
installDfModelFetchShim();

/**
 * 下载模型（带进度），完成后写缓存 + 登记簿。
 * 进度回调 value ∈ 0..1。失败抛错（对话框显示重试）。
 */
export async function downloadModel(onProgress?: (value: number) => void): Promise<void> {
  const response = await fetch(modelUrl(), { cache: "no-store" });
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
  if (received < MODEL_MIN_BYTES) throw new Error("模型文件不完整，请重试");
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  onProgress?.(1);
  bytesPromise = Promise.resolve(bytes.buffer);
  try {
    const cache = await cacheStore();
    await cache.put(MODEL_BYTES_KEY, new Response(bytes, { headers: { "Content-Type": "application/wasm" } }));
    await cache.put(MODEL_LEDGER, new Response("ok", { status: 200 }));
  } catch {
    /* 缓存写不进去（隐私模式等）：本次仍可用，下次重新下载 */
  }
}
