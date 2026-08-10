package net.integr.osmium.audit.model

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
import net.integr.osmium.agent.model.Agent

/**
 * What an operator did, as opposed to what happened to an agent.
 *
 * Recorded: anything that changes state, acts in game, or grants and revokes access. Reads are
 * not — a trail of who listed the agents is noise that buries the entries that matter.
 *
 * The three groups answer different questions. Agent and host entries answer "why is the fleet in
 * this shape"; user entries answer "who was given what, and by whom", which is the one an incident
 * usually turns on.
 */
enum class AuditAction {
    AGENT_CREATE,
    AGENT_UPDATE,
    AGENT_DELETE,
    AGENT_SETUP,
    AGENT_CONNECT,
    AGENT_DISCONNECT,
    AGENT_CHAT,

    HOST_ENROL,
    HOST_RENAME,
    HOST_ROTATE_TOKEN,
    HOST_DELETE,

    USER_CREATE,
    USER_UPDATE,
    USER_DELETE,
    USER_ROLE_CHANGE,
    /** Never carries password material, current or new. */
    USER_PASSWORD_CHANGE,
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

    /**
     * Hibernate emits a `CHECK` constraint listing every enum name, and `ddl-auto=update` writes it
     * once and never alters it — so **adding a value here requires a manual `ALTER TABLE`** against
     * any existing database, or inserts fail against the stale list. See the audit section of the
     * backend README. Neither `columnDefinition` nor an `AttributeConverter` avoids this; both were
     * tried against a real Postgres and Hibernate 7.4 generates the constraint regardless.
     */
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
