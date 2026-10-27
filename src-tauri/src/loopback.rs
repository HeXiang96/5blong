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
///
/// ⚠️ **必须 camelCase 序列化**。前端读的是 `info.sampleRate`，而这个字段原来叫
/// `sample_rate`（serde 默认按原名输出）——于是前端拿到的永远是 `undefined`，
/// `undefined !== 48000` 恒真，`startLoopbackOnce` 里那道"采样率校验"每次都会
/// `cleanup()`（= 调 stop_loopback_capture），采集线程刚初始化完就被掐死。
/// 表现就是：日志里"启动采集 → 初始化成功 → 采集线程正常结束"全在同一秒，
/// 观端从头到尾没有声音，而且没有任何一条明确报错。
/// 项目里其它返回结构体（UpdateNotice / UpdateMeta / UpdatePhase）字段都是单个
/// 单词，所以从来踩不到这个坑——只有这里有多词字段，千万别改回去。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopbackStart {
    pub sample_rate: u32,
    pub channels: u32,
    /// 实际用的采集模式：include（只采一个应用）/ webview / self。
    /// 前端据此把"声音来源"如实写进提示，避免出了回声还看不出走的哪条路。
    pub mode: String,
    /// 本次的目标进程（include=被采应用；webview/self=被排除的进程）。
    pub target: u32,
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

    /// 把 PCM 切成 2048 帧（~43ms）推给页面；返回 false 表示页面已关/停播。
    fn push_pcm(buf: &mut Vec<i16>, pcm: &[i16], on_chunk: &Channel<String>) -> bool {
        const CHUNK_SAMPLES: usize = 2048 * 2; // 立体声
        buf.extend_from_slice(pcm);
        while buf.len() >= CHUNK_SAMPLES {
            let chunk: Vec<i16> = buf.drain(..CHUNK_SAMPLES).collect();
            let bytes: Vec<u8> = chunk.iter().flat_map(|v| v.to_le_bytes()).collect();
            let payload = base64::engine::general_purpose::STANDARD.encode(&bytes);
            if on_chunk.send(payload).is_err() {
                return false;
            }
        }
        true
    }

    /// 采集循环：默认渲染设备 → 回环 → 立体声 f32 → i16 → base64 → Channel。
    /// 每块 ~43ms（2048 帧），前端 AudioWorklet 缓冲后按采样节拍播出去。
    fn capture_loop(
        stop: Arc<AtomicBool>,
        on_chunk: Channel<String>,
        app: tauri::AppHandle,
        only_pid: Option<u32>,
        exclude_pid: u32,
    ) -> Result<(), String> {
        /*
         * 优先进程级采集（整机混音 − 本应用进程树）：
         * 我们自己的语音由 WebView2 子进程渲染，被排除后共享音频里就没有人声，
         * 观众不会听到"同一句话两遍"。共享整个桌面同样成立。
         * 老系统（< Win10 2004）或策略禁用时回退整机回环，并告知页面。
         */
        let mut pcm_buf: Vec<i16> = Vec::new();
        /*
         * 记一下"到底有没有采到过东西"。
         * 进程级采集有可能**不报错就结束**（设备被切走、端点重建、会话被系统回收），
         * 这时函数返回 Ok(())，看起来像"正常采完了"。不能就这么 return，
         * 否则整机回收的兜底永远走不到（业主实拍：共享整桌面 + 自动 = 一点声音都没有）。
         */
        let produced = std::sync::atomic::AtomicUsize::new(0);
        let attempted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match only_pid {
                // 指定应用：只采那个进程树（通知音/音乐都不会混进来）
                Some(pid) => crate::process_loopback::run_capture_with(
                    pid,
                    false,
                    stop.clone(),
                    &mut |pcm: &[i16]| {
                        if !pcm.is_empty() && produced.fetch_add(1, Ordering::Relaxed) == 0 {
                            log::info!("[loopback] 进程级采集收到第一块 PCM");
                        }
                        push_pcm(&mut pcm_buf, pcm, &on_chunk)
                    },
                ),
                // 默认：整机混音减去"我们自己的声音"。
                // 排除对象优先是 WebView2 的 browser 进程树（房间语音真正从这里出），
                // 排 app.exe 只在拿不到 WebView2 进程时兜底——见 exclude_target 注释。
                None => crate::process_loopback::run_capture_excluding(exclude_pid, stop.clone(), |pcm| {
                    if !pcm.is_empty() && produced.fetch_add(1, Ordering::Relaxed) == 0 {
                        log::info!("[loopback] 进程级采集收到第一块 PCM");
                    }
                    push_pcm(&mut pcm_buf, pcm, &on_chunk)
                }),
            }
        }));
        let produced_any = produced.load(Ordering::Relaxed) > 0;
        match attempted {
            Ok(Ok(())) => {
                if stop.load(Ordering::SeqCst) || produced_any {
                    return Ok(());
                }
                log::warn!("[loopback] 进程级采集一块数据都没产出就结束了，回退整机回环");
            }
            Ok(Err(err)) => {
                if stop.load(Ordering::SeqCst) {
                    return Ok(());
                }
                log::warn!("[loopback] 进程级采集不可用，回退整机回环：{err}");
            }
            Err(_) => {
                log::warn!("[loopback] 进程级采集异常，回退整机回环");
            }
        }
        let _ = app.emit(
            "loopback:fallback",
            "这台系统不支持按进程取声音，已改用整机采集（共享声音时可能有回声）",
        );
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        log::info!("[loopback] 回退到整机回环（默认播放设备）");

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
        // 事件句柄仍需设置（initialize 时带了 EVENTCALLBACK 标志），但我们改为轮询读取
        let _h_event = audio_client.set_get_eventhandle().map_err(|e| e.to_string())?;
        let capture = audio_client.get_audiocaptureclient().map_err(|e| e.to_string())?;
        audio_client.start_stream().map_err(|e| e.to_string())?;

        const CHUNK_FRAMES: usize = 2048; // ~43ms @48k
        let chunk_bytes = CHUNK_FRAMES * blockalign;
        let mut queue: VecDeque<u8> = VecDeque::new();
        let mut pcm: Vec<i16> = Vec::with_capacity(CHUNK_FRAMES * 2);

        while !stop.load(Ordering::SeqCst) {
            // ⚠️ **先确认有包、才读**。无数据时 GetBuffer 会返回 0 帧 + 空指针，
            // wasapi 0.14 的 read_from_device_to_deque 对此不设防（api.rs 直接
            // slice::from_raw_parts）——真机探针实测：启动初期/静音期直接 panic，
            // 采集线程无声死亡 → "共享正常但没有声音"。
            // get_next_nbr_frames() 返回 None = 没有可用包，此时只等待不读。
            match capture.get_next_nbr_frames().map_err(|e| e.to_string())? {
                Some(frames) if frames > 0 => {
                    capture
                        .read_from_device_to_deque(blockalign, &mut queue)
                        .map_err(|e| e.to_string())?;
                }
                _ => {
                    // 没有可用包（静音期回环不产生包、也不触发事件）：
                    // 短轮询等待，不依赖事件——静音转有声、设备切换都能自然恢复
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
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
        only_pid: Option<u32>,
    ) -> Result<LoopbackStart, String> {
        // 先停旧的（不持锁 join，避免长时间占住状态锁）
        let existing = state.worker.lock().unwrap().take();
        if let Some(worker) = existing {
            worker.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = worker.thread {
                let _ = thread.join();
            }
        }

        /*
         * 采集模式与目标进程在**起线程之前**定下来，并回给前端：
         * 排障时"到底采的是谁"必须一眼可见，否则出了回声只能靠猜。
         *   include  ：只采被共享的那个应用（共享窗口时最理想）
         *   webview  ：整机 − WebView2 进程树（我们自己的语音从这儿出）
         *   self     ：整机 − 本进程（拿不到 WebView2 进程时的兜底）
         */
        /*
         * include 模式：把"窗口所属进程"解析成**该应用真正在出声的进程**。
         *
         * 进程回环只认精确 pid（`_TREE` 后缀不排子树，见 process_loopback 里的实测表），
         * 而音频往往由 browser 的**子进程**渲染。直接拿窗口 pid 去 INCLUDE，
         * 大概率采到静音——这也是"指定共享也没声音"的另一半原因
         * （当时被 sample_rate 那个 bug 挡在前面，看不出来）。
         */
        let resolved_only_pid = only_pid.map(|pid| {
            let resolved = crate::process_loopback::audio_pid_for(pid).unwrap_or(pid);
            if resolved != pid {
                log::info!("[loopback] 指定进程 {pid} 本身不出声，改用其出声子进程 {resolved}");
            }
            resolved
        });
        let (mode, target) = match resolved_only_pid {
            Some(pid) => ("include".to_string(), pid),
            None => {
                let (pid, kind) = crate::process_loopback::exclude_target();
                (kind.to_string(), pid)
            }
        };
        // 整机采集时排除这个 pid；include 模式下用不到，随便传自身即可
        let exclude_pid = if resolved_only_pid.is_some() {
            std::process::id()
        } else {
            target
        };
        /*
         * 日志里带上**被排除进程的名字**，不只是一个 pid。
         * 只写 pid 的话，出现"排除模式仍然听到自己人声"时根本判断不出
         * 排的到底是 msedgewebview2（我们要的）还是别的什么进程
         * ——2026-10-27 就在这儿卡过一次。
         */
        let target_name = crate::process_loopback::process_name(target)
            .unwrap_or_else(|| "未知进程".to_string());
        log::info!(
            "[loopback] 启动采集：mode={mode} target={target}({target_name}) exclude_pid={exclude_pid} only_pid={only_pid:?}"
        );

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_app = app.clone();
        let handle = std::thread::Builder::new()
            .name("loopback-capture".into())
            .spawn(move || {
                // catch_unwind：wasapi 内部还有别的坑时（见 wait/read 的注释），
                // panic 不能无声吞掉采集线程——必须把原因发到页面给用户看。
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    capture_loop(
                        thread_stop.clone(),
                        on_chunk.clone(),
                        thread_app.clone(),
                        resolved_only_pid,
                        exclude_pid,
                    )
                }));
                let err = match result {
                    Ok(Ok(())) => {
                        log::info!("[loopback] 采集线程正常结束");
                        return;
                    }
                    Ok(Err(err)) => err,
                    Err(panic) => {
                        let detail = panic
                            .downcast_ref::<&str>()
                            .map(|s| (*s).to_string())
                            .or_else(|| panic.downcast_ref::<String>().cloned())
                            .unwrap_or_else(|| "未知原因（采集库内部 panic）".into());
                        format!("内置采集线程异常终止：{detail}")
                    }
                };
                log::warn!("[loopback] {err}");
                let _ = thread_app.emit(
                    "loopback:error",
                    format!("系统声音采集中断（画面不受影响）：{err}"),
                );
            })
            .map_err(|e| format!("无法启动采集线程：{e}"))?;
        *state.worker.lock().unwrap() = Some(LoopbackWorker {
            stop,
            thread: Some(handle),
        });
        Ok(LoopbackStart { sample_rate: 48_000, channels: 2, mode, target })
    }

    /// 列出正在出声的应用（供 UI 选"只采集这个应用"）。
    #[tauri::command]
    pub fn list_loopback_targets() -> Result<Vec<serde_json::Value>, String> {
        let sessions = crate::process_loopback::list_audio_sessions()?;
        Ok(sessions
            .into_iter()
            .map(|(pid, name)| serde_json::json!({ "pid": pid, "name": name }))
            .collect())
    }

    /// 列出"有窗口的进程"（标题 + pid）：共享浮层据此显示"声音来源"，也用于自检。
    #[tauri::command]
    pub fn list_share_windows() -> Result<Vec<serde_json::Value>, String> {
        let mut list: Vec<serde_json::Value> = crate::process_loopback::list_window_titles()
            .into_iter()
            .map(|(pid, title)| serde_json::json!({ "pid": pid, "title": title }))
            .collect();
        list.sort_by(|a, b| {
            let ta = a.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let tb = b.get("title").and_then(|v| v.as_str()).unwrap_or("");
            ta.cmp(tb)
        });
        Ok(list)
    }

    /// 从共享源 label 反查窗口进程：命中返回 { pid, title }，否则 null。
    #[tauri::command]
    pub fn resolve_share_pid(label: String) -> Result<serde_json::Value, String> {
        Ok(match crate::process_loopback::pid_for_share_label(&label) {
            Some((pid, title)) => serde_json::json!({ "pid": pid, "title": title }),
            None => serde_json::Value::Null,
        })
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

    #[tauri::command]
    pub fn list_loopback_targets() -> Result<Vec<serde_json::Value>, String> {
        Ok(Vec::new())
    }

    #[tauri::command]
    pub fn list_share_windows() -> Result<Vec<serde_json::Value>, String> {
        Ok(Vec::new())
    }

    #[tauri::command]
    pub fn resolve_share_pid(_label: String) -> Result<serde_json::Value, String> {
        Ok(serde_json::Value::Null)
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::LoopbackStart;

    /*
     * 守护测试：前端按 `info.sampleRate` 取采样率。
     *
     * 字段名一旦回退成 serde 默认的 snake_case，前端拿到的是 undefined，
     * `undefined !== 48000` 恒真 → 每次共享都会立刻停掉采集，
     * 观端从头到尾没有声音（2026-10-27 实拍事故，排查了两轮 WASAPI 才定位到）。
     * 这个测试就是为了下次有人"顺手"删掉 rename_all 时当场炸出来。
     */
    #[test]
    fn loopback_start_serializes_camel_case() {
        let json = serde_json::to_string(&LoopbackStart {
            sample_rate: 48_000,
            channels: 2,
            mode: "webview".into(),
            target: 123,
        })
        .expect("序列化 LoopbackStart 失败");

        assert!(json.contains("\"sampleRate\":48000"), "实际输出：{json}");
        assert!(json.contains("\"mode\":\"webview\""), "实际输出：{json}");
        assert!(json.contains("\"target\":123"), "实际输出：{json}");
        assert!(
            !json.contains("sample_rate"),
            "字段名回退成 snake_case 了，前端会读到 undefined：{json}"
        );
    }
}
