//! Update state is separate from the client lock: downloads never block normal API use.
use crate::Result;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone)]
pub struct Updates(pub Arc<Mutex<Job>>);
pub struct Job {
    status: Value,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    generation: u64,
}
impl Default for Updates {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Job {
            status: json!({"state":"idle"}),
            update: None,
            bytes: None,
            task: None,
            generation: 0,
        })))
    }
}
pub fn platform() -> String {
    format!(
        "{}-{}",
        if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "windows"
        },
        std::env::consts::ARCH
    )
}
#[cfg(target_os = "macos")]
pub fn check_install_directory(bundle: &std::path::Path) -> Result<()> {
    let parent = bundle.parent().ok_or("无法定位应用目录")?;
    tempfile::Builder::new()
        .prefix(".coding-access-update-check-")
        .tempfile_in(parent)
        .map_err(|_| {
            "应用目录不可写，请使用完整安装包手动更新或移到当前用户可写目录。".to_string()
        })?;
    Ok(())
}
impl Updates {
    pub fn reset(&self) {
        self.cancel();
        let mut j = self.0.lock().unwrap();
        if j.status["state"] == "installing" {
            return;
        }
        j.status = json!({"state":"idle"});
        j.update = None;
        j.bytes = None;
    }
    pub fn status(&self) -> Value {
        self.0.lock().unwrap().status.clone()
    }
    pub fn cancel(&self) -> Value {
        let mut j = self.0.lock().unwrap();
        if j.status["state"] == "installing" {
            return j.status.clone();
        }
        j.generation += 1;
        if let Some(task) = j.task.take() {
            task.abort();
        }
        j.bytes = None;
        j.status["state"] = json!(if j.update.is_some() {
            "available"
        } else {
            "idle"
        });
        j.status["downloaded"] = json!(0);
        j.status["autoInstall"] = json!(false);
        j.status["message"] = json!("已取消下载，可重新下载");
        j.status.clone()
    }
    pub async fn check<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        base: &str,
        channel: &str,
    ) -> Result<Value> {
        let generation = {
            let mut j = self.0.lock().unwrap();
            if ["checking", "downloading", "installing", "ready"]
                .iter()
                .any(|s| j.status["state"] == *s)
            {
                return Ok(j.status.clone());
            }
            j.generation += 1;
            j.status = json!({"state":"checking"});
            j.update = None;
            j.bytes = None;
            j.generation
        };
        let result = async {
            let url = format!("{base}/api/client-updates?platform={}&channel={channel}&current={}", platform(), env!("CARGO_PKG_VERSION"));
            let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(20)).build().map_err(|_| "无法连接更新服务")?;
            let response = http.get(url).send().await.map_err(|_| "检查更新失败，请检查公司网络或 VPN")?;
            if !response.status().is_success() { return Err("更新服务暂不可用，旧版服务端需先升级".to_string()); }
            let info: Value = response.json().await.map_err(|_| "更新服务返回格式无效")?;
            let available = info["available"].as_bool().ok_or("更新服务返回格式无效")?;
            let mut update = None;
            let state = if !available { if info["latest"].is_null() { "unpublished" } else { "current" } }
                else if info["compatible"] != true { "incompatible" } else {
                    let endpoint = format!("{base}/api/client-updater/{channel}/{}/{}", platform(), env!("CARGO_PKG_VERSION")).parse().map_err(|_| "更新地址无效")?;
                    update = app.updater_builder().endpoints(vec![endpoint]).map_err(|_| "更新地址无效")?.timeout(Duration::from_secs(180))
                        .configure_client(|c| c.redirect(reqwest_updater::redirect::Policy::none())).build().map_err(|_| "更新器初始化失败")?.check().await.map_err(|_| "无法读取签名更新信息，请重试")?;
                    if let Some(ref u) = update {
                        if u.download_url.origin().ascii_serialization() != base || !u.download_url.path().starts_with("/client-artifacts/") || info["latest"] != u.version { return Err("更新文件与发布信息不匹配".into()); }
                        "available"
                    } else { "manual" }
                };
            let total = info["artifacts"].as_array().and_then(|files| files.iter().find(|a| a["kind"] == "updater")).and_then(|a| a["size"].as_u64()).filter(|n| *n > 0 && *n <= 256 * 1024 * 1024);
            Ok((json!({"state":state,"total":total,"latest":info["latest"],"notes":info["notes"],"minServerVersion":info["minServerVersion"],"checkedAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),"available":available}), update))
        }.await;
        let mut j = self.0.lock().unwrap();
        if j.generation != generation {
            return Ok(j.status.clone());
        }
        match result {
            Ok((status, update)) => {
                j.status = status;
                j.update = update;
            }
            Err(e) => {
                j.status = json!({"state":"error","message":e});
            }
        }
        Ok(j.status.clone())
    }
    pub fn download(&self) -> Result<Value> {
        self.download_inner::<tauri::Wry>(None)
    }
    pub fn download_automatic<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        isolated: bool,
        state_root: std::path::PathBuf,
    ) -> Result<Value> {
        self.download_inner(Some((app, isolated, state_root)))
    }
    fn download_inner<R: tauri::Runtime>(
        &self,
        install: Option<(AppHandle<R>, bool, std::path::PathBuf)>,
    ) -> Result<Value> {
        let mut j = self.0.lock().unwrap();
        if ["downloading", "ready", "installing"]
            .iter()
            .any(|s| j.status["state"] == *s)
        {
            return Ok(j.status.clone());
        }
        let update = j.update.clone().ok_or("请先检查可用更新")?;
        j.generation += 1;
        let generation = j.generation;
        j.status["state"] = json!("downloading");
        j.status["downloaded"] = json!(0);
        j.status["autoInstall"] = json!(install.is_some());
        j.status["message"] = Value::Null;
        let shared = self.clone();
        j.task = Some(tauri::async_runtime::spawn(async move {
            let oversized = tokio::sync::Notify::new();
            let download = update.download(
                |n, total| {
                    let mut job = shared.0.lock().unwrap();
                    if job.generation == generation {
                        let count = job.status["downloaded"].as_u64().unwrap_or(0) + n as u64;
                        job.status["downloaded"] = json!(count);
                        if let Some(total) = total {
                            job.status["total"] = json!(total);
                        }
                        if count > 256 * 1024 * 1024 || total.is_some_and(|v| v > 256 * 1024 * 1024)
                        {
                            oversized.notify_one();
                        }
                    }
                },
                || {},
            );
            let result = tokio::select! {
                value = download => value.map_err(|_| "下载或签名校验失败，当前版本未改变。请重试或联系管理员。"),
                _ = oversized.notified() => Err("更新包超过 256 MB，下载已停止，当前版本未改变。"),
                _ = tokio::time::sleep(Duration::from_secs(600)) => Err("更新下载超时，可重新下载，当前版本未改变。"),
            };
            {
                let mut job = shared.0.lock().unwrap();
                if job.generation != generation {
                    return;
                }
                match result {
                    Ok(bytes) => {
                        job.status["downloaded"] = json!(bytes.len());
                        job.status["total"] = json!(bytes.len());
                        job.bytes = Some(bytes);
                        job.status["state"] = json!("ready");
                    }
                    Err(message) => {
                        job.bytes = None;
                        job.status["state"] = json!("error");
                        job.status["message"] = json!(message);
                    }
                }
            }
            if let Some((app, isolated, root)) = install {
                // Real completion feedback, not simulated download progress. Leave
                // two seconds to show 100% and allow cancellation before installing.
                tokio::time::sleep(Duration::from_secs(2)).await;
                if let Err(message) =
                    shared.install_generation(&app, isolated, &root, Some(generation))
                {
                    let mut job = shared.0.lock().unwrap();
                    if job.generation == generation && job.status["state"] == "ready" {
                        job.status["state"] = json!("error");
                        job.status["message"] = json!(message);
                    }
                }
            }
        }));
        Ok(j.status.clone())
    }
    pub fn install<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        isolated: bool,
        state_root: &std::path::Path,
    ) -> Result<Value> {
        self.install_generation(app, isolated, state_root, None)
    }
    fn install_generation<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        isolated: bool,
        state_root: &std::path::Path,
        generation: Option<u64>,
    ) -> Result<Value> {
        let (update, bytes) = {
            let mut j = self.0.lock().unwrap();
            if generation.is_some_and(|g| g != j.generation) {
                return Ok(j.status.clone());
            }
            if j.status["state"] != "ready" {
                return Err("请先下载并校验更新包".into());
            }
            if isolated {
                return Err("开发环境不执行自更新安装，请使用隔离的发行版验收".into());
            }
            let update = j.update.clone().ok_or("更新信息已失效")?;
            let bytes = j.bytes.take().ok_or("更新包已失效")?;
            j.status["state"] = json!("installing");
            (update, bytes)
        };
        #[cfg(target_os = "macos")]
        let rollback = {
            let located = std::env::current_exe()
                .map_err(|_| "无法定位当前应用")
                .and_then(|exe| {
                    tauri_plugin_updater::extract_path_from_executable(&exe)
                        .map_err(|_| "无法定位应用目录")
                });
            let bundle = match located {
                Ok(path) => path,
                Err(message) => {
                    let mut j = self.0.lock().unwrap();
                    j.status["state"] = json!("error");
                    j.status["message"] = json!(message);
                    return Ok(j.status.clone());
                }
            };
            if let Err(message) = check_install_directory(&bundle) {
                let mut j = self.0.lock().unwrap();
                j.status["state"] = json!("error");
                j.status["message"] = json!(message);
                return Ok(j.status.clone());
            }
            let backup = state_root
                .join("update-backups")
                .join(uuid::Uuid::new_v4().to_string())
                .join("Coding Access.app");
            if let Err(e) = crate::filesystem::copy_bundle(&bundle, &backup) {
                let mut j = self.0.lock().unwrap();
                j.status["state"] = json!("error");
                j.status["message"] = json!(e);
                return Ok(j.status.clone());
            }
            (bundle, backup)
        };
        #[cfg(not(target_os = "macos"))]
        let _ = state_root;
        if update.install(bytes).is_err() {
            #[cfg(target_os = "macos")]
            if !rollback.0.exists() {
                let _ = crate::filesystem::copy_bundle(&rollback.1, &rollback.0);
            }

            let mut j = self.0.lock().unwrap();
            j.status["state"] = json!("error");
            j.status["message"] = json!("安装失败，请检查安装目录权限，或下载完整安装包后安装。");
            return Ok(j.status.clone());
        }
        app.restart();
    }
}
