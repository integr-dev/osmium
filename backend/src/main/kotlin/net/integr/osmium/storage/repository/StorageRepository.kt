package net.integr.osmium.storage.repository

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import java.time.Instant

/** One table as Postgres reports it. */
data class TableSize(
    val table: String,
    /** Everything the table costs on disk: the rows, its indexes, and its out-of-line storage. */
    val totalBytes: Long,
    /** The rows alone, which is the part a delete can shrink. */
    val heapBytes: Long,
    /**
     * Roughly how many rows are live.
     *
     * An estimate out of the statistics collector, not a count. Counting rows means reading every
     * one of them, and a screen that costs a full scan of the biggest table in the database to open
     * is a screen nobody should open while anything else is happening.
     */
    val rows: Long,
    /** Roughly how many dead rows are waiting to be reclaimed. Also an estimate. */
    val deadRows: Long,
)

/**
 * What the database is holding, measured rather than derived.
 *
 * Straight to `pg_class` and the statistics collector. There is no way to work this out from the
 * application side: what a row costs on disk is a question about page layout, alignment, indexes
 * and out-of-line storage, and any number this computed from the entities would be a guess dressed
 * up as a measurement.
 */
@Repository
class StorageRepository(private val jdbc: JdbcTemplate) {

    /** Every ordinary table in the schema, largest first. */
    fun sizes(): List<TableSize> = jdbc.query(
        """
        SELECT c.relname                            AS table_name,
               pg_total_relation_size(c.oid)        AS total_bytes,
               pg_relation_size(c.oid)              AS heap_bytes,
               COALESCE(s.n_live_tup, 0)            AS live_rows,
               COALESCE(s.n_dead_tup, 0)            AS dead_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = current_schema() AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
        """.trimIndent(),
    ) { row, _ ->
        TableSize(
            table = row.getString("table_name"),
            totalBytes = row.getLong("total_bytes"),
            heapBytes = row.getLong("heap_bytes"),
            rows = row.getLong("live_rows"),
            deadRows = row.getLong("dead_rows"),
        )
    }

    /** What the whole database costs, including everything no table accounts for. */
    fun databaseBytes(): Long =
        jdbc.queryForObject("SELECT pg_database_size(current_database())", Long::class.java) ?: 0

    /**
     * The oldest row in a table, by its own timestamp column.
     *
     * What a retention control is set against: "older than thirty days" means nothing to somebody
     * who does not know whether the oldest thing here is from last week or from last year.
     *
     * The column name is not a parameter — it cannot be, in SQL — so callers pass one from
     * [net.integr.osmium.storage.model.StorageArea], never anything a request carried.
     */
    fun oldest(table: String, column: String): Instant? =
        jdbc.queryForObject("SELECT MIN($column) FROM $table", java.sql.Timestamp::class.java)?.toInstant()

    /**
     * Deletes rows older than a cutoff, or every row when there is none.
     *
     * `DELETE` rather than `TRUNCATE` even when clearing the lot. Truncate takes a lock that waits
     * for every reader, and these tables are written continuously by hosts; a delete leaves the
     * space behind as dead rows, which is what [vacuum] is for and what the screen says out loud.
     */
    fun purge(table: String, column: String, before: Instant?): Int =
        if (before == null) jdbc.update("DELETE FROM $table")
        else jdbc.update("DELETE FROM $table WHERE $column < ?", java.sql.Timestamp.from(before))

    /**
     * Returns to the operating system what deleted rows are still occupying.
     *
     * **`VACUUM FULL`, which rewrites each table and needs an exclusive lock on it.** A plain
     * vacuum only marks the space reusable by the same table, so a deployment that has just deleted
     * a hundred megabytes of chat sees no change on disk and reasonably concludes nothing happened.
     * The lock is why this is a button somebody presses rather than something a purge does for them.
     *
     * Runs outside a transaction: Postgres refuses `VACUUM` inside one.
     */
    fun vacuum(tables: List<String>) {
        for (table in tables) jdbc.execute("VACUUM (FULL, ANALYZE) $table")
    }
}
