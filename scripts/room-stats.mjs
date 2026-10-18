#!/usr/bin/env node
/**
 * 房间遥测离线分析：npm run rooms:stats [-- --days 30] [--out 路径]
 *
 * 数据来源：D1 的 room_sessions / room_members / room_events（保留 30 天）。
 * 输出：Markdown 报表（默认写到工作区 ../outputs/room-stats-YYYY-MM-DD.md）。
 *
 * 隐私口径：只做聚合统计，**不输出房间码、昵称、IP 哈希**——与采集口径一致。
 * 用途：为屏幕共享码率、SFU 阈值、重连策略等"节奏类参数"的调整提供数据依据，
 *       而不是拍脑袋改。
 *
 * 凭据：复用本机 wrangler OAuth（与 feedback:admin / feedback:setup 同一套），
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
const outPath = argOf("--out", path.resolve(root, "..", "..", "outputs", `room-stats-${new Date().toISOString().slice(0, 10)}.md`));

// ── Cloudflare 凭据 / D1 查询（与 feedback-admin.mjs 同一套逻辑）────────
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

// ── 主流程 ──────────────────────────────────────────────────────────────
const since = new Date(Date.now() - days * 86400_000).toISOString();

const sessions = await query(
  "SELECT peak_members, duration_s, host_runtime, host_version FROM room_sessions WHERE created_at >= ?",
  [since],
);
const members = await query(
  "SELECT rtt_avg_ms, rtt_max_ms, jitter_avg_ms, loss_pct, link, reconnects, speaking_s, runtime, version " +
    "FROM room_members WHERE joined_at >= ?",
  [since],
);
const shareEvents = await query(
  "SELECT session_id, COUNT(*) AS n FROM room_events WHERE kind = 'share_start' AND at >= ? GROUP BY session_id",
  [since],
);
const eventKinds = await query(
  "SELECT kind, COUNT(*) AS n FROM room_events WHERE at >= ? GROUP BY kind ORDER BY n DESC",
  [since],
);

const lines = [];
const say = (s = "") => lines.push(s);

say(`# 房间遥测分析（近 ${days} 天）`);
say();
say(`> 生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} ｜ 数据源：D1 \`room_sessions\` / \`room_members\` / \`room_events\``);
say(`> 隐私说明：本报表只含聚合统计，不含房间码、昵称与 IP 哈希。`);
say();

if (!sessions.length && !members.length) {
  say("**近 " + days + " 天没有任何房间数据**（可能尚无真实使用，或已过 30 天保留期）。");
  writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`无数据，已写出空报表：${outPath}`);
  process.exit(0);
}

// 1. 概况
const memberTotal = members.length;
const withShare = shareEvents.length;
say("## 1. 概况");
say();
say("| 指标 | 数值 |");
say("|---|---|");
say(`| 房间场次 | ${sessions.length} |`);
say(`| 成员人次 | ${memberTotal} |`);
say(`| 开过屏幕共享的场次 | ${withShare}（${share(withShare, sessions.length)}） |`);
say(`| 平均每场人数（峰值） | ${fmt(mean(sessions.map((s) => s.peak_members)), " 人", 1)} |`);
say();
const eventTotal = eventKinds.reduce((a, k) => a + Number(k.n), 0);
if (eventTotal === 0) {
  say("> 事件流水：近 " + days + " 天 **0 条**。事件上报是 1.6.0 起才有的能力，且要求房主端使用新版；" +
    "此前房间只有会话/成员档案，没有分享、报错、重连等事件。下方「共享场次」为 0 不代表没共享过。");
} else {
  say(`> 事件流水：${eventTotal} 条（${eventKinds.map((k) => `${k.kind}:${k.n}`).join(" · ")}）。`);
}
say();

// 2. 房间规模
const sizeBuckets = [
  ["2 人", (n) => n === 2],
  ["3-4 人", (n) => n >= 3 && n <= 4],
  ["5-8 人", (n) => n >= 5 && n <= 8],
  ["9 人以上", (n) => n >= 9],
];
say("## 2. 房间规模分布（峰值人数）");
say();
say("| 规模 | 场次 | 占比 |");
say("|---|---|---|");
for (const [label, test] of sizeBuckets) {
  const n = sessions.filter((s) => test(Number(s.peak_members) || 0)).length;
  say(`| ${label} | ${n} | ${share(n, sessions.length)} |`);
}
say();

// 3. 时长
const durBuckets = [
  ["< 5 分钟", (s) => s < 300],
  ["5-15 分钟", (s) => s >= 300 && s < 900],
  ["15-30 分钟", (s) => s >= 900 && s < 1800],
  ["30-60 分钟", (s) => s >= 1800 && s < 3600],
  ["≥ 60 分钟", (s) => s >= 3600],
];
const durations = sessions.map((s) => Number(s.duration_s)).filter((n) => Number.isFinite(n));
say("## 3. 会话时长分布");
say();
say("| 时长 | 场次 | 占比 |");
say("|---|---|---|");
for (const [label, test] of durBuckets) {
  const n = durations.filter(test).length;
  say(`| ${label} | ${n} | ${share(n, durations.length)} |`);
}
say();
say(`中位时长 ${fmt(pct(durations, 50) / 60, " 分钟", 1)}，平均 ${fmt(mean(durations) / 60, " 分钟", 1)}。`);
say();

// 4. 网络质量
// 注意：旧版客户端（1.6.0 之前）不上报 RTT/抖动/链路，字段落库为 0 / NULL。
// 活着的 WebRTC 连接 RTT 恒 > 0，因此 **0 一律视为"未上报"**，不参与统计，
// 否则中位数会被 0 拉平到失真（2026-10-18 首次跑该报表时就踩到了）。
const reported = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
const rtts = members.map((m) => Number(m.rtt_avg_ms)).filter(reported);
const jitters = members.map((m) => Number(m.jitter_avg_ms)).filter(reported);
const losses = members.map((m) => Number(m.loss_pct)).filter((v) => Number.isFinite(Number(v)));
say("## 4. 网络质量分布（按成员人次）");
say();
say("| 指标 | p50 | p75 | p90 | p99 | 最大 |");
say("|---|---|---|---|---|---|");
say(`| RTT（ms） | ${fmt(pct(rtts, 50))} | ${fmt(pct(rtts, 75))} | ${fmt(pct(rtts, 90))} | ${fmt(pct(rtts, 99))} | ${fmt(rtts.length ? Math.max(...rtts) : null)} |`);
say(`| 抖动（ms） | ${fmt(pct(jitters, 50))} | ${fmt(pct(jitters, 75))} | ${fmt(pct(jitters, 90))} | ${fmt(pct(jitters, 99))} | ${fmt(jitters.length ? Math.max(...jitters) : null)} |`);
say();
const lossBuckets = [
  ["< 1%", (l) => l < 1],
  ["1-3%", (l) => l >= 1 && l < 3],
  ["3-8%", (l) => l >= 3 && l < 8],
  ["≥ 8%", (l) => l >= 8],
];
say("| 丢包率 | 人次 | 占比 |");
say("|---|---|---|");
for (const [label, test] of lossBuckets) {
  const n = losses.filter(test).length;
  say(`| ${label} | ${n} | ${share(n, losses.length)} |`);
}
say();

// 5. 接入方式
const links = ["lan", "direct", "relay"];
say("## 5. 链路类型（P2P 直连 vs 中继）");
say();
say("| 类型 | 人次 | 占比 | RTT p50 | 平均丢包 |");
say("|---|---|---|---|---|");
for (const link of links) {
  const rows = members.filter((m) => (m.link ?? "") === link);
  const rowsRtt = rows.map((m) => Number(m.rtt_avg_ms)).filter(reported);
  const rowsLoss = rows.map((m) => Number(m.loss_pct)).filter((v) => Number.isFinite(Number(v)));
  say(`| ${link} | ${rows.length} | ${share(rows.length, memberTotal)} | ${fmt(pct(rowsRtt, 50), " ms")} | ${fmt(mean(rowsLoss), "%", 2)} |`);
}
const unknown = members.filter((m) => !links.includes(m.link ?? "")).length;
if (unknown) say(`| 其它/未知 | ${unknown} | ${share(unknown, memberTotal)} | — | — |`);
say();
const noRtt = memberTotal - rtts.length;
if (noRtt) {
  say(`> 数据质量：${noRtt}/${memberTotal} 人次（${share(noRtt, memberTotal)}）未上报网络指标，` +
    `多为 1.6.0 之前的旧客户端；链路"未知"同理。第 4 节只统计已上报样本（${rtts.length} 人次）。`);
  say();
}

// 6. 重连
const reconnectRows = members.filter((m) => (Number(m.reconnects) || 0) > 0);
say("## 6. 稳定性");
say();
say(`- 发生过重连的人次：${reconnectRows.length}（${share(reconnectRows.length, memberTotal)}）`);
say(`- 重连人次平均重连次数：${fmt(mean(reconnectRows.map((m) => Number(m.reconnects))), " 次", 2)}`);
const speaking = members.map((m) => Number(m.speaking_s)).filter(Number.isFinite);
say(`- 人均说话时长：${fmt(mean(speaking) / 60, " 分钟", 1)}`);
say();

// 7. 版本 / 端
const countBy = (rows, key) =>
  Object.entries(
    rows.reduce((acc, r) => {
      const k = r[key] || "未知";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);
say("## 7. 版本与运行端");
say();
say("| 维度 | 分布 |");
say("|---|---|");
say(`| 房主版本 | ${countBy(sessions, "host_version").map(([k, v]) => `${k}(${v})`).join(" · ") || "—"} |`);
say(`| 房主端 | ${countBy(sessions, "host_runtime").map(([k, v]) => `${k}(${v})`).join(" · ") || "—"} |`);
say(`| 成员端 | ${countBy(members, "runtime").map(([k, v]) => `${k}(${v})`).join(" · ") || "—"} |`);
say();

// 8. 自动判读
say("## 8. 自动判读（供调参参考，改参数前先与业主确认）");
say();
const relayPct = memberTotal ? (members.filter((m) => m.link === "relay").length / memberTotal) * 100 : 0;
const badLoss = losses.filter((l) => l >= 3).length;
const badLossPct = losses.length ? (badLoss / losses.length) * 100 : 0;
if (relayPct > 15) say(`- ⚠ 中继占比 ${relayPct.toFixed(1)}%（>15%）：跨网打洞成功率偏低，值得排查 TURN 与 ICE 配置。`);
else say(`- ✓ 中继占比 ${relayPct.toFixed(1)}%（≤15%）：P2P 直连为主，符合预期。`);
if (badLossPct > 10) say(`- ⚠ 丢包 ≥3% 的人次占 ${badLossPct.toFixed(1)}%：屏幕共享码率/降级策略可考虑更早触发。`);
else say(`- ✓ 丢包 ≥3% 的人次占 ${badLossPct.toFixed(1)}%：网络质量整体健康。`);
const p90rtt = pct(rtts, 90);
if (p90rtt != null && p90rtt > 150) say(`- ⚠ RTT p90 = ${p90rtt} ms（>150ms）：延迟偏高，注意是否远程/跨境线路。`);
else say(`- ✓ RTT p90 = ${fmt(p90rtt, " ms")}：延迟在可接受范围。`);
if (memberTotal < 30) say(`- ℹ 样本量较小（${memberTotal} 人次），以上判读仅供参考，建议积累到 ≥30 人次后再据此调参。`);
say();

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`\n报表已写入：${outPath}`);
