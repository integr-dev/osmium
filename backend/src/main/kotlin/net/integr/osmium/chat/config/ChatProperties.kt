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
 *   holding `chat.speak`: it can speak, but it cannot spam — and chat spam is the one consequence
 *   here that is permanent and unrecoverable.
 *
 * @param spamThreshold how many repeats it takes before a player's repetition stops being recorded.
 *   **Zero disables the filter** and every line is stored as it arrives. Four by default: on real
 *   traffic the difference between three and six is a couple of hundred rows either way, and four
 *   leaves room for somebody saying a thing twice while making a point.
 *
 * @param spamSimilarity how alike two lines must be to count as a repeat, as Jaccard overlap of
 *   character trigrams. 0.8 is deliberately strict. Measured from 0.6 to 0.9 over a week of real
 *   chat the yield moves by 3%, which says what is actually caught is near-identical repetition — so
 *   the strict end costs nothing and leaves less room to catch a conversation by accident.
 *
 * @param spamPrefix how much of two lines has to be an identical opening for them to count as a
 *   repeat, whatever the rest of them looks like. Half. This is the rule that catches a macro: the
 *   template is constant and only a random tail moves, which leaves the trigram overlap around 0.2
 *   to 0.3 — indistinguishable from two unrelated sentences, and far under [spamSimilarity].
 *   **Zero disables it**, leaving the overlap as the only test.
 *
 * @param spamPrefixChars how many leading characters must match before that ratio is even consulted.
 *   Sixteen. The ratio alone would call "yes i think so" and "yes i think not" a repeat, which is
 *   two people talking; sixteen identical characters is a template rather than a turn of phrase.
 *   Measured on real chat, adding this dropped the catch from 654 lines to 486 and every one of the
 *   168 it gave back was ordinary conversation.
 *
 * @param spamWindow how many of a player's recent lines a new one is compared against. Six. One is
 *   not enough: alternating between two messages defeats it, and that is a thing people do.
 *
 * @param spamMinLength the shortest line that is scored at all. Seven characters. Below it sit `gg`,
 *   `lol` and `yea` — near-identical to each other by any measure, most of what conversation is made
 *   of, worth nothing to store, and not worth silencing somebody over.
 *
 * @param spamCooldown how long it takes to shed one point of a player's count. Continuous rather
 *   than a window that resets, for the reason [messagesPerMinute] gives. A minute per point means
 *   somebody held at the cap is recorded again a few minutes after they stop.
 *
 * @param spamSpeakers how many speakers are tracked before the least recently heard is forgotten. A
 *   stranger on a public server has no deletion to hang a cleanup off, so this bound is the only
 *   thing keeping the map finite. Each entry is a counter and a handful of small trigram sets.
 */
@ConfigurationProperties(prefix = "osmium.chat")
data class ChatProperties(
    val retention: Duration = Duration.ofDays(3),
    val messagesPerMinute: Int = 30,
    val spamThreshold: Int = 4,
    val spamSimilarity: Double = 0.8,
    val spamPrefix: Double = 0.5,
    val spamPrefixChars: Int = 16,
    val spamWindow: Int = 6,
    val spamMinLength: Int = 7,
    val spamCooldown: Duration = Duration.ofMinutes(1),
    val spamSpeakers: Int = 2_000,
) {
    init {
        require(!retention.isNegative && !retention.isZero) {
            "osmium.chat.retention must be positive; the purge would otherwise delete every message"
        }
        require(messagesPerMinute > 0) {
            "osmium.chat.messages-per-minute must be positive; zero would silence the whole fleet"
        }
        require(spamThreshold >= 0) {
            "osmium.chat.spam-threshold cannot be negative; zero disables the spam filter"
        }
        require(spamSimilarity > 0.0 && spamSimilarity <= 1.0) {
            "osmium.chat.spam-similarity must be over 0 and at most 1; zero would call every line a repeat"
        }
        require(spamPrefix >= 0.0 && spamPrefix <= 1.0) {
            "osmium.chat.spam-prefix must be between 0 and 1; zero drops the shared-opening test"
        }
        require(spamPrefixChars > 0) {
            "osmium.chat.spam-prefix-chars must be positive; zero would compare empty openings"
        }
        require(spamWindow > 0) {
            "osmium.chat.spam-window must be positive; with nothing remembered nothing can repeat"
        }
        require(spamMinLength > 0) {
            "osmium.chat.spam-min-length must be positive; zero would score an empty line"
        }
        require(!spamCooldown.isNegative && !spamCooldown.isZero) {
            "osmium.chat.spam-cooldown must be positive; zero would never let a count come back down"
        }
        require(spamSpeakers > 0) {
            "osmium.chat.spam-speakers must be positive; zero would forget every speaker immediately"
        }
    }
}
