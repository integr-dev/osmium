package net.integr.osmium.repository

import net.integr.osmium.model.User
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param

/**
 * One row per (account, node). Accounts holding no role still produce a single row with a null
 * [nodeId], which is what lets the caller tell "no such account" apart from "account without
 * permissions".
 */
interface AuthorizationRow {
    val username: String
    val nodeId: String?
}

interface UserRepository : JpaRepository<User, Long> {
    @Query("SELECT u FROM User u WHERE u.username = :username")
    fun findByUsername(username: String): User?
    fun existsByUsername(username: String): Boolean

    /**
     * Scalar projection used on the authentication hot path. Deliberately avoids loading the
     * `User` entity graph, which would eagerly hydrate the role and all of its nodes per request.
     */
    @Query(
        """
        select u.username as username, n.id as nodeId
        from User u
        left join u.role r
        left join r.nodes n
        where u.username = :username
        """,
    )
    fun findAuthorization(@Param("username") username: String): List<AuthorizationRow>
}
