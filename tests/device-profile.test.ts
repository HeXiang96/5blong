import { describe, expect, it } from "vitest";

import { canHardwareDecode } from "../src/client/voice/device-profile";
import { sanitizeDeviceProfile } from "../src/client/voice/protocol";

/**
 * 设备画像的解析与能力判断。
 *
 * 这两段一个吃**外部输入**（别的客户端发什么都有可能），一个决定**给谁编什么码**，
 * 都是判错就有后果的地方，所以逐条钉死。
 */

describe("sanitizeDeviceProfile（外部输入清洗）", () => {
  it("正常对象原样通过", () => {
    const dev = sanitizeDeviceProfile({
      gpu: "NVIDIA GeForce RTX 4060 Ti",
      os: "Windows 10.0",
      dec: ["h264", "av1"],
      enc: ["h264"],
      soft: true,
    });
    expect(dev).toEqual({
      gpu: "NVIDIA GeForce RTX 4060 Ti",
      os: "Windows 10.0",
      dec: ["h264", "av1"],
      enc: ["h264"],
      soft: true,
    });
  });

  it("dec/enc 只认白名单，脏值被丢掉", () => {
    const dev = sanitizeDeviceProfile({ dec: ["h264", "evil", 42, null, "av1"] });
    expect(dev?.dec).toEqual(["h264", "av1"]);
  });

  it("重复值去重", () => {
    expect(sanitizeDeviceProfile({ dec: ["h264", "h264"] })?.dec).toEqual(["h264"]);
  });

  it("数组里全是脏值 → 整个字段不出现", () => {
    const dev = sanitizeDeviceProfile({ dec: ["h265", "theora"], gpu: "X" });
    expect(dev).toEqual({ gpu: "X" });
  });

  it("超长字符串被截断（GPU 48 / OS 24）", () => {
    const dev = sanitizeDeviceProfile({ gpu: "x".repeat(200), os: "y".repeat(200) });
    expect(dev?.gpu).toHaveLength(48);
    expect(dev?.os).toHaveLength(24);
  });

  it("soft 只有 true 才算，别的值一律忽略", () => {
    expect(sanitizeDeviceProfile({ soft: "yes" })?.soft).toBeUndefined();
    expect(sanitizeDeviceProfile({ soft: 1 })?.soft).toBeUndefined();
    expect(sanitizeDeviceProfile({ soft: true })?.soft).toBe(true);
  });

  it("非对象 / 空对象 / 全空字段 → undefined（按“未知”处理）", () => {
    expect(sanitizeDeviceProfile(null)).toBeUndefined();
    expect(sanitizeDeviceProfile("gpu")).toBeUndefined();
    expect(sanitizeDeviceProfile(undefined)).toBeUndefined();
    expect(sanitizeDeviceProfile({})).toBeUndefined();
    expect(sanitizeDeviceProfile({ gpu: "", dec: [] })).toBeUndefined();
  });
});

describe("canHardwareDecode（逐观众选编码的依据）", () => {
  const modern = { dec: ["av1"] };

  it("有 dev.dec 时以它为准（不看旧的 av1Decode 布尔）", () => {
    expect(canHardwareDecode(modern, false, "av1")).toBe(true);
    expect(canHardwareDecode(modern, true, "h264")).toBe(false);
  });

  it("这台机器 H.264 硬解坏了但 AV1 好 → 应走 AV1", () => {
    const dev = { dec: ["av1"] };
    expect(canHardwareDecode(dev, true, "h264")).toBe(false);
    expect(canHardwareDecode(dev, true, "av1")).toBe(true);
  });

  it("老客户端没有 dev：H.264 当能（最低共同分母），AV1 看布尔", () => {
    expect(canHardwareDecode(undefined, undefined, "h264")).toBe(true);
    expect(canHardwareDecode(undefined, undefined, "av1")).toBe(false);
    expect(canHardwareDecode(undefined, true, "av1")).toBe(true);
  });

  it("vp9 没有旧字段可退化，缺省按不能硬解处理", () => {
    expect(canHardwareDecode(undefined, true, "vp9")).toBe(false);
    expect(canHardwareDecode({ dec: ["vp9"] }, undefined, "vp9")).toBe(true);
  });
});
