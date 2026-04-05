use std::collections::{HashMap, VecDeque};
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
    fn key(self) -> &'static str {
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

#[derive(Default)]
pub struct RateLimitState {
    entries: Mutex<HashMap<String, VecDeque<Instant>>>,
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
}
