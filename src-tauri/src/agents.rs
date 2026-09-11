//! Native Agent discovery and GUI launch; never stop another application.
use crate::{model::Agent, terminal, Result};
use std::{path::PathBuf, process::Stdio, time::Duration};

#[cfg(windows)]
async fn output(program: &str, args: &[&str]) -> Result<std::process::Output> {
    let mut command = tokio::process::Command::new(program);
    command.args(args).stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| "检查工具状态超时")?
        .map_err(|_| "无法检查工具状态".into())
}
pub async fn zcode_running() -> Result<bool> {
    desktop_running(Agent::Zcode).await
}
pub async fn desktop_running(agent: Agent) -> Result<bool> {
    #[cfg(target_os = "macos")]
    {
        return Ok(crate::macos_app::running(agent));
    }
    #[cfg(windows)]
    {
        if agent == Agent::CodexDesktop {
            return Ok(windows_codex_probe().await?.running);
        }
        let result = output(
            "tasklist.exe",
            &["/FI", "IMAGENAME eq ZCode.exe", "/FO", "CSV", "/NH"],
        )
        .await?;
        if !result.status.success() {
            return Err("无法检查 ZCode 运行状态".into());
        }
        return Ok(String::from_utf8_lossy(&result.stdout)
            .lines()
            .any(|l| l.to_ascii_lowercase().starts_with("\"zcode.exe\"")));
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    Err("当前支持 macOS 和 Windows".into())
}
pub enum DesktopTarget {
    File(PathBuf),
    Store(String),
}
pub async fn desktop_target(agent: Agent) -> Result<Option<DesktopTarget>> {
    if !agent.desktop() {
        return Err("请选择桌面工具".into());
    }
    if let Some(path) = terminal::locate_tool(agent) {
        return Ok(Some(DesktopTarget::File(path)));
    }
    #[cfg(windows)]
    if agent == Agent::CodexDesktop {
        return Ok(windows_codex_probe().await?.target());
    }
    Ok(None)
}
#[cfg(any(windows, test))]
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WindowsCodexProbe {
    running: bool,
    app_id: Option<String>,
    path: Option<String>,
}
#[cfg(any(windows, test))]
impl WindowsCodexProbe {
    fn target(self) -> Option<DesktopTarget> {
        if let Some(id) = self.app_id.filter(|id| valid_store_id(id) && id.starts_with("OpenAI.Codex")) {
            return Some(DesktopTarget::Store(id));
        }
        self.path.filter(|p| {
            // PowerShell verifies desktop resources; reject malformed paths at
            // the bridge boundary as well. No shell interpolation is used.
            !p.chars().any(char::is_control) && (p.as_bytes().get(1) == Some(&b':') || p.starts_with("\\\\"))
        }).map(|p| DesktopTarget::File(PathBuf::from(p)))
    }
}
#[cfg(windows)]
async fn windows_codex_probe() -> Result<WindowsCodexProbe> {
    // Encode the script so Windows command-line quoting cannot change its text.
    let script = terminal::encoded_ps(include_str!("windows_codex.ps1"));
    let result = output("powershell.exe", &["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", &script]).await?;
    if !result.status.success() { return Err("无法检查 Codex 桌面版，请在设置中重新检测或指定安装路径".into()); }
    serde_json::from_slice(&result.stdout).map_err(|_| "无法读取 Codex 桌面版检测结果".into())
}
pub fn valid_store_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 256
        && id.split('!').count() == 2
        && id.split('!').all(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        })
}
pub async fn launch_desktop(target: DesktopTarget) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let DesktopTarget::File(path) = target else {
            return Err("应用类型不受支持".into());
        };
        let result = tokio::process::Command::new("/usr/bin/open")
            .arg("-a")
            .arg(path)
            .status()
            .await
            .map_err(|_| "无法打开桌面工具")?;
        if !result.success() {
            return Err("无法打开桌面工具，请手动启动".into());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        let mut command = match target {
            DesktopTarget::File(path) => std::process::Command::new(path),
            DesktopTarget::Store(id) => {
                if !valid_store_id(&id) {
                    return Err("应用标识无效".into());
                }
                let mut c = std::process::Command::new("explorer.exe");
                c.arg(format!("shell:AppsFolder\\{id}"));
                c
            }
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "无法打开桌面工具，请手动启动")?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = target;
        Err("当前支持 macOS 和 Windows".into())
    }
}
pub async fn version(path: &std::path::Path) -> Option<String> {
    if path.extension().is_some_and(|x| x == "app") {
        return None;
    }
    let mut command = tokio::process::Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use base64::Engine;
        if path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("cmd") || s.eq_ignore_ascii_case("bat"))
        {
            let script = format!("& {} --version", terminal::powershell_quote(path.to_str()?));
            command = tokio::process::Command::new("powershell.exe");
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &base64::engine::general_purpose::STANDARD.encode(
                    script
                        .encode_utf16()
                        .flat_map(u16::to_le_bytes)
                        .collect::<Vec<_>>(),
                ),
            ]);
            command.stdin(Stdio::null()).kill_on_drop(true);
        }
        command.creation_flags(0x08000000);
    }
    let result = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    if !result.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&result.stdout)
            .trim()
            .chars()
            .take(150)
            .collect(),
    )
}

pub fn validate_manual_path(agent: Agent, path: &std::path::Path) -> Result<()> {
    if !path.is_absolute() || path.to_string_lossy().chars().any(char::is_control) {
        return Err("请选择有效的绝对路径".into());
    }
    #[cfg(target_os = "macos")]
    if agent.desktop() {
        return if crate::macos_app::matches_bundle(path, agent) {
            Ok(())
        } else {
            Err("所选应用与工具类型不匹配".into())
        };
    }
    if !terminal::usable_executable(path, cfg!(windows)) {
        return Err("所选路径不是可执行文件".into());
    }
    if agent == Agent::CodexCli
        && path
            .components()
            .any(|c| c.as_os_str().to_string_lossy().ends_with(".app"))
    {
        return Err("请选择独立安装的 Codex CLI，不能使用桌面应用的内部程序".into());
    }
    #[cfg(windows)]
    if agent.desktop()
        && path
            .extension()
            .is_none_or(|s| !s.eq_ignore_ascii_case("exe"))
    {
        return Err("请选择桌面工具的 exe 文件".into());
    }
    Ok(())
}

#[cfg(test)]
mod windows_codex_tests {
    use super::*;
    #[test]
    fn prefers_stable_store_identity_and_handles_custom_running_paths() {
        let probe: WindowsCodexProbe = serde_json::from_str(r#"{"running":true,"appId":"OpenAI.Codex_123!App","path":"D:\\Apps\\Codex\\Codex.exe"}"#).unwrap();
        assert!(probe.running);
        assert!(matches!(probe.target(), Some(DesktopTarget::Store(_))));
        let probe: WindowsCodexProbe = serde_json::from_str(r#"{"running":true,"appId":null,"path":"D:\\Apps\\Codex\\Codex.exe"}"#).unwrap();
        assert!(matches!(probe.target(), Some(DesktopTarget::File(_))));
    }
    #[test]
    fn stopped_store_app_is_installed_without_a_process_path() {
        // Captured from Windows PowerShell 5.1.26100.9168: the old empty
        // pipeline serialized as an object and could not cross the Rust bridge.
        let legacy = r#"{"appId":"OpenAI.Codex_2p2nqsd0c76g0!App","path":{},"running":false}"#;
        assert!(serde_json::from_str::<WindowsCodexProbe>(legacy).is_err());
        let probe: WindowsCodexProbe = serde_json::from_str(
            r#"{"running":false,"appId":"OpenAI.Codex_2p2nqsd0c76g0!App","path":null}"#,
        ).unwrap();
        assert!(!probe.running);
        assert!(matches!(probe.target(), Some(DesktopTarget::Store(_))));
    }

    #[test]
    fn discovery_script_transport_preserves_quotes_and_unicode() {
        use base64::Engine;
        let script = format!("{}\n# 中文路径", include_str!("windows_codex.ps1"));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(terminal::encoded_ps(&script)).unwrap();
        let utf16: Vec<u16> = bytes.chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        assert_eq!(String::from_utf16(&utf16).unwrap(), script);
    }

    // Windows CI uses the same PowerShell 5.1 runtime as affected users.
    #[cfg(windows)]
    #[test]
    fn windows_powershell_discovery_contract() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
            .arg(terminal::encoded_ps(&format!(
                "& {} -ProbePath {}",
                terminal::powershell_quote(root.join("tests/windows-codex-probe.ps1").to_str().unwrap()),
                terminal::powershell_quote(root.join("src/windows_codex.ps1").to_str().unwrap()),
            )))
            .output().unwrap();
        assert!(output.status.success(), "stdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }

    #[test]
    fn absent_or_invalid_discovery_does_not_claim_installation() {
        for data in [r#"{"running":false,"appId":null,"path":null}"#, r#"{"running":false,"appId":"Other.App!App","path":"relative.exe"}"#] {
            let probe: WindowsCodexProbe = serde_json::from_str(data).unwrap();
            assert!(probe.target().is_none());
        }
    }
}
