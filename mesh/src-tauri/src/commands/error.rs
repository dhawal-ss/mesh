use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("network error: {0}")]
    Network(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("identity error: {0}")]
    Identity(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("rate limited")]
    RateLimited,
    #[error("banned from community")]
    Banned,
    #[error("{0}")]
    Other(String),
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<anyhow::Error> for CommandError {
    fn from(err: anyhow::Error) -> Self {
        CommandError::Other(err.to_string())
    }
}

impl From<String> for CommandError {
    fn from(err: String) -> Self {
        CommandError::Other(err)
    }
}

impl From<&str> for CommandError {
    fn from(err: &str) -> Self {
        CommandError::Other(err.to_string())
    }
}
