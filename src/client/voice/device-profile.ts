/**
 * 设备画像采集。
 *
 * 目的：让**每台机器**拿到适合自己的编解码参数，而不是所有人一刀切。
 *
 * 分工（很重要，别搞混）
 * ----------------------
 * - **决策依据**是 `dec` / `enc`（这台机器能硬解/硬编哪些格式），来自
 *   `probeHardwareEncoders()`——它问的是 `mediaCapabilities.decodingInfo`，
 *   回答的是"WebRTC 这条路上会不会走硬件"，比猜显卡型号靠谱得多。
 * - `gpu` / `os` **只用于诊断**：观众说"我这边黑的"时，能一眼看出人家是什么机器；
 *   将来做"已知坏机器名单"也用它做 key。它们不参与任何参数选择。
 *
 * 为什么显卡信息从 WebGL 取而不是读注册表
 * --------------------------------------
 * WebGL 的 `UNMASKED_RENDERER_WEBGL` 给的是形如
 * `ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)`
 * 的字符串，抠出型号就够用了，而且**网页版也能拿**（读注册表只有桌面客户端能）。
 * 代价是拿不到驱动版本号——驱动号是"已知坏机器名单"想要的，等有能编译 Rust 的
 * 环境再加一个 `get_device_profile` 命令补上，不影响现在的自动选参。
 */

import { isTauriRuntime } from "./loopback";
import type { DeviceProfile } from "./protocol";
import type { HardwareCodecProbe } from "./screen-share";

/**
 * 从 WebGL 渲染器串里抠出 GPU 型号。
 *
 * 三种形态都要认：
 * - ANGLE：`ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)`
 * - 裸渲染器：`NVIDIA GeForce RTX 4060 Ti/PCIe/SSE2`
 * - 软件渲染：`Google SwiftShader` / `llvmpipe`（说明没硬件加速，本身也是重要信息）
 */
function readGpuModel(): string | undefined {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return undefined;
    let raw: unknown;
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    raw = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    // 用完立刻释放上下文：不释放会占着 GPU 资源，反复进房可能撞到上下文上限
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    if (typeof raw !== "string" || raw.length === 0) return undefined;

    let model: string = raw;
    /*
     * ANGLE 形态：括号里第 2 段才是完整型号（第 1 段是厂商）。
     *
     * ⚠️ 必须**贪婪**匹配到最后一个 `)`：真实串长这样
     *   ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti (0x00002788) Direct3D11 vs_5_0 ps_5_0, D3D11)
     * 型号里自己还带一层 `(0x…)` 设备 ID。用 `/\(([^)]*)\)/` 只取到第一个 `)`，
     * 会剩下半截 `(0x00002788`，界面上就成了
     *   "NVIDIA GeForce RTX 4060 Ti (0x00002788"
     * （业主 2026-10-27 截图点名过）。
     */
    const inner = /\(([\s\S]*)\)/.exec(model)?.[1];
    if (inner) {
      const parts = inner
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      model = parts.length >= 2 ? parts[1]! : (parts[0] ?? model);
    }
    return (
      model
        .replace(/\(0x[0-9a-f]+\)/gi, "")
        .replace(/Direct3D\d+/gi, "")
        .replace(/vs_\d+_\d+/gi, "")
        .replace(/ps_\d+_\d+/gi, "")
        .replace(/\/PCIe\/SSE2/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 48) || undefined
    );
  } catch {
    return undefined;
  }
}

/** 操作系统（UA 里能拿到版本段；桌面客户端另有更精确的版本号，这里只求可读） */
function readOs(): string | undefined {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const nt = /Windows NT ([\d.]+)/.exec(ua);
  if (nt) return `Windows ${nt[1]}`;
  const mac = /Mac OS X ([\d_.]+)/.exec(ua);
  if (mac) return `macOS ${mac[1]!.replace(/_/g, ".")}`;
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return undefined;
}

let cached: Promise<DeviceProfile> | null = null;

/**
 * 采集本机设备画像（进程内缓存一次）。
 *
 * 入参是已经探好的硬件编解码结果——本来就要探一次，这里不重复问浏览器。
 * 任何一步失败都只是**少一个字段**，绝不抛错：画像只影响"能不能更优"，
 * 不该影响"能不能进房"。
 */
export function collectDeviceProfile(probe: HardwareCodecProbe): Promise<DeviceProfile> {
  cached ??= (async (): Promise<DeviceProfile> => {
    const dec: string[] = [];
    if (probe.decH264) dec.push("h264");
    if (probe.decAv1) dec.push("av1");
    const enc: string[] = [];
    if (probe.h264) enc.push("h264");
    if (probe.av1) enc.push("av1");

    const out: DeviceProfile = {};
    const gpu = readGpuModel();
    if (gpu) out.gpu = gpu;
    const os = readOs();
    if (os) out.os = os;
    if (dec.length > 0) out.dec = dec;
    if (enc.length > 0) out.enc = enc;

    // 桌面客户端：把"是否已开启兼容模式（关硬件解码）"一并报出去，
    // 别人看到 soft=true 就知道这台机器正在软解，不必再怀疑是参数问题。
    if (isTauriRuntime()) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        if (await invoke<boolean>("get_playback_compat")) out.soft = true;
      } catch {
        /* 老客户端没有这个命令，忽略 */
      }
    }
    return out;
  })();
  return cached;
}

/**
 * 这台的**解码能力**能否硬解某个格式。
 *
 * 名册里的 `dev.dec` 是权威值；老客户端只有 `av1Decode` 一个布尔，
 * 所以退化路径是：h264 一律当作"能"（H.264 是最低共同分母），av1 看那个布尔。
 */
export function canHardwareDecode(
  dev: DeviceProfile | undefined,
  fallbackAv1: boolean | undefined,
  codec: "h264" | "vp9" | "av1",
): boolean {
  if (dev?.dec) return dev.dec.includes(codec);
  if (codec === "av1") return fallbackAv1 === true;
  return codec === "h264";
}
