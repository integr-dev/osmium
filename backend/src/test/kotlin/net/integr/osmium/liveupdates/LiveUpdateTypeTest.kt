package net.integr.osmium.liveupdates

import net.integr.osmium.security.Nodes
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Guards on the event catalogue itself. No Spring context: these are properties of the enum, and a
 * test that needed a database to check them would be slower and no more certain.
 */
class LiveUpdateTypeTest {

    /**
     * The channel is opened behind a session alone, so an event needing only `agent.read` reaches
     * most of the people on
     * it. Any *other* node is a promise that `matches()` keeps — this asserts the promise is real
     * for the types that make it, rather than trusting that dispatch was updated alongside them.
     *
     * `LiveUpdateSubscriptionsTest` proves the enforcement; this proves the catalogue still needs it.
     */
    @Test
    fun `a type needing more than the stream's own node is one dispatch has to filter`() {
        val privileged = LiveUpdateType.entries.filterNot { it.node == Nodes.AGENT_READ }

        assertTrue(
            privileged.isNotEmpty(),
            "No type needs more than ${Nodes.AGENT_READ}. If that is now true, the per-subscriber " +
                "node check in matches() is untested by anything real — delete it or this test.",
        )
    }

    /** A node is a plain string at the use site, so a typo would otherwise gate on nothing. */
    @Test
    fun `every event names a real permission node`() {
        for (type in LiveUpdateType.entries) {
            assertTrue(type.node in Nodes.ALL, "${type.name} requires unknown node '${type.node}'")
        }
    }

    /**
     * The event name is the client's contract, and two types sharing one would arrive as the same
     * kind of thing in the browser — a merge that neither side would report.
     */
    @Test
    fun `event names are distinct`() {
        val names = LiveUpdateType.entries.map { it.eventName }
        assertEquals(names.size, names.toSet().size, "Duplicate event name in $names")
    }
}
