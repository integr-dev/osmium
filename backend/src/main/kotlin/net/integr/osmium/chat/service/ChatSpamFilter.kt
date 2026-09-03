package net.integr.osmium.chat.service

import net.integr.osmium.chat.config.ChatProperties
import net.integr.osmium.chat.model.ChatMessage
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.time.Clock

/**
 * Refuses a line from somebody who keeps saying the same thing.
 *
 * **Storage is what this protects.** Global chat is 98% of the table by volume and the whole of it
 * is other people's words; one player looping `/dupe` at a macro's pace writes thousands of rows
 * that say one thing. This runs before [ChatService.record], so a refused line is never stored -
 * which is the whole point, and would also make it invisible. So the refusals are counted, and a run
 * of them is published as one [Verdict.Drop] for the interface to draw in place of the gap. The
 * count is what is published; the words are not, because storing them is what was being avoided.
 *
 * **Nothing here reaches the game.** Commands are dispatched host-side, in `bot.ts`, before a line
 * is ever reported, so an agent still answers somebody it has stopped recording. This decides what
 * is kept, not what is heard.
 *
 * ### What is compared
 *
 * The **typed** text, which the host sends alongside the rendered line. On a server that renders
 * ranks the decoration is constant per player and most of a short line - 22 of an average 36
 * characters, measured - so two unrelated messages from one player already look alike before
 * anybody has repeated anything. Only the host can strip it: the pattern that says where the prefix
 * ends is `chat.sender`, which is that host's configuration, and the separator differs from server
 * to server.
 *
 * A line the host could not split is left alone. That is exactly the set of lines it could not name
 * a speaker for either - the same pattern decides both - so there is nobody to hold responsible and
 * nothing to compare against.
 *
 * ### How likeness is decided
 *
 * Two tests, and either one is enough.
 *
 * **Overlap**, as Jaccard of character trigrams: exact rather than a sketch, because a chat line is
 * tens of characters and the sets are small enough that hashing them would only add collisions.
 * Digits collapse to one placeholder first, so `/dupe 444` and `/dupe 4444444` are one message.
 *
 * **A shared opening**, because overlap alone does not survive a macro. Sixteen random letters on the
 * end of a constant template - `/dupe BOMBOCLAAT eMbhGOjrPAYhTIK`, then `lWpvwVXOrlvbaPJ`, then
 * fifty more - measures 0.33 against its own predecessor, and `/dupe` repeated six times before a
 * random tail measures 0.17, because the repetition collapses into a handful of distinct trigrams
 * while the tail contributes fifteen fresh ones each time. Both are under any overlap threshold that
 * does not also catch strangers, and both are unmistakable by their first half. So a run of identical
 * leading characters counts too, subject to a floor on how many: the ratio alone would call "yes i
 * think so" and "yes i think not" a repeat.
 *
 * ### The counter
 *
 * A repeat adds a point; time takes points back continuously, one per [ChatProperties.spamCooldown].
 * Continuous rather than a window that resets, for the reason [ChatRateLimiter] gives: a fixed
 * window forgives everything at once, and the burst either side of that boundary is exactly the
 * behaviour being caught.
 *
 * Suppressed lines still score, so somebody who keeps going stays suppressed. The counter stops at
 * twice the threshold so that recovery, once they stop, is bounded rather than open-ended.
 *
 * Muting and releasing use different levels - [ChatProperties.spamThreshold], and half of it. A
 * single level flaps: somebody sitting exactly on it gets one line through, is muted, gets one
 * through.
 *
 * ### What it deliberately will not do
 *
 * **It gags the repetition, not the player.** Once muted, only lines that are themselves alike are
 * dropped; something new lands as usual. Somebody arguing in chat sends a great many messages
 * quickly and repeats themselves several times in the middle of it, and muting the whole
 * conversation for that - 48 lines of ordinary talk, on one evening of real data - is a worse feed
 * than the spam was.
 *
 * **Short lines are never scored.** `lol`, `gg`, `yea`. They are near-identical to each other by any
 * metric, they are what conversation is mostly made of, and scoring them mutes the friendliest
 * people on the server.
 *
 * ### In memory, per instance
 *
 * Like [ChatRateLimiter], and with the same consequences: several instances mean several counters,
 * and a restart forgives whatever was scored. The failure mode is being briefly too lenient, which
 * costs some rows and nothing else.
 *
 * Unlike an agent, a stranger on a public server has no deletion to hang a cleanup off, so the map
 * is bounded rather than swept: the least recently heard speaker falls out past
 * [ChatProperties.spamSpeakers]. A spam defence that grows without limit is the thing it exists to
 * prevent.
 */
@Component
class ChatSpamFilter(
    private val chatProperties: ChatProperties,
    private val clock: Clock = Clock.systemUTC(),
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /**
     * How many lines have been dropped in a row on each server, for the row the interface draws in
     * place of them.
     *
     * Keyed by server rather than by speaker, and so bounded by the fleet's own configuration -
     * every address here came from an agent an operator created. Unlike [speakers], which is keyed
     * by whoever happens to walk past, there is nothing here to evict.
     */
    private val runs = HashMap<String, Int>()

    /**
     * Access-ordered, so eviction drops whoever has been quiet longest rather than whoever arrived
     * first - a server's regulars would otherwise be forgotten in favour of everybody passing
     * through.
     */
    private val speakers = object : LinkedHashMap<String, Speaker>(INITIAL_SPEAKERS, LOAD_FACTOR, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Speaker>): Boolean =
            size > chatProperties.spamSpeakers
    }

    /**
     * Whether this line is worth storing, and if not, how many have now gone in a row.
     *
     * [typed] is what the speaker typed with the server's decoration taken off, or null when the
     * host could not tell where that decoration ended.
     */
    fun judge(serverAddress: String, sender: String, typed: String?): Verdict {
        val keep = keeps(serverAddress, sender, typed)

        // The run belongs to the **feed**, not to the speaker: it stands for one gap in one server's
        // transcript, and a gap is closed by the next line anybody there manages to get through -
        // whoever said it. That is what makes it renderable as a single row in the conversation.
        synchronized(runs) {
            if (keep) {
                runs.remove(serverAddress)
                return Verdict.Keep
            }

            val run = (runs[serverAddress] ?: 0) + 1
            runs[serverAddress] = run
            return Verdict.Drop(run)
        }
    }

    /**
     * What happens to one line, before the run is counted.
     *
     * Every early return here is a line that **is** kept, which is what closes an open run - a
     * server message, a line too short to score, one from somebody nobody can name. They are not
     * exempt from ending a gap just because they are exempt from causing one.
     */
    private fun keeps(serverAddress: String, sender: String, typed: String?): Boolean {
        if (chatProperties.spamThreshold <= 0) return true

        // Nobody to hold responsible. `typed` is absent for precisely the lines whose sender pattern
        // did not match, which are the lines already attributed to the server; the second check
        // covers the one case the two come apart, a pattern that matches but captures something that
        // is not a username.
        if (typed == null || sender.equals(UNATTRIBUTED, ignoreCase = true)) return true

        val line = normalise(typed)
        if (line.length < chatProperties.spamMinLength) return true

        val now = clock.millis()
        val key = "$serverAddress $sender".lowercase()

        // One lock over the whole map. Chat arrives at conversational rates, so there is nothing to
        // win by locking per speaker and a second map to keep correct if we did.
        synchronized(speakers) {
            val speaker = speakers.getOrPut(key) { Speaker(now) }
            val was = speaker.muted
            val allowed = speaker.consider(line, now, chatProperties)

            // Logged rather than left silent. A feed that quietly loses lines reads as broken, and
            // the operator has no other way to find out that it did not.
            if (speaker.muted != was) {
                if (speaker.muted) log.info("Dropping repeated chat from {} on {}", sender, serverAddress)
                else log.info("{} on {} stopped repeating itself, and is recorded again", sender, serverAddress)
            }

            return allowed
        }
    }

    /**
     * What to do with one line.
     *
     * A count rather than a flag, because the interface draws the gap as one row that grows -
     * "412 suppressed" - rather than as 412 rows saying nothing happened. It is never persisted:
     * the row exists to explain a hole in a live transcript, and once the transcript is re-fetched
     * there is no hole to explain.
     */
    sealed interface Verdict {
        /** Store it, and close any run that was open on this server. */
        data object Keep : Verdict

        /** Drop it. [run] counts this one, and every one dropped since the last line that landed. */
        data class Drop(val run: Int) : Verdict
    }

    /** A line as it is held for comparison: normalised, and its trigrams, computed once. */
    private class Said(val text: String, val shingles: Set<String>)

    /** One person on one server. Not thread-safe; every path into it holds the map's lock. */
    private class Speaker(private var lastMillis: Long) {
        private val recent = ArrayDeque<Said>()
        private var score = 0.0

        var muted = false
            private set

        /** Scores one line, and says whether to keep it. */
        fun consider(line: String, now: Long, properties: ChatProperties): Boolean {
            // Shed first, so somebody who has been quiet is judged on what they are saying now.
            val elapsed = (now - lastMillis).coerceAtLeast(0)
            lastMillis = now
            score = (score - elapsed / properties.spamCooldown.toMillis().toDouble()).coerceAtLeast(0.0)

            val print = Said(line, shingles(line))
            val repeat = recent.any { alike(print, it, properties) }
            if (repeat) score = (score + 1.0).coerceAtMost(properties.spamThreshold * CAP)

            // Remembered whether or not it is kept: a suppressed line is still something they said,
            // and forgetting it would let two messages sent alternately pass forever.
            recent.addLast(print)
            while (recent.size > properties.spamWindow) recent.removeFirst()

            muted = if (muted) score > properties.spamThreshold / RELEASE else score >= properties.spamThreshold

            return !(muted && repeat)
        }
    }

    private companion object {
        /**
         * What the host reports a line to when it cannot name a speaker: server messages, command
         * output, and every line whose `chat.sender` pattern is missing or wrong. Mirrors `SERVER`
         * in the host's `sender.ts`. It is a bucket rather than a person - every unattributable line
         * on a server lands in it - so scoring it would judge a whole server as one speaker.
         */
        const val UNATTRIBUTED = "server"

        /** Trigrams. Short enough that a five-character message still has something to compare. */
        const val SHINGLE = 3

        /** The counter stops at this multiple of the threshold, so recovery is bounded. */
        const val CAP = 2.0

        /** Released at the threshold over this, which is the gap that stops it flapping. */
        const val RELEASE = 2.0

        const val INITIAL_SPEAKERS = 64
        const val LOAD_FACTOR = 0.75f

        val DIGITS = Regex("\\d+")
        val SPACES = Regex("\\s+")

        /**
         * Case, spacing and digits carry no meaning here. Digits especially: a counter on the end is
         * the cheapest way to make the same message look new.
         *
         * Capped at the length a line is stored at, so a host sending something enormous costs a
         * bounded amount of work rather than an unbounded one.
         */
        fun normalise(typed: String): String =
            typed.take(ChatMessage.TEXT_MAX).lowercase().replace(DIGITS, "0").replace(SPACES, " ").trim()

        /** Either test is enough; see the class note on why one of them is not. */
        fun alike(said: Said, earlier: Said, properties: ChatProperties): Boolean =
            likeness(said.shingles, earlier.shingles) >= properties.spamSimilarity ||
                leads(said.text, earlier.text, properties)

        /**
         * Whether two lines open the same way for long enough to be one template.
         *
         * Against the longer of the two, so padding the end cannot dilute a shared opening into an
         * innocent-looking ratio.
         */
        fun leads(said: String, earlier: String, properties: ChatProperties): Boolean {
            if (properties.spamPrefix <= 0.0) return false

            var shared = 0
            while (shared < said.length && shared < earlier.length && said[shared] == earlier[shared]) shared += 1

            return shared >= properties.spamPrefixChars &&
                shared.toDouble() / maxOf(said.length, earlier.length) >= properties.spamPrefix
        }

        fun shingles(line: String): Set<String> =
            if (line.length <= SHINGLE) setOf(line)
            else (0..line.length - SHINGLE).mapTo(HashSet(line.length)) { line.substring(it, it + SHINGLE) }

        /** Jaccard: how much of everything either line holds is held by both. */
        fun likeness(a: Set<String>, b: Set<String>): Double {
            val shared = a.count(b::contains)
            return shared.toDouble() / (a.size + b.size - shared)
        }
    }
}
