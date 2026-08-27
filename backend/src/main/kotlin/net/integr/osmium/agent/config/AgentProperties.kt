package net.integr.osmium.agent.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

/**
 * @param connectWindow how long a host gets to report the outcome of a `connect` before the agent
 *   stops claiming to be connecting and falls back to LINKED. 90 seconds by default, which is
 *   generous on purpose: joining a Minecraft server means a session handshake, an authentication
 *   round trip and a world load, and a busy server queues the lot. This is the point at which
 *   nothing is coming, not the point at which it is taking a while.
 *
 *   Configurable mainly so the sweep can be tested without waiting out the real window. See
 *   `AgentService.abandonStalledConnects`.
 * @param rejoinDelay how long to wait before the first automatic reconnect, doubling with every
 *   attempt up to [rejoinDelayMax]. Fifteen seconds by default: long enough that a server which is
 *   restarting is not dialled while it is still coming up, short enough that a one-off kick costs
 *   the fleet almost nothing.
 * @param rejoinDelayMax the longest that backoff grows to. Five minutes, which is the rate at which
 *   a fleet waits out an outage rather than participating in one.
 * @param rejoinAttempts how many automatic reconnects to try before giving up and leaving the agent
 *   where it is. Ten, which with the defaults above is a little over half an hour of trying.
 *
 *   Bounded on purpose. An agent that cannot join *this* server will not be fixed by a thousand more
 *   attempts, and retrying forever would write a failure into the activity feed every five minutes
 *   until somebody noticed. Giving up says so once, in the feed, and leaves the Connect button to
 *   whoever comes back.
 *
 *   All three exist mainly so the sweep can be tested in seconds rather than in half-hours. See
 *   `AgentService.rejoinTheWilling`.
 */
@ConfigurationProperties(prefix = "osmium.agent")
data class AgentProperties(
    val connectWindow: Duration = Duration.ofSeconds(90),
    val rejoinDelay: Duration = Duration.ofSeconds(15),
    val rejoinDelayMax: Duration = Duration.ofMinutes(5),
    val rejoinAttempts: Int = 10,
) {
    init {
        require(!connectWindow.isNegative) {
            "osmium.agent.connect-window must not be negative; a connect cannot expire before it is sent"
        }
        require(!rejoinDelay.isNegative && !rejoinDelay.isZero) {
            "osmium.agent.rejoin-delay must be positive; a reconnect with no delay is a busy loop"
        }
        require(rejoinDelayMax >= rejoinDelay) {
            "osmium.agent.rejoin-delay-max must not be shorter than osmium.agent.rejoin-delay"
        }
        require(rejoinAttempts > 0) {
            "osmium.agent.rejoin-attempts must be positive; turn connect.rejoin off to stop rejoining"
        }
    }
}
