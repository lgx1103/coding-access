pub mod client;
pub mod config;
#[cfg(feature = "desktop")]
pub mod desktop;
pub mod filesystem;
pub mod migration;
pub mod model;
pub mod terminal;
pub mod vault;

pub type Result<T> = std::result::Result<T, String>;

pub mod agents;
#[cfg(target_os = "macos")]
pub mod macos_app;

#[cfg(feature = "desktop")]
pub mod updates;
