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

    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                200_000, // 20ms（100ns 单位）
                0,
                &format,
                None,
            )
            .map_err(|e| format!("初始化进程回环失败：{e}"))?;
    }

    let capture: IAudioCaptureClient = unsafe { client.GetService() }
        .map_err(|e| format!("获取采集接口失败：{e}"))?;
    unsafe { client.Start() }.map_err(|e| format!("启动采集失败：{e}"))?;

    let mut scratch: Vec<i16> = Vec::with_capacity(4096);
    while !stop.load(Ordering::SeqCst) {
        let packet = match unsafe { capture.GetNextPacketSize() } {
            Ok(size) => size,
            Err(_) => break,
        };
        if packet == 0 {
            // 静音期没有包：短睡眠再看（进程回环不触发事件）
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut frames = 0u32;
        let mut flags = 0u32;
        if unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }.is_err()
        {
            break;
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

        let mut out: Vec<(u32, String)> = Vec::new();
        for i in 0..count {
            let Ok(control) = sessions.GetSession(i) else { continue };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
            let Ok(pid) = control2.GetProcessId() else { continue };
            if pid == 0 {
                continue; // 系统声音（System Sounds）没有进程
            }
            // 只听正在出声的：静音/挂起的会话没必要列出来
            let mut loud = true;
            if let Ok(meter) = control.cast::<IAudioMeterInformation>() {
                if let Ok(peak) = meter.GetPeakValue() {
                    loud = peak > 0.0005;
                }
            }
            if !loud {
                continue;
            }
            if out.iter().any(|(p, _)| *p == pid) {
                continue;
            }
            let name = process_name(pid).unwrap_or_else(|| format!("进程 {pid}"));
            out.push((pid, name));
        }
        out.sort_by(|a, b| a.1.cmp(&b.1));
        Ok(out)
    }
}

/// 取进程可执行文件名（不带路径），拿不到就返回 None。
fn process_name(pid: u32) -> Option<String> {
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
