use coding_access_native::{client::*, filesystem::*, model::Agent, vault::MemoryVault};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};
fn setup() -> (tempfile::TempDir, Client) {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let paths = Paths {
        home: root.join("home"),
        state: root.join("state"),
        isolated: true,
    };
    private_dir(&paths.home).unwrap();
    private_dir(&paths.state).unwrap();
    let client = Client::new(paths, Box::<MemoryVault>::default()).unwrap();
    (t, client)
}
fn mock(
    responses: Vec<(u16, Value)>,
) -> (String, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(vec![]));
    let r = requests.clone();
    let h = std::thread::spawn(move || {
        for (status, body) in responses {
            let (mut s, _) = l.accept().unwrap();
            s.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut all = vec![];
            loop {
                let mut buf = [0; 2048];
                let n = s.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                all.extend_from_slice(&buf[..n]);
                if let Some(end) = all.windows(4).position(|b| b == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&all[..end]);
                    let len = headers
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if all.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            r.lock().unwrap().push(String::from_utf8(all).unwrap());
            let body = body.to_string();
            write!(s,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
    });
    (url, requests, h)
}
fn login() -> Value {
    json!({"sessionToken":"synthetic-session","user":{"id":"employee","name":"Test","role":"employee"}})
}
#[tokio::test]
async fn rejected_login_reports_credentials_error_without_changing_state() {
    let (_t, mut c) = setup();
    let before = c.state().unwrap();
    let (url, _, h) = mock(vec![(
        401,
        json!({"error":{"code":"invalid_login","message":"账号或密码不正确"}}),
    )]);
    assert_eq!(
        c.login(&url, "employee", "wrong-password")
            .await
            .unwrap_err(),
        "账号或密码不正确"
    );
    assert!(!c.has_credentials());
    assert_eq!(c.state().unwrap(), before);
    h.join().unwrap();
}
fn catalog() -> Value {
    json!({"models":[{"id":"model","name":"Model","contextWindow":1000000}]})
}
#[test]
fn validates_roots_and_renderer_routes() {
    assert_eq!(
        base_url(" http://127.0.0.1:4317/ ").unwrap(),
        "http://127.0.0.1:4317"
    );
    for s in [
        "file:///etc/passwd",
        "https://user:pass@host",
        "https://host/path",
        "https://host/?q=a",
        "https://host/#x",
        "//host",
    ] {
        assert!(base_url(s).is_err());
    }
    for p in [
        "/api/credentials",
        "/api/admin/users",
        "/api/models/../../credentials",
        "https://evil/api/models",
        "//evil/api/meta",
        "/api/auth/device-logout",
    ] {
        assert!(!allowed_request(p, "GET"));
    }
    assert!(allowed_request("/api/models?agent=zcode", "GET"));
    assert!(!allowed_request("/api/models", "DELETE"));
}
#[tokio::test]
async fn login_apply_relogin_preserves_credential_then_logout_revokes() {
    let (_t, mut c) = setup();
    let (url, r, h) = mock(vec![
        (200, login()),
        (200, catalog()),
        (
            200,
            json!({"apiKey":"synthetic-api","credentialId":"key-id"}),
        ),
        (200, login()),
        (200, json!({"ok":true})),
    ]);
    c.login(&url, "employee", "test-password").await.unwrap();
    c.apply(Agent::ClaudeCode, "model").await.unwrap();
    let before = c.state().unwrap();
    assert_eq!(before["configured"]["claude-code"]["needsUpdate"], false);
    assert!(!before.to_string().contains("synthetic-api"));
    c.login(&url, "employee", "test-password").await.unwrap();
    assert_eq!(c.state().unwrap()["configured"], before["configured"]);
    c.logout().await.unwrap();
    assert_eq!(
        c.state().unwrap()["configured"]["claude-code"]["needsUpdate"],
        true
    );
    h.join().unwrap();
    let r = r.lock().unwrap();
    assert!(r[4].starts_with("POST /api/auth/device-logout"));
    assert!(r[4]
        .to_lowercase()
        .contains("authorization: bearer synthetic-api"));
    let prefs = std::fs::read_to_string(c.config.paths.state.join("preferences.json")).unwrap();
    assert!(!prefs.contains("synthetic"));
}
#[tokio::test]
async fn transient_validation_failure_does_not_issue_new_credential() {
    let (_t, mut c) = setup();
    let (url, r, h) = mock(vec![
        (200, login()),
        (200, catalog()),
        (
            200,
            json!({"apiKey":"synthetic-api","credentialId":"key-id"}),
        ),
        (503, json!({"error":{"message":"busy"}})),
    ]);
    c.login(&url, "employee", "test-password").await.unwrap();
    c.apply(Agent::ClaudeCode, "model").await.unwrap();
    assert!(c.credential().await.is_err());
    h.join().unwrap();
    assert_eq!(
        r.lock()
            .unwrap()
            .iter()
            .filter(|r| r.starts_with("POST /api/credentials "))
            .count(),
        1
    );
}
#[tokio::test]
async fn revoked_agent_credential_is_shown_as_needing_sync() {
    let (_t, mut c) = setup();
    let (url, requests, server) = mock(vec![
        (200, login()),
        (200, catalog()),
        (
            200,
            json!({"apiKey":"synthetic-api","credentialId":"key-id"}),
        ),
        (200, catalog()),
        (401, json!({"error":{"code":"invalid_api_key"}})),
    ]);
    c.login(&url, "employee", "test-password").await.unwrap();
    c.apply(Agent::Zcode, "model").await.unwrap();
    assert_eq!(
        c.state().unwrap()["configured"]["zcode"]["needsUpdate"],
        false
    );
    let state = c.live_state().await.unwrap();
    assert_eq!(state["credentialExpired"], true);
    assert_eq!(state["configured"]["zcode"]["needsUpdate"], true);
    assert!(!state.to_string().contains("synthetic-api"));
    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert!(requests[4].starts_with("GET /v1/models "));
    assert!(requests[4]
        .to_lowercase()
        .contains("authorization: bearer synthetic-api"));
}
#[tokio::test]
async fn temporary_gateway_failure_does_not_claim_credential_is_revoked() {
    let (_t, mut c) = setup();
    let (url, _, server) = mock(vec![
        (200, login()),
        (200, catalog()),
        (
            200,
            json!({"apiKey":"synthetic-api","credentialId":"key-id"}),
        ),
        (200, catalog()),
        (503, json!({"error":{"code":"service_unavailable"}})),
    ]);
    c.login(&url, "employee", "test-password").await.unwrap();
    c.apply(Agent::Zcode, "model").await.unwrap();
    let state = c.live_state().await.unwrap();
    assert_eq!(state["credentialExpired"], Value::Null);
    assert_eq!(state["configured"]["zcode"]["needsUpdate"], false);
    server.join().unwrap();
}
#[tokio::test]
async fn unavailable_catalog_does_not_trigger_second_credential_probe() {
    let (_t, mut c) = setup();
    let (url, requests, server) = mock(vec![
        (200, login()),
        (200, catalog()),
        (
            200,
            json!({"apiKey":"synthetic-api","credentialId":"key-id"}),
        ),
        (503, json!({"error":{"code":"service_unavailable"}})),
    ]);
    c.login(&url, "employee", "test-password").await.unwrap();
    c.apply(Agent::Zcode, "model").await.unwrap();
    let state = c.live_state().await.unwrap();
    assert_eq!(state["credentialExpired"], Value::Null);
    server.join().unwrap();
    assert_eq!(requests.lock().unwrap().len(), 4);
}
#[tokio::test]
async fn stale_or_unpublished_model_cannot_be_applied() {
    let (_t, mut c) = setup();
    let (url, r, h) = mock(vec![(200, login()), (200, json!({"models":[]}))]);
    c.login(&url, "employee", "test-password").await.unwrap();
    assert!(c.apply(Agent::ClaudeCode, "missing").await.is_err());
    assert!(!c.config.path(Agent::ClaudeCode).exists());
    h.join().unwrap();
    assert_eq!(r.lock().unwrap().len(), 2);
}

#[test]
fn settings_preserve_old_preferences_and_reject_cross_server_or_invalid_tool() {
    let (_t, mut client) = setup();
    let old: Preferences =
        serde_json::from_value(json!({"serverUrl":"http://localhost:4317","projectDirectory":""}))
            .unwrap();
    assert!(old.check_updates);
    assert!(old.tool_paths.is_empty());
    let mut changed = client.preferences.clone();
    changed.server_url = "http://another.test".into();
    assert!(client.save_settings(changed).is_err());
    let mut changed = client.preferences.clone();
    changed.terminal = "shell;untrusted".into();
    assert!(client.save_settings(changed).is_err());
    let mut changed = client.preferences.clone();
    changed.check_updates = false;
    client.save_settings(changed).unwrap();
    client.reload_preferences().unwrap();
    assert!(!client.preferences.check_updates);
    let mut changed = client.preferences.clone();
    changed
        .tool_paths
        .insert("claude-code".into(), "/missing-tool".into());
    assert!(client.save_settings(changed).is_err());
    assert!(allowed_request(
        "/api/me/analytics?from=0&to=1&userIds=admin",
        "GET"
    ));
    assert!(!allowed_request("/api/admin/analytics?from=0&to=1", "GET"));
}

#[test]
fn window_preferences_migrate_and_remember_without_revalidating_stale_project() {
    let (_t, mut client) = setup();
    let old: Preferences =
        serde_json::from_value(json!({"serverUrl":"", "projectDirectory":""})).unwrap();
    assert_eq!(old.close_action, "ask");
    assert!(!old.start_on_login && !old.start_hidden);
    client.preferences.project_directory = "/project-removed-after-save".into();
    client.save_close_action("hide").unwrap();
    client.reload_preferences().unwrap();
    assert_eq!(client.preferences.close_action, "hide");
    assert_eq!(
        client.preferences.project_directory,
        "/project-removed-after-save"
    );
    assert!(client.save_close_action("invalid").is_err());
    client.save_close_action("ask").unwrap();
    client.preferences.project_directory.clear();
    let mut prefs = client.preferences.clone();
    prefs.start_on_login = true;
    prefs.start_hidden = true;
    prefs.close_action = "quit".into();
    client.save_settings(prefs).unwrap();
    client.reload_preferences().unwrap();
    assert!(client.preferences.start_on_login && client.preferences.start_hidden);
    assert_eq!(client.preferences.close_action, "quit");
}

#[tokio::test]
async fn remembered_login_survives_logout_and_updates_without_exposing_password() {
    let (t, mut c) = setup();
    let (url, requests, h) = mock(vec![
        (200, login()),
        (200, json!({"ok":true})),
        (200, login()),
    ]);
    c.login_remembered(&url, "employee", "original-secret", true, false)
        .await
        .unwrap();
    let hint = c.remembered_login(&url, None).unwrap();
    assert_eq!(hint, json!({"username":"employee","remembered":true}));
    assert!(!hint.to_string().contains("secret"));
    assert!(
        !std::fs::read_to_string(t.path().join("state/preferences.json"))
            .unwrap()
            .contains("secret")
    );
    c.refresh_saved_password("updated-secret").unwrap();
    c.logout().await.unwrap();
    assert!(!c.has_credentials());
    assert_eq!(c.remembered_login(&url, None).unwrap()["remembered"], true);
    assert_eq!(
        c.remembered_login("https://another.test", Some("employee"))
            .unwrap()["remembered"],
        false
    );
    assert_eq!(
        c.remembered_login(&url, Some("another")).unwrap()["remembered"],
        false
    );
    assert!(c
        .login_remembered("https://another.test", "employee", "", true, true)
        .await
        .is_err());
    c.login_remembered(&url, "employee", "", true, true)
        .await
        .unwrap();
    h.join().unwrap();
    assert!(requests.lock().unwrap()[2].contains("updated-secret"));
    c.clear_saved_logins().unwrap();
    assert!(c.has_credentials());
    assert_eq!(
        c.remembered_login(&url, None).unwrap(),
        json!({"username":"","remembered":false})
    );
}

#[tokio::test]
async fn failed_login_does_not_replace_saved_password_and_unchecking_removes_it() {
    let (_t, mut c) = setup();
    let (url, requests, h) = mock(vec![
        (200, login()),
        (401, json!({})),
        (200, login()),
        (200, login()),
    ]);
    c.login_remembered(&url, "employee", "saved-secret", true, false)
        .await
        .unwrap();
    assert!(c
        .login_remembered(&url, "employee", "wrong-secret", true, false)
        .await
        .is_err());
    c.login_remembered(&url, "employee", "", true, true)
        .await
        .unwrap();
    c.login_remembered(&url, "employee", "typed-secret", false, false)
        .await
        .unwrap();
    h.join().unwrap();
    assert!(requests.lock().unwrap()[2].contains("saved-secret"));
    assert_eq!(c.remembered_login(&url, None).unwrap()["remembered"], false);
    assert!(c
        .login_remembered(&url, "employee", "", false, true)
        .await
        .is_err());
}

#[tokio::test]
async fn saved_login_is_restored_from_vault_after_client_restart() {
    use coding_access_native::vault::Vault;
    #[derive(Clone)]
    struct SharedVault(Arc<Mutex<Option<String>>>);
    impl Vault for SharedVault {
        fn load(&self) -> coding_access_native::Result<Option<String>> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, value: &str) -> coding_access_native::Result<()> {
            *self.0.lock().unwrap() = Some(value.into());
            Ok(())
        }
    }
    let (_t, initial) = setup();
    let paths = initial.config.paths.clone();
    let vault = SharedVault(Arc::new(Mutex::new(None)));
    let mut c = Client::new(paths.clone(), Box::new(vault.clone())).unwrap();
    let (url, requests, h) = mock(vec![
        (200, login()),
        (200, json!({"ok":true})),
        (200, login()),
    ]);
    c.login_remembered(&url, "employee", "restart-secret", true, false)
        .await
        .unwrap();
    c.logout().await.unwrap();
    drop(c);
    let mut reopened = Client::new(paths, Box::new(vault)).unwrap();
    assert!(!reopened.has_credentials());
    assert_eq!(
        reopened.remembered_login(&url, None).unwrap(),
        json!({"username":"employee","remembered":true})
    );
    reopened
        .login_remembered(&url, "employee", "", true, true)
        .await
        .unwrap();
    h.join().unwrap();
    assert!(requests.lock().unwrap()[2].contains("restart-secret"));
}
