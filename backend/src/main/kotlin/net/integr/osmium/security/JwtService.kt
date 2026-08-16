package net.integr.osmium.security

import net.integr.osmium.security.JwtProperties
import net.integr.osmium.account.model.User
import org.springframework.security.oauth2.jose.jws.MacAlgorithm
import org.springframework.security.oauth2.jwt.JwsHeader
import org.springframework.security.oauth2.jwt.JwtClaimsSet
import org.springframework.security.oauth2.jwt.JwtEncoder
import org.springframework.security.oauth2.jwt.JwtEncoderParameters
import org.springframework.stereotype.Service
import java.time.Instant

data class IssuedToken(val value: String, val expiresAt: Instant)

/**
 * Mints access tokens. The token carries only the subject — authorities are resolved from the
 * database on every request by [DatabaseJwtAuthenticationConverter], so a role change takes effect
 * immediately instead of at the next login.
 */
@Service
class JwtService(
    private val encoder: JwtEncoder,
    private val properties: JwtProperties,
) {
    fun issue(user: User): IssuedToken {
        val issuedAt = Instant.now()
        val expiresAt = issuedAt.plus(properties.ttl)

        val claims = JwtClaimsSet.builder()
            .issuer(ISSUER)
            .issuedAt(issuedAt)
            .expiresAt(expiresAt)
            .subject(user.username)
            // The account's token version at the moment of issue, compared on every request. It is
            // the only way to revoke one of these: incrementing it refuses every token minted so
            // far. See DatabaseJwtAuthenticationConverter.
            .claim(VERSION_CLAIM, user.tokenVersion)
            .build()

        val token = encoder
            .encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims))
            .tokenValue

        return IssuedToken(value = token, expiresAt = expiresAt)
    }

    companion object {
        private const val ISSUER = "osmium"

        /** Claim carrying [net.integr.osmium.account.model.User.tokenVersion]. */
        const val VERSION_CLAIM = "ver"
    }
}
