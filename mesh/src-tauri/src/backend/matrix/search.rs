#[derive(Debug)]
struct NativeSearchOperation {
    scope: String,
    cancellation: CancellationToken,
    completion: tokio::sync::watch::Sender<bool>,
}

#[derive(Default, Debug)]
struct NativeSearchRegistry {
    operations: Mutex<HashMap<String, NativeSearchOperation>>,
}

impl NativeSearchRegistry {
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

    async fn begin(&self, request_id: &str, scope: String) -> BackendResult<CancellationToken> {
        Self::validate_request_id(request_id)?;
        loop {
            let previous = {
                let operations = self.operations.lock().await;
                if operations.contains_key(request_id) {
                    return Err(BackendError::InvalidConfiguration(
                        "search request ID is already active".into(),
                    ));
                }
                operations
                    .values()
                    .find(|operation| operation.scope == scope)
                    .map(|operation| {
                        (
                            operation.cancellation.clone(),
                            operation.completion.subscribe(),
                        )
                    })
            };

            let Some((cancellation, mut completion)) = previous else {
                let cancellation = CancellationToken::new();
                let (completion, _) = tokio::sync::watch::channel(false);
                let mut operations = self.operations.lock().await;
                if operations.values().any(|operation| operation.scope == scope) {
                    continue;
                }
                operations.insert(
                    request_id.to_owned(),
                    NativeSearchOperation {
                        scope,
                        cancellation: cancellation.clone(),
                        completion,
                    },
                );
                return Ok(cancellation);
            };

            cancellation.cancel();
            if !*completion.borrow() {
                completion.changed().await.map_err(|_| {
                    BackendError::Other("search cancellation acknowledgement was lost".into())
                })?;
            }
        }
    }

    async fn finish(&self, request_id: &str) {
        if let Some(operation) = self.operations.lock().await.remove(request_id) {
            let _ = operation.completion.send(true);
        }
    }

    async fn cancel(&self, request_id: &str) -> BackendResult<()> {
        Self::validate_request_id(request_id)?;
        let Some((cancellation, mut completion)) = ({
            let operations = self.operations.lock().await;
            operations.get(request_id).map(|operation| {
                (
                    operation.cancellation.clone(),
                    operation.completion.subscribe(),
                )
            })
        }) else {
            return Ok(());
        };
        cancellation.cancel();
        if !*completion.borrow() {
            tokio::time::timeout(Duration::from_secs(5), completion.changed())
                .await
                .map_err(|_| {
                    BackendError::Other(
                        "native search did not acknowledge cancellation within five seconds"
                            .into(),
                    )
                })?
                .map_err(|_| {
                    BackendError::Other("search cancellation acknowledgement was lost".into())
                })?;
        }
        Ok(())
    }

    async fn cancel_all(&self) -> BackendResult<()> {
        let request_ids = self
            .operations
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for request_id in request_ids {
            self.cancel(&request_id).await?;
        }
        Ok(())
    }

    #[cfg(test)]
    async fn active_count(&self) -> usize {
        self.operations.lock().await.len()
    }
}

fn insert_bounded_search_result(results: &mut Vec<MessageDto>, candidate: MessageDto, limit: usize) {
    let position = results.partition_point(|existing| {
        existing.timestamp > candidate.timestamp
            || (existing.timestamp == candidate.timestamp && existing.id > candidate.id)
    });
    results.insert(position, candidate);
    if results.len() > limit {
        results.pop();
    }
}
