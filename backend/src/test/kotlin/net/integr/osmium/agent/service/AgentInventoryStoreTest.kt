package net.integr.osmium.agent.service

import net.integr.osmium.agent.dto.AgentInventoryResponse
import net.integr.osmium.agent.dto.InventorySlotResponse
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * What bounds an inventory's life, which is not a clock.
 *
 * Deliberately unlike [AgentTelemetryStoreTest]. Vitals are resent every few seconds whether or not
 * they changed, so a stale sample there means a host that stopped talking and ageing reads it
 * correctly. An inventory is sent only when items *move*, so nothing refreshes the one an agent is
 * standing still with — and ageing read a quiet agent as an agent nobody had heard from. What ends
 * an inventory is the session ending, which the backend is told about.
 */
class AgentInventoryStoreTest {

    private fun sample(count: Int = 1) = AgentInventoryResponse(
        slots = listOf(
            InventorySlotResponse(
                slot = 36,
                name = "diamond_pickaxe",
                displayName = "Diamond Pickaxe",
                count = count,
                damage = 142,
                maxDamage = 1561,
            ),
        ),
        held = 0,
    )

    @Test
    fun `the latest report wins`() {
        val store = AgentInventoryStore()

        store.record(1L, sample(count = 1))
        store.record(1L, sample(count = 12))

        assertEquals(12, store.find(1L)?.slots?.first()?.count)
    }

    @Test
    fun `an agent that has reported nothing has no inventory`() {
        // Not an empty one. An empty grid is what an agent carrying nothing looks like, so
        // answering with one would be answering a question nobody has been told about.
        assertNull(AgentInventoryStore().find(1L))
    }

    @Test
    fun `an inventory outlives any quiet stretch`() {
        // The regression this exists for: a card that emptied itself a minute after it was opened,
        // because an agent standing in a field had nothing to report and was read as gone.
        val store = AgentInventoryStore()
        store.record(1L, sample())

        repeat(1_000) { store.find(1L) }

        assertEquals(1, store.find(1L)?.slots?.size)
    }

    @Test
    fun `an agent that left the game is forgotten`() {
        // What it had is no longer what it has. Held on to, it would show the last session's
        // pockets against an agent that is offline.
        val store = AgentInventoryStore()
        store.record(1L, sample())

        store.forget(1L)

        assertNull(store.find(1L))
    }

    @Test
    fun `forgetting one agent leaves the others alone`() {
        val store = AgentInventoryStore()
        store.record(1L, sample())
        store.record(2L, sample())

        store.forget(1L)

        assertNull(store.find(1L))
        assertEquals(1, store.find(2L)?.slots?.size)
    }
}
