package net.integr.osmium.liveupdates

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateType
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.get
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.springframework.transaction.support.TransactionTemplate
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class LiveUpdateControllerTest : AbstractRestTest() {

    @Autowired private lateinit var broker: LiveUpdateBroker
    @Autowired private lateinit var transactionTemplate: TransactionTemplate

    // ---- authorization -------------------------------------------------------------------------

    @Test
    fun `an anonymous request cannot open the fleet stream`() {
        mockMvc.get("/api/stream").andExpect { status { isUnauthorized() } }
    }

    @Test
    fun `a viewer can open the fleet stream`() {
        // Receive-only, so it is a read like any other and a viewer is entitled to it.
        mockMvc.get("/api/stream") {
            header(HttpHeaders.AUTHORIZATION, authAs("watcher", "viewer"))
        }.andExpect { status { isOk() } }
    }

    @Test
    fun `an account with no role cannot open the fleet stream`() {
        mockMvc.get("/api/stream") {
            header(HttpHeaders.AUTHORIZATION, authAs("nobody"))
        }.andExpect { status { isForbidden() } }
    }

    @Test
    fun `an orchestrator opens the fleet stream as an event stream`() {
        mockMvc.get("/api/stream") {
            header(HttpHeaders.AUTHORIZATION, authAs("streamer", "orchestrator"))
        }.andExpect {
            status { isOk() }
            content { contentTypeCompatibleWith(MediaType.TEXT_EVENT_STREAM) }
        }
    }

    @Test
    fun `a viewer can open a per-agent stream`() {
        val agent = createAgent("Mason_30", reachableHost("host-stream-1"))

        mockMvc.get("/api/stream/agents/${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("watcher2", "viewer"))
        }.andExpect { status { isOk() } }
    }

    // ---- delivery ------------------------------------------------------------------------------

    /**
     * The rule the whole channel rests on: a client applying events in place has no way to learn it
     * was told about a change that a rollback then discarded.
     */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `an event published in a rolled back transaction is never delivered`() {
        val delivered = CopyOnWriteArrayList<LiveUpdateEvent>()
        broker.subscribe { delivered += it }

        runCatching {
            transactionTemplate.execute {
                broker.publish(LiveUpdateEvent(LiveUpdateType.HOST_CHANGED, mapOf("id" to 1L)))
                throw IllegalStateException("rolled back on purpose")
            }
        }

        assertTrue(delivered.isEmpty(), "expected nothing delivered, got $delivered")
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `an event published in a committed transaction is delivered once`() {
        val delivered = CopyOnWriteArrayList<LiveUpdateEvent>()
        broker.subscribe { delivered += it }

        transactionTemplate.execute {
            broker.publish(LiveUpdateEvent(LiveUpdateType.HOST_CHANGED, mapOf("id" to 2L)))
        }

        assertEquals(1, delivered.size)
        assertEquals(LiveUpdateType.HOST_CHANGED, delivered.single().type)
    }

    /** Outside a transaction there is nothing to wait for, so it goes straight out. */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `an event published outside a transaction is delivered immediately`() {
        val delivered = CopyOnWriteArrayList<LiveUpdateEvent>()
        broker.subscribe { delivered += it }

        broker.publish(LiveUpdateEvent(LiveUpdateType.AGENT_REMOVED, mapOf("id" to 3L), agentId = 3L))

        assertEquals(1, delivered.size)
    }

    /** One broken subscriber must not silence the others. */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `a failing subscriber does not stop delivery to the rest`() {
        val delivered = CopyOnWriteArrayList<LiveUpdateEvent>()
        broker.subscribe { throw IllegalStateException("this listener is broken") }
        broker.subscribe { delivered += it }

        broker.publish(LiveUpdateEvent(LiveUpdateType.HOST_REMOVED, mapOf("id" to 4L)))

        assertEquals(1, delivered.size)
    }

    // ---- progress, which cannot wait for a commit -----------------------------------------------

    /**
     * The distinction the schematic reader needs. Its pass runs for minutes inside a single
     * transaction, so an event held until that transaction commits describes work that has already
     * finished — every report lands in one burst at the end and the whole read reads as silence.
     */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `progress goes out during the transaction that reports it, and state waits`() {
        val delivered = CopyOnWriteArrayList<LiveUpdateEvent>()
        broker.subscribe { delivered += it }

        transactionTemplate.executeWithoutResult {
            broker.publish(stage("held"))
            broker.publishNow(stage("now"))

            assertEquals(listOf("now"), stages(delivered), "the held event escaped its transaction")
        }

        assertEquals(listOf("now", "held"), stages(delivered))
    }

    /**
     * Publishing from an `afterCommit` callback, which is where the analysis queue announces its
     * line. Synchronizations are still *active* there, but the list has already been walked — so
     * the ordinary publish hands the event to a callback that is never invoked and drops it without
     * a word. Immediate delivery is the only thing that works from inside one.
     */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `an event published from an afterCommit callback arrives only if it is immediate`() {
        val delivered = CopyOnWriteArrayList<LiveUpdateEvent>()
        broker.subscribe { delivered += it }

        transactionTemplate.executeWithoutResult {
            TransactionSynchronizationManager.registerSynchronization(
                object : TransactionSynchronization {
                    override fun afterCommit() {
                        broker.publish(stage("held"))
                        broker.publishNow(stage("now"))
                    }
                }
            )
        }

        assertEquals(listOf("now"), stages(delivered))
    }

    private fun stage(name: String) =
        LiveUpdateEvent(LiveUpdateType.SCHEMATIC_CHANGED, mapOf("stage" to name))

    /** Only this test's own events: subscribers outlive the test that added them. */
    private fun stages(delivered: List<LiveUpdateEvent>) =
        delivered.mapNotNull { (it.data as? Map<*, *>)?.get("stage") as? String }
}
