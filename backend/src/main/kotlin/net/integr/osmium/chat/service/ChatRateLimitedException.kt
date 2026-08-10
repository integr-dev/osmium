package net.integr.osmium.chat.service

/**
 * Thrown when an agent has been made to speak too often.
 *
 * Separate from the other command failures because the cause is different in kind: the request is
 * valid, the host is reachable, and it is still refused - on the agent's behalf rather than the
 * operator's. Maps to 429.
 */
class ChatRateLimitedException(agentLabel: String, perMinute: Int) :
    RuntimeException("'$agentLabel' has hit its limit of $perMinute messages a minute")
