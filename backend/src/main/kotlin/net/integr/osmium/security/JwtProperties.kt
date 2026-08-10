package net.integr.osmium.security

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

/**
 * @param secret HMAC signing key. Must be at least 32 bytes for HS256. Override in production via
 *   `OSMIUM_JWT_SECRET`.
 */
@ConfigurationProperties(prefix = "osmium.jwt")
data class JwtProperties(
    val secret: String,
    val ttl: Duration = Duration.ofHours(1),
)
