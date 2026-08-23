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
 */
@ConfigurationProperties(prefix = "osmium.agent")
data class AgentProperties(
    val connectWindow: Duration = Duration.ofSeconds(90),
) {
    init {
        require(!connectWindow.isNegative) {
            "osmium.agent.connect-window must not be negative; a connect cannot expire before it is sent"
        }
    }
}
