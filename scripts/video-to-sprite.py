"""视频 → 序列帧精灵（chroma key 管线）。

输入：绿幕动作视频（AI 生成，可能开头几帧白底、带水印、带绿色地面阴影）
输出：动画 WebP（透明底，裁切到内容，可调尺寸/帧率/质量）

处理步骤：
1. 逐帧读取；跳过开头的非绿幕帧（白底），找到稳定绿幕起点；
2. 抠绿幕：按"绿色占优"计算 alpha（含边缘羽化 + 去绿边 despill）；
3. 抽稀帧率（24fps → 目标帧率）；
4. 逐帧独立 bbox → 底部居中锚定到统一画布（消除 AI 视频帧间漂移）；
5. 可选：按时间段裁剪（掐掉 AI 漂移的后半段）+ 乒乓循环（正放+倒放，首尾无缝）；
6. 缩放 + 存动画 WebP。

用法：python video-to-sprite.py <in.mp4> <out.webp> [width=320] [fps=12] [quality=65] [start_s] [end_s] [pingpong=1]
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

def key_green(frame_bgr: np.ndarray) -> np.ndarray:
    """BGR 帧 → RGBA（绿幕抠成透明，去绿边）。"""
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    # "绿色度"：绿通道相对红蓝的占优程度
    greenness = g - np.maximum(r, b)
    alpha = np.clip(1.0 - greenness / 40.0, 0.0, 1.0)
    # 纯绿核心（绿色度很高）直接全透明，避免残留噪点
    alpha[greenness > 60] = 0.0
    # 去绿边：半透明/边缘像素把绿压到红蓝最大值以下
    g2 = np.minimum(g, np.maximum(r, b))
    out = np.stack([r, g2, b, alpha * 255.0], axis=-1).astype(np.uint8)
    return out


def key_white(frame_bgr: np.ndarray) -> np.ndarray:
    """白/灰底帧 → RGBA。

    用色彩特征而不是泛洪：白底是"低饱和 + 高明度"的灰白，
    而猪皮肤带粉色饱和度（耳/鼻更高）、眼睛是暗色——泛洪会从
    浅色猪背漏进去，色彩特征不会。
    """
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB).astype(np.float32)
    mx = rgb.max(axis=-1)
    mn = rgb.min(axis=-1)
    v = mx / 255.0
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1.0), 0.0)
    bg = (s < 0.055) & (v > 0.70)
    alpha = np.where(bg, 0.0, 255.0)
    # 边缘羽化，过渡自然
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
    out = np.dstack([rgb, alpha]).astype(np.uint8)
    return out


def key_frame(frame_bgr: np.ndarray) -> np.ndarray:
    """按角落颜色自动选绿幕键或白底键。"""
    h, w = frame_bgr.shape[:2]
    s = max(8, h // 20)
    mean = frame_bgr[0:s, 0:s].reshape(-1, 3).mean(axis=0)  # BGR
    b, g, r = mean
    if g > r * 1.3 and g > b * 1.3:
        return key_green(frame_bgr)
    return key_white(frame_bgr)


def is_green_frame(frame_bgr: np.ndarray) -> bool:
    """四角区域是否基本是"可用背景"（绿幕或白底都算）。"""
    h, w = frame_bgr.shape[:2]
    s = max(8, h // 20)
    corners = [frame_bgr[0:s, 0:s], frame_bgr[0:s, w - s:w], frame_bgr[h - s:h, 0:s], frame_bgr[h - s:h, w - s:w]]
    for c in corners:
        mean = c.reshape(-1, 3).mean(axis=0)  # BGR
        b, g, r = mean
        green = g > 120 and g > r * 1.3 and g > b * 1.3
        white = min(b, g, r) > 230
        if not (green or white):
            return False
    return True

def main() -> None:
    src = Path(sys.argv[1])
    out = Path(sys.argv[2])
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 320
    target_fps = float(sys.argv[4]) if len(sys.argv) > 4 else 12
    quality = int(sys.argv[5]) if len(sys.argv) > 5 else 65
    start_s = float(sys.argv[6]) if len(sys.argv) > 6 else 0.0
    end_s = float(sys.argv[7]) if len(sys.argv) > 7 and sys.argv[7] else None
    pingpong = len(sys.argv) > 8 and sys.argv[8] == "1"
    out.parent.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    step = max(1, round(fps / target_fps))
    frames_rgba: list[np.ndarray] = []
    idx = -1
    green_started = False
    skipped = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        idx += 1
        if idx % step:
            continue
        if not green_started:
            if not is_green_frame(frame):
                skipped += 1
                continue
            green_started = True
        frames_rgba.append(key_frame(frame))
    cap.release()

    if not frames_rgba:
        raise SystemExit(f"没有取到任何绿幕帧: {src}")

    # 按"绿幕段内"的秒数裁剪（跳过开头白帧后再算时间）：掐掉 AI 漂移的后半段
    kept_dt = step / fps
    start_i = max(0, round(start_s / kept_dt))
    end_i = len(frames_rgba) if end_s is None else min(len(frames_rgba), round(end_s / kept_dt))
    frames_rgba = frames_rgba[start_i:end_i]
    if len(frames_rgba) < 2:
        raise SystemExit("裁剪后帧数不足")

    if pingpong:
        # 正放 + 倒放（去掉重复的首尾帧），循环首尾无缝
        frames_rgba = frames_rgba + frames_rgba[-2:0:-1]

    # 逐帧独立包围盒 → 统一平移到"底部居中"画布，消除 AI 视频的帧间漂移
    boxes = []
    for f in frames_rgba:
        mask = f[..., 3] > 40
        ys, xs = np.where(mask)
        if len(xs) == 0:
            boxes.append(None)
        else:
            boxes.append((xs.min(), ys.min(), xs.max(), ys.max()))

    pad = 6
    cw = max((b[2] - b[0] for b in boxes if b), default=0) + pad * 2
    ch = max((b[3] - b[1] for b in boxes if b), default=0) + pad * 2
    scale = width / max(1, cw)
    new_size = (width, max(1, round(ch * scale)))
    pil_frames = []
    for f, b in zip(frames_rgba, boxes):
        canvas = np.zeros((ch, cw, 4), dtype=np.uint8)
        if b:
            x0, y0, x1, y1 = b
            bw, bh = x1 - x0, y1 - y0
            ox = (cw - bw) // 2
            oy = ch - bh - pad  # 底部对齐
            canvas[oy:oy + bh, ox:ox + bw] = f[y0:y1, x0:x1]
        img = Image.fromarray(canvas, "RGBA").resize(new_size, Image.LANCZOS)
        pil_frames.append(img)

    duration_ms = int(1000 / target_fps)
    pil_frames[0].save(
        out,
        save_all=True,
        append_images=pil_frames[1:],
        duration=duration_ms,
        loop=0,
        quality=quality,
        alpha_quality=60,
        method=6,
        minimize_size=True,
    )
    kb = out.stat().st_size / 1024
    print(f"{out.name}: {len(pil_frames)} frames @{target_fps}fps, {new_size[0]}x{new_size[1]}, {kb:.0f} KB (跳过开头 {skipped} 帧非绿幕)")

if __name__ == "__main__":
    main()
