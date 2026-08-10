package net.integr.osmium

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling
import net.integr.osmium.audit.service.AuditService

/**
 * Scheduling drives five jobs: the three daily retention purges (audit, activity, chat), the chat
 * listener election, which reconciles on a timer because a host going silent fires no event, and the
 * telemetry tick, which coalesces vitals so the browser is fed at a fixed rate rather than at
 * whatever rate hosts happen to report.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
class Application

fun main(args: Array<String>) {
    runApplication<Application>(*args)
}
