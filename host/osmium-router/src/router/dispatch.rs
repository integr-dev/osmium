use std::collections::{HashMap, VecDeque};

use log::{error, warn};
use osmium_agent::bot::bot;
use osmium_common::{
    message::{
        BotResponse, BotResponseParameters, CommandMessage, CommandResultMessage,
        SetupAgentResponse, WsMessage,
    },
    token::store::{LoginHandle, TokenStorage},
};
use tokio::sync::mpsc::{self, Receiver, Sender};

struct BotState {
    pub(super) label: String,
    pub(super) channel: Sender<CommandMessage>,
    pub(super) response_ids: VecDeque<String>,
}

/// handles/routes messages, spawns swarms
/// rx - receiver from socket, tx - sender to socket
pub async fn dispatch(
    mut token_store: TokenStorage,
    mut rx: Receiver<WsMessage>,
    tx: Sender<WsMessage>,
) {
    let mut bots = HashMap::<u32, BotState>::new();
    let (bot_tx, mut bot_rx) = mpsc::channel::<BotResponse>(100);

    loop {
        tokio::select! {
            message = rx.recv() => {
                let Some(message) = message else {
                    error!("Channel closed unexpectedly");
                    return;
                };

                handle_socket_message(message, &mut bots, &bot_tx, &tx, &mut token_store).await;
            }

            message = bot_rx.recv() => {
                let Some(message) = message else {
                    error!("Channel closed unexpectedly");
                    return;
                };

                handle_bot_message(message, &tx, &mut bots).await;
            }
        }
    }
}

async fn handle_socket_message(
    message: WsMessage,
    bots: &mut HashMap<u32, BotState>,
    bot_tx: &Sender<BotResponse>,
    dispatch_tx: &Sender<WsMessage>,
    store: &mut TokenStorage,
) {
    let WsMessage::Command {
        id,
        agent_id,
        message,
    } = message
    else {
        warn!("Ignoring invalid message");
        return;
    };

    match message {
        CommandMessage::SetupAgent {
            label,
            address,
            method,
        } => {
            let handle = match store.get_login(method, address) {
                Some(handle) => handle,
                None => {
                    let _ = dispatch_tx.send(WsMessage::Result {
                        id,
                        agent_id,
                        message: CommandResultMessage::SetupAgent(SetupAgentResponse::Fail {
                            reason: "No accounts available",
                        }),
                    });

                    return;
                }
            };

            let mut bot = spawn_swarm(agent_id, label, bot_tx.clone(), handle).await;

            bot.response_ids.push_back(id);
            bots.insert(agent_id, bot);
        }

        msg => {
            let Some(bot) = bots.get(&agent_id) else {
                warn!("Ignoring message to unknown bot {agent_id}");
                return;
            };

            if let Err(_) = bot.channel.send(msg).await {
                warn!("Dead bot channel!!")
            };
        }
    }
}

async fn handle_bot_message(
    message: BotResponse,
    tx: &Sender<WsMessage>,
    bots: &mut HashMap<u32, BotState>,
) {
    let BotResponse { bot_id, parameters } = message;

    let _ = tx.send(match parameters {
        BotResponseParameters::Command(command_result_message) => {
            let Some(bot) = bots.get_mut(&bot_id) else {
                warn!("Ignoring response from unknown bot");
                return;
            };

            let Some(id) = bot.response_ids.pop_front() else {
                warn!("Ignoring response due to invalid state");
                return;
            };

            WsMessage::Result {
                id,
                agent_id: bot_id,
                message: command_result_message,
            }
        }

        BotResponseParameters::Event(event_message) => WsMessage::Event(event_message),
    });
}

async fn spawn_swarm(
    id: u32,
    label: String,
    dispatch_tx: Sender<BotResponse>,
    login: LoginHandle,
) -> BotState {
    let (tx, rx) = mpsc::channel::<CommandMessage>(100);
    tokio::spawn(bot(dispatch_tx, rx, login, id));

    BotState {
        label,
        channel: tx,
        response_ids: Default::default(),
    }
}
