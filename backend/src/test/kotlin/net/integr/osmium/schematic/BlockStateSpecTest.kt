package net.integr.osmium.schematic

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * The single-string form of a block state, which is what a segment hands a host.
 *
 * A host is told to place a *state*, not a block: stairs without their facing are stairs pointing
 * whichever way the server defaults to, which is a building that looks almost right.
 */
class BlockStateSpecTest {

    @Test
    fun `a block with no properties is just its name`() {
        assertEquals("minecraft:stone", BlockState("minecraft:stone").spec)
    }

    @Test
    fun `properties are written in the form the formats use`() {
        val state = BlockState("minecraft:oak_stairs", mapOf("facing" to "east", "half" to "bottom"))

        assertEquals("minecraft:oak_stairs[facing=east,half=bottom]", state.spec)
    }

    /**
     * The subtle one. Litematica stores properties as an NBT compound and Sponge writes them into a
     * string, and neither promises an order — so one state can arrive spelled two ways, from two
     * files or from two regions of one. Unsorted, those intern as two palette entries for one block:
     * a palette with the same state in it twice, and a host with no way to know they are the same.
     */
    @Test
    fun `the same state spells the same way whatever order it arrived in`() {
        val one = BlockState("minecraft:oak_stairs", mapOf("half" to "bottom", "facing" to "east"))
        val other = BlockState("minecraft:oak_stairs", mapOf("facing" to "east", "half" to "bottom"))

        assertEquals(one.spec, other.spec)
    }

    /** Round trips, so a Sponge palette read and re-emitted says what it said. */
    @Test
    fun `parsing a spec and writing it back gives the same spec`() {
        val spec = "minecraft:oak_stairs[facing=east,half=bottom,waterlogged=false]"

        assertEquals(spec, BlockState.parse(spec).spec)
    }
}
