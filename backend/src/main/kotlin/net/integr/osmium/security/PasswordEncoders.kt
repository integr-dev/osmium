package net.integr.osmium.security

import org.springframework.security.crypto.password.PasswordEncoder

/**
 * [PasswordEncoder.encode] takes a nullable argument and returns null only for a null input
 * (`@Contract("!null -> !null; null -> null")`). Kotlin does not read that contract, so the result
 * is `String?` at every call site even though we always pass a non-null password.
 */
fun PasswordEncoder.encodeRequired(rawPassword: String): String =
    checkNotNull(encode(rawPassword)) { "Password encoder returned no hash for a non-null password" }
