"""批量跑抠图管线：把 outputs/actions 下的动作视频转成序列帧精灵。

按生成时间戳把视频映射到动作名，并按动作类型决定参数：
- 循环类（idle/walk/dance/run/sleep）：乒乓循环（首尾无缝）；
- 单次类（hang/roll/munch/strain/sniff/pat/boo/poke/wave/tickle/cheer/parachute/join）：单向播放。

输出：outputs/actions/sprites/<name>.webp
"""
import re
import subprocess
import sys
from pathlib import Path

ACTIONS = [
    # (时间戳片段, 动作名, 是否乒乓)
    ("12-09-47", "idle", True),
    ("12-11-57", "walk", True),
    ("12-13-52", "hang", True),        # 吊猪：悬挂摇摆，循环
    ("12-15-51", "roll", False),       # 翻滚：单次
    ("12-17-29", "run", True),
    ("12-18-47", "sleep", True),
    ("12-20-09", "munch", True),
    ("12-21-32", "strain", True),
    ("12-22-54", "sniff", False),
    ("12-24-27", "pat", False),
    ("12-25-55", "boo", False),
    ("12-27-12", "poke", False),
    ("12-28-24", "wave", False),
    ("12-29-41", "tickle", False),
    ("12-31-25", "cheer", False),
    ("12-33-04", "join-parachute", False),
]

SRC_DIR = Path("E:/tv12/5blong/outputs/actions")
OUT_DIR = SRC_DIR / "sprites"
OUT_DIR.mkdir(parents=True, exist_ok=True)

PY = "C:/Users/hexia/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
PIPE = "E:/tv12/5blong/5blong/scripts/video-to-sprite.py"

videos = {p.name: p for p in SRC_DIR.glob("*.mp4")}
for stamp, name, pingpong in ACTIONS:
    match = next((p for n, p in videos.items() if stamp in n), None)
    if match is None:
        print(f"!! 找不到 {name} 对应的视频（{stamp}）")
        continue
    out = OUT_DIR / f"{name}.webp"
    args = [PY, PIPE, str(match), str(out), "256", "10", "55", "0", "", "1" if pingpong else "0"]
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(result.stdout.strip() or result.stderr.strip())
