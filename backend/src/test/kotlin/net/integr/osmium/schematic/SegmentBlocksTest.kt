package net.integr.osmium.schematic

import org.junit.jupiter.api.Test
import java.nio.ByteBuffer
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The packed segment format.
 *
 * A pure function over arithmetic that looks right and can be wrong by one, which is the class of
 * bug this suite exists for: a linear index computed in the wrong axis order still produces a
 * perfectly well-formed body, and the building comes out inside out.
 */
class SegmentBlocksTest {

    private val min = Vec3i(100, 64, -30)
    private val size = Vec3i(4, 2, 3)

    /**
     * The order both decoders read in, and therefore the order a host builds in: y outermost, then
     * z, then x. Getting this wrong is the difference between a wall and a floor.
     */
    @Test
    fun `linear index runs y then z then x`() {
        assertEquals(0, SegmentBlocks.linearOf(100, 64, -30, min, size))
        // One step in x is one step in the stream.
        assertEquals(1, SegmentBlocks.linearOf(101, 64, -30, min, size))
        // One step in z skips a row of x.
        assertEquals(4, SegmentBlocks.linearOf(100, 64, -29, min, size))
        // One step in y skips a whole layer: dx * dz.
        assertEquals(12, SegmentBlocks.linearOf(100, 65, -30, min, size))
        // The last position in the box.
        assertEquals(23, SegmentBlocks.linearOf(103, 65, -28, min, size))
    }

    /** Half-open, matching the split it came from: `max` is the first block *not* in the segment. */
    @Test
    fun `anything outside the box has no place in the stream`() {
        assertNull(SegmentBlocks.linearOf(99, 64, -30, min, size))
        assertNull(SegmentBlocks.linearOf(104, 64, -30, min, size))
        assertNull(SegmentBlocks.linearOf(100, 66, -30, min, size))
        assertNull(SegmentBlocks.linearOf(100, 64, -27, min, size))
    }

    /** Position above material, so sorting the packed values is sorting by position. */
    @Test
    fun `packing survives the round trip and orders by position`() {
        val packed = SegmentBlocks.pack(70_000, 513)

        assertEquals(70_000, SegmentBlocks.linearOf(packed))
        assertEquals(513, SegmentBlocks.paletteOf(packed))
        assert(SegmentBlocks.pack(1, 65_535) < SegmentBlocks.pack(2, 0))
    }

    @Test
    fun `a segment encodes to its header and one record per block`() {
        val blocks = longArrayOf(
            SegmentBlocks.pack(0, 0),
            SegmentBlocks.pack(5, 1),
            SegmentBlocks.pack(23, 0),
        )

        val body = ByteBuffer.wrap(
            SegmentBlocks.encode(min, size, listOf("stone", "oak_planks"), blocks),
        )

        assertEquals("OSM1", String(ByteArray(4).also { body.get(it) }, Charsets.UTF_8))

        assertEquals(2, body.short.toInt())
        assertEquals("stone", body.readName())
        assertEquals("oak_planks", body.readName())

        assertEquals(100, body.int)
        assertEquals(64, body.int)
        assertEquals(-30, body.int)
        assertEquals(4, body.int)
        assertEquals(2, body.int)
        assertEquals(3, body.int)

        assertEquals(3, body.int)
        assertEquals(0, body.int)
        assertEquals(0, body.short.toInt())
        assertEquals(5, body.int)
        assertEquals(1, body.short.toInt())
        assertEquals(23, body.int)
        assertEquals(0, body.short.toInt())

        // Exactly the header and the records, with nothing trailing.
        assertEquals(0, body.remaining())
    }

    /**
     * A segment nobody has to build is a real answer, not an error: a split can hand out a box whose
     * blocks were all substituted away, and the host should be told so rather than left waiting.
     */
    @Test
    fun `an empty segment is still a well-formed body`() {
        val body = ByteBuffer.wrap(SegmentBlocks.encode(min, size, emptyList(), LongArray(0)))

        assertEquals("OSM1", String(ByteArray(4).also { body.get(it) }, Charsets.UTF_8))
        assertEquals(0, body.short.toInt())
        repeat(6) { body.int }
        assertEquals(0, body.int)
        assertEquals(0, body.remaining())
    }

    /**
     * `count` bounds what is read, so the caller's growable buffer can be longer than its contents
     * without the slack arriving as blocks at the origin.
     */
    @Test
    fun `only the first count blocks are written`() {
        val buffer = LongArray(8)
        buffer[0] = SegmentBlocks.pack(7, 0)

        val body = ByteBuffer.wrap(SegmentBlocks.encode(min, size, listOf("stone"), buffer, count = 1))

        skipHeader(body, names = 1)
        assertEquals(1, body.int)
        assertEquals(7, body.int)
        assertEquals(0, body.short.toInt())
        assertEquals(0, body.remaining())
    }

    /**
     * A `u32` index past 2^31 arrives as a negative `Int` in Java and as the right unsigned value on
     * the wire. Worth pinning: the box that reaches it is one nobody will build, but silently
     * wrapping is how blocks end up somewhere nobody asked for.
     */
    @Test
    fun `a position past two billion survives as unsigned`() {
        val far = 3_000_000_000L
        val body = ByteBuffer.wrap(
            SegmentBlocks.encode(
                Vec3i(0, 0, 0),
                Vec3i(2000, 2000, 2000),
                listOf("stone"),
                longArrayOf(SegmentBlocks.pack(far, 0)),
            ),
        )

        skipHeader(body, names = 1)
        body.int

        assertEquals(far, body.int.toLong() and 0xFFFF_FFFFL)
    }

    @Test
    fun `the box a format can index is bounded`() {
        assertEquals(8L, SegmentBlocks.positionsIn(Vec3i(2, 2, 2)))
        // Past a u32, which the endpoint refuses rather than wrapping.
        assert(SegmentBlocks.positionsIn(Vec3i(2000, 2000, 2000)) > SegmentBlocks.MAX_POSITIONS)
    }

    /** Magic, palette, box and the count: everything before the records. */
    private fun skipHeader(body: ByteBuffer, names: Int) {
        body.get(ByteArray(4))
        assertEquals(names, body.short.toInt())
        repeat(names) { body.readName() }
        repeat(6) { body.int }
    }

    private fun ByteBuffer.readName(): String {
        val length = short.toInt()
        return String(ByteArray(length).also { get(it) }, Charsets.UTF_8)
    }
}
