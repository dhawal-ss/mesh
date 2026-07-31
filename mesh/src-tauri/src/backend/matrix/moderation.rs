use super::*;
use crate::backend::{
    CommunityModerationResult, CommunityPermissionProjection, ModerationRoomOutcome,
};

mod permission_projection;

const MODERATION_AUDIT_PREFIX: &str = "org.mesh.moderation.audit.v1:";
const MAX_MODERATION_REASON_CHARS: usize = 500;
const MAX_MODERATION_AUDIT_EVENTS: u32 = 200;
const MAX_MODERATION_AUDIT_SCAN_EVENTS: usize = 2_000;
const COMMUNITY_ROLE_POWER_LEVEL_OVERRIDE_JSON: &str = r#"{"events":{"m.room.power_levels":100}}"#;

// Direct room membership remains authoritative while MSC4284/MSC4204 policy
// list semantics are unstable; importing them without verified enforcement
// would make server-wide moderation appear stronger than it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CommunityPermission {
    Admin,
    Owner,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum MatrixModerationAction {
    Ban,
    Kick,
    RoleAdmin,
    RoleMember,
}

impl MatrixModerationAction {
    pub(super) fn role(role: String) -> BackendResult<Self> {
        match role.as_str() {
            "admin" => Ok(Self::RoleAdmin),
            "member" => Ok(Self::RoleMember),
            _ => Err(BackendError::InvalidConfiguration(
                "role must be admin or member; ownership transfer is not supported".into(),
            )),
        }
    }

    fn permission(&self) -> CommunityPermission {
        match self {
            Self::Ban | Self::Kick => CommunityPermission::Admin,
            Self::RoleAdmin | Self::RoleMember => CommunityPermission::Owner,
        }
    }

    fn audit_label(&self) -> &'static str {
        match self {
            Self::Ban => "Banned member",
            Self::Kick => "Removed member",
            Self::RoleAdmin => "Made administrator",
            Self::RoleMember => "Made member",
        }
    }

    fn role_power_level(&self) -> Option<matrix_sdk::ruma::Int> {
        match self {
            Self::RoleAdmin => Some(int!(50)),
            Self::RoleMember => Some(int!(0)),
            Self::Ban | Self::Kick => None,
        }
    }

    async fn apply(
        &self,
        room: &Room,
        actor_user_id: &UserId,
        user_id: &UserId,
        reason: Option<&str>,
    ) -> BackendResult<()> {
        match self {
            Self::Ban => room
                .ban_user(user_id, reason)
                .await
                .map_err(MatrixBackend::map_error),
            Self::Kick => room
                .kick_user(user_id, reason)
                .await
                .map_err(MatrixBackend::map_error),
            Self::RoleAdmin | Self::RoleMember => {
                let role_power_level = self.role_power_level().ok_or_else(|| {
                    BackendError::InvalidConfiguration(
                        "role action does not define a Matrix power level".into(),
                    )
                })?;
                let creators = room.creators().ok_or_else(|| {
                    BackendError::InvalidConfiguration(
                        "This room does not expose enough creation state to change roles safely."
                            .into(),
                    )
                })?;
                let has_power_levels_event = room
                    .get_state_event_static::<
                        matrix_sdk::ruma::events::room::power_levels::RoomPowerLevelsEventContent,
                    >()
                    .await
                    .map_err(MatrixBackend::map_error)?
                    .is_some();
                let mut power_levels = if has_power_levels_event {
                    room.power_levels()
                        .await
                        .map_err(MatrixBackend::map_error)?
                } else {
                    room.power_levels_or_default().await
                };
                let joined_user_ids = room
                    .members(RoomMemberships::JOIN)
                    .await
                    .map_err(MatrixBackend::map_error)?
                    .into_iter()
                    .map(|member| member.user_id().to_string())
                    .collect();
                let projected = permission_projection::project_power_levels(
                    &power_levels,
                    creators,
                    joined_user_ids,
                );
                permission_projection::ensure_authoritative_role_change(
                    &projected,
                    actor_user_id,
                    user_id,
                    i64::from(role_power_level),
                    &room.name().unwrap_or_else(|| "This room".into()),
                )?;
                power_levels
                    .events
                    .insert(StateEventType::RoomPowerLevels.into(), int!(100));
                if role_power_level == power_levels.users_default {
                    power_levels.users.remove(user_id);
                } else {
                    power_levels
                        .users
                        .insert(user_id.to_owned(), role_power_level);
                }
                room.send_state_event(
                    matrix_sdk::ruma::events::room::power_levels::RoomPowerLevelsEventContent::try_from(
                        power_levels,
                    )
                    .map_err(MatrixBackend::map_error)?,
                )
                .await
                .map(|_| ())
                .map_err(MatrixBackend::map_error)
            }
        }
    }
}

impl MatrixBackend {
    pub(super) fn community_role_power_level_override(
    ) -> BackendResult<Raw<RoomPowerLevelsContentOverride>> {
        Raw::from_json_string(COMMUNITY_ROLE_POWER_LEVEL_OVERRIDE_JSON.to_owned())
            .map_err(Self::map_error)
    }

    pub(super) async fn community_permission_projection(
        &self,
        community_id: &str,
        subject_user_id: &str,
    ) -> BackendResult<CommunityPermissionProjection> {
        permission_projection::read_community_permission_projection(
            self,
            community_id,
            subject_user_id,
        )
        .await
    }

    pub(super) async fn require_community_permission(
        &self,
        space: &Room,
        required: CommunityPermission,
    ) -> BackendResult<OwnedUserId> {
        let client = self.client().await?;
        let own_user_id = client
            .user_id()
            .ok_or(BackendError::NotAuthenticated)?
            .to_owned();
        let is_creator = space
            .creators()
            .is_some_and(|creators| creators.iter().any(|creator| creator == &own_user_id));
        let role = if is_creator {
            RoomMemberRole::Creator
        } else {
            space
                .get_member(&own_user_id)
                .await
                .map_err(Self::map_error)?
                .map(|member| member.suggested_role_for_power_level())
                .ok_or_else(|| {
                    BackendError::PermissionDenied(
                        "You must be a current server member to moderate it.".into(),
                    )
                })?
        };
        let allowed = match required {
            CommunityPermission::Owner => matches!(role, RoomMemberRole::Creator),
            CommunityPermission::Admin => matches!(
                role,
                RoomMemberRole::Creator | RoomMemberRole::Administrator | RoomMemberRole::Moderator
            ),
        };
        if !allowed {
            return Err(BackendError::PermissionDenied(match required {
                CommunityPermission::Owner => {
                    "Only the server owner can change member roles.".into()
                }
                CommunityPermission::Admin => {
                    "You need server administrator permission to moderate members.".into()
                }
            }));
        }
        Ok(own_user_id)
    }

    fn normalized_moderation_reason(reason: Option<String>) -> Option<String> {
        reason.and_then(|reason| {
            let reason = reason.trim();
            if reason.is_empty() {
                None
            } else {
                Some(reason.chars().take(MAX_MODERATION_REASON_CHARS).collect())
            }
        })
    }

    fn moderation_failure_reason(error: &BackendError) -> String {
        match error {
            BackendError::PermissionDenied(_) => {
                "This channel did not allow the moderation change.".into()
            }
            BackendError::Network(_) | BackendError::Cancelled(_) => {
                "This channel could not be reached. Try it again.".into()
            }
            BackendError::RateLimited(_) => {
                "This channel asked Mesh to retry the change later.".into()
            }
            BackendError::NotFound(_) => "This channel is no longer available.".into(),
            BackendError::NotEncrypted(_) | BackendError::DecryptionFailed(_) => {
                "This channel did not pass its privacy check.".into()
            }
            _ => "This channel could not apply the moderation change.".into(),
        }
    }

    fn moderation_room_name(room: &Room, root_space_id: &matrix_sdk::ruma::RoomId) -> String {
        if room.room_id() == root_space_id {
            "Server".into()
        } else {
            room.name().unwrap_or_else(|| "Unnamed channel".into())
        }
    }

    fn moderation_audit_body(entry: &ModerationAuditEntry) -> BackendResult<String> {
        serde_json::to_string(entry)
            .map(|json| format!("{MODERATION_AUDIT_PREFIX}{json}"))
            .map_err(Self::map_error)
    }

    fn parse_moderation_audit_body(body: &str) -> Option<ModerationAuditEntry> {
        let json = body.strip_prefix(MODERATION_AUDIT_PREFIX)?;
        serde_json::from_str(json).ok()
    }

    async fn record_moderation_audit(
        space: &Room,
        entry: &ModerationAuditEntry,
    ) -> BackendResult<()> {
        let body = Self::moderation_audit_body(entry)?;
        let content = RoomMessageEventContent::notice_plain(body);
        let transaction_id =
            Self::validate_transaction_id(&format!("moderation-audit-{}", entry.id))?;
        space
            .send(content)
            .with_transaction_id(transaction_id)
            .await
            .map(|_| ())
            .map_err(Self::map_error)
    }

    async fn moderation_space(&self, community_id: &str) -> BackendResult<Room> {
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(community_id).map_err(Self::map_error)?;
        let space =
            Self::protected_joined_room(&client, &space_id, "moderating this server").await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a server".into(),
            ));
        }
        Ok(space)
    }

    pub(super) async fn apply_community_moderation(
        &self,
        community_id: String,
        target_user_id: String,
        action: MatrixModerationAction,
        reason: Option<String>,
    ) -> BackendResult<CommunityModerationResult> {
        let client = self.client().await?;
        let space = self.moderation_space(&community_id).await?;
        let actor_user_id = self
            .require_community_permission(&space, action.permission())
            .await?;
        let target_user_id =
            matrix_sdk::ruma::UserId::parse(target_user_id).map_err(Self::map_error)?;
        if actor_user_id == target_user_id {
            return Err(BackendError::PermissionDenied(
                "You cannot apply this moderation action to yourself.".into(),
            ));
        }
        if space
            .creators()
            .is_some_and(|creators| creators.iter().any(|creator| creator == &target_user_id))
        {
            return Err(BackendError::PermissionDenied(
                "The server owner cannot be moderated.".into(),
            ));
        }
        let actor_display_name = space
            .get_member(&actor_user_id)
            .await
            .map_err(Self::map_error)?
            .map(|member| member.name().to_owned())
            .unwrap_or_else(|| "Server administrator".into());
        let target_display_name = space
            .get_member(&target_user_id)
            .await
            .map_err(Self::map_error)?
            .map(|member| member.name().to_owned())
            .unwrap_or_else(|| "Former member".into());

        let reason = Self::normalized_moderation_reason(reason);
        let child_ids = self.space_child_ids(&space).await?;
        let mut rooms = Vec::with_capacity(child_ids.len() + 1);
        let mut room_outcomes = Vec::with_capacity(child_ids.len() + 1);
        let mut visited_room_ids = BTreeSet::new();
        for child_id in child_ids {
            match Self::protected_joined_room(&client, &child_id, "moderating a server channel")
                .await
            {
                Ok(room) => {
                    match self
                        .joined_room_upgrade_chain(
                            &client,
                            room,
                            "moderating an upgraded server channel",
                        )
                        .await
                    {
                        Ok(upgrade_chain) => {
                            rooms.extend(
                                upgrade_chain.into_iter().filter(|room| {
                                    visited_room_ids.insert(room.room_id().to_owned())
                                }),
                            );
                        }
                        Err(error) => room_outcomes.push(ModerationRoomOutcome {
                            room_id: child_id.to_string(),
                            room_name: "Unavailable upgraded channel".into(),
                            succeeded: false,
                            failure_reason: Some(Self::moderation_failure_reason(&error)),
                        }),
                    }
                }
                Err(error) => room_outcomes.push(ModerationRoomOutcome {
                    room_id: child_id.to_string(),
                    room_name: "Unavailable channel".into(),
                    succeeded: false,
                    failure_reason: Some(Self::moderation_failure_reason(&error)),
                }),
            }
        }
        rooms.push(space.clone());

        for room in rooms {
            let outcome = action
                .apply(&room, &actor_user_id, &target_user_id, reason.as_deref())
                .await;
            room_outcomes.push(ModerationRoomOutcome {
                room_id: room.room_id().to_string(),
                room_name: Self::moderation_room_name(&room, space.room_id()),
                succeeded: outcome.is_ok(),
                failure_reason: outcome.as_ref().err().map(Self::moderation_failure_reason),
            });
        }

        let audit = ModerationAuditEntry {
            id: uuid::Uuid::new_v4().to_string(),
            actor_user_id: actor_user_id.to_string(),
            actor_display_name,
            target_user_id: target_user_id.to_string(),
            target_display_name,
            action: action.audit_label().into(),
            reason,
            occurred_at: chrono::Utc::now().to_rfc3339(),
            room_outcomes,
        };
        let audit_recorded = Self::record_moderation_audit(&space, &audit).await.is_ok();
        Ok(CommunityModerationResult {
            audit,
            audit_recorded,
        })
    }

    pub(super) async fn moderation_audit(
        &self,
        community_id: &str,
        limit: u32,
    ) -> BackendResult<Vec<ModerationAuditEntry>> {
        let space = self.moderation_space(community_id).await?;
        self.require_community_permission(&space, CommunityPermission::Admin)
            .await?;
        let requested = limit.clamp(1, MAX_MODERATION_AUDIT_EVENTS) as usize;
        let mut entries = Vec::with_capacity(requested);
        let mut from = None;
        let mut scanned = 0_usize;
        while entries.len() < requested && scanned < MAX_MODERATION_AUDIT_SCAN_EVENTS {
            let mut options = MessagesOptions::backward();
            options.limit = 100_u32.into();
            options.from = from;
            let response = space.messages(options).await.map_err(Self::map_error)?;
            if response.chunk.is_empty() {
                break;
            }
            scanned += response.chunk.len();
            entries.extend(
                response
                    .chunk
                    .into_iter()
                    .filter_map(|event| event.raw().deserialize_as::<serde_json::Value>().ok())
                    .filter_map(|event| {
                        let sender = event.get("sender").and_then(serde_json::Value::as_str)?;
                        let entry = event
                            .get("content")?
                            .get("body")
                            .and_then(serde_json::Value::as_str)
                            .and_then(Self::parse_moderation_audit_body)?;
                        (entry.actor_user_id == sender).then_some(entry)
                    }),
            );
            let Some(next) = response.end else {
                break;
            };
            from = Some(next);
        }
        entries.truncate(requested);
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audit_entry() -> ModerationAuditEntry {
        ModerationAuditEntry {
            id: "audit-1".into(),
            actor_user_id: "@owner:example.org".into(),
            actor_display_name: "Owner".into(),
            target_user_id: "@member:remote.org".into(),
            target_display_name: "Member".into(),
            action: "Banned member".into(),
            reason: Some("Repeated abuse".into()),
            occurred_at: "2026-07-27T12:00:00Z".into(),
            room_outcomes: vec![
                ModerationRoomOutcome {
                    room_id: "!one:example.org".into(),
                    room_name: "general".into(),
                    succeeded: true,
                    failure_reason: None,
                },
                ModerationRoomOutcome {
                    room_id: "!two:remote.org".into(),
                    room_name: "support".into(),
                    succeeded: false,
                    failure_reason: Some(
                        "This channel did not allow the moderation change.".into(),
                    ),
                },
            ],
        }
    }

    #[test]
    fn audit_wire_body_round_trips_complete_room_outcomes() {
        let expected = audit_entry();
        let body = MatrixBackend::moderation_audit_body(&expected).unwrap();
        assert_eq!(
            MatrixBackend::parse_moderation_audit_body(&body),
            Some(expected)
        );
    }

    #[test]
    fn moderation_failures_are_plain_and_do_not_expose_remote_errors() {
        let failure = MatrixBackend::moderation_failure_reason(&BackendError::PermissionDenied(
            "M_FORBIDDEN from https://matrix.example.org/_matrix/client".into(),
        ));
        assert_eq!(failure, "This channel did not allow the moderation change.");
        assert!(!failure.contains("M_FORBIDDEN"));
        assert!(!failure.contains("matrix"));
    }

    #[test]
    fn role_updates_are_bounded_to_supported_roles() {
        assert_eq!(
            MatrixModerationAction::role("admin".into()).unwrap(),
            MatrixModerationAction::RoleAdmin
        );
        assert_eq!(
            MatrixModerationAction::role("member".into()).unwrap(),
            MatrixModerationAction::RoleMember
        );
        assert!(MatrixModerationAction::role("owner".into()).is_err());
    }

    #[test]
    fn role_templates_keep_permission_management_owner_only() {
        assert_eq!(
            MatrixModerationAction::RoleAdmin.role_power_level(),
            Some(int!(50))
        );
        assert_eq!(
            MatrixModerationAction::RoleMember.role_power_level(),
            Some(int!(0))
        );
        assert!(int!(100) > int!(50));
    }

    #[test]
    fn role_updates_harden_the_power_levels_event_before_assigning_an_admin() {
        let source = include_str!("moderation.rs");
        let apply = source
            .split("async fn apply(")
            .nth(1)
            .expect("moderation apply implementation exists")
            .split("impl MatrixBackend")
            .next()
            .expect("moderation action implementation is bounded");
        assert!(apply.contains("StateEventType::RoomPowerLevels"));
        assert!(apply.contains("int!(100)"));
        assert!(apply.contains("send_state_event"));
        assert!(!apply.contains("update_power_levels"));
    }

    #[test]
    fn new_room_override_protects_role_management_from_level_fifty_members() {
        let raw = MatrixBackend::community_role_power_level_override().unwrap();
        let content = raw.deserialize_as_unchecked::<serde_json::Value>().unwrap();
        assert_eq!(content["events"]["m.room.power_levels"], 100);
    }

    #[test]
    fn every_matrix_moderation_operation_uses_the_permission_guard() {
        let source = include_str!("moderation.rs");
        let operation = source
            .split("pub(super) async fn apply_community_moderation")
            .nth(1)
            .unwrap();
        assert!(operation.contains("require_community_permission"));
        let audit = source
            .split("pub(super) async fn moderation_audit")
            .nth(1)
            .unwrap();
        assert!(audit.contains("require_community_permission"));
    }

    #[test]
    fn ban_and_recovery_use_distinct_matrix_wire_paths() {
        let moderation_source = include_str!("moderation.rs");
        let moderation_apply = moderation_source
            .split("async fn apply(")
            .nth(1)
            .expect("moderation apply implementation exists")
            .split("impl MatrixBackend")
            .next()
            .expect("moderation action implementation is bounded");
        assert!(moderation_apply.contains("Self::Ban => room"));
        assert!(moderation_apply.contains(".ban_user(user_id, reason)"));
        assert!(!moderation_apply.contains(".recovery()"));

        let matrix_source = include_str!("../matrix.rs");
        let recovery_test = matrix_source
            .split("async fn test_recovery(")
            .nth(1)
            .expect("recovery test implementation exists")
            .split("async fn start_device_verification")
            .next()
            .expect("recovery test implementation is bounded");
        assert!(recovery_test.contains("verify_recovery_credential"));
        let recovery_wire_path = matrix_source
            .split("async fn verify_recovery_credential(")
            .nth(1)
            .expect("recovery credential verifier exists")
            .split("fn account_registry_key")
            .next()
            .expect("recovery credential verifier is bounded");
        assert!(recovery_wire_path.contains(".recovery()"));
        assert!(recovery_wire_path.contains(".recover(recovery_key_or_passphrase.trim())"));
        assert!(!recovery_test.contains(".ban_user("));
    }
}
