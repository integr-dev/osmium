package net.integr.osmium.liveupdates

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.liveupdates.FleetEvent
import net.integr.osmium.liveupdates.FleetEventBroker
import net.integr.osmium.liveupdates.FleetEventType
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.get
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.support.TransactionTemplate
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class LiveUpdateControllerTest : AbstractRestTest() {

    @Autowired private lateinit var broker: FleetEventBroker
    @Autowired private lateinit var transactionTemplate: TransactionTemplate

    // ---- authorization -------------------------------------------------------------------------

    @Test
    fun `an anonymous request cannot open the fleet stream`() {
        mockMvc.get("/api/stream/fleet").andExpect { status { isUnauthorized() } }
    }

    @Test
    fun `a viewer cannot open the fleet stream`() {
        mockMvc.get("/api/stream/fleet") {
            header(HttpHeaders.AUTHORIZATION, authAs("watcher", "viewer"))
        }.andExpect { status { isForbidden() } }
    }

    @Test
    fun `an orchestrator opens the fleet stream as an event stream`() {
        mockMvc.get("/api/stream/fleet") {
            header(HttpHeaders.AUTHORIZATION, authAs("streamer", "orchestrator"))
        }.andExpect {
            status { isOk() }
            content { contentTypeCompatibleWith(MediaType.TEXT_EVENT_STREAM) }
        }
    }

    @Test
    fun `a viewer cannot open a per-agent stream either`() {
        val agent = createAgent("Mason_30", reachableHost("host-stream-1"))

        mockMvc.get("/api/stream/agents/${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("watcher2", "viewer"))
        }.andExpect { status { isForbidden() } }
    }

    // ---- delivery ------------------------------------------------------------------------------

    /**
     * The rule the whole channel rests on: a client applying events in place has no way to learn it
     * was told about a change that a rollback then discarded.
     */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `an event published in a rolled back transaction is never delivered`() {
        val delivered = CopyOnWriteArrayList<FleetEvent>()
        broker.subscribe { delivered += it }

        runCatching {
            transactionTemplate.execute {
                broker.publish(FleetEvent(FleetEventType.HOST_CHANGED, mapOf("id" to 1L)))
                throw IllegalStateException("rolled back on purpose")
            }
        }

        assertTrue(delivered.isEmpty(), "expected nothing delivered, got $delivered")
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `an event published in a committed transaction is delivered once`() {
        val delivered = CopyOnWriteArrayList<FleetEvent>()
        broker.subscribe { delivered += it }

        transactionTemplate.execute {
            broker.publish(FleetEvent(FleetEventType.HOST_CHANGED, mapOf("id" to 2L)))
        }

        assertEquals(1, delivered.size)
        assertEquals(FleetEventType.HOST_CHANGED, delivered.single().type)
    }

    /** Outside a transaction there is nothing to wait for, so it goes straight out. */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `an event published outside a transaction is delivered immediately`() {
        val delivered = CopyOnWriteArrayList<FleetEvent>()
        broker.subscribe { delivered += it }

        broker.publish(FleetEvent(FleetEventType.AGENT_REMOVED, mapOf("id" to 3L), agentId = 3L))

        assertEquals(1, delivered.size)
    }

    /** One broken subscriber must not silence the others. */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `a failing subscriber does not stop delivery to the rest`() {
        val delivered = CopyOnWriteArrayList<FleetEvent>()
        broker.subscribe { throw IllegalStateException("this listener is broken") }
        broker.subscribe { delivered += it }

        broker.publish(FleetEvent(FleetEventType.HOST_REMOVED, mapOf("id" to 4L)))

        assertEquals(1, delivered.size)
    }
}
