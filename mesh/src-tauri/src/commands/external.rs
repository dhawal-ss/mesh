use url::{Host, Url};

use super::error::CommandError;

const MAX_EXTERNAL_URL_BYTES: usize = 2_048;

fn validate_external_url(value: &str) -> Result<Url, CommandError> {
    let normalized_input = value.to_ascii_lowercase();
    if value.len() > MAX_EXTERNAL_URL_BYTES
        || value.chars().any(char::is_control)
        || normalized_input.contains("%0a")
        || normalized_input.contains("%0d")
    {
        return Err(CommandError::Validation(
            "That link is too long or contains unsupported characters".into(),
        ));
    }

    let url =
        Url::parse(value).map_err(|_| CommandError::Validation("That link is not valid".into()))?;
    match url.scheme() {
        "mailto" => {
            if url.path().is_empty() || url.path().contains(['\r', '\n']) {
                return Err(CommandError::Validation(
                    "That email link is not valid".into(),
                ));
            }
        }
        "https" => {
            if !url.username().is_empty() || url.password().is_some() {
                return Err(CommandError::Validation(
                    "Links containing embedded credentials are not supported".into(),
                ));
            }
            if url.port().is_some_and(|port| port != 443) {
                return Err(CommandError::Validation(
                    "External links must use the standard secure port".into(),
                ));
            }
            match url.host() {
                Some(Host::Domain(host)) => {
                    let host = host.trim_end_matches('.').to_ascii_lowercase();
                    if host == "localhost"
                        || host.ends_with(".localhost")
                        || host.ends_with(".local")
                        || host.ends_with(".internal")
                        || host.ends_with(".home.arpa")
                    {
                        return Err(CommandError::Validation(
                            "Local-network links cannot be opened from message content".into(),
                        ));
                    }
                }
                Some(Host::Ipv4(_) | Host::Ipv6(_)) => {
                    return Err(CommandError::Validation(
                        "Direct IP-address links cannot be opened from message content".into(),
                    ));
                }
                None => {
                    return Err(CommandError::Validation(
                        "That secure link has no destination".into(),
                    ));
                }
            }
        }
        _ => {
            return Err(CommandError::Validation(
                "Mesh opens only secure web links and email links".into(),
            ));
        }
    }
    Ok(url)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), CommandError> {
    let url = validate_external_url(&url)?;
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
        .map_err(|_| CommandError::Other("Mesh could not open that link".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_boundary_allows_secure_public_links_and_email() {
        assert!(validate_external_url("https://matrix.org/docs/?view=client#start").is_ok());
        assert!(validate_external_url("https://example.com:443/path").is_ok());
        assert!(validate_external_url("mailto:support@example.com?subject=Mesh").is_ok());
    }

    #[test]
    fn external_url_boundary_rejects_unsafe_schemes_and_destinations() {
        for value in [
            "http://example.com",
            "https://user:password@example.com",
            "https://example.com:8443",
            "https://localhost/settings",
            "https://router.local/settings",
            "https://10.0.0.1/settings",
            "https://[::1]/settings",
            "mailto:support@example.com?subject=hello%0d%0abcc:attacker@example.com",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,unsafe",
        ] {
            assert!(validate_external_url(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn ip_literals_remain_rejected_even_when_they_parse_as_public() {
        assert!(matches!(
            Url::parse("https://8.8.8.8/").unwrap().host(),
            Some(Host::Ipv4(_))
        ));
        assert!(validate_external_url("https://8.8.8.8/").is_err());
    }
}
