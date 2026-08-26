use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use azalea_auth::{
    AuthError, GetProfileError, MinecraftTokenResponse,
    sessionserver::{self, ClientSessionServerError, SessionServerJoinOpts},
};
use azalea_client::account::{Account, AccountTrait};
use rand::distr::{Alphanumeric, SampleString};
use reqwest::Client;
use uuid::Uuid;

use crate::{
    error::LoginError,
    sync::mutex::MutexExt,
    token::{login::Login, store::LoginHandle},
};

type BoxFuture<'a, T> = core::pin::Pin<Box<dyn Future<Output = T> + 'a + Send>>;

#[derive(Debug)]
pub struct TokenAccount {
    login: LoginHandle,
    token: Option<Mutex<String>>,
    username: String,
    uuid: Uuid,
}

#[async_trait]
pub trait TokenAccountExt: Sized {
    async fn login(login: LoginHandle) -> Result<Self, LoginError>;
}

impl AccountTrait for TokenAccount {
    fn username(&self) -> &str {
        &self.username
    }

    fn uuid(&self) -> Uuid {
        self.uuid
    }

    fn access_token(&self) -> Option<String> {
        self.token.as_ref().map(|m| m.lock_ignore().clone())
    }

    fn refresh(&self) -> BoxFuture<'_, Result<(), azalea_auth::AuthError>> {
        let Login::RefreshToken { msa_refresh } = &self.login.inner else {
            return Box::pin(async { Ok(()) });
        };

        Box::pin(async {
            let client = &reqwest::Client::new();
            let MinecraftTokenResponse {
                minecraft_access_token,
                ..
            } = azalea_auth::get_minecraft_token(client, msa_refresh).await?;

            self.token
                .as_ref()
                .map(|t| *t.lock_ignore() = minecraft_access_token.into());

            Ok(())
        })
    }

    fn certs(&self) -> Option<azalea_auth::certs::Certificates> {
        None
    }

    fn set_certs(&self, certs: azalea_auth::certs::Certificates) {
        let _ = certs;
    }

    fn join<'a>(
        &'a self,
        public_key: &'a [u8],
        private_key: &'a [u8; 16],
        server_id: &'a str,
        proxy: Option<reqwest::Proxy>,
    ) -> BoxFuture<'a, Result<(), ClientSessionServerError>> {
        let Some(token) = self.token.as_ref() else {
            return Box::pin(async move { Ok(()) });
        };

        Box::pin(async move {
            let opts = SessionServerJoinOpts {
                access_token: &token.lock_ignore().clone(),
                public_key,
                private_key,
                uuid: &self.uuid,
                server_id,
                proxy,
            };

            sessionserver::join(opts).await
        })
    }
}

#[async_trait]
impl TokenAccountExt for Account {
    async fn login(login: LoginHandle) -> Result<Self, LoginError> {
        TokenAccount::login(login).await.map(|t| t.into())
    }
}

impl TokenAccount {
    pub async fn login(login: LoginHandle) -> Result<Self, LoginError> {
        let client = &reqwest::Client::new();

        match login.inner.clone() {
            Login::RefreshToken { msa_refresh } => Self::login_refresh(client, &msa_refresh, login)
                .await
                .map_err(LoginError::AuthError),

            Login::MojangToken { token } => Self::login_token(client, token, login)
                .await
                .map_err(LoginError::GetProfileError),

            Login::NoToken => Ok(Self::login_cracked(login)),
        }
    }

    async fn login_token(
        client: &Client,
        token: Arc<str>,
        login: LoginHandle,
    ) -> Result<Self, GetProfileError> {
        azalea_auth::get_profile(client, &token)
            .await
            .map(|profile| TokenAccount {
                username: profile.name,
                uuid: profile.id,
                token: Some(Mutex::new((*token).into())),
                login,
            })
    }

    async fn login_refresh(
        client: &Client,
        msa: &str,
        login: LoginHandle,
    ) -> Result<Self, AuthError> {
        match azalea_auth::get_minecraft_token(client, &msa).await {
            Ok(MinecraftTokenResponse {
                minecraft_access_token: token,
                ..
            }) => Self::login_token(client, token.into(), login)
                .await
                .map_err(AuthError::GetMinecraftProfile),

            Err(err) => Err(err.into()),
        }
    }

    fn login_cracked(login: LoginHandle) -> Self {
        TokenAccount {
            login,
            token: None,
            username: Alphanumeric.sample_string(&mut rand::rng(), 10),
            uuid: Uuid::new_v4(),
        }
    }
}
