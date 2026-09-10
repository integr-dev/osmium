package net.integr.osmium.avatar.service

import net.integr.osmium.avatar.config.AvatarProperties
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

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
 * **Failures are cached too, but not every failure is the same failure.** A name the skin service
 * answered "no" about is remembered for minutes, because that answer will not change. A fetch that
 * timed out, or one that never went out because too many were already running, is remembered for
 * seconds or not at all - those say something about this moment, not about the player.
 *
 * Caching them alike is how one busy page-load blanked players out for five minutes. Measured
 * against minotar: a player it has not seen takes **10.3 seconds** to look up and a tenth of a
 * second every time after, so a fleet arrives cold, times out together, and is written off
 * together.
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

    /**
     * One fetch per player at a time, however many callers want it.
     *
     * A cold player costs ten seconds upstream, and the cache cannot answer for one until that has
     * finished - so a chat list, an agent row and the 3D view all wanting the same face at once used
     * to be three requests for one image, three of the eight slots below, and three chances to give
     * up waiting.
     */
    private val fetching = ConcurrentHashMap<String, CompletableFuture<Fetched>>()

    /** Bounded and access-ordered, so the least recently rendered head is the one that goes. */
    private val cache = object : LinkedHashMap<String, Cached>(INITIAL_CAPACITY, LOAD_FACTOR, true) {
        override fun removeEldestEntry(eldest: Map.Entry<String, Cached>): Boolean =
            size > properties.cacheEntries
    }

    /** Null when there is no head to show: unknown identifier, upstream miss, or avatars disabled. */
    fun head(identifier: String): Avatar? =
        proxied(identifier, properties.enabled, "head") { properties.urlFor(it) }

    /**
     * The whole skin sheet, for the 3D view.
     *
     * A different image of the same player rather than a bigger one: the head route serves a crop
     * with the hat composited on, which is right for a 32-pixel avatar and useless for wrapping
     * around a model. Its own upstream and its own switch, so a deployment can keep the 2D heads
     * and skip a fetch per player standing in view.
     */
    fun skin(identifier: String): Avatar? =
        proxied(identifier, properties.skinsEnabled, "skin") { properties.skinUrlFor(it) }

    /**
     * One fetch-and-cache path for both.
     *
     * The [kind] is part of the cache key, not decoration: a head and a skin are two images of one
     * player, and keying on the name alone would serve whichever was asked for first as both.
     */
    private fun proxied(identifier: String, enabled: Boolean, kind: String, url: (String) -> String): Avatar? {
        if (!enabled) return null
        if (!isPlayerIdentifier(identifier)) return null

        val key = "$kind:${identifier.lowercase()}"
        cached(key)?.let { return it.avatar }

        return when (val fetched = once(key, identifier, url(identifier))) {
            // Nothing was asked, so nothing was learnt. Writing this down as "no head" is what turned
            // one busy page-load into five minutes of blank faces.
            is Fetched.Busy -> null
            is Fetched.Got -> remember(key, fetched.avatar, properties.ttl)
            is Fetched.Missing -> remember(key, null, MISS_TTL)
            // Long enough not to hammer an upstream having a bad minute, short enough that the
            // player is back as soon as it stops having one.
            is Fetched.Slow -> remember(key, null, properties.timeout.multipliedBy(SLOW_TTL_TIMEOUTS))
        }
    }

    private fun remember(key: String, avatar: Avatar?, ttl: Duration): Avatar? {
        synchronized(cache) {
            cache[key] = Cached(avatar, Instant.now().plus(ttl))
        }
        return avatar
    }

    /**
     * Fetches, or waits for the fetch somebody else already started for this player.
     *
     * The waiter is handed the same answer rather than making its own request. It waits a little
     * longer than a fetch is allowed to take, so it never gives up on one still inside its budget.
     */
    private fun once(key: String, identifier: String, url: String): Fetched {
        val mine = CompletableFuture<Fetched>()
        val running = fetching.putIfAbsent(key, mine)

        if (running != null) {
            return try {
                running.get(properties.timeout.toMillis() + JOIN_SLACK_MS, TimeUnit.MILLISECONDS)
            } catch (failure: Exception) {
                log.debug("Waiting on an in-flight avatar fetch for {} did not finish", identifier, failure)
                Fetched.Slow
            }
        }

        return try {
            fetch(identifier, url).also { mine.complete(it) }
        } finally {
            // Removed after completing, so a caller already holding this future still gets its answer.
            fetching.remove(key, mine)
        }
    }

    private fun cached(key: String): Cached? {
        val entry = synchronized(cache) { cache[key] } ?: return null
        // Each entry carries its own expiry, because what is being remembered differs: a head lasts
        // hours, "this player has none" minutes, and "the upstream was slow just then" seconds.
        if (entry.until.isBefore(Instant.now())) {
            synchronized(cache) { cache.remove(key) }
            return null
        }
        return entry
    }

    private fun fetch(identifier: String, url: String): Fetched {
        if (!inFlight.tryAcquire()) {
            log.warn("Avatar fetch for {} skipped: {} already in flight", identifier, MAX_IN_FLIGHT)
            return Fetched.Busy
        }
        try {
            val request = HttpRequest.newBuilder(URI.create(url))
                .timeout(properties.timeout)
                .header("Accept", "image/png,image/*")
                .GET()
                .build()

            val response = http.send(request, sizeCappedBody())
            // An answer, and the answer is no: either the upstream has no image for this player or
            // what it sent is not one. Both stay true for a while, so both are worth remembering.
            if (response.statusCode() != HTTP_OK) return Fetched.Missing

            val bytes = response.body()
            if (bytes.isEmpty() || bytes.size > MAX_BYTES) return Fetched.Missing

            val contentType = response.headers().firstValue("content-type").orElse(DEFAULT_CONTENT_TYPE)
            if (!contentType.startsWith("image/")) return Fetched.Missing

            return Fetched.Got(Avatar(bytes = bytes, contentType = contentType.substringBefore(';').trim()))
        } catch (failure: Exception) {
            // Never fatal. A head is decoration, and the caller renders a fallback for a null. No
            // answer came back at all, which says nothing about the player - see Fetched.Slow.
            log.debug("Avatar fetch for {} failed", identifier, failure)
            return Fetched.Slow
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

    private class Cached(val avatar: Avatar?, val until: Instant)

    /**
     * How a fetch ended, which is a different question from what it returned.
     *
     * All four of these used to be a null, and treating them alike is the whole of why a head that
     * was there could stay missing for five minutes.
     */
    private sealed interface Fetched {
        /** The image. */
        data class Got(val avatar: Avatar) : Fetched

        /** The upstream answered and had nothing to give. Still true in a minute. */
        data object Missing : Fetched

        /** Nothing was asked: too many fetches already running. Says nothing about the player. */
        data object Busy : Fetched

        /** Asked and gave up waiting, or could not reach the upstream at all. Worth trying again. */
        data object Slow : Fetched
    }

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
        /** How long "this player has no head" is worth remembering. The answer will not change. */
        private val MISS_TTL: Duration = Duration.ofMinutes(5)

        /** A slow fetch is remembered for twice what one was allowed to take, and no longer. */
        private const val SLOW_TTL_TIMEOUTS = 2L

        /** How much longer than a fetch a caller waiting on somebody else's fetch will wait. */
        private const val JOIN_SLACK_MS = 250L
        private const val INITIAL_CAPACITY = 64
        private const val LOAD_FACTOR = 0.75f
        private const val DEFAULT_CONTENT_TYPE = "image/png"
    }
}
