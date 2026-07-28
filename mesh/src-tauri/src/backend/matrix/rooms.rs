impl MatrixBackend {
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
                rooms.push(room);
            }
        }
        Ok(rooms)
    }
}
