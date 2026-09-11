use coding_access_native::{
    config::*,
    filesystem::*,
    migration::*,
    model::{Agent, Model},
};
use serde_json::{json, Value};
use std::fs;

fn model() -> Model {
    Model {
        id: "legacy-model".into(),
        name: "Old default".into(),
        description: String::new(),
        context_window: Some(1000000),
        max_output_tokens: Some(64000),
        vision: Some(true),
    }
}
fn fixture(agents: &[Agent], original: bool) -> (tempfile::TempDir, Source, Paths) {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let old = ConfigManager {
        paths: Paths::development_at(root.join("old")).unwrap(),
    };
    save_json(
        &old.paths.state.join("preferences.json"),
        &json!({"serverUrl":"http://127.0.0.1:4317", "projectDirectory":root}),
    )
    .unwrap();
    // Deliberately invalid ciphertext: migration must never try to decode it.
    atomic_write(&old.paths.state.join("credentials.enc"), &[0xff, 0, 0x80]).unwrap();
    for a in agents {
        if original {
            atomic_write(
                &old.path(*a),
                if a.codex() {
                    b"# personal\nmodel = 'personal'\n"
                } else {
                    b"{\n// personal\n\"theme\":\"light\",\"enabledPlugins\":{\"hud\":true}}\n"
                },
            )
            .unwrap();
        }
        old.apply(
            *a,
            &model(),
            "http://127.0.0.1:4317",
            "dummy-old-credential",
            "old-id",
        )
        .unwrap();
    }
    let source = Source {
        directory: old.paths.state,
        user_home: old.paths.home,
    };
    let dest = Paths::development_at(root.join("new")).unwrap();
    (t, source, dest)
}
fn import_all(source: &Source, dest: &Paths) -> Receipt {
    let preview = source.preview().unwrap();
    assert!(preview.agents.iter().all(|a| a.status == "ready"));
    import(dest, source, &preview.fingerprint).unwrap()
}

#[test]
fn production_handoff_preserves_active_file_until_apply_and_original_backup_afterward() {
    let (_t, s, p) = fixture(&[Agent::ClaudeCode, Agent::CodexCli, Agent::Zcode], true);
    let production = Paths::production_at(s.user_home.clone(), p.state.clone()).unwrap();
    let manager = ConfigManager {
        paths: production.clone(),
    };
    let originals: std::collections::BTreeMap<String, Record> =
        read_json(&s.directory.join("config-records.json")).unwrap();
    let active: Vec<_> = [Agent::ClaudeCode, Agent::CodexCli, Agent::Zcode]
        .into_iter()
        .map(|a| (a, fs::read(manager.path(a)).unwrap()))
        .collect();
    import_all(&s, &production);
    for (a, bytes) in &active {
        assert_eq!(fs::read(manager.path(*a)).unwrap(), *bytes);
    }
    undo(&production).unwrap();
    for (a, bytes) in &active {
        assert_eq!(fs::read(manager.path(*a)).unwrap(), *bytes);
    }
    import_all(&s, &production);
    assert_eq!(
        manager.configured(Some("new-id")).unwrap()["claude-code"]["needsUpdate"],
        true
    );
    for (a, _) in active {
        let earliest = fs::read(originals[a.key()].backup.as_ref().unwrap()).unwrap();
        manager
            .apply(
                a,
                &model(),
                "http://localhost:4317",
                "new-test-token",
                "new-id",
            )
            .unwrap();
        manager.restore(a).unwrap();
        assert_eq!(fs::read(manager.path(a)).unwrap(), earliest);
        // Restoring under the new client must not re-trigger old import guards.
        manager
            .apply(
                a,
                &model(),
                "http://localhost:4317",
                "new-test-token",
                "new-id",
            )
            .unwrap();
        manager.restore(a).unwrap();
        assert_eq!(fs::read(manager.path(a)).unwrap(), earliest);
    }
}

#[test]
fn skipped_production_import_cannot_replace_the_original_backup() {
    let (_t, s, p) = fixture(&[Agent::ClaudeCode], true);
    let production = Paths::production_at(s.user_home.clone(), p.state).unwrap();
    let manager = ConfigManager {
        paths: production.clone(),
    };
    atomic_write(
        &manager.path(Agent::ClaudeCode),
        b"{\"theme\":\"external\"}",
    )
    .unwrap();
    let v = s.preview().unwrap();
    assert_eq!(v.agents[0].status, "skipped");
    import(&production, &s, &v.fingerprint).unwrap();
    assert!(manager
        .apply(
            Agent::ClaudeCode,
            &model(),
            "http://localhost",
            "new-test-token",
            "new-id"
        )
        .unwrap_err()
        .contains("冲突"));
    assert_eq!(
        fs::read_to_string(manager.path(Agent::ClaudeCode)).unwrap(),
        "{\"theme\":\"external\"}"
    );
}

#[test]
fn import_preserves_original_backup_through_new_login_apply_and_restore() {
    let (_t, s, p) = fixture(&[Agent::ClaudeCode, Agent::CodexCli, Agent::Zcode], true);
    let old = ConfigManager {
        paths: Paths {
            state: s.directory.clone(),
            home: s.user_home.clone(),
            isolated: true,
        },
    };
    let old_records = old.records().unwrap();
    let before = read_optional(&s.directory.join("config-records.json")).unwrap();
    import_all(&s, &p);
    let m = ConfigManager { paths: p.clone() };
    assert_eq!(
        m.configured(None).unwrap()["claude-code"]["needsUpdate"],
        true
    );
    for a in [Agent::ClaudeCode, Agent::CodexCli, Agent::Zcode] {
        let data = read_optional(&m.path(a)).unwrap().unwrap();
        assert!(!data.contains("dummy-old-credential"));
        assert!(data.contains("migration-login-required"));
        let original = read_optional(old_records[a.key()].backup.as_ref().unwrap()).unwrap();
        assert_eq!(
            read_optional(m.records().unwrap()[a.key()].backup.as_ref().unwrap()).unwrap(),
            original
        );
        m.apply(
            a,
            &model(),
            "http://127.0.0.1:4317",
            "dummy-new-credential",
            "new-id",
        )
        .unwrap();
        m.restore(a).unwrap();
        assert_eq!(read_optional(&m.path(a)).unwrap(), original);
    }
    assert_eq!(
        read_optional(&s.directory.join("config-records.json")).unwrap(),
        before
    );
    assert_eq!(
        fs::read(s.directory.join("credentials.enc")).unwrap(),
        [0xff, 0, 0x80]
    );
}
#[test]
fn absent_original_and_old_record_without_capability_revision_work() {
    let (_t, s, p) = fixture(&[Agent::ClaudeCode], false);
    let record_path = s.directory.join("config-records.json");
    let mut v: Value = read_json(&record_path).unwrap();
    v["claude-code"]
        .as_object_mut()
        .unwrap()
        .remove("claudeConfigRevision");
    v["claude-code"]
        .as_object_mut()
        .unwrap()
        .remove("managedCapabilities");
    save_json(&record_path, &v).unwrap();
    import_all(&s, &p);
    let m = ConfigManager { paths: p };
    m.restore(Agent::ClaudeCode).unwrap();
    assert!(!m.path(Agent::ClaudeCode).exists());
}
#[test]
fn drift_and_missing_backup_are_skipped_without_false_applied_state() {
    let (_t, s, p) = fixture(&[Agent::ClaudeCode, Agent::CodexCli], true);
    atomic_write(
        &s.user_home.join(".claude/settings.json"),
        b"{\"theme\":\"external\"}",
    )
    .unwrap();
    let records: Value = read_json(&s.directory.join("config-records.json")).unwrap();
    fs::remove_file(records["codex"]["backup"].as_str().unwrap()).unwrap();
    let v = s.preview().unwrap();
    assert!(v.agents.iter().all(|a| a.status == "skipped"));
    import(&p, &s, &v.fingerprint).unwrap();
    assert!(ConfigManager { paths: p }.records().unwrap().is_empty());
}
#[test]
fn benign_zcode_metadata_survives_import_and_restore() {
    let (_t, s, p) = fixture(&[Agent::Zcode], true);
    let path = s.user_home.join(".zcode/v2/config.json");
    let mut v = json_object(&read_optional(&path).unwrap().unwrap()).unwrap();
    v["theme"] = json!("dark");
    v["provider"]["coding_access"]["source"] = json!("custom");
    save_json(&path, &v).unwrap();
    import_all(&s, &p);
    let m = ConfigManager { paths: p };
    m.restore(Agent::Zcode).unwrap();
    let v = json_object(&read_optional(&m.path(Agent::Zcode)).unwrap().unwrap()).unwrap();
    assert_eq!(v["theme"], "dark");
    assert!(v["provider"].get("coding_access").is_none());
}
#[test]
fn stale_preview_existing_destination_and_duplicate_import_are_rejected() {
    let (_t, s, p) = fixture(&[Agent::ClaudeCode], false);
    let before = s.preview().unwrap();
    save_json(
        &s.directory.join("preferences.json"),
        &json!({"serverUrl":"http://localhost:4317"}),
    )
    .unwrap();
    assert!(import(&p, &s, &before.fingerprint)
        .unwrap_err()
        .contains("变化"));
    atomic_write(&p.home.join(".claude/settings.json"), b"{}").unwrap();
    let next = s.preview().unwrap();
    assert!(import(&p, &s, &next.fingerprint).is_err());
    fs::remove_file(p.home.join(".claude/settings.json")).unwrap();
    import_all(&s, &p);
    assert!(import(&p, &s, &next.fingerprint)
        .unwrap_err()
        .contains("重复导入"));
}
#[test]
fn undo_restores_destination_and_refuses_external_edits() {
    let (_t, s, p) = fixture(&[Agent::ClaudeCode], true);
    let prefs = b"{\"serverUrl\":\"http://localhost:1234\"}";
    atomic_write(&p.state.join("preferences.json"), prefs).unwrap();
    import_all(&s, &p);
    let config = p.home.join(".claude/settings.json");
    let imported = fs::read(&config).unwrap();
    atomic_write(&config, b"{}").unwrap();
    assert!(undo(&p).is_err());
    assert!(receipt(&p).unwrap().is_some());
    atomic_write(&config, &imported).unwrap();
    undo(&p).unwrap();
    assert!(!config.exists());
    assert!(!p.state.join("config-records.json").exists());
    assert!(receipt(&p).unwrap().is_none());
    assert_eq!(fs::read(p.state.join("preferences.json")).unwrap(), prefs);
    assert_eq!(fs::read_dir(p.state.join("backups")).unwrap().count(), 0);
    import_all(&s, &p);
}
#[test]
fn interrupted_import_and_undo_recover_idempotently() {
    for undo_mode in [false, true] {
        let (_t, s, p) = fixture(&[Agent::ClaudeCode], true);
        import_all(&s, &p);
        let committed = p.state.join("legacy-migration.json");
        let mut tx: Value = read_json(&committed).unwrap();
        if undo_mode {
            tx["rollbackOf"] = tx["receipt"]["id"].clone();
            tx["receipt"]["id"] = json!("undo-id");
            // Simulate crash after undo journal, before deleting old receipt.
        } else {
            fs::remove_file(&committed).unwrap();
            // Simulate partially written import.
            fs::remove_file(p.state.join("preferences.json")).unwrap();
        }
        save_json(&p.state.join("legacy-migration-pending.json"), &tx).unwrap();
        recover(&p).unwrap();
        recover(&p).unwrap();
        assert!(!committed.exists());
        assert!(!p.home.join(".claude/settings.json").exists());
        assert!(!p.state.join("config-records.json").exists());
        assert!(!p.state.join("legacy-migration-pending.json").exists());
    }
}
#[test]
fn interrupted_recovery_refuses_to_overwrite_new_edits() {
    let (_t, s, p) = fixture(&[Agent::ClaudeCode], true);
    import_all(&s, &p);
    fs::rename(
        p.state.join("legacy-migration.json"),
        p.state.join("legacy-migration-pending.json"),
    )
    .unwrap();
    atomic_write(&p.home.join(".claude/settings.json"), b"external").unwrap();
    assert!(recover(&p).is_err());
    assert_eq!(
        fs::read_to_string(p.home.join(".claude/settings.json")).unwrap(),
        "external"
    );
}
#[test]
fn committed_import_cleans_pending_journal_without_rollback() {
    let (_t, s, p) = fixture(&[Agent::ClaudeCode], true);
    let result = import_all(&s, &p);
    fs::copy(
        p.state.join("legacy-migration.json"),
        p.state.join("legacy-migration-pending.json"),
    )
    .unwrap();
    recover(&p).unwrap();
    assert_eq!(receipt(&p).unwrap().unwrap().id, result.id);
    assert!(p.home.join(".claude/settings.json").exists());
    assert!(!p.state.join("legacy-migration-pending.json").exists());
    undo(&p).unwrap();
}
#[cfg(unix)]
#[test]
fn unsafe_paths_links_and_oversized_preferences_are_rejected() {
    let (_t, s, p) = fixture(&[Agent::ClaudeCode], false);
    let path = s.user_home.join(".claude/settings.json");
    fs::rename(&path, s.user_home.join("outside")).unwrap();
    std::os::unix::fs::symlink(s.user_home.join("outside"), &path).unwrap();
    let v = s.preview().unwrap();
    assert_eq!(v.agents[0].status, "skipped");
    import(&p, &s, &v.fingerprint).unwrap();
    assert!(!p.home.join(".claude/settings.json").exists());
    atomic_write(
        &s.directory.join("preferences.json"),
        &vec![b' '; 2 * 1024 * 1024 + 1],
    )
    .unwrap();
    assert!(s.preview().is_err());
}

// Use the real discovery layout under a temporary home, never the user's files.
fn automatic_fixture(agents: &[Agent]) -> (tempfile::TempDir, Source, Paths) {
    let (t, mut source, dest) = fixture(agents, true);
    #[cfg(target_os = "macos")]
    let data = source.user_home.join("Library/Application Support");
    #[cfg(target_os = "windows")]
    let data = source.user_home.join("AppData/Roaming");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let data = source.user_home.join(".config");
    private_dir(&data).unwrap();
    let directory = data.join("ai-coding-access");
    fs::rename(&source.directory, &directory).unwrap();
    let mut records: std::collections::BTreeMap<String, Record> =
        read_json(&directory.join("config-records.json")).unwrap();
    for record in records.values_mut() {
        record.backup = record
            .backup
            .as_ref()
            .map(|p| directory.join(p.strip_prefix(&source.directory).unwrap()));
    }
    save_json(&directory.join("config-records.json"), &records).unwrap();
    source.directory = directory;
    let paths = Paths::production_at(source.user_home.clone(), dest.state).unwrap();
    (t, source, paths)
}

#[test]
fn startup_automatically_adopts_all_tools_without_touching_active_or_legacy_files() {
    use coding_access_native::{client::Client, vault::MemoryVault};
    let (_t, source, paths) =
        automatic_fixture(&[Agent::ClaudeCode, Agent::CodexCli, Agent::Zcode]);
    let manager = ConfigManager {
        paths: paths.clone(),
    };
    let legacy = fs::read(source.directory.join("config-records.json")).unwrap();
    let originals: std::collections::BTreeMap<String, Record> =
        read_json(&source.directory.join("config-records.json")).unwrap();
    let active: Vec<_> = [Agent::ClaudeCode, Agent::CodexCli, Agent::Zcode]
        .into_iter()
        .map(|a| (a, fs::read(manager.path(a)).unwrap()))
        .collect();
    let client = Client::new(paths.clone(), Box::<MemoryVault>::default()).unwrap();
    assert!(!client.has_credentials());
    assert_eq!(
        client.preferences.project_directory,
        source.preview().unwrap().project_directory
    );
    assert!(client.state().unwrap()["upgradeIssues"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(client.state().unwrap()["upgradeError"].is_null());
    for (a, bytes) in active {
        assert_eq!(fs::read(manager.path(a)).unwrap(), bytes);
        let earliest = fs::read(originals[a.key()].backup.as_ref().unwrap()).unwrap();
        assert_eq!(
            fs::read(manager.records().unwrap()[a.key()].backup.as_ref().unwrap()).unwrap(),
            earliest
        );
        // No import command: switch defaults directly, then recover the ORIGINAL file.
        manager
            .apply(a, &model(), "http://localhost:4317", "new-token", "new-id")
            .unwrap();
        manager.restore(a).unwrap();
        Client::new(paths.clone(), Box::<MemoryVault>::default()).unwrap();
        assert!(!manager.records().unwrap().contains_key(a.key()));
        assert_eq!(fs::read(manager.path(a)).unwrap(), earliest);
    }
    assert_eq!(
        fs::read(source.directory.join("config-records.json")).unwrap(),
        legacy
    );
    assert_eq!(
        fs::read(source.directory.join("credentials.enc")).unwrap(),
        [0xff, 0, 0x80]
    );
}

#[test]
fn first_apply_adopts_records_before_choosing_the_original_backup() {
    let (_t, source, paths) = automatic_fixture(&[Agent::ClaudeCode]);
    let original: std::collections::BTreeMap<String, Record> =
        read_json(&source.directory.join("config-records.json")).unwrap();
    let earliest = fs::read(original["claude-code"].backup.as_ref().unwrap()).unwrap();
    let manager = ConfigManager { paths };
    manager
        .apply(
            Agent::ClaudeCode,
            &model(),
            "http://localhost:4317",
            "new-token",
            "new-id",
        )
        .unwrap();
    manager.restore(Agent::ClaudeCode).unwrap();
    assert_eq!(fs::read(manager.path(Agent::ClaudeCode)).unwrap(), earliest);
}

#[test]
fn beta_users_keep_native_records_preferences_and_login_while_missing_tools_are_adopted() {
    use coding_access_native::{client::Client, vault::MemoryVault};
    let (_t, _source, paths) = automatic_fixture(&[Agent::ClaudeCode, Agent::CodexCli]);
    // Simulate a beta.1 user who configured Claude and logged in before upgrading.
    let manager = ConfigManager {
        paths: Paths {
            isolated: true,
            ..paths.clone()
        },
    };
    let mut selected = model();
    selected.id = "new-native-model".into();
    manager
        .apply(
            Agent::ClaudeCode,
            &selected,
            "http://localhost:5678",
            "beta-token",
            "beta-id",
        )
        .unwrap();
    let record = serde_json::to_value(&manager.records().unwrap()["claude-code"]).unwrap();
    let bytes = fs::read(manager.path(Agent::ClaudeCode)).unwrap();
    let preferences =
        b"{\"serverUrl\":\"http://localhost:5678\",\"projectDirectory\":\"/native-project\"}";
    atomic_write(&paths.state.join("preferences.json"), preferences).unwrap();
    let secrets = json!({"serverUrl":"http://localhost:5678","device":"beta-device","session":"beta-session","userId":"beta-user","apiKey":"beta-token","credentialId":"beta-id"});
    let vault = MemoryVault(std::sync::Mutex::new(Some(secrets.to_string())));
    let client = Client::new(paths.clone(), Box::new(vault)).unwrap();
    assert!(client.has_credentials());
    assert_eq!(
        fs::read(paths.state.join("preferences.json")).unwrap(),
        preferences
    );
    assert_eq!(fs::read(manager.path(Agent::ClaudeCode)).unwrap(), bytes);
    assert_eq!(
        serde_json::to_value(&manager.records().unwrap()["claude-code"]).unwrap(),
        record
    );
    assert!(manager.records().unwrap().contains_key("codex"));
    assert!(client.state().unwrap()["upgradeIssues"]
        .as_array()
        .unwrap()
        .is_empty());
    let receipt_before = fs::read(paths.state.join("legacy-migration.json")).unwrap();
    automatic(&paths).unwrap();
    assert_eq!(
        fs::read(paths.state.join("legacy-migration.json")).unwrap(),
        receipt_before
    );
}

#[test]
fn conflicts_do_not_block_startup_and_retry_can_adopt_only_the_repaired_tool() {
    use coding_access_native::{client::Client, vault::MemoryVault};
    let (_t, source, paths) = automatic_fixture(&[Agent::ClaudeCode, Agent::CodexCli]);
    let manager = ConfigManager {
        paths: paths.clone(),
    };
    let original: std::collections::BTreeMap<String, Record> =
        read_json(&source.directory.join("config-records.json")).unwrap();
    let backup_path = original["claude-code"].backup.as_ref().unwrap();
    let backup = fs::read(backup_path).unwrap();
    fs::remove_file(backup_path).unwrap();
    let active = fs::read(manager.path(Agent::ClaudeCode)).unwrap();
    let mut client = Client::new(paths.clone(), Box::<MemoryVault>::default()).unwrap();
    assert_eq!(
        client.state().unwrap()["upgradeIssues"][0]["agent"],
        "claude-code"
    );
    check_first_apply(&paths, Agent::ClaudeCode).unwrap();
    assert_eq!(fs::read(manager.path(Agent::ClaudeCode)).unwrap(), active);
    // A healthy tool can still switch, and stays unchanged when the broken one retries.
    manager
        .apply(
            Agent::CodexCli,
            &model(),
            "http://localhost:4317",
            "new-token",
            "new-id",
        )
        .unwrap();
    let codex = serde_json::to_value(&manager.records().unwrap()["codex"]).unwrap();
    atomic_write(backup_path, &backup).unwrap();
    assert!(client.retry_upgrade().unwrap()["upgradeIssues"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        serde_json::to_value(&manager.records().unwrap()["codex"]).unwrap(),
        codex
    );
    manager
        .apply(
            Agent::ClaudeCode,
            &model(),
            "http://localhost:4317",
            "new-token",
            "new-id",
        )
        .unwrap();
    manager.restore(Agent::ClaudeCode).unwrap();
    assert_eq!(fs::read(manager.path(Agent::ClaudeCode)).unwrap(), backup);
}

#[test]
fn fresh_installs_and_development_do_not_require_or_automatically_import_legacy_data() {
    use coding_access_native::{client::Client, vault::MemoryVault};
    let (_t, source, paths) = fixture(&[Agent::ClaudeCode], true);
    automatic_from(&paths, &[source]).unwrap();
    assert!(!paths.state.join("legacy-migration.json").exists());
    let production = Paths::production_at(paths.home.clone(), paths.state.clone()).unwrap();
    let client = Client::new(production, Box::<MemoryVault>::default()).unwrap();
    assert!(client.state().unwrap()["upgradeError"].is_null());
    assert!(client.state().unwrap()["upgradeIssues"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!paths.state.join("legacy-migration.json").exists());
}

#[test]
fn malformed_or_ambiguous_legacy_sources_leave_login_state_available_and_files_intact() {
    use coding_access_native::{client::Client, vault::MemoryVault};
    let (_t, source, paths) = automatic_fixture(&[Agent::ClaudeCode]);
    let manager = ConfigManager {
        paths: paths.clone(),
    };
    let active = fs::read(manager.path(Agent::ClaudeCode)).unwrap();
    let record_path = source.directory.join("config-records.json");
    let records = fs::read(&record_path).unwrap();
    atomic_write(&record_path, b"malformed").unwrap();
    let mut client = Client::new(paths.clone(), Box::<MemoryVault>::default()).unwrap();
    assert!(client.state().unwrap()["upgradeError"]
        .as_str()
        .unwrap()
        .contains("格式"));
    assert_eq!(fs::read(manager.path(Agent::ClaudeCode)).unwrap(), active);
    assert!(!paths.state.join("config-records.json").exists());
    atomic_write(&record_path, &records).unwrap();
    let other = source.directory.parent().unwrap().join("Coding Access");
    atomic_write(&other.join("preferences.json"), b"{}").unwrap();
    assert!(client.retry_upgrade().unwrap()["upgradeError"]
        .as_str()
        .unwrap()
        .contains("多份"));
    assert!(!paths.state.join("config-records.json").exists());
    fs::remove_file(other.join("preferences.json")).unwrap();
    assert!(client.retry_upgrade().unwrap()["upgradeError"].is_null());
    assert!(manager.records().unwrap().contains_key("claude-code"));
}

#[test]
fn explicit_apply_after_skipped_upgrade_backs_up_current_file_without_import_requirement() {
    let (_t, source, paths) = automatic_fixture(&[Agent::ClaudeCode]);
    let m = ConfigManager {
        paths: paths.clone(),
    };
    let records: std::collections::BTreeMap<String, Record> =
        read_json(&source.directory.join("config-records.json")).unwrap();
    std::fs::remove_file(records["claude-code"].backup.as_ref().unwrap()).unwrap();
    let current = std::fs::read(m.path(Agent::ClaudeCode)).unwrap();
    automatic(&paths).unwrap();
    assert_eq!(issues(&paths).unwrap().len(), 1);
    let result = m
        .apply(
            Agent::ClaudeCode,
            &model(),
            "http://localhost:4317",
            "new-token",
            "new-id",
        )
        .unwrap();
    assert_eq!(
        std::fs::read(result["beforeApplyBackup"].as_str().unwrap()).unwrap(),
        current
    );
    assert!(issues(&paths).unwrap().is_empty());
    m.restore(Agent::ClaudeCode).unwrap();
    assert_eq!(std::fs::read(m.path(Agent::ClaudeCode)).unwrap(), current);
}
