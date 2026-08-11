use osmium_agent::{chat::ChatScope, player::Player, state::LoginState};
use uuid::Uuid;

use crate::token::login::LoginKind;

pub enum Message {
    Command {
        id: String,
        agent_id: u32,
        message: CommandMessage,
    },

    Result {
        id: String,
        agent_id: u32,
        message: CommandResponseMessage,
    },

    Event(EventMessage),
}

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

pub enum CommandResponseMessage {
    SetupAgent(SetupAgentResponse),
}

pub enum EventMessage {
    Heartbeat {
        version: &'static str,
    },

    AgentStatus {
        state: Option<LoginState>,
        dimension: Option<String>,
        nearby: Option<Vec<Player>>,

        health: u16,
        food: u16,
        ping: u16,
        position: (f64, f64, f64),
    },

    Chat {
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
