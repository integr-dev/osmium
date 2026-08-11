use std::env;

use crate::socket::spawn::spawn_ws_client;

pub mod socket;

#[tokio::main]
async fn main() {
    let agent_token = env::var("OSMIUM_AGENT_TOKEN").expect("set env OSMIUM_AGENT_TOKEN");
    let agent_ws = env::var("OSMIUM_WS_URL").expect("set env OSMIUM_WS_URL");
    let token_file = env::args().next().unwrap_or("/agent/tokens".into());

    tokio::spawn(spawn_ws_client(agent_ws, agent_token));
}
