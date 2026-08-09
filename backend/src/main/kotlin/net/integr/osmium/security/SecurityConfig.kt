package net.integr.osmium.security

import com.nimbusds.jose.jwk.source.ImmutableSecret
import net.integr.osmium.config.JwtProperties
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
import java.nio.charset.StandardCharsets
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

@Configuration
@EnableWebSecurity
@EnableMethodSecurity
class SecurityConfig(private val jwtProperties: JwtProperties) {

    /**
     * The agent socket gets its own chain, matched first and deliberately without the resource
     * server.
     *
     * `permitAll` on the main chain is not enough: it governs authorization, but the bearer token
     * filter still *authenticates* any `Authorization: Bearer …` header, and an agent's enrolment
     * token is not a JWT - so the handshake was rejected with 401 before the interceptor ran.
     * Leaving oauth2ResourceServer off this chain lets the token reach
     * [net.integr.osmium.websocket.AgentHandshakeInterceptor], which is what understands it.
     */
    @Bean
    @Order(1)
    fun agentSocketFilterChain(http: HttpSecurity): SecurityFilterChain = http
        .securityMatcher("/ws/agent")
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
        .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
        .authorizeHttpRequests {
            it.requestMatchers(HttpMethod.POST, "/api/auth/login").permitAll()
            it.requestMatchers(*OPENAPI_PATHS).permitAll()
            // Everything else is gated by @PreAuthorize on a permission node, except
            // POST /api/auth/password which any authenticated account may call for itself.
            it.anyRequest().authenticated()
        }
        .oauth2ResourceServer { resourceServer ->
            resourceServer.jwt { jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter) }
        }
        .build()

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
    }
}
