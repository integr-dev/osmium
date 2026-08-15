package net.integr.osmium.schematic

import net.integr.osmium.schematic.nbt.NbtFormatException

/** A forward-only source of the longs behind a packed array. */
fun interface LongSource {
    fun next(): Long
}

/**
 * Decodes Litematica's packed block-state array, one entry at a time, without holding it.
 *
 * Litematica stores a region's blocks as palette indices of [bits] bits each, packed end to end
 * across a `long[]` with **no regard for long boundaries** — an entry may begin in one long and
 * finish in the next. That straddling is the whole difficulty. The obvious implementation packs
 * each long independently, which produces the right answer for every `bits` that divides 64 and
 * quietly wrong blocks for every other one, most of the palettes in practice among them.
 *
 * Sequential access is what makes streaming possible: entry *n*'s first long is never before entry
 * *n-1*'s, so two buffered longs are enough however large the array is.
 */
class PackedEntries(
    private val bits: Int,
    private val count: Long,
    private val longs: LongSource,
) {
    init {
        if (bits !in 1..32) throw NbtFormatException("A palette index of $bits bits is not a palette")
    }

    private val mask = (1L shl bits) - 1

    private var index = 0L

    /** Position in the long array of [current], or -1 before anything has been read. */
    private var position = -1L
    private var current = 0L
    private var upcoming = 0L
    private var upcomingLoaded = false

    fun hasNext(): Boolean = index < count

    fun next(): Int {
        if (!hasNext()) throw NbtFormatException("Read past the end of a packed array of $count")

        val startBit = index * bits
        val start = startBit ushr 6
        val end = (startBit + bits - 1) ushr 6
        val offset = (startBit and 63L).toInt()

        advanceTo(start)

        val value = if (start == end) {
            (current ushr offset) and mask
        } else {
            loadUpcoming()
            // `offset` cannot be 0 here: an entry starting on a long boundary is at most 32 bits
            // and therefore cannot straddle. That matters, because a shift of 64 on the JVM is a
            // shift of 0, so this line would silently keep the low bits it means to discard.
            ((current ushr offset) or (upcoming shl (64 - offset))) and mask
        }

        index += 1
        return value.toInt()
    }

    /**
     * The longs an array of this shape occupies. The file states its own length, and a mismatch
     * means the header and the payload disagree — worth catching, because the reader would
     * otherwise run off the end of one region and into the next.
     */
    fun expectedLongs(): Long = (count * bits + 63) / 64

    private fun advanceTo(target: Long) {
        while (position < target) {
            current = if (upcomingLoaded) upcoming.also { upcomingLoaded = false } else longs.next()
            position += 1
        }
    }

    private fun loadUpcoming() {
        if (upcomingLoaded) return
        upcoming = longs.next()
        upcomingLoaded = true
    }

    companion object {
        /**
         * The width Litematica uses for a palette of `size` entries.
         *
         * Two is the floor even for a palette of one: the format has no zero-bit encoding, and a
         * region of a single block state is a real thing to save.
         */
        fun bitsFor(size: Int): Int {
            var bits = 2
            while ((1 shl bits) < size) bits += 1
            return bits
        }
    }
}
