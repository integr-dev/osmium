package net.integr.osmium.security

import org.junit.jupiter.api.Test
import java.time.Duration
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The cookie's attributes, as a plain unit test — no Spring context, because there is nothing here
 * that needs one and `Secure` depends on configuration that the running application deliberately
 * sets differently for development.
 *
 * Each attribute is doing a specific job, and losing one silently would not fail anything else:
 * without `HttpOnly` the credential is readable by script, which is the entire reason this exists;
 * without the path it rides on every request; without `SameSite` another site can POST to refresh
 * and logout, which are authenticated by this cookie alone.
 */
class RefreshCookieTest {

    private val cookie = RefreshCookie.issue(value = "a-token", maxAge = Duration.ofHours(12), secure = true)

    @Test
    fun `is closed to scripts`() {
        assertTrue(cookie.isHttpOnly)
    }

    @Test
    fun `is scoped to the session endpoints, not the whole API`() {
        assertEquals("/api/auth", cookie.path)
    }

    @Test
    fun `refuses to travel cross-site`() {
        assertEquals("Strict", cookie.sameSite)
    }

    @Test
    fun `carries Secure when told to`() {
        assertTrue(cookie.isSecure)
    }

    /**
     * Off only for development. A browser refuses a `Secure` cookie over plain HTTP unless the
     * origin is localhost, and Safari refuses it even there — so a dev server reached by LAN address
     * or hostname would drop the cookie silently, session and all.
     */
    @Test
    fun `omits Secure when told to`() {
        val insecure = RefreshCookie.issue(value = "a-token", maxAge = Duration.ofHours(12), secure = false)

        assertFalse(insecure.isSecure)
    }

    /**
     * A browser matches a deletion on name, path and attributes. A cleared cookie that differed on
     * any of them would leave the original in place, and the logout would not stick.
     */
    @Test
    fun `clears with the same name and path, so the deletion matches`() {
        val cleared = RefreshCookie.clear(secure = true)

        assertEquals(cookie.name, cleared.name)
        assertEquals(cookie.path, cleared.path)
        assertEquals(cookie.sameSite, cleared.sameSite)
        assertEquals(Duration.ZERO, cleared.maxAge)
        assertEquals("", cleared.value)
    }
}
