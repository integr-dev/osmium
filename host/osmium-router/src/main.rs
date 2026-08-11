use std::env;

use tokio::sync::mpsc;

use crate::socket::spawn::ws_client;

pub mod router;
pub mod socket;
pub mod token;

#[tokio::main]
async fn main() {
    let agent_token = env::var("OSMIUM_AGENT_TOKEN").expect("set env OSMIUM_AGENT_TOKEN");
    let agent_ws = env::var("OSMIUM_WS_URL").expect("set env OSMIUM_WS_URL");
    let token_file = env::args().next().unwrap_or("/agent/tokens".into());

    let (tx, rx) = mpsc::channel(25);

    tokio::spawn(ws_client(agent_ws, agent_token, tx));

    loop {}
}
