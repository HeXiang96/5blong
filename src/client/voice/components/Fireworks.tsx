import { useEffect, useRef } from "react";

/**
 * 全屏烟花。
 *
 * 第一版是 7 个光点直接往上飘（纯 CSS），观感很差——没有升空、没有绽放。
 * 这里改成真正的烟花：火箭带尾迹升空 → 到顶点炸开 60+ 颗火花 →
 * 受重力与阻力影响扩散、变暗、消失。
 *
 * 实现约束（与项目既有做法一致）：
 * - 只在 3.4 秒内跑 rAF，播完自行停掉，不常驻；
 * - 不申请额外 DOM，只在自身 canvas 上画，卸载即释放；
 * - 尊重「减少动态效果」：直接不画（界面仍有文字提示兜底）。
 */
const DURATION_MS = 3400;
const SPARKS_PER_BURST = 92;

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  hue: number;
  size: number;
}

interface Rocket {
  x: number;
  y: number;
  vy: number;
  ttl: number;
  hue: number;
  trail: { x: number; y: number }[];
}

export function Fireworks() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let width = 0;
    let height = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const rockets: Rocket[] = [];
    const sparks: Spark[] = [];
    let launchedCount = 0;
    let raf = 0;
    let last = performance.now();
    const startedAt = last;

    const launch = () => {
      const x = width * (0.18 + Math.random() * 0.64);
      rockets.push({
        x,
        // 从画面底边略上方起飞，带一点随机延迟感
        y: height * (0.92 + Math.random() * 0.05),
        vy: -(height * 0.78),
        ttl: 3,
        hue: 24 + Math.random() * 30,
        trail: [],
      });
    };

    const explode = (rocket: Rocket) => {
      // 爆炸瞬间的白光（画在火花之前，用极短寿命的一颗大粒子代替 flash 状态）
      sparks.push({
        x: rocket.x,
        y: rocket.y,
        vx: 0,
        vy: 0,
        life: 0,
        ttl: 0.22,
        hue: rocket.hue,
        size: 46,
      });
      const count = SPARKS_PER_BURST;
      const baseHue = rocket.hue;
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.22;
        const speed = 130 + Math.random() * 240;
        sparks.push({
          x: rocket.x,
          y: rocket.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          ttl: 1.1 + Math.random() * 0.7,
          // 同一朵烟花主色调 ± 少量偏移，炸开时颜色更"整"
          hue: baseHue + (Math.random() - 0.5) * 26,
          size: 2.2 + Math.random() * 2.2,
        });
      }
    };

    // 三发错峰升空（毫秒）：太密会糊成一团，太散又没气势
    const launchAt = [0, 380, 760];

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const elapsed = now - startedAt;

      ctx.clearRect(0, 0, width, height);
      // 放烟花时把舞台压暗一点：浅色草地上不加这层，火花会糊在背景里
      const dim = Math.min(1, elapsed / 320) * (elapsed > DURATION_MS - 700 ? Math.max(0, (DURATION_MS - elapsed) / 700) : 1);
      ctx.fillStyle = `rgba(14, 9, 24, ${0.34 * dim})`;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";

      // 升空：按时间表依次发射，每帧最多发一枚
      if (launchedCount < launchAt.length && elapsed >= launchAt[launchedCount]!) {
        launch();
        launchedCount += 1;
      }

      for (let i = rockets.length - 1; i >= 0; i -= 1) {
        const r = rockets[i]!;
        r.trail.push({ x: r.x, y: r.y });
        if (r.trail.length > 10) r.trail.shift();
        r.vy += height * 0.46 * dt; // 重力，越接近顶点越慢
        r.y += r.vy * dt;
        r.ttl -= dt;

        // 尾迹：画成一整条锥形光带（点状尾迹在小尺寸下几乎看不见）
        const trail = r.trail;
        if (trail.length > 1) {
          ctx.lineCap = "round";
          for (let t = 1; t < trail.length; t += 1) {
            const a = trail[t - 1]!;
            const b = trail[t]!;
            const k = t / trail.length;
            ctx.strokeStyle = `hsla(${r.hue}, 100%, ${76 + k * 12}%, ${0.1 + k * 0.6})`;
            ctx.lineWidth = 0.8 + k * 3.2;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
        // 弹头（带一圈光晕，浅色背景里才看得见）
        ctx.fillStyle = `hsla(${r.hue}, 100%, 80%, 0.22)`;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `hsla(${r.hue}, 100%, 92%, 1)`;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 3.4, 0, Math.PI * 2);
        ctx.fill();

        if (r.vy >= -height * 0.05 || r.ttl <= 0) {
          explode(r);
          rockets.splice(i, 1);
        }
      }

      // 火花
      for (let i = sparks.length - 1; i >= 0; i -= 1) {
        const s = sparks[i]!;
        s.life += dt;
        if (s.life >= s.ttl) {
          sparks.splice(i, 1);
          continue;
        }
        const drag = Math.max(0, 1 - 1.5 * dt);
        s.vx *= drag;
        s.vy *= drag;
        s.vy += 130 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;

        const k = s.life / s.ttl;
        const alpha = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
        const flicker = 0.75 + Math.random() * 0.25; // 火星抖动
        const r = s.size * (1 - k * 0.45);
        // 外圈光晕：小半径的透明圆叠一层，比 shadowBlur 便宜很多
        ctx.fillStyle = `hsla(${s.hue}, 100%, 70%, ${alpha * flicker * 0.18})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r * 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `hsla(${s.hue}, 100%, ${84 - k * 24}%, ${alpha * flicker})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = "source-over";

      if (elapsed < DURATION_MS || sparks.length > 0) {
        raf = requestAnimationFrame(frame);
      }
    };
    raf = requestAnimationFrame(frame);
    const onResize = () => resize();
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas ref={canvasRef} className="vx-fireworks-canvas" aria-hidden="true" />;
}
