/**
 * 把打包好的桌面端目录压成一个 zip（零依赖，用 node:zlib 手写 zip 结构）。
 * 用法：node scripts/zip-desktop.mjs [目录] [输出zip]
 */

import { createWriteStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = process.argv[2] ?? path.join(root, "dist-desktop", "5blong-win-x64");
const targetZip =
  process.argv[3] ?? path.join(root, "dist-desktop", `${path.basename(sourceDir)}.zip`);

if (!existsSync(sourceDir)) {
  console.error(`找不到 ${sourceDir}`);
  process.exit(1);
}

/** CRC-32 查表，zip 每个条目都要带。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

/** ZIP64 扩展字段：条目超过 4GB 或被强制标记时用来放真实尺寸。 */
function zip64Extra(uncompressed, compressed, offset) {
  const need = uncompressed >= 0xffffffff || compressed >= 0xffffffff || offset >= 0xffffffff;
  if (!need) return { extra: Buffer.alloc(0), needsZip64: false };
  const parts = [];
  let mask = 0;
  if (uncompressed >= 0xffffffff) {
    mask |= 1;
    parts.push(uncompressed);
  }
  if (compressed >= 0xffffffff) {
    mask |= 2;
    parts.push(compressed);
  }
  if (offset >= 0xffffffff) {
    mask |= 4;
    parts.push(offset);
  }
  const body = Buffer.alloc(4 + parts.length * 8);
  body.writeUInt16LE(0x0001, 0);
  body.writeUInt16LE(parts.length * 8, 2);
  parts.forEach((value, index) => body.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return { extra: body, needsZip64: true };
}

async function main() {
  const files = walk(sourceDir);
  const output = createWriteStream(targetZip);
  const write = (buffer) =>
    new Promise((resolve, reject) => {
      output.write(buffer, (error) => (error ? reject(error) : resolve()));
    });

  const central = [];
  let offset = 0;
  let rawTotal = 0;

  for (const relative of files) {
    const full = path.join(sourceDir, relative);
    const raw = readFileSync(full);
    const compressed = deflateRawSync(raw, { level: 6 });
    const nameBuffer = Buffer.from(relative, "utf8");
    const crc = crc32(raw);
    const { time, day } = dosDateTime(statSync(full).mtime);
    const { extra, needsZip64 } = zip64Extra(raw.length, compressed.length, offset);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(needsZip64 ? 45 : 20, 4); // 45 = zip64
    header.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length >= 0xffffffff ? 0xffffffff : compressed.length, 18);
    header.writeUInt32LE(raw.length >= 0xffffffff ? 0xffffffff : raw.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(extra.length, 28);

    await write(header);
    await write(nameBuffer);
    if (extra.length) await write(extra);
    await write(compressed);

    central.push({
      nameBuffer,
      crc,
      compressed: compressed.length,
      raw: raw.length,
      offset,
      time,
      day,
      needsZip64,
    });

    offset += header.length + nameBuffer.length + extra.length + compressed.length;
    rawTotal += raw.length;
  }

  const centralStart = offset;
  for (const entry of central) {
    const extra = zip64Extra(entry.raw, entry.compressed, entry.offset).extra;
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(entry.needsZip64 ? 45 : 20, 4);
    header.writeUInt16LE(entry.needsZip64 ? 45 : 20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.day, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed >= 0xffffffff ? 0xffffffff : entry.compressed, 20);
    header.writeUInt32LE(entry.raw >= 0xffffffff ? 0xffffffff : entry.raw, 24);
    header.writeUInt16LE(entry.nameBuffer.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE(0, 32); // 注释长度
    header.writeUInt16LE(0, 34); // 磁盘号
    header.writeUInt16LE(0, 36); // 内部属性
    header.writeUInt32LE(0, 38); // 外部属性
    header.writeUInt32LE(entry.offset >= 0xffffffff ? 0xffffffff : entry.offset, 42);

    await write(header);
    await write(entry.nameBuffer);
    if (extra.length) await write(extra);
    offset += header.length + entry.nameBuffer.length + extra.length;
  }
  const centralSize = offset - centralStart;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length >= 0xffff ? 0xffff : central.length, 8);
  end.writeUInt16LE(central.length >= 0xffff ? 0xffff : central.length, 10);
  end.writeUInt32LE(centralSize >= 0xffffffff ? 0xffffffff : centralSize, 12);
  end.writeUInt32LE(centralStart >= 0xffffffff ? 0xffffffff : centralStart, 16);
  end.writeUInt16LE(0, 20);
  await write(end);

  await new Promise((resolve, reject) => {
    output.end((error) => (error ? reject(error) : resolve()));
  });

  const zipSize = statSync(targetZip).size;
  console.log(`已打包 ${central.length} 个文件 → ${targetZip}`);
  console.log(
    `原始 ${(rawTotal / 1024 / 1024).toFixed(1)} MB → 压缩后 ${(zipSize / 1024 / 1024).toFixed(1)} MB`,
  );
}

await main();
