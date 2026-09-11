//! Agent configuration edits. Never receives paths from the webview.
use crate::{
    filesystem::*,
    model::{Agent, Model, AGENTS},
    Result,
};
use jsonc_parser::{
    cst::{CstInputValue, CstObject, CstRootNode},
    ParseOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::PathBuf};

pub fn json_object(source: &str) -> Result<Value> {
    let source = if source.is_empty() { "{}" } else { source };
    let v: Value = jsonc_parser::parse_to_serde_value(source, &ParseOptions::default())
        .map_err(|_| "现有 JSON 配置格式无效，请先修复")?;
    if !v.is_object() {
        return Err("配置必须是 JSON 对象".into());
    }
    Ok(v)
}
fn input(v: &Value) -> CstInputValue {
    match v {
        Value::Null => CstInputValue::Null,
        Value::Bool(v) => CstInputValue::Bool(*v),
        Value::Number(v) => CstInputValue::Number(v.to_string()),
        Value::String(v) => CstInputValue::String(v.clone()),
        Value::Array(v) => CstInputValue::Array(v.iter().map(input).collect()),
        Value::Object(v) => {
            CstInputValue::Object(v.iter().map(|(k, v)| (k.clone(), input(v))).collect())
        }
    }
}
fn set(obj: &CstObject, key: &str, v: Option<&Value>) {
    match (obj.get(key), v) {
        (Some(p), Some(v)) => p.set_value(input(v)),
        (Some(p), None) => p.remove(),
        (None, Some(v)) => {
            obj.append(key, input(v));
        }
        _ => {}
    }
}
fn root(source: &str) -> Result<CstRootNode> {
    json_object(source)?;
    CstRootNode::parse(
        if source.is_empty() { "{}\n" } else { source },
        &ParseOptions::default(),
    )
    .map_err(|_| "现有 JSON 配置格式无效".into())
}
fn finish(root: CstRootNode) -> String {
    format!("{}\n", root.to_string().trim_end())
}
fn object_field(value: &Value, key: &str) -> Result<()> {
    if value
        .get(key)
        .is_some_and(|v| !v.is_null() && !v.is_object())
    {
        return Err(format!("配置的 {key} 必须是对象"));
    }
    Ok(())
}

pub fn claude_configuration(
    source: &str,
    base: &str,
    credential: &str,
    model: &Model,
    managed: &[String],
) -> Result<String> {
    model.validate()?;
    let parsed = json_object(source)?;
    object_field(&parsed, "env")?;
    let root = root(source)?;
    let obj = root.object_value_or_set();
    let env = obj.object_value_or_set("env");
    let mut fields = BTreeMap::from([
        (
            "ANTHROPIC_BASE_URL".into(),
            base.trim_end_matches('/').into(),
        ),
        ("ANTHROPIC_AUTH_TOKEN".into(), credential.into()),
        ("ANTHROPIC_API_KEY".into(), String::new()),
        ("ANTHROPIC_MODEL".into(), model.id.clone()),
        ("CLAUDE_CODE_SUBAGENT_MODEL".into(), model.id.clone()),
        ("CLAUDE_CODE_MAX_RETRIES".into(), "0".into()),
    ]);
    for family in ["HAIKU", "SONNET", "OPUS", "FABLE"] {
        let key = format!("ANTHROPIC_DEFAULT_{family}_MODEL");
        fields.insert(key.clone(), model.id.clone());
        fields.insert(format!("{key}_NAME"), model.name.clone());
        fields.insert(
            format!("{key}_DESCRIPTION"),
            if model.description.is_empty() {
                format!("通过 Coding Access 使用 {}", model.name)
            } else {
                model.description.clone()
            },
        );
    }
    if parsed["env"].get("ANTHROPIC_SMALL_FAST_MODEL").is_some() {
        fields.insert("ANTHROPIC_SMALL_FAST_MODEL".into(), model.id.clone());
    }
    for (k, v) in fields {
        set(&env, &k, Some(&json!(v)));
    }
    for (field, cap, n) in [
        (
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
            "contextWindow",
            model.context_window,
        ),
        (
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "maxOutputTokens",
            model.max_output_tokens,
        ),
    ] {
        if let Some(n) = n {
            set(&env, field, Some(&json!(n.to_string())));
        } else if managed.iter().any(|c| c == cap) {
            set(&env, field, None);
        }
    }
    set(&obj, "model", Some(&json!(model.id)));
    Ok(finish(root))
}
pub fn codex_configuration(
    source: &str,
    base: &str,
    credential: &str,
    model: &Model,
    managed: &[String],
) -> Result<String> {
    use toml_edit::{value, DocumentMut, Item, Table};
    model.validate()?;
    let mut doc = source
        .parse::<DocumentMut>()
        .map_err(|_| "现有 Codex 配置格式无效，请先修复 TOML 配置")?;
    doc["model"] = value(&model.id);
    doc["model_provider"] = value("coding_access");
    doc["web_search"] = value("disabled");
    if let Some(n) = model.context_window {
        doc["model_context_window"] = value(n as i64);
        doc["model_auto_compact_token_limit"] = value((n * 4 / 5).max(1024) as i64);
    } else if managed.iter().any(|c| c == "contextWindow") {
        doc.remove("model_context_window");
        doc.remove("model_auto_compact_token_limit");
    }
    for k in ["features", "model_providers"] {
        if !doc.contains_key(k) {
            doc[k] = Item::Table(Table::new());
        }
        if !doc[k].is_table_like() {
            return Err(format!("Codex 的 {k} 必须是表"));
        }
    }
    doc["features"]["enable_request_compression"] = value(false);
    doc["features"]["respect_system_proxy"] = value(true);
    let mut provider = Table::new();
    provider["name"] = value("Coding Access");
    provider["base_url"] = value(format!("{}/v1", base.trim_end_matches('/')));
    provider["wire_api"] = value("responses");
    provider["experimental_bearer_token"] = value(credential);
    for k in ["requires_openai_auth", "supports_websockets"] {
        provider[k] = value(false);
    }
    for k in ["request_max_retries", "stream_max_retries"] {
        provider[k] = value(0);
    }
    doc["model_providers"]["coding_access"] = Item::Table(provider);
    Ok(doc.to_string())
}
pub fn zcode_configuration(
    source: &str,
    base: &str,
    credential: &str,
    model: &Model,
) -> Result<String> {
    model.validate()?;
    let parsed = json_object(source)?;
    object_field(&parsed, "provider")?;
    let mut provider = parsed["provider"]
        .get("coding_access")
        .cloned()
        .unwrap_or(json!({}));
    if !provider.is_object() {
        return Err("ZCode 接入配置必须是对象".into());
    }
    for k in ["options", "headers", "models"] {
        object_field(&provider, k)?;
        if !provider[k].is_object() {
            provider[k] = json!({});
        }
    }
    let mut entry = provider["models"]
        .get(&model.id)
        .cloned()
        .unwrap_or(json!({}));
    if !entry.is_object() {
        return Err("ZCode 模型配置必须是对象".into());
    }
    entry["name"] = json!(model.name);
    entry.as_object_mut().unwrap().remove("limit");
    entry.as_object_mut().unwrap().remove("modalities");
    object_field(&entry, "zcode")?;
    if !entry["zcode"].is_object() {
        entry["zcode"] = json!({});
    }
    entry["zcode"]
        .as_object_mut()
        .unwrap()
        .remove("modalitiesConfigured");
    if model.context_window.is_some() || model.max_output_tokens.is_some() {
        entry["limit"] = json!({});
        if let Some(n) = model.context_window {
            entry["limit"]["context"] = json!(n);
        }
        if let Some(n) = model.max_output_tokens {
            entry["limit"]["output"] = json!(n);
        }
    }
    if let Some(vision) = model.vision {
        entry["modalities"] =
            json!({"input":if vision{vec!["text","image"]}else{vec!["text"]},"output":["text"]});
        entry["zcode"]["modalitiesConfigured"] = json!(true);
    }
    provider["name"] = json!("Coding Access");
    provider["kind"] = json!("anthropic");
    provider["enabled"] = json!(true);
    provider["options"]["apiKey"] = json!(credential);
    provider["options"]["baseURL"] = json!(base.trim_end_matches('/'));
    provider["options"]["apiKeyRequired"] = json!(true);
    provider["headers"]["x-coding-agent"] = json!("zcode");
    provider["models"] = json!({model.id.clone():entry});
    let root = root(source)?;
    set(
        &root.object_value_or_set().object_value_or_set("provider"),
        "coding_access",
        Some(&provider),
    );
    Ok(finish(root))
}
pub(crate) fn zcode_hash(source: &str) -> Result<String> {
    let mut p = json_object(source)?["provider"]["coding_access"].clone();
    if p["source"] == "custom" {
        p.as_object_mut().unwrap().remove("source");
    }
    if let Some(models) = p["models"].as_object_mut() {
        for m in models.values_mut() {
            if let Some(m) = m.as_object_mut() {
                m.remove("reasoning");
            }
        }
    }
    // serde_json's default map is sorted, matching the Electron canonical hash.
    Ok(hash(serde_json::to_string(&p).unwrap().as_bytes()))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub applied_model: Option<Model>,
    pub model_id: String,
    pub model_name: String,
    pub applied_at: u64,
    pub path: PathBuf,
    pub credential_id: String,
    pub hash: String,
    pub semantic_hash: Option<String>,
    pub backup: Option<PathBuf>,
    pub original_exists: bool,
    pub managed_capabilities: Option<Vec<String>>,
    pub claude_config_revision: Option<u8>,
    pub zcode_provider_hash: Option<String>,
    #[serde(default)]
    pub preserve_zcode_external_changes: bool,
}
type Records = BTreeMap<String, Record>;

pub(crate) fn semantic_hash(agent: Agent, source: &str) -> Result<String> {
    let value: Value = if agent.codex() {
        toml_edit::de::from_str(source).map_err(|_| "现有 TOML 配置格式无效")?
    } else {
        json_object(source)?
    };
    Ok(hash(
        serde_json::to_vec(&value)
            .map_err(|_| "无法校验配置内容")?
            .as_slice(),
    ))
}
#[derive(Deserialize, Serialize)]
struct Journal {
    agent: Agent,
    before: Option<String>,
    after: Option<String>,
    records: Records,
}
pub struct ConfigManager {
    pub paths: Paths,
}
impl ConfigManager {
    fn render(
        &self,
        agent: Agent,
        source: &str,
        model: &Model,
        base: &str,
        credential: &str,
    ) -> Result<String> {
        let records = self.records()?;
        let managed = records
            .get(agent.key())
            .map(|r| {
                r.managed_capabilities.clone().unwrap_or_else(|| {
                    if agent == Agent::ClaudeCode {
                        vec!["maxOutputTokens".into()]
                    } else {
                        vec!["contextWindow".into(), "maxOutputTokens".into()]
                    }
                })
            })
            .unwrap_or_default();
        match agent {
            Agent::ClaudeCode => claude_configuration(source, base, credential, model, &managed),
            Agent::Zcode => zcode_configuration(source, base, credential, model),
            _ => codex_configuration(source, base, credential, model, &managed),
        }
    }
    pub fn configuration_matches(
        &self,
        agent: Agent,
        model: &Model,
        base: &str,
        credential: &str,
    ) -> Result<bool> {
        let Some(source) = self.source(agent)? else {
            return Ok(false);
        };
        let next = self.render(agent, &source, model, base, credential)?;
        // Compare the result of merging the desired configuration into the current file.
        // Formatting, plugins, UI preferences and ZCode-added metadata are not changes
        // to the connection we manage. No credentials leave the native process.
        Ok(semantic_hash(agent, &source)? == semantic_hash(agent, &next)?)
    }
    pub fn configured_with_targets(
        &self,
        base: &str,
        credential: Option<&str>,
        credential_id: Option<&str>,
        models: &[Model],
    ) -> Result<Value> {
        let mut configured = self.configured(credential_id)?;
        let records = self.records()?;
        if let Some(credential) = credential {
            for agent in AGENTS {
                if let Some(record) = records.get(agent.key()) {
                    if let Some(model) = models
                        .iter()
                        .find(|m| m.id == record.model_id)
                        .or(record.applied_model.as_ref())
                    {
                        configured[agent.id()]["needsUpdate"] = json!(!self
                            .configuration_matches(agent, model, base, credential)
                            .unwrap_or(false));
                    }
                }
            }
        }
        Ok(configured)
    }
    pub fn path(&self, agent: Agent) -> PathBuf {
        self.paths.config_directory(agent).join(if agent.codex() {
            "config.toml"
        } else if agent == Agent::Zcode {
            "config.json"
        } else {
            "settings.json"
        })
    }

    fn record_path(&self) -> PathBuf {
        self.paths.state.join("config-records.json")
    }
    fn source(&self, agent: Agent) -> Result<Option<String>> {
        read_optional(&self.path(agent))
    }
    fn recover(&self) -> Result<()> {
        let journal = self.paths.state.join("config-transaction.json");
        if let Some(s) = read_optional(&journal)? {
            let j: Journal =
                serde_json::from_str(&s).map_err(|_| "配置事务记录无效，请检查本地备份")?;
            let source = self.source(j.agent)?;
            if source == j.after {
                save_json(&self.record_path(), &j.records)?;
            } else if source != j.before {
                return Err("配置写入中断后又被外部修改，请检查本地备份".into());
            }
            fs::remove_file(journal).map_err(|_| "无法完成配置恢复")?;
        }
        Ok(())
    }
    pub fn records(&self) -> Result<Records> {
        self.recover()?;
        read_json(&self.record_path())
    }
    fn matches(&self, agent: Agent, r: &Record, source: &str) -> bool {
        r.path == self.path(agent)
            && (r.hash == hash(source.as_bytes())
                || (r.semantic_hash.is_some()
                    && semantic_hash(agent, source).ok() == r.semantic_hash)
                || (agent == Agent::Zcode
                    && r.zcode_provider_hash.is_some()
                    && zcode_hash(source).ok() == r.zcode_provider_hash))
    }
    pub fn is_applied(&self, agent: Agent, r: &Record) -> bool {
        self.source(agent)
            .ok()
            .flatten()
            .is_some_and(|s| self.matches(agent, r, &s))
            && (agent != Agent::ClaudeCode || r.claude_config_revision == Some(1))
    }
    pub fn configured(&self, credential: Option<&str>) -> Result<Value> {
        let records = self.records()?;
        let mut out = json!({});
        for a in AGENTS {
            if let Some(r) = records.get(a.key()) {
                out[a.id()] = json!({"modelId":r.model_id,"modelName":r.model_name,"appliedAt":r.applied_at,"path":r.path,"credentialId":r.credential_id,"needsUpdate":!self.is_applied(a,r)||Some(r.credential_id.as_str())!=credential});
            }
        }
        Ok(out)
    }
    pub fn warnings(&self, agent: Agent, project: &str) -> Result<Vec<String>> {
        let records = self.records()?;
        let mut w = vec![];
        let source = self.source(agent)?.unwrap_or_default();
        if records
            .get(agent.key())
            .is_some_and(|r| !self.matches(agent, r, &source))
        {
            w.push(
                "当前配置与上次启用时不同。点击启用会备份当前文件并更新接入设置，保留其他设置。"
                    .into(),
            );
        }
        if self.paths.isolated {
            w.push(
                "Tauri 开发版：配置写入独立测试目录，不会修改正式客户端和编程工具的默认配置。"
                    .into(),
            );
        }
        match agent {
            Agent::ClaudeCode => {
                let v = json_object(&source)?;
                if v.get("apiKeyHelper").is_some()
                    || v["env"].get("ANTHROPIC_CUSTOM_HEADERS").is_some()
                {
                    w.push("现有配置包含自定义鉴权，请检查最终生效的连接设置。".into());
                }
                if !project.is_empty()
                    && ["settings.json", "settings.local.json"]
                        .iter()
                        .any(|p| PathBuf::from(project).join(".claude").join(p).exists())
                {
                    w.push("项目含 Claude Code 配置，请在新会话中检查实际模型。".into());
                }
            }
            Agent::Zcode => {
                json_object(&source)?;
                w.push(
                    "配置一致时无需重开 ZCode；改变模型或连接配置时，需先完全退出 ZCode 再启用。"
                        .into(),
                );
            }
            _ => {
                w.push("Codex CLI 与 Codex 桌面版共用配置。".into());
            }
        }
        Ok(w)
    }
    fn commit(
        &self,
        agent: Agent,
        before: Option<String>,
        after: Option<String>,
        records: Records,
    ) -> Result<()> {
        let journal = self.paths.state.join("config-transaction.json");
        let j = Journal {
            agent,
            before,
            after,
            records,
        };
        save_json(&journal, &j)?;
        if let Some(s) = &j.after {
            atomic_write(&self.path(agent), s.as_bytes())?;
        } else {
            fs::remove_file(self.path(agent)).map_err(|_| "无法恢复原始配置状态")?;
        }
        save_json(&self.record_path(), &j.records)?;
        fs::remove_file(journal).map_err(|_| "无法完成配置事务")?;
        Ok(())
    }
    pub fn apply(
        &self,
        agent: Agent,
        model: &Model,
        base: &str,
        credential: &str,
        credential_id: &str,
    ) -> Result<Value> {
        self.apply_checked(agent, model, base, credential, credential_id, false)
    }
    pub fn apply_checked(
        &self,
        agent: Agent,
        model: &Model,
        base: &str,
        credential: &str,
        credential_id: &str,
        running: bool,
    ) -> Result<Value> {
        let mut records = self.records()?;
        let before = self.source(agent)?;
        let source = before.as_deref().unwrap_or("");
        if !records.contains_key(agent.key()) && !self.paths.isolated {
            crate::migration::check_first_apply(&self.paths, agent)?;
            records = self.records()?;
        }
        let current = records.get(agent.key());
        // An explicit Apply authorizes replacing managed connection fields.
        // Read and merge the current file, never replay an old whole-file snapshot.
        let managed = current
            .map(|r| {
                r.managed_capabilities.clone().unwrap_or_else(|| {
                    if agent == Agent::ClaudeCode {
                        vec!["maxOutputTokens".into()]
                    } else {
                        vec!["contextWindow".into(), "maxOutputTokens".into()]
                    }
                })
            })
            .unwrap_or_default();
        let next = match agent {
            Agent::ClaudeCode => claude_configuration(source, base, credential, model, &managed)?,
            Agent::Zcode => zcode_configuration(source, base, credential, model)?,
            _ => codex_configuration(source, base, credential, model, &managed)?,
        };
        let changed =
            before.is_none() || semantic_hash(agent, source)? != semantic_hash(agent, &next)?;
        if changed && running && agent.desktop() {
            let name = if agent == Agent::Zcode {
                "ZCode"
            } else {
                "Codex 桌面版"
            };
            return Err(format!("本次会改变 {name} 的模型或连接配置。请先完全退出 {name}，再点击启用；当前配置尚未修改。"));
        }
        let mut backup = current.and_then(|r| r.backup.clone());
        let before_apply_backup = if before.is_some() && (changed || current.is_none()) {
            let p = self.paths.state.join("backups").join(format!(
                "before-apply-{}-{}.backup",
                agent.key(),
                uuid::Uuid::new_v4()
            ));
            atomic_write(&p, source.as_bytes())?;
            Some(p)
        } else {
            None
        };
        let original_exists = current
            .map(|r| r.original_exists)
            .unwrap_or(before.is_some());
        if current.is_none() && original_exists {
            backup = before_apply_backup.clone();
        }
        let mut caps = vec![];
        if agent != Agent::Zcode {
            if model.context_window.is_some() {
                caps.push("contextWindow".into());
            }
            if agent == Agent::ClaudeCode && model.max_output_tokens.is_some() {
                caps.push("maxOutputTokens".into());
            }
        }
        let r = Record {
            applied_model: Some(model.clone()),
            model_id: model.id.clone(),
            model_name: model.name.clone(),
            applied_at: now(),
            path: self.path(agent),
            credential_id: credential_id.into(),
            hash: hash(if changed {
                next.as_bytes()
            } else {
                source.as_bytes()
            }),
            semantic_hash: Some(semantic_hash(agent, if changed { &next } else { source })?),
            backup,
            original_exists,
            managed_capabilities: Some(caps),
            claude_config_revision: if agent == Agent::ClaudeCode {
                Some(1)
            } else {
                None
            },
            zcode_provider_hash: if agent == Agent::Zcode {
                Some(zcode_hash(&next)?)
            } else {
                None
            },
            preserve_zcode_external_changes: agent == Agent::Zcode
                && current.is_some_and(|r| {
                    r.preserve_zcode_external_changes || r.hash != hash(source.as_bytes())
                }),
        };
        records.insert(agent.key().into(), r);
        if changed {
            self.commit(agent, before, Some(next), records)?;
        } else {
            save_json(&self.record_path(), &records)?;
        }
        Ok(
            json!({"path":self.path(agent),"changed":changed,"beforeApplyBackup":before_apply_backup,"warnings":self.warnings(agent,"")?}),
        )
    }
    pub fn restore(&self, agent: Agent) -> Result<Value> {
        let mut records = self.records()?;
        let r = records.get(agent.key()).ok_or("没有可恢复的客户端备份")?;
        let before = self.source(agent)?;
        let source = before.as_deref().unwrap_or("");
        if !self.matches(agent, r, source) {
            return Err("配置已被其他程序修改，请手动检查备份，自动恢复已暂停".into());
        }
        let original = if r.original_exists {
            let p = r.backup.as_ref().ok_or("接管前的配置备份不存在")?;
            if !p.starts_with(self.paths.state.join("backups")) {
                return Err("备份路径无效".into());
            }
            Some(read_optional(p)?.ok_or("接管前的配置备份不存在")?)
        } else {
            None
        };
        let after = if agent == Agent::Zcode
            && (r.preserve_zcode_external_changes || r.hash != hash(source.as_bytes()))
        {
            let v = json_object(original.as_deref().unwrap_or(""))?;
            let root = root(source)?;
            set(
                &root.object_value_or_set().object_value_or_set("provider"),
                "coding_access",
                v["provider"].get("coding_access"),
            );
            Some(finish(root))
        } else {
            original
        };
        records.remove(agent.key());
        self.commit(agent, before, after, records)?;
        Ok(json!({"path":self.path(agent)}))
    }
}
