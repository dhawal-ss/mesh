const MAX_SEND_QUEUE_ACCOUNT_MESSAGES: usize = 512;
const MAX_SEND_QUEUE_ROOM_MESSAGES: usize = 128;
const MAX_SEND_QUEUE_ACCOUNT_UTF8_BYTES: usize = 4 * 1024 * 1024;
const MAX_SEND_QUEUE_ROOM_UTF8_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct SendQueueUsage {
    messages: usize,
    utf8_bytes: usize,
    exceeded: bool,
}

struct TimelineValuesPage {
    values: Vec<serde_json::Value>,
    anchor_seen: bool,
    reached_start: bool,
    qualifying_messages: usize,
}

impl MatrixBackend {
    const UNDECRYPTABLE_REASON_KEY: &'static str = "org.mesh.undecryptable_reason";
    const MAX_ROOM_UPGRADE_HOPS: usize = 16;

    fn bounded_send_queue_usage_bytes(
        utf8_bytes: impl IntoIterator<Item = usize>,
        max_messages: usize,
        max_utf8_bytes: usize,
    ) -> SendQueueUsage {
        let mut usage = SendQueueUsage::default();
        for item_bytes in utf8_bytes {
            if usage.messages >= max_messages
                || item_bytes > max_utf8_bytes.saturating_sub(usage.utf8_bytes)
            {
                usage.exceeded = true;
                break;
            }
            usage.messages += 1;
            usage.utf8_bytes += item_bytes;
        }
        usage
    }

    fn queued_echo_utf8_bytes(echo: &LocalEcho) -> usize {
        match &echo.content {
            LocalEchoContent::Event {
                serialized_event, ..
            } => serialized_event.raw().0.json().get().len(),
            LocalEchoContent::React {
                key, applies_to, ..
            } => key.len().saturating_add(applies_to.as_str().len()),
            LocalEchoContent::Redaction {
                redacts, reason, ..
            } => redacts
                .as_str()
                .len()
                .saturating_add(reason.as_deref().map_or(0, str::len)),
        }
    }

    fn bounded_send_queue_usage<'a>(
        echoes: impl IntoIterator<Item = &'a LocalEcho>,
        max_messages: usize,
        max_utf8_bytes: usize,
    ) -> SendQueueUsage {
        Self::bounded_send_queue_usage_bytes(
            echoes.into_iter().map(Self::queued_echo_utf8_bytes),
            max_messages,
            max_utf8_bytes,
        )
    }

    fn send_queue_quota_error(scope: &str, quota: &str) -> BackendError {
        BackendError::InvalidConfiguration(format!(
            "Messages waiting to send for this {scope} have reached the {quota} offline queue limit. Wait for them to send or cancel one before trying again."
        ))
    }

    fn ensure_send_queue_capacity(
        account: SendQueueUsage,
        room: SendQueueUsage,
        candidate_utf8_bytes: usize,
    ) -> BackendResult<()> {
        if room.exceeded || room.messages >= MAX_SEND_QUEUE_ROOM_MESSAGES {
            return Err(Self::send_queue_quota_error(
                "room",
                &format!("{MAX_SEND_QUEUE_ROOM_MESSAGES}-message"),
            ));
        }
        if account.exceeded || account.messages >= MAX_SEND_QUEUE_ACCOUNT_MESSAGES {
            return Err(Self::send_queue_quota_error(
                "account",
                &format!("{MAX_SEND_QUEUE_ACCOUNT_MESSAGES}-message"),
            ));
        }
        if candidate_utf8_bytes
            > MAX_SEND_QUEUE_ROOM_UTF8_BYTES.saturating_sub(room.utf8_bytes)
        {
            return Err(Self::send_queue_quota_error("room", "1 MiB"));
        }
        if candidate_utf8_bytes
            > MAX_SEND_QUEUE_ACCOUNT_UTF8_BYTES.saturating_sub(account.utf8_bytes)
        {
            return Err(Self::send_queue_quota_error("account", "4 MiB"));
        }
        Ok(())
    }

    fn receipt_thread_for_message(is_thread_event: bool) -> ReceiptThread {
        if is_thread_event {
            ReceiptThread::Main
        } else {
            ReceiptThread::Unthreaded
        }
    }

    fn can_follow_upgrade_predecessor(predecessor_rooms_visited: usize) -> bool {
        predecessor_rooms_visited < Self::MAX_ROOM_UPGRADE_HOPS
    }

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
        ignored_users: &Arc<RwLock<Option<HashSet<OwnedUserId>>>>,
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
        let direct_targets = room.direct_targets();
        if !direct_targets.is_empty() {
            let suppress = if direct_targets.len() == 1 {
                let peer = direct_targets.iter().next().expect("one direct target");
                match matrix_sdk::ruma::UserId::parse(peer.as_str()) {
                    Ok(peer) => Self::notification_sender_is_ignored(
                        ignored_users.read().await.as_ref(),
                        &peer,
                    ),
                    Err(_) => true,
                }
            } else {
                tracing::warn!(
                    target: "mesh::security",
                    room_id = %room.room_id(),
                    "Cleared unread state for an unsupported group direct-message room"
                );
                true
            };
            if suppress {
                // Emit zero rather than dropping the update so a badge cached
                // before the block cannot remain visible indefinitely.
                Self::dispatch_backend_event(
                    callback,
                    MatrixBackendEvent::UnreadUpdate(MatrixUnreadUpdate {
                        room_id: room.room_id().to_string(),
                        unread_messages: 0,
                        unread_mentions: 0,
                    }),
                );
                return;
            }
        }
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
        ignored_users: &Arc<RwLock<Option<HashSet<OwnedUserId>>>>,
    ) {
        for room in client.rooms() {
            Self::emit_room_unread(client, callback, ignored_users, room.room_id()).await;
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

    fn is_undecryptable_message(value: &serde_json::Value) -> bool {
        value.get("type").and_then(serde_json::Value::as_str) == Some("m.room.encrypted")
            && value.get(Self::UNDECRYPTABLE_REASON_KEY).is_some()
    }

    fn is_ignored_non_state_event(
        value: &serde_json::Value,
        ignored_users: &IgnoredUserListEventContent,
    ) -> bool {
        // Matrix explicitly exempts state events from ignore filtering. This
        // boundary only removes message-like timeline events from renderer
        // projection; it does not redact or mutate stored room history.
        if value.get("state_key").is_some() {
            return false;
        }
        let Some(sender) = value.get("sender").and_then(serde_json::Value::as_str) else {
            return false;
        };
        ignored_users
            .ignored_users
            .keys()
            .any(|user_id| user_id.as_str() == sender)
    }

    fn product_decryption_reason(
        raw_event: &matrix_sdk::deserialized_responses::TimelineEventKind,
        context: matrix_sdk_crypto::types::events::CryptoContextInfo,
    ) -> UndecryptableMessageReason {
        let TimelineEventKind::UnableToDecrypt { event, utd_info } = raw_event else {
            return UndecryptableMessageReason::CouldNotDecrypt;
        };

        let cause = matrix_sdk_crypto::types::events::UtdCause::determine(
            event,
            context,
            utd_info,
        );
        match cause {
            matrix_sdk_crypto::types::events::UtdCause::SentBeforeWeJoined
            | matrix_sdk_crypto::types::events::UtdCause::HistoricalMessageAndBackupIsDisabled
            | matrix_sdk_crypto::types::events::UtdCause::HistoricalMessageAndDeviceIsUnverified => {
                UndecryptableMessageReason::SentBeforeDevice
            }
            matrix_sdk_crypto::types::events::UtdCause::WithheldBySender
            | matrix_sdk_crypto::types::events::UtdCause::WithheldForUnverifiedOrInsecureDevice
            | matrix_sdk_crypto::types::events::UtdCause::VerificationViolation
            | matrix_sdk_crypto::types::events::UtdCause::UnsignedDevice
            | matrix_sdk_crypto::types::events::UtdCause::UnknownDevice => {
                UndecryptableMessageReason::KeysNotShared
            }
            matrix_sdk_crypto::types::events::UtdCause::Unknown => match &utd_info.reason {
                matrix_sdk::deserialized_responses::UnableToDecryptReason::MissingMegolmSession {
                    withheld_code: None,
                }
                | matrix_sdk::deserialized_responses::UnableToDecryptReason::UnknownMegolmMessageIndex => {
                    UndecryptableMessageReason::WaitingForKeys
                }
                _ => UndecryptableMessageReason::CouldNotDecrypt,
            },
        }
    }

    fn undecryptable_reason(value: &serde_json::Value) -> UndecryptableMessageReason {
        value
            .get(Self::UNDECRYPTABLE_REASON_KEY)
            .cloned()
            .and_then(|reason| serde_json::from_value(reason).ok())
            .unwrap_or(UndecryptableMessageReason::CouldNotDecrypt)
    }

    async fn timeline_values_page(
        room: &Room,
        minimum_base_messages: usize,
        before_id: Option<&str>,
    ) -> BackendResult<TimelineValuesPage> {
        const PAGE_SIZE: u32 = 100;
        const MAX_EVENTS: usize = 10_000;

        let mut values = Vec::new();
        let mut from = None;
        let mut anchor_seen = before_id.is_none();
        let mut qualifying_messages = 0_usize;
        let mut reached_start = false;
        let crypto_context = room.crypto_context_info().await;

        loop {
            let mut options = MessagesOptions::backward();
            options.limit = PAGE_SIZE.into();
            options.from = from;
            let response = room.messages(options).await.map_err(Self::map_error)?;
            if response.chunk.is_empty() {
                reached_start = true;
                break;
            }

            for event in response.chunk {
                let mut value = match event.raw().deserialize_as::<serde_json::Value>() {
                    Ok(value) => value,
                    Err(error) => {
                        tracing::warn!(target: "mesh::matrix", "Skipping malformed timeline event: {error}");
                        continue;
                    }
                };
                if matches!(&event.kind, TimelineEventKind::UnableToDecrypt { .. }) {
                    if let Some(object) = value.as_object_mut() {
                        object.insert(
                            Self::UNDECRYPTABLE_REASON_KEY.to_owned(),
                            serde_json::to_value(Self::product_decryption_reason(
                                &event.kind,
                                crypto_context,
                            ))
                            .unwrap_or_else(|_| {
                                serde_json::Value::String("could-not-decrypt".into())
                            }),
                        );
                    }
                }
                let event_id = value.get("event_id").and_then(serde_json::Value::as_str);
                let legacy_message_id = Self::legacy_message_id(&value);
                if !anchor_seen
                    && (event_id == before_id || legacy_message_id.as_deref() == before_id)
                {
                    anchor_seen = true;
                } else if anchor_seen
                    && (Self::is_base_text_message(&value)
                        || Self::is_undecryptable_message(&value)
                        || legacy_message_id.is_some())
                {
                    qualifying_messages += 1;
                }
                values.push(value);
            }

            if qualifying_messages >= minimum_base_messages || values.len() >= MAX_EVENTS {
                break;
            }
            let Some(next) = response.end else {
                reached_start = true;
                break;
            };
            from = Some(next);
        }

        Ok(TimelineValuesPage {
            values,
            anchor_seen,
            reached_start,
            qualifying_messages,
        })
    }

    async fn timeline_values(
        room: &Room,
        minimum_base_messages: usize,
        before_id: Option<&str>,
    ) -> BackendResult<Vec<serde_json::Value>> {
        Ok(Self::timeline_values_page(room, minimum_base_messages, before_id)
            .await?
            .values)
    }

    async fn timeline_values_with_predecessors(
        &self,
        client: &Client,
        room: &Room,
        minimum_base_messages: usize,
        before_id: Option<&str>,
    ) -> BackendResult<Vec<serde_json::Value>> {
        let mut current = room.clone();
        let mut values = Vec::new();
        let mut remaining = minimum_base_messages;
        let mut seeking_anchor = before_id.is_some();
        let mut anchor = before_id;
        let mut visited = BTreeSet::new();
        let mut predecessor_rooms_visited = 0_usize;

        loop {
            if !visited.insert(current.room_id().to_string()) {
                break;
            }

            let page = Self::timeline_values_page(&current, remaining.max(1), anchor).await?;
            if !seeking_anchor || page.anchor_seen {
                remaining = remaining.saturating_sub(page.qualifying_messages);
                values.extend(page.values);
                if remaining == 0 || !page.reached_start {
                    break;
                }
                seeking_anchor = false;
                anchor = None;
            }

            if !Self::can_follow_upgrade_predecessor(predecessor_rooms_visited) {
                break;
            }
            let mut predecessor_room_id =
                current.predecessor_room().map(|room| room.room_id);
            if predecessor_room_id.is_none() {
                predecessor_room_id =
                    self.verified_room_upgrades
                        .read()
                        .await
                        .iter()
                        .find_map(|(predecessor, replacement)| {
                            (replacement == current.room_id()).then(|| predecessor.clone())
                        });
            }
            if predecessor_room_id.is_none() {
                predecessor_room_id = self
                    .cache_verified_room_upgrade(
                        client,
                        &current,
                        "reading room upgrade predecessor history",
                    )
                    .await?;
            }
            let Some(predecessor_room_id) = predecessor_room_id else {
                break;
            };
            let predecessor = match Self::protected_joined_room(
                client,
                &predecessor_room_id,
                "reading room upgrade predecessor history",
            )
            .await
            {
                Ok(room) => room,
                Err(error) => {
                    tracing::debug!(
                        target: "mesh::matrix",
                        room_id = %predecessor_room_id,
                        "Room upgrade predecessor is not available through the protected room guard: {error}"
                    );
                    break;
                }
            };
            current = predecessor;
            predecessor_rooms_visited += 1;
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

    fn thread_root_id(content: &serde_json::Value) -> Option<String> {
        let relation = content.get("m.relates_to")?;
        (relation.get("rel_type").and_then(serde_json::Value::as_str) == Some("m.thread"))
            .then(|| relation.get("event_id"))
            .flatten()
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
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

    fn queued_local_echo_from_updates(
        updates: &mut tokio::sync::broadcast::Receiver<SendQueueUpdate>,
        room_id: &RoomId,
        client_request_id: &str,
    ) -> Option<LocalEcho> {
        loop {
            match updates.try_recv() {
                Ok(update) => {
                    if update.room_id != room_id {
                        continue;
                    }
                    let RoomSendQueueUpdate::NewLocalEvent(echo) = update.update else {
                        continue;
                    };
                    if Self::queued_client_request_id(&echo).as_deref()
                        == Some(client_request_id)
                    {
                        return Some(echo);
                    }
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
                | Err(tokio::sync::broadcast::error::TryRecvError::Closed)
                | Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => return None,
            }
        }
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
        let thread_root_id = Self::thread_root_id(&content);

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
            thread_root_id,
            transaction_id: Some(echo.transaction_id.to_string()),
            client_request_id: Some(client_request_id),
            delivery_status: Some(if failed { "failed" } else { "pending" }.into()),
            undecryptable: None,
        }))
    }

    async fn queued_messages_for_client(client: &Client) -> BackendResult<Vec<MessageDto>> {
        let ignored_users = Self::fetch_ignored_user_list(client).await?;
        let echoes_by_room = client
            .send_queue()
            .local_echoes()
            .await
            .map_err(Self::map_error)?;
        let mut messages = Vec::new();
        let mut account_usage = SendQueueUsage::default();
        let mut truncated = false;
        let mut rooms = echoes_by_room.into_iter().peekable();
        'rooms: while let Some((room_id, echoes)) = rooms.next() {
            if account_usage.messages >= MAX_SEND_QUEUE_ACCOUNT_MESSAGES
                || account_usage.utf8_bytes >= MAX_SEND_QUEUE_ACCOUNT_UTF8_BYTES
            {
                truncated = true;
                break;
            }
            let room =
                Self::existing_protected_text_channel(client, &room_id, "reading queued messages")
                    .await
                    .ok();
            let project_room = room
                .as_ref()
                .map(|room| Self::room_has_ignored_direct_peer(room, &ignored_users))
                .transpose()?
                != Some(true);
            if !project_room {
                // Blocked direct-room echoes are not user-visible pending
                // messages and must not consume the bounded projection budget
                // ahead of unrelated saved messages.
                continue;
            }
            let mut room_usage = SendQueueUsage::default();
            for echo in echoes {
                let echo_bytes = Self::queued_echo_utf8_bytes(&echo);
                if account_usage.messages >= MAX_SEND_QUEUE_ACCOUNT_MESSAGES
                    || echo_bytes
                        > MAX_SEND_QUEUE_ACCOUNT_UTF8_BYTES
                            .saturating_sub(account_usage.utf8_bytes)
                {
                    truncated = true;
                    break 'rooms;
                }
                account_usage.messages += 1;
                account_usage.utf8_bytes += echo_bytes;
                if room_usage.messages >= MAX_SEND_QUEUE_ROOM_MESSAGES
                    || echo_bytes
                        > MAX_SEND_QUEUE_ROOM_UTF8_BYTES
                            .saturating_sub(room_usage.utf8_bytes)
                {
                    truncated = true;
                    break;
                }
                room_usage.messages += 1;
                room_usage.utf8_bytes += echo_bytes;
                let Some(room) = room.as_ref() else {
                    continue;
                };
                if let Some(message) =
                    Self::queued_message_from_local_echo(client, room, &echo).await?
                {
                    messages.push(message);
                }
            }
            if account_usage.messages >= MAX_SEND_QUEUE_ACCOUNT_MESSAGES
                || account_usage.utf8_bytes >= MAX_SEND_QUEUE_ACCOUNT_UTF8_BYTES
            {
                truncated |= rooms.peek().is_some();
                break;
            }
        }
        if truncated {
            tracing::warn!(
                target: "mesh::security",
                "Bounded the pending-message projection because the durable queue exceeded its resource policy"
            );
        }
        messages.sort_by(|left, right| {
            left.timestamp
                .cmp(&right.timestamp)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(messages)
    }

    async fn reconcile_protected_send_queues(
        client: &Client,
        allow_resume: bool,
    ) -> BackendResult<()> {
        // Reconciliation is a fail-closed transaction. Pause the client-wide
        // queue first, validate every persisted room under the same snapshot,
        // and only then resume all queues together. This also prevents an
        // inaccessible or unencrypted legacy room from sending while another
        // room is being checked.
        let send_queue = client.send_queue();
        send_queue.set_enabled(false).await;
        let ignored_users = Self::fetch_ignored_user_list(client).await?;
        let e2ee_ready = Self::client_e2ee_ready(client).await;
        let echoes_by_room = send_queue
            .local_echoes()
            .await
            .map_err(Self::map_error)?;
        // Cancel ignored direct-room entries before applying resource limits.
        // Otherwise an over-limit hostile/legacy queue could permanently pin
        // blocked content ahead of unrelated queues and prevent recovery.
        let mut retained_echoes_by_room = HashMap::new();
        let mut all_ignored_cancelled = true;
        for (room_id, echoes) in echoes_by_room {
            let ignored_direct = match Self::existing_protected_text_channel(
                client,
                &room_id,
                "cancelling blocked direct messages",
            )
            .await
            {
                Ok(room) => match Self::room_has_ignored_direct_peer(&room, &ignored_users) {
                    Ok(ignored) => ignored,
                    Err(error) => {
                        tracing::warn!(
                            target: "mesh::security",
                            room_id = %room_id,
                            "Kept an unsupported direct-message queue disabled: {error}"
                        );
                        false
                    }
                },
                Err(_) => false,
            };
            if !ignored_direct {
                retained_echoes_by_room.insert(room_id, echoes);
                continue;
            }
            for echo in echoes {
                let LocalEchoContent::Event { send_handle, .. } = echo.content else {
                    all_ignored_cancelled = false;
                    continue;
                };
                match send_handle.abort().await {
                    Ok(true) => {}
                    Ok(false) => {
                        all_ignored_cancelled = false;
                        tracing::warn!(
                            target: "mesh::security",
                            room_id = %room_id,
                            "A blocked direct-message queue entry was already being delivered when cancellation was requested"
                        );
                    }
                    Err(error) => {
                        all_ignored_cancelled = false;
                        tracing::warn!(
                            target: "mesh::security",
                            room_id = %room_id,
                            "Could not cancel a blocked direct-message queue entry: {error}"
                        );
                    }
                }
            }
        }
        let account_usage = Self::bounded_send_queue_usage(
            retained_echoes_by_room
                .values()
                .flat_map(|echoes| echoes.iter()),
            MAX_SEND_QUEUE_ACCOUNT_MESSAGES,
            MAX_SEND_QUEUE_ACCOUNT_UTF8_BYTES,
        );
        if account_usage.exceeded {
            tracing::warn!(
                target: "mesh::security",
                messages = account_usage.messages,
                utf8_bytes = account_usage.utf8_bytes,
                "Kept persisted send queues disabled because the account queue exceeded its resource policy"
            );
            return Ok(());
        }
        let mut all_queues_supported = all_ignored_cancelled;
        for (room_id, echoes) in retained_echoes_by_room {
            let room_usage = Self::bounded_send_queue_usage(
                &echoes,
                MAX_SEND_QUEUE_ROOM_MESSAGES,
                MAX_SEND_QUEUE_ROOM_UTF8_BYTES,
            );
            let protected_room = Self::existing_protected_text_channel(
                client,
                &room_id,
                "resuming queued message delivery",
            )
            .await;
            let (ignored_direct, direct_configuration_supported) =
                match protected_room.as_ref() {
                    Ok(room) => match Self::room_has_ignored_direct_peer(room, &ignored_users) {
                        Ok(ignored) => (ignored, true),
                        Err(error) => {
                            tracing::warn!(
                                target: "mesh::security",
                                room_id = %room_id,
                                "Kept an unsupported direct-message queue disabled: {error}"
                            );
                            (false, false)
                        }
                    },
                    Err(_) => (false, true),
                };
            // The first pass removed every ignored direct room under this
            // account-data snapshot. Seeing one here means room metadata
            // changed during reconciliation, so keep all queues paused.
            let direct_configuration_supported = direct_configuration_supported && !ignored_direct;
            let protected = protected_room.is_ok();
            let supported = !room_usage.exceeded
                && !echoes.is_empty()
                && echoes.iter().all(Self::is_supported_queued_text);
            let queue_can_resume =
                e2ee_ready && protected && direct_configuration_supported && supported;
            if !queue_can_resume {
                all_queues_supported = false;
                tracing::warn!(
                    target: "mesh::security",
                    room_id = %room_id,
                    queue_over_limit = room_usage.exceeded,
                    "Kept a persisted send queue disabled because the device, room, content, or resource policy could not be verified"
                );
            }
        }
        if allow_resume && e2ee_ready && all_queues_supported {
            send_queue.set_enabled(true).await;
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
            {
                // The SDK may restore durable echoes before the first fresh
                // sync. Purge ignored direct-room entries while the client
                // queue is still globally paused; do not resume here.
                let _gate = gate.lock().await;
                if let Err(error) =
                    Self::reconcile_protected_send_queues(&client, false).await
                {
                    tracing::warn!(
                        target: "mesh::security",
                        "Could not validate saved message queues before startup: {error}"
                    );
                }
            }
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
                        if let Err(error) = Self::reconcile_protected_send_queues(&client, true).await {
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
                                    Self::reconcile_protected_send_queues(&client, true).await
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
            thread_root_id: None,
            transaction_id: None,
            client_request_id: None,
            delivery_status: Some("imported".into()),
            undecryptable: None,
        })
    }

    fn project_undecryptable_message(
        room_id: &str,
        members: &HashMap<String, String>,
        value: &serde_json::Value,
    ) -> Option<MessageDto> {
        if !Self::is_undecryptable_message(value) {
            return None;
        }
        let event_id = value
            .get("event_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)?;
        let sender = value
            .get("sender")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("@unknown:invalid")
            .to_owned();
        let origin_server_ts = value
            .get("origin_server_ts")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default();
        let timestamp = Self::event_timestamp(value);

        Some(MessageDto {
            id: event_id.clone(),
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
            content: String::new(),
            attachments: Vec::new(),
            reactions: HashMap::new(),
            timestamp,
            signature: String::new(),
            edited_at: None,
            deleted_at: None,
            reply_to_id: None,
            thread_root_id: None,
            transaction_id: None,
            client_request_id: None,
            delivery_status: Some("sent".into()),
            undecryptable: Some(UndecryptableMessageDto {
                event_id,
                sender,
                origin_server_ts,
                reason: Self::undecryptable_reason(value),
            }),
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
            if let Some(message) = Self::project_undecryptable_message(room_id, members, value) {
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
            let thread_root_id = Self::thread_root_id(content);
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
                    thread_root_id,
                    transaction_id,
                    client_request_id,
                    delivery_status: Some("sent".into()),
                    undecryptable: None,
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

    fn projected_message_sender_ids(
        messages: &[MessageDto],
        max_sender_ids: usize,
    ) -> Vec<OwnedUserId> {
        let mut seen = HashSet::new();
        messages
            .iter()
            .filter_map(|message| UserId::parse(message.author_public_key.as_str()).ok())
            .filter(|sender| seen.insert(sender.clone()))
            .take(max_sender_ids)
            .collect()
    }

    fn apply_member_display_names(
        messages: &mut [MessageDto],
        display_names: &HashMap<String, String>,
    ) {
        for message in messages {
            if let Some(display_name) = display_names.get(&message.author_public_key) {
                message.author_display_name.clone_from(display_name);
            }
        }
    }

    async fn resolve_projected_member_display_names(
        room: &Room,
        messages: &mut [MessageDto],
        max_sender_ids: usize,
    ) -> BackendResult<()> {
        let sender_ids = Self::projected_message_sender_ids(messages, max_sender_ids);
        if sender_ids.is_empty() {
            return Ok(());
        }

        let member_events = room
            .get_state_events_for_keys_static::<RoomMemberEventContent, OwnedUserId, _>(&sender_ids)
            .await
            .map_err(Self::map_error)?;
        let mut display_names = HashMap::with_capacity(member_events.len());
        for raw_event in member_events {
            match raw_event.deserialize() {
                Ok(event) => {
                    display_names.insert(
                        event.user_id().to_string(),
                        event.display_name().as_raw_str().to_owned(),
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        target: "mesh::matrix",
                        room_id = %room.room_id(),
                        "Skipping malformed local member state while projecting messages: {error}"
                    );
                }
            }
        }
        Self::apply_member_display_names(messages, &display_names);
        Ok(())
    }

    fn updated_room_pins(
        mut pinned_event_ids: Vec<matrix_sdk::ruma::OwnedEventId>,
        event_id: matrix_sdk::ruma::OwnedEventId,
    ) -> BackendResult<(Vec<matrix_sdk::ruma::OwnedEventId>, bool)> {
        let was_pinned = pinned_event_ids.iter().any(|pinned| pinned == &event_id);
        let mut seen = HashSet::new();
        pinned_event_ids.retain(|pinned| {
            pinned != &event_id && seen.insert(pinned.clone())
        });
        if was_pinned {
            return Ok((pinned_event_ids, false));
        }
        if pinned_event_ids.len() >= MAX_PINNED_EVENTS {
            return Err(BackendError::InvalidConfiguration(
                "This room already has the maximum of 100 pinned messages.".into(),
            ));
        }
        pinned_event_ids.push(event_id);
        Ok((pinned_event_ids, true))
    }

    async fn room_pins_snapshot(
        client: &Client,
        room: &Room,
        pinned_event_ids: Vec<matrix_sdk::ruma::OwnedEventId>,
    ) -> BackendResult<MatrixRoomPins> {
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let can_manage = room
            .get_member_no_sync(own_user_id)
            .await
            .map_err(Self::map_error)?
            .is_some_and(|member| member.can_pin_or_unpin_event());
        let pinned_event_ids = pinned_event_ids
            .into_iter()
            .take(MAX_PINNED_EVENTS)
            .collect::<Vec<_>>();
        let fetched = futures::stream::iter(pinned_event_ids.clone().into_iter().map(|event_id| {
            let room = room.clone();
            async move {
                let event = room.load_or_fetch_event(&event_id, None).await;
                (event_id, event)
            }
        }))
        .buffer_unordered(10)
        .collect::<Vec<_>>()
        .await;

        let mut values = Vec::new();
        let mut unavailable = HashSet::new();
        for (event_id, event) in fetched {
            let value = event
                .map_err(Self::map_error)
                .and_then(|event| event.raw().deserialize_as::<serde_json::Value>().map_err(Self::map_error));
            match value {
                Ok(value) => values.push(value),
                Err(error) => {
                    tracing::warn!(
                        target: "mesh::matrix",
                        room_id = %room.room_id(),
                        event_id = %event_id,
                        "Could not load a pinned message: {error}"
                    );
                    unavailable.insert(event_id.to_string());
                }
            }
        }

        let mut projected_messages =
            Self::project_timeline(room.room_id().as_str(), &HashMap::new(), values);
        Self::resolve_projected_member_display_names(
            room,
            &mut projected_messages,
            MAX_PINNED_EVENTS,
        )
        .await?;
        let mut projected = projected_messages
            .into_iter()
            .map(|message| (message.id.clone(), message))
            .collect::<HashMap<_, _>>();
        let event_ids = pinned_event_ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let messages = event_ids
            .iter()
            .filter_map(|event_id| {
                let message = projected.remove(event_id);
                if message.is_none() {
                    unavailable.insert(event_id.clone());
                }
                message
            })
            .collect();
        let unavailable_event_ids = event_ids
            .iter()
            .filter(|event_id| unavailable.contains(*event_id))
            .cloned()
            .collect();

        Ok(MatrixRoomPins {
            room_id: room.room_id().to_string(),
            event_ids,
            messages,
            unavailable_event_ids,
            can_manage,
        })
    }
}
