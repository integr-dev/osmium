package net.integr.osmium.avatar.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

/**
 * The Minecraft avatar proxy.
 *
 * Osmium fetches player heads itself rather than letting the browser do it. The frontend's CSP is
 * `img-src 'self' data: blob:`, and widening it to a third-party image host would punch a hole in
 * the one layer that actually contains an XSS. Proxying keeps every image same-origin, so the
 * policy stays as narrow as it is.
 *
 * It also means the operator's browsers never talk to the skin service. Which agents exist, and how
 * often somebody is looking at them, stays inside the deployment.
 *
 * @param upstream where a head is fetched from. `{id}` is the player name or UUID and `{size}` the
 *   pixel size below. **Blank disables the feature**, and the endpoint then answers 404 for
 *   everything — an air-gapped deployment has no skin service to reach, and the interface degrades
 *   to what it looked like before heads existed.
 * @param size pixel size requested upstream. One size for the whole app: the head is rendered at a
 *   handful of small sizes and caching one image per size per player buys nothing.
 * @param timeout how long to wait on the upstream. Short on purpose — a head is decoration, and a
 *   slow skin service must not become a slow Osmium.
 * @param ttl how long a fetched head is kept. Skins change rarely, and a stale head for a few hours
 *   is not a fact anybody acts on.
 * @param cacheEntries how many heads are held in memory. Each is a few kilobytes, and the cache is
 *   bounded rather than a map that grows with every name anyone asks for.
 */
@ConfigurationProperties(prefix = "osmium.avatar")
data class AvatarProperties(
    val upstream: String = "https://minotar.net/avatar/{id}/{size}.png",
    val size: Int = 64,
    val timeout: Duration = Duration.ofSeconds(5),
    val ttl: Duration = Duration.ofHours(12),
    val cacheEntries: Int = 512,
) {
    val enabled: Boolean get() = upstream.isNotBlank()

    init {
        if (enabled) {
            require(upstream.startsWith("http://") || upstream.startsWith("https://")) {
                "osmium.avatar.upstream must be an http(s) URL, or blank to disable avatars"
            }
            require(upstream.contains(ID_PLACEHOLDER)) {
                "osmium.avatar.upstream must contain $ID_PLACEHOLDER, or every player gets the same head"
            }
        }
        require(size in MIN_SIZE..MAX_SIZE) { "osmium.avatar.size must be between $MIN_SIZE and $MAX_SIZE" }
        require(cacheEntries > 0) { "osmium.avatar.cacheEntries must be positive" }
        require(!ttl.isNegative && !ttl.isZero) { "osmium.avatar.ttl must be positive" }
        require(!timeout.isNegative && !timeout.isZero) { "osmium.avatar.timeout must be positive" }
    }

    /** The upstream URL for one player. [id] is assumed already validated by the service. */
    fun urlFor(id: String): String =
        upstream.replace(ID_PLACEHOLDER, id).replace(SIZE_PLACEHOLDER, size.toString())

    private companion object {
        const val ID_PLACEHOLDER = "{id}"
        const val SIZE_PLACEHOLDER = "{size}"
        const val MIN_SIZE = 8
        const val MAX_SIZE = 512
    }
}
