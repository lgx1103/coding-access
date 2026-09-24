use coding_access_native::{
    config::*,
    filesystem::*,
    model::{Agent, Model},
};
use serde_json::{json, Value};
fn model(context: Option<u64>) -> Model {
    Model {
        id: "example-model".into(),
        name: "Example".into(),
        description: String::new(),
        context_window: context,
        max_output_tokens: Some(64000),
        vision: Some(true),
    }
}
fn manager() -> (tempfile::TempDir, ConfigManager) {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let p = Paths {
        home: root.join("home"),
        state: root.join("state"),
        isolated: true,
    };
    private_dir(&p.home).unwrap();
    private_dir(&p.state).unwrap();
    (t, ConfigManager { paths: p })
}
#[test]
fn electron_semantic_parity() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/config-parity.json")).unwrap();
    for c in cases {
        let agent: Agent = serde_json::from_value(c["agent"].clone()).unwrap();
        let model: Model = serde_json::from_value(c["model"].clone()).unwrap();
        let managed: Vec<String> = serde_json::from_value(c["managed"].clone()).unwrap();
        let src = c["source"].as_str().unwrap();
        let base = c["base"].as_str().unwrap();
        let key = c["credential"].as_str().unwrap();
        let out = match agent {
            Agent::ClaudeCode => claude_configuration(src, base, key, &model, &managed).unwrap(),
            Agent::Zcode => zcode_configuration(src, base, key, &model).unwrap(),
            _ => codex_configuration(src, base, key, &model, &managed).unwrap(),
        };
        let parsed: Value = if agent.codex() {
            toml_edit::de::from_str(&out).unwrap()
        } else {
            json_object(&out).unwrap()
        };
        assert_eq!(parsed, c["expected"], "{}", c["name"]);
        if src.contains("// preserve") {
            assert!(out.contains("// preserve"));
        }
    }
}
#[test]
fn restore_first_backup_after_multiple_switches() {
    for agent in [Agent::ClaudeCode, Agent::CodexCli, Agent::Zcode] {
        let (_t, m) = manager();
        let src = if agent.codex() {
            "# exact original\nmodel = 'personal'\n"
        } else {
            "{\n// exact original\n\"theme\":\"light\",\n}\n"
        };
        atomic_write(&m.path(agent), src.as_bytes()).unwrap();
        m.apply(
            agent,
            &model(Some(1000000)),
            "http://localhost:4317",
            "dummy1",
            "id1",
        )
        .unwrap();
        m.apply(
            agent,
            &model(Some(128000)),
            "http://localhost:4317",
            "dummy2",
            "id2",
        )
        .unwrap();
        m.restore(agent).unwrap();
        assert_eq!(read_optional(&m.path(agent)).unwrap().unwrap(), src);
        assert!(m.records().unwrap().is_empty());
    }
}
#[test]
fn restore_absent_file_and_share_codex_record() {
    let (_t, m) = manager();
    m.apply(
        Agent::CodexCli,
        &model(None),
        "http://localhost:4317",
        "dummy",
        "id",
    )
    .unwrap();
    let s = m.configured(Some("id")).unwrap();
    assert_eq!(s["codex-cli"], s["codex-desktop"]);
    m.restore(Agent::CodexDesktop).unwrap();
    assert!(!m.path(Agent::CodexCli).exists());
}
#[test]
fn restore_blocks_external_changes_but_explicit_apply_merges_and_backs_up() {
    let (_t, m) = manager();
    m.apply(
        Agent::ClaudeCode,
        &model(Some(1000000)),
        "http://localhost:4317",
        "dummy",
        "id",
    )
    .unwrap();
    atomic_write(&m.path(Agent::ClaudeCode), b"{\"theme\":\"new\"}").unwrap();
    assert!(m.restore(Agent::ClaudeCode).is_err());
    let original_backup = m.records().unwrap()["claude-code"].backup.clone();
    let result = m
        .apply(
            Agent::ClaudeCode,
            &model(None),
            "http://localhost:4317",
            "replacement",
            "id2",
        )
        .unwrap();
    let saved = json_object(&read_optional(&m.path(Agent::ClaudeCode)).unwrap().unwrap()).unwrap();
    assert_eq!(saved["theme"], "new");
    assert_eq!(saved["env"]["ANTHROPIC_AUTH_TOKEN"], "replacement");
    assert_eq!(
        std::fs::read_to_string(result["beforeApplyBackup"].as_str().unwrap()).unwrap(),
        "{\"theme\":\"new\"}"
    );
    assert_eq!(m.records().unwrap()["claude-code"].backup, original_backup);
}
#[test]
fn zcode_metadata_and_foreign_settings_survive_restore() {
    let (_t, m) = manager();
    atomic_write(
        &m.path(Agent::Zcode),
        b"{\"provider\":{\"personal\":{\"name\":\"keep\"}}}",
    )
    .unwrap();
    m.apply(
        Agent::Zcode,
        &model(None),
        "http://localhost:4317",
        "dummy",
        "id",
    )
    .unwrap();
    let mut v = json_object(&read_optional(&m.path(Agent::Zcode)).unwrap().unwrap()).unwrap();
    v["provider"]["coding_access"]["source"] = json!("custom");
    v["provider"]["coding_access"]["models"]["example-model"]["reasoning"] = json!(true);
    v["theme"] = json!("dark");
    save_json(&m.path(Agent::Zcode), &v).unwrap();
    m.restore(Agent::Zcode).unwrap();
    let v = json_object(&read_optional(&m.path(Agent::Zcode)).unwrap().unwrap()).unwrap();
    assert_eq!(v["theme"], "dark");
    assert_eq!(v["provider"]["personal"]["name"], "keep");
    assert!(v["provider"].get("coding_access").is_none());
}

fn personal_config(key: &str) -> String {
    json!({
        "schemaVersion": 1,
        "config": {
            "providerConfigRules": { "providerRules": [
                {"providerId":"other","config":{"access":{"apiKey":"untouched"}}},
                {"providerId":"coding_access","enabled":true,"config":{
                    "access":{"type":"api-key","apiKey":key},
                    "api":{"type":"anthropic-messages","baseUrl":"http://localhost:4317"},
                    "personalModelIds":["old-model"],"modelOrder":["old-model"]
                }}
            ]},
            "defaultModelSelection":{"providerId":"coding_access","modelId":"old-model"},
            "userPreference":"keep"
        }
    })
    .to_string()
}

#[test]
fn zcode_syncs_runtime_personal_provider_and_restores_only_managed_rule() {
    let (_t, m) = manager();
    let legacy = m.path(Agent::Zcode);
    let personal = legacy.with_file_name("provider_config.json");
    let desired = model(None);
    let legacy_original =
        zcode_configuration("{}", "http://localhost:4317", "new-key", &desired).unwrap();
    atomic_write(&legacy, legacy_original.as_bytes()).unwrap();
    atomic_write(&personal, personal_config("old-key").as_bytes()).unwrap();
    assert!(!m
        .configuration_matches(Agent::Zcode, &desired, "http://localhost:4317", "new-key")
        .unwrap());
    assert!(m
        .apply_checked(
            Agent::Zcode,
            &desired,
            "http://localhost:4317",
            "new-key",
            "id",
            true
        )
        .is_err());
    let result = m
        .apply(
            Agent::Zcode,
            &desired,
            "http://localhost:4317",
            "new-key",
            "id",
        )
        .unwrap();
    assert_eq!(result["changed"], true);
    assert!(!m.configured(Some("id")).unwrap()["zcode"]["needsUpdate"]
        .as_bool()
        .unwrap());
    let mut saved: Value =
        serde_json::from_str(&read_optional(&personal).unwrap().unwrap()).unwrap();
    assert_eq!(
        saved["config"]["providerConfigRules"]["providerRules"][1]["config"]["access"]["apiKey"],
        "new-key"
    );
    assert_eq!(
        saved["config"]["defaultModelSelection"]["modelId"],
        "example-model"
    );
    assert_eq!(
        saved["config"]["providerConfigRules"]["providerRules"][0]["config"]["access"]["apiKey"],
        "untouched"
    );
    assert!(m
        .configuration_matches(Agent::Zcode, &desired, "http://localhost:4317", "new-key")
        .unwrap());
    saved["config"]["userPreference"] = json!("later-change");
    save_json(&personal, &saved).unwrap();
    m.restore(Agent::Zcode).unwrap();
    let restored: Value =
        serde_json::from_str(&read_optional(&personal).unwrap().unwrap()).unwrap();
    assert_eq!(
        restored["config"]["providerConfigRules"]["providerRules"][1]["config"]["access"]["apiKey"],
        "old-key"
    );
    assert_eq!(
        restored["config"]["defaultModelSelection"]["modelId"],
        "old-model"
    );
    assert_eq!(restored["config"]["userPreference"], "later-change");
    assert_eq!(read_optional(&legacy).unwrap().unwrap(), legacy_original);
}

#[test]
fn zcode_rejects_unknown_personal_schema_before_touching_legacy() {
    let (_t, m) = manager();
    let legacy = m.path(Agent::Zcode);
    let personal = legacy.with_file_name("provider_config.json");
    atomic_write(&personal, br#"{"schemaVersion":99,"config":{}}"#).unwrap();
    assert!(m
        .apply(Agent::Zcode, &model(None), "http://localhost", "key", "id")
        .is_err());
    assert!(!legacy.exists());
    assert_eq!(
        read_optional(&personal).unwrap().unwrap(),
        r#"{"schemaVersion":99,"config":{}}"#
    );
}

#[test]
fn zcode_sync_after_one_time_import_removes_only_imported_rule_on_restore() {
    let (_t, m) = manager();
    let personal = m.path(Agent::Zcode).with_file_name("provider_config.json");
    let desired = model(None);
    m.apply(
        Agent::Zcode,
        &desired,
        "http://localhost:4317",
        "new-key",
        "id",
    )
    .unwrap();
    atomic_write(&personal, personal_config("old-key").as_bytes()).unwrap();
    assert!(m.configured(Some("id")).unwrap()["zcode"]["needsUpdate"]
        .as_bool()
        .unwrap());
    m.apply(
        Agent::Zcode,
        &desired,
        "http://localhost:4317",
        "new-key",
        "id",
    )
    .unwrap();
    m.restore(Agent::Zcode).unwrap();
    let restored: Value =
        serde_json::from_str(&read_optional(&personal).unwrap().unwrap()).unwrap();
    assert_eq!(
        restored["config"]["providerConfigRules"]["providerRules"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        restored["config"]["providerConfigRules"]["providerRules"][0]["providerId"],
        "other"
    );
    assert!(restored["config"].get("defaultModelSelection").is_none());
}

#[test]
fn zcode_interrupted_two_file_write_finishes_both_files() {
    let (_t, m) = manager();
    let agent = Agent::Zcode;
    let personal = m.path(agent).with_file_name("provider_config.json");
    let desired = model(None);
    m.apply(agent, &desired, "http://localhost:4317", "new-key", "id")
        .unwrap();
    let legacy = read_optional(&m.path(agent)).unwrap().unwrap();
    let before = personal_config("old-key");
    let after = zcode_personal_configuration(&before, "http://localhost:4317", "new-key", &desired)
        .unwrap();
    atomic_write(&personal, before.as_bytes()).unwrap();
    let records = m.records().unwrap();
    save_json(
        &m.paths.state.join("config-transaction.json"),
        &json!({
            "agent":agent,"before":legacy,"after":legacy,"records":records,
            "auxiliary":{"path":personal,"before":before,"after":after}
        }),
    )
    .unwrap();
    m.records().unwrap();
    assert_eq!(read_optional(&personal).unwrap().unwrap(), after);
    assert!(!m.paths.state.join("config-transaction.json").exists());
}
#[test]
fn personal_context_override_preserved_until_owned() {
    let m = model(None);
    let s = claude_configuration(
        "{\"env\":{\"CLAUDE_CODE_MAX_CONTEXT_TOKENS\":\"900000\"}}",
        "http://localhost",
        "dummy",
        &m,
        &[],
    )
    .unwrap();
    assert_eq!(
        json_object(&s).unwrap()["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"],
        "900000"
    );
    let s = claude_configuration(
        &s,
        "http://localhost",
        "dummy",
        &m,
        &["contextWindow".into()],
    )
    .unwrap();
    assert!(json_object(&s).unwrap()["env"]
        .get("CLAUDE_CODE_MAX_CONTEXT_TOKENS")
        .is_none());
}
#[test]
fn invalid_existing_configs_fail_closed() {
    let m = model(None);
    for s in ["[]", "{broken}", "{\"env\":5}"] {
        assert!(claude_configuration(s, "http://localhost", "dummy", &m, &[]).is_err());
    }
    assert!(codex_configuration("features = 1", "http://localhost", "dummy", &m, &[]).is_err());
}
#[cfg(unix)]
#[test]
fn symlink_config_is_rejected() {
    let (_t, m) = manager();
    private_dir(m.path(Agent::ClaudeCode).parent().unwrap()).unwrap();
    let original = m.paths.home.join("outside");
    atomic_write(&original, b"{}").unwrap();
    std::os::unix::fs::symlink(&original, m.path(Agent::ClaudeCode)).unwrap();
    assert!(m
        .apply(
            Agent::ClaudeCode,
            &model(None),
            "http://localhost",
            "dummy",
            "id"
        )
        .is_err());
    assert_eq!(std::fs::read_to_string(original).unwrap(), "{}");
}

#[test]
fn interrupted_write_recovers_records_without_losing_original_backup() {
    let (_t, m) = manager();
    let agent = Agent::ClaudeCode;
    atomic_write(&m.path(agent), b"{\"theme\":\"original\"}").unwrap();
    m.apply(
        agent,
        &model(Some(1000000)),
        "http://localhost",
        "dummy",
        "id",
    )
    .unwrap();
    let records = m.records().unwrap();
    let after = read_optional(&m.path(agent)).unwrap();
    save_json(
        &m.paths.state.join("config-transaction.json"),
        &json!({"agent":agent,"before":"{\"theme\":\"original\"}","after":after,"records":records}),
    )
    .unwrap();
    save_json(&m.paths.state.join("config-records.json"), &json!({})).unwrap();
    assert_eq!(m.records().unwrap().len(), 1);
    assert!(!m.paths.state.join("config-transaction.json").exists());
    m.restore(agent).unwrap();
    assert_eq!(
        read_optional(&m.path(agent)).unwrap().unwrap(),
        "{\"theme\":\"original\"}"
    );
}

#[test]
fn formatting_and_key_order_do_not_require_sync_but_changed_content_does() {
    for agent in [Agent::ClaudeCode, Agent::CodexCli, Agent::Zcode] {
        let (_t, m) = manager();
        m.apply(
            agent,
            &model(Some(1000000)),
            "http://localhost:4317",
            "dummy",
            "id",
        )
        .unwrap();
        let original = read_optional(&m.path(agent)).unwrap().unwrap();
        let reordered = if agent.codex() {
            let value: Value = toml_edit::de::from_str(&original).unwrap();
            toml_edit::ser::to_string_pretty(&value).unwrap()
        } else {
            serde_json::to_string(&json_object(&original).unwrap()).unwrap()
        };
        assert_ne!(original, reordered);
        atomic_write(&m.path(agent), reordered.as_bytes()).unwrap();
        assert_eq!(
            m.configured(Some("id")).unwrap()[agent.id()]["needsUpdate"],
            false
        );
        let changed = reordered.replace("dummy", "external-token");
        atomic_write(&m.path(agent), changed.as_bytes()).unwrap();
        assert_eq!(
            m.configured(Some("id")).unwrap()[agent.id()]["needsUpdate"],
            true
        );
        m.apply(
            agent,
            &model(None),
            "http://localhost:4317",
            "new-token",
            "id",
        )
        .unwrap();
        assert_eq!(
            m.configured(Some("id")).unwrap()[agent.id()]["needsUpdate"],
            false
        );
    }
}

#[test]
fn explicit_apply_accepts_legacy_records_and_preserves_unmanaged_settings() {
    for agent in [Agent::ClaudeCode, Agent::CodexCli, Agent::Zcode] {
        let (_t, m) = manager();
        m.apply(agent, &model(None), "http://localhost:4317", "dummy", "id")
            .unwrap();
        let rp = m.paths.state.join("config-records.json");
        let mut records: Value = read_json(&rp).unwrap();
        records[agent.key()]
            .as_object_mut()
            .unwrap()
            .remove("semanticHash");
        save_json(&rp, &records).unwrap();
        let changed = if agent.codex() {
            "model = 'external'\n[features]\ncustom_flag = true\n"
        } else {
            "{\"theme\":\"dark\",\"enabledPlugins\":{\"example\":true},\"env\":{\"CUSTOM\":\"keep\"}}"
        };
        atomic_write(&m.path(agent), changed.as_bytes()).unwrap();
        let result = m
            .apply(
                agent,
                &model(None),
                "http://localhost:4317",
                "new-token",
                "id",
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(result["beforeApplyBackup"].as_str().unwrap()).unwrap(),
            changed
        );
        let source = read_optional(&m.path(agent)).unwrap().unwrap();
        let value: Value = if agent.codex() {
            toml_edit::de::from_str(&source).unwrap()
        } else {
            json_object(&source).unwrap()
        };
        if agent.codex() {
            assert_eq!(value["features"]["custom_flag"], true);
        } else {
            assert_eq!(value["theme"], "dark");
            assert_eq!(value["enabledPlugins"]["example"], true);
            assert_eq!(value["env"]["CUSTOM"], "keep");
        }
    }
}

#[test]
fn malformed_current_file_is_not_destroyed_by_explicit_apply() {
    let (_t, m) = manager();
    atomic_write(&m.path(Agent::ClaudeCode), b"{ invalid json").unwrap();
    assert!(m
        .apply(
            Agent::ClaudeCode,
            &model(None),
            "http://localhost:4317",
            "dummy",
            "id"
        )
        .is_err());
    assert_eq!(
        std::fs::read(m.path(Agent::ClaudeCode)).unwrap(),
        b"{ invalid json"
    );
    assert!(m.records().unwrap().is_empty());
}

#[test]
fn actual_configuration_survives_agent_metadata_and_legacy_record_upgrade() {
    for agent in [
        Agent::ClaudeCode,
        Agent::CodexCli,
        Agent::CodexDesktop,
        Agent::Zcode,
    ] {
        let (_t, m) = manager();
        let model = model(Some(1000000));
        let base = "http://localhost:4317";
        m.apply(agent, &model, base, "synthetic-token", "id")
            .unwrap();
        let before = read_optional(&m.path(agent)).unwrap().unwrap();
        let changed = if agent.codex() {
            format!("{before}\n[projects.\"/example\"]\ntrust_level = 'trusted'\n")
        } else {
            let mut v = json_object(&before).unwrap();
            v["theme"] = json!("dark");
            if agent == Agent::Zcode {
                v["provider"]["coding_access"]["source"] = json!("custom");
                v["provider"]["coding_access"]["models"][&model.id]["reasoning"] = json!(true);
                v["provider"]["coding_access"]["models"][&model.id]["zcode"]["uiPreference"] =
                    json!(true);
                v["provider"]["coding_access"]["options"]["timeout"] = json!(60000);
            } else {
                v["enabledPlugins"] = json!({"example":true});
            }
            serde_json::to_string(&v).unwrap()
        };
        atomic_write(&m.path(agent), changed.as_bytes()).unwrap();
        let rp = m.paths.state.join("config-records.json");
        let mut records: Value = read_json(&rp).unwrap();
        records[agent.key()]
            .as_object_mut()
            .unwrap()
            .remove("appliedModel");
        save_json(&rp, &records).unwrap();
        let state = m
            .configured_with_targets(base, Some("synthetic-token"), Some("id"), &[model.clone()])
            .unwrap();
        assert_eq!(state[agent.id()]["needsUpdate"], false);
        assert!(m
            .configuration_matches(agent, &model, base, "synthetic-token")
            .unwrap());
        let result = m
            .apply_checked(agent, &model, base, "synthetic-token", "id", true)
            .unwrap();
        assert_eq!(result["changed"], false);
        assert!(result["beforeApplyBackup"].is_null());
        assert_eq!(read_optional(&m.path(agent)).unwrap().unwrap(), changed);
        // The new record also checks correctly offline, without a fresh catalog.
        assert_eq!(
            m.configured_with_targets(base, Some("synthetic-token"), Some("id"), &[])
                .unwrap()[agent.id()]["needsUpdate"],
            false
        );
    }
}

#[test]
fn only_real_desktop_configuration_changes_require_quitting() {
    for agent in [
        Agent::ClaudeCode,
        Agent::CodexCli,
        Agent::CodexDesktop,
        Agent::Zcode,
    ] {
        let (_t, m) = manager();
        let original_model = model(Some(1000000));
        let base = "http://localhost:4317";
        m.apply(agent, &original_model, base, "synthetic-token", "id")
            .unwrap();
        let before = read_optional(&m.path(agent)).unwrap();
        let records_before = read_optional(&m.paths.state.join("config-records.json")).unwrap();
        assert!(!m
            .configuration_matches(
                agent,
                &original_model,
                "http://localhost:5555",
                "synthetic-token"
            )
            .unwrap());
        assert!(!m
            .configuration_matches(agent, &original_model, base, "new-token")
            .unwrap());
        let mut next = original_model.clone();
        next.id = "other-model".into();
        assert!(!m
            .configuration_matches(agent, &next, base, "synthetic-token")
            .unwrap());
        let result = m.apply_checked(agent, &next, base, "synthetic-token", "id", true);
        if agent.desktop() {
            assert!(result.unwrap_err().contains("本次会改变"));
            assert_eq!(read_optional(&m.path(agent)).unwrap(), before);
            assert_eq!(
                read_optional(&m.paths.state.join("config-records.json")).unwrap(),
                records_before
            );
            assert_eq!(
                m.apply_checked(agent, &next, base, "synthetic-token", "id", false)
                    .unwrap()["changed"],
                true
            );
        } else {
            assert_eq!(result.unwrap()["changed"], true);
        }
    }
}
