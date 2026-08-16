use crate::game::{chat::ChatScope, player::Player};
use uuid::Uuid;

use crate::token::login::{LoginKind, LoginState};

pub enum WsMessage {
    Command {
        id: String,
        agent_id: u32,
        message: CommandMessage,
    },

    Result {
        id: String,
        agent_id: u32,
        message: CommandResultMessage,
    },

    Event(EventMessage),
}

#[derive(Clone, Debug)]
pub enum CommandMessage {
    SetupAgent {
        label: String,
        address: String,
        method: LoginKind,
    },

    Connect(String),
    Disconnect,

    Chat(String),
    SetChatListener(bool),
}

pub enum CommandResultMessage {
    SetupAgent(SetupAgentResponse),
}

pub enum EventMessage {
    Heartbeat {
        version: &'static str,
    },

    AgentStatus {
        agent_id: u32,
        state: Option<LoginState>,
        dimension: Option<String>,
        nearby: Option<Vec<Player>>,

        health: u16,
        food: u16,
        ping: u16,
        position: (f64, f64, f64),
    },

    Chat {
        agent_id: u32,
        scope: ChatScope,
        from: Option<String>,
        content: String,
    },

    Activity {
        /// true - system, false - lifecycle
        scope: bool,
        /// 0 - info .. 2 - error
        severity: u8,
        content: String,
    },
}

pub enum SetupAgentResponse {
    Success { username: String, uuid: Uuid },
    Fail { reason: &'static str },
}

pub struct BotResponse {
    pub bot_id: u32,
    pub parameters: BotResponseParameters,
}

pub enum BotResponseParameters {
    Command(CommandResultMessage),
    Event(EventMessage),
}
