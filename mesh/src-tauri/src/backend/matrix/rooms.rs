use super::*;

impl MatrixBackend {
    fn validate_room_upgrade_target(
        visited: &mut BTreeSet<OwnedRoomId>,
        successor_room_id: &RoomId,
        hop: usize,
    ) -> BackendResult<()> {
        if hop >= Self::MAX_ROOM_UPGRADE_HOPS {
            return Err(BackendError::InvalidConfiguration(
                "The room replacement history is longer than Mesh can open safely.".into(),
            ));
        }
        if !visited.insert(successor_room_id.to_owned()) {
            return Err(BackendError::InvalidConfiguration(
                "The room replacement history contains a cycle.".into(),
            ));
        }
        Ok(())
    }

    fn validate_room_upgrade_predecessor(valid: bool) -> BackendResult<()> {
        if valid {
            Ok(())
        } else {
            Err(BackendError::InvalidConfiguration(
                "The room replacement history does not link back to the room it replaces.".into(),
            ))
        }
    }

    pub(super) fn community_channel_join_rule_initial_state(
        space_id: &RoomId,
    ) -> Raw<AnyInitialStateEvent> {
        InitialStateEvent::with_empty_state_key(RoomJoinRulesEventContent::restricted(vec![
            AllowRule::room_membership(space_id.to_owned()),
        ]))
        .to_raw_any()
    }

    pub(super) async fn cache_verified_room_upgrade(
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
            .map_err(Self::map_display_error)?;
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
            .map_err(Self::map_display_error)?;
        if tombstone.replacement_room != replacement.room_id() {
            return Ok(None);
        }

        self.verified_room_upgrades.write().await.insert(
            predecessor.room_id.clone(),
            replacement.room_id().to_owned(),
        );
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
            // No tombstone is a real answer: this room was never upgraded.
            // Anything else is the service failing to tell us, and reporting
            // that as "never upgraded" leaves people writing in a dead room
            // while moderation silently skips its successor.
            Err(error) if matches!(error.client_api_error_kind(), Some(ErrorKind::NotFound)) => {
                return Ok(None)
            }
            Err(error) => return Err(Self::map_error(error)),
        };
        let content = response
            .into_content()
            .deserialize_as_unchecked::<RoomTombstoneEventContent>()
            .map_err(Self::map_display_error)?;
        Ok(Some(content.replacement_room))
    }

    pub(super) async fn joined_room_upgrade_chain(
        &self,
        client: &Client,
        room: Room,
        action: &str,
    ) -> BackendResult<Vec<Room>> {
        let mut rooms = vec![room];
        let mut visited = BTreeSet::from([rooms[0].room_id().to_owned()]);

        for hop in 0..=Self::MAX_ROOM_UPGRADE_HOPS {
            let Some(current) = rooms.last() else {
                return Err(BackendError::Other(
                    "Room replacement traversal lost its starting room".into(),
                ));
            };
            let current_room_id = current.room_id().to_owned();
            let Some(successor_room_id) = self.joined_successor_room_id(client, current).await?
            else {
                break;
            };
            Self::validate_room_upgrade_target(&mut visited, &successor_room_id, hop)?;

            let successor =
                match Self::protected_joined_room_if_available(client, &successor_room_id, action)
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
            Self::validate_room_upgrade_predecessor(valid_predecessor)?;

            rooms.push(successor);
        }

        Ok(rooms)
    }

    /// Enumeration-safe variant of upgrade traversal. A broken successor is
    /// quarantined without removing the last verified room from the result.
    pub(super) async fn joined_room_upgrade_chain_quarantined(
        &self,
        client: &Client,
        room: Room,
        action: &str,
    ) -> BackendResult<EntityList<Room>> {
        let mut rooms = vec![room];
        let mut blocked_entities = Vec::new();
        let mut visited = BTreeSet::from([rooms[0].room_id().to_owned()]);

        for hop in 0..=Self::MAX_ROOM_UPGRADE_HOPS {
            let Some(current) = rooms.last() else {
                return Err(BackendError::Other(
                    "Room replacement traversal lost its starting room".into(),
                ));
            };
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
            if let Err(error) =
                Self::validate_room_upgrade_target(&mut visited, &successor_room_id, hop)
            {
                Self::quarantine_entity::<Room>(
                    &mut rooms,
                    &mut blocked_entities,
                    successor_room_id.to_string(),
                    BlockedEntityKind::Upgrade,
                    Err(error),
                )?;
                break;
            }

            let successor =
                match Self::protected_joined_room_if_available(client, &successor_room_id, action)
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
                    Ok(predecessor) => {
                        predecessor.is_some_and(|predecessor| predecessor == current_room_id)
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
            }
            if let Err(error) = Self::validate_room_upgrade_predecessor(valid_predecessor) {
                Self::quarantine_entity::<Room>(
                    &mut rooms,
                    &mut blocked_entities,
                    successor_room_id.to_string(),
                    BlockedEntityKind::Upgrade,
                    Err(error),
                )?;
                break;
            }
            rooms.push(successor);
        }

        Ok(EntityList {
            entities: rooms,
            blocked_entities,
        })
    }

    /// Lists the rooms a space names as children, bounded the same way the
    /// hierarchy listing is.
    ///
    /// Every caller allocates per returned identifier -- a room handle, a
    /// projection row, or a join request -- and the child list is remote state,
    /// so an unbounded return value hands a homeserver direct control over how
    /// much each of those callers allocates. The cap and its message match
    /// `append_bounded_space_hierarchy_room_ids`, and it fails closed for the
    /// same reason: a partial list would silently under-report a community's
    /// rooms to permission and moderation callers that treat the list as
    /// complete.
    ///
    /// The state-events endpoint has no pagination, so this bounds what is
    /// derived from the response rather than the response itself.
    pub(super) async fn space_child_ids(&self, space: &Room) -> BackendResult<Vec<OwnedRoomId>> {
        let space_id = space.room_id();
        let response = self
            .client()
            .await?
            .send(get_state_events::v3::Request::new(space_id.to_owned()))
            .await
            .map_err(Self::map_error)?;

        let mut child_ids = Vec::new();
        let mut seen = HashSet::new();
        for event in response.room_state {
            let Some(event_type) = event.get_field::<String>("type").ok().flatten() else {
                continue;
            };
            if event_type != "m.space.child" {
                continue;
            }
            let Some(state_key) = event.get_field::<String>("state_key").ok().flatten() else {
                continue;
            };
            let Ok(child_id) = matrix_sdk::ruma::RoomId::parse(state_key) else {
                continue;
            };
            if child_id == space_id || !seen.insert(child_id.clone()) {
                continue;
            }
            if child_ids.len() >= MAX_COMMUNITY_CHANNELS {
                return Err(BackendError::InvalidConfiguration(format!(
                    "This community has more than {MAX_COMMUNITY_CHANNELS} channels, which Mesh cannot open safely yet. Ask an owner to archive channels or open a smaller community."
                )));
            }
            child_ids.push(child_id);
        }
        Ok(child_ids)
    }

    pub(super) async fn community_rooms(&self, community_id: &str) -> BackendResult<Vec<Room>> {
        let client = self.client().await?;
        let space_id =
            matrix_sdk::ruma::RoomId::parse(community_id).map_err(Self::map_display_error)?;
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
                    .joined_room_upgrade_chain(&client, room, "opening this community channel")
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

#[cfg(test)]
mod room_upgrade_tests {
    use super::*;

    #[test]
    fn upgrade_target_rejects_cycles_and_excessive_depth() {
        let start = RoomId::parse("!start:example.org").unwrap();
        let next = RoomId::parse("!next:example.org").unwrap();
        let overflow = RoomId::parse("!overflow:example.org").unwrap();
        let mut visited = BTreeSet::from([start]);

        MatrixBackend::validate_room_upgrade_target(&mut visited, &next, 0).unwrap();
        assert!(matches!(
            MatrixBackend::validate_room_upgrade_target(&mut visited, &next, 1),
            Err(BackendError::InvalidConfiguration(_))
        ));
        assert!(matches!(
            MatrixBackend::validate_room_upgrade_target(
                &mut visited,
                &overflow,
                MatrixBackend::MAX_ROOM_UPGRADE_HOPS,
            ),
            Err(BackendError::InvalidConfiguration(_))
        ));
    }

    #[test]
    fn upgrade_target_rejects_a_malformed_predecessor_link() {
        assert!(MatrixBackend::validate_room_upgrade_predecessor(true).is_ok());
        assert!(matches!(
            MatrixBackend::validate_room_upgrade_predecessor(false),
            Err(BackendError::InvalidConfiguration(_))
        ));
    }
}
