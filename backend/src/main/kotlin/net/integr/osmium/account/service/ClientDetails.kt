package net.integr.osmium.account.service

import net.integr.osmium.account.model.RefreshToken
import org.springframework.web.context.request.RequestContextHolder
import org.springframework.web.context.request.ServletRequestAttributes
import java.net.Inet4Address
import java.net.InetAddress

/**
 * What a request says about the machine it came from, for labelling a session.
 *
 * **Behind a proxy this is only true if the proxy headers are trusted.** `getRemoteAddr()` returns
 * whoever opened the TCP connection, which in every deployment of Osmium is nginx — so without
 * configuration every session would be labelled with the proxy's own address, which looks like
 * information and is not. `server.forward-headers-strategy=native` puts Tomcat's `RemoteIpValve` in
 * front of this, and that valve rewrites the remote address from `X-Forwarded-For` **only when the
 * peer is itself a private address**. A client on the public internet forging the header is
 * therefore ignored, because the connection did not come from a proxy.
 *
 * Read from the ambient request rather than threaded through the service signatures. That is the
 * same trade `AuditService` makes for the acting account: this only observes, and it would otherwise
 * put an HTTP concern into every method between the controller and the token store.
 */
object ClientDetails {

    fun ip(): String? = request()?.remoteAddr?.let(::normalise)?.take(RefreshToken.IP_LENGTH)

    /**
     * The shortest correct spelling of an address, because these are read by people.
     *
     * Java writes IPv6 out in full — loopback arrives as `0:0:0:0:0:0:0:1`, which is unreadable at a
     * glance and takes the width of three columns to say `::1`. An IPv4 address mapped into IPv6
     * (`::ffff:203.0.113.7`) is written as the IPv4 address it is.
     *
     * Anything that does not parse is returned untouched. This is a label, and refusing to show a
     * value because it was not in a form this recognised would lose the only clue on the row.
     */
    fun normalise(raw: String): String {
        // Only strings holding a colon go any further, and that is a safety property rather than an
        // optimisation: `getByName` resolves anything that is not an address literal through DNS,
        // and a blocking lookup on the request path - for a value that ultimately came from a
        // header - is not something to leave available. A colon makes it an IPv6 literal or nothing.
        // IPv4 and anything unrecognised need no shortening anyway.
        if (':' !in raw) return raw

        val address = runCatching { InetAddress.getByName(raw) }.getOrNull() ?: return raw
        if (address is Inet4Address) return address.hostAddress

        // Unwraps ::ffff:a.b.c.d, which Java hands back as its 16-byte form.
        val bytes = address.address
        if (bytes.size == IPV6_BYTES && bytes.take(V4_MAPPED_PREFIX.size) == V4_MAPPED_PREFIX) {
            return runCatching { InetAddress.getByAddress(bytes.copyOfRange(12, 16)).hostAddress }
                .getOrDefault(raw)
        }

        return compress(address.hostAddress)
    }

    /**
     * Collapses the longest run of zero groups to `::`, as RFC 5952 requires. Only the longest run,
     * and only one of them — `::` twice in an address is ambiguous, and there is no way to read it
     * back.
     */
    private fun compress(expanded: String): String {
        val groups = expanded.substringBefore('%').split(':').map { it.trimStart('0').ifEmpty { "0" } }

        var bestStart = -1
        var bestLength = 0
        var start = -1
        // Runs one past the end so a zero run reaching the last group is still closed off.
        for (index in 0..groups.size) {
            if (index < groups.size && groups[index] == "0") {
                if (start == -1) start = index
            } else if (start != -1) {
                if (index - start > bestLength) {
                    bestStart = start
                    bestLength = index - start
                }
                start = -1
            }
        }

        // A single zero group is written out: `::` saves nothing and RFC 5952 forbids it there.
        if (bestLength < 2) return groups.joinToString(":")

        val head = groups.take(bestStart).joinToString(":")
        val tail = groups.drop(bestStart + bestLength).joinToString(":")
        return "$head::$tail"
    }

    /**
     * Truncated rather than rejected. A user agent is an arbitrary self-declared string and some are
     * very long; the point is to help someone recognise their own browser, and the first 255
     * characters do that as well as the whole thing would.
     */
    fun userAgent(): String? =
        request()?.getHeader("User-Agent")?.takeIf { it.isNotBlank() }?.take(RefreshToken.USER_AGENT_LENGTH)

    /** Null outside a request — a scheduled purge has no client, and neither does a test helper. */
    private fun request() =
        (RequestContextHolder.getRequestAttributes() as? ServletRequestAttributes)?.request

    private const val IPV6_BYTES = 16

    /** `::ffff:` — the prefix Java leaves in front of an IPv4 address held in an IPv6 value. */
    private val V4_MAPPED_PREFIX =
        List(10) { 0.toByte() } + listOf(0xFF.toByte(), 0xFF.toByte())
}
