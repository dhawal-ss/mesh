const CUSTOM_EMOJI_PACK_STATE_KEY: &str = "org.mesh.custom_emoji";
const CUSTOM_EMOJI_PACK_NAME: &str = "Mesh server emoji";
const MAX_CUSTOM_EMOJI_COUNT: usize = 100;
const MAX_CUSTOM_EMOJI_UPLOAD_BYTES: usize = 512 * 1024;
const MAX_CUSTOM_EMOJI_DIMENSION: u32 = 128;

impl MatrixBackend {
    fn normalize_custom_emoji_shortcode(shortcode: &str) -> BackendResult<String> {
        let shortcode = shortcode
            .trim()
            .trim_matches(':')
            .to_ascii_lowercase();
        if !(2..=32).contains(&shortcode.len())
            || !shortcode
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err(BackendError::InvalidConfiguration(
                "emoji names must be 2–32 letters, numbers, or underscores".into(),
            ));
        }
        Ok(shortcode)
    }

    fn custom_emoji_info(
        shortcode: &str,
        image: &PackImage,
    ) -> BackendResult<CustomEmoji> {
        if !image.usage.is_empty() && !image.usage.contains(&PackUsage::Emoticon) {
            return Err(BackendError::InvalidConfiguration(
                "the image-pack entry is not an emoji".into(),
            ));
        }
        let width = image
            .info
            .as_ref()
            .and_then(|info| info.width)
            .and_then(|value| u32::try_from(u64::from(value)).ok())
            .unwrap_or(0);
        let height = image
            .info
            .as_ref()
            .and_then(|info| info.height)
            .and_then(|value| u32::try_from(u64::from(value)).ok())
            .unwrap_or(0);
        let size_bytes = image
            .info
            .as_ref()
            .and_then(|info| info.size)
            .and_then(|value| u32::try_from(u64::from(value)).ok())
            .unwrap_or(0);
        let content_type = image
            .info
            .as_ref()
            .and_then(|info| info.mimetype.clone())
            .unwrap_or_else(|| "image/png".into());
        if content_type != "image/png"
            || width == 0
            || height == 0
            || width > MAX_CUSTOM_EMOJI_DIMENSION
            || height > MAX_CUSTOM_EMOJI_DIMENSION
            || size_bytes == 0
            || size_bytes > MAX_CUSTOM_EMOJI_UPLOAD_BYTES as u32
        {
            return Err(BackendError::InvalidConfiguration(
                "server emoji metadata failed local validation".into(),
            ));
        }
        Ok(CustomEmoji {
            shortcode: shortcode.to_owned(),
            body: image
                .body
                .clone()
                .unwrap_or_else(|| shortcode.to_owned()),
            mxc_uri: image.url.to_string(),
            content_type,
            width,
            height,
            size_bytes,
        })
    }

    async fn custom_emoji_pack(room: &Room) -> BackendResult<RoomImagePackEventContent> {
        let Some(raw) = room
            .get_state_event_static_for_key::<RoomImagePackEventContent, _>(
                CUSTOM_EMOJI_PACK_STATE_KEY,
            )
            .await
            .map_err(Self::map_error)?
        else {
            return Ok(RoomImagePackEventContent::new(BTreeMap::new()));
        };
        let event = raw
            .deserialize()
            .map_err(|error| BackendError::Serialization(error.to_string()))?;
        event
            .as_sync()
            .and_then(|event| event.as_original())
            .map(|event| event.content.clone())
            .ok_or_else(|| {
                BackendError::InvalidConfiguration("server emoji settings were redacted".into())
            })
    }

    fn sanitize_custom_emoji(
        bytes: &[u8],
        content_type: &str,
        filename: &str,
    ) -> BackendResult<GeneratedThumbnail> {
        if bytes.is_empty() || bytes.len() > MAX_CUSTOM_EMOJI_UPLOAD_BYTES {
            return Err(BackendError::InvalidConfiguration(
                "emoji images must be 512 KB or smaller".into(),
            ));
        }
        let safe_filename = Self::safe_media_filename(filename)?;
        Self::validate_media_payload(bytes, Some(content_type), &safe_filename)?;
        let format = Self::thumbnail_image_format(content_type).ok_or_else(|| {
            BackendError::InvalidConfiguration(
                "emoji images must be PNG, JPEG, or WebP".into(),
            )
        })?;
        let (decoded, _) = Self::decode_image_with_safe_limits(bytes, format)?;
        let sanitized =
            decoded.thumbnail(MAX_CUSTOM_EMOJI_DIMENSION, MAX_CUSTOM_EMOJI_DIMENSION);
        let width = sanitized.width();
        let height = sanitized.height();
        let mut output = Cursor::new(Vec::new());
        sanitized
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|_| BackendError::Other("failed to sanitize server emoji".into()))?;
        let bytes = output.into_inner();
        if bytes.is_empty()
            || bytes.len() > MAX_CUSTOM_EMOJI_UPLOAD_BYTES
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        {
            return Err(BackendError::InvalidConfiguration(
                "sanitized emoji failed PNG validation".into(),
            ));
        }
        Ok(GeneratedThumbnail {
            bytes,
            width,
            height,
        })
    }

    async fn download_custom_emoji(
        client: &Client,
        url: &MxcUri,
    ) -> BackendResult<Vec<u8>> {
        let supported_versions = client.supported_versions().await.map_err(Self::map_error)?;
        let (endpoint, headers) = Self::media_download_endpoint(
            client.homeserver().as_str(),
            client.access_token().as_deref(),
            &supported_versions,
            url,
        )?;
        let response = reqwest::Client::builder()
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .connect_timeout(MEDIA_DOWNLOAD_CONNECT_TIMEOUT)
            .read_timeout(MEDIA_DOWNLOAD_READ_TIMEOUT)
            .build()
            .map_err(|error| BackendError::Network(error.to_string()))?
            .get(endpoint)
            .headers(headers)
            .send()
            .await
            .map_err(|error| BackendError::Network(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => BackendError::PermissionDenied(
                    "the server refused this emoji download".into(),
                ),
                429 => BackendError::RateLimited(
                    "the server rate limited this emoji download".into(),
                ),
                _ => BackendError::Network(format!(
                    "emoji download returned HTTP {status}"
                )),
            });
        }
        let content_length = response.content_length();
        if content_length.is_some_and(|length| length > MAX_CUSTOM_EMOJI_UPLOAD_BYTES as u64) {
            return Err(BackendError::InvalidConfiguration(
                "server emoji exceeds the 512 KB limit".into(),
            ));
        }
        let bytes = Self::collect_bounded_media(
            &mut HttpMediaChunkSource(response),
            MAX_CUSTOM_EMOJI_UPLOAD_BYTES as u64,
            content_length,
            &mut |_| {},
        )
        .await
        .map_err(|error| match error {
            BackendError::InvalidConfiguration(_) => BackendError::InvalidConfiguration(
                "server emoji exceeds the 512 KB limit".into(),
            ),
            other => other,
        })?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(BackendError::InvalidConfiguration(
                "server emoji failed PNG validation".into(),
            ));
        }
        Self::validate_lightbox_image(&bytes, "image/png")?;
        Ok(bytes)
    }
}
