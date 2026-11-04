/**
 * 5blong · Cloudflare Pages 高级模式 Worker（_worker.js）。
 *
 * ⚠️ 2026-11-04 起本站（5blong.pages.dev）停止运营，后端已迁移到自托管
 * 香港 ECS（5blong.site）。本 worker 对所有请求返回同一张「迁移提示页」：
 *
 *   - 页面明示「旧网站已停止运营 / 已迁移到新网站」，由**用户点击**按钮
 *     跳转 5blong.site（不做自动 301，业主明确要求提示 + 手动跳转）；
 *   - 按钮携带原路径与查询串（如旧邀请链接的 roomKey），点过去无缝续用；
 *   - 例外：/desktop/latest.json 仍 301 到新站真更新源——万一还有旧桌面
 *     客户端，更新器跟随重定向能升到最终版（1.9.x 起连 5blong.site）；
 *   - WebSocket 无法跟随 3xx/提示页，直接 426 并说明去向。
 *
 * 原 /sfu、/ice、/feedback、/admin、静态站等逻辑全部移除；Pages 项目不再
 * 由 CI 更新（release.yml 已停发 Pages），本文件是最后一次手动部署的快照，
 * 只留作存档，不再维护。
 *
 * 部署（一次性，静态资产用最小目录即可，见 2026-11-04 日志）：
 *   node scripts/deploy-pages.mjs <最小资产目录> 5blong
 */

const TARGET = "https://5blong.site";

/** 迁移提示页：全屏深色 + 声浪动画 + 手动跳转按钮（品牌意象：语音 · 围炉暖光）。 */
function migrationPage(dest) {
  const safeDest = JSON.stringify(dest)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>5blong 已搬到新家 · 5blong.site</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", sans-serif;
    background: #0e1014;
    color: #ece9e4;
    display: flex; flex-direction: column;
    min-height: 100vh;
    position: relative; overflow: hidden;
  }
  /* 围炉暖光：底部中央一团橙光，页面唯一的氛围来源 */
  .glow {
    position: fixed; left: 50%; bottom: -22vh;
    width: 120vw; height: 55vh; transform: translateX(-50%);
    background: radial-gradient(ellipse at center,
      rgba(240,140,58,.20) 0%, rgba(229,98,60,.08) 38%, transparent 70%);
    pointer-events: none;
  }
  .grain {
    position: fixed; inset: 0; pointer-events: none; opacity: .5;
    background-image: radial-gradient(rgba(255,255,255,.028) 1px, transparent 1px);
    background-size: 3px 3px;
  }
  header {
    position: relative; z-index: 2;
    display: flex; align-items: center; gap: 10px;
    padding: 26px 34px;
    font-size: 14px; font-weight: 600; letter-spacing: .06em;
    color: #8d8983;
  }
  header .dot {
    width: 9px; height: 9px; border-radius: 50%;
    background: linear-gradient(135deg, #f08c3a, #e5623c);
    box-shadow: 0 0 10px rgba(240,140,58,.8);
  }
  main {
    position: relative; z-index: 2;
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    text-align: center; padding: 24px 28px 40px;
  }
  /* 语音声浪：7 根跳动条，品牌记忆点 */
  .wave {
    display: flex; align-items: center; gap: 7px;
    height: 40px; margin-bottom: 34px;
  }
  .wave i {
    width: 6px; border-radius: 4px;
    background: linear-gradient(180deg, #f5a54d, #e5623c);
    animation: pulse 1.5s ease-in-out infinite;
    transform-origin: center;
  }
  .wave i:nth-child(1) { height: 14px; animation-delay: 0s;    opacity: .75; }
  .wave i:nth-child(2) { height: 26px; animation-delay: .18s; }
  .wave i:nth-child(3) { height: 38px; animation-delay: .36s; }
  .wave i:nth-child(4) { height: 24px; animation-delay: .54s; }
  .wave i:nth-child(5) { height: 34px; animation-delay: .72s; }
  .wave i:nth-child(6) { height: 18px; animation-delay: .9s;  opacity: .75; }
  .wave i:nth-child(7) { height: 28px; animation-delay: 1.08s; opacity: .85; }
  @keyframes pulse {
    0%, 100% { transform: scaleY(.55); }
    50%      { transform: scaleY(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .wave i { animation: none; }
  }
  .eyebrow {
    font-size: 13px; letter-spacing: .35em; text-indent: .35em;
    color: #f3c889; font-weight: 600; margin-bottom: 16px;
  }
  h1 {
    font-size: clamp(38px, 8vw, 64px);
    font-weight: 800; letter-spacing: .02em; line-height: 1.15;
  }
  h1 em {
    font-style: normal;
    background: linear-gradient(120deg, #f5a54d, #e5623c 70%);
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; color: transparent;
  }
  .desc {
    margin-top: 20px; max-width: 460px;
    font-size: 15.5px; line-height: 1.9; color: #a09c96;
  }
  .cta { margin-top: 36px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .btn {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 16px 42px; border-radius: 999px; border: 0; cursor: pointer;
    background: linear-gradient(135deg, #f08c3a, #e5623c);
    color: #fff; font-size: 16.5px; font-weight: 700; letter-spacing: .04em;
    text-decoration: none;
    box-shadow: 0 10px 32px rgba(229,98,60,.35), inset 0 1px 0 rgba(255,255,255,.25);
    transition: transform .16s ease, box-shadow .16s ease, filter .16s ease;
  }
  .btn:hover {
    filter: brightness(1.07);
    transform: translateY(-2px);
    box-shadow: 0 14px 40px rgba(229,98,60,.45), inset 0 1px 0 rgba(255,255,255,.25);
  }
  .btn:active { transform: translateY(0); }
  .btn .arrow { transition: transform .16s ease; }
  .btn:hover .arrow { transform: translateX(3px); }
  .host {
    font-size: 13.5px; color: #8d8983; letter-spacing: .08em;
  }
  .host b { color: #d9d5cf; font-weight: 600; }
  footer {
    position: relative; z-index: 2;
    text-align: center; padding: 0 24px 30px;
    font-size: 12.5px; color: #6e6a65; line-height: 1.8;
  }
  @media (max-width: 480px) {
    header { padding: 20px 22px; }
    .btn { padding: 15px 34px; width: 100%; justify-content: center; }
  }
</style>
</head>
<body>
  <div class="glow"></div>
  <div class="grain"></div>
  <header><span class="dot"></span>5blong</header>
  <main>
    <div class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <div class="eyebrow">旧网站已停止运营</div>
    <h1>我们搬家了，<br>炉火移到了<em>新家</em></h1>
    <p class="desc">5blong 已经整体搬迁到全新网站，语音房、好友与邀请都在老地方等你——点下面的按钮，带着这条链接过去。</p>
    <div class="cta">
      <a class="btn" id="go" data-dest="${safeDest}">前往新网站 <span class="arrow">→</span></a>
      <span class="host">新地址 <b>5blong.site</b></span>
    </div>
  </main>
  <footer>原邀请链接仍然有效：跳转后会带你打开新站的对应页面。</footer>
  <script>
    var btn = document.getElementById("go");
    try { btn.href = JSON.parse(btn.dataset.dest); } catch (e) { btn.href = ${JSON.stringify(TARGET)}; }
  </script>
</body>
</html>`;
}

export default {
  // _env：Pages 的运行时绑定（账号 API 时代用过）。存档版不再使用，但保留参数
  // 与 Pages 协议一致——集成测试也按 (request, env) 两参调用。
  async fetch(request, _env) {
    const url = new URL(request.url);

    // WebSocket（旧信令）无法出示提示页，直接说明去向。
    if (request.headers.get("Upgrade") === "websocket") {
      return new Response("5blong has moved to https://5blong.site", {
        status: 426,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // 旧桌面客户端的更新源：引到新站，让它至少能升到最终版。
    if (url.pathname === "/desktop/latest.json") {
      return Response.redirect(TARGET + url.pathname + url.search, 301);
    }

    // 其余一切请求 → 迁移提示页（200，不缓存）。
    const dest = TARGET + url.pathname + url.search;
    return new Response(migrationPage(dest), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  },
};
