package net.integr.osmium.build

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The token is carried rather than interpreted, so the whole of this backend's job is refusing one
 * the host would have to guess at.
 */
class PlacementOrderTest {

    @Test
    fun `three axes, each named once, each with a direction`() {
        assertTrue(PlacementOrder.valid("y+z+x+"))
        assertTrue(PlacementOrder.valid("x-y-z-"))
        assertTrue(PlacementOrder.valid("z+x-y+s"))
    }

    @Test
    fun `an axis named twice describes no sweep`() {
        assertFalse(PlacementOrder.valid("y+y-x+"))
        assertFalse(PlacementOrder.valid("x+x+x+"))
    }

    @Test
    fun `anything else is not an order`() {
        for (nonsense in listOf("", "y+z+", "y+z+x+y+", "w+z+x+", "y*z+x+", "y+z+x+ss", "yzx")) {
            assertFalse(PlacementOrder.valid(nonsense), nonsense)
        }
    }

    @Test
    fun `nothing asked for is the order every job had before this was a choice`() {
        assertEquals(PlacementOrder.DEFAULT, PlacementOrder.of(null))
        assertEquals(PlacementOrder.DEFAULT, PlacementOrder.of("  "))
    }

    @Test
    fun `what an operator asked for, tidied`() {
        assertEquals("y+z+x+s", PlacementOrder.of(" Y+Z+X+S "))
    }

    /** Null is the refusal the caller turns into a failed request, rather than a quiet default. */
    @Test
    fun `an order this backend cannot read is refused rather than replaced`() {
        assertNull(PlacementOrder.of("y+y+x+"))
        assertNull(PlacementOrder.of("sideways"))
    }
}
