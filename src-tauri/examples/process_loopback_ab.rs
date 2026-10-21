//! A/B 验证："排除自己"是否真的把本进程播放的声音排除在外。
//! 做法：本进程用 PlaySoundW 放一段 wav（会话属于本进程），
//! ① 以 INCLUDE 本进程采集 → 应该采到（峰值大）；
//! ② 以 EXCLUDE 本进程采集 → 应该采不到（峰值接近静音）。
//! 运行：cargo run --example process_loopback_ab

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use windows::core::PCWSTR;
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};

const WAV: &str = "C://Windows//Media//Windows Notify Calendar.wav";

fn play_once() {
    let wide: Vec<u16> = WAV.encode_utf16().chain(std::iter::once(0)).collect();
    // 忽略返回值：没有这个文件也不影响判据（峰值会是一样的低）
    let _ = unsafe { PlaySoundW(PCWSTR(wide.as_ptr()), None, SND_FILENAME | SND_ASYNC | SND_NODEFAULT) };
}

fn capture(pid: u32, exclude: bool, secs: f32) -> (usize, i32) {
    let stop = Arc::new(AtomicBool::new(false));
    let stopper = stop.clone();
    let ms = (secs * 1000.0) as u64;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        stopper.store(true, Ordering::SeqCst);
    });
    let mut frames = 0usize;
    let mut peak = 0i32;
    let mut cb = |pcm: &[i16]| {
        frames += pcm.len() / 2;
        for &s in pcm {
            let v = (s as i32).abs();
            if v > peak {
                peak = v;
            }
        }
        true
    };
    let _ = app_lib::process_loopback::run_capture_with(pid, exclude, stop, &mut cb);
    (frames, peak)
}

fn main() {
    let pid = std::process::id();
    println!("本进程 pid = {pid}，测试音：{WAV}");

    // ① 包含本进程
    play_once();
    std::thread::sleep(Duration::from_millis(120));
    let (f1, p1) = capture(pid, false, 1.2);
    println!("① INCLUDE 本进程：帧 {f1}，峰值 {p1}");

    std::thread::sleep(Duration::from_millis(300));

    // ② 排除本进程
    play_once();
    std::thread::sleep(Duration::from_millis(120));
    let (f2, p2) = capture(pid, true, 1.2);
    println!("② EXCLUDE 本进程：帧 {f2}，峰值 {p2}");

    println!();
    if p1 > 500 && p2 < p1 / 4 {
        println!("✅ 结论成立：本进程的声音能被单独采到（{p1}），排除后基本消失（{p2}）");
        println!("   → 共享时房间语音不会再被采进共享音频，回声根源解决。");
    } else {
        println!("⚠️ 结论不明确：INCLUDE={p1} / EXCLUDE={p2}");
        println!("   可能原因：测试音没播出来（文件不存在/被静音）、或该会话不属于本进程。");
    }
}
