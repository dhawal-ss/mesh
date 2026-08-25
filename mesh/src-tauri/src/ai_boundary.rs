use std::collections::HashSet;

// @mesh-ai-module
// @mesh-ai-local-only
// @mesh-ai-feature-gate: disabled by security/ai-boundary.json
// @mesh-ai-resource-disclosure
// @mesh-ai-no-auto-download

use serde::Deserialize;

const EMBEDDED_AI_BOUNDARY: &str = include_str!("../../security/ai-boundary.json");

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum AiAuthorityAction {
    DraftSuggestion,
    NetworkRequest,
    SendMessage,
    CreateInvitation,
    RemoveMember,
    BanMember,
    ChangeRole,
    ModerateContent,
}

impl AiAuthorityAction {
    fn manifest_name(self) -> &'static str {
        match self {
            Self::DraftSuggestion => "draft-suggestion",
            Self::NetworkRequest => "network-request",
            Self::SendMessage => "send-message",
            Self::CreateInvitation => "create-invitation",
            Self::RemoveMember => "remove-member",
            Self::BanMember => "ban-member",
            Self::ChangeRole => "change-role",
            Self::ModerateContent => "moderate-content",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiBoundaryManifest {
    schema_version: u32,
    production_feature: String,
    network: AiNetworkBoundary,
    authority: AiAuthorityBoundary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiNetworkBoundary {
    allowed_packages: Vec<String>,
    allowed_hosts: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiAuthorityBoundary {
    allowed_actions: Vec<String>,
    forbidden_actions: Vec<String>,
}

fn validated_manifest() -> Result<AiBoundaryManifest, String> {
    let manifest: AiBoundaryManifest = serde_json::from_str(EMBEDDED_AI_BOUNDARY)
        .map_err(|error| format!("embedded AI boundary manifest is invalid: {error}"))?;
    if manifest.schema_version != 1 {
        return Err("embedded AI boundary schema version is unsupported".into());
    }
    if manifest.production_feature != "disabled" {
        return Err(
            "production AI must remain disabled until an owner-approved feature contract exists"
                .into(),
        );
    }
    if !manifest.network.allowed_packages.is_empty() || !manifest.network.allowed_hosts.is_empty() {
        return Err("production AI network access has not been approved".into());
    }
    let allowed = manifest
        .authority
        .allowed_actions
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if allowed != HashSet::from(["draft-suggestion"]) {
        return Err("AI authority may contain only draft-suggestion".into());
    }
    let required_forbidden = [
        AiAuthorityAction::NetworkRequest,
        AiAuthorityAction::SendMessage,
        AiAuthorityAction::CreateInvitation,
        AiAuthorityAction::RemoveMember,
        AiAuthorityAction::BanMember,
        AiAuthorityAction::ChangeRole,
        AiAuthorityAction::ModerateContent,
    ]
    .into_iter()
    .map(AiAuthorityAction::manifest_name)
    .collect::<HashSet<_>>();
    let forbidden = manifest
        .authority
        .forbidden_actions
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if forbidden != required_forbidden {
        return Err("AI authority manifest must explicitly deny every privileged action".into());
    }
    Ok(manifest)
}

/// Rejects a build whose embedded AI boundary manifest does not hold.
///
/// The manifest is compiled in, and until this existed nothing read it at run
/// time: `validated_manifest` was reachable only through `authorize_ai_action`,
/// which has no production caller. That inverted the model documented below --
/// CI became the authority and native authority the defense in depth. Calling
/// this during startup restores the stated order.
///
/// An error here means the binary was built from a tree whose boundary does not
/// hold. It is not a condition a user's machine can cause or recover from, so it
/// is fatal in every build rather than degraded in some.
pub fn enforce_boundary_manifest() -> Result<(), String> {
    validated_manifest().map(|_| ())
}

/// Native authority is the final decision point for any future AI-originated
/// action. Renderer markers and CI scanning are defense in depth, not grants.
pub fn authorize_ai_action(action: AiAuthorityAction) -> Result<(), String> {
    let manifest = validated_manifest()?;
    if manifest
        .authority
        .allowed_actions
        .iter()
        .any(|allowed| allowed == action.manifest_name())
    {
        Ok(())
    } else {
        Err(format!(
            "AI is not authorized to perform {}",
            action.manifest_name()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn security_boundary_startup_enforcement_accepts_the_embedded_manifest() {
        assert!(enforce_boundary_manifest().is_ok());
    }

    #[test]
    fn embedded_manifest_allows_drafts_and_denies_network_and_user_authority() {
        assert!(authorize_ai_action(AiAuthorityAction::DraftSuggestion).is_ok());
        for action in [
            AiAuthorityAction::NetworkRequest,
            AiAuthorityAction::SendMessage,
            AiAuthorityAction::CreateInvitation,
            AiAuthorityAction::RemoveMember,
            AiAuthorityAction::BanMember,
            AiAuthorityAction::ChangeRole,
            AiAuthorityAction::ModerateContent,
        ] {
            assert!(authorize_ai_action(action).is_err(), "{action:?}");
        }
    }
}
