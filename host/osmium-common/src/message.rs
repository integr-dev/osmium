use crate::game::{chat::ChatScope, player::Player, vec3::Vec3};
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
        message: CommandResponseMessage,
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

pub enum CommandResponseMessage {
    SetupAgent(SetupAgentResponse),
}

impl CommandResponseMessage {
    pub fn name(&self) -> &'static str {
        match self {
            CommandResponseMessage::SetupAgent(_) => "setup_agent",
        }
    }

    pub fn is_ok(&self) -> bool {
        match self {
            CommandResponseMessage::SetupAgent(r) => r.is_ok(),
        }
    }
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
        position: Vec3,
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

impl SetupAgentResponse {
    pub fn is_ok(&self) -> bool {
        match self {
            Self::Success { .. } => true,
            Self::Fail { .. } => false,
        }
    }
}

pub struct BotResponse {
    pub bot_id: u32,
    pub parameters: BotResponseParameters,
}

pub enum BotResponseParameters {
    Command(CommandResponseMessage),
    Event(EventMessage),
}
