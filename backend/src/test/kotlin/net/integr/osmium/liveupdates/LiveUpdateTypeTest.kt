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
     * The tripwire for the node that nothing routes on yet.
     *
     * `LiveUpdateController` gates the stream on `fleet.read` once at subscribe, and
     * `LiveUpdateSubscriptions.tick()` re-checks the same single node. That is sound only while
     * every event on the channel needs exactly that node — which is true today, and is why dispatch
     * does not consult `type.node`.
     *
     * If this fails, an event type has arrived that some subscribers must not receive, and the
     * stream can no longer be authorised by one check at the door. Do not relax the assertion: make
     * `matches()` compare the subscriber's nodes against `event.type.node`, and change `tick()` to
     * refresh each subscription's full node set rather than probing `fleet.read`.
     */
    @Test
    fun `every event on the channel needs the node the stream is gated on`() {
        val other = LiveUpdateType.entries.filterNot { it.node == Nodes.FLEET_READ }

        assertEquals(
            emptyList(),
            other,
            "These types need a node the stream does not check. Per-subscriber routing has to land " +
                "with them — see this test's documentation.",
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
