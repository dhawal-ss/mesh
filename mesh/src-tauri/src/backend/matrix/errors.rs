use super::*;

/*
  Classification used to be a keyword search over `error.to_string()`.

  Three things were wrong with that, and they compound. The typed SDK error was
  discarded, so everything downstream reasoned about prose. The tests below pin
  the two orderings that actually bit: `contains("forbidden")` was evaluated
  before the 401 family, so an expired token classified as PermissionDenied and
  the renderer offered "your account does not have permission" instead of "sign
  in again"; and `contains("http")` sat near the end of the chain and captured
  nearly any residual error as Network, which reads as "try again" for failures
  that will never succeed. And the same string was both the classification input
  and the payload, so a homeserver had direct influence over which error a
  person saw.

  Matrix already answers this precisely. `errcode` is a closed vocabulary and
  the status code is a number, so both are decided by the protocol rather than
  by whatever text a server chose. Only errors carrying neither fall back to
  the string classifier, which is now what it should always have been: a last
  resort for error types that genuinely have no structure.
*/

/// An error that may be able to say what the protocol said.
///
/// Deliberately not a blanket impl over `Display`: the point is that the two
/// SDK error types carry structure and everything else does not, and the
/// compiler should route each call site to the right one.
pub(super) trait MatrixErrorClassification: std::fmt::Display {
    fn matrix_error_kind(&self) -> Option<&ErrorKind>;
    fn matrix_status_code(&self) -> Option<u16>;
}

impl MatrixErrorClassification for matrix_sdk::Error {
    fn matrix_error_kind(&self) -> Option<&ErrorKind> {
        self.client_api_error_kind()
    }

    fn matrix_status_code(&self) -> Option<u16> {
        self.as_client_api_error()
            .map(|error| error.status_code.as_u16())
    }
}

impl MatrixErrorClassification for matrix_sdk::HttpError {
    fn matrix_error_kind(&self) -> Option<&ErrorKind> {
        self.client_api_error_kind()
    }

    fn matrix_status_code(&self) -> Option<u16> {
        self.as_client_api_error()
            .map(|error| error.status_code.as_u16())
    }
}

/// What Mesh says about a protocol answer, without repeating the server's text.
///
/// The errcode is a closed vocabulary, so naming it is safe and useful in a
/// diagnostic. The server's free-form message is not included: it was the
/// thing that let a homeserver influence the classification, and including it
/// downstream would let it influence the reading too.
pub(super) fn described_matrix_failure(kind: Option<&ErrorKind>, status: Option<u16>) -> String {
    match (kind, status) {
        (Some(kind), Some(status)) => {
            format!(
                "the account service answered {} ({status})",
                kind.errcode().as_str()
            )
        }
        (Some(kind), None) => {
            format!("the account service answered {}", kind.errcode().as_str())
        }
        (None, Some(status)) => format!("the account service answered HTTP {status}"),
        (None, None) => "the account service could not be reached".into(),
    }
}

/// Classify from `errcode` first, then status, then -- only for errors that
/// carry neither -- the display string.
pub(super) fn classify_matrix_error<E: MatrixErrorClassification>(error: E) -> BackendError {
    let kind = error.matrix_error_kind();
    let status = error.matrix_status_code();
    if kind.is_none() && status.is_none() {
        return BackendError::from_sdk_error(error);
    }
    let detail = described_matrix_failure(kind, status);

    if let Some(kind) = kind {
        return match kind {
            ErrorKind::LimitExceeded(_) => BackendError::RateLimited(detail),
            // Before status, and before Forbidden. An expired or revoked token
            // is the commonest 401 and it is not a permission problem: the
            // recovery is to sign in, not to ask somebody for access.
            ErrorKind::UnknownToken(_) | ErrorKind::MissingToken => BackendError::NotAuthenticated,
            ErrorKind::Forbidden => BackendError::PermissionDenied(detail),
            ErrorKind::NotFound => BackendError::NotFound(detail),
            ErrorKind::Unrecognized => BackendError::Unsupported("this account service endpoint"),
            ErrorKind::NotJson | ErrorKind::BadJson => BackendError::Serialization(detail),
            _ => classify_matrix_status(status, detail),
        };
    }
    classify_matrix_status(status, detail)
}

fn classify_matrix_status(status: Option<u16>, detail: String) -> BackendError {
    match status {
        Some(401) => BackendError::NotAuthenticated,
        Some(403) => BackendError::PermissionDenied(detail),
        Some(404) => BackendError::NotFound(detail),
        Some(429) => BackendError::RateLimited(detail),
        // 5xx is the service failing, which is worth retrying. 4xx that reached
        // here is a request this build made wrongly, which is not.
        Some(status) if (500..600).contains(&status) => BackendError::Network(detail),
        Some(_) => BackendError::Other(detail),
        None => BackendError::Other(detail),
    }
}

#[cfg(test)]
mod matrix_error_classification_tests {
    use super::*;

    struct Classified {
        kind: Option<ErrorKind>,
        status: Option<u16>,
    }

    impl std::fmt::Display for Classified {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            // Deliberately hostile: prose a homeserver could choose, naming the
            // wrong classification on purpose.
            write!(
                formatter,
                "M_FORBIDDEN forbidden: network timeout not found"
            )
        }
    }

    impl MatrixErrorClassification for Classified {
        fn matrix_error_kind(&self) -> Option<&ErrorKind> {
            self.kind.as_ref()
        }
        fn matrix_status_code(&self) -> Option<u16> {
            self.status
        }
    }

    fn classify(kind: Option<ErrorKind>, status: Option<u16>) -> BackendError {
        classify_matrix_error(Classified { kind, status })
    }

    #[test]
    fn an_expired_token_is_a_sign_in_problem_not_a_permission_one() {
        // The defect this closes: the word "forbidden" appeared in the message
        // and was tested before the 401 family, so an expired token classified
        // as PermissionDenied and the renderer offered "your account does not
        // have permission" instead of "sign in again". Match arms cannot
        // reproduce that -- the variants are distinct and order is irrelevant
        // to them, which is the improvement. What is being asserted is that
        // the answer comes from the protocol at all.
        assert!(matches!(
            classify(Some(ErrorKind::UnknownToken(Default::default())), Some(401)),
            BackendError::NotAuthenticated
        ));
        assert!(matches!(
            classify(None, Some(401)),
            BackendError::NotAuthenticated
        ));
    }

    #[test]
    fn a_hostile_message_cannot_choose_its_own_classification() {
        // Every one of these carries text naming a different error than the
        // errcode does. The errcode wins, and none of that text reaches the
        // payload.
        let denied = classify(Some(ErrorKind::Forbidden), Some(403));
        assert!(matches!(denied, BackendError::PermissionDenied(_)));
        let BackendError::PermissionDenied(detail) = denied else {
            unreachable!()
        };
        assert!(
            !detail.contains("timeout"),
            "server prose reached the payload: {detail}"
        );
        assert!(
            !detail.contains("not found"),
            "server prose reached the payload: {detail}"
        );

        assert!(matches!(
            classify(Some(ErrorKind::NotFound), Some(404)),
            BackendError::NotFound(_)
        ));
        assert!(matches!(
            classify(
                Some(ErrorKind::LimitExceeded(Default::default())),
                Some(429)
            ),
            BackendError::RateLimited(_)
        ));
    }

    #[test]
    fn a_server_fault_is_retryable_and_a_bad_request_is_not() {
        // "http" used to appear near the end of the string chain and captured
        // almost anything as Network, which tells somebody to try again after a
        // failure that will never succeed.
        assert!(matches!(
            classify(None, Some(503)),
            BackendError::Network(_)
        ));
        assert!(matches!(classify(None, Some(400)), BackendError::Other(_)));
    }

    #[test]
    fn an_error_carrying_no_protocol_answer_still_falls_back_to_the_text() {
        // Not every error is an API response. Those keep the old classifier,
        // which is the only thing available for them.
        assert!(matches!(
            classify(None, None),
            BackendError::PermissionDenied(_)
        ));
    }
}
