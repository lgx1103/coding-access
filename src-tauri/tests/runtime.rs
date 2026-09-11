use coding_access_native::{
    agents::valid_store_id, filesystem::*, model::Agent, terminal::terminal_script_mode,
};
use std::path::Path;

#[test]
fn custom_agent_directories_follow_electron_conventions() {
    let home = Path::new("/example/home");
    assert_eq!(
        config_directory(home, Agent::ClaudeCode, None),
        home.join(".claude")
    );
    assert_eq!(
        config_directory(home, Agent::CodexDesktop, Some(Path::new("alternate"))),
        home.join("alternate")
    );
    assert_eq!(
        config_directory(home, Agent::ClaudeCode, Some(Path::new("/custom/claude"))),
        Path::new("/custom/claude")
    );
    assert_eq!(
        config_directory(home, Agent::Zcode, Some(Path::new("alternate"))),
        home.join("alternate/.zcode/v2")
    );
}

#[test]
fn packaged_terminal_runner_keeps_production_paths_and_quotes_arguments() {
    for windows in [false, true] {
        let script = terminal_script_mode(
            windows,
            Path::new("/Applications/QA's app/exe"),
            Path::new("/project 中文"),
            Path::new("/data/state/terminal-sessions/session-test/launch.json"),
            false,
        )
        .unwrap();
        assert!(!script.contains("--development-root"));
        assert!(script.contains("--terminal-session"));
        let isolated = terminal_script_mode(
            windows,
            Path::new("/exe"),
            Path::new("/project"),
            Path::new("/data/state/terminal-sessions/session-test/launch.json"),
            true,
        )
        .unwrap();
        assert!(isolated.contains(if windows {
            "--development-root \"/data\""
        } else {
            "--development-root '/data'"
        }));
        if windows {
            assert!(script.contains("-NoNewWindow -Wait"));
            assert!(!script.contains("| Out-"));
        }
    }
}

#[test]
fn store_ids_cannot_inject_shell_commands() {
    assert!(valid_store_id("OpenAI.Codex_abcd123!App"));
    for id in [
        "",
        "bad!",
        "!bad",
        "bad!!App",
        "x!App;calc",
        "x!App\n",
        "x/../y!App",
    ] {
        assert!(!valid_store_id(id));
    }
}
