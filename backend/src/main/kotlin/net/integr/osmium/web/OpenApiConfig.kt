package net.integr.osmium.web

import io.swagger.v3.oas.annotations.OpenAPIDefinition
import io.swagger.v3.oas.annotations.enums.SecuritySchemeIn
import io.swagger.v3.oas.annotations.enums.SecuritySchemeType
import io.swagger.v3.oas.annotations.info.Info
import io.swagger.v3.oas.annotations.security.SecurityRequirement
import io.swagger.v3.oas.annotations.security.SecurityScheme
import org.springframework.context.annotation.Configuration

@Configuration
@OpenAPIDefinition(
    info = Info(
        title = "Osmium backend",
        version = "0.0.1-SNAPSHOT",
        description = "JWT authentication with role-grouped permission nodes. Routes authorize " +
            "against nodes only, never against roles.",
    ),
    security = [SecurityRequirement(name = OpenApiConfig.BEARER_SCHEME)],
)
@SecurityScheme(
    name = OpenApiConfig.BEARER_SCHEME,
    type = SecuritySchemeType.HTTP,
    scheme = "bearer",
    bearerFormat = "JWT",
    `in` = SecuritySchemeIn.HEADER,
)
class OpenApiConfig {
    companion object {
        const val BEARER_SCHEME = "bearerAuth"
    }
}
