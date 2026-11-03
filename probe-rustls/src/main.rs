//! 临时探针（2026-11-03，验完即删）
//!
//! 验证 **rustls** 能否连上阿里云 GA 的加速 IP（dl.5blong.site）。
//! 背景：Windows 原生 TLS（schannel）实测连不上，但 Tauri 的 updater 用的是
//! rustls（tauri-plugin-updater 默认 feature），所以必须用 rustls 本身来验。
#[tokio::main]
async fn main() {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .build()
        .expect("build client");

    let mut failed = false;
    for url in [
        "https://dl.5blong.site/desktop/latest.json",
        "https://5blong.site/desktop/latest.json",
    ] {
        let t0 = std::time::Instant::now();
        match client
            .get(url)
            .header("cache-control", "no-cache")
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                let len = resp.bytes().await.map(|b| b.len()).unwrap_or(0);
                println!("PROBE_OK {url} status={status} bytes={len} ms={}", t0.elapsed().as_millis());
            }
            Err(e) => {
                println!("PROBE_FAIL {url} err={e}");
                failed = true;
            }
        }
    }
    if failed {
        std::process::exit(1);
    }
}
