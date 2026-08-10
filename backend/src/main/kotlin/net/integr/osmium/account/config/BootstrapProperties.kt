package net.integr.osmium.account.config

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Credentials for the account seeded when the `users` table is empty. Override via
 * `OSMIUM_BOOTSTRAP_USERNAME` / `OSMIUM_BOOTSTRAP_PASSWORD`.
 *
 * The seeded account is a full administrator from the first boot and nothing forces the password to
 * be changed, so the defaults below are only safe for local development.
 */
@ConfigurationProperties(prefix = "osmium.bootstrap")
data class BootstrapProperties(
    val username: String = "admin",
    val password: String = "admin",
)
