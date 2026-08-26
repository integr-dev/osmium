use crate::message::{CommandResponseMessage, EventMessage, SetupAgentResponse};

use super::message::WsMessage;
use json::{JsonValue, object};

pub fn serialize(message: WsMessage) -> String {
    let json = match message {
        WsMessage::Command { .. } => panic!("serializing inbound message"),

        WsMessage::Result {
            id,
            agent_id,
            message,
        } => object! {
            id: id,
            kind: "result",
            "type": message.name(),
            agent_id: agent_id,
            ok: message.is_ok(),
            payload: serialize_command_response(message),
        },

        WsMessage::Event(event_message) => object! {},
    };

    println!("{}", &json);

    return json.to_string();
}

fn serialize_command_response(message: CommandResponseMessage) -> JsonValue {
    match message {
        CommandResponseMessage::SetupAgent(setup_agent_response) => match setup_agent_response {
            SetupAgentResponse::Success { username, uuid } => {
                object! {
                    mcUsername: username,
                    mcUuid: uuid.to_string()
                }
            }

            SetupAgentResponse::Fail { reason } => {
                object! {
                    reason: reason
                }
            }
        },
    }
}

fn serialize_event_message(message: EventMessage) -> JsonValue {
    match message {
        EventMessage::Heartbeat { version } => object! {
            kind: "event",
            "type": "heartbeat",
            version: version,
        },

        EventMessage::AgentStatus {
            state,
            dimension,
            nearby,
            health,
            food,
            ping,
            position,
            agent_id,
        } => object! {
            kind: "event",
            "type": "agent_status",
            agentId: agent_id,
            payload: {
                state: state.map(|s| format!("{s:?}").to_ascii_uppercase()),
                health: health,
                food: food,
                pingMs: ping,
                dimension: dimension,
                position: position,
                nearby: nearby.map(|v| v.iter().map(|p| object! {
                    name: p.name.as_str(),
                    distance: p.distance,
                    position: p.position
                }).collect::<Vec<_>>())
            }
        },

        EventMessage::Chat {
            scope,
            from,
            content,
        } => todo!(),
        EventMessage::Activity {
            scope,
            severity,
            content,
        } => todo!(),
    }
}

#[cfg(test)]
mod test {
    use uuid::Uuid;

    use crate::{
        message::{CommandResponseMessage, SetupAgentResponse, WsMessage},
        serde::serialize,
    };

    #[test]
    fn test() {
        let result = serialize(WsMessage::Result {
            id: "command-id".into(),
            agent_id: 67,
            message: CommandResponseMessage::SetupAgent(SetupAgentResponse::Success {
                username: "MeowBot1".into(),
                uuid: Uuid::new_v4(),
            }),
        });

        dbg!(result);
    }
}

// pub fn deserialize(message: String) -> Option<String> {}
