#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修正：复用 1.0.7 已有的 UpdatePhase，删除孤儿 UpdateProgress"""
import io, sys, os

os.chdir(r"E:\twest\5blong\piik\src-tauri\src")
s = io.open("lib.rs", encoding="utf-8").read()

# 1) 删除新插入块里重复的 UpdatePhase 定义（复用 1.0.7 已有的那个）
dup = '''/// 阶段事件载荷（checking / installing / error 走 update:phase）。
#[derive(Clone, serde::Serialize)]
struct UpdatePhase {
    phase: &'static str,
    message: Option<String>,
}

'''
assert dup in s, "dup UpdatePhase 未找到"
s = s.replace(dup, "", 1)

# 2) 删除孤儿 UpdateProgress（旧 check_for_update 已删，无人再用）
old_progress = '''/// 下载进度事件（发给前端画进度条）。
#[derive(Clone, serde::Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

'''
assert old_progress in s, "old UpdateProgress 未找到"
s = s.replace(old_progress, "", 1)

io.open("lib.rs", "w", encoding="utf-8", newline="").write(s)
print("FIX_OK")
