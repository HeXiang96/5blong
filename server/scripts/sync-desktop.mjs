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
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const DEST = process.env.DESKTOP_DIR || "/var/www/5blong/desktop";
const SITE = (process.env.SITE_BASE || "https://5blong.site").replace(/\/+$/, "");

/**
 * 安装包下载地址（2026-11-03 接阿里云 GA 全球加速）。
 *
 * ⚠️ **默认关闭（2026-11-03 17:20 事故后改的）**
 *
 * 加速本身是有效的：国内实测 15~38MB/s，直连 0.45~11.5MB/s。
 * 但 **Windows 的原生 TLS 栈（schannel）连不上 GA 的加速 IP**：
 *   .NET:  "基础连接已经关闭: 发送时发生错误"
 *   curl:  "schannel: failed to receive handshake, SSL/TLS connection failed"
 *   openssl / Node / 浏览器: 正常（15~38MB/s）
 * 而 Tauri 的 updater 在 Windows 上用的就是 native-tls（reqwest 默认后端），
 * 于是所有客户端下载更新全部失败——这就是 1.9.14 → 1.9.15 那次事故。
 *
 * 所以现在是**显式开启**：只有确认客户端换了 rustls 并铺开之后，
 * 才在 systemd 里设 `Environment=DL_BASE=https://dl.5blong.site`。
 * 不设 = 走主域直连（慢，但任何客户端都能下）。
 *
 * 加速管道的其余部分（dl 的 nginx server 块、证书、DNS）都留着，随时可用。
 */
const DL_SITE = (process.env.DL_BASE || "").replace(/\/+$/, "");
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
 * ⚠️ `releases/latest/download/...` 这个地址**有 CDN 缓存**：刚发完版那几分钟
 * 它还在返回上一版的文件，直接拉会以为"没有新版本"，白等一个周期。
 * 所以先用 API 问出确切的 tag，再按 tag 拼直链（tag 直链不走那个缓存。
 */
const REPO = "HeXiang96/5blong";

/** 问 GitHub API 当前最新 release 的 tag。拿不到就返回空串（退回 latest 兜底）。 */
async function resolveLatestTag() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/vnd.github+json", "cache-control": "no-cache" },
    });
    if (!res.ok) {
      log("warn", `问最新版本失败：HTTP ${res.status}`);
      return "";
    }
    const json = await res.json();
    return typeof json.tag_name === "string" ? json.tag_name : "";
  } catch (e) {
    log("warn", `问最新版本失败：${e.message}`);
    return "";
  }
}

const FALLBACK_SOURCES = [
  { label: "github-latest", url: `https://github.com/${REPO}/releases/latest/download/latest.json` },
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
async function loadManifest(sources) {
  const errors = [];
  for (const { label, url } of sources) {
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

/**
 * 决定 this run 用哪个域名写进 url：加速域名还是直连主域。
 *
 * 为什么要有这一步（不是写完就完事）：
 *   加速域名一旦写进 latest.json，**所有客户端都会去那里下**。
 *   只要它有一项不对——证书过期、nginx 少个 server 块——
 *   表现就是"所有人都更新不了"，而且报错发生在客户端，服务器这边毫无动静。
 *
 * 为什么探测的是**本机 127.0.0.1 而不是走 DNS 去连 GA**（2026-11-03 实测）：
 *   这台机器在香港，GA 的加速区域是「中国内地」。从香港去打国内接入点
 *   拿不到完整握手（TCP 通、TLS 000），而国内用户实测 17~38 MB/s。
 *   所以"服务器能不能连 GA"这个问题本身就问错了——它测的是服务器的位置，
 *   不是用户的体验。真正要确认的是**本机已经把 dl 服务准备好了**：
 *   SNI 是 dl、证书覆盖 dl、nginx 认得这个 Host。
 *
 *   至于 GA 那一段（就近接入 → 骨干 → 回源），由阿里云侧保证；
 *   真挂了，`repairDownloadBase` 也没法救（它只能改地址，改不了 GA 的命），
 *   那种情况需要人工把 DL_BASE 置空重新同步，见文末注释。
 */
function probeSelfReady() {
  return new Promise((resolve) => {
    const host = new URL(DL_SITE).hostname;
    const req = https.request(
      {
        host: "127.0.0.1",
        port: 443,
        path: "/desktop/latest.json",
        method: "HEAD",
        servername: host,          // SNI 决定 nginx 用哪个 server 块
        headers: { host },         // TLS 证书按这个校验，必须是 dl 域名
        timeout: 8000,
      },
      (res) => {
        res.resume();
        if (res.statusCode === 200) resolve({ ok: true, detail: "200" });
        else resolve({ ok: false, detail: `HTTP ${res.statusCode}` });
      },
    );
    req.on("timeout", () => req.destroy(new Error("超时 8s")));
    req.on("error", (e) => resolve({ ok: false, detail: e.message }));
    req.end();
  });
}

/**
 * 两份清单各自的下载域名（2026-11-03 起按客户端能力分流）。
 *
 *   latest.json     → 主域直连，**所有客户端**都读这份（老版本只认它）
 *   latest-ga.json  → 加速域名，只有带 `X-Update-Caps: rustls` 的 1.9.16+ 才读
 *
 * 为什么不是一刀切：加速域名对部分客户端的 TLS 栈不可达，而清单只有一份时，
 * 老客户端读到的地址必须是它能用的。分流之后两边各拿各的，谁也不影响谁，
 * 也不需要为了开加速去强制更新。
 *
 * 加速没配（DL_BASE 为空）或本机没备好时，两份写一样的内容——等于关闭加速。
 */
async function resolveBases() {
  if (!DL_SITE || DL_SITE === SITE) return { direct: SITE, ga: SITE, from: "未启用加速（默认）" };
  const r = await probeSelfReady();
  if (r.ok) return { direct: SITE, ga: DL_SITE, from: "加速已启用（本机就绪）" };
  log("warn", `加速域名未就绪（${r.detail}），两份清单都写直连`);
  return { direct: SITE, ga: SITE, from: `加速未就绪：${r.detail}` };
}

/** 读本地版本（上次写下的 latest.json），没有就当 0.0.0。 */
function localVersion() {
  return localField("version", "0.0.0");
}

/**
 * 版本没变时，把两份清单里的下载域名修正成当前该用的那个。
 *
 * 场景：`latest-ga.json` 已经指向 `dl.5blong.site`，某天 GA 欠费/证书过期/线路挂掉。
 * 因为版本没变，常规流程会直接 skip——**带 header 的客户端还指着那个坏地址**，
 * 没有任何东西会去修它，只能等人发现。这条分支就是那个"人"。
 * 修完之后加速那份自动降级成直连，等于临时关掉加速。
 *
 * 只动我们自己那两个域名（SITE / DL_SITE）的 url，GitHub 兜底地址不碰。
 * 返回是否真的改了文件。
 */
function repairDownloadBase(bases) {
  let changed = false;
  for (const [name, base] of [
    ["latest.json", bases.direct],
    ["latest-ga.json", bases.ga],
  ]) {
    const f = path.join(DEST, name);
    if (!existsSync(f)) continue;
    let j;
    try {
      j = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    if (!j?.platforms) continue;

    let touched = false;
    const platforms = Object.fromEntries(
      Object.entries(j.platforms).map(([key, value]) => {
        if (!value || typeof value.url !== "string") return [key, value];
        let u;
        try {
          u = new URL(value.url);
        } catch {
          return [key, value];
        }
        const currentBase = `${u.protocol}//${u.host}`;
        if (currentBase !== SITE && currentBase !== DL_SITE) return [key, value];
        if (currentBase === base) return [key, value];
        touched = true;
        return [key, { ...value, url: `${base}${u.pathname}` }];
      }),
    );
    if (!touched) continue;

    const tmp = `${f}.part`;
    writeFileSync(tmp, `${JSON.stringify({ ...j, platforms }, null, 2)}\n`);
    renameSync(tmp, f);
    changed = true;
  }
  return changed;
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

  const tag = await resolveLatestTag();
  const sources = tag
    ? [
        { label: `github ${tag}`, url: `https://github.com/${REPO}/releases/download/${tag}/latest.json` },
        ...FALLBACK_SOURCES,
      ]
    : FALLBACK_SOURCES;

  const { manifest } = await loadManifest(sources);
  const remote = manifest.version;

  if (!FORCE && compareVersion(remote, current) <= 0) {
    // 版本没变也要确认一次下载地址还活着（GA 停机/证书过期时自动退回直连）。
    if (DRY) {
      log("skip", `远端 v${remote} 不比本地 v${current} 新，什么都不做`);
      return;
    }
    const bases0 = await resolveBases();
    if (repairDownloadBase(bases0)) {
      log("repair", `版本没变，但下载地址已修正（直连 ${bases0.direct} / 加速 ${bases0.ga}）`);
    } else {
      log("skip", `远端 v${remote} 不比本地 v${current} 新，什么都不做（${bases0.from}）`);
    }
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

  // 两份清单各自的下载域名（见 resolveBases 的注释）
  const bases = await resolveBases();
  log("base", `直连 ${bases.direct} ／ 加速 ${bases.ga}（${bases.from}）`);

  if (DRY) {
    log("dry-run", `会下载 ${plat.url}`);
    log("dry-run", `会写 latest.json（${bases.direct}/desktop/…）和 latest-ga.json（${bases.ga}/desktop/…），minimum=${gate.value || "未设置"}`);
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
  const build = (base) => ({
    ...manifest,
    ...(gate.value ? { minimum: gate.value } : {}),
    platforms: Object.fromEntries(
      Object.entries(manifest.platforms).map(([key, value]) => {
        const pointsToSameExe =
          value && typeof value === "object" && typeof value.url === "string" &&
          path.basename(new URL(value.url, "https://placeholder.invalid").pathname) === exeName;
        return [key, pointsToSameExe ? { ...value, url: `${base}/desktop/${exeName}` } : value];
      }),
    ),
  });
  for (const [name, base] of [
    ["latest.json", bases.direct],
    ["latest-ga.json", bases.ga],
  ]) {
    const out = build(base);
    const file = path.join(DEST, name);
    const tmp = `${file}.part`;
    writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
    renameSync(tmp, file);
    log("write", `${name} → v${remote}（minimum=${out.minimum || "未设置"}，url=${out.platforms[TARGET].url}）`);
  }

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
