package net.integr.osmium.build

import org.junit.jupiter.api.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A turn is applied twice — to where a block goes and to what it is — and both halves have to agree
 * with Minecraft's own clockwise, or the build comes out the right shape facing the wrong way.
 */
class RotationTest {

    /** A footprint five wide and three deep, so a swapped side is visible. */
    private val sx = 5
    private val sz = 3

    @Test
    fun `only quarter turns are turns`() {
        assertTrue(Rotation.valid(0))
        assertTrue(Rotation.valid(270))
        assertFalse(Rotation.valid(45))
        assertFalse(Rotation.valid(360))
    }

    @Test
    fun `every column lands inside the turned footprint, and no two land on the same one`() {
        for (turns in 0..3) {
            val (wide, deep) = Rotation.footprint(sx, sz, turns)
            val landed = mutableSetOf<Pair<Int, Int>>()

            for (x in 0 until sx) for (z in 0 until sz) {
                val rx = Rotation.x(x, z, sx, sz, turns)
                val rz = Rotation.z(x, z, sx, sz, turns)
                assertTrue(rx in 0 until wide && rz in 0 until deep, "turn $turns put ($x, $z) at ($rx, $rz)")
                landed += rx to rz
            }

            assertEquals(sx * sz, landed.size, "turn $turns")
        }
    }

    /** North-west corner, turned clockwise, is the north-east one: Minecraft's own sense of clockwise. */
    @Test
    fun `a quarter turn is clockwise seen from above`() {
        val (wide, _) = Rotation.footprint(sx, sz, 1)

        assertEquals(wide - 1, Rotation.x(0, 0, sx, sz, 1))
        assertEquals(0, Rotation.z(0, 0, sx, sz, 1))
    }

    @Test
    fun `a box turns onto exactly the columns its blocks turn onto`() {
        // Half-open, as segments hold them: columns 1..3 across, 0..1 deep.
        val box = intArrayOf(1, 4, 0, 2)

        for (turns in 0..3) {
            val turned = Rotation.box(box[0], box[1], box[2], box[3], sx, sz, turns)
            val xs = (box[0] until box[1]).flatMap { x -> (box[2] until box[3]).map { z -> Rotation.x(x, z, sx, sz, turns) } }
            val zs = (box[0] until box[1]).flatMap { x -> (box[2] until box[3]).map { z -> Rotation.z(x, z, sx, sz, turns) } }

            assertContentEquals(intArrayOf(xs.min(), xs.max() + 1, zs.min(), zs.max() + 1), turned, "turn $turns")
        }
    }

    @Test
    fun `nothing about a state changes without a turn`() {
        assertEquals("minecraft:oak_stairs[facing=north,half=top]", Rotation.state("minecraft:oak_stairs[facing=north,half=top]", 0))
        assertEquals("minecraft:stone", Rotation.state("minecraft:stone", 1))
    }

    @Test
    fun `a facing turns, and up and down do not`() {
        assertEquals("minecraft:oak_stairs[facing=east,half=top]", Rotation.state("minecraft:oak_stairs[facing=north,half=top]", 1))
        assertEquals("minecraft:hopper[facing=down]", Rotation.state("minecraft:hopper[facing=down]", 1))
        assertEquals("minecraft:observer[facing=west]", Rotation.state("minecraft:observer[facing=north]", 3))
    }

    @Test
    fun `an axis trades x for z on an odd turn only`() {
        assertEquals("minecraft:oak_log[axis=z]", Rotation.state("minecraft:oak_log[axis=x]", 1))
        assertEquals("minecraft:oak_log[axis=x]", Rotation.state("minecraft:oak_log[axis=x]", 2))
        assertEquals("minecraft:oak_log[axis=y]", Rotation.state("minecraft:oak_log[axis=y]", 1))
    }

    @Test
    fun `a sign's sixteenths go round by four a quarter`() {
        assertEquals("minecraft:oak_sign[rotation=4]", Rotation.state("minecraft:oak_sign[rotation=0]", 1))
        assertEquals("minecraft:oak_sign[rotation=2]", Rotation.state("minecraft:oak_sign[rotation=14]", 1))
    }

    /** A fence's arms are which side something is on, so the values move between the keys. */
    @Test
    fun `sides move between keys`() {
        assertEquals(
            "minecraft:oak_fence[east=true,north=false,south=false,west=false]",
            Rotation.state("minecraft:oak_fence[east=false,north=true,south=false,west=false]", 1),
        )
        assertEquals(
            "minecraft:cobblestone_wall[east=low,north=none,south=tall,up=true,west=none]",
            Rotation.state("minecraft:cobblestone_wall[east=tall,north=low,south=none,up=true,west=none]", 1),
        )
    }

    /** Vanilla spells every rail shape one way only, and a turned one has to come out in it. */
    @Test
    fun `a rail's ends turn and keep vanilla's spelling`() {
        assertEquals("minecraft:rail[shape=east_west]", Rotation.state("minecraft:rail[shape=north_south]", 1))
        assertEquals("minecraft:rail[shape=north_east]", Rotation.state("minecraft:rail[shape=north_west]", 1))
        assertEquals("minecraft:rail[shape=south_west]", Rotation.state("minecraft:rail[shape=south_east]", 1))
        assertEquals("minecraft:rail[shape=ascending_south]", Rotation.state("minecraft:rail[shape=ascending_east]", 1))
    }

    @Test
    fun `a stair's shape names no direction and is left alone`() {
        assertEquals(
            "minecraft:oak_stairs[facing=east,half=bottom,shape=inner_left]",
            Rotation.state("minecraft:oak_stairs[facing=north,half=bottom,shape=inner_left]", 1),
        )
    }

    @Test
    fun `handedness survives a turn`() {
        assertEquals(
            "minecraft:oak_door[facing=south,half=lower,hinge=left,open=false]",
            Rotation.state("minecraft:oak_door[facing=east,half=lower,hinge=left,open=false]", 1),
        )
    }

    @Test
    fun `four quarter turns are no turn at all`() {
        for (spec in listOf(
            "minecraft:oak_stairs[facing=north,half=top,shape=outer_right]",
            "minecraft:oak_fence[east=false,north=true,south=false,west=true]",
            "minecraft:rail[shape=ascending_west]",
            "minecraft:crafter[orientation=north_up]",
            "minecraft:oak_sign[rotation=7]",
        )) {
            var turned = spec
            repeat(4) { turned = Rotation.state(turned, 1) }
            assertEquals(spec, turned)
        }
    }
}
