package net.integr.osmium.schematic.model

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.Table
import net.integr.osmium.schematic.SchematicFormat
import java.time.Instant

/**
 * Where a schematic is in its life.
 *
 * Stored rather than derived, unlike host reachability, because none of it can be worked out from
 * the world: a file that is half uploaded looks exactly like one whose upload was abandoned, and
 * only the row remembers which.
 */
enum class SchematicStatus {
    /** Bytes are still arriving. The file on disk is a prefix of the real one. */
    UPLOADING,

    /** Complete on disk, waiting for a worker. */
    PENDING,

    /** A worker is reading it. Interrupted by a restart, and requeued on the next boot. */
    ANALYSING,

    /** Read through, and everything known about it is on this row. */
    READY,

    /** The upload or the analysis failed. [Schematic.failure] says how. */
    FAILED,
}

/**
 * A schematic: the file, what is known about it, and how far along it is.
 *
 * The blocks are not here and never will be. This row is the small permanent thing — a few hundred
 * bytes describing a file that may run to gigabytes — which is what lets the library be listed,
 * searched and sorted without touching a disk.
 */
@Entity
@Table(name = "schematics")
class Schematic(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    /** The operator's name for it, which they may change. Not the file's name. */
    @Column(name = "name", nullable = false, length = 128)
    var name: String = "",

    /**
     * What the file was called when it arrived. Kept separately from [name] because it is evidence
     * rather than a label — it is what an operator recognises when two uploads have drifted to
     * similar names, and renaming should not erase it.
     */
    @Column(name = "original_filename", nullable = false, length = 255)
    var originalFilename: String = "",

    @Column(name = "size_bytes", nullable = false)
    var sizeBytes: Long = 0,

    /**
     * How much of it has arrived. The whole of resumability: a client that lost its connection asks
     * for this and starts from there, rather than sending gigabytes again.
     */
    @Column(name = "received_bytes", nullable = false)
    var receivedBytes: Long = 0,

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 16)
    var status: SchematicStatus = SchematicStatus.UPLOADING,

    /**
     * SHA-256 of the finished file. Taken during the first analysis pass, which is already reading
     * every byte — so it costs nothing on top, and no digest state has to survive between the
     * separate requests that carried the chunks. Null until then.
     */
    @Column(name = "content_hash", length = 64)
    var contentHash: String? = null,

    @Enumerated(EnumType.STRING)
    @Column(name = "format", length = 16)
    var format: SchematicFormat? = null,

    /** The Minecraft version the file was saved from. Null until it has been read. */
    @Column(name = "data_version")
    var dataVersion: Int? = null,

    /** Positions inside the bounding boxes, air included. */
    @Column(name = "volume")
    var volume: Long? = null,

    /** Blocks that will actually be placed, which is the number every estimate is built on. */
    @Column(name = "block_count")
    var blockCount: Long? = null,

    @Column(name = "region_count")
    var regionCount: Int? = null,

    /** The minimum corner in the schematic's own space: the box's position, and the cell origin. */
    @Column(name = "origin_x") var originX: Int? = null,
    @Column(name = "origin_y") var originY: Int? = null,
    @Column(name = "origin_z") var originZ: Int? = null,

    /** The edge of one index cell, in blocks. Derived from the volume — see SchematicIndex. */
    @Column(name = "cell_size") var cellSize: Int? = null,

    @Column(name = "size_x") var sizeX: Int? = null,
    @Column(name = "size_y") var sizeY: Int? = null,
    @Column(name = "size_z") var sizeZ: Int? = null,

    /**
     * Bytes read of the work in front of the analysis, so the interface can show something moving
     * during a pass that takes minutes. Reset when a pass starts.
     */
    @Column(name = "analysed_bytes", nullable = false)
    var analysedBytes: Long = 0,

    @Column(name = "analysis_total_bytes", nullable = false)
    var analysisTotalBytes: Long = 0,

    /** Why it failed, in words an operator can act on. Null unless [status] is FAILED. */
    @Column(name = "failure", length = 512)
    var failure: String? = null,

    /**
     * Who uploaded it, as a name rather than a foreign key — the same reasoning as the audit trail.
     * The record should outlive the account.
     */
    @Column(name = "uploaded_by", nullable = false, length = 64)
    var uploadedBy: String = "",

    @Column(name = "created_at", nullable = false)
    var createdAt: Instant = Instant.now(),

    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now(),
) {
    /** 0 to 100. Upload and analysis are two halves of one bar, because that is how it is watched. */
    val progressPercent: Int
        get() = when (status) {
            SchematicStatus.UPLOADING -> percent(receivedBytes, sizeBytes)
            SchematicStatus.PENDING -> 0
            SchematicStatus.ANALYSING -> percent(analysedBytes, analysisTotalBytes)
            SchematicStatus.READY -> 100
            SchematicStatus.FAILED -> 0
        }

    private fun percent(done: Long, total: Long): Int =
        if (total <= 0) 0 else ((done * 100) / total).coerceIn(0, 100).toInt()
}
