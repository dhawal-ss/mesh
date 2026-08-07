impl MatrixBackend {
    fn encrypted_file_sha256(encrypted_file: &EncryptedFile) -> Option<String> {
        match encrypted_file
            .hashes
            .get(&EncryptedFileHashAlgorithm::Sha256)?
        {
            EncryptedFileHash::Sha256(hash) => Some(hash.to_string()),
            _ => None,
        }
    }

    fn resolved_matrix_thumbnail_from_content(
        content: &serde_json::Value,
    ) -> Option<AttachmentThumbnailDto> {
        let info = content.get("info")?;
        // Plain `thumbnail_url` metadata is never accepted for encrypted-room
        // attachments. The encrypted descriptor is validated only to project
        // bounded presentation metadata; its key material is not retained or
        // exposed through renderer IPC.
        let encrypted_file: EncryptedFile =
            serde_json::from_value(info.get("thumbnail_file")?.clone()).ok()?;
        if !encrypted_file.url.as_str().starts_with("mxc://") {
            return None;
        }
        let sha256 = Self::encrypted_file_sha256(&encrypted_file)?;
        let thumbnail_info = info.get("thumbnail_info")?;
        let size = thumbnail_info.get("size")?.as_u64()?;
        let width = u32::try_from(thumbnail_info.get("w")?.as_u64()?).ok()?;
        let height = u32::try_from(thumbnail_info.get("h")?.as_u64()?).ok()?;
        let content_type = thumbnail_info.get("mimetype")?.as_str()?;
        let pixels = u64::from(width).checked_mul(u64::from(height))?;
        if size == 0
            || size > MAX_THUMBNAIL_BYTES as u64
            || width == 0
            || height == 0
            || width > MAX_THUMBNAIL_DIMENSION
            || height > MAX_THUMBNAIL_DIMENSION
            || pixels > u64::from(MAX_THUMBNAIL_DIMENSION).pow(2)
            || content_type != "image/png"
        {
            return None;
        }
        Some(AttachmentThumbnailDto {
            file_hash: format!("matrix-sha256:{sha256}"),
            size,
            width,
            height,
            content_type: content_type.to_owned(),
        })
    }

    fn resolved_matrix_attachment_from_content(
        content: &serde_json::Value,
    ) -> Option<ResolvedMatrixAttachment> {
        let msgtype = content.get("msgtype").and_then(serde_json::Value::as_str)?;
        if !matches!(msgtype, "m.file" | "m.image" | "m.audio" | "m.video") {
            return None;
        }
        let filename = content
            .get("filename")
            .and_then(serde_json::Value::as_str)
            .or_else(|| content.get("body").and_then(serde_json::Value::as_str))?
            .trim();
        if filename.is_empty() {
            return None;
        }
        let encrypted_file: EncryptedFile =
            serde_json::from_value(content.get("file")?.clone()).ok()?;
        if !encrypted_file.url.as_str().starts_with("mxc://") {
            return None;
        }
        let sha256 = Self::encrypted_file_sha256(&encrypted_file)?;
        let size = content
            .get("info")
            .and_then(|info| info.get("size"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default();
        let content_type = content
            .get("info")
            .and_then(|info| info.get("mimetype"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let thumbnail = Self::resolved_matrix_thumbnail_from_content(content);
        Some(ResolvedMatrixAttachment {
            metadata: AttachmentDto {
                file_hash: format!("matrix-sha256:{sha256}"),
                filename: filename.to_owned(),
                size,
                chunks: 1,
                source_peer_id: "matrix".into(),
                content_type,
                thumbnail,
            },
            encrypted_file,
        })
    }

    fn matrix_attachment_from_content(content: &serde_json::Value) -> Option<AttachmentDto> {
        Self::resolved_matrix_attachment_from_content(content).map(|attachment| attachment.metadata)
    }

    fn resolved_matrix_attachment_from_event(
        event: &serde_json::Value,
        attachment_index: u32,
    ) -> BackendResult<ResolvedMatrixAttachment> {
        if attachment_index != 0 {
            return Err(BackendError::NotFound(
                "attachment index is not present in this message".into(),
            ));
        }
        if event.get("type").and_then(serde_json::Value::as_str) != Some("m.room.message")
            || event
                .get("unsigned")
                .and_then(|unsigned| unsigned.get("redacted_because"))
                .is_some()
        {
            return Err(BackendError::NotFound(
                "attachment message is unavailable".into(),
            ));
        }
        let content = event
            .get("content")
            .ok_or_else(|| BackendError::NotFound("attachment message has no content".into()))?;
        Self::resolved_matrix_attachment_from_content(content).ok_or_else(|| {
            BackendError::NotFound(
                "message does not contain a supported encrypted attachment".into(),
            )
        })
    }

    #[cfg(test)]
    fn matrix_attachment_from_event(
        event: &serde_json::Value,
        attachment_index: u32,
    ) -> BackendResult<AttachmentDto> {
        Self::resolved_matrix_attachment_from_event(event, attachment_index)
            .map(|attachment| attachment.metadata)
    }

    async fn resolve_protected_attachment(
        client: &Client,
        room_id: &matrix_sdk::ruma::RoomId,
        event_id: &matrix_sdk::ruma::EventId,
        attachment_index: u32,
    ) -> BackendResult<ResolvedMatrixAttachment> {
        let room =
            Self::protected_joined_room(client, room_id, "downloading an attachment").await?;
        let event = room
            .load_or_fetch_event(event_id, None)
            .await
            .map_err(Self::map_error)?;
        let value: serde_json::Value =
            serde_json::from_str(event.raw().json().get()).map_err(Self::map_error)?;
        if value.get("event_id").and_then(serde_json::Value::as_str) != Some(event_id.as_str()) {
            return Err(BackendError::PermissionDenied(
                "attachment event did not match the requested event".into(),
            ));
        }
        Self::resolved_matrix_attachment_from_event(&value, attachment_index)
    }

    fn safe_media_filename(filename: &str) -> BackendResult<String> {
        let trimmed = filename.trim();
        if !trimmed.is_empty() && trimmed != filename {
            return Err(BackendError::InvalidConfiguration(
                "attachment filename is not safe on this platform".into(),
            ));
        }
        let safe = Path::new(trimmed)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("attachment")
            .to_owned();
        if safe.len() > 255
            || safe.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
            || safe.ends_with(['.', ' '])
            || safe.chars().any(char::is_control)
        {
            return Err(BackendError::InvalidConfiguration(
                "attachment filename is not safe on this platform".into(),
            ));
        }
        let device_basename = safe
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved_device = matches!(device_basename.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || device_basename.strip_prefix("COM").is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
            || device_basename.strip_prefix("LPT").is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
        if reserved_device {
            return Err(BackendError::InvalidConfiguration(
                "attachment filename uses a reserved device name".into(),
            ));
        }
        if classify_attachment(&safe, None, &[]).disposition == AttachmentDisposition::Active {
            return Err(BackendError::InvalidConfiguration(
                "active attachment filenames are not allowed".into(),
            ));
        }
        Ok(safe)
    }

    fn validate_transfer_id(transfer_id: &str) -> BackendResult<()> {
        if transfer_id.len() != 36 || uuid::Uuid::parse_str(transfer_id).is_err() {
            return Err(BackendError::InvalidConfiguration(
                "Matrix transfer id must be a UUID".into(),
            ));
        }
        Ok(())
    }

    fn validate_transaction_id(transaction_id: &str) -> BackendResult<OwnedTransactionId> {
        if transaction_id.is_empty()
            || transaction_id.len() > 255
            || !transaction_id
                .chars()
                .all(|character| !character.is_control() && !character.is_whitespace())
        {
            return Err(BackendError::InvalidConfiguration(
                "message delivery identifier is invalid".into(),
            ));
        }
        Ok(transaction_id.to_owned().into())
    }

    fn new_message_composer_draft(body: String) -> BackendResult<Option<ComposerDraft>> {
        if body.len() > MAX_COMPOSER_DRAFT_BYTES {
            return Err(BackendError::InvalidConfiguration(
                "message draft cannot exceed 16 KiB".into(),
            ));
        }
        if body.is_empty() {
            return Ok(None);
        }
        Ok(Some(ComposerDraft {
            plain_text: body,
            html_text: None,
            draft_type: ComposerDraftType::NewMessage,
            attachments: Vec::new(),
        }))
    }

    fn new_message_composer_draft_body(draft: ComposerDraft) -> BackendResult<Option<String>> {
        let ComposerDraft {
            plain_text,
            draft_type,
            ..
        } = draft;
        if !matches!(draft_type, ComposerDraftType::NewMessage) {
            return Ok(None);
        }
        if plain_text.len() > MAX_COMPOSER_DRAFT_BYTES {
            return Err(BackendError::InvalidConfiguration(
                "saved message draft exceeds 16 KiB".into(),
            ));
        }
        Ok((!plain_text.is_empty()).then_some(plain_text))
    }

    fn emit_transfer_progress(
        progress: &MatrixTransferProgressCallback,
        transfer_id: &str,
        direction: MatrixTransferDirection,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
        state: MatrixTransferState,
        result: Option<MatrixTransferResult>,
    ) {
        let terminal_retry = matches!(
            state,
            MatrixTransferState::Cancelled | MatrixTransferState::Failed
        );
        let error = match state {
            MatrixTransferState::Cancelled => {
                Some("Transfer cancelled. Restarting begins again from zero.".into())
            }
            MatrixTransferState::Failed => {
                Some("Transfer failed. Restarting begins again from zero.".into())
            }
            _ => None,
        };
        progress(MatrixTransferProgress {
            transfer_id: transfer_id.to_owned(),
            direction,
            transferred_bytes,
            total_bytes,
            state,
            retryable: terminal_retry,
            retry_mode: terminal_retry.then_some(MatrixTransferRetryMode::RestartFromZero),
            result,
            error,
        });
    }

    fn validate_media_payload(
        data: &[u8],
        content_type: Option<&str>,
        filename: &str,
    ) -> BackendResult<()> {
        let classification = classify_attachment(filename, content_type, data);
        if classification.disposition == AttachmentDisposition::Active {
            return Err(BackendError::InvalidConfiguration(format!(
                "refusing to send active Matrix attachment content: {filename}"
            )));
        }
        Ok(())
    }

    fn attachment_size_limit_error() -> BackendError {
        BackendError::InvalidConfiguration("attachment exceeds the 100 MB limit".into())
    }

    fn validate_attachment_size(size: u64) -> BackendResult<()> {
        if size > MAX_ATTACHMENT_BYTES {
            return Err(Self::attachment_size_limit_error());
        }
        Ok(())
    }

    fn thumbnail_image_format(content_type: &str) -> Option<image::ImageFormat> {
        match content_type.trim().to_ascii_lowercase().as_str() {
            "image/jpeg" => Some(image::ImageFormat::Jpeg),
            "image/png" => Some(image::ImageFormat::Png),
            "image/webp" => Some(image::ImageFormat::WebP),
            _ => None,
        }
    }

    fn decode_image_with_safe_limits(
        data: &[u8],
        format: image::ImageFormat,
    ) -> BackendResult<(image::DynamicImage, (u32, u32))> {
        let dimensions = image::ImageReader::with_format(Cursor::new(data), format)
            .into_dimensions()
            .map_err(|_| {
                BackendError::InvalidConfiguration(
                    "image attachment does not match its declared content type".into(),
                )
            })?;
        let pixels = u64::from(dimensions.0)
            .checked_mul(u64::from(dimensions.1))
            .ok_or_else(|| {
                BackendError::InvalidConfiguration(
                    "image attachment dimensions overflow the display limit".into(),
                )
            })?;
        if dimensions.0 == 0
            || dimensions.1 == 0
            || dimensions.0 > MAX_THUMBNAIL_SOURCE_DIMENSION
            || dimensions.1 > MAX_THUMBNAIL_SOURCE_DIMENSION
            || pixels > MAX_THUMBNAIL_SOURCE_PIXELS
        {
            return Err(BackendError::InvalidConfiguration(format!(
                "image attachment exceeds the {MAX_THUMBNAIL_SOURCE_PIXELS}-pixel display limit"
            )));
        }

        let mut decode_limits = image::Limits::default();
        decode_limits.max_image_width = Some(MAX_THUMBNAIL_SOURCE_DIMENSION);
        decode_limits.max_image_height = Some(MAX_THUMBNAIL_SOURCE_DIMENSION);
        decode_limits.max_alloc = Some(MAX_THUMBNAIL_DECODE_BYTES);
        let mut reader = image::ImageReader::with_format(Cursor::new(data), format);
        reader.limits(decode_limits);
        let decoded = reader.decode().map_err(|_| {
            BackendError::InvalidConfiguration(
                "image attachment could not be decoded within display limits".into(),
            )
        })?;
        if (decoded.width(), decoded.height()) != dimensions {
            return Err(BackendError::InvalidConfiguration(
                "decoded image dimensions do not match its header".into(),
            ));
        }
        Ok((decoded, dimensions))
    }

    fn validate_lightbox_image(data: &[u8], content_type: &str) -> BackendResult<()> {
        let format = Self::thumbnail_image_format(content_type).ok_or_else(|| {
            BackendError::InvalidConfiguration(
                "attachment is not a supported protected image".into(),
            )
        })?;
        Self::decode_image_with_safe_limits(data, format).map(|_| ())
    }

    fn generate_sanitized_thumbnail(
        data: &[u8],
        content_type: &str,
    ) -> BackendResult<Option<GeneratedThumbnail>> {
        let Some(format) = Self::thumbnail_image_format(content_type) else {
            return Ok(None);
        };
        let (decoded, _) = Self::decode_image_with_safe_limits(data, format)?;
        let thumbnail = decoded.thumbnail(MAX_THUMBNAIL_DIMENSION, MAX_THUMBNAIL_DIMENSION);
        let width = thumbnail.width();
        let height = thumbnail.height();
        let mut output = Cursor::new(Vec::new());
        thumbnail
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|_| BackendError::Other("failed to encode sanitized thumbnail".into()))?;
        let bytes = output.into_inner();
        if bytes.is_empty()
            || bytes.len() > MAX_THUMBNAIL_BYTES
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        {
            return Err(BackendError::Other(
                "sanitized thumbnail exceeded its encoded-size limit".into(),
            ));
        }
        let verified_dimensions =
            image::ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Png)
                .into_dimensions()
                .map_err(|_| BackendError::Other("sanitized thumbnail validation failed".into()))?;
        if verified_dimensions != (width, height)
            || width == 0
            || height == 0
            || width > MAX_THUMBNAIL_DIMENSION
            || height > MAX_THUMBNAIL_DIMENSION
        {
            return Err(BackendError::Other(
                "sanitized thumbnail dimensions failed validation".into(),
            ));
        }
        Ok(Some(GeneratedThumbnail {
            bytes,
            width,
            height,
        }))
    }

    async fn upload_encrypted_media_bytes(
        client: &Client,
        data: &[u8],
        cancellation: &CancellationToken,
        progress: &MatrixTransferProgressCallback,
        transfer_id: &str,
        transferred_bytes: &Arc<AtomicU64>,
        progress_range: (u64, u64),
    ) -> BackendResult<EncryptedFile> {
        let (offset, total_bytes) = progress_range;
        let mut reader = Cursor::new(data);
        let upload = client.upload_encrypted_file(&mut reader);
        let mut upload_progress = upload.subscribe_to_send_progress();
        let progress_callback = progress.clone();
        let progress_transfer_id = transfer_id.to_owned();
        let progress_bytes = transferred_bytes.clone();
        let progress_task = tokio::spawn(async move {
            while let Some(update) = upload_progress.next().await {
                let current = offset.saturating_add(update.current as u64);
                progress_bytes.store(current, Ordering::Relaxed);
                Self::emit_transfer_progress(
                    &progress_callback,
                    &progress_transfer_id,
                    MatrixTransferDirection::Upload,
                    current,
                    Some(total_bytes),
                    MatrixTransferState::Uploading,
                    None,
                );
            }
        });
        let result = tokio::select! {
            result = upload => result.map_err(Self::map_error),
            _ = cancellation.cancelled() => {
                Err(BackendError::Other("Matrix attachment upload cancelled".into()))
            }
        };
        progress_task.abort();
        if result.is_ok() {
            transferred_bytes.store(offset.saturating_add(data.len() as u64), Ordering::Relaxed);
        }
        result
    }

    /// Buffers a media transfer while the cap is checked against bytes actually
    /// received. `info.size` is sender-controlled, so the only honest bound is
    /// the running count of the live stream: the loop stops pulling the moment
    /// it is crossed, before the payload is materialised. `size_hint` (e.g. a
    /// transport `Content-Length`) only sizes the initial allocation and is
    /// clamped to `limit` and, since the hint itself is an unverified remote
    /// claim, to `MEDIA_DOWNLOAD_INITIAL_CAPACITY_BYTES`; the cap is still
    /// enforced against real bytes as they arrive regardless of what the hint
    /// claims.
    async fn collect_bounded_media(
        source: &mut dyn MediaChunkSource,
        limit: u64,
        size_hint: Option<u64>,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> BackendResult<Vec<u8>> {
        let mut buffer = match size_hint {
            Some(hint) => Vec::with_capacity(
                hint.min(limit).min(MEDIA_DOWNLOAD_INITIAL_CAPACITY_BYTES) as usize,
            ),
            None => Vec::new(),
        };
        let mut received = 0_u64;
        let mut reported = 0_u64;
        while let Some(chunk) = source.next_chunk().await? {
            received = received.saturating_add(chunk.len() as u64);
            if received > limit {
                return Err(Self::attachment_size_limit_error());
            }
            buffer.extend_from_slice(&chunk);
            if received.saturating_sub(reported) >= MEDIA_DOWNLOAD_PROGRESS_INTERVAL_BYTES {
                reported = received;
                on_progress(received);
            }
        }
        on_progress(received);
        Ok(buffer)
    }

    /// matrix-sdk 0.18's `Media::get_media_content` reads the whole response
    /// body into memory before any size check can run, so the download is
    /// issued directly against the same endpoint ruma would have used.
    #[allow(deprecated)]
    fn media_download_endpoint(
        homeserver: &str,
        access_token: Option<&str>,
        supported_versions: &SupportedVersions,
        url: &MxcUri,
    ) -> BackendResult<(String, reqwest::header::HeaderMap)> {
        use matrix_sdk::ruma::api::client::{authenticated_media, media};

        let access_token = access_token.map_or(SendAccessToken::None, SendAccessToken::IfRequired);
        let request = if authenticated_media::get_content::v1::Request::PATH_BUILDER
            .is_supported(supported_versions)
        {
            authenticated_media::get_content::v1::Request::from_uri(url)
                .map_err(Self::map_error)?
                .try_into_http_request::<Vec<u8>>(
                    homeserver,
                    access_token,
                    Cow::Borrowed(supported_versions),
                )
        } else {
            media::get_content::v3::Request::from_url(url)
                .map_err(Self::map_error)?
                .try_into_http_request::<Vec<u8>>(
                    homeserver,
                    access_token,
                    Cow::Borrowed(supported_versions),
                )
        }
        .map_err(Self::map_error)?;
        let (parts, _) = request.into_parts();
        Ok((parts.uri.to_string(), parts.headers))
    }

    fn media_http_client() -> BackendResult<reqwest::Client> {
        reqwest::Client::builder()
            // Matrix media requests can carry an account access token. Never
            // let an untrusted Location header choose its next destination or
            // inherit those credentials. A caller can retry through fresh
            // homeserver discovery instead of following redirects here.
            .redirect(reqwest::redirect::Policy::none())
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .connect_timeout(MEDIA_DOWNLOAD_CONNECT_TIMEOUT)
            .read_timeout(MEDIA_DOWNLOAD_READ_TIMEOUT)
            .build()
            .map_err(|error| BackendError::Network(error.to_string()))
    }

    async fn download_bounded_encrypted_media(
        client: &Client,
        encrypted_file: &EncryptedFile,
        limit: u64,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> BackendResult<Vec<u8>> {
        let supported_versions = client.supported_versions().await.map_err(Self::map_error)?;
        let (url, headers) = Self::media_download_endpoint(
            client.homeserver().as_str(),
            client.access_token().as_deref(),
            &supported_versions,
            &encrypted_file.url,
        )?;
        let http = Self::media_http_client()?;
        let response = http
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|error| BackendError::Network(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => BackendError::PermissionDenied(
                    "the homeserver refused this attachment download".into(),
                ),
                429 => BackendError::RateLimited(
                    "the homeserver rate limited this attachment download".into(),
                ),
                _ => BackendError::Network(format!("attachment download returned HTTP {status}")),
            });
        }
        let content_length = response.content_length();
        if content_length.is_some_and(|length| length > limit) {
            return Err(BackendError::InvalidConfiguration(
                "encrypted media exceeds its transfer limit".into(),
            ));
        }
        let ciphertext = Self::collect_bounded_media(
            &mut HttpMediaChunkSource(response),
            limit,
            content_length,
            on_progress,
        )
        .await?;

        // Matrix attachment encryption is AES-CTR, a stream cipher, so the
        // decrypted plaintext is exactly as long as the ciphertext feeding it
        // (see matrix-sdk 0.18.0's media.rs:473 for the same reasoning). Size
        // the output buffer from that known length instead of growing it from
        // empty, so the final reallocation doesn't briefly hold both the old
        // and new backing storage on top of the settled ciphertext buffer.
        let ciphertext_len = ciphertext.len();
        let mut ciphertext = Cursor::new(ciphertext);
        let mut decryptor =
            AttachmentDecryptor::new(&mut ciphertext, encrypted_file.clone().into())
                .map_err(Self::map_error)?;
        let mut data = Vec::with_capacity(ciphertext_len);
        decryptor
            .read_to_end(&mut data)
            .map_err(|error| BackendError::Crypto(error.to_string()))?;
        Ok(data)
    }

    async fn enforce_media_cache_quota(cache_root: &Path, protected: &Path) -> BackendResult<()> {
        Self::enforce_media_cache_quota_with_limit(cache_root, protected, MAX_MEDIA_CACHE_BYTES)
            .await
    }

    async fn enforce_media_cache_quota_with_limit(
        cache_root: &Path,
        protected: &Path,
        max_bytes: u64,
    ) -> BackendResult<()> {
        let mut entries = Vec::new();
        let mut total = 0u64;
        let mut read_dir = tokio::fs::read_dir(cache_root)
            .await
            .map_err(Self::map_error)?;
        while let Some(entry) = read_dir.next_entry().await.map_err(Self::map_error)? {
            let file_type = entry.file_type().await.map_err(Self::map_error)?;
            if !file_type.is_file() {
                continue;
            }
            let metadata = entry.metadata().await.map_err(Self::map_error)?;
            total = total.saturating_add(metadata.len());
            entries.push((
                entry.path(),
                metadata.len(),
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ));
        }
        if total <= max_bytes {
            return Ok(());
        }

        entries.sort_by_key(|(_, _, modified)| *modified);
        for (path, size, _) in entries {
            if total <= max_bytes {
                break;
            }
            if path.as_path() == protected {
                continue;
            }
            tokio::fs::remove_file(&path)
                .await
                .map_err(Self::map_error)?;
            total = total.saturating_sub(size);
        }
        Ok(())
    }
}
