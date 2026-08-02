const COMMUNITY_ADMISSION_ORIGIN_ENV: &str = "MESH_COMMUNITY_ADMISSION_ORIGIN";
const ADMISSION_RESPONSE_MAX_BYTES: usize = 64 * 1024;
const ADMISSION_DNS_TIMEOUT: Duration = Duration::from_secs(3);
const ADMISSION_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const ADMISSION_READ_TIMEOUT: Duration = Duration::from_secs(10);
const ADMISSION_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const ADMISSION_MAX_RESOLVED_ADDRESSES: usize = 16;

#[derive(Debug, Deserialize)]
struct AdmissionCreateResponse {
    invite_url: String,
}

#[derive(Debug, Deserialize)]
struct AdmissionServiceResponse {
    version: u8,
    #[serde(default)]
    registration_token: Option<String>,
    room_id: String,
    service: String,
    #[serde(default)]
    via: Vec<String>,
    #[serde(default)]
    expires_at: Option<u64>,
    #[serde(default)]
    community_name: Option<String>,
    #[serde(default)]
    inviter_display_name: Option<String>,
    #[serde(default)]
    inviter_user_id: Option<String>,
    #[serde(default)]
    join_rule: Option<String>,
    #[serde(default)]
    community_service_display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AdmissionErrorResponse {
    #[serde(default)]
    code: String,
}

#[derive(Clone, PartialEq, Eq)]
struct AdmissionInvitationTarget {
    code: String,
    api_origin: url::Url,
    via: Vec<String>,
    via_truncated: bool,
}

impl std::fmt::Debug for AdmissionInvitationTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AdmissionInvitationTarget")
            .field("code", &"[REDACTED]")
            .field("api_origin", &self.api_origin)
            .field("via", &self.via)
            .field("via_truncated", &self.via_truncated)
            .finish()
    }
}

impl Drop for AdmissionInvitationTarget {
    fn drop(&mut self) {
        self.code.zeroize();
    }
}

impl MatrixBackend {
    fn community_admission_origin() -> BackendResult<url::Url> {
        let configured = std::env::var(COMMUNITY_ADMISSION_ORIGIN_ENV).map_err(|_| {
            BackendError::InvalidConfiguration(
                "no community admission service is configured".into(),
            )
        })?;
        Self::normalize_admission_origin(&configured)
    }

    fn normalize_admission_origin(value: &str) -> BackendResult<url::Url> {
        let mut origin = url::Url::parse(value.trim()).map_err(|_| {
            BackendError::InvalidConfiguration("the invitation service address is invalid".into())
        })?;
        let host = origin.host_str().map(str::to_owned).ok_or_else(|| {
            BackendError::InvalidConfiguration("the invitation service address has no host".into())
        })?;
        let loopback = host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback());
        let development_loopback = loopback && Self::development_loopback_invitations_enabled();
        if origin.scheme() != "https" && !(origin.scheme() == "http" && development_loopback) {
            return Err(BackendError::InvalidConfiguration(
                "the invitation service must use HTTPS".into(),
            ));
        }
        if !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || !matches!(origin.path(), "" | "/")
        {
            return Err(BackendError::InvalidConfiguration(
                "the invitation service address must be an origin without credentials or a path"
                    .into(),
            ));
        }
        origin.set_path("");
        if let Ok(address) = host.parse::<std::net::IpAddr>() {
            if Self::unsafe_admission_address(address) && !development_loopback {
                return Err(BackendError::PermissionDenied(
                    "This invitation points to a private or local network address and cannot be opened safely."
                        .into(),
                ));
            }
        } else if host.eq_ignore_ascii_case("localhost") && !development_loopback {
            return Err(BackendError::PermissionDenied(
                "This invitation points to this device and cannot be opened safely.".into(),
            ));
        }
        Ok(origin)
    }

    fn development_loopback_invitations_enabled() -> bool {
        cfg!(test)
            || (cfg!(debug_assertions)
                && std::env::var("MESH_ALLOW_INSECURE_LOOPBACK_INVITATIONS")
                    .is_ok_and(|value| value.trim() == "1"))
    }

    fn unsafe_admission_address(address: std::net::IpAddr) -> bool {
        match address {
            std::net::IpAddr::V4(address) => {
                let octets = address.octets();
                address.is_private()
                    || address.is_loopback()
                    || address.is_link_local()
                    || address.is_multicast()
                    || address.is_unspecified()
                    || address.is_broadcast()
                    || octets[0] == 0
                    || octets[0] >= 224
                    || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                    || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                    || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
                    || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
                    || (octets[0] == 198 && (18..=19).contains(&octets[1]))
                    || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                    || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
            }
            std::net::IpAddr::V6(address) => {
                if let Some(mapped) = address.to_ipv4_mapped() {
                    return Self::unsafe_admission_address(mapped.into());
                }
                let segments = address.segments();
                // Admission origins are intentionally limited to currently
                // allocated global unicast space. This rejects deprecated
                // IPv4-compatible forms, translation/discard prefixes, ULA,
                // link-local, site-local, and reserved future allocations.
                let allocated_global_unicast = segments[0] & 0xe000 == 0x2000;
                // IANA special-purpose ranges that sit inside 2000::/3 remain
                // unsuitable for an origin even when a subset is globally
                // reachable (for example protocol anycast addresses).
                let ietf_protocol_assignments = segments[0] == 0x2001 && segments[1] <= 0x01ff;
                let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
                let six_to_four = segments[0] == 0x2002;
                let documentation_v2 = segments[0] == 0x3fff && segments[1] & 0xf000 == 0;
                !allocated_global_unicast
                    || ietf_protocol_assignments
                    || documentation
                    || six_to_four
                    || documentation_v2
                    || address.is_loopback()
                    || address.is_unspecified()
                    || address.is_multicast()
                    || address.is_unique_local()
                    || address.is_unicast_link_local()
            }
        }
    }

    fn parse_admission_invitation(
        invite_url: &str,
        expected_origin: Option<&url::Url>,
    ) -> BackendResult<AdmissionInvitationTarget> {
        const CODE_MIN: usize = 32;
        const CODE_MAX: usize = 64;

        let invite_url = invite_url.trim();
        if invite_url.is_empty() || invite_url.len() > 4_096 {
            return Err(BackendError::InvalidConfiguration(
                "this community invitation is incomplete or invalid".into(),
            ));
        }
        let invite = url::Url::parse(invite_url).map_err(|_| {
            BackendError::InvalidConfiguration(
                "this community invitation is incomplete or invalid".into(),
            )
        })?;
        if !invite.username().is_empty()
            || invite.password().is_some()
            || (invite.scheme() == "mesh" && invite.fragment().is_some())
        {
            return Err(BackendError::InvalidConfiguration(
                "this community invitation is incomplete or invalid".into(),
            ));
        }

        let (code, origin, via, via_truncated) = if invite.scheme() == "mesh" {
            if invite.host_str() != Some("join") || !matches!(invite.path(), "" | "/") {
                return Err(BackendError::InvalidConfiguration(
                    "this community invitation is incomplete or invalid".into(),
                ));
            }
            let fields = invite
                .query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect::<Vec<_>>();
            let one = |name: &str| -> BackendResult<Option<String>> {
                let values = fields
                    .iter()
                    .filter(|(key, _)| key == name)
                    .map(|(_, value)| value.clone())
                    .collect::<Vec<_>>();
                if values.len() > 1 {
                    return Err(BackendError::InvalidConfiguration(
                        "this community invitation contains duplicate fields".into(),
                    ));
                }
                Ok(values.into_iter().next())
            };
            let version = one("v")?;
            let kind = one("kind")?;
            if version.as_deref() == Some("4") && kind.as_deref() == Some("managed") {
                if fields
                    .iter()
                    .any(|(key, _)| !matches!(key.as_str(), "v" | "kind" | "code" | "api"))
                {
                    return Err(BackendError::InvalidConfiguration(
                        "this community invitation contains unsupported fields".into(),
                    ));
                }
                let api = one("api")?.ok_or_else(|| {
                    BackendError::InvalidConfiguration(
                        "this community invitation has no service address".into(),
                    )
                })?;
                (
                    one("code")?.ok_or_else(|| {
                        BackendError::InvalidConfiguration(
                            "this community invitation has no admission code".into(),
                        )
                    })?,
                    Self::normalize_admission_origin(&api)?,
                    Vec::new(),
                    false,
                )
            } else if version.as_deref() == Some("5") && kind.as_deref() == Some("community") {
                if fields.iter().any(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        "v" | "kind"
                            | "room"
                            | "via"
                            | "community_service"
                            | "admission"
                            | "code"
                            | "resume"
                    )
                }) {
                    return Err(BackendError::InvalidConfiguration(
                        "this community invitation contains unsupported fields".into(),
                    ));
                }
                let room = one("room")?.ok_or_else(|| {
                    BackendError::InvalidConfiguration(
                        "this community invitation has no community identifier".into(),
                    )
                })?;
                RoomId::parse(&room).map_err(|_| {
                    BackendError::InvalidConfiguration(
                        "this community invitation has an invalid community identifier".into(),
                    )
                })?;
                let raw_via = fields
                    .iter()
                    .filter(|(key, _)| key == "via")
                    .flat_map(|(_, value)| value.split(','))
                    .collect::<Vec<_>>();
                if raw_via.is_empty() || raw_via.iter().any(|server| server.trim().is_empty()) {
                    return Err(BackendError::InvalidConfiguration(
                        "this community invitation has invalid routing information".into(),
                    ));
                }
                let mut via = Vec::new();
                for server in raw_via {
                    let server = server.trim();
                    ServerName::parse(server).map_err(|_| {
                        BackendError::InvalidConfiguration(
                            "this community invitation has invalid routing information".into(),
                        )
                    })?;
                    if !via.iter().any(|existing| existing == server) {
                        via.push(server.to_owned());
                    }
                }
                let via_truncated = via.len() > 3;
                via.truncate(3);
                if let Some(service) = one("community_service")? {
                    Self::normalize_homeserver_input(&service)?;
                }
                if let Some(resume) = one("resume")? {
                    let resume = url::Url::parse(&resume).map_err(|_| {
                        BackendError::InvalidConfiguration(
                            "this community invitation has an invalid resume address".into(),
                        )
                    })?;
                    let loopback = resume.host_str().is_some_and(|host| {
                        host.eq_ignore_ascii_case("localhost")
                            || host
                                .parse::<std::net::IpAddr>()
                                .is_ok_and(|address| address.is_loopback())
                    });
                    if (resume.scheme() != "https" && !(resume.scheme() == "http" && loopback))
                        || !resume.username().is_empty()
                        || resume.password().is_some()
                        || resume.fragment().is_some()
                    {
                        return Err(BackendError::InvalidConfiguration(
                            "this community invitation has an invalid resume address".into(),
                        ));
                    }
                }
                let admission = one("admission")?.ok_or_else(|| {
                    BackendError::InvalidConfiguration(
                        "this community invitation has no admission service".into(),
                    )
                })?;
                (
                    one("code")?.ok_or_else(|| {
                        BackendError::InvalidConfiguration(
                            "this community invitation has no admission code".into(),
                        )
                    })?,
                    Self::normalize_admission_origin(&admission)?,
                    via,
                    via_truncated,
                )
            } else {
                return Err(BackendError::InvalidConfiguration(
                    "this community invitation uses an unsupported version".into(),
                ));
            }
        } else {
            let mut origin = invite.clone();
            origin.set_path("");
            origin.set_query(None);
            origin.set_fragment(None);
            let origin = Self::normalize_admission_origin(origin.as_str())?;
            if invite.query().is_some() {
                return Err(BackendError::InvalidConfiguration(
                    "this community invitation contains unsupported fields".into(),
                ));
            }
            let segments = invite
                .path_segments()
                .map(|segments| segments.filter(|part| !part.is_empty()).collect::<Vec<_>>())
                .unwrap_or_default();
            if segments.len() != 1 || segments[0] != "invite" {
                return Err(BackendError::InvalidConfiguration(
                    "this community invitation is incomplete or invalid".into(),
                ));
            }
            let code = invite.fragment().ok_or_else(|| {
                BackendError::InvalidConfiguration(
                    "this community invitation has no admission capability".into(),
                )
            })?;
            (code.to_owned(), origin, Vec::new(), false)
        };

        if expected_origin.is_some_and(|expected| origin.origin() != expected.origin()) {
            return Err(BackendError::PermissionDenied(
                "the invitation was not issued by this community admission service".into(),
            ));
        }
        if !(CODE_MIN..=CODE_MAX).contains(&code.len())
            || !code.bytes().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, b'_' | b'-')
            })
        {
            return Err(BackendError::InvalidConfiguration(
                "this community invitation has an invalid admission code".into(),
            ));
        }
        Ok(AdmissionInvitationTarget {
            code,
            api_origin: origin,
            via,
            via_truncated,
        })
    }

    fn parse_direct_community_invitation(invite_url: &str) -> BackendResult<(String, Vec<String>)> {
        let invite_url = invite_url.trim();
        if invite_url.is_empty() || invite_url.len() > 4_096 {
            return Err(BackendError::RegistrationInvitationInvalid);
        }
        let invite =
            url::Url::parse(invite_url).map_err(|_| BackendError::RegistrationInvitationInvalid)?;
        if invite.scheme() != "mesh"
            || invite.host_str() != Some("join")
            || !matches!(invite.path(), "" | "/")
            || !invite.username().is_empty()
            || invite.password().is_some()
            || invite.port().is_some()
            || invite.fragment().is_some()
        {
            return Err(BackendError::RegistrationInvitationInvalid);
        }

        let fields = invite
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        if fields.iter().any(|(key, _)| {
            !matches!(
                key.as_str(),
                "v" | "kind" | "room" | "via" | "community_service" | "resume"
            )
        }) {
            // In particular, never reinterpret an incomplete or malformed
            // admission form as a direct room join. Admission and direct links
            // are distinct security modes, not fallback representations.
            return Err(BackendError::RegistrationInvitationInvalid);
        }
        let one = |name: &str| -> BackendResult<Option<String>> {
            let values = fields
                .iter()
                .filter(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .collect::<Vec<_>>();
            if values.len() > 1 {
                return Err(BackendError::RegistrationInvitationInvalid);
            }
            Ok(values.into_iter().next())
        };
        if one("v")?.as_deref() != Some("5") || one("kind")?.as_deref() != Some("community") {
            return Err(BackendError::RegistrationInvitationInvalid);
        }
        let room = one("room")?.ok_or(BackendError::RegistrationInvitationInvalid)?;
        RoomOrAliasId::parse(room.trim())
            .map_err(|_| BackendError::RegistrationInvitationInvalid)?;

        let raw_via = fields
            .iter()
            .filter(|(key, _)| key == "via")
            .flat_map(|(_, value)| value.split(','))
            .collect::<Vec<_>>();
        if raw_via.is_empty() || raw_via.iter().any(|server| server.trim().is_empty()) {
            return Err(BackendError::RegistrationInvitationInvalid);
        }
        let mut via = Vec::new();
        for server in raw_via {
            let server = server.trim();
            ServerName::parse(server).map_err(|_| BackendError::RegistrationInvitationInvalid)?;
            if !via.iter().any(|existing| existing == server) {
                via.push(server.to_owned());
            }
        }
        via.truncate(3);
        Ok((room, via))
    }

    fn admission_endpoint(origin: &url::Url, operation: &str) -> BackendResult<url::Url> {
        origin
            .join(&format!("/_mesh/admission/v1/invitations/{operation}"))
            .map_err(|_| {
                BackendError::InvalidConfiguration(
                    "the invitation service address could not be prepared".into(),
                )
            })
    }

    async fn admission_http_client(origin: &url::Url) -> BackendResult<reqwest::Client> {
        let host = origin.host_str().ok_or_else(|| {
            BackendError::InvalidConfiguration("the invitation service has no host".into())
        })?;
        let port = origin.port_or_known_default().ok_or_else(|| {
            BackendError::InvalidConfiguration("the invitation service has no usable port".into())
        })?;
        let resolved =
            tokio::time::timeout(ADMISSION_DNS_TIMEOUT, tokio::net::lookup_host((host, port)))
                .await
                .map_err(|_| {
                    BackendError::Network(
                        "The invitation service address took too long to look up.".into(),
                    )
                })?
                .map_err(|_| {
                    BackendError::Network(
                        "The invitation service address could not be found.".into(),
                    )
                })?
                .take(ADMISSION_MAX_RESOLVED_ADDRESSES + 1)
                .collect::<Vec<_>>();
        if resolved.is_empty() || resolved.len() > ADMISSION_MAX_RESOLVED_ADDRESSES {
            return Err(BackendError::Network(
                "The invitation service address could not be verified safely.".into(),
            ));
        }
        let development_loopback = Self::development_loopback_invitations_enabled()
            && origin.scheme() == "http"
            && resolved.iter().all(|address| address.ip().is_loopback());
        if !development_loopback
            && resolved
                .iter()
                .any(|address| Self::unsafe_admission_address(address.ip()))
        {
            return Err(BackendError::PermissionDenied(
                "This invitation resolves to a private or local network and cannot be opened safely."
                    .into(),
            ));
        }

        reqwest::Client::builder()
            // A process-level proxy could route around the pinned address set.
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            // Pin the verified DNS answer into this one client so a second DNS
            // answer cannot rebind the connection to a private address.
            .resolve_to_addrs(host, &resolved)
            .connect_timeout(ADMISSION_CONNECT_TIMEOUT)
            .read_timeout(ADMISSION_READ_TIMEOUT)
            .timeout(ADMISSION_REQUEST_TIMEOUT)
            .build()
            .map_err(BackendError::from_sdk_error)
    }

    fn append_admission_response_chunk(buffer: &mut Vec<u8>, chunk: &[u8]) -> BackendResult<()> {
        if buffer
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > ADMISSION_RESPONSE_MAX_BYTES)
        {
            return Err(BackendError::Serialization(
                "the invitation service response was too large".into(),
            ));
        }
        buffer.extend_from_slice(chunk);
        Ok(())
    }

    async fn admission_response_bytes(mut response: reqwest::Response) -> BackendResult<Vec<u8>> {
        let status = response.status();
        let content_length = response.content_length();
        if content_length.is_some_and(|length| length > ADMISSION_RESPONSE_MAX_BYTES as u64) {
            return Err(BackendError::Serialization(
                "the invitation service response was too large".into(),
            ));
        }
        let mut bytes = Vec::with_capacity(
            content_length
                .unwrap_or_default()
                .min(ADMISSION_RESPONSE_MAX_BYTES as u64) as usize,
        );
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(BackendError::from_sdk_error)?
        {
            Self::append_admission_response_chunk(&mut bytes, &chunk)?;
        }
        if status.is_success() {
            return Ok(bytes);
        }

        Err(Self::admission_error_response(status, &bytes))
    }

    fn admission_error_response(status: reqwest::StatusCode, bytes: &[u8]) -> BackendError {
        let error = match serde_json::from_slice::<AdmissionErrorResponse>(bytes) {
            Ok(error) => error,
            Err(_) => {
                // A malicious or buggy admission service can reflect the
                // invitation capability in its body. Never carry that body
                // through IPC, errors, or logs.
                let detail = format!(
                    "the invitation service returned malformed HTTP {} error data",
                    status.as_u16(),
                );
                return if status.is_client_error() {
                    BackendError::InvalidConfiguration(detail)
                } else {
                    BackendError::Network(detail)
                };
            }
        };
        let detail = format!(
            "the invitation service rejected the request with HTTP status {}",
            status.as_u16()
        );
        match status.as_u16() {
            401 => BackendError::NotAuthenticated,
            403 => BackendError::PermissionDenied(detail),
            404 | 410 => BackendError::RegistrationInvitationInvalid,
            409 if error.code == "invitation_claiming" => BackendError::RateLimited(detail),
            429 => BackendError::RateLimited(detail),
            400..=499 => BackendError::InvalidConfiguration(detail),
            _ => BackendError::Network(detail),
        }
    }

    fn validate_admission_response(
        response: AdmissionServiceResponse,
        require_registration: bool,
    ) -> BackendResult<super::MatrixCommunityAdmission> {
        if response.version != 4 {
            return Err(BackendError::Serialization(
                "the invitation service returned an unsupported response".into(),
            ));
        }
        matrix_sdk::ruma::RoomId::parse(&response.room_id).map_err(|_| {
            BackendError::Serialization(
                "the invitation service returned an invalid community".into(),
            )
        })?;
        if response.via.is_empty() || response.via.len() > 3 {
            return Err(BackendError::Serialization(
                "the invitation service returned invalid routing information".into(),
            ));
        }
        for server in &response.via {
            ServerName::parse(server).map_err(|_| {
                BackendError::Serialization(
                    "the invitation service returned invalid routing information".into(),
                )
            })?;
        }
        let response_service = Self::normalize_homeserver_input(&response.service)?;
        if require_registration
            && !response.registration_token.as_deref().is_some_and(|token| {
                !token.is_empty()
                    && token.len() <= 64
                    && token.bytes().all(|character| {
                        character.is_ascii_alphanumeric()
                            || matches!(character, b'.' | b'_' | b'~' | b'-')
                    })
            })
        {
            return Err(BackendError::Serialization(
                "the invitation service returned no valid account admission".into(),
            ));
        }
        let clean_label = |value: Option<String>, field: &str| -> BackendResult<Option<String>> {
            value
                .map(|value| {
                    let value = value.trim();
                    if value.is_empty()
                        || value.chars().count() > 255
                        || value.chars().any(char::is_control)
                    {
                        return Err(BackendError::Serialization(format!(
                            "the invitation service returned an invalid {field}"
                        )));
                    }
                    Ok(value.to_owned())
                })
                .transpose()
        };
        let community_name = clean_label(response.community_name, "community name")?;
        let inviter_display_name =
            clean_label(response.inviter_display_name, "inviter display name")?;
        let community_service_display_name = clean_label(
            response.community_service_display_name,
            "community service name",
        )?;
        let inviter_user_id = response
            .inviter_user_id
            .map(|value| {
                matrix_sdk::ruma::UserId::parse(value.trim())
                    .map(|user_id| user_id.to_string())
                    .map_err(|_| {
                        BackendError::Serialization(
                            "the invitation service returned an invalid inviter".into(),
                        )
                    })
            })
            .transpose()?;
        let join_rule = response
            .join_rule
            .map(|value| match value.trim() {
                "public" | "knock" | "invite" | "restricted" | "knock_restricted" => {
                    Ok(value.trim().to_owned())
                }
                _ => Err(BackendError::Serialization(
                    "the invitation service returned an invalid access policy".into(),
                )),
            })
            .transpose()?;
        Ok(super::MatrixCommunityAdmission {
            registration_token: response.registration_token,
            room_id: response.room_id,
            service: response_service,
            via: response.via,
            expires_at: response.expires_at,
            community_name,
            inviter_display_name,
            inviter_user_id,
            join_rule,
            community_service_display_name,
        })
    }

    async fn resolve_admission_invitation(
        &self,
        invite_url: &str,
        require_registration: bool,
    ) -> BackendResult<super::MatrixCommunityAdmission> {
        let target = Self::parse_admission_invitation(invite_url, None)?;
        let endpoint = Self::admission_endpoint(&target.api_origin, "resolve")?;
        let response = Self::admission_http_client(&target.api_origin)
            .await?
            .post(endpoint)
            .json(&serde_json::json!({ "invitation": target.code.as_str() }))
            .send()
            .await
            .map_err(BackendError::from_sdk_error)?;
        let payload = Self::admission_response_bytes(response).await?;
        let resolved: AdmissionServiceResponse =
            serde_json::from_slice(&payload).map_err(|error| {
                BackendError::Serialization(format!(
                    "the invitation service returned invalid JSON: {error}"
                ))
            })?;
        Self::validate_admission_response(resolved, require_registration)
    }
}
