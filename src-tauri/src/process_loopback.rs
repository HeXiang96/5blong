//! 进程级系统声音采集（Windows 10 2004 / build 19041+）。
//!
//! 为什么需要它：现有的 `loopback.rs` 采的是**默认播放设备的整机混音**，
//! 里面包含我们自己播出去的房间语音。观众于是听到两遍同一声话
//! （P2P 语音一次 + 共享音频里一次）——就是"共享屏幕有回声"。
//!
//! 这里用 `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` 的 **EXCLUDE 模式**：
//! 整机混音减去"本应用进程树"。WebView2 是我们进程的子进程，所以
//! 房间语音（由 WebView2 渲染）天然被排除，而游戏/浏览器/音乐全都在——
//! 共享整个桌面也成立，不需要用户去挑某个应用。
//!
//! 失败（老系统、被策略禁用）时返回 Err，调用方回退到整机回环。

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use windows::core::{implement, Interface, Ref, Result as WinResult};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_BLOB;

/// COM 完成回调：只用来把"激活完成"这件事唤醒主线程。
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Completion {
    done: Arc<(Mutex<bool>, Condvar)>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> WinResult<()> {
        let (lock, cv) = &*self.done;
        let mut finished = lock.lock().unwrap();
        *finished = true;
        cv.notify_all();
        Ok(())
    }
}

/// 按 pid 打开进程级回环客户端；exclude=true 表示"整机混音 − 该进程树"。
pub fn open_process_loopback(pid: u32, exclude: bool) -> Result<IAudioClient, String> {
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: if exclude {
                    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                } else {
                    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                },
            },
        },
    };

    /*
     * PROPVARIANT 用 VT_BLOB 承载上面那坨参数（Windows 官方示例的做法）。
     * ⚠️ 必须用 CoTaskMemAlloc 分配：PROPVARIANT 析构时会调 PropVariantClear，
     * 对 VT_BLOB 它会 CoTaskMemFree(pBlobData)。之前指向栈变量，
     * 结果退出时堆损坏（0xc0000374 STATUS_HEAP_CORRUPTION，实测踩过）。
     */
    let size = std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>();
    let blob_mem = unsafe {
        windows::Win32::System::Com::CoTaskMemAlloc(size)
            as *mut AUDIOCLIENT_ACTIVATION_PARAMS
    };
    if blob_mem.is_null() {
        return Err("分配激活参数失败".into());
    }
    unsafe { blob_mem.write(params) };

    let mut pv = PROPVARIANT::default();
    unsafe {
        let inner = &mut *pv.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob.cbSize = size as u32;
        inner.Anonymous.blob.pBlobData = blob_mem as *mut u8;
    }

    let done = Arc::new((Mutex::new(false), Condvar::new()));
    let handler: IActivateAudioInterfaceCompletionHandler = Completion { done: done.clone() }.into();

    let op = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&pv as *const PROPVARIANT as *const _),
            &handler,
        )
    }
    .map_err(|e| format!("激活进程回环失败：{e}"))?;

    // 等激活完成（最多 3 秒，避免卡死）
    {
        let (lock, cv) = &*done;
        let finished = lock.lock().unwrap();
        let (finished, timeout) = cv
            .wait_timeout_while(finished, Duration::from_secs(3), |f| !*f)
            .unwrap();
        if !*finished {
            let _ = timeout;
            return Err("激活进程回环超时".into());
        }
    }

    let mut hr = windows::Win32::Foundation::S_OK;
    let mut iface: Option<windows::core::IUnknown> = None;
    unsafe { op.GetActivateResult(&mut hr, &mut iface) }
        .map_err(|e| format!("读取激活结果失败：{e}"))?;
    hr.ok().map_err(|e| format!("激活进程回环被拒绝：{e}"))?;
    let iface = iface.ok_or_else(|| "激活结果为空".to_string())?;
    iface
        .cast::<IAudioClient>()
        .map_err(|e| format!("拿到 IAudioClient 失败：{e}"))
}

/// 采集循环：把 PCM 转成 i16 小端字节，交给 `on_pcm`（由调用方切块/编码）。
pub fn run_capture(
    stop: Arc<AtomicBool>,
    mut on_pcm: impl FnMut(&[i16]) -> bool,
) -> Result<(), String> {
    run_capture_with(std::process::id(), true, stop, &mut on_pcm)
}

/// 同 `run_capture`，但可指定 pid 与"包含/排除"（诊断用）。
pub fn run_capture_with(
    pid: u32,
    exclude: bool,
    stop: Arc<AtomicBool>,
    on_pcm: &mut dyn FnMut(&[i16]) -> bool,
) -> Result<(), String> {
    unsafe {
        // 进程回环需要 MTA
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
    }

    let client = open_process_loopback(pid, exclude)?;

    // 固定 48k / 立体声 / 16bit；AUTOCONVERTPCM 让音频引擎替我们重采样
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: 2,
        nSamplesPerSec: 48_000,
        nAvgBytesPerSec: 48_000 * 4,
        nBlockAlign: 4,
        wBitsPerSample: 16,
        cbSize: 0,
    };

    /*
     * 进程回环用的是虚拟端点（VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK），
     * 它对 `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` 的支持**因系统版本而异**：
     * 有的机器（尤其 Win10 2004~20H2）带上这两个标志会直接返回
     * E_INVALIDARG，而裸 LOOPBACK 标志能正常初始化。
     * 以前只有一种写法，失败就整条进程级路径不可用（表现为"共享没声音"）。
     * 现在按"先要自动转换、不行就不要"降级重试，两种情况都能跑起来。
     */
    let base_flags = AUDCLNT_STREAMFLAGS_LOOPBACK;
    let convert_flags =
        base_flags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    let mut last_error = String::new();
    let mut initialized = false;
    unsafe {
        for flags in [convert_flags, base_flags] {
            match client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                flags,
                200_000, // 20ms（100ns 单位），与微软 ApplicationLoopback 示例一致
                0,
                &format,
                None,
            ) {
                Ok(()) => {
                    log::info!("[process-loopback] 初始化成功（flags=0x{flags:X}）");
                    initialized = true;
                    break;
                }
                Err(err) => {
                    last_error = format!("{err}");
                    log::warn!("[process-loopback] Initialize(flags=0x{flags:X}) 失败：{err}");
                }
            }
        }
    }
    if !initialized {
        return Err(format!("初始化进程回环失败：{last_error}"));
    }

    let capture: IAudioCaptureClient = unsafe { client.GetService() }
        .map_err(|e| format!("获取采集接口失败：{e}"))?;
    unsafe { client.Start() }.map_err(|e| format!("启动采集失败：{e}"))?;

    let mut scratch: Vec<i16> = Vec::with_capacity(4096);
    while !stop.load(Ordering::SeqCst) {
        /*
         * ⚠ 这里**不能** `break`。
         *
         * 以前两处都是 `Err(_) => break`，函数于是返回 `Ok(())`；而调用方
         * （loopback.rs 的 capture_loop）把 `Ok(Ok(()))` 当成"采完了、正常退出"，
         * 直接 return——既不回退整机回环，也不给页面发任何错误。
         * 结果就是：设备被禁用/端点被切走/会话结束时，采集线程**无声死亡**，
         * 用户看到的是"共享画面正常、一点声音没有、也没有任何提示"。
         * 采集循环出错必须当成真错误抛出去，让上层走回退或报错。
         */
        let packet = match unsafe { capture.GetNextPacketSize() } {
            Ok(size) => size,
            Err(err) => return Err(format!("读取回环包长度失败：{err}")),
        };
        if packet == 0 {
            // 静音期没有包：短睡眠再看（进程回环不触发事件）
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut frames = 0u32;
        let mut flags = 0u32;
        if let Err(err) = unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
        {
            return Err(format!("取回环音频缓冲失败：{err}"));
        }
        // AUDCLNT_BUFFERFLAGS_SILENT = 0x2：该包内容是静音，data 可能为空
        let silent = flags & 0x2 != 0;
        scratch.clear();
        if !silent && !data.is_null() && frames > 0 {
            let samples = (frames * 2) as usize; // 2ch i16
            let slice = unsafe { std::slice::from_raw_parts(data as *const i16, samples) };
            scratch.extend_from_slice(slice);
        } else if frames > 0 {
            scratch.resize((frames * 2) as usize, 0);
        }
        let _ = unsafe { capture.ReleaseBuffer(frames) };
        if !scratch.is_empty() && !on_pcm(&scratch) {
            break;
        }
    }
    let _ = unsafe { client.Stop() };
    Ok(())
}

/// 列出当前正在出声的音频会话（进程 id + 可执行名）。
///
/// 用途：UI 上让用户挑"只采集这个应用的声音"（INCLUDE 模式），
/// 这样通知音、音乐、浏览器里的杂音都不会混进共享音频。
pub fn list_audio_sessions() -> Result<Vec<(u32, String)>, String> {
    Ok(audio_sessions()?
        .into_iter()
        .map(|(pid, name, _peak)| (pid, name))
        .collect())
}

/// 正在出声的音频会话：`(pid, 进程名, 峰值)`。静音/挂起的会话不返回。
///
/// 峰值是**选目标进程**的关键：进程回环的 `TargetProcessId` 实测只匹配
/// **精确的那一个 pid**（`_TREE` 后缀在 Win11 26300 上没实现成树，两个方向都验过），
/// 所以同一个应用如果有多个子进程都可能出声，必须挑**正在出声**的那个，
/// 而不是"窗口属于哪个进程"。
pub fn audio_sessions() -> Result<Vec<(u32, String, f32)>, String> {
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("创建设备枚举器失败：{e}"))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("取默认播放设备失败：{e}"))?;
        let manager: IAudioSessionManager2 = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("取会话管理器失败：{e}"))?;
        let sessions = manager
            .GetSessionEnumerator()
            .map_err(|e| format!("枚举会话失败：{e}"))?;
        let count = sessions.GetCount().map_err(|e| e.to_string())?;

        let mut out: Vec<(u32, String, f32)> = Vec::new();
        for i in 0..count {
            let Ok(control) = sessions.GetSession(i) else { continue };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
            let Ok(pid) = control2.GetProcessId() else { continue };
            if pid == 0 {
                continue; // 系统声音（System Sounds）没有进程
            }
            // 只听正在出声的：静音/挂起的会话没必要列出来
            let mut peak = 1.0f32;
            if let Ok(meter) = control.cast::<IAudioMeterInformation>() {
                if let Ok(value) = meter.GetPeakValue() {
                    peak = value;
                }
            }
            if peak <= 0.0005 {
                continue;
            }
            // 同一进程可能有多条会话：取最响的那条
            if let Some(existing) = out.iter_mut().find(|item| item.0 == pid) {
                if peak > existing.2 {
                    existing.2 = peak;
                }
                continue;
            }
            let name = process_name(pid).unwrap_or_else(|| format!("进程 {pid}"));
            out.push((pid, name, peak));
        }
        out.sort_by(|a, b| a.1.cmp(&b.1));
        Ok(out)
    }
}

/// 全量父子表（一次快照）。用于判断"某个 pid 是不是某进程的子孙"。
fn parent_table() -> std::collections::HashMap<u32, u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut table = std::collections::HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return table;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                table.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    table
}

/// `pid` 是否就是 `root`，或者位于 `root` 的子树里。
///
/// 为什么需要它：进程回环的 `TargetProcessId` **不认子树**（实测见 `exclude_target`），
/// 于是我们得自己算出"谁属于谁"，再把精确的 pid 递给 API。
pub fn in_subtree(pid: u32, root: u32) -> bool {
    if pid == root {
        return true;
    }
    let table = parent_table();
    let mut current = pid;
    // 进程树深度很小，64 层足够，同时防环
    for _ in 0..64 {
        match table.get(&current) {
            Some(parent) if *parent != 0 => {
                if *parent == root {
                    return true;
                }
                current = *parent;
            }
            _ => return false,
        }
    }
    false
}

/// 在"正在出声"的会话里挑峰值最大的一个（只考虑 `accept` 认可的 pid）。
fn loudest_session(accept: impl Fn(u32) -> bool) -> Option<(u32, String, f32)> {
    audio_sessions()
        .ok()?
        .into_iter()
        .filter(|(pid, _, _)| accept(*pid))
        .max_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal))
}

/// 某个应用（按窗口/进程 pid 定位）**真正在出声**的那个进程。
///
/// 窗口所属进程往往不是出声进程：Edge / WebView2 的音频由 browser 的子进程渲染。
/// 而进程回环只认精确 pid，所以必须先把范围缩到这个应用子树里"正在出声"的进程。
/// 找不到（该应用此刻没出声）返回 None，调用方退回用原 pid。
pub fn audio_pid_for(app_pid: u32) -> Option<u32> {
    loudest_session(|pid| pid == app_pid || in_subtree(pid, app_pid)).map(|(pid, _, _)| pid)
}

/// 取进程可执行文件名（不带路径），拿不到就返回 None。
///
/// 公开是为了**排障**：采集日志里要写清"排除了哪个进程"。
/// 2026-10-27 出现"排除模式下仍然听到自己人声"，只看 pid 根本判断不出
/// 排除的到底是 msedgewebview2（我们要的）还是别的进程。
pub fn process_name(pid: u32) -> Option<String> {
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        ok.ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        Some(path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string())
    }
}

// ------------------------------------------------------- 更精确的"排除对象"
//
// 共享整个桌面时用的是 EXCLUDE 模式：整机混音 − 某个进程。
//
// 演进过程（每一版都是被真实故障推着改的，别退回旧写法）：
// ① 最早排除 app.exe（Tauri 主进程）——但语音是 WebView2 渲染的，
//    它是不是 app.exe 的子孙取决于进程拓扑，漏掉就整段回声；
// ② 改成排除 msedgewebview2 的 **browser 进程树**，以为"排掉树等于排掉所有子进程"；
// ③ 2026-10-27 实测发现 **`_TREE` 根本不排子树**（见 `exclude_target` 的表格），
//    browser 被排掉了、它的子进程还在出声 → 回声照旧。
//    现在改为**按"谁在出声"精确排除**，不依赖任何树语义。

/// 枚举某个进程的直接子进程。
pub fn child_processes(parent: u32) -> Vec<(u32, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut out: Vec<(u32, String)> = Vec::new();
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(handle) => handle,
            Err(_) => return out,
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ParentProcessID == parent {
                    let name = String::from_utf16_lossy(&entry.szExeFile)
                        .trim_end_matches('\0')
                        .to_string();
                    out.push((entry.th32ProcessID, name));
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    out
}

/// WebView2 的 browser 进程（我们窗口的渲染与音频都在它的树里）。
///
/// 判据：父进程是我们的 app.exe，且可执行名是 msedgewebview2.exe。
/// WebView2 只会为每个窗口起一个 browser 进程，所以这里通常恰好命中一个；
/// 命中失败（极老版本、进程树未建立）就返回 None，调用方退回排除自身。
pub fn webview_browser_process() -> Option<u32> {
    let me = std::process::id();
    child_processes(me)
        .into_iter()
        .find(|(_, name)| name.eq_ignore_ascii_case("msedgewebview2.exe"))
        .map(|(pid, _)| pid)
}

/// 整机采集时要排除的进程（连同用于展示/日志的标签）。
///
/// ⚠️ **必须挑"正在出声的那个进程"，不能挑"browser 根进程"。**
///
/// 进程回环的 `TargetProcessId` 实测只匹配**精确的那一个 pid**：
/// `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` 里的 `_TREE` 在
/// Win11 26300 上并没有实现成"排除子树"——用真实 WASAPI 输出流做的对照实验
/// （`outputs/exclude_tree_probe.py`，父链已打印确认是子孙关系）结果：
///
/// | 目标 | 峰值 |
/// |---|---|
/// | INCLUDE 精确的出声进程 | 0.600 |
/// | EXCLUDE 它的**祖先** | **0.600** ← 子孙没被排掉 |
/// | INCLUDE 它的**祖先** | 0.000 ← 祖先也采不到子孙 |
///
/// 于是"排除 msedgewebview2 的 browser 进程"等于**什么都没排**——房间语音是它的
/// 子进程渲染的，整段留在采集流里，观端就听到"同一句话两遍"（2026-10-27 实测回声）。
///
/// 所以这里先问"我方哪个进程正在出声"（`IAudioMeterInformation` 的峰值），
/// 把它排除掉；挑不到（此刻没人说话）才退回老的 browser / 自身兜底。
pub fn exclude_target() -> (u32, &'static str) {
    let me = std::process::id();
    if let Some((pid, name, peak)) = loudest_session(|candidate| candidate != me && in_subtree(candidate, me)) {
        log::info!("[process-loopback] 排除目标 = 我方出声进程 {pid}({name}) 峰值 {peak:.3}");
        // 标签仍用 "webview"：前端那句提示是"整机声音，已排除本应用语音"，
        // 现在这句话终于是事实。精确 pid/进程名看上面的日志。
        return (pid, "webview");
    }
    log::info!("[process-loopback] 我方此刻没有出声的会话，退回按 browser 进程排除");
    match webview_browser_process() {
        Some(pid) => (pid, "webview"),
        None => (me, "self"),
    }
}

/// 同 run_capture，但排除指定进程树（而不是固定排除自身）。
pub fn run_capture_excluding(
    exclude_pid: u32,
    stop: Arc<AtomicBool>,
    on_pcm: impl FnMut(&[i16]) -> bool,
) -> Result<(), String> {
    let mut sink = on_pcm;
    run_capture_with(exclude_pid, true, stop, &mut sink)
}

// ------------------------------------------------------------- 共享源 → 进程
//
// 共享具体窗口时，Chromium 的 track.label 通常就是被共享窗口的标题。
// 用它反查窗口所属进程，就能改成 INCLUDE 模式**只采那个程序的声音**：
// 房间语音由我们自己的 WebView2 渲染，从原理上不可能混进来。
// 这就是 Oopz 那种"只共享当前应用声音"。

/// 枚举"有标题的可见顶层窗口"：返回 (pid, 标题)。
pub fn list_window_titles() -> Vec<(u32, String)> {
    // windows 0.62 起 BOOL 在 windows::core，不在 Win32::Foundation（CI 实测 E0432）
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // Rust 2024 起 unsafe fn 体内也要显式 unsafe 块（CI 警告 unsafe_op_in_unsafe_fn）
        unsafe {
            let out = &mut *(lparam.0 as *mut Vec<(u32, String)>);
            if IsWindowVisible(hwnd).as_bool() {
                let len = GetWindowTextLengthW(hwnd);
                if len > 0 {
                    let mut buf = vec![0u16; len as usize + 1];
                    let copied = GetWindowTextW(hwnd, &mut buf);
                    if copied > 0 {
                        let title = String::from_utf16_lossy(&buf[..copied as usize]);
                        if !title.trim().is_empty() {
                            let mut pid = 0u32;
                            GetWindowThreadProcessId(hwnd, Some(&mut pid));
                            if pid != 0 {
                                out.push((pid, title));
                            }
                        }
                    }
                }
            }
        }
        BOOL(1) // 继续枚举下一个窗口
    }

    let mut found: Vec<(u32, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

/// 归一化：只留字母数字并转小写（中文原样保留），便于标题比对。
fn normalize_title(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 从共享源 label 反查窗口进程，返回 (pid, 窗口标题)。
///
/// label 形态在不同内核上不一致：可能是纯标题，也可能是 `window:12345:0`
/// 这种源 id。源 id 里没有可读标题时返回 None，上层退回"整机 − 本应用"。
pub fn pid_for_share_label(label: &str) -> Option<(u32, String)> {
    let raw = label.trim();
    if raw.is_empty() {
        return None;
    }
    let stripped = raw
        .strip_prefix("window:")
        .or_else(|| raw.strip_prefix("tab:"))
        .or_else(|| raw.strip_prefix("screen:"))
        .unwrap_or(raw)
        .trim();
    let cleaned = match stripped.rsplit_once(':') {
        Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => head,
        _ => stripped,
    };
    let want = normalize_title(cleaned);
    if want.chars().count() < 3 {
        return None; // 太短，容易误配
    }

    let me = std::process::id();
    let mut best: Option<(u32, String, usize)> = None;
    for (pid, title) in list_window_titles() {
        if pid == me {
            continue; // 永远不锁自己
        }
        let have = normalize_title(&title);
        if have.is_empty() {
            continue;
        }
        // 双向包含：窗口标题常带后缀（" - 记事本"、"- Google Chrome"），
        // 而 label 可能是截断后的标题
        if !(have == want || have.contains(&want) || want.contains(&have)) {
            continue;
        }
        let score = have.chars().count().min(want.chars().count());
        if best.as_ref().map(|(_, _, s)| score > *s).unwrap_or(true) {
            best = Some((pid, title, score));
        }
    }
    best.map(|(pid, title, _)| (pid, title))
}
