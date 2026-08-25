use super::*;

/*
    Profile pictures.

    Mesh could read a Matrix avatar URL from the moment it could read a profile,
    and it could not set one: `update_profile_display_name` was the only profile
    writer in the codebase, so the field in settings could only be non-null if
    the person had set it from a different Matrix client. Meanwhile the create
    flow told owners "a custom image replaces it when you add one", which was not
    true because there was no add path.

    Both halves live here. The upload reuses the same sanitising pipeline as
    server emoji, so a profile picture is decoded under the same bounded limits
    and re-encoded to PNG rather than being passed through: an avatar is fetched
    by everyone who can see you, which makes an unsanitised one a broadcast
    primitive.
*/
pub(super) const MAX_PROFILE_AVATAR_UPLOAD_BYTES: usize = 1024 * 1024;
// Larger than an emoji because this is rendered at up to 96px on the settings
// surface and on high-DPI displays, but still small enough that a timeline
// fetching many of them stays cheap.
pub(super) const MAX_PROFILE_AVATAR_DIMENSION: u32 = 256;
// What Mesh will pull down for someone else's avatar. Deliberately larger than
// the 1 MB Mesh accepts on upload: an avatar set from another client was never
// bounded by Mesh's own limit, and refusing to display one for being 1.2 MB
// would read as the picture being broken. It is still a hard ceiling enforced
// against real arriving bytes, and whatever arrives is re-encoded down to
// MAX_PROFILE_AVATAR_DIMENSION before the renderer ever sees it.
pub(super) const MAX_AVATAR_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024;

impl MatrixBackend {
    /// Decodes, bounds and re-encodes an avatar to PNG. Same shape as
    /// `sanitize_custom_emoji`, at avatar dimensions.
    fn sanitize_profile_avatar(
        bytes: &[u8],
        content_type: &str,
        filename: &str,
    ) -> BackendResult<GeneratedThumbnail> {
        if bytes.is_empty() || bytes.len() > MAX_PROFILE_AVATAR_UPLOAD_BYTES {
            return Err(BackendError::InvalidConfiguration(
                "profile pictures must be 1 MB or smaller".into(),
            ));
        }
        let safe_filename = Self::safe_media_filename(filename)?;
        Self::validate_media_payload(bytes, Some(content_type), &safe_filename)?;
        let format = Self::thumbnail_image_format(content_type).ok_or_else(|| {
            BackendError::InvalidConfiguration("profile pictures must be PNG, JPEG, or WebP".into())
        })?;
        let (decoded, _) = Self::decode_image_with_safe_limits(bytes, format)?;
        let sanitized =
            decoded.thumbnail(MAX_PROFILE_AVATAR_DIMENSION, MAX_PROFILE_AVATAR_DIMENSION);
        let width = sanitized.width();
        let height = sanitized.height();
        let mut output = Cursor::new(Vec::new());
        sanitized
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|_| BackendError::Other("failed to sanitize the profile picture".into()))?;
        let bytes = output.into_inner();
        if bytes.is_empty()
            || bytes.len() > MAX_PROFILE_AVATAR_UPLOAD_BYTES
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        {
            return Err(BackendError::InvalidConfiguration(
                "the sanitized profile picture failed PNG validation".into(),
            ));
        }
        Ok(GeneratedThumbnail {
            bytes,
            width,
            height,
        })
    }

    pub(crate) async fn set_profile_avatar_image(
        &self,
        filename: String,
        content_type: String,
        bytes: Vec<u8>,
    ) -> BackendResult<MatrixProfile> {
        let content_type = content_type.trim().to_owned();
        let filename = filename.trim().to_owned();
        let sanitized = Self::decode_off_runtime(move || {
            Self::sanitize_profile_avatar(&bytes, &content_type, &filename)
        })
        .await?;
        let client = self.client().await?;
        let upload = client
            .media()
            .upload(&mime::IMAGE_PNG, sanitized.bytes, None)
            .await
            .map_err(Self::map_error)?;
        client
            .account()
            .set_avatar_url(Some(&upload.content_uri))
            .await
            .map_err(Self::map_error)?;
        self.get_profile().await
    }

    pub(crate) async fn clear_profile_avatar_image(&self) -> BackendResult<MatrixProfile> {
        let client = self.client().await?;
        client
            .account()
            .set_avatar_url(None)
            .await
            .map_err(Self::map_error)?;
        self.get_profile().await
    }

    /// Whether this account may write `m.room.avatar` in this room.
    ///
    /// A profile picture needs no permission check because it is the account's
    /// own data. A room or space icon is a state event, so it is gated by power
    /// levels, and Rust has to be the one that decides: a renderer-side role
    /// check is a hint for the UI, never the authority. The server would refuse
    /// an unauthorised write anyway, but only after the upload, and with
    /// `M_FORBIDDEN` rather than something a person can read.
    ///
    /// Same shape as `user_can_update_custom_emoji`: the room's own threshold
    /// for this event type when it sets one, `state_default` otherwise.
    pub(super) fn user_can_update_room_avatar(
        power_levels: &RoomPowerLevelsEventContent,
        user_id: &UserId,
    ) -> bool {
        let user_level = power_levels
            .users
            .get(user_id)
            .copied()
            .unwrap_or(power_levels.users_default);
        let required_level = power_levels
            .events
            .get(&TimelineEventType::RoomAvatar)
            .copied()
            .unwrap_or(power_levels.state_default);
        user_level >= required_level
    }

    async fn require_room_avatar_permission(client: &Client, room: &Room) -> BackendResult<()> {
        let user_id = client.user_id().ok_or(BackendError::NotAuthenticated)?;
        let power_levels = client
            .send(get_state_event_for_key::v3::Request::new(
                room.room_id().to_owned(),
                StateEventType::RoomPowerLevels,
                String::new(),
            ))
            .await
            .map_err(Self::map_error)?
            .into_content()
            .deserialize_as_unchecked::<RoomPowerLevelsEventContent>()
            .map_err(Self::map_display_error)?;
        if !Self::user_can_update_room_avatar(&power_levels, user_id) {
            return Err(BackendError::PermissionDenied(
                "your current role cannot change this image".into(),
            ));
        }
        Ok(())
    }

    /*
        Sets a room's or space's icon.

        Room-generic on purpose, though only communities offer it in the UI
        today: a Matrix space *is* a room, `m.room.avatar` is ordinary room
        state, and `Room::upload_avatar` does not care which it is. Writing this
        against spaces only would mean a second near-identical writer when a
        per-room surface exists to hang the control on, and there is none today
        (post-creation room editing is a single rename field).

        Reuses `sanitize_profile_avatar`, so an icon is decoded, bounded and
        re-encoded to PNG under exactly the same limits as a profile picture.
        The bounds suit it: an icon renders at 48px in the rail and the same
        256px ceiling applies.
    */
    pub(crate) async fn set_room_avatar_image(
        &self,
        room_id: String,
        filename: String,
        content_type: String,
        bytes: Vec<u8>,
    ) -> BackendResult<String> {
        let content_type = content_type.trim().to_owned();
        let filename = filename.trim().to_owned();
        let sanitized = Self::decode_off_runtime(move || {
            Self::sanitize_profile_avatar(&bytes, &content_type, &filename)
        })
        .await?;
        let client = self.client().await?;
        let room_id = RoomId::parse(&room_id).map_err(Self::map_display_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "changing this image").await?;
        Self::require_room_avatar_permission(&client, &room).await?;
        /*
            Uploads and writes the state event in one call. Deliberately not
            `set_avatar_url` against a separately uploaded URI: that ordering
            can leave an uploaded but unreferenced blob behind if the state
            write fails, and the SDK already sequences it correctly here.
        */
        room.upload_avatar(&mime::IMAGE_PNG, sanitized.bytes, None)
            .await
            .map_err(Self::map_error)?;
        /*
            Read the URI back off room state rather than returning the upload
            response's, so the caller displays what the room actually carries.
            The state event is what every other client reads, and the local
            echo of it is what Mesh's own projection will report next.
        */
        room.avatar_url().map(|url| url.to_string()).ok_or_else(|| {
            BackendError::Other("the image was uploaded but the room did not record it".into())
        })
    }

    pub(crate) async fn clear_room_avatar_image(&self, room_id: String) -> BackendResult<()> {
        let client = self.client().await?;
        let room_id = RoomId::parse(&room_id).map_err(Self::map_display_error)?;
        let room = Self::protected_joined_room(&client, &room_id, "removing this image").await?;
        Self::require_room_avatar_permission(&client, &room).await?;
        room.remove_avatar().await.map_err(Self::map_error)?;
        Ok(())
    }

    /// Re-encodes a downloaded avatar to PNG within the avatar dimension.
    ///
    /// The format is sniffed from the bytes rather than read from the response
    /// `Content-Type`: the header is a remote claim about remote content, and
    /// the decoder is the thing that has to be right about it. Anything outside
    /// the PNG/JPEG/WebP allowlist `thumbnail_image_format` already defines is
    /// refused rather than guessed at.
    pub(super) fn sanitize_downloaded_avatar(bytes: &[u8]) -> BackendResult<Vec<u8>> {
        let format = image::guess_format(bytes)
            .ok()
            .filter(|format| {
                matches!(
                    format,
                    image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP
                )
            })
            .ok_or_else(|| {
                BackendError::InvalidConfiguration(
                    "that profile picture is not a supported image".into(),
                )
            })?;
        let (decoded, _) = Self::decode_image_with_safe_limits(bytes, format)?;
        let sanitized =
            decoded.thumbnail(MAX_PROFILE_AVATAR_DIMENSION, MAX_PROFILE_AVATAR_DIMENSION);
        let mut output = Cursor::new(Vec::new());
        sanitized
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|_| BackendError::Other("failed to sanitize the profile picture".into()))?;
        let bytes = output.into_inner();
        if bytes.is_empty() || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(BackendError::InvalidConfiguration(
                "the sanitized profile picture failed PNG validation".into(),
            ));
        }
        Ok(bytes)
    }

    /*
        The renderer cannot fetch an mxc URI itself: the content security policy
        allows no outbound connection, and the media endpoint needs the access
        token. So the bytes come back through IPC, exactly as server emoji and
        attachment previews already do.

        This does not route through `download_custom_emoji`, though the
        transport is identical, because that path requires the payload to
        already be PNG and bounds it at the 512 KB emoji limit. Those hold for
        an emoji Mesh itself sanitised before upload; they do not hold for an
        avatar, which is whatever another person's client produced. Every
        mainstream Matrix client uploads a JPEG, so the emoji path rejected the
        common case outright with "server emoji failed PNG validation", and its
        512 KB ceiling also sat below the 1 MB one `set_profile_avatar_image`
        accepts on the way up, making a large-but-legal Mesh upload
        undownloadable by its own client. Sanitising here instead means the
        renderer only ever receives bounded PNG, whatever the sender used.
    */
    pub(crate) async fn load_profile_avatar_image(
        &self,
        avatar_url: String,
    ) -> BackendResult<Vec<u8>> {
        let client = self.client().await?;
        // Wrapping as an MxcUri here is infallible (this ruma version defers
        // scheme/server validation past construction); the real guard that
        // confines the fetch to the account's own media endpoint, so a
        // hostile avatar_url arriving in a room event cannot turn this into a
        // request to anywhere else, is the Request::from_uri/from_url call
        // inside media_download_endpoint.
        let url = <&MxcUri>::from(avatar_url.as_str());
        let supported_versions = client.supported_versions().await.map_err(Self::map_error)?;
        let (endpoint, headers) = Self::media_download_endpoint(
            client.homeserver().as_str(),
            client.access_token().as_deref(),
            &supported_versions,
            url,
        )?;
        let response = Self::media_http_client()?
            .get(endpoint)
            .headers(headers)
            .send()
            .await
            .map_err(|error| BackendError::Network(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => {
                    BackendError::PermissionDenied("the server refused this profile picture".into())
                }
                429 => {
                    BackendError::RateLimited("the server rate limited this profile picture".into())
                }
                _ => BackendError::Network(format!(
                    "profile picture download returned HTTP {status}"
                )),
            });
        }
        let content_length = response.content_length();
        let bytes = Self::collect_bounded_media(
            &mut HttpMediaChunkSource(response),
            MAX_AVATAR_DOWNLOAD_BYTES,
            content_length,
            &mut |_| {},
        )
        .await?;
        Self::decode_off_runtime(move || Self::sanitize_downloaded_avatar(&bytes)).await
    }
}
