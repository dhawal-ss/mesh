use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{watch, Notify, Semaphore};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

const MAX_ACTIVE_REQUESTS_PER_ACCOUNT: usize = 4;
const MAX_ACTIVE_REQUESTS_PER_OPERATION: usize = 1;
const MAX_ADMITTED_REQUESTS_PER_ACCOUNT: usize = 16;
const MAX_ADMITTED_REQUESTS_PER_OPERATION: usize = 8;
const MAX_ADMITTED_ACCOUNT_MUTATIONS: usize = 16;
const MAX_REMEMBERED_COMPLETIONS: usize = 512;
const MAX_REMEMBERED_PRE_CANCELLATIONS: usize = 512;
const MIN_DEADLINE_MS: u64 = 100;
const MAX_DEADLINE_MS: u64 = 120_000;
const CANCELLATION_ACK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeRequestError {
    InvalidRequestId,
    DuplicateRequestId,
    Cancelled,
    DeadlineExceeded,
    CapacityExceeded,
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
    account_scope: String,
    operation: String,
    cancellation: CancellationToken,
    completion: watch::Receiver<bool>,
}

#[derive(Default)]
struct NativeRequestState {
    active: HashMap<String, ActiveRequest>,
    completed: HashSet<String>,
    completion_order: VecDeque<String>,
    pre_cancelled: HashSet<String>,
    pre_cancellation_order: VecDeque<String>,
    account_limits: HashMap<String, Arc<Semaphore>>,
    operation_limits: HashMap<(String, String), Arc<Semaphore>>,
    account_transition_active: bool,
    active_account_mutations: usize,
    native_ui_interaction_active: bool,
    account_generation: u64,
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
    account_mutations_idle: Notify,
}

struct NativeRequestRegistration<'a> {
    registry: &'a NativeRequestRegistry,
    request_id: String,
    completion: Option<watch::Sender<bool>>,
}

type NativeRequestResources = (
    CancellationToken,
    Arc<Semaphore>,
    Arc<Semaphore>,
    watch::Sender<bool>,
);

impl Drop for NativeRequestRegistration<'_> {
    fn drop(&mut self) {
        if let Some(completion) = self.completion.take() {
            self.registry.finish(&self.request_id, completion);
        }
    }
}

pub struct NativeAccountTransitionGuard {
    registry: Arc<NativeRequestRegistry>,
}

pub struct NativeAccountMutationGuard {
    registry: Arc<NativeRequestRegistry>,
}

pub struct NativeUiInteractionGuard {
    registry: Arc<NativeRequestRegistry>,
    _mutation: NativeAccountMutationGuard,
}

impl Drop for NativeAccountTransitionGuard {
    fn drop(&mut self) {
        let mut state = self.registry.lock_state();
        state.account_generation = state.account_generation.wrapping_add(1);
        state.account_transition_active = false;
    }
}

impl Drop for NativeAccountMutationGuard {
    fn drop(&mut self) {
        let mut state = self.registry.lock_state();
        state.active_account_mutations = state.active_account_mutations.saturating_sub(1);
        let mutations_are_idle = state.active_account_mutations == 0;
        drop(state);
        if mutations_are_idle {
            // Only one transition can wait at a time; notify_one also retains
            // a permit if the waiter has not been polled yet.
            self.registry.account_mutations_idle.notify_one();
        }
    }
}

impl Drop for NativeUiInteractionGuard {
    fn drop(&mut self) {
        self.registry.lock_state().native_ui_interaction_active = false;
    }
}

impl NativeRequestRegistry {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, NativeRequestState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn valid_request_id(request_id: &str) -> bool {
        (8..=128).contains(&request_id.len())
            && request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    }

    fn begin(
        &self,
        request_id: &str,
        expected_account_generation: u64,
        account_scope: &str,
        operation: &str,
    ) -> Result<NativeRequestResources, NativeRequestError> {
        if !Self::valid_request_id(request_id) {
            return Err(NativeRequestError::InvalidRequestId);
        }

        let mut state = self.lock_state();
        if state.account_transition_active {
            return Err(NativeRequestError::SchedulerClosed);
        }
        if state.account_generation != expected_account_generation {
            return Err(NativeRequestError::Cancelled);
        }
        // IPC delivery is concurrent, so a cancellation can reach Rust before
        // the command it targets. Keep a bounded tombstone instead of letting
        // that stale command start after an account transition or timeout.
        if state.pre_cancelled.contains(request_id) {
            return Err(NativeRequestError::Cancelled);
        }
        if state.active.contains_key(request_id) || state.completed.contains(request_id) {
            return Err(NativeRequestError::DuplicateRequestId);
        }
        let admitted_for_account = state
            .active
            .values()
            .filter(|active| active.account_scope == account_scope)
            .count();
        if admitted_for_account >= MAX_ADMITTED_REQUESTS_PER_ACCOUNT {
            return Err(NativeRequestError::CapacityExceeded);
        }
        let admitted_for_operation = state
            .active
            .values()
            .filter(|active| active.account_scope == account_scope && active.operation == operation)
            .count();
        if admitted_for_operation >= MAX_ADMITTED_REQUESTS_PER_OPERATION {
            return Err(NativeRequestError::CapacityExceeded);
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
                account_scope: account_scope.to_owned(),
                operation: operation.to_owned(),
                cancellation: cancellation.clone(),
                completion: completion_rx,
            },
        );
        Ok((cancellation, account_limit, operation_limit, completion_tx))
    }

    fn finish(&self, request_id: &str, completion: watch::Sender<bool>) {
        let mut state = self.lock_state();
        if let Some(finished) = state.active.remove(request_id) {
            if !state.active.values().any(|active| {
                active.account_scope == finished.account_scope
                    && active.operation == finished.operation
            }) {
                state
                    .operation_limits
                    .remove(&(finished.account_scope.clone(), finished.operation));
            }
            if !state
                .active
                .values()
                .any(|active| active.account_scope == finished.account_scope)
            {
                state.account_limits.remove(&finished.account_scope);
            }
        }
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

    pub fn account_generation(&self) -> u64 {
        self.lock_state().account_generation
    }

    /// Pin a native mutation to the current account generation. Account
    /// transitions stop admitting new work and wait for this guard to finish,
    /// so an operation cannot begin under one account and finish under another.
    pub fn begin_account_mutation(
        self: &Arc<Self>,
        expected_account_generation: u64,
    ) -> Result<NativeAccountMutationGuard, NativeRequestError> {
        let mut state = self.lock_state();
        if state.account_transition_active {
            return Err(NativeRequestError::SchedulerClosed);
        }
        if state.account_generation != expected_account_generation {
            return Err(NativeRequestError::Cancelled);
        }
        if state.active_account_mutations >= MAX_ADMITTED_ACCOUNT_MUTATIONS {
            return Err(NativeRequestError::CapacityExceeded);
        }
        state.active_account_mutations = state.active_account_mutations.saturating_add(1);
        Ok(NativeAccountMutationGuard {
            registry: Arc::clone(self),
        })
    }

    /// Admit at most one native picker or confirmation dialog for the active
    /// account. The embedded mutation guard keeps account transitions from
    /// changing the identity while trusted native UI is awaiting input.
    pub fn begin_native_ui_interaction(
        self: &Arc<Self>,
        expected_account_generation: u64,
    ) -> Result<NativeUiInteractionGuard, NativeRequestError> {
        let mut state = self.lock_state();
        if state.account_transition_active {
            return Err(NativeRequestError::SchedulerClosed);
        }
        if state.account_generation != expected_account_generation {
            return Err(NativeRequestError::Cancelled);
        }
        if state.native_ui_interaction_active
            || state.active_account_mutations >= MAX_ADMITTED_ACCOUNT_MUTATIONS
        {
            return Err(NativeRequestError::CapacityExceeded);
        }
        state.native_ui_interaction_active = true;
        state.active_account_mutations = state.active_account_mutations.saturating_add(1);
        drop(state);
        Ok(NativeUiInteractionGuard {
            registry: Arc::clone(self),
            _mutation: NativeAccountMutationGuard {
                registry: Arc::clone(self),
            },
        })
    }

    /// Atomically stop admitting work for the current account generation.
    ///
    /// Callers that need to cancel a backend-owned operation before waiting on
    /// native guards can use this first phase without leaving an admission gap.
    pub fn close_account_admission(
        self: &Arc<Self>,
    ) -> Result<NativeAccountTransitionGuard, NativeRequestError> {
        let active = {
            let mut state = self.lock_state();
            if state.account_transition_active {
                return Err(NativeRequestError::SchedulerClosed);
            }
            state.account_transition_active = true;
            state.account_generation = state.account_generation.wrapping_add(1);
            state.active.values().cloned().collect::<Vec<_>>()
        };
        let guard = NativeAccountTransitionGuard {
            registry: Arc::clone(self),
        };

        for request in &active {
            request.cancellation.cancel();
        }

        Ok(guard)
    }

    /// Wait until every request and mutation admitted before the transition
    /// has acknowledged completion. The supplied guard keeps admission closed
    /// for the backend runtime change that follows.
    pub async fn finish_account_transition(
        self: &Arc<Self>,
        guard: NativeAccountTransitionGuard,
    ) -> Result<NativeAccountTransitionGuard, NativeRequestError> {
        if !Arc::ptr_eq(&guard.registry, self) {
            return Err(NativeRequestError::SchedulerClosed);
        }

        // Admission is already closed, so this snapshot is complete. Cancel a
        // second time defensively in case a request was registered just before
        // close_account_admission acquired the state lock.
        let active = self
            .lock_state()
            .active
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for request in &active {
            request.cancellation.cancel();
        }
        let deadline = Instant::now() + CANCELLATION_ACK_TIMEOUT;
        for request in active {
            let mut completion = request.completion;
            let acknowledged = tokio::time::timeout_at(deadline, async move {
                while !*completion.borrow() {
                    if completion.changed().await.is_err() {
                        return false;
                    }
                }
                true
            })
            .await
            .unwrap_or(false);
            if !acknowledged {
                drop(guard);
                return Err(NativeRequestError::SchedulerClosed);
            }
        }
        loop {
            // Register for the notification before checking the counter so a
            // mutation cannot finish between the check and the await.
            let mutations_idle = self.account_mutations_idle.notified();
            if self.lock_state().active_account_mutations == 0 {
                break;
            }
            if tokio::time::timeout_at(deadline, mutations_idle)
                .await
                .is_err()
            {
                drop(guard);
                return Err(NativeRequestError::SchedulerClosed);
            }
        }
        Ok(guard)
    }

    pub async fn run<T, E, F>(
        &self,
        request_id: String,
        deadline_ms: u64,
        expected_account_generation: u64,
        account_scope: String,
        operation: impl Into<String>,
        future: F,
    ) -> Result<Result<T, E>, NativeRequestError>
    where
        F: Future<Output = Result<T, E>>,
    {
        let operation = operation.into();
        let (cancellation, account_limit, operation_limit, completion) = self.begin(
            &request_id,
            expected_account_generation,
            &account_scope,
            &operation,
        )?;
        let registration = NativeRequestRegistration {
            registry: self,
            request_id: request_id.clone(),
            completion: Some(completion),
        };
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

        drop(registration);
        outcome
    }

    pub async fn cancel(&self, request_id: &str) -> NativeCancellationStatus {
        if !Self::valid_request_id(request_id) {
            return NativeCancellationStatus::UnknownRequest;
        }
        let active = {
            let mut state = self.lock_state();
            if state.completed.contains(request_id) {
                return NativeCancellationStatus::Completed;
            }
            let active = state.active.get(request_id).cloned();
            if active.is_none() {
                if state.pre_cancelled.insert(request_id.to_owned()) {
                    state
                        .pre_cancellation_order
                        .push_back(request_id.to_owned());
                }
                while state.pre_cancellation_order.len() > MAX_REMEMBERED_PRE_CANCELLATIONS {
                    if let Some(expired) = state.pre_cancellation_order.pop_front() {
                        state.pre_cancelled.remove(&expired);
                    }
                }
            }
            active
        };
        let Some(active) = active else {
            // The cancellation is durably remembered for a command that has
            // not registered yet, so the caller may safely treat it as done.
            return NativeCancellationStatus::Completed;
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
        for index in 0..MAX_ADMITTED_REQUESTS_PER_OPERATION {
            let registry = registry.clone();
            let active = active.clone();
            let peak = peak.clone();
            tasks.push(tokio::spawn(async move {
                registry
                    .run(
                        format!("request-{index:02}"),
                        5_000,
                        registry.account_generation(),
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
    async fn read_admission_caps_waiting_work_and_transition_cancels_every_admitted_request() {
        let registry = Arc::new(NativeRequestRegistry::default());
        let generation = registry.account_generation();
        let mut tasks = Vec::new();
        for index in 0..MAX_ADMITTED_REQUESTS_PER_OPERATION {
            let registry = Arc::clone(&registry);
            tasks.push(tokio::spawn(async move {
                registry
                    .run(
                        format!("request-admitted-{index:02}"),
                        30_000,
                        generation,
                        "@alice:example.org".into(),
                        "matrix_get_profile",
                        std::future::pending::<Result<(), ()>>(),
                    )
                    .await
            }));
        }
        while registry.lock_state().active.len() < MAX_ADMITTED_REQUESTS_PER_OPERATION {
            tokio::task::yield_now().await;
        }

        assert_eq!(
            registry
                .run(
                    "request-over-operation-cap".into(),
                    30_000,
                    generation,
                    "@alice:example.org".into(),
                    "matrix_get_profile",
                    async { Ok::<_, ()>(()) },
                )
                .await,
            Err(NativeRequestError::CapacityExceeded)
        );
        assert_eq!(
            registry.lock_state().active.len(),
            MAX_ADMITTED_REQUESTS_PER_OPERATION
        );

        let transition = registry
            .close_account_admission()
            .expect("the transition should close bounded admission");
        let transition = registry
            .finish_account_transition(transition)
            .await
            .expect("every admitted request should acknowledge cancellation");
        for task in tasks {
            assert_eq!(
                task.await.expect("admitted request task should join"),
                Err(NativeRequestError::Cancelled)
            );
        }
        drop(transition);
        assert!(registry.lock_state().active.is_empty());
    }

    #[tokio::test]
    async fn account_read_admission_is_bounded_reclaimed_and_never_polls_overflow_work() {
        let registry = Arc::new(NativeRequestRegistry::default());
        let generation = registry.account_generation();
        let mut tasks = Vec::new();
        for index in 0..MAX_ADMITTED_REQUESTS_PER_ACCOUNT {
            let registry = Arc::clone(&registry);
            tasks.push(tokio::spawn(async move {
                registry
                    .run(
                        format!("request-account-cap-{index:02}"),
                        30_000,
                        generation,
                        "@alice:example.org".into(),
                        format!("operation-{index:02}"),
                        std::future::pending::<Result<(), ()>>(),
                    )
                    .await
            }));
        }
        while registry.lock_state().active.len() < MAX_ADMITTED_REQUESTS_PER_ACCOUNT {
            tokio::task::yield_now().await;
        }

        let overflow_started = Arc::new(AtomicBool::new(false));
        let overflow_signal = Arc::clone(&overflow_started);
        assert_eq!(
            registry
                .run(
                    "request-over-account-cap".into(),
                    30_000,
                    generation,
                    "@alice:example.org".into(),
                    "overflow-operation",
                    async move {
                        overflow_signal.store(true, Ordering::SeqCst);
                        Ok::<_, ()>(())
                    },
                )
                .await,
            Err(NativeRequestError::CapacityExceeded)
        );
        assert!(!overflow_started.load(Ordering::SeqCst));
        assert_eq!(
            registry.cancel("request-account-cap-15").await,
            NativeCancellationStatus::Completed
        );
        while registry.lock_state().active.len() >= MAX_ADMITTED_REQUESTS_PER_ACCOUNT {
            tokio::task::yield_now().await;
        }

        let replacement_registry = Arc::clone(&registry);
        let replacement = tokio::spawn(async move {
            replacement_registry
                .run(
                    "request-cap-replacement".into(),
                    30_000,
                    generation,
                    "@alice:example.org".into(),
                    "replacement-operation",
                    std::future::pending::<Result<(), ()>>(),
                )
                .await
        });
        while registry.lock_state().active.len() < MAX_ADMITTED_REQUESTS_PER_ACCOUNT {
            tokio::task::yield_now().await;
        }

        let transition = registry
            .close_account_admission()
            .expect("a full read queue must not prevent transition priority");
        assert_eq!(
            registry
                .run(
                    "request-after-admission-close".into(),
                    5_000,
                    registry.account_generation(),
                    "@alice:example.org".into(),
                    "post-close-operation",
                    async { Ok::<_, ()>(()) },
                )
                .await,
            Err(NativeRequestError::SchedulerClosed)
        );
        let transition = registry
            .finish_account_transition(transition)
            .await
            .expect("bounded admitted reads should drain during transition");
        for task in tasks {
            assert!(matches!(
                task.await.expect("bounded account read should join"),
                Err(NativeRequestError::Cancelled)
            ));
        }
        assert_eq!(
            replacement.await.expect("replacement read should join"),
            Err(NativeRequestError::Cancelled)
        );
        drop(transition);
        assert!(registry.lock_state().active.is_empty());
    }

    #[tokio::test]
    async fn mutation_admission_is_bounded_reclaimed_and_transition_first() {
        let registry = Arc::new(NativeRequestRegistry::default());
        let generation = registry.account_generation();
        let mut guards = (0..MAX_ADMITTED_ACCOUNT_MUTATIONS)
            .map(|_| {
                registry
                    .begin_account_mutation(generation)
                    .expect("mutation below the cap should be admitted")
            })
            .collect::<Vec<_>>();

        assert!(matches!(
            registry.begin_account_mutation(generation),
            Err(NativeRequestError::CapacityExceeded)
        ));
        assert_eq!(
            registry.lock_state().active_account_mutations,
            MAX_ADMITTED_ACCOUNT_MUTATIONS
        );

        drop(guards.pop());
        let replacement = registry
            .begin_account_mutation(generation)
            .expect("dropping one guard should reclaim one mutation slot");
        assert_eq!(
            registry.lock_state().active_account_mutations,
            MAX_ADMITTED_ACCOUNT_MUTATIONS
        );

        let transition = registry
            .close_account_admission()
            .expect("full mutation capacity must not prevent transition priority");
        assert!(matches!(
            registry.begin_account_mutation(registry.account_generation()),
            Err(NativeRequestError::SchedulerClosed)
        ));
        drop(replacement);
        drop(guards);
        let transition = registry
            .finish_account_transition(transition)
            .await
            .expect("bounded mutations should drain during transition");
        drop(transition);
        assert_eq!(registry.lock_state().active_account_mutations, 0);
    }

    #[test]
    fn native_ui_interactions_are_singleton_and_generation_scoped() {
        let registry = Arc::new(NativeRequestRegistry::default());
        let generation = registry.account_generation();
        let first = registry
            .begin_native_ui_interaction(generation)
            .expect("the first trusted native interaction should be admitted");
        assert_eq!(registry.lock_state().active_account_mutations, 1);
        assert!(matches!(
            registry.begin_native_ui_interaction(generation),
            Err(NativeRequestError::CapacityExceeded)
        ));

        drop(first);
        assert!(!registry.lock_state().native_ui_interaction_active);
        assert_eq!(registry.lock_state().active_account_mutations, 0);
        let replacement = registry
            .begin_native_ui_interaction(generation)
            .expect("closing native UI should reclaim singleton admission");
        drop(replacement);

        let transition = registry
            .close_account_admission()
            .expect("account transition should close native UI admission");
        assert!(matches!(
            registry.begin_native_ui_interaction(registry.account_generation()),
            Err(NativeRequestError::SchedulerClosed)
        ));
        drop(transition);
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
                        registry.account_generation(),
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
                    blocker_registry.account_generation(),
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
                    waiting_registry.account_generation(),
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
                registry.account_generation(),
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

    #[tokio::test]
    async fn cancellation_before_registration_prevents_stale_work_from_starting() {
        let registry = NativeRequestRegistry::default();
        let started = Arc::new(AtomicBool::new(false));

        assert_eq!(
            registry.cancel("request-before-registration").await,
            NativeCancellationStatus::Completed
        );
        let future_started = started.clone();
        let result = registry
            .run(
                "request-before-registration".into(),
                5_000,
                registry.account_generation(),
                "@alice:example.org".into(),
                "matrix_get_profile",
                async move {
                    future_started.store(true, Ordering::SeqCst);
                    Ok::<_, ()>(())
                },
            )
            .await;

        assert_eq!(result, Err(NativeRequestError::Cancelled));
        assert!(!started.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn pre_cancellation_tombstones_are_bounded() {
        let registry = NativeRequestRegistry::default();
        for index in 0..(MAX_REMEMBERED_PRE_CANCELLATIONS + 50) {
            assert_eq!(
                registry
                    .cancel(&format!("request-pre-cancel-{index:04}"))
                    .await,
                NativeCancellationStatus::Completed
            );
        }

        let state = registry.lock_state();
        assert_eq!(state.pre_cancelled.len(), MAX_REMEMBERED_PRE_CANCELLATIONS);
        assert_eq!(
            state.pre_cancellation_order.len(),
            MAX_REMEMBERED_PRE_CANCELLATIONS
        );
    }

    #[tokio::test]
    async fn scheduler_limits_are_reclaimed_after_the_last_scoped_request_finishes() {
        let registry = NativeRequestRegistry::default();

        for index in 0..128 {
            registry
                .run(
                    format!("request-limiter-{index:03}"),
                    5_000,
                    registry.account_generation(),
                    format!("@user-{index:03}:example.org"),
                    "matrix_get_profile",
                    async { Ok::<_, ()>(()) },
                )
                .await
                .expect("native request should satisfy its lifecycle")
                .expect("native request fixture should succeed");
        }

        let state = registry.lock_state();
        assert!(state.active.is_empty());
        assert!(state.account_limits.is_empty());
        assert!(state.operation_limits.is_empty());
    }

    #[tokio::test]
    async fn dropping_the_owning_future_reclaims_registration_and_limits() {
        let registry = Arc::new(NativeRequestRegistry::default());
        let worker_registry = Arc::clone(&registry);
        let generation = registry.account_generation();
        let worker = tokio::spawn(async move {
            worker_registry
                .run(
                    "request-owner-dropped".into(),
                    30_000,
                    generation,
                    "@alice:example.org".into(),
                    "matrix_get_profile",
                    std::future::pending::<Result<(), ()>>(),
                )
                .await
        });

        while registry.lock_state().active.is_empty() {
            tokio::task::yield_now().await;
        }
        worker.abort();
        let _ = worker.await;

        let state = registry.lock_state();
        assert!(state.active.is_empty());
        assert!(state.account_limits.is_empty());
        assert!(state.operation_limits.is_empty());
        assert!(state.completed.contains("request-owner-dropped"));
    }

    #[tokio::test]
    async fn account_transition_cancels_active_reads_and_rejects_stale_generations() {
        let registry = Arc::new(NativeRequestRegistry::default());
        let stale_generation = registry.account_generation();
        let worker_registry = Arc::clone(&registry);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            worker_registry
                .run(
                    "request-before-transition".into(),
                    30_000,
                    stale_generation,
                    "@alice:example.org".into(),
                    "matrix_list_communities",
                    async move {
                        let _ = started_tx.send(());
                        std::future::pending::<Result<(), ()>>().await
                    },
                )
                .await
        });
        started_rx
            .await
            .expect("the guarded request should signal that it started");

        let transition = registry
            .close_account_admission()
            .expect("the account transition should close admission atomically");
        let during_generation = registry.account_generation();
        assert_eq!(
            registry
                .run(
                    "request-during-transition".into(),
                    5_000,
                    during_generation,
                    "@alice:example.org".into(),
                    "matrix_get_profile",
                    async { Ok::<_, ()>(()) },
                )
                .await,
            Err(NativeRequestError::SchedulerClosed)
        );
        let transition = registry
            .finish_account_transition(transition)
            .await
            .expect("the account transition should await cancellation acknowledgement");
        assert_eq!(
            worker
                .await
                .expect("the guarded request task should finish after cancellation"),
            Err(NativeRequestError::Cancelled)
        );
        drop(transition);

        assert_eq!(
            registry
                .run(
                    "request-stale-generation".into(),
                    5_000,
                    stale_generation,
                    "@alice:example.org".into(),
                    "matrix_get_profile",
                    async { Ok::<_, ()>(()) },
                )
                .await,
            Err(NativeRequestError::Cancelled)
        );
        let current_generation = registry.account_generation();
        assert_eq!(
            registry
                .run(
                    "request-current-generation".into(),
                    5_000,
                    current_generation,
                    "@bob:example.org".into(),
                    "matrix_get_profile",
                    async { Ok::<_, ()>(()) },
                )
                .await,
            Ok(Ok(()))
        );
    }

    #[tokio::test]
    async fn account_bound_mutation_delays_transition_and_rejects_stale_generation() {
        let registry = Arc::new(NativeRequestRegistry::default());
        let generation = registry.account_generation();
        let mutation = registry
            .begin_account_mutation(generation)
            .expect("the current account mutation should acquire its guard");
        let transition_guard = registry
            .close_account_admission()
            .expect("the transition should atomically close mutation admission");
        assert!(registry.lock_state().account_transition_active);
        assert!(matches!(
            registry.begin_account_mutation(generation),
            Err(NativeRequestError::SchedulerClosed)
        ));
        let transition_registry = Arc::clone(&registry);
        let transition = tokio::spawn(async move {
            transition_registry
                .finish_account_transition(transition_guard)
                .await
                .expect("the transition should wait for the active mutation")
        });
        tokio::task::yield_now().await;
        assert!(!transition.is_finished());
        drop(mutation);

        let transition = transition
            .await
            .expect("the transition task should finish after the mutation");
        drop(transition);
        assert!(matches!(
            registry.begin_account_mutation(generation),
            Err(NativeRequestError::Cancelled)
        ));
    }

    #[test]
    fn attachment_transfers_hold_the_native_account_mutation_barrier() {
        let source = include_str!("../commands/backend.rs");
        for (start, end, guard) in [
            (
                "pub async fn matrix_send_attachment(",
                "pub async fn matrix_cancel_attachment_upload(",
                "begin_native_account_mutation(&state, account_generation)?",
            ),
            (
                "pub async fn matrix_download_attachment(",
                "pub async fn matrix_load_attachment_image(",
                "begin_current_account_mutation(&state)?",
            ),
            (
                "pub async fn matrix_send_dm_attachment(",
                "pub async fn matrix_mark_dm_read(",
                "begin_native_account_mutation(&state, account_generation)?",
            ),
        ] {
            let command = source
                .split(start)
                .nth(1)
                .and_then(|tail| tail.split(end).next())
                .expect("attachment command should remain inspectable");
            assert!(
                command.contains(guard),
                "{start} must remain bound to the account that started the transfer"
            );
        }
    }

    #[test]
    fn account_scoped_commands_are_transition_safe_or_explicit_cancellations() {
        let source = include_str!("../commands/backend.rs");
        let independently_cancellable_or_unsupported = [
            "matrix_cancel_login",
            "matrix_cancel_personal_data_export",
            "matrix_cancel_attachment_upload",
            "matrix_cancel_attachment_download",
            "matrix_cancel_search",
            "matrix_update_member_role",
        ];

        for command in source.split("#[tauri::command]").skip(1) {
            let Some(name) = command
                .split("pub async fn ")
                .nth(1)
                .and_then(|tail| tail.split('(').next())
            else {
                continue;
            };
            if !name.starts_with("matrix_")
                || independently_cancellable_or_unsupported.contains(&name)
            {
                continue;
            }
            assert!(
                command.contains("run_native_read(")
                    || command.contains(
                        "begin_native_account_transition(&app, &state, &notifications).await?",
                    )
                    || command.contains("begin_current_account_mutation(&state)?")
                    || command
                        .contains("begin_native_account_mutation(&state, account_generation)?"),
                "{name} must be cancelled or allowed to finish before an account transition"
            );
        }

        let attachments_source = include_str!("../commands/attachments.rs");
        let downloaded_file_open = attachments_source
            .split("pub async fn open_downloaded_file(")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn discard_attachment_grant(").next())
            .expect("downloaded-file opener should remain inspectable");
        assert!(
            downloaded_file_open.contains("begin_account_mutation(account_generation)"),
            "open_downloaded_file must not race account cache replacement"
        );
    }

    #[test]
    fn account_changing_commands_hold_the_native_transition_barrier() {
        let source = include_str!("../commands/backend.rs");
        let transition_helper = source
            .split("async fn begin_native_account_transition(")
            .nth(1)
            .and_then(|tail| tail.split("fn begin_native_account_mutation(").next())
            .expect("native account-transition helper should remain inspectable");
        let notification_boundary = transition_helper
            .find("close_account_admission_and_invalidate(")
            .expect("account admission and notification revocation should share one boundary");
        let admission_closed = transition_helper
            .find("state.native_requests.close_account_admission()")
            .expect("native admission should close inside the notification boundary");
        let export_cancelled = transition_helper
            .find("cancel_personal_data_export()")
            .expect("personal-data exports should be proactively cancelled");
        let transition_finished = transition_helper
            .find(".finish_account_transition(transition)")
            .expect("native transition should await cancellation acknowledgement");
        assert!(notification_boundary < admission_closed);
        assert!(admission_closed < export_cancelled);
        assert!(export_cancelled < transition_finished);
        for (start, end) in [
            (
                "pub async fn matrix_login(",
                "pub async fn register_account(",
            ),
            (
                "pub async fn register_account(",
                "pub async fn check_username_available(",
            ),
            (
                "pub async fn matrix_start_oidc_login(",
                "pub async fn matrix_cancel_login(",
            ),
            (
                "pub async fn matrix_restore_session(",
                "pub async fn matrix_logout(",
            ),
            (
                "pub async fn matrix_logout(",
                "pub async fn matrix_devices(",
            ),
            (
                "pub async fn matrix_remove_local_account(",
                "/// Export to a folder selected by the trusted native picker.",
            ),
            (
                "pub async fn matrix_deactivate_account(",
                "pub async fn matrix_accounts(",
            ),
            (
                "pub async fn matrix_switch_account(",
                "pub async fn matrix_recovery_health(",
            ),
        ] {
            let command = source
                .split(start)
                .nth(1)
                .and_then(|tail| tail.split(end).next())
                .expect("account-changing command should remain inspectable");
            assert!(
                command.contains(
                    "begin_native_account_transition(&app, &state, &notifications).await?",
                ),
                "{start} must close native read admission before changing accounts"
            );
        }

        let native_read = source
            .split("async fn run_native_read")
            .nth(1)
            .and_then(|tail| tail.split("fn matrix_transfer_progress_emitter").next())
            .expect("native read wrapper should remain inspectable");
        let generation = native_read
            .find("account_generation()")
            .expect("native reads should capture the account generation");
        let admission = native_read
            .find(".native_requests\n        .run(")
            .expect("native reads should enter the registry before awaiting work");
        assert!(generation < admission);
        assert!(!native_read[..admission].contains(".await"));
        assert!(!native_read.contains("backend().status().await"));
        assert!(
            native_read.contains(
                "Err(NativeRequestError::CapacityExceeded) => Err(CommandError::RateLimited)",
            ),
            "native read capacity failures must remain typed retryable failures",
        );

        let mutation_admission = source
            .split("fn begin_native_account_mutation(")
            .nth(1)
            .and_then(|tail| tail.split("fn begin_current_account_mutation(").next())
            .expect("native mutation admission helper should remain inspectable");
        assert!(
            mutation_admission.contains(
                "Err(NativeRequestError::CapacityExceeded) => Err(CommandError::RateLimited)",
            ),
            "native mutation capacity failures must remain typed retryable failures",
        );
    }
}
