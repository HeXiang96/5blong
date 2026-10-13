import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { blake3Hex } from "../src/shared/blake3.ts";

interface Vector {
  input_len: number;
  hash: string;
}

const vectors: Vector[] = JSON.parse(
  readFileSync(new URL("./fixtures/blake3-test-vectors.json", import.meta.url), "utf8"),
).cases;

/** 官方 test_vectors.json 里的输入：0,1,...,250,0,1,... */
function officialInput(length: number): Uint8Array {
  const seed = Uint8Array.from({ length: 251 }, (_, index) => index);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = seed[i % 251]!;
  return bytes;
}

describe("BLAKE3", () => {
  it("matches every official unkeyed test vector", () => {
    expect(vectors.length).toBeGreaterThan(30);
    const failures: string[] = [];
    for (const vector of vectors) {
      const actual = blake3Hex(officialInput(vector.input_len));
      // 向量给的是扩展输出，前 32 字节即默认摘要。
      if (actual !== vector.hash.slice(0, 64)) {
        failures.push(`len=${vector.input_len}\n  期望 ${vector.hash.slice(0, 64)}\n  实际 ${actual}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("crosses every structural boundary", () => {
    // 单块 / 块边界 / 单块整 / 双块 / 双块整 / 多块树合并
    for (const length of [0, 1, 63, 64, 65, 1023, 1024, 1025, 2048, 2049, 3072, 4096, 5120]) {
      const vector = vectors.find((item) => item.input_len === length);
      if (!vector) continue;
      expect(blake3Hex(officialInput(length)), `len=${length}`).toBe(vector.hash.slice(0, 64));
    }
  });

  it("hashes the empty input to the published digest", () => {
    expect(blake3Hex(new Uint8Array(0))).toBe(
      "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
  });

  it("accepts a string input as utf8 bytes", () => {
    expect(blake3Hex("abc")).toBe(
      blake3Hex(new TextEncoder().encode("abc")),
    );
  });

  it("keeps the deploy script's copy in sync", async () => {
    // 部署脚本必须能在没有构建工具的环境里直接跑，因此存了一份 .mjs 副本。
    // 这里同时用官方向量验证它，并逐长度比对两份实现，避免任何一方漂移。
    const copy = await import("../scripts/lib/blake3.mjs");
    for (const vector of vectors) {
      const bytes = officialInput(vector.input_len);
      expect(copy.blake3Hex(bytes), `len=${vector.input_len}`).toBe(vector.hash.slice(0, 64));
    }
    for (const length of [0, 1, 64, 65, 1024, 1025, 4096]) {
      expect(copy.blake3Hex(officialInput(length))).toBe(blake3Hex(officialInput(length)));
    }
  });
});
