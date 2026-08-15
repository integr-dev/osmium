package net.integr.osmium.schematic.nbt

/**
 * The thirteen NBT tag types, by their on-wire id.
 *
 * NBT is the container both schematic formats are written in: a tree of named, length-prefixed,
 * big-endian tags, usually gzipped. It is small enough to read directly, which is the point — every
 * NBT library available builds the whole tree in memory, and a schematic of the size Osmium accepts
 * cannot be held that way. See [NbtInput].
 */
enum class NbtType(val id: Int) {
    END(0),
    BYTE(1),
    SHORT(2),
    INT(3),
    LONG(4),
    FLOAT(5),
    DOUBLE(6),
    BYTE_ARRAY(7),
    STRING(8),
    LIST(9),
    COMPOUND(10),
    INT_ARRAY(11),
    LONG_ARRAY(12);

    companion object {
        private val BY_ID = entries.associateBy(NbtType::id)

        fun of(id: Int): NbtType =
            BY_ID[id] ?: throw NbtFormatException("Unknown NBT tag type $id")
    }
}
