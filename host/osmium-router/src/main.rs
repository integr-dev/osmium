use std::env;

use azalea_client::account::Account;

use crate::token::account::TokenAccountExt;

pub mod token;

fn main() {
    let agent_token = env::var("OSMIUM_AGENT_TOKEN").expect("set env OSMIUM_AGENT_TOKEN");
    let agent_ws = env::var("OSMIUM_WS_URL").expect("set env OSMIUM_WS_URL");
    let token_file = env::args().next().unwrap_or("/agent/tokens".into());
}
