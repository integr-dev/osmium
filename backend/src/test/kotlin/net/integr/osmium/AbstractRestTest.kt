package net.integr.osmium

import com.jayway.jsonpath.JsonPath
import net.integr.osmium.model.User
import net.integr.osmium.repository.RoleRepository
import net.integr.osmium.repository.UserRepository
import net.integr.osmium.security.encodeRequired
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.MediaType
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.post
import org.springframework.transaction.annotation.Transactional

/**
 * Shared wiring for the REST tests. Each test runs in a transaction that is rolled back, so users
 * created here never leak between tests. MockMvc runs on the same thread, so it sees them.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Import(TestcontainersConfiguration::class)
@Transactional
abstract class AbstractRestTest {

    @Autowired protected lateinit var mockMvc: MockMvc
    @Autowired protected lateinit var userRepository: UserRepository
    @Autowired protected lateinit var roleRepository: RoleRepository
    @Autowired protected lateinit var passwordEncoder: PasswordEncoder

    protected fun createUser(
        username: String,
        password: String = DEFAULT_PASSWORD,
        roles: Set<String> = emptySet(),
    ): User = userRepository.saveAndFlush(
        User(
            username = username,
            passwordHash = passwordEncoder.encodeRequired(password),
            roles = roleRepository.findAllByNameIn(roles).toMutableSet(),
        ),
    )

    protected fun login(username: String, password: String = DEFAULT_PASSWORD): String =
        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"$username","password":"$password"}"""
        }.andReturn().response.contentAsString

    protected fun tokenFor(username: String, password: String = DEFAULT_PASSWORD): String =
        JsonPath.read(login(username = username, password = password), "$.token")

    protected fun bearer(token: String): String = "Bearer $token"

    /** Convenience: create an account with [roles] and return its bearer header value. */
    protected fun authAs(username: String, vararg roles: String): String {
        createUser(username = username, roles = roles.toSet())
        return bearer(tokenFor(username = username))
    }

    protected companion object {
        const val DEFAULT_PASSWORD = "correct-horse"
        const val BOOTSTRAP_USERNAME = "admin"
        const val BOOTSTRAP_PASSWORD = "admin"
    }
}
