const MAX_PERSONAL_EXPORT_SCANNED_EVENTS_PER_ROOM: usize = 250_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonalDataExportAccount {
    user_id: String,
    homeserver: String,
    device_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonalDataExportScope {
    messages: &'static str,
    media: &'static str,
    excluded: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonalDataExportRoom {
    room_id: String,
    name: String,
    direct_message: bool,
    messages: Vec<MessageDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonalDataExportDocument {
    schema_version: u32,
    exported_at: String,
    account: PersonalDataExportAccount,
    scope: PersonalDataExportScope,
    rooms: Vec<PersonalDataExportRoom>,
    warnings: Vec<String>,
}

struct PersonalDataExportContents {
    rooms: Vec<PersonalDataExportRoom>,
    media_hashes: HashSet<String>,
    warnings: Vec<String>,
}

impl MatrixBackend {
    fn personal_export_event_is_relevant(value: &serde_json::Value, own_user_id: &str) -> bool {
        let event_type = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if event_type == "m.room.redaction" {
            // A moderator may have removed one of the user's messages. Retain
            // redactions in memory so the exported projection does not revive
            // content, but never serialize the raw redaction event.
            return true;
        }
        if value.get("sender").and_then(serde_json::Value::as_str) != Some(own_user_id) {
            return false;
        }
        matches!(
            event_type,
            "m.room.message" | "m.reaction" | crate::backend::LEGACY_MATRIX_EVENT_TYPE
        )
    }

    fn personal_export_cache_prefix(file_hash: &str) -> String {
        let safe_hash: String = file_hash
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character
                } else {
                    '_'
                }
            })
            .collect();
        format!("{safe_hash}-")
    }

    async fn personal_export_room_values(
        room: &Room,
        own_user_id: &str,
    ) -> BackendResult<(Vec<serde_json::Value>, bool, usize)> {
        const PAGE_SIZE: u32 = 100;

        let mut values = Vec::new();
        let mut from = None;
        let mut scanned = 0_usize;
        let mut malformed = 0_usize;
        let mut truncated = false;

        loop {
            let mut options = MessagesOptions::backward();
            options.limit = PAGE_SIZE.into();
            options.from = from;
            let response = room.messages(options).await.map_err(Self::map_error)?;
            if response.chunk.is_empty() {
                break;
            }

            for event in response.chunk {
                scanned = scanned.saturating_add(1);
                match event.raw().deserialize_as::<serde_json::Value>() {
                    Ok(value) if Self::personal_export_event_is_relevant(&value, own_user_id) => {
                        values.push(value);
                    }
                    Ok(_) => {}
                    Err(error) => {
                        malformed = malformed.saturating_add(1);
                        tracing::warn!(
                            target: "mesh::privacy",
                            room_id = %room.room_id(),
                            "Skipping malformed event during personal-data export: {error}"
                        );
                    }
                }
            }

            if scanned >= MAX_PERSONAL_EXPORT_SCANNED_EVENTS_PER_ROOM {
                truncated = response.end.is_some();
                break;
            }
            let Some(next) = response.end else {
                break;
            };
            from = Some(next);
        }

        Ok((values, truncated, malformed))
    }

    async fn collect_personal_data_export(
        &self,
        client: &Client,
        own_user_id: &UserId,
    ) -> BackendResult<PersonalDataExportContents> {
        let mut rooms = Vec::new();
        let mut media_hashes = HashSet::new();
        let mut warnings = Vec::new();

        for room in client.joined_rooms() {
            let (values, truncated, malformed) =
                Self::personal_export_room_values(&room, own_user_id.as_str()).await?;
            let display_name = room
                .get_member(own_user_id)
                .await
                .map_err(Self::map_error)?
                .map(|member| member.name().to_owned())
                .unwrap_or_else(|| own_user_id.localpart().to_owned());
            let members = HashMap::from([(own_user_id.to_string(), display_name)]);
            let mut messages = Self::project_timeline(room.room_id().as_str(), &members, values)
                .into_iter()
                .filter(|message| message.author_public_key == own_user_id.as_str())
                .collect::<Vec<_>>();

            for message in &mut messages {
                message.reactions.retain(|_, authors| {
                    authors.retain(|author| author == own_user_id.as_str());
                    !authors.is_empty()
                });
                message.transaction_id = None;
                message.client_request_id = None;
                message.delivery_status = None;
                for attachment in &message.attachments {
                    media_hashes.insert(attachment.file_hash.clone());
                }
            }

            if truncated {
                warnings.push(format!(
                    "{} reached Mesh's safety limit while scanning history; older authored messages may be absent.",
                    room.name().unwrap_or_else(|| room.room_id().to_string())
                ));
            }
            if malformed > 0 {
                warnings.push(format!(
                    "{} contained {malformed} unreadable event{} that could not be exported.",
                    room.name().unwrap_or_else(|| room.room_id().to_string()),
                    if malformed == 1 { "" } else { "s" }
                ));
            }
            if messages.is_empty() {
                continue;
            }

            rooms.push(PersonalDataExportRoom {
                room_id: room.room_id().to_string(),
                name: room
                    .name()
                    .unwrap_or_else(|| "Unnamed conversation".to_owned()),
                direct_message: room.direct_targets().len() == 1,
                messages,
            });
        }

        rooms.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.room_id.cmp(&right.room_id))
        });
        Ok(PersonalDataExportContents {
            rooms,
            media_hashes,
            warnings,
        })
    }

    async fn copy_personal_export_media(
        cache_root: &Path,
        export_root: &Path,
        media_hashes: &HashSet<String>,
        warnings: &mut Vec<String>,
    ) -> BackendResult<u32> {
        if media_hashes.is_empty() {
            return Ok(0);
        }
        if !tokio::fs::try_exists(cache_root)
            .await
            .map_err(Self::map_error)?
        {
            warnings.push(format!(
                "{} attachment{} referenced by your messages had no downloaded local copy. Mesh did not download anything new for this export.",
                media_hashes.len(),
                if media_hashes.len() == 1 { "" } else { "s" }
            ));
            return Ok(0);
        }

        let prefixes = media_hashes
            .iter()
            .map(|hash| Self::personal_export_cache_prefix(hash))
            .collect::<Vec<_>>();
        let media_root = export_root.join("media");
        let mut source_entries = tokio::fs::read_dir(cache_root)
            .await
            .map_err(Self::map_error)?;
        let mut copied = 0_u32;
        let mut created_media_root = false;

        while let Some(entry) = source_entries.next_entry().await.map_err(Self::map_error)? {
            let file_type = entry.file_type().await.map_err(Self::map_error)?;
            if !file_type.is_file() {
                continue;
            }
            let filename = entry.file_name();
            let filename_text = filename.to_string_lossy();
            if !prefixes
                .iter()
                .any(|prefix| filename_text.starts_with(prefix))
            {
                continue;
            }
            if !created_media_root {
                create_private_dir(&media_root, false)
                    .await
                    .map_err(Self::map_error)?;
                created_media_root = true;
            }

            let destination = media_root.join(&filename);
            let copy_result: std::io::Result<()> = async {
                let mut source = tokio::fs::File::open(entry.path()).await?;
                let mut target = open_private_file(&destination, true).await?;
                tokio::io::copy(&mut source, &mut target).await?;
                target.sync_all().await
            }
            .await;
            if let Err(error) = copy_result {
                let _ = tokio::fs::remove_file(&destination).await;
                warnings.push(format!(
                    "A locally downloaded attachment ({filename_text}) could not be copied: {error}"
                ));
                continue;
            }
            copied = copied.saturating_add(1);
        }

        let missing = media_hashes.len().saturating_sub(copied as usize);
        if missing > 0 {
            warnings.push(format!(
                "{missing} attachment{} referenced by your messages had no downloaded local copy. Mesh did not download anything new for this export.",
                if missing == 1 { "" } else { "s" }
            ));
        }
        Ok(copied)
    }

    async fn write_personal_data_export(
        &self,
        destination_root: PathBuf,
    ) -> BackendResult<MatrixPersonalDataExport> {
        let metadata = tokio::fs::metadata(&destination_root)
            .await
            .map_err(Self::map_error)?;
        if !metadata.is_dir() {
            return Err(BackendError::InvalidConfiguration(
                "choose a folder for the personal-data export".into(),
            ));
        }

        let client = self.client().await?;
        let own_user_id = client
            .user_id()
            .ok_or(BackendError::NotAuthenticated)?
            .to_owned();
        let profile_id = self
            .runtime
            .read()
            .await
            .profile_id
            .clone()
            .ok_or(BackendError::NotAuthenticated)?;
        let storage = self.storage_for_profile(&profile_id);
        let canonical_destination = tokio::fs::canonicalize(&destination_root)
            .await
            .map_err(Self::map_error)?;
        if let Ok(canonical_store) = tokio::fs::canonicalize(&storage.store_root).await {
            if canonical_destination.starts_with(&canonical_store)
                || canonical_store.starts_with(&canonical_destination)
            {
                return Err(BackendError::InvalidConfiguration(
                    "choose a folder outside Mesh's private account storage".into(),
                ));
            }
        }

        let exported_at = chrono::Utc::now();
        let base_name = format!(
            "Mesh personal data {}",
            exported_at.format("%Y-%m-%d %H-%M-%S")
        );
        let mut final_root = canonical_destination.join(&base_name);
        let mut suffix = 2_u16;
        while tokio::fs::try_exists(&final_root)
            .await
            .map_err(Self::map_error)?
        {
            final_root = canonical_destination.join(format!("{base_name} ({suffix})"));
            suffix = suffix.saturating_add(1);
            if suffix == u16::MAX {
                return Err(BackendError::Other(
                    "could not choose a unique personal-data export folder".into(),
                ));
            }
        }
        let staging_root = canonical_destination.join(format!(
            ".mesh-personal-data-{}.partial",
            uuid::Uuid::new_v4()
        ));
        create_private_dir(&staging_root, false)
            .await
            .map_err(Self::map_error)?;

        let export_result: BackendResult<(u32, u64, u32, Vec<String>)> = async {
            let PersonalDataExportContents {
                rooms,
                media_hashes,
                mut warnings,
            } = self
                .collect_personal_data_export(&client, &own_user_id)
                .await?;
            let room_count = rooms.len().min(u32::MAX as usize) as u32;
            let message_count = rooms
                .iter()
                .map(|room| room.messages.len() as u64)
                .sum::<u64>();
            let media_file_count = Self::copy_personal_export_media(
                &storage.store_root.join("media-cache"),
                &staging_root,
                &media_hashes,
                &mut warnings,
            )
            .await?;
            let document = PersonalDataExportDocument {
                schema_version: 1,
                exported_at: exported_at.to_rfc3339(),
                account: PersonalDataExportAccount {
                    user_id: own_user_id.to_string(),
                    homeserver: client.homeserver().to_string(),
                    device_id: client.device_id().map(ToString::to_string),
                },
                scope: PersonalDataExportScope {
                    messages: "Messages authored by this account that Mesh could read from joined conversations, including the latest visible edit and deletion state.",
                    media: "Only already-downloaded local copies attached to those authored messages. Mesh did not download additional media.",
                    excluded: "Messages authored by other people, encryption secrets, access tokens, device keys, and service-side operational records.",
                },
                rooms,
                warnings: warnings.clone(),
            };
            let json = serde_json::to_vec_pretty(&document).map_err(Self::map_error)?;
            let document_path = staging_root.join("mesh-personal-data.json");
            let mut file = open_private_file(&document_path, true)
                .await
                .map_err(Self::map_error)?;
            file.write_all(&json).await.map_err(Self::map_error)?;
            file.sync_all().await.map_err(Self::map_error)?;
            drop(file);
            tokio::fs::rename(&staging_root, &final_root)
                .await
                .map_err(Self::map_error)?;
            Ok((room_count, message_count, media_file_count, warnings))
        }
        .await;

        let (room_count, message_count, media_file_count, warnings) = match export_result {
            Ok(summary) => summary,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&staging_root).await;
                return Err(error);
            }
        };

        Ok(MatrixPersonalDataExport {
            path: final_root.to_string_lossy().into_owned(),
            exported_at: exported_at.to_rfc3339(),
            room_count,
            message_count,
            media_file_count,
            warnings,
        })
    }
}
