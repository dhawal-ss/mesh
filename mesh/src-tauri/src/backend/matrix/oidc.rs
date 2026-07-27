use std::{
    io,
    net::{Ipv4Addr, SocketAddrV4},
    path::{Path, PathBuf},
    time::Duration,
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;
use url::Url;

pub(super) const CALLBACK_ADDRESS: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8418);
pub(super) const CALLBACK_PATH: &str = "/oauth/callback";
pub(super) const MAX_CALLBACK_REQUEST_BYTES: usize = 8 * 1024;
pub(super) const CALLBACK_TIMEOUT: Duration = Duration::from_secs(120);

const SUCCESS_RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\n\
Content-Type: text/html; charset=utf-8\r\n\
Cache-Control: no-store\r\n\
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
X-Content-Type-Options: nosniff\r\n\
Connection: close\r\n\
\r\n\
<!doctype html><html><head><meta charset=\"utf-8\"><title>Mesh sign-in complete</title>\
<style>body{font:16px system-ui;margin:3rem;max-width:36rem}</style></head>\
<body><h1>Return to Mesh</h1><p>The sign-in response was received. You can close this window.</p></body></html>";

const INVALID_RESPONSE: &[u8] = b"HTTP/1.1 400 Bad Request\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Cache-Control: no-store\r\n\
X-Content-Type-Options: nosniff\r\n\
Connection: close\r\n\
\r\nInvalid sign-in response. Return to Mesh.";

const METHOD_RESPONSE: &[u8] = b"HTTP/1.1 405 Method Not Allowed\r\n\
Allow: GET\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Cache-Control: no-store\r\n\
Connection: close\r\n\
\r\nInvalid sign-in response. Return to Mesh.";

const NOT_FOUND_RESPONSE: &[u8] = b"HTTP/1.1 404 Not Found\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Cache-Control: no-store\r\n\
Connection: close\r\n\
\r\nInvalid sign-in response. Return to Mesh.";

const TOO_LARGE_RESPONSE: &[u8] = b"HTTP/1.1 413 Payload Too Large\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Cache-Control: no-store\r\n\
Connection: close\r\n\
\r\nInvalid sign-in response. Return to Mesh.";

#[derive(Debug, thiserror::Error)]
pub(super) enum CallbackError {
    #[error("the Mesh sign-in callback port is already in use")]
    PortUnavailable,
    #[error("the Mesh sign-in callback was cancelled")]
    Cancelled,
    #[error("the Mesh sign-in callback timed out")]
    TimedOut,
    #[error("the Mesh sign-in callback request was too large")]
    RequestTooLarge,
    #[error("the Mesh sign-in callback only accepts GET")]
    InvalidMethod,
    #[error("the Mesh sign-in callback path was invalid")]
    InvalidPath,
    #[error("the Mesh sign-in callback request was invalid")]
    InvalidRequest,
    #[error("the Mesh sign-in callback listener failed")]
    Io,
}

pub(super) struct EphemeralStore {
    path: PathBuf,
}

impl EphemeralStore {
    pub(super) fn create(root: &Path) -> io::Result<Self> {
        let parent = root.join("oauth-attempts");
        std::fs::create_dir_all(&parent)?;
        let path = parent.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&path)?;
        Ok(Self { path })
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn remove_stale(root: &Path) -> io::Result<()> {
        let parent = root.join("oauth-attempts");
        if parent.exists() {
            std::fs::remove_dir_all(parent)?;
        }
        Ok(())
    }
}

impl Drop for EphemeralStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }
}

pub(super) async fn bind_callback_listener() -> Result<TcpListener, CallbackError> {
    TcpListener::bind(CALLBACK_ADDRESS).await.map_err(|error| {
        if error.kind() == io::ErrorKind::AddrInUse {
            CallbackError::PortUnavailable
        } else {
            CallbackError::Io
        }
    })
}

pub(super) async fn receive_callback(
    listener: TcpListener,
    cancellation: CancellationToken,
    expected_state: &str,
) -> Result<Url, CallbackError> {
    receive_callback_with_timeout(listener, cancellation, CALLBACK_TIMEOUT, expected_state).await
}

async fn receive_callback_with_timeout(
    listener: TcpListener,
    cancellation: CancellationToken,
    timeout: Duration,
    expected_state: &str,
) -> Result<Url, CallbackError> {
    tokio::select! {
        _ = cancellation.cancelled() => Err(CallbackError::Cancelled),
        result = tokio::time::timeout(timeout, async {
            loop {
                let (stream, peer) = listener.accept().await.map_err(|_| CallbackError::Io)?;
                if !peer.ip().is_loopback() {
                    let mut stream = stream;
                    let _ = stream.write_all(INVALID_RESPONSE).await;
                    continue;
                }

                match handle_connection(stream, expected_state).await {
                    Ok(callback) => return Ok(callback),
                    Err(CallbackError::Io) => continue,
                    Err(_) => continue,
                }
            }
        }) => result.unwrap_or(Err(CallbackError::TimedOut)),
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    expected_state: &str,
) -> Result<Url, CallbackError> {
    let mut request = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .map_err(|_| CallbackError::TimedOut)?
            .map_err(|_| CallbackError::Io)?;
        if read == 0 {
            let _ = stream.write_all(INVALID_RESPONSE).await;
            return Err(CallbackError::InvalidRequest);
        }
        if request.len() + read > MAX_CALLBACK_REQUEST_BYTES {
            let _ = stream.write_all(TOO_LARGE_RESPONSE).await;
            return Err(CallbackError::RequestTooLarge);
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    let callback = match parse_callback_request(&request) {
        Ok(callback) => callback,
        Err(CallbackError::InvalidMethod) => {
            let _ = stream.write_all(METHOD_RESPONSE).await;
            return Err(CallbackError::InvalidMethod);
        }
        Err(CallbackError::InvalidPath) => {
            let _ = stream.write_all(NOT_FOUND_RESPONSE).await;
            return Err(CallbackError::InvalidPath);
        }
        Err(error) => {
            let _ = stream.write_all(INVALID_RESPONSE).await;
            return Err(error);
        }
    };
    if callback
        .query_pairs()
        .find(|(key, _)| key == "state")
        .is_none_or(|(_, state)| state != expected_state)
    {
        let _ = stream.write_all(INVALID_RESPONSE).await;
        return Err(CallbackError::InvalidRequest);
    }
    stream
        .write_all(SUCCESS_RESPONSE)
        .await
        .map_err(|_| CallbackError::Io)?;
    let _ = stream.shutdown().await;
    Ok(callback)
}

fn parse_callback_request(request: &[u8]) -> Result<Url, CallbackError> {
    let header_end = request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or(CallbackError::InvalidRequest)?;
    let headers =
        std::str::from_utf8(&request[..header_end]).map_err(|_| CallbackError::InvalidRequest)?;
    let request_line = headers
        .split("\r\n")
        .next()
        .ok_or(CallbackError::InvalidRequest)?;
    let mut parts = request_line.split(' ');
    let method = parts.next().ok_or(CallbackError::InvalidRequest)?;
    let target = parts.next().ok_or(CallbackError::InvalidRequest)?;
    let version = parts.next().ok_or(CallbackError::InvalidRequest)?;
    if parts.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err(CallbackError::InvalidRequest);
    }
    if method != "GET" {
        return Err(CallbackError::InvalidMethod);
    }
    if !target.starts_with('/') || target.starts_with("//") {
        return Err(CallbackError::InvalidRequest);
    }
    let callback = Url::parse(&format!("http://{CALLBACK_ADDRESS}{target}"))
        .map_err(|_| CallbackError::InvalidRequest)?;
    if callback.path() != CALLBACK_PATH {
        return Err(CallbackError::InvalidPath);
    }
    Ok(callback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_parser_accepts_only_the_exact_get_path() {
        let parsed = parse_callback_request(
            b"GET /oauth/callback?code=opaque&state=opaque HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        )
        .unwrap();
        assert_eq!(parsed.path(), CALLBACK_PATH);
        assert_eq!(parsed.query(), Some("code=opaque&state=opaque"));
        let denial = parse_callback_request(
            b"GET /oauth/callback?error=access_denied&state=opaque HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        )
        .unwrap();
        assert_eq!(denial.query(), Some("error=access_denied&state=opaque"));

        assert!(matches!(
            parse_callback_request(
                b"POST /oauth/callback?code=opaque HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
            ),
            Err(CallbackError::InvalidMethod)
        ));
        assert!(matches!(
            parse_callback_request(
                b"GET /oauth/callback/other?code=opaque HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
            ),
            Err(CallbackError::InvalidPath)
        ));
    }

    #[tokio::test]
    async fn oversized_callback_is_rejected_without_echoing_sensitive_input() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let receive = tokio::spawn(receive_callback(
            listener,
            CancellationToken::new(),
            "opaque",
        ));
        let mut stream = TcpStream::connect(address).await.unwrap();
        let oversized = vec![b'x'; MAX_CALLBACK_REQUEST_BYTES + 1];
        stream.write_all(&oversized).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 413"));

        let mut valid = TcpStream::connect(address).await.unwrap();
        valid
            .write_all(
                b"GET /oauth/callback?code=real&state=opaque HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            )
            .await
            .unwrap();
        let mut valid_response = Vec::new();
        valid.read_to_end(&mut valid_response).await.unwrap();
        assert!(String::from_utf8_lossy(&valid_response).starts_with("HTTP/1.1 200"));
        assert_eq!(
            receive.await.unwrap().unwrap().query(),
            Some("code=real&state=opaque")
        );
    }

    #[tokio::test]
    async fn invalid_first_callback_does_not_preempt_the_valid_redirect() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let receive = tokio::spawn(receive_callback(
            listener,
            CancellationToken::new(),
            "expected-state",
        ));

        let mut invalid = TcpStream::connect(address).await.unwrap();
        invalid
            .write_all(
                b"GET /oauth/callback?code=attacker&state=wrong-state HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            )
            .await
            .unwrap();
        let mut invalid_response = Vec::new();
        invalid.read_to_end(&mut invalid_response).await.unwrap();
        assert!(String::from_utf8_lossy(&invalid_response).starts_with("HTTP/1.1 400"));

        let mut valid = TcpStream::connect(address).await.unwrap();
        valid
            .write_all(
                b"GET /oauth/callback?code=real&state=expected-state HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            )
            .await
            .unwrap();
        let mut valid_response = Vec::new();
        valid.read_to_end(&mut valid_response).await.unwrap();
        assert!(String::from_utf8_lossy(&valid_response).starts_with("HTTP/1.1 200"));

        let callback = receive.await.unwrap().unwrap();
        assert_eq!(callback.query(), Some("code=real&state=expected-state"));
    }

    #[tokio::test]
    async fn callback_cancellation_releases_the_exclusive_listener() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            receive_callback(listener, cancellation, "opaque").await,
            Err(CallbackError::Cancelled)
        ));
        TcpListener::bind(address)
            .await
            .expect("listener must be released after cancellation");
    }

    #[tokio::test]
    async fn callback_timeout_releases_the_exclusive_listener() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(matches!(
            receive_callback_with_timeout(
                listener,
                CancellationToken::new(),
                Duration::from_millis(10),
                "opaque",
            )
            .await,
            Err(CallbackError::TimedOut)
        ));
        TcpListener::bind(address)
            .await
            .expect("listener must be released after timeout");
    }

    #[tokio::test]
    async fn occupied_callback_address_fails_closed() {
        let occupied = match TcpListener::bind(CALLBACK_ADDRESS).await {
            Ok(listener) => listener,
            Err(_) => return,
        };
        assert!(matches!(
            bind_callback_listener().await,
            Err(CallbackError::PortUnavailable)
        ));
        drop(occupied);
    }

    #[test]
    fn stale_ephemeral_stores_are_removed_before_a_restart_attempt() {
        let root = tempfile::tempdir().unwrap();
        let attempt = EphemeralStore::create(root.path()).unwrap();
        let attempt_path = attempt.path().to_owned();
        std::mem::forget(attempt);
        assert!(attempt_path.exists());
        EphemeralStore::remove_stale(root.path()).unwrap();
        assert!(!attempt_path.exists());
    }
}
