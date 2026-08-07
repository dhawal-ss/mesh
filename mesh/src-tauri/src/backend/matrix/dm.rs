impl MatrixBackend {
    async fn dm_request_from_invited_room(room: &Room) -> BackendResult<Option<DmRequestDto>> {
        if room.state() != RoomState::Invited
            || room.is_space()
            || room.room_type().is_some()
            || !room.is_direct().await.map_err(Self::map_error)?
        {
            return Ok(None);
        }
        let invite = room.invite_details().await.map_err(Self::map_error)?;
        if invite.inviter_id == room.own_user_id() {
            return Ok(None);
        }
        let inviter_display_name = invite
            .inviter
            .as_ref()
            .map(|member| {
                bounded_remote_member_display_name(member.name(), invite.inviter_id.as_str())
            })
            .unwrap_or_else(|| {
                bounded_remote_member_display_name(
                    invite.inviter_id.localpart(),
                    invite.inviter_id.as_str(),
                )
            });
        let can_accept = room
            .latest_encryption_state()
            .await
            .map(|state| state.is_encrypted())
            .unwrap_or(false);

        Ok(Some(DmRequestDto {
            room_id: room.room_id().to_string(),
            inviter_user_id: invite.inviter_id.to_string(),
            inviter_display_name,
            inviter_avatar_color: Self::avatar_color(invite.inviter_id.as_str()),
            can_accept,
        }))
    }

    async fn validated_dm_request_room(
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
    ) -> BackendResult<(Room, OwnedUserId)> {
        let room = client.get_room(room_id).ok_or_else(|| {
            BackendError::NotFound("message request is no longer available".into())
        })?;
        if room.state() != RoomState::Invited
            || room.is_space()
            || room.room_type().is_some()
            || !room.is_direct().await.map_err(Self::map_error)?
        {
            return Err(BackendError::InvalidConfiguration(
                "This is not an incoming direct-message request".into(),
            ));
        }
        let invite = room.invite_details().await.map_err(Self::map_error)?;
        if invite.inviter_id == room.own_user_id() {
            return Err(BackendError::InvalidConfiguration(
                "The message request has an invalid sender".into(),
            ));
        }
        Ok((room, invite.inviter_id))
    }

    fn is_exact_two_party_direct_candidate(
        joined_members_count: u64,
        own_user_is_joined: bool,
        target_user_is_joined: bool,
    ) -> bool {
        joined_members_count == 2 && own_user_is_joined && target_user_is_joined
    }

    async fn room_member_is_joined(
        room: &Room,
        user_id: &matrix_sdk::ruma::UserId,
    ) -> BackendResult<bool> {
        let Some(member_event) = room
            .get_state_event_static_for_key::<RoomMemberEventContent, _>(user_id)
            .await
            .map_err(Self::map_error)?
        else {
            return Ok(false);
        };
        let member_event = member_event.deserialize().map_err(Self::map_error)?;
        Ok(matches!(
            member_event.membership(),
            MembershipState::Join
        ))
    }

    fn direct_rooms(client: &Client, user_id: &matrix_sdk::ruma::UserId) -> Vec<Room> {
        let mut rooms: Vec<Room> = client
            .joined_rooms()
            .into_iter()
            .filter(|room| {
                let targets = room.direct_targets();
                targets.len() == 1
                    && targets
                        .iter()
                        .any(|target| target.as_str() == user_id.as_str())
            })
            .collect();
        rooms.sort_by(|left, right| left.room_id().cmp(right.room_id()));
        rooms
    }

    async fn inferred_direct_rooms(
        client: &Client,
        user_id: &matrix_sdk::ruma::UserId,
    ) -> BackendResult<Vec<Room>> {
        let Some(own_user_id) = client.user_id() else {
            return Err(BackendError::NotAuthenticated);
        };
        let mut rooms = Vec::new();
        for room in client.joined_rooms() {
            if room.is_space() {
                continue;
            }
            if room.joined_members_count() != 2 {
                continue;
            }
            let own_user_is_joined = Self::room_member_is_joined(&room, own_user_id).await?;
            let target_user_is_joined = Self::room_member_is_joined(&room, user_id).await?;
            if !Self::is_exact_two_party_direct_candidate(
                room.joined_members_count(),
                own_user_is_joined,
                target_user_is_joined,
            ) {
                continue;
            }
            Self::require_protected_room(&room, "opening this direct message").await?;
            rooms.push(room);
        }
        rooms.sort_by(|left, right| left.room_id().cmp(right.room_id()));
        Ok(rooms)
    }

    fn canonical_direct_room_id(mut room_ids: Vec<OwnedRoomId>) -> Option<OwnedRoomId> {
        room_ids.sort();
        room_ids.into_iter().next()
    }

    fn merge_direct_room_ids(target: &mut Vec<OwnedRoomId>, source: &[OwnedRoomId]) -> bool {
        let mut additions = source
            .iter()
            .filter(|room_id| !target.contains(room_id))
            .cloned()
            .collect::<Vec<_>>();
        additions.sort();
        let changed = !additions.is_empty();
        target.extend(additions);
        changed
    }

    fn merge_direct_content_preserving_mappings(
        target: &mut DirectEventContent,
        source: &DirectEventContent,
    ) -> bool {
        let mut changed = false;
        for (user_id, source_room_ids) in source.iter() {
            if let Some(target_room_ids) = target.get_mut(user_id) {
                changed |= Self::merge_direct_room_ids(target_room_ids, source_room_ids);
            } else {
                target.insert(user_id.clone(), source_room_ids.clone());
                changed = true;
            }
        }
        changed
    }

    fn direct_content_preserves(
        observed: &DirectEventContent,
        required: &DirectEventContent,
    ) -> bool {
        required.iter().all(|(user_id, required_room_ids)| {
            observed.get(user_id).is_some_and(|observed_room_ids| {
                required_room_ids
                    .iter()
                    .all(|room_id| observed_room_ids.contains(room_id))
            })
        })
    }

    async fn reconcile_direct_duplicates(
        client: &Client,
        user_id: &matrix_sdk::ruma::UserId,
        local_room_ids: &[OwnedRoomId],
        preserved_content: Option<&DirectEventContent>,
        allow_missing_user_mapping: bool,
    ) -> BackendResult<bool> {
        let direct_user = <&DirectUserIdentifier>::from(user_id);
        let mut accumulated = preserved_content.cloned();
        let mut wrote = false;

        for _ in 0..DIRECT_ACCOUNT_DATA_MERGE_ATTEMPTS {
            let Some(first_raw) = client
                .account()
                .fetch_account_data_static::<DirectEventContent>()
                .await
                .map_err(Self::map_error)?
            else {
                return Ok(wrote);
            };
            let first = first_raw.deserialize().map_err(Self::map_error)?;

            let Some(second_raw) = client
                .account()
                .fetch_account_data_static::<DirectEventContent>()
                .await
                .map_err(Self::map_error)?
            else {
                if let Some(accumulated_content) = accumulated.as_mut() {
                    Self::merge_direct_content_preserving_mappings(accumulated_content, &first);
                } else {
                    accumulated = Some(first);
                }
                continue;
            };
            let second = second_raw.deserialize().map_err(Self::map_error)?;

            let snapshots_match = serde_json::to_vec(&first).map_err(Self::map_error)?
                == serde_json::to_vec(&second).map_err(Self::map_error)?;
            let accumulated_content = accumulated.get_or_insert_with(|| first.clone());
            Self::merge_direct_content_preserving_mappings(accumulated_content, &first);
            Self::merge_direct_content_preserving_mappings(accumulated_content, &second);
            if !snapshots_match {
                continue;
            }

            let mut candidate = second;
            Self::merge_direct_content_preserving_mappings(&mut candidate, accumulated_content);
            let room_ids = if let Some(room_ids) = candidate.get_mut(direct_user) {
                room_ids
            } else if allow_missing_user_mapping {
                candidate.insert(direct_user.to_owned(), Vec::new());
                candidate
                    .get_mut(direct_user)
                    .expect("invariant: the direct-user mapping was just inserted")
            } else {
                // A remote device removed this entire peer mapping. Do not
                // recreate it from a possibly stale local SDK snapshot.
                return Ok(wrote);
            };
            Self::merge_direct_room_ids(room_ids, local_room_ids);

            if Self::direct_content_preserves(&first, &candidate) {
                return Ok(wrote);
            }

            client
                .account()
                .set_account_data(candidate.clone())
                .await
                .map_err(Self::map_error)?;
            wrote = true;

            let Some(verification_raw) = client
                .account()
                .fetch_account_data_static::<DirectEventContent>()
                .await
                .map_err(Self::map_error)?
            else {
                continue;
            };
            let verification = verification_raw.deserialize().map_err(Self::map_error)?;
            if Self::direct_content_preserves(&verification, &candidate) {
                return Ok(true);
            }
            Self::merge_direct_content_preserving_mappings(accumulated_content, &candidate);
            Self::merge_direct_content_preserving_mappings(accumulated_content, &verification);
        }

        Err(BackendError::Other(
            "Matrix direct-message account data changed repeatedly; retry after other devices finish updating"
                .into(),
        ))
    }

    async fn is_ignored_user(
        &self,
        client: &Client,
        user_id: &matrix_sdk::ruma::UserId,
    ) -> BackendResult<bool> {
        let content = self.refresh_ignored_user_list(client).await?;
        Ok(content.ignored_users.contains_key(user_id))
    }

    fn notification_sender_is_ignored(
        ignored_users: Option<&HashSet<OwnedUserId>>,
        user_id: &matrix_sdk::ruma::UserId,
    ) -> bool {
        // A notification is a privacy projection, not required state. Unknown
        // cache state fails closed until the initial server read or a standard
        // m.ignored_user_list sync event establishes the current account list.
        ignored_users.is_none_or(|users| users.contains(user_id))
    }

    fn ignored_user_change(
        previous: Option<&HashSet<OwnedUserId>>,
        next: &HashSet<OwnedUserId>,
    ) -> Option<MatrixIgnoredUsersChanged> {
        if previous == Some(next) {
            return None;
        }
        let mut blocked_user_ids = previous
            .map(|previous| {
                next.difference(previous)
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        blocked_user_ids.sort();
        let reset_all = previous.is_none()
            || blocked_user_ids.len() > MAX_IGNORED_USER_CHANGE_IDS;
        if reset_all {
            blocked_user_ids.clear();
        }
        Some(MatrixIgnoredUsersChanged {
            blocked_user_ids,
            reset_all,
        })
    }

    fn ignored_user_list_matches(
        content: &IgnoredUserListEventContent,
        user_id: &matrix_sdk::ruma::UserId,
        blocked: bool,
    ) -> bool {
        content.ignored_users.contains_key(user_id) == blocked
    }

    fn direct_room_peer(room: &Room) -> BackendResult<Option<OwnedUserId>> {
        let targets = room.direct_targets();
        if targets.is_empty() {
            return Ok(None);
        }
        if targets.len() != 1 {
            return Err(BackendError::InvalidConfiguration(
                "group direct-message rooms are not supported".into(),
            ));
        }
        let target = targets
            .into_iter()
            .next()
            .ok_or_else(|| BackendError::InvalidConfiguration("direct room has no peer".into()))?;
        matrix_sdk::ruma::UserId::parse(target.as_str())
            .map(Some)
            .map_err(|error| {
                BackendError::InvalidConfiguration(format!(
                    "direct-message peer ID is malformed: {error}"
                ))
            })
    }

    fn room_has_ignored_direct_peer(
        room: &Room,
        ignored_users: &IgnoredUserListEventContent,
    ) -> BackendResult<bool> {
        Ok(Self::direct_room_peer(room)?
            .as_ref()
            .is_some_and(|peer| ignored_users.ignored_users.contains_key(peer)))
    }

    async fn reject_ignored_direct_room(&self, client: &Client, room: &Room) -> BackendResult<()> {
        let ignored_users = self.refresh_ignored_user_list(client).await?;
        if Self::room_has_ignored_direct_peer(room, &ignored_users)? {
            return Err(BackendError::InvalidConfiguration(
                "direct messages are blocked for this Matrix user".into(),
            ));
        }
        Ok(())
    }

    fn blocked_account_page_from_user_ids(
        user_ids: impl IntoIterator<Item = String>,
        after: Option<&str>,
        limit: u32,
    ) -> BlockedAccountPageDto {
        let mut user_ids = user_ids.into_iter().collect::<Vec<_>>();
        user_ids.sort();
        user_ids.dedup();

        let start = after
            .map(|cursor| user_ids.partition_point(|user_id| user_id.as_str() <= cursor))
            .unwrap_or(0);
        let page_size = limit.clamp(1, MAX_BLOCKED_ACCOUNT_PAGE_SIZE as u32) as usize;
        let end = start.saturating_add(page_size).min(user_ids.len());
        let accounts = user_ids[start..end]
            .iter()
            .cloned()
            .map(|user_id| BlockedAccountDto { user_id })
            .collect::<Vec<_>>();
        let next_cursor = (end < user_ids.len())
            .then(|| accounts.last().map(|account| account.user_id.clone()))
            .flatten();

        BlockedAccountPageDto {
            accounts,
            next_cursor,
        }
    }

    async fn fetch_ignored_user_list(client: &Client) -> BackendResult<IgnoredUserListEventContent> {
        client
            .account()
            .fetch_account_data_static::<IgnoredUserListEventContent>()
            .await
            .map_err(Self::map_error)?
            .map(|raw| raw.deserialize().map_err(Self::map_error))
            .transpose()
            .map(|content| content.unwrap_or_default())
    }

    async fn publish_ignored_user_cache(&self, content: &IgnoredUserListEventContent) {
        let cache = Arc::clone(&self.runtime.read().await.ignored_users);
        *cache.write().await = Some(content.ignored_users.keys().cloned().collect());
    }

    async fn refresh_ignored_user_list(
        &self,
        client: &Client,
    ) -> BackendResult<IgnoredUserListEventContent> {
        let content = Self::fetch_ignored_user_list(client).await?;
        self.publish_ignored_user_cache(&content).await;
        Ok(content)
    }

    async fn set_ignored_user(
        &self,
        client: &Client,
        recipient: OwnedUserId,
        blocked: bool,
    ) -> BackendResult<bool> {
        // m.ignored_user_list is a whole-account-data write. Serialize local
        // edits so two renderer actions cannot accidentally overwrite each
        // other's changes after reading the same snapshot.
        let _write_guard = self.ignored_user_writes.lock().await;
        for attempt in 0..IGNORED_USER_WRITE_ATTEMPTS {
            let mut content = self.refresh_ignored_user_list(client).await?;
            let already_matches = Self::ignored_user_list_matches(&content, &recipient, blocked);
            if already_matches {
                return Ok(blocked);
            }
            if blocked {
                content
                    .ignored_users
                    .insert(recipient.clone(), IgnoredUser::new());
            } else {
                content.ignored_users.remove(&recipient);
            }
            client
                .account()
                .set_account_data(content.clone())
                .await
                .map_err(Self::map_error)?;
            self.publish_ignored_user_cache(&content).await;

            let verification = match self.refresh_ignored_user_list(client).await {
                Ok(content) => content,
                Err(error) => {
                    // The server acknowledged the write. Do not report a
                    // misleading failure solely because the follow-up GET was
                    // interrupted; the next authoritative read will reconcile.
                    tracing::warn!(
                        target: "mesh::security",
                        recipient = %recipient,
                        "The account service accepted a block-list update, but Mesh could not verify it: {error}"
                    );
                    return Ok(blocked);
                }
            };
            if Self::ignored_user_list_matches(&verification, &recipient, blocked) {
                return Ok(blocked);
            }
            tracing::warn!(
                target: "mesh::security",
                recipient = %recipient,
                attempt = attempt + 1,
                "A concurrent account block-list update changed the requested account; retrying from the latest server state"
            );
        }

        Err(BackendError::Other(
            "The account block list changed repeatedly on another device; retry after that device finishes updating"
                .into(),
        ))
    }

    async fn direct_room(
        &self,
        client: &Client,
        user_id: &matrix_sdk::ruma::UserId,
    ) -> BackendResult<Room> {
        let mut direct_rooms = Self::direct_rooms(client, user_id);
        let inferred = direct_rooms.is_empty();
        if inferred {
            direct_rooms = Self::inferred_direct_rooms(client, user_id).await?;
        }
        let duplicate_count = direct_rooms.len();
        let direct_room_ids = direct_rooms
            .iter()
            .map(|room| room.room_id().to_owned())
            .collect::<Vec<_>>();
        let canonical_room_id = Self::canonical_direct_room_id(direct_room_ids.clone());
        let room = if let Some(canonical_room_id) = canonical_room_id {
            let room = direct_rooms
                .into_iter()
                .find(|room| room.room_id() == canonical_room_id)
                .expect("invariant: canonical direct room comes from the candidate set");
            if inferred || duplicate_count > 1 {
                Self::reconcile_direct_duplicates(
                    client,
                    user_id,
                    &direct_room_ids,
                    None,
                    inferred,
                )
                .await?;
            }
            room
        } else {
            // A second device can have a stale local account-data snapshot even
            // while the homeserver already contains valid m.direct mappings
            // written by another device. Preserve the authoritative snapshot
            // before create_dm updates last-write-wins account data, then merge
            // and verify it alongside the newly created room.
            let preserved_content = client
                .account()
                .fetch_account_data_static::<DirectEventContent>()
                .await
                .map_err(Self::map_error)?
                .map(|raw| raw.deserialize().map_err(Self::map_error))
                .transpose()?;
            let room = client.create_dm(user_id).await.map_err(Self::map_error)?;
            Self::reconcile_direct_duplicates(
                client,
                user_id,
                &[room.room_id().to_owned()],
                preserved_content.as_ref(),
                true,
            )
            .await?;
            room
        };
        Self::require_protected_room(&room, "opening this direct message").await?;
        Ok(room)
    }

    fn direct_message_from_message(message: MessageDto) -> DirectMessageDto {
        DirectMessageDto {
            id: message.id,
            conversation_id: message.channel_id,
            author_public_key: message.author_public_key,
            author_display_name: message.author_display_name,
            author_avatar_color: message.author_avatar_color,
            content: message.content,
            timestamp: message.timestamp,
            signature: message.signature,
            attachments: message.attachments,
            reactions: message.reactions,
            seen_by: None,
            edited_at: message.edited_at,
            deleted_at: message.deleted_at,
            reply_to_id: message.reply_to_id,
            thread_root_id: message.thread_root_id,
            delivery_status: message.delivery_status,
        }
    }

    async fn send_immediate_protected_message(
        client: &Client,
        room: &Room,
        body: String,
        reply_to_id: Option<String>,
        thread_root_id: Option<String>,
        transaction_id: String,
    ) -> BackendResult<MessageDto> {
        Self::require_protected_room(room, "sending a direct message").await?;
        Self::require_client_e2ee_ready(client).await?;
        let own_user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let base_content = RoomMessageEventContentWithoutRelation::text_plain(body.clone())
            .add_mentions(Self::mentions_for_body(body.as_str(), Some(own_user_id)));
        let content = match reply_to_id.as_deref() {
            Some(event_id) => {
                let event_id =
                    matrix_sdk::ruma::EventId::parse(event_id).map_err(Self::map_error)?;
                let is_thread_root_reply = thread_root_id.as_deref() == Some(event_id.as_str());
                room.make_reply_event(
                    base_content,
                    Reply {
                        event_id,
                        enforce_thread: if is_thread_root_reply {
                            EnforceThread::Threaded(ReplyWithinThread::No)
                        } else if thread_root_id.is_some() {
                            EnforceThread::Threaded(ReplyWithinThread::Yes)
                        } else {
                            EnforceThread::Unthreaded
                        },
                        add_mentions: AddMentions::Yes,
                    },
                )
                .await
                .map_err(Self::map_error)?
            }
            None => base_content.into(),
        };
        let transaction_id = Self::validate_transaction_id(&transaction_id)?;
        let response = room
            .send(content)
            .with_transaction_id(transaction_id.clone())
            .await
            .map_err(Self::map_matrix_send_error)?;
        let display_name = room
            .get_member(own_user_id)
            .await
            .map_err(Self::map_error)?
            .map(|member| member.name().to_owned())
            .unwrap_or_else(|| own_user_id.localpart().to_owned());

        Ok(MessageDto {
            id: response.response.event_id.to_string(),
            channel_id: room.room_id().to_string(),
            author_public_key: own_user_id.to_string(),
            author_display_name: display_name,
            author_avatar_color: Self::avatar_color(own_user_id.as_str()),
            content: body,
            attachments: Vec::new(),
            reactions: HashMap::new(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            signature: String::new(),
            edited_at: None,
            deleted_at: None,
            reply_to_id,
            thread_root_id,
            transaction_id: Some(transaction_id.to_string()),
            client_request_id: None,
            delivery_status: Some("sent".into()),
            undecryptable: None,
        })
    }
}
