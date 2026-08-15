package net.integr.osmium.schematic

import net.integr.osmium.schematic.SchematicFixtures.Placed
import net.integr.osmium.schematic.SchematicFixtures.Recorder
import net.integr.osmium.schematic.SchematicFixtures.litematic
import net.integr.osmium.schematic.SchematicFixtures.region
import net.integr.osmium.schematic.nbt.NbtFormatException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream

/**
 * What the decoder has to get right is not "does it read a file" — it is the handful of things that
 * decode into a **different building** rather than into an error: a mirrored region, air counted as
 * a block, blocks emitted in an order other than the one the whole pipeline downstream assumes.
 */
class LitematicDecoderTest {

    private val decoder = LitematicDecoder()

    private fun info(bytes: ByteArray) = decoder.readInfo(ByteArrayInputStream(bytes))

    private fun blocks(bytes: ByteArray): List<Placed> {
        val recorder = Recorder()
        decoder.readBlocks(ByteArrayInputStream(bytes), info(bytes), recorder)
        return recorder.placed
    }

    /** Air everywhere except the listed indices, which get palette entry 1. */
    private fun states(size: Int, vararg solid: Int) =
        IntArray(size).also { array -> solid.forEach { array[it] = 1 } }

    @Test
    fun `reads sizes, palette and data version`() {
        val bytes = litematic(
            listOf(
                region(
                    size = Vec3i(2, 2, 2),
                    palette = listOf("minecraft:air", "minecraft:oak_stairs[facing=east,half=top]"),
                    states = states(8, 1),
                )
            )
        )

        val info = info(bytes)

        assertEquals(SchematicFormat.LITEMATIC, info.format)
        assertEquals(SchematicFixtures.SUPPORTED_DATA_VERSION, info.dataVersion)
        assertEquals(1, info.regions.size)
        assertEquals(8L, info.volume)

        val stairs = info.regions[0].palette[1]
        assertEquals("minecraft:oak_stairs", stairs.name)
        assertEquals(mapOf("facing" to "east", "half" to "top"), stairs.properties)
    }

    @Test
    fun `emits blocks bottom layer first, in the format's order`() {
        // Index order is y outermost, then z, then x. Two blocks, deliberately chosen so that the
        // wrong order swaps them: one on the bottom layer, one on the top.
        val bytes = litematic(
            listOf(
                region(
                    size = Vec3i(2, 2, 2),
                    palette = listOf("minecraft:air", "minecraft:stone"),
                    // y=0,z=0,x=1 -> index 1.  y=1,z=1,x=0 -> index 6.
                    states = states(8, 1, 6),
                )
            )
        )

        // Bottom before top is not a preference. Gravity blocks need what is under them, and the
        // deterministic order is what later lets a segment be a range and progress be one integer.
        assertEquals(
            listOf(Placed(0, 1, 0, 0, 1), Placed(0, 0, 1, 1, 1)),
            blocks(bytes),
        )
    }

    @Test
    fun `drops all three kinds of air`() {
        val bytes = litematic(
            listOf(
                region(
                    size = Vec3i(4, 1, 1),
                    palette = listOf(
                        "minecraft:air",
                        "minecraft:cave_air",
                        "minecraft:void_air",
                        "minecraft:stone",
                    ),
                    states = intArrayOf(0, 1, 2, 3),
                )
            )
        )

        // A schematic captured underground is full of cave_air. Counting it as a block turns the
        // build into a solid cube — not a subtle failure, but a silent one.
        assertEquals(listOf(Placed(0, 3, 0, 0, 3)), blocks(bytes))
    }

    @Test
    fun `normalises a region written backwards`() {
        // A negative extent means the region runs back from its position, so the position is the
        // *maximum* corner. Read as a minimum, every block is present and the build is mirrored.
        val bytes = litematic(
            listOf(
                region(
                    position = Vec3i(10, 0, 0),
                    size = Vec3i(-3, 1, 1),
                    palette = listOf("minecraft:air", "minecraft:stone"),
                    states = states(3, 0),
                )
            )
        )

        val info = info(bytes)
        assertEquals(Vec3i(8, 0, 0), info.regions[0].origin)
        assertEquals(Vec3i(3, 1, 1), info.regions[0].size)
        // Local x = 0 is the minimum corner, which is 8 — not the 10 the file names.
        assertEquals(listOf(Placed(0, 8, 0, 0, 1)), blocks(bytes))
    }

    @Test
    fun `reads several regions, keeping their order`() {
        // The main path at the sizes this accepts, not an edge case: an NBT array length is a
        // signed 32-bit int, so anything past about two billion positions is necessarily split.
        val bytes = litematic(
            listOf(
                region(
                    name = "nave",
                    position = Vec3i(0, 0, 0),
                    size = Vec3i(2, 1, 1),
                    palette = listOf("minecraft:air", "minecraft:stone"),
                    states = states(2, 0),
                ),
                region(
                    name = "spire",
                    position = Vec3i(100, 64, 0),
                    size = Vec3i(2, 1, 1),
                    palette = listOf("minecraft:air", "minecraft:glass"),
                    states = states(2, 1),
                ),
            )
        )

        val info = info(bytes)
        assertEquals(listOf("nave", "spire"), info.regions.map { it.name })
        assertEquals(Vec3i(0, 0, 0) to Vec3i(102, 65, 1), info.bounds)

        assertEquals(
            listOf(Placed(0, 0, 0, 0, 1), Placed(1, 101, 64, 0, 1)),
            blocks(bytes),
        )
    }

    @Test
    fun `decodes a palette wide enough to straddle long boundaries`() {
        // Seventeen entries is five bits, and five does not divide 64 — so entries begin in one
        // long and finish in the next. A decoder that packs each long independently passes every
        // test above and fails this one, by returning a different block rather than an error.
        val palette = listOf("minecraft:air") + (1..16).map { "minecraft:stone_$it" }
        val states = IntArray(64) { (it % 16) + 1 }

        val bytes = litematic(
            listOf(region(size = Vec3i(64, 1, 1), palette = palette, states = states))
        )

        assertEquals(states.toList(), blocks(bytes).map { it.state })
    }

    @Test
    fun `reads an uncompressed file too`() {
        val bytes = litematic(
            listOf(
                region(
                    size = Vec3i(1, 1, 1),
                    palette = listOf("minecraft:stone"),
                    states = intArrayOf(0),
                )
            ),
            compressed = false,
        )

        assertEquals(1, blocks(bytes).size)
    }

    @Test
    fun `refuses block data whose length disagrees with the region's size`() {
        val good = litematic(
            listOf(
                region(
                    size = Vec3i(64, 1, 1),
                    palette = listOf("minecraft:air", "minecraft:stone"),
                    states = states(64, 0),
                )
            ),
            compressed = false,
        )
        // Same file, one long short. Unrecoverable rather than merely wrong: reading on leaves the
        // stream inside a value, and every region after this one decodes from the wrong offset.
        val truncated = good.copyOf()
        val marker = "BlockStates".toByteArray()
        val at = good.indices.first { index ->
            marker.indices.all { good.getOrNull(index + it) == marker[it] }
        } + marker.size
        truncated[at + 3] = (truncated[at + 3] - 1).toByte()

        val failure = assertThrows(NbtFormatException::class.java) { blocks(truncated) }
        assertTrue(failure.message!!.contains("longs"))
    }

    @Test
    fun `refuses a file with no regions`() {
        val failure = assertThrows(NbtFormatException::class.java) { info(litematic(emptyList())) }
        assertTrue(failure.message!!.contains("regions"))
    }
}
