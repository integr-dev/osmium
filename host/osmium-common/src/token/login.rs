use std::sync::Arc;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Hash, Clone)]
pub enum Login {
    RefreshToken {
        /// MSA refresh token
        msa_refresh: Arc<str>,
        // /// Obtained mojang account token
        // mojang: Option<String>,
    },

    MojangToken {
        /// Mojang account token
        token: Arc<str>,
    },

    NoToken,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum LoginKind {
    RefreshToken,
    MojangToken,
    NoToken,
}

pub enum LoginState {
    Online,
    FailedConnection,

    UnlinkedCredentials,
    LinkedCredentials,
    NeedLinkCredentials,
}

impl Login {
    pub fn kind(&self) -> LoginKind {
        match self {
            Login::RefreshToken { .. } => LoginKind::RefreshToken,
            Login::MojangToken { .. } => LoginKind::MojangToken,
            Login::NoToken => LoginKind::NoToken,
        }
    }
}
