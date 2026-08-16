package net.integr.osmium.liveupdates

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.account.model.Role
import net.integr.osmium.account.repository.PermissionNodeRepository
import net.integr.osmium.account.repository.RoleRepository
import net.integr.osmium.security.Nodes
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.web.servlet.get
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Who receives what. The broker's own guarantees are in `LiveUpdateControllerTest`; this is about
 * `matches()`, which is the only thing standing between one shared channel and the audit trail
 * reaching everyone entitled to watch the fleet.
 *
 * Driven through the real endpoint rather than the registry, because the emitter's handler is
 * package-private in Spring and a stream nobody opened over HTTP would not prove much anyway. The
 * mock response accumulates whatever the emitter writes, so reading it back is reading the wire.
 *
 * Not transactional: the broker holds a publish until the surrounding transaction commits, so an
 * event raised inside a rolled-back test transaction would never be delivered at all and every
 * assertion here would pass for the wrong reason.
 */
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class LiveUpdateSubscriptionsTest : AbstractRestTest() {

    @Autowired private lateinit var subscriptions: LiveUpdateSubscriptions
    @Autowired private lateinit var broker: LiveUpdateBroker
    @Autowired private lateinit var roles: RoleRepository
    @Autowired private lateinit var nodes: PermissionNodeRepository

    private fun listen(username: String, role: String?, agentId: Long? = null): MockHttpServletResponse {
        val authorization = authAs(username = username, role = role)
        val path = agentId?.let { "/api/stream/agents/$it" } ?: "/api/stream"
        return mockMvc.get(path) { header(HttpHeaders.AUTHORIZATION, authorization) }
            .andExpect { status { isOk() } }
            .andReturn()
            .response
    }

    /** A marker in the payload, not the event name — that also appears in frames nobody asked about. */
    private fun publish(
        type: LiveUpdateType,
        marker: String,
        username: String? = null,
        agentId: Long? = null,
    ) = broker.publish(
        LiveUpdateEvent(
            type = type,
            data = mapOf("marker" to marker),
            agentId = agentId,
            username = username,
        ),
    )

    private fun cleanUp(vararg usernames: String) =
        usernames.forEach { name -> userRepository.findByUsername(name)?.let(userRepository::delete) }

    /**
     * The reason `audit.read` sits outside the `fleet.*` tier: running the fleet does not entitle
     * you to read what other operators did. One shared channel would have handed it over anyway.
     */
    @Test
    fun `an orchestrator watching the fleet never receives an audit entry`() {
        val orchestrator = listen("stream-orchestrator", "orchestrator")
        val administrator = listen("stream-administrator", "administrator")
        try {
            publish(LiveUpdateType.AUDIT_ENTRY, marker = "trail-secret")

            assertFalse(orchestrator.contentAsString.contains("trail-secret"), orchestrator.contentAsString)
            assertTrue(administrator.contentAsString.contains("trail-secret"), administrator.contentAsString)
        } finally {
            cleanUp("stream-orchestrator", "stream-administrator")
        }
    }

    /**
     * The asymmetry worth pinning: an addressed event is for one account, so a subscription that
     * asked for nothing in particular must be excluded rather than included.
     */
    @Test
    fun `a permissions event reaches only the account it names`() {
        val subject = listen("stream-subject", "viewer")
        val bystander = listen("stream-bystander", "administrator")
        try {
            publish(LiveUpdateType.PERMISSIONS_CHANGED, marker = "role-moved", username = "stream-subject")

            assertTrue(subject.contentAsString.contains("role-moved"), subject.contentAsString)
            assertFalse(bystander.contentAsString.contains("role-moved"), bystander.contentAsString)
        } finally {
            cleanUp("stream-subject", "stream-bystander")
        }
    }

    /** The mirror image: here the *subscription* narrows, so the fleet stream still sees it. */
    @Test
    fun `an agent event reaches a stream that asked for no agent in particular`() {
        val fleet = listen("stream-fleet", "viewer")
        val oneAgent = listen("stream-one-agent", "viewer", agentId = 4242L)
        try {
            publish(LiveUpdateType.AGENT_CHANGED, marker = "agent-moved", agentId = 99L)

            assertTrue(fleet.contentAsString.contains("agent-moved"), fleet.contentAsString)
            assertFalse(oneAgent.contentAsString.contains("agent-moved"), oneAgent.contentAsString)
        } finally {
            cleanUp("stream-fleet", "stream-one-agent")
        }
    }

    /**
     * A demotion used to be able to do one of two things to an open stream: nothing, or close it.
     * Now it narrows one — the account keeps the events it is still entitled to and stops receiving
     * the ones it is not, without reconnecting.
     */
    @Test
    fun `losing a node narrows an open stream on the next tick`() {
        val demoted = listen("stream-demoted", "administrator")
        try {
            publish(LiveUpdateType.AUDIT_ENTRY, marker = "before-demotion")
            assertTrue(demoted.contentAsString.contains("before-demotion"), demoted.contentAsString)

            val user = checkNotNull(userRepository.findByUsername("stream-demoted"))
            user.role = roles.findByName("viewer")
            userRepository.saveAndFlush(user)
            subscriptions.tick()

            publish(LiveUpdateType.AUDIT_ENTRY, marker = "after-demotion")
            assertFalse(demoted.contentAsString.contains("after-demotion"), demoted.contentAsString)

            // Still on the fleet stream, which is the point of narrowing rather than closing.
            publish(LiveUpdateType.AGENT_CHANGED, marker = "still-watching")
            assertTrue(demoted.contentAsString.contains("still-watching"), demoted.contentAsString)
        } finally {
            cleanUp("stream-demoted")
        }
    }

    /** Losing the node the endpoint itself is gated on has to end the stream, not narrow it. */
    @Test
    fun `losing the node the stream is gated on closes it`() {
        val stripped = listen("stream-stripped", "viewer")
        try {
            val user = checkNotNull(userRepository.findByUsername("stream-stripped"))
            user.role = null
            userRepository.saveAndFlush(user)
            subscriptions.tick()

            publish(LiveUpdateType.AGENT_CHANGED, marker = "after-strip")
            assertFalse(stripped.contentAsString.contains("after-strip"), stripped.contentAsString)
        } finally {
            cleanUp("stream-stripped")
        }
    }

    /**
     * The reason the endpoint asks for `user.read.self` rather than `agent.read`: an account has to
     * be able to hear that its own role moved, whether or not it may watch the fleet. No seeded role
     * is this narrow, so the test builds one — the point is the shape of the check, not the tiers
     * that happen to exist today.
     */
    @Test
    fun `an account that cannot watch the fleet still hears about itself`() {
        val selfOnly = roles.saveAndFlush(
            Role(
                name = "test-self-only",
                nodes = mutableSetOf(nodes.findById(Nodes.USER_READ_SELF).orElseThrow()),
            ),
        )
        val narrow = listen("stream-narrow", selfOnly.name)
        try {
            publish(LiveUpdateType.AGENT_CHANGED, marker = "fleet-moved")
            assertFalse(narrow.contentAsString.contains("fleet-moved"), narrow.contentAsString)

            publish(LiveUpdateType.PERMISSIONS_CHANGED, marker = "role-moved", username = "stream-narrow")
            assertTrue(narrow.contentAsString.contains("role-moved"), narrow.contentAsString)
        } finally {
            cleanUp("stream-narrow")
            roles.delete(selfOnly)
        }
    }
}
