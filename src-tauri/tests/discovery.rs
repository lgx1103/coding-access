use coding_access_native::{filesystem::*, model::Agent, terminal::*};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

fn executable(path: &Path) {
    atomic_write(path, b"#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
}

#[test]
fn cli_distinguishes_real_installations_from_desktop_runners_and_broken_files() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let internal = root.join("ChatGPT.app/Contents/Resources/codex");
    let real = root.join("bin/codex");
    executable(&internal);
    executable(&real);
    assert_eq!(find_cli(Agent::CodexCli, &[internal.clone()], false), None);
    assert_eq!(
        find_cli(Agent::CodexCli, &[internal, real.clone()], false),
        Some(real.clone())
    );
    assert_eq!(
        find_cli(
            Agent::CodexCli,
            &[root.join("missing"), root.join("bin"), real.clone()],
            false
        ),
        Some(real)
    );
    #[cfg(unix)]
    {
        let link = root.join("symlink/codex");
        private_dir(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(root.join("ChatGPT.app/Contents/Resources/codex"), &link)
            .unwrap();
        assert_eq!(find_cli(Agent::CodexCli, &[link], false), None);
        let denied = root.join("no-execute/codex");
        atomic_write(&denied, b"text").unwrap();
        assert_eq!(find_cli(Agent::CodexCli, &[denied], false), None);
    }
}

#[test]
fn cli_covers_npm_bun_pnpm_volta_and_numeric_nvm_versions_without_a_shell() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let env: BTreeMap<String, OsString> = [
        ("PATH", root.join("chosen-bin")),
        ("NPM_CONFIG_PREFIX", root.join("npm-custom")),
        ("BUN_INSTALL", root.join("bun-custom")),
        ("PNPM_HOME", root.join("pnpm-custom")),
        ("VOLTA_HOME", root.join("volta-custom")),
    ]
    .into_iter()
    .map(|(k, p)| (k.into(), p.into_os_string()))
    .collect();
    for version in ["v9.0.0", "v22.9.0", "v22.23.2"] {
        private_dir(&root.join(format!(".nvm/versions/node/{version}/bin"))).unwrap();
    }
    let paths = cli_candidates(Agent::CodexCli, &root, false, &|key| env.get(key).cloned());
    assert_eq!(paths[0], root.join("chosen-bin/codex"));
    for p in [
        "npm-custom/bin/codex",
        "bun-custom/bin/codex",
        "pnpm-custom/codex",
        "volta-custom/bin/codex",
        ".bun/bin/codex",
        ".local/share/pnpm/codex",
    ] {
        assert!(paths.contains(&root.join(p)), "{p}");
    }
    let nvm = paths
        .iter()
        .filter(|p| p.to_string_lossy().contains(".nvm/versions"))
        .collect::<Vec<_>>();
    assert_eq!(nvm[0], &root.join(".nvm/versions/node/v22.23.2/bin/codex"));
    assert_eq!(nvm[2], &root.join(".nvm/versions/node/v9.0.0/bin/codex"));
    for p in [
        "npm-custom/bin/codex",
        "bun-custom/bin/codex",
        "pnpm-custom/codex",
    ] {
        let path = root.join(p);
        executable(&path);
        assert_eq!(find_cli(Agent::CodexCli, &paths, false), Some(path.clone()));
        fs::remove_file(path).unwrap();
    }
}

#[test]
fn windows_cli_and_desktop_paths_honor_custom_installs_and_file_types() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let env: BTreeMap<String, OsString> = [
        ("APPDATA", root.join("Roaming")),
        ("ProgramFiles", root.join("Custom Programs")),
        ("ZCODE_WINDOWS_APP_INSTALL_DIR", root.join("custom-zcode")),
        ("NPM_CONFIG_PREFIX", root.join("npm-prefix")),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into_os_string()))
    .collect();
    let lookup = |k: &str| env.get(k).cloned();
    let cli = cli_candidates(Agent::CodexCli, &root, true, &lookup);
    let cmd = root.join("Roaming/npm/codex.cmd");
    executable(&cmd);
    assert_eq!(find_cli(Agent::CodexCli, &cli, true), Some(cmd));
    assert!(cli.contains(&root.join("npm-prefix/codex.exe")));
    let zcode = windows_desktop_candidates(Agent::Zcode, &root, &lookup);
    assert_eq!(zcode[0], root.join("custom-zcode/ZCode.exe"));
    let codex = windows_desktop_candidates(Agent::CodexDesktop, &root, &lookup);
    assert!(codex.iter().any(|p| p.ends_with("ChatGPT/ChatGPT.exe")));
    assert!(codex.iter().any(|p| p.ends_with("Codex/ChatGPT.exe")));
    assert!(codex.contains(&root.join("Custom Programs/Codex/Codex.exe")));
    assert!(!usable_executable(&root, true));
    assert!(windows_desktop_candidates(Agent::CodexCli, &root, &lookup).is_empty());
}

#[cfg(target_os = "macos")]
fn app(directory: &Path, name: &str, id: &str, valid_executable: bool) -> PathBuf {
    let path = directory.join(name);
    atomic_write(&path.join("Contents/Info.plist"),format!(r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{id}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>Agent</string></dict></plist>"#).as_bytes()).unwrap();
    if valid_executable {
        executable(&path.join("Contents/MacOS/Agent"));
    }
    path
}

#[cfg(target_os = "macos")]
#[test]
fn mac_detection_uses_identity_and_rejects_uninstalled_or_unrelated_apps() {
    use coding_access_native::macos_app::*;
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let codex = app(&root, "ChatGPT.app", "com.openai.codex", true);
    let renamed = app(
        &root.join("elsewhere"),
        "团队工具.app",
        "dev.zcode.app",
        true,
    );
    let chatgpt = app(&root, "Ordinary ChatGPT.app", "com.openai.chat", true);
    let incomplete = app(&root, "Codex.app", "com.openai.codex", false);
    assert!(matches_bundle(&codex, Agent::CodexDesktop));
    assert!(matches_bundle(&renamed, Agent::Zcode));
    assert!(!matches_bundle(&chatgpt, Agent::CodexDesktop));
    assert!(!matches_bundle(&incomplete, Agent::CodexDesktop));
    assert!(!matches_bundle(
        &root.join("removed/ZCode.app"),
        Agent::Zcode
    ));
    assert_eq!(
        find_in_directories(Agent::CodexDesktop, &[root.clone()]),
        Some(codex)
    );
    assert_eq!(
        find_in_directories(Agent::Zcode, &[root.clone(), root.join("elsewhere")]),
        Some(renamed)
    );
    assert_eq!(bundle_id(Agent::CodexCli), None);
}
