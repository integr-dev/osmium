package net.integr.osmium.account.model

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import net.integr.osmium.security.Nodes

/**
 * A single permission node, e.g. `user.create`. The node string is its own identifier, so there is
 * no surrogate key to keep in sync. Nodes are the only thing routes are ever authorized against.
 */
@Entity
@Table(name = "permission_nodes")
class PermissionNode(
    @Id
    @Column(name = "id", nullable = false, length = 64)
    var id: String = "",
)
