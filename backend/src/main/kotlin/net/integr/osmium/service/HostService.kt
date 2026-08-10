package net.integr.osmium.service

import net.integr.osmium.dto.CreateHostRequest
import net.integr.osmium.dto.HostEnrolledResponse
import net.integr.osmium.dto.HostResponse
import net.integr.osmium.dto.UpdateHostRequest
import net.integr.osmium.model.AuditAction
import net.integr.osmium.model.Host
import net.integr.osmium.repository.AgentRepository
import net.integr.osmium.repository.HostRepository
import net.integr.osmium.security.encodeRequired
import net.integr.osmium.websocket.HostSessionRegistry
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.security.SecureRandom
import java.time.Instant

@Service
@Transactional(readOnly = true)
class HostService(
    private val hostRepository: HostRepository,
    private val agentRepository: AgentRepository,
    private val passwordEncoder: PasswordEncoder,
    private val registry: HostSessionRegistry,
    private val auditService: AuditService,
) {
    fun findAll(): List<HostResponse> =
        hostRepository.findAll().sortedBy { it.name }.map { it.toResponse() }

    /**
     * Enrols a host and returns its token in the clear exactly once. Only the hash is persisted, so
     * a lost token is rotated by re-enrolling rather than recovered.
     */
    @Transactional
    fun enrol(request: CreateHostRequest): HostEnrolledResponse {
        check(!hostRepository.existsByName(request.name)) {
            "Host '${request.name}' is already enrolled"
        }

        // Saved first so the id can be embedded in the token: authenticating a host is then one
        // lookup plus one hash comparison, rather than a BCrypt check against every enrolled host.
        val host = hostRepository.save(Host(name = request.name, tokenHash = "pending"))
        val secret = generateSecret()
        host.tokenHash = passwordEncoder.encodeRequired(secret)

        val token = "$TOKEN_PREFIX${host.id}_$secret"
        auditService.record(
            action = AuditAction.HOST_ENROL,
            target = host.name,
            detail = "Enrolment token issued once",
        )
        return HostEnrolledResponse(host = host.toResponse(), token = token)
    }

    /**
     * Resolves the host a host is presenting a token for. Returns null on any failure - unknown
     * format, unknown host, wrong secret - so the caller cannot distinguish them and probe for
     * valid host ids.
     */
    fun authenticate(token: String): Host? {
        if (!token.startsWith(TOKEN_PREFIX)) return null
        val body = token.removePrefix(TOKEN_PREFIX)
        val separator = body.indexOf('_').takeIf { it > 0 } ?: return null

        val hostId = body.take(separator).toLongOrNull() ?: return null
        val secret = body.substring(separator + 1)

        val host = hostRepository.findById(hostId).orElse(null) ?: return null
        return if (passwordEncoder.matches(secret, host.tokenHash)) host else null
    }

    /** Recorded from the host's heartbeat, so reachability is derived rather than asserted. */
    @Transactional
    fun recordHeartbeat(hostId: Long, hostVersion: String?, address: String?) {
        val host = hostRepository.findById(hostId).orElse(null) ?: return
        host.lastSeenAt = Instant.now()
        hostVersion?.let { host.hostVersion = it }
        address?.let { host.address = it }
    }

    @Transactional
    fun rename(id: Long, request: UpdateHostRequest): HostResponse {
        val host = hostRepository.findById(id).orElseThrow { NoSuchElementException("No host with id $id") }
        if (request.name != host.name) {
            check(!hostRepository.existsByName(request.name)) {
                "Host '${request.name}' is already enrolled"
            }
            host.name = request.name
        }
        return host.toResponse()
    }

    /**
     * Issues a fresh token and invalidates the old one, so a leaked token can be replaced without
     * deleting the host and losing its agents.
     *
     * The live session is closed too. Authentication happens once at the handshake, so an already
     * connected host would otherwise keep running on a token that is supposed to be dead - which
     * is exactly the case rotation exists for.
     */
    @Transactional
    fun rotateToken(id: Long): HostEnrolledResponse {
        val host = hostRepository.findById(id).orElseThrow { NoSuchElementException("No host with id $id") }

        val secret = generateSecret()
        host.tokenHash = passwordEncoder.encodeRequired(secret)
        registry.disconnect(id)

        auditService.record(
            action = AuditAction.HOST_ROTATE_TOKEN,
            target = host.name,
            detail = "Previous token invalidated and the live session closed",
        )
        return HostEnrolledResponse(host = host.toResponse(), token = "$TOKEN_PREFIX${host.id}_$secret")
    }

    /** Removing a host removes its agents: they cannot run without the host that owns them. */
    @Transactional
    fun delete(id: Long) {
        val host = hostRepository.findById(id).orElseThrow { NoSuchElementException("No host with id $id") }
        val agents = agentRepository.findAllByHostId(id)
        agentRepository.deleteAll(agents)
        hostRepository.delete(host)

        // Recorded by name rather than id: the entry has to outlive the host it describes.
        auditService.record(
            action = AuditAction.HOST_DELETE,
            target = host.name,
            detail = "Removed with ${agents.size} agent(s)",
        )
    }

    private fun Host.toResponse(): HostResponse = HostResponse(
        id = checkNotNull(id) { "Host has not been persisted yet" },
        name = name,
        address = address,
        hostVersion = hostVersion,
        lastSeenAt = lastSeenAt,
        reachable = isReachable(),
        agentCount = id?.let { agentRepository.countByHostId(it) } ?: 0,
    )

    private fun generateSecret(): String {
        val bytes = ByteArray(TOKEN_BYTES).also { SecureRandom().nextBytes(it) }
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val TOKEN_PREFIX = "osm_host_"

        /** 32 hex characters plus the prefix stays well inside BCrypt's 72 byte limit. */
        const val TOKEN_BYTES = 16
    }
}
