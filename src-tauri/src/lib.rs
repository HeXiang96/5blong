// 5blong 桌面端（Tauri 壳）。
//
// 能力清单：
//   - 单实例：第二次启动只聚焦已有窗口，不开新进程（tauri-plugin-single-instance）。
//   - 托盘常驻：左键点托盘显示窗口；右键菜单「显示 5blong / 检查更新 / 退出」。
//   - 点窗口右上角 ×：不退出，隐藏到托盘，语音继续（CloseRequested 里 prevent_close + hide）。
//   - 真正退出只走托盘「退出」（app.exit 会直接结束，不再被关窗拦截）。
//
// 前端与网页版是同一份 dist-web，由 Tauri 内置的本地安全协议（tauri.localhost）提供，
// 它是 secure context，WASM（RNNoise）可正常 fetch。

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 内置系统声音采集（Windows WASAPI 回环）：浏览器在多声道播放设备上
/// 拿不到系统音频，客户端在 Rust 侧自己采后喂给页面随共享发布。
mod loopback;
/// 进程级系统声音采集（Win10 2004+）：共享桌面时排除本应用，避免房间语音被采两遍。
#[cfg(windows)]
pub mod process_loopback;

/// 已发现、待用户确认下载的更新（确认后 start_update_download 取走）。
struct UpdaterState {
    pending: Mutex<Option<Update>>,
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

/// 窗口底色跟随时段天空色（前端每次时段变化时调用），
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

/// 检查更新（发事件，不弹原生框）：有新版发 update:available，
/// 手动检查的结果发 update:notice，启动静默检查只在新版时打扰。
async fn run_check(app: &tauri::AppHandle, state: &UpdaterState, manual: bool) -> Result<(), String> {
    // 只有手动检查才展示"检查中"；启动静默检查不打扰用户。
    if manual {
        let _ = app.emit(
            "update:phase",
            UpdatePhase { phase: "checking", message: None },
        );
    }
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
            // 复位前端阶段：即便静默检查，也让界面回到空闲（防御性）
            let _ = app.emit(
                "update:phase",
                UpdatePhase { phase: "idle", message: None },
            );
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
            let _ = app.emit(
                "update:phase",
                UpdatePhase { phase: "idle", message: None },
            );
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

/// 用户确认后开始下载安装：进度/阶段事件照发，安装完整结束后才重启。
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

/// 显示并聚焦主窗口（托盘菜单 / 单实例 / 托盘左键共用）。
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 弹窗前置准备：把主窗口带到前台，并把主窗口返回给调用方当对话框 owner。
/// 不设 owner 的原生对话框会被主窗口压在下面（用户实测踩过）。
fn front_main(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    let window = app.get_webview_window("main");
    if let Some(window) = &window {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    window
}

/// 阶段事件：安装中 / 出错（下载中的阶段由进度事件隐含）。
#[derive(Clone, serde::Serialize)]
struct UpdatePhase {
    phase: &'static str,
    message: Option<String>,
}

/// Windows/WebView2：自动放行页面的权限请求（主要是麦克风）。
///
/// 语义等价于浏览器扩展式的"一律允许"：getUserMedia 无需用户手动确认，
/// 让"创建语音房即开聊"不被打断。
/// 仅 Windows 编译，macOS/Linux 走各自的 WebView 权限机制。
#[cfg(windows)]
fn grant_webview2_permissions(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2,
            ICoreWebView2PermissionRequestedEventArgs,
            ICoreWebView2PermissionRequestedEventHandler,
            COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        };
        use webview2_com::PermissionRequestedEventHandler;

        let controller = webview.controller();
        let Ok(core): Result<ICoreWebView2, _> = controller.CoreWebView2() else {
            return;
        };

        let handler: ICoreWebView2PermissionRequestedEventHandler =
            PermissionRequestedEventHandler::create(Box::new(
                |_core: Option<ICoreWebView2>,
                 args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                    if let Some(args) = args {
                        // 麦克风 / 相机等媒体权限一律放行。
                        let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                    }
                    Ok(())
                },
            ));
        // 第二参是 EventRegistrationToken 出参，这里不需要持有，传空指针。
        let _ = core.add_PermissionRequested(&handler, std::ptr::null_mut());
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /*
     * 共享方切后台不掉帧（2026-10-16：最小化客户端后观众掉到 1fps）。
     * WebView2 默认对"不可见"的窗口做 Occlusion 判定并节流渲染/定时器。
     *
     * ⚠️ 传参必须走 additional_browser_args（API 参数）——之前用
     * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 环境变量注入是**无效**的：
     * wry 总是显式调用 CreateCoreWebView2EnvironmentWithOptions，
     * 而 WebView2 规则是 API 参数**覆盖**该环境变量（实测 1.5.4/1.5.5 未生效）。
     * 显式传参会替换 wry 默认参数串，所以必须把 wry 默认的三项合并进来。
     */
    let browser_args = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
         --disable-backgrounding-occluded-windows \
         --disable-background-timer-throttling \
         --disable-renderer-backgrounding";
    tauri::Builder::default()
        .manage(UpdaterState { pending: Mutex::new(None) })
        .manage(loopback::LoopbackState::default())
        .invoke_handler(tauri::generate_handler![
            set_window_bg,
            check_update,
            start_update_download,
            loopback::start_loopback_capture,
            loopback::stop_loopback_capture
        ])
        // 单实例必须在其它插件 / WebView 初始化之前注册。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // ---- 主窗口：改用 Builder 创建（窗口参数原在 tauri.conf.json），
            //      以便通过 additional_browser_args 传入防后台节流参数（见 run() 顶部说明）----
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("5blong")
                .inner_size(1080.0, 760.0)
                .min_inner_size(820.0, 600.0)
                .resizable(true)
                .center()
                .additional_browser_args(browser_args)
                .build()?;

            // ---- 托盘 ----
            let show_item = MenuItem::with_id(app, "show", "显示 5blong", true, None::<&str>)?;
            let feedback_item = MenuItem::with_id(app, "feedback", "意见反馈", true, None::<&str>)?;
            let update_item = MenuItem::with_id(app, "check_update", "检查更新", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &feedback_item, &update_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .tooltip(format!("5blong v{}", app.package_info().version))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "feedback" => {
                        // 先把窗口带到前台（用户可能从托盘直接发起），再让前端开弹窗
                        show_main(app);
                        let _ = app.emit("feedback:open", ());
                    }
                    "check_update" => {
                        let update_app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = update_app.state::<UpdaterState>();
                            let _ = run_check(&update_app, &state, true).await;
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击：显示并聚焦主窗口。
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;

            // Windows：自动授予麦克风等媒体权限（见函数说明）。
            #[cfg(windows)]
            grant_webview2_permissions(app.handle());

            // 启动后尽快静默检查一次更新（弹窗只在新版本真的存在时出现；
            // 有更新时主窗口会自动置前、弹窗挂主窗口 owner，不会被挡住）。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                {
                    let silent_app = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = silent_app.state::<UpdaterState>();
                        let _ = run_check(&silent_app, &state, false).await;
                    });
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // 点 ×：隐藏到托盘后台运行，语音保持；真正退出只走托盘「退出」。
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
