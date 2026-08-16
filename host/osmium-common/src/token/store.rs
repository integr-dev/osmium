use std::{
    collections::{HashMap, HashSet},
    fs,
    sync::{Arc, Mutex},
};

use super::login::{Login, LoginKind};
use azalea_client::account::Account;

use crate::{
    error::{LoginError, RouterError},
    token::account::TokenAccountExt,
};

#[derive(Debug)]
pub struct TokenStorage {
    tokens: Vec<Login>,
    taken: HashMap<String, Arc<Mutex<HashSet<Login>>>>,
}

impl TokenStorage {
    pub fn read(path: &str) -> Result<Self, RouterError> {
        let file = fs::read(path).map_err(RouterError::AccountReadError)?;
        let tokens = serde_json::from_slice(&file).map_err(RouterError::AccountParseError)?;

        Ok(Self::new(tokens))
    }

    fn new(tokens: Vec<Login>) -> Self {
        Self {
            tokens,
            taken: Default::default(),
        }
    }

    /// Returns a handle to a login that can be used for the given network, or `None` if there are no logins available. Sets the returned login as unavailable for the given network for future calls. Marked as available again whenever the returned handle is dropped.
    pub fn get_login(&mut self, method: LoginKind, network: String) -> Option<LoginHandle> {
        let taken_rc = self.taken.entry(network).or_default();

        let login = {
            let mut taken = match taken_rc.lock() {
                Ok(v) => v,
                Err(e) => e.into_inner(),
            };

            let login = self
                .tokens
                .iter()
                .filter(|l| l.kind() == method && !taken.contains(l))
                .next()
                .map(|l| l.clone());

            let Some(login) = login else {
                return None;
            };

            taken.insert(login.clone());
            login
        };

        Some(LoginHandle::new(taken_rc.clone(), login))
    }
}

#[derive(Debug)]
pub struct LoginHandle {
    pub(super) owner: Arc<Mutex<HashSet<Login>>>,
    pub(super) inner: Login,
}

impl LoginHandle {
    pub fn new(owner: Arc<Mutex<HashSet<Login>>>, inner: Login) -> Self {
        Self { owner, inner }
    }

    pub async fn try_into_account(self) -> Result<Account, LoginError> {
        Account::login(self).await
    }
}

impl Drop for LoginHandle {
    fn drop(&mut self) {
        let mut owner = match self.owner.lock() {
            Ok(v) => v,
            Err(e) => e.into_inner(),
        };

        owner.remove(&self.inner);
    }
}

#[cfg(test)]
mod test {
    use crate::token::{
        login::{Login, LoginKind},
        store::TokenStorage,
    };

    #[test]
    fn borrow_mechanics() {
        let tokens = vec![
            Login::RefreshToken {
                msa_refresh: "a".into(),
            },
            Login::MojangToken { token: "a".into() },
        ];

        let mut store = TokenStorage::new(tokens);
        let token_a = store.get_login(LoginKind::RefreshToken, "test".to_string());
        let token_b = store.get_login(LoginKind::RefreshToken, "test".to_string());
        let token_c = store.get_login(LoginKind::MojangToken, "test".to_string());
        let token_d = store.get_login(LoginKind::RefreshToken, "test2".to_string());
        let token_e = store.get_login(LoginKind::MojangToken, "test2".to_string());

        assert!(token_a.is_some());
        assert!(token_b.is_none());
        assert!(token_c.is_some());
        assert!(token_d.is_some());
        assert!(token_e.is_some());

        drop(token_a);

        assert!(
            store
                .get_login(LoginKind::RefreshToken, "test".to_string())
                .is_some()
        );

        assert!(
            store
                .get_login(LoginKind::RefreshToken, "test2".to_string())
                .is_none()
        )
    }
}
