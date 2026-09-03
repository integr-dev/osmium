package net.integr.osmium.chat.service

import net.integr.osmium.chat.config.ChatProperties
import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Plain unit tests on a clock the test owns, like [ChatRateLimiterTest]. Everything here is about
 * repetition over time, and a suite that waits for real minutes to pass is both slow and flaky.
 */
class ChatSpamFilterTest {

    private val start = Instant.parse("2026-09-03T12:00:00Z")

    private class TestClock(var now: Instant) : Clock() {
        override fun instant(): Instant = now
        override fun getZone() = ZoneOffset.UTC
        override fun withZone(zone: java.time.ZoneId): Clock = this
        fun advance(by: Duration) {
            now = now.plus(by)
        }
    }

    private fun filter(properties: ChatProperties = ChatProperties()): Pair<ChatSpamFilter, TestClock> {
        val clock = TestClock(start)
        return ChatSpamFilter(properties, clock) to clock
    }

    private fun ChatSpamFilter.said(
        typed: String?,
        sender: String = "Notch",
        server: String = "play.example.com",
    ) = judge(serverAddress = server, sender = sender, typed = typed) == ChatSpamFilter.Verdict.Keep

    /** How many were dropped in a row, or null for a line that was kept. */
    private fun ChatSpamFilter.runAfter(
        typed: String?,
        sender: String = "Notch",
        server: String = "play.example.com",
    ) = (judge(serverAddress = server, sender = sender, typed = typed) as? ChatSpamFilter.Verdict.Drop)?.run

    /** Four repeats reach the threshold, and the fifth is where it starts refusing. */
    @Test
    fun `refuses a line once it has been repeated to the threshold`() {
        val (filter, _) = filter()

        val allowed = (1..8).count { filter.said("selling diamond blocks cheap") }

        assertEquals(4, allowed)
    }

    /** The common case, and the one a false positive would ruin. */
    @Test
    fun `never refuses somebody having a conversation`() {
        val (filter, _) = filter()

        val talk = listOf(
            "anybody got spare obsidian",
            "im at the nether hub",
            "thanks that helps a lot",
            "no i went the other way",
            "see you at spawn in a bit",
            "who built the tower over there",
        )

        assertTrue(talk.all { filter.said(it) })
    }

    /**
     * Varying a number is the cheapest way past an exact-match filter, so digits are collapsed
     * before anything is compared.
     */
    @Test
    fun `sees through a counter on the end`() {
        val (filter, _) = filter()

        val allowed = (1..8).count { filter.said("/dupe ${"4".repeat(it)}") }

        assertEquals(4, allowed)
    }

    /**
     * The evasion overlap alone does not survive: a constant template with a fresh random tail every
     * time, which measures about 0.3 against its own predecessor.
     */
    @Test
    fun `sees through a random tail on a constant template`() {
        val (filter, _) = filter()
        val tails = listOf(
            "eMbhGOjrPAYhTIK", "lWpvwVXOrlvbaPJ", "rdCEMCauJmAzOBS", "wSFNDIcyaQSkotT",
            "pTXooMoiTZMEKey", "UJaDingAObAnBTH", "kEQjwzwYDqAgQXx", "gnwpGReCWOdxYak",
        )

        val allowed = tails.count { filter.said("/dupe BOMBOCLAAT $it") }

        assertEquals(4, allowed)
    }

    /** The same, with the template itself repeating - which collapses the overlap further still. */
    @Test
    fun `sees through a repeated command with a random tail`() {
        val (filter, _) = filter()
        val tails = listOf("dgFyeeLoVtPfcMt", "ZFZlvHvDeSJcxWr", "GARGJGkdXJrtmSz", "FodZAIJglyAoWaC", "AnVifULOkMDqsQL")

        val allowed = tails.count { filter.said("/dupe /dupe /dupe /dupe /dupe /dupe $it") }

        assertEquals(4, allowed)
    }

    /**
     * The floor under the shared opening. Without it the ratio alone calls two people talking a
     * repeat, which on real chat cost 168 lines of ordinary conversation.
     */
    @Test
    fun `a short shared opening is not a template`() {
        val (filter, _) = filter()

        val talk = listOf(
            "yes i think so",
            "yes i think not",
            "yes i think maybe",
            "yes i think again",
            "yes i think we should",
            "yes i think it is fine",
        )

        assertTrue(talk.all { filter.said(it) })
    }

    /** `gg`, `lol`, `yea`. Alike by any measure, and most of what chat is made of. */
    @Test
    fun `never scores a short line`() {
        val (filter, _) = filter()

        assertTrue((1..20).all { filter.said("gg") })
    }

    /** One remembered line is not enough: alternating between two defeats it, and people do that. */
    @Test
    fun `catches two messages sent alternately`() {
        val (filter, _) = filter()

        val allowed = (1..10).count { filter.said(if (it % 2 == 0) "join my faction" else "we are recruiting") }

        assertEquals(5, allowed)
    }

    /** Muted gags the repetition, not the person. */
    @Test
    fun `lets something new through from somebody being suppressed`() {
        val (filter, _) = filter()
        repeat(6) { filter.said("selling diamond blocks cheap") }

        assertFalse(filter.said("selling diamond blocks cheap"))
        assertTrue(filter.said("does anyone know where the end portal is"))
    }

    /** The count comes back continuously, so somebody who stops is recorded again. */
    @Test
    fun `records them again once they have been quiet`() {
        val (filter, clock) = filter()
        repeat(6) { filter.said("selling diamond blocks cheap") }
        assertFalse(filter.said("selling diamond blocks cheap"))

        clock.advance(Duration.ofMinutes(10))

        assertTrue(filter.said("selling diamond blocks cheap"))
    }

    /**
     * A refused line still counts against them. Without this, somebody spamming through a mute is
     * released on the same schedule as somebody who stopped, and gets a line through every cooldown.
     */
    @Test
    fun `keeps scoring what it refuses`() {
        val (filter, clock) = filter()
        val (patient, patientClock) = filter()

        repeat(20) { filter.said("selling diamond blocks cheap") }
        repeat(6) { patient.said("selling diamond blocks cheap") }

        clock.advance(Duration.ofMinutes(4))
        patientClock.advance(Duration.ofMinutes(4))

        assertFalse(filter.said("selling diamond blocks cheap"))
        assertTrue(patient.said("selling diamond blocks cheap"))
    }

    /**
     * A line the host could not attribute has no speaker to hold responsible, and every one of them
     * on a server shares the same name - so scoring them would judge the server as one person.
     */
    @Test
    fun `leaves unattributed lines alone`() {
        val (filter, _) = filter()

        assertTrue((1..20).all { filter.said(typed = null) })
        assertTrue((1..20).all { filter.said("the abyss is open for 0 seconds", sender = "server") })
    }

    /** Same name, two servers, and no reason to think it is the same person. */
    @Test
    fun `counts a speaker per server`() {
        val (filter, _) = filter()
        repeat(8) { filter.said("selling diamond blocks cheap", server = "play.example.com") }

        assertTrue(filter.said("selling diamond blocks cheap", server = "mc.example.net"))
    }

    @Test
    fun `stores everything when the threshold is zero`() {
        val (filter, _) = filter(ChatProperties(spamThreshold = 0))

        assertTrue((1..20).all { filter.said("selling diamond blocks cheap") })
    }

    /**
     * The map is bounded, so a server nobody has left in years cannot grow it without limit. The
     * cost of the bound is that a forgotten speaker starts again from nothing, which is the right
     * way round: too lenient, never silencing somebody who has said one thing.
     */
    @Test
    fun `forgets the speaker it has heard from least recently`() {
        val (filter, _) = filter(ChatProperties(spamSpeakers = 2))
        repeat(8) { filter.said("selling diamond blocks cheap", sender = "Notch") }
        assertFalse(filter.said("selling diamond blocks cheap", sender = "Notch"))

        filter.said("hello there everybody", sender = "Alex")
        filter.said("hello there everybody", sender = "Herobrine")

        assertTrue(filter.said("selling diamond blocks cheap", sender = "Notch"))
    }

    /** The count the interface draws in place of the gap, growing while the gap is still open. */
    @Test
    fun `counts how many have gone in a row`() {
        val (filter, _) = filter()
        repeat(4) { filter.said("selling diamond blocks cheap") }

        assertEquals(listOf(1, 2, 3), (1..3).map { filter.runAfter("selling diamond blocks cheap") })
    }

    /** A gap is closed by the next line that lands, and the one after it starts a new gap at one. */
    @Test
    fun `starts the count again after a line gets through`() {
        val (filter, _) = filter()
        repeat(4) { filter.said("selling diamond blocks cheap") }
        assertEquals(1, filter.runAfter("selling diamond blocks cheap"))
        assertEquals(2, filter.runAfter("selling diamond blocks cheap"))

        assertTrue(filter.said("does anyone know where the end portal is"))

        assertEquals(1, filter.runAfter("selling diamond blocks cheap"))
    }

    /**
     * The run belongs to the feed rather than to the person, so anybody getting a line through ends
     * it. What it stands for is a hole in one server's transcript, and that hole has a bottom as
     * soon as there is a line under it.
     */
    @Test
    fun `anybody speaking closes the run`() {
        val (filter, _) = filter()
        repeat(4) { filter.said("selling diamond blocks cheap", sender = "Notch") }
        assertEquals(1, filter.runAfter("selling diamond blocks cheap", sender = "Notch"))

        assertTrue(filter.said("what is going on in here", sender = "Alex"))

        assertEquals(1, filter.runAfter("selling diamond blocks cheap", sender = "Notch"))
    }

    /** Two feeds, two gaps. A line landing on one server says nothing about the other. */
    @Test
    fun `counts a run per server`() {
        val (filter, _) = filter()
        repeat(4) { filter.said("selling diamond blocks cheap", server = "play.example.com") }
        assertEquals(1, filter.runAfter("selling diamond blocks cheap", server = "play.example.com"))

        assertTrue(filter.said("what is going on in here", server = "mc.example.net"))

        assertEquals(2, filter.runAfter("selling diamond blocks cheap", server = "play.example.com"))
    }
}
