impl MatrixBackend {
    fn dispatch_backend_event(
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
        event: MatrixBackendEvent,
    ) {
        let callback = callback
            .read()
            .ok()
            .and_then(|callback| callback.as_ref().cloned());
        if let Some(callback) = callback {
            callback(event);
        }
    }

    fn notification_preview(body: &str) -> String {
        let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut preview = normalized.chars().take(240).collect::<String>();
        if normalized.chars().count() > 240 {
            preview.push('…');
        }
        preview
    }

    /// Extract explicit Matrix user IDs from a message body for intentional mentions.
    ///
    /// Display names and local `@everyone`-style conventions are deliberately ignored until
    /// the composer has a member-backed representation and a server-side policy for them.
    fn mentions_for_body(body: &str, own_user_id: Option<&UserId>) -> Mentions {
        const MAX_MENTIONS: usize = 64;
        const MAX_SCAN_BYTES: usize = 16 * 1024;

        let mut mentions = Mentions::new();
        for (at_index, character) in body.char_indices() {
            if at_index >= MAX_SCAN_BYTES {
                break;
            }
            if character != '@' || mentions.user_ids.len() >= MAX_MENTIONS {
                continue;
            }

            let boundary = body[..at_index].chars().next_back().is_none_or(|previous| {
                previous.is_whitespace()
                    || matches!(previous, '<' | '(' | '[' | '{' | '"' | '\'' | '`')
            });
            if !boundary {
                continue;
            }

            let candidate = body[at_index..]
                .split(|character: char| {
                    character.is_whitespace()
                        || matches!(
                            character,
                            '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | '`'
                        )
                })
                .next()
                .unwrap_or_default()
                .trim_end_matches(|character: char| {
                    matches!(character, '.' | ',' | '!' | '?' | ';' | ':')
                });
            let Ok(user_id) = UserId::parse(candidate) else {
                continue;
            };
            if own_user_id.is_some_and(|own_user_id| own_user_id == user_id) {
                continue;
            }
            mentions.user_ids.insert(user_id);
        }
        mentions
    }

    async fn emit_room_unread(
        client: &Client,
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
        room_id: &matrix_sdk::ruma::RoomId,
    ) {
        let room =
            match Self::protected_joined_room(client, room_id, "reading unread message counts")
                .await
            {
                Ok(room) => room,
                Err(error) => {
                    tracing::warn!(
                        target: "mesh::security",
                        room_id = %room_id,
                        "Suppressed unread state for an unprotected room: {error}"
                    );
                    return;
                }
            };
        Self::dispatch_backend_event(
            callback,
            MatrixBackendEvent::UnreadUpdate(MatrixUnreadUpdate {
                room_id: room.room_id().to_string(),
                unread_messages: room.num_unread_messages().min(i64::MAX as u64) as i64,
                unread_mentions: room.num_unread_mentions().min(i64::MAX as u64) as i64,
            }),
        );
    }

    async fn emit_all_room_unreads(
        client: &Client,
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
    ) {
        for room in client.rooms() {
            Self::emit_room_unread(client, callback, room.room_id()).await;
        }
    }

    fn avatar_color(seed: &str) -> String {
        let digest = Sha256::digest(seed.as_bytes());
        format!("#{:02x}{:02x}{:02x}", digest[0], digest[1], digest[2])
    }

    fn timestamp_from_millis(timestamp: Option<u64>) -> String {
        timestamp
            .and_then(|millis| {
                chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis as i64)
            })
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339()
    }

    fn event_timestamp(value: &serde_json::Value) -> String {
        Self::timestamp_from_millis(
            value
                .get("origin_server_ts")
                .and_then(serde_json::Value::as_u64),
        )
    }

    fn is_base_text_message(value: &serde_json::Value) -> bool {
        if value.get("type").and_then(serde_json::Value::as_str) != Some("m.room.message") {
            return false;
        }
        let Some(content) = value.get("content") else {
            return false;
        };
        if content
            .get("m.relates_to")
            .and_then(|relation| relation.get("rel_type"))
            .and_then(serde_json::Value::as_str)
            == Some("m.replace")
        {
            return false;
        }
        let msgtype = content.get("msgtype").and_then(serde_json::Value::as_str);
        matches!(
            msgtype,
            Some("m.text" | "m.notice" | "m.emote" | "m.file" | "m.image" | "m.audio" | "m.video")
        ) && content
            .get("body")
            .and_then(serde_json::Value::as_str)
            .is_some()
    }

    async fn timeline_values(
        room: &Room,
        minimum_base_messages: usize,
        before_id: Option<&str>,
    ) -> BackendResult<Vec<serde_json::Value>> {
        const PAGE_SIZE: u32 = 100;
        const MAX_EVENTS: usize = 10_000;

        let mut values = Vec::new();
        let mut from = None;
        let mut anchor_seen = before_id.is_none();
        let mut qualifying_messages = 0_usize;

        loop {
            let mut options = MessagesOptions::backward();
            options.limit = PAGE_SIZE.into();
            options.from = from;
            let response = room.messages(options).await.map_err(Self::map_error)?;
            if response.chunk.is_empty() {
                break;
            }

            for event in response.chunk {
                let value = match event.raw().deserialize_as::<serde_json::Value>() {
                    Ok(value) => value,
                    Err(error) => {
                        tracing::warn!(target: "mesh::matrix", "Skipping malformed timeline event: {error}");
                        continue;
                    }
                };
                let event_id = value.get("event_id").and_then(serde_json::Value::as_str);
                let legacy_message_id = Self::legacy_message_id(&value);
                if !anchor_seen
                    && (event_id == before_id || legacy_message_id.as_deref() == before_id)
                {
                    anchor_seen = true;
                } else if anchor_seen
                    && (Self::is_base_text_message(&value) || legacy_message_id.is_some())
                {
                    qualifying_messages += 1;
                }
                values.push(value);
            }

            if qualifying_messages >= minimum_base_messages || values.len() >= MAX_EVENTS {
                break;
            }
            let Some(next) = response.end else {
                break;
            };
            from = Some(next);
        }

        Ok(values)
    }

    fn visible_message_body(content: &serde_json::Value) -> Option<String> {
        let body = content.get("body")?.as_str()?;
        let is_reply = content
            .get("m.relates_to")
            .and_then(|relation| relation.get("m.in_reply_to"))
            .is_some();
        if is_reply && body.starts_with('>') {
            if let Some((_, visible)) = body.split_once("\n\n") {
                return Some(visible.to_owned());
            }
        }
        Some(body.to_owned())
    }

    fn queued_event_content(echo: &LocalEcho) -> Option<(&serde_json::value::RawValue, u64, bool)> {
        let LocalEchoContent::Event {
            serialized_event,
            send_handle,
            send_error,
        } = &echo.content
        else {
            return None;
        };
        let (raw, event_type) = serialized_event.raw();
        if event_type != "m.room.message" {
            return None;
        }
        Some((
            raw.json(),
            send_handle.created_at.get().into(),
            send_error.is_some(),
        ))
    }

    fn queued_event_value(echo: &LocalEcho) -> Option<(serde_json::Value, u64, bool)> {
        let (raw, created_at, failed) = Self::queued_event_content(echo)?;
        let content = serde_json::from_str(raw.get()).ok()?;
        Some((content, created_at, failed))
    }

    fn queued_client_request_id(echo: &LocalEcho) -> Option<String> {
        let (content, _, _) = Self::queued_event_value(echo)?;
        let client_request_id = content.get(CLIENT_REQUEST_ID_KEY)?.as_str()?.to_owned();
        Self::validate_transaction_id(&client_request_id).ok()?;
        Some(client_request_id)
    }

    fn is_supported_queued_content(content: &serde_json::Value) -> bool {
        content.get("msgtype").and_then(serde_json::Value::as_str) == Some("m.text")
            && Self::visible_message_body(content).is_some_and(|body| !body.trim().is_empty())
            && content
                .get(CLIENT_REQUEST_ID_KEY)
                .and_then(serde_json::Value::as_str)
                .is_some_and(|identifier| Self::validate_transaction_id(identifier).is_ok())
    }

    fn is_supported_queued_text(echo: &LocalEcho) -> bool {
        let Some((content, _, _)) = Self::queued_event_value(echo) else {
            return false;
        };
        Self::is_supported_queued_content(&content)
    }

    async fn queued_message_from_local_echo(
        client: &Client,
        room: &Room,
        echo: &LocalEcho,
    ) -> BackendResult<Option<MessageDto>> {
        let Some((content, created_at, failed)) = Self::queued_event_value(echo) else {
            return Ok(None);
        };
        if content.get("msgtype").and_then(serde_json::Value::as_str) != Some("m.text") {
            return Ok(None);
        }
        let Some(body) = Self::visible_message_body(&content) else {
            return Ok(None);
        };
        if body.trim().is_empty() {
            return Ok(None);
        }
        let Some(client_request_id) = content
            .get(CLIENT_REQUEST_ID_KEY)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
        else {
            return Ok(None);
        };
        Self::validate_transaction_id(&client_request_id)?;
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let display_name = room
            .get_member(own_user_id)
            .await
            .map_err(Self::map_error)?
            .map(|member| member.name().to_owned())
            .unwrap_or_else(|| own_user_id.localpart().to_owned());
        let reply_to_id = content
            .get("m.relates_to")
            .and_then(|relation| relation.get("m.in_reply_to"))
            .and_then(|reply| reply.get("event_id"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);

        Ok(Some(MessageDto {
            id: echo.transaction_id.to_string(),
            channel_id: room.room_id().to_string(),
            author_public_key: own_user_id.to_string(),
            author_display_name: display_name,
            author_avatar_color: Self::avatar_color(own_user_id.as_str()),
            content: body,
            attachments: Vec::new(),
            reactions: HashMap::new(),
            timestamp: Self::timestamp_from_millis(Some(created_at)),
            signature: String::new(),
            edited_at: None,
            deleted_at: None,
            reply_to_id,
            transaction_id: Some(echo.transaction_id.to_string()),
            client_request_id: Some(client_request_id),
            delivery_status: Some(if failed { "failed" } else { "pending" }.into()),
        }))
    }

    async fn queued_messages_for_client(client: &Client) -> BackendResult<Vec<MessageDto>> {
        let echoes_by_room = client
            .send_queue()
            .local_echoes()
            .await
            .map_err(Self::map_error)?;
        let mut messages = Vec::new();
        for (room_id, echoes) in echoes_by_room {
            let Ok(room) =
                Self::existing_protected_text_channel(client, &room_id, "reading queued messages")
                    .await
            else {
                continue;
            };
            for echo in echoes {
                if let Some(message) =
                    Self::queued_message_from_local_echo(client, &room, &echo).await?
                {
                    messages.push(message);
                }
            }
        }
        messages.sort_by(|left, right| {
            left.timestamp
                .cmp(&right.timestamp)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(messages)
    }

    async fn reconcile_protected_send_queues(client: &Client) -> BackendResult<()> {
        let echoes_by_room = client
            .send_queue()
            .local_echoes()
            .await
            .map_err(Self::map_error)?;
        for (room_id, echoes) in echoes_by_room {
            let Some(room) = client
                .rooms()
                .into_iter()
                .find(|room| room.room_id() == room_id)
            else {
                continue;
            };
            let protected = Self::existing_protected_text_channel(
                client,
                &room_id,
                "resuming queued message delivery",
            )
            .await
            .is_ok();
            let supported = !echoes.is_empty() && echoes.iter().all(Self::is_supported_queued_text);
            room.send_queue().set_enabled(protected && supported);
            if !protected || !supported {
                tracing::warn!(
                    target: "mesh::security",
                    room_id = %room_id,
                    "Kept a persisted send queue disabled because its room or content could not be verified"
                );
            }
        }
        Ok(())
    }

    async fn resnapshot_send_queue_updates(
        client: &Client,
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
        known: &Arc<Mutex<HashMap<String, HashSet<String>>>>,
    ) -> BackendResult<()> {
        let messages = Self::queued_messages_for_client(client).await?;
        let mut current = HashMap::<String, HashSet<String>>::new();
        let mut updates = Vec::with_capacity(messages.len());
        for message in messages {
            let Some(transaction_id) = message.transaction_id.clone() else {
                continue;
            };
            current
                .entry(message.channel_id.clone())
                .or_default()
                .insert(transaction_id.clone());
            updates.push(MatrixQueuedMessageUpdate {
                room_id: message.channel_id.clone(),
                transaction_id,
                state: if message.delivery_status.as_deref() == Some("failed") {
                    MatrixQueuedMessageState::Failed
                } else {
                    MatrixQueuedMessageState::Pending
                },
                event_id: None,
                message: Some(message),
            });
        }

        let removed = {
            let mut previous = known.lock().await;
            let mut removed = Vec::new();
            for (room_id, transaction_ids) in previous.iter() {
                for transaction_id in transaction_ids {
                    if !current
                        .get(room_id)
                        .is_some_and(|current_ids| current_ids.contains(transaction_id))
                    {
                        removed.push((room_id.clone(), transaction_id.clone()));
                    }
                }
            }
            *previous = current;
            removed
        };

        for update in updates {
            Self::dispatch_backend_event(
                callback,
                MatrixBackendEvent::QueuedMessage(Box::new(update)),
            );
        }
        // A lagged stream cannot distinguish a missed successful send from a
        // missed cancellation. Removing the stale local row is authoritative;
        // a successful event is restored by the encrypted timeline.
        for (room_id, transaction_id) in removed {
            Self::dispatch_backend_event(
                callback,
                MatrixBackendEvent::QueuedMessage(Box::new(MatrixQueuedMessageUpdate {
                    room_id,
                    transaction_id,
                    state: MatrixQueuedMessageState::Cancelled,
                    event_id: None,
                    message: None,
                })),
            );
        }
        Ok(())
    }

    async fn dispatch_send_queue_update(
        client: &Client,
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
        known: &Arc<Mutex<HashMap<String, HashSet<String>>>>,
        update: SendQueueUpdate,
    ) {
        let Ok(room) = Self::existing_protected_text_channel(
            client,
            &update.room_id,
            "updating queued message delivery",
        )
        .await
        else {
            return;
        };
        let (queued_update, requires_known) = match update.update {
            RoomSendQueueUpdate::NewLocalEvent(echo) => {
                let transaction_id = echo.transaction_id.to_string();
                match Self::queued_message_from_local_echo(client, &room, &echo).await {
                    Ok(Some(message)) => (
                        MatrixQueuedMessageUpdate {
                            room_id: update.room_id.to_string(),
                            transaction_id,
                            state: if message.delivery_status.as_deref() == Some("failed") {
                                MatrixQueuedMessageState::Failed
                            } else {
                                MatrixQueuedMessageState::Pending
                            },
                            event_id: None,
                            message: Some(message),
                        },
                        false,
                    ),
                    Ok(None) => return,
                    Err(error) => {
                        tracing::warn!(
                            target: "mesh::matrix",
                            room_id = %update.room_id,
                            "Could not project a queued message: {error}"
                        );
                        return;
                    }
                }
            }
            RoomSendQueueUpdate::SendError {
                transaction_id,
                is_recoverable,
                ..
            } => (
                MatrixQueuedMessageUpdate {
                    room_id: update.room_id.to_string(),
                    transaction_id: transaction_id.to_string(),
                    state: if is_recoverable {
                        MatrixQueuedMessageState::Pending
                    } else {
                        MatrixQueuedMessageState::Failed
                    },
                    event_id: None,
                    message: None,
                },
                true,
            ),
            RoomSendQueueUpdate::RetryEvent { transaction_id } => (
                MatrixQueuedMessageUpdate {
                    room_id: update.room_id.to_string(),
                    transaction_id: transaction_id.to_string(),
                    state: MatrixQueuedMessageState::Pending,
                    event_id: None,
                    message: None,
                },
                true,
            ),
            RoomSendQueueUpdate::SentEvent {
                transaction_id,
                event_id,
            } => (
                MatrixQueuedMessageUpdate {
                    room_id: update.room_id.to_string(),
                    transaction_id: transaction_id.to_string(),
                    state: MatrixQueuedMessageState::Sent,
                    event_id: Some(event_id.to_string()),
                    message: None,
                },
                true,
            ),
            RoomSendQueueUpdate::CancelledLocalEvent { transaction_id } => (
                MatrixQueuedMessageUpdate {
                    room_id: update.room_id.to_string(),
                    transaction_id: transaction_id.to_string(),
                    state: MatrixQueuedMessageState::Cancelled,
                    event_id: None,
                    message: None,
                },
                true,
            ),
            RoomSendQueueUpdate::ReplacedLocalEvent { .. } => {
                if let Err(error) =
                    Self::resnapshot_send_queue_updates(client, callback, known).await
                {
                    tracing::warn!(
                        target: "mesh::matrix",
                        room_id = %update.room_id,
                        "Could not reconcile a replaced queued message: {error}"
                    );
                }
                return;
            }
            RoomSendQueueUpdate::MediaUpload { .. } => return,
        };

        {
            let mut known = known.lock().await;
            let room_transactions = known.entry(queued_update.room_id.clone()).or_default();
            if requires_known && !room_transactions.contains(&queued_update.transaction_id) {
                return;
            }
            match queued_update.state {
                MatrixQueuedMessageState::Pending | MatrixQueuedMessageState::Failed => {
                    room_transactions.insert(queued_update.transaction_id.clone());
                }
                MatrixQueuedMessageState::Sent | MatrixQueuedMessageState::Cancelled => {
                    room_transactions.remove(&queued_update.transaction_id);
                }
            }
            if room_transactions.is_empty() {
                known.remove(&queued_update.room_id);
            }
        }
        Self::dispatch_backend_event(
            callback,
            MatrixBackendEvent::QueuedMessage(Box::new(queued_update)),
        );
    }

    fn spawn_send_queue_task(
        client: Client,
        reconcile: Arc<Notify>,
        gate: Arc<Mutex<()>>,
        known: Arc<Mutex<HashMap<String, HashSet<String>>>>,
        callback: Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
    ) -> JoinHandle<()> {
        let mut updates = client.send_queue().subscribe();
        tokio::spawn(async move {
            if let Err(error) =
                Self::resnapshot_send_queue_updates(&client, &callback, &known).await
            {
                tracing::warn!(
                    target: "mesh::matrix",
                    "Could not restore saved message state: {error}"
                );
            }
            loop {
                tokio::select! {
                    _ = reconcile.notified() => {
                        let _gate = gate.lock().await;
                        if let Err(error) = Self::reconcile_protected_send_queues(&client).await {
                            tracing::warn!(
                                target: "mesh::matrix",
                                "Could not reconcile protected message queues: {error}"
                            );
                        }
                    }
                    update = updates.recv() => {
                        match update {
                            Ok(update) => {
                                Self::dispatch_send_queue_update(
                                    &client,
                                    &callback,
                                    &known,
                                    update,
                                )
                                .await;
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                                tracing::warn!(
                                    target: "mesh::matrix",
                                    skipped,
                                    "Queued-message update stream lagged; reconciling durable state"
                                );
                                let _gate = gate.lock().await;
                                if let Err(error) =
                                    Self::reconcile_protected_send_queues(&client).await
                                {
                                    tracing::warn!(
                                        target: "mesh::matrix",
                                        "Could not reconcile queued messages after lag: {error}"
                                    );
                                }
                                if let Err(error) =
                                    Self::resnapshot_send_queue_updates(
                                        &client,
                                        &callback,
                                        &known,
                                    )
                                    .await
                                {
                                    tracing::warn!(
                                        target: "mesh::matrix",
                                        "Could not restore queued message state after lag: {error}"
                                    );
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }
            }
        })
    }

    fn project_legacy_message(room_id: &str, value: &serde_json::Value) -> Option<MessageDto> {
        if value.get("type").and_then(serde_json::Value::as_str)
            != Some(crate::backend::LEGACY_MATRIX_EVENT_TYPE)
        {
            return None;
        }
        let content = value.get("content")?;
        let status = content
            .get("conflictStatus")
            .and_then(serde_json::Value::as_str)?;
        if status == "approved_non_selected_variant" {
            return None;
        }
        let record = content.get("record")?;
        if record.get("kind").and_then(serde_json::Value::as_str) != Some("message") {
            return None;
        }
        let payload = record.get("payload")?;
        let id = Self::legacy_message_id(value)?;
        let author = payload
            .get("authorPublicKey")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("legacy:unknown")
            .to_owned();
        let attachments = payload
            .get("attachments")
            .cloned()
            .and_then(|attachments| serde_json::from_value::<Vec<AttachmentDto>>(attachments).ok())
            .unwrap_or_default();
        let original_timestamp = record
            .get("originalTimestamp")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| Self::event_timestamp(value));
        let deleted_at = payload
            .get("deletedAt")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);

        Some(MessageDto {
            id,
            channel_id: room_id.to_owned(),
            author_public_key: author.clone(),
            author_display_name: payload
                .get("authorDisplayName")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Legacy member")
                .to_owned(),
            author_avatar_color: payload
                .get("authorAvatarColor")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| Self::avatar_color(&author)),
            content: if deleted_at.is_some() {
                String::new()
            } else {
                payload
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            },
            attachments,
            reactions: payload
                .get("reactions")
                .cloned()
                .and_then(|reactions| serde_json::from_value(reactions).ok())
                .unwrap_or_default(),
            timestamp: original_timestamp,
            signature: record
                .get("originalSignature")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            edited_at: payload
                .get("editedAt")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            deleted_at,
            reply_to_id: payload
                .get("replyToId")
                .and_then(serde_json::Value::as_str)
                .map(|reply| format!("legacy-reply:{reply}")),
            transaction_id: None,
            client_request_id: None,
            delivery_status: Some("imported".into()),
        })
    }

    fn legacy_message_id(value: &serde_json::Value) -> Option<String> {
        if value.get("type").and_then(serde_json::Value::as_str)
            != Some(crate::backend::LEGACY_MATRIX_EVENT_TYPE)
        {
            return None;
        }
        let content = value.get("content")?;
        if content
            .get("conflictStatus")
            .and_then(serde_json::Value::as_str)
            == Some("approved_non_selected_variant")
        {
            return None;
        }
        let record = content.get("record")?;
        if record.get("kind").and_then(serde_json::Value::as_str) != Some("message") {
            return None;
        }
        record
            .get("entityId")
            .and_then(serde_json::Value::as_str)
            .map(|entity_id| format!("legacy:{entity_id}"))
    }

    fn project_timeline(
        room_id: &str,
        members: &HashMap<String, String>,
        mut values: Vec<serde_json::Value>,
    ) -> Vec<MessageDto> {
        values.sort_by(|left, right| {
            left.get("origin_server_ts")
                .and_then(serde_json::Value::as_u64)
                .cmp(
                    &right
                        .get("origin_server_ts")
                        .and_then(serde_json::Value::as_u64),
                )
                .then_with(|| {
                    left.get("event_id")
                        .and_then(serde_json::Value::as_str)
                        .cmp(&right.get("event_id").and_then(serde_json::Value::as_str))
                })
        });

        let mut messages = HashMap::<String, MessageDto>::new();
        let mut ordered_ids = Vec::new();

        for value in &values {
            if let Some(message) = Self::project_legacy_message(room_id, value) {
                ordered_ids.push(message.id.clone());
                messages.insert(message.id.clone(), message);
                continue;
            }
            if !Self::is_base_text_message(value) {
                continue;
            }
            let Some(event_id) = value
                .get("event_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            let Some(content) = value.get("content") else {
                continue;
            };
            let Some(body) = Self::visible_message_body(content) else {
                continue;
            };
            let sender = value
                .get("sender")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("@unknown:invalid")
                .to_owned();
            let timestamp = Self::event_timestamp(value);
            let redacted = value
                .get("unsigned")
                .and_then(|unsigned| unsigned.get("redacted_because"))
                .is_some();
            let reply_to_id = content
                .get("m.relates_to")
                .and_then(|relation| relation.get("m.in_reply_to"))
                .and_then(|reply| reply.get("event_id"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let transaction_id = value
                .get("unsigned")
                .and_then(|unsigned| unsigned.get("transaction_id"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let client_request_id = content
                .get(CLIENT_REQUEST_ID_KEY)
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);

            ordered_ids.push(event_id.clone());
            messages.insert(
                event_id.clone(),
                MessageDto {
                    id: event_id,
                    channel_id: room_id.to_owned(),
                    author_public_key: sender.clone(),
                    author_display_name: members.get(&sender).cloned().unwrap_or_else(|| {
                        sender
                            .split(':')
                            .next()
                            .unwrap_or(&sender)
                            .trim_start_matches('@')
                            .to_owned()
                    }),
                    author_avatar_color: Self::avatar_color(&sender),
                    content: if redacted { String::new() } else { body },
                    attachments: Self::matrix_attachment_from_content(content)
                        .into_iter()
                        .collect(),
                    reactions: HashMap::new(),
                    timestamp: timestamp.clone(),
                    signature: String::new(),
                    edited_at: None,
                    deleted_at: redacted.then_some(timestamp),
                    reply_to_id,
                    transaction_id,
                    client_request_id,
                    delivery_status: Some("sent".into()),
                },
            );
        }

        let mut reaction_events = HashMap::<String, (String, String, String)>::new();
        let mut redacted_events = HashSet::<String>::new();
        for value in &values {
            let event_type = value
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let event_id = value
                .get("event_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let sender = value
                .get("sender")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("@unknown:invalid");
            let timestamp = Self::event_timestamp(value);

            match event_type {
                "m.room.message" => {
                    let Some(content) = value.get("content") else {
                        continue;
                    };
                    let relation = content.get("m.relates_to");
                    if relation
                        .and_then(|relation| relation.get("rel_type"))
                        .and_then(serde_json::Value::as_str)
                        != Some("m.replace")
                    {
                        continue;
                    }
                    let Some(target_id) = relation
                        .and_then(|relation| relation.get("event_id"))
                        .and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    let Some(message) = messages.get_mut(target_id) else {
                        continue;
                    };
                    if message.author_public_key != sender || message.deleted_at.is_some() {
                        continue;
                    }
                    let replacement = relation
                        .and_then(|relation| relation.get("m.new_content"))
                        .or_else(|| content.get("m.new_content"));
                    if let Some(body) = replacement
                        .and_then(|content| content.get("body"))
                        .and_then(serde_json::Value::as_str)
                    {
                        message.content = body.to_owned();
                        message.edited_at = Some(timestamp);
                    }
                }
                "m.reaction" => {
                    let redacted = value
                        .get("unsigned")
                        .and_then(|unsigned| unsigned.get("redacted_because"))
                        .is_some();
                    let relation = value
                        .get("content")
                        .and_then(|content| content.get("m.relates_to"));
                    let Some(target_id) = relation
                        .and_then(|relation| relation.get("event_id"))
                        .and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    let Some(key) = relation
                        .and_then(|relation| relation.get("key"))
                        .and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    reaction_events.insert(
                        event_id.to_owned(),
                        (target_id.to_owned(), key.to_owned(), sender.to_owned()),
                    );
                    if !redacted {
                        if let Some(message) = messages.get_mut(target_id) {
                            let authors = message.reactions.entry(key.to_owned()).or_default();
                            if !authors.iter().any(|author| author == sender) {
                                authors.push(sender.to_owned());
                            }
                        }
                    }
                }
                "m.room.redaction" => {
                    let target_id = value
                        .get("redacts")
                        .or_else(|| {
                            value
                                .get("content")
                                .and_then(|content| content.get("redacts"))
                        })
                        .and_then(serde_json::Value::as_str);
                    if let Some(target_id) = target_id {
                        redacted_events.insert(target_id.to_owned());
                        if let Some(message) = messages.get_mut(target_id) {
                            message.content.clear();
                            message.deleted_at = Some(timestamp);
                        }
                    }
                }
                _ => {}
            }
        }

        for reaction_event_id in redacted_events {
            let Some((target_id, key, sender)) = reaction_events.get(&reaction_event_id) else {
                continue;
            };
            let Some(message) = messages.get_mut(target_id) else {
                continue;
            };
            if let Some(authors) = message.reactions.get_mut(key) {
                authors.retain(|author| author != sender);
                if authors.is_empty() {
                    message.reactions.remove(key);
                }
            }
        }

        let mut projected = ordered_ids
            .into_iter()
            .filter_map(|event_id| messages.remove(&event_id))
            .collect::<Vec<_>>();
        projected.sort_by(|left, right| {
            left.timestamp
                .cmp(&right.timestamp)
                .then_with(|| left.id.cmp(&right.id))
        });
        projected
    }
}
