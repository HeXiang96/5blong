-- 5blong 意见反馈表（D1）
-- 执行：npm run feedback:setup（会建库、建表、绑定到 Pages 项目并写入管理员令牌）
-- 幂等：重复执行安全（IF NOT EXISTS）。

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

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_rate ON feedback (ip_hash, created_at DESC);

-- 在线房间心跳（"有多少房间开着"）：房主每 60 秒报一次，超时视为离线。
-- 隐私：id 是房主随机生成的标识，与房间码/邀请链接无关；只记人数与是否在共享，
-- 不记任何标题/内容。
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

CREATE INDEX IF NOT EXISTS idx_rooms_seen ON rooms (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_rooms_ip ON rooms (ip_hash, last_seen DESC);
