package net.integr.osmium.avatar.service

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import net.integr.osmium.avatar.config.AvatarProperties
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * What the service remembers, and for how long.
 *
 * **Not the controller's tests, because these are about time.** Whether a head comes back as an
 * image is the controller's business; whether a *failure* is remembered for five minutes or half a
 * second is this class's, and answering that needs an upstream that can be made slow and a timeout
 * short enough to test against. Both are awkward inside a Spring context and trivial here.
 *
 * The default upstream is minotar, where a player it has not seen costs **10.3 seconds** to look up
 * and a tenth of a second thereafter. That is what these tests stand in for: a first fetch that
 * takes too long is the ordinary case, not an outage, and it must not blank the player out.
 */
class AvatarServiceTest {

    private fun serviceFor(timeout: Duration = Duration.ofMillis(300)) = AvatarService(
        AvatarProperties(
            upstream = "http://127.0.0.1:${upstream.port}/avatar/{id}/{size}.png",
            skinUpstream = "http://127.0.0.1:${upstream.port}/skin/{id}.png",
            timeout = timeout,
            ttl = Duration.ofHours(12),
        ),
    )

    @Test
    fun `a head the upstream has is served`() {
        upstream.serve("Mason_plain", PNG)

        assertEquals(PNG.toList(), serviceFor().head("Mason_plain")?.bytes?.toList())
    }

    @Test
    fun `a fetch that takes too long is not remembered as a player without a head`() {
        val service = serviceFor()
        upstream.serve("Mason_slow", PNG, delay = Duration.ofSeconds(1))

        // The first ask gives up waiting, which is what every cold player used to do.
        assertNull(service.head("Mason_slow"), "a slow upstream answered")

        // Twice the timeout later the answer is forgotten, and by then the upstream is warm - which
        // is exactly what minotar does, and why the head used to stay missing for five minutes.
        upstream.serve("Mason_slow", PNG)
        Thread.sleep(SLOW_TTL_MS)

        assertNotNull(service.head("Mason_slow"), "the head was still written off after the upstream recovered")
    }

    @Test
    fun `a player the upstream says it has no head for is remembered`() {
        val service = serviceFor()

        assertNull(service.head("Mason_absent"))
        Thread.sleep(SLOW_TTL_MS)
        assertNull(service.head("Mason_absent"))

        // An answer, unlike a timeout, is worth keeping: it will still be the same answer in a
        // minute, and asking again on every render is what the cache exists to stop.
        assertEquals(1, upstream.hits("Mason_absent"), "a known-missing head was fetched again")
    }

    @Test
    fun `two callers wanting the same cold head make one request`() {
        val service = serviceFor(timeout = Duration.ofSeconds(5))
        upstream.serve("Mason_shared", PNG, delay = Duration.ofMillis(200))

        val pool = Executors.newFixedThreadPool(CALLERS)
        try {
            val asked = (1..CALLERS).map { pool.submit<Avatar?> { service.head("Mason_shared") } }
            for (answer in asked) assertNotNull(answer.get(5, TimeUnit.SECONDS), "a caller got nothing")
        } finally {
            pool.shutdownNow()
        }

        // A cold player costs seconds upstream and the cache cannot answer until one of them
        // finishes, so without this every page that shows a face at once asks for it at once.
        assertEquals(1, upstream.hits("Mason_shared"), "one cold head cost more than one fetch")
    }

    @Test
    fun `a head and a skin of one player are different images`() {
        val service = serviceFor()
        upstream.serve("Mason_both", PNG)
        upstream.serveSkin("Mason_both", SHEET)

        assertEquals(PNG.toList(), service.head("Mason_both")?.bytes?.toList())
        assertEquals(SHEET.toList(), service.skin("Mason_both")?.bytes?.toList())
    }

    companion object {
        private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02)
        private val SHEET = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x03, 0x04)

        /** Twice the 300ms timeout the tests run with, plus a moment for the clock to pass it. */
        private const val CALLERS = 4
        private const val SLOW_TTL_MS = 700L

        private val upstream = SlowSkinService().apply { start() }

        @JvmStatic
        @AfterAll
        fun stopUpstream() = upstream.stop()
    }
}

/** A skin service that serves what a test registered, counts asks, and can be told to dawdle. */
private class SlowSkinService {

    private class Held(val bytes: ByteArray, val delay: Duration)

    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val heads = ConcurrentHashMap<String, Held>()
    private val skins = ConcurrentHashMap<String, Held>()
    private val counts = ConcurrentHashMap<String, AtomicInteger>()

    val port: Int get() = server.address.port

    fun start() {
        server.createContext("/avatar") { exchange -> handle(exchange, heads) }
        server.createContext("/skin") { exchange -> handle(exchange, skins) }
        // Concurrent on purpose: a single-threaded executor would serialise the callers that the
        // one-fetch-per-player test is about, and pass it for the wrong reason.
        server.executor = Executors.newFixedThreadPool(8)
        server.start()
    }

    fun stop() = server.stop(0)

    fun serve(player: String, bytes: ByteArray, delay: Duration = Duration.ZERO) {
        heads[player.lowercase()] = Held(bytes, delay)
    }

    fun serveSkin(player: String, bytes: ByteArray, delay: Duration = Duration.ZERO) {
        skins[player.lowercase()] = Held(bytes, delay)
    }

    fun hits(player: String): Int = counts[player.lowercase()]?.get() ?: 0

    private fun handle(exchange: HttpExchange, from: Map<String, Held>) {
        val player = exchange.requestURI.path.split('/').getOrNull(2).orEmpty().removeSuffix(".png")
        counts.computeIfAbsent(player.lowercase()) { AtomicInteger() }.incrementAndGet()

        val held = from[player.lowercase()]
        if (held == null) {
            exchange.sendResponseHeaders(404, -1)
            exchange.close()
            return
        }

        Thread.sleep(held.delay.toMillis())
        exchange.responseHeaders.add("Content-Type", "image/png")
        exchange.sendResponseHeaders(200, held.bytes.size.toLong())
        exchange.responseBody.use { it.write(held.bytes) }
    }
}
