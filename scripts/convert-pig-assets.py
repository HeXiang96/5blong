"""把业主的三个小猪 GIF 转成动画 WebP（控制体积，透明底保留）。

用法：python convert-pig-assets.py
源：E:/tv12/pig/{吊猪,快跑猪,蹦迪猪}.gif
出：E:/tv12/5blong/5blong/src/client/voice/assets/{hanging,running,disco}-pig.webp
"""
from pathlib import Path

from PIL import Image, ImageSequence

SRC = Path("E:/tv12/pig")
DST = Path("E:/tv12/5blong/5blong/src/client/voice/assets")
DST.mkdir(parents=True, exist_ok=True)

JOBS = [
    ("吊猪.gif", "hanging-pig.webp", 512, 70),
    ("快跑猪.gif", "running-pig.webp", 512, 70),
    ("蹦迪猪.gif", "disco-pig.webp", 512, 75),
]

for src_name, out_name, max_w, quality in JOBS:
    src = SRC / src_name
    out = DST / out_name
    frames = []
    durations = []
    for frame in ImageSequence.Iterator(Image.open(src)):
        rgba = frame.convert("RGBA")
        if rgba.width > max_w:
            ratio = max_w / rgba.width
            rgba = rgba.resize((max_w, round(rgba.height * ratio)), Image.LANCZOS)
        frames.append(rgba)
        durations.append(frame.info.get("duration", 80) or 80)
    # 保存为动画 WebP：透明底、无损关键帧间隔、限制画质控体积
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        quality=quality,
        method=6,
        minimize_size=True,
    )
    size_kb = out.stat().st_size / 1024
    print(f"{src_name} -> {out_name}: {len(frames)} frames, {size_kb:.0f} KB")
