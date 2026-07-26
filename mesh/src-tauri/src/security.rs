use std::path::Path;

use tokio::fs::{DirBuilder, File, OpenOptions};

pub(crate) const BLOCKED_ATTACHMENT_EXTENSIONS: &[&str] = &[
    "app", "bat", "chm", "cmd", "com", "command", "cpl", "desktop", "dll", "exe", "gadget", "hta",
    "inf", "jar", "jnlp", "js", "jse", "lnk", "msc", "msh", "msh1", "msh2", "msi", "pif", "ps1",
    "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "reg", "rgs", "scf", "scr", "sct", "shb", "shs",
    "sys", "url", "vbe", "vbs", "wasm", "ws", "wsc", "wsf", "wsh",
];

pub(crate) fn has_blocked_attachment_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            BLOCKED_ATTACHMENT_EXTENSIONS
                .iter()
                .any(|blocked| blocked.eq_ignore_ascii_case(extension))
        })
}

pub(crate) fn is_file_in_named_directory_under(
    path: &Path,
    root: &Path,
    directory_name: &str,
) -> bool {
    path.is_file()
        && path.starts_with(root)
        && path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == directory_name)
}

pub(crate) async fn create_private_dir(path: &Path, recursive: bool) -> std::io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).await
}

pub(crate) async fn open_private_file(path: &Path, create_new: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_extension_policy_is_canonical_and_complete() {
        let mut sorted = BLOCKED_ATTACHMENT_EXTENSIONS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, BLOCKED_ATTACHMENT_EXTENSIONS);

        for required in [
            "jar", "chm", "desktop", "app", "command", "jnlp", "msc", "gadget", "scf", "url",
        ] {
            assert!(BLOCKED_ATTACHMENT_EXTENSIONS.contains(&required));
        }
        assert!(has_blocked_attachment_extension(Path::new("payload.EXE")));
        assert!(!has_blocked_attachment_extension(Path::new("photo.jpeg")));
    }

    #[test]
    fn opener_capability_allows_only_web_and_email_urls() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let permissions = capability["permissions"].as_array().unwrap();
        assert!(!permissions.iter().any(|permission| {
            permission
                .as_str()
                .is_some_and(|identifier| identifier == "opener:default")
        }));
        let opener = permissions
            .iter()
            .find(|permission| permission["identifier"] == "opener:allow-open-url")
            .expect("scoped opener permission is missing");
        let urls: Vec<_> = opener["allow"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["url"].as_str().unwrap())
            .collect();
        assert_eq!(urls, ["https://*", "http://*", "mailto:*"]);
    }

    #[test]
    fn downloaded_file_scope_rejects_siblings_and_nested_spoofs() {
        let root = tempfile::tempdir().unwrap();
        let matrix_root = root.path().join("matrix");
        let cache = matrix_root
            .join("accounts")
            .join("profile")
            .join("media-cache");
        std::fs::create_dir_all(&cache).unwrap();
        let allowed = cache.join("photo.png");
        std::fs::write(&allowed, b"image").unwrap();
        let sibling = matrix_root
            .join("accounts")
            .join("profile")
            .join("session.db");
        std::fs::write(&sibling, b"secret").unwrap();
        let spoof = root.path().join("outside").join("media-cache");
        std::fs::create_dir_all(&spoof).unwrap();
        let spoofed_file = spoof.join("photo.png");
        std::fs::write(&spoofed_file, b"image").unwrap();

        assert!(is_file_in_named_directory_under(
            &allowed,
            &matrix_root,
            "media-cache"
        ));
        assert!(!is_file_in_named_directory_under(
            &sibling,
            &matrix_root,
            "media-cache"
        ));
        assert!(!is_file_in_named_directory_under(
            &spoofed_file,
            &matrix_root,
            "media-cache"
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn private_cache_permissions_are_applied_at_creation() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("account").join("media-cache");
        create_private_dir(&cache, true).await.unwrap();
        let file_path = cache.join("decrypted.bin");
        let file = open_private_file(&file_path, true).await.unwrap();
        drop(file);

        assert_eq!(
            std::fs::metadata(&cache).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&file_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
