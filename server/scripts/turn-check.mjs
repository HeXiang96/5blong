import dgram from "node:dgram";
import { createHash, createHmac } from "node:crypto";

/*
 * 完整的 TURN 分配测试。证明四件事：
 *   1. UDP 3478 从公网可达
 *   2. /ice 签发的凭据能被 coturn 验过
 *   3. external-ip 配对（返回的是公网地址）
 *   4. 中继端口落在放行的 50000-50999 段
 *
 * ⚠️ 必须走标准两步握手：先发不带认证的 Allocate 拿 401 + NONCE，
 *    再带 USERNAME/REALM/NONCE/MESSAGE-INTEGRITY 重发。
 *    直接带 MI 会得到 400（第一次就是这么错的）。
 */

const HOST = "8.210.198.140";
const PORT = 3478;

const ice = await (await fetch("https://5blong.site/ice")).json();
const { username, credential } = ice.iceServers[0];
console.log(`凭据：${username} / ${credential.slice(0, 10)}…`);

const attr = (type, value) => {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  const pad = (4 - (value.length % 4)) % 4;
  return Buffer.concat([head, value, Buffer.alloc(pad)]);
};

function readAttrs(msg) {
  const out = [];
  let offset = 20;
  while (offset + 4 <= msg.length) {
    const type = msg.readUInt16BE(offset);
    const len = msg.readUInt16BE(offset + 2);
    out.push({ type, value: msg.subarray(offset + 4, offset + 4 + len) });
    offset += 4 + len + ((4 - (len % 4)) % 4);
  }
  return out;
}

function build(attrs, key) {
  const body = Buffer.concat(attrs);
  const totalLen = body.length + (key ? 24 : 0);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(0x0003, 0);
  head.writeUInt16BE(totalLen, 2);
  head.writeUInt32BE(0x2112a442, 4);
  Buffer.from([...Array(12)].map(() => Math.floor(Math.random() * 256))).copy(head, 8);
  if (!key) return Buffer.concat([head, body]);

  const miHeader = Buffer.alloc(4);
  miHeader.writeUInt16BE(0x0008, 0);
  miHeader.writeUInt16BE(20, 2);
  /*
   * RFC 5389 §15.4：HMAC 的输入是「消息头 + MESSAGE-INTEGRITY 之前的属性」，
   * **不含 MESSAGE-INTEGRITY 自己的属性头**。但消息头里的长度字段必须已经
   * 把这 24 字节算进去。第一次把 MI 头也 hash 进去 → coturn 回 401。
   */
  const signedInput = Buffer.concat([head, body]);
  const integrity = createHmac("sha1", key).update(signedInput).digest();
  return Buffer.concat([head, body, miHeader, integrity]);
}

/*
 * 必须**复用同一个 socket**（同一个本地端口）。
 * coturn 的 NONCE 是按客户端地址签发并校验的，第二次请求换个源端口
 * 就会得到 438 Wrong nonce —— 第一次就是这么踩的。
 */
const socket = dgram.createSocket("udp4");
await new Promise((resolve) => socket.bind(0, resolve));

function exchange(packet, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const onMessage = (msg) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(msg);
    };
    socket.on("message", onMessage);
    socket.send(packet, PORT, HOST);
  });
}

const transport = attr(0x0019, Buffer.from([17, 0, 0, 0]));

// ── 第一步：不带认证，拿 401 + NONCE ──
const first = await exchange(build([transport]));
if (!first) {
  console.log("✗ 第一步就没响应（UDP 3478 不通）");
  process.exit(1);
}
const firstType = first.readUInt16BE(0);
if (firstType !== 0x0113) {
  console.log(`✗ 预期 401，实际 0x${firstType.toString(16)}`);
  process.exit(1);
}
const challenge = readAttrs(first);
const nonce = challenge.find((a) => a.type === 0x0015)?.value;
const realm = challenge.find((a) => a.type === 0x0014)?.value?.toString("utf8");
if (!nonce || !realm) {
  console.log("✗ 401 里没有 NONCE/REALM，coturn 的 use-auth-secret 可能没生效");
  process.exit(1);
}
console.log(`✓ 拿到挑战：realm=${realm}`);

// ── 第二步：带完整凭据重发 ──
const key = createHash("md5").update(`${username}:${realm}:${credential}`).digest();
const authed = build([
  attr(0x0006, Buffer.from(username, "utf8")),
  attr(0x0014, Buffer.from(realm, "utf8")),
  attr(0x0015, nonce),
  transport,
], key);

const reply = await exchange(authed);
if (!reply) {
  console.log("✗ 认证请求没响应");
  process.exit(1);
}
const type = reply.readUInt16BE(0);
if (type === 0x0113) {
  const attrs = readAttrs(reply);
  const err = attrs.find((a) => a.type === 0x0009)?.value;
  const code = err ? `${err[2] & 0x07}${String(err[3]).padStart(2, "0")}` : "?";
  const reason = err ? err.subarray(4).toString("utf8") : "";
  console.log(`✗ 分配被拒：${code} ${reason}`);
  process.exit(1);
}
if (type !== 0x0103) {
  console.log(`✗ 意外响应 0x${type.toString(16)}`);
  process.exit(1);
}

const relayAttr = readAttrs(reply).find((a) => a.type === 0x0016)?.value;
if (!relayAttr) {
  console.log("✗ 成功响应里没有 XOR-RELAYED-ADDRESS");
  process.exit(1);
}
const relayPort = relayAttr.readUInt16BE(2) ^ 0x2112;
const ipInt = relayAttr.readUInt32BE(4) ^ 0x2112a442;
const relayIp = `${(ipInt >>> 24) & 255}.${(ipInt >>> 16) & 255}.${(ipInt >>> 8) & 255}.${ipInt & 255}`;

const inRange = relayPort >= 50000 && relayPort <= 50999;
const rightIp = relayIp === "8.210.198.140";
console.log(`✓ 分配成功：中继 ${relayIp}:${relayPort}`);
console.log(`${inRange ? "✓" : "✗"} 端口在 50000-50999 段内（${relayPort}）`);
console.log(`${rightIp ? "✓" : "✗"} 返回公网 IP（external-ip ${rightIp ? "正确" : "错了 → " + relayIp}）`);
socket.close();
process.exit(inRange && rightIp ? 0 : 1);
