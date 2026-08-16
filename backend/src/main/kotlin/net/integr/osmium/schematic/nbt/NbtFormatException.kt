package net.integr.osmium.schematic.nbt

import java.io.IOException

/**
 * The file is not the thing it claimed to be.
 *
 * An [IOException] rather than a runtime failure on purpose: every caller is already reading from a
 * stream that can fail, and a malformed upload is the same kind of event as a truncated one — the
 * read did not produce a schematic, and there is nothing to retry.
 */
class NbtFormatException(message: String) : IOException(message)
