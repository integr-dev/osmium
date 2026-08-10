package net.integr.osmium.chat.service

import net.integr.osmium.chat.config.ChatProperties
import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Plain unit tests on a clock the test owns. Rate limiting is about the passage of time, and a
 * suite that waits for real seconds to pass is both slow and flaky.
 */
class ChatRateLimiterTest {

    private val start = Instant.parse("2026-08-10T12:00:00Z")

    /** A clock that only moves when the test says so. */
    private class TestClock(var now: Instant) : Clock() {
        override fun instant(): Instant = now
        override fun getZone() = ZoneOffset.UTC
        override fun withZone(zone: java.time.ZoneId): Clock = this
        fun advance(by: Duration) {
            now = now.plus(by)
        }
    }

    private fun limiter(perMinute: Int = 30): Pair<ChatRateLimiter, TestClock> {
        val clock = TestClock(start)
        return ChatRateLimiter(ChatProperties(messagesPerMinute = perMinute), clock) to clock
    }

    private fun ChatRateLimiter.say(agentId: Long = 1L) = check(agentId, "Mason_01")

    @Test
    fun `spends the whole allowance and then refuses`() {
        val (limiter, _) = limiter()

        repeat(30) { limiter.say() }

        assertFailsWith<ChatRateLimitedException> { limiter.say() }
    }

    /** The message the operator sees has to name the limit, or the refusal is unactionable. */
    @Test
    fun `the refusal names the agent and the limit`() {
        val (limiter, _) = limiter()
        repeat(30) { limiter.say() }

        val failure = assertFailsWith<ChatRateLimitedException> { limiter.say() }

        assertEquals("'Mason_01' has hit its limit of 30 messages a minute", failure.message)
    }

    /**
     * A bucket rather than a count per calendar minute: the allowance comes back continuously, so
     * waiting two seconds buys one message rather than nothing until the minute rolls over.
     */
    @Test
    fun `budget returns as time passes, not on a minute boundary`() {
        val (limiter, clock) = limiter()
        repeat(30) { limiter.say() }

        clock.advance(Duration.ofSeconds(2))
        limiter.say()

        assertFailsWith<ChatRateLimitedException> { limiter.say() }
    }

    @Test
    fun `a full minute of silence restores the whole allowance`() {
        val (limiter, clock) = limiter()
        repeat(30) { limiter.say() }

        clock.advance(Duration.ofMinutes(1))

        repeat(30) { limiter.say() }
        assertFailsWith<ChatRateLimitedException> { limiter.say() }
    }

    /** Idling for an hour must not bank an hour's worth of messages. */
    @Test
    fun `budget does not accumulate past the limit`() {
        val (limiter, clock) = limiter()
        repeat(30) { limiter.say() }

        clock.advance(Duration.ofHours(1))

        repeat(30) { limiter.say() }
        assertFailsWith<ChatRateLimitedException> { limiter.say() }
    }

    /**
     * Per agent, not per fleet and not per operator: the ban this prevents lands on one account, so
     * one noisy agent must not silence the rest.
     */
    @Test
    fun `one agent running out does not silence another`() {
        val (limiter, _) = limiter()
        repeat(30) { limiter.say(agentId = 1L) }

        limiter.say(agentId = 2L)

        assertFailsWith<ChatRateLimitedException> { limiter.say(agentId = 1L) }
    }

    /** Nothing was said, so nothing is spent — the budget is not covered by the transaction. */
    @Test
    fun `an undeliverable message gives its budget back`() {
        val (limiter, _) = limiter()
        repeat(30) { limiter.say() }
        limiter.refund(1L)

        limiter.say()

        assertFailsWith<ChatRateLimitedException> { limiter.say() }
    }

    @Test
    fun `a refund cannot push the budget past the limit`() {
        val (limiter, _) = limiter()
        // One message spent, then refunded five times: the budget is back to full, not to full + 4.
        limiter.say()
        repeat(5) { limiter.refund(1L) }

        repeat(30) { limiter.say() }

        assertFailsWith<ChatRateLimitedException> { limiter.say() }
    }

    /** Deleting an agent drops its bucket, so the map cannot grow for the life of the process. */
    @Test
    fun `forgetting an agent clears what it had spent`() {
        val (limiter, _) = limiter()
        repeat(30) { limiter.say() }

        limiter.forget(1L)

        repeat(30) { limiter.say() }
    }

    @Test
    fun `the limit is configurable`() {
        val (limiter, _) = limiter(perMinute = 3)

        repeat(3) { limiter.say() }

        assertFailsWith<ChatRateLimitedException> { limiter.say() }
    }
}
