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
 *
 *   The default is minotar's `helm`, which composites the skin's second layer — the hat — over the
 *   head. Its `avatar` endpoint returns the bare one, so anybody whose face is drawn on that overlay
 *   comes back looking like a different player rather than like a head missing a detail.
 * @param skinUpstream where the **whole skin sheet** is fetched from, for the 3D view, which
 *   wraps it around a player model rather than showing a crop of it. `{id}` is substituted the same
 *   way; there is no `{size}`, because a skin is 64x64 and rescaling one is how you get a body made
 *   of blurred squares. **Blank disables skins** while leaving heads working, which is the right
 *   default for an operator who wants the 2D screens and not the extra fetch per player in view.
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
    val upstream: String = "https://minotar.net/helm/{id}/{size}.png",
    val skinUpstream: String = "https://minotar.net/skin/{id}.png",
    val size: Int = 64,
    val timeout: Duration = Duration.ofSeconds(5),
    val ttl: Duration = Duration.ofHours(12),
    val cacheEntries: Int = 512,
) {
    val enabled: Boolean get() = upstream.isNotBlank()

    /** Skins are their own switch: a deployment can want heads and not the 3D view's extra traffic. */
    val skinsEnabled: Boolean get() = skinUpstream.isNotBlank()

    init {
        if (enabled) {
            require(upstream.startsWith("http://") || upstream.startsWith("https://")) {
                "osmium.avatar.upstream must be an http(s) URL, or blank to disable avatars"
            }
            require(upstream.contains(ID_PLACEHOLDER)) {
                "osmium.avatar.upstream must contain $ID_PLACEHOLDER, or every player gets the same head"
            }
        }
        if (skinsEnabled) {
            require(skinUpstream.startsWith("http://") || skinUpstream.startsWith("https://")) {
                "osmium.avatar.skinUpstream must be an http(s) URL, or blank to disable skins"
            }
            require(skinUpstream.contains(ID_PLACEHOLDER)) {
                "osmium.avatar.skinUpstream must contain $ID_PLACEHOLDER, or every player wears one skin"
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

    /** The same for the whole sheet. No size: a skin is the size it is. */
    fun skinUrlFor(id: String): String = skinUpstream.replace(ID_PLACEHOLDER, id)

    private companion object {
        const val ID_PLACEHOLDER = "{id}"
        const val SIZE_PLACEHOLDER = "{size}"
        const val MIN_SIZE = 8
        const val MAX_SIZE = 512
    }
}
