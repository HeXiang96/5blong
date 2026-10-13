/**
 * 本机存储：统一的键空间、容错读写、以及把 <input type="file"> 的图片压成头像。
 * 全部读操作都不抛异常——设置坏了不该阻止用户进房。
 */

const NS = "5blong:v1:";

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(NS + key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return fallback;
    return { ...fallback, ...(parsed as object) } as T;
  } catch {
    return fallback;
  }
}

/** 返回是否写入成功：写失败（配额满）时 UI 需要如实告知，而不是静默丢数据。 */
export function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readString(key: string): string | null {
  try {
    return localStorage.getItem(NS + key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string): boolean {
  try {
    localStorage.setItem(NS + key, value);
    return true;
  } catch {
    return false;
  }
}

/** 头像边长上限。原图直存 localStorage 会撑爆配额，先缩到这个尺寸再存。 */
const AVATAR_MAX_EDGE = 192;
const AVATAR_QUALITY = 0.82;

/**
 * 把用户选的图片压成方形头像 dataURL。
 * 失败（不是图片 / 解码失败）时抛出，由 UI 提示，不静默换成空白头像。
 */
export async function toAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const edge = Math.min(bitmap.width, bitmap.height);
    const side = Math.min(AVATAR_MAX_EDGE, edge);
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(
      bitmap,
      (bitmap.width - edge) / 2,
      (bitmap.height - edge) / 2,
      edge,
      edge,
      0,
      0,
      side,
      side,
    );
    const url = canvas.toDataURL("image/webp", AVATAR_QUALITY);
    // 个别浏览器不支持 webp 编码时会回落到 png，此时压缩收益有限但仍可用。
    return url.startsWith("data:image/") ? url : canvas.toDataURL("image/jpeg", AVATAR_QUALITY);
  } finally {
    bitmap.close();
  }
}
