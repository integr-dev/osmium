package net.integr.osmium.schematic.nbt

import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.InputStream
import java.io.PushbackInputStream
import java.util.zip.GZIPInputStream

/** A named tag, as it is met in the stream. */
data class NbtField(val type: NbtType, val name: String)

/** The element type and length of a `TAG_List`, read from its header. */
data class NbtList(val elementType: NbtType, val length: Int)

/**
 * A pull reader for NBT that never holds more of the file than the caller asks for.
 *
 * Every NBT library builds the tag tree in memory. Osmium accepts schematics whose block array
 * alone runs to gigabytes, so the tree is exactly the thing that cannot exist — hence a reader that
 * walks the stream and hands the caller two choices at every tag: read the value, or skip it.
 * Skipping is what makes the size tractable, because a decoder wants four fields out of a file and
 * has no use for the rest.
 *
 * Nothing here allocates in proportion to the file. Arrays are read as a length followed by
 * elements the caller pulls one at a time, so a long array of four hundred million entries costs
 * eight bytes at a time and no more.
 *
 * **This parses uploads, which is to say hostile input.** Two things protect it: the skip path
 * never allocates, and nesting is bounded — a file consisting of ten thousand opening compounds is
 * a stack overflow otherwise, and a stack overflow is not an exception a request handler recovers
 * from cleanly.
 */
class NbtInput(source: InputStream) : AutoCloseable {
    private val data = DataInputStream(source)

    /** Nesting entered by [skipValue], which is the only path that recurses. */
    private var depth = 0

    /**
     * Reads the root tag's header and returns its name, which is conventionally empty.
     *
     * Every NBT document is a single named compound. A file whose first byte is anything else is
     * not NBT — most often it is a file that was never decompressed, so this is where a wrong guess
     * about compression surfaces.
     */
    fun beginCompound(): String {
        val type = NbtType.of(data.readUnsignedByte())
        if (type != NbtType.COMPOUND) {
            throw NbtFormatException("Expected a compound at the root of the file, found $type")
        }
        return data.readUTF()
    }

    /** The next field of the compound being read, or null at its closing `TAG_End`. */
    fun nextField(): NbtField? {
        val type = NbtType.of(data.readUnsignedByte())
        if (type == NbtType.END) return null
        return NbtField(type, data.readUTF())
    }

    fun readByte(): Byte = data.readByte()

    fun readShort(): Short = data.readShort()

    fun readInt(): Int = data.readInt()

    fun readLong(): Long = data.readLong()

    fun readFloat(): Float = data.readFloat()

    fun readDouble(): Double = data.readDouble()

    fun readString(): String = data.readUTF()

    /**
     * The header of a `TAG_List`. Its elements follow, unnamed and all of [NbtList.elementType],
     * and the caller reads exactly [NbtList.length] of them.
     */
    fun beginList(): NbtList {
        val elementType = NbtType.of(data.readUnsignedByte())
        val length = readLength()
        // An empty list carries no element type to state, and writers disagree about what to put
        // there — TAG_End is the usual choice. Any of them is fine as long as nothing is read.
        if (length == 0) return NbtList(elementType, 0)
        if (elementType == NbtType.END) {
            throw NbtFormatException("A list of $length elements has no element type")
        }
        return NbtList(elementType, length)
    }

    /**
     * The element count of a byte, int or long array. The elements follow and are read one at a
     * time — there is deliberately no call that returns the whole array.
     */
    fun beginArray(): Int = readLength()

    /** Fills `buffer` from a byte array's elements. */
    fun readBytes(buffer: ByteArray, offset: Int, length: Int) {
        data.readFully(buffer, offset, length)
    }

    /**
     * Discards `count` bytes of an array whose elements the caller has finished with.
     *
     * A byte array may be longer than the values encoded in it, and the tail still has to go
     * somewhere: leaving it unread ends the array in the middle and every tag after it is read from
     * the wrong offset.
     */
    fun skipBytes(count: Long) = skip(count)

    /** Discards the value of a tag whose header has just been read. */
    fun skipValue(type: NbtType) {
        when (type) {
            NbtType.END -> Unit
            NbtType.BYTE -> skip(1)
            NbtType.SHORT -> skip(2)
            NbtType.INT -> skip(4)
            NbtType.LONG -> skip(8)
            NbtType.FLOAT -> skip(4)
            NbtType.DOUBLE -> skip(8)
            NbtType.BYTE_ARRAY -> skip(readLength().toLong())
            NbtType.INT_ARRAY -> skip(readLength().toLong() * 4)
            NbtType.LONG_ARRAY -> skip(readLength().toLong() * 8)
            NbtType.STRING -> skip(data.readUnsignedShort().toLong())
            NbtType.LIST -> skipList()
            NbtType.COMPOUND -> skipCompound()
        }
    }

    private fun skipList() = nested {
        val list = beginList()
        // Fixed-width elements are one multiplication rather than `length` seeks, which matters:
        // an entity list can hold millions of doubles and seeking each is a syscall's worth of work
        // for eight bytes.
        val width = widthOf(list.elementType)
        if (width > 0) skip(list.length.toLong() * width)
        else repeat(list.length) { skipValue(list.elementType) }
    }

    private fun skipCompound() = nested {
        while (true) {
            val field = nextField() ?: return@nested
            skipValue(field.type)
        }
    }

    /**
     * Bytes per element for the types that have a fixed width, and 0 for the ones that do not.
     * Only used to turn a skip over many elements into a single seek.
     */
    private fun widthOf(type: NbtType): Int = when (type) {
        NbtType.BYTE -> 1
        NbtType.SHORT -> 2
        NbtType.INT, NbtType.FLOAT -> 4
        NbtType.LONG, NbtType.DOUBLE -> 8
        else -> 0
    }

    private inline fun nested(body: () -> Unit) {
        if (++depth > MAX_DEPTH) {
            throw NbtFormatException("NBT nested deeper than $MAX_DEPTH, which no schematic is")
        }
        try {
            body()
        } finally {
            depth -= 1
        }
    }

    /**
     * An array or list length. Negative is the one value worth rejecting by hand: it is what a
     * writer produces when an element count overflows a signed int, and left alone it turns into a
     * negative skip, which is silently no skip at all and a stream that reads garbage from there on.
     */
    private fun readLength(): Int {
        val length = data.readInt()
        if (length < 0) throw NbtFormatException("Negative element count $length")
        return length
    }

    private fun skip(bytes: Long) {
        if (bytes > 0) data.skipNBytes(bytes)
    }

    override fun close() = data.close()

    companion object {
        /**
         * Deep enough for any schematic — the deepest real nesting is a region's tile entities,
         * about six levels — and shallow enough that the recursion in [skipValue] cannot exhaust
         * the stack on a file built to try.
         */
        const val MAX_DEPTH = 512

        private const val GZIP_MAGIC_FIRST = 0x1f
        private const val GZIP_MAGIC_SECOND = 0x8b

        /**
         * Opens a schematic's stream, decompressing it when it turns out to be gzipped.
         *
         * Both formats are conventionally gzipped and neither requires it, so the extension says
         * nothing and the first two bytes say everything. Sniffing rather than trusting also means
         * a file the operator decompressed by hand still opens, instead of failing with a message
         * about the root tag that explains nothing.
         */
        fun open(source: InputStream): InputStream {
            val head = PushbackInputStream(source, 2)
            val first = head.read()
            val second = head.read()
            if (second >= 0) head.unread(second)
            if (first >= 0) head.unread(first)

            val compressed = first == GZIP_MAGIC_FIRST && second == GZIP_MAGIC_SECOND
            // Buffered on both sides of the decompressor: GZIPInputStream reads its source in
            // small pieces, and the reader above pulls two to eight bytes at a time.
            return if (compressed) BufferedInputStream(GZIPInputStream(BufferedInputStream(head)))
            else BufferedInputStream(head)
        }
    }
}
