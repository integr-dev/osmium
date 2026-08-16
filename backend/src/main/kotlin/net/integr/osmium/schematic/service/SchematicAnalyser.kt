package net.integr.osmium.schematic.service

import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateType
import net.integr.osmium.schematic.SchematicFiles
import net.integr.osmium.schematic.config.SchematicProperties
import net.integr.osmium.schematic.SchematicIndex
import net.integr.osmium.schematic.repository.SchematicIndexRepository
import net.integr.osmium.schematic.dto.toResponse
import net.integr.osmium.schematic.model.Schematic
import net.integr.osmium.schematic.model.SchematicStatus
import net.integr.osmium.schematic.repository.SchematicRepository
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.io.FilterInputStream
import java.io.InputStream
import java.security.DigestInputStream
import java.security.MessageDigest
import java.time.Instant

/**
 * Reads an uploaded file through, and writes down what it is.
 *
 * Minutes of work on a large file, so it never runs inside a request. What it produces is small and
 * permanent: format, version, bounds, and the block count every later estimate is built on.
 *
 * The content hash is taken here rather than during the upload. Hashing needs the raw bytes and the
 * reader wants them decompressed, but both can read the same stream — so the digest costs nothing
 * on top of a pass that was happening anyway, and no digest state has to survive between the
 * requests that carried the chunks.
 */
@Service
class SchematicAnalyser(
    private val repository: SchematicRepository,
    private val storage: SchematicStorage,
    private val files: SchematicFiles,
    private val properties: SchematicProperties,
    private val index: SchematicIndexRepository,
    private val broker: LiveUpdateBroker,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Transactional
    fun analyse(id: Long) {
        val schematic = repository.findById(id).orElse(null) ?: return
        if (schematic.status != SchematicStatus.PENDING) return

        schematic.status = SchematicStatus.ANALYSING
        schematic.analysedBytes = 0
        // Two passes over the file, so twice its size is the work in front of us. See
        // SchematicDecoder for why there are two.
        schematic.analysisTotalBytes = schematic.sizeBytes * 2
        schematic.failure = null
        // Said now, not at commit. Everything below runs inside this transaction and takes minutes,
        // so a deferred announcement of having *started* would arrive after finishing.
        touch(schematic, immediately = true)

        try {
            read(schematic)
            schematic.status = SchematicStatus.READY
            schematic.analysedBytes = schematic.analysisTotalBytes
        } catch (failure: Exception) {
            // Every failure here is about the file, not about Osmium: a truncated upload, a format
            // nothing recognises, a version this fleet does not build. The operator can act on all
            // three, so the message goes on the row rather than only into a log.
            log.warn("Could not read schematic {}: {}", id, failure.message)
            schematic.status = SchematicStatus.FAILED
            schematic.failure = failure.message?.take(FAILURE_LENGTH) ?: failure.javaClass.simpleName
        }

        touch(schematic)
    }

    private fun read(schematic: Schematic) {
        val id = schematic.id!!
        val digest = MessageDigest.getInstance("SHA-256")
        var progress = 0L

        // Pass one: what it is. The digest rides along, because these are the raw bytes.
        val info = files.open {
            DigestInputStream(counting(storage.open(id)) { progress += it; report(schematic, progress) }, digest)
        }

        schematic.contentHash = digest.digest().joinToString("") { "%02x".format(it) }
        schematic.format = info.format
        schematic.dataVersion = info.dataVersion
        schematic.regionCount = info.regions.size
        schematic.volume = info.volume

        val (min, max) = info.bounds
        schematic.originX = min.x
        schematic.originY = min.y
        schematic.originZ = min.z
        schematic.sizeX = max.x - min.x
        schematic.sizeY = max.y - min.y
        schematic.sizeZ = max.z - min.z

        // Pass two: where the blocks actually are. Everything downstream — the split, the material
        // list, the estimates — reads what this leaves behind and never the file again, which is
        // the only way any of it is affordable at these sizes.
        val index = SchematicIndex(SchematicIndex.cellEdgeFor(info.volume), min)
        val palettes = info.regions.map { region -> region.palette.map { it.name } }

        files.readBlocks(
            { counting(storage.open(id)) { progress += it; report(schematic, progress) } },
            info,
        ) { region, x, y, z, state ->
            index.add(x, y, z, palettes[region][state])
        }

        schematic.blockCount = index.blocks
        schematic.cellSize = index.cellEdge
        this.index.replaceCells(id, index.cells())
        this.index.replaceMaterials(id, index.materials())
    }

    /**
     * Writes progress out, but not on every read.
     *
     * A pass hands back a few kilobytes at a time, which is tens of thousands of updates a second.
     * Throttling to a couple of seconds is the difference between a progress bar and a second
     * workload alongside the one being measured.
     *
     * Delivered immediately, for the reason the whole method exists. Handed to the ordinary
     * publish it would wait for this transaction — which is the entire read — and every report
     * would arrive at once, after the thing they were reporting on had finished.
     */
    private fun report(schematic: Schematic, bytes: Long) {
        val now = System.currentTimeMillis()
        if (now - lastReport < REPORT_INTERVAL_MS) return
        lastReport = now

        schematic.analysedBytes = bytes
        broker.publishNow(
            LiveUpdateEvent(type = LiveUpdateType.SCHEMATIC_CHANGED, data = schematic.toResponse(properties.maxDataVersion))
        )
    }

    /**
     * @param immediately for a state the row passes *through*. The settled one at the end waits for
     *   the commit, so a pass that fails to write its result never leaves a client believing it.
     */
    private fun touch(schematic: Schematic, immediately: Boolean = false) {
        schematic.updatedAt = Instant.now()
        repository.save(schematic)

        val event =
            LiveUpdateEvent(type = LiveUpdateType.SCHEMATIC_CHANGED, data = schematic.toResponse(properties.maxDataVersion))
        if (immediately) broker.publishNow(event) else broker.publish(event)
    }

    /**
     * Shared across schematics and never reset, so the first report of a pass can be swallowed by
     * the previous one. Harmless: the pass has just announced itself starting, and the next report
     * is two seconds away.
     */
    private var lastReport = 0L

    /** Counts what comes off the disk, which is the only part of the work whose size is known. */
    private fun counting(source: InputStream, onRead: (Long) -> Unit): InputStream =
        object : FilterInputStream(source) {
            override fun read(): Int = super.read().also { if (it >= 0) onRead(1) }

            override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
                super.read(buffer, offset, length).also { if (it > 0) onRead(it.toLong()) }
        }

    private companion object {
        const val REPORT_INTERVAL_MS = 2_000L
        const val FAILURE_LENGTH = 512
    }
}
