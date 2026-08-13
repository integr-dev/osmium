package net.integr.osmium.account.repository

import net.integr.osmium.account.model.RefreshToken
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.time.Instant
import java.util.UUID

/**
 * The revoking queries are deliberately `clearAutomatically = true, flushAutomatically = true`.
 *
 * A bulk update writes straight to the database and leaves the persistence context untouched, so a
 * token already loaded in this transaction keeps its stale `revokedAt = null` — and the next read
 * of it inside the same transaction would hand back a revoked session as a live one. Flushing first
 * keeps pending changes from being discarded by the clear that follows.
 */
interface RefreshTokenRepository : JpaRepository<RefreshToken, Long> {

    /** The lookup on every refresh. Unique, so at most one row can match. */
    fun findByTokenHash(tokenHash: String): RefreshToken?

    /**
     * The account's live sessions, newest first — **one row per family**, which is what a session
     * actually is.
     *
     * Spent tokens are excluded because they are steps in a rotation chain rather than anything an
     * operator would recognise; listing all twenty-four of a day's refreshes would bury the one row
     * that matters. And a family can briefly have more than one live tip, when a retry inside the
     * grace window is given a successor of its own, so the newest of each is taken: one browser is
     * one row, not two.
     */
    @Query(
        """
        select t from RefreshToken t
        where t.user.id = :userId
          and t.usedAt is null
          and t.revokedAt is null
          and t.expiresAt > :now
          and t.issuedAt = (
            select max(newest.issuedAt) from RefreshToken newest
            where newest.family = t.family and newest.usedAt is null and newest.revokedAt is null
          )
        order by t.issuedAt desc
        """,
    )
    fun findLiveFor(@Param("userId") userId: Long, @Param("now") now: Instant): List<RefreshToken>

    /**
     * Revokes every token descended from one login, in one statement.
     *
     * Bulk rather than a loop because this runs on the theft path, where the point is to close the
     * whole chain before the next request rather than to leave a window the size of a round trip.
     * Already-revoked rows are left alone so the first revocation time survives.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update RefreshToken t set t.revokedAt = :at where t.family = :family and t.revokedAt is null")
    fun revokeFamily(@Param("family") family: UUID, @Param("at") at: Instant): Int

    /** Every session an account has, used when its password changes. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update RefreshToken t set t.revokedAt = :at where t.user.id = :userId and t.revokedAt is null")
    fun revokeAllFor(@Param("userId") userId: Long, @Param("at") at: Instant): Int

    /**
     * Drops rows past their expiry. An expired token is already refused on presentation, so this is
     * housekeeping rather than enforcement — nothing depends on it having run.
     */
    @Modifying
    @Query("delete from RefreshToken t where t.expiresAt < :cutoff")
    fun deleteExpired(@Param("cutoff") cutoff: Instant): Int
}
