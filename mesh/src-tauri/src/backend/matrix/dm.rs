impl MatrixBackend {
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
            let members = room
                .members(RoomMemberships::JOIN)
                .await
                .map_err(Self::map_error)?;
            if members.len() != 2
                || !members.iter().any(|member| member.user_id() == own_user_id)
                || !members.iter().any(|member| member.user_id() == user_id)
            {
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
        client: &Client,
        user_id: &matrix_sdk::ruma::UserId,
    ) -> BackendResult<bool> {
        let Some(raw_content) = client
            .account()
            .fetch_account_data_static::<IgnoredUserListEventContent>()
            .await
            .map_err(Self::map_error)?
        else {
            return Ok(false);
        };
        let content = raw_content.deserialize().map_err(Self::map_error)?;
        Ok(content.ignored_users.contains_key(user_id))
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
            .map_err(Self::map_error)?;
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
