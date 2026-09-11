use crate::{model::Agent, Result};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn no_links(path: &Path) -> Result<()> {
    for p in path.ancestors() {
        match fs::symlink_metadata(p) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err("配置路径包含符号链接，已暂停写入".into())
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法检查配置路径权限".into()),
        }
    }
    Ok(())
}
pub fn private_dir(path: &Path) -> Result<()> {
    no_links(path)?;
    if !path.exists() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(path).map_err(|_| "无法创建本地配置目录")?;
    }
    Ok(())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    no_links(path)?;
    let parent = path.parent().ok_or("配置路径无效")?;
    private_dir(parent)?;
    let mut f = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建临时配置文件")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置配置权限")?;
    }
    f.write_all(bytes)
        .and_then(|_| f.as_file().sync_all())
        .map_err(|_| "无法保存本地配置")?;
    f.persist(path).map_err(|_| "无法替换本地配置文件")?;
    Ok(())
}
pub fn read_optional(path: &Path) -> Result<Option<String>> {
    no_links(path)?;
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法读取本地配置文件".into()),
    }
}
pub fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match read_optional(path)? {
        Some(s) => {
            serde_json::from_str(&s).map_err(|_| "本地配置记录格式无效，请从备份恢复".into())
        }
        None => Ok(T::default()),
    }
}
pub fn save_json(path: &Path, data: &impl serde::Serialize) -> Result<()> {
    atomic_write(
        path,
        &serde_json::to_vec_pretty(data).map_err(|_| "本地数据序列化失败")?,
    )
}

#[derive(Clone)]
pub struct Paths {
    pub state: PathBuf,
    pub home: PathBuf,
    pub isolated: bool,
}
impl Paths {
    // Distribution is an explicit compile-time feature; normal dev and even
    // release-profile test builds remain isolated. An explicit QA root also
    // keeps the distributable executable isolated for package acceptance.
    pub fn runtime() -> Result<Self> {
        if !cfg!(feature = "distribution") || std::env::var_os("ACA_TAURI_DEV_ROOT").is_some() {
            return Self::development();
        }
        let home = dirs::home_dir().ok_or("无法定位用户目录")?;
        let state = dirs::data_dir()
            .ok_or("无法定位应用数据目录")?
            .join("coding-access-native");
        Self::production_at(home, state)
    }
    pub fn production_at(home: PathBuf, state: PathBuf) -> Result<Self> {
        if !home.is_absolute() || !state.is_absolute() || !home.is_dir() {
            return Err("本地配置目录无效".into());
        }
        no_links(&home)?;
        private_dir(&state)?;
        Ok(Self {
            home,
            state,
            isolated: false,
        })
    }
    pub fn config_directory(&self, agent: Agent) -> PathBuf {
        let variable = match agent {
            Agent::ClaudeCode => "CLAUDE_CONFIG_DIR",
            Agent::Zcode => "ZCODE_DATA_BASE_DIR",
            _ => "CODEX_HOME",
        };
        let custom = if self.isolated {
            None
        } else {
            std::env::var_os(variable)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
        };
        config_directory(&self.home, agent, custom.as_deref())
    }
    pub fn development() -> Result<Self> {
        let root = std::env::var_os("ACA_TAURI_DEV_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.local/tauri-dev"));
        Self::development_at(root)
    }
    pub fn development_at(root: PathBuf) -> Result<Self> {
        private_dir(&root)?;
        let root = fs::canonicalize(root).map_err(|_| "开发目录不可访问")?;
        let p = Self {
            state: root.join("state"),
            home: root.join("home"),
            isolated: true,
        };
        private_dir(&p.state)?;
        private_dir(&p.home)?;
        Ok(p)
    }
}

/// Match the existing Electron convention, including relative override paths.
pub fn config_directory(home: &Path, agent: Agent, custom: Option<&Path>) -> PathBuf {
    let base = custom.map(|p| {
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            home.join(p)
        }
    });
    match agent {
        Agent::ClaudeCode => base.unwrap_or_else(|| home.join(".claude")),
        Agent::Zcode => base.unwrap_or_else(|| home.into()).join(".zcode/v2"),
        _ => base.unwrap_or_else(|| home.join(".codex")),
    }
}

/// Preserve an app bundle before replacement, including executable modes and symlinks.
#[cfg(target_os = "macos")]
pub fn copy_bundle(source: &std::path::Path, target: &std::path::Path) -> crate::Result<()> {
    let metadata = std::fs::symlink_metadata(source).map_err(|_| "无法读取旧版本应用")?;
    if metadata.file_type().is_symlink() {
        std::os::unix::fs::symlink(
            std::fs::read_link(source).map_err(|_| "无法读取应用链接")?,
            target,
        )
        .map_err(|_| "无法备份应用链接")?;
    } else if metadata.is_dir() {
        std::fs::create_dir_all(target).map_err(|_| "无法创建应用备份")?;
        for entry in std::fs::read_dir(source).map_err(|_| "无法读取应用目录")? {
            let entry = entry.map_err(|_| "无法读取应用文件")?;
            copy_bundle(&entry.path(), &target.join(entry.file_name()))?;
        }
        std::fs::set_permissions(target, metadata.permissions()).map_err(|_| "无法保留应用权限")?;
    } else if metadata.is_file() {
        std::fs::copy(source, target).map_err(|_| "无法备份应用文件")?;
    } else {
        return Err("应用包含不支持的文件类型".into());
    }
    Ok(())
}
