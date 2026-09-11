use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Agent {
    ClaudeCode,
    CodexCli,
    CodexDesktop,
    Zcode,
}
impl Agent {
    pub fn id(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::CodexCli => "codex-cli",
            Self::CodexDesktop => "codex-desktop",
            Self::Zcode => "zcode",
        }
    }
    pub fn key(self) -> &'static str {
        if self.codex() {
            "codex"
        } else {
            self.id()
        }
    }
    pub fn codex(self) -> bool {
        matches!(self, Self::CodexCli | Self::CodexDesktop)
    }
    pub fn desktop(self) -> bool {
        matches!(self, Self::CodexDesktop | Self::Zcode)
    }
}
pub const AGENTS: [Agent; 4] = [
    Agent::ClaudeCode,
    Agent::CodexCli,
    Agent::CodexDesktop,
    Agent::Zcode,
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub vision: Option<bool>,
}
impl Model {
    pub fn validate(&self) -> crate::Result<()> {
        if self.id.is_empty() || self.id.len() > 128 || self.id.chars().any(char::is_control) {
            return Err("模型编号无效".into());
        }
        if self
            .context_window
            .is_some_and(|n| !(1024..=4_000_000).contains(&n))
            || self
                .max_output_tokens
                .is_some_and(|n| !(1..=512000).contains(&n))
        {
            return Err("模型容量无效，请检查服务端配置".into());
        }
        Ok(())
    }
}
