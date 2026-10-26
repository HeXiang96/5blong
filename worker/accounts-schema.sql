-- 5blong · 账号 / 好友 / 固定房号（D1 / SQLite）
--
-- 设计口径（2026-10-26 业主）：
-- * 账号主键是 **8 位数字 ID**（`accounts.id`），好友、房号都以它为外键；
-- * 「我的房间 235417」= `accounts.room_code`，**绑定账号**，一个号只能属于一个账号；
-- * 未登录 = 没有账号行 = 没有固定房号（客户端开随机房号的一次性房间）；
-- * 姓名/头像/用户名都可改，ID 与房号都不是登录凭据，只是身份与门牌。
--
-- 应用方式：npm run accounts:setup
-- 全部 IF NOT EXISTS，可重复执行（幂等）。

CREATE TABLE IF NOT EXISTS accounts (
  -- 8 位数字账号 ID：好友用它加人，永远不变
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  -- PBKDF2-SHA256（12 万次迭代），绝不存明文
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  -- 头像 data URL（≤120KB）。后续搬 R2 时只改存 object key，字段名保留
  avatar TEXT NOT NULL DEFAULT '',
  avatar_version INTEGER NOT NULL DEFAULT 0,
  -- 固定房号（6 位数字）：NULL = 还没领号
  room_code TEXT,
  room_code_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 用户名唯一（大小写不敏感：DuBu 与 dubu 是同一个名字）
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts (lower(username));

-- 固定房号唯一：NULL 不参与（SQLite 的部分索引），一个号只能挂一个账号
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_room_code ON accounts (room_code) WHERE room_code IS NOT NULL;

-- 好友关系（双向两行：查"我的好友"只需 where account_id = ?）
CREATE TABLE IF NOT EXISTS friendships (
  account_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (account_id, friend_id)
);

-- 好友请求（单向一行；对方同意后两行 friendships + 清掉请求）
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests (to_id);

-- 登录态：不透明令牌（前端存 httpOnly cookie；桌面端 WebView2 用 Bearer 兜底）
CREATE TABLE IF NOT EXISTS account_sessions (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_sessions_account ON account_sessions (account_id);

-- 在线心跳（"谁在线"只用于展示，不参与任何进房校验）
CREATE TABLE IF NOT EXISTS account_presence (
  account_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  room_code TEXT
);
