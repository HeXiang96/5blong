//! 诊断用：验证"进程级回环（排除本应用）"在本机是否真的能采到声音。
//! 运行：cargo run --example process_loopback_probe
//! 结论判据：帧数 > 0 且（有声音在播时）峰值电平明显 > 0。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn main() {
    let stop = Arc::new(AtomicBool::new(false));
    let stopper = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        stopper.store(true, Ordering::SeqCst);
    });

    let mut frames = 0usize;
    let mut peak = 0i32;
    let mut nonzero = 0usize;
    let result = app_lib::process_loopback::run_capture(stop, |pcm| {
        frames += pcm.len() / 2;
        for &s in pcm {
            let v = (s as i32).abs();
            if v > peak {
                peak = v;
            }
            if s != 0 {
                nonzero += 1;
            }
        }
        true
    });

    match result {
        Ok(()) => {
            println!("✅ 进程级回环可用：采集 1.5 秒，帧数 {frames}，峰值 {peak}，非零样本 {nonzero}");
            if frames == 0 {
                println!("   注意：这段窗口内没有任何音频在播（静音期不产生包），改用播放中的场景再测");
            }
        }
        Err(err) => println!("❌ 进程级回环失败：{err}"),
    }
}
