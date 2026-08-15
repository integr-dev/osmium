package net.integr.osmium.schematic.service

import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.service.AuditService
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateType
import net.integr.osmium.schematic.SplitMode
import net.integr.osmium.schematic.Vec3i
import net.integr.osmium.schematic.splitSchematic
import net.integr.osmium.schematic.config.SchematicProperties
import net.integr.osmium.schematic.dto.CreateSchematicRequest
import net.integr.osmium.schematic.dto.MaterialResponse
import net.integr.osmium.schematic.dto.SchematicResponse
import net.integr.osmium.schematic.dto.SegmentResponse
import net.integr.osmium.schematic.dto.SplitResponse
import net.integr.osmium.schematic.dto.toResponse
import net.integr.osmium.schematic.model.Schematic
import net.integr.osmium.schematic.model.SchematicStatus
import net.integr.osmium.schematic.repository.SchematicIndexRepository
import net.integr.osmium.schematic.repository.SchematicRepository
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.io.InputStream
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/** The upload does not line up with what is already on disk. */
class UploadOutOfOrderException(val expectedOffset: Long, message: String) : RuntimeException(message)

/** The library: creating, receiving, renaming and removing schematics. */
@Service
@Transactional(readOnly = true)
class SchematicService(
    private val repository: SchematicRepository,
    private val storage: SchematicStorage,
    private val properties: SchematicProperties,
    private val index: SchematicIndexRepository,
    private val queue: SchematicAnalysisQueue,
    private val auditService: AuditService,
    private val broker: LiveUpdateBroker,
) {
    /**
     * One lock per schematic, held across the disk write and the row update.
     *
     * Two chunks arriving at once for the same upload is not hypothetical — a client retrying a
     * chunk it thinks was lost sends it again while the first is still being written — and without
     * this both would pass the offset check and both would append, leaving the file longer than it
     * should be and duplicated in the middle. The database cannot help: the file is not in it.
     */
    private val locks = ConcurrentHashMap<Long, Any>()

    fun findAll(): List<SchematicResponse> =
        repository.findAllByOrderByCreatedAtDesc().map { it.toResponse(properties.maxDataVersion) }

    fun find(id: Long): SchematicResponse = load(id).toResponse(properties.maxDataVersion)

    /**
     * What has to be gathered before the build starts.
     *
     * Its own call rather than part of the schematic: it is a list of up to a few hundred entries
     * that the library view never shows, and folding it in would send it on every poll of a screen
     * that only wants a progress bar.
     */
    fun materials(id: Long): List<MaterialResponse> {
        load(id)
        return index.materialsOf(id).map { MaterialResponse(it.name, it.blocks) }
    }

    /**
     * Divides a schematic between `parts` agents.
     *
     * **Computed on the way out rather than stored.** It is a pure function of the occupancy index
     * and the two arguments, so asking twice gives the same answer — a plan saved now would be a
     * copy of something already derivable, kept in step by hand, describing an assignment nothing
     * can yet carry out. It becomes a row when there is a host that can be sent one.
     */
    fun split(id: Long, mode: SplitMode, parts: Int): SplitResponse {
        require(parts in 1..MAX_PARTS) { "A build cannot be divided between $parts agents" }

        val schematic = load(id)
        check(schematic.status == SchematicStatus.READY) {
            "'${schematic.name}' has not been read yet, so there is nothing to divide"
        }

        val cellSize = schematic.cellSize ?: 1
        val origin = Vec3i(schematic.originX ?: 0, schematic.originY ?: 0, schematic.originZ ?: 0)
        val bounds = origin to Vec3i(
            origin.x + (schematic.sizeX ?: 0),
            origin.y + (schematic.sizeY ?: 0),
            origin.z + (schematic.sizeZ ?: 0),
        )

        val split = splitSchematic(index.cellsOf(id), cellSize, origin, bounds, mode, parts)
        val total = split.blocks

        return SplitResponse(
            mode = split.mode.name,
            requested = split.requested,
            parts = split.segments.size,
            blocks = total,
            segments = split.segments.mapIndexed { ordinal, segment ->
                SegmentResponse(
                    ordinal = ordinal + 1,
                    minX = segment.min.x,
                    minY = segment.min.y,
                    minZ = segment.min.z,
                    maxX = segment.max.x,
                    maxY = segment.max.y,
                    maxZ = segment.max.z,
                    blocks = segment.blocks,
                    sharePercent = if (total == 0L) 0 else ((segment.blocks * 100) / total).toInt(),
                )
            },
        )
    }

    @Transactional
    fun create(request: CreateSchematicRequest): SchematicResponse {
        check(!repository.existsByName(request.name)) {
            "A schematic called '${request.name}' already exists"
        }
        // Refused now rather than after an hour of transfer: the size is declared up front for
        // exactly this, and a disk shared with the database is not somewhere to discover a limit.
        check(request.sizeBytes <= storage.maxBytes) {
            "The file is ${request.sizeBytes} bytes and the limit is ${storage.maxBytes}"
        }

        val schematic = repository.save(
            Schematic(
                name = request.name,
                originalFilename = request.filename,
                sizeBytes = request.sizeBytes,
                status = SchematicStatus.UPLOADING,
                uploadedBy = currentUsername(),
            )
        )

        auditService.record(
            action = AuditAction.SCHEMATIC_UPLOAD,
            target = schematic.name,
            detail = "Upload of ${request.filename} started, ${request.sizeBytes} bytes",
        )
        publish(schematic)
        return schematic.toResponse(properties.maxDataVersion)
    }

    /**
     * Appends one chunk.
     *
     * The bytes reach the disk before the row is updated, and there is no making those two atomic —
     * the file is not in the database. So the order is chosen for what a crash between them leaves
     * behind: a file longer than the row admits, which is recoverable by truncating to the row. The
     * other order loses bytes the row claims to have, which is not recoverable at all.
     */
    @Transactional
    fun append(id: Long, offset: Long, body: InputStream): SchematicResponse {
        val lock = locks.computeIfAbsent(id) { Any() }
        synchronized(lock) {
            val schematic = load(id)
            check(schematic.status == SchematicStatus.UPLOADING) {
                "'${schematic.name}' is ${schematic.status.name.lowercase()}, not receiving bytes"
            }
            if (offset != schematic.receivedBytes) {
                // The client's idea of how much arrived is not ours. Answering with the real offset
                // rather than only refusing is what makes a resume one round trip.
                throw UploadOutOfOrderException(
                    expectedOffset = schematic.receivedBytes,
                    message = "Expected to continue from ${schematic.receivedBytes}, not $offset",
                )
            }

            var written = 0L
            storage.append(id) { out ->
                val buffer = ByteArray(CHUNK)
                while (true) {
                    val read = body.read(buffer)
                    if (read < 0) break
                    val allowed = schematic.sizeBytes - schematic.receivedBytes - written
                    check(read <= allowed) { "The upload is longer than its declared size" }
                    out.write(buffer, 0, read)
                    written += read
                }
            }

            schematic.receivedBytes += written
            schematic.updatedAt = Instant.now()

            if (schematic.receivedBytes == schematic.sizeBytes) {
                schematic.status = SchematicStatus.PENDING
                // Reading it is minutes of work, so it happens behind the request rather than in
                // it. The queue is what the operator watches instead of a spinner.
                queue.enqueue(id)
            }

            publish(schematic)
            return schematic.toResponse(properties.maxDataVersion)
        }
    }

    @Transactional
    fun rename(id: Long, name: String): SchematicResponse {
        val schematic = load(id)
        check(!repository.existsByNameAndIdNot(name, id)) {
            "A schematic called '$name' already exists"
        }

        val previous = schematic.name
        schematic.name = name
        schematic.updatedAt = Instant.now()

        auditService.record(
            action = AuditAction.SCHEMATIC_RENAME,
            target = name,
            detail = "Renamed from '$previous'",
        )
        publish(schematic)
        return schematic.toResponse(properties.maxDataVersion)
    }

    @Transactional
    fun delete(id: Long) {
        val schematic = load(id)
        val name = schematic.name

        repository.delete(schematic)
        // After the row, not before. A file with no row is swept up on the next boot; a row with no
        // file is a schematic that lists, opens and fails on everything.
        storage.delete(id)
        locks.remove(id)

        auditService.record(
            action = AuditAction.SCHEMATIC_DELETE,
            target = name,
            detail = "Schematic and its file removed",
        )
        broker.publish(LiveUpdateEvent(type = LiveUpdateType.SCHEMATIC_REMOVED, data = mapOf("id" to id)))
    }

    private fun load(id: Long): Schematic =
        repository.findById(id).orElseThrow { NoSuchElementException("No schematic $id") }

    private fun publish(schematic: Schematic) {
        broker.publish(LiveUpdateEvent(type = LiveUpdateType.SCHEMATIC_CHANGED, data = schematic.toResponse(properties.maxDataVersion)))
    }

    private fun currentUsername(): String =
        SecurityContextHolder.getContext().authentication?.name ?: "unknown"

    private companion object {
        const val CHUNK = 64 * 1024

        /** More agents than any fleet has. A guard on the argument, not a considered limit. */
        const val MAX_PARTS = 64
    }
}
