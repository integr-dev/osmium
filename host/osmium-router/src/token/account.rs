use async_trait::async_trait;
use azalea_auth::{
    GetProfileError,
    sessionserver::{self, ClientSessionServerError, SessionServerJoinOpts},
};
use azalea_client::account::{Account, AccountTrait};
use uuid::Uuid;

type BoxFuture<'a, T> = core::pin::Pin<Box<dyn Future<Output = T> + 'a + Send>>;

#[derive(Debug)]
pub struct TokenAccount {
    token: &'static str,
    username: String,
    uuid: Uuid,
}

#[async_trait]
pub trait TokenAccountExt: Sized {
    async fn token(token: &'static str) -> Result<Self, GetProfileError>;
}

impl AccountTrait for TokenAccount {
    fn username(&self) -> &str {
        &self.username
    }

    fn uuid(&self) -> Uuid {
        self.uuid
    }

    fn access_token(&self) -> Option<String> {
        Some(self.token.into())
    }

    fn refresh(&self) -> BoxFuture<'_, Result<(), azalea_auth::AuthError>> {
        Box::pin(async { Ok(()) })
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
        Box::pin(async move {
            let opts = SessionServerJoinOpts {
                access_token: self.token,
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
    async fn token(token: &'static str) -> Result<Self, GetProfileError> {
        let client = &reqwest::Client::new();

        azalea_auth::get_profile(client, token)
            .await
            .map(|profile| {
                TokenAccount {
                    username: profile.name,
                    uuid: profile.id,
                    token,
                }
                .into()
            })
    }
}
