use log::error;
use osmium_common::{
    message::{BotResponse, CommandMessage},
    token::store::LoginHandle,
};
use tokio::sync::mpsc::{Receiver, Sender};

pub async fn bot(
    tx: Sender<BotResponse>,
    mut rx: Receiver<CommandMessage>,
    login: LoginHandle,
    id: u32,
) {
    while let Some(msg) = rx.recv().await {
        println!("message to {id}: {msg:?}")
    }

    error!("unexpected bot exit")
}
