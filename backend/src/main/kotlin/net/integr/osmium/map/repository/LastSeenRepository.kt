package net.integr.osmium.map.repository

import net.integr.osmium.map.model.LastSeen
import net.integr.osmium.map.model.SubjectKind
import org.springframework.jdbc.core.BatchPreparedStatementSetter
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.Timestamp

/**
 * The last position known for everyone the fleet has seen, read and written through JDBC.
 *
 * The same shape as the map's tiles and mapped the same way: rows written far more often than they
 * are read, always whole, never partially updated.
 */
@Repository
class LastSeenRepository(private val jdbc: JdbcTemplate) {

    /**
     * Records a batch of sightings, each replacing whatever was known about that subject.
     *
     * **One statement for the batch, because the caller has a batch.** Telemetry arrives about once
     * a second per agent and carries everybody standing near it, so a write per sighting would be a
     * round trip per player per second for a fact nobody reads until they have gone. Buffered
     * upstream and flushed together - see `LastSeenService`.
     *
     * `at` is compared rather than assumed newer: two agents can see the same player in the same
     * flush, and the one whose sample is older must not overwrite the one whose sample is not.
     */
    fun upsertAll(sightings: Collection<LastSeen>) {
        if (sightings.isEmpty()) return

        val batch = sightings.toList()

        // Set through a `BatchPreparedStatementSetter` rather than as rows of `Any`: `face` is
        // nullable, and an array of arguments carrying a null is not the `Array<Any>` the other
        // overload takes.
        jdbc.batchUpdate(
            """
            INSERT INTO last_seen_positions
                (server_address, dimension, kind, subject, label, face, x, y, z, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (server_address, dimension, kind, subject) DO UPDATE SET
                label = EXCLUDED.label,
                face = EXCLUDED.face,
                x = EXCLUDED.x,
                y = EXCLUDED.y,
                z = EXCLUDED.z,
                at = EXCLUDED.at
            WHERE last_seen_positions.at <= EXCLUDED.at
            """.trimIndent(),
            object : BatchPreparedStatementSetter {
                override fun getBatchSize(): Int = batch.size

                override fun setValues(ps: PreparedStatement, i: Int) {
                    val seen = batch[i]
                    ps.setString(1, seen.serverAddress)
                    ps.setString(2, seen.dimension)
                    ps.setString(3, seen.kind.name)
                    ps.setString(4, seen.subject)
                    ps.setString(5, seen.label)
                    ps.setString(6, seen.face)
                    ps.setDouble(7, seen.x)
                    ps.setDouble(8, seen.y)
                    ps.setDouble(9, seen.z)
                    ps.setTimestamp(10, Timestamp.from(seen.at))
                }
            },
        )
    }

    /**
     * Everyone last seen in one world, newest first.
     *
     * Capped by the caller. Nothing here expires - a sighting is deleted from the storage screen and
     * not by a clock - so a server that has been busy for a year holds every account that has ever
     * walked past an agent, and a map cannot draw all of them at once. Newest first is the order
     * that makes a cap mean something.
     */
    fun inWorld(serverAddress: String, dimension: String, limit: Int): List<LastSeen> = jdbc.query(
        """
        SELECT server_address, dimension, kind, subject, label, face, x, y, z, at
        FROM last_seen_positions
        WHERE server_address = ? AND dimension = ?
        ORDER BY at DESC
        LIMIT ?
        """.trimIndent(),
        { rs, _ -> read(rs) },
        serverAddress,
        dimension,
        limit,
    )

    private fun read(rs: ResultSet): LastSeen = LastSeen(
        serverAddress = rs.getString("server_address"),
        dimension = rs.getString("dimension"),
        kind = SubjectKind.valueOf(rs.getString("kind")),
        subject = rs.getString("subject"),
        label = rs.getString("label"),
        face = rs.getString("face"),
        x = rs.getDouble("x"),
        y = rs.getDouble("y"),
        z = rs.getDouble("z"),
        at = rs.getTimestamp("at").toInstant(),
    )
}
