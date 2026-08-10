package net.integr.osmium.chat.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

/**
 * @param retention how long a chat line is kept. 3 days by default — the shortest of the three
 *   streams. This is the largest by volume and the only one full of other people's words, so the
 *   window is what keeps Osmium a short-lived store of third-party conversation rather than an
 *   archive of one. See FLEET_CONNECTIVITY.md.
 */
@ConfigurationProperties(prefix = "osmium.chat")
data class ChatProperties(
    val retention: Duration = Duration.ofDays(3),
) {
    init {
        require(!retention.isNegative && !retention.isZero) {
            "osmium.chat.retention must be positive; the purge would otherwise delete every message"
        }
    }
}
