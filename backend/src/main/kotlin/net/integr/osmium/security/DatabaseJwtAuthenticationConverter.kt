package net.integr.osmium.security

import net.integr.osmium.account.repository.UserRepository
import org.springframework.core.convert.converter.Converter
import org.springframework.security.authentication.AbstractAuthenticationToken
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.stereotype.Component

/**
 * Turns a verified token into an authentication whose authorities are the account's permission
 * nodes, read fresh from the database on every request, so a role change or deletion takes effect
 * immediately instead of at the next login.
 *
 * The token carries only the subject. Resolving it costs one scalar projection query - see
 * [UserRepository.findAuthorization] - rather than hydrating the user, its roles and their nodes.
 */
@Component
class DatabaseJwtAuthenticationConverter(
    private val userRepository: UserRepository,
) : Converter<Jwt, AbstractAuthenticationToken> {

    override fun convert(source: Jwt): AbstractAuthenticationToken {
        val username = source.subject
            ?: throw InvalidBearerTokenException("Token carries no subject")

        val rows = userRepository.findAuthorization(username)
        if (rows.isEmpty()) throw InvalidBearerTokenException("Token subject no longer exists")

        // Revocation. An access token carries no server-side record of itself, so this comparison is
        // the only thing that can end one before it expires: a password change or an explicit "sign
        // out everywhere" increments the account's version, and every token stamped with an earlier
        // one stops working at once.
        //
        // A missing claim reads as version 0, which is where every account starts. That keeps tokens
        // issued before this check existed working until they expire, rather than signing everyone
        // out on deploy - and once anything has ever been revoked, a versionless token no longer
        // matches.
        val presented = (source.getClaim<Any>(JwtService.VERSION_CLAIM) as? Number)?.toInt() ?: 0
        if (presented != rows.first().tokenVersion) {
            throw InvalidBearerTokenException("Token was revoked")
        }

        val authorities = rows
            .mapNotNull { it.nodeId }
            .mapTo(mutableSetOf()) { SimpleGrantedAuthority(it) }

        return JwtAuthenticationToken(source, authorities, rows.first().username)
    }
}
