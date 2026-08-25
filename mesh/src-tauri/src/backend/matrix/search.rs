use super::*;

pub(super) const MAX_REMEMBERED_PRE_CANCELLED_SEARCHES: usize = 512;
const SEARCH_CANCELLATION_ACK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
struct NativeSearchOperation {
    scope: String,
    cancellation: CancellationToken,
    completion: tokio::sync::watch::Sender<bool>,
}

#[derive(Default, Debug)]
pub(super) struct NativeSearchState {
    operations: HashMap<String, NativeSearchOperation>,
    // Read by the bounded-growth tests, which assert the pre-cancellation
    // memory cannot grow without limit.
    pub(super) pre_cancelled: HashSet<String>,
    pub(super) pre_cancellation_order: VecDeque<String>,
}

#[derive(Default, Debug)]
pub(super) struct NativeSearchRegistry {
    state: StdMutex<NativeSearchState>,
}

#[derive(Debug)]
pub(super) struct NativeSearchRegistration<'a> {
    registry: &'a NativeSearchRegistry,
    request_id: String,
    // Read by the callers that hold a registration, to abort their own work
    // when a newer request supersedes it.
    pub(super) cancellation: CancellationToken,
}

impl Drop for NativeSearchRegistration<'_> {
    fn drop(&mut self) {
        self.registry.finish(&self.request_id);
    }
}

impl NativeSearchRegistry {
    pub(super) fn lock_state(&self) -> StdMutexGuard<'_, NativeSearchState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn validate_request_id(request_id: &str) -> BackendResult<()> {
        if !(8..=128).contains(&request_id.len())
            || !request_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_:".contains(character))
        {
            return Err(BackendError::InvalidConfiguration(
                "search request ID is invalid".into(),
            ));
        }
        Ok(())
    }

    pub(super) async fn begin(
        &self,
        request_id: &str,
        scope: String,
    ) -> BackendResult<NativeSearchRegistration<'_>> {
        self.begin_with_ack_timeout(request_id, scope, SEARCH_CANCELLATION_ACK_TIMEOUT)
            .await
    }

    pub(super) async fn begin_with_ack_timeout(
        &self,
        request_id: &str,
        scope: String,
        acknowledgement_timeout: Duration,
    ) -> BackendResult<NativeSearchRegistration<'_>> {
        Self::validate_request_id(request_id)?;
        tokio::time::timeout(acknowledgement_timeout, async {
            loop {
                let previous = {
                    let mut state = self.lock_state();
                    if state.pre_cancelled.contains(request_id) {
                        return Err(BackendError::Cancelled(
                            "search was cancelled before native registration".into(),
                        ));
                    }
                    if state.operations.contains_key(request_id) {
                        return Err(BackendError::InvalidConfiguration(
                            "search request ID is already active".into(),
                        ));
                    }
                    let previous = state
                        .operations
                        .values()
                        .find(|operation| operation.scope == scope)
                        .map(|operation| {
                            (
                                operation.cancellation.clone(),
                                operation.completion.subscribe(),
                            )
                        });
                    if previous.is_none() {
                        let cancellation = CancellationToken::new();
                        let (completion, _) = tokio::sync::watch::channel(false);
                        state.operations.insert(
                            request_id.to_owned(),
                            NativeSearchOperation {
                                scope: scope.clone(),
                                cancellation: cancellation.clone(),
                                completion,
                            },
                        );
                        return Ok(NativeSearchRegistration {
                            registry: self,
                            request_id: request_id.to_owned(),
                            cancellation,
                        });
                    }
                    previous
                };

                let Some((cancellation, mut completion)) = previous else {
                    return Err(BackendError::Other(
                        "search registration changed before it could start".into(),
                    ));
                };
                cancellation.cancel();
                while !*completion.borrow() {
                    completion.changed().await.map_err(|_| {
                        BackendError::Other("search cancellation acknowledgement was lost".into())
                    })?;
                }
            }
        })
        .await
        .map_err(|_| {
            BackendError::Other(
                "native search did not acknowledge cancellation before the safety deadline".into(),
            )
        })?
    }

    fn finish(&self, request_id: &str) {
        if let Some(operation) = self.lock_state().operations.remove(request_id) {
            let _ = operation.completion.send(true);
        }
    }

    pub(super) async fn cancel(&self, request_id: &str) -> BackendResult<()> {
        Self::validate_request_id(request_id)?;
        let Some((cancellation, mut completion)) = ({
            let mut state = self.lock_state();
            let operation = state.operations.get(request_id).map(|operation| {
                (
                    operation.cancellation.clone(),
                    operation.completion.subscribe(),
                )
            });
            if operation.is_none() {
                if state.pre_cancelled.insert(request_id.to_owned()) {
                    state
                        .pre_cancellation_order
                        .push_back(request_id.to_owned());
                }
                while state.pre_cancellation_order.len() > MAX_REMEMBERED_PRE_CANCELLED_SEARCHES {
                    if let Some(expired) = state.pre_cancellation_order.pop_front() {
                        state.pre_cancelled.remove(&expired);
                    }
                }
            }
            operation
        }) else {
            return Ok(());
        };
        cancellation.cancel();
        if !*completion.borrow() {
            tokio::time::timeout(SEARCH_CANCELLATION_ACK_TIMEOUT, completion.changed())
                .await
                .map_err(|_| {
                    BackendError::Other(
                        "native search did not acknowledge cancellation within five seconds".into(),
                    )
                })?
                .map_err(|_| {
                    BackendError::Other("search cancellation acknowledgement was lost".into())
                })?;
        }
        Ok(())
    }

    pub(super) async fn cancel_all(&self) -> BackendResult<()> {
        let request_ids = self
            .lock_state()
            .operations
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for request_id in request_ids {
            self.cancel(&request_id).await?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) async fn active_count(&self) -> usize {
        self.lock_state().operations.len()
    }
}

pub(super) fn insert_bounded_search_result(
    results: &mut Vec<MessageDto>,
    candidate: MessageDto,
    limit: usize,
) {
    let position = results.partition_point(|existing| {
        existing.timestamp > candidate.timestamp
            || (existing.timestamp == candidate.timestamp && existing.id > candidate.id)
    });
    results.insert(position, candidate);
    if results.len() > limit {
        results.pop();
    }
}
