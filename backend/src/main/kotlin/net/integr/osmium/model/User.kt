package net.integr.osmium.model

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.FetchType
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.JoinColumn
import jakarta.persistence.ManyToOne
import jakarta.persistence.Table

@Entity
@Table(name = "users")
class User(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    @Column(name = "username", nullable = false, unique = true, length = 64)
    var username: String = "",

    @Column(name = "password_hash", nullable = false)
    var passwordHash: String = "",

    /**
     * The account's seniority level. Roles are strictly nested - each tier contains the one below
     * it - so holding more than one could never grant more than the highest, and a single
     * assignment keeps the model honest. Null means the account has no permissions at all.
     */
    @ManyToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "role_id")
    var role: Role? = null,
) {
    /** Node ids granted by the assigned role. */
    fun nodes(): Set<String> = role?.nodes?.mapTo(mutableSetOf()) { it.id } ?: emptySet()
}
