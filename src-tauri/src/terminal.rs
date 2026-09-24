use crate::{
    config::{claude_configuration, json_object},
    filesystem::*,
    model::{Agent, Model},
    Result,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub agent: Agent,
    pub executable: PathBuf,
    pub project: PathBuf,
    pub model: Model,
    pub base_url: String,
    pub credential: String,
    pub home: PathBuf,
    #[serde(default)]
    pub config_directory: Option<PathBuf>,
}
pub struct SessionCommand {
    pub executable: PathBuf,
    pub project: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub label: String,
}
pub struct Session {
    pub directory: PathBuf,
    pub payload: PathBuf,
}
fn valid_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_prefix("session-"))
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .is_some()
}
fn text_path(p: &Path) -> Result<String> {
    let s = p.to_str().ok_or("路径编码不受支持")?;
    if s.chars().any(char::is_control) {
        return Err("路径包含不支持的控制字符".into());
    }
    Ok(s.into())
}
pub fn discard(directory: &Path) {
    if !valid_name(directory) || no_links(directory).is_err() {
        return;
    }
    for name in [
        "launch.json",
        "claimed.json",
        "claude-settings.json",
        "launch.command",
        "owner.json",
    ] {
        let _ = fs::remove_file(directory.join(name));
    }
    let _ = fs::remove_dir(directory);
}
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        discard(&self.0);
    }
}
pub fn create(paths: &Paths, input: &SessionInput) -> Result<Session> {
    if input.agent.desktop()
        || input.credential.is_empty()
        || !input.executable.is_file()
        || !input.project.is_dir()
        || input.home != paths.home
    {
        return Err("临时会话配置无效，请检查工具和项目目录".into());
    }
    text_path(&input.executable)?;
    text_path(&input.project)?;
    input.model.validate()?;
    crate::client::base_url(&input.base_url)?;
    let directory = paths
        .state
        .join("terminal-sessions")
        .join(format!("session-{}", uuid::Uuid::new_v4()));
    private_dir(&directory)?;
    let payload = directory.join("launch.json");
    let mut input = input.clone();
    input.config_directory = Some(paths.config_directory(input.agent));
    let result = save_json(
        &directory.join("owner.json"),
        &json!({"createdAt":now(),"pid":null}),
    )
    .and_then(|_| save_json(&payload, &input));
    if let Err(e) = result {
        discard(&directory);
        return Err(e);
    }
    Ok(Session { directory, payload })
}
pub fn command(directory: &Path, input: SessionInput) -> Result<SessionCommand> {
    input.model.validate()?;
    crate::client::base_url(&input.base_url)?;
    if input.agent.desktop() || input.credential.is_empty() || !input.project.is_dir() {
        return Err("临时会话配置无效".into());
    }
    text_path(&input.project)?;
    text_path(&input.executable)?;
    let config_directory = input.config_directory.clone().unwrap_or_else(|| {
        input.home.join(if input.agent == Agent::ClaudeCode {
            ".claude"
        } else {
            ".codex"
        })
    });
    no_links(&config_directory)?;
    let mut env = BTreeMap::new();
    let mut args = vec![];
    if input.agent == Agent::ClaudeCode {
        let mut settings = json_object(&claude_configuration(
            "{}",
            &input.base_url,
            &input.credential,
            &input.model,
            &[],
        )?)?;
        for (k, v) in [
            (
                "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
                input
                    .model
                    .context_window
                    .map(|n| n.to_string())
                    .unwrap_or_default(),
            ),
            (
                "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
                input
                    .model
                    .max_output_tokens
                    .map(|n| n.to_string())
                    .unwrap_or_default(),
            ),
            ("CLAUDE_CODE_USE_BEDROCK", "0".into()),
            ("CLAUDE_CODE_USE_VERTEX", "0".into()),
            ("CLAUDE_CODE_USE_FOUNDRY", "0".into()),
            ("ANTHROPIC_CUSTOM_HEADERS", String::new()),
        ] {
            settings["env"][k] = json!(v);
        }
        for (k, v) in settings["env"].as_object().unwrap() {
            env.insert(k.clone(), v.as_str().unwrap().into());
        }
        let p = directory.join("claude-settings.json");
        save_json(&p, &settings)?;
        args.extend([
            "--settings".into(),
            text_path(&p)?,
            "--model".into(),
            input.model.id.clone(),
        ]);
        env.insert("CLAUDE_CONFIG_DIR".into(), text_path(&config_directory)?);
    } else {
        let provider = format!(
            "coding_access_session_{}",
            directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .replace('-', "_")
        );
        let mut overrides = BTreeMap::from([
            ("model".into(), json!(input.model.id)),
            ("model_provider".into(), json!(provider)),
            ("web_search".into(), json!("disabled")),
            ("features.enable_request_compression".into(), json!(false)),
            ("features.respect_system_proxy".into(), json!(true)),
        ]);
        for (k, v) in [
            ("name", json!("Coding Access")),
            (
                "base_url",
                json!(format!("{}/v1", input.base_url.trim_end_matches('/'))),
            ),
            ("wire_api", json!("responses")),
            ("env_key", json!("CODING_ACCESS_SESSION_TOKEN")),
            ("requires_openai_auth", json!(false)),
            ("supports_websockets", json!(false)),
            ("request_max_retries", json!(0)),
            ("stream_max_retries", json!(0)),
        ] {
            overrides.insert(format!("model_providers.{provider}.{k}"), v);
        }
        if let Some(n) = input.model.context_window {
            overrides.insert("model_context_window".into(), json!(n));
            overrides.insert(
                "model_auto_compact_token_limit".into(),
                json!((n * 4 / 5).max(1024)),
            );
        }
        for (k, v) in overrides {
            args.extend(["-c".into(), format!("{k}={v}")]);
        }
        env.insert("CODING_ACCESS_SESSION_TOKEN".into(), input.credential);
        env.insert("CODEX_HOME".into(), text_path(&config_directory)?);
    }
    Ok(SessionCommand {
        executable: input.executable,
        project: input.project,
        args,
        env,
        label: input
            .model
            .name
            .chars()
            .filter(|c| !c.is_control())
            .collect(),
    })
}
pub fn claim(paths: &Paths, payload: &Path) -> Result<(PathBuf, SessionCommand)> {
    let directory = payload.parent().ok_or("临时会话路径无效")?;
    if payload.file_name().and_then(|s| s.to_str()) != Some("launch.json")
        || !valid_name(directory)
        || directory.parent() != Some(paths.state.join("terminal-sessions").as_path())
    {
        return Err("临时会话路径无效".into());
    }
    no_links(payload)?;
    let claimed = directory.join("claimed.json");
    // An OS-level rename claims the payload exactly once. A second invocation
    // cannot replay credentials, even while the first CLI is still running.
    fs::rename(payload, &claimed).map_err(|_| "临时会话已使用或已过期，请从客户端重新打开")?;
    let result = (|| {
        save_json(
            &directory.join("owner.json"),
            &json!({"createdAt":now(),"pid":std::process::id()}),
        )?;
        let source = read_optional(&claimed)?.ok_or("临时会话已过期")?;
        let input: SessionInput = serde_json::from_str(&source).map_err(|_| "临时会话配置无效")?;
        fs::remove_file(claimed).map_err(|_| "无法清理临时凭证")?;
        if input.home != paths.home {
            return Err("临时会话的配置目录不匹配".into());
        }
        command(directory, input)
    })();
    match result {
        Ok(c) => Ok((directory.into(), c)),
        Err(e) => {
            discard(directory);
            Err(e)
        }
    }
}
pub fn shell_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', "'\\''"))
}
pub fn powershell_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}
fn windows_argument(v: &str) -> String {
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for ch in v.chars() {
        if ch == '\\' {
            slashes += 1;
        } else {
            quoted.push_str(&"\\".repeat(if ch == '"' { slashes * 2 + 1 } else { slashes }));
            quoted.push(ch);
            slashes = 0;
        }
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}
pub fn terminal_script_mode(
    windows: bool,
    runtime: &Path,
    project: &Path,
    payload: &Path,
    isolated: bool,
) -> Result<String> {
    let exe = text_path(runtime)?;
    let project = text_path(project)?;
    let root = payload
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or("临时会话目录无效")?;
    let root = text_path(root)?;
    let payload = text_path(payload)?;
    let root_flag = if isolated {
        format!(
            " --development-root {}",
            if windows {
                windows_argument(&root)
            } else {
                shell_quote(&root)
            }
        )
    } else {
        String::new()
    };
    if windows {
        // PowerShell does not otherwise wait for a GUI-subsystem executable.
        // Keep console I/O attached instead of piping the interactive CLI.
        let arguments = format!(
            "--terminal-session {}{}",
            windows_argument(&payload),
            root_flag
        );
        Ok(format!(
            "Set-Location -LiteralPath {}; Start-Process -FilePath {} -ArgumentList {} -NoNewWindow -Wait",
            powershell_quote(&project),
            powershell_quote(&exe),
            powershell_quote(&arguments)
        ))
    } else {
        Ok(format!(
            "#!/bin/zsh\ncd -- {} || exit\n{} --terminal-session {}{}\nexec /bin/zsh -l\n",
            shell_quote(&project),
            shell_quote(&exe),
            shell_quote(&payload),
            root_flag
        ))
    }
}
pub(crate) fn encoded_ps(script: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    )
}
pub fn terminal_script(
    windows: bool,
    runtime: &Path,
    project: &Path,
    payload: &Path,
) -> Result<String> {
    terminal_script_mode(windows, runtime, project, payload, true)
}
pub async fn launch_terminal(session: &Session, project: &Path, paths: &Paths) -> Result<()> {
    launch_terminal_with(session, project, paths, "").await
}
pub async fn launch_terminal_with(
    session: &Session,
    project: &Path,
    paths: &Paths,
    terminal: &str,
) -> Result<()> {
    let runtime = std::env::current_exe().map_err(|_| "无法定位客户端运行程序")?;
    let script = terminal_script_mode(
        cfg!(windows),
        &runtime,
        project,
        &session.payload,
        paths.isolated,
    )?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = session.directory.join("launch.command");
        atomic_write(&path, script.as_bytes())?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法设置启动脚本权限")?;
        let s = tokio::process::Command::new("/usr/bin/open")
            .args([
                "-a",
                if terminal == "iTerm" {
                    "iTerm"
                } else {
                    "Terminal"
                },
            ])
            .arg(path)
            .status()
            .await
            .map_err(|_| "无法打开终端")?;
        if !s.success() {
            return Err("无法打开终端".into());
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new(if terminal == "wt" {
            "wt.exe"
        } else {
            "powershell.exe"
        });
        if terminal == "wt" {
            command.arg("powershell.exe");
        }
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NoExit",
                "-EncodedCommand",
                &encoded_ps(&script),
            ])
            .creation_flags(0x00000010)
            .spawn()
            .map_err(|_| "无法打开终端")?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = script;
        Err("终端启动当前支持 macOS 和 Windows".into())
    }
}
pub async fn run_session(paths: &Paths, payload: &Path) -> Result<i32> {
    let (directory, c) = claim(paths, payload)?;
    let _cleanup = Cleanup(directory);
    let mut command = if cfg!(windows)
        && [Some("cmd"), Some("bat")].contains(&c.executable.extension().and_then(|s| s.to_str()))
    {
        let script = format!(
            "& {}\nexit $LASTEXITCODE",
            std::iter::once(text_path(&c.executable)?)
                .chain(c.args.clone())
                .map(|s| powershell_quote(&s))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let mut x = tokio::process::Command::new("powershell.exe");
        x.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded_ps(&script),
        ]);
        x
    } else {
        let mut x = tokio::process::Command::new(&c.executable);
        x.args(&c.args);
        x
    };
    println!("Coding Access · {} · 临时会话（默认模型未更改）\n", c.label);
    let mut child = command
        .current_dir(c.project)
        .envs(c.env)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "无法启动编程工具，请检查安装和项目目录")?;
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut hup = signal(SignalKind::hangup()).map_err(|_| "无法接收终端信号")?;
        let mut term = signal(SignalKind::terminate()).map_err(|_| "无法接收终端信号")?;
        loop {
            tokio::select! {s=child.wait()=>return s.map(|s|s.code().unwrap_or(1)).map_err(|_|"编程工具运行失败".into()),_=tokio::signal::ctrl_c()=>{/* Foreground CLI receives SIGINT too; it owns cancel behavior. */},_=hup.recv()=>{let _=child.kill().await;return Ok(129);},_=term.recv()=>{let _=child.kill().await;return Ok(143);}}
        }
    }
    #[cfg(not(unix))]
    {
        loop {
            tokio::select! {s=child.wait()=>return s.map(|s|s.code().unwrap_or(1)).map_err(|_|"编程工具运行失败".into()),_=tokio::signal::ctrl_c()=>{}}
        }
    }
}
/// Find installed CLIs without executing shell startup files or desktop bundles.
pub fn usable_executable(path: &Path, windows: bool) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    if !windows {
        use std::os::unix::fs::PermissionsExt;
        return metadata.permissions().mode() & 0o111 != 0;
    }
    let _ = windows;
    true
}

fn inside_app(path: &Path) -> bool {
    path.components().any(|p| {
        p.as_os_str()
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".app")
    })
}

pub fn cli_candidates(
    agent: Agent,
    home: &Path,
    windows: bool,
    env: &dyn Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<PathBuf> {
    if agent.desktop() {
        return vec![];
    }
    let name = if agent == Agent::ClaudeCode {
        "claude"
    } else {
        "codex"
    };
    let mut dirs = vec![];
    if let Some(path) = env("PATH") {
        if windows {
            dirs.extend(
                path.to_string_lossy()
                    .split(';')
                    .filter(|s| !s.is_empty())
                    .map(|p| PathBuf::from(p.trim_matches('"'))),
            );
        } else {
            dirs.extend(std::env::split_paths(&path).filter(|p| !p.as_os_str().is_empty()));
        }
    }
    for variable in ["PNPM_HOME", "NVM_SYMLINK"] {
        if let Some(path) = env(variable).filter(|s| !s.is_empty()) {
            dirs.push(path.into());
        }
    }
    for variable in ["VOLTA_HOME", "BUN_INSTALL"] {
        if let Some(path) = env(variable).filter(|s| !s.is_empty()) {
            dirs.push(PathBuf::from(path).join("bin"));
        }
    }
    for variable in ["NPM_CONFIG_PREFIX", "npm_config_prefix"] {
        if let Some(path) = env(variable).filter(|s| !s.is_empty()) {
            let prefix = PathBuf::from(path);
            dirs.push(if windows { prefix } else { prefix.join("bin") });
        }
    }
    dirs.extend([
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
        home.join(".volta/bin"),
    ]);
    if windows {
        let appdata = env("APPDATA")
            .map(PathBuf::from)
            .unwrap_or(home.join("AppData/Roaming"));
        let local = env("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or(home.join("AppData/Local"));
        dirs.extend([
            appdata.join("npm"),
            local.join("pnpm"),
            home.join("scoop/shims"),
        ]);
    } else {
        let data = env("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or(home.join(".local/share"));
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            data.join("pnpm"),
            home.join(".asdf/shims"),
            home.join(".nix-profile/bin"),
        ]);
        if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions = entries.flatten().map(|e| e.path()).collect::<Vec<_>>();
            versions.sort_by_cached_key(|p| {
                p.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .trim_start_matches('v')
                    .split('.')
                    .map(|s| s.parse::<u64>().unwrap_or(0))
                    .collect::<Vec<_>>()
            });
            dirs.extend(versions.into_iter().rev().map(|p| p.join("bin")));
        }
    }
    let mut candidates = vec![];
    for dir in dirs {
        for suffix in if windows {
            vec![".exe", ".cmd", ".bat", ""]
        } else {
            vec![""]
        } {
            let candidate = dir.join(format!("{name}{suffix}"));
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
    }
    candidates
}

pub fn find_cli(agent: Agent, candidates: &[PathBuf], windows: bool) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|p| {
            if !usable_executable(p, windows) {
                return false;
            }
            // Codex desktop exposes its internal runner in this development host's
            // PATH. That is not a standalone CLI installation for colleagues.
            !(agent == Agent::CodexCli
                && (inside_app(p) || fs::canonicalize(p).ok().is_some_and(|p| inside_app(&p))))
        })
        .cloned()
}

pub fn windows_desktop_candidates(
    agent: Agent,
    home: &Path,
    env: &dyn Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<PathBuf> {
    if !agent.desktop() {
        return vec![];
    }
    let name = if agent == Agent::Zcode {
        "ZCode"
    } else {
        "Codex"
    };
    let local = env("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or(home.join("AppData/Local"));
    let mut candidates = vec![];
    // Match the existing documented ZCode override before default locations.
    if agent == Agent::Zcode {
        if let Some(root) = env("ZCODE_WINDOWS_APP_INSTALL_DIR").filter(|s| !s.is_empty()) {
            candidates.push(PathBuf::from(root).join("ZCode.exe"));
        }
    }
    candidates.extend([
        local.join(format!("Programs/{name}/{name}.exe")),
        local.join(format!("{name}/{name}.exe")),
    ]);
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(root) = env(variable).filter(|s| !s.is_empty()) {
            candidates.push(PathBuf::from(root).join(format!("{name}/{name}.exe")));
        }
    }
    candidates.push(PathBuf::from(format!("C:/Program Files/{name}/{name}.exe")));
    if agent == Agent::CodexDesktop {
        // The desktop app now displays ChatGPT; retain old Codex installs too.
        let mut roots = vec![
            local.join("Programs"),
            local,
            PathBuf::from("C:/Program Files"),
        ];
        for variable in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(root) = env(variable).filter(|s| !s.is_empty()) {
                roots.push(PathBuf::from(root));
            }
        }
        for root in roots {
            for (directory, executable) in [
                ("ChatGPT", "ChatGPT.exe"),
                ("Codex", "ChatGPT.exe"),
                ("ChatGPT", "Codex.exe"),
            ] {
                let path = root.join(directory).join(executable);
                if !candidates.contains(&path) {
                    candidates.push(path);
                }
            }
        }
    }
    candidates
}

pub fn locate_tool(agent: Agent) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    if agent.desktop() {
        #[cfg(target_os = "macos")]
        return crate::macos_app::locate(agent);
        #[cfg(target_os = "windows")]
        return windows_desktop_candidates(agent, &home, &|name| std::env::var_os(name))
            .into_iter()
            .find(|p| {
                usable_executable(p, true)
                    && (agent != Agent::CodexDesktop
                        || p.parent()
                            .is_some_and(|dir| dir.join("resources/app.asar").is_file()))
            });
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        return None;
    }
    find_cli(
        agent,
        &cli_candidates(agent, &home, cfg!(windows), &|name| std::env::var_os(name)),
        cfg!(windows),
    )
}
pub fn clean_stale(paths: &Paths) {
    let root = paths.state.join("terminal-sessions");
    if no_links(&root).is_err() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !valid_name(&p) || no_links(&p).is_err() {
            continue;
        }
        let Ok(Some(s)) = read_optional(&p.join("owner.json")) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) else {
            continue;
        };
        if v["pid"].is_null()
            && v["createdAt"]
                .as_u64()
                .is_some_and(|t| now().saturating_sub(t) > 86400000)
        {
            discard(&p);
        }
        #[cfg(unix)]
        if let Some(pid) = v["pid"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= i32::MAX as u64)
        {
            let result = unsafe { libc::kill(pid as i32, 0) };
            if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                discard(&p);
            }
        }
    }
}
