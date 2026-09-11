//! Automatically carry forward Electron records and original backups in production.
//! Active tool files and encrypted Electron credentials are never changed or imported.
//! The explicit, reversible import remains available for isolated development QA.
use crate::{
    client::{base_url, Preferences},
    config::{self, ConfigManager, Record},
    filesystem::*,
    model::Agent,
    Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

const RECORDS: &str = "config-records.json";
const RECEIPT: &str = "legacy-migration.json";
const JOURNAL: &str = "legacy-migration-pending.json";
const MAX_FILE: u64 = 2 * 1024 * 1024;
#[derive(Clone)]
pub struct Source {
    pub directory: PathBuf,
    pub user_home: PathBuf,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub path: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreview {
    pub agent: Agent,
    pub model_name: String,
    pub status: String,
    pub message: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub source_id: String,
    pub fingerprint: String,
    pub server_url: String,
    pub project_directory: String,
    pub agents: Vec<AgentPreview>,
    pub warnings: Vec<String>,
    pub needs_login: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub imported_at: u64,
    pub source_id: String,
    pub agents: Vec<AgentPreview>,
    pub needs_login: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    area: String,
    relative: PathBuf,
    before: Option<String>,
    after: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transaction {
    #[serde(default)]
    rollback_of: Option<String>,
    receipt: Receipt,
    changes: Vec<Change>,
}
struct ImportedAgent {
    agent: Agent,
    source: String,
    original: Option<String>,
    record: Record,
}
struct Snapshot {
    preview: Preview,
    preferences: Preferences,
    agents: Vec<ImportedAgent>,
}

pub fn discover() -> Vec<Source> {
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    discover_for_home(&home)
}
pub fn discover_for_home(home: &Path) -> Vec<Source> {
    #[cfg(target_os = "macos")]
    let app_data = home.join("Library/Application Support");
    #[cfg(target_os = "windows")]
    let app_data = if dirs::home_dir().as_deref() == Some(home) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        None
    }
    .unwrap_or_else(|| home.join("AppData/Roaming"));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let app_data = home.join(".config");
    ["ai-coding-access", "Coding Access"]
        .into_iter()
        .map(|name| Source {
            directory: app_data.join(name),
            user_home: home.into(),
        })
        .filter(|s| {
            s.directory.join("preferences.json").is_file() || s.directory.join(RECORDS).is_file()
        })
        .collect()
}
impl Source {
    pub fn id(&self) -> String {
        hash(self.directory.to_string_lossy().as_bytes())
    }
    pub fn candidate(&self) -> Candidate {
        Candidate {
            id: self.id(),
            path: self.directory.clone(),
        }
    }
    fn read(&self, path: &Path) -> Result<Option<String>> {
        no_links(path)?;
        match fs::metadata(path) {
            Ok(m) if !m.is_file() || m.len() > MAX_FILE => {
                return Err("旧版配置文件类型或大小不受支持".into())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("无法读取旧版文件，请检查权限".into()),
            _ => {}
        }
        read_optional(path)
    }
    fn config_path(&self, agent: Agent, path: &Path) -> Result<()> {
        let valid_name = match agent {
            Agent::ClaudeCode => path.file_name().is_some_and(|s| s == "settings.json"),
            Agent::Zcode => path.ends_with(".zcode/v2/config.json"),
            _ => path.file_name().is_some_and(|s| s == "config.toml"),
        };
        if !path.is_absolute()
            || (!path.starts_with(&self.user_home)
                && path
                    != Paths {
                        home: self.user_home.clone(),
                        state: self.directory.clone(),
                        isolated: false,
                    }
                    .config_directory(agent)
                    .join(if agent.codex() {
                        "config.toml"
                    } else if agent == Agent::Zcode {
                        "config.json"
                    } else {
                        "settings.json"
                    }))
            || !valid_name
            || path.components().any(|c| matches!(c, Component::ParentDir))
        {
            return Err("旧版记录中的配置路径超出用户目录或格式不受支持".into());
        }
        no_links(path)
    }
    fn snapshot(&self) -> Result<Snapshot> {
        no_links(&self.directory)?;
        let pref_source = self
            .read(&self.directory.join("preferences.json"))?
            .unwrap_or_else(|| "{}".into());
        let prefs: Value =
            serde_json::from_str(&pref_source).map_err(|_| "旧版偏好设置格式无效")?;
        let server = prefs["serverUrl"].as_str().unwrap_or("");
        let project = prefs["projectDirectory"].as_str().unwrap_or("");
        let preferences = Preferences {
            server_url: if server.is_empty() {
                Preferences::default().server_url
            } else {
                base_url(server)?
            },
            project_directory: project.into(),
            ..Preferences::default()
        };
        if project.len() > 4096 || project.chars().any(char::is_control) {
            return Err("旧版项目目录无效".into());
        }
        let records_source = self
            .read(&self.directory.join(RECORDS))?
            .unwrap_or_else(|| "{}".into());
        let records: BTreeMap<String, Record> = serde_json::from_str(&records_source)
            .map_err(|_| "旧版接管记录格式无效，请先检查备份")?;
        if records
            .keys()
            .any(|k| !["claude-code", "codex", "zcode"].contains(&k.as_str()))
        {
            return Err("旧版接管记录包含不支持的工具".into());
        }
        let mut fingerprint = vec![
            hash(pref_source.as_bytes()),
            hash(records_source.as_bytes()),
        ];
        let mut agents = vec![];
        let mut previews = vec![];
        for (key, record) in records {
            let agent = match key.as_str() {
                "claude-code" => Agent::ClaudeCode,
                "zcode" => Agent::Zcode,
                _ => Agent::CodexCli,
            };
            let mut item = AgentPreview {
                agent,
                model_name: record.model_name.clone(),
                status: "ready".into(),
                message: "导入模型设置和最初备份，重新登录后同步".into(),
            };
            let result: Result<ImportedAgent> = (|| {
                self.config_path(agent, &record.path)?;
                let source = self
                    .read(&record.path)?
                    .ok_or("当前配置已不存在，不自动接管")?;
                fingerprint.push(hash(source.as_bytes()));
                let mut original = None;
                if record.original_exists {
                    let backup = record.backup.as_ref().ok_or("缺少最初备份，不自动接管")?;
                    if !backup.starts_with(self.directory.join("backups"))
                        || backup
                            .components()
                            .any(|c| matches!(c, Component::ParentDir))
                    {
                        return Err("旧版备份路径不在备份目录内".into());
                    }
                    original = Some(
                        self.read(backup)?
                            .ok_or("最初备份文件已不存在，不自动接管")?,
                    );
                    fingerprint.push(hash(original.as_ref().unwrap().as_bytes()));
                }
                let same = record.hash == hash(source.as_bytes());
                let benign = agent == Agent::Zcode
                    && record.zcode_provider_hash.is_some()
                    && config::zcode_hash(&source).ok() == record.zcode_provider_hash;
                if !same && !benign {
                    return Err("配置在上次启用后被外部修改，此工具会跳过导入".into());
                }
                // Validate structure before writing any destination file.
                if agent.codex() {
                    source
                        .parse::<toml_edit::DocumentMut>()
                        .map_err(|_| "Codex 配置格式无效")?;
                } else {
                    config::json_object(&source)?;
                }
                strip_legacy_token(agent, &source)?;
                let mut record = record;
                record.preserve_zcode_external_changes |= agent == Agent::Zcode && !same;
                Ok(ImportedAgent {
                    agent,
                    source,
                    original,
                    record,
                })
            })();
            match result {
                Ok(data) => agents.push(data),
                Err(e) => {
                    item.status = "skipped".into();
                    item.message = e.clone();
                    fingerprint.push(e);
                }
            }
            previews.push(item);
        }
        let mut warnings = vec!["旧版登录凭证不会导入；导入后需重新登录并同步默认模型。".into()];
        if !project.is_empty() && !Path::new(project).is_dir() {
            warnings.push("原项目目录当前不存在，已保留路径，可在登录后重新选择。".into());
        }
        let preview = Preview {
            source_id: self.id(),
            fingerprint: hash(fingerprint.join("\n").as_bytes()),
            server_url: preferences.server_url.clone(),
            project_directory: preferences.project_directory.clone(),
            agents: previews,
            warnings,
            needs_login: true,
        };
        Ok(Snapshot {
            preview,
            preferences,
            agents,
        })
    }
    pub fn preview(&self) -> Result<Preview> {
        Ok(self.snapshot()?.preview)
    }
}
fn target(paths: &Paths, c: &Change) -> Result<PathBuf> {
    if c.relative.is_absolute()
        || c.relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("迁移事务路径无效".into());
    }
    if !paths.isolated && c.area == "home" {
        return Err("正式迁移事务不能改写工具配置".into());
    }
    let root = match c.area.as_str() {
        "state" => &paths.state,
        "home" => &paths.home,
        _ => return Err("迁移事务目录无效".into()),
    };
    let allowed = if c.area == "home" {
        [
            ".claude/settings.json",
            ".codex/config.toml",
            ".zcode/v2/config.json",
        ]
        .iter()
        .any(|s| c.relative == Path::new(s))
    } else {
        ["preferences.json", RECORDS]
            .iter()
            .any(|s| c.relative == Path::new(s))
            || (c.relative.parent() == Some(Path::new("backups"))
                && c.relative
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.starts_with("legacy-") && s.ends_with(".backup")))
    };
    if !allowed {
        return Err("迁移事务目标不受支持".into());
    }
    let p = root.join(&c.relative);
    no_links(&p)?;
    Ok(p)
}
fn write_value(path: &Path, value: &Option<String>) -> Result<()> {
    if let Some(s) = value {
        atomic_write(path, s.as_bytes())
    } else {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法清理迁移文件".into()),
        }
    }
}
fn transaction(path: &Path) -> Result<Option<Transaction>> {
    read_optional(path)?
        .map(|s| serde_json::from_str(&s).map_err(|_| "迁移记录格式无效，请检查本地数据".into()))
        .transpose()
}
pub fn receipt(paths: &Paths) -> Result<Option<Receipt>> {
    Ok(transaction(&paths.state.join(RECEIPT))?.map(|t| t.receipt))
}
pub fn recover(paths: &Paths) -> Result<()> {
    let pending = paths.state.join(JOURNAL);
    let Some(t) = transaction(&pending)? else {
        return Ok(());
    };
    let committed = receipt(paths)?;
    if t.rollback_of.is_none() && committed.as_ref().is_some_and(|r| r.id == t.receipt.id) {
        fs::remove_file(pending).map_err(|_| "无法完成迁移事务清理")?;
        return Ok(());
    }
    for c in &t.changes {
        let now = read_optional(&target(paths, c)?)?;
        if now != c.before && now != c.after {
            return Err("迁移中断后文件又被修改，自动恢复已暂停".into());
        }
    }
    if let Some(id) = &t.rollback_of {
        if committed.as_ref().is_some_and(|r| &r.id != id) {
            return Err("撤销事务与迁移记录不匹配，自动恢复已暂停".into());
        }
        if committed.is_some() {
            fs::remove_file(paths.state.join(RECEIPT)).map_err(|_| "无法撤销迁移记录")?;
        }
    }
    for c in t.changes.iter().rev() {
        write_value(&target(paths, c)?, &c.before)?;
    }
    fs::remove_file(pending).map_err(|_| "无法清理中断的迁移")?;
    Ok(())
}
fn strip_legacy_token(agent: Agent, source: &str) -> Result<String> {
    // Preserve all personal settings and capabilities. Replace only the old
    // company's managed credential so copied defaults cannot reuse its token.
    if agent.codex() {
        let mut doc = source
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "Codex 配置格式无效")?;
        let provider = doc
            .get_mut("model_providers")
            .and_then(|p| p.get_mut("coding_access"))
            .ok_or("旧配置缺少 Coding Access 接入")?;
        provider["experimental_bearer_token"] = toml_edit::value("migration-login-required");
        Ok(doc.to_string())
    } else {
        let root =
            jsonc_parser::cst::CstRootNode::parse(source, &jsonc_parser::ParseOptions::default())
                .map_err(|_| "旧配置格式无效")?;
        let object = root.object_value().ok_or("旧配置必须是对象")?;
        let object = if agent == Agent::ClaudeCode {
            object.object_value("env").ok_or("旧配置缺少 Claude 接入")?
        } else {
            object
                .object_value("provider")
                .and_then(|o| o.object_value("coding_access"))
                .and_then(|o| o.object_value("options"))
                .ok_or("旧配置缺少 ZCode 接入")?
        };
        let key = if agent == Agent::ClaudeCode {
            "ANTHROPIC_AUTH_TOKEN"
        } else {
            "apiKey"
        };
        let value = jsonc_parser::cst::CstInputValue::String("migration-login-required".into());
        if let Some(p) = object.get(key) {
            p.set_value(value);
        } else {
            object.append(key, value);
        }
        Ok(root.to_string())
    }
}
pub fn import(paths: &Paths, source: &Source, fingerprint: &str) -> Result<Receipt> {
    import_snapshot(paths, source, fingerprint, false)
}

fn import_snapshot(
    paths: &Paths,
    source: &Source,
    fingerprint: &str,
    automatic: bool,
) -> Result<Receipt> {
    recover(paths)?;
    let previous = receipt(paths)?;
    if previous.is_some() && !automatic {
        return Err("已导入旧版数据，重复导入不会覆盖现有配置".into());
    }
    if paths.state.starts_with(&source.directory)
        || source.directory.starts_with(&paths.state)
        || (paths.isolated && paths.home == source.user_home)
        || (!paths.isolated && paths.home != source.user_home)
    {
        return Err("迁移源与目标目录不能重叠".into());
    }
    let config = ConfigManager {
        paths: paths.clone(),
    };
    let existing = config.records()?;
    if (!automatic && !existing.is_empty())
        || (paths.isolated
            && [Agent::ClaudeCode, Agent::CodexCli, Agent::Zcode]
                .iter()
                .any(|a| config.path(*a).exists()))
    {
        return Err("当前客户端已有模型配置，不能用旧版数据覆盖。开发验收请使用空目录。".into());
    }
    let mut snapshot = source.snapshot()?;
    if snapshot.preview.fingerprint != fingerprint {
        return Err("旧版数据已变化，请重新预览后导入".into());
    }
    // Beta users may already have logged in or configured another tool. Keep
    // their native records and settings, and only adopt missing legacy tools.
    if automatic {
        for item in &mut snapshot.preview.agents {
            if existing.contains_key(item.agent.key()) {
                item.status = "ready".into();
                item.message = "已保留新版配置和备份".into();
            } else if let Some(done) = previous.as_ref().and_then(|r| {
                r.agents
                    .iter()
                    .find(|a| a.agent.key() == item.agent.key() && a.status == "ready")
            }) {
                // A successful handoff stays complete even after Restore has
                // removed the native record. Never re-adopt stale Electron data.
                *item = done.clone();
            } else if let Some(data) = snapshot
                .agents
                .iter()
                .find(|a| a.agent.key() == item.agent.key())
            {
                if data.record.path != config.path(item.agent) {
                    item.status = "skipped".into();
                    item.message =
                        "工具配置目录已改变，请管理员核对自定义配置目录后重新检查".into();
                }
            }
        }
        snapshot.agents.retain(|a| {
            !existing.contains_key(a.agent.key())
                && !previous.as_ref().is_some_and(|r| {
                    r.agents
                        .iter()
                        .any(|done| done.agent.key() == a.agent.key() && done.status == "ready")
                })
                && snapshot
                    .preview
                    .agents
                    .iter()
                    .any(|item| item.agent.key() == a.agent.key() && item.status == "ready")
        });
        // Keep unresolved entries even if their source record was removed.
        // Deleting a broken legacy record must not bypass backup protection.
        if let Some(prior) = &previous {
            for item in &prior.agents {
                if !snapshot
                    .preview
                    .agents
                    .iter()
                    .any(|a| a.agent.key() == item.agent.key())
                {
                    snapshot.preview.agents.push(item.clone());
                }
            }
        }
        if let Some(prior) = &previous {
            if snapshot.agents.is_empty()
                && serde_json::to_value(&prior.agents).ok()
                    == serde_json::to_value(&snapshot.preview.agents).ok()
            {
                return Ok(prior.clone());
            }
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut changes = vec![];
    let mut records = existing;
    let mut add = |area: &str, relative: PathBuf, after: String| -> Result<()> {
        let mut c = Change {
            area: area.into(),
            relative,
            before: None,
            after: Some(after),
        };
        c.before = read_optional(&target(paths, &c)?)?;
        changes.push(c);
        Ok(())
    };
    for data in snapshot.agents {
        let a = data.agent;
        let mut r = data.record;
        if !paths.isolated && r.path != config.path(a) {
            return Err("旧版工具路径与当前环境不同，请确认自定义配置目录后重试".into());
        }
        let next = if paths.isolated {
            strip_legacy_token(a, &data.source)?
        } else {
            data.source
        };
        r.path = config.path(a);
        r.hash = hash(next.as_bytes());
        r.semantic_hash = Some(config::semantic_hash(a, &next)?);
        r.credential_id = "migration-login-required".into();
        r.zcode_provider_hash = if a == Agent::Zcode {
            Some(config::zcode_hash(&next)?)
        } else {
            None
        };
        r.backup = if let Some(original) = data.original {
            let p = PathBuf::from("backups").join(format!("legacy-{id}-{}.backup", a.key()));
            add("state", p.clone(), original)?;
            Some(paths.state.join(p))
        } else {
            None
        };
        if paths.isolated {
            add(
                "home",
                r.path
                    .strip_prefix(&paths.home)
                    .map_err(|_| "迁移配置路径无效")?
                    .into(),
                next,
            )?;
        }
        records.insert(a.key().into(), r);
    }
    add(
        "state",
        RECORDS.into(),
        serde_json::to_string_pretty(&records).map_err(|_| "配置记录无效")?,
    )?;
    if !automatic || !paths.state.join("preferences.json").exists() {
        add(
            "state",
            "preferences.json".into(),
            serde_json::to_string_pretty(&snapshot.preferences).map_err(|_| "偏好设置无效")?,
        )?;
    }
    // Re-read the source immediately before publishing, so a stale preview or
    // a concurrent Electron write cannot silently become the imported state.
    if source.preview()?.fingerprint != fingerprint {
        return Err("旧版数据在迁移前发生变化，请重新预览".into());
    }
    for c in &changes {
        if read_optional(&target(paths, c)?)? != c.before {
            return Err("本地记录在升级前发生变化，请重试".into());
        }
    }
    let t = Transaction {
        rollback_of: None,
        receipt: Receipt {
            id,
            imported_at: now(),
            source_id: source.id(),
            agents: snapshot.preview.agents,
            needs_login: true,
        },
        changes,
    };
    save_json(&paths.state.join(JOURNAL), &t)?;
    let result = (|| {
        for c in &t.changes {
            write_value(&target(paths, c)?, &c.after)?;
        }
        save_json(&paths.state.join(RECEIPT), &t)?;
        Ok(t.receipt.clone())
    })();
    if result.is_err() {
        recover(paths)?;
    } else {
        fs::remove_file(paths.state.join(JOURNAL))
            .map_err(|_| "本地升级完成但事务清理失败，请重启客户端")?;
    }
    result
}

pub fn automatic(paths: &Paths) -> Result<()> {
    automatic_from(paths, &discover_for_home(&paths.home))
}

pub fn automatic_from(paths: &Paths, sources: &[Source]) -> Result<()> {
    // Development builds must never adopt the actual user's data implicitly.
    if paths.isolated {
        return Ok(());
    }
    recover(paths)?;
    let previous = receipt(paths)?;
    if previous
        .as_ref()
        .is_some_and(|r| r.agents.iter().all(|a| a.status == "ready"))
    {
        return Ok(());
    }
    let source = if let Some(prior) = &previous {
        sources
            .iter()
            .find(|s| s.id() == prior.source_id)
            .ok_or("旧版配置存在冲突或备份问题，但旧数据目录已找不到，请管理员核对后重新检查")?
    } else {
        match sources {
            [] => return Ok(()),
            [source] => source,
            _ => return Err("发现多份旧版数据，无法确定要接续哪一份。请管理员保留正在使用的旧版数据目录后重新检查".into()),
        }
    };
    let preview = source.preview()?;
    import_snapshot(paths, source, &preview.fingerprint, true)?;
    Ok(())
}

pub fn issues(paths: &Paths) -> Result<Vec<AgentPreview>> {
    let records: BTreeMap<String, Record> = read_json(&paths.state.join(RECORDS))?;
    Ok(receipt(paths)?
        .map(|r| {
            r.agents
                .into_iter()
                .filter(|a| a.status == "skipped" && !records.contains_key(a.agent.key()))
                .collect()
        })
        .unwrap_or_default())
}
pub fn undo(paths: &Paths) -> Result<()> {
    recover(paths)?;
    let t = transaction(&paths.state.join(RECEIPT))?.ok_or("没有可撤销的导入")?;
    for c in &t.changes {
        if read_optional(&target(paths, c)?)? != c.after {
            return Err("导入后已有配置变更，为保留这些改动，撤销导入已暂停".into());
        }
    }
    // Reuse crash recovery for undo. Remove the committed receipt only after
    // writing its rollback journal, so any interrupted undo can finish safely.
    let undo = Transaction {
        rollback_of: Some(t.receipt.id.clone()),
        receipt: Receipt {
            id: uuid::Uuid::new_v4().to_string(),
            ..t.receipt
        },
        changes: t.changes,
    };
    save_json(&paths.state.join(JOURNAL), &undo)?;
    recover(paths)
}
pub fn status(paths: &Paths, sources: &[Source]) -> Result<Value> {
    Ok(
        json!({"sources":sources.iter().map(Source::candidate).collect::<Vec<_>>(),"imported":receipt(paths)?,"development":paths.isolated}),
    )
}

/// Do not mistake an old managed configuration for its original backup when
/// the user skips migration or a conflicting source was deliberately skipped.
pub fn check_first_apply(paths: &Paths, _agent: Agent) -> Result<()> {
    // Automatic adoption is best effort for individual tools. Explicit Apply may
    // establish a new baseline from the current file when an old record was skipped.
    // Transaction corruption and I/O failures still require recovery.
    automatic(paths).map_err(|e| format!("旧版配置未能自动接续：{e}。当前工具配置未修改"))?;
    Ok(())
}
