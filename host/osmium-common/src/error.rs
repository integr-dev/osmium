use std::io;

use azalea_auth::{AuthError, GetProfileError};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RouterError {
    #[error("failed to read accounts")]
    AccountReadError(#[from] io::Error),
    #[error("failed to parse accounts")]
    AccountParseError(#[from] serde_json::Error),
}

#[derive(Debug, Error)]
pub enum LoginError {
    #[error("failed to fetch profile")]
    GetProfileError(#[from] GetProfileError),
    #[error("failed to authorize profile")]
    AuthError(#[from] AuthError),
}
