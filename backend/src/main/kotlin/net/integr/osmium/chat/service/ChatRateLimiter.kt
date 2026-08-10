package net.integr.osmium.chat.service

import net.integr.osmium.chat.config.ChatProperties
import org.springframework.stereotype.Component
import java.time.Clock
import java.util.concurrent.ConcurrentHashMap

/**
 * Caps how often an agent can be made to speak.
 *
 * **Per agent, not per operator.** The consequence being avoided is a Minecraft ban, which lands on
 * the account rather than on whoever triggered it — so two operators sharing one agent share its
 * budget, and an operator driving ten agents is not throttled across all of them. It is also the
 * check that contains a stolen session holding `fleet.chat`: it can still speak, but not spam.
 *
 * A token bucket rather than a count per calendar minute. A fixed window lets an operator send the
 * whole allowance at 11:59:59 and the whole allowance again a second later, which is exactly the
 * burst that gets an account banned; a bucket refills continuously, so the sustained rate is the
 * limit no matter where the messages fall.
 *
 * In memory and per instance. With several backend instances a fleet could exceed the limit by the
 * number of instances — the same single-instance assumption the event broker already carries. A
 * restart forgives whatever was spent, which is the right way round: the failure mode is being
 * briefly too lenient, never locking an operator out of a fleet they need to control.
 */
@Component
class ChatRateLimiter(
    private val chatProperties: ChatProperties,
    private val clock: Clock = Clock.systemUTC(),
) {
    private val buckets = ConcurrentHashMap<Long, Bucket>()

    /**
     * Spends one message's worth of budget, or throws.
     *
     * Checked before the command is dispatched, so a refused message never reaches Minecraft and —
     * because the audit entry is written in the same transaction — leaves no trace of having been
     * said. Nothing happened, so there is nothing to record.
     */
    fun check(agentId: Long, agentLabel: String) {
        val limit = chatProperties.messagesPerMinute
        val bucket = buckets.computeIfAbsent(agentId) { Bucket(limit.toDouble(), clock.millis()) }

        val allowed = synchronized(bucket) { bucket.tryConsume(limit, clock.millis()) }
        if (!allowed) throw ChatRateLimitedException(agentLabel, limit)
    }

    /**
     * Gives back a message's worth of budget, for one that turned out not to be deliverable.
     *
     * The bucket is in memory rather than in the transaction, so a rollback does not undo a spend.
     * Without this, an operator retrying against a disconnected host would spend their whole
     * allowance on messages nobody ever saw.
     */
    fun refund(agentId: Long) {
        val bucket = buckets[agentId] ?: return
        synchronized(bucket) {
            bucket.tokens = (bucket.tokens + 1.0).coerceAtMost(chatProperties.messagesPerMinute.toDouble())
        }
    }

    /** Drops an agent's budget. Called when the agent is deleted, so the map cannot grow forever. */
    fun forget(agentId: Long) {
        buckets.remove(agentId)
    }

    private class Bucket(var tokens: Double, var lastRefillMillis: Long) {

        fun tryConsume(limit: Int, now: Long): Boolean {
            // Refill first, so a bucket that has been idle is full by the time it is read.
            val elapsed = (now - lastRefillMillis).coerceAtLeast(0)
            lastRefillMillis = now
            tokens = (tokens + elapsed * limit / MILLIS_PER_MINUTE).coerceAtMost(limit.toDouble())

            if (tokens < 1.0) return false
            tokens -= 1.0
            return true
        }

        companion object {
            const val MILLIS_PER_MINUTE = 60_000.0
        }
    }
}
