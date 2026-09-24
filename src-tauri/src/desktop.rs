use crate::{
    agents, client::Client, filesystem::Paths, migration, model::Agent, terminal,
    vault::SystemVault, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt;

struct WindowBehavior {
    tray_ready: AtomicBool,
    prompt_open: AtomicBool,
    close_action: std::sync::Mutex<String>,
}
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
fn hide_main(window: &WebviewWindow) -> Result<()> {
    if !window
        .state::<WindowBehavior>()
        .tray_ready
        .load(Ordering::SeqCst)
    {
        return Err("托盘暂不可用，请最小化窗口或退出程序".into());
    }
    window.hide().map_err(|_| "无法隐藏窗口，请重试".into())
}
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

pub struct AppState(Mutex<Result<Client>>);
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BridgeRequest {
    GetState,
    GetRememberedLogin {
        server_url: String,
        username: Option<String>,
    },
    ForgetLogin {
        server_url: String,
        username: String,
    },
    ClearSavedLogins,
    CloseWindow {
        choice: String,
        remember: bool,
    },
    Update {
        operation: String,
    },
    GetSettings,
    SaveSettings {
        preferences: crate::client::Preferences,
    },
    TestConnection {
        server_url: String,
    },
    SaveText {
        name: String,
        contents: String,
    },
    MigrationStatus,
    RetryUpgrade,
    PreviewMigration {
        source_id: String,
    },
    ImportMigration {
        source_id: String,
        fingerprint: String,
    },
    UndoMigration,
    Login {
        server_url: String,
        username: String,
        password: String,
        #[serde(default)]
        remember: bool,
        #[serde(default)]
        use_saved: bool,
    },
    Logout,
    Request {
        path: String,
        method: Option<String>,
        body: Option<Value>,
    },
    Inspect {
        agent: Agent,
    },
    Apply {
        agent: Agent,
        model_id: String,
    },
    Restore {
        agent: Agent,
    },
    ChooseDirectory,
    Launch {
        agent: Agent,
        model_id: String,
    },
    Download {
        path: String,
    },
    CopyText {
        value: String,
    },
}
fn trusted(url: &url::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("localhost")
            && url.port() == Some(1420))
}
#[tauri::command]
async fn coding_access(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: BridgeRequest,
) -> Result<Value> {
    if window.label() != "main" || !trusted(&window.url().map_err(|_| "无法识别请求来源")?)
    {
        return Err("请求来源不受信任".into());
    }
    if let BridgeRequest::CloseWindow { choice, remember } = &request {
        let behavior = window.state::<WindowBehavior>();
        if !["cancel", "hide", "quit"].contains(&choice.as_str()) {
            return Err("关闭选项无效".into());
        }
        if choice == "cancel" {
            behavior.prompt_open.store(false, Ordering::SeqCst);
            return Ok(Value::Null);
        }
        if choice == "hide" && !behavior.tray_ready.load(Ordering::SeqCst) {
            return Err("托盘暂不可用，请最小化窗口或退出程序".into());
        }
        if *remember {
            let mut locked = state.0.lock().await;
            let client = locked.as_mut().map_err(|e| e.clone())?;
            client.save_close_action(choice)?;
            *behavior.close_action.lock().unwrap() = choice.clone();
        }
        if choice == "hide" {
            hide_main(&window)?;
        }
        behavior.prompt_open.store(false, Ordering::SeqCst);
        if choice == "quit" {
            window.app_handle().exit(0);
        }
        return Ok(Value::Null);
    }
    if let BridgeRequest::Update { operation } = &request {
        let updates = window.state::<crate::updates::Updates>();
        return match operation.as_str() {
            "status" => Ok(updates.status()),
            "cancel" => Ok(updates.cancel()),
            "download" => updates.download(),
            "downloadAndInstall" => {
                let locked = state.0.lock().await;
                let client = locked.as_ref().map_err(|e| e.clone())?;
                updates.download_automatic(
                    window.app_handle().clone(),
                    client.config.paths.isolated,
                    client.config.paths.state.clone(),
                )
            }
            "check" => {
                let (base, channel) = {
                    let locked = state.0.lock().await;
                    let c = locked.as_ref().map_err(|e| e.clone())?;
                    (
                        c.preferences.server_url.clone(),
                        c.preferences.update_channel.clone(),
                    )
                };
                updates.check(window.app_handle(), &base, &channel).await
            }
            "install" => {
                let locked = state.0.lock().await;
                let isolated = locked
                    .as_ref()
                    .map_err(|e| e.clone())?
                    .config
                    .paths
                    .isolated;
                updates.install(
                    window.app_handle(),
                    isolated,
                    &locked.as_ref().map_err(|e| e.clone())?.config.paths.state,
                )
            }
            _ => Err("Unknown update operation".into()),
        };
    }
    let mut locked = state.0.lock().await;
    let client = locked.as_mut().map_err(|e| e.clone())?;
    match request {
        BridgeRequest::Update { .. } | BridgeRequest::CloseWindow { .. } => unreachable!(),
        BridgeRequest::GetState => client.live_state().await,
        BridgeRequest::GetRememberedLogin {
            server_url,
            username,
        } => client.remembered_login(&server_url, username.as_deref()),
        BridgeRequest::ForgetLogin {
            server_url,
            username,
        } => {
            client.forget_login(&server_url, &username)?;
            Ok(Value::Null)
        }
        BridgeRequest::ClearSavedLogins => {
            client.clear_saved_logins()?;
            Ok(Value::Null)
        }
        BridgeRequest::GetSettings => {
            let mut result = client.settings()?;
            let isolated = client.config.paths.isolated;
            result["preferences"]["startOnLogin"] = json!(
                !isolated
                    && window
                        .autolaunch()
                        .is_enabled()
                        .map_err(|_| "无法读取开机启动状态")?
            );
            result["desktopIntegrationAvailable"] = json!(!isolated);
            result["trayAvailable"] = json!(window
                .state::<WindowBehavior>()
                .tray_ready
                .load(Ordering::SeqCst));
            Ok(result)
        }
        BridgeRequest::SaveSettings { preferences } => {
            let previous = client.preferences.clone();
            let enabled = preferences.start_on_login;
            if enabled && client.config.paths.isolated {
                return Err("开发隔离模式不注册开机启动，请在正式安装的客户端中设置".into());
            }
            let mut result = client.save_settings(preferences)?;
            if !client.config.paths.isolated {
                let launch = window.autolaunch();
                let change = launch.is_enabled().and_then(|current| {
                    if current == enabled {
                        Ok(())
                    } else if enabled {
                        launch.enable()
                    } else {
                        launch.disable()
                    }
                });
                if change.is_err() {
                    client.save_settings(previous)?;
                    return Err("开机启动设置失败，原有设置已保留；请检查系统登录项权限".into());
                }
            }
            *window
                .state::<WindowBehavior>()
                .close_action
                .lock()
                .unwrap() = client.preferences.close_action.clone();
            result["desktopIntegrationAvailable"] = json!(!client.config.paths.isolated);
            result["trayAvailable"] = json!(window
                .state::<WindowBehavior>()
                .tray_ready
                .load(Ordering::SeqCst));
            window.state::<crate::updates::Updates>().reset();
            Ok(result)
        }
        BridgeRequest::TestConnection { server_url } => client.test_connection(&server_url).await,
        BridgeRequest::SaveText { name, contents } => {
            if contents.len() > 20 * 1024 * 1024 || name.contains(['/', '\\']) {
                return Err("导出文件无效".into());
            }
            let Some(path) = window
                .dialog()
                .file()
                .set_file_name(&name)
                .blocking_save_file()
            else {
                return Ok(json!(false));
            };
            crate::filesystem::atomic_write(
                &path.into_path().map_err(|_| "请选择本地文件")?,
                contents.as_bytes(),
            )?;
            Ok(json!(true))
        }
        BridgeRequest::RetryUpgrade => client.retry_upgrade(),
        BridgeRequest::MigrationStatus => {
            migration::status(&client.config.paths, &migration::discover())
        }
        BridgeRequest::PreviewMigration { source_id } => {
            let source = migration::discover()
                .into_iter()
                .find(|s| s.id() == source_id)
                .ok_or("未找到旧版数据，请重新检查")?;
            serde_json::to_value(source.preview()?).map_err(|_| "无法读取导入预览".into())
        }
        BridgeRequest::ImportMigration {
            source_id,
            fingerprint,
        } => {
            if !client.config.paths.isolated {
                return Err("新版会自动接续旧配置，请使用重新检查，无需手动导入".into());
            }
            if client.has_credentials() {
                return Err("请在首次登录前导入旧版数据".into());
            }
            let source = migration::discover()
                .into_iter()
                .find(|s| s.id() == source_id)
                .ok_or("未找到旧版数据，请重新检查")?;
            let receipt = migration::import(&client.config.paths, &source, &fingerprint)?;
            client.reload_preferences()?;
            serde_json::to_value(receipt).map_err(|_| "无法读取导入结果".into())
        }
        BridgeRequest::UndoMigration => {
            if !client.config.paths.isolated {
                return Err("自动升级记录用于保留原始备份，请在排查问题中恢复工具配置".into());
            }
            if client.has_credentials() {
                return Err("登录后请保留当前配置，无法直接撤销导入".into());
            }
            migration::undo(&client.config.paths)?;
            client.reload_preferences()?;
            Ok(Value::Null)
        }
        BridgeRequest::Login {
            server_url,
            username,
            password,
            remember,
            use_saved,
        } => {
            window.state::<crate::updates::Updates>().reset();
            client
                .login_remembered(&server_url, &username, &password, remember, use_saved)
                .await
        }
        BridgeRequest::Logout => {
            window.state::<crate::updates::Updates>().reset();
            client.logout().await?;
            Ok(Value::Null)
        }
        BridgeRequest::Request { path, method, body } => {
            let new_password = if path == "/api/auth/password" && method.as_deref() == Some("POST")
            {
                body.as_ref()
                    .and_then(|v| v["newPassword"].as_str())
                    .map(str::to_owned)
            } else {
                None
            };
            let mut result = client
                .request(&path, method.as_deref().unwrap_or("GET"), body)
                .await?;
            if let Some(password) = new_password {
                if client.refresh_saved_password(&password).is_err() {
                    result["warning"] =
                        json!("密码已修改，但本机保存的密码未能更新，请下次登录时输入新密码。");
                }
            }
            Ok(result)
        }
        BridgeRequest::Inspect { agent } => {
            let mut found = client.tool_path(agent);
            let installed = if agent.desktop() && found.is_none() {
                match agents::desktop_target(agent).await? {
                    Some(agents::DesktopTarget::File(path)) => {
                        found = Some(path);
                        true
                    }
                    Some(agents::DesktopTarget::Store(_)) => true,
                    None => false,
                }
            } else {
                found.is_some()
            };
            let version = if let Some(p) = &found {
                if agent.desktop() {
                    None
                } else {
                    agents::version(p).await
                }
            } else {
                None
            };
            Ok(
                json!({"installed":installed,"version":version,"executablePath":found,"path":client.config.path(agent),"sharedWith":if agent.codex(){vec![if agent==Agent::CodexCli{"Codex 桌面版"}else{"Codex CLI"}]}else{vec![]},"warnings":client.config.warnings(agent,&client.preferences.project_directory)?}),
            )
        }
        BridgeRequest::Apply { agent, model_id } => {
            let model = client.available_model(agent, &model_id).await?;
            let (key, credential_id) = client.credential().await?;
            let same = client.config.configuration_matches(
                agent,
                &model,
                &client.preferences.server_url,
                &key,
            )?;
            let running = !same
                && agent.desktop()
                && !client.config.paths.isolated
                && agents::desktop_running(agent).await?;
            client.config.apply_checked(
                agent,
                &model,
                &client.preferences.server_url,
                &key,
                &credential_id,
                running,
            )
        }
        BridgeRequest::Restore { agent } => {
            if agent == Agent::Zcode
                && !client.config.paths.isolated
                && agents::zcode_running().await?
            {
                return Err("请先完全退出 ZCode，再恢复配置".into());
            }
            client.config.restore(agent)
        }
        BridgeRequest::ChooseDirectory => {
            let selected = window
                .dialog()
                .file()
                .set_title("选择项目目录")
                .set_directory(if client.preferences.project_directory.is_empty() {
                    client.config.paths.home.clone()
                } else {
                    client.preferences.project_directory.clone().into()
                })
                .blocking_pick_folder();
            match selected {
                Some(p) => Ok(json!(
                    client.choose_directory(p.into_path().map_err(|_| "请选择本地项目目录")?)?
                )),
                None => Ok(Value::Null),
            }
        }
        BridgeRequest::Launch { agent, model_id } => {
            if agent.desktop() && client.config.paths.isolated {
                return Err("Tauri 开发版暂不启动桌面 Agent，避免影响正在使用的 Codex 和 ZCode；配置可在独立测试目录验收。".into());
            }
            if agent.desktop() {
                let model = client.available_model(agent, &model_id).await?;
                let (key, _) = client.credential().await?;
                let records = client.config.records()?;
                let record = records.get(agent.key()).ok_or("请先启用此模型")?;
                if record.model_id != model_id
                    || !client.config.configuration_matches(
                        agent,
                        &model,
                        &client.preferences.server_url,
                        &key,
                    )?
                {
                    return Err("请先启用或同步此模型，再打开桌面工具".into());
                }
                let target = match client.tool_path(agent) {
                    Some(p) => Some(agents::DesktopTarget::File(p)),
                    None => agents::desktop_target(agent).await?,
                }
                .ok_or("未检测到工具，请先安装，或手动打开已安装的应用")?;
                agents::launch_desktop(target).await?;
                return Ok(Value::Null);
            }
            let executable = client.tool_path(agent).ok_or("未检测到工具，请先安装")?;
            let model = client.available_model(agent, &model_id).await?;
            let (key, _) = client.credential().await?;
            let input = terminal::SessionInput {
                config_directory: None,
                agent,
                executable,
                project: client.preferences.project_directory.clone().into(),
                model,
                base_url: client.preferences.server_url.clone(),
                credential: key,
                home: client.config.paths.home.clone(),
            };
            let session = terminal::create(&client.config.paths, &input)?;
            if let Err(e) = terminal::launch_terminal_with(
                &session,
                &input.project,
                &client.config.paths,
                &client.preferences.terminal,
            )
            .await
            {
                terminal::discard(&session.directory);
                return Err(e);
            }
            Ok(Value::Null)
        }
        BridgeRequest::Download { path } => {
            let url = client.download_url(&path).await?;
            window
                .opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "无法打开安装包下载地址")?;
            Ok(Value::Null)
        }
        BridgeRequest::CopyText { value } => {
            if value.is_empty() || value.len() > 64 * 1024 {
                return Err("复制内容长度无效".into());
            }
            window
                .clipboard()
                .write_text(value)
                .map_err(|_| "无法复制，请检查剪贴板权限")?;
            Ok(Value::Null)
        }
    }
}
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(if cfg!(feature = "distribution") {
                    "Coding Access"
                } else {
                    "Coding Access Dev"
                })
                .args(["--autostart"])
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(crate::updates::Updates::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let client = Paths::runtime().and_then(|paths| {
                terminal::clean_stale(&paths);
                let vault = if paths.isolated {
                    SystemVault::new(&paths.state)
                } else {
                    SystemVault::production(&paths.state)
                };
                Client::new(paths, Box::new(vault))
            });
            #[cfg(debug_assertions)]
            if let Err(error) = &client {
                eprintln!("Tauri development initialization: {error}");
            }
            let close_action = client
                .as_ref()
                .map(|c| c.preferences.close_action.clone())
                .unwrap_or_else(|_| "ask".into());
            let start_hidden = std::env::args().any(|a| a == "--autostart")
                && client
                    .as_ref()
                    .is_ok_and(|c| c.preferences.start_hidden && !c.config.paths.isolated);
            app.manage(WindowBehavior {
                tray_ready: AtomicBool::new(false),
                prompt_open: AtomicBool::new(false),
                close_action: std::sync::Mutex::new(close_action),
            });
            app.manage(AppState(Mutex::new(client)));
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(trusted)
                .build()?;
            // Never hide a window unless a usable tray icon was created.
            let tray_result = (|| -> tauri::Result<()> {
                let show = tauri::menu::MenuItem::with_id(
                    app,
                    "show",
                    "显示 Coding Access",
                    true,
                    None::<&str>,
                )?;
                let quit =
                    tauri::menu::MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)?;
                let menu = tauri::menu::Menu::with_items(app, &[&show, &quit])?;
                let mut tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
                    .tooltip("Coding Access")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if matches!(
                            event,
                            tauri::tray::TrayIconEvent::Click {
                                button: tauri::tray::MouseButton::Left,
                                button_state: tauri::tray::MouseButtonState::Up,
                                ..
                            }
                        ) {
                            show_main(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
                Ok(())
            })();
            app.state::<WindowBehavior>()
                .tray_ready
                .store(tray_result.is_ok(), Ordering::SeqCst);
            if start_hidden && tray_result.is_ok() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let behavior = window.state::<WindowBehavior>();
                let action = behavior.close_action.lock().unwrap().clone();
                if action == "quit" {
                    window.app_handle().exit(0);
                    return;
                }
                if action == "hide"
                    && behavior.tray_ready.load(Ordering::SeqCst)
                    && window.hide().is_ok()
                {
                    return;
                }
                {
                    behavior.prompt_open.store(true, Ordering::SeqCst);
                    if window
                        .emit(
                            "aca-close-requested",
                            json!({"trayAvailable": behavior.tray_ready.load(Ordering::SeqCst)}),
                        )
                        .is_err()
                    {
                        behavior.prompt_open.store(false, Ordering::SeqCst);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![coding_access])
        .build(tauri::generate_context!())
        .expect("无法启动 Coding Access")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            let _ = (app, event);
        });
}
