//! Verify actual Tauri updater downloads/signatures against an isolated local server.
//! Install verification is restricted to a marked synthetic bundle directory.
use tauri_plugin_updater::UpdaterExt;
#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let endpoint = args.get(1).expect("local endpoint");
    assert!(endpoint.starts_with("http://127.0.0.1:"));
    let public = std::fs::read_to_string(args.get(2).expect("test public key")).unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({"pubkey":public.trim(),"dangerousInsecureTransportProtocol":true}),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    if args.get(3).is_some_and(|v| v == "--job") {
        let job = coding_access_native::updates::Updates::default();
        assert_eq!(
            job.check(app.handle(), endpoint, "beta").await.unwrap()["state"],
            "available"
        );
        assert_eq!(job.download().unwrap()["state"], "downloading");
        assert_eq!(job.download().unwrap()["state"], "downloading");
        for _ in 0..100 {
            if job.status()["downloaded"].as_u64().unwrap_or(0) > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(job.status()["downloaded"].as_u64().unwrap_or(0) > 0);
        assert_eq!(job.cancel()["state"], "available");
        job.download().unwrap();
        for _ in 0..300 {
            if job.status()["state"] != "downloading" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(job.status()["state"], "ready", "{}", job.status());
        assert!(job.status()["total"].as_u64().unwrap() > 0);
        assert_eq!(job.status()["downloaded"], job.status()["total"]);
        let isolated = tempfile::tempdir().unwrap();
        assert!(job.install(app.handle(), true, isolated.path()).is_err());
        job.cancel();
        job.download_automatic(app.handle().clone(), true, isolated.path().into())
            .unwrap();
        while job.status()["state"] == "downloading" {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(job.status()["state"], "ready");
        assert_eq!(job.status()["autoInstall"], true);
        job.cancel();
        tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
        assert_eq!(job.status()["state"], "available");
        job.download_automatic(app.handle().clone(), true, isolated.path().into())
            .unwrap();
        for _ in 0..600 {
            if job.status()["state"] == "error" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        // Reached installation automatically, but the fixture cannot touch an app.
        assert_eq!(job.status()["state"], "error");
        assert!(job.status()["message"]
            .as_str()
            .unwrap()
            .contains("开发环境"));
        job.cancel();
        job.download_automatic(app.handle().clone(), true, isolated.path().into())
            .unwrap();
        for _ in 0..600 {
            if job.status()["state"] == "error" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(job.status()["message"]
            .as_str()
            .unwrap()
            .contains("签名校验失败"));
        tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
        assert!(job.status()["message"]
            .as_str()
            .unwrap()
            .contains("签名校验失败"));
        job.reset();
        assert_eq!(job.status()["state"], "idle");
        println!(
            "{}",
            serde_json::json!({"cancelled":true,"retryVerified":true,"duplicateGuard":true,"completedBytes":true,"autoInstallReached":true,"cancelPreventsAutoInstall":true,"badSignatureNeverInstalls":true,"isolatedInstallBlocked":true})
        );
        return;
    }
    let mut builder = app.updater_builder();
    let target = args.get(3).map(std::path::PathBuf::from);
    if let Some(root) = &target {
        assert_eq!(
            std::fs::read_to_string(root.join(".aca-update-fixture")).unwrap(),
            "synthetic"
        );
        builder = builder.executable_path(root.join("old/Fixture.app/Contents/MacOS/fixture"));
    }
    let updater = builder
        .endpoints(vec![endpoint.parse().unwrap()])
        .unwrap()
        .no_proxy()
        .build()
        .unwrap();
    let update = updater.check().await.unwrap().unwrap();
    let result = update.download(|_, _| {}, || {}).await;
    let install_result = if target.is_some() {
        result
            .as_ref()
            .map_err(|e| e.to_string())
            .and_then(|bytes| {
                #[cfg(target_os = "macos")]
                coding_access_native::updates::check_install_directory(
                    &target.as_ref().unwrap().join("old/Fixture.app"),
                )?;
                update.install(bytes).map_err(|e| e.to_string())
            })
    } else {
        Ok(())
    };
    let installed = target.is_some() && install_result.is_ok();
    println!(
        "{}",
        serde_json::json!({"installError":install_result.err(),"installed":installed,"verified":result.is_ok(),"size":result.as_ref().map(|v|v.len()).unwrap_or(0)})
    );
}
