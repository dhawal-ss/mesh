use serde::Serialize;

#[derive(Debug, thiserror::Error)]
#[cfg_attr(not(feature = "legacy-p2p"), allow(dead_code))]
pub enum CommandError {
    #[error("authentication is required")]
    NotAuthenticated,
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("network error: {0}")]
    Network(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("identity error: {0}")]
    Identity(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("room is not encrypted: {0}")]
    NotEncrypted(String),
    #[error("content could not be decrypted: {0}")]
    DecryptionFailed(String),
    #[error("serialization error: {0}")]
    Serialization(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("community-hosted service is not configured")]
    CommunityHomeserverUnconfigured,
    #[error("that username is not available")]
    UsernameUnavailable,
    #[error("account creation requires accepting the service terms")]
    RegistrationTermsRequired,
    #[error("account creation requires an additional verification step")]
    RegistrationAdditionalAuthRequired,
    #[error("account creation requires a valid Mesh invitation")]
    RegistrationInvitationRequired,
    #[error("the Mesh invitation is invalid, expired, or already used")]
    RegistrationInvitationInvalid,
    #[error("account creation timed out")]
    RegistrationTimedOut,
    #[error("rate limited")]
    RateLimited,
    #[error("banned from community")]
    Banned,
    #[error("operation is unavailable: {0}")]
    Unsupported(String),
    #[error("sign-in was cancelled")]
    LoginCancelled,
    #[error("sign-in timed out")]
    LoginTimedOut,
    #[error("operation was cancelled: {0}")]
    Cancelled(String),
    #[error("{0}")]
    Other(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SerializedCommandError {
    code: &'static str,
    detail: String,
    retryable: bool,
}

impl CommandError {
    fn code(&self) -> &'static str {
        match self {
            Self::NotAuthenticated => "not_authenticated",
            Self::Database(_) => "database_error",
            Self::Network(_) => "network_unavailable",
            Self::Crypto(_) => "crypto_error",
            Self::Identity(_) => "identity_error",
            Self::NotFound(_) => "not_found",
            Self::PermissionDenied(_) => "permission_denied",
            Self::NotEncrypted(_) => "not_encrypted",
            Self::DecryptionFailed(_) => "decryption_failed",
            Self::Serialization(_) => "serialization_error",
            Self::Validation(_) => "validation_error",
            Self::CommunityHomeserverUnconfigured => "community_homeserver_unconfigured",
            Self::UsernameUnavailable => "username_unavailable",
            Self::RegistrationTermsRequired => "registration_terms_required",
            Self::RegistrationAdditionalAuthRequired => "registration_additional_auth_required",
            Self::RegistrationInvitationRequired => "registration_invitation_required",
            Self::RegistrationInvitationInvalid => "registration_invitation_invalid",
            Self::RegistrationTimedOut => "registration_timed_out",
            Self::RateLimited => "rate_limited",
            Self::Banned => "banned",
            Self::Unsupported(_) => "unsupported_operation",
            Self::LoginCancelled => "login_cancelled",
            Self::LoginTimedOut => "login_timed_out",
            Self::Cancelled(_) => "cancelled",
            Self::Other(_) => "unexpected_error",
        }
    }

    fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Network(_) | Self::RateLimited | Self::LoginTimedOut | Self::RegistrationTimedOut
        )
    }
}

fn sanitize_detail(detail: &str) -> String {
    const SECRET_MARKERS: [&str; 7] = [
        "access_token",
        "refresh_token",
        "authorization",
        "bearer",
        "password",
        "recovery_key",
        "secret",
    ];

    let mut sanitized = detail
        .split_whitespace()
        .scan(false, |redact_next, token| {
            let lower = token.to_ascii_lowercase();
            let contains_secret = SECRET_MARKERS.iter().any(|marker| lower.contains(marker));
            let redact_current = *redact_next || contains_secret;
            let inline_value = ['=', ':'].iter().any(|separator| {
                lower.split_once(*separator).is_some_and(|(_, value)| {
                    !value
                        .trim_matches(|character| matches!(character, '\'' | '"'))
                        .is_empty()
                })
            });
            let marker_needs_following_value = contains_secret
                && (!inline_value
                    || lower
                        .trim_matches(|character: char| !character.is_ascii_alphanumeric())
                        .ends_with("bearer"));
            *redact_next = marker_needs_following_value;

            if redact_current {
                return Some("[redacted]".to_owned());
            }

            let bytes = token.as_bytes();
            let windows_path = bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/');
            let unc_path = token.starts_with("\\\\");
            let unix_path = token.starts_with('/') && !token.starts_with("//");
            if windows_path || unc_path || unix_path {
                Some("[redacted path]".to_owned())
            } else {
                Some(token.to_owned())
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    if sanitized.chars().count() > 512 {
        sanitized = sanitized.chars().take(509).collect::<String>();
        sanitized.push_str("...");
    }
    sanitized
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        SerializedCommandError {
            code: self.code(),
            detail: sanitize_detail(&self.to_string()),
            retryable: self.retryable(),
        }
        .serialize(serializer)
    }
}

impl From<anyhow::Error> for CommandError {
    fn from(err: anyhow::Error) -> Self {
        CommandError::Other(err.to_string())
    }
}

impl From<serde_json::Error> for CommandError {
    fn from(err: serde_json::Error) -> Self {
        Self::Serialization(err.to_string())
    }
}

impl From<String> for CommandError {
    fn from(err: String) -> Self {
        CommandError::Other(err)
    }
}

impl From<&str> for CommandError {
    fn from(err: &str) -> Self {
        CommandError::Other(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_errors_serialize_as_a_stable_typed_contract() {
        let serialized =
            serde_json::to_value(CommandError::Network("connection refused".to_owned())).unwrap();

        assert_eq!(serialized["code"], "network_unavailable");
        assert_eq!(serialized["detail"], "network error: connection refused");
        assert_eq!(serialized["retryable"], true);
    }

    #[test]
    fn registration_errors_keep_distinct_actionable_codes() {
        let cases = [
            (
                CommandError::CommunityHomeserverUnconfigured,
                "community_homeserver_unconfigured",
                false,
            ),
            (
                CommandError::UsernameUnavailable,
                "username_unavailable",
                false,
            ),
            (
                CommandError::RegistrationTermsRequired,
                "registration_terms_required",
                false,
            ),
            (
                CommandError::RegistrationAdditionalAuthRequired,
                "registration_additional_auth_required",
                false,
            ),
            (
                CommandError::RegistrationInvitationRequired,
                "registration_invitation_required",
                false,
            ),
            (
                CommandError::RegistrationInvitationInvalid,
                "registration_invitation_invalid",
                false,
            ),
            (
                CommandError::RegistrationTimedOut,
                "registration_timed_out",
                true,
            ),
        ];

        for (error, expected_code, retryable) in cases {
            let serialized = serde_json::to_value(error).unwrap();
            assert_eq!(serialized["code"], expected_code);
            assert_eq!(serialized["retryable"], retryable);
        }
    }

    #[test]
    fn command_error_details_redact_secrets_and_local_paths() {
        for (source, forbidden) in [
            (
                "failed C:\\Users\\person\\session.json access_token=private",
                ["person", "private"].as_slice(),
            ),
            (
                "request failed Authorization: Bearer sentinel-header-token",
                ["sentinel-header-token"].as_slice(),
            ),
            (
                "login failed password sentinel-password-value",
                ["sentinel-password-value"].as_slice(),
            ),
            (
                "request failed Authorization:Bearer sentinel-compact-token",
                ["sentinel-compact-token"].as_slice(),
            ),
        ] {
            let serialized = serde_json::to_value(CommandError::Other(source.to_owned())).unwrap();
            let detail = serialized["detail"].as_str().unwrap();

            for secret in forbidden {
                assert!(!detail.contains(secret));
            }
            assert!(detail.contains("[redacted]"));
        }

        let path = serde_json::to_value(CommandError::Other(
            "failed C:\\Users\\person\\session.json".to_owned(),
        ))
        .unwrap();
        assert!(path["detail"].as_str().unwrap().contains("[redacted path]"));
    }
}
