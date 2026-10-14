//! 内置系统声音采集（Windows WASAPI 回环）。
//!
//! 为什么要它：浏览器的"共享系统音频"在**多声道播放设备**（7.1/8ch 游戏声卡、
//! 虚拟声卡）上拿不到回环流——Chromium 对回环端点的格式要求死板，格式对不上
//! 就直接把音频轨结束掉。而 Windows 的 WASAPI 本身支持任意声道的回环
//! （Oopz/Discord/OBS 这些原生软件都这么干），加上
//! `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` 后还能让音频引擎自动把 8ch/44.1k
//! 转成我们要的 2ch/48k。
//!
//! 所以桌面客户端在 Rust 侧自己采：默认渲染设备 → 回环 → 下混成立体声
//! → base64(i16) 经 Tauri Channel 流给页面 → 页面用 AudioWorklet 播进
//! `MediaStreamAudioDestinationNode`，与 `getDisplayMedia` 的画面轨合并发布。
//! 网页版没有这条路（浏览器安全边界），只能提示用户换设备或改用客户端。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use tauri::ipc::Channel;
use tauri::{Emitter, State};

/// 一个正在跑的采集 worker：停止标志 + 线程句柄。
struct LoopbackWorker {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// 全局最多一个采集 worker（共享一次只有一路系统声音）。
#[derive(Default)]
pub struct LoopbackState {
    worker: Mutex<Option<LoopbackWorker>>,
}

/// 启动成功后回给前端的参数（页面要按这个采样率建 AudioContext）。
#[derive(Clone, serde::Serialize)]
pub struct LoopbackStart {
    pub sample_rate: u32,
    pub channels: u32,
}

/// 停掉现有 worker（置停止标志并等线程退出；线程每轮最多 20ms 检查一次）。
fn stop_worker(state: &LoopbackState) {
    let worker = state.worker.lock().unwrap().take();
    if let Some(worker) = worker {
        worker.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = worker.thread {
            let _ = thread.join();
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::VecDeque;

    /// 采集循环：默认渲染设备 → 回环 → 立体声 f32 → i16 → base64 → Channel。
    /// 每块 ~43ms（2048 帧），前端 AudioWorklet 缓冲后按采样节拍播出去。
    fn capture_loop(
        stop: Arc<AtomicBool>,
        on_chunk: Channel<String>,
        _app: tauri::AppHandle,
    ) -> Result<(), String> {
        use wasapi::{Direction, SampleType, ShareMode, WaveFormat};

        wasapi::initialize_mta().map_err(|e| e.to_string())?;
        let device = wasapi::get_default_device(&Direction::Render).map_err(|e| e.to_string())?;
        let mut audio_client = device.get_iaudioclient().map_err(|e| e.to_string())?;
        // 目标格式固定：立体声 f32 @48k。convert=true 打开
        // AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM，音频引擎会自动把端点的
        // 8ch/44.1k 等混合格式转成它——浏览器缺的就是这一步。
        let desired = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);
        let blockalign = desired.get_blockalign() as usize;
        let (default_period, _min_period) = audio_client.get_periods().map_err(|e| e.to_string())?;
        // 设备是 Render、方向传 Capture：wasapi 会自动加上
        // AUDCLNT_STREAMFLAGS_LOOPBACK（见 wasapi::api 的 initialize_client）。
        audio_client
            .initialize_client(
                &desired,
                default_period,
                &Direction::Capture,
                &ShareMode::Shared,
                true,
            )
            .map_err(|e| e.to_string())?;
        let h_event = audio_client.set_get_eventhandle().map_err(|e| e.to_string())?;
        let capture = audio_client.get_audiocaptureclient().map_err(|e| e.to_string())?;
        audio_client.start_stream().map_err(|e| e.to_string())?;

        const CHUNK_FRAMES: usize = 2048; // ~43ms @48k
        let chunk_bytes = CHUNK_FRAMES * blockalign;
        let mut queue: VecDeque<u8> = VecDeque::new();
        let mut pcm: Vec<i16> = Vec::with_capacity(CHUNK_FRAMES * 2);

        while !stop.load(Ordering::SeqCst) {
            capture
                .read_from_device_to_deque(blockalign, &mut queue)
                .map_err(|e| e.to_string())?;
            while queue.len() >= chunk_bytes {
                let mut chunk = Vec::with_capacity(chunk_bytes);
                for _ in 0..chunk_bytes {
                    chunk.push(queue.pop_front().unwrap_or(0));
                }
                pcm.clear();
                for frame in chunk.chunks_exact(4) {
                    let value = f32::from_ne_bytes([frame[0], frame[1], frame[2], frame[3]]);
                    pcm.push((value.clamp(-1.0, 1.0) * 32767.0) as i16);
                }
                let bytes: Vec<u8> = pcm.iter().flat_map(|v| v.to_le_bytes()).collect();
                let payload = base64::engine::general_purpose::STANDARD.encode(&bytes);
                // 页面关了/停播了（Channel 被回收）就顺势退出线程
                if on_chunk.send(payload).is_err() {
                    let _ = audio_client.stop_stream();
                    return Ok(());
                }
            }
            // 静音期不会有回环事件，这里按 20ms 超时轮询一次（顺便检查停止标志）
            let _ = h_event.wait_for_event(200_000);
        }
        let _ = audio_client.stop_stream();
        Ok(())
    }

    /// 启动回环采集（重复调用会先停掉旧的）。返回前端建 AudioContext 所需参数。
    #[tauri::command]
    pub fn start_loopback_capture(
        app: tauri::AppHandle,
        state: State<'_, LoopbackState>,
        on_chunk: Channel<String>,
    ) -> Result<LoopbackStart, String> {
        // 先停旧的（不持锁 join，避免长时间占住状态锁）
        let existing = state.worker.lock().unwrap().take();
        if let Some(worker) = existing {
            worker.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = worker.thread {
                let _ = thread.join();
            }
        }

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_app = app.clone();
        let handle = std::thread::Builder::new()
            .name("loopback-capture".into())
            .spawn(move || {
                if let Err(err) = capture_loop(thread_stop, on_chunk, thread_app.clone()) {
                    log::warn!("[loopback] 采集线程异常退出：{err}");
                    let _ = thread_app.emit(
                        "loopback:error",
                        format!("系统声音采集中断（画面不受影响）：{err}"),
                    );
                }
            })
            .map_err(|e| format!("无法启动采集线程：{e}"))?;
        *state.worker.lock().unwrap() = Some(LoopbackWorker {
            stop,
            thread: Some(handle),
        });
        Ok(LoopbackStart { sample_rate: 48_000, channels: 2 })
    }

    /// 停止回环采集（停播时调用；重复调用安全）。
    #[tauri::command]
    pub fn stop_loopback_capture(state: State<'_, LoopbackState>) -> Result<(), String> {
        stop_worker(&state);
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    #[tauri::command]
    pub fn start_loopback_capture() -> Result<LoopbackStart, String> {
        Err("内置系统声音采集仅支持 Windows 客户端".into())
    }

    #[tauri::command]
    pub fn stop_loopback_capture() -> Result<(), String> {
        Ok(())
    }
}

pub use imp::*;
