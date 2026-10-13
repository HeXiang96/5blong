#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""changelog：加 1.0.8 条目，旧条目清空"""
import io

p = r"E:\twest\5blong\piik\src\client\voice\changelog.ts"
s = io.open(p, encoding="utf-8").read()

old = '''export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.0.6",
    date: "2026-10-13",
    lines: [
      "小猪换 3D 新形象，全套动作上线",
      "新互动「吊起来」+ 降落伞空降入场",
      "场景与界面跟随早晚自动变色",
      "更新下载显示进度：小猪跑给你看",
    ],
  },'''
new = '''export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.0.8",
    date: "2026-10-13",
    lines: [
      "更新全流程换成木牌主题界面，告别原生白框",
      "窗口标题栏跟随深浅色与四时段主题",
      "默认静音进房；投喂后小猪立即跑向食物",
      "设置里改昵称，铭牌立即跟着变",
    ],
  },
  {
    // 纯修复/已合并版本：lines 留空 → 公告栏跳过，只展示最新一条有内容的
    version: "1.0.7",
    date: "2026-10-13",
    lines: [],
  },
  {
    version: "1.0.6",
    date: "2026-10-13",
    lines: [],
  },'''
assert old in s, "changelog 锚点未找到"
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("CHANGELOG_OK")
