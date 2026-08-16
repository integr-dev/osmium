package net.integr.osmium.schematic.service

import net.integr.osmium.schematic.config.SchematicProperties
import org.springframework.stereotype.Component
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import kotlin.io.path.exists
import kotlin.io.path.fileSize
import kotlin.io.path.name

/**
 * The files, on a volume rather than in the database.
 *
 * A schematic here can run to gigabytes and a Postgres value caps out at one, so the row describes
 * the file and this owns it. That split is what makes the two able to disagree — a crash between
 * writing bytes and committing a row leaves a file longer than the row admits — and why
 * [SchematicReconciler] exists.
 *
 * One file per schematic, named by its id. Nothing is derived from the operator's name: it is
 * theirs to change, may contain anything, and a path built from user input is a path traversal
 * waiting to be written.
 */
@Component
class SchematicStorage(private val properties: SchematicProperties) {

    private val root: Path = properties.directory.toAbsolutePath().normalize()

    init {
        Files.createDirectories(root)
    }

    fun pathOf(id: Long): Path = root.resolve("$id.schematic")

    fun exists(id: Long): Boolean = pathOf(id).exists()

    /** Bytes actually on disk, which is the only authority on how much arrived. */
    fun sizeOf(id: Long): Long = pathOf(id).let { if (it.exists()) it.fileSize() else 0 }

    fun open(id: Long): InputStream = Files.newInputStream(pathOf(id))

    /**
     * Appends to the end of the file, creating it if this is the first chunk.
     *
     * `APPEND` rather than a seek to `offset`: the caller has already checked that the offset it
     * was given matches what is on disk, and appending means a write can never land in the middle
     * of a file and leave a hole of zeroes that reads as valid data.
     */
    fun append(id: Long, body: (OutputStream) -> Unit) {
        Files.newOutputStream(
            pathOf(id),
            StandardOpenOption.CREATE,
            StandardOpenOption.WRITE,
            StandardOpenOption.APPEND,
        ).use(body)
    }

    /** Cuts a file back to what the row believes arrived, after a crash mid-write. */
    fun truncate(id: Long, size: Long) {
        Files.newByteChannel(pathOf(id), StandardOpenOption.WRITE).use { it.truncate(size) }
    }

    fun delete(id: Long) {
        Files.deleteIfExists(pathOf(id))
    }

    /**
     * The ids of every file present, whether or not a row claims it.
     *
     * Used to find files no row owns. They are the residue of an upload that died between creating
     * the file and committing the row, and nothing else will ever look at them — so without this
     * they accumulate at the size of the uploads that failed.
     */
    fun storedIds(): Set<Long> {
        if (!root.exists()) return emptySet()
        Files.list(root).use { paths ->
            return paths
                .map { it.name.substringBefore('.') }
                .map { it.toLongOrNull() }
                .filter { it != null }
                .map { it!! }
                .toList()
                .toSet()
        }
    }

    val maxBytes: Long get() = properties.maxSize.toBytes()
}
