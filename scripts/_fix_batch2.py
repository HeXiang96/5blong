#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量修复续：HELLO muted / identity parse / use-voice / settings / 徽章 / changelog"""
import io, sys, os

os.chdir(r"E:\twest\5blong\piik\src\client\voice")

def patch(path, pairs, must=True):
    s = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        if old not in s:
            if must:
                print(f"[FAIL] {path}: 未找到锚点: {old[:70]!r}")
                sys.exit(1)
            print(f"[SKIP] {path}: 锚点不存在")
            continue
        s = s.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="").write(s)
    print(f"[OK] {path}")

# ================= engine.ts：HELLO 带 muted =================
patch("engine.ts", [
    ('''      hasMic: this.me.hasMic,
      nonce,
      proof,
    });''',
     '''      hasMic: this.me.hasMic,
      muted: this.me.muted,
      nonce,
      proof,
    });'''),
])

# ================= protocol.ts =================
patch("protocol.ts", [
    # HELLO 类型加 muted + identity 消息
    ('''  | { t: "hello"; personId: string; sessionId: string; name: string; avatar: string; color: string; hasMic: boolean; nonce: string; proof: string }''',
     '''  | { t: "hello"; personId: string; sessionId: string; name: string; avatar: string; color: string; hasMic: boolean; muted: boolean; nonce: string; proof: string }
  | { t: "identity"; name: string; avatar: string; color: string }'''),
])

# hello parse：加 muted 字段
s = io.open("protocol.ts", encoding="utf-8").read()
i = s.find('case "hello": {')
assert i != -1, "hello case 未找到"
j = s.find("hasMic", i)
assert j != -1
line_end = s.find("\n", j)
s = s[:line_end] + '\n        muted: typeof record["muted"] === "boolean" ? record["muted"] : false,' + s[line_end:]
io.open("protocol.ts", "w", encoding="utf-8", newline="").write(s)
print("[OK] protocol.ts hello parse muted")

# identity parse case：插在 hello case 结束之后
s = io.open("protocol.ts", encoding="utf-8").read()
anchor = s.find('case "hello": {')
end = s.find("\n  if (kind ===", anchor)  # hello case 后面的下一个 case/if
if end == -1:
    end = s.find("\n  }\n", anchor)
insert_pos = s.find("\n", s.find("return {", anchor))  # 兜底
# 找 hello case 的结束 "  }\n"（第一个顶格两空格大括号）
end = s.find("\n  }\n", anchor)
assert end != -1
identity_case = '''
  if (kind === "identity") {
    const name = str(record["name"], 24);
    const avatar = typeof record["avatar"] === "string" ? record["avatar"].slice(0, 200_000) : "";
    const colorRaw = str(record["color"], 16);
    if (!name || !colorRaw) return null;
    return { t: "identity", id, name, avatar, color: colorRaw };
  }'''
s = s[:end] + identity_case + s[end:]
io.open("protocol.ts", "w", encoding="utf-8", newline="").write(s)
print("[OK] protocol.ts identity parse")

# ================= use-voice.ts =================
patch("use-voice.ts", [
    # feedCount：投喂时不立即涨
    ('''  const interact = useCallback((peerId: string, personId: string, kind: InteractKind) => {
    engineRef.current?.interactWith(peerId, kind);
    if (kind === "feed" && personId) {
      setFeedCounts((prev) => {
        const next = { ...prev, [personId]: (prev[personId] ?? 0) + 1 };
        writeJson(FEED_STORAGE_KEY, next);
        return next;
      });
    }
  }, []);''',
     '''  const interact = useCallback((peerId: string, personId: string, kind: InteractKind) => {
    engineRef.current?.interactWith(peerId, kind);
    // 注意：喂食计数在猪**真的吃掉**时才 +1（见下方 pen 事件处理），
    // 之前是投喂瞬间就涨——猪还没动体型先变大，观感很怪。
  }, []);'''),
    # pen 事件处理：eat 事件到达 → 走完 5s 后（开始嚼）计数 +1
    ('''      penPoses: (poses) => {''',
     '''      pen: (event) => {
        handlePenEvent(event);
        // "吃掉才长"：eat 事件到达后等走过去的时间（approach 5s），
        // 猪开始低头嚼的那一刻体型 +1，因果顺序才对。
        if (event.kind === "eat") {
          const actor = event.actor;
          window.setTimeout(() => {
            if (actor === "*") return;
            setFeedCounts((prev) => {
              const next = { ...prev, [actor]: (prev[actor] ?? 0) + 1 };
              writeJson(FEED_STORAGE_KEY, next);
              return next;
            });
          }, 5200);
        }
      },
      penPoses: (poses) => {'''),
])

# saveAll：改资料立即同步运行中的会话
s = io.open("use-voice.ts", encoding="utf-8").read()
old = '''      const engine = engineRef.current;
      const settingsToSave = persistSettings(nextSettings);
      if (engine) {
        void engine.updateAudioSettings(settingsToSave);
        engine.applySpeaker(settingsToSave);'''
new = '''      const engine = engineRef.current;
      const settingsToSave = persistSettings(nextSettings);
      if (engine) {
        void engine.updateAudioSettings(settingsToSave);
        engine.applySpeaker(settingsToSave);
        // 昵称/头像/颜色改动立即同步运行中的会话（铭牌不再停留在旧名字）
        engine.updateIdentity(nextIdentity);'''
assert old in s
s = s.replace(old, new)

# 进房默认静音：host 与房间码两条路径都用 true
s = s.replace('await engine.host(identityRef.current, settings, settings.joinMuted);',
              'await engine.host(identityRef.current, settings, true);')
s = s.replace('void joinRoom(target, settings.joinMuted);',
              'void joinRoom(target, true);')
s = s.replace('      void joinRoom(target, settings.joinMuted);',
              '      void joinRoom(target, true);')
io.open("use-voice.ts", "w", encoding="utf-8", newline="").write(s)
print("[OK] use-voice.ts")

# ================= settings.ts：默认静音进房 =================
patch("settings.ts", [
    ('    joinMuted: false,', '    joinMuted: true,'),
    ('    joinMuted: stored.joinMuted === true,', '    // 进房默认静音（2026-10-13 业主决定）；此字段暂无 UI，留作后续开关\n    joinMuted: stored.joinMuted === true,'),
])

# ================= 徽章对比度（三个主题块全改成深底奶油字）=================
p = "styles.css"
s = io.open(p, encoding="utf-8").read()
s = s.replace("  --vx-plate-badge-bg: rgba(176, 122, 52, 0.2);\n  --vx-plate-badge-fg: #7a4f12;",
              "  --vx-plate-badge-bg: rgba(122, 79, 18, 0.92);\n  --vx-plate-badge-fg: #ffefd0;")
s = s.replace("  --vx-plate-badge-bg: rgba(176, 122, 52, 0.18);\n  --vx-plate-badge-fg: #6b4410;",
              "  --vx-plate-badge-bg: rgba(122, 79, 18, 0.92);\n  --vx-plate-badge-fg: #ffefd0;")
s = s.replace("  --vx-plate-badge-bg: rgba(207, 150, 80, 0.22);\n  --vx-plate-badge-fg: #e8c894;",
              "  --vx-plate-badge-bg: rgba(122, 79, 18, 0.92);\n  --vx-plate-badge-fg: #ffefd0;")
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("[OK] styles.css badge 对比度")

# 收听/闭听两个浅色徽章也加深
patch("pen-scene.css", [
    ('''.vx-pig-tag-face b.vx-plate-quiet {
  background: rgba(110, 120, 135, 0.2);
  color: #5b6472;
}''',
     '''.vx-pig-tag-face b.vx-plate-quiet {
  background: rgba(74, 82, 96, 0.9);
  color: #f2f4f8;
}'''),
    ('''.vx-pig-tag-face b.vx-plate-deaf {
  background: rgba(116, 108, 146, 0.22);
  color: #565070;
}''',
     '''.vx-pig-tag-face b.vx-plate-deaf {
  background: rgba(86, 80, 112, 0.9);
  color: #f0eef8;
}'''),
])

# ================= changelog.ts：1.0.7 = 现有内容；旧版本清空 =================
p = "../src/client/voice/changelog.ts"
os.chdir(r"E:\twest\5blong\piik\src\client\voice")
patch("../src/client/voice/changelog.ts", [
    ('''  {
    version: "1.0.6",
    date: "2026-10-13",
    lines: [
      "小猪换 3D 新形象，全套动作上线",
      "新互动「吊起来」+ 降落伞空降入场",
      "场景与界面跟随早晚自动变色",
      "更新下载显示进度：小猪跑给你看",
    ],
  },
  {
    // 纯修复/已合并版本：lines 留空 → 公告栏跳过，只展示最新一条有内容的
    version: "1.0.5",
    date: "2026-10-13",
    lines: [],
  },
  {
    version: "1.0.4",
    date: "2026-10-13",
    lines: [],
  },''',
     '''  {
    version: "1.0.7",
    date: "2026-10-13",
    lines: [
      "小猪换 3D 新形象，全套动作上线",
      "新互动「吊起来」+ 降落伞空降入场",
      "场景与界面跟随早晚自动变色",
      "更新下载显示进度：小猪跑给你看",
    ],
  },
  {
    // 纯修复/已合并版本：lines 留空 → 公告栏跳过，只展示最新一条有内容的
    version: "1.0.6",
    date: "2026-10-13",
    lines: [],
  },
  {
    version: "1.0.5",
    date: "2026-10-13",
    lines: [],
  },
  {
    version: "1.0.4",
    date: "2026-10-13",
    lines: [],
  },'''),
])

print("BATCH_DONE")
