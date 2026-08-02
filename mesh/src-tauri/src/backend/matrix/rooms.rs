impl MatrixBackend {
    fn community_channel_join_rule_initial_state(
        space_id: &RoomId,
    ) -> Raw<AnyInitialStateEvent> {
        InitialStateEvent::with_empty_state_key(RoomJoinRulesEventContent::restricted(vec![
            AllowRule::room_membership(space_id.to_owned()),
        ]))
        .to_raw_any()
    }

    async fn cache_verified_room_upgrade(
        &self,
        client: &Client,
        replacement: &Room,
        action: &str,
    ) -> BackendResult<Option<OwnedRoomId>> {
        let create = client
            .send(get_state_event_for_key::v3::Request::new(
                replacement.room_id().to_owned(),
                StateEventType::RoomCreate,
                String::new(),
            ))
            .await
            .map_err(Self::map_error)?
            .into_content()
            .deserialize_as_unchecked::<RoomCreateEventContent>()
            .map_err(Self::map_error)?;
        let Some(predecessor) = create.predecessor else {
            return Ok(None);
        };
        let Some(predecessor_room) =
            Self::protected_joined_room_if_available(client, &predecessor.room_id, action).await?
        else {
            return Ok(None);
        };
        let tombstone = client
            .send(get_state_event_for_key::v3::Request::new(
                predecessor_room.room_id().to_owned(),
                StateEventType::RoomTombstone,
                String::new(),
            ))
            .await
            .map_err(Self::map_error)?
            .into_content()
            .deserialize_as_unchecked::<RoomTombstoneEventContent>()
            .map_err(Self::map_error)?;
        if tombstone.replacement_room != replacement.room_id() {
            return Ok(None);
        }

        self.verified_room_upgrades
            .write()
            .await
            .insert(predecessor.room_id.clone(), replacement.room_id().to_owned());
        Ok(Some(predecessor.room_id))
    }

    async fn joined_successor_room_id(
        &self,
        client: &Client,
        room: &Room,
    ) -> BackendResult<Option<OwnedRoomId>> {
        if let Some(successor) = room.successor_room() {
            return Ok(Some(successor.room_id));
        }
        if let Some(successor_room_id) = self
            .verified_room_upgrades
            .read()
            .await
            .get(room.room_id())
            .cloned()
        {
            return Ok(Some(successor_room_id));
        }

        let has_joined_successor_candidate = client.joined_rooms().into_iter().any(|candidate| {
            candidate
                .predecessor_room()
                .is_some_and(|predecessor| predecessor.room_id == room.room_id())
        });
        if !has_joined_successor_candidate {
            return Ok(None);
        }

        let response = match client
            .send(get_state_event_for_key::v3::Request::new(
                room.room_id().to_owned(),
                StateEventType::RoomTombstone,
                String::new(),
            ))
            .await
        {
            Ok(response) => response,
            Err(_) => return Ok(None),
        };
        let content = response
            .into_content()
            .deserialize_as_unchecked::<RoomTombstoneEventContent>()
            .map_err(Self::map_error)?;
        Ok(Some(content.replacement_room))
    }

    async fn joined_room_upgrade_chain(
        &self,
        client: &Client,
        room: Room,
        action: &str,
    ) -> BackendResult<Vec<Room>> {
        let mut rooms = vec![room];
        let mut visited = BTreeSet::from([rooms[0].room_id().to_owned()]);

        for _ in 0..Self::MAX_ROOM_UPGRADE_HOPS {
            let current_room_id = rooms
                .last()
                .expect("the room upgrade chain always contains its starting room")
                .room_id()
                .to_owned();
            let Some(successor_room_id) = self
                .joined_successor_room_id(
                client,
                rooms
                    .last()
                    .expect("the room upgrade chain always contains its starting room"),
            )
            .await?
            else {
                break;
            };
            if !visited.insert(successor_room_id.clone()) {
                break;
            }

            let successor = match Self::protected_joined_room_if_available(
                client,
                &successor_room_id,
                action,
            )
            .await
            {
                Ok(Some(successor)) => successor,
                Ok(None) | Err(BackendError::NotEncrypted(_)) => break,
                Err(error) => return Err(error),
            };
            if successor.is_space() {
                break;
            }
            let mut valid_predecessor = successor
                .predecessor_room()
                .is_some_and(|predecessor| predecessor.room_id == current_room_id);
            if !valid_predecessor {
                valid_predecessor = self
                    .verified_room_upgrades
                    .read()
                    .await
                    .get(&current_room_id)
                    .is_some_and(|replacement| replacement == successor.room_id());
            }
            if !valid_predecessor {
                valid_predecessor = self
                    .cache_verified_room_upgrade(client, &successor, action)
                    .await?
                    .is_some_and(|predecessor| predecessor == current_room_id);
            }
            if !valid_predecessor {
                break;
            }

            rooms.push(successor);
        }

        Ok(rooms)
    }

    /// Enumeration-safe variant of upgrade traversal. A broken successor is
    /// quarantined without removing the last verified room from the result.
    async fn joined_room_upgrade_chain_quarantined(
        &self,
        client: &Client,
        room: Room,
        action: &str,
    ) -> BackendResult<EntityList<Room>> {
        let mut rooms = vec![room];
        let mut blocked_entities = Vec::new();
        let mut visited = BTreeSet::from([rooms[0].room_id().to_owned()]);

        for _ in 0..Self::MAX_ROOM_UPGRADE_HOPS {
            let current = rooms
                .last()
                .expect("the room upgrade chain always contains its starting room");
            let current_room_id = current.room_id().to_owned();
            let successor_room_id = match self.joined_successor_room_id(client, current).await {
                Ok(Some(room_id)) => room_id,
                Ok(None) => break,
                Err(error) => {
                    Self::quarantine_entity::<Room>(
                        &mut rooms,
                        &mut blocked_entities,
                        current_room_id.to_string(),
                        BlockedEntityKind::Upgrade,
                        Err(error),
                    )?;
                    break;
                }
            };
            if !visited.insert(successor_room_id.clone()) {
                if blocked_entities.len() < MAX_BLOCKED_ENTITY_DIAGNOSTICS {
                    blocked_entities.push(BlockedEntityDiagnostic {
                        entity_id: successor_room_id.to_string(),
                        entity_kind: BlockedEntityKind::Upgrade,
                        reason: BlockedEntityReason::Unsupported,
                    });
                }
                break;
            }

            let successor = match Self::protected_joined_room_if_available(
                client,
                &successor_room_id,
                action,
            )
            .await
            {
                Ok(Some(successor)) => successor,
                Ok(None) => {
                    if blocked_entities.len() < MAX_BLOCKED_ENTITY_DIAGNOSTICS {
                        blocked_entities.push(BlockedEntityDiagnostic {
                            entity_id: successor_room_id.to_string(),
                            entity_kind: BlockedEntityKind::Upgrade,
                            reason: BlockedEntityReason::Inaccessible,
                        });
                    }
                    break;
                }
                Err(error) => {
                    Self::quarantine_entity::<Room>(
                        &mut rooms,
                        &mut blocked_entities,
                        successor_room_id.to_string(),
                        BlockedEntityKind::Upgrade,
                        Err(error),
                    )?;
                    break;
                }
            };
            if successor.is_space() {
                if blocked_entities.len() < MAX_BLOCKED_ENTITY_DIAGNOSTICS {
                    blocked_entities.push(BlockedEntityDiagnostic {
                        entity_id: successor_room_id.to_string(),
                        entity_kind: BlockedEntityKind::Upgrade,
                        reason: BlockedEntityReason::Unsupported,
                    });
                }
                break;
            }
            let mut valid_predecessor = successor
                .predecessor_room()
                .is_some_and(|predecessor| predecessor.room_id == current_room_id);
            if !valid_predecessor {
                valid_predecessor = self
                    .verified_room_upgrades
                    .read()
                    .await
                    .get(&current_room_id)
                    .is_some_and(|replacement| replacement == successor.room_id());
            }
            if !valid_predecessor {
                valid_predecessor = match self
                    .cache_verified_room_upgrade(client, &successor, action)
                    .await
                {
                    Ok(predecessor) => predecessor
                        .is_some_and(|predecessor| predecessor == current_room_id),
                    Err(error) => {
                        Self::quarantine_entity::<Room>(
                            &mut rooms,
                            &mut blocked_entities,
                            successor_room_id.to_string(),
                            BlockedEntityKind::Upgrade,
                            Err(error),
                        )?;
                        break;
                    }
                };
            }
            if !valid_predecessor {
                if blocked_entities.len() < MAX_BLOCKED_ENTITY_DIAGNOSTICS {
                    blocked_entities.push(BlockedEntityDiagnostic {
                        entity_id: successor_room_id.to_string(),
                        entity_kind: BlockedEntityKind::Upgrade,
                        reason: BlockedEntityReason::Unsupported,
                    });
                }
                break;
            }
            rooms.push(successor);
        }

        Ok(EntityList {
            entities: rooms,
            blocked_entities,
        })
    }

    async fn space_child_ids(&self, space: &Room) -> BackendResult<Vec<OwnedRoomId>> {
        let response = self
            .client()
            .await?
            .send(get_state_events::v3::Request::new(
                space.room_id().to_owned(),
            ))
            .await
            .map_err(Self::map_error)?;

        Ok(response
            .room_state
            .into_iter()
            .filter_map(|event| {
                let event_type = event.get_field::<String>("type").ok().flatten()?;
                if event_type != "m.space.child" {
                    return None;
                }
                let state_key = event.get_field::<String>("state_key").ok().flatten()?;
                matrix_sdk::ruma::RoomId::parse(state_key).ok()
            })
            .collect())
    }

    async fn community_rooms(&self, community_id: &str) -> BackendResult<Vec<Room>> {
        let client = self.client().await?;
        let space_id = matrix_sdk::ruma::RoomId::parse(community_id).map_err(Self::map_error)?;
        let space =
            Self::protected_joined_room(&client, &space_id, "opening this community").await?;
        if !space.is_space() {
            return Err(BackendError::InvalidConfiguration(
                "community ID does not identify a Matrix Space".into(),
            ));
        }

        let mut visited = BTreeSet::from([space.room_id().to_owned()]);
        let mut rooms = vec![space];
        for child_id in self.space_child_ids(&rooms[0]).await? {
            let room = match Self::protected_joined_room(
                &client,
                &child_id,
                "opening this community channel",
            )
            .await
            {
                Ok(room) => room,
                Err(BackendError::NotFound(_)) => continue,
                Err(error) => return Err(error),
            };
            if !room.is_space() {
                for room in self
                    .joined_room_upgrade_chain(
                    &client,
                    room,
                    "opening this community channel",
                )
                .await?
                {
                    if visited.insert(room.room_id().to_owned()) {
                        rooms.push(room);
                    }
                }
            }
        }
        Ok(rooms)
    }
}
