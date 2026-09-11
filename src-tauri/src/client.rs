use crate::{
    config::ConfigManager,
    filesystem::*,
    model::{Agent, Model},
    vault::Vault,
    Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const DEFAULT_URL: &str = match option_env!("ACA_DEFAULT_SERVICE_URL") {
    Some(value) => value,
    None => "",
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub server_url: String,
    pub project_directory: String,
    #[serde(default)]
    pub tool_paths: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub terminal: String,
    #[serde(default = "default_update_check")]
    pub check_updates: bool,
    #[serde(default = "default_channel")]
    pub update_channel: String,
    #[serde(default)]
    pub start_on_login: bool,
    #[serde(default)]
    pub start_hidden: bool,
    #[serde(default = "default_close_action")]
    pub close_action: String,
}
fn default_close_action() -> String {
    "ask".into()
}
fn default_update_check() -> bool {
    true
}
fn default_channel() -> String {
    if env!("CARGO_PKG_VERSION").contains('-') {
        "beta".into()
    } else {
        "stable".into()
    }
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            server_url: DEFAULT_URL.into(),
            project_directory: String::new(),
            tool_paths: Default::default(),
            terminal: String::new(),
            check_updates: true,
            update_channel: default_channel(),
            start_on_login: false,
            start_hidden: false,
            close_action: default_close_action(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct SavedLogin {
    username: String,
    password: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Secrets {
    server_url: String,
    device: String,
    session: Option<String>,
    user_id: Option<String>,
    api_key: Option<String>,
    credential_id: Option<String>,
    #[serde(default)]
    login_username: Option<String>,
    #[serde(default)]
    saved_logins: std::collections::BTreeMap<String, SavedLogin>,
    #[serde(default)]
    last_logins: std::collections::BTreeMap<String, String>,
}
impl Default for Secrets {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            device: uuid::Uuid::new_v4().to_string(),
            session: None,
            user_id: None,
            api_key: None,
            credential_id: None,
            login_username: None,
            saved_logins: Default::default(),
            last_logins: Default::default(),
        }
    }
}
pub fn base_url(raw: &str) -> Result<String> {
    if raw.trim().is_empty() || raw.len() > 2048 {
        return Err("请填写有效的公司服务地址".into());
    }
    let url = url::Url::parse(raw.trim())
        .map_err(|_| "请填写完整的公司服务地址，例如 http://localhost:4317")?;
    if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() {
        return Err("公司服务地址须使用 HTTP 或 HTTPS".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("请填写公司服务根地址，不包含用户名、路径或查询参数".into());
    }
    Ok(url.origin().ascii_serialization())
}
pub fn allowed_request(path: &str, method: &str) -> bool {
    if path.len() > 4096
        || path.chars().any(char::is_control)
        || path.contains('#')
        || !path.is_ascii()
    {
        return false;
    }
    let route = path.split('?').next().unwrap_or("");
    match (method, route) {
        (
            "GET",
            "/api/meta"
            | "/api/client-release"
            | "/api/auth/me"
            | "/api/models"
            | "/api/me/stats"
            | "/api/me/analytics"
            | "/api/me/requests"
            | "/api/me/credential-status",
        ) => true,
        ("POST", "/api/auth/password") => true,
        // Administration stays in the browser. Native API access cannot issue
        // credentials into the renderer or escape to an arbitrary URL.
        _ => false,
    }
}
pub struct Client {
    pub config: ConfigManager,
    pub preferences: Preferences,
    secrets: Secrets,
    vault: Box<dyn Vault>,
    http: reqwest::Client,
    upgrade_error: Option<String>,
}
impl Client {
    fn login_key(base: &str, username: &str) -> String {
        format!("{base}\n{username}")
    }
    pub fn remembered_login(&self, server_url: &str, username: Option<&str>) -> Result<Value> {
        let base = base_url(server_url)?;
        let name = username.filter(|s| !s.is_empty()).or_else(|| self.secrets.last_logins.get(&base).map(String::as_str)).unwrap_or("");
        let saved = self.secrets.saved_logins.get(&Self::login_key(&base, name));
        // A renderer can request a saved login, but never receives its password.
        Ok(json!({"username": name, "remembered": saved.is_some_and(|s| s.password.is_some())}))
    }
    pub fn forget_login(&mut self, server_url: &str, username: &str) -> Result<()> {
        let base = base_url(server_url)?;
        let mut secrets = self.secrets.clone();
        secrets.saved_logins.remove(&Self::login_key(&base, username));
        self.save_secrets(secrets)
    }
    pub fn clear_saved_logins(&mut self) -> Result<()> {
        let mut secrets = self.secrets.clone();
        secrets.saved_logins.clear();
        secrets.last_logins.clear();
        self.save_secrets(secrets)
    }
    pub fn refresh_saved_password(&mut self, password: &str) -> Result<()> {
        let mut secrets = self.secrets.clone();
        if let Some(name) = &secrets.login_username {
            let key = Self::login_key(&secrets.server_url, name);
            if let Some(saved) = secrets.saved_logins.get_mut(&key) {
                if saved.password.is_some() { saved.password = Some(password.into()); }
            }
        }
        self.save_secrets(secrets)
    }
    pub async fn login_remembered(&mut self, server_url: &str, username: &str, password: &str, remember: bool, use_saved: bool) -> Result<Value> {
        let base = base_url(server_url)?;
        let key = Self::login_key(&base, username);
        let password = if use_saved {
            self.secrets.saved_logins.get(&key).and_then(|s| s.password.clone()).ok_or("未保存此账号密码，请重新输入")?
        } else { password.to_owned() };
        let result = self.login(&base, username, &password).await?;
        let mut secrets = self.secrets.clone();
        secrets.last_logins.insert(base, username.into());
        if remember { secrets.saved_logins.insert(key, SavedLogin { username: username.into(), password: Some(password) }); }
        else { secrets.saved_logins.remove(&key); }
        self.save_secrets(secrets)?;
        Ok(result)
    }
    pub fn tool_path(&self, agent: Agent) -> Option<std::path::PathBuf> {
        self.preferences
            .tool_paths
            .get(agent.id())
            .map(std::path::PathBuf::from)
            .filter(|p| p.exists())
            .or_else(|| crate::terminal::locate_tool(agent))
    }
    pub fn save_settings(&mut self, mut preferences: Preferences) -> Result<Value> {
        // Changing the server happens through login, never by reusing the old credential.
        if preferences.server_url != self.preferences.server_url {
            return Err("切换服务地址请退出后重新登录".into());
        }
        if !preferences.project_directory.is_empty()
            && !std::path::Path::new(&preferences.project_directory).is_dir()
        {
            return Err("项目目录不存在".into());
        }
        if !["", "Terminal", "iTerm", "powershell", "wt"].contains(&preferences.terminal.as_str()) {
            return Err("终端选项无效".into());
        }
        if !["stable", "beta"].contains(&preferences.update_channel.as_str()) {
            return Err("更新通道无效".into());
        }
        if !["ask", "hide", "quit"].contains(&preferences.close_action.as_str()) {
            return Err("关闭窗口选项无效".into());
        }
        preferences.tool_paths.retain(|_, p| !p.trim().is_empty());
        for (agent, path) in &preferences.tool_paths {
            let agent: Agent = serde_json::from_value(json!(agent)).map_err(|_| "工具类型无效")?;
            crate::agents::validate_manual_path(agent, std::path::Path::new(path))?;
        }
        save_json(
            &self.config.paths.state.join("preferences.json"),
            &preferences,
        )?;
        self.preferences = preferences;
        self.settings()
    }
    pub fn save_close_action(&mut self, action: &str) -> Result<()> {
        if !["ask", "hide", "quit"].contains(&action) {
            return Err("关闭窗口选项无效".into());
        }
        let mut preferences = self.preferences.clone();
        preferences.close_action = action.into();
        save_json(
            &self.config.paths.state.join("preferences.json"),
            &preferences,
        )?;
        self.preferences = preferences;
        Ok(())
    }
    pub fn settings(&self) -> Result<Value> {
        Ok(
            json!({"preferences": self.preferences, "backupDirectory": self.config.paths.state.join("backups")}),
        )
    }
    pub async fn test_connection(&self, base: &str) -> Result<Value> {
        let (_, body) = self.send(base, "/api/meta", "GET", None, None).await?;
        if !body.get("version").is_some_and(Value::is_string) {
            return Err("该地址未返回 Coding Access 服务信息".into());
        }
        Ok(json!({"version":body["version"],"companyName":body["companyName"]}))
    }
    pub fn new(paths: Paths, vault: Box<dyn Vault>) -> Result<Self> {
        crate::migration::recover(&paths)?;
        // Local upgrade issues must not block login or the server model list.
        // Run before loading preferences so a first upgrade retains its address.
        let upgrade_error = crate::migration::automatic(&paths).err();
        let preferences = read_json(&paths.state.join("preferences.json"))?;
        let secrets = match vault.load()? {
            Some(s) => serde_json::from_str(&s).map_err(|_| "本地登录凭证格式无效")?,
            None => Secrets::default(),
        };
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "无法初始化公司服务连接")?;
        Ok(Self {
            config: ConfigManager { paths },
            preferences,
            secrets,
            vault,
            http,
            upgrade_error,
        })
    }
    pub fn has_credentials(&self) -> bool {
        self.secrets.session.is_some() || self.secrets.api_key.is_some()
    }
    pub fn reload_preferences(&mut self) -> Result<()> {
        self.preferences = read_json(&self.config.paths.state.join("preferences.json"))?;
        Ok(())
    }
    pub fn retry_upgrade(&mut self) -> Result<Value> {
        self.upgrade_error = crate::migration::automatic(&self.config.paths).err();
        self.reload_preferences()?;
        self.state()
    }
    fn save_secrets(&mut self, secrets: Secrets) -> Result<()> {
        self.vault
            .save(&serde_json::to_string(&secrets).map_err(|_| "凭证序列化失败")?)?;
        self.secrets = secrets;
        Ok(())
    }
    fn save_preferences(&self) -> Result<()> {
        save_json(
            &self.config.paths.state.join("preferences.json"),
            &self.preferences,
        )
    }
    async fn send(
        &self,
        base: &str,
        path: &str,
        method: &str,
        body: Option<Value>,
        token: Option<&str>,
    ) -> Result<(u16, Value)> {
        let base = base_url(base)?;
        let mut r = self.http.request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "请求方法无效")?,
            format!("{base}{path}"),
        );
        if let Some(token) = token {
            r = r.bearer_auth(token);
        }
        if let Some(body) = body {
            r = r.json(&body);
        }
        let mut r = r
            .send()
            .await
            .map_err(|_| "无法连接公司服务，请检查服务地址和公司网络 / VPN")?;
        let status = r.status().as_u16();
        if (300..400).contains(&status) {
            return Err("公司服务返回了重定向，请填写最终服务根地址".into());
        }
        let mut bytes = vec![];
        while let Some(chunk) = r.chunk().await.map_err(|_| "公司服务响应中断，请重试")?
        {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err("公司服务响应过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let data = serde_json::from_slice(&bytes)
            .map_err(|_| format!("公司服务返回了无效响应（{status}）"))?;
        Ok((status, data))
    }
    fn checked(status: u16, data: Value) -> Result<Value> {
        if (200..300).contains(&status) {
            Ok(data)
        } else if status == 401 {
            Err("请登录公司账号".into())
        } else {
            Err(data["error"]["message"]
                .as_str()
                .unwrap_or("公司服务请求失败，请稍后重试")
                .chars()
                .take(500)
                .collect())
        }
    }
    pub async fn request(&self, path: &str, method: &str, body: Option<Value>) -> Result<Value> {
        if !allowed_request(path, method) {
            return Err("客户端不支持该接口".into());
        }
        if body
            .as_ref()
            .is_some_and(|v| v.to_string().len() > 1024 * 1024)
        {
            return Err("请求内容过长".into());
        }
        let token = if self.secrets.server_url == self.preferences.server_url {
            self.secrets.session.as_deref()
        } else {
            None
        };
        let (s, v) = self
            .send(&self.preferences.server_url, path, method, body, token)
            .await?;
        Self::checked(s, v)
    }
    pub async fn login(
        &mut self,
        server_url: &str,
        username: &str,
        password: &str,
    ) -> Result<Value> {
        let base = base_url(server_url)?;
        if username.is_empty()
            || username.len() > 320
            || password.is_empty()
            || password.len() > 1024
        {
            return Err("请输入有效的账号和密码".into());
        }
        if self.secrets.server_url != base
            && (self.secrets.session.is_some() || self.secrets.api_key.is_some())
        {
            self.logout().await?;
        }
        let(s,result)=self.send(&base,"/api/auth/login","POST",Some(json!({"username":username,"password":password,"client":"desktop","device":self.secrets.device})),None).await?;
        if s == 401 {
            return Err("账号或密码不正确".into());
        }
        let result = Self::checked(s, result)?;
        let user = result["user"]["id"]
            .as_str()
            .ok_or("公司服务未返回账号信息")?
            .to_owned();
        let session = result["sessionToken"]
            .as_str()
            .ok_or("公司服务未返回登录凭证")?
            .to_owned();
        if self.secrets.user_id.as_ref().is_some_and(|id| id != &user) {
            self.logout().await?;
        }
        let mut secrets = self.secrets.clone();
        secrets.server_url = base.clone();
        secrets.session = Some(session);
        secrets.user_id = Some(user);
        secrets.login_username = Some(username.into());
        self.save_secrets(secrets)?;
        self.preferences.server_url = base;
        self.save_preferences()?;
        Ok(json!({"user":result["user"]}))
    }
    pub async fn logout(&mut self) -> Result<()> {
        if let Some(token) = self
            .secrets
            .api_key
            .as_deref()
            .or(self.secrets.session.as_deref())
        {
            let (s, _) = self
                .send(
                    &self.secrets.server_url,
                    "/api/auth/device-logout",
                    "POST",
                    None,
                    Some(token),
                )
                .await?;
            if ![200, 401].contains(&s) {
                return Err("公司服务未确认凭证撤销，请连接公司网络后重新退出".into());
            }
        }
        self.save_secrets(Secrets {
            server_url: self.preferences.server_url.clone(),
            device: self.secrets.device.clone(),
            saved_logins: self.secrets.saved_logins.clone(),
            last_logins: self.secrets.last_logins.clone(),
            ..Secrets::default()
        })
    }
    pub fn state(&self) -> Result<Value> {
        let configured = self.config.configured_with_targets(
            &self.preferences.server_url,
            self.secrets.api_key.as_deref(),
            self.secrets.credential_id.as_deref(),
            &[],
        )?;
        Ok(
            json!({"serverUrl":self.preferences.server_url,"projectDirectory":self.preferences.project_directory,"version":env!("CARGO_PKG_VERSION"),"platform":if cfg!(target_os="macos"){"darwin"}else if cfg!(target_os="windows"){"win32"}else{"linux"},"development":self.config.paths.isolated,"configured":configured,"upgradeError":self.upgrade_error,"upgradeIssues":crate::migration::issues(&self.config.paths)?}),
        )
    }
    pub async fn live_state(&self) -> Result<Value> {
        let mut state = self.state()?;
        if self.secrets.api_key.is_some() && !self.config.records()?.is_empty() {
            if let Ok(catalog) = self.request("/api/models", "GET", None).await {
                let models: Vec<Model> = catalog["models"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| serde_json::from_value(v.clone()).ok())
                    .collect();
                state["configured"] = self.config.configured_with_targets(
                    &self.preferences.server_url,
                    self.secrets.api_key.as_deref(),
                    self.secrets.credential_id.as_deref(),
                    &models,
                )?;
            }
        }
        Ok(state)
    }
    pub fn choose_directory(&mut self, path: std::path::PathBuf) -> Result<String> {
        if !path.is_dir() {
            return Err("项目目录不存在，请重新选择".into());
        }
        let path = path.to_str().ok_or("项目路径编码不受支持")?;
        if path.chars().any(char::is_control) {
            return Err("项目路径包含不支持的控制字符".into());
        }
        self.preferences.project_directory = path.into();
        self.save_preferences()?;
        Ok(path.into())
    }
    pub async fn available_model(&self, agent: Agent, id: &str) -> Result<Model> {
        if id.is_empty() || id.len() > 128 {
            return Err("模型编号无效".into());
        }
        let catalog = self
            .request(&format!("/api/models?agent={}", agent.id()), "GET", None)
            .await?;
        let m = catalog["models"]
            .as_array()
            .and_then(|a| a.iter().find(|m| m["id"].as_str() == Some(id)))
            .ok_or("该模型已不在可用目录，请刷新后重新选择")?;
        let model: Model =
            serde_json::from_value(m.clone()).map_err(|_| "公司服务的模型配置格式无效")?;
        model.validate()?;
        Ok(model)
    }
    pub async fn credential(&mut self) -> Result<(String, String)> {
        let mut valid = false;
        if self.secrets.server_url == self.preferences.server_url {
            if let Some(key) = &self.secrets.api_key {
                let (s, _) = self
                    .send(
                        &self.preferences.server_url,
                        "/v1/models",
                        "GET",
                        None,
                        Some(key),
                    )
                    .await?;
                valid = (200..300).contains(&s);
                if !valid && ![401, 403].contains(&s) {
                    return Err("公司服务暂时无法验证访问凭证，请稍后重试".into());
                }
            }
        }
        if !valid {
            if self.secrets.server_url != self.preferences.server_url {
                return Err("请登录公司账号".into());
            }
            let (s, v) = self
                .send(
                    &self.preferences.server_url,
                    "/api/credentials",
                    "POST",
                    None,
                    self.secrets.session.as_deref(),
                )
                .await?;
            let v = Self::checked(s, v)?;
            let mut secrets = self.secrets.clone();
            secrets.api_key = Some(v["apiKey"].as_str().ok_or("未收到访问凭证")?.into());
            secrets.credential_id =
                Some(v["credentialId"].as_str().ok_or("未收到凭证编号")?.into());
            self.save_secrets(secrets)?;
        }
        Ok((
            self.secrets.api_key.clone().ok_or("请登录公司账号")?,
            self.secrets
                .credential_id
                .clone()
                .ok_or("请重新登录公司账号")?,
        ))
    }
    pub async fn apply(&mut self, agent: Agent, id: &str) -> Result<Value> {
        self.apply_checked(agent, id, false).await
    }
    pub async fn apply_checked(&mut self, agent: Agent, id: &str, running: bool) -> Result<Value> {
        let model = self.available_model(agent, id).await?;
        let (key, credential_id) = self.credential().await?;
        self.config.apply_checked(
            agent,
            &model,
            &self.preferences.server_url,
            &key,
            &credential_id,
            running,
        )
    }
    pub async fn download_url(&self, path: &str) -> Result<String> {
        if !regex::Regex::new(
            r"^(/downloads/Coding-Access-[0-9A-Za-z.-]+-(win|mac)-(x64|arm64)\.zip|/client-artifacts/[0-9a-f-]{36}/[0-9A-Za-z._-]+)$",
        )
        .unwrap()
        .is_match(path)
        {
            return Err("安装包地址无效".into());
        }
        let r = self.request("/api/client-release", "GET", None).await?;
        if !r["downloads"]
            .as_array()
            .is_some_and(|a| a.iter().any(|d| d["url"] == path))
        {
            return Err("安装包已变更，请刷新后重试".into());
        }
        Ok(format!("{}{path}", base_url(&self.preferences.server_url)?))
    }
}
