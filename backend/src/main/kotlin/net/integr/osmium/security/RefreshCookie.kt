package net.integr.osmium.security

import org.springframework.http.ResponseCookie
import java.time.Duration

/**
 * The cookie carrying the refresh token.
 *
 * Four properties, each doing a specific job:
 *
 * **HttpOnly** — the reason any of this exists. JavaScript cannot read it, so an XSS cannot carry
 * the session off the machine. It can still act as the user while the page is open; nothing about
 * a cookie changes that, and claiming otherwise is the usual overstatement.
 *
 * **Path=/api/auth** — the cookie is sent to the three endpoints that need it and to nothing else.
 * Ordinary API calls carry the Bearer access token and never the refresh token, so the credential
 * is on the wire a few times an hour instead of on every request.
 *
 * **SameSite=Strict** — the refresh and logout endpoints are authenticated by this cookie alone, so
 * without it another site could POST to them from a victim's browser. Strict rather than Lax costs
 * nothing here: the path is an API, never something a person follows a link to.
 *
 * **Secure** — configurable only because it would otherwise make plain-HTTP development impossible.
 * Browsers exempt `http://localhost`, so the default holds there too; see [JwtProperties].
 */
object RefreshCookie {

    const val NAME = "osmium_refresh"

    private const val PATH = "/api/auth"

    fun issue(value: String, maxAge: Duration, secure: Boolean): ResponseCookie =
        base(value, secure).maxAge(maxAge).build()

    /**
     * Clears it. Same name, path and attributes with a zero age — a browser matches a deletion on
     * those, so a mismatched path would leave the old cookie in place and logout would not stick.
     */
    fun clear(secure: Boolean): ResponseCookie = base("", secure).maxAge(0).build()

    private fun base(value: String, secure: Boolean): ResponseCookie.ResponseCookieBuilder =
        ResponseCookie.from(NAME, value)
            .httpOnly(true)
            .secure(secure)
            .path(PATH)
            .sameSite("Strict")
}
