use std::path::Path;

use tokio::fs::{DirBuilder, File, OpenOptions};

pub(crate) const BLOCKED_ATTACHMENT_EXTENSIONS: &[&str] = &[
    "apk",
    "app",
    "appimage",
    "appinstaller",
    "appx",
    "appxbundle",
    "bash",
    "bat",
    "bin",
    "chm",
    "cmd",
    "com",
    "command",
    "cpl",
    "csh",
    "deb",
    "desktop",
    "dll",
    "dmg",
    "docm",
    "dotm",
    "exe",
    "fish",
    "gadget",
    "hta",
    "htm",
    "html",
    "img",
    "inf",
    "iso",
    "jar",
    "jnlp",
    "js",
    "jse",
    "ksh",
    "lnk",
    "lua",
    "mjs",
    "msc",
    "msh",
    "msh1",
    "msh2",
    "msi",
    "msix",
    "msixbundle",
    "pif",
    "pl",
    "potm",
    "ppam",
    "ppsm",
    "pptm",
    "ps1",
    "ps1xml",
    "ps2",
    "ps2xml",
    "psc1",
    "psc2",
    "psd1",
    "psm1",
    "py",
    "pyc",
    "pyo",
    "pyw",
    "rb",
    "reg",
    "rgs",
    "rpm",
    "scf",
    "scr",
    "sct",
    "sh",
    "shb",
    "shs",
    "sldm",
    "svg",
    "sys",
    "url",
    "vbe",
    "vbs",
    "vhd",
    "vhdx",
    "wasm",
    "ws",
    "wsc",
    "wsf",
    "wsh",
    "xht",
    "xhtml",
    "xlsm",
    "xltm",
    "zsh",
];

const ACTIVE_ATTACHMENT_CONTENT_TYPES: &[&str] = &[
    "application/ecmascript",
    "application/hta",
    "application/javascript",
    "application/vnd.microsoft.portable-executable",
    "application/vnd.ms-htmlhelp",
    "application/vnd.ms-office",
    "application/vnd.ms-powerpoint.addin.macroenabled.12",
    "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
    "application/vnd.ms-powerpoint.template.macroenabled.12",
    "application/vnd.ms-word.document.macroenabled.12",
    "application/vnd.ms-word.template.macroenabled.12",
    "application/vnd.ms-excel.addin.macroenabled.12",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.ms-excel.template.macroenabled.12",
    "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    "application/x-bat",
    "application/x-csh",
    "application/x-dosexec",
    "application/x-executable",
    "application/x-httpd-php",
    "application/x-iso9660-image",
    "application/x-javascript",
    "application/x-msdownload",
    "application/x-msi",
    "application/x-powershell",
    "application/x-python",
    "application/x-sh",
    "application/x-shellscript",
    "application/x-shockwave-flash",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/ecmascript",
    "text/html",
    "text/javascript",
    "text/x-python",
    "text/x-script.python",
    "text/x-shellscript",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AttachmentDisposition {
    Safe,
    Active,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AttachmentClassification {
    pub disposition: AttachmentDisposition,
    pub reason: &'static str,
}

fn normalized_content_type(content_type: Option<&str>) -> Option<String> {
    content_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

fn executable_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(b"MZ")
        || bytes.starts_with(b"\x7fELF")
        || bytes.starts_with(b"#!")
        || bytes.starts_with(b"\xfe\xed\xfa\xce")
        || bytes.starts_with(b"\xce\xfa\xed\xfe")
        || bytes.starts_with(b"\xfe\xed\xfa\xcf")
        || bytes.starts_with(b"\xcf\xfa\xed\xfe")
        || bytes.starts_with(b"\xca\xfe\xba\xbe")
}

fn active_text_signature(bytes: &[u8]) -> bool {
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
    let prefix = prefix
        .trim_start_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
    prefix.starts_with("<!doctype html")
        || prefix.starts_with("<html")
        || prefix.starts_with("<svg")
        || prefix.starts_with("<script")
        || prefix.starts_with("<?xml") && prefix.contains("<svg")
}

fn recognized_safe_signature(extension: Option<&str>, bytes: &[u8]) -> bool {
    match extension {
        Some("png") => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        Some("jpg" | "jpeg") => bytes.starts_with(b"\xff\xd8\xff"),
        Some("gif") => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        Some("webp") => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        Some("wav") => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE",
        Some("ogg" | "oga" | "ogv") => bytes.starts_with(b"OggS"),
        Some("flac") => bytes.starts_with(b"fLaC"),
        Some("mp3") => bytes.starts_with(b"ID3") || bytes.first() == Some(&0xff),
        Some("mp4" | "m4a" | "m4v" | "mov") => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
        Some("txt" | "md" | "csv" | "json") => !bytes.contains(&0),
        _ => false,
    }
}

/// Classify an attachment from every native signal available at the boundary.
///
/// `prefix` should contain up to the first 4 KiB for intake/opening and may be
/// the complete buffer for Matrix transfers. Unknown containers remain
/// saveable but are never considered safe for direct OS opening.
pub(crate) fn classify_attachment(
    filename: &str,
    content_type: Option<&str>,
    prefix: &[u8],
) -> AttachmentClassification {
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if extension.as_deref().is_some_and(|extension| {
        BLOCKED_ATTACHMENT_EXTENSIONS
            .iter()
            .any(|blocked| blocked.eq_ignore_ascii_case(extension))
    }) {
        return AttachmentClassification {
            disposition: AttachmentDisposition::Active,
            reason: "active filename",
        };
    }

    let content_type = normalized_content_type(content_type);
    if content_type.as_deref().is_some_and(|content_type| {
        ACTIVE_ATTACHMENT_CONTENT_TYPES
            .iter()
            .any(|blocked| blocked.eq_ignore_ascii_case(content_type))
    }) {
        return AttachmentClassification {
            disposition: AttachmentDisposition::Active,
            reason: "active content type",
        };
    }
    if executable_signature(prefix) || active_text_signature(prefix) {
        return AttachmentClassification {
            disposition: AttachmentDisposition::Active,
            reason: "active file contents",
        };
    }

    let expected_type = match extension.as_deref() {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("wav") => Some("audio/wav"),
        Some("ogg" | "oga") => Some("audio/ogg"),
        Some("flac") => Some("audio/flac"),
        Some("mp3") => Some("audio/mpeg"),
        Some("mp4" | "m4v" | "mov") => Some("video/mp4"),
        Some("m4a") => Some("audio/mp4"),
        Some("txt" | "md") => Some("text/plain"),
        Some("csv") => Some("text/csv"),
        Some("json") => Some("application/json"),
        _ => None,
    };
    if let (Some(expected), Some(declared)) = (expected_type, content_type.as_deref()) {
        if declared != expected && declared != "application/octet-stream" {
            return AttachmentClassification {
                disposition: AttachmentDisposition::Ambiguous,
                reason: "conflicting filename and content type",
            };
        }
    }
    if expected_type.is_some() && recognized_safe_signature(extension.as_deref(), prefix) {
        return AttachmentClassification {
            disposition: AttachmentDisposition::Safe,
            reason: "recognized passive content",
        };
    }

    AttachmentClassification {
        disposition: AttachmentDisposition::Ambiguous,
        reason: "unrecognized or container content",
    }
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
        assert_eq!(
            classify_attachment("payload.EXE", None, &[]).disposition,
            AttachmentDisposition::Active
        );
        assert_ne!(
            classify_attachment("photo.jpeg", None, &[]).disposition,
            AttachmentDisposition::Active
        );
    }

    #[test]
    fn central_attachment_classifier_combines_name_mime_magic_and_text_sniffing() {
        assert_eq!(
            classify_attachment("photo.png", Some("image/png"), b"\x89PNG\r\n\x1a\nrest")
                .disposition,
            AttachmentDisposition::Safe
        );
        assert_eq!(
            classify_attachment("photo.png", Some("image/png"), b"MZnot-really-an-image")
                .disposition,
            AttachmentDisposition::Active
        );
        assert_eq!(
            classify_attachment("notes.txt", Some("text/plain"), b"  <!doctype html><html>")
                .disposition,
            AttachmentDisposition::Active
        );
        assert_eq!(
            classify_attachment("vector.svg", Some("image/svg+xml"), b"<svg/>").disposition,
            AttachmentDisposition::Active
        );
        assert_eq!(
            classify_attachment("photo.png", Some("image/jpeg"), b"\x89PNG\r\n\x1a\nrest")
                .disposition,
            AttachmentDisposition::Ambiguous
        );
        assert_eq!(
            classify_attachment("archive.zip", Some("application/zip"), b"PK\x03\x04").disposition,
            AttachmentDisposition::Ambiguous
        );
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
    fn downloaded_file_scope_rejects_siblings_spoofs_and_other_accounts() {
        let root = tempfile::tempdir().unwrap();
        let matrix_root = root.path().join("matrix");
        let active_account = matrix_root.join("accounts").join("active-profile");
        let cache = active_account.join("media-cache");
        std::fs::create_dir_all(&cache).unwrap();
        let allowed = cache.join("photo.png");
        std::fs::write(&allowed, b"image").unwrap();
        let sibling = active_account.join("session.db");
        std::fs::write(&sibling, b"secret").unwrap();
        let other_account_cache = matrix_root
            .join("accounts")
            .join("other-profile")
            .join("media-cache");
        std::fs::create_dir_all(&other_account_cache).unwrap();
        let other_account_file = other_account_cache.join("private.png");
        std::fs::write(&other_account_file, b"image").unwrap();
        let spoof = root.path().join("outside").join("media-cache");
        std::fs::create_dir_all(&spoof).unwrap();
        let spoofed_file = spoof.join("photo.png");
        std::fs::write(&spoofed_file, b"image").unwrap();

        assert!(is_file_in_named_directory_under(
            &allowed,
            &active_account,
            "media-cache"
        ));
        assert!(!is_file_in_named_directory_under(
            &sibling,
            &active_account,
            "media-cache"
        ));
        assert!(!is_file_in_named_directory_under(
            &other_account_file,
            &active_account,
            "media-cache"
        ));
        assert!(!is_file_in_named_directory_under(
            &spoofed_file,
            &active_account,
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
