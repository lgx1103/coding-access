#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let args = std::env::args_os().collect::<Vec<_>>();
    // A terminal session runs before webview initialization and single-instance
    // handling. It needs neither Node.js nor a second GUI process.
    if args.get(1).is_some_and(|v| v == "--terminal-session") {
        // The packaged binary has the Windows GUI subsystem. Attach only the
        // runner to its launching PowerShell console so the CLI can use its TTY.
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::Console::AttachConsole(u32::MAX);
        }
        let result = (|| {
            let payload = args.get(2).ok_or("缺少临时会话路径")?;
            let paths = if args.get(3).is_some_and(|v| v == "--development-root") {
                coding_access_native::filesystem::Paths::development_at(
                    args.get(4).ok_or("缺少开发目录")?.into(),
                )?
            } else {
                coding_access_native::filesystem::Paths::runtime()?
            };
            tokio::runtime::Runtime::new()
                .map_err(|_| "无法初始化临时会话")?
                .block_on(coding_access_native::terminal::run_session(
                    &paths,
                    std::path::Path::new(payload),
                ))
        })();
        match result {
            Ok(code) => std::process::exit(code),
            Err(_) => {
                eprintln!("临时会话启动失败，请检查工具安装和项目目录，然后从客户端重新打开。");
                std::process::exit(1);
            }
        }
    }
    coding_access_native::desktop::run();
}
