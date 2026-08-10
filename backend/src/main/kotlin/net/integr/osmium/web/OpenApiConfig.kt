package net.integr.osmium.web

import io.swagger.v3.oas.models.Components
import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.info.Info
import io.swagger.v3.oas.models.security.SecurityRequirement
import io.swagger.v3.oas.models.security.SecurityScheme
import org.springframework.boot.info.BuildProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/**
 * Built as a bean rather than declared with `@OpenAPIDefinition`, because the annotation needs a
 * compile-time constant for the version — which meant retyping it on every release, and it had
 * already fallen two behind. This reads the version Gradle stamped into the jar.
 */
@Configuration
class OpenApiConfig {

    @Bean
    fun openApi(buildProperties: BuildProperties?): OpenAPI = OpenAPI()
        .info(
            Info()
                .title("Osmium")
                .version(buildProperties?.version ?: DEVELOPMENT_VERSION)
                .description(DESCRIPTION),
        )
        .components(
            Components().addSecuritySchemes(
                BEARER_SCHEME,
                SecurityScheme()
                    .type(SecurityScheme.Type.HTTP)
                    .scheme("bearer")
                    .bearerFormat("JWT")
                    .`in`(SecurityScheme.In.HEADER)
                    .description("Obtain one from POST /api/auth/login. Send as `Bearer <token>`."),
            ),
        )
        .addSecurityItem(SecurityRequirement().addList(BEARER_SCHEME))

    companion object {
        const val BEARER_SCHEME = "bearerAuth"

        /** `bootRun` has no build-info unless the task has run, so the document still renders. */
        private const val DEVELOPMENT_VERSION = "dev"

        private val DESCRIPTION = """
            Orchestration for a fleet of Minecraft agents that build a large schematic together.

            An **agent** is one Minecraft session on one server. A **host** is a machine running the
            Osmium host software, which owns its agents and is the only component that ever performs
            a Minecraft login — the backend holds no Minecraft credentials and has no code path that
            touches one. Commands are relayed to the owning host and answer **503** when it has no
            live connection; they are never queued.

            Routes authorize against **permission nodes**, never against role names. Roles are named
            bundles of nodes arranged as nested tiers: `viewer`, `orchestrator`, `administrator`.
            The node required by each route is listed on its 403 response.

            Two channels sit outside this document. Hosts dial in over a WebSocket at `/ws/host`
            with an enrolment token rather than a JWT. Browsers receive live updates as server-sent
            events from `/api/stream/**`, which is receive-only — every command travels over the
            REST routes below, where it is node-gated and written to the audit log.

            See FLEET_CONNECTIVITY.md in the repository for the wire protocol and the reasoning.
        """.trimIndent()
    }
}
