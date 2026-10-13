/**
 * BLAKE3（纯 JavaScript，零依赖）——部署脚本用的副本。
 *
 * 与 src/shared/blake3.ts 是同一份算法；之所以存在两份，是因为部署脚本必须能在
 * 没有 npm / 构建工具的隔离环境里直接跑。两者由 tests/blake3.test.ts 用官方
 * 测试向量同时验证（含"两份实现结果一致"的断言），不会各自漂移。
 */

const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;

const IV = Uint32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
  0x5be0cd19,
]);

const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];

function mix(state, a, b, c, d, mx, my) {
  state[a] = (state[a] + state[b] + mx) >>> 0;
  let x = state[d] ^ state[a];
  state[d] = ((x >>> 16) | (x << 16)) >>> 0;
  state[c] = (state[c] + state[d]) >>> 0;
  x = state[b] ^ state[c];
  state[b] = ((x >>> 12) | (x << 20)) >>> 0;
  state[a] = (state[a] + state[b] + my) >>> 0;
  x = state[d] ^ state[a];
  state[d] = ((x >>> 8) | (x << 24)) >>> 0;
  state[c] = (state[c] + state[d]) >>> 0;
  x = state[b] ^ state[c];
  state[b] = ((x >>> 7) | (x << 25)) >>> 0;
}

function compress(chainingValue, blockWords, counter, blockLen, flags) {
  const state = new Uint32Array(16);
  state.set(chainingValue, 0);
  state.set(IV.subarray(0, 4), 8);
  state[12] = counter >>> 0;
  state[13] = Math.floor(counter / 0x100000000) >>> 0;
  state[14] = blockLen;
  state[15] = flags;

  const message = Uint32Array.from(blockWords);
  const scratch = new Uint32Array(16);
  for (let round = 0; round < 7; round++) {
    mix(state, 0, 4, 8, 12, message[0], message[1]);
    mix(state, 1, 5, 9, 13, message[2], message[3]);
    mix(state, 2, 6, 10, 14, message[4], message[5]);
    mix(state, 3, 7, 11, 15, message[6], message[7]);
    mix(state, 0, 5, 10, 15, message[8], message[9]);
    mix(state, 1, 6, 11, 12, message[10], message[11]);
    mix(state, 2, 7, 8, 13, message[12], message[13]);
    mix(state, 3, 4, 9, 14, message[14], message[15]);
    if (round < 6) {
      for (let i = 0; i < 16; i++) scratch[i] = message[MSG_PERMUTATION[i]];
      message.set(scratch);
    }
  }

  const output = new Uint32Array(16);
  for (let i = 0; i < 8; i++) {
    output[i] = state[i] ^ state[i + 8];
    output[i + 8] = state[i + 8] ^ chainingValue[i];
  }
  return output;
}

function wordsFromBytes(bytes, offset, length) {
  const words = new Uint32Array(16);
  for (let i = 0; i < length; i++) {
    words[i >> 2] = (words[i >> 2] | (bytes[offset + i] << ((i & 3) * 8))) >>> 0;
  }
  return words;
}

function wordsToBytes(words, count) {
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    out[i * 4] = words[i] & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}

function chunkOutput(bytes, counter, root) {
  let chainingValue = IV;
  const totalBlocks = Math.max(1, Math.ceil(bytes.length / BLOCK_LEN));
  for (let index = 0; index < totalBlocks; index++) {
    const isLast = index === totalBlocks - 1;
    const length = Math.min(BLOCK_LEN, bytes.length - index * BLOCK_LEN);
    let flags = 0;
    if (index === 0) flags |= CHUNK_START;
    if (isLast) flags |= CHUNK_END;
    if (isLast && root) flags |= ROOT;
    const output = compress(
      chainingValue,
      wordsFromBytes(bytes, index * BLOCK_LEN, Math.max(0, length)),
      counter,
      length,
      flags,
    );
    if (isLast) return output;
    chainingValue = output.subarray(0, 8);
  }
  throw new Error("unreachable");
}

function parentOutput(left, right, root) {
  const block = new Uint8Array(BLOCK_LEN);
  block.set(wordsToBytes(left.subarray(0, 8), 8), 0);
  block.set(wordsToBytes(right.subarray(0, 8), 8), 32);
  return compress(
    IV,
    wordsFromBytes(block, 0, BLOCK_LEN),
    0,
    BLOCK_LEN,
    PARENT | (root ? ROOT : 0),
  );
}

function subtreeOutput(bytes, counter, root) {
  if (bytes.length <= CHUNK_LEN) return chunkOutput(bytes, counter, root);
  const totalChunks = Math.ceil(bytes.length / CHUNK_LEN);
  let leftChunks = 1;
  while (leftChunks * 2 < totalChunks) leftChunks *= 2;
  const splitAt = leftChunks * CHUNK_LEN;
  const left = subtreeOutput(bytes.subarray(0, splitAt), counter, false);
  const right = subtreeOutput(bytes.subarray(splitAt), counter + leftChunks, false);
  return parentOutput(left, right, root);
}

export function blake3(input) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  return wordsToBytes(subtreeOutput(bytes, 0, true), 8);
}

export function blake3Hex(input) {
  return Buffer.from(blake3(input)).toString("hex");
}
