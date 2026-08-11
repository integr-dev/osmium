use tokio::sync::mpsc::Receiver;

use crate::socket::message::Message;

/// handles/routes messages, spawns swarms
/// rx - receiver from socket
pub async fn dispatch(token_file: &str, rx: Receiver<Message>) {}
