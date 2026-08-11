package net.integr.osmium.audit.service

import net.integr.osmium.audit.model.AuditEntry
import java.io.Writer
import java.time.Instant

/**
 * The trail as CSV, per RFC 4180.
 *
 * **English only, and not translated.** An export is read by tooling and kept as a record; a header
 * row whose spelling depends on who pressed the button is not something you can write a script
 * against, and two files of the same range would no longer be comparable.
 */
object AuditCsv {

    const val CONTENT_TYPE = "text/csv;charset=UTF-8"

    private const val HEADER = "at,account,action,target,detail"

    /**
     * Leading characters a spreadsheet reads as the start of a formula rather than as text.
     *
     * This matters here more than in most exports: `detail` carries in-game chat, which is written
     * by whoever is on the Minecraft server, not by an operator. Without this, a player typing
     * `=HYPERLINK(...)` into chat gets it executed when an administrator opens the export.
     */
    private val FORMULA_LEAD = setOf('=', '+', '-', '@', '\t', '\r')

    fun writeHeader(out: Writer) {
        out.write(HEADER)
        out.write("\r\n")
    }

    fun writeRow(out: Writer, entry: AuditEntry) {
        out.write(field(entry.at.toString()))
        out.write(",")
        out.write(field(entry.account))
        out.write(",")
        out.write(field(entry.action.name))
        out.write(",")
        out.write(field(entry.target))
        out.write(",")
        out.write(field(entry.detail.orEmpty()))
        out.write("\r\n")
    }

    /**
     * Every field is quoted rather than only the ones that need it. A conditional would be smaller
     * output and one more branch to get wrong, and the reader does not care.
     *
     * A value that would open as a formula keeps its text and gains a leading apostrophe, which is
     * how a spreadsheet is told "this is text". That is a deliberate edit to the data: the
     * alternative is a faithful file that runs code when someone opens it.
     */
    private fun field(value: String): String {
        val guarded = if (value.firstOrNull() in FORMULA_LEAD) "'$value" else value
        return "\"" + guarded.replace("\"", "\"\"") + "\""
    }

    /** `osmium-audit-2026-07-12-to-2026-08-11.csv` — sorts by range, says what it holds. */
    fun fileName(from: Instant, to: Instant): String =
        "osmium-audit-${from.toString().take(10)}-to-${to.toString().take(10)}.csv"
}
