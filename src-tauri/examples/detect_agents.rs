//! Read-only local acceptance: no launches, model requests or configuration writes.
use coding_access_native::{
    agents::{self, DesktopTarget},
    model::AGENTS,
    terminal,
};
use serde_json::json;

#[tokio::main]
async fn main() {
    let mut report = vec![];
    for agent in AGENTS {
        let target = if agent.desktop() {
            agents::desktop_target(agent)
                .await
                .unwrap()
                .map(|t| match t {
                    DesktopTarget::File(p) => p.to_string_lossy().into_owned(),
                    DesktopTarget::Store(id) => format!("appx:{id}"),
                })
        } else {
            terminal::locate_tool(agent).map(|p| p.to_string_lossy().into_owned())
        };
        report.push(json!({"agent":agent,"installed":target.is_some(),"target":target}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({"readOnly":true,"agents":report})).unwrap()
    );
}
