use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

/// Structured metrics for a single download scheduler.
/// Exposed via the diagnostics command for UI/operator visibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStats {
    pub file_hash: String,
    pub total_chunks: u32,
    pub received_chunks: u32,
    pub pending_chunks: u32,
    pub in_flight_chunks: u32,
    pub retry_queue_length: u32,
    pub seeder_count: u32,
    pub active_seeders: u32,
    pub total_successful_requests: u32,
    pub total_failed_requests: u32,
    pub avg_seeder_rtt_ms: f64,
    pub is_complete: bool,
    pub is_stalled: bool,
    pub is_failed: bool,
}

/// Maximum concurrent chunk requests across all peers
const MAX_CONCURRENT_REQUESTS: usize = 16;
/// Maximum concurrent requests per individual peer
const MAX_PER_PEER: usize = 4;
/// Timeout before retrying a chunk request
const CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum retry attempts per chunk
const MAX_RETRIES: u32 = 5;

#[derive(Debug, Clone)]
pub struct ChunkRequest {
    pub file_hash: String,
    pub chunk_index: u32,
}

#[derive(Debug)]
struct InFlightChunk {
    #[allow(dead_code)]
    chunk_index: u32,
    peer_id: String,
    sent_at: Instant,
    retries: u32,
}

pub struct DownloadScheduler {
    /// File hash this scheduler manages
    file_hash: String,
    /// Community ID for signing chunk requests
    community_id: String,
    /// Total chunks needed
    total_chunks: u32,
    /// Chunks we already have
    received: HashSet<u32>,
    /// Chunks waiting to be requested
    pending: VecDeque<u32>,
    /// Currently in-flight requests
    in_flight: HashMap<u32, InFlightChunk>,
    /// Available seeders with their current load
    seeders: Vec<SeederState>,
    /// Chunks that failed and need retry
    retry_queue: VecDeque<(u32, u32)>, // (chunk_index, retry_count)
}

#[derive(Debug)]
struct SeederState {
    peer_id: String,
    active_requests: u32,
    failed_requests: u32,
    successful_requests: u32,
    avg_response_time_ms: f64,
}

impl DownloadScheduler {
    pub fn new(
        file_hash: String,
        community_id: String,
        total_chunks: u32,
        seeders: Vec<String>,
        already_received: HashSet<u32>,
    ) -> Self {
        let mut pending = VecDeque::new();
        for i in 0..total_chunks {
            if !already_received.contains(&i) {
                pending.push_back(i);
            }
        }

        let seeder_states = seeders
            .into_iter()
            .map(|peer_id| SeederState {
                peer_id,
                active_requests: 0,
                failed_requests: 0,
                successful_requests: 0,
                avg_response_time_ms: 0.0,
            })
            .collect();

        DownloadScheduler {
            file_hash,
            community_id,
            total_chunks,
            received: already_received,
            pending,
            in_flight: HashMap::new(),
            seeders: seeder_states,
            retry_queue: VecDeque::new(),
        }
    }

    /// Get the community ID associated with this download.
    pub fn community_id(&self) -> &str {
        &self.community_id
    }

    /// Get the next batch of chunk requests to send, respecting concurrency limits.
    /// Returns pairs of (ChunkRequest, peer_id).
    pub fn next_requests(&mut self) -> Vec<(ChunkRequest, String)> {
        let mut requests = Vec::new();

        // Process retry queue first (higher priority)
        while let Some((chunk_index, retry_count)) = self.retry_queue.front().copied() {
            if self.in_flight.len() >= MAX_CONCURRENT_REQUESTS {
                break;
            }
            if let Some(peer_id) = self.pick_seeder() {
                self.retry_queue.pop_front();
                let req = ChunkRequest {
                    file_hash: self.file_hash.clone(),
                    chunk_index,
                };
                self.in_flight.insert(
                    chunk_index,
                    InFlightChunk {
                        chunk_index,
                        peer_id: peer_id.clone(),
                        sent_at: Instant::now(),
                        retries: retry_count,
                    },
                );
                self.increment_seeder_load(&peer_id);
                requests.push((req, peer_id));
            } else {
                break; // No available seeders
            }
        }

        // Then process pending queue
        while let Some(chunk_index) = self.pending.front().copied() {
            if self.in_flight.len() >= MAX_CONCURRENT_REQUESTS {
                break;
            }
            if let Some(peer_id) = self.pick_seeder() {
                self.pending.pop_front();
                let req = ChunkRequest {
                    file_hash: self.file_hash.clone(),
                    chunk_index,
                };
                self.in_flight.insert(
                    chunk_index,
                    InFlightChunk {
                        chunk_index,
                        peer_id: peer_id.clone(),
                        sent_at: Instant::now(),
                        retries: 0,
                    },
                );
                self.increment_seeder_load(&peer_id);
                requests.push((req, peer_id));
            } else {
                break;
            }
        }

        requests
    }

    /// Record that a chunk was successfully received.
    pub fn chunk_received(&mut self, chunk_index: u32) {
        self.received.insert(chunk_index);
        if let Some(in_flight) = self.in_flight.remove(&chunk_index) {
            let elapsed = in_flight.sent_at.elapsed().as_millis() as f64;
            self.update_seeder_stats(&in_flight.peer_id, true, elapsed);
        }
    }

    /// Record that a chunk request failed (empty response or error).
    pub fn chunk_failed(&mut self, chunk_index: u32) {
        if let Some(in_flight) = self.in_flight.remove(&chunk_index) {
            self.update_seeder_stats(&in_flight.peer_id, false, 0.0);
            if in_flight.retries < MAX_RETRIES {
                self.retry_queue
                    .push_back((chunk_index, in_flight.retries + 1));
            }
        }
    }

    /// Check for timed-out in-flight requests and move them to the retry queue.
    /// Returns the list of chunk indices that timed out.
    pub fn check_timeouts(&mut self) -> Vec<u32> {
        let now = Instant::now();
        let timed_out: Vec<u32> = self
            .in_flight
            .iter()
            .filter(|(_, chunk)| now.duration_since(chunk.sent_at) > CHUNK_TIMEOUT)
            .map(|(&idx, _)| idx)
            .collect();

        for idx in &timed_out {
            self.chunk_failed(*idx);
        }
        timed_out
    }

    /// Is the download complete?
    pub fn is_complete(&self) -> bool {
        self.received.len() as u32 >= self.total_chunks
    }

    /// Returns true if the download is stalled — no seeders available and retry queue exhausted.
    pub fn is_stalled(&self) -> bool {
        if self.is_complete() {
            return false;
        }
        // Stalled if: nothing in-flight, nothing pending, nothing to retry, and no available seeders
        self.in_flight.is_empty()
            && self.pending.is_empty()
            && self.retry_queue.is_empty()
            && self.pick_seeder().is_none()
    }

    /// Returns true if all retry attempts are exhausted for remaining chunks.
    pub fn is_failed(&self) -> bool {
        if self.is_complete() {
            return false;
        }
        // Failed if nothing is in-flight, nothing is pending or retryable,
        // and we still have unchunked portions
        self.in_flight.is_empty()
            && self.pending.is_empty()
            && self.retry_queue.is_empty()
            && (self.received.len() as u32) < self.total_chunks
    }

    /// Progress as a fraction 0.0-1.0
    #[allow(dead_code)]
    pub fn progress(&self) -> f64 {
        if self.total_chunks == 0 {
            return 1.0;
        }
        self.received.len() as f64 / self.total_chunks as f64
    }

    /// Return structured metrics for observability and diagnostics.
    /// Used by the diagnostics command to surface scheduler state in the UI.
    pub fn stats(&self) -> SchedulerStats {
        let total_success: u32 = self.seeders.iter().map(|s| s.successful_requests).sum();
        let total_failed: u32 = self.seeders.iter().map(|s| s.failed_requests).sum();
        let avg_rtt = if self.seeders.is_empty() {
            0.0
        } else {
            let sum: f64 = self.seeders.iter().map(|s| s.avg_response_time_ms).sum();
            sum / self.seeders.len() as f64
        };
        SchedulerStats {
            file_hash: self.file_hash.clone(),
            total_chunks: self.total_chunks,
            received_chunks: self.received.len() as u32,
            pending_chunks: self.pending.len() as u32,
            in_flight_chunks: self.in_flight.len() as u32,
            retry_queue_length: self.retry_queue.len() as u32,
            seeder_count: self.seeders.len() as u32,
            active_seeders: self
                .seeders
                .iter()
                .filter(|s| s.active_requests > 0)
                .count() as u32,
            total_successful_requests: total_success,
            total_failed_requests: total_failed,
            avg_seeder_rtt_ms: avg_rtt,
            is_complete: self.is_complete(),
            is_stalled: self.is_stalled(),
            is_failed: self.is_failed(),
        }
    }

    /// Add a new seeder discovered during download.
    #[allow(dead_code)]
    pub fn add_seeder(&mut self, peer_id: String) {
        if !self.seeders.iter().any(|s| s.peer_id == peer_id) {
            self.seeders.push(SeederState {
                peer_id,
                active_requests: 0,
                failed_requests: 0,
                successful_requests: 0,
                avg_response_time_ms: 0.0,
            });
        }
    }

    /// Pick the best available seeder (lowest load, fewest failures, best response time).
    fn pick_seeder(&self) -> Option<String> {
        self.seeders
            .iter()
            .filter(|s| s.active_requests < MAX_PER_PEER as u32)
            .min_by(|a, b| {
                a.active_requests
                    .cmp(&b.active_requests)
                    .then(a.failed_requests.cmp(&b.failed_requests))
                    .then(
                        a.avg_response_time_ms
                            .partial_cmp(&b.avg_response_time_ms)
                            .unwrap_or(std::cmp::Ordering::Equal),
                    )
            })
            .map(|s| s.peer_id.clone())
    }

    fn increment_seeder_load(&mut self, peer_id: &str) {
        if let Some(s) = self.seeders.iter_mut().find(|s| s.peer_id == peer_id) {
            s.active_requests += 1;
        }
    }

    fn update_seeder_stats(&mut self, peer_id: &str, success: bool, response_time_ms: f64) {
        if let Some(s) = self.seeders.iter_mut().find(|s| s.peer_id == peer_id) {
            s.active_requests = s.active_requests.saturating_sub(1);
            if success {
                s.successful_requests += 1;
                // Exponential moving average for response time
                let alpha = 0.3;
                s.avg_response_time_ms =
                    alpha * response_time_ms + (1.0 - alpha) * s.avg_response_time_ms;
            } else {
                s.failed_requests += 1;
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn respects_max_concurrent_requests() {
        let seeders: Vec<String> = (0..5).map(|i| format!("peer-{}", i)).collect();
        let mut scheduler =
            DownloadScheduler::new("hash".into(), String::new(), 100, seeders, HashSet::new());

        let batch = scheduler.next_requests();
        assert_eq!(batch.len(), MAX_CONCURRENT_REQUESTS);
        assert_eq!(scheduler.in_flight.len(), MAX_CONCURRENT_REQUESTS);

        // No more should be issued while at capacity
        let batch2 = scheduler.next_requests();
        assert!(batch2.is_empty());
    }

    #[test]
    fn respects_per_peer_limit() {
        // Only one seeder: should cap at MAX_PER_PEER
        let mut scheduler = DownloadScheduler::new(
            "hash".into(),
            String::new(),
            100,
            vec!["peer-0".into()],
            HashSet::new(),
        );

        let batch = scheduler.next_requests();
        assert_eq!(batch.len(), MAX_PER_PEER);
    }

    #[test]
    fn receiving_chunk_opens_slot() {
        let seeders = vec!["peer-0".into(), "peer-1".into()];
        let mut scheduler =
            DownloadScheduler::new("hash".into(), String::new(), 20, seeders, HashSet::new());

        let batch1 = scheduler.next_requests();
        assert_eq!(batch1.len(), 8); // 2 seeders * MAX_PER_PEER(4) = 8

        // Receive one chunk to free a slot
        scheduler.chunk_received(batch1[0].0.chunk_index);

        let batch2 = scheduler.next_requests();
        assert_eq!(batch2.len(), 1);
    }

    #[test]
    fn skips_already_received_chunks() {
        let mut already = HashSet::new();
        already.insert(0);
        already.insert(2);
        let mut scheduler = DownloadScheduler::new(
            "hash".into(),
            String::new(),
            5,
            vec!["peer-0".into()],
            already,
        );

        let batch = scheduler.next_requests();
        let indices: Vec<u32> = batch.iter().map(|(r, _)| r.chunk_index).collect();
        assert!(!indices.contains(&0));
        assert!(!indices.contains(&2));
    }

    #[test]
    fn timed_out_chunks_are_retried() {
        let mut scheduler = DownloadScheduler::new(
            "hash".into(),
            String::new(),
            5,
            vec!["peer-0".into()],
            HashSet::new(),
        );

        let _ = scheduler.next_requests(); // issues up to 4

        // Manually expire in-flight chunks
        for chunk in scheduler.in_flight.values_mut() {
            chunk.sent_at = Instant::now() - Duration::from_secs(60);
        }

        let timed_out = scheduler.check_timeouts();
        assert!(!timed_out.is_empty());

        // Retry queue should now have entries
        assert!(!scheduler.retry_queue.is_empty());

        // Next requests should pull from retry queue
        let batch = scheduler.next_requests();
        assert!(!batch.is_empty());
    }

    #[test]
    fn completion_detected() {
        let mut scheduler = DownloadScheduler::new(
            "hash".into(),
            String::new(),
            2,
            vec!["peer-0".into()],
            HashSet::new(),
        );

        let batch = scheduler.next_requests();
        assert_eq!(batch.len(), 2);

        scheduler.chunk_received(0);
        assert!(!scheduler.is_complete());

        scheduler.chunk_received(1);
        assert!(scheduler.is_complete());
    }
}
