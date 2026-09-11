//! Read-only macOS application discovery. File names are not application IDs.
use crate::model::Agent;
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::{NSBundle, NSString};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn bundle_id(agent: Agent) -> Option<&'static str> {
    match agent {
        Agent::CodexDesktop => Some("com.openai.codex"),
        Agent::Zcode => Some("dev.zcode.app"),
        _ => None,
    }
}

pub fn matches_bundle(path: &Path, agent: Agent) -> bool {
    autoreleasepool(|_| {
        let Some(expected) = bundle_id(agent) else {
            return false;
        };
        if !path.is_dir()
            || !path
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("app"))
        {
            return false;
        }
        let Some(path) = path.to_str() else {
            return false;
        };
        let Some(bundle) = NSBundle::bundleWithPath(&NSString::from_str(path)) else {
            return false;
        };
        bundle
            .bundleIdentifier()
            .is_some_and(|id| id.to_string() == expected)
            && bundle.executablePath().is_some_and(|p| {
                crate::terminal::usable_executable(Path::new(&p.to_string()), false)
            })
    })
}

pub fn find_in_directories(agent: Agent, directories: &[PathBuf]) -> Option<PathBuf> {
    for directory in directories {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        let mut paths = entries.flatten().map(|e| e.path()).collect::<Vec<_>>();
        paths.sort();
        if let Some(path) = paths.into_iter().find(|p| matches_bundle(p, agent)) {
            return Some(path);
        }
    }
    None
}

pub fn running(agent: Agent) -> bool {
    autoreleasepool(|_| {
        bundle_id(agent).is_some_and(|id| {
            !NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(id))
                .is_empty()
        })
    })
}

pub fn locate(agent: Agent) -> Option<PathBuf> {
    autoreleasepool(|_| {
        let id = NSString::from_str(bundle_id(agent)?);
        // Prefer the actual running bundle, including renamed/translocated apps.
        let applications = NSRunningApplication::runningApplicationsWithBundleIdentifier(&id);
        for index in 0..applications.len() {
            let app = applications.objectAtIndex(index);
            if let Some(path) = app
                .bundleURL()
                .filter(|u| u.isFileURL())
                .and_then(|u| u.path())
            {
                let path = PathBuf::from(path.to_string());
                if matches_bundle(&path, agent) {
                    return Some(path);
                }
            }
        }
        // LaunchServices also knows apps installed outside /Applications.
        if let Some(path) = NSWorkspace::sharedWorkspace()
            .URLForApplicationWithBundleIdentifier(&id)
            .filter(|u| u.isFileURL())
            .and_then(|u| u.path())
        {
            let path = PathBuf::from(path.to_string());
            if matches_bundle(&path, agent) {
                return Some(path);
            }
        }
        // An unregistered app can still be found after a drag-and-drop install.
        let mut directories = vec![PathBuf::from("/Applications")];
        if let Some(home) = dirs::home_dir() {
            directories.push(home.join("Applications"));
        }
        find_in_directories(agent, &directories)
    })
}
