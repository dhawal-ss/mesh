const MANAGED_ADMISSION_ORIGIN_ENV: &str = "MESH_MANAGED_ADMISSION_ORIGIN";
const DEFAULT_MANAGED_ADMISSION_ORIGIN: &str = "https://mesh.dhawal.org";
const ADMISSION_RESPONSE_MAX_BYTES: usize = 64 * 1024;
const ADMISSION_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

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
}

#[derive(Debug, Deserialize)]
struct AdmissionErrorResponse {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManagedInvitationTarget {
    code: String,
    api_origin: url::Url,
}

impl MatrixBackend {
    fn managed_admission_origin() -> BackendResult<url::Url> {
        let configured = std::env::var(MANAGED_ADMISSION_ORIGIN_ENV)
            .ok()
            .or_else(|| option_env!("MESH_MANAGED_ADMISSION_ORIGIN").map(str::to_owned))
            .unwrap_or_else(|| DEFAULT_MANAGED_ADMISSION_ORIGIN.to_owned());
        Self::normalize_admission_origin(&configured)
    }

    fn normalize_admission_origin(value: &str) -> BackendResult<url::Url> {
        let mut origin = url::Url::parse(value.trim()).map_err(|_| {
            BackendError::InvalidConfiguration("the invitation service address is invalid".into())
        })?;
        let host = origin.host_str().ok_or_else(|| {
            BackendError::InvalidConfiguration(
                "the invitation service address has no host".into(),
            )
        })?;
        let loopback = host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback());
        if origin.scheme() != "https" && !(origin.scheme() == "http" && loopback) {
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
        Ok(origin)
    }

    fn parse_managed_invitation(
        invite_url: &str,
        expected_origin: &url::Url,
    ) -> BackendResult<ManagedInvitationTarget> {
        const CODE_MIN: usize = 32;
        const CODE_MAX: usize = 64;

        let invite = url::Url::parse(invite_url.trim()).map_err(|_| {
            BackendError::InvalidConfiguration(
                "this community invitation is incomplete or invalid".into(),
            )
        })?;
        if !invite.username().is_empty() || invite.password().is_some() || invite.fragment().is_some()
        {
            return Err(BackendError::InvalidConfiguration(
                "this community invitation is incomplete or invalid".into(),
            ));
        }

        let (code, origin) = if invite.scheme() == "mesh" {
            if invite.host_str() != Some("join") || !matches!(invite.path(), "" | "/") {
                return Err(BackendError::InvalidConfiguration(
                    "this community invitation is incomplete or invalid".into(),
                ));
            }
            let mut version = None;
            let mut kind = None;
            let mut code = None;
            let mut api = None;
            for (key, value) in invite.query_pairs() {
                let destination = match key.as_ref() {
                    "v" => &mut version,
                    "kind" => &mut kind,
                    "code" => &mut code,
                    "api" => &mut api,
                    _ => {
                        return Err(BackendError::InvalidConfiguration(
                            "this community invitation contains unsupported fields".into(),
                        ))
                    }
                };
                if destination.replace(value.into_owned()).is_some() {
                    return Err(BackendError::InvalidConfiguration(
                        "this community invitation contains duplicate fields".into(),
                    ));
                }
            }
            if version.as_deref() != Some("4") || kind.as_deref() != Some("managed") {
                return Err(BackendError::InvalidConfiguration(
                    "this community invitation uses an unsupported version".into(),
                ));
            }
            let api = api.ok_or_else(|| {
                BackendError::InvalidConfiguration(
                    "this community invitation has no service address".into(),
                )
            })?;
            (
                code.ok_or_else(|| {
                    BackendError::InvalidConfiguration(
                        "this community invitation has no admission code".into(),
                    )
                })?,
                Self::normalize_admission_origin(&api)?,
            )
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
            if segments.len() != 2 || segments[0] != "invite" {
                return Err(BackendError::InvalidConfiguration(
                    "this community invitation is incomplete or invalid".into(),
                ));
            }
            (segments[1].to_owned(), origin)
        };

        if origin.origin() != expected_origin.origin() {
            return Err(BackendError::PermissionDenied(
                "the invitation is for a different Mesh service".into(),
            ));
        }
        if !(CODE_MIN..=CODE_MAX).contains(&code.len())
            || !code
                .bytes()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, b'_' | b'-'))
        {
            return Err(BackendError::InvalidConfiguration(
                "this community invitation has an invalid admission code".into(),
            ));
        }
        Ok(ManagedInvitationTarget {
            code,
            api_origin: origin,
        })
    }

    fn admission_endpoint(
        target: &ManagedInvitationTarget,
        suffix: &str,
    ) -> BackendResult<url::Url> {
        target
            .api_origin
            .join(&format!(
                "/_mesh/admission/v1/invitations/{}{}",
                target.code, suffix
            ))
            .map_err(|_| {
                BackendError::InvalidConfiguration(
                    "the invitation service address could not be prepared".into(),
                )
            })
    }

    fn admission_http_client() -> BackendResult<reqwest::Client> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(ADMISSION_REQUEST_TIMEOUT)
            .build()
            .map_err(BackendError::from_sdk_error)
    }

    async fn admission_response_bytes(
        response: reqwest::Response,
    ) -> BackendResult<Vec<u8>> {
        let status = response.status();
        let content_length = response.content_length();
        if content_length.is_some_and(|length| length > ADMISSION_RESPONSE_MAX_BYTES as u64) {
            return Err(BackendError::Serialization(
                "the invitation service response was too large".into(),
            ));
        }
        let bytes = response.bytes().await.map_err(BackendError::from_sdk_error)?;
        if bytes.len() > ADMISSION_RESPONSE_MAX_BYTES {
            return Err(BackendError::Serialization(
                "the invitation service response was too large".into(),
            ));
        }
        if status.is_success() {
            return Ok(bytes.to_vec());
        }

        let error = serde_json::from_slice::<AdmissionErrorResponse>(&bytes).unwrap_or(
            AdmissionErrorResponse {
                code: String::new(),
                message: String::new(),
            },
        );
        let detail = if error.message.trim().is_empty() {
            "The invitation service could not complete this request.".to_owned()
        } else {
            error.message
        };
        match status.as_u16() {
            401 => Err(BackendError::NotAuthenticated),
            403 => Err(BackendError::PermissionDenied(detail)),
            404 | 410 => Err(BackendError::RegistrationInvitationInvalid),
            409 if error.code == "invitation_claiming" => Err(BackendError::RateLimited(detail)),
            429 => Err(BackendError::RateLimited(detail)),
            400..=499 => Err(BackendError::InvalidConfiguration(detail)),
            _ => Err(BackendError::Network(detail)),
        }
    }

    fn validate_admission_response(
        response: AdmissionServiceResponse,
        managed: &ManagedHomeserverConfig,
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
        let expected_service = Self::normalize_homeserver_input(&managed.homeserver)?;
        if response_service.trim_end_matches('/') != expected_service.trim_end_matches('/') {
            return Err(BackendError::PermissionDenied(
                "the invitation resolved to a different account service".into(),
            ));
        }
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
        Ok(super::MatrixCommunityAdmission {
            registration_token: response.registration_token,
            room_id: response.room_id,
            service: response_service,
            via: response.via,
            expires_at: response.expires_at,
        })
    }

    async fn resolve_managed_invitation(
        &self,
        invite_url: &str,
        require_registration: bool,
    ) -> BackendResult<super::MatrixCommunityAdmission> {
        let expected_origin = Self::managed_admission_origin()?;
        let target = Self::parse_managed_invitation(invite_url, &expected_origin)?;
        let endpoint = Self::admission_endpoint(&target, "")?;
        let response = Self::admission_http_client()?
            .get(endpoint)
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
        let managed = Self::managed_homeserver_config()?;
        Self::validate_admission_response(resolved, &managed, require_registration)
    }
}
