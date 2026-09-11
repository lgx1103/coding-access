//! Explicit smoke check; writes and removes one synthetic OS-vault entry.
use coding_access_native::{
    filesystem::hash,
    vault::{SystemVault, Vault},
};
fn main() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap();
    let vault = SystemVault::new(&path);
    assert!(vault.load().unwrap().is_none());
    vault.save("synthetic-tauri-vault-smoke").unwrap();
    let loaded = vault.load();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    keyring::Entry::new(
        "com.codingaccess.tauri.dev",
        &hash(path.to_string_lossy().as_bytes()),
    )
    .unwrap()
    .delete_credential()
    .unwrap();
    assert_eq!(
        loaded.unwrap().as_deref(),
        Some("synthetic-tauri-vault-smoke")
    );
    assert!(vault.load().unwrap().is_none());
    println!("OS credential storage save/read/delete passed; synthetic item removed");
}
