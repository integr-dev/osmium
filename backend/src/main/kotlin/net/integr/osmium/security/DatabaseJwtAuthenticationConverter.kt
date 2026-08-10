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

        val authorities = rows
            .mapNotNull { it.nodeId }
            .mapTo(mutableSetOf()) { SimpleGrantedAuthority(it) }

        return JwtAuthenticationToken(source, authorities, rows.first().username)
    }
}
