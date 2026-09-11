use coding_access_native::{
    filesystem::*,
    model::{Agent, Model},
    terminal::*,
};
use std::{fs, path::PathBuf};
fn setup(agent: Agent, window: Option<u64>) -> (tempfile::TempDir, Paths, SessionInput) {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let paths = Paths {
        state: root.join("state"),
        home: root.join("home"),
        isolated: true,
    };
    private_dir(&paths.home).unwrap();
    private_dir(&paths.state).unwrap();
    let input = SessionInput {
        config_directory: None,
        agent,
        executable: std::env::current_exe().unwrap(),
        project: root,
        model: Model {
            id: "temporary".into(),
            name: "测试模型".into(),
            description: String::new(),
            context_window: window,
            max_output_tokens: None,
            vision: None,
        },
        base_url: "http://localhost:4317".into(),
        credential: "synthetic-session-token".into(),
        home: paths.home.clone(),
    };
    (t, paths, input)
}
#[test]
fn temporary_claude_overrides_all_aliases_and_inherited_limits() {
    let (_t, p, input) = setup(Agent::ClaudeCode, None);
    let config = p.home.join(".claude/settings.json");
    atomic_write(&config, b"{\"model\":\"saved-default\"}").unwrap();
    let before = fs::read(&config).unwrap();
    let s = create(&p, &input).unwrap();
    let (d, c) = claim(&p, &s.payload).unwrap();
    assert_eq!(c.env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "");
    assert_eq!(c.env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "");
    for family in ["HAIKU", "SONNET", "OPUS", "FABLE"] {
        assert_eq!(
            c.env[&format!("ANTHROPIC_DEFAULT_{family}_MODEL")],
            "temporary"
        );
    }
    assert_eq!(
        c.env["CLAUDE_CONFIG_DIR"],
        p.home.join(".claude").to_str().unwrap()
    );
    assert!(claim(&p, &s.payload).is_err());
    assert_eq!(fs::read(config).unwrap(), before);
    discard(&d);
    assert!(!d.exists());
}
#[test]
fn codex_auth_is_in_environment_not_shell_arguments() {
    let (_t, p, input) = setup(Agent::CodexCli, Some(1000000));
    let s = create(&p, &input).unwrap();
    let (d, c) = claim(&p, &s.payload).unwrap();
    assert_eq!(c.env["CODING_ACCESS_SESSION_TOKEN"], input.credential);
    assert!(!c.args.join(" ").contains(&input.credential));
    assert!(c.args.contains(&"model_context_window=1000000".into()));
    assert!(c
        .args
        .contains(&"model_auto_compact_token_limit=800000".into()));
    assert!(!p.home.join(".codex/config.toml").exists());
    discard(&d);
}
#[test]
fn shell_paths_cannot_inject_commands() {
    let paths = ["/tmp/空 格 ' ` $() &.exe", "C:\\test's folder\\$(bad).exe"];
    for p in paths {
        let s = terminal_script(
            false,
            &PathBuf::from(p),
            &PathBuf::from(p),
            &PathBuf::from("/root/state/terminal-sessions/session-1/launch.json"),
        )
        .unwrap();
        assert!(s.contains("'\\''"));
        let s = terminal_script(
            true,
            &PathBuf::from(p),
            &PathBuf::from(p),
            &PathBuf::from("/root/state/terminal-sessions/session-1/launch.json"),
        )
        .unwrap();
        assert!(s.contains("''"));
    }
    assert!(terminal_script(
        false,
        &PathBuf::from("/tmp/bad\ncommand"),
        &PathBuf::from("/tmp"),
        &PathBuf::from("/tmp/a")
    )
    .is_err());
}
#[test]
fn invalid_payload_cannot_claim_outside_session_root() {
    let (_t, p, input) = setup(Agent::ClaudeCode, None);
    let s = create(&p, &input).unwrap();
    let foreign = Paths {
        state: p.state.join("other"),
        ..p.clone()
    };
    assert!(claim(&foreign, &s.payload).is_err());
    assert!(s.payload.exists());
    discard(&s.directory);
}
#[test]
fn cleanup_preserves_unexpected_files() {
    let (_t, p, input) = setup(Agent::ClaudeCode, None);
    let s = create(&p, &input).unwrap();
    fs::write(s.directory.join("user-file"), "keep").unwrap();
    discard(&s.directory);
    assert!(s.directory.join("user-file").exists());
    assert!(!s.payload.exists());
}
#[test]
fn concurrent_claim_has_only_one_winner() {
    let (_t, p, input) = setup(Agent::CodexCli, None);
    let s = create(&p, &input).unwrap();
    let handles = (0..2)
        .map(|_| {
            let p = p.clone();
            let payload = s.payload.clone();
            std::thread::spawn(move || claim(&p, &payload).is_ok())
        })
        .collect::<Vec<_>>();
    assert_eq!(
        handles
            .into_iter()
            .map(|h| h.join().unwrap() as usize)
            .sum::<usize>(),
        1
    );
    discard(&s.directory);
}
#[cfg(unix)]
#[tokio::test]
async fn native_runner_executes_and_cleans_its_secret_files() {
    use std::os::unix::fs::PermissionsExt;
    let (_t, p, mut input) = setup(Agent::ClaudeCode, Some(128000));
    let exe = input.project.join("fake claude's CLI");
    fs::write(&exe,"#!/bin/sh\ntest \"$ANTHROPIC_MODEL\" = temporary || exit 41\ntest \"$CLAUDE_CODE_MAX_CONTEXT_TOKENS\" = 128000 || exit 42\ntest \"$ANTHROPIC_DEFAULT_FABLE_MODEL\" = temporary || exit 43\nexit 0\n").unwrap();
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).unwrap();
    input.executable = exe;
    let s = create(&p, &input).unwrap();
    assert_eq!(run_session(&p, &s.payload).await.unwrap(), 0);
    assert!(!s.directory.exists());
}
#[cfg(unix)]
#[test]
fn secrets_have_private_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let (_t, p, input) = setup(Agent::ClaudeCode, None);
    let s = create(&p, &input).unwrap();
    assert_eq!(
        fs::metadata(&s.payload).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&s.directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    discard(&s.directory);
}
