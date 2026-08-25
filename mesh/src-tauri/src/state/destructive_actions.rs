use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Deserialize;

const GRANT_TTL: Duration = Duration::from_secs(60);
const MAX_LIVE_GRANTS: usize = 16;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DestructiveAction {
    RemoveLocalAccount,
    RevokeDevice,
    DeactivateAccount,
}

impl DestructiveAction {
    pub fn dialog_copy(self, target: &str) -> (&'static str, String, &'static str) {
        match self {
            Self::RemoveLocalAccount => (
                "Remove this account from Mesh?",
                "Mesh will sign this device out and permanently delete this account's local Mesh data. The account and shared messages remain at its service."
                    .to_owned(),
                "Remove local data",
            ),
            Self::RevokeDevice => (
                "Sign out this device?",
                format!(
                    "Mesh will ask your account service to sign out device {target}. You will confirm your account password next."
                ),
                "Continue",
            ),
            Self::DeactivateAccount => (
                "Permanently delete this account?",
                "Mesh will ask your account service to disable the account and erase its data where possible. Shared copies may remain. You will confirm your account password next."
                    .to_owned(),
                "Continue",
            ),
        }
    }

    pub fn validate_target(self, target: Option<String>) -> Result<String, GrantError> {
        match self {
            Self::RemoveLocalAccount | Self::DeactivateAccount => {
                if target.is_some() {
                    return Err(GrantError::ScopeMismatch);
                }
                Ok(String::new())
            }
            Self::RevokeDevice => {
                let target = target.ok_or(GrantError::ScopeMismatch)?;
                let trimmed = target.trim();
                if trimmed.is_empty()
                    || trimmed.chars().count() > 256
                    || trimmed.chars().any(char::is_control)
                {
                    return Err(GrantError::ScopeMismatch);
                }
                Ok(trimmed.to_owned())
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DestructiveActionScope {
    account_id: String,
    action: DestructiveAction,
    target: String,
}

impl DestructiveActionScope {
    pub fn new(account_id: String, action: DestructiveAction, target: String) -> Self {
        Self {
            account_id,
            action,
            target,
        }
    }
}

#[derive(Clone, Debug)]
struct Grant {
    scope: DestructiveActionScope,
    expires_at: Instant,
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum GrantError {
    #[error("the confirmation is missing, expired, or for a different action")]
    InvalidGrant,
    #[error("the destructive action target is invalid")]
    ScopeMismatch,
    #[error("too many destructive actions are awaiting confirmation")]
    Capacity,
    #[error("the native confirmation service is unavailable")]
    Unavailable,
}

#[derive(Default)]
pub struct DestructiveActionGrantStore {
    grants: Mutex<HashMap<String, Grant>>,
}

impl DestructiveActionGrantStore {
    pub fn issue(&self, scope: DestructiveActionScope) -> Result<String, GrantError> {
        self.issue_at(scope, Instant::now())
    }

    fn issue_at(&self, scope: DestructiveActionScope, now: Instant) -> Result<String, GrantError> {
        let mut grants = self.grants.lock().map_err(|_| GrantError::Unavailable)?;
        grants.retain(|_, grant| grant.expires_at > now);
        if grants.len() >= MAX_LIVE_GRANTS {
            return Err(GrantError::Capacity);
        }

        let token = uuid::Uuid::new_v4().to_string();
        grants.insert(
            token.clone(),
            Grant {
                scope,
                expires_at: now + GRANT_TTL,
            },
        );
        Ok(token)
    }

    pub fn consume(
        &self,
        token: &str,
        expected_scope: &DestructiveActionScope,
    ) -> Result<(), GrantError> {
        self.consume_at(token, expected_scope, Instant::now())
    }

    fn consume_at(
        &self,
        token: &str,
        expected_scope: &DestructiveActionScope,
        now: Instant,
    ) -> Result<(), GrantError> {
        let mut grants = self.grants.lock().map_err(|_| GrantError::Unavailable)?;
        let Some(grant) = grants.remove(token) else {
            return Err(GrantError::InvalidGrant);
        };
        if grant.expires_at <= now || &grant.scope != expected_scope {
            return Err(GrantError::InvalidGrant);
        }
        Ok(())
    }

    pub fn clear(&self) -> Result<(), GrantError> {
        self.grants
            .lock()
            .map_err(|_| GrantError::Unavailable)?
            .clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(action: DestructiveAction, target: &str) -> DestructiveActionScope {
        DestructiveActionScope::new("@alice:example.org".to_owned(), action, target.to_owned())
    }

    #[test]
    fn grants_are_one_use_and_bound_to_the_exact_action_scope() {
        let store = DestructiveActionGrantStore::default();
        let expected = scope(DestructiveAction::RevokeDevice, "DEVICE-A");
        let token = store.issue(expected.clone()).expect("grant should issue");

        assert_eq!(store.consume(&token, &expected), Ok(()));
        assert_eq!(
            store.consume(&token, &expected),
            Err(GrantError::InvalidGrant)
        );
    }

    #[test]
    fn mismatched_use_consumes_the_grant_and_fails_closed() {
        let store = DestructiveActionGrantStore::default();
        let expected = scope(DestructiveAction::RevokeDevice, "DEVICE-A");
        let token = store.issue(expected.clone()).expect("grant should issue");
        let wrong = scope(DestructiveAction::RevokeDevice, "DEVICE-B");

        assert_eq!(store.consume(&token, &wrong), Err(GrantError::InvalidGrant));
        assert_eq!(
            store.consume(&token, &expected),
            Err(GrantError::InvalidGrant)
        );
    }

    #[test]
    fn expired_grants_fail_closed() {
        let store = DestructiveActionGrantStore::default();
        let expected = scope(DestructiveAction::DeactivateAccount, "");
        let issued_at = Instant::now();
        let token = store
            .issue_at(expected.clone(), issued_at)
            .expect("grant should issue");

        assert_eq!(
            store.consume_at(&token, &expected, issued_at + GRANT_TTL),
            Err(GrantError::InvalidGrant)
        );
    }

    #[test]
    fn action_targets_are_strictly_validated() {
        assert_eq!(
            DestructiveAction::RemoveLocalAccount.validate_target(Some("unexpected".to_owned())),
            Err(GrantError::ScopeMismatch)
        );
        assert_eq!(
            DestructiveAction::RevokeDevice.validate_target(Some("\n".to_owned())),
            Err(GrantError::ScopeMismatch)
        );
        assert_eq!(
            DestructiveAction::RevokeDevice.validate_target(Some(" DEVICE-A ".to_owned())),
            Ok("DEVICE-A".to_owned())
        );
    }
}
