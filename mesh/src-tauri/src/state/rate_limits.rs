use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy)]
pub enum RateLimitBucket {
    Message,
    MessageEdit,
    Reaction,
    FileAnnouncement,
    Presence,
    InviteChallenge,
}

impl RateLimitBucket {
    pub fn key(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::MessageEdit => "message_edit",
            Self::Reaction => "reaction",
            Self::FileAnnouncement => "file",
            Self::Presence => "presence",
            Self::InviteChallenge => "invite_challenge",
        }
    }

    fn limit(self) -> (usize, Duration) {
        match self {
            Self::Message => (8, Duration::from_secs(10)),
            Self::MessageEdit => (10, Duration::from_secs(60)),
            Self::Reaction => (20, Duration::from_secs(10)),
            Self::FileAnnouncement => (3, Duration::from_secs(60)),
            Self::Presence => (6, Duration::from_secs(60)),
            Self::InviteChallenge => (3, Duration::from_secs(60)),
        }
    }
}

const STALE_ENTRY_AGE: Duration = Duration::from_secs(600);
const REQUESTS_BETWEEN_SWEEPS: usize = 256;

#[derive(Default)]
pub struct RateLimitState {
    entries: Mutex<HashMap<String, VecDeque<Instant>>>,
    requests_since_sweep: AtomicUsize,
}

impl RateLimitState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn allow(&self, bucket: RateLimitBucket, community_id: &str, actor: &str) -> bool {
        let (max_events, window) = bucket.limit();
        let now = Instant::now();
        let cutoff = now.checked_sub(window).unwrap_or(now);
        let key = format!("{}:{}:{}", bucket.key(), community_id, actor);

        let mut entries = self.entries.lock().await;
        self.sweep_if_due(&mut entries, now);
        let queue = entries.entry(key).or_default();
        while queue.front().is_some_and(|timestamp| *timestamp < cutoff) {
            queue.pop_front();
        }

        if queue.len() >= max_events {
            return false;
        }

        queue.push_back(now);
        true
    }

    /// Global per-actor rate limit (cross-community).
    /// Prevents a single actor from spamming across multiple communities.
    pub async fn check_global_rate_limit(&self, bucket: &RateLimitBucket, actor: &str) -> bool {
        let (global_max, window) = match bucket {
            RateLimitBucket::Message => (50, Duration::from_secs(60)),
            RateLimitBucket::MessageEdit => (30, Duration::from_secs(60)),
            RateLimitBucket::Reaction => (60, Duration::from_secs(60)),
            RateLimitBucket::FileAnnouncement => (10, Duration::from_secs(60)),
            RateLimitBucket::Presence => (20, Duration::from_secs(60)),
            RateLimitBucket::InviteChallenge => (10, Duration::from_secs(60)),
        };

        let now = Instant::now();
        let cutoff = now.checked_sub(window).unwrap_or(now);
        let key = format!("global:{}:{}", bucket.key(), actor);

        let mut entries = self.entries.lock().await;
        self.sweep_if_due(&mut entries, now);
        let queue = entries.entry(key).or_default();
        while queue.front().is_some_and(|timestamp| *timestamp < cutoff) {
            queue.pop_front();
        }

        if queue.len() >= global_max {
            return false;
        }

        queue.push_back(now);
        true
    }

    /// Remove stale rate limit entries to prevent unbounded memory growth.
    /// Call periodically (e.g., from the voice sweeper task).
    pub async fn gc_stale_entries(&self) {
        let mut entries = self.entries.lock().await;
        let now = Instant::now();
        Self::retain_active_entries(&mut entries, now);
        self.requests_since_sweep.store(0, Ordering::Relaxed);
    }

    fn sweep_if_due(&self, entries: &mut HashMap<String, VecDeque<Instant>>, now: Instant) {
        let requests = self.requests_since_sweep.fetch_add(1, Ordering::Relaxed) + 1;
        if requests < REQUESTS_BETWEEN_SWEEPS {
            return;
        }
        self.requests_since_sweep.store(0, Ordering::Relaxed);
        Self::retain_active_entries(entries, now);
    }

    fn retain_active_entries(entries: &mut HashMap<String, VecDeque<Instant>>, now: Instant) {
        entries.retain(|_key, queue| {
            queue.back().is_some_and(|last| {
                now.checked_duration_since(*last)
                    .is_some_and(|age| age < STALE_ENTRY_AGE)
            })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn active_traffic_sweeps_stale_actor_keys_without_a_legacy_runtime_task() {
        let state = RateLimitState::new();
        let stale = Instant::now()
            .checked_sub(STALE_ENTRY_AGE + Duration::from_secs(1))
            .expect("test instant should support a ten minute offset");
        {
            let mut entries = state.entries.lock().await;
            for index in 0..300 {
                entries.insert(
                    format!("message:community-{index}:actor-{index}"),
                    VecDeque::from([stale]),
                );
            }
        }
        state
            .requests_since_sweep
            .store(REQUESTS_BETWEEN_SWEEPS - 1, Ordering::Relaxed);

        assert!(
            state
                .allow(
                    RateLimitBucket::Message,
                    "current-community",
                    "current-actor"
                )
                .await
        );

        let entries = state.entries.lock().await;
        assert_eq!(entries.len(), 1);
        assert!(entries.contains_key("message:current-community:current-actor"));
    }
}
