use tokio::net::TcpStream;

pub async fn spawn_ws_client(addr: String, token: String) {
    let stream = TcpStream::connect(addr);
}
