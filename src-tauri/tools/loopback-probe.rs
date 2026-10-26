//! 系统声音采集自检探针（只在 Windows 上跑）。
//!
//! 这里**故意不放在 `examples/`**：`cargo test` 会连带编译 examples，
//! 而本项目 CI 机器不一定装了 MSVC，一个编译不过的 example 会把流水线拖红。
//! 需要用时手工挪过去：
//!
//! ```text
//! mkdir examples && cp tools/loopback-probe.rs examples/
//! cargo run --release --example loopback-probe
//! ```
//!
//! 它把"共享屏幕没声音"拆成几件可观测的事：
//!   1. 默认播放设备的混合格式（进程回环只抓默认设备，格式决定能不能转换）
//!   2. 当前有哪些进程正在出声（INCLUDE 模式必须有活跃会话）
//!   3. EXCLUDE 目标判定（排除的是 WebView2 树，还是退回排除自身）
//!   4. 三条采集路径各跑 2.5 秒，看收到多少块、多少采样点、峰值多大
//!
//! 包数为 0 = 采不到（"完全没声音"的直接证据）；
//! 有包但峰值为 0 = 采到了静音（设备没声，或抓的是错的设备）。

#![cfg(windows)]

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn main() {
    println!("=== 5blong 系统声音采集自检 ===");
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
    }

    // ---------------------------------------------------------------- 1. 设备
    match default_render_format() {
        Ok((rate, ch, bits)) => {
            println!("\n[1] 默认播放设备混合格式：{rate} Hz / {ch} ch / {bits} bit");
            if rate != 48_000 || ch != 2 {
                println!("    ⚠ 与采集侧写死的 48000/2ch 不一致，要靠 AUTOCONVERTPCM 转换");
            }
        }
        Err(err) => println!("\n[1] 取默认播放设备格式失败：{err}"),
    }

    // ---------------------------------------------------------------- 2. 会话
    let sessions = app_lib::process_loopback::list_audio_sessions().unwrap_or_default();
    if sessions.is_empty() {
        println!("\n[2] 当前没有正在出声的程序（INCLUDE 模式此时必然采不到）");
    } else {
        println!("\n[2] 正在出声的程序：");
        for (pid, name) in &sessions {
            println!("    - {name} (pid {pid})");
        }
    }

    // ------------------------------------------------------------ 3. 排除目标
    let (exclude_pid, exclude_kind) = app_lib::process_loopback::exclude_target();
    println!("\n[3] EXCLUDE 目标：{exclude_kind} (pid {exclude_pid})");
    if exclude_kind == "self" {
        println!("    ⚠ 没找到 msedgewebview2.exe 直接子进程 → 退回排除自身，");
        println!("      房间语音可能漏进共享音频（听到回声）");
    }

    // -------------------------------------------------------- 4. EXCLUDE 实测
    println!("\n[4a] EXCLUDE 采集 2.5 秒（自动模式的真实路径）…");
    report(run_probe(2_500, |stop, sink| {
        app_lib::process_loopback::run_capture_excluding(exclude_pid, stop, sink)
    }));

    // -------------------------------------------------------- 5. INCLUDE 实测
    match sessions.first() {
        Some((pid, name)) => {
            println!("\n[4b] INCLUDE「{name}」(pid {pid}) 采集 2.5 秒…");
            report(run_probe(2_500, |stop, sink| {
                app_lib::process_loopback::run_capture_with(*pid, false, stop, sink)
            }));
        }
        None => println!("\n[4b] 跳过 INCLUDE：没有正在出声的程序"),
    }

    // -------------------------------------------------- 6. 经典整机回环兜底
    println!("\n[4c] 经典整机回环兜底 2.5 秒（老系统路径）…");
    report(classic_loopback_probe(2_500));

    println!("\n=== 自检结束 ===");
}

/// 跑一段采集，返回 (错误, 块数, 采样点数, 峰值)。
fn run_probe(
    ms: u64,
    run: impl FnOnce(Arc<AtomicBool>, &mut dyn FnMut(&[i16]) -> bool) -> Result<(), String>,
) -> (Option<String>, usize, usize, i32) {
    let stop = Arc::new(AtomicBool::new(false));
    let chunks = Cell::new(0usize);
    let points = Cell::new(0usize);
    let peak = Cell::new(0i32);
    let mut sink = |pcm: &[i16]| -> bool {
        chunks.set(chunks.get() + 1);
        points.set(points.get() + pcm.len());
        for &v in pcm {
            let level = (v as i32).abs();
            if level > peak.get() {
                peak.set(level);
            }
        }
        true
    };

    let timer_stop = stop.clone();
    let timer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        timer_stop.store(true, Ordering::SeqCst);
    });

    let started = Instant::now();
    let result = run(stop.clone(), &mut sink);
    stop.store(true, Ordering::SeqCst);
    let _ = timer.join();
    println!("    耗时 {} ms", started.elapsed().as_millis());
    (result.err(), chunks.get(), points.get(), peak.get())
}

fn report((err, chunks, points, peak): (Option<String>, usize, usize, i32)) {
    if let Some(err) = err {
        println!("    ✗ 采集失败：{err}");
        return;
    }
    let level = if peak == 0 {
        "静音".to_string()
    } else {
        format!("{:.1}% 满量程", peak as f32 / 32767.0 * 100.0)
    };
    println!("    收到 {chunks} 块 / {points} 采样点，峰值 {level}");
    if chunks == 0 {
        println!("    ✗ 一个包都没收到 → 这条路径在这台机器上不通");
    } else if peak == 0 {
        println!("    ⚠ 有包但全是静音 → 设备没在出声，或抓的是错的设备");
    } else {
        println!("    ✓ 正常");
    }
}

/// 经典整机回环（loopback.rs 的兜底路径），独立实现一份用于对比。
fn classic_loopback_probe(ms: u64) -> (Option<String>, usize, usize, i32) {
    use wasapi::{Direction, SampleType, ShareMode, WaveFormat};

    let stop = Arc::new(AtomicBool::new(false));
    let chunks = Cell::new(0usize);
    let points = Cell::new(0usize);
    let peak = Cell::new(0i32);

    let err = (|| -> Result<(), String> {
        wasapi::initialize_mta().map_err(|e| e.to_string())?;
        let device = wasapi::get_default_device(&Direction::Render).map_err(|e| e.to_string())?;
        let mut client = device.get_iaudioclient().map_err(|e| e.to_string())?;
        let desired = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);
        let blockalign = desired.get_blockalign() as usize;
        let (default_period, _) = client.get_periods().map_err(|e| e.to_string())?;
        client
            .initialize_client(
                &desired,
                default_period,
                &Direction::Capture,
                &ShareMode::Shared,
                true,
            )
            .map_err(|e| e.to_string())?;
        let _ = client.set_get_eventhandle().map_err(|e| e.to_string())?;
        let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
        client.start_stream().map_err(|e| e.to_string())?;

        let mut queue = std::collections::VecDeque::new();
        while !stop.load(Ordering::SeqCst) {
            match capture.get_next_nbr_frames().map_err(|e| e.to_string())? {
                Some(n) if n > 0 => {
                    capture
                        .read_from_device_to_deque(blockalign, &mut queue)
                        .map_err(|e| e.to_string())?;
                    chunks.set(chunks.get() + 1);
                    while queue.len() >= 4 {
                        let b = [
                            queue.pop_front().unwrap_or(0),
                            queue.pop_front().unwrap_or(0),
                            queue.pop_front().unwrap_or(0),
                            queue.pop_front().unwrap_or(0),
                        ];
                        let f = f32::from_ne_bytes(b);
                        let i = (f.clamp(-1.0, 1.0) * 32767.0) as i16;
                        let level = (i as i32).abs();
                        if level > peak.get() {
                            peak.set(level);
                        }
                        points.set(points.get() + 1);
                    }
                }
                _ => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        let _ = client.stop_stream();
        Ok(())
    })();

    let _ = stop;
    (err.err(), chunks.get(), points.get(), peak.get())
}

/// 默认渲染设备的混合格式：采样率 / 声道 / 位深。
fn default_render_format() -> Result<(u32, u16, u16), String> {
    use windows::Win32::Media::Audio::{eConsole, eRender, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("枚举器：{e}"))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("默认端点：{e}"))?;
        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("激活：{e}"))?;
        let fmt = client.GetMixFormat().map_err(|e| format!("混合格式：{e}"))?;
        let f = &*fmt;
        Ok((f.nSamplesPerSec, f.nChannels, f.wBitsPerSample))
    }
}
