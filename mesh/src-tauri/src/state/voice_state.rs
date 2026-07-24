use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use serde::Serialize;
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;

pub const VOICE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
pub const VOICE_MEMBER_TIMEOUT: Duration = Duration::from_secs(30);
pub const VOICE_RELAY_THRESHOLD: usize = 8;
pub const VOICE_SESSION_MAX_MEMBERS: usize = 16;

static HEARTBEAT_TASKS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VoiceSessionRef {
    pub community_id: String,
    pub channel_id: String,
}

impl VoiceSessionRef {
    pub fn new(community_id: &str, channel_id: &str) -> Self {
        Self {
            community_id: community_id.to_string(),
            channel_id: channel_id.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMemberSnapshot {
    pub public_key: String,
    pub joined_at: String,
    pub last_seen_at: String,
    pub is_local: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRelayElectionSnapshot {
    pub relay_required: bool,
    pub relay_candidate_public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSessionSnapshot {
    pub community_id: String,
    pub channel_id: String,
    pub session_epoch: u64,
    pub member_count: usize,
    pub members: Vec<VoiceMemberSnapshot>,
    pub relay: VoiceRelayElectionSnapshot,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSessionEvent {
    pub community_id: String,
    pub channel_id: String,
    pub event: String,
    pub source_public_key: String,
    pub snapshot: VoiceSessionSnapshot,
}

#[derive(Debug, Clone)]
struct VoiceMemberState {
    public_key: String,
    joined_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
    is_local: bool,
    display_name: Option<String>,
    avatar_color: Option<String>,
}

#[derive(Debug, Clone)]
struct VoiceSessionState {
    members: HashMap<String, VoiceMemberState>,
    session_epoch: u64,
    updated_at: DateTime<Utc>,
}

impl VoiceSessionState {
    fn new() -> Self {
        Self {
            members: HashMap::new(),
            session_epoch: 0,
            updated_at: Utc::now(),
        }
    }

    fn upsert_member(
        &mut self,
        public_key: &str,
        is_local: bool,
        display_name: Option<String>,
        avatar_color: Option<String>,
    ) -> Result<bool, String> {
        let now = Utc::now();
        let existed = self.members.contains_key(public_key);
        if !existed && self.members.len() >= VOICE_SESSION_MAX_MEMBERS {
            return Err(format!(
                "Voice session full (max {} members)",
                VOICE_SESSION_MAX_MEMBERS
            ));
        }

        let entry = self
            .members
            .entry(public_key.to_string())
            .or_insert_with(|| VoiceMemberState {
                public_key: public_key.to_string(),
                joined_at: now,
                last_seen_at: now,
                is_local,
                display_name: None,
                avatar_color: None,
            });

        let mut changed = !existed;
        if entry.last_seen_at != now {
            entry.last_seen_at = now;
            changed = true;
        }
        if is_local && !entry.is_local {
            entry.is_local = true;
            changed = true;
        }
        if let Some(display_name) = display_name.filter(|value| !value.trim().is_empty()) {
            if entry.display_name.as_deref() != Some(display_name.as_str()) {
                entry.display_name = Some(display_name);
                changed = true;
            }
        }
        if let Some(avatar_color) = avatar_color.filter(|value| !value.trim().is_empty()) {
            if entry.avatar_color.as_deref() != Some(avatar_color.as_str()) {
                entry.avatar_color = Some(avatar_color);
                changed = true;
            }
        }

        Ok(changed)
    }

    fn touch_existing_member(
        &mut self,
        public_key: &str,
        is_local: bool,
        display_name: Option<String>,
        avatar_color: Option<String>,
    ) -> bool {
        let Some(member) = self.members.get_mut(public_key) else {
            return false;
        };

        member.last_seen_at = Utc::now();
        if is_local {
            member.is_local = true;
        }
        if let Some(display_name) = display_name.filter(|value| !value.trim().is_empty()) {
            member.display_name = Some(display_name);
        }
        if let Some(avatar_color) = avatar_color.filter(|value| !value.trim().is_empty()) {
            member.avatar_color = Some(avatar_color);
        }
        true
    }

    fn remove_member(&mut self, public_key: &str) -> bool {
        self.members.remove(public_key).is_some()
    }

    fn sweep_expired(&mut self) -> bool {
        let now = Utc::now();
        let stale_before = now
            - chrono::Duration::from_std(VOICE_MEMBER_TIMEOUT)
                .unwrap_or_else(|_| chrono::Duration::seconds(30));
        let stale_members: Vec<String> = self
            .members
            .iter()
            .filter(|(_, member)| member.last_seen_at < stale_before)
            .map(|(public_key, _)| public_key.clone())
            .collect();

        let mut changed = false;
        for public_key in stale_members {
            if self.members.remove(&public_key).is_some() {
                changed = true;
            }
        }

        changed
    }

    fn recompute_epoch(&mut self, session: &VoiceSessionRef) {
        self.session_epoch = compute_session_epoch(session, &self.members);
        self.updated_at = Utc::now();
    }

    fn snapshot(&self, session: &VoiceSessionRef) -> VoiceSessionSnapshot {
        let mut members: Vec<_> = self.members.values().cloned().collect();
        members.sort_by(|a, b| a.public_key.cmp(&b.public_key));

        let relay_candidate_public_key = if members.len() > VOICE_RELAY_THRESHOLD {
            members.first().map(|member| member.public_key.clone())
        } else {
            None
        };

        VoiceSessionSnapshot {
            community_id: session.community_id.clone(),
            channel_id: session.channel_id.clone(),
            session_epoch: self.session_epoch,
            member_count: members.len(),
            members: members
                .into_iter()
                .map(|member| VoiceMemberSnapshot {
                    public_key: member.public_key,
                    joined_at: member.joined_at.to_rfc3339(),
                    last_seen_at: member.last_seen_at.to_rfc3339(),
                    is_local: member.is_local,
                    display_name: member.display_name,
                    avatar_color: member.avatar_color,
                })
                .collect(),
            relay: VoiceRelayElectionSnapshot {
                relay_required: self.members.len() > VOICE_RELAY_THRESHOLD,
                relay_candidate_public_key,
            },
            updated_at: self.updated_at.to_rfc3339(),
        }
    }
}

#[derive(Clone)]
pub struct VoiceState {
    sessions: Arc<RwLock<HashMap<VoiceSessionRef, VoiceSessionState>>>,
    heartbeat_tasks: Arc<Mutex<HashMap<VoiceSessionRef, JoinHandle<()>>>>,
    pub current_session: Arc<RwLock<Option<VoiceSessionRef>>>,
}

impl Default for VoiceState {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            heartbeat_tasks: Arc::new(Mutex::new(HashMap::new())),
            current_session: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn set_current_session(&self, session: Option<VoiceSessionRef>) {
        *self.current_session.write().await = session;
    }

    /// Return the number of active voice sessions. Used by the diagnostics command.
    pub async fn session_count(&self) -> u32 {
        self.sessions.read().await.len() as u32
    }

    pub async fn record_join(
        &self,
        community_id: &str,
        channel_id: &str,
        public_key: &str,
        is_local: bool,
        display_name: Option<String>,
        avatar_color: Option<String>,
    ) -> Result<VoiceSessionEvent, String> {
        let mut sessions = self.sessions.write().await;
        let session_ref = VoiceSessionRef::new(community_id, channel_id);
        let session = sessions
            .entry(session_ref.clone())
            .or_insert_with(VoiceSessionState::new);
        session.upsert_member(public_key, is_local, display_name, avatar_color)?;
        session.recompute_epoch(&session_ref);

        Ok(VoiceSessionEvent {
            community_id: community_id.to_string(),
            channel_id: channel_id.to_string(),
            event: "join".into(),
            source_public_key: public_key.to_string(),
            snapshot: session.snapshot(&session_ref),
        })
    }

    #[allow(dead_code)]
    pub async fn refresh_member(
        &self,
        community_id: &str,
        channel_id: &str,
        public_key: &str,
    ) -> Option<VoiceSessionEvent> {
        let mut sessions = self.sessions.write().await;
        let session_ref = VoiceSessionRef::new(community_id, channel_id);
        let session = sessions.get_mut(&session_ref)?;
        if !session.touch_existing_member(public_key, false, None, None) {
            return None;
        }
        session.recompute_epoch(&session_ref);

        Some(VoiceSessionEvent {
            community_id: community_id.to_string(),
            channel_id: channel_id.to_string(),
            event: "heartbeat".into(),
            source_public_key: public_key.to_string(),
            snapshot: session.snapshot(&session_ref),
        })
    }

    pub async fn record_heartbeat(
        &self,
        community_id: &str,
        channel_id: &str,
        public_key: &str,
        is_local: bool,
        display_name: Option<String>,
        avatar_color: Option<String>,
    ) -> Option<VoiceSessionEvent> {
        let mut sessions = self.sessions.write().await;
        let session_ref = VoiceSessionRef::new(community_id, channel_id);
        let session = sessions.get_mut(&session_ref)?;
        if !session.touch_existing_member(public_key, is_local, display_name, avatar_color) {
            return None;
        }
        session.recompute_epoch(&session_ref);

        Some(VoiceSessionEvent {
            community_id: community_id.to_string(),
            channel_id: channel_id.to_string(),
            event: "heartbeat".into(),
            source_public_key: public_key.to_string(),
            snapshot: session.snapshot(&session_ref),
        })
    }

    pub async fn record_leave(
        &self,
        community_id: &str,
        channel_id: &str,
        public_key: &str,
    ) -> Option<VoiceSessionEvent> {
        let mut sessions = self.sessions.write().await;
        let session_ref = VoiceSessionRef::new(community_id, channel_id);
        let session = sessions.get_mut(&session_ref)?;
        if !session.remove_member(public_key) {
            return Some(VoiceSessionEvent {
                community_id: community_id.to_string(),
                channel_id: channel_id.to_string(),
                event: "leave".into(),
                source_public_key: public_key.to_string(),
                snapshot: session.snapshot(&session_ref),
            });
        }

        session.recompute_epoch(&session_ref);
        let snapshot = session.snapshot(&session_ref);
        if session.members.is_empty() {
            sessions.remove(&session_ref);
        }

        Some(VoiceSessionEvent {
            community_id: community_id.to_string(),
            channel_id: channel_id.to_string(),
            event: "leave".into(),
            source_public_key: public_key.to_string(),
            snapshot,
        })
    }

    pub async fn sweep_expired(&self) -> Vec<VoiceSessionEvent> {
        let mut sessions = self.sessions.write().await;
        let session_refs: Vec<VoiceSessionRef> = sessions.keys().cloned().collect();
        let mut events = Vec::new();

        for session_ref in session_refs {
            let mut should_emit = false;
            if let Some(session) = sessions.get_mut(&session_ref) {
                if session.sweep_expired() {
                    session.recompute_epoch(&session_ref);
                    should_emit = true;
                }
            }

            if let Some(session) = sessions.get(&session_ref) {
                if session.members.is_empty() {
                    sessions.remove(&session_ref);
                    continue;
                }

                if should_emit {
                    events.push(VoiceSessionEvent {
                        community_id: session_ref.community_id.clone(),
                        channel_id: session_ref.channel_id.clone(),
                        event: "sweep".into(),
                        source_public_key: String::new(),
                        snapshot: session.snapshot(&session_ref),
                    });
                }
            }
        }

        events
    }

    #[allow(dead_code)]
    pub async fn snapshot(
        &self,
        community_id: &str,
        channel_id: &str,
    ) -> Option<VoiceSessionSnapshot> {
        let sessions = self.sessions.read().await;
        let session_ref = VoiceSessionRef::new(community_id, channel_id);
        sessions
            .get(&session_ref)
            .map(|session| session.snapshot(&session_ref))
    }

    pub async fn current_epoch(&self, community_id: &str, channel_id: &str) -> Option<u64> {
        let sessions = self.sessions.read().await;
        sessions
            .get(&VoiceSessionRef::new(community_id, channel_id))
            .map(|session| session.session_epoch)
    }

    pub async fn start_heartbeat_task(
        &self,
        community_id: String,
        channel_id: String,
        handle: JoinHandle<()>,
    ) {
        let _guard = HEARTBEAT_TASKS_LOCK.lock().await;
        let mut tasks = self.heartbeat_tasks.lock().await;
        let session_ref = VoiceSessionRef::new(&community_id, &channel_id);
        if let Some(existing) = tasks.insert(session_ref, handle) {
            existing.abort();
        }
    }

    pub async fn stop_heartbeat_task(&self, community_id: &str, channel_id: &str) {
        let _guard = HEARTBEAT_TASKS_LOCK.lock().await;
        let mut tasks = self.heartbeat_tasks.lock().await;
        if let Some(existing) = tasks.remove(&VoiceSessionRef::new(community_id, channel_id)) {
            existing.abort();
        }
    }
}

fn compute_session_epoch(
    session: &VoiceSessionRef,
    members: &HashMap<String, VoiceMemberState>,
) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    session.community_id.hash(&mut hasher);
    session.channel_id.hash(&mut hasher);

    let mut member_keys: Vec<&String> = members.keys().collect();
    member_keys.sort();
    for public_key in member_keys {
        public_key.hash(&mut hasher);
    }

    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn relay_candidate_is_deterministic() {
        let state = VoiceState::new();
        for idx in 0..9 {
            let public_key = format!("pk-{idx:02}");
            let _ = state
                .record_join("community-a", "chan", &public_key, false, None, None)
                .await
                .unwrap();
        }

        let snapshot = state.snapshot("community-a", "chan").await.unwrap();
        assert!(snapshot.relay.relay_required);
        assert_eq!(
            snapshot.relay.relay_candidate_public_key.as_deref(),
            Some("pk-00")
        );
    }

    #[tokio::test]
    async fn join_refuses_more_than_sixteen_members() {
        let state = VoiceState::new();
        for idx in 0..VOICE_SESSION_MAX_MEMBERS {
            let public_key = format!("pk-{idx:02}");
            let _ = state
                .record_join("community-a", "chan", &public_key, false, None, None)
                .await
                .unwrap();
        }

        let err = state
            .record_join("community-a", "chan", "pk-overflow", false, None, None)
            .await
            .unwrap_err();

        assert!(err.contains("Voice session full"));
    }

    #[tokio::test]
    async fn record_leave_removes_member_and_cleans_up_empty_session() {
        let state = VoiceState::new();

        // Add two members
        let _ = state
            .record_join("community-b", "chan-1", "pk-alice", false, None, None)
            .await
            .unwrap();
        let _ = state
            .record_join("community-b", "chan-1", "pk-bob", false, None, None)
            .await
            .unwrap();

        // Remove alice — session should still exist with bob
        let event = state
            .record_leave("community-b", "chan-1", "pk-alice")
            .await
            .unwrap();
        assert_eq!(event.event, "leave");
        assert_eq!(event.snapshot.member_count, 1);
        assert!(state.snapshot("community-b", "chan-1").await.is_some());

        // Remove bob — session should be cleaned up (empty)
        let event = state
            .record_leave("community-b", "chan-1", "pk-bob")
            .await
            .unwrap();
        assert_eq!(event.event, "leave");
        assert_eq!(event.snapshot.member_count, 0);
        // Session should be removed since it's empty
        assert!(state.snapshot("community-b", "chan-1").await.is_none());
    }

    #[tokio::test]
    async fn record_heartbeat_for_nonexistent_session_returns_none() {
        let state = VoiceState::new();

        // No session exists for this community/channel
        let result = state
            .record_heartbeat("no-community", "no-channel", "pk-ghost", false, None, None)
            .await;
        assert!(
            result.is_none(),
            "Heartbeat for a non-existent session must return None"
        );
    }

    #[tokio::test]
    async fn record_heartbeat_for_nonexistent_member_returns_none() {
        let state = VoiceState::new();

        // Create a session with one member
        let _ = state
            .record_join("community-c", "chan-2", "pk-alice", false, None, None)
            .await
            .unwrap();

        // Heartbeat for a member who never joined
        let result = state
            .record_heartbeat("community-c", "chan-2", "pk-unknown", false, None, None)
            .await;
        assert!(
            result.is_none(),
            "Heartbeat for a non-existent member must return None"
        );
    }

    #[tokio::test]
    async fn sweep_expired_removes_stale_members() {
        let state = VoiceState::new();

        // Add a member
        let _ = state
            .record_join("community-d", "chan-3", "pk-stale", false, None, None)
            .await
            .unwrap();

        // Manually set the member's last_seen_at to be in the past
        {
            let mut sessions = state.sessions.write().await;
            let session_ref = VoiceSessionRef::new("community-d", "chan-3");
            if let Some(session) = sessions.get_mut(&session_ref) {
                if let Some(member) = session.members.get_mut("pk-stale") {
                    // Set last_seen_at to 60 seconds ago (beyond VOICE_MEMBER_TIMEOUT of 30s)
                    member.last_seen_at = Utc::now() - chrono::Duration::seconds(60);
                }
            }
        }

        let events = state.sweep_expired().await;
        // The stale member should have been swept; session becomes empty and is removed
        assert!(
            state.snapshot("community-d", "chan-3").await.is_none(),
            "Empty session should be cleaned up after sweep"
        );
        // Since the session was removed (empty after sweep), we may or may not get
        // an event depending on implementation — the key assertion is the session is gone
        let _ = events;
    }

    #[tokio::test]
    async fn sweep_expired_keeps_fresh_members() {
        let state = VoiceState::new();

        // Add two members
        let _ = state
            .record_join("community-e", "chan-4", "pk-fresh", false, None, None)
            .await
            .unwrap();
        let _ = state
            .record_join("community-e", "chan-4", "pk-stale", false, None, None)
            .await
            .unwrap();

        // Make only pk-stale old
        {
            let mut sessions = state.sessions.write().await;
            let session_ref = VoiceSessionRef::new("community-e", "chan-4");
            if let Some(session) = sessions.get_mut(&session_ref) {
                if let Some(member) = session.members.get_mut("pk-stale") {
                    // Set last_seen_at to 60 seconds ago (beyond VOICE_MEMBER_TIMEOUT of 30s)
                    member.last_seen_at = Utc::now() - chrono::Duration::seconds(60);
                }
            }
        }

        let _ = state.sweep_expired().await;

        // Session should still exist with the fresh member
        let snapshot = state.snapshot("community-e", "chan-4").await;
        assert!(
            snapshot.is_some(),
            "Session with fresh member should survive sweep"
        );
        let snapshot = snapshot.unwrap();
        assert_eq!(snapshot.member_count, 1);
        assert_eq!(snapshot.members[0].public_key, "pk-fresh");
    }

    #[tokio::test]
    async fn epoch_changes_when_member_list_changes() {
        let state = VoiceState::new();

        // Add first member and record epoch
        let _ = state
            .record_join("community-f", "chan-5", "pk-alice", false, None, None)
            .await
            .unwrap();
        let epoch_1 = state.current_epoch("community-f", "chan-5").await.unwrap();

        // Add second member — epoch should change
        let _ = state
            .record_join("community-f", "chan-5", "pk-bob", false, None, None)
            .await
            .unwrap();
        let epoch_2 = state.current_epoch("community-f", "chan-5").await.unwrap();
        assert_ne!(epoch_1, epoch_2, "Epoch must change when a member joins");

        // Remove a member — epoch should change again
        let _ = state
            .record_leave("community-f", "chan-5", "pk-alice")
            .await;
        let epoch_3 = state.current_epoch("community-f", "chan-5").await.unwrap();
        assert_ne!(epoch_2, epoch_3, "Epoch must change when a member leaves");
    }

    #[tokio::test]
    async fn record_leave_for_nonexistent_session_returns_none() {
        let state = VoiceState::new();
        let result = state
            .record_leave("no-community", "no-channel", "pk-ghost")
            .await;
        assert!(
            result.is_none(),
            "Leave for a non-existent session must return None"
        );
    }
}
