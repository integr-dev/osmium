package net.integr.osmium.model

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.Index
import jakarta.persistence.Table
import java.time.Instant

/**
 * What an operator did, as opposed to what happened to an agent.
 *
 * Only commands that act in-game or that mint or destroy credentials are recorded. Reads are not:
 * an audit trail of who listed the agents is noise that buries the entries that matter.
 */
enum class AuditAction {
    AGENT_SETUP,
    AGENT_CONNECT,
    AGENT_DISCONNECT,
    AGENT_CHAT,
    HOST_ENROL,
    HOST_ROTATE_TOKEN,
    HOST_DELETE,
}

/**
 * One operator action. See the Audit section of FLEET_CONNECTIVITY.md.
 *
 * The target is stored as a **name**, not a foreign key, on purpose: an audit entry has to survive
 * the thing it refers to. "admin deleted host eu-2" is precisely the record you want after eu-2 is
 * gone, and a cascade would delete the evidence along with the subject.
 */
@Entity
@Table(
    name = "audit_entries",
    indexes = [Index(name = "idx_audit_entries_at", columnList = "at")],
)
class AuditEntry(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    @Column(name = "at", nullable = false)
    var at: Instant = Instant.now(),

    /** The acting account's username at the time. Not a foreign key, for the reason above. */
    @Column(name = "account", nullable = false, length = 64)
    var account: String = "",

    @Enumerated(EnumType.STRING)
    @Column(name = "action", nullable = false, length = 32)
    var action: AuditAction = AuditAction.AGENT_CONNECT,

    @Column(name = "target", nullable = false, length = 128)
    var target: String = "",

    /** Outbound message text for `AGENT_CHAT`; a short outcome for everything else. */
    @Column(name = "detail", length = DETAIL_MAX)
    var detail: String? = null,
) {
    companion object {
        const val DETAIL_MAX = 512
    }
}
