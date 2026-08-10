package net.integr.osmium.audit.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

/**
 * @param retention how long an audit entry is kept. 30 days by default — the longest of the three
 *   streams, because audit is the only one about people rather than machines, and it is the
 *   smallest by volume: a row per command, not per event. See FLEET_CONNECTIVITY.md.
 */
@ConfigurationProperties(prefix = "osmium.audit")
data class AuditProperties(
    val retention: Duration = Duration.ofDays(30),
) {
    init {
        require(!retention.isNegative && !retention.isZero) {
            "osmium.audit.retention must be positive; the purge would otherwise delete every entry"
        }
    }
}
