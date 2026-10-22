#!/usr/bin/env node
/**
 * 房间问题归因分析：node scripts/rooms-attribution.mjs [--days 30] [--out 路径]
 *
 * 背景：业主要评估「Cloudflare MoQ 中继能否解决 ①语音互相听不到 ②掉线 ③屏幕共享画质」
 *       三个问题。本脚本从 D1 遥测里把这三类问题的真实占比统计出来，避免拍脑袋决策。
 *
 * 数据来源：D1 的 room_sessions / room_members / room_events（保留 30 天）。
 * 输出：Markdown 报表（默认写到工作区 outputs/rooms-attribution-YYYY-MM-DD.md）。
 *
 * 归因口径（对应 engine.ts pushRoomEvent 的实际文案，改动文案后要同步这里）：
 *   - one_way     ：「单向 / 没有收到任何包」→ P2P 链路单向故障，MoQ 对症
 *   - establish   ：「未建立 / 连接失败」→ 链路建立失败（NAT/网络类），MoQ 对症
 *   - playback    ：「播放通道断了」→ 收流通道断，已自动重建，MoQ 部分对症
 *   - autoplay    ：「自动播放被拦截」→ 浏览器策略，MoQ 不对症
 *   - local_audio ：「麦克风 / AudioContext」→ 本地设备/音频引擎，MoQ 不对症
 *   - redial      ：kind=reconnect 的「链路恢复」→ 曾失败后自愈，归入掉线问题
 *
 * 隐私口径：只做聚合统计，不输出房间码、昵称、IP 哈希（与 room-stats.mjs 一致）。
 * 凭据：复用本机 wrangler OAuth（与 room-stats / feedback:admin 同一套），
 *       或环境变量 CLOUDFLARE_API_TOKEN。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const OAUTH_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CONFIG = path.join(process.env.APPDATA ?? "", "xdg.config", ".wrangler", "config", "default.toml");
const DB_NAME = "5blong-feedback";

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const days = Math.max(1, Math.min(365, Number(argOf("--days", "30")) || 30));
const outPath = argOf("--out", path.resolve(root, "outputs", `rooms-attribution-${new Date().toISOString().slice(0, 10)}.md`));

// ── Cloudflare 凭据 / D1 查询（与 room-stats.mjs 同一套逻辑）────────────
function readWranglerConfig() {
  const raw = readFileSync(WRANGLER_CONFIG, "utf8");
  const pick = (key) => new RegExp(`${key}\\s*=\\s*"([^"]+)"`).exec(raw)?.[1] ?? "";
  return { raw, oauthToken: pick("oauth_token"), refreshToken: pick("refresh_token"), expirationTime: pick("expiration_time") };
}

async function refreshOAuth(config) {
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  });
  if (!response.ok) throw new Error(`刷新 Cloudflare 凭据失败（HTTP ${response.status}）：重新跑 npx wrangler login`);
  const token = await response.json();
  const expiration = new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString();
  writeFileSync(
    WRANGLER_CONFIG,
    config.raw
      .replace(/oauth_token\s*=\s*"[^"]*"/, `oauth_token = "${token.access_token}"`)
      .replace(/expiration_time\s*=\s*"[^"]*"/, `expiration_time = "${expiration}"`)
      .replace(/refresh_token\s*=\s*"[^"]*"/, `refresh_token = "${token.refresh_token ?? config.refreshToken}"`),
    "utf8",
  );
  return token.access_token;
}

async function getToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const config = readWranglerConfig();
  const expiresAt = Date.parse(config.expirationTime);
  if (config.oauthToken && Number.isFinite(expiresAt) && expiresAt - Date.now() > 120_000) return config.oauthToken;
  return refreshOAuth(config);
}

async function api(token, route, init = {}) {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || (payload && payload.success === false)) {
    const detail = payload?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? text.slice(0, 200);
    throw new Error(`${init.method ?? "GET"} ${route} 失败（HTTP ${response.status}）：${detail}`);
  }
  return payload?.result;
}

async function query(sql, params = []) {
  const token = await getToken();
  const accounts = await api(token, "/accounts?per_page=50");
  const account = accounts?.[0];
  if (!account) throw new Error("凭据下没有可用账号");
  const databases = await api(token, `/accounts/${account.id}/d1/database?per_page=100`);
  const database = (databases ?? []).find((db) => db.name === DB_NAME);
  if (!database) throw new Error(`找不到数据库 ${DB_NAME}`);
  const result = await api(token, `/accounts/${account.id}/d1/database/${database.uuid}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
  return result?.[0]?.results ?? [];
}

// ── 统计小工具 ──────────────────────────────────────────────────────────
const pct = (arr, p) => {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const fmt = (v, unit = "", digits = 0) => (v == null || Number.isNaN(v) ? "—" : `${Number(v).toFixed(digits)}${unit}`);
const share = (n, total) => (total ? `${((n / total) * 100).toFixed(1)}%` : "—");
const reported = (v) => Number.isFinite(Number(v)) && Number(v) > 0; // 0 一律视为"未上报"（旧客户端），与 room-stats 同口径

// ── 事件归因分类（匹配 engine.ts 的实际文案，子串匹配，顺序即优先级）──
const BUCKETS = [
  { key: "one_way", label: "语音单向/收不到包（P2P 链路故障）", moq: "MoQ 对症", match: (d) => d.includes("单向") || d.includes("没有收到任何包") },
  { key: "establish", label: "链路建立失败/重拨（NAT 类）", moq: "MoQ 对症", match: (d) => d.includes("未建立") || d.includes("连接失败") || d.includes("重拨") },
  { key: "playback", label: "播放通道断开（已自动重建）", moq: "部分对症", match: (d) => d.includes("播放通道断了") },
  { key: "autoplay", label: "浏览器拦截自动播放", moq: "不对症", match: (d) => d.includes("自动播放") },
  { key: "local_audio", label: "本地麦克风/音频引擎异常", moq: "不对症", match: (d) => d.includes("麦克风") || d.includes("AudioContext") },
];
const classify = (kind, detail) => {
  if (kind === "reconnect") return "redial";
  const d = detail ?? "";
  for (const b of BUCKETS) if (b.match(d)) return b.key;
  return "other";
};

// ── 主流程 ──────────────────────────────────────────────────────────────
const since = new Date(Date.now() - days * 86400_000).toISOString();

const sessions = await query("SELECT id, created_at, duration_s, peak_members FROM room_sessions WHERE created_at >= ?", [since]);
const members = await query(
  "SELECT session_id, rtt_avg_ms, rtt_max_ms, jitter_avg_ms, loss_pct, link, reconnects, speaking_s FROM room_members WHERE joined_at >= ?",
  [since],
);
const events = await query("SELECT session_id, at, kind, detail FROM room_events WHERE at >= ?", [since]);

const lines = [];
const say = (s = "") => lines.push(s);

if (!sessions.length) {
  say(`# 房间问题归因（近 ${days} 天）`);
  say();
  say(`**近 ${days} 天没有任何房间会话数据**（可能尚无真实使用，或已过 30 天保留期）。`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`无数据，已写出空报表：${outPath}`);
  process.exit(0);
}

// 会话 id → 该场成员，便于"问题场次里的链路分布"交叉分析
const membersBySession = new Map();
for (const m of members) {
  if (!membersBySession.has(m.session_id)) membersBySession.set(m.session_id, []);
  membersBySession.get(m.session_id).push(m);
}

const eventTotal = events.length;
const errEvents = events.filter((e) => e.kind === "error");
const reconnEvents = events.filter((e) => e.kind === "reconnect");
const byBucket = new Map();
for (const e of events) {
  const k = classify(e.kind, e.detail);
  if (!byBucket.has(k)) byBucket.set(k, { count: 0, sessions: new Set() });
  const b = byBucket.get(k);
  b.count += 1;
  b.sessions.add(e.session_id);
}

// "对症"类问题（one_way/establish/playback）所在场次的成员链路分布
const moqRelevantSessions = new Set([
  ...(byBucket.get("one_way")?.sessions ?? []),
  ...(byBucket.get("establish")?.sessions ?? []),
  ...(byBucket.get("playback")?.sessions ?? []),
]);
const moqSessionMembers = members.filter((m) => moqRelevantSessions.has(m.session_id));

const memberTotal = members.length;
const relayMembers = members.filter((m) => m.link === "relay").length;
const reconnectRows = members.filter((m) => (Number(m.reconnects) || 0) > 0);

// ── 报表 ────────────────────────────────────────────────────────────────
say(`# 房间问题归因分析（近 ${days} 天）`);
say();
say(`> 生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} ｜ 数据源：D1 \`room_sessions\` / \`room_members\` / \`room_events\``);
say(`> 隐私说明：本报表只含聚合统计，不含房间码、昵称与 IP 哈希。`);
say();

// 1. 概况
say("## 1. 概况");
say();
say("| 指标 | 数值 |");
say("|---|---|");
say(`| 房间场次 | ${sessions.length} |`);
say(`| 成员人次 | ${memberTotal} |`);
say(`| 遥测事件总数 | ${eventTotal}（error ${errEvents.length} · reconnect ${reconnEvents.length}） |`);
say(`| 中继（relay）人次占比 | ${relayMembers}/${memberTotal}（${share(relayMembers, memberTotal)}） |`);
say(`| 发生过重连的人次 | ${reconnectRows.length}（${share(reconnectRows.length, memberTotal)}） |`);
say();
if (eventTotal === 0) {
  say("> 事件流水为 0：事件上报是 1.6.0 起才有的能力，且要求房主端使用新版。以下归因基于成员档案字段（重连/链路/丢包），事件分类部分无样本。");
  say();
}

// 2. 三大问题归因总表
say("## 2. 三大问题归因（事件分类计数）");
say();
say("| 归因类别 | MoQ 是否对症 | 事件数 | 涉及场次 | 场次占比 |");
say("|---|---|---|---|---|");
for (const b of BUCKETS) {
  const row = byBucket.get(b.key);
  say(`| ${b.label} | ${b.moq} | ${row?.count ?? 0} | ${row?.sessions.size ?? 0} | ${share(row?.sessions.size ?? 0, sessions.length)} |`);
}
const redialRow = byBucket.get("redial");
say(`| 链路曾失败后自愈（reconnect） | 部分对症（连接迁移有帮助） | ${redialRow?.count ?? 0} | ${redialRow?.sessions.size ?? 0} | ${share(redialRow?.sessions.size ?? 0, sessions.length)} |`);
const otherRow = byBucket.get("other");
if (otherRow) say(`| 其它（未归类文案） | 待人工看明细 | ${otherRow.count} | ${otherRow.sessions.size} | ${share(otherRow.sessions.size, sessions.length)} |`);
say();

// 3. MoQ 对症类问题场次的链路质量
say("## 3. 「MoQ 对症」问题场次的成员链路质量");
say();
say(`出现过单向/建立失败/通道断开的场次共 **${moqRelevantSessions.size} 场**，这些场次里成员的接入方式与网络指标：`);
say();
say("| 接入方式 | 人次 | 占比 | RTT p50 | 平均丢包 |");
say("|---|---|---|---|---|");
for (const link of ["lan", "direct", "relay"]) {
  const rows = moqSessionMembers.filter((m) => (m.link ?? "") === link);
  const rowsRtt = rows.map((m) => Number(m.rtt_avg_ms)).filter(reported);
  const rowsLoss = rows.map((m) => Number(m.loss_pct)).filter((v) => Number.isFinite(Number(v)));
  say(`| ${link} | ${rows.length} | ${share(rows.length, moqSessionMembers.length)} | ${fmt(pct(rowsRtt, 50), " ms")} | ${fmt(mean(rowsLoss), "%", 2)} |`);
}
const unknownLinks = moqSessionMembers.filter((m) => !["lan", "direct", "relay"].includes(m.link ?? "")).length;
if (unknownLinks) say(`| 未知/未上报 | ${unknownLinks} | ${share(unknownLinks, moqSessionMembers.length)} | — | — |`);
say();
say(`> 判读：如果问题场次的 relay/直连失败占比明显偏高，说明瓶颈在网络链路（MoQ/TURN 方向有价值）；`);
say(`> 如果问题多发生在 lan/direct 正常链路上，则瓶颈更可能在应用层（自动播放策略、设备），换传输协议没用。`);
say();

// 4. 掉线归因
say("## 4. 掉线归因");
say();
const rcDist = [1, 2, 5, 10];
say("| 单人次重连次数 | 人次 |");
say("|---|---|");
let prev = 0;
for (const n of rcDist) {
  const c = reconnectRows.filter((m) => Number(m.reconnects) > prev && Number(m.reconnects) <= n).length;
  say(`| ${prev + 1}-${n} 次 | ${c} |`);
  prev = n;
}
const heavy = reconnectRows.filter((m) => Number(m.reconnects) > prev).length;
say(`| >${prev} 次（重度） | ${heavy} |`);
say();
say(`- 重连人次平均重连次数：${fmt(mean(reconnectRows.map((m) => Number(m.reconnects))), " 次", 2)}`);
say(`- 「链路恢复」事件：${redialRow?.count ?? 0} 条 / ${redialRow?.sessions.size ?? 0} 场`);
const lostMembers = members.filter((m) => (Number(m.loss_pct) || 0) >= 3);
say(`- 丢包 ≥3% 的人次：${lostMembers.length}（${share(lostMembers.length, memberTotal)}），其中 relay 链路 ${(lostMembers.filter((m) => m.link === "relay").length)} 人次`);
say();

// 5. 屏幕共享画质归因
say("## 5. 屏幕共享画质归因");
say();
const shareStartEvents = events.filter((e) => (e.detail ?? "").includes("共享") && e.kind === "share_start");
const shareSessions = new Set(shareStartEvents.map((e) => e.session_id));
say(`- 开过屏幕共享的场次：${shareSessions.size}（占 ${share(shareSessions.size, sessions.length)}；事件为 0 时此数为 0，不代表没共享过）`);
say("- 当前遥测**不采集编码器错误/帧率/码率**，画质问题无法从现有数据直接归因；");
say("  如需量化，需要客户端在共享统计里补报编码指标（属于采集口径变更，先与业主确认）。");
say();

// 6. 判读
say("## 6. 自动判读（供 MoQ 决策参考）");
say();
const moqCount = (byBucket.get("one_way")?.count ?? 0) + (byBucket.get("establish")?.count ?? 0) + (byBucket.get("playback")?.count ?? 0);
const noMoqCount = (byBucket.get("autoplay")?.count ?? 0) + (byBucket.get("local_audio")?.count ?? 0);
if (eventTotal === 0) {
  say("- ℹ 无事件样本，无法归因；建议等房主端升级到 1.6.x 产生真实事件后再跑。");
} else if (moqCount > noMoqCount * 2) {
  say(`- ⚠ 链路类问题（单向/建立失败/通道断）${moqCount} 条 vs 本地类 ${noMoqCount} 条：**问题主要在网络链路**，MoQ/换中继方案值得做连通性实测。`);
} else if (noMoqCount > moqCount * 2) {
  say(`- ⚠ 本地类问题（自动播放/设备）${noMoqCount} 条 vs 链路类 ${moqCount} 条：**问题主要不在网络**，换 MoQ 帮助有限，优先改提示文案与本地音频健壮性。`);
} else {
  say(`- ℹ 链路类 ${moqCount} 条 vs 本地类 ${noMoqCount} 条，比例接近：MoQ 只能解决一半问题，需配合其它手段。`);
}
if (relayMembers / Math.max(memberTotal, 1) > 0.15) {
  say(`- ⚠ 中继占比 ${share(relayMembers, memberTotal)}（>15%）：打洞成功率偏低，先排查 TURN 配置（比上 MoQ 便宜得多）。`);
} else {
  say(`- ✓ 中继占比 ${share(relayMembers, memberTotal)}（≤15%）：P2P 直连为主，链路整体健康。`);
}
if (memberTotal < 30) say(`- ℹ 样本量较小（${memberTotal} 人次 / ${sessions.length} 场），判读仅供参考，建议积累到 ≥30 人次再据此拍板。`);
say();

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`\n报表已写入：${outPath}`);
