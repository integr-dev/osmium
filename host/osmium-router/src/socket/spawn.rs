use tokio_tungstenite::tungstenite::client::IntoClientRequest;

pub async fn spawn_ws_client(addr: String, token: String) {
    let mut request = addr.into_client_request().expect("Invalid backend address");

    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .expect("Invalid token format"),
    );

    let (stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("Failed to locate backend");

    println!("connected :3")
}
