package net.integr.osmium.host.service

import net.integr.osmium.host.dto.CreateHostRequest
import net.integr.osmium.host.dto.HostEnrolledResponse
import net.integr.osmium.host.dto.HostResponse
import net.integr.osmium.host.dto.UpdateHostRequest
import net.integr.osmium.host.dto.toResponse
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.host.model.Host
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.host.repository.HostRepository
import net.integr.osmium.security.encodeRequired
import net.integr.osmium.liveupdates.FleetEvent
import net.integr.osmium.liveupdates.FleetEventBroker
import net.integr.osmium.liveupdates.FleetEventType
import net.integr.osmium.hostlink.HostConnections
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.security.SecureRandom
import java.time.Instant
import net.integr.osmium.audit.service.AuditService

@Service
@Transactional(readOnly = true)
class HostService(
    private val hostRepository: HostRepository,
    private val agentRepository: AgentRepository,
    private val passwordEncoder: PasswordEncoder,
    private val registry: HostConnections,
    private val auditService: AuditService,
    private val broker: FleetEventBroker,
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
        publish(host)
        return HostEnrolledResponse(host = host.toResponse(), token = token)
    }

    /**
     * Resolves the host that is presenting a token. Returns null on any failure - unknown
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
        val wasReachable = host.isReachable()
        host.lastSeenAt = Instant.now()
        hostVersion?.let { host.hostVersion = it }
        address?.let { host.address = it }

        // Only on the transition. A heartbeat every ten seconds per host, forwarded to every open
        // browser, would be pure noise: what changes is reachable false -> true.
        if (!wasReachable) publish(host)
    }

    @Transactional
    fun rename(id: Long, request: UpdateHostRequest): HostResponse {
        val host = hostRepository.findById(id).orElseThrow { NoSuchElementException("No host with id $id") }
        if (request.name != host.name) {
            check(!hostRepository.existsByName(request.name)) {
                "Host '${request.name}' is already enrolled"
            }
            val previous = host.name
            host.name = request.name
            // Worth recording because earlier entries name the old host: without this the trail
            // reads as two different machines.
            auditService.record(
                action = AuditAction.HOST_RENAME,
                target = host.name,
                detail = "Renamed from $previous",
            )
            publish(host)
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
        // Each cascaded agent is announced individually. Publishing only the host would leave every
        // browser holding agents that no longer exist, with nothing to tell it otherwise.
        for (agent in agents) {
            broker.publish(
                FleetEvent(
                    type = FleetEventType.AGENT_REMOVED,
                    data = mapOf("id" to agent.id),
                    agentId = agent.id,
                ),
            )
        }
        broker.publish(FleetEvent(type = FleetEventType.HOST_REMOVED, data = mapOf("id" to id)))
    }

    private fun publish(host: Host) = broker.publish(
        FleetEvent(type = FleetEventType.HOST_CHANGED, data = host.toResponse()),
    )

    /** Delegates to the shared mapper, supplying the count it deliberately does not query itself. */
    private fun Host.toResponse(): HostResponse =
        toResponse(agentCount = id?.let { agentRepository.countByHostId(it) } ?: 0)

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
