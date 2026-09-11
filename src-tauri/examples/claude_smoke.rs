//! Opt-in real Claude /context check. Synthetic credentials, loopback only.
use coding_access_native::{
    client::base_url,
    config::ConfigManager,
    filesystem::*,
    model::{Agent, Model},
    terminal::*,
};
use serde_json::json;
use std::process::Stdio;
#[tokio::main]
async fn main() {
    let base = base_url(
        &std::env::args()
            .nth(1)
            .expect("loopback fixture URL required"),
    )
    .unwrap();
    assert_eq!(
        url::Url::parse(&base).unwrap().host_str(),
        Some("127.0.0.1")
    );
    let executable = locate_tool(Agent::ClaudeCode).expect("Claude Code must be installed");
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let paths = Paths {
        state: root.join("state"),
        home: root.join("home"),
        isolated: true,
    };
    private_dir(&paths.home).unwrap();
    private_dir(&paths.state).unwrap();
    let manager = ConfigManager {
        paths: paths.clone(),
    };
    let model = Model {
        id: "glm-5.3-flash".into(),
        name: "GLM 测试".into(),
        description: String::new(),
        context_window: Some(1000000),
        max_output_tokens: None,
        vision: None,
    };
    manager
        .apply(
            Agent::ClaudeCode,
            &model,
            &base,
            "synthetic-loopback-token",
            "test",
        )
        .unwrap();
    let before = std::fs::read(manager.path(Agent::ClaudeCode)).unwrap();
    let mut checks = vec![];
    for (name, window, temporary) in [
        ("saved default 1M", Some(1000000), false),
        ("Fable alias 1M", Some(1000000), false),
        ("temporary 128K", Some(128000), true),
        ("temporary unknown", None, true),
    ] {
        let mut cmd = tokio::process::Command::new(&executable);
        for (key, _) in std::env::vars() {
            if [
                "ANTHROPIC",
                "OPENAI",
                "CLAUDE",
                "CODEX",
                "TOKEN",
                "SECRET",
                "PASSWORD",
                "PROXY",
                "DISABLE_COMPACT",
            ]
            .iter()
            .any(|p| key.to_uppercase().contains(p))
            {
                cmd.env_remove(key);
            }
        }
        cmd.current_dir(&root)
            .env("CLAUDE_CONFIG_DIR", paths.home.join(".claude"))
            .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
            .env("DISABLE_AUTOUPDATER", "1")
            .env("NO_PROXY", "127.0.0.1,localhost");
        cmd.args([
            "--safe-mode",
            "--setting-sources",
            "user",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--tools",
            "",
            "-p",
            "/context",
        ]);
        if name.starts_with("Fable") {
            cmd.args(["--model", "fable"]);
        }
        let session = if temporary {
            let input = SessionInput {
                config_directory: None,
                agent: Agent::ClaudeCode,
                executable: executable.clone(),
                project: root.clone(),
                model: Model {
                    id: "temporary-custom".into(),
                    context_window: window,
                    ..model.clone()
                },
                base_url: base.clone(),
                credential: "synthetic-loopback-token".into(),
                home: paths.home.clone(),
            };
            let session = create(&paths, &input).unwrap();
            let (_, c) = claim(&paths, &session.payload).unwrap();
            cmd.args(c.args).envs(c.env);
            Some(session)
        } else {
            None
        };
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            cmd.stdin(Stdio::null()).kill_on_drop(true).output(),
        )
        .await
        .expect("CLI timeout")
        .unwrap();
        if let Some(session) = session {
            discard(&session.directory);
        }
        assert!(out.status.success(), "Claude /context failed");
        let stdout = String::from_utf8_lossy(&out.stdout);
        let expected = if !temporary {
            "1.0M"
        } else if window.is_some() {
            "128k"
        } else {
            "200k"
        };
        assert!(
            stdout
                .to_ascii_lowercase()
                .contains(&expected.to_ascii_lowercase())
                || (expected == "1.0M" && stdout.to_ascii_lowercase().contains("1m")),
            "Unexpected context for {name}: {stdout}"
        );
        assert_eq!(
            std::fs::read(manager.path(Agent::ClaudeCode)).unwrap(),
            before
        );
        checks.push(json!({"name":name,"passed":true,"context":expected}));
    }
    manager.restore(Agent::ClaudeCode).unwrap();
    println!(
        "{}",
        json!({"checks":checks,"savedDefaultUnchanged":true,"restorePassed":!manager.path(Agent::ClaudeCode).exists()})
    );
}
