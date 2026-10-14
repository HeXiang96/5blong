//! 诊断用：在真机上验证 loopback.rs 的同款调用链是否可用。
//! 运行：cargo run --example loopback_probe
//! （只读采集 1 秒默认播放设备的回环，不改任何系统状态；发布构建不包含 examples。）

use std::collections::VecDeque;

fn main() {
    if let Err(err) = run() {
        println!("❌ 探针失败：{err}");
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    wasapi::initialize_mta()?;
    let device = wasapi::get_default_device(&wasapi::Direction::Render)?;
    let mut audio_client = device.get_iaudioclient()?;
    // 与 src-tauri/src/loopback.rs 完全一致的目标格式与参数
    let desired = wasapi::WaveFormat::new(32, 32, &wasapi::SampleType::Float, 48_000, 2, None);
    let blockalign = desired.get_blockalign() as usize;
    let (default_period, _min) = audio_client.get_periods()?;
    println!("请求格式：2ch f32 @48k（块对齐 {blockalign} B）· 周期 {default_period}");

    match audio_client.initialize_client(
        &desired,
        default_period,
        &wasapi::Direction::Capture,
        &wasapi::ShareMode::Shared,
        true,
    ) {
        Ok(()) => println!("✅ initialize_client 成功（回环 + 自动格式转换可用）"),
        Err(e) => {
            println!("❌ initialize_client 失败：{e}");
            println!("   → 结论：这台机器上 Chromium 失败的原因一样，但 WASAPI 的自动转换也救不了；");
            println!("     需要改用设备混合格式采集后在 Rust 里自行下混。");
            return Ok(());
        }
    }

    let h_event = audio_client.set_get_eventhandle()?;
    let capture = audio_client.get_audiocaptureclient()?;
    audio_client.start_stream()?;

    println!("采集 1 秒…（此刻可以放点声音，能看出峰值）");
    let mut queue: VecDeque<u8> = VecDeque::new();
    let start = std::time::Instant::now();
    while start.elapsed().as_millis() < 1000 {
        // 与 loopback.rs 同款绕法：有包才读（无包读会踩 crate 的空指针切片）
        match capture.get_next_nbr_frames()? {
            Some(frames) if frames > 0 => {
                capture.read_from_device_to_deque(blockalign, &mut queue)?;
            }
            _ => {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }
    let total = queue.len();
    audio_client.stop_stream()?;

    let expected = 48_000 * blockalign; // 1 秒的量
    println!("实际采到 {total} B（期望 ≈ {expected} B）");
    let mut peak = 0f32;
    let bytes: Vec<u8> = queue.into_iter().collect();
    for frame in bytes.chunks_exact(4) {
        let v = f32::from_ne_bytes([frame[0], frame[1], frame[2], frame[3]]);
        peak = peak.max(v.abs());
    }
    println!("峰值电平：{peak:.4}");
    if total == 0 {
        println!("❌ 没采到任何数据 → Rust 侧采集链不通");
    } else if total < expected / 4 {
        println!("⚠️ 采到的数据远少于预期 → 回环有数据但流量异常");
    } else {
        println!("✅ Rust 侧采集链正常（WASAPI 回环 + 自动转换在本机可用）");
    }
    Ok(())
}
