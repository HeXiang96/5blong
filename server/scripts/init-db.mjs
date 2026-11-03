#!/usr/bin/env node
/**
 * 初始化 / 升级数据库。
 *
 * 两种用法：
 *   1. 全新库：直接建表（schema.sql 自带 IF NOT EXISTS，重复跑无害）
 *   2. 从 D1 迁过来：先 `sqlite3 app.db < dump.sql`，再跑这个补齐索引与缺列
 *
 * 用法：
 *   node scripts/init-db.mjs              # 用默认路径
 *   DB_PATH=/data/5blong/app.db node scripts/init-db.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../src/config.mjs";
import { closeDatabase, openDatabase } from "../src/db.mjs";

const file = process.argv[2] ?? CONFIG.dbPath;

console.log(`数据库：${file}`);
if (fs.existsSync(file)) {
  const size = fs.statSync(file).size;
  console.log(`  已存在，当前大小 ${(size / 1024).toFixed(1)} KB`);
} else {
  console.log("  不存在，将新建");
}

const db = openDatabase(file);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().results;

console.log(`  表 ${tables.length} 张：${tables.map((row) => row.name).join(", ")}`);

const counts = [];
for (const { name } of tables) {
  if (name === "admin_audit") continue;
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).first()?.n ?? 0;
  if (n > 0) counts.push(`${name}=${n}`);
}
if (counts.length) console.log(`  已有数据：${counts.join("  ")}`);

// 索引盘点：唯一索引是防"抢房号 / 抢用户名"的最后一道闸，缺了必须立刻发现
const indexes = db
  .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY tbl_name, name")
  .all().results;
console.log(`  索引 ${indexes.length} 个`);
for (const index of indexes) {
  console.log(`    ${index.tbl_name}.${index.name}`);
}

const mustHave = ["idx_accounts_username", "idx_accounts_room_code"];
const present = new Set(indexes.map((index) => index.name));
const missing = mustHave.filter((name) => !present.has(name));
if (missing.length) {
  console.error(`\n❌ 缺少关键唯一索引：${missing.join(", ")}`);
  console.error("   没有它们，两个账号可以抢到同一个房号/用户名。请检查 schema.sql 是否执行成功。");
  closeDatabase();
  process.exit(1);
}

// WAL 检查：不是 WAL 就说明 pragma 没生效（比如目录权限不对）
const journal = db.prepare("PRAGMA journal_mode").first();
console.log(`  journal_mode = ${journal?.journal_mode ?? "?"}`);

console.log(`\n✅ 数据库就绪：${path.resolve(file)}`);
closeDatabase();
