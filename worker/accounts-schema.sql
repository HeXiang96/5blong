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
  -- 改号次数：0 = 还允许改一次；>=1 = 已锁定（业主 2026-10-26 口径）
  room_changes INTEGER NOT NULL DEFAULT 0,
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

-- 房间邀请（2026-10-26 业主口径）：
-- 邀请**必须留档**，不能只靠一闪而过的弹窗——对方没看见、在忙、关机了，
-- 回来在好友面板的「邀请」里还得看得到"谁邀请了我"。
-- 一人对一人只留最新一条（重复邀请覆盖时间与房号）；对方加入或忽略后删除。
CREATE TABLE IF NOT EXISTS room_invites (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  code TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_room_invites_to ON room_invites (to_id, at DESC);

-- 老库补列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列）。
-- 重复执行会报 duplicate column，scripts/accounts-setup.mjs 会跳过这种错误。
ALTER TABLE accounts ADD COLUMN room_changes INTEGER NOT NULL DEFAULT 0;

-- 房号占位（2026-10-26 业主口径：认领过的号，别人开临时房就不能再占）：
-- 开房前先用唯一主键原子地"占住"这个号；心跳续期，关房释放，过期可被覆盖。
-- 这样"临时房撞上某个账号的固定房号"从"概率问题"变成"数据库挡住"。
-- 注意：房号已被账号认领（accounts.room_code）时**不允许占位**，那条优先。
CREATE TABLE IF NOT EXISTS room_holds (
  code TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_holds_token ON room_holds (token);

-- 管理员操作审计：改房号 / 改数字 ID 这类"绕过用户端限制"的动作必须留痕。
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit (at DESC);

-- 改过数字 ID 时记住旧 ID：客户端据此把本机的房间钥匙搬到新 ID 名下
-- （roomKey 只存客户端，服务端搬不了；不搬的话老邀请链接会全部失效）。
ALTER TABLE accounts ADD COLUMN prev_id TEXT;

-- 邀请里带上房间钥匙：私密房只给房号等于"告诉你门牌却不给钥匙"，
-- 对方点「加入」只会被要求临时密码。钥匙仅好友可见、随邀请一起过期（24 小时）。
ALTER TABLE room_invites ADD COLUMN room_key TEXT;

-- ===========================================================================
-- 好友体验补全（2026-10-27）
-- ===========================================================================
-- 备注名（仅自己可见）：好友把昵称改得面目全非、或者两个人同名时，
-- 还能按你熟悉的名字找到他。存在 friendships 的**自己那一行**，天然只自己可见。
ALTER TABLE friendships ADD COLUMN alias TEXT;

-- 好友申请附言（≤30 字）：只给 8 位 ID 加人的时候，对方至少知道"我是谁"。
ALTER TABLE friend_requests ADD COLUMN note TEXT;

-- 申请状态：0 = 待处理，1 = 已被拒绝。
-- 拒绝不再直接删行 —— 删了就查不到"上次被拒是什么时候"，对方可以无限重复申请。
-- 保留一行并把 at 刷成拒绝时间，就能做 24 小时冷却；超时后重新申请会覆盖回 0。
ALTER TABLE friend_requests ADD COLUMN status INTEGER NOT NULL DEFAULT 0;

-- 最近一起玩（2026-10-27 业主批准）：
-- 现在加好友只有两条路——知道 8 位 ID，或者在房间里点成员头像。
-- 后者依赖对方客户端 ≥1.8.9 上报 accountId，旧客户端只能按昵称猜，经常加不上。
-- 所以把"同房过"这件事记下来，好友面板里给一个一键加好友的入口。
--
-- 隐私口径（业主批准）：**只自己可见**，A 和 B 同房时 A 记一条 B、B 记一条 A，
-- 不产生"谁看过谁"的第三方查询；7 天过期；每人最多 30 条。
CREATE TABLE IF NOT EXISTS recent_plays (
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_recent_plays_owner ON recent_plays (owner_id, at DESC);

-- 敲门（2026-10-27）：好友在某个房间里，但那是私密房 / 你不知道密码。
-- 点一下"请求进入"，房主收到提示；**房主同意后才由他的客户端发出带钥匙的邀请**。
-- 钥匙始终只由房主本机提供，服务端不生成、不推导——安全边界没有变松。
CREATE TABLE IF NOT EXISTS knocks (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_knocks_to ON knocks (to_id, at DESC);

-- 每日动作计数：好友请求 / 邀请 / 敲门各有一个软上限，防止脚本刷。
-- 按天一行（UPSERT 自增），不随次数膨胀；90 天前的行可以随手删。
CREATE TABLE IF NOT EXISTS daily_actions (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (account_id, day, kind)
);
