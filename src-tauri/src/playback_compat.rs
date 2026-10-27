//! 播放兼容模式：关闭 WebView2 的**硬件视频解码**。
//!
//! 为什么需要它
//! ------------
//! 观端出现过「解码器每秒都在出帧、码率正常，画面却全黑」的故障
//! （实测读数：`1920×1088 · 32fps · 5226 kbps · H264 D3D11VideoDecoder 硬解 · 直连`）。
//! 浏览器里**没有**运行时关闭硬件解码的 API——WebCodecs 的 `hardwareAcceleration`
//! 只作用于 WebCodecs，不影响 WebRTC 内部的解码路径；`RTCRtpReceiver` 也没有开关。
//! 唯一可靠的手段是给 WebView2 传启动参数 `--disable-accelerated-video-decode`。
//!
//! 为什么做成"落盘开关 + 下次启动生效"
//! ---------------------------------
//! 启动参数只在进程起来那一刻有意义，运行期改不了。所以：观端检测到黑屏
//! （见前端 `video-health.ts`）就写这个标记，并提示用户重启一次；
//! 设置面板里可以随时关掉。
//!
//! ⚠️ 千万不要改用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量：
//! wry 总是显式调用 `CreateCoreWebView2EnvironmentWithOptions`，而 WebView2 的
//! 规则是 **API 参数覆盖环境变量**，实测无效（见 `lib.rs` 里 `run()` 顶部的说明，
//! 2026-10-16 已经踩过一次）。必须走 `additional_browser_args`。
//!
//! 代价
//! ----
//! 软解 1080p60 H.264 大约吃掉 5–10% 单核，画质**不受影响**（解码是确定性的）。
//! 所以这只是"某台机器硬解坏了"的兜底，不该给所有人默认打开。

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// 标记文件名（存在 = 开启兼容模式）。放在 app_config_dir 下。
const FLAG_FILE: &str = "playback-soft-decode";

fn flag_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FLAG_FILE))
}

/// 当前是否开启兼容模式（读标记文件）。读不到目录时按"关闭"处理。
pub fn soft_decode(app: &AppHandle) -> bool {
    flag_path(app).map(|path| path.exists()).unwrap_or(false)
}

fn set(app: &AppHandle, on: bool) -> Result<(), String> {
    let path = flag_path(app).ok_or_else(|| "取不到应用配置目录".to_string())?;
    if on {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
        }
        std::fs::write(&path, b"1").map_err(|e| format!("写入兼容模式标记失败：{e}"))?;
        log::info!("[playback] 已开启兼容模式（关闭硬件视频解码），下次启动生效");
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("移除兼容模式标记失败：{e}"))?;
        log::info!("[playback] 已关闭兼容模式，下次启动恢复硬件解码");
    }
    Ok(())
}

/// 前端查询：兼容模式是否已开启（用于设置面板显示"已开启，重启生效"）。
#[tauri::command]
pub fn get_playback_compat(app: AppHandle) -> Result<bool, String> {
    Ok(soft_decode(&app))
}

/// 前端写入：开启 / 关闭兼容模式。
///
/// 参数名在 JS 侧是 camelCase（`softDecode`），Tauri 会自动映射到 snake_case，
/// 与其它命令（`onlyPid` → `only_pid`）一致。
#[tauri::command]
pub fn set_playback_compat(app: AppHandle, soft_decode: bool) -> Result<(), String> {
    set(&app, soft_decode)
}

/// 给 WebView2 追加的启动参数（不含 wry 默认那些，调用方自行拼接）。
pub fn extra_browser_args(app: &AppHandle) -> &'static str {
    if soft_decode(app) {
        " --disable-accelerated-video-decode"
    } else {
        ""
    }
}
