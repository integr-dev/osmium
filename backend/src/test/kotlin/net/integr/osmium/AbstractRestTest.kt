package net.integr.osmium

import com.jayway.jsonpath.JsonPath
import net.integr.osmium.model.Bot
import net.integr.osmium.model.BotState
import net.integr.osmium.model.Host
import net.integr.osmium.model.User
import net.integr.osmium.repository.BotRepository
import net.integr.osmium.repository.HostRepository
import net.integr.osmium.repository.RoleRepository
import net.integr.osmium.repository.UserRepository
import java.time.Instant
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
    @Autowired protected lateinit var hostRepository: HostRepository
    @Autowired protected lateinit var botRepository: BotRepository

    /** A host that heartbeated just now, so commands reach the dispatch stage instead of 503ing. */
    protected fun reachableHost(name: String = "agent-1"): Host =
        hostRepository.saveAndFlush(
            Host(name = name, tokenHash = "hash", lastSeenAt = Instant.now(), address = "10.0.0.1:871"),
        )

    /** A host that has never dialled in, so every command to its bots fails fast. */
    protected fun unreachableHost(name: String = "agent-cold"): Host =
        hostRepository.saveAndFlush(Host(name = name, tokenHash = "hash"))

    protected fun createBot(
        label: String,
        host: Host,
        state: BotState = BotState.UNLINKED,
        server: String = "mc.example.com:25565",
    ): Bot = botRepository.saveAndFlush(
        Bot(label = label, host = host, serverAddress = server, state = state),
    )

    protected fun createUser(
        username: String,
        password: String = DEFAULT_PASSWORD,
        role: String? = null,
    ): User = userRepository.saveAndFlush(
        User(
            username = username,
            passwordHash = passwordEncoder.encodeRequired(password),
            role = role?.let { roleRepository.findByName(it) },
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

    /** Convenience: create an account holding [role] and return its bearer header value. */
    protected fun authAs(username: String, role: String? = null): String {
        createUser(username = username, role = role)
        return bearer(tokenFor(username = username))
    }

    protected companion object {
        const val DEFAULT_PASSWORD = "correct-horse"
        const val BOOTSTRAP_USERNAME = "admin"
        const val BOOTSTRAP_PASSWORD = "admin"
    }
}
