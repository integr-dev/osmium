package net.integr.osmium.schematic.repository

import net.integr.osmium.schematic.Cell
import net.integr.osmium.schematic.Material
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository

/**
 * The index, written and read through JDBC rather than JPA.
 *
 * A quarter of a million cells is a batch insert, not a persistence context. Mapping them as
 * entities would build that many managed objects, flush them one statement at a time, and hold the
 * lot in memory until the transaction ends — for rows that are written once, read as a set, and
 * never updated.
 */
@Repository
class SchematicIndexRepository(private val jdbc: JdbcTemplate) {

    fun replaceCells(schematicId: Long, cells: List<Cell>) {
        // Replaced rather than merged: a re-analysis is a fresh reading of the same file, and
        // leaving the previous one behind would double every count.
        jdbc.update("DELETE FROM schematic_cells WHERE schematic_id = ?", schematicId)

        cells.chunked(BATCH).forEach { batch ->
            jdbc.batchUpdate(
                "INSERT INTO schematic_cells (schematic_id, cx, cy, cz, blocks, block_name) " +
                    "VALUES (?, ?, ?, ?, ?, ?)",
                batch.map { arrayOf<Any>(schematicId, it.x, it.y, it.z, it.blocks, it.block) },
            )
        }
    }

    fun replaceMaterials(schematicId: Long, materials: List<Material>) {
        jdbc.update("DELETE FROM schematic_materials WHERE schematic_id = ?", schematicId)

        materials.chunked(BATCH).forEach { batch ->
            jdbc.batchUpdate(
                "INSERT INTO schematic_materials (schematic_id, block_name, blocks) VALUES (?, ?, ?)",
                batch.map { arrayOf<Any>(schematicId, it.name, it.blocks) },
            )
        }
    }

    fun materialsOf(schematicId: Long): List<Material> = jdbc.query(
        "SELECT block_name, blocks FROM schematic_materials WHERE schematic_id = ? ORDER BY blocks DESC, block_name",
        { rs, _ -> Material(rs.getString("block_name"), rs.getLong("blocks")) },
        schematicId,
    )

    fun cellsOf(schematicId: Long): List<Cell> = jdbc.query(
        "SELECT cx, cy, cz, blocks, block_name FROM schematic_cells WHERE schematic_id = ?",
        { rs, _ ->
            Cell(
                rs.getInt("cx"),
                rs.getInt("cy"),
                rs.getInt("cz"),
                rs.getInt("blocks"),
                // Null for anything analysed before the column existed. Empty rather than a
                // guessed name: the preview falls back to a default colour and says nothing false.
                rs.getString("block_name") ?: "",
            )
        },
        schematicId,
    )

    private companion object {
        /** Large enough that the round trips stop mattering, small enough to stay off the heap. */
        const val BATCH = 1_000
    }
}
