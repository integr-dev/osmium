package net.integr.osmium.avatar.service

import net.integr.osmium.avatar.config.AvatarProperties
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Instant
import java.util.concurrent.Semaphore

/** A fetched head, ready to write to a response. */
data class Avatar(val bytes: ByteArray, val contentType: String) {
    // Data classes compare arrays by identity, which would make two identical heads unequal. Only
    // the tests care, but a data class that lies about equality is worse than one that does not.
    override fun equals(other: Any?): Boolean =
        this === other || (other is Avatar && contentType == other.contentType && bytes.contentEquals(other.bytes))

    override fun hashCode(): Int = 31 * bytes.contentHashCode() + contentType.hashCode()
}

/**
 * Fetches Minecraft player heads from a skin service and caches them.
 *
 * Three things are deliberate here, and all three exist because this endpoint is reachable without
 * a token — an `<img>` cannot carry an `Authorization` header, and the token is not a cookie:
 *
 * **The identifier is validated against Minecraft's own shape, not sanitised.** It is interpolated
 * into a URL, so anything that is not plainly a player name or a UUID is refused rather than
 * escaped. That is what stops the endpoint from being pointed anywhere except the configured
 * upstream.
 *
 * **Failures are cached too.** Without it, a name nobody has a skin for is a fresh upstream request
 * on every page render.
 *
 * **Concurrent upstream fetches are capped.** Anyone can ask for any name, so without a ceiling
 * Osmium would happily turn one attacker into a flood aimed at the skin service, and exhaust its own
 * connections doing it.
 */
@Service
class AvatarService(private val properties: AvatarProperties) {

    private val log = LoggerFactory.getLogger(javaClass)

    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(properties.timeout)
        // The upstream is operator-configured and therefore trusted; the identifier cannot influence
        // which host is contacted, so following its redirects does not widen what this can reach.
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build()

    private val inFlight = Semaphore(MAX_IN_FLIGHT)

    /** Bounded and access-ordered, so the least recently rendered head is the one that goes. */
    private val cache = object : LinkedHashMap<String, Cached>(INITIAL_CAPACITY, LOAD_FACTOR, true) {
        override fun removeEldestEntry(eldest: Map.Entry<String, Cached>): Boolean =
            size > properties.cacheEntries
    }

    /** Null when there is no head to show: unknown identifier, upstream miss, or avatars disabled. */
    fun head(identifier: String): Avatar? {
        if (!properties.enabled) return null
        if (!isPlayerIdentifier(identifier)) return null

        val key = identifier.lowercase()
        cached(key)?.let { return it.avatar }

        val fetched = fetch(identifier)
        synchronized(cache) {
            cache[key] = Cached(fetched, Instant.now())
        }
        return fetched
    }

    private fun cached(key: String): Cached? {
        val entry = synchronized(cache) { cache[key] } ?: return null
        // A miss expires far sooner than a hit: a head that was simply not there yet, or a skin
        // service having a bad minute, should not blank that player out for the rest of the day.
        val ttl = if (entry.avatar == null) MISS_TTL_SECONDS else properties.ttl.seconds
        val expired = entry.at.plusSeconds(ttl).isBefore(Instant.now())
        if (expired) {
            synchronized(cache) { cache.remove(key) }
            return null
        }
        return entry
    }

    private fun fetch(identifier: String): Avatar? {
        if (!inFlight.tryAcquire()) {
            log.warn("Avatar fetch for {} skipped: {} already in flight", identifier, MAX_IN_FLIGHT)
            return null
        }
        try {
            val request = HttpRequest.newBuilder(URI.create(properties.urlFor(identifier)))
                .timeout(properties.timeout)
                .header("Accept", "image/png,image/*")
                .GET()
                .build()

            val response = http.send(request, sizeCappedBody())
            if (response.statusCode() != HTTP_OK) return null

            val bytes = response.body()
            if (bytes.isEmpty() || bytes.size > MAX_BYTES) return null

            val contentType = response.headers().firstValue("content-type").orElse(DEFAULT_CONTENT_TYPE)
            if (!contentType.startsWith("image/")) return null

            return Avatar(bytes = bytes, contentType = contentType.substringBefore(';').trim())
        } catch (failure: Exception) {
            // Never fatal. A head is decoration, and the caller renders a fallback for a null.
            log.debug("Avatar fetch for {} failed", identifier, failure)
            return null
        } finally {
            inFlight.release()
        }
    }

    /**
     * Refuses an over-long body before reading it rather than after. `ofByteArray` will buffer
     * whatever it is sent, so a misbehaving upstream could otherwise hand Osmium its own heap.
     */
    private fun sizeCappedBody(): HttpResponse.BodyHandler<ByteArray> =
        HttpResponse.BodyHandler { info ->
            val declared = info.headers().firstValueAsLong("content-length").orElse(0)
            if (declared > MAX_BYTES) HttpResponse.BodySubscribers.replacing(ByteArray(0))
            else HttpResponse.BodySubscribers.ofByteArray()
        }

    private class Cached(val avatar: Avatar?, val at: Instant)

    companion object {
        /**
         * Minecraft's own shape for a name, and a UUID with or without dashes. Nothing else reaches
         * the upstream URL — this is the check that keeps the proxy pointed where it was configured.
         */
        private val USERNAME = Regex("[A-Za-z0-9_]{1,16}")
        private val UUID = Regex("[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}")

        fun isPlayerIdentifier(value: String): Boolean =
            USERNAME.matches(value) || UUID.matches(value)

        private const val HTTP_OK = 200
        private const val MAX_BYTES = 256 * 1024L
        private const val MAX_IN_FLIGHT = 8
        private const val MISS_TTL_SECONDS = 300L
        private const val INITIAL_CAPACITY = 64
        private const val LOAD_FACTOR = 0.75f
        private const val DEFAULT_CONTENT_TYPE = "image/png"
    }
}
