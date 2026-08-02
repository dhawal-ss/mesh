const MAX_PERSONAL_EXPORT_SCANNED_EVENTS_PER_ROOM: usize = 250_000;
const MAX_PERSONAL_EXPORT_ROOMS: usize = 5_000;
const MAX_PERSONAL_EXPORT_SCANNED_EVENTS: usize = 1_000_000;
const MAX_PERSONAL_EXPORT_MESSAGES: usize = 250_000;
const MAX_PERSONAL_EXPORT_MEDIA_FILES: usize = 10_000;
const MAX_PERSONAL_EXPORT_MEDIA_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PERSONAL_EXPORT_JSON_BYTES: u64 = 256 * 1024 * 1024;

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

#[derive(Default)]
struct PersonalDataExportBudget {
    scanned_events: usize,
    exported_messages: usize,
    serialized_bytes: u64,
    media_files: usize,
    media_bytes: u64,
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
        cancellation: &CancellationToken,
        budget: &mut PersonalDataExportBudget,
    ) -> BackendResult<(Vec<serde_json::Value>, bool, usize)> {
        const PAGE_SIZE: u32 = 100;

        let mut values = Vec::new();
        let mut from = None;
        let mut scanned = 0_usize;
        let mut malformed = 0_usize;
        let mut truncated = false;

        loop {
            if cancellation.is_cancelled() {
                return Err(BackendError::Cancelled(
                    "personal-data export cancelled".into(),
                ));
            }
            let mut options = MessagesOptions::backward();
            options.limit = PAGE_SIZE.into();
            options.from = from;
            let response = tokio::select! {
                biased;
                _ = cancellation.cancelled() => {
                    return Err(BackendError::Cancelled("personal-data export cancelled".into()))
                }
                response = room.messages(options) => response.map_err(Self::map_error)?,
            };
            if response.chunk.is_empty() {
                break;
            }

            for event in response.chunk {
                scanned = scanned.saturating_add(1);
                budget.scanned_events = budget.scanned_events.saturating_add(1);
                if budget.scanned_events > MAX_PERSONAL_EXPORT_SCANNED_EVENTS {
                    return Err(BackendError::Other(format!(
                        "Personal-data export exceeded the global {MAX_PERSONAL_EXPORT_SCANNED_EVENTS}-event safety limit"
                    )));
                }
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

    async fn project_personal_export_room(
        room: &Room,
        own_user_id: &UserId,
        cancellation: &CancellationToken,
        budget: &mut PersonalDataExportBudget,
        media_hashes: &mut HashSet<String>,
        warnings: &mut Vec<String>,
    ) -> BackendResult<Option<PersonalDataExportRoom>> {
        let (values, truncated, malformed) = Self::personal_export_room_values(
            room,
            own_user_id.as_str(),
            cancellation,
            budget,
        )
        .await?;
        let display_name = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                return Err(BackendError::Cancelled("personal-data export cancelled".into()))
            }
            member = room.get_member(own_user_id) => member.map_err(Self::map_error)?,
        }
        .map(|member| member.name().to_owned())
        .unwrap_or_else(|| own_user_id.localpart().to_owned());
        let members = HashMap::from([(own_user_id.to_string(), display_name)]);
        let mut messages = Self::project_timeline(room.room_id().as_str(), &members, values)
            .into_iter()
            .filter(|message| message.author_public_key == own_user_id.as_str())
            .collect::<Vec<_>>();

        budget.exported_messages = budget.exported_messages.saturating_add(messages.len());
        if budget.exported_messages > MAX_PERSONAL_EXPORT_MESSAGES {
            return Err(BackendError::Other(format!(
                "Personal-data export exceeded the global {MAX_PERSONAL_EXPORT_MESSAGES}-message safety limit"
            )));
        }
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
                if media_hashes.len() > MAX_PERSONAL_EXPORT_MEDIA_FILES {
                    return Err(BackendError::Other(format!(
                        "Personal-data export exceeded the global {MAX_PERSONAL_EXPORT_MEDIA_FILES}-attachment safety limit"
                    )));
                }
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
            return Ok(None);
        }

        Ok(Some(PersonalDataExportRoom {
            room_id: room.room_id().to_string(),
            name: room
                .name()
                .unwrap_or_else(|| "Unnamed conversation".to_owned()),
            direct_message: room.direct_targets().len() == 1,
            messages,
        }))
    }

    #[cfg(test)]
    async fn copy_personal_export_media(
        cache_root: &Path,
        export_root: &Path,
        media_hashes: &HashSet<String>,
        warnings: &mut Vec<String>,
    ) -> BackendResult<u32> {
        Self::copy_personal_export_media_bounded(
            cache_root,
            export_root,
            media_hashes,
            warnings,
            &CancellationToken::new(),
            &mut PersonalDataExportBudget::default(),
        )
        .await
    }

    async fn copy_personal_export_media_bounded(
        cache_root: &Path,
        export_root: &Path,
        media_hashes: &HashSet<String>,
        warnings: &mut Vec<String>,
        cancellation: &CancellationToken,
        budget: &mut PersonalDataExportBudget,
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
            if cancellation.is_cancelled() {
                return Err(BackendError::Cancelled(
                    "personal-data export cancelled".into(),
                ));
            }
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
                let metadata = source.metadata().await?;
                let next_media_files = budget.media_files.saturating_add(1);
                let next_media_bytes = budget.media_bytes.saturating_add(metadata.len());
                if next_media_files > MAX_PERSONAL_EXPORT_MEDIA_FILES
                    || next_media_bytes > MAX_PERSONAL_EXPORT_MEDIA_BYTES
                {
                    return Err(std::io::Error::other(
                        "personal-data export media safety limit exceeded",
                    ));
                }
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    if cancellation.is_cancelled() {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "personal-data export cancelled",
                        ));
                    }
                    let read = tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => {
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::Interrupted,
                                "personal-data export cancelled",
                            ))
                        }
                        result = source.read(&mut buffer) => result?,
                    };
                    if read == 0 {
                        break;
                    }
                    if cancellation.is_cancelled() {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "personal-data export cancelled",
                        ));
                    }
                    tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => {
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::Interrupted,
                                "personal-data export cancelled",
                            ))
                        }
                        result = target.write_all(&buffer[..read]) => result?,
                    }
                }
                if cancellation.is_cancelled() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "personal-data export cancelled",
                    ));
                }
                target.sync_all().await
            }
            .await;
            if let Err(error) = copy_result {
                let _ = tokio::fs::remove_file(&destination).await;
                if error.kind() == std::io::ErrorKind::Interrupted {
                    return Err(BackendError::Cancelled(
                        "personal-data export cancelled".into(),
                    ));
                }
                if error.to_string().contains("safety limit exceeded") {
                    return Err(BackendError::Other(error.to_string()));
                }
                warnings.push(format!(
                    "A locally downloaded attachment ({filename_text}) could not be copied: {error}"
                ));
                continue;
            }
            if cancellation.is_cancelled() {
                let _ = tokio::fs::remove_file(&destination).await;
                return Err(BackendError::Cancelled(
                    "personal-data export cancelled".into(),
                ));
            }
            let copied_size = tokio::fs::metadata(&destination)
                .await
                .map_err(Self::map_error)?
                .len();
            budget.media_files = budget.media_files.saturating_add(1);
            budget.media_bytes = budget.media_bytes.saturating_add(copied_size);
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

    async fn write_personal_export_chunk(
        file: &mut tokio::fs::File,
        bytes: &[u8],
        cancellation: &CancellationToken,
        budget: &mut PersonalDataExportBudget,
    ) -> BackendResult<()> {
        if cancellation.is_cancelled() {
            return Err(BackendError::Cancelled(
                "personal-data export cancelled".into(),
            ));
        }
        let next_size = budget.serialized_bytes.saturating_add(bytes.len() as u64);
        if next_size > MAX_PERSONAL_EXPORT_JSON_BYTES {
            return Err(BackendError::Other(format!(
                "Personal-data export exceeded the global {} MB document safety limit",
                MAX_PERSONAL_EXPORT_JSON_BYTES / 1024 / 1024
            )));
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                return Err(BackendError::Cancelled("personal-data export cancelled".into()))
            }
            result = file.write_all(bytes) => result.map_err(Self::map_error)?,
        }
        budget.serialized_bytes = next_size;
        Ok(())
    }

    async fn write_personal_data_export(
        &self,
        destination_root: PathBuf,
        cancellation: &CancellationToken,
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
            let mut budget = PersonalDataExportBudget::default();
            let mut media_hashes = HashSet::new();
            let mut warnings = Vec::new();
            let mut rooms = client.joined_rooms();
            if rooms.len() > MAX_PERSONAL_EXPORT_ROOMS {
                return Err(BackendError::Other(format!(
                    "Personal-data export exceeded the global {MAX_PERSONAL_EXPORT_ROOMS}-conversation safety limit"
                )));
            }
            rooms.sort_by(|left, right| {
                left.name()
                    .unwrap_or_default()
                    .to_lowercase()
                    .cmp(&right.name().unwrap_or_default().to_lowercase())
                    .then_with(|| left.room_id().cmp(right.room_id()))
            });
            let document_path = staging_root.join("mesh-personal-data.json");
            let mut file = open_private_file(&document_path, true)
                .await
                .map_err(Self::map_error)?;

            Self::write_personal_export_chunk(
                &mut file,
                b"{\n\"schemaVersion\":1,\n\"exportedAt\":",
                cancellation,
                &mut budget,
            )
            .await?;
            Self::write_personal_export_chunk(
                &mut file,
                &serde_json::to_vec(&exported_at.to_rfc3339()).map_err(Self::map_error)?,
                cancellation,
                &mut budget,
            )
            .await?;
            let account = PersonalDataExportAccount {
                user_id: own_user_id.to_string(),
                homeserver: client.homeserver().to_string(),
                device_id: client.device_id().map(ToString::to_string),
            };
            let scope = PersonalDataExportScope {
                messages: "Messages authored by this account that Mesh could read from joined conversations, including the latest visible edit and deletion state.",
                media: "Only already-downloaded local copies attached to those authored messages. Mesh did not download additional media.",
                excluded: "Messages authored by other people, encryption secrets, access tokens, device keys, and service-side operational records.",
            };
            for (prefix, value) in [
                (b",\n\"account\":".as_slice(), serde_json::to_vec(&account).map_err(Self::map_error)?),
                (b",\n\"scope\":".as_slice(), serde_json::to_vec(&scope).map_err(Self::map_error)?),
            ] {
                Self::write_personal_export_chunk(&mut file, prefix, cancellation, &mut budget)
                    .await?;
                Self::write_personal_export_chunk(&mut file, &value, cancellation, &mut budget)
                    .await?;
            }
            Self::write_personal_export_chunk(
                &mut file,
                b",\n\"rooms\":[",
                cancellation,
                &mut budget,
            )
            .await?;

            let mut room_count = 0_u32;
            let mut message_count = 0_u64;
            for room in rooms {
                let Some(projected) = Self::project_personal_export_room(
                    &room,
                    &own_user_id,
                    cancellation,
                    &mut budget,
                    &mut media_hashes,
                    &mut warnings,
                )
                .await?
                else {
                    continue;
                };
                let room_json = serde_json::to_vec(&projected).map_err(Self::map_error)?;
                if room_count > 0 {
                    Self::write_personal_export_chunk(
                        &mut file,
                        b",",
                        cancellation,
                        &mut budget,
                    )
                    .await?;
                }
                Self::write_personal_export_chunk(
                    &mut file,
                    &room_json,
                    cancellation,
                    &mut budget,
                )
                .await?;
                room_count = room_count.saturating_add(1);
                message_count = message_count.saturating_add(projected.messages.len() as u64);
            }

            let media_file_count = Self::copy_personal_export_media_bounded(
                &storage.store_root.join("media-cache"),
                &staging_root,
                &media_hashes,
                &mut warnings,
                cancellation,
                &mut budget,
            )
            .await?;
            Self::write_personal_export_chunk(
                &mut file,
                b"],\n\"warnings\":",
                cancellation,
                &mut budget,
            )
            .await?;
            Self::write_personal_export_chunk(
                &mut file,
                &serde_json::to_vec(&warnings).map_err(Self::map_error)?,
                cancellation,
                &mut budget,
            )
            .await?;
            Self::write_personal_export_chunk(
                &mut file,
                b"\n}\n",
                cancellation,
                &mut budget,
            )
            .await?;
            file.sync_all().await.map_err(Self::map_error)?;
            drop(file);
            if cancellation.is_cancelled() {
                return Err(BackendError::Cancelled(
                    "personal-data export cancelled".into(),
                ));
            }
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
