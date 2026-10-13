#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""补回 set_window_bg 与 check_update 命令"""
import io, sys, os

os.chdir(r"E:\twest\5blong\piik\src-tauri\src")
s = io.open("lib.rs", encoding="utf-8").read()

anchor = '''/// 检查更新（发事件，不弹原生框）：有新版发 update:available，'''
assert anchor in s, "run_check 锚点"
new = '''/// 窗口底色跟随时段天空色（前端每次时段变化时调用），
/// 让系统标题栏不再是一块突兀的白条。
#[tauri::command]
fn set_window_bg(app: tauri::AppHandle, color: String) {
    use std::str::FromStr;
    let Ok(parsed) = tauri::utils::config::Color::from_str(&color) else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_background_color(Some(parsed));
    }
}

/// 检查更新（前端触发）：结果全部走事件，由主题化界面展示。
#[tauri::command]
async fn check_update(
    app: tauri::AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), String> {
    run_check(&app, &state, true).await
}

''' + anchor
s = s.replace(anchor, new, 1)
io.open("lib.rs", "w", encoding="utf-8", newline="").write(s)
print("OK")
