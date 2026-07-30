const COMMUNITY_ADMISSION_ORIGIN_ENV: &str = "MESH_COMMUNITY_ADMISSION_ORIGIN";
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
struct AdmissionInvitationTarget {
    code: String,
    api_origin: url::Url,
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
                )
            } else if version.as_deref() == Some("5") && kind.as_deref() == Some("community") {
                if fields.iter().any(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        "v"
                            | "kind"
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
                let via = fields
                    .iter()
                    .filter(|(key, _)| key == "via")
                    .flat_map(|(_, value)| value.split(','))
                    .filter(|value| !value.trim().is_empty())
                    .collect::<Vec<_>>();
                if via.is_empty()
                    || via.len() > 3
                    || via
                        .iter()
                        .any(|server| ServerName::parse(server.trim()).is_err())
                {
                    return Err(BackendError::InvalidConfiguration(
                        "this community invitation has invalid routing information".into(),
                    ));
                }
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
            if segments.len() != 2 || segments[0] != "invite" {
                return Err(BackendError::InvalidConfiguration(
                    "this community invitation is incomplete or invalid".into(),
                ));
            }
            (segments[1].to_owned(), origin)
        };

        if expected_origin.is_some_and(|expected| origin.origin() != expected.origin()) {
            return Err(BackendError::PermissionDenied(
                "the invitation was not issued by this community admission service".into(),
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
        Ok(AdmissionInvitationTarget {
            code,
            api_origin: origin,
        })
    }

    fn admission_endpoint(
        target: &AdmissionInvitationTarget,
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
        Ok(super::MatrixCommunityAdmission {
            registration_token: response.registration_token,
            room_id: response.room_id,
            service: response_service,
            via: response.via,
            expires_at: response.expires_at,
        })
    }

    async fn resolve_admission_invitation(
        &self,
        invite_url: &str,
        require_registration: bool,
    ) -> BackendResult<super::MatrixCommunityAdmission> {
        let target = Self::parse_admission_invitation(invite_url, None)?;
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
        Self::validate_admission_response(resolved, require_registration)
    }
}
