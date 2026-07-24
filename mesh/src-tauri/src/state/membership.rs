use std::collections::HashMap;
use std::sync::RwLock;

use crate::storage::db::MemberRow;
use crate::storage::Database;

#[derive(Default)]
pub struct MembershipState {
    communities: RwLock<HashMap<String, HashMap<String, MemberRow>>>,
}

impl MembershipState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load_community(&self, db: &Database, community_id: &str) -> Result<(), String> {
        let members = db
            .get_all_member_rows(community_id)
            .map_err(|error| error.to_string())?;
        let mut communities = self
            .communities
            .write()
            .map_err(|error| format!("membership write lock: {error}"))?;
        let roster = communities.entry(community_id.to_string()).or_default();
        roster.clear();
        for member in members {
            roster.insert(member.public_key.clone(), member);
        }
        Ok(())
    }

    pub fn add_member(&self, community_id: &str, member: MemberRow) -> Result<(), String> {
        let mut communities = self
            .communities
            .write()
            .map_err(|error| format!("membership write lock: {error}"))?;
        communities
            .entry(community_id.to_string())
            .or_default()
            .insert(member.public_key.clone(), member);
        Ok(())
    }

    pub fn remove_member(&self, community_id: &str, public_key: &str) -> Result<(), String> {
        let mut communities = self
            .communities
            .write()
            .map_err(|error| format!("membership write lock: {error}"))?;
        if let Some(member) = communities
            .entry(community_id.to_string())
            .or_default()
            .get_mut(public_key)
        {
            member.join_status = "left".into();
        }
        Ok(())
    }

    pub fn clear_community(&self, community_id: &str) -> Result<(), String> {
        let mut communities = self
            .communities
            .write()
            .map_err(|error| format!("membership write lock: {error}"))?;
        communities.remove(community_id);
        Ok(())
    }

    pub fn update_role(
        &self,
        community_id: &str,
        public_key: &str,
        role: &str,
    ) -> Result<(), String> {
        let mut communities = self
            .communities
            .write()
            .map_err(|error| format!("membership write lock: {error}"))?;
        if let Some(member) = communities
            .entry(community_id.to_string())
            .or_default()
            .get_mut(public_key)
        {
            member.role = role.to_string();
        }
        Ok(())
    }

    pub fn ban_member(&self, community_id: &str, public_key: &str) -> Result<(), String> {
        let mut communities = self
            .communities
            .write()
            .map_err(|error| format!("membership write lock: {error}"))?;
        if let Some(member) = communities
            .entry(community_id.to_string())
            .or_default()
            .get_mut(public_key)
        {
            member.join_status = "left".into();
            member.ban_status = "banned".into();
        }
        Ok(())
    }

    pub fn touch_member(
        &self,
        community_id: &str,
        public_key: &str,
        last_seen: String,
    ) -> Result<(), String> {
        let mut communities = self
            .communities
            .write()
            .map_err(|error| format!("membership write lock: {error}"))?;
        if let Some(member) = communities
            .entry(community_id.to_string())
            .or_default()
            .get_mut(public_key)
        {
            member.last_seen = Some(last_seen);
        }
        Ok(())
    }

    pub fn get_roster(&self, community_id: &str) -> Result<Vec<MemberRow>, String> {
        let communities = self
            .communities
            .read()
            .map_err(|error| format!("membership read lock: {error}"))?;
        let mut members = communities
            .get(community_id)
            .map(|roster| {
                roster
                    .values()
                    .filter(|member| member.join_status == "joined" && member.ban_status == "none")
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        members.sort_by(|left, right| {
            left.role
                .cmp(&right.role)
                .then_with(|| left.display_name.cmp(&right.display_name))
        });
        Ok(members)
    }

    #[allow(dead_code)]
    pub fn member_count(&self, community_id: &str) -> Result<usize, String> {
        let communities = self
            .communities
            .read()
            .map_err(|error| format!("membership read lock: {error}"))?;
        Ok(communities
            .get(community_id)
            .map(|roster| {
                roster
                    .values()
                    .filter(|member| member.join_status == "joined" && member.ban_status == "none")
                    .count()
            })
            .unwrap_or(0))
    }

    /// Check if a user is an active member. Returns `Some(true/false)` if
    /// the community roster is loaded, or `None` if no roster exists yet.
    pub fn is_active_member(
        &self,
        community_id: &str,
        public_key: &str,
    ) -> Result<Option<bool>, String> {
        let communities = self
            .communities
            .read()
            .map_err(|error| format!("membership read lock: {error}"))?;
        match communities.get(community_id) {
            Some(roster) => Ok(Some(
                roster
                    .get(public_key)
                    .map(|member| member.join_status == "joined" && member.ban_status == "none")
                    .unwrap_or(false),
            )),
            None => Ok(None),
        }
    }

    #[allow(dead_code)]
    pub fn is_member(&self, community_id: &str, public_key: &str) -> Result<bool, String> {
        let communities = self
            .communities
            .read()
            .map_err(|error| format!("membership read lock: {error}"))?;
        Ok(communities
            .get(community_id)
            .and_then(|roster| roster.get(public_key))
            .map(|member| member.join_status == "joined" && member.ban_status == "none")
            .unwrap_or(false))
    }

    pub fn has_permission(
        &self,
        community_id: &str,
        public_key: &str,
        required_role: &str,
    ) -> Result<bool, String> {
        let communities = self
            .communities
            .read()
            .map_err(|error| format!("membership read lock: {error}"))?;
        let Some(member) = communities
            .get(community_id)
            .and_then(|roster| roster.get(public_key))
        else {
            return Ok(false);
        };

        let member_rank = role_rank(&member.role);
        let required_rank = role_rank(required_role);
        Ok(member.join_status == "joined"
            && member.ban_status == "none"
            && member_rank >= required_rank)
    }
}

fn role_rank(role: &str) -> u8 {
    match role {
        "owner" => 3,
        "admin" => 2,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(public_key: &str, role: &str) -> MemberRow {
        MemberRow {
            public_key: public_key.into(),
            display_name: public_key.into(),
            avatar_color: "#c8b89a".into(),
            role: role.into(),
            join_status: "joined".into(),
            ban_status: "none".into(),
            x25519_public_key: None,
            last_seen: None,
        }
    }

    #[test]
    fn member_count_ignores_left_and_banned_entries() {
        let state = MembershipState::new();
        let community_id = "community-a";
        let _ = state.add_member(community_id, member("owner", "owner"));
        let _ = state.add_member(community_id, member("member", "member"));
        let _ = state.remove_member(community_id, "member");
        let _ = state.add_member(community_id, member("banned", "member"));
        let _ = state.ban_member(community_id, "banned");

        assert_eq!(state.member_count(community_id).unwrap(), 1);
    }

    #[test]
    fn permission_checks_follow_role_hierarchy() {
        let state = MembershipState::new();
        let community_id = "community-b";
        let _ = state.add_member(community_id, member("owner", "owner"));
        let _ = state.add_member(community_id, member("admin", "admin"));
        let _ = state.add_member(community_id, member("member", "member"));

        assert!(state
            .has_permission(community_id, "owner", "admin")
            .unwrap());
        assert!(state
            .has_permission(community_id, "admin", "member")
            .unwrap());
        assert!(!state
            .has_permission(community_id, "member", "admin")
            .unwrap());
    }

    #[test]
    fn banning_member_revokes_membership() {
        let state = MembershipState::new();
        let community_id = "community-c";
        let _ = state.add_member(community_id, member("member", "member"));

        assert!(state.is_member(community_id, "member").unwrap());
        let _ = state.ban_member(community_id, "member");
        assert!(!state.is_member(community_id, "member").unwrap());
    }

    #[test]
    fn update_role_changes_permissions_correctly() {
        let state = MembershipState::new();
        let community_id = "community-role";
        let _ = state.add_member(community_id, member("alice", "member"));

        // alice as member cannot perform admin actions
        assert!(!state
            .has_permission(community_id, "alice", "admin")
            .unwrap());

        // Promote alice to admin
        let _ = state.update_role(community_id, "alice", "admin");
        assert!(state
            .has_permission(community_id, "alice", "admin")
            .unwrap());
        assert!(state
            .has_permission(community_id, "alice", "member")
            .unwrap());

        // Promote alice to owner
        let _ = state.update_role(community_id, "alice", "owner");
        assert!(state
            .has_permission(community_id, "alice", "owner")
            .unwrap());
        assert!(state
            .has_permission(community_id, "alice", "admin")
            .unwrap());

        // Demote alice back to member
        let _ = state.update_role(community_id, "alice", "member");
        assert!(!state
            .has_permission(community_id, "alice", "admin")
            .unwrap());
        assert!(state
            .has_permission(community_id, "alice", "member")
            .unwrap());
    }

    #[test]
    fn touch_member_updates_last_seen() {
        let state = MembershipState::new();
        let community_id = "community-touch";
        let _ = state.add_member(community_id, member("bob", "member"));

        // Initially last_seen is None
        let roster = state.get_roster(community_id).unwrap();
        let bob = roster.iter().find(|m| m.public_key == "bob").unwrap();
        assert!(bob.last_seen.is_none());

        // Touch with a timestamp
        let _ = state.touch_member(community_id, "bob", "2024-06-15T12:00:00Z".to_string());

        let roster = state.get_roster(community_id).unwrap();
        let bob = roster.iter().find(|m| m.public_key == "bob").unwrap();
        assert_eq!(bob.last_seen.as_deref(), Some("2024-06-15T12:00:00Z"));

        // Touch again with a later timestamp
        let _ = state.touch_member(community_id, "bob", "2024-06-15T13:00:00Z".to_string());
        let roster = state.get_roster(community_id).unwrap();
        let bob = roster.iter().find(|m| m.public_key == "bob").unwrap();
        assert_eq!(bob.last_seen.as_deref(), Some("2024-06-15T13:00:00Z"));
    }

    #[test]
    fn clear_community_removes_all_members() {
        let state = MembershipState::new();
        let community_id = "community-clear";
        let _ = state.add_member(community_id, member("alice", "owner"));
        let _ = state.add_member(community_id, member("bob", "admin"));
        let _ = state.add_member(community_id, member("charlie", "member"));

        assert_eq!(state.member_count(community_id).unwrap(), 3);

        let _ = state.clear_community(community_id);

        assert_eq!(state.member_count(community_id).unwrap(), 0);
        let roster = state.get_roster(community_id).unwrap();
        assert!(roster.is_empty());
    }

    #[test]
    fn get_roster_returns_only_joined_non_banned_members() {
        let state = MembershipState::new();
        let community_id = "community-roster";

        // Add various members
        let _ = state.add_member(community_id, member("alice", "owner"));
        let _ = state.add_member(community_id, member("bob", "admin"));
        let _ = state.add_member(community_id, member("charlie", "member"));
        let _ = state.add_member(community_id, member("dave", "member"));
        let _ = state.add_member(community_id, member("eve", "member"));

        // Remove dave (sets join_status to "left")
        let _ = state.remove_member(community_id, "dave");
        // Ban eve
        let _ = state.ban_member(community_id, "eve");

        let roster = state.get_roster(community_id).unwrap();
        let keys: Vec<&str> = roster.iter().map(|m| m.public_key.as_str()).collect();

        // dave and eve should not appear
        assert!(!keys.contains(&"dave"));
        assert!(!keys.contains(&"eve"));
        // alice, bob, charlie should appear
        assert!(keys.contains(&"alice"));
        assert!(keys.contains(&"bob"));
        assert!(keys.contains(&"charlie"));
        assert_eq!(roster.len(), 3);
    }

    #[test]
    fn get_roster_sorted_by_role_then_display_name() {
        let state = MembershipState::new();
        let community_id = "community-sort";

        // Add members with specific display_names to test sorting
        let _ = state.add_member(
            community_id,
            MemberRow {
                public_key: "zara".into(),
                display_name: "Zara".into(),
                avatar_color: "#000000".into(),
                role: "admin".into(),
                join_status: "joined".into(),
                ban_status: "none".into(),
                x25519_public_key: None,
                last_seen: None,
            },
        );
        let _ = state.add_member(
            community_id,
            MemberRow {
                public_key: "alice".into(),
                display_name: "Alice".into(),
                avatar_color: "#000000".into(),
                role: "admin".into(),
                join_status: "joined".into(),
                ban_status: "none".into(),
                x25519_public_key: None,
                last_seen: None,
            },
        );
        let _ = state.add_member(
            community_id,
            MemberRow {
                public_key: "bob".into(),
                display_name: "Bob".into(),
                avatar_color: "#000000".into(),
                role: "owner".into(),
                join_status: "joined".into(),
                ban_status: "none".into(),
                x25519_public_key: None,
                last_seen: None,
            },
        );
        let _ = state.add_member(
            community_id,
            MemberRow {
                public_key: "charlie".into(),
                display_name: "Charlie".into(),
                avatar_color: "#000000".into(),
                role: "member".into(),
                join_status: "joined".into(),
                ban_status: "none".into(),
                x25519_public_key: None,
                last_seen: None,
            },
        );

        let roster = state.get_roster(community_id).unwrap();
        let names: Vec<&str> = roster.iter().map(|m| m.display_name.as_str()).collect();

        // Sorted by role (alphabetical: "admin" < "member" < "owner") then by display_name
        // role order: "admin" → "member" → "owner"
        assert_eq!(names, vec!["Alice", "Zara", "Charlie", "Bob"]);
    }
}
