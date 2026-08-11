use tokio::{net::TcpStream, sync::mpsc::Sender};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::client::IntoClientRequest};

use super::message::Message;

/// connects a websocket client to the given address and handles incoming messages
/// tx - channel to dispatch
pub async fn ws_client(addr: String, token: String, tx: Sender<Message>) {
    let stream = spawn(addr, token).await;
}

async fn spawn(addr: String, token: String) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
    let mut request = addr
        .clone()
        .into_client_request()
        .expect("Invalid backend address");

    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .expect("Invalid token format"),
    );

    let (stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect(&format!("Failed to locate backend at {addr}"));

    stream
}
