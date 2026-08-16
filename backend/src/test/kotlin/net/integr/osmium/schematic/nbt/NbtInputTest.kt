package net.integr.osmium.schematic.nbt

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.DataOutputStream
import java.io.ByteArrayOutputStream

/**
 * The reader under the whole schematic pipeline.
 *
 * What is worth testing here is not that a byte is a byte. It is that **skipping lands in the right
 * place** — every decoder above reads four fields out of a file and skips the rest, so a skip that
 * is off by one leaves the stream misaligned and the next tag is read out of the middle of a value.
 * That failure does not throw where it happens; it throws several tags later, or worse, produces a
 * plausible number.
 */
class NbtInputTest {

    private fun read(bytes: ByteArray): NbtInput = NbtInput(NbtInput.open(ByteArrayInputStream(bytes)))

    /** Walks a compound to the named field, skipping everything before it. */
    private fun NbtInput.seek(name: String): NbtType {
        while (true) {
            val field = nextField() ?: throw AssertionError("No field named $name")
            if (field.name == name) return field.type
            skipValue(field.type)
        }
    }

    @Test
    fun `reads the root name and every scalar type`() {
        val bytes = NbtWriter.document("root") {
            byte("b", 7)
            short("s", 1234)
            int("i", -5)
            long("l", 1L shl 40)
            double("d", 0.5)
            string("str", "cathedral")
        }

        read(bytes).use { input ->
            assertEquals("root", input.beginCompound())
            assertEquals(NbtType.BYTE, input.nextField()!!.type)
            assertEquals(7, input.readByte().toInt())
            input.nextField()
            assertEquals(1234, input.readShort().toInt())
            input.nextField()
            assertEquals(-5, input.readInt())
            input.nextField()
            assertEquals(1L shl 40, input.readLong())
            input.nextField()
            assertEquals(0.5, input.readDouble())
            input.nextField()
            assertEquals("cathedral", input.readString())
            assertNull(input.nextField())
        }
    }

    @Test
    fun `skips past every type to reach a later field`() {
        val bytes = NbtWriter.document {
            byte("skipped1", 1)
            string("skipped2", "a somewhat longer string, to make a wrong length visible")
            byteArray("skipped3", ByteArray(300) { it.toByte() })
            intArray("skipped4", IntArray(70) { it })
            longArray("skipped5", LongArray(40) { it.toLong() })
            doubleList("skipped6", DoubleArray(50) { it.toDouble() })
            compoundList("skipped7", 3) { index -> int("inner", index) }
            compound("skipped8") { compound("deeper") { string("x", "y") } }
            emptyList("skipped9")
            int("wanted", 99)
        }

        read(bytes).use { input ->
            input.beginCompound()
            assertEquals(NbtType.INT, input.seek("wanted"))
            // The whole point: one wrong length anywhere above and this reads bytes from the
            // middle of some other value, usually without failing.
            assertEquals(99, input.readInt())
        }
    }

    @Test
    fun `reads a list of compounds, which is what a palette is`() {
        val bytes = NbtWriter.document {
            compoundList("BlockStatePalette", 2) { index ->
                string("Name", "minecraft:stone_$index")
            }
        }

        read(bytes).use { input ->
            input.beginCompound()
            input.seek("BlockStatePalette")
            val list = input.beginList()
            assertEquals(NbtType.COMPOUND, list.elementType)
            assertEquals(2, list.length)

            val names = (0 until list.length).map {
                input.nextField()
                val name = input.readString()
                assertNull(input.nextField())
                name
            }
            assertEquals(listOf("minecraft:stone_0", "minecraft:stone_1"), names)
        }
    }

    @Test
    fun `reads a long array one element at a time`() {
        val values = LongArray(2048) { it.toLong() * 31 }
        val bytes = NbtWriter.document { longArray("BlockStates", values) }

        read(bytes).use { input ->
            input.beginCompound()
            input.seek("BlockStates")
            assertEquals(values.size, input.beginArray())
            // Never as an array. A real one of these is hundreds of megabytes, and a call that
            // returned it would be the one place the whole design fails.
            values.forEach { assertEquals(it, input.readLong()) }
        }
    }

    @Test
    fun `opens a gzipped file and an uncompressed one alike`() {
        val body: NbtWriter.() -> Unit = { int("Version", 6) }

        listOf(NbtWriter.gzipped(body = body), NbtWriter.document(body = body)).forEach { bytes ->
            read(bytes).use { input ->
                input.beginCompound()
                input.seek("Version")
                // Neither format requires compression, so the extension says nothing about it and
                // the first two bytes say everything.
                assertEquals(6, input.readInt())
            }
        }
    }

    @Test
    fun `rejects a file that is not NBT at all`() {
        // Whatever the operator uploaded, it was not this. Rejected on the first byte, which is
        // not a tag type — the common case is a zip, since a .schem is sometimes shipped inside one.
        assertThrows(NbtFormatException::class.java) {
            read("this is a zip file, actually".toByteArray()).use { it.beginCompound() }
        }
    }

    @Test
    fun `rejects NBT whose root is not a compound`() {
        val bytes = ByteArrayOutputStream().also { out ->
            DataOutputStream(out).run {
                writeByte(NbtType.INT.id)
                writeUTF("")
                writeInt(1)
            }
        }.toByteArray()

        // Valid NBT, wrong shape. Worth its own message: this is what an undecompressed file looks
        // like once the gzip sniff has been fooled, and "unknown tag type" would send the operator
        // looking in the wrong place.
        val failure = assertThrows(NbtFormatException::class.java) {
            read(bytes).use { it.beginCompound() }
        }
        assertEquals(true, failure.message!!.contains("root"))
    }

    @Test
    fun `rejects a negative element count rather than skipping backwards`() {
        val bytes = ByteArrayOutputStream().also { out ->
            DataOutputStream(out).run {
                writeByte(NbtType.COMPOUND.id)
                writeUTF("")
                writeByte(NbtType.BYTE_ARRAY.id)
                writeUTF("BlockData")
                // What a writer produces when an element count overflows a signed int. Left alone
                // it is a negative skip, which is no skip at all and a stream misaligned from here
                // on — the failure surfaces much later, as nonsense rather than as an error.
                writeInt(-1)
            }
        }.toByteArray()

        read(bytes).use { input ->
            input.beginCompound()
            val field = input.nextField()!!
            assertThrows(NbtFormatException::class.java) { input.skipValue(field.type) }
        }
    }

    @Test
    fun `refuses to recurse forever on a file built to try`() {
        val bytes = ByteArrayOutputStream().also { out ->
            DataOutputStream(out).run {
                writeByte(NbtType.COMPOUND.id)
                writeUTF("")
                // Ten thousand compounds, none of them closed. Uploads are hostile input, and a
                // stack overflow is not something a request handler recovers from cleanly.
                repeat(10_000) {
                    writeByte(NbtType.COMPOUND.id)
                    writeUTF("deeper")
                }
            }
        }.toByteArray()

        read(bytes).use { input ->
            input.beginCompound()
            val field = input.nextField()!!
            assertThrows(NbtFormatException::class.java) { input.skipValue(field.type) }
        }
    }

    @Test
    fun `rejects an unknown tag type`() {
        val bytes = ByteArrayOutputStream().also { out ->
            DataOutputStream(out).run {
                writeByte(NbtType.COMPOUND.id)
                writeUTF("")
                writeByte(77)
            }
        }.toByteArray()

        read(bytes).use { input ->
            input.beginCompound()
            assertThrows(NbtFormatException::class.java) { input.nextField() }
        }
    }
}
