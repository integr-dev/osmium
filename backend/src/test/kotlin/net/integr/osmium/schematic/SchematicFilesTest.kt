package net.integr.osmium.schematic

import net.integr.osmium.schematic.SchematicFixtures.SUPPORTED_DATA_VERSION
import net.integr.osmium.schematic.SchematicFixtures.litematic
import net.integr.osmium.schematic.SchematicFixtures.region
import net.integr.osmium.schematic.SchematicFixtures.sponge
import net.integr.osmium.schematic.config.SchematicProperties
import net.integr.osmium.schematic.config.SchematicProperties.Companion.MINECRAFT_1_13
import net.integr.osmium.schematic.nbt.NbtFormatException
import net.integr.osmium.schematic.nbt.NbtWriter
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

/**
 * Picking the format and refusing the wrong game version — the two things that happen before a
 * schematic is trusted at all.
 */
class SchematicFilesTest {

    private fun files(min: Int = MINECRAFT_1_13, max: Int = SUPPORTED_DATA_VERSION) = SchematicFiles(
        listOf(LitematicDecoder(), SpongeDecoder()),
        SchematicProperties(minDataVersion = min, maxDataVersion = max),
    )

    private val cube = region(
        size = Vec3i(2, 1, 1),
        palette = listOf("minecraft:air", "minecraft:stone"),
        states = intArrayOf(0, 1),
    )

    /** Counts what actually came off the wire, so a test can say a read stopped early. */
    private class Counting(private val delegate: InputStream) : InputStream() {
        var count = 0L

        override fun read(): Int = delegate.read().also { if (it >= 0) count += 1 }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
            delegate.read(buffer, offset, length).also { if (it > 0) count += it }
    }

    @Test
    fun `tells the two formats apart from their contents`() {
        // Not from the extension: that is whatever the operator typed, and both formats are NBT
        // underneath, so the file is the only thing that knows what it is.
        assertEquals(
            SchematicFormat.LITEMATIC,
            files().detect(ByteArrayInputStream(litematic(listOf(cube)))).format,
        )
        assertEquals(
            SchematicFormat.SPONGE,
            files().detect(ByteArrayInputStream(sponge(cube, version = 2))).format,
        )
        assertEquals(
            SchematicFormat.SPONGE,
            files().detect(ByteArrayInputStream(sponge(cube, version = 3))).format,
        )
    }

    @Test
    fun `settles the format without reading the build`() {
        // The tag that decides it in a litematic is `Regions`, which holds everything. Checking the
        // name before the value is what keeps detection cheap; skipping past it would decompress
        // the whole file to learn something already known.
        val big = litematic(
            listOf(
                region(
                    size = Vec3i(64, 64, 64),
                    palette = listOf("minecraft:air", "minecraft:stone"),
                    states = IntArray(64 * 64 * 64) { it % 2 },
                )
            ),
            compressed = false,
        )
        val counting = Counting(ByteArrayInputStream(big))

        files().detect(counting)

        assertTrue(big.size > 60_000, "the fixture should be big enough for this to mean something")
        // Some read-ahead is unavoidable — the reader is buffered — but it is a fixed window, not
        // a share of the file.
        assertTrue(counting.count < 16_384, "detection read ${counting.count} bytes of ${big.size}")
    }

    @Test
    fun `names the legacy schematic format rather than calling it unrecognised`() {
        // MCEdit's .schematic: numeric block ids and a data nibble, no palette, no data version.
        // It shares an extension with files people have renamed, so it arrives by accident — and
        // it is the one unsupported format an operator can actually do something about.
        val bytes = NbtWriter.gzipped("Schematic") {
            short("Width", 4)
            short("Height", 4)
            short("Length", 4)
            string("Materials", "Alpha")
            byteArray("Blocks", ByteArray(64) { 1 })
            byteArray("Data", ByteArray(64))
        }

        val failure = assertThrows(NbtFormatException::class.java) {
            files().detect(ByteArrayInputStream(bytes))
        }
        assertTrue(failure.message!!.contains("MCEdit"))
        // Says what to do about it. "Unrecognised" would have them concluding the file is broken.
        assertTrue(failure.message!!.contains(".litematic"))
    }

    @Test
    fun `reads a modern file whatever it has been named`() {
        // Format comes from the contents, so a Sponge file saved as .schematic is just a Sponge
        // file. Nothing here sees the name at all — which is why the picker can accept all three.
        assertEquals(
            SchematicFormat.SPONGE,
            files().detect(ByteArrayInputStream(sponge(cube, version = 3))).format,
        )
    }

    @Test
    fun `refuses NBT that is neither format`() {
        val bytes = NbtWriter.gzipped { string("Name", "not a schematic") }

        val failure = assertThrows(NbtFormatException::class.java) {
            files().detect(ByteArrayInputStream(bytes))
        }
        assertTrue(failure.message!!.contains("neither"))
    }

    @Test
    fun `opens a schematic from a version it builds`() {
        val bytes = litematic(listOf(cube))

        val info = files().open { ByteArrayInputStream(bytes) }

        assertEquals(SUPPORTED_DATA_VERSION, info.dataVersion)
    }

    @Test
    fun `accepts a schematic from an older Minecraft`() {
        // 2566 is 1.16. Most blocks did not change between then and now, and refusing a build for
        // being old would refuse most of the builds anyone has.
        val bytes = litematic(listOf(cube), dataVersion = 2566)

        assertEquals(2566, files().open { ByteArrayInputStream(bytes) }.dataVersion)
    }

    @Test
    fun `refuses a schematic from before blocks had names`() {
        // 1.12 and earlier stored numeric ids. There is nothing in such a file to read as a block
        // name, so this end of the range is about the format rather than about compatibility.
        val bytes = litematic(listOf(cube), dataVersion = 1000)

        val failure = assertThrows(UnsupportedVersionException::class.java) {
            files().open { ByteArrayInputStream(bytes) }
        }
        assertTrue(failure.message!!.contains("1000"))
        assertTrue(failure.message!!.contains("$MINECRAFT_1_13"))
    }

    @Test
    fun `refuses a schematic from a Minecraft newer than the fleet plays`() {
        // The end that actually bites. A newer file names blocks that do not exist yet, and the
        // game being backwards compatible does nothing about that.
        val newer = SUPPORTED_DATA_VERSION + 100
        val bytes = litematic(listOf(cube), dataVersion = newer)

        val failure = assertThrows(UnsupportedVersionException::class.java) {
            files().open { ByteArrayInputStream(bytes) }
        }
        assertTrue(failure.message!!.contains("$newer"))
    }

    @Test
    fun `can be narrowed to one version`() {
        // A deployment that would rather refuse anything but its own version sets both ends alike.
        val bytes = litematic(listOf(cube), dataVersion = 2566)

        assertThrows(UnsupportedVersionException::class.java) {
            files(min = SUPPORTED_DATA_VERSION).open { ByteArrayInputStream(bytes) }
        }
    }

    @Test
    fun `refuses a litematic that never recorded its version`() {
        // Written before Litematica stored one. Reported as 0 rather than guessed — a schematic
        // whose version is unknown is exactly the one not to build from.
        val bytes = NbtWriter.gzipped {
            compound("Regions") {
                compound("main") {
                    compound("Position") { int("x", 0); int("y", 0); int("z", 0) }
                    compound("Size") { int("x", 1); int("y", 1); int("z", 1) }
                    compoundList("BlockStatePalette", 1) { string("Name", "minecraft:stone") }
                    longArray("BlockStates", longArrayOf(0))
                }
            }
        }

        assertThrows(UnsupportedVersionException::class.java) {
            files().open { ByteArrayInputStream(bytes) }
        }
    }
}
