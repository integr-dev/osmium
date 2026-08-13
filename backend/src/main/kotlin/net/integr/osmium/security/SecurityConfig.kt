package net.integr.osmium.security

import com.nimbusds.jose.jwk.source.ImmutableSecret
import net.integr.osmium.security.CorsProperties
import net.integr.osmium.security.JwtProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.annotation.Order
import org.springframework.http.HttpMethod
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.security.oauth2.jose.jws.MacAlgorithm
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.security.oauth2.jwt.JwtEncoder
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder
import org.springframework.security.web.SecurityFilterChain
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.CorsConfigurationSource
import org.springframework.web.cors.UrlBasedCorsConfigurationSource
import java.nio.charset.StandardCharsets
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import net.integr.osmium.main
import net.integr.osmium.hostlink.HostHandshakeAuthenticator

@Configuration
@EnableWebSecurity
@EnableMethodSecurity
class SecurityConfig(
    private val jwtProperties: JwtProperties,
    private val corsProperties: CorsProperties,
) {

    /**
     * The host socket gets its own chain, matched first and deliberately without the resource
     * server.
     *
     * `permitAll` on the main chain is not enough: it governs authorization, but the bearer token
     * filter still *authenticates* any `Authorization: Bearer …` header, and a host's enrolment
     * token is not a JWT - so the handshake was rejected with 401 before the interceptor ran.
     * Leaving oauth2ResourceServer off this chain lets the token reach
     * [net.integr.osmium.websocket.HostHandshakeAuthenticator], which is what understands it.
     */
    @Bean
    @Order(1)
    fun hostSocketFilterChain(http: HttpSecurity): SecurityFilterChain = http
        .securityMatcher("/ws/host")
        .csrf { it.disable() }
        .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
        .authorizeHttpRequests { it.anyRequest().permitAll() }
        .build()

    @Bean
    @Order(2)
    fun securityFilterChain(
        http: HttpSecurity,
        jwtAuthenticationConverter: DatabaseJwtAuthenticationConverter,
    ): SecurityFilterChain = http
        .csrf { it.disable() }
        .cors { cors ->
            val source = corsConfigurationSource()
            if (source == null) cors.disable() else cors.configurationSource(source)
        }
        .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
        .authorizeHttpRequests {
            it.requestMatchers(HttpMethod.POST, "/api/auth/login").permitAll()
            // Both are authenticated by the refresh cookie rather than by a Bearer token, and
            // requiring one here would defeat the point: refresh exists for the moment the access
            // token has expired, and a logout must work from a session that is already gone.
            it.requestMatchers(HttpMethod.POST, "/api/auth/refresh").permitAll()
            it.requestMatchers(HttpMethod.POST, "/api/auth/logout").permitAll()
            it.requestMatchers(*OPENAPI_PATHS).permitAll()
            // Everything else is gated by @PreAuthorize on a permission node, except
            // POST /api/auth/password which any authenticated account may call for itself.
            it.anyRequest().authenticated()
        }
        .oauth2ResourceServer { resourceServer ->
            resourceServer.jwt { jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter) }
        }
        .build()

    /**
     * Null when no origin is configured, which leaves CORS off entirely rather than answering
     * preflights with an empty allow-list. Deliberately not a bean: a `CorsConfigurationSource` in
     * the context is picked up automatically, and an empty one would be indistinguishable from
     * having none.
     */
    private fun corsConfigurationSource(): CorsConfigurationSource? {
        if (corsProperties.origins.isEmpty()) return null

        val configuration = CorsConfiguration().apply {
            allowedOrigins = corsProperties.origins
            allowedMethods = listOf("GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS")
            allowedHeaders = listOf("Authorization", "Content-Type")
            // The SPA sends the token in a header, not a cookie, but a split-origin deployment may
            // still want credentialed requests; this is why '*' is refused in CorsProperties.
            allowCredentials = true
            maxAge = PREFLIGHT_CACHE_SECONDS
        }

        return UrlBasedCorsConfigurationSource().apply {
            registerCorsConfiguration("/api/**", configuration)
        }
    }

    @Bean
    fun passwordEncoder(): PasswordEncoder = BCryptPasswordEncoder()

    @Bean
    fun jwtEncoder(): JwtEncoder = NimbusJwtEncoder(ImmutableSecret(secretKey()))

    @Bean
    fun jwtDecoder(): JwtDecoder = NimbusJwtDecoder
        .withSecretKey(secretKey())
        .macAlgorithm(MacAlgorithm.HS256)
        .build()

    private fun secretKey(): SecretKey =
        SecretKeySpec(jwtProperties.secret.toByteArray(StandardCharsets.UTF_8), "HmacSHA256")

    private companion object {
        val OPENAPI_PATHS = arrayOf("/v3/api-docs", "/v3/api-docs/**", "/swagger-ui.html", "/swagger-ui/**")
        const val PREFLIGHT_CACHE_SECONDS = 3600L
    }
}
