use std::env;

use osmium_common::{error::RouterError, token::store::TokenStorage};
use tokio::sync::mpsc;

use crate::{router::dispatch::dispatch, socket::spawn::ws_client};

pub mod router;
pub mod socket;

#[tokio::main]
async fn main() -> Result<(), RouterError> {
    let agent_token = env::var("OSMIUM_AGENT_TOKEN").expect("set env OSMIUM_AGENT_TOKEN");
    let agent_ws = env::var("OSMIUM_WS_URL").expect("set env OSMIUM_WS_URL");
    let token_file = env::args().next().unwrap_or("/agent/tokens".into());

    let token_store = TokenStorage::read(&token_file)?;

    let (dispatch_tx, dispatch_rx) = mpsc::channel(25);
    let (sock_tx, sock_rx) = mpsc::channel(25);

    tokio::spawn(dispatch(token_store, dispatch_rx, sock_tx));
    ws_client(agent_ws, agent_token, dispatch_tx, sock_rx).await;

    Ok(())
}
