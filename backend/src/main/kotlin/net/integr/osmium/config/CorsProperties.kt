package net.integr.osmium.config

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Cross-origin access to the API.
 *
 * Empty by default, which disables CORS entirely: both supported deployments are same-origin — the
 * Vite dev server proxies `/api`, and nginx proxies it in the image — so no browser ever sends a
 * preflight. This exists for a split-origin deployment, where the SPA is served from somewhere the
 * backend does not sit behind.
 *
 * @param origins exact origins allowed to call the API, e.g. `https://osmium.example`. Overridden
 *   via `OSMIUM_CORS_ORIGINS` as a comma-separated list. Wildcards are not accepted: credentials
 *   are allowed on this configuration, and `*` with credentials is rejected by every browser.
 */
@ConfigurationProperties(prefix = "osmium.cors")
data class CorsProperties(
    val origins: List<String> = emptyList(),
) {
    init {
        require(origins.none { it == "*" }) {
            "osmium.cors.origins cannot be '*': the API allows credentials, so list exact origins"
        }
    }
}
