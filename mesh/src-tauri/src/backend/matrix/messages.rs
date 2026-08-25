use super::*;

pub(super) const MAX_SEND_QUEUE_ACCOUNT_MESSAGES: usize = 512;
pub(super) const MAX_SEND_QUEUE_ROOM_MESSAGES: usize = 128;
pub(super) const MAX_SEND_QUEUE_ACCOUNT_UTF8_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_SEND_QUEUE_ROOM_UTF8_BYTES: usize = 1024 * 1024;
/// Upper bound on the `m.mentions.user_ids` prefix scanned when projecting or
/// detecting mentions. Matches the send-side `MAX_MENTIONS` cap so detection
/// and projection agree, and keeps semantic work bounded on remote events.
const MAX_PROJECTED_MENTIONS: usize = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct SendQueueUsage {
    pub(super) messages: usize,
    pub(super) utf8_bytes: usize,
    pub(super) exceeded: bool,
}

struct TimelineValuesPage {
    values: Vec<serde_json::Value>,
    anchor_seen: bool,
    reached_start: bool,
    qualifying_messages: usize,
}

/// How an author is presented, as the room's member state has them now.
pub(super) struct ProjectedMemberProfile {
    pub(super) display_name: String,
    pub(super) avatar_url: Option<String>,
}

impl MatrixBackend {
    const UNDECRYPTABLE_REASON_KEY: &'static str = "org.mesh.undecryptable_reason";
    pub(super) const MAX_ROOM_UPGRADE_HOPS: usize = 16;

    pub(super) fn bounded_send_queue_usage_bytes(
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

    pub(super) fn bounded_send_queue_usage<'a>(
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

    pub(super) fn ensure_send_queue_capacity(
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
        if candidate_utf8_bytes > MAX_SEND_QUEUE_ROOM_UTF8_BYTES.saturating_sub(room.utf8_bytes) {
            return Err(Self::send_queue_quota_error("room", "1 MiB"));
        }
        if candidate_utf8_bytes
            > MAX_SEND_QUEUE_ACCOUNT_UTF8_BYTES.saturating_sub(account.utf8_bytes)
        {
            return Err(Self::send_queue_quota_error("account", "4 MiB"));
        }
        Ok(())
    }

    pub(super) fn receipt_thread_for_message(
        thread_root_id: Option<&str>,
    ) -> Option<ReceiptThread> {
        match thread_root_id {
            Some(root_id) => matrix_sdk::ruma::EventId::parse(root_id)
                .ok()
                .map(ReceiptThread::Thread),
            None => Some(ReceiptThread::Main),
        }
    }

    pub(super) fn can_follow_upgrade_predecessor(predecessor_rooms_visited: usize) -> bool {
        predecessor_rooms_visited < Self::MAX_ROOM_UPGRADE_HOPS
    }

    pub(super) fn dispatch_backend_event(
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
        event: MatrixBackendEvent,
    ) {
        // Recovered rather than treated as fatal, matching
        // `lock_matrix_sync_freshness`. The guarded value is a single
        // `Option<callback>`, so a panic elsewhere cannot leave it half-written,
        // and mapping the poison to `None` instead made one unrelated panic
        // permanently silence every backend event -- new messages, unread
        // badges, typing and RTC -- while the app went on looking connected.
        let callback = callback
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .cloned();
        if let Some(callback) = callback {
            callback(event);
        }
    }

    pub(super) fn notification_preview(body: &str) -> String {
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
    pub(super) fn mentions_for_body(body: &str, own_user_id: Option<&UserId>) -> Mentions {
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

    pub(super) async fn mentions_for_user_ids(
        room: &Room,
        user_ids: &[String],
        own_user_id: &UserId,
    ) -> BackendResult<Mentions> {
        const MAX_MENTIONS: usize = 64;
        if user_ids.len() > MAX_MENTIONS {
            return Err(BackendError::InvalidConfiguration(
                "message has too many mention recipients".into(),
            ));
        }

        let mut mentions = Mentions::new();
        for candidate in user_ids {
            // Skip an unparseable id rather than failing the whole send, matching
            // the lenient handling in mentions_for_body / content_mention_ids.
            let Ok(user_id) = UserId::parse(candidate) else {
                continue;
            };
            if user_id == own_user_id || mentions.user_ids.contains(&user_id) {
                continue;
            }
            let member = room.get_member(&user_id).await.map_err(Self::map_error)?;
            if member.is_some_and(|member| member.membership().as_str() == "join") {
                mentions.user_ids.insert(user_id);
            }
        }
        Ok(mentions)
    }

    fn content_mention_ids(content: &serde_json::Value) -> Vec<String> {
        let mut seen = HashSet::new();
        content
            .get("m.mentions")
            .and_then(|mentions| mentions.get("user_ids"))
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_PROJECTED_MENTIONS)
            .filter_map(serde_json::Value::as_str)
            .filter_map(|candidate| UserId::parse(candidate).ok())
            .map(|user_id| user_id.to_string())
            .filter(|user_id| seen.insert(user_id.clone()))
            .collect()
    }

    pub(super) async fn emit_room_unread(
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
                match direct_targets.iter().next() {
                    Some(peer) => match matrix_sdk::ruma::UserId::parse(peer.as_str()) {
                        Ok(peer) => Self::notification_sender_is_ignored(
                            ignored_users.read().await.as_ref(),
                            &peer,
                        ),
                        Err(_) => true,
                    },
                    None => true,
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
                // before the block cannot remain visible indefinitely. The
                // marked-unread flag is the person's own explicit action, not
                // something derived from the blocked sender's activity, so it
                // is reported truthfully even while counts are suppressed.
                Self::dispatch_backend_event(
                    callback,
                    MatrixBackendEvent::UnreadUpdate(MatrixUnreadUpdate {
                        room_id: room.room_id().to_string(),
                        unread_messages: 0,
                        unread_mentions: 0,
                        unread_marked: room.is_marked_unread(),
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
                unread_marked: room.is_marked_unread(),
            }),
        );
    }

    pub(super) async fn emit_all_room_unreads(
        client: &Client,
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
        ignored_users: &Arc<RwLock<Option<HashSet<OwnedUserId>>>>,
    ) {
        for room in client.rooms() {
            Self::emit_room_unread(client, callback, ignored_users, room.room_id()).await;
        }
    }

    /// Identity colour for an account.
    ///
    /// This used to be `#rrggbb` taken from the first three bytes of a
    /// SHA-256 digest, which sampled the whole RGB cube: a large share of
    /// accounts landed below 4.5:1 against the app canvas and the worst cases
    /// were invisible. It now returns one of the ten curated `--avatar-*`
    /// design tokens, so contrast is clamped by the stylesheet, per theme, and
    /// the backend cannot emit an out-of-gamut colour at all.
    pub(super) fn avatar_color(seed: &str) -> String {
        crate::types::avatar::avatar_palette_value(seed)
    }

    pub(super) fn timestamp_from_millis(timestamp: Option<u64>) -> String {
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

    pub(super) fn is_base_text_message(value: &serde_json::Value) -> bool {
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

    pub(super) fn is_undecryptable_message(value: &serde_json::Value) -> bool {
        value.get("type").and_then(serde_json::Value::as_str) == Some("m.room.encrypted")
            && value.get(Self::UNDECRYPTABLE_REASON_KEY).is_some()
    }

    pub(super) fn is_ignored_non_state_event(
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

        let cause = matrix_sdk_crypto::types::events::UtdCause::determine(event, context, utd_info);
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
                    && (Self::is_undecryptable_message(&value)
                        || legacy_message_id.is_some()
                        || (Self::is_base_text_message(&value)
                            && value
                                .get("content")
                                .and_then(Self::thread_root_id)
                                .is_none()))
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

    pub(super) async fn timeline_values(
        room: &Room,
        minimum_base_messages: usize,
        before_id: Option<&str>,
    ) -> BackendResult<Vec<serde_json::Value>> {
        Ok(
            Self::timeline_values_page(room, minimum_base_messages, before_id)
                .await?
                .values,
        )
    }

    pub(super) async fn timeline_values_with_predecessors(
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
            let mut predecessor_room_id = current.predecessor_room().map(|room| room.room_id);
            if predecessor_room_id.is_none() {
                predecessor_room_id = self.verified_room_upgrades.read().await.iter().find_map(
                    |(predecessor, replacement)| {
                        (replacement == current.room_id()).then(|| predecessor.clone())
                    },
                );
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

    pub(super) fn visible_message_body(content: &serde_json::Value) -> Option<String> {
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

    pub(super) fn thread_root_id(content: &serde_json::Value) -> Option<String> {
        let relation = content.get("m.relates_to")?;
        let root_id = (relation.get("rel_type").and_then(serde_json::Value::as_str)
            == Some("m.thread"))
        .then(|| relation.get("event_id"))
        .flatten()
        .and_then(serde_json::Value::as_str)?;
        matrix_sdk::ruma::EventId::parse(root_id)
            .ok()
            .map(|root_id| root_id.to_string())
    }

    /// Refuse a room-wide mention that the sender's power level does not allow.
    ///
    /// The composer offers `@room` only where it believes the account may use
    /// it, but that is a hint drawn from a role which can change between
    /// opening the composer and pressing send, so it is not the authority --
    /// the same reasoning `user_can_update_room_avatar` records. The
    /// alternative to refusing is worse than it looks: the message would land
    /// normally and only the notification would be dropped, server-side and
    /// silently, leaving the sender believing they had reached everyone.
    ///
    /// `notifications.room` is the room's own threshold and defaults to 50,
    /// which is why an ordinary member cannot do this and a moderator can.
    pub(super) async fn require_room_notification_permission(
        room: &Room,
        user_id: &UserId,
    ) -> BackendResult<()> {
        if !room
            .power_levels_or_default()
            .await
            .user_can_trigger_room_notification(user_id)
        {
            return Err(BackendError::PermissionDenied(
                "your current role cannot notify everyone in this room".into(),
            ));
        }
        Ok(())
    }

    /// Whether an event notified the whole room via the standard
    /// `m.mentions.room` flag.
    ///
    /// Read verbatim rather than inferred from the body: the sender's power
    /// level decides whether the flag is set, so a body containing `@room` from
    /// somebody without that power carries no flag and notified nobody.
    fn content_mentions_room(content: &serde_json::Value) -> bool {
        content
            .get("m.mentions")
            .and_then(|mentions| mentions.get("room"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }

    fn content_mentions_user(content: &serde_json::Value, user_id: &UserId) -> bool {
        // A room-wide mention names everyone in the room without naming anyone
        // in user_ids, so it has to be checked separately or the thread mention
        // counters would miss it entirely. Both callers reach this through
        // thread_unread_counts, which already drops the reader's own messages,
        // so this does not badge somebody for their own @room.
        if Self::content_mentions_room(content) {
            return true;
        }
        content
            .get("m.mentions")
            .and_then(|mentions| mentions.get("user_ids"))
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            // Scan the same bounded prefix the projection (content_mention_ids)
            // and the send path (MAX_MENTIONS) use, so mention detection and the
            // projected mentions list never disagree about who was mentioned.
            .take(MAX_PROJECTED_MENTIONS)
            .filter_map(serde_json::Value::as_str)
            .filter_map(|candidate| UserId::parse(candidate).ok())
            .any(|candidate| candidate == user_id)
    }

    pub(super) fn effectively_mentioned_event_ids(
        values: &[serde_json::Value],
        user_id: &UserId,
    ) -> HashSet<String> {
        let mut base_authors = HashMap::<String, String>::new();
        let mut mentioned = HashSet::<String>::new();
        let mut redacted = HashSet::<String>::new();
        let mut latest_replacements = HashMap::<String, (u64, String, bool)>::new();

        for value in values {
            let event_id = value
                .get("event_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let sender = value
                .get("sender")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if !Self::is_base_text_message(value) {
                continue;
            }
            let Some(content) = value.get("content") else {
                continue;
            };
            base_authors.insert(event_id.to_owned(), sender.to_owned());
            if Self::content_mentions_user(content, user_id) {
                mentioned.insert(event_id.to_owned());
            }
            if value
                .get("unsigned")
                .and_then(|unsigned| unsigned.get("redacted_because"))
                .is_some()
            {
                redacted.insert(event_id.to_owned());
            }
        }

        for value in values {
            let event_id = value
                .get("event_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let sender = value
                .get("sender")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            match value
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
            {
                "m.room.message" => {
                    let Some(content) = value.get("content") else {
                        continue;
                    };
                    let Some(relation) = content.get("m.relates_to") else {
                        continue;
                    };
                    if relation.get("rel_type").and_then(serde_json::Value::as_str)
                        != Some("m.replace")
                    {
                        continue;
                    }
                    let Some(target_id) = relation
                        .get("event_id")
                        .and_then(serde_json::Value::as_str)
                        .filter(|target_id| matrix_sdk::ruma::EventId::parse(*target_id).is_ok())
                    else {
                        continue;
                    };
                    if base_authors.get(target_id).map(String::as_str) != Some(sender) {
                        continue;
                    }
                    let replacement = relation
                        .get("m.new_content")
                        .or_else(|| content.get("m.new_content"));
                    let replacement_mentions = replacement.is_some_and(|replacement| {
                        Self::content_mentions_user(replacement, user_id)
                    });
                    let order = (
                        value
                            .get("origin_server_ts")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or_default(),
                        event_id.to_owned(),
                    );
                    let should_replace = latest_replacements.get(target_id).is_none_or(
                        |(timestamp, replacement_id, _)| {
                            order > (*timestamp, replacement_id.clone())
                        },
                    );
                    if should_replace {
                        latest_replacements.insert(
                            target_id.to_owned(),
                            (order.0, order.1, replacement_mentions),
                        );
                    }
                }
                "m.room.redaction" => {
                    if let Some(target_id) = value
                        .get("redacts")
                        .or_else(|| {
                            value
                                .get("content")
                                .and_then(|content| content.get("redacts"))
                        })
                        .and_then(serde_json::Value::as_str)
                        .filter(|target_id| matrix_sdk::ruma::EventId::parse(*target_id).is_ok())
                    {
                        redacted.insert(target_id.to_owned());
                    }
                }
                _ => {}
            }
        }

        for (target_id, (_, _, replacement_mentions)) in latest_replacements {
            if replacement_mentions {
                mentioned.insert(target_id);
            } else {
                mentioned.remove(&target_id);
            }
        }
        mentioned.retain(|event_id| !redacted.contains(event_id));
        mentioned
    }

    pub(super) fn thread_unread_counts(
        replies: &[MessageDto],
        own_user_id: &UserId,
        mentioned_event_ids: &HashSet<String>,
        receipt_event_ids: &HashSet<String>,
    ) -> (u32, u32) {
        let last_read_index = replies
            .iter()
            .enumerate()
            .filter(|(_, reply)| receipt_event_ids.contains(&reply.id))
            .map(|(index, _)| index)
            .max();
        replies
            .iter()
            .enumerate()
            .filter(|(index, reply)| {
                last_read_index.is_none_or(|last_read_index| *index > last_read_index)
                    && reply.author_public_key != own_user_id.as_str()
                    && reply.deleted_at.is_none()
            })
            .fold((0_u32, 0_u32), |(unread, mentions), (_, reply)| {
                (
                    unread.saturating_add(1),
                    mentions.saturating_add(u32::from(mentioned_event_ids.contains(&reply.id))),
                )
            })
    }

    pub(super) fn thread_participant_count(root: &MessageDto, replies: &[MessageDto]) -> u32 {
        replies
            .iter()
            .map(|message| message.author_public_key.as_str())
            .chain(std::iter::once(root.author_public_key.as_str()))
            .collect::<HashSet<_>>()
            .len() as u32
    }

    pub(super) fn thread_last_activity(root: &MessageDto, replies: &[MessageDto]) -> String {
        replies
            .iter()
            .map(|message| message.timestamp.as_str())
            .chain(std::iter::once(root.timestamp.as_str()))
            .max()
            .unwrap_or(root.timestamp.as_str())
            .to_owned()
    }

    pub(super) async fn thread_list_item(
        &self,
        room: &Room,
        own_user_id: &UserId,
        thread_root_id: matrix_sdk::ruma::OwnedEventId,
        root_value: serde_json::Value,
        ignored_users: &IgnoredUserListEventContent,
    ) -> BackendResult<Option<ThreadListItemDto>> {
        let mut relation_values = Vec::new();
        let mut from = None;
        let mut seen_tokens = HashSet::new();
        loop {
            let remaining = MAX_THREAD_LIST_RELATION_EVENTS.saturating_sub(relation_values.len());
            if remaining == 0 {
                break;
            }
            let page_size = remaining.min(THREAD_RELATION_PAGE_SIZE) as u32;
            let page = room
                .relations(
                    thread_root_id.clone(),
                    RelationsOptions {
                        from,
                        limit: Some(UInt::from(page_size)),
                        recurse: true,
                        ..Default::default()
                    },
                )
                .await
                .map_err(Self::map_error)?;
            let next = page.prev_batch_token;
            for event in page.chunk {
                if relation_values.len() >= MAX_THREAD_LIST_RELATION_EVENTS {
                    break;
                }
                if let Ok(value) = event.raw().deserialize_as::<serde_json::Value>() {
                    relation_values.push(value);
                }
            }
            let Some(next) = next else {
                break;
            };
            if !seen_tokens.insert(next.clone()) {
                break;
            }
            from = Some(next);
        }

        let mut values = Vec::with_capacity(relation_values.len().saturating_add(1));
        values.push(root_value);
        values.extend(relation_values);
        values.retain(|value| !Self::is_ignored_non_state_event(value, ignored_users));
        let mentioned_event_ids = Self::effectively_mentioned_event_ids(&values, own_user_id);
        let mut projected =
            Self::project_timeline(room.room_id().as_str(), &HashMap::new(), values);

        let Some(root_index) = projected
            .iter()
            .position(|message| message.id == thread_root_id.as_str())
        else {
            return Ok(None);
        };
        let root = projected.remove(root_index);
        let replies = projected
            .into_iter()
            .filter(|message| message.thread_root_id.as_deref() == Some(thread_root_id.as_str()))
            .collect::<Vec<_>>();

        let unread_state_available = self
            .wire_privacy
            .read()
            .await
            .read_receipt_mode_for(room.room_id().as_str())
            != ReadReceiptMode::Off;
        let (unread_count, unread_mentions) = if unread_state_available {
            let mut receipt_event_ids = HashSet::new();
            for receipt_type in [ReceiptType::Read, ReceiptType::ReadPrivate] {
                if let Some((event_id, _)) = room
                    .load_user_receipt(
                        receipt_type,
                        ReceiptThread::Thread(thread_root_id.clone()),
                        own_user_id,
                    )
                    .await
                    .map_err(Self::map_error)?
                {
                    receipt_event_ids.insert(event_id.to_string());
                }
            }
            Self::thread_unread_counts(
                &replies,
                own_user_id,
                &mentioned_event_ids,
                &receipt_event_ids,
            )
        } else {
            (0, 0)
        };

        let participant_count = Self::thread_participant_count(&root, &replies);
        let last_activity = Self::thread_last_activity(&root, &replies);

        let mut display_messages = Vec::with_capacity(replies.len().saturating_add(1));
        display_messages.push(root);
        display_messages.extend(replies);
        let display_message_count = display_messages.len();
        Self::resolve_projected_member_profiles(room, &mut display_messages, display_message_count)
            .await?;
        let root = display_messages.remove(0);
        let reply_count = display_messages.len() as u32;

        Ok(Some(ThreadListItemDto {
            root,
            reply_count,
            participant_count,
            last_activity,
            unread_count,
            unread_mentions,
        }))
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

    pub(super) fn queued_client_request_id(echo: &LocalEcho) -> Option<String> {
        let (content, _, _) = Self::queued_event_value(echo)?;
        let client_request_id = content.get(CLIENT_REQUEST_ID_KEY)?.as_str()?.to_owned();
        Self::validate_transaction_id(&client_request_id).ok()?;
        Some(client_request_id)
    }

    pub(super) fn queued_local_echo_from_updates(
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
                    if Self::queued_client_request_id(&echo).as_deref() == Some(client_request_id) {
                        return Some(echo);
                    }
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
                | Err(tokio::sync::broadcast::error::TryRecvError::Closed)
                | Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => return None,
            }
        }
    }

    pub(super) fn is_supported_queued_content(content: &serde_json::Value) -> bool {
        content.get("msgtype").and_then(serde_json::Value::as_str) == Some("m.text")
            && Self::visible_message_body(content).is_some_and(|body| !body.trim().is_empty())
            && content
                .get(CLIENT_REQUEST_ID_KEY)
                .and_then(serde_json::Value::as_str)
                .is_some_and(|identifier| Self::validate_transaction_id(identifier).is_ok())
    }

    pub(super) fn is_supported_queued_text(echo: &LocalEcho) -> bool {
        let Some((content, _, _)) = Self::queued_event_value(echo) else {
            return false;
        };
        Self::is_supported_queued_content(&content)
    }

    pub(super) async fn queued_message_from_local_echo(
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
        let (display_name, author_avatar_url) = Self::own_author_profile(room, own_user_id).await?;
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
            author_avatar_url,
            content: body,
            mentions: Self::content_mention_ids(&content),
            mentions_room: Self::content_mentions_room(&content),
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

    pub(super) async fn queued_messages_for_client(
        client: &Client,
        ignored_users: &IgnoredUserListEventContent,
    ) -> BackendResult<Vec<MessageDto>> {
        let echoes_by_room = client
            .send_queue()
            .local_echoes()
            .await
            .map_err(Self::map_display_error)?;
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
                .map(|room| Self::room_has_ignored_direct_peer(room, ignored_users))
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
                        > MAX_SEND_QUEUE_ACCOUNT_UTF8_BYTES.saturating_sub(account_usage.utf8_bytes)
                {
                    truncated = true;
                    break 'rooms;
                }
                account_usage.messages += 1;
                account_usage.utf8_bytes += echo_bytes;
                if room_usage.messages >= MAX_SEND_QUEUE_ROOM_MESSAGES
                    || echo_bytes
                        > MAX_SEND_QUEUE_ROOM_UTF8_BYTES.saturating_sub(room_usage.utf8_bytes)
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

    pub(super) async fn reconcile_protected_send_queues(
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
            .map_err(Self::map_display_error)?;
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
            let (ignored_direct, direct_configuration_supported) = match protected_room.as_ref() {
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

    pub(super) async fn resnapshot_send_queue_updates(
        client: &Client,
        callback: &Arc<StdRwLock<Option<MatrixBackendEventCallback>>>,
        known: &Arc<Mutex<HashMap<String, HashSet<String>>>>,
    ) -> BackendResult<()> {
        let ignored_users = Self::fetch_ignored_user_list(client).await?;
        let messages = Self::queued_messages_for_client(client, &ignored_users).await?;
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
                failure: None,
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
                    failure: None,
                })),
            );
        }
        Ok(())
    }

    /// Name an unrecoverable send failure precisely enough for the renderer to
    /// tell the difference between a dropped connection and a door that is
    /// closed. The raw error never reaches the user: it is a protocol failure,
    /// and the product rule is that an error says what to do next instead.
    ///
    /// Takes the error kind rather than the error so the mapping stays a pure
    /// function that a test can drive with every variant it claims to handle.
    pub(super) fn classify_send_failure(kind: Option<&ErrorKind>) -> MatrixQueuedMessageFailure {
        match kind {
            // Announcement-only power levels, a mute, a kick, and a ban all
            // arrive here. They differ in cause and not in what the person can
            // do about it, which is nothing, so they share one outcome.
            Some(ErrorKind::Forbidden) => MatrixQueuedMessageFailure::NotAllowed,
            // The room is gone from under the queue, which in practice means an
            // upgrade replaced it while the message was still waiting.
            Some(ErrorKind::NotFound) => MatrixQueuedMessageFailure::RoomUnavailable,
            _ => MatrixQueuedMessageFailure::Unknown,
        }
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
                            failure: None,
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
                error,
                is_recoverable,
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
                    // A recoverable error keeps the message queued, so there is
                    // nothing to explain yet. An unrecoverable one is the end of
                    // the road, and the renderer has to say why rather than
                    // offering a retry that cannot work.
                    failure: (!is_recoverable)
                        .then(|| Self::classify_send_failure(error.client_api_error_kind())),
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
                    failure: None,
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
                    failure: None,
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
                    failure: None,
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

    pub(super) fn spawn_send_queue_task(
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
                if let Err(error) = Self::reconcile_protected_send_queues(&client, false).await {
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
            // Derived, never taken from the bridged payload: that field is
            // remote-controlled and used to reach a renderer style attribute
            // unclamped. Deriving keeps every author inside the curated
            // `--avatar-*` palette.
            author_avatar_color: Self::avatar_color(&author),
            // Bridged from the legacy control log, which carried no picture.
            author_avatar_url: None,
            content: if deleted_at.is_some() {
                String::new()
            } else {
                payload
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            },
            mentions: Vec::new(),
            mentions_room: false,
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
            author_avatar_url: None,
            content: String::new(),
            mentions: Vec::new(),
            mentions_room: false,
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

    pub(super) fn project_timeline(
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
                    // Filled in by resolve_projected_member_profiles, which
                    // reads it from the same member state as the display name.
                    author_avatar_url: None,
                    content: if redacted { String::new() } else { body },
                    mentions: if redacted {
                        Vec::new()
                    } else {
                        Self::content_mention_ids(content)
                    },
                    mentions_room: !redacted && Self::content_mentions_room(content),
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
                    if let Some(replacement) = replacement {
                        let Some(body) =
                            replacement.get("body").and_then(serde_json::Value::as_str)
                        else {
                            continue;
                        };
                        message.content = body.to_owned();
                        message.mentions = Self::content_mention_ids(replacement);
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

    pub(super) fn projected_message_sender_ids(
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

    pub(super) fn apply_member_profiles(
        messages: &mut [MessageDto],
        profiles: &HashMap<String, ProjectedMemberProfile>,
    ) {
        for message in messages {
            if let Some(profile) = profiles.get(&message.author_public_key) {
                message
                    .author_display_name
                    .clone_from(&profile.display_name);
                // Assigned, not merged: a profile in hand is the current state
                // of that member, so someone who cleared their picture has to
                // clear it here too. Keeping the old value when the new one is
                // absent would leave a removed picture on any message that
                // carried one, and the projection sites that set it themselves
                // (a local echo, for instance) would never let go of it.
                message.author_avatar_url.clone_from(&profile.avatar_url);
            }
        }
    }

    pub(super) async fn resolve_projected_member_profiles(
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
        let mut profiles = HashMap::with_capacity(member_events.len());
        for raw_event in member_events {
            match raw_event.deserialize() {
                Ok(event) => {
                    profiles.insert(
                        event.user_id().to_string(),
                        ProjectedMemberProfile {
                            display_name: event.display_name().as_raw_str().to_owned(),
                            // Absent for a member who set none, and for a
                            // redacted or stripped member event, which is the
                            // same answer: show the generated mark.
                            avatar_url: event.avatar_url().map(ToString::to_string),
                        },
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
        Self::apply_member_profiles(messages, &profiles);
        Ok(())
    }

    /// How to present the account's own message before the server echoes it.
    ///
    /// The same two fields `resolve_projected_member_profiles` fills in for
    /// everyone else, read from this room's own membership, so a message a
    /// person just sent does not appear under a different name or a generated
    /// mark for the moment before its projected copy replaces it.
    ///
    /// Local state only. Mesh syncs members lazily, so the fetching `get_member`
    /// the three send paths used to call could put a whole member download in
    /// front of a message that was already sent, to read the one member event
    /// that is always present anyway: an account has to be joined to send. If it
    /// somehow is not there, the localpart stands in for the moment until the
    /// projected copy arrives with the real name.
    pub(super) async fn own_author_profile(
        room: &Room,
        own_user_id: &UserId,
    ) -> BackendResult<(String, Option<String>)> {
        let member = room
            .get_member_no_sync(own_user_id)
            .await
            .map_err(Self::map_error)?;
        let display_name = member
            .as_ref()
            .map(|member| member.name().to_owned())
            .unwrap_or_else(|| own_user_id.localpart().to_owned());
        let avatar_url = member
            .as_ref()
            .and_then(|member| member.avatar_url())
            .map(ToString::to_string);
        Ok((display_name, avatar_url))
    }

    pub(super) fn updated_room_pins(
        mut pinned_event_ids: Vec<matrix_sdk::ruma::OwnedEventId>,
        event_id: matrix_sdk::ruma::OwnedEventId,
    ) -> BackendResult<(Vec<matrix_sdk::ruma::OwnedEventId>, bool)> {
        let was_pinned = pinned_event_ids.iter().any(|pinned| pinned == &event_id);
        let mut seen = HashSet::new();
        pinned_event_ids.retain(|pinned| pinned != &event_id && seen.insert(pinned.clone()));
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

    pub(super) async fn room_pins_snapshot(
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
            let value = event.map_err(Self::map_error).and_then(|event| {
                event
                    .raw()
                    .deserialize_as::<serde_json::Value>()
                    .map_err(Self::map_display_error)
            });
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
        Self::resolve_projected_member_profiles(room, &mut projected_messages, MAX_PINNED_EVENTS)
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

#[cfg(test)]
mod message_core_tests {
    use super::*;

    #[test]
    fn queue_usage_stops_before_remote_data_can_exceed_the_budget() {
        let usage = MatrixBackend::bounded_send_queue_usage_bytes([4, 4, 4], 3, 9);
        assert_eq!(usage.messages, 2);
        assert_eq!(usage.utf8_bytes, 8);
        assert!(usage.exceeded);
    }

    #[test]
    fn malformed_or_own_mentions_are_not_projected() {
        let own_user_id = UserId::parse("@alice:example.org").unwrap();
        let mentions = MatrixBackend::mentions_for_body(
            "hello @alice:example.org @bob:example.org @not-an-id",
            Some(&own_user_id),
        );
        let expected = UserId::parse("@bob:example.org").unwrap();
        assert_eq!(mentions.user_ids.len(), 1);
        assert!(mentions.user_ids.contains(&expected));
    }

    #[test]
    fn a_room_wide_mention_is_read_from_the_flag_not_from_the_body() {
        // The body is what a person typed; the flag is what the service acted
        // on. Somebody without the power level can write the word and reach
        // nobody, so only the flag may drive the highlight or the badge.
        let claimed = serde_json::json!({
            "msgtype": "m.text",
            "body": "@room please read this",
        });
        assert!(!MatrixBackend::content_mentions_room(&claimed));

        let granted = serde_json::json!({
            "msgtype": "m.text",
            "body": "@room please read this",
            "m.mentions": { "room": true },
        });
        assert!(MatrixBackend::content_mentions_room(&granted));
    }

    #[test]
    fn a_room_wide_mention_survives_being_sent_as_a_reply() {
        // send_message sets the flag on the base content and then hands that
        // content to the SDK's reply construction, which is a different path
        // from a plain send. If it rebuilt m.mentions around the reply target
        // instead of adding to what it was given, replying with @room would
        // notify nobody while the composer had just promised it would -- the
        // failure this whole feature exists to avoid, in its most common
        // variant. Pinned so an SDK upgrade that changes it fails here.
        use matrix_sdk::ruma::events::room::message::{
            AddMentions, ForwardThread, ReplyMetadata, RoomMessageEventContentWithoutRelation,
        };

        let mut room_wide = Mentions::new();
        room_wide.room = true;
        let base = RoomMessageEventContentWithoutRelation::text_plain("@room ship it")
            .add_mentions(room_wide);

        let replied_to = matrix_sdk::ruma::EventId::parse("$original:example.org").unwrap();
        let author = UserId::parse("@bob:example.org").unwrap();
        let reply = base.make_reply_to(
            ReplyMetadata::new(&replied_to, &author, None),
            ForwardThread::No,
            AddMentions::Yes,
        );

        let mentions = reply.mentions.expect("the reply kept an m.mentions block");
        assert!(mentions.room, "the reply dropped the room-wide flag");
        assert!(
            mentions.user_ids.contains(&author),
            "the reply lost the author it is replying to",
        );
    }

    #[test]
    fn a_room_wide_mention_counts_as_mentioning_a_reader_it_never_names() {
        // m.mentions.room names everyone without listing anyone, so a detector
        // that only reads user_ids would leave thread mention counts at zero
        // for the one message most likely to need attention.
        let reader = UserId::parse("@carol:example.org").unwrap();
        let content = serde_json::json!({
            "msgtype": "m.text",
            "body": "@room standup moved",
            "m.mentions": { "room": true },
        });
        assert!(MatrixBackend::content_mentions_user(&content, &reader));

        let unflagged = serde_json::json!({
            "msgtype": "m.text",
            "body": "@room standup moved",
        });
        assert!(!MatrixBackend::content_mentions_user(&unflagged, &reader));
    }

    #[test]
    fn structured_mention_ids_project_from_message_metadata() {
        let content = serde_json::json!({
            "msgtype": "m.text",
            "body": "hello @Alice",
            "m.mentions": {
                "user_ids": [
                    "@alice:example.org",
                    "not-an-account-id",
                    "@alice:example.org",
                    "@bob:example.org"
                ]
            }
        });

        assert_eq!(
            MatrixBackend::content_mention_ids(&content),
            vec!["@alice:example.org", "@bob:example.org"]
        );
    }

    #[test]
    fn mention_projection_and_detection_share_the_same_cap() {
        // 70 distinct valid mention ids: entries at index >= MAX_PROJECTED_MENTIONS
        // fall outside the scanned prefix for both projection and detection.
        let ids: Vec<String> = (0..70)
            .map(|index| format!("@user{index}:example.org"))
            .collect();
        let content = serde_json::json!({
            "msgtype": "m.text",
            "body": "many mentions",
            "m.mentions": { "user_ids": ids },
        });

        let projected = MatrixBackend::content_mention_ids(&content);
        assert_eq!(projected.len(), MAX_PROJECTED_MENTIONS);

        // A user within the cap is both projected and detected.
        let within = UserId::parse("@user0:example.org").unwrap();
        assert!(projected.iter().any(|id| id == within.as_str()));
        assert!(MatrixBackend::content_mentions_user(&content, &within));

        // A user beyond the cap is neither projected nor detected: the two paths
        // agree instead of the badge firing without a matching projection.
        let beyond = UserId::parse("@user69:example.org").unwrap();
        assert!(!projected.iter().any(|id| id == beyond.as_str()));
        assert!(!MatrixBackend::content_mentions_user(&content, &beyond));
    }
}
