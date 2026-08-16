package net.integr.osmium.security

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

/**
 * @param secret HMAC signing key. Must be at least 32 bytes for HS256. Override in production via
 *   `OSMIUM_JWT_SECRET`.
 * @param ttl how long an access token is good for. Short, because it is re-minted silently from the
 *   refresh cookie — this is the interval between refreshes, not anything an operator sees.
 * @param refreshTtl how long a session lasts before the password is needed again. Counted from the
 *   **login**, not from last activity: refreshing does not extend it, so an operator signs in again
 *   on this schedule however busy they have been. Twelve hours is a shift.
 * @param cookieSecure whether the refresh cookie is marked `Secure`. True everywhere it matters —
 *   browsers exempt `http://localhost`, so development over plain HTTP works with the default on.
 *   Only turn it off for a non-localhost deployment without TLS, which is a thing not to have.
 */
@ConfigurationProperties(prefix = "osmium.jwt")
data class JwtProperties(
    val secret: String,
    val ttl: Duration = Duration.ofMinutes(30),
    val refreshTtl: Duration = Duration.ofHours(12),
    val cookieSecure: Boolean = true,
) {
    init {
        require(!ttl.isNegative && !ttl.isZero) { "osmium.jwt.ttl must be positive" }
        require(!refreshTtl.isNegative && !refreshTtl.isZero) { "osmium.jwt.refresh-ttl must be positive" }
        // A session shorter than the access token it mints would leave a window where the access
        // token still works but nothing can renew it.
        require(refreshTtl >= ttl) { "osmium.jwt.refresh-ttl must be at least osmium.jwt.ttl" }
    }
}
