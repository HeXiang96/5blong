#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""更新器去弹窗化：全部消息走事件给前端主题化界面"""
import io, sys, os

os.chdir(r"E:\twest\5blong\piik\src-tauri\src")

s = io.open("lib.rs", encoding="utf-8").read()

# ---- 1) imports：去掉原生对话框，加 Mutex / Emitter / Update 载荷 ----
old = '''use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;'''
new = '''use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_updater::{Update, UpdaterExt};'''
assert old in s, "imports 锚点未找到"
s = s.replace(old, new, 1)

# ---- 2) 状态与事件载荷（插在 front_main 之前）----
old = '''/// 显示并聚焦主窗口（托盘菜单 / 单实例 / 托盘左键共用）。'''
new = '''/// 已发现、待用户确认下载的更新（确认后 start_update_download 取走）。
struct UpdaterState {
    pending: Mutex<Option<Update>>,
}

/// 阶段事件载荷（checking / installing / error 走 update:phase）。
#[derive(Clone, serde::Serialize)]
struct UpdatePhase {
    phase: &'static str,
    message: Option<String>,
}

/// 主题化提示事件（检查结果 / 错误说明，前端用木牌风卡片展示）。
#[derive(Clone, serde::Serialize)]
struct UpdateNotice {
    kind: &'static str, // "info" | "error"
    text: String,
}

/// 发现新版本事件载荷。
#[derive(Clone, serde::Serialize)]
struct UpdateMeta {
    version: String,
    current: String,
}

/// 检查更新（发事件，不弹原生框）：有新版发 update:available，
/// 手动检查的结果发 update:notice，启动静默检查只在新版时打扰。
async fn run_check(app: &tauri::AppHandle, state: &UpdaterState, manual: bool) -> Result<(), String> {
    let _ = app.emit(
        "update:phase",
        UpdatePhase { phase: "checking", message: None },
    );
    let Ok(updater) = app.updater() else {
        let _ = app.emit(
            "update:notice",
            UpdateNotice { kind: "error", text: "更新器初始化失败（配置缺失）。".into() },
        );
        return Ok(());
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let meta = UpdateMeta {
                version: update.version.clone(),
                current: update.current_version.clone(),
            };
            *state.pending.lock().unwrap() = Some(update);
            let _ = app.emit("update:available", meta);
            // 把主窗口带到前台：用户可能从托盘发起，提示框要看得见。
            if let Some(window) = front_main(app) {
                let _ = window.set_focus();
            }
        }
        Ok(None) => {
            if manual {
                let _ = app.emit(
                    "update:notice",
                    UpdateNotice {
                        kind: "info",
                        text: format!("当前已是最新版本（v{}）。", app.package_info().version),
                    },
                );
            }
        }
        Err(e) => {
            if manual {
                let _ = app.emit(
                    "update:notice",
                    UpdateNotice { kind: "error", text: format!("无法连接更新源：{e}") },
                );
            }
        }
    }
    Ok(())
}

/// 显示并聚焦主窗口（托盘菜单 / 单实例 / 托盘左键共用）。'''
assert old in s, "front_main 锚点未找到"
s = s.replace(old, new, 1)

# ---- 3) 删除旧的原生弹窗版 check_for_update + update_message_blocking ----
i1 = s.find("/// 检查更新并询问安装（更新包来自 GitHub Releases")
i2 = s.find("/// Windows/WebView2：自动放行页面的权限请求")
assert i1 != -1 and i2 != -1 and i1 < i2
s = s[:i1] + s[i2:]

# ---- 4) 新命令：check_update / start_update_download（含进度）----
anchor = '''/// 窗口底色跟随时段天空色（前端每次时段变化时调用），'''
new_cmds = '''/// 检查更新（前端触发）：结果全部走事件，由主题化界面展示。
#[tauri::command]
async fn check_update(
    app: tauri::AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), String> {
    run_check(&app, &state, true).await
}

/// 用户确认后开始下载安装：进度/阶段事件照发，装完才重启。
#[tauri::command]
async fn start_update_download(
    app: tauri::AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), String> {
    let Some(update) = state.pending.lock().unwrap().take() else {
        return Err("没有待安装的更新".into());
    };
    // 下载/安装期间窗口置顶：进度框钉在界面最上层。
    if let Some(window) = front_main(&app) {
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
    }
    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let result = update
        .download_and_install(
            move |chunk: usize, total: Option<u64>| {
                downloaded += chunk as u64;
                // 限流 ~8 次/秒，避免每几 KB 就发一条事件
                let done = total.map(|t| t > 0 && downloaded >= t).unwrap_or(false);
                if done || last_emit.elapsed().as_millis() >= 120 {
                    last_emit = std::time::Instant::now();
                    let _ = progress_app.emit(
                        "update:progress",
                        serde_json::json!({ "downloaded": downloaded, "total": total }),
                    );
                }
            },
            move || {
                let _ = finish_app.emit(
                    "update:phase",
                    UpdatePhase { phase: "installing", message: None },
                );
            },
        )
        .await;
    match result {
        Err(e) => {
            let _ = app.emit(
                "update:phase",
                UpdatePhase { phase: "error", message: Some(e.to_string()) },
            );
            let _ = app.emit(
                "update:notice",
                UpdateNotice { kind: "error", text: format!("下载或安装出错：{e}") },
            );
            // 失败就把置顶恢复掉，别把窗口"钉"死在最前面
            if let Some(window) = front_main(&app) {
                let _ = window.set_always_on_top(false);
            }
            Err(e.to_string())
        }
        Ok(()) => {
            // 安装完整结束后才重启（NSIS 拉起新版本）。
            app.restart();
        }
    }
}

/// 窗口底色跟随时段天空色（前端每次时段变化时调用），'''
assert anchor in s
s = s.replace(anchor, new_cmds, 1)

# ---- 5) Builder：manage 状态 + 注册命令 ----
old = '''    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_window_bg])'''
new = '''    tauri::Builder::default()
        .manage(UpdaterState { pending: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![set_window_bg, check_update, start_update_download])'''
assert old in s
s = s.replace(old, new, 1)

# ---- 6) 托盘「检查更新」→ 事件化检查 ----
old = '''                    "check_update" => check_for_update(app.clone(), true),'''
new = '''                    "check_update" => {
                        let update_app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = update_app.state::<UpdaterState>();
                            let _ = run_check(&update_app, &state, true).await;
                        });
                    }'''
assert old in s
s = s.replace(old, new, 1)

# ---- 7) 启动静默检查 → 事件化 ----
old = '''                check_for_update(handle, false);'''
new = '''                {
                    let silent_app = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = silent_app.state::<UpdaterState>();
                        let _ = run_check(&silent_app, &state, false).await;
                    });
                }'''
assert old in s
s = s.replace(old, new, 1)

io.open("lib.rs", "w", encoding="utf-8", newline="").write(s)
print("RUST_OK")
