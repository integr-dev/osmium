package net.integr.osmium.chat.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

/**
 * @param retention how long a chat line is kept. 3 days by default — the shortest of the three
 *   streams. This is the largest by volume and the only one full of other people's words, so the
 *   window is what keeps Osmium a short-lived store of third-party conversation rather than an
 *   archive of one. See FLEET_CONNECTIVITY.md.
 *
 * @param messagesPerMinute how often one agent can be made to speak. Enforced per agent rather than
 *   per operator, because a ban lands on the account. It is also what contains a stolen session
 *   holding `fleet.chat`: it can speak, but it cannot spam — and chat spam is the one consequence
 *   here that is permanent and unrecoverable.
 */
@ConfigurationProperties(prefix = "osmium.chat")
data class ChatProperties(
    val retention: Duration = Duration.ofDays(3),
    val messagesPerMinute: Int = 30,
) {
    init {
        require(!retention.isNegative && !retention.isZero) {
            "osmium.chat.retention must be positive; the purge would otherwise delete every message"
        }
        require(messagesPerMinute > 0) {
            "osmium.chat.messages-per-minute must be positive; zero would silence the whole fleet"
        }
    }
}
