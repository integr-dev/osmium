pub enum LoginState {
    Online,
    FailedConnection,

    UnlinkedCredentials,
    LinkedCredentials,
    NeedLinkCredentials,
}
