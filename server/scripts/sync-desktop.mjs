#!/usr/bin/env node
/**
 * 桌面端更新源同步（2026-11-03）
 * ---------------------------------------------------------------------------
 * 干什么：把 CI 出的最新安装包拉到本机，生成一份**指向 5blong.site** 的
 * `latest.json` 放进静态站目录，让桌面客户端的第一更新源（ECS）永远有新版。
 *
 * 为什么要它：CI（release.yml）只把产物发到 Cloudflare Pages——那是给
 * 1.9.11 及更老的客户端用的。1.9.12 起客户端先读 `5blong.site/desktop/latest.json`，
 * 这份以前靠手 scp，忘了就永远停在旧版。现在交给定时任务，不再靠人记。
 *
 * 关键取舍（别改，改了会出事故）：
 *
 * 1. **manifest 不自己拼，抄 CI 那份**。`minimum`（强制更新闸门）由 CI 里的
 *    `MIN_SUPPORTED` 决定，如果这里另算一遍，两处口径迟早不一致——一边不强制、
 *    一边强制，用户看到的行为就随机。
 * 2. **只改 `url` 一个字段**（改成 5blong.site），`signature` 原样保留。
 *    签名是 tauri 在上传产物时算的，自己重算/搬动都会导致客户端校验失败。
 * 3. **不许降级**：本地版本 >= 远端就跳过。历史上真踩过——两个 tag 的构建
 *    完成顺序颠倒，线上 latest.json 从 1.8.9 退回 1.8.8，所有人停在旧版。
 * 4. **原子替换**：先写 `.part` 再 rename，否则正好在下载的客户端会读到半个文件。
 * 5. 旧 exe 只留上一版，留着是给"正好在下载"的客户端用。
 *
 * 用法：
 *   node sync-desktop.mjs              # 正常同步
 *   node sync-desktop.mjs --dry-run    # 只说要做什么，不写文件
 *   node sync-desktop.mjs --force      # 忽略"不降级"护栏（回滚时用）
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const DEST = process.env.DESKTOP_DIR || "/var/www/5blong/desktop";
const SITE = (process.env.SITE_BASE || "https://5blong.site").replace(/\/+$/, "");
const TARGET = "windows-x86_64";
const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

/**
 * 来源顺序（2026-11-03 业主口径：「以后弃用 CF 的 Pages」）：
 *
 * 1. **GitHub Releases 是主来源**——CI 出包后就发在这里，不依赖任何第三方静态站。
 * 2. Pages 只作**过渡期兜底**：1.9.11 及更老的客户端只认 pages.dev，
 *    这一版还得靠它送达；等旧客户端被强制更新干净、pages.dev 下线后，
 *    把下面这一项删掉即可，其余代码不用动。
 *
 * 注意用的是 `releases/latest/download/...`（直接重定向到资产），不走 API，
 * 所以没有每小时 60 次的限流问题。
 */
const SOURCES = [
  { label: "github", url: "https://github.com/HeXiang96/5blong/releases/latest/download/latest.json" },
  { label: "pages", url: "https://5blong.pages.dev/desktop/latest.json" },
];

const log = (step, message) => process.stdout.write(`[sync-desktop] ${step.padEnd(9)} ${message}\n`);

/** `1.9.12` → 数字数组，用来比大小。非数字段一律当 0。 */
function parseVersion(v) {
  return String(v || "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
}

/** a 比 b 新返回 正数；相等 0；旧 负数。 */
function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 依次试来源，第一个可用且结构合法的就用。 */
async function loadManifest() {
  const errors = [];
  for (const { label, url } of SOURCES) {
    try {
      const j = await fetchJson(url);
      const plat = j?.platforms?.[TARGET];
      if (!j?.version || !plat?.url || !plat?.signature) {
        throw new Error("结构不完整（缺 version / url / signature）");
      }
      log("source", `${label} → v${j.version}（minimum=${j.minimum || "未设置"}）`);
      return { manifest: j, label };
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      log("source", `${label} 不可用：${e.message}`);
    }
  }
  throw new Error(`所有更新源都拿不到 latest.json\n  ${errors.join("\n  ")}`);
}

/**
 * 取强制更新闸门的值（`minimum`）。
 *
 * **为什么不能只信 manifest**：GitHub Release 里那份 `latest.json` 是 tauri-action
 * 生成的，根本没有 `minimum` 字段——那个字段是 `publish-desktop.mjs` 在发 Pages 时
 * **后加**的。以前只从 Pages 拿，所以看不出来；改成从 GitHub 拿之后，
 * 一旦照抄就会把闸门写成空值 → 旧客户端又变成"可以点稍后再说"，
 * 强制更新静默失效（不报错，最难查）。
 *
 * 所以这里直接从仓库源码读 `MIN_SUPPORTED`——**口径只有一处**，
 * 永远跟 `npm run publish:desktop` 用的是同一个值。
 * 读不到就退回本地上一版的值（宁可不更新，也不放行）。
 */
async function resolveMinimum(manifest, localPrev) {
  if (typeof manifest.minimum === "string" && /^\d+\.\d+\.\d+$/.test(manifest.minimum)) {
    return { value: manifest.minimum, from: "manifest" };
  }
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/HeXiang96/5blong/main/scripts/publish-desktop.mjs`,
      { signal: AbortSignal.timeout(20_000), headers: { "cache-control": "no-cache" } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const m = text.match(/const MIN_SUPPORTED\s*=\s*process\.env\.MIN_SUPPORTED\s*\|\|\s*"(\d+\.\d+\.\d+)"/);
    if (m) return { value: m[1], from: "publish-desktop.mjs" };
    throw new Error("源码里没找到 MIN_SUPPORTED 常量");
  } catch (e) {
    log("warn", `取闸门值失败：${e.message}`);
    if (localPrev && /^\d+\.\d+\.\d+$/.test(localPrev)) {
      return { value: localPrev, from: "沿用上一版（保守）" };
    }
    return { value: "", from: "无（闸门失效，需人工检查）" };
  }
}

/** 读本地已写下的 latest.json 里的某个字段，没有就给默认值。 */
function localField(name, fallback) {
  const f = path.join(DEST, "latest.json");
  if (!existsSync(f)) return fallback;
  try {
    return JSON.parse(readFileSync(f, "utf8"))[name] || fallback;
  } catch {
    log("warn", `本地 latest.json 解析失败，${name} 当作 ${fallback}`);
    return fallback;
  }
}

/** 读本地版本（上次写下的 latest.json），没有就当 0.0.0。 */
function localVersion() {
  return localField("version", "0.0.0");
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") || 0);
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  const size = statSync(part).size;
  if (size < 1024 * 1024) {
    unlinkSync(part);
    throw new Error(`下载文件太小（${size} 字节），不像安装包`);
  }
  if (total && size !== total) {
    unlinkSync(part);
    throw new Error(`下载不完整（${size}/${total} 字节）`);
  }
  renameSync(part, dest);
  return size;
}

/** 只留最新一版和它的上一版，其余删掉（别在别人正在下载时把文件抽走）。 */
function pruneOldExe(keepNames) {
  const keep = new Set(keepNames);
  for (const f of readdirSync(DEST)) {
    if (!f.endsWith(".exe") || keep.has(f)) continue;
    if (!/^5blong_\d+\.\d+\.\d+_x64-setup\.exe$/.test(f)) continue;
    const full = path.join(DEST, f);
    log("prune", `删除旧安装包 ${f}`);
    if (!DRY) unlinkSync(full);
  }
}

async function main() {
  if (!DRY) mkdirSync(DEST, { recursive: true });
  const current = localVersion();
  log("local", `本地版本 v${current}（${DEST}）`);

  const { manifest } = await loadManifest();
  const remote = manifest.version;

  if (!FORCE && compareVersion(remote, current) <= 0) {
    log("skip", `远端 v${remote} 不比本地 v${current} 新，什么都不做`);
    return;
  }

  const plat = manifest.platforms[TARGET];
  const exeName = path.basename(new URL(plat.url, "https://placeholder.invalid").pathname);
  if (!/^5blong_\d+\.\d+\.\d+_x64-setup\.exe$/.test(exeName)) {
    throw new Error(`安装包文件名不像话：${exeName}`);
  }

  const exePath = path.join(DEST, exeName);
  log("target", `v${remote} → ${exeName}`);

  const gate = await resolveMinimum(manifest, localField("minimum", ""));
  log("gate", `minimum=${gate.value || "空"}（来源：${gate.from}）`);

  if (DRY) {
    log("dry-run", `会下载 ${plat.url}`);
    log("dry-run", `会写 latest.json（url 改成 ${SITE}/desktop/${exeName}，minimum=${gate.value || "未设置"}）`);
    return;
  }

  const size = existsSync(exePath) && statSync(exePath).size > 1024 * 1024
    ? (log("exists", `安装包已在，跳过下载（${exeName}）`), statSync(exePath).size)
    : await download(plat.url, exePath);
  log("download", `${exeName} ${(size / 1024 / 1024).toFixed(1)} MB`);


  // 抄 CI 的 manifest，只动 url：签名/说明全部原样，避免两处口径打架。
  // minimum 单独由 resolveMinimum 决定（GitHub 那份里没有这个字段）。
  // 注意 platforms 里有两个 key（`windows-x86_64` 与 `windows-x86_64-nsis`），
  // 指向同一个安装包——只改一个的话，读另一个 key 的客户端还是会回原地址下。
  const out = {
    ...manifest,
    ...(gate.value ? { minimum: gate.value } : {}),
    platforms: Object.fromEntries(
      Object.entries(manifest.platforms).map(([key, value]) => {
        const pointsToSameExe =
          value && typeof value === "object" && typeof value.url === "string" &&
          path.basename(new URL(value.url, "https://placeholder.invalid").pathname) === exeName;
        return [key, pointsToSameExe ? { ...value, url: `${SITE}/desktop/${exeName}` } : value];
      }),
    ),
  };
  const tmp = path.join(DEST, "latest.json.part");
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
  renameSync(tmp, path.join(DEST, "latest.json"));
  log("write", `latest.json → v${remote}（minimum=${out.minimum || "未设置"}，url=${out.platforms[TARGET].url}）`);

  // 保留：本版 + 上一版（上一版可能是有人正在下的那个）。
  const prev = readdirSync(DEST)
    .filter((f) => /^5blong_\d+\.\d+\.\d+_x64-setup\.exe$/.test(f) && f !== exeName)
    .sort((a, b) => compareVersion(b.match(/_([\d.]+)_/)[1], a.match(/_([\d.]+)_/)[1]))[0];
  pruneOldExe(prev ? [exeName, prev] : [exeName]);

  log("done", `更新源已就绪：${SITE}/desktop/latest.json`);
}

main().catch((e) => {
  process.stderr.write(`[sync-desktop] 失败：${e.message}\n`);
  process.exit(1);
});
