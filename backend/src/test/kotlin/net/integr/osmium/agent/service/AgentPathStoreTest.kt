package net.integr.osmium.agent.service

import net.integr.osmium.agent.dto.AgentPathResponse
import net.integr.osmium.agent.dto.AgentPathState
import net.integr.osmium.agent.dto.PathGoalResponse
import net.integr.osmium.agent.dto.PositionResponse
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The two things the store does that are not "put it in a map".
 *
 * **It merges.** Most updates carry only how far along the agent has got: the line is sent when it
 * is drawn and again on every re-plan, because a few hundred points a second is bandwidth spent
 * redrawing something that moved by one node. A store that replaced would blank the path on the
 * first progress report.
 *
 * **It forgets.** A journey that has ended is not a weaker answer, it is a wrong one - so the three
 * states that end one clear the entry rather than replacing it, and a page opened afterwards draws
 * nothing rather than a line to somewhere nobody is going.
 */
class AgentPathStoreTest {

    private val store = AgentPathStore()

    private fun update(
        state: AgentPathState,
        nodes: List<PositionResponse>? = null,
        goal: PathGoalResponse? = null,
        dimension: String? = null,
        progress: Int? = null,
        reason: String? = null,
    ) = AgentPathResponse(
        agentId = 7,
        state = state,
        dimension = dimension,
        goal = goal,
        nodes = nodes,
        progress = progress,
        reason = reason,
    )

    private val line = listOf(PositionResponse(0.5, 64.0, 0.5), PositionResponse(1.5, 64.0, 0.5))

    @Test
    fun `a journey that has just started is held whole`() {
        store.record(
            update(
                AgentPathState.MOVING,
                nodes = line,
                goal = PathGoalResponse(128.0, 64.0, -340.0),
                dimension = "overworld",
                progress = 0,
            ),
        )

        val held = store.find(7)
        assertEquals(2, held?.nodes?.size)
        assertEquals("overworld", held?.dimension)
        assertEquals(0, held?.progress)
    }

    @Test
    fun `an update that only moved along the line keeps the line`() {
        store.record(
            update(AgentPathState.MOVING, nodes = line, goal = PathGoalResponse(1.0, 2.0, 3.0), dimension = "nether"),
        )
        store.record(update(AgentPathState.MOVING, progress = 1))

        val held = store.find(7)
        assertEquals(2, held?.nodes?.size, "the line was blanked by a progress report")
        assertEquals("nether", held?.dimension)
        assertEquals(PathGoalResponse(1.0, 2.0, 3.0), held?.goal)
        assertEquals(1, held?.progress)
    }

    @Test
    fun `a re-plan replaces the line rather than merging into it`() {
        store.record(update(AgentPathState.MOVING, nodes = line))
        store.record(update(AgentPathState.MOVING, nodes = listOf(PositionResponse(9.5, 64.0, 9.5))))

        assertEquals(1, store.find(7)?.nodes?.size)
    }

    @Test
    fun `the merged journey is what the caller is handed back`() {
        store.record(update(AgentPathState.MOVING, nodes = line, dimension = "the_end"))
        val merged = store.record(update(AgentPathState.MOVING, progress = 1))

        assertEquals(2, merged.nodes?.size)
        assertEquals("the_end", merged.dimension)
    }

    /**
     * A destination picked off uncharted ground names a column, and the store has to hold that as
     * faithfully as it holds a point - blanking the height on the way through would turn "get to
     * that spot" into "get to the bottom of the world".
     */
    @Test
    fun `a goal with no height keeps not having one`() {
        store.record(update(AgentPathState.MOVING, nodes = line, goal = PathGoalResponse(9.0, null, 4.0)))
        store.record(update(AgentPathState.MOVING, progress = 1))

        assertEquals(PathGoalResponse(9.0, null, 4.0), store.find(7)?.goal)
    }

    @Test
    fun `every way of ending a journey clears it`() {
        for (ending in listOf(AgentPathState.ARRIVED, AgentPathState.FAILED, AgentPathState.IDLE)) {
            store.record(update(AgentPathState.MOVING, nodes = line))
            assertTrue(store.find(7) != null)

            store.record(update(ending, reason = "done"))
            assertNull(store.find(7), "$ending left a journey behind")
        }
    }

    /** The ending itself is still handed back, so it can go out and clear a screen already drawing. */
    @Test
    fun `an ending is answered with itself rather than with nothing`() {
        store.record(update(AgentPathState.MOVING, nodes = line))
        val ending = store.record(update(AgentPathState.FAILED, reason = "there is no route there"))

        assertEquals(AgentPathState.FAILED, ending.state)
        assertEquals("there is no route there", ending.reason)
    }

    @Test
    fun `planning is a journey, and the three endings are not`() {
        assertTrue(AgentPathState.PLANNING.live)
        assertTrue(AgentPathState.MOVING.live)
        assertTrue(!AgentPathState.ARRIVED.live)
        assertTrue(!AgentPathState.FAILED.live)
        assertTrue(!AgentPathState.IDLE.live)
    }

    @Test
    fun `an agent that is deleted stops being on its way somewhere`() {
        store.record(update(AgentPathState.MOVING, nodes = line))
        store.forget(7)

        assertNull(store.find(7))
        assertTrue(store.all().isEmpty())
    }

    @Test
    fun `nothing is known about an agent nobody has sent anywhere`() {
        assertNull(store.find(7))
        assertNull(store.find(null))
    }
}
