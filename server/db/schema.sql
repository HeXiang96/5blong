-- 5blong 自托管后端 · SQLite 建表（与 worker/accounts-schema.sql 字段完全一致）
--
-- 为什么要单独一份而不是直接复用 worker/accounts-schema.sql：
--   那份是给 D1 用的，靠一串 `ALTER TABLE ... ADD COLUMN` 给老库补列。
--   新库从零建，如果照抄会立刻报 "duplicate column"。
--   这里把所有列写进 CREATE，语义与 worker 的最终结构**逐列对齐**。
--
-- 校验方式：迁移完成后跑 `sqlite3 app.db ".schema"`，
-- 与 D1 里 `wrangler d1 execute --command ".schema"` 的输出对比。
--
-- 全部 IF NOT EXISTS，可重复执行。

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = OFF;

-- ---------------------------------------------------------------------------
-- 账号：主键是 8 位数字 ID（好友、房号都以它为键）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  -- pbkdf2$<轮数>$<hex>；轮数写在串里，将来调强度不影响老密码
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  avatar_version INTEGER NOT NULL DEFAULT 0,
  -- 固定房号（6 位）：NULL = 还没领号
  room_code TEXT,
  room_code_at INTEGER,
  -- 改号次数：>=1 表示已经用掉那唯一一次机会
  room_changes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 后台改过数字 ID 时记旧号，客户端据此迁移本机房间钥匙
  prev_id TEXT
);

-- 用户名唯一且大小写不敏感（DuBu 与 dubu 是同一个名字）
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts (lower(username));

-- 房号唯一：NULL 不参与（部分索引），一个号只能挂一个账号
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_room_code ON accounts (room_code) WHERE room_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 好友
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friendships (
  account_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  since INTEGER NOT NULL,
  -- 备注名（仅自己可见，存在自己那一行）
  alias TEXT,
  PRIMARY KEY (account_id, friend_id)
);

CREATE TABLE IF NOT EXISTS friend_requests (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  -- 附言（≤30 字符）
  note TEXT,
  -- 0 = 待处理，1 = 被拒（保留一行做 24 小时冷却）
  status INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests (to_id);

-- ---------------------------------------------------------------------------
-- 登录态 / 在线状态
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_sessions (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_sessions_account ON account_sessions (account_id);

CREATE TABLE IF NOT EXISTS account_presence (
  account_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  room_code TEXT
);

-- ---------------------------------------------------------------------------
-- 邀请 / 敲门 / 最近一起玩
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_invites (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  code TEXT NOT NULL,
  at INTEGER NOT NULL,
  -- 私密房的钥匙：只随邀请走、24 小时过期
  room_key TEXT,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_room_invites_to ON room_invites (to_id, at DESC);

CREATE TABLE IF NOT EXISTS knocks (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_knocks_to ON knocks (to_id, at DESC);

CREATE TABLE IF NOT EXISTS recent_plays (
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_recent_plays_owner ON recent_plays (owner_id, at DESC);

-- ---------------------------------------------------------------------------
-- 房号占位 / 每日限额 / 审计
-- ---------------------------------------------------------------------------
-- 开临时房前先原子占住这个号，心跳续期、关房释放、过期可被覆盖
CREATE TABLE IF NOT EXISTS room_holds (
  code TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_holds_token ON room_holds (token);

CREATE TABLE IF NOT EXISTS daily_actions (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (account_id, day, kind)
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit (at DESC);


-- ===========================================================================
-- 以下表原样来自线上 D1（房间采样 / 开黑圈 / 反馈 / 员工令牌）
-- 「在线房间」后台页面依赖 room_* 与 rooms；feedback 的列以 D1 为准，
-- 早先手写的那份结构是错的（id 是 UUID 文本、时间字段叫 created_at）。
-- ===========================================================================

CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT PRIMARY KEY,          -- 服务端生成 UUID
  created_at   TEXT NOT NULL,             -- UTC ISO8601
  version      TEXT,                      -- 客户端版本号，如 1.4.7
  platform     TEXT,                      -- 使用端：client-win32 / web-chrome ...
  category     TEXT,                      -- voice|mic|room|screen|lag|other
  message      TEXT NOT NULL,             -- 描述（服务端截断至 500 字）
  contact      TEXT,                      -- 联系方式（选填）
  context_json TEXT,                      -- 自动环境信息（JSON，≤2KB）
  ip_hash      TEXT,                      -- CF-Connecting-IP 的 SHA-256 前 32 位（限速用，不可逆）
  status       TEXT NOT NULL DEFAULT 'new' -- new | done
);

CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,          -- 房主随机 id（32 位 hex）
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  members    INTEGER NOT NULL DEFAULT 1,
  sharing    INTEGER NOT NULL DEFAULT 0,
  version    TEXT,
  runtime    TEXT,                      -- client | web
  ip_hash    TEXT                        -- 限速用（不可逆）
);

CREATE TABLE IF NOT EXISTS room_sessions (
  id           TEXT PRIMARY KEY,        -- 会话 id（随机）
  code         TEXT NOT NULL,           -- 房间码（明文）
  created_at   TEXT NOT NULL,
  ended_at     TEXT,                    -- NULL = 可能仍在进行（由兜底落库补齐）
  duration_s   INTEGER,
  peak_members INTEGER DEFAULT 1,
  host_runtime TEXT,
  host_version TEXT,
  snapshot_json TEXT                    -- 最后一份快照（崩溃兜底 / 深度排障）
);

CREATE TABLE IF NOT EXISTS room_members (
  session_id  TEXT NOT NULL,
  member_key  TEXT NOT NULL,            -- 匿名编号（同一人一场房内稳定）
  name        TEXT,                     -- 昵称（业主确认收集）
  joined_at   TEXT NOT NULL,
  left_at     TEXT,
  duration_s  INTEGER,
  rtt_avg_ms  INTEGER,
  rtt_max_ms  INTEGER,
  jitter_avg_ms INTEGER,
  loss_pct    REAL,
  link        TEXT,                     -- lan | direct | relay
  reconnects  INTEGER DEFAULT 0,
  speaking_s  INTEGER DEFAULT 0,
  runtime     TEXT,
  version     TEXT,
  PRIMARY KEY (session_id, member_key)
);

CREATE TABLE IF NOT EXISTS room_events (
  session_id TEXT NOT NULL,
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- share_start | share_end | error | reconnect
  detail     TEXT
);

CREATE TABLE IF NOT EXISTS room_samples (  -- 人数曲线采样（约每 5 分钟一点）
  session_id TEXT NOT NULL,
  at         TEXT NOT NULL,
  members    INTEGER NOT NULL,
  PRIMARY KEY (session_id, at)
);

CREATE TABLE IF NOT EXISTS staff_tokens (
  id TEXT PRIMARY KEY,
  name TEXT,
  scope TEXT NOT NULL DEFAULT 'game',
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS game_codes (
  code TEXT PRIMARY KEY,
  note TEXT,
  uses_left INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS game_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT,
  action TEXT,
  detail TEXT
);

-- 附属索引
CREATE INDEX IF NOT EXISTS idx_events_session ON room_events (session_id, at);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_rate ON feedback (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rooms_ip ON rooms (ip_hash, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_rooms_seen ON rooms (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_code ON room_sessions (code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON room_sessions (created_at DESC);

-- ---------------------------------------------------------------------------
-- 房间内「梗王对局」的信使表（docs/DUEL-NET-PLAN.md 方案 A）
-- 服务器只做收发，不懂规则：房主上传快照，访客上传意图，双方各 1.2s 轮询。
-- host_left / guest_left 解决「人还在房间里但退出了对局」的通知问题；
-- host_seen_at / guest_seen_at 是轮询心跳，用于判「对方是不是直接关了页面」。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS duel_sessions (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  host_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  guest_id TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'invite',
  version INTEGER NOT NULL DEFAULT 0,
  state TEXT,
  action TEXT,
  action_seq INTEGER NOT NULL DEFAULT 0,
  host_seen_at INTEGER NOT NULL DEFAULT 0,
  guest_seen_at INTEGER NOT NULL DEFAULT 0,
  host_left INTEGER NOT NULL DEFAULT 0,
  guest_left INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_duel_guest ON duel_sessions (guest_id, phase, updated_at);
CREATE INDEX IF NOT EXISTS idx_duel_host ON duel_sessions (host_id, phase, updated_at);
CREATE INDEX IF NOT EXISTS idx_duel_updated ON duel_sessions (updated_at);
