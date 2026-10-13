#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""changelog：补回 1.0.7/1.0.6/1.0.4 的历史内容 + boardEntries 辅助"""
import io

p = r"E:\twest\5blong\piik\src\client\voice\changelog.ts"
s = io.open(p, encoding="utf-8").read()

old = '''  {
    // 纯修复/已合并版本：lines 留空 → 公告栏跳过，只展示最新一条有内容的
    version: "1.0.7",
    date: "2026-10-13",
    lines: [],
  },
  {
    version: "1.0.6",
    date: "2026-10-13",
    lines: [],
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
  },
];

/** 公告栏展示用：最新一条**有内容**的记录（纯修复版本 lines 为空会跳过）。 */
export function latestChangelog(): ChangelogEntry | undefined {
  return CHANGELOG.find((entry) => entry.lines.length > 0);
}'''

new = '''  {
    version: "1.0.7",
    date: "2026-10-13",
    lines: [
      "修好：房主进设置不再冻结全房",
      "设置页新增「快捷方式」指南",
      "客户端滚动条不再乱入",
    ],
  },
  {
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
    // 纯修复/已合并版本：lines 留空 → 公告栏翻页时跳过
    version: "1.0.5",
    date: "2026-10-13",
    lines: [],
  },
  {
    version: "1.0.4",
    date: "2026-10-13",
    lines: [
      "8 种小猪互动动作上线",
      "闭听戴耳罩，全房间可见",
      "房间场景与聊天界面木质化",
      "断线自动重连、跨网连通增强",
    ],
  },
];

/** 公告栏展示用：最新一条**有内容**的记录。 */
export function latestChangelog(): ChangelogEntry | undefined {
  return CHANGELOG.find((entry) => entry.lines.length > 0);
}

/** 公告栏可翻阅的过往更新：有内容的最近 4 条（最新在前）。 */
export function boardEntries(): ChangelogEntry[] {
  return CHANGELOG.filter((entry) => entry.lines.length > 0).slice(0, 4);
}'''

assert old in s, "changelog 锚点未找到"
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("CHANGELOG_OK")
