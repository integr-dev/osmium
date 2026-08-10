package net.integr.osmium

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling
import net.integr.osmium.audit.service.AuditService

/** Scheduling drives the three daily retention purges: audit, activity and chat. */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
class Application

fun main(args: Array<String>) {
    runApplication<Application>(*args)
}
