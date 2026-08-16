package net.integr.osmium.schematic.nbt

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.OutputStream
import java.util.zip.GZIPOutputStream

/**
 * Writes NBT, for tests only.
 *
 * The suite has no schematic files in it and should not: a fixture large enough to exercise the
 * reader is a fixture too large to keep in a repository, and one small enough to keep proves
 * nothing about the case that matters. So the tests build their input, which also means a test can
 * state the malformed thing it is about — a negative length, a truncated array — rather than
 * hunting for a file that happens to contain it.
 */
class NbtWriter private constructor(private val out: DataOutputStream) {

    fun byte(name: String, value: Int) = header(NbtType.BYTE, name).also { out.writeByte(value) }

    fun short(name: String, value: Int) = header(NbtType.SHORT, name).also { out.writeShort(value) }

    fun int(name: String, value: Int) = header(NbtType.INT, name).also { out.writeInt(value) }

    fun long(name: String, value: Long) = header(NbtType.LONG, name).also { out.writeLong(value) }

    fun double(name: String, value: Double) =
        header(NbtType.DOUBLE, name).also { out.writeDouble(value) }

    fun string(name: String, value: String) =
        header(NbtType.STRING, name).also { out.writeUTF(value) }

    fun byteArray(name: String, values: ByteArray) {
        header(NbtType.BYTE_ARRAY, name)
        out.writeInt(values.size)
        out.write(values)
    }

    fun intArray(name: String, values: IntArray) {
        header(NbtType.INT_ARRAY, name)
        out.writeInt(values.size)
        values.forEach(out::writeInt)
    }

    fun longArray(name: String, values: LongArray) {
        header(NbtType.LONG_ARRAY, name)
        out.writeInt(values.size)
        values.forEach(out::writeLong)
    }

    fun compound(name: String, body: NbtWriter.() -> Unit) {
        header(NbtType.COMPOUND, name)
        body()
        out.writeByte(NbtType.END.id)
    }

    /** A list of compounds, the shape both palettes and entity lists use. */
    fun compoundList(name: String, count: Int, body: NbtWriter.(index: Int) -> Unit) {
        header(NbtType.LIST, name)
        out.writeByte(NbtType.COMPOUND.id)
        out.writeInt(count)
        repeat(count) { index ->
            body(index)
            out.writeByte(NbtType.END.id)
        }
    }

    /** A list of a fixed-width type, written unnamed as the format requires. */
    fun doubleList(name: String, values: DoubleArray) {
        header(NbtType.LIST, name)
        out.writeByte(NbtType.DOUBLE.id)
        out.writeInt(values.size)
        values.forEach(out::writeDouble)
    }

    /** An empty list, which writers are free to type however they like. */
    fun emptyList(name: String, elementType: NbtType = NbtType.END) {
        header(NbtType.LIST, name)
        out.writeByte(elementType.id)
        out.writeInt(0)
    }

    /** Raw bytes, for tests that need to write something the writer would not produce. */
    fun raw(bytes: ByteArray) = out.write(bytes)

    private fun header(type: NbtType, name: String) {
        out.writeByte(type.id)
        out.writeUTF(name)
    }

    companion object {
        /** A whole document: the root compound and everything under it. */
        fun document(rootName: String = "", body: NbtWriter.() -> Unit): ByteArray {
            val bytes = ByteArrayOutputStream()
            DataOutputStream(bytes).use { out ->
                out.writeByte(NbtType.COMPOUND.id)
                out.writeUTF(rootName)
                NbtWriter(out).body()
                out.writeByte(NbtType.END.id)
            }
            return bytes.toByteArray()
        }

        /** The same, gzipped, which is how both formats are written in practice. */
        fun gzipped(rootName: String = "", body: NbtWriter.() -> Unit): ByteArray =
            gzip(document(rootName, body))

        fun gzip(payload: ByteArray): ByteArray {
            val bytes = ByteArrayOutputStream()
            GZIPOutputStream(bytes).use { it.write(payload) }
            return bytes.toByteArray()
        }

        /** Writes straight to a stream, for fixtures too large to hold as a byte array. */
        fun streamed(target: OutputStream, rootName: String = "", body: NbtWriter.() -> Unit) {
            val out = DataOutputStream(target)
            out.writeByte(NbtType.COMPOUND.id)
            out.writeUTF(rootName)
            NbtWriter(out).body()
            out.writeByte(NbtType.END.id)
            out.flush()
        }
    }
}
