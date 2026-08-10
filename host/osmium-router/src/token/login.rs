use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub enum Login {
    RefreshToken {
        /// MSA refresh token
        msa_refresh: &'static str,
        /// Obtained mojang account token
        mojang: Option<&'static str>,
    },

    MojangToken {
        /// Mojang account token
        token: &'static str,
    },
}
