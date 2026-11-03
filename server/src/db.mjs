/**
 * SQLite 访问层：**刻意做成 D1 的形状**。
 *
 * 为什么要仿 D1 而不是直接写底层 API：
 *   worker 里已经有 ~1400 行经过线上验证的业务代码（唯一索引兜底、批量事务、
 *   `ON CONFLICT` upsert、每日限额……）。把它们改写一遍，等于重写一遍 bug。
 *   仿一层 `prepare().bind().first()/all()/run()` + `batch()`，业务代码就能
 *   **原样搬过来** —— 而 D1 本来就是 SQLite，方言几乎一致。
 *
 * 为什么用 `node:sqlite` 而不是 better-sqlite3：
 *   better-sqlite3 是原生模块，服务器上要装 gcc/python 才能编译，
 *   `npm install` 一失败就卡在"环境不对"上，排查成本很高。
 *   Node 22 自带的 `node:sqlite` 是同步 API、语义几乎一样，
 *   **零编译、零额外依赖**，部署只剩"装 Node + npm install 纯 JS 包"。
 *
 * 与 D1 的已知差异（都不影响现有代码）：
 *   1. `.first()` 在这里是同步的；调用方都 `await`，无感。
 *   2. D1 的 `.first("列名")` 取单列，业务代码没用，未实现。
 *   3. `batch()` 用显式事务包住 —— 比 D1 更严格也更安全。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "./config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(HERE, "..", "db", "schema.sql");

/** undefined 会直接抛错，布尔要转成 0/1，Date 转毫秒。 */
function normalize(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return value;
}

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args.map(normalize);
    return this;
  }

  /** 取第一行；没有返回 null（D1 行为）。 */
  first() {
    const row = this.db.prepareCached(this.sql).get(...this.args);
    return row ?? null;
  }

  /** 取全部，但**保留** D1 的 `{ results }` 包装。 */
  all() {
    return { results: this.db.prepareCached(this.sql).all(...this.args) };
  }

  run() {
    const info = this.db.prepareCached(this.sql).run(...this.args);
    return {
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }
}

class Database1 {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.statements = new Map();
    this.depth = 0;

    /*
     * 这三条是单机 SQLite 服务端的标准配置，缺一个都会在并发下出事：
     *   WAL            —— 读不阻塞写（默认 rollback journal 会让轮询把写入卡住）
     *   busy_timeout   —— 抢锁时等一会儿，而不是立刻抛 SQLITE_BUSY
     *   synchronous=NORMAL —— WAL 下够安全，又不用每次 fsync
     */
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.raw.exec("PRAGMA foreign_keys = OFF");
  }

  /** 语句缓存：轮询类接口每秒都在打同一条 SQL，重复 prepare 纯属浪费。 */
  prepareCached(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  /** 与 D1 一致：一批语句在一个事务里执行，任一失败全部回滚。 */
  batch(statements) {
    const list = Array.from(statements ?? []);
    if (list.length === 0) return [];
    const results = [];
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of list) results.push(statement.run());
      this.raw.exec("COMMIT");
    } catch (error) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        /* 已经回滚过了 */
      }
      throw error;
    }
    return results;
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  close() {
    try {
      this.raw.close();
    } catch {
      /* 关闭失败无所谓，进程都要退了 */
    }
  }
}

let instance = null;

/** 建表（幂等）。 */
export function ensureSchema(db) {
  db.exec(fs.readFileSync(SCHEMA_FILE, "utf8"));
}

export function openDatabase(file = CONFIG.dbPath) {
  const db = new Database1(file);
  ensureSchema(db);
  return db;
}

/** 进程级单例。 */
export function getDatabase() {
  if (!instance) instance = openDatabase();
  return instance;
}

export function closeDatabase() {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export { Database1 };
