package net.integr.osmium.web

import java.time.Instant

/**
 * A position in a newest-first feed, rendered as `<instant>|<id>`.
 *
 * **Keyset, not offset.** The audit trail, the activity feed and chat are all append-only and read
 * newest-first, so `offset 200` moves by one every time something is recorded: a reader scrolling
 * would see rows repeat or disappear underneath them. A cursor names the last row already
 * delivered, which nothing arriving later can shift.
 *
 * `id` is carried alongside the instant to break ties. Two rows in the same instant are ordinary -
 * a burst of chat, two concurrent commands - and without the tiebreak one of them falls into the
 * gap at a page boundary.
 *
 * Deliberately not encoded or signed. It carries a timestamp and a row id that the same response
 * already returned in full, so obscuring it would protect nothing.
 */
object PageCursor {

    /**
     * Where an unpositioned request starts.
     *
     * A sentinel rather than a nullable parameter: a null `Instant` in the `where` clause needs an
     * explicit type hint and forks every query into two, and nothing real can be recorded after
     * this. Kept inside the range Postgres can hold, so it survives being bound as a parameter.
     */
    private val NEWEST: Instant = Instant.parse("9999-12-31T23:59:59Z")

    /** The first page: everything is older than this. */
    val START: Pair<Instant, Long> = NEWEST to Long.MAX_VALUE

    fun decode(raw: String?): Pair<Instant, Long> {
        if (raw.isNullOrBlank()) return START

        val at = runCatching { Instant.parse(raw.substringBeforeLast('|', missingDelimiterValue = "")) }
            .getOrNull() ?: throw IllegalArgumentException(MALFORMED)
        val id = raw.substringAfterLast('|').toLongOrNull()
            ?: throw IllegalArgumentException(MALFORMED)

        return at to id
    }

    fun encode(at: Instant, id: Long): String = "$at|$id"

    /** Does not echo the input: it is caller-supplied and ends up in logs and error surfaces. */
    private const val MALFORMED = "Malformed cursor"
}
