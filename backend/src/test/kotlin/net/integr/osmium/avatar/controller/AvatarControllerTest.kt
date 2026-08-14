package net.integr.osmium.avatar.controller

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import net.integr.osmium.AbstractRestTest
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.get
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

/**
 * The proxy is driven against a real HTTP server rather than a mocked client, in keeping with the
 * rest of the suite. The stub records what it was asked for, which is how the caching claims are
 * checked: a cache that is not observed to prevent a second request is not a cache.
 *
 * Every test uses its own player name. The service is a singleton and its cache outlives a test, so
 * sharing a name between two of them would make the second one depend on the first having run.
 */
class AvatarControllerTest : AbstractRestTest() {

    /** A head only ever appears beside something `agent.read` already covers, which a viewer has. */
    private fun asViewer(name: String) = authAs(name, "viewer")

    @Test
    fun `a known player's head is served as an image`() {
        upstream.serve("Mason_01", PNG)

        mockMvc.get("/api/avatars/Mason_01") {
            header(HttpHeaders.AUTHORIZATION, asViewer("head-reader"))
        }.andExpect {
            status { isOk() }
            header { string("Content-Type", "image/png") }
        }.andReturn().response.let { assertContentEquals(PNG, it.contentAsByteArray) }
    }

    @Test
    fun `an anonymous request gets nothing`() {
        upstream.serve("Mason_gated", PNG)
        val before = upstream.requests.get()

        mockMvc.get("/api/avatars/Mason_gated").andExpect { status { isUnauthorized() } }

        assertEquals(before, upstream.requests.get(), "an anonymous request reached the skin service")
    }

    @Test
    fun `an account without fleet-read is refused`() {
        upstream.serve("Mason_denied", PNG)

        mockMvc.get("/api/avatars/Mason_denied") {
            header(HttpHeaders.AUTHORIZATION, authAs("no-fleet"))
        }.andExpect { status { isForbidden() } }
    }

    @Test
    fun `a UUID is accepted as well as a name`() {
        upstream.serve("069a79f4-44e9-4726-a5be-fca90e38aaf5", PNG)

        mockMvc.get("/api/avatars/069a79f4-44e9-4726-a5be-fca90e38aaf5") {
            header(HttpHeaders.AUTHORIZATION, asViewer("uuid-reader"))
        }.andExpect { status { isOk() } }
    }

    @Test
    fun `a player the skin service does not know is a 404, not an error`() {
        mockMvc.get("/api/avatars/Nobody_here") {
            header(HttpHeaders.AUTHORIZATION, asViewer("miss-reader"))
        }.andExpect { status { isNotFound() } }
    }

    @Test
    fun `an identifier that is not a Minecraft name never reaches the upstream`() {
        val before = upstream.requests.get()

        // Too long for a name and not a UUID. Refused on shape, so nothing is interpolated into a
        // URL - this is the check that keeps the proxy pointed where it was configured.
        mockMvc.get("/api/avatars/this-is-not-a-minecraft-name") {
            header(HttpHeaders.AUTHORIZATION, asViewer("shape-reader"))
        }.andExpect { status { isNotFound() } }

        assertEquals(before, upstream.requests.get(), "a malformed identifier was forwarded upstream")
    }

    @Test
    fun `a head is fetched once and served from cache afterwards`() {
        upstream.serve("Mason_cached", PNG)
        val auth = asViewer("cache-reader")

        repeat(3) {
            mockMvc.get("/api/avatars/Mason_cached") {
                header(HttpHeaders.AUTHORIZATION, auth)
            }.andExpect { status { isOk() } }
        }

        assertEquals(1, upstream.hits("Mason_cached"), "the head was fetched more than once")
    }

    @Test
    fun `a miss is cached too, so a name with no skin is not re-fetched on every render`() {
        val auth = asViewer("miss-cache-reader")

        repeat(3) {
            mockMvc.get("/api/avatars/Mason_missing") {
                header(HttpHeaders.AUTHORIZATION, auth)
            }.andExpect { status { isNotFound() } }
        }

        assertEquals(1, upstream.hits("Mason_missing"), "the missing head was re-fetched")
    }

    @Test
    fun `an over-long body is refused rather than buffered`() {
        upstream.serve("Mason_huge", ByteArray(TOO_BIG))

        mockMvc.get("/api/avatars/Mason_huge") {
            header(HttpHeaders.AUTHORIZATION, asViewer("huge-reader"))
        }.andExpect { status { isNotFound() } }
    }

    @Test
    fun `an upstream that answers with something other than an image is refused`() {
        upstream.serve("Mason_html", "<html>rate limited</html>".toByteArray(), contentType = "text/html")

        mockMvc.get("/api/avatars/Mason_html") {
            header(HttpHeaders.AUTHORIZATION, asViewer("html-reader"))
        }.andExpect { status { isNotFound() } }
    }

    companion object {
        private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02)
        private const val TOO_BIG = 300 * 1024

        private val upstream = SkinService().apply { start() }

        @JvmStatic
        @DynamicPropertySource
        fun avatarUpstream(registry: DynamicPropertyRegistry) {
            registry.add("osmium.avatar.upstream") { "http://127.0.0.1:${upstream.port}/avatar/{id}/{size}.png" }
        }
    }
}

/** A stand-in for the skin service: serves what a test registered and counts what was asked for. */
private class SkinService {

    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val heads = ConcurrentHashMap<String, Pair<ByteArray, String>>()
    private val counts = ConcurrentHashMap<String, AtomicInteger>()

    val requests = AtomicInteger()
    val port: Int get() = server.address.port

    fun start() {
        server.createContext("/avatar") { exchange -> handle(exchange) }
        server.executor = null
        server.start()
    }

    fun serve(player: String, bytes: ByteArray, contentType: String = "image/png") {
        heads[player.lowercase()] = bytes to contentType
    }

    fun hits(player: String): Int = counts[player.lowercase()]?.get() ?: 0

    private fun handle(exchange: HttpExchange) {
        // /avatar/<id>/<size>.png
        val player = exchange.requestURI.path.split('/').getOrNull(2).orEmpty()
        requests.incrementAndGet()
        counts.computeIfAbsent(player.lowercase()) { AtomicInteger() }.incrementAndGet()

        val head = heads[player.lowercase()]
        if (head == null) {
            exchange.sendResponseHeaders(404, -1)
            exchange.close()
            return
        }

        val (bytes, contentType) = head
        exchange.responseHeaders.add("Content-Type", contentType)
        exchange.sendResponseHeaders(200, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }
}
