use std::{collections::BTreeMap, fmt};

use serde::Deserialize;
use url::Url;

pub(in crate::backend::matrix) const NATIVE_REDIRECT_URI: &str =
    "http://127.0.0.1:8418/oauth/callback";
pub(in crate::backend::matrix) const REGISTRATIONS_BUILD_ENV: &str =
    "MESH_OAUTH_CLIENT_REGISTRATIONS_JSON";

const CONFIG_VERSION: u8 = 1;
const MAX_CONFIG_BYTES: usize = 64 * 1024;
const MAX_REGISTRATIONS: usize = 32;
const MAX_ISSUER_BYTES: usize = 2_048;
const MAX_CLIENT_ID_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::backend::matrix) struct OidcClientRegistration {
    issuer: String,
    client_id: String,
}

impl OidcClientRegistration {
    #[cfg(test)]
    fn issuer(&self) -> &str {
        &self.issuer
    }

    pub(in crate::backend::matrix) fn client_id(&self) -> &str {
        &self.client_id
    }

    pub(in crate::backend::matrix) fn redirect_uri(&self) -> &'static str {
        NATIVE_REDIRECT_URI
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::backend::matrix) struct OidcClientRegistry {
    registrations: BTreeMap<String, OidcClientRegistration>,
}

impl OidcClientRegistry {
    pub(in crate::backend::matrix) fn from_embedded_build_configuration(
    ) -> Result<Self, OidcRegistrationError> {
        let document = option_env!("MESH_OAUTH_CLIENT_REGISTRATIONS_JSON")
            .ok_or(OidcRegistrationError::MissingConfiguration)?;
        Self::parse(document)
    }

    pub(in crate::backend::matrix) fn parse(document: &str) -> Result<Self, OidcRegistrationError> {
        if document.is_empty() || document.len() > MAX_CONFIG_BYTES {
            return Err(OidcRegistrationError::InvalidSchema);
        }

        let document: RegistrationDocument =
            serde_json::from_str(document).map_err(|_| OidcRegistrationError::InvalidSchema)?;
        if document.version != CONFIG_VERSION
            || document.registrations.is_empty()
            || document.registrations.len() > MAX_REGISTRATIONS
        {
            return Err(OidcRegistrationError::InvalidSchema);
        }

        let mut registrations = BTreeMap::new();
        for (index, candidate) in document.registrations.into_iter().enumerate() {
            let issuer = canonical_issuer(&candidate.issuer)
                .map_err(|_| OidcRegistrationError::InvalidIssuer { index })?;
            let client_id = validate_client_id(&candidate.client_id)
                .map_err(|_| OidcRegistrationError::InvalidClientId { index })?;
            if candidate.redirect_uri != NATIVE_REDIRECT_URI {
                return Err(OidcRegistrationError::RedirectMismatch { index });
            }

            let registration = OidcClientRegistration {
                issuer: issuer.clone(),
                client_id,
            };
            if registrations.insert(issuer, registration).is_some() {
                return Err(OidcRegistrationError::DuplicateIssuer { index });
            }
        }

        Ok(Self { registrations })
    }

    pub(in crate::backend::matrix) fn resolve(
        &self,
        discovered_issuer: &Url,
        capabilities: NativeOidcCapabilities,
    ) -> Result<&OidcClientRegistration, OidcRegistrationError> {
        let issuer = canonical_issuer(discovered_issuer.as_str())
            .map_err(|_| OidcRegistrationError::InvalidDiscoveredIssuer)?;
        capabilities.require_all(&issuer)?;
        self.registrations
            .get(&issuer)
            .ok_or(OidcRegistrationError::MissingIssuerRegistration { issuer })
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.registrations.len()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::backend::matrix) struct NativeOidcCapabilities {
    pub(in crate::backend::matrix) code_response: bool,
    pub(in crate::backend::matrix) query_response_mode: bool,
    pub(in crate::backend::matrix) authorization_code_grant: bool,
    pub(in crate::backend::matrix) refresh_token_grant: bool,
    pub(in crate::backend::matrix) s256_pkce: bool,
}

impl NativeOidcCapabilities {
    pub(in crate::backend::matrix) fn require_all(
        self,
        issuer: &str,
    ) -> Result<(), OidcRegistrationError> {
        for (supported, capability) in [
            (self.code_response, NativeOidcCapability::CodeResponse),
            (
                self.query_response_mode,
                NativeOidcCapability::QueryResponseMode,
            ),
            (
                self.authorization_code_grant,
                NativeOidcCapability::AuthorizationCodeGrant,
            ),
            (
                self.refresh_token_grant,
                NativeOidcCapability::RefreshTokenGrant,
            ),
            (self.s256_pkce, NativeOidcCapability::S256Pkce),
        ] {
            if !supported {
                return Err(OidcRegistrationError::UnsupportedCapability {
                    issuer: issuer.to_owned(),
                    capability,
                });
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::backend::matrix) enum NativeOidcCapability {
    CodeResponse,
    QueryResponseMode,
    AuthorizationCodeGrant,
    RefreshTokenGrant,
    S256Pkce,
}

impl fmt::Display for NativeOidcCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::CodeResponse => "authorization-code response type",
            Self::QueryResponseMode => "query response mode",
            Self::AuthorizationCodeGrant => "authorization_code grant",
            Self::RefreshTokenGrant => "refresh_token grant",
            Self::S256Pkce => "S256 PKCE",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(in crate::backend::matrix) enum OidcRegistrationError {
    #[error(
        "Browser sign-in has no embedded provider registrations. Configure the non-secret {REGISTRATIONS_BUILD_ENV} build input"
    )]
    MissingConfiguration,
    #[error("Browser sign-in provider registration has an invalid schema")]
    InvalidSchema,
    #[error("Browser sign-in provider registration {index} has an invalid canonical issuer")]
    InvalidIssuer { index: usize },
    #[error("Browser sign-in provider registration {index} has an invalid public client ID")]
    InvalidClientId { index: usize },
    #[error(
        "Browser sign-in provider registration {index} must use {NATIVE_REDIRECT_URI} exactly"
    )]
    RedirectMismatch { index: usize },
    #[error("Browser sign-in provider registration {index} duplicates an issuer")]
    DuplicateIssuer { index: usize },
    #[error("Browser sign-in discovery returned an invalid canonical issuer")]
    InvalidDiscoveredIssuer,
    #[error(
        "Browser sign-in is unavailable because Mesh has no desktop client registration for issuer {issuer}"
    )]
    MissingIssuerRegistration { issuer: String },
    #[error(
        "Browser sign-in is unavailable because issuer {issuer} does not advertise required {capability}"
    )]
    UnsupportedCapability {
        issuer: String,
        capability: NativeOidcCapability,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationDocument {
    version: u8,
    registrations: Vec<RegistrationCandidate>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationCandidate {
    issuer: String,
    client_id: String,
    redirect_uri: String,
}

fn canonical_issuer(value: &str) -> Result<String, ()> {
    if value.is_empty()
        || value.len() > MAX_ISSUER_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(());
    }
    let issuer = Url::parse(value).map_err(|_| ())?;
    if issuer.scheme() != "https"
        || issuer.cannot_be_a_base()
        || issuer.host_str().is_none()
        || !issuer.username().is_empty()
        || issuer.password().is_some()
        || issuer.query().is_some()
        || issuer.fragment().is_some()
        || issuer.as_str() != value
    {
        return Err(());
    }
    Ok(issuer.to_string())
}

fn validate_client_id(value: &str) -> Result<String, ()> {
    if value.is_empty()
        || value.len() > MAX_CLIENT_ID_BYTES
        || !value.bytes().all(|byte| matches!(byte, 0x21..=0x7e))
    {
        return Err(());
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMPLETE_CAPABILITIES: NativeOidcCapabilities = NativeOidcCapabilities {
        code_response: true,
        query_response_mode: true,
        authorization_code_grant: true,
        refresh_token_grant: true,
        s256_pkce: true,
    };

    fn registry_document(registrations: &str) -> String {
        format!(r#"{{"version":1,"registrations":[{registrations}]}}"#)
    }

    fn registration(issuer: &str, client_id: &str) -> String {
        format!(
            r#"{{"issuer":"{issuer}","clientId":"{client_id}","redirectUri":"{NATIVE_REDIRECT_URI}"}}"#
        )
    }

    #[test]
    fn two_issuers_resolve_only_their_own_public_client_ids() {
        let issuer_a = "https://login.provider-a.example/";
        let issuer_b = "https://login.provider-b.example/tenant";
        let registry = OidcClientRegistry::parse(&registry_document(&format!(
            "{},{}",
            registration(issuer_a, "mesh-provider-a"),
            registration(issuer_b, "mesh-provider-b")
        )))
        .unwrap();

        let resolved_a = registry
            .resolve(&Url::parse(issuer_a).unwrap(), COMPLETE_CAPABILITIES)
            .unwrap();
        let resolved_b = registry
            .resolve(&Url::parse(issuer_b).unwrap(), COMPLETE_CAPABILITIES)
            .unwrap();
        assert_eq!(resolved_a.issuer(), issuer_a);
        assert_eq!(resolved_a.client_id(), "mesh-provider-a");
        assert_eq!(resolved_a.redirect_uri(), NATIVE_REDIRECT_URI);
        assert_eq!(resolved_b.issuer(), issuer_b);
        assert_eq!(resolved_b.client_id(), "mesh-provider-b");

        let missing = registry
            .resolve(
                &Url::parse("https://login.provider-c.example/").unwrap(),
                COMPLETE_CAPABILITIES,
            )
            .unwrap_err();
        assert!(matches!(
            missing,
            OidcRegistrationError::MissingIssuerRegistration { .. }
        ));
        assert!(!missing.to_string().contains("mesh-provider-a"));
        assert!(!missing.to_string().contains("mesh-provider-b"));
    }

    #[test]
    fn canonical_issuers_preserve_distinct_authorities_and_paths() {
        let registrations = [
            registration("https://login.example/", "mesh-default-port"),
            registration("https://login.example:8443/", "mesh-alt-port"),
            registration("https://login.example/tenant-a", "mesh-tenant-a"),
            registration("https://login.example/tenant-b", "mesh-tenant-b"),
        ]
        .join(",");
        let registry = OidcClientRegistry::parse(&registry_document(&registrations)).unwrap();
        assert_eq!(registry.len(), 4);

        for noncanonical in [
            "https://LOGIN.example/",
            "https://login.example:443/",
            " https://login.example/",
        ] {
            let document = registry_document(&registration(noncanonical, "mesh-noncanonical"));
            assert!(matches!(
                OidcClientRegistry::parse(&document),
                Err(OidcRegistrationError::InvalidIssuer { .. })
            ));
        }
    }

    #[test]
    fn invalid_duplicate_or_aliased_configuration_fails_closed() {
        let issuer = "https://login.example/";
        let duplicate = registry_document(&format!(
            "{},{}",
            registration(issuer, "mesh-one"),
            registration(issuer, "mesh-two")
        ));
        assert!(matches!(
            OidcClientRegistry::parse(&duplicate),
            Err(OidcRegistrationError::DuplicateIssuer { .. })
        ));

        for invalid in [
            r#"{"version":1,"registrations":[]}"#.to_owned(),
            registry_document(&registration("http://login.example/", "mesh-client")),
            registry_document(&registration(
                "https://login.example/?tenant=one",
                "mesh-client",
            )),
            registry_document(&registration(issuer, "bad client")),
            registry_document(&format!(
                r#"{{"issuer":"{issuer}","clientId":"mesh-client","redirectUri":"http://127.0.0.1:9999/oauth/callback"}}"#
            )),
            registry_document(&format!(
                r#"{{"issuer":"{issuer}","clientId":"mesh-client","redirectUri":"{NATIVE_REDIRECT_URI}","aliases":["https://alias.example/"]}}"#
            )),
        ] {
            assert!(OidcClientRegistry::parse(&invalid).is_err());
        }
    }

    #[test]
    fn every_native_capability_is_required_with_sanitized_diagnostics() {
        let issuer = "https://login.example/";
        let registry =
            OidcClientRegistry::parse(&registry_document(&registration(issuer, "mesh-client")))
                .unwrap();
        for missing in 0..5 {
            let mut values = [true; 5];
            values[missing] = false;
            let error = registry
                .resolve(
                    &Url::parse(issuer).unwrap(),
                    NativeOidcCapabilities {
                        code_response: values[0],
                        query_response_mode: values[1],
                        authorization_code_grant: values[2],
                        refresh_token_grant: values[3],
                        s256_pkce: values[4],
                    },
                )
                .unwrap_err();
            assert!(matches!(
                error,
                OidcRegistrationError::UnsupportedCapability { .. }
            ));
            let diagnostic = error.to_string();
            assert!(diagnostic.contains(issuer));
            assert!(!diagnostic.contains("mesh-client"));
        }
    }

    #[test]
    fn missing_embedded_configuration_never_borrows_the_legacy_global_client() {
        if option_env!("MESH_OAUTH_CLIENT_REGISTRATIONS_JSON").is_none() {
            assert_eq!(
                OidcClientRegistry::from_embedded_build_configuration(),
                Err(OidcRegistrationError::MissingConfiguration)
            );
        }
        assert_ne!(REGISTRATIONS_BUILD_ENV, "MESH_OAUTH_CLIENT_ID");
    }

    #[test]
    fn configured_release_registry_must_parse_before_ci_can_pass() {
        if option_env!("MESH_OAUTH_CLIENT_REGISTRATIONS_JSON").is_some() {
            let registry = OidcClientRegistry::from_embedded_build_configuration()
                .expect("configured release registry must be valid");
            assert!(registry.len() > 0);
        }
    }
}
