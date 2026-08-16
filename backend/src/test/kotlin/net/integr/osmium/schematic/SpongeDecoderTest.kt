package net.integr.osmium.schematic

import net.integr.osmium.schematic.SchematicFixtures.Placed
import net.integr.osmium.schematic.SchematicFixtures.Recorder
import net.integr.osmium.schematic.SchematicFixtures.region
import net.integr.osmium.schematic.SchematicFixtures.sponge
import net.integr.osmium.schematic.nbt.NbtFormatException
import net.integr.osmium.schematic.nbt.NbtWriter
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream

/**
 * Sponge differs from Litematica in every mechanical detail — varints rather than packed bits, a
 * palette as one string rather than a name and a compound, two layouts rather than one — and in
 * nothing that the rest of the pipeline sees. These tests are mostly about that: the same schematic
 * written both ways has to arrive identically.
 */
class SpongeDecoderTest {

    private val decoder = SpongeDecoder()

    private fun info(bytes: ByteArray) = decoder.readInfo(ByteArrayInputStream(bytes))

    private fun blocks(bytes: ByteArray): List<Placed> {
        val recorder = Recorder()
        decoder.readBlocks(ByteArrayInputStream(bytes), info(bytes), recorder)
        return recorder.placed
    }

    private val cube = region(
        position = Vec3i(4, 60, -2),
        size = Vec3i(2, 2, 2),
        palette = listOf("minecraft:air", "minecraft:stone"),
        // y=0,z=0,x=1 -> index 1.  y=1,z=1,x=0 -> index 6.
        states = IntArray(8).also { it[1] = 1; it[6] = 1 },
    )

    @Test
    fun `reads version 3, where the body is nested twice`() {
        val info = info(sponge(cube, version = 3))

        assertEquals(SchematicFormat.SPONGE, info.format)
        assertEquals(1, info.regions.size)
        assertEquals(Vec3i(4, 60, -2), info.regions[0].origin)
        assertEquals(Vec3i(2, 2, 2), info.regions[0].size)
    }

    @Test
    fun `reads version 2 and version 3 to the same blocks`() {
        // The versions differ by nesting, not by content. Descending into `Schematic` and `Blocks`
        // wherever they appear is what makes one reader serve both.
        val expected = listOf(Placed(0, 5, 60, -2, 1), Placed(0, 4, 61, -1, 1))

        assertEquals(expected, blocks(sponge(cube, version = 2)))
        assertEquals(expected, blocks(sponge(cube, version = 3)))
    }

    @Test
    fun `agrees with the litematic decoder about the same build`() {
        // The whole point of a format-agnostic pipeline. Same geometry, same palette, same order —
        // so anything downstream can be written once.
        val fromSponge = blocks(sponge(cube))
        val litematic = SchematicFixtures.litematic(listOf(cube))
        val recorder = Recorder()
        LitematicDecoder().readBlocks(
            ByteArrayInputStream(litematic),
            LitematicDecoder().readInfo(ByteArrayInputStream(litematic)),
            recorder,
        )

        assertEquals(recorder.placed, fromSponge)
    }

    @Test
    fun `reads a dimension past the sign bit of a short`() {
        // Width, Height and Length are shorts, and the format means them unsigned. Believed signed,
        // a build 40,000 blocks across measures -25,536 and the region reads as empty.
        val wide = region(
            size = Vec3i(40_000, 1, 1),
            palette = listOf("minecraft:air", "minecraft:stone"),
            states = IntArray(40_000).also { it[39_999] = 1 },
        )

        val info = info(sponge(wide))

        assertEquals(40_000, info.regions[0].size.x)
        assertEquals(listOf(Placed(0, 39_999, 0, 0, 1)), blocks(sponge(wide)))
    }

    @Test
    fun `parses properties out of the palette's single string`() {
        val stairs = region(
            size = Vec3i(1, 1, 1),
            palette = listOf("minecraft:oak_stairs[facing=east,half=top,waterlogged=false]"),
            states = intArrayOf(0),
        )

        val state = info(sponge(stairs)).regions[0].palette[0]

        assertEquals("minecraft:oak_stairs", state.name)
        assertEquals(
            mapOf("facing" to "east", "half" to "top", "waterlogged" to "false"),
            state.properties,
        )
    }

    @Test
    fun `drops air, whichever kind`() {
        val mixed = region(
            size = Vec3i(4, 1, 1),
            palette = listOf(
                "minecraft:air",
                "minecraft:cave_air",
                "minecraft:void_air",
                "minecraft:stone",
            ),
            states = intArrayOf(0, 1, 2, 3),
        )

        assertEquals(listOf(Placed(0, 3, 0, 0, 3)), blocks(sponge(mixed)))
    }

    @Test
    fun `tolerates block data longer than the build`() {
        // The array may carry more bytes than there are positions. Reading exactly as many varints
        // as the build needs and discarding the rest is what leaves the stream where the next tag
        // begins.
        assertEquals(2, blocks(sponge(cube, trailingData = 32)).size)
    }

    @Test
    fun `refuses block data that names an index the palette does not define`() {
        val bad = region(
            size = Vec3i(2, 1, 1),
            palette = listOf("minecraft:air", "minecraft:stone"),
            states = intArrayOf(0, 7),
        )

        val failure = assertThrows(NbtFormatException::class.java) { blocks(sponge(bad)) }
        assertTrue(failure.message!!.contains("palette entry 7"))
    }

    @Test
    fun `refuses a palette with a hole in it`() {
        // A gap means the palette leaves an index undefined that the data is free to name.
        // Resolving it to air would delete blocks and say nothing.
        val bytes = NbtWriter.gzipped {
            compound("Schematic") {
                int("Version", 3)
                int("DataVersion", SchematicFixtures.SUPPORTED_DATA_VERSION)
                short("Width", 1)
                short("Height", 1)
                short("Length", 1)
                compound("Blocks") {
                    compound("Palette") {
                        int("minecraft:stone", 0)
                        int("minecraft:glass", 2)
                    }
                    byteArray("Data", byteArrayOf(0))
                }
            }
        }

        val failure = assertThrows(NbtFormatException::class.java) {
            decoder.readInfo(ByteArrayInputStream(bytes))
        }
        assertTrue(failure.message!!.contains("index 1"))
    }

    @Test
    fun `refuses block data that runs out before the build does`() {
        val bytes = NbtWriter.gzipped {
            compound("Schematic") {
                int("Version", 3)
                int("DataVersion", SchematicFixtures.SUPPORTED_DATA_VERSION)
                short("Width", 8)
                short("Height", 1)
                short("Length", 1)
                compound("Blocks") {
                    compound("Palette") { int("minecraft:stone", 0) }
                    byteArray("Data", byteArrayOf(0, 0))
                }
            }
        }

        assertThrows(NbtFormatException::class.java) { blocks(bytes) }
    }
}
