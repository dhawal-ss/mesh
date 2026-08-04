use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{watch, Mutex, Semaphore};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

const MAX_ACTIVE_REQUESTS_PER_ACCOUNT: usize = 4;
const MAX_ACTIVE_REQUESTS_PER_OPERATION: usize = 1;
const MAX_REMEMBERED_COMPLETIONS: usize = 512;
const MIN_DEADLINE_MS: u64 = 100;
const MAX_DEADLINE_MS: u64 = 120_000;
const CANCELLATION_ACK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeRequestError {
    InvalidRequestId,
    DuplicateRequestId,
    Cancelled,
    DeadlineExceeded,
    SchedulerClosed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeCancellationStatus {
    Completed,
    UnknownRequest,
    AcknowledgementTimedOut,
}

#[derive(Clone)]
struct ActiveRequest {
    cancellation: CancellationToken,
    completion: watch::Receiver<bool>,
}

#[derive(Default)]
struct NativeRequestState {
    active: HashMap<String, ActiveRequest>,
    completed: HashSet<String>,
    completion_order: VecDeque<String>,
    account_limits: HashMap<String, Arc<Semaphore>>,
    operation_limits: HashMap<(String, String), Arc<Semaphore>>,
}

/// Rust-owned lifecycle for renderer-initiated read operations.
///
/// Requests are bounded both across an account and per operation. Cancellation
/// acknowledgement is sent only after the guarded future has been dropped and
/// its permits have been released, so a renderer can never mistake its own
/// timeout for native completion.
#[derive(Default)]
pub struct NativeRequestRegistry {
    state: Mutex<NativeRequestState>,
}

impl NativeRequestRegistry {
    fn valid_request_id(request_id: &str) -> bool {
        (8..=128).contains(&request_id.len())
            && request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    }

    async fn begin(
        &self,
        request_id: &str,
        account_scope: &str,
        operation: &str,
    ) -> Result<
        (
            CancellationToken,
            Arc<Semaphore>,
            Arc<Semaphore>,
            watch::Sender<bool>,
        ),
        NativeRequestError,
    > {
        if !Self::valid_request_id(request_id) {
            return Err(NativeRequestError::InvalidRequestId);
        }

        let mut state = self.state.lock().await;
        if state.active.contains_key(request_id) || state.completed.contains(request_id) {
            return Err(NativeRequestError::DuplicateRequestId);
        }

        let account_limit = state
            .account_limits
            .entry(account_scope.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_ACTIVE_REQUESTS_PER_ACCOUNT)))
            .clone();
        let operation_limit = state
            .operation_limits
            .entry((account_scope.to_owned(), operation.to_owned()))
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_ACTIVE_REQUESTS_PER_OPERATION)))
            .clone();
        let cancellation = CancellationToken::new();
        let (completion_tx, completion_rx) = watch::channel(false);
        state.active.insert(
            request_id.to_owned(),
            ActiveRequest {
                cancellation: cancellation.clone(),
                completion: completion_rx,
            },
        );
        Ok((cancellation, account_limit, operation_limit, completion_tx))
    }

    async fn finish(&self, request_id: &str, completion: watch::Sender<bool>) {
        let mut state = self.state.lock().await;
        state.active.remove(request_id);
        if state.completed.insert(request_id.to_owned()) {
            state.completion_order.push_back(request_id.to_owned());
        }
        while state.completion_order.len() > MAX_REMEMBERED_COMPLETIONS {
            if let Some(expired) = state.completion_order.pop_front() {
                state.completed.remove(&expired);
            }
        }
        let _ = completion.send(true);
    }

    pub async fn run<T, E, F>(
        &self,
        request_id: String,
        deadline_ms: u64,
        account_scope: String,
        operation: &'static str,
        future: F,
    ) -> Result<Result<T, E>, NativeRequestError>
    where
        F: Future<Output = Result<T, E>>,
    {
        let (cancellation, account_limit, operation_limit, completion) =
            self.begin(&request_id, &account_scope, operation).await?;
        let deadline = Instant::now()
            + Duration::from_millis(deadline_ms.clamp(MIN_DEADLINE_MS, MAX_DEADLINE_MS));

        let outcome = async {
            let account_permit = tokio::select! {
                _ = cancellation.cancelled() => return Err(NativeRequestError::Cancelled),
                _ = tokio::time::sleep_until(deadline) => return Err(NativeRequestError::DeadlineExceeded),
                permit = account_limit.acquire_owned() => permit.map_err(|_| NativeRequestError::SchedulerClosed)?,
            };
            let operation_permit = tokio::select! {
                _ = cancellation.cancelled() => return Err(NativeRequestError::Cancelled),
                _ = tokio::time::sleep_until(deadline) => return Err(NativeRequestError::DeadlineExceeded),
                permit = operation_limit.acquire_owned() => permit.map_err(|_| NativeRequestError::SchedulerClosed)?,
            };

            let result = tokio::select! {
                _ = cancellation.cancelled() => Err(NativeRequestError::Cancelled),
                _ = tokio::time::sleep_until(deadline) => Err(NativeRequestError::DeadlineExceeded),
                result = future => Ok(result),
            };
            drop(operation_permit);
            drop(account_permit);
            result
        }
        .await;

        self.finish(&request_id, completion).await;
        outcome
    }

    pub async fn cancel(&self, request_id: &str) -> NativeCancellationStatus {
        if !Self::valid_request_id(request_id) {
            return NativeCancellationStatus::UnknownRequest;
        }
        let active = {
            let state = self.state.lock().await;
            if state.completed.contains(request_id) {
                return NativeCancellationStatus::Completed;
            }
            state.active.get(request_id).cloned()
        };
        let Some(active) = active else {
            return NativeCancellationStatus::UnknownRequest;
        };

        active.cancellation.cancel();
        let mut completion = active.completion;
        let acknowledged = tokio::time::timeout(CANCELLATION_ACK_TIMEOUT, async move {
            while !*completion.borrow() {
                if completion.changed().await.is_err() {
                    return false;
                }
            }
            true
        })
        .await
        .unwrap_or(false);
        if acknowledged {
            NativeCancellationStatus::Completed
        } else {
            NativeCancellationStatus::AcknowledgementTimedOut
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    fn observe_peak(active: &AtomicUsize, peak: &AtomicUsize) -> usize {
        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
        peak.fetch_max(current, Ordering::SeqCst);
        current
    }

    #[tokio::test]
    async fn serializes_the_same_operation_and_bounds_account_concurrency() {
        let registry = Arc::new(NativeRequestRegistry::default());
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for index in 0..20 {
            let registry = registry.clone();
            let active = active.clone();
            let peak = peak.clone();
            tasks.push(tokio::spawn(async move {
                registry
                    .run(
                        format!("request-{index:02}"),
                        5_000,
                        "@alice:example.org".into(),
                        "matrix_get_profile",
                        async move {
                            observe_peak(&active, &peak);
                            tokio::task::yield_now().await;
                            active.fetch_sub(1, Ordering::SeqCst);
                            Ok::<_, ()>(())
                        },
                    )
                    .await
            }));
        }
        for task in tasks {
            task.await
                .expect("serialized native request task should join")
                .expect("serialized native request should satisfy its lifecycle")
                .expect("serialized native request fixture should succeed");
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn bounds_distinct_operations_for_one_account() {
        const OPERATIONS: [&str; 8] = [
            "operation-0",
            "operation-1",
            "operation-2",
            "operation-3",
            "operation-4",
            "operation-5",
            "operation-6",
            "operation-7",
        ];
        let registry = Arc::new(NativeRequestRegistry::default());
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(tokio::sync::Notify::new());
        let mut tasks = Vec::new();
        for (index, operation) in OPERATIONS.into_iter().enumerate() {
            let registry = registry.clone();
            let active = active.clone();
            let peak = peak.clone();
            let release = release.clone();
            tasks.push(tokio::spawn(async move {
                registry
                    .run(
                        format!("account-request-{index}"),
                        5_000,
                        "@alice:example.org".into(),
                        operation,
                        async move {
                            observe_peak(&active, &peak);
                            release.notified().await;
                            active.fetch_sub(1, Ordering::SeqCst);
                            Ok::<_, ()>(())
                        },
                    )
                    .await
            }));
        }

        while active.load(Ordering::SeqCst) < MAX_ACTIVE_REQUESTS_PER_ACCOUNT {
            tokio::task::yield_now().await;
        }
        assert_eq!(peak.load(Ordering::SeqCst), MAX_ACTIVE_REQUESTS_PER_ACCOUNT);
        release.notify_waiters();
        // The second wave may not be waiting on Notify yet when the first wave
        // is released, so release each of those requests as it starts.
        while tasks.iter().any(|task| !task.is_finished()) {
            release.notify_waiters();
            tokio::task::yield_now().await;
        }
        for task in tasks {
            task.await
                .expect("bounded native request task should join")
                .expect("bounded native request should satisfy its lifecycle")
                .expect("bounded native request fixture should succeed");
        }
        assert!(peak.load(Ordering::SeqCst) <= MAX_ACTIVE_REQUESTS_PER_ACCOUNT);
    }

    #[tokio::test]
    async fn cancellation_acknowledges_a_waiting_request_before_it_starts() {
        let registry = Arc::new(NativeRequestRegistry::default());
        let release = Arc::new(tokio::sync::Notify::new());
        let blocker_started = Arc::new(tokio::sync::Notify::new());
        let blocker_registry = registry.clone();
        let blocker_release = release.clone();
        let blocker_start_signal = blocker_started.clone();
        let blocker = tokio::spawn(async move {
            blocker_registry
                .run(
                    "request-blocker".into(),
                    5_000,
                    "@alice:example.org".into(),
                    "matrix_get_profile",
                    async move {
                        blocker_start_signal.notify_one();
                        blocker_release.notified().await;
                        Ok::<_, ()>(())
                    },
                )
                .await
        });
        blocker_started.notified().await;

        let started = Arc::new(AtomicBool::new(false));
        let waiting_registry = registry.clone();
        let waiting_started = started.clone();
        let waiting = tokio::spawn(async move {
            waiting_registry
                .run(
                    "request-waiting".into(),
                    5_000,
                    "@alice:example.org".into(),
                    "matrix_get_profile",
                    async move {
                        waiting_started.store(true, Ordering::SeqCst);
                        Ok::<_, ()>(())
                    },
                )
                .await
        });
        tokio::task::yield_now().await;

        assert_eq!(
            registry.cancel("request-waiting").await,
            NativeCancellationStatus::Completed
        );
        assert_eq!(
            waiting
                .await
                .expect("waiting native request task should join"),
            Err(NativeRequestError::Cancelled)
        );
        assert!(!started.load(Ordering::SeqCst));

        release.notify_one();
        blocker
            .await
            .expect("blocking native request task should join")
            .expect("blocking native request should satisfy its lifecycle")
            .expect("blocking native request fixture should succeed");
    }

    #[tokio::test]
    async fn native_deadline_drops_work_and_is_remembered_as_completed() {
        let registry = NativeRequestRegistry::default();
        let result = registry
            .run(
                "request-deadline".into(),
                1,
                "@alice:example.org".into(),
                "matrix_get_profile",
                std::future::pending::<Result<(), ()>>(),
            )
            .await;
        assert_eq!(result, Err(NativeRequestError::DeadlineExceeded));
        assert_eq!(
            registry.cancel("request-deadline").await,
            NativeCancellationStatus::Completed
        );
    }
}
