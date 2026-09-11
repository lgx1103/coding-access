//! Test-only stdio transport for WebKit integration. Not linked into the app.
use coding_access_native::{
    client::Client,
    config::ConfigManager,
    filesystem::*,
    model::{Agent, Model},
    terminal,
    vault::MemoryVault,
    Result,
};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
fn main() {
    let root = std::env::args_os()
        .nth(1)
        .expect("isolated test root required");
    let mut paths = Paths::development_at(root.into()).unwrap();
    let scenario = std::env::args().nth(2).unwrap_or_default();
    if scenario == "automatic" || scenario == "conflict" {
        #[cfg(target_os = "macos")]
        let old_state = paths
            .home
            .join("Library/Application Support/ai-coding-access");
        #[cfg(target_os = "windows")]
        let old_state = paths.home.join("AppData/Roaming/ai-coding-access");
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let old_state = paths.home.join(".config/ai-coding-access");
        let old = ConfigManager {
            paths: Paths {
                state: old_state,
                home: paths.home.clone(),
                isolated: true,
            },
        };
        let prefs = read_optional(&paths.state.join("preferences.json"))
            .unwrap()
            .unwrap();
        let base = serde_json::from_str::<Value>(&prefs).unwrap()["serverUrl"]
            .as_str()
            .unwrap()
            .to_owned();
        atomic_write(&old.paths.state.join("preferences.json"), prefs.as_bytes()).unwrap();
        old.apply(
            Agent::ClaudeCode,
            &Model {
                id: "glm-test".into(),
                name: "GLM 测试 · 1M".into(),
                description: String::new(),
                context_window: Some(1000000),
                max_output_tokens: None,
                vision: None,
            },
            &base,
            "synthetic-old-credential",
            "old-id",
        )
        .unwrap();
        if scenario == "conflict" {
            let backup = old.records().unwrap()["claude-code"]
                .backup
                .clone()
                .unwrap();
            std::fs::rename(&backup, paths.state.join("recoverable-test.backup")).unwrap();
            save_json(&paths.state.join("test-backup-path.json"), &backup).unwrap();
        }
        std::fs::remove_file(paths.state.join("preferences.json")).unwrap();
        paths = Paths::production_at(paths.home, paths.state).unwrap();
        // Fail closed if an inherited custom config directory could escape QA.
        assert!(ConfigManager {
            paths: paths.clone()
        }
        .path(Agent::ClaudeCode)
        .starts_with(&paths.home));
    } else if scenario == "fresh" {
        paths = Paths::production_at(paths.home, paths.state).unwrap();
        assert!(ConfigManager {
            paths: paths.clone()
        }
        .path(Agent::ClaudeCode)
        .starts_with(&paths.home));
    }
    let mut client = Client::new(paths, Box::<MemoryVault>::default()).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for line in std::io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let r = &v["request"];
        let result:Result<Value>=runtime.block_on(async{
            let string=|key:&str|r[key].as_str().ok_or_else(||format!("Missing {key}"));
            let agent=||serde_json::from_value::<Agent>(r["agent"].clone()).map_err(|_|String::from("Invalid agent"));
            match string("action")?{
                "getSettings"=>client.settings(),
                "saveSettings"=>client.save_settings(serde_json::from_value(r["preferences"].clone()).map_err(|_|"Invalid preferences")?),
                "testConnection"=>client.test_connection(string("serverUrl")?).await,
                "update"=>Ok(json!({"state":"unpublished"})),
                "getState"=>client.live_state().await,"retryUpgrade"=>client.retry_upgrade(),"login"=>client.login_remembered(string("serverUrl")?,string("username")?,string("password")?,r["remember"].as_bool().unwrap_or(false),r["useSaved"].as_bool().unwrap_or(false)).await,
                "getRememberedLogin"=>client.remembered_login(string("serverUrl")?,r["username"].as_str()),
                "forgetLogin"=>{client.forget_login(string("serverUrl")?,string("username")?)?;Ok(Value::Null)},
                "clearSavedLogins"=>{client.clear_saved_logins()?;Ok(Value::Null)},
                "logout"=>{client.logout().await?;Ok(Value::Null)},"request"=>{let result=client.request(string("path")?,r["method"].as_str().unwrap_or("GET"),r.get("body").cloned()).await?;if r["path"]=="/api/auth/password" { if let Some(p)=r["body"]["newPassword"].as_str(){client.refresh_saved_password(p)?;} }Ok(result)},
                "inspect"=>{let a=agent()?;Ok(json!({"installed":true,"version":"test transport","path":client.config.path(a),"sharedWith":[],"warnings":client.config.warnings(a,"")?}))},
                "apply"=>client.apply(agent()?,string("modelId")?).await,"restore"=>client.config.restore(agent()?),
                "launch"=>{let agent=agent()?;let model=client.available_model(agent,string("modelId")?).await?;let (credential,_)=client.credential().await?;
                    let session=terminal::create(&client.config.paths,&terminal::SessionInput{config_directory:None,agent,model,executable:std::env::current_exe().unwrap(),project:client.config.paths.home.clone(),base_url:client.preferences.server_url.clone(),credential,home:client.config.paths.home.clone()})?;
                    let (_,command)=terminal::claim(&client.config.paths,&session.payload)?;terminal::discard(&session.directory);Ok(json!({"model":command.env.get("ANTHROPIC_MODEL"),"launchPlanOnly":true}))},
                _=>Err("Unavailable in WebKit fixture".into()),
            }
        });
        println!(
            "{}",
            match result {
                Ok(result) => json!({"id":v["id"],"result":result}),
                Err(error) => json!({"id":v["id"],"error":error}),
            }
        );
        std::io::stdout().flush().unwrap();
    }
}
