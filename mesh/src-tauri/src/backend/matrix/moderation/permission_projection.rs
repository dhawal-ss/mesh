use super::*;
use crate::backend::{
    CommunityPermissionAggregate, CommunityPermissionAggregateStatus, CommunityPermissionId,
    CommunityPermissionProjection, MatrixPermissionRoomStatus, MatrixRoomPermissionProjection,
    MatrixRoomPowerLevelProjection,
};
use matrix_sdk::ruma::events::room::power_levels::{
    RoomPowerLevels, RoomPowerLevelsEventContent, UserPowerLevel,
};

const MAX_PERMISSION_PROJECTION_ROOMS: usize = 2_048;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum EffectivePowerLevel {
    Finite(i64),
    Infinite,
}

pub(super) async fn read_community_permission_projection(
    backend: &MatrixBackend,
    community_id: &str,
    subject_user_id: &str,
) -> BackendResult<CommunityPermissionProjection> {
    let subject_user_id =
        matrix_sdk::ruma::UserId::parse(subject_user_id).map_err(MatrixBackend::map_error)?;
    let client = backend.client().await?;
    let root_space = backend.moderation_space(community_id).await?;
    let mut pending = VecDeque::from([root_space]);
    let mut visited = BTreeSet::new();
    let mut rooms = Vec::new();
    let mut discovery_complete = true;
    let mut discovery_failure_reason = None;

    while let Some(room) = pending.pop_front() {
        if rooms.len() >= MAX_PERMISSION_PROJECTION_ROOMS {
            discovery_complete = false;
            discovery_failure_reason = Some(
                "This community is too large to verify every room in one permission check.".into(),
            );
            break;
        }
        if !visited.insert(room.room_id().to_owned()) {
            continue;
        }

        if room.is_space() {
            match backend.space_child_ids(&room).await {
                Ok(child_ids) => {
                    for child_id in child_ids {
                        if visited.contains(&child_id) {
                            continue;
                        }
                        match client.get_room(&child_id) {
                            Some(child) if child.state() == RoomState::Joined => {
                                pending.push_back(child);
                            }
                            Some(child) => {
                                visited.insert(child_id.clone());
                                rooms.push(inaccessible_room(
                                    &child_id,
                                    child.name(),
                                    child.is_space(),
                                ));
                            }
                            None => {
                                visited.insert(child_id.clone());
                                rooms.push(inaccessible_room(&child_id, None, false));
                            }
                        }
                    }
                }
                Err(_) => {
                    discovery_complete = false;
                    discovery_failure_reason.get_or_insert_with(|| {
                        "Mesh could not list every connected room. Retry after synchronization."
                            .into()
                    });
                }
            }
        }

        rooms.push(read_room_projection(&room).await);
    }

    let aggregate = aggregate_permissions(&rooms, discovery_complete, subject_user_id.as_str());
    Ok(CommunityPermissionProjection {
        community_id: community_id.into(),
        subject_user_id: subject_user_id.to_string(),
        discovery_complete,
        discovery_failure_reason,
        rooms,
        aggregate,
    })
}

async fn read_room_projection(room: &Room) -> MatrixRoomPermissionProjection {
    let room_id = room.room_id().to_string();
    let room_name = room.name().unwrap_or_else(|| {
        if room.is_space() {
            "Unnamed community section".into()
        } else {
            "Unnamed room".into()
        }
    });
    let room_kind = if room.is_space() { "space" } else { "room" }.into();

    let event = match room
        .get_state_event_static::<RoomPowerLevelsEventContent>()
        .await
    {
        Ok(event) => event,
        Err(_) => {
            return MatrixRoomPermissionProjection {
                room_id,
                room_name,
                room_kind,
                status: MatrixPermissionRoomStatus::Failed,
                policy: None,
                failure_reason: Some(
                    "Current permission state could not be read. Retry after synchronization."
                        .into(),
                ),
            };
        }
    };
    let Some(creators) = room.creators() else {
        return MatrixRoomPermissionProjection {
            room_id,
            room_name,
            room_kind,
            status: MatrixPermissionRoomStatus::Unsupported,
            policy: None,
            failure_reason: Some(
                "This room does not expose enough creation state to verify permissions.".into(),
            ),
        };
    };
    let joined_user_ids = match room.members(RoomMemberships::JOIN).await {
        Ok(members) => members
            .into_iter()
            .map(|member| member.user_id().to_string())
            .collect(),
        Err(_) => {
            return MatrixRoomPermissionProjection {
                room_id,
                room_name,
                room_kind,
                status: MatrixPermissionRoomStatus::Failed,
                policy: None,
                failure_reason: Some(
                    "Current membership could not be read, so owner recovery cannot be verified."
                        .into(),
                ),
            };
        }
    };
    let (status, power_levels) = if event.is_some() {
        match room.power_levels().await {
            Ok(power_levels) => (MatrixPermissionRoomStatus::Loaded, power_levels),
            Err(_) => {
                return MatrixRoomPermissionProjection {
                    room_id,
                    room_name,
                    room_kind,
                    status: MatrixPermissionRoomStatus::Unsupported,
                    policy: None,
                    failure_reason: Some(
                        "This room's permission event could not be interpreted safely.".into(),
                    ),
                };
            }
        }
    } else {
        (
            MatrixPermissionRoomStatus::MatrixDefault,
            room.power_levels_or_default().await,
        )
    };

    MatrixRoomPermissionProjection {
        room_id,
        room_name,
        room_kind,
        status,
        policy: Some(project_power_levels(
            &power_levels,
            creators,
            joined_user_ids,
        )),
        failure_reason: None,
    }
}

fn inaccessible_room(
    room_id: &RoomId,
    room_name: Option<String>,
    is_space: bool,
) -> MatrixRoomPermissionProjection {
    MatrixRoomPermissionProjection {
        room_id: room_id.to_string(),
        room_name: room_name.unwrap_or_else(|| "Unavailable connected room".into()),
        room_kind: if is_space { "space" } else { "room" }.into(),
        status: MatrixPermissionRoomStatus::Inaccessible,
        policy: None,
        failure_reason: Some(
            "This account has not joined the connected room, so its permissions are unknown."
                .into(),
        ),
    }
}

pub(super) fn project_power_levels(
    power_levels: &RoomPowerLevels,
    creators: Vec<OwnedUserId>,
    joined_user_ids: Vec<String>,
) -> MatrixRoomPowerLevelProjection {
    let creator_user_ids = creators.iter().map(ToString::to_string).collect::<Vec<_>>();
    let privileged_creator_user_ids = creators
        .iter()
        .filter(|creator| matches!(power_levels.for_user(creator), UserPowerLevel::Infinite))
        .map(ToString::to_string)
        .collect();
    MatrixRoomPowerLevelProjection {
        users: power_levels
            .users
            .iter()
            .map(|(user_id, level)| (user_id.to_string(), i64::from(*level)))
            .collect(),
        users_default: i64::from(power_levels.users_default),
        events: power_levels
            .events
            .iter()
            .map(|(event_type, level)| (event_type.to_string(), i64::from(*level)))
            .collect(),
        events_default: i64::from(power_levels.events_default),
        state_default: i64::from(power_levels.state_default),
        ban: i64::from(power_levels.ban),
        kick: i64::from(power_levels.kick),
        invite: i64::from(power_levels.invite),
        redact: i64::from(power_levels.redact),
        notifications: BTreeMap::from([(
            "room".into(),
            i64::from(power_levels.notifications.room),
        )]),
        creator_user_ids,
        privileged_creator_user_ids,
        joined_user_ids,
    }
}

pub(super) fn aggregate_permissions(
    rooms: &[MatrixRoomPermissionProjection],
    discovery_complete: bool,
    subject_user_id: &str,
) -> Vec<CommunityPermissionAggregate> {
    let verified_rooms = rooms
        .iter()
        .filter_map(|room| match (room.status, room.policy.as_ref()) {
            (
                MatrixPermissionRoomStatus::Loaded | MatrixPermissionRoomStatus::MatrixDefault,
                Some(policy),
            ) => Some(policy),
            _ => None,
        })
        .collect::<Vec<_>>();
    let has_unknown = !discovery_complete || verified_rooms.len() != rooms.len();

    [
        CommunityPermissionId::Participate,
        CommunityPermissionId::Invite,
        CommunityPermissionId::Redact,
        CommunityPermissionId::Remove,
        CommunityPermissionId::Ban,
        CommunityPermissionId::RoomState,
        CommunityPermissionId::Roles,
    ]
    .into_iter()
    .map(|permission_id| {
        let granted_room_count = verified_rooms
            .iter()
            .filter(|policy| {
                effective_user_level(policy, subject_user_id)
                    >= EffectivePowerLevel::Finite(permission_threshold(policy, permission_id))
            })
            .count();
        let status = if has_unknown {
            CommunityPermissionAggregateStatus::Unknown
        } else if !verified_rooms.is_empty() && granted_room_count == verified_rooms.len() {
            CommunityPermissionAggregateStatus::GrantedEverywhere
        } else if granted_room_count > 0 {
            CommunityPermissionAggregateStatus::GrantedSomeRooms
        } else {
            CommunityPermissionAggregateStatus::NotGranted
        };
        CommunityPermissionAggregate {
            permission_id,
            status,
            granted_room_count,
            verified_room_count: verified_rooms.len(),
            total_room_count: rooms.len(),
        }
    })
    .collect()
}

pub(super) fn ensure_authoritative_role_change(
    policy: &MatrixRoomPowerLevelProjection,
    actor_user_id: &UserId,
    target_user_id: &UserId,
    next_level: i64,
    room_name: &str,
) -> BackendResult<()> {
    let actor_level = effective_user_level(policy, actor_user_id.as_str());
    let target_level = effective_user_level(policy, target_user_id.as_str());
    let role_threshold = permission_threshold(policy, CommunityPermissionId::Roles);

    if actor_level < EffectivePowerLevel::Finite(role_threshold) {
        return Err(BackendError::PermissionDenied(
            "Your account cannot manage roles in every community room.".into(),
        ));
    }
    if matches!(target_level, EffectivePowerLevel::Infinite) {
        return Err(BackendError::PermissionDenied(
            "A protected room creator cannot be assigned a lower role.".into(),
        ));
    }
    if actor_level != EffectivePowerLevel::Infinite && target_level >= actor_level {
        return Err(BackendError::PermissionDenied(
            "You cannot change the role of a member with equal or greater authority.".into(),
        ));
    }
    if actor_level != EffectivePowerLevel::Infinite
        && EffectivePowerLevel::Finite(next_level) >= actor_level
    {
        return Err(BackendError::PermissionDenied(
            "A role change cannot grant authority equal to or above your own.".into(),
        ));
    }

    let mut resulting_policy = policy.clone();
    resulting_policy
        .events
        .insert("m.room.power_levels".into(), 100);
    if next_level == resulting_policy.users_default {
        resulting_policy.users.remove(target_user_id.as_str());
    } else {
        resulting_policy
            .users
            .insert(target_user_id.to_string(), next_level);
    }
    let resulting_role_threshold =
        permission_threshold(&resulting_policy, CommunityPermissionId::Roles);
    let recovery_path_exists = resulting_policy.joined_user_ids.iter().any(|user_id| {
        effective_user_level(&resulting_policy, user_id)
            >= EffectivePowerLevel::Finite(resulting_role_threshold)
    });
    if !recovery_path_exists {
        return Err(BackendError::PermissionDenied(format!(
            "{room_name} would have no effective owner or recovery path."
        )));
    }
    Ok(())
}

fn effective_user_level(
    policy: &MatrixRoomPowerLevelProjection,
    user_id: &str,
) -> EffectivePowerLevel {
    if policy
        .privileged_creator_user_ids
        .iter()
        .any(|creator| creator == user_id)
    {
        EffectivePowerLevel::Infinite
    } else {
        EffectivePowerLevel::Finite(
            policy
                .users
                .get(user_id)
                .copied()
                .unwrap_or(policy.users_default),
        )
    }
}

fn permission_threshold(
    policy: &MatrixRoomPowerLevelProjection,
    permission_id: CommunityPermissionId,
) -> i64 {
    match permission_id {
        CommunityPermissionId::Participate => policy
            .events
            .get("m.room.message")
            .copied()
            .unwrap_or(policy.events_default),
        CommunityPermissionId::Invite => policy.invite,
        CommunityPermissionId::Redact => policy.redact.max(
            policy
                .events
                .get("m.room.redaction")
                .copied()
                .unwrap_or(policy.events_default),
        ),
        CommunityPermissionId::Remove => policy.kick,
        CommunityPermissionId::Ban => policy.ban,
        CommunityPermissionId::RoomState => policy.state_default,
        CommunityPermissionId::Roles => policy
            .events
            .get("m.room.power_levels")
            .copied()
            .unwrap_or(policy.state_default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregates_divergent_and_federated_room_thresholds() {
        let rooms = vec![
            loaded_room("!space:example.org", 50),
            loaded_room("!support:remote.org", 75),
        ];
        let aggregate = aggregate_permissions(&rooms, true, "@admin:example.org");

        assert_eq!(
            status(&aggregate, CommunityPermissionId::Ban),
            CommunityPermissionAggregateStatus::GrantedEverywhere
        );
        assert_eq!(
            status(&aggregate, CommunityPermissionId::Roles),
            CommunityPermissionAggregateStatus::GrantedSomeRooms
        );
    }

    #[test]
    fn missing_inaccessible_and_partial_discovery_are_unknown() {
        let mut rooms = vec![loaded_room("!space:example.org", 100)];
        rooms.push(MatrixRoomPermissionProjection {
            room_id: "!private:remote.org".into(),
            room_name: "Private support".into(),
            room_kind: "room".into(),
            status: MatrixPermissionRoomStatus::Inaccessible,
            policy: None,
            failure_reason: Some("Permission state unavailable.".into()),
        });
        assert!(aggregate_permissions(&rooms, true, "@owner:example.org")
            .iter()
            .all(|permission| permission.status == CommunityPermissionAggregateStatus::Unknown));
        assert!(
            aggregate_permissions(&rooms[..1], false, "@owner:example.org")
                .iter()
                .all(|permission| permission.status == CommunityPermissionAggregateStatus::Unknown)
        );
    }

    #[test]
    fn manual_remote_edits_and_restart_round_trip_deterministically() {
        let mut rooms = vec![loaded_room("!space:example.org", 50)];
        assert_eq!(
            status(
                &aggregate_permissions(&rooms, true, "@admin:example.org"),
                CommunityPermissionId::Roles,
            ),
            CommunityPermissionAggregateStatus::GrantedEverywhere
        );
        rooms[0]
            .policy
            .as_mut()
            .unwrap()
            .events
            .insert("m.room.power_levels".into(), 100);
        let serialized = serde_json::to_string(&rooms).unwrap();
        let after_restart: Vec<MatrixRoomPermissionProjection> =
            serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            aggregate_permissions(&rooms, true, "@admin:example.org"),
            aggregate_permissions(&after_restart, true, "@admin:example.org")
        );
        assert_eq!(
            status(
                &aggregate_permissions(&after_restart, true, "@admin:example.org"),
                CommunityPermissionId::Roles,
            ),
            CommunityPermissionAggregateStatus::NotGranted
        );
    }

    #[test]
    fn protects_privileged_creators_last_owner_and_escalation() {
        let actor = matrix_sdk::ruma::user_id!("@owner:example.org");
        let target = matrix_sdk::ruma::user_id!("@backup:example.org");
        let mut policy = loaded_room("!space:example.org", 100).policy.unwrap();
        policy.privileged_creator_user_ids.push(target.to_string());
        assert!(ensure_authoritative_role_change(&policy, actor, target, 0, "Community").is_err());

        policy.privileged_creator_user_ids.clear();
        policy.users.insert(target.to_string(), 100);
        policy.users.insert(actor.to_string(), 50);
        assert!(ensure_authoritative_role_change(&policy, actor, target, 50, "Community").is_err());

        policy.users.insert(actor.to_string(), 0);
        policy.users.insert(target.to_string(), 100);
        policy
            .privileged_creator_user_ids
            .push("@creator:example.org".into());
        policy.joined_user_ids = vec![target.to_string()];
        assert!(ensure_authoritative_role_change(
            &policy,
            matrix_sdk::ruma::user_id!("@creator:example.org"),
            target,
            0,
            "Community"
        )
        .is_err());
    }

    fn status(
        aggregate: &[CommunityPermissionAggregate],
        permission_id: CommunityPermissionId,
    ) -> CommunityPermissionAggregateStatus {
        aggregate
            .iter()
            .find(|permission| permission.permission_id == permission_id)
            .unwrap()
            .status
    }

    fn loaded_room(room_id: &str, power_levels_threshold: i64) -> MatrixRoomPermissionProjection {
        MatrixRoomPermissionProjection {
            room_id: room_id.into(),
            room_name: room_id.into(),
            room_kind: if room_id.contains("space") {
                "space"
            } else {
                "room"
            }
            .into(),
            status: MatrixPermissionRoomStatus::Loaded,
            failure_reason: None,
            policy: Some(MatrixRoomPowerLevelProjection {
                users: BTreeMap::from([
                    ("@owner:example.org".into(), 100),
                    ("@admin:example.org".into(), 50),
                    ("@backup:example.org".into(), 100),
                ]),
                users_default: 0,
                events: BTreeMap::from([("m.room.power_levels".into(), power_levels_threshold)]),
                events_default: 0,
                state_default: 50,
                ban: 50,
                kick: 50,
                invite: 0,
                redact: 50,
                notifications: BTreeMap::from([("room".into(), 50)]),
                creator_user_ids: vec!["@owner:example.org".into()],
                privileged_creator_user_ids: Vec::new(),
                joined_user_ids: vec![
                    "@owner:example.org".into(),
                    "@admin:example.org".into(),
                    "@backup:example.org".into(),
                ],
            }),
        }
    }
}
