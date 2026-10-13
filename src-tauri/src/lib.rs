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

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

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

/// 检查更新并询问安装（更新包来自 GitHub Releases，minisign 签名校验由插件完成）。
///
/// `manual`：true 来自托盘「检查更新」，失败 / 已是最新都要弹窗告知；
/// false 为启动后的静默检查，只在确实有新版本时才打扰用户。
fn check_for_update(app: tauri::AppHandle, manual: bool) {
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else {
            if manual {
                update_message_blocking(&app, "检查更新失败", "更新器初始化失败（配置缺失）。".into());
            }
            return;
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let mut dialog = app
                    .dialog()
                    .message(format!(
                        "发现新版本 v{}（当前 v{}），要立即下载并安装吗？\n\n更新自动进行，完成后 5blong 会自动重启。",
                        update.version, update.current_version
                    ))
                    .title("5blong 更新")
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "立即更新".into(),
                        "稍后再说".into(),
                    ));
                // 挂到主窗口上并置前：保证启动时就能看到更新提示。
                if let Some(window) = front_main(&app) {
                    dialog = dialog.parent(&window);
                }
                let confirmed = dialog.blocking_show();
                if !confirmed {
                    return;
                }
                // 进度回调留空：安装包只有几 MB，秒级完成，不值得再弹一层窗。
                if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                    update_message_blocking(&app, "更新失败", format!("下载或安装出错：{e}"));
                } else {
                    // 不返回：重启进程，由 NSIS 安装完成后拉起新版本。
                    app.restart();
                }
            }
            Ok(None) => {
                if manual {
                    update_message_blocking(
                        &app,
                        "检查更新",
                        format!("当前已是最新版本（v{}）。", app.package_info().version),
                    );
                }
            }
            Err(e) => {
                if manual {
                    update_message_blocking(&app, "检查更新失败", format!("无法连接更新源：{e}"));
                }
            }
        }
    });
}

/// 简单的信息弹窗（阻塞到用户关闭为止；只从异步线程调用）。
/// 同样挂主窗口当 owner 并置前，避免被主窗口挡住。
fn update_message_blocking(app: &tauri::AppHandle, title: &str, text: String) {
    let mut dialog = app
        .dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Info);
    if let Some(window) = front_main(app) {
        dialog = dialog.parent(&window);
    }
    dialog.blocking_show();
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
    tauri::Builder::default()
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

            // ---- 托盘 ----
            let show_item = MenuItem::with_id(app, "show", "显示 5blong", true, None::<&str>)?;
            let update_item = MenuItem::with_id(app, "check_update", "检查更新", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &update_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .tooltip(format!("5blong v{}", app.package_info().version))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "check_update" => check_for_update(app.clone(), true),
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
                check_for_update(handle, false);
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
