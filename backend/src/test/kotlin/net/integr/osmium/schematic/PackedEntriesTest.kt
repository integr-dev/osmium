package net.integr.osmium.schematic

import net.integr.osmium.schematic.nbt.NbtFormatException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

/**
 * The one piece of arithmetic in the pipeline that fails by producing the wrong block rather than
 * an error. A packing that ignores long boundaries decodes every width that divides 64 correctly
 * and everything else into a different block, so a suite that only tries 4, 8 and 16 bits passes
 * on an implementation that is wrong for most real palettes.
 */
class PackedEntriesTest {

    private fun decode(bits: Int, count: Long, longs: LongArray): List<Int> {
        var at = 0
        val entries = PackedEntries(bits, count) {
            if (at >= longs.size) throw AssertionError("Read more longs than the array holds")
            longs[at++]
        }
        return buildList { while (entries.hasNext()) add(entries.next()) }
    }

    /** The format's own packing, written out plainly, so the round trip below tests both ways. */
    private fun pack(bits: Int, values: IntArray): LongArray {
        val longs = LongArray(((values.size.toLong() * bits + 63) / 64).toInt())
        values.forEachIndexed { index, value ->
            val startBit = index.toLong() * bits
            val start = (startBit ushr 6).toInt()
            val end = ((startBit + bits - 1) ushr 6).toInt()
            val offset = (startBit and 63L).toInt()

            longs[start] = longs[start] or (value.toLong() shl offset)
            if (start != end) longs[end] = longs[end] or (value.toLong() ushr (64 - offset))
        }
        return longs
    }

    @Test
    fun `decodes a hand-packed array`() {
        // Three five-bit entries in one long: 31 at bits 0-4, 0 at 5-9, 1 at 10-14.
        val longs = longArrayOf(31L or (1L shl 10))

        assertEquals(listOf(31, 0, 1), decode(bits = 5, count = 3, longs = longs))
    }

    @Test
    fun `decodes an entry that straddles two longs`() {
        // Entry 12 of a five-bit array occupies bits 60 through 64 — four bits at the top of the
        // first long and one at the bottom of the second. This is the case the naive packing gets
        // wrong, and it gets it wrong by returning 15 instead of 31: a real block, just not this one.
        val longs = longArrayOf(0xF000000000000000UL.toLong(), 1L)

        assertEquals(31, decode(bits = 5, count = 13, longs = longs)[12])
    }

    @Test
    fun `round-trips every width a palette can produce`() {
        // 2 through 16 covers every palette from one block state to 65,536 of them, which is past
        // anything a region holds.
        (2..16).forEach { bits ->
            val limit = (1 shl bits) - 1
            val values = IntArray(500) { (it * 37) % (limit + 1) }

            assertEquals(values.toList(), decode(bits, values.size.toLong(), pack(bits, values)))
        }
    }

    @Test
    fun `never reads a long twice or out of order`() {
        // The reason streaming works at all: entry n's first long is never before entry n-1's, so
        // a source that only goes forward is enough. A decoder that seeks backwards would be
        // correct against an array in memory and impossible against a stream.
        val values = IntArray(1000) { it % 32 }
        val longs = pack(5, values)
        var handed = 0

        val entries = PackedEntries(5, values.size.toLong()) { longs[handed++] }
        repeat(values.size) { entries.next() }

        assertEquals(longs.size, handed)
    }

    @Test
    fun `states how many longs the array should hold`() {
        // Checked against the length the file declares. A mismatch means header and payload
        // disagree, and reading on would run out of one region and into the next.
        assertEquals(1L, PackedEntries(5, 12) { 0 }.expectedLongs())
        assertEquals(2L, PackedEntries(5, 13) { 0 }.expectedLongs())
        assertEquals(1L, PackedEntries(4, 16) { 0 }.expectedLongs())
    }

    @Test
    fun `uses two bits for a palette that would fit in one`() {
        // The format has no zero- or one-bit encoding, and a region of a single block state is an
        // ordinary thing to save.
        assertEquals(2, PackedEntries.bitsFor(1))
        assertEquals(2, PackedEntries.bitsFor(4))
        assertEquals(3, PackedEntries.bitsFor(5))
        assertEquals(8, PackedEntries.bitsFor(256))
        assertEquals(9, PackedEntries.bitsFor(257))
    }

    @Test
    fun `refuses to read past the end`() {
        val entries = PackedEntries(5, 1) { 0 }
        entries.next()

        assertThrows(NbtFormatException::class.java) { entries.next() }
    }
}
