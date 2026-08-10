package net.integr.osmium.activity.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

/**
 * @param retention how long an activity entry is kept. 10 days by default — diagnostics go stale.
 *   A crash loop or a relink storm is investigated within days or not at all, and a death from
 *   three weeks ago tells you nothing you would act on. Ten days covers a fortnight's on-call
 *   without keeping noise forever. See FLEET_CONNECTIVITY.md.
 */
@ConfigurationProperties(prefix = "osmium.activity")
data class ActivityProperties(
    val retention: Duration = Duration.ofDays(10),
) {
    init {
        require(!retention.isNegative && !retention.isZero) {
            "osmium.activity.retention must be positive; the purge would otherwise delete every entry"
        }
    }
}
