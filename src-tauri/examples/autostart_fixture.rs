//! Registers only a uniquely named QA login item, then removes it, even on panic.
use tauri_plugin_autostart::ManagerExt;
struct Cleanup<'a>(&'a tauri_plugin_autostart::AutoLaunchManager);
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        let _ = self.0.disable();
    }
}
fn main() {
    let name = format!("CodingAccessQA-{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(name)
                .args(["--autostart"])
                .build(),
        )
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let launch = app.autolaunch();
    let _cleanup = Cleanup(&launch);
    assert!(!launch.is_enabled().unwrap());
    launch.enable().unwrap();
    assert!(launch.is_enabled().unwrap());
    launch.disable().unwrap();
    assert!(!launch.is_enabled().unwrap());
    println!("{{\"registered\":true,\"detected\":true,\"removed\":true,\"actualSystemLoginTested\":false}}");
}
