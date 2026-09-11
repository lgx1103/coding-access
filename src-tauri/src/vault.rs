use crate::Result;
use std::sync::Mutex;
/// No plaintext fallback: a locked/unavailable OS vault must remain an error.
pub trait Vault: Send + Sync {
    fn load(&self) -> Result<Option<String>>;
    fn save(&self, value: &str) -> Result<()>;
}
pub struct SystemVault {
    account: String,
    service: &'static str,
}
impl SystemVault {
    pub fn new(state: &std::path::Path) -> Self {
        Self {
            account: crate::filesystem::hash(state.to_string_lossy().as_bytes()),
            service: "com.codingaccess.tauri.dev",
        }
    }
    pub fn production(state: &std::path::Path) -> Self {
        Self {
            account: crate::filesystem::hash(state.to_string_lossy().as_bytes()),
            service: "com.codingaccess.native",
        }
    }
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SystemVault {
    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(self.service, &self.account)
            .map_err(|_| "无法访问系统凭证存储，请解锁后重试".into())
    }
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
impl Vault for SystemVault {
    fn load(&self) -> Result<Option<String>> {
        match self.entry()?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("无法读取系统凭证存储，请解锁后重试".into()),
        }
    }
    fn save(&self, value: &str) -> Result<()> {
        self.entry()?
            .set_password(value)
            .map_err(|_| "无法保存登录凭证，请解锁系统凭证存储后重试".into())
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl Vault for SystemVault {
    fn load(&self) -> Result<Option<String>> {
        Err("开发版凭证存储当前支持 macOS 和 Windows".into())
    }
    fn save(&self, _: &str) -> Result<()> {
        Err("开发版凭证存储当前支持 macOS 和 Windows".into())
    }
}
/// Explicitly injected by core tests; never selected by runtime environment flags.
#[derive(Default)]
pub struct MemoryVault(pub Mutex<Option<String>>);
impl Vault for MemoryVault {
    fn load(&self) -> Result<Option<String>> {
        Ok(self.0.lock().map_err(|_| "测试凭证锁异常")?.clone())
    }
    fn save(&self, v: &str) -> Result<()> {
        *self.0.lock().map_err(|_| "测试凭证锁异常")? = Some(v.into());
        Ok(())
    }
}
